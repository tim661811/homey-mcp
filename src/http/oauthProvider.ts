// This server as its own OAuth authorization server.
//
// Not a design choice so much as the only option. Athom denies third-party OAuth
// clients the flow write scopes, which is the fact this whole project is built
// around, so proxying to Athom's authorization server would produce tokens that
// cannot do the one thing that makes this server worth running. The MCP
// specification permits co-hosting explicitly and leaves the login screen
// entirely to the implementation, which is what makes the browser page next door
// legitimate.
//
// Two measured facts shape this file more than anything in the specification.
//
// `verifyAccessToken` decides yellow versus red. A plain `new Error` out of it
// produces `500 server_error` with NO `WWW-Authenticate` header, which the client
// shows as "failed to connect" in red. Throwing `InvalidTokenError` produces the
// 401 carrying the full header, which is the yellow "needs authentication" state
// this whole mode exists for. The SDK's own example provider throws a plain
// Error, so copying it reproduces exactly the failure being escaped. Every path
// out of that method is therefore wrapped.
//
// `registerClient` must exist. Its presence is what mounts `/register` and puts
// `registration_endpoint` into the metadata, and with `/register` answering 404 an
// identical 401 with an identical header produced red rather than yellow. That
// was the single change that flipped it, and no document says so.

import { randomUUID, timingSafeEqual } from 'node:crypto'

import type { Response } from 'express'
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
  InvalidTargetError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js'

import type { HomeySignInState, SignInPageState } from '../auth/page.js'
import { renderProblemPage, renderSignInPage, SIGN_IN_PAGE_HEADERS } from '../auth/page.js'
import type { VerifyAndStoreTokenResult } from '../auth/homeySignIn.js'
import type { HttpEndpointConfig } from './config.js'
import { HOMEY_SCOPE, OFFLINE_ACCESS_SCOPE } from './config.js'
import type { AuthStore, StoredTokenRecord } from './authStore.js'
import { ACCESS_TOKEN_LIFETIME_SECONDS, mintOpaqueSecret, REFRESH_TOKEN_LIFETIME_SECONDS } from './authStore.js'
import { peerIdentityOf } from './peerIdentity.js'
import type { Logger } from '../util/log.js'

/** Where the consent form posts back to. Its own path, so it never reaches the SDK's authorize handler. */
export const AUTHORIZE_CONTINUE_PATH = '/authorize/continue'

export const PENDING_AUTHORIZATION_LIFETIME_MS = 10 * 60_000
export const AUTHORIZATION_CODE_LIFETIME_MS = 60_000

/**
 * A sign-in the browser is in the middle of.
 *
 * Held in memory only. A restart mid-sign-in costs one click, whereas tokens that
 * did not survive a restart would cost a re-authorization on every service
 * restart, so the two live in different places on purpose.
 *
 * The id and the CSRF token travel in hidden form fields rather than in a cookie.
 * That satisfies the specification's consent-cookie rules trivially rather than
 * carefully: there is no cookie to set before consent has been given, no
 * `__Host-` prefix to get right, and no `Secure` attribute to agonise over on a
 * loopback origin that cannot have one.
 */
interface PendingAuthorization {
  id: string
  csrfToken: string
  client: OAuthClientInformationFull
  redirectUri: string
  codeChallenge: string
  state?: string
  scopes: string[]
  resource?: URL
  createdAtMs: number
  /**
   * How many wrong approval codes this sign-in has left before it is discarded.
   *
   * This is what makes a 48 bit typed code safe. Without it the code is a secret
   * that can be hammered over loopback at whatever rate the machine allows; with
   * it an attacker gets three guesses per authorization it has to start from
   * scratch, and the owner's browser gets room for a typo.
   */
  approvalAttemptsLeft: number
}

interface AuthorizationCodeRecord {
  clientId: string
  redirectUri: string
  codeChallenge: string
  scopes: string[]
  resource?: URL
  createdAtMs: number
}

export interface HomeyOAuthProviderOptions {
  config: HttpEndpointConfig
  store: AuthStore
  /** Asks the running server whether the Homey is reachable, for the page's middle section. */
  describeHomey: () => Promise<HomeySignInState>
  /** Verifies a pasted Personal Access Token and merges it in. Never returns the token. */
  storePersonalAccessToken: (personalAccessToken: string) => Promise<VerifyAndStoreTokenResult>
  logger?: Logger
  /** Injected by tests so expiry does not depend on the wall clock. */
  now?: () => number
}

