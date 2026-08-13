import { describe, expect, it } from 'vitest'

import { asNumber, asRecord, asString, asStringArray } from './coerce.js'

describe('asString', () => {
  it('treats an empty string as absent, because that is how the hub reports an unset field', () => {
    expect(asString('')).toBeNull()
    expect(asString('Woonkamer')).toBe('Woonkamer')
    expect(asString(null)).toBeNull()
    expect(asString(42)).toBeNull()
  })
})

describe('asNumber', () => {
  it('rejects NaN and Infinity, neither of which is a measurement', () => {
    expect(asNumber(Number.NaN)).toBeNull()
    expect(asNumber(Number.POSITIVE_INFINITY)).toBeNull()
    expect(asNumber(0)).toBe(0)
    expect(asNumber('21.4')).toBeNull()
  })
})

describe('asStringArray', () => {
  it('drops non-string entries rather than stringifying them', () => {
    expect(asStringArray(['onoff', 7, null, 'dim'])).toEqual(['onoff', 'dim'])
    expect(asStringArray('onoff')).toEqual([])
  })
})

describe('asRecord', () => {
  it('does not accept an array as a record', () => {
    expect(asRecord([])).toBeNull()
    expect(asRecord(null)).toBeNull()
    expect(asRecord({ id: 'a' })).toEqual({ id: 'a' })
  })
})
