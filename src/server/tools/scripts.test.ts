import { describe, expect, it, vi } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { createHomeCache } from '../../homey/cache.js'
import { HOMEYSCRIPT_APP_ID } from '../../homey/homeyscript.js'
import type { CapabilityRegistry, HomeyConnection, HomeyIdentity } from '../../homey/types.js'
import { createLogger } from '../../util/log.js'
import type { AskFunction, ServerContext } from '../context.js'
import { findHardCodedIdentifiers, registerScriptTools } from './scripts.js'

const IDENTITY: HomeyIdentity = {
  id: 'test-homey',
  name: 'Test Home',
  modelId: 'homey4d',
  modelName: 'Homey Pro (Early 2019)',
  softwareVersion: '13.2.4',
  platformVersion: 1,
  language: 'en',
  timezone: 'Europe/Amsterdam',
  address: 'http://hub.invalid',
  addressKind: 'local',
}

type ToolHandler = (input: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>

interface RecordedTool {
  name: string
  config: { description?: string; annotations?: Record<string, unknown> }
  handler: ToolHandler
}

function createRecordingServer(): { server: McpServer; tools: Map<string, RecordedTool> } {
  const tools = new Map<string, RecordedTool>()
  const server = {
    registerTool(name: string, config: RecordedTool['config'], handler: ToolHandler) {
      tools.set(name, { name, config, handler })
      return {}
    },
  }
  return { server: server as unknown as McpServer, tools }
}

interface Call {
  method: string
  path: string
  body?: unknown
}

interface HarnessOptions {
  installed?: boolean
  answers?: Record<string, unknown>
  ask?: AskFunction
  askSupported?: boolean
  installFromAppStore?: () => Promise<unknown>
}

function createHarness(options: HarnessOptions = {}) {
  const calls: Call[] = []
  const answers = options.answers ?? {}

  const answerFor = (method: string, path: string): unknown => {
    const answer = answers[`${method} ${path}`]
    if (answer instanceof Error) throw answer
    return answer
  }

  const app = {
    get: async ({ path }: { path: string }) => {
      calls.push({ method: 'GET', path })
      return answerFor('GET', path)
    },
    post: async ({ path, body }: { path: string; body?: unknown }) => {
      calls.push({ method: 'POST', path, body })
      return answerFor('POST', path)
    },
    put: async ({ path, body }: { path: string; body?: unknown }) => {
      calls.push({ method: 'PUT', path, body })
      return answerFor('PUT', path)
    },
    delete: async ({ path }: { path: string }) => {
      calls.push({ method: 'DELETE', path })
      return answerFor('DELETE', path)
    },
  }

  const connection = {
    api: {
      apps: {
        getApp: async () => app,
        getApps: async () =>
          options.installed === false ? {} : { [HOMEYSCRIPT_APP_ID]: { version: '3.6.2', state: 'running' } },
        installFromAppStore: options.installFromAppStore ?? (async () => undefined),
      },
    },
    dialect: 'v2',
    identity: IDENTITY,
    queue: { run: async (operation: () => Promise<unknown>) => operation(), inFlight: 0, queued: 0 },
    request: async (operation: () => Promise<unknown>) => operation(),
  } as unknown as HomeyConnection

  const capabilities: CapabilityRegistry = {
    hardware: { advancedFlow: false, energyReports: false, moods: false, insights: true },
    probedAt: '2026-08-19T08:00:00.000Z',
    notes: [],
    probes: {},
  }

  const context: ServerContext = {
    connection,
    cache: createHomeCache(connection),
    capabilities,
    logger: createLogger({ level: 'silent' }),
    askSupported: options.askSupported ?? false,
    ask: options.ask ?? (async () => ({ answered: false, value: null, declined: false })),
  }

  const { server, tools } = createRecordingServer()
  registerScriptTools(server, context)

  return { tools, calls, context }
}

function call(tools: Map<string, RecordedTool>, name: string, input: Record<string, unknown> = {}): Promise<CallToolResult> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`${name} was never registered`)
  return tool.handler(input, {})
}

function structured(result: CallToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>
}

function text(result: CallToolResult): string {
  return (result.content ?? []).map((part) => (part as { text?: string }).text ?? '').join('\n')
}

const LISTING = {
  '448d5f5b': { id: '448d5f5b', name: 'Airing advice', version: 3, lastExecuted: '2026-08-19T11:25:28.834Z' },
  'example-say': { id: 'example-say', name: 'example-say', version: 1, lastExecuted: null },
}

