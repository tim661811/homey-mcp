// One fetch per collection, held behind a time to live.
//
// The hub starts refusing requests when a handful arrive at once, so the shape
// of every read is "ask for the whole collection once, index it, answer from the
// index". Never `getDevice(id)` in a loop: with 26 devices that is 26 requests
// where one would do, and it is exactly the pattern that produced "Too many
// requests" during the hardware probes.
//
// The index also carries the name lookups, because every tool needs to turn a
// phrase like "the hallway light" into an id, and doing that consistently in one
// place is what keeps two tools from disagreeing about which device that is.
//
// The second half of this file is the adapter that turns a `homey-api` item into
// a domain type. It is written against what the library produces, not against
// what the hub sends, which are two different shapes. See the section comment
// there before changing any mapper.

import { classifyError, isHomeyMcpError } from './errors.js'
import type {
  CapabilityRegistry,
  DeviceCapabilityValue,
  DeviceInsightReference,
  DeviceSummary,
  FlowCardArgumentDescriptor,
  FlowCardDescriptor,
  FlowCardKind,
  FlowCardLookup,
  FlowCardOwnerType,
  FlowCardTokenDescriptor,
  FlowFolderSummary,
  FlowSummary,
  HomeyConnection,
  InsightsLogSummary,
  LogicVariableSummary,
  ZoneSummary,
} from './types.js'
import { splitCanonicalCardId, toCanonicalCardId } from './types.js'
import type { Logger } from '../util/log.js'
import { asNumber, asRecord, asString, asStringArray } from '../util/coerce.js'

export { splitCanonicalCardId, toCanonicalCardId }

/** Volatile collections: device state changes minute to minute. */
export const DEFAULT_TTL_MS = 60_000

/** The card catalogue only changes when an app is installed, updated or removed. */
export const DEFAULT_CARD_TTL_MS = 900_000

export type CacheCollection =
  | 'devices'
  | 'zones'
  | 'flows'
  | 'flowFolders'
  | 'flowCardTriggers'
  | 'flowCardConditions'
  | 'flowCardActions'
  | 'insightsLogs'
  | 'logicVariables'

export interface EntityIndex<T> {
  readonly all: readonly T[]
  readonly byId: ReadonlyMap<string, T>
  /** Epoch milliseconds at which this index was filled. */
  readonly fetchedAt: number
}

/**
 * The whole card catalogue, keyed by kind and id rather than by id alone.
 *
 * Card ids are not unique across kinds. `homey:manager:flow:programmatic_trigger`
 * exists twice on the measured hub: as the trigger "this Flow has started" and
 * as the action "start a Flow". A single id-keyed map therefore holds only one
 * of them, and since the kinds are indexed in order the action overwrites the
 * trigger. That trigger is one of the five cards this server recommends as
 * always safe to build on, so the recommended flow could not be validated: the
 * lookup answered with an action card and validation rejected it as the wrong
 * kind.
 *
 * There is deliberately no `byId` here. A caller that knows which kind it is
 * holding (a flow's trigger is a trigger, its actions are actions) must say so,
 * and one that does not gets every meaning of the id rather than an arbitrary
 * one.
 */
export interface FlowCardIndex extends FlowCardLookup {
  readonly all: readonly FlowCardDescriptor[]
  /** Keyed by {@link flowCardIndexKey}. Prefer `get`, which builds the key for you. */
  readonly byKindAndId: ReadonlyMap<string, FlowCardDescriptor>
  /** Epoch milliseconds at which this index was filled. */
  readonly fetchedAt: number
}

/** The composite key {@link FlowCardIndex.byKindAndId} uses. Exported so a caller can build one without guessing the separator. */
export function flowCardIndexKey(kind: FlowCardKind, id: string): string {
  return `${kind}:${id}`
}

export interface FetchOptions {
  /** Ignore the time to live and go back to the hub. Use after a write. */
  forceRefresh?: boolean
}

export type NameResolutionReason =
  | 'id'
  | 'exact_name'
  | 'unique_prefix'
  | 'unique_substring'
  | 'ambiguous'
  | 'not_found'

export interface NameResolution<T> {
  /** The single thing the reference names, or null when it names none or several. */
  match: T | null
  /** Every candidate considered, so a tool can ask the user which one was meant. */
  candidates: T[]
  reason: NameResolutionReason
}

export interface CacheCollectionStatus {
  collection: CacheCollection
  loaded: boolean
  entryCount: number
  fetchedAt: string | null
  ageMs: number | null
}

export interface HomeCache {
  getDevices(options?: FetchOptions): Promise<EntityIndex<DeviceSummary>>
  getZones(options?: FetchOptions): Promise<EntityIndex<ZoneSummary>>
  /** Standard and advanced flows in one index. `kind` on each entry says which it is. */
  getFlows(options?: FetchOptions): Promise<EntityIndex<FlowSummary>>
  getFlowFolders(options?: FetchOptions): Promise<EntityIndex<FlowFolderSummary>>
  /** One kind, keyed by plain card id. Ids are unique within a kind, only not across kinds. */
  getFlowCards(kind: FlowCardKind, options?: FetchOptions): Promise<EntityIndex<FlowCardDescriptor>>
  /** All three card kinds in one index. 808 cards on the measured hub, so search, never list. */
  getAllFlowCards(options?: FetchOptions): Promise<FlowCardIndex>
  getInsightsLogs(options?: FetchOptions): Promise<EntityIndex<InsightsLogSummary>>
  getLogicVariables(options?: FetchOptions): Promise<EntityIndex<LogicVariableSummary>>

