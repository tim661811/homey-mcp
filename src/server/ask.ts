// The single place this server asks the user anything.
//
// Two audiences make this awkward. A model that guesses "you probably meant the
// living room lamp" and then switches the wrong light off is worse than a model
// that admits it does not know. But asking is only possible when the connected
// client implements MCP elicitation, and several do not. So this module has
// exactly two outcomes and no third:
//
//   - the client can ask, so ask, and use the answer;
//   - the client cannot ask (or the user declined), so hand the question back to
//     the model as structured data and let it ask in the conversation.
//
// What never happens is an answer being invented because only one candidate
// looked plausible. `AskResult.answered` is false in every unhappy path, and a
// caller that ignores it fails a code review.
//
// One hard protocol rule shapes the schema below: form-mode elicitation MUST NOT
// be used for passwords, API keys or access tokens (MCP specification, 2025-11-25).
// Credentials in this server are collected by "homey-mcp setup" on a terminal
// instead, so nothing here ever asks for one.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { AskFunction, AskOptions, AskResult } from './context.js'
import type { Logger } from '../util/log.js'

/**
 * How long to leave a question on screen. Two minutes is long enough for someone
 * to walk back to the machine and short enough that an abandoned dialog does not
 * pin an MCP request open for the rest of the session.
 */
export const DEFAULT_ASK_TIMEOUT_MS = 120_000

/** The elicitation form field carrying the chosen option. */
export const ASK_ANSWER_FIELD = 'answer'

/** The elicitation form field carrying free text, present only when choices do not cover everything. */
export const ASK_FREE_TEXT_FIELD = 'otherAnswer'

/** Nothing was asked, and nothing was assumed. The shape every unhappy path returns. */
const UNANSWERED: AskResult = { answered: false, value: null, declined: false }

export interface CreateAskFunctionOptions {
  server: McpServer
  logger?: Logger
  defaultTimeoutMs?: number
}

/** True when the connected client declared MCP elicitation support during the handshake. */
export function isElicitationSupported(server: McpServer): boolean {
  return server.server.getClientCapabilities()?.elicitation !== undefined
}

/**
 * Builds the `ask` implementation handed to every tool through `ServerContext`.
 *
 * Capability is checked per call rather than once at startup because the
 * capabilities are only known after the client handshake, which happens after
 * the server object is built.
 */
export function createAskFunction(options: CreateAskFunctionOptions): AskFunction {
  const logger = options.logger
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS

  return async (question: AskOptions): Promise<AskResult> => {
    if (!isElicitationSupported(options.server)) {
      logger?.debug('Not asking: the connected client does not support elicitation', {
        question: question.question,
      })
      return UNANSWERED
    }

    try {
      const response = await options.server.server.elicitInput(
        {
          mode: 'form',
          message: question.question,
          requestedSchema: buildRequestedSchema(question),
        },
        { timeout: question.timeoutMs ?? defaultTimeoutMs },
      )

      if (response.action === 'decline') {
        logger?.debug('The user declined to answer', { question: question.question })
        return { answered: false, value: null, declined: true }
      }

      if (response.action !== 'accept') {
        logger?.debug('The question was dismissed without an answer', { question: question.question })
        return UNANSWERED
      }

      const value = readAnswer(response.content)
      if (value === null) {
        // Accepted with an empty form. Treating that as an answer would put an
        // empty string where a device id belongs.
        logger?.debug('The question was accepted but no value was submitted', { question: question.question })
        return UNANSWERED
      }

      return { answered: true, value, declined: false }
    } catch (error) {
      // A client that advertises elicitation but fails the request must not take
      // the tool call down with it. The caller already has to handle "not
      // answered", so this becomes that.
      logger?.warn('Asking the user failed, continuing without an answer', {
        question: question.question,
        error: error instanceof Error ? error.message : String(error),
      })
      return UNANSWERED
    }
  }
}

/** The restricted-JSON-Schema form the MCP elicitation request carries. */
export interface RequestedSchema {
  type: 'object'
  properties: Record<string, PrimitiveFieldSchema>
  required?: string[]
}

export type PrimitiveFieldSchema =
  | { type: 'string'; title?: string; description?: string }
  | { type: 'string'; title?: string; description?: string; oneOf: Array<{ const: string; title: string }> }

