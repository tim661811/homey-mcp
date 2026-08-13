// Shared domain types. Every other module in the server codes against these.
//
// The shapes here are the server's own vocabulary, not the wire format. Field
// names are spelled out (`watts`, not `W`) and identifiers are always paired
// with the name they resolve to, because a model cannot reason about a bare
// UUID. Modules that read the hub are responsible for mapping wire payloads
// onto these types, and each carries the original payload under `raw` so a tool
// can still reach a field this vocabulary does not model yet.

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * Which API dialect the connected hub speaks.
 *
 * `v2` is Homey Pro (Early 2019) and older, `v3` is Homey Pro (Early 2023) and
 * newer. This is detected by looking at a real flow card descriptor, never
 * derived from a firmware version string: both generations run firmware 13.x
 * with completely different API surfaces.
 */
export type HomeyDialect = 'v2' | 'v3'

/** The address ladder, in the order it is tried. Measured: localSecure 142 ms, local 25 ms, cloud 195 ms. */
export type HomeyAddressKind = 'localSecure' | 'local' | 'cloud'

export interface HomeyIdentity {
  id: string
  name: string
  modelId: string
  modelName: string
  softwareVersion: string
  /**
   * 1 for the 2016-2019 generation, 2 for 2023 and newer.
   *
   * Measured: the field is absent from `system.getInfo()` on firmware 13.2.4 on
   * a Homey Pro (Early 2019), and the documented rule for that case is to treat
   * it as 1. It is reported for diagnostics only. Never gate a feature on it,
   * gate on the capability registry instead.
   */
  platformVersion: number
  /** The hub's interface language, for example `nl`. Empty when the hub did not report one: never guessed. */
  language: string
  /** IANA zone from the hub, for example `Europe/Amsterdam`. Insights windows are cut in this zone, not the server's. */
  timezone: string
  address: string
  addressKind: HomeyAddressKind
}

export interface RequestQueue {
  /**
   * Queues one hub call.
   *
   * `idempotent` is the caller's promise that running the operation twice has
   * the same effect as running it once, which is what lets the queue repeat it
   * after a timeout or a 5xx. Reads are idempotent; a write is only idempotent
   * if a second execution genuinely changes nothing more (setting a capability
   * to a fixed value is, starting a flow or creating one is not). It defaults to
   * false so a call added later cannot become retryable by omission.
   */
  run<T>(operation: () => Promise<T>, label: string, idempotent?: boolean): Promise<T>
  readonly inFlight: number
  /** Operations accepted but not started yet. Diagnostics only. */
  readonly queued: number
}