  resolveDevice(reference: string, options?: FetchOptions): Promise<NameResolution<DeviceSummary>>
  resolveZone(reference: string, options?: FetchOptions): Promise<NameResolution<ZoneSummary>>
  resolveFlow(reference: string, options?: FetchOptions): Promise<NameResolution<FlowSummary>>
  resolveLogicVariable(reference: string, options?: FetchOptions): Promise<NameResolution<LogicVariableSummary>>
  resolveInsightsLog(reference: string, options?: FetchOptions): Promise<NameResolution<InsightsLogSummary>>

  /** Drops one collection, or everything. Call after any write that changes what was read. */
  invalidate(collection?: CacheCollection): void
  /** What is currently held, for `doctor`. */
  describe(): CacheCollectionStatus[]
}

export interface HomeCacheOptions {
  logger?: Logger
  ttlMs?: number
  cardTtlMs?: number
  now?: () => number
  /**
   * When known, keeps the cache from asking for something this hub has already
   * said it does not have. Without it the advanced-flow fetch is attempted once
   * and an "unsupported" answer is recorded as an empty result.
   */
  capabilities?: CapabilityRegistry
}

interface CacheEntry<T> {
  index: EntityIndex<T>
  /** In flight fetch, so two concurrent callers share one request rather than racing. */
  pending: Promise<EntityIndex<T>> | null
}

interface HomeyManagers {
  devices: { getDevices(): Promise<unknown> }
  zones: { getZones(): Promise<unknown> }
  flow: {
    getFlows(): Promise<unknown>
    getAdvancedFlows(): Promise<unknown>
    getFlowFolders(): Promise<unknown>
    getFlowCardTriggers(): Promise<unknown>
    getFlowCardConditions(): Promise<unknown>
    getFlowCardActions(): Promise<unknown>
  }
  insights: { getLogs(): Promise<unknown> }
  logic: { getVariables(): Promise<unknown> }
}

