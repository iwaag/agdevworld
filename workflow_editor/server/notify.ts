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
// - outbox: one row per coordination event, keyed by its stable id
//   (<project>/<workflow>/<run>#<seq>:<type>, or a checkpoint's), rebuilt
//   from history whenever it is scanned, so a crash between the record and
//   the queue loses nothing.
//
// The transport (autolab's agautolab.wfnotify, with the existing Zulip
// client) asks `due()` what to do and reports each result; it never decides
// what is notable. Delivery is ordered per run, retried with backoff, and a
// send whose answer was lost is reconciled by its marker before retrying.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  channelDescription, channelName, folderDescription, folderName, renderMessage, renderPublication, renderPublished, topicName, topicUrl,
  DELAYED_AFTER_MS, type DocLink, type RenderContext,
} from '../shared/notify.ts'
import { notableEvents, questionState, runKey, type NotableEvent, type RunRecord, type RunRef } from '../shared/run.ts'
import { assertWorkspaceAllowed, loadBoundary } from './boundary.ts'
import type { CheckpointRow, ExecStore } from './exec.ts'
import { git } from './git.ts'
import { loadRegistry, observe } from './registry.ts'
import { listRuns, readRun, runDir } from './runs.ts'
import { Workspace } from './workspace.ts'

// <area>/zulip.json — system configuration, outside every repository. No
// credentials: the transport holds those.
export interface NotifyConfig {
  enabled: boolean
  zulipUrl: string // the realm's web address, for topic links
  viewBase: string | null // agdevworld's editor as remote readers reach it (…/wfe/); null: none is reachable
  since: string // runs created before this are not announced (no backfill)
  person?: string // who decides results, as messages name them
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
    return { enabled: raw.enabled, zulipUrl: raw.zulipUrl, viewBase: raw.viewBase ?? null, since: raw.since, person: raw.person }
  } catch (e) {
    return { problem: `${file} cannot be read: ${(e as Error).message}` }
  }
}

export interface TargetRow { key: string; kind: 'folder' | 'channel'; project: string; workflow: string | null; name: string; description: string; zulip_id: number | null; state: 'pending' | 'provisioned' | 'problem'; problem: string | null; created: string; updated: string }
export interface RunRow { key: string; project: string; workflow: string; run: string; workspace: string; created: string; scan_seq: number; stream_id: number | null; channel: string | null; topic: string | null; last_message_id: number | null; problem: string | null; skipped: string | null; updated: string }
export interface OutboxRow { id: string; run_key: string; ord: number; type: string; critical: number; event: string; state: 'pending' | 'sent' | 'failed'; attempts: number; next_try: string | null; last_error: string | null; uncertain: number; message_id: number | null; unpublished: string | null; sent_at: string | null; created: string }

// What the transport is asked to do.
export type ProvisionTask =
  | { kind: 'folder'; key: string; name: string; description: string; zulipId: number | null }
  | { kind: 'channel'; key: string; name: string; description: string; zulipId: number | null; folderId: number }
export interface Delivery { ids: string[]; run: string; streamId: number; channel: string; topic: string; lastMessageId: number | null; content: string; marker: string; uncertain: boolean }

const now = () => new Date().toISOString()
const BACKOFF = (attempts: number) => Math.min(15 * 60, 15 * 2 ** Math.max(0, attempts - 1)) * 1000

