// Flow folders, and moving a flow between them.
//
// Organisation only: nothing here changes what a flow does. A folder has a name
// and an optional parent, so they nest, and a flow carries the id of the folder
// it sits in or null for the top level.
//
// Measured against a Homey Pro (Early 2019), because two of these answers are
// not in any documentation:
//
//   - A folder that still contains flows CANNOT be deleted. The hub refuses with
//     `cannot_delete_has_flows`, wrapped in a localised "an unknown error
//     occurred" that names neither the folder nor the fix. So the count is read
//     first and the refusal is written here instead.
//   - `parent: null` moves a folder back to the top level, and the hub accepts
//     it, even though the library types the field as an optional string.

import { HomeyMcpError } from './errors.js'
import type { FlowSummary, HomeyConnection } from './types.js'

export interface FlowFolderRecord {
  id: string
  name: string
  parentId: string | null
}

interface FlowManagerCalls {
  createFlowFolder(options: { flowfolder: { name: string; parent?: string | null } }): Promise<unknown>
  updateFlowFolder(options: { id: string; flowfolder: { name?: string; parent?: string | null } }): Promise<unknown>
  deleteFlowFolder(options: { id: string }): Promise<unknown>
  updateFlow(options: { id: string; flow: { folder: string | null } }): Promise<unknown>
  updateAdvancedFlow(options: { id: string; advancedflow: { folder: string | null } }): Promise<unknown>
}

function flowManager(connection: HomeyConnection): FlowManagerCalls {
  return (connection.api as { flow: FlowManagerCalls }).flow
}

function toRecord(value: unknown, fallbackName: string): FlowFolderRecord {
  const record = (value ?? {}) as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : null
  if (id === null) {
    // Without the id there is nothing to put a flow into, and reporting success
    // would leave the caller holding a name that addresses nothing.
    throw new HomeyMcpError('transient', 'The Homey did not report an id for the folder, so nothing can be put in it.', {
      suggestion: 'Try again in a moment. If the folder now exists in the Homey app, the second attempt finds it.',
    })
  }

  return {
    id,
    name: typeof record['name'] === 'string' ? record['name'] : fallbackName,
    parentId: typeof record['parent'] === 'string' ? record['parent'] : null,
  }
}

export async function createFlowFolder(
  connection: HomeyConnection,
  folder: { name: string; parentId?: string | null },
): Promise<FlowFolderRecord> {
  const created = await connection.request(
    () =>
      flowManager(connection).createFlowFolder({
        flowfolder: { name: folder.name, ...(folder.parentId === undefined ? {} : { parent: folder.parentId }) },
      }),
    'flow.createFlowFolder',
  )
  return toRecord(created, folder.name)
}

/** Renames a folder, moves it under another one, or both. `parentId: null` puts it at the top level. */
export async function updateFlowFolder(
  connection: HomeyConnection,
  id: string,
  changes: { name?: string; parentId?: string | null },
): Promise<FlowFolderRecord> {
  const updated = await connection.request(
    () =>
      flowManager(connection).updateFlowFolder({
        id,
        flowfolder: {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.parentId === undefined ? {} : { parent: changes.parentId }),
        },
      }),
    'flow.updateFlowFolder',
  )
  return toRecord(updated, changes.name ?? id)
}

export async function deleteFlowFolder(connection: HomeyConnection, id: string): Promise<void> {
  await connection.request(() => flowManager(connection).deleteFlowFolder({ id }), 'flow.deleteFlowFolder')
}

/**
 * Moves one flow into a folder, or out of all of them with `folderId: null`.
 *
 * The kind decides the call: an advanced flow updated through `updateFlow` is
 * not found. It changes where the flow lives and nothing else, so it is a write
 * rather than an edit of the flow's behaviour.
 */
export async function moveFlowToFolder(
  connection: HomeyConnection,
  flow: Pick<FlowSummary, 'id' | 'kind'>,
  folderId: string | null,
): Promise<void> {
  await connection.request(
    () =>
      flow.kind === 'advanced'
        ? flowManager(connection).updateAdvancedFlow({ id: flow.id, advancedflow: { folder: folderId } })
        : flowManager(connection).updateFlow({ id: flow.id, flow: { folder: folderId } }),
    flow.kind === 'advanced' ? 'flow.updateAdvancedFlow' : 'flow.updateFlow',
  )
}