export function createHomeCache(connection: HomeyConnection, options: HomeCacheOptions = {}): HomeCache {
  const logger = options.logger?.child('cache')
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const cardTtlMs = options.cardTtlMs ?? DEFAULT_CARD_TTL_MS
  const now = options.now ?? (() => Date.now())
  const managers = connection.api as HomeyManagers

  const entries = new Map<CacheCollection, CacheEntry<unknown>>()

  function ttlFor(collection: CacheCollection): number {
    return collection.startsWith('flowCard') ? cardTtlMs : ttlMs
  }

  function load<T>(
    collection: CacheCollection,
    fetchEntries: () => Promise<T[]>,
    identify: (entry: T) => string,
    fetchOptions: FetchOptions | undefined,
  ): Promise<EntityIndex<T>> {
    const existing = entries.get(collection) as CacheEntry<T> | undefined

    if (existing !== undefined) {
      if (existing.pending !== null) return existing.pending
      const isFresh = now() - existing.index.fetchedAt < ttlFor(collection)
      if (isFresh && fetchOptions?.forceRefresh !== true) return Promise.resolve(existing.index)
    }

    const pending = (async () => {
      const values = await fetchEntries()
      const byId = new Map<string, T>()
      for (const value of values) byId.set(identify(value), value)
      const index: EntityIndex<T> = { all: values, byId, fetchedAt: now() }
      entries.set(collection, { index, pending: null } as CacheEntry<unknown>)
      logger?.debug(`Loaded ${collection}`, { entryCount: values.length })
      return index
    })()

    entries.set(collection, {
      index: (existing?.index ?? { all: [], byId: new Map(), fetchedAt: 0 }) as EntityIndex<unknown>,
      pending: pending as Promise<EntityIndex<unknown>>,
    })

    return pending.catch((error: unknown) => {
      entries.delete(collection)
      throw error
    })
  }

  async function loadDevices(fetchOptions?: FetchOptions): Promise<EntityIndex<DeviceSummary>> {
    return load<DeviceSummary>(
      'devices',
      async () => {
        // Zones first so every device carries a room name a model can reason
        // about. It is one cached request, not one per device.
        const zones = await loadZones(fetchOptions)
        const raw = await connection.request(() => managers.devices.getDevices(), 'devices.getDevices', true)
        return toEntries(raw).map((device) => mapDevice(device, zones))
      },
      (device) => device.id,
      fetchOptions,
    )
  }

  async function loadZones(fetchOptions?: FetchOptions): Promise<EntityIndex<ZoneSummary>> {
    return load<ZoneSummary>(
      'zones',
      async () =>
        toEntries(await connection.request(() => managers.zones.getZones(), 'zones.getZones', true)).map(mapZone),
      (zone) => zone.id,
      fetchOptions,
    )
  }

  /**
   * The device and zone names, for owners whose name the library threw away.
   *
   * `FlowCard.transformGet` and `Log.transformGet` both delete `ownerName`, and
   * on a live V3 hub nothing else on the item carries it. The owner id does
   * survive, so a device-owned or zone-owned card can still be given the name
   * its owner has in the two indexes this cache already holds. Failing to load
   * them is not a reason to fail the catalogue: an unnamed card is still usable,
   * so this degrades to an empty lookup rather than throwing.
   */
  async function loadOwnerNames(fetchOptions?: FetchOptions): Promise<OwnerNameLookup> {
    const [devices, zones] = await Promise.all([
      loadDevices(fetchOptions).catch(() => null),
      loadZones(fetchOptions).catch(() => null),
    ])
    return createOwnerNameLookup(devices, zones)
  }

  async function loadFlows(fetchOptions?: FetchOptions): Promise<EntityIndex<FlowSummary>> {
    return load<FlowSummary>(
      'flows',
      async () => {
        const folders = await loadFlowFolders(fetchOptions).catch(() => null)
        const folderNameById = new Map<string, string>()
        for (const folder of folders?.all ?? []) folderNameById.set(folder.id, folder.name)

        const standard = toEntries(
          await connection.request(() => managers.flow.getFlows(), 'flow.getFlows', true),
        ).map((flow) => mapFlow(flow, 'standard', folderNameById))

        const advanced = await loadAdvancedFlows(folderNameById)
        return [...standard, ...advanced]
      },
      (flow) => flow.id,
      fetchOptions,
    )
  }

  async function loadAdvancedFlows(folderNameById: Map<string, string>): Promise<FlowSummary[]> {
    if (options.capabilities?.hardware.advancedFlow === false) return []

    try {
      const raw = await connection.request(() => managers.flow.getAdvancedFlows(), 'flow.getAdvancedFlows', true)
      return toEntries(raw).map((flow) => mapFlow(flow, 'advanced', folderNameById))
    } catch (error) {
      const classified = isHomeyMcpError(error)
        ? error
        : classifyError(error, { operation: 'flow.getAdvancedFlows', notFoundMeans: 'unsupported_hardware' })
      if (classified.reason === 'unsupported_hardware' || classified.reason === 'not_found') {
        // A hub without Advanced Flow has no advanced flows, which is an answer
        // rather than a failure. Anything else is a real problem and is rethrown.
        logger?.info('This Homey has no Advanced Flow support, so no advanced flows were listed')
        return []
      }
      throw classified
    }
  }

  async function loadFlowFolders(fetchOptions?: FetchOptions): Promise<EntityIndex<FlowFolderSummary>> {
    return load<FlowFolderSummary>(
      'flowFolders',
      async () =>
        toEntries(await connection.request(() => managers.flow.getFlowFolders(), 'flow.getFlowFolders', true)).map(
          mapFlowFolder,
        ),
      (folder) => folder.id,
      fetchOptions,
    )
  }

  async function loadFlowCards(kind: FlowCardKind, fetchOptions?: FetchOptions): Promise<EntityIndex<FlowCardDescriptor>> {
    const collection: CacheCollection =
      kind === 'trigger' ? 'flowCardTriggers' : kind === 'condition' ? 'flowCardConditions' : 'flowCardActions'

    const fetchByKind = {
      trigger: () => managers.flow.getFlowCardTriggers(),
      condition: () => managers.flow.getFlowCardConditions(),
      action: () => managers.flow.getFlowCardActions(),
    }

    return load<FlowCardDescriptor>(
      collection,
      async () => {
        const owners = await loadOwnerNames(fetchOptions)
        const raw = await connection.request(fetchByKind[kind], `flow.getFlowCard${capitalise(kind)}s`, true)
        return toEntries(raw).map((card) => mapFlowCard(card, kind, owners))
      },
      (card) => card.id,
      fetchOptions,
    )
  }

  async function loadInsightsLogs(fetchOptions?: FetchOptions): Promise<EntityIndex<InsightsLogSummary>> {
    return load<InsightsLogSummary>(
      'insightsLogs',
      async () => {
        const owners = await loadOwnerNames(fetchOptions)
        const raw = await connection.request(() => managers.insights.getLogs(), 'insights.getLogs', true)
        return toEntries(raw).map((log) => mapInsightsLog(log, owners))
      },
      // The fully qualified log id, which is exactly what the library's
      // getLogEntries expects back: it splits the first three segments off as
      // the owner URI and takes the last as the capability.
      (log) => `${log.uri}:${log.id}`,
      fetchOptions,
    )
  }

  async function loadLogicVariables(fetchOptions?: FetchOptions): Promise<EntityIndex<LogicVariableSummary>> {
    return load<LogicVariableSummary>(
      'logicVariables',
      async () =>
        toEntries(await connection.request(() => managers.logic.getVariables(), 'logic.getVariables', true)).map(
          mapLogicVariable,
        ),
      (variable) => variable.id,
      fetchOptions,
    )
  }

  return {
    getDevices: loadDevices,
    getZones: loadZones,
    getFlows: loadFlows,
    getFlowFolders: loadFlowFolders,
    getFlowCards: loadFlowCards,

    async getAllFlowCards(fetchOptions?: FetchOptions) {
      // Serial on purpose: three list requests fired together is precisely the
      // burst the hub rate limits.
      const triggers = await loadFlowCards('trigger', fetchOptions)
      const conditions = await loadFlowCards('condition', fetchOptions)
      const actions = await loadFlowCards('action', fetchOptions)

      return createFlowCardIndex(
        [...triggers.all, ...conditions.all, ...actions.all],
        Math.min(triggers.fetchedAt, conditions.fetchedAt, actions.fetchedAt),
      )
    },

    getInsightsLogs: loadInsightsLogs,
    getLogicVariables: loadLogicVariables,

    async resolveDevice(reference, fetchOptions) {
      return resolveByName(await loadDevices(fetchOptions), reference, (device) => device.name)
    },
    async resolveZone(reference, fetchOptions) {
      return resolveByName(await loadZones(fetchOptions), reference, (zone) => zone.name)
    },
    async resolveFlow(reference, fetchOptions) {
      return resolveByName(await loadFlows(fetchOptions), reference, (flow) => flow.name)
    },
    async resolveLogicVariable(reference, fetchOptions) {
      return resolveByName(await loadLogicVariables(fetchOptions), reference, (variable) => variable.name)
    },
    async resolveInsightsLog(reference, fetchOptions) {
      return resolveByName(await loadInsightsLogs(fetchOptions), reference, (log) => `${log.ownerName} ${log.title}`)
    },

    invalidate(collection) {
      if (collection === undefined) {
        entries.clear()
        logger?.debug('Cache cleared')
        return
      }
      entries.delete(collection)
      logger?.debug(`Cache cleared for ${collection}`)
    },

    describe() {
      const collections: CacheCollection[] = [
        'devices',
        'zones',
        'flows',
        'flowFolders',
        'flowCardTriggers',
        'flowCardConditions',
        'flowCardActions',
        'insightsLogs',
        'logicVariables',
      ]

      return collections.map((collection) => {
        const entry = entries.get(collection)
        if (entry === undefined || entry.index.fetchedAt === 0) {
          return { collection, loaded: false, entryCount: 0, fetchedAt: null, ageMs: null }
        }
        return {
          collection,
          loaded: true,
          entryCount: entry.index.all.length,
          fetchedAt: new Date(entry.index.fetchedAt).toISOString(),
          ageMs: now() - entry.index.fetchedAt,
        }
      })
    },
  }
}

