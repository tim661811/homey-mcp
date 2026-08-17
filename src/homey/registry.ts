// What this particular Homey can actually do.
//
// Probe, never infer from a version string. Both hardware generations run
// firmware 13.x, `homeyApi.platformVersion` is a constant baked into the client
// class rather than a fact about the device, and every manager method exists on
// the client whether or not the hub implements it. So `typeof api.flow.createAdvancedFlow === 'function'`
// is always true and tells you nothing. The only honest answer comes from
// sending a read-only request and looking at the reply.
//
// Every probe here is a GET with no side effects. Creating and deleting a
// throwaway object to see whether creation works would write to the audit log,
// fire realtime events at every other connected client, and can trip the user's
// own flows.

import { classifyError, HomeyMcpError, isHomeyMcpError } from './errors.js'
import type {
  CapabilityProbeOutcome,
  CapabilityRegistry,
  CapabilitySupport,
  HomeyConnection,
} from './types.js'
import type { Logger } from '../util/log.js'

export interface DetectCapabilitiesOptions {
  logger?: Logger
  now?: () => Date
}

interface ProbeDefinition {
  name: string
  label: string
  /** What the user loses when this comes back unsupported. Used to write the note. */
  description: string
  run: (connection: HomeyConnection) => Promise<unknown>
  /**
   * A second probe tried whenever the first one fails for any reason other than
   * a rejected session or a refused scope.
   *
   * Deliberately not conditioned on the shape of the primary's failure. The
   * whole point of having one is that a single unusable route must not cost a
   * whole feature, and the previous guard only ran it for a clean 404, which is
   * precisely the case where the primary was already informative.
   */
  fallback?: (connection: HomeyConnection) => Promise<unknown>
}

interface HomeyManagers {
  flow: { getAdvancedFlows(): Promise<unknown> }
  energy: { getLiveReport(): Promise<unknown> }
  moods: { getMoods(): Promise<unknown> }
  insights: { getStorageInfo(): Promise<unknown>; getLogs(): Promise<unknown> }
  logic: { getVariables(): Promise<unknown> }
  call(options: { method: string; path: string }): Promise<unknown>
}

const PROBES: ProbeDefinition[] = [
  {
    name: 'advancedFlow',
    label: 'flow.getAdvancedFlows',
    description: 'Advanced Flow authoring',
    // Advanced Flow is a paid unlock as well as a firmware feature, so the read
    // sibling of the write is the only trustworthy probe. It is parameterless,
    // creates nothing, and answers 404 when the route is not on this firmware.
    run: (connection) => managers(connection).flow.getAdvancedFlows(),
  },
  {
    name: 'energyReports',
    label: 'GET /api/manager/energy/reports/available',
    description: 'historical energy reports',
    // Measured: the historical report routes answer a clean 404 on the 2019
    // generation while the live report works. The library's generated client has
    // no method for them at all, so this goes out as a raw request.
    run: (connection) =>
      managers(connection).call({ method: 'GET', path: '/api/manager/energy/reports/available' }),
  },
  {
    name: 'energyLive',
    label: 'energy.getLiveReport',
    description: 'the live energy report',
    run: (connection) => managers(connection).energy.getLiveReport(),
  },
  {
    name: 'moods',
    label: 'moods.getMoods',
    description: 'moods',
    run: (connection) => managers(connection).moods.getMoods(),
  },
  {
    name: 'insights',
    label: 'insights.getLogs',
    description: 'sensor history',
    // The log catalogue rather than the cheaper storage-info call, which is the
    // reverse of how this probe started out. Two measurements settled it.
    // `insights.getStorageInfo` does not exist on the reference hardware, so the
    // "cheap" probe was a guaranteed failure and seconds of backoff on every
    // start; and `getLogs` is the route both Insights tools actually call, so it
    // is the only one whose success is evidence that those tools will work.
    // Measured cost of being right: 161 logs, around 16 KB, next to the 617 KB
    // card catalogue this server already reads.
    run: (connection) => managers(connection).insights.getLogs(),
    // Kept, in the other direction, for the case the swap does not cover: a hub
    // where the catalogue read fails for a reason other than absence. Storage
    // info answering then still proves the Insights manager is there, which
    // beats switching the feature off on one bad reply.
    fallback: (connection) => managers(connection).insights.getStorageInfo(),
  },
  {
    name: 'logicVariables',
    label: 'logic.getVariables',
    description: 'logic variables',
    run: (connection) => managers(connection).logic.getVariables(),
  },
  {
    name: 'weather',
    label: 'GET /api/manager/weather/weather',
    description: 'the outdoor weather reading',
    // `homey-api` ships no weather manager on either dialect, so this goes out
    // as a raw request like the energy report probe above.
    //
    // Deliberately the exact route `homey_weather` calls, following the same
    // reasoning as the Insights probe: only the route the tool uses proves the
    // tool will work. It costs about 5 KB, most of it the LED ring animation the
    // firmware bundles into the reply, which is small next to the 617 KB card
    // catalogue this server already reads on the way in.
    run: (connection) => managers(connection).call({ method: 'GET', path: '/api/manager/weather/weather' }),
  },
  {
    name: 'weatherHourlyForecast',
    label: 'GET /api/manager/weather/forecast/hourly',
    // Worded carefully, because this is what the unsupported note quotes back.
    // Measured on the reference hub: this route answers a clean 404 while the
    // weather reading above carries five hourly entries inline under
    // `forecastHourly`. So an absent route here does not mean the hub has no
    // hourly data, and a note that said so would be wrong.
    description: 'a separate hourly weather forecast route (its weather reading may still carry hourly entries inline)',
    run: (connection) =>
      managers(connection).call({ method: 'GET', path: '/api/manager/weather/forecast/hourly' }),
  },
]