/** What the consent form sent back, already read out of the urlencoded body. */
export interface ContinueRequest {
  pendingId: string
  csrfToken: string
  action: string
  personalAccessToken?: string
  approvalCode?: string
}

export const APPROVAL_CODE_ATTEMPTS = 3

export class HomeyOAuthProvider implements OAuthServerProvider {
  private readonly pendingAuthorizations = new Map<string, PendingAuthorization>()
  private readonly authorizationCodes = new Map<string, AuthorizationCodeRecord>()
  private readonly options: HomeyOAuthProviderOptions
  private readonly clients: OAuthRegisteredClientsStore

  /**
   * Left false, and stated rather than left to the default.
   *
   * With it false the SDK runs `verifyChallenge` itself against the challenge
   * `challengeForAuthorizationCode` returns, so the code verifier never reaches
   * this module and PKCE cannot be got wrong here. Setting it true would be for
   * an upstream authorization server doing the validation, which is exactly what
   * this design does not have.
   */
  readonly skipLocalPkceValidation = false

  constructor(options: HomeyOAuthProviderOptions) {
    this.options = options

    // Built once here rather than lazily, because `mcpAuthRouter` reads this
    // getter at construction to decide whether to mount `/register` at all. A
    // store that returned undefined on the first read would silently produce
    // metadata with no registration endpoint, which is the red-badge case.
    this.clients = {
      getClient: async (clientId: string): Promise<OAuthClientInformationFull | undefined> =>
        await options.store.getClient(clientId),

      registerClient: async (
        client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
      ): Promise<OAuthClientInformationFull> => {
        const registered: OAuthClientInformationFull = {
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(this.nowMs() / 1_000),
        }
        await options.store.putClient(registered)
        options.logger?.info('Registered an OAuth client', {
          clientName: registered.client_name ?? '(unnamed)',
          redirectUris: registered.redirect_uris,
        })
        return registered
      },
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.clients
  }

  /**
   * Renders the consent page instead of redirecting.
   *
   * The SDK has already validated `client_id`, the redirect URI (including the
   * RFC 8252 section 7.3 loopback port relaxation the client needs, since it
   * binds 3118 when free and an arbitrary ephemeral port otherwise) and the PKCE
   * parameters by the time this runs.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    response: Response,
  ): Promise<void> {
    this.pruneExpired()

    const pending: PendingAuthorization = {
      id: mintOpaqueSecret(),
      csrfToken: mintOpaqueSecret(),
      client,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      ...(params.state === undefined ? {} : { state: params.state }),
      scopes: grantedScopes(params.scopes ?? []),
      ...(params.resource === undefined ? {} : { resource: params.resource }),
      createdAtMs: this.nowMs(),
      approvalAttemptsLeft: APPROVAL_CODE_ATTEMPTS,
    }
    this.pendingAuthorizations.set(pending.id, pending)

    const approvalCodeRequired = peerIdentityOf(response).kind !== 'same_user'
    // Minted HERE rather than when the form comes back, because the page tells the
    // user to go and read it. Minting it on the post instead left "service status"
    // printing nothing at the moment the user went looking, which is a dead end:
    // the field is required, so there is no submit that could mint it first.
    if (approvalCodeRequired) await this.options.store.readApprovalCode()

    const homey = await this.options.describeHomey()
    this.sendPage(response, renderSignInPage({ ...this.pageState(pending, homey), approvalCodeRequired }))
  }

  /**
   * Handles the consent form's post.
   *
   * Mounted on its own path rather than on `/authorize`, because the SDK's
   * authorize handler validates the full authorization request on POST as well
   * as on GET. Reaching it would mean re-submitting `code_challenge`,
   * `response_type` and the redirect URI as hidden fields, which puts
   * security-relevant parameters back under the browser's control for no gain.
   * The pending record already holds all of them.
   */
  async handleContinue(request: ContinueRequest, response: Response): Promise<void> {
    this.pruneExpired()

    const pending = this.pendingAuthorizations.get(request.pendingId)
    if (pending === undefined || pending.csrfToken !== request.csrfToken) {
      // Never a redirect. Without a matching pending record there is no verified
      // redirect URI to send anything to, so answering with one would be an open
      // redirect handed to whoever guessed the id.
      response
        .status(400)
        .set(SIGN_IN_PAGE_HEADERS)
        .send(
          renderProblemPage(
            'This sign-in is no longer open',
            'It may have been completed already, or it may have expired. Ask your assistant to connect again to start a new one.',
          ),
        )
      return
    }

    // Only the two actions that grant something are gated. Cancel and recheck
    // change nothing and are left reachable, so a sign-in started by mistake can
    // always be closed off.
    const approvalCodeRequired = peerIdentityOf(response).kind !== 'same_user'
    if (approvalCodeRequired && (request.action === 'allow' || request.action === 'personal_access_token')) {
      const expected = await this.options.store.readApprovalCode()
      if (!approvalCodesMatch(request.approvalCode ?? '', expected)) {
        pending.approvalAttemptsLeft -= 1
        if (pending.approvalAttemptsLeft <= 0) {
          this.pendingAuthorizations.delete(pending.id)
          response
            .status(400)
            .set(SIGN_IN_PAGE_HEADERS)
            .send(
              renderProblemPage(
                'This sign-in was closed',
                'The approval code was wrong too many times. Ask your assistant to connect again to start a new one.',
              ),
            )
          return
        }

        const homey = await this.options.describeHomey()
        this.sendPage(
          response,
          renderSignInPage({
            ...this.pageState(pending, homey),
            approvalCodeRequired: true,
            notice: {
              kind: 'bad',
              message: `That approval code was not right. ${pending.approvalAttemptsLeft} attempt${pending.approvalAttemptsLeft === 1 ? '' : 's'} left before this sign-in is closed.`,
            },
          }),
        )
        return
      }
    }

    switch (request.action) {
      case 'allow': {
        this.pendingAuthorizations.delete(pending.id)
        const code = mintOpaqueSecret()
        this.authorizationCodes.set(code, {
          clientId: pending.client.client_id,
          redirectUri: pending.redirectUri,
          codeChallenge: pending.codeChallenge,
          scopes: pending.scopes,
          ...(pending.resource === undefined ? {} : { resource: pending.resource }),
          createdAtMs: this.nowMs(),
        })

        const target = new URL(pending.redirectUri)
        target.searchParams.set('code', code)
        if (pending.state !== undefined) target.searchParams.set('state', pending.state)
        // RFC 9207. A SHOULD in the current revision with a stated intention to
        // become a MUST, and it costs one parameter on a redirect built here.
        target.searchParams.set('iss', this.options.config.issuerUrl.href)
        response.redirect(302, target.href)
        return
      }

      case 'cancel': {
        this.pendingAuthorizations.delete(pending.id)
        const target = new URL(pending.redirectUri)
        target.searchParams.set('error', 'access_denied')
        target.searchParams.set('error_description', 'The sign-in was cancelled in the browser.')
        if (pending.state !== undefined) target.searchParams.set('state', pending.state)
        target.searchParams.set('iss', this.options.config.issuerUrl.href)
        response.redirect(302, target.href)
        return
      }

      case 'personal_access_token': {
        const result = await this.options.storePersonalAccessToken(request.personalAccessToken ?? '')
        const homey = await this.options.describeHomey()
        this.sendPage(
          response,
          renderSignInPage({
            ...this.pageState(pending, homey),
            approvalCodeRequired,
            notice: { kind: result.ok ? 'good' : 'bad', message: result.message },
          }),
        )
        return
      }

      case 'recheck':
      default: {
        const homey = await this.options.describeHomey()
        this.sendPage(
          response,
          renderSignInPage({ ...this.pageState(pending, homey), approvalCodeRequired }),
        )
        return
      }
    }
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.readLiveCode(authorizationCode)
    if (record === undefined || record.clientId !== client.client_id) {
      throw new InvalidGrantError('The authorization code is not valid, has been used, or has expired.')
    }
    return record.codeChallenge
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.readLiveCode(authorizationCode)
    if (record === undefined || record.clientId !== client.client_id) {
      throw new InvalidGrantError('The authorization code is not valid, has been used, or has expired.')
    }

    // Single use, and consumed before anything can fail below, so a rejected
    // exchange cannot leave a code that a second attempt could succeed with.
    this.authorizationCodes.delete(authorizationCode)

    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('The redirect_uri does not match the one the code was issued for.')
    }

    this.assertResourceAllowed(resource)

    return await this.mintTokens(client.client_id, record.scopes)
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    // Read and delete in one step: rotation is a specification MUST for a public
    // client, and a refresh token presented twice means either a race or a stolen
    // token. The safe answer to both is to make the user click Authenticate once,
    // not to quietly issue another pair.
    //
    // The client id goes IN rather than being checked on the way out. `/token`
    // authenticates a public client on an unproven client id, so a check
    // afterwards would let anybody destroy a refresh token they hold but do not
    // own, and the owner's next silent refresh would become a browser round trip
    // with nothing saying why.
    const record = await this.options.store.consumeRefreshToken(refreshToken, client.client_id)
    if (record === undefined) {
      throw new InvalidGrantError('The refresh token is not valid, has been used, or has expired.')
    }

    this.assertResourceAllowed(resource)

    let granted = record.scopes
    if (scopes !== undefined && scopes.length > 0) {
      const widened = scopes.filter((scope) => !record.scopes.includes(scope))
      if (widened.length > 0) {
        throw new InvalidRequestError(`A refresh cannot ask for scopes the token was not granted: ${widened.join(' ')}`)
      }
      // Narrowing is honoured, but `homey` is kept whatever happens: a token
      // without it fails the bearer middleware's scope check with a 403, and a
      // client that meets an identical 403 twice hard-fails instead of prompting.
      granted = scopes.includes(HOMEY_SCOPE) ? scopes : [HOMEY_SCOPE, ...scopes]
    }

    return await this.mintTokens(client.client_id, granted)
  }

