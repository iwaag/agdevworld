// A room: one screen for talking in a conversation and reading it back.
//
// Since `argue` p2 there are two of them on one scene — the Front Desk
// (a WFE conversation since project_migration p8; before, `#front` ›
// `front-desk-<id>`) and the Arguing Room (`#argue` › `argue-<stem>`) — and they differ only in what this file names: which
// conversations the room lists, how one is opened, where a post goes, and
// which background it stands in. Everything else is shared: the portraits,
// the dialogue playback, the history, the composer, the settings.
//
// The discussion itself is plain. What the screen plays as character
// dialogue is Front's re-voicing, saved afterwards in a memo topic nobody
// reacts to; the relay relates the two as `presentation`. The desk has no
// re-voicing since project_migration p8 (`presentation` is null). A post always goes into the **source** conversation, whichever
// view is showing.

import { relayCompletionAt, type CompletionPlan } from './completionState'
import { AGDEV_URL, AGENTROOM_URL } from './endpoints'

const BASE = AGENTROOM_URL

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
  // The run an agent message started or reports on, with its WFE run view
  // (project_migration p8): drawn as a small link, never folded into content.
  run?: { key: string; url: string; status?: RunStatusWords | null }
}

// A run's status in short, as WFE's shared reading gives it
// (workflow_editor shared/status.ts; project_migration p8 ex1).
export interface RunStatusWords { state: string; label: string; reason: string; text: string; tone: string }

export type RoomState = 'waiting' | 'received' | 'answered' | 'asking' | 'done' | 'quiet' | 'unknown'

export interface RoomStatus {
  state: RoomState
  since: number | null
  evidence: string
  // The conversation's unfinished work, each run with its short status (p8 ex1).
  work?: { key: string; url: string | null; status: RunStatusWords }[]
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
  // `as`: who a post goes in as, when the service names the person.
  chat: { configured: boolean; reason: string | null; max_chars?: number; as?: string }
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
  // `live`: the health line's word for a reachable backend (default `relay live`).
  words: { newButton: string; empty: string; prompt: string; resumed: string; done: string; live?: string }
}

// The chip a post's run is drawn as: small, after the post's own links.
export function runLink(run: { key: string; url: string; status?: RunStatusWords | null }): { label: string; url: string } {
  return { label: `work: ${run.key}${run.status ? ` — ${run.status.text}` : ''} ↗`, url: run.url }
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
//
// Since project_migration p8 the desk talks to WFE, not the agentroom relay:
// Front is a managed WFE project and the conversation lives there
// (`${AGDEV_URL}api/conversations…`). Nothing below names a Zulip id — the
// message ids are WFE's own, and the work an agent message started is
// linked by its run, not by a topic.

const WFE = AGDEV_URL

type WfeRole = 'person' | 'agent'
type WfeKind = 'message' | 'reply' | 'question' | 'progress' | 'result'

interface WfeLast { at: string; role: WfeRole; author: string; text: string }

interface WfeRow {
  id: string
  title: string
  created: string
  updated: string
  state: 'open' | 'closed'
  last: WfeLast | null
  asking: number
  active: number
}

interface WfeMessage {
  id: number
  role: WfeRole
  author: string
  text: string
  at: string
  // How a person's message came when not through the desk (slack_connect p1: `slack`).
  via?: string | null
  re: number[]
  kind: WfeKind
  run: string | null
  runUrl: string | null
  question: string | null
  dispatch: { state: 'pending' | 'started' | 'failed'; run: string | null; error: string | null } | null
}

interface WfeDetail {
  person: string
  conversation: { id: string; title: string; created: string; updated: string; state: 'open' | 'closed' }
  messages: WfeMessage[]
  links: { message: number; run: string; relation: string; note: string; by: string; at: string }[]
  runs: { key: string; workspace: string; workflow: string; run: string; situation: string; execution: string; url: string; relation: string; status?: RunStatusWords | null }[]
  asking: number[]
}

// The scene tells "for you" by a numeric viewer id; WFE names the person by
// a string. One conversation has one person, so the desk numbers the two
// sides itself (project_migration p8).
const PERSON_ID = 1
const AGENT_ID = 2

const epoch = (iso: string | null | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isFinite(ms) ? ms / 1000 : Date.now() / 1000
}

// A run URL WFE gives relative is relative to the WFE service.
const absolute = (url: string): string => {
  try { return new URL(url, WFE).href } catch { return url }
}

async function readWfe<T>(path: string): Promise<T | { error: string; status?: number }> {
  let response: Response
  try {
    response = await fetch(`${WFE}${path}`, { signal: AbortSignal.timeout(8000) })
  } catch {
    return { error: `WFE is not answering on ${WFE}` }
  }
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) {
    const detail = (payload as { error?: string } | undefined)?.error
    return { error: detail ?? `WFE answered ${response.status}`, status: response.status }
  }
  if (!payload || typeof payload !== 'object') return { error: 'WFE returned an unreadable response' }
  return payload as T
}

