// Energy arithmetic.
//
// The single most common way to get home energy wrong is to treat the two kinds
// of energy capability as one. Homey's naming convention separates them and this
// module keeps that separation visible everywhere:
//
//   `meter_power`   is a CUMULATIVE counter in kWh. It only ever goes up (until
//                   the meter is reset or replaced). Consumption over a period
//                   is the difference between its endpoints. Averaging it is
//                   meaningless: the average of an odometer is not a distance.
//                   Gaps in the series cost nothing, because the counter kept
//                   counting while Homey was not looking.
//
//   `measure_power` is an INSTANTANEOUS reading in watts. Energy over a period
//                   is its integral over time. Its average is meaningful, its
//                   difference between endpoints is not. Gaps DO cost: energy
//                   used during a gap was never sampled, so it is reported as
//                   uncovered time rather than interpolated across.
//
// The second thing this module handles is that the historical energy report
// routes answer a clean 404 on the 2019 generation. Only the live report exists
// there, so historical energy has to be rebuilt from Insights. That is a
// capability difference, not an error.

import type { EnergyAmount, EnergyLiveReport, EnergyReportItem, InsightsSeries } from '../homey/types.js'
import {
  asFiniteNumber,
  asRecord,
  asString,
  measureCoverage,
  roundValue,
  splitCanonicalLogId,
  summariseSeries,
  toNumericValue,
} from './series.js'
import type { SeriesStatistics } from './series.js'

// ---------------------------------------------------------------------------
// Live report
// ---------------------------------------------------------------------------

export interface LiveEnergyItem extends EnergyReportItem {
  /** Homey estimated this draw from the device type instead of measuring it. An estimate, not a reading. */
  approximated: boolean
  canApproximate: boolean
  /** The room a device item sits in, when the zone index knows it. Null for zone items. */
  zoneName: string | null
}

/** A whole-home meter, for example a smart meter reading the grid connection. Negative watts means export. */
export interface CumulativeMeterReading {
  id: string
  name: string
  values: EnergyAmount
  includedInTotal: boolean
}

export type UnmonitoredLoadBasis = 'measured' | 'lower_bound' | 'not_derivable'

export interface UnmonitoredLoad {
  /** Draw the hub cannot attribute to any device, in watts. Null when it cannot be derived honestly. */
  watts: number | null
  basis: UnmonitoredLoadBasis
  /** Why the figure is a lower bound or missing. Null when it was derived from measurements throughout. */
  reason: string | null
  attributedWatts: number | null
  wholeHomeWatts: number | null
  generatedWatts: number | null
  /** Devices and zones reporting no draw at all. Their real consumption, if any, is inside `watts`. */
  itemsWithUnknownDraw: number
}

export interface NormalisedEnergyLive extends EnergyLiveReport {
  items: LiveEnergyItem[]
  cumulativeMeters: CumulativeMeterReading[]
  /** Item types this vocabulary does not model yet, kept verbatim rather than dropped. */
  otherItems: Array<{ type: string; id: string; name: string; values: EnergyAmount }>
  unmonitored: UnmonitoredLoad
}

export interface EnergyLiveLookups {
  zoneNameById?: ReadonlyMap<string, string>
  deviceById?: ReadonlyMap<string, { name: string; zoneName: string }>
}

