// Statistics over an Insights series.
//
// Three measured facts about this firmware shape everything in this file, and
// ignoring any one of them produces numbers that look right and are wrong.
//
//   1. `values` contains nulls wherever the hub has no sample. Every statistic
//      here skips nulls rather than treating them as zero, and every result
//      carries the coverage it was computed over, because a mean over 40 percent
//      of a window is not a mean of that window.
//   2. An unrecognised `resolution` is answered with HTTP 200 and a default
//      window instead of an error, so a typo yields plausible but wrong data.
//      Every resolution is checked against the allow-list before it is sent.
//   3. Calendar windows are cut in the hub's own timezone, not UTC and not the
//      timezone of the process running this server. The default window observed
//      on the hub started at 22:00Z, which is midnight in its CEST zone. So any
//      re-bucketing into days, weeks or months has to be done in the hub's zone.

import { HomeyMcpError } from '../homey/errors.js'
import { INSIGHTS_RESOLUTIONS, splitCanonicalCardId, toCanonicalCardId } from '../homey/types.js'
import type {
  HomeyConnection,
  InsightsEntry,
  InsightsResolution,
  InsightsSeries,
} from '../homey/types.js'
import { asNumber, asRecord, asString } from '../util/coerce.js'

// The wire coercers live in `util/coerce.ts` and are re-exported here under the
// names this module's existing callers already import. Two copies of "what
// counts as a usable value off the wire" is the kind of duplication that drifts:
// one copy gains a NaN guard, the other does not, and the two halves of the same
// analytics pipeline then disagree about whether a reading exists.
export { asRecord, asString }
/** `asNumber` under the name this module has always used for it. */
export { asNumber as asFiniteNumber }

// ---------------------------------------------------------------------------
// Resolution validation
// ---------------------------------------------------------------------------

export function isInsightsResolution(value: unknown): value is InsightsResolution {
  return typeof value === 'string' && (INSIGHTS_RESOLUTIONS as readonly string[]).includes(value)
}

/**
 * Returns the resolution, or throws with the full allow-list attached.
 *
 * This is the client-side guard the firmware does not provide: it answers an
 * unknown resolution with a default window and a 200, so nothing downstream can
 * tell a typo from a deliberate request.
 */
export function assertInsightsResolution(value: string, argumentName = 'resolution'): InsightsResolution {
  if (isInsightsResolution(value)) return value

  const closest = closestResolution(value)

  throw new HomeyMcpError(
    'invalid_request',
    `"${value}" is not an Insights resolution.${closest === null ? '' : ` Did you mean "${closest}"?`} Homey silently answers an unknown resolution with a default window instead of an error, so this request was stopped here rather than returning data for a period nobody asked for.`,
    {
      argument: argumentName,
      received: value,
      allowedValues: [...INSIGHTS_RESOLUTIONS],
      ...(closest === null ? {} : { suggestion: closest }),
    },
  )
}

function closestResolution(value: string): InsightsResolution | null {
  const normalised = value.toLowerCase()
  let best: InsightsResolution | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const candidate of INSIGHTS_RESOLUTIONS) {
    const distance = editDistance(normalised, candidate.toLowerCase())
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }

  // Beyond a third of the word being wrong it is a different request, not a typo,
  // and suggesting something unrelated is worse than suggesting nothing.
  return bestDistance <= Math.max(2, Math.floor(normalised.length / 3)) ? best : null
}

/** Levenshtein distance. Only ever run over short identifiers, so the simple table is fine. */
export function editDistance(left: string, right: string): number {
  if (left === right) return 0
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length

  let previousRow = Array.from({ length: right.length + 1 }, (_unused, index) => index)

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const currentRow: number[] = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
      const deletion = (previousRow[rightIndex] ?? 0) + 1
      const insertion = (currentRow[rightIndex - 1] ?? 0) + 1
      const substitution = (previousRow[rightIndex - 1] ?? 0) + substitutionCost
      currentRow.push(Math.min(deletion, insertion, substitution))
    }
    previousRow = currentRow
  }

  return previousRow[right.length] ?? 0
}

// ---------------------------------------------------------------------------
// Fetching and normalising
// ---------------------------------------------------------------------------

/** The canonical Insights log id, `homey:device:<uuid>:measure_temperature`. */
export type InsightsLogId = string

