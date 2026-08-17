// Onboarding, in one command.
//
// The promise this file has to keep is that somebody goes from nothing to a
// working server without hunting for an IP address, without reading a wiki page
// about API generations, and without hand-editing a JSON config. So it does the
// finding, the verifying and the writing, and ends by printing the one line the
// user pastes into their assistant.
//
// It used to start by assuming the official Homey CLI was already installed and
// already logged in, which is the one assumption a first-time user cannot
// satisfy. It now walks that gap itself: find the CLI, offer to install it, run
// the login, settle which Homey is active, and only then verify by connecting.
//
// Two rules govern that walk.
//
// NOTHING IS INSTALLED WITHOUT AN EXPLICIT YES. `npm install --global homey`
// writes outside this project and can need elevated permissions, so it is asked
// for, the exact command is shown before it runs, and declining is a supported
// answer rather than a dead end: the npx route needs no global write, and the
// Personal Access Token route needs no CLI at all.
//
// THE PERSONAL ACCESS TOKEN ROUTE IS A FIRST-CLASS PATH, NOT A PUNISHMENT.
// Anyone who does not want a global npm install, cannot have one, or simply does
// not want another tool on their machine lands there, and everything except
// creating flows works exactly the same.
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
import {
  findHomeyCli,
  getSelectedHomey,
  HOMEY_CLI_INSTALL_COMMAND,
  installHomeyCli,
  isLoggedIn,
  npxHomeyCli,
  readHomeyCliStoredState,
  runInteractive,
  selectHomeyWithCli,
} from '../homey/homey-cli.js'
import type {
  CommandRunner,
  FindHomeyCliOptions,
  HomeyCliFileSystem,
  HomeyCliHomey,
  HomeyCliInstallation,
  RunHomeyCliOptions,
} from '../homey/homey-cli.js'
import { readPackageMetadata } from '../server/createServer.js'
import type { Logger } from '../util/log.js'
import { createLogger } from '../util/log.js'
import { maskSecret } from '../util/redact.js'
import { readFlagValue } from './flags.js'
import { checkNodeVersion, MINIMUM_NODE_MAJOR_VERSION } from './node-version.js'

/** Where an Athom account Personal Access Token is created. Printed verbatim so it can be clicked. */
export const PERSONAL_ACCESS_TOKEN_URL = 'https://tools.developer.homey.app/me'

/**
 * The machine setup is running on.
 *
 * Injected as one object rather than as six unrelated options, and only ever by
 * tests: the walk below installs software and starts a browser, so it has to be
 * possible to drive the whole thing against a machine that does not exist.
 * Everything here defaults to the real one.
 */
export interface SetupMachine {
  fileSystem?: HomeyCliFileSystem
  runCommand?: CommandRunner
  homeDirectory?: string
  platform?: NodeJS.Platform
  nodeExecutablePath?: string
}

export interface SetupOptions {
  argv?: string[]
  environment?: Record<string, string | undefined>
  logger?: Logger
  input?: NodeJS.ReadableStream & { isTTY?: boolean }
  output?: NodeJS.WritableStream
  machine?: SetupMachine
}

type Write = (line?: string) => void

/** Everything the two routes need, gathered once so no step has to rebuild it. */
interface SetupSession {
  write: Write
  readlineInterface: ReadlineInterface
  output: NodeJS.WritableStream
  logger: Logger
  environment: Record<string, string | undefined>
  /** True only on a real terminal. Anything interactive is skipped otherwise rather than hung on. */
  canPrompt: boolean
  /**
   * `--yes` on the command line. Answers the questions that ask permission to
   * proceed, so an unattended run can consent to installing the CLI.
   *
   * Deliberately NOT applied to "replace the credentials you already have?".
   * Yes is the constructive answer to the first kind of question and a
   * destructive one to the second, and a single flag must not silently mean
   * both.
   */
  assumeYes: boolean
  machine: SetupMachine
}

/** Where to look for the CLI. The npm probe is on: see `ensureHomeyCliPresent`. */
function lookupOptions(session: SetupSession): FindHomeyCliOptions {
  return {
    environment: session.environment,
    logger: session.logger,
    probeNpmGlobalRoot: true,
    ...(session.machine.fileSystem === undefined ? {} : { fileSystem: session.machine.fileSystem }),
    ...(session.machine.runCommand === undefined ? {} : { runCommand: session.machine.runCommand }),
    ...(session.machine.platform === undefined ? {} : { platform: session.machine.platform }),
    ...(session.machine.nodeExecutablePath === undefined
      ? {}
      : { nodeExecutablePath: session.machine.nodeExecutablePath }),
  }
}

