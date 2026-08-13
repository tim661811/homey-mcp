// The cache is the only place where a `homey-api` item becomes a domain type,
// so it is the only place these bugs can be fixed once instead of at every
// call site.
//
// Every mapping assertion here runs against items the real library produced,
// not against a hand-copied HTTP payload. That distinction is the whole point:
// on the V2 dialect `transformGet` rewrites fields and then deletes the
// originals, so a fixture shaped like the capture passes while the shipped
// server reads undefined. The raw-shape assertions sit next to them because the
// committed fixtures and the V3 dialect still send that shape.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createHomeCache, flowCardIndexKey } from './cache.js'
import { createLogger } from '../util/log.js'
import type { HomeyConnection } from './types.js'
import {
  COLLIDING_CARD_ID,
  DEVICE_ID,
  DEVICE_NAME,
  DEVICE_URI,
  ZONE_ID,
  ZONE_NAME,
  ZONE_URI,
  libraryPayloads,
  wirePayloads,
  type Dialect,
  type HomePayloads,
} from '../../tests/fixtures/homey-api-items.js'

interface RecordedRequest {
  label: string
  idempotent: boolean | undefined
}

interface Harness {
  connection: HomeyConnection
  requests: RecordedRequest[]
}

function createHarness(payloads: HomePayloads, dialect: Dialect = 'v2'): Harness {
  const requests: RecordedRequest[] = []

  const managers = {
    devices: { getDevices: async () => payloads.devices },
    zones: { getZones: async () => payloads.zones },
    flow: {
      getFlows: async () => payloads.flows,
      getAdvancedFlows: async () => payloads.advancedFlows,
      getFlowFolders: async () => payloads.flowFolders,
      getFlowCardTriggers: async () => payloads.flowCardTriggers,
      getFlowCardConditions: async () => payloads.flowCardConditions,
      getFlowCardActions: async () => payloads.flowCardActions,
    },
    insights: { getLogs: async () => payloads.insightsLogs },
    logic: { getVariables: async () => payloads.logicVariables },
  }

  const connection: HomeyConnection = {
    api: managers,
    dialect,
    identity: {
      id: 'homey-under-test',
      name: 'Test Home',
      modelId: 'homey4d',
      modelName: 'Homey Pro (Early 2019)',
      softwareVersion: '13.2.4',
      platformVersion: dialect === 'v2' ? 1 : 2,
      language: 'en',
      timezone: 'Europe/Amsterdam',
      address: 'https://homey.example.invalid',
      addressKind: 'local',
    },
    queue: { run: async (operation) => operation(), inFlight: 0, queued: 0 },
    request: async (operation, label, idempotent) => {
      requests.push({ label, idempotent })
      return operation()
    },
  }

  return { connection, requests }
}

function createCache(payloads: HomePayloads, dialect: Dialect = 'v2') {
  const harness = createHarness(payloads, dialect)
  return {
    cache: createHomeCache(harness.connection, { logger: createLogger({ level: 'silent' }) }),
    requests: harness.requests,
  }
}

describe('insights log mapping', () => {
  it('reads the owner from ownerUri, not from the synthetic uri the base class defines', async () => {
    const { cache } = createCache(libraryPayloads('v2'))

    const logs = await cache.getInsightsLogs()
    const log = logs.all[0]

    // The failure this pins: `uri` survives on a live item as
    // `homey:log:<fully qualified id>`, so mapping it as the owner produced
    // `homey:log:homey:device:...` and every Insights query 404'd.
    expect(log?.uri).toBe(DEVICE_URI)
    expect(log?.id).toBe('measure_temperature')
  })

  it('rejoins into the identifier the library asks the hub for', async () => {
    const { cache } = createCache(libraryPayloads('v2'))

    const log = (await cache.getInsightsLogs()).all[0]

    // What the tools rebuild and hand to getLogEntries, which splits the first
    // three segments back off as the owner URI and takes the last as the
    // capability. Anything else resolves to a route that does not exist.
    expect(`${log?.uri}:${log?.id}`).toBe(`${DEVICE_URI}:measure_temperature`)
  })

  it('keys the index by that same identifier', async () => {
    const { cache } = createCache(libraryPayloads('v2'))

    const logs = await cache.getInsightsLogs()

    expect([...logs.byId.keys()]).toEqual([`${DEVICE_URI}:measure_temperature`])
  })

  it('takes the owner id from the owner URI, since the library fills ownerId with the capability', async () => {
    const { cache } = createCache(libraryPayloads('v2'))

    const log = (await cache.getInsightsLogs()).all[0]

    // ManagerInsights/Log.transformGet on V2 runs `item.ownerId = item.id`
    // before rewriting the id, so the library's own ownerId says
    // `measure_temperature`. Trusting it names the capability as the device.
    expect(log?.ownerId).toBe(DEVICE_ID)
    expect(log?.ownerType).toBe('device')
  })

  it('names the owner from the device index when the library deleted the name', async () => {
    const { cache } = createCache(libraryPayloads('v2'))

    const log = (await cache.getInsightsLogs()).all[0]

    // Both dialects delete ownerName. Without this the log scores against
    // nothing and no search on a device name ever matches it.
    expect(log?.ownerName).toBe(DEVICE_NAME)
  })

  it('resolves a log by the owner name the device index supplied', async () => {
    const { cache } = createCache(libraryPayloads('v2'))

    const resolution = await cache.resolveInsightsLog('Hallway sensor Temperature')

    expect(resolution.match?.id).toBe('measure_temperature')
  })

  it('maps a V3 item to the same domain shape', async () => {
    const { cache } = createCache(libraryPayloads('v3'), 'v3')

    const log = (await cache.getInsightsLogs()).all[0]

    expect(log?.uri).toBe(DEVICE_URI)
    expect(log?.id).toBe('measure_temperature')
    expect(log?.ownerId).toBe(DEVICE_ID)
    expect(log?.ownerName).toBe(DEVICE_NAME)
  })

  it('still maps a raw capture, where the owner is only in uri and uriObj', async () => {
    const { cache } = createCache(wirePayloads('v2'))

    const log = (await cache.getInsightsLogs()).all[0]

    expect(log?.uri).toBe(DEVICE_URI)
    expect(log?.id).toBe('measure_temperature')
    expect(log?.ownerId).toBe(DEVICE_ID)
    expect(log?.ownerName).toBe(DEVICE_NAME)
  })
})