export interface FetchedSeries {
  series: InsightsSeries
  /**
   * True when the response carried no usable `step` and the bucket width had to
   * be measured from the timestamps instead. Never assumed from the resolution.
   */
  stepMeasuredFromTimestamps: boolean
}

interface InsightsManager {
  insights: {
    getLogEntries(options: { id: string; resolution: string }): Promise<unknown>
  }
}

export interface FetchInsightsSeriesOptions {
  logId: InsightsLogId
  resolution: InsightsResolution
}

/**
 * Reads one series.
 *
 * Deliberately fetches a single log: the hub rate limits its own local API after
 * four rapid requests, so callers wanting several series await them one at a
 * time rather than fanning out.
 */
export async function fetchInsightsSeries(
  connection: HomeyConnection,
  options: FetchInsightsSeriesOptions,
): Promise<FetchedSeries> {
  const resolution = assertInsightsResolution(options.resolution)
  const managers = connection.api as InsightsManager

  const raw = await connection.request(
    () => managers.insights.getLogEntries({ id: options.logId, resolution }),
    'insights.getLogEntries',
    true,
  )

  return normaliseSeries(raw, options.logId)
}

/**
 * Splits a canonical log id into the owner URI and the log's own id.
 *
 * The rule is `homey-api`'s own, `uri = id.split(':', 3).join(':')`, and it has
 * exactly one implementation: `splitCanonicalCardId` in `homey/types.ts`. A log
 * id and a card id are the same wire shape, so a second copy of the rule here
 * could only ever drift away from the library it has to match. Only the field
 * names differ, because the Insights routes speak of a `uri` and an `id`.
 */
export function splitCanonicalLogId(logId: InsightsLogId): { uri: string; id: string } {
  const { ownerUri, shortId } = splitCanonicalCardId(logId)
  return { uri: ownerUri, id: shortId }
}

/** The exact inverse, and likewise the library's rule rather than a second copy of it. */
export function toCanonicalLogId(uri: string, id: string): InsightsLogId {
  return toCanonicalCardId(uri, id)
}

export function normaliseSeries(raw: unknown, requestedLogId: InsightsLogId): FetchedSeries {
  const record = asRecord(raw)
  if (record === null) {
    throw new HomeyMcpError('transient', 'Homey answered the Insights query with something that is not a series.', {
      logId: requestedLogId,
    })
  }

  const values = normaliseEntries(record['values'])
  const wireStep = asNumber(record['step'])
  const measuredStep = wireStep === null || wireStep <= 0 ? measureStepFromTimestamps(values) : null

  const requested = splitCanonicalLogId(requestedLogId)
  const uri = asString(record['uri']) ?? requested.uri
  const wireId = asString(record['id'])
  // V2 rewrites `id` back to the canonical form on the way out, V3 echoes what
  // was sent. Anything shorter than the canonical form is the owner-relative id,
  // so it gets its owner back.
  const id = wireId === null ? requested.id : wireId.includes(':') ? splitCanonicalLogId(wireId).id : wireId

  const series: InsightsSeries = {
    uri,
    id,
    start: asString(record['start']) ?? values[0]?.t ?? '',
    end: asString(record['end']) ?? values[values.length - 1]?.t ?? '',
    step: wireStep !== null && wireStep > 0 ? wireStep : (measuredStep ?? 0),
    values,
    lastValue: asSeriesValue(record['lastValue']),
    updatesIn: asNumber(record['updatesIn']),
  }

  return { series, stepMeasuredFromTimestamps: measuredStep !== null }
}

function normaliseEntries(raw: unknown): InsightsEntry[] {
  if (!Array.isArray(raw)) return []

  const entries: InsightsEntry[] = []
  for (const candidate of raw) {
    const record = asRecord(candidate)
    if (record === null) continue

    const timestamp = record['t']
    const isoTimestamp =
      typeof timestamp === 'string'
        ? timestamp
        : typeof timestamp === 'number' && Number.isFinite(timestamp)
          ? new Date(timestamp).toISOString()
          : null
    if (isoTimestamp === null) continue

    entries.push({ t: isoTimestamp, v: asSeriesValue(record['v']) })
  }

  return entries
}

