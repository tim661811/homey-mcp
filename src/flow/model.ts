// The canonical internal shape of a standard flow, and its translation to the wire.
//
// Everything inside this server models a flow card as ONE fully qualified id
// (`homey:device:<uuid>:alarm_contact_true`), which is the V3 form. A Homey Pro
// (Early 2019) speaks V2 on the wire, where the same card is split into
// `{ uri: 'homey:device:<uuid>', id: 'alarm_contact_true' }`. Keeping one
// internal form means the MCP tool schemas are identical on both generations,
// and the split happens in exactly one place.
//
// Read `toLibraryPayload` before wiring anything up: `homey-api` performs the
// V2 split itself, so the payload handed to the library is always the canonical
// form, never the already-split one.

import type { HomeyDialect } from '../homey/types.js'
import { splitCanonicalCardId } from '../homey/types.js'

/**
 * Conditions inside one group are ANDed, groups are ORed with each other.
 *
 * The V2 schema enumerates exactly these three. V3 does not constrain the
 * value, so `validateFlow` only enforces the enum when talking to a V2 hub.
 */
export const CONDITION_GROUPS = ['group1', 'group2', 'group3'] as const
export type ConditionGroup = (typeof CONDITION_GROUPS)[number]

/** `then` runs when the condition expression is true, `else` when it is false. */
export const ACTION_GROUPS = ['then', 'else'] as const
export type ActionGroup = (typeof ACTION_GROUPS)[number]

export const DEFAULT_CONDITION_GROUP: ConditionGroup = 'group1'
export const DEFAULT_ACTION_GROUP: ActionGroup = 'then'

/**
 * Firmware-computed fields that must never be sent back.
 *
 * `broken` and `triggerable` are marked `x-homey-readonly` in the API
 * specification, and `triggerCount` is a running counter. Sending any of them
 * is at best ignored and at worst overwrites the hub's own bookkeeping.
 */
export const READ_ONLY_FLOW_FIELDS = ['broken', 'triggerable', 'triggerCount'] as const

/** A card inside a standard flow, in the canonical V3 form. */
export interface CanonicalCard {
  /** Fully qualified card id, for example `homey:manager:notifications:create_notification`. */
  id: string
  /** Keyed by the argument `name` from the card descriptor. Always an object, never null. */
  args?: Record<string, unknown>
  /** `group1`..`group3` on a condition, `then` or `else` on an action. */
  group?: string
  /** Condition only. `true` means "is NOT". */
  inverted?: boolean
  /** Action only. Whole seconds to wait before running. Serialised as `{number, multiplier}`. */
  delay?: number | null
  /** Action only. Whole seconds to hold the action for. Serialised as `{number, multiplier}`. */
  duration?: number | null
  /** A global token dropped onto the card, as `<ownerUri>|<tokenId>`. Pipe, never colon. */
  droptoken?: string | null
}

export interface CanonicalFlow {
  name: string
  enabled?: boolean
  folder?: string | null
  trigger: CanonicalCard
  conditions: CanonicalCard[]
  actions: CanonicalCard[]
}

/** A flow read back from the hub, so the id and the read-only fields are known. */
export interface StoredCanonicalFlow extends CanonicalFlow {
  id: string
  broken: boolean | null
  triggerable: boolean | null
  triggerCount: number | null
  order: number | null
}

/** The `{number, multiplier}` pair the firmware uses for a delay or a duration. */
export interface WireInterval {
  /** Decimal string. The firmware rejects a JSON number here. */
  number: string
  /** 1 means `number` counts seconds, 60 means it counts minutes. */
  multiplier: number
}

// ---------------------------------------------------------------------------
// Interval encoding
// ---------------------------------------------------------------------------

/**
 * Encodes whole seconds as the firmware's interval pair.
 *
 * Whole minutes are emitted with `multiplier: 60` so the Homey app shows
 * "2 minutes" rather than "120 seconds", which is what the editor writes for
 * the same value.
 */
