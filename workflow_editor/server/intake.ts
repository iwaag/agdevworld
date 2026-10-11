// Zulip intake on this host (p6): the durable inbox that turns posts in a
// workflow's channel into recorded workflow input. The rules are
// shared/intake.ts (docs/intake.md); this module keeps, in
// <area>/.local/intake/intake.sqlite:
//
// - cursors: per realm and channel, the highest message id received. It
//   moves only in the transaction that stores the posts it passes, so a post
//   fetched and not stored is fetched again;
// - messages: every post received, keyed by (realm, message id), with its
//   stage (received → classified → applied → done, or failed with the stage
//   to resume), its classification and binding (stored once, never derived
//   again), the run entry it became, and the reply the person is owed;
// - requests: each request topic's binding — its identity (first message),
//   current name, origin post, project/workflow/workspace and run — and
//   relocations: where a renamed topic was before;
// - transport: the last pass of the transport, so a network or
//   authorization failure stays visible.
//
// Application goes through the run operations with the post's receipt
// (`zulip:<realm>:<id>`), so a crash between changing the run and recording
// that it changed is repaired by repeating the operation: the run records
// it once. A request's run is found again by its run.create receipt.
//
// The transport (autolab's agautolab.wfintake) fetches posts, adds what the
// rules need (sender is a bot, the topic's first message) and hands them over
// with `wfe intake receive`; it decides nothing.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  APPLIES, canMove, classify, noticeFor, realmId, requestKey, routeMessage, sourceReceipt, validInbound,
  type Classification, type InboundMessage, type InboxState, type IntakeNoticeKind, type RequestBinding, type Route, type RouteResult, type RunView, type SourceRef,
} from '../shared/intake.ts'
import { questionState, runKey, type RunRecord, type RunRef } from '../shared/run.ts'
import { assertWorkspaceAllowed, loadBoundary } from './boundary.ts'
import type { ExecStore } from './exec.ts'
import { loadNotifyConfig, type NotifyStore } from './notify.ts'
import { loadRegistry, observe } from './registry.ts'
import { createRun, findRunByReceipt, readRun, runOp } from './runs.ts'
import { named, openStore, transaction, type Migration } from './sqlite.ts'
import { RequestError, Workspace } from './workspace.ts'

export const INTAKE_PROTOCOL = 1

// <area>/zulip.json → "intake": which projects accept requests from Zulip,
// who may request and answer (Zulip user ids, with the name their words are
// recorded under), and from when posts are read.
export interface IntakeConfig {
  enabled: boolean
  since: string
  projects: Record<string, { workspace?: string }>
  requesters: { id: number; name: string }[]
}

export function loadIntakeConfig(area: string): { realm: string; zulipUrl: string; intake: IntakeConfig } | { disabled: string } {
  const cfg = loadNotifyConfig(area)
  if (!cfg) return { disabled: `no ${join(area, 'zulip.json')}: Zulip is not configured` }
  if ('problem' in cfg) return { disabled: cfg.problem }
  const raw = cfg.intake as Partial<IntakeConfig> | undefined
  if (!raw) return { disabled: 'zulip.json has no "intake": requests from Zulip are not enabled' }
  if (typeof raw.enabled !== 'boolean' || typeof raw.since !== 'string' || Number.isNaN(Date.parse(raw.since)) || typeof raw.projects !== 'object' || raw.projects === null || !Array.isArray(raw.requesters)) {
    return { disabled: 'zulip.json "intake" needs {"enabled": bool, "since": ISO time, "projects": {<id>: {"workspace"?: id}}, "requesters": [{"id": n, "name": text}]}' }
  }
  for (const r of raw.requesters) if (!Number.isInteger(r?.id) || typeof r?.name !== 'string' || !r.name.trim()) return { disabled: 'zulip.json "intake.requesters" entries are {"id": Zulip user id, "name": text}' }
  if (!raw.enabled) return { disabled: 'zulip.json "intake.enabled" is false' }
  return { realm: realmId(cfg.zulipUrl), zulipUrl: cfg.zulipUrl, intake: raw as IntakeConfig }
}

