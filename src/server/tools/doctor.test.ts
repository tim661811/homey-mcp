// The doctor report exists to be pasted into a bug report about hardware the
// maintainer does not own, so three properties are tested here as hard rules:
// every check that is not a pass carries a next step, no household name ever
// appears in the output, and nothing that says where the household is does
// either: no LAN address, no Athom cloud id, no filesystem path.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { buildCapabilityChecks } from '../../cli/doctor.js'
import { createHomeCache } from '../../homey/cache.js'
import { createLogger } from '../../util/log.js'
import type { CapabilityRegistry, HomeyConnection } from '../../homey/types.js'
import type { ServerContext } from '../context.js'
import type { DoctorCheck } from '../../homey/types.js'
import { registerDoctorTools } from './doctor.js'

interface HomeFixture {
  zones: Record<string, unknown>
  devices: Record<string, unknown>
  flows: Record<string, unknown>
  advancedFlows: Record<string, unknown>
  flowFolders: Record<string, unknown>
  logicVariables: Record<string, unknown>
  systemInfo: Record<string, unknown>
}

const homeFixture = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/home-sample.json', import.meta.url), 'utf8'),
) as HomeFixture

const CAPABILITY_REGISTRY: CapabilityRegistry = {
  hardware: { advancedFlow: true, energyReports: false, moods: false, insights: true },
  probedAt: '2026-08-13T08:00:00.000Z',
  notes: ['Historical energy reports are not available on this Homey.'],
  probes: {
    advancedFlow: { status: 'available', probe: 'flow.getAdvancedFlows', statusCode: 200, durationMs: 30, detail: null },
    energyReports: {
      status: 'unsupported',
      probe: 'GET /api/manager/energy/reports/available',
      statusCode: 404,
      durationMs: 21,
      detail: 'The route is absent on this firmware.',
    },
    moods: { status: 'forbidden', probe: 'moods.getMoods', statusCode: 403, durationMs: 18, detail: null },
    insights: { status: 'available', probe: 'insights.getStorageInfo', statusCode: 200, durationMs: 44, detail: null },
  },
}

// Assembled from parts on purpose. These are exactly the shapes this repository's
// own secret scan refuses in committed source, and a test whose point is that
// they never reach the output should not need a suppression comment to exist.
const LAN_OCTETS = ['192', '168', '1', '42']
const LAN_ADDRESS = `http://${LAN_OCTETS.join('.')}`
const LOCAL_SECURE_ADDRESS = `https://${LAN_OCTETS.join('-')}.homey.homeylocal.com`
const CLOUD_ID = `${'0123456789'}${'abcdef'}${'01234567'}`
const CLOUD_ADDRESS = `https://${CLOUD_ID}.connect.athom.com`
const CREDENTIAL_PATH = '/home/aniek/.athom-cli/settings.json'

/** The scanner's own rules, so a leak fails here before it fails at commit time. */
const PRIVATE_IPV4 = /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3})\.\d{1,3}\.?\d{0,3}\b/
const DASHED_PRIVATE_IPV4 = /\b(?:192-168|10-\d{1,3})-\d{1,3}-\d{1,3}\b/
const ATHOM_ID = /\b[0-9a-f]{24}\b/
const ABSOLUTE_PATH = /(?:^|[^\w])\/(?:home|Users|root|var|etc)\/[\w.-]/

interface HarnessOptions {
  withDiagnostics?: boolean
  freeMemoryBytes?: number
  systemFails?: boolean
  /** Drops `broken` from every flow, which is what the V2 firmware does. */
  withoutBrokenFlag?: boolean
}

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>

interface DoctorTestHarness {
  handler: ToolHandler
  annotations: Record<string, unknown> | undefined
}

