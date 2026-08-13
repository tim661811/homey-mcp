// These tools write to someone's house, so the tests are mostly about the
// three safety properties: a new flow arrives switched off and in its own
// folder, a write is checked by reading it back, and a flow the owner wrote is
// not touched without being asked.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { createHomeCache } from '../../homey/cache.js'
import { createLogger } from '../../util/log.js'
import type { AskOptions, AskResult, ServerContext } from '../context.js'
import { shouldOfferCapability } from '../../homey/types.js'
import type { CapabilityRegistry, CapabilitySupport, HomeyConnection } from '../../homey/types.js'
import { registerAdvancedFlowTools, registerFlowTools } from './flows.js'

interface HomeFixture {
  zones: Record<string, unknown>
  devices: Record<string, unknown>
  flows: Record<string, Record<string, unknown>>
  advancedFlows: Record<string, Record<string, unknown>>
  flowFolders: Record<string, Record<string, unknown>>
  logicVariables: Record<string, unknown>
}

interface FlowFixture {
  flowCardTriggers: unknown[]
  flowCardConditions: unknown[]
  flowCardActions: unknown[]
  standardFlowWire: Record<string, unknown>
  advancedFlowWire: Record<string, unknown>
}

const homeFixture = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/home-sample.json', import.meta.url), 'utf8'),
) as HomeFixture

const flowFixture = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/flow-authoring-sample.json', import.meta.url), 'utf8'),
) as FlowFixture

const CAPABILITY_REGISTRY: CapabilityRegistry = {
  hardware: { advancedFlow: true, energyReports: false, moods: false, insights: true },
  probedAt: '2026-08-13T08:00:00.000Z',
  notes: [],
}

const DOOR_TRIGGER = 'homey:device:aaaaaaaa-0004-4000-8000-000000000004:alarm_contact_true'
const PRESENCE_CONDITION = 'homey:manager:presence:noone_athome'
const NOTIFY_ACTION = 'homey:manager:notifications:create_notification'
const CRON_TRIGGER = 'homey:manager:cron:time_exactly'

/**
 * The one id on the measured hub that names two cards: the trigger "This Flow is
 * started" and the action "Start a Flow". It is also the trigger this server
 * recommends whenever a flow is only ever meant to be started by something else,
 * so resolving it to the action makes the safest flow on the hub unbuildable.
 */
const PROGRAMMATIC_TRIGGER = 'homey:manager:flow:programmatic_trigger'

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>

interface RegisteredTestTool {
  config: { annotations?: Record<string, unknown>; inputSchema?: z.ZodRawShape }
  handler: ToolHandler
}

interface HarnessOptions {
  askSupported?: boolean
  ask?: (options: AskOptions) => Promise<AskResult>
  /** Lets a test make the fake hub store something other than what it was sent. */
  mangleOnWrite?: (flow: Record<string, unknown>) => Record<string, unknown>
  /**
   * What the Advanced Flow probe established, in all three of its answers.
   *
   * `false` is a Homey where the probe came back negative: the advanced tools
   * are then not registered at all, exactly as createServer decides it, and the
   * cache is built without the capability registry so the advanced flows the
   * hub reports are still resolvable. That is the state the suggestion has to
   * survive, because a tool that is not in the model's list must not be the
   * thing it is told to use.
   *
   * `null` is a probe that never settled the question, and it registers the
   * tools exactly as `true` does. Both directions matter here: the suggestion
   * has to follow the registration rather than the raw value.
   */
  advancedFlowSupport?: CapabilitySupport
}

interface Harness {
  tools: Map<string, RegisteredTestTool>
  flows: Record<string, Record<string, unknown>>
  advancedFlows: Record<string, Record<string, unknown>>
  folders: Record<string, Record<string, unknown>>
  writes: Array<{ operation: string; payload: unknown }>
  /** Every call put through the request queue, with the idempotency it declared. */
  queued: Array<{ label: string; idempotent: boolean }>
  askedQuestions: AskOptions[]
}

function createHarness(options: HarnessOptions = {}): Harness {
  // A copy per harness: these tests create, change and delete, and a shared
  // fixture object would leak state between them.
  const flows: Record<string, Record<string, unknown>> = structuredClone(homeFixture.flows)
  const advancedFlows: Record<string, Record<string, unknown>> = structuredClone(homeFixture.advancedFlows)
  const folders: Record<string, Record<string, unknown>> = structuredClone(homeFixture.flowFolders)
  const writes: Array<{ operation: string; payload: unknown }> = []
  const queued: Array<{ label: string; idempotent: boolean }> = []
  const askedQuestions: AskOptions[] = []

  // The fixture's own flow, so there is something the server did not create.
  flows[String(flowFixture.standardFlowWire['id'])] = structuredClone(flowFixture.standardFlowWire)
  advancedFlows[String(flowFixture.advancedFlowWire['id'])] = structuredClone(flowFixture.advancedFlowWire)

  let nextIdentifier = 0
  const mintIdentifier = (): string => {
    nextIdentifier += 1
    return `ffffffff-${String(nextIdentifier).padStart(4, '0')}-4000-8000-000000000000`
  }

  const managers = {
    devices: { getDevices: async () => homeFixture.devices },
    zones: { getZones: async () => homeFixture.zones },
    flow: {
      getFlows: async () => flows,
      getAdvancedFlows: async () => advancedFlows,
      getFlowFolders: async () => folders,
      getFlowCardTriggers: async () => flowFixture.flowCardTriggers,
      getFlowCardConditions: async () => flowFixture.flowCardConditions,
      getFlowCardActions: async () => flowFixture.flowCardActions,

      getFlow: async ({ id }: { id: string }) => {
        const flow = flows[id]
        if (flow === undefined) throw Object.assign(new Error('Not Found'), { statusCode: 404 })
        return flow
      },
      createFlow: async ({ flow }: { flow: Record<string, unknown> }) => {
        writes.push({ operation: 'createFlow', payload: flow })
        const id = mintIdentifier()
        const stored = { ...(options.mangleOnWrite?.(flow) ?? flow), id }
        flows[id] = stored
        return stored
      },
      updateFlow: async ({ id, flow }: { id: string; flow: Record<string, unknown> }) => {
        writes.push({ operation: 'updateFlow', payload: { id, flow } })
        flows[id] = { ...(options.mangleOnWrite?.(flow) ?? flow), id }
        return flows[id]
      },
      deleteFlow: async ({ id }: { id: string }) => {
        writes.push({ operation: 'deleteFlow', payload: { id } })
        delete flows[id]
        return {}
      },

      getAdvancedFlow: async ({ id }: { id: string }) => {
        const flow = advancedFlows[id]
        if (flow === undefined) throw Object.assign(new Error('Not Found'), { statusCode: 404 })
        return flow
      },
      createAdvancedFlow: async ({ advancedflow }: { advancedflow: Record<string, unknown> }) => {
        writes.push({ operation: 'createAdvancedFlow', payload: advancedflow })
        const id = mintIdentifier()
        advancedFlows[id] = { ...advancedflow, id }
        return advancedFlows[id]
      },
      updateAdvancedFlow: async ({ id, advancedflow }: { id: string; advancedflow: Record<string, unknown> }) => {
        writes.push({ operation: 'updateAdvancedFlow', payload: { id, advancedflow } })
        advancedFlows[id] = { ...advancedflow, id }
        return advancedFlows[id]
      },
      deleteAdvancedFlow: async ({ id }: { id: string }) => {
        writes.push({ operation: 'deleteAdvancedFlow', payload: { id } })
        delete advancedFlows[id]
        return {}
      },

      createFlowFolder: async ({ flowfolder }: { flowfolder: Record<string, unknown> }) => {
        writes.push({ operation: 'createFlowFolder', payload: flowfolder })
        const id = mintIdentifier()
        folders[id] = { ...flowfolder, id, parent: null }
        return folders[id]
      },
    },
    insights: { getLogs: async () => ({}) },
    logic: { getVariables: async () => homeFixture.logicVariables },
  }

  const connection: HomeyConnection = {
    api: managers,
    dialect: 'v2',
    identity: {
      id: 'homey-under-test',
      name: 'Test Home',
      modelId: 'homey4d',
      modelName: 'Homey Pro (Early 2019)',
      softwareVersion: '13.2.4',
      platformVersion: 1,
      language: 'en',
      timezone: 'Europe/Amsterdam',
      address: 'https://homey.example.invalid',
      addressKind: 'local',
    },
    queue: { run: async (operation) => operation(), inFlight: 0, queued: 0 },
    // Records how every call was queued. Whether a call was declared idempotent
    // decides whether the queue repeats it after a timeout, which for a write is
    // the difference between opening a door once and opening it four times.
    request: async (operation, label, idempotent) => {
      queued.push({ label, idempotent: idempotent === true })
      return operation()
    },
  }

  const logger = createLogger({ level: 'silent' })
  const advancedFlowSupport: CapabilitySupport =
    options.advancedFlowSupport === undefined ? true : options.advancedFlowSupport
  const advancedFlowOffered = shouldOfferCapability(advancedFlowSupport)
  const capabilities: CapabilityRegistry = {
    ...CAPABILITY_REGISTRY,
    hardware: { ...CAPABILITY_REGISTRY.hardware, advancedFlow: advancedFlowSupport },
  }

  const context: ServerContext = {
    connection,
    cache: createHomeCache(connection, advancedFlowOffered ? { logger, capabilities } : { logger }),
    capabilities,
    logger,
    ask: async (askOptions) => {
      askedQuestions.push(askOptions)
      return (await options.ask?.(askOptions)) ?? { answered: false, value: null, declined: false }
    },
    askSupported: options.askSupported === true,
  }

  const tools = new Map<string, RegisteredTestTool>()
  const server = {
    registerTool(name: string, config: RegisteredTestTool['config'], handler: ToolHandler) {
      // Every call goes through the tool's own zod schema first, exactly as the
      // MCP server does at runtime. Handing the handler a hand-built object
      // instead hides the whole class of defect where a field the code reads is
      // one zod silently strips: the tools emitted delay and duration under
      // names the input schema did not accept, and no test that skipped the
      // parse could see it.
      const parse =
        config.inputSchema === undefined
          ? (input: Record<string, unknown>): Record<string, unknown> => input
          : (input: Record<string, unknown>): Record<string, unknown> =>
              z.object(config.inputSchema as z.ZodRawShape).parse(input) as Record<string, unknown>

      tools.set(name, { config, handler: async (args) => handler(parse(args)) })
      return {}
    },
  } as unknown as McpServer

  registerFlowTools(server, context)
  // Mirrors createServer: the advanced tools exist wherever the probe did not
  // establish that this hub lacks Advanced Flow, which includes a probe that
  // never settled it.
  if (advancedFlowOffered) registerAdvancedFlowTools(server, context)

  return { tools, flows, advancedFlows, folders, writes, queued, askedQuestions }
}

