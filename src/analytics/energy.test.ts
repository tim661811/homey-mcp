import { describe, expect, it } from 'vitest'

import type { InsightsSeries } from '../homey/types.js'
import {
  classifyEnergyLog,
  deriveUnmonitoredLoad,
  normaliseLiveReport,
  summariseEnergySeries,
} from './energy.js'

// Hand-built from the shape of a real `GET /api/manager/energy/live` response.
// It pins four things measured on the hub: the wire spells the watts field `W`,
// zone and device items add up exactly to `totalConsumed`, a whole-home meter
// arrives as a third item type (`cumulative`) that the domain vocabulary does
// not model, and an item can report a null draw, which is "unknown" rather than
// "zero".
const MEASURED_LIVE_REPORT = {
  zoneId: 'aaaaaaaa-1111-4222-8333-444444444444',
  zoneName: 'Home',
  zoneIcon: 'home',
  currency: 'EUR',
  totalConsumed: { W: 186.18, cost: 0.0446832 },
  totalCumulative: { W: -56, cost: -0.01344 },
  totalGenerated: { W: null, cost: null },
  items: [
    { type: 'zone', id: 'zone-office', name: 'Office', icon: 'office', values: { W: 129.95, cost: 0.031188 } },
    { type: 'zone', id: 'zone-living', name: 'Living room', icon: 'living', values: { W: 33.65, cost: 0.008076 } },
    { type: 'zone', id: 'zone-hall', name: 'Hall', icon: 'default', values: { W: 20, cost: 0.0048 } },
    { type: 'zone', id: 'zone-spare', name: 'Spare room', icon: 'bedroom', values: { W: null, cost: null } },
    {
      type: 'device',
      id: 'dddddddd-1111-4222-8333-444444444444',
      name: 'Fridge',
      values: { W: 2.58, cost: 0.0006192 },
      isHomeBattery: false,
      isEVCharger: false,
      approximated: true,
      canApproximate: false,
    },
    {
      type: 'device',
      id: 'dddddddd-2222-4333-8444-555555555555',
      name: 'Car charger',
      values: { W: null, cost: null },
      isHomeBattery: false,
      isEVCharger: true,
      approximated: false,
      canApproximate: true,
    },
    {
      type: 'cumulative',
      id: 'cccccccc-1111-4222-8333-444444444444',
      name: 'Smart meter',
      values: { W: -56, cost: -0.01344 },
      includedInTotal: true,
    },
  ],
}

function buildSeries(values: InsightsSeries['values'], id: string, step = 300000): InsightsSeries {
  return {
    uri: 'homey:device:11111111-2222-4333-8444-555555555555',
    id,
    start: values[0]?.t ?? '',
    end: values[values.length - 1]?.t ?? '',
    step,
    values,
    lastValue: values[values.length - 1]?.v ?? null,
    updatesIn: null,
  }
}

describe('normaliseLiveReport', () => {
  it('maps the wire vocabulary onto the domain one', () => {
    const report = normaliseLiveReport(MEASURED_LIVE_REPORT)

    expect(report.currency).toBe('EUR')
    expect(report.totalConsumed).toEqual({ watts: 186.18, cost: 0.0446832 })
    expect(report.totalGenerated).toEqual({ watts: null, cost: null })
    expect(report.items).toHaveLength(6)
    expect(report.items.every((item) => item.type === 'zone' || item.type === 'device')).toBe(true)
  })

  it('keeps the whole-home meter out of the device list instead of dropping it', () => {
    const report = normaliseLiveReport(MEASURED_LIVE_REPORT)

    expect(report.cumulativeMeters).toEqual([
      {
        id: 'cccccccc-1111-4222-8333-444444444444',
        name: 'Smart meter',
        values: { watts: -56, cost: -0.01344 },
        includedInTotal: true,
      },
    ])
  })

  it('reads the firmware spelling isEVCharger as an electric car', () => {
    const carCharger = normaliseLiveReport(MEASURED_LIVE_REPORT).items.find((item) => item.name === 'Car charger')

    expect(carCharger?.isElectricCar).toBe(true)
    expect(carCharger?.values.watts).toBeNull()
  })

  it('marks an estimated draw as estimated', () => {
    const fridge = normaliseLiveReport(MEASURED_LIVE_REPORT).items.find((item) => item.name === 'Fridge')

    expect(fridge?.approximated).toBe(true)
  })

  it('prefers the zone and device indexes for names, so a rename shows up at once', () => {
    const report = normaliseLiveReport(MEASURED_LIVE_REPORT, {
      zoneNameById: new Map([['zone-office', 'Study']]),
      deviceById: new Map([
        ['dddddddd-1111-4222-8333-444444444444', { name: 'Kitchen fridge', zoneName: 'Kitchen' }],
      ]),
    })

    expect(report.items.find((item) => item.id === 'zone-office')?.name).toBe('Study')
    const fridge = report.items.find((item) => item.id === 'dddddddd-1111-4222-8333-444444444444')
    expect(fridge?.name).toBe('Kitchen fridge')
    expect(fridge?.zoneName).toBe('Kitchen')
  })

  it('survives a report with nothing in it', () => {
    const report = normaliseLiveReport({})

    expect(report.items).toEqual([])
    expect(report.unmonitored.watts).toBeNull()
    expect(report.unmonitored.basis).toBe('not_derivable')
  })
})

