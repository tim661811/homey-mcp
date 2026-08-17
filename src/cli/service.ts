// The per-user service that keeps `serve --http` alive.
//
// This exists because of one measured fact that no document states: no MCP
// client ever starts an HTTP MCP server. `claude mcp add-json` strips `command`
// and `args` from an http entry, and a hand-written entry carrying both spawned
// nothing and left the port unbound. So the HTTP mode's failure state is not "a
// lapsed session", it is "the daemon is not running", and the client shows that
// as a red cross saying it could not connect.
//
// A terminal window is a worse supervisor than the client that starts the stdio
// server today, which is why this mode is not shipped as "run it in a terminal".
//
// Two rules from CLAUDE.md shape the writing half. Nothing is installed without
// an explicit yes, and the exact file is shown first, which is what
// `installHomeyCli` already does. And the definition names the absolute path of
// the Node running now rather than `node`, for the reason this project already
// paid for once: a service manager starts a process with its own environment and
// nvm is not on it.

import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { httpAuthStatePath, readStoredApprovalCode } from '../http/authStore.js'
import { createHttpEndpointConfig, DEFAULT_HTTP_PORT, LOOPBACK_HOST } from '../http/config.js'
import { readFlagValue } from './flags.js'

const runCommand = promisify(execFile)

export type ServiceVerb = 'install' | 'status' | 'uninstall'

/** Which supervisor this machine has, which is a different question from which platform it is. */
export type ServiceKind = 'systemd_user' | 'launchd_agent' | 'unsupported'

export interface ServiceOptions {
  verb: ServiceVerb
  argv?: string[]
  environment?: Record<string, string | undefined>
  homeDirectory?: string
  output?: NodeJS.WritableStream
  input?: NodeJS.ReadableStream & { isTTY?: boolean }
  /** Overridden by tests. Defaults to the absolute path of the Node running now. */
  nodePath?: string
  /** Overridden by tests. Defaults to this package's own entry point. */
  entryPointPath?: string
}

export interface ServiceDefinition {
  kind: ServiceKind
  /** Where the definition goes, or null when this machine has no supervisor to write one for. */
  path: string | null
  /** The file's whole contents, shown before it is written. */
  contents: string
  /** What the user would run to reach the same state by hand. */
  activationCommands: string[][]
  port: number
}

export async function runService(options: ServiceOptions): Promise<number> {
  const output = options.output ?? process.stdout
  const write = (line = ''): void => {
    output.write(`${line}\n`)
  }
  const argv = options.argv ?? []
  const homeDirectory = options.homeDirectory ?? homedir()
  const portFlag = readFlagValue(argv, '--port')
  const port = portFlag === null ? DEFAULT_HTTP_PORT : Number.parseInt(portFlag, 10)

  const definition = buildServiceDefinition({
    port,
    homeDirectory,
    nodePath: options.nodePath ?? process.execPath,
    entryPointPath: options.entryPointPath ?? defaultEntryPointPath(),
  })

  switch (options.verb) {
    case 'install':
      return await install(definition, { ...options, write, homeDirectory })
    case 'status':
      return await reportStatus(definition, {
        write,
        homeDirectory,
        environment: options.environment ?? process.env,
      })
    case 'uninstall':
      return await uninstall(definition, { ...options, write })
  }
}