function takeTool(harness: Harness, name: string): RegisteredTestTool {
  const tool = harness.tools.get(name)
  if (tool === undefined) throw new Error(`The tool ${name} was never registered`)
  return tool
}

function structuredOf(result: CallToolResult): Record<string, unknown> {
  const structured = result.structuredContent
  if (structured === undefined) throw new Error('The tool returned no structured content')
  return structured
}

/**
 * The error half of a failed tool result.
 *
 * Failures come back as `isError` results carrying `{ ok: false, error: {...} }`
 * rather than as thrown protocol errors, so the model can read the reason and
 * correct itself.
 */
function failureOf(result: CallToolResult): Record<string, unknown> {
  return (structuredOf(result)['error'] ?? {}) as Record<string, unknown>
}

/** The result's text block, which is what a person actually reads. */
function textOf(result: CallToolResult): string {
  const first = result.content[0]
  return first !== undefined && first.type === 'text' ? first.text : ''
}

/** A flow that passes validation against the fixture's cards. */
function soundFlowInput(name = 'Warn when the attic door opens'): Record<string, unknown> {
  return {
    name,
    trigger: { cardId: DOOR_TRIGGER },
    conditions: [{ cardId: PRESENCE_CONDITION, inverted: true }],
    actions: [{ cardId: NOTIFY_ACTION, args: { text: 'The attic door opened' } }],
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registration', () => {
  it('registers the flow tools it owns, and the advanced ones only through their own entry point', () => {
    const harness = createHarness()

    expect([...harness.tools.keys()].sort()).toEqual([
      'homey_advancedflow_create',
      'homey_advancedflow_update',
      'homey_flow_create',
      'homey_flow_delete',
      'homey_flow_get',
      'homey_flow_update',
      'homey_flow_validate',
      'homey_flows_list',
    ])
  })

  it('marks deleting and replacing a flow as destructive, and creating one as not', () => {
    const harness = createHarness()

    expect(takeTool(harness, 'homey_flow_delete').config.annotations).toMatchObject({ destructiveHint: true })
    // Both update tools replace a stored definition: an array that is sent
    // wipes the stored one, and the advanced graph drops every card not re-sent.
    // A client that reads destructiveHint should be able to ask about that.
    expect(takeTool(harness, 'homey_flow_update').config.annotations).toMatchObject({ destructiveHint: true })
    expect(takeTool(harness, 'homey_advancedflow_update').config.annotations).toMatchObject({ destructiveHint: true })
    expect(takeTool(harness, 'homey_flow_create').config.annotations).toMatchObject({ destructiveHint: false })
    expect(takeTool(harness, 'homey_flows_list').config.annotations).toMatchObject({ readOnlyHint: true })
  })
})

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe('homey_flows_list', () => {
  it('lists standard and advanced flows together', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flows_list').handler({})

    const flows = structuredOf(result)['flows'] as Array<Record<string, unknown>>
    expect(flows.some((flow) => flow['kind'] === 'standard')).toBe(true)
    expect(flows.some((flow) => flow['kind'] === 'advanced')).toBe(true)
  })

  it('filters by name, kind and state', async () => {
    const harness = createHarness()

    const byName = await takeTool(harness, 'homey_flows_list').handler({ query: 'attic' })
    expect((structuredOf(byName)['flows'] as unknown[]).length).toBe(2)

    const broken = await takeTool(harness, 'homey_flows_list').handler({ brokenOnly: true })
    expect((structuredOf(broken)['flows'] as Array<Record<string, unknown>>).every((flow) => flow['broken'] === true)).toBe(true)

    const enabled = await takeTool(harness, 'homey_flows_list').handler({ enabledOnly: true })
    expect((structuredOf(enabled)['flows'] as Array<Record<string, unknown>>).every((flow) => flow['enabled'] === true)).toBe(true)
  })

  it('says the Homey does not report broken flows, rather than answering "none"', async () => {
    // Both flow transforms delete `broken` on this firmware, so brokenOnly has
    // nothing to filter on. An empty list would read as "nothing is broken",
    // which is the opposite of what the hub actually said.
    const harness = createHarness()
    for (const flow of [...Object.values(harness.flows), ...Object.values(harness.advancedFlows)]) {
      delete flow['broken']
    }

    const result = await takeTool(harness, 'homey_flows_list').handler({ brokenOnly: true })

    expect(textOf(result)).toContain('does not report which flows are broken')
    expect(structuredOf(result)['brokenReportedByHomey']).toBe(false)
  })

  it('says when the answer was cut short', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flows_list').handler({ limit: 1 })

    expect(structuredOf(result)['truncated']).toBe(true)
  })
})