/** How to run it, once found. */
function runOptions(session: SetupSession): RunHomeyCliOptions {
  return {
    environment: session.environment,
    logger: session.logger,
    ...(session.machine.runCommand === undefined ? {} : { runCommand: session.machine.runCommand }),
  }
}

export async function runSetup(options: SetupOptions = {}): Promise<number> {
  const environment = options.environment ?? process.env
  const argv = options.argv ?? []
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const logger = options.logger ?? createLogger({ scope: 'setup', environment, level: 'error' })

  const write: Write = (line = ''): void => {
    output.write(`${line}\n`)
  }

  const readlineInterface = createInterface({ input, output, terminal: input.isTTY === true })
  const httpMode = argv.includes('--http')

  const session: SetupSession = {
    write,
    readlineInterface,
    output,
    logger,
    environment,
    canPrompt: input.isTTY === true,
    assumeYes: argv.includes('--yes') || argv.includes('-y'),
    machine: options.machine ?? {},
  }

  try {
    write()
    write('  homey-mcp setup')
    write('  Connects an AI assistant to your Homey Pro.')
    write()

    if (!reportNodeVersion(write)) return 1

    const configPath = storedCredentialsPath({ environment })
    const existing = await readStoredCredentials(configPath)
    if (existing !== null) {
      write(`There are already credentials at ${configPath}.`)
      const replace = await askYesNo(session, 'Replace them and set up again?', false)
      if (!replace) {
        write()
        write('Nothing changed. Run "npx homey-mcp doctor" to check that they still work.')
        return 0
      }
      write()
    }

    const useCliRoute = await walkHomeyCliRoute(session)
    const credentialExitCode = useCliRoute
      ? await finishWithHomeyCliSession({
          write,
          logger,
          environment,
          // Credential resolution reads our own file before the CLI's session, so
          // an old file left in place would silently win over the login the user
          // just chose. They already agreed to replace it.
          configPathToDiscard: existing === null ? null : configPath,
          httpMode,
        })
      : await finishWithPersonalAccessToken({
          readlineInterface,
          write,
          output,
          logger,
          environment,
          configPath,
          canPrompt: session.canPrompt,
          httpMode,
        })

    if (credentialExitCode !== 0) return credentialExitCode

    if (!httpMode) {
      // One sentence, at the end, after the working instructions. Somebody who
      // does not care about the browser sign-in reads one extra line.
      const { HTTP_MODE_POINTER } = await import('./setupHttp.js')
      for (const line of HTTP_MODE_POINTER) write(line)
      write()
      return 0
    }

    // Only now, because the credential half has to have succeeded before there
    // is any point starting a service that would answer with nothing behind it.
    const { finishWithHttpMode } = await import('./setupHttp.js')
    const portValue = readFlagValue(argv, '--port')
    return await finishWithHttpMode({
      write,
      argv,
      environment,
      output,
      input,
      ...(portValue === null ? {} : { port: Number.parseInt(portValue, 10) }),
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

/**
 * The Node check, first and out loud.
 *
 * The binary already refuses to load anything on an old Node, so reaching this
 * line means the version is fine. It is still printed, because a setup that
 * silently skips its first step leaves a user who later hits a version problem
 * with no idea it was ever looked at.
 */
function reportNodeVersion(write: Write): boolean {
  const verdict = checkNodeVersion()
  write('Node')
  if (verdict.satisfied) {
    write(`  Node ${verdict.version}. This server and the Homey client library both need ${MINIMUM_NODE_MAJOR_VERSION} or newer.`)
    write()
    return true
  }

  write(`  Node ${verdict.version} is too old: ${MINIMUM_NODE_MAJOR_VERSION} or newer is required.`)
  write(`  This Node came from ${verdict.executablePath}.`)
  write('  Install a current Node from https://nodejs.org, or with nvm: "nvm install 24 && nvm use 24".')
  write()
  return false
}

// ---------------------------------------------------------------------------
// The Homey CLI route
// ---------------------------------------------------------------------------

/**
 * Walks the whole CLI route and answers one question: can this server be set up
 * on the Homey CLI's session?
 *
 * False is a normal answer, not a failure. It means the Personal Access Token
 * route is the one to take, whether because the user preferred it, declined an
 * install, has no terminal to answer prompts in, or hit something that could not
 * be fixed from here. Every one of those cases prints what it found and what the
 * next action is before returning.
 */
async function walkHomeyCliRoute(session: SetupSession): Promise<boolean> {
  const { write } = session

  write('The Homey CLI')
  write('  This is the route that can create Flows. Athom issues the root "homey" scope only to its own')
  write('  first-party tool, and no third-party API token carries it, so flow writes need this CLI.')
  write()

  // Asked before anything is installed, because a machine that is already signed
  // in needs none of the steps below and a user who wants the token route should
  // not have to decline three questions to get there.
  const stored = await readHomeyCliStoredState({
    environment: session.environment,
    ...(session.machine.homeDirectory === undefined ? {} : { homeDirectory: session.machine.homeDirectory }),
  })
  if (stored !== null && stored.hasCloudToken) {
    write('  A Homey CLI login is already stored on this machine.')
    write(`  file:         ${stored.path}`)
    if (stored.activeHomeyName !== null) write(`  active Homey: ${stored.activeHomeyName}`)
    write()

    const useIt = await askYesNo(session, '  Use this login?', true, session.assumeYes)
    write()

    if (!useIt) {
      write('  Continuing with the Personal Access Token route.')
      write()
      return false
    }

    // With a Homey already chosen there is nothing the CLI itself is needed for:
    // this server reads that settings file directly on every start, so it works
    // even on a machine where the CLI was later uninstalled.
    if (stored.activeHomeyId !== null) return true

    write('  No Homey is selected yet, so the CLI is needed to choose one.')
    write()
  }

  const installation = await ensureHomeyCliPresent(session)
  if (installation === null) return false

  const signedIn = await ensureSignedIn(session, installation)
  if (!signedIn) return false

  return await ensureHomeySelected(session, installation)
}

/**
 * Finds the CLI, or offers to put it there.
 *
 * The npm probe is turned on here and nowhere else. It costs a subprocess, and
 * this is the one place where a wrong "not installed" would cost the user an
 * install they did not need.
 */
async function ensureHomeyCliPresent(session: SetupSession): Promise<HomeyCliInstallation | null> {
  const { write } = session

  const found = await findHomeyCli(lookupOptions(session))

  if (found !== null) {
    describeInstallation(write, found)
    return found
  }

  // Named in full rather than as "not on PATH". The CLI is frequently installed
  // and on no PATH at all, because running it once as "npx homey" leaves it in
  // the npx cache and nowhere else, and a PATH-only check calls that machine
  // unconfigured.
  write('  Not found: not on your PATH, not installed globally with npm, and not in the npx cache.')
  write()

  if (!session.canPrompt && !session.assumeYes) {
    write(`  Nothing is installed without asking, and this terminal cannot ask. To use this route:`)
    write(`    1. ${HOMEY_CLI_INSTALL_COMMAND}`)
    write('    2. homey login')
    write('    3. npx homey-mcp setup')
    write('  Or pass --yes to allow setup to install it unattended.')
    write()
    write('  Continuing with the Personal Access Token route, which needs no CLI.')
    write()
    return null
  }

  const install = await askYesNo(
    session,
    `  Install it now with "${HOMEY_CLI_INSTALL_COMMAND}"?`,
    true,
    session.assumeYes,
  )
  write()

  if (install) {
    write(`  Running ${HOMEY_CLI_INSTALL_COMMAND}. This can take a minute.`)
    const result = await installHomeyCli({
      confirmed: true,
      environment: session.environment,
      logger: session.logger,
      ...(session.machine.platform === undefined ? {} : { platform: session.machine.platform }),
      ...(session.machine.runCommand === undefined ? {} : { runCommand: session.machine.runCommand }),
    })

    if (result.installed) {
      write('  Installed.')
      const reFound = await findHomeyCli(lookupOptions(session))
      if (reFound !== null) {
        describeInstallation(write, reFound)
        return reFound
      }
      write('  npm reported success, but the CLI still cannot be found from here.')
      write()
    } else {
      // npm's own output is not passed through. Forty lines ending in
      // "EACCES: permission denied, mkdir '/usr/lib/node_modules'" is a true
      // description of a problem the user cannot act on.
      for (const line of result.message.split('\n')) write(`  ${line}`)
      write()
    }
  }

  const useNpx = await askYesNo(
    session,
    '  Use the CLI through npx instead, without installing anything globally?',
    true,
    session.assumeYes,
  )
  write()

  if (useNpx) {
    const installation = npxHomeyCli(
      session.machine.platform === undefined ? {} : { platform: session.machine.platform },
    )
    write('  Using "npx homey". npm downloads it into its own cache when it runs, and nothing is installed')
    write('  outside that cache. The first command is slower because of the download.')
    write()
    return installation
  }

  write('  Nothing was installed.')
  write('  Continuing with the Personal Access Token route, which needs no CLI.')
  write()
  return null
}

function describeInstallation(write: Write, installation: HomeyCliInstallation): void {
  write(`  Found ${installation.where}${installation.version === null ? '' : `, version ${installation.version}`}.`)
  if (installation.path !== null) write(`  path: ${installation.path}`)
  write()
}

/**
 * Makes sure the CLI holds a login, running the real one when it does not.
 *
 * The login is spawned with this process's own stdin, stdout and stderr, so the
 * user answers Athom's prompts directly. Nothing here scrapes the exchange or
 * touches the credential: the whole reason for using the official tool is that
 * the official tool owns it.
 */
async function ensureSignedIn(session: SetupSession, installation: HomeyCliInstallation): Promise<boolean> {
  const { write } = session

  write('Signing in')
  let state = await isLoggedIn(installation, {
    ...runOptions(session),
    confirmWithAthom: true,
    ...(session.machine.homeDirectory === undefined ? {} : { homeDirectory: session.machine.homeDirectory }),
  })

  if (state.loggedIn) {
    write(`  ${state.account === null ? 'Already signed in.' : `Already signed in as ${state.account}.`}`)
    write()
    return true
  }

  write(`  ${state.detail}`)
  write()

  if (!session.canPrompt) {
    // "homey login" opens a browser and waits for a person. Starting it where
    // nobody can answer would hang until the timeout and achieve nothing.
    write('  Signing in is interactive, and this terminal cannot prompt.')
    write('  Run "homey login" in a terminal, then run setup again.')
    write()
    write('  Continuing with the Personal Access Token route.')
    write()
    return false
  }

  if (session.assumeYes) {
    // --yes means "do not stop to ask me", and it is right for an install, which
    // is deterministic and finishes on its own. Signing in is the opposite: it
    // opens a browser and waits for a person to be there. Auto-consenting to
    // that on someone's behalf is how an unattended run ends up throwing a login
    // page in the face of whoever happens to be at the machine, which is exactly
    // what it did once. An unattended run cannot complete an OAuth flow anyway,
    // so there is nothing to gain and a real surprise to lose.
    write('  Signing in opens a browser and waits for you, so --yes does not do it for you.')
    write('  Run "homey login" yourself, then run setup again.')
    write()
    write('  Continuing with the Personal Access Token route.')
    write()
    return false
  }

  const runLogin = await askYesNo(session, '  Run "homey login" now?', true, false)
  write()

  if (!runLogin) {
    write('  Skipped. Run "homey login" whenever you want this route.')
    write()
    write('  Continuing with the Personal Access Token route.')
    write()
    return false
  }

  write('  Starting "homey login". It opens a browser and waits for you there.')
  write('  Everything below this line comes from Athom\'s own tool.')
  write()

  const result = await runInteractive(installation, ['login'], runOptions(session))

  write()
  if (result.outcome !== 'completed' || result.exitCode !== 0) {
    write(`  ${result.message}`)
    write('  Run "homey login" yourself to see what it says, then run setup again.')
    write()
    write('  Continuing with the Personal Access Token route.')
    write()
    return false
  }

  state = await isLoggedIn(installation, {
    ...runOptions(session),
    confirmWithAthom: true,
    ...(session.machine.homeDirectory === undefined ? {} : { homeDirectory: session.machine.homeDirectory }),
  })

  if (!state.loggedIn) {
    write(`  The login command finished, but there is still no usable session. ${state.detail}`)
    write()
    write('  Continuing with the Personal Access Token route.')
    write()
    return false
  }

  write(`  ${state.account === null ? 'Signed in.' : `Signed in as ${state.account}.`}`)
  write()
  return true
}

/**
 * Settles which Homey the CLI is pointed at.
 *
 * An account with two Homeys and none selected is a real state rather than a
 * crash: `homey select current` prints a bare null and exits 0, and everything
 * downstream then has no way to tell which house is meant.
 */
async function ensureHomeySelected(session: SetupSession, installation: HomeyCliInstallation): Promise<boolean> {
  const { write } = session

  write('Choosing a Homey')
  const selection = await getSelectedHomey(installation, runOptions(session))

  if (selection.status === 'selected' && selection.selected !== null) {
    write(`  ${describeHomey(selection.selected)} is selected.`)
    write()
    return true
  }

  if (selection.status === 'none_available') {
    write('  This Athom account has no Homey on it.')
    write('  Sign in to the Homey app with the account that owns your Homey, then run setup again.')
    write()
    return false
  }

  if (selection.status === 'unknown') {
    write(`  ${selection.detail}`)
    write('  Run "homey list" yourself to see what it says.')
    write()
    write('  Continuing with the Personal Access Token route.')
    write()
    return false
  }

  const chosen = await chooseHomey(session, selection.available)
  if (chosen === null) return false

  const result = await selectHomeyWithCli(installation, chosen.id, runOptions(session))

  if (result.outcome !== 'completed' || result.exitCode !== 0) {
    write(`  ${result.message}`)
    write(`  Run "homey select" yourself, then run setup again.`)
    write()
    write('  Continuing with the Personal Access Token route.')
    write()
    return false
  }

  write(`  ${describeHomey(chosen)} is now selected.`)
  write()
  return true
}

async function chooseHomey(session: SetupSession, available: HomeyCliHomey[]): Promise<HomeyCliHomey | null> {
  const { write } = session
  const only = available[0]

  if (available.length === 1 && only !== undefined) {
    write(`  No Homey is selected. This account has exactly one: ${describeHomey(only)}.`)
    const select = await askYesNo(session, '  Select it?', true, session.assumeYes)
    write()
    if (select) return only
    write('  Nothing selected.')
    write()
    write('  Continuing with the Personal Access Token route.')
    write()
    return null
  }

  write(`  No Homey is selected, and this account has ${available.length}:`)
  available.forEach((homey, index) => {
    write(`    ${index + 1}. ${describeHomey(homey)}`)
  })
  write()

  if (!session.canPrompt) {
    write('  This terminal cannot ask which one you mean.')
    write('  Run "homey select" in a terminal, then run setup again.')
    write()
    write('  Continuing with the Personal Access Token route.')
    write()
    return null
  }

  for (;;) {
    const answer = (await session.readlineInterface.question(`  Which one? [1-${available.length}] `)).trim()
    const chosenIndex = Number.parseInt(answer, 10)
    const chosen = Number.isNaN(chosenIndex) ? undefined : available[chosenIndex - 1]
    if (chosen !== undefined) {
      write()
      return chosen
    }
    write(`  Please answer with a number between 1 and ${available.length}.`)
  }
}

function describeHomey(homey: HomeyCliHomey): string {
  const name = homey.name ?? homey.id
  const details = [
    homey.softwareVersion === null ? null : `firmware ${homey.softwareVersion}`,
    homey.state === null ? null : homey.state,
  ].filter((entry): entry is string => entry !== null)
  return details.length === 0 ? name : `${name} (${details.join(', ')})`
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

interface FinishWithCliSessionOptions {
  write: Write
  logger: Logger
  environment: Record<string, string | undefined>
  /** An older credentials file the user agreed to replace, which must not be left to win. */
  configPathToDiscard: string | null
  /**
   * True when `--http` was given, in which case the stdio client entry is NOT
   * printed. Printing it and then telling the reader to remove it, which is what
   * the HTTP block has to say, is worse than not printing it at all.
   */
  httpMode: boolean
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

  // Read for its scope list, which is what proves this session can write flows.
  // It throws when the CLI holds sessions for several Homeys and none is
  // active, a state the selection step above has already settled, so a failure
  // here is worth reporting rather than swallowing.
  const cliSession = await readHomeyCliSession({ environment: options.environment, logger: options.logger })
  if (cliSession !== null) {
    options.write('Checking the connection')
    options.write(`  session file: ${cliSession.path}`)
    if (cliSession.scopes.length > 0) options.write(`  scopes:       ${cliSession.scopes.join(', ')}`)
    if (!cliSession.scopes.includes('homey') && cliSession.scopes.length > 0) {
      options.write('  This session does not carry the root "homey" scope, so creating flows will be refused.')
      options.write('  Run "homey login" again to get one that does.')
    }
  } else {
    options.write('Checking the connection')
  }

  options.write('  Connecting to your Homey and reading its identity back...')
  const identity = await verifyCredentials({ environment: options.environment, logger: options.logger })
  reportIdentity(options.write, identity)

  options.write('Nothing was saved to disk, and that is on purpose: this server reads the Homey CLI')
  options.write('session fresh every time it starts, so it always uses a current one.')
  options.write()
  options.write('If "homey login" is ever run again, or a different Homey is selected with "homey select",')
  options.write('this server follows along without any further setup.')
  options.write()
  if (!options.httpMode) printClientInstructions(options.write)
  return 0
}

interface FinishWithTokenOptions {
  readlineInterface: ReadlineInterface
  write: Write
  output: NodeJS.WritableStream
  logger: Logger
  environment: Record<string, string | undefined>
  configPath: string
  canPrompt: boolean
  /** See `FinishWithCliSessionOptions.httpMode`. */
  httpMode: boolean
}

async function finishWithPersonalAccessToken(options: FinishWithTokenOptions): Promise<number> {
  const environmentToken = options.environment[PERSONAL_ACCESS_TOKEN_ENVIRONMENT_VARIABLE]
  const tokenFromEnvironment =
    environmentToken !== undefined && environmentToken.trim() !== '' ? environmentToken.trim() : null

  let personalAccessToken = tokenFromEnvironment

  options.write('Personal Access Token')

  if (personalAccessToken === null) {
    options.write('  This route reads your whole home, its sensor history and its energy use. It cannot create')
    options.write('  flows, because Athom withholds that scope from tokens like this one.')
    options.write()
    options.write('  1. Open this page and sign in with your Athom account:')
    options.write(`       ${PERSONAL_ACCESS_TOKEN_URL}`)
    options.write('  2. Create a Personal Access Token.')
    options.write('  3. Copy it and paste it below. It will not be shown as you type.')
    options.write()

    if (!options.canPrompt) {
      options.write('  This terminal cannot prompt for input, so setup cannot continue here.')
      options.write()
      options.write(`  Run setup again in an interactive terminal, or set ${PERSONAL_ACCESS_TOKEN_ENVIRONMENT_VARIABLE}`)
      options.write('  in the environment and run it again.')
      return 1
    }

    personalAccessToken = await askSecret(options.readlineInterface, options.output, '  Personal Access Token: ')
    options.write()
  } else {
    options.write(`  Using the token from ${PERSONAL_ACCESS_TOKEN_ENVIRONMENT_VARIABLE}.`)
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

  options.write('Checking the connection')
  options.write('  Connecting to your Homey and reading its identity back...')
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

  if (!options.httpMode) printClientInstructions(options.write)
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

function reportIdentity(write: Write, identity: VerifiedIdentity): void {
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
  write: Write,
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

async function reportAddresses(write: Write, homey: CloudHomey): Promise<void> {
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

function printClientInstructions(write: Write): void {
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

/**
 * Asks a yes or no question.
 *
 * `assumeYes` comes from `--yes` and only ever answers questions where yes is
 * the constructive answer. The one destructive question setup asks, whether to
 * replace credentials that already work, does not pass it.
 *
 * A question is never put to a terminal that cannot answer it. Measured:
 * `readline`'s `question` on an input stream that has already ended does not
 * resolve, does not reject and does not time out, so asking anyway is not a
 * defensive default, it is a hang. `setup` piped into anything, or run from a
 * process manager, would have stopped there forever.
 */
async function askYesNo(
  session: SetupSession,
  question: string,
  defaultAnswer: boolean,
  assumeYes = false,
): Promise<boolean> {
  // Both answers below are printed with the reason they were taken. A run whose
  // transcript silently skips the questions leaves whoever reads it later unable
  // to tell which decisions were made on their behalf.
  if (assumeYes) {
    session.write(`${question} yes, because --yes was given.`)
    return true
  }

  if (!session.canPrompt) {
    session.write(`${question} ${defaultAnswer ? 'yes' : 'no'}, the default: there is no terminal to ask.`)
    return defaultAnswer
  }

  const suffix = defaultAnswer ? '[Y/n]' : '[y/N]'
  for (;;) {
    const answer = (await session.readlineInterface.question(`${question} ${suffix} `)).trim().toLowerCase()
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