export function normaliseLiveReport(raw: unknown, lookups: EnergyLiveLookups = {}): NormalisedEnergyLive {
  const record = asRecord(raw) ?? {}

  const items: LiveEnergyItem[] = []
  const cumulativeMeters: CumulativeMeterReading[] = []
  const otherItems: NormalisedEnergyLive['otherItems'] = []

  for (const candidate of Array.isArray(record['items']) ? record['items'] : []) {
    const itemRecord = asRecord(candidate)
    if (itemRecord === null) continue

    const type = asString(itemRecord['type']) ?? ''
    const id = asString(itemRecord['id']) ?? ''
    const values = readEnergyAmount(itemRecord['values'])

    if (type === 'zone' || type === 'device') {
      const device = type === 'device' ? lookups.deviceById?.get(id) : undefined
      // The zone index is the authority on a room's current name, the same rule
      // the device cache follows, so a rename shows up here immediately.
      const name =
        (type === 'zone' ? lookups.zoneNameById?.get(id) : device?.name) ?? asString(itemRecord['name']) ?? ''

      items.push({
        type,
        id,
        name,
        values,
        isHomeBattery: itemRecord['isHomeBattery'] === true,
        // The 2019 firmware spells this `isEVCharger`; the domain type calls it
        // what it is. Both spellings are read so neither generation loses it.
        isElectricCar: itemRecord['isEVCharger'] === true || itemRecord['isElectricCar'] === true,
        approximated: itemRecord['approximated'] === true,
        canApproximate: itemRecord['canApproximate'] === true,
        zoneName: device?.zoneName ?? null,
        raw: itemRecord,
      })
      continue
    }

    if (type === 'cumulative') {
      cumulativeMeters.push({
        id,
        name: asString(itemRecord['name']) ?? '',
        values,
        includedInTotal: itemRecord['includedInTotal'] === true,
      })
      continue
    }

    otherItems.push({ type, id, name: asString(itemRecord['name']) ?? '', values })
  }

  const totalConsumed = readEnergyAmount(record['totalConsumed'])
  const totalCumulative = readEnergyAmount(record['totalCumulative'])
  const totalGenerated = readEnergyAmount(record['totalGenerated'])

  return {
    zoneId: asString(record['zoneId']) ?? '',
    zoneName: asString(record['zoneName']) ?? '',
    currency: asString(record['currency']) ?? '',
    totalConsumed,
    totalCumulative,
    totalGenerated,
    items,
    cumulativeMeters,
    otherItems,
    unmonitored: deriveUnmonitoredLoad({ items, totalConsumed, totalCumulative, totalGenerated }),
    raw,
  }
}

export interface DeriveUnmonitoredLoadInput {
  items: LiveEnergyItem[]
  totalConsumed: EnergyAmount
  totalCumulative: EnergyAmount
  totalGenerated: EnergyAmount
}

/**
 * Works out the draw the hub cannot attribute to anything.
 *
 * Measured on the hub: zone and device items add up exactly to `totalConsumed`,
 * and the whole-home meter reports separately as `totalCumulative` (negative
 * while exporting). So the unmonitored load is what the house is really using
 * minus what Homey can name.
 *
 * The trap is generation. When the house produces power that Homey does not
 * measure, the whole-home meter reads lower than real consumption, and the
 * subtraction understates the answer. Rather than assuming generation is zero,
 * which would report a confidently wrong number on any house with unmonitored
 * solar, that case is labelled: either a lower bound, or not derivable at all.
 */
export function deriveUnmonitoredLoad(input: DeriveUnmonitoredLoadInput): UnmonitoredLoad {
  const attributed = sumWatts(input.items)
  const itemsWithUnknownDraw = input.items.filter((item) => item.values.watts === null).length
  const wholeHomeWatts = input.totalCumulative.watts
  const generatedWatts = input.totalGenerated.watts
  const attributedWatts = input.totalConsumed.watts ?? attributed

  const shared = { attributedWatts, wholeHomeWatts, generatedWatts, itemsWithUnknownDraw }

  if (wholeHomeWatts === null) {
    return {
      ...shared,
      watts: null,
      basis: 'not_derivable',
      reason:
        'This Homey has no whole-home meter reading, so there is nothing to compare the attributed devices against. Add a smart meter device to see unmonitored load.',
    }
  }

  if (attributedWatts === null) {
    return {
      ...shared,
      watts: null,
      basis: 'not_derivable',
      reason: 'Homey reported no total for the attributed devices, so the difference cannot be taken.',
    }
  }

  if (generatedWatts !== null) {
    return {
      ...shared,
      watts: roundValue(wholeHomeWatts + generatedWatts - attributedWatts),
      basis: 'measured',
      reason: null,
    }
  }

  if (wholeHomeWatts >= attributedWatts) {
    return {
      ...shared,
      watts: roundValue(wholeHomeWatts - attributedWatts),
      basis: 'lower_bound',
      reason:
        'No generation is being measured. Any solar or battery output would add to this figure, so it is the least the unmonitored load can be, not the exact value.',
    }
  }

  return {
    ...shared,
    watts: null,
    basis: 'not_derivable',
    reason:
      'The whole-home meter reads less than the devices Homey can account for, which means power is being generated somewhere that Homey does not measure. Until that generation is measured the unmonitored load cannot be separated from it.',
  }
}

function sumWatts(items: LiveEnergyItem[]): number | null {
  let total = 0
  let sawValue = false
  for (const item of items) {
    if (item.values.watts === null) continue
    total += item.values.watts
    sawValue = true
  }
  return sawValue ? roundValue(total) : null
}

