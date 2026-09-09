// The routine board's read, and the two places this application writes.
//
// Since `refine_routine` p1 a routine is a guide kept in Zulip (one channel
// per routine, its `guide` topic: the newest post is the whole guide) and
// the runs made of it (`routinerun-<id>` topics in the same channel, opened
// and owned by Front). Three payloads, from the same `agentroom` relay the
// operation room uses:
//
// - `/routines` — every routine channel, its guide, its latest run.
// - `/routines/<name>` — the last three runs: opening post, origin, entries,
//   finish, resolution, the run topic as a chat log, and the tree of the
//   conversations the run opened.
// - `/inflight/<name>` — the **only** signal here that is not Zulip: the host's
//   own `.local/topics` and `.local/agent` directories, which is why it is the
//   only one this view polls.
//
// As in `opsState.ts`, nothing is interpreted here. Every state word and every
// sentence of provenance is decided by the relay; a second copy of the rules in
// the browser would drift from it.

const BASE = (import.meta.env.VITE_AGENTROOM_URL as string | undefined) ?? 'http://localhost:8094'

// A run's own vocabulary (relay `routines.run_state`), plus the ops board's
// words for a run somebody else posted into, plus the row-only `idle` and
// `retired`.
export type RunState = 'unstarted' | 'acked' | 'waiting' | 'awaiting' | 'stalled' | 'finished' | 'unknown'
export type RoutineState = RunState | 'idle' | 'retired'

export interface RoutinePost {
  message_id: number
  at: number
  by: string
  sender_id: number
}

// How a routine is shown. Routing stays keyed by `name`; the relay reads an
// optional `display:` line or a heading out of the guide and otherwise falls
// back to the name, with an icon assigned by the name.
export interface RoutineDisplay {
  icon: string
  icon_source: 'metadata' | 'heading' | 'assigned'
  title: string
  title_source: 'metadata' | 'heading' | 'name'
}

// Where a run was requested from: Front's root note in the run topic names
// the conversation that opened it. Absent for a run opened by hand.
export interface RunOrigin {
  channel: string
  topic: string
  by: string
  by_id: number
  message_id: number
}

// How a run ended, from its `ag-routinerun` finish block. `achieved` is the
// routine's goal, `reason` is why the run ends — two different sentences.
export interface RunFinish {
  achieved: boolean
  reason: string
  message_id: number
  at: number
}

export interface RunStatus {
  state: RunState
  evidence: string
  age_seconds: number | null
}

export interface RunSummary {
  channel: string
  topic: string
  opened: (RoutinePost & { text: string }) | null
  origin: RunOrigin | null
  finish: RunFinish | null
  resolution: SessionResolution
  run: RunStatus
  posts: number
}

export interface RoutineRow {
  name: string
  channel: string
  display?: RoutineDisplay
  retired: boolean
  // The guide: the newest post of the `guide` topic, whole.
  guide: (RoutinePost & { text: string; posts: number; authors: string[] }) | null
  guide_topic: string | null
  runs: number
  open_runs: number
  latest: RunSummary | null
  latest_topic: string | null
  state: RoutineState
  stale_state?: RoutineState
}

export interface SessionNode {
  channel: string
  topic: string
  depth: number
  parent: { channel: string; topic: string }
  via: 'served' | 'rootchat'
  link_id: number
  by: string | null
  known: 'swept' | 'note-only'
  resolved: boolean | null
  state: 'stalled' | 'awaiting' | 'acked' | 'done' | 'unknown' | 'quiet'
  last_post: RoutinePost | null
  rows: Array<{ instance: string; state: string; provenance?: { short?: string } }>
}

// A run is resolved (✔) by Front's listener when it finishes, or by a human.
export interface SessionResolution {
  state: 'resolved' | 'open'
  evidence: string
}

// A session is a run topic, `#routine-<name>` › `routinerun-<id>`.
export interface RoutineSession {
  id: number | null
  index: number
  channel: string
  topic: string
  // The opening post: the request as it was made, the conditions as Front
  // read them, the guide post it read, where the request came from.
  opened: (RoutinePost & { text: string }) | null
  origin: RunOrigin | null
  entries: number
  last_entry: (RoutinePost & { excerpt: string }) | null
  finish: (RunFinish & { report: string }) | null
  resolution: SessionResolution
  run: RunStatus
  history: { posts: number; post_limit: number; bounded: boolean; note: string }
  chat: Array<RoutinePost & { content: string }>
  nodes: SessionNode[]
  truncation?: { truncated: boolean; reasons: string[]; max_nodes: number; max_depth: number }
}

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
  entrance?: string
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
  routines: RoutineRow[]
  chat: ChatStatus
}

