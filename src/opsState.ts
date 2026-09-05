// The operation room's read: who owes a reply, and for how long.
//
// One fetch of `/ops` on the `agentroom` relay (`agentroom/README.md`). The
// relay holds the reconstruction and refreshes it from a Zulip event queue;
// this file does no interpretation of its own, deliberately — every state on
// that board is an inference from a trace somebody left for another purpose,
// and the relay is where the inference is made and explained. A second copy of
// the rules here would drift from it, which is exactly how `operation_room` p1
// produced 66 stalled rows for conversations that had been answered.

const BASE = (import.meta.env.VITE_AGENTROOM_URL as string | undefined) ?? 'http://localhost:8094'

// `unknown` is a first-class state, not a fallback. p9's 26 silent minutes
// looked exactly like an idle board, and a screen that paints unknown the
// colour of quiet cannot show the one failure it exists to catch.
export type OpsState = 'stalled' | 'awaiting' | 'acked' | 'done' | 'unknown'

export interface OpsProvenance {
  // A finished sentence, written by the relay. The view renders it and reads
  // nothing out of it.
  text: string
  // The same evidence at the length a card can hold. The panel's status line
  // wraps at about 28 characters and the sentence above runs to six lines —
  // measured in a screenshot, which is the only place a card's contract with
  // the eye is ever provable.
  short: string
  message_id?: number | null
  message_at?: number | null
  by?: string | null
  served_mark?: number | null
  route?: string | null
  resolved?: boolean
}

export interface OpsRow {
  instance: string
  bot: string | null
  channel: string | null
  topic: string | null
  live_topic: string | null
  state: OpsState
  route: string | null
  age_seconds: number | null
  // Present only while the relay cannot vouch for the row: what it last knew,
  // kept as evidence and never as the answer.
  stale_state?: OpsState
  provenance: OpsProvenance
}

export interface OpsInstance {
  instance: string
  roster: 'intro' | 'missing'
  state: 'ok' | 'unknown'
  bot: string | null
  bot_id: number | null
  // What the instance says its listener matches on — not a claim that such a
  // channel exists, which is what `channel_exists` answers separately.
  channel: string | null
  channel_exists: boolean | null
  prefixes: string[]
  served_marks: number
  counts: Record<OpsState, number>
  // done rows of this instance that have already been confirmed away. The
  // counts above no longer include them, so the card and the board agree.
  confirmed: number
}

export interface OpsHealth {
  state: 'live' | 'unknown'
  reason: string
  error: string | null
  queue: boolean
  last_event_at: number | null
  last_sweep_at: number | null
  sweeps: number
  sweep_calls: number
  channels: number
  topics: number
}

export interface OpsBoard {
  schema: string
  generated_at: number
  settings: { stalled_seconds: number }
  health: OpsHealth
  instances: OpsInstance[]
  rows: OpsRow[]
  errors: Array<{ channel: string; error: string }>
  // What the relay is holding back because somebody said they had seen it.
  confirmed: { rows: number; topics: number }
}

// A board the view can render when the relay itself cannot be reached. The
// alternative is an exception that empties the grid, and an empty grid is the
// one thing this screen must never show for a reason it has not named.
export function unreadableBoard(reason: string): OpsBoard {
  return {
    schema: 'ag.ops.v1',
    generated_at: Date.now() / 1000,
    settings: { stalled_seconds: 0 },
    health: {
      state: 'unknown',
      reason,
      error: reason,
      queue: false,
      last_event_at: null,
      last_sweep_at: null,
      sweeps: 0,
      sweep_calls: 0,
      channels: 0,
      topics: 0,
    },
    instances: [],
    rows: [],
    errors: [],
    confirmed: { rows: 0, topics: 0 },
  }
}

export async function loadOpsBoard(): Promise<OpsBoard> {
  let response: Response
  try {
    response = await fetch(`${BASE}/ops`)
  } catch {
    return unreadableBoard(`the agentroom relay is not answering on ${BASE}`)
  }
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) {
    const detail = (payload as { error?: string } | undefined)?.error
    return unreadableBoard(detail ?? `agentroom answered ${response.status}`)
  }
  return payload as OpsBoard
}

// The state a row is *wearing*, which is the one a human is deciding about.
// While the queue is dead every row reads `unknown` and keeps its last verdict
// in `stale_state`; the relay's `confirm` reads it the same way.
export function shownState(row: OpsRow): OpsState {
  return row.stale_state ?? row.state
}

// Dismiss the `done` rows: all of them, or one conversation.
//
// The relay is the one that decides what may be dismissed — only `done`, and
// it answers 409 for anything else. This function does not pre-filter and
// does not interpret the refusal beyond showing it: a screen that decided for
// itself which debts could be cleared would be a second opinion in front of
// the evidence, which is the mistake this whole view is built against.
export async function confirmDone(
  target?: { channel: string; topic: string },
): Promise<{ ok: boolean; confirmed: number; message: string }> {
  let response: Response
  try {
    response = await fetch(`${BASE}/ops/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target ?? { all: true }),
    })
  } catch {
    return { ok: false, confirmed: 0, message: `the agentroom relay is not answering on ${BASE}` }
  }
  const payload = (await response.json().catch(() => undefined)) as
    | { confirmed?: number; error?: string }
    | undefined
  if (!response.ok) {
    return {
      ok: false,
      confirmed: 0,
      message: payload?.error ?? `agentroom answered ${response.status}`,
    }
  }
  const confirmed = payload?.confirmed ?? 0
  return { ok: true, confirmed, message: `confirmed ${confirmed} done ${confirmed === 1 ? 'row' : 'rows'}` }
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

// The one line under the title. It names the relay's own condition first,
// because everything below it is only as true as the queue behind it.
export function healthLine(board: OpsBoard): string {
  const health = board.health
  if (health.state !== 'live') {
    return `⚠ UNKNOWN — ${health.reason}. Every row below is the last thing known, not the state now.`
  }
  const seen = health.last_event_at ? `last event ${at(health.last_event_at)}` : 'no event yet'
  return (
    `event queue live · ${seen} · swept ${health.topics} topics in ${health.channels} channels ` +
    `for ${health.sweep_calls} calls · stalled at ${Math.round(board.settings.stalled_seconds / 60)} min`
  )
}