  /**
   * The most consequential method here, and the one rule it must never break is
   * that a Homey failure never becomes an HTTP status.
   *
   * It reads the OAuth store and nothing else. It never calls the hub, never
   * reads `credentials.json` and never consults `connection.authenticated`. Break
   * that and a lapsed 24 hour Homey session becomes a 401: the client refreshes
   * its token, retries, takes another 401, and finally offers Re-authenticate for
   * a problem no amount of re-authorizing can fix. That is worse than the red
   * cross this project already spent days on, because it now has a button that
   * looks like it should help.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const record = await this.options.store.readAccessToken(token)
      if (record === undefined) {
        throw new InvalidTokenError('This access token is not one this server issued, or it has expired.')
      }

      if (record.expiresAtSeconds <= Math.floor(this.nowMs() / 1_000)) {
        throw new InvalidTokenError('This access token has expired.')
      }

      // `requireBearerAuth` does not check the audience, while the specification
      // says an MCP server MUST validate that a token was issued for it.
      if (
        !checkResourceAllowed({
          requestedResource: new URL(record.resource),
          configuredResource: this.options.config.mcpUrl,
        })
      ) {
        throw new InvalidTokenError('This access token was issued for a different resource.')
      }

      return {
        token,
        clientId: record.clientId,
        scopes: record.scopes,
        // Seconds since the epoch, never milliseconds and never a Date. The
        // middleware compares it against `Date.now() / 1000`, so milliseconds
        // would make every token valid for about 55000 years and a Date would
        // make every token invalid.
        expiresAt: record.expiresAtSeconds,
        resource: this.options.config.mcpUrl,
        extra: { source: 'homey-mcp-http' },
      }
    } catch (error: unknown) {
      if (error instanceof InvalidTokenError) throw error
      // Anything else at all, including a disk failure reading the store, is
      // re-thrown as an invalid token. The alternative is a 500 with no
      // WWW-Authenticate header, which the client shows as a red cross with
      // nothing to click.
      this.options.logger?.warn('Refusing an access token after an unexpected failure', { error })
      throw new InvalidTokenError('This access token could not be checked.')
    }
  }

  /** How many sign-ins are open right now. `doctor` reports the count, never a value. */
  get openSignInCount(): number {
    this.pruneExpired()
    return this.pendingAuthorizations.size
  }