/** The most common gap between consecutive timestamps. Measured, not inferred from the resolution. */
function measureStepFromTimestamps(values: InsightsEntry[]): number | null {
  if (values.length < 2) return null

  const gapCounts = new Map<number, number>()
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (previous === undefined || current === undefined) continue
    const gap = Date.parse(current.t) - Date.parse(previous.t)
    if (!Number.isFinite(gap) || gap <= 0) continue
    gapCounts.set(gap, (gapCounts.get(gap) ?? 0) + 1)
  }

  let mostCommonGap: number | null = null
  let mostCommonCount = 0
  for (const [gap, count] of gapCounts) {
    if (count > mostCommonCount) {
      mostCommonGap = gap
      mostCommonCount = count
    }
  }

  return mostCommonGap
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export type SeriesKind = 'number' | 'boolean'

export interface SeriesCoverage {
  bucketCount: number
  presentCount: number
  missingCount: number
  /** Non-null buckets over total buckets, 0 to 1. Null when the window has no buckets at all. */
  fraction: number | null
  percent: number | null
  gapCount: number
  /** Longest run of consecutive empty buckets, expressed in milliseconds via the bucket width. */
  longestGapMs: number
  /** Total time inside the window with no sample at all. */
  missingMs: number
}

export interface NumericStatistics {
  count: number
  min: number | null
  minAt: string | null
  max: number | null
  maxAt: string | null
  mean: number | null
  median: number | null
  first: number | null
  firstAt: string | null
  last: number | null
  lastAt: string | null
  /** Last minus first, across the non-null endpoints of the window. */
  delta: number | null
  standardDeviation: number | null
}

export interface BooleanStatistics {
  count: number
  trueCount: number
  falseCount: number
  /**
   * Buckets whose value is strictly between false and true. The hub averages
   * within a bucket, so a boolean log at a coarse resolution can report 0.25.
   */
  fractionalCount: number
  /** Share of the covered time the log was true, 0 to 1. Fractional buckets count proportionally. */
  dutyCycle: number | null
  /** Duty cycle applied to the covered time. Approximate: buckets are samples, not exact edges. */
  trueMs: number | null
  falseMs: number | null
  transitionCount: number
  first: boolean | null
  firstAt: string | null
  last: boolean | null
  lastAt: string | null
}

export interface SeriesStatistics {
  kind: SeriesKind
  coverage: SeriesCoverage
  /** Null for a boolean log: min, max and mean over true and false mislead more than they explain. */
  numeric: NumericStatistics | null
  /** Null for a numeric log. */
  boolean: BooleanStatistics | null
  warnings: string[]
}

/** Below this share of covered buckets an average stops describing the whole window. */
export const LOW_COVERAGE_THRESHOLD = 0.9
/** Below this share an average describes a minority of the window and must not be quoted bare. */
export const UNRELIABLE_COVERAGE_THRESHOLD = 0.5

export interface SummariseSeriesOptions {
  /**
   * The log's declared type. Pass it. A boolean log arrives as 0 and 1 on the
   * wire, so the values alone cannot tell a switch from a sensor.
   */
  kind?: SeriesKind
  lowCoverageThreshold?: number
  unreliableCoverageThreshold?: number
}

export function summariseSeries(series: InsightsSeries, options: SummariseSeriesOptions = {}): SeriesStatistics {
  const kind = options.kind ?? inferSeriesKind(series.values)
  const coverage = measureCoverage(series)
  const warnings: string[] = []

  const lowThreshold = options.lowCoverageThreshold ?? LOW_COVERAGE_THRESHOLD
  const unreliableThreshold = options.unreliableCoverageThreshold ?? UNRELIABLE_COVERAGE_THRESHOLD

  if (coverage.fraction === null) {
    warnings.push('Homey returned no buckets for this window, so there is nothing to summarise.')
  } else if (coverage.presentCount === 0) {
    warnings.push('Every bucket in this window is empty, so no statistic could be computed.')
  } else if (coverage.fraction < unreliableThreshold) {
    warnings.push(
      `Only ${formatPercent(coverage.fraction)} of this window carries a sample, so these statistics describe a minority of the period. Do not quote the average without this figure.`,
    )
  } else if (coverage.fraction < lowThreshold) {
    warnings.push(
      `${formatPercent(coverage.fraction)} of this window carries a sample. Gaps are skipped rather than filled in, so the average covers only the sampled time.`,
    )
  }

  if (kind === 'number') {
    return { kind, coverage, numeric: computeNumericStatistics(series.values), boolean: null, warnings }
  }

  return { kind, coverage, numeric: null, boolean: computeBooleanStatistics(series.values, series.step), warnings }
}

