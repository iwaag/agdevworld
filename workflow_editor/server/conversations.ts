// Conversations (project_migration p8; workflow_editor p15,
// docs/conversations.md): a person's continuing conversation with one
// project's conversational workflow — its destination, recorded when the
// conversation is created and never changed — kept apart from any one run.
// This module keeps, in <area>/.local/conversations/conversations.sqlite:
//
// - conversations: an id (the client mints it), a title, open or closed,
//   and the destination (workspace and workflow) every turn goes to;
// - messages: the person's words as they were said (author, time, the
//   submit token that makes a resubmission one message, the way they came
//   when not a page: `via`, e.g. slack) and the destination agent's
//   replies, each naming the run and attempt that wrote it and the messages
//   it answers (`re`). A reply never borrows "the newest message" as its
//   target: concurrent work is told apart by its run;
// - links: what a message is to a run. `turn` is recorded here: every
//   person's message starts one bounded run of the destination workflow
//   (receipt `conversation:<id>:<message>`, so a replay or restart finds the
//   same run). The destination's agent records its interpretation itself
//   (new, follow-up, correction, steer, answer, question, informational,
//   cites), and a correction is a newer link superseding an older one: the
//   message is never rewritten.
//
// The store routes and persists; the destination's agent decides what a
// message means. Run state stays the runs' own records; nothing here mirrors
// it. Which destinations a new conversation may name is configuration
// (conversations.json `targets`); who a target is to a person (a character,
// a picture) is the client's.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ConversationSource } from '../shared/intake.ts'
import type { Workflow } from '../shared/model.ts'
import { runDisplayTitle, runKey, situation, type RunRecord, type RunRef } from '../shared/run.ts'
import type { ExecStore } from './exec.ts'
import { presenterOf, type Presenter } from './present.ts'
import { nodeNames, readRun } from './runs.ts'
import { runStatus, type RunStatus } from '../shared/status.ts'
import { openStore, transaction } from './sqlite.ts'
import { RequestError } from './workspace.ts'
import { DISCUSSION_MIGRATIONS } from './discussionSchema.ts'

export const CONVERSATION_ID = /^[a-z0-9][a-z0-9-]{0,47}$/
export const RELATIONS = ['turn', 'new', 'follow-up', 'correction', 'steer', 'answer', 'question', 'informational', 'cites', 'handoff'] as const
export type Relation = typeof RELATIONS[number]
// `announce` (argue p4): the conductor's own speech in a discussion — an
// agenda, context, an interim synthesis or a conclusion; it waits for nobody.
export const MESSAGE_KINDS = ['message', 'reply', 'question', 'progress', 'result', 'synthesis', 'announce'] as const
export type MessageKind = typeof MESSAGE_KINDS[number]
const MAX_TEXT = 100_000
const VIA = /^[a-z0-9][a-z0-9:._ -]{0,63}$/

// <area>/conversations.json: the destinations a new conversation may name,
// and who the person writing through pages is.
//   { "person": "iwaag", "targets": [{ "workspace": "front", "workflow": "converse" }, …] }
export interface ConversationTarget { workspace: string; workflow: string }
export interface ConversationConfig { targets: ConversationTarget[]; person: string }
const NAME = /^[a-z0-9][a-z0-9_.-]*$/
export const targetName = (t: ConversationTarget) => `${t.workspace}/${t.workflow}`
export function parseTarget(text: string): ConversationTarget {
  const [workspace, workflow, ...rest] = text.split('/')
  if (rest.length || !NAME.test(workspace ?? '') || !NAME.test(workflow ?? '')) throw new RequestError(400, `"${text}" is not a destination (<workspace>/<workflow>)`)
  return { workspace, workflow }
}
export function loadConversationConfig(area: string): ConversationConfig | { disabled: string } {
  const file = join(area, 'conversations.json')
  if (!existsSync(file)) return { disabled: `no ${file}: no conversation targets are configured here` }
  try {
    const o = JSON.parse(readFileSync(file, 'utf8')) as { targets?: unknown; person?: unknown }
    const shape = `${file} needs {"person", "targets": [{"workspace", "workflow"}, …]}`
    if (typeof o.person !== 'string' || !o.person || !Array.isArray(o.targets)) return { disabled: shape }
    const targets: ConversationTarget[] = []
    for (const t of o.targets as Partial<ConversationTarget>[]) {
      if (typeof t?.workspace !== 'string' || typeof t.workflow !== 'string' || !NAME.test(t.workspace) || !NAME.test(t.workflow)) return { disabled: shape }
      targets.push({ workspace: t.workspace, workflow: t.workflow })
    }
    return { targets, person: o.person }
  } catch (e) { return { disabled: `${file} cannot be read: ${(e as Error).message}` } }
}