export interface MessageRow {
  realm: string; id: number; stream_id: number; topic: string; topic_first: number; sender_id: number; sender_name: string; sender_email: string; sender_bot: number
  content: string; ts: number; received: string; state: InboxState; stage: string | null; route: string | null; classification: string | null
  request_key: string | null; applied: string | null; notice: string | null; detail: string | null; error: string | null; attempts: number; next_try: string | null; updated: string
}
export interface RequestRow {
  key: string; realm: string; stream_id: number; topic: string; topic_first: number; origin: number; project: string; workflow: string; workspace: string
  run_workflow: string | null; run: string | null; state: RequestBinding['state']; refused: string | null; created: string; updated: string
}

const now = () => new Date().toISOString()
const BACKOFF = (attempts: number) => Math.min(10 * 60, 10 * 2 ** Math.max(0, attempts - 1)) * 1000

const MIGRATIONS: Migration[] = [{
  version: 1,
  up: db => db.exec(`
    CREATE TABLE cursors (realm TEXT NOT NULL, stream_id INTEGER NOT NULL, last_id INTEGER NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (realm, stream_id));
    CREATE TABLE messages (realm TEXT NOT NULL, id INTEGER NOT NULL, stream_id INTEGER NOT NULL, topic TEXT NOT NULL, topic_first INTEGER NOT NULL,
      sender_id INTEGER NOT NULL, sender_name TEXT NOT NULL, sender_email TEXT NOT NULL, sender_bot INTEGER NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL,
      received TEXT NOT NULL, state TEXT NOT NULL, stage TEXT, route TEXT, classification TEXT, request_key TEXT, applied TEXT, notice TEXT, detail TEXT,
      error TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_try TEXT, updated TEXT NOT NULL, PRIMARY KEY (realm, id));
    CREATE INDEX messages_state ON messages (state, id);
    CREATE INDEX messages_request ON messages (request_key, id);
    CREATE TABLE requests (key TEXT PRIMARY KEY, realm TEXT NOT NULL, stream_id INTEGER NOT NULL, topic TEXT NOT NULL, topic_first INTEGER NOT NULL, origin INTEGER NOT NULL,
      project TEXT NOT NULL, workflow TEXT NOT NULL, workspace TEXT NOT NULL, run_workflow TEXT, run TEXT, state TEXT NOT NULL, refused TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE UNIQUE INDEX requests_identity ON requests (realm, topic_first);
    CREATE TABLE relocations (id INTEGER PRIMARY KEY, request_key TEXT NOT NULL, from_topic TEXT NOT NULL, to_topic TEXT NOT NULL, message INTEGER NOT NULL, at TEXT NOT NULL);
    CREATE TABLE transport (name TEXT PRIMARY KEY, at TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT, detail TEXT);
  `),
}]

// Which request-topic message carried a question (step 6 wires the
// notifier's deliveries in); null while it has not been posted there.
export type PostedLookup = (requestKey: string, ref: RunRef, question: string) => number | null

export class IntakeStore {
  readonly db: DatabaseSync
  readonly area: string
  readonly registryFile: string
  exec?: ExecStore
  notify?: NotifyStore
  posted: PostedLookup
  constructor(o: { area: string; registryFile: string; exec?: ExecStore; notify?: NotifyStore; posted?: PostedLookup }) {
    this.area = o.area; this.registryFile = o.registryFile; this.exec = o.exec; this.notify = o.notify
    this.posted = o.posted ?? (() => null)
    const dir = join(o.area, '.local', 'intake')
    mkdirSync(dir, { recursive: true })
    this.db = openStore('intake store', join(dir, 'intake.sqlite'), MIGRATIONS)
  }
  close() { this.db.close() }
  private all<T>(sql: string, ...a: (string | number | null)[]): T[] { return named('intake store', 'a read', () => this.db.prepare(sql).all(...a) as T[]) }
  private one<T>(sql: string, ...a: (string | number | null)[]): T | undefined { return named('intake store', 'a read', () => this.db.prepare(sql).get(...a) as T | undefined) }
  private run(sql: string, ...a: (string | number | null)[]) { return named('intake store', 'a write', () => this.db.prepare(sql).run(...a)) }
  private tx<T>(f: () => T): T { return transaction(this.db, f, 'intake store') }