/** The definition this machine would get, without writing anything. Exported for `doctor` and tests. */
export function buildServiceDefinition(options: {
  port: number
  homeDirectory: string
  nodePath: string
  entryPointPath: string
  platformName?: NodeJS.Platform
}): ServiceDefinition {
  const platformName = options.platformName ?? platform()
  const { port, homeDirectory, nodePath, entryPointPath } = options

  if (platformName === 'darwin') {
    return {
      kind: 'launchd_agent',
      path: join(homeDirectory, 'Library', 'LaunchAgents', 'dev.homey-mcp.plist'),
      contents: launchAgentPlist({ nodePath, entryPointPath, port }),
      activationCommands: [
        ['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 0}`, join(homeDirectory, 'Library', 'LaunchAgents', 'dev.homey-mcp.plist')],
      ],
      port,
    }
  }

  if (platformName === 'linux') {
    const path = join(homeDirectory, '.config', 'systemd', 'user', 'homey-mcp.service')
    return {
      kind: 'systemd_user',
      path,
      contents: systemdUnit({ nodePath, entryPointPath, port }),
      activationCommands: [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', '--now', 'homey-mcp'],
      ],
      port,
    }
  }

  return { kind: 'unsupported', path: null, contents: '', activationCommands: [], port }
}

function systemdUnit(options: { nodePath: string; entryPointPath: string; port: number }): string {
  return [
    '[Unit]',
    'Description=homey-mcp, the Homey MCP server, on loopback HTTP',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${options.nodePath} ${options.entryPointPath} serve --http --port ${options.port}`,
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

function launchAgentPlist(options: { nodePath: string; entryPointPath: string; port: number }): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>dev.homey-mcp</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${options.nodePath}</string>`,
    `    <string>${options.entryPointPath}</string>`,
    '    <string>serve</string>',
    '    <string>--http</string>',
    '    <string>--port</string>',
    `    <string>${options.port}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

type Write = (line?: string) => void

async function install(
  definition: ServiceDefinition,
  options: ServiceOptions & { write: Write; homeDirectory: string },
): Promise<number> {
  const { write } = options

  if (definition.kind === 'unsupported' || definition.path === null) {
    write()
    write(await unsupportedExplanation(definition.port))
    write()
    return 1
  }

  if (definition.kind === 'systemd_user' && !(await hasSystemdUserManager())) {
    // WSL only has systemd when `systemd=true` is set in /etc/wsl.conf. Writing
    // a unit file that nothing will ever read is worse than saying so: the user
    // would then have a service that reports installed and never starts.
    write()
    write('This Linux has no per-user systemd, so a unit file here would never be read.')
    write('That is the usual state inside WSL unless "systemd=true" is set in /etc/wsl.conf.')
    write()
    write(await unsupportedExplanation(definition.port))
    write()
    return 1
  }

  write()
  write(`This will write ${definition.path}:`)
  write()
  for (const line of definition.contents.split('\n')) write(`  ${line}`)
  write('and then run:')
  for (const command of definition.activationCommands) write(`  ${command.join(' ')}`)
  write()

  const approved = await confirm(options, 'Write it and start the service?')
  if (!approved) {
    write('Nothing was written.')
    return 1
  }

  await mkdir(dirname(definition.path), { recursive: true })
  await writeFile(definition.path, definition.contents, { mode: 0o644 })
  write(`Written to ${definition.path}.`)

  for (const command of definition.activationCommands) {
    const [program = '', ...commandArguments] = command
    try {
      await runCommand(program, commandArguments)
    } catch (error: unknown) {
      write()
      write(`"${command.join(' ')}" failed: ${describeCommandFailure(error)}`)
      write('The file is written, so running that command by hand is all that is left.')
      return 1
    }
  }

  write('The service is enabled and running.')
  write()
  write(`Point your assistant at http://${LOOPBACK_HOST}:${definition.port}/mcp and it will ask you to`)
  write('approve it once in your browser.')
  if (definition.kind === 'systemd_user') {
    write()
    write('This starts when you log in. To have it run without you being logged in:')
    write(`  loginctl enable-linger ${process.env['USER'] ?? '<your user>'}`)
  }
  write()
  return 0
}

async function reportStatus(
  definition: ServiceDefinition,
  context: { write: Write; homeDirectory: string; environment: Record<string, string | undefined> },
): Promise<number> {
  const { write } = context
  // Four separate questions, because somebody who is stuck needs to know which
  // one failed. "It does not work" has four different fixes here.
  write()
  write('The homey-mcp HTTP service')
  write()

  const definitionExists = definition.path !== null && (await fileExists(definition.path))
  write(`  definition:  ${definition.path === null ? 'not supported on this platform' : definitionExists ? definition.path : `not written (${definition.path})`}`)

  const supervisorState = definitionExists ? await readSupervisorState(definition) : 'not installed'
  write(`  supervisor:  ${supervisorState}`)

  const config = createHttpEndpointConfig({ port: definition.port })
  const listening = await portAnswers(config.port)
  write(`  port ${String(definition.port).padEnd(6)} ${listening ? 'answering' : 'silent'}`)
  write(`  address:     ${config.mcpUrl.href}`)

  // Printed here because this is the one command that reads a mode 0600 file in
  // the owner's own config directory, which is exactly the boundary the code
  // stands in for: on a platform where the kernel will not say which account a
  // loopback connection came from, being able to read this file IS the proof
  // that you are the owner. Read and never written, because a second process
  // that writes it clobbers what the running server holds in memory.
  const approvalCode = await readStoredApprovalCode(
    httpAuthStatePath({ port: definition.port, environment: context.environment, homeDirectory: context.homeDirectory }),
  )
  if (approvalCode !== null) {
    write(`  approval code: ${approvalCode}`)
    write('               Asked for on the sign-in page only when this computer cannot say which')
    write('               account opened it. On Linux it never is.')
  }
  write()

  // The port travels with every command this prints. Without it somebody running
  // on another port is sent to install a second service on 8431, and two servers
  // are exactly what the per-port state file exists to keep apart.
  const portArgument = definition.port === DEFAULT_HTTP_PORT ? '' : ` --port ${definition.port}`

  if (!definitionExists) {
    write(`Run "npx homey-mcp service install${portArgument}" to write it.`)
    write()
    return 1
  }
  if (!listening) {
    write('The service is installed but nothing is answering on the port, so your assistant will')
    write(`show a red cross. Run "npx homey-mcp doctor --http${portArgument}" for the whole picture.`)
    write()
    return 1
  }

  write()
  return 0
}

async function uninstall(
  definition: ServiceDefinition,
  options: ServiceOptions & { write: Write },
): Promise<number> {
  const { write } = options

  if (definition.path === null || !(await fileExists(definition.path))) {
    write()
    write('There is no service definition to remove.')
    write()
    return 0
  }

  write()
  write(`This will stop the service and delete ${definition.path}.`)
  write()
  const approved = await confirm(options, 'Remove it?')
  if (!approved) {
    write('Nothing was removed.')
    return 1
  }

  for (const command of deactivationCommands(definition)) {
    const [program = '', ...commandArguments] = command
    // A supervisor that already forgot the unit is not a failure worth stopping
    // for: the file is about to go either way.
    await runCommand(program, commandArguments).catch(() => undefined)
  }
  await rm(definition.path, { force: true })

  write(`Removed ${definition.path}.`)
  write()
  write('Your assistant\'s HTTP entry now points at nothing, so remove it too:')
  write('  claude mcp remove homey-http')
  write()
  return 0
}

function deactivationCommands(definition: ServiceDefinition): string[][] {
  if (definition.kind === 'systemd_user') {
    return [['systemctl', '--user', 'disable', '--now', 'homey-mcp']]
  }
  if (definition.kind === 'launchd_agent' && definition.path !== null) {
    return [['launchctl', 'bootout', `gui/${process.getuid?.() ?? 0}`, definition.path]]
  }
  return []
}

async function readSupervisorState(definition: ServiceDefinition): Promise<string> {
  try {
    if (definition.kind === 'systemd_user') {
      const { stdout } = await runCommand('systemctl', ['--user', 'is-active', 'homey-mcp'])
      return stdout.trim()
    }
    if (definition.kind === 'launchd_agent') {
      const { stdout } = await runCommand('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/dev.homey-mcp`])
      return /state = running/.test(stdout) ? 'running' : 'loaded but not running'
    }
  } catch (error: unknown) {
    // `systemctl is-active` exits non-zero for every state that is not active,
    // and its stdout is still the answer, so the failure is read rather than
    // reported as one.
    const stdout = (error as { stdout?: unknown }).stdout
    if (typeof stdout === 'string' && stdout.trim() !== '') return stdout.trim()
    return 'could not be asked'
  }
  return 'unknown'
}

/** True when something is listening. Not a health check: an answer of any kind counts. */
async function portAnswers(port: number, timeoutMs = 1_500): Promise<boolean> {
  const { connect } = await import('node:net')
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host: LOOPBACK_HOST, port })
    const settle = (answer: boolean): void => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

async function hasSystemdUserManager(): Promise<boolean> {
  try {
    await runCommand('systemctl', ['--user', 'is-system-running'])
    return true
  } catch (error: unknown) {
    // A degraded or starting system still has a user manager, and `is-system-running`
    // exits non-zero for both. Only a missing manager prints nothing usable.
    const stdout = (error as { stdout?: unknown }).stdout
    return typeof stdout === 'string' && stdout.trim() !== ''
  }
}

/**
 * What to do on a platform with no supervisor this command writes for.
 *
 * Windows is the honest gap. A Scheduled Task at logon would work, but this
 * project's maintainer cannot test one, and a service command that half works on
 * a platform nobody verified is exactly the kind of thing that turns into an
 * unreproducible bug report.
 */
async function unsupportedExplanation(port: number): Promise<string> {
  return [
    'There is no supervised HTTP mode for this platform yet, so it has to be started by hand:',
    '',
    `  npx homey-mcp serve --http --port ${port}`,
    '',
    'It has to keep running for your assistant to reach it. On Windows, a Scheduled Task at',
    'logon running that command does the job; it is not written here because nobody has',
    'verified one on real hardware.',
    '',
    'The stdio mode needs none of this and is what "npx homey-mcp setup" sets up.',
  ].join('\n')
}

async function confirm(options: ServiceOptions & { write: Write }, question: string): Promise<boolean> {
  const argv = options.argv ?? []
  if (argv.includes('--yes') || argv.includes('-y')) {
    options.write(`${question} yes, because --yes was given.`)
    return true
  }

  const input = options.input ?? process.stdin
  if (input.isTTY !== true) {
    // `readline`'s `question` never resolves on a stream that has ended: not a
    // rejection, not a timeout, it simply stays pending forever. So a piped or
    // service-run invocation must not ask.
    options.write(`${question} no, the default: there is no terminal to ask.`)
    return false
  }

  const readlineInterface = createInterface({ input, output: options.output ?? process.stdout, terminal: true })
  try {
    for (;;) {
      const answer = (await readlineInterface.question(`${question} [y/N] `)).trim().toLowerCase()
      if (answer === '') return false
      if (answer === 'y' || answer === 'yes') return true
      if (answer === 'n' || answer === 'no') return false
    }
  } finally {
    readlineInterface.close()
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

function describeCommandFailure(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr
  if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim()
  return error instanceof Error ? error.message : String(error)
}

/** The installed `dist/index.js`, resolved from this module rather than guessed. */
function defaultEntryPointPath(): string {
  return fileURLToPath(new URL('../index.js', import.meta.url))
}
