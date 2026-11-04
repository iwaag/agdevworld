// Positions for the canvas, and the auto-arrange used by the UI and the CLI
// (`wfe arrange`). Stored positions (layout.nodes) are in compact
// units; mini mode draws the same positions scaled down, so both modes show
// the same arrangement. Nodes without a stored position are placed by rank
// (longest path from a source), in file order within a rank, below anything
// already occupying that column.
import type { Point, Workflow } from './model.ts'

export type DisplayMode = 'compact' | 'mini'

export interface Metrics { width: number; height: number; scale: number }
export const METRICS: Record<DisplayMode, Metrics> = {
  compact: { width: 240, height: 128, scale: 1 },
  mini: { width: 156, height: 64, scale: 0.66 },
}
export const STEP_X = 300
export const STEP_Y = 168
export const PAD = 40

export function ranks(w: Workflow): Map<string, number> {
  const ids = Object.keys(w.nodes)
  const incoming = new Map<string, string[]>(ids.map(id => [id, []]))
  for (const e of w.edges) if (incoming.has(e.to) && incoming.has(e.from) && e.from !== e.to) incoming.get(e.to)!.push(e.from)
  const rank = new Map<string, number>()
  const visiting = new Set<string>()
  const visit = (id: string): number => {
    if (rank.has(id)) return rank.get(id)!
    if (visiting.has(id)) return 0 // cycle: validation reports it; layout just stops
    visiting.add(id)
    const r = Math.max(-1, ...incoming.get(id)!.map(visit)) + 1
    visiting.delete(id)
    rank.set(id, r)
    return r
  }
  ids.forEach(visit)
  return rank
}

// What a node's knowledge strip adds to its card, so that a placed column does not
// overlap (improve_workflow p3). An estimate: rows, and findings that wrap.
function knowledgeHeight(w: Workflow, id: string): number {
  const list = w.nodes[id]?.knowledge
  if (!list?.length) return 0
  return 12 + list.reduce((n, a) => n + 22 * Math.max(1, Math.min(a.findings?.length ?? 0, 3)), 0)
}

export function positions(w: Workflow): Map<string, Point> {
  const out = new Map<string, Point>()
  for (const [id, p] of Object.entries(w.layout.nodes)) if (id in w.nodes) out.set(id, { ...p })
  const missing = Object.keys(w.nodes).filter(id => !out.has(id))
  if (!missing.length) return out
  const rank = ranks(w)
  const nextY = new Map<number, number>()
  const tall = new Map(Object.keys(w.nodes).map(id => [id, knowledgeHeight(w, id)]))
  const overlaps = (p: Point, own: number) => [...out.entries()].some(([id, q]) => Math.abs(q.x - p.x) < STEP_X * 0.8 && (q.y <= p.y ? p.y - q.y < STEP_Y * 0.8 + (tall.get(id) ?? 0) : q.y - p.y < STEP_Y * 0.8 + own))
  for (const id of missing) {
    const r = rank.get(id) ?? 0
    let p = { x: PAD + r * STEP_X, y: nextY.get(r) ?? PAD }
    while (overlaps(p, tall.get(id) ?? 0)) p = { x: p.x, y: p.y + STEP_Y }
    nextY.set(r, p.y + STEP_Y + (tall.get(id) ?? 0))
    out.set(id, p)
  }
  return out
}

// Fills in every missing position.
export function completeLayout(w: Workflow) {
  for (const [id, p] of positions(w)) w.layout.nodes[id] = { x: Math.round(p.x), y: Math.round(p.y) }
}

// "Auto-arrange": discards stored positions and lays the graph out by rank.
// Only layout changes, so approvals are unaffected.
export function autoArrange(w: Workflow) {
  w.layout.nodes = {}
  completeLayout(w)
}

// A free slot for a new node: right of the selected node if there is one,
// otherwise near `near`, stepping down (then up) a row at a time.
export function freeSlot(w: Workflow, near: Point, after?: string): Point {
  const taken = [...positions(w).values()]
  const anchor = after ? positions(w).get(after) : undefined
  const origin = anchor ? { x: anchor.x + STEP_X, y: anchor.y } : { x: Math.round(near.x / 20) * 20, y: Math.round(near.y / 20) * 20 }
  const free = (p: Point) => !taken.some(q => Math.abs(q.x - p.x) < STEP_X * 0.8 && Math.abs(q.y - p.y) < STEP_Y * 0.8)
  for (let k = 0; k < 60; k++) {
    const dy = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * STEP_Y
    const p = { x: origin.x, y: origin.y + dy }
    if (p.y >= 0 && free(p)) return p
  }
  return { x: origin.x, y: origin.y + taken.length * STEP_Y }
}
