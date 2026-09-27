// The progress panel's data (`progress_panel` p1): the relay's `/progress`
// board, and a scripted one for `&demo=1`.
//
// **Nothing here decides a state.** The relay reads the conversations,
// Observer's records and the health checks, and pyagag's `agag.progress`
// says what each unit is (`display.state`, its reason, whose move); this
// file only types the payload and words it. What *is* here is presentation:
// labels, tones, how a meter is segmented, how old a fact is.

import { readRelay } from './roomState'

export type DisplayState =
  | 'planning' | 'queued' | 'working' | 'waiting' | 'awaiting_you'
  | 'answered' | 'completed' | 'cancelled' | 'stopped' | 'unknown'

export type Evidence = 'confirmed' | 'stale' | 'conversation'
export type Activity = 'active' | 'waiting' | 'claimed' | 'stopped' | 'ended' | 'unknown'

export interface ProgressHealth {
  verdict: string
  why: string
  observed_at: number | null
  age: number | null
  process: string | null
  last_work: string | null
  last_work_at: number | null
  wait: { kind: string; name?: string; detail?: string; since?: number; bound_seconds?: number | null } | null
  unknowns: string[]
  injected?: { fault?: string } | null
}

export interface ProgressRun {
  determinate: number | null
  activity: Activity
  action: string | null
  action_at: number | null
  action_age: number | null
  evidence: Evidence
  observed_at: number | null
}

export interface ProgressMeter {
  known: boolean
  total: number | null
  completed: number
  working: number
  awaiting_agreement: number
  stopped?: number
  unknown?: number
  cancelled: number
  revisions: { doc: number; at: number; total: number }[]
  note: string
  segments?: string[]
}

export interface ProgressRecovery {
  incident?: string
  kind?: string
  state?: string
  open?: boolean
  unrecovered?: boolean
  fact?: string
  held?: boolean
  held_why?: string
  retired?: boolean
  retired_why?: string
}

export interface ProgressUnit {
  anchor: number
  kind: 'request' | 'plan' | 'task' | 'run' | 'routine_run' | 'conversation'
  channel: string
  topic: string
  resolved: boolean
  label: string
  owner: string
  serial: number
  work: { state: string; record: string | null; detail: string }
  execution: { serving: string; ack: number | null; evidence: Evidence; health: ProgressHealth | null; health_note?: string }
  holder: string
  waiting_on: string[]
  recovery: ProgressRecovery | null
  display: { state: DisplayState; reason: string; next: string }
  latest_work_at: number | null
  evidence_id: number | null
  failures: string[]
  awaiting_agreement: boolean
  run: ProgressRun | null
  meter?: ProgressMeter | null
  children: ProgressUnit[]
}

export interface ProgressStage {
  stage: 'tasks_agreed' | 'plan_accepted' | 'run_ended' | 'report_delivered' | 'knowledge_refreshed'
  unit: number
  label: string
  status: 'done' | 'pending'
  detail: string
  evidence?: number | null
}

export interface ProgressCard {
  origin: number
  anchor: number
  observed_at: number
  state: DisplayState
  reason: string
  next: string
  focus: number | null
  latest_work_at: number | null
  stale: boolean
  problem: string
  stages: ProgressStage[]
  root: ProgressUnit | null
  topic: string
  live_topic: string
  resolved: boolean
  desk: string | null
  group: 'active' | 'recent' | 'current'
  last_at: number
  observer_tracked: boolean
  observer_held: boolean
  links: Record<string, string>
  current?: boolean
}

export interface ProgressBoard {
  schema: string
  generated_at: number
  served_at?: number
  source: { mirror: string; reason: string; last_event_at: number | null; revision: number | null }
  observer: { available: boolean; problems: string[]; monitor: { state: string; reason: string } }
  health: { owners: string[]; probes_run: number; note: string }
  bounds: { active_hours: number; recent_hours: number; recent_max: number; max_cards: number; refresh_seconds: number }
  cards: ProgressCard[]
  current: string | null
  current_note?: string
  error?: string
}

export interface ProgressSource {
  board: (current: string | null) => Promise<ProgressBoard | { error: string }>
}

export const relayProgress: ProgressSource = {
  board: (current) => readRelay<ProgressBoard>(`/progress${current ? `?current=${encodeURIComponent(current)}` : ''}`),
}

// --- words and tones --------------------------------------------------------------

export type Tone = 'ok' | 'live' | 'wait' | 'you' | 'bad' | 'unknown' | 'dim'

