// Two things decide whether these tools are safe to hand a model: the
// projection, which keeps a 4 KB device record from becoming context, and the
// value coercion, which decides what actually gets sent to the house.
//
// The percentage trap is the sharp edge. `dim` reports `units: "%"` with a range
// of 0 to 1, so "dim to 60 percent" arrives as 60. Clamping that to 1 would turn
// a dim request into full brightness, so the request is refused with the number
// that would have been right.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { createHomeCache } from '../../homey/cache.js'
import { createLogger } from '../../util/log.js'
import type { AskOptions, AskResult, ServerContext } from '../context.js'
import type { CapabilityRegistry, HomeyConnection } from '../../homey/types.js'
import { registerDevicesTools } from './devices.js'

// ---------------------------------------------------------------------------
// Fixture and harness
// ---------------------------------------------------------------------------

interface HomeFixture {
  zones: Record<string, unknown>
  devices: Record<string, unknown>
  flows: Record<string, unknown>
  advancedFlows: Record<string, unknown>
  flowFolders: Record<string, unknown>
  logicVariables: Record<string, unknown>
}

const homeFixture = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/home-sample.json', import.meta.url), 'utf8'),
) as HomeFixture

interface CapabilityWrite {
  deviceId: string
  capabilityId: string
  value: boolean | number | string
}

/**
 * The Insights catalogue as it arrives after `Log.transformGet`: an `ownerUri`
 * and a fully qualified `id`, with the raw `uri` and `uriObj` already deleted.
 * Two logs on the bedroom radiator, one on the reading lamp, so a filter that
 * forgets the owner is visible immediately.
 */
const INSIGHTS_LOG_CATALOGUE: Record<string, unknown> = {
  'homey:device:aaaaaaaa-0002-4000-8000-000000000002:measure_temperature': {
    ownerUri: 'homey:device:aaaaaaaa-0002-4000-8000-000000000002',
    id: 'homey:device:aaaaaaaa-0002-4000-8000-000000000002:measure_temperature',
    title: 'Temperature',
    type: 'number',
    units: '°C',
    decimals: 2,
    lastValue: 19.5,
  },
  'homey:device:aaaaaaaa-0002-4000-8000-000000000002:target_temperature': {
    ownerUri: 'homey:device:aaaaaaaa-0002-4000-8000-000000000002',
    id: 'homey:device:aaaaaaaa-0002-4000-8000-000000000002:target_temperature',
    title: 'Target temperature',
    type: 'number',
    units: '°C',
    decimals: 1,
    lastValue: 21,
  },
  'homey:device:aaaaaaaa-0001-4000-8000-000000000001:dim': {
    ownerUri: 'homey:device:aaaaaaaa-0001-4000-8000-000000000001',
    id: 'homey:device:aaaaaaaa-0001-4000-8000-000000000001:dim',
    title: 'Dim level',
    type: 'number',
    units: '%',
    decimals: 2,
    lastValue: 0.6,
  },
  'homey:manager:weather:temperature': {
    ownerUri: 'homey:manager:weather',
    id: 'homey:manager:weather:temperature',
    title: 'Outside temperature',
    type: 'number',
    units: '°C',
    decimals: 1,
    lastValue: 21.6,
  },
}

/**
 * The devices as a live hub returns them: `Device.transformGet` has already
 * deleted the per-device `insights` array, so nothing can be read off it.
 */
function withoutTheDeviceInsightsArray(devices: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(devices as Record<string, Record<string, unknown>>).map(([id, device]) => {
      const { insights: _deletedByTheLibrary, ...rest } = device
      return [id, rest]
    }),
  )
}

interface HarnessOptions {
  askSupported?: boolean
  ask?: (options: AskOptions) => Promise<AskResult>
  getDevices?: () => Promise<unknown>
  getInsightsLogs?: () => Promise<unknown>
  getFlows?: () => Promise<unknown>
  getAdvancedFlows?: () => Promise<unknown>
  capabilities?: CapabilityRegistry
}

/** Every flow as the V2 firmware returns it: both flow transforms delete `broken`. */
function withoutTheBrokenFlag(flows: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(flows as Record<string, Record<string, unknown>>).map(([id, flow]) => {
      const { broken: _deletedByTheLibrary, ...rest } = flow
      return [id, rest]
    }),
  )
}