describe('flow mapping', () => {
  it('reports an absent broken flag as unknown rather than healthy', async () => {
    const { cache } = createCache(libraryPayloads('v2'))

    const flows = await cache.getFlows()

    // Both flow transforms end with `delete item.broken` on V2. Reading that as
    // false is what made a broken-only filter answer "none" on a hub that has
    // broken flows, and let the flow-start guard wave one through.
    expect(flows.all.every((flow) => flow.broken === null)).toBe(true)
    expect(flows.all.some((flow) => flow.broken === false)).toBe(false)
  })

  it('keeps the flag when the dialect actually sends one', async () => {
    const { cache } = createCache(libraryPayloads('v3'), 'v3')

    const flows = await cache.getFlows()

    expect(flows.byId.get('flow-broken')?.broken).toBe(true)
    expect(flows.byId.get('flow-healthy')?.broken).toBe(false)
  })

  it('keeps the flag from a raw capture', async () => {
    const { cache } = createCache(wirePayloads('v2'))

    const flows = await cache.getFlows()

    expect(flows.byId.get('flow-broken')?.broken).toBe(true)
    expect(flows.byId.get('flow-healthy')?.broken).toBe(false)
    expect(flows.byId.get('advanced-broken')?.broken).toBe(true)
  })
})

describe('flow card mapping', () => {
  it('names the owner from the field the library produces', async () => {
    const { cache } = createCache(libraryPayloads('v2'))

    const cards = await cache.getFlowCards('trigger')
    const deviceCard = cards.all.find((card) => card.ownerType === 'device')

    // V2 copies the name out of uriObj and deletes the object. Reading the
    // deleted object left every ownerName empty, so an owner filter matched
    // nothing at all.
    expect(deviceCard?.ownerName).toBe(DEVICE_NAME)
    expect(deviceCard?.ownerId).toBe(DEVICE_ID)
    expect(deviceCard?.ownerUri).toBe(DEVICE_URI)
    expect(deviceCard?.id).toBe(`${DEVICE_URI}:measure_temperature_changed`)
    expect(deviceCard?.shortId).toBe('measure_temperature_changed')
  })

  it('names a device owner from the device index when the dialect deleted the name', async () => {
    const { cache } = createCache(libraryPayloads('v3'), 'v3')

    const cards = await cache.getFlowCards('trigger')
    const deviceCard = cards.all.find((card) => card.ownerType === 'device')

    // V3's FlowCard.transformGet deletes ownerName outright, so the only route
    // left to a readable owner is the device index this cache already holds.
    expect(deviceCard?.ownerName).toBe(DEVICE_NAME)
  })

  it('names a zone owner from the zone index', async () => {
    const { cache } = createCache(libraryPayloads('v3'), 'v3')

    const cards = await cache.getFlowCards('condition')
    const zoneCard = cards.all.find((card) => card.ownerType === 'zone')

    expect(zoneCard?.ownerName).toBe(ZONE_NAME)
    expect(zoneCard?.ownerId).toBe(ZONE_ID)
    expect(zoneCard?.ownerUri).toBe(ZONE_URI)
  })

  it('still maps a raw capture, where the owner is only in uriObj', async () => {
    const { cache } = createCache(wirePayloads('v2'))

    const cards = await cache.getFlowCards('trigger')
    const deviceCard = cards.all.find((card) => card.ownerType === 'device')

    expect(deviceCard?.ownerName).toBe(DEVICE_NAME)
    expect(deviceCard?.id).toBe(`${DEVICE_URI}:measure_temperature_changed`)
  })

  it('never touches a deprecated field, because each read prints a line to the server log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { cache } = createCache(libraryPayloads('v2'))

    await cache.getAllFlowCards()
    await cache.getInsightsLogs()
    await cache.getDevices()

    // The deprecation getters return undefined and warn on every read. With 808
    // cards that was around 1130 lines onto stderr on one cold cache fill, in
    // the channel MCP clients show as the server log.
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('flow card index', () => {
  it('keeps both cards that share an id across kinds', async () => {
    const { cache } = createCache(libraryPayloads('v2'))

    const cards = await cache.getAllFlowCards()

    // Indexing by id alone let the action overwrite the trigger, so the card
    // the server recommends as always safe came back as the wrong kind and
    // validation rejected the flow built on it.
    expect(cards.get('trigger', COLLIDING_CARD_ID)?.title).toBe('This Flow has started')
    expect(cards.get('action', COLLIDING_CARD_ID)?.title).toBe('Start a Flow')
    expect(cards.byKindAndId.get(flowCardIndexKey('trigger', COLLIDING_CARD_ID))?.kind).toBe('trigger')
    expect(cards.byKindAndId.get(flowCardIndexKey('action', COLLIDING_CARD_ID))?.kind).toBe('action')
  })

  it('answers a kind-agnostic lookup with every match', async () => {
    const { cache } = createCache(libraryPayloads('v2'))

    const cards = await cache.getAllFlowCards()
    const matches = cards.findById(COLLIDING_CARD_ID)

    expect(matches.map((card) => card.kind).sort()).toEqual(['action', 'trigger'])
  })

  it('reports no match rather than throwing for an unknown id', async () => {
    const { cache } = createCache(libraryPayloads('v2'))

    const cards = await cache.getAllFlowCards()

    expect(cards.findById('homey:manager:flow:no_such_card')).toEqual([])
    expect(cards.get('trigger', 'homey:manager:flow:no_such_card')).toBeUndefined()
  })

  it('keeps every card in all, including both sides of a collision', async () => {
    const { cache } = createCache(libraryPayloads('v2'))

    const cards = await cache.getAllFlowCards()

    expect(cards.all).toHaveLength(4)
  })
})

describe('device mapping', () => {
  it('splits the driver identity the library folded together', async () => {
    const { cache } = createCache(libraryPayloads('v2'))

    const device = (await cache.getDevices()).byId.get(DEVICE_ID)

    // `Device.transformGet` sets driverId to `<driverUri>:<driverId>` and then
    // deletes driverUri, so reading the wire field left it empty on every
    // device on the hub.
    expect(device?.driverUri).toBe('homey:app:com.example.sensors')
    expect(device?.driverId).toBe('homey:app:com.example.sensors:motion')
  })

  it('reports the same driver identity from a raw capture, where the halves arrive apart', async () => {
    const { cache } = createCache(wirePayloads('v2'))

    const device = (await cache.getDevices()).byId.get(DEVICE_ID)

    expect(device?.driverUri).toBe('homey:app:com.example.sensors')
    expect(device?.driverId).toBe('homey:app:com.example.sensors:motion')
  })

  it('reads a capability timestamp the library turned into a Date', async () => {
    const { cache } = createCache(libraryPayloads('v2'))

    const device = (await cache.getDevices()).byId.get(DEVICE_ID)

    // The Device transform replaces every lastUpdated with a Date instance, so
    // reading it as a string answered "never updated" on every live device.
    expect(device?.capabilityValues['measure_temperature']?.lastUpdated).toBe('2026-08-13T08:00:00.000Z')
  })

  it('takes the room name from the zone index once the library deleted the copy', async () => {
    const { cache } = createCache(libraryPayloads('v2'))

    const device = (await cache.getDevices()).byId.get(DEVICE_ID)

    expect(device?.zoneName).toBe(ZONE_NAME)
  })
})

describe('request queue hints', () => {
  it('marks every read as idempotent, since repeating a read changes nothing', async () => {
    const { cache, requests } = createCache(libraryPayloads('v2'))

    await cache.getDevices()
    await cache.getZones()
    await cache.getFlows()
    await cache.getFlowFolders()
    await cache.getAllFlowCards()
    await cache.getInsightsLogs()
    await cache.getLogicVariables()

    expect(requests.length).toBeGreaterThan(0)
    expect(requests.filter((request) => request.idempotent !== true)).toEqual([])
  })
})

describe('cold load', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fills every collection from one pass over the library payloads', async () => {
    const { cache } = createCache(libraryPayloads('v2'))

    await cache.getDevices()
    await cache.getFlows()
    await cache.getAllFlowCards()
    await cache.getInsightsLogs()
    await cache.getLogicVariables()

    const loaded = cache.describe().filter((status) => status.loaded)
    expect(loaded.map((status) => status.collection).sort()).toEqual([
      'devices',
      'flowCardActions',
      'flowCardConditions',
      'flowCardTriggers',
      'flowFolders',
      'flows',
      'insightsLogs',
      'logicVariables',
      'zones',
    ])
  })
})
