// Onboarding, in one command.
//
// The promise this file has to keep is that somebody goes from nothing to a
// working server without hunting for an IP address, without reading a wiki page
// about API generations, and without hand-editing a JSON config. So it does the
// finding, the verifying and the writing, and ends by printing the one line the
// user pastes into their assistant.
//
// Two credential routes exist on this hardware and they are stored very
// differently, which is the least obvious thing in here.
//
//   - The Homey CLI's session is not copied. It is re-read from the CLI's own
//     file on every start, because a hub session lasts 24 hours and a copy would
//     be stale by tomorrow while shadowing the fresh original. Setup verifies it
//     and writes nothing.
//   - An Athom Personal Access Token is ours to keep, so it is written to
//     ~/.config/homey-mcp/credentials.json with mode 0600, but only after it has
//     been proven to reach the hub. An unverified credential on disk is worse
//     than none: it turns "you are not set up" into "something is broken".

import { rm } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import type { Interface as ReadlineInterface } from 'node:readline/promises'

import { AthomCloudAPI } from 'homey-api'

import { connectToHomey, disconnectFromHomey } from '../homey/connect.js'
import type { ResolvedCredentials, StoredCredentials } from '../homey/credentials.js'
import {
  PERSONAL_ACCESS_TOKEN_ENVIRONMENT_VARIABLE,
  readHomeyCliSession,
  readStoredCredentials,
  resolveCredentials,
  storedCredentialsPath,
  writeStoredCredentials,
} from '../homey/credentials.js'
import { buildAddressCandidates, probeAddresses } from '../homey/discovery.js'
import { classifyError } from '../homey/errors.js'
import { readPackageMetadata } from '../server/createServer.js'
import type { Logger } from '../util/log.js'
import { createLogger } from '../util/log.js'
import { maskSecret } from '../util/redact.js'

/** Where an Athom account Personal Access Token is created. Printed verbatim so it can be clicked. */
export const PERSONAL_ACCESS_TOKEN_URL = 'https://tools.developer.homey.app/me'

export interface SetupOptions {
  argv?: string[]
  environment?: Record<string, string | undefined>
  logger?: Logger
  input?: NodeJS.ReadableStream & { isTTY?: boolean }
  output?: NodeJS.WritableStream
}

export async function runSetup(options: SetupOptions = {}): Promise<number> {
  const environment = options.environment ?? process.env
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const logger = options.logger ?? createLogger({ scope: 'setup', environment, level: 'error' })

  const write = (line = ''): void => {
    output.write(`${line}\n`)
  }

  const readlineInterface = createInterface({ input, output, terminal: input.isTTY === true })

  try {
    write()
    write('  homey-mcp setup')
    write('  Connects an AI assistant to your Homey Pro.')
    write()

    const configPath = storedCredentialsPath({ environment })
    const existing = await readStoredCredentials(configPath)
    if (existing !== null) {
      write(`There are already credentials at ${configPath}.`)
      const replace = await askYesNo(readlineInterface, 'Replace them and set up again?', false)
      if (!replace) {
        write()
        write('Nothing changed. Run "npx homey-mcp doctor" to check that they still work.')
        return 0
      }
      write()
    }

    const cliSession = await readHomeyCliSession({ environment, logger })
    if (cliSession !== null) {
      write('Found a Homey CLI login on this machine.')
      write(`  file:   ${cliSession.path}`)
      if (cliSession.homeyId !== null) write(`  homey:  ${cliSession.homeyId}`)
      if (cliSession.scopes.length > 0) write(`  scopes: ${cliSession.scopes.join(', ')}`)
      write()
      write('This is the route that can create Flows: the CLI session carries the root "homey" scope,')
      write('which Athom does not grant to third-party API clients.')
      write()

      const useCliSession = await askYesNo(readlineInterface, 'Use this login?', true)
      write()
      if (useCliSession) {
        return await finishWithHomeyCliSession({
          write,
          logger,
          environment,
          // Credential resolution reads our own file before the CLI's session, so
          // an old file left in place would silently win over the login the user
          // just chose. They already agreed to replace it.
          configPathToDiscard: existing === null ? null : configPath,
        })
      }
    }

    return await finishWithPersonalAccessToken({
      readlineInterface,
      write,
      output,
      logger,
      environment,
      configPath,
      canPrompt: input.isTTY === true,
    })
  } catch (error) {
    const failure = classifyError(error, { operation: 'setup' })
    write()
    write('Setup could not finish.')
    write()
    write(failure.message)
    write()
    write('Run "npx homey-mcp doctor" for a full check of what does and does not answer.')
    return 1
  } finally {
    readlineInterface.close()
  }
}

