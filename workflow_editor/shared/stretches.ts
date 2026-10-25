// The stretches of a standing conductor's graph (workflow_editor p18,
// docs/runs.md *Standing runs*): its opening (the nodes it was created
// with) and one stretch per wake. A node belongs to the stretch in force
// when the revision that added it was recorded, so a turn's `ponder --next`
// chain stays with the wake it answered. Read from the record alone — no
// snapshot, no other run — for views that show the current stretch in full
// and fold completed ones.
import type { RunRecord, StandingWake } from './run.ts'

export interface Stretch {
  n: number // 0: the opening
  wake: StandingWake | null
  nodes: string[] // authored nodes (generated steps left out), in the order they were added
  at: string // when it began
  open: boolean // some node of it is not completed (running, waiting, ready, pending, failed)
}

export function stretchesOf(r: Pick<RunRecord, 'nodes' | 'definition' | 'history' | 'created' | 'standing'>): Stretch[] {
  const wakes = r.standing?.wakes ?? []
  const authored = (id: string) => !id.startsWith('_') && id in r.nodes
  const order: string[] = []
  const stretchOf = new Map<string, number>()
  const add = (id: string, n: number) => { if (!stretchOf.has(id) && authored(id)) { stretchOf.set(id, n); order.push(id) } }
  for (const id of Object.keys(r.definition.effective?.nodes ?? {}).sort()) add(id, 0)
  const seqOf = new Map<string, number>()
  for (const h of r.history) if ((h.op === 'run.adjust' || h.op === 'run.record-done') && typeof (h as { revision?: unknown }).revision === 'string') seqOf.set((h as { revision: string }).revision, h.seq)
  for (const rev of r.definition.revisions ?? []) {
    const seq = seqOf.get(rev.revision) ?? Number.MAX_SAFE_INTEGER
    const n = wakes.filter(w => w.seq <= seq).length
    for (const id of rev.diff.added) add(id, n)
  }
  // Nodes of a record whose definition carries no frozen graph (before p5).
  for (const id of Object.keys(r.nodes).sort()) add(id, 0)
  const out: Stretch[] = [{ n: 0, wake: null, nodes: [], at: r.created, open: false }, ...wakes.map(w => ({ n: w.n, wake: w, nodes: [] as string[], at: w.at, open: false }))]
  for (const id of order) out[Math.min(stretchOf.get(id)!, out.length - 1)].nodes.push(id)
  for (const s of out) s.open = s.nodes.some(id => r.nodes[id]?.state !== 'completed' && r.nodes[id]?.state !== 'cancelled')
  return out
}
