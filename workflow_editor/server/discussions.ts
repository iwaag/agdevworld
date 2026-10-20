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
// - continuation: when every invitation a facilitator run awaits is
//   resolved, that run is given one instruction listing the outcomes (the
//   existing continuation of a waiting run, runs.md). An agent's
//   contribution never starts anything by itself.
//
// Routing a person's message: addressed participants are invited; without
// an addressee (or addressing the facilitator) the facilitator is. Closing
// withdraws invitations not yet started and stops continuations; started ones
// finish and are recorded; reopening replays nothing.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationSource } from '../shared/intake.ts'
import { situation, type RunRecord } from '../shared/run.ts'
import { CONVERSATION_ID, firstLine, loadConversationConfig, parseRunName, pendingQuestions, runName, runUrl, targetName, type ConversationRow, type ConversationStore, type ConversationTarget, type MessageKind, type MessageRow, type RunEntry, type TargetView } from './conversations.ts'
import { readRun, runOp } from './runs.ts'
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
const ANSWERING: MessageKind[] = ['reply', 'result', 'synthesis']
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
}
export interface InvitationEventRow { id: number; conv: string; invitation: number; state: string; at: string; run: string | null; message: number | null; note: string }
export interface Invitation {
  id: number; participant: string; target: string; question: string; source: number[]; by: string; byRun: string | null; awaitedBy: string | null
  horizon: number; state: InvitationState; late: boolean; run: string | null; runUrl: string | null; error: string | null; tries: number
  created: string; updated: string; answeredBy: number | null; reported: string | null
  deliveredTo: number | null // the question (message) whose asking run this was delivered to
}
export interface DiscussionMessage {
  id: number; role: 'person' | 'agent'; author: string; participant: string | null; text: string; at: string; via: string | null; re: number[]; kind: MessageKind
  run: string | null; runUrl: string | null; attempt: string | null; question: string | null; invitation: number | null; addressed: string[]
}
// The live extent of a discussion's records, by table: what an export covers.
export interface Horizon { message: number; link: number; membership: number; event: number }

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
    return { message: max('messages'), link: max('links'), membership: max('membership'), event: max('invitation_events') }
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
  create(conv: string, o: { title: string; by: string; members?: string[] }): { discussion: ConversationRow; duplicate: boolean } {
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
      this.db.prepare('INSERT INTO conversations (id, title, created, updated, state, by, workspace, workflow, kind) VALUES (?, ?, ?, ?, \'open\', ?, ?, ?, \'discussion\')').run(conv, firstLine(title), at, at, o.by, cfg.facilitator.workspace, cfg.facilitator.workflow)
      this.joinRow(conv, this.resolve(o.by, { person: true }), o.by, 'created the discussion')
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

  private left(conv: string, participant: string): boolean {
    const rows = this.membership(conv).filter(r => r.participant === participant)
    return rows.at(-1)?.action === 'leave'
  }

  // Records an invitation (inside a transaction), joining a participant who
  // was never a member. Its token makes a retried issue the same invitation.
  private issue(conv: string, o: { participant: ReturnType<DiscussionStore['resolve']>; question: string; source: number[]; by: string; byRun: string | null; awaitedBy: string | null; token: string; deliver?: { run: string; question: string | null; message: number } }): InvitationRow {
    const seen = this.one<InvitationRow>('SELECT * FROM invitations WHERE conv = ? AND token = ?', conv, o.token)
    if (seen) return seen
    if (!this.members(conv).some(m => m.participant === o.participant.participant)) this.joinRow(conv, o.participant, o.by, `invited by ${o.by}`)
    const at = now()
    const id = Number(this.db.prepare('INSERT INTO invitations (conv, participant, workspace, workflow, question, source, by, by_run, awaited_by, token, state, run, delivery, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'pending\', ?, ?, ?, ?)')
      .run(conv, o.participant.participant, o.participant.workspace!, o.participant.workflow!, o.question, JSON.stringify(o.source), o.by, o.byRun, o.awaitedBy, o.token, o.deliver?.run ?? null, o.deliver ? JSON.stringify({ question: o.deliver.question, message: o.deliver.message }) : null, at, at).lastInsertRowid)
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
  async invite(conv: string, o: { participant: string; question: string; re?: number[]; by: string; byRun?: string | null; token?: string }): Promise<{ invitation: InvitationRow; duplicate: boolean }> {
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
    const inv = this.tx(() => this.issue(conv, { participant: p, question: o.question, source: re.length ? re : [horizon], by: o.by, byRun: o.byRun ?? null, awaitedBy, token }))
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
      this.tx(() => {
        this.db.prepare('UPDATE invitations SET state = \'started\', run = ?, error = NULL, tries = tries + 1, horizon = CASE WHEN horizon = 0 THEN ? ELSE horizon END, updated = ? WHERE id = ?').run(run, horizon, now(), id)
        this.event(i.conv, id, 'started', { run, note: `${run} requested; horizon #${horizon}` })
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

  // ---- the participants' speech ----------------------------------------------------

  // A message by a run's agent: attributed to the participant the run speaks
  // for, its run and attempt, and the invitation it was started for. A reply,
  // result or synthesis answers that invitation (late, after it was found
  // unanswered or withdrawn). The same key (default: the text's hash) from
  // the same run is one message.
  async contribute(conv: string, o: { text: string; author: string; run: string; attempt?: string | null; invitation?: number | null; re?: number[]; kind?: MessageKind; question?: string | null; key?: string }): Promise<{ message: MessageRow; duplicate: boolean; invitation: InvitationRow | null }> {
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
      // member's run (e.g. a facilitator turn answering after a restart).
      if (!this.members(conv).some(m => m.participant === participant) && !this.invitations(conv).some(i => i.run === o.run)) throw new RequestError(403, `${o.run} is not a member's run in ${conv}`, { code: 'not-member' })
    }
    if (kind === 'synthesis' && participant !== cfg.facilitator.workspace) throw new RequestError(403, 'a synthesis is the facilitator\'s (a participant\'s view is a reply)', { code: 'not-facilitator' })
    const re = this.validRe(conv, o.re ?? [])
    const key = o.key ?? createHash('sha256').update(o.text).digest('hex').slice(0, 24)
    const res = this.tx(() => {
      const seen = this.one<MessageRow>('SELECT * FROM messages WHERE conv = ? AND run IS ? AND key = ?', conv, o.run, key)
      if (seen) return { message: seen, duplicate: true }
      const at = now()
      this.touch(conv)
      const id = Number(this.db.prepare('INSERT INTO messages (conv, role, author, text, at, re, kind, run, attempt, question, key, participant, invitation) VALUES (?, \'agent\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(conv, o.author, o.text, at, JSON.stringify(re), kind, o.run, o.attempt ?? null, o.question ?? null, key, participant, inv?.id ?? null).lastInsertRowid)
      // The run's own invitation, and those delivered to it since (a reply
      // to its question): a reply, result or synthesis answers them.
      const answered = ANSWERING.includes(kind) ? [...(inv && inv.state !== 'answered' ? [inv] : []), ...this.all<InvitationRow>('SELECT * FROM invitations WHERE conv = ? AND run = ? AND delivery IS NOT NULL AND state = \'started\' AND id IS NOT ?', conv, o.run, inv?.id ?? null)] : []
      for (const a of answered) {
        const late = a.state === 'unanswered' || a.state === 'withdrawn' || a.state === 'failed' ? 1 : 0
        this.db.prepare('UPDATE invitations SET state = \'answered\', answered_by = ?, late = ?, updated = ? WHERE id = ?').run(id, late, at, a.id)
        this.event(conv, a.id, 'answered', { run: o.run, message: id, note: late ? `answered late (was ${a.state})` : 'answered' })
      }
      return { message: this.cs.message(id)!, duplicate: false }
    })
    if (inv) await this.afterResolution(inv.id)
    return { ...res, invitation: inv && this.invitation(inv.id)! }
  }

  // When an invitation awaited by a facilitator run is resolved and nothing
  // else that run awaits is still open, the run is told the outcomes in one
  // instruction, which continues it if it waits (runs.md, "An instruction
  // continues a run nobody executes"). Each outcome is told once (a late
  // answer is a new outcome). A closed discussion continues nobody; a
  // facilitator still in its attempt is told after it (reconcile).
  async afterResolution(id: number): Promise<string | null> {
    const i = this.invitation(id)
    if (!i?.awaited_by || !resolved(i.state)) return null
    const c = this.cs.conversation(i.conv)!
    if (c.state === 'closed') return null
    const awaited = this.all<InvitationRow>('SELECT * FROM invitations WHERE awaited_by = ? AND conv = ? ORDER BY id', i.awaited_by, i.conv)
    if (awaited.some(a => OPEN_STATES.includes(a.state))) return null
    const untold = awaited.filter(a => a.reported !== label(a))
    if (!untold.length || !this.exec) return null
    const outcome = (a: InvitationRow) => a.state === 'answered' ? `answered${a.late ? ' late' : ''} by #${a.answered_by} (${a.run})`
      : a.state === 'unanswered' ? `unanswered: ${a.run} ended without a contribution`
      : a.state === 'failed' ? `failed: ${a.error}` : `withdrawn: ${a.error ?? ''}`
    const text = [`Discussion ${i.conv}: the invitations you awaited are resolved.`, ...untold.map(a => `- invitation ${a.id} to ${a.participant}: ${outcome(a)}`), `Read what was said: wfe discussion show ${i.conv} --since ${Math.min(...untold.map(a => a.horizon || 0))}`].join('\n')
    const ids = untold.map(a => `${a.id}-${label(a)}`).join('.')
    let receipt = `discussion:${i.conv}:continue:${i.awaited_by}:${ids}`
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
      const fr = (await readRun(ws, ref)).record as RunRecord | null
      if (fr && (fr.control.attempt || fr.execution.state === 'not-started')) return null
      const source: ConversationSource | undefined = m ? { kind: 'conversation', conversation: i.conv, message: m.id, author: m.author, at: m.at } : undefined
      const r = await runOp(ws, ref, { op: 'instruction.receive', text, from: `discussion ${i.conv}`, ...(source ? { source } : {}), receipt }, { by: 'discussion', via: 'discussion' })
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
        this.tx(() => {
          this.db.prepare('UPDATE invitations SET state = \'unanswered\', updated = ? WHERE id = ? AND state = \'started\'').run(now(), i.id)
          this.event(i.conv, i.id, 'unanswered', { run: i.run, note: `${i.run} is ${s} and contributed no answer` })
        })
        notes.push(`discussion ${i.conv} invitation ${i.id}: unanswered (${i.run} ${s})`)
        const told = await this.afterResolution(i.id)
        if (told) notes.push(`discussion ${i.conv}: ${told}`)
      } catch { /* an unreadable run is read again next time */ }
    }
    for (const r of this.all<{ awaited_by: string; conv: string; id: number }>('SELECT awaited_by, conv, max(id) AS id FROM invitations WHERE awaited_by IS NOT NULL AND (reported IS NULL OR reported != state || CASE WHEN late = 1 THEN \'-late\' ELSE \'\' END) AND state NOT IN (\'pending\', \'started\') GROUP BY awaited_by, conv')) {
      const told = await this.afterResolution(r.id)
      if (told) notes.push(`discussion ${r.conv}: ${told}`)
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
    return { id: m.id, role: m.role, author: m.author, participant: m.participant, text: m.text, at: m.at, via: m.via, re: JSON.parse(m.re) as number[], kind: m.kind, run, runUrl: run ? runUrl(viewBase, run) : null, attempt: m.attempt, question: m.question, invitation: m.invitation, addressed: m.addressed ? JSON.parse(m.addressed) as string[] : [] }
  }
  invitationView(i: InvitationRow, viewBase?: string | null): Invitation {
    return { id: i.id, participant: i.participant, target: `${i.workspace}/${i.workflow}`, question: i.question, source: JSON.parse(i.source) as number[], by: i.by, byRun: i.by_run, awaitedBy: i.awaited_by, horizon: i.horizon, state: i.state, late: !!i.late, run: i.run, runUrl: i.run ? runUrl(viewBase, i.run) : null, error: i.error, tries: i.tries, created: i.created, updated: i.updated, answeredBy: i.answered_by, reported: i.reported, deliveredTo: i.delivery ? (JSON.parse(i.delivery) as { message: number }).message : null }
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
    for (const i of invitations) if (i.run) add(i.run, `invitation ${i.id}`)
    for (const l of links) add(l.run, l.relation)
    const runs: RunEntry[] = await this.cs.runEntries([...keys].map(([key, rel]) => ({ key, relation: [...rel].join(', ') })), o.viewBase)
    return {
      discussion: { id: c.id, title: c.title, created: c.created, updated: c.updated, state: c.state, by: c.by, facilitator: `${c.workspace}/${c.workflow}` },
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
