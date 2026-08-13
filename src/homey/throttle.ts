// The single shared request queue. Every call to the hub goes through it.
//
// Measured on a Homey Pro (Early 2019) on firmware 13.2.4: four rapid
// sequential requests over the LAN were enough for the hub itself to answer
// "Too many requests". No Athom documentation mentions a rate limit, so this is
// not defensive padding around a hypothetical: it is the observed behaviour of
// the target hardware, and a tool that fans out will hit it.
//
// The rules that follow from that measurement:
//   - at most two requests in flight at once
//   - at least 150 ms between two starts
//   - on a rate limit, back off 1 s, 2 s, 4 s, then give up and say so
//
// Retrying anything else is a decision the caller has to make, not the queue.
// A rate limit is a rejection: the hub turned the request away before running
// it, so repeating it cannot change the house twice. A timeout, a 5xx or a
// connection reset only mean no answer arrived, which says nothing about
// whether the hub acted. Retrying those blind turned one `homey_flow_start` on
// a garage door into four openings, so they are repeated only when the caller
// declares the operation idempotent, and the default is that it is not.

import { classifyError, isRetryableFailure } from './errors.js'
import type { RequestQueue } from './types.js'
import type { Logger } from '../util/log.js'

export const DEFAULT_MAX_CONCURRENT = 2
export const DEFAULT_MINIMUM_SPACING_MS = 150
export const DEFAULT_MAX_RETRIES = 3
export const DEFAULT_INITIAL_BACKOFF_MS = 1_000
export const DEFAULT_BACKOFF_FACTOR = 2

export interface RequestQueueOptions {
  maxConcurrent?: number
  minimumSpacingMs?: number
  /** Retries after the first attempt. 3 means up to four attempts in total. */
  maxRetries?: number
  initialBackoffMs?: number
  backoffFactor?: number
  logger?: Logger
  /**
   * Decides whether a failure may be repeated automatically, given whether the
   * caller declared the operation idempotent. Defaults to `isRetryableFailure`.
   */
  isRetryable?: (error: unknown, idempotent: boolean) => boolean
  /** Injected by tests so fake timers drive the waiting. */
  sleep?: (durationMs: number) => Promise<void>
  now?: () => number
}

interface QueuedOperation {
  operation: () => Promise<unknown>
  label: string
  /** The caller's promise that running this twice is the same as running it once. */
  idempotent: boolean
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

/**
 * Builds the queue. One instance per connection: the limit belongs to the hub,
 * so two queues would each think they were within budget while together
 * doubling the load.
 */
export function createRequestQueue(options: RequestQueueOptions = {}): RequestQueue {
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)
  const minimumSpacingMs = Math.max(0, options.minimumSpacingMs ?? DEFAULT_MINIMUM_SPACING_MS)
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES)
  const initialBackoffMs = Math.max(0, options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS)
  const backoffFactor = options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR
  const logger = options.logger
  const isRetryable = options.isRetryable ?? isRetryableFailure
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => Date.now())

  const pending: QueuedOperation[] = []
  let inFlight = 0
  let lastStartedAt = Number.NEGATIVE_INFINITY
  let spacingTimerActive = false

  function pump(): void {
    if (pending.length === 0) return
    if (inFlight >= maxConcurrent) return

    const millisecondsUntilAllowed = lastStartedAt + minimumSpacingMs - now()
    if (millisecondsUntilAllowed > 0) {
      // One timer at a time. A second one would let two operations start in the
      // same millisecond once it fired, which is exactly what the spacing exists
      // to prevent.
      if (spacingTimerActive) return
      spacingTimerActive = true
      void sleep(millisecondsUntilAllowed).then(() => {
        spacingTimerActive = false
        pump()
      })
      return
    }

    const next = pending.shift()
    if (next === undefined) return

    inFlight += 1
    lastStartedAt = now()

    void runWithRetries(next)
      .then(
        (value) => next.resolve(value),
        (error: unknown) => next.reject(error),
      )
      .finally(() => {
        inFlight -= 1
        pump()
      })

    // A second slot may be free right away.
    pump()
  }

  async function runWithRetries(queued: QueuedOperation): Promise<unknown> {
    let attempt = 0

    for (;;) {
      try {
        return await queued.operation()
      } catch (error) {
        const hasAttemptsLeft = attempt < maxRetries
        if (!hasAttemptsLeft || !isRetryable(error, queued.idempotent)) {
          throw classifyError(error, {
            operation: queued.label,
            details: { attempts: attempt + 1 },
          })
        }

        const backoffMs = initialBackoffMs * backoffFactor ** attempt
        attempt += 1
        logger?.warn(`Homey refused ${queued.label}, backing off before retry ${attempt} of ${maxRetries}`, {
          backoffMs,
          error,
        })

        // The slot is deliberately held during the backoff. When the hub says it
        // is receiving too much, freeing capacity for another caller to start a
        // request immediately would make the situation worse, not better.
        await sleep(backoffMs)
      }
    }
  }

  return {
    // `idempotent` defaults to false so that a write added later cannot opt into
    // being retried by forgetting to say anything.
    run<T>(operation: () => Promise<T>, label: string, idempotent = false): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        pending.push({
          operation: operation as () => Promise<unknown>,
          label,
          idempotent,
          resolve: resolve as (value: unknown) => void,
          reject,
        })
        pump()
      })
    },
    get inFlight() {
      return inFlight
    },
    get queued() {
      return pending.length
    },
  }
}

function defaultSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    // Deliberately not unref'd, and that is the whole point of this function.
    //
    // This timer was unref'd once, so that "the queue can never be the reason
    // the process stays alive after the transport has closed". But somebody is
    // awaiting the promise it settles, so between two hub calls the timer was
    // the only handle the process held. Node saw an empty event loop, decided
    // there was no work left and exited mid-request. `serve` and `setup` got
    // away with it because the stdio transport and readline hold stdin open;
    // `doctor` holds nothing, so it printed zero bytes and exited 0.
    //
    // The wait here is bounded by construction (one spacing gap of
    // `minimumSpacingMs`, or a backoff ladder capped by `maxRetries`) and only
    // exists while an awaited operation is outstanding, so it cannot keep a
    // finished process alive. Shutting down early is a shutdown-path decision:
    // cancel or reject the pending work there, never detach a timer a caller is
    // waiting on.
    setTimeout(resolve, durationMs)
  })
}
