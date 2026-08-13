// Finding and driving the official Homey CLI.
//
// WHY THIS IS ALLOWED HERE, AND NOWHERE ELSE.
//
// An earlier review rejected shelling out to the Homey CLI to refresh an expired
// token, and that judgement stands. That path was invisible to the user, ran
// automatically, and depended on an undocumented side effect of a command whose
// documented job is something else. If it broke, it broke silently, on a
// schedule nobody chose.
//
// This module is the opposite on every one of those counts. It runs only from
// `homey-mcp setup`, only after the user answered a question, only to do the
// thing the CLI documents itself as doing (log in, list Homeys, select one), and
// with its output on the user's screen while it happens. `serve` never calls any
// of it, and `doctor` only reads the filesystem. So: do not "consistently" route
// this through some automatic path later, and do not add a second caller that
// runs without a person watching.
//
// THREE MEASURED FACTS THAT BREAK THE OBVIOUS IMPLEMENTATION.
//
// 1. `which homey` is the wrong test. On the machine this was developed on the
//    CLI is installed and logged in, and is on no PATH at all: it lives in the
//    npx cache because it has only ever been run as `npx homey`. Detection
//    therefore covers PATH, the global npm root and the npx cache, and reports
//    which of the three answered.
//
// 2. `npx --no-install homey` does not resolve that cache entry. npm keys the
//    cache by a hash of the literal package spec, so `homey@latest` and `homey`
//    are two different directories, and only the one that was actually invoked
//    is populated. On the development machine `npx --no-install homey` failed
//    with "missing packages" while `homey@latest` sat fully installed one
//    directory away. So the cache is scanned directly and the executable is
//    invoked by path, through this same Node, which also sidesteps shebang and
//    cmd-shim differences between platforms.
//
// 3. `homey whoami` is NOT a safe read when nobody is logged in. With no stored
//    session it starts the interactive login: it prints a URL, opens a local
//    callback server and blocks on "Paste the code:" forever. Closing stdin does
//    not end it. So the login check reads the CLI's own settings file first and
//    only spawns `whoami` when a session is actually stored there, in which case
//    an invalid token exits 1 with a JSON error instead of prompting. Every
//    spawn additionally carries a timeout, because a user who walks away from a
//    browser tab must not leave setup hanging.

import { spawn } from 'node:child_process'
import { constants as fileSystemConstants } from 'node:fs'
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { homeyCliSettingsCandidates } from './credentials.js'
import { asRecord } from '../util/coerce.js'
import type { Logger } from '../util/log.js'
import { redactString } from '../util/redact.js'

/** The npm package the official CLI ships as. */
export const HOMEY_CLI_PACKAGE_NAME = 'homey'

/** Printed verbatim before it is ever run, so nobody is surprised by what it does. */
export const HOMEY_CLI_INSTALL_COMMAND = 'npm install --global homey'

/** Where an Athom account signs the CLI in. Named in messages so a reader knows what opens. */
export const HOMEY_CLI_LOGIN_COMMAND = 'homey login'

/**
 * How long a captured, non-interactive CLI call may take.
 *
 * Every one of them makes an Athom cloud round trip, so this is generous
 * compared to the measured second or so, and short enough that a hung call is
 * reported rather than waited on.
 */
export const CAPTURED_RUN_TIMEOUT_MS = 30_000

/** A login involves opening a browser and signing in, so it gets minutes rather than seconds. */
export const INTERACTIVE_RUN_TIMEOUT_MS = 5 * 60_000

/** A cold global install pulls a large dependency tree over the network. */
export const INSTALL_TIMEOUT_MS = 5 * 60_000

/** How long a process gets to end after SIGTERM before it is killed outright. */
const FORCED_KILL_DELAY_MS = 5_000

/** Where the CLI was found. Reported rather than reduced to a boolean, because the fix differs per case. */
export type HomeyCliLocationKind = 'path' | 'global_npm' | 'npx_cache' | 'npx_on_demand'

export interface HomeyCliInstallation {
  kind: HomeyCliLocationKind
  /**
   * The executable this resolves to. Absolute, so it carries the account name of
   * whoever is running this and must never reach a shared report. Null for the
   * on-demand npx route, which resolves nothing until it runs.
   */
  path: string | null
  /** argv[0] for the spawn. */
  command: string
  /** Fixed arguments that come before the CLI's own subcommand. */
  commandArguments: string[]
  /**
   * True only when the executable is a Windows shim that cannot be spawned
   * directly. Everything else runs without a shell.
   */
  shell: boolean
  /** Read from the package manifest, never by running the CLI. Null when no manifest was found. */
  version: string | null
  /** Where it was found, in words and with no filesystem path in it. Safe to paste in public. */
  where: string
}