describe('findHardCodedIdentifiers', () => {
  it('finds a UUID and an Athom id, and reports each once', () => {
    const code = [
      'const device = await Homey.devices.getDevice({ id: "448d5f5b-ad47-458c-8ba9-732de236c0a6" })',
      'const again = "448d5f5b-ad47-458c-8ba9-732de236c0a6"',
      // An invented constant, never a captured one. This test cannot prove the
      // warning fires on Athom-shaped ids without one in it. check-secrets-allow
      'const zone = "0123456789abcdef01234567"',
    ].join('\n')

    expect(findHardCodedIdentifiers(code)).toEqual([
      '448d5f5b-ad47-458c-8ba9-732de236c0a6',
      // The same invented constant, asserted on. check-secrets-allow
      '0123456789abcdef01234567',
    ])
  })

  it('leaves ordinary code alone', () => {
    // A scanner that fires on normal scripts is one nobody reads, so the shapes
    // it matches are only the two an id actually takes.
    const code = 'const temperature = 21.5\nlog(`it is ${temperature}`)\nreturn temperature > 20'

    expect(findHardCodedIdentifiers(code)).toEqual([])
  })
})

describe('homey_scripts_list', () => {
  it('lists the scripts by name', async () => {
    const { tools } = createHarness({ answers: { 'GET /script': LISTING } })

    const result = await call(tools, 'homey_scripts_list')

    expect(structured(result)['count']).toBe(2)
    expect(text(result)).toContain('Airing advice')
  })

  it('says HomeyScript is not installed rather than failing obscurely', async () => {
    const { tools } = createHarness({ installed: false })

    const result = await call(tools, 'homey_scripts_list')

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('HomeyScript is not installed')
  })
})

describe('installing the app', () => {
  it('offers to install it, and installs only after a yes', async () => {
    // The same rule setup follows for the Homey CLI: nothing is installed
    // without an explicit yes.
    const installFromAppStore = vi.fn(async () => undefined)
    const ask = vi.fn(async () => ({ answered: true, value: 'install', declined: false }))
    const { tools } = createHarness({ installed: false, askSupported: true, ask, installFromAppStore })

    const result = await call(tools, 'homey_scripts_list')

    expect(ask).toHaveBeenCalledOnce()
    expect(installFromAppStore).toHaveBeenCalledWith({ id: HOMEYSCRIPT_APP_ID })
    // Installing is a download and a start, so it is not usable yet and the
    // answer has to say that rather than pretend the call can continue.
    expect(text(result)).toContain('Give it a moment')
    expect(structured(result)['ready']).toBe(false)
  })

  it('installs nothing when the user says no', async () => {
    const installFromAppStore = vi.fn(async () => undefined)
    const ask = vi.fn(async () => ({ answered: true, value: 'no', declined: false }))
    const { tools } = createHarness({ installed: false, askSupported: true, ask, installFromAppStore })

    const result = await call(tools, 'homey_scripts_list')

    expect(installFromAppStore).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })

  it('does not ask a client that cannot present the question', async () => {
    const ask = vi.fn(async () => ({ answered: false, value: null, declined: false }))
    const { tools } = createHarness({ installed: false, askSupported: false, ask })

    await call(tools, 'homey_scripts_list')

    expect(ask).not.toHaveBeenCalled()
  })
})

describe('homey_script_create', () => {
  it('creates through POST and reports the id the Homey assigned', async () => {
    const { tools, calls } = createHarness({
      answers: {
        'POST /script': { id: 'new-uuid', name: 'Airing advice', code: 'return 1', version: 1, lastExecuted: null },
      },
    })

    const result = await call(tools, 'homey_script_create', { name: 'Airing advice', code: 'return 1' })

    expect((structured(result)['script'] as Record<string, unknown>)['id']).toBe('new-uuid')
    expect(calls.filter((entry) => entry.method === 'POST')).toEqual([
      { method: 'POST', path: '/script', body: { name: 'Airing advice', code: 'return 1' } },
    ])
    expect(calls.some((entry) => entry.method === 'PUT')).toBe(false)
  })

  it('warns about an id written into the script without refusing it', async () => {
    // The rule is that a baked in id is allowed where nothing else makes sense,
    // so this must stay a warning. What it may not do is stay silent.
    const code = 'await Homey.devices.getDevice({ id: "448d5f5b-ad47-458c-8ba9-732de236c0a6" })'
    const { tools } = createHarness({
      answers: { 'POST /script': { id: 'new-uuid', name: 'Window', code, version: 1, lastExecuted: null } },
    })

    const result = await call(tools, 'homey_script_create', { name: 'Window', code })

    expect(result.isError).toBeFalsy()
    expect(structured(result)['warnings']).toHaveLength(1)
    expect(text(result)).toContain('args[0]')
  })

  it('says nothing about reusability when the script has no ids in it', async () => {
    const { tools } = createHarness({
      answers: { 'POST /script': { id: 'new-uuid', name: 'Airing advice', code: 'return 1', version: 1, lastExecuted: null } },
    })

    const result = await call(tools, 'homey_script_create', { name: 'Airing advice', code: 'return 1' })

    expect(structured(result)['warnings']).toEqual([])
  })

  it('tells the model to write reusable scripts, in the description it reads', async () => {
    const { tools } = createHarness()

    const description = tools.get('homey_script_create')?.config.description ?? ''

    expect(description).toContain('args[0]')
    expect(description).toContain('reusable')
  })
})

