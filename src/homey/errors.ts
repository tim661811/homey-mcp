// The failure taxonomy every tool result is built on.
//
// Two audiences read these messages: a human staring at a doctor report, and a
// model deciding what to do next. Neither knows what a `HomeyAPIV2` is. So a
// message says what went wrong in terms of the user's home and, where there is
// one, what to do about it. The reason code carries the machine-readable part.

import { redactSecrets, redactString } from '../util/redact.js'

export type FailureReason =
  /** This Homey generation cannot do it. Retrying never helps. */
  | 'unsupported_hardware'
  /** A permissions problem, not a hardware one. */
  | 'missing_scope'
  /** The named device, flow or card does not exist. */
  | 'not_found'
  /** The caller's arguments are wrong. Details carry a suggestion. */
  | 'invalid_request'
  /**
   * The hub refused the request because too many arrived at once.
   *
   * Kept apart from `transient` because it is the one failure where the hub is
   * known to have rejected the request instead of running it: it answers "Too
   * many requests" before the request reaches the manager. Repeating it can
   * therefore never make a second change to the house, which is what makes it
   * safe to retry automatically even for a write.
   */
  | 'rate_limited'
  /**
   * Timed out, was reset, or answered 5xx.
   *
   * The request may or may not have been carried out: a reply that never
   * arrived says nothing about whether the hub acted on it. Safe to repeat only
   * when running the operation twice has the same effect as running it once.
   */
  | 'transient'
  /** No credentials, or the hub cannot be reached at all. */
  | 'not_connected'
  /**
   * Nothing here recognised the failure.
   *
   * Usually a fault in this server rather than in the hub (a TypeError from our
   * own code lands here). Deliberately not folded into `transient`: calling an
   * unknown fault temporary invites a model to repeat a permanently broken call
   * forever.
   */
  | 'unknown'

export interface HomeyMcpErrorOptions {
  /** The original failure, kept for the stack chain. Never rendered to a model. */
  cause?: unknown
}

export class HomeyMcpError extends Error {
  readonly reason: FailureReason
  readonly details: Record<string, unknown>
  /**
   * True when repeating the identical call could still succeed: `rate_limited`
   * and `transient`. Every other reason needs a different request, not the same
   * one again.
   *
   * Note the asymmetry with `safeToRepeat`. A caller that is about to change
   * something in the house needs both to be true before repeating on its own.
   */
  readonly retryable: boolean
  /**
   * True only when the hub is known not to have carried the request out, so a
   * repeat cannot duplicate a write. Only a rate limit gives that guarantee.
   */
  readonly safeToRepeat: boolean

