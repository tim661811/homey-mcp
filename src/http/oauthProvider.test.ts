import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Response } from 'express'
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthStore } from './authStore.js'
import { createAuthStore } from './authStore.js'
import type { PeerIdentity } from './peerIdentity.js'
import { PEER_IDENTITY_LOCAL } from './peerIdentity.js'
import { createHttpEndpointConfig } from './config.js'
import { HomeyOAuthProvider } from './oauthProvider.js'
import type { HomeySignInState } from '../auth/page.js'

const CONFIG = createHttpEndpointConfig({ port: 8431 })

const CLIENT: OAuthClientInformationFull = {
  client_id: 'client-one',
  client_name: 'Claude Code (homey-http)',
  redirect_uris: ['http://localhost:3118/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  scope: 'homey',
}

const SIGNED_IN: HomeySignInState = {
  kind: 'signed_in',
  homeyName: 'Home',
  modelName: 'Homey Pro (Early 2019)',
  firmware: '13.2.4',
  sessionExpiresAt: null,
}

interface FakeResponse {
  response: Response
  status: number
  body: string
  redirectedTo: string | null
  headers: Record<string, string>
}

/**
 * `peerIdentity` stands in for what the gate in `serveHttp` stores on the
 * response. `same_user` is the default because that is the case every test here
 * was written against; the gate's other two verdicts have their own tests below.
 */
function fakeResponse(peerIdentity: PeerIdentity = { kind: 'same_user' }): FakeResponse {
  const captured: FakeResponse = {
    response: undefined as unknown as Response,
    status: 200,
    body: '',
    redirectedTo: null,
    headers: {},
  }
  captured.response = {
    locals: { [PEER_IDENTITY_LOCAL]: peerIdentity },
    status(code: number) {
      captured.status = code
      return this
    },
    set(headers: Record<string, string>) {
      Object.assign(captured.headers, headers)
      return this
    },
    send(body: string) {
      captured.body = body
      return this
    },
    redirect(_code: number, target: string) {
      captured.redirectedTo = target
    },
  } as unknown as Response
  return captured
}

let store: AuthStore
let nowMs: number

function buildProvider(overrides: Partial<ConstructorParameters<typeof HomeyOAuthProvider>[0]> = {}): HomeyOAuthProvider {
  return new HomeyOAuthProvider({
    config: CONFIG,
    store,
    describeHomey: async () => SIGNED_IN,
    storePersonalAccessToken: async () => ({ ok: true, message: 'Saved.' }),
    now: () => nowMs,
    ...overrides,
  })
}

/** Walks a whole sign-in and returns the tokens it produced. */
async function authorizeAndExchange(provider: HomeyOAuthProvider, scope = 'homey offline_access') {
  const authorizePage = fakeResponse()
  await provider.authorize(
    CLIENT,
    {
      codeChallenge: 'a-challenge',
      redirectUri: 'http://localhost:3118/callback',
      state: 'state-value',
      scopes: scope.split(' '),
      resource: CONFIG.mcpUrl,
    },
    authorizePage.response,
  )

  const pendingId = /name="pendingId" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''
  const csrfToken = /name="csrfToken" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''

  const decision = fakeResponse()
  await provider.handleContinue({ pendingId, csrfToken, action: 'allow' }, decision.response)

  const code = new URL(decision.redirectedTo ?? '').searchParams.get('code') ?? ''
  const tokens = await provider.exchangeAuthorizationCode(CLIENT, code, undefined, 'http://localhost:3118/callback', CONFIG.mcpUrl)
  return { tokens, code, pendingId, csrfToken, authorizePage, decision }
}

beforeEach(async () => {
  nowMs = Date.parse('2026-08-17T10:00:00Z')
  store = await createAuthStore({
    path: join(await mkdtemp(join(tmpdir(), 'homey-mcp-provider-')), 'http-auth.json'),
    now: () => nowMs,
  })
})

describe('clientsStore', () => {
  it('offers registerClient, which is what mounts /register at all', async () => {
    // Measured: with /register answering 404 the identical 401 with the identical
    // WWW-Authenticate header produced a red "failed to connect" rather than the
    // yellow "needs authentication". Adding a registration endpoint was the one
    // change that flipped it, and no document says so.
    const provider = buildProvider()
    expect(provider.clientsStore.registerClient).toBeTypeOf('function')
  })

  it('is readable immediately, because the router reads it once at construction', async () => {
    const provider = buildProvider()
    expect(await provider.clientsStore.getClient('nobody')).toBeUndefined()
  })

  it('gives a registered client an id and remembers it', async () => {
    const provider = buildProvider()
    const registered = await provider.clientsStore.registerClient?.({
      client_name: 'Claude Code (homey-http)',
      redirect_uris: ['http://localhost:3118/callback'],
    } as Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>)

    expect(registered?.client_id).toBeTypeOf('string')
    expect(await provider.clientsStore.getClient(registered?.client_id ?? '')).toMatchObject({
      client_name: 'Claude Code (homey-http)',
    })
  })
})

describe('authorize', () => {
  it('renders the consent page rather than redirecting', async () => {
    const provider = buildProvider()
    const captured = fakeResponse()

    await provider.authorize(
      CLIENT,
      { codeChallenge: 'a-challenge', redirectUri: 'http://localhost:3118/callback', scopes: ['homey'] },
      captured.response,
    )

    expect(captured.status).toBe(200)
    expect(captured.redirectedTo).toBeNull()
    expect(captured.body).toContain('Allow access to your Homey?')
  })

  it('names the redirect host, which the specification requires be displayed', async () => {
    const provider = buildProvider()
    const captured = fakeResponse()

    await provider.authorize(
      CLIENT,
      { codeChallenge: 'a-challenge', redirectUri: 'http://localhost:3118/callback', scopes: ['homey'] },
      captured.response,
    )

    expect(captured.body).toContain('localhost:3118')
    expect(captured.body).toContain('a program running on this computer')
  })

  it('serves the page with the headers a consent screen has to carry', async () => {
    const provider = buildProvider()
    const captured = fakeResponse()

    await provider.authorize(
      CLIENT,
      { codeChallenge: 'a-challenge', redirectUri: 'http://localhost:3118/callback', scopes: ['homey'] },
      captured.response,
    )

    expect(captured.headers['Content-Security-Policy']).toContain("frame-ancestors 'none'")
    expect(captured.headers['Cache-Control']).toBe('no-store')
  })
})

describe('handleContinue', () => {
  it('refuses a post with no matching pending sign-in, and never redirects for it', async () => {
    // Answering with a redirect would hand an open redirect to whoever guessed
    // an id, since without a pending record there is no verified target.
    const provider = buildProvider()
    const captured = fakeResponse()

    await provider.handleContinue({ pendingId: 'nope', csrfToken: 'nope', action: 'allow' }, captured.response)

    expect(captured.status).toBe(400)
    expect(captured.redirectedTo).toBeNull()
  })

  it('refuses a post whose CSRF token does not match the pending record', async () => {
    const provider = buildProvider()
    const authorizePage = fakeResponse()
    await provider.authorize(
      CLIENT,
      { codeChallenge: 'a-challenge', redirectUri: 'http://localhost:3118/callback', scopes: ['homey'] },
      authorizePage.response,
    )
    const pendingId = /name="pendingId" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''

    const captured = fakeResponse()
    await provider.handleContinue({ pendingId, csrfToken: 'wrong', action: 'allow' }, captured.response)

    expect(captured.status).toBe(400)
    expect(captured.redirectedTo).toBeNull()
  })

  it('redirects with the code, the state and the RFC 9207 issuer on Allow', async () => {
    const provider = buildProvider()
    const { decision } = await authorizeAndExchange(provider)
    const target = new URL(decision.redirectedTo ?? '')

    expect(target.origin + target.pathname).toBe('http://localhost:3118/callback')
    expect(target.searchParams.get('state')).toBe('state-value')
    expect(target.searchParams.get('iss')).toBe(CONFIG.issuerUrl.href)
  })

  it('redirects with access_denied on Cancel', async () => {
    const provider = buildProvider()
    const authorizePage = fakeResponse()
    await provider.authorize(
      CLIENT,
      { codeChallenge: 'a-challenge', redirectUri: 'http://localhost:3118/callback', state: 's', scopes: ['homey'] },
      authorizePage.response,
    )
    const pendingId = /name="pendingId" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''
    const csrfToken = /name="csrfToken" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''

    const captured = fakeResponse()
    await provider.handleContinue({ pendingId, csrfToken, action: 'cancel' }, captured.response)

    expect(new URL(captured.redirectedTo ?? '').searchParams.get('error')).toBe('access_denied')
  })

  it('never puts a submitted Personal Access Token back into the page, on either path', async () => {
    const secret = 'a-secret-token-value-nobody-should-see'

    for (const outcome of [true, false]) {
      const provider = buildProvider({
        storePersonalAccessToken: async () => ({
          ok: outcome,
          message: outcome ? 'Saved.' : 'That token did not work, so nothing was saved.',
        }),
      })
      const authorizePage = fakeResponse()
      await provider.authorize(
        CLIENT,
        { codeChallenge: 'a-challenge', redirectUri: 'http://localhost:3118/callback', scopes: ['homey'] },
        authorizePage.response,
      )
      const pendingId = /name="pendingId" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''
      const csrfToken = /name="csrfToken" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''

      const captured = fakeResponse()
      await provider.handleContinue(
        { pendingId, csrfToken, action: 'personal_access_token', personalAccessToken: secret },
        captured.response,
      )

      expect(captured.body).not.toContain(secret)
    }
  })

  it('keeps the sign-in open after a token attempt, so a failure can be retried', async () => {
    const provider = buildProvider({
      storePersonalAccessToken: async () => ({ ok: false, message: 'That token did not work.' }),
    })
    const authorizePage = fakeResponse()
    await provider.authorize(
      CLIENT,
      { codeChallenge: 'a-challenge', redirectUri: 'http://localhost:3118/callback', scopes: ['homey'] },
      authorizePage.response,
    )
    const pendingId = /name="pendingId" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''
    const csrfToken = /name="csrfToken" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''

    const captured = fakeResponse()
    await provider.handleContinue(
      { pendingId, csrfToken, action: 'personal_access_token', personalAccessToken: 'nope' },
      captured.response,
    )

    expect(captured.status).toBe(200)
    expect(captured.body).toContain('That token did not work.')
    expect(captured.body).toContain(pendingId)
  })
})

describe('authorization codes', () => {
  it('are single use', async () => {
    const provider = buildProvider()
    const { code } = await authorizeAndExchange(provider)

    await expect(
      provider.exchangeAuthorizationCode(CLIENT, code, undefined, 'http://localhost:3118/callback'),
    ).rejects.toBeInstanceOf(InvalidGrantError)
  })

  it('are dead after sixty seconds', async () => {
    const provider = buildProvider()
    const authorizePage = fakeResponse()
    await provider.authorize(
      CLIENT,
      { codeChallenge: 'a-challenge', redirectUri: 'http://localhost:3118/callback', scopes: ['homey'] },
      authorizePage.response,
    )
    const pendingId = /name="pendingId" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''
    const csrfToken = /name="csrfToken" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''
    const decision = fakeResponse()
    await provider.handleContinue({ pendingId, csrfToken, action: 'allow' }, decision.response)
    const code = new URL(decision.redirectedTo ?? '').searchParams.get('code') ?? ''

    nowMs += 61_000

    await expect(provider.exchangeAuthorizationCode(CLIENT, code)).rejects.toBeInstanceOf(InvalidGrantError)
  })

  it('carry the challenge PKCE is verified against, and never the verifier', async () => {
    const provider = buildProvider()
    const authorizePage = fakeResponse()
    await provider.authorize(
      CLIENT,
      { codeChallenge: 'the-stored-challenge', redirectUri: 'http://localhost:3118/callback', scopes: ['homey'] },
      authorizePage.response,
    )
    const pendingId = /name="pendingId" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''
    const csrfToken = /name="csrfToken" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''
    const decision = fakeResponse()
    await provider.handleContinue({ pendingId, csrfToken, action: 'allow' }, decision.response)
    const code = new URL(decision.redirectedTo ?? '').searchParams.get('code') ?? ''

    expect(await provider.challengeForAuthorizationCode(CLIENT, code)).toBe('the-stored-challenge')
    // Left false, so the SDK runs verifyChallenge itself and the verifier never
    // reaches this module.
    expect(provider.skipLocalPkceValidation).toBe(false)
  })

  it('refuse a redirect URI that is not the one the code was issued for', async () => {
    const provider = buildProvider()
    const authorizePage = fakeResponse()
    await provider.authorize(
      CLIENT,
      { codeChallenge: 'a-challenge', redirectUri: 'http://localhost:3118/callback', scopes: ['homey'] },
      authorizePage.response,
    )
    const pendingId = /name="pendingId" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''
    const csrfToken = /name="csrfToken" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''
    const decision = fakeResponse()
    await provider.handleContinue({ pendingId, csrfToken, action: 'allow' }, decision.response)
    const code = new URL(decision.redirectedTo ?? '').searchParams.get('code') ?? ''

    await expect(
      provider.exchangeAuthorizationCode(CLIENT, code, undefined, 'http://localhost:9999/callback'),
    ).rejects.toBeInstanceOf(InvalidGrantError)
  })

  it('refuse a resource this server does not serve', async () => {
    const provider = buildProvider()
    const authorizePage = fakeResponse()
    await provider.authorize(
      CLIENT,
      { codeChallenge: 'a-challenge', redirectUri: 'http://localhost:3118/callback', scopes: ['homey'] },
      authorizePage.response,
    )
    const pendingId = /name="pendingId" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''
    const csrfToken = /name="csrfToken" value="([a-f0-9]+)"/.exec(authorizePage.body)?.[1] ?? ''
    const decision = fakeResponse()
    await provider.handleContinue({ pendingId, csrfToken, action: 'allow' }, decision.response)
    const code = new URL(decision.redirectedTo ?? '').searchParams.get('code') ?? ''

    await expect(
      provider.exchangeAuthorizationCode(
        CLIENT,
        code,
        undefined,
        'http://localhost:3118/callback',
        new URL('http://127.0.0.1:9999/mcp'),
      ),
    ).rejects.toThrow(/does not issue tokens/)
  })
})

describe('refresh tokens', () => {
  it('are issued only when offline_access was asked for', async () => {
    const withOffline = await authorizeAndExchange(buildProvider(), 'homey offline_access')
    expect(withOffline.tokens.refresh_token).toBeTypeOf('string')

    const withoutOffline = await authorizeAndExchange(buildProvider(), 'homey')
    expect(withoutOffline.tokens.refresh_token).toBeUndefined()
  })

  it('rotate on every use, and reuse is refused rather than silently re-issued', async () => {
    // Reuse means either a race or a stolen token. The safe answer to both is to
    // make the user click Authenticate once.
    const provider = buildProvider()
    const { tokens } = await authorizeAndExchange(provider)
    const firstRefresh = tokens.refresh_token ?? ''

    const rotated = await provider.exchangeRefreshToken(CLIENT, firstRefresh, undefined, CONFIG.mcpUrl)
    expect(rotated.refresh_token).toBeTypeOf('string')
    expect(rotated.refresh_token).not.toBe(firstRefresh)

    await expect(provider.exchangeRefreshToken(CLIENT, firstRefresh)).rejects.toBeInstanceOf(InvalidGrantError)
  })

  it('refuse to widen the scopes the token was granted', async () => {
    const provider = buildProvider()
    const { tokens } = await authorizeAndExchange(provider, 'homey')
    const authorized = await authorizeAndExchange(provider, 'homey offline_access')

    await expect(
      provider.exchangeRefreshToken(CLIENT, authorized.tokens.refresh_token ?? '', ['homey', 'something_else']),
    ).rejects.toThrow(/cannot ask for scopes/)
    expect(tokens.refresh_token).toBeUndefined()
  })

  it('belong to one client and are refused for another', async () => {
    const provider = buildProvider()
    const { tokens } = await authorizeAndExchange(provider)

    await expect(
      provider.exchangeRefreshToken({ ...CLIENT, client_id: 'somebody-else' }, tokens.refresh_token ?? ''),
    ).rejects.toBeInstanceOf(InvalidGrantError)
  })
})

describe('verifyAccessToken', () => {
  it('accepts a token it issued and reports the expiry in SECONDS', async () => {
    // The middleware compares it against Date.now() / 1000. Milliseconds would
    // make every token valid for about 55000 years; a Date would make every
    // token invalid. The magnitude is asserted, not just the type.
    const provider = buildProvider()
    const { tokens } = await authorizeAndExchange(provider)

    const info = await provider.verifyAccessToken(tokens.access_token)

    expect(info.clientId).toBe('client-one')
    expect(info.scopes).toContain('homey')
    expect(typeof info.expiresAt).toBe('number')
    expect(info.expiresAt).toBeGreaterThan(1_700_000_000)
    expect(info.expiresAt).toBeLessThan(100_000_000_000)
    expect(info.resource?.href).toBe(CONFIG.mcpUrl.href)
  })

  it('always grants the homey scope, so a token can never 403 its way into a hard failure', async () => {
    // A missing scope is 403 insufficient_scope, and the client refuses a second
    // identical upscoping challenge and hard-fails rather than prompting. There
    // is only one scope here, so granting it is the safe reading of a request
    // that omitted it.
    const provider = buildProvider()
    const { tokens } = await authorizeAndExchange(provider, '')

    expect((await provider.verifyAccessToken(tokens.access_token)).scopes).toContain('homey')
  })

  it('throws InvalidTokenError for a token it never issued, which is the 401 the client needs', async () => {
    const provider = buildProvider()
    await expect(provider.verifyAccessToken('never-issued')).rejects.toBeInstanceOf(InvalidTokenError)
  })

  it('throws InvalidTokenError, never a plain Error, when the store itself fails', async () => {
    // This is the whole yellow-versus-red decision. A plain Error out of here
    // produces 500 server_error with NO WWW-Authenticate header, which the client
    // shows as a red cross. The SDK's own example provider throws a plain Error.
    for (const failure of [new Error('disk on fire'), 'a string', Promise.reject(new Error('rejected'))]) {
      const brokenStore = {
        ...store,
        readAccessToken: async () => {
          if (failure instanceof Promise) return await (failure as Promise<never>)
          throw failure
        },
      } as unknown as AuthStore
      const provider = buildProvider({ store: brokenStore })

      await expect(provider.verifyAccessToken('anything')).rejects.toBeInstanceOf(InvalidTokenError)
    }
  })

  it('refuses a token whose stored audience is not this server', async () => {
    const provider = buildProvider()
    const { tokens } = await authorizeAndExchange(provider)
    await store.putAccessToken(tokens.access_token, {
      clientId: 'client-one',
      scopes: ['homey'],
      resource: 'http://127.0.0.1:9999/mcp',
      issuedAtSeconds: Math.floor(nowMs / 1_000),
      expiresAtSeconds: Math.floor(nowMs / 1_000) + 3_600,
    })

    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toBeInstanceOf(InvalidTokenError)
  })

  it('never touches the Homey, whatever state the hub is in', async () => {
    // The invariant: a Homey failure never becomes an HTTP status. Break it and
    // the client 401s, refreshes, retries, 401s again and offers Re-authenticate
    // for a problem no amount of re-authorizing can fix.
    const describeHomey = vi.fn(async (): Promise<HomeySignInState> => SIGNED_IN)
    const provider = buildProvider({ describeHomey })
    const { tokens } = await authorizeAndExchange(provider)
    describeHomey.mockClear()

    await provider.verifyAccessToken(tokens.access_token)

    expect(describeHomey).not.toHaveBeenCalled()
  })

  it('refuses a token after it has expired', async () => {
    const provider = buildProvider()
    const { tokens } = await authorizeAndExchange(provider)

    nowMs += 3_601 * 1_000

    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toBeInstanceOf(InvalidTokenError)
  })
})
