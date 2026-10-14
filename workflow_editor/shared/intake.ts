// Zulip intake (p6): the rules that turn a post in a workflow's Zulip
// channel into recorded workflow input. Pure — the durable inbox and its
// application to runs are server/intake.ts; the transport (fetching posts)
// is autolab's agautolab.wfintake. See docs/intake.md for the contract.
//
//   channel  ←  workflow   wf-<project>.<workflow> (its recorded stream id)
//   topic    ←  request    request-…  one request, one run
//   topic    ←  run        run-…      the run's progress (never input)
//
// Three things are kept apart, each with its own durable evidence:
//
//   receipt      the post is in the inbox (server/intake.ts), cursor moved
//   application  the run's history has an entry carrying the post's receipt
//   take-up      the executing attempt recorded that it read the input
//                (question.take-up, instruction.ack)
//
// A transport receipt is not the agent having read anything.
import type { ExecutionState } from './run.ts'

// ---- identity ------------------------------------------------------------------

// The realm a post comes from, as a stable short text: the host (and port)
// of the configured Zulip URL. Message ids are unique within one realm.
export function realmId(zulipUrl: string): string {
  const u = new URL(zulipUrl)
  return u.port ? `${u.hostname}:${u.port}` : u.hostname
}

// The receipt a run operation carries when it applies a post: retransmitting
// the operation with it records nothing new (shared/run.ts `operate`).
export function sourceReceipt(realm: string, messageId: number): string {
  if (!Number.isInteger(messageId) || messageId <= 0) throw new Error(`message id ${messageId} is not a Zulip message id`)
  return `zulip:${realm.replace(/[^A-Za-z0-9:._-]/g, '_')}:${messageId}`
}

// Where a recorded input came from: kept with the answer or instruction it
// became, so it can always be traced back to the post.
export interface SourceRef { kind: 'zulip'; realm: string; message: number; stream: number; topic: string; sender: number; senderName: string; at: string }

// ---- topics ------------------------------------------------------------------------

export type TopicKind = 'request' | 'run' | 'other'
// Zulip marks a resolved topic by renaming it with this prefix.
const RESOLVED = '✔ '
export const bareTopic = (topic: string) => (topic.startsWith(RESOLVED) ? topic.slice(RESOLVED.length) : topic)
export function topicKind(topic: string): TopicKind {
  const t = bareTopic(topic).trim()
  if (/^request-\S/.test(t)) return 'request'
  if (/^run-\S/.test(t)) return 'run'
  return 'other'
}

// ---- what the transport hands over ---------------------------------------------------

export interface InboundMessage {
  realm: string
  id: number
  streamId: number
  topic: string
  sender: { id: number; name: string; email: string; bot: boolean }
  content: string
  timestamp: number // Zulip's, epoch seconds
  // The oldest message of its topic when the transport received it. A
  // topic's identity: a renamed topic keeps its first message, and a new
  // topic that reuses an old name does not.
  topicFirst: number
}

export function validInbound(raw: unknown): InboundMessage {
  const o = raw as Record<string, unknown>
  const s = (o?.sender ?? {}) as Record<string, unknown>
  const int = (v: unknown, what: string) => { if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new Error(`${what} must be a positive integer`); return v }
  const str = (v: unknown, what: string) => { if (typeof v !== 'string') throw new Error(`${what} must be text`); return v }
  if (typeof s.bot !== 'boolean') throw new Error('sender.bot must be true or false')
  return {
    realm: str(o.realm, 'realm'), id: int(o.id, 'id'), streamId: int(o.streamId, 'streamId'), topic: str(o.topic, 'topic'),
    sender: { id: int(s.id, 'sender.id'), name: str(s.name, 'sender.name'), email: str(s.email, 'sender.email'), bot: s.bot },
    content: str(o.content, 'content'), timestamp: int(o.timestamp, 'timestamp'), topicFirst: int(o.topicFirst, 'topicFirst'),
  }
}

