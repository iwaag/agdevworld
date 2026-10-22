// Character dialogue (argue p5, docs/dialogue.md): the short reading view of
// a discussion. Each agent message may be shown as one line in its speaker's
// character voice, rendered by the client's renderer (aghangout's
// renderer/render.ts) from a snapshot of the original speech. It is
// presentation only and is kept apart from everything else WFE does:
//
// - where it lives: the configured archive project's workspace, in its
//   ignored `.local/character-dialogue/dialogue.sqlite` (pj-ponderer today).
//   That folder is never committed, never published by the archive writer
//   (its own clone), and never copied into a run (a run copy takes only the
//   regular files directly in `.local/`, runspace.ts);
// - who writes it: this module only, from the service's worker loop (model
//   calls) and from reads (queueing). No discussion, archive, overview,
//   state or run context reads it;
// - what it is: one result per message, language and exact inputs (the
//   cache key: renderer, model, the speaker's voice, the request). A changed
//   source, context, character or renderer is a new key: an older result is
//   kept as local data and never shown as current.
//
// Jobs are durable rows keyed like results. A read queues a bounded window of
// a discussion's missing lines; the worker follows new agent speech from a
// checkpoint taken at its first start (history is never rendered wholesale).
// A job is leased while it runs, retried with backoff and failed after
// `tries`; a result and its job's completion are one transaction, so a
// restart neither loses nor duplicates a result.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { MessageRow } from './conversations.ts'
import type { ConversationService } from './conversationService.ts'
import { git } from './git.ts'
import { openStore, transaction } from './sqlite.ts'
import { RequestError } from './workspace.ts'

export const DIALOGUE_DIR = '.local/character-dialogue'
const NAME = 'character dialogue store'
const CONTEXT_BEFORE = 4 // earlier messages given as context, besides the ones replied to
const CONTEXT_CHARS = 1500 // each context message is cut here (the target never is, up to TARGET_CHARS)
const TARGET_CHARS = 16_000
const LEASE_MS = 5 * 60_000
const DESCRIBE_TTL_MS = 30_000

// conversations.json "dialogue":
//   { "renderer": "hangout/renderer-current/renderer/render.ts",   (relative to the area, or absolute)
//     "languages": ["ja", "en"], "follow": ["ja"], "concurrency": 2, "window": 40, "tries": 3,
//     "env": { "AGHANGOUT_CLAUDE": "…" } }
export interface DialogueConfig { renderer: string; languages: string[]; follow: string[]; concurrency: number; window: number; tries: number; env: Record<string, string> }
export function loadDialogueConfig(area: string): DialogueConfig | { disabled: string } {
  const file = join(area, 'conversations.json')
  let o: Record<string, unknown> | undefined
  try { o = (JSON.parse(readFileSync(file, 'utf8')) as { dialogue?: Record<string, unknown> }).dialogue } catch (e) { return { disabled: `${file} cannot be read: ${(e as Error).message}` } }
  if (!o) return { disabled: `${file} has no "dialogue": character dialogue is not configured here` }
  const strs = (k: string, d: string[]) => { const v = o![k] ?? d; return Array.isArray(v) && v.every(x => typeof x === 'string' && /^[a-z]{2}(-[A-Za-z]+)?$/.test(x)) ? v as string[] : null }
  const num = (k: string, d: number, max: number) => { const v = o![k] ?? d; return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max ? v as number : null }
  const languages = strs('languages', ['ja']), follow = strs('follow', ['ja'])
  const concurrency = num('concurrency', 2, 8), window = num('window', 40, 500), tries = num('tries', 3, 10)
  const env = (o.env ?? {}) as Record<string, unknown>
  if (typeof o.renderer !== 'string' || !languages || !follow || !concurrency || !window || !tries || typeof env !== 'object' || !Object.values(env).every(v => typeof v === 'string')) {
    return { disabled: `${file} "dialogue" needs {"renderer": "<path to render.ts>", "languages"?: ["ja"], "follow"?: ["ja"], "concurrency"?: 1–8, "window"?: 1–500, "tries"?: 1–10, "env"?: {…}}` }
  }
  return { renderer: isAbsolute(o.renderer) ? o.renderer : resolve(area, o.renderer), languages, follow: follow.filter(l => languages.includes(l)), concurrency, window, tries, env: env as Record<string, string> }
}

