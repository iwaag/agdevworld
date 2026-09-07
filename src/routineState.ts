// The routine board's read, and the one place this application writes.
//
// Three payloads, from the same `agentroom` relay the operation room uses:
//
// - `/routines` — every routine, its standing request, its schedule, and
//   whether its last fire was answered.
// - `/routines/<name>` — the last three runs as session trees, plus the fire
//   topic as a chat log.
// - `/inflight/<name>` — the **only** signal here that is not Zulip: the host's
//   own `.local/topics` and `.local/agent` directories, which is why it is the
//   only one this view polls. The realm side is already live on the relay's
//   event queue, and polling Zulip harder would spend the agents' own quota to
//   learn nothing (`operation_room` p1 measured a 429 for it).
//
// As in `opsState.ts`, nothing is interpreted here. Every state word and every
// sentence of provenance is decided by the relay; a second copy of the rules in
// the browser would drift from it.

const BASE = (import.meta.env.VITE_AGENTROOM_URL as string | undefined) ?? 'http://localhost:8094'

export type RoutineState = 'stalled' | 'awaiting' | 'acked' | 'done' | 'unknown'

export interface RoutinePost {
  message_id: number
  at: number
  by: string
  sender_id: number
}

export interface RoutineAnswer {
  // `acked` is its own state because Front acks everything it is served: a
  // board that read the ack as a reply would call every routine answered a
  // second after it fired.
  state: 'answered' | 'acked' | 'unanswered' | 'no fire'
  age_seconds: number | null
  answered_after?: number
  answer: (RoutinePost & { excerpt: string }) | null
  ack: RoutinePost | null
}

export interface RoutineSchedule {
  events: number
  next: { id: string; at: number | null; fired_at: number | null; from: string } | null
  last: { id: string; at: number | null; fired_at: number | null; from: string } | null
  // Due, unfired, and in the past. The dispatcher runs every five minutes, so
  // one of these is a signal and not a rounding error.
  overdue: Array<{ id: string; at: number | null; from: string }>
}

// How a routine is shown. Routing stays keyed by `name`; the relay reads an
// optional `display:` line or a heading out of the standing request and
// otherwise falls back to the name, with an icon assigned by the name so a
// new routine is recognisable without anybody adding a mapping.
export interface RoutineDisplay {
  icon: string
  icon_source: 'metadata' | 'heading' | 'assigned'
  title: string
  title_source: 'metadata' | 'heading' | 'name'
}

export interface RoutineRow {
  name: string
  display?: RoutineDisplay
  retired: boolean
  request: (RoutinePost & { text: string }) | null
  request_topic: string | null
  // The newest run topic (`front-routine-<name>-<stamp>`), where a
  // continuation goes and what the next fire names as `Previous run:`.
  latest_topic: string | null
  runs: number
  open_runs: number
  // Posts in the standing-request topic by anybody but its author — the
  // evidence that an agent answered in the wrong topic.
  request_strays: RoutinePost[]
  posts: number
  last_fire: (RoutinePost & { text: string }) | null
  answer: RoutineAnswer
  state: RoutineState
  stale_state?: RoutineState
  schedule: RoutineSchedule
}

export interface SessionNode {
  channel: string
  topic: string
  depth: number
  parent: { channel: string; topic: string }
  // Which selfnote named this conversation. Never rendered as content — this
  // is the link, which is the only thing selfnotes are read for.
  via: 'served' | 'rootchat'
  link_id: number
  by: string | null
  // `note-only` is a topic the relay has never read: a resolved topic is never
  // swept, and saying so is the difference between "quiet" and "not looked at".
  known: 'swept' | 'note-only'
  resolved: boolean | null
  state: RoutineState | 'quiet'
  last_post: RoutinePost | null
  rows: Array<{ instance: string; state: string; provenance?: { short?: string } }>
}

// One session is finished when a human said so with Zulip's ✔ on the run's
// own topic — a different sentence from `done`, which only means the fire got
// an answer. One topic per run (operation_room p7) is what makes the flag the
// whole answer: there is no `unknown` any more.
export interface SessionResolution {
  state: 'resolved' | 'open'
  evidence: string
}