interface DeviceTestHarness {
  context: ServerContext
  capabilityWrites: CapabilityWrite[]
  variableWrites: Array<{ id: string; value: boolean | number | string }>
  variablesCreated: Array<{ name: string; type: string; value: unknown }>
  flowStarts: Array<{ id: string; kind: string }>
  invalidatedCollections: Array<string | undefined>
  tools: Map<string, RegisteredTestTool>
}

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>

interface RegisteredTestTool {
  config: { annotations?: Record<string, unknown> }
  handler: ToolHandler
}

const CAPABILITY_REGISTRY: CapabilityRegistry = {
  hardware: { advancedFlow: true, energyReports: false, moods: false, insights: true },
  probedAt: '2026-08-13T08:00:00.000Z',
  notes: [],
}

function createHarness(options: HarnessOptions = {}): DeviceTestHarness {
  const capabilityWrites: CapabilityWrite[] = []
  const variableWrites: Array<{ id: string; value: boolean | number | string }> = []
  const variablesCreated: Array<{ name: string; type: string; value: unknown }> = []
  const flowStarts: Array<{ id: string; kind: string }> = []
  const invalidatedCollections: Array<string | undefined> = []

  const managers = {
    devices: {
      getDevices: options.getDevices ?? (async () => homeFixture.devices),
      setCapabilityValue: async (write: CapabilityWrite) => {
        capabilityWrites.push(write)
        return {}
      },
    },
    zones: { getZones: async () => homeFixture.zones },
    flow: {
      getFlows: options.getFlows ?? (async () => homeFixture.flows),
      getAdvancedFlows: options.getAdvancedFlows ?? (async () => homeFixture.advancedFlows),
      getFlowFolders: async () => homeFixture.flowFolders,
      triggerFlow: async ({ id }: { id: string }) => {
        flowStarts.push({ id, kind: 'standard' })
        return {}
      },
      triggerAdvancedFlow: async ({ id }: { id: string }) => {
        flowStarts.push({ id, kind: 'advanced' })
        return {}
      },
    },
    logic: {
      getVariables: async () => homeFixture.logicVariables,
      updateVariable: async ({ id, variable }: { id: string; variable: { value: boolean | number | string } }) => {
        variableWrites.push({ id, value: variable.value })
        return {}
      },
      createVariable: async ({ variable }: { variable: { name: string; type: string; value: boolean | number | string } }) => {
        variablesCreated.push(variable)
        return { id: 'created-variable-id', ...variable }
      },
    },
    insights: { getLogs: options.getInsightsLogs ?? (async () => INSIGHTS_LOG_CATALOGUE) },
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
      address: 'https://homey.example.invalid',
      addressKind: 'local',
    },
    queue: { run: async (operation) => operation(), inFlight: 0, queued: 0 },
    request: async (operation) => operation(),
  }

  const logger = createLogger({ level: 'silent' })
  const capabilities = options.capabilities ?? CAPABILITY_REGISTRY
  const cache = createHomeCache(connection, { logger, capabilities })
  const originalInvalidate = cache.invalidate.bind(cache)

  const context: ServerContext = {
    connection,
    cache: {
      ...cache,
      invalidate: (collection) => {
        invalidatedCollections.push(collection)
        originalInvalidate(collection)
      },
    },
    capabilities,
    logger,
    ask: options.ask ?? (async () => ({ answered: false, value: null, declined: false })),
    askSupported: options.askSupported === true,
  }

  const tools = new Map<string, RegisteredTestTool>()
  const server = {
    registerTool(name: string, config: RegisteredTestTool['config'], handler: ToolHandler) {
      tools.set(name, { config, handler })
      return {}
    },
  } as unknown as McpServer

  registerDevicesTools(server, context)

  return { context, capabilityWrites, variablesCreated, variableWrites, flowStarts, invalidatedCollections, tools }
}

function takeTool(harness: DeviceTestHarness, name: string): RegisteredTestTool {
  const tool = harness.tools.get(name)
  if (tool === undefined) throw new Error(`The tool ${name} was never registered`)
  return tool
}

function structuredOf(result: CallToolResult): Record<string, unknown> {
  const structured = result.structuredContent
  if (structured === undefined) throw new Error('The tool returned no structured content')
  return structured
}

/**
 * The error half of a failed tool result.
 *
 * Failures come back as `isError` results carrying `{ ok: false, error: {...} }`
 * rather than as thrown protocol errors, so the model can read the reason and
 * correct itself.
 */