  private pageState(pending: PendingAuthorization, homey: HomeySignInState): SignInPageState {
    const redirect = new URL(pending.redirectUri)
    return {
      formAction: AUTHORIZE_CONTINUE_PATH,
      pendingId: pending.id,
      csrfToken: pending.csrfToken,
      homey,
      consent: {
        clientName: pending.client.client_name ?? pending.client.client_id,
        redirectHost: redirect.host,
        redirectIsLoopback: ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname),
        scopes: pending.scopes,
      },
    }
  }

  private sendPage(response: Response, html: string): void {
    response.status(200).set(SIGN_IN_PAGE_HEADERS).send(html)
  }

  private async mintTokens(clientId: string, scopes: string[]): Promise<OAuthTokens> {
    const issuedAtSeconds = Math.floor(this.nowMs() / 1_000)
    const accessToken = mintOpaqueSecret()

    const record: StoredTokenRecord = {
      clientId,
      scopes,
      resource: this.options.config.mcpUrl.href,
      issuedAtSeconds,
      expiresAtSeconds: issuedAtSeconds + ACCESS_TOKEN_LIFETIME_SECONDS,
    }
    await this.options.store.putAccessToken(accessToken, record)

    const tokens: OAuthTokens = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
      scope: scopes.join(' '),
    }

    if (scopes.includes(OFFLINE_ACCESS_SCOPE)) {
      const refreshToken = mintOpaqueSecret()
      await this.options.store.putRefreshToken(refreshToken, {
        ...record,
        expiresAtSeconds: issuedAtSeconds + REFRESH_TOKEN_LIFETIME_SECONDS,
      })
      tokens.refresh_token = refreshToken
    }

    return tokens
  }

  private assertResourceAllowed(resource: URL | undefined): void {
    if (resource === undefined) return
    if (checkResourceAllowed({ requestedResource: resource, configuredResource: this.options.config.mcpUrl })) return
    throw new InvalidTargetError(`This server does not issue tokens for ${resource.href}.`)
  }

  private readLiveCode(code: string): AuthorizationCodeRecord | undefined {
    this.pruneExpired()
    return this.authorizationCodes.get(code)
  }

  private pruneExpired(): void {
    const now = this.nowMs()
    for (const [id, pending] of this.pendingAuthorizations) {
      if (now - pending.createdAtMs > PENDING_AUTHORIZATION_LIFETIME_MS) this.pendingAuthorizations.delete(id)
    }
    for (const [code, record] of this.authorizationCodes) {
      if (now - record.createdAtMs > AUTHORIZATION_CODE_LIFETIME_MS) this.authorizationCodes.delete(code)
    }
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now()
  }
}

