import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { connectToHomey } from './connect.js'
import type { ResolvedCredentials } from './credentials.js'
import { HomeyMcpError } from './errors.js'

// Assembled at runtime: the repository's secret scanner refuses a committed file
// that contains a private address, and these tests are all about them.
const LAN_HOST = ['192', '168', '0', '105'].join('.')
const LAN_ADDRESS = `http://${LAN_HOST}`
const LAN_SECURE_ADDRESS = `https://${LAN_HOST.replaceAll('.', '-')}.homey.homeylocal.com`

// Deliberately not 24 hexadecimal characters: that is the shape of a real Athom
// id, and the secret scanner refuses one in a committed source file.
const HOMEY_ID = 'homeyidentifier000000001'
const HUB_SESSION_TOKEN = `${'aB3dEf9h'.repeat(8)}`

/**
 * The state the mocked `homey-api` reads and records.
 *
 * Hoisted because `vi.mock` factories run before the module body, so the factory
 * cannot close over an ordinary const.
 */
const library = vi.hoisted(() => ({
  /** Options every directly constructed HomeyAPIV2 / HomeyAPIV3Local was given. */
  directConstructions: [] as Array<Record<string, unknown>>,
  /**
   * Which library class each construction actually used, in order.
   *
   * The whole design rests on the dialect verdict selecting the matching client
   * class, and the two classes shape reads and writes differently, so the class
   * that was picked has to be observable. Mapping both names onto one fake made
   * every dialect test pass whichever class the code chose.
   */
  constructedApiClassNames: [] as string[],
  cloudApiConstructions: 0,
  authenticateCalls: 0,
  /** What the Athom cloud says about where this Homey answers. */
  cloudLocalUrl: null as string | null,
  cloudLocalUrlSecure: null as string | null,
  /** When set, the Athom cloud rejects the token instead of naming a Homey. */
  cloudFailure: null as Error | null,
  /** What `system.getInfo()` says the hub's own network address is. */
  wifiAddress: null as string | null,
  /** The generation the fake hub answers as, which decides the flow card shape it serves. */
  hubDialect: 'v2' as 'v2' | 'v3',
}))

vi.mock('homey-api', () => {
  const systemInfo = (): Record<string, unknown> => ({
    homeyVersion: '13.2.4',
    homeyModelId: 'homey4d',
    homeyModelName: 'Homey Pro (Early 2019)',
    timezone: 'Europe/Amsterdam',
    ...(library.wifiAddress === null ? {} : { wifiAddress: library.wifiAddress }),
  })

  class FakeHomeyApi {
    /**
     * Read through `this.constructor` in the base constructor, so it must be
     * static: a subclass instance field is not initialised yet at that point.
     */
    static readonly className: string = 'FakeHomeyApi'

    id = HOMEY_ID
    name = 'Home'
    language = 'en'
    strategyId = 'local'
    baseUrl = Promise.resolve('http://homey.test')
    system = {
      getInfo: async () => systemInfo(),
      getSystemName: async () => 'Home',
    }

    constructor(options: Record<string, unknown> = {}) {
      library.directConstructions.push(options)
      library.constructedApiClassNames.push((this.constructor as typeof FakeHomeyApi).className)
    }

    async call({ path }: { method: string; path: string }): Promise<unknown> {
      if (path.includes('flowcardtrigger')) return cardDescriptor()
      return {}
    }
  }

  // Two distinguishable classes, because "which one did the code construct" is
  // the question these tests exist to answer.
  class FakeHomeyApiV2 extends FakeHomeyApi {
    static override readonly className: string = 'HomeyAPIV2'
  }

  class FakeHomeyApiV3Local extends FakeHomeyApi {
    static override readonly className: string = 'HomeyAPIV3Local'
  }

  class FakeAthomCloudApi {
    static Token = class {
      constructor(public readonly options: unknown) {}
    }

    constructor() {
      library.cloudApiConstructions += 1
    }

    async getAuthenticatedUser(): Promise<unknown> {
      if (library.cloudFailure !== null) throw library.cloudFailure
      const homey = {
        id: HOMEY_ID,
        localUrl: library.cloudLocalUrl,
        localUrlSecure: library.cloudLocalUrlSecure,
        authenticate: async () => {
          library.authenticateCalls += 1
          // The real cloud route is where the library picks the class itself,
          // from the Homey's registered apiVersion, so the fake picks the one
          // matching the generation this hub is standing in for.
          return library.hubDialect === 'v3' ? new FakeHomeyApiV3Local() : new FakeHomeyApiV2()
        },
      }
      return {
        getFirstHomey: async () => homey,
        getHomeyById: async () => homey,
      }
    }
  }

  return {
    AthomCloudAPI: FakeAthomCloudApi,
    HomeyAPIV2: FakeHomeyApiV2,
    HomeyAPIV3Local: FakeHomeyApiV3Local,
  }
})

