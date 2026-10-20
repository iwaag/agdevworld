// Discussions (workflow_editor p16, docs/discussions.md): a person, a
// facilitator and project agents with their own missions and contexts,
// speaking in one shared conversation. A discussion is a conversation of kind
// `discussion` in the conversation store: it shares its id space, its
// messages (verbatim, with author, time, submit token and `re`) and its links
// with direct conversations, and adds
//
// - members: an append-only membership history (`join` / `leave`), folded
//   into the current members. A participant is the configured person (or a
//   named trial author), the facilitator (`argue/facilitate`) or a project
//   speaking through its discussion workflow (`<project>/discuss`);
// - invitations: the only thing that starts a run in a discussion. One
//   names a participant, the question, the messages it is about, who issued
//   it (the person, or the facilitator's run, which then awaits it) and the
//   horizon (the newest message when it was dispatched). Its run is requested
//   with receipt `discussion:<id>:invitation:<n>`, so a retry or a restart
//   finds the same run. Its state is the record of what came of it:
//   pending → started → answered | unanswered, failed (with the reason),
//   withdrawn (on close), answered late;
// - awaited results (argue p3): the facilitator's run may also await the
//   result of a run that is already working (a participant's run that
//   entrusted work and waits for it, a synthesize run, any run). It is an
//   invitation row that starts nothing (`awaits = 'result'`): answered by
//   that run's next result or synthesis here, or settled when the run ends;
// - continuation: when every invitation a facilitator run awaits is
//   resolved, that run is given one instruction listing the outcomes (the
//   existing continuation of a waiting run, runs.md); a facilitator run that
//   has ended meanwhile is replaced by a new facilitator turn invited with
//   the outcomes, so what it awaited is never left unread. An agent's
//   contribution never starts anything by itself.
//
// - the conductor (argue p4): the facilitator's open run that owns the
//   discussion's progression across many attempts. Its nodes carry
//   discussion activities (announce, ask, ponder, talk), each bound here to
//   its messages, invitations and decision (`activities`, with an
//   append-only event history). WFE completes an ask node when its
//   invitations are resolved and then continues the run; announce and ponder
//   complete with their message or decision; talk is the run's question to
//   the discussion's requester (the person who opened it, or the run that
//   requested the conductor run);
// - annotations: interventions, recoveries, evaluations and corrections by
//   someone outside the speech, kept apart from it.
//
// Routing a person's message: addressed participants are invited; without
// an addressee (or addressing the facilitator) the open conductor run is
// given it (as the answer to its question, else as an instruction), and
// without one the facilitator is invited. Closing
// withdraws invitations not yet started and stops continuations; started ones
// finish and are recorded; reopening replays nothing.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationSource } from '../shared/intake.ts'
import { ACTIVITIES, type Activity } from '../shared/model.ts'
import { isOpenDelegation } from '../shared/delegation.ts'
import { situation, type OpInput, type RunRecord } from '../shared/run.ts'
import { CONVERSATION_ID, firstLine, loadConversationConfig, parseRunName, pendingQuestions, runName, runUrl, targetName, type ConversationRow, type ConversationStore, type ConversationTarget, type MessageKind, type MessageRow, type RunEntry, type TargetView } from './conversations.ts'
import { activeDefinition, adjustRun, readRun, runOp, usableRun } from './runs.ts'
import { parseWorkflow, renderWorkflow } from './yamlDoc.ts'
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

// conversations.json `discussions`: the facilitator, the projects that may be
// invited, and the managed project whose repository keeps the archive.
//   "discussions": { "facilitator": {"workspace": "argue", "workflow": "facilitate"},
//                    "participants": [{"workspace": "forge", "workflow": "discuss"}, …],
//                    "archive": {"workspace": "argue"} }
export interface DiscussionConfig { person: string; facilitator: ConversationTarget; participants: ConversationTarget[]; archive: { workspace: string } | null }
const NAME = /^[a-z0-9][a-z0-9_.-]*$/
export function loadDiscussionConfig(area: string): DiscussionConfig | { disabled: string } {
  const base = loadConversationConfig(area)
  if ('disabled' in base) return base
  const file = join(area, 'conversations.json')
  try {
    const o = (JSON.parse(readFileSync(file, 'utf8')) as { discussions?: Record<string, unknown> }).discussions
    if (!o) return { disabled: `${file} has no "discussions": no facilitator is configured here` }
    const shape = `${file} "discussions" needs {"facilitator": {"workspace", "workflow"}, "participants": [{"workspace", "workflow"}, …], "archive"?: {"workspace"}}`
    const target = (t: unknown): ConversationTarget | null => {
      const x = t as Partial<ConversationTarget> | undefined
      return typeof x?.workspace === 'string' && typeof x.workflow === 'string' && NAME.test(x.workspace) && NAME.test(x.workflow) ? { workspace: x.workspace, workflow: x.workflow } : null
    }
    const facilitator = target(o.facilitator)
    if (!facilitator || !Array.isArray(o.participants)) return { disabled: shape }
    const participants: ConversationTarget[] = []
    for (const p of o.participants) { const t = target(p); if (!t || t.workspace === facilitator.workspace) return { disabled: shape }; participants.push(t) }
    const a = o.archive as { workspace?: unknown } | undefined
    if (a !== undefined && (typeof a?.workspace !== 'string' || !NAME.test(a.workspace))) return { disabled: shape }
    return { person: base.person, facilitator, participants, archive: a ? { workspace: a.workspace as string } : null }
  } catch (e) { return { disabled: `${file} cannot be read: ${(e as Error).message}` } }
}

