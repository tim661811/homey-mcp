// The wire format is where a flow silently goes wrong, so these tests pin the
// exact shape rather than the round trip alone: a card that splits into
// `{uri, id}` the wrong way, a delay sent as a bare number, or a read-only
// field echoed back all save without an error and then misbehave.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { CanonicalFlow } from './model.js'
import {
  ACTION_GROUPS,
  CONDITION_GROUPS,
  READ_ONLY_FLOW_FIELDS,
  diffFlows,
  flowDeepLink,
  fromWire,
  fromWireInterval,
  storedFlowFromWire,
  stripReadOnlyFlowFields,
  toLibraryPayload,
  toWire,
  toWireInterval,
} from './model.js'

interface FlowFixture {
  standardFlowWire: Record<string, unknown>
}

const fixture = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/flow-authoring-sample.json', import.meta.url), 'utf8'),
) as FlowFixture

const DOOR_TRIGGER = 'homey:device:aaaaaaaa-0004-4000-8000-000000000004:alarm_contact_true'
const LAMP_ACTION = 'homey:device:aaaaaaaa-0001-4000-8000-000000000001:onoff'

describe('fromWire', () => {
  it('joins the V2 owner uri and short id into one canonical card id', () => {
    const flow = fromWire(fixture.standardFlowWire, 'v2')

    expect(flow.trigger.id).toBe(DOOR_TRIGGER)
    expect(flow.conditions[0]?.id).toBe('homey:manager:presence:noone_athome')
    expect(flow.actions[0]?.id).toBe('homey:manager:notifications:create_notification')
  })

  it('leaves an already joined card alone, because homey-api may have joined it first', () => {
    const flow = fromWire(
      {
        name: 'Joined by the library',
        trigger: { id: DOOR_TRIGGER, args: {} },
        conditions: [],
        actions: [{ id: LAMP_ACTION, args: {}, group: 'then' }],
      },
      'v2',
    )

    expect(flow.trigger.id).toBe(DOOR_TRIGGER)
    expect(flow.actions[0]?.id).toBe(LAMP_ACTION)
  })

  it('keeps an app card id that contains further colons intact', () => {
    const flow = fromWire(
      {
        name: 'Colons',
        trigger: { uri: 'homey:app:com.example.cast', id: 'some:card:with:colons', args: {} },
        conditions: [],
        actions: [],
      },
      'v2',
    )

    expect(flow.trigger.id).toBe('homey:app:com.example.cast:some:card:with:colons')
  })

  it('reads a condition group and its inverted flag', () => {
    const flow = fromWire(fixture.standardFlowWire, 'v2')

    expect(flow.conditions[0]?.group).toBe('group1')
    expect(flow.conditions[0]?.inverted).toBe(true)
  })

  it('decodes a delay and a duration into whole seconds', () => {
    const flow = fromWire(fixture.standardFlowWire, 'v2')

    // The fixture carries {number: "2", multiplier: 60} and {number: "45", multiplier: 1}.
    expect(flow.actions[1]?.delay).toBe(120)
    expect(flow.actions[1]?.duration).toBe(45)
    expect(flow.actions[0]?.delay).toBeNull()
  })

  it('answers an empty trigger rather than inventing one, so the validator can name the real problem', () => {
    const flow = fromWire({ name: 'No trigger', conditions: [], actions: [] }, 'v2')

    expect(flow.trigger.id).toBe('')
  })
})

describe('storedFlowFromWire', () => {
  it('keeps the read-only fields separate from the editable flow', () => {
    const stored = storedFlowFromWire(fixture.standardFlowWire, 'v2')

    expect(stored.id).toBe('bbbbbbbb-0009-4000-8000-000000000009')
    expect(stored.triggerCount).toBe(7777)
    expect(stored.triggerable).toBe(true)
    expect(stored.order).toBe(12)
  })

  it('reports an absent broken flag as null, because homey-api deletes it on a V2 hub', () => {
    const withoutBroken = { ...fixture.standardFlowWire }
    delete withoutBroken['broken']

    expect(storedFlowFromWire(withoutBroken, 'v2').broken).toBeNull()
    expect(storedFlowFromWire(fixture.standardFlowWire, 'v2').broken).toBe(false)
  })
})