  // ---- routes: the configured workflow channels ---------------------------------------------

  // A channel routes to a workflow when the notifier recorded its stream id,
  // the workflow (as it is now in its workspace) declares intake.zulip:
  // requests, and the host enables its project here. Nothing is routed by name.
  async routes(): Promise<{ realm: string; routes: Route[]; problems: string[] } | { disabled: string }> {
    const c = loadIntakeConfig(this.area)
    if ('disabled' in c) return c
    const problems: string[] = []
    const routes: Route[] = []
    const reg = await loadRegistry(this.registryFile)
    const boundary = await loadBoundary(this.registryFile, this.area)
    for (const [project, opt] of Object.entries(c.intake.projects).sort()) {
      const candidates = reg.workspaces.filter(w => w.project === project)
      const reg1 = opt.workspace ? candidates.find(w => w.id === opt.workspace) : candidates.length === 1 ? candidates[0] : undefined
      if (!reg1) { problems.push(`intake: project ${project}: ${opt.workspace ? `workspace ${opt.workspace} is not registered for it` : candidates.length ? `it has ${candidates.length} workspaces here; name one in zulip.json intake.projects.${project}.workspace` : 'no workspace of it is registered here'}`); continue }
      try { await assertWorkspaceAllowed(boundary, reg1, 'Intake') } catch (e) { problems.push(`intake: project ${project}: ${(e as Error).message}`); continue }
      if (!(await observe(reg1)).available) { problems.push(`intake: project ${project}: workspace ${reg1.id} is not available`); continue }
      const ws = new Workspace(reg1)
      for (const s of (await ws.workflowSummaries()).list) {
        if (!s.id) continue
        const wf = (await ws.workflowResponse(s.file)).workflow
        if (wf?.intake.zulip !== 'requests') continue
        const target = this.notify?.target(`channel:${project}/${s.id}`)
        if (!target || target.state !== 'provisioned' || !target.zulip_id) { problems.push(`intake: ${project}/${s.id}: its channel is not provisioned yet (the notifier creates it)`); continue }
        routes.push({ realm: c.realm, streamId: target.zulip_id, project, workflow: s.id, workspace: reg1.id })
      }
    }
    return { realm: c.realm, routes, problems }
  }

  bindings(): RequestBinding[] {
    return this.all<RequestRow>('SELECT * FROM requests ORDER BY key').map(r => ({
      key: r.key, realm: r.realm, streamId: r.stream_id, topic: r.topic, topicFirst: r.topic_first, origin: r.origin, project: r.project, workflow: r.workflow,
      workspace: r.workspace, run: r.run && r.run_workflow ? { workflow: r.run_workflow, run: r.run } : null, state: r.state, ...(r.refused ? { refused: r.refused } : {}),
    }))
  }
  request(key: string): RequestRow | undefined { return this.one<RequestRow>('SELECT * FROM requests WHERE key = ?', key) }
  requestOfRun(project: string, ref: RunRef): RequestRow | undefined {
    return this.one<RequestRow>('SELECT * FROM requests WHERE project = ? AND run_workflow = ? AND run = ?', project, ref.workflow, ref.run)
  }

  // ---- the transport's side ------------------------------------------------------------------