export interface FindHomeyCliOptions {
  environment?: Record<string, string | undefined>
  homeDirectory?: string
  platform?: NodeJS.Platform
  /** The Node that will run the CLI script. Defaults to the one running this process. */
  nodeExecutablePath?: string
  logger?: Logger
  /**
   * Ask npm where its global root is when the derived locations came up empty.
   * One extra subprocess, so callers that must stay cheap can turn it off.
   */
  probeNpmGlobalRoot?: boolean
  /** Injected by tests so a search never touches the real filesystem. */
  fileSystem?: HomeyCliFileSystem
  /** Injected by tests so the npm probe never spawns. */
  runCommand?: CommandRunner
}

/** The filesystem surface a search needs. Small on purpose: a test implements it in a few lines. */
export interface HomeyCliFileSystem {
  isFile(path: string): Promise<boolean>
  isExecutable(path: string): Promise<boolean>
  listDirectory(path: string): Promise<string[]>
  readJson(path: string): Promise<unknown>
  resolveRealPath(path: string): Promise<string>
}

/**
 * Finds the official CLI, or returns null.
 *
 * Order is PATH, then the global npm root, then the npx cache, then npm's own
 * answer for where the global root is. A CLI that is both globally installed
 * under a prefix only npm knows about and present in the npx cache is reported
 * as the npx cache one. Both invocations work, so the only cost of that is a
 * slightly less precise sentence, which is not worth a second subprocess on
 * every run to avoid.
 */
export async function findHomeyCli(options: FindHomeyCliOptions = {}): Promise<HomeyCliInstallation | null> {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const fileSystem = options.fileSystem ?? realFileSystem
  const nodeExecutablePath = options.nodeExecutablePath ?? process.execPath
  const context: SearchContext = { environment, platform, fileSystem, nodeExecutablePath }

  const onPath = await findOnPath(context, options.logger)
  if (onPath !== null) return onPath

  for (const root of derivedGlobalRoots(context)) {
    const found = await installationFromPackageDirectory(context, join(root, HOMEY_CLI_PACKAGE_NAME), 'global_npm')
    if (found !== null) return found
  }

  const inNpxCache = await findInNpxCache(context)
  if (inNpxCache !== null) return inNpxCache

  if (options.probeNpmGlobalRoot === true) {
    const root = await askNpmForGlobalRoot(context, options.runCommand, options.logger)
    if (root !== null) {
      const found = await installationFromPackageDirectory(context, join(root, HOMEY_CLI_PACKAGE_NAME), 'global_npm')
      if (found !== null) return found
    }
  }

  return null
}

/**
 * The CLI run straight from the registry, without installing anything durable.
 *
 * This is the route offered when a global install is refused or impossible: npm
 * downloads the package into its own cache for the duration and needs no write
 * access outside it. It costs a download on first use, so it is never preferred
 * over something already on the machine.
 */
