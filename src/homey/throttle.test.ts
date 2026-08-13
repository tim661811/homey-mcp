import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRequestQueue } from './throttle.js'
import { HomeyMcpError } from './errors.js'

/**
 * A promise that resolves when the queue has finished handing out work.
 *
 * With fake timers the queue only moves when time is advanced, so every test
 * drives it forward explicitly rather than waiting on wall clock time.
 */
async function advance(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds)
}

/** Lets already-resolved promise callbacks run without moving the clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('createRequestQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the operation result', async () => {
    const queue = createRequestQueue({ minimumSpacingMs: 0 })
    const result = queue.run(async () => 'ok', 'test')
    await settle()
    await expect(result).resolves.toBe('ok')
  })

  it('never runs more than two operations at once', async () => {
    const queue = createRequestQueue({ minimumSpacingMs: 0 })

    let concurrent = 0
    let peakConcurrent = 0
    const release: Array<() => void> = []

    const operations = Array.from({ length: 6 }, (_unused, index) =>
      queue.run(async () => {
        concurrent += 1
        peakConcurrent = Math.max(peakConcurrent, concurrent)
        await new Promise<void>((resolve) => release.push(resolve))
        concurrent -= 1
        return index
      }, `operation-${index}`),
    )

    await settle()
    expect(peakConcurrent).toBe(2)
    expect(queue.inFlight).toBe(2)
    expect(queue.queued).toBe(4)

    // Let everything through, two at a time, and confirm the ceiling holds.
    for (let step = 0; step < 6; step += 1) {
      release.shift()?.()
      await settle()
    }

    await expect(Promise.all(operations)).resolves.toEqual([0, 1, 2, 3, 4, 5])
    expect(peakConcurrent).toBe(2)
  })

  it('leaves at least the minimum spacing between two starts', async () => {
    const startTimes: number[] = []
    const queue = createRequestQueue({ minimumSpacingMs: 150, maxConcurrent: 1 })

    const operations = [0, 1, 2].map((index) =>
      queue.run(async () => {
        startTimes.push(Date.now())
        return index
      }, `operation-${index}`),
    )

    await advance(1_000)
    await Promise.all(operations)

    expect(startTimes).toHaveLength(3)
    expect((startTimes[1] ?? 0) - (startTimes[0] ?? 0)).toBeGreaterThanOrEqual(150)
    expect((startTimes[2] ?? 0) - (startTimes[1] ?? 0)).toBeGreaterThanOrEqual(150)
  })

  it('backs off exponentially from one second and succeeds on a later attempt', async () => {
    const attemptTimes: number[] = []
    const queue = createRequestQueue({ minimumSpacingMs: 0 })

    const operation = queue.run(async () => {
      attemptTimes.push(Date.now())
      if (attemptTimes.length < 3) throw new Error('Too many requests')
      return 'eventually'
    }, 'flow.getFlows')

    await advance(10_000)
    await expect(operation).resolves.toBe('eventually')

    expect(attemptTimes).toHaveLength(3)
    // 1 s after the first failure, then 2 s after the second.
    expect((attemptTimes[1] ?? 0) - (attemptTimes[0] ?? 0)).toBe(1_000)
    expect((attemptTimes[2] ?? 0) - (attemptTimes[1] ?? 0)).toBe(2_000)
  })

  it('gives up after three retries and reports a rate-limited failure', async () => {
    let attempts = 0
    const queue = createRequestQueue({ minimumSpacingMs: 0 })

    const operation = queue.run(async () => {
      attempts += 1
      throw new Error('Too many requests')
    }, 'flow.getFlows')

    const assertion = expect(operation).rejects.toBeInstanceOf(HomeyMcpError)
    await advance(30_000)
    await assertion

    // One first attempt plus three retries.
    expect(attempts).toBe(4)

    const failure = await operation.catch((error: unknown) => error as HomeyMcpError)
    expect(failure.reason).toBe('rate_limited')
    expect(failure.details['operation']).toBe('flow.getFlows')
    expect(failure.details['attempts']).toBe(4)
  })

  it('retries a rate limit even on an operation that is not idempotent', async () => {
    // The measured hub behaviour this queue exists for. A rate limit is a
    // rejection, so repeating a write after one cannot make a second change.
    let attempts = 0
    const queue = createRequestQueue({ minimumSpacingMs: 0 })

    const operation = queue.run(async () => {
      attempts += 1
      if (attempts < 3) throw new Error('Too many requests')
      return 'started'
    }, 'flow.triggerFlow')

    await advance(10_000)
    await expect(operation).resolves.toBe('started')
    expect(attempts).toBe(3)
  })

  it('never repeats a write after a timeout, because the hub may already have carried it out', async () => {
    // homey_flow_start on a flow that opens a garage door: the reply is lost,
    // the queue used to try again three more times, and the door opened four
    // times. The default has to be that a call is not idempotent.
    let attempts = 0
    const queue = createRequestQueue({ minimumSpacingMs: 0 })

    const operation = queue.run(async () => {
      attempts += 1
      throw Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' })
    }, 'flow.triggerFlow')

    const assertion = expect(operation).rejects.toMatchObject({ reason: 'transient' })
    await advance(30_000)
    await assertion

    expect(attempts).toBe(1)
  })

  it('repeats a timeout when the caller declared the operation idempotent', async () => {
    let attempts = 0
    const queue = createRequestQueue({ minimumSpacingMs: 0 })

    const operation = queue.run(
      async () => {
        attempts += 1
        if (attempts < 2) throw Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' })
        return 'read'
      },
      'flow.getFlows',
      true,
    )

    await advance(10_000)
    await expect(operation).resolves.toBe('read')
    expect(attempts).toBe(2)
  })

  it('does not repeat a 5xx on a write, and does repeat it on a read', async () => {
    const queue = createRequestQueue({ minimumSpacingMs: 0 })

    let writeAttempts = 0
    const write = queue.run(async () => {
      writeAttempts += 1
      throw Object.assign(new Error('Internal Server Error'), { statusCode: 500 })
    }, 'flow.createFlow')

    let readAttempts = 0
    const read = queue.run(
      async () => {
        readAttempts += 1
        throw Object.assign(new Error('Internal Server Error'), { statusCode: 500 })
      },
      'flow.getFlows',
      true,
    )

    const assertions = Promise.all([
      expect(write).rejects.toBeInstanceOf(HomeyMcpError),
      expect(read).rejects.toBeInstanceOf(HomeyMcpError),
    ])
    await advance(30_000)
    await assertions

    expect(writeAttempts).toBe(1)
    expect(readAttempts).toBe(4)
  })

  it('does not repeat a failure nothing recognised, even on a read', async () => {
    // A TypeError from this server's own code is not the hub being busy, and
    // retrying it three times only delays the report by seven seconds.
    let attempts = 0
    const queue = createRequestQueue({ minimumSpacingMs: 0 })

    const operation = queue.run(
      async () => {
        attempts += 1
        throw new TypeError('cards.map is not a function')
      },
      'flow.getFlowCardTriggers',
      true,
    )

    const assertion = expect(operation).rejects.toMatchObject({ reason: 'unknown' })
    await advance(30_000)
    await assertion

    expect(attempts).toBe(1)
  })

  it('does not retry a failure that retrying cannot fix', async () => {
    let attempts = 0
    const queue = createRequestQueue({ minimumSpacingMs: 0 })

    const operation = queue.run(async () => {
      attempts += 1
      throw Object.assign(new Error('Not Found'), { statusCode: 404 })
    }, 'flow.getFlow')

    const assertion = expect(operation).rejects.toMatchObject({ reason: 'not_found' })
    await advance(10_000)
    await assertion

    expect(attempts).toBe(1)
  })

  it('holds the event loop open while it waits out the spacing gap', async () => {
    // The defect this pins: the spacing timer used to be unref'd, so between two
    // hub calls the process held no handle at all and Node exited while the
    // awaited work was still pending. `doctor` produced zero bytes of output and
    // exited 0. Fake timers cannot see this, because they replace the very
    // handle whose ref-ness is the bug, so this test runs on real ones.
    vi.useRealTimers()

    const countLiveTimers = (): number =>
      process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length

    const queue = createRequestQueue({ minimumSpacingMs: 120, maxConcurrent: 1 })
    const timersBefore = countLiveTimers()

    const first = queue.run(async () => 'first', 'operation-0')
    const second = queue.run(async () => 'second', 'operation-1')

    await first
    // One macrotask later the queue has installed the spacing timer for the
    // second operation and cannot yet have fired it. `getActiveResourcesInfo`
    // lists only the resources currently keeping the event loop alive, so an
    // unref'd timer is missing from it and a refed one is counted.
    await new Promise<void>((resolve) => setImmediate(resolve))
    const timersDuringGap = countLiveTimers()

    await expect(second).resolves.toBe('second')
    expect(timersDuringGap).toBeGreaterThan(timersBefore)
  })

  it('keeps a failure from blocking the operations behind it', async () => {
    const queue = createRequestQueue({ minimumSpacingMs: 0, maxRetries: 0 })

    const failing = queue.run(async () => {
      throw Object.assign(new Error('Not Found'), { statusCode: 404 })
    }, 'first')
    const succeeding = queue.run(async () => 'second result', 'second')

    const failureAssertion = expect(failing).rejects.toBeInstanceOf(HomeyMcpError)
    await advance(1_000)
    await failureAssertion
    await expect(succeeding).resolves.toBe('second result')
    expect(queue.inFlight).toBe(0)
    expect(queue.queued).toBe(0)
  })
})
