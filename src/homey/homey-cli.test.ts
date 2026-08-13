import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CAPTURED_RUN_TIMEOUT_MS,
  findHomeyCli,
  getSelectedHomey,
  INTERACTIVE_RUN_TIMEOUT_MS,
  installHomeyCli,
  isLoggedIn,
  npxHomeyCli,
  readHomeyCliStoredState,
  runInteractive,
  selectHomeyWithCli,
} from './homey-cli.js'
import type { HomeyCliInstallation } from './homey-cli.js'
import { fakeFileSystem, fakeRunner, homeyCliManifest } from '../../tests/fixtures/homey-cli-machine.js'

const NODE = '/opt/node/bin/node'

/** Shorthand: every search in here recognises the package by its manifest. */
const manifest = homeyCliManifest

const NPX_INSTALLATION: HomeyCliInstallation = {
  kind: 'npx_cache',
  path: '/cache/_npx/abc/node_modules/homey/bin/homey.mjs',
  command: NODE,
  commandArguments: ['/cache/_npx/abc/node_modules/homey/bin/homey.mjs'],
  shell: false,
  version: '4.4.2',
  where: 'in the npx cache',
}

// ---------------------------------------------------------------------------

describe('findHomeyCli', () => {
  it('finds the CLI through the shim on PATH and reads its version from the package', async () => {
    const found = await findHomeyCli({
      environment: { PATH: '/usr/local/bin:/usr/bin' },
      platform: 'linux',
      nodeExecutablePath: NODE,
      fileSystem: fakeFileSystem({
        files: {
          '/usr/lib/node_modules/homey/package.json': manifest('4.4.2'),
          '/usr/lib/node_modules/homey/bin/homey.mjs': '#!/usr/bin/env node',
        },
        executables: ['/usr/local/bin/homey'],
        symlinks: { '/usr/local/bin/homey': '/usr/lib/node_modules/homey/bin/homey.mjs' },
      }),
    })

    expect(found?.kind).toBe('path')
    expect(found?.where).toBe('on your PATH')
    expect(found?.version).toBe('4.4.2')
  })

  // The case that a `which homey` check gets wrong, and the reason this module
  // exists at all. On the machine this was developed on the CLI is installed and
  // logged in and sits on no PATH, because it has only ever been run as
  // "npx homey".
  it('finds a CLI that is only in the npx cache, where a PATH check reports nothing', async () => {
    const found = await findHomeyCli({
      environment: { PATH: '/usr/local/bin', npm_config_cache: '/cache' },
      platform: 'linux',
      nodeExecutablePath: NODE,
      fileSystem: fakeFileSystem({
        files: {
          '/cache/_npx/76a0/node_modules/homey/package.json': manifest('4.4.2'),
          '/cache/_npx/76a0/node_modules/homey/bin/homey.mjs': '#!/usr/bin/env node',
        },
      }),
    })

    expect(found?.kind).toBe('npx_cache')
    expect(found?.where).toBe('in the npx cache')
    expect(found?.version).toBe('4.4.2')
  })

  it('scans every npx cache entry rather than hashing the package spec, and takes the newest', async () => {
    // npm keys each entry by a hash of the literal spec, so "homey" and
    // "homey@latest" are different directories and only the one that was
    // actually invoked is populated. Hashing the spec ourselves lands on the
    // empty one, which is exactly why "npx --no-install homey" fails on a
    // machine that has the CLI.
    const found = await findHomeyCli({
      environment: { PATH: '', npm_config_cache: '/cache' },
      platform: 'linux',
      nodeExecutablePath: NODE,
      fileSystem: fakeFileSystem({
        files: {
          '/cache/_npx/2e25/placeholder': '',
          '/cache/_npx/76a0/node_modules/homey/package.json': manifest('4.4.2'),
          '/cache/_npx/76a0/node_modules/homey/bin/homey.mjs': '',
          '/cache/_npx/aaaa/node_modules/homey/package.json': manifest('4.10.0'),
          '/cache/_npx/aaaa/node_modules/homey/bin/homey.mjs': '',
        },
      }),
    })

    expect(found?.version).toBe('4.10.0')
  })

  it('finds a global npm install without asking npm where its root is', async () => {
    const runner = fakeRunner([])

    const found = await findHomeyCli({
      environment: { PATH: '', npm_config_prefix: '/opt/npm-global' },
      platform: 'linux',
      nodeExecutablePath: NODE,
      probeNpmGlobalRoot: true,
      runCommand: runner.run,
      fileSystem: fakeFileSystem({
        files: {
          '/opt/npm-global/lib/node_modules/homey/package.json': manifest('4.4.2'),
          '/opt/npm-global/lib/node_modules/homey/bin/homey.mjs': '',
        },
      }),
    })

    expect(found?.kind).toBe('global_npm')
    expect(runner.requests).toHaveLength(0)
  })

  it('asks npm for its global root only when everything cheaper came up empty', async () => {
    const runner = fakeRunner([{ stdout: '/custom/prefix/lib/node_modules\n' }])

    const found = await findHomeyCli({
      environment: { PATH: '' },
      platform: 'linux',
      nodeExecutablePath: NODE,
      probeNpmGlobalRoot: true,
      runCommand: runner.run,
      fileSystem: fakeFileSystem({
        files: {
          '/custom/prefix/lib/node_modules/homey/package.json': manifest('4.4.2'),
          '/custom/prefix/lib/node_modules/homey/bin/homey.mjs': '',
        },
      }),
    })

    expect(found?.kind).toBe('global_npm')
    expect(runner.requests[0]?.commandArguments).toEqual(['root', '-g'])
  })

  it('never spawns anything when the npm probe is off, which is how doctor calls it', async () => {
    const runner = fakeRunner([])

    const found = await findHomeyCli({
      environment: { PATH: '' },
      platform: 'linux',
      nodeExecutablePath: NODE,
      runCommand: runner.run,
      fileSystem: fakeFileSystem({ files: {} }),
    })

    expect(found).toBeNull()
    expect(runner.requests).toHaveLength(0)
  })

  // Running the script through this process's own Node sidesteps shebangs on one
  // platform and cmd shims on another, and this Node was already checked to be
  // new enough.
  it('invokes the CLI script through this process own Node rather than through a shim', async () => {
    const found = await findHomeyCli({
      environment: { PATH: '', npm_config_cache: '/cache' },
      platform: 'linux',
      nodeExecutablePath: NODE,
      fileSystem: fakeFileSystem({
        files: {
          '/cache/_npx/a/node_modules/homey/package.json': manifest('4.4.2'),
          '/cache/_npx/a/node_modules/homey/bin/homey.mjs': '',
        },
      }),
    })

    expect(found?.command).toBe(NODE)
    expect(found?.commandArguments).toEqual(['/cache/_npx/a/node_modules/homey/bin/homey.mjs'])
    expect(found?.shell).toBe(false)
  })
})