export function npxHomeyCli(options: { platform?: NodeJS.Platform } = {}): HomeyCliInstallation {
  const platform = options.platform ?? process.platform
  return {
    kind: 'npx_on_demand',
    path: null,
    command: 'npx',
    // `--yes` is not a hidden consent: this installation is only ever built
    // after the user chose the npx route over a global install.
    commandArguments: ['--yes', HOMEY_CLI_PACKAGE_NAME],
    // npm ships as npm.cmd on Windows, which Node refuses to spawn directly.
    shell: platform === 'win32',
    version: null,
    where: describeLocationKind('npx_on_demand'),
  }
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

export type HomeyCliRunOutcome = 'completed' | 'timed_out' | 'spawn_failed'

export interface HomeyCliRunResult {
  outcome: HomeyCliRunOutcome
  /** Null when the process was killed or never started. */
  exitCode: number | null
  signal: NodeJS.Signals | null
  /** Empty for an interactive run: its output went straight to the terminal. */
  stdout: string
  stderr: string
  durationMs: number
  /** What happened, in one sentence a user can act on. Carries no secret. */
  message: string
}

export interface RunHomeyCliOptions {
  environment?: Record<string, string | undefined>
  timeoutMs?: number
  logger?: Logger
  /** Injected by tests. Defaults to a real spawn. */
  runCommand?: CommandRunner
}

/**
 * Runs a CLI subcommand and captures its output.
 *
 * Never use this for anything that may prompt. See the note at the top about
 * `homey whoami` on a machine with no stored session.
 */
export async function runHomeyCli(
  installation: HomeyCliInstallation,
  commandArguments: string[],
  options: RunHomeyCliOptions = {},
): Promise<HomeyCliRunResult> {
  return await runCommandWith(options.runCommand, {
    command: installation.command,
    commandArguments: [...installation.commandArguments, ...commandArguments],
    shell: installation.shell,
    mode: 'capture',
    label: describeCommand(commandArguments),
    timeoutMs: options.timeoutMs ?? CAPTURED_RUN_TIMEOUT_MS,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
}

/**
 * Runs a CLI subcommand with this process's own stdin, stdout and stderr.
 *
 * Inherited rather than piped because the interesting commands are
 * conversations: `homey login` prints a URL, opens a browser and waits for the
 * user to come back. Scraping that exchange, or trying to drive it, would mean
 * handling somebody's Athom credential inside this process, which is precisely
 * what using the official tool avoids. So the user talks to Athom's tool
 * directly and this process only learns the exit code.
 *
 * The timeout is what keeps an abandoned login from hanging setup forever.
 */
export async function runInteractive(
  installation: HomeyCliInstallation,
  commandArguments: string[],
  options: RunHomeyCliOptions = {},
): Promise<HomeyCliRunResult> {
  return await runCommandWith(options.runCommand, {
    command: installation.command,
    commandArguments: [...installation.commandArguments, ...commandArguments],
    shell: installation.shell,
    mode: 'inherit',
    label: describeCommand(commandArguments),
    timeoutMs: options.timeoutMs ?? INTERACTIVE_RUN_TIMEOUT_MS,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
}

// ---------------------------------------------------------------------------
// Login state
// ---------------------------------------------------------------------------

export interface HomeyCliLoginState {
  loggedIn: boolean
  /**
   * The account the CLI reports, when it was asked. Personal data: it must not
   * reach a shared report, and it is only ever shown in the user's own terminal.
   */
  account: string | null
  /** True when a session is stored but Athom refused it, which needs a fresh login rather than a first one. */
  sessionRejected: boolean
  /** True when the answer came from the CLI's stored session rather than from Athom. */
  fromStoredSessionOnly: boolean
  /** What was checked and what it said. Carries no token. */
  detail: string
}

export interface IsLoggedInOptions {
  environment?: Record<string, string | undefined>
  homeDirectory?: string
  logger?: Logger
  timeoutMs?: number
  /**
   * Ask Athom whether the stored session is still good. Off by default: the
   * stored session answers "is this CLI signed in" on its own, and confirming it
   * costs a subprocess and a network round trip.
   */
  confirmWithAthom?: boolean
  runCommand?: CommandRunner
  /** Injected by tests so the CLI's settings file can be a fixture. */
  readSettings?: () => Promise<HomeyCliStoredState | null>
}

/**
 * Whether the CLI has a login, cheaply and without ever prompting.
 *
 * The stored session is the source of truth for the question "is this CLI signed
 * in", and reading it cannot hang, cannot rate limit the hub and cannot open a
 * browser. `homey whoami --json` is only run on top of that, and only when asked
 * for, because on a machine with no session at all it starts an interactive
 * login and blocks forever.
 */
export async function isLoggedIn(
  installation: HomeyCliInstallation | null,
  options: IsLoggedInOptions = {},
): Promise<HomeyCliLoginState> {
  const stored = await (options.readSettings ?? (() => readHomeyCliStoredState(options)))()

  if (stored === null || !stored.hasCloudToken) {
    return {
      loggedIn: false,
      account: null,
      sessionRejected: false,
      fromStoredSessionOnly: true,
      detail: 'The Homey CLI has no stored session on this machine, so nobody has run "homey login" here yet.',
    }
  }

  if (options.confirmWithAthom !== true || installation === null) {
    return {
      loggedIn: true,
      account: null,
      sessionRejected: false,
      fromStoredSessionOnly: true,
      detail: 'The Homey CLI has a stored session.',
    }
  }

  const result = await runHomeyCli(installation, ['whoami', '--json'], {
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand }),
  })

  const payload = asRecord(parseJsonOrNull(result.stdout))
  const reportedError = typeof payload?.['error'] === 'string' ? (payload['error'] as string) : null

  if (result.outcome !== 'completed' || result.exitCode !== 0 || reportedError !== null) {
    return {
      loggedIn: false,
      account: null,
      // A stored session that Athom refuses is a different problem from never
      // having logged in, and it has a different sentence attached to it.
      sessionRejected: true,
      fromStoredSessionOnly: false,
      detail:
        reportedError === null
          ? `The Homey CLI has a stored session, but checking it failed: ${result.message}`
          : `The Homey CLI has a stored session, but Athom refused it: ${redactString(reportedError)}`,
    }
  }

  const email = typeof payload?.['email'] === 'string' ? (payload['email'] as string) : null
  return {
    loggedIn: true,
    account: email,
    sessionRejected: false,
    fromStoredSessionOnly: false,
    detail: email === null ? 'Athom confirmed the stored session.' : `Athom confirmed the session for ${email}.`,
  }
}

// ---------------------------------------------------------------------------
// Which Homey is active
// ---------------------------------------------------------------------------

export interface HomeyCliHomey {
  id: string
  name: string | null
  softwareVersion: string | null
  state: string | null
}

export type HomeyCliSelectionStatus =
  | 'selected'
  | 'none_selected'
  | 'none_available'
  | 'unknown'

export interface HomeyCliSelection {
  status: HomeyCliSelectionStatus
  selected: HomeyCliHomey | null
  /** Everything the account can reach. Empty when the list could not be read, which `status` distinguishes. */
  available: HomeyCliHomey[]
  detail: string
}

export interface GetSelectedHomeyOptions {
  environment?: Record<string, string | undefined>
  logger?: Logger
  timeoutMs?: number
  runCommand?: CommandRunner
}

/**
 * Which Homey the CLI is pointed at, and which ones it could be pointed at.
 *
 * Measured, and contrary to what the obvious reading of the CLI's help
 * suggests: `homey list --json` returns every Homey on the account and marks
 * none of them as active, so it cannot answer this on its own. The active one
 * comes from `homey select current --json`, which prints a bare `null` and exits
 * 0 when nothing is selected. An account with two Homeys and no selection is
 * therefore an ordinary, silent state rather than an error, and it is exactly
 * the state that leaves this server unable to decide which house it is talking
 * about.
 */
export async function getSelectedHomey(
  installation: HomeyCliInstallation,
  options: GetSelectedHomeyOptions = {},
): Promise<HomeyCliSelection> {
  const runOptions: RunHomeyCliOptions = {
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand }),
  }

  const currentResult = await runHomeyCli(installation, ['select', 'current', '--json'], runOptions)
  const listResult = await runHomeyCli(installation, ['list', '--json'], runOptions)

  const selected = toHomey(parseJsonOrNull(currentResult.stdout))
  const listed = parseJsonOrNull(listResult.stdout)
  const available = Array.isArray(listed)
    ? listed.map(toHomey).filter((entry): entry is HomeyCliHomey => entry !== null)
    : []

  const currentFailed = currentResult.outcome !== 'completed' || currentResult.exitCode !== 0
  const listFailed = listResult.outcome !== 'completed' || listResult.exitCode !== 0

  if (selected !== null) {
    return {
      status: 'selected',
      selected,
      available,
      detail: `The Homey CLI is pointed at ${selected.name ?? selected.id}.`,
    }
  }

  if (currentFailed) {
    return {
      status: 'unknown',
      selected: null,
      available,
      detail: `Asking the Homey CLI which Homey is selected failed: ${currentResult.message}`,
    }
  }

  if (available.length === 0) {
    return {
      status: listFailed ? 'unknown' : 'none_available',
      selected: null,
      available,
      detail: listFailed
        ? `Listing the Homeys on this account failed: ${listResult.message}`
        : 'This Athom account has no Homey on it.',
    }
  }

  return {
    status: 'none_selected',
    selected: null,
    available,
    detail: `The Homey CLI knows about ${available.length} Homeys and none of them is selected.`,
  }
}

/** Points the CLI at one Homey. Non-interactive: the id comes from a list the user already chose from. */
export async function selectHomeyWithCli(
  installation: HomeyCliInstallation,
  homeyId: string,
  options: GetSelectedHomeyOptions = {},
): Promise<HomeyCliRunResult> {
  return await runHomeyCli(installation, ['select', '--id', homeyId], {
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand }),
  })
}

