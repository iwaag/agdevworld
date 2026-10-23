// Challenges (challenge p1, p3; docs/challenges.md): problems found during
// project work, kept as durable shared records that any project can find and
// carry into later work, with the work done on them. One challenge is one
// directory, `challenges/<id>/`, in one shared Git repository
// (<area>/challenges.json names it):
//
// - `summary.md` (optional): the standard statement — frontmatter with the
//   management fields (id, title, state, projects) and a free-form body;
// - any other files: source material that explains the challenge;
// - `wedo/<trial>/`: one directory per trial, named and filled freely by
//   whoever does the work; its `summary.md` is optional.
//
// The layout before challenge p3 (`challenges/<id>.md`, `evidence/<id>/…`) is
// still read at the commits that have it, so a revision pinned then reads as
// it was; it is never written.
//
// Git is the truth. This module keeps, in <area>/.local/challenges/:
//
// - repo/: the writer's own clone. It is disposable: every publication
//   starts from the remote's state (fetch, reset), so what it holds beyond
//   the remote is an earlier attempt that never reached it;
// - challenges.sqlite:
//   - operations: the journal. A create or an edit (summary fields, files
//     added or dropped anywhere in the challenge's directory, a trial's
//     included) is accepted here first, with its request identity (the same
//     request twice is one operation), the actor, the run, attempt and
//     source it came from, what it writes, the repository paths it changes
//     and the revision it was based on. It stays until the remote history is
//     seen to contain it: pending → published, or unsynced (the push failed
//     or its outcome is unknown; retried), conflict (one of its paths
//     changed on the remote after the base; the draft is kept), refused (it
//     can never be written, e.g. its id exists remotely) or discarded;
//   - blobs: the bytes of files an operation adds, until published;
//   - records, trials: an index of the published challenges for lists and
//     search, rebuilt from the repository whenever its head moves. It is
//     never edited by itself: dropping it loses nothing.
//
// Publication: under one cross-process lock (the service, the CLI and the
// executor's reconcile may all publish), fetch; for each operation in order,
// look for its request in the remote history first (a crash after a push, or
// a push whose outcome was not seen, is recognised and never written twice);
// check that none of its paths changed since its base; commit as the actor
// with trailers naming the request, run, attempt and source; push once. A
// rejected push starts again from the new remote state; nothing is ever
// force-pushed.
//
// Reads: a current read is the index (refreshed from the remote at most
// every few seconds); a pinned read is the tree of one commit. History is the
// repository's log. Creating, editing or reading a challenge starts no run,
// assigns no work and interprets nothing.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml'
import { git, gitBytes, gitOk } from './git.ts'
import { withLock } from './lock.ts'
import { openStore, transaction } from './sqlite.ts'
import { RequestError } from './workspace.ts'

