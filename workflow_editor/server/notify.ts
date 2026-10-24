// Zulip coordination on this host (p5): what is owed to Zulip, kept apart
// from the work record. devdocs (run.json) stays authoritative: an event is
// recorded first and only then becomes deliverable. This module keeps, in
// <area>/.local/notify/notify.sqlite:
//
// - targets: the project's channel folder and each workflow's channel, by
//   recorded Zulip id (names are labels), with a visible problem when one is
//   missing or a name is taken by something this integration did not make;
// - runs: each run's topic binding (channel id, topic, last message id) and
//   the identity it was bound with (workspace + creation time), so two
//   different runs sharing project/workflow/run are refused, not merged;
//   relocations: where a run's topic was followed to, kept as history;
// - outbox: one row per coordination event, keyed by its stable id
//   (<project>/<workflow>/<run>#<seq>:<type>, or a checkpoint's), rebuilt
//   from history whenever it is scanned, so a crash between the record and
//   the queue loses nothing;
// - deliveries (p5/ex1): one row per message. Its events, their order, the
//   text, the marker line, the documents it called unpublished and where it
//   was meant to go are frozen when it is first handed to a sender and never
//   change afterwards; an event belongs to one delivery only, and a run has
//   at most one delivery in progress. New events wait for the next one;
// - senders: which transport may deliver. Only the recorded owner claims and
//   sends; another takes over only when the owner's process is gone.
//
// The transport (autolab's agautolab.wfnotify, with the existing Zulip
// client) claims what is due, records `begin` before each POST and reports
// the result with the delivery and claim it was given; it never decides what
// is notable. A delivery that may have been posted — the answer was lost, or
// a send was begun and not finished — is looked for by its marker before
// anything is posted again, and only an established absence lets the same
// payload go out again. Exactly-once is not claimed: a message deleted by
// hand, or a search Zulip cannot answer, leaves the delivery uncertain, and
// that is shown rather than guessed.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  channelDescription, channelName, fitName, folderDescription, folderName, messageUrl, renderDelegationPost, renderMessage, renderNotice, renderPublication, renderPublished, topicName, topicUrl,
  DELAYED_AFTER_MS, type DocLink, type NoticeKind, type RenderContext,
} from '../shared/notify.ts'
import type { IntakeStore, RequestRow } from './intake.ts'
import { effectiveOf, notableEvents, openPresentations, questionState, runKey, type NotableEvent, type RunRecord, type RunRef } from '../shared/run.ts'
import { assertWorkspaceAllowed, loadBoundary } from './boundary.ts'
import type { AttemptRow, CheckpointRow, ExecStore } from './exec.ts'
import { git } from './git.ts'
import { loadRegistry, observe } from './registry.ts'
import { listRuns, readRun, runDir } from './runs.ts'
import { named, openStore, transaction, type Migration } from './sqlite.ts'
import { RequestError, Workspace } from './workspace.ts'
import { runSpace } from './runspace.ts'
import { chunk, entriesOf, ioConfig, ioDescription, ioKey, IO_TOPIC, readFrom, Redactor, renderEntry, type IoConfig, type ReaderState } from './io.ts'
import { creationOf } from './observe.ts'

// <area>/zulip.json — system configuration, outside every repository. No
// credentials: the transport holds those.
export interface NotifyConfig {
  enabled: boolean
  zulipUrl: string // the realm's web address, for topic links
  viewBase: string | null // agdevworld's editor as remote readers reach it (…/wfe/); null: none is reachable
  since: string // runs created before this are not announced (no backfill)
  person?: string // who decides results, as messages name them
  intake?: unknown // requests from Zulip (p6): read by server/intake.ts loadIntakeConfig
  io?: unknown // detailed IO channels (p10): read by server/io.ts ioConfig
}

export function loadNotifyConfig(area: string): NotifyConfig | { problem: string } | null {
  const file = join(area, 'zulip.json')
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<NotifyConfig>
    if (typeof raw.enabled !== 'boolean' || typeof raw.zulipUrl !== 'string' || typeof raw.since !== 'string' || Number.isNaN(Date.parse(raw.since))) {
      return { problem: `${file} needs {"enabled": bool, "zulipUrl": text, "since": ISO time, "viewBase": URL or null}` }
    }
    if (raw.viewBase && /^https?:\/\/(localhost|127\.|\[::1\])/.test(raw.viewBase)) return { problem: `${file}: viewBase ${raw.viewBase} is reachable only on this host; set null or a URL remote readers reach` }
    return { enabled: raw.enabled, zulipUrl: raw.zulipUrl, viewBase: raw.viewBase ?? null, since: raw.since, person: raw.person, ...(raw.intake !== undefined ? { intake: raw.intake } : {}), ...(raw.io !== undefined ? { io: raw.io } : {}) }
  } catch (e) {
    return { problem: `${file} cannot be read: ${(e as Error).message}` }
  }
}

// The interface between this store and the transport. A transport that
// speaks another version is refused rather than half understood (p5/ex1:
// version 2 = frozen deliveries with claims; version 1 sent event ids).
export const NOTIFY_PROTOCOL = 2

export interface TargetRow { key: string; kind: 'folder' | 'channel'; project: string; workflow: string | null; name: string; description: string; zulip_id: number | null; state: 'pending' | 'provisioned' | 'problem'; problem: string | null; created: string; updated: string }
// A conversation messages go to (p6: `kind`). `run`: a run's progress topic,
// keyed <project>/<workflow>/<run>. `request`: the request topic a run was
// asked for in, keyed <project>/<workflow>/<request key>, bound to its run
// once it exists (`bound`); its place is the intake's recorded topic.
// p10 `delegation`: a delegation's posts into its target workflow's channel
// (the request, then the parent's answers and instructions), keyed
// <target project>/<target workflow>/<label>; `request` holds the
// delegation uid, `bound` the child run once the intake created it.
// p10 `io`: a run's detailed IO channel (one per run, topic `io`), keyed
// <ioKey>/io; `request` holds the run uid.
export interface RunRow { key: string; project: string; workflow: string; run: string; workspace: string; created: string; scan_seq: number; stream_id: number | null; channel: string | null; topic: string | null; last_message_id: number | null; problem: string | null; skipped: string | null; updated: string; kind: 'run' | 'request' | 'delegation' | 'io'; request: string | null; bound: string | null }
// How far an attempt's log has become IO messages (p10).
export interface IoAttemptRow { attempt: string; run_key: string; log: string | null; ino: number | null; offset: number; line: number; reader: string; began_queued: number; ended_queued: number; gap: string | null; updated: string }
// What a delegation's outbox event carries: enough to find the parent's
// record and the one answer or instruction it is (docs/delegation.md).
export interface DelegationOutEvent { id: string; seq: number; type: 'delegation-request' | 'delegation-answer' | 'delegation-instruction' | 'delegation-revision'; at: string; by: string; critical: true; parent: { workspace: string; project: string; workflow: string; run: string }; delegation: string; uid: string; index: number; question?: string }
// The conversation key and request topic of a delegation (labels; the
// delivery's recorded message id is the identity).
export const delegationLabel = (parent: { project: string; workflow: string; run: string }, d: string) => `from-${parent.project}.${parent.workflow}.${parent.run}.${d}`
export const delegationTopic = (parent: { project: string; workflow: string; run: string }, d: string) => fitName(`request-${parent.project}.${parent.workflow}.${parent.run}.${d}`)
// state/attempts/next_try/last_error/uncertain are the pre-p5/ex1 per-event
// delivery fields: kept for history and migration; deliveries carry them now.
export interface OutboxRow { id: string; run_key: string; ord: number; type: string; critical: number; event: string; state: 'pending' | 'sent' | 'failed'; attempts: number; next_try: string | null; last_error: string | null; uncertain: number; message_id: number | null; unpublished: string | null; sent_at: string | null; created: string }
export interface Destination { streamId: number; channel: string; topic: string }
// ready: frozen, no send begun since it was (re)claimed; sending: a POST may
// be under way or may have happened; failed: retried at next_try, `uncertain`
// says whether it may have been posted; unresolved: needs a person (`wfe
// notify resolve`); sent; resolved: a legacy delivery whose events were
// accounted for.
export type DeliveryState = 'ready' | 'sending' | 'failed' | 'unresolved' | 'sent' | 'resolved'
export interface DeliveryRow {
  id: number; run_key: string; kind: 'message' | 'legacy'; ord: number; events: string; content: string | null; marker: string | null; unpublished: string | null
  stream_id: number | null; channel: string | null; topic: string | null; tried: string; state: DeliveryState; claim: string | null; owner: string | null
  attempts: number; failures: number; next_try: string | null; last_error: string | null; uncertain: number; first_began: string | null; checked: string | null
  message_id: number | null; sent_at: string | null; followed_up: number | null; problem: string | null; created: string; updated: string
}
export interface SenderRow { name: string; owner: string; pid: number | null; host: string; since: string; seen: string }
export interface Sender { owner: string; pid: number }

// What the transport is asked to do.
export type ProvisionTask =
  | { kind: 'folder'; key: string; name: string; description: string; zulipId: number | null }
  | { kind: 'channel'; key: string; name: string; description: string; zulipId: number | null; folderId: number }
// One claimed delivery. `destination` is where to post now (the run's
// binding, which follows moves); `reconcile` is set when an earlier send may
// have posted it: look in `searchIn` for the sender's messages since `since`
// whose last line is `marker` (legacy: whose marker names any of `tokens`).
export interface Delivery {
  delivery: number; claim: string; run: string; kind: 'message' | 'legacy'; events: string[]; content: string; marker: string
  destination: Destination; lastMessageId: number | null; attempts: number
  reconcile: null | { since: string; searchIn: Destination[]; label: string; tokens?: { event: string; token: string }[] }
}

const now = () => new Date().toISOString()
const BACKOFF = (failures: number) => Math.min(15 * 60, 15 * 2 ** Math.max(0, failures - 1)) * 1000
const ACTIVE = `('ready', 'sending', 'failed', 'unresolved')`
const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
const sameDest = (a: Destination, b: Destination) => a.streamId === b.streamId && a.topic === b.topic

// The marker token an event id stands for: `#<seq>:<type>` for a run entry,
// `cp<n>:<state>` for a checkpoint's.
export function markerToken(eventId: string): string {
  const tail = eventId.slice(eventId.indexOf('#') + 1)
  return tail.startsWith('cp') ? tail : `#${tail}`
}