// ---------------------------------------------------------------------------
// Installing it
// ---------------------------------------------------------------------------

export type InstallFailureReason = 'not_confirmed' | 'permission_denied' | 'network' | 'timed_out' | 'unknown'

export interface InstallHomeyCliResult {
  installed: boolean
  reason: InstallFailureReason | null
  /** The exact command that was run, so the user can repeat or adapt it. */
  command: string
  /** What happened and what to do about it. Never npm's raw output. */
  message: string
}

export interface InstallHomeyCliOptions {
  /**
   * Must be true. This is a hard gate rather than a default, because a global
   * install writes outside the project and can need elevated permissions.
   */
  confirmed: boolean
  environment?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  logger?: Logger
  timeoutMs?: number
  runCommand?: CommandRunner
}

/**
 * Installs the CLI globally, and only ever after an explicit yes.
 *
 * A global install is the one step here that changes something outside this
 * project, so the confirmation is a parameter rather than a convention: a caller
 * that forgets to ask gets a refusal, not an install.
 *
 * npm's own failure output is not passed through. "EACCES: permission denied,
 * mkdir '/usr/lib/node_modules'" followed by forty lines of stack is a true
 * description of a problem the user cannot act on, so the specific case is
 * detected and answered with the two things that actually fix it.
 */