describe('npxHomeyCli', () => {
  it('is the no-install route, and needs a shell only on Windows', () => {
    expect(npxHomeyCli({ platform: 'linux' })).toMatchObject({
      command: 'npx',
      commandArguments: ['--yes', 'homey'],
      shell: false,
    })
    expect(npxHomeyCli({ platform: 'win32' }).shell).toBe(true)
  })
})

describe('isLoggedIn', () => {
  // Measured: with no stored session at all, "homey whoami" does not report that
  // it is signed out. It starts the interactive login, prints a URL, opens a
  // local callback server and blocks on "Paste the code:" forever, and closing
  // stdin does not end it. So the stored session is read first and the CLI is
  // never asked when there is nothing to ask about.
  it('answers from the stored session and spawns nothing when nobody has logged in', async () => {
    const runner = fakeRunner([])

    const state = await isLoggedIn(NPX_INSTALLATION, {
      confirmWithAthom: true,
      runCommand: runner.run,
      readSettings: async () => null,
    })

    expect(state.loggedIn).toBe(false)
    expect(runner.requests).toHaveLength(0)
  })

  it('does not ask Athom unless asked to', async () => {
    const runner = fakeRunner([])

    const state = await isLoggedIn(NPX_INSTALLATION, {
      runCommand: runner.run,
      readSettings: async () => ({
        path: '/home/someone/.athom-cli/settings.json',
        hasCloudToken: true,
        activeHomeyId: 'homey-one',
        activeHomeyName: 'Upstairs',
        storedHomeyCount: 1,
      }),
    })

    expect(state).toMatchObject({ loggedIn: true, fromStoredSessionOnly: true })
    expect(runner.requests).toHaveLength(0)
  })

  it('confirms a stored session with Athom and reports the account', async () => {
    const runner = fakeRunner([{ stdout: JSON.stringify({ id: 'user-1', email: 'someone@example.invalid' }) }])

    const state = await isLoggedIn(NPX_INSTALLATION, {
      confirmWithAthom: true,
      runCommand: runner.run,
      readSettings: async () => ({
        path: '/home/someone/.athom-cli/settings.json',
        hasCloudToken: true,
        activeHomeyId: 'homey-one',
        activeHomeyName: 'Upstairs',
        storedHomeyCount: 1,
      }),
    })

    expect(state).toMatchObject({ loggedIn: true, account: 'someone@example.invalid', fromStoredSessionOnly: false })
    expect(runner.requests[0]?.commandArguments).toEqual([...NPX_INSTALLATION.commandArguments, 'whoami', '--json'])
  })

  // Measured: a stored but invalid token exits 1 with {"error":"Invalid refresh
  // token"} rather than starting a login. That is a different problem from never
  // having signed in, and it needs a different sentence.
  it('separates a session Athom refused from never having signed in', async () => {
    const runner = fakeRunner([{ exitCode: 1, stdout: JSON.stringify({ error: 'Invalid refresh token' }) }])

    const state = await isLoggedIn(NPX_INSTALLATION, {
      confirmWithAthom: true,
      runCommand: runner.run,
      readSettings: async () => ({
        path: '/home/someone/.athom-cli/settings.json',
        hasCloudToken: true,
        activeHomeyId: null,
        activeHomeyName: null,
        storedHomeyCount: 0,
      }),
    })

    expect(state.loggedIn).toBe(false)
    expect(state.sessionRejected).toBe(true)
    expect(state.detail).toContain('Invalid refresh token')
  })

  it('treats a timed out check as a rejected session rather than as a login', async () => {
    const runner = fakeRunner([{ outcome: 'timed_out', exitCode: null, message: 'it was stopped.' }])

    const state = await isLoggedIn(NPX_INSTALLATION, {
      confirmWithAthom: true,
      runCommand: runner.run,
      readSettings: async () => ({
        path: '/home/someone/.athom-cli/settings.json',
        hasCloudToken: true,
        activeHomeyId: 'homey-one',
        activeHomeyName: 'Upstairs',
        storedHomeyCount: 1,
      }),
    })

    expect(state.loggedIn).toBe(false)
    expect(state.detail).toContain('it was stopped.')
  })
})

