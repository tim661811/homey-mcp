// The address ladder.
//
// A Homey can be reached at up to three addresses and they behave differently
// enough that picking the wrong one is the difference between a 25 ms answer
// and a round trip through Athom's cloud. Measured on the owner's network:
// localSecure 142 ms, local 25 ms, cloud 195 ms.
//
// The probe is `GET /api/manager/system/ping`, which carries no scopes at all
// and answers with `X-Homey-ID` and `X-Homey-Version` headers. That means the
// ladder can be walked before any credential exists, which is what makes a
// useful `doctor` report possible when authentication is the thing that broke.

import { classifyError } from './errors.js'
import type { AddressCandidate, AddressProbeResult, HomeyAddressKind } from './types.js'
import { redactString } from '../util/redact.js'
import type { Logger } from '../util/log.js'

export const PING_PATH = '/api/manager/system/ping'

/** Preference order. Local first for speed, cloud last because it leaves the house. */
export const ADDRESS_LADDER: readonly HomeyAddressKind[] = ['localSecure', 'local', 'cloud']

export const DEFAULT_PROBE_TIMEOUT_MS = 4_000

export interface ProbeAddressesOptions {
  timeoutMs?: number
  logger?: Logger
  /** Injected by tests. Defaults to the global fetch. */
  fetchImplementation?: typeof fetch
  /** Stop as soon as one candidate answers. `doctor` wants every timing, connecting does not. */
  stopAtFirstReachable?: boolean
  /**
   * When set, a candidate that answers with a different `X-Homey-ID` is reported
   * as unreachable. Guards against another Homey on the same LAN answering an
   * address that used to belong to this one.
   */
  expectedHomeyId?: string
  now?: () => number
}

/**
 * Probes candidates in ladder order, one at a time.
 *
 * Sequential on purpose. Two of the three candidates are the same physical hub,
 * and that hub starts refusing requests after a handful arrive together, so
 * probing in parallel would both distort the timings and risk tripping the rate
 * limit before the session has even started.
 */
export async function probeAddresses(
  candidates: AddressCandidate[],
  options: ProbeAddressesOptions = {},
): Promise<AddressProbeResult[]> {
  const ordered = [...candidates].sort(
    (first, second) => ladderPosition(first.kind) - ladderPosition(second.kind),
  )

  const results: AddressProbeResult[] = []
  for (const candidate of ordered) {
    const result = await probeAddress(candidate, options)
    results.push(result)
    if (options.stopAtFirstReachable === true && result.reachable) break
  }

  return results
}

/** Probes a single address. Never throws: an unreachable address is a result, not an error. */
export async function probeAddress(
  candidate: AddressCandidate,
  options: ProbeAddressesOptions = {},
): Promise<AddressProbeResult> {
  const fetchImplementation = options.fetchImplementation ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const now = options.now ?? (() => Date.now())
  const startedAt = now()

  const abortController = new AbortController()
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs)

  try {
    const response = await fetchImplementation(`${trimTrailingSlash(candidate.address)}${PING_PATH}`, {
      method: 'GET',
      signal: abortController.signal,
      // The ping is unauthenticated by design. Sending a credential here would
      // leak it to whatever answered, which during discovery is not yet known
      // to be a Homey.
      headers: { Accept: 'application/json' },
    })

    const homeyId = response.headers.get('x-homey-id')
    const homeyVersion = response.headers.get('x-homey-version')
    const durationMs = now() - startedAt

    if (homeyId === null) {
      return {
        kind: candidate.kind,
        address: candidate.address,
        reachable: false,
        durationMs,
        homeyId: null,
        homeyVersion,
        statusCode: response.status,
        error: 'Something answered at this address but it is not a Homey: the reply carried no X-Homey-ID header.',
      }
    }

    if (options.expectedHomeyId !== undefined && homeyId !== options.expectedHomeyId) {
      return {
        kind: candidate.kind,
        address: candidate.address,
        reachable: false,
        durationMs,
        homeyId,
        homeyVersion,
        statusCode: response.status,
        error: 'A Homey answered at this address, but it is a different one than the configured Homey.',
      }
    }

    options.logger?.debug(`Ping succeeded over ${candidate.kind}`, { durationMs, homeyVersion })

    return {
      kind: candidate.kind,
      address: candidate.address,
      reachable: true,
      durationMs,
      homeyId,
      homeyVersion,
      statusCode: response.status,
      error: null,
    }
  } catch (error) {
    const durationMs = now() - startedAt
    const classified = classifyError(error, { operation: `ping ${candidate.kind}` })
    options.logger?.debug(`Ping failed over ${candidate.kind}`, { durationMs, reason: classified.reason })

    return {
      kind: candidate.kind,
      address: candidate.address,
      reachable: false,
      durationMs,
      homeyId: null,
      homeyVersion: null,
      statusCode: null,
      error: redactString(classified.message),
    }
  } finally {
    clearTimeout(timeoutHandle)
  }
}

export interface AddressCandidateInput {
  /** Plain LAN origin, for example `http://<ip>`. Usually from the Athom cloud's `localUrl`. */
  localAddress?: string | null
  /** TLS LAN origin ending in `homey.homeylocal.com`, from the cloud's `localUrlSecure`. */
  localSecureAddress?: string | null
  /** The Homey's 24 character cloud id, used to build the `connect.athom.com` origin. */
  cloudId?: string | null
}

/**
 * Builds the candidate list from whatever addresses are known.
 *
 * Only addresses that were actually supplied become candidates. Nothing is
 * invented: a missing local address means the LAN rungs are skipped, not that a
 * plausible looking address is guessed at.
 */
export function buildAddressCandidates(input: AddressCandidateInput): AddressCandidate[] {
  const candidates: AddressCandidate[] = []

  if (isUsableAddress(input.localSecureAddress)) {
    candidates.push({ kind: 'localSecure', address: trimTrailingSlash(input.localSecureAddress) })
  }
  if (isUsableAddress(input.localAddress)) {
    candidates.push({ kind: 'local', address: trimTrailingSlash(input.localAddress) })
  }
  if (typeof input.cloudId === 'string' && input.cloudId.trim() !== '') {
    candidates.push({ kind: 'cloud', address: `https://${input.cloudId.trim()}.connect.athom.com` })
  }

  return candidates
}

/** Ladder order first, then measured latency. What `connectToHomey` picks from. */
export function orderProbeResults(results: AddressProbeResult[]): AddressProbeResult[] {
  return [...results].sort((first, second) => {
    if (first.reachable !== second.reachable) return first.reachable ? -1 : 1
    const ladderDifference = ladderPosition(first.kind) - ladderPosition(second.kind)
    if (ladderDifference !== 0) return ladderDifference
    return first.durationMs - second.durationMs
  })
}

/** Reads the address kind back out of a base URL, for identity reporting. */
export function classifyAddress(address: string): HomeyAddressKind {
  if (address.includes('homeylocal.com')) return 'localSecure'
  if (address.includes('connect.athom.com')) return 'cloud'
  return 'local'
}

function ladderPosition(kind: HomeyAddressKind): number {
  const position = ADDRESS_LADDER.indexOf(kind)
  return position === -1 ? ADDRESS_LADDER.length : position
}

function isUsableAddress(address: string | null | undefined): address is string {
  return typeof address === 'string' && address.trim() !== ''
}

function trimTrailingSlash(address: string): string {
  return address.trim().replace(/\/+$/, '')
}