/**
 * Resolves a phrase to one entry.
 *
 * Exact id wins, then exact name, then a unique prefix, then a unique substring.
 * A reference that fits several entries is reported as ambiguous with every
 * candidate attached, because picking the first one silently would eventually
 * switch off the wrong light.
 */
export function resolveByName<T>(
  index: EntityIndex<T>,
  reference: string,
  nameOf: (entry: T) => string,
): NameResolution<T> {
  const trimmedReference = reference.trim()

  const byId = index.byId.get(trimmedReference)
  if (byId !== undefined) return { match: byId, candidates: [byId], reason: 'id' }

  const normalisedReference = normaliseForComparison(trimmedReference)
  if (normalisedReference === '') return { match: null, candidates: [], reason: 'not_found' }

  const named = index.all.map((entry) => ({ entry, name: normaliseForComparison(nameOf(entry)) }))

  const exactMatches = named.filter((candidate) => candidate.name === normalisedReference)
  if (exactMatches.length === 1 && exactMatches[0] !== undefined) {
    return { match: exactMatches[0].entry, candidates: [exactMatches[0].entry], reason: 'exact_name' }
  }
  if (exactMatches.length > 1) {
    return { match: null, candidates: exactMatches.map((candidate) => candidate.entry), reason: 'ambiguous' }
  }

  const prefixMatches = named.filter((candidate) => candidate.name.startsWith(normalisedReference))
  if (prefixMatches.length === 1 && prefixMatches[0] !== undefined) {
    return { match: prefixMatches[0].entry, candidates: [prefixMatches[0].entry], reason: 'unique_prefix' }
  }

  const substringMatches = named.filter((candidate) => candidate.name.includes(normalisedReference))
  if (substringMatches.length === 1 && substringMatches[0] !== undefined) {
    return { match: substringMatches[0].entry, candidates: [substringMatches[0].entry], reason: 'unique_substring' }
  }

  const candidates = prefixMatches.length > 0 ? prefixMatches : substringMatches
  if (candidates.length > 1) {
    return { match: null, candidates: candidates.map((candidate) => candidate.entry), reason: 'ambiguous' }
  }

  return { match: null, candidates: [], reason: 'not_found' }
}

