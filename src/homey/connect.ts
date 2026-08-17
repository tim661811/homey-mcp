// Building the connection to the hub.
//
// The one thing never to do here is call `HomeyAPI.createLocalAPI()`. It
// hardcodes the V3 dialect, connects perfectly happily against a V2 hub, and
// then fails much later on the first write, by which point the failure looks
// like a permissions problem instead of a wrong client class. Two supported
// routes are used instead: let the Athom cloud tell the library which dialect
// the hub speaks, or, when a hub session token and a LAN address are already
// known, construct the right class directly and never leave the network.
//
// No credential source names the hub's LAN address, so the second route has
// nothing to try until something teaches it one. Two sources do: the Athom
// cloud's record of the Homey, and the hub's own `system.getInfo()`, which
// reports the address it answers on. Whichever route came up, the answer is
// cached here and every later start reads it back and stays on the network.
// The hub's own answer is what keeps that true when the cloud is never reached
// at all, for instance after the one hour cloud token has died and only the 24
// hour hub session is left.
//
// Either way the dialect recorded on the connection comes from looking at a real
// flow card descriptor, because that is a fact about the hub rather than a fact
// about which class happened to be instantiated.
//
// The library ships type declarations that describe its documented surface but
// not its constructors (they are marked `@hideconstructor`), so the few places
// that construct one of its classes go through the small structural types
// declared at the bottom of this file. That keeps the casts in one place and
// documents exactly which parts of `homey-api` this server depends on.

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { AthomCloudAPI, HomeyAPIV2, HomeyAPIV3Local } from 'homey-api'

import { buildAddressCandidates, classifyAddress, probeAddresses } from './discovery.js'
import { classifyError, HomeyMcpError } from './errors.js'
import { createRequestQueue } from './throttle.js'
import type {
  AddressProbeResult,
  HomeyAddressKind,
  HomeyConnection,
  HomeyDialect,
  HomeyIdentity,
  HomeySystemInfo,
  RequestQueue,
} from './types.js'
import type { ResolvedCredentials } from './credentials.js'
import { isCloudTokenExpired, isSessionExpired } from './credentials.js'
import type { Logger } from '../util/log.js'
import { logger as defaultLogger } from '../util/log.js'
import { asNumber, asString } from '../util/coerce.js'

/**
 * The one flow card that is guaranteed to be there and can never fire by
 * itself. Measured: `homey:manager:flow` / `programmatic_trigger` exists on the
 * 2019 generation, which makes it the safe card to probe with.
 */
export const DIALECT_PROBE_OWNER_URI = 'homey:manager:flow'
export const DIALECT_PROBE_CARD_ID = 'programmatic_trigger'

export interface ConnectToHomeyOptions {
  logger?: Logger
  /** Reuse an existing queue. One queue per hub, always. */
  queue?: RequestQueue
  /** Address ladder to walk. Defaults to localSecure, then local, then cloud. */
  strategy?: HomeyAddressKind[]
  probeTimeoutMs?: number
  /** Injected by tests. Defaults to the global fetch. */
  fetchImplementation?: typeof fetch
  /**
   * Athom OAuth client credentials. Only needed to refresh an expiring cloud
   * token; nothing is embedded in this package, so without them an expired
   * session is reported with instructions rather than silently renewed.
   */
  athomClientId?: string
  athomClientSecret?: string
  /** Overrides where the learned LAN addresses are remembered. Injected by tests. */
  hubAddressCachePath?: string
  /** Injected by tests so an expiry check does not depend on the wall clock. */
  now?: () => Date
}

/** Everything `doctor` wants to show about how the connection was established. */
export interface ConnectionDiagnostics {
  /**
   * How the session was obtained, which is a different question from which
   * address it landed on.
   *
   * `lan_session` means a stored hub session token authenticated straight at the
   * Homey with no Athom round trip. That is almost always a LAN address; when
   * only the Homey's cloud id is known it can be the hub's own cloud origin,
   * which still skips the Athom OAuth handshake. `identity.addressKind` reports
   * which rung actually answered.
   */
  route: 'lan_session' | 'athom_cloud'
  probes: AddressProbeResult[]
  dialectEvidence: string
  credentialSource: string
}

export interface HomeyConnectionWithDiagnostics extends HomeyConnection {
  readonly diagnostics: ConnectionDiagnostics
}

export async function connectToHomey(
  credentials: ResolvedCredentials,
  options: ConnectToHomeyOptions = {},
): Promise<HomeyConnectionWithDiagnostics> {
  const logger = (options.logger ?? defaultLogger).child('connect')
  const queue = options.queue ?? createRequestQueue({ logger })
  const fetchImplementation = options.fetchImplementation ?? fetch
  const cachePath = options.hubAddressCachePath ?? hubAddressCachePath()
  const internalOptions: InternalOptions = { ...options, logger, fetchImplementation, cachePath }

  const request = <T>(operation: () => Promise<T>, label: string, idempotent = false): Promise<T> =>
    queue.run(operation, label, idempotent)

  assertSessionUsable(credentials, options.now?.() ?? new Date())

  // The hub session route first, over LAN addresses only. It is the fast one
  // (measured 25 ms against 195 ms through the cloud) and it does not need Athom
  // to be reachable at all.
  const overLan = await tryLocalNetworkRoute(credentials, internalOptions, { allowHubCloudOrigin: false })
  const established = overLan ?? (await connectWithoutKnownLanAddress(credentials, internalOptions))

  const { identity, hubReportedAddresses } = await readIdentity({
    api: established.api,
    request,
    address: established.address,
    addressKind: established.addressKind,
  })

  // Remembered only now, once the addresses have proven to belong to a Homey
  // that answers. This is what makes the LAN route reachable on the next start:
  // no credential source announces the hub's LAN address, so without a cache the
  // route above can never have any candidate to try.
  await rememberHubAddresses(
    cachePath,
    identity.id,
    mergeHubAddresses(established.learnedAddresses, hubReportedAddresses),
    logger,
  )

  logger.info(`Connected to ${identity.modelName} over ${established.addressKind}`, {
    dialect: established.dialect,
    softwareVersion: identity.softwareVersion,
    route: established.route,
  })

  return {
    api: established.api,
    dialect: established.dialect,
    identity,
    queue,
    request,
    diagnostics: {
      route: established.route,
      probes: established.probes,
      dialectEvidence: established.dialectEvidence,
      credentialSource: credentials.sourceDescription,
    },
  }
}

// ---------------------------------------------------------------------------
// Surviving the 24 hour session wall
// ---------------------------------------------------------------------------