// What the renderer says about itself (ag.dialogue-renderer.v1).
export interface RendererDescription {
  renderer: string; profile: { model: string }; characters: { commit: string | null }; languages: string[]
  participants: Record<string, { character: string | null; voice: string }>; neutral: string
}
export interface SourceMessage { id: number; role: 'person' | 'agent'; participant: string | null; author: string; kind: string; text: string; re: number[]; addressed: string[]; truncated?: boolean }
export interface DialogueRequest {
  schema: 'ag.dialogue-request.v1'; language: string; discussion: { id: string; title: string }
  participants: Record<string, { kind: 'person' | 'facilitator' | 'project'; projectName: string | null }>
  target: SourceMessage; context: SourceMessage[]
}
interface ResultRow { id: number; key: string; conv: string; message: number; language: string; participant: string | null; character: string | null; voice: string; renderer: string; model: string | null; characters: string | null; source: string; context: string; horizon: number; text: string; usage: string; created: string; job: number }
interface JobRow { owner?: string | null; id: number; key: string; conv: string; message: number; language: string; state: 'queued' | 'running' | 'done' | 'failed' | 'dropped'; priority: number; tries: number; not_before: string | null; lease_until: string | null; error: string | null; request: string; renderer: string; model: string; voice: string; origin: string; created: string; updated: string; started: string | null; finished: string | null; regenerate: number }

export type ItemState = 'original' | 'ready' | 'pending' | 'running' | 'failed' | 'unrequested'
export interface DialogueItem {
  message: number; participant: string | null; state: ItemState
  text?: string; character?: string | null; created?: string // ready
  error?: string; tries?: number // failed (or a pending retry)
  stale?: boolean // an earlier rendering exists for other inputs; it is not shown as current
}
export interface DialogueRead {
  discussion: string; language: string; available: boolean; problem: string | null
  renderer: { version: string; model: string; characters: string | null } | null
  items: DialogueItem[]; queued: number
}

const now = () => new Date().toISOString()
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const MIGRATIONS = [{
  version: 1,
  up: (db: DatabaseSync) => db.exec(`
    CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, conv TEXT NOT NULL, message INTEGER NOT NULL, language TEXT NOT NULL,
      state TEXT NOT NULL, priority INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, not_before TEXT, lease_until TEXT, error TEXT,
      request TEXT NOT NULL, renderer TEXT NOT NULL, model TEXT NOT NULL, voice TEXT NOT NULL, origin TEXT NOT NULL,
      created TEXT NOT NULL, updated TEXT NOT NULL, started TEXT, finished TEXT, regenerate INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX jobs_queue ON jobs (state, priority, id);
    CREATE INDEX jobs_message ON jobs (conv, message, language);
    CREATE TABLE results (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, conv TEXT NOT NULL, message INTEGER NOT NULL, language TEXT NOT NULL,
      participant TEXT, character TEXT, voice TEXT NOT NULL, renderer TEXT NOT NULL, model TEXT, characters TEXT,
      source TEXT NOT NULL, context TEXT NOT NULL, horizon INTEGER NOT NULL, text TEXT NOT NULL, usage TEXT NOT NULL, created TEXT NOT NULL, job INTEGER NOT NULL);
    CREATE INDEX results_key ON results (key, id);
    CREATE INDEX results_message ON results (conv, message, language, id);
    CREATE TABLE state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `),
}, {
  // Who holds a running job (host:pid:nonce): a restarted worker takes back
  // at once what a dead process held, and only the holder may complete it.
  version: 2,
  up: (db: DatabaseSync) => db.exec('ALTER TABLE jobs ADD COLUMN owner TEXT'),
}]
const HOST = hostname()
// A holder on this host whose process is gone; another host's is left to its lease.
function deadOwner(owner: string | null): boolean {
  const [host, pid] = (owner ?? '').split(':')
  if (host !== HOST || !pid || !/^\d+$/.test(pid)) return false
  try { process.kill(Number(pid), 0); return false } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' }
}