/**
 * The one text folding used for every name comparison in this server.
 *
 * Exported rather than private because the tool modules filter and search on the
 * same names this resolver matches on. Two foldings that drift apart produce the
 * worst possible symptom: a search that lists a device and a lookup that then
 * cannot find it by the name the search just printed.
 */
export function normaliseForComparison(value: string): string {
  return value
    .normalize('NFKD')
    // Strip accents so "Kantoor" and "Kantóor" are the same room to a model that
    // typed the name from memory.
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Builds the kind-aware card index. Exported so a test can index a hand-built catalogue the same way. */
export function createFlowCardIndex(all: FlowCardDescriptor[], fetchedAt: number): FlowCardIndex {
  const byKindAndId = new Map<string, FlowCardDescriptor>()
  const byCardId = new Map<string, FlowCardDescriptor[]>()

  for (const card of all) {
    byKindAndId.set(flowCardIndexKey(card.kind, card.id), card)
    const sameId = byCardId.get(card.id)
    if (sameId === undefined) byCardId.set(card.id, [card])
    else sameId.push(card)
  }

  return {
    all,
    byKindAndId,
    fetchedAt,
    get: (kind, id) => byKindAndId.get(flowCardIndexKey(kind, id)),
    findById: (id) => byCardId.get(id) ?? [],
  }
}

// ---------------------------------------------------------------------------
// Library item adapter
// ---------------------------------------------------------------------------
//
// The one place where an item handed over by `homey-api` becomes a domain type.
//
// What arrives here is NOT the HTTP payload. Every item goes through its class's
// `transformGet` first, and on the V2 dialect that rewrites fields and then
// deletes the originals: an Insights log loses `uri` and `uriObj` and gains
// `ownerUri` plus a fully qualified `id`, a flow card loses `uriObj` and gains
// `ownerId` and `ownerName`, a device has `driverUri` folded into `driverId`,
// and a flow loses `broken` outright. Several of the deleted names survive as
// prototype getters that log a deprecation warning and return undefined, so
// reading them is both wrong and noisy.
//
// So every mapper below reads the field the library produces first and falls
// back to the raw wire spelling only when it is absent. That fallback is what
// keeps the hand-built fixtures and the V3 dialect working, and it is why the
// mappers must never assume one shape or the other.

/**
 * Reads a field the library may have replaced with a deprecation getter.
 *
 * The getters live on the prototype, return undefined and print a line to
 * stderr on every read. With 808 cards that was over a thousand warning lines
 * on one cold cache fill, into the channel MCP clients show as the server log.
 * An item that genuinely carries the field carries it as an own property: the
 * library defines every transformed property directly on the instance, and a
 * raw capture is a plain object. `hasOwn` is exactly that distinction, so this
 * returns a real wire value and never triggers a getter.
 */
function readOwnField(item: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(item, key) ? item[key] : undefined
}

/** Names for owners the library no longer names itself. Empty maps are valid: an unnamed card still works. */
export interface OwnerNameLookup {
  deviceNameById: ReadonlyMap<string, string>
  zoneNameById: ReadonlyMap<string, string>
}

export function createOwnerNameLookup(
  devices: EntityIndex<DeviceSummary> | null,
  zones: EntityIndex<ZoneSummary> | null,
): OwnerNameLookup {
  const deviceNameById = new Map<string, string>()
  for (const device of devices?.all ?? []) deviceNameById.set(device.id, device.name)

  const zoneNameById = new Map<string, string>()
  for (const zone of zones?.all ?? []) zoneNameById.set(zone.id, zone.name)

  return { deviceNameById, zoneNameById }
}

const EMPTY_OWNER_NAMES: OwnerNameLookup = { deviceNameById: new Map(), zoneNameById: new Map() }

/**
 * The owner's display name, for every owner type that can be named at all.
 *
 * Devices and zones come from the two indexes this cache already holds. A
 * manager is named from its own URI instead, because no index holds managers and
 * nothing else on the item survives to name one.
 *
 * Two owner types are deliberately left unnamed, because neither one can be
 * named from what is in hand:
 *
 *   - An app id is a reverse-DNS identifier (`nu.baretta.openweathermap`), which
 *     is not a name in any language, so the only route to the real one is the app
 *     list. On the measured hub no Insights log is app-owned (the per-app CPU and
 *     memory logs belong to `homey:manager:apps`), and all 31 app-owned flow
 *     cards are named by V2 out of the object it deletes, so nothing is empty
 *     here today. V3 deletes that name and cannot be tested on this hardware, so
 *     it is left alone rather than fixed blind.
 *   - A user URI is `homey:user:<uuid>`, which carries no name at all. The two
 *     user-owned logs on the measured hub (`asleep` and `present`) therefore stay
 *     empty. Naming them would take a request to the users manager and would put
 *     a household member's name into tool output, so it is a decision to make
 *     deliberately rather than a gap to close in passing.
 */
function resolveOwnerName(ownerType: string, ownerId: string, owners: OwnerNameLookup): string | null {
  if (ownerId === '') return null
  if (ownerType === 'device') return owners.deviceNameById.get(ownerId) ?? null
  if (ownerType === 'zone') return owners.zoneNameById.get(ownerId) ?? null
  if (ownerType === 'manager') return managerDisplayName(ownerId)
  return null
}

/**
 * A readable label for a manager, derived from the manager's own identifier.
 *
 * Measured: `homey:manager:weather:temperature` came back with an empty
 * ownerName, so the hub's outdoor weather service was presented exactly like an
 * unnamed device and a model could not tell whose temperature it was reading.
 * The manager URI carries the manager's name inside it, so no request is needed
 * to turn `weather` into "Weather" or `speech-output` into "Speech Output".
 *
 * The hub does have a better name: it sends `uriObj.name` ("Weer" on a Dutch
 * household), and where that survives transformGet it is preferred over this,
 * which is why every mapper reads the library's own field first and only falls
 * back to here. What it does not have is a route to that name on its own. The
 * only place the hub repeats it is the flow card catalogue, and reaching for
 * that to name an Insights log would mean three list requests and 617 KB on a
 * hub that rate limits after four rapid calls, to answer a question about a
 * different collection. The derived label is good enough because a manager
 * identifier is a real English word chosen by Athom rather than an opaque key:
 * it tells a reader which service this is, and the exact identifier is still
 * carried alongside as `ownerId` for anyone who needs to match on it.
 */
export function managerDisplayName(managerId: string): string {
  return managerId
    .split(/[-_]/)
    .filter((word) => word !== '')
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ')
}

/** Collections arrive as an object keyed by id, card lists as an array. Both end up as entries. */
export function toEntries(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
  }
  if (raw !== null && typeof raw === 'object') {
    return Object.values(raw as Record<string, unknown>).filter(
      (entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object',
    )
  }
  return []
}

function mapDevice(raw: Record<string, unknown>, zones: EntityIndex<ZoneSummary>): DeviceSummary {
  const zoneId = asString(raw['zone']) ?? ''
  const zoneFromIndex = zones.byId.get(zoneId)
  const driver = readDriverIdentity(raw)

  return {
    id: asString(raw['id']) ?? '',
    name: asString(raw['name']) ?? '',
    zoneId,
    // The zone index is the authority: a renamed room shows up there first, and
    // the device's own copy of the room name is deleted by the library anyway.
    zoneName: zoneFromIndex?.name ?? asString(readOwnField(raw, 'zoneName')) ?? '',
    class: asString(raw['class']) ?? '',
    virtualClass: asString(raw['virtualClass']),
    driverUri: driver.driverUri,
    driverId: driver.driverId,
    available: raw['available'] === true,
    ready: raw['ready'] === true,
    unavailableMessage: asString(raw['unavailableMessage']),
    capabilities: asStringArray(raw['capabilities']),
    capabilityValues: mapCapabilityValues(raw['capabilitiesObj']),
    // Deleted by `Device.transformGet` on both dialects, so this is populated
    // from a raw capture only. The logs themselves are still reachable through
    // getInsightsLogs, filtered on an owner URI of `homey:device:<device id>`.
    insights: mapDeviceInsights(raw['insights']),
    energyWatts: asNumber(asRecord(raw['energyObj'])?.['W']),
    raw,
  }
}

/**
 * Both halves of the driver identity, whichever shape the device arrived in.
 *
 * `Device.transformGet` sets `driverId` to `<driverUri>:<driverId>` and then
 * deletes `driverUri`, leaving a deprecation getter behind. A raw capture has
 * the two apart. Reading `driverUri` straight off the item is what left it
 * empty on every device on the hub. Both shapes are normalised to the same
 * pair here, so a tool result does not change shape with the dialect.
 */
function readDriverIdentity(raw: Record<string, unknown>): { driverUri: string; driverId: string } {
  const identifier = asString(raw['driverId']) ?? ''
  const wireDriverUri = asString(readOwnField(raw, 'driverUri'))

  if (identifier === '') return { driverUri: wireDriverUri ?? '', driverId: '' }
  if (wireDriverUri !== null && !identifier.startsWith(`${wireDriverUri}:`)) {
    return { driverUri: wireDriverUri, driverId: `${wireDriverUri}:${identifier}` }
  }

  // The folded `driverId` is the same wire shape as a card id, so the owner
  // half is taken with the one implementation of that split rather than a
  // second copy of it. The copy that used to live here disagreed with the
  // shared one on an identifier too short to carry an owner.
  return { driverUri: wireDriverUri ?? splitCanonicalCardId(identifier).ownerUri, driverId: identifier }
}

function mapCapabilityValues(raw: unknown): Record<string, DeviceCapabilityValue> {
  const record = asRecord(raw)
  if (record === null) return {}

  const values: Record<string, DeviceCapabilityValue> = {}
  for (const [capabilityId, rawCapability] of Object.entries(record)) {
    const capability = asRecord(rawCapability)
    if (capability === null) continue

    values[capabilityId] = {
      id: asString(capability['id']) ?? capabilityId,
      title: asString(capability['title']) ?? capabilityId,
      type: asCapabilityType(capability['type']),
      value: asCapabilityValue(capability['value']),
      lastUpdated: asIsoTimestamp(capability['lastUpdated']),
      getable: capability['getable'] !== false,
      setable: capability['setable'] === true,
      units: asString(capability['units']),
      decimals: asNumber(capability['decimals']),
      values: mapIdTitleList(capability['values']),
      min: asNumber(capability['min']),
      max: asNumber(capability['max']),
      step: asNumber(capability['step']),
    }
  }
  return values
}

function mapDeviceInsights(raw: unknown): DeviceInsightReference[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const record = asRecord(entry)
    if (record === null) return []
    return [
      {
        uri: asString(record['uri']) ?? '',
        id: asString(record['id']) ?? '',
        type: record['type'] === 'boolean' ? ('boolean' as const) : ('number' as const),
        title: asString(record['title']) ?? '',
        units: asString(record['units']),
        decimals: asNumber(record['decimals']),
      },
    ]
  })
}

