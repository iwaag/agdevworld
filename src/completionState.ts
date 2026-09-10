// Completing a request: the relay's shared operation, read and applied.
//
// One request is any conversation, `(channel, topic)` — a Front Desk
// conversation, an ordinary `front-*` one, one run of a routine, an Autolab
// `workplan-`, a Forge `assetplan-` (`front_desk` p4). The relay decides what
// the request owns, what would change and why; this file carries those words
// to the screens and sends back the fingerprint of the plan a human read.
// Nothing here decides that a Work may be closed or that a channel is done.
//
// Two screens draw the same plan: the Front Desk's Phaser panel and the DOM
// overlay the operation room and the agent room open. `planLines()` is the
// one view model both render, so they cannot say different things.

const BASE = (import.meta.env.VITE_AGENTROOM_URL as string | undefined) ?? 'http://localhost:8094'

export type CompletionKind = 'work' | 'topic' | 'channel' | 'conversation'

// One piece of a work record: an autolab task (a conversation of its own) or
// a forge Sub-Work. `state` is in its own storage's vocabulary.
export interface CompletionChild {
  label: string
  state: string
  channel?: string
  topic?: string
  reached?: boolean
}
export type CompletionState = 'ready' | 'done' | 'blocked' | 'kept'
export type CompletionOutcome = 'applied' | 'already' | 'failed' | 'skipped'

export interface CompletionAction {
  kind: CompletionKind
  // Stable across previews and retries: what a result is matched to.
  key: string
  label: string
  state: CompletionState
  reason: string
  detail: Record<string, unknown>
}

export interface CompletionResult {
  key: string
  kind: CompletionKind
  label: string
  outcome: CompletionOutcome
  note: string
}

export interface CompletionRef {
  channel: string
  topic: string
}

// A conversation this root was opened for, by its own root note. For an
// execution topic the structural one (autolab's plan for a task, forge's
// plan for a run) comes first and is the one to go to.
export interface CompletionParent extends CompletionRef {
  kind: string
  by: string
  by_id: number
  message_id: number
  structural: boolean
}

export interface CompletionScope {
  root: CompletionRef
  kind: string
  closable: boolean
  reason: string
  description: string
  parents: CompletionParent[]
  // Mentioned by the records, not owned: a routine run's guide.
  context: Array<CompletionRef & { relation: string; reason: string }>
  routine: { name: string; channel: string; run_topic: string; guide_topic: string } | null
}

export interface CompletionRecord {
  at: number
  channel: string
  topic: string
  kind: string
  fingerprint: string
  results: CompletionResult[]
}

export interface CompletionPlan {
  schema: string
  generated_at: number
  channel: string
  topic: string
  root: CompletionRef
  scope: CompletionScope
  // What the human approves. A close carries it back and the relay refuses
  // with a fresh plan if the targets have changed since.
  fingerprint: string
  status: { zulip_read: boolean; zulip_write: boolean; reason: string }
  actions: CompletionAction[]
  counts: { ready: number; blocked: number; done: number; kept: number }
  blocked: CompletionAction[]
  excluded: Array<CompletionRef & { reason: string; kind?: string }>
  gaps: { truncated: boolean; unread: string[]; bounded: string[]; errors: unknown[] }
  results: CompletionResult[]
  history: CompletionRecord[]
  note: string
  // Only on the answer to a close.
  applied?: boolean
  partial?: boolean
  refused?: boolean
  error?: string
}

export type CompletionAnswer = CompletionPlan | { error: string }

// A refusal (409) is a plan that also carries `error`; only an answer with no
// plan in it is unreadable.
export function isCompletionPlan(answer: CompletionAnswer): answer is CompletionPlan {
  return 'actions' in answer && Array.isArray((answer as CompletionPlan).actions)
}

export interface CompletionSource {
  plan: (root: CompletionRef) => Promise<CompletionAnswer>
  apply: (root: CompletionRef, fingerprint: string) => Promise<CompletionAnswer>
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T | { error: string }> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    return { error: timedOut
      ? 'the agentroom relay did not answer in time; ask for the plan again to see what moved'
      : `the agentroom relay is not answering on ${BASE}` }
  }
  const payload = (await response.json().catch(() => undefined)) as (T & { error?: string; refused?: boolean }) | undefined
  if (!payload || typeof payload !== 'object') return { error: `agentroom answered ${response.status}` }
  // 409 is the refusal that carries the fresh plan — a payload, not an error.
  if (!response.ok && !payload.refused) return { error: payload.error ?? `agentroom answered ${response.status}` }
  return payload
}

const query = (root: CompletionRef) =>
  `channel=${encodeURIComponent(root.channel)}&topic=${encodeURIComponent(root.topic)}`