// Runs the renderer (`node <render.ts> <command>`), with the configured env.
export function runRenderer(cfg: DialogueConfig, command: 'describe' | 'render', input?: string, timeoutMs = 240_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cfg.renderer, command], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...cfg.env } })
    let out = '', err = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error((err.trim().split('\n').at(-1) || `the renderer ended with ${code ?? 'a signal'}`).slice(0, 500))) })
    child.stdin.end(input ?? '')
  })
}

export class DialogueStore {
  readonly ds: ConversationService
  private _db: DatabaseSync | null = null
  private _dir: string | null = null
  private described: { at: number; real: string; mtime: number; d: RendererDescription } | null = null
  private o: { config?: DialogueConfig | { disabled: string }; backoffMs?: number }
  constructor(ds: ConversationService, o: { config?: DialogueConfig | { disabled: string }; backoffMs?: number } = {}) { this.ds = ds; this.o = o }

  config(): DialogueConfig | { disabled: string } { return this.o.config ?? loadDialogueConfig(this.ds.area) }

  // The storage folder: the archive project's workspace's ignored .local/.
  async dir(): Promise<string> {
    if (this._dir) return this._dir
    const cfg = this.ds.config()
    if ('disabled' in cfg) throw new RequestError(503, cfg.disabled)
    if (!cfg.archive) throw new RequestError(503, 'conversations.json "discussions" names no archive project: character dialogue is kept beside the archive')
    if (!this.ds.exec) throw new RequestError(503, 'execution is not configured here')
    const ws = await this.ds.exec.workspace(cfg.archive.workspace)
    const dir = join(ws.root, DIALOGUE_DIR)
    // Never into version control: the folder must be ignored by the workspace's Git.
    const ignored = await git(ws.root, ['check-ignore', '-q', '--no-index', DIALOGUE_DIR])
    if (ignored.code !== 0) throw new RequestError(503, `${DIALOGUE_DIR} is not ignored by Git in the archive workspace ${cfg.archive.workspace}; character dialogue is kept only where it is never committed`)
    mkdirSync(dir, { recursive: true })
    this._dir = dir
    return dir
  }
  async db(): Promise<DatabaseSync> {
    if (!this._db) this._db = openStore(NAME, join(await this.dir(), 'dialogue.sqlite'), MIGRATIONS)
    return this._db
  }
  close() { this._db?.close(); this._db = null }

  // The renderer's description, read again when its file (or the release it
  // links to) changes, or every half minute.
  async describe(force = false): Promise<RendererDescription> {
    const cfg = this.config()
    if ('disabled' in cfg) throw new RequestError(503, cfg.disabled)
    let real: string, mtime: number
    try { real = realpathSync(cfg.renderer); mtime = statSync(real).mtimeMs } catch { throw new RequestError(503, `the renderer ${cfg.renderer} does not exist (is aghangout deployed with its renderer?)`) }
    const c = this.described
    if (!force && c && c.real === real && c.mtime === mtime && Date.now() - c.at < DESCRIBE_TTL_MS) return c.d
    let d: RendererDescription
    try { d = JSON.parse(await runRenderer(cfg, 'describe', undefined, 30_000)) as RendererDescription } catch (e) { throw new RequestError(503, `the renderer cannot describe itself: ${(e as Error).message}`) }
    if (typeof d?.renderer !== 'string' || typeof d.neutral !== 'string' || !d.participants) throw new RequestError(503, 'the renderer described itself in an unknown form')
    this.described = { at: Date.now(), real, mtime, d }
    return d
  }

  // ---- snapshots and keys -------------------------------------------------------------------

