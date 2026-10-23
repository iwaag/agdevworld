// The conversation service (challenge p2, docs/conversations.md): the one
// engine for every conversation — a person talking with one project, several
// projects together, or a room a conductor facilitates. It began as the
// discussion store (workflow_editor p16, argue p3–p4 ex3) and absorbed the
// one-to-one conversation engine (project_migration p8, workflow_editor p15).
// A conversation keeps, besides the store's messages, links and attachments
// (server/conversations.ts):
//
// - members: an append-only membership history (`join` / `leave`), folded
//   into the current members: people, and projects speaking through runs of
//   their own workflows;
// - a default addressee (`default_to`): a one-to-one room's project;
// - facilitation: an explicit record that a conductor (ponderer's `conduct`)
//   leads the room — begun with a brief and the history horizon it starts
//   from, ended by an explicit write. While it is active the conductor is
//   the default recipient; ending it changes routing, never ownership of
//   work already asked;
// - response requests (table `invitations`; "invitations" before p2): the
//   only thing that starts or continues a run. One names a participant, the
//   workflow selected for it (`role`: converse, discuss, conduct, deliver,
//   await), the words, the messages it is about, who issued it (the person,
//   or the conductor's run, which then awaits it), the horizon and the run
//   request's receipt (`conversation:<id>:request:<n>`; legacy direct turns
//   keep `conversation:<id>:<message>`, legacy invitations
//   `discussion:<id>:invitation:<n>`), so a retry or a restart finds the
//   same run. Its state is the record of what came of it: pending → started
//   → answered | unanswered, failed (with the reason), withdrawn (on close),
//   answered late. A request may instead be delivered to a run already
//   working: the answer to its question, or an explicit instruction;
// - awaited results (argue p3): the conductor's run may await the result of
//   a run already working (`awaits = 'result'`): answered by that run's next
//   result or synthesis here, or settled when the run ends;
// - continuation: when every request a conductor run awaits is resolved, that
//   run is given one instruction listing the outcomes; one that has ended is
//   replaced by a new conductor turn while the room is facilitated and open.
//   A continuation that may not run now (the room is closed, or no longer
//   facilitated) is held and shown, and runs once on an explicit resume;
// - the conductor (argue p4): the facilitator's run that owns the room's
//   progression across many attempts, with its activities (announce, ask,
//   ponder, talk) bound to messages, requests and decisions;
// - questions (fix3): every open question of a run that speaks for the room
//   is posted here by WFE (postQuestions), whoever asked it;
// - annotations, metadata (category, display title, default addressee) and
//   overviews: records about the conversation, never speech.
//
// Routing a person's message: the participants it names (`to`), else the runs
// it names (`runs`: an instruction to existing work), else the open questions
// it replies to (`re`), else the active conductor, else the default
// addressee; a message with none of these is refused so the client can ask
// whom it is for. An agent's contribution never starts anything. Closing
// withdraws requests not yet started and continues nobody; reopening replays
// nothing.
import { createHash } from 'node:crypto'
import type { ConversationSource } from '../shared/intake.ts'
import { ACTIVITIES, type Activity } from '../shared/model.ts'
import { isOpenDelegation } from '../shared/delegation.ts'
import { situation, type OpInput, type RunRecord } from '../shared/run.ts'
import { CONVERSATION_ID, firstLine, loadConversationConfig, parseRunName, pendingQuestions, runName, runUrl, targetName, type ConversationConfig, type ConversationRow, type ConversationStore, type AttachRequest, type MessageAttachment, type MessageKind, type MessageRow, type RunEntry, type TargetView } from './conversations.ts'
import { activeDefinition, adjustRun, readRun, runOp, usableRun } from './runs.ts'
import { parseWorkflow, renderWorkflow } from './yamlDoc.ts'
import { ConversationWorkflows } from './conversationWorkflows.ts'
import { loadRegistry } from './registry.ts'
import { transaction } from './sqlite.ts'
import { RequestError } from './workspace.ts'

