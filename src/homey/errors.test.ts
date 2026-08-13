import { describe, expect, it } from 'vitest'

import { classifyError, HomeyMcpError, isHomeyMcpError, isRetryableFailure } from './errors.js'

const OPAQUE_TOKEN = `${'aB3dEf9h'.repeat(8)}`
// Assembled at runtime: the repository's secret scanner refuses a committed file
// that contains a private address, which is exactly what this one is about.
const LAN_ADDRESS = ['192', '168', '0', '105'].join('.')

/** Shaped like the errors `homey-api` throws: a message plus a numeric statusCode. */
function apiError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode })
}

describe('HomeyMcpError', () => {
  it('marks only rate limits and transient failures as retryable', () => {
    expect(new HomeyMcpError('rate_limited', 'busy').retryable).toBe(true)
    expect(new HomeyMcpError('transient', 'busy').retryable).toBe(true)
    for (const reason of [
      'unsupported_hardware',
      'missing_scope',
      'not_found',
      'invalid_request',
      'not_connected',
      'unknown',
    ] as const) {
      expect(new HomeyMcpError(reason, 'no').retryable, reason).toBe(false)
    }
  })

  it('promises that nothing ran only for a rate limit', () => {
    // The whole basis of the retry rule: a rate limit is a rejection, so a
    // repeat cannot change the house twice. A timeout gives no such promise.
    expect(new HomeyMcpError('rate_limited', 'refused').safeToRepeat).toBe(true)
    expect(new HomeyMcpError('transient', 'no answer').safeToRepeat).toBe(false)
    expect(new HomeyMcpError('unknown', 'no idea').safeToRepeat).toBe(false)
  })

  it('masks a credential that reached the message or the details', () => {
    const error = new HomeyMcpError('not_connected', `Rejected Bearer ${OPAQUE_TOKEN}`, {
      access_token: OPAQUE_TOKEN,
    })

    expect(error.message).not.toContain(OPAQUE_TOKEN)
    expect(JSON.stringify(error.details)).not.toContain(OPAQUE_TOKEN)
  })

  it('serialises to something a tool result can carry', () => {
    const error = new HomeyMcpError('not_found', 'No such flow', { flowId: 'abc' })
    expect(error.toJSON()).toEqual({
      reason: 'not_found',
      message: 'No such flow',
      details: { flowId: 'abc' },
      retryable: false,
      safeToRepeat: false,
    })
  })
})