interface FinishWithCliSessionOptions {
  write: (line?: string) => void
  logger: Logger
  environment: Record<string, string | undefined>
  /** An older credentials file the user agreed to replace, which must not be left to win. */
  configPathToDiscard: string | null
}

/**
 * Verifies the CLI session and stops there. Deliberately writes no file: see the
 * note at the top of this module about why copying that token would break in a
 * day's time.
 */
async function finishWithHomeyCliSession(options: FinishWithCliSessionOptions): Promise<number> {
  if (options.configPathToDiscard !== null) {
    await rm(options.configPathToDiscard, { force: true })
    options.write(`Removed the older credentials at ${options.configPathToDiscard}.`)
    options.write()
  }

  options.write('Checking that it can reach your Homey...')
  const identity = await verifyCredentials({ environment: options.environment, logger: options.logger })
  reportIdentity(options.write, identity)

  options.write('Nothing was saved to disk, and that is on purpose: this server reads the Homey CLI')
  options.write('session fresh every time it starts, so it always uses a current one.')
  options.write()
  options.write('If "homey login" is ever run again, or a different Homey is selected with "homey select",')
  options.write('this server follows along without any further setup.')
  options.write()
  printClientInstructions(options.write)
  return 0
}

interface FinishWithTokenOptions {
  readlineInterface: ReadlineInterface
  write: (line?: string) => void
  output: NodeJS.WritableStream
  logger: Logger
  environment: Record<string, string | undefined>
  configPath: string
  canPrompt: boolean
}

async function finishWithPersonalAccessToken(options: FinishWithTokenOptions): Promise<number> {
  const environmentToken = options.environment[PERSONAL_ACCESS_TOKEN_ENVIRONMENT_VARIABLE]
  const tokenFromEnvironment =
    environmentToken !== undefined && environmentToken.trim() !== '' ? environmentToken.trim() : null

  let personalAccessToken = tokenFromEnvironment

  if (personalAccessToken === null) {
    options.write('This server needs an Athom Personal Access Token.')
    options.write()
    options.write('  1. Open this page and sign in with your Athom account:')
    options.write(`       ${PERSONAL_ACCESS_TOKEN_URL}`)
    options.write('  2. Create a Personal Access Token.')
    options.write('  3. Copy it and paste it below. It will not be shown as you type.')
    options.write()

    if (!options.canPrompt) {
      options.write('This terminal cannot prompt for input, so setup cannot continue here.')
      options.write()
      options.write(`Run setup again in an interactive terminal, or set ${PERSONAL_ACCESS_TOKEN_ENVIRONMENT_VARIABLE}`)
      options.write('in the environment and run it again.')
      return 1
    }

    personalAccessToken = await askSecret(options.readlineInterface, options.output, 'Personal Access Token: ')
    options.write()
  } else {
    options.write(`Using the token from ${PERSONAL_ACCESS_TOKEN_ENVIRONMENT_VARIABLE}.`)
    options.write()
  }

  if (personalAccessToken === null || personalAccessToken === '') {
    options.write('No token was entered, so there is nothing to check.')
    return 1
  }

  options.write('Asking Athom which Homeys this account has...')
  const homeys = await listCloudHomeys(personalAccessToken)

  if (homeys.length === 0) {
    options.write()
    options.write('That token works, but the account has no Homey linked to it.')
    options.write('Sign in to the Homey app with the account that owns your Homey, then run setup again.')
    return 1
  }

  const selected = await selectHomey(options.readlineInterface, options.write, homeys, options.canPrompt)
  options.write()
  options.write(`Using ${selected.name ?? selected.id}.`)
  options.write()

  await reportAddresses(options.write, selected)

  const stored: StoredCredentials = {
    personalAccessToken,
    homeyId: selected.id,
    localAddress: selected.localUrl,
    localSecureAddress: selected.localUrlSecure,
  }

  options.write('Checking that it can reach your Homey...')
  const identity = await verifyCredentials({
    environment: options.environment,
    logger: options.logger,
    credentials: {
      source: 'config_file',
      // Labelled as the file it is about to become: this exact object is what
      // gets written, and only after the check below has passed.
      sourceDescription: 'the Personal Access Token entered during setup',
      cloudToken: null,
      personalAccessToken,
      homeyId: selected.id,
      localSessionToken: null,
      localAddress: selected.localUrl,
      localSecureAddress: selected.localUrlSecure,
      sessionExpiresAt: null,
      scopes: [],
      configPath: null,
    },
  })

  reportIdentity(options.write, identity)

  await writeStoredCredentials(options.configPath, stored)
  options.write(`Saved to ${options.configPath} (readable only by you).`)
  options.write(`Token stored: ${maskSecret(personalAccessToken)}`)
  options.write()

  printClientInstructions(options.write)
  return 0
}

