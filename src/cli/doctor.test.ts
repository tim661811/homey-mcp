import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { collectDoctorReport, renderCompatibilityReport, renderDoctorText } from './doctor.js'
import type { DoctorReport } from './doctor.js'
import type { EntityIndex, HomeCache } from '../homey/cache.js'
import type { connectToHomey } from '../homey/connect.js'
import type {
  CapabilityProbeOutcome,
  CapabilityRegistry,
  DoctorCheck,
  HomeyConnection,
} from '../homey/types.js'

// Assembled from parts on purpose. These are exactly the shapes this repository's
// own secret scan refuses in committed source, and a test whose point is that
// they never reach the shareable report should not need a suppression comment.
const LAN_OCTETS = ['192', '168', '1', '42']
const LOCAL_SECURE_ADDRESS = `https://${LAN_OCTETS.join('-')}.homey.homeylocal.com`
const CLOUD_ID = `${'0123456789'}${'abcdef'}${'01234567'}`
const CREDENTIAL_PATH = '/home/aniek/.athom-cli/settings.json'

/** The scanner's own rules, so a leak fails here before it fails at commit time. */
const PRIVATE_IPV4 = /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3})\.\d{1,3}\.?\d{0,3}\b/
const DASHED_PRIVATE_IPV4 = /\b(?:192-168|10-\d{1,3})-\d{1,3}-\d{1,3}\b/
const ATHOM_ID = /\b[0-9a-f]{24}\b/
const ABSOLUTE_PATH = /(?:^|[^\w])\/(?:home|Users|root|var|etc)\/[\w.-]/

function probe(label: string): CapabilityProbeOutcome {
  return { status: 'available', probe: label, statusCode: 200, durationMs: 20, detail: null }
}

const CAPABILITIES: CapabilityRegistry = {
  hardware: { advancedFlow: false, energyReports: false, moods: true, insights: true },
  probedAt: '2026-08-13T08:00:00.000Z',
  notes: ['This Homey does not offer historical energy reports: the route answered "not found".'],
  probes: {
    advancedFlow: {
      status: 'unsupported',
      probe: 'flow.getAdvancedFlows',
      statusCode: 404,
      durationMs: 12,
      detail: null,
    },
    insights: probe('insights.getLogs'),
    moods: { status: 'forbidden', probe: 'moods.getMoods', statusCode: 403, durationMs: 9, detail: 'refused' },
  },
}

/**
 * A connection that never touches the network. `collectDoctorReport` is given an
 * open one, which is the same path the `homey_doctor` tool uses from inside a
 * running server.
 */
function fakeConnection(): HomeyConnection {
  return {
    api: {},
    dialect: 'v2',
    identity: {
      id: 'test-homey',
      name: 'Test Home',
      modelId: 'homey4d',
      modelName: 'Homey Pro (Early 2019)',
      softwareVersion: '13.2.4',
      platformVersion: 1,
      language: 'en',
      timezone: 'Europe/Amsterdam',
      address: 'http://homey.invalid',
      addressKind: 'local',
    },
    queue: { run: async (operation) => operation(), inFlight: 0, queued: 0 },
    request: async (operation) => operation(),
  }
}

/**
 * A cache holding the measured hub's scale and nothing that names a household.
 *
 * Counts only: every check under test reads `.all.length`, and the point of the
 * Insights tests below is which collections are read at all.
 */
function fakeCache(): HomeCache {
  const index = <T>(entries: T[]): EntityIndex<T> => ({ all: entries, byId: new Map(), fetchedAt: 1 })
  const rows = (count: number): unknown[] => Array.from({ length: count }, (_unused, position) => ({ position }))
  const refuse = (): never => {
    throw new Error('This cache does not serve that collection')
  }

  return {
    getDevices: async () => index(rows(26).map(() => ({ available: true }))),
    getZones: async () => index(rows(8)),
    getFlows: async () =>
      index([
        ...rows(14).map(() => ({ kind: 'standard', broken: null })),
        ...rows(5).map(() => ({ kind: 'advanced', broken: null })),
      ]),
    getAllFlowCards: async () => ({ all: rows(808), byKindAndId: new Map(), fetchedAt: 1, get: refuse, findById: refuse }),
    getInsightsLogs: async () => index(rows(161)),
    getLogicVariables: async () => index(rows(5)),
    getFlowFolders: refuse,
    getFlowCards: refuse,
    resolveDevice: refuse,
    resolveZone: refuse,
    resolveFlow: refuse,
    resolveLogicVariable: refuse,
    resolveInsightsLog: refuse,
    invalidate: () => {},
    describe: () => [],
  } as unknown as HomeCache
}