/**
 * How long to wait before trying to rebuild a session again after an attempt.
 *
 * A rebuild walks the whole address ladder, so without a floor a Homey that is
 * simply off the network would get one full ladder walk per tool call. Long
 * enough to keep that quiet, short enough that a user who has just run
 * "homey login" does not sit waiting.
 */
export const DEFAULT_SESSION_RETRY_INTERVAL_MS = 30_000

export interface ReconnectingConnectionOptions {
  /**
   * The credentials the first connection is made with, already resolved.
   *
   * Optional, because there may not be any: a server can start with nothing to
   * sign in with and acquire a session later. `loadCredentials` is what is used
   * from then on, and it is read again every time.
   */
  credentials?: ResolvedCredentials
  /**
   * Reads the credential source again. Called before every rebuild and its
   * answer is never cached, because the file on disk is routinely newer than
   * what this process started with: the Homey CLI refreshes its own session in
   * the same file, so by the time a 24 hour session dies the replacement is
   * often already sitting there.
   */
  loadCredentials: () => Promise<ResolvedCredentials>
  logger?: Logger
  /** Passed to every connect, first and later. */
  connectOptions?: ConnectToHomeyOptions
  /** Injected by tests. Defaults to `connectToHomey`. */
  connectImplementation?: (
    credentials: ResolvedCredentials,
    options: ConnectToHomeyOptions,
  ) => Promise<HomeyConnectionWithDiagnostics>
  retryIntervalMs?: number
  /** Injected by tests so the cooldown does not depend on the wall clock. */
  now?: () => number
  /**
   * Start even when no session can be established, and report that per call.
   *
   * What this is for: an MCP client that cannot complete a handshake shows the
   * server as failed and says nothing about why. Exiting at startup therefore
   * turned the most ordinary situation there is, a credential that expired
   * overnight, into a red cross with no route out of it. Starting anyway lets
   * the handshake succeed, so the client lists the tools, every call that needs
   * the hub explains what to do, and `homey_authenticate` fixes it from inside
   * the conversation.
   */
  startWithoutSession?: boolean
}

export interface ReconnectingConnection extends HomeyConnectionWithDiagnostics {
  /** 1 for the session the server started with, one more for every rebuild. */
  readonly sessionCount: number
  /**
   * False when the server is running without a Homey session. Reading `identity`,
   * `dialect` or `diagnostics` throws in that state, so anything that reports on
   * the hub has to check this first.
   */
  readonly authenticated: boolean
  /**
   * Signs in, or confirms an existing session, and answers with the hub's
   * identity. What `homey_authenticate` calls. Throws an error naming both routes
   * when it cannot.
   */
  authenticate(): Promise<HomeyIdentity>
  /** Closes whichever session is current. Safe when there is none. */
  close(): Promise<void>
}

/**
 * A connection that survives its own session expiring.
 *
 * Measured on the hardware: a hub session lasts exactly 24 hours. An MCP server
 * is normally left running, so the interesting lifetime of this process is days,
 * and a connection that is resolved once at startup means every tool call after
 * the first day fails with no route back from inside the process. The user sees
 * a server that worked yesterday and answers nothing today.
 *
 * Three things make the rebuild honest:
 *
 * The credential source is read again rather than reused, because the session
 * that replaces the dead one usually already exists on disk.
 *
 * Only a call that declared itself idempotent is repeated afterwards. A write
 * that failed is reported, with its session renewed, so the caller decides
 * whether to send it again. Repeating it here is exactly the case the
 * idempotency rule forbids, and it is not a theoretical one: the request queue
 * once started the same flow four times.
 *
 * `api` is a live view of the current session rather than a captured object.
 * Everything downstream reads `connection.api` once and holds it: `createHomeCache`
 * captures it at construction and keeps it for the life of the process, and each
 * tool captures it at the top of a handler. Swapping a plain property would
 * leave every one of those holding the dead client, so the rebuild would change
 * nothing anybody can see.
 */