  constructor(
    reason: FailureReason,
    message: string,
    details: Record<string, unknown> = {},
    options: HomeyMcpErrorOptions = {},
  ) {
    // Redacted at construction rather than at render time, so there is no path
    // through which an unmasked token reaches a log line or a tool result.
    super(redactString(message), options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HomeyMcpError'
    this.reason = reason
    this.details = (redactSecrets(details) ?? {}) as Record<string, unknown>
    this.retryable = reason === 'rate_limited' || reason === 'transient'
    this.safeToRepeat = reason === 'rate_limited'
  }

  toJSON(): {
    reason: FailureReason
    message: string
    details: Record<string, unknown>
    retryable: boolean
    safeToRepeat: boolean
  } {
    return {
      reason: this.reason,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
      safeToRepeat: this.safeToRepeat,
    }
  }
}

export function isHomeyMcpError(value: unknown): value is HomeyMcpError {
  return value instanceof HomeyMcpError
}

/**
 * Whether a failed call may be repeated automatically.
 *
 * This is the rule the request queue runs on, and the reason the queue needs to
 * know whether an operation is idempotent at all. Measured on the hub: a rate
 * limit arrives as an outright rejection, so repeating it is always safe, for a
 * write as much as for a read. A timeout, a connection reset or a 5xx says only
 * that no answer came back, which leaves it genuinely unknown whether the hub
 * already opened the garage door. Those may be repeated only when the caller has
 * declared that running the operation twice has the same effect as running it
 * once.
 *
 * Anything else, including a failure nothing recognised, is not repeated at all.
 */
export function isRetryableFailure(error: unknown, idempotent: boolean): boolean {
  const { reason } = classifyError(error)
  if (reason === 'rate_limited') return true
  return reason === 'transient' && idempotent
}

export interface ClassifyErrorOptions {
  /** What was being attempted, for example `flow.getFlows`. Appears in the details. */
  operation?: string
  /**
   * What a 404 means for this call. A missing route on the firmware is
   * `unsupported_hardware`; a missing device or flow is `not_found`. The caller
   * knows which one it asked for, the error does not.
   */
  notFoundMeans?: 'not_found' | 'unsupported_hardware'
  /** Extra context merged into the resulting error's details. */
  details?: Record<string, unknown>
}

/**
 * Turns anything thrown by `homey-api`, `fetch` or our own code into a
 * HomeyMcpError with a reason a caller can act on.
 *
 * Read in three passes, in this order, because only the first two are facts:
 *
 *   1. machine codes: the firmware's own `[code]`, SQLite's constraint token and
 *      the JSON-schema validator's rejection. Emitted by machinery, never
 *      translated, and they routinely arrive under a status code that means
 *      something else entirely.
 *   2. numeric status and Node system codes.
 *   3. English prose, as a last resort.
 *
 * Measured on the hub, and the reason for the order: a call to a method this
 * firmware does not have answers
 * `500 {"error":"missing_api_method","error_description":"Er is een onbekende fout opgetreden [missing_api_method]"}`.
 * The status says "temporary", the prose is Dutch, and only the bracketed code
 * says what actually happened.
 */
export function classifyError(error: unknown, options: ClassifyErrorOptions = {}): HomeyMcpError {
  if (isHomeyMcpError(error)) return error

  const originalMessage = extractMessage(error)
  const statusCode = extractStatusCode(error)
  const systemCode = extractSystemCode(error)
  const hubErrorCode = extractHubErrorCode(error, originalMessage)
  const lowerCaseMessage = originalMessage.toLowerCase()

  const details: Record<string, unknown> = {
    ...options.details,
    ...(options.operation === undefined ? {} : { operation: options.operation }),
    ...(statusCode === null ? {} : { statusCode }),
    ...(systemCode === null ? {} : { systemCode }),
    ...(hubErrorCode === null ? {} : { hubErrorCode }),
    hubMessage: originalMessage,
  }

  const operationSuffix = options.operation === undefined ? '' : ` while running ${options.operation}`

  const missingItem = (): HomeyMcpError => {
    if (options.notFoundMeans === 'unsupported_hardware') {
      return new HomeyMcpError(
        'unsupported_hardware',
        `This Homey does not offer that feature${operationSuffix}. The endpoint itself is not present on this generation of hardware, so retrying will not help.`,
        details,
        { cause: error },
      )
    }
    return new HomeyMcpError(
      'not_found',
      `Homey has no such item${operationSuffix}. Check the name or id, and list the available items first if you are unsure.`,
      details,
      { cause: error },
    )
  }

  // -------------------------------------------------------------------------
  // 1. Machine codes. Language independent, and deliberately ahead of the
  //    status codes because the firmware puts each of these behind a status
  //    that points somewhere else.
  // -------------------------------------------------------------------------

  // Measured: this is how the firmware says "I do not have that method", and it
  // says it with HTTP 500. Classified as a 5xx it looks temporary, which is how
  // the whole Insights surface once switched itself off on a hub where Insights
  // works, and cost seconds of backoff retrying a route that can never exist.
  if (hubErrorCode === 'missing_api_method') {
    return new HomeyMcpError(
      'unsupported_hardware',
      `This Homey does not have that endpoint${operationSuffix}. It reported "missing_api_method", which is how this firmware says the method is absent even though it answers with a server-error status. Retrying will not help; a different route is needed.`,
      details,
      { cause: error },
    )
  }

  // The firmware reports a rejected advanced-flow node key as a schema error
  // about additional properties. Measured: the real cause is always a node key
  // that is not an RFC-4122 version 4 UUID. Emitted by the JSON-schema
  // validator rather than by the hub's own message layer, so it is not
  // translated, and it arrives under a plain 400 that says nothing useful.
  if (lowerCaseMessage.includes('should not have additional properties')) {
    return new HomeyMcpError(
      'invalid_request',
      `Homey rejected the flow layout${operationSuffix}. Its message names "additional properties", but on this firmware that is how it reports a node key it will not accept: every card key in an advanced flow must be a version 4 UUID.`,
      { ...details, suggestion: 'Generate every advanced-flow card key with crypto.randomUUID().' },
      { cause: error },
    )
  }

  // `SQLITE_CONSTRAINT` is SQLite's own error token, carried through untouched.
  if (lowerCaseMessage.includes('sqlite_constraint') || lowerCaseMessage.includes('constraint failed')) {
    return new HomeyMcpError(
      'invalid_request',
      `Homey refused to store the flow${operationSuffix} because a required part was missing. A flow must always have a trigger card, even when it is only ever started by another flow.`,
      {
        ...details,
        suggestion: 'Add a trigger. homey:manager:flow / programmatic_trigger never fires on its own and is safe to use.',
      },
      { cause: error },
    )
  }

  // -------------------------------------------------------------------------
  // 2. Numeric status and Node system codes. Also language independent.
  // -------------------------------------------------------------------------

  // Rate limiting is the only failure with its own reason purely because of what
  // it guarantees: the request was turned away, so nothing in the house changed.
  if (statusCode === 429) {
    return new HomeyMcpError(
      'rate_limited',
      `Homey is refusing further requests for the moment because too many arrived at once${operationSuffix}. It turned this request away without carrying it out, so nothing changed. Wait a few seconds and make exactly the same call again.`,
      details,
      { cause: error },
    )
  }

  if (
    statusCode === 408 ||
    systemCode === 'ETIMEDOUT' ||
    systemCode === 'ESOCKETTIMEDOUT' ||
    systemCode === 'ABORT_ERR' ||
    extractErrorName(error) === 'AbortError' ||
    extractErrorName(error) === 'TimeoutError'
  ) {
    return new HomeyMcpError(
      'transient',
      `Homey did not answer in time${operationSuffix}. It may be busy or briefly off the network. A missing answer says nothing about whether Homey carried the request out, so repeat a read freely, but check the current state first before repeating anything that changes the house.`,
      details,
      { cause: error },
    )
  }

  if (statusCode === 401) {
    return new HomeyMcpError(
      'not_connected',
      `Homey rejected the saved session${operationSuffix}. Sessions last 24 hours, so this usually means it expired. Sign in again with "homey login" and restart this server, or set HOMEY_PAT to a Personal Access Token from https://tools.developer.homey.app/me.`,
      details,
      { cause: error },
    )
  }

  if (statusCode === 403) {
    return new HomeyMcpError(
      'missing_scope',
      `The current Homey session is not allowed to do this${operationSuffix}. This is a permissions problem rather than a hardware limit: the session was issued without the scope this action needs. Sign in again with "homey login", which grants the full "homey" scope, and restart this server.`,
      details,
      { cause: error },
    )
  }

  if (statusCode === 404) return missingItem()

  if (statusCode === 400 || statusCode === 422) {
    return new HomeyMcpError(
      'invalid_request',
      `Homey rejected the request as malformed${operationSuffix}. ${originalMessage}`,
      details,
      { cause: error },
    )
  }

  if (
    systemCode === 'ECONNREFUSED' ||
    systemCode === 'ENOTFOUND' ||
    systemCode === 'EHOSTUNREACH' ||
    systemCode === 'ENETUNREACH' ||
    systemCode === 'EAI_AGAIN'
  ) {
    return new HomeyMcpError(
      'not_connected',
      `Homey could not be reached${operationSuffix}. Check that it is powered on and on the same network, then run "homey-mcp doctor" to see which addresses answer.`,
      details,
      { cause: error },
    )
  }

  if (systemCode === 'ECONNRESET' || systemCode === 'EPIPE' || (statusCode !== null && statusCode >= 500)) {
    return new HomeyMcpError(
      'transient',
      `Homey answered with an internal error${operationSuffix}. That is usually temporary. Homey may still have carried the request out before it failed, so check the current state first before repeating anything that changes the house, and run "homey-mcp doctor" if it keeps happening.`,
      details,
      { cause: error },
    )
  }

  // -------------------------------------------------------------------------
  // 3. English prose, last and least.
  //
  // The hub answers in the household's language: the measured message above was
  // Dutch, on a hub whose reported language field is empty. So none of these
  // substrings will fire for most of the world, and none of them may be the only
  // route to a reason that matters. They stay because a message with no status
  // code at all still reaches here, from the library's own transport errors and
  // from anything that throws a bare Error.
  // -------------------------------------------------------------------------

  if (lowerCaseMessage.includes('too many requests') || lowerCaseMessage.includes('rate limit')) {
    return new HomeyMcpError(
      'rate_limited',
      `Homey is refusing further requests for the moment because too many arrived at once${operationSuffix}. It turned this request away without carrying it out, so nothing changed. Wait a few seconds and make exactly the same call again.`,
      details,
      { cause: error },
    )
  }

  if (lowerCaseMessage.includes('timed out') || lowerCaseMessage.includes('timeout')) {
    return new HomeyMcpError(
      'transient',
      `Homey did not answer in time${operationSuffix}. It may be busy or briefly off the network. A missing answer says nothing about whether Homey carried the request out, so repeat a read freely, but check the current state first before repeating anything that changes the house.`,
      details,
      { cause: error },
    )
  }

  if (lowerCaseMessage.includes('invalid token') || lowerCaseMessage.includes('session expired')) {
    return new HomeyMcpError(
      'not_connected',
      `Homey rejected the saved session${operationSuffix}. Sessions last 24 hours, so this usually means it expired. Sign in again with "homey login" and restart this server, or set HOMEY_PAT to a Personal Access Token from https://tools.developer.homey.app/me.`,
      details,
      { cause: error },
    )
  }

  if (lowerCaseMessage.includes('missing scope') || lowerCaseMessage.includes('insufficient scope')) {
    return new HomeyMcpError(
      'missing_scope',
      `The current Homey session is not allowed to do this${operationSuffix}. This is a permissions problem rather than a hardware limit: the session was issued without the scope this action needs. Sign in again with "homey login", which grants the full "homey" scope, and restart this server.`,
      details,
      { cause: error },
    )
  }

  if (lowerCaseMessage.includes('not found')) return missingItem()

  if (lowerCaseMessage.includes('invalid') || lowerCaseMessage.includes('validation')) {
    return new HomeyMcpError(
      'invalid_request',
      `Homey rejected the request as malformed${operationSuffix}. ${originalMessage}`,
      details,
      { cause: error },
    )
  }

  if (
    lowerCaseMessage.includes('no homey found at address') ||
    lowerCaseMessage.includes('homey offline') ||
    lowerCaseMessage.includes('offline')
  ) {
    return new HomeyMcpError(
      'not_connected',
      `Homey could not be reached${operationSuffix}. Check that it is powered on and on the same network, then run "homey-mcp doctor" to see which addresses answer.`,
      details,
      { cause: error },
    )
  }

  // Everything above matched something measured on the hardware. Reaching here
  // means nothing recognised the failure, which most often means the fault is in
  // this server rather than in the hub. Saying "temporary, try again" here with
  // the same confidence as the measured rate limit is how a model ends up
  // repeating a permanently broken call.
  return new HomeyMcpError(
    'unknown',
    `Homey could not complete the request${operationSuffix}, and this server does not recognise the failure that came back: ${originalMessage}. Nothing about it says it is temporary, so making the same call again is unlikely to help. Run "homey_doctor" to check the connection, and please report this along with its output.`,
    details,
    { cause: error },
  )
}

function extractMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error && typeof error.message === 'string' && error.message !== '') return error.message
  if (error !== null && typeof error === 'object') {
    const record = error as Record<string, unknown>
    for (const key of ['message', 'error_description', 'description', 'error']) {
      const candidate = record[key]
      if (typeof candidate === 'string' && candidate !== '') return candidate
    }
  }
  return 'no further detail was reported'
}

