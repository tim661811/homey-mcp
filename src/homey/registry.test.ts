import { describe, expect, it } from 'vitest'

import { detectCapabilities } from './registry.js'
import type { HomeyConnection, HomeyIdentity } from './types.js'

interface RecordedCall {
  label: string
  idempotent: boolean | undefined
}

const IDENTITY: HomeyIdentity = {
  id: 'homeyidentifier000000001',
  name: 'Home',
  modelId: 'homey4d',
  modelName: 'Homey Pro (Early 2019)',
  softwareVersion: '13.2.4',
  platformVersion: 1,
  language: 'en',
  timezone: 'Europe/Amsterdam',
  address: 'http://homey.test',
  addressKind: 'local',
}

function notFound(): Error & { statusCode: number } {
  return Object.assign(new Error('Not Found'), { statusCode: 404 })
}

function forbidden(): Error & { statusCode: number } {
  return Object.assign(new Error('Forbidden'), { statusCode: 403 })
}

/**
 * What this hub answers when four requests arrive in quick succession. Measured
 * on the hardware, undocumented, and the reason a startup probe can fail on a
 * feature that works perfectly.
 */
function rateLimited(): Error & { statusCode: number } {
  return Object.assign(new Error('Too many requests'), { statusCode: 429 })
}

/**
 * Exactly what the hub answers for a method this firmware does not have.
 * Measured over raw HTTP against the 2019 hardware: HTTP 500, and the only
 * usable part of it is the bracketed code, because the prose is in the
 * household's language.
 */
function missingApiMethod(): Error & { statusCode: number } {
  return Object.assign(new Error('Er is een onbekende fout opgetreden [missing_api_method]'), { statusCode: 500 })
}

/**
 * A connection that records how each probe was queued rather than talking to
 * anything. Each Insights route can be told to fail with a given error, which is
 * what the probe swap and the fallback rules are about.
 */
function fakeConnection(
  options: {
    getLogsFails?: () => Error
    getStorageInfoFails?: () => Error
    /** Advanced Flow has no fallback route, so it is the clean case for a single probe failing. */
    getAdvancedFlowsFails?: () => Error
    /** Raw routes that fail, keyed by path, for the probes with no manager method. */
    rawPathFails?: Record<string, () => Error>
  } = {},
): {
  connection: HomeyConnection
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []

  const api = {
    flow: {
      getAdvancedFlows: async () => {
        if (options.getAdvancedFlowsFails !== undefined) throw options.getAdvancedFlowsFails()
        return []
      },
    },
    energy: { getLiveReport: async () => ({}) },
    moods: { getMoods: async () => [] },
    insights: {
      getStorageInfo: async () => {
        if (options.getStorageInfoFails !== undefined) throw options.getStorageInfoFails()
        return {}
      },
      getLogs: async () => {
        if (options.getLogsFails !== undefined) throw options.getLogsFails()
        return []
      },
    },
    logic: { getVariables: async () => [] },
    call: async ({ path }: { method: string; path: string }) => {
      const fails = options.rawPathFails?.[path]
      if (fails !== undefined) throw fails()
      return {}
    },
  }

  const connection: HomeyConnection = {
    api,
    dialect: 'v2',
    identity: IDENTITY,
    queue: {
      run: async <T>(operation: () => Promise<T>) => operation(),
      inFlight: 0,
      queued: 0,
    },
    request: async <T>(operation: () => Promise<T>, label: string, idempotent?: boolean) => {
      calls.push({ label, idempotent })
      return operation()
    },
  }

  return { connection, calls }
}

