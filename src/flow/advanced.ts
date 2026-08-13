// The advanced-flow graph: a map of nodes keyed by UUID, not a list of steps.
//
// Three measured facts shape this module.
//
// 1. A node key must be an RFC-4122 version 4 UUID. The firmware enforces the
//    version and variant nibbles through a JSON-Schema `propertyNames` pattern,
//    and rejects anything else as "should NOT have additional properties",
//    which points at entirely the wrong thing. `createNodeKey` is the only
//    supported way to mint one.
// 2. Edges live on the SOURCE node as arrays of target keys, except for an
//    `all` join, which additionally repeats each incoming edge in its own
//    `input` array as `<sourceKey>::<port>`. Both halves have to be written.
// 3. Values produced by an upstream node are referenced as
//    `[[trigger::<node-uuid>::<tokenId>]]`, never with the standard flow's
//    `[[ownerUri|tokenId]]` form. Node keys therefore have to be allocated
//    before any argument is filled in, which makes building a graph a two-pass
//    job.

import { randomUUID } from 'node:crypto'
import type { HomeyDialect } from '../homey/types.js'
import { splitCanonicalCardId } from '../homey/types.js'
import { fromWireInterval, toWireInterval } from './model.js'
import type { LayoutNode } from './layout.js'
import { layoutAdvancedFlow } from './layout.js'
import { formatNodeToken, parseTokenReferences } from './tokens.js'

/**
 * Node kinds the firmware understands.
 *
 * `trigger`, `condition` and `action` carry a flow card. `start` is the manual
 * or programmatic entry point. `delay` waits. `any` continues on the first
 * incoming branch, `all` waits for every declared one. `note` is a comment on
 * the canvas.
 */
export const ADVANCED_NODE_TYPES = ['trigger', 'condition', 'action', 'start', 'delay', 'any', 'all', 'note'] as const
export type AdvancedNodeType = (typeof ADVANCED_NODE_TYPES)[number]

/** The three kinds whose `id` is a flow card and therefore gets split on a V2 hub. */
export const CARD_BEARING_NODE_TYPES: readonly AdvancedNodeType[] = ['trigger', 'condition', 'action']

/** Node kinds that begin a branch, and so anchor the left-hand column of the layout. */
export const ENTRY_POINT_NODE_TYPES: readonly AdvancedNodeType[] = ['trigger', 'start']

export const NOTE_COLOURS = ['yellow', 'red', 'green', 'blue', 'purple', 'grey'] as const
export type NoteColour = (typeof NOTE_COLOURS)[number]

/**
 * A version 4 UUID in lowercase.
 *
 * Deliberately narrower than either firmware generation's own pattern (V2
 * accepts versions 0 to 5, V3 accepts 1 to 8). The intersection is what
 * `crypto.randomUUID` produces, so a key built here is accepted by both.
 */
export const NODE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const OUTPUT_PORTS = ['outputSuccess', 'outputTrue', 'outputFalse', 'outputError'] as const
export type OutputPort = (typeof OUTPUT_PORTS)[number]

export interface AdvancedNode {
  /** The key this node occupies in the `cards` map. Must satisfy `NODE_KEY_PATTERN`. */
  key: string
  type: AdvancedNodeType
  /** Canonical flow card id. Required on `trigger`, `condition` and `action`, absent on the rest. */
  cardId?: string
  args?: Record<string, unknown>
  /** Condition only. `true` means "is NOT". */
  inverted?: boolean
  /** A global token dropped onto the card, as `<ownerUri>|<tokenId>`. */
  droptoken?: string | null
  /** Delay only. Whole seconds. Serialised as `args.delay = {number, multiplier}`. */
  delaySeconds?: number | null
  /** Note only. */
  value?: string
  color?: string
  outputSuccess?: string[]
  outputTrue?: string[]
  outputFalse?: string[]
  outputError?: string[]
  /** `all` only. `<sourceKey>::<port>` entries, derivable from the incoming edges. */
  input?: string[]
  x?: number
  y?: number
}

export interface CanonicalAdvancedFlow {
  name: string
  enabled?: boolean
  folder?: string | null
  nodes: AdvancedNode[]
}

export interface StoredCanonicalAdvancedFlow extends CanonicalAdvancedFlow {
  id: string
  broken: boolean | null
  triggerable: boolean | null
}

/**
 * Mints a node key the firmware will accept.
 *
 * `crypto.randomUUID` is not a stylistic choice: a key that is not a version 4
 * UUID is rejected with a JSON-Schema message about additional properties,
 * which sends anyone debugging it looking at the node's fields instead of its
 * key.
 */
export function createNodeKey(): string {
  return randomUUID()
}