function readEnergyAmount(raw: unknown): EnergyAmount {
  const record = asRecord(raw)
  if (record === null) return { watts: null, cost: null }
  // The wire calls the field `W`. The domain type spells it out.
  return { watts: asFiniteNumber(record['W']), cost: asFiniteNumber(record['cost']) }
}

// ---------------------------------------------------------------------------
// Historical energy, rebuilt from Insights
// ---------------------------------------------------------------------------

export type EnergySeriesKind = 'cumulative_meter' | 'instantaneous_power' | 'not_energy'

/**
 * Which of the two kinds of energy log this is, from Homey's own capability
 * naming: `meter_*` counts up forever, `measure_*` reports right now.
 */
export function classifyEnergyLog(logId: string, units: string | null = null): EnergySeriesKind {
  const { id } = splitCanonicalLogId(logId)
  const shortId = id === '' ? logId : id

  if (shortId.startsWith('meter_')) return 'cumulative_meter'
  // Sub-capabilities are suffixed with a dot, for example `measure_power.total`.
  if (shortId === 'measure_power' || shortId.startsWith('measure_power.')) return 'instantaneous_power'
  if (units === 'W' && shortId.startsWith('measure_')) return 'instantaneous_power'

  return 'not_energy'
}

export interface CumulativeMeterSummary {
  kind: 'cumulative_meter'
  /** Taken from the log descriptor, for example `kWh`. Null when the hub did not report one. */
  unit: string | null
  firstValue: number | null
  firstAt: string | null
  lastValue: number | null
  lastAt: string | null
  /** Last reading minus first reading. This, not an average, is the consumption over the window. */
  consumed: number | null
  /** The same total with every downward step ignored, which survives a meter reset or replacement. */
  consumedIgnoringResets: number | null
  resetCount: number
  /** Time actually spanned by the two endpoints, which is shorter than the window when it starts or ends in a gap. */
  measuredDurationMs: number | null
  /** Consumption per hour across the measured span. */
  averageRatePerHour: number | null
  warnings: string[]
}

export interface InstantaneousPowerSummary {
  kind: 'instantaneous_power'
  unit: string
  meanWatts: number | null
  minWatts: number | null
  maxWatts: number | null
  /** Integral of power over the sampled time. Gaps are excluded, never interpolated across. */
  energyWattHours: number | null
  energyKilowattHours: number | null
  /** Time the integral actually covers, and the time it could not. */
  coveredMs: number
  uncoveredMs: number
  coveredFraction: number | null
  warnings: string[]
}

export type EnergySeriesSummary = CumulativeMeterSummary | InstantaneousPowerSummary

export interface EnergySeriesDescriptor {
  /** Canonical log id, or the bare capability id. */
  logId: string
  units: string | null
}

/**
 * Summarises an Insights series as energy, or returns null when the log is not
 * an energy log at all.
 *
 * This is the historical-energy path. It exists because the report endpoints
 * (`/energy/report/day|week|month|year`) answer a clean 404 on the 2019
 * generation, so the only history available there is Insights.
 */
export function summariseEnergySeries(
  series: InsightsSeries,
  descriptor: EnergySeriesDescriptor,
  statistics?: SeriesStatistics,
): EnergySeriesSummary | null {
  const kind = classifyEnergyLog(descriptor.logId, descriptor.units)
  if (kind === 'not_energy') return null
  if (kind === 'cumulative_meter') return summariseCumulativeMeter(series, descriptor)
  return summariseInstantaneousPower(series, statistics ?? summariseSeries(series, { kind: 'number' }))
}

