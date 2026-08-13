import { describe, expect, it } from 'vitest'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { createHomeCache } from '../../homey/cache.js'
import type {
  CapabilityProbeOutcome,
  CapabilityRegistry,
  CapabilitySupport,
  HomeyConnection,
  HomeyIdentity,
} from '../../homey/types.js'
import { createLogger } from '../../util/log.js'
import type { ServerContext } from '../context.js'
import { registerEnergyTools } from './energy.js'

const FRIDGE_ID = '44444444-4444-4444-8444-444444444444'
const CHARGER_ID = '55555555-5555-4555-8555-555555555555'

const ZONES = [
  { id: 'zone-office', name: 'Kantoor', parent: null, order: 1, active: true },
  { id: 'zone-living', name: 'Woonkamer', parent: null, order: 2, active: true },
  { id: 'zone-spare', name: 'Logeerkamer', parent: null, order: 3, active: false },
]

const DEVICES = [
  { id: FRIDGE_ID, name: 'Koelkast', zone: 'zone-living', class: 'socket', capabilities: [] },
  { id: CHARGER_ID, name: 'Laadpaal', zone: 'zone-office', class: 'evcharger', capabilities: [] },
]

// The measured shape of `GET /api/manager/energy/live`: watts arrive as `W`,
// zone and device items add up to `totalConsumed`, the whole-home meter is a
// third item type, and a null draw means unknown rather than zero.
const LIVE_REPORT = {
  zoneId: 'aaaaaaaa-1111-4222-8333-444444444444',
  zoneName: 'Thuis',
  currency: 'EUR',
  totalConsumed: { W: 186.18, cost: 0.0446832 },
  totalCumulative: { W: 400, cost: 0.096 },
  totalGenerated: { W: null, cost: null },
  items: [
    { type: 'zone', id: 'zone-office', name: 'Office', values: { W: 129.95, cost: 0.031188 } },
    { type: 'zone', id: 'zone-living', name: 'Living room', values: { W: 33.65, cost: 0.008076 } },
    { type: 'zone', id: 'zone-spare', name: 'Spare room', values: { W: null, cost: null } },
    {
      type: 'device',
      id: FRIDGE_ID,
      name: 'Fridge',
      values: { W: 22.58, cost: 0.0054192 },
      isHomeBattery: false,
      isEVCharger: false,
      approximated: true,
      canApproximate: false,
    },
    {
      type: 'device',
      id: CHARGER_ID,
      name: 'Charger',
      values: { W: null, cost: null },
      isHomeBattery: false,
      isEVCharger: true,
      approximated: false,
      canApproximate: true,
    },
    {
      type: 'cumulative',
      id: 'cccccccc-1111-4222-8333-444444444444',
      name: 'Slimme meter',
      values: { W: 400, cost: 0.096 },
      includedInTotal: true,
    },
  ],
}

const IDENTITY: HomeyIdentity = {
  id: 'homey-under-test',
  name: 'Test hub',
  modelId: 'homey4d',
  modelName: 'Homey Pro (Early 2019)',
  softwareVersion: '13.2.4',
  platformVersion: 1,
  language: 'nl',
  timezone: 'Europe/Amsterdam',
  address: 'http://hub.invalid',
  addressKind: 'local',
}