// A session is a run topic, `#front` › `front-routine-<name>-<stamp>`.
export interface RoutineSession {
  // The fire's message id, or the first held post's when the topic was
  // opened by hand; null only when nothing of the topic is held.
  id: number | null
  index: number
  topic: string
  stamp: string | null
  fire: (RoutinePost & { text: string }) | null
  origin: 'manual' | 'scheduled' | 'unknown'
  origin_evidence: string
  schedule_event: { id: string; fired_at: number } | null
  // The run topic this fire's `Previous run:` names, if it names one.
  previous: string | null
  answer: RoutineAnswer
  resolution: SessionResolution
  // The run topic is held as a window of posts; a full window is disclosed
  // rather than read as the whole run.
  history: { posts: number; post_limit: number; bounded: boolean; note: string }
  // The run topic, whole: real posts, oldest first.
  chat: Array<RoutinePost & { content: string }>
  nodes: SessionNode[]
  truncation?: { truncated: boolean; reasons: string[]; max_nodes: number; max_depth: number }
}

// How far back the session list could look: the relay reads the newest
// `deep_runs` run topics of a routine even under ✔ and older ones only while
// open, so a resolved run older than that is in Zulip and not here.
export interface SessionHistory {
  runs: number
  open_runs: number
  session_limit: number
  deep_runs: number
  hidden_resolved: number
  note: string
}

export interface ChatStatus {
  configured: boolean
  reason: string | null
  max_chars?: number
  realm_max_chars?: number
  channel?: string
}

export interface RoutineBoard {
  schema: string
  generated_at: number
  settings: { stalled_seconds: number }
  health: {
    state: 'live' | 'unknown'
    reason: string
    sweeps: number
    sweep_calls: number
    channels: number
    topics: number
    last_event_at: number | null
  }
  schedule: { configured: boolean; ok: boolean; error: string | null; events: number }
  routines: RoutineRow[]
  chat: ChatStatus
}

export interface RoutineDetail extends Omit<RoutineBoard, 'routines'> {
  routine: RoutineRow
  sessions: RoutineSession[]
  // The routine's actual newest run and its fire, whatever a filter left
  // visible. Each session carries its own `chat`; the top-level `chat` is
  // the relay's chat *status*, added by the server.
  latest_topic?: string | null
  latest_fire?: (RoutinePost & { text: string }) | null
  history?: SessionHistory
  filter?: { include_resolved: boolean }
}

export interface InflightTopic {
  instance: string
  channel: string
  topic: string
  known: boolean
  in_flight: boolean | null
  generation?: number | null
  reason: string
}

export interface InflightBoard {
  schema: string
  generated_at: number
  routine: string
  configured: boolean
  session: { fire: RoutinePost | null; nodes: number } | null
  topics: InflightTopic[]
  agents: Array<{
    instance: string
    known: boolean
    in_flight: boolean | null
    where?: string | null
    reason: string
  }>
}

// A board the view can render when the relay is not there. The alternative is
// an exception that empties the grid, and an empty grid is the one thing this
// screen must never show for a reason it has not named.
export function unreadableRoutines(reason: string): RoutineBoard {
  return {
    schema: 'ag.routines.v1',
    generated_at: Date.now() / 1000,
    settings: { stalled_seconds: 0 },
    health: {
      state: 'unknown', reason, sweeps: 0, sweep_calls: 0, channels: 0, topics: 0,
      last_event_at: null,
    },
    schedule: { configured: false, ok: false, error: reason, events: 0 },
    routines: [],
    chat: { configured: false, reason },
  }
}

async function read<T>(path: string): Promise<T | { error: string }> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(8000) })
  } catch {
    return { error: `the agentroom relay is not answering on ${BASE}` }
  }
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) {
    const detail = (payload as { error?: string } | undefined)?.error
    return { error: detail ?? `agentroom answered ${response.status}` }
  }
  if (!payload || typeof payload !== 'object') return { error: 'agentroom returned an unreadable response' }
  return payload as T
}

export async function loadRoutines(): Promise<RoutineBoard> {
  const found = await read<RoutineBoard>('/routines')
  if ('error' in found) return unreadableRoutines(found.error)
  return found
}