function summariseCumulativeMeter(series: InsightsSeries, descriptor: EnergySeriesDescriptor): CumulativeMeterSummary {
  const samples: Array<{ value: number; at: string }> = []
  for (const entry of series.values) {
    const numeric = toNumericValue(entry.v)
    if (numeric === null) continue
    samples.push({ value: numeric, at: entry.t })
  }

  const warnings: string[] = [
    'This is a cumulative counter. Consumption over the window is the difference between its endpoints, and its average is not a meaningful quantity.',
  ]

  const first = samples[0] ?? null
  const last = samples[samples.length - 1] ?? null

  if (first === null || last === null) {
    warnings.push('The window contains no readings at all, so no consumption could be derived.')
    return {
      kind: 'cumulative_meter',
      unit: descriptor.units,
      firstValue: null,
      firstAt: null,
      lastValue: null,
      lastAt: null,
      consumed: null,
      consumedIgnoringResets: null,
      resetCount: 0,
      measuredDurationMs: null,
      averageRatePerHour: null,
      warnings,
    }
  }

  let resetCount = 0
  let risingTotal = 0
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]
    const current = samples[index]
    if (previous === undefined || current === undefined) continue
    const step = current.value - previous.value
    if (step < 0) {
      resetCount += 1
      continue
    }
    risingTotal += step
  }

  const consumed = last.value - first.value
  const measuredDurationMs = Date.parse(last.at) - Date.parse(first.at)
  const usableDuration = Number.isFinite(measuredDurationMs) && measuredDurationMs > 0 ? measuredDurationMs : null

  if (resetCount > 0) {
    warnings.push(
      `The counter went down ${resetCount} time${resetCount === 1 ? '' : 's'} inside this window, which means it was reset or the device was replaced. Use "consumedIgnoringResets" instead of the endpoint difference.`,
    )
  }

  const coverage = measureCoverage(series)
  if (coverage.missingCount > 0) {
    // Worth stating explicitly, because the opposite is true for measure_power
    // and the two get confused constantly.
    warnings.push(
      `${coverage.missingCount} of ${coverage.bucketCount} buckets are empty, but a cumulative counter keeps counting while Homey is not sampling, so the endpoint difference still covers the whole span between the first and last reading.`,
    )
  }

  return {
    kind: 'cumulative_meter',
    unit: descriptor.units,
    firstValue: roundValue(first.value),
    firstAt: first.at,
    lastValue: roundValue(last.value),
    lastAt: last.at,
    consumed: roundValue(consumed),
    consumedIgnoringResets: roundValue(risingTotal),
    resetCount,
    measuredDurationMs: usableDuration,
    averageRatePerHour: usableDuration === null ? null : roundValue((consumed / usableDuration) * 3_600_000),
    warnings,
  }
}

function summariseInstantaneousPower(
  series: InsightsSeries,
  statistics: SeriesStatistics,
): InstantaneousPowerSummary {
  const warnings: string[] = [
    'This is an instantaneous power reading. Energy over the window is the area under it, which is what "energyWattHours" reports. The difference between its endpoints means nothing.',
  ]

  let wattMilliseconds = 0
  let coveredMs = 0
  let uncoveredMs = 0

  for (let index = 1; index < series.values.length; index += 1) {
    const previous = series.values[index - 1]
    const current = series.values[index]
    if (previous === undefined || current === undefined) continue

    const intervalMs = Date.parse(current.t) - Date.parse(previous.t)
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) continue

    const previousWatts = toNumericValue(previous.v)
    const currentWatts = toNumericValue(current.v)

    if (previousWatts === null || currentWatts === null) {
      // Deliberately not interpolated. Power during a gap was never sampled, and
      // carrying the last reading across it would invent energy that may never
      // have been used.
      uncoveredMs += intervalMs
      continue
    }

    wattMilliseconds += ((previousWatts + currentWatts) / 2) * intervalMs
    coveredMs += intervalMs
  }

  const totalMs = coveredMs + uncoveredMs
  const coveredFraction = totalMs === 0 ? null : roundValue(coveredMs / totalMs)

  if (uncoveredMs > 0) {
    warnings.push(
      `${formatDuration(uncoveredMs)} of this window has no samples. That time is left out of the energy total rather than interpolated, so the real figure is higher by whatever was used then.`,
    )
  }

  const energyWattHours = coveredMs === 0 ? null : roundValue(wattMilliseconds / 3_600_000)

  return {
    kind: 'instantaneous_power',
    unit: 'W',
    meanWatts: statistics.numeric?.mean ?? null,
    minWatts: statistics.numeric?.min ?? null,
    maxWatts: statistics.numeric?.max ?? null,
    energyWattHours,
    energyKilowattHours: energyWattHours === null ? null : roundValue(energyWattHours / 1000),
    coveredMs,
    uncoveredMs,
    coveredFraction,
    warnings,
  }
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 60_000) return `${Math.round(durationMs / 1000)} s`
  if (durationMs < 3_600_000) return `${Math.round(durationMs / 60_000)} min`
  const hours = durationMs / 3_600_000
  return hours < 48 ? `${roundToOneDecimal(hours)} h` : `${roundToOneDecimal(hours / 24)} days`
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10
}