export async function installHomeyCli(options: InstallHomeyCliOptions): Promise<InstallHomeyCliResult> {
  const platform = options.platform ?? process.platform

  if (options.confirmed !== true) {
    return {
      installed: false,
      reason: 'not_confirmed',
      command: HOMEY_CLI_INSTALL_COMMAND,
      message: 'Nothing was installed: this install was never confirmed.',
    }
  }

  const result = await runCommandWith(options.runCommand, {
    command: 'npm',
    commandArguments: ['install', '--global', HOMEY_CLI_PACKAGE_NAME],
    // npm is npm.cmd on Windows, which Node refuses to spawn without a shell.
    shell: platform === 'win32',
    mode: 'capture',
    label: HOMEY_CLI_INSTALL_COMMAND,
    timeoutMs: options.timeoutMs ?? INSTALL_TIMEOUT_MS,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })

  if (result.outcome === 'completed' && result.exitCode === 0) {
    return {
      installed: true,
      reason: null,
      command: HOMEY_CLI_INSTALL_COMMAND,
      message: 'The Homey CLI is installed.',
    }
  }

  const reason = classifyInstallFailure(result)
  return {
    installed: false,
    reason,
    command: HOMEY_CLI_INSTALL_COMMAND,
    message: explainInstallFailure(reason, result),
  }
}

function classifyInstallFailure(result: HomeyCliRunResult): InstallFailureReason {
  if (result.outcome === 'timed_out') return 'timed_out'
  const output = `${result.stdout}\n${result.stderr}`
  // Only the machine-readable npm error codes are matched. npm's prose is
  // translated on some systems, and the hub next door already taught this
  // project what matching English sentences costs.
  if (/\b(?:EACCES|EPERM|EROFS)\b/.test(output)) return 'permission_denied'
  if (/\b(?:ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH)\b/.test(output)) return 'network'
  if (result.outcome === 'spawn_failed') return 'unknown'
  return 'unknown'
}

function explainInstallFailure(reason: InstallFailureReason, result: HomeyCliRunResult): string {
  switch (reason) {
    case 'permission_denied':
      return [
        `"${HOMEY_CLI_INSTALL_COMMAND}" was refused because this Node cannot write to its global folder.`,
        'That usually means Node was installed by the system package manager rather than for your account.',
        'Two ways forward, neither of which needs this to be solved right now:',
        '  - run the same command with elevated permissions yourself, or',
        '  - point npm at a folder you own: "npm config set prefix ~/.npm-global", then add ~/.npm-global/bin to your PATH.',
        'Or skip installing it altogether and let npx download it when needed.',
      ].join('\n')
    case 'network':
      return `"${HOMEY_CLI_INSTALL_COMMAND}" could not reach the npm registry. Check the network or a proxy setting and try again.`
    case 'timed_out':
      return `"${HOMEY_CLI_INSTALL_COMMAND}" was still running after ${Math.round(result.durationMs / 1000)} seconds and was stopped. Run it yourself in a terminal to see where it gets stuck.`
    default:
      return `"${HOMEY_CLI_INSTALL_COMMAND}" failed: ${result.message} Run it yourself in a terminal to see npm's own output.`
  }
}

// ---------------------------------------------------------------------------
// The CLI's stored state, read straight from its settings file
// ---------------------------------------------------------------------------

export interface HomeyCliStoredState {
  /** The settings file this came from. An absolute path, so it stays out of shared reports. */
  path: string
  hasCloudToken: boolean
  activeHomeyId: string | null
  activeHomeyName: string | null
  /** How many Homeys the CLI has a stored session for. Two with no active one is the ambiguous case. */
  storedHomeyCount: number
}

/**
 * Reads the CLI's settings file, read-only and without spawning anything.
 *
 * This is what lets `doctor` report the CLI situation for the price of one file
 * read: no subprocess, no cloud round trip, and no chance of the interactive
 * login being triggered from inside a running MCP server.
 *
 * The candidate paths come from `credentials.ts`, which owns that knowledge.
 * Only the two fields this question needs are read here, and unlike
 * `readHomeyCliSession` this never throws: an unreadable or half-written file is
 * a thing to report, not a reason for a diagnostic to fail.
 */
