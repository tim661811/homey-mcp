// Turning a failure into something a model can act on.
//
// A tool that throws produces a JSON-RPC protocol error. The model never sees
// the text of one: the client reports that the tool call failed and the
// conversation stalls. So every failure that originates inside a tool comes back
// as a normal result with `isError: true`, which the model reads and can correct
// itself from.
//
// The three failure classes have to read completely differently, because the
// right next move is completely different:
//
//   unsupported_hardware  Retrying is pointless and so is rephrasing. The model
//                         needs to hear that the hub itself lacks the feature,
//                         and which tool to use instead.
//   missing_scope         The hub can do it, this session is not allowed to. The
//                         model cannot fix that; the human can, in one command.
//   transient             Nothing is wrong. Wait and repeat the same call.
//
// A message that blurs those three sends the model into a retry loop against a
// hub that will never answer differently.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { FailureReason } from '../homey/errors.js'
import { classifyError, HomeyMcpError } from '../homey/errors.js'
import type { Logger } from '../util/log.js'

/** The failure, decomposed into the parts a result is built from. */
export interface FailureDescription {
  reason: FailureReason
  /** One line naming what went wrong, in the user's terms. */
  headline: string
  /** What to do about it. Never empty: a failure with no next step is a dead end. */
  guidance: string
  /**
   * True for `rate_limited` and `transient`, and for nothing else. Every other
   * reason needs a different request rather than the same one again.
   *
   * The two are not interchangeable even so: only a rate limit promises the hub
   * did not carry the request out. `HomeyMcpError.safeToRepeat` is the field
   * that says which of the two this is.
   */
  retryable: boolean
  details: Record<string, unknown>
}

export interface FailureResultOptions {
  /** What was being attempted, in the caller's words, for example `search flow cards`. */
  operation?: string
  /**
   * The tool to use instead when the hardware cannot do this. Only meaningful
   * for `unsupported_hardware`, where the model's whole problem is not knowing
   * what else to try.
   */
  alternativeTool?: string
  /** Extra context merged into the reported details. Redacted by HomeyMcpError. */
  details?: Record<string, unknown>
  logger?: Logger
}

/**
 * Describes any thrown value as a failure. Anything that is not already a
 * HomeyMcpError is classified first, so an unexpected library error still comes
 * out with a reason and a next step rather than as a bare stack trace.
 */
export function describeFailure(error: unknown, options: FailureResultOptions = {}): FailureDescription {
  const classified = classifyError(error, {
    ...(options.operation === undefined ? {} : { operation: options.operation }),
    ...(options.details === undefined ? {} : { details: options.details }),
  })

  const details: Record<string, unknown> = { ...classified.details }
  if (options.details !== undefined) Object.assign(details, options.details)

  return {
    reason: classified.reason,
    headline: classified.message,
    guidance: guidanceFor(classified.reason, options),
    retryable: classified.retryable,
    details,
  }
}

/**
 * Builds the `isError` result for a failed tool call.
 *
 * Output-schema validation is skipped by the SDK for error results, so the
 * structured half is free to use this shape rather than the tool's own.
 */
export function failureResult(error: unknown, options: FailureResultOptions = {}): CallToolResult {
  const failure = describeFailure(error, options)

  options.logger?.warn(`Tool call failed: ${failure.reason}`, {
    ...(options.operation === undefined ? {} : { operation: options.operation }),
    headline: failure.headline,
  })

  const lines = [failure.headline, '', failure.guidance]
  if (options.alternativeTool !== undefined && failure.reason === 'unsupported_hardware') {
    lines.push('', `Use "${options.alternativeTool}" instead.`)
  }
  const suggestion = failure.details['suggestion']
  if (typeof suggestion === 'string' && suggestion !== '') {
    lines.push('', suggestion)
  }

  return {
    isError: true,
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: {
      ok: false,
      error: {
        reason: failure.reason,
        message: failure.headline,
        guidance: failure.guidance,
        retryable: failure.retryable,
        ...(options.operation === undefined ? {} : { operation: options.operation }),
        ...(options.alternativeTool === undefined ? {} : { alternativeTool: options.alternativeTool }),
        details: failure.details,
      },
    },
  }
}