function mapZone(raw: Record<string, unknown>): ZoneSummary {
  return {
    id: asString(raw['id']) ?? '',
    name: asString(raw['name']) ?? '',
    parentZoneId: asString(raw['parent']),
    order: asNumber(raw['order']) ?? 0,
    active: raw['active'] === true,
    activeLastUpdated: asString(raw['activeLastUpdated']),
    icon: asString(raw['icon']),
    raw,
  }
}

function mapFlow(
  raw: Record<string, unknown>,
  kind: FlowSummary['kind'],
  folderNameById: Map<string, string>,
): FlowSummary {
  const folderId = asString(raw['folder'])

  return {
    id: asString(raw['id']) ?? '',
    name: asString(raw['name']) ?? '',
    kind,
    enabled: raw['enabled'] === true,
    // Null, not false. Both `Flow.transformGet` and `AdvancedFlow.transformGet`
    // end with `delete item.broken` on the V2 dialect, so an absent flag means
    // the hub was never asked, not that the flow is healthy. Reading it as false
    // is what made a broken-only filter answer "none" on a hub with three.
    broken: typeof raw['broken'] === 'boolean' ? raw['broken'] : null,
    triggerable: raw['triggerable'] === true,
    folderId,
    folderName: folderId === null ? null : (folderNameById.get(folderId) ?? null),
    order: asNumber(raw['order']),
    triggerCount: asNumber(raw['triggerCount']),
    raw,
  }
}