interface VerifyCredentialsOptions {
  environment: Record<string, string | undefined>
  logger: Logger
  /** Verify these instead of whatever credential resolution would find. */
  credentials?: ResolvedCredentials
}

interface VerifiedIdentity {
  name: string
  modelName: string
  softwareVersion: string
  address: string
  addressKind: string
  dialect: string
  timezone: string
}

/** Proves the credential works by connecting and reading the hub's own identity back. */
async function verifyCredentials(options: VerifyCredentialsOptions): Promise<VerifiedIdentity> {
  const credentials =
    options.credentials ??
    (await resolveCredentials({ environment: options.environment, logger: options.logger }))

  const connection = await connectToHomey(credentials, { logger: options.logger })
  try {
    return {
      name: connection.identity.name,
      modelName: connection.identity.modelName,
      softwareVersion: connection.identity.softwareVersion,
      address: connection.identity.address,
      addressKind: connection.identity.addressKind,
      dialect: connection.dialect,
      timezone: connection.identity.timezone,
    }
  } finally {
    await disconnectFromHomey(connection)
  }
}

function reportIdentity(write: (line?: string) => void, identity: VerifiedIdentity): void {
  write()
  write(`Connected to "${identity.name}".`)
  write(`  model:     ${identity.modelName}`)
  write(`  firmware:  ${identity.softwareVersion}`)
  write(`  API:       ${identity.dialect === 'v2' ? 'V2 (2016-2019 hardware)' : 'V3 (2023 hardware and newer)'}`)
  write(`  reached:   ${describeAddressKind(identity.addressKind)}`)
  write(`  timezone:  ${identity.timezone}`)
  write()
}

interface CloudHomey {
  id: string
  name: string | null
  localUrl: string | null
  localUrlSecure: string | null
}

/**
 * Lists the Homeys on the account behind a token.
 *
 * Done here rather than letting the connection pick the first one, because an
 * account with two Homeys would otherwise be set up against whichever one Athom
 * happens to return first, silently and possibly wrongly.
 */
async function listCloudHomeys(athomToken: string): Promise<CloudHomey[]> {
  try {
    const TokenConstructor = AthomCloudAPI.Token as unknown as new (options: {
      token_type: string
      access_token: string
    }) => unknown
    const CloudApiConstructor = AthomCloudAPI as unknown as new (options: {
      token: unknown
      autoRefreshTokens: boolean
    }) => { getAuthenticatedUser(): Promise<{ getHomeys(): unknown[] }> }

    const cloudApi = new CloudApiConstructor({
      token: new TokenConstructor({ token_type: 'bearer', access_token: athomToken }),
      // A Personal Access Token is not an OAuth grant, so there is nothing to
      // refresh it with and attempting to would only produce a confusing error.
      autoRefreshTokens: false,
    })

    const user = await cloudApi.getAuthenticatedUser()
    return user.getHomeys().map((entry) => {
      const record = entry as Record<string, unknown>
      return {
        id: String(record['id'] ?? record['_id'] ?? ''),
        name: typeof record['name'] === 'string' ? record['name'] : null,
        localUrl: typeof record['localUrl'] === 'string' ? record['localUrl'] : null,
        localUrlSecure: typeof record['localUrlSecure'] === 'string' ? record['localUrlSecure'] : null,
      }
    })
  } catch (error) {
    throw classifyError(error, { operation: 'athom.getHomeys' })
  }
}

