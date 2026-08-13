// Card discovery decides whether a flow can be built at all. The measured hub
// exposes 808 cards totalling 617 KB, so the two behaviours that matter are
// that an unfiltered search is refused rather than truncated, and that a search
// result stays small enough to be worth reading.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { createHomeCache } from '../../homey/cache.js'
import { createLogger } from '../../util/log.js'
import type { ServerContext } from '../context.js'
import type { CapabilityRegistry, HomeyConnection } from '../../homey/types.js'
import { registerFlowCardTools } from './flowcards.js'

interface HomeFixture {
  zones: Record<string, unknown>
  devices: Record<string, unknown>
  flows: Record<string, unknown>
  advancedFlows: Record<string, unknown>
  flowFolders: Record<string, unknown>
  logicVariables: Record<string, unknown>
}

interface FlowFixture {
  flowCardTriggers: unknown[]
  flowCardConditions: unknown[]
  flowCardActions: unknown[]
  autocompleteResults: Array<Record<string, unknown>>
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

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>

interface RegisteredTestTool {
  config: { annotations?: Record<string, unknown>; inputSchema?: Record<string, unknown> }
  handler: ToolHandler
}

interface AutocompleteCall {
  id: string
  type: string
  name: string
  query: string
  args?: Record<string, unknown>
}

interface Harness {
  tools: Map<string, RegisteredTestTool>
  autocompleteCalls: AutocompleteCall[]
}

interface HarnessOptions {
  /** Path segments the fake hub answers to. Anything else gets a 404, as a missing route does. */
  answeringSegments?: string[]
  /** Replaces the condition catalogue. No app on the measured hub publishes a condition token. */
  flowCardConditions?: unknown[]
  /** Replaces the action catalogue, for the same reason: no action in the fixture emits a token. */
  flowCardActions?: unknown[]
}

function createHarness(options: HarnessOptions = {}): Harness {
  const autocompleteCalls: AutocompleteCall[] = []
  const answeringSegments = options.answeringSegments ?? ['flowcardtrigger', 'flowcardcondition', 'flowcardaction']

  const managers = {
    devices: { getDevices: async () => homeFixture.devices },
    zones: { getZones: async () => homeFixture.zones },
    flow: {
      getFlows: async () => homeFixture.flows,
      getAdvancedFlows: async () => homeFixture.advancedFlows,
      getFlowFolders: async () => homeFixture.flowFolders,
      getFlowCardTriggers: async () => flowFixture.flowCardTriggers,
      getFlowCardConditions: async () => options.flowCardConditions ?? flowFixture.flowCardConditions,
      getFlowCardActions: async () => options.flowCardActions ?? flowFixture.flowCardActions,
      getFlowCardAutocomplete: async (call: AutocompleteCall) => {
        autocompleteCalls.push(call)
        if (!answeringSegments.includes(call.type)) {
          throw Object.assign(new Error('Not Found'), { statusCode: 404 })
        }
        return flowFixture.autocompleteResults
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
    request: async (operation) => operation(),
  }

  const logger = createLogger({ level: 'silent' })
  const context: ServerContext = {
    connection,
    cache: createHomeCache(connection, { logger, capabilities: CAPABILITY_REGISTRY }),
    capabilities: CAPABILITY_REGISTRY,
    logger,
    ask: async () => ({ answered: false, value: null, declined: false }),
    askSupported: false,
  }

  const tools = new Map<string, RegisteredTestTool>()
  const server = {
    registerTool(name: string, config: RegisteredTestTool['config'], handler: ToolHandler) {
      tools.set(name, { config, handler })
      return {}
    },
  } as unknown as McpServer

  registerFlowCardTools(server, context)

  return { tools, autocompleteCalls }
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

/** The result's text block, which is what a person actually reads. */
function textOf(result: CallToolResult): string {
  const first = result.content[0]
  return first !== undefined && first.type === 'text' ? first.text : ''
}

function cardsOf(result: CallToolResult): Array<Record<string, unknown>> {
  return structuredOf(result)['cards'] as Array<Record<string, unknown>>
}

describe('registration', () => {
  it('registers exactly the three discovery tools, all annotated read-only', () => {
    const harness = createHarness()

    expect([...harness.tools.keys()].sort()).toEqual([
      'homey_flowcard_autocomplete',
      'homey_flowcard_describe',
      'homey_flowcards_search',
    ])

    for (const tool of harness.tools.values()) {
      expect(tool.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    }
  })

  // These tools are used in sequence, so a caller carries the card id straight
  // from homey_flowcard_describe into homey_flowcard_autocomplete. While
  // describe called it `id` and autocomplete called it `cardId`, doing exactly
  // that failed with "expected string, received undefined at cardId", naming a
  // field the caller had never been shown. It happened on the first real
  // attempt against the hub, so the shared name is asserted rather than left to
  // whoever edits one tool next.
  it('asks for the card id under one name on every tool that takes one', () => {
    const harness = createHarness()

    for (const name of ['homey_flowcard_describe', 'homey_flowcard_autocomplete']) {
      const schemaKeys = Object.keys(takeTool(harness, name).config.inputSchema ?? {})
      expect(schemaKeys).toContain('cardId')
      expect(schemaKeys).not.toContain('id')
    }
  })
})

describe('homey_flowcards_search', () => {
  it('refuses an unfiltered call, because the real catalogue is 808 cards and 617 KB', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcards_search').handler({})

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('hundreds of flow cards')
  })

  it('returns only what is needed to choose a card', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcards_search').handler({ query: 'notification' })

    const card = cardsOf(result)[0]
    expect(Object.keys(card ?? {}).sort()).toEqual(['argNames', 'id', 'kind', 'ownerName', 'ownerUri', 'title'])
    expect(card?.['id']).toBe('homey:manager:notifications:create_notification')
    expect(card?.['argNames']).toEqual(['text'])
  })

  it('finds a card by a word in its title and ranks the closest match first', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcards_search').handler({ query: 'turn on or off' })

    expect(cardsOf(result)[0]?.['id']).toBe('homey:device:aaaaaaaa-0001-4000-8000-000000000001:onoff')
  })

  it('finds a card by the short id a model is likely to half-remember', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcards_search').handler({ query: 'alarm contact true' })

    expect(cardsOf(result)[0]?.['id']).toBe('homey:device:aaaaaaaa-0004-4000-8000-000000000004:alarm_contact_true')
  })

  // The wrong-kind diagnostic in flow validation quotes the id back and says to
  // search for the right card, and the search matched title, short id, owner
  // name and hint but never the id itself, so following that advice literally
  // returned nothing at all.
  it('finds a card by the full id pasted straight back in', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcards_search').handler({
      query: 'homey:manager:notifications:create_notification',
    })

    expect(cardsOf(result)[0]?.['id']).toBe('homey:manager:notifications:create_notification')
  })

  it('finds every card of an owner by the owner uri pasted as a query', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcards_search').handler({ query: 'homey:manager:flow' })

    const found = cardsOf(result)
    expect(found.length).toBeGreaterThan(0)
    for (const card of found) {
      expect(card['ownerUri']).toBe('homey:manager:flow')
    }
  })

  it('does not let an ordinary word match the id and drag in every card of a kind', async () => {
    // The id carries "homey", "device" and "manager" on every single card, so
    // comparing plain words against it would make those words free. Only a term
    // carrying a colon is an id, and only that is compared against one.
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcards_search').handler({ query: 'manager' })

    expect(cardsOf(result)).toEqual([])
  })

  it('finds a card by the short id written the way the hub spells it', async () => {
    // Measured against the live hub while checking the id fix: the short id is
    // compared with its underscores folded to spaces, so searching for
    // "programmatic_trigger", the one card this project recommends by name,
    // returned nothing. The words work, the id the reader copied does not.
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcards_search').handler({ query: 'alarm_contact_true' })

    expect(cardsOf(result)[0]?.['id']).toBe('homey:device:aaaaaaaa-0004-4000-8000-000000000004:alarm_contact_true')
  })

  it('requires every search term to appear somewhere on the card', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcards_search').handler({ query: 'notification thermostat' })

    expect(cardsOf(result)).toEqual([])
  })

  it('filters to the cards one device contributes itself', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcards_search').handler({ device: 'Reading lamp' })

    for (const card of cardsOf(result)) {
      expect(card['ownerUri']).toBe('homey:device:aaaaaaaa-0001-4000-8000-000000000001')
    }
    expect(cardsOf(result).length).toBeGreaterThan(0)
  })

  it('reports the candidates instead of guessing when a device name matches several', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcards_search').handler({ device: 'nothing here' })

    expect(result.isError).toBe(true)
  })

  it('filters by card kind', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcards_search').handler({ query: 'the', kind: 'condition' })

    for (const card of cardsOf(result)) {
      expect(card['kind']).toBe('condition')
    }
  })

  it('hides a deprecated card until it is asked for', async () => {
    const harness = createHarness()
    const hidden = await takeTool(harness, 'homey_flowcards_search').handler({ query: 'turned on' })
    const shown = await takeTool(harness, 'homey_flowcards_search').handler({ query: 'turned on', includeDeprecated: true })

    expect(cardsOf(hidden).map((card) => card['id'])).not.toContain('homey:device:aaaaaaaa-0001-4000-8000-000000000001:onoff_true')
    expect(cardsOf(shown).map((card) => card['id'])).toContain('homey:device:aaaaaaaa-0001-4000-8000-000000000001:onoff_true')
  })

  it('says when the answer was cut short', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcards_search').handler({ query: 'the', limit: 1 })

    const structured = structuredOf(result)
    expect(structured['truncated']).toBe(true)
    expect(Number(structured['totalMatches'])).toBeGreaterThan(1)
  })
})