/**
 * Best guess at the kind when the caller has no log descriptor to hand.
 *
 * Only a series that is entirely made of real booleans counts as boolean, since
 * the hub sends boolean logs as 0 and 1 and a numeric log of zeroes and ones is
 * indistinguishable from them here. Callers that know the log type must pass it.
 */
export function inferSeriesKind(values: InsightsEntry[]): SeriesKind {
  let sawBoolean = false
  for (const entry of values) {
    if (entry.v === null) continue
    if (typeof entry.v !== 'boolean') return 'number'
    sawBoolean = true
  }
  return sawBoolean ? 'boolean' : 'number'
}

export function measureCoverage(series: InsightsSeries): SeriesCoverage {
  const bucketCount = series.values.length
  let presentCount = 0
  let gapCount = 0
  let currentGap = 0
  let longestGap = 0

  for (const entry of series.values) {
    if (entry.v === null) {
      if (currentGap === 0) gapCount += 1
      currentGap += 1
      if (currentGap > longestGap) longestGap = currentGap
      continue
    }
    presentCount += 1
    currentGap = 0
  }

  const missingCount = bucketCount - presentCount

  return {
    bucketCount,
    presentCount,
    missingCount,
    fraction: bucketCount === 0 ? null : roundValue(presentCount / bucketCount),
    percent: bucketCount === 0 ? null : roundValue((presentCount / bucketCount) * 100),
    gapCount,
    longestGapMs: longestGap * series.step,
    missingMs: missingCount * series.step,
  }
}

function computeNumericStatistics(values: InsightsEntry[]): NumericStatistics {
  const samples: Array<{ value: number; at: string }> = []
  for (const entry of values) {
    const numeric = toNumericValue(entry.v)
    if (numeric === null) continue
    samples.push({ value: numeric, at: entry.t })
  }

  const first = samples[0] ?? null
  const last = samples[samples.length - 1] ?? null

  if (first === null || last === null) {
    return {
      count: 0,
      min: null,
      minAt: null,
      max: null,
      maxAt: null,
      mean: null,
      median: null,
      first: null,
      firstAt: null,
      last: null,
      lastAt: null,
      delta: null,
      standardDeviation: null,
    }
  }

  let minimum = first
  let maximum = first
  let total = 0
  for (const sample of samples) {
    if (sample.value < minimum.value) minimum = sample
    if (sample.value > maximum.value) maximum = sample
    total += sample.value
  }

  const mean = total / samples.length
  const variance =
    samples.length < 2
      ? 0
      : samples.reduce((accumulator, sample) => accumulator + (sample.value - mean) ** 2, 0) / (samples.length - 1)

  const sorted = samples.map((sample) => sample.value).sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? null)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2

  return {
    count: samples.length,
    min: roundValue(minimum.value),
    minAt: minimum.at,
    max: roundValue(maximum.value),
    maxAt: maximum.at,
    mean: roundValue(mean),
    median: median === null ? null : roundValue(median),
    first: roundValue(first.value),
    firstAt: first.at,
    last: roundValue(last.value),
    lastAt: last.at,
    delta: roundValue(last.value - first.value),
    standardDeviation: roundValue(Math.sqrt(variance)),
  }
}

