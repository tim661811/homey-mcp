import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { runSetup } from './setup.js'
import type { SetupMachine } from './setup.js'
import { fakeFileSystem, fakeRunner, homeyCliManifest } from '../../tests/fixtures/homey-cli-machine.js'
import type { FakeRunner, FakeTree } from '../../tests/fixtures/homey-cli-machine.js'
import { createLogger } from '../util/log.js'

const NODE = '/opt/node/bin/node'
const QUIET = createLogger({ level: 'silent', environment: {} })

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'homey-mcp-setup-'))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * Anything setup asks a question with.
 *
 * A prompt is the one thing setup writes that does not end in a newline, and
 * these are the four shapes it uses: a yes or no default, a numbered range, and
 * the token prompt that ends in a colon.
 */
const PROMPT_PATTERN = /(?:\[[Yy]\/[Nn]\]|\[\d+-\d+\]|:) $/

interface Terminal {
  input: NodeJS.ReadableStream & { isTTY?: boolean }
  output: NodeJS.WritableStream
  text: () => string
}

/**
 * A terminal with a script, or none at all.
 *
 * Answers are typed one at a time, in response to a prompt appearing in the
 * output. Writing them all up front does not work: readline in terminal mode
 * consumes everything buffered on the first question and drops every line after
 * the one it wanted, so the second question would wait forever on input that had
 * already been thrown away.
 *
 * `answers` of null makes it a pipe rather than a terminal, which is what setup
 * sees when it is run by a service or with its output redirected.
 */
function terminal(answers: string[] | null): Terminal {
  const chunks: string[] = []
  const input = new PassThrough() as PassThrough & { isTTY?: boolean }
  let index = 0

  const output = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const text = chunk.toString()
      chunks.push(text)
      if (answers !== null && index < answers.length && PROMPT_PATTERN.test(text)) {
        const answer = answers[index] ?? ''
        index += 1
        setImmediate(() => input.write(`${answer}\n`))
      }
      callback()
    },
  })

  if (answers === null) {
    input.end()
  } else {
    input.isTTY = true
  }

  return { input, output, text: () => chunks.join('') }
}

interface RunOptions {
  answers?: string[] | null
  argv?: string[]
  tree?: FakeTree
  runner?: FakeRunner
  /** Contents of the Homey CLI's settings file, when there is one. */
  cliSettings?: string
  /** Contents of this server's own credentials file, when there is one. */
  credentials?: string
  /** Merged over the environment, for a test that needs one more variable set. */
  extraEnvironment?: Record<string, string | undefined>
}

interface RunResult {
  exitCode: number
  output: string
  runner: FakeRunner
  configPath: string
}

/** Runs setup against a machine that does not exist and a home directory that is thrown away. */
async function run(options: RunOptions = {}): Promise<RunResult> {
  const homeDirectory = await temporaryDirectory()
  const configHome = await temporaryDirectory()
  const cliHome = await temporaryDirectory()

  if (options.cliSettings !== undefined) {
    await writeFile(join(cliHome, 'settings.json'), options.cliSettings)
  }

  const configPath = join(configHome, 'homey-mcp', 'credentials.json')
  if (options.credentials !== undefined) {
    await mkdir(join(configHome, 'homey-mcp'), { recursive: true })
    await writeFile(configPath, options.credentials)
  }

  const session = terminal(options.answers ?? null)
  const runner = options.runner ?? fakeRunner([])
  const machine: SetupMachine = {
    fileSystem: fakeFileSystem(options.tree ?? { files: {} }),
    runCommand: runner.run,
    homeDirectory,
    platform: 'linux',
    nodeExecutablePath: NODE,
  }

  const exitCode = await runSetup({
    ...(options.argv === undefined ? {} : { argv: options.argv }),
    // npm_config_cache is pinned because the npx cache otherwise defaults to the
    // real ~/.npm, and this suite must answer the same on a machine that has
    // once run "npx homey" as on one that never has.
    environment: {
      PATH: '',
      npm_config_cache: '/cache',
      XDG_CONFIG_HOME: configHome,
      HOMEY_HOME: cliHome,
      ...options.extraEnvironment,
    },
    logger: QUIET,
    input: session.input,
    output: session.output,
    machine,
  })

  return { exitCode, output: session.text(), runner, configPath }
}

function cliSettings(overrides: { activeHomey?: { id: string; name: string } } = {}): string {
  return JSON.stringify({
    homeyApi: {
      token: { token_type: 'bearer', access_token: 'a-stored-value', expires_in: 3660 },
      'homey-one': { token: 'hub-session', session: { scopes: ['homey'] } },
    },
    ...(overrides.activeHomey === undefined ? {} : { activeHomey: overrides.activeHomey }),
  })
}