  // What to fetch: each routed channel and its cursor.
  async due(): Promise<{ protocol: number; disabled?: string; realm?: string; channels: { streamId: number; project: string; workflow: string; cursor: number }[]; problems: string[] }> {
    const r = await this.routes()
    if ('disabled' in r) return { protocol: INTAKE_PROTOCOL, disabled: r.disabled, channels: [], problems: [] }
    const channels = r.routes.map(x => ({ streamId: x.streamId, project: x.project, workflow: x.workflow, cursor: this.cursor(r.realm, x.streamId) }))
    return { protocol: INTAKE_PROTOCOL, realm: r.realm, channels, problems: [...r.problems, ...this.problems()] }
  }

  cursor(realm: string, streamId: number): number {
    return this.one<{ last_id: number }>('SELECT last_id FROM cursors WHERE realm = ? AND stream_id = ?', realm, streamId)?.last_id ?? 0
  }

  // Stores posts of one channel and moves its cursor past them — `through`
  // is the highest id the transport read, posts or not — in one transaction.
  // A post already stored is not stored again (and not reprocessed).
  receive(o: { realm: string; streamId: number; through: number; messages: unknown[] }): { stored: number; duplicates: number; cursor: number } {
    const msgs = o.messages.map(validInbound)
    for (const m of msgs) {
      if (m.realm !== o.realm) throw new RequestError(400, `post ${m.id} is from realm ${m.realm}, not ${o.realm}`)
      if (m.streamId !== o.streamId) throw new RequestError(400, `post ${m.id} is in channel #${m.streamId}, not #${o.streamId}`)
    }
    if (!Number.isInteger(o.through) || o.through < Math.max(0, ...msgs.map(m => m.id))) throw new RequestError(400, '--through must be at least the highest message id handed over')
    return this.tx(() => {
      let stored = 0
      const t = now()
      for (const m of msgs) {
        const r = this.run(`INSERT OR IGNORE INTO messages (realm, id, stream_id, topic, topic_first, sender_id, sender_name, sender_email, sender_bot, content, ts, received, state, updated)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`, m.realm, m.id, m.streamId, m.topic, m.topicFirst, m.sender.id, m.sender.name, m.sender.email, m.sender.bot ? 1 : 0, m.content, m.timestamp, t, t)
        stored += Number(r.changes)
      }
      this.run('INSERT INTO cursors (realm, stream_id, last_id, updated) VALUES (?, ?, ?, ?) ON CONFLICT (realm, stream_id) DO UPDATE SET last_id = max(last_id, excluded.last_id), updated = excluded.updated', o.realm, o.streamId, o.through, t)
      return { stored, duplicates: msgs.length - stored, cursor: this.cursor(o.realm, o.streamId) }
    })
  }

  // The transport's last pass, kept so a failure is visible to people.
  transportResult(o: { ok: boolean; error?: string; detail?: string }) {
    this.run('INSERT INTO transport (name, at, ok, error, detail) VALUES (\'zulip\', ?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET at = excluded.at, ok = excluded.ok, error = excluded.error, detail = excluded.detail',
      now(), o.ok ? 1 : 0, o.error?.slice(0, 500) ?? null, o.detail?.slice(0, 500) ?? null)
  }

  // ---- processing ----------------------------------------------------------------------------

  // Settles what can be settled, in message-id order. A post that has to
  // wait (an earlier post of its request is unsettled) stays where it is;
  // a failure is recorded with the stage to resume and retried later.
  async process(at = new Date()): Promise<string[]> {
    const routed = await this.routes()
    if ('disabled' in routed) return []
    const notes: string[] = []
    const rows = this.all<MessageRow>(`SELECT * FROM messages WHERE state IN ('received', 'classified', 'applied') OR (state = 'failed' AND (next_try IS NULL OR next_try <= ?)) ORDER BY id`, at.toISOString())
    for (const row of rows) {
      let current = row
      try {
        for (let guard = 0; guard < 4; guard++) {
          const stage = (current.state === 'failed' ? current.stage : current.state) as 'received' | 'classified' | 'applied'
          const next = stage === 'received' ? await this.classifyRow(current, routed)
            : stage === 'classified' ? await this.applyRow(current)
              : await this.followUp(current)
          if (next === 'waiting') break
          current = this.message(row.realm, row.id)!
          if (current.state === 'done') { notes.push(`${row.id}: ${summary(current)}`); break }
        }
      } catch (e) {
        const stage = (current.state === 'failed' ? current.stage : current.state) ?? 'received'
        const attempts = current.attempts + 1
        this.run('UPDATE messages SET state = \'failed\', stage = ?, error = ?, attempts = ?, next_try = ?, updated = ? WHERE realm = ? AND id = ?',
          stage, (e as Error).message.slice(0, 500), attempts, new Date(at.getTime() + BACKOFF(attempts)).toISOString(), now(), row.realm, row.id)
        notes.push(`${row.id}: failed at ${stage} (${(e as Error).message}); retried later`)
      }
    }
    return notes
  }

