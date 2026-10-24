// What a retained conversation is told when a new attempt continues it, and
// the compact read of a run's current state (agent_session p1 ex2,
// docs/sessions.md "Continuation").
//
// A resumed session already holds the contract, the guides, the frozen
// catalog and documentation policy, and whatever it read and did in earlier
// attempts. What it cannot hold is what was recorded while its process was
// absent. So a continuation carries:
//   - the pending input, selected by state (answers not taken up,
//     instructions not acknowledged, delegation facts not taken up), in full:
//     an input stays in every continuation until it is taken up, so a failed
//     launch or an interrupted delivery never loses it;
//   - the record entries since the session's previous attempt began that
//     this conversation did not write itself (the delta), one line each;
//   - the compact current state, at the seq the snapshot was taken.
// Later input is found at node boundaries (`wfe run state`) and by the
// write-time refusals, as before.
import { sourceLabel } from '../shared/intake.ts'
import { effectiveOf, holderOf, questionState, replay, runKey, type HistoryEntry, type Question, type RunRecord } from '../shared/run.ts'
import { attachedLines, delegationBrief, instructionBrief } from './exec.ts'
import { answerReminder } from '../shared/reminders.ts'
import { runDir } from './runs.ts'

// How many delta entries a continuation lists before pointing at the refresh.
export const DELTA_LINES = 30
// Executor bookkeeping: the previous attempt's end is stated on its own
// line, and the new attempt's begin is this one.
const BOOKKEEPING = new Set(['attempt.begin', 'attempt.session', 'attempt.context', 'attempt.end'])

const one = (t: string, n: number) => { const l = String(t ?? '').split('\n')[0]; return l.length > n || String(t ?? '').includes('\n') ? `${l.slice(0, n)}…` : l }
const indent = (t: string, pad = '    ') => t.split('\n').map(l => `${pad}${l}`)

// Answers recorded and not taken up, each in full with what it answers.
export function pendingAnswers(r: RunRecord): { q: Question; index: number }[] {
  const out: { q: Question; index: number }[] = []
  for (const q of Object.values(r.questions)) {
    if (q.withdrawn || questionState(q) !== 'answered') continue
    const from = q.takenUp ? q.takenUp.answer + 1 : 0
    for (let k = from; k < q.answers.length; k++) out.push({ q, index: k })
  }
  return out
}
export function pendingAnswerLines(r: RunRecord): string[] {
  const all = pendingAnswers(r)
  if (!all.length) return []
  return ['', `Answers recorded and not yet taken up (${all.length}), exact text; wfe run take-up <run> <question> records that you read one:`,
    ...all.flatMap(({ q, index }) => {
      const a = q.answers[index]
      const about = answerReminder(r, q.id) // an answer about a presentation (fix5): once, with that answer
      return [`- ${q.id} answer ${index} from ${a.from}${a.by !== a.from ? ` (recorded by ${a.by})` : ''} via ${a.via} at ${a.at}${a.source ? ` (${sourceLabel(a.source)})` : ''}; your question${q.node ? ` from ${q.node}` : ''}: "${one(q.text, 160)}"`, ...indent(a.text), ...attachedLines(a.source), ...(about && index === q.answers.length - 1 ? [`  Reminder: ${about}`] : [])]
    })]
}

// The run as it stands, in a few lines: hold, nodes by state, open
// presentations, the definition in force, decisions.
export function stateLines(r: RunRecord): string[] {
  const ex = r.execution
  const out = [`State at seq ${r.seq}: ${ex.state}${r.cancelled ? ` — cancelled by ${r.cancelled.by}: ${r.cancelled.reason}` : ''}.`]
  if (r.control.hold) out.push(`Held (${r.control.hold.kind}) since ${r.control.hold.since} by ${r.control.hold.by}: ${r.control.hold.reason}`)
  else if (r.control.stop) out.push(`A stop was requested by ${r.control.stop.by}: ${r.control.stop.reason}`)
  const done = Object.values(r.nodes).filter(n => n.state === 'completed').length
  out.push(`Nodes: ${done} completed; ready: ${ex.ready.join(', ') || '(none)'}; running: ${ex.active.join(', ') || '(none)'}${ex.failed.length ? `; failed: ${ex.failed.join(', ')}` : ''}${ex.blocked.length ? `; blocked: ${ex.blocked.join(', ')}` : ''}.`)
  for (const w of ex.waiting) {
    const n = r.nodes[w.node]
    out.push(`Waiting: ${w.node} — ${'question' in w.on ? `question ${w.on.question}` : 'external' in w.on ? `external ${w.on.external}` : `delegation ${w.on.delegation}`}; next move: ${holderOf(r, w.node)}${n?.wait?.reason && !('question' in w.on) ? ` (${one(n.wait.reason, 120)})` : ''}.`)
  }
  const pres = Object.values(r.presentations ?? {}).filter(p => p.state !== 'stopped')
  if (pres.length) out.push(`Presentations not stopped: ${pres.map(p => `${p.id} (${p.state}, from ${p.node}${Object.values(r.questions).filter(q => q.presentation?.id === p.id).map(q => `, asked in ${q.id}`).join('')})`).join('; ')}.`)
  if (r.definition.revisions?.length) out.push(`Definition: revision ${r.definition.active} in force (wfe run revisions <run>).`)
  for (const d of r.decisions) out.push(`Decision: ${d.decision} by ${d.by} at ${d.at}${d.confirmation ? ` (answer ${d.confirmation.answer} to ${d.confirmation.question})` : ''}.`)
  return out
}