export async function openReconnectingConnection(
  options: ReconnectingConnectionOptions,
): Promise<ReconnectingConnection> {
  const logger = (options.logger ?? defaultLogger).child('session')
  const connect = options.connectImplementation ?? connectToHomey
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_SESSION_RETRY_INTERVAL_MS
  const now = options.now ?? (() => Date.now())

  // One queue for the hub, not one per session. The hub rate limits itself, so a
  // second queue would let a rebuild's traffic race the queue it was meant to be
  // spaced against, and `doctor` reports this queue's depth.
  const queue = options.connectOptions?.queue ?? createRequestQueue({ logger })
  const connectOptions: ConnectToHomeyOptions = { ...options.connectOptions, logger, queue }

  // Null means no session yet, which is a state this server can run in rather
  // than a reason to refuse to start. See `startWithoutSession`.
  let current: HomeyConnectionWithDiagnostics | null = null
  let startupFailure: HomeyMcpError | null = null

  const initialCredentials = options.credentials
  if (initialCredentials === undefined) {
    // Nothing to try with. Not a failure to report as one: it is the state of a
    // machine that has never been set up, and the first tool call will read the
    // credential source again in case that changed.
    if (options.startWithoutSession !== true) {
      throw new HomeyMcpError('not_connected', 'No credentials were supplied to open a Homey session with.')
    }
    logger.warn('Starting without any credentials, every tool will say so until this is signed in')
  } else {
    try {
      current = await connect(initialCredentials, connectOptions)
    } catch (error) {
      if (options.startWithoutSession !== true) throw error
      startupFailure = classifyError(error, { operation: 'connectToHomey' })
      logger.warn('Starting without a Homey session, every tool will say so until this is signed in', {
        reason: startupFailure.reason,
      })
    }
  }
  // Zero when the server started without one, so `doctor` and the logs can tell
  // "never signed in" from "signed in once".
  let sessionCount = current === null ? 0 : 1

  let rebuildInFlight: Promise<void> | null = null
  let lastAttemptAt = Number.NEGATIVE_INFINITY
  /** Why the last rebuild failed, so the calls inside the cooldown say that instead of the raw refusal. */
  let lastRebuildFailure: HomeyMcpError | null = null

  async function rebuild(): Promise<void> {
    const credentials = await options.loadCredentials()
    const next = await connect(credentials, connectOptions)
    const previous = current
    current = next
    sessionCount += 1
    lastRebuildFailure = null
    // After the swap, so a slow teardown cannot delay the calls that are waiting
    // for the new session, and a failing one cannot undo it. Null on the first
    // sign-in of a server that started without a session: nothing to tear down.
    if (previous !== null) await disconnectFromHomey(previous)
    logger.info('Signed in again after Homey refused the previous session', {
      session: sessionCount,
      route: next.diagnostics.route,
      addressKind: next.identity.addressKind,
    })
  }

  /**
   * Rebuilds at most one session at a time, and at most one per retry interval.
   *
   * Concurrent callers share the attempt rather than each starting one: without
   * that, a client that fires several tool calls at once would sign in several
   * times over, on a hub that refuses requests arriving together.
   */
  async function ensureFreshSession(trigger: HomeyMcpError): Promise<void> {
    if (rebuildInFlight !== null) return await rebuildInFlight

    if (now() - lastAttemptAt < retryIntervalMs) {
      // Already tried a moment ago. What this window is for is the work: a
      // rebuild walks the whole address ladder, and a Homey that is off the
      // network would otherwise get one walk per tool call. It is not for the
      // answer the caller gets, which stays the same inside the window as
      // outside it.
      //
      // The last attempt failed, so its reason is the useful one: it is the
      // sentence that names the command to run, where the refusal this call saw
      // names nothing.
      if (lastRebuildFailure !== null) throw lastRebuildFailure

      // The last attempt worked, so the session is seconds old and there is
      // nothing to rebuild. Returning rather than rethrowing is what stops a
      // caller inside the window getting a worse answer than one outside it:
      // the bare refusal, with none of the guidance below about what did and did
      // not happen to their house.
      return
    }

    lastAttemptAt = now()
    logger.warn('Homey refused the session, reading the credentials again to sign in once more', {
      reason: trigger.reason,
    })

    // Wrapped inside the shared promise rather than around the await, so a
    // caller that joined an attempt in progress is told exactly what the caller
    // that started it was told.
    const attempt = (async (): Promise<void> => {
      try {
        await rebuild()
      } catch (error) {
        const failure = classifyError(error, { operation: 'reconnect' })
        // Kept so every later call inside the cooldown gets this sentence rather
        // than a bare refusal, and so nothing repeats a stack trace per call.
        lastRebuildFailure = new HomeyMcpError(
          failure.reason,
          `The Homey session this server started with is no longer accepted, and signing in again did not work either. ${failure.message}`,
          { ...failure.details, sessions: sessionCount },
          { cause: error },
        )
        throw lastRebuildFailure
      }
    })()

    rebuildInFlight = attempt
    try {
      await attempt
    } finally {
      rebuildInFlight = null
    }
  }

  /**
   * The current session, signing in first when there is none.
   *
   * A server that started without one reaches this on its first tool call, which
   * is the right moment to try: by then the user may well have signed in since,
   * and the alternative is refusing forever on the strength of one failure at
   * startup. The cooldown inside `ensureFreshSession` keeps a hub that is off the
   * network from being walked once per call.
   */
  async function requireSession(): Promise<HomeyConnectionWithDiagnostics> {
    if (current !== null) return current

    try {
      await ensureFreshSession(
        startupFailure ??
          new HomeyMcpError('not_connected', 'This server has no Homey session yet.', { sessions: sessionCount }),
      )
    } catch (error) {
      // The rebuild's own message says what the hub refused, which is the useful
      // half for someone reading a log. It does not say what to DO, and this is
      // the one path where the caller has never had a working session and needs
      // exactly that. So the reason is kept and the instructions are added.
      throw needsAuthenticationError(startupFailure, sessionCount, error)
    }

    if (current === null) throw needsAuthenticationError(startupFailure, sessionCount)
    return current
  }

  async function request<T>(operation: () => Promise<T>, label: string, idempotent = false): Promise<T> {
    const session = await requireSession()
    try {
      return await session.request(operation, label, idempotent)
    } catch (error) {
      const failure = classifyError(error, { operation: label })
      // `not_connected` is the only reason a new session can fix: the hub
      // refused the credential, or nothing answered at the address this session
      // was built on. Every other reason describes the request rather than the
      // connection, and reconnecting would only hide it.
      if (failure.reason !== 'not_connected') throw failure

      await ensureFreshSession(failure)

      if (!idempotent) {
        throw new HomeyMcpError(
          'transient',
          `Homey refused the session while running ${label}, so it did not carry this call out. This server has signed in again, so the call can simply be made once more. It was not repeated automatically because it changes something in your home, and this server never repeats one of those by itself.`,
          { ...failure.details, sessionRenewed: true },
          { cause: error },
        )
      }

      // A read, so repeating it changes nothing. It runs against the session
      // that has just replaced the dead one, because `operation` reaches the hub
      // through the live `api` view above.
      return await (await requireSession()).request(operation, label, idempotent)
    }
  }

  /** Whichever session is current, refusing rather than pretending when there is none. */
  const established = (): HomeyConnectionWithDiagnostics => {
    if (current === null) throw needsAuthenticationError(startupFailure, sessionCount)
    return current
  }

  return {
    // A live view rather than the current session's object: see the note above.
    api: createLiveApiView(() => established().api),
    get dialect(): HomeyDialect {
      return established().dialect
    },
    get identity(): HomeyIdentity {
      return established().identity
    },
    get diagnostics(): ConnectionDiagnostics {
      return established().diagnostics
    },
    get sessionCount(): number {
      return sessionCount
    },
    get authenticated(): boolean {
      return current !== null
    },
    authenticate: async (): Promise<HomeyIdentity> => {
      const session = await requireSession()
      return session.identity
    },
    queue,
    request,
    close: async (): Promise<void> => {
      if (current !== null) await disconnectFromHomey(current)
    },
  }
}

/**
 * The failure a caller gets when there is no session and one could not be made.
 *
 * Worded for the person, not the model: it names both routes and says which one
 * lasts. The reason stays `not_connected` rather than becoming a new taxonomy
 * entry, because every consumer of that reason already treats it as "cannot
 * reach the hub, and retrying the same call will not change that".
 */
function needsAuthenticationError(
  startupFailure: HomeyMcpError | null,
  sessionCount: number,
  cause?: unknown,
): HomeyMcpError {
  const reported = cause instanceof HomeyMcpError ? cause : startupFailure
  return new HomeyMcpError(
    'not_connected',
    [
      'This server is not signed in to your Homey yet, so it cannot read or change anything.',
      reported === null || reported === undefined ? '' : `The last attempt said: ${reported.message}`,
      // Only what the reported message does not already say. It names both
      // routes itself, and repeating them here made a wall of text a model has
      // to wade through to find the one new instruction.
      //
      // And it says what the tool actually does: it reads the credential source
      // again and signs in with whatever is there. It does not open a browser
      // itself, and promising that would send someone to wait for a window that
      // never appears.
      'Once that is done, call "homey_authenticate" here. It picks up the new credential without restarting anything, and answers with the name of the Homey it reached.',
    ]
      .filter(Boolean)
      .join(' '),
    { needsAuthentication: true, sessions: sessionCount, ...(reported?.details ?? {}) },
    { cause: cause ?? startupFailure ?? undefined },
  )
}