export async function readHomeyCliStoredState(
  options: { environment?: Record<string, string | undefined>; homeDirectory?: string } = {},
): Promise<HomeyCliStoredState | null> {
  for (const path of homeyCliSettingsCandidates(options)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      continue
    }

    const settings = asRecord(parsed)
    const homeyApi = asRecord(settings?.['homeyApi'])
    if (homeyApi === null) continue

    const activeHomey = asRecord(settings?.['activeHomey'])
    const token = asRecord(homeyApi['token'])

    return {
      path,
      hasCloudToken: typeof token?.['access_token'] === 'string' && token['access_token'] !== '',
      activeHomeyId: typeof activeHomey?.['id'] === 'string' ? (activeHomey['id'] as string) : null,
      activeHomeyName: typeof activeHomey?.['name'] === 'string' ? (activeHomey['name'] as string) : null,
      storedHomeyCount: Object.keys(homeyApi).filter((key) => key.startsWith('homey-')).length,
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Searching the filesystem
// ---------------------------------------------------------------------------

interface SearchContext {
  environment: Record<string, string | undefined>
  platform: NodeJS.Platform
  fileSystem: HomeyCliFileSystem
  nodeExecutablePath: string
}

async function findOnPath(context: SearchContext, logger?: Logger): Promise<HomeyCliInstallation | null> {
  const rawPath = context.environment['PATH'] ?? context.environment['Path'] ?? ''
  const directories = rawPath.split(delimiter).filter((entry) => entry.trim() !== '')
  const names = context.platform === 'win32' ? ['homey.cmd', 'homey.exe', 'homey'] : ['homey']

  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (!(await context.fileSystem.isExecutable(candidate))) continue

      const resolved = await resolveShim(context, candidate, 'path')
      if (resolved !== null) return resolved

      // A shim whose package could not be located still runs. Reported without
      // a version rather than skipped, because "installed but I cannot read its
      // version" is a much better answer than "not installed".
      logger?.debug('Found a Homey CLI shim whose package manifest could not be read', { name })
      return {
        kind: 'path',
        path: candidate,
        command: candidate,
        commandArguments: [],
        shell: context.platform === 'win32',
        version: null,
        where: 'on your PATH',
      }
    }
  }

  return null
}

/**
 * Turns an executable on PATH into the package it belongs to.
 *
 * npm puts a symlink (or on Windows a generated .cmd) in a bin directory, so the
 * thing found on PATH is rarely the script itself. Following it and walking up
 * to the owning package.json is what yields both a version and a script this
 * process's own Node can run directly.
 */
