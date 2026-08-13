// The hub validates argument values against a card's own schema and almost
// nothing else, so everything that saves happily and then misbehaves has to be
// caught here. Each test names the failure mode it prevents.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { FlowCardIndex } from '../homey/cache.js'
import { createHomeCache } from '../homey/cache.js'
import type { HomeyConnection } from '../homey/types.js'
import { createLogger } from '../util/log.js'
import type { CanonicalFlow } from './model.js'
import type { CanonicalAdvancedFlow } from './advanced.js'
import type { ValidationContext, ValidationProblem } from './validate.js'
import { validateAdvancedFlow, validateFlow } from './validate.js'

interface FlowFixture {
  flowCardTriggers: unknown[]
  flowCardConditions: unknown[]
  flowCardActions: unknown[]
}

const fixture = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/flow-authoring-sample.json', import.meta.url), 'utf8'),
) as FlowFixture

const LAMP_ID = 'aaaaaaaa-0001-4000-8000-000000000001'
const RADIATOR_ID = 'aaaaaaaa-0002-4000-8000-000000000002'
const DOOR_ID = 'aaaaaaaa-0004-4000-8000-000000000004'

const DOOR_TRIGGER = `homey:device:${DOOR_ID}:alarm_contact_true`
const PRESENCE_CONDITION = 'homey:manager:presence:noone_athome'
const LOGIC_LESS_THAN = 'homey:manager:logic:lt'
const NOTIFY_ACTION = 'homey:manager:notifications:create_notification'
const LAMP_ACTION = `homey:device:${LAMP_ID}:onoff`
const RADIATOR_ACTION = `homey:device:${RADIATOR_ID}:target_temperature_set`
const CRON_TRIGGER = 'homey:manager:cron:time_exactly'
/** The one id the measured hub gives to two cards: a trigger and an action. */
const PROGRAMMATIC_TRIGGER = 'homey:manager:flow:programmatic_trigger'

/** Loads the fixture's cards through the real cache, so the V2 mapping is exercised too. */
async function loadCards(): Promise<FlowCardIndex> {
  const connection: HomeyConnection = {
    api: {
      devices: { getDevices: async () => ({}) },
      zones: { getZones: async () => ({}) },
      flow: {
        getFlows: async () => ({}),
        getAdvancedFlows: async () => ({}),
        getFlowFolders: async () => ({}),
        getFlowCardTriggers: async () => fixture.flowCardTriggers,
        getFlowCardConditions: async () => fixture.flowCardConditions,
        getFlowCardActions: async () => fixture.flowCardActions,
      },
      insights: { getLogs: async () => ({}) },
      logic: { getVariables: async () => ({}) },
    },
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
    request: async (operation) => operation(),
  }

  const cache = createHomeCache(connection, { logger: createLogger({ level: 'silent' }) })
  return await cache.getAllFlowCards()
}

async function contextFor(overrides: Partial<ValidationContext> = {}): Promise<ValidationContext> {
  return {
    cards: await loadCards(),
    deviceIds: new Set([LAMP_ID, RADIATOR_ID, DOOR_ID]),
    zoneIds: new Set(['22222222-2222-4222-8222-222222222222']),
    folderIds: new Set(['cccccccc-0001-4000-8000-000000000001']),
    dialect: 'v2',
    ...overrides,
  }
}

function soundFlow(): CanonicalFlow {
  return {
    name: 'Warn when the attic door opens',
    trigger: { id: DOOR_TRIGGER, args: {} },
    conditions: [{ id: PRESENCE_CONDITION, args: {}, group: 'group1', inverted: true }],
    actions: [{ id: NOTIFY_ACTION, args: { text: 'The attic door opened' }, group: 'then' }],
  }
}

function problemsAt(problems: ValidationProblem[], path: string): ValidationProblem[] {
  return problems.filter((problem) => problem.path === path)
}

