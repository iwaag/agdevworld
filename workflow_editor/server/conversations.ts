// The conversation store (project_migration p8, workflow_editor p15/p16,
// challenge p2; docs/conversations.md): the records every conversation keeps
// in <area>/.local/conversations/conversations.sqlite, and the configuration
// of who can take part. Conversations, messages (verbatim, with author, time,
// submit token, `via` and `re`), links (what a message is to a run) and
// attachments (challenges a message carried) live here; the rest of a
// conversation — members, response requests, facilitation, the conductor's
// activities, overviews — and every operation that routes or delivers is the
// conversation service (server/conversationService.ts), the one engine for
// one-to-one and facilitated rooms alike. Run state stays the runs' own
// records; nothing here mirrors it. Who a participant is to a person (a
// character, a picture) is the client's.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AttachmentRef, ConversationSource } from '../shared/intake.ts'
import type { ChallengeStore } from './challenges.ts'
import type { PinnedAttachment } from './runs.ts'
import type { Workflow } from '../shared/model.ts'
import { runDisplayTitle, runKey, situation, type RunRecord, type RunRef } from '../shared/run.ts'
import { reviewStateText, subjectRun } from '../shared/humanReview.ts'
import type { ExecStore } from './exec.ts'
import { presenterOf, type Presenter } from './present.ts'
import { nodeNames, readRun } from './runs.ts'
import { runStatus, type RunStatus } from '../shared/status.ts'
import { creationOf } from './observe.ts'
import { openStore, transaction } from './sqlite.ts'
import { RequestError } from './workspace.ts'
import { CONVERSATION_MIGRATIONS } from './conversationSchema.ts'

export const CONVERSATION_ID = /^[a-z0-9][a-z0-9-]{0,47}$/
export const RELATIONS = ['turn', 'new', 'follow-up', 'correction', 'steer', 'answer', 'question', 'informational', 'cites', 'handoff'] as const
export type Relation = typeof RELATIONS[number]
// `announce` (argue p4): the conductor's own speech in a discussion — an
// agenda, context, an interim synthesis or a conclusion; it waits for nobody.
export const MESSAGE_KINDS = ['message', 'reply', 'question', 'progress', 'result', 'synthesis', 'announce'] as const
export type MessageKind = typeof MESSAGE_KINDS[number]