export class NotifyStore {
  readonly db: DatabaseSync
  readonly area: string
  readonly registryFile: string
  private exec?: ExecStore
  constructor(o: { area: string; registryFile: string; exec?: ExecStore }) {
    this.area = o.area; this.registryFile = o.registryFile; this.exec = o.exec
    const dir = join(o.area, '.local', 'notify')
    mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(join(dir, 'notify.sqlite'))
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS targets (key TEXT PRIMARY KEY, kind TEXT NOT NULL, project TEXT NOT NULL, workflow TEXT, name TEXT NOT NULL, description TEXT NOT NULL,
        zulip_id INTEGER, state TEXT NOT NULL, problem TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (key TEXT PRIMARY KEY, project TEXT NOT NULL, workflow TEXT NOT NULL, run TEXT NOT NULL, workspace TEXT NOT NULL, created TEXT NOT NULL,
        scan_seq INTEGER NOT NULL DEFAULT 0, stream_id INTEGER, channel TEXT, topic TEXT, last_message_id INTEGER, problem TEXT, skipped TEXT, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, run_key TEXT NOT NULL, ord REAL NOT NULL, type TEXT NOT NULL, critical INTEGER NOT NULL, event TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_try TEXT, last_error TEXT, uncertain INTEGER NOT NULL DEFAULT 0, message_id INTEGER,
        unpublished TEXT, sent_at TEXT, created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outbox_run ON outbox (run_key, state, ord);
    `)
  }
  close() { this.db.close() }
  private all<T>(sql: string, ...a: (string | number | null)[]): T[] { return this.db.prepare(sql).all(...a) as T[] }
  private one<T>(sql: string, ...a: (string | number | null)[]): T | undefined { return this.db.prepare(sql).get(...a) as T | undefined }
  private run(sql: string, ...a: (string | number | null)[]) { return this.db.prepare(sql).run(...a) }

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
  // already sent stay where they are.
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
    return notes
  }

  private async scanRun(ws: Workspace, rec: RunRecord, cfg: NotifyConfig): Promise<string[]> {
    const key = `${rec.project}/${rec.workflow}/${rec.run}`
    this.ensureTarget('channel', rec.project, rec.workflow, rec.workflow)
    let row = this.one<RunRow>('SELECT * FROM runs WHERE key = ?', key)
    if (!row) {
      const skipped = Date.parse(rec.created) < Date.parse(cfg.since) ? `created ${rec.created}, before announcements began (${cfg.since}); not backfilled` : null
      this.run('INSERT INTO runs (key, project, workflow, run, workspace, created, skipped, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', key, rec.project, rec.workflow, rec.run, ws.reg.id, rec.created, skipped, now())
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
    const insert = (id: string, ord: number, type: string, critical: boolean, event: unknown) => {
      const r = this.run('INSERT OR IGNORE INTO outbox (id, run_key, ord, type, critical, event, state, created) VALUES (?, ?, ?, ?, ?, ?, \'pending\', ?)', id, key, ord, type, critical ? 1 : 0, JSON.stringify(event), now())
      if (Number(r.changes)) added.push(id)
    }
    if (rec.seq > row.scan_seq) {
      // Events of one entry keep the order the selection gives them.
      let prev = -1, k = 0
      for (const e of notableEvents(rec, row.scan_seq)) { k = e.seq === prev ? k + 1 : 0; prev = e.seq; insert(e.id, e.seq + k * 0.01, e.type, e.critical, e) }
      this.run('UPDATE runs SET scan_seq = ?, updated = ? WHERE key = ?', rec.seq, now(), key)
    }
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
        const waiting = this.all<OutboxRow>('SELECT * FROM outbox WHERE run_key = ? AND state = \'sent\' AND unpublished IS NOT NULL', key)
        if (waiting.length) {
          const docs = [...new Set(waiting.flatMap(o => JSON.parse(o.unpublished!) as string[]))]
          insert(`${cpKey}:published`, ordOf + 0.6, 'published', false, { checkpoint: cp.id, docs, at })
          this.run(`UPDATE outbox SET unpublished = NULL WHERE run_key = ? AND state = 'sent' AND unpublished IS NOT NULL`, key)
        }
      }
    }
    return added.map(id => `queued ${id}`)
  }

  // An attempt of the run is open, or its last checkpoint is not settled.
  private publicationPending(r: RunRow): boolean {
    if (!this.exec) return false
    const open = this.exec.db.prepare('SELECT 1 FROM attempts WHERE workspace = ? AND workflow = ? AND run = ? AND state != \'ended\'').get(r.workspace, r.workflow, r.run)
    const last = this.exec.db.prepare('SELECT state FROM checkpoints WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY id DESC LIMIT 1').get(r.workspace, r.workflow, r.run) as { state?: string } | undefined
    return !!open || last?.state === 'pending'
  }

  private checkpoints(workspace: string, ref: RunRef): CheckpointRow[] {
    if (!this.exec) return []
    return (this.exec.db.prepare('SELECT * FROM checkpoints WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY id').all(workspace, ref.workflow, ref.run) as unknown as CheckpointRow[])
  }

  // ---- what is due -----------------------------------------------------------------------

  async due(at = new Date()): Promise<{ disabled?: string; provision: ProvisionTask[]; deliveries: Delivery[]; problems: string[] }> {
    const cfg = this.config()
    if (!cfg) return { disabled: `no ${join(this.area, 'zulip.json')}: Zulip coordination is not configured`, provision: [], deliveries: [], problems: [] }
    if ('problem' in cfg) return { disabled: cfg.problem, provision: [], deliveries: [], problems: [cfg.problem] }
    if (!cfg.enabled) return { disabled: 'zulip.json: enabled is false', provision: [], deliveries: [], problems: [] }
    await this.scan()
    const problems: string[] = []
    const provision: ProvisionTask[] = []
    for (const t of this.all<TargetRow>('SELECT * FROM targets ORDER BY kind DESC, key')) {
      if (t.state === 'problem') { problems.push(`${t.key}: ${t.problem}`); continue }
      if (t.state === 'provisioned') continue
      if (t.kind === 'folder') provision.push({ kind: 'folder', key: t.key, name: t.name, description: t.description, zulipId: t.zulip_id })
      else {
        const folder = this.target(`folder:${t.project}`)
        if (folder?.state === 'provisioned') provision.push({ kind: 'channel', key: t.key, name: t.name, description: t.description, zulipId: t.zulip_id, folderId: folder.zulip_id! })
      }
    }
    const deliveries: Delivery[] = []
    for (const r of this.all<RunRow>('SELECT * FROM runs WHERE skipped IS NULL ORDER BY key')) {
      if (r.problem) { problems.push(`${r.key}: ${r.problem}`); continue }
      const rows = this.all<OutboxRow>('SELECT * FROM outbox WHERE run_key = ? AND state != \'sent\' ORDER BY ord, id', r.key)
      if (!rows.length) continue
      const head = rows[0]
      if (head.next_try && Date.parse(head.next_try) > at.getTime()) continue // order: nothing passes a row that waits
      const channel = this.target(`channel:${r.project}/${r.workflow}`)
      if (channel?.state !== 'provisioned') continue // the channel comes first; the outbox waits
      // A message about a document waits a little for its publication, so
      // it can carry a working link: routine ones while the attempt is open
      // (they then go out together), questions and blockers hardly at all.
      const ev = JSON.parse(head.event) as { document?: string; at?: string }
      const pending = this.publicationPending(r)
      if (ev.document && pending && at.getTime() - Date.parse(ev.at ?? head.created) < (head.critical ? 90_000 : 20 * 60_000)) continue
      // Adjacent routine rows go out as one message (up to one that waits
      // for publication); a critical row alone.
      const waits = (o: OutboxRow) => { const e = JSON.parse(o.event) as { document?: string; at?: string }; return !!e.document && pending && at.getTime() - Date.parse(e.at ?? o.created) < (o.critical ? 90_000 : 20 * 60_000) }
      const batch: OutboxRow[] = [head]
      const alone = (o: OutboxRow) => o.critical || o.type === 'publication' || o.type === 'published'
      if (!alone(head)) for (const o of rows.slice(1, 6)) { if (alone(o) || waits(o) || (o.next_try && Date.parse(o.next_try) > at.getTime())) break; batch.push(o) }
      try {
        const d = await this.render(r, batch, cfg, at)
        deliveries.push({ ...d, streamId: r.stream_id ?? channel.zulip_id!, channel: r.channel ?? channel.name, topic: r.topic ?? topicName(r.run), lastMessageId: r.last_message_id })
      } catch (e) { problems.push(`${r.key}: cannot render ${head.id}: ${(e as Error).message}`) }
    }
    return { provision, deliveries, problems }
  }

  private async workspaceOf(r: RunRow): Promise<Workspace | null> {
    const w = (await loadRegistry(this.registryFile)).workspaces.find(x => x.id === r.workspace)
    return w ? new Workspace(w) : null
  }

  private async render(r: RunRow, batch: OutboxRow[], cfg: NotifyConfig, at: Date): Promise<Omit<Delivery, 'streamId' | 'channel' | 'topic' | 'lastMessageId'>> {
    const ws = await this.workspaceOf(r)
    const ref = { workflow: r.workflow, run: r.run }
    const reading = ws ? await readRun(ws, ref) : undefined
    const rec = reading?.record
    const authored = rec ? reading!.bundle.entries[rec.definition.root]?.workflow : undefined
    const label = runKey(ref)
    const links = ws ? await this.links(ws, ref) : new Map<string, DocLink>()
    const unpublished: string[] = []
    const link = (path: string): DocLink => {
      const l = links.get(path) ?? { path, name: path.split('/').pop()! }
      if (!l.url && !l.commit) unpublished.push(path)
      return l
    }
    const runView = cfg.viewBase ? `${cfg.viewBase.replace(/\/?$/, '/')}#/ws/${encodeURIComponent(r.workspace)}/run/${encodeURIComponent(r.workflow)}/${encodeURIComponent(r.run)}` : undefined
    const answerRoute = (q: string) => (runView ? `[agdevworld run view](${runView})` : `in agdevworld's run view on the execution host (no remote address is configured), or \`wfe run answer ${label} ${q || '<question>'} --answer … --by <name>\` there`)
    const request = rec && ws ? await readFile(join(ws.root, runDir(ref), rec.input.file), 'utf8').then(t => t.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '', () => '') : ''
    const nextOf = (): string | undefined => {
      if (!rec) return undefined
      const ex = rec.execution
      if (ex.waiting.length) return ex.waiting.map(w => `${w.node} waits for ${w.holder}`).join('; ')
      if (ex.ready.length) return `${rec.executor.name}: ${ex.ready.map(id => rec.definition.effective?.nodes[id]?.step?.purpose ?? id).join(', ')}`
      return undefined
    }
    const ctx: RenderContext = {
      ref: label, executor: rec?.executor.name ?? 'the executor', request, answerRoute, runLink: runView, link,
      label: id => authored?.nodes[id]?.name || id, openQuestion: id => !!rec?.questions[id] && ['open', 'answered'].includes(questionState(rec.questions[id])),
      now: at, next: nextOf(), person: cfg.person,
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
      content = renderPublished(label, docs, commit)
    } else {
      const oldest = events[0].at
      const delayed = at.getTime() - Date.parse(oldest) > DELAYED_AFTER_MS
      content = renderMessage(events, ctx, delayed ? { delayedFrom: oldest } : {})
    }
    // Which documents this message had to call unpublished: a later
    // published checkpoint answers them with one availability update.
    this.db.prepare('UPDATE outbox SET unpublished = ? WHERE id = ?').run(unpublished.length ? JSON.stringify([...new Set(unpublished)]) : null, batch[0].id)
    return { ids: batch.map(b => b.id), run: r.key, content, marker: content.split('\n').at(-1)!, uncertain: batch.some(b => b.uncertain) }
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
        out.set(path, { path, name: path.split('/').pop()!, commit: c, url: web ? `${web}/src/commit/${c}/${inRepo}` : undefined })
        break
      }
    }
    return out
  }