/**
 * Runs the startup probe. Serialised through the connection's queue like every
 * other call, so it cannot be the thing that trips the rate limit.
 */
export async function detectCapabilities(
  connection: HomeyConnection,
  options: DetectCapabilitiesOptions = {},
): Promise<CapabilityRegistry> {
  const logger = options.logger
  const now = options.now ?? (() => new Date())
  const probes: Record<string, CapabilityProbeOutcome> = {}
  const notes: string[] = []

  for (const probe of PROBES) {
    const outcome = await runProbe(connection, probe)
    probes[probe.name] = outcome

    if (outcome.status === 'unsupported') {
      // Deliberately does not quote "not found": measured on the hardware, this
      // firmware reports an absent method as HTTP 500 with `missing_api_method`,
      // so naming a 404 here would send a reader looking for the wrong thing.
      notes.push(`This Homey does not offer ${probe.description}: ${probe.label} reports that the endpoint is absent.`)
    } else if (outcome.status === 'forbidden') {
      notes.push(
        `${probe.description} was refused for this session rather than missing from the hardware. Sign in again with "homey login" and restart this server: the probe runs once at startup, so a new session only counts from the next start.`,
      )
    } else if (outcome.status === 'failed') {
      // Deliberately does not say "treating it as unavailable", which is what it
      // used to say. The probe runs once at startup and this hub rate limits its
      // own local API, so a probe can fail on a feature that works; reporting
      // that as unavailable turned one bad moment into a permanent claim about
      // the hardware.
      const reason = endSentence(outcome.detail ?? '')
      notes.push(
        `Could not determine whether this Homey offers ${probe.description}: ${reason === '' ? 'the probe failed.' : reason} That is not a verdict about the hardware, and the probe only runs at startup, so restart this server to try again.`,
      )
    }

    logger?.debug(`Capability probe ${probe.name}: ${outcome.status}`, {
      probe: probe.label,
      durationMs: outcome.durationMs,
      statusCode: outcome.statusCode,
    })
  }

  const registry: CapabilityRegistry = {
    hardware: {
      advancedFlow: probedSupport(probes['advancedFlow']),
      energyReports: probedSupport(probes['energyReports']),
      moods: probedSupport(probes['moods']),
      insights: probedSupport(probes['insights']),
    },
    probedAt: now().toISOString(),
    notes,
    probes,
  }

  logger?.info('Capability probe complete', registry.hardware)

  return registry
}

