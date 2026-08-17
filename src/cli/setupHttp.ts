// The extra half of `setup --http`.
//
// Order matters here more than anywhere else in setup, and the order is what
// stops it printing a client entry that will show a red cross. Each probe below
// corresponds to a measured failure that otherwise reaches the user only as an
// unexplained red cross, so the entry is printed last, after the service is
// running and after this process has checked its own endpoints from the outside.
//
// The trade-off is stated in the output rather than buried in a README, because
// this mode's failure state is a red cross and somebody who chooses it deserves
// to know that before they choose it.

import { setTimeout as delay } from 'node:timers/promises'

import { collectHttpDoctorSection } from '../http/doctorSection.js'
import { createHttpEndpointConfig, DEFAULT_HTTP_PORT } from '../http/config.js'
import { readPackageMetadata } from '../server/createServer.js'
import { runService } from './service.js'

type Write = (line?: string) => void

/**
 * The one line the ordinary stdio setup prints at the very end.
 *
 * One sentence, after the working instructions. Somebody who does not care reads
 * one extra line.
 */
export const HTTP_MODE_POINTER = [
  'There is also a mode where your assistant shows a "needs authentication" prompt and signs',
  'you in through your browser. It needs a background service. Run',
  '"npx homey-mcp setup --http" if you want it.',
]

export interface FinishWithHttpModeOptions {
  write: Write
  argv: string[]
  environment: Record<string, string | undefined>
  output?: NodeJS.WritableStream
  input?: NodeJS.ReadableStream & { isTTY?: boolean }
  port?: number
  /** How long to wait for the service to answer once it has been started. */
  startupTimeoutMs?: number
}

/** Returns the exit code. Called after the ordinary credential half has already succeeded. */
export async function finishWithHttpMode(options: FinishWithHttpModeOptions): Promise<number> {
  const { write } = options
  const port = options.port ?? DEFAULT_HTTP_PORT
  const config = createHttpEndpointConfig({ port })

  write('Browser sign-in mode')
  write(`  This runs a small server on ${config.mcpUrl.href} that your assistant talks to.`)
  write('  Nothing starts it for you, so it needs a background service.')
  write()

  const serviceExitCode = await runService({
    verb: 'install',
    argv: [...(options.argv.includes('--yes') || options.argv.includes('-y') ? ['--yes'] : []), '--port', String(port)],
    environment: options.environment,
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.input === undefined ? {} : { input: options.input }),
  })

  if (serviceExitCode !== 0) {
    write('The service was not installed, so there is no address to give your assistant yet.')
    write()
    return 1
  }

  write('Checking it from the outside')
  const section = await waitForHealthyEndpoints(config.port, options)

  for (const check of section.checks) {
    write(`  ${check.status === 'pass' ? 'ok  ' : 'FAIL'} ${check.title}`)
    if (check.status !== 'pass') write(`       ${check.detail}`)
  }
  write()

  if (section.checks.some((check) => check.status === 'fail')) {
    write('Not printing the client entry, because adding it now would only show a red cross.')
    write('Run "npx homey-mcp doctor --http" once the failures above are fixed.')
    write()
    return 1
  }

  printHttpClientInstructions(write, config.mcpUrl.href)
  return 0
}

/**
 * Waits for the service to come up, then probes.
 *
 * A service that has just been enabled takes a moment to bind, and probing
 * during that moment reports a healthy install as broken.
 */
async function waitForHealthyEndpoints(
  port: number,
  options: FinishWithHttpModeOptions,
): Promise<Awaited<ReturnType<typeof collectHttpDoctorSection>>> {
  const deadline = Date.now() + (options.startupTimeoutMs ?? 20_000)

  for (;;) {
    const section = await collectHttpDoctorSection({ port, environment: options.environment })
    if (section.httpMode.portIsListening) return section
    if (Date.now() >= deadline) return section
    await delay(500)
  }
}

export function printHttpClientInstructions(write: Write, mcpUrl: string): void {
  const packageName = readPackageMetadata().name

  write('Add it to Claude Code with exactly this line:')
  write()
  write(`  claude mcp add --scope user --transport http homey-http ${mcpUrl}`)
  write()
  write('The first time you use it, Claude Code shows "homey-http - needs authentication" in')
  write('yellow. Open /mcp, choose Authenticate, and a page opens in your browser where you')
  write('approve it and, if needed, sign in to your Homey.')
  write()
  write('This replaces the stdio entry. If you added one before, remove it so your assistant')
  write('does not see every tool twice:')
  write()
  write('  claude mcp remove homey')
  write()
  write('Two things to know:')
  write()
  write('  - This mode needs the background service to be running. If it is not, your assistant')
  write(`    shows a red cross saying it could not connect. "npx ${packageName} doctor --http" says`)
  write('    whether it is running and how to start it.')
  write(`  - The service is per user and starts when you log in. "npx ${packageName} service status"`)
  write(`    shows its state, "npx ${packageName} service uninstall" removes it.`)
  write()
}