describe('unmonitored load', () => {
  it('is a lower bound when nothing measures generation', () => {
    const report = normaliseLiveReport(MEASURED_LIVE_REPORT)

    // The whole-home meter reads less than the attributed devices, which can
    // only happen when something is generating power that Homey cannot see.
    expect(report.unmonitored.basis).toBe('not_derivable')
    expect(report.unmonitored.watts).toBeNull()
    expect(report.unmonitored.reason).toMatch(/generated somewhere that Homey does not measure/)
    expect(report.unmonitored.itemsWithUnknownDraw).toBe(2)
  })

  it('subtracts what Homey can name from the whole-home meter when both are known', () => {
    const unmonitored = deriveUnmonitoredLoad({
      items: [],
      totalConsumed: { watts: 400, cost: null },
      totalCumulative: { watts: 1000, cost: null },
      totalGenerated: { watts: null, cost: null },
    })

    expect(unmonitored.watts).toBe(600)
    expect(unmonitored.basis).toBe('lower_bound')
    expect(unmonitored.reason).toMatch(/least the unmonitored load can be/)
  })

  it('adds measured generation back before subtracting', () => {
    const unmonitored = deriveUnmonitoredLoad({
      items: [],
      totalConsumed: { watts: 400, cost: null },
      totalCumulative: { watts: -100, cost: null },
      totalGenerated: { watts: 900, cost: null },
    })

    expect(unmonitored.watts).toBe(400)
    expect(unmonitored.basis).toBe('measured')
    expect(unmonitored.reason).toBeNull()
  })

  it('says so rather than guessing when there is no whole-home meter', () => {
    const unmonitored = deriveUnmonitoredLoad({
      items: [],
      totalConsumed: { watts: 400, cost: null },
      totalCumulative: { watts: null, cost: null },
      totalGenerated: { watts: null, cost: null },
    })

    expect(unmonitored.watts).toBeNull()
    expect(unmonitored.basis).toBe('not_derivable')
    expect(unmonitored.reason).toMatch(/no whole-home meter/)
  })
})

describe('classifyEnergyLog', () => {
  it('separates a cumulative counter from an instantaneous reading', () => {
    expect(classifyEnergyLog('homey:device:11111111-2222-4333-8444-555555555555:meter_power')).toBe(
      'cumulative_meter',
    )
    expect(classifyEnergyLog('homey:device:11111111-2222-4333-8444-555555555555:measure_power')).toBe(
      'instantaneous_power',
    )
    expect(classifyEnergyLog('homey:device:11111111-2222-4333-8444-555555555555:measure_power.imported')).toBe(
      'instantaneous_power',
    )
    expect(classifyEnergyLog('homey:device:11111111-2222-4333-8444-555555555555:measure_temperature')).toBe(
      'not_energy',
    )
  })

  it('accepts a bare capability id as well as a canonical one', () => {
    expect(classifyEnergyLog('meter_water')).toBe('cumulative_meter')
  })
})

