// What every tool module is handed.
//
// This file is the interface only. The implementation that fills it in belongs
// to the server module, so a tool can be unit tested against a hand-built
// context without a Homey anywhere in sight.

import type { CapabilityRegistry, HomeyConnection } from '../homey/types.js'
import type { HomeCache } from '../homey/cache.js'
import type { Logger } from '../util/log.js'

export interface AskChoice {
  /** Returned verbatim in `AskResult.value` when this choice is picked. */
  value: string
  label: string
  description?: string
}

export interface AskOptions {
  /** One clear question, phrased for someone who is not looking at the code. */
  question: string
  /** Offer choices whenever the set of valid answers is known. Free text is a last resort. */
  choices?: AskChoice[]
  allowFreeText?: boolean
  timeoutMs?: number
}

export interface AskResult {
  /** False when the user declined, the client cannot ask, or the question timed out. */
  answered: boolean
  /** The chosen `AskChoice.value`, or the typed text. Null whenever `answered` is false. */
  value: string | null
  /** True specifically when the user was asked and said no, as opposed to never being asked. */
  declined: boolean
}

/**
 * Asks the user a clarifying question through the MCP client.
 *
 * Not every client supports this, so a tool must handle an unanswered question:
 * check `askSupported` first, and when it is false, return the ambiguity to the
 * model as a normal result listing the candidates instead of guessing one.
 */
export type AskFunction = (options: AskOptions) => Promise<AskResult>

export interface ServerContext {
  readonly connection: HomeyConnection
  readonly cache: HomeCache
  readonly capabilities: CapabilityRegistry
  readonly logger: Logger
  readonly ask: AskFunction
  /** Whether the connected client can actually present a question to the user. */
  readonly askSupported: boolean
}
