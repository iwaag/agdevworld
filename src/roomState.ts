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

import { relayCompletion, relayCompletionAt, type CompletionPlan } from './completionState'

const BASE = (import.meta.env.VITE_AGENTROOM_URL as string | undefined) ?? 'http://localhost:8094'

// `project` is the Project Room (`project_room` p1): it stands in a room of
// its own but is not one of the two adapter-driven dialogue rooms below.
export type RoomId = 'front' | 'argue' | 'project'

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

// What a post says it is for (`ag.post.v1`, pyagag `agag.post`), as the
// relay read it from the post itself. Null is an unclassified post — never
// "waiting for somebody". `error` is a line that was there and unusable.
export type PostIntent = 'progress' | 'report' | 'response_request'

export interface PostMeaning {
  intent?: PostIntent
  to?: number
  ask?: 'question' | 'confirmation'
  re?: number[]
  // `none`: the post says it answers no request (`ag-post answer=none`).
  answer?: 'none'
  seen?: number
  error?: string
}

// The composer's choice of what the next post answers (`clearer_chat_ui`
// ex1). Three choices, never one overloaded null: `auto` leaves it to the
// relay's next-post rule (which settles a single pending request only);
// `answer` names the request (`re=`); `none` says it answers nothing
// (`answer=none`), so an aside never clears a question.
export type Correlation = { kind: 'auto' } | { kind: 'answer'; id: number } | { kind: 'none' }

export const AUTO: Correlation = { kind: 'auto' }

// The relay's request body for a choice.
export function correlationBody(choice: Correlation | undefined): Record<string, unknown> {
  if (choice?.kind === 'answer') return { answers: [choice.id] }
  if (choice?.kind === 'none') return { not_answer: true }
  return {}
}

// One response request and where it stands now (`ag.outstanding.v1`,
// pyagag `agag.outstanding`). The post keeps its intent forever; `state`
// is derived from what came after it.
export type RequestState = 'pending' | 'overtaken' | 'answered' | 'withdrawn' | 'superseded' | 'closed'

export interface RequestRow {
  id: number
  sender_id: number
  sender_name: string
  to: number
  to_name: string
  ask: 'question' | 'confirmation' | null
  text: string
  timestamp: number
  state: RequestState
  settled_by: number | null
  how: 'reference' | 'quote' | 'next_post' | null
  certain: boolean
  overtaken_by: number[]
}

export interface RoomRequests {
  requests: RequestRow[]
  pending: number[]
  // A reply by a request's recipient that named nothing while several of
  // theirs were pending: `{reply id: [request ids]}`.
  unmatched: Record<string, number[]>
  uncertain: string[]
  closed: boolean
}

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
  meaning?: PostMeaning | null
}

export type RoomState = 'waiting' | 'received' | 'answered' | 'asking' | 'done' | 'quiet' | 'unknown'

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
  // How many requests are pending in it; null when the relay holds only its name.
  asking?: number | null
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
  // What is still being asked (null when the relay could not read the posts),
  // and who this screen posts as, so a request to them reads "for you".
  requests?: RoomRequests | null
  viewer_id?: number | null
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
  // `correlation`: what this post answers, written into the post by the
  // relay — exactly the named request, or none at all.
  send: (key: string, text: string, token: string, correlation?: Correlation) => Promise<SendResult>
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
  asking?: number | null
}

interface ArgueDetail {
  health: { state: string; reason: string }
  chat: { configured: boolean; reason: string | null; max_chars?: number }
  argue: ArgueRow & {
    posts: (RoomPost & { logical?: string | null })[]; zulip_url: string | null; presentation: Presentation
    requests?: RoomRequests | null; viewer_id?: number | null
  }
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
    return found.argues.map((row) => ({ key: String(row.anchor), label: row.stem, resolved: row.resolved, last_post: row.last_post, asking: row.asking ?? null }))
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
        presentation: argue.presentation, requests: argue.requests ?? null, viewer_id: argue.viewer_id ?? null,
      },
    }
  },
  send: (key, text, token, correlation) => writeRelay(`/argues/${encodeURIComponent(key)}/post`, { text, token, ...correlationBody(correlation) }),
  create: (text, token) => writeRelay('/argues', { text, token }),
  render: (key, revision, token) => writeRelay(`/argues/${encodeURIComponent(key)}/render`, { revision, token }),
  // Finishing from the room (`argue` p2 ex1): the shared completion door,
  // reached by anchor so the relay names the argue's current topic. The
  // plan is the discussion only — what it ended in stays open — and a
  // human close writes no outcome: a ✔ without an outcome note means
  // "ended by the human".
  completion: {
    closePlan: (key) => relayCompletionAt.plan(`/argues/${encodeURIComponent(key)}/close-plan`),
    close: (key, fingerprint) => relayCompletionAt.apply(`/argues/${encodeURIComponent(key)}/close`, fingerprint),
  },
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
  asking?: number | null
}

interface DeskDetailPayload {
  health: { state: string; reason: string }
  chat: { configured: boolean; reason: string | null; max_chars?: number }
  conversation: {
    id: string; topic: string; live_topic: string; resolved: boolean; known: 'held' | 'read' | 'unknown'
    history: { posts: number; bounded: boolean; note: string }
    posts: { message_id: number; at: number; by: string; sender_id: number; content: string; kind: 'developer' | 'agent' | 'ack' | 'other'; meaning?: PostMeaning | null }[]
    status: RoomStatus; zulip_url: string | null; presentation: Presentation | null
    requests?: RoomRequests | null; viewer_id?: number | null
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
    return found.conversations.map((row) => ({ key: row.id, label: row.id, resolved: row.resolved, last_post: row.last_post, asking: row.asking ?? null }))
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
        requests: c.requests ?? null, viewer_id: c.viewer_id ?? null,
        // The desk's relay words: the Developer is the human, Front is the agent.
        posts: c.posts.map((post) => ({
          ...post, kind: post.kind === 'developer' ? 'human' as const : post.kind,
          agent: post.kind === 'agent' || post.kind === 'ack' ? 'front' : null, speaker: post.by,
        })),
      },
    }
  },
  send: (key, text, token, correlation) => writeRelay(`/frontdesk/${encodeURIComponent(key)}/post`, { text, token, ...correlationBody(correlation) }),
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
