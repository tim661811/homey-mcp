// The check that turns "it does not work" into "here is the line to run".
//
// Every check answers three questions: what was tested, what happened, and what
// to do about it. A check that reports a failure without naming a fix has moved
// the problem rather than solved it, so `fix` is only null when the check passed.
//
// This module owns the checks for BOTH doctors. `doctor` on the command line and
// the `homey_doctor` tool used to build their own lists, and they disagreed about
// the same hub in ways a user could see side by side: a probe that merely failed
// was a warning in one and a failure in the other, and the flow counts were
// shaped differently. Everything a check decides is therefore decided here once,
// and the tool differs from the terminal only in `forSharing`.
//
// `forSharing` is the privacy boundary, and it is a requirement rather than a
// formatting preference. The maintainer has exactly one Homey, so both GitHub
// issue templates ask users to paste a report about hardware nobody here can
// test. A shared report therefore carries the hardware model, the API
// generation, the firmware, the probe verdicts and the scale of the home, and
// never a LAN address, an Athom cloud id or a filesystem path. The terminal
// report keeps all of it, because it stays on the machine that ran it.

import { readFile } from 'node:fs/promises'

import { createHomeCache } from '../homey/cache.js'
import type { HomeCache } from '../homey/cache.js'
import { connectToHomey, disconnectFromHomey, hubAddressCachePath, normaliseSystemInfo } from '../homey/connect.js'
import type { HomeyConnectionWithDiagnostics, HubAddresses } from '../homey/connect.js'
import type { ResolvedCredentials } from '../homey/credentials.js'
import { isSessionExpired, resolveCredentials, storedCredentialsPath } from '../homey/credentials.js'
import { buildAddressCandidates, probeAddresses } from '../homey/discovery.js'
import { classifyError } from '../homey/errors.js'
import { findHomeyCli, HOMEY_CLI_INSTALL_COMMAND, readHomeyCliStoredState } from '../homey/homey-cli.js'
import type { HomeyCliInstallation, HomeyCliStoredState } from '../homey/homey-cli.js'
import { detectCapabilities } from '../homey/registry.js'
import type {
  AddressProbeResult,
  CapabilityProbeStatus,
  CapabilityRegistry,
  DoctorCheck,
  DoctorStatus,
  HomeyAddressKind,
  HomeyConnection,
} from '../homey/types.js'
import { readPackageMetadata } from '../server/createServer.js'
import { formatValue, renderKeyValueLines, renderTextBlock } from '../server/render.js'
import { asString } from '../util/coerce.js'
import type { Logger } from '../util/log.js'
import { createLogger } from '../util/log.js'
import { readFlagValue } from './flags.js'
import { MINIMUM_NODE_MAJOR_VERSION } from './node-version.js'

export { MINIMUM_NODE_MAJOR_VERSION } from './node-version.js'

/**
 * Below this the hub starts killing apps under load.
 *
 * Measured on the 2019 generation: 1 GB total with roughly 41 MB free at rest, so
 * this is a warning threshold rather than a fault, and the note says as much.
 */
const LOW_FREE_MEMORY_BYTES = 25 * 1024 * 1024

export type { DoctorCheck, DoctorStatus } from '../homey/types.js'

export interface DoctorHardware {
  modelId: string
  modelName: string
  softwareVersion: string
  platformVersion: number
  dialect: string
  addressKind: string
  timezone: string
  language: string
}

export interface DoctorInventory {
  devices: number | null
  unavailableDevices: number | null
  zones: number | null
  /** Every flow the hub has. `standardFlows` and `advancedFlows` are the two halves of it, not two more collections. */
  flows: number | null
  standardFlows: number | null
  advancedFlows: number | null
  brokenFlows: number | null
  /** False means `brokenFlows` was never measured: the V2 firmware drops the flag, so zero would be an invention. */
  brokenFlowsReported: boolean
  flowCards: number | null
  insightsLogs: number | null
  logicVariables: number | null
}

/**
 * What the official Homey CLI situation is, as far as reading the filesystem can
 * tell.
 *
 * Nothing here spawns a process. Both doctors report the same facts because both
 * read the same two things: where the CLI is installed, and what its own
 * settings file says. `setup` goes further and asks Athom, because a person is
 * sitting there waiting for the answer; a diagnostic that runs inside a live MCP
 * server has no business starting subprocesses, and `homey whoami` on a machine
 * with no stored session opens an interactive login that never returns.
 */
export interface DoctorHomeyCli {
  found: boolean
  /** Where it was found, in words. Never a filesystem path, so it is safe to share. */
  where: string | null
  version: string | null
  /** Whether the CLI has a stored session. Whether that session still works is what the checks below test. */
  loggedIn: boolean
  homeySelected: boolean
  /** Withheld from a shared report: the name of a Homey is the name of a household. */
  selectedHomeyName: string | null
  /** How many Homeys the CLI holds a session for. Two with none selected is the state that needs fixing. */
  storedHomeyCount: number
}

export interface DoctorReport {
  generatedAt: string
  serverVersion: string
  nodeVersion: string
  ok: boolean
  checks: DoctorCheck[]
  credentialSource: string | null
  connectionRoute: string | null
  /** Reduced to the kind, the timing and the status code when `forSharing` is set. */
  addresses: AddressProbeResult[]
  hardware: DoctorHardware | null
  capabilities: CapabilityRegistry | null
  inventory: DoctorInventory | null
  homeyCli: DoctorHomeyCli | null
}

export interface CollectDoctorReportOptions {
  environment?: Record<string, string | undefined>
  logger?: Logger
  /** An open connection to reuse. Supplied by the running server so `doctor` costs no second login. */
  connection?: HomeyConnection
  capabilities?: CapabilityRegistry
  cache?: HomeCache
  configPath?: string
  /** Skip the collection counts. They cost one request each and are not needed to diagnose a failure. */
  skipInventory?: boolean
  /** Ask the hub for memory, uptime and its own Node version. One request. Defaults to true. */
  includeSystem?: boolean
  /** Report the live request queue. Only meaningful inside a running server, so it is off by default. */
  includeQueue?: boolean
  /**
   * Report where the official Homey CLI is and what it is signed in to. Reads
   * two files and spawns nothing, so it is on by default. Defaults to true.
   */
  includeHomeyCli?: boolean
  /**
   * Produce a report that is safe to paste in public.
   *
   * No check detail, no fix and no address entry then carries a LAN address, an
   * Athom cloud id or a filesystem path. Set by the `homey_doctor` tool, whose
   * output lands in conversation history forever, and by `doctor --report`.
   */
  forSharing?: boolean
  /** Injected by tests so the address probes never leave the machine. Defaults to the global fetch. */
  fetchImplementation?: typeof fetch
  /** Injected by tests that need a connection to succeed without a hub. Defaults to `connectToHomey`. */
  connectImplementation?: typeof connectToHomey
  now?: () => Date
}

