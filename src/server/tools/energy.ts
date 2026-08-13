// Energy tools.
//
// Only the live report exists on the 2019 generation: the historical report
// routes (`/energy/report/day|week|month|year`) answer a clean 404 there. That
// is handled as a capability, not as a crash, and the tool says where history
// does come from instead, which is Insights on meter_power and measure_power.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { HomeyMcpError } from '../../homey/errors.js'
import type { ServerContext } from '../context.js'
import { READ_ONLY_TOOL_ANNOTATIONS } from '../createServer.js'
import { failureResult } from '../errors.js'
import { successResult } from '../render.js'
import { normaliseLiveReport } from '../../analytics/energy.js'
import type { LiveEnergyItem, NormalisedEnergyLive } from '../../analytics/energy.js'

const DEFAULT_ITEM_LIMIT = 20
const MAXIMUM_ITEM_LIMIT = 100

interface EnergyManager {
  energy: { getLiveReport(): Promise<unknown> }
}

export function registerEnergyTools(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'homey_energy_live',
    {
      title: 'Live power draw',
      description:
        'Reads what the home is drawing right now, in watts, broken down by room and by device, together with the whole-home meter reading and the load Homey cannot attribute to anything. Instantaneous only: for history use homey_insights_query on a meter_power log (a cumulative kWh counter, where consumption is the difference between its endpoints) or a measure_power log (instantaneous watts, where energy is the area under it). Homey Pro (Early 2019) has no historical energy report endpoints at all, so Insights is the only history there.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAXIMUM_ITEM_LIMIT)
          .optional()
          .describe(`Maximum rooms and devices to list, biggest draw first. Defaults to ${DEFAULT_ITEM_LIMIT}.`),
        includeItems: z
          .boolean()
          .optional()
          .describe('Include the per-room and per-device breakdown. On by default; turn it off for just the totals.'),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (rawArguments) => {
      try {
        assertLiveEnergySupported(context)

        const limit = rawArguments.limit ?? DEFAULT_ITEM_LIMIT
        const includeItems = rawArguments.includeItems !== false

        const managers = context.connection.api as EnergyManager
        const raw = await context.connection.request(
          () => managers.energy.getLiveReport(),
          'energy.getLiveReport',
          true,
        )

        // Names come from the cached indexes rather than from the report, so a
        // room renamed a minute ago reads correctly here too.
        const zones = await context.cache.getZones()
        const devices = await context.cache.getDevices()

        const report = normaliseLiveReport(raw, {
          zoneNameById: new Map(zones.all.map((zone) => [zone.id, zone.name])),
          deviceById: new Map(
            devices.all.map((device) => [device.id, { name: device.name, zoneName: device.zoneName }]),
          ),
        })

        const sortedItems = [...report.items].sort(compareByDrawDescending)
        const shownItems = includeItems ? sortedItems.slice(0, limit) : []

        const structuredContent = {
          zoneId: report.zoneId,
          zoneName: report.zoneName,
          currency: report.currency,
          totals: {
            consumed: report.totalConsumed,
            cumulative: report.totalCumulative,
            generated: report.totalGenerated,
          },
          /**
           * Homey reports `cost` as a rate rather than an amount: on the measured
           * hub every item's cost divided by its kilowatts is the same number,
           * the configured tariff.
           */
          costNote:
            'Every cost figure is a rate per hour at the current tariff, not an amount already spent.',
          impliedTariffPerKilowattHour: impliedTariff(report),
          unmonitored: report.unmonitored,
          cumulativeMeters: report.cumulativeMeters,
          otherItems: report.otherItems,
          itemCount: sortedItems.length,
          returnedItemCount: shownItems.length,
          truncated: includeItems && sortedItems.length > shownItems.length,
          items: shownItems.map((item) => ({
            type: item.type,
            id: item.id,
            name: item.name,
            zoneName: item.zoneName,
            watts: item.values.watts,
            costPerHour: item.values.cost,
            approximated: item.approximated,
            isHomeBattery: item.isHomeBattery,
            isElectricCar: item.isElectricCar,
          })),
          history: describeHistoryRoute(context),
        }

        return successResult(renderReportText(report, shownItems, sortedItems.length), structuredContent)
      } catch (error) {
        return failureResult(error, { operation: 'homey_energy_live', logger: context.logger })
      }
    },
  )
}