  // What the renderer is given for one agent message: the message, the
  // earlier messages it replies to and the few before it (originals only,
  // never another rendering, never anything later), and who each speaker is.
  async request(conv: string, message: number, language: string, rows: MessageRow[] = this.ds.messages(conv), names?: Map<string, string | null>): Promise<{ request: DialogueRequest; horizon: number }> {
    const i = rows.findIndex(m => m.id === message)
    if (i < 0) throw new RequestError(404, `no message ${message} in discussion ${conv}`)
    const m = rows[i]!
    const re = (JSON.parse(m.re) as number[]).filter(n => n < m.id)
    const ids = new Set<number>([...re, ...rows.slice(Math.max(0, i - CONTEXT_BEFORE), i).map(x => x.id)])
    const src = (x: MessageRow, cut: number): SourceMessage => ({
      id: x.id, role: x.role, participant: x.participant, author: x.author, kind: x.kind, text: x.text.length > cut ? x.text.slice(0, cut) : x.text,
      re: JSON.parse(x.re) as number[], addressed: x.addressed ? JSON.parse(x.addressed) as string[] : [], ...(x.text.length > cut ? { truncated: true } : {}),
    })
    const context = rows.filter(x => ids.has(x.id)).map(x => src(x, CONTEXT_CHARS))
    const members = [...this.ds.members(conv), ...this.ds.membership(conv)]
    const nameOf = names ?? await this.projectNames()
    const participants: DialogueRequest['participants'] = {}
    for (const x of [...context, m]) {
      const p = x.participant ?? x.author
      if (participants[p]) continue
      const kind = x.role === 'person' ? 'person' : (members.find(r => r.participant === p)?.kind ?? 'project')
      participants[p] = { kind, projectName: kind === 'person' ? null : nameOf.get(p) ?? null }
    }
    const d = this.ds.conversation(conv)!
    return {
      request: { schema: 'ag.dialogue-request.v1', language, discussion: { id: conv, title: d.display_title ?? d.title }, participants, target: src(m, TARGET_CHARS), context },
      horizon: m.id,
    }
  }
  private async projectNames(): Promise<Map<string, string | null>> {
    try { return new Map((await this.ds.participants()).map(p => [p.participant, p.projectName ?? null])) } catch { return new Map() }
  }
  // The cache identity: everything the result depends on.
  static key(d: RendererDescription, r: DialogueRequest): { key: string; voice: string } {
    const p = r.target.participant
    const voice = (p && d.participants[p]?.voice) || d.neutral
    return { key: sha(JSON.stringify({ renderer: d.renderer, model: d.profile.model, voice, request: r })), voice }
  }

  // ---- reads (the presentation path) ---------------------------------------------------------

