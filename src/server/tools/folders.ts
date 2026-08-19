// Organising flows: the folders themselves, and moving flows between them.
//
// Nothing in this module changes what a flow does. That is the whole reason it
// is separate from the flow tools next door, which guard writes behind a
// `confirm` because they rewrite cards. Moving a flow leaves it doing exactly
// what it did, in a different place in the list, so guarding it the same way
// would put a confirmation in front of tidying up.

import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { HomeyMcpError } from '../../homey/errors.js'
import {
  createFlowFolder,
  deleteFlowFolder,
  moveFlowToFolder,
  updateFlowFolder,
} from '../../homey/flowFolders.js'
import type { FlowFolderSummary, FlowSummary } from '../../homey/types.js'
import type { ServerContext } from '../context.js'
import { DESTRUCTIVE_TOOL_ANNOTATIONS, READ_ONLY_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS } from '../createServer.js'
import { failureResult, invalidRequestResult } from '../errors.js'
import { renderTextBlock, successResult } from '../render.js'

/** Where a flow sits, counted per folder, so a listing says which folders are actually in use. */
async function countFlowsByFolder(context: ServerContext): Promise<Map<string | null, number>> {
  const flows = await context.cache.getFlows()
  const counts = new Map<string | null, number>()
  for (const flow of flows.all) {
    const key = flow.folderId ?? null
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function describeFolder(folder: FlowFolderSummary, counts: Map<string | null, number>, depth: number): string {
  const count = counts.get(folder.id) ?? 0
  return `${'  '.repeat(depth)}${folder.name} (${count} ${count === 1 ? 'flow' : 'flows'})  id: ${folder.id}`
}

/** The folders as a tree, parents before their children, so the shape is readable in a flat list. */
function renderFolderTree(folders: readonly FlowFolderSummary[], counts: Map<string | null, number>): string[] {
  const lines: string[] = []
  const walk = (parentId: string | null, depth: number): void => {
    for (const folder of folders.filter((candidate) => (candidate.parentFolderId ?? null) === parentId)) {
      lines.push(describeFolder(folder, counts, depth))
      walk(folder.id, depth + 1)
    }
  }
  walk(null, 0)

  // A folder whose parent is missing would otherwise vanish from the tree
  // silently, which is worse than showing it at the top with a note.
  const shown = new Set(lines.length === 0 ? [] : folders.filter((folder) => lines.some((line) => line.includes(folder.id))).map((folder) => folder.id))
  for (const folder of folders) {
    if (!shown.has(folder.id)) lines.push(`${describeFolder(folder, counts, 0)}  (its parent folder no longer exists)`)
  }
  return lines
}

interface FolderResolution {
  folder?: FlowFolderSummary
  failure?: CallToolResult
}

/** Finds a folder by id or by exact name, asking when a name matches more than one. */
async function resolveFolder(context: ServerContext, reference: string): Promise<FolderResolution> {
  const folders = (await context.cache.getFlowFolders()).all

  const byId = folders.find((folder) => folder.id === reference)
  if (byId !== undefined) return { folder: byId }

  const wanted = reference.trim().toLowerCase()
  const byName = folders.filter((folder) => folder.name.trim().toLowerCase() === wanted)
  if (byName.length === 1) return { folder: byName[0] as FlowFolderSummary }

  if (byName.length > 1) {
    if (context.askSupported) {
      const answer = await context.ask({
        question: `Which folder did you mean by "${reference}"?`,
        choices: byName.map((folder) => ({ value: folder.id, label: folder.name, description: `id ${folder.id}` })),
      })
      const chosen = byName.find((folder) => folder.id === answer.value)
      if (answer.answered && chosen !== undefined) return { folder: chosen }
    }
    return {
      failure: invalidRequestResult(`"${reference}" matches ${byName.length} folders. Say which one, by id.`, {
        candidates: byName.map((folder) => ({ id: folder.id, name: folder.name })),
      }),
    }
  }

  return {
    failure: failureResult(
      new HomeyMcpError('not_found', `No flow folder on this Homey is called "${reference}".`, {
        suggestion: 'List them with homey_flow_folders_list, or create it with homey_flow_folder_create.',
      }),
      { operation: 'find a flow folder' },
    ),
  }
}

export function registerFolderTools(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'homey_flow_folders_list',
    {
      title: 'List the folders flows are organised in',
      description: [
        'Lists every flow folder with how many flows sits in it, as a tree: folders can contain folders.',
        'Flows outside every folder are reported separately. Use this before moving anything, because folder names are not unique and only the id addresses one for certain.',
      ].join(' '),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      try {
        const folders = (await context.cache.getFlowFolders()).all
        const counts = await countFlowsByFolder(context)
        const loose = counts.get(null) ?? 0

        return successResult(
          renderTextBlock([
            {
              heading: folders.length === 0 ? 'This Homey has no flow folders' : `${folders.length} folders`,
              lines: renderFolderTree(folders, counts),
            },
            { heading: 'Outside every folder', lines: [`${loose} ${loose === 1 ? 'flow' : 'flows'}`] },
          ]),
          {
            ok: true,
            folders: folders.map((folder) => ({
              id: folder.id,
              name: folder.name,
              parentId: folder.parentFolderId ?? null,
              flowCount: counts.get(folder.id) ?? 0,
            })),
            flowsOutsideAnyFolder: loose,
          },
        )
      } catch (error) {
        return failureResult(error, { operation: 'list flow folders', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_flow_folder_create',
    {
      title: 'Create a folder for flows',
      description: [
        'Creates a folder to organise flows in, optionally inside another one. Returns the id, which is what homey_flow_move takes.',
        'Names are not unique on a Homey, so check homey_flow_folders_list first rather than creating a second folder with a name that already exists.',
      ].join(' '),
      annotations: WRITE_TOOL_ANNOTATIONS,
      inputSchema: {
        name: z.string().min(1).describe('What the folder is called, as shown in the Homey app.'),
        parent: z.string().optional().describe('The id or exact name of the folder to nest this one inside. Leave out for the top level.'),
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        let parentId: string | null = null
        if (input.parent !== undefined) {
          const resolution = await resolveFolder(context, input.parent)
          if (resolution.failure !== undefined) return resolution.failure
          parentId = (resolution.folder as FlowFolderSummary).id
        }

        const created = await createFlowFolder(context.connection, {
          name: input.name,
          ...(parentId === null ? {} : { parentId }),
        })
        context.cache.invalidate('flowFolders')

        return successResult(
          `Created the folder "${created.name}"${parentId === null ? '' : ' inside the one you named'}. Move flows into it with homey_flow_move.`,
          { ok: true, folder: { id: created.id, name: created.name, parentId: created.parentId } },
        )
      } catch (error) {
        return failureResult(error, { operation: 'create a flow folder', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_flow_folder_update',
    {
      title: 'Rename a folder or move it',
      description: [
        'Renames a flow folder, moves it inside another one, or both. The flows in it are untouched and keep working.',
        'Send parent as null to move a folder back to the top level.',
      ].join(' '),
      annotations: WRITE_TOOL_ANNOTATIONS,
      inputSchema: {
        folder: z.string().min(1).describe('The folder id, or its exact name.'),
        name: z.string().min(1).optional().describe('A new name. Leave out to keep the current one.'),
        parent: z
          .string()
          .nullable()
          .optional()
          .describe('The folder to nest this one inside, by id or exact name. Null moves it to the top level. Leave out to keep it where it is.'),
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        if (input.name === undefined && input.parent === undefined) {
          return invalidRequestResult('Nothing to change: send a new name, a new parent, or both.')
        }

        const resolution = await resolveFolder(context, input.folder)
        if (resolution.failure !== undefined) return resolution.failure
        const folder = resolution.folder as FlowFolderSummary

        let parentId: string | null | undefined
        if (input.parent === null) {
          parentId = null
        } else if (input.parent !== undefined) {
          const parentResolution = await resolveFolder(context, input.parent)
          if (parentResolution.failure !== undefined) return parentResolution.failure
          const parent = parentResolution.folder as FlowFolderSummary
          if (parent.id === folder.id) {
            return invalidRequestResult('A folder cannot be inside itself.')
          }
          parentId = parent.id
        }

        const updated = await updateFlowFolder(context.connection, folder.id, {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(parentId === undefined ? {} : { parentId }),
        })
        context.cache.invalidate('flowFolders')

        return successResult(
          `Updated the folder "${folder.name}"${input.name === undefined ? '' : `, now called "${updated.name}"`}.`,
          {
            ok: true,
            folder: { id: updated.id, name: updated.name, parentId: updated.parentId },
            previous: { name: folder.name, parentId: folder.parentFolderId ?? null },
          },
        )
      } catch (error) {
        return failureResult(error, { operation: 'update a flow folder', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_flow_folder_delete',
    {
      title: 'Delete a flow folder',
      description: [
        'Removes an empty flow folder. The Homey refuses to delete one that still contains flows, so move them out first with homey_flow_move.',
        'Deleting a folder never deletes a flow.',
      ].join(' '),
      annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
      inputSchema: {
        folder: z.string().min(1).describe('The folder id, or its exact name.'),
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const resolution = await resolveFolder(context, input.folder)
        if (resolution.failure !== undefined) return resolution.failure
        const folder = resolution.folder as FlowFolderSummary

        // The hub refuses this itself, with `cannot_delete_has_flows` wrapped in
        // a localised "an unknown error occurred" that names neither the folder
        // nor what to do. Counting first turns that into an answer.
        const counts = await countFlowsByFolder(context)
        const inside = counts.get(folder.id) ?? 0
        if (inside > 0) {
          return invalidRequestResult(
            `"${folder.name}" still holds ${inside} ${inside === 1 ? 'flow' : 'flows'}, and this Homey does not delete a folder that is not empty. Move them somewhere else with homey_flow_move first, then delete the folder. Nothing here deletes a flow.`,
            { flowsInside: inside },
          )
        }

        const children = (await context.cache.getFlowFolders()).all.filter(
          (candidate) => (candidate.parentFolderId ?? null) === folder.id,
        )
        if (children.length > 0) {
          return invalidRequestResult(
            `"${folder.name}" still holds ${children.length} ${children.length === 1 ? 'folder' : 'folders'}.`,
            { hint: 'Move or delete those first with homey_flow_folder_update or homey_flow_folder_delete.' },
          )
        }

        await deleteFlowFolder(context.connection, folder.id)
        context.cache.invalidate('flowFolders')

        return successResult(`Deleted the empty folder "${folder.name}".`, {
          ok: true,
          deleted: { id: folder.id, name: folder.name },
        })
      } catch (error) {
        return failureResult(error, { operation: 'delete a flow folder', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_flow_move',
    {
      title: 'Move flows into a folder',
      description: [
        'Moves one or more flows into a folder, or out of every folder when folder is null. Takes flow ids or exact names.',
        'This changes where a flow lives and nothing about what it does: it keeps its cards, and a flow that was running stays running.',
        'The folder each flow came from is reported, so a move can be undone from the result.',
      ].join(' '),
      // A write rather than an overwrite: nothing is lost, and the previous
      // folder comes back in the result.
      annotations: WRITE_TOOL_ANNOTATIONS,
      inputSchema: {
        flows: z.array(z.string().min(1)).min(1).describe('The flows to move, by id or exact name.'),
        folder: z
          .string()
          .nullable()
          .describe('The folder to move them into, by id or exact name. Null takes them out of every folder.'),
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        let target: FlowFolderSummary | null = null
        if (input.folder !== null) {
          const resolution = await resolveFolder(context, input.folder)
          if (resolution.failure !== undefined) return resolution.failure
          target = resolution.folder as FlowFolderSummary
        }

        const moved: Array<Record<string, unknown>> = []
        const failed: Array<Record<string, unknown>> = []

        for (const reference of input.flows) {
          const resolution = await context.cache.resolveFlow(reference)
          const match = resolution.match
          if (match === null) {
            failed.push({
              flow: reference,
              reason:
                resolution.reason === 'ambiguous'
                  ? `matches ${resolution.candidates.length} flows, so name it by id`
                  : 'no flow on this Homey is called that',
            })
            continue
          }

          const flow = match as FlowSummary
          const from = flow.folderId ?? null
          if (from === (target?.id ?? null)) {
            moved.push({ id: flow.id, name: flow.name, from, to: from, changed: false })
            continue
          }

          await moveFlowToFolder(context.connection, flow, target?.id ?? null)
          moved.push({ id: flow.id, name: flow.name, from, to: target?.id ?? null, changed: true })
        }

        if (moved.some((entry) => entry['changed'] === true)) context.cache.invalidate('flows')

        const changedCount = moved.filter((entry) => entry['changed'] === true).length
        return successResult(
          renderTextBlock([
            {
              heading:
                changedCount === 0
                  ? 'Nothing moved: every flow was already where it was asked to be'
                  : `Moved ${changedCount} ${changedCount === 1 ? 'flow' : 'flows'} ${target === null ? 'out of every folder' : `into "${target.name}"`}`,
              lines: moved.map((entry) => `${String(entry['name'])}${entry['changed'] === true ? '' : ' (already there)'}`),
            },
            failed.length === 0
              ? null
              : { heading: 'Not moved', lines: failed.map((entry) => `${String(entry['flow'])}: ${String(entry['reason'])}`) },
          ]),
          { ok: failed.length === 0, movedTo: target === null ? null : { id: target.id, name: target.name }, moved, failed },
        )
      } catch (error) {
        return failureResult(error, { operation: 'move flows between folders', logger: context.logger })
      }
    },
  )
}
