import { describe, expect, it } from 'vitest'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { createHomeCache } from '../../homey/cache.js'
import type { CapabilityProbeOutcome, CapabilityRegistry, HomeyConnection, HomeyIdentity } from '../../homey/types.js'
import { createLogger } from '../../util/log.js'
import type { ServerContext } from '../context.js'
import { registerWeatherTools } from './weather.js'

const WEATHER_PATH = '/api/manager/weather/weather'
const HOURLY_FORECAST_PATH = '/api/manager/weather/forecast/hourly'

/**
 * The measured shape of `GET /api/manager/weather/weather` on the reference hub,
 * hand-built and carrying no household data.
 *
 * Every trap in the real payload is kept: `screensaver` holds LED ring frames,
 * `humidity` is a 0..1 fraction while the hub's own Insights log for the same
 * quantity stores a percentage, `forecast` is daily with unix seconds and a
 * property literally named "//" beside a deprecated `weatherId`, and the hourly
 * entries live inside this reply rather than behind the hourly route.
 */
const WEATHER_READING = {
  city: 'Testdorp',
  country: 'NL',
  state: 'Heldere Lucht',
  id: 800,
  screensaverId: 'sunny',
  screensaver: {
    rpm: 3,
    fps: 1,
    frames: [[{ r: 182, g: 247, b: 254, a: 1 }, { r: 15, g: 112, b: 205, a: 1 }]],
  },
  temperature: 34.4,
  temperatureMin: 33.9,
  temperatureMax: 36,
  temperatureUnits: '°C',
  humidity: 0.24,
  pressure: 1.02,
  when: '2026-08-13T14:47:39.029Z',
  forecastHourly: [
    { time: 1786633200, temperature: 34.41, temperatureMin: 34.41, temperatureMax: 34.63, iconId: 'clear_day' },
    { time: 1786636800, temperature: 34.46, temperatureMin: 34.46, temperatureMax: 34.61, iconId: 'clear_day' },
  ],
  iconId: 'clear_day',
  videoId: 'clear_day',
  colors: [{ r: 19, g: 113, b: 196 }],
  forecast: [
    {
      time: 1786705200,
      temperature: 34.98,
      temperatureMin: 21.95,
      temperatureMax: 36.3,
      iconId: 'clouds_light_day',
      '//': 'Deprecated. Do not use the following properties, they will be removed soon.',
      weatherId: 801,
    },
    {
      time: 1786791600,
      temperature: 28.32,
      temperatureMin: 17.64,
      temperatureMax: 34.89,
      iconId: 'rain_light_day',
      '//': 'Deprecated. Do not use the following properties, they will be removed soon.',
      weatherId: 500,
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

function probe(status: CapabilityProbeOutcome['status'], probeLabel: string): CapabilityProbeOutcome {
  return { status, probe: probeLabel, statusCode: status === 'unsupported' ? 404 : null, durationMs: 9, detail: null }
}

interface HarnessOptions {
  weatherProbe?: CapabilityProbeOutcome
  hourlyProbe?: CapabilityProbeOutcome
  reading?: unknown
  hourlyReply?: unknown
  hourlyFails?: () => Error
  timezone?: string
}

function createHarness(options: HarnessOptions = {}) {
  const paths: string[] = []

  const api = {
    async call({ path }: { method: string; path: string }): Promise<unknown> {
      paths.push(path)
      if (path === HOURLY_FORECAST_PATH) {
        if (options.hourlyFails !== undefined) throw options.hourlyFails()
        return options.hourlyReply ?? []
      }
      return options.reading ?? WEATHER_READING
    },
  }

  const connection: HomeyConnection = {
    api,
    dialect: 'v2',
    identity: options.timezone === undefined ? IDENTITY : { ...IDENTITY, timezone: options.timezone },
    queue: { run: async (operation) => operation(), inFlight: 0, queued: 0 },
    request: async (operation) => operation(),
  }

  const probes: Record<string, CapabilityProbeOutcome> = {
    weather: options.weatherProbe ?? probe('available', `GET ${WEATHER_PATH}`),
  }
  if (options.hourlyProbe !== undefined) probes['weatherHourlyForecast'] = options.hourlyProbe

  const capabilities: CapabilityRegistry = {
    hardware: { advancedFlow: false, energyReports: false, moods: false, insights: true },
    probedAt: '2026-08-13T08:00:00.000Z',
    notes: [],
    probes,
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
  registerWeatherTools(server, context)

  return { tools, paths, context }
}

async function callWeather(
  tools: Map<string, RecordedTool>,
  input: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const tool = tools.get('homey_weather')
  if (tool === undefined) throw new Error('homey_weather was never registered')
  return tool.handler(input, {})
}

function structured(result: CallToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>
}

function section(result: CallToolResult, name: string): Record<string, unknown> {
  return (structured(result)[name] ?? {}) as Record<string, unknown>
}

function textOf(result: CallToolResult): string {
  return result.content[0]?.type === 'text' ? result.content[0].text : ''
}

function failure(result: CallToolResult): Record<string, unknown> {
  return (structured(result)['error'] ?? {}) as Record<string, unknown>
}

describe('homey_weather', () => {
  it('registers as a read-only tool', () => {
    const { tools } = createHarness()

    expect(tools.get('homey_weather')?.config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    })
  })

  it('says in its description what the reading is good for and what it cannot do', () => {
    const { tools } = createHarness()
    const description = tools.get('homey_weather')?.config.description ?? ''

    expect(description).toMatch(/percentage/)
    expect(description).toMatch(/outdoor sensor in the garden/)
    expect(description).toMatch(/granularity depends on the hardware/)
  })

  it('reports the current conditions and the place they are for', async () => {
    const { tools } = createHarness()

    const result = await callWeather(tools)
    const current = section(result, 'current')

    expect((section(result, 'location'))['city']).toBe('Testdorp')
    expect((section(result, 'location'))['country']).toBe('NL')
    expect(current['temperature']).toBe(34.4)
    expect(current['state']).toBe('Heldere Lucht')
    expect(textOf(result)).toMatch(/Testdorp/)
  })

  it('normalises the humidity fraction to a percentage without float noise', async () => {
    const { tools } = createHarness()

    // The trap: 0.24 here and 47 in the hub's own Insights log are the same
    // quantity in two forms, and 0.24 * 100 is 24.000000000000004 in binary
    // floating point.
    expect(section(await callWeather(tools), 'current')['humidityPercent']).toBe(24)
  })

  it('passes a humidity that is already a percentage through unchanged', async () => {
    const { tools } = createHarness({ reading: { ...WEATHER_READING, humidity: 47 } })

    expect(section(await callWeather(tools), 'current')['humidityPercent']).toBe(47)
  })

  it('reads a saturated fraction as 100 percent rather than as one percent', async () => {
    const { tools } = createHarness({ reading: { ...WEATHER_READING, humidity: 1 } })

    expect(section(await callWeather(tools), 'current')['humidityPercent']).toBe(100)
  })

  it('gives pressure in bar and in the millibar a forecast quotes', async () => {
    const { tools } = createHarness()
    const current = section(await callWeather(tools), 'current')

    expect(current['pressureBar']).toBe(1.02)
    expect(current['pressureMillibar']).toBe(1020)
  })

  it('echoes the temperature unit instead of assuming Celsius', async () => {
    const { tools } = createHarness({
      reading: { ...WEATHER_READING, temperature: 93.9, temperatureUnits: '°F' },
    })

    const current = section(await callWeather(tools), 'current')

    expect(current['temperatureUnits']).toBe('°F')
    expect(current['temperature']).toBe(93.9)
  })

  it('never lets the screensaver or the deprecated fields reach the result', async () => {
    const { tools } = createHarness()

    const result = await callWeather(tools)
    const serialised = JSON.stringify(structured(result))

    expect(serialised).not.toContain('screensaver')
    expect(serialised).not.toContain('weatherId')
    expect(serialised).not.toContain('Deprecated')
    expect(serialised).not.toContain('"//"')
    expect(serialised).not.toContain('videoId')
    expect(textOf(result)).not.toContain('Deprecated')
  })

  it('renders forecast timestamps in the hub timezone rather than as unix seconds', async () => {
    const { tools } = createHarness()

    const forecast = section(await callWeather(tools), 'forecast')
    const firstDay = (forecast['days'] as Array<Record<string, unknown>>)[0] ?? {}

    // 1786705200 is 2026-08-14T11:00:00Z, which is 13:00 in the hub's own zone.
    expect(firstDay['time']).toBe('2026-08-14T13:00:00+02:00')
    expect(firstDay['timeUtc']).toBe('2026-08-14T11:00:00.000Z')
    expect(firstDay['date']).toBe('2026-08-14')
    expect(JSON.stringify(firstDay)).not.toContain('1786705200')
  })

  it('renders the moment the reading was taken in the hub timezone too', async () => {
    const { tools } = createHarness()

    expect(structured(await callWeather(tools))['observedAt']).toBe('2026-08-13T16:47:39+02:00')
  })

  it('leaves local timestamps null rather than presenting UTC as local time', async () => {
    const { tools } = createHarness({ timezone: '' })

    const result = await callWeather(tools)
    const firstDay = (section(result, 'forecast')['days'] as Array<Record<string, unknown>>)[0] ?? {}

    expect(structured(result)['timezone']).toBeNull()
    expect(structured(result)['observedAt']).toBeNull()
    expect(firstDay['time']).toBeNull()
    expect(firstDay['timeUtc']).toBe('2026-08-14T11:00:00.000Z')
    expect(String(structured(result)['timezoneNote'])).toMatch(/UTC/)
  })

  it('states that the forecast is daily, with the night low named as such', async () => {
    const { tools } = createHarness()

    const forecast = section(await callWeather(tools), 'forecast')
    const firstDay = (forecast['days'] as Array<Record<string, unknown>>)[0] ?? {}

    expect(forecast['granularity']).toBe('daily')
    expect(String(forecast['granularityNote'])).toMatch(/DAILY/)
    expect(String(forecast['granularityNote'])).toMatch(/night/)
    expect(forecast['dayCount']).toBe(2)
    expect(firstDay['temperatureMin']).toBe(21.95)
    expect(firstDay['temperatureMax']).toBe(36.3)
  })

  it('drops a forecast entry with no usable timestamp rather than placing it at an invented time', async () => {
    const { tools } = createHarness({
      reading: {
        ...WEATHER_READING,
        forecast: [...WEATHER_READING.forecast, { temperature: 20, iconId: 'clear_day' }],
      },
    })

    expect(section(await callWeather(tools), 'forecast')['dayCount']).toBe(2)
  })

  it('uses the hourly entries the weather reading already carries, without a second request', async () => {
    const { tools, paths } = createHarness({
      hourlyProbe: probe('unsupported', `GET ${HOURLY_FORECAST_PATH}`),
    })

    const hourly = section(await callWeather(tools), 'hourlyForecast')

    // Measured on the reference hub: the separate route is absent while the
    // reading itself carries hourly entries, so the two are different questions.
    expect(hourly['available']).toBe(true)
    expect(hourly['source']).toBe('weather_reading')
    expect(hourly['hourCount']).toBe(2)
    expect(paths).toEqual([WEATHER_PATH])
  })

  it('states a missing hourly forecast plainly instead of failing', async () => {
    const { tools } = createHarness({
      reading: { ...WEATHER_READING, forecastHourly: [] },
      hourlyProbe: probe('unsupported', `GET ${HOURLY_FORECAST_PATH}`),
    })

    const result = await callWeather(tools)
    const hourly = section(result, 'hourlyForecast')

    expect(result.isError).toBeFalsy()
    expect(structured(result)['ok']).toBe(true)
    expect(hourly['available']).toBe(false)
    expect(String(hourly['note'])).toMatch(/no hourly forecast/)
    expect(String(hourly['note'])).toMatch(/rather than a fault/)
    expect(textOf(result)).toMatch(/no hourly forecast/)
  })

  it('fetches the hourly route on hardware that offers it', async () => {
    const { tools, paths } = createHarness({
      reading: { ...WEATHER_READING, forecastHourly: [] },
      hourlyProbe: probe('available', `GET ${HOURLY_FORECAST_PATH}`),
      hourlyReply: [{ time: 1786633200, temperature: 34.41, temperatureMax: 34.63, iconId: 'clear_day' }],
    })

    const hourly = section(await callWeather(tools), 'hourlyForecast')

    expect(paths).toEqual([WEATHER_PATH, HOURLY_FORECAST_PATH])
    expect(hourly['source']).toBe('hourly_forecast_route')
    expect((hourly['hours'] as Array<Record<string, unknown>>)[0]?.['time']).toBe('2026-08-13T17:00:00+02:00')
  })

  it('accepts an hourly reply wrapped in an object, since that route is untested hardware', async () => {
    const { tools } = createHarness({
      reading: { ...WEATHER_READING, forecastHourly: [] },
      hourlyProbe: probe('available', `GET ${HOURLY_FORECAST_PATH}`),
      hourlyReply: { forecastHourly: [{ time: 1786633200, temperature: 34.41, iconId: 'clear_day' }] },
    })

    expect(section(await callWeather(tools), 'hourlyForecast')['hourCount']).toBe(1)
  })

  it('asks for a compatibility report when the hourly route answers in a shape it does not know', async () => {
    const { tools } = createHarness({
      reading: { ...WEATHER_READING, forecastHourly: [] },
      hourlyProbe: probe('available', `GET ${HOURLY_FORECAST_PATH}`),
      hourlyReply: { somethingElse: true },
    })

    const hourly = section(await callWeather(tools), 'hourlyForecast')

    expect(hourly['available']).toBe(false)
    expect(String(hourly['note'])).toMatch(/doctor --report/)
  })

  it('calls an absent hourly route absent, even when no probe settled it first', async () => {
    // No hourly probe in the registry at all, so the route is tried and its 404
    // is what answers the question. That is a fact about the hub rather than a
    // fetch that went wrong, and it is worded as such.
    const { tools, paths } = createHarness({
      reading: { ...WEATHER_READING, forecastHourly: [] },
      hourlyFails: () => Object.assign(new Error('Not Found'), { statusCode: 404 }),
    })

    const hourly = section(await callWeather(tools), 'hourlyForecast')

    expect(paths).toEqual([WEATHER_PATH, HOURLY_FORECAST_PATH])
    expect(hourly['available']).toBe(false)
    expect(String(hourly['note'])).toMatch(/no hourly forecast/)
    expect(String(hourly['note'])).not.toMatch(/could not be fetched/)
  })

  it('keeps the reading when only the hourly fetch fails', async () => {
    const { tools } = createHarness({
      reading: { ...WEATHER_READING, forecastHourly: [] },
      hourlyProbe: probe('available', `GET ${HOURLY_FORECAST_PATH}`),
      hourlyFails: () => Object.assign(new Error('Homey did not answer in time'), { code: 'ETIMEDOUT' }),
    })

    const result = await callWeather(tools)

    expect(structured(result)['ok']).toBe(true)
    expect(section(result, 'current')['temperature']).toBe(34.4)
    expect(section(result, 'hourlyForecast')['available']).toBe(false)
    expect(String(section(result, 'hourlyForecast')['note'])).toMatch(/could not be fetched/)
  })

  it('skips the forecast entirely when the caller asks for just the reading', async () => {
    const { tools, paths } = createHarness({
      reading: { ...WEATHER_READING, forecastHourly: [] },
      hourlyProbe: probe('available', `GET ${HOURLY_FORECAST_PATH}`),
    })

    const result = await callWeather(tools, { includeForecast: false })

    expect(structured(result)['forecast']).toBeNull()
    expect(section(result, 'hourlyForecast')['available']).toBe(false)
    expect(paths).toEqual([WEATHER_PATH])
  })

  it('skips only the hourly request when asked to', async () => {
    const { tools, paths } = createHarness({
      reading: { ...WEATHER_READING, forecastHourly: [] },
      hourlyProbe: probe('available', `GET ${HOURLY_FORECAST_PATH}`),
    })

    const result = await callWeather(tools, { includeHourlyForecast: false })

    expect(section(result, 'forecast')['dayCount']).toBe(2)
    expect(paths).toEqual([WEATHER_PATH])
  })

  it('answers unsupported hardware when the probe found no weather route', async () => {
    const { tools } = createHarness({ weatherProbe: probe('unsupported', `GET ${WEATHER_PATH}`) })

    const result = await callWeather(tools)

    expect(result.isError).toBe(true)
    expect(failure(result)['reason']).toBe('unsupported_hardware')
  })

  it('separates a permissions problem from a hardware one', async () => {
    const { tools } = createHarness({ weatherProbe: probe('forbidden', `GET ${WEATHER_PATH}`) })

    const result = await callWeather(tools)

    expect(result.isError).toBe(true)
    expect(failure(result)['reason']).toBe('missing_scope')
    expect(String(failure(result)['message'])).toMatch(/geolocation/)
  })

  it('treats a reply that is not a weather reading as something worth retrying', async () => {
    const { tools } = createHarness({ reading: 'not a weather reading' })

    const result = await callWeather(tools)

    expect(result.isError).toBe(true)
    expect(failure(result)['reason']).toBe('transient')
  })
})