/**
 * Runs every check and returns the report.
 *
 * The `homey_doctor` tool calls this with the server's own connection, cache and
 * capability registry, so both doctors reach their verdicts through the same
 * code and cannot contradict each other about the same hub.
 */
export async function collectDoctorReport(options: CollectDoctorReportOptions = {}): Promise<DoctorReport> {
  const environment = options.environment ?? process.env
  const now = options.now ?? (() => new Date())
  const logger = options.logger ?? createLogger({ scope: 'doctor', environment, level: 'error' })
  const forSharing = options.forSharing === true

  const checks: DoctorCheck[] = []
  const report: DoctorReport = {
    generatedAt: now().toISOString(),
    serverVersion: readPackageMetadata().version,
    nodeVersion: process.versions.node,
    ok: false,
    checks,
    credentialSource: null,
    connectionRoute: null,
    addresses: [],
    hardware: null,
    capabilities: null,
    inventory: null,
    homeyCli: null,
  }

  checks.push(checkNodeVersion(forSharing))

  // Before the connection rather than after it, because this is the check that
  // explains an empty credentials store. Someone who has never set anything up
  // reads "the Homey CLI is not installed" above the failure to connect, which
  // is the order the two facts actually relate in.
  if (options.includeHomeyCli !== false) {
    const homeyCli = await inspectHomeyCli(environment, logger)
    report.homeyCli = forSharing ? withheldHomeyCliDetail(homeyCli.report) : homeyCli.report
    checks.push(homeyCli.check)
  }

  // A connection handed in by the caller has already proved every step below, so
  // the checks that would repeat that work are reported from what the connection
  // recorded rather than run a second time against a hub that rate limits.
  const reusedConnection = options.connection ?? null
  let openedConnection: HomeyConnectionWithDiagnostics | null = null

  try {
    let connection: HomeyConnection
    let diagnostics: RecordedDiagnostics | null

    if (reusedConnection === null) {
      const credentials: ResolvedCredentials = await resolveCredentials({
        environment,
        logger,
        ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      })
      report.credentialSource = forSharing
        ? describeCredentialSourceKind(credentials.sourceDescription)
        : credentials.sourceDescription
      checks.push(checkCredentials(credentials, environment, forSharing))

      report.addresses = await probeKnownAddresses(credentials, environment, logger, options.fetchImplementation)
      // Pushed before the connection is attempted, because a connection that
      // fails is exactly when this check is the diagnosis, and because the
      // failure below is titled after the last check that ran.
      const addressCheckIndex = checks.push(checkAddresses(report.addresses)) - 1

      const connect = options.connectImplementation ?? connectToHomey
      openedConnection = await connect(credentials, {
        logger,
        ...(options.fetchImplementation === undefined ? {} : { fetchImplementation: options.fetchImplementation }),
      })
      connection = openedConnection
      diagnostics = readDiagnostics(openedConnection)
      report.connectionRoute = diagnostics?.route ?? null

      // On a first run the cache is empty, so the only candidate above was the
      // cloud rung and the check concluded "only the cloud address answered,
      // move onto the Homey's network" directly above a connection reporting
      // localSecure over that very network. Connecting is the step that learns
      // the LAN addresses and writes them to the cache, so re-probing once the
      // connection has settled on a local rung is what makes the two agree.
      // Reading the cache alone fixed the second run onwards, and the first run
      // is exactly when someone reads this advice.
      if (reachedLocalRung(openedConnection) && !sawReachableLocalRung(report.addresses)) {
        report.addresses = await probeKnownAddresses(credentials, environment, logger, options.fetchImplementation)
        checks[addressCheckIndex] = checkAddresses(report.addresses)
      }
      if (report.addresses.length === 0 && diagnostics !== null) report.addresses = diagnostics.probes
    } else {
      connection = reusedConnection
      diagnostics = readDiagnostics(reusedConnection)
      report.connectionRoute = diagnostics?.route ?? null
      report.credentialSource = describeCredentialSourceKind(diagnostics?.credentialSource ?? null)
      checks.push(checkRecordedCredentialSource(report.credentialSource))

      // The probes the running server made on its way in. They are the only
      // address evidence a reused connection has, and without them this report
      // would have nothing to say about the route at all.
      if (diagnostics !== null && diagnostics.probes.length > 0) {
        report.addresses = diagnostics.probes
        checks.push(checkAddresses(report.addresses))
      }
    }

    checks.push(checkConnection(connection, report.connectionRoute))
    checks.push(checkDialect(connection, diagnostics?.dialectEvidence ?? null))

    report.hardware = describeHardware(connection)
    checks.push(checkHardware(connection))
    checks.push(checkIdentity(connection))

    if (options.includeSystem !== false) checks.push(await checkSystem(connection))

    const capabilities =
      options.capabilities ?? (await detectCapabilities(connection, { logger: logger.child('capabilities') }))
    report.capabilities = capabilities
    checks.push(...buildCapabilityChecks(capabilities))

    if (options.includeQueue === true) checks.push(checkQueue(connection))

    if (options.skipInventory !== true) {
      const cache = options.cache ?? createHomeCache(connection, { logger: logger.child('cache'), capabilities })
      const inventory = await collectInventory(cache, capabilities)
      report.inventory = inventory.counts
      checks.push(inventory.check)
    }
  } catch (error) {
    const failure = classifyError(error, { operation: 'doctor' })
    checks.push({
      id: failureCheckId(checks),
      title: failureCheckTitle(checks),
      status: 'fail',
      detail: failure.message,
      fix: fixForReason(failure.reason),
    })
  } finally {
    if (openedConnection !== null) await disconnectFromHomey(openedConnection)
  }

  if (forSharing) report.addresses = report.addresses.map(withheldAddressDetail)

  report.ok = checks.every((check) => check.status !== 'fail')
  return report
}

export interface RunDoctorOptions {
  argv?: string[]
  environment?: Record<string, string | undefined>
  logger?: Logger
  output?: NodeJS.WritableStream
}

/** The `doctor` subcommand. Returns the process exit code: 0 when nothing failed. */
export async function runDoctor(options: RunDoctorOptions = {}): Promise<number> {
  const argv = options.argv ?? []
  const output = options.output ?? process.stdout
  const asJson = argv.includes('--json')
  const asCompatibilityReport = argv.includes('--report')
  const configPath = readFlagValue(argv, '--config')

  const report = await collectDoctorReport({
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(configPath === null ? {} : { configPath }),
    skipInventory: argv.includes('--quick'),
    includeSystem: !argv.includes('--quick'),
    // Collected scrubbed rather than scrubbed at the last moment, so `--report`
    // cannot leak through a field a later check adds and this renderer forgets.
    forSharing: asCompatibilityReport,
  })

  if (asJson) {
    output.write(`${JSON.stringify(report, null, 2)}\n`)
  } else if (asCompatibilityReport) {
    output.write(`${renderCompatibilityReport(report)}\n`)
  } else {
    output.write(`${renderDoctorText(report)}\n`)
  }

  return report.ok ? 0 : 1
}