describe('homey_flow_get', () => {
  it('resolves every card to its title, so the flow reads as a sentence', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_get').handler({ flow: 'Warn when the attic door opens' })

    const flow = structuredOf(result)['flow'] as Record<string, unknown>
    expect((flow['trigger'] as Record<string, unknown>)['title']).toBe('The contact alarm turned on')
    expect((flow['actions'] as Array<Record<string, unknown>>)[0]?.['title']).toBe('Write a notification')
  })

  it('marks a card that no longer exists rather than repeating its id as a title', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_get').handler({ flow: 'Broken doorbell' })

    const trigger = (structuredOf(result)['flow'] as Record<string, unknown>)['trigger'] as Record<string, unknown>
    expect(trigger['exists']).toBe(false)
    expect(trigger['title']).toBeNull()
  })

  it('reports a delay and a duration in seconds', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_get').handler({ flow: 'Warn when the attic door opens' })

    const actions = (structuredOf(result)['flow'] as Record<string, unknown>)['actions'] as Array<Record<string, unknown>>
    expect(actions[1]).toMatchObject({ delaySeconds: 120, durationSeconds: 45 })
  })

  it('returns the graph of an advanced flow, with the join and the delay intact', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_get').handler({ flow: 'Attic door routine' })

    const cards = (structuredOf(result)['flow'] as Record<string, unknown>)['cards'] as Array<Record<string, unknown>>
    expect(cards.find((card) => card['type'] === 'delay')?.['delaySeconds']).toBe(60)
    expect(cards.find((card) => card['type'] === 'all')?.['input']).toHaveLength(2)
  })

  it('fails cleanly on a flow name nothing matches', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_get').handler({ flow: 'no such flow' })

    expect(result.isError).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('homey_flow_validate', () => {
  it('never writes anything, whatever it is handed', async () => {
    const harness = createHarness()
    await takeTool(harness, 'homey_flow_validate').handler(soundFlowInput())

    expect(harness.writes).toEqual([])
  })

  it('passes a sound flow and returns the normalised form', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_validate').handler(soundFlowInput())

    const structured = structuredOf(result)
    expect(structured['valid']).toBe(true)
    const flow = structured['flow'] as Record<string, unknown>
    expect((flow['conditions'] as Array<Record<string, unknown>>)[0]?.['group']).toBe('group1')
  })

  it('reads the trigger meaning of an id that also names an action, so the recommended safe flow can be built', async () => {
    // homey:manager:flow:programmatic_trigger is a trigger AND an action. A
    // catalogue keyed by id alone held whichever kind was indexed last, which is
    // the action, so this flow was rejected as "Start a Flow is an action card
    // and cannot be used as a trigger".
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_validate').handler({
      name: 'Started by another flow',
      trigger: { cardId: PROGRAMMATIC_TRIGGER },
      actions: [{ cardId: NOTIFY_ACTION, args: { text: 'someone started me' } }],
    })

    const structured = structuredOf(result)
    expect(structured['problems']).toEqual([])
    expect(structured['valid']).toBe(true)
  })

  it('still reads the action meaning of that same id when it sits among the actions', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_validate').handler({
      name: 'Start another flow',
      trigger: { cardId: DOOR_TRIGGER },
      actions: [{ cardId: PROGRAMMATIC_TRIGGER, args: { flow: { id: 'ffffffff-0001-4000-8000-000000000000', name: 'Other flow' } } }],
    })

    const structured = structuredOf(result)
    expect(structured['problems']).toEqual([])
    expect(structured['valid']).toBe(true)
  })

  it('names the kind an id actually has rather than claiming the card does not exist', async () => {
    // The trigger exists; it is simply not usable as a condition. Saying "no
    // such card" would send the caller searching for an id it already holds.
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_validate').handler({
      name: 'Wrong slot',
      trigger: { cardId: DOOR_TRIGGER },
      conditions: [{ cardId: PROGRAMMATIC_TRIGGER }],
      actions: [{ cardId: NOTIFY_ACTION, args: { text: 'x' } }],
    })

    const reported = JSON.stringify(structuredOf(result)['problems'])
    // The message has to name the kind the id really has, so assert on that
    // half rather than only on the refusal clause: a message that dropped the
    // kind entirely would still contain "be used as a condition".
    expect(reported).toContain('names a trigger card')
    expect(reported).toContain('can be used as a condition')
    expect(reported).not.toContain('has no flow card')
  })

  it('points every problem at a field this tool actually accepts', async () => {
    // The validator works on the internal canonical model, which spells three
    // fields differently from the tool schema: `id`, `delay` and `duration`
    // against `cardId`, `delaySeconds` and `durationSeconds`. Emitting the
    // internal spelling in the path sent a caller reading it straight to a
    // field name that is not in the object it sent, and zod had already
    // stripped it on the way in.
    const harness = createHarness()
    const validate = takeTool(harness, 'homey_flow_validate')
    const result = await validate.handler({
      name: 'Every kind of wrong',
      trigger: { cardId: 'not-a-card-id' },
      actions: [{ cardId: NOTIFY_ACTION, args: { text: 'x' }, delaySeconds: -1, durationSeconds: -1 }],
    })

    const problems = structuredOf(result)['problems'] as Array<Record<string, unknown>>
    const paths = problems.map((problem) => String(problem['path']))
    expect(paths).toContain('trigger.cardId')
    expect(paths).toContain('actions[0].delaySeconds')
    expect(paths).toContain('actions[0].durationSeconds')

    // Asked of the tool's own schema rather than of a list written out here, so
    // this keeps biting if either side is renamed again. zod strips whatever
    // the schema does not declare, so a field that survives the parse is a
    // field the tool takes.
    const cardShape = z.object(validate.config.inputSchema as z.ZodRawShape)
    const echoed = cardShape.parse({
      name: 'x',
      trigger: { cardId: DOOR_TRIGGER },
      actions: [
        {
          cardId: NOTIFY_ACTION,
          args: { text: 'x' },
          group: 'then',
          inverted: false,
          droptoken: null,
          delaySeconds: 1,
          durationSeconds: 1,
        },
      ],
    }) as { actions: Array<Record<string, unknown>> }
    const acceptedCardFields = new Set(Object.keys(echoed.actions[0]!))
    expect(acceptedCardFields.has('cardId')).toBe(true)

    for (const path of paths) {
      // Only the segment naming a field of a card is checked. An `args.<name>`
      // tail names an argument of that particular card, which is allowed to be
      // absent from the input: that is exactly what "requires the argument"
      // problems report.
      const cardField = /^(?:trigger|conditions\[\d+\]|actions\[\d+\])\.([a-zA-Z]+)$/u.exec(path)?.[1]
      if (cardField === undefined) continue
      expect(acceptedCardFields.has(cardField)).toBe(true)
    }
  })

  it('names the database constraint for a flow with no trigger', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_validate').handler({
      name: 'No trigger',
      trigger: { cardId: '' },
      actions: [{ cardId: NOTIFY_ACTION, args: { text: 'x' } }],
    })

    expect(JSON.stringify(structuredOf(result))).toContain('NOT NULL constraint failed: Flow.trigger')
  })
})

// ---------------------------------------------------------------------------
// Handing one tool's output back to another
// ---------------------------------------------------------------------------

