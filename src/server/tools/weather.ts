// Outdoor weather.
//
// One tool rather than two. Splitting current conditions from the forecast would
// mean two calls for the question this exists to answer, and it would be two
// calls to the same endpoint: the hub returns the reading and the forecast in
// one reply, so a second tool would fetch the first tool's payload again.
//
// Four things about that reply shape the whole file, all measured on the hub.
//
//   1. `screensaver` is an array of RGB frames for the LED ring. It is a third of
//      the payload and means nothing to a model, so it is dropped here and never
//      reaches a result.
//   2. `humidity` is a 0..1 fraction (0.24), while the hub's own Insights log for
//      the same quantity, `homey:manager:weather:humidity`, carries units "%" and
//      stored 47. Both forms exist on one hub, so this tool commits to percent
//      and says so in the description rather than passing a bare number on.
//   3. `forecast` is DAILY, not hourly, with unix seconds in `time`. Each entry
//      carries a property literally named "//" holding a deprecation notice and a
//      deprecated `weatherId`; both are dropped.
//   4. The measured hub has no `/forecast/hourly` route at all, yet its weather
//      reading carries five hourly entries inline under `forecastHourly`. So
//      hourly data and the hourly route are separate questions, and the answer to
//      "is there hourly data" is a plain statement in the result, never an error.
//
// Pressure has no unit field on the wire. The hub's own Insights log
// `homey:manager:weather:pressure` reports units "bar" and a last value of 1.023
// against this endpoint's 1.02, which is what settles it as bar rather than the
// hectopascals a forecast usually quotes. Both are returned so nobody has to
// guess which one 1.02 is.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { formatDateInTimezone, formatIsoInTimezone, isValidTimezone, roundValue } from '../../analytics/series.js'
import { HomeyMcpError } from '../../homey/errors.js'
import type { ServerContext } from '../context.js'
import { READ_ONLY_TOOL_ANNOTATIONS } from '../createServer.js'
import { describeFailure, failureResult } from '../errors.js'
import { renderTextBlock, successResult } from '../render.js'
import { asNumber, asRecord, asString } from '../../util/coerce.js'

const WEATHER_PATH = '/api/manager/weather/weather'
const HOURLY_FORECAST_PATH = '/api/manager/weather/forecast/hourly'

interface RawCaller {
  call(options: { method: string; path: string }): Promise<unknown>
}

/** Where an hourly forecast came from, so a caller can tell an inline one from a fetched one. */
export type HourlyForecastSource = 'weather_reading' | 'hourly_forecast_route'

export interface WeatherForecastEntry {
  /** ISO 8601 in the Homey's own zone, for example `2026-08-14T13:00:00+02:00`. Null when the hub reported no usable zone. */
  time: string | null
  /** The same instant in UTC, always present, so a caller is never left without a timestamp. */
  timeUtc: string
  /** Local calendar date, `2026-08-14`. Null when the hub reported no usable zone. */
  date: string | null
  temperature: number | null
  /** The low across the entry. On a daily entry this is effectively the coming night's low. */
  temperatureMin: number | null
  temperatureMax: number | null
  /** Homey's own icon name, for example `clouds_light_day`. A stable machine name, unlike the translated state text. */
  iconId: string | null
}

export interface NormalisedWeather {
  city: string | null
  country: string | null
  /** Homey's readable sky description. Comes back in the household's language, for example "Heldere Lucht". */
  state: string | null
  iconId: string | null
  observedAtUtc: string | null
  observedAt: string | null
  temperature: number | null
  /** Echoed from the hub, for example `°C`. Never assumed: a Homey set to imperial units reports Fahrenheit here. */
  temperatureUnits: string | null
  temperatureMin: number | null
  temperatureMax: number | null
  /** Normalised to 0..100 from the hub's 0..1 fraction. */
  humidityPercent: number | null
  pressureBar: number | null
  /** The same pressure in millibar, which is the hectopascal figure a forecast quotes. */
  pressureMillibar: number | null
  daily: WeatherForecastEntry[]
  /** Hourly entries carried inside the weather reading itself. Empty on hardware that does not include them. */
  hourly: WeatherForecastEntry[]
}