// A configured target as a client sees it: the project and workflow it
// names, the agent that answers, and whether a conversation could start a
// turn there now.
export interface TargetView {
  target: string; workspace: string; workflow: string
  project: string | null; projectName: string | null; workflowName: string | null; intent: string | null; agent: string | null
  state: 'available' | 'unavailable'; problem: string | null
}

export interface ConversationRow {
  id: string; title: string; created: string; updated: string; state: 'open' | 'closed'; by: string; workspace: string | null; workflow: string | null; kind: 'conversation' | 'discussion'
  conductor?: string | null // a discussion's conductor run (argue p4)
  requester?: string | null // a discussion's requester, JSON (argue p4)
}
export interface MessageRow {
  id: number; conv: string; role: 'person' | 'agent'; author: string; text: string; at: string
  token: string | null; via: string | null; re: string; kind: MessageKind; run: string | null; attempt: string | null; question: string | null; key: string | null
  dispatch_state: 'pending' | 'started' | 'failed' | null; dispatch_run: string | null; dispatch_error: string | null; dispatch_tries: number
  // A discussion's (workflow_editor p16, server/discussions.ts): the member who
  // spoke, the invitation an agent's message answers, and the members a
  // person's message addressed (JSON list).
  participant: string | null; invitation: number | null; addressed: string | null
  node?: string | null // the node of its run it was spoken for (argue p4)
}
export interface LinkRow { id: number; conv: string; message: number; run: string; relation: Relation; note: string; by: string; attempt: string | null; at: string; supersedes: number | null }

export interface Message {
  id: number; role: 'person' | 'agent'; author: string; text: string; at: string; via: string | null; re: number[]; kind: MessageKind
  run: string | null; runUrl: string | null; question: string | null
  dispatch: { state: 'pending' | 'started' | 'failed'; run: string | null; error: string | null } | null
}

const now = () => new Date().toISOString()
// A run as conversations name it: <workspace>/<workflow>/<run>.
export const runName = (workspace: string, ref: RunRef) => `${workspace}/${runKey(ref)}`
export function parseRunName(name: string): { workspace: string; ref: RunRef } {
  const m = /^([a-z0-9][a-z0-9_.-]*)\/([a-z0-9][a-z0-9_.-]*)\/(run-[a-z0-9][a-z0-9_.-]*)$/.exec(name)
  if (!m) throw new RequestError(400, `"${name}" is not a run (<workspace>/<workflow>/<run>)`)
  return { workspace: m[1], ref: { workflow: m[2], run: m[3] } }
}

