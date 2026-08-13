// Credential resolution.
//
// Measured on the target hardware: the only credential that can actually write
// flows is an Athom session carrying the root `homey` scope, and Athom withholds
// that scope from third-party OAuth clients by design. Local API Keys do not
// exist before the 2023 hardware. So the working routes are an Athom Personal
// Access Token, or the session the first-party Homey CLI already stored on this
// machine. Both are read here, never minted.
//
// Two rules that are not negotiable:
//   - The Homey CLI's settings file belongs to the CLI. It is opened read-only.
//     Writing to it would corrupt a tool we do not own.
//   - Anything this server persists itself is written with mode 0600, because a
//     Homey session token is a key to somebody's house.

import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { HomeyMcpError } from './errors.js'
import { asRecord } from '../util/coerce.js'
import type { Logger } from '../util/log.js'

export type CredentialSource = 'config_file' | 'environment_pat' | 'homey_cli_session'

/** An Athom cloud OAuth token, in the exact shape `AthomCloudAPI.Token` expects. */
export interface AthomCloudToken {
  token_type: string
  access_token: string
  refresh_token: string | null
  expires_in: number | null
  grant_type: string | null
}

export interface ResolvedCredentials {
  source: CredentialSource
  /** Where this came from, in words, for `doctor` and for error messages. Contains no secret. */
  sourceDescription: string
  /** OAuth token for the Athom cloud, when one is available. */
  cloudToken: AthomCloudToken | null
  /**
   * ISO timestamp after which `cloudToken` is certainly dead, or absent when the
   * source gives no way to work it out.
   *
   * An upper bound rather than the exact instant, and safe in that direction on
   * purpose. See `cloudTokenExpiryFromFile` for how it is derived and why the
   * error can only ever be optimistic.
   */
  cloudTokenExpiresAt?: string | null
  /** An Athom account Personal Access Token, used as a bearer against the cloud. */
  personalAccessToken: string | null
  /** The Athom cloud id of the Homey to talk to. Null means "ask the cloud for the first one". */
  homeyId: string | null
  /** A session token that authenticates directly against the hub on the LAN, when one is known. */
  localSessionToken: string | null
  localAddress: string | null
  localSecureAddress: string | null
  /** ISO timestamp. Measured: a hub session lasts exactly 24 hours from creation. */
  sessionExpiresAt: string | null
  /** Scopes the session carries. `homey` is the root scope and implies the flow write scopes. */
  scopes: string[]
  /** Path of the file the credentials were read from, when they came from a file. */
  configPath: string | null
}

/** Our own persisted credentials. Same shape as the resolved form, minus the bookkeeping. */
export interface StoredCredentials {
  cloudToken?: AthomCloudToken | null
  cloudTokenExpiresAt?: string | null
  personalAccessToken?: string | null
  homeyId?: string | null
  localSessionToken?: string | null
  localAddress?: string | null
  localSecureAddress?: string | null
  sessionExpiresAt?: string | null
  scopes?: string[]
}

export interface HomeyCliSession {
  path: string
  cloudToken: AthomCloudToken | null
  /** Upper bound on when `cloudToken` dies. Null when the file carries no lifetime. */
  cloudTokenExpiresAt: string | null
  homeyId: string | null
  localSessionToken: string | null
  sessionExpiresAt: string | null
  scopes: string[]
}

export interface ResolveCredentialsOptions {
  /** From `--config`. Takes precedence over everything, and a bad path is an error rather than a fallback. */
  configPath?: string
  environment?: Record<string, string | undefined>
  homeDirectory?: string
  logger?: Logger
}

export const CONFIG_PATH_ENVIRONMENT_VARIABLE = 'HOMEY_MCP_CONFIG'
export const PERSONAL_ACCESS_TOKEN_ENVIRONMENT_VARIABLE = 'HOMEY_PAT'
export const HOMEY_CLI_HOME_ENVIRONMENT_VARIABLE = 'HOMEY_HOME'

/**
 * What to tell a user who has no credentials at all. A stack trace here would be
 * useless: nothing is broken, the server has simply never been set up.
 */
export const NO_CREDENTIALS_HELP = [
  'No Homey credentials were found, so this server cannot reach your Homey yet.',
  '',
  'Pick whichever of these suits you:',
  '  1. Run "npx homey-mcp setup" and follow the prompts.',
  '  2. Install the Homey CLI ("npm install --global homey") and run "homey login".',
  '     This server then reuses that session, read-only.',
  '  3. Create a Personal Access Token at https://tools.developer.homey.app/me',
  '     and start the server with HOMEY_PAT set to it.',
].join('\n')