const MAX_TEXT = 100_000
const TOKEN = /^[A-Za-z0-9:._/#-]{8,200}$/
const VIA = /^[a-z0-9][a-z0-9:._ -]{0,63}$/
// A dispatch that failed is retried by reconcile this many times in all;
// after that only `wfe discussion dispatch` tries it again.
export const DISPATCH_TRIES = 3
// The kinds of an agent's message that answer the invitation it was started
// for (a progress note or a question to the person does not).
const ANSWERING: MessageKind[] = ['reply', 'result', 'synthesis', 'announce']
export const INVITATION_STATES = ['pending', 'started', 'answered', 'unanswered', 'failed', 'withdrawn'] as const
export type InvitationState = typeof INVITATION_STATES[number]
const OPEN_STATES: InvitationState[] = ['pending', 'started']

// A member is a person or a project. `facilitator` appears only in
// membership rows written before challenge p2 (ponderer joined as the
// facilitator); it is read as a project member.
export type ParticipantKind = 'person' | 'facilitator' | 'project'
// A participant as clients see it: a project (with the workflows it uses
// one-to-one and among several) or the facilitator.
export type ParticipantView = TargetView & { participant: string; kind: 'project' | 'facilitator'; converse: string | null; discuss: string | null }
// The workflow role a request was selected for (challenge p2).
export const REQUEST_ROLES = ['converse', 'discuss', 'conduct', 'deliver', 'await'] as const
export type RequestRole = typeof REQUEST_ROLES[number]
// How a client may present a room: one project, several, or facilitated.
export type Mode = 'direct' | 'group' | 'facilitated'
export interface FacilitationRow { id: number; conv: string; workspace: string; workflow: string; state: 'active' | 'ended'; brief: number | null; horizon: number; by: string; by_run: string | null; at: string; ended_at: string | null; ended_by: string | null; end_note: string | null; note: string; token: string }
export interface MembershipRow { id: number; conv: string; participant: string; kind: ParticipantKind; workspace: string | null; workflow: string | null; action: 'join' | 'leave'; by: string; at: string; note: string }
export interface Member { participant: string; kind: ParticipantKind; workspace: string | null; workflow: string | null; since: string; by: string }
export interface InvitationRow {
  id: number; conv: string; participant: string; workspace: string; workflow: string; question: string; source: string; by: string; by_run: string | null
  awaited_by: string | null; horizon: number; token: string | null; state: InvitationState; run: string | null; error: string | null; tries: number
  created: string; updated: string; answered_by: number | null; late: number; reported: string | null
  delivery: string | null // JSON {question, message}: delivered to the run that asked (see post)
  awaits: string | null // 'result': an awaited result of a run already working (see awaitResult)
  activity: number | null // the conductor's ask activity it belongs to (argue p4)
  role: RequestRole | null // the workflow role selected for it (challenge p2)
  receipt: string | null // its run request's receipt, as recorded (challenge p2)
  held: string | null // why its continuation is held (closed, no longer facilitated)
}
export interface InvitationEventRow { id: number; conv: string; invitation: number; state: string; at: string; run: string | null; message: number | null; note: string }
export interface Invitation {
  id: number; participant: string; target: string; question: string; source: number[]; by: string; byRun: string | null; awaitedBy: string | null
  horizon: number; state: InvitationState; late: boolean; run: string | null; runUrl: string | null; error: string | null; tries: number
  created: string; updated: string; answeredBy: number | null; reported: string | null
  deliveredTo: number | null // the question (message) whose asking run this was delivered to
  instruct: boolean // an explicit instruction to the run it names (challenge p2)
  awaits: string | null // 'result': the facilitator awaits this run's result; no run was started for it
  activity: number | null // the ask activity (argue p4)
  role: RequestRole | null; receipt: string | null; held: string | null
}
export interface DiscussionMessage {
  id: number; role: 'person' | 'agent'; author: string; participant: string | null; text: string; at: string; via: string | null; re: number[]; kind: MessageKind
  run: string | null; runUrl: string | null; attempt: string | null; question: string | null; invitation: number | null; addressed: string[]
  node: string | null
  requests: number[] // a person's message: the requests it made (challenge p2)
  attachments?: MessageAttachment[] // challenges it carried (challenge p1)
}
// The live extent of a discussion's records, by table: what an export covers.
export interface Horizon { message: number; link: number; membership: number; event: number; activity?: number; annotation?: number; meta?: number; overview?: number; workflow?: number; workflowEvent?: number }

// The discussion's requester (argue p4): whom the conductor's talk consults.
export type Requester = { kind: 'person'; id: string } | { kind: 'run'; run: string; agent: string | null }
export const ACTIVITY_STATES = ['waiting', 'completed', 'settled', 'withdrawn'] as const
export type ActivityState = typeof ACTIVITY_STATES[number]
export interface ActivityRow {
  id: number; conv: string; run: string; node: string; attempt: string | null; kind: Activity; state: ActivityState; text: string; sources: string
  message: number | null; question: string | null; awaits: string | null; decision: string | null; obligations: string | null; outcome: string | null
  token: string; created: string; updated: string
}
export interface ActivityView {
  id: number; run: string; node: string; attempt: string | null; kind: Activity; state: ActivityState; text: string; sources: number[]
  message: number | null; question: string | null; awaits: string | null; invitations: number[]
  decision: { next: { activity: string; node: string }[]; revision: string | null } | null
  obligations: Obligation[] | null; outcome: string | null; created: string; updated: string
}
export interface ActivityEventRow { id: number; conv: string; activity: number | null; kind: string; state: string; at: string; by: string; note: string; data: string }
export const ANNOTATION_KINDS = ['intervention', 'recovery', 'evaluation', 'correction', 'note'] as const
export interface AnnotationRow { id: number; conv: string; kind: string; author: string; text: string; re: string; run: string | null; at: string; token: string | null }
// Reading a discussion (argue p4 ex2): its purpose category, a display title
// recorded for readers, and the overview — an interpretation with sources.
export const CATEGORIES = ['conversation', 'check'] as const
export type Category = typeof CATEGORIES[number]
// Why an `ifUntitled` display title was not written: the record that titled
// the conversation first (meta null: a title with no record, from before
// records were kept).
export interface TitleSkip { reason: 'titled'; value: string | null; by: string | null; run: string | null; at: string | null; meta: number | null }
export interface MetaRow { id: number; conv: string; field: 'category' | 'displayTitle' | 'defaultTo'; value: string | null; by: string; run: string | null; at: string; note: string }
export interface OverviewRow { id: number; conv: string; author: string; run: string | null; purpose: string; outcome: string | null; unresolved: string; through: number; sources: string; note: string; at: string; token: string }
// `after`: messages newer than the newest one the overview covers.
export interface Overview { id: number; author: string; run: string | null; purpose: string; outcome: string | null; unresolved: string[]; through: number; sources: number[]; note: string; at: string; after: number }
// The opening request, shown (labelled) when no overview exists: the first
// message of the person, else the conductor's opening announcement.
export interface Brief { message: number; author: string; participant: string | null; text: string }
// Where a discussion stands, read from WFE's records (invitations, questions,
// activities, obligations): never from its speech.
export interface DiscussionStatus {
  room: 'open' | 'closed'
  working: number // invitations, awaited results, runs and delegations still open
  owed: number // every obligation, questions included
  awaiting: { message: number; question: string | null; from: string; receiver: { kind: 'person' | 'run'; id: string; agent: string | null }; you: boolean }[]
  failed: { invitation: number; participant: string; error: string | null }[]
  held: { run: string; situation: string }[] // runs of the conversation stopped or interrupted
  continuations: { requests: number[]; awaitedBy: string | null; why: string }[] // continuations held for an explicit resume (challenge p2)
}
const MAX_TITLE = 200
// A display title as given: undefined (not named), null (back to the
// original) or one line; refused before anything is written.
function displayTitleOf(t: string | null | undefined): string | null | undefined {
  const title = t === undefined ? undefined : t?.trim() || null
  if (title && (title.includes('\n') || title.length > MAX_TITLE)) throw new RequestError(400, `a display title is one line of at most ${MAX_TITLE} characters`)
  return title
}
const MAX_OVERVIEW = 4000
// A citation in an overview: [#123] (or [#123 #124]).
const CITATION = /\[#(\d+)((?:[ ,]+#\d+)*)\]/g
export function citations(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(CITATION)) for (const n of m[0].matchAll(/#(\d+)/g)) out.push(Number(n[1]))
  return [...new Set(out)]
}

// Something still owed in a discussion (argue p4): who owes it and who will
// receive it when it comes, read from the records now.
export interface Obligation { kind: 'invitation' | 'result' | 'question' | 'run' | 'delegation' | 'continuation'; ref: string; owes: string; owner: string; receiver: string; since: string; situation?: string }

// The description a node made by `wfe discussion ponder --next` starts with.
const ACTIVITY_DESCRIPTIONS: Record<Activity, string> = {
  announce: 'Tell the discussion what comes next and why (wfe discussion announce): an agenda, context, an interim synthesis or the conclusion.',
  ask: 'Ask the participants who can supply what is missing (wfe discussion ask), or await a commissioned result (--run); WFE completes it with their outcomes.',
  ponder: 'Read what was said and what is owed (wfe discussion state), decide the next step and why (wfe discussion ponder).',
  talk: 'Consult the requester about intent or direction: wfe run ask on this node, to the requester (wfe discussion state names them); WFE posts the question here and their answer continues this run.',
}
const now = () => new Date().toISOString()
function categoryOf(v: string): Category {
  // `discussion` was the ordinary category's name before challenge p2.
  if (v === 'discussion') return 'conversation'
  if (!(CATEGORIES as readonly string[]).includes(v)) throw new RequestError(400, `a conversation's category is ${CATEGORIES.join(' or ')} (check: an operational check or fixture)`, { code: 'bad-category' })
  return v as Category
}
// A room's mode from its members and facilitation (a client's reading).
export const modeOf = (members: Member[], facilitation: FacilitationRow | null): Mode => facilitation ? 'facilitated' : members.filter(m => m.kind !== 'person').length > 1 ? 'group' : 'direct'
const label = (i: Pick<InvitationRow, 'state' | 'late'>) => `${i.state}${i.late ? '-late' : ''}`
const resolved = (s: InvitationState) => !OPEN_STATES.includes(s)

export class ConversationService {
  readonly cs: ConversationStore
  constructor(cs: ConversationStore) { this.cs = cs }
  get db() { return this.cs.db }
  get area() { return this.cs.area }
  get exec() { return this.cs.exec }
  config() { return loadConversationConfig(this.area) }
  private cfg(): ConversationConfig {
    const c = this.config()
    if ('disabled' in c) throw new RequestError(503, c.disabled)
    return c
  }

  private tx<T>(f: () => T): T { return transaction(this.db, f, 'conversation store') }
  private all<T>(sql: string, ...a: (string | number | null)[]): T[] { return this.db.prepare(sql).all(...a) as T[] }
  private one<T>(sql: string, ...a: (string | number | null)[]): T | undefined { return this.db.prepare(sql).get(...a) as T | undefined }

  conversation(id: string): ConversationRow | undefined { return this.cs.conversation(id) }
  private need(id: string): ConversationRow {
    const c = this.cs.conversation(id)
    if (!c) throw new RequestError(404, `no conversation ${id}`)
    return c
  }
  // Each conversation with its members, open requests, its facilitation and
  // (argue p4) what its conductor does now: the latest waiting activity, else
  // the latest one.
  list() {
    return this.cs.list().map(c => {
      const acts = this.activityRows(c.id)
      const now = acts.filter(a => a.state === 'waiting').at(-1) ?? acts.at(-1)
      const who = now?.kind === 'ask' ? this.all<{ participant: string }>('SELECT participant FROM invitations WHERE activity = ? ORDER BY id', now.id).map(r => r.participant) : []
      const members = this.members(c.id)
      const facilitation = this.facilitation(c.id)
      return { ...c, members: members.map(m => m.participant), mode: modeOf(members, facilitation), facilitation, open: this.invitations(c.id).filter(i => OPEN_STATES.includes(i.state)).length,
        activity: now ? { kind: now.kind, state: now.state, node: now.node, run: now.run, asked: now.awaits ? [now.awaits] : who } : null }
    })
  }
  messages(conv: string, since = 0): MessageRow[] { return this.cs.messages(conv, since) }
  membership(conv: string): MembershipRow[] { return this.all<MembershipRow>('SELECT * FROM membership WHERE conv = ? ORDER BY id', conv) }
  invitations(conv: string): InvitationRow[] { return this.all<InvitationRow>('SELECT * FROM invitations WHERE conv = ? ORDER BY id', conv) }
  invitation(id: number): InvitationRow | undefined { return this.one<InvitationRow>('SELECT * FROM invitations WHERE id = ?', id) }
  events(conv: string, since = 0): InvitationEventRow[] { return this.all<InvitationEventRow>('SELECT * FROM invitation_events WHERE conv = ? AND id > ? ORDER BY id', conv, since) }
  facilitations(conv: string, since = 0): FacilitationRow[] { return this.all<FacilitationRow>('SELECT * FROM facilitations WHERE conv = ? AND id > ? ORDER BY id', conv, since) }
  // The active facilitation, else null.
  facilitation(conv: string): FacilitationRow | null { return this.one<FacilitationRow>('SELECT * FROM facilitations WHERE conv = ? AND state = \'active\' ORDER BY id DESC LIMIT 1', conv) ?? null }
  horizon(conv: string): Horizon {
    const max = (table: string) => this.one<{ n: number | null }>(`SELECT max(id) AS n FROM ${table} WHERE conv = ?`, conv)!.n ?? 0
    const workflow = this.one<{ n: number | null }>('SELECT max(id) AS n FROM workflow_refs WHERE conv = ? AND state != \'pending\'', conv)!.n ?? 0
    return { message: max('messages'), link: max('links'), membership: max('membership'), event: max('invitation_events'), activity: max('activity_events'), annotation: max('annotations'), meta: max('discussion_meta'), overview: max('overviews'), workflow, workflowEvent: max('workflow_ref_events') }
  }

  // The current members: the membership history folded, in order of joining.
  members(conv: string): Member[] {
    const cur = new Map<string, Member>()
    for (const r of this.membership(conv)) {
      if (r.action === 'leave') cur.delete(r.participant)
      else if (!cur.has(r.participant)) cur.set(r.participant, { participant: r.participant, kind: r.kind === 'facilitator' ? 'project' : r.kind, workspace: r.workspace, workflow: r.workflow, since: r.at, by: r.by })
    }
    return [...cur.values()]
  }
  mode(conv: string): Mode { return modeOf(this.members(conv), this.facilitation(conv)) }

  // Who a participant id is: a configured project (the facilitator's
  // workspace included, consulted as a project when it is not leading), or —
  // for a name that is neither — a person.
  resolve(participant: string, o: { person?: boolean } = {}): { participant: string; kind: ParticipantKind; workspace: string | null; workflow: string | null } {
    const cfg = this.cfg()
    if (cfg.projects.some(p => p.workspace === participant) || participant === cfg.facilitator.workspace) return { participant, kind: 'project', workspace: participant, workflow: null }
    if (o.person) return { participant, kind: 'person', workspace: null, workflow: null }
    throw new RequestError(400, `"${participant}" is not a participant here: the projects that can take part are ${cfg.projects.map(t => t.workspace).join(', ') || 'none'}`, { code: 'unknown-participant' })
  }

  // The workflow a request to a participant is selected for, recorded with
  // it for its lifetime: the facilitator's for the conductor; for a project,
  // `converse` in a room where it is the only project and nobody facilitates,
  // `discuss` otherwise (its other workflow when it has only one).
  selectWorkflow(conv: string, participant: string, role?: 'conduct'): { workspace: string; workflow: string; role: RequestRole } {
    const cfg = this.cfg()
    if (role === 'conduct') return { ...cfg.facilitator, role: 'conduct' }
    const p = cfg.projects.find(x => x.workspace === participant)
    if (!p) throw new RequestError(409, `${participant} has no conversation workflow here (conversations.json "projects")${participant === cfg.facilitator.workspace ? ': it takes part only by leading — start facilitation' : ''}`, { code: 'no-workflow' })
    const others = this.members(conv).filter(m => m.kind !== 'person' && m.participant !== participant)
    const want: 'converse' | 'discuss' = this.facilitation(conv) || others.length ? 'discuss' : 'converse'
    const other = want === 'converse' ? 'discuss' : 'converse'
    const workflow = p[want] ?? p[other]!
    return { workspace: p.workspace, workflow, role: p[want] ? want : other }
  }

  // The projects that can take part and the facilitator, as their projects
  // say now (an unreadable one is listed unavailable with the reason).
  async participants(): Promise<ParticipantView[]> {
    const cfg = this.config()
    if ('disabled' in cfg) return []
    const out: ParticipantView[] = []
    for (const p of cfg.projects) out.push({ ...await this.cs.target({ workspace: p.workspace, workflow: (p.converse ?? p.discuss)! }), participant: p.workspace, kind: 'project', converse: p.converse, discuss: p.discuss })
    out.push({ ...await this.cs.target(cfg.facilitator), participant: cfg.facilitator.workspace, kind: 'facilitator', converse: null, discuss: null })
    return out
  }

  private joinRow(conv: string, m: ReturnType<ConversationService['resolve']>, by: string, note: string) {
    this.db.prepare('INSERT INTO membership (conv, participant, kind, workspace, workflow, action, by, at, note) VALUES (?, ?, ?, ?, ?, \'join\', ?, ?, ?)').run(conv, m.participant, m.kind, m.workspace, m.workflow, by, now(), note)
  }

  // ---- creating, joining, leaving --------------------------------------------------

  // A new conversation with its first members: the person who creates it and
  // the projects named. With one project and no conductor that project is its
  // default addressee (a one-to-one room) unless `defaultTo` says otherwise.
  // The same id again with the same creator is the same conversation (a
  // retried create), never a second one. From the conductor's attempt (argue
  // p4) `conductor` is that run: the conversation starts facilitated by it,
  // and the requester is the run that requested it (or the person it acts
  // for). Its category (argue p4 ex2) is `conversation` unless the creator
  // says it is an operational `check` (a fixture, a trial of the system).
  // `facilitate`: the creator asks the facilitator to lead from the start (a
  // room opened as a facilitated discussion); its first message to the
  // conductor is the brief.
  create(conv: string, o: { title: string; by: string; members?: string[]; defaultTo?: string | null; conductor?: string; requester?: Requester; category?: string; facilitate?: boolean }): { conversation: ConversationRow; duplicate: boolean } {
    if (!CONVERSATION_ID.test(conv)) throw new RequestError(400, `conversation id must match ${CONVERSATION_ID.source}`)
    const title = o.title.trim()
    if (!title) throw new RequestError(400, 'a conversation needs a title')
    const category = categoryOf(o.category ?? 'conversation')
    const cfg = this.cfg()
    const members = [...new Set(o.members ?? [])].map(p => this.resolve(p))
    const projects = members.filter(m => m.kind === 'project')
    const led = !!o.conductor || !!o.facilitate
    const defaultTo = o.defaultTo !== undefined ? o.defaultTo : projects.length === 1 && !led ? projects[0].participant : null
    if (defaultTo && !projects.some(m => m.participant === defaultTo)) throw new RequestError(400, `the default addressee ${defaultTo} is not among the members`, { code: 'bad-default' })
    return this.tx(() => {
      const c = this.cs.conversation(conv)
      if (c) {
        if (c.by !== o.by) throw new RequestError(409, `${conv} already exists`, { code: 'exists' })
        return { conversation: c, duplicate: true }
      }
      const at = now()
      const requester: Requester = o.requester ?? { kind: 'person', id: o.by }
      this.db.prepare('INSERT INTO conversations (id, title, created, updated, state, by, workspace, workflow, kind, conductor, requester, category, default_to) VALUES (?, ?, ?, ?, \'open\', ?, NULL, NULL, \'conversation\', ?, ?, ?, ?)').run(conv, firstLine(title), at, at, o.by, o.conductor ?? null, JSON.stringify(requester), category, defaultTo)
      this.db.prepare('INSERT INTO discussion_meta (conv, field, value, by, run, at, note) VALUES (?, \'category\', ?, ?, ?, ?, ?)').run(conv, category, o.by, o.conductor ?? null, at, o.category ? 'at creation' : 'at creation (default)')
      if (defaultTo) this.db.prepare('INSERT INTO discussion_meta (conv, field, value, by, run, at, note) VALUES (?, \'defaultTo\', ?, ?, ?, ?, \'at creation\')').run(conv, defaultTo, o.by, o.conductor ?? null, at)
      this.activityEvent(conv, null, 'requester', requester.kind, o.by, requester.kind === 'person' ? `requested by ${requester.id}` : `requested by ${requester.run}`, { requester })
      if (o.requester?.kind !== 'run' || !o.conductor) this.joinRow(conv, this.resolve(o.by, { person: true }), o.by, 'created the conversation')
      for (const m of members) this.joinRow(conv, m, o.by, 'a member from its creation')
      if (led) {
        if (!members.some(m => m.participant === cfg.facilitator.workspace)) this.joinRow(conv, this.resolve(cfg.facilitator.workspace), o.by, 'leads it')
        this.db.prepare('INSERT INTO facilitations (conv, workspace, workflow, state, brief, horizon, by, by_run, at, note, token) VALUES (?, ?, ?, \'active\', NULL, 0, ?, ?, ?, ?, \'created\')').run(conv, cfg.facilitator.workspace, cfg.facilitator.workflow, o.by, o.conductor ?? null, at, o.conductor ? 'the conductor created the conversation' : 'opened as a facilitated conversation')
        this.activityEvent(conv, null, 'facilitation', 'started', o.by, o.conductor ? `${o.conductor} created the conversation and leads it` : `${o.by} opened it for ${cfg.facilitator.workspace} to lead`, { run: o.conductor ?? null, horizon: 0 })
      }
      if (o.conductor) this.activityEvent(conv, null, 'conductor', 'set', o.by, `${o.conductor} conducts (it created the conversation)`, { run: o.conductor })
      return { conversation: this.cs.conversation(conv)!, duplicate: false }
    })
  }

  join(conv: string, participant: string, o: { by: string; note?: string; person?: boolean }): { member: Member; duplicate: boolean } {
    this.need(conv)
    const m = this.resolve(participant, { person: o.person })
    return this.tx(() => {
      const cur = this.members(conv).find(x => x.participant === m.participant)
      if (cur) return { member: cur, duplicate: true }
      this.joinRow(conv, m, o.by, o.note?.trim() || 'joined')
      this.touch(conv)
      return { member: this.members(conv).find(x => x.participant === m.participant)!, duplicate: false }
    })
  }

  // A member who leaves is asked nothing more; what it said and the requests
  // it was given stay. The default addressee who leaves is no longer one.
  leave(conv: string, participant: string, o: { by: string; note?: string }): { left: boolean } {
    this.need(conv)
    return this.tx(() => {
      const cur = this.members(conv).find(x => x.participant === participant)
      if (!cur) return { left: false }
      this.db.prepare('INSERT INTO membership (conv, participant, kind, workspace, workflow, action, by, at, note) VALUES (?, ?, ?, ?, ?, \'leave\', ?, ?, ?)').run(conv, participant, cur.kind, cur.workspace, cur.workflow, o.by, now(), o.note?.trim() || 'left')
      if (this.cs.conversation(conv)?.default_to === participant) this.recordDefault(conv, null, o.by, null, `${participant} left`)
      this.touch(conv)
      return { left: true }
    })
  }
  private touch(conv: string) { this.db.prepare('UPDATE conversations SET updated = ? WHERE id = ?').run(now(), conv) }

  // The default addressee: whom a message naming nobody goes to while nobody
  // facilitates. An explicit write, recorded like the other metadata.
  setDefault(conv: string, participant: string | null, o: { by: string; run?: string | null; note?: string }): ConversationRow {
    this.need(conv)
    if (participant !== null && !this.members(conv).some(m => m.participant === participant && m.kind !== 'person')) throw new RequestError(400, `${participant} is not a project member of ${conv}`, { code: 'bad-default' })
    return this.tx(() => {
      if ((this.cs.conversation(conv)!.default_to ?? null) !== participant) this.recordDefault(conv, participant, o.by, o.run ?? null, o.note?.trim() ?? '')
      return this.cs.conversation(conv)!
    })
  }
  private recordDefault(conv: string, participant: string | null, by: string, run: string | null, note: string) {
    this.db.prepare('UPDATE conversations SET default_to = ? WHERE id = ?').run(participant, conv)
    this.db.prepare('INSERT INTO discussion_meta (conv, field, value, by, run, at, note) VALUES (?, \'defaultTo\', ?, ?, ?, ?, ?)').run(conv, participant, by, run, now(), note)
  }

  // ---- facilitation ----------------------------------------------------------------

  // Starts facilitation: an explicit act with a brief — the person's words to
  // the conductor, a message of the conversation — and the horizon it starts
  // from (the newest message before the brief). The conversation, its
  // messages, members, open questions, runs and attachments stay as they
  // are; the brief's request starts the conductor's run. The same token again
  // is the same start.
  async startFacilitation(conv: string, o: { text: string; author: string; token: string; re?: number[]; via?: string; challenges?: AttachRequest[] }): Promise<{ facilitation: FacilitationRow; duplicate: boolean; posted: Awaited<ReturnType<ConversationService['post']>> }> {
    const c = this.need(conv)
    const cfg = this.cfg()
    if (!TOKEN.test(o.token)) throw new RequestError(400, 'a start needs a submit token (8–200 of A-Z a-z 0-9 : . _ / # -)')
    const token = `start:${o.token}`.slice(0, 200)
    const seen = this.one<FacilitationRow>('SELECT * FROM facilitations WHERE conv = ? AND token = ?', conv, token)
    const active = this.facilitation(conv)
    if (!seen && active) throw new RequestError(409, `${conv} is already facilitated (since ${active.at}, by ${active.by})`, { code: 'facilitated' })
    if (!seen && c.state === 'closed') throw new RequestError(409, `${conv} is closed: reopen it first`, { code: 'closed' })
    if (!o.text.trim()) throw new RequestError(400, 'facilitation starts with a brief: what the conductor is asked to lead')
    if (!seen) this.tx(() => {
      const horizon = this.horizon(conv).message
      this.db.prepare('INSERT INTO facilitations (conv, workspace, workflow, state, brief, horizon, by, at, note, token) VALUES (?, ?, ?, \'active\', NULL, ?, ?, ?, \'\', ?)').run(conv, cfg.facilitator.workspace, cfg.facilitator.workflow, horizon, o.author, now(), token)
      if (!this.members(conv).some(m => m.participant === cfg.facilitator.workspace)) this.joinRow(conv, this.resolve(cfg.facilitator.workspace), o.author, 'asked to lead')
      const requester: Requester = { kind: 'person', id: o.author }
      this.db.prepare('UPDATE conversations SET requester = ? WHERE id = ?').run(JSON.stringify(requester), conv)
      this.activityEvent(conv, null, 'facilitation', 'started', o.author, `${o.author} asked ${cfg.facilitator.workspace} to lead, from #${horizon}`, { horizon, requester })
    })
    const posted = await this.post(conv, { text: o.text, author: o.author, token: o.token, re: o.re, to: [cfg.facilitator.workspace], via: o.via, challenges: o.challenges })
    this.db.prepare('UPDATE facilitations SET brief = ? WHERE conv = ? AND token = ? AND brief IS NULL').run(posted.message.id, conv, token)
    return { facilitation: this.one<FacilitationRow>('SELECT * FROM facilitations WHERE conv = ? AND token = ?', conv, token)!, duplicate: !!seen, posted }
  }

  // Ends facilitation: from now on a message naming nobody goes to the
  // default addressee (or asks whom it is for). Nothing is stopped, and what
  // the conductor asked of others stays its own; a continuation that would
  // need a new conductor turn is held (afterResolution).
  endFacilitation(conv: string, o: { by: string; run?: string | null; note?: string }): { facilitation: FacilitationRow | null; ended: boolean } {
    this.need(conv)
    return this.tx(() => {
      const f = this.facilitation(conv)
      if (!f) return { facilitation: null, ended: false }
      this.db.prepare('UPDATE facilitations SET state = \'ended\', ended_at = ?, ended_by = ?, end_note = ? WHERE id = ?').run(now(), o.by, o.note?.trim() ?? '', f.id)
      this.activityEvent(conv, null, 'facilitation', 'ended', o.by, `${o.by} ended facilitation${o.note?.trim() ? `: ${o.note.trim()}` : ''}`, { facilitation: f.id, run: o.run ?? null })
      this.touch(conv)
      return { facilitation: this.one<FacilitationRow>('SELECT * FROM facilitations WHERE id = ?', f.id)!, ended: true }
    })
  }

  // ---- the person's words ----------------------------------------------------------

  // A person's message, verbatim, routed into requests (docs/conversations.md
  // *Routing*): the participants it names; else the runs it names (an
  // instruction to work under way); else the open questions it replies to;
  // else the active conductor; else the default addressee. Without any it is
  // refused (409 choose-recipient) and nothing is recorded. A reply naming a
  // question of an addressed participant's open run is that run's answer.
  // The same token twice is one message and the same requests. A post
  // reopens a closed conversation. A new id is created by its first message,
  // with the project `with` names (a one-to-one room).
  // `challenges` (challenge p1): challenges the message carries, pinned to the
  // revision named (or the current one), given to whoever it reaches.
  async post(conv: string, o: { text: string; author: string; token: string; re?: number[]; to?: string[]; runs?: string[]; via?: string; challenges?: AttachRequest[]; with?: string; title?: string }): Promise<{ message: MessageRow; duplicate: boolean; reopened: boolean; created: boolean; invitations: InvitationRow[] }> {
    if (!CONVERSATION_ID.test(conv)) throw new RequestError(400, `conversation id must match ${CONVERSATION_ID.source}`)
    if (!o.text.trim()) throw new RequestError(400, 'the message is empty')
    if (o.text.length > MAX_TEXT) throw new RequestError(413, `a message is at most ${MAX_TEXT} characters`)
    if (!TOKEN.test(o.token)) throw new RequestError(400, 'a message needs a submit token (8–200 of A-Z a-z 0-9 : . _ / # -)')
    if (o.via !== undefined && !VIA.test(o.via)) throw new RequestError(400, `via must match ${VIA.source}`)
    const cfg = this.cfg()
    let created = false
    if (!this.cs.conversation(conv)) {
      if (!o.with) throw new RequestError(404, `conversation ${conv} does not exist yet: its first message names whom it is with (with: <project>)`, { code: 'no-destination' })
      if (!cfg.projects.some(p => p.workspace === o.with)) throw new RequestError(400, `${o.with} is not a project that can take part here (${cfg.projects.map(p => p.workspace).join(', ') || 'none configured'})`, { code: 'unknown-target' })
      created = !this.create(conv, { title: o.title?.trim() || firstLine(o.text), by: o.author, members: [o.with] }).duplicate
    }
    const c = this.need(conv)
    if (o.with && !this.members(conv).some(m => m.participant === o.with)) throw new RequestError(409, `conversation ${conv} is not with ${o.with}: invite it, or start a new conversation`, { code: 'other-destination' })
    const seen = this.one<MessageRow>('SELECT * FROM messages WHERE conv = ? AND token = ?', conv, o.token)
    const re = this.validRe(conv, o.re ?? [])
    const to = [...new Set(o.to ?? [])]
    const runs = [...new Set(o.runs ?? [])]
    const facilitated = !!this.facilitation(conv)
    const targets = to.map(p => this.resolve(p))
    const left = targets.filter(t => this.left(conv, t.participant))
    if (left.length) throw new RequestError(409, `${left.map(t => t.participant).join(', ')} left this conversation; ask ${left.length > 1 ? 'them' : 'it'} to join again first`, { code: 'left' })
    const known = new Set([...this.invitations(conv).map(i => i.run).filter((r): r is string => !!r), ...this.cs.links(conv).map(l => l.run), ...this.all<{ run: string }>('SELECT DISTINCT run FROM activities WHERE conv = ?', conv).map(r => r.run), ...(c.conductor ? [c.conductor] : [])])
    for (const r of runs) { parseRunName(r); if (!known.has(r)) throw new RequestError(400, `${r} is not work of this conversation: name a run its requests started, linked or conducted`, { code: 'unknown-run' }) }
    // Whom the words reach.
    type Recipient = { key: string; participant: string; role: 'conduct' | 'project' | 'run'; run?: string; deliver?: { run: string; question: string | null; message: number; instruct?: boolean } }
    const recipients: Recipient[] = []
    const add = (r: Recipient) => { if (!recipients.some(x => x.key === r.key)) recipients.push(r) }
    const conductorOrProject = (participant: string) => facilitated && participant === cfg.facilitator.workspace ? add({ key: participant, participant, role: 'conduct' }) : add({ key: participant, participant, role: 'project' })
    const named = re.map(n => this.cs.message(n)).filter((m): m is MessageRow => !!m && m.role === 'agent' && m.kind === 'question' && !!m.run)
    if (seen) {
      // A resubmission finds its requests by their tokens.
      for (const i of this.all<InvitationRow>('SELECT * FROM invitations WHERE conv = ? AND token LIKE ? ORDER BY id', conv, `message:${seen.id}:%`)) add({ key: i.token!.slice(`message:${seen.id}:`.length), participant: i.participant, role: 'project' })
    } else if (targets.length) for (const t of targets) conductorOrProject(t.participant)
    else if (runs.length) for (const r of runs) add({ key: `run:${r}`, participant: parseRunName(r).workspace, role: 'run', run: r })
    else {
      for (const q of named) if (await this.runIsOpen(q.run!)) add({ key: q.participant ?? parseRunName(q.run!).workspace, participant: q.participant ?? parseRunName(q.run!).workspace, role: c.conductor === q.run ? 'conduct' : 'project' })
      if (!recipients.length) {
        if (facilitated) add({ key: cfg.facilitator.workspace, participant: cfg.facilitator.workspace, role: 'conduct' })
        else if (c.default_to && !this.left(conv, c.default_to)) add({ key: c.default_to, participant: c.default_to, role: 'project' })
        else throw new RequestError(409, `whom is this for? ${conv} has no default addressee${this.members(conv).some(m => m.kind !== 'person') ? `: name one of ${this.members(conv).filter(m => m.kind !== 'person').map(m => m.participant).join(', ')}` : ': invite a project first'}`, { code: 'choose-recipient', members: this.members(conv).filter(m => m.kind !== 'person').map(m => m.participant) })
      }
    }
    if (!seen) for (const r of recipients) {
      if (r.role === 'run') { r.deliver = { run: r.run!, question: null, message: 0, instruct: true }; continue }
      // The person's reply to a question of this participant's run goes to
      // the run that asked while it is open: as the answer to its WFE
      // question, else as an instruction.
      const q = named.filter(m => (m.participant ?? parseRunName(m.run!).workspace) === r.participant).at(-1)
      if (q && await this.runIsOpen(q.run!)) r.deliver = { run: q.run!, question: q.question, message: q.id }
      // The conductor (argue p4): an open conductor run is given the words —
      // as the answer to its question the message names, or to its only open
      // question asked here — and no second run is started.
      else if (r.role === 'conduct') {
        const conductor = await this.openConductor(conv)
        if (conductor) r.deliver = { run: conductor, ...await this.conductorQuestion(conv, conductor, re, q) }
      }
    }
    // The workflow of each request, selected now and recorded with it.
    const chosen = seen ? [] : recipients.map(r => r.role === 'run' ? (({ workspace, ref }) => ({ workspace, workflow: ref.workflow, role: 'deliver' as RequestRole }))(parseRunName(r.run!)) : r.role === 'conduct' ? this.selectWorkflow(conv, r.participant, 'conduct') : this.selectWorkflow(conv, r.participant))
    const pins = seen ? [] : await this.cs.pinAll(o.challenges ?? [])
    const res = this.tx(() => {
      const again = this.one<MessageRow>('SELECT * FROM messages WHERE conv = ? AND token = ?', conv, o.token)
      const reopened = !again && c.state === 'closed'
      let id = again?.id
      if (!again) {
        const at = now()
        this.db.prepare('UPDATE conversations SET updated = ?, state = \'open\' WHERE id = ?').run(at, conv)
        if (!this.members(conv).some(m => m.participant === o.author)) this.joinRow(conv, this.resolve(o.author, { person: true }), o.author, 'first message')
        id = Number(this.db.prepare('INSERT INTO messages (conv, role, author, text, at, token, via, re, kind, participant, addressed) VALUES (?, \'person\', ?, ?, ?, ?, ?, ?, \'message\', ?, ?)').run(conv, o.author, o.text, at, o.token, o.via ?? null, JSON.stringify(re), o.author, JSON.stringify(recipients.map(r => r.run ?? r.participant))).lastInsertRowid)
        this.cs.attachRows(conv, id, pins)
      }
      const m = this.cs.message(id!)!
      const invs = again ? this.all<InvitationRow>('SELECT * FROM invitations WHERE conv = ? AND token LIKE ? ORDER BY id', conv, `message:${m.id}:%`)
        : recipients.map((r, n) => {
          const w = chosen[n] as { workspace: string; workflow: string; role: RequestRole }
          const role: RequestRole = r.deliver && r.role !== 'run' ? 'deliver' : w.role
          return this.issue(conv, { participant: { participant: r.participant, kind: 'project', workspace: w.workspace, workflow: w.workflow }, role, question: m.text, source: [m.id, ...re.filter(n => n !== m.id)], by: o.author, byRun: null, awaitedBy: null, token: `message:${m.id}:${r.key}`, deliver: r.deliver ? { ...r.deliver, message: r.deliver.message || m.id } : undefined })
        })
      return { message: m, duplicate: !!again, reopened, invitations: invs }
    })
    // A facilitation opened without its brief takes the first words to the conductor.
    if (!res.duplicate && res.invitations.some(i => i.role === 'conduct' || (i.role === 'deliver' && i.workflow === cfg.facilitator.workflow && i.workspace === cfg.facilitator.workspace))) this.db.prepare('UPDATE facilitations SET brief = ? WHERE conv = ? AND state = \'active\' AND brief IS NULL').run(res.message.id, conv)
    for (const i of res.invitations) if (i.state === 'pending') await this.dispatch(i.id)
    return { ...res, created, invitations: res.invitations.map(i => this.invitation(i.id)!) }
  }

  // The conversations a run conducts, newest first (a conductor run that was
  // requested as work, not asked here, finds its conversation this way).
  conductedBy(run: string): string[] { return this.all<{ id: string }>('SELECT id FROM conversations WHERE conductor = ? ORDER BY updated DESC', run).map(r => r.id) }
  // The conductor run while it is open (not completed or cancelled), else
  // null: the next message for the conductor starts a new one.
  async openConductor(conv: string): Promise<string | null> {
    const run = this.cs.conversation(conv)?.conductor
    return run && await this.runIsOpen(run) ? run : null
  }
  private setConductor(conv: string, run: string, by: string, why: string) {
    this.db.prepare('UPDATE conversations SET conductor = ? WHERE id = ?').run(run, conv)
    this.activityEvent(conv, null, 'conductor', 'set', by, `${run} conducts (${why})`, { run })
  }
  requester(conv: string): Requester | null {
    const r = this.cs.conversation(conv)?.requester
    return r ? JSON.parse(r) as Requester : null
  }
  // Which question of the conductor a person's words answer: the one the
  // message names, else the only one of its open questions asked here.
  private async conductorQuestion(conv: string, run: string, re: number[], named?: MessageRow): Promise<{ question: string | null; message: number }> {
    const asked = named?.run === run ? named : re.map(n => this.cs.message(n)).find(m => m?.role === 'agent' && m.kind === 'question' && m.run === run)
    if (asked?.question) return { question: asked.question, message: asked.id }
    try {
      const { workspace, ref } = parseRunName(run)
      const rec = (await readRun(await this.exec!.workspace(workspace), ref)).record as RunRecord | null
      const here = this.all<MessageRow>('SELECT * FROM messages WHERE conv = ? AND run = ? AND kind = \'question\' AND question IS NOT NULL ORDER BY id', conv, run)
      const open = here.filter(m => { const q = rec?.questions[m.question!]; return q && !q.takenUp && !q.withdrawn })
      if (open.length === 1) return { question: open[0].question, message: open[0].id }
    } catch { /* read again by the delivery */ }
    return { question: null, message: re[0] ?? 0 }
  }

  private left(conv: string, participant: string): boolean {
    const rows = this.membership(conv).filter(r => r.participant === participant)
    return rows.at(-1)?.action === 'leave'
  }

  // Records a request (inside a transaction), joining a participant who was
  // never a member. Its token makes a retried issue the same request; its
  // receipt (`conversation:<id>:request:<n>`) is recorded with it.
  private issue(conv: string, o: { participant: ReturnType<ConversationService['resolve']>; role: RequestRole; question: string; source: number[]; by: string; byRun: string | null; awaitedBy: string | null; token: string; deliver?: { run: string; question: string | null; message: number; instruct?: boolean }; activity?: number | null }): InvitationRow {
    const seen = this.one<InvitationRow>('SELECT * FROM invitations WHERE conv = ? AND token = ?', conv, o.token)
    if (seen) return seen
    if (!this.members(conv).some(m => m.participant === o.participant.participant)) this.joinRow(conv, { ...o.participant, workflow: null }, o.by, `asked by ${o.by}`)
    const at = now()
    const id = Number(this.db.prepare('INSERT INTO invitations (conv, participant, workspace, workflow, question, source, by, by_run, awaited_by, token, state, run, delivery, activity, role, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'pending\', ?, ?, ?, ?, ?, ?)')
      .run(conv, o.participant.participant, o.participant.workspace!, o.participant.workflow!, o.question, JSON.stringify(o.source), o.by, o.byRun, o.awaitedBy, o.token, o.deliver?.run ?? null, o.deliver ? JSON.stringify({ question: o.deliver.question, message: o.deliver.message, ...(o.deliver.instruct ? { instruct: true } : {}) }) : null, o.activity ?? null, o.role, at, at).lastInsertRowid)
    this.db.prepare('UPDATE invitations SET receipt = ? WHERE id = ?').run(`conversation:${conv}:request:${id}`, id)
    this.event(conv, id, 'pending', { note: `issued by ${o.by}${o.byRun ? ` (${o.byRun})` : ''} to ${o.participant.participant} (${o.role}: ${o.participant.workspace}/${o.participant.workflow})${o.awaitedBy ? `; awaited by ${o.awaitedBy}` : ''}${o.deliver ? o.deliver.instruct ? `; an instruction to ${o.deliver.run}` : `; for ${o.deliver.run}, which asked #${o.deliver.message}` : ''}` })
    this.touch(conv)
    return this.invitation(id)!
  }
  private event(conv: string, invitation: number, state: string, o: { run?: string | null; message?: number | null; note?: string } = {}) {
    this.db.prepare('INSERT INTO invitation_events (conv, invitation, state, at, run, message, note) VALUES (?, ?, ?, ?, ?, ?, ?)').run(conv, invitation, state, now(), o.run ?? null, o.message ?? null, o.note ?? '')
  }
  // The receipt a request's run is requested (and its delivery recorded) with.
  private receipt(i: InvitationRow): string { return i.receipt ?? `discussion:${i.conv}:invitation:${i.id}` }

  // ---- requests by the person or the conductor ---------------------------------------

  // A request by the person or by the conductor's run (which then awaits
  // it). A participant's run cannot ask others: it says in its own
  // contribution whom it would ask.
  async invite(conv: string, o: { participant: string; question: string; re?: number[]; by: string; byRun?: string | null; token?: string; activity?: number | null }): Promise<{ invitation: InvitationRow; duplicate: boolean }> {
    const c = this.need(conv)
    const cfg = this.cfg()
    if (c.state === 'closed') throw new RequestError(409, `conversation ${conv} is closed: reopen it to ask anyone`, { code: 'closed' })
    if (!o.question.trim()) throw new RequestError(400, 'say what the participant is asked (--question)')
    if (o.question.length > MAX_TEXT) throw new RequestError(413, `a question is at most ${MAX_TEXT} characters`)
    let awaitedBy: string | null = null
    if (o.byRun) {
      const { workspace, ref } = parseRunName(o.byRun)
      if (workspace !== cfg.facilitator.workspace || ref.workflow !== cfg.facilitator.workflow) throw new RequestError(403, `only the conductor (${targetName(cfg.facilitator)}) or the person asks participants; a participant says in its contribution whom it would ask`, { code: 'not-facilitator' })
      awaitedBy = o.byRun
    }
    const p = this.resolve(o.participant)
    if (this.left(conv, p.participant)) throw new RequestError(409, `${p.participant} left this conversation; ask it to join again first`, { code: 'left' })
    const re = this.validRe(conv, o.re ?? [])
    const horizon = this.horizon(conv).message
    if (!re.length && !horizon) throw new RequestError(400, 'the conversation has no message yet: a request is about messages (--re)')
    const token = o.token ?? `${o.byRun ?? o.by}:${createHash('sha256').update(`${p.participant}\n${o.question}\n${re.join(',')}`).digest('hex').slice(0, 24)}`
    if (!TOKEN.test(token)) throw new RequestError(400, 'a request token is 8–200 of A-Z a-z 0-9 : . _ / # -')
    const before = this.one<InvitationRow>('SELECT * FROM invitations WHERE conv = ? AND token = ?', conv, token)
    const conduct = p.participant === cfg.facilitator.workspace && (!!this.facilitation(conv) || !cfg.projects.some(x => x.workspace === p.participant))
    const w = before ? null : conduct ? this.selectWorkflow(conv, p.participant, 'conduct') : this.selectWorkflow(conv, p.participant)
    const inv = before ?? this.tx(() => this.issue(conv, { participant: { ...p, workspace: w!.workspace, workflow: w!.workflow }, role: w!.role, question: o.question, source: re.length ? re : [horizon], by: o.by, byRun: o.byRun ?? null, awaitedBy, token, activity: o.activity }))
    if (inv.state === 'pending') await this.dispatch(inv.id)
    return { invitation: this.invitation(inv.id)!, duplicate: !!before }
  }

  // Starts a request's run: one run of its recorded workflow with the words
  // as its braindump; or delivers it to the run it names. The receipt finds
  // the same run again. A target that cannot take it leaves the request
  // `failed` with the reason; it is never sent to anyone else. A closed
  // conversation starts nothing: the request is withdrawn.
  async dispatch(id: number): Promise<InvitationRow> {
    const i = this.invitation(id)
    if (!i || (i.state !== 'pending' && i.state !== 'failed')) return i!
    const c = this.cs.conversation(i.conv)!
    if (c.state === 'closed') { this.withdraw(i, 'the conversation was closed before it started'); return this.invitation(id)! }
    try {
      if (!this.exec) throw new Error('execution is not configured here')
      if (i.delivery && i.run && await this.deliver(i)) return this.invitation(id)!
      const named = JSON.parse(i.source) as number[]
      const first = this.cs.message(named[0] ?? 0) ?? this.cs.message(this.horizon(i.conv).message)
      if (!first) throw new Error('the request names no message')
      const horizon = this.horizon(i.conv).message
      const source: ConversationSource = { kind: 'conversation', conversation: i.conv, message: first.id, author: first.author, at: first.at, invitation: i.id }
      // The challenges the messages it is about carried (challenge p1), as
      // they were when sent.
      const attachments = await this.cs.pinnedTexts(this.cs.attachmentsOf(named))
      const r = await this.exec.request({ workspace: i.workspace, workflow: i.workflow, text: i.question, author: i.by, receipt: this.receipt(i), via: 'conversation', source, ...(attachments.length ? { attachments } : {}) })
      const run = runName(i.workspace, r.ref)
      // The facilitator's run started for a conductor request conducts the
      // conversation unless another one still does (argue p4).
      const conducts = i.role === 'conduct' && !await this.openConductor(i.conv)
      this.tx(() => {
        this.db.prepare('UPDATE invitations SET state = \'started\', run = ?, error = NULL, tries = tries + 1, horizon = CASE WHEN horizon = 0 THEN ? ELSE horizon END, updated = ? WHERE id = ?').run(run, horizon, now(), id)
        this.event(i.conv, id, 'started', { run, note: `${run} requested; horizon #${horizon}` })
        if (conducts && this.cs.conversation(i.conv)?.conductor !== run) this.setConductor(i.conv, run, 'conversation', `started by request ${id}`)
        if (named[0] && !this.one('SELECT 1 FROM links WHERE message = ? AND run = ? AND relation = \'turn\'', named[0], run)) this.db.prepare('INSERT INTO links (conv, message, run, relation, note, by, at) VALUES (?, ?, ?, \'turn\', ?, \'conversation\', ?)').run(i.conv, named[0], run, `the run started for request ${id}`, now())
      })
    } catch (e) {
      this.tx(() => {
        this.db.prepare('UPDATE invitations SET state = \'failed\', error = ?, tries = tries + 1, updated = ? WHERE id = ?').run((e as Error).message, now(), id)
        if (i.state !== 'failed' || i.error !== (e as Error).message) this.event(i.conv, id, 'failed', { note: (e as Error).message })
      })
      await this.afterResolution(id)
    }
    return this.invitation(id)!
  }

  // Delivers a request to the run it names: the person's words as the answer
  // to its open WFE question (which resumes the node waiting on it), else as
  // an instruction (which continues a waiting run). The receipt makes a retry
  // the same record. When that run has ended meanwhile, a reply to its
  // question starts a new run like any other request (false); an explicit
  // instruction fails instead — it is never redirected.
  private async deliver(i: InvitationRow): Promise<boolean> {
    const d = JSON.parse(i.delivery!) as { question: string | null; message: number; instruct?: boolean }
    const { workspace, ref } = parseRunName(i.run!)
    const ws = await this.exec!.workspace(workspace)
    const rec = (await readRun(ws, ref)).record as RunRecord | null
    if (!rec || ['completed', 'cancelled'].includes(situation(rec))) {
      if (d.instruct) throw new Error(`${i.run} has ${rec ? `ended (${situation(rec)})` : 'no record'}: an instruction is never redirected; ask the participant for new work instead`)
      this.tx(() => {
        this.db.prepare('UPDATE invitations SET run = NULL, delivery = NULL, updated = ? WHERE id = ?').run(now(), i.id)
        this.event(i.conv, i.id, 'pending', { note: `${i.run} has ended: a new run is requested instead` })
      })
      return false
    }
    const m = this.cs.message(JSON.parse(i.source)[0])!
    const attached = this.cs.attachmentsOf(JSON.parse(i.source) as number[])
    const source: ConversationSource = { kind: 'conversation', conversation: i.conv, message: m.id, author: m.author, at: m.at, invitation: i.id, ...(attached.length ? { attachments: attached } : {}) }
    const receipt = this.receipt(i)
    const q = d.question ? rec.questions[d.question] : undefined
    let how: string
    if (q && !q.withdrawn && !q.takenUp) {
      await runOp(ws, ref, { op: 'question.answer', question: q.id, text: i.question, from: i.by, source, receipt }, { by: i.by, via: 'conversation' })
      const job = await this.exec!.afterAnswer(ws, ref, q.id)
      how = `the answer to ${q.id}${job ? `; job ${job.id}` : ''}`
    } else {
      const r = await runOp(ws, ref, { op: 'instruction.receive', text: i.question, from: i.by, source, receipt }, { by: i.by, via: 'conversation' })
      const ins = r.record.history.find(h => h.receipt === receipt)?.change.instruction?.[1] ?? Object.keys(r.record.instructions ?? {}).at(-1)
      const job = ins ? await this.exec!.afterInstruction(ws, ref, ins) : null
      how = `instruction ${ins}${job ? `; job ${job.id}` : ''}`
    }
    this.tx(() => {
      this.db.prepare('UPDATE invitations SET state = \'started\', error = NULL, tries = tries + 1, horizon = CASE WHEN horizon = 0 THEN ? ELSE horizon END, updated = ? WHERE id = ?').run(this.horizon(i.conv).message, now(), i.id)
      this.event(i.conv, i.id, 'started', { run: i.run, note: d.instruct ? `delivered to ${i.run} as ${how}` : `delivered to ${i.run}, which asked #${d.message}, as ${how}` })
    })
    return true
  }

  private async runIsOpen(run: string): Promise<boolean> {
    if (!this.exec) return false
    try {
      const { workspace, ref } = parseRunName(run)
      const rec = (await readRun(await this.exec.workspace(workspace), ref)).record as RunRecord | null
      return !!rec && !['completed', 'cancelled'].includes(situation(rec))
    } catch { return false }
  }

  private withdraw(i: InvitationRow, why: string) { this.tx(() => this.withdrawRow(i, why)) }
  private withdrawRow(i: InvitationRow, why: string) {
    this.db.prepare('UPDATE invitations SET state = \'withdrawn\', error = ?, updated = ? WHERE id = ?').run(why, now(), i.id)
    this.event(i.conv, i.id, 'withdrawn', { note: why })
  }

  // Withdraws a request that has not started (by the person or the conductor
  // that issued it). A started run is not stopped by this: stopping a run is
  // the run's own control.
  withdrawInvitation(conv: string, id: number, o: { by: string; reason: string }): InvitationRow {
    this.need(conv)
    const i = this.invitation(id)
    if (!i || i.conv !== conv) throw new RequestError(404, `no request ${id} in ${conv}`)
    if (i.state !== 'pending' && i.state !== 'failed') throw new RequestError(409, `request ${id} is ${i.state}: only one not started can be withdrawn${i.run ? ` (its run is ${i.run})` : ''}`, { code: 'not-withdrawable' })
    this.withdraw(i, `${o.by}: ${o.reason}`)
    return this.invitation(id)!
  }

  // Tries a failed request again, at the same recipient (by hand, after
  // reconcile's tries).
  async retry(conv: string, id: number): Promise<InvitationRow> {
    this.need(conv)
    const i = this.invitation(id)
    if (!i || i.conv !== conv) throw new RequestError(404, `no request ${id} in ${conv}`)
    if (i.state !== 'failed' && i.state !== 'pending') throw new RequestError(409, `request ${id} is ${i.state}: only a failed or pending one is tried again`, { code: 'not-retryable' })
    return this.dispatch(id)
  }

  // The facilitator's run awaits the result of a run that is already working:
  // a participant's run that entrusted work and waits for it, a synthesize
  // run, or any other run the discussion depends on. Nothing is started; the
  // row is an invitation (`awaits = 'result'`, state `started`) so that its
  // outcome reaches the facilitator by the same continuation. It is answered
  // by that run's next result or synthesis in this discussion; when the run
  // ends first, by its last message here since the await, else it is
  // unanswered. The same facilitator run awaiting the same run again is the
  // same row.
  async awaitResult(conv: string, o: { run: string; note: string; re?: number[]; by: string; byRun: string; activity?: number | null }): Promise<{ invitation: InvitationRow; duplicate: boolean }> {
    const c = this.need(conv)
    const cfg = this.cfg()
    if (c.state === 'closed') throw new RequestError(409, `discussion ${conv} is closed: reopen it to await anything`, { code: 'closed' })
    const f = parseRunName(o.byRun)
    if (f.workspace !== cfg.facilitator.workspace || f.ref.workflow !== cfg.facilitator.workflow) throw new RequestError(403, `only the facilitator's run (${targetName(cfg.facilitator)}) awaits a result here`, { code: 'not-facilitator' })
    if (o.run === o.byRun) throw new RequestError(400, 'a run does not await itself')
    if (!o.note.trim()) throw new RequestError(400, 'say what result is awaited (--note)')
    const { workspace, ref } = parseRunName(o.run)
    if (!this.exec) throw new RequestError(503, 'execution is not configured here')
    const rec = (await readRun(await this.exec.workspace(workspace), ref).catch(() => ({ record: null }))).record as RunRecord | null
    if (!rec) throw new RequestError(404, `no run ${o.run}`)
    const re = this.validRe(conv, o.re ?? [])
    const horizon = this.horizon(conv).message
    const token = o.activity ? `await:${o.byRun}:${o.run}:a${o.activity}` : `await:${o.byRun}:${o.run}`
    const before = this.one<InvitationRow>('SELECT * FROM invitations WHERE conv = ? AND token = ?', conv, token)
    if (!before) {
      this.tx(() => {
        const at = now()
        const id = Number(this.db.prepare('INSERT INTO invitations (conv, participant, workspace, workflow, question, source, by, by_run, awaited_by, horizon, token, state, run, awaits, activity, role, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'started\', ?, \'result\', ?, \'await\', ?, ?)')
          .run(conv, workspace, workspace, ref.workflow, o.note.trim(), JSON.stringify(re.length ? re : [horizon]), o.by, o.byRun, o.byRun, horizon, token, o.run, o.activity ?? null, at, at).lastInsertRowid)
        this.event(conv, id, 'awaited', { run: o.run, note: `${o.byRun} awaits the result of ${o.run} (${situation(rec)}): ${o.note.trim()}` })
        this.touch(conv)
      })
    }
    const inv = this.one<InvitationRow>('SELECT * FROM invitations WHERE conv = ? AND token = ?', conv, token)!
    // A run that has already ended settles at once.
    if (inv.state === 'started' && ['completed', 'cancelled'].includes(situation(rec))) await this.settleEnded(inv, situation(rec))
    return { invitation: this.invitation(inv.id)!, duplicate: !!before }
  }

  // An awaited result whose run ended: answered by the run's last message in
  // the discussion since the await (a result it gave as a reply), else
  // unanswered. Either way the facilitator is told.
  private async settleEnded(i: InvitationRow, s: string): Promise<string | null> {
    this.tx(() => {
      const last = i.awaits ? this.one<MessageRow>('SELECT * FROM messages WHERE conv = ? AND run = ? AND role = \'agent\' AND at >= ? ORDER BY id DESC LIMIT 1', i.conv, i.run, i.created) : undefined
      if (last) {
        this.db.prepare('UPDATE invitations SET state = \'answered\', answered_by = ?, updated = ? WHERE id = ? AND state = \'started\'').run(last.id, now(), i.id)
        this.event(i.conv, i.id, 'answered', { run: i.run, message: last.id, note: `${i.run} is ${s}; its last message here since the await is #${last.id}` })
      } else {
        this.db.prepare('UPDATE invitations SET state = \'unanswered\', updated = ? WHERE id = ? AND state = \'started\'').run(now(), i.id)
        this.event(i.conv, i.id, 'unanswered', { run: i.run, note: `${i.run} is ${s} and contributed no answer` })
      }
    })
    return this.afterResolution(i.id)
  }

  // ---- the participants' speech ----------------------------------------------------

  // A message by a run's agent: attributed to the participant the run speaks
  // for, its run and attempt, and the invitation it was started for. A reply,
  // result or synthesis answers that invitation (late, after it was found
  // unanswered or withdrawn). The same key (default: the text's hash) from
  // the same run is one message.
  async contribute(conv: string, o: { text: string; author: string; run: string; attempt?: string | null; invitation?: number | null; re?: number[]; kind?: MessageKind; question?: string | null; key?: string; node?: string | null; complete?: boolean }): Promise<{ message: MessageRow; duplicate: boolean; invitation: InvitationRow | null; completed?: string }> {
    this.need(conv)
    const cfg = this.cfg()
    if (!o.text.trim()) throw new RequestError(400, 'the contribution is empty')
    if (o.text.length > MAX_TEXT) throw new RequestError(413, `a message is at most ${MAX_TEXT} characters`)
    const kind = o.kind ?? 'reply'
    if (kind === 'message') throw new RequestError(400, 'a contribution\'s kind is reply, question, progress, result or synthesis')
    const { workspace, ref } = parseRunName(o.run)
    const participant = workspace === cfg.facilitator.workspace && ref.workflow === cfg.facilitator.workflow ? cfg.facilitator.workspace : workspace
    let inv: InvitationRow | null = null
    if (o.invitation) {
      inv = this.invitation(o.invitation) ?? null
      if (!inv || inv.conv !== conv) throw new RequestError(404, `no invitation ${o.invitation} in ${conv}`)
      if (inv.run !== o.run) throw new RequestError(409, `invitation ${o.invitation} was given to ${inv.run ?? inv.participant}, not ${o.run}`, { code: 'other-run' })
    } else {
      // A run speaking without an invitation of its own must still be a
      // member's run (e.g. a facilitator turn answering after a restart), or
      // the archive project's (a synthesis requested as ordinary work).
      if (!this.members(conv).some(m => m.participant === participant) && !this.invitations(conv).some(i => i.run === o.run) && participant !== cfg.archive?.workspace) throw new RequestError(403, `${o.run} is not a member's run in ${conv}`, { code: 'not-member' })
    }
    if (kind === 'synthesis' && participant !== cfg.facilitator.workspace && participant !== cfg.archive?.workspace) throw new RequestError(403, `a synthesis is the facilitator's or the archive's (${[cfg.facilitator.workspace, cfg.archive?.workspace].filter(Boolean).join(', ')}); a participant's view is a reply`, { code: 'not-facilitator' })
    if (kind === 'announce' && participant !== cfg.facilitator.workspace) throw new RequestError(403, 'an announcement is the facilitator\'s (wfe discussion announce)', { code: 'not-facilitator' })
    const re = this.validRe(conv, o.re ?? [])
    const key = o.key ?? createHash('sha256').update(o.text).digest('hex').slice(0, 24)
    const res = this.tx(() => {
      const seen = this.one<MessageRow>('SELECT * FROM messages WHERE conv = ? AND run IS ? AND key = ?', conv, o.run, key)
      if (seen) return { message: seen, duplicate: true, answered: [] as number[] }
      const at = now()
      this.touch(conv)
      const id = Number(this.db.prepare('INSERT INTO messages (conv, role, author, text, at, re, kind, run, attempt, question, key, participant, invitation, node) VALUES (?, \'agent\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(conv, o.author, o.text, at, JSON.stringify(re), kind, o.run, o.attempt ?? null, o.question ?? null, key, participant, inv?.id ?? null, o.node ?? null).lastInsertRowid)
      // The run's own invitation, and those delivered to it since (a reply
      // to its question): a reply, result or synthesis answers them. A result
      // or synthesis also answers what is awaited of this run (an interim
      // reply does not).
      const answered = ANSWERING.includes(kind) ? [...(inv && inv.state !== 'answered' ? [inv] : []), ...this.all<InvitationRow>('SELECT * FROM invitations WHERE conv = ? AND run = ? AND delivery IS NOT NULL AND state = \'started\' AND id IS NOT ?', conv, o.run, inv?.id ?? null),
        ...(kind === 'result' || kind === 'synthesis' ? this.all<InvitationRow>('SELECT * FROM invitations WHERE conv = ? AND run = ? AND awaits IS NOT NULL AND state = \'started\'', conv, o.run) : [])] : []
      for (const a of answered) {
        const late = a.state === 'unanswered' || a.state === 'withdrawn' || a.state === 'failed' ? 1 : 0
        this.db.prepare('UPDATE invitations SET state = \'answered\', answered_by = ?, late = ?, updated = ? WHERE id = ?').run(id, late, at, a.id)
        this.event(conv, a.id, 'answered', { run: o.run, message: id, note: late ? `answered late (was ${a.state})` : 'answered' })
      }
      return { message: this.cs.message(id)!, duplicate: false, answered: answered.map(a => a.id) }
    })
    for (const a of new Set([...(inv ? [inv.id] : []), ...(res.answered ?? [])])) await this.afterResolution(a)
    // --complete (argue p4): the node this was spoken for completes with the
    // message, in the same command (p3: two turns spoke and left it running).
    let completed: string | undefined
    if (o.complete && o.node && this.exec) {
      const { workspace, ref } = parseRunName(o.run)
      const rec = (await readRun(await this.exec.workspace(workspace), ref)).record as RunRecord | null
      const n = rec?.nodes[o.node]
      if (!n) throw new RequestError(404, `${o.run} has no node ${o.node}`, { code: 'node-unknown' })
      if (n.state !== 'completed') {
        const receipt = `discussion:${conv}:message:${res.message.id}`
        await this.startNode(o.run, o.node, n.state, { by: o.author, attempt: o.attempt, receipt })
        await this.finishNode(o.run, o.node, `${kind} #${res.message.id} in discussion ${conv}`, { by: o.author, attempt: o.attempt, receipt })
      }
      completed = o.node
    }
    return { message: res.message, duplicate: res.duplicate, invitation: inv && this.invitation(inv.id)!, ...(completed ? { completed } : {}) }
  }

  // When an invitation awaited by a facilitator run is resolved and nothing
  // else that run awaits is still open, the run is told the outcomes in one
  // instruction, which continues it if it waits (runs.md, "An instruction
  // continues a run nobody executes"). Each outcome is told once (a late
  // answer is a new outcome). A closed discussion continues nobody; a
  // facilitator still in its attempt is told after it (reconcile).
  // An ask activity (argue p4) is its own group: when its invitations are
  // resolved (or it was settled), WFE completes its node first — the
  // outcomes are its completion evidence — and then tells the run.
  // A continuation that may not run now — the conversation is closed, or a
  // new conductor turn would be needed while nobody facilitates — is held
  // (each request's `held` says why) and shown among the obligations; only an
  // explicit resume runs it (o.resume).
  async afterResolution(id: number, o: { resume?: boolean } = {}): Promise<string | null> {
    const i = this.invitation(id)
    if (!i?.awaited_by || !resolved(i.state)) return null
    if (i.held && !o.resume) return null
    const c = this.cs.conversation(i.conv)!
    const act = i.activity ? this.activityRow(i.activity) ?? null : null
    const awaited = act
      ? this.all<InvitationRow>('SELECT * FROM invitations WHERE activity = ? ORDER BY id', act.id)
      : this.all<InvitationRow>('SELECT * FROM invitations WHERE awaited_by = ? AND conv = ? AND activity IS NULL ORDER BY id', i.awaited_by, i.conv)
    if (awaited.some(a => OPEN_STATES.includes(a.state)) && act?.state !== 'settled') return null
    const untold = awaited.filter(a => resolved(a.state) && a.reported !== label(a))
    if (!untold.length || !this.exec) return null
    const hold = (why: string) => {
      this.tx(() => { for (const a of untold) if (!a.held) { this.db.prepare('UPDATE invitations SET held = ? WHERE id = ?').run(why, a.id); this.event(a.conv, a.id, 'held', { run: a.awaited_by, note: `continuation of ${a.awaited_by} held: ${why}` }) } })
      return `held the continuation of ${i.awaited_by}: ${why}`
    }
    if (c.state === 'closed') return hold('the conversation is closed (resume to continue)')
    const outcome = (a: InvitationRow) => a.state === 'answered' ? `answered${a.late ? ' late' : ''} by #${a.answered_by} (${a.run})`
      : a.state === 'unanswered' ? `unanswered: ${a.run} ended without ${a.awaits ? 'a message here since the await' : 'a contribution'}`
      : a.state === 'failed' ? `failed: ${a.error}` : `withdrawn: ${a.error ?? ''}`
    const what = (a: InvitationRow) => a.awaits ? `the awaited result of ${a.run} (invitation ${a.id}, ${a.participant})` : `invitation ${a.id} to ${a.participant}`
    const read = `Read what was said: wfe discussion show ${i.conv} --since ${Math.min(...untold.map(a => a.horizon || 0))}`
    const lines = (head: string) => [head, ...untold.map(a => `- ${what(a)}: ${outcome(a)}`), read].join('\n')
    const ids = untold.map(a => `${a.id}-${label(a)}`).join('.')
    let receipt = `discussion:${i.conv}:continue:${i.awaited_by}:${act ? `a${act.id}:` : ''}${ids}`
    if (receipt.length > 200) receipt = `discussion:${i.conv}:continue:${createHash('sha256').update(receipt).digest('hex').slice(0, 32)}`
    const newest = untold.map(a => a.answered_by).filter((n): n is number => !!n).at(-1) ?? JSON.parse(untold[0].source)[0]
    const m = this.cs.message(newest)
    const { workspace, ref } = parseRunName(i.awaited_by)
    let note: string
    try {
      const ws = await this.exec.workspace(workspace)
      // While the facilitator's attempt is open (it is still inviting) or
      // before it started, nothing is told yet: what it awaits is read in
      // the invite results, and reconcile tells it once its attempt ended.
      let fr = (await readRun(ws, ref)).record as RunRecord | null
      if (fr && (fr.control.attempt || fr.execution.state === 'not-started')) return null
      let head = `Discussion ${i.conv}: the invitations you awaited are resolved.`
      if (act) {
        const done = act.state === 'waiting' ? await this.completeAsk(act, untold.map(a => `- ${what(a)}: ${outcome(a)}`).join('\n')) : null
        fr = (await readRun(ws, ref)).record as RunRecord | null
        head = act.state === 'waiting'
          ? `Discussion ${i.conv}: everything your ${act.kind} node ${act.node} asked (activity ${act.id}) is resolved${done ? `; ${done}` : ''}.`
          : `Discussion ${i.conv}: a later outcome of your ${act.state} ${act.kind} node ${act.node} (activity ${act.id}).`
      }
      // A facilitator run that completed meanwhile cannot be continued: the
      // outcomes go to a new facilitator turn (receipt-bound, once), so what
      // was awaited is read by the facilitator whenever it resolves.
      if (fr && situation(fr) === 'completed') {
        if (!this.facilitation(i.conv) && !o.resume) return hold(`${i.awaited_by} has completed and nobody facilitates now (resume to start a conductor turn)`)
        const cfg = this.cfg()
        const turn = this.tx(() => this.issue(i.conv, { participant: { participant: cfg.facilitator.workspace, kind: 'project', ...cfg.facilitator }, role: 'conduct', question: lines(`Discussion ${i.conv}: what ${i.awaited_by} awaited is resolved, and that run has completed; this turn takes it up.`), source: m ? [m.id] : JSON.parse(untold[0].source) as number[], by: 'discussion', byRun: null, awaitedBy: null, token: receipt }))
        this.tx(() => { for (const a of untold) this.db.prepare('UPDATE invitations SET reported = ?, held = NULL WHERE id = ?').run(label(a), a.id) })
        const started = turn.state === 'pending' ? await this.dispatch(turn.id) : turn
        return `${i.awaited_by} has completed: a new facilitator turn, invitation ${started.id} (${started.state}${started.run ? ` ${started.run}` : ''})`
      }
      const source: ConversationSource | undefined = m ? { kind: 'conversation', conversation: i.conv, message: m.id, author: m.author, at: m.at } : undefined
      const r = await runOp(ws, ref, { op: 'instruction.receive', text: lines(head), from: `discussion ${i.conv}`, ...(source ? { source } : {}), receipt }, { by: 'discussion', via: 'discussion' })
      const ins = r.record.history.find(h => h.receipt === receipt)?.change.instruction?.[1] ?? Object.keys(r.record.instructions ?? {}).at(-1)
      const job = ins ? await this.exec.afterInstruction(ws, ref, ins) : null
      note = `told ${i.awaited_by} (instruction ${ins}${job ? `, job ${job.id}` : ', nothing to continue'})`
    } catch (e) {
      // A run that cannot take it (cancelled) is told nothing more; the
      // outcomes stay visible in the discussion.
      note = `could not tell ${i.awaited_by}: ${(e as Error).message}`
    }
    this.tx(() => { for (const a of untold) this.db.prepare('UPDATE invitations SET reported = ?, held = NULL WHERE id = ?').run(label(a), a.id) })
    return note
  }

  // Runs held continuations once (all of the conversation's, or one
  // request's group): the person's explicit decision that what was awaited
  // should be taken up now. The conversation must be open.
  async resume(conv: string, o: { by: string; request?: number }): Promise<{ resumed: number[]; notes: string[] }> {
    const c = this.need(conv)
    if (c.state === 'closed') throw new RequestError(409, `conversation ${conv} is closed: reopen it, then resume`, { code: 'closed' })
    const held = this.all<InvitationRow>('SELECT * FROM invitations WHERE conv = ? AND held IS NOT NULL ORDER BY id', conv).filter(i => o.request === undefined || i.id === o.request)
    if (o.request !== undefined && !held.length) throw new RequestError(404, `request ${o.request} of ${conv} holds no continuation`, { code: 'not-held' })
    const notes: string[] = []
    const done = new Set<string>()
    for (const i of held) {
      const group = `${i.awaited_by}:${i.activity ?? ''}`
      if (done.has(group)) continue
      done.add(group)
      this.event(conv, i.id, 'resumed', { run: i.awaited_by, note: `resumed by ${o.by}` })
      const n = await this.afterResolution(i.id, { resume: true })
      if (n) notes.push(n)
    }
    return { resumed: held.map(i => i.id), notes }
  }

  // ---- reconcile -------------------------------------------------------------------

  // What the executor's reconcile does every minute: starts invitations not
  // yet started (failed ones up to DISPATCH_TRIES in all), finds started ones
  // whose run ended without a contribution (`unanswered`), and tells waiting
  // facilitators what they have not been told (a crash between a resolution
  // and the instruction); posts questions a run asked where the asking
  // command could not (a worker's run, a failure after the record).
  async reconcile(): Promise<string[]> {
    const notes: string[] = []
    for (const i of this.all<InvitationRow>('SELECT i.* FROM invitations i JOIN conversations c ON c.id = i.conv WHERE c.state = \'open\' AND (i.state = \'pending\' OR (i.state = \'failed\' AND i.tries < ?)) ORDER BY i.id', DISPATCH_TRIES)) {
      const after = await this.dispatch(i.id)
      notes.push(`discussion ${i.conv} invitation ${i.id} → ${i.participant}: ${after.state}${after.run ? ` ${after.run}` : ''}${after.state === 'failed' ? ` — ${after.error}` : ''}`)
    }
    for (const i of this.all<InvitationRow>('SELECT * FROM invitations WHERE state = \'started\' ORDER BY id')) {
      if (!this.exec || !i.run) continue
      try {
        const { workspace, ref } = parseRunName(i.run)
        const rec = (await readRun(await this.exec.workspace(workspace), ref)).record as RunRecord | null
        const s = rec ? situation(rec) : null
        if (s !== 'completed' && s !== 'cancelled') continue
        if (i.awaits) {
          const told = await this.settleEnded(i, s)
          notes.push(`discussion ${i.conv} awaited result ${i.id}: ${this.invitation(i.id)!.state} (${i.run} ${s})`)
          if (told) notes.push(`discussion ${i.conv}: ${told}`)
          continue
        }
        this.tx(() => {
          this.db.prepare('UPDATE invitations SET state = \'unanswered\', updated = ? WHERE id = ? AND state = \'started\'').run(now(), i.id)
          this.event(i.conv, i.id, 'unanswered', { run: i.run, note: `${i.run} is ${s} and contributed no answer` })
        })
        notes.push(`discussion ${i.conv} invitation ${i.id}: unanswered (${i.run} ${s})`)
        const told = await this.afterResolution(i.id)
        if (told) notes.push(`discussion ${i.conv}: ${told}`)
      } catch { /* an unreadable run is read again next time */ }
    }
    for (const r of this.all<{ awaited_by: string; conv: string; id: number }>('SELECT awaited_by, conv, max(id) AS id FROM invitations WHERE awaited_by IS NOT NULL AND held IS NULL AND (reported IS NULL OR reported != state || CASE WHEN late = 1 THEN \'-late\' ELSE \'\' END) AND state NOT IN (\'pending\', \'started\') GROUP BY awaited_by, conv, activity')) {
      const told = await this.afterResolution(r.id)
      if (told) notes.push(`discussion ${r.conv}: ${told}`)
    }
    notes.push(...await this.postQuestions())
    notes.push(...await this.reconcileActivities())
    return notes
  }

  // ---- activities (argue p4) -------------------------------------------------------

  activityRow(id: number): ActivityRow | undefined { return this.one<ActivityRow>('SELECT * FROM activities WHERE id = ?', id) }
  activityRows(conv: string): ActivityRow[] { return this.all<ActivityRow>('SELECT * FROM activities WHERE conv = ? ORDER BY id', conv) }
  activityEvents(conv: string, since = 0): ActivityEventRow[] { return this.all<ActivityEventRow>('SELECT * FROM activity_events WHERE conv = ? AND id > ? ORDER BY id', conv, since) }
  annotations(conv: string, since = 0): AnnotationRow[] { return this.all<AnnotationRow>('SELECT * FROM annotations WHERE conv = ? AND id > ? ORDER BY id', conv, since) }
  activityView(a: ActivityRow): ActivityView {
    return {
      id: a.id, run: a.run, node: a.node, attempt: a.attempt, kind: a.kind, state: a.state, text: a.text, sources: JSON.parse(a.sources) as number[],
      message: a.message, question: a.question, awaits: a.awaits, invitations: this.all<{ id: number }>('SELECT id FROM invitations WHERE activity = ? ORDER BY id', a.id).map(r => r.id),
      decision: a.decision ? JSON.parse(a.decision) as ActivityView['decision'] : null, obligations: a.obligations ? JSON.parse(a.obligations) as Obligation[] : null,
      outcome: a.outcome, created: a.created, updated: a.updated,
    }
  }
  // Every change of an activity, the conductor or the requester is an event
  // that keeps what it changed to (the archive exports these).
  private activityEvent(conv: string, activity: number | null, kind: string, state: string, by: string, note: string, data: unknown) {
    this.db.prepare('INSERT INTO activity_events (conv, activity, kind, state, at, by, note, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(conv, activity, kind, state, now(), by, note, JSON.stringify(data))
  }
  // Records an activity (inside a transaction); its token (run and node)
  // makes a retried command the same row.
  private recordActivity(conv: string, o: { run: string; node: string; attempt: string | null; kind: Activity; state: ActivityState; text: string; sources: number[]; message?: number | null; question?: string | null; awaits?: string | null; decision?: unknown; obligations?: Obligation[] | null; outcome?: string | null; by: string; note: string }): { row: ActivityRow; duplicate: boolean } {
    const token = `${o.run}:${o.node}`
    const seen = this.one<ActivityRow>('SELECT * FROM activities WHERE conv = ? AND token = ?', conv, token)
    if (seen) return { row: seen, duplicate: true }
    const at = now()
    const id = Number(this.db.prepare('INSERT INTO activities (conv, run, node, attempt, kind, state, text, sources, message, question, awaits, decision, obligations, outcome, token, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(conv, o.run, o.node, o.attempt, o.kind, o.state, o.text, JSON.stringify(o.sources), o.message ?? null, o.question ?? null, o.awaits ?? null, o.decision === undefined ? null : JSON.stringify(o.decision), o.obligations ? JSON.stringify(o.obligations) : null, o.outcome ?? null, token, at, at).lastInsertRowid)
    const row = this.activityRow(id)!
    this.activityEvent(conv, id, 'activity', row.state, o.by, o.note, this.activityView(row))
    this.touch(conv)
    return { row, duplicate: false }
  }
  private updateActivity(a: ActivityRow, patch: Partial<Pick<ActivityRow, 'state' | 'outcome' | 'message'>>, by: string, note: string): ActivityRow {
    const sets = Object.keys(patch).map(k => `${k} = ?`)
    this.db.prepare(`UPDATE activities SET ${sets.join(', ')}, updated = ? WHERE id = ?`).run(...Object.values(patch).map(v => v ?? null) as (string | number | null)[], now(), a.id)
    const row = this.activityRow(a.id)!
    this.activityEvent(a.conv, a.id, 'activity', row.state, by, note, this.activityView(row))
    return row
  }

  // The conductor's run and the node an activity is performed in: the run
  // must be the facilitator's workflow, the node one of its definition whose
  // `activity` is this one (the definition says what the node is).
  private async activityNode(conv: string, run: string, node: string, kind: Activity) {
    const cfg = this.cfg()
    const { workspace, ref } = parseRunName(run)
    if (workspace !== cfg.facilitator.workspace || ref.workflow !== cfg.facilitator.workflow) throw new RequestError(403, `${kind} is the conductor's (${targetName(cfg.facilitator)}); ${run} is not its run`, { code: 'not-facilitator' })
    if (!this.exec) throw new RequestError(503, 'execution is not configured here')
    const ws = await this.exec.workspace(workspace)
    const { record, graph } = await usableRun(ws, ref)
    const n = graph.nodes[node]
    if (!n || !(node in record.nodes)) throw new RequestError(404, `${run} has no node ${node}`, { code: 'node-unknown' })
    if (n.activity !== kind) throw new RequestError(409, `node ${node} of ${run} is ${n.activity ? `the ${n.activity} activity` : `a ${n.type} node without an activity`}, not ${kind}: add it as \`activity: ${kind}\` (wfe discussion ponder --next ${kind}:<id>, or wfe run adjust)`, { code: 'activity-node' })
    return { ws, ref, record, node: record.nodes[node], conv }
  }
  // Executes one of the conductor's node operations: by its attempt (agent)
  // while one is open, else by `discussion` (WFE completing an ask).
  private async nodeOp(run: string, input: OpInput, o: { by: string; attempt?: string | null; receipt: string }) {
    const { workspace, ref } = parseRunName(run)
    const ws = await this.exec!.workspace(workspace)
    return runOp(ws, ref, { ...input, ...(o.attempt ? { attempt: o.attempt } : {}), receipt: o.receipt } as unknown as OpInput, { by: o.by, via: 'discussion' })
  }
  private async startNode(run: string, node: string, state: string, o: { by: string; attempt?: string | null; receipt: string }) {
    if (state === 'running') return
    if (state === 'completed' || state === 'cancelled' || state === 'failed') throw new RequestError(409, `node ${node} of ${run} is ${state}`, { code: 'node-state' })
    await this.nodeOp(run, { op: 'node.start', node, ...(state === 'waiting' ? { reason: 'resumed by its discussion activity' } : {}) } as OpInput, { ...o, receipt: `${o.receipt}:start` })
  }
  private async finishNode(run: string, node: string, outcome: string, o: { by: string; attempt?: string | null; receipt: string }) {
    await this.nodeOp(run, { op: 'node.complete', node, outcome } as OpInput, { ...o, receipt: `${o.receipt}:complete` })
  }

  // announce: the conductor's message to the discussion — an agenda,
  // context, an interim synthesis, a conclusion. Nobody is waited for. The
  // message (key `activity:<run>:<node>`) comes first and its node completes
  // with its id; a retry finds the same message, and reconcile completes a
  // node whose message is delivered when the attempt ended first. A
  // conclusion records what is still owed and who will receive it.
  async announce(conv: string, o: { run: string; attempt: string | null; author: string; node: string; text: string; re: number[]; invitation?: number | null; conclude?: boolean; close?: boolean }) {
    const t = await this.activityNode(conv, o.run, o.node, 'announce')
    const obligations = o.conclude ? await this.obligations(conv, { except: o.run, closing: !!o.close }) : null
    const said = await this.contribute(conv, { text: o.text, author: o.author, run: o.run, attempt: o.attempt, invitation: o.invitation ?? null, re: o.re, kind: 'announce', key: `activity:${o.run}:${o.node}`, node: o.node })
    const { row } = this.tx(() => this.recordActivity(conv, { run: o.run, node: o.node, attempt: o.attempt, kind: 'announce', state: 'completed', text: o.conclude ? 'conclusion' : '', sources: o.re, message: said.message.id, obligations, outcome: `announced #${said.message.id}`, by: o.author, note: `${o.conclude ? 'concluded' : 'announced'} #${said.message.id}${obligations ? `; ${obligations.length} obligation${obligations.length === 1 ? '' : 's'} outstanding` : ''}` }))
    if (t.node.state !== 'completed') {
      await this.startNode(o.run, o.node, t.node.state, { by: o.author, attempt: o.attempt, receipt: `discussion:${conv}:activity:${row.id}` })
      await this.finishNode(o.run, o.node, `announced #${said.message.id}${obligations ? `; conclusion with ${obligations.length} outstanding: ${obligations.map(b => `${b.ref} (${b.owes}; owner ${b.owner}; to ${b.receiver})`).join('; ') || 'none'}` : ''}`, { by: o.author, attempt: o.attempt, receipt: `discussion:${conv}:activity:${row.id}` })
    }
    const closed = o.close ? this.close(conv, { by: o.author }) : null
    return { message: said.message, duplicate: said.duplicate, activity: this.activityView(this.activityRow(row.id)!), closed }
  }

  // ask: invites participants with one question (each an invitation of this
  // activity, awaited by the conductor) and makes the node wait. When all of
  // them are resolved WFE completes the node with their outcomes and
  // continues the run. `awaitRun` asks for the result of a run already
  // working instead (a participant's run waiting for its delegated work).
  async ask(conv: string, o: { run: string; attempt: string | null; author: string; node: string; participants: string[]; question: string; re: number[]; awaitRun?: string }) {
    const t = await this.activityNode(conv, o.run, o.node, 'ask')
    if (!o.awaitRun && !o.participants.length) throw new RequestError(400, 'name whom you ask (<participant>…), or --run <run> to await its result')
    if (t.node.state === 'completed' || t.node.state === 'cancelled') throw new RequestError(409, `node ${o.node} is ${t.node.state}: an ask is a new node (wfe discussion ponder --next ask:<id>)`, { code: 'node-state' })
    const holders = o.awaitRun ? [o.awaitRun] : [...new Set(o.participants)]
    const { row, duplicate } = this.tx(() => this.recordActivity(conv, { run: o.run, node: o.node, attempt: o.attempt, kind: 'ask', state: 'waiting', text: o.question, sources: o.re, awaits: o.awaitRun ?? null, by: o.author, note: o.awaitRun ? `awaits the result of ${o.awaitRun}` : `asks ${holders.join(', ')}` }))
    const invitations: InvitationRow[] = []
    if (o.awaitRun) invitations.push((await this.awaitResult(conv, { run: o.awaitRun, note: o.question, re: o.re, by: o.author, byRun: o.run, activity: row.id })).invitation)
    else for (const p of holders) invitations.push((await this.invite(conv, { participant: p, question: o.question, re: o.re, by: o.author, byRun: o.run, token: `ask:${o.run}:${o.node}:${p}`, activity: row.id })).invitation)
    const cur = (await usableRun(t.ws, t.ref)).record.nodes[o.node]
    if (cur.state !== 'waiting') {
      const receipt = `discussion:${conv}:activity:${row.id}`
      await this.startNode(o.run, o.node, cur.state, { by: o.author, attempt: o.attempt, receipt })
      await this.nodeOp(o.run, { op: 'node.wait', node: o.node, reason: o.awaitRun ? `awaits the result of ${o.awaitRun} (activity ${row.id})` : `asked ${holders.join(', ')} (activity ${row.id})`, holder: holders.join(', '), external: `discussion:${conv}:activity:${row.id}` } as OpInput, { by: o.author, attempt: o.attempt, receipt: `${receipt}:wait` })
    }
    return { activity: this.activityView(this.activityRow(row.id)!), invitations: invitations.map(i => this.invitation(i.id)!), duplicate }
  }

  // WFE's completion of an ask whose invitations are resolved (or that was
  // settled): the node, if it still waits on this activity, resumes and
  // completes with the outcomes. Only outside an attempt (afterResolution).
  private async completeAsk(a: ActivityRow, outcomes: string): Promise<string | null> {
    const { workspace, ref } = parseRunName(a.run)
    const rec = (await readRun(await this.exec!.workspace(workspace), ref)).record as RunRecord | null
    const n = rec?.nodes[a.node]
    const receipt = `discussion:${a.conv}:activity:${a.id}:resolved`
    let note: string
    if (n?.state === 'waiting' && n.wait?.on && 'external' in n.wait.on && n.wait.on.external === `discussion:${a.conv}:activity:${a.id}`) {
      await this.startNode(a.run, a.node, 'waiting', { by: 'discussion', receipt })
      await this.finishNode(a.run, a.node, `every invitation of activity ${a.id} is resolved:\n${outcomes}`, { by: 'discussion', receipt })
      note = `node ${a.node} completed`
    } else note = `node ${a.node} is ${n?.state ?? 'gone'}; left as it is`
    this.tx(() => this.updateActivity(a, { state: 'completed', outcome: outcomes }, 'discussion', `resolved; ${note}`))
    return note
  }

  // settle: the conductor moves on before every invitation of an ask is
  // resolved. Its node completes now (from the attempt); the open ones stay
  // open and their outcomes are told later as late outcomes of this ask.
  async settle(conv: string, o: { run: string; attempt: string | null; author: string; node: string; reason: string }) {
    const t = await this.activityNode(conv, o.run, o.node, 'ask')
    const a = this.one<ActivityRow>('SELECT * FROM activities WHERE conv = ? AND token = ?', conv, `${o.run}:${o.node}`)
    if (!a) throw new RequestError(404, `node ${o.node} asked nothing yet (wfe discussion ask)`, { code: 'no-activity' })
    if (a.state !== 'waiting') return { activity: this.activityView(a), duplicate: true }
    if (!o.reason.trim()) throw new RequestError(400, 'say why you move on (--reason)')
    const invs = this.all<InvitationRow>('SELECT * FROM invitations WHERE activity = ? ORDER BY id', a.id)
    const lines = invs.map(i => `- invitation ${i.id} (${i.participant}${i.run ? ` ${i.run}` : ''}): ${label(i)}${i.answered_by ? ` by #${i.answered_by}` : ''}`)
    const outcome = `settled by the conductor: ${o.reason.trim()}\n${lines.join('\n')}`
    const receipt = `discussion:${conv}:activity:${a.id}:settle`
    await this.startNode(o.run, o.node, t.node.state, { by: o.author, attempt: o.attempt, receipt })
    await this.finishNode(o.run, o.node, outcome, { by: o.author, attempt: o.attempt, receipt })
    const row = this.tx(() => {
      for (const i of invs) if (resolved(i.state)) this.db.prepare('UPDATE invitations SET reported = ? WHERE id = ?').run(label(i), i.id)
      return this.updateActivity(a, { state: 'settled', outcome }, o.author, `settled with ${invs.filter(i => !resolved(i.state)).length} open: ${o.reason.trim()}`)
    })
    return { activity: this.activityView(row), duplicate: false }
  }

  // ponder: the conductor's decision — what is settled, what is missing, what
  // comes next and why — with the messages it rests on. Its node completes
  // with the decision; `next` (a chain of activities after this node) or a
  // whole definition records the run revision in the same operation.
  async ponder(conv: string, o: { run: string; attempt: string | null; author: string; node: string; decision: string; sources: number[]; next?: { activity: string; node: string; name?: string; description?: string }[]; definition?: string }) {
    const t = await this.activityNode(conv, o.run, o.node, 'ponder')
    if (!o.decision.trim()) throw new RequestError(400, 'say what you decided and why (--decision)')
    const sources = this.validRe(conv, o.sources)
    const seen = this.one<ActivityRow>('SELECT * FROM activities WHERE conv = ? AND token = ?', conv, `${o.run}:${o.node}`)
    if (seen) return { activity: this.activityView(seen), revision: (JSON.parse(seen.decision ?? 'null') as ActivityView['decision'])?.revision ?? null, duplicate: true }
    const next = o.next ?? []
    for (const x of next) if (!(ACTIVITIES as readonly string[]).includes(x.activity)) throw new RequestError(400, `--next ${x.activity}:${x.node}: the activities are ${ACTIVITIES.join(', ')}`)
    const receipt = `discussion:${conv}:ponder:${o.run}:${o.node}`
    let revision: string | null = null
    if (next.length || o.definition) {
      await this.startNode(o.run, o.node, t.node.state, { by: o.author, attempt: o.attempt, receipt })
      let text = o.definition
      if (!text) {
        const { record, bundle } = await usableRun(t.ws, t.ref)
        const active = activeDefinition(record, bundle)
        const parsed = parseWorkflow(active.text)
        if (!parsed.ok) throw new RequestError(409, `the run's definition cannot be read: ${parsed.problem.message}`)
        const w = parsed.model
        let prev = o.node
        for (const x of next) {
          if (x.node in w.nodes) throw new RequestError(409, `node ${x.node} is already in ${o.run}: a new activity is a new node (another id)`, { code: 'node-exists' })
          w.nodes[x.node] = { type: x.activity === 'talk' ? 'talk' : 'do', activity: x.activity, name: x.name ?? x.node, description: x.description ?? ACTIVITY_DESCRIPTIONS[x.activity as Activity], repositories: [] }
          w.edges.push({ from: prev, to: x.node })
          prev = x.node
        }
        text = renderWorkflow(parsed.doc, w)
      }
      const r = await adjustRun(t.ws, t.ref, { text, reason: o.decision.trim(), source: { kind: 'agent' }, completing: { node: o.node, outcome: o.decision.trim() } } as unknown as Parameters<typeof adjustRun>[2], { by: o.author, via: 'discussion', attempt: o.attempt ?? undefined, receipt })
      if (!r.ok) throw new RequestError(409, `the revision was not recorded: ${r.problems.map(p => p.message).join('; ')}`, { code: 'adjust', problems: r.problems })
      revision = r.revision ?? null
    } else if (t.node.state !== 'completed') {
      await this.startNode(o.run, o.node, t.node.state, { by: o.author, attempt: o.attempt, receipt })
      await this.finishNode(o.run, o.node, o.decision.trim(), { by: o.author, attempt: o.attempt, receipt })
    }
    const { row } = this.tx(() => this.recordActivity(conv, { run: o.run, node: o.node, attempt: o.attempt, kind: 'ponder', state: 'completed', text: o.decision.trim(), sources, decision: { next: next.map(x => ({ activity: x.activity, node: x.node })), revision }, outcome: revision ? `revision ${revision}` : 'no graph change', by: o.author, note: next.length ? `next: ${next.map(x => `${x.activity}:${x.node}`).join(' → ')}` : revision ? `revision ${revision}` : 'decided; no graph change' }))
    // The conductor's revision is recorded as its progression, with this
    // activity (argue p4 ex3); a failure here leaves it to the reconcile's repair.
    if (revision) await new ConversationWorkflows(this).deriveRun(conv, o.run).catch(() => undefined)
    return { activity: this.activityView(row), revision, duplicate: false }
  }

  // A question is one thing (workflow_editor fix3): the run's WFE question
  // (`wfe run ask`), whoever asks it. Every open question of a run that speaks
  // for a discussion is posted here by WFE, so everyone reads it and the
  // person's reply naming it comes back to that run as the answer (post). On
  // the conductor's talk node it is the talk activity. Called after `wfe run
  // ask` and by the reconcile; the key makes it one message per question.
  // (ponderer/conduct/run-020 relayed a delegated child's question with `wfe
  // run ask`; nothing reached the discussion, which said it awaited nobody.)
  async postQuestions(o: { run?: string; conv?: string } = {}): Promise<string[]> {
    const notes: string[] = []
    if (!this.exec) return notes
    const cfg = this.cfg()
    const wfs = new ConversationWorkflows(this)
    const convs = o.conv ? [o.conv] : this.list().filter(c => c.state === 'open').map(c => c.id)
    for (const conv of convs) for (const run of wfs.runsOf(conv)) {
      if (o.run && run !== o.run) continue
      try {
        const { workspace, ref } = parseRunName(run)
        const { record, graph } = await usableRun(await this.exec.workspace(workspace), ref)
        if (['completed', 'cancelled'].includes(situation(record))) continue
        for (const q of Object.values(record.questions)) {
          if (q.answers.length || q.takenUp || q.withdrawn) continue
          if (this.one<MessageRow>('SELECT id FROM messages WHERE conv = ? AND run = ? AND question = ?', conv, run, q.id)) continue
          const inv = this.invitations(conv).find(i => i.run === run)
          const re = inv ? (JSON.parse(inv.source) as number[]).filter(n => this.cs.message(n)?.conv === conv).slice(0, 1) : []
          const said = await this.contribute(conv, { text: q.text, author: q.askedBy, run, attempt: null, re, kind: 'question', question: q.id, key: `question:${run}:${q.id}`, node: q.node })
          if (said.duplicate) continue
          notes.push(`discussion ${conv}: ${run} ${q.id} to ${q.to} posted as #${said.message.id}`)
          const talk = q.node && graph.nodes[q.node]?.activity === 'talk' && workspace === cfg.facilitator.workspace && ref.workflow === cfg.facilitator.workflow
          if (talk && !this.one<ActivityRow>('SELECT id FROM activities WHERE conv = ? AND token = ?', conv, `${run}:${q.node}`)) {
            this.tx(() => this.recordActivity(conv, { run, node: q.node!, attempt: null, kind: 'talk', state: 'waiting', text: q.text, sources: re, message: said.message.id, question: q.id, by: q.askedBy, note: `asked ${q.to} (${q.id}) #${said.message.id}` }))
          }
        }
      } catch { /* unreadable (a retired project's run): read again next time */ }
    }
    return notes
  }

  // The questions still waiting for an answer: those the messages leave open
  // whose WFE question is not answered, taken up or withdrawn either (argue p4
  // step 5: an agent requester answers through its delegation, never with a
  // message here — conduct/run-004 q1 stayed "waiting for the person").
  async openAsking(conv: string, rows: MessageRow[] = this.messages(conv)): Promise<number[]> {
    const out: number[] = []
    for (const n of pendingQuestions(rows)) {
      const m = this.cs.message(n)
      if (m?.run && m.question && this.exec) {
        try {
          const { workspace, ref } = parseRunName(m.run)
          const q = ((await readRun(await this.exec.workspace(workspace), ref)).record as RunRecord | null)?.questions[m.question]
          if (q && (q.answers.length || q.takenUp || q.withdrawn)) continue
        } catch { /* unreadable: still listed */ }
      }
      out.push(n)
    }
    return out
  }

  // What is still owed in a discussion, and who receives it when it comes
  // (argue p4): open invitations and awaited results, questions to the
  // person, runs of the discussion still working and their delegated work.
  async obligations(conv: string, o: { except?: string; closing?: boolean } = {}): Promise<Obligation[]> {
    const c = this.need(conv)
    const closed = o.closing || c.state === 'closed'
    const runState = new Map<string, RunRecord | null>()
    const rec = async (run: string) => {
      if (!runState.has(run)) {
        try { const { workspace, ref } = parseRunName(run); runState.set(run, this.exec ? (await readRun(await this.exec.workspace(workspace), ref)).record as RunRecord | null : null) } catch { runState.set(run, null) }
      }
      return runState.get(run) ?? null
    }
    const ended = (r: RunRecord | null) => !!r && ['completed', 'cancelled'].includes(situation(r))
    const receiver = async (run: string | null) => {
      if (closed) return 'recorded only: the conversation is closed (reopen to continue)'
      if (!run) return 'nobody awaits it: recorded in the discussion'
      if (run === o.except) return `a new ${this.cfg().facilitator.workspace} turn (${run} will have completed)`
      return ended(await rec(run)) ? `a new ${this.cfg().facilitator.workspace} turn (${run} has ended)` : run
    }
    const out: Obligation[] = []
    for (const i of this.invitations(conv).filter(x => OPEN_STATES.includes(x.state))) {
      if (i.run === o.except) continue
      out.push({ kind: i.awaits ? 'result' : 'invitation', ref: `invitation ${i.id}`, owes: i.awaits ? `the result of ${i.run}` : `a reply from ${i.participant}`, owner: i.run ?? i.participant, receiver: await receiver(i.awaited_by), since: i.created })
    }
    // Continuations held while closed or no longer facilitated: what was
    // awaited has come, and is taken up only on an explicit resume.
    const held = new Map<string, InvitationRow[]>()
    for (const i of this.invitations(conv).filter(x => x.held)) held.set(`${i.awaited_by}:${i.activity ?? ''}`, [...held.get(`${i.awaited_by}:${i.activity ?? ''}`) ?? [], i])
    for (const g of held.values()) out.push({ kind: 'continuation', ref: `request ${g.map(i => i.id).join(', ')}`, owes: `the outcomes awaited by ${g[0].awaited_by}, told to nobody yet`, owner: 'the person (wfe conversation resume)', receiver: `held: ${g[0].held}`, since: g[0].updated })
    const rows = this.messages(conv)
    for (const n of await this.openAsking(conv, rows)) {
      const m = this.cs.message(n)!
      out.push({ kind: 'question', ref: `#${n}`, owes: `an answer to ${m.participant ?? m.author}${m.question ? ` (${m.question})` : ''}`, owner: (() => { const r = this.requester(conv); return r?.kind === 'run' ? r.run : r?.id ?? this.cfg().person })(), receiver: m.run ? await receiver(m.run) : 'the discussion', since: m.at })
    }
    const runs = new Set<string>()
    for (const i of this.invitations(conv)) if (i.run) runs.add(i.run)
    for (const l of this.cs.links(conv)) runs.add(l.run)
    for (const run of runs) {
      if (run === o.except) continue
      const r = await rec(run)
      if (!r || ended(r)) continue
      if (!out.some(x => x.owner === run)) out.push({ kind: 'run', ref: run, owes: `its work (${situation(r)})`, owner: run, receiver: closed ? 'recorded only: the conversation is closed (reopen to continue)' : 'its own contributions here', since: r.created, situation: situation(r) })
      for (const d of Object.values(r.delegations ?? {}).filter(isOpenDelegation)) {
        const child = d.child ? `${d.child.workspace}/${d.child.workflow}/${d.child.run}` : `${d.target.project ?? ''}/${d.target.workflow} (not created yet)`
        out.push({ kind: 'delegation', ref: child, owes: `its result to ${run} (delegation ${d.id})`, owner: child, receiver: run, since: d.dispatched.at })
      }
    }
    return out
  }

  // An annotation: an intervention, a recovery, an evaluation, a correction
  // or a note by someone outside the speech, about some messages. It never
  // starts anything and is never speech.
  annotate(conv: string, o: { kind: string; author: string; text: string; re?: number[]; run?: string | null; token?: string }): { annotation: AnnotationRow; duplicate: boolean } {
    this.need(conv)
    if (!(ANNOTATION_KINDS as readonly string[]).includes(o.kind)) throw new RequestError(400, `an annotation is one of ${ANNOTATION_KINDS.join(', ')}`)
    if (!o.text.trim()) throw new RequestError(400, 'the annotation is empty')
    if (o.text.length > MAX_TEXT) throw new RequestError(413, `an annotation is at most ${MAX_TEXT} characters`)
    if (o.run) parseRunName(o.run)
    const re = this.validRe(conv, o.re ?? [])
    const token = o.token ?? `${o.author}:${createHash('sha256').update(`${o.kind}\n${o.text}\n${re.join(',')}`).digest('hex').slice(0, 24)}`
    return this.tx(() => {
      const seen = this.one<AnnotationRow>('SELECT * FROM annotations WHERE conv = ? AND token = ?', conv, token)
      if (seen) return { annotation: seen, duplicate: true }
      const id = Number(this.db.prepare('INSERT INTO annotations (conv, kind, author, text, re, run, at, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(conv, o.kind, o.author, o.text, JSON.stringify(re), o.run ?? null, now(), token).lastInsertRowid)
      this.touch(conv)
      return { annotation: this.one<AnnotationRow>('SELECT * FROM annotations WHERE id = ?', id)!, duplicate: false }
    })
  }

  // Reconcile's part for activities: a node whose message was delivered but
  // which the attempt left running is completed with that message (and a
  // hold caused only by it is lifted); a talk whose question was taken up or
  // withdrawn is recorded so.
  private async reconcileActivities(): Promise<string[]> {
    const notes: string[] = []
    if (!this.exec) return notes
    const since = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const cfg = this.config()
    const discussWorkflows = 'disabled' in cfg ? [] : cfg.projects.flatMap(p => [p.converse, p.discuss].filter((w): w is string => !!w).map(w => `${p.workspace}/${w}`))
    // Messages spoken for a node, and replies answering a participant's own
    // invitation (a one-node discussion turn), from the last two days.
    const spoken = this.all<MessageRow>('SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conv WHERE m.role = \'agent\' AND m.run IS NOT NULL AND m.at >= ? AND (m.node IS NOT NULL OR m.invitation IS NOT NULL) ORDER BY m.id', since)
    const done = new Set<string>()
    for (const m of spoken) {
      const key = `${m.run}:${m.node ?? ''}`
      if (done.has(key)) continue
      try {
        const { workspace, ref } = parseRunName(m.run!)
        const ws = await this.exec.workspace(workspace)
        const { record, graph } = await usableRun(ws, ref)
        if (record.control.attempt || ['completed', 'cancelled'].includes(situation(record))) continue
        let node = m.node ?? null
        if (!node) {
          // A participant's turn (p3: rts-vs-bot/discuss/run-001, run-004
          // spoke and left their only node running): its one authored node.
          if (!ANSWERING.includes(m.kind) || !discussWorkflows.includes(`${workspace}/${ref.workflow}`)) continue
          const authored = Object.keys(graph.nodes).filter(n => !graph.nodes[n].step)
          if (authored.length !== 1) continue
          node = authored[0]
        }
        done.add(`${m.run}:${m.node ?? ''}`)
        if (record.nodes[node]?.state !== 'running') continue
        const receipt = `discussion:${m.conv}:delivered:${m.id}`
        await runOp(ws, ref, { op: 'node.complete', node, outcome: `delivered #${m.id} in discussion ${m.conv}; the attempt ${m.attempt ?? ''} ended without completing ${node}, so WFE recorded it`, receipt: `${receipt}:complete` } as OpInput & { receipt: string }, { by: 'discussion', via: 'discussion' })
        notes.push(`discussion ${m.conv}: ${m.run} ${node} completed with #${m.id} (delivered, left running)`)
        const after = (await readRun(ws, ref)).record as RunRecord
        const hold = after.control.hold
        if (hold?.cause?.code === 'left-running' && hold.cause.nodes.every(n => after.nodes[n]?.state === 'completed')) {
          await runOp(ws, ref, { op: 'run.resume', reason: `discussion ${m.conv}: ${hold.cause.nodes.join(', ')} had delivered #${m.id}; WFE recorded the completion the attempt left out`, receipt: `${receipt}:resume` } as OpInput & { receipt: string }, { by: 'discussion', via: 'discussion' })
          notes.push(`discussion ${m.conv}: ${m.run} hold lifted (it was only ${hold.cause.nodes.join(', ')} left running)`)
        }
      } catch { /* read again next time */ }
    }
    for (const a of this.all<ActivityRow>('SELECT * FROM activities WHERE kind = \'talk\' AND state = \'waiting\'')) {
      try {
        const { workspace, ref } = parseRunName(a.run)
        const rec = (await readRun(await this.exec.workspace(workspace), ref)).record as RunRecord | null
        const q = rec && a.question ? rec.questions[a.question] : undefined
        if (q?.takenUp || q?.withdrawn) {
          const ans = q.takenUp ? q.answers[q.takenUp.answer] : null
          this.tx(() => this.updateActivity(a, { state: q.takenUp ? 'completed' : 'withdrawn', outcome: q.takenUp ? `answered by ${ans?.from ?? '?'}${ans?.source && 'message' in ans.source ? ` (#${(ans.source as { message: number }).message})` : ''}: ${ans?.text.slice(0, 200) ?? ''}` : `withdrawn: ${q.withdrawn!.reason}` }, 'discussion', q.takenUp ? `${a.question} taken up` : `${a.question} withdrawn`))
        } else if (rec && ['completed', 'cancelled'].includes(situation(rec))) this.tx(() => this.updateActivity(a, { state: 'withdrawn', outcome: `${a.run} ended (${situation(rec)}) with ${a.question} unanswered` }, 'discussion', 'its run ended'))
      } catch { /* read again next time */ }
    }
    return notes
  }

  // ---- closing and reopening -------------------------------------------------------

  // Ends automatic dispatch: requests not started are withdrawn, started
  // ones finish and are recorded, nothing downstream is cancelled, and no
  // conductor is continued while closed (its continuation is held).
  close(conv: string, o: { by: string }): { conversation: ConversationRow; withdrawn: number[] } {
    this.need(conv)
    return this.tx(() => {
      this.db.prepare('UPDATE conversations SET state = \'closed\', updated = ? WHERE id = ?').run(now(), conv)
      const pending = this.all<InvitationRow>('SELECT * FROM invitations WHERE conv = ? AND state IN (\'pending\', \'failed\')', conv)
      for (const i of pending) this.withdrawRow(i, `the conversation was closed by ${o.by}`)
      return { conversation: this.cs.conversation(conv)!, withdrawn: pending.map(i => i.id) }
    })
  }
  // The conversation continues; nothing withdrawn, completed or held is
  // replayed (held continuations wait for resume).
  reopen(conv: string, o: { by: string }): ConversationRow {
    this.need(conv)
    void o
    this.db.prepare('UPDATE conversations SET state = \'open\', updated = ? WHERE id = ?').run(now(), conv)
    return this.cs.conversation(conv)!
  }

  // A run's own discussion and invitation, read from its record's source.
  async runSource(run: string): Promise<{ conversation: string; invitation: number | null } | null> {
    if (!this.exec) return null
    const { workspace, ref } = parseRunName(run)
    const rec = (await readRun(await this.exec.workspace(workspace), ref)).record as RunRecord | null
    const s = rec?.input.source
    if (s?.kind !== 'conversation' || !this.conversation(s.conversation)) return null
    return { conversation: s.conversation, invitation: s.invitation ?? null }
  }

  private validRe(conv: string, re: number[]): number[] {
    if (!Array.isArray(re) || !re.every(n => Number.isInteger(n))) throw new RequestError(400, 're is a list of message ids')
    for (const n of re) { const m = this.cs.message(n); if (!m || m.conv !== conv) throw new RequestError(400, `message #${n} is not in discussion ${conv}`) }
    return [...new Set(re)]
  }

  // ---- reading: category, display title, overview, status (argue p4 ex2) ----------

  metaRows(conv: string, since = 0): MetaRow[] { return this.all<MetaRow>('SELECT * FROM discussion_meta WHERE conv = ? AND id > ? ORDER BY id', conv, since) }

  // Corrects a discussion's category or display title, each change recorded
  // with who and why. Nothing else moves: no message, no invitation, no run,
  // no reopening, and not `updated` (the list's order is the conversation's).
  //
  // `ifUntitled` (challenge p4) names a conversation that nobody has titled
  // yet: the display title is written only when the conversation has none
  // and no display-title record at all — a person's edit, and their reset to
  // the original too, are records and win. The check and the write are one
  // write transaction, so an edit that lands first is kept; one that lands
  // after is an ordinary later change. Otherwise `skipped` names the record
  // that won, and nothing about the title is written.
  setMeta(conv: string, o: { category?: string; displayTitle?: string | null; ifUntitled?: boolean; by: string; run?: string | null; note?: string }): { conversation: ConversationRow; changed: MetaRow[]; skipped: TitleSkip | null } {
    this.need(conv)
    if (o.category === undefined && o.displayTitle === undefined) throw new RequestError(400, 'nothing to change: name a category or a display title')
    const category = o.category === undefined ? undefined : categoryOf(o.category)
    const title = displayTitleOf(o.displayTitle)
    if (o.ifUntitled && !title) throw new RequestError(400, 'ifUntitled names a display title to give an untitled conversation')
    if (o.run) parseRunName(o.run)
    return this.tx(() => {
      const c = this.cs.conversation(conv)!
      const ids: number[] = []
      const at = now()
      const record = (field: MetaRow['field'], value: string | null) => ids.push(Number(this.db.prepare('INSERT INTO discussion_meta (conv, field, value, by, run, at, note) VALUES (?, ?, ?, ?, ?, ?, ?)').run(conv, field, value, o.by, o.run ?? null, at, o.note?.trim() ?? '').lastInsertRowid))
      if (category !== undefined && category !== (c.category === 'check' ? 'check' : 'conversation')) { this.db.prepare('UPDATE conversations SET category = ? WHERE id = ?').run(category, conv); record('category', category) }
      let skipped: TitleSkip | null = null
      if (title !== undefined && o.ifUntitled) {
        const prior = this.one<MetaRow>('SELECT * FROM discussion_meta WHERE conv = ? AND field = \'displayTitle\' ORDER BY id DESC LIMIT 1', conv)
        if (prior) skipped = { reason: 'titled', value: prior.value, by: prior.by, run: prior.run, at: prior.at, meta: prior.id }
        else if (c.display_title) skipped = { reason: 'titled', value: c.display_title, by: null, run: null, at: null, meta: null }
      }
      if (title !== undefined && !skipped && title !== (c.display_title ?? null)) { this.db.prepare('UPDATE conversations SET display_title = ? WHERE id = ?').run(title, conv); record('displayTitle', title) }
      return { conversation: this.cs.conversation(conv)!, changed: ids.map(id => this.one<MetaRow>('SELECT * FROM discussion_meta WHERE id = ?', id)!), skipped }
    })
  }

  overviewRows(conv: string, since = 0): OverviewRow[] { return this.all<OverviewRow>('SELECT * FROM overviews WHERE conv = ? AND id > ? ORDER BY id', conv, since) }
  overviewView(r: OverviewRow): Overview {
    const after = this.one<{ n: number }>('SELECT count(*) AS n FROM messages WHERE conv = ? AND id > ?', r.conv, r.through)!.n
    return { id: r.id, author: r.author, run: r.run, purpose: r.purpose, outcome: r.outcome, unresolved: JSON.parse(r.unresolved) as string[], through: r.through, sources: JSON.parse(r.sources) as number[], note: r.note, at: r.at, after }
  }
  // The current overview: the newest revision. Earlier ones stay readable.
  overview(conv: string): Overview | null {
    const r = this.one<OverviewRow>('SELECT * FROM overviews WHERE conv = ? ORDER BY id DESC LIMIT 1', conv)
    return r ? this.overviewView(r) : null
  }

  // An overview: what the discussion is trying to establish, its current
  // outcome and what is unresolved, each statement citing the messages it
  // rests on ([#n]), covering the speech through one message. It is an
  // interpretation with sources — not speech, not agreement, not the
  // discussion's execution state — and starts nothing. From a run it is the
  // facilitator's or the archive project's; outside a run it is whoever is
  // named (the person, an outside agent), as recorded.
  //
  // A title given with it is written as `setMeta` writes one, after the
  // overview, and `ifUntitled` applies there: a title that is skipped never
  // keeps the overview from being published. A duplicate overview (the same
  // token) still passes its title on, so `ifUntitled` is what keeps a
  // repeated submission from renaming anything.
  publishOverview(conv: string, o: { purpose: string; outcome?: string | null; unresolved?: string[]; through?: number; title?: string | null; ifUntitled?: boolean; note?: string; author: string; run?: string | null; token?: string }): { overview: Overview; duplicate: boolean; changed: MetaRow[]; skipped: TitleSkip | null } {
    this.need(conv)
    const title = displayTitleOf(o.title)
    if (o.ifUntitled && !title) throw new RequestError(400, 'ifUntitled names a display title to give an untitled conversation')
    const cfg = this.cfg()
    if (o.run) {
      const { workspace } = parseRunName(o.run)
      if (workspace !== cfg.facilitator.workspace && workspace !== cfg.archive?.workspace) throw new RequestError(403, `an overview is the facilitator's or the archive project's (${[cfg.facilitator.workspace, cfg.archive?.workspace].filter(Boolean).join(', ')}); a participant says what it thinks in a reply`, { code: 'not-facilitator' })
    }
    const purpose = o.purpose.trim()
    const outcome = o.outcome?.trim() || null
    const unresolved = (o.unresolved ?? []).map(u => u.trim()).filter(Boolean)
    if (!purpose) throw new RequestError(400, 'an overview states the purpose')
    for (const t of [purpose, outcome ?? '', ...unresolved]) if (t.length > MAX_OVERVIEW) throw new RequestError(413, `each part of an overview is at most ${MAX_OVERVIEW} characters`)
    const newest = this.horizon(conv).message
    const through = o.through ?? newest
    const at = this.cs.message(through)
    if (!at || at.conv !== conv) throw new RequestError(400, through ? `message #${through} is not in ${conv}` : `${conv} has no message to summarise yet`)
    const cite = (part: string, text: string) => {
      const ns = citations(text)
      if (!ns.length) throw new RequestError(400, `the ${part} cites no message: write the messages it rests on as [#n]`, { code: 'no-source' })
      for (const n of ns) {
        const m = this.cs.message(n)
        if (!m || m.conv !== conv) throw new RequestError(400, `the ${part} cites #${n}, which is not a message of ${conv}`, { code: 'bad-source' })
        if (n > through) throw new RequestError(400, `the ${part} cites #${n}, newer than the message it covers through (#${through})`, { code: 'bad-source' })
      }
      return ns
    }
    const sources = [...new Set([...cite('purpose', purpose), ...(outcome ? cite('outcome', outcome) : []), ...unresolved.flatMap((u, i) => cite(`unresolved point ${i + 1}`, u))])].sort((a, b) => a - b)
    const token = o.token ?? `${o.author}:${createHash('sha256').update(JSON.stringify([purpose, outcome, unresolved, through])).digest('hex').slice(0, 24)}`
    const r = this.tx(() => {
      const seen = this.one<OverviewRow>('SELECT * FROM overviews WHERE conv = ? AND token = ?', conv, token)
      if (seen) return { row: seen, duplicate: true }
      const id = Number(this.db.prepare('INSERT INTO overviews (conv, author, run, purpose, outcome, unresolved, through, sources, note, at, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(conv, o.author, o.run ?? null, purpose, outcome, JSON.stringify(unresolved), through, JSON.stringify(sources), o.note?.trim() ?? '', now(), token).lastInsertRowid)
      return { row: this.one<OverviewRow>('SELECT * FROM overviews WHERE id = ?', id)!, duplicate: false }
    })
    const t = title !== undefined ? this.setMeta(conv, { displayTitle: title, ifUntitled: o.ifUntitled, by: o.author, run: o.run, note: o.note?.trim() || 'with an overview' }) : null
    return { overview: this.overviewView(r.row), duplicate: r.duplicate, changed: t?.changed ?? [], skipped: t?.skipped ?? null }
  }

  // The opening request, for a discussion without an overview: the earliest
  // of the person's messages and the conductor's announcements (a discussion
  // the conductor opened quotes its request there).
  brief(conv: string): Brief | null {
    const m = this.one<MessageRow>('SELECT * FROM messages WHERE conv = ? AND (role = \'person\' OR kind = \'announce\') ORDER BY id LIMIT 1', conv)
    return m ? { message: m.id, author: m.author, participant: m.participant, text: m.text.length > 400 ? `${m.text.slice(0, 400)}…` : m.text } : null
  }

  // Where the discussion stands, from its records: what is still owed (also
  // in a closed room), whose answer is awaited — the configured person's
  // only when the question's receiver is that person (a talk goes to the
  // requester, which may be a run) — failed invitations and held runs.
  async status(conv: string): Promise<DiscussionStatus> {
    const c = this.need(conv)
    const cfg = this.cfg()
    const obligations = await this.obligations(conv)
    const req = this.requester(conv)
    const talks = this.activityRows(conv).filter(a => a.kind === 'talk')
    // Any other question goes to whom the run asked it (fix3): a person
    // member, or the agent whose run relays it (the requesting run's).
    const people = new Set([cfg.person, ...this.members(conv).filter(x => x.kind === 'person').map(x => x.participant)])
    const askedTo = async (m: MessageRow) => {
      if (!m.run || !m.question || !this.exec) return null
      try { const { workspace, ref } = parseRunName(m.run); return ((await readRun(await this.exec.workspace(workspace), ref)).record as RunRecord | null)?.questions[m.question]?.to ?? null } catch { return null }
    }
    const awaiting = await Promise.all((await this.openAsking(conv)).map(async n => {
      const m = this.cs.message(n)!
      const to = talks.some(t => t.message === n) ? null : await askedTo(m)
      const receiver = talks.some(t => t.message === n) && req
        ? req.kind === 'run' ? { kind: 'run' as const, id: req.run, agent: req.agent } : { kind: 'person' as const, id: req.id, agent: null }
        : !to || people.has(to) ? { kind: 'person' as const, id: to ?? cfg.person, agent: null }
        : { kind: 'run' as const, id: req?.kind === 'run' && req.agent === to ? req.run : to, agent: to }
      return { message: n, question: m.question, from: m.participant ?? m.author, receiver, you: receiver.kind === 'person' && receiver.id === cfg.person }
    }))
    return {
      room: c.state, working: obligations.filter(b => b.kind !== 'question').length, owed: obligations.length, awaiting,
      failed: this.invitations(conv).filter(i => i.state === 'failed').map(i => ({ invitation: i.id, participant: i.participant, error: i.error })),
      held: obligations.filter(b => b.kind === 'run' && ['stopped', 'interrupted', 'unknown'].includes(b.situation ?? '')).map(b => ({ run: b.ref, situation: b.situation! })),
      continuations: obligations.filter(b => b.kind === 'continuation').map(b => ({ requests: b.ref.replace(/^request /, '').split(', ').map(Number), awaitedBy: b.owes.replace(/^the outcomes awaited by (.*), told to nobody yet$/, '$1'), why: b.receiver.replace(/^held: /, '') })),
    }
  }

  // The list as readers use it: one category and state at a time, a page at
  // a time, with the counts of every view. Overview, brief and status are
  // read for the page's rows only; no transcript is read for the list.
  // `with` keeps the conversations a participant is a member of; `mode`
  // those of one mode (direct, group, facilitated).
  async listing(o: { category?: string; state?: string; limit?: number; offset?: number; with?: string; mode?: string } = {}) {
    if (o.mode !== undefined && !['direct', 'group', 'facilitated'].includes(o.mode)) throw new RequestError(400, 'mode is direct, group or facilitated')
    const all = this.list().filter(d => (!o.with || d.members.includes(o.with)) && (!o.mode || d.mode === o.mode))
    const cat = (d: ConversationRow) => d.category === 'check' ? 'check' : 'conversation'
    const counts = Object.fromEntries(CATEGORIES.map(k => [k, { open: all.filter(d => cat(d) === k && d.state === 'open').length, closed: all.filter(d => cat(d) === k && d.state === 'closed').length }]))
    const want = o.category === undefined ? undefined : categoryOf(o.category)
    if (o.state !== undefined && !['open', 'closed', 'all'].includes(o.state)) throw new RequestError(400, 'state is open, closed or all')
    const rows = all.filter(d => (want === undefined || cat(d) === want) && (!o.state || o.state === 'all' || d.state === o.state))
    const offset = Math.max(0, o.offset ?? 0)
    const page = rows.slice(offset, o.limit === undefined ? undefined : offset + Math.max(1, o.limit))
    return {
      counts, total: rows.length, offset,
      conversations: await Promise.all(page.map(async d => {
        const overview = this.overview(d.id)
        const members = this.members(d.id)
        return { ...d, category: cat(d), displayTitle: d.display_title ?? null, defaultTo: d.default_to ?? null, overview, brief: overview ? null : this.brief(d.id), status: await this.status(d.id), participants: members.filter(m => m.kind !== 'person').map(m => m.participant) }
      })),
    }
  }

  // ---- the view --------------------------------------------------------------------

  message(m: MessageRow, viewBase?: string | null): DiscussionMessage {
    const run = m.run ?? null
    const requests = m.role === 'person' ? this.all<{ id: number }>('SELECT id FROM invitations WHERE conv = ? AND token LIKE ? ORDER BY id', m.conv, `message:${m.id}:%`).map(r => r.id) : []
    return { requests, id: m.id, role: m.role, author: m.author, participant: m.participant, text: m.text, at: m.at, via: m.via, re: JSON.parse(m.re) as number[], kind: m.kind, run, runUrl: run ? runUrl(viewBase, run) : null, attempt: m.attempt, question: m.question, invitation: m.invitation, addressed: m.addressed ? JSON.parse(m.addressed) as string[] : [], node: m.node ?? null }
  }
  invitationView(i: InvitationRow, viewBase?: string | null): Invitation {
    return { id: i.id, participant: i.participant, target: `${i.workspace}/${i.workflow}`, question: i.question, source: JSON.parse(i.source) as number[], by: i.by, byRun: i.by_run, awaitedBy: i.awaited_by, horizon: i.horizon, state: i.state, late: !!i.late, run: i.run, runUrl: i.run ? runUrl(viewBase, i.run) : null, error: i.error, tries: i.tries, created: i.created, updated: i.updated, answeredBy: i.answered_by, reported: i.reported, deliveredTo: i.delivery && !(JSON.parse(i.delivery) as { instruct?: boolean }).instruct ? (JSON.parse(i.delivery) as { message: number }).message : null, instruct: !!i.delivery && !!(JSON.parse(i.delivery) as { instruct?: boolean }).instruct, awaits: i.awaits ?? null, activity: i.activity ?? null, role: i.role ?? null, receipt: i.receipt ?? null, held: i.held ?? null }
  }

  // The conversation with its members and their history, its facilitation,
  // every message (the person's words verbatim, with the requests each made;
  // each agent message with its participant, run and request), the requests
  // and their runs as their records say now,
  // the questions waiting for the person, and the archive's state when an
  // archive status reader is given.
  async view(conv: string, o: { viewBase?: string | null; since?: number } = {}) {
    const c = this.need(conv)
    const rows = this.messages(conv)
    const invitations = this.invitations(conv)
    const links = this.cs.links(conv)
    const keys = new Map<string, Set<string>>()
    const add = (k: string, rel: string) => { if (!keys.has(k)) keys.set(k, new Set()); keys.get(k)!.add(rel) }
    for (const i of invitations) if (i.run) add(i.run, i.awaits ? `awaited result (request ${i.id})` : `request ${i.id}`)
    for (const l of links) add(l.run, l.relation)
    if (c.conductor) add(c.conductor, 'conductor')
    const runs: RunEntry[] = await this.cs.runEntries([...keys].map(([key, rel]) => ({ key, relation: [...rel].join(', ') })), o.viewBase)
    // Speech of a project no longer registered here (argue p4 ex1: argue's
    // runs) keeps its run name; it gets no run-view link that opens nothing.
    const known = this.exec ? new Set((await loadRegistry(this.exec.ctx.registryFile)).workspaces.map(w => w.id)) : null
    const linkable = (run: string | null) => !run || !known || known.has(parseRunName(run).workspace)
    const attached = await this.cs.attachmentViews(conv)
    return {
      conversation: { id: c.id, title: c.title, created: c.created, updated: c.updated, state: c.state, by: c.by, origin: c.kind, category: c.category === 'check' ? 'check' : 'conversation', displayTitle: c.display_title ?? null, defaultTo: c.default_to ?? null, mode: this.mode(conv), conductor: c.conductor ?? null, requester: this.requester(conv), facilitation: this.facilitation(conv) },
      facilitations: this.facilitations(conv),
      overview: this.overview(conv),
      overviews: this.overviewRows(conv).map(r => this.overviewView(r)),
      brief: this.brief(conv),
      status: await this.status(conv),
      meta: this.metaRows(conv),
      activities: this.activityRows(conv).map(a => this.activityView(a)),
      annotations: this.annotations(conv).map(a => ({ ...a, re: JSON.parse(a.re) as number[] })),
      obligations: await this.obligations(conv),
      members: this.members(conv),
      membership: this.membership(conv),
      messages: rows.filter(m => m.id > (o.since ?? 0)).map(m => ({ ...this.message(m, o.viewBase), attachments: attached.get(m.id) ?? [] })).map(m => linkable(m.run) ? m : { ...m, runUrl: null }),
      requests: invitations.map(i => this.invitationView(i, o.viewBase)).map(i => linkable(i.run) ? i : { ...i, runUrl: null }),
      links,
      runs,
      asking: await this.openAsking(conv, rows),
      horizon: this.horizon(conv),
    }
  }
}