export type ParticipantKind = 'person' | 'facilitator' | 'project'
export interface MembershipRow { id: number; conv: string; participant: string; kind: ParticipantKind; workspace: string | null; workflow: string | null; action: 'join' | 'leave'; by: string; at: string; note: string }
export interface Member { participant: string; kind: ParticipantKind; workspace: string | null; workflow: string | null; since: string; by: string }
export interface InvitationRow {
  id: number; conv: string; participant: string; workspace: string; workflow: string; question: string; source: string; by: string; by_run: string | null
  awaited_by: string | null; horizon: number; token: string | null; state: InvitationState; run: string | null; error: string | null; tries: number
  created: string; updated: string; answered_by: number | null; late: number; reported: string | null
  delivery: string | null // JSON {question, message}: delivered to the run that asked (see post)
  awaits: string | null // 'result': an awaited result of a run already working (see awaitResult)
  activity: number | null // the conductor's ask activity it belongs to (argue p4)
}
export interface InvitationEventRow { id: number; conv: string; invitation: number; state: string; at: string; run: string | null; message: number | null; note: string }
export interface Invitation {
  id: number; participant: string; target: string; question: string; source: number[]; by: string; byRun: string | null; awaitedBy: string | null
  horizon: number; state: InvitationState; late: boolean; run: string | null; runUrl: string | null; error: string | null; tries: number
  created: string; updated: string; answeredBy: number | null; reported: string | null
  deliveredTo: number | null // the question (message) whose asking run this was delivered to
  awaits: string | null // 'result': the facilitator awaits this run's result; no run was started for it
  activity: number | null // the ask activity (argue p4)
}
export interface DiscussionMessage {
  id: number; role: 'person' | 'agent'; author: string; participant: string | null; text: string; at: string; via: string | null; re: number[]; kind: MessageKind
  run: string | null; runUrl: string | null; attempt: string | null; question: string | null; invitation: number | null; addressed: string[]
  node: string | null
}
// The live extent of a discussion's records, by table: what an export covers.
export interface Horizon { message: number; link: number; membership: number; event: number; activity?: number; annotation?: number }

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
// Something still owed in a discussion (argue p4): who owes it and who will
// receive it when it comes, read from the records now.
export interface Obligation { kind: 'invitation' | 'result' | 'question' | 'run' | 'delegation'; ref: string; owes: string; owner: string; receiver: string; since: string }

// The description a node made by `wfe discussion ponder --next` starts with.
const ACTIVITY_DESCRIPTIONS: Record<Activity, string> = {
  announce: 'Tell the discussion what comes next and why (wfe discussion announce): an agenda, context, an interim synthesis or the conclusion.',
  ask: 'Ask the participants who can supply what is missing (wfe discussion ask), or await a commissioned result (--run); WFE completes it with their outcomes.',
  ponder: 'Read what was said and what is owed (wfe discussion state), decide the next step and why (wfe discussion ponder).',
  talk: 'Consult the requester about intent or direction (wfe discussion talk); their answer continues this run.',
}
const now = () => new Date().toISOString()
const label = (i: Pick<InvitationRow, 'state' | 'late'>) => `${i.state}${i.late ? '-late' : ''}`
const resolved = (s: InvitationState) => !OPEN_STATES.includes(s)

export class DiscussionStore {
  readonly cs: ConversationStore
  constructor(cs: ConversationStore) { this.cs = cs }
  get db() { return this.cs.db }
  get area() { return this.cs.area }
  get exec() { return this.cs.exec }
  config() { return loadDiscussionConfig(this.area) }
  private cfg(): DiscussionConfig {
    const c = this.config()
    if ('disabled' in c) throw new RequestError(503, c.disabled)
    return c
  }

  private tx<T>(f: () => T): T { return transaction(this.db, f, 'conversation store') }
  private all<T>(sql: string, ...a: (string | number | null)[]): T[] { return this.db.prepare(sql).all(...a) as T[] }
  private one<T>(sql: string, ...a: (string | number | null)[]): T | undefined { return this.db.prepare(sql).get(...a) as T | undefined }

  discussion(id: string): ConversationRow | undefined {
    const c = this.cs.conversation(id)
    return c?.kind === 'discussion' ? c : undefined
  }
  private need(id: string): ConversationRow {
    const c = this.cs.conversation(id)
    if (!c) throw new RequestError(404, `no discussion ${id}`)
    if (c.kind !== 'discussion') throw new RequestError(409, `${id} is a conversation with ${c.workspace}/${c.workflow}, not a discussion: use wfe conversation (api/conversations/${id})`, { code: 'is-conversation' })
    return c
  }
  list() { return this.cs.list({ kind: 'discussion' }).map(c => ({ ...c, members: this.members(c.id).map(m => m.participant), open: this.invitations(c.id).filter(i => OPEN_STATES.includes(i.state)).length })) }
  messages(conv: string, since = 0): MessageRow[] { return this.cs.messages(conv, since) }
  membership(conv: string): MembershipRow[] { return this.all<MembershipRow>('SELECT * FROM membership WHERE conv = ? ORDER BY id', conv) }
  invitations(conv: string): InvitationRow[] { return this.all<InvitationRow>('SELECT * FROM invitations WHERE conv = ? ORDER BY id', conv) }
  invitation(id: number): InvitationRow | undefined { return this.one<InvitationRow>('SELECT * FROM invitations WHERE id = ?', id) }
  events(conv: string, since = 0): InvitationEventRow[] { return this.all<InvitationEventRow>('SELECT * FROM invitation_events WHERE conv = ? AND id > ? ORDER BY id', conv, since) }
  horizon(conv: string): Horizon {
    const max = (table: string) => this.one<{ n: number | null }>(`SELECT max(id) AS n FROM ${table} WHERE conv = ?`, conv)!.n ?? 0
    return { message: max('messages'), link: max('links'), membership: max('membership'), event: max('invitation_events'), activity: max('activity_events'), annotation: max('annotations') }
  }

