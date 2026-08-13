// The advanced-flow graph has three constraints the firmware enforces badly or
// not at all: node keys must be version 4 UUIDs (rejected with a message about
// additional properties when they are not), an `all` join records each incoming
// edge twice, and a value from an upstream card is addressed by node key. All
// three are pinned here.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { AdvancedNode, CanonicalAdvancedFlow } from './advanced.js'
import {
  NODE_KEY_PATTERN,
  applyAutoLayout,
  assignNodeKeys,
  createNodeKey,
  deriveJoinInputs,
  diffAdvancedFlows,
  fromAdvancedWire,
  isValidNodeKey,
  outgoingTargets,
  toAdvancedLibraryPayload,
  toAdvancedWire,
} from './advanced.js'

interface FlowFixture {
  advancedFlowWire: Record<string, unknown>
}

const fixture = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/flow-authoring-sample.json', import.meta.url), 'utf8'),
) as FlowFixture

const CRON_NODE = 'dddddddd-0011-4000-8000-000000000011'
const CONDITION_NODE = 'dddddddd-0013-4000-8000-000000000013'
const DELAY_NODE = 'dddddddd-0014-4000-8000-000000000014'
const JOIN_NODE = 'dddddddd-0015-4000-8000-000000000015'
const NOTIFY_NODE = 'dddddddd-0016-4000-8000-000000000016'

function nodeOf(flow: CanonicalAdvancedFlow, key: string): AdvancedNode {
  const node = flow.nodes.find((candidate) => candidate.key === key)
  if (node === undefined) throw new Error(`The fixture has no node ${key}`)
  return node
}

describe('node keys', () => {
  it('mints keys the firmware accepts', () => {
    for (let i = 0; i < 20; i++) {
      expect(isValidNodeKey(createNodeKey())).toBe(true)
    }
  })

  it('accepts only what BOTH firmware generations accept', () => {
    // The 2019 firmware pins the version nibble to 0-5 and the variant to
    // 0/8/9/a/b; the 2023 one pins them to 1-8 and 8/9/a/b. Version 4 lowercase
    // is the intersection, and it is what crypto.randomUUID produces.
    expect(NODE_KEY_PATTERN.test('dddddddd-0011-4000-8000-000000000011')).toBe(true)
    expect(NODE_KEY_PATTERN.test('dddddddd-0011-9000-8000-000000000011')).toBe(false)
    expect(NODE_KEY_PATTERN.test('dddddddd-0011-4000-c000-000000000011')).toBe(false)
    expect(NODE_KEY_PATTERN.test('DDDDDDDD-0011-4000-8000-000000000011')).toBe(false)
    expect(NODE_KEY_PATTERN.test('motion')).toBe(false)
  })
})

describe('assignNodeKeys', () => {
  it('replaces a readable label with a real key and rewrites every edge to it', () => {
    const { nodes, keyByLabel } = assignNodeKeys([
      { key: 'motion', type: 'trigger', cardId: 'homey:device:x:alarm_motion_true', outputSuccess: ['lamp'] },
      { key: 'lamp', type: 'action', cardId: 'homey:device:y:on' },
    ])

    const motionKey = keyByLabel.get('motion')
    const lampKey = keyByLabel.get('lamp')
    expect(motionKey).toBeDefined()
    expect(isValidNodeKey(motionKey!)).toBe(true)
    expect(nodes[0]?.outputSuccess).toEqual([lampKey])
  })

  it('rewrites a node token inside an argument, which is why keys are allocated first', () => {
    const { nodes, keyByLabel } = assignNodeKeys([
      { key: 'clock', type: 'trigger', cardId: 'homey:manager:cron:time_exactly', outputSuccess: ['notify'] },
      {
        key: 'notify',
        type: 'action',
        cardId: 'homey:manager:notifications:create_notification',
        args: { text: 'It is [[trigger::clock::time]]' },
      },
    ])

    expect(nodes[1]?.args?.['text']).toBe(`It is [[trigger::${keyByLabel.get('clock')}::time]]`)
  })

  it('rewrites a join\'s input entries, keeping the port name', () => {
    const { nodes, keyByLabel } = assignNodeKeys([
      { key: 'check', type: 'condition', cardId: 'homey:manager:presence:noone_athome', outputTrue: ['join'] },
      { key: 'join', type: 'all', input: ['check::outputTrue'] },
    ])

    expect(nodes[1]?.input).toEqual([`${keyByLabel.get('check')}::outputTrue`])
  })

  it('keeps a key that is already valid, so a graph read back from the hub round-trips', () => {
    const { nodes } = assignNodeKeys([{ key: CRON_NODE, type: 'trigger', cardId: 'homey:manager:cron:time_exactly' }])

    expect(nodes[0]?.key).toBe(CRON_NODE)
  })
})

describe('deriveJoinInputs', () => {
  it('fills a join\'s input from the edges that actually point at it', () => {
    const nodes = deriveJoinInputs([
      { key: CONDITION_NODE, type: 'condition', outputTrue: [JOIN_NODE] },
      { key: DELAY_NODE, type: 'delay', delaySeconds: 60, outputSuccess: [JOIN_NODE] },
      { key: JOIN_NODE, type: 'all' },
    ])

    expect(nodes[2]?.input).toEqual([`${CONDITION_NODE}::outputTrue`, `${DELAY_NODE}::outputSuccess`])
  })

  it('empties a join nothing feeds, rather than leaving a stale input that waits forever', () => {
    const nodes = deriveJoinInputs([{ key: JOIN_NODE, type: 'all', input: [`${DELAY_NODE}::outputSuccess`] }])

    expect(nodes[0]?.input).toEqual([])
  })

  it('leaves every other node kind alone', () => {
    const nodes = deriveJoinInputs([{ key: CRON_NODE, type: 'any', outputSuccess: [] }])

    expect(nodes[0]?.input).toBeUndefined()
  })
})

