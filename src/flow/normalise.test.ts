// Normalisation writes what the Homey editor writes and coerces what the card
// declares. The line it must not cross is guessing: a value it cannot bring to
// the declared type is reported, never replaced, because the wrong number here
// is the wrong thing happening in someone's house.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { FlowCardIndex } from '../homey/cache.js'
import { createHomeCache, toEntries } from '../homey/cache.js'
import type { HomeyConnection } from '../homey/types.js'
import { createLogger } from '../util/log.js'
import type { NormalisationProblem } from './normalise.js'
import { coerceArgumentValue, missingRequiredArguments, normaliseCard, normaliseFlow, unknownArguments } from './normalise.js'

interface FlowFixture {
  flowCardTriggers: unknown[]
  flowCardConditions: unknown[]
  flowCardActions: unknown[]
}

const fixture = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/flow-authoring-sample.json', import.meta.url), 'utf8'),
) as FlowFixture

/**
 * Builds the card index the way the real server does, through the cache, so
 * these tests exercise the same V2 to canonical mapping the tools rely on.
 */
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

const LAMP_ON_OFF = 'homey:device:aaaaaaaa-0001-4000-8000-000000000001:onoff'
const RADIATOR_SET = 'homey:device:aaaaaaaa-0002-4000-8000-000000000002:target_temperature_set'
const CAST_SAY = 'homey:app:com.example.cast:tts'
const DOOR_TRIGGER = 'homey:device:aaaaaaaa-0004-4000-8000-000000000004:alarm_contact_true'
/** The one id the measured hub gives to two cards: a trigger and an action. */
const PROGRAMMATIC_TRIGGER = 'homey:manager:flow:programmatic_trigger'

describe('normaliseFlow', () => {
  it('fills in the group and the inverted flag the editor always writes', async () => {
    const { flow } = normaliseFlow(
      {
        name: '  Attic warning  ',
        trigger: { id: DOOR_TRIGGER },
        conditions: [{ id: 'homey:manager:presence:noone_athome' }],
        actions: [{ id: 'homey:manager:notifications:create_notification', args: { text: 'hello' } }],
      },
      await loadCards(),
    )

    expect(flow.name).toBe('Attic warning')
    expect(flow.conditions[0]?.group).toBe('group1')
    expect(flow.conditions[0]?.inverted).toBe(false)
    expect(flow.actions[0]?.group).toBe('then')
    expect(flow.trigger.args).toEqual({})
  })

  it('leaves an argument the card does not declare exactly as it was', async () => {
    // Reporting an unknown argument is the validator's job. Silently dropping
    // it here would hide a card that changed its schema behind a flow that
    // simply stopped doing part of its work.
    const { flow } = normaliseFlow(
      {
        name: 'Unknown argument',
        trigger: { id: DOOR_TRIGGER },
        conditions: [],
        actions: [{ id: LAMP_ON_OFF, args: { onoff: 'true', whatIsThis: 42 } }],
      },
      await loadCards(),
    )

    expect(flow.actions[0]?.args).toEqual({ onoff: 'true', whatIsThis: 42 })
  })

  it('coerces a card against the schema of its own kind, for an id that names two cards', async () => {
    // homey:manager:flow:programmatic_trigger is a trigger taking no arguments
    // AND an action taking an autocomplete `flow`. Looked up by id alone the
    // trigger got the action's schema, so a stray argument on the trigger was
    // measured against an autocomplete it does not have and reported as
    // something to go and resolve through the hub.
    const triggerProblems: NormalisationProblem[] = []
    const cards = await loadCards()

    const trigger = normaliseCard({ id: PROGRAMMATIC_TRIGGER, args: { flow: 'Other flow' } }, 'trigger', 'trigger', cards, triggerProblems)
    expect(trigger.args).toEqual({ flow: 'Other flow' })
    expect(triggerProblems).toEqual([])

    // The same id in the action slot keeps the action's schema, so the object
    // the hub returned for the autocomplete is accepted whole.
    const actionProblems: NormalisationProblem[] = []
    const chosen = { id: 'ffffffff-0001-4000-8000-000000000000', name: 'Other flow' }
    const action = normaliseCard({ id: PROGRAMMATIC_TRIGGER, args: { flow: chosen } }, 'action', 'actions[0]', cards, actionProblems)
    expect(action.args).toEqual({ flow: chosen })
    expect(actionProblems).toEqual([])
  })
})