function failureOf(result: CallToolResult): Record<string, unknown> {
  return (structuredOf(result)['error'] ?? {}) as Record<string, unknown>
}

function devicesOf(result: CallToolResult): Array<Record<string, unknown>> {
  return structuredOf(result)['devices'] as Array<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// homey_devices_search
// ---------------------------------------------------------------------------

describe('homey_devices_search', () => {
  it('registers every tool this module owns', () => {
    const harness = createHarness()
    expect([...harness.tools.keys()].sort()).toEqual([
      'homey_device_get',
      'homey_device_set_capability',
      'homey_devices_search',
      'homey_flow_start',
      'homey_variable_create',
      'homey_variable_set',
    ])
  })

  it('marks the writes destructive and the reads read-only', () => {
    const harness = createHarness()
    expect(takeTool(harness, 'homey_devices_search').config.annotations?.['readOnlyHint']).toBe(true)
    expect(takeTool(harness, 'homey_device_get').config.annotations?.['readOnlyHint']).toBe(true)

    for (const name of ['homey_device_set_capability', 'homey_variable_set', 'homey_flow_start']) {
      expect(takeTool(harness, name).config.annotations?.['destructiveHint']).toBe(true)
      expect(takeTool(harness, name).config.annotations?.['readOnlyHint']).toBe(false)
    }

    // Writing the same value again lands in the same place; starting a flow runs
    // its actions again every single time.
    expect(takeTool(harness, 'homey_device_set_capability').config.annotations?.['idempotentHint']).toBe(true)
    expect(takeTool(harness, 'homey_variable_set').config.annotations?.['idempotentHint']).toBe(true)
    expect(takeTool(harness, 'homey_flow_start').config.annotations?.['idempotentHint']).toBe(false)
  })

  it('strips the protocol settings, artwork and interface layout from every result', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_devices_search').handler({ includeCapabilitySummaries: true })

    const serialised = JSON.stringify(structuredOf(result))
    for (const forbidden of ['passwd', 'iconObj', 'images', 'componentsStartAt', 'internalReference', 'capabilitiesObj']) {
      expect(serialised).not.toContain(forbidden)
    }
    // The projection is what keeps a 26-device home inside a sane context budget.
    expect(serialised.length).toBeLessThan(4000)
  })

  it('filters by zone name and, on request, by the zones below it', async () => {
    const harness = createHarness()
    const search = takeTool(harness, 'homey_devices_search').handler

    const livingRoomOnly = await search({ zone: 'Living room' })
    expect(devicesOf(livingRoomOnly).map((device) => device['name']).sort()).toEqual([
      'Meter cupboard plug',
      'Reading lamp',
    ])

    const withChildren = await search({ zone: 'Living room', includeChildZones: true })
    expect(devicesOf(withChildren).map((device) => device['name']).sort()).toEqual([
      'Meter cupboard plug',
      'Nook speaker',
      'Reading lamp',
    ])
  })

  it('matches a capability prefix so a sub-capability is still found', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_devices_search').handler({ capability: 'meter_power' })

    expect(devicesOf(result)).toHaveLength(1)
    expect(devicesOf(result)[0]?.['name']).toBe('Meter cupboard plug')
  })

  it('matches the class the owner sees rather than the declared one', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_devices_search').handler({ deviceClass: 'socket' })

    expect(devicesOf(result)[0]?.['name']).toBe('Meter cupboard plug')
    expect(devicesOf(result)[0]?.['declaredClass']).toBe('other')
  })

  it('filters on reachability and name', async () => {
    const harness = createHarness()
    const search = takeTool(harness, 'homey_devices_search').handler

    expect(devicesOf(await search({ available: false }))[0]?.['name']).toBe('Attic door sensor')
    expect(devicesOf(await search({ nameContains: 'READING' }))[0]?.['name']).toBe('Reading lamp')
  })

  it('pages client side and reports that more remain', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_devices_search').handler({ limit: 2, offset: 0 })

    expect(structuredOf(result)['totalMatches']).toBe(5)
    expect(structuredOf(result)['returned']).toBe(2)
    expect(structuredOf(result)['truncated']).toBe(true)

    const lastPage = await takeTool(harness, 'homey_devices_search').handler({ limit: 2, offset: 4 })
    expect(structuredOf(lastPage)['truncated']).toBe(false)
  })

  it('omits capability summaries unless they are asked for', async () => {
    const harness = createHarness()
    const withoutValues = await takeTool(harness, 'homey_devices_search').handler({ nameContains: 'lamp' })
    const withValues = await takeTool(harness, 'homey_devices_search').handler({
      nameContains: 'lamp',
      includeCapabilitySummaries: true,
    })

    expect(devicesOf(withoutValues)[0]?.['capabilitySummaries']).toBeUndefined()
    const values = devicesOf(withValues)[0]?.['capabilitySummaries'] as Record<string, Record<string, unknown>>
    expect(values['dim']).toEqual({ title: 'Dim level', value: 0.35, units: '%', setable: true })
  })

  it('does not call its four-field projection by the name homey_device_get uses for the full record', async () => {
    // One name meant two shapes: four fields here and fourteen from
    // homey_device_get, both under `capabilityValues`, so anything reading
    // `capabilityValues.dim.max` worked against one tool and read undefined
    // against the other. Two shapes, two names, and the range only exists on
    // the full record.
    const harness = createHarness()
    const searched = await takeTool(harness, 'homey_devices_search').handler({
      nameContains: 'lamp',
      includeCapabilitySummaries: true,
    })
    const summarised = devicesOf(searched)[0] as Record<string, unknown>
    expect(summarised['capabilityValues']).toBeUndefined()

    const fetched = await takeTool(harness, 'homey_device_get').handler({ device: 'Reading lamp' })
    const detailed = structuredOf(fetched)['device'] as Record<string, unknown>
    expect(detailed['capabilitySummaries']).toBeUndefined()
    const full = (detailed['capabilityValues'] as Record<string, Record<string, unknown>>)['dim']
    expect(full?.['max']).toBe(1)
  })

  it('names the match count the way every other search tool names it', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_devices_search').handler({ limit: 2 })

    const structured = structuredOf(result)
    expect(structured['total']).toBeUndefined()
    expect(structured['totalMatches']).toBeGreaterThan(2)
    expect(structured['returned']).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// homey_device_get
// ---------------------------------------------------------------------------

describe('homey_device_get', () => {
  it('takes the reference under the name homey_devices_search reports it as', async () => {
    // Search answers with "id", so that is the name a caller is holding when
    // it arrives here. Guessing "deviceId" cost a round trip in a real session,
    // and a round trip for a synonym is a round trip for nothing.
    const harness = createHarness()

    const byDevice = await takeTool(harness, 'homey_device_get').handler({ device: 'Bedroom radiator' })
    const byDeviceId = await takeTool(harness, 'homey_device_get').handler({ deviceId: 'Bedroom radiator' })

    expect(byDeviceId.isError).toBeFalsy()
    expect(structuredOf(byDeviceId)).toEqual(structuredOf(byDevice))
  })

  it('says which argument to send when neither is given', async () => {
    const harness = createHarness()

    const result = await takeTool(harness, 'homey_device_get').handler({})

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('deviceId')
  })
  it('returns the full capability descriptor including the range to set within', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_device_get').handler({ device: 'Bedroom radiator' })

    const device = structuredOf(result)['device'] as Record<string, unknown>
    const capabilities = device['capabilityValues'] as Record<string, Record<string, unknown>>

    expect(capabilities['target_temperature']?.['min']).toBe(5)
    expect(capabilities['target_temperature']?.['max']).toBe(25)
    expect(capabilities['target_temperature']?.['step']).toBe(0.5)
    expect(capabilities['measure_temperature']?.['setable']).toBe(false)
    expect(capabilities['thermostat_mode']?.['values']).toEqual([
      { id: 'auto', title: 'Automatic' },
      { id: 'heat', title: 'Heating' },
      { id: 'off', title: 'Off' },
    ])
  })

  it('reports the energy block and flags a cumulative meter', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_device_get').handler({ device: 'Meter cupboard plug' })

    const device = structuredOf(result)['device'] as Record<string, unknown>
    expect(device['energy']).toEqual({
      watts: -134,
      cumulative: true,
      batteries: null,
      isHomeBattery: false,
      isElectricCar: false,
      isEvCharger: false,
      isGenerator: false,
    })
  })

  // The device record itself cannot answer this. `Device.transformGet` deletes
  // the per-device `insights` array on both dialects, so on a live hub the tool
  // advertised "which Insights logs exist for it" and then listed none. The
  // catalogue still knows: every log carries the URI of its owner.
  it('lists the Insights logs of a device the hub stripped the insights array from', async () => {
    const harness = createHarness({ getDevices: async () => withoutTheDeviceInsightsArray(homeFixture.devices) })
    const result = await takeTool(harness, 'homey_device_get').handler({ device: 'Bedroom radiator' })

    const device = structuredOf(result)['device'] as Record<string, unknown>
    const insights = device['insights'] as Array<Record<string, unknown>>
    expect(insights.map((entry) => entry['logId']).sort()).toEqual([
      'homey:device:aaaaaaaa-0002-4000-8000-000000000002:measure_temperature',
      'homey:device:aaaaaaaa-0002-4000-8000-000000000002:target_temperature',
    ])
    expect(device['insightCount']).toBe(2)
    expect(device['insightsUnavailableReason']).toBeUndefined()
  })

  it('takes only the logs this device owns, not the whole catalogue', async () => {
    const harness = createHarness({ getDevices: async () => withoutTheDeviceInsightsArray(homeFixture.devices) })
    const result = await takeTool(harness, 'homey_device_get').handler({ device: 'Reading lamp' })

    const device = structuredOf(result)['device'] as Record<string, unknown>
    const insights = device['insights'] as Array<Record<string, unknown>>
    expect(insights.map((entry) => entry['logId'])).toEqual(['homey:device:aaaaaaaa-0001-4000-8000-000000000001:dim'])
  })

  it('names a device\'s history the way homey_insights_query names it, and only that way', async () => {
    // The documented path from a device to its own history was broken. This
    // tool emitted the owner uri and the short id as two fields, while
    // homey_insights_query resolves against the composite "<uri>:<id>" that
    // homey_insights_search already returns as logId. Neither half on its own
    // is a value the query tool accepts, so the pair is gone rather than kept
    // beside the identifier that works.
    const harness = createHarness({ getDevices: async () => withoutTheDeviceInsightsArray(homeFixture.devices) })
    const result = await takeTool(harness, 'homey_device_get').handler({ device: 'Reading lamp' })

    const device = structuredOf(result)['device'] as Record<string, unknown>
    const log = (device['insights'] as Array<Record<string, unknown>>)[0]!

    // Exactly what the cache keys the log under, which is what the Insights
    // tools resolve against.
    const catalogue = await harness.context.cache.getInsightsLogs()
    expect(catalogue.byId.has(String(log['logId']))).toBe(true)

    expect(log['uri']).toBeUndefined()
    expect(log['id']).toBeUndefined()
  })

  it('still describes the device when the Insights catalogue cannot be read', async () => {
    const harness = createHarness({
      getDevices: async () => withoutTheDeviceInsightsArray(homeFixture.devices),
      getInsightsLogs: async () => {
        throw new Error('Too many requests')
      },
    })
    const result = await takeTool(harness, 'homey_device_get').handler({ device: 'Bedroom radiator' })

    expect(result.isError).toBeUndefined()
    const device = structuredOf(result)['device'] as Record<string, unknown>
    expect(device['name']).toBe('Bedroom radiator')
    expect(device['insights']).toEqual([])
    expect(typeof device['insightsUnavailableReason']).toBe('string')
  })

  it('still lists a device\'s history when the Insights probe never settled the question', async () => {
    // The probe answers three things, and only `false` is a verdict about the
    // hub. A probe that failed or was refused leaves this null, and reading the
    // value for truth turned that into a refusal with a sentence about the
    // probe, hiding history the hub answers for perfectly well. The catalogue
    // read below is the honest way to find out.
    const harness = createHarness({
      getDevices: async () => withoutTheDeviceInsightsArray(homeFixture.devices),
      capabilities: { ...CAPABILITY_REGISTRY, hardware: { ...CAPABILITY_REGISTRY.hardware, insights: null } },
    })
    const result = await takeTool(harness, 'homey_device_get').handler({ device: 'Bedroom radiator' })

    const device = structuredOf(result)['device'] as Record<string, unknown>
    expect(device['insightsUnavailableReason']).toBeUndefined()
    expect((device['insights'] as unknown[]).length).toBe(2)
  })

  it('says the hub has no Insights only when the hub answered that it has none', async () => {
    const harness = createHarness({
      getDevices: async () => withoutTheDeviceInsightsArray(homeFixture.devices),
      capabilities: { ...CAPABILITY_REGISTRY, hardware: { ...CAPABILITY_REGISTRY.hardware, insights: false } },
    })
    const result = await takeTool(harness, 'homey_device_get').handler({ device: 'Bedroom radiator' })

    const device = structuredOf(result)['device'] as Record<string, unknown>
    expect(device['insights']).toEqual([])
    expect(String(device['insightsUnavailableReason'])).toContain('does not offer the Insights routes')
  })

  it('refuses to guess when a name matches several devices', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_device_get').handler({ device: 'o' })

    expect(result.isError).toBe(true)
    const candidates = (failureOf(result)['details'] as Record<string, unknown>)['candidates'] as unknown[]
    expect(candidates.length).toBeGreaterThan(1)
  })

  it('asks the user which device was meant when the client can ask', async () => {
    const askedQuestions: AskOptions[] = []
    const harness = createHarness({
      askSupported: true,
      ask: async (options) => {
        askedQuestions.push(options)
        return { answered: true, value: 'aaaaaaaa-0002-4000-8000-000000000002', declined: false }
      },
    })

    const result = await takeTool(harness, 'homey_device_get').handler({ device: 'o' })

    expect(askedQuestions).toHaveLength(1)
    expect((structuredOf(result)['device'] as Record<string, unknown>)['name']).toBe('Bedroom radiator')
  })

  it('says so when nothing matches', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_device_get').handler({ device: 'garden fountain' })

    expect(result.isError).toBe(true)
    expect(failureOf(result)['reason']).toBe('not_found')
  })
})