// The server instructions prescribe validate then create, and the three undo
// paths (previousFlow, deletedFlow, storedFlow) all promise that sending the
// value back restores what was there. Both promises are only worth anything
// while what comes out is in the shape that goes back in, and zod drops an
// unrecognised key without saying so. These tests run a flow all the way out
// and all the way back in through the real schemas.
describe('the flow tools round trip through each other', () => {
  const LESS_THAN_CONDITION = 'homey:manager:logic:lt'
  const LUMINANCE_DROPTOKEN = 'homey:device:aaaaaaaa-0004-4000-8000-000000000004|measure_luminance'

  function flowWithEveryCardField(name = 'Warn, wait and hold'): Record<string, unknown> {
    return {
      name,
      trigger: { cardId: DOOR_TRIGGER },
      conditions: [{ cardId: LESS_THAN_CONDITION, args: { value: 5 }, droptoken: LUMINANCE_DROPTOKEN }],
      actions: [{ cardId: NOTIFY_ACTION, args: { text: 'The attic door opened' }, delaySeconds: 30, durationSeconds: 5 }],
    }
  }

  it('creates the delay, the duration and the droptoken that homey_flow_validate reported valid', async () => {
    const harness = createHarness()

    const validated = await takeTool(harness, 'homey_flow_validate').handler(flowWithEveryCardField())
    expect(structuredOf(validated)['valid']).toBe(true)

    // Exactly what a model is told to do: post the flow the validator handed
    // back. Nothing is rebuilt here on purpose.
    const validatedFlow = structuredOf(validated)['flow'] as Record<string, unknown>
    const created = await takeTool(harness, 'homey_flow_create').handler(validatedFlow)
    expect(created.isError).toBeUndefined()

    const written = harness.writes.find((write) => write.operation === 'createFlow')?.payload as {
      conditions: Array<Record<string, unknown>>
      actions: Array<Record<string, unknown>>
    }
    expect(written.actions[0]?.['delay']).toEqual({ number: '30', multiplier: 1 })
    expect(written.actions[0]?.['duration']).toEqual({ number: '5', multiplier: 1 })
    expect(written.conditions[0]?.['droptoken']).toBe(LUMINANCE_DROPTOKEN)

    // And the hub agrees with the request, which it cannot when the request
    // lost the field before it was ever compared.
    expect(structuredOf(created)['verified']).toBe(true)
  })

  it('reports the flow it created with the delay and duration still on it', async () => {
    const harness = createHarness()
    const created = await takeTool(harness, 'homey_flow_create').handler(flowWithEveryCardField())

    const stored = structuredOf(created)['storedFlow'] as { actions: Array<Record<string, unknown>> }
    expect(stored.actions[0]).toMatchObject({ delaySeconds: 30, durationSeconds: 5 })
  })

  it('undoes a change from previousFlow without losing the delay and the duration', async () => {
    const harness = createHarness()
    const created = await takeTool(harness, 'homey_flow_create').handler(flowWithEveryCardField('Held for five seconds'))
    const flowId = String(structuredOf(created)['flowId'])

    const changed = await takeTool(harness, 'homey_flow_update').handler({
      flow: flowId,
      actions: [{ cardId: NOTIFY_ACTION, args: { text: 'Something else' } }],
    })

    const previous = structuredOf(changed)['previousFlow'] as Record<string, unknown>
    const putBack = await takeTool(harness, 'homey_flow_update').handler({
      flow: flowId,
      name: previous['name'],
      trigger: previous['trigger'],
      conditions: previous['conditions'],
      actions: previous['actions'],
    })

    expect(putBack.isError).toBeUndefined()
    const restored = (structuredOf(putBack)['storedFlow'] as { actions: Array<Record<string, unknown>> }).actions[0]
    expect(restored).toMatchObject({ delaySeconds: 30, durationSeconds: 5 })
  })

  it('rebuilds a deleted flow from deletedFlow with its delay and duration intact', async () => {
    const harness = createHarness()
    const created = await takeTool(harness, 'homey_flow_create').handler(flowWithEveryCardField('Doomed'))
    const flowId = String(structuredOf(created)['flowId'])

    const deleted = await takeTool(harness, 'homey_flow_delete').handler({ flow: flowId })
    const definition = structuredOf(deleted)['deletedFlow'] as Record<string, unknown>

    const rebuilt = await takeTool(harness, 'homey_flow_create').handler({
      name: definition['name'],
      trigger: definition['trigger'],
      conditions: definition['conditions'],
      actions: definition['actions'],
    })

    expect(rebuilt.isError).toBeUndefined()
    const stored = structuredOf(rebuilt)['storedFlow'] as { actions: Array<Record<string, unknown>> }
    expect(stored.actions[0]).toMatchObject({ delaySeconds: 30, durationSeconds: 5 })
  })

  it('names a card id "cardId" on the way out, exactly as the card tools name it on the way in', async () => {
    // The rename that stopped one tool short. homey_flowcard_describe and
    // homey_flowcard_autocomplete take `cardId`, so a caller carrying a card
    // from discovery into authoring had to rename it to `id` for validate,
    // create and update, and rename it back for the advanced tools, which kept
    // `cardId` throughout. Every card these tools emit is now in the shape the
    // input accepts.
    const harness = createHarness()

    const validated = await takeTool(harness, 'homey_flow_validate').handler(flowWithEveryCardField())
    const flow = structuredOf(validated)['flow'] as {
      trigger: Record<string, unknown>
      conditions: Array<Record<string, unknown>>
      actions: Array<Record<string, unknown>>
    }
    expect(flow.trigger['cardId']).toBe(DOOR_TRIGGER)
    expect(flow.trigger['id']).toBeUndefined()
    expect(flow.conditions[0]?.['cardId']).toBe(LESS_THAN_CONDITION)
    expect(flow.actions[0]?.['cardId']).toBe(NOTIFY_ACTION)

    const read = await takeTool(harness, 'homey_flow_get').handler({ flow: 'Warn when the attic door opens' })
    const stored = (structuredOf(read)['flow'] as Record<string, unknown>)['trigger'] as Record<string, unknown>
    expect(stored['cardId']).toBe(DOOR_TRIGGER)
    expect(stored['id']).toBeUndefined()
  })

  it('refuses a card that still names its id the old way, rather than building a flow without a trigger', async () => {
    const harness = createHarness()

    await expect(
      takeTool(harness, 'homey_flow_validate').handler({
        name: 'Old field name',
        trigger: { id: DOOR_TRIGGER },
        actions: [{ cardId: NOTIFY_ACTION, args: { text: 'x' } }],
      }),
    ).rejects.toThrow()
  })

  it('accepts a card whose droptoken is null, which is how a card with nothing dropped on it reads', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_validate').handler({
      name: 'Nothing dropped on it',
      trigger: { cardId: DOOR_TRIGGER, droptoken: null },
      actions: [{ cardId: NOTIFY_ACTION, args: { text: 'x' }, droptoken: null, delaySeconds: null, durationSeconds: null }],
    })

    expect(structuredOf(result)['valid']).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

describe('homey_flow_create', () => {
  it('creates the flow switched off and inside its own folder', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_create').handler(soundFlowInput())

    const structured = structuredOf(result)
    expect(structured['enabled']).toBe(false)
    expect((structured['folder'] as Record<string, unknown>)['name']).toBe('AI')

    const written = harness.writes.find((write) => write.operation === 'createFlow')?.payload as Record<string, unknown>
    expect(written['enabled']).toBe(false)
    expect(written['folder']).toBe((structured['folder'] as Record<string, unknown>)['id'])
  })

  it('creates the folder on demand, and reuses it the second time', async () => {
    const harness = createHarness()
    await takeTool(harness, 'homey_flow_create').handler(soundFlowInput('First'))
    await takeTool(harness, 'homey_flow_create').handler(soundFlowInput('Second'))

    expect(harness.writes.filter((write) => write.operation === 'createFlowFolder')).toHaveLength(1)
  })

  it('hands the library canonical card ids, which it splits again itself for this hub', async () => {
    const harness = createHarness()
    await takeTool(harness, 'homey_flow_create').handler(soundFlowInput())

    const written = harness.writes.find((write) => write.operation === 'createFlow')?.payload as Record<string, Record<string, unknown>>
    expect(written['trigger']?.['id']).toBe(DOOR_TRIGGER)
    expect(written['trigger']).not.toHaveProperty('uri')
  })

  it('never sends a firmware-computed field back', async () => {
    const harness = createHarness()
    await takeTool(harness, 'homey_flow_create').handler(soundFlowInput())

    const written = JSON.stringify(harness.writes.find((write) => write.operation === 'createFlow')?.payload)
    expect(written).not.toContain('"broken"')
    expect(written).not.toContain('"triggerable"')
    expect(written).not.toContain('"triggerCount"')
  })

  it('writes the group and the inverted flag the editor writes', async () => {
    const harness = createHarness()
    await takeTool(harness, 'homey_flow_create').handler(soundFlowInput())

    const written = harness.writes.find((write) => write.operation === 'createFlow')?.payload as {
      conditions: Array<Record<string, unknown>>
      actions: Array<Record<string, unknown>>
    }
    expect(written.conditions[0]).toMatchObject({ group: 'group1', inverted: true })
    expect(written.actions[0]).toMatchObject({ group: 'then' })
  })

  it('refuses an invalid flow and writes nothing at all', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_create').handler({
      name: 'Made up card',
      trigger: { cardId: 'homey:app:com.example.missing:something' },
      actions: [{ cardId: NOTIFY_ACTION, args: { text: 'x' } }],
    })

    expect(result.isError).toBe(true)
    expect(harness.writes).toEqual([])
  })

  it('reads the flow back and reports what the hub stored differently', async () => {
    // The hub accepts an argument it then changes, and says nothing. The diff
    // after the write is the only place that becomes visible.
    const harness = createHarness({
      mangleOnWrite: (flow) => {
        const mangled = structuredClone(flow) as { actions: Array<Record<string, unknown>> }
        mangled.actions[0]!['args'] = { text: 'something else entirely' }
        return mangled as unknown as Record<string, unknown>
      },
    })

    const result = await takeTool(harness, 'homey_flow_create').handler(soundFlowInput())
    const structured = structuredOf(result)

    expect(structured['verified']).toBe(false)
    expect((structured['differences'] as Array<Record<string, unknown>>)[0]?.['path']).toBe('actions[0].args.text')
    expect(textOf(result)).toContain('before switching it on')
  })

  it('returns a link the owner can open', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_create').handler(soundFlowInput())

    expect(String(structuredOf(result)['url'])).toMatch(/^https:\/\/my\.homey\.app\/flows\//)
  })

  it('declares its reads idempotent and its writes not, so only the reads are ever repeated', async () => {
    // The queue repeats a timeout only on a call the caller declared idempotent.
    // createFlow must never carry that flag: a timed-out write may already have
    // been carried out, and a repeat would build the flow twice.
    const harness = createHarness()
    await takeTool(harness, 'homey_flow_create').handler(soundFlowInput())

    const idempotencyByLabel = new Map(harness.queued.map((entry) => [entry.label, entry.idempotent]))
    expect(idempotencyByLabel.get('flow.getFlow')).toBe(true)
    expect(idempotencyByLabel.get('flow.createFlow')).toBe(false)
    expect(idempotencyByLabel.get('flow.createFlowFolder')).toBe(false)
  })

  it('builds the flow that starts only when another flow starts it, and reads its trigger back as the trigger', async () => {
    // End to end over the id both a trigger and an action carry: the write must
    // happen at all, and reading it back must report "This Flow is started"
    // rather than the action "Start a Flow" that shares the id.
    const harness = createHarness()
    const created = await takeTool(harness, 'homey_flow_create').handler({
      name: 'Started by another flow',
      trigger: { cardId: PROGRAMMATIC_TRIGGER },
      actions: [{ cardId: NOTIFY_ACTION, args: { text: 'someone started me' } }],
    })

    expect(created.isError).toBeFalsy()
    expect(harness.writes.filter((write) => write.operation === 'createFlow')).toHaveLength(1)

    const read = await takeTool(harness, 'homey_flow_get').handler({ flow: 'Started by another flow' })
    const trigger = (structuredOf(read)['flow'] as Record<string, unknown>)['trigger'] as Record<string, unknown>
    expect(trigger['title']).toBe('This Flow is started')
    expect(textOf(read)).toContain('This Flow is started')
  })
})