export class ConversationStore {
  readonly db: DatabaseSync
  readonly area: string
  readonly exec?: ExecStore
  constructor(o: { area: string; exec?: ExecStore }) {
    this.area = o.area
    this.exec = o.exec
    const dir = join(o.area, '.local', 'conversations')
    mkdirSync(dir, { recursive: true })
    this.db = openStore('conversation store', join(dir, 'conversations.sqlite'), [{
      version: 1,
      up: db => db.exec(`
        CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, state TEXT NOT NULL, by TEXT NOT NULL);
        CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, role TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL,
          token TEXT, re TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL, run TEXT, attempt TEXT, question TEXT, key TEXT,
          dispatch_state TEXT, dispatch_run TEXT, dispatch_error TEXT, dispatch_tries INTEGER NOT NULL DEFAULT 0,
          UNIQUE (conv, token), UNIQUE (conv, run, key));
        CREATE INDEX messages_conv ON messages (conv, id);
        CREATE TABLE links (id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, message INTEGER NOT NULL, run TEXT NOT NULL, relation TEXT NOT NULL,
          note TEXT NOT NULL, by TEXT NOT NULL, attempt TEXT, at TEXT NOT NULL, supersedes INTEGER);
        CREATE INDEX links_conv ON links (conv, message);
        CREATE INDEX links_run ON links (run);
      `),
    }, {
      // slack_connect p1: the way a person's message came (null: a page or the CLI).
      version: 2,
      up: db => db.exec('ALTER TABLE messages ADD COLUMN via TEXT'),
    }, {
      // workflow_editor p15: every conversation records its destination.
      // Conversations from before had one: the single entrance the
      // configuration named then, which this step maps once.
      version: 3,
      up: db => {
        db.exec('ALTER TABLE conversations ADD COLUMN workspace TEXT; ALTER TABLE conversations ADD COLUMN workflow TEXT')
        const before = formerEntrance(o.area)
        if (before) db.prepare('UPDATE conversations SET workspace = ?, workflow = ? WHERE workspace IS NULL').run(before.workspace, before.workflow)
      },
    }, ...DISCUSSION_MIGRATIONS])
  }
  close() { this.db.close(); this._presenter?.close() }
  // This host's presentation store, opened when a linked run has presentations.
  private _presenter: Presenter | null | undefined
  private presenter(): Presenter | null {
    if (this._presenter === undefined) this._presenter = this.exec ? presenterOf(this.area, this.exec.ctx.registryFile) : null
    return this._presenter
  }
  config() { return loadConversationConfig(this.area) }

  private tx<T>(f: () => T): T { return transaction(this.db, f, 'conversation store') }
  private all<T>(sql: string, ...a: (string | number | null)[]): T[] { return this.db.prepare(sql).all(...a) as T[] }
  private one<T>(sql: string, ...a: (string | number | null)[]): T | undefined { return this.db.prepare(sql).get(...a) as T | undefined }