const CLI_IN_NPX_CACHE: FakeTree = {
  files: {
    '/cache/_npx/76a0/node_modules/homey/package.json': homeyCliManifest('4.4.2'),
    '/cache/_npx/76a0/node_modules/homey/bin/homey.mjs': '',
  },
}

describe('runSetup, when the Homey CLI is missing', () => {
  it('installs nothing and names the three commands instead when nobody can be asked', async () => {
    const result = await run()

    // The exact command is printed before anything could run it, and the manual
    // route is spelled out rather than left as "install the CLI".
    expect(result.output).toContain('npm install --global homey')
    expect(result.output).toContain('homey login')
    expect(result.output).toContain('npx homey-mcp setup')
    expect(result.runner.requests.some((request) => request.commandArguments.includes('install'))).toBe(false)
  })

  // Not on PATH is the wrong summary. The CLI is frequently installed and on no
  // PATH at all, because "npx homey" leaves it in the npx cache and nowhere
  // else, so a report that only mentions PATH sends people to fix the wrong
  // thing.
  it('says where it looked, all three places', async () => {
    const result = await run()

    expect(result.output).toContain('not on your PATH')
    expect(result.output).toContain('globally with npm')
    expect(result.output).toContain('npx cache')
  })

  it('falls through to the Personal Access Token route rather than dead-ending', async () => {
    const result = await run()

    expect(result.output).toContain('Personal Access Token')
    expect(result.output).toContain('https://tools.developer.homey.app/me')
    expect(result.exitCode).toBe(1)
  })

  // A global install can be refused by a system Node whose folder the user
  // cannot write to. That is not the end of the route: npx needs no global
  // write at all.
  it('offers the npx route when a global install is refused for permissions', async () => {
    const runner = fakeRunner((request) =>
      request.commandArguments.includes('install')
        ? { exitCode: 243, stderr: 'npm error code EACCES\nnpm error syscall mkdir' }
        : { exitCode: 1 },
    )

    const result = await run({ answers: ['y', 'y', 'n', ''], runner })

    expect(result.output).toContain('npm config set prefix')
    // npm's own forty lines are not what a user can act on, so they do not
    // appear.
    expect(result.output).not.toContain('npm error syscall')
    expect(result.output).toContain('Using "npx homey"')
  })

  it('never installs when the offer is declined, and says so', async () => {
    const runner = fakeRunner([{ exitCode: 1 }])
    const result = await run({ answers: ['n', 'n', ''], runner })

    expect(result.runner.requests.some((request) => request.commandArguments.includes('install'))).toBe(false)
    expect(result.output).toContain('Nothing was installed.')
    expect(result.output).toContain('Personal Access Token')
  })
})

