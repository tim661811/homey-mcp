// Reading and authoring flows.
//
// This module writes to someone's house, so every write is deliberately
// awkward in the same four ways:
//
//   - a new flow is created DISABLED and inside its own folder, so nothing
//     starts happening until the owner has looked at it and switched it on;
//   - switching a flow from off to on is a gate of its own, because the pause
//     above is worth nothing if the same caller can end it unaided;
//   - after any write the flow is read back and diffed against what was sent,
//     because the firmware accepts a great deal that it then silently mangles,
//     and a quietly wrong flow is worse than a rejected one;
//   - changing or deleting a flow this server did not create needs an explicit
//     confirmation, and keeps a pre-image in the result so the change can be
//     undone by hand.
//
// The firmware's own `testFlow` route is NOT used anywhere here. Despite the
// name it executes the actions for real, so offering it as a preview would
// switch things on in the house to find out whether the flow is valid.
// `homey_flow_validate` is entirely client-side and talks to the hub only to
// read its card catalogue.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { normaliseForComparison } from '../../homey/cache.js'
import { HomeyMcpError, classifyError } from '../../homey/errors.js'
import type { FlowCardKind, FlowCardLookup, FlowSummary } from '../../homey/types.js'
import type { ServerContext } from '../context.js'
import {
  DESTRUCTIVE_TOOL_ANNOTATIONS,
  OVERWRITE_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
} from '../createServer.js'
import { failureResult, invalidRequestResult } from '../errors.js'
import { successResult } from '../render.js'
import type { CanonicalCard, CanonicalFlow, FlowDifference, StoredCanonicalFlow } from '../../flow/model.js'
import { diffFlows, flowDeepLink, fromWire, storedFlowFromWire, toLibraryPayload } from '../../flow/model.js'
import { normaliseFlow } from '../../flow/normalise.js'
import type { ValidationContext, ValidationProblem } from '../../flow/validate.js'
import { validateAdvancedFlow, validateFlow } from '../../flow/validate.js'
import type { AdvancedNode, CanonicalAdvancedFlow, StoredCanonicalAdvancedFlow } from '../../flow/advanced.js'
import {
  ADVANCED_NODE_TYPES,
  CARD_BEARING_NODE_TYPES,
  applyAutoLayout,
  assignNodeKeys,
  deriveJoinInputs,
  diffAdvancedFlows,
  fromAdvancedWire,
  storedAdvancedFlowFromWire,
  toAdvancedLibraryPayload,
} from '../../flow/advanced.js'

/**
 * Where flows built through this server are put.
 *
 * A dedicated folder is the difference between "the assistant added something"
 * and "something appeared in my flows". It also gives every later write an
 * honest answer to "did this server create this flow" that survives a restart,
 * which an in-memory set on its own does not.
 */
const MANAGED_FOLDER_NAME = 'AI'

const DEFAULT_LIST_LIMIT = 50
const MAXIMUM_LIST_LIMIT = 200

/**
 * Flows created in this session, per server context.
 *
 * Module level because the standard and advanced authoring tools are registered
 * through two separate entry points and share one notion of what this server
 * made. Keyed weakly so a context that goes away takes its set with it.
 */
const flowsCreatedByContext = new WeakMap<ServerContext, Set<string>>()

function createdFlowsFor(context: ServerContext): Set<string> {
  const existing = flowsCreatedByContext.get(context)
  if (existing !== undefined) return existing
  const created = new Set<string>()
  flowsCreatedByContext.set(context, created)
  return created
}

const flowCardInput = z.object({
  // `cardId`, not `id`, because this is the same value homey_flowcards_search
  // reports and homey_flowcard_describe and homey_flowcard_autocomplete already
  // take under that name. A caller carries it straight from discovery into
  // authoring, and a rename in between is a failed call rather than a style
  // preference. It is also what describeCard emits back, so a flow read out of
  // homey_flow_get or out of a previousFlow pre-image can be sent straight back
  // in without being renamed field by field.
  cardId: z.string().describe('The full card id from homey_flowcards_search, for example homey:device:<uuid>:on.'),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The values this card is set to, keyed by the argument name from the "arguments" list homey_flowcard_describe reports. That list is the schema; this is what you fill in. Omit for a card that takes none.'),
  group: z
    .string()
    .optional()
    .describe('Conditions: group1, group2 or group3. Conditions in the same group are ANDed, separate groups are ORed. Actions: "then" for the normal branch, "else" for when the conditions are false. Defaults to group1 and then.'),
  inverted: z.boolean().optional().describe('Conditions only. True turns the condition into "is NOT".'),
  // Nullable, not merely optional. A card read back from the Homey carries
  // droptoken: null when nothing was dropped on it, and everything this module
  // emits is meant to be sendable straight back. Accepting only a string
  // rejected that card with "expected string, received null", naming a field
  // the caller never set.
  droptoken: z
    .string()
    .nullable()
    .optional()
    .describe('A value dropped onto the card, written as owner, pipe, token: homey:device:<uuid>|measure_luminance. A colon in place of the pipe saves without an error and then shows as "Unavailable" in the app.'),
  // Nullable for the same reason as droptoken above: null is how a card with no
  // wait reads once it has been through the Homey, and a card that came out of
  // one of these tools has to be sendable straight back into them.
  delaySeconds: z.number().nullable().optional().describe('Actions only. Wait this many seconds before running the card.'),
  durationSeconds: z
    .number()
    .nullable()
    .optional()
    .describe('Actions only. Hold the action for this many seconds, on cards that support it.'),
})