describe('detectCapabilities', () => {
  it('declares every probe idempotent, because each one is a read', async () => {
    // Without this the queue treats a probe like a write and refuses to repeat
    // it after a timeout, so one slow answer at startup hides a feature the hub
    // does have for the rest of the process's life.
    const { connection, calls } = fakeConnection()

    await detectCapabilities(connection)

    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.idempotent, call.label).toBe(true)
    }
  })

  it('probes Insights on the route the Insights tools actually call', async () => {
    // The cheap storage-info probe does not exist on the reference hardware, so
    // it could only ever cost a failed request, and its success would not have
    // been evidence that the log routes work anyway.
    const { connection, calls } = fakeConnection()

    const registry = await detectCapabilities(connection)

    expect(registry.hardware.insights).toBe(true)
    expect(calls.map((call) => call.label)).toContain('insights.getLogs')
    expect(calls.map((call) => call.label)).not.toContain('insights.getStorageInfo')
  })

  it('keeps Insights available when the hub reports the probe route as a missing method', async () => {
    // The blocker this test exists for. Measured on the hardware: an absent
    // method answers HTTP 500 with `[missing_api_method]`, which the old guard
    // read as a temporary server error, so the fallback never ran, Insights was
    // reported as absent on a hub where it works, and the retry ladder burned
    // seconds of backoff on a route that can never exist.
    const { connection, calls } = fakeConnection({ getLogsFails: missingApiMethod })

    const registry = await detectCapabilities(connection)

    expect(registry.hardware.insights).toBe(true)
    const fallback = calls.find((call) => call.label.endsWith('(fallback)'))
    expect(fallback?.label).toBe('insights.getLogs (fallback)')
    expect(fallback?.idempotent).toBe(true)
    expect(registry.notes.join('\n')).not.toContain('does not offer sensor history')
  })

  it('runs the fallback for a clean 404 as well', async () => {
    const { connection, calls } = fakeConnection({ getLogsFails: notFound })

    const registry = await detectCapabilities(connection)

    expect(registry.hardware.insights).toBe(true)
    expect(calls.find((call) => call.label.endsWith('(fallback)'))?.idempotent).toBe(true)
  })

  it('lets the fallback rescue a primary route that failed for a passing reason', async () => {
    // The guard was widened from "only a not-found style verdict" to "any
    // failure", and this is the case that widening exists for: a genuine blip on
    // the primary route at exactly the wrong moment used to switch the feature
    // off for the whole process lifetime, because the registry is probed once at
    // startup and never again.
    const { connection, calls } = fakeConnection({
      getLogsFails: () => Object.assign(new Error('Internal Server Error'), { statusCode: 500 }),
    })

    const registry = await detectCapabilities(connection)

    expect(registry.hardware.insights).toBe(true)
    expect(calls.find((call) => call.label.endsWith('(fallback)'))?.label).toBe('insights.getLogs (fallback)')
  })

  it('reports Insights as absent only when both routes are gone', async () => {
    const { connection } = fakeConnection({
      getLogsFails: missingApiMethod,
      getStorageInfoFails: missingApiMethod,
    })

    const registry = await detectCapabilities(connection)

    expect(registry.hardware.insights).toBe(false)
    expect(registry.probes?.['insights']?.status).toBe('unsupported')
    // The note used to quote "not found", which is not what this firmware says.
    expect(registry.notes.join('\n')).not.toContain('not found')
  })

  it('probes weather on the exact route the weather tool calls', async () => {
    const { connection, calls } = fakeConnection()

    const registry = await detectCapabilities(connection)

    expect(registry.probes?.['weather']?.status).toBe('available')
    expect(calls.map((call) => call.label)).toContain('GET /api/manager/weather/weather')
  })

  it('reads a clean 404 on the hourly forecast route as absent hardware rather than a failure', async () => {
    // Measured on the reference hub: this route answers 404 while the weather
    // reading itself carries hourly entries inline, so the note must not claim
    // the hub has no hourly data at all.
    const { connection } = fakeConnection({
      rawPathFails: { '/api/manager/weather/forecast/hourly': notFound },
    })

    const registry = await detectCapabilities(connection)

    expect(registry.probes?.['weatherHourlyForecast']?.status).toBe('unsupported')
    expect(registry.probes?.['weather']?.status).toBe('available')
    expect(registry.notes.join('\n')).toContain('may still carry hourly entries inline')
  })

  it('does not let the fallback paper over a scope refusal on the real route', async () => {
    // The sibling route answering says nothing useful here: the session is the
    // problem, the hardware is fine, and only the human can fix it. Reporting
    // "available" would hide the one command that helps.
    const { connection, calls } = fakeConnection({ getLogsFails: forbidden })

    const registry = await detectCapabilities(connection)

    expect(registry.probes?.['insights']?.status).toBe('forbidden')
    expect(calls.some((call) => call.label.endsWith('(fallback)'))).toBe(false)
    expect(registry.notes.join('\n')).toContain('homey login')
    // Not reported as available either, which is the point of the paragraph
    // above. The status stays `forbidden`, so nothing downstream can read this
    // as a working feature.
    expect(registry.probes?.['insights']?.status).not.toBe('available')
  })

  // A registry with no probe detail cannot tell an absent feature from a probe
  // that never completed, so these four booleans are the last thing standing
  // between a bad moment at startup and a permanent claim about someone's
  // hardware. They gate tool registration and the registry is never rebuilt.
  describe('what the hardware booleans mean when a probe did not answer', () => {
    it('keeps a capability offered when its probe failed rather than answered', async () => {
      // The blocker. This hub rate limits its own local API, undocumented and
      // measured at four rapid requests, so a probe can fail on a feature that
      // works. Collapsing that into the same false as "the endpoint is absent"
      // unregistered the Advanced Flow tools for the life of the process and
      // told the model this hardware cannot author them.
      const { connection } = fakeConnection({ getAdvancedFlowsFails: rateLimited })

      const registry = await detectCapabilities(connection)

      expect(registry.probes?.['advancedFlow']?.status).toBe('failed')
      expect(registry.hardware.advancedFlow).toBe(true)
    })

    it('still switches a capability off when the hub says the endpoint is absent', async () => {
      // The other half of the same distinction. Keeping a failed probe offered
      // is only correct as long as a real hardware verdict still closes the
      // door, otherwise the fix would advertise features no hub has.
      const { connection } = fakeConnection({ getAdvancedFlowsFails: missingApiMethod })

      const registry = await detectCapabilities(connection)

      expect(registry.probes?.['advancedFlow']?.status).toBe('unsupported')
      expect(registry.hardware.advancedFlow).toBe(false)
    })

    it('reads a refused probe as undetermined rather than as absent hardware', async () => {
      // A refused scope is a fact about the session, not about the hub. Hiding
      // the tools hides the one thing the user can act on; leaving them
      // registered means a real call answers with the permissions error that
      // names "homey login".
      const { connection } = fakeConnection({ getAdvancedFlowsFails: forbidden })

      const registry = await detectCapabilities(connection)

      expect(registry.probes?.['advancedFlow']?.status).toBe('forbidden')
      expect(registry.hardware.advancedFlow).toBe(true)
    })

    it('tells the reader a failed probe can be retried by restarting', async () => {
      // The note used to end "Treating it as unavailable", which reads as a
      // settled answer about the hub and names nothing anyone can do.
      const { connection } = fakeConnection({ getAdvancedFlowsFails: rateLimited })

      const registry = await detectCapabilities(connection)

      const notes = registry.notes.join('\n')
      expect(notes).toContain('Could not determine')
      expect(notes).toContain('restart this server')
      expect(notes).not.toContain('Treating it as unavailable')
      expect(notes).not.toContain('does not offer Advanced Flow authoring')
    })
  })
})