  // ---- results from the transport --------------------------------------------------------

  recordSent(ids: string[], o: { messageId: number; streamId: number; channel: string; topic: string }) {
    const rows = ids.map(id => this.one<OutboxRow>('SELECT * FROM outbox WHERE id = ?', id)).filter((r): r is OutboxRow => !!r)
    if (!rows.length) throw new Error(`no outbox rows ${ids.join(', ')}`)
    const at = now()
    for (const r of rows) this.run('UPDATE outbox SET state = \'sent\', message_id = ?, sent_at = ?, uncertain = 0, last_error = NULL, next_try = NULL WHERE id = ?', o.messageId, at, r.id)
    this.run('UPDATE runs SET stream_id = ?, channel = ?, topic = ?, last_message_id = ?, updated = ? WHERE key = ?', o.streamId, o.channel, o.topic, o.messageId, at, rows[0].run_key)
  }

  // A failure retries later; `uncertain` says the message may have been
  // posted (the answer was lost), so the next attempt looks for its marker.
  recordFailed(ids: string[], error: string, uncertain: boolean, at = new Date()) {
    for (const id of ids) {
      const r = this.one<OutboxRow>('SELECT * FROM outbox WHERE id = ?', id)
      if (!r) continue
      const attempts = r.attempts + 1
      this.run('UPDATE outbox SET state = \'failed\', attempts = ?, last_error = ?, uncertain = ?, next_try = ? WHERE id = ?', attempts, error.slice(0, 500), uncertain || r.uncertain ? 1 : 0, new Date(at.getTime() + BACKOFF(attempts)).toISOString(), id)
    }
  }