// <area>/conversations.json (challenge p2): who the person writing through
// pages is, the projects that can take part with the workflow each uses in a
// one-to-one room (`converse`) and among several (`discuss`), the facilitator
// (the workflow that conducts a facilitated room), and the archive project.
//   { "person": "iwaag",
//     "projects": [{ "workspace": "front", "converse": "converse", "discuss": "discuss" }, …],
//     "facilitator": { "workspace": "ponderer", "workflow": "conduct" },
//     "archive": { "workspace": "ponderer" } }
export interface ConversationTarget { workspace: string; workflow: string }
export interface ProjectEntry { workspace: string; converse: string | null; discuss: string | null }
export interface ConversationConfig { person: string; projects: ProjectEntry[]; facilitator: ConversationTarget; archive: { workspace: string } | null }
const NAME = /^[a-z0-9][a-z0-9_.-]*$/
export const targetName = (t: ConversationTarget) => `${t.workspace}/${t.workflow}`
export function parseTarget(text: string): ConversationTarget {
  const [workspace, workflow, ...rest] = text.split('/')
  if (rest.length || !NAME.test(workspace ?? '') || !NAME.test(workflow ?? '')) throw new RequestError(400, `"${text}" is not a workflow (<workspace>/<workflow>)`)
  return { workspace, workflow }
}
// Who a page's words are recorded as (conversations.json "person"), read
// alone: clients that record as the person need nothing else configured.
export function configuredPerson(area: string): string | null {
  try { const p = (JSON.parse(readFileSync(join(area, 'conversations.json'), 'utf8')) as { person?: unknown }).person; return typeof p === 'string' && p ? p : null } catch { return null }
}
export function loadConversationConfig(area: string): ConversationConfig | { disabled: string } {
  const file = join(area, 'conversations.json')
  if (!existsSync(file)) return { disabled: `no ${file}: conversations are not configured here` }
  try {
    const o = legacyShape(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
    const shape = `${file} needs {"person", "projects": [{"workspace", "converse"?, "discuss"?}, …], "facilitator": {"workspace", "workflow"}, "archive"?: {"workspace"}}`
    if (typeof o.person !== 'string' || !o.person || !Array.isArray(o.projects)) return { disabled: shape }
    const wf = (v: unknown) => v === undefined || v === null ? null : typeof v === 'string' && NAME.test(v) ? v : undefined
    const projects: ProjectEntry[] = []
    for (const p of o.projects as Record<string, unknown>[]) {
      const converse = wf(p?.converse), discuss = wf(p?.discuss)
      if (typeof p?.workspace !== 'string' || !NAME.test(p.workspace) || converse === undefined || discuss === undefined || (!converse && !discuss) || projects.some(x => x.workspace === p.workspace)) return { disabled: shape }
      projects.push({ workspace: p.workspace, converse, discuss })
    }
    const f = o.facilitator as Partial<ConversationTarget> | undefined
    if (typeof f?.workspace !== 'string' || typeof f.workflow !== 'string' || !NAME.test(f.workspace) || !NAME.test(f.workflow)) return { disabled: shape }
    const a = o.archive as { workspace?: unknown } | undefined
    if (a !== undefined && (typeof a?.workspace !== 'string' || !NAME.test(a.workspace))) return { disabled: shape }
    return { person: o.person, projects, facilitator: { workspace: f.workspace, workflow: f.workflow }, archive: a ? { workspace: a.workspace as string } : null }
  } catch (e) { return { disabled: `${file} cannot be read: ${(e as Error).message}` } }
}

// The shape before challenge p2 — `targets` (one-to-one workflows) and
// `discussions` {facilitator, participants (group workflows), archive} — read
// as the one it became.
function legacyShape(o: Record<string, unknown>): Record<string, unknown> {
  if (o.projects !== undefined || (o.targets === undefined && o.discussions === undefined)) return o
  const d = (o.discussions ?? {}) as { facilitator?: unknown; participants?: { workspace?: string; workflow?: string }[]; archive?: unknown }
  const projects = new Map<string, { workspace: string; converse?: string; discuss?: string }>()
  for (const t of (o.targets ?? []) as { workspace?: string; workflow?: string }[]) if (t?.workspace) projects.set(t.workspace, { ...projects.get(t.workspace), workspace: t.workspace, converse: t.workflow })
  for (const t of d.participants ?? []) if (t?.workspace) projects.set(t.workspace, { ...projects.get(t.workspace), workspace: t.workspace, discuss: t.workflow })
  return { ...o, projects: [...projects.values()], facilitator: d.facilitator, archive: d.archive }
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
  // `kind` is how the room began (`conversation`: one-to-one, `discussion`:
  // facilitated, before challenge p2); it names only its archive namespace.
  // `workspace`/`workflow` are the destination or facilitator recorded then.
  id: string; title: string; created: string; updated: string; state: 'open' | 'closed'; by: string; workspace: string | null; workflow: string | null; kind: 'conversation' | 'discussion'
  conductor?: string | null // the conductor run of its facilitation (argue p4)
  requester?: string | null // whom the conductor consults, JSON (argue p4)
  category?: 'conversation' | 'check' | null // an ordinary conversation, or an operational check (argue p4 ex2, challenge p2)
  display_title?: string | null // a title for readers, when one was recorded (argue p4 ex2)
  default_to?: string | null // the default addressee (challenge p2)
}
export interface MessageRow {
  id: number; conv: string; role: 'person' | 'agent'; author: string; text: string; at: string
  token: string | null; via: string | null; re: string; kind: MessageKind; run: string | null; attempt: string | null; question: string | null; key: string | null
  // A one-to-one turn's dispatch before challenge p2 (history; requests carry it since).
  dispatch_state: 'pending' | 'started' | 'failed' | null; dispatch_run: string | null; dispatch_error: string | null; dispatch_tries: number
  // The member who spoke, the request an agent's message answers, and the
  // members a person's message addressed (JSON list).
  participant: string | null; invitation: number | null; addressed: string | null
  node?: string | null // the node of its run it was spoken for (argue p4)
}
export interface LinkRow { id: number; conv: string; message: number; run: string; relation: Relation; note: string; by: string; attempt: string | null; at: string; supersedes: number | null }

export interface Message {
  id: number; role: 'person' | 'agent'; author: string; text: string; at: string; via: string | null; re: number[]; kind: MessageKind
  run: string | null; runUrl: string | null; question: string | null
  dispatch: { state: 'pending' | 'started' | 'failed'; run: string | null; error: string | null } | null
  attachments: MessageAttachment[]
}
// A challenge a message carried (challenge p1): the revision it was sent
// with, and — a separate, current read — the latest one when it moved since.
export interface MessageAttachment extends AttachmentRef { latest: { commit: string; title: string; state: string | null } | null }
// What a client names to attach: a challenge, optionally at a commit (else
// its current revision when the message is accepted).
export interface AttachRequest { id: string; at?: string }
// `challenges` as a client sends it: ["ch-0001", "ch-0002@<commit>", {id, at?}].
export function attachRequests(v: unknown): AttachRequest[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new RequestError(400, 'challenges is a list of ids (ch-0001, ch-0001@<commit>) or {id, at}')
  return v.map(x => {
    if (typeof x === 'string') { const [id, at] = x.split('@'); return { id: id!, ...(at ? { at } : {}) } }
    if (typeof x === 'object' && x && typeof (x as AttachRequest).id === 'string') return { id: (x as AttachRequest).id, ...(typeof (x as AttachRequest).at === 'string' && (x as AttachRequest).at ? { at: (x as AttachRequest).at } : {}) }
    throw new RequestError(400, 'challenges is a list of ids (ch-0001, ch-0001@<commit>) or {id, at}')
  })
}
interface AttachmentRow { id: number; conv: string; message: number; kind: string; ref: string; commit_id: string; title: string; sha256: string; at: string }

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
  private _challenges?: ChallengeStore
  constructor(o: { area: string; exec?: ExecStore; challenges?: ChallengeStore }) {
    this.area = o.area
    this.exec = o.exec
    this._challenges = o.challenges
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
    }, ...CONVERSATION_MIGRATIONS])
  }
  close() { this.db.close(); this._presenter?.close(); if (this.ownChallenges) this._challenges?.close() }
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
  // Every conversation, newest first, with its last message and count.
  list(): (ConversationRow & { last: MessageRow | null; count: number })[] {
    const rows = this.all<ConversationRow>('SELECT * FROM conversations ORDER BY updated DESC')
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

  // ---- links ---------------------------------------------------------------------

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

  // The source a run operation names for a person's message (instructions
  // and answers carried from the conversation keep the words' origin).
  source(conv: string, message: number): ConversationSource {
    const m = this.message(message)
    if (!m || m.conv !== conv || m.role !== 'person') throw new RequestError(404, `#${message} is not a person's message of conversation ${conv}`)
    return { kind: 'conversation', conversation: conv, message, author: m.author, at: m.at }
  }



  // ---- attachments (challenge p1, docs/challenges.md) ------------------------------------

  // The challenge store of this area (the repository challenges.json names),
  // or null where none is configured.
  private ownChallenges = false
  async challenges(): Promise<ChallengeStore | null> {
    if (!this._challenges) {
      const { ChallengeStore, loadChallengeConfig } = await import('./challenges.ts')
      if ('disabled' in loadChallengeConfig(this.area)) return null
      const gitea = this.exec?.ctx.gitea
      this._challenges = new ChallengeStore({ area: this.area, env: async () => gitea ? gitea.gitEnv() : {} })
      this.ownChallenges = true
    }
    return this._challenges
  }

  // Each named challenge at the revision named, or its current one. Refused
  // (with the reason) when one is not published or cannot be read: a message
  // never carries a reference that does not resolve.
  async pinAll(refs: AttachRequest[]): Promise<AttachmentRef[]> {
    if (!Array.isArray(refs)) throw new RequestError(400, 'challenges is a list of {id, at?}')
    if (!refs.length) return []
    if (refs.length > 20) throw new RequestError(400, 'a message carries at most 20 challenges')
    const store = await this.challenges()
    if (!store) throw new RequestError(503, 'no challenge repository is configured here (challenges.json): nothing can be attached', { code: 'no-challenges' })
    const out: AttachmentRef[] = []
    for (const r of refs) {
      if (typeof r?.id !== 'string') throw new RequestError(400, 'challenges is a list of {id, at?}')
      if (out.some(x => x.id === r.id)) continue
      const p = await store.pin(r.id, r.at)
      out.push({ kind: 'challenge', id: p.id, commit: p.commit, title: p.title, sha256: p.sha256 })
    }
    return out
  }
  // Inside the message's own transaction.
  attachRows(conv: string, message: number, pins: AttachmentRef[]) {
    const ins = this.db.prepare('INSERT INTO attachments (conv, message, kind, ref, commit_id, title, sha256, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (message, kind, ref) DO NOTHING')
    for (const p of pins) ins.run(conv, message, p.kind, p.id, p.commit, p.title, p.sha256, now())
  }
  // What the named messages carried, in order, each challenge once.
  attachmentsOf(messages: number[]): AttachmentRef[] {
    const out: AttachmentRef[] = []
    for (const m of messages) for (const a of this.all<AttachmentRow>('SELECT * FROM attachments WHERE message = ? ORDER BY id', m)) {
      if (!out.some(x => x.id === a.ref)) out.push({ kind: 'challenge', id: a.ref, commit: a.commit_id, title: a.title, sha256: a.sha256 })
    }
    return out
  }
  // The text of each attached revision, for the run that receives it.
  async pinnedTexts(refs: AttachmentRef[]): Promise<PinnedAttachment[]> {
    if (!refs.length) return []
    const store = await this.challenges()
    if (!store) throw new Error('the message carries challenges, but no challenge repository is configured here (challenges.json)')
    const out: PinnedAttachment[] = []
    for (const a of refs) out.push({ ...a, text: await store.text(a.id, a.commit) })
    return out
  }
  // A conversation's attachments by message, with the latest revision of
  // each challenge beside the attached one (the index; refreshed at most
  // every few seconds).
  async attachmentViews(conv: string): Promise<Map<number, MessageAttachment[]>> {
    const rows = this.all<AttachmentRow>('SELECT * FROM attachments WHERE conv = ? ORDER BY id', conv)
    const out = new Map<number, MessageAttachment[]>()
    if (!rows.length) return out
    const store = await this.challenges()
    await store?.sync().catch(() => undefined)
    for (const a of rows) {
      const cur = store?.current(a.ref) ?? null
      out.set(a.message, [...out.get(a.message) ?? [], { kind: 'challenge', id: a.ref, commit: a.commit_id, title: a.title, sha256: a.sha256, latest: cur ? { commit: cur.commit, title: cur.title, state: cur.state } : null }])
    }
    return out
  }

  // ---- targets ---------------------------------------------------------------------

  // A workflow of a project as a client sees it: the project and workflow it
  // names, the agent that answers, and whether a request could start a run
  // there now (an unreadable one is unavailable with the reason).
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
  async runEntries(keys: { key: string; relation: string }[], viewBase?: string | null, delegated = false): Promise<RunEntry[]> {
    const files = (workspace: string, ref: RunRef) => viewBase ? `${viewBase.replace(/\/?$/, '/')}api/projects/${encodeURIComponent(workspace)}/runs/${encodeURIComponent(ref.workflow)}/${encodeURIComponent(ref.run)}/raw?path=` : null
    const cfg = loadConversationConfig(this.area)
    const person = 'disabled' in cfg ? null : cfg.person
    const runs: RunEntry[] = []
    const queue: { key: string; relation: string; uid?: string }[] = [...keys]
    const seen = new Set<string>()
    for (const { key, relation, uid } of queue) {
      if (seen.has(key)) continue
      seen.add(key)
      const { workspace, ref } = parseRunName(key)
      const entry = { key, workspace, workflow: ref.workflow, run: ref.run, relation, url: runUrl(viewBase, key), files: files(workspace, ref) }
      try {
        if (!this.exec) throw new Error('execution is not configured here')
        const ws = await this.exec.workspace(workspace)
        const reading = await readRun(ws, ref)
        const rec = reading.record as RunRecord | null
        if (!rec) throw new Error('the run cannot be read')
        if (uid && `${rec.project}/${rec.workflow}/${rec.run}#${creationOf(rec)}` !== uid) throw new Error('the delegated run identity changed; its review cannot be substituted')
        // A child can prepare its own human review before it completes, so
        // it has no result to relay yet. Follow recorded bindings directly,
        // including satisfied delegations, rather than waiting for a result.
        if (delegated) for (const d of Object.values(rec.delegations ?? {})) {
          const c = d.child
          if (c) queue.push({ key: `${c.workspace}/${c.workflow}/${c.run}`, relation: `delegated by ${key} (${d.id})`, uid: c.uid })
        }
        const job = this.exec.runRows(workspace, ref).jobs.find(j => j.state === 'queued' || j.state === 'claimed') ?? null
        const status = runStatus(rec, { names: nodeNames(reading.bundle, rec), job: job && { state: job.state as 'queued' | 'claimed', reason: job.reason }, person })
        const presenter = rec.presentations ? this.presenter() : null
        const shown = presenter ? (await presenter.view(ws, rec).catch(() => [])).filter(p => p.live && p.url && !p.local).map(p => ({ id: p.id, title: p.title, url: p.url! })) : []
        const reviews = Object.values(rec.reviews ?? {}).map((v): ConversationReview => ({
          id: v.id, state: v.state, text: reviewStateText(v), summary: v.summary, reviewer: v.reviewer, prepared: { at: v.prepared.at, by: v.prepared.by },
          subjects: v.subjects.map(x => ({ title: x.title, presentation: x.presentation, run: subjectRun(x) })),
          decision: v.decision ? { outcome: v.decision.outcome, by: v.decision.by, at: v.decision.at, synthetic: !!v.decision.synthetic } : null,
          page: reviewPage(viewBase, workspace, ref, v.id), api: `api/workspaces/${encodeURIComponent(workspace)}/runs/${encodeURIComponent(ref.workflow)}/${encodeURIComponent(ref.run)}/reviews/${encodeURIComponent(v.id)}`,
        }))
        runs.push({ ...entry, situation: situation(rec), execution: rec.execution.state, title: runDisplayTitle(rec), waiting: rec.execution.waiting.map(w => w.node), status, presentations: shown, ...(reviews.length ? { reviews } : {}) })
      } catch (e) {
        // A run of a project no longer registered here (a retired one, argue
        // p4 ex1) has no run view to open: no link is made up for it.
        const gone = e instanceof RequestError && e.status === 404 && /is not registered/.test(e.message)
        runs.push({ ...entry, ...(gone ? { url: null, files: null } : {}), situation: 'unknown', execution: 'unknown', title: null, waiting: [], status: null, presentations: [], problem: gone ? `${(e as Error).message} here (a retired or unknown project): no run view; the run's record stays in that project's history` : (e as Error).message })
      }
    }
    return runs
  }

}

