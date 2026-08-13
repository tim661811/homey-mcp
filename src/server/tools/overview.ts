// The tool a model calls first.
//
// Orientation has to survive a home several times larger than the one this was
// measured against (26 devices, 8 zones, 20 apps), so nothing here returns a
// per-device record except the handful that are actually broken. Everything else
// is a count, a name or a tree, which keeps the answer roughly the same size at
// 26 devices and at 260.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { toEntries } from '../../homey/cache.js'
import type { EntityIndex } from '../../homey/cache.js'
import { classifyError } from '../../homey/errors.js'
import type { DeviceSummary, FlowSummary, ZoneSummary } from '../../homey/types.js'
import type { ServerContext } from '../context.js'
import { READ_ONLY_TOOL_ANNOTATIONS } from '../createServer.js'
import { failureResult } from '../errors.js'
import { formatValue, successResult } from '../render.js'
import { asString } from '../../util/coerce.js'

// ---------------------------------------------------------------------------
// homey_home_overview
// ---------------------------------------------------------------------------

export const OVERVIEW_SECTIONS = [
  'home',
  'zones',
  'devices',
  'apps',
  'variables',
  'presence',
  'flows',
  'capabilities',
] as const

export type OverviewSection = (typeof OVERVIEW_SECTIONS)[number]

/** Every section by default: the point of the tool is that one call is enough. */
export const DEFAULT_OVERVIEW_SECTIONS: readonly OverviewSection[] = OVERVIEW_SECTIONS

/**
 * Entries per list inside a section.
 *
 * Measured against the real home: 26 devices carry about 85 distinct capability
 * ids, and listing all of them costs more context than it teaches. Fifty is
 * enough to orient, and a caller who wants the whole histogram can raise it.
 */
const DEFAULT_OVERVIEW_LIMIT = 50

interface OverviewManagers {
  apps: { getApps(): Promise<unknown> }
  users: { getUsers(): Promise<unknown> }
}

/**
 * The four fields that always appear, plus the three that only appear when the
 * app is not in its normal state.
 *
 * Twenty apps on the measured hub, and a larger home runs many more, so a null
 * placeholder per app per field is real context spent on nothing. An absent
 * `crashedMessage`, `updateAvailable` or `enabled` here means "nothing to report".
 */
interface AppSummary {
  id: string
  name: string
  version: string | null
  state: string | null
  enabled?: false
  crashed?: true
  crashedMessage?: string
  updateAvailable?: string
}

interface UserSummary {
  id: string
  name: string
  role: string | null
  present: boolean | null
  asleep: boolean | null
  enabled: boolean
}

interface ZoneNode {
  id: string
  name: string
  active: boolean
  /** Devices whose zone is exactly this one. */
  deviceCount: number
  /**
   * Devices in this zone or any zone below it. What a model means by "downstairs".
   * Absent on a zone with no children, where it would only repeat `deviceCount`.
   */
  deviceCountIncludingChildren?: number
  children: ZoneNode[]
}

/** A section the hub refused or could not answer. Reported in place, so one gap does not sink the overview. */
interface UnavailableSection {
  available: false
  reason: string
}

