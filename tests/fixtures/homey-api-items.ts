// What the cache actually receives, as opposed to what the hub sends.
//
// `homey-api` runs every item through its class's `transformGet` before any of
// our code sees it, and on the V2 dialect that rewrites fields and then deletes
// the originals. A fixture hand-copied from an HTTP capture therefore tests a
// shape that never reaches production, which is exactly how four separate
// mapping bugs shipped at once: doubled Insights ids, flows that were never
// broken, nameless flow cards and empty driver URIs.
//
// So the payloads here are hand-built (no household data, nothing captured) and
// then put through the real library classes, including construction of the item
// instances, so the deprecation getters and the synthetic `uri` the base class
// defines are present too. If a future `homey-api` release changes a transform,
// these fixtures change with it and the cache tests fail, which is the point.

import { createRequire } from 'node:module'

const requireFromHere = createRequire(import.meta.url)

/** The surface of a library item class that these fixtures use. The library ships no types for it. */
interface LibraryItemClass {
  ID: string | null
  transformGet(item: Record<string, unknown>): Record<string, unknown>
  new (options: {
    id: unknown
    homey: unknown
    manager: unknown
    properties: Record<string, unknown>
  }): Record<string, unknown>
}

function loadItemClass(path: string, itemId: string): LibraryItemClass {
  const ItemClass = requireFromHere(`homey-api/lib/HomeyAPI/${path}`) as LibraryItemClass
  // Normally set by the Manager from the API definition. It decides the
  // synthetic `homey:<itemId>:<id>` URI the base class defines on every item.
  ItemClass.ID = itemId
  return ItemClass
}

const ITEM_CLASSES = {
  v2: {
    device: () => loadItemClass('HomeyAPIV2/ManagerDevices/Device.js', 'device'),
    flow: () => loadItemClass('HomeyAPIV2/ManagerFlow/Flow.js', 'flow'),
    advancedFlow: () => loadItemClass('HomeyAPIV2/ManagerFlow/AdvancedFlow.js', 'advancedflow'),
    trigger: () => loadItemClass('HomeyAPIV2/ManagerFlow/FlowCardTrigger.js', 'flowcardtrigger'),
    condition: () => loadItemClass('HomeyAPIV2/ManagerFlow/FlowCardCondition.js', 'flowcardcondition'),
    action: () => loadItemClass('HomeyAPIV2/ManagerFlow/FlowCardAction.js', 'flowcardaction'),
    log: () => loadItemClass('HomeyAPIV2/ManagerInsights/Log.js', 'log'),
    zone: () => loadItemClass('HomeyAPIV3/Item.js', 'zone'),
    logicVariable: () => loadItemClass('HomeyAPIV3/Item.js', 'variable'),
  },
  v3: {
    device: () => loadItemClass('HomeyAPIV3/ManagerDevices/Device.js', 'device'),
    flow: () => loadItemClass('HomeyAPIV3/ManagerFlow/Flow.js', 'flow'),
    advancedFlow: () => loadItemClass('HomeyAPIV3/ManagerFlow/AdvancedFlow.js', 'advancedflow'),
    trigger: () => loadItemClass('HomeyAPIV3/ManagerFlow/FlowCardTrigger.js', 'flowcardtrigger'),
    condition: () => loadItemClass('HomeyAPIV3/ManagerFlow/FlowCardCondition.js', 'flowcardcondition'),
    action: () => loadItemClass('HomeyAPIV3/ManagerFlow/FlowCardAction.js', 'flowcardaction'),
    log: () => loadItemClass('HomeyAPIV3/ManagerInsights/Log.js', 'log'),
    zone: () => loadItemClass('HomeyAPIV3/Item.js', 'zone'),
    logicVariable: () => loadItemClass('HomeyAPIV3/Item.js', 'variable'),
  },
} as const

type ItemKind = keyof (typeof ITEM_CLASSES)['v2']

