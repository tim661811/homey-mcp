// Placing advanced-flow nodes on the canvas.
//
// `x` and `y` are required on every node by the firmware's schema, and a graph
// that arrives with everything at 0,0 opens in the Homey app as an unreadable
// pile of overlapping cards. Every real flow captured from the hub snaps to a
// 20 px grid, steps 400 px per column and 80 to 120 px between stacked
// siblings, so those are the constants used here: a generated flow should look
// like one somebody drew.

/** Horizontal distance between two logical stages. Every captured flow uses this step. */
export const COLUMN_WIDTH = 400

/** Vertical distance between two siblings in the same stage. */
export const ROW_HEIGHT = 100

/** Every coordinate in every captured flow is a multiple of this. */
export const GRID = 20

/** A note sits directly above the card it annotates, at the same x. */
export const NOTE_VERTICAL_OFFSET = -80

export function snapToGrid(value: number): number {
  return Math.round(value / GRID) * GRID
}

export interface LayoutNode {
  key: string
  /** Keys this node hands control to, on any output port. */
  targets: string[]
  /** True for the node kinds that begin a branch: `trigger` and `start`. */
  isEntryPoint: boolean
}

export interface NodePosition {
  x: number
  y: number
}

/**
 * Lays a graph out left to right by longest path from an entry point.
 *
 * Longest path rather than shortest, so a node that is reachable both directly
 * and through a chain of conditions is drawn to the right of that chain instead
 * of on top of it. Cycles are possible in an advanced flow (a flow can loop
 * back through a delay), so the walk carries its own visited set per path and
 * stops rather than spinning.
 */
export function layoutAdvancedFlow(nodes: LayoutNode[]): Map<string, NodePosition> {
  const byKey = new Map(nodes.map((node) => [node.key, node]))
  const depthByKey = new Map<string, number>()

  const entryPoints = nodes.filter((node) => node.isEntryPoint)
  // A graph with no trigger and no start is still worth drawing: it is what a
  // half-built flow looks like, and the caller gets a clearer error from the
  // validator than from a layout that silently produced nothing.
  const roots = entryPoints.length > 0 ? entryPoints : nodes.filter((node) => !isReachable(node.key, nodes))

  for (const root of roots.length > 0 ? roots : nodes.slice(0, 1)) {
    assignDepth(root.key, 0, byKey, depthByKey, new Set())
  }

  // Anything still unplaced is unreachable from any root. It is placed in the
  // first column rather than dropped, so the author can see it is orphaned.
  for (const node of nodes) {
    if (!depthByKey.has(node.key)) depthByKey.set(node.key, 0)
  }

  const positions = new Map<string, NodePosition>()
  const usedRowsByDepth = new Map<number, number>()

  // Stable order: the input order decides which sibling sits on top, so two
  // runs over the same graph produce the same picture.
  for (const node of nodes) {
    const depth = depthByKey.get(node.key) ?? 0
    const row = usedRowsByDepth.get(depth) ?? 0
    usedRowsByDepth.set(depth, row + 1)
    positions.set(node.key, { x: snapToGrid(depth * COLUMN_WIDTH), y: snapToGrid(row * ROW_HEIGHT) })
  }

  return positions
}

function assignDepth(
  key: string,
  depth: number,
  byKey: Map<string, LayoutNode>,
  depthByKey: Map<string, number>,
  pathSoFar: Set<string>,
): void {
  if (pathSoFar.has(key)) return

  const existing = depthByKey.get(key)
  if (existing !== undefined && existing >= depth) return
  depthByKey.set(key, depth)

  const node = byKey.get(key)
  if (node === undefined) return

  const nextPath = new Set(pathSoFar)
  nextPath.add(key)
  for (const target of node.targets) {
    assignDepth(target, depth + 1, byKey, depthByKey, nextPath)
  }
}

function isReachable(key: string, nodes: LayoutNode[]): boolean {
  return nodes.some((node) => node.key !== key && node.targets.includes(key))
}