  // The current members: the membership history folded, in order of joining.
  members(conv: string): Member[] {
    const cur = new Map<string, Member>()
    for (const r of this.membership(conv)) {
      if (r.action === 'leave') cur.delete(r.participant)
      else if (!cur.has(r.participant)) cur.set(r.participant, { participant: r.participant, kind: r.kind, workspace: r.workspace, workflow: r.workflow, since: r.at, by: r.by })
    }
    return [...cur.values()]
  }

  // Who a participant id is: the facilitator, a configured project, or —
  // for a name that is neither — a person.
  resolve(participant: string, o: { person?: boolean } = {}): { participant: string; kind: ParticipantKind; workspace: string | null; workflow: string | null } {
    const cfg = this.cfg()
    if (participant === cfg.facilitator.workspace) return { participant, kind: 'facilitator', ...cfg.facilitator }
    const p = cfg.participants.find(t => t.workspace === participant)
    if (p) return { participant, kind: 'project', ...p }
    if (o.person) return { participant, kind: 'person', workspace: null, workflow: null }
    throw new RequestError(400, `"${participant}" is not a participant here: the facilitator is ${cfg.facilitator.workspace}; projects that can be invited are ${cfg.participants.map(t => t.workspace).join(', ') || 'none'}`, { code: 'unknown-participant' })
  }

  // The facilitator and the projects that can be invited, as their projects
  // say now (an unreadable one is listed unavailable with the reason).
  async participants(): Promise<(TargetView & { participant: string; kind: ParticipantKind })[]> {
    const cfg = this.config()
    if ('disabled' in cfg) return []
    return Promise.all([cfg.facilitator, ...cfg.participants].map(async (t, i) => ({ ...await this.cs.target(t), participant: t.workspace, kind: (i === 0 ? 'facilitator' : 'project') as ParticipantKind })))
  }

  private joinRow(conv: string, m: ReturnType<DiscussionStore['resolve']>, by: string, note: string) {
    this.db.prepare('INSERT INTO membership (conv, participant, kind, workspace, workflow, action, by, at, note) VALUES (?, ?, ?, ?, ?, \'join\', ?, ?, ?)').run(conv, m.participant, m.kind, m.workspace, m.workflow, by, now(), note)
  }

  // ---- creating, joining, leaving --------------------------------------------------

