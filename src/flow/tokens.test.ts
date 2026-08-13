// The two token dialects look alike and are not interchangeable, and the hub
// stores either without complaint. Everything here pins the distinction the
// firmware will not enforce.

import { describe, expect, it } from 'vitest'

import {
  collectTokenReferences,
  describeDroptokenProblem,
  formatDroptoken,
  formatGlobalToken,
  formatLocalToken,
  formatNodeToken,
  isValidDroptoken,
  parseTokenReferences,
} from './tokens.js'

describe('parseTokenReferences', () => {
  it('recognises a global token by its pipe', () => {
    const [reference] = parseTokenReferences('It is [[homey:device:aaaa-bbbb|measure_luminance]] lux')

    expect(reference?.kind).toBe('global')
    expect(reference?.ownerUri).toBe('homey:device:aaaa-bbbb')
    expect(reference?.tokenId).toBe('measure_luminance')
  })

  it('recognises a bare token id as one this flow\'s own trigger emits', () => {
    const [reference] = parseTokenReferences('at [[time]]')

    expect(reference?.kind).toBe('local')
    expect(reference?.tokenId).toBe('time')
  })

  it('recognises an advanced flow node reference and the node it names', () => {
    const [reference] = parseTokenReferences('at [[trigger::dddddddd-0011-4000-8000-000000000011::time]]')

    expect(reference?.kind).toBe('node')
    expect(reference?.nodeKind).toBe('trigger')
    expect(reference?.nodeKey).toBe('dddddddd-0011-4000-8000-000000000011')
    expect(reference?.tokenId).toBe('time')
  })

  it('recognises the card::<node>::error form used on an error branch', () => {
    const [reference] = parseTokenReferences('failed: [[card::dddddddd-0011-4000-8000-000000000011::error]]')

    expect(reference?.nodeKind).toBe('card')
    expect(reference?.tokenId).toBe('error')
  })

  it('refuses to guess at a reference it does not recognise', () => {
    // The colon here is the classic mistake: it looks like a global token and
    // is not one, and guessing a pipe was meant would hide the problem.
    const [reference] = parseTokenReferences('[[homey:device:aaaa-bbbb:measure_luminance]]')

    expect(reference?.kind).toBe('unrecognised')
  })

  it('finds every reference in one string, in order', () => {
    const references = parseTokenReferences('[[a]] and [[homey:manager:cron|time]]')

    expect(references.map((reference) => reference.kind)).toEqual(['local', 'global'])
  })
})

describe('collectTokenReferences', () => {
  it('walks the string arguments only, and names which argument each came from', () => {
    const collected = collectTokenReferences({
      text: 'at [[homey:manager:cron|time]]',
      value: 10,
      device: { id: 'x', name: 'y' },
    })

    expect(collected).toHaveLength(1)
    expect(collected[0]?.argumentName).toBe('text')
  })

  it('has nothing to collect from a card with no arguments', () => {
    expect(collectTokenReferences(undefined)).toEqual([])
  })
})

describe('formatting', () => {
  it('writes each reference in its own dialect', () => {
    expect(formatGlobalToken('homey:device:aaaa', 'onoff')).toBe('[[homey:device:aaaa|onoff]]')
    expect(formatLocalToken('time')).toBe('[[time]]')
    expect(formatNodeToken('action', 'dddddddd-0011-4000-8000-000000000011', 'name')).toBe(
      '[[action::dddddddd-0011-4000-8000-000000000011::name]]',
    )
  })

  it('writes a droptoken without brackets, since it is a field rather than an interpolation', () => {
    expect(formatDroptoken('homey:device:aaaa', 'measure_luminance')).toBe('homey:device:aaaa|measure_luminance')
  })
})

describe('droptoken validation', () => {
  it('accepts the pipe form', () => {
    expect(isValidDroptoken('homey:device:aaaa-bbbb|measure_luminance')).toBe(true)
    expect(isValidDroptoken('homey:manager:logic|217ee151-7ac5-47a6-a96f-73af5e2d0b6f')).toBe(true)
  })

  it('rejects the colon form and says exactly why, because the hub accepts it silently', () => {
    const problem = describeDroptokenProblem('homey:device:aaaa-bbbb:measure_luminance')

    expect(problem).not.toBeNull()
    expect(problem).toContain('pipe')
    expect(problem).toContain('Unavailable')
  })

  it('has nothing to say about a valid droptoken', () => {
    expect(describeDroptokenProblem('homey:device:aaaa-bbbb|onoff')).toBeNull()
  })
})