export function registerOverviewTools(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'homey_home_overview',
    {
      title: 'Homey home overview',
      description: [
        'Orients you in this Homey in one call: the zone tree with device counts, device counts by class,',
        'the most common capabilities, devices that are currently unavailable, installed apps, logic variables,',
        'household presence, flow counts, and what this Homey generation can actually do.',
        'Call this before any other Homey tool. It returns counts and names rather than full device records,',
        'so use homey_devices_search or homey_device_get afterwards for actual device state.',
        'Narrow it with `include` when you only need one part.',
      ].join(' '),
      inputSchema: {
        include: z
          .array(z.enum(OVERVIEW_SECTIONS))
          .optional()
          .describe('Sections to return. Defaults to all of them.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe(`Maximum entries per list inside a section. Defaults to ${DEFAULT_OVERVIEW_LIMIT}.`),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args) => {
      const requestedSections = args.include === undefined || args.include.length === 0
        ? DEFAULT_OVERVIEW_SECTIONS
        : args.include
      const limit = args.limit ?? DEFAULT_OVERVIEW_LIMIT

      try {
        return await buildOverview(context, requestedSections, limit)
      } catch (error) {
        return failureResult(error, { operation: 'homey_home_overview', logger: context.logger })
      }
    },
  )
}

async function buildOverview(
  context: ServerContext,
  sections: readonly OverviewSection[],
  limit: number,
): Promise<CallToolResult> {
  const wanted = new Set(sections)
  const structured: Record<string, unknown> = { sections: [...wanted].sort() }
  const summaryLines: string[] = []

  // Zones are loaded whenever devices are, because a device count per zone is
  // the whole point of the tree and the cache serves both from one request each.
  const needsDevices = wanted.has('devices') || wanted.has('zones')
  const devices = needsDevices ? await context.cache.getDevices() : null
  const zones = needsDevices ? await context.cache.getZones() : null

  if (wanted.has('home')) {
    const { identity, dialect } = context.connection
    structured['home'] = {
      // No `id` here on purpose, and it is the same rule homey_doctor states in
      // its header. The Homey id is the hub's Athom cloud id, which is also the
      // host part of its public https://<id>.connect.athom.com origin, so it is
      // a routable address for someone else's house. Nothing in this tool
      // surface takes a Homey id as an argument, so the model has no use for it,
      // and a tool result stays in the conversation permanently.
      name: identity.name,
      modelId: identity.modelId,
      modelName: identity.modelName,
      softwareVersion: identity.softwareVersion,
      platformVersion: identity.platformVersion,
      apiDialect: dialect,
      language: identity.language,
      timezone: identity.timezone,
      // The address itself is in no tool output at all, homey_doctor included.
      // It is a LAN address, it does not help a model decide anything, and tool
      // output is kept in the conversation permanently. The full address lives
      // in the terminal report, `npx homey-mcp doctor`, which never leaves the
      // machine it runs on.
      addressKind: identity.addressKind,
    }
    summaryLines.push(
      `${identity.modelName} "${identity.name}", firmware ${identity.softwareVersion}, API ${dialect}, timezone ${identity.timezone || 'unknown'}.`,
    )
  }

  if (wanted.has('zones') && zones !== null && devices !== null) {
    const tree = buildZoneTree(zones, devices)
    structured['zones'] = {
      count: zones.all.length,
      // No truncation here on purpose: a zone entry is a few dozen bytes and the
      // tree is the shape a model navigates by, so cutting it would cost more
      // than it saves.
      tree,
    }
  }

  if (wanted.has('devices') && devices !== null) {
    const deviceOverview = buildDeviceOverview(devices, limit)
    structured['devices'] = deviceOverview.structured
    summaryLines.push(deviceOverview.summary)
  }

  if (wanted.has('apps')) {
    const apps = await loadApps(context, limit)
    structured['apps'] = apps.structured
    if (apps.summary !== null) summaryLines.push(apps.summary)
  }

  if (wanted.has('flows')) {
    const flows = await context.cache.getFlows()
    const flowOverview = buildFlowOverview(flows)
    structured['flows'] = flowOverview.structured
    summaryLines.push(flowOverview.summary)
  }

  if (wanted.has('variables')) {
    const variables = await loadLogicVariables(context, limit)
    structured['variables'] = variables.structured
    if (variables.summary !== null) summaryLines.push(variables.summary)
  }

  if (wanted.has('presence')) {
    const presence = await loadPresence(context, limit)
    structured['presence'] = presence.structured
    if (presence.summary !== null) summaryLines.push(presence.summary)
  }

  if (wanted.has('capabilities')) {
    const { hardware, notes, probedAt, probes } = context.capabilities
    structured['capabilities'] = {
      hardware,
      probedAt,
      notes,
      probes: Object.entries(probes ?? {}).map(([name, outcome]) => ({
        name,
        status: outcome.status,
        probe: outcome.probe,
        statusCode: outcome.statusCode,
        detail: outcome.detail,
      })),
    }
    summaryLines.push(
      `Advanced Flow: ${formatValue(hardware.advancedFlow)}. Energy reports: ${formatValue(hardware.energyReports)}. Moods: ${formatValue(hardware.moods)}. Insights: ${formatValue(hardware.insights)}.`,
    )
  }

  return successResult(summaryLines.join('\n'), structured)
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export function buildZoneTree(zones: EntityIndex<ZoneSummary>, devices: EntityIndex<DeviceSummary>): ZoneNode[] {
  const directDeviceCountByZoneId = new Map<string, number>()
  for (const device of devices.all) {
    directDeviceCountByZoneId.set(device.zoneId, (directDeviceCountByZoneId.get(device.zoneId) ?? 0) + 1)
  }

  const childrenByParentId = new Map<string | null, ZoneSummary[]>()
  for (const zone of [...zones.all].sort((first, second) => first.order - second.order)) {
    // A zone whose parent is missing from the index is treated as a root rather
    // than dropped, so a device never disappears from the tree.
    const parentId = zone.parentZoneId !== null && zones.byId.has(zone.parentZoneId) ? zone.parentZoneId : null
    const siblings = childrenByParentId.get(parentId) ?? []
    siblings.push(zone)
    childrenByParentId.set(parentId, siblings)
  }

  const visitedZoneIds = new Set<string>()

  function build(zone: ZoneSummary): ZoneNode {
    // A parent cycle would otherwise recurse forever. The firmware should never
    // produce one, but the tree is built from data the server does not control.
    visitedZoneIds.add(zone.id)
    const children = (childrenByParentId.get(zone.id) ?? [])
      .filter((child) => !visitedZoneIds.has(child.id))
      .map(build)
    const deviceCount = directDeviceCountByZoneId.get(zone.id) ?? 0
    const totalDeviceCount = children.reduce(
      (total, child) => total + (child.deviceCountIncludingChildren ?? child.deviceCount),
      deviceCount,
    )

    return {
      id: zone.id,
      name: zone.name,
      active: zone.active,
      deviceCount,
      ...(children.length === 0 ? {} : { deviceCountIncludingChildren: totalDeviceCount }),
      children,
    }
  }

  return (childrenByParentId.get(null) ?? []).map(build)
}

function buildDeviceOverview(
  devices: EntityIndex<DeviceSummary>,
  limit: number,
): { structured: Record<string, unknown>; summary: string } {
  const countsByClass = new Map<string, number>()
  const countsByCapability = new Map<string, number>()
  const unavailable: DeviceSummary[] = []

  for (const device of devices.all) {
    const deviceClass = device.virtualClass ?? device.class
    countsByClass.set(deviceClass, (countsByClass.get(deviceClass) ?? 0) + 1)
    for (const capability of device.capabilities) {
      countsByCapability.set(capability, (countsByCapability.get(capability) ?? 0) + 1)
    }
    if (!device.available) unavailable.push(device)
  }

  const byClass = sortCounts(countsByClass)
  const topCapabilities = sortCounts(countsByCapability).slice(0, limit)
  const shownUnavailable = unavailable.slice(0, limit)

  const classSummary = byClass
    .slice(0, 8)
    .map((entry) => `${entry.name || 'unclassified'} ${entry.count}`)
    .join(', ')
  const summary = `${devices.all.length} devices, ${devices.all.length - unavailable.length} available, ${unavailable.length} unavailable. Classes: ${classSummary || 'none'}.`

  return {
    structured: {
      count: devices.all.length,
      availableCount: devices.all.length - unavailable.length,
      unavailableCount: unavailable.length,
      byClass,
      topCapabilities,
      capabilityCount: countsByCapability.size,
      capabilitiesTruncated: countsByCapability.size > topCapabilities.length,
      unavailable: shownUnavailable.map((device) => ({
        id: device.id,
        name: device.name,
        zoneName: device.zoneName,
        class: device.virtualClass ?? device.class,
        unavailableMessage: device.unavailableMessage,
      })),
      unavailableTruncated: unavailable.length > shownUnavailable.length,
    },
    summary,
  }
}

function buildFlowOverview(flows: EntityIndex<FlowSummary>): {
  structured: Record<string, unknown>
  summary: string
} {
  let standardCount = 0
  let advancedCount = 0
  let enabledCount = 0
  let brokenCount = 0
  let brokenKnownCount = 0
  const countsByFolder = new Map<string, number>()

  for (const flow of flows.all) {
    if (flow.kind === 'advanced') advancedCount += 1
    else standardCount += 1
    if (flow.enabled) enabledCount += 1
    // `broken` is null when the hub did not report the flag at all, which is
    // every flow on the V2 firmware: both flow transforms delete it. Counting
    // null as healthy turns "this Homey does not say" into a confident zero.
    if (flow.broken === true) brokenCount += 1
    if (flow.broken !== null) brokenKnownCount += 1
    const folderName = flow.folderName ?? '(no folder)'
    countsByFolder.set(folderName, (countsByFolder.get(folderName) ?? 0) + 1)
  }

  const brokenReported = flows.all.length === 0 || brokenKnownCount > 0

  return {
    structured: {
      count: flows.all.length,
      standardCount,
      advancedCount,
      enabledCount,
      disabledCount: flows.all.length - enabledCount,
      brokenCount,
      /** False means the count above is "not measured", not "none found". */
      brokenReportedByHomey: brokenReported,
      byFolder: sortCounts(countsByFolder),
    },
    summary: `${flows.all.length} flows (${standardCount} standard, ${advancedCount} advanced), ${enabledCount} enabled, ${
      brokenReported ? `${brokenCount} broken` : 'and this Homey does not report which flows are broken'
    }.`,
  }
}

async function loadApps(
  context: ServerContext,
  limit: number,
): Promise<{ structured: Record<string, unknown>; summary: string | null }> {
  const managers = context.connection.api as OverviewManagers
  try {
    const raw = await context.connection.request(() => managers.apps.getApps(), 'apps.getApps', true)
    const apps = toEntries(raw).map(mapApp)
    const shown = [...apps].sort((first, second) => first.name.localeCompare(second.name)).slice(0, limit)
    const runningCount = apps.filter((app) => app.state === 'running').length
    const crashedCount = apps.filter((app) => app.crashed === true).length

    return {
      structured: {
        count: apps.length,
        runningCount,
        crashedCount,
        updateAvailableCount: apps.filter((app) => app.updateAvailable !== undefined).length,
        truncated: apps.length > shown.length,
        list: shown,
      },
      summary: `${apps.length} apps installed, ${runningCount} running, ${crashedCount} crashed.`,
    }
  } catch (error) {
    // An app list that cannot be read is worth reporting in place. It is the
    // usual symptom of a session issued without the apps scope, and the rest of
    // the overview is still worth having.
    const failure = classifyError(error, { operation: 'apps.getApps' })
    const unavailable: UnavailableSection = { available: false, reason: failure.message }
    return { structured: { ...unavailable }, summary: null }
  }
}

/**
 * Logic variables, reported in place when the hub will not answer for them.
 *
 * `logic.getVariables` is one of the startup probes precisely because it is not
 * a given: a hub that does not have the route answers with "missing api method",
 * and this call sits in the middle of an eight-section overview. Letting it
 * throw took the zone tree, the devices, the apps and the flow counts down with
 * it, while `apps` and `presence` a few lines away degraded in place. Now all
 * three behave the same way.
 */
async function loadLogicVariables(
  context: ServerContext,
  limit: number,
): Promise<{ structured: Record<string, unknown>; summary: string | null }> {
  try {
    const variables = await context.cache.getLogicVariables()
    const shown = variables.all.slice(0, limit)

    return {
      structured: {
        count: variables.all.length,
        truncated: variables.all.length > shown.length,
        list: shown.map((variable) => ({
          id: variable.id,
          name: variable.name,
          type: variable.type,
          value: variable.value,
        })),
      },
      summary: `${variables.all.length} logic variables.`,
    }
  } catch (error) {
    // `notFoundMeans` matters here and does not on the two sections beside this
    // one. This route takes no name and no id, so a "not found" from it can only
    // mean the route itself is absent. Without this the section explained a
    // missing feature as "check the name or id", which is advice the caller
    // cannot act on.
    const failure = classifyError(error, {
      operation: 'logic.getVariables',
      notFoundMeans: 'unsupported_hardware',
    })
    const unavailable: UnavailableSection = { available: false, reason: failure.message }
    return { structured: { ...unavailable }, summary: null }
  }
}

async function loadPresence(
  context: ServerContext,
  limit: number,
): Promise<{ structured: Record<string, unknown>; summary: string | null }> {
  const managers = context.connection.api as OverviewManagers
  try {
    const raw = await context.connection.request(() => managers.users.getUsers(), 'users.getUsers', true)
    const users = toEntries(raw).map(mapUser)
    const shown = users.slice(0, limit)
    const presentCount = users.filter((user) => user.present === true).length

    return {
      structured: {
        count: users.length,
        presentCount,
        asleepCount: users.filter((user) => user.asleep === true).length,
        truncated: users.length > shown.length,
        users: shown,
      },
      summary: `Presence: ${users.length} household members, ${presentCount} at home.`,
    }
  } catch (error) {
    // Presence needs its own scope, so a session without it must not take the
    // rest of the overview down with it.
    const failure = classifyError(error, { operation: 'users.getUsers' })
    return { structured: { available: false, reason: failure.message }, summary: null }
  }
}

// ---------------------------------------------------------------------------
// Wire projections
// ---------------------------------------------------------------------------

/** Drops the icon, images, permissions, settings, author contact details and CPU sampling. */
function mapApp(raw: Record<string, unknown>): AppSummary {
  const crashedMessage = asString(raw['crashedMessage'])
  const updateAvailable = asString(raw['updateAvailable'])

  return {
    id: asString(raw['id']) ?? '',
    name: asString(raw['name']) ?? '',
    version: asString(raw['version']),
    state: asString(raw['state']),
    ...(raw['enabled'] === false ? { enabled: false as const } : {}),
    ...(raw['crashed'] === true ? { crashed: true as const } : {}),
    ...(crashedMessage === null ? {} : { crashedMessage }),
    ...(updateAvailable === null ? {} : { updateAvailable }),
  }
}

/** Keeps only what presence reasoning needs. `athomId` and `properties` can carry contact details. */
function mapUser(raw: Record<string, unknown>): UserSummary {
  return {
    id: asString(raw['id']) ?? '',
    name: asString(raw['name']) ?? '',
    role: asString(raw['role']),
    present: typeof raw['present'] === 'boolean' ? raw['present'] : null,
    asleep: typeof raw['asleep'] === 'boolean' ? raw['asleep'] : null,
    enabled: raw['enabled'] !== false,
  }
}

function sortCounts(counts: Map<string, number>): Array<{ name: string; count: number }> {
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((first, second) => second.count - first.count || first.name.localeCompare(second.name))
}