/**
 * The firmware's own machine-readable error code, which is the only part of a
 * hub failure that is neither a status code nor written in the household's
 * language.
 *
 * Measured on the hub over raw HTTP, a call to an absent method answers
 * `500 {"code":500,"error":"missing_api_method","error_description":"Er is een onbekende fout opgetreden [missing_api_method]"}`.
 * Two shapes therefore have to be read. Through `homey-api` only the message
 * survives, because its transport throws `new APIError(body.error_description,
 * statusCode)` and drops every other field, so the bracketed suffix is all
 * there is. Through this server's own direct caller the parsed body is at hand
 * and `error` carries the code on its own.
 *
 * Returns the code verbatim. Deciding what a given code means is the caller's
 * job, so an unrecognised one still lands in the reported details instead of
 * silently changing a classification.
 */
function extractHubErrorCode(error: unknown, message: string): string | null {
  if (error !== null && typeof error === 'object') {
    const candidate = (error as Record<string, unknown>)['error']
    if (typeof candidate === 'string' && MACHINE_CODE_PATTERN.test(candidate)) return candidate
  }

  const bracketed = BRACKETED_MACHINE_CODE_PATTERN.exec(message)
  return bracketed?.[1] ?? null
}

/** `snake_case` and nothing else, so a human sentence can never be read as a code. */
const MACHINE_CODE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
const BRACKETED_MACHINE_CODE_PATTERN = /\[([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\]/

function extractErrorName(error: unknown): string | null {
  if (error instanceof Error) return error.name
  if (error !== null && typeof error === 'object') {
    const name = (error as Record<string, unknown>)['name']
    if (typeof name === 'string') return name
  }
  return null
}

function extractStatusCode(error: unknown): number | null {
  if (error === null || typeof error !== 'object') return null
  const record = error as Record<string, unknown>

  for (const key of ['statusCode', 'status', 'code']) {
    const candidate = record[key]
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) {
      return candidate
    }
  }

  const response = record['response']
  if (response !== null && typeof response === 'object') {
    const status = (response as Record<string, unknown>)['status']
    if (typeof status === 'number') return status
  }

  return null
}

function extractSystemCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null
  const record = error as Record<string, unknown>
  const code = record['code']
  if (typeof code === 'string' && code !== '') return code
  const cause = record['cause']
  if (cause !== null && typeof cause === 'object') {
    const causeCode = (cause as Record<string, unknown>)['code']
    if (typeof causeCode === 'string' && causeCode !== '') return causeCode
  }
  return null
}