describe('getSelectedHomey', () => {
  it('reports the active Homey', async () => {
    const runner = fakeRunner((request) =>
      request.commandArguments.includes('current')
        ? { stdout: JSON.stringify({ id: 'homey-one', name: 'Upstairs' }) }
        : { stdout: JSON.stringify([{ id: 'homey-one', name: 'Upstairs', softwareVersion: '13.2.4', state: 'online' }]) },
    )

    const selection = await getSelectedHomey(NPX_INSTALLATION, { runCommand: runner.run })

    expect(selection.status).toBe('selected')
    expect(selection.selected?.name).toBe('Upstairs')
  })

  // Measured, and the reason "homey list --json" cannot answer this on its own:
  // it returns every Homey and marks none of them active, while
  // "homey select current --json" prints a bare null and exits 0. Two Homeys and
  // no selection is an ordinary silent state, not an error.
  it('handles two Homeys with none selected instead of crashing on the null', async () => {
    const runner = fakeRunner((request) =>
      request.commandArguments.includes('current')
        ? { stdout: 'null\n' }
        : {
            stdout: JSON.stringify([
              { id: 'homey-one', name: 'Upstairs' },
              { id: 'homey-two', name: 'The cabin' },
            ]),
          },
    )

    const selection = await getSelectedHomey(NPX_INSTALLATION, { runCommand: runner.run })

    expect(selection.status).toBe('none_selected')
    expect(selection.selected).toBeNull()
    expect(selection.available.map((homey) => homey.name)).toEqual(['Upstairs', 'The cabin'])
  })

  it('says the account has no Homey when the list is empty', async () => {
    const runner = fakeRunner((request) =>
      request.commandArguments.includes('current') ? { stdout: 'null' } : { stdout: '[]' },
    )

    const selection = await getSelectedHomey(NPX_INSTALLATION, { runCommand: runner.run })

    expect(selection.status).toBe('none_available')
  })

  it('does not claim a state it could not read', async () => {
    const runner = fakeRunner([
      { outcome: 'spawn_failed', exitCode: null, message: 'could not be started: ENOENT' },
      { outcome: 'spawn_failed', exitCode: null, message: 'could not be started: ENOENT' },
    ])

    const selection = await getSelectedHomey(NPX_INSTALLATION, { runCommand: runner.run })

    expect(selection.status).toBe('unknown')
    expect(selection.detail).toContain('ENOENT')
  })

  it('selects by id rather than through the interactive picker', async () => {
    const runner = fakeRunner([{}])

    await selectHomeyWithCli(NPX_INSTALLATION, 'homey-two', { runCommand: runner.run })

    expect(runner.requests[0]?.commandArguments).toEqual([
      ...NPX_INSTALLATION.commandArguments,
      'select',
      '--id',
      'homey-two',
    ])
  })
})