  // The dialogue of a discussion in one language: every message's state. A
  // read queues at most `window` missing lines (`queue`), and only lines; it
  // never calls a model.
  async read(conv: string, language: string, o: { queue?: boolean; since?: number } = {}): Promise<DialogueRead> {
    if (!this.ds.conversation(conv)) throw new RequestError(404, `no discussion ${conv}`)
    const rows = this.ds.messages(conv)
    const plain = (problem: string): DialogueRead => ({
      discussion: conv, language, available: false, problem, renderer: null, queued: 0,
      items: rows.filter(m => m.id > (o.since ?? 0)).map(m => ({ message: m.id, participant: m.participant, state: m.role === 'person' ? 'original' : 'unrequested' })),
    })
    const cfg = this.config()
    if ('disabled' in cfg) return plain(cfg.disabled)
    if (!cfg.languages.includes(language)) throw new RequestError(400, `language is one of ${cfg.languages.join(', ')}`)
    let d: RendererDescription, db: DatabaseSync
    try { d = await this.describe(); db = await this.db() } catch (e) { return plain((e as Error).message) }
    const names = await this.projectNames()
    let budget = o.queue === false ? 0 : cfg.window
    let queued = 0
    const items: DialogueItem[] = []
    for (const m of rows) {
      if (m.id <= (o.since ?? 0)) continue
      if (m.role === 'person') { items.push({ message: m.id, participant: m.participant, state: 'original' }); continue }
      const { request, horizon } = await this.request(conv, m.id, language, rows, names)
      const { key, voice } = DialogueStore.key(d, request)
      const r = db.prepare('SELECT * FROM results WHERE key = ? ORDER BY id DESC LIMIT 1').get(key) as ResultRow | undefined
      const job = db.prepare('SELECT * FROM jobs WHERE key = ?').get(key) as JobRow | undefined
      const stale = !r && !!db.prepare('SELECT 1 FROM results WHERE conv = ? AND message = ? AND language = ? LIMIT 1').get(conv, m.id, language)
      // A line being rendered again keeps showing its current result until the new one is in.
      if (r) items.push({ message: m.id, participant: m.participant, state: 'ready', text: r.text, character: r.character, created: r.created })
      else if (job && job.state !== 'dropped') {
        items.push({ message: m.id, participant: m.participant, state: job.state === 'failed' ? 'failed' : job.state === 'running' ? 'running' : 'pending', ...(job.error ? { error: job.error, tries: job.tries } : {}), ...(stale ? { stale } : {}) })
      } else if (budget > 0) {
        this.enqueue(db, { key, conv, message: m.id, language, request, renderer: d.renderer, model: d.profile.model, voice, origin: 'reader', priority: 1, horizon })
        budget--; queued++
        items.push({ message: m.id, participant: m.participant, state: 'pending', ...(stale ? { stale } : {}) })
      } else items.push({ message: m.id, participant: m.participant, state: 'unrequested', ...(stale ? { stale } : {}) })
    }
    return { discussion: conv, language, available: true, problem: null, renderer: { version: d.renderer, model: d.profile.model, characters: d.characters.commit }, items, queued }
  }

  private enqueue(db: DatabaseSync, j: { key: string; conv: string; message: number; language: string; request: DialogueRequest; renderer: string; model: string; voice: string; origin: string; priority: number; horizon: number }): boolean {
    const t = now()
    // A dropped job (its renderer changed before it ran) is the same inputs again: requeue it.
    const r = db.prepare(`INSERT INTO jobs (key, conv, message, language, state, priority, request, renderer, model, voice, origin, created, updated)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET state = 'queued', tries = 0, error = NULL, not_before = NULL, updated = excluded.updated WHERE jobs.state = 'dropped'`)
      .run(j.key, j.conv, j.message, j.language, j.priority, JSON.stringify(j.request), j.renderer, j.model, j.voice, j.origin, t, t)
    return Number(r.changes) > 0
  }

  // Retry a failed line, or render a ready one again (the older result stays
  // as local data). A line already queued or running is left as it is.
  async retry(conv: string, message: number, language: string, by: string): Promise<{ state: 'queued' | 'unchanged'; reason: string }> {
    const cfg = this.config()
    if ('disabled' in cfg) throw new RequestError(503, cfg.disabled)
    if (!cfg.languages.includes(language)) throw new RequestError(400, `language is one of ${cfg.languages.join(', ')}`)
    if (!this.ds.conversation(conv)) throw new RequestError(404, `no discussion ${conv}`)
    const rows = this.ds.messages(conv)
    const m = rows.find(x => x.id === message)
    if (!m) throw new RequestError(404, `no message ${message} in discussion ${conv}`)
    if (m.role === 'person') throw new RequestError(409, `message ${message} is the person's: it is always shown as written`)
    const d = await this.describe(true)
    const db = await this.db()
    const { request, horizon } = await this.request(conv, message, language, rows)
    const { key, voice } = DialogueStore.key(d, request)
    return transaction(db, () => {
      const job = db.prepare('SELECT * FROM jobs WHERE key = ?').get(key) as JobRow | undefined
      if (job && (job.state === 'queued' || job.state === 'running')) return { state: 'unchanged' as const, reason: `already ${job.state}` }
      if (!job) {
        this.enqueue(db, { key, conv, message, language, request, renderer: d.renderer, model: d.profile.model, voice, origin: `retry by ${by}`, priority: 3, horizon })
        return { state: 'queued' as const, reason: 'queued' }
      }
      const regenerate = job.state === 'done' ? 1 : 0
      db.prepare(`UPDATE jobs SET state = 'queued', tries = 0, error = NULL, not_before = NULL, lease_until = NULL, priority = 3, regenerate = ?, origin = ?, updated = ? WHERE id = ?`)
        .run(regenerate, `retry by ${by}`, now(), job.id)
      return { state: 'queued' as const, reason: regenerate ? 'rendering again (the current line stays until the new one is ready)' : 'retrying' }
    }, NAME)
  }

