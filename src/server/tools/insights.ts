// Insights tools: finding a log, and querying its history.
//
// A real hub carries 161 Insights logs, most of them titled in the household's
// own language, so a model cannot be expected to know an id. `homey_insights_search`
// exists to turn "the living room temperature sensor" into a concrete log id,
// and `homey_insights_query` never invents one.
//
// Everything numeric here goes through `analytics/series.ts`, which is where the
// three measured firmware traps are handled: nulls inside the series, a silently
// accepted invalid resolution, and calendar windows cut in the hub's timezone.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { normaliseForComparison } from '../../homey/cache.js'
import { HomeyMcpError } from '../../homey/errors.js'
import { INSIGHTS_RESOLUTIONS } from '../../homey/types.js'
import type { InsightsLogSummary, InsightsResolution } from '../../homey/types.js'
import type { ServerContext } from '../context.js'
import { READ_ONLY_TOOL_ANNOTATIONS } from '../createServer.js'
import { failureResult } from '../errors.js'
import { successResult } from '../render.js'
import {
  assertInsightsResolution,
  bucketByCalendarPeriod,
  compareStatistics,
  describeWindow,
  editDistance,
  fetchInsightsSeries,
  formatPercent,
  isValidTimezone,
  sampleSeriesEvenly,
  summariseSeries,
} from '../../analytics/series.js'
import type {
  CalendarBucket,
  CalendarPeriod,
  SampledSeries,
  SeriesComparison,
  SeriesStatistics,
  SeriesWindow,
} from '../../analytics/series.js'
import { classifyEnergyLog, summariseEnergySeries } from '../../analytics/energy.js'
import type { EnergySeriesSummary } from '../../analytics/energy.js'

const DEFAULT_SEARCH_LIMIT = 20
const MAXIMUM_SEARCH_LIMIT = 100
/** The hub rate limits after four rapid requests, and each series is one request. */
const MAXIMUM_SERIES_PER_QUERY = 5
const DEFAULT_MAX_VALUES = 100
const MAXIMUM_VALUES = 1000
const MAXIMUM_CALENDAR_BUCKETS = 200
const MAXIMUM_ASK_CHOICES = 10

