// The Project Room's relay reads and writes, and the browser-local memory
// beside them (`project_room` p1 step 3).
//
// Everything a project *is* comes from the relay's read model (`/projects`,
// `/projects/<key>`) and its talk door (`/work/<anchor>`,
// `/projects/<key>/topics/<topic>`, and their `/post`): documents, setup,
// missions, tasks, recorded work state beside the conversation's reply state,
// counts never percentages, links found in the source, and what could not be
// read. This file carries those payloads to the screen and keeps two things
// the relay deliberately does not: where the reader last was in each
// conversation (an "updated since you looked" mark), and the draft typed
// into each conversation's composer. Both live in this browser only.

import { readRelay, writeRelay, type SendResult } from './roomState'

export type ProjectKind = 'project' | 'study' | 'unknown'
export type ConversationKind = 'document' | 'setup' | 'mission' | 'plan' | 'task'

export interface LastPost { message_id: number; at: number; by: string; sender_id?: number }
export interface Gap { kind: string; text: string }
export interface FoundLink { url: string; kind: 'repository' | 'report' | 'zulip' | 'other'; message_id?: number }
export interface Origin { channel: string; topic: string; by?: string; by_id?: number; message_id?: number }

// The ops engine's verdict for one conversation, beside the recorded state.
export interface Reply {
  state: string
  evidence?: string
  short?: string
  instance?: string
  age_seconds?: number | null
  stale_state?: string
  rows?: { instance: string; state: string; short: string }[]
}

export interface Conversation {
  channel: string
  topic: string
  live_topic: string
  resolved: boolean
  posts: number
  last_post: LastPost | null
  first_post?: LastPost | null
  read: { complete: boolean; note: string | null }
  reply: Reply
  origins: Origin[]
  links: FoundLink[]
  zulip_url: string | null
}

export interface DocumentText { message_id: number; at: number; by: string; title: string; content?: string }

export interface DocumentRow extends Partial<Conversation> {
  kind: 'document'
  topic: string
  document_kind: 'goal' | 'researchplan'
  stem: string | null
  title: string
  versions: number
  resolved: boolean
  last_post: LastPost | null
  current?: DocumentText | null
  missions?: number[]
  note?: string
}

export interface TaskRow extends Conversation {
  kind: 'task'
  anchor: number
  label: string
  serial: number
  mission: number
  state: string
  finished: boolean
  replaces: number | null
  by: string
  document: DocumentText | null
}

export interface TaskCounts {
  total: number; live: number; finished: number; completed: number; accepted: number; cancelled: number; open: number
}

export interface MissionRow extends Partial<Conversation> {
  kind?: 'mission'
  anchor: number
  label: string
  topic: string
  resolved: boolean
  setup: boolean
  work: { state: string; note: string }
  task_counts: TaskCounts
  tasks_read: { complete: boolean; channel?: string; note: string | null }
  last_post: LastPost | null
  reply: Reply
  replaces: number | null
  replaced_by: number | null
  gaps: Gap[]
  title?: string
  document?: DocumentText | null
  tasks?: TaskRow[]
  slug?: string
  by?: string
}

export interface SetupRow extends Partial<Conversation> {
  kind?: 'setup' | 'plan'
  topic: string
  resolved: boolean
  last_post: LastPost | null
  reply: Reply
  note?: string
  recorded?: boolean
}

export interface ProjectOrigin { channel: string; topic: string; anchor: number | null; zulip_url?: string | null }

export interface ProjectCounts {
  documents: number; setups: number; missions: number; open_missions: number; plans_unrecorded: number
  orphan_tasks: number; tasks: number; tasks_finished: number; other_topics: number
  missions_by_state: Record<string, number>
}

export interface ProjectRow {
  key: string
  stream_id: number
  channel: string
  slug: string
  folder_id: number | null
  archived: boolean
  kind: ProjectKind
  description: string
  origin: ProjectOrigin | null
  zulip_url: string | null
  counts: ProjectCounts
  tasks_read: { complete: boolean; incomplete_missions: string[] }
  latest: (LastPost & { channel: string; topic: string; kind: string }) | null
  reply: { state: string }
  gaps: Gap[]
  documents: DocumentRow[]
  setups: SetupRow[]
  missions: MissionRow[]
  plans: SetupRow[]
  orphan_tasks?: TaskRow[]
  other_topics?: { topic: string; kind: string; resolved?: boolean }[]
}

export interface Health { state: string; reason: string; stale_since?: number | null; last_event_at?: number | null }

export interface ProjectBoard {
  schema: string
  generated_at: number
  health: Health
  stale: boolean
  projects: ProjectRow[]
  counts: { projects: number; live: number; archived: number }
}

export interface ProjectDetail {
  schema: string
  generated_at: number
  health: Health
  stale: boolean
  project: ProjectRow
}

export interface TalkPost {
  message_id: number
  at: number
  by: string
  sender_id: number
  kind: 'human' | 'agent' | 'ack'
  agent: string | null
  speaker: string
  content: string
  edited?: boolean
}

export interface Destination {
  channel: string
  topic: string
  live_topic: string
  resolved: boolean
  role: 'planning' | 'execution' | 'none'
  responsible: { instance: string; agent: string; bot: string; bot_id?: number | null }[]
  label: string
  postable: boolean
}

export interface TalkDetail {
  schema: string
  generated_at: number
  health: Health
  chat: { configured: boolean; reason: string | null; max_chars?: number }
  conversation: {
    kind: ConversationKind
    anchor: number | null
    project: { key: string; channel: string; slug: string; kind: ProjectKind; origin: ProjectOrigin | null } | null
    record: MissionRow | TaskRow | null
    destination: Destination
    posts: TalkPost[]
    status: { state: string; since: number | null; evidence: string; stale_state?: string }
    zulip_url: string | null
    front: { desk: string; argue: string | null; note: string } | null
    note: string
  }
}