/**
 * A stand-in for the `homey-api` instance that always reads the current one.
 *
 * Only `get` and `has` are trapped, which is every way this codebase touches the
 * instance: it reads a manager (`api.devices`) or calls a method on the instance
 * itself (`api.call(...)`, `api.destroy()`).
 *
 * Methods are bound to the real instance on the way out. The library's own
 * methods read private class fields, and a private field read throws a TypeError
 * when `this` is a proxy rather than the instance the field was installed on. A
 * manager object is handed back untouched, so calls into it never pass through
 * here at all.
 */
function createLiveApiView(readApi: () => unknown): unknown {
  return new Proxy(Object.create(null) as object, {
    get(_target, property): unknown {
      const api = readApi() as object
      const value = Reflect.get(api, property, api)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(api) : value
    },
    has(_target, property): boolean {
      return Reflect.has(readApi() as object, property)
    },
  })
}

/** Closes the connection's transport. Safe to call on a connection that never opened a socket. */
export async function disconnectFromHomey(connection: HomeyConnection): Promise<void> {
  try {
    const api = connection.api as { destroy?: () => void } | null
    api?.destroy?.()
  } catch {
    // Tearing down is best effort. A failure here must never mask the reason the
    // caller was shutting down in the first place.
  }
}

interface EstablishedApi {
  api: unknown
  probes: AddressProbeResult[]
  route: 'lan_session' | 'athom_cloud'
  address: string
  addressKind: HomeyAddressKind
  dialect: HomeyDialect
  dialectEvidence: string
  /** LAN addresses this route learned and the next start should reuse. Absent when it learned none. */
  learnedAddresses?: HubAddresses
}

interface InternalOptions extends ConnectToHomeyOptions {
  logger: Logger
  fetchImplementation: typeof fetch
  /** Already resolved, so every route reads the same file. */
  cachePath: string
}

/**
 * True when there is an Athom account credential worth trying.
 *
 * A cloud token that is known to have died does not count. Measured lifetimes:
 * the Homey CLI's cloud token lives a little over an hour while the hub session
 * it minted lives 24 hours, so for most of any day the file holds a dead cloud
 * token next to a live hub session. Counting the dead one as a credential is
 * what put the cloud route ahead of a session that still works.
 */
function hasAthomCredential(credentials: ResolvedCredentials, now: Date): boolean {
  if (credentials.personalAccessToken !== null) return true
  return credentials.cloudToken !== null && !isCloudTokenExpired(credentials, now)
}

/**
 * No LAN address answered, so pick between the two remaining routes.
 *
 * The Athom cloud route comes first when there is an account credential for it,
 * because it is the only one that can mint a fresh hub session and the only one
 * that learns where the hub lives on the network. When it fails, the hub's own
 * cloud origin is tried on the stored hub session, which needs no Athom
 * handshake at all: measured, it answers in 318 ms.
 *
 * The failure that surfaces on a total loss is the cloud one, never the second
 * attempt's. "Your session expired, run homey login" names a command; "no
 * address answered" names nothing anybody can act on.
 */
async function connectWithoutKnownLanAddress(
  credentials: ResolvedCredentials,
  options: InternalOptions,
): Promise<EstablishedApi> {
  const now = options.now?.() ?? new Date()

  if (!hasAthomCredential(credentials, now)) return connectWithHubSessionOnly(credentials, options)

  let cloudFailure: unknown
  try {
    return await connectThroughAthomCloud(credentials, options)
  } catch (error) {
    cloudFailure = error
  }

  // No guard on the session here on purpose: `tryLocalNetworkRoute` already
  // refuses a missing or expired hub session and answers null, so the rule for
  // when that route is usable lives in exactly one place.
  const overHubCloudOrigin = await tryLocalNetworkRoute(credentials, options, { allowHubCloudOrigin: true })
  if (overHubCloudOrigin !== null) {
    options.logger.info('The Athom cloud route failed, but the stored Homey session reached the hub directly')
    return overHubCloudOrigin
  }

  throw cloudFailure
}

/**
 * Refuses to start on a session that is already known to be dead, with the exact
 * command that fixes it.
 *
 * Measured on the hardware: a hub session lasts exactly 24 hours. Left to run,
 * an expired one produces a 401 somewhere further in, which reads like a
 * permissions problem rather than like "sign in again". This only fires when the
 * expired session is the only credential there is: an Athom token in the same
 * file can mint a new hub session, so that case is not a failure at all.
 */
function assertSessionUsable(credentials: ResolvedCredentials, now: Date): void {
  if (!isSessionExpired(credentials, now)) return
  if (hasAthomCredential(credentials, now)) return

  throw new HomeyMcpError(
    'not_connected',
    // "credential" rather than "token" because both a Personal Access Token and
    // a cloud token qualify, and naming one of them would send someone looking
    // for the wrong thing.
    `The Homey session in ${credentials.sourceDescription} expired at ${credentials.sessionExpiresAt ?? 'an unknown time'}, and there is no Athom account credential beside it to get a new one with. Homey sessions last exactly 24 hours, so this is expected rather than a fault. Run "homey login" to sign in again. A server that is already running picks the new session up by itself; one that has stopped needs starting again.`,
    {
      sessionExpiresAt: credentials.sessionExpiresAt,
      credentialSource: credentials.source,
    },
  )
}

/**
 * Last resort when the only credential is a hub session token: try the hub's own
 * cloud origin, the one address that can be derived from the Homey id alone.
 *
 * Slower than the LAN, but it is this or nothing, and it is still a direct
 * session against the hub rather than an Athom OAuth handshake this credential
 * cannot perform.
 */
async function connectWithHubSessionOnly(
  credentials: ResolvedCredentials,
  options: InternalOptions,
): Promise<EstablishedApi> {
  // No hub session either, so there is nothing to reach anything with. That is a
  // missing credential rather than an unreachable Homey, and the cloud route
  // already says so in the words that name the command to run.
  if (credentials.localSessionToken === null) return connectThroughAthomCloud(credentials, options)

  const established = await tryLocalNetworkRoute(credentials, options, { allowHubCloudOrigin: true })
  if (established !== null) return established

  // Worded for both ways of getting here: no Athom token at all, and an Athom
  // token that has already expired. Claiming the file carries none would send
  // someone looking for a credential that is sitting right there.
  throw new HomeyMcpError(
    'not_connected',
    `The saved Homey session could not reach your Homey, and ${credentials.sourceDescription} has no usable Athom account token to fall back on. Run "npx homey-mcp doctor" to see which addresses answer, or "homey login" to sign in again.`,
    { credentialSource: credentials.source, homeyId: credentials.homeyId },
  )
}

