import { describe, expect, it } from 'vitest'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { createHomeCache } from '../../homey/cache.js'
import type {
  CapabilityProbeOutcome,
  CapabilityRegistry,
  HomeyConnection,
  HomeyIdentity,
} from '../../homey/types.js'
import { createLogger } from '../../util/log.js'
import type { AskOptions, AskResult, ServerContext } from '../context.js'
import { registerInsightsTools, scoreLog } from './insights.js'

// ---------------------------------------------------------------------------
// Fixtures, hand-built from the wire shapes captured on a Homey Pro (Early 2019)
// ---------------------------------------------------------------------------

const THERMOSTAT_ID = '11111111-1111-4111-8111-111111111111'
const SENSOR_ID = '22222222-2222-4222-8222-222222222222'
const SOCKET_ID = '33333333-3333-4333-8333-333333333333'

const ZONES = [
  { id: 'zone-living', name: 'Woonkamer', parent: null, order: 1, active: true },
  { id: 'zone-office', name: 'Kantoor', parent: null, order: 2, active: false },
]

const DEVICES = [
  { id: THERMOSTAT_ID, name: 'Thermostaat', zone: 'zone-living', class: 'thermostat', capabilities: [] },
  { id: SENSOR_ID, name: 'Sensor', zone: 'zone-office', class: 'sensor', capabilities: [] },
  { id: SOCKET_ID, name: 'Stekker', zone: 'zone-office', class: 'socket', capabilities: [] },
]

// Titles come back in the household's language while capability ids stay
// English. That split is why the search tool has to match on both.
const INSIGHTS_LOGS = [
  {
    uri: `homey:device:${THERMOSTAT_ID}`,
    uriObj: { type: 'device', id: THERMOSTAT_ID, name: 'Thermostaat' },
    id: 'measure_temperature',
    title: 'Temperatuur',
    type: 'number',
    units: '°C',
    decimals: 1,
    titleTrue: null,
    titleFalse: null,
    lastValue: 21.4,
  },
  {
    uri: `homey:device:${SENSOR_ID}`,
    uriObj: { type: 'device', id: SENSOR_ID, name: 'Sensor' },
    id: 'measure_temperature',
    title: 'Temperatuur',
    type: 'number',
    units: '°C',
    decimals: 1,
    titleTrue: null,
    titleFalse: null,
    lastValue: 19.2,
  },
  {
    uri: `homey:device:${SENSOR_ID}`,
    uriObj: { type: 'device', id: SENSOR_ID, name: 'Sensor' },
    id: 'alarm_motion',
    title: 'Beweging',
    type: 'boolean',
    units: null,
    decimals: null,
    titleTrue: 'Beweging gedetecteerd',
    titleFalse: 'Geen beweging',
    lastValue: 0,
  },
  {
    uri: `homey:device:${SOCKET_ID}`,
    uriObj: { type: 'device', id: SOCKET_ID, name: 'Stekker' },
    id: 'meter_power',
    title: 'Energie',
    type: 'number',
    units: 'kWh',
    decimals: 2,
    titleTrue: null,
    titleFalse: null,
    lastValue: 1004,
  },
]

const TEMPERATURE_ENTRIES = {
  values: [
    { t: '2026-08-12T08:00:00.000Z', v: 20 },
    { t: '2026-08-12T08:05:00.000Z', v: 22 },
    { t: '2026-08-12T08:10:00.000Z', v: null },
    { t: '2026-08-12T08:15:00.000Z', v: 24 },
  ],
  start: '2026-08-12T08:00:00.000Z',
  end: '2026-08-12T08:20:00.000Z',
  step: 300000,
  lastValue: 24,
  updatesIn: 120,
}

const METER_ENTRIES = {
  values: [
    { t: '2026-08-12T08:00:00.000Z', v: 1000 },
    { t: '2026-08-12T09:00:00.000Z', v: 1004 },
  ],
  start: '2026-08-12T08:00:00.000Z',
  end: '2026-08-12T09:00:00.000Z',
  step: 3600000,
  lastValue: 1004,
  updatesIn: 120,
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

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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
  insightsSupported?: boolean
  /** The recorded probe outcome. Without one the registry carries only the boolean above. */
  insightsProbe?: CapabilityProbeOutcome
  askSupported?: boolean
  ask?: (options: AskOptions) => Promise<AskResult>
  entriesByLogId?: Record<string, unknown>
}