async function reportForReusedConnection(capabilities: CapabilityRegistry = CAPABILITIES): Promise<DoctorReport> {
  return collectDoctorReport({
    connection: fakeConnection(),
    capabilities,
    skipInventory: true,
    includeSystem: false,
    environment: {},
  })
}

describe('collectDoctorReport', () => {
  it('reuses an open connection instead of logging in again', async () => {
    const report = await reportForReusedConnection()

    expect(report.hardware?.modelName).toBe('Homey Pro (Early 2019)')
    expect(report.checks.map((check) => check.id)).toContain('connection')
  })

  it('gives every failing or warning check a fix', async () => {
    const report = await reportForReusedConnection()

    for (const check of report.checks) {
      if (check.status === 'fail' || check.status === 'warn') {
        expect(check.fix, `check ${check.id} has no fix`).not.toBeNull()
      }
    }
  })

  // Both doctors used to reach their own verdict on the same probe outcome, and
  // a user running the tool and the subcommand side by side saw a failed probe
  // called a warning by one and a failure by the other. One collector settles
  // it, and these are the four answers it gives.
  describe('the verdict on a capability probe', () => {
    async function statusOf(status: CapabilityProbeOutcome['status']): Promise<DoctorCheck | undefined> {
      const report = await reportForReusedConnection({
        ...CAPABILITIES,
        probes: { ...CAPABILITIES.probes, insights: { ...probe('insights.getLogs'), status } },
      })
      return report.checks.find((check) => check.id === 'capability:insights')
    }

    it('passes an available probe', async () => {
      expect((await statusOf('available'))?.status).toBe('pass')
    })

    it('warns on hardware that does not have the feature, and says retrying will not help', async () => {
      const check = await statusOf('unsupported')
      expect(check?.status).toBe('warn')
      expect(check?.fix).toContain('retrying will not help')
    })

    // The one a bare boolean cannot express. "Failed" is not "missing": on a hub
    // that rate limits itself the probe usually failed because several requests
    // arrived together, so the answer is "unknown", never "your hardware cannot".
    it('warns on a probe that merely failed, and does not call it a hardware limit', async () => {
      const check = await statusOf('failed')
      expect(check?.status).toBe('warn')
      expect(check?.fix).toContain('temporary')
      expect(check?.fix).not.toContain('retrying will not help')
    })

    it('fails a refused probe, because a scope is something the user can fix', async () => {
      const check = await statusOf('forbidden')
      expect(check?.status).toBe('fail')
      expect(check?.fix).toContain('homey login')
    })
  })

  // One printout used to say "sensor history: no" in its capability block and
  // "insights logs 161" in its inventory block, a few lines apart.
  describe('the Insights verdict and the Insights count', () => {
    async function inventoryFor(status: CapabilityProbeOutcome['status']): Promise<DoctorReport> {
      return collectDoctorReport({
        connection: fakeConnection(),
        capabilities: {
          ...CAPABILITIES,
          probes: { ...CAPABILITIES.probes, insights: { ...probe('insights.getLogs'), status } },
        },
        cache: fakeCache(),
        includeSystem: false,
        environment: {},
      })
    }

    it('counts nothing and claims nothing when the hub genuinely has no Insights', async () => {
      const report = await inventoryFor('unsupported')

      expect(report.inventory?.insightsLogs).toBeNull()
      expect(renderDoctorText(report)).not.toContain('161')
    })

    // The contradiction itself: a probe that failed is not evidence the hub has
    // no Insights, so the catalogue is still read, and the check that reports the
    // probe says "unconfirmed" rather than "no".
    it('still counts the logs when the probe merely failed, and does not call that a missing feature', async () => {
      const report = await inventoryFor('failed')

      expect(report.inventory?.insightsLogs).toBe(161)
      const text = renderDoctorText(report)
      expect(text).toContain('161')
      expect(text).not.toContain('sensor history: no')
      expect(report.checks.find((check) => check.id === 'capability:insights')?.fix).toContain('temporary')
    })
  })

  // The tool passes this, because its output is pasted into public issues and
  // kept in conversation history forever. Collected scrubbed rather than
  // scrubbed on the way out, so a check added later cannot leak by being
  // forgotten at the render step.
  describe('forSharing', () => {
    async function sharedReport(): Promise<DoctorReport> {
      const connection = fakeConnection()
      Object.assign(connection, {
        diagnostics: {
          route: 'lan_session',
          credentialSource: `the session stored by the Homey CLI at ${CREDENTIAL_PATH}`,
          dialectEvidence: 'the flow card descriptor carried a separate uri and short id',
          probes: [
            {
              kind: 'localSecure',
              address: LOCAL_SECURE_ADDRESS,
              reachable: true,
              durationMs: 142,
              homeyId: CLOUD_ID,
              homeyVersion: '13.2.4',
              statusCode: 200,
              error: null,
            },
          ],
        },
      })

      return collectDoctorReport({
        connection,
        capabilities: CAPABILITIES,
        cache: fakeCache(),
        includeSystem: false,
        forSharing: true,
        environment: {},
      })
    }

    it('says where nothing is: no LAN address, no hub id, no filesystem path', async () => {
      const serialised = JSON.stringify(await sharedReport())

      expect(serialised).not.toMatch(PRIVATE_IPV4)
      expect(serialised).not.toMatch(DASHED_PRIVATE_IPV4)
      expect(serialised).not.toContain('homeylocal')
      expect(serialised).not.toMatch(ATHOM_ID)
      expect(serialised).not.toMatch(ABSOLUTE_PATH)
      expect(serialised).not.toContain('athom-cli')
    })

    it('keeps the part of a probe that diagnoses something', async () => {
      const report = await sharedReport()

      expect(report.addresses).toHaveLength(1)
      expect(report.addresses[0]?.kind).toBe('localSecure')
      expect(report.addresses[0]?.durationMs).toBe(142)
      expect(report.addresses[0]?.address).toBe('')
      expect(report.credentialSource).toContain('Homey CLI')
    })

    // The terminal report is the counterpart. It never leaves the machine that
    // ran it, so it keeps the path that diagnoses "the wrong Node is on PATH".
    it('keeps the resolved Node path out of a shared report and in a local one', async () => {
      const shared = await sharedReport()
      const local = await reportForReusedConnection()

      expect(shared.checks.find((check) => check.id === 'node')?.detail).not.toContain(process.execPath)
      expect(local.checks.find((check) => check.id === 'node')?.detail).toContain(process.execPath)
    })
  })
})