export function registerWeatherTools(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'homey_weather',
    {
      title: 'Outdoor weather',
      description:
        'Reads the outdoor weather Homey itself uses: temperature, humidity, air pressure, a readable sky description, and the name of the town the reading is for, plus the forecast, in one call. Use it to compare outdoors against indoors (pair it with homey_device_get on a room sensor), to answer whether opening a window would help, or to look ahead to tonight\'s low. Humidity is returned as a percentage from 0 to 100: Homey\'s own field is a 0 to 1 fraction and is converted here. Temperature is in whatever unit this Homey is configured for, echoed as temperatureUnits, and pressure is given in bar with the millibar (hectopascal) equivalent beside it. Forecast granularity depends on the hardware and is stated explicitly in every result: a daily forecast is always returned, each day carrying its expected, minimum and maximum temperature, where the minimum is effectively that night\'s low, while an hourly forecast is included only when this Homey offers one and its absence is reported as a plain statement rather than as an error. What it cannot do: it is one reading for one location, the town it names, taken from Homey\'s weather provider rather than from any hardware in this house, so it is not a substitute for an outdoor sensor in the garden and says nothing about conditions in any individual room. The sky description arrives in the Homey\'s own language. For outdoor history rather than the present, look for the logs owned by homey:manager:weather with homey_insights_search and query those.',
      inputSchema: {
        includeForecast: z
          .boolean()
          .optional()
          .describe('Include the forecast as well as the current conditions. On by default; turn it off for just the reading.'),
        includeHourlyForecast: z
          .boolean()
          .optional()
          .describe(
            'Include an hourly forecast when this Homey has one. On by default. Turning it off skips the extra request on hardware where the hourly forecast is a separate route.',
          ),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (rawArguments) => {
      try {
        assertWeatherSupported(context)

        const includeForecast = rawArguments.includeForecast !== false
        const includeHourlyForecast = rawArguments.includeHourlyForecast !== false
        const timezone = context.connection.identity.timezone

        const callers = context.connection.api as RawCaller
        const raw = await context.connection.request(
          () => callers.call({ method: 'GET', path: WEATHER_PATH }),
          `GET ${WEATHER_PATH}`,
          true,
        )

        const weather = normaliseWeather(raw, { timezone })
        const hourly =
          includeForecast && includeHourlyForecast
            ? await resolveHourlyForecast(context, weather)
            : skippedHourlyForecast(includeForecast)

        const structuredContent = {
          location: {
            city: weather.city,
            country: weather.country,
            note: 'Homey reads the weather for the location set on the hub itself, not for any device. A town that is not where the user lives means the Homey\'s location setting is wrong.',
          },
          observedAt: weather.observedAt,
          observedAtUtc: weather.observedAtUtc,
          timezone: isValidTimezone(timezone) ? timezone : null,
          timezoneNote: isValidTimezone(timezone)
            ? 'Local timestamps are cut in the Homey\'s own zone, which is this one, not the server\'s.'
            : 'This Homey reported no usable timezone, so local timestamps are null and only the UTC ones are given.',
          current: {
            state: weather.state,
            stateNote: 'Homey\'s own words for the sky, in the language the hub is set to. Use iconId for a value that does not change with the language.',
            iconId: weather.iconId,
            temperature: weather.temperature,
            temperatureUnits: weather.temperatureUnits,
            temperatureMin: weather.temperatureMin,
            temperatureMax: weather.temperatureMax,
            temperatureRangeNote: 'temperatureMin and temperatureMax are today\'s low and high, not the range of the reading itself.',
            humidityPercent: weather.humidityPercent,
            humidityNote: 'Relative humidity from 0 to 100. The hub reports this as a 0 to 1 fraction and it is converted here.',
            pressureBar: weather.pressureBar,
            pressureMillibar: weather.pressureMillibar,
            pressureNote: 'Homey reports pressure in bar with no unit field of its own; the millibar figure is the same value and is what a forecast quotes as hectopascals.',
          },
          forecast: includeForecast
            ? {
                granularity: 'daily',
                granularityNote: `This forecast is DAILY. Each of the ${weather.daily.length} entries covers one whole day: its timestamp names the day rather than an hour within it, and "date" is that day. temperatureMin is the low across the day, which in practice is the following night; temperatureMax is the daytime high. Do not read an entry as an hour.`,
                dayCount: weather.daily.length,
                days: weather.daily,
              }
            : null,
          hourlyForecast: hourly,
          limitations:
            'One reading for one location from Homey\'s weather provider. It is not measured in this house, so it cannot stand in for an outdoor sensor in the garden and says nothing about any individual room.',
        }

        return successResult(renderWeatherText(weather, includeForecast, hourly), structuredContent)
      } catch (error) {
        return failureResult(error, { operation: 'homey_weather', logger: context.logger })
      }
    },
  )
}

// ---------------------------------------------------------------------------
// The hourly forecast, which is a different question from the hourly route
// ---------------------------------------------------------------------------

export interface HourlyForecastResult {
  available: boolean
  source: HourlyForecastSource | null
  hourCount: number
  hours: WeatherForecastEntry[]
  /** Always a plain sentence, including when there is no hourly forecast. Absence here is not a failure. */
  note: string
}

function skippedHourlyForecast(includeForecast: boolean): HourlyForecastResult {
  return {
    available: false,
    source: null,
    hourCount: 0,
    hours: [],
    note: includeForecast
      ? 'Not fetched: includeHourlyForecast was false. Call again with it unset to see whether this Homey offers one.'
      : 'Not fetched: includeForecast was false, which turns off the forecast entirely.',
  }
}

/**
 * Answers "does this hub give hourly data" from the two places it can come from.
 *
 * The weather reading first, because on the reference hardware that is the only
 * place hourly entries exist and they are already in hand. The separate route
 * second, and only when the startup probe did not already settle that it is
 * absent, so a hub that has the route still gets it and the hub this was built
 * against is never asked twice for a 404. A registry with no probe recorded is
 * an unknown rather than a no, so the route is tried in that case.
 *
 * Absence is never an error in any branch: the whole point of the note is that a
 * caller assuming hourly data must be told plainly that it does not exist here.
 */
async function resolveHourlyForecast(context: ServerContext, weather: NormalisedWeather): Promise<HourlyForecastResult> {
  const timezone = context.connection.identity.timezone

  if (weather.hourly.length > 0) {
    return {
      available: true,
      source: 'weather_reading',
      hourCount: weather.hourly.length,
      hours: weather.hourly,
      note: `This Homey carries ${weather.hourly.length} hourly entries inside its weather reading, covering roughly the next ${weather.hourly.length} hours. Beyond that the forecast is daily.`,
    }
  }

  const probe = context.capabilities.probes?.['weatherHourlyForecast']
  if (probe !== undefined && probe.status !== 'available') {
    return {
      available: false,
      source: null,
      hourCount: 0,
      hours: [],
      note:
        probe.status === 'unsupported'
          ? `This Homey has no hourly forecast. Its weather reading carries daily entries only, and ${HOURLY_FORECAST_PATH} is absent on this hardware, which is normal for the 2019 generation rather than a fault. Reason about whole days here, and use homey_insights_query on the logs owned by homey:manager:weather for finer-grained history of what has already happened.`
          : `Whether this Homey offers an hourly forecast could not be established: the startup probe of ${HOURLY_FORECAST_PATH} came back "${probe.status}". Only the daily forecast is reported. Run homey_doctor for the probe detail.`,
    }
  }

  try {
    const callers = context.connection.api as RawCaller
    const raw = await context.connection.request(
      () => callers.call({ method: 'GET', path: HOURLY_FORECAST_PATH }),
      `GET ${HOURLY_FORECAST_PATH}`,
      true,
    )

    const hours = normaliseForecastEntries(extractForecastArray(raw), timezone)
    if (hours.length === 0) {
      return {
        available: false,
        source: null,
        hourCount: 0,
        hours: [],
        note: `${HOURLY_FORECAST_PATH} answered on this Homey but carried no forecast entries this server recognises. Only the daily forecast is reported. This route does not exist on the hardware this server was built against, so please run "homey-mcp doctor --report" and file that output so it can be supported properly.`,
      }
    }

    return {
      available: true,
      source: 'hourly_forecast_route',
      hourCount: hours.length,
      hours,
      note: `${hours.length} hourly entries from ${HOURLY_FORECAST_PATH}, which this Homey offers as a separate route. The daily forecast above covers the days after them.`,
    }
  } catch (error) {
    // Degraded rather than fatal on purpose. The reading the caller asked for is
    // already in hand, and an hourly forecast that could not be fetched is a
    // missing extra, not a failed weather lookup.
    const described = describeFailure(error, { operation: `GET ${HOURLY_FORECAST_PATH}` })
    context.logger.debug('Hourly forecast could not be fetched', { reason: described.reason })

    // An absent route is a statement about the hub, not a fetch that went wrong,
    // so it is worded as such. This branch is reached when no probe was recorded
    // to settle it earlier.
    const absent = described.reason === 'unsupported_hardware' || described.reason === 'not_found'

    return {
      available: false,
      source: null,
      hourCount: 0,
      hours: [],
      note: absent
        ? `This Homey has no hourly forecast. Its weather reading carries daily entries only, and ${HOURLY_FORECAST_PATH} is absent on this hardware, which is normal for the 2019 generation rather than a fault. Reason about whole days here.`
        : `The hourly forecast could not be fetched (${described.reason}), so only the daily forecast is reported. The current conditions above are unaffected.`,
    }
  }
}

// ---------------------------------------------------------------------------
// Wire shape to vocabulary
// ---------------------------------------------------------------------------

export interface NormaliseWeatherOptions {
  /** The hub's IANA zone from `HomeyIdentity.timezone`. Local timestamps are cut in it, never in the server's zone. */
  timezone: string
}

export function normaliseWeather(raw: unknown, options: NormaliseWeatherOptions): NormalisedWeather {
  const record = asRecord(raw)
  if (record === null) {
    // `transient` for the same reason the Insights series normaliser uses it on
    // a malformed reply: a garbled or truncated answer may well come back whole
    // on a second call, and calling it a hardware limitation would tell a model
    // to stop trying forever.
    throw new HomeyMcpError(
      'transient',
      'Homey answered the weather route with something that is not a weather reading.',
      { path: WEATHER_PATH },
    )
  }

  const observedAtUtc = asString(record['when'])

  return {
    city: asString(record['city']),
    country: asString(record['country']),
    state: asString(record['state']),
    iconId: asString(record['iconId']),
    observedAtUtc,
    observedAt: observedAtUtc === null ? null : formatIsoInTimezone(observedAtUtc, options.timezone),
    temperature: roundOrNull(asNumber(record['temperature'])),
    temperatureUnits: asString(record['temperatureUnits']),
    temperatureMin: roundOrNull(asNumber(record['temperatureMin'])),
    temperatureMax: roundOrNull(asNumber(record['temperatureMax'])),
    humidityPercent: toHumidityPercent(record['humidity']),
    pressureBar: roundOrNull(asNumber(record['pressure'])),
    pressureMillibar: toMillibar(asNumber(record['pressure'])),
    // `screensaver`, the "//" deprecation notice and `weatherId` are all left
    // behind here, which is the only place they could reach a result from.
    daily: normaliseForecastEntries(record['forecast'], options.timezone),
    hourly: normaliseForecastEntries(record['forecastHourly'], options.timezone),
  }
}

export function normaliseForecastEntries(value: unknown, timezone: string): WeatherForecastEntry[] {
  if (!Array.isArray(value)) return []

  const entries: WeatherForecastEntry[] = []
  for (const candidate of value) {
    const record = asRecord(candidate)
    if (record === null) continue

    // Unix SECONDS on this endpoint, unlike every other timestamp the hub sends,
    // which are ISO strings. An entry with no usable time is dropped rather than
    // reported with a null timestamp: a forecast point nobody can place on a
    // calendar cannot be reasoned about, and inventing "now" for it would be
    // worse than leaving it out.
    const unixSeconds = asNumber(record['time'])
    if (unixSeconds === null) continue
    const timeUtc = new Date(unixSeconds * 1000).toISOString()

    entries.push({
      time: formatIsoInTimezone(timeUtc, timezone),
      timeUtc,
      date: formatDateInTimezone(timeUtc, timezone),
      temperature: roundOrNull(asNumber(record['temperature'])),
      temperatureMin: roundOrNull(asNumber(record['temperatureMin'])),
      temperatureMax: roundOrNull(asNumber(record['temperatureMax'])),
      iconId: asString(record['iconId']),
    })
  }

  return entries
}

/**
 * The forecast array out of an hourly-route reply.
 *
 * The reference hardware has no such route, so its envelope is unverified. A
 * bare array and the two field names the weather reading itself uses are
 * accepted; anything else is reported as an unrecognised shape rather than
 * guessed at, which is what turns an untested hub into a compatibility report
 * instead of into wrong numbers.
 */
function extractForecastArray(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw

  const record = asRecord(raw)
  if (record === null) return []

  for (const field of ['forecastHourly', 'forecast']) {
    if (Array.isArray(record[field])) return record[field]
  }
  return []
}

/**
 * Relative humidity as a percentage.
 *
 * Measured: this endpoint reports 0.24 for a day the hub's own Insights log for
 * the same quantity (`homey:manager:weather:humidity`, units "%") stored as 47.
 * One hub, one quantity, two forms, so passing the number through unlabelled
 * would leave a model to read 0.24 as either a quarter or a very dry desert.
 *
 * A value above 1 is taken as an already-expressed percentage. That is a defence
 * against one specific thing rather than a general fallback: the percent form
 * demonstrably exists elsewhere on this same hub, and 1 is a legitimate reading
 * on this route (fully saturated air) so it is converted rather than passed
 * through.
 */
function toHumidityPercent(value: unknown): number | null {
  const humidity = asNumber(value)
  if (humidity === null) return null
  if (humidity > 1) return roundValue(humidity)
  // 0.24 * 100 is 24.000000000000004 in binary floating point.
  return roundValue(humidity * 100)
}

function toMillibar(pressureBar: number | null): number | null {
  return pressureBar === null ? null : roundValue(pressureBar * 1000)
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : roundValue(value)
}

// ---------------------------------------------------------------------------
// The half a person reads
// ---------------------------------------------------------------------------

function renderWeatherText(
  weather: NormalisedWeather,
  includeForecast: boolean,
  hourly: HourlyForecastResult,
): string {
  const place = weather.city === null ? 'the location set on this Homey' : `${weather.city}${weather.country === null ? '' : `, ${weather.country}`}`
  const units = weather.temperatureUnits ?? ''

  const headline = [
    `Outdoor weather for ${place}: ${formatTemperature(weather.temperature, units)}${weather.state === null ? '' : `, ${weather.state}`}.`,
    weather.humidityPercent === null ? null : `Humidity ${weather.humidityPercent}%.`,
    weather.pressureBar === null ? null : `Pressure ${weather.pressureBar} bar (${weather.pressureMillibar} mbar).`,
    weather.observedAt === null
      ? weather.observedAtUtc === null
        ? null
        : `Read at ${weather.observedAtUtc} UTC.`
      : `Read at ${weather.observedAt}.`,
    weather.temperatureMin === null && weather.temperatureMax === null
      ? null
      : `Today ranges from ${formatTemperature(weather.temperatureMin, units)} to ${formatTemperature(weather.temperatureMax, units)}.`,
  ]
    .filter((sentence): sentence is string => sentence !== null)
    .join(' ')

  const sections = [
    headline,
    'This is Homey\'s own reading for one location, not a sensor in this house.',
    includeForecast
      ? {
          heading: `Daily forecast, one entry per day (${weather.daily.length}). The minimum is that day's low, in practice the following night:`,
          lines: weather.daily.map(
            (day) =>
              `  ${day.date ?? day.timeUtc}  ${formatTemperature(day.temperature, units)}  low ${formatTemperature(day.temperatureMin, units)}, high ${formatTemperature(day.temperatureMax, units)}${day.iconId === null ? '' : `  ${day.iconId}`}`,
          ),
        }
      : null,
    includeForecast && hourly.available
      ? {
          heading: `Hourly forecast (${hourly.hourCount}):`,
          lines: hourly.hours.map(
            (hour) =>
              `  ${hour.time ?? hour.timeUtc}  ${formatTemperature(hour.temperature, units)}${hour.iconId === null ? '' : `  ${hour.iconId}`}`,
          ),
        }
      : null,
    includeForecast && !hourly.available ? hourly.note : null,
  ]

  return renderTextBlock(sections)
}

function formatTemperature(temperature: number | null, units: string): string {
  if (temperature === null) return 'unknown'
  return units === '' ? String(temperature) : `${temperature} ${units}`
}

/**
 * The same shape as the energy tool's guard, and for the same reason: a hub that
 * did not answer the route at startup should say so in the terms the probe found
 * it in, rather than repeating the failure at call time.
 */
function assertWeatherSupported(context: ServerContext): void {
  const probe = context.capabilities.probes?.['weather']
  if (probe === undefined || probe.status === 'available') return

  if (probe.status === 'forbidden') {
    throw new HomeyMcpError(
      'missing_scope',
      'This session is not allowed to read the weather, which needs the geolocation scope. Sign in again to get a session with full permissions.',
      { probe },
    )
  }

  throw new HomeyMcpError(
    'unsupported_hardware',
    'This Homey did not answer the weather route when the server probed it, so outdoor conditions are not available here. Run homey_doctor for the probe detail.',
    { probe },
  )
}