describe('applyAutoLayout', () => {
  it('places a node that has no coordinates and leaves a hand-placed one alone', () => {
    const nodes = applyAutoLayout([
      { key: CRON_NODE, type: 'trigger', cardId: 'homey:manager:cron:time_exactly', outputSuccess: [NOTIFY_NODE] },
      { key: NOTIFY_NODE, type: 'action', cardId: 'homey:manager:notifications:create_notification', x: 999, y: 111 },
    ])

    expect(nodes[0]?.x).toBe(0)
    expect(nodes[1]?.x).toBe(999)
    expect(nodes[1]?.y).toBe(111)
  })
})

describe('fromAdvancedWire', () => {
  const flow = fromAdvancedWire(fixture.advancedFlowWire, 'v2')

  it('joins the owner uri and the short id on the three card-bearing node kinds', () => {
    expect(nodeOf(flow, CRON_NODE).cardId).toBe('homey:manager:cron:time_exactly')
    expect(nodeOf(flow, NOTIFY_NODE).cardId).toBe('homey:manager:notifications:create_notification')
  })

  it('reads a delay out of its args, where a delay node keeps it', () => {
    expect(nodeOf(flow, DELAY_NODE).delaySeconds).toBe(60)
    expect(nodeOf(flow, DELAY_NODE).cardId).toBeUndefined()
  })

  it('reads a join\'s input entries and a condition\'s inverted flag', () => {
    expect(nodeOf(flow, JOIN_NODE).input).toEqual([`${CONDITION_NODE}::outputTrue`, `${DELAY_NODE}::outputSuccess`])
    expect(nodeOf(flow, CONDITION_NODE).inverted).toBe(true)
  })

  it('reads every output port', () => {
    expect(outgoingTargets(nodeOf(flow, CRON_NODE))).toEqual([CONDITION_NODE, DELAY_NODE])
    expect(outgoingTargets(nodeOf(flow, CONDITION_NODE))).toEqual([JOIN_NODE])
  })
})

describe('toAdvancedWire', () => {
  const flow = fromAdvancedWire(fixture.advancedFlowWire, 'v2')

  it('splits a card-bearing node into an owner uri and a short id for a V2 hub', () => {
    const wire = toAdvancedWire(flow, 'v2') as { cards: Record<string, Record<string, unknown>> }

    expect(wire.cards[CRON_NODE]).toMatchObject({ ownerUri: 'homey:manager:cron', id: 'time_exactly' })
  })

  it('keeps the canonical id for the library, which splits it again itself', () => {
    const payload = toAdvancedLibraryPayload(flow) as { cards: Record<string, Record<string, unknown>> }

    expect(payload.cards[CRON_NODE]?.['id']).toBe('homey:manager:cron:time_exactly')
    expect(payload.cards[CRON_NODE]?.['ownerUri']).toBe('homey:manager:cron')
  })

  it('writes a delay back inside args, as the firmware stores it', () => {
    const wire = toAdvancedWire(flow, 'v2') as { cards: Record<string, Record<string, unknown>> }

    expect(wire.cards[DELAY_NODE]?.['args']).toEqual({ delay: { number: '1', multiplier: 60 } })
    expect(wire.cards[DELAY_NODE]).not.toHaveProperty('ownerUri')
  })

  it('gives every node the coordinates the schema requires', () => {
    const wire = toAdvancedWire(flow, 'v2') as { cards: Record<string, Record<string, unknown>> }

    for (const node of Object.values(wire.cards)) {
      expect(typeof node['x']).toBe('number')
      expect(typeof node['y']).toBe('number')
    }
  })

  it('lets the app size a note itself rather than guessing a width', () => {
    const wire = toAdvancedWire(
      { name: 'Noted', nodes: [{ key: CRON_NODE, type: 'note', value: 'Why this exists', x: 0, y: 0 }] },
      'v2',
    ) as { cards: Record<string, Record<string, unknown>> }

    expect(wire.cards[CRON_NODE]).toMatchObject({ value: 'Why this exists', color: 'yellow', width: null, height: null })
  })

  it('round-trips the fixture graph unchanged', () => {
    const reparsed = fromAdvancedWire(toAdvancedWire(flow, 'v2'), 'v2')

    expect(diffAdvancedFlows(flow, reparsed)).toEqual([])
  })
})

describe('diffAdvancedFlows', () => {
  const flow = fromAdvancedWire(fixture.advancedFlowWire, 'v2')

  it('reports an edge the hub did not keep', () => {
    const stored = structuredClone(flow)
    nodeOf(stored, CRON_NODE).outputSuccess = [CONDITION_NODE]

    expect(diffAdvancedFlows(flow, stored).map((difference) => difference.path)).toContain(
      `cards.${CRON_NODE}.outputSuccess`,
    )
  })

  it('reports a node the hub dropped and one it added', () => {
    const stored: CanonicalAdvancedFlow = { ...flow, nodes: flow.nodes.filter((node) => node.key !== NOTIFY_NODE) }

    expect(diffAdvancedFlows(flow, stored)).toContainEqual({ path: `cards.${NOTIFY_NODE}`, sent: 'present', stored: null })
    expect(diffAdvancedFlows(stored, flow)).toContainEqual({ path: `cards.${NOTIFY_NODE}`, sent: null, stored: 'present' })
  })
})