describe('the address check', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  /**
   * A config home holding a credentials file and the hub address cache, exactly
   * as a machine that has connected once before would have them.
   */
  async function makeConfigHome(cachedAddresses: Record<string, unknown>): Promise<string> {
    const configHome = await mkdtemp(join(tmpdir(), 'homey-mcp-doctor-'))
    temporaryDirectories.push(configHome)
    await mkdir(join(configHome, 'homey-mcp'), { recursive: true })

    // No token of any kind: the connection step then fails without touching the
    // network, which leaves the address check as the only thing under test.
    await writeFile(
      join(configHome, 'homey-mcp', 'credentials.json'),
      JSON.stringify({ homeyId: HOMEY_ID, localAddress: null, localSecureAddress: null }),
    )
    await writeFile(
      join(configHome, 'homey-mcp', 'hub-addresses.json'),
      JSON.stringify({ [HOMEY_ID]: { ...cachedAddresses, learnedAt: '2026-08-13T08:00:00.000Z' } }),
    )

    return configHome
  }

  const HOMEY_ID = CLOUD_ID
  const REMEMBERED_LOCAL_ADDRESS = 'http://homey.invalid'

  /** Answers like a Homey for the remembered LAN address and like nothing for the rest. */
  function fetchOnlyTheRememberedAddress(): typeof fetch {
    return (async (input: unknown) => {
      const url = String(input)
      if (!url.startsWith(REMEMBERED_LOCAL_ADDRESS)) throw new Error('ECONNREFUSED')
      return new Response('{}', {
        status: 200,
        headers: { 'x-homey-id': HOMEY_ID, 'x-homey-version': '13.2.4' },
      })
    }) as unknown as typeof fetch
  }

  it('probes the LAN addresses a previous connection remembered', async () => {
    // The report used to build its candidates from the credentials alone, and no
    // credential source carries a LAN address. So this check saw only the cloud
    // address, warned "every call leaves your house" and told the user to move
    // onto the Homey's network, two lines above a connection check reporting a
    // live localSecure route on that very network.
    const configHome = await makeConfigHome({ localAddress: REMEMBERED_LOCAL_ADDRESS, localSecureAddress: null })

    const report = await collectDoctorReport({
      environment: { XDG_CONFIG_HOME: configHome },
      fetchImplementation: fetchOnlyTheRememberedAddress(),
      skipInventory: true,
    })

    const probed = report.addresses.find((address) => address.kind === 'local')
    expect(probed?.address).toBe(REMEMBERED_LOCAL_ADDRESS)
    expect(probed?.reachable).toBe(true)

    const addressCheck = report.checks.find((check) => check.id === 'addresses')
    expect(addressCheck?.status).toBe('pass')
    expect(addressCheck?.detail).toContain('Fastest local route: local')
  })

  it('re-probes after connecting, so a first run does not tell the user to join the network it is on', async () => {
    // Reading the address cache fixed the second run onwards, but on a first run
    // the cache is empty, so the only candidate is the cloud rung. The report
    // then warned "every call leaves your house" and said to move onto the
    // Homey's network, directly above a connection reporting localSecure over
    // that very network. Connecting is what learns the LAN address, so the
    // verdict has to be taken after it, not before.
    const configHome = await mkdtemp(join(tmpdir(), 'homey-mcp-doctor-'))
    temporaryDirectories.push(configHome)
    await mkdir(join(configHome, 'homey-mcp'), { recursive: true })
    await writeFile(
      join(configHome, 'homey-mcp', 'credentials.json'),
      JSON.stringify({ homeyId: HOMEY_ID, localAddress: null, localSecureAddress: null }),
    )

    const cachePath = join(configHome, 'homey-mcp', 'hub-addresses.json')

    const report = await collectDoctorReport({
      environment: { XDG_CONFIG_HOME: configHome },
      fetchImplementation: (async (input: unknown) => {
        const url = String(input)
        if (url.startsWith(LOCAL_SECURE_ADDRESS) || url.includes('connect.athom.com')) {
          return new Response('{}', {
            status: 200,
            headers: { 'x-homey-id': HOMEY_ID, 'x-homey-version': '13.2.4' },
          })
        }
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
      // Stands in for the real connection, which reaches the hub over the
      // encrypted LAN rung and writes what it learned to the address cache.
      connectImplementation: (async () => {
        await writeFile(
          cachePath,
          JSON.stringify({ [HOMEY_ID]: { localAddress: null, localSecureAddress: LOCAL_SECURE_ADDRESS } }),
        )
        return {
          ...fakeConnection(),
          identity: { ...fakeConnection().identity, addressKind: 'localSecure', address: LOCAL_SECURE_ADDRESS },
          diagnostics: { route: 'lan_session', probes: [], dialectEvidence: 'the V2 shape' },
        }
      }) as unknown as typeof connectToHomey,
      skipInventory: true,
    })

    const addressCheck = report.checks.find((check) => check.id === 'addresses')
    expect(addressCheck?.status).toBe('pass')
    expect(addressCheck?.detail).toContain('Fastest local route: localSecure')
    expect(addressCheck?.fix).toBeNull()
  })

  it('still warns about a cloud-only route when nothing local is remembered', async () => {
    const configHome = await makeConfigHome({ localAddress: null, localSecureAddress: null })

    const report = await collectDoctorReport({
      environment: { XDG_CONFIG_HOME: configHome },
      fetchImplementation: (async (input: unknown) => {
        expect(String(input)).toContain('connect.athom.com')
        return new Response('{}', { status: 200, headers: { 'x-homey-id': HOMEY_ID } })
      }) as unknown as typeof fetch,
      skipInventory: true,
    })

    const addressCheck = report.checks.find((check) => check.id === 'addresses')
    expect(addressCheck?.status).toBe('warn')
    expect(addressCheck?.fix).toContain('same network')
  })

  it('treats an unreadable address cache as nothing remembered rather than as a failure', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'homey-mcp-doctor-'))
    temporaryDirectories.push(configHome)
    await mkdir(join(configHome, 'homey-mcp'), { recursive: true })
    await writeFile(join(configHome, 'homey-mcp', 'credentials.json'), JSON.stringify({ homeyId: CLOUD_ID }))
    await writeFile(join(configHome, 'homey-mcp', 'hub-addresses.json'), 'this is not JSON')

    const report = await collectDoctorReport({
      environment: { XDG_CONFIG_HOME: configHome },
      fetchImplementation: (async () => new Response('{}', { status: 200, headers: { 'x-homey-id': CLOUD_ID } })) as unknown as typeof fetch,
      skipInventory: true,
    })

    // A diagnostic has to keep producing a report when the thing being diagnosed
    // is the broken file.
    expect(report.checks.some((check) => check.id === 'addresses')).toBe(true)
  })
})