  // A new discussion with its first members: the person who creates it, the
  // facilitator, and the projects named. The same id again with the same
  // creator is the same discussion (a retried create), never a second one.
  // From the conductor's attempt (argue p4), `conductor` is that run and the
  // requester is the run that requested it (or the person it acts for);
  // otherwise the requester is the person who opens the discussion.
  create(conv: string, o: { title: string; by: string; members?: string[]; conductor?: string; requester?: Requester }): { discussion: ConversationRow; duplicate: boolean } {
    if (!CONVERSATION_ID.test(conv)) throw new RequestError(400, `discussion id must match ${CONVERSATION_ID.source}`)
    const title = o.title.trim()
    if (!title) throw new RequestError(400, 'a discussion needs a title')
    const cfg = this.cfg()
    const members = [...new Set(o.members ?? [])].map(p => this.resolve(p)).filter(m => m.kind !== 'facilitator')
    return this.tx(() => {
      const c = this.cs.conversation(conv)
      if (c) {
        if (c.kind !== 'discussion' || c.by !== o.by) throw new RequestError(409, `${conv} already exists`, { code: 'exists' })
        return { discussion: c, duplicate: true }
      }
      const at = now()
      const requester: Requester = o.requester ?? { kind: 'person', id: o.by }
      this.db.prepare('INSERT INTO conversations (id, title, created, updated, state, by, workspace, workflow, kind, conductor, requester) VALUES (?, ?, ?, ?, \'open\', ?, ?, ?, \'discussion\', ?, ?)').run(conv, firstLine(title), at, at, o.by, cfg.facilitator.workspace, cfg.facilitator.workflow, o.conductor ?? null, JSON.stringify(requester))
      this.activityEvent(conv, null, 'requester', requester.kind, o.by, requester.kind === 'person' ? `requested by ${requester.id}` : `requested by ${requester.run}`, { requester })
      if (o.conductor) this.activityEvent(conv, null, 'conductor', 'set', o.by, `${o.conductor} conducts (it created the discussion)`, { run: o.conductor })
      if (o.requester?.kind !== 'run' || !o.conductor) this.joinRow(conv, this.resolve(o.by, { person: true }), o.by, 'created the discussion')
      this.joinRow(conv, this.resolve(cfg.facilitator.workspace), o.by, 'facilitator')
      for (const m of members) this.joinRow(conv, m, o.by, 'invited at creation')
      return { discussion: this.cs.conversation(conv)!, duplicate: false }
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

  // A member who leaves is invited no more; what it said and the invitations
  // it was given stay.
  leave(conv: string, participant: string, o: { by: string; note?: string }): { left: boolean } {
    this.need(conv)
    return this.tx(() => {
      const cur = this.members(conv).find(x => x.participant === participant)
      if (!cur) return { left: false }
      this.db.prepare('INSERT INTO membership (conv, participant, kind, workspace, workflow, action, by, at, note) VALUES (?, ?, ?, ?, ?, \'leave\', ?, ?, ?)').run(conv, participant, cur.kind, cur.workspace, cur.workflow, o.by, now(), o.note?.trim() || 'left')
      this.touch(conv)
      return { left: true }
    })
  }
  private touch(conv: string) { this.db.prepare('UPDATE conversations SET updated = ? WHERE id = ?').run(now(), conv) }

  // ---- the person's words ----------------------------------------------------------

  // A person's message, verbatim, routed into invitations: each addressed
  // participant is invited with these words; without an addressee (or when
  // the facilitator is addressed) the facilitator is. The same token twice is
  // one message and the same invitations. A post reopens a closed discussion.
  async post(conv: string, o: { text: string; author: string; token: string; re?: number[]; to?: string[]; via?: string }): Promise<{ message: MessageRow; duplicate: boolean; reopened: boolean; invitations: InvitationRow[] }> {
    const c = this.need(conv)
    if (!o.text.trim()) throw new RequestError(400, 'the message is empty')
    if (o.text.length > MAX_TEXT) throw new RequestError(413, `a message is at most ${MAX_TEXT} characters`)
    if (!TOKEN.test(o.token)) throw new RequestError(400, 'a message needs a submit token (8–200 of A-Z a-z 0-9 : . _ / # -)')
    if (o.via !== undefined && !VIA.test(o.via)) throw new RequestError(400, `via must match ${VIA.source}`)
    const cfg = this.cfg()
    const re = this.validRe(conv, o.re ?? [])
    const to = [...new Set(o.to ?? [])]
    const targets = to.map(p => this.resolve(p))
    const left = targets.filter(t => this.left(conv, t.participant))
    if (left.length) throw new RequestError(409, `${left.map(t => t.participant).join(', ')} left this discussion; join ${left.length > 1 ? 'them' : 'it'} again first`, { code: 'left' })
    const invited = targets.some(t => t.kind === 'facilitator') || !targets.length ? [this.resolve(cfg.facilitator.workspace), ...targets.filter(t => t.kind !== 'facilitator')] : targets
    // The person's reply to a participant's question goes to the run that
    // asked, while it is there (not completed): as the answer to its WFE
    // question, else as an instruction. Otherwise the participant is invited
    // with a new run, as for any addressed message.
    const asked = new Map<string, { run: string; question: string | null; message: number }>()
    for (const t of invited) {
      const q = re.map(n => this.cs.message(n)).filter((m): m is MessageRow => !!m && m.role === 'agent' && m.kind === 'question' && m.participant === t.participant && !!m.run).at(-1)
      if (q && await this.runIsOpen(q.run!)) asked.set(t.participant, { run: q.run!, question: q.question, message: q.id })
      // The facilitator (argue p4): an open conductor run is given the words —
      // as the answer to its question that the message names, or to its only
      // open question asked here — and no second run is started.
      else if (t.kind === 'facilitator') {
        const conductor = await this.openConductor(conv)
        if (conductor) asked.set(t.participant, { run: conductor, ...await this.conductorQuestion(conv, conductor, re, q) })
      }
    }
    const res = this.tx(() => {
      const seen = this.one<MessageRow>('SELECT * FROM messages WHERE conv = ? AND token = ?', conv, o.token)
      const reopened = !seen && c.state === 'closed'
      let id = seen?.id
      if (!seen) {
        const at = now()
        this.db.prepare('UPDATE conversations SET updated = ?, state = \'open\' WHERE id = ?').run(at, conv)
        if (!this.members(conv).some(m => m.participant === o.author)) this.joinRow(conv, this.resolve(o.author, { person: true }), o.author, 'first message')
        id = Number(this.db.prepare('INSERT INTO messages (conv, role, author, text, at, token, via, re, kind, participant, addressed) VALUES (?, \'person\', ?, ?, ?, ?, ?, ?, \'message\', ?, ?)').run(conv, o.author, o.text, at, o.token, o.via ?? null, JSON.stringify(re), o.author, JSON.stringify(to)).lastInsertRowid)
      }
      const m = this.cs.message(id!)!
      // The invitations of a resubmitted message are found by their tokens.
      const invs = invited.map(t => this.issue(conv, { participant: t, question: m.text, source: [m.id, ...re.filter(n => n !== m.id)], by: o.author, byRun: null, awaitedBy: null, token: `message:${m.id}:${t.participant}`, deliver: asked.get(t.participant) }))
      return { message: m, duplicate: !!seen, reopened, invitations: invs }
    })
    for (const i of res.invitations) if (i.state === 'pending') await this.dispatch(i.id)
    return { ...res, invitations: res.invitations.map(i => this.invitation(i.id)!) }
  }

  // The discussions a run conducts, newest first (a conductor run that was
  // requested as work, not invited, finds its discussion this way).
  conductedBy(run: string): string[] { return this.all<{ id: string }>('SELECT id FROM conversations WHERE kind = \'discussion\' AND conductor = ? ORDER BY updated DESC', run).map(r => r.id) }
  // The discussion's conductor run while it is open (not completed or
  // cancelled), else null: the next untargeted message invites a new one.
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

  // Records an invitation (inside a transaction), joining a participant who
  // was never a member. Its token makes a retried issue the same invitation.
  private issue(conv: string, o: { participant: ReturnType<DiscussionStore['resolve']>; question: string; source: number[]; by: string; byRun: string | null; awaitedBy: string | null; token: string; deliver?: { run: string; question: string | null; message: number }; activity?: number | null }): InvitationRow {
    const seen = this.one<InvitationRow>('SELECT * FROM invitations WHERE conv = ? AND token = ?', conv, o.token)
    if (seen) return seen
    if (!this.members(conv).some(m => m.participant === o.participant.participant)) this.joinRow(conv, o.participant, o.by, `invited by ${o.by}`)
    const at = now()
    const id = Number(this.db.prepare('INSERT INTO invitations (conv, participant, workspace, workflow, question, source, by, by_run, awaited_by, token, state, run, delivery, activity, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'pending\', ?, ?, ?, ?, ?)')
      .run(conv, o.participant.participant, o.participant.workspace!, o.participant.workflow!, o.question, JSON.stringify(o.source), o.by, o.byRun, o.awaitedBy, o.token, o.deliver?.run ?? null, o.deliver ? JSON.stringify({ question: o.deliver.question, message: o.deliver.message }) : null, o.activity ?? null, at, at).lastInsertRowid)
    this.event(conv, id, 'pending', { note: `issued by ${o.by}${o.byRun ? ` (${o.byRun})` : ''} to ${o.participant.participant}${o.awaitedBy ? `; awaited by ${o.awaitedBy}` : ''}${o.deliver ? `; for ${o.deliver.run}, which asked #${o.deliver.message}` : ''}` })
    this.touch(conv)
    return this.invitation(id)!
  }
  private event(conv: string, invitation: number, state: string, o: { run?: string | null; message?: number | null; note?: string } = {}) {
    this.db.prepare('INSERT INTO invitation_events (conv, invitation, state, at, run, message, note) VALUES (?, ?, ?, ?, ?, ?, ?)').run(conv, invitation, state, now(), o.run ?? null, o.message ?? null, o.note ?? '')
  }

  // ---- invitations -----------------------------------------------------------------

  // An invitation by the person or by the facilitator's run (which then
  // awaits it). A participant's run cannot invite: it says in its own
  // contribution whom it would ask.
  async invite(conv: string, o: { participant: string; question: string; re?: number[]; by: string; byRun?: string | null; token?: string; activity?: number | null }): Promise<{ invitation: InvitationRow; duplicate: boolean }> {
    const c = this.need(conv)
    const cfg = this.cfg()
    if (c.state === 'closed') throw new RequestError(409, `discussion ${conv} is closed: reopen it to invite`, { code: 'closed' })
    if (!o.question.trim()) throw new RequestError(400, 'say what the participant is asked (--question)')
    if (o.question.length > MAX_TEXT) throw new RequestError(413, `a question is at most ${MAX_TEXT} characters`)
    let awaitedBy: string | null = null
    if (o.byRun) {
      const { workspace, ref } = parseRunName(o.byRun)
      if (workspace !== cfg.facilitator.workspace || ref.workflow !== cfg.facilitator.workflow) throw new RequestError(403, `only the facilitator (${targetName(cfg.facilitator)}) or the person invites; a participant says in its contribution whom it would ask`, { code: 'not-facilitator' })
      awaitedBy = o.byRun
    }
    const p = this.resolve(o.participant)
    if (this.left(conv, p.participant)) throw new RequestError(409, `${p.participant} left this discussion; join it again first`, { code: 'left' })
    const re = this.validRe(conv, o.re ?? [])
    const horizon = this.horizon(conv).message
    if (!re.length && !horizon) throw new RequestError(400, 'the discussion has no message yet: an invitation is about messages (--re)')
    const token = o.token ?? `${o.byRun ?? o.by}:${createHash('sha256').update(`${p.participant}\n${o.question}\n${re.join(',')}`).digest('hex').slice(0, 24)}`
    if (!TOKEN.test(token)) throw new RequestError(400, 'an invitation token is 8–200 of A-Z a-z 0-9 : . _ / # -')
    const before = this.one<InvitationRow>('SELECT * FROM invitations WHERE conv = ? AND token = ?', conv, token)
    const inv = this.tx(() => this.issue(conv, { participant: p, question: o.question, source: re.length ? re : [horizon], by: o.by, byRun: o.byRun ?? null, awaitedBy, token, activity: o.activity }))
    if (inv.state === 'pending') await this.dispatch(inv.id)
    return { invitation: this.invitation(inv.id)!, duplicate: !!before }
  }

  // Starts an invitation's run: one run of the participant's workflow with
  // the question as its words. The receipt finds the same run again. A
  // target that cannot take it leaves the invitation `failed` with the
  // reason; it is never sent to anyone else. A closed discussion starts
  // nothing: the invitation is withdrawn.
  async dispatch(id: number): Promise<InvitationRow> {
    const i = this.invitation(id)
    if (!i || (i.state !== 'pending' && i.state !== 'failed')) return i!
    const c = this.cs.conversation(i.conv)!
    if (c.state === 'closed') { this.withdraw(i, 'the discussion was closed before it started'); return this.invitation(id)! }
    try {
      if (!this.exec) throw new Error('execution is not configured here')
      if (i.delivery && i.run && await this.deliver(i)) return this.invitation(id)!
      const named = JSON.parse(i.source) as number[]
      const first = this.cs.message(named[0] ?? 0) ?? this.cs.message(this.horizon(i.conv).message)
      if (!first) throw new Error('the invitation names no message')
      const horizon = this.horizon(i.conv).message
      const source: ConversationSource = { kind: 'conversation', conversation: i.conv, message: first.id, author: first.author, at: first.at, invitation: i.id }
      const r = await this.exec.request({ workspace: i.workspace, workflow: i.workflow, text: i.question, author: i.by, receipt: `discussion:${i.conv}:invitation:${i.id}`, via: 'discussion', source })
      const run = runName(i.workspace, r.ref)
      // The facilitator's run started by an invitation conducts the
      // discussion unless another one still does (argue p4).
      const cfg = this.cfg()
      const conducts = i.workspace === cfg.facilitator.workspace && i.workflow === cfg.facilitator.workflow && !await this.openConductor(i.conv)
      this.tx(() => {
        this.db.prepare('UPDATE invitations SET state = \'started\', run = ?, error = NULL, tries = tries + 1, horizon = CASE WHEN horizon = 0 THEN ? ELSE horizon END, updated = ? WHERE id = ?').run(run, horizon, now(), id)
        this.event(i.conv, id, 'started', { run, note: `${run} requested; horizon #${horizon}` })
        if (conducts && this.cs.conversation(i.conv)?.conductor !== run) this.setConductor(i.conv, run, 'discussion', `started by invitation ${id}`)
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

  // Delivers an invitation to the run that asked: the person's words as the
  // answer to its open WFE question (which resumes the node waiting on it),
  // else as an instruction (which continues a waiting run). The receipt makes
  // a retry the same record. False when that run has ended meanwhile: the
  // invitation then starts a new run like any other.
  private async deliver(i: InvitationRow): Promise<boolean> {
    const d = JSON.parse(i.delivery!) as { question: string | null; message: number }
    const { workspace, ref } = parseRunName(i.run!)
    const ws = await this.exec!.workspace(workspace)
    const rec = (await readRun(ws, ref)).record as RunRecord | null
    if (!rec || ['completed', 'cancelled'].includes(situation(rec))) {
      this.tx(() => {
        this.db.prepare('UPDATE invitations SET run = NULL, delivery = NULL, updated = ? WHERE id = ?').run(now(), i.id)
        this.event(i.conv, i.id, 'pending', { note: `${i.run} has ended: a new run is requested instead` })
      })
      return false
    }
    const m = this.cs.message(JSON.parse(i.source)[0])!
    const source: ConversationSource = { kind: 'conversation', conversation: i.conv, message: m.id, author: m.author, at: m.at, invitation: i.id }
    const receipt = `discussion:${i.conv}:invitation:${i.id}`
    const q = d.question ? rec.questions[d.question] : undefined
    let how: string
    if (q && !q.withdrawn && !q.takenUp) {
      await runOp(ws, ref, { op: 'question.answer', question: q.id, text: i.question, from: i.by, source, receipt }, { by: i.by, via: 'discussion' })
      const job = await this.exec!.afterAnswer(ws, ref, q.id)
      how = `the answer to ${q.id}${job ? `; job ${job.id}` : ''}`
    } else {
      const r = await runOp(ws, ref, { op: 'instruction.receive', text: i.question, from: i.by, source, receipt }, { by: i.by, via: 'discussion' })
      const ins = r.record.history.find(h => h.receipt === receipt)?.change.instruction?.[1] ?? Object.keys(r.record.instructions ?? {}).at(-1)
      const job = ins ? await this.exec!.afterInstruction(ws, ref, ins) : null
      how = `instruction ${ins}${job ? `; job ${job.id}` : ''}`
    }
    this.tx(() => {
      this.db.prepare('UPDATE invitations SET state = \'started\', error = NULL, tries = tries + 1, horizon = CASE WHEN horizon = 0 THEN ? ELSE horizon END, updated = ? WHERE id = ?').run(this.horizon(i.conv).message, now(), i.id)
      this.event(i.conv, i.id, 'started', { run: i.run, note: `delivered to ${i.run}, which asked #${d.message}, as ${how}` })
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

  // Withdraws an invitation that has not started (by the person or the
  // facilitator that issued it). A started run is not stopped by this:
  // stopping a run is the run's own control.
  withdrawInvitation(conv: string, id: number, o: { by: string; reason: string }): InvitationRow {
    this.need(conv)
    const i = this.invitation(id)
    if (!i || i.conv !== conv) throw new RequestError(404, `no invitation ${id} in ${conv}`)
    if (i.state !== 'pending' && i.state !== 'failed') throw new RequestError(409, `invitation ${id} is ${i.state}: only one not started can be withdrawn${i.run ? ` (its run is ${i.run})` : ''}`, { code: 'not-withdrawable' })
    this.withdraw(i, `${o.by}: ${o.reason}`)
    return this.invitation(id)!
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
        const participant = workspace === cfg.facilitator.workspace && ref.workflow === cfg.facilitator.workflow ? cfg.facilitator.workspace : workspace
        const id = Number(this.db.prepare('INSERT INTO invitations (conv, participant, workspace, workflow, question, source, by, by_run, awaited_by, horizon, token, state, run, awaits, activity, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'started\', ?, \'result\', ?, ?, ?)')
          .run(conv, participant, workspace, ref.workflow, o.note.trim(), JSON.stringify(re.length ? re : [horizon]), o.by, o.byRun, o.byRun, horizon, token, o.run, o.activity ?? null, at, at).lastInsertRowid)
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
      // the archive project's (argue's synthesize, requested as ordinary work).
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
  async afterResolution(id: number): Promise<string | null> {
    const i = this.invitation(id)
    if (!i?.awaited_by || !resolved(i.state)) return null
    const c = this.cs.conversation(i.conv)!
    if (c.state === 'closed') return null
    const act = i.activity ? this.activityRow(i.activity) ?? null : null
    const awaited = act
      ? this.all<InvitationRow>('SELECT * FROM invitations WHERE activity = ? ORDER BY id', act.id)
      : this.all<InvitationRow>('SELECT * FROM invitations WHERE awaited_by = ? AND conv = ? AND activity IS NULL ORDER BY id', i.awaited_by, i.conv)
    if (awaited.some(a => OPEN_STATES.includes(a.state)) && act?.state !== 'settled') return null
    const untold = awaited.filter(a => resolved(a.state) && a.reported !== label(a))
    if (!untold.length || !this.exec) return null
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
        const cfg = this.cfg()
        const turn = this.tx(() => this.issue(i.conv, { participant: this.resolve(cfg.facilitator.workspace), question: lines(`Discussion ${i.conv}: what ${i.awaited_by} awaited is resolved, and that run has completed; this turn takes it up.`), source: m ? [m.id] : JSON.parse(untold[0].source) as number[], by: 'discussion', byRun: null, awaitedBy: null, token: receipt }))
        this.tx(() => { for (const a of untold) this.db.prepare('UPDATE invitations SET reported = ? WHERE id = ?').run(label(a), a.id) })
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
    this.tx(() => { for (const a of untold) this.db.prepare('UPDATE invitations SET reported = ? WHERE id = ?').run(label(a), a.id) })
    return note
  }

  // ---- reconcile -------------------------------------------------------------------

  // What the executor's reconcile does every minute: starts invitations not
  // yet started (failed ones up to DISPATCH_TRIES in all), finds started ones
  // whose run ended without a contribution (`unanswered`), and tells waiting
  // facilitators what they have not been told (a crash between a resolution
  // and the instruction).
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
    for (const r of this.all<{ awaited_by: string; conv: string; id: number }>('SELECT awaited_by, conv, max(id) AS id FROM invitations WHERE awaited_by IS NOT NULL AND (reported IS NULL OR reported != state || CASE WHEN late = 1 THEN \'-late\' ELSE \'\' END) AND state NOT IN (\'pending\', \'started\') GROUP BY awaited_by, conv, activity')) {
      const told = await this.afterResolution(r.id)
      if (told) notes.push(`discussion ${r.conv}: ${told}`)
    }
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
          w.nodes[x.node] = { type: x.activity === 'talk' ? 'talk' : 'do', activity: x.activity, name: x.name ?? '', description: x.description ?? ACTIVITY_DESCRIPTIONS[x.activity as Activity], repositories: [] }
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
    return { activity: this.activityView(row), revision, duplicate: false }
  }

  // talk: the conductor consults the discussion's requester. The question is
  // the run's WFE question on the talk node (to the person, or to the
  // requesting run's agent, whose relay carries it), and is posted here so
  // everyone reads it. The person's reply comes back to this run as the
  // answer (post); an agent's answer through its delegation or request.
  async talk(conv: string, o: { run: string; attempt: string | null; author: string; node: string; question: string; re: number[]; to?: string }) {
    const t = await this.activityNode(conv, o.run, o.node, 'talk')
    const seen = this.one<ActivityRow>('SELECT * FROM activities WHERE conv = ? AND token = ?', conv, `${o.run}:${o.node}`)
    if (seen) return { activity: this.activityView(seen), message: this.cs.message(seen.message ?? 0) ?? null, duplicate: true }
    const req = this.requester(conv)
    const to = o.to ?? (req?.kind === 'run' ? req.agent ?? req.run : req?.id ?? this.cfg().person)
    const receipt = `discussion:${conv}:talk:${o.run}:${o.node}`
    let q = Object.values(t.record.questions).find(x => x.node === o.node && !x.withdrawn)?.id
    if (!q) {
      await this.startNode(o.run, o.node, t.node.state, { by: o.author, attempt: o.attempt, receipt })
      let n = Object.keys(t.record.questions).length + 1
      while (`q${n}` in t.record.questions) n++
      const r = await this.nodeOp(o.run, { op: 'question.ask', question: `q${n}`, node: o.node, text: o.question, to } as OpInput, { by: o.author, attempt: o.attempt, receipt: `${receipt}:ask` })
      q = r.record.history.find(h => h.receipt === `${receipt}:ask`)?.change.question?.[1] ?? `q${n}`
    }
    const said = await this.contribute(conv, { text: o.question, author: o.author, run: o.run, attempt: o.attempt, re: o.re, kind: 'question', question: q, key: `activity:${o.run}:${o.node}`, node: o.node })
    const { row } = this.tx(() => this.recordActivity(conv, { run: o.run, node: o.node, attempt: o.attempt, kind: 'talk', state: 'waiting', text: o.question, sources: o.re, message: said.message.id, question: q!, by: o.author, note: `asked ${to} (${q}) #${said.message.id}` }))
    return { activity: this.activityView(row), message: said.message, to, duplicate: false }
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
      if (closed) return 'recorded only: the discussion is closed (reopen to continue)'
      if (!run) return 'nobody awaits it: recorded in the discussion'
      if (run === o.except) return `a new ${this.cfg().facilitator.workspace} turn (${run} will have completed)`
      return ended(await rec(run)) ? `a new ${this.cfg().facilitator.workspace} turn (${run} has ended)` : run
    }
    const out: Obligation[] = []
    for (const i of this.invitations(conv).filter(x => OPEN_STATES.includes(x.state))) {
      if (i.run === o.except) continue
      out.push({ kind: i.awaits ? 'result' : 'invitation', ref: `invitation ${i.id}`, owes: i.awaits ? `the result of ${i.run}` : `a reply from ${i.participant}`, owner: i.run ?? i.participant, receiver: await receiver(i.awaited_by), since: i.created })
    }
    const rows = this.messages(conv)
    for (const n of pendingQuestions(rows)) {
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
      if (!out.some(x => x.owner === run)) out.push({ kind: 'run', ref: run, owes: `its work (${situation(r)})`, owner: run, receiver: closed ? 'recorded only: the discussion is closed (reopen to continue)' : 'its own contributions here', since: r.created })
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
    const discussWorkflows = 'disabled' in cfg ? [] : cfg.participants.map(targetName)
    // Messages spoken for a node, and replies answering a participant's own
    // invitation (a one-node discussion turn), from the last two days.
    const spoken = this.all<MessageRow>('SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conv WHERE c.kind = \'discussion\' AND m.role = \'agent\' AND m.run IS NOT NULL AND m.at >= ? AND (m.node IS NOT NULL OR m.invitation IS NOT NULL) ORDER BY m.id', since)
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

  // Ends automatic dispatch: invitations not started are withdrawn, started
  // ones finish and are recorded, nothing downstream is cancelled, and no
  // facilitator is continued while closed.
  close(conv: string, o: { by: string }): { discussion: ConversationRow; withdrawn: number[] } {
    this.need(conv)
    return this.tx(() => {
      this.db.prepare('UPDATE conversations SET state = \'closed\', updated = ? WHERE id = ?').run(now(), conv)
      const pending = this.all<InvitationRow>('SELECT * FROM invitations WHERE conv = ? AND state IN (\'pending\', \'failed\')', conv)
      for (const i of pending) this.withdrawRow(i, `the discussion was closed by ${o.by}`)
      return { discussion: this.cs.conversation(conv)!, withdrawn: pending.map(i => i.id) }
    })
  }
  // Discussion continues; nothing withdrawn or completed is replayed.
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
    if (s?.kind !== 'conversation' || !this.discussion(s.conversation)) return null
    return { conversation: s.conversation, invitation: s.invitation ?? null }
  }

  private validRe(conv: string, re: number[]): number[] {
    if (!Array.isArray(re) || !re.every(n => Number.isInteger(n))) throw new RequestError(400, 're is a list of message ids')
    for (const n of re) { const m = this.cs.message(n); if (!m || m.conv !== conv) throw new RequestError(400, `message #${n} is not in discussion ${conv}`) }
    return [...new Set(re)]
  }

  // ---- the view --------------------------------------------------------------------

  message(m: MessageRow, viewBase?: string | null): DiscussionMessage {
    const run = m.run ?? null
    return { id: m.id, role: m.role, author: m.author, participant: m.participant, text: m.text, at: m.at, via: m.via, re: JSON.parse(m.re) as number[], kind: m.kind, run, runUrl: run ? runUrl(viewBase, run) : null, attempt: m.attempt, question: m.question, invitation: m.invitation, addressed: m.addressed ? JSON.parse(m.addressed) as string[] : [], node: m.node ?? null }
  }
  invitationView(i: InvitationRow, viewBase?: string | null): Invitation {
    return { id: i.id, participant: i.participant, target: `${i.workspace}/${i.workflow}`, question: i.question, source: JSON.parse(i.source) as number[], by: i.by, byRun: i.by_run, awaitedBy: i.awaited_by, horizon: i.horizon, state: i.state, late: !!i.late, run: i.run, runUrl: i.run ? runUrl(viewBase, i.run) : null, error: i.error, tries: i.tries, created: i.created, updated: i.updated, answeredBy: i.answered_by, reported: i.reported, deliveredTo: i.delivery ? (JSON.parse(i.delivery) as { message: number }).message : null, awaits: i.awaits ?? null, activity: i.activity ?? null }
  }

  // The discussion with its members and their history, every message (the
  // person's words verbatim; each agent message with its participant, run and
  // invitation), the invitations and their runs as their records say now,
  // the questions waiting for the person, and the archive's state when an
  // archive status reader is given.
  async view(conv: string, o: { viewBase?: string | null; since?: number } = {}) {
    const c = this.need(conv)
    const rows = this.messages(conv)
    const invitations = this.invitations(conv)
    const links = this.cs.links(conv)
    const keys = new Map<string, Set<string>>()
    const add = (k: string, rel: string) => { if (!keys.has(k)) keys.set(k, new Set()); keys.get(k)!.add(rel) }
    for (const i of invitations) if (i.run) add(i.run, i.awaits ? `awaited result (invitation ${i.id})` : `invitation ${i.id}`)
    for (const l of links) add(l.run, l.relation)
    if (c.conductor) add(c.conductor, 'conductor')
    const runs: RunEntry[] = await this.cs.runEntries([...keys].map(([key, rel]) => ({ key, relation: [...rel].join(', ') })), o.viewBase)
    return {
      discussion: { id: c.id, title: c.title, created: c.created, updated: c.updated, state: c.state, by: c.by, facilitator: `${c.workspace}/${c.workflow}`, conductor: c.conductor ?? null, requester: this.requester(conv) },
      activities: this.activityRows(conv).map(a => this.activityView(a)),
      annotations: this.annotations(conv).map(a => ({ ...a, re: JSON.parse(a.re) as number[] })),
      obligations: await this.obligations(conv),
      members: this.members(conv),
      membership: this.membership(conv),
      messages: rows.filter(m => m.id > (o.since ?? 0)).map(m => this.message(m, o.viewBase)),
      invitations: invitations.map(i => this.invitationView(i, o.viewBase)),
      links,
      runs,
      asking: pendingQuestions(rows),
      horizon: this.horizon(conv),
    }
  }
}