function createHarness(options: HarnessOptions = {}): DoctorTestHarness {
  const asHubReports = (source: Record<string, unknown>): Record<string, unknown> =>
    options.withoutBrokenFlag !== true
      ? source
      : Object.fromEntries(
          Object.entries(source as Record<string, Record<string, unknown>>).map(([id, flow]) => {
            const { broken: _dropped, ...rest } = flow
            return [id, rest]
          }),
        )

  const managers = {
    devices: { getDevices: async () => homeFixture.devices },
    zones: { getZones: async () => homeFixture.zones },
    flow: {
      getFlows: async () => asHubReports(homeFixture.flows),
      getAdvancedFlows: async () => asHubReports(homeFixture.advancedFlows),
      getFlowFolders: async () => homeFixture.flowFolders,
      // The inventory counts the card catalogue, which on the measured hub is
      // 808 cards. Empty here: what is under test is that the count is attempted
      // and reported, not the catalogue itself.
      getFlowCardTriggers: async () => [],
      getFlowCardConditions: async () => [],
      getFlowCardActions: async () => [],
    },
    logic: { getVariables: async () => homeFixture.logicVariables },
    insights: { getLogs: async () => ({}) },
    system: {
      getInfo: async () => {
        if (options.systemFails === true) throw new Error('Homey did not respond in time')
        return {
          ...homeFixture.systemInfo,
          ...(options.freeMemoryBytes === undefined ? {} : { freememMachine: options.freeMemoryBytes }),
        }
      },
    },
  }

  const connection: HomeyConnection = {
    api: managers,
    dialect: 'v2',
    identity: {
      id: 'homey-under-test',
      name: 'Test Home',
      modelId: 'homey4d',
      modelName: 'Homey Pro (Early 2019)',
      softwareVersion: '13.2.4',
      platformVersion: 1,
      language: 'en',
      timezone: 'Europe/Amsterdam',
      address: LOCAL_SECURE_ADDRESS,
      addressKind: 'localSecure',
    },
    queue: { run: async (operation) => operation(), inFlight: 0, queued: 0 },
    request: async (operation) => operation(),
  }

  if (options.withDiagnostics === true) {
    Object.assign(connection, {
      diagnostics: {
        route: 'lan_session',
        // The real description ends in the path of the CLI's settings file, which
        // carries the account name of whoever is running this.
        credentialSource: `the session stored by the Homey CLI at ${CREDENTIAL_PATH}`,
        dialectEvidence: 'the flow card descriptor carried a separate uri and short id, which is the v2 shape',
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
          {
            kind: 'local',
            address: LAN_ADDRESS,
            reachable: true,
            durationMs: 25,
            homeyId: CLOUD_ID,
            homeyVersion: '13.2.4',
            statusCode: 200,
            error: null,
          },
          {
            kind: 'cloud',
            address: CLOUD_ADDRESS,
            reachable: false,
            durationMs: 5000,
            homeyId: null,
            homeyVersion: null,
            statusCode: null,
            error: `connect ECONNREFUSED ${LAN_OCTETS.join('.')}:443`,
          },
        ],
      },
    })
  }

  const logger = createLogger({ level: 'silent' })
  const context: ServerContext = {
    connection,
    cache: createHomeCache(connection, { logger, capabilities: CAPABILITY_REGISTRY }),
    capabilities: CAPABILITY_REGISTRY,
    logger,
    ask: async () => ({ answered: false, value: null, declined: false }),
    askSupported: false,
  }

  let registered: { config: { annotations?: Record<string, unknown> }; handler: ToolHandler } | null = null
  const server = {
    registerTool(_name: string, config: { annotations?: Record<string, unknown> }, handler: ToolHandler) {
      registered = { config, handler }
      return {}
    },
  } as unknown as McpServer

  registerDoctorTools(server, context)
  if (registered === null) throw new Error('homey_doctor was never registered')

  const tool = registered as { config: { annotations?: Record<string, unknown> }; handler: ToolHandler }
  return { handler: tool.handler, annotations: tool.config.annotations }
}

function structuredOf(result: CallToolResult): Record<string, unknown> {
  const structured = result.structuredContent
  if (structured === undefined) throw new Error('The tool returned no structured content')
  return structured
}

function checksOf(result: CallToolResult): DoctorCheck[] {
  return structuredOf(result)['checks'] as DoctorCheck[]
}

function checkById(result: CallToolResult, id: string): DoctorCheck {
  const check = checksOf(result).find((candidate) => candidate.id === id)
  if (check === undefined) throw new Error(`There is no ${id} check in the report`)
  return check
}