describe('homey_script_update', () => {
  it('refuses an id that does not exist instead of creating a ghost', async () => {
    // A PUT to an unknown id answers happily on a real Homey and leaves a record
    // that no listing shows. The existence check is what stops that.
    const { tools, calls } = createHarness({ answers: { 'GET /script': LISTING } })

    const result = await call(tools, 'homey_script_update', { script: 'no-such-script', code: 'return 1' })

    expect(result.isError).toBe(true)
    expect(calls.some((entry) => entry.method === 'PUT')).toBe(false)
  })

  it('returns the previous code so the change can be undone', async () => {
    const { tools } = createHarness({
      answers: {
        'GET /script': LISTING,
        'GET /script/448d5f5b': { id: '448d5f5b', name: 'Airing advice', code: 'return "old"', version: 3, lastExecuted: null },
        'PUT /script/448d5f5b': { code: 'return "new"' },
      },
    })

    const result = await call(tools, 'homey_script_update', { script: 'Airing advice', code: 'return "new"' })

    expect(structured(result)['previousCode']).toBe('return "old"')
  })
})

describe('homey_script_run', () => {
  it('reports what the script returned', async () => {
    const { tools } = createHarness({
      answers: { 'GET /script': LISTING, 'POST /script/448d5f5b/run': { success: true, returns: 42 } },
    })

    const result = await call(tools, 'homey_script_run', { script: 'Airing advice' })

    expect(structured(result)['success']).toBe(true)
    expect(text(result)).toContain('42')
  })

  it('reports a script that threw as an answer with the line it happened on', async () => {
    const { tools } = createHarness({
      answers: {
        'GET /script': LISTING,
        'POST /script/448d5f5b/run': {
          success: false,
          returns: { message: 'boom', stack: 'Error: boom\n    at Airing advice.js:3:11' },
        },
      },
    })

    const result = await call(tools, 'homey_script_run', { script: 'Airing advice' })

    // Not an error result: the call worked, the script did not, and the model
    // needs the stack to fix it rather than a failure with none.
    expect(result.isError).toBeFalsy()
    expect(structured(result)['success']).toBe(false)
    expect(text(result)).toContain('Airing advice.js:3:11')
  })
})

describe('homey_script_delete', () => {
  it('returns the code it removed, because that is the only copy left', async () => {
    const { tools, calls } = createHarness({
      answers: {
        'GET /script': LISTING,
        'GET /script/448d5f5b': { id: '448d5f5b', name: 'Airing advice', code: 'return "gone"', version: 3, lastExecuted: null },
        'DELETE /script/448d5f5b': undefined,
      },
    })

    const result = await call(tools, 'homey_script_delete', { script: '448d5f5b' })

    expect(structured(result)['code']).toBe('return "gone"')
    expect(calls).toContainEqual({ method: 'DELETE', path: '/script/448d5f5b' })
  })
})

describe('resolving a script', () => {
  it('asks which one when a name matches more than one', async () => {
    const ask = vi.fn(async () => ({ answered: true, value: 'second', declined: false }))
    const { tools } = createHarness({
      askSupported: true,
      ask,
      answers: {
        'GET /script': {
          first: { id: 'first', name: 'Airing advice', version: 1, lastExecuted: null },
          second: { id: 'second', name: 'Airing advice', version: 1, lastExecuted: null },
        },
        'GET /script/second': { id: 'second', name: 'Airing advice', code: 'return 2', version: 1, lastExecuted: null },
      },
    })

    const result = await call(tools, 'homey_script_get', { script: 'Airing advice' })

    expect(ask).toHaveBeenCalledOnce()
    expect(text(result)).toContain('return 2')
  })

  it('refuses rather than guessing when it cannot ask', async () => {
    const { tools } = createHarness({
      askSupported: false,
      answers: {
        'GET /script': {
          first: { id: 'first', name: 'Airing advice', version: 1, lastExecuted: null },
          second: { id: 'second', name: 'Airing advice', version: 1, lastExecuted: null },
        },
      },
    })

    const result = await call(tools, 'homey_script_get', { script: 'Airing advice' })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('matches 2 scripts')
  })
})