export function isValidNodeKey(key: string): boolean {
  return NODE_KEY_PATTERN.test(key)
}

/** Every target key this node points at, across all four output ports. */
export function outgoingTargets(node: AdvancedNode): string[] {
  return OUTPUT_PORTS.flatMap((port) => node[port] ?? [])
}

// ---------------------------------------------------------------------------
// Key allocation
// ---------------------------------------------------------------------------

export interface NodeKeyAssignment {
  nodes: AdvancedNode[]
  /** The key each incoming label was given, so a caller can report the mapping. */
  keyByLabel: Map<string, string>
}

/**
 * Replaces every node label with a UUID the firmware accepts, and rewrites
 * everything that pointed at the old label.
 *
 * Callers describe a graph with readable labels ("motion", "hall-light")
 * because that is what a graph is easy to think about in. The firmware wants
 * version 4 UUIDs and rejects anything else with a message about additional
 * properties. Doing the substitution here means the caller never has to mint a
 * UUID, and it is what makes a node token like
 * `[[trigger::motion::value]]` work: the label inside the token is rewritten
 * along with the edges, in the same pass.
 *
 * A label that is already a valid key is kept, so a graph read back from the
 * hub round-trips unchanged.
 */
export function assignNodeKeys(nodes: AdvancedNode[]): NodeKeyAssignment {
  const keyByLabel = new Map<string, string>()
  for (const node of nodes) {
    if (keyByLabel.has(node.key)) continue
    keyByLabel.set(node.key, isValidNodeKey(node.key) ? node.key : createNodeKey())
  }

  const translate = (label: string): string => keyByLabel.get(label) ?? label

  const rewritten = nodes.map((node) => {
    const next: AdvancedNode = { ...node, key: translate(node.key) }

    for (const port of OUTPUT_PORTS) {
      const targets = node[port]
      if (targets !== undefined) next[port] = targets.map(translate)
    }

    if (node.input !== undefined) {
      next.input = node.input.map((entry) => {
        const [sourceLabel, port] = entry.split('::')
        if (sourceLabel === undefined) return entry
        return port === undefined ? translate(sourceLabel) : `${translate(sourceLabel)}::${port}`
      })
    }

    if (node.args !== undefined) {
      next.args = rewriteNodeTokensInArgs(node.args, keyByLabel)
    }

    return next
  })

  return { nodes: rewritten, keyByLabel }
}

function rewriteNodeTokensInArgs(args: Record<string, unknown>, keyByLabel: ReadonlyMap<string, string>): Record<string, unknown> {
  const rewritten: Record<string, unknown> = {}

  for (const [argumentName, value] of Object.entries(args)) {
    if (typeof value !== 'string') {
      rewritten[argumentName] = value
      continue
    }

    let replaced = value
    for (const reference of parseTokenReferences(value)) {
      if (reference.kind !== 'node' || reference.nodeKey === null || reference.nodeKind === null || reference.tokenId === null) {
        continue
      }
      const key = keyByLabel.get(reference.nodeKey)
      if (key === undefined || key === reference.nodeKey) continue
      replaced = replaced.split(reference.raw).join(formatNodeToken(reference.nodeKind, key, reference.tokenId))
    }
    rewritten[argumentName] = replaced
  }

  return rewritten
}

// ---------------------------------------------------------------------------
// Edge bookkeeping
// ---------------------------------------------------------------------------

/**
 * Fills in the `input` array of every `all` node from the incoming edges.
 *
 * An `all` join is the one place where an edge is written twice: the source
 * node lists the join in its output array, and the join lists
 * `<sourceKey>::<port>` in its own `input`. Deriving the second half from the
 * first keeps them from drifting apart, which is what produces a join that
 * waits forever for a branch nobody feeds it.
 */
export function deriveJoinInputs(nodes: AdvancedNode[]): AdvancedNode[] {
  const incomingByTarget = new Map<string, string[]>()

  for (const node of nodes) {
    for (const port of OUTPUT_PORTS) {
      for (const target of node[port] ?? []) {
        const entries = incomingByTarget.get(target) ?? []
        entries.push(`${node.key}::${port}`)
        incomingByTarget.set(target, entries)
      }
    }
  }

  return nodes.map((node) => {
    if (node.type !== 'all') return node
    return { ...node, input: incomingByTarget.get(node.key) ?? [] }
  })
}