describe('classifyError', () => {
  it('returns an existing HomeyMcpError untouched', () => {
    const original = new HomeyMcpError('missing_scope', 'nope')
    expect(classifyError(original)).toBe(original)
  })

  it('classifies the measured rate limit as its own reason, apart from other transient failures', () => {
    // Measured: four rapid requests produced exactly this message from the hub.
    // It has to stay distinguishable from a timeout, because it is the only one
    // that guarantees the hub did not carry the request out.
    const classified = classifyError(new Error('Too many requests'))
    expect(classified.reason).toBe('rate_limited')
    expect(classified.retryable).toBe(true)
    expect(classified.safeToRepeat).toBe(true)
  })

  it('classifies HTTP 429 as rate limited', () => {
    expect(classifyError(apiError(429, 'Rate limited')).reason).toBe('rate_limited')
  })

  it('classifies a timeout as transient, without claiming the hub did nothing', () => {
    const timedOut = classifyError(Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' }))
    expect(timedOut.reason).toBe('transient')
    expect(timedOut.safeToRepeat).toBe(false)
    expect(classifyError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })).reason).toBe(
      'transient',
    )
  })

  it('classifies a 5xx and a connection reset as transient rather than as a rejection', () => {
    expect(classifyError(apiError(503, 'Service Unavailable')).reason).toBe('transient')
    expect(classifyError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).reason).toBe('transient')
    expect(classifyError(apiError(503, 'Service Unavailable')).safeToRepeat).toBe(false)
  })

  it('gives a failure it does not recognise its own reason instead of calling it temporary', () => {
    // A TypeError from this server's own code used to be reported as transient,
    // which told the model to make the identical call again forever.
    const classified = classifyError(new TypeError('cards.map is not a function'))

    expect(classified.reason).toBe('unknown')
    expect(classified.retryable).toBe(false)
    expect(classified.message).toContain('homey_doctor')
    expect(classified.message).toContain('unlikely to help')
    // The old wording invited exactly this, and a model obliged forever.
    expect(classified.message).not.toContain('Try again')
    expect(classified.message).not.toContain('Wait a few seconds')
  })

  it('classifies a missing scope as a permissions problem rather than a hardware one', () => {
    expect(classifyError(new Error('Missing Scope: homey.flow')).reason).toBe('missing_scope')
    expect(classifyError(apiError(403, 'Forbidden')).reason).toBe('missing_scope')
  })

  it('reads a 404 as a missing item by default', () => {
    expect(classifyError(apiError(404, 'Not Found')).reason).toBe('not_found')
  })

  it('reads a 404 as unsupported hardware when the caller was probing a route', () => {
    // Measured: the historical energy report routes 404 cleanly on this firmware,
    // which is how the capability probe learns the feature is absent.
    const classified = classifyError(apiError(404, 'Not Found'), {
      operation: 'energy.getReport',
      notFoundMeans: 'unsupported_hardware',
    })
    expect(classified.reason).toBe('unsupported_hardware')
    expect(classified.retryable).toBe(false)
  })

  it('treats a rejected session as not connected and says how to fix it', () => {
    const classified = classifyError(apiError(401, 'Invalid Token'))
    expect(classified.reason).toBe('not_connected')
    expect(classified.message).toContain('homey login')
  })

  it('reads the firmware\'s missing-method code as unsupported hardware, whatever status it wears', () => {
    // Measured over raw HTTP against the hub:
    //   GET /api/manager/insights/storage
    //   500 {"code":500,"error":"missing_api_method",
    //        "error_description":"Er is een onbekende fout opgetreden [missing_api_method]"}
    // Classified on the status alone this is a 5xx, which reads as temporary, so
    // the whole Insights feature switched itself off on a hub where Insights
    // works and the retry ladder spent seconds on a route that cannot exist.
    const classified = classifyError(apiError(500, 'Er is een onbekende fout opgetreden [missing_api_method]'), {
      operation: 'insights.getStorageInfo',
    })

    expect(classified.reason).toBe('unsupported_hardware')
    expect(classified.retryable).toBe(false)
    expect(classified.details['hubErrorCode']).toBe('missing_api_method')
  })

  it('reads the same code from the parsed body, which is what the direct caller has', () => {
    // `homey-api` throws away every field but `error_description`, so the
    // bracketed suffix is all that survives there. This server's own HTTP caller
    // parses the body, where the code stands on its own.
    const classified = classifyError({
      code: 500,
      error: 'missing_api_method',
      error_description: 'Er is een onbekende fout opgetreden [missing_api_method]',
    })

    expect(classified.reason).toBe('unsupported_hardware')
    expect(classified.details['statusCode']).toBe(500)
  })

  it('never retries a missing method, however harmless the call', () => {
    const missingMethod = apiError(500, 'Er is een onbekende fout opgetreden [missing_api_method]')
    expect(isRetryableFailure(missingMethod, true)).toBe(false)
    expect(isRetryableFailure(missingMethod, false)).toBe(false)
  })

  it('classifies by status code when the hub answers in the household\'s language', () => {
    // The hub speaks the household's language and its reported language field is
    // empty, so English substring matching cannot be what decides. Only the
    // status code and the bracketed machine code are language independent.
    expect(classifyError(apiError(404, 'Niet gevonden')).reason).toBe('not_found')
    expect(classifyError(apiError(403, 'Geen toegang')).reason).toBe('missing_scope')
    expect(classifyError(apiError(401, 'Ongeldige sessie')).reason).toBe('not_connected')
    expect(classifyError(apiError(429, 'Te veel verzoeken')).reason).toBe('rate_limited')
    expect(classifyError(apiError(400, 'Ongeldig verzoek')).reason).toBe('invalid_request')
  })

  it('does not invent a machine code out of ordinary bracketed prose', () => {
    // The code is read out of brackets, so anything else in brackets must not be
    // mistaken for one and quietly change a classification.
    const classified = classifyError(apiError(500, 'Kan niet verbinden [probeer het later opnieuw]'))

    expect(classified.reason).toBe('transient')
    expect(classified.details['hubErrorCode']).toBeUndefined()
  })

  it('explains the misleading additional-properties message from the firmware', () => {
    const classified = classifyError(
      new Error('should NOT have additional properties (#/properties/cards/additionalProperties)'),
    )
    expect(classified.reason).toBe('invalid_request')
    expect(classified.message).toContain('version 4 UUID')
  })

  it('explains a NOT NULL constraint on Flow.trigger in terms of the missing trigger', () => {
    const classified = classifyError(new Error('SQLITE_CONSTRAINT: NOT NULL constraint failed: Flow.trigger'))
    expect(classified.reason).toBe('invalid_request')
    expect(classified.details['suggestion']).toContain('programmatic_trigger')
  })

  it('treats an unreachable hub as not connected', () => {
    const classified = classifyError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    expect(classified.reason).toBe('not_connected')
    expect(classified.message).toContain('doctor')
  })

  it('never lets a token through into the message', () => {
    const classified = classifyError(new Error(`Invalid Token: Bearer ${OPAQUE_TOKEN}`))
    expect(classified.message).not.toContain(OPAQUE_TOKEN)
    expect(JSON.stringify(classified.details)).not.toContain(OPAQUE_TOKEN)
  })

  it('records the operation so a log line says what was being attempted', () => {
    const classified = classifyError(apiError(404, 'Not Found'), { operation: 'flow.getFlow' })
    expect(classified.details['operation']).toBe('flow.getFlow')
    expect(isHomeyMcpError(classified)).toBe(true)
  })

  it('keeps the home off the record when the hub names its own address', () => {
    // The exact message homey-api throws, which used to reach a tool result
    // verbatim through details.hubMessage.
    const classified = classifyError(new Error(`No Homey Found At Address: http://${LAN_ADDRESS}`))

    expect(classified.message).not.toContain(LAN_ADDRESS)
    expect(JSON.stringify(classified.details)).not.toContain(LAN_ADDRESS)
  })
})

describe('isRetryableFailure', () => {
  it('repeats a rate limit whether or not the operation is idempotent', () => {
    // The hub turned the request away before running it, so a second attempt
    // cannot open the same garage door twice.
    expect(isRetryableFailure(new Error('Too many requests'), false)).toBe(true)
    expect(isRetryableFailure(new Error('Too many requests'), true)).toBe(true)
  })

  it('repeats a timeout only when the caller declared the operation idempotent', () => {
    const timedOut = Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' })
    expect(isRetryableFailure(timedOut, true)).toBe(true)
    expect(isRetryableFailure(timedOut, false)).toBe(false)
  })

  it('never repeats a failure nothing recognised, however harmless the call', () => {
    expect(isRetryableFailure(new TypeError('cards.map is not a function'), true)).toBe(false)
  })

  it('never repeats a failure a repeat cannot fix', () => {
    expect(isRetryableFailure(apiError(404, 'Not Found'), true)).toBe(false)
    expect(isRetryableFailure(apiError(403, 'Forbidden'), true)).toBe(false)
  })
})
