import { describe, expect, it } from 'vitest'

import { describeFailure, failureResult } from './errors.js'
import { HomeyMcpError } from '../homey/errors.js'

describe('failureResult', () => {
  it('is an error result rather than a thrown protocol error', () => {
    const result = failureResult(new HomeyMcpError('not_found', 'Homey has no such flow.'))

    expect(result.isError).toBe(true)
    expect((result.structuredContent as { ok: boolean }).ok).toBe(false)
  })

  it('tells the model that a hardware limit will never succeed, and names the alternative', () => {
    const result = failureResult(
      new HomeyMcpError('unsupported_hardware', 'This Homey does not offer historical energy reports.'),
      { operation: 'read the energy report', alternativeTool: 'homey_insights_query' },
    )

    const text = JSON.stringify(result.content)
    expect(text).toContain('hardware limitation')
    expect(text).toContain('never succeed')
    expect(text).toContain('homey_insights_query')
    expect((result.structuredContent as { error: { retryable: boolean } }).error.retryable).toBe(false)
  })

  it('reads as a permissions problem, not a hardware one, when a scope is missing', () => {
    const result = failureResult(new HomeyMcpError('missing_scope', 'Not allowed.'))

    const text = JSON.stringify(result.content)
    expect(text).toContain('permissions problem')
    expect(text).toContain('homey login')
    // The three classes must not blur into each other: a scope problem is not a
    // hardware limit and must not send the model looking for another tool.
    expect(text).not.toContain('hardware limitation')
  })

  it('says a rate limit is temporary and to repeat the same call', () => {
    // The hub rejects a rate-limited request without carrying it out, so this is
    // the one failure a model may repeat unaided, write or not.
    const result = failureResult(new HomeyMcpError('rate_limited', 'Too many requests.'))

    const text = JSON.stringify(result.content)
    expect(text).toContain('temporary')
    expect(text).toContain('same call again')
    expect((result.structuredContent as { error: { retryable: boolean } }).error.retryable).toBe(true)
  })

  it('warns that a transient failure may already have happened, instead of saying to repeat it', () => {
    // A timeout, a 5xx or a reset loses the ANSWER, not necessarily the request.
    // Guidance that says "make the same call again" here is what opened a door
    // four times, so it must not read like the rate-limit case.
    const result = failureResult(new HomeyMcpError('transient', 'The request timed out.'))

    const text = JSON.stringify(result.content)
    expect(text).toContain('may already have carried the request out')
    expect(text).not.toContain('same call again')
    expect((result.structuredContent as { error: { retryable: boolean } }).error.retryable).toBe(true)
  })

  it('does not promise an unrecognised failure will pass, since nothing said it would', () => {
    const result = failureResult(new HomeyMcpError('unknown', 'Something nothing recognised.'))

    const text = JSON.stringify(result.content)
    expect(text).toContain('does not recognise')
    expect(text).toContain('unlikely to help')
    expect((result.structuredContent as { error: { retryable: boolean } }).error.retryable).toBe(false)
  })

  it('carries a suggestion from the error details into the text', () => {
    const result = failureResult(
      new HomeyMcpError('invalid_request', 'Homey refused to store the flow.', {
        suggestion: 'Add a trigger card.',
      }),
    )

    expect(JSON.stringify(result.content)).toContain('Add a trigger card.')
  })
})

describe('describeFailure', () => {
  it('reports exactly two reasons as retryable, which is what the field promises', () => {
    // Pinned because the field's own documentation said "true only for
    // transient" long after rate limiting had been split out into its own
    // reason, so the comment and the code disagreed about a rule that decides
    // whether a model repeats a call.
    for (const reason of ['rate_limited', 'transient'] as const) {
      expect(describeFailure(new HomeyMcpError(reason, 'busy')).retryable, reason).toBe(true)
    }
    for (const reason of [
      'unsupported_hardware',
      'missing_scope',
      'not_found',
      'invalid_request',
      'not_connected',
      'unknown',
    ] as const) {
      expect(describeFailure(new HomeyMcpError(reason, 'no')).retryable, reason).toBe(false)
    }
  })

  it('classifies something that is not already a HomeyMcpError', () => {
    const failure = describeFailure({ statusCode: 429, message: 'Too many requests' })

    // A rate limit has its own reason: it is the only failure the hub is known
    // to have rejected rather than run, which is what makes it safe to repeat.
    expect(failure.reason).toBe('rate_limited')
    expect(failure.retryable).toBe(true)
    expect(failure.guidance).not.toBe('')
  })
})