export interface PostResult extends SendResult {
  resumed?: boolean
  needs_resume?: boolean
  resolved?: boolean
  channel?: string
  topic?: string
  front?: { desk: string; argue: string | null; note: string }
}

// What the screen selects: a project, and inside it one conversation — a
// mission or task by anchor, or an unrecorded topic by name.
export type ConversationRef =
  | { kind: 'work'; anchor: number }
  | { kind: 'topic'; project: string; topic: string }

export function refKey(ref: ConversationRef | null): string {
  if (!ref) return ''
  return ref.kind === 'work' ? `work:${ref.anchor}` : `topic:${ref.project}/${ref.topic}`
}

// --- the source: the relay, or a fixture -------------------------------------------

export interface ProjectSource {
  board: () => Promise<ProjectBoard | { error: string }>
  project: (key: string) => Promise<ProjectDetail | { error: string }>
  work: (anchor: number) => Promise<TalkDetail | { error: string }>
  topic: (key: string, topic: string) => Promise<TalkDetail | { error: string }>
  postWork: (anchor: number, text: string, token: string, resume: boolean) => Promise<PostResult>
  postTopic: (key: string, topic: string, text: string, token: string, resume: boolean) => Promise<PostResult>
}

export const relaySource: ProjectSource = {
  board: () => readRelay<ProjectBoard>('/projects'),
  project: (key) => readRelay<ProjectDetail>(`/projects/${encodeURIComponent(key)}`),
  work: (anchor) => readRelay<TalkDetail>(`/work/${anchor}`),
  topic: (key, topic) => readRelay<TalkDetail>(`/projects/${encodeURIComponent(key)}/topics/${encodeURIComponent(topic)}`),
  postWork: (anchor, text, token, resume) => writeRelay(`/work/${anchor}/post`, { text, token, resume }),
  postTopic: (key, topic, text, token, resume) =>
    writeRelay(`/projects/${encodeURIComponent(key)}/topics/${encodeURIComponent(topic)}/post`, { text, token, resume }),
}

export function readConversation(source: ProjectSource, ref: ConversationRef) {
  return ref.kind === 'work' ? source.work(ref.anchor) : source.topic(ref.project, ref.topic)
}

export function postConversation(source: ProjectSource, ref: ConversationRef, text: string, token: string, resume: boolean) {
  return ref.kind === 'work' ? source.postWork(ref.anchor, text, token, resume) : source.postTopic(ref.project, ref.topic, text, token, resume)
}

// --- browser-local memory ------------------------------------------------------------
//
// Wrapped because storage can be absent or throw (private windows, blocked
// site data); the room renders without it, it only forgets between reloads.

const SEEN = 'agdevworld.projectRoom.seen'
const DRAFTS = 'agdevworld.projectRoom.drafts'

function readStore(key: string): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown> } catch { return {} }
}
function writeStore(key: string, value: Record<string, unknown>) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* no storage: this page only */ }
}

// The newest message id the reader has had on screen for a conversation key.
export class ReadPositions {
  private seen: Record<string, number>
  constructor() {
    const found = readStore(SEEN)
    this.seen = Object.fromEntries(Object.entries(found).filter(([, v]) => typeof v === 'number')) as Record<string, number>
  }
  // `true` when the conversation has a post newer than the reader saw; a
  // conversation never opened counts as unread only when it has a post.
  unread(key: string, last: { message_id: number } | null | undefined): boolean {
    if (!last) return false
    const seen = this.seen[key]
    return seen === undefined || last.message_id > seen
  }
  mark(key: string, messageId: number) {
    if ((this.seen[key] ?? 0) >= messageId) return
    this.seen[key] = messageId
    writeStore(SEEN, this.seen)
  }
}

// One draft per conversation key, kept across a refresh, a selection change
// and a reload; cleared only when its post was confirmed sent.
export class Drafts {
  private held: Record<string, string>
  constructor() {
    const found = readStore(DRAFTS)
    this.held = Object.fromEntries(Object.entries(found).filter(([, v]) => typeof v === 'string')) as Record<string, string>
  }
  get(key: string): string { return this.held[key] ?? '' }
  set(key: string, text: string) {
    if (text === '') delete this.held[key]
    else this.held[key] = text
    writeStore(DRAFTS, this.held)
  }
}

// --- words for the screen ------------------------------------------------------------

export const WORK_STATE_LABEL: Record<string, string> = {
  planned: 'planned', started: 'started', done: 'done', cancelled: 'cancelled', replaced: 'replaced',
  open: 'open', completed: 'completed', accepted: 'accepted',
}

export function replyLabel(reply: Reply | undefined | null): string {
  if (!reply) return '?'
  const state = reply.state
  if (state === 'unknown' && reply.stale_state) return `unknown (last ${reply.stale_state})`
  return state
}

export function replyTone(state: string | undefined): string {
  switch (state) {
    case 'stalled': return 'bad'
    case 'awaiting': case 'waiting': return 'warn'
    case 'acked': case 'received': return 'accent'
    case 'done': case 'answered': return 'live'
    case 'unknown': return 'warn'
    default: return 'dim'
  }
}

export function workTone(state: string): string {
  switch (state) {
    case 'done': case 'completed': case 'accepted': return 'live'
    case 'started': return 'accent'
    case 'cancelled': case 'replaced': return 'dim'
    default: return 'muted'
  }
}

export function kindLabel(kind: ProjectKind): string {
  return kind === 'project' ? 'project' : kind === 'study' ? 'study' : 'kind unknown'
}
