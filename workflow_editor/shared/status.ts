// A run's status as people read it (project_migration p8 ex1): one short
// state, one short reason, and the waits behind them, derived from the
// record's work, control and execution facts and — where the reader has
// them — the execution host's queue and a child's current situation. No
// second status ledger: every word here is recomputed from those facts, and
// the full sentences (a hold's reason, a wait's reason) stay available as
// detail. Shared by the service, the CLI, the browser and the Front Desk.
import type { Delegation } from './delegation.ts'
import { dueReason, type HoldCause, type RunState } from './run.ts'

export type StatusState =
  | 'working' | 'stopping' // an attempt is open
  | 'waiting' // the next move is someone else's: a person, a child run, an external result
  | 'queued' | 'due' | 'stalled' // the next move is the executor's: queued, owed (host facts unknown), owed with nothing queued
  | 'paused' | 'interrupted' | 'unknown' // held
  | 'failed' | 'done' | 'cancelled' | 'not-started' | 'idle'

// One thing the run waits on. `kind` person: a question; delegation: a child
// run's work; external: a named result. `text` is the short form, `detail`
// the record's own words, `condition` what continues it.
export interface StatusWait {
  node: string
  kind: 'person' | 'delegation' | 'external'
  target: string
  text: string
  condition: string
  detail: string
  child?: { project: string; workflow: string; run: string | null; state: string | null }
}

export interface RunStatus {
  state: StatusState
  label: string // Waiting, Queued, Paused, Interrupted, …
  reason: string // the short reason
  text: string // `${label} · ${reason}`
  tone: 'working' | 'waiting' | 'queued' | 'held' | 'warn' | 'done' | 'muted'
  waits: StatusWait[]
  hold?: { kind: string; cause: HoldCause | null; reason: string; since: string; by: string }
  detail: string | null // the full sentence behind the reason, when there is one
}

// What the reader knows beyond the record. `job`: the run's queued or
// claimed job on its execution host (null: none; undefined: not known).
// `children`: a delegation's child as read now (keyed by delegation id).
// `person`: whose answers read as "Your answer". `names`: node labels.
export interface StatusFacts {
  job?: { state: 'queued' | 'claimed'; reason?: string } | null
  children?: Record<string, { situation: string | null; hold?: string | null; execution?: string | null; run?: string | null }>
  person?: string | null
  names?: Record<string, string>
}