async function resolveShim(
  context: SearchContext,
  shimPath: string,
  kind: HomeyCliLocationKind,
): Promise<HomeyCliInstallation | null> {
  let scriptPath: string
  try {
    scriptPath = await context.fileSystem.resolveRealPath(shimPath)
  } catch {
    return null
  }

  let directory = dirname(scriptPath)
  // Bounded rather than walked to the filesystem root: the manifest of a package
  // is at most a couple of levels above its bin script, and an unbounded walk
  // would happily read a package.json belonging to something else entirely.
  for (let depth = 0; depth < 4; depth += 1) {
    const found = await installationFromPackageDirectory(context, directory, kind)
    if (found !== null) return found
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  return null
}

async function installationFromPackageDirectory(
  context: SearchContext,
  packageDirectory: string,
  kind: HomeyCliLocationKind,
): Promise<HomeyCliInstallation | null> {
  let manifest: unknown
  try {
    manifest = await context.fileSystem.readJson(join(packageDirectory, 'package.json'))
  } catch {
    return null
  }

  const record = asRecord(manifest)
  if (record === null || record['name'] !== HOMEY_CLI_PACKAGE_NAME) return null

  const relativeScript = binScriptFromManifest(record)
  if (relativeScript === null) return null

  const scriptPath = join(packageDirectory, relativeScript)
  if (!(await context.fileSystem.isFile(scriptPath))) return null

  return {
    kind,
    path: scriptPath,
    // Run through this process's own Node rather than through the script's
    // shebang or a Windows shim. The Node running this was already checked to be
    // new enough, and it is the one arrangement that behaves the same on every
    // platform.
    command: context.nodeExecutablePath,
    commandArguments: [scriptPath],
    shell: false,
    version: typeof record['version'] === 'string' ? (record['version'] as string) : null,
    where: describeLocationKind(kind),
  }
}

function binScriptFromManifest(manifest: Record<string, unknown>): string | null {
  const bin = manifest['bin']
  if (typeof bin === 'string') return bin
  const record = asRecord(bin)
  const named = record?.[HOMEY_CLI_PACKAGE_NAME]
  return typeof named === 'string' ? named : null
}

/**
 * Where a global install lands, worked out without asking npm.
 *
 * npm answers this authoritatively but costs a subprocess of several hundred
 * milliseconds, and these two cover nvm, a system Node, Homebrew and Windows.
 * `findHomeyCli` falls back to asking npm only when everything else missed.
 */
function derivedGlobalRoots(context: SearchContext): string[] {
  const roots: string[] = []
  const prefix = context.environment['npm_config_prefix']
  if (prefix !== undefined && prefix.trim() !== '') {
    roots.push(context.platform === 'win32' ? join(prefix.trim(), 'node_modules') : join(prefix.trim(), 'lib', 'node_modules'))
  }

  const nodeDirectory = dirname(context.nodeExecutablePath)
  roots.push(
    context.platform === 'win32' ? join(nodeDirectory, 'node_modules') : join(nodeDirectory, '..', 'lib', 'node_modules'),
  )

  return roots
}

/**
 * Scans npm's npx cache.
 *
 * This is the case that a `which homey` check gets wrong, and it is not exotic:
 * anybody who has only ever run `npx homey ...` has the CLI here and nowhere
 * else. npm keys each entry by a hash of the literal package spec, so `homey`
 * and `homey@latest` are different directories and only the spec that was
 * actually invoked is populated. Hashing the spec ourselves would therefore find
 * an empty directory, which is what `npx --no-install homey` does. Every entry
 * is scanned instead, and the newest version wins when several are present.
 */
async function findInNpxCache(context: SearchContext): Promise<HomeyCliInstallation | null> {
  const cacheDirectory = join(npmCacheDirectory(context), '_npx')

  let entries: string[]
  try {
    entries = await context.fileSystem.listDirectory(cacheDirectory)
  } catch {
    return null
  }

  const found: HomeyCliInstallation[] = []
  for (const entry of entries) {
    const installation = await installationFromPackageDirectory(
      context,
      join(cacheDirectory, entry, 'node_modules', HOMEY_CLI_PACKAGE_NAME),
      'npx_cache',
    )
    if (installation !== null) found.push(installation)
  }

  if (found.length === 0) return null
  return found.reduce((best, candidate) => (compareVersions(candidate.version, best.version) > 0 ? candidate : best))
}

function npmCacheDirectory(context: SearchContext): string {
  const configured = context.environment['npm_config_cache']
  if (configured !== undefined && configured.trim() !== '') return configured.trim()

  if (context.platform === 'win32') {
    const localAppData = context.environment['LOCALAPPDATA']
    if (localAppData !== undefined && localAppData.trim() !== '') return join(localAppData.trim(), 'npm-cache')
  }

  return join(context.environment['HOME'] ?? homedir(), '.npm')
}

async function askNpmForGlobalRoot(
  context: SearchContext,
  runCommand: CommandRunner | undefined,
  logger?: Logger,
): Promise<string | null> {
  const result = await runCommandWith(runCommand, {
    command: 'npm',
    commandArguments: ['root', '-g'],
    shell: context.platform === 'win32',
    mode: 'capture',
    label: 'npm root -g',
    timeoutMs: CAPTURED_RUN_TIMEOUT_MS,
    environment: context.environment,
    ...(logger === undefined ? {} : { logger }),
  })

  if (result.outcome !== 'completed' || result.exitCode !== 0) return null
  const root = result.stdout.trim().split('\n').pop()?.trim() ?? ''
  return root === '' ? null : root
}

/** Compares two version strings numerically. A missing version sorts lowest. */
function compareVersions(left: string | null, right: string | null): number {
  if (left === right) return 0
  if (left === null) return -1
  if (right === null) return 1

  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10))
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10))
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] ?? 0
    const rightPart = rightParts[index] ?? 0
    if (Number.isNaN(leftPart) || Number.isNaN(rightPart)) return 0
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1
  }
  return 0
}