/**
 * Turns a question into the elicitation schema.
 *
 * Choices become a single-select with display titles, which is what makes a
 * client render a list instead of a text box. When free text is allowed as well,
 * it gets its own optional field rather than being smuggled in as an extra
 * choice, because a sentinel value would be indistinguishable from a real one.
 */
export function buildRequestedSchema(question: AskOptions): RequestedSchema {
  const choices = question.choices ?? []
  const allowFreeText = question.allowFreeText === true

  if (choices.length === 0) {
    return {
      type: 'object',
      properties: {
        [ASK_ANSWER_FIELD]: { type: 'string', title: 'Answer', description: question.question },
      },
      required: [ASK_ANSWER_FIELD],
    }
  }

  const properties: Record<string, PrimitiveFieldSchema> = {
    [ASK_ANSWER_FIELD]: {
      type: 'string',
      title: 'Answer',
      description: question.question,
      oneOf: choices.map((choice) => ({
        const: choice.value,
        title: choice.description === undefined ? choice.label : `${choice.label} (${choice.description})`,
      })),
    },
  }

  if (!allowFreeText) {
    return { type: 'object', properties, required: [ASK_ANSWER_FIELD] }
  }

  properties[ASK_FREE_TEXT_FIELD] = {
    type: 'string',
    title: 'Something else',
    description: 'Fill this in only if none of the options above is what you meant.',
  }

  // Neither field is required: the user picks one or types the other, and an
  // empty submission is reported as unanswered rather than as an empty answer.
  return { type: 'object', properties }
}

function readAnswer(content: Record<string, unknown> | undefined): string | null {
  if (content === undefined) return null

  const chosen = content[ASK_ANSWER_FIELD]
  if (typeof chosen === 'string' && chosen.trim() !== '') return chosen

  const typed = content[ASK_FREE_TEXT_FIELD]
  if (typeof typed === 'string' && typed.trim() !== '') return typed.trim()

  return null
}

/** Why the question came back to the model instead of to the user. */
export type UnansweredReason = 'client_cannot_ask' | 'declined' | 'dismissed'

export interface PendingQuestion {
  question: string
  choices: Array<{ value: string; label: string; description?: string }>
  allowFreeText: boolean
  reason: UnansweredReason
}

export function describePendingQuestion(question: AskOptions, result: AskResult, canAsk: boolean): PendingQuestion {
  return {
    question: question.question,
    choices: (question.choices ?? []).map((choice) => ({
      value: choice.value,
      label: choice.label,
      ...(choice.description === undefined ? {} : { description: choice.description }),
    })),
    allowFreeText: question.allowFreeText === true,
    reason: result.declined ? 'declined' : canAsk ? 'dismissed' : 'client_cannot_ask',
  }
}

/**
 * The structured fallback: the question, handed back to the model.
 *
 * Marked as an error result so it is never mistaken for the answer the tool was
 * asked for, and so the tool's own output schema does not have to grow a branch
 * for "no result yet". The model's next move is to put the question to the user
 * in the conversation and call the tool again with the chosen value.
 */
export function pendingQuestionResult(
  question: AskOptions,
  result: AskResult,
  options: { canAsk: boolean; toolName?: string } = { canAsk: false },
): CallToolResult {
  const pending = describePendingQuestion(question, result, options.canAsk)

  const lines: string[] = [
    'This needs a decision from the user before it can go ahead, and it was not made for them.',
    '',
    pending.reason === 'declined'
      ? 'The user was asked and chose not to answer.'
      : pending.reason === 'dismissed'
        ? 'The user was asked and dismissed the question without choosing.'
        : 'This client cannot show a question to the user, so ask them directly in the conversation.',
    '',
    `Question: ${pending.question}`,
  ]

  if (pending.choices.length > 0) {
    lines.push('', 'Options:')
    for (const choice of pending.choices) {
      lines.push(
        choice.description === undefined
          ? `  - ${choice.label} (value: ${choice.value})`
          : `  - ${choice.label}: ${choice.description} (value: ${choice.value})`,
      )
    }
  }

  if (pending.allowFreeText) {
    lines.push('', 'An answer outside these options is also acceptable.')
  }

  lines.push(
    '',
    options.toolName === undefined
      ? 'Put this question to the user, then call this tool again with their answer. Do not choose on their behalf.'
      : `Put this question to the user, then call "${options.toolName}" again with their answer. Do not choose on their behalf.`,
  )

  return {
    isError: true,
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: { ok: false, needsUserInput: pending },
  }
}
