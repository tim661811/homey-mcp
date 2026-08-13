import { afterEach, describe, expect, it, vi } from 'vitest'

import { reportExitCode } from './index.js'

/**
 * `process.exitCode` is process-wide state, so every test puts it back. Vitest
 * reads it when it decides how the run itself ends.
 */
const originalExitCode = process.exitCode

afterEach(() => {
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
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
