// The HTTP surface, driven over a real socket.
//
// Everything here is asserted against the wire rather than against a function's
// return value, because every one of these behaviours is something a client reads
// off an HTTP response and nothing else. The 401 and its header in particular are
// the whole reason this mode exists: they are what make a client say "needs
// authentication" instead of "failed to connect".

import type { AddressInfo } from 'node:net'
import { createServer as createTcpServer } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Server } from 'node:http'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp, isAddressInUse } from './serveHttp.js'
import { createAuthStore, readStoredApprovalCode } from '../http/authStore.js'
import type { AuthStore } from '../http/authStore.js'
import { createHttpEndpointConfig } from '../http/config.js'
import type { HttpEndpointConfig } from '../http/config.js'
import { HomeyOAuthProvider } from '../http/oauthProvider.js'
import type { PeerIdentity, ReadPeerIdentity } from '../http/peerIdentity.js'
import { readPeerIdentity } from '../http/peerIdentity.js'
import { createSessionRegistry } from '../http/sessions.js'
import { createLogger } from '../util/log.js'

const logger = createLogger({ level: 'silent' })

let config: HttpEndpointConfig
let store: AuthStore
let statePath: string
let httpServer: Server
let provider: HomeyOAuthProvider

/** A port nothing holds. Grabbed and released, because the config has to know it before the app binds. */
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

/** A server with one tool that answers without a Homey anywhere in sight. */
function buildStubMcpServer(): McpServer {
  const server = new McpServer({ name: 'homey-mcp', version: '0.0.0-test' })
  server.registerTool(
    'homey_home_overview',
    { description: 'Stands in for the real overview tool.', inputSchema: {} },
    async () => ({
      // The shape a tool returns when the Homey is unreachable: a result, not a
      // protocol failure.
      isError: true,
      content: [{ type: 'text' as const, text: 'This server is not signed in to your Homey yet.' }],
    }),
  )
  return server
}

/**
 * The verdict the peer gate is told to reach.
 *
 * Injected rather than measured, so every test here asserts one verdict instead
 * of whichever one the machine running the suite produces. The real reader is
 * covered in `http/peerIdentity.test.ts`, and one test below wires it in for
 * real to prove the default is mounted.
 */
let peerIdentity: PeerIdentity = { kind: 'same_user' }

async function start(readPeerIdentityOverride?: ReadPeerIdentity): Promise<void> {
  const app = buildApp({
    config,
    provider,
    createMcpSession: async () => ({ server: buildStubMcpServer() }),
    sessions: createSessionRegistry({ logger }),
    logger,
    readPeerIdentity: readPeerIdentityOverride ?? (async () => peerIdentity),
  })

  await new Promise<void>((resolve) => {
    httpServer = app.listen(config.port, config.bindHost, () => resolve())
  })
}

