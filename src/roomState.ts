// A room: one screen for talking in a conversation and reading it back.
//
// Since `argue` p2 there are two of them on one scene — the Front Desk
// (`#front` › `front-desk-<id>`) and the Arguing Room (`#argue` ›
// `argue-<stem>`) — and they differ only in what this file names: which
// conversations the room lists, how one is opened, where a post goes, and
// which background it stands in. Everything else is shared: the portraits,
// the dialogue playback, the history, the composer, the settings.
//
// The discussion itself is plain. What the screen plays as character
// dialogue is Front's re-voicing, saved afterwards in a memo topic nobody
// reacts to; the relay relates the two as `presentation` (the same block for
// both rooms). A post always goes into the **source** conversation, whichever
// view is showing.

import { relayCompletion, type CompletionPlan } from './completionState'

const BASE = (import.meta.env.VITE_AGENTROOM_URL as string | undefined) ?? 'http://localhost:8094'

export type RoomId = 'front' | 'argue'

export interface Citation {
  channel: string
  topic: string
  message_id: number | null
}

// One line of a saved interpretation. `character` is an id of the settings
// revision the interpretation names; a `plain` turn is a speaker who has no
// character there, and the post is shown as written under `speaker`.
export interface RenderedTurn {
  character: string | null
  speaker?: string
  text?: string
  plain?: boolean
  sources: Citation[]
}

export interface Rendering {
  settings_revision: string
  renderer: string
  job: string
  stale: boolean
  missing_sources: number[]
  turns: RenderedTurn[]
  memo_message_ids: number[]
  at: number
}

export interface Interpretation {
  settings_revision: string
  renderer: string
  results: number
  posts: number
  stale: number
  newest_at: number
}

export interface Presentation {
  anchor: number
  memo: { channel: string; topic: string } | null
  active_revision: string | null
  interpretations: Interpretation[]
  renderings: Record<string, Rendering[]>
  pending: { message_id: number; age_seconds: number; overdue: boolean }[]
  failed: { job: string; messages: number[]; settings_revision: string; error: string; attempts: number; at: number }[]
  refused: { request: number; settings_revision: string; error: string; at: number }[]
  requests: { message_id: number; settings_revision: string; at: number }[]
  renderer: { state: 'idle' | 'rendering' | 'unavailable' | 'unknown'; reason: string }
}

export type RoomPostKind = 'human' | 'agent' | 'ack' | 'other'

export interface RoomPost {
  message_id: number
  at: number
  by: string
  sender_id: number
  content: string
  kind: RoomPostKind
  // The roster agent name behind the account (`front`, `autolab`,
  // `archsage`…) and the speaker label — a logical one such as `sage:arxiv`
  // for a post under that header.
  agent: string | null
  speaker: string
}

export type RoomState = 'waiting' | 'received' | 'answered' | 'done' | 'quiet' | 'unknown'

export interface RoomStatus {
  state: RoomState
  since: number | null
  evidence: string
}

export interface RoomRow {
  key: string
  label: string
  resolved: boolean
  last_post: { at: number; by: string } | null
}

export interface RoomConversation {
  key: string
  channel: string
  topic: string
  live_topic: string
  resolved: boolean
  known: 'held' | 'read' | 'unknown'
  bounded: boolean
  posts: RoomPost[]
  status: RoomStatus
  zulip_url: string | null
  presentation: Presentation | null
}

export interface RoomDetail {
  health: { state: string; reason: string }
  chat: { configured: boolean; reason: string | null; max_chars?: number }
  conversation: RoomConversation
}

export interface SendResult {
  sent: boolean
  message_id?: number
  // A new conversation's key, when the write opened one.
  key?: string
  resumed?: boolean
  duplicate?: boolean
  uncertain?: boolean
  error?: string
  note?: string
}

export interface RoomCompletion {
  closePlan: (key: string) => Promise<CompletionPlan | { error: string }>
  close: (key: string, fingerprint: string) => Promise<CompletionPlan | { error: string }>
}

export interface RoomAdapter {
  room: RoomId
  title: string
  // The URL parameter naming the open conversation.
  param: string
  // Where the other room is.
  other: { label: string; href: string }
  // A conversation that does not exist yet: the desk mints an id and the
  // first post creates the topic; an argue is opened by `create`.
  newKey: () => string | null
  list: () => Promise<RoomRow[] | { error: string }>
  detail: (key: string) => Promise<RoomDetail | { error: string }>
  send: (key: string, text: string, token: string) => Promise<SendResult>
  create?: (text: string, token: string) => Promise<SendResult>
  render: (key: string, revision: string | null, token: string) => Promise<SendResult>
  completion?: RoomCompletion
  words: { newButton: string; empty: string; prompt: string; resumed: string; done: string }
}

export function submitToken(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export async function readRelay<T>(path: string): Promise<T | { error: string }> {
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

export async function writeRelay(path: string, body: Record<string, unknown>): Promise<SendResult> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    // No answer at all. A timeout is the uncertain case: the post may have
    // left the relay and landed, and a second one would start a second run.
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    return {
      sent: false, uncertain: timedOut,
      error: timedOut ? 'the relay did not answer in time; the post may have landed' : `the agentroom relay is not answering on ${BASE}`,
    }
  }
  const payload = (await response.json().catch(() => undefined)) as (SendResult & { anchor?: number }) | undefined
  if (!response.ok || !payload?.sent) {
    return {
      sent: false, uncertain: Boolean(payload?.uncertain), duplicate: Boolean(payload?.duplicate),
      error: payload?.error ?? `agentroom answered ${response.status}`, note: payload?.note,
    }
  }
  return { ...payload, key: payload.anchor !== undefined ? String(payload.anchor) : undefined }
}

