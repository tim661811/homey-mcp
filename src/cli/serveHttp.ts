// `serve --http`: the loopback HTTP transport and the authorization server.
//
// Reached by a branch in `runServe` and imported dynamically from there, so the
// stdio path never loads express, the OAuth router, cors or express-rate-limit.
// stdio remains the published default and is untouched.
//
// What this mode buys and what it costs, stated here because it is easy to
// forget while reading the wiring. It buys the client's yellow "needs
// authentication" state and a browser sign-in, which is the only route by which
// the durable Homey credential becomes reachable without a terminal. It costs a
// process that has to be kept alive: no MCP client starts an HTTP server, so a
// daemon that is not running shows as a red cross saying it could not connect.
// That is why `service install` exists rather than a line in the README telling
// somebody to keep a terminal open.
//
// The bind is 127.0.0.1 and there is no `--bind`. A LAN bind would fail the SDK's
// own issuer check (which exempts only localhost and 127.0.0.1), would widen the
// exposure of a credential that opens somebody's front door, and would need HTTPS
// to be defensible at all.

import type { Server } from 'node:http'

import express from 'express'
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js'
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { OAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'

import { describeHomeySignIn, verifyAndStorePersonalAccessToken } from '../auth/homeySignIn.js'
import { openReconnectingConnection } from '../homey/connect.js'
import type { ResolvedCredentials } from '../homey/credentials.js'
import { resolveCredentials } from '../homey/credentials.js'
import { classifyError } from '../homey/errors.js'
import { createAuthStore } from '../http/authStore.js'
import type { HttpEndpointConfig } from '../http/config.js'
import { createHttpEndpointConfig, HOMEY_SCOPE, OFFLINE_ACCESS_SCOPE, portInUseMessage, RESOURCE_NAME } from '../http/config.js'
import { AUTHORIZE_CONTINUE_PATH, HomeyOAuthProvider } from '../http/oauthProvider.js'
import { originValidation } from '../http/originValidation.js'
import type { ReadPeerIdentity } from '../http/peerIdentity.js'
import { PEER_IDENTITY_LOCAL, readPeerIdentity } from '../http/peerIdentity.js'
import { renderProblemPage, SIGN_IN_PAGE_HEADERS } from '../auth/page.js'
import { createSessionRegistry } from '../http/sessions.js'
import { createServer } from '../server/createServer.js'
import type { Logger } from '../util/log.js'

export interface ServeHttpOptions {
  argv?: string[]
  environment?: Record<string, string | undefined>
  logger: Logger
  errorOutput: NodeJS.WritableStream
  configPath?: string
  port?: number
}

/** Runs until the process is asked to stop. Resolves with the exit code. */
export async function runServeHttp(options: ServeHttpOptions): Promise<number> {
  const environment = options.environment ?? process.env
  const logger = options.logger
  const config = createHttpEndpointConfig(options.port === undefined ? {} : { port: options.port })

  const loadCredentials = (): Promise<ResolvedCredentials> =>
    resolveCredentials({
      environment,
      logger,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    })

  // Same rule as the stdio path: a missing credential is a state, not a reason to
  // refuse to start. Here it matters more, not less. The transport being up is
  // what produces a client badge that can be acted on at all, so exiting because
  // the Homey is unreachable would turn a solvable problem into an unexplained
  // red cross.
  let unauthenticatedReason: string | undefined
  const credentials = await loadCredentials().catch((error: unknown) => {
    const failure = classifyError(error, { operation: 'resolveCredentials' })
    if (failure.reason !== 'not_connected') throw failure
    logger.warn(failure.message)
    unauthenticatedReason = failure.message
    return undefined
  })

  const connection = await openReconnectingConnection({
    ...(credentials === undefined ? {} : { credentials }),
    loadCredentials,
    logger,
    startWithoutSession: true,
  })

  if (!connection.authenticated && unauthenticatedReason === undefined) {
    unauthenticatedReason = 'The stored credentials did not open a session.'
  }

  // Keyed by port, so a second server started on another port keeps its own
  // clients and tokens instead of erasing this one's on its next write.
  const store = await createAuthStore({ environment, port: config.port })
  const provider = new HomeyOAuthProvider({
    config,
    store,
    logger: logger.child('oauth'),
    describeHomey: async () => await describeHomeySignIn({ connection, environment, logger }),
    storePersonalAccessToken: async (personalAccessToken: string) =>
      await verifyAndStorePersonalAccessToken({
        personalAccessToken,
        environment,
        logger,
        ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      }),
  })

  const sessions = createSessionRegistry({ logger: logger.child('sessions') })

  const app = buildApp({
    config,
    provider,
    createMcpSession: async () =>
      await createServer({
        connection,
        logger,
        ...(unauthenticatedReason === undefined ? {} : { unauthenticatedReason }),
      }),
    sessions,
    logger,
  })

  let httpServer: Server
  try {
    httpServer = await listen(app, config)
  } catch (error: unknown) {
    await connection.close()
    if (isAddressInUse(error)) {
      options.errorOutput.write(`\n${portInUseMessage(config.port)}\n\n`)
      return 1
    }
    throw error
  }

  logger.info(`Listening on ${config.mcpUrl.href}`)
  logger.info(
    'Your assistant will show this server as needing authentication until you approve it once in your browser. Homey sessions last 24 hours and are renewed by this server, not by re-approving.',
  )

  await new Promise<void>((resolve) => {
    const stop = (reason: string): void => {
      logger.info(`${reason}, shutting down`)
      httpServer.close()
      void sessions.closeAll().finally(resolve)
    }

    process.once('SIGINT', () => stop('Received SIGINT'))
    process.once('SIGTERM', () => stop('Received SIGTERM'))
  })

  await connection.close()
  return 0
}

interface BuildAppOptions {
  config: HttpEndpointConfig
  provider: HomeyOAuthProvider
  createMcpSession: () => Promise<{ server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer }>
  sessions: ReturnType<typeof createSessionRegistry>
  logger: Logger
  /** Injected by tests, so the suite asserts each verdict rather than the machine it runs on. */
  readPeerIdentity?: ReadPeerIdentity
}

/** Exported so a test can drive the whole surface without binding a port. */
export function buildApp(options: BuildAppOptions): express.Express {
  const { config, provider, sessions, logger } = options

  // Applies express.json() and the SDK's localhost Host header validation, which
  // is the non-deprecated route to DNS rebinding protection. The transport's own
  // `allowedHosts` is deprecated and, worse, is ignored entirely unless
  // `enableDnsRebindingProtection` is also set, which defaults to false.
  const app = createMcpExpressApp({ host: config.bindHost })
  app.use(originValidation(config.allowedOrigins))

  // Everything under /authorize, which is both the consent page and the form's
  // post back. It is mounted before either of them, and it is the only thing
  // between another account on this machine and a token that can open a front
  // door: without it the whole flow runs headlessly, because the page hands its
  // pendingId and csrfToken to whoever fetched it and a loopback socket is not a
  // per-user boundary. /register, /token and /mcp are not gated here: /token
  // needs a code this gate is what produces, and /mcp needs a token.
  const peerIdentityReader = options.readPeerIdentity ?? readPeerIdentity
  app.use('/authorize', (request, response, next) => {
    void peerIdentityReader(request.socket)
      .then((identity) => {
        if (identity.kind === 'other_user') {
          logger.warn('Refused a sign-in started by another user account on this machine', { uid: identity.uid })
          response
            .status(403)
            .set(SIGN_IN_PAGE_HEADERS)
            .send(
              renderProblemPage(
                'This sign-in came from another account',
                'homey-mcp only signs in the account it is running as. Ask the person whose Homey this is to run their assistant under their own account.',
              ),
            )
          return
        }
        response.locals[PEER_IDENTITY_LOCAL] = identity
        next()
      })
      .catch((error: unknown) => {
        // Fails closed by never storing a verdict: `peerIdentityOf` then reads
        // `unknown` and the approval code is asked for.
        logger.warn('Could not tell which account a sign-in came from', { error })
        next()
      })
  })

  // The consent form's post, mounted before the auth router so it is never
  // reached by the SDK's authorize handler. See `handleContinue` for why it has
  // its own path.
  app.post(AUTHORIZE_CONTINUE_PATH, express.urlencoded({ extended: false }), (request, response) => {
    const body = request.body as Record<string, unknown>
    void provider
      .handleContinue(
        {
          pendingId: asString(body['pendingId']),
          csrfToken: asString(body['csrfToken']),
          action: asString(body['action']),
          personalAccessToken: typeof body['personalAccessToken'] === 'string' ? body['personalAccessToken'] : '',
          approvalCode: asString(body['approvalCode']),
        },
        response,
      )
      .catch((error: unknown) => {
        // Never the token, never the body. Only that the step failed.
        logger.error('The sign-in page could not answer a form post', { error })
        if (!response.headersSent) response.status(500).type('text/plain').send('Something went wrong on this page.')
      })
  })

  // Registered BEFORE mcpAuthRouter so it wins on this exact path. The router
  // derives both metadata documents from one `scopesSupported` list, and the two
  // documents want different answers: the protected resource SHOULD NOT advertise
  // `offline_access`, while the authorization server MUST advertise it or the
  // client never asks for a refresh token and every lapse becomes a browser round
  // trip.
  const protectedResourceMetadata: OAuthProtectedResourceMetadata = {
    resource: config.mcpUrl.href,
    authorization_servers: [config.issuerUrl.href],
    scopes_supported: [HOMEY_SCOPE],
    resource_name: RESOURCE_NAME,
  }
  app.use(
    new URL(getOAuthProtectedResourceMetadataUrl(config.mcpUrl)).pathname,
    metadataHandler(protectedResourceMetadata),
  )

  // Same trick again, and for a related reason: `mcpAuthRouter` builds the
  // authorization server document itself and offers no way to add a field. RFC
  // 9207's `authorization_response_iss_parameter_supported` is a SHOULD in the
  // current revision with a stated intention to become a MUST, and the redirect
  // this server builds already carries the matching `iss` parameter. Advertising
  // one without the other would be the inconsistent half.
  const authorizationServerMetadata = {
    ...createOAuthMetadata({
      provider,
      issuerUrl: config.issuerUrl,
      scopesSupported: [HOMEY_SCOPE, OFFLINE_ACCESS_SCOPE],
    }),
    authorization_response_iss_parameter_supported: true,
  }
  app.use('/.well-known/oauth-authorization-server', metadataHandler(authorizationServerMetadata))

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.issuerUrl,
      resourceServerUrl: config.mcpUrl,
      scopesSupported: [HOMEY_SCOPE, OFFLINE_ACCESS_SCOPE],
      resourceName: RESOURCE_NAME,
      // Never expires. The client registers with `token_endpoint_auth_method:
      // "none"` so no secret is used at all, and the SDK's default 30 day expiry
      // would reject a client that comes back after a month, with nothing
      // prompting it to register again.
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  )

  const authenticate = requireBearerAuth({
    verifier: provider,
    // Not an empty list, so the challenge carries the `scope` parameter the
    // specification asks for. Safe only because every token minted here carries
    // this scope and a numeric expiry; see `grantedScopes`.
    requiredScopes: [HOMEY_SCOPE],
    // Not optional in practice. With a resource server URL that has a path, the
    // protected resource document is mounted only at the path-specific location,
    // and this header is the only thing that points a client at it. It is also
    // the only signal carried by the very first unauthenticated POST, which is
    // the request that decides yellow versus red.
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl),
  })

  const handleMcpRequest = async (
    request: express.Request,
    response: express.Response,
    isPost: boolean,
  ): Promise<void> => {
    const clientId = request.auth?.clientId ?? ''
    const sessionId = readSessionId(request)

    if (sessionId !== null) {
      const record = sessions.claim(sessionId, clientId)
      if (record === undefined) {
        // The same answer a session that does not exist gets. A session is bound
        // to the token that created it, and the specification forbids sessions
        // being used for authentication in the first place.
        respondNotFound(response)
        return
      }
      await record.transport.handleRequest(request, response, isPost ? request.body : undefined)
      return
    }

    if (!isPost || !isInitializeRequest(request.body)) {
      respondBadRequest(response, 'This request needs an MCP-Session-Id, or it must be an initialize request.')
      return
    }

    const { server } = await options.createMcpSession()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId: string) => {
        // Registered here rather than after the constructor returns, because a
        // request can arrive before the constructor's return value has been
        // assigned to anything.
        sessions.register(newSessionId, { transport, server, clientId, lastSeenMs: Date.now() })
      },
      onsessionclosed: (closedSessionId: string) => {
        sessions.forget(closedSessionId)
      },
    })

    transport.onclose = () => {
      if (transport.sessionId !== undefined) sessions.forget(transport.sessionId)
      void server.close().catch(() => undefined)
    }

    // Connected before the request is handled, so the initialize response has a
    // transport to travel back through.
    await server.connect(transport)
    await transport.handleRequest(request, response, request.body)
  }

  const wrap =
    (isPost: boolean) =>
    (request: express.Request, response: express.Response): void => {
      void handleMcpRequest(request, response, isPost).catch((error: unknown) => {
        logger.error('An MCP request failed', { error })
        if (!response.headersSent) respondServerError(response)
      })
    }

  app.post('/mcp', authenticate, wrap(true))
  app.get('/mcp', authenticate, wrap(false))
  app.delete('/mcp', authenticate, wrap(false))

  return app
}

function readSessionId(request: express.Request): string | null {
  const header = request.headers['mcp-session-id']
  if (typeof header === 'string' && header !== '') return header
  if (Array.isArray(header) && header[0] !== undefined && header[0] !== '') return header[0]
  return null
}

function respondNotFound(response: express.Response): void {
  response.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null })
}

function respondBadRequest(response: express.Response, message: string): void {
  response.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null })
}

function respondServerError(response: express.Response): void {
  response.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** True for the one failure that has an answer a user can act on. */
export function isAddressInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EADDRINUSE'
}

async function listen(app: express.Express, config: HttpEndpointConfig): Promise<Server> {
  return await new Promise<Server>((resolve, reject) => {
    const server = app.listen(config.port, config.bindHost)
    server.once('listening', () => {
      server.removeListener('error', reject)
      resolve(server)
    })
    server.once('error', reject)
  })
}
