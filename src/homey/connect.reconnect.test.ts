// The 24 hour session wall.
//
// A hub session lasts exactly 24 hours, and an MCP server is normally started
// once and left running, so this is the failure the owner of a long-lived server
// meets first: everything works for a day and then every tool call fails with no
// route back from inside the process.
//
// In its own file rather than in connect.test.ts, which mocks the whole
// `homey-api` package to test how a first connection is built. Nothing here
// needs the library at all: `openReconnectingConnection` is given the connect
// function, so what these tests drive is the lifecycle, which is the part that
// was missing.

import { describe, expect, it, vi } from 'vitest'

import { openReconnectingConnection } from './connect.js'
import type { ConnectToHomeyOptions, HomeyConnectionWithDiagnostics } from './connect.js'
import type { ResolvedCredentials } from './credentials.js'
import { HomeyMcpError } from './errors.js'
import type { HomeyIdentity } from './types.js'
import { createLogger } from '../util/log.js'

const SESSION_TOKEN_PREFIX = 'session-'

/** Silent: a reconnect is meant to be loud in a real run and quiet in a test run. */
const logger = createLogger({ level: 'silent' })

function credentialsWithSession(token: string): ResolvedCredentials {
  return {
    source: 'homey_cli_session',
    sourceDescription: 'the session stored by the Homey CLI',
    cloudToken: null,
    personalAccessToken: null,
    homeyId: 'homeyidentifier000000001',
    localSessionToken: token,
    localAddress: null,
    localSecureAddress: null,
    sessionExpiresAt: null,
    scopes: ['homey'],
    configPath: null,
  }
}

function identity(): HomeyIdentity {
  return {
    id: 'homeyidentifier000000001',
    name: 'Home',
    modelId: 'homey4d',
    modelName: 'Homey Pro (Early 2019)',
    softwareVersion: '13.2.4',
    platformVersion: 1,
    language: 'nl',
    timezone: 'Europe/Amsterdam',
    address: 'http://homey.test',
    addressKind: 'local',
  }
}

/**
 * One session of a fake hub.
 *
 * Its `api` is the thing that goes stale: every call through it fails once the
 * session is retired, which is exactly what an expired token does. The point of
 * the test suite is that the rest of the server stops holding a retired one.
 */
interface FakeSession extends HomeyConnectionWithDiagnostics {
  readonly token: string
  retire(): void
  readonly callsMade: string[]
}

function createFakeSession(token: string): FakeSession {
  let retired = false
  const callsMade: string[] = []

  const api = {
    devices: {
      async getDevices(): Promise<string> {
        callsMade.push(`${token}:getDevices`)
        if (retired) throw new HomeyMcpError('not_connected', 'Homey rejected the saved session.')
        return `devices from ${token}`
      },
    },
    async setCapability(): Promise<string> {
      callsMade.push(`${token}:setCapability`)
      if (retired) throw new HomeyMcpError('not_connected', 'Homey rejected the saved session.')
      return `written by ${token}`
    },
    destroyed: false,
    destroy(): void {
      this.destroyed = true
    },
  }

  return {
    api,
    dialect: 'v2',
    identity: identity(),
    queue: { run: async (operation) => await operation(), inFlight: 0, queued: 0 },
    request: async (operation) => await operation(),
    diagnostics: {
      route: 'lan_session',
      probes: [],
      dialectEvidence: 'the flow card descriptor carries a separate uri and a short id',
      credentialSource: 'the session stored by the Homey CLI',
    },
    token,
    callsMade,
    retire: () => {
      retired = true
    },
  }
}

/** A fake `connectToHomey` that mints one session per call and hands back the ones it made. */
function createConnector(): {
  connect: (credentials: ResolvedCredentials, options: ConnectToHomeyOptions) => Promise<FakeSession>
  sessions: FakeSession[]
  optionsSeen: ConnectToHomeyOptions[]
  failNext: (failure: Error | null) => void
} {
  const sessions: FakeSession[] = []
  const optionsSeen: ConnectToHomeyOptions[] = []
  let failure: Error | null = null

  return {
    sessions,
    optionsSeen,
    failNext: (next) => {
      failure = next
    },
    connect: async (credentials, options) => {
      optionsSeen.push(options)
      if (failure !== null) {
        const thrown = failure
        failure = null
        throw thrown
      }
      const session = createFakeSession(credentials.localSessionToken ?? 'no-token')
      sessions.push(session)
      return session
    },
  }
}