export function toWireInterval(seconds: number | null | undefined): WireInterval | null {
  if (seconds === null || seconds === undefined) return null
  if (!Number.isFinite(seconds) || seconds < 0) return null
  if (seconds === 0) return null

  if (seconds >= 60 && seconds % 60 === 0) {
    return { number: String(seconds / 60), multiplier: 60 }
  }
  return { number: String(seconds), multiplier: 1 }
}

/** Decodes the firmware's interval pair back to whole seconds. Null when the pair is absent or unreadable. */
export function fromWireInterval(value: unknown): number | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const rawNumber = record['number']
  const rawMultiplier = record['multiplier']

  const parsedNumber = typeof rawNumber === 'number' ? rawNumber : Number.parseFloat(String(rawNumber ?? ''))
  const parsedMultiplier = typeof rawMultiplier === 'number' ? rawMultiplier : Number.parseFloat(String(rawMultiplier ?? ''))

  if (!Number.isFinite(parsedNumber) || !Number.isFinite(parsedMultiplier)) return null
  return parsedNumber * parsedMultiplier
}

// ---------------------------------------------------------------------------
// Canonical to wire
// ---------------------------------------------------------------------------

function cardToWire(card: CanonicalCard, dialect: HomeyDialect, role: 'trigger' | 'condition' | 'action'): Record<string, unknown> {
  const wire: Record<string, unknown> = {}

  if (dialect === 'v2') {
    const { ownerUri, shortId } = splitCanonicalCardId(card.id)
    wire['uri'] = ownerUri
    wire['id'] = shortId
  } else {
    wire['id'] = card.id
  }

  // Never null and never omitted: the firmware and the app editor both expect
  // an object here even when the card takes no arguments.
  wire['args'] = card.args ?? {}

  if (typeof card.droptoken === 'string' && card.droptoken !== '') {
    wire['droptoken'] = card.droptoken
  }

  if (role === 'condition') {
    wire['group'] = card.group ?? DEFAULT_CONDITION_GROUP
    wire['inverted'] = card.inverted === true
  }

  if (role === 'action') {
    wire['group'] = card.group ?? DEFAULT_ACTION_GROUP
    wire['delay'] = toWireInterval(card.delay)
    wire['duration'] = toWireInterval(card.duration)
  }

  return wire
}

/**
 * Serialises a flow to the raw wire body the hub's REST endpoint accepts.
 *
 * This is the true HTTP shape for the given dialect. It is what a raw fetch
 * would post, and what the fixtures in `tests/fixtures` are shaped like. When
 * calling through `homey-api`, use `toLibraryPayload` instead.
 */
export function toWire(flow: CanonicalFlow, dialect: HomeyDialect): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    name: flow.name,
    trigger: cardToWire(flow.trigger, dialect, 'trigger'),
    conditions: flow.conditions.map((condition) => cardToWire(condition, dialect, 'condition')),
    actions: flow.actions.map((action) => cardToWire(action, dialect, 'action')),
  }

  if (flow.enabled !== undefined) wire['enabled'] = flow.enabled
  if (flow.folder !== undefined) wire['folder'] = flow.folder

  return wire
}

/**
 * Serialises a flow for `homey-api`'s `createFlow` / `updateFlow` / `testFlow`.
 *
 * Always the canonical V3 form, on both generations. The reason is that
 * `HomeyAPIV2.ManagerFlow` runs `Flow.transformSet` on whatever it is given,
 * and that transform derives the owner uri with `id.split(':', 3).join(':')`.
 * Handing it an already-split card would split the short id a second time and
 * post `{ uri: 'alarm_contact_true', id: '' }`, which the hub stores as a
 * broken card without complaining.
 */
export function toLibraryPayload(flow: CanonicalFlow): Record<string, unknown> {
  return toWire(flow, 'v3')
}