/**
 * A caller-fixable problem: the arguments were wrong, so say what would be right.
 *
 * Separate from `failureResult` only so that a tool rejecting its own input reads
 * as one call rather than as constructing an error to immediately describe.
 */
export function invalidRequestResult(
  message: string,
  details: Record<string, unknown> = {},
  options: FailureResultOptions = {},
): CallToolResult {
  return failureResult(new HomeyMcpError('invalid_request', message, details), {
    operation: 'argument validation',
    ...options,
  })
}

function guidanceFor(reason: FailureReason, options: FailureResultOptions): string {
  const attempt = options.operation === undefined ? 'this' : `"${options.operation}"`

  switch (reason) {
    case 'unsupported_hardware':
      // Deliberately blunt about retrying. The measured hub answers a missing
      // route with a clean 404 forever, and a model that reads "failed" without
      // reading "permanently" will try the same call again with new wording.
      return [
        `This is a hardware limitation of the connected Homey, not a temporary failure and not a mistake in how ${attempt} was called.`,
        'This generation of Homey does not implement the feature at all, so retrying, rewording or waiting will never succeed.',
        'Run "homey_doctor" to see exactly which features this hub reports.',
      ].join(' ')

    case 'missing_scope':
      // Separated from the hardware case on purpose: the hub CAN do this, and
      // the fix is one command by the human rather than a different tool.
      return [
        'This is a permissions problem rather than a hardware limit: the Homey supports this, but the session this server is using was issued without the scope it needs.',
        'Ask the user to run "homey login" again (the Homey CLI session carries the root "homey" scope, which covers flow writes) and then restart this server.',
        'No other tool can work around a missing scope.',
      ].join(' ')

    case 'rate_limited':
      // The one failure that is safe to repeat unconditionally, including for a
      // write: the hub refuses the request without carrying it out, so nothing
      // happened in the house.
      return [
        'This is temporary. The Homey rate limits its own local API and briefly refuses further requests when several arrive together. It rejected this one without carrying it out, so nothing changed.',
        'Wait a few seconds and make the same call again. Nothing needs changing.',
      ].join(' ')

    case 'transient':
      // Deliberately NOT "just try again". A timeout, a 5xx or a reset says the
      // answer went missing, not that the request did: the hub may already have
      // done the thing. Repeating a flow start on a door-opening flow because
      // the reply was slow is how a house gets opened twice.
      return [
        'This looks temporary: the Homey was busy, momentarily off the network, or answered with a server error.',
        'What did NOT come back is the answer, so on anything that changes something, the Homey may already have carried the request out.',
        'Read the current state back first, and only repeat the call if it plainly did not happen.',
      ].join(' ')

    case 'not_connected':
      return [
        'This server cannot reach the Homey at all right now, so no tool will work until that is fixed.',
        'Ask the user to run "npx homey-mcp doctor", which reports which addresses answer and which credential was used.',
        'A session that has expired is the most common cause: sessions last 24 hours, and "homey login" issues a new one.',
      ].join(' ')

    case 'not_found':
      return [
        'The named item does not exist on this Homey.',
        'List or search first and use an id from that result, rather than guessing a name or reusing an id from an earlier conversation.',
      ].join(' ')

    case 'invalid_request':
      return [
        'The arguments were rejected, so the same call will fail again unchanged.',
        'Read the message above for what was wrong, correct that argument, and call again.',
      ].join(' ')

    case 'unknown':
      // Nothing recognised this failure, so there is no honest advice to give
      // beyond "do not assume it goes away". Saying "try again" here with the
      // confidence of the rate-limit case is how a model loops on a call that
      // is permanently broken.
      return [
        'This server does not recognise the failure that came back, so it cannot say whether it is temporary.',
        'Making the same call again is unlikely to help. Run "homey_doctor" for the state of the connection, and report the failure with that output.',
      ].join(' ')

    default:
      return 'Run "homey_doctor" to see the state of the connection to your Homey.'
  }
}