describe('toWire', () => {
  const flow: CanonicalFlow = {
    name: 'Attic warning',
    enabled: false,
    folder: 'cccccccc-0001-4000-8000-000000000001',
    trigger: { id: DOOR_TRIGGER, args: {} },
    conditions: [{ id: 'homey:manager:presence:noone_athome', args: {}, group: 'group1', inverted: true }],
    actions: [{ id: LAMP_ACTION, args: { onoff: 'true' }, group: 'then', delay: 120, duration: 45 }],
  }

  it('splits every card into an owner uri and a short id for a V2 hub', () => {
    const wire = toWire(flow, 'v2') as Record<string, Record<string, unknown>>

    expect(wire['trigger']).toMatchObject({
      uri: 'homey:device:aaaaaaaa-0004-4000-8000-000000000004',
      id: 'alarm_contact_true',
    })
    expect((wire['actions'] as unknown as Array<Record<string, unknown>>)[0]).toMatchObject({
      uri: 'homey:device:aaaaaaaa-0001-4000-8000-000000000001',
      id: 'onoff',
    })
  })

  it('keeps one fully qualified card id for a V3 hub', () => {
    const wire = toWire(flow, 'v3') as Record<string, Record<string, unknown>>

    expect(wire['trigger']).toMatchObject({ id: DOOR_TRIGGER })
    expect(wire['trigger']).not.toHaveProperty('uri')
  })

  it('always sends an args object, never null and never omitted', () => {
    const wire = toWire(
      { name: 'No args', trigger: { id: DOOR_TRIGGER }, conditions: [], actions: [] },
      'v2',
    ) as Record<string, Record<string, unknown>>

    expect(wire['trigger']?.['args']).toEqual({})
  })

  it('always writes the group the editor writes, because omitting it breaks the web renderer', () => {
    const wire = toWire(
      {
        name: 'Defaults',
        trigger: { id: DOOR_TRIGGER },
        conditions: [{ id: 'homey:manager:presence:noone_athome' }],
        actions: [{ id: LAMP_ACTION }],
      },
      'v2',
    ) as unknown as { conditions: Array<Record<string, unknown>>; actions: Array<Record<string, unknown>> }

    expect(wire.conditions[0]?.['group']).toBe(CONDITION_GROUPS[0])
    expect(wire.conditions[0]?.['inverted']).toBe(false)
    expect(wire.actions[0]?.['group']).toBe(ACTION_GROUPS[0])
  })

  it('encodes a delay and a duration as the firmware pair, never as a bare number', () => {
    const wire = toWire(flow, 'v2') as unknown as { actions: Array<Record<string, unknown>> }

    expect(wire.actions[0]?.['delay']).toEqual({ number: '2', multiplier: 60 })
    expect(wire.actions[0]?.['duration']).toEqual({ number: '45', multiplier: 1 })
  })

  it('never emits a firmware-computed field', () => {
    const serialised = JSON.stringify(toWire(flow, 'v2'))

    for (const field of READ_ONLY_FLOW_FIELDS) {
      expect(serialised).not.toContain(`"${field}"`)
    }
  })
})

describe('toLibraryPayload', () => {
  it('is the canonical form, because homey-api splits it again for a V2 hub', () => {
    // Handing the library an already split card would make it split the short
    // id a second time and post {uri: "alarm_contact_true", id: ""}, which the
    // hub stores as a broken card without complaining.
    const payload = toLibraryPayload({
      name: 'Library',
      trigger: { id: DOOR_TRIGGER },
      conditions: [],
      actions: [],
    }) as unknown as { trigger: Record<string, unknown> }

    expect(payload.trigger['id']).toBe(DOOR_TRIGGER)
    expect(payload.trigger).not.toHaveProperty('uri')
  })
})

describe('interval encoding', () => {
  it('uses minutes for a whole number of them, matching what the editor writes', () => {
    expect(toWireInterval(120)).toEqual({ number: '2', multiplier: 60 })
    expect(toWireInterval(3600)).toEqual({ number: '60', multiplier: 60 })
  })

  it('uses seconds for anything else', () => {
    expect(toWireInterval(45)).toEqual({ number: '45', multiplier: 1 })
    expect(toWireInterval(90)).toEqual({ number: '90', multiplier: 1 })
  })

  it('has no interval for zero, null or a negative wait', () => {
    expect(toWireInterval(0)).toBeNull()
    expect(toWireInterval(null)).toBeNull()
    expect(toWireInterval(undefined)).toBeNull()
    expect(toWireInterval(-5)).toBeNull()
  })

  it('decodes the pair the firmware sends, where number is a string', () => {
    expect(fromWireInterval({ number: '2', multiplier: 60 })).toBe(120)
    expect(fromWireInterval({ number: '45', multiplier: 1 })).toBe(45)
    expect(fromWireInterval(null)).toBeNull()
    expect(fromWireInterval({ number: 'not a number', multiplier: 1 })).toBeNull()
  })
})

describe('stripReadOnlyFlowFields', () => {
  it('removes exactly the firmware-computed fields', () => {
    const stripped = stripReadOnlyFlowFields({ name: 'Kept', broken: false, triggerable: true, triggerCount: 7 })

    expect(stripped).toEqual({ name: 'Kept' })
  })
})

describe('diffFlows', () => {
  const sent: CanonicalFlow = {
    name: 'Sent',
    trigger: { id: DOOR_TRIGGER, args: {} },
    conditions: [],
    actions: [{ id: LAMP_ACTION, args: { onoff: 'true' }, group: 'then' }],
  }

  it('finds nothing when the hub stored what was sent', () => {
    expect(diffFlows(sent, structuredClone(sent))).toEqual([])
  })

  it('reports an argument the hub quietly changed', () => {
    const stored = structuredClone(sent)
    stored.actions[0]!.args = { onoff: 'false' }

    expect(diffFlows(sent, stored)).toEqual([{ path: 'actions[0].args.onoff', sent: 'true', stored: 'false' }])
  })

  it('reports an action the hub dropped', () => {
    const stored: CanonicalFlow = { ...structuredClone(sent), actions: [] }

    expect(diffFlows(sent, stored).map((difference) => difference.path)).toContain('actions.length')
  })

  it('reports a folder the hub reset to the root', () => {
    const withFolder: CanonicalFlow = { ...structuredClone(sent), folder: 'cccccccc-0001-4000-8000-000000000001' }
    const stored: CanonicalFlow = { ...structuredClone(sent), folder: null }

    expect(diffFlows(withFolder, stored)).toContainEqual({
      path: 'folder',
      sent: 'cccccccc-0001-4000-8000-000000000001',
      stored: null,
    })
  })
})

describe('flowDeepLink', () => {
  it('points a standard and an advanced flow at their own editors', () => {
    expect(flowDeepLink('abc', 'standard')).toBe('https://my.homey.app/flows/abc/')
    expect(flowDeepLink('abc', 'advanced')).toBe('https://my.homey.app/flows/advanced/abc/')
  })
})