/**
 * Connects using a hub session token over the LAN, when one is known.
 *
 * Preferred when available: no cloud round trip, no dependency on Athom being
 * reachable, and the measured 25 ms local answer instead of 195 ms through the
 * cloud. Returns null when the credentials do not carry what this route needs,
 * so the caller falls through to the cloud route.
 *
 * The addresses come from three places, in order: whatever the credentials file
 * configures, whatever a previous connection through the Athom cloud learned and
 * cached, and, only when `allowHubCloudOrigin` is set, the hub's cloud origin
 * derived from the Homey id. None of the credential sources supplies a LAN
 * address on its own, so without the cache this route has nothing to try and
 * never runs, which is exactly how it came to be dead code.
 */
async function tryLocalNetworkRoute(
  credentials: ResolvedCredentials,
  options: InternalOptions,
  routeOptions: { allowHubCloudOrigin: boolean },
): Promise<EstablishedApi | null> {
  const token = credentials.localSessionToken
  if (token === null) return null

  // An expired hub session cannot authenticate anything. Falling through to the
  // cloud, which mints a fresh one, beats sending a dead token and reading the
  // 401 that comes back as something else.
  if (isSessionExpired(credentials, options.now?.() ?? new Date())) {
    options.logger.debug('The stored Homey session has expired, so the direct hub route is skipped')
    return null
  }

  const cached =
    credentials.homeyId === null
      ? null
      : await readHubAddressCache(options.cachePath, credentials.homeyId, options.logger)

  const candidates = buildAddressCandidates({
    localAddress: credentials.localAddress ?? cached?.localAddress ?? null,
    localSecureAddress: credentials.localSecureAddress ?? cached?.localSecureAddress ?? null,
    ...(routeOptions.allowHubCloudOrigin ? { cloudId: credentials.homeyId } : {}),
  }).filter((candidate) => options.strategy === undefined || options.strategy.includes(candidate.kind))

  if (candidates.length === 0) return null

  const probes = await probeAddresses(candidates, {
    logger: options.logger,
    fetchImplementation: options.fetchImplementation,
    stopAtFirstReachable: true,
    ...(options.probeTimeoutMs === undefined ? {} : { timeoutMs: options.probeTimeoutMs }),
    ...(credentials.homeyId === null ? {} : { expectedHomeyId: credentials.homeyId }),
  })

  const reachable = probes.find((probe) => probe.reachable)
  if (reachable === undefined || reachable.homeyId === null) {
    options.logger.debug('No LAN address answered, falling back to the Athom cloud', {
      tried: probes.map((probe) => probe.kind),
    })
    return null
  }

  const call = createDirectCaller({
    baseUrl: reachable.address,
    token,
    homeyId: reachable.homeyId,
    fetchImplementation: options.fetchImplementation,
  })

  let dialect: HomeyDialect
  let evidence: string
  try {
    ;({ dialect, evidence } = await detectDialect(call))
  } catch (error) {
    const classified = classifyError(error, { operation: 'flow.getFlowCardTrigger' })
    // A 401 here means this session no longer works against this hub, and a 403
    // that it was issued without the scopes this server needs. Neither is a
    // reason to give up: the cloud route mints a new session with the full
    // scope. Rethrowing would have turned a recoverable state into a dead end.
    if (classified.reason === 'not_connected' || classified.reason === 'missing_scope') {
      options.logger.debug('The stored Homey session was refused by the hub, falling back to the Athom cloud', {
        reason: classified.reason,
      })
      return null
    }
    throw classified
  }

  const ApiConstructor = (dialect === 'v2' ? HomeyAPIV2 : HomeyAPIV3Local) as unknown as HomeyApiConstructor
  const api = new ApiConstructor({
    token,
    baseUrl: reachable.address,
    // Empty strategy list: the address is already known, so the library must not
    // start its own discovery and quietly move to a different one.
    strategy: [],
    reconnect: false,
    properties: {
      id: reachable.homeyId,
      softwareVersion: reachable.homeyVersion,
    },
  })

  return {
    api,
    probes,
    route: 'lan_session',
    address: reachable.address,
    addressKind: reachable.kind,
    dialect,
    dialectEvidence: evidence,
  }
}

/**
 * Connects through the Athom cloud, which is what makes the library pick the
 * dialect class from the Homey's registered `apiVersion` instead of assuming
 * one.
 */
async function connectThroughAthomCloud(
  credentials: ResolvedCredentials,
  options: InternalOptions,
): Promise<EstablishedApi> {
  const cloudApi = createAthomCloudApi(credentials, options)
  const user = await callCloud(() => cloudApi.getAuthenticatedUser(), 'athom.getAuthenticatedUser')

  const configuredHomeyId = credentials.homeyId
  const selectedHomey =
    configuredHomeyId === null
      ? await callCloud(() => user.getFirstHomey(), 'athom.getFirstHomey')
      : await callCloud(() => user.getHomeyById(configuredHomeyId), 'athom.getHomeyById')

  if (selectedHomey === null || selectedHomey === undefined) {
    throw new HomeyMcpError(
      'not_found',
      configuredHomeyId === null
        ? 'Your Athom account has no Homey linked to it, so there is nothing for this server to connect to.'
        : 'Your Athom account has no Homey with the id this server was configured with. Run "npx homey-mcp setup" again to choose one.',
      { homeyId: configuredHomeyId },
    )
  }

  const api = await callCloud(
    () =>
      selectedHomey.authenticate({
        strategy: options.strategy ?? ['localSecure', 'local', 'cloud'],
        // No realtime socket. This server polls on demand, and an idle socket is
        // a reconnect loop waiting to happen on a hub with 41 MB free memory.
        reconnect: false,
      }),
    'athom.authenticate',
  )

  const address = await resolveBaseUrl(api)
  const addressKind = resolveAddressKind(api, address)

  const { dialect, evidence } = await detectDialect((path) =>
    (api as HomeyApiInstance).call({ method: 'GET', path }),
  )

  return {
    api,
    probes: [],
    route: 'athom_cloud',
    address,
    addressKind,
    dialect,
    dialectEvidence: evidence,
    learnedAddresses: readHubAddressesFromCloud(selectedHomey, api, address, addressKind),
  }
}

