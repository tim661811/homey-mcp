import { describe, expect, it } from 'vitest'

import { isHomeyMcpError } from '../homey/errors.js'
import { splitCanonicalCardId, toCanonicalCardId } from '../homey/types.js'
import type { HomeyConnection, HomeyIdentity, InsightsSeries } from '../homey/types.js'
import {
  asNumber,
  asRecord as sharedAsRecord,
  asString as sharedAsString,
} from '../util/coerce.js'
import {
  assertInsightsResolution,
  asFiniteNumber,
  asRecord,
  asString,
  bucketByCalendarPeriod,
  calendarPeriodKey,
  compareStatistics,
  describeWindow,
  fetchInsightsSeries,
  isInsightsResolution,
  measureCoverage,
  normaliseSeries,
  sampleSeriesEvenly,
  splitCanonicalLogId,
  toCanonicalLogId,
  summariseSeries,
} from './series.js'

// Hand-built from the shape observed on a real Homey Pro (Early 2019), firmware
// 13.2.4. It pins three quirks at once: `values` carries nulls for gaps, the
// final bucket of a live window is always still empty, and `step` is reported by
// the hub rather than implied by the resolution.
const MEASURED_TEMPERATURE_RESPONSE = {
  values: [
    { t: '2026-08-12T08:10:00.000Z', v: 20 },
    { t: '2026-08-12T08:15:00.000Z', v: 22 },
    { t: '2026-08-12T08:20:00.000Z', v: null },
    { t: '2026-08-12T08:25:00.000Z', v: 24 },
    { t: '2026-08-12T08:30:00.000Z', v: null },
  ],
  start: '2026-08-12T08:10:00.000Z',
  end: '2026-08-12T08:35:00.000Z',
  step: 300000,
  uri: 'homey:device:11111111-2222-4333-8444-555555555555',
  id: 'homey:device:11111111-2222-4333-8444-555555555555:measure_temperature',
  lastValue: 24,
  updatesIn: 84915,
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

function createFakeConnection(api: unknown): HomeyConnection {
  return {
    api,
    dialect: 'v2',
    identity: IDENTITY,
    queue: { run: async (operation) => operation(), inFlight: 0, queued: 0 },
    request: async (operation) => operation(),
  }
}

function buildSeries(values: InsightsSeries['values'], step = 300000): InsightsSeries {
  return {
    uri: 'homey:device:11111111-2222-4333-8444-555555555555',
    id: 'measure_temperature',
    start: values[0]?.t ?? '',
    end: values[values.length - 1]?.t ?? '',
    step,
    values,
    lastValue: values[values.length - 1]?.v ?? null,
    updatesIn: null,
  }
}

describe('resolution validation', () => {
  it('accepts every resolution the firmware documents', () => {
    expect(isInsightsResolution('last24Hours')).toBe(true)
    expect(assertInsightsResolution('thisWeek')).toBe('thisWeek')
  })

  // Measured: the hub answers an unknown resolution with HTTP 200 and a default
  // window instead of an error, so this guard is the only thing between a typo
  // and plausible, wrong data.
  it('rejects an unknown resolution and suggests the closest real one', () => {
    let thrown: unknown = null
    try {
      assertInsightsResolution('last24Hour')
    } catch (error) {
      thrown = error
    }

    expect(isHomeyMcpError(thrown)).toBe(true)
    if (!isHomeyMcpError(thrown)) return
    expect(thrown.reason).toBe('invalid_request')
    expect(thrown.details['suggestion']).toBe('last24Hours')
    expect(thrown.details['allowedValues']).toContain('lastMonth')
  })

  it('offers no suggestion when the value is not a typo of anything', () => {
    try {
      assertInsightsResolution('definitelyNotAResolution')
      expect.unreachable('should have thrown')
    } catch (error) {
      if (!isHomeyMcpError(error)) throw error
      expect(error.details['suggestion']).toBeUndefined()
    }
  })
})

describe('normaliseSeries', () => {
  it('reads the window and the step off the response rather than assuming them', () => {
    const { series, stepMeasuredFromTimestamps } = normaliseSeries(
      MEASURED_TEMPERATURE_RESPONSE,
      'homey:device:11111111-2222-4333-8444-555555555555:measure_temperature',
    )

    expect(series.step).toBe(300000)
    expect(stepMeasuredFromTimestamps).toBe(false)
    expect(series.start).toBe('2026-08-12T08:10:00.000Z')
    expect(series.end).toBe('2026-08-12T08:35:00.000Z')
    expect(series.values).toHaveLength(5)
    expect(series.values[2]?.v).toBeNull()
    // V2 rewrites `id` to the canonical form on the way out; the owner is
    // carried separately in `uri`, so the id here is the owner-relative one.
    expect(series.id).toBe('measure_temperature')
  })

  it('measures the step from the timestamps when the hub sends none', () => {
    const { series, stepMeasuredFromTimestamps } = normaliseSeries(
      { ...MEASURED_TEMPERATURE_RESPONSE, step: undefined },
      'homey:device:11111111-2222-4333-8444-555555555555:measure_temperature',
    )

    expect(stepMeasuredFromTimestamps).toBe(true)
    expect(series.step).toBe(300000)
  })

  it('splits a canonical log id the way the client library does', () => {
    expect(splitCanonicalLogId('homey:device:11111111-2222-4333-8444-555555555555:meter_power')).toEqual({
      uri: 'homey:device:11111111-2222-4333-8444-555555555555',
      id: 'meter_power',
    })
    expect(splitCanonicalLogId('homey:manager:weather:temperature')).toEqual({
      uri: 'homey:manager:weather',
      id: 'temperature',
    })
  })

  // A log id and a card id are the same wire shape, so the split rule that has
  // to stay identical to `homey-api`'s own has exactly one implementation. This
  // pins the delegation rather than the answer: a second copy would pass the
  // cases above on the day it was written and drift away from the library on the
  // day one of the two is corrected.
  it('splits a log id through the same implementation the card ids use', () => {
    for (const identifier of [
      'homey:device:11111111-2222-4333-8444-555555555555:meter_power',
      'homey:manager:weather:temperature',
      // Not a canonical id at all: too few segments to have an owner.
      'homey:device',
      // A short id that itself contains colons, which is where a naive split at
      // the last colon would part company with the library.
      'homey:app:com.example:one:two:three',
    ]) {
      const asCard = splitCanonicalCardId(identifier)
      expect(splitCanonicalLogId(identifier)).toEqual({ uri: asCard.ownerUri, id: asCard.shortId })
      expect(toCanonicalLogId(asCard.ownerUri, asCard.shortId)).toBe(toCanonicalCardId(asCard.ownerUri, asCard.shortId))
    }
  })
})

// The analytics modules read the same untrusted wire values as everything else,
// and "what counts as a usable value" has to be one answer rather than two that
// happen to agree today.
describe('wire coercion', () => {
  it('reads the wire through the shared coercers rather than a second copy of them', () => {
    expect(asFiniteNumber).toBe(asNumber)
    expect(asRecord).toBe(sharedAsRecord)
    expect(asString).toBe(sharedAsString)
  })
})

describe('fetchInsightsSeries', () => {
  it('sends the canonical id and the validated resolution', async () => {
    const calls: Array<{ id: string; resolution: string }> = []
    const connection = createFakeConnection({
      insights: {
        getLogEntries: async (options: { id: string; resolution: string }) => {
          calls.push(options)
          return MEASURED_TEMPERATURE_RESPONSE
        },
      },
    })

    const fetched = await fetchInsightsSeries(connection, {
      logId: 'homey:device:11111111-2222-4333-8444-555555555555:measure_temperature',
      resolution: 'last24Hours',
    })

    expect(calls).toEqual([
      {
        id: 'homey:device:11111111-2222-4333-8444-555555555555:measure_temperature',
        resolution: 'last24Hours',
      },
    ])
    expect(fetched.series.values).toHaveLength(5)
  })

  it('never reaches the hub with a resolution the allow-list does not know', async () => {
    let called = false
    const connection = createFakeConnection({
      insights: {
        getLogEntries: async () => {
          called = true
          return MEASURED_TEMPERATURE_RESPONSE
        },
      },
    })

    await expect(
      fetchInsightsSeries(connection, {
        logId: 'homey:device:11111111-2222-4333-8444-555555555555:measure_temperature',
        // Deliberately bypasses the compile-time type, which is what a tool
        // argument coming off the wire effectively does.
        resolution: 'lastFortnight' as never,
      }),
    ).rejects.toThrow(/not an Insights resolution/)
    expect(called).toBe(false)
  })
})

describe('numeric statistics', () => {
  it('skips gaps instead of treating them as zero, and reports the coverage it used', () => {
    const { series } = normaliseSeries(
      MEASURED_TEMPERATURE_RESPONSE,
      'homey:device:11111111-2222-4333-8444-555555555555:measure_temperature',
    )
    const statistics = summariseSeries(series, { kind: 'number' })

    expect(statistics.numeric?.count).toBe(3)
    expect(statistics.numeric?.mean).toBe(22)
    expect(statistics.numeric?.min).toBe(20)
    expect(statistics.numeric?.max).toBe(24)
    expect(statistics.numeric?.median).toBe(22)
    expect(statistics.numeric?.first).toBe(20)
    expect(statistics.numeric?.last).toBe(24)
    expect(statistics.numeric?.delta).toBe(4)
    expect(statistics.coverage.presentCount).toBe(3)
    expect(statistics.coverage.bucketCount).toBe(5)
    expect(statistics.coverage.percent).toBe(60)
    expect(statistics.coverage.gapCount).toBe(2)
    expect(statistics.coverage.longestGapMs).toBe(300000)
  })

  it('warns loudly when the average covers a minority of the window', () => {
    const statistics = summariseSeries(
      buildSeries([
        { t: '2026-08-12T08:00:00.000Z', v: 10 },
        { t: '2026-08-12T08:05:00.000Z', v: null },
        { t: '2026-08-12T08:10:00.000Z', v: null },
        { t: '2026-08-12T08:15:00.000Z', v: null },
      ]),
      { kind: 'number' },
    )

    expect(statistics.coverage.percent).toBe(25)
    expect(statistics.warnings.join(' ')).toMatch(/minority of the period/)
  })

  it('returns nulls rather than NaN when every bucket is empty', () => {
    const statistics = summariseSeries(
      buildSeries([
        { t: '2026-08-12T08:00:00.000Z', v: null },
        { t: '2026-08-12T08:05:00.000Z', v: null },
      ]),
      { kind: 'number' },
    )

    expect(statistics.numeric?.mean).toBeNull()
    expect(statistics.numeric?.delta).toBeNull()
    expect(statistics.warnings.join(' ')).toMatch(/Every bucket/)
  })

  it('measures coverage over an empty window without dividing by zero', () => {
    expect(measureCoverage(buildSeries([])).fraction).toBeNull()
  })
})

describe('boolean statistics', () => {
  // Measured: a boolean log reports its lastValue as 0 or 1, not as false or
  // true, so the caller has to pass the log's declared type.
  it('treats a wire value of 0 and 1 as off and on', () => {
    const statistics = summariseSeries(
      buildSeries([
        { t: '2026-08-12T08:00:00.000Z', v: 0 },
        { t: '2026-08-12T08:05:00.000Z', v: 1 },
        { t: '2026-08-12T08:10:00.000Z', v: 1 },
        { t: '2026-08-12T08:15:00.000Z', v: null },
      ]),
      { kind: 'boolean' },
    )

    expect(statistics.numeric).toBeNull()
    expect(statistics.boolean?.trueCount).toBe(2)
    expect(statistics.boolean?.falseCount).toBe(1)
    expect(statistics.boolean?.transitionCount).toBe(1)
    expect(statistics.boolean?.dutyCycle).toBeCloseTo(2 / 3, 6)
    expect(statistics.boolean?.last).toBe(true)
  })

  it('counts a bucket the hub averaged as a partial share of the time', () => {
    const statistics = summariseSeries(
      buildSeries([
        { t: '2026-08-12T08:00:00.000Z', v: 0.5 },
        { t: '2026-08-12T08:05:00.000Z', v: 0.5 },
      ]),
      { kind: 'boolean' },
    )

    expect(statistics.boolean?.fractionalCount).toBe(2)
    expect(statistics.boolean?.dutyCycle).toBe(0.5)
    expect(statistics.boolean?.trueMs).toBe(300000)
  })
})

describe('comparison between two windows', () => {
  it('reports the delta and the percentage change', () => {
    const current = summariseSeries(
      buildSeries([
        { t: '2026-08-12T08:00:00.000Z', v: 21 },
        { t: '2026-08-12T08:05:00.000Z', v: 23 },
      ]),
      { kind: 'number' },
    )
    const previous = summariseSeries(
      buildSeries([
        { t: '2026-08-05T08:00:00.000Z', v: 19 },
        { t: '2026-08-05T08:05:00.000Z', v: 21 },
      ]),
      { kind: 'number' },
    )

    const comparison = compareStatistics(current, previous)

    expect(comparison.comparable).toBe(true)
    expect(comparison.numeric?.mean.current).toBe(22)
    expect(comparison.numeric?.mean.previous).toBe(20)
    expect(comparison.numeric?.mean.delta).toBe(2)
    expect(comparison.numeric?.mean.percentChange).toBe(10)
  })

  it('returns no percentage against a zero baseline rather than Infinity', () => {
    const current = summariseSeries(buildSeries([{ t: '2026-08-12T08:00:00.000Z', v: 5 }]), { kind: 'number' })
    const previous = summariseSeries(buildSeries([{ t: '2026-08-05T08:00:00.000Z', v: 0 }]), { kind: 'number' })

    const comparison = compareStatistics(current, previous)

    expect(comparison.numeric?.mean.delta).toBe(5)
    expect(comparison.numeric?.mean.percentChange).toBeNull()
    expect(comparison.warnings.join(' ')).toMatch(/zero/)
  })

  it('flags a comparison where the two windows are covered very differently', () => {
    const current = summariseSeries(
      buildSeries([
        { t: '2026-08-12T08:00:00.000Z', v: 21 },
        { t: '2026-08-12T08:05:00.000Z', v: 21 },
      ]),
      { kind: 'number' },
    )
    const previous = summariseSeries(
      buildSeries([
        { t: '2026-08-05T08:00:00.000Z', v: 19 },
        { t: '2026-08-05T08:05:00.000Z', v: null },
      ]),
      { kind: 'number' },
    )

    expect(compareStatistics(current, previous).warnings.join(' ')).toMatch(/missing data rather than a real change/)
  })
})

describe('calendar windows in the hub timezone', () => {
  // Measured: the hub's own default 24 hour window started at 22:00Z, which is
  // midnight in its CEST zone. Bucketing by UTC would put the last two hours of
  // every summer evening on the wrong day.
  it('cuts the day at local midnight, not at 00:00 UTC', () => {
    const buckets = bucketByCalendarPeriod(
      buildSeries([
        { t: '2026-08-12T21:55:00.000Z', v: 20 },
        { t: '2026-08-12T22:00:00.000Z', v: 24 },
      ]),
      { timezone: 'Europe/Amsterdam', period: 'day', kind: 'number' },
    )

    expect(buckets.map((bucket) => bucket.key)).toEqual(['2026-08-12', '2026-08-13'])
    expect(buckets[0]?.statistics.numeric?.mean).toBe(20)
    expect(buckets[1]?.statistics.numeric?.mean).toBe(24)
  })

  it('puts the same two instants on one UTC day, which is the bug being avoided', () => {
    expect(calendarPeriodKey('2026-08-12T21:55:00.000Z', 'UTC', 'day')).toBe('2026-08-12')
    expect(calendarPeriodKey('2026-08-12T22:00:00.000Z', 'UTC', 'day')).toBe('2026-08-12')
  })

  it('keys hours, weeks and months in local time', () => {
    expect(calendarPeriodKey('2026-08-12T22:00:00.000Z', 'Europe/Amsterdam', 'hour')).toBe('2026-08-13T00')
    // 13 August 2026 is a Thursday, so its week starts on Monday the 10th.
    expect(calendarPeriodKey('2026-08-12T22:00:00.000Z', 'Europe/Amsterdam', 'week')).toBe('2026-08-10')
    expect(calendarPeriodKey('2026-08-31T22:00:00.000Z', 'Europe/Amsterdam', 'month')).toBe('2026-09')
  })

  it('refuses to bucket rather than falling back to UTC when the hub reported no timezone', () => {
    expect(() =>
      bucketByCalendarPeriod(buildSeries([{ t: '2026-08-12T22:00:00.000Z', v: 1 }]), {
        timezone: '',
        period: 'day',
      }),
    ).toThrow(/not a timezone/)
  })

  it('renders the window in the hub zone and says so when it cannot', () => {
    const series = buildSeries([
      { t: '2026-08-12T21:55:00.000Z', v: 20 },
      { t: '2026-08-12T22:00:00.000Z', v: 24 },
    ])

    expect(describeWindow(series, 'Europe/Amsterdam').localStart).toBe('2026-08-12 23:55 GMT+2')
    expect(describeWindow(series, '').localStart).toBeNull()
    expect(describeWindow(series, '').timezone).toBeNull()
  })
})

describe('sampleSeriesEvenly', () => {
  it('returns everything when it fits the budget', () => {
    const values = [
      { t: '2026-08-12T08:00:00.000Z', v: 1 },
      { t: '2026-08-12T08:05:00.000Z', v: 2 },
    ]
    expect(sampleSeriesEvenly(values, 10)).toEqual({
      values,
      stride: 1,
      returnedCount: 2,
      totalCount: 2,
      truncated: false,
    })
  })

  it('thins a long series but keeps the most recent reading', () => {
    const values = Array.from({ length: 100 }, (_unused, index) => ({
      t: new Date(Date.UTC(2026, 7, 12, 0, index * 5)).toISOString(),
      v: index,
    }))

    const sampled = sampleSeriesEvenly(values, 10)

    expect(sampled.truncated).toBe(true)
    expect(sampled.stride).toBe(10)
    expect(sampled.values[0]?.v).toBe(0)
    expect(sampled.values[sampled.values.length - 1]?.v).toBe(99)
    expect(sampled.totalCount).toBe(100)
  })
})