export const STATE_WORDS: Record<DisplayState, { label: string; icon: string; tone: Tone }> = {
  planning: { label: 'planning', icon: '✎', tone: 'live' },
  queued: { label: 'queued', icon: '⋯', tone: 'dim' },
  working: { label: 'working', icon: '▶', tone: 'live' },
  waiting: { label: 'waiting', icon: '⏳', tone: 'wait' },
  awaiting_you: { label: 'needs you', icon: '✋', tone: 'you' },
  answered: { label: 'answered', icon: '💬', tone: 'dim' },
  completed: { label: 'completed', icon: '✓', tone: 'ok' },
  cancelled: { label: 'cancelled', icon: '⊘', tone: 'dim' },
  stopped: { label: 'stopped', icon: '■', tone: 'bad' },
  unknown: { label: 'unknown', icon: '?', tone: 'unknown' },
}

export const STAGE_WORDS: Record<ProgressStage['stage'], string> = {
  tasks_agreed: 'tasks agreed',
  plan_accepted: 'plan accepted',
  run_ended: 'run ended',
  report_delivered: 'report delivered',
  knowledge_refreshed: 'knowledge refreshed',
}

export const ACTIVITY_WORDS: Record<Activity, string> = {
  active: 'active',
  waiting: 'waiting on a call',
  claimed: 'open (unconfirmed)',
  stopped: 'stopped',
  ended: 'ended',
  unknown: 'no evidence',
}

export const EVIDENCE_WORDS: Record<Evidence, string> = {
  confirmed: 'health check',
  stale: 'old health check',
  conversation: 'conversation only',
}

