import { describe, expect, it } from 'vitest'

import { formatValue, renderKeyValueLines, renderTextBlock, successResult, toolResult } from './render.js'

describe('renderTextBlock', () => {
  it('drops empty sections, headings included', () => {
    const block = renderTextBlock([
      'Two devices are on.',
      { heading: 'Zones', lines: [] },
      { heading: 'Devices', lines: ['  Hallway lamp'] },
    ])

    expect(block).toBe('Two devices are on.\n\nDevices\n  Hallway lamp')
  })

  it('leaves no trailing whitespace', () => {
    expect(renderTextBlock(['One line.  ', null, undefined])).toBe('One line.')
  })
})

describe('formatValue', () => {
  it('shows a missing value rather than hiding it', () => {
    expect(formatValue(null)).toBe('unknown')
  })

  it('reads booleans as words', () => {
    expect(formatValue(true)).toBe('yes')
    expect(formatValue(false)).toBe('no')
  })

  it('trims the float noise a hub leaves behind without rounding real precision away', () => {
    expect(formatValue(21.400000000000002)).toBe('21.4')
    expect(formatValue(0.125)).toBe('0.125')
    expect(formatValue(12)).toBe('12')
  })
})

describe('renderKeyValueLines', () => {
  it('pads labels into a column', () => {
    expect(renderKeyValueLines([['model', 'Homey Pro'], ['firmware', '13.2.4']])).toEqual([
      '  model     Homey Pro',
      '  firmware  13.2.4',
    ])
  })
})

describe('toolResult', () => {
  it('always carries both halves of the answer', () => {
    const result = toolResult({ text: 'Two devices.', structuredContent: { deviceCount: 2 } })

    expect(result.content).toEqual([{ type: 'text', text: 'Two devices.' }])
    expect(result.structuredContent).toEqual({ deviceCount: 2 })
  })
})

describe('successResult', () => {
  it('leads the structured half with ok, so success and failure differ by one field', () => {
    const result = successResult('Two devices.', { deviceCount: 2 })

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ ok: true, deviceCount: 2 })
  })
})