  conversation(id: string): ConversationRow | undefined { return this.one<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id) }
  list(o: { target?: ConversationTarget; kind?: ConversationRow['kind'] } = {}): (ConversationRow & { last: MessageRow | null; count: number })[] {
    const kind = o.kind ?? 'conversation'
    const rows = o.target
      ? this.all<ConversationRow>('SELECT * FROM conversations WHERE kind = ? AND workspace = ? AND workflow = ? ORDER BY updated DESC', kind, o.target.workspace, o.target.workflow)
      : this.all<ConversationRow>('SELECT * FROM conversations WHERE kind = ? ORDER BY updated DESC', kind)
    return rows.map(c => ({
      ...c, last: this.one<MessageRow>('SELECT * FROM messages WHERE conv = ? ORDER BY id DESC LIMIT 1', c.id) ?? null,
      count: this.one<{ n: number }>('SELECT count(*) AS n FROM messages WHERE conv = ?', c.id)!.n,
    }))
  }
  messages(conv: string, since = 0): MessageRow[] { return this.all<MessageRow>('SELECT * FROM messages WHERE conv = ? AND id > ? ORDER BY id', conv, since) }
  message(id: number): MessageRow | undefined { return this.one<MessageRow>('SELECT * FROM messages WHERE id = ?', id) }
  links(conv: string): LinkRow[] { return this.all<LinkRow>('SELECT * FROM links WHERE conv = ? ORDER BY id', conv) }
  // The conversations a run is linked to (the run's own source first).
  conversationsOfRun(run: string): string[] { return this.all<{ conv: string }>('SELECT DISTINCT conv FROM links WHERE run = ? ORDER BY id', run).map(r => r.conv) }

  // ---- the person's words ----------------------------------------------------------

  // A person's message: stored first, then its turn is started. The same
  // token twice is one message (a resubmitted form, a retried request). A
  // post to a closed conversation reopens it. A new id creates the
  // conversation with the destination `target` names, which must be one of
  // the configured targets; nothing defaults to any project. A target that
  // differs from an existing conversation's destination is refused: another
  // destination is another conversation. `via` names the way the words came
  // when not a page (e.g. slack).
  async post(conv: string, o: { text: string; author: string; token: string; re?: number[]; title?: string; via?: string; target?: ConversationTarget }): Promise<{ message: MessageRow; duplicate: boolean; reopened: boolean }> {
    if (!CONVERSATION_ID.test(conv)) throw new RequestError(400, `conversation id must match ${CONVERSATION_ID.source}`)
    if (!o.text.trim()) throw new RequestError(400, 'the message is empty')
    if (o.text.length > MAX_TEXT) throw new RequestError(413, `a message is at most ${MAX_TEXT} characters`)
    if (!/^[A-Za-z0-9:._/#-]{8,200}$/.test(o.token)) throw new RequestError(400, 'a message needs a submit token (8–200 of A-Z a-z 0-9 : . _ / # -)')
    if (o.via !== undefined && !VIA.test(o.via)) throw new RequestError(400, `via must match ${VIA.source}`)
    const re = this.validRe(conv, o.re ?? [])
    const existing = this.conversation(conv)
    notDiscussion(existing)
    if (existing && o.target && (existing.workspace !== o.target.workspace || existing.workflow !== o.target.workflow)) {
      throw new RequestError(409, `conversation ${conv} is with ${existing.workspace}/${existing.workflow}, not ${targetName(o.target)}: start a new conversation for another destination`, { code: 'other-destination', destination: existing.workspace && `${existing.workspace}/${existing.workflow}` })
    }
    if (!existing) {
      if (!o.target) throw new RequestError(400, `conversation ${conv} does not exist yet: its first message names its destination (target <workspace>/<workflow>)`, { code: 'no-destination' })
      const cfg = this.config()
      if ('disabled' in cfg) throw new RequestError(503, cfg.disabled)
      if (!cfg.targets.some(t => t.workspace === o.target!.workspace && t.workflow === o.target!.workflow)) throw new RequestError(400, `${targetName(o.target)} is not a conversation target here (${cfg.targets.map(targetName).join(', ') || 'none configured'})`, { code: 'unknown-target' })
    }
    const res = this.tx(() => {
      const seen = this.one<MessageRow>('SELECT * FROM messages WHERE conv = ? AND token = ?', conv, o.token)
      if (seen) return { message: seen, duplicate: true, reopened: false }
      const at = now()
      const c = this.conversation(conv)
      const reopened = c?.state === 'closed'
      if (!c) this.db.prepare('INSERT INTO conversations (id, title, created, updated, state, by, workspace, workflow) VALUES (?, ?, ?, ?, \'open\', ?, ?, ?)').run(conv, o.title?.trim() || firstLine(o.text), at, at, o.author, o.target!.workspace, o.target!.workflow)
      else this.db.prepare('UPDATE conversations SET updated = ?, state = \'open\' WHERE id = ?').run(at, conv)
      const id = Number(this.db.prepare('INSERT INTO messages (conv, role, author, text, at, token, via, re, kind, dispatch_state) VALUES (?, \'person\', ?, ?, ?, ?, ?, ?, \'message\', \'pending\')').run(conv, o.author, o.text, at, o.token, o.via ?? null, JSON.stringify(re)).lastInsertRowid)
      return { message: this.message(id)!, duplicate: false, reopened }
    })
    if (res.message.dispatch_state !== 'started') await this.dispatch(res.message.id)
    return { message: this.message(res.message.id)!, duplicate: res.duplicate, reopened: res.reopened }
  }

  // Starts the turn of a person's message: one run of the conversation's
  // recorded destination with the message as the person's words — the
  // destination it was created with, whatever the configuration says now.
  // Repeating it finds the same run (the request's receipt), so a crash
  // between the request and the record here is repaired by dispatching
  // again. A destination that cannot take the request leaves the message
  // `failed` with the reason; it is never sent elsewhere.
  async dispatch(id: number): Promise<MessageRow> {
    const m = this.message(id)
    if (!m || m.role !== 'person' || m.dispatch_state === 'started') return m!
    const c = this.conversation(m.conv)
    try {
      if (!c?.workspace || !c.workflow) throw new Error(`conversation ${m.conv} has no recorded destination`)
      if (!this.exec) throw new Error('execution is not configured here')
      const source: ConversationSource = { kind: 'conversation', conversation: m.conv, message: m.id, author: m.author, at: m.at }
      const r = await this.exec.request({ workspace: c.workspace, workflow: c.workflow, text: m.text, author: m.author, receipt: `conversation:${m.conv}:${m.id}`, via: 'conversation', source })
      const run = runName(c.workspace, r.ref)
      this.tx(() => {
        this.db.prepare('UPDATE messages SET dispatch_state = \'started\', dispatch_run = ?, dispatch_error = NULL, dispatch_tries = dispatch_tries + 1 WHERE id = ?').run(run, id)
        if (!this.one('SELECT 1 FROM links WHERE message = ? AND relation = \'turn\'', id)) this.db.prepare('INSERT INTO links (conv, message, run, relation, note, by, at) VALUES (?, ?, ?, \'turn\', ?, \'conversation\', ?)').run(m.conv, id, run, 'the run started for this message', now())
      })
    } catch (e) {
      this.db.prepare('UPDATE messages SET dispatch_state = \'failed\', dispatch_error = ?, dispatch_tries = dispatch_tries + 1 WHERE id = ?').run((e as Error).message, id)
    }
    return this.message(id)!
  }

  // Messages whose turn has not started (a failed request, a crash before
  // it): tried again, oldest first. Called by the executor's reconcile.
  async dispatchDue(): Promise<string[]> {
    const notes: string[] = []
    for (const m of this.all<MessageRow>('SELECT * FROM messages WHERE role = \'person\' AND dispatch_state IN (\'pending\', \'failed\') ORDER BY id')) {
      const after = await this.dispatch(m.id)
      notes.push(after.dispatch_state === 'started' ? `conversation ${m.conv} #${m.id}: started ${after.dispatch_run}` : `conversation ${m.conv} #${m.id}: not started — ${after.dispatch_error}`)
    }
    return notes
  }

  // ---- the destination's replies and interpretation ------------------------------------

  // A reply by a run's agent (or a named author). `key` makes a retried
  // command one message; by default it is the text's hash.
  reply(conv: string, o: { text: string; author: string; run: string | null; attempt?: string | null; re?: number[]; kind?: MessageKind; question?: string | null; key?: string }): { message: MessageRow; duplicate: boolean } {
    const c = this.conversation(conv)
    if (!c) throw new RequestError(404, `no conversation ${conv}`)
    notDiscussion(c)
    if (!o.text.trim()) throw new RequestError(400, 'the reply is empty')
    if (o.text.length > MAX_TEXT) throw new RequestError(413, `a message is at most ${MAX_TEXT} characters`)
    const kind = o.kind ?? 'reply'
    if (!(MESSAGE_KINDS as readonly string[]).includes(kind) || kind === 'message' || kind === 'announce') throw new RequestError(400, `a reply's kind is one of ${MESSAGE_KINDS.filter(k => k !== 'message' && k !== 'announce').join(', ')}`)
    const re = this.validRe(conv, o.re ?? [])
    const key = o.key ?? createHash('sha256').update(o.text).digest('hex').slice(0, 24)
    return this.tx(() => {
      const seen = this.one<MessageRow>('SELECT * FROM messages WHERE conv = ? AND run IS ? AND key = ?', conv, o.run, key)
      if (seen) return { message: seen, duplicate: true }
      const at = now()
      this.db.prepare('UPDATE conversations SET updated = ? WHERE id = ?').run(at, conv)
      const id = Number(this.db.prepare('INSERT INTO messages (conv, role, author, text, at, re, kind, run, attempt, question, key) VALUES (?, \'agent\', ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(conv, o.author, o.text, at, JSON.stringify(re), kind, o.run, o.attempt ?? null, o.question ?? null, key).lastInsertRowid)
      return { message: this.message(id)!, duplicate: false }
    })
  }

  // What a message is to a run, as the destination's agent reads it. The
  // same link twice is one link; a different relation for the same message
  // and run supersedes the earlier one (a correction keeps both).
  link(conv: string, o: { message: number; run: string; relation: Relation; note: string; by: string; attempt?: string | null }): { link: LinkRow; duplicate: boolean } {
    const m = this.message(o.message)
    if (!m || m.conv !== conv) throw new RequestError(404, `message #${o.message} is not in conversation ${conv}`)
    if (!(RELATIONS as readonly string[]).includes(o.relation) || o.relation === 'turn') throw new RequestError(400, `a relation is one of ${RELATIONS.filter(r => r !== 'turn').join(', ')}`)
    parseRunName(o.run)
    if (!o.note.trim()) throw new RequestError(400, 'say why (--note): what the message is to that run')
    return this.tx(() => {
      const current = this.all<LinkRow>('SELECT * FROM links WHERE message = ? AND run = ? AND relation != \'turn\' ORDER BY id', o.message, o.run)
      const newest = current.at(-1)
      if (newest && newest.relation === o.relation && newest.note === o.note.trim()) return { link: newest, duplicate: true }
      const id = Number(this.db.prepare('INSERT INTO links (conv, message, run, relation, note, by, attempt, at, supersedes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(conv, o.message, o.run, o.relation, o.note.trim(), o.by, o.attempt ?? null, now(), newest?.id ?? null).lastInsertRowid)
      return { link: this.one<LinkRow>('SELECT * FROM links WHERE id = ?', id)!, duplicate: false }
    })
  }

  closeConversation(conv: string): ConversationRow {
    if (!this.conversation(conv)) throw new RequestError(404, `no conversation ${conv}`)
    notDiscussion(this.conversation(conv))
    this.db.prepare('UPDATE conversations SET state = \'closed\', updated = ? WHERE id = ?').run(now(), conv)
    return this.conversation(conv)!
  }

  // The source a run operation names for a person's message (instructions
  // and answers carried from the conversation keep the words' origin).
  source(conv: string, message: number): ConversationSource {
    const m = this.message(message)
    if (!m || m.conv !== conv || m.role !== 'person') throw new RequestError(404, `#${message} is not a person's message of conversation ${conv}`)
    return { kind: 'conversation', conversation: conv, message, author: m.author, at: m.at }
  }

  private validRe(conv: string, re: number[]): number[] {
    if (!Array.isArray(re) || !re.every(n => Number.isInteger(n))) throw new RequestError(400, 're is a list of message ids')
    for (const n of re) { const m = this.message(n); if (!m || m.conv !== conv) throw new RequestError(400, `message #${n} is not in conversation ${conv}`) }
    return [...new Set(re)]
  }

  // ---- targets ---------------------------------------------------------------------

  // The configured targets as their projects say now: a target whose
  // workspace or workflow cannot be read is listed as unavailable with the
  // reason, never left out.
  async targets(): Promise<TargetView[]> {
    const cfg = this.config()
    if ('disabled' in cfg) return []
    return Promise.all(cfg.targets.map(t => this.target(t)))
  }
  async target(t: ConversationTarget): Promise<TargetView> {
    const base: TargetView = { target: targetName(t), ...t, project: null, projectName: null, workflowName: null, intent: null, agent: null, state: 'unavailable', problem: null }
    try {
      if (!this.exec) throw new Error('execution is not configured here')
      const ws = await this.exec.workspace(t.workspace)
      const [project, files] = await Promise.all([ws.readProject().catch(() => ({ project: undefined })), ws.workflowFiles()])
      Object.assign(base, { project: ws.reg.project ?? null, projectName: project.project?.name || null })
      let wf: Workflow | undefined
      for (const f of files) { const r = await ws.readWorkflowFile(f); if (r.workflow?.id === t.workflow) { wf = r.workflow; break } }
      if (!wf) throw new Error(`workspace ${t.workspace} has no workflow "${t.workflow}"`)
      return { ...base, workflowName: wf.name || null, intent: wf.intent || null, agent: wf.execution.agent || null, state: 'available' }
    } catch (e) { return { ...base, problem: (e as Error).message } }
  }

  // Runs as their own records say now: the shared status reading (p8 ex1),
  // where its results open — its file route (a path in the run folder
  // appended) and its presentations that serve now. A run that cannot be
  // read is listed with the reason, never left out.
  async runEntries(keys: { key: string; relation: string }[], viewBase?: string | null): Promise<RunEntry[]> {
    const files = (workspace: string, ref: RunRef) => viewBase ? `${viewBase.replace(/\/?$/, '/')}api/projects/${encodeURIComponent(workspace)}/runs/${encodeURIComponent(ref.workflow)}/${encodeURIComponent(ref.run)}/raw?path=` : null
    const cfg = loadConversationConfig(this.area)
    const person = 'disabled' in cfg ? null : cfg.person
    const runs: RunEntry[] = []
    for (const { key, relation } of keys) {
      const { workspace, ref } = parseRunName(key)
      const entry = { key, workspace, workflow: ref.workflow, run: ref.run, relation, url: runUrl(viewBase, key), files: files(workspace, ref) }
      try {
        if (!this.exec) throw new Error('execution is not configured here')
        const ws = await this.exec.workspace(workspace)
        const reading = await readRun(ws, ref)
        const rec = reading.record as RunRecord | null
        if (!rec) throw new Error('the run cannot be read')
        const job = this.exec.runRows(workspace, ref).jobs.find(j => j.state === 'queued' || j.state === 'claimed') ?? null
        const status = runStatus(rec, { names: nodeNames(reading.bundle, rec), job: job && { state: job.state as 'queued' | 'claimed', reason: job.reason }, person })
        const presenter = rec.presentations ? this.presenter() : null
        const shown = presenter ? (await presenter.view(ws, rec).catch(() => [])).filter(p => p.live && p.url && !p.local).map(p => ({ id: p.id, title: p.title, url: p.url! })) : []
        runs.push({ ...entry, situation: situation(rec), execution: rec.execution.state, title: runDisplayTitle(rec), waiting: rec.execution.waiting.map(w => w.node), status, presentations: shown })
      } catch (e) {
        // A run of a project no longer registered here (a retired one, argue
        // p4 ex1) has no run view to open: no link is made up for it.
        const gone = e instanceof RequestError && e.status === 404 && /is not registered/.test(e.message)
        runs.push({ ...entry, ...(gone ? { url: null, files: null } : {}), situation: 'unknown', execution: 'unknown', title: null, waiting: [], status: null, presentations: [], problem: gone ? `${(e as Error).message} here (a retired or unknown project): no run view; the run's record stays in that project's history` : (e as Error).message })
      }
    }
    return runs
  }

  // ---- the view --------------------------------------------------------------------

  // The conversation with every message, its links, and the runs it is
  // linked to as their own records say now (situation, execution, waits).
  // Questions the destination asked are pending until a later message of the
  // person names them, or — when exactly one is pending — follows them.
  async view(conv: string, o: { viewBase?: string | null; since?: number } = {}) {
    const c = this.conversation(conv)
    if (!c) throw new RequestError(404, `no conversation ${conv}`)
    notDiscussion(c)
    const url = (run: string) => runUrl(o.viewBase, run)
    const rows = this.messages(conv)
    const links = this.links(conv)
    const asking = pendingQuestions(rows)
    // The runs linked to its messages, and the destination's own run of each
    // message (relation `turn`), with the shared status reading (p8 ex1).
    const turns = rows.filter(m => m.role === 'person' && m.dispatch_run).map(m => m.dispatch_run!)
    const runs = await this.runEntries([...new Set([...links.map(l => l.run), ...turns])].map(key => ({
      key, relation: [...new Set([...links.filter(l => l.run === key).map(l => l.relation), ...(turns.includes(key) ? ['turn'] : [])])].join(', '),
    })), o.viewBase)
    const message = (m: MessageRow): Message => ({
      id: m.id, role: m.role, author: m.author, text: m.text, at: m.at, via: m.via, re: JSON.parse(m.re) as number[], kind: m.kind, run: m.run ?? m.dispatch_run, runUrl: (m.run ?? m.dispatch_run) ? url((m.run ?? m.dispatch_run)!) : null, question: m.question,
      dispatch: m.role === 'person' ? { state: m.dispatch_state ?? 'pending', run: m.dispatch_run, error: m.dispatch_error } : null,
    })
    const destination = c.workspace && c.workflow ? targetName({ workspace: c.workspace, workflow: c.workflow }) : null
    return { conversation: { ...c, destination }, messages: rows.filter(m => m.id > (o.since ?? 0)).map(message), links, runs, asking }
  }
}

export interface RunEntry {
  key: string; workspace: string; workflow: string; run: string; relation: string; url: string | null; files: string | null
  situation: string; execution: string; title: string | null; waiting: string[]; status: RunStatus | null; presentations: { id: string; title: string; url: string }[]; problem?: string
}
export const runUrl = (viewBase: string | null | undefined, run: string) => { if (!viewBase) return null; const { workspace, ref } = parseRunName(run); return `${viewBase.replace(/\/?$/, '/')}#/ws/${encodeURIComponent(workspace)}/run/${encodeURIComponent(ref.workflow)}/${encodeURIComponent(ref.run)}` }

// The destination's questions not yet answered by the person: named by a later
// message's `re`, or followed by the person's next message when it was the
// only one pending.
export function pendingQuestions(rows: MessageRow[]): number[] {
  const pending: number[] = []
  for (const m of rows) {
    if (m.role === 'agent' && m.kind === 'question') { pending.push(m.id); continue }
    if (m.role !== 'person') continue
    const re = JSON.parse(m.re) as number[]
    if (re.length) { for (const r of re) { const i = pending.indexOf(r); if (i >= 0) pending.splice(i, 1) } } else if (pending.length === 1) pending.pop()
  }
  return pending
}

// Where remote readers reach the editor (zulip.json viewBase, else the
// presentation answer base): links from a conversation to its runs.
export function viewBaseOf(area: string): string | null {
  for (const [file, key] of [['zulip.json', 'viewBase'], ['present.json', 'answerBase']] as const) {
    try { const v = (JSON.parse(readFileSync(join(area, file), 'utf8')) as Record<string, unknown>)[key]; if (typeof v === 'string' && v) return v } catch { /* the next one */ }
  }
  return null
}

// The single entrance the configuration named before p15
// ({"entrance": {workspace, workflow}}), or its first target: what the
// conversations from before destinations existed were with.
function formerEntrance(area: string): ConversationTarget | null {
  try {
    const o = JSON.parse(readFileSync(join(area, 'conversations.json'), 'utf8')) as { entrance?: Partial<ConversationTarget>; targets?: Partial<ConversationTarget>[] }
    const t = o.entrance ?? o.targets?.[0]
    return t?.workspace && t.workflow ? { workspace: t.workspace, workflow: t.workflow } : null
  } catch { return null }
}

// A discussion has members and invitations instead of one destination
// (docs/discussions.md): the conversation operations would give it the wrong
// meaning, so they refuse it and say where it is served.
function notDiscussion(c: ConversationRow | undefined) {
  if (c?.kind === 'discussion') throw new RequestError(409, `${c.id} is a discussion, not a conversation: use wfe discussion (api/discussions/${c.id})`, { code: 'is-discussion' })
}

export const firstLine = (t: string) => { const l = t.trim().split('\n')[0]; return l.length > 80 ? `${l.slice(0, 77)}…` : l }