export interface RoutineDetail extends Omit<RoutineBoard, 'routines'> {
  routine: RoutineRow
  sessions: RoutineSession[]
  latest_topic?: string | null
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
  session: { channel: string; topic: string; opened: (RoutinePost & { text: string }) | null; nodes: number } | null
  topics: InflightTopic[]
  agents: Array<{
    instance: string
    known: boolean
    in_flight: boolean | null
    where?: string | null
    reason: string
  }>
}

export function unreadableRoutines(reason: string): RoutineBoard {
  return {
    schema: 'ag.routines.v2',
    generated_at: Date.now() / 1000,
    settings: { stalled_seconds: 0 },
    health: {
      state: 'unknown', reason, sweeps: 0, sweep_calls: 0, channels: 0, topics: 0,
      last_event_at: null,
    },
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
  const query = options.includeResolved === false ? '?resolved=hide' : ''
  return read<RoutineDetail>(`/routines/${encodeURIComponent(name)}${query}`)
}

export async function loadInflight(name: string): Promise<InflightBoard | { error: string }> {
  return read<InflightBoard>(`/inflight/${encodeURIComponent(name)}`)
}

// The write into a routine's own conversation: its `guide` topic (a new
// version) or one of its runs (a word to Front in a topic it owns, which
// buys a paid Front run). Every rule about where it may land is enforced by
// the relay.
export async function sendChat(
  channel: string,
  topic: string,
  text: string,
): Promise<{ sent: boolean; message_id?: number; error?: string }> {
  let response: Response
  try {
    response = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, topic, text }),
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

// The other write: ask Front to run a routine. The relay posts the request
// as the Developer at Front's ordinary entrance — a Front Desk conversation
// of its own — and Front reads the guide and opens the run. One paid Front
// run, deliberately. `uncertain` is the relay saying the post may have landed
// although it could not confirm it; the view reports that and never reposts.
export interface RunRequestResult {
  sent: boolean
  uncertain: boolean
  message_id?: number
  channel?: string
  topic?: string
  desk?: string
  error?: string
  note?: string
}

export async function requestRun(name: string, instruction: string): Promise<RunRequestResult> {
  let response: Response
  try {
    response = await fetch(`${BASE}/routines/${encodeURIComponent(name)}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction }),
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    return {
      sent: false, uncertain: timedOut,
      error: timedOut ? 'the relay did not answer in time' : `the agentroom relay is not answering on ${BASE}`,
    }
  }
  const payload = (await response.json().catch(() => undefined)) as RunRequestResult | undefined
  if (!response.ok || !payload?.sent) {
    return {
      sent: false, uncertain: Boolean(payload?.uncertain),
      error: payload?.error ?? `agentroom answered ${response.status}`, note: payload?.note,
    }
  }
  return { ...payload, sent: true, uncertain: false }
}

export function routineHeadline(board: Pick<RoutineBoard, 'health' | 'chat'>): string {
  if (board.health.state !== 'live') {
    return `⚠ UNKNOWN — ${board.health.reason}. Every row below is the last thing known, not the state now.`
  }
  const chat = board.chat.configured ? 'chat can post as the Developer' : 'chat read-only'
  return `event queue live · guides and runs read from the routine channels · ${chat}`
}

// One line about a run, from the relay's own evidence.
export function runLine(summary: RunSummary | RoutineSession | null | undefined, now: number): string {
  if (!summary) return 'no run yet'
  const status = summary.run
  const opened = summary.opened ? `opened ${ago(now - summary.opened.at)} ago` : 'opening post not held'
  if (status.state === 'finished') {
    const finish = summary.finish
    return finish
      ? `${opened} · finished — ${finish.achieved ? 'goal reached' : 'goal not reached'}: ${finish.reason}`
      : `${opened} · finished — ✔ on the run topic, no finish block`
  }
  return `${opened} · ${status.state} — ${status.evidence}`
}

// The card's second line.
export function routineDetail(row: RoutineRow, now: number): string {
  if (row.retired) return 'retired — its guide carries ✔'
  if (!row.guide) return 'no guide posted yet'
  return runLine(row.latest, now)
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