  message(realm: string, id: number): MessageRow | undefined { return this.one<MessageRow>('SELECT * FROM messages WHERE realm = ? AND id = ?', realm, id) }

  private move(row: MessageRow, to: InboxState, set: Record<string, string | number | null> = {}) {
    const from = row.state === 'failed' ? 'failed' : row.state
    if (!canMove(from, to) && !(from === 'failed' && canMove(row.stage as InboxState, to))) throw new Error(`post ${row.id}: ${from} → ${to} is not a transition of the inbox`)
    const keys = Object.keys(set)
    this.run(`UPDATE messages SET state = ?, ${keys.map(k => `${k} = ?, `).join('')}stage = NULL, error = NULL, next_try = NULL, updated = ? WHERE realm = ? AND id = ?`,
      to, ...keys.map(k => set[k]), now(), row.realm, row.id)
  }

  private inbound(row: MessageRow): InboundMessage {
    return { realm: row.realm, id: row.id, streamId: row.stream_id, topic: row.topic, sender: { id: row.sender_id, name: row.sender_name, email: row.sender_email, bot: !!row.sender_bot }, content: row.content, timestamp: row.ts, topicFirst: row.topic_first }
  }

  private async classifyRow(row: MessageRow, routed: { realm: string; routes: Route[] }): Promise<'waiting' | 'ok'> {
    const cfg = loadIntakeConfig(this.area)
    if ('disabled' in cfg) return 'waiting'
    const m = this.inbound(row)
    const done = (route: RouteResult | null, c: Classification | null, notice: IntakeNoticeKind | null, detail: string | null, key: string | null) =>
      this.move(row, 'classified', { route: route ? JSON.stringify(route.kind === 'ignore' || route.kind === 'problem' ? route : { kind: route.kind }) : null, classification: c ? JSON.stringify(c) : null, request_key: key, notice, detail })
    if (m.timestamp * 1000 < Date.parse(cfg.intake.since)) {
      this.move(row, 'classified', { route: JSON.stringify({ kind: 'ignore', reason: 'before-intake' }), detail: `posted before intake began (${cfg.intake.since})` })
      this.finish(row); return 'ok'
    }
    const route = routeMessage(m, routed.routes, this.bindings())
    if (route.kind === 'ignore') { done(route, null, null, null, null); this.finish(row); return 'ok' }
    if (route.kind === 'problem') { done(route, null, 'problem', route.detail, route.binding?.key ?? null); this.finish(row); return 'ok' }
    let binding = route.kind === 'new' ? null : route.binding
    if (route.kind === 'renamed') {
      this.tx(() => {
        this.run('UPDATE requests SET topic = ?, updated = ? WHERE key = ?', route.to, now(), route.binding.key)
        this.run('INSERT INTO relocations (request_key, from_topic, to_topic, message, at) VALUES (?, ?, ?, ?, ?)', route.binding.key, route.from, route.to, m.id, now())
      })
      binding = { ...route.binding, topic: route.to }
    }
    // Posts of one request settle in id order.
    const earlier = this.one<{ id: number }>('SELECT id FROM messages WHERE realm = ? AND topic_first = ? AND id < ? AND state != \'done\' ORDER BY id LIMIT 1', m.realm, m.topicFirst, m.id)?.id ?? null
    const requesters = new Set(cfg.intake.requesters.map(r => r.id))
    const runView = binding?.run ? await this.runView(binding) : null
    const c = classify(m, { requesters, binding, run: runView, earlierUnsettled: earlier })
    if (c.kind === 'wait') return 'waiting'
    const key = c.kind === 'request' ? requestKey(m.id) : binding?.key ?? null
    this.tx(() => {
      if (c.kind === 'request') {
        this.run(`INSERT INTO requests (key, realm, stream_id, topic, topic_first, origin, project, workflow, workspace, state, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'opening', ?, ?)`,
          key, m.realm, m.streamId, m.topic, m.topicFirst, m.id, route.route.project, route.route.workflow, route.route.workspace, now(), now())
      }
      done(route, c, noticeFor(c), null, key)
    })
    if (!APPLIES.has(c.kind)) this.finish(this.message(row.realm, row.id)!)
    return 'ok'
  }