function mapFlowFolder(raw: Record<string, unknown>): FlowFolderSummary {
  return {
    id: asString(raw['id']) ?? '',
    name: asString(raw['name']) ?? '',
    parentFolderId: asString(raw['parent']),
    raw,
  }
}

function mapFlowCard(
  raw: Record<string, unknown>,
  kind: FlowCardKind,
  owners: OwnerNameLookup = EMPTY_OWNER_NAMES,
): FlowCardDescriptor {
  // `ownerUri` is what both dialects produce after transformGet, and the raw
  // wire spelling `uri` is the fallback for a capture. The order matters: on a
  // live item `uri` is still readable, but it holds the base class's synthetic
  // `homey:flowcardtrigger:<id>` rather than the owner.
  const ownerUri = asString(raw['ownerUri']) ?? asString(readOwnField(raw, 'uri')) ?? ''
  const identifier = asString(raw['id']) ?? ''
  const isAlreadyCanonical = ownerUri !== '' && identifier.startsWith(`${ownerUri}:`)
  const canonicalId = ownerUri === '' || isAlreadyCanonical ? identifier : toCanonicalCardId(ownerUri, identifier)
  const shortId = isAlreadyCanonical ? identifier.slice(ownerUri.length + 1) : identifier

  // Only present on a raw capture: the V2 card classes copy `id`, `name`,
  // `color` and `iconObj` out of it and then delete it, and what is left is a
  // deprecation getter.
  const ownerObject = asRecord(readOwnField(raw, 'uriObj')) ?? asRecord(readOwnField(raw, 'ownerUriObj'))
  const ownerSegments = ownerUri.split(':')
  const ownerType = asOwnerType(ownerSegments[1] ?? asString(ownerObject?.['type']) ?? undefined)
  const ownerId = asString(raw['ownerId']) ?? asString(ownerObject?.['id']) ?? ownerSegments.slice(2).join(':')

  return {
    kind,
    id: canonicalId,
    ownerUri,
    ownerType,
    ownerId,
    // V2 fills `ownerName` in from the object it then deletes, V3 deletes the
    // name altogether, and a capture only has it inside `uriObj`. Where the
    // library kept nothing, the owner is looked up by id instead, because an
    // empty owner name means `homey_flowcards_search({owner: 'Sonos'})` matches
    // nothing and one of the four ways to narrow the catalogue stops working.
    ownerName:
      asString(readOwnField(raw, 'ownerName')) ??
      asString(ownerObject?.['name']) ??
      resolveOwnerName(ownerType, ownerId, owners) ??
      '',
    shortId,
    title: asString(raw['title']) ?? shortId,
    hint: asString(raw['hint']),
    deprecated: raw['deprecated'] === true,
    advanced: raw['advanced'] === true,
    args: mapFlowCardArguments(raw['args']),
    tokens: mapFlowCardTokens(raw['tokens']),
    raw,
  }
}