// ---- routing -------------------------------------------------------------------------

// A configured workflow channel: explicit, by recorded realm and stream id.
// The name of a channel or topic never selects a project or workflow.
export interface Route { realm: string; streamId: number; project: string; workflow: string; workspace: string }

// A request topic as recorded when its first eligible post was accepted.
// `topicFirst` is the topic's identity; `topic` its current name (it follows
// a rename). `origin` is the post that became the braindump.
export interface RequestBinding {
  key: string // r<origin message id>
  realm: string
  streamId: number
  topic: string
  topicFirst: number
  origin: number
  project: string
  workflow: string
  workspace: string
  run: { workflow: string; run: string } | null // null until the run exists
  state: 'opening' | 'bound' | 'refused'
  refused?: string
}
export const requestKey = (origin: number) => `r${origin}`

export type RouteResult =
  | { kind: 'ignore'; reason: 'other-realm' | 'unrouted-channel' | 'run-topic' | 'not-a-request-topic' }
  | { kind: 'new'; route: Route }
  | { kind: 'bound'; route: Route; binding: RequestBinding }
  | { kind: 'renamed'; route: Route; binding: RequestBinding; from: string; to: string }
  | { kind: 'problem'; reason: 'topic-name-reused' | 'moved-across-channels'; detail: string; binding?: RequestBinding }

// Where a post belongs. Identity first (the topic's first message), then the
// current name only to notice that a name now means another topic.
export function routeMessage(m: InboundMessage, routes: Route[], bindings: RequestBinding[]): RouteResult {
  const inRealm = routes.filter(r => r.realm === m.realm)
  if (!inRealm.length) return { kind: 'ignore', reason: 'other-realm' }
  const route = inRealm.find(r => r.streamId === m.streamId)
  const kind = topicKind(m.topic)
  const same = bindings.filter(b => b.realm === m.realm)
  const byIdentity = same.find(b => b.topicFirst === m.topicFirst)
  if (byIdentity && byIdentity.streamId !== m.streamId) {
    return { kind: 'problem', reason: 'moved-across-channels', binding: byIdentity, detail: `request ${byIdentity.key} (${byIdentity.project}/${byIdentity.workflow}) was opened in channel #${byIdentity.streamId} › ${byIdentity.topic}; this post is in #${m.streamId} › ${m.topic}. A request does not change workflow; move the topic back, or open a new request topic` }
  }
  if (!route) return { kind: 'ignore', reason: 'unrouted-channel' }
  if (byIdentity) {
    if (byIdentity.topic !== m.topic) return { kind: 'renamed', route, binding: byIdentity, from: byIdentity.topic, to: m.topic }
    return { kind: 'bound', route, binding: byIdentity }
  }
  const byName = same.find(b => b.streamId === m.streamId && b.topic === m.topic)
  if (byName) {
    return { kind: 'problem', reason: 'topic-name-reused', binding: byName, detail: `topic "${m.topic}" is recorded for request ${byName.key}, whose first message is ${byName.topicFirst}; this topic begins with ${m.topicFirst}, so it is another topic using the same name. Nothing is routed to ${byName.key} by its name; rename this topic to open a new request` }
  }
  if (kind === 'run') return { kind: 'ignore', reason: 'run-topic' }
  if (kind !== 'request') return { kind: 'ignore', reason: 'not-a-request-topic' }
  return { kind: 'new', route }
}

// ---- classification ---------------------------------------------------------------------

// What the request's run looks like to the classifier. `posted` is the
// request-topic message that carried the question (null until delivered):
// a post can answer a question only if that message existed when it was
// written, i.e. its id is lower.
export interface QuestionView { id: string; state: 'open' | 'answered' | 'taken-up' | 'withdrawn'; posted: number | null }
export interface RunView { execution: ExecutionState; cancelled: boolean; questions: QuestionView[] }