/** Assigns coordinates to every node that has none, leaving hand-placed ones alone. */
export function applyAutoLayout(nodes: AdvancedNode[]): AdvancedNode[] {
  const layoutNodes: LayoutNode[] = nodes.map((node) => ({
    key: node.key,
    targets: outgoingTargets(node),
    isEntryPoint: ENTRY_POINT_NODE_TYPES.includes(node.type),
  }))

  const positions = layoutAdvancedFlow(layoutNodes)

  return nodes.map((node) => {
    if (typeof node.x === 'number' && typeof node.y === 'number') return node
    const position = positions.get(node.key)
    if (position === undefined) return node
    return { ...node, x: position.x, y: position.y }
  })
}

// ---------------------------------------------------------------------------
// Canonical to wire
// ---------------------------------------------------------------------------

/**
 * Serialises one node.
 *
 * `homey-api` splits `id` into `ownerUri` plus a short id on a V2 hub exactly
 * as it does for a standard flow, and only for the three card-bearing types, so
 * `toAdvancedLibraryPayload` hands it the canonical form and lets it do that.
 */
function nodeToWire(node: AdvancedNode, dialect: HomeyDialect): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    type: node.type,
    x: node.x ?? 0,
    y: node.y ?? 0,
  }

  if (CARD_BEARING_NODE_TYPES.includes(node.type) && node.cardId !== undefined) {
    if (dialect === 'v2') {
      const { ownerUri, shortId } = splitCanonicalCardId(node.cardId)
      wire['ownerUri'] = ownerUri
      wire['id'] = shortId
    } else {
      wire['ownerUri'] = splitCanonicalCardId(node.cardId).ownerUri
      wire['id'] = node.cardId
    }
  }

  if (node.type === 'delay') {
    // A delay node carries its wait inside `args`, unlike a standard flow's
    // action which carries `delay` as a sibling of `args`.
    wire['args'] = { delay: toWireInterval(node.delaySeconds) ?? { number: '0', multiplier: 1 } }
  } else if (node.args !== undefined && Object.keys(node.args).length > 0) {
    wire['args'] = node.args
  }

  if (node.inverted === true) wire['inverted'] = true
  if (typeof node.droptoken === 'string' && node.droptoken !== '') wire['droptoken'] = node.droptoken

  if (node.type === 'note') {
    wire['value'] = node.value ?? ''
    wire['color'] = node.color ?? 'yellow'
    // The app sizes a note itself when both are null; a guessed width makes
    // long notes clip.
    wire['width'] = null
    wire['height'] = null
  }

  for (const port of OUTPUT_PORTS) {
    const targets = node[port]
    if (targets !== undefined && targets.length > 0) wire[port] = [...targets]
  }

  if (node.type === 'all' && node.input !== undefined) wire['input'] = [...node.input]

  return wire
}

/** Serialises the graph to the raw `cards` map the REST endpoint accepts. */
export function toAdvancedWire(flow: CanonicalAdvancedFlow, dialect: HomeyDialect): Record<string, unknown> {
  const cards: Record<string, unknown> = {}
  for (const node of flow.nodes) {
    cards[node.key] = nodeToWire(node, dialect)
  }

  const wire: Record<string, unknown> = { name: flow.name, cards }
  if (flow.enabled !== undefined) wire['enabled'] = flow.enabled
  if (flow.folder !== undefined) wire['folder'] = flow.folder
  return wire
}

/** Serialises the graph for `homey-api`'s `createAdvancedFlow` / `updateAdvancedFlow`. Always canonical. */
export function toAdvancedLibraryPayload(flow: CanonicalAdvancedFlow): Record<string, unknown> {
  return toAdvancedWire(flow, 'v3')
}

// ---------------------------------------------------------------------------
// Wire to canonical
// ---------------------------------------------------------------------------

function nodeFromWire(key: string, raw: unknown): AdvancedNode | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>

  const type = typeof record['type'] === 'string' ? (record['type'] as AdvancedNodeType) : 'action'
  const node: AdvancedNode = { key, type }

  const ownerUri = typeof record['ownerUri'] === 'string' ? record['ownerUri'] : null
  const rawId = typeof record['id'] === 'string' ? record['id'] : null
  if (rawId !== null) {
    // As with a standard flow, the payload may arrive already joined by
    // `homey-api` or still split from a raw capture. Recognise it per node.
    node.cardId = ownerUri !== null && !rawId.startsWith(`${ownerUri}:`) ? `${ownerUri}:${rawId}` : rawId
  }

  const rawArgs = record['args']
  const args = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : null

  if (type === 'delay') {
    node.delaySeconds = fromWireInterval(args?.['delay'])
  } else if (args !== null) {
    node.args = args
  }

  if (record['inverted'] === true) node.inverted = true
  if (typeof record['droptoken'] === 'string') node.droptoken = record['droptoken']
  if (typeof record['value'] === 'string') node.value = record['value']
  if (typeof record['color'] === 'string') node.color = record['color']
  if (typeof record['x'] === 'number') node.x = record['x']
  if (typeof record['y'] === 'number') node.y = record['y']

  for (const port of OUTPUT_PORTS) {
    const targets = record[port]
    if (Array.isArray(targets)) {
      node[port] = targets.filter((target): target is string => typeof target === 'string')
    }
  }

  const input = record['input']
  if (Array.isArray(input)) {
    node.input = input.filter((entry): entry is string => typeof entry === 'string')
  }

  return node
}

