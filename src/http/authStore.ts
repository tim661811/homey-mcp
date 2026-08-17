// Where the HTTP mode's OAuth bookkeeping lives.
//
// Its own file, deliberately NOT `credentials.json`, and for the same reason
// `hub-addresses.json` is not: `resolveCredentials` treats any readable
// credentials file as the complete answer and stops looking, so OAuth
// bookkeeping written there would shadow the Homey CLI session and leave the
// next start with nothing to sign in with.
//
// Three things have to survive a restart, and one of them is not obvious. The
// registered client must, because Claude Code stores the `client_id` it was given
// and never registers again (measured: the second login made no /register call at
// all). Access and refresh tokens must, because in-memory tokens would prompt for
// re-authorization on every service restart, which for a supervised service is
// often. Authorization codes and pending sign-ins deliberately do not: a restart
// mid-flow costs one click.
//
// Tokens are keyed by SHA-256 of the token rather than stored plainly. That does
// nothing against somebody who can read the file, who already has
// `credentials.json` sitting next to it. It defends against the ordinary
// accidents this project already guards elsewhere: a stack trace, a backup, a
// paste into a chat window. It costs one hash per lookup.

import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'

import { asRecord } from '../util/coerce.js'

export const ACCESS_TOKEN_LIFETIME_SECONDS = 3_600
export const REFRESH_TOKEN_LIFETIME_SECONDS = 30 * 24 * 3_600

/** What a stored token grants, minus the token itself, which is never written down. */
export interface StoredTokenRecord {
  clientId: string
  scopes: string[]
  /** The RFC 8707 audience this token was minted for, as a string. */
  resource: string
  issuedAtSeconds: number
  expiresAtSeconds: number
}

export interface HttpAuthState {
  version: 1
  clients: Record<string, OAuthClientInformationFull>
  accessTokens: Record<string, StoredTokenRecord>
  refreshTokens: Record<string, StoredTokenRecord>
  /**
   * The code the sign-in page asks for when this computer cannot say which
   * account a connection came from. See `peerIdentity.ts` for why it exists and
   * `readApprovalCode` for why it lives in this file rather than in memory.
   */
  approvalCode?: string
}

/**
 * Where the OAuth bookkeeping is kept. Honours XDG_CONFIG_HOME, like the two
 * files beside it.
 *
 * The port is in the NAME, and that is not cosmetic. Every process here loads
 * the whole file at startup and rewrites it wholesale on each mutation, so two
 * servers sharing one file destroy each other's clients and tokens on the next
 * write: the registration a client stored a `client_id` against disappears, and
 * because a client that has a `client_id` never registers again it then answers
 * `invalid_client` forever with nothing prompting it to recover. A second server
 * is not hypothetical either, it is what `portInUseMessage` tells the user to
 * start. One listener owns one file, and two listeners cannot share a port.
 */
export function httpAuthStatePath(options: {
  port: number
  environment?: Record<string, string | undefined>
  homeDirectory?: string
}): string {
  const environment = options.environment ?? process.env
  const homeDirectory = options.homeDirectory ?? homedir()
  const configHome = environment['XDG_CONFIG_HOME']
  const base =
    configHome !== undefined && configHome.trim() !== '' ? configHome.trim() : join(homeDirectory, '.config')
  return join(base, 'homey-mcp', `http-auth-${options.port}.json`)
}

/** A token, hashed the one way this module looks one up. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** 32 bytes of randomness, hex. Used for tokens, authorization codes and pending-sign-in ids alike. */
export function mintOpaqueSecret(): string {
  return randomBytes(32).toString('hex')
}

/**
 * 48 bits of randomness, in three groups a person can read off a terminal and
 * type into a page without losing their place.
 *
 * Short enough to type because it is typed, and safe at that length because it
 * is not guessable at leisure: a wrong code costs one of three attempts and then
 * the whole sign-in is discarded, so an attacker gets three tries per
 * authorization it starts rather than an open door to hammer.
 */