describe('installHomeyCli', () => {
  it('refuses to install anything that was not confirmed', async () => {
    const runner = fakeRunner([])

    const result = await installHomeyCli({ confirmed: false, runCommand: runner.run })

    expect(result.installed).toBe(false)
    expect(result.reason).toBe('not_confirmed')
    // The guard is the point: a caller that forgets to ask gets a refusal rather
    // than a global install.
    expect(runner.requests).toHaveLength(0)
  })

  it('runs the exact command it advertises', async () => {
    const runner = fakeRunner([{}])

    const result = await installHomeyCli({ confirmed: true, platform: 'linux', runCommand: runner.run })

    expect(result.installed).toBe(true)
    expect(runner.requests[0]?.command).toBe('npm')
    expect(runner.requests[0]?.commandArguments).toEqual(['install', '--global', 'homey'])
    expect(runner.requests[0]?.shell).toBe(false)
  })

  // npm's own output for this is a wall of stack ending in a path the user
  // cannot write to, which describes the problem truthfully and helps nobody.
  it('turns a permissions failure into the two things that actually fix it', async () => {
    const runner = fakeRunner([
      {
        exitCode: 243,
        stderr: "npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/lib/node_modules/homey",
      },
    ])

    const result = await installHomeyCli({ confirmed: true, platform: 'linux', runCommand: runner.run })

    expect(result.reason).toBe('permission_denied')
    expect(result.message).toContain('npm config set prefix')
    expect(result.message).toContain('npx')
    expect(result.message).not.toContain('npm error syscall')
  })

  it('separates a registry that could not be reached from a permissions problem', async () => {
    const runner = fakeRunner([{ exitCode: 1, stderr: 'npm error code ENOTFOUND' }])

    const result = await installHomeyCli({ confirmed: true, platform: 'linux', runCommand: runner.run })

    expect(result.reason).toBe('network')
  })

  it('reports a timeout as a timeout rather than as a mystery', async () => {
    const runner = fakeRunner([{ outcome: 'timed_out', exitCode: null, durationMs: 300_000 }])

    const result = await installHomeyCli({ confirmed: true, platform: 'linux', runCommand: runner.run })

    expect(result.reason).toBe('timed_out')
    expect(result.message).toContain('300 seconds')
  })
})

describe('runInteractive', () => {
  // The login is a conversation with Athom: it prints a URL, opens a browser and
  // waits. Piping it would hide the prompts the user has to answer, and scraping
  // it would mean handling their credential in this process.
  it('gives the child this terminal and a timeout it cannot outlast', async () => {
    const runner = fakeRunner([{}])

    await runInteractive(NPX_INSTALLATION, ['login'], { runCommand: runner.run })

    expect(runner.requests[0]).toMatchObject({
      mode: 'inherit',
      timeoutMs: INTERACTIVE_RUN_TIMEOUT_MS,
      label: 'homey login',
    })
  })

  it('captures the read-only commands instead, on a much shorter leash', async () => {
    const runner = fakeRunner([{ stdout: 'null' }])

    await getSelectedHomey(NPX_INSTALLATION, { runCommand: runner.run })

    expect(runner.requests[0]).toMatchObject({ mode: 'capture', timeoutMs: CAPTURED_RUN_TIMEOUT_MS })
  })
})

describe('readHomeyCliStoredState', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  /**
   * A settings file in a directory of its own, used as both HOMEY_HOME and the
   * home directory. Without the second, the search falls through to the real
   * ~/.athom-cli/settings.json and the test starts reporting on whoever is
   * running it.
   */
  async function settingsDirectory(contents: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'homey-mcp-cli-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, 'settings.json'), contents)
    return directory
  }

  it('reads the login and the active Homey without running anything', async () => {
    const directory = await settingsDirectory(
      JSON.stringify({
        homeyApi: {
          token: { token_type: 'bearer', access_token: 'a-stored-value' },
          'homey-one': { token: 'hub-session' },
        },
        activeHomey: { id: 'homey-one', name: 'Upstairs' },
      }),
    )

    const state = await readHomeyCliStoredState({ environment: { HOMEY_HOME: directory }, homeDirectory: directory })

    expect(state).toMatchObject({
      hasCloudToken: true,
      activeHomeyId: 'homey-one',
      activeHomeyName: 'Upstairs',
      storedHomeyCount: 1,
    })
  })

  it('counts the stored Homeys so an unselected one can be told apart from an unselectable one', async () => {
    const directory = await settingsDirectory(
      JSON.stringify({
        homeyApi: {
          token: { token_type: 'bearer', access_token: 'a-stored-value' },
          'homey-one': {},
          'homey-two': {},
        },
      }),
    )

    const state = await readHomeyCliStoredState({ environment: { HOMEY_HOME: directory }, homeDirectory: directory })

    expect(state).toMatchObject({ activeHomeyId: null, storedHomeyCount: 2 })
  })

  // Unlike readHomeyCliSession, this one never throws. It exists to make a
  // diagnostic possible, and a diagnostic that dies on the file it was asked to
  // look at has failed at its one job.
  it('reads a half-written settings file as nothing rather than throwing', async () => {
    const directory = await settingsDirectory('{ this is not JSON')

    await expect(readHomeyCliStoredState({ environment: { HOMEY_HOME: directory }, homeDirectory: directory })).resolves.toBeNull()
  })
})