/**
 * The LAN addresses the Athom cloud knows about.
 *
 * The cloud record for a Homey carries `localUrl` and `localUrlSecure`, which is
 * where the library's own discovery gets them from, so a connection through the
 * cloud is the moment this server can learn them too. When the record does not
 * carry them, the address the connection actually settled on is derived from the
 * probe result instead, which is at least one rung that is known to answer.
 */
function readHubAddressesFromCloud(
  selectedHomey: AthomCloudHomey,
  api: unknown,
  address: string,
  addressKind: HomeyAddressKind,
): HubAddresses {
  const properties = (api as { __properties?: Record<string, unknown> }).__properties ?? {}

  const localAddress =
    nonEmptyString(selectedHomey.localUrl) ??
    nonEmptyString(properties['localUrl']) ??
    (addressKind === 'local' ? address : null)

  const localSecureAddress =
    nonEmptyString(selectedHomey.localUrlSecure) ??
    nonEmptyString(properties['localUrlSecure']) ??
    (addressKind === 'localSecure' ? address : null)

  return { localAddress, localSecureAddress }
}

/**
 * Where the hub says it answers on the local network.
 *
 * Measured on the hardware: `system.getInfo()` carries
 * `wifiAddress: "<lan ip>:80"`, which is the same origin the Athom cloud reports
 * as `localUrl`. That matters because it is the one source of a LAN address that
 * does not go through the cloud, so a start that reached the hub over its own
 * cloud origin can still fill the address cache and the next start goes straight
 * to the LAN. Without it that route can never learn anything and every start
 * after a cloud-token expiry stays slow.
 *
 * Returns null rather than a guess whenever the field is missing or shaped
 * differently, for instance on hardware with a wired interface: the caller only
 * ever uses this to fill a gap, and the address it writes is probed for the
 * right `X-Homey-ID` before anything is sent to it.
 */
function readHubAddressesFromSystemInfo(raw: unknown): HubAddresses | null {
  if (raw === null || typeof raw !== 'object') return null
  const wifiAddress = asString((raw as Record<string, unknown>)['wifiAddress'])?.trim()
  if (wifiAddress === undefined || wifiAddress === '') return null

  // `<host>:<port>`, no scheme. Port 80 is left out so the origin matches the
  // cloud's `localUrl` exactly and the two cannot be cached as different rungs.
  const parts = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(wifiAddress)
  if (parts === null) return null

  const host = parts[1]
  const port = parts[2]
  return {
    localAddress: port === undefined || port === '80' ? `http://${host}` : `http://${host}:${port}`,
    localSecureAddress: null,
  }
}

/**
 * Combines what the cloud said with what the hub said about itself.
 *
 * The cloud record wins where it has an answer: it is the source the library's
 * own discovery uses, and it names both rungs, where the hub names only the
 * plain one. The hub's answer fills the gaps, which on the hub-session route is
 * every gap there is.
 */
function mergeHubAddresses(
  fromCloud: HubAddresses | undefined,
  fromHub: HubAddresses | null,
): HubAddresses | undefined {
  if (fromHub === null) return fromCloud
  if (fromCloud === undefined) return fromHub
  return {
    localAddress: fromCloud.localAddress ?? fromHub.localAddress,
    localSecureAddress: fromCloud.localSecureAddress ?? fromHub.localSecureAddress,
  }
}

function createAthomCloudApi(credentials: ResolvedCredentials, options: InternalOptions): AthomCloudApiInstance {
  const athomToken = credentials.personalAccessToken ?? credentials.cloudToken?.access_token ?? null

  if (athomToken === null) {
    throw new HomeyMcpError(
      'not_connected',
      `The credentials from ${credentials.sourceDescription} contain neither an Athom token nor a Homey session, so there is no way to reach your Homey. Run "npx homey-mcp setup" to fix this.`,
      { credentialSource: credentials.source },
    )
  }

  const usingPersonalAccessToken = credentials.personalAccessToken !== null

  // A Personal Access Token is not an OAuth grant and has nothing to refresh
  // with, so its OAuth fields stay empty rather than borrowing another
  // credential's.
  const cloudToken = usingPersonalAccessToken ? null : credentials.cloudToken

  const TokenConstructor = AthomCloudAPI.Token as unknown as AthomCloudTokenConstructor
  const token = new TokenConstructor({
    token_type: credentials.cloudToken?.token_type ?? 'bearer',
    access_token: athomToken,
    refresh_token: cloudToken?.refresh_token ?? null,
    expires_in: cloudToken?.expires_in ?? null,
    grant_type: credentials.cloudToken?.grant_type ?? null,
  })

  // Refreshing an Athom OAuth token requires the client id and secret that
  // issued it. This package embeds neither, so a refresh is only attempted when
  // the operator supplied them. Without them an expired session is reported with
  // instructions instead of being retried into a loop.
  const athomClientId = options.athomClientId
  const athomSecret = options.athomClientSecret
  const canRefreshTokens = !usingPersonalAccessToken && athomClientId !== undefined && athomSecret !== undefined

  const CloudApiConstructor = AthomCloudAPI as unknown as AthomCloudApiConstructor
  return new CloudApiConstructor({
    ...(athomClientId === undefined ? {} : { clientId: athomClientId }),
    ...(athomSecret === undefined ? {} : { clientSecret: athomSecret }),
    token,
    autoRefreshTokens: canRefreshTokens,
  })
}

async function callCloud<T>(operation: () => Promise<T>, label: string): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw classifyError(error, { operation: label })
  }
}

/**
 * Asks the hub for one flow card descriptor and reads the dialect off its shape.
 *
 * V2 splits a card reference into a `uri` plus a short `id`; V3 carries a single
 * `ownerUri` plus a fully qualified `id`. That difference is the reliable
 * runtime probe, and it is a property of the answering firmware rather than of
 * the client class doing the asking.
 */
export async function detectDialect(
  call: (path: string) => Promise<unknown>,
): Promise<{ dialect: HomeyDialect; evidence: string }> {
  const singleCardPath = `/api/manager/flow/flowcardtrigger/${DIALECT_PROBE_OWNER_URI}/${DIALECT_PROBE_CARD_ID}`

  try {
    const verdict = readDialectFromDescriptor(await call(singleCardPath))
    if (verdict !== null) return verdict
  } catch (error) {
    // A hub that keys its cards by fully qualified id answers this path with a
    // 404, which is information rather than a failure, so fall through to the
    // list instead of giving up.
    const classified = classifyError(error, { operation: 'flow.getFlowCardTrigger' })
    if (classified.reason !== 'not_found' && classified.reason !== 'unsupported_hardware') throw classified
  }

  const cards = await call('/api/manager/flow/flowcardtrigger')
  const firstCard = Array.isArray(cards)
    ? cards[0]
    : Object.values((cards ?? {}) as Record<string, unknown>)[0]

  const verdict = readDialectFromDescriptor(firstCard)
  if (verdict !== null) return verdict

  throw new HomeyMcpError(
    'not_connected',
    'This Homey answered, but its flow cards match neither supported API generation, so this server cannot tell how to talk to it safely. Run "homey-mcp doctor" and include its output when reporting this.',
    { probe: 'flow.getFlowCardTriggers' },
  )
}