describe('openReconnectingConnection', () => {
  it('reads the credential source again and signs in once more when Homey refuses the session', async () => {
    // The 24 hour wall. The Homey CLI refreshes its own session in the same file
    // this reads, so the replacement is usually already on disk by the time the
    // one this process started with dies.
    const connector = createConnector()
    let storedToken = `${SESSION_TOKEN_PREFIX}first`
    const loadCredentials = vi.fn(async () => credentialsWithSession(storedToken))

    const connection = await openReconnectingConnection({
      credentials: await loadCredentials(),
      loadCredentials,
      logger,
      connectImplementation: connector.connect,
    })

    expect(await connection.request(readDevices(connection), 'devices.getDevices', true)).toBe(
      `devices from ${SESSION_TOKEN_PREFIX}first`,
    )

    // A day passes: the hub starts refusing the session, and the CLI has since
    // written a new one.
    connector.sessions[0]?.retire()
    storedToken = `${SESSION_TOKEN_PREFIX}second`

    const answer = await connection.request(readDevices(connection), 'devices.getDevices', true)

    expect(answer).toBe(`devices from ${SESSION_TOKEN_PREFIX}second`)
    expect(connection.sessionCount).toBe(2)
    // Read again rather than reused: once for the first connection in this test,
    // once for the rebuild.
    expect(loadCredentials).toHaveBeenCalledTimes(2)
  })

  it('keeps working for a caller that captured api before the session was rebuilt', async () => {
    // `createHomeCache` reads `connection.api` once at construction and holds it
    // for the life of the process, and every tool captures it at the top of a
    // handler. A rebuild that swapped a plain property would leave all of them
    // holding the dead client, so the reconnect would change nothing anybody
    // could see.
    const connector = createConnector()
    const loadCredentials = async (): Promise<ResolvedCredentials> =>
      credentialsWithSession(`${SESSION_TOKEN_PREFIX}${connector.sessions.length + 1}`)

    const connection = await openReconnectingConnection({
      credentials: await loadCredentials(),
      loadCredentials,
      logger,
      connectImplementation: connector.connect,
    })

    // Captured once, exactly as the cache does, and never read from the
    // connection again.
    const managers = connection.api as { devices: { getDevices(): Promise<string> } }

    expect(await connection.request(() => managers.devices.getDevices(), 'devices.getDevices', true)).toBe(
      `devices from ${SESSION_TOKEN_PREFIX}1`,
    )

    connector.sessions[0]?.retire()

    expect(await connection.request(() => managers.devices.getDevices(), 'devices.getDevices', true)).toBe(
      `devices from ${SESSION_TOKEN_PREFIX}2`,
    )
  })

  it('never repeats a write, even though it renews the session for the next call', async () => {
    // The idempotency rule. A lost or refused write says nothing this server may
    // act on by itself: repeating "start this flow" is how a door-opening flow
    // ran four times.
    const connector = createConnector()
    const loadCredentials = async (): Promise<ResolvedCredentials> =>
      credentialsWithSession(`${SESSION_TOKEN_PREFIX}${connector.sessions.length + 1}`)

    const connection = await openReconnectingConnection({
      credentials: await loadCredentials(),
      loadCredentials,
      logger,
      connectImplementation: connector.connect,
    })

    const first = connector.sessions[0]
    first?.retire()

    const write = (): Promise<unknown> => {
      const api = connection.api as { setCapability(): Promise<string> }
      return api.setCapability()
    }

    await expect(connection.request(write, 'devices.setCapabilityValue')).rejects.toMatchObject({
      reason: 'transient',
    })

    // Sent once and only once, on the session that refused it.
    expect(first?.callsMade).toEqual(['session-1:setCapability'])
    expect(connector.sessions[1]?.callsMade).toEqual([])
    // The session was still renewed, so the next call works without a restart.
    expect(connection.sessionCount).toBe(2)
    expect(await connection.request(write, 'devices.setCapabilityValue')).toBe(`written by ${SESSION_TOKEN_PREFIX}2`)
  })

  it('tells the caller in words that the write did not go through', async () => {
    const connector = createConnector()
    const loadCredentials = async (): Promise<ResolvedCredentials> =>
      credentialsWithSession(`${SESSION_TOKEN_PREFIX}${connector.sessions.length + 1}`)

    const connection = await openReconnectingConnection({
      credentials: await loadCredentials(),
      loadCredentials,
      logger,
      connectImplementation: connector.connect,
    })

    connector.sessions[0]?.retire()

    const failure = await failureFrom(
      connection.request(() => (connection.api as { setCapability(): Promise<string> }).setCapability(), 'flow.startFlow'),
    )

    expect(failure.message).toContain('did not carry this call out')
    expect(failure.message).toContain('can simply be made once more')
    expect(failure.safeToRepeat).toBe(false)
  })

  it('names the command to run when signing in again cannot work', async () => {
    // The other half of the wall: the session died and nothing on disk can
    // replace it. A stack trace on every later call helps nobody; the one line
    // that fixes it does.
    const connector = createConnector()
    const loadCredentials = async (): Promise<ResolvedCredentials> => credentialsWithSession('session-1')

    const connection = await openReconnectingConnection({
      credentials: await loadCredentials(),
      loadCredentials,
      logger,
      connectImplementation: connector.connect,
    })

    connector.sessions[0]?.retire()
    connector.failNext(
      new HomeyMcpError(
        'not_connected',
        'The Homey session expired at an unknown time. Run "homey login" to sign in again, then restart this server.',
      ),
    )

    const failure = await failureFrom(connection.request(readDevices(connection), 'devices.getDevices', true))

    expect(failure.reason).toBe('not_connected')
    expect(failure.message).toContain('signing in again did not work either')
    expect(failure.message).toContain('homey login')
  })

  it('does not sign in again on every call while it cannot succeed', async () => {
    // Without the interval a Homey that is simply off the network would get one
    // full address-ladder walk per tool call, and the client would see a
    // different failure each time.
    const connector = createConnector()
    const loadCredentials = vi.fn(async () => credentialsWithSession('session-1'))
    let clock = 0

    const connection = await openReconnectingConnection({
      credentials: await loadCredentials(),
      loadCredentials,
      logger,
      connectImplementation: connector.connect,
      retryIntervalMs: 30_000,
      now: () => clock,
    })

    connector.sessions[0]?.retire()
    connector.failNext(new HomeyMcpError('not_connected', 'Homey could not be reached. Run "homey-mcp doctor".'))

    const first = await failureFrom(connection.request(readDevices(connection), 'devices.getDevices', true))
    const attemptsAfterFirst = loadCredentials.mock.calls.length

    clock += 5_000
    const second = await failureFrom(connection.request(readDevices(connection), 'devices.getDevices', true))

    expect(loadCredentials.mock.calls.length).toBe(attemptsAfterFirst)
    // And the same sentence, so a client is not told a different story each call.
    expect(second.message).toBe(first.message)

    clock += 30_000
    await connection.request(readDevices(connection), 'devices.getDevices', true).catch(() => undefined)
    expect(loadCredentials.mock.calls.length).toBe(attemptsAfterFirst + 1)
  })

  it('explains itself the same way inside the retry window as outside it', async () => {
    // The window exists so a Homey that is off the network does not get one
    // address-ladder walk per tool call. It suppresses that walk and nothing
    // else: a genuine refusal arriving seconds after a session was successfully
    // renewed used to fall straight through it with the raw refusal, so the
    // caller inside the window was told less than the identical caller outside
    // it, on the same failure.
    const connector = createConnector()
    let clock = 0
    const loadCredentials = vi.fn(async () => credentialsWithSession(`session-${connector.sessions.length + 1}`))

    const connection = await openReconnectingConnection({
      credentials: await loadCredentials(),
      loadCredentials,
      logger,
      connectImplementation: connector.connect,
      retryIntervalMs: 30_000,
      now: () => clock,
    })

    // The 24 hour wall, handled: the session is renewed and the read succeeds.
    connector.sessions[0]?.retire()
    await connection.request(readDevices(connection), 'devices.getDevices', true)
    expect(connection.sessionCount).toBe(2)
    const attemptsAfterRenewal = loadCredentials.mock.calls.length

    // Five seconds later, well inside the window, the renewed session is refused
    // too. This one is a write, so it is exactly the case where the caller needs
    // to be told whether their house changed.
    clock += 5_000
    connector.sessions[1]?.retire()

    const failure = await failureFrom(
      connection.request(
        () => (connection.api as { setCapability(): Promise<string> }).setCapability(),
        'devices.setCapabilityValue',
      ),
    )

    expect(failure.reason).toBe('transient')
    expect(failure.message).toContain('did not carry this call out')
    expect(failure.message).toContain('never repeats one of those by itself')
    // And the work really was suppressed: no second ladder walk, no third session.
    expect(loadCredentials.mock.calls.length).toBe(attemptsAfterRenewal)
    expect(connection.sessionCount).toBe(2)
  })

  it('signs in once for several calls that fail together', async () => {
    // An assistant fires a handful of tool calls at once. Signing in once per
    // call would mint several sessions against a hub that refuses requests
    // arriving together.
    const connector = createConnector()
    const loadCredentials = vi.fn(async () => credentialsWithSession(`session-${connector.sessions.length + 1}`))

    const connection = await openReconnectingConnection({
      credentials: await loadCredentials(),
      loadCredentials,
      logger,
      connectImplementation: connector.connect,
    })

    connector.sessions[0]?.retire()

    const answers = await Promise.all([
      connection.request(readDevices(connection), 'devices.getDevices', true),
      connection.request(readDevices(connection), 'devices.getDevices', true),
      connection.request(readDevices(connection), 'devices.getDevices', true),
    ])

    expect(answers).toEqual(['devices from session-2', 'devices from session-2', 'devices from session-2'])
    expect(connection.sessionCount).toBe(2)
  })

  it('does not sign in again for a failure a new session cannot fix', async () => {
    const connector = createConnector()
    const loadCredentials = vi.fn(async () => credentialsWithSession('session-1'))

    const connection = await openReconnectingConnection({
      credentials: await loadCredentials(),
      loadCredentials,
      logger,
      connectImplementation: connector.connect,
    })

    await expect(
      connection.request(async () => {
        throw new HomeyMcpError('rate_limited', 'Homey is refusing further requests for the moment.')
      }, 'devices.getDevices', true),
    ).rejects.toMatchObject({ reason: 'rate_limited' })

    expect(connection.sessionCount).toBe(1)
    expect(loadCredentials).toHaveBeenCalledTimes(1)
  })

  it('keeps one request queue across sessions, because the hub rate limits itself', async () => {
    const connector = createConnector()
    const loadCredentials = async (): Promise<ResolvedCredentials> =>
      credentialsWithSession(`session-${connector.sessions.length + 1}`)

    const connection = await openReconnectingConnection({
      credentials: await loadCredentials(),
      loadCredentials,
      logger,
      connectImplementation: connector.connect,
    })

    const queueAtStart = connection.queue
    connector.sessions[0]?.retire()
    await connection.request(readDevices(connection), 'devices.getDevices', true)

    expect(connection.queue).toBe(queueAtStart)
    // Every connect was handed the same queue rather than left to build its own.
    const queues = connector.optionsSeen.map((options) => options.queue)
    expect(queues[0]).toBe(queues[1])
    expect(queues[0]).toBe(queueAtStart)
  })

  it('closes the session it replaced, so a day of running does not leak one per day', async () => {
    const connector = createConnector()
    const loadCredentials = async (): Promise<ResolvedCredentials> =>
      credentialsWithSession(`session-${connector.sessions.length + 1}`)

    const connection = await openReconnectingConnection({
      credentials: await loadCredentials(),
      loadCredentials,
      logger,
      connectImplementation: connector.connect,
    })

    connector.sessions[0]?.retire()
    await connection.request(readDevices(connection), 'devices.getDevices', true)

    expect((connector.sessions[0]?.api as { destroyed: boolean }).destroyed).toBe(true)
    expect((connector.sessions[1]?.api as { destroyed: boolean }).destroyed).toBe(false)

    await connection.close()
    expect((connector.sessions[1]?.api as { destroyed: boolean }).destroyed).toBe(true)
  })

  it('reports the identity and dialect of whichever session is current', async () => {
    const connector = createConnector()
    const loadCredentials = async (): Promise<ResolvedCredentials> =>
      credentialsWithSession(`session-${connector.sessions.length + 1}`)

    const connection = await openReconnectingConnection({
      credentials: await loadCredentials(),
      loadCredentials,
      logger,
      connectImplementation: connector.connect,
    })

    expect(connection.identity.modelId).toBe('homey4d')
    expect(connection.dialect).toBe('v2')
    expect(connection.diagnostics.route).toBe('lan_session')
  })
})

/** The failure a call produced. Fails the test loudly when the call succeeded instead. */
async function failureFrom(call: Promise<unknown>): Promise<HomeyMcpError> {
  let thrown: unknown = null
  let failed = false
  try {
    await call
  } catch (error) {
    thrown = error
    failed = true
  }
  if (!failed) throw new Error('This call was expected to fail and did not.')
  return thrown as HomeyMcpError
}

/** Reads through `connection.api` the way a tool does: captured, then called inside the thunk. */
function readDevices(connection: { api: unknown }): () => Promise<string> {
  const managers = connection.api as { devices: { getDevices(): Promise<string> } }
  return () => managers.devices.getDevices()
}