function mapFlowCardArguments(raw: unknown): FlowCardArgumentDescriptor[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const record = asRecord(entry)
    if (record === null) return []
    return [
      {
        name: asString(record['name']) ?? '',
        type: asString(record['type']) ?? '',
        title: asString(record['title']),
        placeholder: asString(record['placeholder']),
        // Homey treats an argument as required unless it says otherwise.
        required: record['required'] !== false,
        values: mapIdTitleList(record['values']),
        raw: record,
      },
    ]
  })
}

function mapFlowCardTokens(raw: unknown): FlowCardTokenDescriptor[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const record = asRecord(entry)
    if (record === null) return []
    return [
      {
        id: asString(record['id']) ?? '',
        type: asString(record['type']) ?? '',
        title: asString(record['title']) ?? '',
        example: record['example'] === undefined ? null : String(record['example']),
      },
    ]
  })
}

function mapInsightsLog(
  raw: Record<string, unknown>,
  owners: OwnerNameLookup = EMPTY_OWNER_NAMES,
): InsightsLogSummary {
  // `ownerUri` first. On a live item `uri` is the base class's synthetic
  // `homey:log:<id>`, and mapping that as the owner produced a doubled
  // identifier (`homey:log:homey:device:...:homey:device:...`) which the
  // library then split into `homey:log:homey` and asked the hub for, so every
  // Insights query on the hub answered 404.
  const ownerUri = asString(raw['ownerUri']) ?? asString(readOwnField(raw, 'uri')) ?? ''
  const ownerSegments = ownerUri.split(':')

  // Only present on a raw capture; both dialects delete it in transformGet.
  const owner = asRecord(readOwnField(raw, 'uriObj'))

  const ownerType = ownerSegments[1] ?? asString(owner?.['type']) ?? ''
  // Derived from the owner URI, never read off `ownerId`: the V2 Log transform
  // assigns the log's own short id to that field (`item.ownerId = item.id` runs
  // before the id is rewritten), so on this hardware it holds
  // `measure_temperature` rather than the device that measured it.
  const ownerId = ownerSegments.slice(2).join(':')

  // After transformGet the id is fully qualified. The domain keeps the two
  // apart, because the owner URI and the short id are what the hub's Insights
  // routes take, and callers rejoin them into `<ownerUri>:<shortId>`.
  const identifier = asString(raw['id']) ?? ''
  const shortId =
    ownerUri !== '' && identifier.startsWith(`${ownerUri}:`) ? identifier.slice(ownerUri.length + 1) : identifier

  return {
    uri: ownerUri,
    ownerType,
    ownerId,
    // Deleted on both dialects, so the device index is the only route left to a
    // readable owner. Without it every log scored as belonging to nothing and
    // no search on a device name ever matched one.
    ownerName:
      asString(readOwnField(raw, 'ownerName')) ??
      asString(owner?.['name']) ??
      resolveOwnerName(ownerType, ownerId, owners) ??
      '',
    id: shortId,
    title: asString(raw['title']) ?? '',
    type: raw['type'] === 'boolean' ? 'boolean' : 'number',
    units: asString(raw['units']),
    decimals: asNumber(raw['decimals']),
    titleTrue: asString(raw['titleTrue']),
    titleFalse: asString(raw['titleFalse']),
    lastValue: asCapabilityValue(raw['lastValue']) as number | boolean | null,
    raw,
  }
}

function mapLogicVariable(raw: Record<string, unknown>): LogicVariableSummary {
  const type = raw['type']
  return {
    id: asString(raw['id']) ?? '',
    name: asString(raw['name']) ?? '',
    type: type === 'boolean' || type === 'number' ? type : 'string',
    value: asCapabilityValue(raw['value']),
    raw,
  }
}

function mapIdTitleList(raw: unknown): Array<{ id: string; title: string }> {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const record = asRecord(entry)
    if (record === null) return []
    const id = asString(record['id'])
    if (id === null) return []
    return [{ id, title: asString(record['title']) ?? id }]
  })
}

function asCapabilityType(value: unknown): DeviceCapabilityValue['type'] {
  return value === 'boolean' || value === 'number' || value === 'enum' ? value : 'string'
}

function asCapabilityValue(value: unknown): boolean | number | string | null {
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value
  return null
}

/**
 * An ISO timestamp from either shape.
 *
 * `Device.transformGet` replaces every capability's `lastUpdated` with a Date
 * instance, while a raw capture leaves it an ISO string. Reading it as a string
 * only is what made "when did this last change" answer null on every live
 * device.
 */
function asIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  return asString(value)
}

/** Passes an unrecognised owner type through unchanged rather than folding it into a known one. */
function asOwnerType(value: string | undefined): FlowCardOwnerType {
  return value ?? ''
}

function capitalise(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}