async function writeWfe<T>(path: string, body: Record<string, unknown>): Promise<{ ok: true; payload: T } | { ok: false; error: string; uncertain: boolean }> {
  let response: Response
  try {
    response = await fetch(`${WFE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    // As with the relay: a timeout is the uncertain case — the message may
    // have landed and started a run, and only the same token may retry it.
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    return { ok: false, uncertain: timedOut, error: timedOut ? 'WFE did not answer in time; the message may have landed' : `WFE is not answering on ${WFE}` }
  }
  const payload = (await response.json().catch(() => undefined)) as (T & { error?: string }) | undefined
  if (!response.ok || !payload || typeof payload !== 'object') {
    return { ok: false, uncertain: false, error: payload?.error ?? `WFE answered ${response.status}` }
  }
  return { ok: true, payload }
}

// What a WFE message says it is for, in the scene's post words.
function wfeMeaning(message: WfeMessage): PostMeaning | null {
  const re = message.re.length ? { re: message.re } : {}
  if (message.role === 'agent') {
    if (message.kind === 'question') return { intent: 'response_request', ask: 'question', to: PERSON_ID, ...re }
    if (message.kind === 'progress') return { intent: 'progress', ...re }
    if (message.kind === 'result') return { intent: 'report', ...re }
  }
  return message.re.length ? re : null
}

// The agent's questions and where they stand: pending while WFE lists them
// in `asking`, otherwise settled by the person's message that names them,
// or else by the person's next message; one WFE stopped asking with no
// reply is withdrawn (or closed, with the conversation).
function wfeRequests(found: WfeDetail): RoomRequests {
  const asking = new Set(found.asking)
  const rows: RequestRow[] = []
  found.messages.forEach((message, index) => {
    if (message.role !== 'agent' || message.kind !== 'question') return
    const later = found.messages.slice(index + 1).filter((one) => one.role === 'person')
    const named = later.find((one) => one.re.includes(message.id))
    const settled = asking.has(message.id) ? null : named ?? later[0] ?? null
    rows.push({
      id: message.id, sender_id: AGENT_ID, sender_name: message.author, to: PERSON_ID, to_name: found.person,
      ask: 'question', text: message.question ?? message.text, timestamp: epoch(message.at),
      state: asking.has(message.id) ? 'pending' : settled ? 'answered' : found.conversation.state === 'closed' ? 'closed' : 'withdrawn',
      settled_by: settled?.id ?? null, how: named ? 'reference' : settled ? 'next_post' : null, certain: Boolean(named),
      overtaken_by: [],
    })
  })
  return { requests: rows, pending: found.asking.filter((id) => rows.some((row) => row.id === id)), unmatched: {}, uncertain: [], closed: found.conversation.state === 'closed' }
}

// Where the conversation stands (project_migration p8): read from the
// messages WFE holds, the dispatch of the person's newest message included.
// The conversation's work that is not done, newest first, with its status.
function wfeWork(found: WfeDetail): RoomStatus['work'] {
  return found.runs.filter(r => r.status && !['done', 'cancelled'].includes(r.status.state))
    .sort((a, b) => b.run.localeCompare(a.run))
    .map(r => ({ key: r.key, url: r.url ? absolute(r.url) : null, status: r.status! }))
}

function wfeStatus(found: WfeDetail | null): RoomStatus {
  const status = wfeStatusOnly(found)
  const work = found ? wfeWork(found) : []
  return work?.length ? { ...status, work } : status
}

function wfeStatusOnly(found: WfeDetail | null): RoomStatus {
  const messages = found?.messages ?? []
  if (!found || messages.length === 0) return { state: 'quiet', since: null, evidence: 'nothing posted yet' }
  const last = messages[messages.length - 1]
  if (found.conversation.state === 'closed') return { state: 'done', since: epoch(found.conversation.updated), evidence: 'closed' }
  if (found.asking.length) {
    const asked = messages.find((one) => one.id === found.asking[0])
    return { state: 'asking', since: epoch(asked?.at ?? last.at), evidence: `${found.asking.length} question(s) open` }
  }
  if (last.role === 'person') {
    if (last.dispatch?.state === 'failed') return { state: 'unknown', since: epoch(last.at), evidence: `Front was not reached — ${last.dispatch.error ?? 'the dispatch failed'}` }
    if (last.dispatch?.state === 'started') return { state: 'received', since: epoch(last.at), evidence: 'dispatched to Front' }
    return { state: 'waiting', since: epoch(last.at), evidence: 'no reply yet' }
  }
  return { state: 'answered', since: epoch(last.at), evidence: 'Front replied' }
}

function wfeRunLink(message: WfeMessage, found: WfeDetail): RoomPost['run'] {
  const key = message.run ?? message.dispatch?.run ?? null
  if (!key) return undefined
  const run = found.runs.find((one) => one.key === key)
  const url = message.runUrl ?? run?.url ?? null
  return url ? { key, url: absolute(url), status: run?.status ?? null } : undefined
}

// Whether the desk last saw a conversation closed: a post to it reopens it
// (WFE does that), and the screen says so once.
const closedSeen = new Set<string>()

function deskDetail(key: string, found: WfeDetail | null): RoomDetail {
  const posts: RoomPost[] = (found?.messages ?? []).map((message) => ({
    message_id: message.id, at: epoch(message.at), by: message.author,
    sender_id: message.role === 'person' ? PERSON_ID : AGENT_ID,
    content: message.text,
    kind: message.role === 'person' ? 'human' : 'agent',
    agent: message.role === 'agent' ? 'front' : null,
    speaker: message.via ? `${message.author} (via ${message.via})` : message.author,
    meaning: wfeMeaning(message),
    run: found ? wfeRunLink(message, found) : undefined,
  }))
  const closed = found?.conversation.state === 'closed'
  return {
    health: { state: 'live', reason: '' },
    chat: { configured: true, reason: null, as: found?.person },
    conversation: {
      key, channel: 'front', topic: key, live_topic: found?.conversation.title || key, resolved: closed,
      known: 'held', bounded: false, posts, status: wfeStatus(found), zulip_url: null,
      // Re-voicing is retired (project_migration p8): posts are shown as written.
      presentation: null,
      requests: found ? wfeRequests(found) : { requests: [], pending: [], unmatched: {}, uncertain: [], closed: false },
      viewer_id: PERSON_ID,
    },
  }
}

// The close door (project_migration p8): WFE's close route ends the
// conversation and nothing else, so the plan the panel previews is one
// line — this conversation — and says that no run stops with it.
const STOPS_NOTHING = 'closing ends the conversation only — it stops no run; work it started keeps going and stays in its run view'

function deskPlan(key: string, state: 'open' | 'closed' | 'missing', updated: string | null, closed?: { note: string }): CompletionPlan {
  const root = { channel: 'front', topic: key }
  const action = {
    kind: 'conversation' as const, key: `conversation:${key}`, label: `Front Desk ${key}`,
    state: state === 'open' ? 'ready' as const : 'done' as const,
    reason: state === 'open' ? STOPS_NOTHING : 'already closed — posting here reopens it',
    detail: {},
  }
  const actions = state === 'missing' ? [] : [action]
  return {
    schema: 'ag.completion.v1', generated_at: Date.now() / 1000, channel: 'front', topic: key, root,
    scope: {
      root, kind: 'desk', closable: state !== 'missing',
      reason: state === 'missing' ? 'nothing has been posted here yet; there is nothing to close' : '',
      description: `The Front Desk conversation ${key}, held by WFE.`,
      parents: [], context: [], routine: null,
    },
    fingerprint: `${key}@${updated ?? ''}`,
    status: { zulip_read: true, zulip_write: true, reason: '' },
    actions,
    counts: { ready: state === 'open' ? 1 : 0, blocked: 0, done: state === 'closed' ? 1 : 0, kept: 0 },
    blocked: [], excluded: [], gaps: { truncated: false, unread: [], bounded: [], errors: [] },
    results: closed ? [{ key: action.key, kind: 'conversation', label: action.label, outcome: 'applied', note: closed.note }] : [],
    history: [], note: STOPS_NOTHING,
    ...(closed ? { applied: true } : {}),
  }
}

export const DESK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/

export function newConversationId(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
}

const conversationPath = (key: string) => `api/conversations/${encodeURIComponent(key)}`

export const deskAdapter: RoomAdapter = {
  room: 'front',
  title: 'FRONT DESK',
  param: 'conv',
  other: { label: 'Arguing Room ↗', href: '/?view=argue' },
  newKey: () => newConversationId(),
  async list() {
    const found = await readWfe<{ conversations: WfeRow[] }>('api/conversations')
    if ('error' in found) return found
    return found.conversations.map((row) => ({
      key: row.id, label: row.title || row.id, resolved: row.state === 'closed',
      last_post: row.last ? { at: epoch(row.last.at), by: row.last.author } : null, asking: row.asking,
    }))
  },
  async detail(key) {
    const found = await readWfe<WfeDetail>(conversationPath(key))
    // A desk id WFE has never seen is a new conversation: the first post
    // creates it, so it is shown empty rather than as an error.
    if ('error' in found) return found.status === 404 ? deskDetail(key, null) : found
    if (found.conversation.state === 'closed') closedSeen.add(key)
    else closedSeen.delete(key)
    return deskDetail(key, found)
  },
  // `answer` names the question (`re`); `auto` and `none` both send none —
  // WFE has no "not an answer" mark yet (project_migration p8).
  async send(key, text, token, correlation) {
    const body: Record<string, unknown> = { text, token }
    if (correlation?.kind === 'answer') body.re = [correlation.id]
    const result = await writeWfe<{ sent: boolean; duplicate: boolean; message: { id: number }; run: string | null; reopened?: boolean }>(
      `${conversationPath(key)}/messages`, body)
    if (!result.ok) return { sent: false, uncertain: result.uncertain, error: result.error }
    const payload = result.payload
    if (!payload.sent) return { sent: false, error: 'WFE did not take the message' }
    const resumed = payload.reopened ?? closedSeen.has(key)
    closedSeen.delete(key)
    return { sent: true, message_id: payload.message?.id, duplicate: payload.duplicate, resumed }
  },
  render: async () => ({ sent: false, error: 're-voicing is retired (project_migration p8): posts are shown as written' }),
  completion: {
    async closePlan(key) {
      const found = await readWfe<WfeDetail>(conversationPath(key))
      if ('error' in found) return found.status === 404 ? deskPlan(key, 'missing', null) : found
      return deskPlan(key, found.conversation.state, found.conversation.updated)
    },
    async close(key) {
      const result = await writeWfe<{ ok: boolean; conversation: { state: 'open' | 'closed'; updated: string } }>(`${conversationPath(key)}/close`, {})
      if (!result.ok) return { error: result.error }
      closedSeen.add(key)
      return deskPlan(key, 'closed', result.payload.conversation?.updated ?? null, { note: STOPS_NOTHING })
    },
  },
  words: {
    newButton: 'new conversation',
    empty: 'A new conversation. Say something in the bar below — Front answers here, and any work it starts is linked with its run view. Every message is kept in the history panel.',
    prompt: 'Say something to Front…',
    resumed: '↩ reopened this conversation — closing it stopped no run, and none was restarted',
    done: '✔ closed — posting here reopens it; closing stopped no run',
    live: 'WFE live',
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