describe('homey_flowcard_describe', () => {
  it('returns the full argument schema, including the range a card enforces', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcard_describe').handler({
      cardId: 'homey:device:aaaaaaaa-0002-4000-8000-000000000002:target_temperature_set',
    })

    const card = structuredOf(result)['card'] as Record<string, unknown>
    const args = card['args'] as Array<Record<string, unknown>>
    expect(args[0]).toMatchObject({ name: 'target_temperature', type: 'number', min: 4, max: 35, step: 0.5 })
  })

  it('says how to fill an autocomplete argument rather than leaving the model to guess', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcard_describe').handler({ cardId: 'homey:app:com.example.cast:tts' })

    const card = structuredOf(result)['card'] as Record<string, unknown>
    const args = card['args'] as Array<Record<string, unknown>>
    expect(args.find((argument) => argument['name'] === 'device')?.['resolveWith']).toContain('homey_flowcard_autocomplete')
  })

  it('reports the tokens a card emits in BOTH dialects, since mixing them is the classic mistake', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcard_describe').handler({ cardId: 'homey:manager:cron:time_exactly' })

    const card = structuredOf(result)['card'] as Record<string, unknown>
    const tokens = card['emitsTokens'] as Array<Record<string, unknown>>
    // A trigger is the one card whose values a standard flow can name in the
    // short form, and even then only in a flow this card triggers, which the
    // note next to it says out loud.
    expect(tokens[0]).toMatchObject({ id: 'time', referenceInStandardFlow: '[[time]]' })
    expect(String(tokens[0]?.['referenceInStandardFlowNote'])).toContain('[[homey:manager:cron|time]]')
    expect(String(tokens[0]?.['referenceInAdvancedFlow'])).toContain('[[trigger::')
  })

  it('addresses an action card through the action namespace', async () => {
    const harness = createHarness({
      flowCardActions: [
        {
          uri: 'homey:app:com.example.http',
          uriObj: { type: 'app', id: 'com.example.http', name: 'Example HTTP' },
          id: 'get',
          title: 'Fetch a page',
          titleFormatted: 'Fetch [[url]]',
          hint: null,
          args: [{ name: 'url', type: 'text' }],
          tokens: [{ id: 'body', type: 'string', title: 'body', hint: null, example: 'ok' }],
        },
      ],
    })

    const result = await takeTool(harness, 'homey_flowcard_describe').handler({ cardId: 'homey:app:com.example.http:get' })

    const card = structuredOf(result)['card'] as Record<string, unknown>
    const tokens = card['emitsTokens'] as Array<Record<string, unknown>>
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.['referenceInAdvancedFlow']).toBe('[[action::<the key of this card in the flow>::body]]')
    expect(tokens[0]?.['referenceInAdvancedFlowNote']).toBeUndefined()
  })

  // The short [[<tokenId>]] form names a value the flow's OWN trigger publishes.
  // Offering it for an action card handed the model a reference the flow can
  // never satisfy, the validator waved it through, the hub stored it, and the
  // Homey app rendered the card as "Unavailable": the server's own suggestion,
  // passed by the server's own check.
  it('never offers the short standard-flow form for a card that is not a trigger', async () => {
    const harness = createHarness({
      flowCardActions: [
        {
          uri: 'homey:manager:util',
          uriObj: { type: 'manager', id: 'util', name: 'Logic' },
          id: 'http_advanced',
          title: 'Make a web request',
          titleFormatted: 'Make a [[method]] request',
          hint: null,
          args: [{ name: 'method', type: 'text' }],
          tokens: [{ id: 'response', type: 'string', title: 'response', hint: null, example: 'ok' }],
        },
      ],
    })

    const result = await takeTool(harness, 'homey_flowcard_describe').handler({ cardId: 'homey:manager:util:http_advanced' })

    const card = structuredOf(result)['card'] as Record<string, unknown>
    const tokens = card['emitsTokens'] as Array<Record<string, unknown>>
    expect(tokens[0]?.['referenceInStandardFlow']).toBe('[[homey:manager:util|response]]')
    expect(String(tokens[0]?.['referenceInStandardFlowNote'])).toContain('own trigger')
    expect(JSON.stringify(card)).not.toContain('[[response]]')
  })

  it('offers a condition card\'s value in the owner form too, the only form it could resolve in', async () => {
    const harness = createHarness({
      flowCardConditions: [
        {
          uri: 'homey:app:com.example.sensor',
          uriObj: { type: 'app', id: 'com.example.sensor', name: 'Example Sensor' },
          id: 'reading_above',
          title: 'The reading is above',
          titleFormatted: 'The reading is above [[limit]]',
          hint: null,
          args: [{ name: 'limit', type: 'number' }],
          tokens: [{ id: 'reading', type: 'number', title: 'reading', hint: null, example: 12 }],
        },
      ],
    })

    const result = await takeTool(harness, 'homey_flowcard_describe').handler({
      cardId: 'homey:app:com.example.sensor:reading_above',
    })

    const card = structuredOf(result)['card'] as Record<string, unknown>
    const tokens = card['emitsTokens'] as Array<Record<string, unknown>>
    expect(tokens[0]?.['referenceInStandardFlow']).toBe('[[homey:app:com.example.sensor|reading]]')
  })

  // A card kind and a node-token namespace are two different vocabularies:
  // trigger / condition / action against trigger / action / card. Reusing the
  // kind verbatim produced "[[condition::...]]", which this project's own token
  // parser rejects and which the firmware saves without complaint before showing
  // the card as "Unavailable". Latent on the measured hub only because no app
  // installed on it publishes a condition token, so the fixture supplies one.
  it('offers no advanced-flow reference for a condition card, rather than an invalid one', async () => {
    const harness = createHarness({
      flowCardConditions: [
        {
          uri: 'homey:app:com.example.sensor',
          uriObj: { type: 'app', id: 'com.example.sensor', name: 'Example Sensor' },
          id: 'reading_above',
          title: 'The reading is above',
          titleFormatted: 'The reading is above [[limit]]',
          hint: null,
          args: [{ name: 'limit', type: 'number' }],
          tokens: [{ id: 'reading', type: 'number', title: 'reading', hint: null, example: 12 }],
        },
      ],
    })

    const result = await takeTool(harness, 'homey_flowcard_describe').handler({
      cardId: 'homey:app:com.example.sensor:reading_above',
    })

    const card = structuredOf(result)['card'] as Record<string, unknown>
    const tokens = card['emitsTokens'] as Array<Record<string, unknown>>
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.['referenceInStandardFlow']).toBe('[[homey:app:com.example.sensor|reading]]')
    expect(tokens[0]?.['referenceInAdvancedFlow']).toBeNull()
    expect(String(tokens[0]?.['referenceInAdvancedFlowNote'])).toContain('trigger or an action')
    expect(JSON.stringify(card)).not.toContain('[[condition::')
  })

  it('normalises the boolean droptoken this firmware sends into the same shape as the newer array', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcard_describe').handler({ cardId: 'homey:manager:logic:lt' })

    const card = structuredOf(result)['card'] as Record<string, unknown>
    expect(card['acceptedDropTokenTypes']).toEqual(['any'])
  })

  it('reports a card that supports a duration', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcard_describe').handler({
      cardId: 'homey:device:aaaaaaaa-0001-4000-8000-000000000001:onoff',
    })

    expect((structuredOf(result)['card'] as Record<string, unknown>)['supportsDuration']).toBe(true)
  })

  it('fails cleanly on a card id that does not exist', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcard_describe').handler({ cardId: 'homey:app:com.example.missing:x' })

    expect(result.isError).toBe(true)
  })

  it('reports every kind an id names, because one id can be two cards', async () => {
    // homey:manager:flow:programmatic_trigger is the trigger "This Flow is
    // started" and the action "Start a Flow". Answering with only one of them,
    // whichever was indexed last, sent the model off to build the wrong card.
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcard_describe').handler({ cardId: 'homey:manager:flow:programmatic_trigger' })

    const cards = structuredOf(result)['cards'] as Array<Record<string, unknown>>
    expect(cards.map((card) => card['kind']).sort()).toEqual(['action', 'trigger'])
    expect(textOf(result)).toContain('This Flow is started')
    expect(textOf(result)).toContain('Start a Flow')
  })

  it('holds the stated kind in "card", not whichever catalogue was concatenated first', async () => {
    // The catalogues are concatenated triggers, conditions, actions, so an id
    // shared by a condition and an action put the condition first and the single
    // "card" field answered with it. Nothing said that was intended, and a
    // change to the index order would have silently changed the answer. An
    // action is the more useful of the two to describe, and now that is a
    // decision rather than a side effect.
    const dual = (kindTitle: string) => [
      {
        uri: 'homey:app:com.example.dual',
        uriObj: { type: 'app', id: 'com.example.dual', name: 'Example Dual' },
        id: 'x',
        title: kindTitle,
        titleFormatted: null,
        hint: null,
        args: [],
        tokens: [],
      },
    ]
    const harness = createHarness({
      flowCardConditions: dual('Is the switch on'),
      flowCardActions: dual('Flip the switch'),
    })

    const result = await takeTool(harness, 'homey_flowcard_describe').handler({ cardId: 'homey:app:com.example.dual:x' })

    const card = structuredOf(result)['card'] as Record<string, unknown>
    expect(card['kind']).toBe('action')
    expect(card['title']).toBe('Flip the switch')
    expect(textOf(result)).toContain('"card" below holds the action')
  })

  it('chooses which card the single "card" field holds, and says which one it is', async () => {
    // Taking the first match left this to the order the three catalogues are
    // concatenated in, so the answer was the trigger by accident and would have
    // changed with the index. The preference is stated in the code and named in
    // the summary, so a reader is never left wondering which of the two they
    // are looking at.
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcard_describe').handler({ cardId: 'homey:manager:flow:programmatic_trigger' })

    const card = structuredOf(result)['card'] as Record<string, unknown>
    expect(card['kind']).toBe('trigger')
    expect(textOf(result)).toContain('"card" below holds the trigger')
  })

  it('describes the one kind that was asked for', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcard_describe').handler({
      cardId: 'homey:manager:flow:programmatic_trigger',
      kind: 'trigger',
    })

    const cards = structuredOf(result)['cards'] as Array<Record<string, unknown>>
    expect(cards).toHaveLength(1)
    expect((structuredOf(result)['card'] as Record<string, unknown>)['title']).toBe('This Flow is started')
  })
})