  // The topic a run's messages go to moved (renamed, or moved to another
  // channel by a person): follow it, keeping the run's identity.
  recordMoved(runKeyText: string, o: { streamId: number; channel: string; topic: string }) {
    this.run('UPDATE runs SET stream_id = ?, channel = ?, topic = ?, updated = ? WHERE key = ?', o.streamId, o.channel, o.topic, now(), runKeyText)
  }

  recordRunProblem(runKeyText: string, problem: string) {
    this.run('UPDATE runs SET problem = ?, updated = ? WHERE key = ?', problem, now(), runKeyText)
  }

  // ---- views -----------------------------------------------------------------------------

  runStatus(project: string, ref: RunRef): { configured: boolean; problem?: string; skipped?: string; topic?: { url: string | null; channel: string; topic: string }; pending: number; failed: number; lastError?: string; lastSent?: string; provisioning?: string; viewBase: string | null } {
    const cfg = this.config()
    if (!cfg || 'problem' in cfg || !cfg.enabled) return { configured: false, problem: cfg && 'problem' in cfg ? cfg.problem : undefined, pending: 0, failed: 0, viewBase: null }
    const key = `${project}/${ref.workflow}/${ref.run}`
    const r = this.one<RunRow>('SELECT * FROM runs WHERE key = ?', key)
    const t = this.target(`channel:${project}/${ref.workflow}`), f = this.target(`folder:${project}`)
    const counts = this.one<{ p: number; f: number }>('SELECT sum(state = \'pending\') AS p, sum(state = \'failed\') AS f FROM outbox WHERE run_key = ?', key)
    const last = this.one<OutboxRow>('SELECT * FROM outbox WHERE run_key = ? AND state = \'sent\' ORDER BY sent_at DESC LIMIT 1', key)
    const err = this.one<OutboxRow>('SELECT * FROM outbox WHERE run_key = ? AND state = \'failed\' ORDER BY ord LIMIT 1', key)
    const provisioning = [f, t].find(x => x?.state === 'problem')?.problem ?? ([f, t].some(x => !x || x.state === 'pending') ? 'the channel is not provisioned yet' : undefined)
    return {
      configured: true, problem: r?.problem ?? undefined, skipped: r?.skipped ?? undefined,
      topic: r?.stream_id && r.topic ? { url: topicUrl(cfg.zulipUrl, r.stream_id, r.channel ?? '', r.topic), channel: r.channel ?? '', topic: r.topic } : undefined,
      pending: counts?.p ?? 0, failed: counts?.f ?? 0, lastError: err?.last_error ?? undefined, lastSent: last?.sent_at ?? undefined,
      provisioning, viewBase: cfg.viewBase,
    }
  }