function computeBooleanStatistics(values: InsightsEntry[], stepMs: number): BooleanStatistics {
  const samples: Array<{ share: number; at: string }> = []
  let trueCount = 0
  let falseCount = 0
  let fractionalCount = 0
  let transitionCount = 0
  let previousCrisp: boolean | null = null
  let first: { value: boolean; at: string } | null = null
  let last: { value: boolean; at: string } | null = null

  for (const entry of values) {
    const share = toBooleanShare(entry.v)
    if (share === null) continue
    samples.push({ share, at: entry.t })

    if (share === 1 || share === 0) {
      const crisp = share === 1
      if (crisp) trueCount += 1
      else falseCount += 1
      if (previousCrisp !== null && previousCrisp !== crisp) transitionCount += 1
      previousCrisp = crisp
      if (first === null) first = { value: crisp, at: entry.t }
      last = { value: crisp, at: entry.t }
      continue
    }

    fractionalCount += 1
  }

  if (samples.length === 0) {
    return {
      count: 0,
      trueCount: 0,
      falseCount: 0,
      fractionalCount: 0,
      dutyCycle: null,
      trueMs: null,
      falseMs: null,
      transitionCount: 0,
      first: null,
      firstAt: null,
      last: null,
      lastAt: null,
    }
  }

  const dutyCycle = samples.reduce((accumulator, sample) => accumulator + sample.share, 0) / samples.length
  const coveredMs = samples.length * stepMs

  return {
    count: samples.length,
    trueCount,
    falseCount,
    fractionalCount,
    dutyCycle: roundValue(dutyCycle),
    trueMs: Math.round(dutyCycle * coveredMs),
    falseMs: Math.round((1 - dutyCycle) * coveredMs),
    transitionCount,
    first: first?.value ?? null,
    firstAt: first?.at ?? null,
    last: last?.value ?? null,
    lastAt: last?.at ?? null,
  }
}