/**
 * The scopes a request is granted.
 *
 * `homey` is always in the answer, even when the client did not ask for it.
 * There is only one scope that means anything here, and a token without it fails
 * the bearer middleware's scope check with a 403 rather than a 401. A 403 is a
 * different client state entirely: the client tracks the last upscoping
 * challenge it saw and refuses a second identical one, so it hard-fails instead
 * of prompting. Granting the only scope this server has is the safe reading of a
 * request that omitted it.
 */
/**
 * Compares two approval codes in constant time, ignoring how they were typed.
 *
 * Dashes, spaces and case are dropped on both sides because the code is read off
 * a terminal and typed into a page by hand, and rejecting `A1B2C3D4E5F6` for the
 * code printed as `a1b2-c3d4-e5f6` would spend one of three attempts on
 * punctuation. The comparison itself is `timingSafeEqual` on the normalised
 * form: three attempts already bound guessing, and a length or prefix leak here
 * would still be a leak of the one secret standing in for the peer check.
 */
export function approvalCodesMatch(submitted: string, expected: string): boolean {
  const normalise = (code: string): Buffer => Buffer.from(code.replace(/[\s-]/g, '').toLowerCase(), 'utf8')
  const left = normalise(submitted)
  const right = normalise(expected)
  if (right.length === 0) return false
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function grantedScopes(requested: string[]): string[] {
  const scopes = [HOMEY_SCOPE]
  if (requested.includes(OFFLINE_ACCESS_SCOPE)) scopes.push(OFFLINE_ACCESS_SCOPE)
  return scopes
}
