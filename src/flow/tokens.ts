// Token references, which come in two dialects that look alike and are not.
//
// A standard flow can only reach values that its own trigger emits, or global
// values published by a device, an app or a manager. Those are written
// `[[<ownerUri>|<tokenId>]]` for a global and `[[<tokenId>]]` for one of the
// trigger's own.
//
// An advanced flow has a graph instead of a single trigger, so a value is
// addressed by the NODE that produced it: `[[trigger::<node-uuid>::<tokenId>]]`,
// `[[action::<node-uuid>::<tokenId>]]`, and `[[card::<node-uuid>::error]]` on an
// error branch.
//
// Mixing the two is the failure that costs the most time to find, because the
// hub stores either form without complaint and the Homey app then renders the
// card as "Unavailable". The same is true of writing a global token with a
// colon instead of a pipe. Both are checked here rather than discovered later.

/** Matches one `[[...]]` reference. Mirrors the regex `homey-api` itself uses in `Flow.isBroken`. */
const TOKEN_REFERENCE_PATTERN = /\[\[(.*?)\]\]/g

// A global token: `<ownerUri>|<tokenId>`. The owner segment is deliberately not
// restricted to the owner types this hub happens to expose, so a token from a
// namespace a future firmware invents is still recognised rather than reported
// as malformed.
const GLOBAL_TOKEN_PATTERN = /^(homey:[a-z][a-z0-9-]*:[^|]+)\|(.+)$/

/** A node-scoped reference, only legal inside an advanced flow. */
const NODE_TOKEN_PATTERN = /^(trigger|action|card)::([^:]+)::(.+)$/

/** The same shape as a global token but written into a card's own `droptoken` field, with no brackets. */
const DROPTOKEN_PATTERN = GLOBAL_TOKEN_PATTERN

export type TokenReferenceKind = 'local' | 'global' | 'node' | 'unrecognised'

export interface TokenReference {
  /** The whole match including the brackets, so an error message can quote it verbatim. */
  raw: string
  /** The text between the brackets. */
  body: string
  kind: TokenReferenceKind
  /** Global only. The publishing owner, for example `homey:device:<uuid>`. */
  ownerUri: string | null
  /** Node only. Which node output kind is being read. */
  nodeKind: 'trigger' | 'action' | 'card' | null
  /** Node only. The key of the node in the advanced flow's `cards` map. */
  nodeKey: string | null
  /** The token's own id, for every kind but `unrecognised`. */
  tokenId: string | null
}

/** Extracts every `[[...]]` reference from one string, in order of appearance. */
export function parseTokenReferences(text: string): TokenReference[] {
  const references: TokenReference[] = []

  for (const match of text.matchAll(TOKEN_REFERENCE_PATTERN)) {
    const raw = match[0]
    const body = match[1] ?? ''
    references.push(classifyTokenBody(raw, body))
  }

  return references
}

function classifyTokenBody(raw: string, body: string): TokenReference {
  const nodeMatch = NODE_TOKEN_PATTERN.exec(body)
  if (nodeMatch !== null) {
    return {
      raw,
      body,
      kind: 'node',
      ownerUri: null,
      nodeKind: nodeMatch[1] as 'trigger' | 'action' | 'card',
      nodeKey: nodeMatch[2] ?? null,
      tokenId: nodeMatch[3] ?? null,
    }
  }

  const globalMatch = GLOBAL_TOKEN_PATTERN.exec(body)
  if (globalMatch !== null) {
    return {
      raw,
      body,
      kind: 'global',
      ownerUri: globalMatch[1] ?? null,
      nodeKind: null,
      nodeKey: null,
      tokenId: globalMatch[2] ?? null,
    }
  }

  // A bare word is a token emitted by this flow's own trigger card. It cannot
  // contain a colon, and refusing one here is what catches the classic mistake:
  // `[[homey:device:<id>:measure_luminance]]` is a global token written with a
  // colon where the pipe belongs, and reading it as a local token would hide
  // that behind a much vaguer "no such token".
  if (body !== '' && !body.includes('|') && !body.includes(':')) {
    return { raw, body, kind: 'local', ownerUri: null, nodeKind: null, nodeKey: null, tokenId: body }
  }

  return { raw, body, kind: 'unrecognised', ownerUri: null, nodeKind: null, nodeKey: null, tokenId: null }
}

/** Walks every string argument of a card and collects the references inside them. */
export function collectTokenReferences(args: Record<string, unknown> | undefined): Array<{ argumentName: string; reference: TokenReference }> {
  if (args === undefined) return []

  const collected: Array<{ argumentName: string; reference: TokenReference }> = []
  for (const [argumentName, value] of Object.entries(args)) {
    if (typeof value !== 'string') continue
    for (const reference of parseTokenReferences(value)) {
      collected.push({ argumentName, reference })
    }
  }
  return collected
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Builds `[[<ownerUri>|<tokenId>]]` for use inside a text argument. */
export function formatGlobalToken(ownerUri: string, tokenId: string): string {
  return `[[${ownerUri}|${tokenId}]]`
}

/** Builds `[[<tokenId>]]`, a value emitted by this standard flow's own trigger. */
export function formatLocalToken(tokenId: string): string {
  return `[[${tokenId}]]`
}

/** Builds `[[trigger::<nodeKey>::<tokenId>]]` and its `action` / `card` siblings. Advanced flows only. */
export function formatNodeToken(nodeKind: 'trigger' | 'action' | 'card', nodeKey: string, tokenId: string): string {
  return `[[${nodeKind}::${nodeKey}::${tokenId}]]`
}

/**
 * Builds the value for a card's `droptoken` field: the same `ownerUri|tokenId`
 * pair as a global token, but without the brackets.
 */
export function formatDroptoken(ownerUri: string, tokenId: string): string {
  return `${ownerUri}|${tokenId}`
}

/** True when a droptoken uses the pipe separator the firmware requires. */
export function isValidDroptoken(value: string): boolean {
  return DROPTOKEN_PATTERN.test(value)
}

/**
 * Explains what is wrong with a droptoken, or null when it is fine.
 *
 * Split out from `isValidDroptoken` because the single most common mistake has
 * a specific, actionable fix and deserves to be named rather than reported as
 * "invalid format".
 */
export function describeDroptokenProblem(value: string): string | null {
  if (isValidDroptoken(value)) return null

  if (!value.includes('|')) {
    return 'a droptoken separates the owner from the capability with a pipe, as in "homey:device:<id>|measure_luminance". Written with a colon it saves without an error and then shows as "Unavailable" in the Homey app.'
  }
  if (!value.startsWith('homey:')) {
    return 'a droptoken starts with the owner uri, as in "homey:device:<id>|measure_luminance".'
  }
  return 'a droptoken looks like "homey:device:<id>|measure_luminance": an owner uri, a pipe, then the token id.'
}