/**
 * Resolves credentials in a fixed order:
 *
 *   1. the config file, either the one named by `--config` / HOMEY_MCP_CONFIG or,
 *      when neither is given, the one this server writes during setup
 *   2. HOMEY_PAT from the environment
 *   3. the Homey CLI's stored session
 *   4. nothing, which is an instruction rather than a crash
 */
export async function resolveCredentials(options: ResolveCredentialsOptions = {}): Promise<ResolvedCredentials> {
  const environment = options.environment ?? process.env
  const homeDirectory = options.homeDirectory ?? homedir()
  const logger = options.logger

  const explicitConfigPath = options.configPath ?? environment[CONFIG_PATH_ENVIRONMENT_VARIABLE]

  if (explicitConfigPath !== undefined && explicitConfigPath.trim() !== '') {
    const stored = await readStoredCredentials(explicitConfigPath)
    if (stored === null) {
      // The user named this file, so a missing or unreadable one is a mistake to
      // report, not something to quietly fall past.
      throw new HomeyMcpError(
        'not_connected',
        `The credentials file you pointed at could not be read: ${explicitConfigPath}. Check the path, or run "npx homey-mcp setup" to create one.`,
        { configPath: explicitConfigPath },
      )
    }
    return fromStoredCredentials(stored, explicitConfigPath, 'the credentials file you specified')
  }

  const defaultConfigPath = storedCredentialsPath({ environment, homeDirectory })
  const defaultStored = await readStoredCredentials(defaultConfigPath)
  if (defaultStored !== null) {
    logger?.debug('Using credentials written by homey-mcp setup', { configPath: defaultConfigPath })
    return fromStoredCredentials(defaultStored, defaultConfigPath, 'the credentials saved by "homey-mcp setup"')
  }

  const personalAccessToken = environment[PERSONAL_ACCESS_TOKEN_ENVIRONMENT_VARIABLE]
  if (personalAccessToken !== undefined && personalAccessToken.trim() !== '') {
    logger?.debug(`Using the Personal Access Token from ${PERSONAL_ACCESS_TOKEN_ENVIRONMENT_VARIABLE}`)
    return {
      source: 'environment_pat',
      sourceDescription: `the ${PERSONAL_ACCESS_TOKEN_ENVIRONMENT_VARIABLE} environment variable`,
      cloudToken: null,
      personalAccessToken: personalAccessToken.trim(),
      homeyId: null,
      localSessionToken: null,
      localAddress: null,
      localSecureAddress: null,
      sessionExpiresAt: null,
      scopes: [],
      configPath: null,
    }
  }

  const cliSession = await readHomeyCliSession({ environment, homeDirectory, logger })
  if (cliSession !== null) {
    logger?.debug('Using the session stored by the Homey CLI', { path: cliSession.path })
    return {
      source: 'homey_cli_session',
      sourceDescription: `the session stored by the Homey CLI at ${cliSession.path}`,
      cloudToken: cliSession.cloudToken,
      cloudTokenExpiresAt: cliSession.cloudTokenExpiresAt,
      personalAccessToken: null,
      homeyId: cliSession.homeyId,
      localSessionToken: cliSession.localSessionToken,
      localAddress: null,
      localSecureAddress: null,
      sessionExpiresAt: cliSession.sessionExpiresAt,
      scopes: cliSession.scopes,
      configPath: null,
    }
  }

  throw new HomeyMcpError('not_connected', NO_CREDENTIALS_HELP, {
    checked: [defaultConfigPath, ...homeyCliSettingsCandidates({ environment, homeDirectory })],
  })
}

/** Where this server keeps anything it persists itself. Honours XDG_CONFIG_HOME. */
export function storedCredentialsPath(
  options: { environment?: Record<string, string | undefined>; homeDirectory?: string } = {},
): string {
  const environment = options.environment ?? process.env
  const homeDirectory = options.homeDirectory ?? homedir()
  const configHome = environment['XDG_CONFIG_HOME']
  const base =
    configHome !== undefined && configHome.trim() !== '' ? configHome.trim() : join(homeDirectory, '.config')
  return join(base, 'homey-mcp', 'credentials.json')
}

/** Reads our own credentials file. Returns null when it does not exist or is not usable JSON. */
export async function readStoredCredentials(path: string): Promise<StoredCredentials | null> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(contents)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as StoredCredentials
  } catch {
    throw new HomeyMcpError(
      'invalid_request',
      `The credentials file at ${path} is not valid JSON. Delete it and run "npx homey-mcp setup" again.`,
      { configPath: path },
    )
  }
}