// ---------------------------------------------------------------------------
// Changing and deleting
// ---------------------------------------------------------------------------

describe('homey_flow_update', () => {
  it('will not change a flow this server did not create without confirmation', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_update').handler({
      flow: 'Warn when the attic door opens',
      name: 'Renamed by an assistant',
    })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('confirm')
    expect(harness.writes).toEqual([])
  })

  it('changes it once the caller confirms, and keeps the flow as it was', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_update').handler({
      flow: 'Warn when the attic door opens',
      name: 'Renamed on request',
      confirm: true,
    })

    const structured = structuredOf(result)
    expect(structured['verified']).toBe(true)
    const previous = structured['previousFlow'] as Record<string, unknown>
    expect(previous['name']).toBe('Warn when the attic door opens')
    expect((previous['actions'] as unknown[]).length).toBe(2)
  })

  it('needs no confirmation for a flow it created itself', async () => {
    const harness = createHarness()
    const created = await takeTool(harness, 'homey_flow_create').handler(soundFlowInput('Made here'))
    const flowId = String(structuredOf(created)['flowId'])

    const result = await takeTool(harness, 'homey_flow_update').handler({ flow: flowId, name: 'Made here, renamed' })

    expect(result.isError).toBeUndefined()
  })

  it('keeps the parts of the flow the caller did not mention', async () => {
    const harness = createHarness()
    await takeTool(harness, 'homey_flow_update').handler({
      flow: 'Warn when the attic door opens',
      name: 'Renamed on request',
      confirm: true,
    })

    const written = harness.writes.find((write) => write.operation === 'updateFlow')?.payload as {
      flow: { name: string; actions: unknown[]; trigger: Record<string, unknown> }
    }
    expect(written.flow.name).toBe('Renamed on request')
    expect(written.flow.actions).toHaveLength(2)
    expect(written.flow.trigger['id']).toBe(DOOR_TRIGGER)
  })

  it('reads the flow again before merging, so an edit made in the app is not silently undone', async () => {
    const harness = createHarness()
    // Warm the cache, then change the flow the way the owner would have in the
    // Homey app. The cached list is now a minute out of date; the merge must
    // not be built on it.
    await takeTool(harness, 'homey_flows_list').handler({})
    harness.flows['bbbbbbbb-0009-4000-8000-000000000009']!['actions'] = [
      { uri: 'homey:manager:notifications', id: 'create_notification', args: { text: 'Edited in the app' }, group: 'then' },
    ]

    const result = await takeTool(harness, 'homey_flow_update').handler({
      flow: 'Warn when the attic door opens',
      name: 'Renamed on request',
      confirm: true,
    })

    const previous = structuredOf(result)['previousFlow'] as Record<string, unknown>
    const previousActions = previous['actions'] as Array<Record<string, unknown>>
    expect(previousActions).toHaveLength(1)
    expect((previousActions[0]?.['args'] as Record<string, unknown>)['text']).toBe('Edited in the app')

    const written = harness.writes.find((write) => write.operation === 'updateFlow')?.payload as {
      flow: { actions: Array<Record<string, unknown>> }
    }
    expect(written.flow.actions).toHaveLength(1)
  })

  it('sends an advanced flow to the tool that understands graphs', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_update').handler({ flow: 'Attic door routine', confirm: true })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(structuredOf(result))).toContain('homey_advancedflow_update')
  })

  it('does not name the advanced tool on a Homey that never registered it', async () => {
    // Advanced Flow is a separate purchase on this hardware, so the advanced
    // tools can be absent while advanced flows are not. Naming a tool the model
    // cannot see leaves it with nowhere to go.
    const harness = createHarness({ advancedFlowSupport: false })
    expect(harness.tools.has('homey_advancedflow_update')).toBe(false)

    const result = await takeTool(harness, 'homey_flow_update').handler({ flow: 'Attic door routine', confirm: true })

    expect(result.isError).toBe(true)
    const reported = JSON.stringify(structuredOf(result))
    expect(reported).not.toContain('homey_advancedflow_update')
    expect(reported).toContain('Homey app')
  })

  it('names the advanced tool on a Homey whose probe never settled the question', async () => {
    // The registration gate asks shouldOfferCapability, which offers the tools
    // on an unsettled probe, so the suggestion has to agree with it. Reading
    // the three-valued support for truth made this branch state that the hub
    // does not have Advanced Flow while homey_advancedflow_update sat in the
    // model's own tool list.
    const harness = createHarness({ advancedFlowSupport: null })
    expect(harness.tools.has('homey_advancedflow_update')).toBe(true)

    const result = await takeTool(harness, 'homey_flow_update').handler({ flow: 'Attic door routine', confirm: true })

    expect(result.isError).toBe(true)
    const reported = JSON.stringify(structuredOf(result))
    expect(reported).toContain('homey_advancedflow_update')
    expect(reported).not.toContain('does not have Advanced Flow')
  })
})