export interface HomeyConnection {
  /** The `homey-api` instance. Typed as unknown because the library ships no usable types for the manager surface. */
  readonly api: unknown
  readonly dialect: HomeyDialect
  readonly identity: HomeyIdentity
  readonly queue: RequestQueue
  /**
   * Runs one hub call through the shared queue and converts any failure into a
   * HomeyMcpError. `label` names the operation in logs and in error details,
   * for example `flow.getFlows`.
   *
   * `idempotent` says whether repeating the operation is harmless, and decides
   * whether the queue may retry it after a timeout, a reset or a 5xx. Pass true
   * for reads. Leave it out for anything that changes the house: the default of
   * false is what stops a lost reply from opening a garage door four times.
   */
  request<T>(operation: () => Promise<T>, label: string, idempotent?: boolean): Promise<T>
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Why a probe answered the way it did. Kept so `doctor` can explain a false without guessing. */
export type CapabilityProbeStatus = 'available' | 'unsupported' | 'forbidden' | 'failed'

export interface CapabilityProbeOutcome {
  status: CapabilityProbeStatus
  /** The call that was made, for example `flow.getAdvancedFlows`. */
  probe: string
  statusCode: number | null
  durationMs: number
  detail: string | null
}

export interface CapabilityRegistry {
  hardware: {
    advancedFlow: boolean
    energyReports: boolean
    moods: boolean
    insights: boolean
  }
  probedAt: string
  notes: string[]
  /**
   * Full probe detail keyed by capability name, including probes that do not
   * appear in `hardware` (`energyLive`, `logicVariables`, `weather`,
   * `weatherHourlyForecast`). Always populated by `detectCapabilities`; optional
   * so a test can build a minimal registry.
   *
   * A probe earns a place in `hardware` when something other than its own tool
   * has to branch on it: `advancedFlow` decides which tools are registered at
   * all, `insights` gates a device field, `energyReports` changes what the energy
   * tool says about history. A capability only its own tool reads stays here,
   * where `doctor --report` still publishes it for hardware nobody here owns.
   */
  probes?: Record<string, CapabilityProbeOutcome>
}

// ---------------------------------------------------------------------------
// Devices and zones
// ---------------------------------------------------------------------------

export type CapabilityValueType = 'boolean' | 'number' | 'string' | 'enum'

export interface DeviceCapabilityValue {
  id: string
  title: string
  type: CapabilityValueType
  value: boolean | number | string | null
  lastUpdated: string | null
  getable: boolean
  setable: boolean
  units: string | null
  decimals: number | null
  /** Allowed entries for an `enum` capability, empty for every other type. */
  values: Array<{ id: string; title: string }>
  min: number | null
  max: number | null
  step: number | null
}

export interface DeviceInsightReference {
  uri: string
  id: string
  type: 'number' | 'boolean'
  title: string
  units: string | null
  decimals: number | null
}

export interface DeviceSummary {
  id: string
  name: string
  zoneId: string
  zoneName: string
  /** Homey device class, for example `light`, `sensor`, `socket`. */
  class: string
  /** Set when the owner overrode the class in the app. Falls back to null, never to `class`. */
  virtualClass: string | null
  driverUri: string
  driverId: string
  available: boolean
  ready: boolean
  unavailableMessage: string | null
  capabilities: string[]
  capabilityValues: Record<string, DeviceCapabilityValue>
  insights: DeviceInsightReference[]
  /** Instantaneous draw in watts when the device reports energy, otherwise null. */
  energyWatts: number | null
  raw: unknown
}

export interface ZoneSummary {
  id: string
  name: string
  parentZoneId: string | null
  order: number
  active: boolean
  activeLastUpdated: string | null
  icon: string | null
  raw: unknown
}

// ---------------------------------------------------------------------------
// Flows and flow cards
// ---------------------------------------------------------------------------

export type FlowKind = 'standard' | 'advanced'

export interface FlowSummary {
  id: string
  name: string
  kind: FlowKind
  enabled: boolean
  /**
   * Firmware-computed and read-only. Never send it back.
   *
   * Null means unknown rather than healthy: `homey-api` deletes `broken` from
   * every flow on the V2 dialect, so the hub's answer never reaches us there.
   * Reading an absent flag as false is what made `brokenOnly` report zero on a
   * hub that has three broken flows. Treat null as "not established" and say so
   * rather than implying the flow is fine.
   */
  broken: boolean | null
  /** Firmware-computed and read-only. Never send it back. */
  triggerable: boolean
  folderId: string | null
  folderName: string | null
  order: number | null
  /** Firmware-computed and read-only. Absent on advanced flows. */
  triggerCount: number | null
  raw: unknown
}

export interface FlowFolderSummary {
  id: string
  name: string
  parentFolderId: string | null
  raw: unknown
}

export type FlowCardKind = 'trigger' | 'condition' | 'action'

/**
 * What owns a flow card. These five are what the measured hub reports, but the
 * union stays open: a future firmware inventing a sixth must show up verbatim
 * rather than being folded into whichever of these looked closest.
 */
export type FlowCardOwnerType = 'manager' | 'app' | 'device' | 'zone' | 'appwidget' | (string & {})

/**
 * A card kind with its article, as "a trigger" or "an action".
 *
 * Here rather than in each module that writes a sentence about a kind, because
 * gluing a fixed "a" to an interpolated kind is what produced "is a trigger and
 * a action card" in the validator and "this card is a action" in the card
 * description. The three kinds are a closed set, so the vowel is all the rule
 * this needs.
 */
export function flowCardKindWithArticle(kind: FlowCardKind): string {
  return kind === 'action' ? `an ${kind}` : `a ${kind}`
}

export interface FlowCardArgumentDescriptor {
  name: string
  /** `autocomplete`, `dropdown`, `text`, `number`, `time`, `device`, and app-specific types. */
  type: string
  title: string | null
  placeholder: string | null
  required: boolean
  /** Fixed choices for a `dropdown`. An `autocomplete` argument is resolved through the hub instead. */
  values: Array<{ id: string; title: string }>
  raw: unknown
}

export interface FlowCardTokenDescriptor {
  id: string
  type: string
  title: string
  example: string | null
}

export interface FlowCardDescriptor {
  kind: FlowCardKind
  /**
   * Canonical, fully qualified card id in the V3 form
   * (`homey:device:<uuid>:alarm_contact_true`). On a V2 hub this is assembled
   * from the wire's `uri` and short `id`, so tool schemas are identical across
   * generations.
   */
  id: string
  ownerUri: string
  ownerType: FlowCardOwnerType
  ownerId: string
  ownerName: string
  /** The short, owner-relative id the V2 wire format carries separately. */
  shortId: string
  title: string
  hint: string | null
  deprecated: boolean
  advanced: boolean
  args: FlowCardArgumentDescriptor[]
  tokens: FlowCardTokenDescriptor[]
  raw: unknown
}

/**
 * Looking a flow card up in the catalogue.
 *
 * Card ids are NOT unique across kinds: `homey:manager:flow:programmatic_trigger`
 * is both the trigger "this Flow has started" and the action "start a Flow". So
 * every lookup either says which kind it is holding, or asks for all of them.
 * The full index in `cache.ts` satisfies this; anything that only needs to read
 * the catalogue takes this narrower shape, which keeps the flow model free of a
 * dependency on the cache.
 */
export interface FlowCardLookup {
  /** The one card of this kind carrying this id. */
  get(kind: FlowCardKind, id: string): FlowCardDescriptor | undefined
  /** Every card carrying this id, at most one per kind, empty when the hub has none. */
  findById(id: string): FlowCardDescriptor[]
}

/**
 * Assembles the canonical V3 card id from a V2 owner URI and short id.
 *
 * The library's own rule, read from `homey-api`, is `uri = id.split(':', 3).join(':')`,
 * so joining with a colon is its exact inverse.
 */
export function toCanonicalCardId(ownerUri: string, shortId: string): string {
  return `${ownerUri}:${shortId}`
}

/**
 * Splits a canonical V3 card id back into the owner URI and short id a V2 hub expects.
 *
 * This is the only implementation of that split in the server, and it is the
 * only place the rule may be written, because the rule is not ours: it has to
 * stay identical to `homey-api`'s `uri = id.split(':', 3).join(':')` or a card
 * addressed here reaches a different card there. Insights log ids
 * (`analytics/series.ts`) and the folded `driverId` on a device
 * (`homey/cache.ts`) are the same wire shape and come through here too. A
 * second copy agreed on the happy path and answered the degenerate one
 * differently, which is how one rule became two.
 */
export function splitCanonicalCardId(canonicalId: string): { ownerUri: string; shortId: string } {
  const segments = canonicalId.split(':')
  if (segments.length < 4) {
    // An identifier with fewer than four segments has no short id to split off,
    // so the caller is holding something that is not a canonical card id. It
    // comes back whole because that is what the library's own split answers for
    // it, and answering differently here would be a second rule.
    return { ownerUri: canonicalId, shortId: '' }
  }
  return {
    ownerUri: segments.slice(0, 3).join(':'),
    shortId: segments.slice(3).join(':'),
  }
}

// ---------------------------------------------------------------------------
// Logic variables
// ---------------------------------------------------------------------------

export type LogicVariableType = 'boolean' | 'number' | 'string'

export interface LogicVariableSummary {
  id: string
  name: string
  type: LogicVariableType
  value: boolean | number | string | null
  raw: unknown
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

/**
 * The complete set of resolutions the hub accepts.
 *
 * Measured: an unrecognised resolution is accepted with HTTP 200 and answered
 * with a default window instead of an error, so a typo produces plausible but
 * wrong data. Validate against this list before sending anything.
 */
export const INSIGHTS_RESOLUTIONS = [
  'lastHour',
  'last6Hours',
  'last24Hours',
  'last7Days',
  'last14Days',
  'last31Days',
  'last2Years',
  'today',
  'yesterday',
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'thisYear',
  'lastYear',
] as const

export type InsightsResolution = (typeof INSIGHTS_RESOLUTIONS)[number]

export type InsightsLogType = 'number' | 'boolean'

export interface InsightsLogSummary {
  /** Owner URI, for example `homey:device:<uuid>`. */
  uri: string
  ownerType: string
  ownerId: string
  ownerName: string
  id: string
  title: string
  type: InsightsLogType
  units: string | null
  decimals: number | null
  /** Labels a boolean log's two states. Null on numeric logs. */
  titleTrue: string | null
  titleFalse: string | null
  lastValue: number | boolean | null
  raw: unknown
}

export interface InsightsEntry {
  /** ISO timestamp of the bucket start. */
  t: string
  /** Null marks a gap in the series. Measured on real data: every statistic must be null-safe. */
  v: number | boolean | null
}

export interface InsightsSeries {
  uri: string
  id: string
  start: string
  end: string
  /** Bucket width in milliseconds, read off the response. Never assume it from the resolution. */
  step: number
  values: InsightsEntry[]
  lastValue: number | boolean | null
  updatesIn: number | null
}

// ---------------------------------------------------------------------------
// Energy
// ---------------------------------------------------------------------------

export interface EnergyAmount {
  watts: number | null
  cost: number | null
}

export interface EnergyReportItem {
  type: 'zone' | 'device'
  id: string
  name: string
  values: EnergyAmount
  isHomeBattery: boolean
  isElectricCar: boolean
  raw: unknown
}

export interface EnergyLiveReport {
  zoneId: string
  zoneName: string
  currency: string
  totalConsumed: EnergyAmount
  totalCumulative: EnergyAmount
  totalGenerated: EnergyAmount
  items: EnergyReportItem[]
  raw: unknown
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export interface HomeySystemInfo {
  homeyVersion: string
  homeyModelId: string
  homeyModelName: string
  timezone: string
  /** Present on the hub, absent on the 2019 generation's firmware. Null means "treat as generation 1". */
  homeyPlatformVersion: number | null
  cloudId: string | null
  totalMemoryBytes: number | null
  freeMemoryBytes: number | null
  uptimeSeconds: number | null
  nodeVersion: string | null
  raw: unknown
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface AddressCandidate {
  kind: HomeyAddressKind
  /** Origin only, with no trailing slash, for example `http://<lan-ip>`. */
  address: string
}

export interface AddressProbeResult {
  kind: HomeyAddressKind
  address: string
  reachable: boolean
  /** Round trip of the ping in milliseconds, whether it succeeded or failed. `doctor` prints this. */
  durationMs: number
  /** From the `X-Homey-ID` response header. Null when the address answered but is not a Homey. */
  homeyId: string | null
  /** From the `X-Homey-Version` response header, for example `13.2.4`. */
  homeyVersion: string | null
  statusCode: number | null
  /** Human readable reason the probe failed. Already redacted. Null on success. */
  error: string | null
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** `skip` is a check that could not run yet, which is not the same as one that passed. */
export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip'

/**
 * One diagnostic check.
 *
 * Shared between the `doctor` subcommand, which runs before a connection exists,
 * and the `homey_doctor` tool, which runs inside a connected server. They check
 * different things, but a caller must be able to read both reports the same way,
 * so the shape lives here rather than being declared twice.
 *
 * `fix` is null only when the check passed. A failure with nothing to do about it
 * has moved the problem rather than reported it.
 */
export interface DoctorCheck {
  id: string
  title: string
  status: DoctorStatus
  detail: string
  fix: string | null
}