  // ---- the worker (the service's loop) -------------------------------------------------------

  // New agent speech in discussions, after the checkpoint (set at the first
  // call, so nothing that existed before is queued), for the follow languages.
  async follow(): Promise<number> {
    const cfg = this.config()
    if ('disabled' in cfg || !cfg.follow.length) return 0
    const db = await this.db()
    const top = (this.ds.db.prepare("SELECT max(m.id) AS n FROM messages m JOIN conversations c ON c.id = m.conv").get() as { n: number | null }).n ?? 0
    const cp = db.prepare("SELECT v FROM state WHERE k = 'follow'").get() as { v: string } | undefined
    if (!cp) { db.prepare("INSERT OR IGNORE INTO state (k, v) VALUES ('follow', ?)").run(String(top)); return 0 }
    const from = Number(cp.v)
    if (top <= from) return 0
    const fresh = this.ds.db.prepare("SELECT m.id, m.conv FROM messages m JOIN conversations c ON c.id = m.conv WHERE m.role = 'agent' AND m.id > ? AND m.id <= ? ORDER BY m.id").all(from, top) as { id: number; conv: string }[]
    let n = 0
    if (fresh.length) {
      const d = await this.describe()
      const names = await this.projectNames()
      for (const f of fresh) for (const language of cfg.follow) {
        const { request, horizon } = await this.request(f.conv, f.id, language, this.ds.messages(f.conv), names)
        const { key, voice } = DialogueStore.key(d, request)
        if (this.enqueue(db, { key, conv: f.conv, message: f.id, language, request, renderer: d.renderer, model: d.profile.model, voice, origin: 'follow', priority: 2, horizon })) n++
      }
    }
    db.prepare("UPDATE state SET v = ? WHERE k = 'follow'").run(String(top))
    return n
  }

  // Jobs left by a stopped worker go back to the queue (their try counted):
  // at once when the holder was a process on this host that is gone, else
  // when the lease runs out.
  async reclaim(): Promise<number> {
    const db = await this.db()
    let n = Number(db.prepare("UPDATE jobs SET state = 'queued', lease_until = NULL, owner = NULL, updated = ? WHERE state = 'running' AND lease_until < ?").run(now(), now()).changes)
    for (const j of db.prepare("SELECT id, owner FROM jobs WHERE state = 'running'").all() as { id: number; owner: string | null }[]) {
      if (deadOwner(j.owner)) n += Number(db.prepare("UPDATE jobs SET state = 'queued', lease_until = NULL, owner = NULL, updated = ? WHERE id = ? AND state = 'running' AND owner = ?").run(now(), j.id, j.owner).changes)
    }
    return n
  }

  // Takes the next due job: atomically from queued to running, its try counted.
  async claim(): Promise<JobRow | null> {
    const db = await this.db()
    return transaction(db, () => {
      const j = db.prepare("SELECT * FROM jobs WHERE state = 'queued' AND (not_before IS NULL OR not_before <= ?) ORDER BY priority DESC, id LIMIT 1").get(now()) as JobRow | undefined
      if (!j) return null
      const t = now()
      const owner = `${HOST}:${process.pid}:${Math.random().toString(36).slice(2, 10)}`
      db.prepare("UPDATE jobs SET state = 'running', tries = tries + 1, lease_until = ?, owner = ?, started = ?, updated = ? WHERE id = ?").run(new Date(Date.now() + LEASE_MS).toISOString(), owner, t, t, j.id)
      return { ...j, state: 'running' as const, tries: j.tries + 1, owner }
    }, NAME)
  }

