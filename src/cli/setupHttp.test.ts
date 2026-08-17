import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { finishWithHttpMode, HTTP_MODE_POINTER, printHttpClientInstructions } from './setupHttp.js'

function collect(): { write: (line?: string) => void; text: () => string } {
  const lines: string[] = []
  return {
    write: (line = ''): void => {
      lines.push(line)
    },
    text: (): string => lines.join('\n'),
  }
}

describe('HTTP_MODE_POINTER', () => {
  it('is the one line the ordinary setup adds, and it points at the command', () => {
    const text = HTTP_MODE_POINTER.join(' ')

    expect(text).toContain('npx homey-mcp setup --http')
    expect(text).toContain('background service')
    expect(HTTP_MODE_POINTER.length).toBeLessThanOrEqual(3)
  })
})

describe('printHttpClientInstructions', () => {
  it('gives the http transport line, not the stdio one', () => {
    const output = collect()
    printHttpClientInstructions(output.write, 'http://127.0.0.1:8431/mcp')

    expect(output.text()).toContain(
      'claude mcp add --scope user --transport http homey-http http://127.0.0.1:8431/mcp',
    )
  })

  it('says the HTTP entry replaces the stdio one, so no assistant sees every tool twice', () => {
    const output = collect()
    printHttpClientInstructions(output.write, 'http://127.0.0.1:8431/mcp')

    expect(output.text()).toContain('claude mcp remove homey')
  })

  it('states the trade-off in the output rather than burying it in a README', () => {
    // This mode's failure state is a red cross saying it could not connect.
    // Somebody choosing it deserves to know that before they choose it.
    const output = collect()
    printHttpClientInstructions(output.write, 'http://127.0.0.1:8431/mcp')
    const text = output.text()

    expect(text).toContain('red cross')
    expect(text).toContain('doctor --http')
    expect(text).toContain('service status')
  })
})

describe('finishWithHttpMode', () => {
  it('prints no client entry when the service was not installed', async () => {
    // Printing an address nothing answers on would produce exactly the
    // unexplained red cross this whole section exists to prevent.
    const output = collect()
    const input = new PassThrough() as unknown as NodeJS.ReadableStream & { isTTY?: boolean }
    input.isTTY = false

    const exitCode = await finishWithHttpMode({
      write: output.write,
      // No --yes and no terminal, so the install is declined by the documented
      // default rather than hung on.
      argv: ['--http'],
      environment: {},
      input,
      output: new PassThrough(),
      port: 8431,
      startupTimeoutMs: 0,
    })

    expect(exitCode).toBe(1)
    expect(output.text()).not.toContain('claude mcp add')
    expect(output.text()).toContain('no address to give your assistant yet')
  })
})