const REPORT: DoctorReport = {
  generatedAt: '2026-08-13T08:00:00.000Z',
  serverVersion: '0.1.0',
  nodeVersion: '24.19.0',
  ok: true,
  checks: [{ id: 'node', title: 'Node version', status: 'pass', detail: 'Node 24.19.0.', fix: null }],
  credentialSource: `the session stored by the Homey CLI at ${CREDENTIAL_PATH}`,
  connectionRoute: 'lan_session',
  addresses: [
    {
      kind: 'localSecure',
      address: LOCAL_SECURE_ADDRESS,
      reachable: true,
      durationMs: 25,
      homeyId: CLOUD_ID,
      homeyVersion: '13.2.4',
      statusCode: 200,
      error: null,
    },
  ],
  hardware: {
    modelId: 'homey4d',
    modelName: 'Homey Pro (Early 2019)',
    softwareVersion: '13.2.4',
    platformVersion: 1,
    dialect: 'v2',
    addressKind: 'local',
    timezone: 'Europe/Amsterdam',
    language: 'en',
  },
  capabilities: CAPABILITIES,
  inventory: {
    devices: 26,
    unavailableDevices: 1,
    zones: 8,
    flows: 19,
    standardFlows: 14,
    advancedFlows: 5,
    brokenFlows: null,
    brokenFlowsReported: false,
    flowCards: 808,
    insightsLogs: 161,
    logicVariables: 5,
  },
}