// One line per record entry after `since` that `exclude` (the attempts of
// this conversation) did not write, without the executor's bookkeeping.
export function changeLines(r: RunRecord, since: number, exclude: string[] = [], cap = DELTA_LINES): { lines: string[]; count: number } {
  const own = new Set(exclude)
  const picked = r.history.filter(e => e.seq > since && !BOOKKEEPING.has(e.op) && !(e.attempt && own.has(e.attempt)))
  const lines = picked.slice(0, cap).map(entryLine)
  if (picked.length > cap) lines.push(`  … ${picked.length - cap} more: wfe run state ${runKey(r)} --since ${picked[cap - 1].seq}`)
  return { lines, count: picked.length }
}
function entryLine(e: HistoryEntry): string {
  const d = e as unknown as Record<string, unknown>
  const subject = [d.node && `node ${d.node}`, d.question && `question ${d.question}`, d.presentation && `presentation ${d.presentation}`, d.revision && `revision ${d.revision}`, d.delegation && `delegation ${d.delegation}`,
    e.op === 'instruction.receive' && `instruction ${e.change.instruction?.[1] ?? ''}`, Array.isArray(d.instructions) && `instructions ${(d.instructions as string[]).join(', ')}`].filter(Boolean).join(', ')
  const moves = Object.entries(e.change.nodes ?? {}).map(([n, [a, b]]) => `${n} ${a}→${b}`)
  if (e.change.execution) moves.push(`run ${e.change.execution[0] ?? '—'}→${e.change.execution[1]}`)
  if (e.change.hold) moves.push(`hold ${e.change.hold[0] ?? '—'}→${e.change.hold[1] ?? '—'}`)
  const detail = (d.reason ?? d.outcome ?? d.text ?? d.evidence ?? d.note ?? d.status ?? d.decision ?? '') as string
  return `  ${e.seq} ${e.op} by ${e.by}${subject ? ` (${subject})` : ''}${moves.length ? ` [${moves.join(', ')}]` : ''}${detail ? `: ${one(String(detail), 160)}` : ''}`
}

// The documentation steps whose instructions a session was briefed with:
// those running, ready or waiting when each of its attempts began, from the
// last attempt that was given the whole bootstrap on (`attempts`, in order).
export function briefedSteps(r: RunRecord, attempts: string[]): Set<string> {
  const out = new Set<string>()
  const eff = r.definition.effective
  if (!eff) return out
  for (const a of attempts) {
    const begin = r.history.find(e => e.op === 'attempt.begin' && (e as { attempt?: string }).attempt === a)
    if (!begin) continue
    let st
    try { st = replay(r.history.slice(0, begin.seq), { nodes: eff.nodes, edges: eff.edges }).state } catch { continue }
    const at = effectiveOf(st)
    for (const id of [...st.execution.active, ...st.execution.ready, ...st.execution.waiting.map(w => w.node)]) if (at?.nodes[id]?.step) out.add(id)
  }
  return out
}

// Instructions of documentation steps running, ready or waiting now that
// this conversation was not briefed with.
export function newStepLines(r: RunRecord, briefed: Set<string>): string[] {
  const eff = effectiveOf(r)
  if (!eff) return []
  const out: string[] = []
  const now = [...new Set([...r.execution.active, ...r.execution.ready, ...r.execution.waiting.map(w => w.node)])]
  for (const id of now) {
    const step = eff.nodes[id]?.step
    if (!step || briefed.has(id)) continue
    const state = r.nodes[id]?.state
    out.push('', `Step ${id} (${state === 'pending' ? 'ready' : state}), first reached in this conversation: ${step.purpose}. Document: ${runDir(r)}/${step.output}.${step.for && r.nodes[step.for]?.state === 'completed' ? ` Node ${step.for} is completed; only its report remains.` : ''}`, step.instructions)
  }
  return out
}

// `wfe run state`: the compact current state, the pending input in full and,
// with `since`, the entries recorded after that seq. Never the whole record.
export function describeState(r: RunRecord, since?: number): string {
  const lines = [`Run ${runKey(r)}`, ...stateLines(r), ...pendingAnswerLines(r), ...instructionBrief(r), ...delegationBrief(r)]
  if (since !== undefined) {
    const { lines: ch, count } = changeLines(r, since, [], 200)
    lines.push('', count ? `Recorded after seq ${since} (${count}):` : `Nothing recorded after seq ${since}.`, ...ch)
  }
  lines.push('', `Full record: wfe run show ${runKey(r)} (--history: every entry).`)
  return lines.join('\n')
}
