import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { describeHomeySignIn, verifyAndStorePersonalAccessToken } from './homeySignIn.js'
import { HomeyMcpError } from '../homey/errors.js'
import type { HomeyIdentity } from '../homey/types.js'

const IDENTITY: HomeyIdentity = {
  id: 'homeyidentifier000000001',
  name: 'Home',
  modelName: 'Homey Pro (Early 2019)',
  modelId: 'homey4d',
  softwareVersion: '13.2.4',
  address: 'http://127.0.0.1',
  addressKind: 'local',
  timezone: 'Europe/Amsterdam',
  language: '',
} as unknown as HomeyIdentity

let configPath: string
let homeDirectory: string

beforeEach(async () => {
  homeDirectory = await mkdtemp(join(tmpdir(), 'homey-mcp-signin-'))
  configPath = join(homeDirectory, 'credentials.json')
})

describe('describeHomeySignIn', () => {
  it('reports the hub when signing in works', async () => {
    const state = await describeHomeySignIn({
      connection: { authenticated: true, authenticate: async () => IDENTITY },
      environment: { HOMEY_HOME: join(homeDirectory, 'nothing-here') },
    })

    expect(state).toMatchObject({ kind: 'signed_in', homeyName: 'Home', firmware: '13.2.4' })
  })

  it('names "homey login" when the CLI has never signed in on this machine', async () => {
    const state = await describeHomeySignIn({
      connection: {
        authenticated: false,
        authenticate: async () => {
          throw new HomeyMcpError('not_connected', 'No Homey credentials were found.')
        },
      },
      environment: { HOMEY_HOME: join(homeDirectory, 'nothing-here') },
    })

    expect(state.kind).toBe('not_signed_in')
    if (state.kind !== 'not_signed_in') return
    expect(state.instruction).toContain('homey login')
    expect(state.reason).toContain('No Homey credentials were found')
  })

  it('says the session did not open, rather than that there is none, when a file exists', async () => {
    // The two look identical from outside and have different fixes. Naming which
    // one it is is the difference between one command and an afternoon.
    const cliHome = join(homeDirectory, 'athom-cli')
    await mkdir(cliHome, { recursive: true })
    await writeFile(
      join(cliHome, 'settings.json'),
      JSON.stringify({
        homeyApi: {
          // A synthetic value in a fixture, token-shaped on purpose because the
          // code under test reads it as one. check-secrets-allow
          token: { token_type: 'bearer', access_token: 'cD4fGh1jcD4fGh1jcD4fGh1j', refresh_token: null, expires_in: 3660, grant_type: null },
        },
      }),
    )

    const state = await describeHomeySignIn({
      connection: {
        authenticated: false,
        authenticate: async () => {
          throw new HomeyMcpError('not_connected', 'The session was refused.')
        },
      },
      environment: { HOMEY_HOME: cliHome },
    })

    expect(state.kind).toBe('not_signed_in')
    if (state.kind !== 'not_signed_in') return
    expect(state.instruction).toContain('did not open')
  })

  it('re-reads the credential source rather than trusting a flag', async () => {
    // A "homey login" that happened thirty seconds ago in another terminal has to
    // become visible without restarting anything, which is what pressing Check
    // again is for.
    const authenticate = vi.fn(async () => IDENTITY)

    await describeHomeySignIn({
      connection: { authenticated: false, authenticate },
      environment: { HOMEY_HOME: join(homeDirectory, 'nothing') },
    })

    expect(authenticate).toHaveBeenCalledOnce()
  })
})

describe('verifyAndStorePersonalAccessToken', () => {
  const token = 'pat-value-that-must-never-leak'

  it('merges into an existing credentials file rather than replacing it', async () => {
    // The shadowing trap. resolveCredentials stops at the first readable
    // credentials file, so a file rewritten with only a token in it would shadow
    // everything already recorded there, permanently. Same shape as the rule that
    // the address cache must be merged, never overwritten.
    await writeFile(
      configPath,
      JSON.stringify({ homeyId: 'homeyidentifier000000001', localSecureAddress: 'https://example.homeylocal.test' }),
    )

    const result = await verifyAndStorePersonalAccessToken({
      personalAccessToken: token,
      configPath,
      verifyImplementation: async () => IDENTITY,
    })

    expect(result.ok).toBe(true)
    const stored = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    expect(stored['homeyId']).toBe('homeyidentifier000000001')
    expect(stored['localSecureAddress']).toBe('https://example.homeylocal.test')
    expect(stored['personalAccessToken']).toBe(token)
  })

  it('writes nothing at all when the token did not verify against the hub', async () => {
    // setup already established the rule: an unverified credential on disk turns
    // "you are not set up" into "something is broken", which is a much worse
    // place to debug from.
    const result = await verifyAndStorePersonalAccessToken({
      personalAccessToken: token,
      configPath,
      verifyImplementation: async () => {
        throw new HomeyMcpError('not_connected', 'Athom refused that token.')
      },
    })

    expect(result.ok).toBe(false)
    await expect(readFile(configPath, 'utf8')).rejects.toThrow()
  })

  it('never returns the token, on either path', async () => {
    const good = await verifyAndStorePersonalAccessToken({
      personalAccessToken: token,
      configPath,
      verifyImplementation: async () => IDENTITY,
    })
    const bad = await verifyAndStorePersonalAccessToken({
      personalAccessToken: token,
      configPath: join(homeDirectory, 'other.json'),
      verifyImplementation: async () => {
        throw new HomeyMcpError('not_connected', 'Athom refused that token.')
      },
    })

    expect(good.message).not.toContain(token)
    expect(bad.message).not.toContain(token)
  })

  it('writes the credentials file readable only by its owner', async () => {
    await verifyAndStorePersonalAccessToken({
      personalAccessToken: token,
      configPath,
      verifyImplementation: async () => IDENTITY,
    })

    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
  })

  it('refuses an empty submission without reaching the hub', async () => {
    const verify = vi.fn()
    const result = await verifyAndStorePersonalAccessToken({
      personalAccessToken: '   ',
      configPath,
      verifyImplementation: verify as never,
    })

    expect(result.ok).toBe(false)
    expect(verify).not.toHaveBeenCalled()
  })
})
