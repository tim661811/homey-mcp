// What `doctor --http` reports.
//
// `doctor` is load-bearing in this project: it is the only route by which
// untested hardware paths get real data, and it is what the issue templates tell
// people to run. The HTTP mode gives it a fifth thing to answer, and the reason
// it needs its own section is the mode's one genuinely new failure: the daemon is
// not running. That reaches the client as "ConnectionRefused: Unable to connect",
// with nothing in it saying which of four things went wrong.
//
// So each probe below corresponds to a measured failure that otherwise shows up
// as an unexplained red cross:
//
//   - the port is silent                     -> the service is not running
//   - no WWW-Authenticate on the 401          -> the client shows red, not yellow
//   - a `resource` that is not its own URL    -> RFC 9728 says MUST NOT be used
//   - no code_challenge_methods_supported     -> the client refuses to proceed
//   - /register absent                        -> measured: yellow becomes red
//
// Everything reported is a count, a verdict or a port. Never a client id, never
// token material, never a home directory path, so `--report` needs no extra
// scrubbing rule for it.

import { connect } from 'node:net'

import type { DoctorCheck } from '../homey/types.js'
import { createAuthStore } from './authStore.js'
import type { HttpEndpointConfig } from './config.js'
import { createHttpEndpointConfig } from './config.js'

export interface DoctorHttpMode {
  /** The address a client has to be given, which is also the resource identifier. */
  url: string
  port: number
  portIsListening: boolean
  registeredClients: number
  liveAccessTokens: number
  liveRefreshTokens: number
  /** Whole days since the OAuth state was last written, or null when there is none. */
  authStateAgeDays: number | null
}

export interface CollectHttpDoctorOptions {
  port?: number
  environment?: Record<string, string | undefined>
  /** Injected by tests. Defaults to the global fetch. */
  fetchImplementation?: typeof fetch
  now?: () => Date
}

export interface HttpDoctorSection {
  httpMode: DoctorHttpMode
  checks: DoctorCheck[]
}

export async function collectHttpDoctorSection(
  options: CollectHttpDoctorOptions = {},
): Promise<HttpDoctorSection> {
  const config = createHttpEndpointConfig(options.port === undefined ? {} : { port: options.port })
  const fetchImplementation = options.fetchImplementation ?? fetch
  const now = options.now ?? ((): Date => new Date())

  const store = await createAuthStore({
    port: config.port,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  })
  const counts = await store.countLiveTokens()
  const lastWritten = await store.lastWrittenAt()

  const portIsListening = await portAnswers(config.port)

  const httpMode: DoctorHttpMode = {
    url: config.mcpUrl.href,
    port: config.port,
    portIsListening,
    registeredClients: await store.countClients(),
    liveAccessTokens: counts.accessTokens,
    liveRefreshTokens: counts.refreshTokens,
    authStateAgeDays:
      lastWritten === null ? null : Math.floor((now().getTime() - lastWritten.getTime()) / 86_400_000),
  }

  if (!portIsListening) {
    return {
      httpMode,
      checks: [
        {
          id: 'http_listening',
          title: 'The HTTP mode is not answering',
          status: 'fail',
          detail: `Nothing is listening on port ${config.port}, so an assistant pointed at ${config.mcpUrl.href} shows a red cross saying it could not connect.`,
          // Both commands carry the port. Without it, somebody who runs the
          // service on another port is told to install a SECOND service on
          // 8431, which is the two-servers case this project keeps one state
          // file per port to survive.
          fix: `Run "npx homey-mcp service status --port ${config.port}" to see whether the service is installed and running, and "npx homey-mcp service install --port ${config.port}" if it is not.`,
        },
      ],
    }
  }

  const checks: DoctorCheck[] = [
    {
      id: 'http_listening',
      title: 'The HTTP mode is answering',
      status: 'pass',
      detail: `Something is listening on port ${config.port}.`,
      fix: null,
    },
    await probeUnauthenticatedPost(config, fetchImplementation),
    await probeProtectedResourceMetadata(config, fetchImplementation),
    await probeAuthorizationServerMetadata(config, fetchImplementation),
    await probeRegistration(config, fetchImplementation),
  ]

  return { httpMode, checks }
}