/** The human-readable report. One block per check, then the facts, then what to paste. */
export function renderDoctorText(report: DoctorReport): string {
  const checkLines = report.checks.map((check) => {
    const lines = [`${statusMarker(check.status)} ${check.title}`, `    ${check.detail}`]
    if (check.fix !== null) lines.push(`    Fix: ${check.fix}`)
    return lines.join('\n')
  })

  const packageName = readPackageMetadata().name

  return renderTextBlock([
    `homey-mcp doctor  (server ${report.serverVersion}, Node ${report.nodeVersion})`,
    { lines: checkLines },
    report.hardware === null
      ? null
      : {
          heading: 'Homey',
          lines: renderKeyValueLines([
            ['model', `${report.hardware.modelName} (${report.hardware.modelId})`],
            ['firmware', report.hardware.softwareVersion],
            ['API generation', report.hardware.dialect === 'v2' ? 'V2' : 'V3'],
            ['platform version', report.hardware.platformVersion],
            ['reached over', report.hardware.addressKind],
            ['timezone', report.hardware.timezone],
            ['language', report.hardware.language === '' ? 'not reported' : report.hardware.language],
          ]),
        },
    report.homeyCli === null
      ? null
      : {
          heading: 'Homey CLI',
          lines: renderKeyValueLines([
            ['installed', report.homeyCli.found ? (report.homeyCli.where ?? 'yes') : 'no'],
            ['version', report.homeyCli.version ?? 'not readable'],
            ['signed in', report.homeyCli.loggedIn ? 'yes' : 'no'],
            [
              'active Homey',
              report.homeyCli.homeySelected ? (report.homeyCli.selectedHomeyName ?? 'one is selected') : 'none selected',
            ],
          ]),
        },
    report.addresses.length === 0
      ? null
      : {
          heading: 'Addresses',
          lines: report.addresses.map(
            (address) =>
              `  ${address.kind.padEnd(12)} ${address.reachable ? `answered in ${address.durationMs} ms` : (address.error ?? 'no answer')}`,
          ),
        },
    report.inventory === null
      ? null
      : {
          heading: 'What is on it',
          lines: renderKeyValueLines([
            ['devices', describeDeviceCount(report.inventory)],
            ['zones', report.inventory.zones],
            // One line, because two adjacent lines read as two disjoint
            // collections and the advanced flows are part of the total.
            ['flows', describeFlowCount(report.inventory)],
            ['flow cards', report.inventory.flowCards],
            ['insights logs', report.inventory.insightsLogs],
            ['logic variables', report.inventory.logicVariables],
          ]),
        },
    {
      heading: report.ok ? 'Everything checks out. Add it to Claude Code with:' : 'Once the failures above are fixed, add it with:',
      lines: [`  claude mcp add --scope user --transport stdio homey -- npx -y ${packageName}@latest`],
    },
    report.ok
      ? null
      : 'Run "npx homey-mcp setup" to redo the credential step, or "npx homey-mcp doctor --report" to produce a scrubbed report for a bug report.',
  ])
}

/**
 * The version that is safe to paste in public.
 *
 * Includes what is needed to fix a bug on hardware that cannot be tested here,
 * and nothing that describes the household: no device or zone names, no
 * addresses, no identifiers, no credential paths.
 */