// ---------------------------------------------------------------------------
// Switching a flow on
// ---------------------------------------------------------------------------

// A flow is created switched off so that a person reads it before it can run the
// house. Ownership cannot protect that pause, because the flow the server just
// created is a flow the server created: without a gate of its own, the same
// caller that wrote a door-unlocking flow can switch it on in the next call and
// nobody ever sees it.
describe('switching a flow on', () => {
  const graph = {
    cards: [
      { key: 'clock', type: 'trigger', cardId: CRON_TRIGGER, args: { time: '22:00' }, outputSuccess: ['notify'] },
      { key: 'notify', type: 'action', cardId: NOTIFY_ACTION, args: { text: 'Ten o clock' } },
    ],
  }

  async function createDisabledFlow(harness: Harness, name = 'Unlock the front door'): Promise<string> {
    const created = await takeTool(harness, 'homey_flow_create').handler(soundFlowInput(name))
    expect(structuredOf(created)['enabled']).toBe(false)
    return String(structuredOf(created)['flowId'])
  }

  it('refuses to switch on a flow it created itself, and says what would let it', async () => {
    const harness = createHarness()
    const flowId = await createDisabledFlow(harness)

    const result = await takeTool(harness, 'homey_flow_update').handler({ flow: flowId, enabled: true })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('confirmEnable')
    expect(harness.writes.some((write) => write.operation === 'updateFlow')).toBe(false)
    expect(harness.flows[flowId]?.['enabled']).toBe(false)
  })

  it('switches it on once the owner has confirmed it', async () => {
    const harness = createHarness()
    const flowId = await createDisabledFlow(harness)

    const result = await takeTool(harness, 'homey_flow_update').handler({ flow: flowId, enabled: true, confirmEnable: true })

    expect(result.isError).toBeUndefined()
    expect(harness.flows[flowId]?.['enabled']).toBe(true)
  })

  it('does not gate switching a flow off, or a change that leaves the switch alone', async () => {
    const harness = createHarness()

    const off = await takeTool(harness, 'homey_flow_update').handler({
      flow: 'Warn when the attic door opens',
      enabled: false,
      confirm: true,
    })
    expect(off.isError).toBeUndefined()
    expect(harness.flows['bbbbbbbb-0009-4000-8000-000000000009']?.['enabled']).toBe(false)

    const flowId = await createDisabledFlow(harness, 'Still being written')
    const renamed = await takeTool(harness, 'homey_flow_update').handler({ flow: flowId, name: 'Still being written, renamed' })
    expect(renamed.isError).toBeUndefined()
    expect(harness.flows[flowId]?.['enabled']).toBe(false)
  })

  it('leaves a flow that is already on alone, since nothing starts running that was not already', async () => {
    const harness = createHarness({ askSupported: true })

    const result = await takeTool(harness, 'homey_flow_update').handler({
      flow: 'Warn when the attic door opens',
      enabled: true,
      confirm: true,
    })

    expect(result.isError).toBeUndefined()
    expect(harness.askedQuestions).toEqual([])
  })

  it('asks the owner as well, where the client can put the question to them', async () => {
    const harness = createHarness({ askSupported: true, ask: async () => ({ answered: true, value: 'enable', declined: false }) })
    const flowId = await createDisabledFlow(harness)

    const result = await takeTool(harness, 'homey_flow_update').handler({ flow: flowId, enabled: true, confirmEnable: true })

    expect(harness.askedQuestions).toHaveLength(1)
    expect(harness.askedQuestions[0]?.question).toContain('Unlock the front door')
    expect(result.isError).toBeUndefined()
    expect(harness.flows[flowId]?.['enabled']).toBe(true)
  })

  it('does not switch it on when the owner was asked and said no, whatever the caller sent', async () => {
    const harness = createHarness({ askSupported: true, ask: async () => ({ answered: true, value: 'leave', declined: false }) })
    const flowId = await createDisabledFlow(harness)

    const result = await takeTool(harness, 'homey_flow_update').handler({ flow: flowId, enabled: true, confirmEnable: true })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Do not send the same call again')
    expect(harness.flows[flowId]?.['enabled']).toBe(false)
    expect(harness.writes.some((write) => write.operation === 'updateFlow')).toBe(false)
  })

  it('gates an advanced flow the same way', async () => {
    const harness = createHarness()
    const created = await takeTool(harness, 'homey_advancedflow_create').handler({ name: 'Say the time', ...structuredClone(graph) })
    const flowId = String(structuredOf(created)['flowId'])
    expect(harness.advancedFlows[flowId]?.['enabled']).toBe(false)

    const refused = await takeTool(harness, 'homey_advancedflow_update').handler({
      flow: flowId,
      enabled: true,
      ...structuredClone(graph),
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('confirmEnable')
    expect(harness.advancedFlows[flowId]?.['enabled']).toBe(false)

    const allowed = await takeTool(harness, 'homey_advancedflow_update').handler({
      flow: flowId,
      enabled: true,
      confirmEnable: true,
      ...structuredClone(graph),
    })
    expect(allowed.isError).toBeUndefined()
    expect(harness.advancedFlows[flowId]?.['enabled']).toBe(true)
  })
})

describe('homey_flow_delete', () => {
  it('will not delete a flow this server did not create without confirmation', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_delete').handler({ flow: 'Warn when the attic door opens' })

    expect(result.isError).toBe(true)
    expect(harness.flows['bbbbbbbb-0009-4000-8000-000000000009']).toBeDefined()
  })

  it('returns the whole flow it deleted, since the Homey has no undo', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flow_delete').handler({
      flow: 'Warn when the attic door opens',
      confirm: true,
    })

    const deleted = structuredOf(result)['deletedFlow'] as Record<string, unknown>
    expect((deleted['trigger'] as Record<string, unknown>)['cardId']).toBe(DOOR_TRIGGER)
    expect(harness.flows['bbbbbbbb-0009-4000-8000-000000000009']).toBeUndefined()
  })

  it('deletes an advanced flow through its own route', async () => {
    const harness = createHarness()
    await takeTool(harness, 'homey_flow_delete').handler({ flow: 'Attic door routine', confirm: true })

    expect(harness.writes.map((write) => write.operation)).toContain('deleteAdvancedFlow')
  })

  it('rebuilds a deleted advanced flow from deletedFlow, which is the only undo there is', async () => {
    // The regression this exists for: the result said in as many words that it
    // was "rendered in the shape the create tools accept", and for an advanced
    // flow it was not. The graph came back under `nodes` while
    // homey_advancedflow_create takes `cards`, so zod dropped it and the rebuild
    // failed on a required field, with the deleted flow already gone from the
    // hub.
    const harness = createHarness()
    const deleted = await takeTool(harness, 'homey_flow_delete').handler({
      flow: 'Attic door routine',
      confirm: true,
    })

    const definition = structuredOf(deleted)['deletedFlow'] as Record<string, unknown>
    expect(definition['nodes']).toBeUndefined()

    const rebuilt = await takeTool(harness, 'homey_advancedflow_create').handler({
      name: definition['name'],
      cards: definition['cards'],
    })

    expect(rebuilt.isError).toBeUndefined()
    expect(structuredOf(rebuilt)['verified']).toBe(true)
    const written = harness.writes.find((write) => write.operation === 'createAdvancedFlow')?.payload as {
      cards: Record<string, unknown>
    }
    expect(Object.keys(written.cards)).toHaveLength(6)
  })
})