function readDialectFromDescriptor(descriptor: unknown): { dialect: HomeyDialect; evidence: string } | null {
  if (descriptor === null || typeof descriptor !== 'object') return null
  const record = descriptor as Record<string, unknown>

  if (typeof record['ownerUri'] === 'string') {
    return { dialect: 'v3', evidence: 'the flow card descriptor carries ownerUri' }
  }

  const identifier = record['id']
  if (typeof record['uri'] === 'string' && typeof identifier === 'string') {
    return identifier.includes(':')
      ? { dialect: 'v3', evidence: 'the flow card descriptor carries a fully qualified id' }
      : { dialect: 'v2', evidence: 'the flow card descriptor carries a separate uri and a short id' }
  }

  return null
}

interface DirectCallerOptions {
  baseUrl: string
  token: string
  homeyId: string
  fetchImplementation: typeof fetch
}

/** Minimal authenticated GET against the hub, for the probes that run before a client class exists. */
function createDirectCaller(options: DirectCallerOptions): (path: string) => Promise<unknown> {
  return async (path: string) => {
    const response = await options.fetchImplementation(`${options.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${options.token}`,
        'X-Homey-ID': options.homeyId,
      },
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw classifyError(
        { statusCode: response.status, message: extractApiErrorMessage(body) ?? response.statusText },
        { operation: `GET ${path}` },
      )
    }

    return (await response.json()) as unknown
  }
}

function extractApiErrorMessage(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      for (const key of ['error_description', 'error', 'message']) {
        const candidate = record[key]
        if (typeof candidate === 'string' && candidate !== '') return candidate
      }
    }
  } catch {
    // Not JSON. The HTTP status text is a better message than a page of HTML.
  }
  return null
}

interface ReadIdentityOptions {
  api: unknown
  request: <T>(operation: () => Promise<T>, label: string, idempotent?: boolean) => Promise<T>
  address: string
  addressKind: HomeyAddressKind
}

interface IdentityReading {
  identity: HomeyIdentity
  /** Where the hub says it answers on the local network, when it says. */
  hubReportedAddresses: HubAddresses | null
}

async function readIdentity(options: ReadIdentityOptions): Promise<IdentityReading> {
  const api = options.api as HomeyApiInstance
  // Every call here is a read, so the queue may safely repeat one after a timeout.
  const info = normaliseSystemInfo(await options.request(() => api.system.getInfo(), 'system.getInfo', true))

  const identifier = nonEmptyString(api.id)
  if (identifier === null) {
    throw new HomeyMcpError(
      'not_connected',
      'The connection to Homey came up without an identifier, so this server cannot tell which Homey it is talking to. Run "homey-mcp doctor" to see what the addresses report.',
    )
  }

  const nameFromProperties = nonEmptyString(api.name)
  const name =
    nameFromProperties ??
    nonEmptyString(await options.request(() => api.system.getSystemName(), 'system.getSystemName', true))

  const internationalisation = api.i18n
  const languageFromProperties = nonEmptyString(api.language)
  const language =
    languageFromProperties ??
    nonEmptyString(
      internationalisation === undefined
        ? null
        : await options.request(() => internationalisation.getOptionLanguage(), 'i18n.getOptionLanguage', true),
    )

  return {
    identity: {
      id: identifier,
      name: name ?? requireInfoField(info.homeyModelName, 'homeyModelName'),
      modelId: requireInfoField(info.homeyModelId, 'homeyModelId'),
      modelName: requireInfoField(info.homeyModelName, 'homeyModelName'),
      softwareVersion: requireInfoField(info.homeyVersion, 'homeyVersion'),
      // Measured: this firmware omits the platform version entirely, and the
      // documented reading of an absent value is generation 1. Reported for
      // diagnostics only, never used to gate a feature.
      platformVersion: info.homeyPlatformVersion ?? 1,
      // Empty means the hub did not report a language. Nothing is substituted:
      // a guessed locale would silently change what every hub-rendered title says.
      language: language ?? '',
      timezone: requireInfoField(info.timezone, 'timezone'),
      address: options.address,
      addressKind: options.addressKind,
    },
    hubReportedAddresses: readHubAddressesFromSystemInfo(info.raw),
  }
}

/**
 * Turns the raw `system.getInfo()` payload into the server's own vocabulary.
 * Exported because `doctor` reports the memory and uptime fields too.
 */
export function normaliseSystemInfo(raw: unknown): HomeySystemInfo {
  const record = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  return {
    homeyVersion: asString(record['homeyVersion']) ?? '',
    homeyModelId: asString(record['homeyModelId']) ?? '',
    homeyModelName: asString(record['homeyModelName']) ?? '',
    timezone: asString(record['timezone']) ?? '',
    homeyPlatformVersion: asNumber(record['homeyPlatformVersion']),
    cloudId: asString(record['cloudId']),
    totalMemoryBytes: asNumber(record['totalmem']),
    freeMemoryBytes: asNumber(record['freememMachine']),
    uptimeSeconds: asNumber(record['uptime']),
    nodeVersion: asString(record['nodeVersion']),
    raw,
  }
}

/**
 * Fails loudly on a missing identity field rather than substituting a plausible
 * one. A guessed timezone would silently move every Insights window by an hour,
 * and a guessed model name would make the capability report a lie.
 */
function requireInfoField(value: string, fieldName: string): string {
  if (value !== '') return value
  throw new HomeyMcpError(
    'unsupported_hardware',
    `This Homey did not report its ${fieldName}, which this server needs before it can work correctly. That is unusual: please open an issue and include the output of "homey-mcp doctor".`,
    { field: fieldName },
  )
}

async function resolveBaseUrl(api: unknown): Promise<string> {
  const candidate = await (api as HomeyApiInstance).baseUrl
  if (typeof candidate === 'string' && candidate !== '') return candidate
  throw new HomeyMcpError(
    'not_connected',
    'Homey accepted the session but never reported which address it settled on, so this server cannot reuse or report it. Run "homey-mcp doctor" to see which addresses answer.',
  )
}