// ---------------------------------------------------------------------------
// homey_device_set_capability
// ---------------------------------------------------------------------------

describe('homey_device_set_capability', () => {
  it('refuses a percentage sent to a capability that takes a fraction, and names the right number', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_device_set_capability').handler({
      device: 'Reading lamp',
      capability: 'dim',
      value: 60,
    })

    expect(result.isError).toBe(true)
    expect(failureOf(result)['reason']).toBe('invalid_request')
    expect((failureOf(result)['details'] as Record<string, unknown>)['suggestedValue']).toBe(0.6)
    expect(harness.capabilityWrites).toHaveLength(0)
  })

  it('applies the same rule to volume_set on a different device class', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_device_set_capability').handler({
      device: 'Nook speaker',
      capability: 'volume_set',
      value: 40,
    })

    expect(result.isError).toBe(true)
    expect((failureOf(result)['details'] as Record<string, unknown>)['suggestedValue']).toBe(0.4)
  })

  it('accepts the fraction and sends a real JSON number', async () => {
    const harness = createHarness()
    await takeTool(harness, 'homey_device_set_capability').handler({
      device: 'Reading lamp',
      capability: 'dim',
      value: 0.6,
    })

    expect(harness.capabilityWrites).toEqual([
      { deviceId: 'aaaaaaaa-0001-4000-8000-000000000001', capabilityId: 'dim', value: 0.6 },
    ])
    expect(typeof harness.capabilityWrites[0]?.value).toBe('number')
  })

  it('turns a numeric string into a number rather than sending the string', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_device_set_capability').handler({
      device: 'Bedroom radiator',
      capability: 'target_temperature',
      value: '21.5',
    })

    expect(harness.capabilityWrites[0]?.value).toBe(21.5)
    expect(typeof harness.capabilityWrites[0]?.value).toBe('number')
    expect(structuredOf(result)['note']).toContain('21.5')
  })

  it('clamps a number to the range the device declares, and says it did', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_device_set_capability').handler({
      device: 'Bedroom radiator',
      capability: 'target_temperature',
      value: 30,
    })

    expect(harness.capabilityWrites[0]?.value).toBe(25)
    expect(structuredOf(result)['clamped']).toBe(true)
    expect(structuredOf(result)['requestedValue']).toBe(30)
    expect(structuredOf(result)['previousValue']).toBe(15)
  })

  it('accepts a boolean, and a string that plainly means one', async () => {
    const harness = createHarness()
    await takeTool(harness, 'homey_device_set_capability').handler({
      device: 'Reading lamp',
      capability: 'onoff',
      value: 'true',
    })

    expect(harness.capabilityWrites[0]?.value).toBe(true)
  })

  it('rejects a value an enum capability does not offer, and lists what it does', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_device_set_capability').handler({
      device: 'Bedroom radiator',
      capability: 'thermostat_mode',
      value: 'boost',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('auto, heat, off')
    expect(harness.capabilityWrites).toHaveLength(0)
  })

  it('refuses a capability that only reports, and points at the ones that can be set', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_device_set_capability').handler({
      device: 'Bedroom radiator',
      capability: 'measure_temperature',
      value: 20,
    })

    expect(result.isError).toBe(true)
    const details = failureOf(result)['details'] as Record<string, unknown>
    expect(details['setableCapabilities']).toEqual(['target_temperature', 'thermostat_mode'])
  })

  it('refuses a capability the device does not have', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_device_set_capability').handler({
      device: 'Reading lamp',
      capability: 'light_temperature',
      value: 0.5,
    })

    expect(result.isError).toBe(true)
    const details = failureOf(result)['details'] as Record<string, unknown>
    expect(details['availableCapabilities']).toEqual(['onoff', 'dim'])
  })

  it('does not write to a device Homey cannot currently reach', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_device_set_capability').handler({
      device: 'Attic door sensor',
      capability: 'alarm_contact',
      value: true,
    })

    expect(result.isError).toBe(true)
    expect(harness.capabilityWrites).toHaveLength(0)
  })

  it('drops the cached devices after a write so the next read is not stale', async () => {
    const harness = createHarness()
    await takeTool(harness, 'homey_device_set_capability').handler({
      device: 'Reading lamp',
      capability: 'onoff',
      value: true,
    })

    expect(harness.invalidatedCollections).toEqual(['devices'])
  })
})