describe('runSetup, when the Homey CLI is there', () => {
  it('reports where it found one that is in the npx cache and on no PATH', async () => {
    const runner = fakeRunner((request) =>
      request.commandArguments.includes('whoami')
        ? { stdout: JSON.stringify({ id: 'user-1', email: 'someone@example.invalid' }) }
        : request.commandArguments.includes('current')
          ? { stdout: 'null' }
          : { stdout: '[]' },
    )

    const result = await run({
      tree: CLI_IN_NPX_CACHE,
      runner,
      cliSettings: cliSettings(),
      // Use the stored login, then an empty token once the account turns out to
      // have no Homey on it and the walk hands over to the other route.
      answers: ['', ''],
    })

    expect(result.output).toContain('Found in the npx cache, version 4.4.2')
  })

  // Measured: "homey list --json" marks none of its entries as active and
  // "homey select current --json" prints a bare null, so this is a silent,
  // ordinary state that leaves nothing able to tell which house is meant.
  it('stops on two Homeys and no selection rather than picking one', async () => {
    const runner = fakeRunner((request) =>
      request.commandArguments.includes('whoami')
        ? { stdout: JSON.stringify({ id: 'user-1', email: 'someone@example.invalid' }) }
        : request.commandArguments.includes('current')
          ? { stdout: 'null' }
          : {
              stdout: JSON.stringify([
                { id: 'homey-one', name: 'Upstairs' },
                { id: 'homey-two', name: 'The cabin' },
              ]),
            },
    )

    const result = await run({ tree: CLI_IN_NPX_CACHE, runner, cliSettings: cliSettings() })

    expect(result.output).toContain('No Homey is selected, and this account has 2')
    expect(result.output).toContain('homey select')
    expect(runner.requests.some((request) => request.commandArguments.includes('--id'))).toBe(false)
  })

  it('selects the one Homey on the account once that is agreed to', async () => {
    const runner = fakeRunner((request) =>
      request.commandArguments.includes('whoami')
        ? { stdout: JSON.stringify({ id: 'user-1', email: 'someone@example.invalid' }) }
        : request.commandArguments.includes('current')
          ? { stdout: 'null' }
          : request.commandArguments.includes('list')
            ? { stdout: JSON.stringify([{ id: 'homey-one', name: 'Upstairs' }]) }
            : {},
    )

    // Answers: use the stored login, select the only Homey. The step after this
    // one connects to a real hub, so HOMEY_MCP_CONFIG points at a file that does
    // not exist: credential resolution then fails before anything is sent, and
    // the suite stays off the network.
    await run({
      tree: CLI_IN_NPX_CACHE,
      runner,
      cliSettings: cliSettings(),
      answers: ['y', 'y'],
      extraEnvironment: { HOMEY_MCP_CONFIG: '/nowhere/credentials.json' },
    })

    expect(runner.requests.some((request) => request.commandArguments.join(' ').includes('select --id homey-one'))).toBe(
      true,
    )
  })

  // The whole point of the token route is that it stays available to anyone who
  // does not want another tool on their machine.
  it('goes to the Personal Access Token route when the stored login is declined', async () => {
    const result = await run({
      tree: CLI_IN_NPX_CACHE,
      cliSettings: cliSettings({ activeHomey: { id: 'homey-one', name: 'Upstairs' } }),
      answers: ['n', ''],
    })

    expect(result.output).toContain('Use this login?')
    expect(result.output).toContain('https://tools.developer.homey.app/me')
    expect(result.exitCode).toBe(1)
  })

  // "homey login" opens a browser and waits for a person, so starting it where
  // nobody can answer would hang until the timeout and achieve nothing.
  it('does not start an interactive login on a terminal that cannot answer', async () => {
    const runner = fakeRunner([{ exitCode: 1 }])
    const result = await run({ tree: CLI_IN_NPX_CACHE, runner })

    expect(result.output).toContain('Signing in is interactive')
    expect(runner.requests.some((request) => request.commandArguments.includes('login'))).toBe(false)
  })

  // Regression. --yes used to answer this question too, and an unattended run
  // then threw a browser login at whoever happened to be at the machine. It also
  // could not have succeeded: nobody was going to be there to finish the OAuth
  // flow. --yes consents to work that finishes on its own, never to work that
  // needs a person.
  it('does not start an interactive login under --yes either, even on a real terminal', async () => {
    const runner = fakeRunner([{ exitCode: 0 }])
    const result = await run({
      tree: CLI_IN_NPX_CACHE,
      runner,
      argv: ['--yes'],
      // One empty answer for the token prompt setup falls through to. Without it
      // the run waits on input that never comes, and the test times out instead
      // of asserting anything.
      answers: [''],
    })

    expect(runner.requests.some((request) => request.commandArguments.includes('login'))).toBe(false)
    expect(result.output).toContain('--yes does not do it for you')
    expect(result.output).toContain('https://tools.developer.homey.app/me')
  })
})

describe('runSetup, when credentials already exist', () => {
  it('leaves them alone by default', async () => {
    const result = await run({ credentials: JSON.stringify({ personalAccessToken: 'kept' }) })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('Nothing changed.')
    await expect(readFile(result.configPath, 'utf8')).resolves.toContain('kept')
  })

  // --yes answers the questions that ask permission to proceed. Deleting a
  // credential that already works is not one of them: yes is constructive to the
  // first kind of question and destructive to this one, and one flag must not
  // quietly mean both.
  it('still leaves them alone under --yes', async () => {
    const result = await run({
      argv: ['--yes'],
      credentials: JSON.stringify({ personalAccessToken: 'kept' }),
    })

    expect(result.exitCode).toBe(0)
    await expect(readFile(result.configPath, 'utf8')).resolves.toContain('kept')
  })

  // A run nobody watched still has to say which decisions were taken for it.
  it('records the answer it assumed, and why', async () => {
    const result = await run({ credentials: JSON.stringify({ personalAccessToken: 'kept' }) })

    expect(result.output).toContain('Replace them and set up again? no, the default: there is no terminal to ask.')
  })
})

describe('runSetup, on any machine', () => {
  it('reports the Node it checked before anything else', async () => {
    const result = await run()

    expect(result.output).toContain('Node')
    expect(result.output).toContain(process.versions.node)
  })

  // Measured: readline's question on an input stream that has already ended does
  // not resolve, does not reject and does not time out. Asking anyway is not a
  // defensive default, it is a hang, and setup piped into anything would have
  // stopped there forever.
  it('finishes rather than hanging when there is no terminal to ask', async () => {
    const result = await run({ credentials: JSON.stringify({ personalAccessToken: 'kept' }) })

    expect(result.exitCode).toBe(0)
  })
})
