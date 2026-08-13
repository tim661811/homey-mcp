import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import type { ResolvedCredentials } from './credentials.js'
import { isCloudTokenExpired, isSessionExpired, readHomeyCliSession } from './credentials.js'

// Deliberately not 24 hexadecimal characters: that is the shape of a real Athom
// id, and the repository's secret scanner refuses one in a committed file.
const HOMEY_ID = 'homeyidentifier000000001'
const CLOUD_ACCESS_TOKEN = `${'cD4fGh1j'.repeat(5)}`
const HUB_SESSION_TOKEN = `${'aB3dEf9h'.repeat(8)}`

/** Measured: the CLI's own token lifetime, a little over an hour. */
const CLOUD_TOKEN_LIFETIME_SECONDS = 3_660

let homeDirectory: string
let settingsPath: string

/**
 * The Homey CLI's settings file, in the shape read off an installed CLI. Note
 * what is not in it: no LAN address of any kind, and no issue time for the cloud
 * token, only a relative `expires_in`.
 */
async function writeCliSettings(options: { writtenAt: Date; expiresIn?: number | null }): Promise<void> {
  await writeFile(
    settingsPath,
    JSON.stringify({
      homeyApi: {
        token: {
          token_type: 'bearer',
          access_token: CLOUD_ACCESS_TOKEN,
          refresh_token: `${CLOUD_ACCESS_TOKEN}refresh`,
          ...(options.expiresIn === undefined ? { expires_in: CLOUD_TOKEN_LIFETIME_SECONDS } : { expires_in: options.expiresIn }),
          grant_type: 'authorization_code',
        },
        [`homey-${HOMEY_ID}`]: {
          session: {
            scopes: ['resource', 'account.homeys.readonly', 'homey'],
            intersectedScopes: ['resource', 'homey'],
            createdAt: '2026-08-13T08:00:00.000Z',
            expiresAt: '2026-08-14T08:00:00.000Z',
          },
          token: HUB_SESSION_TOKEN,
        },
      },
      activeHomey: { id: HOMEY_ID, name: 'Home', platform: 'local' },
    }),
  )

  await utimes(settingsPath, options.writtenAt, options.writtenAt)
}

function credentials(overrides: Partial<ResolvedCredentials> = {}): ResolvedCredentials {
  return {
    source: 'homey_cli_session',
    sourceDescription: 'the session stored by the Homey CLI',
    cloudToken: {
      token_type: 'bearer',
      access_token: CLOUD_ACCESS_TOKEN,
      refresh_token: null,
      expires_in: CLOUD_TOKEN_LIFETIME_SECONDS,
      grant_type: null,
    },
    cloudTokenExpiresAt: null,
    personalAccessToken: null,
    homeyId: HOMEY_ID,
    localSessionToken: HUB_SESSION_TOKEN,
    localAddress: null,
    localSecureAddress: null,
    sessionExpiresAt: null,
    scopes: ['homey'],
    configPath: null,
    ...overrides,
  }
}

beforeEach(async () => {
  homeDirectory = await mkdtemp(join(tmpdir(), 'homey-mcp-credentials-'))
  const cliHome = join(homeDirectory, 'athom-cli')
  await mkdir(cliHome, { recursive: true })
  settingsPath = join(cliHome, 'settings.json')
})

describe('readHomeyCliSession', () => {
  it('turns the relative cloud-token lifetime into an absolute expiry', async () => {
    // The file records how long the token lives and never records when it was
    // issued, so the lifetime has to be anchored to something. Without this, the
    // one hour cloud token looked as durable as the 24 hour hub session and got
    // to decide the route on its own.
    const writtenAt = new Date('2026-08-13T10:55:00.000Z')
    await writeCliSettings({ writtenAt })

    const session = await readHomeyCliSession({ environment: { HOMEY_HOME: join(homeDirectory, 'athom-cli') } })

    expect(session?.cloudTokenExpiresAt).toBe(
      new Date(writtenAt.getTime() + CLOUD_TOKEN_LIFETIME_SECONDS * 1_000).toISOString(),
    )
  })

  it('anchors the expiry no earlier than the true one, so the estimate can only ever be late', async () => {
    // The file's modification time cannot precede the write that put the token
    // in it. Erring late costs one cloud attempt that is recovered from; erring
    // early would skip a cloud route that still works.
    const writtenAt = new Date('2026-08-13T10:55:00.000Z')
    await writeCliSettings({ writtenAt })

    const session = await readHomeyCliSession({ environment: { HOMEY_HOME: join(homeDirectory, 'athom-cli') } })

    expect(Date.parse(session?.cloudTokenExpiresAt ?? '')).toBeGreaterThanOrEqual(writtenAt.getTime())
  })

  it('reports no expiry rather than a guessed one when the file states no lifetime', async () => {
    await writeCliSettings({ writtenAt: new Date('2026-08-13T10:55:00.000Z'), expiresIn: null })

    const session = await readHomeyCliSession({ environment: { HOMEY_HOME: join(homeDirectory, 'athom-cli') } })

    expect(session?.cloudTokenExpiresAt).toBeNull()
    // Everything else still reads normally.
    expect(session?.localSessionToken).toBe(HUB_SESSION_TOKEN)
    expect(session?.sessionExpiresAt).toBe('2026-08-14T08:00:00.000Z')
  })
})

describe('isCloudTokenExpired', () => {
  it('is true once the recorded expiry has passed', () => {
    expect(
      isCloudTokenExpired(
        credentials({ cloudTokenExpiresAt: '2026-08-13T05:00:00.000Z' }),
        new Date('2026-08-13T06:00:00.000Z'),
      ),
    ).toBe(true)
  })

  it('is false while the token is still alive', () => {
    expect(
      isCloudTokenExpired(
        credentials({ cloudTokenExpiresAt: '2026-08-13T07:00:00.000Z' }),
        new Date('2026-08-13T06:00:00.000Z'),
      ),
    ).toBe(false)
  })

  it('treats an unstated or unreadable lifetime as "not expired", never as expired', () => {
    // "Not stated" is not "dead". Reading it as dead would skip a cloud route
    // that works and report a connection problem that does not exist.
    const now = new Date('2026-08-13T06:00:00.000Z')
    expect(isCloudTokenExpired(credentials({ cloudTokenExpiresAt: null }), now)).toBe(false)
    expect(isCloudTokenExpired(credentials({ cloudTokenExpiresAt: 'not a date' }), now)).toBe(false)
    expect(isCloudTokenExpired(credentials({ cloudToken: null }), now)).toBe(false)
  })

  it('stays independent of the hub session, which outlives it by a day', () => {
    // The whole reason the two are asked separately: measured, the cloud token
    // lives about an hour and the hub session it minted lives 24.
    const now = new Date('2026-08-13T12:00:00.000Z')
    const stale = credentials({
      cloudTokenExpiresAt: '2026-08-13T09:00:00.000Z',
      sessionExpiresAt: '2026-08-14T08:00:00.000Z',
    })

    expect(isCloudTokenExpired(stale, now)).toBe(true)
    expect(isSessionExpired(stale, now)).toBe(false)
  })
})