// ---------------------------------------------------------------------------
// Ambiguity
// ---------------------------------------------------------------------------

describe('resolving a flow by name', () => {
  const SECOND_EVENING_FLOW = 'bbbbbbbb-0020-4000-8000-000000000020'

  /** A second flow with the same name. The Homey allows it, and people do it. */
  function addDuplicateName(harness: Harness): void {
    harness.flows[SECOND_EVENING_FLOW] = {
      id: SECOND_EVENING_FLOW,
      name: 'Evening lights',
      enabled: true,
      folder: null,
      trigger: { uri: 'homey:manager:cron', id: 'time_exactly', args: { time: '20:00' } },
      conditions: [],
      actions: [],
    }
  }

  it('returns the candidates rather than picking one when the client cannot ask', async () => {
    const harness = createHarness()
    addDuplicateName(harness)

    const result = await takeTool(harness, 'homey_flow_get').handler({ flow: 'Evening lights' })

    expect(result.isError).toBe(true)
    expect((failureOf(result)['details'] as Record<string, unknown>)['candidates']).toHaveLength(2)
    expect(harness.askedQuestions).toEqual([])
  })

  it('asks the owner when the client can put the question', async () => {
    const harness = createHarness({
      askSupported: true,
      ask: async (options) => ({ answered: true, value: options.choices?.[1]?.value ?? null, declined: false }),
    })
    addDuplicateName(harness)

    const result = await takeTool(harness, 'homey_flow_get').handler({ flow: 'Evening lights' })

    expect(harness.askedQuestions).toHaveLength(1)
    expect((structuredOf(result)['flow'] as Record<string, unknown>)['id']).toBe(SECOND_EVENING_FLOW)
  })

  it('prefers an exact name over a longer one that merely starts with it', async () => {
    const harness = createHarness()
    harness.flows[SECOND_EVENING_FLOW] = {
      id: SECOND_EVENING_FLOW,
      name: 'Evening lights upstairs',
      enabled: true,
      folder: null,
      trigger: { uri: 'homey:manager:cron', id: 'time_exactly', args: { time: '20:00' } },
      conditions: [],
      actions: [],
    }

    const result = await takeTool(harness, 'homey_flow_get').handler({ flow: 'Evening lights' })

    expect((structuredOf(result)['flow'] as Record<string, unknown>)['id']).toBe('bbbbbbbb-0001-4000-8000-000000000001')
  })
})

// ---------------------------------------------------------------------------
// Advanced flows
// ---------------------------------------------------------------------------

describe('homey_advancedflow_create', () => {
  const graphInput = {
    name: 'Say the time at ten',
    cards: [
      { key: 'clock', type: 'trigger', cardId: CRON_TRIGGER, args: { time: '22:00' }, outputSuccess: ['wait', 'check'] },
      { key: 'wait', type: 'delay', delaySeconds: 60, outputSuccess: ['join'] },
      { key: 'check', type: 'condition', cardId: PRESENCE_CONDITION, outputTrue: ['join'] },
      { key: 'join', type: 'all', outputSuccess: ['notify'] },
      {
        key: 'notify',
        type: 'action',
        cardId: NOTIFY_ACTION,
        args: { text: 'It is [[trigger::clock::time]]' },
      },
    ],
  }

  it('turns every readable label into a card id the firmware accepts', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_advancedflow_create').handler(structuredClone(graphInput))

    const written = harness.writes.find((write) => write.operation === 'createAdvancedFlow')?.payload as {
      cards: Record<string, Record<string, unknown>>
    }
    for (const key of Object.keys(written.cards)) {
      // Anything other than a version 4 UUID is rejected with a message about
      // additional properties, which names the wrong thing entirely.
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
    expect(Object.keys(structuredOf(result)['nodeKeysByLabel'] as Record<string, unknown>).sort()).toEqual([
      'check',
      'clock',
      'join',
      'notify',
      'wait',
    ])
  })

  it('rewrites a node token to the key the card actually got', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_advancedflow_create').handler(structuredClone(graphInput))

    const identifiers = structuredOf(result)['nodeKeysByLabel'] as Record<string, string>
    const written = harness.writes.find((write) => write.operation === 'createAdvancedFlow')?.payload as {
      cards: Record<string, Record<string, unknown>>
    }
    const notify = written.cards[identifiers['notify']!]
    expect((notify?.['args'] as Record<string, unknown>)['text']).toBe(`It is [[trigger::${identifiers['clock']}::time]]`)
  })

  it('records each incoming edge on the join as well as on the card that feeds it', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_advancedflow_create').handler(structuredClone(graphInput))

    const identifiers = structuredOf(result)['nodeKeysByLabel'] as Record<string, string>
    const written = harness.writes.find((write) => write.operation === 'createAdvancedFlow')?.payload as {
      cards: Record<string, Record<string, unknown>>
    }
    expect(written.cards[identifiers['join']!]?.['input']).toEqual([
      `${identifiers['wait']}::outputSuccess`,
      `${identifiers['check']}::outputTrue`,
    ])
  })

  it('gives every card coordinates on the grid, so the flow opens readable', async () => {
    const harness = createHarness()
    await takeTool(harness, 'homey_advancedflow_create').handler(structuredClone(graphInput))

    const written = harness.writes.find((write) => write.operation === 'createAdvancedFlow')?.payload as {
      cards: Record<string, Record<string, unknown>>
    }
    for (const card of Object.values(written.cards)) {
      expect(Number(card['x']) % 20).toBe(0)
      expect(Number(card['y']) % 20).toBe(0)
    }
  })

  it('writes a delay inside args, where a delay card keeps it', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_advancedflow_create').handler(structuredClone(graphInput))

    const identifiers = structuredOf(result)['nodeKeysByLabel'] as Record<string, string>
    const written = harness.writes.find((write) => write.operation === 'createAdvancedFlow')?.payload as {
      cards: Record<string, Record<string, unknown>>
    }
    expect(written.cards[identifiers['wait']!]?.['args']).toEqual({ delay: { number: '1', multiplier: 60 } })
  })

  it('creates it switched off and in its own folder', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_advancedflow_create').handler(structuredClone(graphInput))

    expect(structuredOf(result)['enabled']).toBe(false)
    const written = harness.writes.find((write) => write.operation === 'createAdvancedFlow')?.payload as Record<string, unknown>
    expect(written['enabled']).toBe(false)
    expect(written['folder']).toBeTypeOf('string')
  })

  it('refuses a graph nothing can start, and writes nothing', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_advancedflow_create').handler({
      name: 'No way in',
      cards: [{ key: 'notify', type: 'action', cardId: NOTIFY_ACTION, args: { text: 'x' } }],
    })

    expect(result.isError).toBe(true)
    expect(harness.writes).toEqual([])
  })

  it('refuses a standard-flow token inside a graph', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_advancedflow_create').handler({
      name: 'Wrong dialect',
      cards: [
        { key: 'clock', type: 'trigger', cardId: CRON_TRIGGER, args: { time: '22:00' }, outputSuccess: ['notify'] },
        { key: 'notify', type: 'action', cardId: NOTIFY_ACTION, args: { text: 'It is [[time]]' } },
      ],
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(structuredOf(result))).toContain('standard-flow token')
  })
})