export function renderCompatibilityReport(report: DoctorReport): string {
  const lines: string[] = [
    '### homey-mcp compatibility report',
    '',
    `- server version: ${report.serverVersion}`,
    `- node: ${report.nodeVersion}`,
    `- generated: ${report.generatedAt}`,
  ]

  if (report.hardware !== null) {
    lines.push(
      `- model: ${report.hardware.modelName} (${report.hardware.modelId})`,
      `- firmware: ${report.hardware.softwareVersion}`,
      `- API generation: ${report.hardware.dialect === 'v2' ? 'V2' : 'V3'}`,
      `- platform version: ${report.hardware.platformVersion}`,
      `- reached over: ${report.hardware.addressKind}`,
    )
  } else {
    lines.push('- model: not reached, see the check results below')
  }

  // Which route the reporter authenticated by decides which code paths their
  // report exercised, and the CLI route is the only one that can write flows.
  // The version matters too: the CLI is a moving target this project does not
  // control. Neither the install path nor the Homey's name appears.
  if (report.homeyCli !== null) {
    lines.push(`- Homey CLI: ${describeHomeyCliForSharing(report.homeyCli)}`)
  }

  lines.push('', '#### Checks', '')
  for (const check of report.checks) {
    lines.push(`- ${check.status.toUpperCase()}: ${check.title}`)
  }

  if (report.capabilities !== null) {
    lines.push('', '#### Capability probes', '')
    for (const [name, outcome] of Object.entries(report.capabilities.probes ?? {})) {
      lines.push(`- ${name}: ${outcome.status} (${outcome.probe}, ${outcome.statusCode ?? 'no status'})`)
    }
    if (report.capabilities.notes.length > 0) {
      lines.push('', '#### Notes', '')
      for (const note of report.capabilities.notes) lines.push(`- ${note}`)
    }
  }

  if (report.inventory !== null) {
    // Counts only. How many devices a home has is a scale figure; which devices
    // it has is the household.
    lines.push(
      '',
      '#### Scale',
      '',
      `- devices: ${formatCount(report.inventory.devices)}`,
      `- zones: ${formatCount(report.inventory.zones)}`,
      `- flows: ${formatCount(report.inventory.flows)} (${formatCount(report.inventory.standardFlows)} standard, ${formatCount(report.inventory.advancedFlows)} advanced)`,
      `- flow cards: ${formatCount(report.inventory.flowCards)}`,
      `- insights logs: ${formatCount(report.inventory.insightsLogs)}`,
    )
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkNodeVersion(forSharing: boolean): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
  // The path Node was resolved from is what diagnoses "the wrong Node is on
  // PATH", and it carries the account name of whoever is running this.
  const resolvedFrom = forSharing ? '' : ` at ${process.execPath}`

  if (!Number.isNaN(major) && major >= MINIMUM_NODE_MAJOR_VERSION) {
    return {
      id: 'node',
      title: 'Node version',
      status: 'pass',
      detail: `Node ${process.versions.node}${resolvedFrom}.`,
      fix: null,
    }
  }

  return {
    id: 'node',
    title: 'Node version',
    status: 'fail',
    detail: `Node ${process.versions.node} is too old. This server and the Homey client library both need Node ${MINIMUM_NODE_MAJOR_VERSION} or newer.`,
    fix: forSharing
      ? `Install Node ${MINIMUM_NODE_MAJOR_VERSION} or newer and make sure it is the one on your PATH.`
      : `Install Node ${MINIMUM_NODE_MAJOR_VERSION} or newer and make sure it is the one on your PATH. Node was resolved from ${process.execPath}.`,
  }
}

interface HomeyCliInspection {
  check: DoctorCheck
  report: DoctorHomeyCli
}

/**
 * Reports the official Homey CLI: whether it is there, where, which version,
 * whether it holds a login and which Homey it points at.
 *
 * Never a failure, whatever it finds. This server runs perfectly well on a
 * Personal Access Token and `serve` never touches the CLI, so a missing CLI is a
 * missing capability (creating flows needs the root "homey" scope that Athom
 * only issues to its own first-party tool) rather than something being broken.
 *
 * `findHomeyCli` is called without the npm probe on purpose. Everything this
 * check does is a file read, which is what makes it safe to run from inside a
 * live MCP server on every `homey_doctor` call. `setup` turns the probe on,
 * because there a person is waiting and a wrong "not installed" costs them an
 * install they did not need.
 */
async function inspectHomeyCli(
  environment: Record<string, string | undefined>,
  logger: Logger,
): Promise<HomeyCliInspection> {
  const installation = await findHomeyCli({ environment, logger: logger.child('homey-cli') })
  const stored = await readHomeyCliStoredState({ environment })

  const report: DoctorHomeyCli = {
    found: installation !== null,
    where: installation?.where ?? null,
    version: installation?.version ?? null,
    loggedIn: stored?.hasCloudToken === true,
    homeySelected: stored?.activeHomeyId !== null && stored?.activeHomeyId !== undefined,
    selectedHomeyName: stored?.activeHomeyName ?? null,
    storedHomeyCount: stored?.storedHomeyCount ?? 0,
  }

  return { report, check: buildHomeyCliCheck(report, installation, stored) }
}

/**
 * Turns what was found into the check. Exported so the four states it
 * distinguishes can be tested without a machine that happens to be in one of
 * them, the same reason `buildCapabilityChecks` is exported.
 */
export function buildHomeyCliCheck(
  report: DoctorHomeyCli,
  installation: HomeyCliInstallation | null,
  stored: HomeyCliStoredState | null,
): DoctorCheck {
  const title = 'Homey CLI'
  const found = installation === null ? null : `Found ${installation.where}${installation.version === null ? '' : `, version ${installation.version}`}.`

  if (installation === null && !report.loggedIn) {
    return {
      id: 'homey-cli',
      title,
      status: 'warn',
      // Named in full, because "not on PATH" is the wrong summary: it is also
      // not in the global npm folder and not in the npx cache, and the last of
      // those is where it hides on a machine that only ever ran "npx homey".
      detail:
        'The official Homey CLI is not on your PATH, not installed globally with npm and not in the npx cache, and it has no stored login here.',
      fix: `Run "npx homey-mcp setup", which offers to install it and walks through signing in. Or do it yourself: "${HOMEY_CLI_INSTALL_COMMAND}" then "homey login". Without it this server still reads your home through a Personal Access Token, but it cannot create flows: Athom grants the root "homey" scope that flow writes need only to its own first-party tool.`,
    }
  }

  if (installation === null) {
    return {
      id: 'homey-cli',
      title,
      status: 'warn',
      detail:
        'A Homey CLI login is stored on this machine, but the CLI itself is no longer on your PATH, in the global npm folder or in the npx cache.',
      fix: `The stored session still works until it expires, and this server reads it directly. To refresh it later you will need the CLI back: "${HOMEY_CLI_INSTALL_COMMAND}".`,
    }
  }

  if (!report.loggedIn) {
    return {
      id: 'homey-cli',
      title,
      status: 'warn',
      detail: `${found} Nobody has signed in with it on this machine.`,
      fix: 'Run "homey login". That session is the only one that can create flows, and this server reads it fresh on every start rather than copying it.',
    }
  }

  if (!report.homeySelected) {
    const knownCount = stored?.storedHomeyCount ?? 0
    return {
      id: 'homey-cli',
      title,
      status: 'warn',
      detail: `${found} It has a stored login, but no Homey is selected${knownCount > 1 ? `, and it knows about ${knownCount}` : ''}.`,
      fix: 'Run "homey select" to choose which Homey this server should talk to. Until one is chosen there is no way to tell which house you mean.',
    }
  }

  return {
    id: 'homey-cli',
    title,
    status: 'pass',
    detail: `${found} It has a stored login and a selected Homey. Whether that session is still valid is what the credentials and connection checks report.`,
    fix: null,
  }
}

/** The Homey's name is the household's name, so a shared report says whether one is selected and not which. */
function withheldHomeyCliDetail(report: DoctorHomeyCli): DoctorHomeyCli {
  return { ...report, selectedHomeyName: null }
}

function checkCredentials(
  credentials: ResolvedCredentials,
  environment: Record<string, string | undefined>,
  forSharing: boolean,
): DoctorCheck {
  if (isSessionExpired(credentials)) {
    return {
      id: 'credentials',
      title: 'Credentials',
      status: 'fail',
      detail: forSharing
        ? 'A session was found, but it had already expired. Homey sessions last 24 hours.'
        : `Found ${credentials.sourceDescription}, but that session expired at ${credentials.sessionExpiresAt}. Homey sessions last 24 hours.`,
      // No restart in the instruction on purpose. A running server reads the
      // credential source again the moment Homey refuses a call, so the new
      // session is picked up by itself; telling someone to restart their
      // assistant's MCP server for something that fixes itself is busywork.
      fix: 'Run "homey login" to get a fresh session. A server that is already running signs in again by itself the next time Homey refuses a call.',
    }
  }

  // One of the source descriptions ends in the absolute path of the Homey CLI's
  // settings file, which carries the account name of whoever is running this.
  const source = forSharing ? describeCredentialSourceKind(credentials.sourceDescription) : credentials.sourceDescription
  const scopeNote =
    credentials.scopes.length === 0
      ? ''
      : credentials.scopes.includes('homey')
        ? ' It carries the root "homey" scope, so flow writes will work.'
        : ` It carries only these scopes: ${credentials.scopes.join(', ')}.`

  if (credentials.scopes.length > 0 && !credentials.scopes.includes('homey')) {
    return {
      id: 'credentials',
      title: 'Credentials',
      status: 'warn',
      detail: `Using ${source}.${scopeNote} Creating flows needs the root "homey" scope.`,
      fix: 'Run "homey login" with the Homey CLI, which issues a session with the root scope, then start this server again.',
    }
  }

  return {
    id: 'credentials',
    title: 'Credentials',
    status: 'pass',
    detail: forSharing
      ? `Using ${source}.${scopeNote}`
      : `Using ${source}.${scopeNote} Stored credentials, when present, live at ${storedCredentialsPath({ environment })}.`,
    fix: null,
  }
}

/** What a reused connection can say about its credential: the kind, never the description. */
function checkRecordedCredentialSource(kind: string | null): DoctorCheck {
  return {
    id: 'credentials',
    title: 'Credentials',
    status: kind === null ? 'warn' : 'pass',
    detail:
      kind === null
        ? 'This connection did not record which credential source it used.'
        : `Authenticated from ${kind}. Neither the credential nor the path it was read from is included here.`,
    fix:
      kind === null
        ? 'Restart the server so it reconnects through connectToHomey, which records the source. If sign-in keeps failing, run "homey login" and try again: sessions last 24 hours.'
        : null,
  }
}

function checkConnection(connection: HomeyConnection, route: string | null): DoctorCheck {
  return {
    id: 'connection',
    title: 'Connection to Homey',
    // The kind and the route, never the address. Which rung answered and how the
    // session was obtained are what diagnose a problem; where the hub lives on
    // someone's network diagnoses nothing.
    detail: `Connected over ${connection.identity.addressKind}, speaking the ${connection.dialect === 'v2' ? 'V2' : 'V3'} API${route === null ? '' : ` via the ${route} route`}.`,
    status: 'pass',
    fix: null,
  }
}

function checkDialect(connection: HomeyConnection, dialectEvidence: string | null): DoctorCheck {
  const evidence = dialectEvidence === null ? '' : ` Detected from: ${dialectEvidence}.`
  return {
    id: 'dialect',
    title: 'API dialect',
    status: 'pass',
    detail:
      connection.dialect === 'v2'
        ? `This Homey speaks the v2 API, which is the 2019 generation and older. Flow cards are sent as a separate owner URI and short id on the wire.${evidence}`
        : `This Homey speaks the v3 API, which is the 2023 generation and newer.${evidence} The v3 paths in this server are untested against real hardware, so please report anything that misbehaves.`,
    fix:
      connection.dialect === 'v3'
        ? 'If a tool fails on this hardware, include this whole report in the issue: it is the only way the v3 paths get real data.'
        : null,
  }
}

function checkHardware(connection: HomeyConnection): DoctorCheck {
  const tested = connection.identity.modelId === 'homey4d'
  return {
    id: 'hardware',
    title: 'Hardware support',
    status: tested ? 'pass' : 'warn',
    detail: tested
      ? `${connection.identity.modelName} is the hardware this project is developed and tested against.`
      : `${connection.identity.modelName} is supported but untested: every measured behaviour in this project came from a Homey Pro (Early 2019).`,
    fix: tested
      ? null
      : 'If something misbehaves, run "npx homey-mcp doctor --report" and open a compatibility issue with the output. That report is scrubbed of household data and is the only way this hardware gets fixed.',
  }
}

function checkIdentity(connection: HomeyConnection): DoctorCheck {
  const { identity } = connection
  const missingTimezone = identity.timezone === ''
  const missingLanguage = identity.language === ''

  // Named separately because they cost different things. A missing timezone
  // moves every calendar window in Insights; a missing language only decides
  // which language the hub words its own errors in. Listing both under one
  // consequence told a user with a reported timezone that "today" would land on
  // the wrong day.
  const consequences: string[] = []
  if (missingTimezone) {
    consequences.push(
      'Insights windows are cut in the hub\'s own timezone, so without one a calendar resolution such as "today" lands on the wrong day.',
    )
  }
  if (missingLanguage) {
    consequences.push(
      'The language is only used to explain that this hub answers its own errors in the household language, so this one costs little.',
    )
  }

  const missing = [...(missingTimezone ? ['timezone'] : []), ...(missingLanguage ? ['language'] : [])]

  return {
    id: 'identity',
    title: 'Hardware identity',
    status: missing.length === 0 ? 'pass' : 'warn',
    detail: `${identity.modelName} (${identity.modelId}) on firmware ${identity.softwareVersion}, platform version ${identity.platformVersion}, timezone ${identity.timezone || 'not reported'}, language ${identity.language || 'not reported'}.`,
    fix:
      missing.length === 0
        ? null
        : `Homey did not report its ${missing.join(' or ')}. ${consequences.join(' ')} Set the location and language in the Homey app under Settings, then restart this server.`,
  }
}

interface SystemManagers {
  system: { getInfo(): Promise<unknown> }
}

async function checkSystem(connection: HomeyConnection): Promise<DoctorCheck> {
  const managers = connection.api as SystemManagers
  try {
    const info = normaliseSystemInfo(await connection.request(() => managers.system.getInfo(), 'system.getInfo', true))
    const freeMemoryBytes = info.freeMemoryBytes
    const isLow = freeMemoryBytes !== null && freeMemoryBytes < LOW_FREE_MEMORY_BYTES

    return {
      id: 'system',
      title: 'Homey system resources',
      status: isLow ? 'warn' : 'pass',
      detail: `${formatMegabytes(freeMemoryBytes)} free of ${formatMegabytes(info.totalMemoryBytes)}, up ${formatDuration(info.uptimeSeconds)}, running Node ${info.nodeVersion ?? 'unknown'}.`,
      fix: isLow
        ? 'Free memory is low. Homey restarts apps under memory pressure, which shows up as devices briefly going unavailable. Consider removing an unused app, and keep requests to this server modest.'
        : null,
    }
  } catch (error) {
    const failure = classifyError(error, { operation: 'system.getInfo' })
    return {
      id: 'system',
      title: 'Homey system resources',
      // A warning rather than a failure on purpose. Memory and uptime are
      // diagnostics about the hub, so losing them says nothing about whether the
      // server works, and failing the whole report over them would send a user
      // chasing a problem that is not there.
      status: 'warn',
      detail: failure.message,
      fix: 'This is diagnostics only, so the rest of the server still works. Ask again without the system section to skip it, or run doctor again if the hub was simply busy.',
    }
  }
}

function checkQueue(connection: HomeyConnection): DoctorCheck {
  const { queue } = connection
  const isBacklogged = queue.queued > 10

  return {
    id: 'queue',
    title: 'Request queue',
    status: isBacklogged ? 'warn' : 'pass',
    detail: `${queue.inFlight} requests in flight, ${queue.queued} waiting. Homey rate limits its own local API after a handful of rapid requests, so this server sends at most two at a time with a minimum spacing between them.`,
    fix: isBacklogged
      ? 'A long queue means answers will be slow. Wait for it to drain rather than issuing more tool calls, and prefer one broad call such as homey_home_overview over many narrow ones.'
      : null,
  }
}

interface CapabilityExplanation {
  title: string
  /** What the caller loses while this capability is not available. Read as a clause, so it starts lowercase. */
  consequence: string
}

const CAPABILITY_EXPLANATIONS: Record<string, CapabilityExplanation> = {
  advancedFlow: {
    title: 'Advanced Flow',
    consequence: 'the advanced flow tools are not registered, so only standard flows can be created or edited',
  },
  energyReports: {
    title: 'Historical energy reports',
    consequence:
      'historical energy has to come from Insights instead: meter_power is cumulative so take deltas, measure_power is instantaneous so integrate over time',
  },
  energyLive: {
    title: 'Live energy report',
    consequence: 'homey_energy_live cannot answer what the house is drawing right now',
  },
  moods: {
    title: 'Moods',
    consequence: 'mood flow cards will not resolve. This server has no mood tool in either case',
  },
  insights: {
    title: 'Insights',
    consequence: 'there is no sensor history to query, so trends and averages are unavailable',
  },
  logicVariables: {
    title: 'Logic variables',
    consequence: 'homey_variable_set has nothing to write to, and flows using variables cannot be reasoned about',
  },
  weather: {
    title: 'Outdoor weather',
    consequence: 'homey_weather cannot answer, so nothing here can say what it is like outside',
  },
  weatherHourlyForecast: {
    title: 'Hourly weather forecast route',
    // Measured on the reference hub: this route is absent while the weather
    // reading itself still carries hourly entries inline, so its absence costs
    // nothing there. The consequence is worded for the hub where both are gone.
    consequence:
      'an hourly forecast is only available if this hub carries one inside its weather reading, and otherwise homey_weather reports whole days only',
  },
}

/**
 * One check per capability probe.
 *
 * The four statuses stay four statuses. Collapsing "the probe failed" into "this
 * hardware does not have it" tells a reader that retrying can never help, which
 * on a hub that rate limits itself is usually the opposite of the truth.
 */
export function buildCapabilityChecks(capabilities: CapabilityRegistry): DoctorCheck[] {
  const probeEntries = Object.entries(capabilities.probes ?? {})

  if (probeEntries.length === 0) {
    // A registry without probe detail is still usable: report the four hardware
    // booleans rather than pretending nothing is known.
    const { hardware, probedAt, notes } = capabilities
    return [
      {
        id: 'capabilities',
        title: 'Feature probe',
        status: 'warn',
        detail: `Advanced Flow ${formatValue(hardware.advancedFlow)}, energy reports ${formatValue(hardware.energyReports)}, moods ${formatValue(hardware.moods)}, Insights ${formatValue(hardware.insights)}. Probed at ${probedAt}. ${notes.join(' ')}`.trim(),
        fix: 'No per-probe detail was recorded, so a false here cannot be told apart from a failed probe. Restart the server to run detectCapabilities again.',
      },
    ]
  }

  return probeEntries.map(([name, outcome]) => {
    const explanation = CAPABILITY_EXPLANATIONS[name] ?? { title: name, consequence: 'that feature is unavailable' }
    return {
      id: `capability:${name}`,
      title: explanation.title,
      status: capabilityStatus(outcome.status),
      detail: `${outcome.probe} answered ${outcome.status}${outcome.statusCode === null ? '' : ` with HTTP ${outcome.statusCode}`} in ${outcome.durationMs} ms.${outcome.detail === null ? '' : ` ${outcome.detail}`}`,
      fix: capabilityNextStep(outcome.status, explanation.consequence),
    }
  })
}

function capabilityStatus(status: CapabilityProbeStatus): DoctorStatus {
  switch (status) {
    case 'available':
      return 'pass'
    case 'unsupported':
      // Not a fault: this generation of hardware simply does not have it.
      return 'warn'
    case 'failed':
      // Not a fault either, and above all not settled. The probe may have hit
      // the hub's rate limit, so this says "unknown", not "missing".
      return 'warn'
    case 'forbidden':
      // The session was refused, which is a real problem with a real fix.
      return 'fail'
  }
}

function capabilityNextStep(status: CapabilityProbeStatus, consequence: string): string | null {
  switch (status) {
    case 'available':
      return null
    case 'unsupported':
      return `This Homey generation does not offer it, so retrying will not help, and ${consequence}.`
    case 'forbidden':
      return `The session lacks the scope for this. Run "homey login" to get a session with the full "homey" scope and restart this server. Until then ${consequence}.`
    case 'failed':
      return `The probe itself failed, so this may be a temporary problem rather than a missing feature: this Homey refuses requests that arrive together. Run doctor again to settle it, and if it keeps failing include this report in an issue. Until it is confirmed ${consequence}.`
  }
}

interface InventoryReport {
  check: DoctorCheck
  counts: DoctorInventory
}

/**
 * Counts what is on the hub.
 *
 * Both doctors read the same numbers here, and they are shaped so that a reader
 * cannot mistake a subset for a separate collection: `flows` is the total and
 * the two kinds are named as its halves.
 */
async function collectInventory(cache: HomeCache, capabilities: CapabilityRegistry): Promise<InventoryReport> {
  const devices = await readSafely(async () => (await cache.getDevices()).all)
  const zones = await readSafely(async () => (await cache.getZones()).all)
  const flows = await readSafely(async () => (await cache.getFlows()).all)
  const flowCards = await readSafely(async () => (await cache.getAllFlowCards()).all)
  const logicVariables = await readSafely(async () => (await cache.getLogicVariables()).all)

  // Attempted unless the probe settled that this hub has no Insights at all. A
  // probe that merely failed leaves the question open, and reading the catalogue
  // is better evidence than the probe was.
  const insightsUnsupported = capabilities.probes?.['insights']?.status === 'unsupported'
  const insightsLogs = insightsUnsupported ? null : await readSafely(async () => (await cache.getInsightsLogs()).all)

  // A null broken flag means the hub did not report one, which is every flow on
  // the V2 firmware. Counted apart from a reported false, so the report says
  // "not reported" instead of a confident zero.
  const brokenReported = flows !== null && (flows.length === 0 || flows.some((flow) => flow.broken !== null))
  const brokenFlows = brokenReported ? flows.filter((flow) => flow.broken === true).length : null
  const unavailableDevices = devices === null ? null : devices.filter((device) => !device.available).length

  const counts: DoctorInventory = {
    devices: devices?.length ?? null,
    unavailableDevices,
    zones: zones?.length ?? null,
    flows: flows?.length ?? null,
    standardFlows: flows === null ? null : flows.filter((flow) => flow.kind === 'standard').length,
    advancedFlows: flows === null ? null : flows.filter((flow) => flow.kind === 'advanced').length,
    brokenFlows,
    brokenFlowsReported: brokenReported,
    flowCards: flowCards?.length ?? null,
    insightsLogs: insightsLogs?.length ?? null,
    logicVariables: logicVariables?.length ?? null,
  }

  // Only collections that were attempted can be missing. Insights on a hub that
  // does not have them, and a broken count this firmware never reports, are
  // absent by design rather than unread.
  const unread = (
    [
      ['devices', counts.devices],
      ['zones', counts.zones],
      ['flows', counts.flows],
      ['flow cards', counts.flowCards],
      ['logic variables', counts.logicVariables],
      ...(insightsUnsupported ? [] : ([['insights logs', counts.insightsLogs]] as Array<[string, number | null]>)),
    ] as Array<[string, number | null]>
  )
    .filter(([, value]) => value === null)
    .map(([name]) => name)

  const insightsPhrase = insightsUnsupported
    ? 'This Homey does not offer Insights, so there are no sensor logs to count'
    : counts.insightsLogs === null
      ? 'The Insights catalogue could not be read'
      : `${counts.insightsLogs} Insights logs`

  const detail =
    unread.length > 0
      ? `These could not be read: ${unread.join(', ')}.`
      : [
          `${counts.devices} devices in ${counts.zones} zones${(unavailableDevices ?? 0) > 0 ? `, ${unavailableDevices} unavailable` : ''}.`,
          `Flows: ${describeFlowCount(counts)}.`,
          `${counts.flowCards} flow cards.`,
          `${counts.logicVariables} logic variables.`,
          `${insightsPhrase}.`,
        ].join(' ')

  const somethingNeedsAttention = unread.length > 0 || (unavailableDevices ?? 0) > 0 || (brokenFlows ?? 0) > 0

  return {
    counts,
    check: {
      id: 'inventory',
      title: 'Reading your home',
      status: somethingNeedsAttention ? 'warn' : 'pass',
      detail,
      fix:
        unread.length > 0
          ? 'Run doctor again in a moment. If it keeps failing for the same collection, open an issue with the output of "npx homey-mcp doctor --report".'
          : somethingNeedsAttention
            ? 'Use homey_devices_search with available set to false to see which devices Homey cannot reach, and the flow tools to see which flows are broken. An unavailable device usually means a flat battery, a bridge that is off, or an app that crashed.'
            : null,
    },
  }
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

async function probeKnownAddresses(
  credentials: ResolvedCredentials,
  environment: Record<string, string | undefined>,
  logger: Logger,
  fetchImplementation?: typeof fetch,
): Promise<AddressProbeResult[]> {
  const remembered = await readRememberedHubAddresses(credentials.homeyId, environment, logger)

  const candidates = buildAddressCandidates({
    localAddress: credentials.localAddress ?? remembered?.localAddress ?? null,
    localSecureAddress: credentials.localSecureAddress ?? remembered?.localSecureAddress ?? null,
    cloudId: credentials.homeyId,
  })
  if (candidates.length === 0) return []
  return probeAddresses(candidates, {
    logger,
    ...(fetchImplementation === undefined ? {} : { fetchImplementation }),
  })
}

/**
 * The LAN addresses a previous connection learned and wrote to the hub address
 * cache, which is the same file `connectToHomey` reads before it tries the local
 * route.
 *
 * Reading this file is not an optimisation, it is what makes the address check
 * true. No credential source carries a LAN address, so on the ordinary setup the
 * cache is the only place one exists. Building the candidate list from the
 * credentials alone left this check probing a strictly smaller set than the
 * connection two checks below it, and the report then said "only the cloud
 * address answered, so every call leaves your house" directly above "Connected
 * over localSecure". The user was told to move their machine onto a network it
 * was already on.
 *
 * Read here rather than imported because `connect.ts` keeps its own reader
 * private and exports only the path. A missing, unreadable or malformed cache
 * reads as "nothing remembered": this is a diagnostic, and it must still produce
 * a report when the thing being diagnosed is a broken file.
 */
async function readRememberedHubAddresses(
  homeyId: string | null,
  environment: Record<string, string | undefined>,
  logger: Logger,
): Promise<HubAddresses | null> {
  if (homeyId === null) return null

  const path = hubAddressCachePath({ environment })

  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null

    const entry = (parsed as Record<string, unknown>)[homeyId]
    if (entry === null || typeof entry !== 'object') return null

    const record = entry as Record<string, unknown>
    return {
      localAddress: nonEmptyString(record['localAddress']),
      localSecureAddress: nonEmptyString(record['localSecureAddress']),
    }
  } catch {
    logger.debug('No usable record of where this Homey answers on the local network', { path })
    return null
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * A probe result with everything that identifies the home taken out.
 *
 * What a bug report needs from a probe is which kinds of address were tried,
 * which answered, how long each took and what the hub said. The address itself
 * and the `X-Homey-ID` header help with none of that, and the cloud id is the
 * hub's public connect URL. The reason a probe failed can carry the address
 * inside its message, so it goes too. An empty address means withheld, never
 * "there was none".
 */
function withheldAddressDetail(probe: AddressProbeResult): AddressProbeResult {
  return {
    kind: probe.kind,
    address: '',
    reachable: probe.reachable,
    durationMs: probe.durationMs,
    homeyId: null,
    homeyVersion: probe.homeyVersion,
    statusCode: probe.statusCode,
    error: null,
  }
}

/** Whether the connection settled on a LAN rung rather than the Athom cloud. */
function reachedLocalRung(connection: HomeyConnectionWithDiagnostics): boolean {
  return isLocalRung(connection.identity.addressKind)
}

function sawReachableLocalRung(addresses: AddressProbeResult[]): boolean {
  return addresses.some((address) => address.reachable && isLocalRung(address.kind))
}

function isLocalRung(kind: HomeyAddressKind): boolean {
  return kind === 'local' || kind === 'localSecure'
}

function checkAddresses(addresses: AddressProbeResult[]): DoctorCheck {
  if (addresses.length === 0) {
    return {
      id: 'addresses',
      title: 'Network addresses',
      status: 'skip',
      detail: 'No addresses are known yet, so the connection below will ask Athom for them.',
      fix: null,
    }
  }

  const reachable = addresses.filter((address) => address.reachable)
  if (reachable.length === 0) {
    return {
      id: 'addresses',
      title: 'Network addresses',
      status: 'fail',
      detail: `None of the ${addresses.length} known addresses answered.`,
      fix: 'Check that the Homey is powered on and on the same network as this machine. If it is only reachable from elsewhere, the connection will fall back to the Athom cloud, which is slower but works.',
    }
  }

  const local = reachable.filter((address) => address.kind !== 'cloud')
  if (local.length === 0) {
    return {
      id: 'addresses',
      title: 'Network addresses',
      status: 'warn',
      detail: 'Only the cloud address answered, so every call leaves your house and comes back.',
      fix: 'Run this server on the same network as the Homey to get the local route, which measured roughly eight times faster.',
    }
  }

  const fastest = local.reduce((best, candidate) => (candidate.durationMs < best.durationMs ? candidate : best))
  return {
    id: 'addresses',
    title: 'Network addresses',
    status: 'pass',
    detail: `${reachable.length} of ${addresses.length} addresses answered. Fastest local route: ${fastest.kind} in ${fastest.durationMs} ms.`,
    fix: null,
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Which of the credential sources was used, never the description of it.
 *
 * `connectToHomey` records `ResolvedCredentials.sourceDescription`, and one of
 * those descriptions ends in the absolute path of the Homey CLI's settings file,
 * which carries the account name of whoever is running this. `ResolvedCredentials`
 * also has a `source` kind, which is exactly what belongs here, but the
 * connection's diagnostics do not carry it yet. Until they do, the description is
 * matched to a kind here and is never passed through, so an unrecognised one
 * degrades to "unrecognised" rather than leaking a path.
 */
function describeCredentialSourceKind(recorded: string | null): string | null {
  if (recorded === null) return null

  const lowered = recorded.toLowerCase()
  if (lowered.includes('environment variable')) return 'a personal access token in the environment'
  if (lowered.includes('homey cli')) return "the Homey CLI's own stored session"
  if (lowered.includes('credentials file') || lowered.includes('homey-mcp setup'))
    return 'the credentials file this server wrote'
  if (lowered.includes('session this server is already using')) return 'the session this server was started with'
  return 'a credential source this version does not recognise'
}

/**
 * What `connectToHomey` recorded on its way in.
 *
 * Every field is optional here rather than typed as `ConnectionDiagnostics`,
 * because a connection built by hand (a test, or a future caller) carries none
 * of it, and a missing route must read as "not recorded" rather than be filled
 * in with whichever value looked likely.
 */
interface RecordedDiagnostics {
  route: string | null
  probes: AddressProbeResult[]
  dialectEvidence: string | null
  credentialSource: string | null
}

function readDiagnostics(connection: HomeyConnection): RecordedDiagnostics | null {
  const candidate = (connection as { diagnostics?: unknown }).diagnostics
  if (candidate === undefined || candidate === null || typeof candidate !== 'object') return null

  const record = candidate as Record<string, unknown>
  return {
    route: asString(record['route']),
    probes: Array.isArray(record['probes']) ? (record['probes'] as AddressProbeResult[]) : [],
    dialectEvidence: asString(record['dialectEvidence']),
    credentialSource: asString(record['credentialSource']),
  }
}

function describeHardware(connection: HomeyConnection): DoctorHardware {
  return {
    modelId: connection.identity.modelId,
    modelName: connection.identity.modelName,
    softwareVersion: connection.identity.softwareVersion,
    platformVersion: connection.identity.platformVersion,
    dialect: connection.dialect,
    addressKind: connection.identity.addressKind,
    timezone: connection.identity.timezone,
    language: connection.identity.language,
  }
}

/** A collection this hub does not serve is reported as unknown rather than as zero. */
async function readSafely<T>(read: () => Promise<readonly T[]>): Promise<readonly T[] | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

function describeDeviceCount(inventory: DoctorInventory): string {
  if (inventory.devices === null) return 'unknown'
  if (inventory.unavailableDevices === null || inventory.unavailableDevices === 0) return String(inventory.devices)
  return `${inventory.devices} (${inventory.unavailableDevices} unavailable)`
}

/**
 * The flow total with its two halves inside it.
 *
 * Printed on one line because two adjacent lines, "flows 17" above "advanced
 * flows 4", read as two separate collections when the second is part of the
 * first.
 */
function describeFlowCount(inventory: DoctorInventory): string {
  if (inventory.flows === null) return 'unknown'
  const brokenPhrase = inventory.brokenFlowsReported
    ? `${inventory.brokenFlows} broken`
    : 'this Homey does not report which are broken'
  return `${inventory.flows} in total, ${formatCount(inventory.standardFlows)} standard and ${formatCount(inventory.advancedFlows)} advanced; ${brokenPhrase}`
}

/** One line about the CLI with nothing in it that names a household or a filesystem. */
function describeHomeyCliForSharing(homeyCli: DoctorHomeyCli): string {
  if (!homeyCli.found) {
    return homeyCli.loggedIn
      ? 'not installed, but a stored login was found'
      : 'not installed on this machine'
  }

  return [
    homeyCli.where ?? 'installed',
    homeyCli.version === null ? 'version not readable' : `version ${homeyCli.version}`,
    homeyCli.loggedIn ? 'signed in' : 'not signed in',
    homeyCli.homeySelected ? 'one Homey selected' : 'no Homey selected',
  ].join(', ')
}

function formatCount(value: number | null): string {
  return value === null ? 'unknown' : String(value)
}

function formatMegabytes(bytes: number | null): string {
  if (bytes === null) return 'an unknown amount'
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'an unknown time'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  if (days > 0) return `${days} days ${hours} hours`
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours} hours ${minutes} minutes`
}

function fixForReason(reason: string): string {
  switch (reason) {
    case 'not_connected':
      return 'Run "npx homey-mcp setup" to set up credentials, or "homey login" if you use the Homey CLI. Sessions expire after 24 hours.'
    case 'missing_scope':
      return 'Sign in again with "homey login". That session carries the root "homey" scope, which is the one that allows writing flows.'
    case 'unsupported_hardware':
      return 'Nothing to fix: this Homey generation does not have the feature. The tools that depend on it are not registered.'
    case 'rate_limited':
      // Its own case since the taxonomy split rate limiting out of `transient`.
      // Without it this advice, which is only true of a rate limit, fell through
      // to "open an issue".
      return 'Wait a few seconds and run doctor again. This Homey refuses requests when several arrive at once.'
    case 'transient':
      return 'Run doctor again. If it keeps failing, check that the Homey is powered on and on the network.'
    default:
      return 'Run "npx homey-mcp doctor --report" and open an issue with the output.'
  }
}

/** Names the failed step after whichever checks already ran, so the report reads in order. */
function failureCheckId(checks: DoctorCheck[]): string {
  if (!checks.some((check) => check.id === 'credentials')) return 'credentials'
  if (!checks.some((check) => check.id === 'connection')) return 'connection'
  if (!checks.some((check) => check.id.startsWith('capabilit'))) return 'capabilities'
  return 'inventory'
}

function failureCheckTitle(checks: DoctorCheck[]): string {
  switch (failureCheckId(checks)) {
    case 'credentials':
      return 'Credentials'
    case 'connection':
      return 'Connection to Homey'
    case 'capabilities':
      return 'Feature probe'
    default:
      return 'Reading your home'
  }
}

function statusMarker(status: DoctorStatus): string {
  switch (status) {
    case 'pass':
      return '[ ok ]'
    case 'warn':
      return '[warn]'
    case 'fail':
      return '[FAIL]'
    default:
      return '[skip]'
  }
}
