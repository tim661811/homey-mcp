import { describe, expect, it, vi } from 'vitest'

import { HomeyMcpError } from './errors.js'
import {
  createScript,
  deleteScript,
  getScript,
  HOMEYSCRIPT_APP_ID,
  installHomeyScriptApp,
  listScripts,
  readHomeyScriptApp,
  runScript,
  updateScript,
} from './homeyscript.js'
import type { HomeyConnection } from './types.js'

interface Call {
  method: string
  path: string
  body?: unknown
}

/**
 * A stand-in for the HomeyScript app's Web API that records what was asked of it.
 *
 * Every answer here is the shape a real Homey Pro (Early 2019) running
 * HomeyScript 3.6.2 gave back, captured while probing the endpoints, rather than
 * a shape invented to suit the code under test.
 */
function fakeHomey(options: {
  apps?: Record<string, unknown>
  answers?: Record<string, unknown>
  installFromAppStore?: () => Promise<unknown>
} = {}): { connection: HomeyConnection; calls: Call[] } {
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
        getApp: async ({ id }: { id: string }) => {
          if (id !== HOMEYSCRIPT_APP_ID) throw new Error(`unexpected app ${id}`)
          return app
        },
        getApps: async () => options.apps ?? {},
        installFromAppStore: options.installFromAppStore ?? (async () => undefined),
      },
    },
    dialect: 'v2',
    identity: {} as HomeyConnection['identity'],
    queue: { run: async (operation: () => Promise<unknown>) => operation(), inFlight: 0, queued: 0 },
    request: async (operation: () => Promise<unknown>) => operation(),
  } as unknown as HomeyConnection

  return { connection, calls }
}

describe('readHomeyScriptApp', () => {
  it('reports the app when it is installed', async () => {
    const { connection } = fakeHomey({
      apps: { [HOMEYSCRIPT_APP_ID]: { id: HOMEYSCRIPT_APP_ID, version: '3.6.2', state: 'running' } },
    })

    expect(await readHomeyScriptApp(connection)).toEqual({ installed: true, version: '3.6.2', state: 'running' })
  })

  it('reports its absence rather than throwing', async () => {
    const { connection } = fakeHomey({ apps: { 'com.sonos': {} } })

    expect(await readHomeyScriptApp(connection)).toEqual({ installed: false, version: null, state: null })
  })

  it('asks the hub every time, because the app can be installed while this runs', async () => {
    // The hardware capabilities are probed once at startup because hardware does
    // not change. An app does, so a cached "not installed" would outlive the
    // install and leave every script tool refusing on stale information.
    const getApps = vi.fn(async () => ({}))
    const { connection } = fakeHomey()
    ;(connection.api as { apps: { getApps: unknown } }).apps.getApps = getApps

    await readHomeyScriptApp(connection)
    await readHomeyScriptApp(connection)

    expect(getApps).toHaveBeenCalledTimes(2)
  })
})

describe('listScripts', () => {
  it('reads the id-keyed listing and sorts it by name', async () => {
    const { connection } = fakeHomey({
      answers: {
        'GET /script': {
          'example-hello-world': { id: 'example-hello-world', name: 'example-hello-world', version: 1, lastExecuted: null },
          '448d5f5b': { id: '448d5f5b', name: 'Airing advice', version: 3, lastExecuted: '2026-08-19T11:25:28.834Z' },
        },
      },
    })

    expect(await listScripts(connection)).toEqual([
      { id: '448d5f5b', name: 'Airing advice', version: 3, lastExecuted: '2026-08-19T11:25:28.834Z' },
      { id: 'example-hello-world', name: 'example-hello-world', version: 1, lastExecuted: null },
    ])
  })

  it('falls back to the key when a record carries no name', async () => {
    const { connection } = fakeHomey({ answers: { 'GET /script': { 'example-say': { version: 1 } } } })

    expect((await listScripts(connection))[0]).toMatchObject({ id: 'example-say', name: 'example-say' })
  })
})

describe('getScript', () => {
  it('returns the code with the record', async () => {
    const { connection, calls } = fakeHomey({
      answers: { 'GET /script/abc': { id: 'abc', name: 'Airing advice', code: 'log("hi")', version: 2, lastExecuted: null } },
    })

    expect(await getScript(connection, 'abc')).toEqual({
      id: 'abc',
      name: 'Airing advice',
      code: 'log("hi")',
      version: 2,
      lastExecuted: null,
    })
    expect(calls).toEqual([{ method: 'GET', path: '/script/abc' }])
  })

  it('says so when there is no such script', async () => {
    const { connection } = fakeHomey({ answers: { 'GET /script/nope': null } })

    await expect(getScript(connection, 'nope')).rejects.toThrow(HomeyMcpError)
  })
})

