#!/usr/bin/env node
// The binary.
//
// Three things happen before anything else is loaded, and the order matters.
//
// The Node version is checked first, with no imports above the check. On an old
// Node an unsupported syntax or a missing built-in in a dependency produces a
// crash that says nothing about the real problem, and the user is left reading a
// stack trace from inside a library they have never heard of. A plain sentence
// naming the version they have, the version they need and where their Node came
// from is worth more than the whole trace.
//
// The subcommand is then routed to a module loaded on demand, so `--version` and
// `--help` never pay for the Homey client or the MCP SDK.
//
// Nothing here writes to stdout unless the subcommand is one that prints for a
// human. `serve` gives stdout to the JSON-RPC transport.

const MINIMUM_NODE_MAJOR_VERSION = 24

export async function main(): Promise<number> {
  const argv = process.argv.slice(2)

  const versionProblem = checkNodeVersion()
  if (versionProblem !== null) {
    process.stderr.write(`${versionProblem}\n`)
    return 1
  }

  const [firstArgument = 'serve', ...rest] = argv

  if (firstArgument === '--version' || firstArgument === '-v') {
    const { readPackageMetadata } = await import('./server/createServer.js')
    process.stdout.write(`${readPackageMetadata().version}\n`)
    return 0
  }

  if (firstArgument === '--help' || firstArgument === '-h' || firstArgument === 'help') {
    process.stdout.write(`${usage()}\n`)
    return 0
  }

  switch (firstArgument) {
    case 'setup': {
      const { runSetup } = await import('./cli/setup.js')
      return await runSetup({ argv: rest })
    }
    case 'doctor': {
      const { runDoctor } = await import('./cli/doctor.js')
      return await runDoctor({ argv: rest })
    }
    case 'serve': {
      const { runServe } = await import('./cli/serve.js')
      return await runServe({ argv: rest })
    }
    default: {
      // A flag in the first position means the default subcommand with options,
      // which is what "npx homey-mcp --config ..." looks like.
      if (firstArgument.startsWith('-')) {
        const { runServe } = await import('./cli/serve.js')
        return await runServe({ argv })
      }
      process.stderr.write(`Unknown command "${firstArgument}".\n\n${usage()}\n`)
      return 1
    }
  }
}

/** Returns the message to print when this Node cannot run the server, or null when it can. */
function checkNodeVersion(): string | null {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
  if (!Number.isNaN(major) && major >= MINIMUM_NODE_MAJOR_VERSION) return null

  return [
    '',
    `homey-mcp needs Node ${MINIMUM_NODE_MAJOR_VERSION} or newer, but this is Node ${process.versions.node}.`,
    '',
    `The Homey client library requires it too, so there is no way around the upgrade.`,
    '',
    'What to do:',
    '  - Install a current Node from https://nodejs.org, or with nvm: "nvm install 24 && nvm use 24".',
    '  - Then check the right one is being used: "node --version".',
    '',
    `The Node running now is at: ${process.execPath}`,
    '',
    'If your assistant starts this server for you, it may be using a different Node than your',
    'terminal does. Point it at the full path of a current Node in its MCP server configuration.',
    '',
  ].join('\n')
}

function usage(): string {
  return [
    'homey-mcp - connect an AI assistant to your Homey Pro',
    '',
    'Usage:',
    '  homey-mcp [serve] [--config <path>] [--log-level <level>]',
    '      Run the MCP server on stdio. This is what your assistant starts.',
    '',
    '  homey-mcp setup',
    '      Find your Homey, check it can be reached, save the credentials and print',
    '      the exact line to register this server with your assistant.',
    '',
    '  homey-mcp doctor [--json] [--report] [--quick] [--config <path>]',
    '      Check everything and name the fix for anything that is wrong.',
    '      --json    the same report as JSON',
    '      --report  a scrubbed version to paste into a bug report',
    '      --quick   skip the counts, which cost one request each',
    '',
    'Options:',
    '  --version, -v   print the version',
    '  --help, -h      print this',
    '',
    'Environment:',
    '  HOMEY_MCP_CONFIG      path to a credentials file',
    '  HOMEY_PAT             an Athom Personal Access Token',
    '  HOMEY_MCP_LOG_LEVEL   silent, error, warn, info (default) or debug',
  ].join('\n')
}

/**
 * Turns the outcome of a run into the process exit code.
 *
 * The failing code is set BEFORE the run is awaited, and that ordering is the
 * point. Node's own default exit code is 0, so a process whose event loop drains
 * while `main` is still pending exits reporting success on work that never
 * finished. That is exactly what happened when the request queue's spacing timer
 * was unref'd: `doctor` died between two hub calls, printed nothing at all, and
 * still told the caller everything was fine. Starting at 1 means only a settled
 * run can report anything else, so "no output, exit 0" cannot happen again.
 *
 * Exported so a test can drive it without the module deciding to serve on stdio.
 */
export async function reportExitCode(run: Promise<number>): Promise<void> {
  process.exitCode = 1

  try {
    process.exitCode = await run
  } catch (error: unknown) {
    // Anything reaching here is a bug or an unreachable Homey. Either way the
    // user needs a sentence, not a trace, and stderr is the only safe channel.
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`\n${message}\n\nRun "npx homey-mcp doctor" to see what is reachable.\n`)
    process.exitCode = 1
  }
}

// Only when this file is the process entry point. Importing it, which is how the
// wiring above is tested, must not start a server on stdio.
if (import.meta.main) void reportExitCode(main())
