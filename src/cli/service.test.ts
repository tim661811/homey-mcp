import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createAuthStore, httpAuthStatePath } from '../http/authStore.js'
import { buildServiceDefinition, runService } from './service.js'

const COMMON = {
  port: 8431,
  homeDirectory: '/home/someone',
  nodePath: '/usr/local/bin/node',
  entryPointPath: '/opt/homey-mcp/dist/index.js',
}

describe('buildServiceDefinition', () => {
  it('names the absolute path of the Node running now, never the bare word node', () => {
    // The reason this project already paid for once: a supervisor starts a
    // process with its own environment, and nvm is not on it. A unit saying
    // "node" starts whatever /usr/bin/node happens to be, or nothing at all.
    const definition = buildServiceDefinition({ ...COMMON, platformName: 'linux' })

    expect(definition.contents).toContain('ExecStart=/usr/local/bin/node /opt/homey-mcp/dist/index.js serve --http --port 8431')
    expect(definition.contents).not.toMatch(/ExecStart=node /)
  })

  it('records the chosen port rather than leaving it to be guessed on restart', () => {
    const definition = buildServiceDefinition({ ...COMMON, port: 9001, platformName: 'linux' })

    expect(definition.contents).toContain('--port 9001')
    expect(definition.port).toBe(9001)
  })

  it('restarts itself, because a stopped daemon is a red cross in the client', () => {
    const definition = buildServiceDefinition({ ...COMMON, platformName: 'linux' })

    expect(definition.contents).toContain('Restart=always')
    expect(definition.contents).toContain('WantedBy=default.target')
  })

  it('writes a user unit, not a system one', () => {
    const definition = buildServiceDefinition({ ...COMMON, platformName: 'linux' })

    expect(definition.path).toBe('/home/someone/.config/systemd/user/homey-mcp.service')
    expect(definition.activationCommands[0]).toEqual(['systemctl', '--user', 'daemon-reload'])
  })

  it('writes a LaunchAgent on macOS, keeping it alive and starting it at login', () => {
    const definition = buildServiceDefinition({ ...COMMON, platformName: 'darwin' })

    expect(definition.kind).toBe('launchd_agent')
    expect(definition.path).toBe('/home/someone/Library/LaunchAgents/dev.homey-mcp.plist')
    expect(definition.contents).toContain('<key>KeepAlive</key>')
    expect(definition.contents).toContain('<key>RunAtLoad</key>')
    expect(definition.contents).toContain('<string>/usr/local/bin/node</string>')
  })

  it('says plainly that it has nothing to write on a platform nobody has verified', () => {
    // Windows would need a Scheduled Task. Shipping one nobody has run on real
    // hardware turns into an unreproducible bug report, which is exactly the
    // class of thing this project's hardware policy refuses.
    const definition = buildServiceDefinition({ ...COMMON, platformName: 'win32' })

    expect(definition.kind).toBe('unsupported')
    expect(definition.path).toBeNull()
    expect(definition.activationCommands).toEqual([])
  })
})

describe('service status', () => {
  it('prints the approval code, which is the one thing only this account can read', async () => {
    // The code stands in for the peer check on a platform whose kernel will not
    // say which account a loopback connection came from. Being able to read the
    // mode 0600 state file IS the proof of ownership, so the command that reads
    // it is where the code is shown.
    const configHome = await mkdtemp(join(tmpdir(), 'homey-mcp-service-'))
    const environment = { XDG_CONFIG_HOME: configHome }
    const store = await createAuthStore({ port: 8431, environment })
    const code = await store.readApprovalCode()

    let written = ''
    const output = { write: (chunk: string) => { written += chunk; return true } } as NodeJS.WritableStream
    await runService({ verb: 'status', environment, homeDirectory: configHome, output })

    expect(written).toContain(code)
  })

  it('prints no code before a server has ever minted one, and writes nothing', async () => {
    // Writing this file from a second process would clobber whatever the running
    // server holds in memory, which is the same reason doctor registers nothing.
    const configHome = await mkdtemp(join(tmpdir(), 'homey-mcp-service-'))
    const environment = { XDG_CONFIG_HOME: configHome }

    let written = ''
    const output = { write: (chunk: string) => { written += chunk; return true } } as NodeJS.WritableStream
    await runService({ verb: 'status', environment, homeDirectory: configHome, output })

    expect(written).not.toContain('approval code')
    expect(existsSync(httpAuthStatePath({ port: 8431, environment, homeDirectory: configHome }))).toBe(false)
  })
})