describe('createScript', () => {
  it('posts, and reports the id the hub assigned rather than the name it was given', async () => {
    // This is the whole reason the module exists in this shape. A PUT to an id
    // of the caller's choosing answers happily, reads back, and produces a
    // script that appears in no listing and cannot be picked in a Flow.
    const { connection, calls } = fakeHomey({
      answers: {
        'POST /script': {
          id: '448d5f5b-ad47-458c-8ba9-732de236c0a6',
          name: 'Airing advice',
          code: 'return 42',
          version: 1,
          lastExecuted: null,
        },
      },
    })

    const created = await createScript(connection, { name: 'Airing advice', code: 'return 42' })

    expect(created.id).toBe('448d5f5b-ad47-458c-8ba9-732de236c0a6')
    expect(calls).toEqual([{ method: 'POST', path: '/script', body: { name: 'Airing advice', code: 'return 42' } }])
    expect(calls.some((call) => call.method === 'PUT')).toBe(false)
  })

  it('refuses to report success when the hub answered without an id', async () => {
    // A caller told "created" with no id has nothing to update, run or remove.
    const { connection } = fakeHomey({ answers: { 'POST /script': { name: 'Airing advice' } } })

    await expect(createScript(connection, { name: 'Airing advice', code: 'return 42' })).rejects.toThrow(/did not answer with its id/)
  })
})

describe('updateScript', () => {
  it('checks the script exists before putting, so a wrong id fails instead of making a ghost', async () => {
    const { connection, calls } = fakeHomey({ answers: { 'GET /script/ghost': null } })

    await expect(updateScript(connection, 'ghost', 'return 1')).rejects.toThrow(HomeyMcpError)
    expect(calls.some((call) => call.method === 'PUT')).toBe(false)
  })

  it('puts the new code once the script is known', async () => {
    const { connection, calls } = fakeHomey({
      answers: {
        'GET /script/abc': { id: 'abc', name: 'Airing advice', code: 'old', version: 1, lastExecuted: null },
        'PUT /script/abc': { code: 'new' },
      },
    })

    expect(await updateScript(connection, 'abc', 'new')).toMatchObject({ id: 'abc', name: 'Airing advice', code: 'new' })
    expect(calls).toContainEqual({ method: 'PUT', path: '/script/abc', body: { code: 'new' } })
  })
})

describe('deleteScript', () => {
  it('deletes by id', async () => {
    const { connection, calls } = fakeHomey({ answers: { 'DELETE /script/abc': undefined } })

    await deleteScript(connection, 'abc')

    expect(calls).toEqual([{ method: 'DELETE', path: '/script/abc' }])
  })
})

describe('runScript', () => {
  it('reports what the script returned', async () => {
    const { connection } = fakeHomey({ answers: { 'POST /script/abc/run': { success: true, returns: 42 } } })

    expect(await runScript(connection, 'abc')).toEqual({ success: true, returns: 42, error: null })
  })

  it('treats a script that threw as an answer, not as a failed call', async () => {
    // The hub answers 200 with success:false, so throwing here would turn a
    // perfectly good diagnosis into an error with no line number in it.
    const { connection } = fakeHomey({
      answers: {
        'POST /script/abc/run': {
          success: false,
          returns: { message: 'deliberate probe failure', stack: 'Error: deliberate probe failure\n    at abc.js:1:7' },
        },
      },
    })

    const result = await runScript(connection, 'abc')

    expect(result.success).toBe(false)
    expect(result.error?.message).toBe('deliberate probe failure')
    expect(result.error?.stack).toContain('abc.js:1:7')
  })

  it('still names a failure the app did not explain', async () => {
    const { connection } = fakeHomey({ answers: { 'POST /script/abc/run': { success: false } } })

    expect((await runScript(connection, 'abc')).error?.message).toMatch(/did not say why/)
  })
})

describe('installHomeyScriptApp', () => {
  it('asks the hub to install it from the app store', async () => {
    const installFromAppStore = vi.fn(async () => undefined)
    const { connection } = fakeHomey({ installFromAppStore })

    await installHomeyScriptApp(connection)

    expect(installFromAppStore).toHaveBeenCalledWith({ id: HOMEYSCRIPT_APP_ID })
  })
})
