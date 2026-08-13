// Reading and changing device state, logic variables and flow starts.
//
// The projection is the whole design here. A raw device record on the measured
// hub averages 4 KB and the largest single contributor is `images`, followed by
// `settings`, `capabilitiesObj` and `ui`. None of `images`, `icon`, `iconObj`,
// `ui`, `flags`, `data` or `settings` helps a model decide anything, and
// `settings` is actively dangerous: a real device on the measured hub stores its
// account password there. So nothing in this module ever returns
// `DeviceSummary.raw`, and the only settings-shaped field that reaches a result
// is the one the owner can already see in the app.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { normaliseForComparison } from '../../homey/cache.js'
import type { NameResolution } from '../../homey/cache.js'
import { classifyError, HomeyMcpError } from '../../homey/errors.js'
import type {
  DeviceCapabilityValue,
  DeviceInsightReference,
  DeviceSummary,
  FlowSummary,
  LogicVariableSummary,
  ZoneSummary,
} from '../../homey/types.js'
import type { ServerContext } from '../context.js'
import {
  DESTRUCTIVE_TOOL_ANNOTATIONS,
  OVERWRITE_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from '../createServer.js'
import { failureResult, invalidRequestResult } from '../errors.js'
import { successResult } from '../render.js'

const DEFAULT_SEARCH_LIMIT = 50
const MAX_SEARCH_LIMIT = 200

/**
 * Capabilities whose units read as a percentage while their range is 0..1.
 *
 * Measured on the hub: `dim` reports `units: "%"`, `min: 0`, `max: 1`. A model
 * that reads "%" and sends 60 means 60 percent, and clamping that to the maximum
 * would turn a request for "dim to 60%" into full brightness. Membership here
 * only decides whether a value between 1 and 100 is treated as a mistake worth
 * refusing; the range that is actually enforced always comes from the device's
 * own `min` and `max`.
 */
export const PERCENTAGE_UNIT_FRACTION_CAPABILITIES: ReadonlySet<string> = new Set([
  'dim',
  'light_hue',
  'light_saturation',
  'light_temperature',
  'windowcoverings_set',
  'volume_set',
  'fan_speed',
])

interface DeviceManagers {
  devices: {
    setCapabilityValue(options: {
      deviceId: string
      capabilityId: string
      value: boolean | number | string
    }): Promise<unknown>
  }
  logic: { updateVariable(options: { id: string; variable: { value: boolean | number | string } }): Promise<unknown> }
  flow: {
    triggerFlow(options: { id: string }): Promise<unknown>
    triggerAdvancedFlow(options: { id: string }): Promise<unknown>
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDevicesTools(server: McpServer, context: ServerContext): void {
  registerDevicesSearch(server, context)
  registerDeviceGet(server, context)
  registerDeviceSetCapability(server, context)
  registerVariableSet(server, context)
  registerFlowStart(server, context)
}

function registerDevicesSearch(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'homey_devices_search',
    {
      title: 'Search Homey devices',
      description: [
        'Finds devices by zone, class, capability or name, and optionally returns their live values.',
        'Set includeCapabilityValues to answer a question like "what is the state of the living room" in one call.',
        'Every filter is combined with AND. Results are projected down to what is useful for reasoning:',
        'protocol settings, icons, images and interface layout are never returned.',
        'The Homey API cannot paginate, so paging happens here: use offset with limit and check `truncated`.',
      ].join(' '),
      inputSchema: {
        zone: z.string().optional().describe('Zone name or id. Use homey_home_overview to see the zone tree.'),
        includeChildZones: z
          .boolean()
          .optional()
          .describe('Also match devices in zones below the named zone. Defaults to false.'),
        deviceClass: z
          .string()
          .optional()
          .describe('Homey device class, for example light, socket, sensor, thermostat. Matches virtualClass too.'),
        capability: z
          .string()
          .optional()
          .describe('Capability id the device must have, for example onoff or measure_temperature. Prefix match.'),
        nameContains: z.string().optional().describe('Case and accent insensitive substring of the device name.'),
        available: z.boolean().optional().describe('Filter on whether Homey can currently reach the device.'),
        includeCapabilityValues: z
          .boolean()
          .optional()
          .describe('Include the current value, unit and setable flag of every capability. Defaults to false.'),
        limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional().describe(`Defaults to ${DEFAULT_SEARCH_LIMIT}.`),
        offset: z.number().int().min(0).optional().describe('Devices to skip, for paging. Defaults to 0.'),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args) => {
      try {
        const devices = await context.cache.getDevices()
        const zones = await context.cache.getZones()

        let matchingZoneIds: Set<string> | null = null
        if (args.zone !== undefined) {
          const resolution = await context.cache.resolveZone(args.zone)
          const resolved = await resolveSingle(context, resolution, 'zone', args.zone, (zone: ZoneSummary) => zone.name)
          if ('failure' in resolved) return resolved.failure
          matchingZoneIds =
            args.includeChildZones === true
              ? collectZoneAndDescendants(resolved.match.id, zones.all)
              : new Set([resolved.match.id])
        }

        const filtered = devices.all.filter((device) =>
          matchesFilters(device, {
            zoneIds: matchingZoneIds,
            deviceClass: args.deviceClass,
            capability: args.capability,
            nameContains: args.nameContains,
            available: args.available,
          }),
        )

        const limit = args.limit ?? DEFAULT_SEARCH_LIMIT
        const offset = args.offset ?? 0
        const page = filtered.slice(offset, offset + limit)
        const includeValues = args.includeCapabilityValues === true

        const summary =
          filtered.length === 0
            ? 'No devices matched those filters.'
            : `${filtered.length} devices matched, returning ${page.length} from offset ${offset}: ${page
                .map((device) => `${device.name} (${device.zoneName})`)
                .join(', ')}.`

        return successResult(summary, {
          total: filtered.length,
          returned: page.length,
          offset,
          truncated: offset + page.length < filtered.length,
          devices: page.map((device) => projectDevice(device, includeValues)),
        })
      } catch (error) {
        return failureResult(error, { operation: 'homey_devices_search', logger: context.logger })
      }
    },
  )
}

function registerDeviceGet(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'homey_device_get',
    {
      title: 'Get one Homey device',
      description: [
        'Full detail for a single device: every capability with its live value, whether it can be set,',
        'its unit, decimals and allowed range, the energy block, and which Insights logs exist for it.',
        'Accepts a device id or a device name. Read the min and max here before calling',
        'homey_device_set_capability: several capabilities are a 0..1 fraction despite reading as a percentage.',
      ].join(' '),
      inputSchema: {
        device: z.string().describe('Device id or device name.'),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args) => {
      try {
        const resolution = await context.cache.resolveDevice(args.device)
        const resolved = await resolveSingle(context, resolution, 'device', args.device, describeDevice)
        if ('failure' in resolved) return resolved.failure

        const device = resolved.match
        const capabilityLines = Object.values(device.capabilityValues).map(
          (capability) =>
            `${capability.id}=${formatCapabilityValue(capability.value)}${capability.units === null ? '' : ` ${capability.units}`}${capability.setable ? ' (setable)' : ''}`,
        )
        const insights = await resolveDeviceInsights(context, device)

        return successResult(
          `${device.name} in ${device.zoneName}, class ${device.virtualClass ?? device.class}, ${device.available ? 'available' : 'unavailable'}. ${capabilityLines.join(', ')}`,
          {
            device: {
              ...projectDevice(device, false),
              capabilityValues: device.capabilityValues,
              insights: insights.logs,
              insightCount: insights.logs.length,
              ...(insights.unavailableReason === null
                ? {}
                : { insightsUnavailableReason: insights.unavailableReason }),
              energy: projectEnergy(device),
              driverUri: device.driverUri,
              driverId: device.driverId,
              resolvedBy: resolution.reason,
            },
          },
        )
      } catch (error) {
        return failureResult(error, { operation: 'homey_device_get', logger: context.logger })
      }
    },
  )
}

function registerDeviceSetCapability(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'homey_device_set_capability',
    {
      title: 'Set a Homey device capability',
      description: [
        'Changes one capability of one device, for example onoff, dim or target_temperature.',
        'This physically changes something in the house.',
        'Beware the percentage trap: dim, light_hue, light_saturation, light_temperature, windowcoverings_set,',
        'volume_set and fan_speed report their unit as a percentage but take a fraction between 0 and 1,',
        'so 60 percent is 0.6. A value outside the capability range is clamped to it and the clamp is reported.',
        'Call homey_device_get first when unsure of a range or of which capabilities can be set.',
      ].join(' '),
      inputSchema: {
        device: z.string().describe('Device id or device name.'),
        capability: z.string().describe('Capability id, for example onoff, dim, target_temperature.'),
        value: z
          .union([z.boolean(), z.number(), z.string()])
          .describe('The new value. Use a real JSON boolean or number, not a quoted string, where the type allows.'),
      },
      annotations: OVERWRITE_TOOL_ANNOTATIONS,
    },
    async (args) => {
      try {
        const resolution = await context.cache.resolveDevice(args.device)
        const resolved = await resolveSingle(context, resolution, 'device', args.device, describeDevice)
        if ('failure' in resolved) return resolved.failure

        const device = resolved.match
        const capability = findCapability(device, args.capability)
        if (capability === null) {
          return invalidRequestResult(
            `${device.name} has no capability called "${args.capability}".`,
            {
              device: device.name,
              availableCapabilities: device.capabilities,
              setableCapabilities: setableCapabilityIds(device),
            },
          )
        }

        if (!capability.setable) {
          return invalidRequestResult(
            `The capability "${capability.id}" on ${device.name} reports values but cannot be set. Its current value is ${formatCapabilityValue(capability.value)}.`,
            { device: device.name, setableCapabilities: setableCapabilityIds(device) },
          )
        }

        if (!device.available) {
          return failureResult(
            new HomeyMcpError(
              'not_connected',
              `Homey cannot currently reach ${device.name}${device.unavailableMessage === null ? '' : `: ${device.unavailableMessage}`}. Setting a capability would fail.`,
              { device: device.name, unavailableMessage: device.unavailableMessage },
            ),
            { operation: 'homey_device_set_capability', logger: context.logger },
          )
        }

        const coercion = coerceCapabilityValue(capability, args.value)
        const managers = context.connection.api as DeviceManagers

        await context.connection.request(
          () =>
            managers.devices.setCapabilityValue({
              deviceId: device.id,
              capabilityId: capability.id,
              value: coercion.value,
            }),
          'devices.setCapabilityValue',
        )

        // The cached device still holds the old value, and the next read would
        // otherwise report the change as not having happened.
        context.cache.invalidate('devices')

        const clampNote = coercion.note === null ? '' : ` ${coercion.note}`
        return successResult(
          `Set ${capability.id} on ${device.name} to ${formatCapabilityValue(coercion.value)}${capability.units === null ? '' : ` ${capability.units}`} (was ${formatCapabilityValue(capability.value)}).${clampNote}`,
          {
            deviceId: device.id,
            deviceName: device.name,
            zoneName: device.zoneName,
            capability: capability.id,
            previousValue: capability.value,
            requestedValue: coercion.requested,
            sentValue: coercion.value,
            clamped: coercion.clamped,
            note: coercion.note,
          },
        )
      } catch (error) {
        return failureResult(error, { operation: 'homey_device_set_capability', logger: context.logger })
      }
    },
  )
}

function registerVariableSet(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'homey_variable_set',
    {
      title: 'Set a Homey logic variable',
      description: [
        'Writes a new value to an existing Homey logic variable. A variable is one of exactly three types:',
        'string, number or boolean, and the new value has to match the type the variable already has.',
        'Flows read these variables, so changing one can change what the house does next.',
        'This tool never creates a variable; use homey_home_overview to see which ones exist.',
      ].join(' '),
      inputSchema: {
        variable: z.string().describe('Logic variable id or name.'),
        value: z.union([z.boolean(), z.number(), z.string()]).describe('The new value, matching the variable type.'),
      },
      annotations: OVERWRITE_TOOL_ANNOTATIONS,
    },
    async (args) => {
      try {
        assertLogicVariablesSupported(context)

        const resolution = await context.cache.resolveLogicVariable(args.variable)
        const resolved = await resolveSingle(
          context,
          resolution,
          'logic variable',
          args.variable,
          (variable: LogicVariableSummary) => `${variable.name} (${variable.type})`,
        )
        if ('failure' in resolved) return resolved.failure

        const variable = resolved.match
        const value = coerceVariableValue(variable, args.value)
        const managers = context.connection.api as DeviceManagers

        await context.connection.request(
          () => managers.logic.updateVariable({ id: variable.id, variable: { value } }),
          'logic.updateVariable',
        )
        context.cache.invalidate('logicVariables')

        return successResult(
          `Set logic variable "${variable.name}" to ${formatCapabilityValue(value)} (was ${formatCapabilityValue(variable.value)}).`,
          {
            variableId: variable.id,
            variableName: variable.name,
            type: variable.type,
            previousValue: variable.value,
            newValue: value,
          },
        )
      } catch (error) {
        return failureResult(error, { operation: 'homey_variable_set', logger: context.logger })
      }
    },
  )
}

/**
 * Refuses a variable write on a hub whose logic route the startup probe settled.
 *
 * `logicVariables` is probed at startup and homey_doctor explains what its
 * absence costs, but nothing acted on it: this write went out regardless and the
 * hub answered with its own, far vaguer error. Only the two verdicts that are
 * definite are acted on here. A probe that merely failed leaves the question
 * open, and refusing a write over an inconclusive probe would be its own kind of
 * wrong answer, so that case still goes to the hub.
 */
function assertLogicVariablesSupported(context: ServerContext): void {
  const probe = context.capabilities.probes?.['logicVariables']
  if (probe === undefined) return

  if (probe.status === 'unsupported') {
    throw new HomeyMcpError(
      'unsupported_hardware',
      `This Homey did not answer ${probe.probe} when the server probed it, so it has no logic variables to write to. Run homey_doctor for the probe detail.`,
      { probe },
    )
  }

  if (probe.status === 'forbidden') {
    throw new HomeyMcpError(
      'missing_scope',
      `This session is not allowed to read or write logic variables (${probe.probe} was refused). Sign in again with "homey login" to get a session with full permissions.`,
      { probe },
    )
  }
}

function registerFlowStart(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'homey_flow_start',
    {
      title: 'Start a Homey flow',
      description: [
        'Runs an existing flow immediately, exactly as if its trigger had fired.',
        'This is a real execution and not a preview: a flow can unlock a door, open a window covering,',
        'turn on the heating or send a message. Read the flow with the flow tools before starting it',
        'if you are not certain what it does. Works for both standard and advanced flows.',
      ].join(' '),
      inputSchema: {
        flow: z.string().describe('Flow id or flow name.'),
      },
      annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    },
    async (args) => {
      try {
        const resolution = await context.cache.resolveFlow(args.flow)
        const resolved = await resolveSingle(
          context,
          resolution,
          'flow',
          args.flow,
          (flow: FlowSummary) => `${flow.name} (${flow.kind}${flow.enabled ? '' : ', disabled'})`,
        )
        if ('failure' in resolved) return resolved.failure

        const flow = resolved.match
        // Only a reported `true` refuses the start. `broken` is null whenever
        // the hub never reported the flag, which is every flow on the V2
        // firmware because both flow transforms delete it, and reading that null
        // as false turned "this Homey does not say" into a check that had
        // silently never run.
        if (flow.broken === true) {
          return invalidRequestResult(
            `The flow "${flow.name}" is marked broken by Homey, which means one of its cards refers to something that no longer exists. Starting it would fail. Repair it in the Homey app first.`,
            { flowId: flow.id, kind: flow.kind },
          )
        }

        const managers = context.connection.api as DeviceManagers
        await context.connection.request(
          () =>
            flow.kind === 'advanced'
              ? managers.flow.triggerAdvancedFlow({ id: flow.id })
              : managers.flow.triggerFlow({ id: flow.id }),
          flow.kind === 'advanced' ? 'flow.triggerAdvancedFlow' : 'flow.triggerFlow',
        )

        // Starting a flow can change anything it touches, so the cached view of
        // the flows is no longer trustworthy.
        //
        // Measured, and worth recording because it is the obvious thing to check:
        // `triggerCount` does NOT move when a flow is started this way. It counts
        // the flow's own trigger firing, not a programmatic start, so it cannot be
        // used to confirm that a start actually ran. Read an effect the flow has
        // instead.
        context.cache.invalidate('flows')

        const disabledNote = flow.enabled
          ? ''
          : ' Note that this flow is disabled, so it would not have run on its own.'
        // The start went ahead on a null flag, so the result has to say that the
        // broken check did not happen rather than let its silence read as a pass.
        const brokenNote =
          flow.broken === null
            ? ' This Homey does not report whether a flow is broken, so that could not be checked first: if one of its cards refers to something that no longer exists, the start may have done nothing.'
            : ''
        return successResult(`Started the ${flow.kind} flow "${flow.name}".${disabledNote}${brokenNote}`, {
          flowId: flow.id,
          flowName: flow.name,
          kind: flow.kind,
          enabled: flow.enabled,
          folderName: flow.folderName,
          /** False means "this Homey never said", not "the flow is healthy". */
          brokenReportedByHomey: flow.broken !== null,
        })
      } catch (error) {
        return failureResult(error, { operation: 'homey_flow_start', logger: context.logger })
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Filtering and projection
// ---------------------------------------------------------------------------

export interface DeviceFilters {
  zoneIds: Set<string> | null
  deviceClass?: string | undefined
  capability?: string | undefined
  nameContains?: string | undefined
  available?: boolean | undefined
}

export function matchesFilters(device: DeviceSummary, filters: DeviceFilters): boolean {
  if (filters.zoneIds !== null && !filters.zoneIds.has(device.zoneId)) return false

  if (filters.deviceClass !== undefined) {
    const wanted = normaliseForComparison(filters.deviceClass)
    if (normaliseForComparison(device.class) !== wanted && normaliseForComparison(device.virtualClass ?? '') !== wanted) return false
  }

  if (filters.capability !== undefined) {
    const wanted = filters.capability.trim().toLowerCase()
    // A prefix match so `meter_power` also finds `meter_power.consumed.t1`,
    // which is how the hub names sub-capabilities.
    const hasCapability = device.capabilities.some(
      (capability) => capability.toLowerCase() === wanted || capability.toLowerCase().startsWith(`${wanted}.`),
    )
    if (!hasCapability) return false
  }

  if (filters.nameContains !== undefined && !normaliseForComparison(device.name).includes(normaliseForComparison(filters.nameContains))) {
    return false
  }

  if (filters.available !== undefined && device.available !== filters.available) return false

  return true
}

export function collectZoneAndDescendants(zoneId: string, zones: readonly ZoneSummary[]): Set<string> {
  const collected = new Set<string>([zoneId])
  let addedSomething = true
  // Repeated passes rather than recursion, because the parent links come from the
  // hub and a cycle must not hang the tool.
  while (addedSomething) {
    addedSomething = false
    for (const zone of zones) {
      if (zone.parentZoneId !== null && collected.has(zone.parentZoneId) && !collected.has(zone.id)) {
        collected.add(zone.id)
        addedSomething = true
      }
    }
  }
  return collected
}

export interface CompactCapabilityValue {
  title: string
  value: boolean | number | string | null
  units: string | null
  setable: boolean
}

export function projectDevice(device: DeviceSummary, includeCapabilityValues: boolean): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    id: device.id,
    name: device.name,
    zoneId: device.zoneId,
    zoneName: device.zoneName,
    // The effective class, which is what the owner sees in the app. The class the
    // driver declared is kept alongside it, so an override is visible without a
    // third field that only ever repeats one of these two.
    class: device.virtualClass ?? device.class,
    declaredClass: device.class,
    available: device.available,
    ready: device.ready,
    unavailableMessage: device.unavailableMessage,
    capabilities: device.capabilities,
    energyWatts: device.energyWatts,
    // No `insightCount` here. `Device.transformGet` deletes a device's own
    // `insights` array on both dialects, so counting it reported a confident
    // zero on every live hub. The real count needs the Insights catalogue, which
    // homey_device_get reads for the one device it was asked about; paying for
    // it on every row of a search is not worth it on a hub that rate limits
    // itself after four rapid requests.
  }

  if (includeCapabilityValues) {
    const compact: Record<string, CompactCapabilityValue> = {}
    for (const [capabilityId, capability] of Object.entries(device.capabilityValues)) {
      compact[capabilityId] = {
        title: capability.title,
        value: capability.value,
        units: capability.units,
        setable: capability.setable,
      }
    }
    projected['capabilityValues'] = compact
  }

  return projected
}

interface ResolvedDeviceInsights {
  logs: DeviceInsightReference[]
  /** Null when the catalogue was read. A sentence naming why when it was not. */
  unavailableReason: string | null
}

/**
 * The Insights logs that belong to one device.
 *
 * Not `DeviceSummary.insights`: `Device.transformGet` deletes the device's own
 * `insights` array on both dialects, and it is not recoverable from `raw`
 * either, because `raw` holds the transformed item. So that field is empty on
 * every live hub, and homey_device_get promised "which Insights logs exist for
 * it" and then listed none.
 *
 * The logs themselves are still there. Every entry in the Insights catalogue
 * carries the URI of whatever owns it, so a device's own series are exactly the
 * ones owned by `homey:device:<device id>`. The catalogue is cached, so this
 * costs one request per session rather than one per device.
 */
async function resolveDeviceInsights(
  context: ServerContext,
  device: DeviceSummary,
): Promise<ResolvedDeviceInsights> {
  if (!context.capabilities.hardware.insights) {
    return {
      logs: [],
      unavailableReason:
        'This Homey did not answer the Insights routes when the server probed it, so there is no sensor history to list for this device.',
    }
  }

  try {
    const catalogue = await context.cache.getInsightsLogs()
    const ownerUri = `homey:device:${device.id}`

    return {
      logs: catalogue.all
        .filter((log) => log.uri === ownerUri)
        .map((log) => ({
          uri: log.uri,
          id: log.id,
          type: log.type,
          title: log.title,
          units: log.units,
          decimals: log.decimals,
        })),
      unavailableReason: null,
    }
  } catch (error) {
    // A device that cannot be described because its history could not be read is
    // still worth describing. The rest of the record is unaffected, so the gap is
    // reported in place rather than turned into a failed tool call.
    const failure = classifyError(error, { operation: 'insights.getLogs' })
    return { logs: [], unavailableReason: failure.message }
  }
}

function projectEnergy(device: DeviceSummary): Record<string, unknown> {
  const raw = device.raw
  const energy =
    raw !== null && typeof raw === 'object' ? ((raw as Record<string, unknown>)['energyObj'] ?? null) : null
  const record = energy !== null && typeof energy === 'object' ? (energy as Record<string, unknown>) : {}

  return {
    watts: device.energyWatts,
    // `cumulative` marks a meter that only ever counts up, which must never be
    // averaged. Downstream analytics needs to know that before it does maths.
    cumulative: record['cumulative'] === true,
    batteries: Array.isArray(record['batteries']) ? record['batteries'] : null,
    isHomeBattery: record['homeBattery'] === true,
    isElectricCar: record['electricCar'] === true,
    isEvCharger: record['evCharger'] === true,
    isGenerator: record['generator'] === true,
  }
}

function findCapability(device: DeviceSummary, capabilityId: string): DeviceCapabilityValue | null {
  const trimmed = capabilityId.trim()
  const exact = device.capabilityValues[trimmed]
  if (exact !== undefined) return exact

  const lowerCase = trimmed.toLowerCase()
  for (const [id, capability] of Object.entries(device.capabilityValues)) {
    if (id.toLowerCase() === lowerCase) return capability
  }
  return null
}

function setableCapabilityIds(device: DeviceSummary): string[] {
  return Object.values(device.capabilityValues)
    .filter((capability) => capability.setable)
    .map((capability) => capability.id)
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

export interface CapabilityValueCoercion {
  /** What is actually sent to Homey. Always a real JSON boolean, number or string. */
  value: boolean | number | string
  requested: boolean | number | string
  clamped: boolean
  /** A sentence for the caller when the sent value differs from the requested one. */
  note: string | null
}

/**
 * Validates and, where it is safe, adjusts a requested capability value.
 *
 * Two adjustments are made and both are reported. A number outside the device's
 * declared range is clamped to that range, because the range is the device's own
 * statement about itself. A percentage sent to a 0..1 capability is refused
 * rather than clamped: clamping 60 to 1 would answer "dim to 60 percent" with
 * full brightness, which is a worse outcome than an error the caller can fix.
 */
export function coerceCapabilityValue(
  capability: DeviceCapabilityValue,
  requested: boolean | number | string,
): CapabilityValueCoercion {
  switch (capability.type) {
    case 'boolean': {
      const value = toBoolean(requested)
      if (value === null) {
        throw new HomeyMcpError(
          'invalid_request',
          `The capability "${capability.id}" is a switch, so it takes true or false. Received ${JSON.stringify(requested)}.`,
          { capability: capability.id, expectedType: 'boolean' },
        )
      }
      return {
        value,
        requested,
        clamped: false,
        note: typeof requested === 'boolean' ? null : `Interpreted ${JSON.stringify(requested)} as ${value}.`,
      }
    }

    case 'enum': {
      const value = typeof requested === 'string' ? requested.trim() : String(requested)
      const allowed = capability.values.map((choice) => choice.id)
      if (allowed.length > 0 && !allowed.includes(value)) {
        throw new HomeyMcpError(
          'invalid_request',
          `The capability "${capability.id}" only accepts one of: ${allowed.join(', ')}. Received ${JSON.stringify(requested)}.`,
          { capability: capability.id, allowedValues: capability.values },
        )
      }
      return { value, requested, clamped: false, note: null }
    }

    case 'number': {
      const parsed = toNumber(requested)
      if (parsed === null) {
        throw new HomeyMcpError(
          'invalid_request',
          `The capability "${capability.id}" takes a number. Received ${JSON.stringify(requested)}.`,
          { capability: capability.id, expectedType: 'number', min: capability.min, max: capability.max },
        )
      }

      assertNotAPercentageMistake(capability, parsed)

      const clampedValue = clampToRange(parsed, capability.min, capability.max)
      const clamped = clampedValue !== parsed
      return {
        value: clampedValue,
        requested,
        clamped,
        note: clamped
          ? `${parsed} is outside the range this device accepts (${capability.min ?? 'no minimum'} to ${capability.max ?? 'no maximum'}), so ${clampedValue} was sent instead.`
          : typeof requested === 'string'
            ? `Interpreted the string ${JSON.stringify(requested)} as the number ${parsed}.`
            : null,
      }
    }

    case 'string': {
      const value = typeof requested === 'string' ? requested : String(requested)
      return {
        value,
        requested,
        clamped: false,
        note: typeof requested === 'string' ? null : `Interpreted ${JSON.stringify(requested)} as the text "${value}".`,
      }
    }
  }
}

function assertNotAPercentageMistake(capability: DeviceCapabilityValue, value: number): void {
  const baseCapabilityId = capability.id.split('.')[0] ?? capability.id
  if (!PERCENTAGE_UNIT_FRACTION_CAPABILITIES.has(baseCapabilityId)) return

  // The device is the authority on its own range. Only when the device really
  // does declare a 0..1 fraction (or declares a percentage unit with no upper
  // bound at all) is a value between 1 and 100 unambiguously a percentage that
  // was meant as a fraction.
  const declaresFraction = capability.max === 1 || (capability.max === null && capability.units === '%')
  if (!declaresFraction) return
  if (value <= 1 || value > 100) return

  const asFraction = value / 100
  throw new HomeyMcpError(
    'invalid_request',
    `The capability "${capability.id}" reads as a percentage but takes a fraction between 0 and 1, so ${value} is out of range. Send ${asFraction} for ${value} percent.`,
    {
      capability: capability.id,
      min: capability.min,
      max: capability.max,
      units: capability.units,
      suggestedValue: asFraction,
    },
  )
}

function clampToRange(value: number, min: number | null, max: number | null): number {
  if (min !== null && value < min) return min
  if (max !== null && value > max) return max
  return value
}

export function coerceVariableValue(
  variable: LogicVariableSummary,
  requested: boolean | number | string,
): boolean | number | string {
  switch (variable.type) {
    case 'boolean': {
      const value = toBoolean(requested)
      if (value === null) {
        throw new HomeyMcpError(
          'invalid_request',
          `The logic variable "${variable.name}" is a boolean, so it takes true or false. Received ${JSON.stringify(requested)}.`,
          { variable: variable.name, expectedType: 'boolean' },
        )
      }
      return value
    }
    case 'number': {
      const value = toNumber(requested)
      if (value === null) {
        throw new HomeyMcpError(
          'invalid_request',
          `The logic variable "${variable.name}" is a number. Received ${JSON.stringify(requested)}.`,
          { variable: variable.name, expectedType: 'number' },
        )
      }
      return value
    }
    case 'string':
      return typeof requested === 'string' ? requested : String(requested)
  }
}

function toBoolean(value: boolean | number | string): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  if (typeof value === 'string') {
    const normalised = value.trim().toLowerCase()
    if (normalised === 'true') return true
    if (normalised === 'false') return false
  }
  return null
}

function toNumber(value: boolean | number | string): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * A capability value as the caller would send it back.
 *
 * Deliberately not `render.ts`'s `formatValue`, which renders a boolean as
 * "yes". A model reading "onoff is yes" then has to guess that the value to send
 * is `true`, so this one prints the literal.
 */
function formatCapabilityValue(value: boolean | number | string | null): string {
  return value === null ? 'unknown' : String(value)
}

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

interface NamedEntity {
  id: string
  name: string
}

/**
 * Turns a name or id into exactly one entity, or into a result the caller can
 * return unchanged.
 *
 * An ambiguous reference is never resolved by taking the first candidate: on a
 * write path that eventually switches off the wrong light. When the client can
 * present a question the user is asked; when it cannot, the candidates go back
 * to the model so it can ask in its own words.
 */
export async function resolveSingle<T extends NamedEntity>(
  context: ServerContext,
  resolution: NameResolution<T>,
  kindLabel: string,
  reference: string,
  describe: (entry: T) => string,
): Promise<{ match: T } | { failure: CallToolResult }> {
  if (resolution.match !== null) return { match: resolution.match }

  if (resolution.candidates.length === 0) {
    return {
      failure: failureResult(
        new HomeyMcpError('not_found', `This Homey has no ${kindLabel} matching "${reference}".`, {
          reference,
          kind: kindLabel,
        }),
        { operation: `resolve ${kindLabel}`, logger: context.logger },
      ),
    }
  }

  if (context.askSupported) {
    const answer = await context.ask({
      question: `Which ${kindLabel} did you mean by "${reference}"?`,
      choices: resolution.candidates.map((candidate) => ({
        value: candidate.id,
        label: describe(candidate),
      })),
    })
    if (answer.answered && answer.value !== null) {
      const chosen = resolution.candidates.find((candidate) => candidate.id === answer.value)
      if (chosen !== undefined) return { match: chosen }
    }
  }

  return {
    failure: invalidRequestResult(
      `"${reference}" matches ${resolution.candidates.length} ${kindLabel}s. Ask which one is meant, then call again with the exact name or the id.`,
      {
        reference,
        kind: kindLabel,
        candidates: resolution.candidates.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          description: describe(candidate),
        })),
      },
    ),
  }
}

function describeDevice(device: DeviceSummary): string {
  return `${device.name} in ${device.zoneName} (${device.virtualClass ?? device.class})`
}