function resolveAddressKind(api: unknown, address: string): HomeyAddressKind {
  const strategyId = (api as HomeyApiInstance).strategyId
  if (strategyId === 'localSecure' || strategyId === 'local' || strategyId === 'cloud') return strategyId
  // mdns and remoteForwarded are strategies this server does not ladder over, so
  // the shape of the address it landed on is the honest answer.
  return classifyAddress(address)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

// ---------------------------------------------------------------------------
// Remembering where the hub answers
// ---------------------------------------------------------------------------

/** The two LAN origins a Homey announces to the Athom cloud. */
export interface HubAddresses {
  localAddress: string | null
  localSecureAddress: string | null
}

interface CachedHubAddresses extends HubAddresses {
  /** ISO timestamp, so a stale entry can be recognised by a human reading the file. */
  learnedAt: string
}

/**
 * Where the addresses learned from the Athom cloud are remembered, keyed by
 * Homey id.
 *
 * Deliberately not the credentials file, even though that is where the rest of
 * this server's own state lives. `resolveCredentials` treats any readable
 * credentials file as the complete answer and stops looking, so creating one
 * here to hold two addresses would shadow the Homey CLI session and leave the
 * next start with no token at all. This file holds no secret: only the addresses
 * the hub already broadcasts on the network it is attached to. It is still
 * written 0600, because those addresses describe someone's home.
 */
export function hubAddressCachePath(
  options: { environment?: Record<string, string | undefined>; homeDirectory?: string } = {},
): string {
  const environment = options.environment ?? process.env
  const homeDirectory = options.homeDirectory ?? homedir()
  const configHome = environment['XDG_CONFIG_HOME']
  const base =
    configHome !== undefined && configHome.trim() !== '' ? configHome.trim() : join(homeDirectory, '.config')
  return join(base, 'homey-mcp', 'hub-addresses.json')
}

async function readHubAddressCache(
  path: string,
  homeyId: string,
  logger: Logger,
): Promise<HubAddresses | null> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(contents)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const entry = (parsed as Record<string, unknown>)[homeyId]
    if (entry === null || typeof entry !== 'object') return null
    const record = entry as Record<string, unknown>
    return {
      localAddress: nonEmptyString(record['localAddress']),
      localSecureAddress: nonEmptyString(record['localSecureAddress']),
    }
  } catch {
    // A corrupt cache is not worth failing a connection over: the cloud route
    // still works and will overwrite the file with something readable.
    logger.debug('Ignoring the remembered hub addresses because the file is not valid JSON', { path })
    return null
  }
}

/**
 * Writes the learned addresses back. Best effort throughout: a read-only config
 * directory costs a fast path on the next start, and nothing else, so it must
 * never be the reason a working connection is reported as failed.
 */
async function rememberHubAddresses(
  path: string,
  homeyId: string,
  addresses: HubAddresses | undefined,
  logger: Logger,
): Promise<void> {
  if (addresses === undefined) return
  if (addresses.localAddress === null && addresses.localSecureAddress === null) return

  try {
    const existing = await readHubAddressCache(path, homeyId, logger)

    // A null rung means the source that answered did not name it, never that the
    // rung is gone. The Athom cloud names both; the hub's own system.getInfo()
    // names only the plain one. Writing the incoming record wholesale therefore
    // erased the encrypted address on the first LAN start after a cloud start,
    // and every start after that ran over plain HTTP. Keeping a rung that has
    // since moved costs one failed probe, because every candidate is checked for
    // the expected X-Homey-ID before anything is sent to it.
    const merged: HubAddresses = {
      localAddress: addresses.localAddress ?? existing?.localAddress ?? null,
      localSecureAddress: addresses.localSecureAddress ?? existing?.localSecureAddress ?? null,
    }

    if (
      existing !== null &&
      existing.localAddress === merged.localAddress &&
      existing.localSecureAddress === merged.localSecureAddress
    ) {
      return
    }

    let stored: Record<string, CachedHubAddresses> = {}
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        stored = parsed as Record<string, CachedHubAddresses>
      }
    } catch {
      // No usable file yet, so start a fresh one rather than losing the address.
    }

    stored[homeyId] = { ...merged, learnedAt: new Date().toISOString() }

    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 })
    // The mode argument only applies when the file is created, so an existing
    // file that was somehow left world readable is corrected explicitly.
    await chmod(path, 0o600)
    logger.debug('Remembered where this Homey answers on the local network', { path })
  } catch (error) {
    logger.debug('Could not remember where this Homey answers, so the next start will ask the Athom cloud again', {
      path,
      error,
    })
  }
}

// ---------------------------------------------------------------------------
// The parts of `homey-api` this server relies on.
//
// Declared structurally because the package's own declarations hide the
// constructors and type most manager results as `any`. Keeping them here means
// there is exactly one place to look when the library changes shape.
// ---------------------------------------------------------------------------

interface HomeyApiConstructorOptions {
  token: string
  baseUrl: string
  strategy: string[]
  reconnect: boolean
  properties: { id: string; softwareVersion: string | null }
}

type HomeyApiConstructor = new (options: HomeyApiConstructorOptions) => unknown

interface HomeyApiInstance {
  id?: string | null
  name?: string | null
  language?: string | null
  baseUrl: Promise<string>
  strategyId?: string | null
  call(options: { method: string; path: string }): Promise<unknown>
  system: {
    getInfo(): Promise<unknown>
    getSystemName(): Promise<unknown>
  }
  i18n?: {
    getOptionLanguage(): Promise<unknown>
  }
}

interface AthomCloudTokenOptions {
  token_type: string
  access_token: string
  refresh_token: string | null
  expires_in: number | null
  grant_type: string | null
}

type AthomCloudTokenConstructor = new (options: AthomCloudTokenOptions) => unknown

interface AthomCloudApiOptions {
  clientId?: string
  clientSecret?: string
  token: unknown
  autoRefreshTokens: boolean
}

interface AthomCloudUser {
  getFirstHomey(): Promise<AthomCloudHomey | null>
  getHomeyById(id: string): Promise<AthomCloudHomey | null>
}

interface AthomCloudHomey {
  authenticate(options: { strategy: string[]; reconnect: boolean }): Promise<unknown>
  /**
   * The LAN origins the Homey last reported to the Athom cloud, for example
   * `http://<lan ip>` and `https://<dashed lan ip>.homey.homeylocal.com`. The
   * library copies every field of the cloud record onto the instance, and its
   * own discovery reads exactly these two.
   */
  localUrl?: string | null
  localUrlSecure?: string | null
}

interface AthomCloudApiInstance {
  getAuthenticatedUser(): Promise<AthomCloudUser>
}

type AthomCloudApiConstructor = new (options: AthomCloudApiOptions) => AthomCloudApiInstance