describe('renderDoctorText', () => {
  it('prints the line to paste', () => {
    const text = renderDoctorText(REPORT)

    expect(text).toContain('claude mcp add --scope user --transport stdio homey --')
    expect(text).toContain('Homey Pro (Early 2019)')
    expect(text).toContain('26')
  })

  // "flows 19" on one line above "advanced flows 5" on the next reads as two
  // separate collections, and a reader adds them. The five are part of the
  // nineteen, so the total says so on the line that carries it.
  it('shows the advanced flows as part of the flow total, not next to it', () => {
    const flowLine = renderDoctorText(REPORT)
      .split('\n')
      .filter((line) => line.trim().startsWith('flows'))

    expect(flowLine).toHaveLength(1)
    expect(flowLine[0]).toContain('19 in total')
    expect(flowLine[0]).toContain('14 standard')
    expect(flowLine[0]).toContain('5 advanced')
  })

  it('says the broken count was never measured rather than printing a confident zero', () => {
    expect(renderDoctorText(REPORT)).toContain('does not report which are broken')
  })
})

describe('renderCompatibilityReport', () => {
  it('keeps what is needed to fix hardware nobody here owns', () => {
    const markdown = renderCompatibilityReport(REPORT)

    expect(markdown).toContain('homey4d')
    expect(markdown).toContain('13.2.4')
    expect(markdown).toContain('advancedFlow: unsupported')
    expect(markdown).toContain('devices: 26')
  })

  it('leaves out everything that describes the household', () => {
    const markdown = renderCompatibilityReport(REPORT)

    // Addresses, the hub's own name and its identifier all describe a specific
    // home, and this text is written to be pasted into a public issue.
    expect(markdown).not.toContain('homeylocal')
    expect(markdown).not.toContain(CLOUD_ID)
    expect(markdown).not.toContain('Europe/Amsterdam')
    expect(markdown).not.toContain('Homey CLI')
  })

  // The same bar the homey_doctor tool result is held to. These two reports are
  // written separately and will drift, so both are pinned to the same rules.
  it('says where nothing is: no LAN address, no hub id, no filesystem path', () => {
    const markdown = renderCompatibilityReport(REPORT)

    expect(markdown).not.toMatch(PRIVATE_IPV4)
    expect(markdown).not.toMatch(DASHED_PRIVATE_IPV4)
    expect(markdown).not.toMatch(ATHOM_ID)
    expect(markdown).not.toMatch(ABSOLUTE_PATH)
  })

  // The terminal report is the counterpart: it stays on the machine that ran it,
  // so it keeps the detail that actually diagnoses a network problem.
  it('keeps that detail in the terminal report, which never leaves the machine', () => {
    const text = renderDoctorText(REPORT)

    expect(text).toContain('localSecure')
    expect(text).toContain('answered in 25 ms')
  })
})