// A challenge is its directory: any plain name (WFE allocates ch-0001, …).
export const CHALLENGE_ID = /^(?!operations$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const ALLOCATED = /^ch-([0-9]{4,})$/
// The standard management vocabulary; any other state is kept as written.
export const CHALLENGE_STATES = ['open', 'resolved', 'withdrawn'] as const
export type StandardState = typeof CHALLENGE_STATES[number]
export type StateKind = StandardState | 'custom' | 'unspecified'
export const STATE_FILTERS = ['all', ...CHALLENGE_STATES, 'custom', 'unspecified'] as const
export const OPERATION_STATES = ['pending', 'published', 'unsynced', 'conflict', 'refused', 'discarded'] as const
export type OperationState = typeof OPERATION_STATES[number]
const OPEN_OPS: OperationState[] = ['pending', 'unsynced', 'conflict']
const PROJECT = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const STATE = /^[^\r\n]{1,60}$/
const REQUEST = /^[A-Za-z0-9:._/#-]{8,200}$/
const ACTOR = /^[^\n\r<>]{1,100}$/
const MAX_TITLE = 200
const MAX_BODY = 200_000
export const MAX_FILE = 32 * 1024 * 1024
export const MAX_WRITE = 64 * 1024 * 1024
export const MAX_FILES = 500
export const SUMMARY = 'summary.md'
export const WEDO = 'wedo'
const IDENTITY = { 'user.name': 'WFE challenges', 'user.email': 'wfe-challenges@agdev.invalid', 'core.quotePath': 'false' }
const SYNC_MS = 10_000
const now = () => new Date().toISOString()
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
export const stateKind = (s: string | null): StateKind => s === null ? 'unspecified' : (CHALLENGE_STATES as readonly string[]).includes(s) ? s as StandardState : 'custom'

// A name inside a challenge's directory (`voice.wav`, `wedo/speech/out/a.wav`):
// relative, `/`-separated, no empty, `.`, `..` or `.git` segment, no control
// characters, quotes or backslashes. The structure is the writer's own.
export function materialName(n: string, what = 'file name'): string {
  const name = n.replace(/^\.\/+/, '')
  const bad = (why: string) => new RequestError(400, `${what} "${n}": ${why}`)
  if (!name || name.length > 1024) throw bad('a relative path of 1–1024 characters')
  if (name.startsWith('/') || isAbsolute(name)) throw bad('relative to the challenge (or trial) directory, not absolute')
  if (/[\u0000-\u001f\u007f"\\]/.test(name)) throw bad('no control characters, quotes or backslashes')
  for (const seg of name.split('/')) {
    if (!seg || seg === '.' || seg === '..') throw bad('no empty, "." or ".." segments')
    if (seg.toLowerCase() === '.git') throw bad('no ".git" segment')
    if (Buffer.byteLength(seg) > 255) throw bad('a segment is at most 255 bytes')
  }
  return name
}
export function trialName(t: string): string {
  const n = materialName(t, 'trial name')
  if (n.includes('/')) throw new RequestError(400, `trial name "${t}": one directory name under wedo/, no "/"`)
  return n
}

// <area>/challenges.json: {"repository": "<clone URL or path>", "branch"?: "main", "web"?: "<browser URL>",
//   "mirrors"?: ["<URL of a copy on another host>", …], "sshCommand"?: "ssh -i <key> -o BatchMode=yes"}
// A mirror is a backup: after a publication the branch is pushed there too
// (best effort; its state is in status()). It is never read. `sshCommand`
// is how an ssh:// mirror is reached (GIT_SSH_COMMAND for mirror pushes only).
export interface ChallengeConfig { url: string; branch: string; web: string | null; destination: string; mirrors: string[]; sshCommand: string | null }
export function loadChallengeConfig(area: string): ChallengeConfig | { disabled: string } {
  const file = join(area, 'challenges.json')
  if (!existsSync(file)) return { disabled: `no ${file}: no challenge repository is configured here` }
  try {
    const o = JSON.parse(readFileSync(file, 'utf8')) as { repository?: unknown; branch?: unknown; web?: unknown; mirrors?: unknown; sshCommand?: unknown }
    if (typeof o.repository !== 'string' || !o.repository.trim()) return { disabled: `${file} needs {"repository": "<clone URL>"}` }
    let url = o.repository.trim()
    if (!/^[a-z+]+:\/\//.test(url) && !isAbsolute(url) && !/^[^/]+@[^:]+:/.test(url)) url = resolve(area, url)
    const destination = url.replace(/\/\/[^@/]+@/, '//').replace(/\/+$/, '').replace(/\.git$/, '')
    const web = typeof o.web === 'string' && o.web ? o.web.replace(/\/+$/, '') : /^https?:\/\//.test(destination) ? destination : null
    if (o.mirrors !== undefined && (!Array.isArray(o.mirrors) || !o.mirrors.every(m => typeof m === 'string' && m))) return { disabled: `${file}: "mirrors" is a list of repository URLs` }
    return { url, branch: typeof o.branch === 'string' && o.branch ? o.branch : 'main', web, destination, mirrors: (o.mirrors as string[] | undefined) ?? [], sshCommand: typeof o.sshCommand === 'string' && o.sshCommand ? o.sshCommand : null }
  } catch (e) { return { disabled: `${file} cannot be read: ${(e as Error).message}` } }
}

// The standard summary's fields. `state` is null when the summary names none
// (or there is no summary); a state outside the standard three is kept.
export interface Fields { title: string; state: string | null; projects: string[]; body: string }
export interface Person { at: string; by: string; commit: string }
// A file of a challenge: `name` is its path inside the challenge's directory
// (the same before and after challenge p3: `evidence/<f>` was
// `evidence/<id>/<f>`), `path` is where the repository has it at that commit.
export interface MaterialFile { name: string; path: string; size: number }
// A summary.md that is not the challenge's own: shown as written. The title
// is its frontmatter `title` or its first heading, if it has one.
export interface TrialSummary { name: string; path: string; title: string | null; body: string; extra: Record<string, unknown>; problem?: string }
export interface Trial {
  name: string // the directory under wedo/
  dir: string // wedo/<name>
  files: MaterialFile[] // every file in it, summary.md included
  summary: TrialSummary | null
  commit: string // the newest commit that changed it
  created: Person
  updated: Person
}
// A challenge as one revision of the repository has it.
export interface Challenge extends Fields {
  id: string
  layout: 'directory' | 'legacy' // legacy: challenges/<id>.md and evidence/<id>/ (before challenge p3)
  dir: string // challenges/<id>
  path: string // its summary's repository path (absent or not)
  summary: boolean // whether it has a summary
  stateKind: StateKind
  commit: string // the revision: the newest commit that changed anything of it
  sha256: string // of what a run is given for it (text())
  created: Person
  updated: Person
  files: MaterialFile[] // its own files: neither its summary nor any trial's
  trials: Trial[]
  extra: Record<string, unknown> // frontmatter fields beyond the four, kept as written
  problem?: string // why its summary could not be read as standard (it is shown as written)
}
export interface Source { kind: 'conversation'; conversation: string; message: number }
export interface OperationRow {
  id: number; request: string; kind: 'create' | 'edit'; challenge: string; base: string | null
  fields: string; evidence: string; drop_names: string; paths: string | null; actor: string; on_behalf: string | null; run: string | null; attempt: string | null
  source: string | null; via: string; note: string; state: OperationState; commit_id: string | null; current: string | null
  error: string | null; tries: number; created: string; updated: string
}
export interface Operation {
  id: number; request: string; kind: 'create' | 'edit'; challenge: string; base: string | null
  fields: Partial<Fields> // what it sets in the summary (a create: all four)
  files: { name: string; sha256: string; size: number }[] // added or replaced, by name in the challenge's directory
  drop: string[] // removed, by name
  paths: string[] // the repository paths it changes
  trial: string | null // when every path is in one trial
  actor: string; onBehalfOf: string | null; run: string | null; attempt: string | null; source: Source | null; via: string; note: string
  state: OperationState; commit: string | null; current: string | null; error: string | null; tries: number; created: string; updated: string
}
interface RecordRow { id: string; state: string | null; state_kind: string; projects: string; text: string; commit_id: string; updated_at: string; data: string }

export interface Actor { by: string; onBehalfOf?: string | null; run?: string | null; attempt?: string | null; via: string }
export interface AddFile { name: string; bytes: Buffer }
export interface CreateInput extends Actor { request: string; title: string; body: string; projects?: string[]; state?: string; files?: AddFile[]; source?: Source | null; note?: string }
// An edit: summary fields, files (names in the challenge's directory, or in
// `trial`'s when it is given) added or dropped — one commit. `base` is the
// revision read; it may be left out only when every file is new.
export interface EditInput extends Actor { request: string; base?: string | null; title?: string; body?: string; projects?: string[]; state?: string; trial?: string; files?: AddFile[]; drop?: string[]; source?: Source | null; note?: string }
export interface Accepted { operation: Operation; duplicate: boolean; record: Challenge | null; publication: Publication }
export interface Publication { state: OperationState; commit: string | null; error: string | null; repository: string | null }

export class ChallengeStore {
  readonly area: string
  readonly dir: string
  readonly db: DatabaseSync
  private env: () => Promise<Record<string, string>>
  private hooks: { beforePush?: () => Promise<void>; afterPush?: () => Promise<void> }
  private lastSync = 0
  constructor(o: { area: string; env?: () => Promise<Record<string, string>>; dir?: string; hooks?: ChallengeStore['hooks'] }) {
    this.area = o.area
    this.dir = o.dir ?? join(o.area, '.local', 'challenges')
    this.env = o.env ?? (async () => ({}))
    this.hooks = o.hooks ?? {}
    mkdirSync(this.dir, { recursive: true })
    this.db = openStore('challenge store', join(this.dir, 'challenges.sqlite'), [{
      version: 1,
      up: db => db.exec(`
        CREATE TABLE operations (id INTEGER PRIMARY KEY AUTOINCREMENT, request TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, challenge TEXT NOT NULL, base TEXT,
          fields TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '[]', drop_names TEXT NOT NULL DEFAULT '[]', actor TEXT NOT NULL, on_behalf TEXT, run TEXT, attempt TEXT,
          source TEXT, via TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, commit_id TEXT, current TEXT, error TEXT, tries INTEGER NOT NULL DEFAULT 0,
          created TEXT NOT NULL, updated TEXT NOT NULL);
        CREATE INDEX operations_state ON operations (state, id);
        CREATE INDEX operations_challenge ON operations (challenge, id);
        CREATE TABLE blobs (sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL);
        CREATE TABLE records (id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL, projects TEXT NOT NULL, body TEXT NOT NULL, commit_id TEXT NOT NULL,
          sha256 TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, evidence TEXT NOT NULL, extra TEXT NOT NULL, problem TEXT);
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `),
    }, {
      // challenge p3: one directory per challenge, trials, any files. The
      // journal gains the paths each operation changes (`evidence` holds the
      // files it adds, by name in the challenge's directory); the index is
      // derived, so it is dropped and rebuilt from the repository.
      version: 2,
      up: db => db.exec(`
        ALTER TABLE operations ADD COLUMN paths TEXT;
        DROP TABLE records;
        CREATE TABLE records (id TEXT PRIMARY KEY, state TEXT, state_kind TEXT NOT NULL, projects TEXT NOT NULL, text TEXT NOT NULL, commit_id TEXT NOT NULL,
          updated_at TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE trials (challenge TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (challenge, name));
        DELETE FROM meta WHERE key IN ('indexed', 'indexed-at');
      `),
    }])
  }
  close() { this.db.close() }
  config() { return loadChallengeConfig(this.area) }
  private get clone() { return join(this.dir, 'repo') }
  private tx<T>(f: () => T): T { return transaction(this.db, f, 'challenge store') }
  private all<T>(sql: string, ...a: (string | number | null)[]): T[] { return this.db.prepare(sql).all(...a) as T[] }
  private one<T>(sql: string, ...a: (string | number | null)[]): T | undefined { return this.db.prepare(sql).get(...a) as T | undefined }
  private meta(key: string): string | null { return this.one<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null }
  private setMeta(key: string, value: string | null) {
    if (value === null) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key)
    else this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
  }
  private need(): ChallengeConfig {
    const c = this.config()
    if ('disabled' in c) throw new RequestError(503, c.disabled, { code: 'disabled' })
    return c
  }

  // ---- the repository ----------------------------------------------------------------

  private async g(args: string[], timeoutMs = 120_000) { return gitOk(this.clone, args, { env: await this.env(), config: IDENTITY, timeoutMs }) }
  private async gt(args: string[]) { return git(this.clone, args, { env: await this.env(), config: IDENTITY, timeoutMs: 120_000 }) }

  // The writer's clone of the configured repository, fetched. A clone of
  // another origin is rebuilt, never re-pointed. Returns the remote branch's
  // head, or null when the repository has no such branch yet (empty).
  private async fetched(c: ChallengeConfig): Promise<string | null> {
    const env = await this.env()
    if (existsSync(join(this.clone, '.git'))) {
      const was = await git(this.clone, ['remote', 'get-url', 'origin'], { env })
      const dest = (u: string) => u.replace(/\/\/[^@/]+@/, '//').replace(/\/+$/, '').replace(/\.git$/, '')
      if (was.code !== 0 || dest(was.stdout.trim()) !== c.destination) await rm(this.clone, { recursive: true, force: true })
    }
    if (!existsSync(join(this.clone, '.git'))) {
      await mkdir(this.clone, { recursive: true })
      await gitOk(this.clone, ['init', '-q'], { env })
      await gitOk(this.clone, ['remote', 'add', 'origin', c.url], { env })
    } else await this.g(['remote', 'set-url', 'origin', c.url])
    await this.g(['fetch', '-q', '--prune', 'origin', `+refs/heads/*:refs/remotes/origin/*`])
    const head = await this.gt(['rev-parse', '--verify', '-q', `refs/remotes/origin/${c.branch}`])
    this.setMeta('fetched', now())
    this.setMeta('fetch-error', null)
    return head.code === 0 ? head.stdout.trim() : null
  }

  // Brings the index to the remote's head (at most every SYNC_MS unless
  // forced). A remote that cannot be reached leaves the index as it was and
  // says so in status().
  async sync(o: { force?: boolean } = {}): Promise<void> {
    const c = this.config()
    if ('disabled' in c) return
    if (!o.force && Date.now() - this.lastSync < SYNC_MS) return
    this.lastSync = Date.now()
    try {
      await withLock(join(this.dir, 'writer'), async () => {
        const head = await this.fetched(c)
        if (head !== this.meta('indexed') || o.force) await this.reindexAt(head)
      }, { timeoutMs: 60_000, what: 'the challenge repository' })
    } catch (e) { this.setMeta('fetch-error', (e as Error).message) }
  }

  // Every file of the challenges at `rev` (all, or one), with its size.
  private async tree(rev: string, id: string | null): Promise<{ path: string; size: number }[]> {
    const out = await this.g(['ls-tree', '-r', '-l', '-z', '--full-tree', rev, '--', ...(id ? [`challenges/${id}`, `challenges/${id}.md`, `evidence/${id}`] : ['challenges', 'evidence'])])
    return out.split('\0').map(l => /^\d+ blob [0-9a-f]+\s+(\d+)\t([\s\S]+)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map(m => ({ path: m[2]!, size: Number(m[1]) }))
  }

  // Reads every challenge one commit has (all of them, or one) — its
  // summary, files and trials — with who created and last changed each from
  // one pass over the log.
  private async assemble(rev: string, only: string | null): Promise<Challenge[]> {
    const log = await this.history(rev, only)
    const out: Challenge[] = []
    for (const s of shapes(await this.tree(rev, only))) {
      if (only && s.id !== only) continue
      const read = async (path: string) => { const r = await this.gt(['show', `${rev}:${path}`]); return r.code === 0 ? r.stdout : null }
      out.push(await build(s, log, read))
    }
    return out
  }

  // Rebuilds the index from one commit of the clone (the remote head).
  private async reindexAt(head: string | null) {
    const records = head ? await this.assemble(head, null) : []
    this.tx(() => {
      this.db.exec('DELETE FROM records; DELETE FROM trials')
      const ins = this.db.prepare('INSERT INTO records (id, state, state_kind, projects, text, commit_id, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      const tri = this.db.prepare('INSERT INTO trials (challenge, name, text) VALUES (?, ?, ?)')
      for (const r of records) {
        ins.run(r.id, r.state, r.stateKind, JSON.stringify(r.projects), `${r.title}\n${r.body}`, r.commit, r.updated.at, JSON.stringify(r))
        for (const t of r.trials) tri.run(r.id, t.name, t.summary ? `${t.summary.title ?? ''}\n${t.summary.body}` : '')
      }
      this.setMeta('indexed', head ?? '')
      this.setMeta('indexed-at', now())
    })
  }

  // The log of the repository at `rev` (optionally of one challenge, in
  // either layout), newest first, with the actor and the trailers each
  // commit carries.
  private async history(rev: string, id: string | null): Promise<LogEntry[]> {
    const paths = id ? [`challenges/${id}`, `challenges/${id}.md`, `evidence/${id}`] : ['challenges', 'evidence']
    const out = await this.g(['log', '--no-renames', '--format=%x1e%H%x1f%an%x1f%aI%x1f%s%x1f%B%x1f', '--name-only', rev, '--', ...paths])
    const entries: LogEntry[] = []
    for (const chunk of out.split('\x1e').slice(1)) {
      const [commit, author, at, subject, message, rest] = chunk.split('\x1f')
      const trailers = trailersOf(message ?? '')
      entries.push({ commit: commit!, actor: trailers['Challenge-Actor'] ?? author!, at: at!, subject: subject!, trailers, paths: (rest ?? '').split('\n').map(s => s.trim()).filter(Boolean) })
    }
    return entries
  }

  // Every request the history at `rev` contains, with its commit (all
  // commits, whatever paths they touch).
  private async requests(rev: string): Promise<Map<string, string>> {
    const out = await this.g(['log', '--format=%x1e%H%x1f%B', rev])
    const m = new Map<string, string>()
    for (const chunk of out.split('\x1e').slice(1)) {
      const [commit, message] = chunk.split('\x1f')
      const r = trailersOf(message ?? '')['Challenge-Request']
      if (r && !m.has(r)) m.set(r, commit!.trim())
    }
    return m
  }

  async status() {
    const c = this.config()
    const ops = this.all<{ state: string; n: number }>('SELECT state, count(*) AS n FROM operations GROUP BY state')
    return {
      disabled: 'disabled' in c ? c.disabled : null,
      repository: 'disabled' in c ? null : { url: c.destination, web: c.web, branch: c.branch },
      head: this.meta('indexed') || null, indexed: this.meta('indexed-at'), fetched: this.meta('fetched'), problem: this.meta('fetch-error'),
      operations: Object.fromEntries(ops.map(o => [o.state, o.n])),
      mirrors: 'disabled' in c ? [] : c.mirrors.map(url => ({ url, ...JSON.parse(this.meta(`mirror:${url}`) ?? '{"commit": null, "at": null, "error": null}') as { commit: string | null; at: string | null; error: string | null } })),
      limits: { file: MAX_FILE, write: MAX_WRITE, files: MAX_FILES },
    }
  }

  // Pushes the published branch to each configured mirror whose copy is
  // behind what the index read. Best effort: a failure is recorded and
  // tried again at the next publication or reconcile.
  async mirror(): Promise<string[]> {
    const c = this.config()
    if ('disabled' in c || !c.mirrors.length) return []
    const head = this.meta('indexed')
    if (!head || !existsSync(join(this.clone, '.git'))) return []
    const notes: string[] = []
    for (const url of c.mirrors) {
      const was = JSON.parse(this.meta(`mirror:${url}`) ?? '{}') as { commit?: string | null; error?: string | null }
      if (was.commit === head && !was.error) continue
      const p = await git(this.clone, ['push', '-q', url, `${head}:refs/heads/${c.branch}`], { env: { ...await this.env(), ...(c.sshCommand ? { GIT_SSH_COMMAND: c.sshCommand } : {}) }, timeoutMs: 120_000 })
      const rec = p.code === 0 ? { commit: head, at: now(), error: null } : { commit: was.commit ?? null, at: now(), error: (p.stderr.trim() || `exit ${p.code}`).slice(0, 500) }
      this.setMeta(`mirror:${url}`, JSON.stringify(rec))
      notes.push(`challenge mirror ${url}: ${rec.error ? `failed — ${rec.error}` : `at ${head.slice(0, 12)}`}`)
    }
    return notes
  }

  // ---- reading -----------------------------------------------------------------------

  // Published challenges by text, project and state, newest change first;
  // with counts per state kind (for the same text and project), the custom
  // states seen and every project named. Text matches a challenge's id,
  // title, summary and projects, and its trials' names and summaries; the
  // trials that matched are named (`matches`). Files are not searched.
  list(q: { text?: string; project?: string; state?: string; limit?: number; offset?: number } = {}) {
    const where: string[] = []
    const args: string[] = []
    const words = q.text?.trim() ? q.text.trim().split(/\s+/).slice(0, 8) : []
    const likes = words.map(w => `%${w.replace(/[\\%_]/g, c => `\\${c}`)}%`)
    for (const like of likes) {
      where.push('(id LIKE ? ESCAPE \'\\\' OR text LIKE ? ESCAPE \'\\\' OR projects LIKE ? ESCAPE \'\\\' OR EXISTS (SELECT 1 FROM trials t WHERE t.challenge = records.id AND (t.name LIKE ? ESCAPE \'\\\' OR t.text LIKE ? ESCAPE \'\\\')))')
      args.push(like, like, like, like, like)
    }
    if (q.project) { where.push('EXISTS (SELECT 1 FROM json_each(records.projects) WHERE value = ?)'); args.push(q.project) }
    const base = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const counts = { open: 0, resolved: 0, withdrawn: 0, custom: 0, unspecified: 0 } as Record<StateKind, number>
    for (const r of this.all<{ k: string; n: number }>(`SELECT state_kind AS k, count(*) AS n FROM records ${base} GROUP BY state_kind`, ...args)) counts[r.k as StateKind] = r.n
    const custom = this.all<{ state: string; n: number }>(`SELECT state, count(*) AS n FROM records ${base ? `${base} AND` : 'WHERE'} state_kind = 'custom' GROUP BY state ORDER BY state`, ...args).map(r => ({ state: r.state, count: r.n }))
    // A state filter: a kind (open, resolved, withdrawn, custom, unspecified), all, or one custom state exactly.
    const state = q.state ?? 'all'
    const [filtered, fargs] = state === 'all' ? [base, []] : [`${base ? `${base} AND` : 'WHERE'} ${(STATE_FILTERS as readonly string[]).includes(state) ? 'state_kind' : 'state'} = ?`, [state]]
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500)
    const offset = Math.max(q.offset ?? 0, 0)
    const rows = this.all<RecordRow>(`SELECT * FROM records ${filtered} ORDER BY updated_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, ...args, ...fargs)
    const total = this.one<{ n: number }>(`SELECT count(*) AS n FROM records ${filtered}`, ...args, ...fargs)!.n
    const projects = this.all<{ value: string; n: number }>('SELECT value, count(*) AS n FROM records, json_each(records.projects) GROUP BY value ORDER BY value').map(r => ({ project: r.value, count: r.n }))
    const challenges = rows.map(r => {
      const c = JSON.parse(r.data) as Challenge
      if (!likes.length) return c
      const lower = words.map(w => w.toLowerCase())
      const matches = c.trials.filter(t => lower.some(w => t.name.toLowerCase().includes(w) || (t.summary && `${t.summary.title ?? ''}\n${t.summary.body}`.toLowerCase().includes(w))))
        .map(t => ({ trial: t.name, title: t.summary?.title ?? null, excerpt: t.summary ? excerpt(t.summary.body, lower) : null }))
      return { ...c, matches }
    })
    return { counts, custom, total, offset, projects, challenges }
  }

  // The current challenge (the index, at the remote head it last read).
  current(id: string): Challenge | null {
    const r = this.one<RecordRow>('SELECT * FROM records WHERE id = ?', id)
    return r ? JSON.parse(r.data) as Challenge : null
  }

  // The challenge as one commit has it: `at` names a commit (abbreviated or
  // full) at or after one of its revisions. Everything — summary, files,
  // trials, who created and last changed it — is read from that commit's
  // tree and history, in the layout it has there; nothing newer is mixed in.
  async at(id: string, at: string): Promise<Challenge> {
    validId(id)
    const c = this.need()
    if (!/^[0-9a-f]{4,64}$/i.test(at)) throw new RequestError(400, `${at} is not a commit id`)
    return withLock(join(this.dir, 'writer'), async () => {
      if (!existsSync(join(this.clone, '.git')) || (await this.gt(['cat-file', '-e', `${at}^{commit}`])).code !== 0) await this.fetched(c)
      const full = await this.gt(['rev-parse', '--verify', '-q', `${at}^{commit}`])
      if (full.code !== 0) throw new RequestError(404, `no commit ${at} in the challenge repository`)
      const commit = full.stdout.trim()
      const [r] = await this.assemble(commit, id)
      if (!r) {
        if (!(await this.history(commit, id)).length) throw new RequestError(404, `${id} has no revision at or before ${commit.slice(0, 12)}`)
        throw new RequestError(404, `${id} does not exist at ${commit.slice(0, 12)} (it was removed there)`)
      }
      return r
    }, { timeoutMs: 60_000, what: 'the challenge repository' })
  }

  // What a run is given for a revision: its summary as written, or — when it
  // has none — a note naming its files and how to read them.
  async text(id: string, commit: string): Promise<string> {
    const r = await this.at(id, commit)
    return r.summary ? this.g(['show', `${r.commit}:${r.path}`]) : noSummaryText(r)
  }

  // One file's bytes, by its name in the challenge's directory or its
  // repository path, at the current revision or at `at`.
  async file(id: string, ref: { name?: string; path?: string }, at?: string): Promise<{ bytes: Buffer; commit: string; name: string; path: string }> {
    validId(id)
    const rec = at ? await this.at(id, at) : this.current(id)
    if (!rec) throw new RequestError(404, `no challenge ${id}`)
    const f = allFiles(rec).find(e => ref.path !== undefined ? e.path === ref.path : e.name === ref.name?.replace(/^\.\/+/, ''))
    if (!f) throw new RequestError(404, `${id} has no file ${ref.path ?? ref.name} at ${rec.commit.slice(0, 12)}`)
    const r = await gitBytes(this.clone, ['show', `${rec.commit}:${f.path}`], { env: await this.env() })
    if (r.code !== 0) throw new RequestError(404, `${f.path} cannot be read at ${rec.commit.slice(0, 12)}`)
    return { bytes: r.stdout, commit: rec.commit, name: f.name, path: f.path }
  }

  // Every revision of one challenge (or of one of its trials), newest
  // first: who (the actor), when, what the request was, the run and source it
  // came from, the paths it changed, and the title and state the summary has
  // there.
  async log(id: string, o: { trial?: string } = {}) {
    validId(id)
    const c = this.need()
    const trial = o.trial !== undefined ? trialName(o.trial) : null
    return withLock(join(this.dir, 'writer'), async () => {
      const head = await this.fetched(c)
      if (!head) return []
      const out = []
      for (const e of await this.history(head, id)) {
        const paths = trial ? e.paths.filter(p => p.startsWith(`challenges/${id}/${WEDO}/${trial}/`)) : e.paths
        if (!paths.length) continue
        let r: ReturnType<typeof parseRecord> | null = null
        for (const p of [`challenges/${id}/${SUMMARY}`, `challenges/${id}.md`]) {
          const t = await this.gt(['show', `${e.commit}:${p}`])
          if (t.code === 0) { r = parseRecord(id, t.stdout); break }
        }
        out.push({ commit: e.commit, at: e.at, actor: e.actor, subject: e.subject, request: e.trailers['Challenge-Request'] ?? null, onBehalfOf: e.trailers['Challenge-On-Behalf-Of'] ?? null,
          run: e.trailers['Challenge-Run'] ?? null, attempt: e.trailers['Challenge-Attempt'] ?? null, source: e.trailers['Challenge-Source'] ?? null, via: e.trailers['Challenge-Via'] ?? null,
          trial: e.trailers['Challenge-Trial'] ?? null, title: r?.title ?? null, state: r?.state ?? null, paths })
      }
      return out
    }, { timeoutMs: 60_000, what: 'the challenge repository' })
  }

  // ---- the journal -------------------------------------------------------------------

  private opOf(r: OperationRow): Operation {
    const files = JSON.parse(r.evidence) as Operation['files']
    const drop = JSON.parse(r.drop_names) as string[]
    const fields = JSON.parse(r.fields) as Partial<Fields>
    const paths = r.paths ? JSON.parse(r.paths) as string[] : opPaths(r.challenge, r.kind, fields, files.map(f => f.name), drop)
    return {
      id: r.id, request: r.request, kind: r.kind, challenge: r.challenge, base: r.base, fields, files, drop, paths, trial: trialOf(r.challenge, paths),
      actor: r.actor, onBehalfOf: r.on_behalf, run: r.run, attempt: r.attempt,
      source: r.source ? JSON.parse(r.source) as Source : null, via: r.via, note: r.note, state: r.state, commit: r.commit_id, current: r.current, error: r.error, tries: r.tries, created: r.created, updated: r.updated,
    }
  }
  operation(id: number): Operation | null { const r = this.one<OperationRow>('SELECT * FROM operations WHERE id = ?', id); return r ? this.opOf(r) : null }
  operations(o: { open?: boolean; challenge?: string } = {}): Operation[] {
    const where = [o.open ? `state IN (${OPEN_OPS.map(s => `'${s}'`).join(', ')})` : null, o.challenge ? 'challenge = ?' : null].filter(Boolean)
    return this.all<OperationRow>(`SELECT * FROM operations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 200`, ...(o.challenge ? [o.challenge] : [])).map(r => this.opOf(r))
  }
  private byRequest(request: string): Operation | null { const r = this.one<OperationRow>('SELECT * FROM operations WHERE request = ?', request); return r ? this.opOf(r) : null }

  // The next identity: past every allocated id published, journaled or
  // present in the remote head the index read. Taken inside the journal's
  // write transaction, so two writers never take one id.
  private nextId(): string {
    const ids = [
      ...this.all<{ id: string }>('SELECT id FROM records'),
      ...this.all<{ id: string }>('SELECT challenge AS id FROM operations WHERE kind = \'create\''),
    ].map(r => Number(ALLOCATED.exec(r.id)?.[1] ?? 0))
    return `ch-${String(Math.max(0, ...ids) + 1).padStart(4, '0')}`
  }

  private validate(f: Partial<Fields>) {
    if (f.title !== undefined) {
      if (!f.title.trim()) throw new RequestError(400, 'a challenge needs a title')
      if (/[\r\n]/.test(f.title.trim()) || f.title.trim().length > MAX_TITLE) throw new RequestError(400, `a title is one line of at most ${MAX_TITLE} characters`)
    }
    if (f.state !== undefined && f.state !== null && !STATE.test(f.state.trim())) throw new RequestError(400, `a state is one line of at most 60 characters (the standard ones: ${CHALLENGE_STATES.join(', ')})`)
    if (f.projects !== undefined && (!Array.isArray(f.projects) || !f.projects.every(p => typeof p === 'string' && PROJECT.test(p)))) throw new RequestError(400, 'projects are project ids (lower-case letters, digits, . _ -)')
    if (f.body !== undefined && f.body.length > MAX_BODY) throw new RequestError(413, `a body is at most ${MAX_BODY} characters`)
  }
  // Files by name in the challenge's directory (under `prefix`, a trial's
  // directory): safe names, each once, within the size limits.
  private validFiles(files: AddFile[], drop: string[], prefix: string): { files: AddFile[]; drop: string[] } {
    if (files.length + drop.length > MAX_FILES) throw new RequestError(413, `one write changes at most ${MAX_FILES} files`)
    const names = new Set<string>()
    let total = 0
    const out = files.map(f => {
      const name = prefix + materialName(f.name)
      if (names.has(name)) throw new RequestError(400, `"${name}" is named twice`)
      if (f.bytes.length > MAX_FILE) throw new RequestError(413, `"${name}" is ${f.bytes.length} bytes; a file is at most ${MAX_FILE} (the repository has no large-file storage: keep larger files in a durable store and link them)`)
      names.add(name)
      total += f.bytes.length
      return { name, bytes: f.bytes }
    })
    if (total > MAX_WRITE) throw new RequestError(413, `one write adds at most ${MAX_WRITE} bytes (this one: ${total}); publish in several writes`)
    const gone = drop.map(d => { const name = prefix + materialName(d); if (names.has(name)) throw new RequestError(400, `"${name}" is both added and dropped`); return name })
    for (const n of [...names, ...gone]) if (n.split('/').some((_, i, a) => names.has(a.slice(0, i).join('/')))) throw new RequestError(400, `"${n}" is inside a file this write adds`)
    return { files: out, drop: gone }
  }
  private validActor(a: Actor) {
    if (!ACTOR.test(a.by.trim())) throw new RequestError(400, 'who writes (by) is a name of one line')
    if (a.onBehalfOf && !ACTOR.test(a.onBehalfOf)) throw new RequestError(400, 'on behalf of is a name of one line')
  }

  private journal(o: { request: string; kind: 'create' | 'edit'; challenge?: string; base: string | null; fields: Partial<Fields>; files: AddFile[]; drop: string[]; actor: Actor; source?: Source | null; note?: string }): { operation: Operation; duplicate: boolean } {
    return this.tx(() => {
      const seen = this.byRequest(o.request)
      if (seen) return { operation: seen, duplicate: true }
      const challenge = o.challenge ?? this.nextId()
      const paths = opPaths(challenge, o.kind, o.fields, o.files.map(f => f.name), o.drop)
      if (o.kind === 'edit') {
        // Writes of one challenge wait for each other only when they change
        // the same paths: two trials added at once are independent.
        const mine = new Set(paths)
        const open = this.all<OperationRow>(`SELECT * FROM operations WHERE challenge = ? AND state IN (${OPEN_OPS.map(s => `'${s}'`).join(', ')}) ORDER BY id`, challenge).map(r => this.opOf(r))
        const clash = open.find(x => x.paths.some(p => mine.has(p) || [...mine].some(m => m.startsWith(`${p}/`) || p.startsWith(`${m}/`))))
        if (clash) throw new RequestError(409, `${challenge}: operation ${clash.id} (${clash.state}) changes the same files and is not published yet: retry or discard it first (wfe challenge ops)`, { code: 'pending-edit', operation: clash })
      }
      const blobs = this.db.prepare('INSERT INTO blobs (sha256, bytes) VALUES (?, ?) ON CONFLICT (sha256) DO NOTHING')
      const files = o.files.map(e => { const h = sha256(e.bytes); blobs.run(h, e.bytes); return { name: e.name, sha256: h, size: e.bytes.length } })
      const at = now()
      const id = Number(this.db.prepare('INSERT INTO operations (request, kind, challenge, base, fields, evidence, drop_names, paths, actor, on_behalf, run, attempt, source, via, note, state, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'pending\', ?, ?)')
        .run(o.request, o.kind, challenge, o.base, JSON.stringify(o.fields), JSON.stringify(files), JSON.stringify(o.drop), JSON.stringify(paths), o.actor.by.trim(), o.actor.onBehalfOf ?? null, o.actor.run ?? null, o.actor.attempt ?? null,
          o.source ? JSON.stringify(o.source) : null, o.actor.via, o.note?.trim() ?? '', at, at).lastInsertRowid)
      return { operation: this.operation(id)!, duplicate: false }
    })
  }

  // A new challenge: its directory with a summary and any files (source
  // material, by name in the directory). The identity is allocated here and
  // never changes.
  async create(i: CreateInput): Promise<Accepted> {
    this.need()
    if (!REQUEST.test(i.request)) throw new RequestError(400, 'a write needs a request identity (8–200 of A-Z a-z 0-9 : . _ / # -)')
    this.validActor(i)
    const fields: Fields = { title: i.title.trim(), state: (i.state ?? 'open').trim(), projects: [...new Set(i.projects ?? [])], body: normalizeBody(i.body) }
    this.validate(fields)
    const f = this.validFiles(i.files ?? [], [], '')
    if (f.files.some(x => x.name === SUMMARY)) throw new RequestError(400, `${SUMMARY} is the summary itself: give its fields, not a file`)
    const seen = this.byRequest(i.request)
    if (seen) return this.accepted({ operation: seen, duplicate: true })
    await this.sync()
    const j = this.journal({ request: i.request, kind: 'create', base: null, fields, files: f.files, drop: [], actor: i, source: i.source, note: i.note })
    return this.accepted(j)
  }

  // An edit: summary fields given change in the summary (and nothing else of
  // it); files are added, replaced or dropped. It is refused at once, with
  // the current revision, when one of the paths it changes changed since
  // `base` — an edit elsewhere in the challenge (another trial, say) is no
  // conflict. Without a base every file must be new.
  async edit(id: string, i: EditInput): Promise<Accepted> {
    validId(id)
    this.need()
    if (!REQUEST.test(i.request)) throw new RequestError(400, 'a write needs a request identity (8–200 of A-Z a-z 0-9 : . _ / # -)')
    this.validActor(i)
    const seen = this.byRequest(i.request)
    if (seen) return this.accepted({ operation: seen, duplicate: true })
    const prefix = i.trial !== undefined ? `${WEDO}/${trialName(i.trial)}/` : ''
    const given: Partial<Fields> = {
      ...(i.title !== undefined ? { title: i.title.trim() } : {}), ...(i.state !== undefined ? { state: i.state.trim() } : {}),
      ...(i.projects !== undefined ? { projects: [...new Set(i.projects)] } : {}), ...(i.body !== undefined ? { body: normalizeBody(i.body) } : {}),
    }
    this.validate(given)
    const f = this.validFiles(i.files ?? [], i.drop ?? [], prefix)
    await this.sync({ force: true })
    const cur = this.current(id)
    if (!cur) {
      const pending = this.all<OperationRow>('SELECT * FROM operations WHERE challenge = ? AND kind = \'create\' AND state != \'published\'', id)
      throw new RequestError(pending.length ? 409 : 404, pending.length ? `${id} is not published yet (operation ${pending[0].id}, ${pending[0].state}); it can be edited once it is` : `no challenge ${id}`, { code: pending.length ? 'unpublished' : 'missing' })
    }
    if (cur.layout === 'legacy') throw new RequestError(409, `${id} is in the layout before challenge p3 (challenges/${id}.md); it is read, never written: move it to challenges/${id}/ first`, { code: 'legacy-layout' })
    const fields = Object.fromEntries(Object.entries(given).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(cur[k as keyof Fields]))) as Partial<Fields>
    const changesSummary = Object.keys(fields).length > 0
    if (changesSummary && f.files.some(x => x.name === SUMMARY)) throw new RequestError(400, `the summary's fields and its file are given together: give one`)
    if (changesSummary && f.drop.includes(SUMMARY)) throw new RequestError(400, 'the summary is changed and dropped at once')
    if (changesSummary && cur.summary && /not YAML/.test(cur.problem ?? '')) throw new RequestError(409, `${id}'s summary frontmatter is not YAML (${cur.problem}); its fields cannot be changed one by one: replace ${SUMMARY} as a file`, { code: 'unreadable-summary' })
    const names = new Set(allFiles(cur).map(x => x.name))
    for (const d of f.drop) if (!names.has(d)) throw new RequestError(400, `${id} has no file ${d}`)
    if (!changesSummary && !f.files.length && !f.drop.length) throw new RequestError(400, `the edit changes nothing in ${id}`, { code: 'unchanged' })
    const paths = opPaths(id, 'edit', fields, f.files.map(x => x.name), f.drop)
    let base: string | null = null
    if (i.base) {
      base = await this.resolveCommit(i.base)
      const changed = await this.changedSince(base, `refs/remotes/origin/${this.need().branch}`, paths)
      if (changed) throw new RequestError(409, `${id} changed since ${i.base.slice(0, 12)} where this edit writes (${changed.paths.slice(0, 5).join(', ')}): its current revision is ${cur.commit.slice(0, 12)} (${cur.updated.by}, ${cur.updated.at}). Read it again and apply your change to it; nothing was written.`, { code: 'conflict', current: cur, changed: changed.paths })
    } else {
      if (changesSummary || f.drop.length) throw new RequestError(400, 'an edit of the summary, or one that drops files, names the revision it was based on (base: the commit show prints)')
      const existing = f.files.filter(x => names.has(x.name)).map(x => x.name)
      if (existing.length) throw new RequestError(409, `${existing.slice(0, 5).join(', ')} already exist in ${id}: read the challenge and name the revision you replace (base)`, { code: 'conflict', current: cur, changed: existing.map(n => `challenges/${id}/${n}`) })
    }
    const j = this.journal({ request: i.request, kind: 'edit', challenge: id, base, fields, files: f.files, drop: f.drop, actor: i, source: i.source, note: i.note })
    return this.accepted(j)
  }

  private async resolveCommit(rev: string): Promise<string> {
    if (!/^[0-9a-f]{4,64}$/i.test(rev)) throw new RequestError(400, `base ${rev} is not a commit id (the revision you read: wfe challenge show prints it)`)
    const r = existsSync(join(this.clone, '.git')) ? await this.gt(['rev-parse', '--verify', '-q', `${rev}^{commit}`]) : { code: 1, stdout: '' }
    if (r.code !== 0) throw new RequestError(409, `base ${rev} is no revision of the challenge repository`, { code: 'conflict' })
    return r.stdout.trim()
  }

  // Whether any of `paths` changed between `base` and `head` (or `base` is
  // not in head's history): the newest commit that changed them, and which.
  private async changedSince(base: string, head: string, paths: string[]): Promise<{ commit: string | null; paths: string[] } | null> {
    if ((await this.gt(['merge-base', '--is-ancestor', base, head])).code !== 0) return { commit: (await this.gt(['rev-parse', head])).stdout.trim() || null, paths }
    const out = await this.g(['log', '--no-renames', '--format=%x1e%H', '--name-only', `${base}..${head}`, '--', ...paths])
    const chunks = out.split('\x1e').slice(1)
    if (!chunks.length) return null
    const touched = new Set(chunks.flatMap(c => c.split('\n').slice(1).map(s => s.trim()).filter(Boolean)))
    return { commit: chunks[0]!.split('\n')[0]!.trim(), paths: [...touched] }
  }

  private async accepted(j: { operation: Operation; duplicate: boolean }): Promise<Accepted> {
    if (OPEN_OPS.includes(j.operation.state) && j.operation.state !== 'conflict') await this.publish()
    const op = this.operation(j.operation.id)!
    const c = this.config()
    return { operation: op, duplicate: j.duplicate, record: op.state === 'published' ? this.current(op.challenge) : null, publication: { state: op.state, commit: op.commit, error: op.error, repository: 'disabled' in c ? null : c.web ?? c.destination } }
  }

  retry(id: number): Promise<Operation> {
    const op = this.operation(id)
    if (!op) throw new RequestError(404, `no operation ${id}`)
    if (op.state === 'conflict') throw new RequestError(409, `operation ${id} conflicts with a newer revision ${op.current?.slice(0, 12) ?? ''}: apply the draft to it as a new edit, or discard it`, { code: 'conflict', operation: op })
    return this.publish().then(() => this.operation(id)!)
  }

  // A draft's file, kept in the journal until its operation is published.
  draftFile(id: number, name: string): Buffer {
    const op = this.operation(id)
    if (!op) throw new RequestError(404, `no operation ${id}`)
    const f = op.files.find(x => x.name === name)
    const blob = f && this.one<{ bytes: Uint8Array }>('SELECT bytes FROM blobs WHERE sha256 = ?', f.sha256)
    if (!blob) throw new RequestError(404, `operation ${id} keeps no file ${name}${op.state === 'published' ? ' (published: read it from the challenge)' : ''}`)
    return Buffer.from(blob.bytes)
  }

  // Drops an operation that is not published (a conflicting draft, or one
  // that should not be written after all). Its draft stays readable here.
  discard(id: number, o: { by: string; reason: string }): Operation {
    const op = this.operation(id)
    if (!op) throw new RequestError(404, `no operation ${id}`)
    if (!OPEN_OPS.includes(op.state) && op.state !== 'refused') throw new RequestError(409, `operation ${id} is ${op.state}: only one not published can be discarded`)
    this.db.prepare('UPDATE operations SET state = \'discarded\', error = ?, updated = ? WHERE id = ?').run(`discarded by ${o.by}: ${o.reason}`, now(), id)
    return this.operation(id)!
  }

  // ---- publication ---------------------------------------------------------------------

  // Publishes every operation not yet confirmed (pending, unsynced), oldest
  // first, in one push. See the head of this file.
  async publish(): Promise<{ published: number[]; failed: { id: number; error: string }[]; conflicts: number[]; refused: number[] }> {
    const c = this.need()
    const result = { published: [] as number[], failed: [] as { id: number; error: string }[], conflicts: [] as number[], refused: [] as number[] }
    if (!this.one('SELECT 1 FROM operations WHERE state IN (\'pending\', \'unsynced\')')) return result
    return withLock(join(this.dir, 'writer'), async () => {
      const due = () => this.all<OperationRow>('SELECT * FROM operations WHERE state IN (\'pending\', \'unsynced\') ORDER BY id').map(r => this.opOf(r))
      let ops = due()
      if (!ops.length) return result
      const at = now()
      for (const op of ops) this.db.prepare('UPDATE operations SET tries = tries + 1, updated = ? WHERE id = ?').run(at, op.id)
      try {
        for (let round = 1; ; round++) {
          const head = await this.fetched(c)
          // The clone starts from the remote's state every round.
          if ((await this.gt(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0) await this.g(['reset', '-q', '--hard'])
          await this.g(['clean', '-qfdx'])
          if (head) await this.g(['checkout', '-q', '-f', '-B', c.branch, head])
          else {
            await this.gt(['update-ref', '-d', `refs/heads/${c.branch}`])
            await this.g(['symbolic-ref', 'HEAD', `refs/heads/${c.branch}`])
            await this.g(['read-tree', '--empty'])
            await this.g(['clean', '-qfdx'])
          }
          const seen = head ? await this.requests(head) : new Map<string, string>()
          const made: Operation[] = []
          ops = due()
          for (const op of ops) {
            // Already in the remote history: a crash after the push, or a push
            // whose outcome was not seen. Recorded, never written again.
            const there = seen.get(op.request)
            if (there) { this.mark(op.id, 'published', { commit: there }); result.published.push(op.id); continue }
            const dir = join(this.clone, 'challenges', op.challenge)
            const exists = existsSync(dir) || existsSync(join(this.clone, 'challenges', `${op.challenge}.md`))
            if (op.kind === 'create' && exists) {
              this.mark(op.id, 'refused', { error: `${op.challenge} already exists in the repository (written outside this journal); the draft is kept here (wfe challenge ops)` })
              result.refused.push(op.id); continue
            }
            if (op.kind === 'edit') {
              const committed = (await this.gt(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0
              const why = !existsSync(dir) ? (exists ? `${op.challenge} is in the layout before challenge p3 there` : `${op.challenge} was removed from the repository`)
                : op.base ? (committed ? await this.changedSince(op.base, 'HEAD', op.paths) : { commit: null, paths: op.paths })
                  : await this.existingDiffer(op)
              if (why) {
                const what = typeof why === 'string' ? why : `${op.challenge} changed on the remote where this edit writes (${why.paths.slice(0, 5).join(', ')})${op.base ? ` after ${op.base.slice(0, 12)}` : ''}; the draft is kept`
                this.mark(op.id, 'conflict', { current: typeof why === 'string' ? null : why.commit, error: what })
                result.conflicts.push(op.id); continue
              }
            }
            const summaryFile = join(dir, SUMMARY)
            let prior: Fields | null = null
            if (Object.keys(op.fields).length) {
              const text = existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : null
              prior = text === null ? null : parseRecord(op.challenge, text)
              safeTarget(this.clone, summaryFile)
              await mkdir(dir, { recursive: true })
              await writeFile(summaryFile, op.kind === 'create' || text === null ? renderRecord(op.challenge, op.fields) : updateSummary(op.challenge, text, op.fields))
            }
            for (const e of op.files) {
              const blob = this.one<{ bytes: Uint8Array }>('SELECT bytes FROM blobs WHERE sha256 = ?', e.sha256)
              if (!blob) throw new Error(`operation ${op.id}: the bytes of ${e.name} are missing from the journal`)
              const p = join(dir, e.name)
              safeTarget(this.clone, p)
              await mkdir(dirname(p), { recursive: true })
              await writeFile(p, Buffer.from(blob.bytes))
            }
            for (const d of op.drop) {
              const p = join(dir, d)
              safeTarget(this.clone, p)
              if (existsSync(p)) await unlink(p)
            }
            await this.g(['add', '-A', '--', ...op.paths])
            const state = op.fields.state
            const verb = op.kind === 'create' ? 'Record'
              : state !== undefined && prior?.state !== state ? ({ open: 'Reopen', resolved: 'Resolve', withdrawn: 'Withdraw' } as Record<string, string>)[state ?? ''] ?? `Set state ${JSON.stringify(state)} of`
                : Object.keys(op.fields).length ? 'Edit' : op.trial ? 'Record work in' : 'Update files of'
            const what = op.kind === 'create' || Object.keys(op.fields).length ? (op.fields.title ?? prior?.title ?? op.challenge) : op.trial ? `${WEDO}/${op.trial}` : `${[...op.files.map(f => f.name), ...op.drop].slice(0, 3).join(', ')}${op.files.length + op.drop.length > 3 ? ', …' : ''}`
            const trailers = [
              `Challenge-Id: ${op.challenge}`, `Challenge-Request: ${op.request}`, `Challenge-Actor: ${op.actor}`,
              ...(op.onBehalfOf ? [`Challenge-On-Behalf-Of: ${op.onBehalfOf}`] : []), ...(op.base ? [`Challenge-Base: ${op.base}`] : []),
              ...(op.trial ? [`Challenge-Trial: ${op.trial}`] : []),
              ...(op.run ? [`Challenge-Run: ${op.run}`] : []), ...(op.attempt ? [`Challenge-Attempt: ${op.attempt}`] : []),
              ...(op.source ? [`Challenge-Source: conversation ${op.source.conversation}#${op.source.message}`] : []), `Challenge-Via: ${op.via}`,
            ]
            const message = [`${verb} ${op.challenge}: ${what}`, ...(op.note ? [op.note] : []), trailers.join('\n')]
            const email = `${op.actor.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'someone'}@agdev.invalid`
            await gitOk(this.clone, ['commit', '-q', '--allow-empty', ...message.flatMap(m => ['-m', m])], { env: { ...await this.env(), GIT_AUTHOR_NAME: op.actor, GIT_AUTHOR_EMAIL: email }, config: IDENTITY })
            made.push(op)
          }
          if (made.length) {
            await this.hooks.beforePush?.()
            const p = await git(this.clone, ['push', '-q', 'origin', `HEAD:refs/heads/${c.branch}`], { env: await this.env(), timeoutMs: 180_000 })
            if (p.code !== 0) {
              if (round < 3 && /non-fast-forward|fetch first|rejected/.test(p.stderr)) continue
              throw new Error(`push failed: ${p.stderr.trim() || p.stdout.trim() || `exit ${p.code}`}`)
            }
            await this.hooks.afterPush?.()
            // What the remote has now is what is recorded: read it back.
            const after = await this.fetched(c)
            const seen2 = after ? await this.requests(after) : new Map<string, string>()
            for (const op of made) {
              const commit = seen2.get(op.request)
              if (commit) { this.mark(op.id, 'published', { commit }); result.published.push(op.id) }
              else { this.mark(op.id, 'unsynced', { error: 'pushed, but the remote history does not show it; it is looked for again before any retry' }); result.failed.push({ id: op.id, error: 'not seen after the push' }) }
            }
            await this.reindexAt(after)
            await this.mirror()
          } else if (head !== this.meta('indexed')) await this.reindexAt(head)
          return result
        }
      } catch (e) {
        const error = (e as Error).message
        for (const op of due()) { this.mark(op.id, 'unsynced', { error }); result.failed.push({ id: op.id, error }) }
        return result
      }
    }, { timeoutMs: 120_000, what: 'the challenge repository' })
  }

  // An edit without a base adds only new files: one that exists now with
  // other bytes was written by someone else first.
  private async existingDiffer(op: Operation): Promise<{ commit: string | null; paths: string[] } | null> {
    const clash: string[] = []
    for (const f of op.files) {
      const p = join(this.clone, 'challenges', op.challenge, f.name)
      if (existsSync(p) && sha256(readFileSync(p)) !== f.sha256) clash.push(`challenges/${op.challenge}/${f.name}`)
    }
    if (!clash.length) return null
    return { commit: (await this.gt(['log', '-1', '--format=%H', 'HEAD', '--', ...clash])).stdout.trim() || null, paths: clash }
  }

  private mark(id: number, state: OperationState, o: { commit?: string; current?: string | null; error?: string }) {
    this.tx(() => {
      this.db.prepare('UPDATE operations SET state = ?, commit_id = COALESCE(?, commit_id), current = ?, error = ?, updated = ? WHERE id = ?').run(state, o.commit ?? null, o.current ?? null, o.error ?? null, now(), id)
      // Published bytes live in the repository; the journal keeps only those
      // of operations not published (a conflicting or refused draft included).
      if (state === 'published') {
        const kept = new Set(this.all<{ evidence: string }>('SELECT evidence FROM operations WHERE state != \'published\'').flatMap(r => (JSON.parse(r.evidence) as { sha256: string }[]).map(e => e.sha256)))
        for (const b of this.all<{ sha256: string }>('SELECT sha256 FROM blobs')) if (!kept.has(b.sha256)) this.db.prepare('DELETE FROM blobs WHERE sha256 = ?').run(b.sha256)
      }
    })
  }

  // What a message or a run is given for a challenge: its revision (the
  // current one, or the named commit), title and the hash of its text.
  async pin(id: string, at?: string): Promise<{ id: string; commit: string; title: string; state: string | null; sha256: string }> {
    validId(id)
    if (at) { const r = await this.at(id, at); return { id, commit: r.commit, title: r.title, state: r.state, sha256: r.sha256 } }
    await this.sync()
    const r = this.current(id)
    if (!r) {
      const pending = this.all<OperationRow>('SELECT id, state FROM operations WHERE challenge = ? AND kind = \'create\' AND state != \'published\'', id)
      throw new RequestError(pending.length ? 409 : 404, pending.length ? `${id} is not published yet: it can be attached once it is` : `no challenge ${id}`, { code: pending.length ? 'unpublished' : 'missing' })
    }
    return { id, commit: r.commit, title: r.title, state: r.state, sha256: r.sha256 }
  }
}

interface LogEntry { commit: string; actor: string; at: string; subject: string; trailers: Record<string, string>; paths: string[] }

function validId(id: string) { if (!CHALLENGE_ID.test(id)) throw new RequestError(400, `"${id}" is not a challenge id (ch-0001, or the name of its directory)`) }
const normalizeBody = (b: string) => b.replace(/\r\n/g, '\n').replace(/\s+$/, '')

function trailersOf(message: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of message.split('\n')) { const m = /^(Challenge-[A-Za-z-]+): (.*)$/.exec(line.trim()); if (m) out[m[1]] = m[2] }
  return out
}

// The repository paths an operation changes.
function opPaths(id: string, kind: 'create' | 'edit', fields: Partial<Fields>, files: string[], drop: string[]): string[] {
  const dir = `challenges/${id}`
  return [...new Set([...(kind === 'create' || Object.keys(fields).length ? [`${dir}/${SUMMARY}`] : []), ...files.map(n => `${dir}/${n}`), ...drop.map(n => `${dir}/${n}`)])]
}
function trialOf(id: string, paths: string[]): string | null {
  const names = new Set(paths.map(p => p.startsWith(`challenges/${id}/${WEDO}/`) ? p.slice(`challenges/${id}/${WEDO}/`.length).split('/') : null).map(s => s && s.length > 1 ? s[0]! : null))
  return names.size === 1 ? [...names][0]! : null
}

// Refuses to write through a symbolic link: a file's every directory inside
// the clone must be a plain directory (or not exist yet), and the file itself
// not a link, so nothing is written outside the challenge's directory.
function safeTarget(clone: string, file: string) {
  const root = resolve(clone)
  const abs = resolve(file)
  if (!abs.startsWith(`${root}/challenges/`)) throw new Error(`${file} is outside the challenge directories`)
  let p = abs
  while (p.length > root.length) {
    let st
    try { st = lstatSync(p) } catch { p = dirname(p); continue }
    if (st.isSymbolicLink()) throw new Error(`${p.slice(root.length + 1)} is a symbolic link in the repository: nothing is written through it`)
    p = dirname(p)
  }
}

// ---- the layout ------------------------------------------------------------------------

interface Shape { id: string; layout: 'directory' | 'legacy'; summaryPath: string; summary: boolean; files: MaterialFile[]; problem?: string }

// Groups a tree's files into challenges: `challenges/<id>/…` (a directory),
// or before challenge p3 `challenges/<id>.md` with `evidence/<id>/…`.
function shapes(tree: { path: string; size: number }[]): Shape[] {
  const dirs = new Map<string, MaterialFile[]>()
  const legacy = new Map<string, { md: boolean; files: MaterialFile[] }>()
  const leg = (id: string) => { let l = legacy.get(id); if (!l) legacy.set(id, l = { md: false, files: [] }); return l }
  for (const f of tree) {
    const parts = f.path.split('/')
    if (parts[0] === 'challenges' && parts.length >= 3 && CHALLENGE_ID.test(parts[1]!)) dirs.set(parts[1]!, [...dirs.get(parts[1]!) ?? [], { name: parts.slice(2).join('/'), path: f.path, size: f.size }])
    else if (parts[0] === 'challenges' && parts.length === 2 && parts[1]!.endsWith('.md') && CHALLENGE_ID.test(parts[1]!.slice(0, -3))) leg(parts[1]!.slice(0, -3)).md = true
    else if (parts[0] === 'evidence' && parts.length >= 3 && CHALLENGE_ID.test(parts[1]!)) leg(parts[1]!).files.push({ name: `evidence/${parts.slice(2).join('/')}`, path: f.path, size: f.size })
  }
  const out: Shape[] = []
  for (const [id, files] of dirs) {
    const l = legacy.get(id)
    out.push({ id, layout: 'directory', summaryPath: `challenges/${id}/${SUMMARY}`, summary: files.some(f => f.name === SUMMARY), files,
      ...(l ? { problem: `files of the layout before challenge p3 are beside its directory (${l.md ? `challenges/${id}.md` : `evidence/${id}/`}); only the directory is read` } : {}) })
  }
  for (const [id, l] of legacy) if (!dirs.has(id) && l.md) out.push({ id, layout: 'legacy', summaryPath: `challenges/${id}.md`, summary: true, files: l.files })
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

async function build(s: Shape, log: LogEntry[], read: (path: string) => Promise<string | null>): Promise<Challenge> {
  const belongs = (p: string) => p.startsWith(`challenges/${s.id}/`) || p === `challenges/${s.id}.md` || p.startsWith(`evidence/${s.id}/`)
  const people = (match: (p: string) => boolean) => {
    const mine = log.filter(e => e.paths.some(match))
    const first = mine.at(-1), last = mine[0]
    const person = (e: LogEntry | undefined): Person => e ? { at: e.at, by: e.actor, commit: e.commit } : { at: '', by: '', commit: '' }
    return { commit: last?.commit ?? '', created: person(first), updated: person(last) }
  }
  const text = s.summary ? await read(s.summaryPath) : null
  const r: ReturnType<typeof parseRecord> = text !== null ? parseRecord(s.id, text) : { title: s.id, state: null, projects: [], body: '', extra: {} }
  const trials = new Map<string, MaterialFile[]>()
  const own: MaterialFile[] = []
  for (const f of s.files) {
    const parts = f.name.split('/')
    if (s.layout === 'directory' && parts[0] === WEDO && parts.length >= 3) trials.set(parts[1]!, [...trials.get(parts[1]!) ?? [], f])
    else if (!(s.layout === 'directory' && f.name === SUMMARY)) own.push(f)
  }
  const trialList: Trial[] = []
  for (const [name, files] of [...trials].sort(([a], [b]) => a.localeCompare(b))) {
    const sf = files.find(f => f.name === `${WEDO}/${name}/${SUMMARY}`)
    const st = sf ? await read(sf.path) : null
    trialList.push({ name, dir: `${WEDO}/${name}`, files, summary: sf && st !== null ? { name: sf.name, path: sf.path, ...parseSummary(st) } : null, ...people(p => p.startsWith(`challenges/${s.id}/${WEDO}/${name}/`)) })
  }
  const who = people(belongs)
  const c: Challenge = {
    id: s.id, layout: s.layout, dir: `challenges/${s.id}`, path: s.summaryPath, summary: text !== null, ...r, stateKind: stateKind(r.state),
    commit: who.commit, sha256: '', created: who.created, updated: who.updated, files: own, trials: trialList,
    ...(r.problem || s.problem ? { problem: [r.problem, s.problem].filter(Boolean).join('; ') } : {}),
  }
  c.sha256 = sha256(text ?? noSummaryText(c))
  return c
}

const allFiles = (c: Challenge): MaterialFile[] => [...(c.summary ? [{ name: SUMMARY, path: c.path, size: 0 }] : []), ...c.files, ...c.trials.flatMap(t => t.files)]

// A run is given a challenge's text; one without a summary is described by
// its files, nothing more.
function noSummaryText(c: Challenge): string {
  const at = c.commit.slice(0, 12)
  return [`# ${c.id}`, '', `(${c.dir} has no ${SUMMARY} at ${at}. Its files are below; read one with \`wfe challenge file ${c.id} <name> --at ${at}\`.)`, '',
    ...[...c.files, ...c.trials.flatMap(t => t.files)].map(f => `- ${f.name} (${f.size} bytes)`), ''].join('\n')
}

function excerpt(body: string, words: string[]): string {
  const lower = body.toLowerCase()
  const i = Math.max(0, Math.min(...words.map(w => lower.indexOf(w)).filter(n => n >= 0), body.length))
  const from = Math.max(0, i - 60)
  return `${from > 0 ? '…' : ''}${body.slice(from, from + 200).replace(/\s+/g, ' ').trim()}${from + 200 < body.length ? '…' : ''}`
}

// ---- the summary file ------------------------------------------------------------------

const FRONT = /^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))([\s\S]*)$/

// A new summary: id and the fields given, then the body.
export function renderRecord(id: string, f: Partial<Fields>, extra: Record<string, unknown> = {}): string {
  const front = stringifyYaml({ id, ...(f.title !== undefined ? { title: f.title } : {}), ...(f.state !== undefined && f.state !== null ? { state: f.state } : {}), ...(f.projects !== undefined ? { projects: f.projects } : {}),
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => !['id', 'title', 'state', 'projects'].includes(k))) }, { lineWidth: 0 }).trimEnd()
  return `---\n${front}\n---\n\n${f.body ? `${f.body}\n` : ''}`
}

// An existing summary with only the given fields changed: the rest of its
// frontmatter (other fields, comments, order) and, unless the body is given,
// its body stay byte for byte.
export function updateSummary(id: string, text: string, f: Partial<Fields>): string {
  const m = FRONT.exec(text)
  const cur = parseRecord(id, text)
  const front = (Object.keys(f) as (keyof Fields)[]).filter(k => k !== 'body' && JSON.stringify(f[k]) !== JSON.stringify(cur[k]))
  const bodyChanged = f.body !== undefined && normalizeBody(f.body) !== cur.body
  let head = m ? `${m[1]}${m[2]}${m[3]}` : ''
  let rest = m ? m[4]! : text
  if (front.length) {
    if (m) {
      const doc = parseDocument(m[2]!)
      if (doc.errors.length) throw new Error(`the summary's frontmatter is not YAML: ${doc.errors[0]!.message}`)
      for (const k of front) { if (k === 'state' && f.state === null) doc.delete('state'); else doc.set(k, f[k]) }
      head = `${m[1]}${doc.toString({ lineWidth: 0 }).replace(/\r?\n$/, '')}${m[3]}`
    } else {
      head = `---\n${stringifyYaml(Object.fromEntries(front.filter(k => f[k] !== null).map(k => [k, f[k]])), { lineWidth: 0 }).trimEnd()}\n---\n`
      if (!bodyChanged) rest = `\n${rest}`
    }
  }
  if (bodyChanged) rest = f.body ? `\n${normalizeBody(f.body)}\n` : ''
  return `${head}${rest}`
}

// The standard reading of a summary: the four fields from its frontmatter,
// with whatever else it holds kept. Nothing is replaced by a default: an
// absent state is null, a nonstandard one is kept as written; what cannot be
// read is named in `problem`, and the file is still shown as written.
export function parseRecord(id: string, text: string): Fields & { extra: Record<string, unknown>; problem?: string } {
  const m = FRONT.exec(text)
  const fallback = { title: id, state: null, projects: [] as string[], body: text.trim(), extra: {} }
  if (!m) return { ...fallback, problem: 'the summary has no frontmatter' }
  let front: Record<string, unknown>
  try {
    const v = parseYaml(m[2]!) ?? {}
    if (typeof v !== 'object' || Array.isArray(v)) throw new Error('not a mapping')
    front = v as Record<string, unknown>
  } catch (e) { return { ...fallback, body: m[4]!.replace(/^\n+/, '').replace(/\s+$/, ''), problem: `the frontmatter is not YAML: ${(e as Error).message}` } }
  const problems: string[] = []
  if (front.id !== undefined && front.id !== id) problems.push(`its id is ${JSON.stringify(front.id)}, not ${id} (the directory names the challenge)`)
  const state = front.state === undefined || front.state === null ? null : typeof front.state === 'string' ? front.state : (problems.push(`state ${JSON.stringify(front.state)} is not text`), String(JSON.stringify(front.state)))
  const projects = Array.isArray(front.projects) ? front.projects.filter((p): p is string => typeof p === 'string') : (front.projects !== undefined && problems.push('projects is not a list'), [])
  const extra = Object.fromEntries(Object.entries(front).filter(([k]) => !['id', 'title', 'state', 'projects'].includes(k)))
  return { title: typeof front.title === 'string' && front.title.trim() ? front.title.trim() : id, state, projects, body: m[4]!.replace(/^\n+/, '').replace(/\s+$/, ''), extra, ...(problems.length ? { problem: problems.join('; ') } : {}) }
}

// A trial's summary: shown as written. Frontmatter, if any, is kept apart;
// its title is the frontmatter's or the first heading's.
export function parseSummary(text: string): Omit<TrialSummary, 'name' | 'path'> {
  const m = FRONT.exec(text)
  let extra: Record<string, unknown> = {}
  let problem: string | undefined
  let body = text
  if (m) {
    body = m[4]!
    try { const v = parseYaml(m[2]!); if (v && typeof v === 'object' && !Array.isArray(v)) extra = v as Record<string, unknown>; else problem = 'the frontmatter is not a mapping' } catch (e) { problem = `the frontmatter is not YAML: ${(e as Error).message}` }
  }
  body = body.replace(/^\n+/, '').replace(/\s+$/, '')
  const title = typeof extra.title === 'string' && extra.title.trim() ? extra.title.trim() : /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? null
  return { title, body, extra, ...(problem ? { problem } : {}) }
}
