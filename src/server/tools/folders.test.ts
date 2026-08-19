import { describe, expect, it } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { CapabilityRegistry, FlowFolderSummary, FlowSummary, HomeyConnection } from '../../homey/types.js'
import { createLogger } from '../../util/log.js'
import type { ServerContext } from '../context.js'
import { registerFolderTools } from './folders.js'

type ToolHandler = (input: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>

function createRecordingServer(): { server: McpServer; tools: Map<string, ToolHandler> } {
  const tools = new Map<string, ToolHandler>()
  const server = {
    registerTool(name: string, _config: unknown, handler: ToolHandler) {
      tools.set(name, handler)
      return {}
    },
  }
  return { server: server as unknown as McpServer, tools }
}

function folder(id: string, name: string, parentFolderId: string | null = null): FlowFolderSummary {
  return { id, name, parentFolderId, raw: {} }
}

function flow(id: string, name: string, folderId: string | null, kind: 'standard' | 'advanced' = 'standard'): FlowSummary {
  return {
    id,
    name,
    kind,
    enabled: true,
    broken: null,
    folderId,
    folderName: null,
    raw: {},
  } as unknown as FlowSummary
}

interface Call {
  method: string
  payload: unknown
}

function createHarness(options: { folders?: FlowFolderSummary[]; flows?: FlowSummary[] } = {}) {
  const folders = options.folders ?? [folder('f-heating', 'Verwarming'), folder('f-ai', 'AI')]
  const flows = options.flows ?? [flow('flow-1', 'Morning', 'f-heating'), flow('flow-2', 'Loose', null)]
  const calls: Call[] = []
  const invalidated: string[] = []

  const connection = {
    api: {
      flow: {
        createFlowFolder: async (payload: unknown) => {
          calls.push({ method: 'createFlowFolder', payload })
          return { id: 'f-new', name: 'New', parent: null }
        },
        updateFlowFolder: async (payload: unknown) => {
          calls.push({ method: 'updateFlowFolder', payload })
          return { id: 'f-heating', name: 'Renamed', parent: null }
        },
        deleteFlowFolder: async (payload: unknown) => {
          calls.push({ method: 'deleteFlowFolder', payload })
          return {}
        },
        updateFlow: async (payload: unknown) => {
          calls.push({ method: 'updateFlow', payload })
          return {}
        },
        updateAdvancedFlow: async (payload: unknown) => {
          calls.push({ method: 'updateAdvancedFlow', payload })
          return {}
        },
      },
    },
    dialect: 'v2',
    identity: {} as HomeyConnection['identity'],
    queue: { run: async (operation: () => Promise<unknown>) => operation(), inFlight: 0, queued: 0 },
    request: async (operation: () => Promise<unknown>) => operation(),
  } as unknown as HomeyConnection

  const cache = {
    getFlowFolders: async () => ({ all: folders }),
    getFlows: async () => ({ all: flows }),
    resolveFlow: async (reference: string) => {
      const byId = flows.find((candidate) => candidate.id === reference)
      if (byId !== undefined) return { match: byId, reason: 'id', candidates: [] }
      const byName = flows.filter((candidate) => candidate.name.toLowerCase() === reference.toLowerCase())
      if (byName.length === 1) return { match: byName[0], reason: 'exact_name', candidates: [] }
      if (byName.length > 1) return { match: null, reason: 'ambiguous', candidates: byName }
      return { match: null, reason: 'not_found', candidates: [] }
    },
    invalidate: (collection: string) => invalidated.push(collection),
  }

  const capabilities: CapabilityRegistry = {
    hardware: { advancedFlow: true, energyReports: false, moods: false, insights: true },
    probedAt: '2026-08-19T08:00:00.000Z',
    notes: [],
    probes: {},
  }

  const context = {
    connection,
    cache,
    capabilities,
    logger: createLogger({ level: 'silent' }),
    askSupported: false,
    ask: async () => ({ answered: false, value: null, declined: false }),
  } as unknown as ServerContext

  const { server, tools } = createRecordingServer()
  registerFolderTools(server, context)

  return { tools, calls, invalidated }
}

const call = (tools: Map<string, ToolHandler>, name: string, input: Record<string, unknown> = {}): Promise<CallToolResult> => {
  const handler = tools.get(name)
  if (handler === undefined) throw new Error(`${name} was never registered`)
  return handler(input, {})
}

const structured = (result: CallToolResult): Record<string, unknown> => (result.structuredContent ?? {}) as Record<string, unknown>
const text = (result: CallToolResult): string => (result.content ?? []).map((part) => (part as { text?: string }).text ?? '').join('\n')

describe('homey_flow_folders_list', () => {
  it('counts the flows in each folder and the ones outside every folder', async () => {
    const { tools } = createHarness()

    const result = await call(tools, 'homey_flow_folders_list')

    expect(structured(result)['flowsOutsideAnyFolder']).toBe(1)
    expect(structured(result)['folders']).toContainEqual({ id: 'f-heating', name: 'Verwarming', parentId: null, flowCount: 1 })
  })

  it('shows nesting, and still shows a folder whose parent has gone', async () => {
    // A folder pointing at a parent that no longer exists would fall out of a
    // naive tree walk and simply not be listed, which reads as "it is not there".
    const { tools } = createHarness({
      folders: [folder('f-top', 'Top'), folder('f-child', 'Child', 'f-top'), folder('f-orphan', 'Orphan', 'f-gone')],
      flows: [],
    })

    const rendered = text(await call(tools, 'homey_flow_folders_list'))

    expect(rendered).toContain('  Child')
    expect(rendered).toContain('Orphan')
    expect(rendered).toContain('parent folder no longer exists')
  })
})

describe('homey_flow_folder_create', () => {
  it('takes a parent by name and sends its id', async () => {
    const { tools, calls } = createHarness()

    await call(tools, 'homey_flow_folder_create', { name: 'Ramen', parent: 'Verwarming' })

    expect(calls).toContainEqual({ method: 'createFlowFolder', payload: { flowfolder: { name: 'Ramen', parent: 'f-heating' } } })
  })

  it('says so when the named parent does not exist', async () => {
    const { tools, calls } = createHarness()

    const result = await call(tools, 'homey_flow_folder_create', { name: 'Ramen', parent: 'Nowhere' })

    expect(result.isError).toBe(true)
    expect(calls).toEqual([])
  })
})

describe('homey_flow_folder_update', () => {
  it('refuses a call that changes nothing', async () => {
    const { tools, calls } = createHarness()

    expect((await call(tools, 'homey_flow_folder_update', { folder: 'AI' })).isError).toBe(true)
    expect(calls).toEqual([])
  })

  it('refuses to put a folder inside itself', async () => {
    const { tools, calls } = createHarness()

    const result = await call(tools, 'homey_flow_folder_update', { folder: 'AI', parent: 'AI' })

    expect(result.isError).toBe(true)
    expect(calls).toEqual([])
  })

  it('moves a folder back to the top level on an explicit null', async () => {
    const { tools, calls } = createHarness()

    await call(tools, 'homey_flow_folder_update', { folder: 'AI', parent: null })

    expect(calls).toContainEqual({ method: 'updateFlowFolder', payload: { id: 'f-ai', flowfolder: { parent: null } } })
  })
})

describe('homey_flow_folder_delete', () => {
  it('refuses a folder that still holds flows, and says how to empty it', async () => {
    // The hub refuses this itself with cannot_delete_has_flows, wrapped in a
    // localised "an unknown error occurred" that names neither the folder nor
    // the fix. Measured on a Homey Pro (Early 2019).
    const { tools, calls } = createHarness()

    const result = await call(tools, 'homey_flow_folder_delete', { folder: 'Verwarming' })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('homey_flow_move')
    expect(calls).toEqual([])
  })

  it('refuses a folder that still holds folders', async () => {
    const { tools, calls } = createHarness({
      folders: [folder('f-top', 'Top'), folder('f-child', 'Child', 'f-top')],
      flows: [],
    })

    expect((await call(tools, 'homey_flow_folder_delete', { folder: 'Top' })).isError).toBe(true)
    expect(calls).toEqual([])
  })

  it('deletes an empty one', async () => {
    const { tools, calls, invalidated } = createHarness({ folders: [folder('f-empty', 'Empty')], flows: [] })

    const result = await call(tools, 'homey_flow_folder_delete', { folder: 'Empty' })

    expect(result.isError).toBeFalsy()
    expect(calls).toContainEqual({ method: 'deleteFlowFolder', payload: { id: 'f-empty' } })
    expect(invalidated).toContain('flowFolders')
  })
})

describe('homey_flow_move', () => {
  it('moves a standard flow and reports where it came from', async () => {
    const { tools, calls } = createHarness()

    const result = await call(tools, 'homey_flow_move', { flows: ['Morning'], folder: 'AI' })

    expect(calls).toContainEqual({ method: 'updateFlow', payload: { id: 'flow-1', flow: { folder: 'f-ai' } } })
    expect(structured(result)['moved']).toEqual([{ id: 'flow-1', name: 'Morning', from: 'f-heating', to: 'f-ai', changed: true }])
  })

  it('uses the advanced call for an advanced flow, which the standard one does not find', async () => {
    const { tools, calls } = createHarness({ flows: [flow('flow-3', 'Graph', null, 'advanced')] })

    await call(tools, 'homey_flow_move', { flows: ['Graph'], folder: 'AI' })

    expect(calls).toContainEqual({ method: 'updateAdvancedFlow', payload: { id: 'flow-3', advancedflow: { folder: 'f-ai' } } })
  })

  it('takes a flow out of every folder on a null', async () => {
    const { tools, calls } = createHarness()

    await call(tools, 'homey_flow_move', { flows: ['flow-1'], folder: null })

    expect(calls).toContainEqual({ method: 'updateFlow', payload: { id: 'flow-1', flow: { folder: null } } })
  })

  it('writes nothing for a flow that is already there', async () => {
    const { tools, calls } = createHarness()

    const result = await call(tools, 'homey_flow_move', { flows: ['Morning'], folder: 'Verwarming' })

    expect(calls).toEqual([])
    expect(structured(result)['moved']).toEqual([{ id: 'flow-1', name: 'Morning', from: 'f-heating', to: 'f-heating', changed: false }])
  })

  it('moves what it can and names what it could not', async () => {
    const { tools, calls } = createHarness()

    const result = await call(tools, 'homey_flow_move', { flows: ['Morning', 'No such flow'], folder: 'AI' })

    expect(calls).toHaveLength(1)
    expect(structured(result)['ok']).toBe(false)
    expect(structured(result)['failed']).toEqual([{ flow: 'No such flow', reason: 'no flow on this Homey is called that' }])
  })
})