async function selectHomey(
  readlineInterface: ReadlineInterface,
  write: (line?: string) => void,
  homeys: CloudHomey[],
  canPrompt: boolean,
): Promise<CloudHomey> {
  const only = homeys[0]
  if (homeys.length === 1 && only !== undefined) return only

  write()
  write('This account has more than one Homey:')
  homeys.forEach((homey, index) => {
    write(`  ${index + 1}. ${homey.name ?? homey.id}`)
  })
  write()

  if (!canPrompt) {
    throw new Error(
      'More than one Homey is linked to this account and this terminal cannot prompt, so setup cannot tell which one you mean. Run setup again in an interactive terminal.',
    )
  }

  for (;;) {
    const answer = (await readlineInterface.question(`Which one? [1-${homeys.length}] `)).trim()
    const chosenIndex = Number.parseInt(answer, 10)
    const chosen = Number.isNaN(chosenIndex) ? undefined : homeys[chosenIndex - 1]
    if (chosen !== undefined) return chosen
    write(`Please answer with a number between 1 and ${homeys.length}.`)
  }
}

async function reportAddresses(write: (line?: string) => void, homey: CloudHomey): Promise<void> {
  const candidates = buildAddressCandidates({
    localAddress: homey.localUrl,
    localSecureAddress: homey.localUrlSecure,
    cloudId: homey.id,
  })

  if (candidates.length === 0) {
    write('Athom reported no addresses for this Homey, so the connection will be made through the cloud.')
    write()
    return
  }

  write('Checking which addresses answer...')
  const results = await probeAddresses(candidates)
  for (const result of results) {
    write(
      result.reachable
        ? `  ${describeAddressKind(result.kind).padEnd(24)} answered in ${result.durationMs} ms`
        : `  ${describeAddressKind(result.kind).padEnd(24)} no answer`,
    )
  }
  write()

  if (!results.some((result) => result.reachable)) {
    write('None of them answered from this machine. That is not fatal, but it does mean every call')
    write('will go through the Athom cloud, which is slower. Being on the same network as the Homey')
    write('is what makes the local route available.')
    write()
  }
}

function printClientInstructions(write: (line?: string) => void): void {
  const packageName = readPackageMetadata().name

  write('Add it to Claude Code with exactly this line:')
  write()
  write(`  claude mcp add --scope user --transport stdio homey -- npx -y ${packageName}@latest`)
  write()
  write('For any other MCP client, the equivalent entry is:')
  write()
  write(`  "homey": { "command": "npx", "args": ["-y", "${packageName}@latest"] }`)
  write()
  write('No credentials belong in that entry: this server finds them itself.')
  write()
  write('Then ask your assistant something like "what is the temperature in the living room?".')
  write()
}

async function askYesNo(
  readlineInterface: ReadlineInterface,
  question: string,
  defaultAnswer: boolean,
): Promise<boolean> {
  const suffix = defaultAnswer ? '[Y/n]' : '[y/N]'
  for (;;) {
    const answer = (await readlineInterface.question(`${question} ${suffix} `)).trim().toLowerCase()
    if (answer === '') return defaultAnswer
    if (answer === 'y' || answer === 'yes') return true
    if (answer === 'n' || answer === 'no') return false
  }
}

/**
 * Reads a secret without echoing it.
 *
 * `readline` has no public way to suppress the echo, so the prompt is written
 * separately and the interface's own writer is silenced for the duration. The
 * alternative is a token sitting in the terminal scrollback and in every screen
 * recording made afterwards.
 */
async function askSecret(
  readlineInterface: ReadlineInterface,
  output: NodeJS.WritableStream,
  prompt: string,
): Promise<string> {
  output.write(prompt)

  const writable = readlineInterface as unknown as { _writeToOutput?: (text: string) => void }
  const originalWriter = writable._writeToOutput
  writable._writeToOutput = () => {}

  try {
    const answer = await readlineInterface.question('')
    return answer.trim()
  } finally {
    if (originalWriter === undefined) {
      delete writable._writeToOutput
    } else {
      writable._writeToOutput = originalWriter
    }
    output.write('\n')
  }
}

function describeAddressKind(kind: string): string {
  switch (kind) {
    case 'local':
      return 'your local network'
    case 'localSecure':
      return 'your local network (TLS)'
    case 'cloud':
      return "Athom's cloud"
    default:
      return kind
  }
}