  // A post that changes no run is done once classified; its reply (if any)
  // is queued with it.
  private finish(row: MessageRow) {
    const r = this.message(row.realm, row.id)!
    if (r.state === 'classified') this.move(r, 'done')
  }

  private async runView(b: RequestBinding): Promise<RunView | null> {
    const ws = await this.workspace(b.workspace)
    const rec = (await readRun(ws, b.run!)).record
    if (!rec) throw new Error(`run ${runKey(b.run!)} of request ${b.key} cannot be read`)
    return {
      execution: rec.execution.state, cancelled: !!rec.cancelled,
      questions: Object.values(rec.questions).map(q => ({ id: q.id, state: questionState(q), posted: this.posted(b.key, b.run!, q.id) })),
    }
  }

  private async workspace(id: string): Promise<Workspace> {
    const reg = (await loadRegistry(this.registryFile)).workspaces.find(w => w.id === id)
    if (!reg) throw new RequestError(404, `workspace ${id} is not registered`)
    await assertWorkspaceAllowed(await loadBoundary(this.registryFile, this.area), reg, 'Intake')
    return new Workspace(reg)
  }

  private personOf(senderId: number): string {
    const cfg = loadIntakeConfig(this.area)
    return ('intake' in cfg ? cfg.intake.requesters.find(r => r.id === senderId)?.name : undefined) ?? `zulip user ${senderId}`
  }

  private source(row: MessageRow): SourceRef {
    return { kind: 'zulip', realm: row.realm, message: row.id, stream: row.stream_id, topic: row.topic, sender: row.sender_id, senderName: row.sender_name, at: new Date(row.ts * 1000).toISOString() }
  }