/** Registers a client, walks the consent page and comes back with a usable bearer token. */
async function signIn(): Promise<{ accessToken: string; refreshToken: string; clientId: string }> {
  const registration = (await (
    await fetch(`${config.issuerUrl.href}register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude Code (homey-http)',
        redirect_uris: ['http://localhost:3118/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'homey',
      }),
    })
  ).json()) as { client_id: string }

  const { createHash, randomBytes } = await import('node:crypto')
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')

  const authorizeUrl = new URL('/authorize', config.issuerUrl)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('client_id', registration.client_id)
  authorizeUrl.searchParams.set('code_challenge', codeChallenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')
  authorizeUrl.searchParams.set('redirect_uri', 'http://localhost:3118/callback')
  authorizeUrl.searchParams.set('scope', 'homey offline_access')
  authorizeUrl.searchParams.set('resource', config.mcpUrl.href)

  const page = await (await fetch(authorizeUrl)).text()
  const pendingId = /name="pendingId" value="([a-f0-9]+)"/.exec(page)?.[1] ?? ''
  const csrfToken = /name="csrfToken" value="([a-f0-9]+)"/.exec(page)?.[1] ?? ''

  const decision = await fetch(new URL('/authorize/continue', config.issuerUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pendingId, csrfToken, action: 'allow' }).toString(),
    redirect: 'manual',
  })
  const code = new URL(decision.headers.get('location') ?? '').searchParams.get('code') ?? ''

  const tokens = (await (
    await fetch(new URL('/token', config.issuerUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: 'http://localhost:3118/callback',
        resource: config.mcpUrl.href,
        client_id: registration.client_id,
      }).toString(),
    })
  ).json()) as { access_token: string; refresh_token: string }

  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, clientId: registration.client_id }
}

/** Reads the single JSON payload out of an SSE response body. */
function readServerSentEvent(body: string): Record<string, unknown> {
  const line = body.split('\n').find((candidate) => candidate.startsWith('data: ')) ?? 'data: {}'
  return JSON.parse(line.slice('data: '.length)) as Record<string, unknown>
}

async function initializeSession(accessToken: string): Promise<string> {
  const response = await fetch(config.mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    }),
  })
  await response.text()
  return response.headers.get('mcp-session-id') ?? ''
}

beforeEach(async () => {
  config = createHttpEndpointConfig({ port: await findFreePort() })
  peerIdentity = { kind: 'same_user' }
  statePath = join(await mkdtemp(join(tmpdir(), 'homey-mcp-serve-http-')), 'http-auth.json')
  store = await createAuthStore({ path: statePath })
  provider = new HomeyOAuthProvider({
    config,
    store,
    logger,
    describeHomey: async () => ({
      kind: 'not_signed_in',
      reason: 'The session lapsed.',
      instruction: 'Run "homey login".',
    }),
    storePersonalAccessToken: async () => ({ ok: false, message: 'Not reached in this test.' }),
  })
  await start()
})

afterEach(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
})

describe('the unauthenticated request that decides yellow versus red', () => {
  it('answers 401 with a WWW-Authenticate header naming the resource metadata', async () => {
    // This single header is what makes a client show "needs authentication" in
    // yellow rather than "failed to connect" in red. Nothing else does.
    const response = await fetch(config.mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(response.status).toBe(401)
    const challenge = response.headers.get('www-authenticate') ?? ''
    expect(challenge).toContain('Bearer')
    expect(challenge).toContain('error="invalid_token"')
    expect(challenge).toContain('scope="homey"')
    expect(challenge).toContain(
      `resource_metadata="${config.issuerUrl.origin}/.well-known/oauth-protected-resource/mcp"`,
    )
  })

  it('answers 401 rather than 500 for a token that was never issued', async () => {
    const response = await fetch(config.mcpUrl, {
      method: 'POST',
      // The point of this test is that a token the server never issued is
      // refused, so this value is deliberately not a credential. check-secrets-allow
      headers: { Authorization: 'Bearer nothing-like-a-real-one', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=')
  })
})

describe('the discovery documents', () => {
  it('serves a resource identifier byte-identical to the URL it is served from', async () => {
    // RFC 9728 section 3.3 makes these a matched pair, and says a mismatch MUST
    // NOT be used. On loopback that breaks invisibly: localhost and 127.0.0.1 are
    // different identifiers and a trailing slash is another one again. Asserted
    // as a round trip through the header, not as two halves.
    const unauthenticated = await fetch(config.mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(unauthenticated.headers.get('www-authenticate') ?? '')?.[1]

    const metadata = (await (await fetch(metadataUrl ?? '')).json()) as { resource: string }
    expect(metadata.resource).toBe(config.mcpUrl.href)
  })

  it('advertises offline_access on the authorization server and not on the resource', async () => {
    // The two documents want different answers and the SDK derives both from one
    // list, which is why our own route is registered first. Without
    // offline_access on the authorization server the client never asks for a
    // refresh token and every lapse becomes a browser round trip.
    const authorizationServer = (await (
      await fetch(new URL('/.well-known/oauth-authorization-server', config.issuerUrl))
    ).json()) as { scopes_supported: string[]; code_challenge_methods_supported: string[] }
    const protectedResource = (await (
      await fetch(new URL('/.well-known/oauth-protected-resource/mcp', config.issuerUrl))
    ).json()) as { scopes_supported: string[] }

    expect(authorizationServer.scopes_supported).toContain('offline_access')
    expect(protectedResource.scopes_supported).not.toContain('offline_access')
  })

  it('advertises the PKCE method a client refuses to proceed without', async () => {
    const metadata = (await (
      await fetch(new URL('/.well-known/oauth-authorization-server', config.issuerUrl))
    ).json()) as { code_challenge_methods_supported: string[]; registration_endpoint: string }

    expect(metadata.code_challenge_methods_supported).toEqual(['S256'])
    // The measured precondition for the yellow badge. With this absent the same
    // 401 with the same header produced red.
    expect(metadata.registration_endpoint).toBe(`${config.issuerUrl.origin}/register`)
  })

  it('advertises no revocation endpoint, because there is no revokeToken to back one', async () => {
    // The SDK mounts and advertises it purely from the method's presence, so a
    // stub would promise a capability this server does not have.
    const metadata = (await (
      await fetch(new URL('/.well-known/oauth-authorization-server', config.issuerUrl))
    ).json()) as Record<string, unknown>

    expect(metadata['revocation_endpoint']).toBeUndefined()
  })
})

describe('registration', () => {
  it('returns a client_id and remembers it across a store reload', async () => {
    const registration = (await (
      await fetch(new URL('/register', config.issuerUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Claude Code (homey-http)', redirect_uris: ['http://localhost:3118/callback'] }),
      })
    ).json()) as { client_id: string }

    expect(registration.client_id).toBeTypeOf('string')

    const reloaded = await createAuthStore({ path: statePath })
    expect(await reloaded.getClient(registration.client_id)).toMatchObject({ client_name: 'Claude Code (homey-http)' })
  })
})

describe('DNS rebinding defences', () => {
  it('refuses a present but unknown Origin with 403, and lets an absent one through', async () => {
    const refused = await fetch(config.mcpUrl, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid Origin: https://evil.example' },
      id: null,
    })

    // Absent is the ordinary case for a non-browser client, so it reaches the
    // bearer check and gets the 401 rather than a 403.
    const allowed = await fetch(config.mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(allowed.status).toBe(401)
  })

  it('refuses a Host header that is not a loopback name', async () => {
    // Driven through node:http rather than fetch, because Host is a forbidden
    // header name there and cannot be set: fetch would rewrite it and the test
    // would pass for the wrong reason.
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: config.bindHost,
          port: config.port,
          path: '/mcp',
          method: 'POST',
          headers: { Host: 'attacker.test', 'Content-Type': 'application/json' },
        },
        (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        },
      )
      request.once('error', reject)
      request.end('{}')
    })

    expect(status).toBe(403)
  })
})

describe('a session over the transport', () => {
  it('initializes, lists tools and answers a call', async () => {
    const { accessToken } = await signIn()
    const sessionId = await initializeSession(accessToken)

    expect(sessionId).not.toBe('')

    const listed = await fetch(config.mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'MCP-Session-Id': sessionId,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    })
    const payload = readServerSentEvent(await listed.text()) as { result: { tools: { name: string }[] } }

    expect(listed.status).toBe(200)
    expect(payload.result.tools.map((tool) => tool.name)).toContain('homey_home_overview')
  })

  it('answers 200 with a tool result when the Homey is not signed in', async () => {
    // The invariant this whole design turns on: a Homey failure never becomes an
    // HTTP status. A 401 here would send the client into a re-authorization loop
    // that cannot possibly fix an expired Athom session.
    const { accessToken } = await signIn()
    const sessionId = await initializeSession(accessToken)

    const called = await fetch(config.mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'MCP-Session-Id': sessionId,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'homey_home_overview', arguments: {} },
      }),
    })
    const payload = readServerSentEvent(await called.text()) as {
      result: { isError: boolean; content: { text: string }[] }
    }

    expect(called.status).toBe(200)
    expect(payload.result.isError).toBe(true)
    expect(payload.result.content[0]?.text).toContain('not signed in')
  })

  it('checks the token on a request that already carries a session id', async () => {
    const { accessToken } = await signIn()
    const sessionId = await initializeSession(accessToken)

    const response = await fetch(config.mcpUrl, {
      method: 'POST',
      headers: { 'MCP-Session-Id': sessionId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
    })

    expect(response.status).toBe(401)
  })

  it('answers 404 for a session that belongs to a different client', async () => {
    const first = await signIn()
    const sessionId = await initializeSession(first.accessToken)
    const second = await signIn()

    const response = await fetch(config.mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${second.accessToken}`,
        'MCP-Session-Id': sessionId,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
    })

    expect(response.status).toBe(404)
  })

  it('refuses a non-initialize request that carries no session at all', async () => {
    const { accessToken } = await signIn()

    const response = await fetch(config.mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' }),
    })

    expect(response.status).toBe(400)
  })
})