// ---------------------------------------------------------------------------
// homey_variable_set
// ---------------------------------------------------------------------------

describe('homey_variable_set', () => {
  it('writes only the value, and reports what it replaced', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_variable_set').handler({
      variable: 'Comfort temperature',
      value: 21,
    })

    expect(harness.variableWrites).toEqual([{ id: 'eeeeeeee-0002-4000-8000-000000000002', value: 21 }])
    expect(structuredOf(result)['previousValue']).toBe(20.5)
    expect(harness.invalidatedCollections).toEqual(['logicVariables'])
  })

  it('holds each variable to its own type', async () => {
    const harness = createHarness()
    const setVariable = takeTool(harness, 'homey_variable_set').handler

    const wrongType = await setVariable({ variable: 'Guest mode', value: 'maybe' })
    expect(wrongType.isError).toBe(true)
    expect(failureOf(wrongType)['reason']).toBe('invalid_request')

    await setVariable({ variable: 'Guest mode', value: 'true' })
    expect(harness.variableWrites[0]?.value).toBe(true)

    await setVariable({ variable: 'Last message', value: 42 })
    expect(harness.variableWrites[1]?.value).toBe('42')
  })

  // The logicVariables probe was measured at startup and its consequence spelled
  // out in homey_doctor, but nothing acted on it: the write went to a hub that
  // had already said it has no such route, and came back as the firmware's own
  // much vaguer error.
  it('refuses to write on a hub whose logic route the probe found missing', async () => {
    const harness = createHarness({
      capabilities: {
        ...CAPABILITY_REGISTRY,
        probes: {
          logicVariables: {
            status: 'unsupported',
            probe: 'logic.getVariables',
            statusCode: 404,
            durationMs: 12,
            detail: null,
          },
        },
      },
    })

    const result = await takeTool(harness, 'homey_variable_set').handler({
      variable: 'Comfort temperature',
      value: 21,
    })

    expect(result.isError).toBe(true)
    expect(failureOf(result)['reason']).toBe('unsupported_hardware')
    expect(harness.variableWrites).toHaveLength(0)
  })

  it('names a refused session as a permissions problem rather than as missing hardware', async () => {
    const harness = createHarness({
      capabilities: {
        ...CAPABILITY_REGISTRY,
        probes: {
          logicVariables: {
            status: 'forbidden',
            probe: 'logic.getVariables',
            statusCode: 403,
            durationMs: 9,
            detail: 'the session is not allowed to read this, so support could not be confirmed',
          },
        },
      },
    })

    const result = await takeTool(harness, 'homey_variable_set').handler({
      variable: 'Comfort temperature',
      value: 21,
    })

    expect(failureOf(result)['reason']).toBe('missing_scope')
    expect(harness.variableWrites).toHaveLength(0)
  })

  it('still writes when the probe was inconclusive, rather than refusing on a maybe', async () => {
    const harness = createHarness({
      capabilities: {
        ...CAPABILITY_REGISTRY,
        probes: {
          logicVariables: {
            status: 'failed',
            probe: 'logic.getVariables',
            statusCode: null,
            durationMs: 5000,
            detail: 'the probe timed out',
          },
        },
      },
    })

    await takeTool(harness, 'homey_variable_set').handler({ variable: 'Comfort temperature', value: 21 })

    expect(harness.variableWrites).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// homey_flow_start
// ---------------------------------------------------------------------------

describe('homey_flow_start', () => {
  it('starts a standard flow through the standard route', async () => {
    const harness = createHarness()
    await takeTool(harness, 'homey_flow_start').handler({ flow: 'Evening lights' })

    expect(harness.flowStarts).toEqual([{ id: 'bbbbbbbb-0001-4000-8000-000000000001', kind: 'standard' }])
    expect(harness.invalidatedCollections).toEqual(['flows'])
  })

  it('starts an advanced flow through the advanced route', async () => {
    const harness = createHarness()
    await takeTool(harness, 'homey_flow_start').handler({ flow: 'Morning routine' })

    expect(harness.flowStarts).toEqual([{ id: 'bbbbbbbb-0004-4000-8000-000000000004', kind: 'advanced' }])
  })

  it('refuses a flow the firmware has marked broken', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_start').handler({ flow: 'Broken doorbell' })

    expect(result.isError).toBe(true)
    expect(harness.flowStarts).toHaveLength(0)
  })

  // `broken` is null on every flow of the measured hub, because both flow
  // transforms delete it. Reading that null as false meant the tool promised a
  // check it had not made: it said nothing at all and started the flow anyway.
  it('starts a flow whose broken flag this Homey never reported, and says the check did not happen', async () => {
    const harness = createHarness({
      getFlows: async () => withoutTheBrokenFlag(homeFixture.flows),
      getAdvancedFlows: async () => withoutTheBrokenFlag(homeFixture.advancedFlows),
    })

    const result = await takeTool(harness, 'homey_flow_start').handler({ flow: 'Broken doorbell' })

    expect(result.isError).toBeUndefined()
    expect(harness.flowStarts).toHaveLength(1)
    expect(structuredOf(result)['brokenReportedByHomey']).toBe(false)
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain(
      'does not report whether a flow is broken',
    )
  })

  it('says nothing about the broken flag on a Homey that does report it', async () => {
    const harness = createHarness()

    const result = await takeTool(harness, 'homey_flow_start').handler({ flow: 'Evening lights' })

    expect(structuredOf(result)['brokenReportedByHomey']).toBe(true)
    expect(result.content[0]?.type === 'text' && result.content[0].text).not.toContain('does not report')
  })

  it('starts a disabled flow but says that it would not have run on its own', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_start').handler({ flow: 'Holiday mode' })

    expect(harness.flowStarts).toHaveLength(1)
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('disabled')
    expect(structuredOf(result)['enabled']).toBe(false)
  })
})