describe('coerceArgumentValue', () => {
  function descriptorFor(cardId: string, argumentName: string, cards: FlowCardIndex) {
    const argument = cards.findById(cardId)[0]?.args.find((entry) => entry.name === argumentName)
    if (argument === undefined) throw new Error(`The fixture has no ${cardId} argument ${argumentName}`)
    return argument
  }

  it('turns a numeric string into a number, because the card wants a JSON number', async () => {
    const problems: NormalisationProblem[] = []
    const cards = await loadCards()

    const value = coerceArgumentValue(descriptorFor(RADIATOR_SET, 'target_temperature', cards), '21', 'path', problems)

    expect(value).toBe(21)
    expect(problems).toEqual([])
  })

  it('accepts the visible label for a dropdown and stores the id the hub wants', async () => {
    const problems: NormalisationProblem[] = []
    const cards = await loadCards()

    expect(coerceArgumentValue(descriptorFor(LAMP_ON_OFF, 'onoff', cards), 'On', 'path', problems)).toBe('true')
    expect(problems).toEqual([])
  })

  it('refuses a dropdown value that is neither an id nor a label', async () => {
    const problems: NormalisationProblem[] = []
    const cards = await loadCards()

    coerceArgumentValue(descriptorFor(LAMP_ON_OFF, 'onoff', cards), 'maybe', 'actions[0]', problems)

    expect(problems).toHaveLength(1)
    expect(problems[0]?.suggestion).toContain('true (On)')
  })

  it('will not build an autocomplete value out of a name, because app-specific fields would be lost', async () => {
    const problems: NormalisationProblem[] = []
    const cards = await loadCards()

    const value = coerceArgumentValue(descriptorFor(CAST_SAY, 'device', cards), 'Nook speaker', 'actions[0]', problems)

    expect(value).toBe('Nook speaker')
    expect(problems[0]?.suggestion).toContain('homey_flowcard_autocomplete')
  })

  it('keeps an autocomplete object with its extra fields intact', async () => {
    const problems: NormalisationProblem[] = []
    const cards = await loadCards()
    const chosen = { id: 'cast-nook', name: 'Nook speaker', host: 'nook.example.invalid', model: 'Example Cast' }

    expect(coerceArgumentValue(descriptorFor(CAST_SAY, 'device', cards), chosen, 'actions[0]', problems)).toEqual(chosen)
    expect(problems).toEqual([])
  })
})

describe('argument bookkeeping', () => {
  it('names every required argument the card did not get', async () => {
    const cards = await loadCards()
    const descriptor = cards.findById(RADIATOR_SET)[0]
    expect(descriptor).toBeDefined()

    expect(missingRequiredArguments({ id: RADIATOR_SET, args: {} }, descriptor!)).toEqual(['target_temperature'])
    expect(missingRequiredArguments({ id: RADIATOR_SET, args: { target_temperature: 21 } }, descriptor!)).toEqual([])
  })

  it('names every argument the card does not declare', async () => {
    const cards = await loadCards()
    const descriptor = cards.findById(LAMP_ON_OFF)[0]
    expect(descriptor).toBeDefined()

    expect(unknownArguments({ id: LAMP_ON_OFF, args: { onoff: 'true', brightness: 1 } }, descriptor!)).toEqual(['brightness'])
  })
})

describe('the fixture itself', () => {
  it('is shaped like the hub answers, with cards as an array and flows as a map', () => {
    // Pinning this because the cache's `toEntries` accepts both, and a fixture
    // that quietly changed shape would stop exercising the array path.
    expect(Array.isArray(fixture.flowCardTriggers)).toBe(true)
    expect(toEntries(fixture.flowCardTriggers)).toHaveLength(fixture.flowCardTriggers.length)
  })
})