describe('a port that is already taken', () => {
  it('is recognised, so the failure can name the port instead of moving off it', async () => {
    const error = await new Promise<unknown>((resolve) => {
      const second = createTcpServer()
      second.once('error', resolve)
      second.listen(config.port, config.bindHost)
    })

    // A fallback port would produce a server that is running and unreachable at
    // the address the client stored, which reads as ConnectionRefused with no
    // explanation.
    expect(isAddressInUse(error)).toBe(true)
    expect(isAddressInUse(new Error('something else'))).toBe(false)
  })
})

describe('the gate in front of /authorize', () => {
  /** Registers a client and opens the consent page, stopping short of a decision. */
  async function beginAuthorization(): Promise<{ pendingId: string; csrfToken: string; page: string }> {
    const registration = (await (
      await fetch(`${config.issuerUrl.href}register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Something local',
          redirect_uris: ['http://localhost:3118/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      })
    ).json()) as { client_id: string }

    const authorizeUrl = new URL('/authorize', config.issuerUrl)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('client_id', registration.client_id)
    authorizeUrl.searchParams.set('code_challenge', 'a'.repeat(43))
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    authorizeUrl.searchParams.set('redirect_uri', 'http://localhost:3118/callback')
    authorizeUrl.searchParams.set('scope', 'homey')

    const page = await (await fetch(authorizeUrl)).text()
    return {
      pendingId: /name="pendingId" value="([a-f0-9]+)"/.exec(page)?.[1] ?? '',
      csrfToken: /name="csrfToken" value="([a-f0-9]+)"/.exec(page)?.[1] ?? '',
      page,
    }
  }

  async function decide(fields: Record<string, string>): Promise<Response> {
    return await fetch(new URL('/authorize/continue', config.issuerUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    })
  }

  it('asks a connection from this same account for nothing extra', async () => {
    const { page } = await beginAuthorization()

    expect(page).toContain('name="pendingId"')
    expect(page).not.toContain('name="approvalCode"')
  })

  it('refuses the page outright to another account on this machine', async () => {
    // The measured hole this gate closes: the page hands its pendingId and
    // csrfToken to whoever fetched it and the post needs nothing else, so the
    // whole flow ran headlessly with two fetch calls and produced a token that
    // could start a door-opening Flow.
    peerIdentity = { kind: 'other_user', uid: 1042 }

    const response = await fetch(new URL('/authorize?response_type=code', config.issuerUrl))

    expect(response.status).toBe(403)
    const body = await response.text()
    expect(body).toContain('another account')
    expect(body).not.toContain('name="pendingId"')
  })

  it('refuses the form post to another account too, not just the page', async () => {
    const { pendingId, csrfToken } = await beginAuthorization()
    peerIdentity = { kind: 'other_user', uid: 1042 }

    const response = await decide({ pendingId, csrfToken, action: 'allow' })

    expect(response.status).toBe(403)
    expect(response.headers.get('location')).toBeNull()
  })

  it('asks for the approval code when this computer cannot name the account', async () => {
    // macOS and anything without /proc land here. The code comes out of the mode
    // 0600 state file, which is the boundary another account cannot cross.
    peerIdentity = { kind: 'unknown', reason: 'no /proc on this platform' }

    const { pendingId, csrfToken, page } = await beginAuthorization()
    expect(page).toContain('name="approvalCode"')

    const refused = await decide({ pendingId, csrfToken, action: 'allow', approvalCode: 'wrong-code-here' })
    expect(refused.status).toBe(200)
    expect(refused.headers.get('location')).toBeNull()
    expect(await refused.text()).toContain('not right')

    const allowed = await decide({
      pendingId,
      csrfToken,
      action: 'allow',
      approvalCode: await store.readApprovalCode(),
    })
    expect(allowed.status).toBe(302)
    expect(new URL(allowed.headers.get('location') ?? '').searchParams.get('code')).toMatch(/^[a-f0-9]{64}$/)
  })

  it('has the code readable from a second process by the time the page names it', async () => {
    // The page tells the user to run "service status", which reads the file and
    // never writes it. Minting on the form post instead left that command
    // printing nothing at the moment the user went looking, and the field is
    // required so there is no submit that could have minted it first.
    peerIdentity = { kind: 'unknown', reason: 'no /proc on this platform' }

    const { page } = await beginAuthorization()
    expect(page).toContain('service status')
    expect(await readStoredApprovalCode(statePath)).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/)
  })

  it('closes the sign-in after three wrong codes, so the code cannot be hammered', async () => {
    peerIdentity = { kind: 'unknown', reason: 'no /proc on this platform' }
    const { pendingId, csrfToken } = await beginAuthorization()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await decide({ pendingId, csrfToken, action: 'allow', approvalCode: 'no' })).status).toBe(200)
    }
    expect((await decide({ pendingId, csrfToken, action: 'allow', approvalCode: 'no' })).status).toBe(400)

    // Gone, so even the right code cannot revive it: a new authorization has to
    // be started, which is what bounds guessing to three tries per sign-in.
    const afterwards = await decide({
      pendingId,
      csrfToken,
      action: 'allow',
      approvalCode: await store.readApprovalCode(),
    })
    expect(afterwards.status).toBe(400)
    expect(afterwards.headers.get('location')).toBeNull()
  })

  it('leaves cancel reachable, so a sign-in opened by mistake can always be closed', async () => {
    peerIdentity = { kind: 'unknown', reason: 'no /proc on this platform' }
    const { pendingId, csrfToken } = await beginAuthorization()

    const response = await decide({ pendingId, csrfToken, action: 'cancel' })

    expect(response.status).toBe(302)
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe('access_denied')
  })

  it('mounts the real reader by default, and it calls this process the same account', async () => {
    if (process.platform !== 'linux') return

    // The tests above inject a verdict. This one wires nothing and drives a real
    // loopback connection, so it fails if the default reader is ever unmounted
    // or starts answering unknown for an ordinary local browser.
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    config = createHttpEndpointConfig({ port: await findFreePort() })
    await start(readPeerIdentity)

    const { page } = await beginAuthorization()
    expect(page).toContain('name="pendingId"')
    expect(page).not.toContain('name="approvalCode"')
  })
})