// ---------------------------------------------------------------------------
// Wire to canonical
// ---------------------------------------------------------------------------

function cardFromWire(raw: unknown, role: 'trigger' | 'condition' | 'action'): CanonicalCard | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>

  const rawId = typeof record['id'] === 'string' ? record['id'] : ''
  const rawUri = typeof record['uri'] === 'string' ? record['uri'] : null

  // `homey-api` already joins the V2 pair before the payload reaches us, so a
  // card can arrive in either shape regardless of the dialect. Detect it from
  // the payload rather than trusting the dialect, which is what makes the raw
  // hardware captures and the library output both parse here.
  const isSplit = rawUri !== null && !rawId.startsWith(`${rawUri}:`)
  const canonicalId = isSplit ? `${rawUri}:${rawId}` : rawId

  const card: CanonicalCard = { id: canonicalId }

  const rawArgs = record['args']
  card.args = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? (rawArgs as Record<string, unknown>)
    : {}

  if (typeof record['droptoken'] === 'string' && record['droptoken'] !== '') {
    card.droptoken = record['droptoken']
  }

  if (role === 'condition') {
    if (typeof record['group'] === 'string') card.group = record['group']
    card.inverted = record['inverted'] === true
  }

  if (role === 'action') {
    if (typeof record['group'] === 'string') card.group = record['group']
    card.delay = fromWireInterval(record['delay'])
    card.duration = fromWireInterval(record['duration'])
  }

  return card
}

/**
 * Parses a wire flow into the canonical form.
 *
 * `dialect` is accepted for symmetry with `toWire` but is not consulted: each
 * card is recognised from its own payload, because `homey-api` may already have
 * joined a V2 pair before the flow reaches this function while a raw capture of
 * the same hub still carries the split form.
 */
export function fromWire(wire: unknown, dialect: HomeyDialect): CanonicalFlow {
  void dialect

  if (wire === null || typeof wire !== 'object') {
    return { name: '', trigger: { id: '', args: {} }, conditions: [], actions: [] }
  }
  const record = wire as Record<string, unknown>

  const trigger = cardFromWire(record['trigger'], 'trigger')

  const flow: CanonicalFlow = {
    name: typeof record['name'] === 'string' ? record['name'] : '',
    // A flow without a trigger is a real state on the wire only for a payload
    // that was never valid, so it is surfaced as an empty card id rather than
    // invented. `validateFlow` reports it with the firmware's own reason.
    trigger: trigger ?? { id: '', args: {} },
    conditions: toCardArray(record['conditions'], 'condition'),
    actions: toCardArray(record['actions'], 'action'),
  }

  if (typeof record['enabled'] === 'boolean') flow.enabled = record['enabled']
  if ('folder' in record) {
    const folder = record['folder']
    flow.folder = typeof folder === 'string' ? folder : null
  }

  return flow
}

/** Parses a wire flow including the fields only the hub can fill in. */
export function storedFlowFromWire(wire: unknown, dialect: HomeyDialect): StoredCanonicalFlow {
  const flow = fromWire(wire, dialect)
  const record = (wire !== null && typeof wire === 'object' ? wire : {}) as Record<string, unknown>

  return {
    ...flow,
    id: typeof record['id'] === 'string' ? record['id'] : '',
    // Null rather than false: `homey-api` deletes `broken` on a V2 hub, so
    // "absent" and "healthy" are different answers and must stay different.
    broken: typeof record['broken'] === 'boolean' ? record['broken'] : null,
    triggerable: typeof record['triggerable'] === 'boolean' ? record['triggerable'] : null,
    triggerCount: typeof record['triggerCount'] === 'number' ? record['triggerCount'] : null,
    order: typeof record['order'] === 'number' ? record['order'] : null,
  }
}

function toCardArray(raw: unknown, role: 'condition' | 'action'): CanonicalCard[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const card = cardFromWire(entry, role)
    return card === null ? [] : [card]
  })
}