async function runProbe(connection: HomeyConnection, probe: ProbeDefinition): Promise<CapabilityProbeOutcome> {
  const startedAt = Date.now()

  try {
    // Idempotent: every probe is a GET with no side effects, which is the whole
    // point of the probe design above, so the queue may repeat one after a
    // timeout without changing anything on the hub.
    await connection.request(() => probe.run(connection), probe.label, true)
    return { status: 'available', probe: probe.label, statusCode: 200, durationMs: Date.now() - startedAt, detail: null }
  } catch (error) {
    const classified = isHomeyMcpError(error)
      ? error
      : classifyError(error, { operation: probe.label, notFoundMeans: 'unsupported_hardware' })

    // A rejected session is not a fact about the hardware. Stopping here is
    // deliberate: continuing would write a registry full of false negatives and
    // then hide half the tools for the rest of the process's life.
    if (classified.reason === 'not_connected') {
      throw new HomeyMcpError(
        'not_connected',
        `Homey rejected the session while working out what this hub supports (${probe.label}). ${classified.message}`,
        classified.details,
        { cause: error },
      )
    }

    // Checked before the fallback runs, and on purpose. A scope refusal is about
    // this session rather than about the hub, so a cheaper sibling route
    // answering would not mean the tools can do their work; reporting
    // "available" off the back of it would hide the one problem the human can
    // actually fix.
    if (classified.reason === 'missing_scope') {
      return {
        status: 'forbidden',
        probe: probe.label,
        statusCode: statusCodeOf(classified),
        durationMs: Date.now() - startedAt,
        detail: 'the session is not allowed to read this, so support could not be confirmed',
      }
    }

    // Any other failure gets the fallback. The old guard ran it only for a 404,
    // which meant the measured `missing_api_method` reply (an HTTP 500) never
    // reached it and one absent route switched off the whole feature.
    const fallback = probe.fallback
    if (fallback !== undefined) {
      try {
        await connection.request(() => fallback(connection), `${probe.label} (fallback)`, true)
        return {
          status: 'available',
          probe: `${probe.label} (fallback)`,
          statusCode: 200,
          durationMs: Date.now() - startedAt,
          detail: `${probe.label} failed, but the feature answered on its other route`,
        }
      } catch {
        // Both routes are gone, which settles it.
      }
    }

    if (classified.reason === 'not_found' || classified.reason === 'unsupported_hardware') {
      return {
        status: 'unsupported',
        probe: probe.label,
        statusCode: statusCodeOf(classified),
        durationMs: Date.now() - startedAt,
        detail: null,
      }
    }

    return {
      status: 'failed',
      probe: probe.label,
      statusCode: statusCodeOf(classified),
      durationMs: Date.now() - startedAt,
      detail: classified.message,
    }
  }
}

function managers(connection: HomeyConnection): HomeyManagers {
  return connection.api as HomeyManagers
}

/**
 * What one probe outcome says about the hardware.
 *
 * Four probe statuses collapse onto three answers, and the third one has to
 * survive the collapse. `available` and `unsupported` are verdicts about the
 * hub. `forbidden` is a fact about this session, `failed` is a fact about one
 * moment on a hub that rate limits its own local API, and a missing outcome
 * means no probe ran: none of those three establish anything about the
 * hardware, so all three answer `null` rather than picking a side.
 *
 * This used to answer a boolean meaning "not proven absent", which made
 * `hardware.energyReports` come back true on a hub whose report routes answer a
 * clean 404, purely because the probe never got through. The registry is built
 * once and never rebuilt, so that claim then stood for the life of the process.
 * The gating decision that boolean was really carrying now lives in
 * `shouldOfferCapability`, where it reads as the separate question it is.
 */
function probedSupport(outcome: CapabilityProbeOutcome | undefined): CapabilitySupport {
  if (outcome === undefined) return null
  if (outcome.status === 'available') return true
  if (outcome.status === 'unsupported') return false
  return null
}

/**
 * Ends a borrowed sentence exactly once.
 *
 * The detail handed in is the hub's own message and it already ends in a full
 * stop, so composing a longer sentence around it printed "if it keeps
 * happening.. That is not a verdict". The punctuation is dropped here rather
 * than at the source, because the source is an error message that reads
 * correctly on its own and the note is what adds the sentence after it.
 */
function endSentence(detail: string): string {
  const trimmed = detail.replace(/[.\s]+$/u, '')
  return trimmed === '' ? '' : `${trimmed}.`
}

function statusCodeOf(error: HomeyMcpError): number | null {
  const candidate = error.details['statusCode']
  return typeof candidate === 'number' ? candidate : null
}

/**
 * A registry for a server that has no session, so nothing could be probed.
 *
 * Every answer is null rather than false: nothing was established about this
 * hardware, and `shouldOfferCapability` therefore keeps every tool registered.
 * That is deliberate. A client that lists the tools before the user has signed
 * in should show the same surface it will have afterwards, or the list changes
 * under the user the moment they authenticate.
 */
export function unprobedCapabilities(reason: string): CapabilityRegistry {
  return {
    hardware: { advancedFlow: null, energyReports: null, moods: null, insights: null },
    probedAt: new Date().toISOString(),
    notes: [reason],
    probes: {},
  }
}