const cap = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s
const list = (xs: string[]) => xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`
const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

// A hold's cause in a few words. Holds recorded before causes existed are
// read from their sentence as far as it says.
export function causeText(cause: HoldCause | null | undefined, reason = '', names: Record<string, string> = {}): string {
  const named = (ids: string[]) => list(ids.map(id => names[id] ?? id))
  const nodes = (ids: string[], what: string) => ids.length === 1 ? `${cap(named(ids))} node ${what}` : `${cap(named(ids))} ${what}`
  if (cause) {
    switch (cause.code) {
      case 'left-running': return `${nodes(cause.nodes, 'left running at exit')}`
      case 'left-ready': return `${nodes(cause.nodes, 'left ready at exit')}, nothing waiting`
      case 'nothing-recorded': return 'Ended with none of its work recorded'
      case 'missed-event': return `${cause.events.map(e => `${e.type === 'completed' ? 'Result' : cap(e.type)} of ${e.delegation}`).join(', ')} not taken up`
      case 'process': return cap(short(cause.detail, 70))
      case 'lost': return 'Process lost; outcome unconfirmed'
    }
  }
  let m = /exited with (.+?) recorded as running/.exec(reason)
  if (m) return nodes(m[1].split(', '), 'left running at exit')
  m = /exited with (.+?) ready and nothing waiting/.exec(reason)
  if (m) return `${nodes(m[1].split(', '), 'left ready at exit')}, nothing waiting`
  if (/without taking up delegation event/.test(reason)) return 'Delegation fact not taken up'
  if (/process was gone|not known/.test(reason)) return 'Process lost; outcome unconfirmed'
  return reason ? cap(short(reason.replace(/^the executor /, ''), 70)) : 'Attempt ended with work unfinished'
}

function childWords(state: string | null | undefined, hold?: string | null): string | null {
  if (hold === 'stopped') return 'paused by its person'
  if (hold === 'interrupted' || hold === 'unknown') return 'interrupted'
  switch (state) {
    case 'executing': return 'working'
    case 'stopping': return 'stopping'
    case 'awaiting-person': return 'waiting for an answer'
    case 'awaiting-delegation': return 'waiting for its own delegation'
    case 'awaiting-external': return 'waiting for an external result'
    case 'due': return 'continuing'
    case 'not-started': return 'queued to start'
    case 'completed': return 'done'
    case 'cancelled': return 'cancelled'
    case 'stopped': return 'paused by its person'
    case 'interrupted': return 'interrupted'
    case 'unknown': return 'interrupted (process lost)'
    default: return null
  }
}

// The child of a delegation as its own facts relayed to the parent say,
// without reading it: a recorded hold not resumed since.
function relayedChild(d: Delegation): { hold: string | null } {
  let hold: string | null = null
  for (const e of d.events) {
    if (e.type === 'held') hold = e.hold ?? 'interrupted'
    if (e.type === 'resumed') hold = null
  }
  return { hold }
}

export function waitsOf(s: Pick<RunState, 'nodes' | 'questions' | 'delegations' | 'execution' | 'input'>, facts: StatusFacts = {}): StatusWait[] {
  const person = facts.person ?? s.input.author ?? s.input.onBehalfOf ?? null
  const out: StatusWait[] = []
  for (const w of s.execution.waiting) {
    const n = s.nodes[w.node]
    const detail = n?.wait?.reason ?? ''
    if ('question' in w.on) {
      const q = s.questions[w.on.question]
      const to = q?.to ?? w.holder
      out.push({ node: w.node, kind: 'person', target: to, text: person && to === person ? 'Your answer' : `Answer from ${to}`, condition: 'an answer continues it', detail: q ? `${q.id}: ${short(q.text, 160)}` : detail })
    } else if ('delegation' in w.on) {
      const d = s.delegations?.[w.on.delegation]
      const target = d ? `${d.target.project} ${d.target.workflow}` : w.holder
      const now = d ? facts.children?.[d.id] : undefined
      const words = d ? childWords(now?.situation, now?.hold ?? relayedChild(d).hold) : null
      const troubled = !!words && /interrupted|paused|stopping|cancelled/.test(words)
      out.push({
        node: w.node, kind: 'delegation', target, text: `${target} result${troubled ? ` (child ${words})` : ''}`,
        condition: 'the child\'s question or result continues it', detail: `${detail}${words ? `; the child is ${words}` : ''}`,
        ...(d ? { child: { project: d.target.project, workflow: d.target.workflow, run: d.child?.run ?? null, state: words } } : {}),
      })
    } else {
      const deadline = n?.wait?.deadline
      const over = deadline && Date.parse(deadline) < Date.now()
      out.push({ node: w.node, kind: 'external', target: w.on.external, text: `${short(detail || w.on.external, 60)}${over ? ' (overdue)' : ''}`, condition: `the result ${w.on.external} continues it${deadline ? `, expected by ${deadline}` : ''}`, detail: `${detail} (${w.holder})` })
    }
  }
  return out
}

const status = (state: StatusState, label: string, reason: string, tone: RunStatus['tone'], waits: StatusWait[], extra: Partial<RunStatus> = {}): RunStatus =>
  ({ state, label, reason, text: `${label} · ${reason}`, tone, waits, detail: null, ...extra })

export function runStatus(s: Pick<RunState, 'nodes' | 'questions' | 'delegations' | 'execution' | 'control' | 'cancelled' | 'decisions' | 'instructions' | 'input'>, facts: StatusFacts = {}): RunStatus {
  const waits = waitsOf(s, facts)
  const names = facts.names ?? {}
  const ctl = s.control
  if (s.cancelled) return status('cancelled', 'Cancelled', short(s.cancelled.reason), 'muted', [], { detail: s.cancelled.reason })
  if (ctl.attempt) {
    if (ctl.stop) return status('stopping', 'Stopping', `Stop requested by ${ctl.stop.by}`, 'warn', waits, { detail: ctl.stop.reason })
    const doing = s.execution.active.map(id => names[id] ?? id)
    return status('working', 'Working', doing.length ? `On ${list(doing)}` : 'Between steps', 'working', waits)
  }
  if (ctl.hold) {
    const h = ctl.hold
    const hold = { kind: h.kind, cause: h.cause ?? null, reason: h.reason, since: h.since, by: h.by }
    if (h.kind === 'stopped') return status('paused', 'Paused', short(h.reason) || `by ${h.by}`, 'held', waits, { hold, detail: `Stopped by ${h.by}: ${h.reason}` })
    return status(h.kind === 'unknown' ? 'unknown' : 'interrupted', h.kind === 'unknown' ? 'Unknown' : 'Interrupted', causeText(h.cause, h.reason, names), 'held', waits, { hold, detail: h.reason })
  }
  if (s.execution.state === 'completed') {
    const d = s.decisions.at(-1)?.decision
    return status('done', 'Done', d === 'accepted' ? 'Result accepted' : d === 'rejected' ? 'Result rejected' : 'Every step completed', 'done', [])
  }
  const due = dueReason(s)
  if (facts.job) return status('queued', facts.job.state === 'claimed' ? 'Starting' : 'Queued', facts.job.state === 'claimed' ? 'An execution slot was taken' : 'Waiting for an execution slot', 'queued', waits, { detail: due ?? facts.job.reason ?? null })
  if (s.execution.state === 'not-started') return facts.job === null ? status('stalled', 'Not started', 'Nothing is queued to start it', 'warn', waits) : status('not-started', 'Not started', 'Waiting to be started', 'muted', waits)
  if (due) return facts.job === null
    ? status('stalled', 'Stalled', `${cap(due)}; nothing queued to continue it`, 'warn', waits, { detail: due })
    : status('due', 'Continuing', cap(due), 'queued', waits, { detail: due })
  if (waits.length) {
    const order = ['person', 'delegation', 'external']
    const first = [...waits].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0]
    const more = waits.length - 1
    return status('waiting', 'Waiting', `${first.text}${more ? ` (+${more} more)` : ''}`, 'waiting', waits, { detail: waits.map(w => w.detail).join('; ') })
  }
  if (s.execution.failed.length) return status('failed', 'Failed', `${list(s.execution.failed.map(id => names[id] ?? id))} failed`, 'warn', [], { detail: s.execution.failed.map(id => s.nodes[id]?.failure?.reason ?? '').filter(Boolean).join('; ') || null })
  return status('idle', 'Idle', 'Nothing to do now', 'muted', [])
}