/** The only description of a location that ever leaves this module: words, never a path. */
function describeLocationKind(kind: HomeyCliLocationKind): string {
  switch (kind) {
    case 'path':
      return 'on your PATH'
    case 'global_npm':
      return 'installed globally with npm'
    case 'npx_cache':
      return 'in the npx cache'
    case 'npx_on_demand':
      return 'downloaded on demand by npx'
  }
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

export interface CommandRequest {
  command: string
  commandArguments: string[]
  shell: boolean
  /** `capture` pipes stdout and stderr back; `inherit` gives the child this process's terminal. */
  mode: 'capture' | 'inherit'
  /** Names the command in messages, for example `homey login`. Carries no secret. */
  label: string
  timeoutMs: number
  environment?: Record<string, string | undefined>
  logger?: Logger
}

/** Everything that spawns goes through one of these, so a test never starts a process. */
export type CommandRunner = (request: CommandRequest) => Promise<HomeyCliRunResult>

async function runCommandWith(runner: CommandRunner | undefined, request: CommandRequest): Promise<HomeyCliRunResult> {
  return await (runner ?? spawnCommand)(request)
}

/**
 * Spawns a command and always resolves.
 *
 * A rejected promise here would mean the caller has to translate an exception
 * into a sentence at every call site, and the interesting outcomes are not
 * exceptional: a non-zero exit is how "not logged in" arrives, and a timeout is
 * how "the user walked away from the browser tab" arrives.
 *
 * The timeout is enforced here rather than through `spawn`'s own `timeout`
 * option so the child gets a chance to shut down cleanly first. A CLI killed
 * outright mid-write can leave its settings file truncated, and that file is one
 * this project promised never to damage.
 */
async function spawnCommand(request: CommandRequest): Promise<HomeyCliRunResult> {
  const startedAt = Date.now()

  return await new Promise<HomeyCliRunResult>((resolve) => {
    let settled = false
    let timedOut = false
    let stdout = ''
    let stderr = ''

    const child = spawn(request.command, request.commandArguments, {
      shell: request.shell,
      stdio: request.mode === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: (request.environment ?? process.env) as NodeJS.ProcessEnv,
    })

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })

    const forcedKill = setTimeout(() => {
      child.kill('SIGKILL')
    }, request.timeoutMs + FORCED_KILL_DELAY_MS)

    const timer = setTimeout(() => {
      timedOut = true
      request.logger?.warn(`"${request.label}" did not finish in time and is being stopped`)
      child.kill('SIGTERM')
    }, request.timeoutMs)

    const finish = (result: HomeyCliRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(forcedKill)
      resolve(result)
    }

    child.on('error', (error: Error) => {
      finish({
        outcome: 'spawn_failed',
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        message: `"${request.label}" could not be started: ${redactString(error.message)}`,
      })
    })

    child.on('close', (code, signal) => {
      const durationMs = Date.now() - startedAt
      if (timedOut) {
        finish({
          outcome: 'timed_out',
          exitCode: null,
          signal,
          stdout,
          stderr,
          durationMs,
          message: `"${request.label}" was still running after ${Math.round(request.timeoutMs / 1000)} seconds and was stopped.`,
        })
        return
      }

      finish({
        outcome: 'completed',
        exitCode: code,
        signal,
        stdout,
        stderr,
        durationMs,
        message:
          code === 0
            ? `"${request.label}" finished.`
            : `"${request.label}" exited with code ${code ?? 'unknown'}${signal === null ? '' : ` after ${signal}`}.`,
      })
    })
  })
}

/**
 * The real filesystem.
 *
 * Behind a small interface so a test can search a made-up tree. Every method
 * answers rather than throws where "no" is a meaningful answer, because a
 * missing directory is the normal case in a search.
 */
const realFileSystem: HomeyCliFileSystem = {
  async isFile(path) {
    try {
      return (await stat(path)).isFile()
    } catch {
      return false
    }
  },
  async isExecutable(path) {
    try {
      // The execute bit is meaningless on Windows, where being on PATH with a
      // known extension is what makes something runnable.
      if (process.platform === 'win32') return (await stat(path)).isFile()
      await access(path, fileSystemConstants.X_OK)
      return true
    } catch {
      return false
    }
  },
  async listDirectory(path) {
    return await readdir(path)
  },
  async readJson(path) {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  },
  async resolveRealPath(path) {
    return await realpath(path)
  },
}

function toHomey(value: unknown): HomeyCliHomey | null {
  const record = asRecord(value)
  const id = record?.['id']
  if (typeof id !== 'string' || id === '') return null
  return {
    id,
    name: typeof record?.['name'] === 'string' ? (record['name'] as string) : null,
    softwareVersion: typeof record?.['softwareVersion'] === 'string' ? (record['softwareVersion'] as string) : null,
    state: typeof record?.['state'] === 'string' ? (record['state'] as string) : null,
  }
}

/** JSON or null. The CLI prints a bare `null` for "nothing selected", which parses to exactly that. */
function parseJsonOrNull(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function describeCommand(commandArguments: string[]): string {
  return `homey ${commandArguments.join(' ')}`.trim()
}
