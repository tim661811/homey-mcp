// The three probes behind the sign-in page.
//
// Route A reads the Homey CLI's settings file and reports what it found. It does
// NOT run the CLI. CLAUDE.md allows driving the official CLI in exactly one
// place, `setup`, because that is user initiated, interactive and visible, and
// says plainly that `serve` never calls any of it. A page served by a background
// daemon is precisely the invisible automatic caller that rule forbids, so this
// module reads files and asks the connection it was handed to try again. It
// writes nothing, ever.
//
// Route B takes a Personal Access Token typed into the browser, proves it works
// against the hub BEFORE anything touches the disk, and then MERGES it into the
// credentials file. The merge is the load-bearing half: `resolveCredentials`
// stops at the first readable credentials file, so a file written wholesale with
// only a token in it would shadow a working Homey CLI session permanently. Same
// shape as the rule that the hub address cache must be merged rather than
// overwritten, and the same bug if it is got wrong.

import type { HomeySignInState } from './page.js'
import { connectToHomey, disconnectFromHomey } from '../homey/connect.js'
import type { ResolvedCredentials, StoredCredentials } from '../homey/credentials.js'
import {
  readHomeyCliSession,
  readStoredCredentials,
  storedCredentialsPath,
  writeStoredCredentials,
} from '../homey/credentials.js'
import { classifyError } from '../homey/errors.js'
import type { HomeyIdentity } from '../homey/types.js'
import type { Logger } from '../util/log.js'

/** What the page needs from the running server to answer "are we signed in". */
export interface SignInConnection {
  readonly authenticated: boolean
  authenticate(): Promise<HomeyIdentity>
  /** Throws when there is no session, which is why `authenticated` is checked first. */
  readonly identity?: HomeyIdentity
}

export interface DescribeHomeySignInOptions {
  connection: SignInConnection
  environment?: Record<string, string | undefined>
  logger?: Logger
}

/**
 * Tries to sign in and turns the outcome into the two sentences the page shows.
 *
 * Calling `authenticate` rather than reading a flag is the point: it re-reads the
 * credential source, which is how a `homey login` that happened thirty seconds
 * ago in another terminal becomes visible without restarting anything.
 */
export async function describeHomeySignIn(options: DescribeHomeySignInOptions): Promise<HomeySignInState> {
  try {
    const identity = await options.connection.authenticate()
    return {
      kind: 'signed_in',
      homeyName: identity.name,
      modelName: identity.modelName,
      firmware: identity.softwareVersion,
      sessionExpiresAt: null,
    }
  } catch (error: unknown) {
    const failure = classifyError(error, { operation: 'sign in to Homey' })
    return {
      kind: 'not_signed_in',
      reason: failure.message,
      instruction: await instructionForCliState(options),
    }
  }
}

/**
 * What to do about the Homey CLI, given what its settings file actually says.
 *
 * Three different states that all look the same from the outside, and naming
 * which one it is is the difference between one command and an afternoon.
 */
async function instructionForCliState(options: DescribeHomeySignInOptions): Promise<string> {
  const environment = options.environment ?? process.env

  let session: Awaited<ReturnType<typeof readHomeyCliSession>>
  try {
    session = await readHomeyCliSession({
      environment,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    })
  } catch (error: unknown) {
    // The only error this throws is the several-Homeys-and-none-active one,
    // which already carries the sentence naming `homey select`.
    return classifyError(error, { operation: 'read the Homey CLI session' }).message
  }

  if (session === null) {
    return 'The Homey CLI is not signed in on this machine. Open a terminal, run "homey login", then press Check again.'
  }

  if (session.localSessionToken === null && session.cloudToken === null) {
    return `The Homey CLI settings file at ${session.path} holds no usable session. Run "homey login" in a terminal, then press Check again.`
  }

  return `The Homey CLI has a session at ${session.path}, but it did not open. Run "homey login" in a terminal to refresh it, then press Check again.`
}

export interface VerifyAndStoreTokenOptions {
  personalAccessToken: string
  environment?: Record<string, string | undefined>
  logger?: Logger
  /** Overridden by tests. Defaults to the usual credentials file. */
  configPath?: string
  /** Overridden by tests, so nothing has to reach a real hub. */
  verifyImplementation?: (credentials: ResolvedCredentials) => Promise<HomeyIdentity>
}

export interface VerifyAndStoreTokenResult {
  ok: boolean
  /** One sentence for the page. Never contains the token, on either path. */
  message: string
}

/**
 * Verifies a pasted Personal Access Token and, only if it works, merges it in.
 *
 * The order is the rule `setup` already established: an unverified credential on
 * disk turns "you are not set up" into "something is broken", which is a much
 * worse place to debug from. So nothing is written until the hub has answered.
 *
 * The token appears in no return value, no log line and no error message. What
 * comes back is a sentence for a human and a boolean.
 */
export async function verifyAndStorePersonalAccessToken(
  options: VerifyAndStoreTokenOptions,
): Promise<VerifyAndStoreTokenResult> {
  const environment = options.environment ?? process.env
  const personalAccessToken = options.personalAccessToken.trim()

  if (personalAccessToken === '') {
    return { ok: false, message: 'No token was entered, so there was nothing to check.' }
  }

  const configPath = options.configPath ?? storedCredentialsPath({ environment })
  const existing = (await readStoredCredentials(configPath).catch(() => null)) ?? {}

  const candidate: ResolvedCredentials = {
    source: 'config_file',
    // Named as the file it is about to become, and only if the check below passes.
    sourceDescription: 'the Personal Access Token entered in the browser',
    cloudToken: null,
    personalAccessToken,
    homeyId: existing.homeyId ?? null,
    localSessionToken: null,
    localAddress: existing.localAddress ?? null,
    localSecureAddress: existing.localSecureAddress ?? null,
    sessionExpiresAt: null,
    scopes: [],
    configPath: null,
  }

  const verify = options.verifyImplementation ?? defaultVerify(options.logger)

  let identity: HomeyIdentity
  try {
    identity = await verify(candidate)
  } catch (error: unknown) {
    const failure = classifyError(error, { operation: 'check the Personal Access Token' })
    return {
      ok: false,
      message: `That token did not work, so nothing was saved. ${failure.message}`,
    }
  }

  // Merged, never wholesale. A field the new credential does not name keeps its
  // old value, so a Homey CLI session recorded here is not erased by a token.
  const merged: StoredCredentials = {
    ...existing,
    personalAccessToken,
    homeyId: existing.homeyId ?? null,
  }
  await writeStoredCredentials(configPath, merged)

  return {
    ok: true,
    message: `Saved. Connected to "${identity.name}", a ${identity.modelName} on firmware ${identity.softwareVersion}.`,
  }
}

/** Proves the credential works by connecting and reading the hub's own identity back. */
function defaultVerify(logger: Logger | undefined): (credentials: ResolvedCredentials) => Promise<HomeyIdentity> {
  return async (credentials: ResolvedCredentials): Promise<HomeyIdentity> => {
    const connection = await connectToHomey(credentials, logger === undefined ? {} : { logger })
    try {
      return connection.identity
    } finally {
      await disconnectFromHomey(connection)
    }
  }
}