export const relayCompletion: CompletionSource = {
  plan: (root) => readJson<CompletionPlan>(`${BASE}/complete/plan?${query(root)}`, { signal: AbortSignal.timeout(20000) }),
  apply: (root, fingerprint) => readJson<CompletionPlan>(`${BASE}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: root.channel, topic: root.topic, fingerprint }),
    signal: AbortSignal.timeout(60000),
  }),
}

export async function loadCompletionHistory(root?: CompletionRef): Promise<{ history: CompletionRecord[] } | { error: string }> {
  return readJson(`${BASE}/complete/history${root ? `?${query(root)}` : ''}`, { signal: AbortSignal.timeout(8000) })
}

// The event a screen fires once anything moved, so every view on the page
// re-reads what it shows (a closed run is ✔, an archived channel is gone).
export const COMPLETED_EVENT = 'agdevworld:completed'
export function announceCompleted(root: CompletionRef): void {
  window.dispatchEvent(new CustomEvent(COMPLETED_EVENT, { detail: root }))
}

// --- the words both panels draw --------------------------------------------------

export type Tone = 'ink' | 'muted' | 'dim' | 'accent' | 'ready' | 'warn' | 'bad'
export interface PlanLine {
  text: string
  tone: Tone
  indent: number
  size: 'body' | 'small'
  // Set on a parent line: where to go instead. The DOM panel makes it a
  // button; the Phaser panel makes it clickable text.
  navigate?: CompletionRef
}

export type PlanPhase = 'preview' | 'working' | 'done'

// One glyph per state, so a row reads before it is read.
export const MARK: Record<string, string> = {
  ready: '▶', done: '✔', blocked: '⨯', kept: '·',
  applied: '✔', already: '·', failed: '⨯', skipped: '—',
}
export const TINT: Record<string, Tone> = {
  ready: 'ready', done: 'dim', blocked: 'bad', kept: 'muted',
  applied: 'ready', already: 'dim', failed: 'bad', skipped: 'warn',
}
const KIND: Record<string, string> = {
  work: 'work', topic: 'topic', channel: 'channel', conversation: 'this request',
}
const ROOT_KIND: Record<string, string> = {
  desk: 'Front Desk conversation', front: 'Front conversation', 'routine-run': 'routine run',
  workplan: 'Autolab request', assetplan: 'Forge request', workrun: 'Autolab task topic',
  assetrun: 'Forge run topic', 'routine-guide': 'routine guide', intro: 'introduction',
  topic: 'conversation',
}

export function rootKindLabel(kind: string): string {
  return ROOT_KIND[kind] ?? kind
}

export function refLabel(ref: CompletionRef): string {
  return `#${ref.channel} › ${ref.topic}`
}

export function summaryLine(plan: CompletionPlan, phase: PlanPhase): string {
  const counts = plan.counts
  if (phase === 'working') return 'closing…'
  if (phase === 'done') {
    const applied = plan.results.filter((one) => one.outcome === 'applied').length
    const failed = plan.results.filter((one) => one.outcome === 'failed').length
    const skipped = plan.results.filter((one) => one.outcome === 'skipped').length
    if (plan.partial) {
      return `partially closed — ${applied} changed, ${failed} failed, ${skipped} left; the request stays open`
    }
    const kept = plan.results.filter((one) => one.outcome === 'skipped').length
    return `closed — ${applied} changed, ${plan.results.length - applied - kept} already were${kept ? `, ${kept} kept` : ''}`
  }
  if (!plan.scope.closable) return 'nothing to close here'
  return `${counts.ready} to change · ${counts.done} already · ${counts.blocked} blocked · ${counts.kept} kept`
}

export function summaryTone(plan: CompletionPlan, phase: PlanPhase): Tone {
  if (plan.refused) return 'warn'
  if (phase === 'done') return plan.partial ? 'warn' : 'ready'
  if (!plan.scope.closable) return 'warn'
  return plan.counts.blocked ? 'warn' : 'muted'
}

export function titleLine(plan: CompletionPlan, phase: PlanPhase): string {
  if (phase === 'done' && !plan.partial) return 'CLOSED'
  if (!plan.scope.closable) return 'NOT A REQUEST'
  return `FINISH THIS ${rootKindLabel(plan.scope.kind).toUpperCase()}`
}

// Every line the panel shows for a plan, in order. The Phaser panel and the
// DOM overlay both draw exactly this list.
export function planLines(plan: CompletionPlan, phase: PlanPhase): PlanLine[] {
  const lines: PlanLine[] = []
  const line = (text: string, tone: Tone, indent = 0, size: PlanLine['size'] = 'small', navigate?: CompletionRef) => {
    const entry: PlanLine = { text, tone, indent, size }
    if (navigate) entry.navigate = navigate
    lines.push(entry)
  }
  const scope = plan.scope
  const finished = phase === 'done'

  line(scope.description, 'muted', 0, 'body')
  if (plan.refused && plan.error) line(plan.error, 'warn', 0, 'body')
  if (!scope.closable) {
    line(scope.reason, 'warn', 0, 'body')
    for (const parent of scope.parents) {
      line(`→ ${parent.structural ? 'go to' : 'also served'} ${refLabel(parent)} (${rootKindLabel(parent.kind)}, by ${parent.by})`,
           'accent', 8, 'body', parent)
    }
  } else if (scope.parents.length) {
    for (const parent of scope.parents) {
      line(`opened for ${refLabel(parent)} (${rootKindLabel(parent.kind)}) — stays open; go there to finish it too`,
           'accent', 0, 'small', parent)
    }
  }
  if (!plan.status.zulip_write) line(plan.status.reason, 'bad', 0, 'body')
  // No Plane warning any more: since `refactor` p2 both agents keep their
  // work record in the conversations, so there is no credential this panel
  // could be missing and no row it could fail to read.

  const results = new Map<string, CompletionResult>(plan.results.map((one) => [one.key, one]))
  if (scope.closable) {
    for (const action of plan.actions) {
      const result = results.get(action.key)
      const state = result ? result.outcome : action.state
      const tone = TINT[state] ?? 'muted'
      line(`${MARK[state] ?? '·'} ${KIND[action.kind] ?? action.kind} · ${action.label}`,
           state === 'ready' ? 'ink' : tone, 0, 'body')
      line(result ? result.note : action.reason, tone, 18)
      const unreached = (action.detail?.unreached_children as string[] | undefined) ?? []
      if (unreached.length) {
        line(`pieces of this work the request never reached: ${unreached.join(', ')}`, 'warn', 18)
      }
      // An autolab mission is made of conversations, and each one's state is
      // the thing a reader is judging: `completed` is the run's word,
      // `accepted` is a person's, and neither is the ✔ on the topic below.
      for (const child of (action.detail?.children as CompletionChild[] | undefined) ?? []) {
        if (action.detail?.source !== 'agautolab') continue
        line(`${child.label} · ${child.state} — #${child.channel} › ${child.topic}`, 'muted', 18)
      }
      const visitors = (action.detail?.visitors as CompletionParent[] | undefined) ?? []
      for (const visitor of visitors) {
        line(`also served on behalf of ${refLabel(visitor)} (${visitor.by}) — that request is not touched`, 'dim', 18)
      }
    }
  }

  if (scope.context.length) {
    line('mentioned, not touched', 'accent', 0, 'small')
    for (const row of scope.context) {
      line(`· ${refLabel(row)} — ${row.relation}`, 'muted', 8, 'small')
      line(row.reason, 'dim', 20)
    }
  }
  if (plan.excluded.length) {
    line(scope.closable ? 'not this request’s — left alone' : 'the parent’s — left alone', 'accent', 0, 'small')
    for (const row of plan.excluded) {
      line(`· ${refLabel(row)}`, 'muted', 8, 'small')
      line(row.reason, 'dim', 20)
    }
  }
  const gaps = [
    ...plan.gaps.unread.map((one) => `${one} could not be read`),
    ...plan.gaps.bounded.map((one) => `${one} was read as a window; older posts are in Zulip`),
    ...(plan.gaps.truncated ? ['the walk hit its node cap; there may be more'] : []),
  ]
  if (gaps.length) {
    line('what is not known', 'warn', 0, 'small')
    for (const gap of gaps) line(`· ${gap}`, 'warn', 8)
  }
  if (plan.history.length && !finished) {
    const last = plan.history[plan.history.length - 1]!
    const applied = last.results.filter((one) => one.outcome === 'applied').length
    const failed = last.results.filter((one) => one.outcome === 'failed').length
    line(`this relay last closed it at ${new Date(last.at * 1000).toLocaleString()} — ${applied} changed, ${failed} failed (${plan.history.length} operation${plan.history.length > 1 ? 's' : ''} remembered)`,
         'dim', 0)
  }
  line(plan.note, 'dim', 0)
  if (phase === 'working') line('closing…', 'accent', 0, 'body')
  return lines
}

// Which buttons a plan allows, in the order they are drawn from the right.
export interface PlanButton {
  id: 'close' | 'refresh' | 'apply' | 'retry'
  label: string
  tone: Tone
}

export function planButtons(plan: CompletionPlan | undefined, phase: PlanPhase | 'loading' | 'unreadable'): PlanButton[] {
  const buttons: PlanButton[] = [{ id: 'close', label: 'close panel', tone: 'muted' }]
  if (phase === 'preview' || phase === 'done' || phase === 'unreadable') {
    buttons.push({ id: 'refresh', label: 'refresh', tone: 'muted' })
  }
  if (plan && phase === 'preview' && plan.scope.closable && plan.counts.ready > 0 && plan.status.zulip_write) {
    buttons.push({ id: 'apply', label: `close ${plan.counts.ready} target${plan.counts.ready > 1 ? 's' : ''}`, tone: 'ready' })
  }
  if (plan && phase === 'done' && plan.partial && plan.counts.ready > 0) {
    buttons.push({ id: 'retry', label: 'try the rest again', tone: 'warn' })
  }
  return buttons
}