describe('validateFlow', () => {
  it('has nothing to say about a sound flow', async () => {
    expect(validateFlow(soundFlow(), await contextFor())).toEqual([])
  })

  it('names the database constraint when the flow has no trigger, because that is the error the hub gives', async () => {
    const flow: CanonicalFlow = { ...soundFlow(), trigger: { id: '', args: {} } }

    const [problem] = problemsAt(validateFlow(flow, await contextFor()), 'trigger')
    expect(problem?.problem).toContain('NOT NULL constraint failed: Flow.trigger')
    expect(problem?.suggestion).toContain('programmatic_trigger')
  })

  it('refuses a card this Homey does not have, which would otherwise save and show as "NO CARD"', async () => {
    const flow: CanonicalFlow = {
      ...soundFlow(),
      actions: [{ id: 'homey:app:com.example.missing:do_something', args: {}, group: 'then' }],
    }

    const [problem] = problemsAt(validateFlow(flow, await contextFor()), 'actions[0].id')
    expect(problem?.problem).toContain('NO CARD')
  })

  it('refuses a condition card used as an action', async () => {
    const flow: CanonicalFlow = { ...soundFlow(), actions: [{ id: PRESENCE_CONDITION, args: {}, group: 'then' }] }

    const [problem] = problemsAt(validateFlow(flow, await contextFor()), 'actions[0].id')
    expect(problem?.problem).toContain('is a condition card, so it cannot be used as an action')
    // "a action" is what an article glued to the kind produced, and a reader
    // who cannot trust the grammar reads the rest of the sentence more slowly.
    expect(problem?.problem).not.toContain('a action')
  })

  it('names each card behind an id that means two things, rather than one title with both kinds', async () => {
    // The message used to take the first match's title and every match's kind,
    // so "This Flow is started" was announced as "a trigger and a action card":
    // one card's name with both cards' meanings, and a broken article on top.
    const flow: CanonicalFlow = {
      ...soundFlow(),
      conditions: [{ id: PROGRAMMATIC_TRIGGER, args: {}, group: 'group1' }],
    }

    const [problem] = problemsAt(validateFlow(flow, await contextFor()), 'conditions[0].id')
    expect(problem?.problem).toContain('a trigger card ("This Flow is started")')
    expect(problem?.problem).toContain('an action card ("Start a Flow")')
    expect(problem?.problem).toContain('none of them can be used as a condition')
    expect(problem?.problem).not.toContain('a action')
  })

  it('accepts both meanings of an id that names a card of two kinds', async () => {
    // homey:manager:flow:programmatic_trigger is the trigger "This Flow is
    // started" and the action "Start a Flow". A catalogue keyed by id alone
    // held only the action, so the trigger this server recommends as always safe
    // was rejected as the wrong kind and the flow could not be built.
    const asTrigger: CanonicalFlow = { ...soundFlow(), trigger: { id: PROGRAMMATIC_TRIGGER, args: {} } }
    expect(validateFlow(asTrigger, await contextFor())).toEqual([])

    const asAction: CanonicalFlow = {
      ...soundFlow(),
      actions: [{ id: PROGRAMMATIC_TRIGGER, args: { flow: { id: 'ffffffff-0001-4000-8000-000000000000', name: 'Other flow' } }, group: 'then' }],
    }
    expect(validateFlow(asAction, await contextFor())).toEqual([])
  })

  it('says which kind an id really is instead of claiming the Homey has no such card', async () => {
    const flow: CanonicalFlow = {
      ...soundFlow(),
      conditions: [{ id: PROGRAMMATIC_TRIGGER, args: {}, group: 'group1' }],
    }

    const [problem] = problemsAt(validateFlow(flow, await contextFor()), 'conditions[0].id')
    expect(problem?.problem).toContain('used as a condition')
    expect(problem?.problem).not.toContain('has no flow card')
  })

  it('refuses something that is not a card id at all', async () => {
    const flow: CanonicalFlow = { ...soundFlow(), trigger: { id: 'turn on the light', args: {} } }

    expect(problemsAt(validateFlow(flow, await contextFor()), 'trigger.id')).toHaveLength(1)
  })

  it('names a deprecated card without refusing it', async () => {
    const flow: CanonicalFlow = { ...soundFlow(), trigger: { id: `homey:device:${LAMP_ID}:onoff_true`, args: {} } }

    const problems = problemsAt(validateFlow(flow, await contextFor()), 'trigger.id')
    expect(problems[0]?.problem).toContain('deprecated')
  })

  it('reports an argument the card does not declare, and lists the ones it does', async () => {
    const flow: CanonicalFlow = {
      ...soundFlow(),
      actions: [{ id: NOTIFY_ACTION, args: { message: 'hello' }, group: 'then' }],
    }

    const problems = validateFlow(flow, await contextFor())
    expect(problemsAt(problems, 'actions[0].args.message')[0]?.suggestion).toContain('text')
    expect(problemsAt(problems, 'actions[0].args.text')[0]?.problem).toContain('requires the argument')
  })

  it('refuses a dropdown value that is not one of the card\'s ids', async () => {
    const flow: CanonicalFlow = { ...soundFlow(), actions: [{ id: LAMP_ACTION, args: { onoff: 'On' }, group: 'then' }] }

    expect(problemsAt(validateFlow(flow, await contextFor()), 'actions[0].args.onoff')).toHaveLength(1)
  })

  it('refuses a number outside the range the card declares, which the hub answers with "Invalid arguments"', async () => {
    const flow: CanonicalFlow = {
      ...soundFlow(),
      actions: [{ id: RADIATOR_ACTION, args: { target_temperature: 60 }, group: 'then' }],
    }

    const [problem] = problemsAt(validateFlow(flow, await contextFor()), 'actions[0].args.target_temperature')
    expect(problem?.problem).toContain('maximum of 35')
  })

  it('refuses a droptoken written with a colon, which saves fine and shows as "Unavailable"', async () => {
    const flow: CanonicalFlow = {
      ...soundFlow(),
      conditions: [
        {
          id: LOGIC_LESS_THAN,
          args: { value: 10 },
          group: 'group1',
          droptoken: `homey:device:${DOOR_ID}:measure_battery`,
        },
      ],
    }

    const [problem] = problemsAt(validateFlow(flow, await contextFor()), 'conditions[0].droptoken')
    expect(problem?.problem).toContain('pipe')
  })

  it('accepts a droptoken written with a pipe', async () => {
    const flow: CanonicalFlow = {
      ...soundFlow(),
      conditions: [
        {
          id: LOGIC_LESS_THAN,
          args: { value: 10 },
          group: 'group1',
          droptoken: `homey:device:${DOOR_ID}|measure_battery`,
        },
      ],
    }

    expect(validateFlow(flow, await contextFor())).toEqual([])
  })

  it('refuses a droptoken on a card that has no droptoken slot', async () => {
    const flow: CanonicalFlow = {
      ...soundFlow(),
      conditions: [{ id: PRESENCE_CONDITION, args: {}, group: 'group1', droptoken: `homey:device:${DOOR_ID}|onoff` }],
    }

    expect(problemsAt(validateFlow(flow, await contextFor()), 'conditions[0].droptoken')).toHaveLength(1)
  })

  it('reports a missing condition group, which crashes the Homey web editor rather than failing on save', async () => {
    const flow: CanonicalFlow = { ...soundFlow(), conditions: [{ id: PRESENCE_CONDITION, args: {} }] }

    const [problem] = problemsAt(validateFlow(flow, await contextFor()), 'conditions[0].group')
    expect(problem?.problem).toContain('web editor')
  })

  it('refuses a fourth condition group on a hub that only has three', async () => {
    const flow: CanonicalFlow = {
      ...soundFlow(),
      conditions: [{ id: PRESENCE_CONDITION, args: {}, group: 'group4' }],
    }

    expect(problemsAt(validateFlow(flow, await contextFor({ dialect: 'v2' })), 'conditions[0].group')).toHaveLength(1)
    expect(problemsAt(validateFlow(flow, await contextFor({ dialect: 'v3' })), 'conditions[0].group')).toHaveLength(0)
  })

  it('refuses an action group that is neither then nor else', async () => {
    const flow: CanonicalFlow = { ...soundFlow(), actions: [{ id: NOTIFY_ACTION, args: { text: 'x' }, group: 'group1' }] }

    expect(problemsAt(validateFlow(flow, await contextFor()), 'actions[0].group')).toHaveLength(1)
  })

  it('refuses an advanced-flow node token inside a standard flow', async () => {
    const flow: CanonicalFlow = {
      ...soundFlow(),
      actions: [
        {
          id: NOTIFY_ACTION,
          args: { text: 'at [[trigger::dddddddd-0011-4000-8000-000000000011::time]]' },
          group: 'then',
        },
      ],
    }

    const [problem] = problemsAt(validateFlow(flow, await contextFor()), 'actions[0].args.text')
    expect(problem?.problem).toContain('advanced-flow token')
  })

  it('accepts the standard flow token dialects', async () => {
    const flow: CanonicalFlow = {
      ...soundFlow(),
      trigger: { id: CRON_TRIGGER, args: { time: '22:00' } },
      actions: [
        { id: NOTIFY_ACTION, args: { text: 'at [[time]] and [[homey:manager:cron|time]]' }, group: 'then' },
      ],
    }

    expect(validateFlow(flow, await contextFor())).toEqual([])
  })

  // The short form addresses a value the flow's OWN trigger publishes. Checking
  // only the dialect waved through a short reference to anything else, which is
  // the "Unavailable" card this project calls its most expensive failure. The
  // owner's hub has exactly one bare reference in its real flows, in a flow the
  // hub itself marks broken, and this is why.
  it('refuses a short token the flow\'s own trigger does not publish', async () => {
    const flow: CanonicalFlow = {
      ...soundFlow(),
      trigger: { id: DOOR_TRIGGER, args: {} },
      actions: [{ id: NOTIFY_ACTION, args: { text: 'at [[time]]' }, group: 'then' }],
    }

    const [problem] = problemsAt(validateFlow(flow, await contextFor()), 'actions[0].args.text')
    expect(problem?.problem).toContain('[[time]]')
    // Which trigger was checked, and what it does publish. "Unknown token" on
    // its own sends a reader round in circles looking for the wrong thing.
    expect(problem?.problem).toContain('The contact alarm turned on')
    expect(problem?.problem).toContain(DOOR_TRIGGER)
    expect(problem?.problem).toContain('publishes no values at all')
    expect(problem?.suggestion).toContain('[[<ownerUri>|<tokenId>]]')
  })

  it('lists what the trigger does publish when the short token is merely the wrong one', async () => {
    const flow: CanonicalFlow = {
      ...soundFlow(),
      trigger: { id: CRON_TRIGGER, args: { time: '22:00' } },
      actions: [{ id: NOTIFY_ACTION, args: { text: 'at [[hour]]' }, group: 'then' }],
    }

    const [problem] = problemsAt(validateFlow(flow, await contextFor()), 'actions[0].args.text')
    expect(problem?.problem).toContain('publishes only: time')
  })

  it('accepts a short token the trigger really publishes, in the trigger\'s own args too', async () => {
    const flow: CanonicalFlow = {
      ...soundFlow(),
      trigger: { id: CRON_TRIGGER, args: { time: '22:00' } },
      actions: [{ id: NOTIFY_ACTION, args: { text: 'it is [[time]]' }, group: 'then' }],
    }

    expect(validateFlow(flow, await contextFor())).toEqual([])
  })

  it('says nothing about the tokens when the trigger card itself is unknown, which is the problem to fix first', async () => {
    const flow: CanonicalFlow = {
      ...soundFlow(),
      trigger: { id: 'homey:app:com.example.missing:message_received', args: {} },
      actions: [{ id: NOTIFY_ACTION, args: { text: 'at [[message]]' }, group: 'then' }],
    }

    const problems = validateFlow(flow, await contextFor())
    expect(problemsAt(problems, 'trigger.id')).toHaveLength(1)
    expect(problemsAt(problems, 'actions[0].args.text')).toEqual([])
  })

  it('reports a device that is not on this Homey any more, which the hub reports as healthy', async () => {
    const flow: CanonicalFlow = {
      ...soundFlow(),
      actions: [
        {
          id: NOTIFY_ACTION,
          args: { text: 'value [[homey:device:aaaaaaaa-9999-4000-8000-000000009999|measure_power]]' },
          group: 'then',
        },
      ],
    }

    const [problem] = problemsAt(validateFlow(flow, await contextFor()), 'actions[0]')
    expect(problem?.problem).toContain('not on this Homey')
  })

  it('reports a folder that no longer exists, which the hub quietly resets to the root', async () => {
    const flow: CanonicalFlow = { ...soundFlow(), folder: 'cccccccc-9999-4000-8000-000000009999' }

    expect(problemsAt(validateFlow(flow, await contextFor()), 'folder')).toHaveLength(1)
  })

  it('says plainly when a flow does nothing', async () => {
    const flow: CanonicalFlow = { ...soundFlow(), actions: [] }

    expect(problemsAt(validateFlow(flow, await contextFor()), 'actions')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Advanced flows
// ---------------------------------------------------------------------------

function soundGraph(): CanonicalAdvancedFlow {
  return {
    name: 'Attic door routine',
    nodes: [
      {
        key: 'dddddddd-0011-4000-8000-000000000011',
        type: 'trigger',
        cardId: CRON_TRIGGER,
        args: { time: '22:00' },
        x: 0,
        y: 0,
        outputSuccess: ['dddddddd-0016-4000-8000-000000000016'],
      },
      {
        key: 'dddddddd-0016-4000-8000-000000000016',
        type: 'action',
        cardId: NOTIFY_ACTION,
        args: { text: 'at [[trigger::dddddddd-0011-4000-8000-000000000011::time]]' },
        x: 400,
        y: 0,
      },
    ],
  }
}

describe('validateAdvancedFlow', () => {
  it('has nothing to say about a sound graph', async () => {
    expect(validateAdvancedFlow(soundGraph(), await contextFor())).toEqual([])
  })

  it('refuses a node key that is not a version 4 UUID, and says what the hub\'s message really means', async () => {
    const graph = soundGraph()
    graph.nodes[0]!.key = 'motion'
    graph.nodes[1]!.outputSuccess = []
    graph.nodes[1]!.args = {}

    const problems = validateAdvancedFlow(graph, await contextFor())
    expect(problems.some((problem) => problem.problem.includes('should NOT have additional properties'))).toBe(true)
  })

  it('refuses an edge pointing at a card that is not in the flow', async () => {
    const graph = soundGraph()
    graph.nodes[0]!.outputSuccess = ['dddddddd-9999-4000-8000-000000009999']

    const problems = validateAdvancedFlow(graph, await contextFor())
    expect(problems.some((problem) => problem.problem.includes('is not a card in this flow'))).toBe(true)
  })

  it('refuses a join waiting on a card that is not in the flow', async () => {
    const graph = soundGraph()
    graph.nodes.push({
      key: 'dddddddd-0015-4000-8000-000000000015',
      type: 'all',
      input: ['dddddddd-9999-4000-8000-000000009999::outputTrue'],
      x: 800,
      y: 0,
    })
    graph.nodes[1]!.outputSuccess = ['dddddddd-0015-4000-8000-000000000015']

    const problems = validateAdvancedFlow(graph, await contextFor())
    expect(problems.some((problem) => problem.problem.includes('wait forever'))).toBe(true)
  })

  it('refuses a node token naming a card the flow does not contain', async () => {
    const graph = soundGraph()
    graph.nodes[1]!.args = { text: 'at [[trigger::dddddddd-9999-4000-8000-000000009999::time]]' }

    const problems = validateAdvancedFlow(graph, await contextFor())
    expect(problems.some((problem) => problem.problem.includes('is not in this flow'))).toBe(true)
  })

  it('refuses a standard-flow bare token, which has nothing to read from in a graph', async () => {
    const graph = soundGraph()
    graph.nodes[1]!.args = { text: 'at [[time]]' }

    const problems = validateAdvancedFlow(graph, await contextFor())
    expect(problems.some((problem) => problem.problem.includes('standard-flow token'))).toBe(true)
  })

  it('accepts a global token in a graph, which still reads a device capability', async () => {
    const graph = soundGraph()
    graph.nodes[1]!.args = { text: `battery [[homey:device:${DOOR_ID}|measure_battery]]` }

    expect(validateAdvancedFlow(graph, await contextFor())).toEqual([])
  })

  it('reports a card nothing can reach', async () => {
    const graph = soundGraph()
    graph.nodes.push({ key: 'dddddddd-0017-4000-8000-000000000017', type: 'action', cardId: NOTIFY_ACTION, args: { text: 'orphan' }, x: 0, y: 400 })

    const problems = validateAdvancedFlow(graph, await contextFor())
    expect(problems.some((problem) => problem.problem.includes('nothing can reach this card'))).toBe(true)
  })

  it('does not call a note orphaned, since a note is never wired to anything', async () => {
    const graph = soundGraph()
    graph.nodes.push({ key: 'dddddddd-0018-4000-8000-000000000018', type: 'note', value: 'Why this exists', x: 0, y: -80 })

    expect(validateAdvancedFlow(graph, await contextFor())).toEqual([])
  })

  it('reports a graph nothing can start', async () => {
    const graph = soundGraph()
    graph.nodes[0]!.type = 'action'
    graph.nodes[0]!.cardId = NOTIFY_ACTION
    graph.nodes[0]!.args = { text: 'x' }

    const problems = validateAdvancedFlow(graph, await contextFor())
    expect(problems.some((problem) => problem.problem.includes('nothing that starts it'))).toBe(true)
  })

  it('reports a delay that was never told how long to wait', async () => {
    const graph = soundGraph()
    graph.nodes.push({ key: 'dddddddd-0019-4000-8000-000000000019', type: 'delay', x: 400, y: 200 })
    graph.nodes[0]!.outputSuccess = ['dddddddd-0016-4000-8000-000000000016', 'dddddddd-0019-4000-8000-000000000019']

    const problems = validateAdvancedFlow(graph, await contextFor())
    expect(problems.some((problem) => problem.path.endsWith('.delaySeconds'))).toBe(true)
  })
})