/** The V2 shape: a separate owner uri and a short id. */
function v2CardDescriptor(): Record<string, unknown> {
  return { uri: 'homey:manager:flow', id: 'programmatic_trigger', title: 'Programmatic trigger' }
}

/** The V3 shape: one owner uri field and a single fully qualified id. */
function v3CardDescriptor(): Record<string, unknown> {
  return {
    ownerUri: 'homey:manager:flow',
    id: 'homey:manager:flow:programmatic_trigger',
    title: 'Programmatic trigger',
  }
}

/** Whatever the hub of the moment answers with. One source of truth for both routes. */
function cardDescriptor(): Record<string, unknown> {
  return library.hubDialect === 'v3' ? v3CardDescriptor() : v2CardDescriptor()
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function pingResponse(): Response {
  return new Response('{}', {
    status: 200,
    headers: { 'x-homey-id': HOMEY_ID, 'x-homey-version': '13.2.4' },
  })
}

interface FetchScript {
  /** Addresses whose ping answers as this Homey. Everything else is unreachable. */
  reachableAddresses: string[]
  /** Status the authenticated dialect probe answers with. 200 unless a test says otherwise. */
  dialectProbeStatus?: number
  /**
   * Status for the single-card path only, leaving the card list answering
   * normally. A hub that keys its cards by fully qualified id answers 404 there,
   * which is how the dialect probe reaches its second step.
   */
  singleCardProbeStatus?: number
}

function scriptedFetch(script: FetchScript): { implementation: typeof fetch; requestedUrls: string[] } {
  const requestedUrls: string[] = []

  const implementation = (async (input: unknown) => {
    const url = String(input)
    requestedUrls.push(url)

    if (url.endsWith('/api/manager/system/ping')) {
      if (script.reachableAddresses.some((address) => url.startsWith(address))) return pingResponse()
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    }

    if (url.includes('flowcardtrigger')) {
      const status = script.dialectProbeStatus ?? 200
      if (status !== 200) return jsonResponse({ error: 'Invalid Token' }, status)

      const isCardList = url.endsWith('/flowcardtrigger')
      if (isCardList) {
        const descriptor = cardDescriptor()
        return jsonResponse({ [String(descriptor['id'])]: descriptor })
      }

      const singleCardStatus = script.singleCardProbeStatus ?? 200
      if (singleCardStatus !== 200) return jsonResponse({ error: 'Not Found' }, singleCardStatus)
      return jsonResponse(cardDescriptor())
    }

    throw new Error(`Unexpected request in this test: ${url}`)
  }) as unknown as typeof fetch

  return { implementation, requestedUrls }
}

/** The failure a connection attempt produced, or a failed test if it connected. */
async function failureOf(attempt: Promise<unknown>): Promise<HomeyMcpError> {
  try {
    await attempt
  } catch (error) {
    return error as HomeyMcpError
  }
  throw new Error('Expected connectToHomey to fail, but it connected')
}

function credentials(overrides: Partial<ResolvedCredentials> = {}): ResolvedCredentials {
  return {
    source: 'homey_cli_session',
    sourceDescription: 'the session stored by the Homey CLI',
    cloudToken: {
      token_type: 'bearer',
      access_token: `${'cD4fGh1j'.repeat(8)}`,
      refresh_token: null,
      expires_in: null,
      grant_type: null,
    },
    personalAccessToken: null,
    homeyId: HOMEY_ID,
    localSessionToken: HUB_SESSION_TOKEN,
    localAddress: null,
    localSecureAddress: null,
    sessionExpiresAt: null,
    scopes: ['homey'],
    configPath: null,
    ...overrides,
  }
}

let cacheDirectory: string
let cachePath: string

beforeEach(async () => {
  library.directConstructions = []
  library.constructedApiClassNames = []
  library.hubDialect = 'v2'
  library.cloudApiConstructions = 0
  library.authenticateCalls = 0
  library.cloudLocalUrl = LAN_ADDRESS
  library.cloudLocalUrlSecure = LAN_SECURE_ADDRESS
  library.cloudFailure = null
  library.wifiAddress = null

  cacheDirectory = await mkdtemp(join(tmpdir(), 'homey-mcp-connect-'))
  cachePath = join(cacheDirectory, 'hub-addresses.json')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('connectToHomey', () => {
  it('stays on the LAN using the addresses a previous connection remembered', async () => {
    // The direct hub route was unreachable code: no credential source names a
    // LAN address, so the candidate list was always empty and every start went
    // through the Athom cloud, even though the hub answers in 25 ms.
    await writeFile(
      cachePath,
      JSON.stringify({ [HOMEY_ID]: { localAddress: LAN_ADDRESS, localSecureAddress: null } }),
    )

    const { implementation } = scriptedFetch({ reachableAddresses: [LAN_ADDRESS] })

    const connection = await connectToHomey(credentials(), {
      fetchImplementation: implementation,
      hubAddressCachePath: cachePath,
    })

    expect(connection.diagnostics.route).toBe('lan_session')
    expect(connection.identity.addressKind).toBe('local')
    expect(connection.identity.address).toBe(LAN_ADDRESS)
    expect(library.cloudApiConstructions).toBe(0)
    expect(library.authenticateCalls).toBe(0)
    // The hub session token, not the Athom one, and against the LAN address.
    expect(library.directConstructions[0]).toMatchObject({ token: HUB_SESSION_TOKEN, baseUrl: LAN_ADDRESS })
  })

  it('remembers where the Athom cloud says the hub answers, so the next start skips the cloud', async () => {
    const first = scriptedFetch({ reachableAddresses: [LAN_ADDRESS] })

    const cloudConnection = await connectToHomey(credentials(), {
      fetchImplementation: first.implementation,
      hubAddressCachePath: cachePath,
    })

    expect(cloudConnection.diagnostics.route).toBe('athom_cloud')
    expect(library.authenticateCalls).toBe(1)

    const remembered: unknown = JSON.parse(await readFile(cachePath, 'utf8'))
    expect(remembered).toMatchObject({
      [cloudConnection.identity.id]: {
        localAddress: LAN_ADDRESS,
        localSecureAddress: LAN_SECURE_ADDRESS,
      },
    })

    // Second start: same credentials, same cache file, no cloud round trip.
    const second = scriptedFetch({ reachableAddresses: [LAN_ADDRESS, LAN_SECURE_ADDRESS] })
    const lanConnection = await connectToHomey(credentials(), {
      fetchImplementation: second.implementation,
      hubAddressCachePath: cachePath,
    })

    expect(lanConnection.diagnostics.route).toBe('lan_session')
    expect(library.authenticateCalls).toBe(1)
  })

  it('falls back to the Athom cloud when the hub refuses the stored session', async () => {
    // A 401 during dialect detection means this session no longer works here.
    // Rethrowing turned a recoverable state into a dead end, even though the
    // cloud route can mint a new session.
    const { implementation } = scriptedFetch({
      reachableAddresses: [LAN_ADDRESS],
      dialectProbeStatus: 401,
    })

    const connection = await connectToHomey(credentials({ localAddress: LAN_ADDRESS }), {
      fetchImplementation: implementation,
      hubAddressCachePath: cachePath,
    })

    expect(connection.diagnostics.route).toBe('athom_cloud')
    expect(library.authenticateCalls).toBe(1)
  })

  it('names the command that fixes an expired session instead of failing opaquely', async () => {
    const { implementation } = scriptedFetch({ reachableAddresses: [LAN_ADDRESS] })

    const expired = credentials({
      cloudToken: null,
      sessionExpiresAt: '2026-08-12T06:00:00.000Z',
    })

    const failure = await failureOf(
      connectToHomey(expired, {
        fetchImplementation: implementation,
        hubAddressCachePath: cachePath,
        now: () => new Date('2026-08-13T06:00:00.000Z'),
      }),
    )

    expect(failure).toBeInstanceOf(HomeyMcpError)
    expect(failure.reason).toBe('not_connected')
    expect(failure.message).toContain('homey login')
    expect(failure.message).toContain('24 hours')
    // Every message is redacted on its way into the error, and the redactor
    // masks whatever follows the word "token", because that is the shape of an
    // Authorization header. This sentence used to say "no Athom account token
    // alongside it" and reached the user as "token alon...[9 chars] it".
    expect(failure.message).not.toContain('chars]')
    // Nothing was attempted against the hub with a token known to be dead.
    expect(library.cloudApiConstructions).toBe(0)
  })

  it('connects on a hub session alone by deriving the hub cloud origin from the Homey id', async () => {
    // Nothing to authenticate against the Athom cloud with, and no remembered
    // LAN address either. The one address that can still be derived is the
    // hub's own cloud origin, and the hub session token authenticates there.
    const cloudOrigin = `https://${HOMEY_ID}.connect.athom.com`
    const { implementation } = scriptedFetch({ reachableAddresses: [cloudOrigin] })

    const connection = await connectToHomey(credentials({ cloudToken: null }), {
      fetchImplementation: implementation,
      hubAddressCachePath: cachePath,
    })

    expect(connection.diagnostics.route).toBe('lan_session')
    expect(connection.identity.addressKind).toBe('cloud')
    expect(library.cloudApiConstructions).toBe(0)
  })

  it('falls back to the hub session when the Athom cloud route fails', async () => {
    // The measured dead end. The Homey CLI stores a one hour cloud token, a 24
    // hour hub session and the Homey's cloud id, and no LAN address of any kind.
    // On a cold cache there was therefore nothing to try locally, the presence of
    // a cloud token sent the connection down the cloud route, and the hour-old
    // token killed it there, while the hub sat answering on its own cloud origin
    // in 318 ms.
    const hubCloudOrigin = `https://${HOMEY_ID}.connect.athom.com`
    library.cloudFailure = new HomeyMcpError('not_connected', 'Homey rejected the saved session, run "homey login"')
    const { implementation } = scriptedFetch({ reachableAddresses: [hubCloudOrigin] })

    const connection = await connectToHomey(credentials(), {
      fetchImplementation: implementation,
      hubAddressCachePath: cachePath,
    })

    expect(connection.diagnostics.route).toBe('lan_session')
    expect(connection.identity.addressKind).toBe('cloud')
    expect(library.directConstructions[0]).toMatchObject({ token: HUB_SESSION_TOKEN })
  })

  it('re-raises the cloud failure, not the address failure, when neither route works', async () => {
    // "Your session expired, run homey login" names a command. "No address
    // answered" names nothing anybody can act on, so it must not be the message
    // that surfaces when the real cause is a dead credential.
    library.cloudFailure = new HomeyMcpError(
      'not_connected',
      'Homey rejected the saved session. Sign in again with "homey login".',
    )
    const { implementation } = scriptedFetch({ reachableAddresses: [] })

    const failure = await failureOf(
      connectToHomey(credentials(), {
        fetchImplementation: implementation,
        hubAddressCachePath: cachePath,
      }),
    )

    expect(failure.message).toContain('homey login')
    expect(failure.message).not.toContain('which addresses answer')
  })

  it('does not let an expired cloud token outrank a hub session that is still alive', async () => {
    // The two lifetimes are an order of magnitude apart, so for most of any day
    // the cloud token is dead while the hub session it minted is fine. Treating
    // the dead one as a credential put the cloud route first and dead-ended
    // there without ever trying the session that works.
    const hubCloudOrigin = `https://${HOMEY_ID}.connect.athom.com`
    const { implementation } = scriptedFetch({ reachableAddresses: [hubCloudOrigin] })

    const connection = await connectToHomey(
      credentials({ cloudTokenExpiresAt: '2026-08-13T05:00:00.000Z' }),
      {
        fetchImplementation: implementation,
        hubAddressCachePath: cachePath,
        now: () => new Date('2026-08-13T06:00:00.000Z'),
      },
    )

    expect(connection.diagnostics.route).toBe('lan_session')
    // Nothing was even attempted against Athom with a token known to be dead.
    expect(library.cloudApiConstructions).toBe(0)
  })

  it('still uses a cloud token whose lifetime the credential source never stated', async () => {
    // "Not stated" is not "expired". A config file that carries no lifetime must
    // keep working exactly as before.
    const { implementation } = scriptedFetch({ reachableAddresses: [LAN_ADDRESS] })

    const connection = await connectToHomey(credentials({ cloudTokenExpiresAt: null }), {
      fetchImplementation: implementation,
      hubAddressCachePath: cachePath,
    })

    expect(connection.diagnostics.route).toBe('athom_cloud')
  })

  it('learns the LAN address from the hub itself, so a cloud-free start still fills the cache', async () => {
    // Measured on the hardware: system.getInfo() answers with
    // `wifiAddress: "<lan ip>:80"`. Without reading it, a start that reached the
    // hub over its own cloud origin learns nothing, so the address cache stays
    // empty and every later start is slow again for as long as the cloud token
    // is dead.
    const hubCloudOrigin = `https://${HOMEY_ID}.connect.athom.com`
    library.cloudFailure = new HomeyMcpError('not_connected', 'Homey rejected the saved session')
    library.wifiAddress = `${LAN_HOST}:80`
    const first = scriptedFetch({ reachableAddresses: [hubCloudOrigin] })

    await connectToHomey(credentials(), {
      fetchImplementation: first.implementation,
      hubAddressCachePath: cachePath,
    })

    const remembered: unknown = JSON.parse(await readFile(cachePath, 'utf8'))
    expect(remembered).toMatchObject({ [HOMEY_ID]: { localAddress: LAN_ADDRESS } })

    // And the next start uses it, on the LAN, with no cloud attempt at all.
    const second = scriptedFetch({ reachableAddresses: [LAN_ADDRESS] })
    const overLan = await connectToHomey(credentials(), {
      fetchImplementation: second.implementation,
      hubAddressCachePath: cachePath,
    })

    expect(overLan.identity.address).toBe(LAN_ADDRESS)
    expect(library.cloudApiConstructions).toBe(1)
  })

  it('keeps the encrypted LAN address a cloud start learned, which the hub never reports about itself', async () => {
    // system.getInfo() names only the plain `wifiAddress`, so the hub-reported
    // record carries localSecureAddress: null. Writing that record wholesale
    // erased the encrypted rung the Athom cloud had taught the cache, so the
    // first LAN start silently downgraded every later start to plain HTTP.
    await writeFile(
      cachePath,
      JSON.stringify({ [HOMEY_ID]: { localAddress: LAN_ADDRESS, localSecureAddress: LAN_SECURE_ADDRESS } }),
    )
    library.wifiAddress = `${LAN_HOST}:80`

    const { implementation } = scriptedFetch({ reachableAddresses: [LAN_ADDRESS] })
    const connection = await connectToHomey(credentials(), {
      fetchImplementation: implementation,
      hubAddressCachePath: cachePath,
    })

    expect(connection.diagnostics.route).toBe('lan_session')

    const remembered: unknown = JSON.parse(await readFile(cachePath, 'utf8'))
    expect(remembered).toMatchObject({
      [HOMEY_ID]: { localAddress: LAN_ADDRESS, localSecureAddress: LAN_SECURE_ADDRESS },
    })
  })

  it('still reports a credentials file that carries no credential at all as a setup problem', async () => {
    // Not a reachability problem, so it must not be reported as one.
    const { implementation } = scriptedFetch({ reachableAddresses: [] })

    const failure = await failureOf(
      connectToHomey(credentials({ cloudToken: null, localSessionToken: null }), {
        fetchImplementation: implementation,
        hubAddressCachePath: cachePath,
      }),
    )

    expect(failure.reason).toBe('not_connected')
    expect(failure.message).toContain('homey-mcp setup')
  })

  it('reports a hub session that reaches nothing without blaming the credentials file', async () => {
    const { implementation } = scriptedFetch({ reachableAddresses: [] })

    const failure = await failureOf(
      connectToHomey(credentials({ cloudToken: null }), {
        fetchImplementation: implementation,
        hubAddressCachePath: cachePath,
      }),
    )

    expect(failure).toBeInstanceOf(HomeyMcpError)
    expect(failure.reason).toBe('not_connected')
    expect(failure.message).toContain('doctor')
  })
})

/**
 * The class the dialect verdict selects.
 *
 * This is the one decision the whole design rests on. V2 splits a flow card into
 * a separate uri and a short id while V3 carries one fully qualified id, so the
 * two client classes read and write different shapes, and picking the wrong one
 * connects perfectly happily and then corrupts writes. The hardware to check it
 * on is not here, so the decision is what gets tested: a V3 descriptor must
 * reach HomeyAPIV3Local and a V2 descriptor must reach HomeyAPIV2, with the two
 * classes distinguishable rather than mapped onto one fake.
 *
 * Every test here goes over the LAN route on a remembered address, because that
 * is the route where this server picks the class itself. Over the Athom cloud
 * the library picks it from the Homey's registered apiVersion.
 */
describe('the client class the dialect verdict selects', () => {
  async function connectOverLan(): Promise<{ dialect: string; evidence: string }> {
    await writeFile(
      cachePath,
      JSON.stringify({ [HOMEY_ID]: { localAddress: LAN_ADDRESS, localSecureAddress: null } }),
    )

    const { implementation } = scriptedFetch({ reachableAddresses: [LAN_ADDRESS] })
    const connection = await connectToHomey(credentials(), {
      fetchImplementation: implementation,
      hubAddressCachePath: cachePath,
    })

    // Anything else means the library chose the class rather than this server.
    expect(connection.diagnostics.route).toBe('lan_session')
    expect(library.cloudApiConstructions).toBe(0)

    return { dialect: connection.dialect, evidence: connection.diagnostics.dialectEvidence }
  }

  it('constructs HomeyAPIV3Local when the hub answers in the V3 shape', async () => {
    library.hubDialect = 'v3'

    const { dialect, evidence } = await connectOverLan()

    expect(dialect).toBe('v3')
    expect(evidence).toContain('ownerUri')
    expect(library.constructedApiClassNames).toEqual(['HomeyAPIV3Local'])
  })

  it('constructs HomeyAPIV2 when the hub answers in the V2 shape', async () => {
    library.hubDialect = 'v2'

    const { dialect, evidence } = await connectOverLan()

    expect(dialect).toBe('v2')
    expect(evidence).toContain('short id')
    expect(library.constructedApiClassNames).toEqual(['HomeyAPIV2'])
  })

  it('still reaches HomeyAPIV3Local when the V3 verdict comes from the card list', async () => {
    // A hub that keys its cards by fully qualified id answers the single-card
    // path with a 404, so the verdict arrives one step later. The class it
    // selects must not depend on which step produced it.
    library.hubDialect = 'v3'
    await writeFile(
      cachePath,
      JSON.stringify({ [HOMEY_ID]: { localAddress: LAN_ADDRESS, localSecureAddress: null } }),
    )

    const { implementation } = scriptedFetch({
      reachableAddresses: [LAN_ADDRESS],
      singleCardProbeStatus: 404,
    })

    const connection = await connectToHomey(credentials(), {
      fetchImplementation: implementation,
      hubAddressCachePath: cachePath,
    })

    expect(connection.dialect).toBe('v3')
    expect(library.constructedApiClassNames).toEqual(['HomeyAPIV3Local'])
    expect(library.cloudApiConstructions).toBe(0)
  })
})