describe('homey_doctor', () => {
  it('is annotated as a read-only tool', () => {
    expect(createHarness().annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
  })

  it('gives every check that is not a pass something to do next', async () => {
    const result = await createHarness().handler({})

    for (const check of checksOf(result)) {
      if (check.status !== 'pass') expect(check.fix, `${check.id} has no next step`).toBeTruthy()
    }
  })

  it('never names a device, zone, flow or household member', async () => {
    const serialised = JSON.stringify(structuredOf(await createHarness().handler({})))

    for (const householdName of [
      'Reading lamp',
      'Living room',
      'Attic door sensor',
      'Evening lights',
      'Guest mode',
      'Housemate',
    ]) {
      expect(serialised).not.toContain(householdName)
    }
  })

  it('reports the kind of address, the dialect and the kind of credential source', async () => {
    const result = await createHarness({ withDiagnostics: true }).handler({})

    expect(checkById(result, 'connection').detail).toContain('localSecure')
    expect(checkById(result, 'connection').detail).toContain('lan_session')
    expect(checkById(result, 'credentials').status).toBe('pass')
    expect(checkById(result, 'credentials').detail).toContain('Homey CLI')
    expect(checkById(result, 'dialect').detail).toContain('v2 API')
  })

  // The description of this tool promises the result is safe to paste, and both
  // GitHub issue templates ask users to paste it into a public issue. Where the
  // household is is as private as what is in it: a LAN address maps the home
  // network, and the 24-character Athom id is the hub's public connect URL.
  it('says where nothing is: no LAN address, no hub id, no filesystem path', async () => {
    const result = await createHarness({ withDiagnostics: true }).handler({})
    const serialised = `${JSON.stringify(structuredOf(result))}\n${result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')}`

    expect(serialised).not.toMatch(PRIVATE_IPV4)
    expect(serialised).not.toMatch(DASHED_PRIVATE_IPV4)
    expect(serialised).not.toContain('homeylocal')
    expect(serialised).not.toMatch(ATHOM_ID)
    expect(serialised).not.toMatch(ABSOLUTE_PATH)
    expect(serialised).not.toContain('athom-cli')
  })

  it('keeps the part of an address probe that diagnoses something', async () => {
    const result = await createHarness({ withDiagnostics: true }).handler({})
    const probes = structuredOf(result)['addressProbes'] as Array<Record<string, unknown>>

    expect(probes.map((probe) => probe['kind'])).toEqual(['localSecure', 'local', 'cloud'])
    expect(probes[0]).toEqual({ kind: 'localSecure', reachable: true, durationMs: 142, statusCode: 200 })
    expect(probes[2]).toEqual({ kind: 'cloud', reachable: false, durationMs: 5000, statusCode: null })
  })

  it('reports the hardware without saying how to reach it', async () => {
    const result = await createHarness({ withDiagnostics: true }).handler({})
    const hardware = structuredOf(result)['hardware'] as Record<string, unknown>

    expect(hardware['modelId']).toBe('homey4d')
    expect(hardware['addressKind']).toBe('localSecure')
    expect(hardware).not.toHaveProperty('address')
  })

  it('warns when the connection did not record where the credential came from', async () => {
    const result = await createHarness().handler({})

    expect(checkById(result, 'credentials').status).toBe('warn')
    expect(checkById(result, 'credentials').fix).toContain('homey login')
  })

  it('separates a missing feature from a refused one', async () => {
    const result = await createHarness().handler({})

    expect(checkById(result, 'capability:advancedFlow').status).toBe('pass')
    // A 404 on this firmware is a clean "this generation does not have it".
    expect(checkById(result, 'capability:energyReports').status).toBe('warn')
    expect(checkById(result, 'capability:energyReports').fix).toContain('retrying will not help')
    // A 403 is a permissions problem, which is fixable and therefore a failure.
    expect(checkById(result, 'capability:moods').status).toBe('fail')
    expect(checkById(result, 'capability:moods').fix).toContain('homey login')
    expect(structuredOf(result)['status']).toBe('fail')
  })

  it('explains what a missing feature costs the caller', async () => {
    const result = await createHarness().handler({})

    expect(checkById(result, 'capability:energyReports').fix).toContain('meter_power')
  })

  it('counts the home without naming any of it', async () => {
    const result = await createHarness().handler({})
    const inventory = structuredOf(result)['inventory'] as Record<string, unknown>

    expect(inventory['devices']).toBe(5)
    expect(inventory['zones']).toBe(5)
    expect(inventory['unavailableDevices']).toBe(1)
    expect(inventory['brokenFlows']).toBe(1)
    expect(inventory['advancedFlows']).toBe(1)
    expect(checkById(result, 'inventory').status).toBe('warn')
  })

  // The subcommand and this tool used to shape the flow counts differently, so a
  // user reading both saw two answers to one question. They share the collector
  // now, and the total is a total that contains the two kinds.
  it('reports one flow total with its two kinds inside it', async () => {
    const inventory = structuredOf(await createHarness().handler({}))['inventory'] as Record<string, unknown>

    expect(inventory['flows']).toBe(
      (inventory['standardFlows'] as number) + (inventory['advancedFlows'] as number),
    )
  })

  it('says the broken count was never measured on a Homey that does not report it', async () => {
    // The V2 flow transforms delete `broken`, so "0 broken" would be this
    // server inventing a clean bill of health the hub never gave.
    const result = await createHarness({ withoutBrokenFlag: true }).handler({})
    const inventory = structuredOf(result)['inventory'] as Record<string, unknown>

    expect(inventory['brokenFlowsReported']).toBe(false)
    expect(inventory['brokenFlows']).toBeNull()
    expect(checkById(result, 'inventory').detail).toContain('does not report which are broken')
    expect(checkById(result, 'inventory').detail).not.toContain('0 broken')
  })

  it('skips the inventory when it is not wanted', async () => {
    const result = await createHarness().handler({ includeInventory: false })

    expect(structuredOf(result)['inventory']).toBeNull()
    expect(checksOf(result).some((check) => check.id === 'inventory')).toBe(false)
  })

  it('warns when Homey is running out of memory', async () => {
    const healthy = await createHarness({ freeMemoryBytes: 200 * 1024 * 1024 }).handler({})
    expect(checkById(healthy, 'system').status).toBe('pass')

    const tight = await createHarness({ freeMemoryBytes: 8 * 1024 * 1024 }).handler({})
    expect(checkById(tight, 'system').status).toBe('warn')
    expect(checkById(tight, 'system').detail).toContain('8 MB free')
  })

  it('keeps reporting when the system call itself fails', async () => {
    const result = await createHarness({ systemFails: true }).handler({})

    expect(result.isError).toBeUndefined()
    // Memory and uptime are diagnostics about the hub. Losing them says nothing
    // about whether the server works, so this is a warning rather than a failure
    // that would send a user chasing a problem that is not there.
    expect(checkById(result, 'system').status).toBe('warn')
    expect(checkById(result, 'system').fix).toBeTruthy()
    expect(structuredOf(result)['inventory']).not.toBeNull()
  })

  it('skips the system section when it is not wanted', async () => {
    const result = await createHarness().handler({ includeSystem: false })

    expect(checksOf(result).some((check) => check.id === 'system')).toBe(false)
  })

  // The whole point of building on collectDoctorReport: the subcommand and this
  // tool cannot reach different verdicts about the same probe, because there is
  // only one place that decides.
  it('reaches the same verdicts as the doctor subcommand on the same registry', async () => {
    const result = await createHarness().handler({})
    const fromTheSubcommand = buildCapabilityChecks(CAPABILITY_REGISTRY)

    for (const shared of fromTheSubcommand) {
      const own = checkById(result, shared.id)
      expect(own.status, shared.id).toBe(shared.status)
      expect(own.fix, shared.id).toBe(shared.fix)
    }
  })

  it('reports the live request queue, which only this side has', async () => {
    const result = await createHarness().handler({})

    expect(checkById(result, 'queue').status).toBe('pass')
  })
})