function createHarness(options: HarnessOptions = {}) {
  const entryCalls: Array<{ id: string; resolution: string }> = []
  const askCalls: AskOptions[] = []

  const api = {
    zones: { getZones: async () => ZONES },
    devices: { getDevices: async () => DEVICES },
    insights: {
      getLogs: async () => INSIGHTS_LOGS,
      getLogEntries: async (request: { id: string; resolution: string }) => {
        entryCalls.push(request)
        const override = options.entriesByLogId?.[request.id]
        const body = override ?? (request.id.endsWith('meter_power') ? METER_ENTRIES : TEMPERATURE_ENTRIES)
        return { ...(body as Record<string, unknown>), uri: request.id.split(':', 3).join(':'), id: request.id }
      },
    },
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
      energyReports: false,
      moods: false,
      insights: options.insightsSupported !== false,
    },
    probedAt: '2026-08-13T08:00:00.000Z',
    notes: [],
    probes: options.insightsProbe === undefined ? {} : { insights: options.insightsProbe },
  }

  const context: ServerContext = {
    connection,
    cache: createHomeCache(connection),
    capabilities,
    logger: createLogger({ level: 'silent' }),
    askSupported: options.askSupported === true,
    ask: async (askOptions) => {
      askCalls.push(askOptions)
      return options.ask === undefined ? { answered: false, value: null, declined: false } : options.ask(askOptions)
    },
  }

  const { server, tools } = createRecordingServer()
  registerInsightsTools(server, context)

  return { tools, entryCalls, askCalls, context }
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registration', () => {
  it('registers both analytics read tools as read-only', () => {
    const { tools } = createHarness()

    expect([...tools.keys()]).toEqual(['homey_insights_search', 'homey_insights_query'])
    for (const tool of tools.values()) {
      // The SDK defaults destructiveHint and openWorldHint to true, so an
      // unannotated read tool is presented to the client as destructive.
      expect(tool.config.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      })
    }
  })
})

describe('homey_insights_search', () => {
  it('finds a Dutch titled log from an English query through the capability id', async () => {
    const { tools } = createHarness()

    const result = await callTool(tools, 'homey_insights_search', { query: 'kantoor temperature' })
    const candidates = structured(result)['candidates'] as Array<Record<string, unknown>>

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.['logId']).toBe(`homey:device:${SENSOR_ID}:measure_temperature`)
    expect(candidates[0]?.['zoneName']).toBe('Kantoor')
    expect(candidates[0]?.['title']).toBe('Temperatuur')
  })

  it('requires every word to match, so a room name actually narrows the result', async () => {
    const { tools } = createHarness()

    const everywhere = structured(await callTool(tools, 'homey_insights_search', { query: 'temperature' }))
    const oneRoom = structured(await callTool(tools, 'homey_insights_search', { query: 'woonkamer temperature' }))

    expect(everywhere['matchCount']).toBe(2)
    expect(oneRoom['matchCount']).toBe(1)
    expect((oneRoom['candidates'] as Array<Record<string, unknown>>)[0]?.['ownerName']).toBe('Thermostaat')
  })

  it('filters by log type', async () => {
    const { tools } = createHarness()

    const result = structured(await callTool(tools, 'homey_insights_search', { query: 'sensor', type: 'boolean' }))
    const candidates = result['candidates'] as Array<Record<string, unknown>>

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.['logId']).toBe(`homey:device:${SENSOR_ID}:alarm_motion`)
    expect(candidates[0]?.['type']).toBe('boolean')
  })

  it('labels an energy log with the arithmetic it needs', async () => {
    const { tools } = createHarness()

    const result = structured(await callTool(tools, 'homey_insights_search', { query: 'meter_power' }))
    const candidates = result['candidates'] as Array<Record<string, unknown>>

    expect(candidates[0]?.['energyKind']).toBe('cumulative_meter')
  })

  it('reports how many logs it held back', async () => {
    const { tools } = createHarness()

    const result = structured(await callTool(tools, 'homey_insights_search', { limit: 1 }))

    expect(result['returnedCount']).toBe(1)
    expect(result['truncated']).toBe(true)
    expect(result['totalLogCount']).toBe(4)
  })

  it('scores an exact title above a fuzzy near miss', () => {
    const log = {
      uri: `homey:device:${SENSOR_ID}`,
      ownerType: 'device',
      ownerId: SENSOR_ID,
      ownerName: 'Sensor',
      id: 'measure_temperature',
      title: 'Temperatuur',
      type: 'number' as const,
      units: '°C',
      decimals: 1,
      titleTrue: null,
      titleFalse: null,
      lastValue: 19.2,
      raw: {},
    }

    expect(scoreLog(log, 'Kantoor', 'temperatuur').score).toBeGreaterThan(
      scoreLog(log, 'Kantoor', 'temperature').score,
    )
    expect(scoreLog(log, 'Kantoor', 'humidity').score).toBe(0)
  })
})