export function mintApprovalCode(): string {
  const hex = randomBytes(6).toString('hex')
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`
}

export interface AuthStore {
  readonly path: string
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>
  putClient(client: OAuthClientInformationFull): Promise<void>
  countClients(): Promise<number>
  putAccessToken(token: string, record: StoredTokenRecord): Promise<void>
  readAccessToken(token: string): Promise<StoredTokenRecord | undefined>
  putRefreshToken(token: string, record: StoredTokenRecord): Promise<void>
  /**
   * Reads and deletes in one step, because a refresh token is single use and
   * rotation is a MUST, but ONLY when it belongs to `clientId`.
   *
   * The ownership check is inside the same step rather than after it for a
   * reason measured on the way in: `/token` authenticates a public client on an
   * unproven `client_id`, so anyone holding a refresh token could present it
   * with the wrong client id, take the expected `invalid_grant`, and leave the
   * token destroyed for its real owner. The owner's next silent refresh then
   * became a browser round trip with nothing saying why. A mismatch now leaves
   * the token exactly where it was, which is what the authorization code path
   * next door already did.
   */
  consumeRefreshToken(token: string, clientId: string): Promise<StoredTokenRecord | undefined>
  countLiveTokens(): Promise<{ accessTokens: number; refreshTokens: number }>
  /**
   * The code the sign-in page asks for on a connection this computer cannot
   * attribute to an account. Minted and persisted on first read.
   *
   * On disk rather than in memory because the owner has to be able to read it
   * from a second process, and the state file is the one place that is already
   * mode 0600 in a mode 0700 directory. That file permission IS the gate: it is
   * the boundary another account on the machine cannot cross, and the reason a
   * code works where the approval click did not.
   */
  readApprovalCode(): Promise<string>
  /** Modification time of the state file, or null when there is none yet. */
  lastWrittenAt(): Promise<Date | null>
}

export interface CreateAuthStoreOptions {
  /** The listener this bookkeeping belongs to. Required unless `path` is given outright. */
  port?: number
  path?: string
  environment?: Record<string, string | undefined>
  homeDirectory?: string
  now?: () => number
}

/**
 * Opens the store, reading the file once and writing it back atomically.
 *
 * Every write goes through one in-process promise chain. Two token exchanges
 * arriving together is not hypothetical on the refresh path, and a read followed
 * by a write with no serialisation loses whichever finished first, which for a
 * rotated refresh token means the client is left holding one this server has
 * forgotten.
 */
export async function createAuthStore(options: CreateAuthStoreOptions = {}): Promise<AuthStore> {
  const path = options.path ?? httpAuthStatePath({ port: requirePort(options.port), ...withoutUndefined(options) })
  const nowSeconds = (): number => Math.floor((options.now?.() ?? Date.now()) / 1_000)

  const state = await readState(path)
  let writeChain: Promise<void> = Promise.resolve()

  /** Runs `change` against the state and persists the result, one at a time. */
  const mutate = async <T>(change: (current: HttpAuthState) => T): Promise<T> => {
    const previous = writeChain
    let settle: () => void = () => {}
    writeChain = new Promise<void>((resolve) => {
      settle = resolve
    })
    await previous.catch(() => undefined)

    try {
      const result = change(state)
      pruneExpired(state, nowSeconds())
      await writeState(path, state)
      return result
    } finally {
      settle()
    }
  }

  const read = <T>(readValue: (current: HttpAuthState) => T): T => {
    // Pruning on read as well as on write, so an expired token is never handed
    // back by a process that has not written anything since it lapsed.
    pruneExpired(state, nowSeconds())
    return readValue(state)
  }

  return {
    path,

    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
      return read((current) => current.clients[clientId])
    },

    async putClient(client: OAuthClientInformationFull): Promise<void> {
      await mutate((current) => {
        current.clients[client.client_id] = client
      })
    },

    async countClients(): Promise<number> {
      return read((current) => Object.keys(current.clients).length)
    },

    async putAccessToken(token: string, record: StoredTokenRecord): Promise<void> {
      await mutate((current) => {
        current.accessTokens[hashToken(token)] = record
      })
    },

    async readAccessToken(token: string): Promise<StoredTokenRecord | undefined> {
      return read((current) => current.accessTokens[hashToken(token)])
    },

    async putRefreshToken(token: string, record: StoredTokenRecord): Promise<void> {
      await mutate((current) => {
        current.refreshTokens[hashToken(token)] = record
      })
    },

    async consumeRefreshToken(token: string, clientId: string): Promise<StoredTokenRecord | undefined> {
      return await mutate((current) => {
        const key = hashToken(token)
        const record = current.refreshTokens[key]
        if (record === undefined || record.clientId !== clientId) return undefined
        delete current.refreshTokens[key]
        return record
      })
    },

    async readApprovalCode(): Promise<string> {
      const existing = read((current) => current.approvalCode)
      if (existing !== undefined) return existing

      return await mutate((current) => {
        // Re-checked inside the write chain, so two sign-ins arriving together
        // cannot mint two codes and leave the printed one wrong.
        current.approvalCode ??= mintApprovalCode()
        return current.approvalCode
      })
    },

    async countLiveTokens(): Promise<{ accessTokens: number; refreshTokens: number }> {
      return read((current) => ({
        accessTokens: Object.keys(current.accessTokens).length,
        refreshTokens: Object.keys(current.refreshTokens).length,
      }))
    },

    async lastWrittenAt(): Promise<Date | null> {
      try {
        return (await stat(path)).mtime
      } catch {
        return null
      }
    },
  }
}

function requirePort(port: number | undefined): number {
  if (port === undefined) {
    throw new Error('createAuthStore needs the port whose bookkeeping this is, or an explicit path.')
  }
  return port
}

function withoutUndefined(
  options: CreateAuthStoreOptions,
): { environment?: Record<string, string | undefined>; homeDirectory?: string } {
  return {
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
  }
}

/**
 * The approval code a running server has already minted, or null when there is
 * none yet.
 *
 * Reads and never writes, which is the whole point of it being separate from
 * `createAuthStore().readApprovalCode()`. `service status` is a second process,
 * and a second process that writes this file clobbers whatever the running
 * server has in memory. Same rule as `doctor --http` registering nothing.
 */
export async function readStoredApprovalCode(statePath: string): Promise<string | null> {
  return (await readState(statePath)).approvalCode ?? null
}

async function readState(statePath: string): Promise<HttpAuthState> {
  let contents: string
  try {
    contents = await readFile(statePath, 'utf8')
  } catch {
    return emptyState()
  }

  try {
    return normaliseState(JSON.parse(contents))
  } catch {
    // A corrupt file is not worth failing a start over: everything in it is
    // re-obtainable by clicking Authenticate once. It is overwritten by the next
    // write rather than deleted here, so nothing is destroyed by a read.
    return emptyState()
  }
}

function emptyState(): HttpAuthState {
  return { version: 1, clients: {}, accessTokens: {}, refreshTokens: {} }
}

function normaliseState(parsed: unknown): HttpAuthState {
  const record = asRecord(parsed)
  if (record === null) return emptyState()

  const approvalCode = record['approvalCode']

  return {
    version: 1,
    clients: asClientTable(record['clients']),
    accessTokens: asTokenTable(record['accessTokens']),
    refreshTokens: asTokenTable(record['refreshTokens']),
    ...(typeof approvalCode === 'string' && approvalCode !== '' ? { approvalCode } : {}),
  }
}

function asClientTable(value: unknown): Record<string, OAuthClientInformationFull> {
  const record = asRecord(value)
  if (record === null) return {}

  const table: Record<string, OAuthClientInformationFull> = {}
  for (const [clientId, entry] of Object.entries(record)) {
    const client = asRecord(entry)
    if (client === null) continue
    if (typeof client['client_id'] !== 'string') continue
    if (!Array.isArray(client['redirect_uris'])) continue
    table[clientId] = client as unknown as OAuthClientInformationFull
  }
  return table
}

function asTokenTable(value: unknown): Record<string, StoredTokenRecord> {
  const record = asRecord(value)
  if (record === null) return {}

  const table: Record<string, StoredTokenRecord> = {}
  for (const [key, entry] of Object.entries(record)) {
    const stored = asRecord(entry)
    if (stored === null) continue
    const clientId = stored['clientId']
    const resource = stored['resource']
    const expiresAtSeconds = stored['expiresAtSeconds']
    const issuedAtSeconds = stored['issuedAtSeconds']
    if (typeof clientId !== 'string' || typeof resource !== 'string') continue
    if (typeof expiresAtSeconds !== 'number' || typeof issuedAtSeconds !== 'number') continue

    table[key] = {
      clientId,
      resource,
      issuedAtSeconds,
      expiresAtSeconds,
      scopes: Array.isArray(stored['scopes'])
        ? stored['scopes'].filter((scope): scope is string => typeof scope === 'string')
        : [],
    }
  }
  return table
}

function pruneExpired(state: HttpAuthState, nowSeconds: number): void {
  for (const table of [state.accessTokens, state.refreshTokens]) {
    for (const [key, record] of Object.entries(table)) {
      if (record.expiresAtSeconds <= nowSeconds) delete table[key]
    }
  }
}

/**
 * Writes the state with owner-only permissions.
 *
 * Temporary file plus rename, so a reader never sees a half-written file, and an
 * explicit chmod afterwards because the mode argument only applies when the file
 * is created: an existing file somehow left world readable is corrected rather
 * than left. Same rule as `writeStoredCredentials`.
 */
async function writeState(path: string, state: HttpAuthState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}