  // Renders one claimed job. The result is accepted only for the inputs the
  // job was keyed by; it and the job's completion are one transaction.
  async perform(job: JobRow): Promise<'done' | 'retry' | 'failed' | 'dropped'> {
    const cfg = this.config()
    const db = await this.db()
    const fail = (error: string) => transaction(db, () => {
      const cur = db.prepare('SELECT state, owner FROM jobs WHERE id = ?').get(job.id) as { state: string; owner: string | null } | undefined
      if (cur?.state !== 'running' || cur.owner !== (job.owner ?? null)) return 'dropped' as const
      const max = 'disabled' in cfg ? 1 : cfg.tries
      if (job.tries >= max) { db.prepare("UPDATE jobs SET state = 'failed', error = ?, lease_until = NULL, owner = NULL, finished = ?, updated = ? WHERE id = ?").run(error, now(), now(), job.id); return 'failed' as const }
      db.prepare("UPDATE jobs SET state = 'queued', error = ?, lease_until = NULL, owner = NULL, not_before = ?, updated = ? WHERE id = ?").run(error, new Date(Date.now() + (this.o.backoffMs ?? 20_000) * 2 ** (job.tries - 1)).toISOString(), now(), job.id)
      return 'retry' as const
    }, NAME)
    if ('disabled' in cfg) return fail(cfg.disabled)
    let d: RendererDescription
    try { d = await this.describe() } catch (e) { return fail((e as Error).message) }
    const request = JSON.parse(job.request) as DialogueRequest
    if (DialogueStore.key(d, request).key !== job.key) {
      // The renderer, its model or the speaker's character changed since the
      // job was queued: these inputs are no longer what a reader would get.
      db.prepare("UPDATE jobs SET state = 'dropped', error = 'the renderer or the character changed before it ran', lease_until = NULL, owner = NULL, updated = ? WHERE id = ? AND state = 'running' AND owner = ?").run(now(), job.id, job.owner ?? null)
      return 'dropped'
    }
    let out: { renderer?: string; voice?: string; character?: string | null; language?: string; text?: string; usage?: unknown }
    try { out = JSON.parse(await runRenderer(cfg, 'render', job.request)) } catch (e) { return fail((e as Error).message) }
    if (out.renderer !== job.renderer || out.voice !== job.voice || out.language !== job.language || typeof out.text !== 'string' || !out.text.trim()) {
      return fail(`the renderer answered for other inputs (${out.renderer}/${out.voice}/${out.language}) or without text`)
    }
    return transaction(db, () => {
      const cur = db.prepare('SELECT state, owner FROM jobs WHERE id = ?').get(job.id) as { state: string; owner: string | null } | undefined
      if (cur?.state !== 'running' || cur.owner !== (job.owner ?? null)) return 'dropped' as const
      const ctx = request.context.map(c => ({ id: c.id, sha256: sha(c.text) }))
      db.prepare(`INSERT INTO results (key, conv, message, language, participant, character, voice, renderer, model, characters, source, context, horizon, text, usage, created, job)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(job.key, job.conv, job.message, job.language, request.target.participant, out.character ?? null, job.voice, job.renderer, job.model, d.characters.commit,
          sha(request.target.text), JSON.stringify(ctx), Math.max(job.message, ...ctx.map(c => c.id)), out.text!.trim(), JSON.stringify(out.usage ?? null), now(), job.id)
      db.prepare("UPDATE jobs SET state = 'done', error = NULL, lease_until = NULL, owner = NULL, regenerate = 0, finished = ?, updated = ? WHERE id = ?").run(now(), now(), job.id)
      return 'done' as const
    }, NAME)
  }

  // What is queued, running, done and failed, and the newest results' usage.
  async status() {
    const cfg = this.config()
    if ('disabled' in cfg) return { configured: false, problem: cfg.disabled }
    let dir: string, db: DatabaseSync
    try { dir = await this.dir(); db = await this.db() } catch (e) { return { configured: true, problem: (e as Error).message } }
    let renderer: RendererDescription | null = null, problem: string | null = null
    try { renderer = await this.describe() } catch (e) { problem = (e as Error).message }
    const jobs = Object.fromEntries((db.prepare('SELECT state, count(*) AS n FROM jobs GROUP BY state').all() as { state: string; n: number }[]).map(r => [r.state, r.n]))
    const results = (db.prepare('SELECT count(*) AS n FROM results').get() as { n: number }).n
    const follow = (db.prepare("SELECT v FROM state WHERE k = 'follow'").get() as { v: string } | undefined)?.v ?? null
    const failed = db.prepare("SELECT conv, message, language, tries, error, updated FROM jobs WHERE state = 'failed' ORDER BY id DESC LIMIT 10").all()
    return { configured: true, problem, storage: dir, renderer: renderer && { version: renderer.renderer, model: renderer.profile.model, characters: renderer.characters.commit, path: cfg.renderer }, languages: cfg.languages, follow: cfg.follow, followFrom: follow ? Number(follow) : null, concurrency: cfg.concurrency, jobs, results, failed }
  }

  // Every result of one message (current first), with its inputs and usage: evidence for a reader's check.
  async history(conv: string, message: number, language: string) {
    const db = await this.db()
    return (db.prepare('SELECT * FROM results WHERE conv = ? AND message = ? AND language = ? ORDER BY id DESC').all(conv, message, language) as unknown as ResultRow[])
      .map(r => ({ id: r.id, key: r.key.slice(0, 16), created: r.created, renderer: r.renderer, model: r.model, character: r.character, characters: r.characters, horizon: r.horizon, context: JSON.parse(r.context), text: r.text, usage: JSON.parse(r.usage) }))
  }
}

// The worker loop in the service process: follows new speech, reclaims
// leases, and renders up to `concurrency` jobs at once. It holds no executor
// slot and never touches a run.
export class DialogueWorker {
  private running = 0
  private timer: NodeJS.Timeout | undefined
  private ticking = false
  stopped = false
  readonly store: DialogueStore
  private log: (s: string) => void
  constructor(store: DialogueStore, log: (s: string) => void = s => console.log(s)) { this.store = store; this.log = log }
  start(intervalMs = 2000) {
    const cfg = this.store.config()
    if ('disabled' in cfg) { this.log(`character dialogue: off (${cfg.disabled})`); return }
    this.log(`character dialogue: renderer ${cfg.renderer}, languages ${cfg.languages.join(',')}, following ${cfg.follow.join(',') || 'nothing'}, ${cfg.concurrency} at once`)
    this.timer = setInterval(() => void this.tick(), intervalMs)
    this.timer.unref()
    void this.tick()
  }
  stop() { this.stopped = true; clearInterval(this.timer) }
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return
    this.ticking = true
    try {
      const cfg = this.store.config()
      if ('disabled' in cfg) return
      await this.store.reclaim()
      await this.store.follow()
      while (this.running < cfg.concurrency && !this.stopped) {
        const job = await this.store.claim()
        if (!job) break
        this.running++
        void this.store.perform(job)
          .then(r => { if (r !== 'done') this.log(`character dialogue: ${job.conv} #${job.message} ${job.language}: ${r}`) })
          .catch(e => this.log(`character dialogue: ${job.conv} #${job.message}: ${(e as Error).message}`))
          .finally(() => { this.running--; void this.tick() })
      }
    } catch (e) {
      this.log(`character dialogue: ${(e as Error).message}`)
    } finally { this.ticking = false }
  }
  // Until nothing is queued or running (checks and the CLI's `work`).
  async drain(timeoutMs = 600_000): Promise<void> {
    const end = Date.now() + timeoutMs
    for (;;) {
      await this.tick()
      const db = await this.store.db()
      const open = (db.prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('queued', 'running')").get() as { n: number }).n
      if (!open && !this.running) return
      if (Date.now() > end) throw new Error('character dialogue: jobs still open at the deadline')
      await new Promise(r => setTimeout(r, 200))
    }
  }
}