describe('homey_insights_query', () => {
  it('returns statistics, the true window and the coverage they were computed over', async () => {
    const { tools, entryCalls } = createHarness()

    const result = await callTool(tools, 'homey_insights_query', {
      logs: [`homey:device:${SENSOR_ID}:measure_temperature`],
    })
    const series = (structured(result)['series'] as Array<Record<string, unknown>>)[0]
    const statistics = series?.['statistics'] as Record<string, Record<string, unknown>>

    expect(entryCalls).toEqual([
      { id: `homey:device:${SENSOR_ID}:measure_temperature`, resolution: 'last24Hours' },
    ])
    expect(statistics['numeric']?.['mean']).toBe(22)
    expect(statistics['numeric']?.['delta']).toBe(4)
    expect(statistics['coverage']?.['percent']).toBe(75)
    expect((series?.['window'] as Record<string, unknown>)['stepMs']).toBe(300000)
    // Cut in the hub's zone, which is two hours ahead of UTC in August.
    expect((series?.['window'] as Record<string, unknown>)['localStart']).toBe('2026-08-12 10:00 GMT+2')
  })

  it('stops an unknown resolution before it reaches the hub', async () => {
    const { tools, entryCalls } = createHarness()

    const result = await callTool(tools, 'homey_insights_query', {
      logs: [`homey:device:${SENSOR_ID}:measure_temperature`],
      resolution: 'lastFortnight',
    })

    expect(result.isError).toBe(true)
    expect(failure(result)['reason']).toBe('invalid_request')
    expect(entryCalls).toHaveLength(0)
  })

  it('fetches a second window and reports the difference', async () => {
    const { tools, entryCalls } = createHarness({
      entriesByLogId: {},
    })

    const result = await callTool(tools, 'homey_insights_query', {
      logs: [`homey:device:${SENSOR_ID}:measure_temperature`],
      resolution: 'thisWeek',
      compareWith: 'lastWeek',
    })
    const series = (structured(result)['series'] as Array<Record<string, unknown>>)[0]

    expect(entryCalls.map((call) => call.resolution)).toEqual(['thisWeek', 'lastWeek'])
    const comparison = series?.['comparison'] as Record<string, unknown>
    expect(comparison['comparable']).toBe(true)
    expect((comparison['numeric'] as Record<string, Record<string, unknown>>)['mean']?.['delta']).toBe(0)
  })

  it('adds cumulative meter arithmetic to an energy log rather than an average', async () => {
    const { tools } = createHarness()

    const result = await callTool(tools, 'homey_insights_query', {
      logs: [`homey:device:${SOCKET_ID}:meter_power`],
    })
    const series = (structured(result)['series'] as Array<Record<string, unknown>>)[0]
    const energy = series?.['energy'] as Record<string, unknown>

    expect(energy['kind']).toBe('cumulative_meter')
    expect(energy['consumed']).toBe(4)
    expect(energy['unit']).toBe('kWh')
    expect(String(result.content[0]?.type === 'text' ? result.content[0].text : '')).toMatch(
      /endpoint difference, not an average/,
    )
  })

  it('groups into local calendar days when asked', async () => {
    const { tools } = createHarness({
      entriesByLogId: {
        [`homey:device:${SENSOR_ID}:measure_temperature`]: {
          values: [
            { t: '2026-08-12T21:55:00.000Z', v: 20 },
            { t: '2026-08-12T22:00:00.000Z', v: 24 },
          ],
          start: '2026-08-12T21:55:00.000Z',
          end: '2026-08-12T22:05:00.000Z',
          step: 300000,
          lastValue: 24,
          updatesIn: 60,
        },
      },
    })

    const result = await callTool(tools, 'homey_insights_query', {
      logs: [`homey:device:${SENSOR_ID}:measure_temperature`],
      groupBy: 'day',
    })
    const series = (structured(result)['series'] as Array<Record<string, unknown>>)[0]
    const buckets = series?.['calendarBuckets'] as Array<Record<string, unknown>>

    // Both instants fall on 12 August in UTC. In the hub's own zone they are on
    // either side of midnight, which is the whole point.
    expect(buckets.map((bucket) => bucket['key'])).toEqual(['2026-08-12', '2026-08-13'])
  })

  it('thins the raw readings to a budget without hiding that it did', async () => {
    const { tools } = createHarness()

    const result = await callTool(tools, 'homey_insights_query', {
      logs: [`homey:device:${SENSOR_ID}:measure_temperature`],
      includeValues: true,
      maxValues: 2,
    })
    const series = (structured(result)['series'] as Array<Record<string, unknown>>)[0]
    const values = series?.['values'] as Record<string, unknown>

    expect(values['truncated']).toBe(true)
    expect(values['totalCount']).toBe(4)
    expect(values['stride']).toBe(2)
  })

  it('returns the candidates instead of picking one when a name fits several logs', async () => {
    const { tools } = createHarness()

    const result = await callTool(tools, 'homey_insights_query', { logs: ['Temperatuur'] })
    const content = structured(result)

    expect(result.isError).toBeUndefined()
    expect(content['status']).toBe('ambiguous')
    expect((content['candidates'] as unknown[]).length).toBe(2)
  })

  it('asks the user when the client can ask, and uses the answer', async () => {
    const { tools, askCalls, entryCalls } = createHarness({
      askSupported: true,
      ask: async () => ({
        answered: true,
        value: `homey:device:${SENSOR_ID}:measure_temperature`,
        declined: false,
      }),
    })

    const result = await callTool(tools, 'homey_insights_query', { logs: ['Temperatuur'] })

    expect(askCalls).toHaveLength(1)
    expect(askCalls[0]?.choices?.length).toBe(2)
    expect(structured(result)['status']).toBeUndefined()
    expect(entryCalls[0]?.id).toBe(`homey:device:${SENSOR_ID}:measure_temperature`)
  })

  it('points at the search tool when nothing matches', async () => {
    const { tools } = createHarness()

    const result = await callTool(tools, 'homey_insights_query', { logs: ['nothing like this exists'] })

    expect(result.isError).toBe(true)
    expect(failure(result)['reason']).toBe('not_found')
    expect(String(failure(result)['message'])).toMatch(/homey_insights_search/)
  })

  it('reports unsupported hardware rather than failing obscurely', async () => {
    const { tools } = createHarness({ insightsSupported: false })

    const result = await callTool(tools, 'homey_insights_query', {
      logs: [`homey:device:${SENSOR_ID}:measure_temperature`],
    })

    expect(result.isError).toBe(true)
    expect(failure(result)['reason']).toBe('unsupported_hardware')
    expect(failure(result)['retryable']).toBe(false)
  })

  // A probe fails for four reasons and only one of them is about the hardware.
  // Reading the registry's boolean collapsed all four, so a probe lost to this
  // hub's own rate limiting switched sensor history off for the life of the
  // process and told the model that retrying could never help.
  describe('what the capability probe actually said', () => {
    function probeOutcome(status: CapabilityProbeOutcome['status']): CapabilityProbeOutcome {
      return { status, probe: 'insights.getLogs', statusCode: null, durationMs: 40, detail: null }
    }

    async function query(status: CapabilityProbeOutcome['status']): Promise<CallToolResult> {
      const { tools } = createHarness({ insightsSupported: false, insightsProbe: probeOutcome(status) })
      return callTool(tools, 'homey_insights_query', { logs: [`homey:device:${SENSOR_ID}:measure_temperature`] })
    }

    it('asks the hub anyway when the probe merely failed', async () => {
      const result = await query('failed')

      expect(result.isError).toBeUndefined()
    })

    it('still refuses when the probe settled that this hardware has no Insights', async () => {
      expect(failure(await query('unsupported'))['reason']).toBe('unsupported_hardware')
    })

    it('names a refused probe as a permissions problem rather than a hardware one', async () => {
      expect(failure(await query('forbidden'))['reason']).toBe('missing_scope')
    })
  })
})