export type Dialect = 'v2' | 'v3'

/**
 * Runs one hand-built payload through the library exactly as a manager would.
 *
 * The clone matters: several transforms mutate nested objects in place, so
 * without it the exported raw payloads would be rewritten by the first test
 * that asks for the transformed ones.
 */
function toLibraryItem(dialect: Dialect, kind: ItemKind, wireItem: Record<string, unknown>): Record<string, unknown> {
  const ItemClass = ITEM_CLASSES[dialect][kind]()
  const properties = ItemClass.transformGet(structuredClone(wireItem))
  return new ItemClass({ id: properties['id'], homey: {}, manager: {}, properties })
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export const ZONE_ID = '11111111-1111-4111-8111-111111111111'
export const DEVICE_ID = '22222222-2222-4222-8222-222222222222'
export const DEVICE_URI = `homey:device:${DEVICE_ID}`
export const ZONE_URI = `homey:zone:${ZONE_ID}`
export const DEVICE_NAME = 'Hallway sensor'
export const ZONE_NAME = 'Hallway'

/**
 * A manager-owned Insights log, which is the owner type no index can name.
 *
 * The hub really does keep outdoor weather as `homey:manager:weather`, so a log
 * owned by a manager is not an exotic case: it is where the outdoor temperature
 * lives, sitting in the same search results as every device-owned one.
 */
export const MANAGER_URI = 'homey:manager:weather'
export const MANAGER_ID = 'weather'
/** What the hub calls that manager, in the household's own language. */
export const MANAGER_NAME_FROM_HUB = 'Weer'
/** What the manager identifier reads as once it is rendered for a person. */
export const MANAGER_NAME_DERIVED = 'Weather'

/**
 * The card that exists as both a trigger and an action.
 *
 * `homey:manager:flow:programmatic_trigger` is "this Flow has started" in the
 * When column and "start a Flow" in the Then column. It is one of the five
 * cards the server recommends as always safe, which is why an index that keeps
 * only one of the two breaks the recommended flow.
 */
export const COLLIDING_CARD_ID = 'homey:manager:flow:programmatic_trigger'

// ---------------------------------------------------------------------------
// Hand-built payloads, in the shape each dialect puts on the wire
// ---------------------------------------------------------------------------

export interface HomePayloads {
  zones: Record<string, unknown>
  devices: Record<string, unknown>
  flows: Record<string, unknown>
  advancedFlows: Record<string, unknown>
  flowFolders: Record<string, unknown>
  flowCardTriggers: unknown[]
  flowCardConditions: unknown[]
  flowCardActions: unknown[]
  insightsLogs: Record<string, unknown>
  logicVariables: Record<string, unknown>
}

/** Every capability the hub sends carries its own record; only the fields the cache reads are here. */
function capabilitiesObject(): Record<string, unknown> {
  return {
    measure_temperature: {
      id: 'measure_temperature',
      title: 'Temperature',
      type: 'number',
      value: 20.5,
      // An ISO string on the wire. The Device transform turns it into a Date.
      lastUpdated: '2026-08-13T08:00:00.000Z',
      getable: true,
      setable: false,
      units: '°C',
      decimals: 1,
    },
  }
}

function zonePayloads(): Record<string, unknown> {
  return {
    [ZONE_ID]: {
      id: ZONE_ID,
      name: ZONE_NAME,
      order: 1,
      parent: null,
      active: true,
      activeLastUpdated: '2026-08-13T08:02:32.565Z',
      icon: 'home',
    },
  }
}

function devicePayloads(dialect: Dialect): Record<string, unknown> {
  return {
    [DEVICE_ID]: {
      id: DEVICE_ID,
      name: DEVICE_NAME,
      // V2 splits the driver identity in two. V3 sends it already joined and
      // still carries the URI half alongside.
      driverUri: 'homey:app:com.example.sensors',
      driverId: dialect === 'v2' ? 'motion' : 'homey:app:com.example.sensors:motion',
      zone: ZONE_ID,
      zoneName: ZONE_NAME,
      class: 'sensor',
      virtualClass: null,
      capabilities: ['measure_temperature'],
      capabilitiesObj: capabilitiesObject(),
      insights: [
        {
          uri: DEVICE_URI,
          id: 'measure_temperature',
          type: 'number',
          title: 'Temperature',
          units: '°C',
          decimals: 1,
        },
      ],
      energyObj: { W: 4 },
      available: true,
      ready: true,
      unavailableMessage: null,
    },
  }
}

function flowPayloads(dialect: Dialect): Record<string, unknown> {
  const triggerCard =
    dialect === 'v2'
      ? { uri: 'homey:manager:flow', id: 'programmatic_trigger', args: {} }
      : { id: COLLIDING_CARD_ID, args: {} }

  return {
    'flow-broken': {
      id: 'flow-broken',
      name: 'Leaving home',
      enabled: true,
      broken: true,
      triggerable: true,
      triggerCount: 4,
      folder: null,
      order: 1,
      trigger: structuredClone(triggerCard),
      conditions: [],
      actions: [],
    },
    'flow-healthy': {
      id: 'flow-healthy',
      name: 'Coming home',
      enabled: true,
      broken: false,
      triggerable: true,
      triggerCount: 9,
      folder: null,
      order: 2,
      trigger: structuredClone(triggerCard),
      conditions: [],
      actions: [],
    },
  }
}

function advancedFlowPayloads(): Record<string, unknown> {
  return {
    'advanced-broken': {
      id: 'advanced-broken',
      name: 'Morning routine',
      enabled: true,
      broken: true,
      triggerable: true,
      folder: null,
      cards: {},
    },
  }
}

/**
 * One card in the shape its dialect sends.
 *
 * V2 splits the owner into `uri` plus a `uriObj` describing it, and keeps the
 * card id short. V3 sends a fully qualified id with the owner flattened into
 * `ownerUri`, `ownerId` and `ownerName`, the last of which its transform then
 * deletes again.
 */
function cardPayload(
  dialect: Dialect,
  options: { ownerUri: string; ownerId: string; ownerType: string; ownerName: string; shortId: string; title: string },
): Record<string, unknown> {
  const shared = {
    title: options.title,
    titleFormatted: null,
    hint: null,
    args: [],
    tokens: [],
  }

  if (dialect === 'v2') {
    return {
      ...shared,
      uri: options.ownerUri,
      uriObj: { type: options.ownerType, id: options.ownerId, name: options.ownerName, iconObj: null },
      id: options.shortId,
    }
  }

  return {
    ...shared,
    id: `${options.ownerUri}:${options.shortId}`,
    ownerUri: options.ownerUri,
    ownerId: options.ownerId,
    ownerName: options.ownerName,
  }
}

function insightsLogPayloads(dialect: Dialect): Record<string, unknown> {
  const shared = {
    title: 'Temperature',
    titleTrue: null,
    titleFalse: null,
    type: 'number',
    units: '°C',
    decimals: 1,
    lastValue: 20.5,
  }

  if (dialect === 'v2') {
    return {
      measure_temperature: {
        ...shared,
        uri: DEVICE_URI,
        uriObj: { type: 'device', id: DEVICE_ID, name: DEVICE_NAME, iconObj: null },
        id: 'measure_temperature',
      },
      temperature: {
        ...shared,
        uri: MANAGER_URI,
        uriObj: { type: 'manager', id: MANAGER_ID, name: MANAGER_NAME_FROM_HUB, iconObj: null },
        id: 'temperature',
      },
    }
  }

  return {
    [`${DEVICE_URI}:measure_temperature`]: {
      ...shared,
      id: `${DEVICE_URI}:measure_temperature`,
      ownerUri: DEVICE_URI,
      ownerId: DEVICE_ID,
      ownerName: DEVICE_NAME,
    },
    [`${MANAGER_URI}:temperature`]: {
      ...shared,
      id: `${MANAGER_URI}:temperature`,
      ownerUri: MANAGER_URI,
      ownerId: MANAGER_ID,
      ownerName: MANAGER_NAME_FROM_HUB,
    },
  }
}

/**
 * The payloads exactly as the hub puts them on the wire, before `homey-api`
 * touches them. This is what a captured fixture looks like, and what the
 * committed hand-built fixtures elsewhere in this directory are shaped like.
 */
export function wirePayloads(dialect: Dialect = 'v2'): HomePayloads {
  return {
    zones: zonePayloads(),
    devices: devicePayloads(dialect),
    flows: flowPayloads(dialect),
    advancedFlows: advancedFlowPayloads(),
    flowFolders: {},
    flowCardTriggers: [
      cardPayload(dialect, {
        ownerUri: 'homey:manager:flow',
        ownerId: 'flow',
        ownerType: 'manager',
        ownerName: 'Flow',
        shortId: 'programmatic_trigger',
        title: 'This Flow has started',
      }),
      cardPayload(dialect, {
        ownerUri: DEVICE_URI,
        ownerId: DEVICE_ID,
        ownerType: 'device',
        ownerName: DEVICE_NAME,
        shortId: 'measure_temperature_changed',
        title: 'The temperature changed',
      }),
    ],
    flowCardConditions: [
      cardPayload(dialect, {
        ownerUri: ZONE_URI,
        ownerId: ZONE_ID,
        ownerType: 'zone',
        ownerName: ZONE_NAME,
        shortId: 'zone_active',
        title: 'There is activity',
      }),
    ],
    flowCardActions: [
      cardPayload(dialect, {
        ownerUri: 'homey:manager:flow',
        ownerId: 'flow',
        ownerType: 'manager',
        ownerName: 'Flow',
        shortId: 'programmatic_trigger',
        title: 'Start a Flow',
      }),
    ],
    insightsLogs: insightsLogPayloads(dialect),
    logicVariables: {
      'variable-1': { id: 'variable-1', name: 'Holiday mode', type: 'boolean', value: false },
    },
  }
}

/**
 * The same payloads after `homey-api` has transformed them into item instances.
 *
 * This is what `cache.ts` is handed at runtime, and the only shape a mapper
 * assertion about a live hub may be written against.
 */
export function libraryPayloads(dialect: Dialect = 'v2'): HomePayloads {
  const wire = wirePayloads(dialect)

  const mapRecord = (record: Record<string, unknown>, kind: ItemKind): Record<string, unknown> => {
    const transformed: Record<string, unknown> = {}
    for (const item of Object.values(record)) {
      const libraryItem = toLibraryItem(dialect, kind, item as Record<string, unknown>)
      transformed[String(libraryItem['id'])] = libraryItem
    }
    return transformed
  }

  const mapList = (list: unknown[], kind: ItemKind): unknown[] =>
    list.map((item) => toLibraryItem(dialect, kind, item as Record<string, unknown>))

  return {
    zones: mapRecord(wire.zones, 'zone'),
    devices: mapRecord(wire.devices, 'device'),
    flows: mapRecord(wire.flows, 'flow'),
    advancedFlows: mapRecord(wire.advancedFlows, 'advancedFlow'),
    flowFolders: {},
    flowCardTriggers: mapList(wire.flowCardTriggers, 'trigger'),
    flowCardConditions: mapList(wire.flowCardConditions, 'condition'),
    flowCardActions: mapList(wire.flowCardActions, 'action'),
    insightsLogs: mapRecord(wire.insightsLogs, 'log'),
    // No manager class overrides these, so the library hands them over unchanged
    // apart from the synthetic URI every item carries.
    logicVariables: mapRecord(wire.logicVariables, 'logicVariable'),
  }
}