export interface RunEntry {
  key: string; workspace: string; workflow: string; run: string; relation: string; url: string | null; files: string | null
  situation: string; execution: string; title: string | null; waiting: string[]; status: RunStatus | null; presentations: { id: string; title: string; url: string }[]; problem?: string
  // p17 (docs/reviews.md): the run's human review rounds, for the person's
  // Start review in the room; `page` is WFE's review page, `api` the
  // route a client posts start to (relative to the WFE base).
  reviews?: ConversationReview[]
}
export interface ConversationReview {
  id: string; state: string; text: string; summary: string; reviewer: string | null; prepared: { at: string; by: string }
  subjects: { title: string; presentation: string; run: string }[]
  decision: { outcome: string; by: string; at: string; synthetic: boolean } | null
  page: string | null; api: string
}
export const reviewPage = (viewBase: string | null | undefined, workspace: string, ref: RunRef, id: string) => viewBase ? `${viewBase.replace(/\/?$/, '/')}#/ws/${encodeURIComponent(workspace)}/review/${encodeURIComponent(ref.workflow)}/${encodeURIComponent(ref.run)}/${encodeURIComponent(id)}` : null
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

// An original title from words: the first nonempty line, whitespace
// collapsed, shortened to 80 UTF-16 units at a character boundary (challenge
// p4: a surrogate pair or a joined emoji is never cut).
export function firstLine(t: string): string {
  const l = t.split(/\r?\n/).map(x => x.replace(/\s+/gu, ' ').trim()).find(Boolean) ?? ''
  if (l.length <= 80) return l
  let out = ''
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(l)) { if (out.length + segment.length > 79) break; out += segment }
  return `${out.trimEnd()}…`
}