/** Writes our own credentials file with owner-only permissions, creating the directory if needed. */
export async function writeStoredCredentials(path: string, credentials: StoredCredentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // The mode argument only applies when the file is created, so an existing file
  // that was somehow left world readable is corrected explicitly afterwards.
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

export interface ReadHomeyCliSessionOptions {
  environment?: Record<string, string | undefined>
  homeDirectory?: string
  logger?: Logger
}

/**
 * Reads the Homey CLI's stored session. Read-only, always.
 *
 * The file's real shape, read from an installed CLI:
 *
 *   {
 *     "homeyApi": {
 *       "token": { "token_type", "access_token", "refresh_token", "expires_in", "grant_type" },
 *       "homey-<athomHomeyId>": { "session": { scopes, createdAt, expiresAt, ... }, "token": "<hub session token>" }
 *     },
 *     "activeHomey": { "id", "name", "platform" }
 *   }
 *
 * The outer `homeyApi.token` authenticates against the Athom cloud. The per-Homey
 * `token` authenticates directly against the hub itself.
 */
export async function readHomeyCliSession(
  options: ReadHomeyCliSessionOptions = {},
): Promise<HomeyCliSession | null> {
  for (const path of homeyCliSettingsCandidates(options)) {
    let contents: string
    try {
      contents = await readFile(path, 'utf8')
    } catch {
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(contents)
    } catch {
      options.logger?.warn(`Ignoring the Homey CLI settings file because it is not valid JSON: ${path}`)
      continue
    }

    const session = extractHomeyCliSession(parsed, path, await lastWrittenAt(path))
    if (session !== null) return session
  }

  return null
}

/** Modification time of the CLI's settings file, or null when it cannot be read. */
async function lastWrittenAt(path: string): Promise<Date | null> {
  try {
    return (await stat(path)).mtime
  } catch {
    return null
  }
}

/**
 * When the CLI's Athom cloud token is certainly dead.
 *
 * The file records `expires_in` (measured: 3660 seconds, so a little over an
 * hour) and no issue time at all, so the lifetime has to be anchored to
 * something. The file's own modification time is the one anchor available, and
 * it cannot be earlier than the moment the token was written into it. The
 * derived instant is therefore never earlier than the true expiry, only ever
 * later: the CLI rewrites this file for other reasons too, and each such write
 * pushes the estimate further out.
 *
 * Erring late is the direction that matters. Too late costs one cloud attempt
 * that fails and is recovered from; too early would skip a cloud route that
 * still works and report a connection problem that does not exist.
 */
function cloudTokenExpiryFromFile(token: AthomCloudToken | null, lastWritten: Date | null): string | null {
  if (token === null || token.expires_in === null || lastWritten === null) return null
  if (!Number.isFinite(token.expires_in) || token.expires_in <= 0) return null
  return new Date(lastWritten.getTime() + token.expires_in * 1_000).toISOString()
}

/** Candidate locations for the CLI's settings file, most specific first. */
export function homeyCliSettingsCandidates(
  options: { environment?: Record<string, string | undefined>; homeDirectory?: string } = {},
): string[] {
  const environment = options.environment ?? process.env
  const homeDirectory = options.homeDirectory ?? homedir()
  const candidates: string[] = []

  const explicitHome = environment[HOMEY_CLI_HOME_ENVIRONMENT_VARIABLE]
  if (explicitHome !== undefined && explicitHome.trim() !== '') {
    candidates.push(join(explicitHome.trim(), 'settings.json'))
  }

  candidates.push(join(homeDirectory, '.athom-cli', 'settings.json'))
  // Newer CLI releases moved the directory. Both are checked because either may
  // be the one holding a live session on a given machine.
  candidates.push(join(homeDirectory, '.homey', 'settings.json'))

  return candidates
}

function extractHomeyCliSession(
  parsed: unknown,
  path: string,
  lastWritten: Date | null,
): HomeyCliSession | null {
  if (parsed === null || typeof parsed !== 'object') return null
  const settings = parsed as Record<string, unknown>

  const homeyApi = asRecord(settings['homeyApi'])
  if (homeyApi === null) return null

  const cloudToken = asAthomCloudToken(homeyApi['token'])
  const cloudTokenExpiresAt = cloudTokenExpiryFromFile(cloudToken, lastWritten)

  const activeHomey = asRecord(settings['activeHomey'])
  const activeHomeyId = typeof activeHomey?.['id'] === 'string' ? (activeHomey['id'] as string) : null

  const homeyEntryKeys = Object.keys(homeyApi).filter((key) => key.startsWith('homey-'))

  let selectedKey: string | null = null
  if (activeHomeyId !== null && homeyApi[`homey-${activeHomeyId}`] !== undefined) {
    selectedKey = `homey-${activeHomeyId}`
  } else if (homeyEntryKeys.length === 1) {
    // Not a guess: with exactly one stored Homey there is nothing to choose between.
    selectedKey = homeyEntryKeys[0] ?? null
  } else if (homeyEntryKeys.length > 1) {
    throw new HomeyMcpError(
      'invalid_request',
      `The Homey CLI has sessions for several Homeys but none of them is marked as active, so this server cannot tell which one you mean. Run "homey select" to choose one, then start this server again.`,
      { path, availableHomeys: homeyEntryKeys.map((key) => key.replace(/^homey-/, '')) },
    )
  }

  if (selectedKey === null) {
    // A cloud token on its own is still usable: the cloud can name the Homeys.
    if (cloudToken === null) return null
    return {
      path,
      cloudToken,
      cloudTokenExpiresAt,
      homeyId: activeHomeyId,
      localSessionToken: null,
      sessionExpiresAt: null,
      scopes: [],
    }
  }

  const homeyEntry = asRecord(homeyApi[selectedKey])
  const session = asRecord(homeyEntry?.['session'])
  const localSessionToken = typeof homeyEntry?.['token'] === 'string' ? (homeyEntry['token'] as string) : null

  return {
    path,
    cloudToken,
    cloudTokenExpiresAt,
    homeyId: activeHomeyId ?? selectedKey.replace(/^homey-/, ''),
    localSessionToken,
    sessionExpiresAt: typeof session?.['expiresAt'] === 'string' ? (session['expiresAt'] as string) : null,
    scopes: asStringArrayOrNull(session?.['intersectedScopes']) ?? asStringArrayOrNull(session?.['scopes']) ?? [],
  }
}

function fromStoredCredentials(
  stored: StoredCredentials,
  configPath: string,
  sourceDescription: string,
): ResolvedCredentials {
  return {
    source: 'config_file',
    sourceDescription,
    cloudToken: stored.cloudToken ?? null,
    cloudTokenExpiresAt: stored.cloudTokenExpiresAt ?? null,
    personalAccessToken: stored.personalAccessToken ?? null,
    homeyId: stored.homeyId ?? null,
    localSessionToken: stored.localSessionToken ?? null,
    localAddress: stored.localAddress ?? null,
    localSecureAddress: stored.localSecureAddress ?? null,
    sessionExpiresAt: stored.sessionExpiresAt ?? null,
    scopes: stored.scopes ?? [],
    configPath,
  }
}

/** True when a session is known to have expired. Sessions last 24 hours from creation. */
export function isSessionExpired(credentials: ResolvedCredentials, now: Date = new Date()): boolean {
  return hasPassed(credentials.sessionExpiresAt ?? null, now)
}

/**
 * True when the Athom cloud token is known to be dead.
 *
 * Worth asking separately from `isSessionExpired` because the two lifetimes are
 * an order of magnitude apart: the cloud token lives about an hour, the hub
 * session it minted lives 24. For most of any given day the cloud token is the
 * dead one while the hub session is still perfectly good, and treating a
 * credentials file as "has an Athom credential" on the strength of an hour-old
 * token is what sent this server down the cloud route and into a dead end.
 *
 * False when the source gives no lifetime, because "not stated" is not "expired".
 */
export function isCloudTokenExpired(credentials: ResolvedCredentials, now: Date = new Date()): boolean {
  if (credentials.cloudToken === null) return false
  return hasPassed(credentials.cloudTokenExpiresAt ?? null, now)
}

/** An unparseable or absent timestamp is not evidence of expiry, so it reads as false. */
function hasPassed(timestamp: string | null, now: Date): boolean {
  if (timestamp === null) return false
  const instant = Date.parse(timestamp)
  if (Number.isNaN(instant)) return false
  return instant <= now.getTime()
}

/**
 * Null rather than an empty array when the field is absent.
 *
 * Deliberately not `util/coerce.ts`'s `asStringArray`: the caller chains two
 * scope fields with `??`, so "the session listed no scopes" and "this field was
 * not present" have to stay distinguishable.
 */
function asStringArrayOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function asAthomCloudToken(value: unknown): AthomCloudToken | null {
  const record = asRecord(value)
  if (record === null) return null
  const accessToken = record['access_token']
  if (typeof accessToken !== 'string' || accessToken === '') return null

  return {
    token_type: typeof record['token_type'] === 'string' ? (record['token_type'] as string) : 'bearer',
    access_token: accessToken,
    refresh_token: typeof record['refresh_token'] === 'string' ? (record['refresh_token'] as string) : null,
    expires_in: typeof record['expires_in'] === 'number' ? (record['expires_in'] as number) : null,
    grant_type: typeof record['grant_type'] === 'string' ? (record['grant_type'] as string) : null,
  }
}