/** Drops the firmware-computed fields from an arbitrary payload before it is sent back. */
export function stripReadOnlyFlowFields(raw: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...raw }
  for (const field of READ_ONLY_FLOW_FIELDS) delete copy[field]
  return copy
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface FlowDifference {
  /** Dotted path inside the flow, for example `actions[0].args.text`. */
  path: string
  sent: unknown
  stored: unknown
}

/**
 * Compares what was sent against what the hub actually stored.
 *
 * The hub accepts a great deal it then silently mangles or drops: an unknown
 * card id saves fine and renders as "NO CARD", an argument outside a card's
 * declared range can be dropped, and a folder id that no longer exists is
 * quietly reset. A diff after the write is the only way to notice.
 */
export function diffFlows(sent: CanonicalFlow, stored: CanonicalFlow): FlowDifference[] {
  const differences: FlowDifference[] = []

  compareValue('name', sent.name, stored.name, differences)
  if (sent.enabled !== undefined) compareValue('enabled', sent.enabled, stored.enabled ?? null, differences)
  if (sent.folder !== undefined) compareValue('folder', sent.folder ?? null, stored.folder ?? null, differences)

  compareCard('trigger', sent.trigger, stored.trigger, differences)
  compareCardList('conditions', sent.conditions, stored.conditions, differences)
  compareCardList('actions', sent.actions, stored.actions, differences)

  return differences
}

function compareCardList(path: string, sent: CanonicalCard[], stored: CanonicalCard[], differences: FlowDifference[]): void {
  if (sent.length !== stored.length) {
    differences.push({ path: `${path}.length`, sent: sent.length, stored: stored.length })
  }
  const count = Math.max(sent.length, stored.length)
  for (let i = 0; i < count; i++) {
    compareCard(`${path}[${i}]`, sent[i], stored[i], differences)
  }
}

function compareCard(path: string, sent: CanonicalCard | undefined, stored: CanonicalCard | undefined, differences: FlowDifference[]): void {
  if (sent === undefined || stored === undefined) {
    if (sent !== stored) differences.push({ path, sent: sent ?? null, stored: stored ?? null })
    return
  }

  compareValue(`${path}.id`, sent.id, stored.id, differences)

  const sentArgs = sent.args ?? {}
  const storedArgs = stored.args ?? {}
  for (const argumentName of new Set([...Object.keys(sentArgs), ...Object.keys(storedArgs)])) {
    compareValue(`${path}.args.${argumentName}`, sentArgs[argumentName] ?? null, storedArgs[argumentName] ?? null, differences)
  }

  if (sent.group !== undefined) compareValue(`${path}.group`, sent.group, stored.group ?? null, differences)
  if (sent.inverted !== undefined) compareValue(`${path}.inverted`, sent.inverted, stored.inverted ?? false, differences)
  if (sent.droptoken !== undefined) compareValue(`${path}.droptoken`, sent.droptoken ?? null, stored.droptoken ?? null, differences)
  if (sent.delay !== undefined && sent.delay !== null) compareValue(`${path}.delay`, sent.delay, stored.delay ?? null, differences)
  if (sent.duration !== undefined && sent.duration !== null) compareValue(`${path}.duration`, sent.duration, stored.duration ?? null, differences)
}

function compareValue(path: string, sent: unknown, stored: unknown, differences: FlowDifference[]): void {
  if (JSON.stringify(sent ?? null) === JSON.stringify(stored ?? null)) return
  differences.push({ path, sent: sent ?? null, stored: stored ?? null })
}

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

/**
 * The web app URL for a flow, so the owner can review what was built.
 *
 * Advanced flows live under a different path than standard ones, and pointing
 * at the wrong one lands on an empty editor.
 */
export function flowDeepLink(id: string, kind: 'standard' | 'advanced'): string {
  return kind === 'advanced' ? `https://my.homey.app/flows/advanced/${id}/` : `https://my.homey.app/flows/${id}/`
}