type ToolHandler = (input: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>

interface RecordedTool {
  name: string
  config: { description?: string; annotations?: Record<string, unknown> }
  handler: ToolHandler
}

function createRecordingServer(): { server: McpServer; tools: Map<string, RecordedTool> } {
  const tools = new Map<string, RecordedTool>()
  const server = {
    registerTool(name: string, config: RecordedTool['config'], handler: ToolHandler) {
      tools.set(name, { name, config, handler })
      return {}
    },
  }
  return { server: server as unknown as McpServer, tools }
}

interface HarnessOptions {
  energyLiveProbe?: CapabilityProbeOutcome
  /** Null is what the probe answers when it did not settle the question, which is a third case rather than a false. */
  energyReports?: CapabilitySupport
  liveReport?: unknown
}

function createHarness(options: HarnessOptions = {}) {
  const api = {
    zones: { getZones: async () => ZONES },
    devices: { getDevices: async () => DEVICES },
    energy: { getLiveReport: async () => options.liveReport ?? LIVE_REPORT },
  }

  const connection: HomeyConnection = {
    api,
    dialect: 'v2',
    identity: IDENTITY,
    queue: { run: async (operation) => operation(), inFlight: 0, queued: 0 },
    request: async (operation) => operation(),
  }

  const capabilities: CapabilityRegistry = {
    hardware: {
      advancedFlow: false,
      // Measured: the historical report routes 404 on this generation.
      energyReports: options.energyReports === undefined ? false : options.energyReports,
      moods: false,
      insights: true,
    },
    probedAt: '2026-08-13T08:00:00.000Z',
    notes: [],
    probes:
      options.energyLiveProbe === undefined
        ? {}
        : { energyLive: options.energyLiveProbe },
  }

  const context: ServerContext = {
    connection,
    cache: createHomeCache(connection),
    capabilities,
    logger: createLogger({ level: 'silent' }),
    askSupported: false,
    ask: async () => ({ answered: false, value: null, declined: false }),
  }

  const { server, tools } = createRecordingServer()
  registerEnergyTools(server, context)

  return { tools, context }
}

async function callTool(
  tools: Map<string, RecordedTool>,
  name: string,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`${name} was never registered`)
  return tool.handler(input, {})
}

function structured(result: CallToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>
}

function failure(result: CallToolResult): Record<string, unknown> {
  return (structured(result)['error'] ?? {}) as Record<string, unknown>
}