// The update tool's own description says the whole graph is replaced and tells
// the model to read the current one with homey_flow_get first. That instruction
// is only safe while everything homey_flow_get emits is something the update
// tool accepts back.
describe('homey_flow_get into homey_advancedflow_update', () => {
  const GRAPH_FLOW_ID = 'bbbbbbbb-0022-4000-8000-000000000022'
  const TRIGGER_NODE = 'dddddddd-0021-4000-8000-000000000021'
  const CONDITION_NODE = 'dddddddd-0022-4000-8000-000000000022'
  const SPEAK_NODE = 'dddddddd-0023-4000-8000-000000000023'
  const NOTE_NODE = 'dddddddd-0024-4000-8000-000000000024'
  const LUMINANCE_DROPTOKEN = 'homey:device:aaaaaaaa-0004-4000-8000-000000000004|measure_luminance'

  /** A graph carrying the two fields the reader used to drop: a droptoken and a note colour. */
  function addGraphWithDroptokenAndColouredNote(harness: Harness): void {
    harness.advancedFlows[GRAPH_FLOW_ID] = {
      id: GRAPH_FLOW_ID,
      name: 'Say something when it gets dark',
      enabled: true,
      folder: null,
      cards: {
        [TRIGGER_NODE]: {
          ownerUri: 'homey:manager:cron',
          id: 'time_exactly',
          args: { time: '22:00' },
          type: 'trigger',
          x: 40,
          y: 200,
          outputSuccess: [CONDITION_NODE],
        },
        [CONDITION_NODE]: {
          ownerUri: 'homey:manager:logic',
          id: 'lt',
          args: { value: 5 },
          droptoken: LUMINANCE_DROPTOKEN,
          type: 'condition',
          x: 440,
          y: 200,
          outputTrue: [SPEAK_NODE],
        },
        [SPEAK_NODE]: {
          ownerUri: 'homey:manager:notifications',
          id: 'create_notification',
          args: { text: 'It is dark on the attic landing' },
          type: 'action',
          x: 840,
          y: 200,
        },
        [NOTE_NODE]: { type: 'note', value: 'The porch sensor reads low under the roof light', color: 'blue', x: 40, y: 400 },
      },
    }
  }

  it('sends the droptoken and the note colour back unchanged when the graph is read and rewritten', async () => {
    const harness = createHarness()
    addGraphWithDroptokenAndColouredNote(harness)

    const read = await takeTool(harness, 'homey_flow_get').handler({ flow: 'Say something when it gets dark' })
    const cards = (structuredOf(read)['flow'] as Record<string, unknown>)['cards'] as Array<Record<string, unknown>>

    // What the instruction says to do: read the graph, change one edge, send the
    // whole thing back. Every other card is passed through untouched.
    const rewritten = cards.map((card) =>
      card['key'] === TRIGGER_NODE ? { ...card, outputSuccess: [CONDITION_NODE, SPEAK_NODE] } : card,
    )
    const updated = await takeTool(harness, 'homey_advancedflow_update').handler({
      flow: GRAPH_FLOW_ID,
      confirm: true,
      cards: rewritten,
    })
    expect(updated.isError).toBeUndefined()

    const written = harness.writes.find((write) => write.operation === 'updateAdvancedFlow')?.payload as {
      advancedflow: { cards: Record<string, Record<string, unknown>> }
    }
    expect(written.advancedflow.cards[CONDITION_NODE]?.['droptoken']).toBe(LUMINANCE_DROPTOKEN)
    expect(written.advancedflow.cards[NOTE_NODE]?.['color']).toBe('blue')
    expect(written.advancedflow.cards[NOTE_NODE]?.['value']).toBe('The porch sensor reads low under the roof light')
  })

  it('keeps the canvas the owner arranged when the graph is read and rewritten', async () => {
    // The coordinates are on the wire and on the node type, and the update tool
    // replaces the whole graph. While the input schema did not accept x and y,
    // zod stripped both off every card the reader had just been handed, so
    // applyAutoLayout treated a hand-arranged flow as unplaced and moved every
    // card in it. The owner's arrangement of their own flow is not this
    // server's to discard on an unrelated edit.
    const harness = createHarness()
    addGraphWithDroptokenAndColouredNote(harness)

    const read = await takeTool(harness, 'homey_flow_get').handler({ flow: 'Say something when it gets dark' })
    const cards = (structuredOf(read)['flow'] as Record<string, unknown>)['cards'] as Array<Record<string, unknown>>
    expect(cards.find((card) => card['key'] === NOTE_NODE)).toMatchObject({ x: 40, y: 400 })

    const rewritten = cards.map((card) =>
      card['key'] === TRIGGER_NODE ? { ...card, outputSuccess: [CONDITION_NODE, SPEAK_NODE] } : card,
    )
    const updated = await takeTool(harness, 'homey_advancedflow_update').handler({
      flow: GRAPH_FLOW_ID,
      confirm: true,
      cards: rewritten,
    })
    expect(updated.isError).toBeUndefined()

    const written = harness.writes.find((write) => write.operation === 'updateAdvancedFlow')?.payload as {
      advancedflow: { cards: Record<string, Record<string, unknown>> }
    }
    expect(written.advancedflow.cards[TRIGGER_NODE]).toMatchObject({ x: 40, y: 200 })
    expect(written.advancedflow.cards[CONDITION_NODE]).toMatchObject({ x: 440, y: 200 })
    expect(written.advancedflow.cards[SPEAK_NODE]).toMatchObject({ x: 840, y: 200 })
    expect(written.advancedflow.cards[NOTE_NODE]).toMatchObject({ x: 40, y: 400 })
  })
})

describe('homey_advancedflow_update', () => {
  it('will not change a graph this server did not create without confirmation', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_advancedflow_update').handler({
      flow: 'Attic door routine',
      cards: [{ key: 'clock', type: 'trigger', cardId: CRON_TRIGGER, args: { time: '22:00' } }],
    })

    expect(result.isError).toBe(true)
    expect(harness.writes).toEqual([])
  })

  it('keeps the graph as it was, so a wrong change can be put back', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_advancedflow_update').handler({
      flow: 'Attic door routine',
      confirm: true,
      cards: [{ key: 'clock', type: 'trigger', cardId: CRON_TRIGGER, args: { time: '22:00' } }],
    })

    // Under `cards`, which is what the create and update tools take, and never
    // under the internal `nodes`. This result is the whole undo path for a
    // change that replaces the graph wholesale.
    const previous = structuredOf(result)['previousFlow'] as Record<string, unknown>
    expect(previous['nodes']).toBeUndefined()
    expect((previous['cards'] as unknown[]).length).toBe(6)
  })

  it('puts the graph back from previousFlow without renaming a single field', async () => {
    // The regression this exists for: previousFlow emitted the graph under
    // `nodes` while the tool takes it under `cards`, so zod dropped the graph
    // entirely and the undo failed on a required field the caller had never
    // been shown. Nothing is rebuilt or renamed here on purpose.
    const harness = createHarness()
    const changed = await takeTool(harness, 'homey_advancedflow_update').handler({
      flow: 'Attic door routine',
      confirm: true,
      cards: [{ key: 'clock', type: 'trigger', cardId: CRON_TRIGGER, args: { time: '22:00' } }],
    })
    const previous = structuredOf(changed)['previousFlow'] as Record<string, unknown>

    const putBack = await takeTool(harness, 'homey_advancedflow_update').handler({
      flow: 'Attic door routine',
      confirm: true,
      name: previous['name'],
      cards: previous['cards'],
    })

    expect(putBack.isError).toBeUndefined()
    expect(structuredOf(putBack)['verified']).toBe(true)
    const written = harness.writes.filter((write) => write.operation === 'updateAdvancedFlow')
    const restored = (written[written.length - 1]?.payload as { advancedflow: { cards: Record<string, unknown> } })
      .advancedflow.cards
    expect(Object.keys(restored)).toHaveLength(6)
  })

  it('sends a standard flow to the tool that understands it', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_advancedflow_update').handler({
      flow: 'Warn when the attic door opens',
      confirm: true,
      cards: [],
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(structuredOf(result))).toContain('homey_flow_update')
  })
})