const advancedNodeInput = z.object({
  key: z
    .string()
    .describe('Your own label for this card, for example "motion" or "hall-light". It is replaced by a real id before sending, and every reference to the label is rewritten with it.'),
  type: z
    .enum(ADVANCED_NODE_TYPES)
    .describe('trigger and start begin a branch; condition splits it; action does something; delay waits; any continues on the first incoming branch; all waits for every one; note is a comment on the canvas.'),
  cardId: z.string().optional().describe('The flow card id. Only on trigger, condition and action cards.'),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The values this card is set to, keyed by the argument name from the "arguments" list homey_flowcard_describe reports.'),
  inverted: z.boolean().optional().describe('Conditions only. True turns the condition into "is NOT".'),
  // Nullable for the same reason as the standard card above: a node read back
  // through homey_flow_get has to be sendable straight back here.
  droptoken: z.string().nullable().optional().describe('A value dropped onto the card, as owner, pipe, token.'),
  delaySeconds: z.number().optional().describe('Delay cards only. How long to wait.'),
  value: z.string().optional().describe('Note cards only. The text of the note.'),
  color: z.string().optional().describe('Note cards only: yellow, red, green, blue, purple or grey.'),
  outputSuccess: z.array(z.string()).optional().describe('Labels of the cards that run next. Several labels run in parallel.'),
  outputTrue: z.array(z.string()).optional().describe('Conditions only. Labels of the cards that run when the condition holds.'),
  outputFalse: z.array(z.string()).optional().describe('Conditions only. Labels of the cards that run when it does not.'),
  outputError: z.array(z.string()).optional().describe('Labels of the cards that run when this card fails.'),
  // Accepted, and emitted by homey_flow_get, because homey_advancedflow_update
  // replaces the whole graph from what the caller read. Without these two the
  // canvas the owner arranged by hand cannot survive the trip: applyAutoLayout
  // leaves a node alone only when it already carries both coordinates, so a
  // graph read back and sent again with one edge changed came back re-laid-out
  // from scratch and every card had moved. The owner's arrangement of their own
  // flow is theirs, not this server's to discard on an unrelated edit.
  x: z.number().optional().describe('Horizontal position on the canvas. Send back what homey_flow_get reported to keep the layout; omit on a new card and one is chosen.'),
  y: z.number().optional().describe('Vertical position on the canvas. Send back what homey_flow_get reported to keep the layout; omit on a new card and one is chosen.'),
})

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFlowTools(server: McpServer, context: ServerContext): void {
  const flowsCreatedHere = createdFlowsFor(context)

  server.registerTool(
    'homey_flows_list',
    {
      title: 'List Homey flows',
      description:
        'Lists the flows on this Homey, standard and advanced together. Filter by name, folder, kind or state. Use homey_flow_get to see what one flow actually does.',
      inputSchema: {
        query: z.string().optional().describe('Part of the flow name.'),
        kind: z.enum(['standard', 'advanced']).optional().describe('Restrict to one kind of flow.'),
        folder: z.string().optional().describe('A folder name or id.'),
        enabledOnly: z.boolean().optional().describe('Only flows that are switched on.'),
        brokenOnly: z
          .boolean()
          .optional()
          .describe('Only flows the Homey has marked broken. Not every Homey generation reports the flag: where it does not, the result says so rather than answering with an empty list.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAXIMUM_LIST_LIMIT)
          .optional()
          .describe(`Maximum number of flows to return. Defaults to ${DEFAULT_LIST_LIMIT}.`),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (input): Promise<CallToolResult> => {
      try {
        const index = await context.cache.getFlows()

        const query = input.query === undefined ? null : normaliseForComparison(input.query)
        const folder = input.folder === undefined ? null : normaliseForComparison(input.folder)

        const matches = index.all.filter((flow) => {
          if (input.kind !== undefined && flow.kind !== input.kind) return false
          if (input.enabledOnly === true && !flow.enabled) return false
          if (input.brokenOnly === true && flow.broken !== true) return false
          if (query !== null && !normaliseForComparison(flow.name).includes(query)) return false
          if (folder !== null && !normaliseForComparison(`${flow.folderName ?? ''} ${flow.folderId ?? ''}`).includes(folder)) return false
          return true
        })

        const limit = input.limit ?? DEFAULT_LIST_LIMIT
        const page = matches.slice(0, limit)

        // Asked for broken flows on a hub that never reports the flag, the honest
        // answer is "this Homey does not say", not an empty list that reads as
        // "nothing is broken".
        const brokenReported = index.all.length === 0 || index.all.some((flow) => flow.broken !== null)
        const unreportedBrokenFlag = input.brokenOnly === true && !brokenReported

        return successResult(
          unreportedBrokenFlag
            ? 'This Homey does not report which flows are broken, so nothing can be filtered on it. The firmware drops the flag before this server sees it. List the flows without brokenOnly and check them in the Homey app, or use homey_flow_validate on one to see whether its cards still exist.'
            : `${page.length} of ${matches.length} flows.`,
          {
            totalMatches: matches.length,
            truncated: matches.length > page.length,
            flows: page.map(summariseFlow),
            // Spelled exactly as homey_flow_start and homey_home_overview spell
            // it. One question, one field name, whichever tool answers it.
            ...(unreportedBrokenFlag ? { brokenReportedByHomey: false } : {}),
          },
        )
      } catch (error) {
        return failureResult(error, { operation: 'list flows', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_flow_get',
    {
      title: 'Read one Homey flow',
      description:
        'Returns everything one flow contains: its trigger, conditions and actions with their arguments, or for an advanced flow the whole graph of cards. Every card is resolved to its title so the flow can be read as a sentence, and a card that no longer exists is marked.',
      inputSchema: {
        flow: z.string().describe('The flow name or id.'),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (input): Promise<CallToolResult> => {
      try {
        const resolution = await resolveFlow(context, input.flow)
        if ('failure' in resolution) return resolution.failure

        const summary = resolution.flow
        const cards = await context.cache.getAllFlowCards()

        if (summary.kind === 'advanced') {
          const advanced = fromAdvancedWire(summary.raw, context.connection.dialect)
          return successResult(`Advanced flow "${summary.name}" with ${advanced.nodes.length} cards.`, {
            flow: {
              ...summariseFlow(summary),
              url: flowDeepLink(summary.id, 'advanced'),
              cards: advanced.nodes.map((node) => describeAdvancedNode(node, cards)),
            },
          })
        }

        const standard = fromWire(summary.raw, context.connection.dialect)
        return successResult(
          `Flow "${summary.name}": starts on ${cards.get('trigger', standard.trigger.id)?.title ?? standard.trigger.id}, ${standard.conditions.length} conditions, ${standard.actions.length} actions.`,
          {
            flow: {
              ...summariseFlow(summary),
              url: flowDeepLink(summary.id, 'standard'),
              trigger: describeCard(standard.trigger, 'trigger', cards),
              conditions: standard.conditions.map((condition) => describeCard(condition, 'condition', cards)),
              actions: standard.actions.map((action) => describeCard(action, 'action', cards)),
            },
          },
        )
      } catch (error) {
        return failureResult(error, { operation: 'read a flow', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_flow_validate',
    {
      title: 'Check a flow before building it',
      description: [
        'Checks a flow against this Homey without writing anything and without running anything: every card exists and is the right kind, every argument is named and typed correctly, and every device and token reference resolves.',
        'Worth calling first, because the Homey itself accepts almost anything. A flow naming a card that does not exist saves and shows as "NO CARD"; a token written with a colon instead of a pipe saves and shows as "Unavailable". Neither reports an error.',
      ].join(' '),
      inputSchema: {
        name: z.string().describe('What the flow is called.'),
        trigger: flowCardInput.describe(
          'The card that starts the flow. A flow cannot exist without one: the Homey stores the trigger in a NOT NULL column and rejects the flow otherwise. Use homey:manager:flow:programmatic_trigger for a flow that is only ever started by something else.',
        ),
        conditions: z.array(flowCardInput).optional().describe('Cards that decide whether the actions run. Omit for a flow that always runs.'),
        actions: z.array(flowCardInput).optional().describe('What the flow does.'),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (input): Promise<CallToolResult> => {
      try {
        const { flow, problems, cards } = await prepareStandardFlow(context, input)

        return successResult(
          problems.length === 0
            ? `"${flow.name}" looks sound: ${flow.conditions.length} conditions, ${flow.actions.length} actions.`
            : `${problems.length} problems with "${flow.name}".`,
          // Rendered in the tools' own shape: this flow is what the caller is
          // told to hand to homey_flow_create, so it has to survive that trip.
          { valid: problems.length === 0, problems, flow: describeFlow(flow, cards) },
        )
      } catch (error) {
        return failureResult(error, { operation: 'validate a flow', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_flow_create',
    {
      title: 'Create a Homey flow',
      description: [
        `Builds a new flow. It is created switched OFF and inside a folder called "${MANAGED_FOLDER_NAME}", so nothing happens in the house until the owner has read it and switched it on.`,
        'The flow is validated first and refused outright if anything is wrong, then read back from the Homey and compared with what was sent. The result carries a link to it in the Homey app.',
      ].join(' '),
      inputSchema: {
        name: z.string().describe('What the flow is called. Say what it does, in the owner\'s words.'),
        trigger: flowCardInput.describe('The card that starts the flow. Required: the Homey refuses a flow without one.'),
        conditions: z.array(flowCardInput).optional().describe('Cards that decide whether the actions run.'),
        actions: z.array(flowCardInput).optional().describe('What the flow does.'),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async (input): Promise<CallToolResult> => {
      try {
        const { flow, problems, cards } = await prepareStandardFlow(context, input)
        if (problems.length > 0) {
          return invalidRequestResult(`"${flow.name}" was not created: ${problems.length} things are wrong with it.`, { problems })
        }

        const folderId = await resolveManagedFolder(context)
        // Switched off on create, always. The owner turns it on once they have
        // read what it does.
        const requested: CanonicalFlow = { ...flow, enabled: false, folder: folderId }

        const created = await context.connection.request(
          () => flowManager(context).createFlow({ flow: toLibraryPayload(requested) }),
          'flow.createFlow',
        )
        context.cache.invalidate('flows')

        const stored = storedFlowFromWire(created, context.connection.dialect)
        if (stored.id === '') {
          throw new HomeyMcpError(
            'transient',
            'The Homey accepted the flow but did not report the id it gave it, so the flow could not be read back and checked.',
            { suggestion: 'List the flows and see whether it appeared before trying again, so no duplicate is created.' },
          )
        }

        flowsCreatedHere.add(stored.id)
        const verification = await verifyStandardFlow(context, stored.id, requested)
        const url = flowDeepLink(stored.id, 'standard')

        return successResult(
          verification.differences.length === 0
            ? `Created "${flow.name}", switched off, in the ${MANAGED_FOLDER_NAME} folder. Open it at ${url} and switch it on if it is right.`
            : `Created "${flow.name}", but the Homey stored ${verification.differences.length} things differently from what was sent. Read the differences before switching it on: ${url}`,
          {
            flowId: stored.id,
            name: flow.name,
            enabled: false,
            folder: { id: folderId, name: MANAGED_FOLDER_NAME },
            url,
            verified: verification.differences.length === 0,
            differences: verification.differences,
            storedFlow: verification.stored === null ? null : describeFlow(verification.stored, cards),
          },
        )
      } catch (error) {
        return failureResult(error, { operation: 'create a flow', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_flow_update',
    {
      title: 'Change a Homey flow',
      description: [
        'Replaces the trigger, conditions and actions of an existing standard flow. Anything left out keeps its current value, but an array that IS sent replaces that array wholesale.',
        'A flow this server did not create belongs to the owner and needs confirm: true. The flow as it was is read first and returned in the result, so a wrong change can be put back by sending it again.',
        'Switching a flow that is off ON is a separate step that needs confirmEnable: true, because a flow that is off has never run in the house.',
      ].join(' '),
      inputSchema: {
        flow: z.string().describe('The flow name or id to change.'),
        name: z.string().optional().describe('A new name. Leave out to keep the current one.'),
        trigger: flowCardInput.optional().describe('A new trigger card. Leave out to keep the current one.'),
        conditions: z
          .array(flowCardInput)
          .optional()
          .describe('The complete new set of conditions. An empty array removes them all. Leave out to keep the current ones.'),
        actions: z.array(flowCardInput).optional().describe('The complete new set of actions. Leave out to keep the current ones.'),
        enabled: z
          .boolean()
          .optional()
          .describe(
            'Switch the flow on or off. Switching it OFF is always allowed. Switching a flow that is currently off ON is refused unless confirmEnable is also true, because a flow arrives switched off so that a person reads what it does before it can run the house, and this is that step. Ask the owner; do not confirm it on their behalf.',
          ),
        confirm: z.boolean().optional().describe('Required when the flow was not created by this server. Confirms the owner asked for this change.'),
        confirmEnable: z
          .boolean()
          .optional()
          .describe(
            'Required only when enabled is true and the flow is currently off. Set it after the owner has seen what the flow does and said to switch it on, never merely because the flow looks finished.',
          ),
      },
      // Overwrite rather than plain write: any array that is sent replaces that
      // array wholesale, so the previous definition is gone and the client
      // should be able to ask about it first.
      annotations: OVERWRITE_TOOL_ANNOTATIONS,
    },
    async (input): Promise<CallToolResult> => {
      try {
        const resolution = await resolveFlow(context, input.flow)
        if ('failure' in resolution) return resolution.failure
        const summary = resolution.flow

        if (summary.kind === 'advanced') {
          // homey_advancedflow_update is registered only where the capability
          // probe found Advanced Flow, while advanced flows stay visible in
          // homey_flows_list on a hub without the unlock. Naming the tool
          // unconditionally therefore sent the model looking for a tool that is
          // not in its list.
          //
          // `!== false` rather than a truth test, because the probe has three
          // answers. It is the same question createServer asks through
          // shouldOfferCapability when it decides whether to register the tool,
          // so a probe that merely failed registers the tool AND names it here.
          // A bare truth test read that null as "absent" and told the owner
          // their Homey does not have Advanced Flow while the tool sat in the
          // model's list.
          return invalidRequestResult(
            `"${summary.name}" is an advanced flow: it has a graph of cards rather than one trigger and a list of actions.`,
            {
              suggestion: context.capabilities.hardware.advancedFlow !== false
                ? 'Use homey_advancedflow_update instead.'
                : 'This Homey does not have Advanced Flow, so this server offers no tool that can change one. Advanced Flow is a separate purchase on a Homey Pro (2016 - 2019); change this flow in the Homey app instead.',
              flowId: summary.id,
            },
          )
        }

        const ownership = checkOwnership(summary, input.confirm === true, flowsCreatedHere, 'change')
        if (ownership !== null) return ownership

        // Read the flow again rather than trusting the cached list. The device
        // and flow caches hold a minute, and a minute is long enough for the
        // owner to have edited this flow in the Homey app. Merging onto a stale
        // copy would silently undo that edit, and the pre-image returned for
        // undo would not be what was actually replaced.
        const preImage = await readStandardFlow(context, summary.id)

        const enableGate = await checkEnableTransition(context, {
          requestedEnabled: input.enabled,
          currentlyEnabled: preImage.enabled,
          confirmed: input.confirmEnable === true,
          flow: summary,
          url: flowDeepLink(summary.id, 'standard'),
        })
        if (enableGate !== null) return enableGate

        const { flow, problems, cards } = await prepareStandardFlow(context, {
          name: input.name ?? preImage.name,
          trigger: input.trigger ?? toInputCard(preImage.trigger),
          conditions: input.conditions ?? preImage.conditions.map(toInputCard),
          actions: input.actions ?? preImage.actions.map(toInputCard),
        })
        if (problems.length > 0) {
          return invalidRequestResult(`"${summary.name}" was left alone: ${problems.length} things are wrong with the change.`, {
            problems,
            flowId: summary.id,
          })
        }

        const requested: CanonicalFlow = {
          ...flow,
          enabled: input.enabled ?? preImage.enabled ?? summary.enabled,
          folder: preImage.folder ?? summary.folderId,
        }

        await context.connection.request(
          () => flowManager(context).updateFlow({ id: summary.id, flow: toLibraryPayload(requested) }),
          'flow.updateFlow',
        )
        context.cache.invalidate('flows')

        const verification = await verifyStandardFlow(context, summary.id, requested)
        const url = flowDeepLink(summary.id, 'standard')

        return successResult(
          verification.differences.length === 0
            ? `Changed "${requested.name}". ${url}`
            : `Changed "${requested.name}", but the Homey stored ${verification.differences.length} things differently from what was sent.`,
          {
            flowId: summary.id,
            url,
            verified: verification.differences.length === 0,
            differences: verification.differences,
            // The flow exactly as it was. Sending these cards back undoes the
            // change, which is only true while they are in the shape this tool
            // accepts.
            previousFlow: describeFlow(preImage, cards),
            storedFlow: verification.stored === null ? null : describeFlow(verification.stored, cards),
          },
        )
      } catch (error) {
        return failureResult(error, { operation: 'change a flow', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_flow_delete',
    {
      title: 'Delete a Homey flow',
      description: [
        'Deletes a flow, standard or advanced. The Homey has no undo, so the flow exactly as it was is returned in the result and can be rebuilt from it.',
        'A flow this server did not create needs confirm: true.',
      ].join(' '),
      inputSchema: {
        flow: z.string().describe('The flow name or id to delete.'),
        confirm: z.boolean().optional().describe('Required when the flow was not created by this server. Confirms the owner asked for this deletion.'),
      },
      // The only destructive flow tool. Create leaves the flow disabled and
      // update returns the pre-image, so both can be undone from the result
      // alone. A deleted flow is gone from the hub.
      annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    },
    async (input): Promise<CallToolResult> => {
      try {
        const resolution = await resolveFlow(context, input.flow)
        if ('failure' in resolution) return resolution.failure
        const summary = resolution.flow

        const ownership = checkOwnership(summary, input.confirm === true, flowsCreatedHere, 'delete')
        if (ownership !== null) return ownership

        // Read from the hub before writing, not from the cache: after the
        // delete there is nothing left to read, so a stale pre-image would be
        // the only record of a flow that no longer exists anywhere.
        const preImage =
          summary.kind === 'advanced'
            ? await readAdvancedFlow(context, summary.id)
            : await readStandardFlow(context, summary.id)

        if (summary.kind === 'advanced') {
          await context.connection.request(() => flowManager(context).deleteAdvancedFlow({ id: summary.id }), 'flow.deleteAdvancedFlow')
        } else {
          await context.connection.request(() => flowManager(context).deleteFlow({ id: summary.id }), 'flow.deleteFlow')
        }

        context.cache.invalidate('flows')
        flowsCreatedHere.delete(summary.id)

        // Rendered in the shape the create tools accept, because rebuilding the
        // flow from this result is the only undo the Homey offers. Both kinds go
        // through a describe path for that reason: the advanced branch used to
        // hand back the internal graph under `nodes`, which
        // homey_advancedflow_create cannot read at all.
        const cards = await context.cache.getAllFlowCards()
        const deletedFlow =
          summary.kind === 'advanced'
            ? describeAdvancedFlow(preImage as StoredCanonicalAdvancedFlow, cards)
            : describeFlow(preImage as StoredCanonicalFlow, cards)

        return successResult(`Deleted "${summary.name}". The full definition is in this result if it has to be rebuilt.`, {
          flowId: summary.id,
          name: summary.name,
          kind: summary.kind,
          deletedFlow,
        })
      } catch (error) {
        return failureResult(error, { operation: 'delete a flow', logger: context.logger })
      }
    },
  )
}

/**
 * Registered only where the capability probe actually found Advanced Flow.
 *
 * On a Homey Pro (2016 - 2019) Advanced Flow is a separate one-time purchase,
 * so its absence is normal rather than a fault, and a tool that is not
 * registered is a much clearer answer than one that always fails.
 */
export function registerAdvancedFlowTools(server: McpServer, context: ServerContext): void {
  const flowsCreatedHere = createdFlowsFor(context)

  const graphExplanation = [
    'An advanced flow is a graph of cards rather than one trigger and a list of actions: branches, parallel paths, joins, delays and error handlers.',
    'Give each card your own label and refer to those labels in the output lists; real ids are generated before sending.',
    'To use a value another card produced, write [[trigger::<that card\'s label>::<token id>]] or [[action::<label>::<token id>]]. The [[owner|token]] form used in standard flows does not name a card and will not work here.',
  ].join(' ')

  server.registerTool(
    'homey_advancedflow_create',
    {
      title: 'Create a Homey advanced flow',
      description: `${graphExplanation} The flow is created switched OFF and inside the "${MANAGED_FOLDER_NAME}" folder, then read back and compared with what was sent.`,
      inputSchema: {
        name: z.string().describe('What the flow is called.'),
        cards: z
          .array(advancedNodeInput)
          .describe('Every card in the graph. At least one must be a trigger or a start card, otherwise nothing can begin it.'),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async (input): Promise<CallToolResult> => {
      try {
        const prepared = await prepareAdvancedFlow(context, input.name, input.cards)
        if (prepared.problems.length > 0) {
          return invalidRequestResult(`"${input.name}" was not created: ${prepared.problems.length} things are wrong with it.`, {
            problems: prepared.problems,
          })
        }

        const folderId = await resolveManagedFolder(context)
        const requested: CanonicalAdvancedFlow = { ...prepared.flow, enabled: false, folder: folderId }

        const created = await context.connection.request(
          () => flowManager(context).createAdvancedFlow({ advancedflow: toAdvancedLibraryPayload(requested) }),
          'flow.createAdvancedFlow',
        )
        context.cache.invalidate('flows')

        const storedId = readIdentifier(created)
        if (storedId === null) {
          throw new HomeyMcpError(
            'transient',
            'The Homey accepted the flow but did not report the id it gave it, so the flow could not be read back and checked.',
            { suggestion: 'List the flows and see whether it appeared before trying again, so no duplicate is created.' },
          )
        }

        flowsCreatedHere.add(storedId)
        const verification = await verifyAdvancedFlow(context, storedId, requested)
        const url = flowDeepLink(storedId, 'advanced')

        return successResult(
          verification.differences.length === 0
            ? `Created "${input.name}", switched off, in the ${MANAGED_FOLDER_NAME} folder. Open it at ${url} and switch it on if it is right.`
            : `Created "${input.name}", but the Homey stored ${verification.differences.length} things differently from what was sent. Read the differences before switching it on: ${url}`,
          {
            flowId: storedId,
            name: input.name,
            enabled: false,
            folder: { id: folderId, name: MANAGED_FOLDER_NAME },
            url,
            // The node key each label was given, so a follow-up change can
            // address the same cards. Named for what it holds: these are node
            // keys in the graph, not flow card ids, and `cardId` already means a
            // flow card id on this very tool's input.
            nodeKeysByLabel: Object.fromEntries(prepared.keyByLabel),
            verified: verification.differences.length === 0,
            differences: verification.differences,
          },
        )
      } catch (error) {
        return failureResult(error, { operation: 'create an advanced flow', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_advancedflow_update',
    {
      title: 'Change a Homey advanced flow',
      description: `${graphExplanation} The whole graph is replaced, so every card that should survive has to be sent again: read the current one with homey_flow_get first. A flow this server did not create needs confirm: true. Switching a flow that is off ON needs confirmEnable: true.`,
      inputSchema: {
        flow: z.string().describe('The advanced flow name or id to change.'),
        name: z.string().optional().describe('A new name. Leave out to keep the current one.'),
        cards: z.array(advancedNodeInput).describe('The complete new graph.'),
        enabled: z
          .boolean()
          .optional()
          .describe(
            'Switch the flow on or off. Switching it OFF is always allowed. Switching a flow that is currently off ON is refused unless confirmEnable is also true, because a flow arrives switched off so that a person reads what it does before it can run the house, and this is that step. Ask the owner; do not confirm it on their behalf.',
          ),
        confirm: z.boolean().optional().describe('Required when the flow was not created by this server.'),
        confirmEnable: z
          .boolean()
          .optional()
          .describe(
            'Required only when enabled is true and the flow is currently off. Set it after the owner has seen what the flow does and said to switch it on, never merely because the flow looks finished.',
          ),
      },
      // Overwrite rather than plain write: the graph sent replaces the stored
      // one, so every card that was not sent again is dropped.
      annotations: OVERWRITE_TOOL_ANNOTATIONS,
    },
    async (input): Promise<CallToolResult> => {
      try {
        const resolution = await resolveFlow(context, input.flow)
        if ('failure' in resolution) return resolution.failure
        const summary = resolution.flow

        if (summary.kind !== 'advanced') {
          return invalidRequestResult(`"${summary.name}" is a standard flow, not an advanced one.`, {
            suggestion: 'Use homey_flow_update instead.',
            flowId: summary.id,
          })
        }

        const ownership = checkOwnership(summary, input.confirm === true, flowsCreatedHere, 'change')
        if (ownership !== null) return ownership

        // Read again rather than trusting the cached list, so the pre-image
        // returned for undo is what is actually being replaced.
        const preImage = await readAdvancedFlow(context, summary.id)

        const enableGate = await checkEnableTransition(context, {
          requestedEnabled: input.enabled,
          currentlyEnabled: preImage.enabled,
          confirmed: input.confirmEnable === true,
          flow: summary,
          url: flowDeepLink(summary.id, 'advanced'),
        })
        if (enableGate !== null) return enableGate

        const prepared = await prepareAdvancedFlow(context, input.name ?? summary.name, input.cards)
        if (prepared.problems.length > 0) {
          return invalidRequestResult(`"${summary.name}" was left alone: ${prepared.problems.length} things are wrong with the change.`, {
            problems: prepared.problems,
            flowId: summary.id,
          })
        }

        const requested: CanonicalAdvancedFlow = {
          ...prepared.flow,
          enabled: input.enabled ?? preImage.enabled ?? summary.enabled,
          folder: preImage.folder ?? summary.folderId,
        }

        await context.connection.request(
          () => flowManager(context).updateAdvancedFlow({ id: summary.id, advancedflow: toAdvancedLibraryPayload(requested) }),
          'flow.updateAdvancedFlow',
        )
        context.cache.invalidate('flows')

        const verification = await verifyAdvancedFlow(context, summary.id, requested)
        const url = flowDeepLink(summary.id, 'advanced')

        return successResult(
          verification.differences.length === 0
            ? `Changed "${requested.name}". ${url}`
            : `Changed "${requested.name}", but the Homey stored ${verification.differences.length} things differently from what was sent.`,
          {
            flowId: summary.id,
            url,
            nodeKeysByLabel: Object.fromEntries(prepared.keyByLabel),
            verified: verification.differences.length === 0,
            differences: verification.differences,
            // The graph exactly as it was, in the shape this tool accepts.
            // Sending it back undoes the change, which is only true while it is
            // rendered under `cards` rather than under the internal `nodes`.
            previousFlow: describeAdvancedFlow(preImage, await context.cache.getAllFlowCards()),
          },
        )
      } catch (error) {
        return failureResult(error, { operation: 'change an advanced flow', logger: context.logger })
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

interface StandardFlowInput {
  name: string
  trigger: z.infer<typeof flowCardInput>
  conditions?: Array<z.infer<typeof flowCardInput>>
  actions?: Array<z.infer<typeof flowCardInput>>
}

/**
 * Turns tool input into a normalised canonical flow, and everything wrong with it.
 *
 * The card catalogue comes back with it because every caller then has to render
 * the flow for output, and that rendering needs the same lookup. Fetching it
 * again would be a second call on a hub that answers a burst with "Too many
 * requests", cached or not.
 */
async function prepareStandardFlow(
  context: ServerContext,
  input: StandardFlowInput,
): Promise<{ flow: CanonicalFlow; problems: ValidationProblem[]; cards: FlowCardLookup }> {
  const validationContext = await buildValidationContext(context)

  const draft: CanonicalFlow = {
    name: input.name,
    trigger: toCanonicalCard(input.trigger),
    conditions: (input.conditions ?? []).map(toCanonicalCard),
    actions: (input.actions ?? []).map(toCanonicalCard),
  }

  const normalised = normaliseFlow(draft, validationContext.cards)
  return {
    flow: normalised.flow,
    problems: [...normalised.problems, ...validateFlow(normalised.flow, validationContext)],
    cards: validationContext.cards,
  }
}

async function prepareAdvancedFlow(
  context: ServerContext,
  name: string,
  cards: Array<z.infer<typeof advancedNodeInput>>,
): Promise<{ flow: CanonicalAdvancedFlow; problems: ValidationProblem[]; keyByLabel: Map<string, string> }> {
  const validationContext = await buildValidationContext(context)

  // Order matters. Keys are allocated first so every edge and every node token
  // can be rewritten against them; the joins are derived from the finished
  // edges; the layout comes last because it walks those edges.
  const assignment = assignNodeKeys(cards.map(toAdvancedNode))
  const positioned = applyAutoLayout(deriveJoinInputs(assignment.nodes))

  const flow: CanonicalAdvancedFlow = { name, nodes: positioned }
  return { flow, problems: validateAdvancedFlow(flow, validationContext), keyByLabel: assignment.keyByLabel }
}

async function buildValidationContext(context: ServerContext): Promise<ValidationContext> {
  // Serial, not parallel. Four list requests fired at once is precisely the
  // burst this hub answers with "Too many requests", and all four are cached
  // anyway so the cost is paid once per time to live.
  const cards = await context.cache.getAllFlowCards()
  const devices = await context.cache.getDevices()
  const zones = await context.cache.getZones()
  const folders = await context.cache.getFlowFolders()

  return {
    cards,
    deviceIds: new Set(devices.all.map((device) => device.id)),
    zoneIds: new Set(zones.all.map((zone) => zone.id)),
    folderIds: new Set(folders.all.map((folder) => folder.id)),
    dialect: context.connection.dialect,
  }
}

// ---------------------------------------------------------------------------
// Reading before writing
// ---------------------------------------------------------------------------

/** The flow as the hub holds it right now, for the pre-image and for a merge. */
async function readStandardFlow(context: ServerContext, flowId: string): Promise<StoredCanonicalFlow> {
  const raw = await context.connection.request(() => flowManager(context).getFlow({ id: flowId }), 'flow.getFlow', true)
  return storedFlowFromWire(raw, context.connection.dialect)
}

async function readAdvancedFlow(context: ServerContext, flowId: string): Promise<StoredCanonicalAdvancedFlow> {
  const raw = await context.connection.request(
    () => flowManager(context).getAdvancedFlow({ id: flowId }),
    'flow.getAdvancedFlow',
    true,
  )
  return storedAdvancedFlowFromWire(raw, context.connection.dialect)
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Reads the flow back and compares it with what was sent.
 *
 * This is not belt and braces. The firmware accepts an argument outside a
 * card's declared range, a folder id that no longer exists and a card id that
 * names nothing, and reports none of them. The diff is the only place any of
 * that becomes visible.
 */
async function verifyStandardFlow(
  context: ServerContext,
  flowId: string,
  requested: CanonicalFlow,
): Promise<{ differences: FlowDifference[]; stored: CanonicalFlow | null }> {
  try {
    const raw = await context.connection.request(() => flowManager(context).getFlow({ id: flowId }), 'flow.getFlow', true)
    const stored = fromWire(raw, context.connection.dialect)
    return { differences: diffFlows(requested, stored), stored }
  } catch (error) {
    const classified = classifyError(error, { operation: 'flow.getFlow' })
    context.logger.warn('The flow was written but could not be read back to check it', { reason: classified.reason })
    return {
      differences: [{ path: '(verification)', sent: 'written', stored: `could not be read back: ${classified.message}` }],
      stored: null,
    }
  }
}

async function verifyAdvancedFlow(
  context: ServerContext,
  flowId: string,
  requested: CanonicalAdvancedFlow,
): Promise<{ differences: Array<{ path: string; sent: unknown; stored: unknown }> }> {
  try {
    const raw = await context.connection.request(() => flowManager(context).getAdvancedFlow({ id: flowId }), 'flow.getAdvancedFlow', true)
    return { differences: diffAdvancedFlows(requested, fromAdvancedWire(raw, context.connection.dialect)) }
  } catch (error) {
    const classified = classifyError(error, { operation: 'flow.getAdvancedFlow' })
    context.logger.warn('The advanced flow was written but could not be read back to check it', { reason: classified.reason })
    return { differences: [{ path: '(verification)', sent: 'written', stored: `could not be read back: ${classified.message}` }] }
  }
}

// ---------------------------------------------------------------------------
// Folder, ownership and reference resolution
// ---------------------------------------------------------------------------

/** Finds the managed folder, creating it the first time a flow is written. */
async function resolveManagedFolder(context: ServerContext): Promise<string> {
  const folders = await context.cache.getFlowFolders()
  const existing = folders.all.find((folder) => folder.name === MANAGED_FOLDER_NAME)
  if (existing !== undefined) return existing.id

  const created = await context.connection.request(
    () => flowManager(context).createFlowFolder({ flowfolder: { name: MANAGED_FOLDER_NAME } }),
    'flow.createFlowFolder',
  )
  context.cache.invalidate('flowFolders')

  const id = readIdentifier(created)
  if (id === null) {
    throw new HomeyMcpError(
      'transient',
      `The Homey did not report an id for the "${MANAGED_FOLDER_NAME}" folder it created, so there is nowhere safe to put the flow.`,
      { suggestion: 'Try again in a moment. If the folder now exists in the Homey app, the second attempt reuses it.' },
    )
  }
  return id
}

/**
 * Refuses to touch a flow the owner wrote, unless told to explicitly.
 *
 * "Written by this server" means one of two things: created in this session, or
 * sitting in the managed folder. The session set alone would forget everything
 * on restart; the folder alone would miss a flow the owner has since moved. Two
 * weak signals, and the confirmation flag for everything else.
 *
 * Returns null when the write may go ahead, or the result to hand back when it
 * may not.
 */
function checkOwnership(
  flow: FlowSummary,
  confirmed: boolean,
  flowsCreatedHere: ReadonlySet<string>,
  verb: 'change' | 'delete',
): CallToolResult | null {
  if (confirmed) return null
  if (flowsCreatedHere.has(flow.id)) return null
  if (flow.folderName === MANAGED_FOLDER_NAME) return null

  return invalidRequestResult(
    `"${flow.name}" was not created by this server, so it will not be ${verb === 'delete' ? 'deleted' : 'changed'} without confirmation.`,
    {
      flowId: flow.id,
      suggestion: 'Check with the owner that this is the flow they mean, then call again with confirm: true.',
    },
  )
}

interface EnableTransitionOptions {
  /** What the caller asked for. Undefined means the switch was not mentioned at all. */
  requestedEnabled: boolean | undefined
  /** What the hub says right now, read from the pre-image. Undefined when the hub did not report it. */
  currentlyEnabled: boolean | undefined
  confirmed: boolean
  flow: FlowSummary
  url: string
}

/**
 * The one human checkpoint in the authoring path, guarded.
 *
 * A flow is created switched off so that a person reads what it will do before
 * it can run the house. Ownership does not protect that pause: a flow this
 * server just created is one this server created, so the same caller can turn it
 * on in the very next call without anybody having looked at it. Turning a flow
 * from off to on is therefore its own gate, and `confirmEnable` is deliberately
 * an argument a model cannot honestly satisfy on its own.
 *
 * Switching a flow OFF is never gated. Stopping something from running is the
 * safe direction, and a confirmation there would leave a misbehaving flow on.
 *
 * Returns null when the write may go ahead, or the result to hand back when it
 * may not.
 */
async function checkEnableTransition(context: ServerContext, options: EnableTransitionOptions): Promise<CallToolResult | null> {
  if (options.requestedEnabled !== true) return null
  // Only an explicit true counts as "already running". A hub that did not report
  // the switch is not evidence that it was on, and guessing wrong here starts
  // something in someone's house.
  if (options.currentlyEnabled === true) return null

  if (!options.confirmed) {
    return invalidRequestResult(`"${options.flow.name}" was left switched off, and the rest of the change was not applied either.`, {
      flowId: options.flow.id,
      url: options.url,
      suggestion: [
        `A flow is off until a person has read what it will do, so this step is theirs. Show the owner the flow at ${options.url} and ask whether it should run.`,
        'When they say yes, send this same call again with confirmEnable: true. They can also switch it on themselves in the Homey app.',
        'To apply the rest of the change now and leave the switch alone, send it again without enabled.',
      ].join(' '),
    })
  }

  // The flag is the caller's claim that the owner agreed. Where the client can
  // put the question to the owner directly, ask them rather than take the claim:
  // this is the only checkpoint between a generated flow and it running a house.
  if (context.askSupported) {
    const answer = await context.ask({
      question: `Switch the flow "${options.flow.name}" on? It is off at the moment, so it has never run. Once it is on it runs by itself every time its trigger fires.`,
      choices: [
        { value: 'enable', label: 'Switch it on', description: 'The flow starts running the house from now on.' },
        { value: 'leave', label: 'Leave it off', description: 'Nothing changes. It can still be switched on later in the Homey app.' },
      ],
    })

    if (!answer.answered || answer.value !== 'enable') {
      return invalidRequestResult(
        `"${options.flow.name}" was left switched off: the question went to the owner and did not come back as a yes.`,
        {
          flowId: options.flow.id,
          url: options.url,
          suggestion: [
            'Do not send the same call again. Repeating it only asks the same question a second time.',
            `Tell the owner the flow is ready at ${options.url}, and leave switching it on to them.`,
            'Sending the change again without enabled applies everything else and keeps the flow off.',
          ].join(' '),
        },
      )
    }
  }

  return null
}

type FlowResolution = { flow: FlowSummary } | { failure: CallToolResult }

/**
 * Turns a name or an id into exactly one flow.
 *
 * An ambiguous reference is never settled by taking the first candidate. Where
 * the client can put a question to the owner, it is asked. Where it cannot, the
 * candidates go back to the model so it can ask instead.
 */
async function resolveFlow(context: ServerContext, reference: string): Promise<FlowResolution> {
  const resolution = await context.cache.resolveFlow(reference)
  if (resolution.match !== null) return { flow: resolution.match }

  if (resolution.reason === 'ambiguous' && context.askSupported) {
    const answer = await context.ask({
      question: `Which flow did you mean by "${reference}"?`,
      choices: resolution.candidates.map((candidate) => ({
        value: candidate.id,
        label: candidate.name,
        description: `${candidate.kind} flow${candidate.folderName === null ? '' : ` in ${candidate.folderName}`}`,
      })),
    })

    if (answer.answered && answer.value !== null) {
      const chosen = resolution.candidates.find((candidate) => candidate.id === answer.value)
      if (chosen !== undefined) return { flow: chosen }
    }
  }

  if (resolution.reason === 'ambiguous') {
    return {
      failure: invalidRequestResult(`"${reference}" matches ${resolution.candidates.length} flows. Say which one is meant.`, {
        candidates: resolution.candidates.map(summariseFlow),
      }),
    }
  }

  return {
    failure: failureResult(
      new HomeyMcpError('not_found', `No flow on this Homey is called "${reference}".`, {
        suggestion: 'List the flows with homey_flows_list and use the name or id it reports.',
      }),
      { operation: 'find a flow' },
    ),
  }
}

// ---------------------------------------------------------------------------
// Shape conversion and rendering
// ---------------------------------------------------------------------------

function toCanonicalCard(input: z.infer<typeof flowCardInput>): CanonicalCard {
  const card: CanonicalCard = { id: input.cardId, args: input.args ?? {} }
  if (input.group !== undefined) card.group = input.group
  if (input.inverted !== undefined) card.inverted = input.inverted
  if (input.droptoken !== undefined) card.droptoken = input.droptoken
  if (input.delaySeconds !== undefined) card.delay = input.delaySeconds
  if (input.durationSeconds !== undefined) card.duration = input.durationSeconds
  return card
}

/** The inverse, used when an update keeps part of the flow that is already there. */
function toInputCard(card: CanonicalCard): z.infer<typeof flowCardInput> {
  const input: z.infer<typeof flowCardInput> = { cardId: card.id, args: card.args ?? {} }
  if (card.group !== undefined) input.group = card.group
  if (card.inverted !== undefined) input.inverted = card.inverted
  if (card.droptoken !== undefined && card.droptoken !== null) input.droptoken = card.droptoken
  if (card.delay !== undefined && card.delay !== null) input.delaySeconds = card.delay
  if (card.duration !== undefined && card.duration !== null) input.durationSeconds = card.duration
  return input
}

function toAdvancedNode(input: z.infer<typeof advancedNodeInput>): AdvancedNode {
  const node: AdvancedNode = { key: input.key, type: input.type }
  if (input.cardId !== undefined) node.cardId = input.cardId
  if (input.args !== undefined) node.args = input.args
  if (input.inverted !== undefined) node.inverted = input.inverted
  if (input.droptoken !== undefined) node.droptoken = input.droptoken
  if (input.delaySeconds !== undefined) node.delaySeconds = input.delaySeconds
  if (input.value !== undefined) node.value = input.value
  if (input.color !== undefined) node.color = input.color
  if (input.outputSuccess !== undefined) node.outputSuccess = input.outputSuccess
  if (input.outputTrue !== undefined) node.outputTrue = input.outputTrue
  if (input.outputFalse !== undefined) node.outputFalse = input.outputFalse
  if (input.outputError !== undefined) node.outputError = input.outputError
  if (input.x !== undefined) node.x = input.x
  if (input.y !== undefined) node.y = input.y
  return node
}

function summariseFlow(flow: FlowSummary): Record<string, unknown> {
  return {
    id: flow.id,
    name: flow.name,
    kind: flow.kind,
    enabled: flow.enabled,
    broken: flow.broken,
    folderName: flow.folderName,
    triggerCount: flow.triggerCount,
  }
}

/**
 * Renders a flow in the shape the authoring tools accept back.
 *
 * The server instructions prescribe validate then create, `previousFlow`,
 * `deletedFlow` and `storedFlow` all promise that sending the value back
 * restores what was there, and none of that holds while a tool emits the
 * internal shape. Internally a card names its fields `delay`, `duration` and
 * `droptoken`; the tool input names the first two `delaySeconds` and
 * `durationSeconds`, and zod drops an unrecognised key without a word. So a
 * validated flow with a thirty second delayed action was reported valid,
 * handed back to create, and built without the delay, and the create-then-verify
 * diff could not see it because the request had already lost the field.
 *
 * `describeCard` is the one translation between the two shapes, so it is the
 * one used here rather than a second one that could drift from it.
 */
function describeFlow(flow: CanonicalFlow, cards: FlowCardLookup): Record<string, unknown> {
  return {
    ...flow,
    trigger: describeCard(flow.trigger, 'trigger', cards),
    conditions: flow.conditions.map((condition) => describeCard(condition, 'condition', cards)),
    actions: flow.actions.map((action) => describeCard(action, 'action', cards)),
  }
}

function describeCard(card: CanonicalCard, kind: FlowCardKind, cards: FlowCardLookup): Record<string, unknown> {
  // The kind is known from where the card sits in the flow, and it has to be
  // passed: an id-only lookup would resolve the trigger
  // homey:manager:flow:programmatic_trigger to the action that shares its id and
  // report the wrong title back to the reader.
  const descriptor = cards.get(kind, card.id)
  const described: Record<string, unknown> = {
    // `cardId`, matching the name flowCardInput accepts and the name the whole
    // card-discovery surface already uses. It used to be `id`, so every card in
    // a validated flow, a pre-image or a deleted-flow definition had to be
    // renamed by hand before any of them could be sent back.
    cardId: card.id,
    // Resolved so the flow reads without holding a dozen uuids in mind. Null
    // rather than the id repeated, so a card that no longer exists stands out.
    title: descriptor?.title ?? null,
    ownerName: descriptor?.ownerName ?? null,
    exists: descriptor !== undefined,
    args: card.args ?? {},
  }
  if (card.group !== undefined) described['group'] = card.group
  if (card.inverted === true) described['inverted'] = true
  if (card.droptoken !== undefined && card.droptoken !== null) described['droptoken'] = card.droptoken
  if (card.delay !== undefined && card.delay !== null) described['delaySeconds'] = card.delay
  if (card.duration !== undefined && card.duration !== null) described['durationSeconds'] = card.duration
  return described
}

function describeAdvancedNode(node: AdvancedNode, cards: FlowCardLookup): Record<string, unknown> {
  // A card-bearing node's own type IS the card kind, so the graph already says
  // which meaning of the id it holds. The other node types (start, delay, any,
  // all, note) carry no card at all.
  const descriptor =
    node.cardId === undefined || !CARD_BEARING_NODE_TYPES.includes(node.type)
      ? undefined
      : cards.get(node.type as FlowCardKind, node.cardId)
  const described: Record<string, unknown> = {
    key: node.key,
    type: node.type,
    title: descriptor?.title ?? null,
    args: node.args ?? {},
  }
  if (node.cardId !== undefined) {
    described['cardId'] = node.cardId
    described['exists'] = descriptor !== undefined
  }
  if (node.inverted === true) described['inverted'] = true
  if (node.delaySeconds !== undefined && node.delaySeconds !== null) described['delaySeconds'] = node.delaySeconds
  if (node.value !== undefined) described['value'] = node.value
  // Both of these are round-trippable, and homey_advancedflow_update replaces
  // the whole graph from what the caller read here. Leaving them out meant a
  // model that followed the instruction to read the graph, changed one edge and
  // sent it back stripped every droptoken (the card then shows "Unavailable" in
  // the app) and reset every note to yellow.
  if (node.droptoken !== undefined && node.droptoken !== null) described['droptoken'] = node.droptoken
  if (node.color !== undefined) described['color'] = node.color
  for (const port of ['outputSuccess', 'outputTrue', 'outputFalse', 'outputError'] as const) {
    const targets = node[port]
    if (targets !== undefined && targets.length > 0) described[port] = targets
  }
  if (node.input !== undefined && node.input.length > 0) described['input'] = node.input
  // Round-trippable for the same reason droptoken and colour are: the update
  // tool replaces the whole graph, and a node that comes back without its
  // coordinates is laid out again from scratch, which rearranges a canvas the
  // owner may have arranged themselves.
  if (typeof node.x === 'number') described['x'] = node.x
  if (typeof node.y === 'number') described['y'] = node.y
  return described
}

/**
 * Renders an advanced flow in the shape the advanced authoring tools accept back.
 *
 * The exact counterpart of `describeFlow`, and it exists for the exact same
 * reason. `homey_advancedflow_update.previousFlow` and
 * `homey_flow_delete.deletedFlow` both promise that sending the value back
 * rebuilds what was there, and for an advanced flow that promise was false:
 * internally the graph is `nodes`, while `homey_advancedflow_create` and
 * `homey_advancedflow_update` take it as `cards`. Zod drops an unrecognised key
 * without a word, so `cards` was then missing and the call failed on a required
 * field the caller had never been shown. Rebuilding from the result is the only
 * undo the Homey offers for a delete, so this is the whole value of that result.
 */
function describeAdvancedFlow(flow: CanonicalAdvancedFlow, cards: FlowCardLookup): Record<string, unknown> {
  const { nodes, ...rest } = flow
  return { ...rest, cards: nodes.map((node) => describeAdvancedNode(node, cards)) }
}

// ---------------------------------------------------------------------------
// Hub access
// ---------------------------------------------------------------------------

interface FlowManagerCalls {
  getFlow(options: { id: string }): Promise<unknown>
  createFlow(options: { flow: unknown }): Promise<unknown>
  updateFlow(options: { id: string; flow: unknown }): Promise<unknown>
  deleteFlow(options: { id: string }): Promise<unknown>
  getAdvancedFlow(options: { id: string }): Promise<unknown>
  createAdvancedFlow(options: { advancedflow: unknown }): Promise<unknown>
  updateAdvancedFlow(options: { id: string; advancedflow: unknown }): Promise<unknown>
  deleteAdvancedFlow(options: { id: string }): Promise<unknown>
  createFlowFolder(options: { flowfolder: unknown }): Promise<unknown>
}

function flowManager(context: ServerContext): FlowManagerCalls {
  return (context.connection.api as { flow: FlowManagerCalls }).flow
}

function readIdentifier(created: unknown): string | null {
  if (created === null || typeof created !== 'object') return null
  const id = (created as Record<string, unknown>)['id']
  return typeof id === 'string' && id !== '' ? id : null
}