function renderReportText(
  report: NormalisedEnergyLive,
  shownItems: LiveEnergyItem[],
  totalItemCount: number,
): string {
  const lines: string[] = [
    `Live power in ${report.zoneName === '' ? 'the home' : report.zoneName}: ${formatWatts(report.totalConsumed.watts)} attributed to devices.`,
  ]

  if (report.totalCumulative.watts !== null) {
    lines.push(
      `Whole-home meter: ${formatWatts(report.totalCumulative.watts)}${report.totalCumulative.watts < 0 ? ' (exporting to the grid)' : ''}.`,
    )
  }
  if (report.totalGenerated.watts !== null) {
    lines.push(`Generated: ${formatWatts(report.totalGenerated.watts)}.`)
  }

  const unmonitored = report.unmonitored
  lines.push(
    unmonitored.watts === null
      ? `Unmonitored load: not derivable. ${unmonitored.reason ?? ''}`.trim()
      : `Unmonitored load: ${formatWatts(unmonitored.watts)}${unmonitored.basis === 'lower_bound' ? ' at least' : ''}. ${unmonitored.reason ?? 'Whole-home meter minus everything Homey can name.'}`.trim(),
  )

  if (unmonitored.itemsWithUnknownDraw > 0) {
    lines.push(
      `${unmonitored.itemsWithUnknownDraw} of the listed rooms and devices report no draw at all, so whatever they use sits inside the unmonitored figure.`,
    )
  }

  if (shownItems.length > 0) {
    lines.push(`Biggest draws (${shownItems.length} of ${totalItemCount}):`)
    for (const item of shownItems) {
      lines.push(
        `  ${formatWatts(item.values.watts).padStart(9)}  ${item.name} (${item.type}${item.zoneName === null ? '' : ` in ${item.zoneName}`})${item.approximated ? ' [estimated, not measured]' : ''}`,
      )
    }
  }

  for (const meter of report.cumulativeMeters) {
    lines.push(`Meter ${meter.name}: ${formatWatts(meter.values.watts)}.`)
  }

  return lines.join('\n')
}

/**
 * Cost divided by kilowatts, which was constant across every item on the
 * measured hub. Null unless at least one item carries both numbers, since a
 * tariff invented here would end up quoted as if Homey had reported it.
 */
function impliedTariff(report: NormalisedEnergyLive): number | null {
  const candidates = [report.totalConsumed, ...report.items.map((item) => item.values)]
  for (const amount of candidates) {
    if (amount.watts === null || amount.cost === null || amount.watts === 0) continue
    return Math.round((amount.cost / (amount.watts / 1000)) * 1_000_000) / 1_000_000
  }
  return null
}

function describeHistoryRoute(context: ServerContext): {
  reportEndpointsAvailable: boolean
  guidance: string
} {
  const available = context.capabilities.hardware.energyReports
  return {
    reportEndpointsAvailable: available,
    guidance: available
      ? 'This Homey answers the historical energy report routes. Live figures above are instantaneous only.'
      : 'This Homey has no historical energy report endpoints, which is normal for the 2019 generation rather than a fault. For history, call homey_insights_query on a meter_power log (cumulative kWh: take the difference between endpoints) or a measure_power log (instantaneous watts: energy is the area under it).',
  }
}

function compareByDrawDescending(left: LiveEnergyItem, right: LiveEnergyItem): number {
  const leftWatts = left.values.watts
  const rightWatts = right.values.watts
  // Items with no reading sort last: they are not zero, they are unknown, and
  // putting them at the top of a "biggest draws" list would be misleading.
  if (leftWatts === null && rightWatts === null) return left.name.localeCompare(right.name)
  if (leftWatts === null) return 1
  if (rightWatts === null) return -1
  return rightWatts - leftWatts || left.name.localeCompare(right.name)
}

function assertLiveEnergySupported(context: ServerContext): void {
  const probe = context.capabilities.probes?.['energyLive']
  if (probe === undefined || probe.status === 'available') return

  if (probe.status === 'forbidden') {
    throw new HomeyMcpError(
      'missing_scope',
      'This session is not allowed to read the energy report. Sign in again to get a session with full permissions.',
      { probe },
    )
  }

  throw new HomeyMcpError(
    'unsupported_hardware',
    'This Homey did not answer the live energy route when the server probed it, so live power is not available here. Run homey_doctor for the probe detail.',
    { probe },
  )
}

function formatWatts(watts: number | null): string {
  return watts === null ? 'unknown' : `${Math.round(watts * 100) / 100} W`
}