/** The request that decides whether the client shows yellow or red. */
async function probeUnauthenticatedPost(
  config: HttpEndpointConfig,
  fetchImplementation: typeof fetch,
): Promise<DoctorCheck> {
  try {
    const response = await fetchImplementation(config.mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    const challenge = response.headers.get('www-authenticate') ?? ''

    if (response.status !== 401) {
      return failure(
        'http_challenge',
        `An unauthenticated call answered ${response.status} rather than 401, so your assistant will not offer to sign you in.`,
      )
    }
    if (!challenge.includes('resource_metadata=')) {
      return failure(
        'http_challenge',
        'The 401 carries no resource_metadata in its WWW-Authenticate header, which is the one thing that makes an assistant say "needs authentication" instead of "failed to connect".',
      )
    }

    return {
      id: 'http_challenge',
      title: 'An unsigned-in assistant is told how to sign in',
      status: 'pass',
      detail: 'A call with no token answers 401 with a WWW-Authenticate header naming where to look.',
      fix: null,
    }
  } catch (error: unknown) {
    return failure('http_challenge', `The unauthenticated probe failed: ${describe(error)}`)
  }
}

async function probeProtectedResourceMetadata(
  config: HttpEndpointConfig,
  fetchImplementation: typeof fetch,
): Promise<DoctorCheck> {
  const metadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', config.issuerUrl)
  try {
    const response = await fetchImplementation(metadataUrl)
    const body = (await response.json()) as { resource?: unknown }

    if (body.resource !== config.mcpUrl.href) {
      // RFC 9728 section 3.3: if these are not identical the data MUST NOT be
      // used. On loopback that breaks invisibly, since localhost and 127.0.0.1
      // are different identifiers and a trailing slash is another one again.
      return failure(
        'http_resource_metadata',
        `The resource identifier it advertises (${String(body.resource)}) is not the URL it is served from (${config.mcpUrl.href}), so a client must refuse it.`,
      )
    }

    return {
      id: 'http_resource_metadata',
      title: 'The resource identifier matches its own address',
      status: 'pass',
      detail: `Advertised as ${config.mcpUrl.href}.`,
      fix: null,
    }
  } catch (error: unknown) {
    return failure('http_resource_metadata', `The protected resource document could not be read: ${describe(error)}`)
  }
}

async function probeAuthorizationServerMetadata(
  config: HttpEndpointConfig,
  fetchImplementation: typeof fetch,
): Promise<DoctorCheck> {
  try {
    const response = await fetchImplementation(new URL('/.well-known/oauth-authorization-server', config.issuerUrl))
    const body = (await response.json()) as { code_challenge_methods_supported?: unknown }

    if (!Array.isArray(body.code_challenge_methods_supported) || body.code_challenge_methods_supported.length === 0) {
      // Only OPTIONAL in RFC 8414, but a client "MUST refuse to proceed" when it
      // is absent, so a server that omits it looks correct and simply never
      // authenticates anybody.
      return failure(
        'http_authorization_server',
        'It does not advertise a PKCE code challenge method, which makes a client refuse to sign in at all.',
      )
    }

    return {
      id: 'http_authorization_server',
      title: 'The sign-in service advertises what a client needs',
      status: 'pass',
      detail: `PKCE methods offered: ${body.code_challenge_methods_supported.join(', ')}.`,
      fix: null,
    }
  } catch (error: unknown) {
    return failure('http_authorization_server', `The sign-in service could not be read: ${describe(error)}`)
  }
}

/**
 * The precondition nothing documents.
 *
 * Measured: with `/register` answering 404, an identical 401 with an identical
 * header produced a red "failed to connect" rather than the yellow "needs
 * authentication". So the endpoint is probed rather than assumed.
 *
 * Deliberately posted with a body the endpoint must REFUSE, and the check is
 * that it refuses it as a registration endpoint (400 with an OAuth error) rather
 * than as a path that does not exist (404). Two reasons, and the second is the
 * one that matters:
 *
 * A successful registration would persist a phantom assistant, so every run of a
 * diagnostic would inflate the count this same section reports. And deleting it
 * again is not available: `doctor` is a second process, the running server holds
 * the whole state in memory and rewrites the file wholesale on its next write,
 * so a deletion here would be undone by the server and could clobber whatever the
 * server had written in between.
 */
async function probeRegistration(
  config: HttpEndpointConfig,
  fetchImplementation: typeof fetch,
): Promise<DoctorCheck> {
  try {
    const response = await fetchImplementation(new URL('/register', config.issuerUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No redirect_uris, which every registration endpoint must reject.
      body: JSON.stringify({ client_name: 'homey-mcp doctor probe' }),
    })

    if (response.status === 404 || response.status === 405) {
      return failure(
        'http_registration',
        'There is no registration endpoint, and without one an assistant shows a red cross rather than offering to sign in.',
      )
    }

    // A rate-limited answer proves exactly what this probe is trying to
    // establish: the endpoint is mounted, and it is the SDK's own limiter
    // answering. Measured: the limiter allows 20 requests an hour per address,
    // counts refused ones, and loopback makes that one global budget, so a
    // debugging session that runs doctor twenty times reaches it. Reading it as
    // a broken endpoint told the user to reinstall a perfectly healthy service.
    if (response.status === 429) {
      return {
        id: 'http_registration',
        title: 'An assistant can register itself',
        status: 'pass',
        detail:
          'The registration endpoint is mounted and is currently rate limiting, which is its own protection answering rather than a fault. It accepts about twenty registrations an hour.',
        fix: null,
      }
    }

    const body = (await response.json()) as { error?: unknown }
    if (body.error !== 'invalid_client_metadata') {
      return failure(
        'http_registration',
        `The registration endpoint answered ${response.status} with ${JSON.stringify(body)}, which is not how a registration endpoint refuses an incomplete request.`,
      )
    }

    return {
      id: 'http_registration',
      title: 'An assistant can register itself',
      status: 'pass',
      detail: 'The registration endpoint is mounted and answering. Nothing was registered by this check.',
      fix: null,
    }
  } catch (error: unknown) {
    return failure('http_registration', `The registration endpoint could not be reached: ${describe(error)}`)
  }
}

function failure(id: string, detail: string): DoctorCheck {
  return {
    id,
    title: 'The HTTP mode is not set up correctly',
    status: 'fail',
    detail,
    fix: 'Stop and restart the service ("npx homey-mcp service install"), then run this again. If it persists, this is worth a bug report with the output of "npx homey-mcp doctor --http --report".',
  }
}

/** True when something is listening. Not a health check: an answer of any kind counts. */
async function portAnswers(port: number, timeoutMs = 1_500): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const settle = (answer: boolean): void => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