/** Maps a wire value onto the share of the bucket the log was true, or null when there is no sample. */
export function toBooleanShare(value: number | boolean | null): number | null {
  if (value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (!Number.isFinite(value)) return null
  if (value < 0 || value > 1) return null
  return value
}

export function toNumericValue(value: number | boolean | null): number | null {
  if (value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  return Number.isFinite(value) ? value : null
}

// ---------------------------------------------------------------------------
// Comparison between two windows
// ---------------------------------------------------------------------------

export interface StatisticDifference {
  current: number | null
  previous: number | null
  /** Current minus previous. Null when either side is missing. */
  delta: number | null
  /** Change relative to the previous value, in percent. Null when the previous value is zero or missing. */
  percentChange: number | null
}

export interface SeriesComparison {
  kind: SeriesKind
  /**
   * False when the two windows cannot be lined up: different log kinds, or one
   * of them empty. The differences are still reported, but a reader must not
   * present them as an answer.
   */
  comparable: boolean
  numeric: Record<'min' | 'max' | 'mean' | 'median' | 'first' | 'last' | 'delta', StatisticDifference> | null
  boolean: Record<'dutyCycle' | 'trueMs' | 'transitionCount', StatisticDifference> | null
  coverage: StatisticDifference
  warnings: string[]
}

export function compareStatistics(current: SeriesStatistics, previous: SeriesStatistics): SeriesComparison {
  const warnings: string[] = []
  const comparable = current.kind === previous.kind && current.coverage.presentCount > 0 && previous.coverage.presentCount > 0

  if (current.kind !== previous.kind) {
    warnings.push(
      `The two windows are different kinds of log (${current.kind} against ${previous.kind}), so they cannot be compared.`,
    )
  }
  if (current.coverage.presentCount === 0 || previous.coverage.presentCount === 0) {
    warnings.push('One of the two windows has no samples at all, so the difference is not meaningful.')
  }
  if (
    current.coverage.fraction !== null &&
    previous.coverage.fraction !== null &&
    Math.abs(current.coverage.fraction - previous.coverage.fraction) > 0.2
  ) {
    warnings.push(
      `The two windows are covered very differently (${formatPercent(current.coverage.fraction)} against ${formatPercent(previous.coverage.fraction)}), so part of the difference is missing data rather than a real change.`,
    )
  }

  const coverage = difference(current.coverage.percent, previous.coverage.percent, warnings, 'coverage')

  if (current.numeric !== null && previous.numeric !== null) {
    return {
      kind: current.kind,
      comparable,
      numeric: {
        min: difference(current.numeric.min, previous.numeric.min, warnings, 'min'),
        max: difference(current.numeric.max, previous.numeric.max, warnings, 'max'),
        mean: difference(current.numeric.mean, previous.numeric.mean, warnings, 'mean'),
        median: difference(current.numeric.median, previous.numeric.median, warnings, 'median'),
        first: difference(current.numeric.first, previous.numeric.first, warnings, 'first'),
        last: difference(current.numeric.last, previous.numeric.last, warnings, 'last'),
        delta: difference(current.numeric.delta, previous.numeric.delta, warnings, 'delta'),
      },
      boolean: null,
      coverage,
      warnings,
    }
  }

  if (current.boolean !== null && previous.boolean !== null) {
    return {
      kind: current.kind,
      comparable,
      numeric: null,
      boolean: {
        dutyCycle: difference(current.boolean.dutyCycle, previous.boolean.dutyCycle, warnings, 'dutyCycle'),
        trueMs: difference(current.boolean.trueMs, previous.boolean.trueMs, warnings, 'trueMs'),
        transitionCount: difference(
          current.boolean.transitionCount,
          previous.boolean.transitionCount,
          warnings,
          'transitionCount',
        ),
      },
      coverage,
      warnings,
    }
  }

  return { kind: current.kind, comparable: false, numeric: null, boolean: null, coverage, warnings }
}

function difference(
  current: number | null,
  previous: number | null,
  warnings: string[],
  label: string,
): StatisticDifference {
  if (current === null || previous === null) {
    return { current, previous, delta: null, percentChange: null }
  }

  const delta = current - previous
  if (previous === 0) {
    // Dividing by a zero baseline produces Infinity, which reads as a real
    // number downstream. The absolute change is still the honest answer.
    warnings.push(`The previous window's ${label} is zero, so a percentage change cannot be computed for it.`)
    return { current: roundValue(current), previous: roundValue(previous), delta: roundValue(delta), percentChange: null }
  }

  return {
    current: roundValue(current),
    previous: roundValue(previous),
    delta: roundValue(delta),
    percentChange: roundValue((delta / Math.abs(previous)) * 100),
  }
}

// ---------------------------------------------------------------------------
// Calendar windows, cut in the hub's timezone
// ---------------------------------------------------------------------------

export type CalendarPeriod = 'hour' | 'day' | 'week' | 'month'

export interface CalendarBucket {
  /** Local calendar key: `2026-08-12T10` for an hour, `2026-08-12` for a day or the Monday of a week, `2026-08` for a month. */
  key: string
  /** First and last instant that fell into this bucket, as UTC timestamps. */
  start: string
  end: string
  statistics: SeriesStatistics
}

export interface BucketByCalendarPeriodOptions {
  /** IANA zone from `HomeyIdentity.timezone`. The hub's zone, never the server's. */
  timezone: string
  period: CalendarPeriod
  kind?: SeriesKind
}

export function isValidTimezone(timezone: string): boolean {
  if (timezone.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/**
 * Re-cuts a series into local calendar periods.
 *
 * Measured: the hub's own default window starts at 22:00Z, which is midnight in
 * its CEST zone. Bucketing by UTC days would therefore put two hours of every
 * evening into the wrong day, which is exactly the sort of error that survives
 * review because the numbers still look plausible.
 */
export function bucketByCalendarPeriod(
  series: InsightsSeries,
  options: BucketByCalendarPeriodOptions,
): CalendarBucket[] {
  if (!isValidTimezone(options.timezone)) {
    throw new HomeyMcpError(
      'invalid_request',
      `Cannot cut ${options.period} buckets: "${options.timezone}" is not a timezone this system recognises. Calendar periods have to be cut in the Homey's own zone, so guessing one here would silently shift every boundary.`,
      { timezone: options.timezone, period: options.period },
    )
  }

  const kind = options.kind ?? inferSeriesKind(series.values)
  const grouped = new Map<string, InsightsEntry[]>()

  for (const entry of series.values) {
    const key = calendarPeriodKey(entry.t, options.timezone, options.period)
    if (key === null) continue
    const bucket = grouped.get(key)
    if (bucket === undefined) grouped.set(key, [entry])
    else bucket.push(entry)
  }

  return [...grouped.entries()]
    .sort(([leftKey], [rightKey]) => (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0))
    .map(([key, entries]) => {
      const bucketSeries: InsightsSeries = {
        uri: series.uri,
        id: series.id,
        start: entries[0]?.t ?? '',
        end: entries[entries.length - 1]?.t ?? '',
        step: series.step,
        values: entries,
        lastValue: entries[entries.length - 1]?.v ?? null,
        updatesIn: null,
      }
      return {
        key,
        start: bucketSeries.start,
        end: bucketSeries.end,
        statistics: summariseSeries(bucketSeries, { kind }),
      }
    })
}

/** The local calendar key an instant falls into, in the given zone. Null when the timestamp is unparseable. */
export function calendarPeriodKey(isoTimestamp: string, timezone: string, period: CalendarPeriod): string | null {
  const parts = localDateParts(isoTimestamp, timezone)
  if (parts === null) return null

  switch (period) {
    case 'hour':
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`
    case 'day':
      return `${parts.year}-${parts.month}-${parts.day}`
    case 'week':
      return startOfLocalWeek(parts)
    case 'month':
      return `${parts.year}-${parts.month}`
  }
}

interface LocalDateParts {
  year: string
  month: string
  day: string
  hour: string
  minute: string
  second: string
}

function localDateParts(isoTimestamp: string, timezone: string): LocalDateParts | null {
  const instant = Date.parse(isoTimestamp)
  if (!Number.isFinite(instant)) return null

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // h23 rather than the locale default, which renders midnight as hour 24 in
    // some ICU builds and would sort a day's first bucket to the end.
    hourCycle: 'h23',
  })

  const parts = new Map(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]))
  const year = parts.get('year')
  const month = parts.get('month')
  const day = parts.get('day')
  const hour = parts.get('hour')
  const minute = parts.get('minute')
  const second = parts.get('second')
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return null
  }

  return { year, month, day, hour, minute, second }
}

function startOfLocalWeek(parts: LocalDateParts): string {
  // The local calendar date is treated as a plain date here, so UTC arithmetic
  // on it cannot drift across a daylight saving change.
  const asPlainDate = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))
  const dayOfWeek = new Date(asPlainDate).getUTCDay()
  const daysSinceMonday = (dayOfWeek + 6) % 7
  const monday = new Date(asPlainDate - daysSinceMonday * 86_400_000)
  return monday.toISOString().slice(0, 10)
}

/**
 * The window as the hub's household would read it, for example
 * `2026-08-12 10:10 CEST`. Null when the hub reported no usable timezone, which
 * is surfaced as such rather than silently rendered in UTC.
 */
export function formatInstantInTimezone(isoTimestamp: string, timezone: string): string | null {
  if (!isValidTimezone(timezone)) return null
  const parts = localDateParts(isoTimestamp, timezone)
  if (parts === null) return null

  const zoneFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, timeZoneName: 'short' })
  const zoneName = zoneFormatter.formatToParts(new Date(isoTimestamp)).find((part) => part.type === 'timeZoneName')

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${zoneName === undefined ? '' : ` ${zoneName.value}`}`
}

/**
 * The instant as a machine-readable ISO 8601 string in the hub's zone, for
 * example `2026-08-14T13:00:00+02:00`. Null when the hub reported no usable
 * timezone or the timestamp cannot be parsed, so a caller says that rather than
 * quietly presenting UTC as local time.
 *
 * The sibling of `formatInstantInTimezone`, which renders the same instant for a
 * person to read (`2026-08-14 13:00 CEST`). Both live here because the rule they
 * share, that local time is cut in the Homey's zone and never in the server's,
 * is the same rule the calendar buckets above follow.
 */
export function formatIsoInTimezone(isoTimestamp: string, timezone: string): string | null {
  if (!isValidTimezone(timezone)) return null

  const instant = Date.parse(isoTimestamp)
  if (!Number.isFinite(instant)) return null

  const parts = localDateParts(isoTimestamp, timezone)
  if (parts === null) return null

  // The offset comes from the zone's own answer rather than from an abbreviation
  // like "CEST": reading the local wall clock back as though it were UTC and
  // subtracting the real instant is what the offset means, so this stays correct
  // across a daylight saving change and for zones with a half-hour offset,
  // without carrying a table of any of it.
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  const offsetMinutes = Math.round((asIfUtc - instant) / 60_000)
  const sign = offsetMinutes < 0 ? '-' : '+'
  const offsetHoursPart = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')
  const offsetMinutesPart = String(Math.abs(offsetMinutes) % 60).padStart(2, '0')

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${offsetHoursPart}:${offsetMinutesPart}`
}

/** The local calendar date an instant falls on, `2026-08-14`. Null when the zone is unusable. */
export function formatDateInTimezone(isoTimestamp: string, timezone: string): string | null {
  if (!isValidTimezone(timezone)) return null
  const parts = localDateParts(isoTimestamp, timezone)
  if (parts === null) return null
  return `${parts.year}-${parts.month}-${parts.day}`
}

export interface SeriesWindow {
  start: string
  end: string
  stepMs: number
  /** Rendered in the hub's zone. Null when the hub reported no timezone. */
  localStart: string | null
  localEnd: string | null
  timezone: string | null
  durationMs: number | null
}

export function describeWindow(series: InsightsSeries, timezone: string): SeriesWindow {
  const startInstant = Date.parse(series.start)
  const endInstant = Date.parse(series.end)
  const usableTimezone = isValidTimezone(timezone)

  return {
    start: series.start,
    end: series.end,
    stepMs: series.step,
    localStart: usableTimezone ? formatInstantInTimezone(series.start, timezone) : null,
    localEnd: usableTimezone ? formatInstantInTimezone(series.end, timezone) : null,
    timezone: usableTimezone ? timezone : null,
    durationMs: Number.isFinite(startInstant) && Number.isFinite(endInstant) ? endInstant - startInstant : null,
  }
}

// ---------------------------------------------------------------------------
// Bounded raw output
// ---------------------------------------------------------------------------

export interface SampledSeries {
  values: InsightsEntry[]
  /** 1 when every bucket is included, otherwise every nth bucket was taken. */
  stride: number
  returnedCount: number
  totalCount: number
  truncated: boolean
}

/**
 * Thins a series down to a point budget by taking every nth bucket.
 *
 * Sampling can step over a spike, which is why the statistics are computed over
 * every bucket and returned alongside: the extremes come from there, not from
 * this list.
 */
export function sampleSeriesEvenly(values: InsightsEntry[], maxPoints: number): SampledSeries {
  if (maxPoints <= 0) {
    return { values: [], stride: 0, returnedCount: 0, totalCount: values.length, truncated: values.length > 0 }
  }
  if (values.length <= maxPoints) {
    return { values: [...values], stride: 1, returnedCount: values.length, totalCount: values.length, truncated: false }
  }

  const stride = Math.ceil(values.length / maxPoints)
  const sampled: InsightsEntry[] = []
  for (let index = 0; index < values.length; index += stride) {
    const entry = values[index]
    if (entry !== undefined) sampled.push(entry)
  }

  // The final bucket carries the most recent reading, which is what a reader
  // usually asked for, so it is kept even when the stride skipped past it.
  const finalEntry = values[values.length - 1]
  if (finalEntry !== undefined && sampled[sampled.length - 1] !== finalEntry) sampled.push(finalEntry)

  return { values: sampled, stride, returnedCount: sampled.length, totalCount: values.length, truncated: true }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * Trims binary floating point noise (21.400000000000006) without touching the
 * measurement. Six decimals is far finer than any Homey sensor reports.
 */
export function roundValue(value: number): number {
  if (!Number.isFinite(value)) return value
  return Math.round(value * 1_000_000) / 1_000_000
}

/** One decimal is enough to keep 288 of 289 buckets away from 100 percent without turning a share into a measurement. */
const PERCENT_DECIMALS = 1

/**
 * Renders a share of something as a percentage, rounding towards zero.
 *
 * Measured: a last24Hours window on the hub's weather log answered with 288 of
 * 289 buckets. Rounded to the nearest whole percent that reads as "coverage
 * 100%", printed beside a window with a hole in it, and a reader who takes the
 * percentage alone concludes the series is complete. The whole position this
 * server takes on Insights is that an average without honest coverage is a lie,
 * so the rounding error is spent in the direction that understates: 99.65 reads
 * as 99.6, and 100% is printed only when every bucket is genuinely there.
 *
 * The bottom of the scale is the same mistake mirrored, so a share that is above
 * zero but would floor to it reads as "<0.1%" rather than as "0%".
 *
 * Only ever called with a share between 0 and 1. A signed change (this window
 * against the previous one) is a different quantity: rounding it to the nearest
 * value overstates nothing, since neither direction is the flattering one.
 */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return 'unknown'

  const percent = fraction * 100
  const scale = 10 ** PERCENT_DECIMALS
  // Binary noise is cleared first: 0.58 * 100 is 57.99999999999999, and flooring
  // that straight away would report a clean 58 percent as 57.9.
  const floored = Math.floor(roundValue(percent) * scale) / scale

  if (floored === 0 && percent > 0) return `<${1 / scale}%`
  return `${floored}%`
}

function asSeriesValue(value: unknown): number | boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}
