import { afterEach, describe, expect, it, vi } from 'vitest'

import { DOCTOR_FLAGS, SERVE_FLAGS, SETUP_FLAGS } from './cli/flags.js'
import { main, reportExitCode } from './index.js'

// Every subcommand is replaced, so a routing bug in the checks below cannot
// start a real server on this process's stdio or reach for a Homey.
const subcommands = vi.hoisted(() => ({
  runServe: vi.fn(async () => 0),
  runSetup: vi.fn(async () => 0),
  runDoctor: vi.fn(async () => 0),
}))

vi.mock('./cli/serve.js', () => ({ runServe: subcommands.runServe }))
vi.mock('./cli/setup.js', () => ({ runSetup: subcommands.runSetup }))
vi.mock('./cli/doctor.js', () => ({ runDoctor: subcommands.runDoctor }))

/** Collects what a run wrote, so the message a user reads can be asserted on. */
function captureOutput(): { standardOutput: () => string; errorOutput: () => string } {
  const written: string[] = []
  const errors: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    errors.push(String(chunk))
    return true
  })
  return { standardOutput: () => written.join(''), errorOutput: () => errors.join('') }
}

/**
 * `process.exitCode` is process-wide state, so every test puts it back. Vitest
 * reads it when it decides how the run itself ends.
 */
const originalExitCode = process.exitCode

afterEach(() => {
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
  subcommands.runServe.mockClear()
  subcommands.runSetup.mockClear()
  subcommands.runDoctor.mockClear()
})

describe('main, on the arguments it is given', () => {
  it('refuses a misspelled --report instead of running the unscrubbed report', async () => {
    // The privacy trap this check exists for. "doctor --repot" used to run the
    // full terminal report, which carries LAN addresses, the Athom cloud id and
    // filesystem paths, at the moment the user believed they had asked for the
    // scrubbed one they were about to paste into a public issue.
    const output = captureOutput()

    const exitCode = await main(['doctor', '--repot'])

    expect(exitCode).toBe(1)
    expect(subcommands.runDoctor).not.toHaveBeenCalled()
    expect(output.errorOutput()).toContain('"--repot" is not an option of "homey-mcp doctor"')
    expect(output.errorOutput()).toContain('Did you mean "--report"?')
  })

  it('still runs a subcommand whose options are all recognised', async () => {
    captureOutput()

    expect(await main(['doctor', '--report', '--quick'])).toBe(0)
    expect(subcommands.runDoctor).toHaveBeenCalledWith({ argv: ['--report', '--quick'] })
  })

  it('refuses an unknown option in the first position, which is the default subcommand', async () => {
    const output = captureOutput()

    expect(await main(['--repot'])).toBe(1)
    expect(subcommands.runServe).not.toHaveBeenCalled()
    expect(output.errorOutput()).toContain('is not an option')
  })

  it('checks setup too, which reads its own arguments with includes and cannot notice one', async () => {
    const output = captureOutput()

    expect(await main(['setup', '--yess'])).toBe(1)
    expect(subcommands.runSetup).not.toHaveBeenCalled()
    expect(output.errorOutput()).toContain('Did you mean "--yes"?')
  })

  it('prints the usage for --help after a subcommand rather than running it', async () => {
    // "homey-mcp doctor --help" used to fall through as an argument nothing
    // read, so asking for help ran a full report against the hub.
    const output = captureOutput()

    expect(await main(['doctor', '--help'])).toBe(0)
    expect(subcommands.runDoctor).not.toHaveBeenCalled()
    expect(output.standardOutput()).toContain('homey-mcp doctor')
  })

  it('documents every option it accepts, so the help and the checks cannot drift apart', async () => {
    const output = captureOutput()
    await main(['--help'])
    const usage = output.standardOutput()

    for (const spec of [...SERVE_FLAGS, ...SETUP_FLAGS, ...DOCTOR_FLAGS]) {
      expect(usage, `${spec.name} is accepted but not documented`).toContain(spec.name)
    }

    // Per subcommand as well, because the check above is satisfied by the flag
    // appearing anywhere at all: `doctor --port` was accepted while only the
    // `serve` synopsis mentioned a port, so the one command that says which of
    // four things is wrong looked as though it could not be aimed anywhere.
    // `serve` is described in two paragraphs, the stdio one and the HTTP one, so
    // a subcommand's documentation is every paragraph that names it rather than
    // one line.
    const paragraphsFor = (verbs: string[]): string =>
      usage
        .split('\n\n')
        .filter((paragraph) => {
          const synopsis = paragraph.split('\n').find((line) => line.startsWith('  homey-mcp')) ?? ''
          return verbs.some((verb) => synopsis.includes(verb))
        })
        .join('\n')

    for (const [verbs, specs] of [
      [['homey-mcp serve', 'homey-mcp [serve]'], SERVE_FLAGS],
      [['homey-mcp setup'], SETUP_FLAGS],
      [['homey-mcp doctor'], DOCTOR_FLAGS],
    ] as const) {
      const documentation = paragraphsFor([...verbs])
      expect(documentation, `nothing in the usage describes ${verbs[0]}`).not.toBe('')
      for (const spec of specs) {
        if (spec.name === '--help') continue
        expect(documentation, `${verbs[0]} accepts ${spec.name} but its own paragraph never mentions it`).toContain(
          spec.name,
        )
      }
    }
  })

  it('says the session renews itself, because a day-old server that answers nothing looks broken', async () => {
    const output = captureOutput()
    await main(['--help'])

    expect(output.standardOutput()).toContain('24 hours')
  })
})

describe('reportExitCode', () => {
  it('reports failure for as long as the run has not finished', async () => {
    // The regression. Node's default exit code is 0, so a process that drains
    // its event loop while the run is still pending used to exit reporting
    // success on work that never happened: `doctor --quick` printed zero bytes
    // and exited 0 while it sat between two hub calls.
    let finish: (exitCode: number) => void = () => undefined
    const run = new Promise<number>((resolve) => {
      finish = resolve
    })

    const reported = reportExitCode(run)

    expect(process.exitCode).toBe(1)
    // Still pending after the microtask queue drains, which is the moment Node
    // would decide there is nothing left to do.
    await Promise.resolve()
    expect(process.exitCode).toBe(1)

    finish(0)
    await reported
    expect(process.exitCode).toBe(0)
  })

  it('reports the code the run settled on', async () => {
    await reportExitCode(Promise.resolve(0))
    expect(process.exitCode).toBe(0)

    await reportExitCode(Promise.resolve(1))
    expect(process.exitCode).toBe(1)
  })

  it('turns a thrown failure into one sentence on stderr and a failing code', async () => {
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })

    await reportExitCode(Promise.reject(new Error('Homey did not answer')))

    expect(process.exitCode).toBe(1)
    expect(written.join('')).toContain('Homey did not answer')
    expect(written.join('')).toContain('npx homey-mcp doctor')
    // A trace would bury the one line that says what to do next, and its frames
    // would name this file.
    expect(written.join('')).not.toContain('index.test.ts')
  })
})
