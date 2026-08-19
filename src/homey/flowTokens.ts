// The flow tokens this Homey publishes, with their current values.
//
// A token is any value a flow card can drop into a text argument: a device
// capability, a logic variable, or a tag an app publishes. They live on their
// own manager, `api.flowtoken`, which is why nothing else in this codebase found
// them: `api.flow` has no token methods at all.
//
// Two separate needs are served by one call, and both came out of a real
// session on a real hub:
//
//   1. `homey_flow_validate` promised that "every device and token reference
//      resolves" and did not check a qualified reference at all. A flow naming
//      [[homey:app:com.athom.homeyscript|no_such_tag]] validated clean. That is
//      the worst kind of wrong for a tool an agent trusts, because it reports
//      confidence rather than ignorance.
//   2. A tag written by a script could be set and never read back, so checking
//      what a script had actually produced meant asking the owner to look at
//      their phone.
//
// The id is the addressable one and it is NOT the `ownerId`. A reference written
// [[<ownerUri>|<tokenId>]] resolves to `${ownerUri}:${tokenId}`, which is what
// `id` holds. Measured: ownerUri `homey:app:com.athom.flowchecker`, ownerId
// `token_BROKEN`, id `homey:app:com.athom.flowchecker:token_BROKEN`.
//
// `getFlowTokenValue` appears in the library's type definitions and does NOT
// exist on this manager. It does not need to: every token arrives with its
// `value` already on it.

import { asRecord, asString } from '../util/coerce.js'
import type { HomeyConnection } from './types.js'

export interface FlowTokenSummary {
  /** The addressable id, `${ownerUri}:${ownerId}`. This is what a reference must name. */
  id: string
  /** What publishes it, for example `homey:device:<uuid>` or `homey:app:<appId>`. */
  ownerUri: string | null
  /** The owner's own name for it, the half after the pipe in a reference. */
  ownerId: string | null
  title: string | null
  /** `string`, `number`, `boolean` or `image`. */
  type: string | null
  /** What it holds right now. Undefined when the hub reported none. */
  value: unknown
}

interface FlowTokenManager {
  getFlowTokens(): Promise<unknown>
}

function flowTokensOf(connection: HomeyConnection): FlowTokenManager {
  return (connection.api as { flowtoken: FlowTokenManager }).flowtoken
}

/** Every token on this Homey, values included. One request. */
export async function listFlowTokens(connection: HomeyConnection): Promise<FlowTokenSummary[]> {
  const answer = asRecord(
    await connection.request(() => flowTokensOf(connection).getFlowTokens(), 'flowtoken.getFlowTokens', true),
  )
  if (answer === null) return []

  return Object.entries(answer).map(([key, raw]) => {
    const record = asRecord(raw) ?? {}
    return {
      id: asString(record['id']) ?? key,
      ownerUri: asString(record['ownerUri']),
      ownerId: asString(record['ownerId']),
      title: asString(record['title']),
      type: asString(record['type']),
      value: record['value'],
    }
  })
}

/**
 * The ids a `[[owner|token]]` reference can name, for validation.
 *
 * Returns null rather than an empty set when the catalogue could not be read.
 * That distinction is the entire point: an empty set would mark every reference
 * in the flow as broken, which is the same failure as the one being fixed with
 * the sign reversed. Absent means "not checked", and the caller says so.
 */
export async function readFlowTokenIds(connection: HomeyConnection): Promise<Set<string> | null> {
  try {
    return new Set((await listFlowTokens(connection)).map((token) => token.id))
  } catch {
    return null
  }
}