  // Applies a classified post through the run operations, with its receipt.
  private async applyRow(row: MessageRow): Promise<'ok'> {
    const c = JSON.parse(row.classification!) as Classification
    const receipt = sourceReceipt(row.realm, row.id)
    const b = this.request(row.request_key!)
    if (!b) throw new Error(`post ${row.id}: request ${row.request_key} is not recorded`)
    const ws = await this.workspace(b.workspace)
    const person = this.personOf(row.sender_id)
    if (c.kind === 'request') {
      let ref = await findRunByReceipt(ws, b.workflow, receipt)
      if (!ref) {
        const held = this.exec ? await this.exec.holder(ws) : null
        if (held) return this.refuse(row, b, `workspace ${ws.reg.id} is held by run ${held}, which has not completed; one run works in a workspace at a time. Open a new request topic once it has finished.`)
        try {
          ref = (await createRun(ws, {
            workflow: b.workflow, receipt, executor: { host: this.exec?.executor ?? 'autolab' }, by: person, via: 'zulip',
            input: { kind: 'braindump', text: row.content, author: person, source: this.source(row) },
          })).ref
        } catch (e) {
          if (e instanceof RequestError && e.status >= 400 && e.status < 500 && e.status !== 409) return this.refuse(row, b, e.message)
          if (e instanceof RequestError && e.status === 409 && !/already exists/.test(e.message)) return this.refuse(row, b, e.message)
          throw e
        }
      }
      this.tx(() => {
        this.run('UPDATE requests SET run_workflow = ?, run = ?, state = \'bound\', updated = ? WHERE key = ?', ref!.workflow, ref!.run, now(), b.key)
        this.move(row, 'applied', { applied: JSON.stringify({ workflow: ref!.workflow, run: ref!.run, seq: 1 }) })
      })
      return 'ok'
    }
    const ref = { workflow: b.run_workflow!, run: b.run! }
    const op = c.kind === 'answer'
      ? { op: 'question.answer' as const, question: c.question, text: row.content, from: person, source: this.source(row), receipt }
      : { op: 'instruction.receive' as const, text: row.content, from: person, source: this.source(row), receipt }
    try {
      const r = await runOp(ws, ref, op, { by: person, via: 'zulip' })
      const seq = r.record.history.find(h => h.receipt === receipt)?.seq ?? r.record.seq
      this.move(row, 'applied', { applied: JSON.stringify({ ...ref, seq }) })
    } catch (e) {
      const code = (e as RequestError).detail && typeof (e as RequestError).detail === 'object' ? ((e as RequestError).detail as { code?: string }).code : undefined
      // Refused by the run as it is now — a question closed or the run
      // cancelled between classification and application. Recorded and
      // explained; never applied elsewhere.
      if (code === 'question-closed' && c.kind === 'answer') {
        const q = (await readRun(ws, ref)).record?.questions[c.question]
        this.move(row, 'done', { notice: 'late', classification: JSON.stringify({ kind: 'late', question: c.question, state: q && q.withdrawn ? 'withdrawn' : 'taken-up' }), detail: (e as Error).message })
        return 'ok'
      }
      if (code === 'run-completed') { this.move(row, 'done', { notice: 'closed', classification: JSON.stringify({ kind: 'closed', reason: 'completed' }), detail: (e as Error).message }); return 'ok' }
      if (code === 'run-cancelled') { this.move(row, 'done', { notice: 'closed', classification: JSON.stringify({ kind: 'closed', reason: 'cancelled' }), detail: (e as Error).message }); return 'ok' }
      // Any other refusal by the record is deterministic: retrying repeats
      // it. Shown and told, not applied.
      if (e instanceof RequestError && e.status === 422) { this.move(row, 'done', { notice: 'problem', detail: `the run refused it: ${e.message}` }); return 'ok' }
      throw e
    }
    return 'ok'
  }

  private refuse(row: MessageRow, b: RequestRow, why: string): 'ok' {
    this.tx(() => {
      this.run('UPDATE requests SET state = \'refused\', refused = ?, updated = ? WHERE key = ?', why, now(), b.key)
      this.move(row, 'done', { notice: 'refused', detail: why })
    })
    return 'ok'
  }

  // What follows an applied post: a request's start, an answer's resumption
  // (both queued by receipt, so twice is once). An instruction waits in the
  // run for the next node boundary.
  private async followUp(row: MessageRow): Promise<'ok'> {
    const c = JSON.parse(row.classification!) as Classification
    const applied = JSON.parse(row.applied!) as RunRef & { seq: number }
    const b = this.request(row.request_key!)!
    const ws = await this.workspace(b.workspace)
    const ref = { workflow: applied.workflow, run: applied.run }
    if (this.exec && c.kind === 'request') {
      const rec = (await readRun(ws, ref)).record
      if (rec && !rec.cancelled && rec.control.attempts === 0) this.exec.enqueue(ws.reg.id, ref, 'start', `request:${sourceReceipt(row.realm, row.id)}`, 'start: the person\'s request (Zulip)')
    }
    if (this.exec && c.kind === 'answer') await this.exec.afterAnswer(ws, ref, c.question)
    this.move(row, 'done')
    return 'ok'
  }

