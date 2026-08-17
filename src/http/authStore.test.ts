import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import { beforeEach, describe, expect, it } from 'vitest'

import type { StoredTokenRecord } from './authStore.js'
import {
  createAuthStore,
  hashToken,
  httpAuthStatePath,
  mintOpaqueSecret,
  readStoredApprovalCode,
} from './authStore.js'

let statePath: string

const CLIENT: OAuthClientInformationFull = {
  client_id: 'client-one',
  client_name: 'Claude Code (homey-http)',
  redirect_uris: ['http://localhost:3118/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  scope: 'homey',
}

/** Anchored to now, because the store prunes anything already expired on read and on write. */
function tokenRecord(overrides: Partial<StoredTokenRecord> = {}): StoredTokenRecord {
  const issuedAtSeconds = Math.floor(Date.now() / 1_000)
  return {
    clientId: 'client-one',
    scopes: ['homey'],
    resource: 'http://127.0.0.1:8431/mcp',
    issuedAtSeconds,
    expiresAtSeconds: issuedAtSeconds + 3_600,
    ...overrides,
  }
}

beforeEach(async () => {
  statePath = join(await mkdtemp(join(tmpdir(), 'homey-mcp-auth-')), 'http-auth.json')
})

describe('httpAuthStatePath', () => {
  it('is its own file, never credentials.json', () => {
    // resolveCredentials stops at the first readable credentials file, so OAuth
    // bookkeeping written there would shadow the Homey CLI session and leave the
    // next start with nothing to sign in with. Same reason the address cache is
    // its own file.
    const path = httpAuthStatePath({
      port: 8431,
      environment: { XDG_CONFIG_HOME: '/x/config' },
      homeDirectory: '/home/someone',
    })
    expect(path).toBe('/x/config/homey-mcp/http-auth-8431.json')
    expect(path).not.toContain('credentials.json')
  })

  it('falls back to ~/.config when XDG_CONFIG_HOME is not set', () => {
    expect(httpAuthStatePath({ port: 8431, environment: {}, homeDirectory: '/home/someone' })).toBe(
      '/home/someone/.config/homey-mcp/http-auth-8431.json',
    )
  })

  it('gives two ports two files, so a second server cannot erase the first one\'s clients', () => {
    // Measured before this: both servers loaded one file at startup and rewrote
    // it wholesale, so registering a client on 8532 removed the client 8531 had
    // stored. A client that already holds a client_id never registers again, so
    // it then answered invalid_client forever with nothing prompting it to
    // recover. Starting a second server is what portInUseMessage recommends.
    const environment = { XDG_CONFIG_HOME: '/x/config' }
    expect(httpAuthStatePath({ port: 8431, environment, homeDirectory: '/home/someone' })).not.toBe(
      httpAuthStatePath({ port: 8432, environment, homeDirectory: '/home/someone' }),
    )
  })

  it('refuses to guess a path when neither a port nor a path is given', async () => {
    await expect(createAuthStore({})).rejects.toThrow(/needs the port/)
  })
})

describe('createAuthStore', () => {
  it('creates the file readable only by its owner', async () => {
    const store = await createAuthStore({ path: statePath })
    await store.putClient(CLIENT)

    expect((await stat(statePath)).mode & 0o777).toBe(0o600)
  })

  it('corrects an existing file that was left readable by everybody', async () => {
    await writeFile(statePath, '{}\n')
    await chmod(statePath, 0o644)

    const store = await createAuthStore({ path: statePath })
    await store.putClient(CLIENT)

    expect((await stat(statePath)).mode & 0o777).toBe(0o600)
  })

  it('keeps a registered client across a reload, because the client never registers twice', async () => {
    // Measured against a real client: after the first registration it stores the
    // client_id and never calls /register again. A client table that did not
    // survive a restart would leave it authenticating as a client this server
    // has forgotten.
    const first = await createAuthStore({ path: statePath })
    await first.putClient(CLIENT)

    const second = await createAuthStore({ path: statePath })
    expect(await second.getClient('client-one')).toMatchObject({ client_id: 'client-one' })
  })

  it('stores a token as a hash and never as the token itself', async () => {
    const store = await createAuthStore({ path: statePath })
    const token = mintOpaqueSecret()
    await store.putAccessToken(token, tokenRecord())

    const contents = await readFile(statePath, 'utf8')
    expect(contents).not.toContain(token)
    expect(contents).toContain(hashToken(token))
    expect(await store.readAccessToken(token)).toMatchObject({ clientId: 'client-one' })
  })

  it('keeps tokens across a reload, so a service restart is not a re-authorization', async () => {
    const token = mintOpaqueSecret()
    const first = await createAuthStore({ path: statePath })
    await first.putAccessToken(token, tokenRecord())

    const second = await createAuthStore({ path: statePath })
    expect(await second.readAccessToken(token)).toMatchObject({ scopes: ['homey'] })
  })

  it('consumes a refresh token so a second use finds nothing', async () => {
    const store = await createAuthStore({ path: statePath })
    const token = mintOpaqueSecret()
    await store.putRefreshToken(token, tokenRecord())

    expect(await store.consumeRefreshToken(token, 'client-one')).toMatchObject({ clientId: 'client-one' })
    expect(await store.consumeRefreshToken(token, 'client-one')).toBeUndefined()
  })

  it('leaves a refresh token alone when the client asking for it does not own it', async () => {
    // /token authenticates a public client on an unproven client_id, so consuming
    // first and checking ownership afterwards let anyone destroy a token they
    // hold but do not own. The owner's next silent refresh then became a browser
    // round trip with nothing saying why.
    const store = await createAuthStore({ path: statePath })
    const token = mintOpaqueSecret()
    await store.putRefreshToken(token, tokenRecord())

    expect(await store.consumeRefreshToken(token, 'someone-else')).toBeUndefined()
    expect(await store.consumeRefreshToken(token, 'client-one')).toMatchObject({ clientId: 'client-one' })
  })

  it('mints one approval code and keeps it across a reload', async () => {
    const first = await createAuthStore({ path: statePath })
    const code = await first.readApprovalCode()

    expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/)
    expect(await first.readApprovalCode()).toBe(code)

    const second = await createAuthStore({ path: statePath })
    expect(await second.readApprovalCode()).toBe(code)
  })

  it('reads an approval code from disk without writing one', async () => {
    // service status is a second process, and a second process that writes this
    // file clobbers whatever the running server holds in memory.
    expect(await readStoredApprovalCode(statePath)).toBeNull()
    expect(existsSync(statePath)).toBe(false)

    const store = await createAuthStore({ path: statePath })
    const code = await store.readApprovalCode()
    expect(await readStoredApprovalCode(statePath)).toBe(code)
  })

  it('prunes an expired token on read rather than handing it back', async () => {
    let nowMs = 1_000_000
    const store = await createAuthStore({ path: statePath, now: () => nowMs })
    const token = mintOpaqueSecret()
    await store.putAccessToken(token, tokenRecord({ issuedAtSeconds: 1_000, expiresAtSeconds: 1_100 }))

    nowMs = 1_200 * 1_000
    expect(await store.readAccessToken(token)).toBeUndefined()
  })

  it('starts empty rather than failing when the file is not usable JSON', async () => {
    // Everything in this file is re-obtainable by clicking Authenticate once, so
    // a corrupt one is not worth refusing to start over.
    await writeFile(statePath, 'not json at all')
    const store = await createAuthStore({ path: statePath })
    expect(await store.countClients()).toBe(0)
  })

  it('reports counts without ever exposing a value', async () => {
    const store = await createAuthStore({ path: statePath })
    await store.putClient(CLIENT)
    await store.putAccessToken(mintOpaqueSecret(), tokenRecord())
    await store.putRefreshToken(mintOpaqueSecret(), tokenRecord())

    expect(await store.countClients()).toBe(1)
    expect(await store.countLiveTokens()).toEqual({ accessTokens: 1, refreshTokens: 1 })
  })
})