export type Classification =
  | { kind: 'ignored'; reason: 'bot' | 'unauthorized' }
  | { kind: 'request' } // the first eligible post: the original braindump
  | { kind: 'answer'; question: string; by: 'reference' | 'explicit' | 'pending' }
  | { kind: 'instruction' } // additional instruction to the active run
  | { kind: 'clarify'; reason: 'ambiguous' | 'unknown-question' | 'not-yet-asked'; questions: string[] }
  | { kind: 'late'; question: string; state: 'taken-up' | 'withdrawn' } // a reply to a closed question: kept, explained, applied nowhere
  | { kind: 'closed'; reason: 'completed' | 'cancelled' | 'refused' } // the request is over: a new request topic is needed
  | { kind: 'wait'; reason: string } // an earlier post of this request is not settled yet; classify later

// Which classifications change a run (and so need the application stage).
export const APPLIES: ReadonlySet<Classification['kind']> = new Set(['request', 'answer', 'instruction'])

// Message ids a post refers to: Zulip's quote-and-reply and message links
// (…/near/<id>, …/with/<id>).
export function referencedMessages(content: string): number[] {
  const out = new Set<number>()
  for (const m of content.matchAll(/#narrow\/[^\s)\]]*?\/(?:near|with)\/(\d+)/g)) out.add(Number(m[1]))
  return [...out]
}

// An explicit question id at the start of the post's own words (after any
// quote): "q2: yes", "q2 ok".
export function explicitQuestion(content: string): string | null {
  const own = content.replace(/^@_\*\*[^*]*\*\*[^\n]*\n/m, '').replace(/^```quote\n[\s\S]*?\n```\n?/m, '').replace(/^(>[^\n]*\n)+/m, '')
  const m = /^\s*(q[0-9]{1,6})(?:\s*[:：]|\s+\S|\s*$)/i.exec(own)
  return m ? m[1].toLowerCase() : null
}

const OPEN = (q: QuestionView) => q.state === 'open' || q.state === 'answered'

export interface ClassifyContext {
  requesters: ReadonlySet<number> // Zulip user ids allowed to request and answer
  // observer p3: agents (often bots) allowed to open a request in named
  // workflows only (`<project>/<workflow>`); nothing else they post is input.
  agents?: ReadonlyMap<number, ReadonlySet<string>>
  workflow?: string // the routed `<project>/<workflow>` of this post
  binding: RequestBinding | null // the request this topic is bound to; null for a new request topic
  run: RunView | null // the bound run as it is now
  earlierUnsettled?: number | null // an earlier post of the same request still being processed
}

// Classifies one post. Deterministic in its inputs, and its result is
// persisted with the post (server/intake.ts): a post is never classified
// again later, so an old message never becomes the answer to a newer question.
export function classify(m: InboundMessage, c: ClassifyContext): Classification {
  const agent = c.agents?.get(m.sender.id)
  if (agent) return !c.binding && c.workflow && agent.has(c.workflow) ? { kind: 'request' } : { kind: 'ignored', reason: m.sender.bot ? 'bot' : 'unauthorized' }
  if (m.sender.bot) return { kind: 'ignored', reason: 'bot' }
  if (!c.requesters.has(m.sender.id)) return { kind: 'ignored', reason: 'unauthorized' }
  if (!c.binding) return { kind: 'request' }
  if (c.earlierUnsettled) return { kind: 'wait', reason: `post ${c.earlierUnsettled} of this request is not settled yet` }
  if (c.binding.state === 'refused') return { kind: 'closed', reason: 'refused' }
  if (c.binding.state === 'opening' || !c.run) return { kind: 'wait', reason: 'the request\'s run is being created' }
  const r = c.run
  if (r.cancelled || r.execution === 'cancelled') return { kind: 'closed', reason: 'cancelled' }
  if (r.execution === 'completed') return { kind: 'closed', reason: 'completed' }
  const byPost = new Map(r.questions.filter(q => q.posted !== null).map(q => [q.posted!, q]))
  const named = [...new Set([
    ...referencedMessages(m.content).map(id => byPost.get(id)?.id).filter((x): x is string => !!x),
    ...[explicitQuestion(m.content)].filter((x): x is string => !!x),
  ])]
  if (named.length > 1) return { kind: 'clarify', reason: 'ambiguous', questions: named.sort() }
  if (named.length === 1) {
    const q = r.questions.find(x => x.id === named[0])
    if (!q) return { kind: 'clarify', reason: 'unknown-question', questions: named }
    if (q.posted === null || q.posted > m.id) return { kind: 'clarify', reason: 'not-yet-asked', questions: [q.id] }
    if (!OPEN(q)) return { kind: 'late', question: q.id, state: q.state as 'taken-up' | 'withdrawn' }
    return { kind: 'answer', question: q.id, by: referencedMessages(m.content).some(id => byPost.get(id)?.id === q.id) ? 'reference' : 'explicit' }
  }
  // No reference: the one question the person could see and is still open.
  const visible = r.questions.filter(q => OPEN(q) && q.posted !== null && q.posted < m.id)
  if (visible.length === 1) return { kind: 'answer', question: visible[0].id, by: 'pending' }
  if (visible.length > 1) return { kind: 'clarify', reason: 'ambiguous', questions: visible.map(q => q.id).sort() }
  // A stopped or held run is not over: the instruction waits in its history
  // for whoever resumes it.
  return { kind: 'instruction' }
}

// ---- the inbox's stages ---------------------------------------------------------------------

// received    stored with its raw payload; the channel cursor moved past it in the same transaction
// classified  its classification and binding are stored (never derived again)
// applied     the run's history holds an entry with its receipt (evidence: run, seq)
// done        follow-ups recorded: the resumption queued, the reply to the person queued
// failed      a stage could not complete; `stage` says which is retried, `error` why
export type InboxState = 'received' | 'classified' | 'applied' | 'done' | 'failed'
export const INBOX_TRANSITIONS: Record<InboxState, readonly InboxState[]> = {
  received: ['classified', 'failed'],
  classified: ['applied', 'done', 'failed'], // done directly when nothing is applied (ignored, late, closed, clarify)
  applied: ['done', 'failed'],
  failed: ['received', 'classified', 'applied'], // a retry resumes at the stage that failed
  done: [],
}
export function canMove(from: InboxState, to: InboxState): boolean { return INBOX_TRANSITIONS[from].includes(to) }

// The next stage a post at `state` (with this classification) must reach.
export function nextStage(state: Exclude<InboxState, 'failed' | 'done'>, c: Classification | null): InboxState {
  if (state === 'received') return 'classified'
  if (state === 'classified') return c && APPLIES.has(c.kind) ? 'applied' : 'done'
  return 'done'
}

// ---- additional instructions in the run ----------------------------------------------------------

// An additional instruction is run history (shared/run.ts instruction.receive
// / instruction.ack). Receipt by the run is not reading: the executing
// attempt acknowledges it at a node boundary, saying what it will do.
export const INSTRUCTION_RESPONSES = ['incorporate', 'clarify', 'new-run'] as const
export type InstructionResponse = typeof INSTRUCTION_RESPONSES[number]

// ---- what the person is told in the request topic ---------------------------------------------------

// A reply the intake owes the person for a post that changed nothing (or
// needs them): queued with the post, delivered by the notifier.
export type IntakeNoticeKind = 'clarify' | 'late' | 'closed' | 'refused' | 'problem'
export function noticeFor(c: Classification): IntakeNoticeKind | null {
  if (c.kind === 'clarify') return 'clarify'
  if (c.kind === 'late') return 'late'
  if (c.kind === 'closed') return c.reason === 'refused' ? 'refused' : 'closed'
  return null
}
