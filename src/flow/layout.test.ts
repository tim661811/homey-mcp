// Coordinates are required on every advanced-flow node, and a graph that opens
// as a pile of overlapping cards is a graph nobody will read. These pin the
// grid and the layering rule.

import { describe, expect, it } from 'vitest'

import type { LayoutNode } from './layout.js'
import { COLUMN_WIDTH, GRID, ROW_HEIGHT, layoutAdvancedFlow, snapToGrid } from './layout.js'

function node(key: string, targets: string[], isEntryPoint = false): LayoutNode {
  return { key, targets, isEntryPoint }
}

describe('snapToGrid', () => {
  it('rounds to the grid every captured flow uses', () => {
    expect(snapToGrid(0)).toBe(0)
    expect(snapToGrid(31)).toBe(40)
    expect(snapToGrid(29)).toBe(20)
    expect(GRID).toBe(20)
  })
})

describe('layoutAdvancedFlow', () => {
  it('puts a chain in one column per stage', () => {
    const positions = layoutAdvancedFlow([
      node('trigger', ['condition'], true),
      node('condition', ['action']),
      node('action', []),
    ])

    expect(positions.get('trigger')?.x).toBe(0)
    expect(positions.get('condition')?.x).toBe(COLUMN_WIDTH)
    expect(positions.get('action')?.x).toBe(COLUMN_WIDTH * 2)
  })

  it('stacks siblings in the same column without overlapping them', () => {
    const positions = layoutAdvancedFlow([
      node('trigger', ['first', 'second'], true),
      node('first', []),
      node('second', []),
    ])

    expect(positions.get('first')?.x).toBe(positions.get('second')?.x)
    expect(Math.abs((positions.get('first')?.y ?? 0) - (positions.get('second')?.y ?? 0))).toBe(ROW_HEIGHT)
  })

  it('places a node by its LONGEST path, so a join sits after the chain that feeds it', () => {
    // `join` is reachable in one hop from the trigger and in three through the
    // conditions. Placing it at depth 1 would draw it on top of them.
    const positions = layoutAdvancedFlow([
      node('trigger', ['first', 'join'], true),
      node('first', ['second']),
      node('second', ['join']),
      node('join', []),
    ])

    expect(positions.get('join')?.x).toBe(COLUMN_WIDTH * 3)
  })

  it('terminates on a cycle, which a flow that loops back through a delay really has', () => {
    const positions = layoutAdvancedFlow([
      node('trigger', ['delay'], true),
      node('delay', ['action']),
      node('action', ['delay']),
    ])

    expect(positions.size).toBe(3)
  })

  it('still places a node nothing can reach, so an orphan is visible rather than dropped', () => {
    const positions = layoutAdvancedFlow([node('trigger', [], true), node('orphan', [])])

    expect(positions.has('orphan')).toBe(true)
  })

  it('snaps every coordinate to the grid', () => {
    const positions = layoutAdvancedFlow([node('trigger', ['action'], true), node('action', [])])

    for (const position of positions.values()) {
      expect(position.x % GRID).toBe(0)
      expect(position.y % GRID).toBe(0)
    }
  })
})