export async function loadRoutine(
  name: string,
  options: { includeResolved?: boolean } = {},
): Promise<RoutineDetail | { error: string }> {
  // `resolved=hide` is filtered by the relay before its limit, so hiding
  // three finished runs shows the three before them rather than nothing.
  const query = options.includeResolved === false ? '?resolved=hide' : ''
  return read<RoutineDetail>(`/routines/${encodeURIComponent(name)}${query}`)
}

export async function loadInflight(name: string): Promise<InflightBoard | { error: string }> {
  return read<InflightBoard>(`/inflight/${encodeURIComponent(name)}`)
}

// The write. It buys a paid Front run, which is what a chat with an agent is;
// every rule about where it may land is enforced by the relay, and this
// function shows the refusal rather than deciding anything itself.
export async function sendChat(
  topic: string,
  text: string,
): Promise<{ sent: boolean; message_id?: number; error?: string }> {
  let response: Response
  try {
    response = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, text }),
    })
  } catch {
    return { sent: false, error: `the agentroom relay is not answering on ${BASE}` }
  }
  const payload = (await response.json().catch(() => undefined)) as
    | { sent?: boolean; message_id?: number; error?: string }
    | undefined
  if (!response.ok || !payload?.sent) {
    return { sent: false, error: payload?.error ?? `agentroom answered ${response.status}` }
  }
  return { sent: true, message_id: payload.message_id }
}

// The other write: start a new session of a routine. The relay composes the
// fire line the dispatcher would have posted, marked as started by hand, and
// posts it as the Developer — one paid Front run, deliberately. `uncertain`
// is the relay saying the post may have landed although it could not confirm
// it; the view reports that and never reposts on its own.
export async function startSession(
  name: string,
  instruction: string,
): Promise<{ sent: boolean; uncertain: boolean; message_id?: number; topic?: string; previous?: string | null; error?: string; note?: string }> {
  let response: Response
  try {
    response = await fetch(`${BASE}/routines/${encodeURIComponent(name)}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction }),
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    // No answer at all: the request may or may not have reached the relay.
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    return {
      sent: false, uncertain: timedOut,
      error: timedOut ? 'the relay did not answer in time' : `the agentroom relay is not answering on ${BASE}`,
    }
  }
  const payload = (await response.json().catch(() => undefined)) as
    | { sent?: boolean; uncertain?: boolean; message_id?: number; topic?: string; previous?: string | null; error?: string; note?: string }
    | undefined
  if (!response.ok || !payload?.sent) {
    return {
      sent: false, uncertain: Boolean(payload?.uncertain),
      error: payload?.error ?? `agentroom answered ${response.status}`, note: payload?.note,
    }
  }
  return { sent: true, uncertain: false, message_id: payload.message_id, topic: payload.topic, previous: payload.previous ?? null, note: payload.note }
}

export function routineHeadline(board: Pick<RoutineBoard, 'health' | 'schedule' | 'chat'>): string {
  if (board.health.state !== 'live') {
    return `⚠ UNKNOWN — ${board.health.reason}. Every row below is the last thing known, not the state now.`
  }
  const schedule = board.schedule.ok
    ? `schedule read (${board.schedule.events} events)`
    : `schedule unreadable — ${board.schedule.error}`
  const chat = board.chat.configured ? 'chat can post as the Developer' : 'chat read-only'
  return `event queue live · ${schedule} · ${chat}`
}

// The card's second line. Every routine's own evidence, at the length the
// panel's status line holds.
export function routineDetail(row: RoutineRow): string {
  const answer = row.answer
  if (answer.state === 'no fire') {
    return row.posts > 0
      ? `no dispatcher fire in ${row.posts} posts — every run started by hand`
      : 'no fire and no conversation'
  }
  const age = ago(answer.age_seconds)
  if (answer.state === 'answered') {
    return `fired ${age} ago · answered in ${ago(answer.answered_after ?? null)}`
  }
  if (answer.state === 'acked') return `fired ${age} ago · acked, no answer yet`
  return `fired ${age} ago · nothing has answered`
}

export function ago(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'unknown age'
  if (seconds < 90) return `${Math.round(seconds)}s`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`
  return `${(seconds / 86400).toFixed(1)} d`
}

export function at(timestamp: number | null | undefined): string {
  if (!timestamp) return '—'
  return new Date(timestamp * 1000).toLocaleString()
}
