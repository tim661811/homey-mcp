import type { AddressInfo } from 'node:net'
import { createServer as createTcpServer } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Server } from 'node:http'
import { createServer as createHttpServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { collectHttpDoctorSection } from './doctorSection.js'
import { createAuthStore } from './authStore.js'
import { createHttpEndpointConfig } from './config.js'
import type { HttpEndpointConfig } from './config.js'
import { HomeyOAuthProvider } from './oauthProvider.js'
import { createSessionRegistry } from './sessions.js'
import { buildApp } from '../cli/serveHttp.js'
import { createLogger } from '../util/log.js'

const logger = createLogger({ level: 'silent' })

let config: HttpEndpointConfig
let configHome: string
let httpServer: Server | null = null

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createTcpServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

async function startRealServer(): Promise<void> {
  const store = await createAuthStore({ port: config.port, environment: { XDG_CONFIG_HOME: configHome } })
  const provider = new HomeyOAuthProvider({
    config,
    store,
    logger,
    describeHomey: async () => ({ kind: 'not_signed_in', reason: 'No session.', instruction: 'Run "homey login".' }),
    storePersonalAccessToken: async () => ({ ok: false, message: 'Not reached.' }),
  })

  const app = buildApp({
    config,
    provider,
    createMcpSession: async () => ({ server: new McpServer({ name: 'homey-mcp', version: '0.0.0-test' }) }),
    sessions: createSessionRegistry({ logger }),
    logger,
  })

  await new Promise<void>((resolve) => {
    httpServer = app.listen(config.port, config.bindHost, () => resolve())
  })
}

beforeEach(async () => {
  config = createHttpEndpointConfig({ port: await findFreePort() })
  configHome = await mkdtemp(join(tmpdir(), 'homey-mcp-doctor-http-'))
  httpServer = null
})

afterEach(async () => {
  if (httpServer !== null) await new Promise<void>((resolve) => httpServer?.close(() => resolve()))
})

describe('collectHttpDoctorSection', () => {
  it('says the port is silent, which is the one failure this mode adds', async () => {
    // A daemon that is not running reaches the client as "ConnectionRefused:
    // Unable to connect", with nothing in it saying which of four things went
    // wrong. This is where that question gets an answer.
    const section = await collectHttpDoctorSection({
      port: config.port,
      environment: { XDG_CONFIG_HOME: configHome },
    })

    expect(section.httpMode.portIsListening).toBe(false)
    expect(section.checks).toHaveLength(1)
    expect(section.checks[0]?.status).toBe('fail')
    expect(section.checks[0]?.fix).toContain('service status')
  })

  it('passes every probe against a server that is actually running', async () => {
    await startRealServer()

    const section = await collectHttpDoctorSection({
      port: config.port,
      environment: { XDG_CONFIG_HOME: configHome },
    })

    expect(section.httpMode.portIsListening).toBe(true)
    expect(section.checks.map((check) => check.id)).toEqual([
      'http_listening',
      'http_challenge',
      'http_resource_metadata',
      'http_authorization_server',
      'http_registration',
    ])
    expect(section.checks.every((check) => check.status === 'pass')).toBe(true)
  })

  it('fails the challenge probe when the 401 carries no resource metadata', async () => {
    // The whole yellow-versus-red decision, asserted against a server that
    // answers 401 without the header a client needs.
    const bare = await new Promise<Server>((resolve) => {
      const server = createHttpServer((_request, response) => {
        response.writeHead(401, { 'Content-Type': 'application/json' }).end('{}')
      })
      server.listen(config.port, config.bindHost, () => resolve(server))
    })
    httpServer = bare

    const section = await collectHttpDoctorSection({
      port: config.port,
      environment: { XDG_CONFIG_HOME: configHome },
    })

    const challenge = section.checks.find((check) => check.id === 'http_challenge')
    expect(challenge?.status).toBe('fail')
    expect(challenge?.detail).toContain('resource_metadata')
  })

  it('reports counts and never a client id or token material', async () => {
    await startRealServer()

    const section = await collectHttpDoctorSection({
      port: config.port,
      environment: { XDG_CONFIG_HOME: configHome },
    })

    // Every field is a number, a verdict or the configured address, so --report
    // needs no extra scrubbing rule for this section.
    expect(Object.keys(section.httpMode).sort()).toEqual([
      'authStateAgeDays',
      'liveAccessTokens',
      'liveRefreshTokens',
      'port',
      'portIsListening',
      'registeredClients',
      'url',
    ])
    expect(section.httpMode.url).toBe(config.mcpUrl.href)
  })
})

describe('the registration probe', () => {
  it('registers nothing, so running a diagnostic does not inflate the count it reports', async () => {
    // Deleting a probe registration afterwards is not available: doctor is a
    // second process, and the running server rewrites the whole state file from
    // memory on its next write.
    await startRealServer()

    const before = await collectHttpDoctorSection({ port: config.port, environment: { XDG_CONFIG_HOME: configHome } })
    const after = await collectHttpDoctorSection({ port: config.port, environment: { XDG_CONFIG_HOME: configHome } })

    expect(before.checks.find((check) => check.id === 'http_registration')?.status).toBe('pass')
    expect(after.httpMode.registeredClients).toBe(before.httpMode.registeredClients)
    expect(after.httpMode.registeredClients).toBe(0)
  })

  it('reads a rate-limited answer as proof the endpoint is mounted', async () => {
    // Measured against the running server: the SDK's limiter allows about twenty
    // registrations an hour per address, counts refused ones, and on loopback
    // that is one global budget. So twenty doctor runs reach it, and reading 429
    // as a broken endpoint told the user to reinstall a healthy service and made
    // "setup --http" refuse to print the client entry.
    const limited = await new Promise<Server>((resolve) => {
      const server = createHttpServer((request, response) => {
        if (request.url === '/register') {
          response.writeHead(429, { 'Content-Type': 'application/json' }).end('{"error":"too_many_requests"}')
          return
        }
        response.writeHead(401, { 'WWW-Authenticate': 'Bearer resource_metadata="x"' }).end('{}')
      })
      server.listen(config.port, config.bindHost, () => resolve(server))
    })
    httpServer = limited

    const section = await collectHttpDoctorSection({ port: config.port, environment: { XDG_CONFIG_HOME: configHome } })
    const check = section.checks.find((candidate) => candidate.id === 'http_registration')

    expect(check?.status).toBe('pass')
    expect(check?.detail).toContain('rate limiting')
  })

  it('fails when the registration endpoint is not mounted at all', async () => {
    // The measured precondition: with /register answering 404, an identical 401
    // with an identical header produced red rather than yellow.
    const bare = await new Promise<Server>((resolve) => {
      const server = createHttpServer((request, response) => {
        if (request.url === '/register') {
          response.writeHead(404).end()
          return
        }
        response.writeHead(401, { 'WWW-Authenticate': 'Bearer resource_metadata="x"' }).end('{}')
      })
      server.listen(config.port, config.bindHost, () => resolve(server))
    })
    httpServer = bare

    const section = await collectHttpDoctorSection({ port: config.port, environment: { XDG_CONFIG_HOME: configHome } })

    expect(section.checks.find((check) => check.id === 'http_registration')?.status).toBe('fail')
  })
})
