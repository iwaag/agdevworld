// Standing runs (workflow_editor p18, docs/runs.md *Standing runs*): the
// file layer of a conversation's conductor that rests between turns. The
// reducer (shared/run.ts) keeps the rules; this module derives the wake —
// the one ponder node WFE appends when the conversation's words reach a
// conductor with nothing ready or running — from the run's definition in
// force, under the run's lock (adjustRun `derive`), so two wakers append
// one node and a restart finds the same one by its receipt.
import { standingEvents, type AdjustSource, type RunRecord } from '../shared/run.ts'
import type { Workflow } from '../shared/model.ts'
import { adjustRun } from './runs.ts'
import { parseWorkflow, renderWorkflow } from './yamlDoc.ts'
import type { Workspace } from './workspace.ts'
import type { RunRef } from '../shared/run.ts'

const firstLine = (t: string, n = 120) => { const l = t.split('\n').find(x => x.trim())?.trim() ?? ''; return l.length > n ? `${l.slice(0, n - 1)}…` : l }

// Why the run cannot be woken now, or null.
// `resume`: the person's resume also continues a conductor that stands
// suspended (facilitation ended) for the words it was given.
export function wakeRefusal(r: RunRecord, o: { resume?: boolean } = {}): string | null {
  const st = r.standing
  if (!st) return 'the run is not a standing conductor'
  if (r.cancelled) return 'the run is cancelled'
  if (st.state === 'closed' || (st.state === 'suspended' && !o.resume)) return `it stands ${st.state} in ${st.conversation}`
  if (r.control.attempt) return `attempt ${r.control.attempt.id} is open; it reads the words at its next boundary`
  if (r.control.hold) return `the run is held (${r.control.hold.kind}); its resume continues it`
  if (r.execution.ready.length || r.execution.active.length) return `${[...r.execution.active, ...r.execution.ready].join(', ')} takes them up`
  if (!standingEvents(r).length) return 'nothing arrived that no attempt was briefed with'
  return null
}

// The wake's revision: the definition in force with one new ponder node
// after the conductor's latest completed ponder (its deliberation is one
// line; the work it started — asks, reviews, delegations — branches off and
// is not waited for), naming the words it is for.
export function wakeRevision(r: RunRecord, active: { text: string; workflow: Workflow }, o: { resume?: boolean } = {}): { text: string; reason: string; source: AdjustSource } | { skip: string } {
  const refusal = wakeRefusal(r, o)
  if (refusal) return { skip: refusal }
  const events = standingEvents(r)
  const parsed = parseWorkflow(active.text)
  if (!parsed.ok) return { skip: `the run's definition cannot be read: ${parsed.problem.message}` }
  const w = parsed.model
  const n = r.standing!.wakes.length + 1
  let id = `ponder-w${n}`
  for (let k = 2; id in w.nodes; k++) id = `ponder-w${n}-${k}`
  const ponders = Object.entries(r.nodes).filter(([nid, s]) => s.state === 'completed' && w.nodes[nid]?.activity === 'ponder').sort((a, b) => (a[1].ended ?? '').localeCompare(b[1].ended ?? '') || a[0].localeCompare(b[0]))
  const after = ponders.at(-1)?.[0]
  const words = events.map(e => r.instructions![e]).map(i => {
    const msg = i.source?.kind === 'conversation' ? `#${i.source.message}` : null
    return { id: i.id, msg, line: `${i.id}${msg ? ` (${msg})` : ''} from ${i.from}: ${firstLine(i.text)}` }
  })
  const msgs = words.map(x => x.msg).filter(Boolean)
  w.nodes[id] = {
    type: 'do', activity: 'ponder', name: msgs.length ? `Ponder ${msgs.join(' ')}` : 'Ponder',
    description: `The conversation continued while nothing of this run was ready: ${words.map(x => x.line).join('; ')}. Read what was said and what is owed (wfe conversation state), then act on it — reply, ask, review, or add the next activities (wfe conversation ponder --next). Unrelated earlier work keeps its own nodes.`,
    repositories: [],
  }
  if (after) w.edges.push({ from: after, to: id })
  return { text: renderWorkflow(parsed.doc, w), reason: `woken for ${words.map(x => x.id).join(', ')}${msgs.length ? ` (${msgs.join(', ')})` : ''}`, source: { kind: 'wake', events } }
}

// Appends the wake node now when the run qualifies (decided under its lock).
// The result names the wake recorded, or why there was none.
export async function wake(ws: Workspace, ref: RunRef, o: { resume?: boolean } = {}): Promise<{ record: RunRecord | null; wake: NonNullable<RunRecord['standing']>['wakes'][number] | null; skipped?: string }> {
  const res = await adjustRun(ws, ref, { text: '', reason: '', source: { kind: 'agent' }, derive: (r, active) => wakeRevision(r, active, o) }, { by: 'conversation', via: 'conversation' })
  if (!res.ok || !res.record) return { record: res.record ?? null, wake: null, skipped: res.skipped ?? res.problems.map(p => p.message).join('; ') }
  return { record: res.record, wake: res.record.standing?.wakes.at(-1) ?? null }
}