  overview(): { targets: TargetRow[]; runs: (RunRow & { pending: number; failed: number })[] } {
    return {
      targets: this.all<TargetRow>('SELECT * FROM targets ORDER BY key'),
      runs: this.all<RunRow & { pending: number; failed: number }>('SELECT r.*, (SELECT count(*) FROM outbox o WHERE o.run_key = r.key AND o.state = \'pending\') AS pending, (SELECT count(*) FROM outbox o WHERE o.run_key = r.key AND o.state = \'failed\') AS failed FROM runs r ORDER BY key'),
    }
  }

  outbox(runKeyText?: string): OutboxRow[] {
    return runKeyText ? this.all<OutboxRow>('SELECT * FROM outbox WHERE run_key = ? ORDER BY ord, id', runKeyText) : this.all<OutboxRow>('SELECT * FROM outbox ORDER BY run_key, ord, id')
  }
}

function stepProblems(cp: CheckpointRow): string {
  try {
    const steps = JSON.parse(cp.steps) as { repo: string; error?: string; conflicts?: string[] }[]
    return steps.map(s => [s.error, s.conflicts?.length ? `${s.repo}: ${s.conflicts.join(', ')} changed before the run and again by it` : ''].filter(Boolean).join('; ')).filter(Boolean).join('; ') || cp.state
  } catch { return cp.state }
}