describe('cumulative meter summaries', () => {
  it('takes the difference between endpoints and refuses to call an average consumption', () => {
    const summary = summariseEnergySeries(
      buildSeries(
        [
          { t: '2026-08-12T08:00:00.000Z', v: 1000 },
          { t: '2026-08-12T08:05:00.000Z', v: 1001 },
          { t: '2026-08-12T09:00:00.000Z', v: 1004 },
        ],
        'meter_power',
      ),
      { logId: 'homey:device:11111111-2222-4333-8444-555555555555:meter_power', units: 'kWh' },
    )

    expect(summary?.kind).toBe('cumulative_meter')
    if (summary?.kind !== 'cumulative_meter') return
    expect(summary.consumed).toBe(4)
    expect(summary.unit).toBe('kWh')
    expect(summary.averageRatePerHour).toBe(4)
    expect(summary.warnings.join(' ')).toMatch(/average is not a meaningful quantity/)
  })

  it('survives a meter that was reset mid-window', () => {
    const summary = summariseEnergySeries(
      buildSeries(
        [
          { t: '2026-08-12T08:00:00.000Z', v: 1000 },
          { t: '2026-08-12T08:05:00.000Z', v: 1002 },
          { t: '2026-08-12T08:10:00.000Z', v: 0 },
          { t: '2026-08-12T08:15:00.000Z', v: 3 },
        ],
        'meter_power',
      ),
      { logId: 'homey:device:11111111-2222-4333-8444-555555555555:meter_power', units: 'kWh' },
    )

    if (summary?.kind !== 'cumulative_meter') throw new Error('expected a cumulative meter summary')
    expect(summary.resetCount).toBe(1)
    // The endpoint difference is nonsense after a reset; the rising steps are not.
    expect(summary.consumed).toBe(-997)
    expect(summary.consumedIgnoringResets).toBe(5)
    expect(summary.warnings.join(' ')).toMatch(/reset or the device was replaced/)
  })

  it('explains that a gap costs a cumulative counter nothing', () => {
    const summary = summariseEnergySeries(
      buildSeries(
        [
          { t: '2026-08-12T08:00:00.000Z', v: 1000 },
          { t: '2026-08-12T08:05:00.000Z', v: null },
          { t: '2026-08-12T08:10:00.000Z', v: 1006 },
        ],
        'meter_power',
      ),
      { logId: 'homey:device:11111111-2222-4333-8444-555555555555:meter_power', units: 'kWh' },
    )

    if (summary?.kind !== 'cumulative_meter') throw new Error('expected a cumulative meter summary')
    expect(summary.consumed).toBe(6)
    expect(summary.warnings.join(' ')).toMatch(/keeps counting while Homey is not sampling/)
  })
})

describe('instantaneous power summaries', () => {
  it('integrates watts over time instead of differencing them', () => {
    // A steady 1000 W for one hour is 1 kWh, whatever the endpoints say.
    const summary = summariseEnergySeries(
      buildSeries(
        [
          { t: '2026-08-12T08:00:00.000Z', v: 1000 },
          { t: '2026-08-12T08:30:00.000Z', v: 1000 },
          { t: '2026-08-12T09:00:00.000Z', v: 1000 },
        ],
        'measure_power',
        1_800_000,
      ),
      { logId: 'homey:device:11111111-2222-4333-8444-555555555555:measure_power', units: 'W' },
    )

    if (summary?.kind !== 'instantaneous_power') throw new Error('expected an instantaneous power summary')
    expect(summary.energyWattHours).toBe(1000)
    expect(summary.energyKilowattHours).toBe(1)
    expect(summary.meanWatts).toBe(1000)
    expect(summary.coveredMs).toBe(3_600_000)
    expect(summary.uncoveredMs).toBe(0)
  })

  it('leaves a gap out of the total rather than interpolating across it', () => {
    const summary = summariseEnergySeries(
      buildSeries(
        [
          { t: '2026-08-12T08:00:00.000Z', v: 1000 },
          { t: '2026-08-12T08:30:00.000Z', v: 1000 },
          { t: '2026-08-12T09:00:00.000Z', v: null },
          { t: '2026-08-12T09:30:00.000Z', v: 1000 },
        ],
        'measure_power',
        1_800_000,
      ),
      { logId: 'homey:device:11111111-2222-4333-8444-555555555555:measure_power', units: 'W' },
    )

    if (summary?.kind !== 'instantaneous_power') throw new Error('expected an instantaneous power summary')
    // Only the first half hour is covered by two real readings.
    expect(summary.energyWattHours).toBe(500)
    expect(summary.coveredMs).toBe(1_800_000)
    expect(summary.uncoveredMs).toBe(3_600_000)
    expect(summary.coveredFraction).toBeCloseTo(1 / 3, 6)
    expect(summary.warnings.join(' ')).toMatch(/left out of the energy total rather than interpolated/)
  })

  it('returns nothing at all for a log that is not about energy', () => {
    expect(
      summariseEnergySeries(
        buildSeries([{ t: '2026-08-12T08:00:00.000Z', v: 21 }], 'measure_temperature'),
        { logId: 'homey:device:11111111-2222-4333-8444-555555555555:measure_temperature', units: '°C' },
      ),
    ).toBeNull()
  })
})