export function registerInsightsTools(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'homey_insights_search',
    {
      title: 'Search sensor history logs',
      description:
        'Finds Insights logs (sensor and meter history) by fuzzy matching over room name, device name, log title, capability id and units. A Homey carries well over a hundred logs, titled in the household\'s own language, so start here: this is how "the living room temperature sensor" becomes a log id you can query. Returns candidates with their ids and never guesses which one was meant.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            'What to look for, for example "living room temperature", "power", or "measure_humidity". Words are matched against room name, device name, log title, capability id and units. Omit it to browse the first logs on the hub.',
          ),
        type: z
          .enum(['number', 'boolean'])
          .optional()
          .describe('Restrict to numeric logs (measurements) or boolean logs (on and off states).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAXIMUM_SEARCH_LIMIT)
          .optional()
          .describe(`Maximum candidates to return. Defaults to ${DEFAULT_SEARCH_LIMIT}.`),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (rawArguments) => {
      try {
        assertInsightsSupported(context)

        const limit = rawArguments.limit ?? DEFAULT_SEARCH_LIMIT
        const query = (rawArguments.query ?? '').trim()

        const logs = await context.cache.getInsightsLogs()
        // Sequential, like everything else that touches the hub: two list calls
        // fired together is half the burst that trips its rate limiter.
        const devices = await context.cache.getDevices()
        const zoneNameByDeviceId = new Map(devices.all.map((device) => [device.id, device.zoneName]))

        const searchable = logs.all
          .filter((log) => rawArguments.type === undefined || log.type === rawArguments.type)
          .map((log) => ({ log, zoneName: zoneNameByDeviceId.get(log.ownerId) ?? null }))

        const scored =
          query === ''
            ? searchable.map((entry) => ({ ...entry, score: 0, matchedOn: [] as string[] }))
            : searchable
                .map((entry) => ({ ...entry, ...scoreLog(entry.log, entry.zoneName, query) }))
                .filter((entry) => entry.score > 0)

        scored.sort(
          (left, right) =>
            right.score - left.score ||
            left.log.ownerName.localeCompare(right.log.ownerName) ||
            left.log.title.localeCompare(right.log.title),
        )

        const page = scored.slice(0, limit)
        const candidates = page.map((entry) => ({
          logId: canonicalLogId(entry.log),
          title: entry.log.title,
          ownerName: entry.log.ownerName,
          ownerType: entry.log.ownerType,
          zoneName: entry.zoneName,
          type: entry.log.type,
          units: entry.log.units,
          decimals: entry.log.decimals,
          lastValue: entry.log.lastValue,
          energyKind: classifyEnergyLog(canonicalLogId(entry.log), entry.log.units),
          matchedOn: entry.matchedOn,
          score: entry.score,
        }))

        const structuredContent = {
          query: query === '' ? null : query,
          // `totalMatches`, the name homey_devices_search, homey_flows_list and
          // both flow card lists already answer with for this same number. It
          // was `matchCount` here, a fifth tool answering one question in a
          // fourth spelling.
          totalMatches: scored.length,
          returnedCount: candidates.length,
          truncated: scored.length > candidates.length,
          totalLogCount: logs.all.length,
          candidates,
        }

        const lines =
          candidates.length === 0
            ? [
                `No Insights log matches "${query}". The hub has ${logs.all.length} logs; try a room name, a device name, or a capability id such as measure_temperature.`,
              ]
            : [
                `${scored.length} log${scored.length === 1 ? '' : 's'} match${scored.length === 1 ? 'es' : ''}${query === '' ? '' : ` "${query}"`}, showing ${candidates.length}. Pass a logId to homey_insights_query.`,
                ...candidates.map(
                  (candidate) =>
                    // Same rule as the query renderer: an owner this server
                    // cannot name is left unsaid rather than printed as a blank.
                    `  ${candidate.logId}  ${candidate.title}${candidate.units === null ? '' : ` (${candidate.units})`}${candidate.ownerName === '' ? '' : ` on ${candidate.ownerName}`}${candidate.zoneName === null ? '' : ` in ${candidate.zoneName}`}`,
                ),
              ]

        return successResult(lines.join('\n'), structuredContent)
      } catch (error) {
        return failureResult(error, { operation: 'homey_insights_search', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_insights_query',
    {
      title: 'Query sensor history',
      description:
        'Fetches up to five Insights series at one resolution and returns statistics computed over them: min, max, mean, median, first, last and delta, plus the true window and step the hub answered with and the share of it that actually carries samples. Gaps are skipped rather than filled in, so always read the coverage next to an average. Use compareWith to fetch a second window and get the differences, which is what questions like "warmer than last week" need. Energy logs are summarised correctly for their kind: meter_power is a cumulative counter, so consumption is the difference between its endpoints, while measure_power is instantaneous watts, so energy is the area under it. Find log ids with homey_insights_search first.',
      inputSchema: {
        logs: z
          .array(z.string().min(1))
          .min(1)
          .max(MAXIMUM_SERIES_PER_QUERY)
          .describe(
            `Up to ${MAXIMUM_SERIES_PER_QUERY} log ids from homey_insights_search, for example "homey:device:<device-id>:measure_temperature". A device-and-log name is accepted too, and comes back as a candidate list when it fits more than one log.`,
          ),
        resolution: z
          .enum(INSIGHTS_RESOLUTIONS)
          .optional()
          .describe('Window to fetch. Defaults to last24Hours. Calendar windows are cut in the Homey\'s own timezone.'),
        compareWith: z
          .enum(INSIGHTS_RESOLUTIONS)
          .optional()
          .describe('A second window to fetch and compare against, for example thisWeek against lastWeek.'),
        groupBy: z
          .enum(['hour', 'day', 'week', 'month'])
          .optional()
          .describe('Also return per-period statistics, cut in the Homey\'s timezone rather than UTC.'),
        includeValues: z
          .boolean()
          .optional()
          .describe('Include the individual readings as well as the statistics. Off by default: a day of data is around 290 points per log.'),
        maxValues: z
          .number()
          .int()
          .min(1)
          .max(MAXIMUM_VALUES)
          .optional()
          .describe(`Point budget per series when includeValues is set. Defaults to ${DEFAULT_MAX_VALUES}; longer series are thinned evenly and the statistics still cover every point.`),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (rawArguments) => {
      try {
        assertInsightsSupported(context)

        // Validated here as well as in the schema: the firmware answers an
        // unrecognised resolution with a default window and HTTP 200, so a value
        // that slipped past the schema would return data for a period nobody
        // asked for.
        const resolution = assertInsightsResolution(rawArguments.resolution ?? 'last24Hours')
        const compareWith =
          rawArguments.compareWith === undefined
            ? null
            : assertInsightsResolution(rawArguments.compareWith, 'compareWith')
        const groupBy = rawArguments.groupBy ?? null
        const maxValues = rawArguments.maxValues ?? DEFAULT_MAX_VALUES
        const timezone = context.connection.identity.timezone

        const resolved: InsightsLogSummary[] = []
        for (const reference of rawArguments.logs) {
          const outcome = await resolveLogReference(context, reference)
          if (outcome.status === 'ambiguous') {
            return successResult(
              `"${reference}" fits ${outcome.candidates.length} logs. Pick one and call homey_insights_query again with its logId.`,
              {
                status: 'ambiguous',
                reference,
                candidates: outcome.candidates.map((log) => ({
                  logId: canonicalLogId(log),
                  title: log.title,
                  ownerName: log.ownerName,
                  type: log.type,
                  units: log.units,
                })),
              },
            )
          }
          if (outcome.status === 'not_found') {
            throw new HomeyMcpError(
              'not_found',
              `No Insights log matches "${reference}". Use homey_insights_search to find one; this Homey has ${outcome.logCount} logs.`,
              { reference, logCount: outcome.logCount },
            )
          }
          resolved.push(outcome.log)
        }

        const results: SeriesResult[] = []
        // Serialised on purpose. Four rapid requests is enough to make the hub
        // answer "Too many requests", so series are never fetched in parallel.
        for (const log of resolved) {
          results.push(
            await querySingleSeries(context, {
              log,
              resolution,
              compareWith,
              groupBy,
              timezone,
              includeValues: rawArguments.includeValues === true,
              maxValues,
            }),
          )
        }

        const structuredContent = {
          resolution,
          compareWith,
          timezone: isValidTimezone(timezone) ? timezone : null,
          timezoneNote:
            isValidTimezone(timezone)
              ? 'Calendar windows and any groupBy buckets are cut in this zone, which is the Homey\'s own, not the server\'s.'
              : 'This Homey did not report a timezone, so local times and calendar buckets are unavailable. Times are UTC.',
          seriesCount: results.length,
          series: results,
        }

        return successResult(results.map((result) => renderSeriesText(result)).join('\n\n'), structuredContent)
      } catch (error) {
        return failureResult(error, { operation: 'homey_insights_query', logger: context.logger })
      }
    },
  )
}

// ---------------------------------------------------------------------------
// One series
// ---------------------------------------------------------------------------

interface QuerySingleSeriesOptions {
  log: InsightsLogSummary
  resolution: InsightsResolution
  compareWith: InsightsResolution | null
  groupBy: CalendarPeriod | null
  timezone: string
  includeValues: boolean
  maxValues: number
}

interface SeriesResult {
  logId: string
  title: string
  ownerName: string
  ownerType: string
  type: 'number' | 'boolean'
  units: string | null
  decimals: number | null
  window: SeriesWindow
  /** True when the hub sent no bucket width and it had to be measured from the timestamps. */
  stepMeasuredFromTimestamps: boolean
  statistics: SeriesStatistics
  energy: EnergySeriesSummary | null
  comparison: SeriesComparison | null
  comparisonWindow: SeriesWindow | null
  calendarBuckets: CalendarBucket[] | null
  calendarBucketsTruncated: boolean
  values: SampledSeries | null
}

async function querySingleSeries(
  context: ServerContext,
  options: QuerySingleSeriesOptions,
): Promise<SeriesResult> {
  const logId = canonicalLogId(options.log)
  const fetched = await fetchInsightsSeries(context.connection, { logId, resolution: options.resolution })
  const statistics = summariseSeries(fetched.series, { kind: options.log.type })

  let comparison: SeriesResult['comparison'] = null
  let comparisonWindow: SeriesResult['comparisonWindow'] = null
  if (options.compareWith !== null) {
    const previous = await fetchInsightsSeries(context.connection, { logId, resolution: options.compareWith })
    comparison = compareStatistics(statistics, summariseSeries(previous.series, { kind: options.log.type }))
    comparisonWindow = describeWindow(previous.series, options.timezone)
  }

  let calendarBuckets: SeriesResult['calendarBuckets'] = null
  let calendarBucketsTruncated = false
  if (options.groupBy !== null) {
    const buckets = bucketByCalendarPeriod(fetched.series, {
      timezone: options.timezone,
      period: options.groupBy,
      kind: options.log.type,
    })
    calendarBucketsTruncated = buckets.length > MAXIMUM_CALENDAR_BUCKETS
    calendarBuckets = buckets.slice(0, MAXIMUM_CALENDAR_BUCKETS)
  }

  return {
    logId,
    title: options.log.title,
    ownerName: options.log.ownerName,
    ownerType: options.log.ownerType,
    type: options.log.type,
    units: options.log.units,
    decimals: options.log.decimals,
    window: describeWindow(fetched.series, options.timezone),
    stepMeasuredFromTimestamps: fetched.stepMeasuredFromTimestamps,
    statistics,
    energy: summariseEnergySeries(fetched.series, { logId, units: options.log.units }, statistics),
    comparison,
    comparisonWindow,
    calendarBuckets,
    calendarBucketsTruncated,
    values: options.includeValues ? sampleSeriesEvenly(fetched.series.values, options.maxValues) : null,
  }
}

function renderSeriesText(result: SeriesResult): string {
  const unit = result.units === null ? '' : ` ${result.units}`
  const lines: string[] = [
    // A user-owned log is the one owner the cache still cannot name, and the
    // clause is dropped rather than printed empty: "Asleep on  (homey:user:...)"
    // reads as a name the renderer lost, which is worse than not claiming one.
    `${result.title}${result.ownerName === '' ? '' : ` on ${result.ownerName}`} (${result.logId})`,
    `  window ${result.window.localStart ?? result.window.start} to ${result.window.localEnd ?? result.window.end}, step ${Math.round(result.window.stepMs / 1000)} s`,
  ]

  const coverage = result.statistics.coverage
  // Rendered from the fraction through the one shared formatter, which rounds
  // towards zero. A second rounding rule here is what printed "coverage 100%"
  // next to "(288 of 289 buckets)": the counts were the only thing keeping the
  // line honest, and a model that reads the percentage alone never saw them.
  lines.push(
    `  coverage ${coverage.fraction === null ? 'unknown' : formatPercent(coverage.fraction)} (${coverage.presentCount} of ${coverage.bucketCount} buckets)`,
  )

  const numeric = result.statistics.numeric
  if (numeric !== null && numeric.count > 0) {
    lines.push(
      `  mean ${format(numeric.mean, result.decimals)}${unit}, median ${format(numeric.median, result.decimals)}, min ${format(numeric.min, result.decimals)}, max ${format(numeric.max, result.decimals)}, first ${format(numeric.first, result.decimals)}, last ${format(numeric.last, result.decimals)}, delta ${format(numeric.delta, result.decimals)}`,
    )
  }

  const booleanStatistics = result.statistics.boolean
  if (booleanStatistics !== null && booleanStatistics.count > 0) {
    lines.push(
      `  on for ${booleanStatistics.dutyCycle === null ? 'unknown' : formatPercent(booleanStatistics.dutyCycle)} of the sampled time, ${booleanStatistics.transitionCount} change${booleanStatistics.transitionCount === 1 ? '' : 's'}, now ${booleanStatistics.last === null ? 'unknown' : booleanStatistics.last ? 'on' : 'off'}`,
    )
  }

  if (result.energy !== null) {
    lines.push(
      result.energy.kind === 'cumulative_meter'
        ? `  cumulative counter: ${format(result.energy.consumed, 3)}${result.energy.unit === null ? '' : ` ${result.energy.unit}`} used across this window (endpoint difference, not an average)`
        : `  instantaneous power: ${format(result.energy.energyKilowattHours, 3)} kWh used across the sampled time (area under the curve, not a difference)`,
    )
  }

  if (result.comparison !== null) {
    const mean = result.comparison.numeric?.mean
    const dutyCycle = result.comparison.boolean?.dutyCycle
    if (mean !== undefined) {
      lines.push(
        `  compared with the other window: mean ${format(mean.current, result.decimals)} against ${format(mean.previous, result.decimals)} (${signed(mean.delta, result.decimals)}${unit}${mean.percentChange === null ? '' : `, ${signed(mean.percentChange, 1)}%`})`,
      )
    } else if (dutyCycle !== undefined) {
      lines.push(
        `  compared with the other window: on ${format(dutyCycle.current, 3)} against ${format(dutyCycle.previous, 3)} of the time`,
      )
    }
  }

  for (const warning of result.statistics.warnings) lines.push(`  note: ${warning}`)
  if (result.comparison !== null) for (const warning of result.comparison.warnings) lines.push(`  note: ${warning}`)
  if (result.energy !== null) for (const warning of result.energy.warnings) lines.push(`  note: ${warning}`)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

type LogReferenceOutcome =
  | { status: 'resolved'; log: InsightsLogSummary }
  | { status: 'ambiguous'; candidates: InsightsLogSummary[] }
  | { status: 'not_found'; logCount: number }

async function resolveLogReference(context: ServerContext, reference: string): Promise<LogReferenceOutcome> {
  const index = await context.cache.getInsightsLogs()
  const direct = index.byId.get(reference.trim())
  if (direct !== undefined) return { status: 'resolved', log: direct }

  const resolution = await context.cache.resolveInsightsLog(reference)
  if (resolution.match !== null) return { status: 'resolved', log: resolution.match }
  if (resolution.reason !== 'ambiguous' || resolution.candidates.length === 0) {
    return { status: 'not_found', logCount: index.all.length }
  }

  if (!context.askSupported) return { status: 'ambiguous', candidates: resolution.candidates }

  const choices = resolution.candidates.slice(0, MAXIMUM_ASK_CHOICES).map((log) => ({
    value: canonicalLogId(log),
    label: `${log.ownerName}: ${log.title}`,
    description: `${log.type}${log.units === null ? '' : ` in ${log.units}`}`,
  }))

  const answer = await context.ask({
    question: `Which history log did you mean by "${reference}"?`,
    choices,
    allowFreeText: false,
  })

  if (!answer.answered || answer.value === null) return { status: 'ambiguous', candidates: resolution.candidates }

  const chosen = index.byId.get(answer.value)
  return chosen === undefined
    ? { status: 'ambiguous', candidates: resolution.candidates }
    : { status: 'resolved', log: chosen }
}

// ---------------------------------------------------------------------------
// Fuzzy search
// ---------------------------------------------------------------------------

interface SearchScore {
  score: number
  matchedOn: string[]
}

const FIELD_WEIGHTS: ReadonlyArray<{ name: string; weight: number }> = [
  { name: 'title', weight: 3 },
  { name: 'ownerName', weight: 3 },
  { name: 'zoneName', weight: 2 },
  { name: 'capabilityId', weight: 2 },
  { name: 'units', weight: 1 },
]

/**
 * Scores one log against a free-text query.
 *
 * Every token has to match something, so "living room temperature" cannot be
 * satisfied by a bathroom sensor that merely happens to measure temperature.
 * The capability id is searched alongside the title because titles come back in
 * the household's own language while ids stay English: on the measured hub the
 * temperature log is titled "Temperatuur" but carries the id
 * `measure_temperature`, so an English query finds it through the id.
 */
export function scoreLog(log: InsightsLogSummary, zoneName: string | null, query: string): SearchScore {
  const fieldValues: Record<string, string> = {
    title: log.title,
    ownerName: log.ownerName,
    zoneName: zoneName ?? '',
    capabilityId: log.id,
    units: log.units ?? '',
  }

  const tokens = normaliseForComparison(query).split(' ').filter((token) => token !== '')
  if (tokens.length === 0) return { score: 0, matchedOn: [] }

  let total = 0
  const matchedOn = new Set<string>()

  for (const token of tokens) {
    let bestForToken = 0
    let bestField: string | null = null

    for (const field of FIELD_WEIGHTS) {
      const value = normaliseForComparison(fieldValues[field.name] ?? '')
      if (value === '') continue
      const tokenScore = scoreField(value, token) * field.weight
      if (tokenScore > bestForToken) {
        bestForToken = tokenScore
        bestField = field.name
      }
    }

    // One unmatched word disqualifies the log. Anything else turns a two-word
    // query into an OR and buries the answer under near misses.
    if (bestForToken === 0) return { score: 0, matchedOn: [] }

    total += bestForToken
    if (bestField !== null) matchedOn.add(bestField)
  }

  return { score: total, matchedOn: [...matchedOn] }
}

function scoreField(value: string, token: string): number {
  if (value === token) return 10

  const words = value.split(/[\s_.:-]+/).filter((word) => word !== '')
  if (words.includes(token)) return 8
  if (value.startsWith(token)) return 6
  if (words.some((word) => word.startsWith(token))) return 5
  if (value.includes(token)) return 4

  // Last resort, and only for words long enough that a small edit distance still
  // means the same word: "temperature" against the Dutch "temperatuur".
  const tolerance = token.length >= 8 ? 2 : token.length >= 5 ? 1 : 0
  if (tolerance > 0 && words.some((word) => Math.abs(word.length - token.length) <= tolerance && editDistance(word, token) <= tolerance)) {
    return 2
  }

  return 0
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function canonicalLogId(log: InsightsLogSummary): string {
  return `${log.uri}:${log.id}`
}

/**
 * Refuses only where the probe settled the question.
 *
 * `unsupported_hardware` says retrying can never help, so it is reserved for the
 * one probe outcome that means it. This used to read the registry's boolean,
 * which is false for all three of "missing", "refused" and "the probe itself
 * failed", so a probe lost to the hub's own rate limiting switched sensor
 * history off for the life of the process and told the model it was hardware.
 * The same shape as `assertLogicVariablesSupported` in devices.ts.
 */
function assertInsightsSupported(context: ServerContext): void {
  const probe = context.capabilities.probes?.['insights']

  if (probe === undefined) {
    // No probe detail was recorded, so the registry's own answer is all there
    // is. Only its `false` is a verdict about the hub: `null` means nothing
    // established it either way, and refusing the call on that would state a
    // hardware limit nobody measured.
    if (context.capabilities.hardware.insights !== false) return
    throw new HomeyMcpError(
      'unsupported_hardware',
      'This Homey did not answer the Insights routes when the server probed it, so sensor history is not available here. Run homey_doctor for the probe detail.',
      { probe: null },
    )
  }

  if (probe.status === 'unsupported') {
    throw new HomeyMcpError(
      'unsupported_hardware',
      `This Homey did not answer ${probe.probe} when the server probed it, so it has no sensor history to read. Run homey_doctor for the probe detail.`,
      { probe },
    )
  }

  if (probe.status === 'forbidden') {
    throw new HomeyMcpError(
      'missing_scope',
      `This session is not allowed to read sensor history (${probe.probe} was refused). Sign in again with "homey login" to get a session with full permissions.`,
      { probe },
    )
  }

  // Available, or a probe that merely failed. A failure leaves the question
  // open, and refusing the call over an inconclusive probe would report a
  // permanent hardware limit that was never established, so the hub answers.
}

function format(value: number | null, decimals: number | null): string {
  if (value === null) return 'unknown'
  return decimals === null ? String(value) : value.toFixed(Math.min(Math.max(decimals, 0), 6))
}

function signed(value: number | null, decimals: number | null): string {
  if (value === null) return 'unknown'
  return `${value > 0 ? '+' : ''}${format(value, decimals)}`
}