export function fromAdvancedWire(wire: unknown, dialect: HomeyDialect): CanonicalAdvancedFlow {
  void dialect

  if (wire === null || typeof wire !== 'object') return { name: '', nodes: [] }
  const record = wire as Record<string, unknown>

  const rawCards = record['cards']
  const nodes: AdvancedNode[] = []
  if (rawCards !== null && typeof rawCards === 'object' && !Array.isArray(rawCards)) {
    for (const [key, rawNode] of Object.entries(rawCards as Record<string, unknown>)) {
      const node = nodeFromWire(key, rawNode)
      if (node !== null) nodes.push(node)
    }
  }

  const flow: CanonicalAdvancedFlow = {
    name: typeof record['name'] === 'string' ? record['name'] : '',
    nodes,
  }
  if (typeof record['enabled'] === 'boolean') flow.enabled = record['enabled']
  if ('folder' in record) {
    const folder = record['folder']
    flow.folder = typeof folder === 'string' ? folder : null
  }

  return flow
}

export function storedAdvancedFlowFromWire(wire: unknown, dialect: HomeyDialect): StoredCanonicalAdvancedFlow {
  const flow = fromAdvancedWire(wire, dialect)
  const record = (wire !== null && typeof wire === 'object' ? wire : {}) as Record<string, unknown>

  return {
    ...flow,
    id: typeof record['id'] === 'string' ? record['id'] : '',
    broken: typeof record['broken'] === 'boolean' ? record['broken'] : null,
    triggerable: typeof record['triggerable'] === 'boolean' ? record['triggerable'] : null,
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface AdvancedFlowDifference {
  path: string
  sent: unknown
  stored: unknown
}

/** Compares the graph that was sent against the one the hub stored, node by node. */
export function diffAdvancedFlows(sent: CanonicalAdvancedFlow, stored: CanonicalAdvancedFlow): AdvancedFlowDifference[] {
  const differences: AdvancedFlowDifference[] = []

  if (sent.name !== stored.name) differences.push({ path: 'name', sent: sent.name, stored: stored.name })
  if (sent.enabled !== undefined && sent.enabled !== stored.enabled) {
    differences.push({ path: 'enabled', sent: sent.enabled, stored: stored.enabled ?? null })
  }
  if (sent.folder !== undefined && (sent.folder ?? null) !== (stored.folder ?? null)) {
    differences.push({ path: 'folder', sent: sent.folder ?? null, stored: stored.folder ?? null })
  }

  const storedByKey = new Map(stored.nodes.map((node) => [node.key, node]))

  for (const node of sent.nodes) {
    const counterpart = storedByKey.get(node.key)
    if (counterpart === undefined) {
      differences.push({ path: `cards.${node.key}`, sent: 'present', stored: null })
      continue
    }
    if (node.type !== counterpart.type) {
      differences.push({ path: `cards.${node.key}.type`, sent: node.type, stored: counterpart.type })
    }
    if ((node.cardId ?? null) !== (counterpart.cardId ?? null)) {
      differences.push({ path: `cards.${node.key}.id`, sent: node.cardId ?? null, stored: counterpart.cardId ?? null })
    }
    for (const port of OUTPUT_PORTS) {
      const sentTargets = JSON.stringify(node[port] ?? [])
      const storedTargets = JSON.stringify(counterpart[port] ?? [])
      if (sentTargets !== storedTargets) {
        differences.push({ path: `cards.${node.key}.${port}`, sent: node[port] ?? [], stored: counterpart[port] ?? [] })
      }
    }
    const sentArgs = JSON.stringify(node.args ?? {})
    const storedArgs = JSON.stringify(counterpart.args ?? {})
    if (sentArgs !== storedArgs) {
      differences.push({ path: `cards.${node.key}.args`, sent: node.args ?? {}, stored: counterpart.args ?? {} })
    }
  }

  const sentKeys = new Set(sent.nodes.map((node) => node.key))
  for (const node of stored.nodes) {
    if (!sentKeys.has(node.key)) {
      differences.push({ path: `cards.${node.key}`, sent: null, stored: 'present' })
    }
  }

  return differences
}