const MIGRATIONS: Migration[] = [
  {
    version: 1, // p5: targets, runs, outbox (created before versions were kept)
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS targets (key TEXT PRIMARY KEY, kind TEXT NOT NULL, project TEXT NOT NULL, workflow TEXT, name TEXT NOT NULL, description TEXT NOT NULL,
        zulip_id INTEGER, state TEXT NOT NULL, problem TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (key TEXT PRIMARY KEY, project TEXT NOT NULL, workflow TEXT NOT NULL, run TEXT NOT NULL, workspace TEXT NOT NULL, created TEXT NOT NULL,
        scan_seq INTEGER NOT NULL DEFAULT 0, stream_id INTEGER, channel TEXT, topic TEXT, last_message_id INTEGER, problem TEXT, skipped TEXT, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, run_key TEXT NOT NULL, ord REAL NOT NULL, type TEXT NOT NULL, critical INTEGER NOT NULL, event TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_try TEXT, last_error TEXT, uncertain INTEGER NOT NULL DEFAULT 0, message_id INTEGER,
        unpublished TEXT, sent_at TEXT, created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outbox_run ON outbox (run_key, state, ord);
    `),
  },
  {
    version: 2, // p5/ex1: frozen deliveries, sender ownership, relocation history
    up: db => {
      db.exec(`
        CREATE TABLE deliveries (id INTEGER PRIMARY KEY, run_key TEXT NOT NULL, kind TEXT NOT NULL, ord REAL NOT NULL, events TEXT NOT NULL, content TEXT, marker TEXT, unpublished TEXT,
          stream_id INTEGER, channel TEXT, topic TEXT, tried TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, claim TEXT, owner TEXT,
          attempts INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, next_try TEXT, last_error TEXT, uncertain INTEGER NOT NULL DEFAULT 0, first_began TEXT, checked TEXT,
          message_id INTEGER, sent_at TEXT, followed_up INTEGER, problem TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
        CREATE UNIQUE INDEX deliveries_active ON deliveries (run_key) WHERE state IN ${ACTIVE};
        CREATE TABLE delivery_events (event TEXT PRIMARY KEY, delivery INTEGER NOT NULL REFERENCES deliveries (id), pos INTEGER NOT NULL);
        CREATE INDEX delivery_events_delivery ON delivery_events (delivery, pos);
        CREATE TABLE senders (name TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER, host TEXT NOT NULL, since TEXT NOT NULL, seen TEXT NOT NULL);
        CREATE TABLE relocations (id INTEGER PRIMARY KEY, run_key TEXT NOT NULL, stream_id INTEGER NOT NULL, channel TEXT NOT NULL, topic TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL);
        CREATE TABLE notes (id INTEGER PRIMARY KEY, at TEXT NOT NULL, note TEXT NOT NULL);
      `)
      legacyUncertainty(db)
    },
  },
  {
    version: 3, // p6: request-topic conversations beside run topics
    up: db => db.exec(`
      ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'run';
      ALTER TABLE runs ADD COLUMN request TEXT;
      ALTER TABLE runs ADD COLUMN bound TEXT;
    `),
  },
  {
    version: 4, // p10: detailed IO — how far each attempt's log was relayed
    up: db => db.exec(`
      CREATE TABLE io_attempts (attempt TEXT PRIMARY KEY, run_key TEXT NOT NULL, log TEXT, ino INTEGER, offset INTEGER NOT NULL DEFAULT 0, line INTEGER NOT NULL DEFAULT 0,
        reader TEXT NOT NULL DEFAULT '{"tools":{},"format":null}', began_queued INTEGER NOT NULL DEFAULT 0, ended_queued INTEGER NOT NULL DEFAULT 0, gap TEXT, updated TEXT NOT NULL);
      CREATE INDEX io_attempts_run ON io_attempts (run_key);
    `),
  },
]

// Where a run's coordination event goes (p6). A run requested in a Zulip
// request topic talks with the person there — questions, receipts of their
// answers and instructions, the result, its decision — and reports progress
// in its run topic. Events that need the person go to both. A run requested
// elsewhere keeps one topic.
const REQUEST_ONLY = new Set(['question', 'answered', 'instructed', 'acknowledged', 'accepted', 'notice'])
// presented and cleanup-failed (p7) need the person: both conversations.
const RUN_ONLY = new Set(['started', 'reported', 'node-completed', 'delegated', 'delegation'])
export function destinationsOf(type: string, requested: boolean): ('run' | 'request')[] {
  if (!requested) return ['run']
  if (REQUEST_ONLY.has(type)) return ['request']
  if (RUN_ONLY.has(type)) return ['run']
  return ['run', 'request']
}
export const REQUEST_SUFFIX = '@request'

// Pre-p5/ex1 state: an event marked uncertain may have been posted in a
// batch nobody recorded. Per run, those events become one legacy delivery
// that is reconciled — the posts found name exactly which events they
// carried — before anything new of that run is sent. Sent rows, bindings
// and unattempted rows stay as they are; nothing already sent is rescanned.
function legacyUncertainty(db: DatabaseSync) {
  const at = now()
  const runs = db.prepare('SELECT DISTINCT run_key FROM outbox WHERE state != \'sent\' AND uncertain = 1 ORDER BY run_key').all() as { run_key: string }[]
  for (const { run_key } of runs) {
    const rows = db.prepare('SELECT * FROM outbox WHERE run_key = ? AND state != \'sent\' ORDER BY ord, id').all(run_key) as unknown as OutboxRow[]
    const uncertain = rows.filter(r => r.uncertain)
    const notes = [`pre-p5/ex1 uncertain send of ${uncertain.length} event(s); the batch it was part of was not recorded, so the topic is searched for posts naming them before anything else of this run is sent`]
    // The old transport sent a contiguous prefix of a run's unsent events;
    // an unattempted event among or before the uncertain ones is not that.
    const lastUncertain = rows.lastIndexOf(uncertain.at(-1)!)
    const among = rows.slice(0, lastUncertain).filter(r => !r.uncertain)
    if (among.length) notes.push(`inconsistent: ${among.length} unattempted event(s) are ordered among or before the uncertain ones (${among.map(r => r.id).join(', ')}); they wait behind this reconciliation`)
    legacyDelivery(db, run_key, uncertain.map(r => r.id), uncertain[0].ord, notes.join('; '), at)
  }
  const odd = db.prepare('SELECT count(*) AS n FROM outbox WHERE state = \'sent\' AND message_id IS NULL').get() as { n: number }
  if (odd.n) db.prepare('INSERT INTO notes (at, note) VALUES (?, ?)').run(at, `migration: ${odd.n} event(s) are recorded as sent without a message id; left as they are`)
  for (const r of runs) db.prepare('INSERT INTO notes (at, note) VALUES (?, ?)').run(at, `migration: ${r.run_key} had uncertain sends; a legacy reconciliation was created`)
}

function legacyDelivery(db: DatabaseSync, runKeyText: string, ids: string[], ord: number, problem: string, at: string): number {
  const r = db.prepare('SELECT * FROM runs WHERE key = ?').get(runKeyText) as RunRow | undefined
  const channel = r ? db.prepare('SELECT * FROM targets WHERE key = ?').get(`channel:${r.project}/${r.workflow}`) as TargetRow | undefined : undefined
  const dest = r?.stream_id && r.channel && r.topic ? { streamId: r.stream_id, channel: r.channel, topic: r.topic }
    : r && channel?.zulip_id ? { streamId: channel.zulip_id, channel: channel.name, topic: topicName(r.run) } : null
  const id = Number(db.prepare(`INSERT INTO deliveries (run_key, kind, ord, events, stream_id, channel, topic, tried, state, uncertain, problem, created, updated)
    VALUES (?, 'legacy', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(runKeyText, ord, JSON.stringify(ids), dest?.streamId ?? null, dest?.channel ?? null, dest?.topic ?? null,
    JSON.stringify(dest ? [dest] : []), dest ? 'failed' : 'unresolved', dest ? problem : `${problem}; no destination is recorded to search — resolve with \`wfe notify resolve\``, at, at).lastInsertRowid)
  ids.forEach((e, i) => db.prepare('INSERT INTO delivery_events (event, delivery, pos) VALUES (?, ?, ?)').run(e, id, i))
  return id
}

export class NotifyStore {
  readonly db: DatabaseSync
  readonly area: string
  readonly registryFile: string
  private exec?: ExecStore
  intake?: IntakeStore // the request topics (p6); without it every run has one topic
  constructor(o: { area: string; registryFile: string; exec?: ExecStore; intake?: IntakeStore }) {
    this.area = o.area; this.registryFile = o.registryFile; this.exec = o.exec; this.intake = o.intake
    const dir = join(o.area, '.local', 'notify')
    mkdirSync(dir, { recursive: true })
    this.db = openStore('notify store', join(dir, 'notify.sqlite'), MIGRATIONS)
  }
  close() { this.db.close() }
  private all<T>(sql: string, ...a: (string | number | null)[]): T[] { return named('notify store', 'a read', () => this.db.prepare(sql).all(...a) as T[]) }
  private one<T>(sql: string, ...a: (string | number | null)[]): T | undefined { return named('notify store', 'a read', () => this.db.prepare(sql).get(...a) as T | undefined) }
  private run(sql: string, ...a: (string | number | null)[]) { return named('notify store', 'a write', () => this.db.prepare(sql).run(...a)) }
  private tx<T>(f: () => T): T { return transaction(this.db, f, 'notify store') }

  config(): NotifyConfig | { problem: string } | null { return loadNotifyConfig(this.area) }

  // ---- targets ---------------------------------------------------------------------------

  // A target is recorded when its project or workflow becomes known; its
  // name and description are what provisioning will ask for.
  private ensureTarget(kind: 'folder' | 'channel', project: string, workflow: string | null, label: string) {
    const key = kind === 'folder' ? project : `${project}/${workflow}`
    const name = kind === 'folder' ? folderName(project) : channelName(project, workflow!)
    const description = kind === 'folder' ? folderDescription(project, label) : channelDescription(project, workflow!)
    this.run('INSERT OR IGNORE INTO targets (key, kind, project, workflow, name, description, state, created, updated) VALUES (?, ?, ?, ?, ?, ?, \'pending\', ?, ?)', `${kind}:${key}`, kind, project, workflow, name, description, now(), now())
  }

  target(key: string): TargetRow | undefined { return this.one<TargetRow>('SELECT * FROM targets WHERE key = ?', key) }

  recordTarget(key: string, r: { zulipId: number } | { problem: string }) {
    const t = this.target(key)
    if (!t) throw new Error(`no target ${key}`)
    if ('zulipId' in r) this.run('UPDATE targets SET zulip_id = ?, state = \'provisioned\', problem = NULL, updated = ? WHERE key = ?', r.zulipId, now(), key)
    else this.run('UPDATE targets SET state = \'problem\', problem = ?, updated = ? WHERE key = ?', r.problem, now(), key)
  }

  // The explicit repair path: forget a recorded binding (a deleted channel,
  // a name taken by hand) so the next pass provisions it again. Messages
  // already sent stay where they are; a delivery that may have been posted
  // keeps the places it was sent to and is still looked for there.
  reset(key: string): string[] {
    const notes: string[] = []
    const t = this.target(key)
    if (t) {
      this.run('UPDATE targets SET zulip_id = NULL, state = \'pending\', problem = NULL, updated = ? WHERE key = ?', now(), key)
      notes.push(`${key}: will be provisioned again`)
      if (t.kind === 'channel') {
        const n = this.run('UPDATE runs SET stream_id = NULL, channel = NULL, topic = NULL, last_message_id = NULL, problem = NULL, updated = ? WHERE project = ? AND workflow = ?', now(), t.project, t.workflow!).changes
        notes.push(`${n} run topic binding(s) of ${t.project}/${t.workflow} forgotten; their next messages open new topics`)
      }
    }
    const r = this.one<RunRow>('SELECT * FROM runs WHERE key = ?', key)
    if (r) {
      this.run('UPDATE runs SET problem = NULL, stream_id = NULL, channel = NULL, topic = NULL, last_message_id = NULL, updated = ? WHERE key = ?', now(), key)
      notes.push(`${key}: topic binding and problem cleared`)
    }
    if (!notes.length) throw new Error(`nothing is recorded under ${key} (a target key is folder:<project> or channel:<project>/<workflow>; a run is <project>/<workflow>/<run>)`)
    const open = this.all<DeliveryRow>(`SELECT * FROM deliveries WHERE state IN ${ACTIVE} AND (uncertain = 1 OR state = 'sending') AND (run_key = ? OR run_key LIKE ?)`, key, `${t?.kind === 'channel' ? `${t.project}/${t.workflow}` : '\u0000'}/%`)
    for (const d of open) notes.push(`delivery ${d.id} of ${d.run_key} may have been posted; it is still looked for where it was sent (${(JSON.parse(d.tried) as Destination[]).map(x => `#${x.streamId} › ${x.topic}`).join(', ') || 'nowhere recorded'}) before anything is posted again`)
    return notes
  }

  // ---- scanning: the outbox follows the records ------------------------------------------

  // Reads every available, allowed workspace: its project and workflows
  // become targets; its runs' new history entries become outbox rows. Safe
  // to repeat: rows are keyed by event id and inserted once.
  async scan(): Promise<string[]> {
    const cfg = this.config()
    if (!cfg || 'problem' in cfg || !cfg.enabled) return []
    const notes: string[] = []
    const reg = await loadRegistry(this.registryFile)
    const boundary = await loadBoundary(this.registryFile, this.area)
    for (const w of reg.workspaces) {
      try { await assertWorkspaceAllowed(boundary, w, 'Notification') } catch { continue }
      if (!(await observe(w)).available) continue
      const ws = new Workspace(w)
      const project = (await ws.readProject().catch(() => ({ project: undefined }))).project
      if (!project?.id) continue
      this.ensureTarget('folder', project.id, null, project.name)
      for (const s of (await ws.workflowSummaries()).list) if (s.id) this.ensureTarget('channel', project.id, s.id, s.name || s.id)
      for (const s of await listRuns(ws)) {
        if (s.problem) continue
        const ref = { workflow: s.workflow, run: s.run }
        const rec = (await readRun(ws, ref)).record
        if (rec) notes.push(...await this.scanRun(ws, rec, cfg))
      }
    }
    notes.push(...this.scanNotices(cfg))
    return notes
  }

  // The request topic's conversation row, created when first needed and
  // bound to its run once that exists.
  private requestThread(req: RequestRow): string {
    const key = `${req.project}/${req.workflow}/${req.key}`
    const channel = this.target(`channel:${req.project}/${req.workflow}`)?.name ?? channelName(req.project, req.workflow)
    this.run(`INSERT OR IGNORE INTO runs (key, project, workflow, run, workspace, created, stream_id, channel, topic, kind, request, bound, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'request', ?, ?, ?)`, key, req.project, req.workflow, req.key, req.workspace, req.created, req.stream_id, channel, req.topic, req.key, req.run, now())
    if (req.run) this.run('UPDATE runs SET bound = ?, updated = ? WHERE key = ? AND bound IS NULL', req.run, now(), key)
    return key
  }

  // ---- detailed IO (p10, server/io.ts) -------------------------------------------------------

  private ioOf(cfg: NotifyConfig): IoConfig | null { return ioConfig(cfg.io) }
  ioTargetOf(rec: RunRecord): TargetRow | undefined { return this.target(`channel:${ioKey(rec, creationOf(rec))}`) }

  // The IO channel target and its conversation, once per run.
  private ensureIo(workspace: string, rec: RunRecord) {
    const creation = creationOf(rec)
    const key = ioKey(rec, creation)
    const uid = `${rec.project}/${rec.workflow}/${rec.run}#${creation}`
    const name = fitName(`wf-${rec.project}.${rec.workflow}.${rec.run}.io`)
    this.run('INSERT OR IGNORE INTO targets (key, kind, project, workflow, name, description, state, created, updated) VALUES (?, \'channel\', ?, ?, ?, ?, \'pending\', ?, ?)', `channel:${key}`, rec.project, `${rec.workflow}/${rec.run}@${creation}`, name, ioDescription(rec, creation, uid), now(), now())
    this.run(`INSERT OR IGNORE INTO runs (key, project, workflow, run, workspace, created, channel, topic, kind, request, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'io', ?, ?)`, `${key}/io`, rec.project, rec.workflow, rec.run, workspace, rec.created, name, IO_TOPIC, uid, now())
  }

  // Turns what each attempt of each IO-enabled run appended to its log into
  // messages of the run's IO conversation (p10). Positions persist: nothing
  // is relayed twice, a restart goes on where it stopped, and a log that is
  // missing, truncated or replaced is said to be so, never shown as whole.
  async ioScan(at = new Date()): Promise<string[]> {
    const cfg = this.config()
    if (!cfg || 'problem' in cfg || !cfg.enabled || !this.exec) return []
    const io = this.ioOf(cfg)
    if (!io) return []
    const notes: string[] = []
    const redact = await Redactor.from(io.secretFiles)
    for (const r of this.all<RunRow>('SELECT * FROM runs WHERE kind = \'io\' AND problem IS NULL ORDER BY key')) {
      const attempts = this.exec.db.prepare('SELECT a.*, j.kind AS job_kind, j.reason AS job_reason FROM attempts a LEFT JOIN jobs j ON j.id = a.job WHERE a.workspace = ? AND a.workflow = ? AND a.run = ? ORDER BY a.began').all(r.workspace, r.workflow, r.run) as unknown as (AttemptRow & { job_kind: string | null; job_reason: string | null })[]
      // How each attempt ended as the record says it (an exit with work left
      // running is an interruption there, whatever the exit code).
      let ends: Map<string, string> | null = null
      const endOf = async (attempt: string) => {
        if (!ends) {
          ends = new Map()
          const w = (await loadRegistry(this.registryFile)).workspaces.find(x => x.id === r.workspace)
          const rec = w ? (await readRun(await runSpace(new Workspace(w), { workflow: r.workflow, run: r.run }), { workflow: r.workflow, run: r.run }).catch(() => null))?.record : undefined
          for (const h of rec?.history ?? []) if (h.op === 'attempt.end') ends.set((h as { attempt: string }).attempt, `${h.change.hold?.[1] ?? (h as { outcome: string }).outcome}${(h as { detail?: string }).detail ? `: ${(h as { detail?: string }).detail}` : ''}`)
        }
        return ends.get(attempt)
      }
      for (const a of attempts) {
        try { notes.push(...await this.ioAttempt(r, a, cfg, redact, at, endOf)) } catch (e) { notes.push(`io ${r.key} ${a.id}: ${(e as Error).message}`) }
      }
    }
    return notes
  }

  private async ioAttempt(r: RunRow, a: AttemptRow & { job_kind: string | null; job_reason: string | null }, cfg: NotifyConfig, redact: Redactor, at: Date, endOf: (attempt: string) => Promise<string | undefined>): Promise<string[]> {
    this.run('INSERT OR IGNORE INTO io_attempts (attempt, run_key, log, updated) VALUES (?, ?, ?, ?)', a.id, r.key, a.log, now())
    let row = this.one<IoAttemptRow>('SELECT * FROM io_attempts WHERE attempt = ?', a.id)!
    if (row.ended_queued) return []
    const out: string[] = []
    const ord = () => (this.one<{ o: number | null }>('SELECT max(ord) AS o FROM outbox WHERE run_key = ?', r.key)?.o ?? 0) + 1
    const queue = (id: string, text: string, type = 'io') => {
      const res = this.run('INSERT OR IGNORE INTO outbox (id, run_key, ord, type, critical, event, state, created) VALUES (?, ?, ?, ?, 1, ?, \'pending\', ?)', `${r.key}#io:${a.id}:${id}`, r.key, ord(), type, JSON.stringify({ id: `${r.key}#io:${a.id}:${id}`, type, at: now(), text }), now())
      if (Number(res.changes)) out.push(`queued io ${r.workflow}/${r.run} ${a.id} ${id}`)
    }
    const label = `${r.workflow}/${r.run}`
    const full = (line: number) => cfg.viewBase ? `[open the whole entry](${cfg.viewBase.replace(/\/?$/, '/')}#/ws/${encodeURIComponent(r.workspace)}/run/${encodeURIComponent(r.workflow)}/${encodeURIComponent(r.run)}/io/${a.id}/${line})` : `\`wfe run io ${label} --attempt ${a.id} --line ${line}\` on the execution host`
    if (!row.began_queued) {
      queue('begin', `**Attempt ${a.id} began** ${a.began.replace('T', ' ').slice(0, 19)} UTC — ${a.job_kind ?? 'job'}${a.job_reason ? `: ${redact.apply(a.job_reason)}` : ''}${a.backend ? ` (${a.backend})` : ''}`)
      this.run('UPDATE io_attempts SET began_queued = 1, updated = ? WHERE attempt = ?', now(), a.id)
    }
    if (a.log) {
      const read = await readFrom(a.log, row.offset, row.line)
      if (!read) {
        if (a.state === 'ended' && row.gap !== 'missing') {
          queue(`gap:missing`, `_The log of attempt ${a.id} is not on this host; its IO ${row.offset ? `after line ${row.line} ` : ''}cannot be shown here (a gap, not an empty attempt)._`, 'io-gap')
          this.run('UPDATE io_attempts SET gap = ?, updated = ? WHERE attempt = ?', 'missing', now(), a.id)
        }
        if (a.state === 'ended') {
          queue('end', `**Attempt ${a.id} ended** — ${redact.apply((await endOf(a.id)) ?? a.outcome ?? 'ended')} (its log is gone: the IO above is all this channel has of it).`, 'io')
          this.run('UPDATE io_attempts SET ended_queued = 1, updated = ? WHERE attempt = ?', now(), a.id)
        }
      } else {
        if ((row.ino !== null && read.ino !== row.ino) || read.size < row.offset) {
          const what = row.ino !== null && read.ino !== row.ino ? 'replaced' : 'truncated'
          queue(`gap:${row.offset}`, `_The log of attempt ${a.id} was ${what} after line ${row.line} (byte ${row.offset}); what it held beyond that point and was not yet shown is missing here (a gap)._`, 'io-gap')
          this.run('UPDATE io_attempts SET gap = ?, ino = ?, offset = ?, line = ?, updated = ? WHERE attempt = ?', what, read.ino, what === 'replaced' ? 0 : read.size, what === 'replaced' ? 0 : row.line, now(), a.id)
          return out // read the new content next pass, from its start
        }
        if (row.ino === null) this.run('UPDATE io_attempts SET ino = ? WHERE attempt = ?', read.ino, a.id)
        if (read.lines.length) {
          const reader = JSON.parse(row.reader) as ReaderState
          const entries = entriesOf(read.lines, reader)
          const rendered = entries.map(e => ({ line: e.line, text: renderEntry(e, redact, full) }))
          const size = rendered.reduce((n, x) => n + x.text.length, 0)
          // While the attempt writes, small increments wait a little to be one message.
          const settled = a.state === 'ended' || size >= 1500 || at.getTime() - read.mtimeMs > 15_000 || read.offset < read.size
          if (settled) {
            for (const c of chunk(rendered)) queue(`L${c.from}-${c.to}`, `_${a.id} · log ${c.from === c.to ? `line ${c.from}` : `lines ${c.from}–${c.to}`}_\n\n${c.text}`)
            this.run('UPDATE io_attempts SET offset = ?, line = ?, reader = ?, updated = ? WHERE attempt = ?', read.offset, read.line, JSON.stringify(reader), now(), a.id)
            row = this.one<IoAttemptRow>('SELECT * FROM io_attempts WHERE attempt = ?', a.id)!
          }
        }
        if (a.state === 'ended' && row.offset >= read.size) {
          const recorded = await endOf(a.id)
          queue('end', `**Attempt ${a.id} ended** — ${redact.apply(recorded ?? a.outcome ?? 'ended')}${a.exit_code !== null && a.exit_code !== undefined ? ` (process exit ${a.exit_code})` : a.signal ? ` (process signal ${a.signal})` : ''}.`, 'io')
          this.run('UPDATE io_attempts SET ended_queued = 1, updated = ? WHERE attempt = ?', now(), a.id)
        }
      }
    }
    if (!a.log && a.state === 'ended') {
      queue('end', `**Attempt ${a.id} ended** — ${redact.apply((await endOf(a.id)) ?? a.outcome ?? 'ended')} (no log was kept).`, 'io')
      this.run('UPDATE io_attempts SET ended_queued = 1, updated = ? WHERE attempt = ?', now(), a.id)
    }
    return out
  }

  // The IO channel of a run as views state it.
  ioStatus(rec: RunRecord): { state: 'disabled' | 'pending' | 'provisioned' | 'problem'; url: string | null; problem?: string; attempts: { attempt: string; line: number; gap: string | null; ended: boolean }[] } {
    const cfg = this.config()
    if (!cfg || 'problem' in cfg || !this.ioOf(cfg) || Date.parse(rec.created) < Date.parse(this.ioOf(cfg)!.since)) return { state: 'disabled', url: null, attempts: [] }
    const t = this.ioTargetOf(rec)
    const key = `${ioKey(rec, creationOf(rec))}/io`
    const attempts = this.all<IoAttemptRow>('SELECT * FROM io_attempts WHERE run_key = ? ORDER BY rowid', key).map(x => ({ attempt: x.attempt, line: x.line, gap: x.gap, ended: !!x.ended_queued }))
    if (!t) return { state: 'pending', url: null, attempts }
    return { state: t.state, url: t.state === 'provisioned' && t.zulip_id ? topicUrl(cfg.zulipUrl, t.zulip_id, t.name, IO_TOPIC) : null, ...(t.problem ? { problem: t.problem } : {}), attempts }
  }

  // A delegation's conversation row (p10), created with its request topic.
  private delegationThread(workspace: string, rec: RunRecord, d: NonNullable<RunRecord['delegations']>[string]): string {
    const label = delegationLabel(rec, d.id)
    const key = `${d.target.project}/${d.target.workflow}/${label}`
    this.ensureTarget('channel', d.target.project, d.target.workflow, d.target.workflow)
    const channel = this.target(`channel:${d.target.project}/${d.target.workflow}`)?.name ?? channelName(d.target.project, d.target.workflow)
    this.run(`INSERT OR IGNORE INTO runs (key, project, workflow, run, workspace, created, channel, topic, kind, request, bound, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'delegation', ?, ?, ?)`, key, d.target.project, d.target.workflow, label, workspace, d.dispatched.at, channel, delegationTopic(rec, d.id), d.uid, d.child?.run ?? null, now())
    return key
  }

  // Which delegation a post in a workflow channel is (p10): the sent
  // delivery that recorded its message id — never its text. `pending` when
  // a delegation delivery to that channel may have been posted and is not
  // yet acknowledged (the intake waits for it).
  delegationPost(m: { id: number; streamId: number }): { state: 'sent'; event: DelegationOutEvent; destination: Destination } | { state: 'pending' } | null {
    const d = this.one<DeliveryRow>(`SELECT d.* FROM deliveries d JOIN runs r ON r.key = d.run_key WHERE r.kind = 'delegation' AND d.state = 'sent' AND d.message_id = ?`, m.id)
    if (d) {
      const first = (JSON.parse(d.events) as string[])[0]
      const ev = this.one<OutboxRow>('SELECT * FROM outbox WHERE id = ?', first)
      if (ev) return { state: 'sent', event: JSON.parse(ev.event) as DelegationOutEvent, destination: { streamId: d.stream_id!, channel: d.channel!, topic: d.topic! } }
    }
    const open = this.all<DeliveryRow>(`SELECT d.* FROM deliveries d JOIN runs r ON r.key = d.run_key WHERE r.kind = 'delegation' AND (d.state = 'sending' OR (d.state IN ('failed', 'unresolved') AND d.uncertain = 1))`)
    if (open.some(x => x.stream_id === m.streamId || (JSON.parse(x.tried) as Destination[]).some(t => t.streamId === m.streamId))) return { state: 'pending' }
    return null
  }

  // Replies the intake owes the person about posts that changed nothing or
  // need them (docs/intake.md): one message each, in their request topic.
  private scanNotices(cfg: NotifyConfig): string[] {
    if (!this.intake) return []
    const added: string[] = []
    for (const m of this.intake.notices()) {
      const req = m.request_key ? this.intake.request(m.request_key) : undefined
      if (!req || Date.parse(req.created) < Date.parse(cfg.since)) continue
      const key = this.requestThread(req)
      const id = `${key}#z${m.id}:${m.notice}`
      if (this.one('SELECT 1 FROM outbox WHERE id = ?', id)) continue
      const ord = (this.one<{ o: number | null }>('SELECT max(ord) AS o FROM outbox WHERE run_key = ?', key)?.o ?? 0) + 0.5
      const event = { id, seq: 0, type: 'notice', at: m.updated, by: 'intake', critical: true, text: m.detail ?? '', kind: m.notice, post: m.id, stream: m.stream_id, topic: m.topic, classification: m.classification ? JSON.parse(m.classification) : null }
      const r = this.run('INSERT OR IGNORE INTO outbox (id, run_key, ord, type, critical, event, state, created) VALUES (?, ?, ?, \'notice\', 1, ?, \'pending\', ?)', id, key, ord, JSON.stringify(event), now())
      if (Number(r.changes)) added.push(`queued ${id}`)
    }
    return added
  }

  private async scanRun(ws: Workspace, rec: RunRecord, cfg: NotifyConfig): Promise<string[]> {
    const key = `${rec.project}/${rec.workflow}/${rec.run}`
    this.ensureTarget('channel', rec.project, rec.workflow, rec.workflow)
    // A run requested in a Zulip request topic is announced once the intake
    // has bound the request to it, so its first events reach both topics.
    const req = this.intake?.requestOfRun(rec.project, rec)
    if (rec.input.source?.kind === 'zulip' && !req) return []
    let row = this.one<RunRow>('SELECT * FROM runs WHERE key = ?', key)
    if (!row) {
      const skipped = Date.parse(rec.created) < Date.parse(cfg.since) ? `created ${rec.created}, before announcements began (${cfg.since}); not backfilled` : null
      this.run('INSERT OR IGNORE INTO runs (key, project, workflow, run, workspace, created, skipped, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', key, rec.project, rec.workflow, rec.run, ws.reg.id, rec.created, skipped, now())
      row = this.one<RunRow>('SELECT * FROM runs WHERE key = ?', key)!
    }
    if (row.skipped) return []
    // One run, one topic: the same project/workflow/run created elsewhere is
    // another run and is refused; a second workspace holding this very run
    // (same creation) is read only through the bound one.
    if (row.workspace !== ws.reg.id) {
      if (row.created !== rec.created && !row.problem) {
        this.run('UPDATE runs SET problem = ?, updated = ? WHERE key = ?', `ambiguous identity: ${key} exists in workspace ${row.workspace} (created ${row.created}) and in ${ws.reg.id} (created ${rec.created}); nothing more is announced until one is renamed or the binding is reset (wfe notify reset ${key})`, now(), key)
        return [`${key}: duplicate identity in ${row.workspace} and ${ws.reg.id}`]
      }
      return []
    }
    if (row.created !== rec.created) {
      if (!row.problem) this.run('UPDATE runs SET problem = ?, updated = ? WHERE key = ?', `${key} in ${ws.reg.id} was created again (${rec.created}; bound to ${row.created}); reset the binding to announce the new run (wfe notify reset ${key})`, now(), key)
      return [`${key}: recreated run`]
    }
    const added: string[] = []
    const reqKey = req ? this.requestThread(req) : null
    // The run's detailed IO channel (p10), from its creation on.
    const io = this.ioOf(cfg)
    if (io && Date.parse(rec.created) >= Date.parse(io.since)) this.ensureIo(ws.reg.id, rec)
    const insert = (id: string, ord: number, type: string, critical: boolean, event: unknown, thread = key) => {
      const r = this.run('INSERT OR IGNORE INTO outbox (id, run_key, ord, type, critical, event, state, created) VALUES (?, ?, ?, ?, ?, ?, \'pending\', ?)', id, thread, ord, type, critical ? 1 : 0, JSON.stringify(event), now())
      if (Number(r.changes)) added.push(id)
      return Number(r.changes) > 0
    }
    // The request became this run: said once, first, in the request topic.
    if (reqKey) {
      const first = rec.history[0]
      insert(`${key}#1:accepted${REQUEST_SUFFIX}`, 1, 'accepted', false, { id: `${key}#1:accepted`, seq: 1, type: 'accepted', at: first.at, by: first.by, critical: false, text: '' }, reqKey)
      // The receipt went out before the IO channel existed: its link follows (p10).
      const t = io ? this.ioTargetOf(rec) : undefined
      if (t?.state === 'provisioned') {
        const sent = this.one<{ content: string | null }>(`SELECT d.content FROM outbox o JOIN delivery_events e ON e.event = o.id JOIN deliveries d ON d.id = e.delivery WHERE o.id = ? AND o.state = 'sent'`, `${key}#1:accepted${REQUEST_SUFFIX}`)
        if (sent && !sent.content?.includes('Detailed IO: http')) insert(`${key}#1:io-ready${REQUEST_SUFFIX}`, 1.5, 'io-ready', false, { id: `${key}#1:io-ready`, seq: 1, type: 'io-ready', at: now(), by: 'wfe', critical: false, text: '' }, reqKey)
      }
    }
    if (rec.seq > row.scan_seq) {
      // Events of one entry keep the order the selection gives them; each
      // goes to the conversations it belongs to, under an id per destination.
      this.tx(() => {
        let prev = -1, k = 0
        for (const e of notableEvents(rec, row!.scan_seq)) {
          k = e.seq === prev ? k + 1 : 0; prev = e.seq
          for (const d of destinationsOf(e.type, !!reqKey)) {
            if (d === 'run') insert(e.id, e.seq + k * 0.01, e.type, e.critical, e)
            else insert(`${e.id}${REQUEST_SUFFIX}`, e.seq + k * 0.01, e.type, e.critical, e, reqKey!)
          }
        }
        // A delegation's posts (p10): its request, then the parent agent's
        // answers and instructions, into its target workflow's channel, in
        // record order, each a delivery of its own.
        for (const h of rec.history) {
          if (h.seq <= row!.scan_seq || !['delegation.dispatch', 'delegation.answer', 'delegation.instruct', 'delegation.revise'].includes(h.op)) continue
          const d = rec.delegations?.[(h as { delegation?: string }).delegation ?? '']
          if (!d) continue
          const conv = this.delegationThread(ws.reg.id, rec, d)
          const type = h.op === 'delegation.dispatch' ? 'delegation-request' : h.op === 'delegation.answer' ? 'delegation-answer' : h.op === 'delegation.revise' ? 'delegation-revision' : 'delegation-instruction'
          const index = type === 'delegation-answer' ? d.answers.find(a => a.seq === h.seq)?.n ?? 0 : type === 'delegation-instruction' ? d.instructions.find(a => a.seq === h.seq)?.n ?? 0 : type === 'delegation-revision' ? d.revisions?.find(a => a.seq === h.seq)?.n ?? 0 : 0
          const ev: DelegationOutEvent = { id: `${key}#${h.seq}:${type}@${d.id}`, seq: h.seq, type, at: h.at, by: h.by, critical: true, parent: { workspace: ws.reg.id, project: rec.project, workflow: rec.workflow, run: rec.run }, delegation: d.id, uid: d.uid, index, ...(type === 'delegation-answer' ? { question: (h as { question?: string }).question } : {}) }
          insert(ev.id, h.seq, type, true, ev, conv)
        }
        this.run('UPDATE runs SET scan_seq = max(scan_seq, ?), updated = ? WHERE key = ?', rec.seq, now(), key)
      })
    }
    const repaired: string[] = []
    // An open delegation's post whose outbox row is missing although the
    // cursor passed its entry (project_migration p8 ex1: a lost or removed
    // row) is queued again from the record, under the same id, so the
    // transport's marker search finds a post that did go out.
    for (const d of Object.values(rec.delegations ?? {})) {
      if (d.disposition || d.closed) continue
      const owed = [...(d.child ? [] : [{ seq: d.dispatched.seq, type: 'delegation-request' as const, index: 0 }]),
        ...d.answers.map(a => ({ seq: a.seq, type: 'delegation-answer' as const, index: a.n, question: a.question })),
        ...d.instructions.map(i => ({ seq: i.seq, type: 'delegation-instruction' as const, index: i.n })),
        ...(d.revisions ?? []).map(r => ({ seq: r.seq, type: 'delegation-revision' as const, index: r.n }))]
      for (const o of owed) {
        const id = `${key}#${o.seq}:${o.type}@${d.id}`
        if (this.one('SELECT 1 FROM outbox WHERE id = ?', id) || this.one('SELECT 1 FROM delivery_events WHERE event = ?', id)) continue
        const h = rec.history.find(x => x.seq === o.seq)
        if (!h) continue
        const ev: DelegationOutEvent = { id, seq: o.seq, type: o.type, at: h.at, by: h.by, critical: true, parent: { workspace: ws.reg.id, project: rec.project, workflow: rec.workflow, run: rec.run }, delegation: d.id, uid: d.uid, index: o.index, ...('question' in o ? { question: o.question } : {}) }
        if (insert(id, o.seq, o.type, true, ev, this.delegationThread(ws.reg.id, rec, d))) { this.run('UPDATE outbox SET uncertain = 1 WHERE id = ?', id); repaired.push(id) }
      }
    }
    // The delegation conversations follow their child once it is bound.
    for (const d of Object.values(rec.delegations ?? {})) if (d.child) this.run('UPDATE runs SET bound = ?, updated = ? WHERE kind = \'delegation\' AND request = ? AND bound IS NULL', d.child.run, now(), d.uid)
    // Publication: failures and their recovery, and details that became
    // readable after a message had to call them unpublished.
    for (const cp of this.checkpoints(ws.reg.id, rec)) {
      const at = cp.created
      // After the last entry recorded before the checkpoint was made.
      const ordOf = [...rec.history].reverse().find(h => h.at <= cp.created)?.seq ?? rec.seq
      const cpKey = `${key}#cp${cp.id}`
      if (cp.state === 'failed' || cp.state === 'attention') insert(`${cpKey}:${cp.state}`, ordOf + 0.5, 'publication', true, { checkpoint: cp.id, state: cp.state, detail: cp.error ?? stepProblems(cp), at })
      if (cp.state === 'published' && this.one('SELECT 1 FROM outbox WHERE id IN (?, ?)', `${cpKey}:failed`, `${cpKey}:attention`)) insert(`${cpKey}:recovered`, ordOf + 0.5, 'publication', false, { checkpoint: cp.id, state: 'recovered', at })
      if (cp.state === 'published') {
        // Sent messages that called documents unpublished — deliveries (their
        // frozen record stays as it was; the follow-up is noted beside it),
        // and pre-p5/ex1 outbox rows — in each conversation that sent them.
        for (const thread of [key, ...(reqKey ? [reqKey] : [])]) this.tx(() => {
          const deliveries = this.all<DeliveryRow>('SELECT * FROM deliveries WHERE run_key = ? AND state = \'sent\' AND unpublished IS NOT NULL AND followed_up IS NULL', thread)
          const legacy = this.all<OutboxRow>('SELECT * FROM outbox WHERE run_key = ? AND state = \'sent\' AND unpublished IS NOT NULL', thread)
          const docs = [...new Set([...deliveries, ...legacy].flatMap(o => JSON.parse(o.unpublished!) as string[]))]
          if (!docs.length) return
          const base = `${cpKey}:published${thread === key ? '' : REQUEST_SUFFIX}`
          let id = base
          for (let n = 2; this.one('SELECT 1 FROM outbox WHERE id = ?', id); n++) id = `${base}.${n}`
          insert(id, ordOf + 0.6, 'published', false, { checkpoint: cp.id, docs, at }, thread)
          this.run('UPDATE deliveries SET followed_up = ?, updated = ? WHERE run_key = ? AND state = \'sent\' AND unpublished IS NOT NULL AND followed_up IS NULL', cp.id, now(), thread)
          this.run('UPDATE outbox SET unpublished = NULL WHERE run_key = ? AND state = \'sent\' AND unpublished IS NOT NULL', thread)
        })
      }
    }
    return added.map(id => repaired.includes(id) ? `queued ${id} again (its outbox row was missing)` : `queued ${id}`)
  }

  // An attempt of the run is open, or its last checkpoint is not settled.
  private publicationPending(r: RunRow): boolean {
    const run = r.kind === 'request' ? r.bound : r.run
    if (!this.exec || !run) return false
    const open = this.exec.db.prepare('SELECT 1 FROM attempts WHERE workspace = ? AND workflow = ? AND run = ? AND state != \'ended\'').get(r.workspace, r.workflow, run)
    const last = this.exec.db.prepare('SELECT state FROM checkpoints WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY id DESC LIMIT 1').get(r.workspace, r.workflow, run) as { state?: string } | undefined
    return !!open || last?.state === 'pending'
  }

  private checkpoints(workspace: string, ref: RunRef): CheckpointRow[] {
    if (!this.exec) return []
    return (this.exec.db.prepare('SELECT * FROM checkpoints WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY id').all(workspace, ref.workflow, ref.run) as unknown as CheckpointRow[])
  }

  // ---- what is due -----------------------------------------------------------------------

  private enabled(): { cfg: NotifyConfig } | { disabled: string; problems: string[] } {
    const cfg = this.config()
    if (!cfg) return { disabled: `no ${join(this.area, 'zulip.json')}: Zulip coordination is not configured`, problems: [] }
    if ('problem' in cfg) return { disabled: cfg.problem, problems: [cfg.problem] }
    if (!cfg.enabled) return { disabled: 'zulip.json: enabled is false', problems: [] }
    return { cfg }
  }

  // Scans, then says what to provision and which problems stand. Deliveries
  // are handed out only by claim().
  async due(): Promise<{ protocol: number; disabled?: string; provision: ProvisionTask[]; problems: string[] }> {
    const e = this.enabled()
    if ('disabled' in e) return { protocol: NOTIFY_PROTOCOL, disabled: e.disabled, provision: [], problems: e.problems }
    await this.scan()
    await this.ioScan().catch(() => [])
    const provision: ProvisionTask[] = []
    for (const t of this.all<TargetRow>('SELECT * FROM targets ORDER BY kind DESC, key')) {
      if (t.state !== 'pending') continue
      if (t.kind === 'folder') provision.push({ kind: 'folder', key: t.key, name: t.name, description: t.description, zulipId: t.zulip_id })
      else {
        const folder = this.target(`folder:${t.project}`)
        if (folder?.state === 'provisioned') provision.push({ kind: 'channel', key: t.key, name: t.name, description: t.description, zulipId: t.zulip_id, folderId: folder.zulip_id! })
      }
    }
    return { protocol: NOTIFY_PROTOCOL, provision, problems: this.problems() }
  }

  problems(): string[] {
    const out: string[] = []
    for (const t of this.all<TargetRow>('SELECT * FROM targets WHERE state = \'problem\' ORDER BY key')) out.push(`${t.key}: ${t.problem}`)
    for (const r of this.all<RunRow>('SELECT * FROM runs WHERE skipped IS NULL AND problem IS NOT NULL ORDER BY key')) out.push(`${r.key}: ${r.problem}`)
    for (const d of this.all<DeliveryRow>(`SELECT * FROM deliveries WHERE state IN ${ACTIVE} AND (state = 'unresolved' OR (uncertain = 1 AND last_error IS NOT NULL)) ORDER BY run_key`)) {
      out.push(`${d.run_key}: delivery ${d.id} ${d.state === 'unresolved' ? 'needs a person' : 'may have been posted and is not reconciled'}: ${d.problem ?? d.last_error}`)
    }
    return out
  }

  // Sender ownership: the recorded owner, or nobody, or an owner whose
  // process on this host is gone. A lease that merely aged proves nothing
  // (its request may still be in flight), so there is no expiry.
  private takeSender(s: Sender): { ok: true; tookOver?: SenderRow } | { refused: string } {
    const row = this.one<SenderRow>('SELECT * FROM senders WHERE name = \'zulip\'')
    const host = hostname()
    if (row && row.owner !== s.owner) {
      if (row.host !== host) return { refused: `sender ${row.owner} on ${row.host} owns delivery (since ${row.since}, last seen ${row.seen}); its process cannot be checked from here. Stop it, then \`wfe notify sender --release ${row.owner}\`` }
      if (alive(row.pid)) return { refused: `sender ${row.owner} (pid ${row.pid}, since ${row.since}, last seen ${row.seen}) is delivering; only one sender posts` }
    }
    const tookOver = row && row.owner !== s.owner ? row : undefined
    this.run('INSERT INTO senders (name, owner, pid, host, since, seen) VALUES (\'zulip\', ?, ?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, pid = excluded.pid, host = excluded.host, since = CASE WHEN senders.owner = excluded.owner THEN senders.since ELSE excluded.since END, seen = excluded.seen',
      s.owner, s.pid, host, now(), now())
    return { ok: true, tookOver }
  }

  sender(): SenderRow | undefined { return this.one<SenderRow>('SELECT * FROM senders WHERE name = \'zulip\'') }

  // A person's override for a sender on another host or a stuck record.
  releaseSender(owner: string): string {
    const row = this.sender()
    if (!row || row.owner !== owner) throw new RequestError(409, `the sender is ${row ? row.owner : 'nobody'}, not ${owner}`)
    if (row.host === hostname() && alive(row.pid)) throw new RequestError(409, `sender ${owner} (pid ${row.pid}) is still running on this host; stop it first`)
    this.run('DELETE FROM senders WHERE name = \'zulip\' AND owner = ?', owner)
    return `released ${owner}; deliveries it had begun are reconciled before they are sent again`
  }

  // Hands the sender at most one delivery per run: the run's delivery in
  // progress, or a new one frozen from its next events. Rendering reads
  // documents and Git outside any transaction; the delivery is then created
  // in a short one that checks the selection still holds.
  async claim(s: Sender, at = new Date()): Promise<{ protocol: number; disabled?: string; deliveries: Delivery[]; problems: string[]; refused?: string }> {
    const e = this.enabled()
    if ('disabled' in e) return { protocol: NOTIFY_PROTOCOL, disabled: e.disabled, deliveries: [], problems: e.problems }
    const owner = this.tx(() => this.takeSender(s))
    if ('refused' in owner) return { protocol: NOTIFY_PROTOCOL, deliveries: [], problems: [owner.refused], refused: owner.refused }
    await this.scan()
    const out: Delivery[] = []
    const problems: string[] = []
    for (const r of this.all<RunRow>('SELECT * FROM runs WHERE skipped IS NULL AND problem IS NULL ORDER BY key')) {
      try {
        const d = await this.claimRun(r, s, e.cfg, at)
        if (d) out.push(d)
      } catch (err) { problems.push(`${r.key}: ${(err as Error).message}`) }
    }
    return { protocol: NOTIFY_PROTOCOL, deliveries: out, problems: [...this.problems(), ...problems] }
  }

  private active(runKeyText: string): DeliveryRow | undefined {
    return this.one<DeliveryRow>(`SELECT * FROM deliveries WHERE run_key = ? AND state IN ${ACTIVE}`, runKeyText)
  }

  private unassigned(runKeyText: string, limit = 7): OutboxRow[] {
    return this.all<OutboxRow>('SELECT * FROM outbox WHERE run_key = ? AND state != \'sent\' AND id NOT IN (SELECT event FROM delivery_events) ORDER BY ord, id LIMIT ?', runKeyText, limit)
  }

  // Where the run's messages go now: its binding (which follows moves), or
  // the workflow's channel and the run's topic.
  private destination(r: RunRow): Destination | null {
    if (r.kind === 'io' && !r.stream_id) {
      const t = this.all<TargetRow>('SELECT * FROM targets WHERE key = ?', `channel:${r.key.slice(0, -'/io'.length)}`)[0]
      return t?.state === 'provisioned' && t.zulip_id ? { streamId: t.zulip_id, channel: t.name, topic: IO_TOPIC } : null
    }
    if (r.kind === 'delegation' && !r.stream_id) {
      const channel = this.target(`channel:${r.project}/${r.workflow}`)
      return channel?.state === 'provisioned' && r.topic ? { streamId: channel.zulip_id!, channel: channel.name, topic: r.topic } : null
    }
    if (r.stream_id && r.channel && r.topic) return { streamId: r.stream_id, channel: r.channel, topic: r.topic }
    const channel = this.target(`channel:${r.project}/${r.workflow}`)
    return channel?.state === 'provisioned' ? { streamId: channel.zulip_id!, channel: channel.name, topic: topicName(r.run) } : null
  }

  private async claimRun(r: RunRow, s: Sender, cfg: NotifyConfig, at: Date): Promise<Delivery | null> {
    const current = this.active(r.key)
    if (current) {
      if (current.state === 'unresolved') return null // reported by problems()
      // Its events were sent by something else meanwhile (a release rolled
      // back to and forward again): recorded, never sent a second time.
      const members = JSON.parse(current.events) as string[]
      const elsewhere = this.all<OutboxRow>(`SELECT * FROM outbox WHERE id IN (SELECT value FROM json_each(?)) AND state = 'sent'`, current.events)
      if (current.kind === 'message' && elsewhere.length) {
        const ids = [...new Set(elsewhere.map(o => o.message_id))]
        const t = now()
        if (elsewhere.length === members.length && ids.length === 1 && ids[0] !== null) {
          this.run(`UPDATE deliveries SET state = 'sent', message_id = ?, sent_at = ?, claim = NULL, checked = 'its events were recorded as sent outside this delivery', updated = ? WHERE id = ? AND state = ?`, ids[0], t, t, current.id, current.state)
          return null
        }
        this.run(`UPDATE deliveries SET state = 'unresolved', claim = NULL, problem = ?, updated = ? WHERE id = ? AND state = ?`,
          `${elsewhere.length} of its ${members.length} event(s) were recorded as sent outside this delivery (messages ${ids.join(', ')}); check the topic, then \`wfe notify resolve ${current.id}\``, t, current.id, current.state)
        return null
      }
      if (current.state === 'failed' && current.next_try && Date.parse(current.next_try) > at.getTime()) return null
      const dest = this.destination(r) ?? (current.stream_id ? { streamId: current.stream_id, channel: current.channel!, topic: current.topic! } : null)
      if (!dest) return null
      const claim = `c${randomBytes(6).toString('hex')}`
      const n = this.run(`UPDATE deliveries SET claim = ?, owner = ?, state = CASE WHEN state = 'sending' THEN 'failed' ELSE state END,
        uncertain = CASE WHEN state = 'sending' THEN 1 ELSE uncertain END, updated = ? WHERE id = ? AND state = ? AND coalesce(claim, '') = ?`,
      claim, s.owner, now(), current.id, current.state, current.claim ?? '').changes
      if (!Number(n)) return null // changed meanwhile; the next pass sees it
      return this.handOut(this.one<DeliveryRow>('SELECT * FROM deliveries WHERE id = ?', current.id)!, r, dest)
    }
    // A new delivery from the run's next events, with the batching rules:
    // adjacent routine events go together (up to six, and only up to one
    // that waits for publication); a critical event, a publication notice
    // or a published follow-up alone.
    const rows = this.unassigned(r.key)
    if (!rows.length) return null
    const dest = this.destination(r)
    if (!dest) return null // the channel comes first; the outbox waits
    const pending = this.publicationPending(r)
    const waits = (o: OutboxRow) => { const ev = JSON.parse(o.event) as { document?: string; at?: string }; return !!ev.document && pending && at.getTime() - Date.parse(ev.at ?? o.created) < (o.critical ? 90_000 : 20 * 60_000) }
    // A message about a document waits a little for its publication, so it
    // can carry a working link: routine ones while the attempt is open,
    // questions and blockers hardly at all.
    if (waits(rows[0])) return null
    const batch: OutboxRow[] = [rows[0]]
    const alone = (o: OutboxRow) => !!o.critical || o.type === 'publication' || o.type === 'published'
    if (!alone(rows[0])) for (const o of rows.slice(1, 6)) { if (alone(o) || waits(o)) break; batch.push(o) }
    const rendered = await this.render(r, batch, cfg, at)
    const claim = `c${randomBytes(6).toString('hex')}`
    const id = this.tx(() => {
      // The selection still holds: nothing else became active, the same
      // events are still the run's next, the binding has not changed.
      if (this.active(r.key)) return null
      const again = this.unassigned(r.key, batch.length).map(o => o.id)
      if (again.join('\n') !== batch.map(o => o.id).join('\n')) return null
      const r2 = this.one<RunRow>('SELECT * FROM runs WHERE key = ?', r.key)
      const d2 = r2 && !r2.problem ? this.destination(r2) : null
      if (!d2 || !sameDest(d2, dest)) return null
      const t = now()
      // An event queued again after its row was lost (p8 ex1) may have gone
      // out already: its delivery looks for its marker since the event first.
      const unsure = batch.filter(o => o.uncertain)
      const since = unsure.length ? unsure.map(o => (JSON.parse(o.event) as { at?: string }).at ?? o.created).sort()[0] : null
      const did = Number(this.run(`INSERT INTO deliveries (run_key, kind, ord, events, content, marker, unpublished, stream_id, channel, topic, tried, state, claim, owner, created, updated, uncertain, first_began)
        VALUES (?, 'message', ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'ready', ?, ?, ?, ?, ?, ?)`, r.key, batch[0].ord, JSON.stringify(batch.map(o => o.id)), rendered.content, rendered.marker,
      rendered.unpublished.length ? JSON.stringify(rendered.unpublished) : null, dest.streamId, dest.channel, dest.topic, claim, s.owner, t, t, unsure.length ? 1 : 0, since).lastInsertRowid)
      batch.forEach((o, i) => this.run('INSERT INTO delivery_events (event, delivery, pos) VALUES (?, ?, ?)', o.id, did, i))
      return did
    })
    if (id === null) return null
    return this.handOut(this.one<DeliveryRow>('SELECT * FROM deliveries WHERE id = ?', id)!, r, dest)
  }

  private handOut(d: DeliveryRow, r: RunRow, dest: Destination): Delivery {
    const events = JSON.parse(d.events) as string[]
    const label = runKey({ workflow: r.workflow, run: r.kind === 'request' ? r.bound ?? r.run : r.run })
    let reconcile: Delivery['reconcile'] = null
    if (d.uncertain || d.kind === 'legacy') {
      const places: Destination[] = [dest, ...(d.stream_id ? [{ streamId: d.stream_id, channel: d.channel!, topic: d.topic! }] : []), ...(JSON.parse(d.tried) as Destination[]),
        ...this.all<{ stream_id: number; channel: string; topic: string }>('SELECT * FROM relocations WHERE run_key = ? ORDER BY id', r.key).map(x => ({ streamId: x.stream_id, channel: x.channel, topic: x.topic }))]
      const searchIn = places.filter((p, i) => places.findIndex(q => sameDest(p, q)) === i)
      // Nothing of this delivery can have been posted before its events
      // existed, nor (once begun) before its first send began.
      const since = d.kind === 'legacy' ? (this.one<{ t: string }>(`SELECT min(created) AS t FROM outbox WHERE id IN (SELECT value FROM json_each(?))`, d.events)?.t ?? d.created) : (d.first_began ?? d.created)
      reconcile = { since, searchIn, label, ...(d.kind === 'legacy' ? { tokens: events.map(ev => ({ event: ev, token: markerToken(ev) })) } : {}) }
    }
    return { delivery: d.id, claim: d.claim!, run: d.run_key, kind: d.kind, events, content: d.content ?? '', marker: d.marker ?? '', destination: dest, lastMessageId: r.last_message_id, attempts: d.attempts, reconcile }
  }

  private async workspaceOf(r: RunRow): Promise<Workspace | null> {
    const w = (await loadRegistry(this.registryFile)).workspaces.find(x => x.id === r.workspace)
    return w ? new Workspace(w) : null
  }

  private async render(r: RunRow, batch: OutboxRow[], cfg: NotifyConfig, at: Date): Promise<{ content: string; marker: string; unpublished: string[] }> {
    if (r.kind === 'delegation') return this.renderDelegation(batch[0], cfg)
    if (r.kind === 'io') {
      const ev = JSON.parse(batch[0].event) as { text: string }
      const marker = `ref io ${r.workflow}/${r.run} ${markerToken(batch[0].id)}`
      return { content: `${ev.text}\n${marker}`, marker, unpublished: [] }
    }
    const ws = await this.workspaceOf(r)
    const inRequest = r.kind === 'request'
    const runId = inRequest ? r.bound : r.run
    const ref = { workflow: r.workflow, run: runId ?? r.run }
    const reading = ws && runId ? await readRun(ws, ref) : undefined
    const rec = reading?.record
    const authored = rec ? reading!.bundle.entries[rec.definition.root]?.workflow : undefined
    const label = runKey(ref)
    // The run's documents and commits are in its own copy (p9).
    const space = ws && runId ? await runSpace(ws, ref).catch(() => null) : null
    const links = space ? await this.links(space, ref) : new Map<string, DocLink>()
    const marker = `ref ${label} ${batch.map(o => markerToken(o.id)).join(' ')}`
    // The run's IO channel now (p10): its link, or that it is being set up.
    const ioState = rec && this.ioOf(cfg) ? this.ioStatus(rec) : null
    // Each delegation's child, followed where it lives (p10).
    const children = new Map<string, { conversation?: string; progress?: string; io?: string; run?: string }>()
    for (const d of Object.values(rec?.delegations ?? {})) {
      if (!d.child) continue
      const cref = { workflow: d.child.workflow, run: d.child.run }
      const st = this.runStatus(d.child.project, cref)
      const w = (await loadRegistry(this.registryFile)).workspaces.find(x => x.id === d.child!.workspace)
      const crec = w ? (await readRun(await runSpace(new Workspace(w), cref), cref).catch(() => null))?.record : undefined
      const cio = crec ? this.ioStatus(crec) : null
      children.set(d.id, {
        ...(st.request?.url ? { conversation: st.request.url } : {}), ...(st.topic?.url ? { progress: st.topic.url } : {}), ...(cio?.url ? { io: cio.url } : {}),
        ...(cfg.viewBase ? { run: `${cfg.viewBase.replace(/\/?$/, '/')}#/ws/${encodeURIComponent(d.child.workspace)}/run/${encodeURIComponent(cref.workflow)}/${encodeURIComponent(cref.run)}` } : {}),
      })
    }
    if (batch[0].type === 'io-ready') {
      const content = ioState?.url ? `**Detailed IO** of run ${label} is ready: ${ioState.url} — the agent's messages, tool calls and results, attempt by attempt.\n${marker}` : `**Detailed IO** of run ${label} could not be set up${ioState?.problem ? `: ${ioState.problem}` : ''}.\n${marker}`
      return { content, marker, unpublished: [] }
    }
    if (batch[0].type === 'notice') {
      const e = JSON.parse(batch[0].event) as { kind: NoticeKind; post: number; stream: number; topic: string; classification: null; text: string }
      const content = renderNotice({ kind: e.kind, post: messageUrl(cfg.zulipUrl, e.stream, r.channel ?? '', e.topic, e.post), classification: e.classification, detail: e.text, ref: label, executor: rec?.executor.name ?? 'the agent', marker })
      return { content, marker, unpublished: [] }
    }
    // The two conversations link to each other (p6).
    const req = rec ? this.intake?.requestOfRun(rec.project, rec) : undefined
    const runRow = rec ? this.one<RunRow>('SELECT * FROM runs WHERE key = ?', `${rec.project}/${rec.workflow}/${rec.run}`) : undefined
    const channelTarget = this.target(`channel:${r.project}/${r.workflow}`)
    const runTopic = runRow?.stream_id && runRow.topic ? topicUrl(cfg.zulipUrl, runRow.stream_id, runRow.channel ?? '', runRow.topic)
      : channelTarget?.zulip_id && runId ? topicUrl(cfg.zulipUrl, channelTarget.zulip_id, channelTarget.name, topicName(runId)) : undefined
    const reqRow = req ? this.one<RunRow>('SELECT * FROM runs WHERE key = ?', `${req.project}/${req.workflow}/${req.key}`) : undefined
    const requestTopic = reqRow?.stream_id && reqRow.topic ? topicUrl(cfg.zulipUrl, reqRow.stream_id, reqRow.channel ?? '', reqRow.topic) : undefined
    const unpublished: string[] = []
    const link = (path: string): DocLink => {
      const l = links.get(path) ?? { path, name: path.split('/').pop()! }
      if (!l.url && !l.commit) unpublished.push(path)
      return l
    }
    // The run itself, also from its request topic (whose row is keyed by the request).
    const runView = cfg.viewBase ? `${cfg.viewBase.replace(/\/?$/, '/')}#/ws/${encodeURIComponent(r.workspace)}/run/${encodeURIComponent(r.workflow)}/${encodeURIComponent(ref.run)}` : undefined
    const answerRoute = (q: string) => inRequest
      ? `reply in this topic — quote this message, or start your reply with \`${q || 'q<n>'}:\`.`
      : req && requestTopic ? `in the request topic: ${requestTopic}`
        : runView ? `[agdevworld run view](${runView})` : `in agdevworld's run view on the execution host (no remote address is configured), or \`wfe run answer ${label} ${q || '<question>'} --answer … --by <name>\` there`
    const request = rec && space ? await readFile(join(space.root, runDir(ref), rec.input.file), 'utf8').then(t => t.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '', () => '') : ''
    const nextOf = (): string | undefined => {
      if (!rec) return undefined
      const ex = rec.execution
      if (ex.waiting.length) return ex.waiting.map(w => `${w.node} waits for ${w.holder}`).join('; ')
      if (ex.ready.length) return `${rec.executor.name}: ${ex.ready.map(id => effectiveOf(rec)?.nodes[id]?.step?.purpose ?? id).join(', ')}`
      return undefined
    }
    // Where each presentation is served now (p7): resolved from this host's
    // present store when the message is rendered, frozen with the delivery.
    const addresses = new Map<string, { url: string; local: boolean; live: boolean } | null>()
    if (rec?.presentations) {
      const { Presenter } = await import('./present.ts')
      let pr: InstanceType<typeof Presenter> | null = null
      try { pr = new Presenter({ area: this.area, registryFile: this.registryFile }) } catch { pr = null }
      try { for (const p of Object.values(rec.presentations)) addresses.set(p.id, pr ? await pr.address(p.instance).catch(() => null) : null) } finally { pr?.close() }
    }
    const ctx: RenderContext = {
      presentation: id => addresses.get(id) ?? null,
      // p17: a human review round's page on this host's editor.
      review: id => cfg.viewBase ? `${cfg.viewBase.replace(/\/?$/, '/')}#/ws/${encodeURIComponent(r.workspace)}/review/${encodeURIComponent(r.workflow)}/${encodeURIComponent(ref.run)}/${encodeURIComponent(id)}` : null,
      openPresentations: rec ? openPresentations(rec).map(p => p.id) : [],
      ref: label, executor: rec?.executor.name ?? 'the executor', request, answerRoute, runLink: runView, link,
      label: id => authored?.nodes[id]?.name || id, openQuestion: id => !!rec?.questions[id] && ['open', 'answered'].includes(questionState(rec.questions[id])),
      now: at, next: nextOf(), person: cfg.person,
      conversation: inRequest ? 'request' : 'run', runTopic: inRequest ? runTopic : undefined, requestTopic: inRequest ? undefined : requestTopic,
      decision: rec?.decisions.length ? (d => ({ decision: d.decision, by: d.by, question: d.confirmation?.question, from: d.confirmation?.from }))(rec.decisions.at(-1)!) : undefined,
      ...(ioState && ioState.state !== 'disabled' ? { io: ioState.url ?? 'pending' } : {}),
      child: id => children.get(id) ?? null,
    }
    const events = batch.map(o => JSON.parse(o.event) as NotableEvent & { checkpoint?: number; state?: string; detail?: string; docs?: string[] })
    let content: string
    if (batch[0].type === 'publication') {
      const e = events[0]
      content = renderPublication(label, e.state as 'failed' | 'attention' | 'recovered', e.detail ?? '', e.checkpoint!)
    } else if (batch[0].type === 'published') {
      const e = events[0]
      const docs = (e.docs ?? []).map(p => links.get(p) ?? { path: p, name: p.split('/').pop()! })
      const commit = docs.find(d => d.commit)?.commit ?? ''
      content = renderPublished(label, docs, commit, markerToken(batch[0].id))
    } else {
      const oldest = events[0].at
      const delayed = at.getTime() - Date.parse(oldest) > DELAYED_AFTER_MS
      content = renderMessage(events, ctx, { marker, ...(delayed ? { delayedFrom: oldest } : {}) })
    }
    // Which documents this message had to call unpublished: a later
    // published checkpoint answers them with one availability update.
    return { content, marker: content.split('\n').at(-1)!, unpublished: [...new Set(unpublished)] }
  }

  // A delegation post (p10): the words come from the parent's record — the
  // dispatched request.md (checked by hash), or the recorded answer or
  // instruction — never from anything typed into Zulip.
  private async renderDelegation(o: OutboxRow, cfg: NotifyConfig): Promise<{ content: string; marker: string; unpublished: string[] }> {
    const ev = JSON.parse(o.event) as DelegationOutEvent
    const w = (await loadRegistry(this.registryFile)).workspaces.find(x => x.id === ev.parent.workspace)
    if (!w) throw new Error(`the delegating run's workspace ${ev.parent.workspace} is not registered`)
    const ws = new Workspace(w)
    const ref = { workflow: ev.parent.workflow, run: ev.parent.run }
    const space = await runSpace(ws, ref)
    const rec = (await readRun(space, ref)).record
    const d = rec?.delegations?.[ev.delegation]
    if (!rec || !d) throw new Error(`delegation ${ev.uid} cannot be read from its run`)
    const marker = `ref ${runKey(ref)} ${markerToken(o.id)}`
    const parentLink = cfg.viewBase ? `${cfg.viewBase.replace(/\/?$/, '/')}#/ws/${encodeURIComponent(ev.parent.workspace)}/run/${encodeURIComponent(ref.workflow)}/${encodeURIComponent(ref.run)}` : undefined
    const base = { by: rec.executor.name, parent: `${rec.project}/${runKey(ref)}`, node: d.node, onBehalfOf: d.onBehalfOf, parentLink, marker }
    if (ev.type === 'delegation-request') {
      const text = await readFile(join(space.root, d.request.path), 'utf8')
      return { content: renderDelegationPost({ ...base, kind: 'request', from: rec.executor.name, text }), marker, unpublished: [] }
    }
    if (ev.type === 'delegation-revision') {
      const r = d.revisions?.find(a => a.n === ev.index)
      if (!r) throw new Error(`delegation ${ev.uid} has no correction request ${ev.index}`)
      return { content: renderDelegationPost({ ...base, kind: 'revision', from: r.from, by: r.by, text: r.instruction, reason: r.reason, result: r.event }), marker, unpublished: [] }
    }
    const item = ev.type === 'delegation-answer' ? d.answers.find(a => a.n === ev.index) : d.instructions.find(a => a.n === ev.index)
    if (!item) throw new Error(`delegation ${ev.uid} has no ${ev.type === 'delegation-answer' ? 'answer' : 'instruction'} ${ev.index}`)
    return { content: renderDelegationPost({ ...base, kind: ev.type === 'delegation-answer' ? 'answer' : 'instruction', from: item.from, by: item.by, text: item.text, question: ev.question }), marker, unpublished: [] }
  }

  // Commit-addressed links for the run's documents: the newest published
  // checkpoint commit of the repository that owns devdocs in which the file
  // exists. Gitea web links for http(s) remotes; the commit alone otherwise.
  async links(ws: Workspace, ref: RunRef): Promise<Map<string, DocLink>> {
    const out = new Map<string, DocLink>()
    const info = await ws.devdocs()
    const repo = info.owner === 'devdocs' ? 'devdocs' : '.'
    const commits = this.checkpoints(ws.reg.id, ref).filter(c => c.state === 'published' || c.state === 'attention')
      .flatMap(c => (JSON.parse(c.steps) as { repo: string; commit?: string; pushed?: boolean }[]).filter(s => s.repo === repo && s.commit && s.pushed).map(s => s.commit!)).reverse()
    const origin = (await git(info.ownerDir, ['remote', 'get-url', 'origin'])).stdout.trim()
    const web = /^https?:\/\//.test(origin) ? origin.replace(/\/\/[^@/]*@/, '//').replace(/\.git$/, '') : null
    const dir = runDir(ref)
    const names = (await git(info.ownerDir, ['ls-files', '--', `${info.prefix}${dir.slice('devdocs/'.length)}`])).stdout.split('\n').filter(Boolean)
    for (const inRepo of names) {
      const path = `devdocs/${inRepo.slice(info.prefix.length)}`
      for (const c of commits) {
        if ((await git(info.ownerDir, ['cat-file', '-e', `${c}:${inRepo}`])).code !== 0) continue
        out.set(path, { path, name: path.split('/').pop()!, commit: c, url: web ? `${web}/src/commit/${c}/${inRepo}` : undefined, raw: web ? `${web}/raw/commit/${c}/${inRepo}` : undefined })
        break
      }
    }
    return out
  }

  // ---- results from the transport --------------------------------------------------------

  // The delivery a result is about, checked: it exists, the claim is the
  // one it holds now and the current sender's, and the events named are its
  // events in its order. Anything else is a stale or unrelated update.
  private held(id: number, claim: string, events: string[] | undefined): DeliveryRow {
    const d = this.one<DeliveryRow>('SELECT * FROM deliveries WHERE id = ?', id)
    if (!d) throw new RequestError(404, `no delivery ${id}`)
    if (events && JSON.stringify(events) !== d.events) throw new RequestError(409, `delivery ${id} carries ${d.events}, not ${JSON.stringify(events)}`)
    if (d.claim !== claim) throw new RequestError(409, `delivery ${id} is not held by claim ${claim} (${d.claim ? 'claimed again since' : d.state === 'sent' ? 'already sent' : 'not claimed'}); this result is stale`)
    const owner = this.sender()
    if (!owner || owner.owner !== d.owner) throw new RequestError(409, `delivery ${id} was claimed by ${d.owner}, which is no longer the sender`)
    return d
  }

  // Recorded before the POST: from here until a result is recorded the
  // delivery may have been posted. A delivery that may already have been
  // posted is begun again only with the evidence that it was not.
  begin(id: number, claim: string, o: { destination: Destination; checkedAbsent?: string; events?: string[] }) {
    this.tx(() => {
      const d = this.held(id, claim, o.events)
      if (d.kind !== 'message') throw new RequestError(409, `delivery ${id} is a legacy reconciliation; it is never posted as such`)
      if (!['ready', 'failed'].includes(d.state)) throw new RequestError(409, `delivery ${id} is ${d.state}; only a ready or failed delivery is begun`)
      if (d.uncertain && !o.checkedAbsent?.trim()) throw new RequestError(409, `delivery ${id} may already have been posted; search for its marker first and pass what established its absence (--checked-absent)`)
      const tried = JSON.parse(d.tried) as Destination[]
      if (!tried.some(t => sameDest(t, o.destination))) tried.push(o.destination)
      const t = now()
      this.run('UPDATE deliveries SET state = \'sending\', attempts = attempts + 1, first_began = coalesce(first_began, ?), tried = ?, uncertain = 0, checked = coalesce(?, checked), updated = ? WHERE id = ?',
        t, JSON.stringify(tried), o.checkedAbsent ?? null, t, id)
    })
  }

  // The message is in Zulip: posted now, or found by its marker. The
  // delivery and all its events are sent, and the run follows where it is.
  // The same acknowledgment again is harmless; a different one is refused.
  acknowledge(id: number, claim: string, o: { messageId: number; destination: Destination; found?: boolean; events?: string[] }): 'recorded' | 'already recorded' {
    return this.tx(() => {
      const prior = this.one<DeliveryRow>('SELECT * FROM deliveries WHERE id = ?', id)
      if (prior?.state === 'sent') {
        if (prior.message_id === o.messageId && (!o.events || JSON.stringify(o.events) === prior.events)) return 'already recorded'
        throw new RequestError(409, `delivery ${id} is already recorded as message ${prior.message_id}, not ${o.messageId}`)
      }
      const d = this.held(id, claim, o.events)
      if (d.kind !== 'message') throw new RequestError(409, `delivery ${id} is a legacy reconciliation; record what was found with \`wfe notify legacy\``)
      if (d.state !== 'sending' && !o.found) throw new RequestError(409, `delivery ${id} was not begun; only a message found by its marker is recorded without a begin`)
      const t = now()
      this.run('UPDATE deliveries SET state = \'sent\', message_id = ?, sent_at = ?, claim = NULL, uncertain = 0, last_error = NULL, next_try = NULL, problem = NULL, checked = CASE WHEN ? THEN coalesce(checked, \'\') || \'found by its marker\' ELSE checked END, updated = ? WHERE id = ?',
        o.messageId, t, o.found ? 1 : 0, t, id)
      this.markSent(JSON.parse(d.events) as string[], o.messageId, t)
      this.bind(d.run_key, o.destination, o.messageId, t)
      return 'recorded'
    })
  }

  private markSent(events: string[], messageId: number, t: string) {
    for (const e of events) this.run('UPDATE outbox SET state = \'sent\', message_id = ?, sent_at = ?, uncertain = 0, last_error = NULL, next_try = NULL WHERE id = ?', messageId, t, e)
  }

  private bind(runKeyText: string, dest: Destination, messageId: number, t: string) {
    this.run('UPDATE runs SET stream_id = ?, channel = ?, topic = ?, last_message_id = max(coalesce(last_message_id, 0), ?), updated = ? WHERE key = ?', dest.streamId, dest.channel, dest.topic, messageId, t, runKeyText)
  }

  // A failed attempt is retried later with the same delivery. `uncertain`:
  // the request went out and its answer was lost, so the next attempt looks
  // first. A failure that posted nothing keeps what was known before.
  fail(id: number, claim: string, error: string, uncertain: boolean, o: { events?: string[]; at?: Date } = {}) {
    const at = o.at ?? new Date()
    this.tx(() => {
      const d = this.held(id, claim, o.events)
      if (!['ready', 'sending', 'failed'].includes(d.state)) throw new RequestError(409, `delivery ${id} is ${d.state}`)
      const failures = d.failures + 1
      const still = uncertain || (d.state !== 'sending' && !!d.uncertain)
      this.run('UPDATE deliveries SET state = \'failed\', failures = ?, last_error = ?, uncertain = ?, next_try = ?, claim = NULL, updated = ? WHERE id = ?',
        failures, error.slice(0, 500), still ? 1 : 0, new Date(at.getTime() + BACKOFF(failures)).toISOString(), now(), id)
    })
  }

  // A legacy reconciliation's result: the posts found name the events they
  // carried; those are sent. When the search covered everything the rest
  // were never posted and go out with the new batching. An incomplete
  // search keeps the rest uncertain.
  legacy(id: number, claim: string, o: { found: { event: string; messageId: number; destination: Destination }[]; complete: boolean; error?: string }) {
    this.tx(() => {
      const d = this.held(id, claim, undefined)
      if (d.kind !== 'legacy') throw new RequestError(409, `delivery ${id} is not a legacy reconciliation`)
      const members = new Set(JSON.parse(d.events) as string[])
      const t = now()
      for (const f of o.found) {
        if (!members.has(f.event)) throw new RequestError(409, `${f.event} is not part of delivery ${id}`)
        this.markSent([f.event], f.messageId, t)
        this.bind(d.run_key, f.destination, f.messageId, t)
      }
      if (o.complete) {
        const unsent = [...members].filter(e => this.one<OutboxRow>('SELECT * FROM outbox WHERE id = ?', e)?.state !== 'sent')
        for (const e of unsent) this.run('DELETE FROM delivery_events WHERE event = ? AND delivery = ?', e, id)
        this.run('UPDATE deliveries SET state = \'resolved\', claim = NULL, uncertain = 0, checked = ?, problem = NULL, updated = ? WHERE id = ?',
          `${o.found.length} event(s) found posted; ${unsent.length} not posted (searched completely), sent again in new deliveries: ${unsent.join(', ') || 'none'}`, t, id)
      } else {
        const failures = d.failures + 1
        this.run('UPDATE deliveries SET state = \'failed\', failures = ?, last_error = ?, next_try = ?, claim = NULL, updated = ? WHERE id = ?',
          failures, (o.error ?? 'the search could not establish which events were posted').slice(0, 500), new Date(Date.now() + BACKOFF(failures)).toISOString(), t, id)
      }
    })
  }

  // A person's reconciliation, for what the transport cannot establish: the
  // message they found (it is recorded as sent), or that it is not in Zulip
  // (the same payload goes out again).
  resolve(id: number, o: { messageId: number } | { notPosted: true }, by: string): string {
    return this.tx(() => {
      const d = this.one<DeliveryRow>('SELECT * FROM deliveries WHERE id = ?', id)
      if (!d) throw new RequestError(404, `no delivery ${id}`)
      if (!['failed', 'unresolved', 'ready', 'sending'].includes(d.state)) throw new RequestError(409, `delivery ${id} is ${d.state}`)
      const owner = this.sender()
      if (d.state === 'sending' && owner && owner.host === hostname() && alive(owner.pid)) throw new RequestError(409, `delivery ${id} is being sent by ${owner.owner} (pid ${owner.pid}); wait for its result`)
      const t = now()
      if ('messageId' in o) {
        if (d.kind === 'legacy') {
          for (const e of JSON.parse(d.events) as string[]) this.markSent([e], o.messageId, t)
          this.run('UPDATE deliveries SET state = \'resolved\', claim = NULL, uncertain = 0, checked = ?, problem = NULL, updated = ? WHERE id = ?', `resolved by ${by}: posted as message ${o.messageId}`, t, id)
        } else {
          this.run('UPDATE deliveries SET state = \'sent\', message_id = ?, sent_at = ?, claim = NULL, uncertain = 0, problem = NULL, checked = ?, updated = ? WHERE id = ?', o.messageId, t, `resolved by ${by}: posted as message ${o.messageId}`, t, id)
          this.markSent(JSON.parse(d.events) as string[], o.messageId, t)
        }
        return `delivery ${id} recorded as message ${o.messageId}`
      }
      if (d.kind === 'legacy') {
        this.run('DELETE FROM delivery_events WHERE delivery = ? AND event IN (SELECT id FROM outbox WHERE state != \'sent\')', id)
        this.run('UPDATE deliveries SET state = \'resolved\', claim = NULL, uncertain = 0, checked = ?, problem = NULL, updated = ? WHERE id = ?', `resolved by ${by}: not posted; its events go out again`, t, id)
        return `delivery ${id}: its unsent events go out in new deliveries`
      }
      this.run('UPDATE deliveries SET state = \'failed\', claim = NULL, uncertain = 0, next_try = NULL, problem = NULL, checked = ?, updated = ? WHERE id = ?', `resolved by ${by}: not posted`, t, id)
      return `delivery ${id} goes out again as it was frozen`
    })
  }

  // The pre-p5/ex1 transport's record of a send in flight (one per
  // transport, so another run's could be lost): its events join their run's
  // legacy reconciliation, before any new delivery could carry them.
  importInflight(o: { ids: string[]; marker?: string }): string[] {
    return this.tx(() => {
      const notes: string[] = []
      const byRun = new Map<string, OutboxRow[]>()
      for (const id of o.ids) {
        const row = this.one<OutboxRow>('SELECT * FROM outbox WHERE id = ?', id)
        if (!row) { notes.push(`${id}: not in the outbox; ignored`); continue }
        if (row.state === 'sent') { notes.push(`${id}: already recorded as sent`); continue }
        const owner = this.one<{ delivery: number }>('SELECT delivery FROM delivery_events WHERE event = ?', id)
        if (owner) {
          const d = this.one<DeliveryRow>('SELECT * FROM deliveries WHERE id = ?', owner.delivery)!
          if (d.kind !== 'legacy') throw new RequestError(409, `${id} is already part of delivery ${d.id}, frozen after the migration; the in-flight record cannot be reconciled automatically — check the topic, then \`wfe notify resolve ${d.id}\``)
          notes.push(`${id}: already part of legacy reconciliation ${d.id}`); continue
        }
        byRun.set(row.run_key, [...(byRun.get(row.run_key) ?? []), row])
      }
      for (const [run, rows] of byRun) {
        this.run('UPDATE outbox SET uncertain = 1 WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(rows.map(r => r.id)))
        const current = this.active(run)
        if (current && current.kind === 'legacy') {
          const events = [...JSON.parse(current.events) as string[], ...rows.map(r => r.id)]
          rows.forEach((r, i) => this.run('INSERT INTO delivery_events (event, delivery, pos) VALUES (?, ?, ?)', r.id, current.id, events.length - rows.length + i))
          this.run('UPDATE deliveries SET events = ?, ord = min(ord, ?), marker = coalesce(marker, ?), updated = ? WHERE id = ?', JSON.stringify(events), Math.min(...rows.map(r => r.ord)), o.marker ?? null, now(), current.id)
          notes.push(`${rows.map(r => r.id).join(', ')}: joined legacy reconciliation ${current.id}`)
        } else if (current) {
          throw new RequestError(409, `run ${run} already has delivery ${current.id} in progress; the in-flight events ${rows.map(r => r.id).join(', ')} need a person: check the topic, then \`wfe notify resolve ${current.id}\``)
        } else {
          const id = legacyDelivery(this.db, run, rows.map(r => r.id), Math.min(...rows.map(r => r.ord)), `pre-p5/ex1 send in flight (inflight.json${o.marker ? `, marker "${o.marker}"` : ''}); the topic is searched for it before anything else of this run is sent`, now())
          if (o.marker) this.run('UPDATE deliveries SET marker = ? WHERE id = ?', o.marker, id)
          notes.push(`${rows.map(r => r.id).join(', ')}: legacy reconciliation ${id}`)
        }
      }
      return notes
    })
  }

  // The topic a run's messages go to moved (renamed, or moved to another
  // channel by a person): follow it, keeping the run's identity and where
  // it was before.
  recordMoved(runKeyText: string, o: Destination & { reason?: string }) {
    this.tx(() => {
      const r = this.one<RunRow>('SELECT * FROM runs WHERE key = ?', runKeyText)
      if (!r) throw new RequestError(404, `no run ${runKeyText}`)
      const t = now()
      if (r.stream_id && r.channel && r.topic) this.run('INSERT INTO relocations (run_key, stream_id, channel, topic, reason, at) VALUES (?, ?, ?, ?, ?, ?)', runKeyText, r.stream_id, r.channel, r.topic, `left for #${o.streamId} › ${o.topic}${o.reason ? `: ${o.reason}` : ''}`, t)
      this.run('UPDATE runs SET stream_id = ?, channel = ?, topic = ?, updated = ? WHERE key = ?', o.streamId, o.channel, o.topic, t, runKeyText)
    })
  }

  recordRunProblem(runKeyText: string, problem: string) {
    this.run('UPDATE runs SET problem = ?, updated = ? WHERE key = ?', problem, now(), runKeyText)
  }

  // Which request-topic message carried a question (p6 step 6 delivers
  // questions to the request topic); until then, none.
  postedLookup(): (requestKey: string, ref: RunRef, question: string) => number | null {
    return (requestKey, ref, question) => this.one<{ message_id: number }>(
      `SELECT message_id FROM outbox WHERE run_key LIKE ? AND type = 'question' AND state = 'sent' AND id LIKE ? AND json_extract(event, '$.question') = ? ORDER BY message_id LIMIT 1`,
      `%/${ref.workflow}/${requestKey}`, `%/${ref.workflow}/${ref.run}#%${REQUEST_SUFFIX}`, question)?.message_id ?? null
  }

  // ---- views -----------------------------------------------------------------------------

  runStatus(project: string, ref: RunRef): { configured: boolean; problem?: string; skipped?: string; topic?: { url: string | null; channel: string; topic: string }; request?: { url: string | null; channel: string; topic: string }; pending: number; failed: number; uncertain: boolean; lastError?: string; lastSent?: string; provisioning?: string; viewBase: string | null } {
    const cfg = this.config()
    if (!cfg || 'problem' in cfg || !cfg.enabled) return { configured: false, problem: cfg && 'problem' in cfg ? cfg.problem : undefined, pending: 0, failed: 0, uncertain: false, viewBase: null }
    const key = `${project}/${ref.workflow}/${ref.run}`
    const r = this.one<RunRow>('SELECT * FROM runs WHERE key = ?', key)
    const t = this.target(`channel:${project}/${ref.workflow}`), f = this.target(`folder:${project}`)
    const pending = this.one<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE run_key = ? AND state != \'sent\'', key)?.n ?? 0
    const d = this.active(key)
    const last = this.one<OutboxRow>('SELECT * FROM outbox WHERE run_key = ? AND state = \'sent\' ORDER BY sent_at DESC LIMIT 1', key)
    const provisioning = [f, t].find(x => x?.state === 'problem')?.problem ?? ([f, t].some(x => !x || x.state === 'pending') ? 'the channel is not provisioned yet' : undefined)
    const rq = this.one<RunRow>('SELECT * FROM runs WHERE kind = \'request\' AND project = ? AND workflow = ? AND bound = ?', project, ref.workflow, ref.run)
    return {
      ...(rq?.stream_id && rq.topic ? { request: { url: topicUrl(cfg.zulipUrl, rq.stream_id, rq.channel ?? '', rq.topic), channel: rq.channel ?? '', topic: rq.topic } } : {}),
      configured: true, problem: r?.problem ?? (d?.state === 'unresolved' ? `delivery ${d.id} needs a person: ${d.problem}` : undefined), skipped: r?.skipped ?? undefined,
      topic: r?.stream_id && r.topic ? { url: topicUrl(cfg.zulipUrl, r.stream_id, r.channel ?? '', r.topic), channel: r.channel ?? '', topic: r.topic } : undefined,
      pending, failed: d && ['failed', 'unresolved'].includes(d.state) ? 1 : 0, uncertain: !!d && (!!d.uncertain || d.state === 'sending'),
      lastError: d?.last_error ?? undefined, lastSent: last?.sent_at ?? undefined, provisioning, viewBase: cfg.viewBase,
    }
  }

  // runStatus with the run's IO channel (p10); the record is read by the caller.
  async runStatusOf(project: string, ws: Workspace, ref: RunRef): Promise<ReturnType<NotifyStore['runStatus']> & { io?: ReturnType<NotifyStore['ioStatus']> }> {
    const st = this.runStatus(project, ref)
    if (!st.configured) return st
    const rec = (await readRun(await runSpace(ws, ref), ref).catch(() => null))?.record
    return rec ? { ...st, io: this.ioStatus(rec) } : st
  }

  overview(): { targets: TargetRow[]; runs: (RunRow & { pending: number; failed: number; uncertain: number })[]; sender: SenderRow | null } {
    return {
      targets: this.all<TargetRow>('SELECT * FROM targets ORDER BY key'),
      runs: this.all<RunRow & { pending: number; failed: number; uncertain: number }>(`SELECT r.*, (SELECT count(*) FROM outbox o WHERE o.run_key = r.key AND o.state != 'sent') AS pending,
        (SELECT count(*) FROM deliveries d WHERE d.run_key = r.key AND d.state IN ('failed', 'unresolved')) AS failed,
        (SELECT count(*) FROM deliveries d WHERE d.run_key = r.key AND d.state IN ${ACTIVE} AND (d.uncertain = 1 OR d.state = 'sending')) AS uncertain FROM runs r ORDER BY key`),
      sender: this.sender() ?? null,
    }
  }

  outbox(runKeyText?: string): (OutboxRow & { delivery: number | null })[] {
    const sql = 'SELECT o.*, e.delivery AS delivery FROM outbox o LEFT JOIN delivery_events e ON e.event = o.id'
    return runKeyText ? this.all(`${sql} WHERE o.run_key = ? ORDER BY o.ord, o.id`, runKeyText) : this.all(`${sql} ORDER BY o.run_key, o.ord, o.id`)
  }

  deliveries(runKeyText?: string): DeliveryRow[] {
    return runKeyText ? this.all<DeliveryRow>('SELECT * FROM deliveries WHERE run_key = ? ORDER BY id', runKeyText) : this.all<DeliveryRow>('SELECT * FROM deliveries ORDER BY id')
  }

  notes(): { at: string; note: string }[] { return this.all('SELECT at, note FROM notes ORDER BY id') }

  relocations(runKeyText: string): { stream_id: number; channel: string; topic: string; reason: string; at: string }[] {
    return this.all('SELECT * FROM relocations WHERE run_key = ? ORDER BY id', runKeyText)
  }
}

function stepProblems(cp: CheckpointRow): string {
  try {
    const steps = JSON.parse(cp.steps) as { repo: string; error?: string; conflicts?: string[] }[]
    return steps.map(s => [s.error, s.conflicts?.length ? `${s.repo}: ${s.conflicts.join(', ')} changed before the run and again by it` : ''].filter(Boolean).join('; ')).filter(Boolean).join('; ') || cp.state
  } catch { return cp.state }
}