// --- the Arguing Room ---------------------------------------------------------

interface ArgueRow {
  anchor: number
  topic: string
  stem: string
  live_topic: string
  channel: string
  resolved: boolean
  last_post: { at: number; by: string } | null
  status: RoomStatus
}

interface ArgueDetail {
  health: { state: string; reason: string }
  chat: { configured: boolean; reason: string | null; max_chars?: number }
  argue: ArgueRow & { posts: (RoomPost & { logical?: string | null })[]; zulip_url: string | null; presentation: Presentation }
}

export const ANCHOR_PATTERN = /^[0-9]{1,12}$/

export const argueAdapter: RoomAdapter = {
  room: 'argue',
  title: 'ARGUING ROOM',
  param: 'argue',
  other: { label: 'Front Desk ↗', href: '/?view=frontdesk' },
  newKey: () => null,
  async list() {
    const found = await readRelay<{ argues: ArgueRow[] }>('/argues')
    if ('error' in found) return found
    return found.argues.map((row) => ({ key: String(row.anchor), label: row.stem, resolved: row.resolved, last_post: row.last_post }))
  },
  async detail(key) {
    const found = await readRelay<ArgueDetail>(`/argues/${encodeURIComponent(key)}`)
    if ('error' in found) return found
    const argue = found.argue
    return {
      health: found.health, chat: found.chat,
      conversation: {
        key, channel: argue.channel, topic: argue.topic, live_topic: argue.live_topic, resolved: argue.resolved,
        known: 'held', bounded: false, posts: argue.posts, status: argue.status, zulip_url: argue.zulip_url,
        presentation: argue.presentation,
      },
    }
  },
  send: (key, text, token) => writeRelay(`/argues/${encodeURIComponent(key)}/post`, { text, token }),
  create: (text, token) => writeRelay('/argues', { text, token }),
  render: (key, revision, token) => writeRelay(`/argues/${encodeURIComponent(key)}/render`, { revision, token }),
  words: {
    newButton: 'new argue',
    empty: 'A new argue. State what you want in the bar below — however vague — and Front opens the discussion with every agent. Every post is kept in the history panel.',
    prompt: 'Say something in this argue…',
    resumed: '↩ resumed this discussion — what it ended in stays as it is',
    done: '✔ resolved — posting here resumes the discussion, not what it ended in',
  },
}

// --- the Front Desk ---------------------------------------------------------------

interface DeskRow {
  id: string
  resolved: boolean
  last_post: { at: number; by: string } | null
}

interface DeskDetailPayload {
  health: { state: string; reason: string }
  chat: { configured: boolean; reason: string | null; max_chars?: number }
  conversation: {
    id: string; topic: string; live_topic: string; resolved: boolean; known: 'held' | 'read' | 'unknown'
    history: { posts: number; bounded: boolean; note: string }
    posts: { message_id: number; at: number; by: string; sender_id: number; content: string; kind: 'developer' | 'agent' | 'ack' | 'other' }[]
    status: RoomStatus; zulip_url: string | null; presentation: Presentation | null
  }
}

export const DESK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/

export function newConversationId(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
}

export const deskAdapter: RoomAdapter = {
  room: 'front',
  title: 'FRONT DESK',
  param: 'conv',
  other: { label: 'Arguing Room ↗', href: '/?view=argue' },
  newKey: () => newConversationId(),
  async list() {
    const found = await readRelay<{ conversations: DeskRow[] }>('/frontdesk')
    if ('error' in found) return found
    return found.conversations.map((row) => ({ key: row.id, label: row.id, resolved: row.resolved, last_post: row.last_post }))
  },
  async detail(key) {
    const found = await readRelay<DeskDetailPayload>(`/frontdesk/${encodeURIComponent(key)}`)
    if ('error' in found) return found
    const c = found.conversation
    return {
      health: found.health, chat: found.chat,
      conversation: {
        key, channel: 'front', topic: c.topic, live_topic: c.live_topic, resolved: c.resolved, known: c.known,
        bounded: c.history.bounded, status: c.status, zulip_url: c.zulip_url, presentation: c.presentation,
        // The desk's relay words: the Developer is the human, Front is the agent.
        posts: c.posts.map((post) => ({
          ...post, kind: post.kind === 'developer' ? 'human' as const : post.kind,
          agent: post.kind === 'agent' || post.kind === 'ack' ? 'front' : null, speaker: post.by,
        })),
      },
    }
  },
  send: (key, text, token) => writeRelay(`/frontdesk/${encodeURIComponent(key)}/post`, { text, token }),
  render: (key, revision, token) => writeRelay(`/frontdesk/${encodeURIComponent(key)}/render`, { revision, token }),
  completion: {
    closePlan: (key) => relayCompletion.plan({ channel: 'front', topic: `front-desk-${key}` }),
    close: (key, fingerprint) => relayCompletion.apply({ channel: 'front', topic: `front-desk-${key}` }, fingerprint),
  },
  words: {
    newButton: 'new conversation',
    empty: 'A new conversation. Say something in the bar below — Front answers here, and every post is kept in the history panel.',
    prompt: 'Say something to Front…',
    resumed: '↩ reopened this conversation — the work it closed stays closed',
    done: '✔ resolved — posting here reopens the conversation, not the work it closed',
  },
}

export function ago(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'unknown age'
  if (seconds < 90) return `${Math.round(seconds)}s`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`
  return `${(seconds / 86400).toFixed(1)} d`
}

export function clock(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}