describe('homey_flowcard_autocomplete', () => {
  it('sends the canonical card id and the flowcard-prefixed type segment, and no owner uri', async () => {
    // The library derives the owner uri from the id and splits it for a V2 hub.
    // An owner uri sent alongside would override that derivation on this route.
    const harness = createHarness()
    await takeTool(harness, 'homey_flowcard_autocomplete').handler({
      cardId: 'homey:app:com.example.cast:tts',
      argument: 'device',
      query: 'nook',
    })

    expect(harness.autocompleteCalls[0]).toMatchObject({
      id: 'homey:app:com.example.cast:tts',
      type: 'flowcardaction',
      name: 'device',
      query: 'nook',
    })
    expect(harness.autocompleteCalls[0]).not.toHaveProperty('uri')
  })

  it('returns the whole result object as the value to store, extra app fields and all', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcard_autocomplete').handler({
      cardId: 'homey:app:com.example.cast:tts',
      argument: 'device',
    })

    const choices = structuredOf(result)['choices'] as Array<Record<string, unknown>>
    expect(choices[0]?.['value']).toEqual({
      id: 'cast-nook',
      name: 'Nook speaker',
      description: 'Cast device',
      host: 'nook.example.invalid',
      model: 'Example Cast',
    })
  })

  it('falls back to the bare kind when the hub has no flowcard-prefixed route, then reuses what worked', async () => {
    const harness = createHarness({ answeringSegments: ['action'] })
    await takeTool(harness, 'homey_flowcard_autocomplete').handler({
      cardId: 'homey:app:com.example.cast:tts',
      argument: 'device',
    })
    await takeTool(harness, 'homey_flowcard_autocomplete').handler({
      cardId: 'homey:app:com.example.cast:tts',
      argument: 'device',
    })

    expect(harness.autocompleteCalls.map((call) => call.type)).toEqual(['flowcardaction', 'action', 'action'])
  })

  it('says plainly that a dropdown is not resolved through the hub, and lists its choices instead', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcard_autocomplete').handler({
      cardId: 'homey:device:aaaaaaaa-0001-4000-8000-000000000001:onoff',
      argument: 'onoff',
    })

    const structured = structuredOf(result)
    expect(structured['resolvable']).toBe(false)
    expect(harness.autocompleteCalls).toEqual([])
  })

  it('names the arguments the card does have when asked for one it does not', async () => {
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcard_autocomplete').handler({
      cardId: 'homey:app:com.example.cast:tts',
      argument: 'speaker',
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(structuredOf(result))).toContain('device')
  })

  it('picks the kind that actually declares the argument, for an id that names two cards', async () => {
    // The action "Start a Flow" takes a `flow` argument; the trigger of the same
    // id takes none. An id-keyed catalogue could hand back either, so which card
    // the hub was asked about was decided by index order.
    const harness = createHarness()
    const result = await takeTool(harness, 'homey_flowcard_autocomplete').handler({
      cardId: 'homey:manager:flow:programmatic_trigger',
      argument: 'flow',
    })

    expect(result.isError).toBeFalsy()
    expect(harness.autocompleteCalls[0]).toMatchObject({
      id: 'homey:manager:flow:programmatic_trigger',
      type: 'flowcardaction',
      name: 'flow',
    })
  })

  it('passes the arguments already chosen, for a choice that depends on an earlier one', async () => {
    const harness = createHarness()
    await takeTool(harness, 'homey_flowcard_autocomplete').handler({
      cardId: 'homey:app:com.example.cast:tts',
      argument: 'device',
      args: { text: 'hello' },
    })

    expect(harness.autocompleteCalls[0]?.args).toEqual({ text: 'hello' })
  })
})