describe('homey_energy_live', () => {
  it('registers as a read-only tool', () => {
    const { tools } = createHarness()
    const tool = tools.get('homey_energy_live')

    expect(tool?.config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    })
  })

  it('reports the totals and the load nothing accounts for', async () => {
    const { tools } = createHarness()

    const content = structured(await callTool(tools, 'homey_energy_live', {}))
    const totals = content['totals'] as Record<string, Record<string, unknown>>
    const unmonitored = content['unmonitored'] as Record<string, unknown>

    expect(totals['consumed']?.['watts']).toBe(186.18)
    expect(totals['cumulative']?.['watts']).toBe(400)
    // 400 W measured at the meter, 186.18 W attributed, and no generation being
    // measured, so the rest is unmonitored but only as a lower bound.
    expect(unmonitored['watts']).toBe(213.82)
    expect(unmonitored['basis']).toBe('lower_bound')
    expect(unmonitored['itemsWithUnknownDraw']).toBe(2)
  })

  it('names rooms and devices from the cached indexes rather than from the report', async () => {
    const { tools } = createHarness()

    const content = structured(await callTool(tools, 'homey_energy_live', {}))
    const items = content['items'] as Array<Record<string, unknown>>

    expect(items[0]?.['name']).toBe('Kantoor')
    expect(items.find((item) => item['id'] === FRIDGE_ID)?.['name']).toBe('Koelkast')
    expect(items.find((item) => item['id'] === FRIDGE_ID)?.['zoneName']).toBe('Woonkamer')
  })

  it('sorts by draw and puts the devices with no reading last', async () => {
    const { tools } = createHarness()

    const items = structured(await callTool(tools, 'homey_energy_live', {}))['items'] as Array<
      Record<string, unknown>
    >

    expect(items.map((item) => item['watts'])).toEqual([129.95, 33.65, 22.58, null, null])
  })

  it('flags an estimated draw as an estimate', async () => {
    const { tools } = createHarness()

    const result = await callTool(tools, 'homey_energy_live', {})
    const items = structured(result)['items'] as Array<Record<string, unknown>>

    expect(items.find((item) => item['id'] === FRIDGE_ID)?.['approximated']).toBe(true)
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toMatch(/estimated, not measured/)
  })

  it('keeps the whole-home meter separate from the device breakdown', async () => {
    const { tools } = createHarness()

    const meters = structured(await callTool(tools, 'homey_energy_live', {}))['cumulativeMeters'] as unknown[]

    expect(meters).toHaveLength(1)
    expect((meters[0] as Record<string, unknown>)['name']).toBe('Slimme meter')
  })

  it('derives the tariff Homey is costing with', async () => {
    const { tools } = createHarness()

    const content = structured(await callTool(tools, 'homey_energy_live', {}))

    expect(content['impliedTariffPerKilowattHour']).toBeCloseTo(0.24, 6)
  })

  it('truncates the breakdown and says so', async () => {
    const { tools } = createHarness()

    const content = structured(await callTool(tools, 'homey_energy_live', { limit: 2 }))

    expect((content['items'] as unknown[]).length).toBe(2)
    expect(content['truncated']).toBe(true)
    expect(content['itemCount']).toBe(5)
  })

  it('points at Insights for history on a hub with no report endpoints', async () => {
    const { tools } = createHarness({ energyReports: false })

    const history = structured(await callTool(tools, 'homey_energy_live', {}))['history'] as Record<string, unknown>

    expect(history['reportEndpointsAvailable']).toBe(false)
    expect(String(history['guidance'])).toMatch(/meter_power/)
    expect(String(history['guidance'])).toMatch(/measure_power/)
  })

  it('does not claim the report endpoints are absent when the probe never settled it', async () => {
    // The measured residual, from the other end. A dropped connection at startup
    // left this unsettled, the registry answered true, and the tool then told
    // the model this Homey answers routes that reply with a clean 404. Answering
    // false instead would be the mirror of the same mistake, so the tool reports
    // the third state and still names the route that works either way.
    const { tools } = createHarness({ energyReports: null })

    const history = structured(await callTool(tools, 'homey_energy_live', {}))['history'] as Record<string, unknown>

    expect(history['reportEndpointsAvailable']).toBeNull()
    expect(String(history['guidance'])).toContain('never established')
    expect(String(history['guidance'])).not.toMatch(/This Homey answers the historical energy report routes/)
    expect(String(history['guidance'])).not.toMatch(/This Homey has no historical energy report endpoints/)
    expect(String(history['guidance'])).toMatch(/meter_power/)
  })

  it('reports the endpoints as present only when the probe found them', async () => {
    const { tools } = createHarness({ energyReports: true })

    const history = structured(await callTool(tools, 'homey_energy_live', {}))['history'] as Record<string, unknown>

    expect(history['reportEndpointsAvailable']).toBe(true)
    expect(String(history['guidance'])).toContain('answers the historical energy report routes')
  })

  it('answers the call when the live probe merely failed, rather than calling it a hardware limit', async () => {
    // A probe that failed settles nothing: it runs once at startup, on a hub
    // that rate limits its own local API. Refusing here reported a permanent
    // hardware limit that was never measured, and hid a working reading for the
    // life of the process.
    const { tools } = createHarness({
      energyLiveProbe: {
        status: 'failed',
        probe: 'energy.getLiveReport',
        statusCode: 429,
        durationMs: 12,
        detail: 'Homey is refusing further requests for the moment.',
      },
    })

    const result = await callTool(tools, 'homey_energy_live', {})

    expect(result.isError).not.toBe(true)
    expect(structured(result)['zoneName']).toBe('Thuis')
  })

  it('answers unsupported hardware when the probe found no live route', async () => {
    const { tools } = createHarness({
      energyLiveProbe: {
        status: 'unsupported',
        probe: 'energy.getLiveReport',
        statusCode: 404,
        durationMs: 12,
        detail: null,
      },
    })

    const result = await callTool(tools, 'homey_energy_live', {})

    expect(result.isError).toBe(true)
    expect(failure(result)['reason']).toBe('unsupported_hardware')
  })

  it('separates a permissions problem from a hardware one', async () => {
    const { tools } = createHarness({
      energyLiveProbe: {
        status: 'forbidden',
        probe: 'energy.getLiveReport',
        statusCode: 403,
        durationMs: 12,
        detail: null,
      },
    })

    const result = await callTool(tools, 'homey_energy_live', {})

    expect(result.isError).toBe(true)
    expect(failure(result)['reason']).toBe('missing_scope')
  })

  it('does not invent a tariff when the hub reports no cost at all', async () => {
    const { tools } = createHarness({
      liveReport: {
        zoneId: 'zone-home',
        zoneName: 'Thuis',
        currency: 'EUR',
        totalConsumed: { W: 100, cost: null },
        totalCumulative: { W: null, cost: null },
        totalGenerated: { W: null, cost: null },
        items: [{ type: 'zone', id: 'zone-office', name: 'Office', values: { W: 100, cost: null } }],
      },
    })

    const content = structured(await callTool(tools, 'homey_energy_live', {}))

    expect(content['impliedTariffPerKilowattHour']).toBeNull()
    expect((content['unmonitored'] as Record<string, unknown>)['watts']).toBeNull()
  })
})