describe('homey_variable_create', () => {
  // A logic variable is the answer when a person may want to see or change the
  // value, and its absence pushed a real design toward script tags instead,
  // which are invisible in the Homey app.
  it('creates one when the owner has confirmed', async () => {
    const harness = createHarness()

    const result = await takeTool(harness, 'homey_variable_create').handler({
      name: 'Airing advice',
      type: 'string',
      value: 'KIER',
      confirm: true,
    })

    expect(result.isError).toBeFalsy()
    expect(harness.variablesCreated).toEqual([{ name: 'Airing advice', type: 'string', value: 'KIER' }])
    expect(structuredOf(result)['variableId']).toBe('created-variable-id')
  })

  it('creates nothing without an explicit confirm', async () => {
    const harness = createHarness()

    const result = await takeTool(harness, 'homey_variable_create').handler({
      name: 'Airing advice',
      type: 'string',
      value: 'KIER',
      confirm: false,
    })

    expect(result.isError).toBe(true)
    expect(harness.variablesCreated).toEqual([])
  })

  it('refuses a value that does not match the type, which cannot be changed later', async () => {
    const harness = createHarness()

    const result = await takeTool(harness, 'homey_variable_create').handler({
      name: 'Window open',
      type: 'boolean',
      value: 'yes',
      confirm: true,
    })

    expect(result.isError).toBe(true)
    expect(harness.variablesCreated).toEqual([])
  })

  it('drops the cached variable list, so the new one is visible at once', async () => {
    const harness = createHarness()

    await takeTool(harness, 'homey_variable_create').handler({ name: 'Counter', type: 'number', value: 0, confirm: true })

    expect(harness.invalidatedCollections).toContain('logicVariables')
  })
})
