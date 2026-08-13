// What `serve` does before and around the MCP server itself.
//
// The connection it opens is the whole subject of the first test group: a Homey
// session lasts exactly 24 hours and this process is meant to be left running,
// so a connection resolved once at startup is a server that answers nothing
// after a day.

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runServe } from './serve.js'
import type { ResolvedCredentials } from '../homey/credentials.js'
import { createLogger } from '../util/log.js'

const doubles = vi.hoisted(() => ({
  openReconnectingConnection: vi.fn(),
  connectToHomey: vi.fn(),
  createServer: vi.fn(),
}))

vi.mock('../homey/connect.js', () => ({
  openReconnectingConnection: doubles.openReconnectingConnection,
  connectToHomey: doubles.connectToHomey,
  disconnectFromHomey: vi.fn(),
}))

vi.mock('../server/createServer.js', () => ({ createServer: doubles.createServer }))

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}))

const logger = createLogger({ level: 'silent' })

afterEach(() => {
  vi.clearAllMocks()
})

/** Collects what was written for the person reading the client's server log. */
function collectOutput(): { written: () => string; stream: NodeJS.WritableStream } {
  const chunks: string[] = []
  return {
    written: () => chunks.join(''),
    stream: {
      write: (chunk: unknown) => {
        chunks.push(String(chunk))
        return true
      },
    } as unknown as NodeJS.WritableStream,
  }
}

/** A credentials file with nothing secret in it. The connection is mocked, so the content only has to parse. */
async function writeCredentialsFile(contents: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'homey-mcp-serve-'))
  const path = join(directory, 'credentials.json')
  await writeFile(path, `${JSON.stringify(contents)}\n`)
  return path
}

/**
 * An MCP server that closes as soon as it is connected, so `runServe` reaches
 * its shutdown path instead of waiting for a client that will never arrive.
 */
function stubMcpServer(): { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => undefined)
  const server = {
    server: { onclose: undefined as (() => void) | undefined },
    connect: vi.fn(async () => {
      queueMicrotask(() => server.server.onclose?.())
    }),
    close,
  }
  doubles.createServer.mockResolvedValue({ server })
  return { close }
}

describe('runServe, on the connection it opens', () => {
  it('opens a connection that can renew itself, rather than one resolved once at startup', async () => {
    // The 24 hour wall. `connectToHomey` on its own has no route back into a
    // running process once Homey stops accepting the session.
    const close = vi.fn(async () => undefined)
    doubles.openReconnectingConnection.mockResolvedValue({ close })
    stubMcpServer()

    const configPath = await writeCredentialsFile({ homeyId: 'homeyidentifier000000001' })

    expect(await runServe({ argv: ['--config', configPath], logger, environment: {} })).toBe(0)

    expect(doubles.openReconnectingConnection).toHaveBeenCalledTimes(1)
    expect(doubles.connectToHomey).not.toHaveBeenCalled()
    // Closed on the way out, so a client that hangs up does not leave a session open.
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('hands it a reader that goes back to the file, not the credentials it started with', async () => {
    // The Homey CLI refreshes its own session in the same file, so by the time a
    // 24 hour session dies the replacement is usually already on disk. Reusing
    // the credentials this process started with would sign in again with the
    // very token that was just refused.
    doubles.openReconnectingConnection.mockResolvedValue({ close: vi.fn(async () => undefined) })
    stubMcpServer()

    const configPath = await writeCredentialsFile({ homeyId: 'homeyidentifier000000001' })
    await runServe({ argv: ['--config', configPath], logger, environment: {} })

    const options = doubles.openReconnectingConnection.mock.calls[0]?.[0] as {
      credentials: ResolvedCredentials
      loadCredentials: () => Promise<ResolvedCredentials>
    }
    expect(options.credentials.homeyId).toBe('homeyidentifier000000001')

    // The Homey CLI, or "homey-mcp setup", writes a new session into the file.
    await writeFile(configPath, `${JSON.stringify({ homeyId: 'homeyidentifier000000002' })}\n`)

    expect((await options.loadCredentials()).homeyId).toBe('homeyidentifier000000002')
  })
})

describe('runServe, on the arguments it is given', () => {
  it('refuses a log level it does not know instead of quietly using the default', async () => {
    // Somebody who mistypes this is asking to see more. Silently giving them the
    // default level is how a debugging session begins by chasing the wrong thing.
    const output = collectOutput()

    const exitCode = await runServe({
      argv: ['--log-level', 'debgu'],
      environment: {},
      errorOutput: output.stream,
    })

    expect(exitCode).toBe(1)
    expect(output.written()).toContain('"debgu" is not a log level')
    expect(output.written()).toContain('silent, error, warn, info, debug')
    expect(doubles.openReconnectingConnection).not.toHaveBeenCalled()
  })

  it('accepts every level it documents', async () => {
    doubles.openReconnectingConnection.mockResolvedValue({ close: vi.fn(async () => undefined) })
    stubMcpServer()
    const configPath = await writeCredentialsFile({ homeyId: 'homeyidentifier000000001' })

    for (const level of ['silent', 'error', 'warn', 'info', 'debug']) {
      expect(await runServe({ argv: ['--log-level', level, '--config', configPath], logger, environment: {} })).toBe(0)
    }
  })

  it('says which file it could not read instead of claiming nothing is set up', async () => {
    // "--config" pointing at a path that is not there used to print the generic
    // "no credentials were found, run setup" help, which sends someone to redo a
    // setup they already did rather than at the typo in their client config.
    const output = collectOutput()
    const missingPath = join(tmpdir(), 'homey-mcp-does-not-exist', 'credentials.json')

    const exitCode = await runServe({
      argv: ['--config', missingPath],
      logger,
      environment: {},
      errorOutput: output.stream,
    })

    expect(exitCode).toBe(1)
    expect(output.written()).toContain(missingPath)
    expect(output.written()).toContain('could not be read')
  })
})

// There is deliberately no test here for "no credentials anywhere". Its answer
// depends on whether the machine running the suite has a Homey CLI session in
// its home directory, and `runServe` reads the real one.