  // ---- people ------------------------------------------------------------------------------------

  // A failed post is tried again now, from the stage that failed.
  retry(realm: string, id?: number): number {
    const sql = id === undefined ? 'UPDATE messages SET next_try = NULL, updated = ? WHERE state = \'failed\' AND realm = ?' : 'UPDATE messages SET next_try = NULL, updated = ? WHERE state = \'failed\' AND realm = ? AND id = ?'
    return Number((id === undefined ? this.run(sql, now(), realm) : this.run(sql, now(), realm, id)).changes)
  }

  problems(): string[] {
    const out: string[] = []
    const t = this.one<{ at: string; ok: number; error: string | null }>('SELECT * FROM transport WHERE name = \'zulip\'')
    if (t && !t.ok) out.push(`intake transport: last pass failed at ${t.at}: ${t.error}`)
    for (const m of this.all<MessageRow>('SELECT * FROM messages WHERE state = \'failed\' ORDER BY id')) out.push(`intake: post ${m.id} failed at ${m.stage} (${m.attempts}×): ${m.error}`)
    for (const m of this.all<MessageRow>('SELECT * FROM messages WHERE notice = \'problem\' ORDER BY id DESC LIMIT 5')) out.push(`intake: post ${m.id} in "${m.topic}": ${m.detail}`)
    return out
  }

  status() {
    return {
      cursors: this.all<{ realm: string; stream_id: number; last_id: number; updated: string }>('SELECT * FROM cursors ORDER BY stream_id'),
      transport: this.one<{ at: string; ok: number; error: string | null; detail: string | null }>('SELECT * FROM transport WHERE name = \'zulip\'') ?? null,
      counts: Object.fromEntries(this.all<{ state: string; n: number }>('SELECT state, count(*) AS n FROM messages GROUP BY state').map(r => [r.state, r.n])),
      requests: this.all<RequestRow>('SELECT * FROM requests ORDER BY created'),
      problems: this.problems(),
    }
  }

  messages(o: { request?: string; limit?: number } = {}): MessageRow[] {
    return o.request ? this.all<MessageRow>('SELECT * FROM messages WHERE request_key = ? ORDER BY id', o.request)
      : this.all<MessageRow>('SELECT * FROM messages ORDER BY id DESC LIMIT ?', o.limit ?? 50)
  }

  // Posts whose reply to the person is owed (the notifier queues each once).
  notices(): MessageRow[] { return this.all<MessageRow>('SELECT * FROM messages WHERE notice IS NOT NULL AND state = \'done\' ORDER BY id') }

  relocations(key: string) { return this.all<{ from_topic: string; to_topic: string; message: number; at: string }>('SELECT * FROM relocations WHERE request_key = ? ORDER BY id', key) }
}

function summary(r: MessageRow): string {
  const c = r.classification ? JSON.parse(r.classification) as Classification : null
  const route = r.route ? JSON.parse(r.route) as { kind: string; reason?: string } : null
  if (!c) return route?.kind === 'ignore' ? `ignored (${route.reason})` : route?.kind === 'problem' ? `routing problem (${route.reason})` : r.detail ?? 'done'
  const applied = r.applied ? ` → ${(JSON.parse(r.applied) as { workflow: string; run: string; seq: number }).workflow}/${(JSON.parse(r.applied) as { run: string }).run} #${(JSON.parse(r.applied) as { seq: number }).seq}` : ''
  return `${c.kind}${'reason' in c ? ` (${c.reason})` : 'question' in c ? ` ${c.question}` : ''}${applied}${r.notice ? `; reply: ${r.notice}` : ''}`
}

// For the run view and status: what became of a run's Zulip input.
export function intakeOfRun(store: IntakeStore, project: string, rec: RunRecord): { request: RequestRow | undefined; messages: MessageRow[] } {
  const request = store.requestOfRun(project, rec)
  return { request, messages: request ? store.messages({ request: request.key }) : [] }
}