export function ageOf(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '?'
  const s = Math.max(0, Math.round(seconds))
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  if (s < 172800) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`
  return `${Math.round(s / 86400)} days`
}

export function since(stamp: number | null | undefined, now = Date.now() / 1000): string {
  return stamp ? `${ageOf(now - stamp)} ago` : 'never'
}

export function clockOf(stamp: number | null | undefined): string {
  if (!stamp) return '—'
  return new Date(stamp * 1000).toISOString().slice(11, 19) + 'Z'
}

// A plan meter's segments, one per task in serial order, each a tone. A task
// awaiting agreement is its own segment kind; a working task animates only
// when the panel is live and the evidence for it is fresh (the panel decides
// that at draw time from the unit, not from here).
export type Segment = 'done' | 'working' | 'agreement' | 'waiting' | 'stopped' | 'unknown' | 'queued'

export function segmentOf(state: string): Segment {
  switch (state) {
    case 'completed': return 'done'
    case 'awaiting_agreement': return 'agreement'
    case 'working': return 'working'
    case 'waiting': return 'waiting'
    case 'stopped': return 'stopped'
    case 'unknown': return 'unknown'
    case 'cancelled': return 'queued'
    default: return 'queued'
  }
}

export function meterWords(meter: ProgressMeter): string {
  if (!meter.known || meter.total === null) return 'planning — no task is known yet'
  const parts = [`${meter.completed}/${meter.total} task${meter.total === 1 ? '' : 's'} agreed`]
  if (meter.working) parts.push(`${meter.working} in progress`)
  if (meter.awaiting_agreement) parts.push(`${meter.awaiting_agreement} awaiting agreement`)
  if (meter.stopped) parts.push(`${meter.stopped} stopped`)
  if (meter.unknown) parts.push(`${meter.unknown} without evidence`)
  if (meter.cancelled) parts.push(`${meter.cancelled} cancelled`)
  return parts.join(' · ')
}

export function unitsOf(card: ProgressCard): ProgressUnit[] {
  const found: ProgressUnit[] = []
  const walk = (unit: ProgressUnit) => { found.push(unit); unit.children.forEach(walk) }
  if (card.root) walk(card.root)
  return found
}

export function titleOf(card: ProgressCard): string {
  return card.desk ?? card.topic.replace(/^front-/, '')
}

// --- the demo ----------------------------------------------------------------------
//
// Two requests in two conversations sharing one agent, moving on a clock from
// the moment the page opened: A plans, its tasks run and wait for agreement
// one after another, the plan changes its mind (3 → 4 tasks), and it
// completes; B's single task waits on a tool, then its health check goes
// stale, then it is stopped and recovered. `window.__progressDemo.at(s)`
// jumps the script. Nothing here reaches the realm.

interface DemoFrame { at: number; a: Partial<Record<string, string>>; b: string; aPlan: number; bNote?: string }

export function demoProgress(): ProgressSource & { at: (seconds: number) => void; fail: (on: boolean) => void } {
  let offset = 0
  let failing = false
  const started = Date.now() / 1000
  const now = () => Date.now() / 1000
  const elapsed = () => now() - started + offset
  const frames: DemoFrame[] = [
    { at: 0, a: {}, b: 'working', aPlan: 0 },
    { at: 8, a: { t1: 'working', t2: 'queued', t3: 'queued' }, b: 'waiting', aPlan: 3 },
    { at: 16, a: { t1: 'awaiting_agreement', t2: 'queued', t3: 'queued' }, b: 'waiting', aPlan: 3 },
    { at: 24, a: { t1: 'completed', t2: 'working', t3: 'queued', t4: 'queued' }, b: 'stale', aPlan: 4 },
    { at: 32, a: { t1: 'completed', t2: 'completed', t3: 'working', t4: 'queued' }, b: 'stopped', aPlan: 4 },
    { at: 40, a: { t1: 'completed', t2: 'completed', t3: 'completed', t4: 'awaiting_agreement' }, b: 'working', aPlan: 4, bNote: 'resumed after the stop' },
    { at: 48, a: { t1: 'completed', t2: 'completed', t3: 'completed', t4: 'completed' }, b: 'awaiting_you', aPlan: 4 },
    { at: 56, a: { t1: 'completed', t2: 'completed', t3: 'completed', t4: 'completed', done: 'yes' }, b: 'awaiting_you', aPlan: 4 },
  ]
  const frame = () => [...frames].reverse().find((f) => elapsed() >= f.at) ?? frames[0]
  const link = (anchor: number) => `https://zulip.invalid/#narrow/near/${anchor}`

  const unit = (partial: Partial<ProgressUnit> & Pick<ProgressUnit, 'anchor' | 'kind' | 'label'>): ProgressUnit => ({
    channel: 'demo', topic: partial.label, resolved: false, owner: 'autolab', serial: 0,
    work: { state: 'executing', record: null, detail: '' },
    execution: { serving: 'ended', ack: null, evidence: 'conversation', health: null },
    holder: 'owner', waiting_on: [], recovery: null,
    display: { state: 'queued', reason: '', next: '' },
    latest_work_at: now() - 20, evidence_id: partial.anchor, failures: [], awaiting_agreement: false,
    run: null, children: [], ...partial,
  })

  const task = (serial: number, state: string): ProgressUnit => {
    const t = now()
    const agreement = state === 'awaiting_agreement'
    const shown: DisplayState = agreement ? 'waiting' : (state as DisplayState)
    const reason = {
      working: 'health check: work 4 s ago (tool Bash)',
      queued: serial > 1 ? `after task ${serial - 1}` : 'opened, not started',
      completed: 'its record says completed',
      waiting: 'a result was shown; waiting for Front\'s agreement',
    }[agreement ? 'waiting' : state] ?? state
    return unit({
      anchor: 200 + serial, kind: 'task', label: `task 100#${serial}`, serial,
      topic: `workrun-task${serial}-m100`, channel: 'work-m100',
      work: { state: state === 'completed' ? 'done' : 'executing', record: state === 'completed' ? 'completed' : null, detail: '' },
      execution: state === 'working'
        ? { serving: 'open', ack: 300 + serial, evidence: 'confirmed', health: { verdict: 'running', why: 'work 4 s ago', observed_at: t - 6, age: 6, process: 'alive', last_work: 'tool Bash', last_work_at: t - 4, wait: null, unknowns: [] } }
        : { serving: state === 'queued' ? 'unknown' : 'ended', ack: null, evidence: 'conversation', health: null },
      display: { state: shown, reason, next: agreement ? 'Front' : 'autolab' },
      awaiting_agreement: agreement,
      run: state === 'working' ? { determinate: null, activity: 'active', action: 'tool Bash — npm test', action_at: t - 4, action_age: 4, evidence: 'confirmed', observed_at: t - 6 } : null,
    })
  }

  const cardA = (f: DemoFrame): ProgressCard => {
    const tasks = Object.entries(f.a).filter(([k]) => k.startsWith('t')).map(([k, v]) => task(Number(k.slice(1)), v as string))
    const done = f.a.done === 'yes'
    const planning = f.aPlan === 0
    const completed = tasks.filter((t) => t.display.state === 'completed').length
    const working = tasks.filter((t) => t.display.state === 'working').length
    const agreement = tasks.filter((t) => t.awaiting_agreement).length
    const meter: ProgressMeter = planning
      ? { known: false, total: null, completed: 0, working: 0, awaiting_agreement: 0, cancelled: 0, revisions: [{ doc: 150, at: started, total: 0 }], note: 'planning: no task is known yet' }
      : { known: true, total: tasks.length, completed, working, awaiting_agreement: agreement, cancelled: 0,
          revisions: f.aPlan === 4 ? [{ doc: 150, at: started, total: 3 }, { doc: 160, at: started + 20, total: 4 }] : [{ doc: 150, at: started, total: 3 }],
          note: f.aPlan === 4 ? 'plan revised 1×: 3 → 4 tasks' : '',
          segments: tasks.map((t) => t.awaiting_agreement ? 'awaiting_agreement' : t.display.state) }
    const planState: DisplayState = done ? 'completed' : planning ? 'planning' : 'waiting'
    const plan = unit({
      anchor: 100, kind: 'plan', label: 'mission m100 (demo)', channel: 'pj-demo', topic: 'workplan-demo-a',
      display: { state: planState, reason: done ? 'its record says done' : planning ? 'no task is known yet (its planner\'s serving is open)' : 'on work opened from it', next: 'autolab' },
      meter, children: tasks,
    })
    const state: DisplayState = done ? 'completed' : planning ? 'planning' : working ? 'working' : agreement ? 'waiting' : 'working'
    const stages: ProgressStage[] = planning ? [] : [
      { stage: 'tasks_agreed', unit: 100, label: plan.label, status: completed === tasks.length ? 'done' : 'pending', detail: `${completed}/${tasks.length} task(s) agreed` },
      { stage: 'plan_accepted', unit: 100, label: plan.label, status: done ? 'done' : 'pending', detail: done ? 'accepted: #420 by 8 (Developer)' : 'not accepted yet' },
    ]
    return {
      origin: 10, anchor: 10, observed_at: now(), state, reason: done ? 'every unit of work is finished by its record' : planning ? 'no task is known yet' : agreement ? 'a result was shown; waiting for Front\'s agreement' : 'health check: work 4 s ago (tool Bash)',
      next: done ? '' : agreement ? 'Front' : 'autolab', focus: null, latest_work_at: now() - 4, stale: false, problem: '',
      stages, topic: 'front-desk-demo-a', live_topic: 'front-desk-demo-a', resolved: false, desk: 'demo-a',
      group: done ? 'recent' : 'active', last_at: now() - 4, observer_tracked: false, observer_held: false,
      links: { 10: link(10), 100: link(100), ...Object.fromEntries(tasks.map((t) => [t.anchor, link(t.anchor)])) },
      root: unit({ anchor: 10, kind: 'request', label: 'front-desk-demo-a', owner: 'Front', display: { state: done ? 'answered' : 'waiting', reason: done ? 'answered; nothing is asked of anybody' : 'on work opened from it', next: '' }, children: [plan] }),
    }
  }

  const cardB = (f: DemoFrame): ProgressCard => {
    const t = now()
    const health = (verdict: string, age: number, wait: ProgressHealth['wait'] = null): ProgressHealth => ({ verdict, why: verdict === 'waiting' ? 'a named tool call inside its bound' : verdict === 'stopped' ? 'the process is gone and nothing was posted' : 'work 3 s ago', observed_at: t - age, age, process: verdict === 'stopped' ? 'exited' : 'alive', last_work: 'text', last_work_at: t - 40, wait, unknowns: [] })
    const wait = { kind: 'tool', name: 'Bash', detail: 'pytest -q tests/ (bound 600 s)', since: t - 95, bound_seconds: 600 }
    const table: Record<string, { display: ProgressUnit['display']; execution: ProgressUnit['execution']; run: ProgressRun | null; recovery: ProgressRecovery | null }> = {
      working: { display: { state: 'working', reason: f.bNote ? `health check: work 3 s ago — ${f.bNote}` : 'health check: work 3 s ago', next: 'autolab' },
        execution: { serving: 'open', ack: 520, evidence: 'confirmed', health: health('running', 5) },
        run: { determinate: null, activity: 'active', action: 'text', action_at: t - 3, action_age: 3, evidence: 'confirmed', observed_at: t - 5 }, recovery: f.bNote ? { kind: 'stopped', state: 'rescued', open: false } : null },
      waiting: { display: { state: 'waiting', reason: 'on Bash — pytest -q tests/ (bound 600 s)', next: 'autolab' },
        execution: { serving: 'open', ack: 510, evidence: 'confirmed', health: health('waiting', 8, wait) },
        run: { determinate: null, activity: 'waiting', action: 'tool: Bash — pytest -q tests/ (bound 600 s)', action_at: t - 95, action_age: 95, evidence: 'confirmed', observed_at: t - 8 }, recovery: null },
      stale: { display: { state: 'unknown', reason: 'the last health check is 6 min old', next: 'autolab' },
        execution: { serving: 'open', ack: 510, evidence: 'stale', health: health('waiting', 360, wait) },
        run: { determinate: null, activity: 'unknown', action: 'last sign of work', action_at: t - 420, action_age: 420, evidence: 'stale', observed_at: t - 360 }, recovery: null },
      stopped: { display: { state: 'stopped', reason: 'health check: the process is gone and nothing was posted', next: 'Front' },
        execution: { serving: 'open', ack: 510, evidence: 'confirmed', health: health('stopped', 4) },
        run: { determinate: null, activity: 'stopped', action: 'last sign of work', action_at: t - 60, action_age: 60, evidence: 'confirmed', observed_at: t - 4 },
        recovery: { kind: 'stopped', state: 'recovering', open: true, fact: 'a health check found the work stopped' } },
      awaiting_you: { display: { state: 'waiting', reason: 'a result was shown; waiting for Front\'s agreement', next: 'Front' },
        execution: { serving: 'ended', ack: 520, evidence: 'conversation', health: null }, run: null, recovery: null },
    }
    const row = table[f.b] ?? table.working
    const taskB = unit({ anchor: 501, kind: 'task', label: 'task 500#1', serial: 1, channel: 'work-m500', topic: 'workrun-task1-m500',
      ...row, awaiting_agreement: f.b === 'awaiting_you' })
    const plan = unit({ anchor: 500, kind: 'plan', label: 'mission m500 (demo)', channel: 'pj-demo', topic: 'workplan-demo-b',
      display: { state: 'waiting', reason: 'on work opened from it', next: 'autolab' },
      meter: { known: true, total: 1, completed: 0, working: f.b === 'awaiting_you' ? 0 : 1, awaiting_agreement: f.b === 'awaiting_you' ? 1 : 0, cancelled: 0, revisions: [{ doc: 505, at: started, total: 1 }], note: '', segments: [f.b === 'awaiting_you' ? 'awaiting_agreement' : row.display.state] },
      children: [taskB] })
    const asks = f.b === 'awaiting_you'
    const root = unit({ anchor: 50, kind: 'request', label: 'front-desk-demo-b', owner: 'Front',
      display: asks ? { state: 'awaiting_you', reason: '#530 asks you (confirmation)', next: 'you' } : { state: 'waiting', reason: 'on work opened from it', next: '' }, children: [plan] })
    const state: DisplayState = asks ? 'awaiting_you' : row.display.state
    return {
      origin: 50, anchor: 50, observed_at: t, state, reason: asks ? '#530 asks you (confirmation)' : row.display.reason, next: asks ? 'you' : row.display.next,
      focus: null, latest_work_at: t - 3, stale: false, problem: '',
      stages: [{ stage: 'tasks_agreed', unit: 500, label: plan.label, status: 'pending', detail: '0/1 task(s) agreed' },
        { stage: 'plan_accepted', unit: 500, label: plan.label, status: 'pending', detail: 'not accepted yet' }],
      topic: 'front-desk-demo-b', live_topic: 'front-desk-demo-b', resolved: false, desk: 'demo-b', group: 'active', last_at: t - 3,
      observer_tracked: f.b === 'stopped', observer_held: false, links: { 50: link(50), 500: link(500), 501: link(501) }, root,
    }
  }

  const source = {
    async board(current: string | null): Promise<ProgressBoard | { error: string }> {
      if (failing) return { error: 'the agentroom relay is not answering on http://localhost:8094 (demo)' }
      const f = frame()
      let cards = [cardA(f), cardB(f)]
      if (current) {
        const mine = cards.filter((c) => c.desk === current).map((c) => ({ ...c, current: true }))
        cards = [...mine, ...cards.filter((c) => c.desk !== current)]
      }
      return {
        schema: 'ag.progress-board.v1', generated_at: now(), served_at: now(),
        source: { mirror: 'live', reason: 'live (demo)', last_event_at: now() - 2, revision: 1 },
        observer: { available: true, problems: [], monitor: { state: 'ok', reason: 'Observer\'s last look ended 20 s ago' } },
        health: { owners: ['autolab-agstudio1'], probes_run: 3, note: 'only these owners expose execution health; every other owner is read from its conversation alone' },
        bounds: { active_hours: 12, recent_hours: 24, recent_max: 6, max_cards: 16, refresh_seconds: 5 },
        cards, current,
        ...(current && !cards.some((c) => c.desk === current) ? { current_note: 'this conversation has no post yet, so it is not a request' } : {}),
      }
    },
    at(seconds: number) { offset = seconds - (now() - started) },
    fail(on: boolean) { failing = on },
  }
  return source
}
