// Challenges (challenge p1, docs/challenges.md): problems found during
// project work, kept as durable shared records that any project can find and
// carry into later work. One record is `challenges/<id>.md` in one shared Git
// repository (<area>/challenges.json names it), with four management fields
// in its frontmatter (id, title, state, projects) and a free-form Markdown
// body; essential evidence files are `evidence/<id>/<name>` beside it.
//
// Git is the truth. This module keeps, in <area>/.local/challenges/:
//
// - repo/: the writer's own clone. It is disposable: every publication
//   starts from the remote's state (fetch, reset), so what it holds beyond
//   the remote is an earlier attempt that never reached it;
// - challenges.sqlite:
//   - operations: the journal. A create or an edit is accepted here first,
//     with its request identity (the same request twice is one operation),
//     the actor, the run, attempt and source it came from, the full fields
//     it writes and the revision it was based on. It stays until the remote
//     history is seen to contain it: pending → published, or unsynced (the
//     push failed or its outcome is unknown; retried), conflict (the record
//     changed on the remote after the base; the draft is kept), refused
//     (it can never be written, e.g. its id exists remotely) or discarded;
//   - blobs: the bytes of evidence an operation adds, until published;
//   - records: an index of the published records for lists and search,
//     rebuilt from the repository whenever its head moves. It is never
//     edited by itself: dropping it loses nothing.
//
// Publication: under one cross-process lock (the service, the CLI and the
// executor's reconcile may all publish), fetch; for each operation in order,
// look for its request in the remote history first (a crash after a push, or
// a push whose outcome was not seen, is recognised and never written twice);
// check its base against the record's latest revision there; commit as the
// actor with trailers naming the request, run, attempt and source; push once.
// A rejected push starts again from the new remote state; nothing is ever
// force-pushed.
//
// Reads: a current read is the index (refreshed from the remote at most
// every few seconds); a pinned read is `git show <commit>:…` of a revision of
// that record. History is the repository's log. Creating, editing or reading a
// challenge starts no run and assigns no work.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { git, gitBytes, gitOk } from './git.ts'
import { withLock } from './lock.ts'
import { openStore, transaction } from './sqlite.ts'
import { RequestError } from './workspace.ts'

export const CHALLENGE_ID = /^ch-[0-9]{4,}$/
export const CHALLENGE_STATES = ['open', 'resolved', 'withdrawn'] as const
export type ChallengeState = typeof CHALLENGE_STATES[number]
export const OPERATION_STATES = ['pending', 'published', 'unsynced', 'conflict', 'refused', 'discarded'] as const
export type OperationState = typeof OPERATION_STATES[number]
const OPEN_OPS: OperationState[] = ['pending', 'unsynced', 'conflict']
const PROJECT = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const EVIDENCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const REQUEST = /^[A-Za-z0-9:._/#-]{8,200}$/
const ACTOR = /^[^\n\r<>]{1,100}$/
const MAX_TITLE = 200
const MAX_BODY = 200_000
export const MAX_EVIDENCE = 32 * 1024 * 1024
const IDENTITY = { 'user.name': 'WFE challenges', 'user.email': 'wfe-challenges@agdev.invalid' }
const SYNC_MS = 10_000
const now = () => new Date().toISOString()
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')

// <area>/challenges.json: {"repository": "<clone URL or path>", "branch"?: "main", "web"?: "<browser URL>",
//   "mirrors"?: ["<URL of a copy on another host>", …]}
// A mirror is a backup: after a publication the branch is pushed there too
// (best effort; its state is in status()). It is never read.
export interface ChallengeConfig { url: string; branch: string; web: string | null; destination: string; mirrors: string[] }
export function loadChallengeConfig(area: string): ChallengeConfig | { disabled: string } {
  const file = join(area, 'challenges.json')
  if (!existsSync(file)) return { disabled: `no ${file}: no challenge repository is configured here` }
  try {
    const o = JSON.parse(readFileSync(file, 'utf8')) as { repository?: unknown; branch?: unknown; web?: unknown; mirrors?: unknown }
    if (typeof o.repository !== 'string' || !o.repository.trim()) return { disabled: `${file} needs {"repository": "<clone URL>"}` }
    let url = o.repository.trim()
    if (!/^[a-z+]+:\/\//.test(url) && !isAbsolute(url) && !/^[^/]+@[^:]+:/.test(url)) url = resolve(area, url)
    const destination = url.replace(/\/\/[^@/]+@/, '//').replace(/\/+$/, '').replace(/\.git$/, '')
    const web = typeof o.web === 'string' && o.web ? o.web.replace(/\/+$/, '') : /^https?:\/\//.test(destination) ? destination : null
    if (o.mirrors !== undefined && (!Array.isArray(o.mirrors) || !o.mirrors.every(m => typeof m === 'string' && m))) return { disabled: `${file}: "mirrors" is a list of repository URLs` }
    return { url, branch: typeof o.branch === 'string' && o.branch ? o.branch : 'main', web, destination, mirrors: (o.mirrors as string[] | undefined) ?? [] }
  } catch (e) { return { disabled: `${file} cannot be read: ${(e as Error).message}` } }
}

export interface Fields { title: string; state: ChallengeState; projects: string[]; body: string }
export interface Person { at: string; by: string; commit: string }
export interface EvidenceFile { name: string; path: string; size: number }
// A record as one revision of the repository has it.
export interface Challenge extends Fields {
  id: string
  path: string // challenges/<id>.md
  commit: string // the revision: the newest commit that changed this record or its evidence
  sha256: string // of the file's bytes at that revision
  created: Person
  updated: Person
  evidence: EvidenceFile[]
  extra: Record<string, unknown> // frontmatter fields beyond the four, kept as written
  problem?: string
}
export interface Source { kind: 'conversation'; conversation: string; message: number }
export interface OperationRow {
  id: number; request: string; kind: 'create' | 'edit'; challenge: string; base: string | null
  fields: string; evidence: string; drop_names: string; actor: string; on_behalf: string | null; run: string | null; attempt: string | null
  source: string | null; via: string; note: string; state: OperationState; commit_id: string | null; current: string | null
  error: string | null; tries: number; created: string; updated: string
}
export interface Operation {
  id: number; request: string; kind: 'create' | 'edit'; challenge: string; base: string | null; fields: Fields
  evidence: { name: string; sha256: string; size: number }[]; drop: string[]
  actor: string; onBehalfOf: string | null; run: string | null; attempt: string | null; source: Source | null; via: string; note: string
  state: OperationState; commit: string | null; current: string | null; error: string | null; tries: number; created: string; updated: string
}
interface RecordRow { id: string; title: string; state: string; projects: string; body: string; commit_id: string; sha256: string; created: string; updated: string; evidence: string; extra: string; problem: string | null }

export interface Actor { by: string; onBehalfOf?: string | null; run?: string | null; attempt?: string | null; via: string }
export interface AddEvidence { name: string; bytes: Buffer }
export interface CreateInput extends Actor { request: string; title: string; body: string; projects?: string[]; state?: ChallengeState; evidence?: AddEvidence[]; source?: Source | null; note?: string }
export interface EditInput extends Actor { request: string; base: string; title?: string; body?: string; projects?: string[]; state?: ChallengeState; evidence?: AddEvidence[]; drop?: string[]; source?: Source | null; note?: string }
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

  // Rebuilds the index from one commit of the clone (the remote head): every
  // challenges/<id>.md there, with who created and last changed it from one
  // pass over the log.
  private async reindexAt(head: string | null) {
    const rows: RecordRow[] = []
    if (head) {
      const log = await this.history(head, null)
      const files = (await this.g(['ls-tree', '-r', '-l', '--full-tree', head, '--', 'challenges', 'evidence'])).split('\n').filter(Boolean)
      const evidence = new Map<string, EvidenceFile[]>()
      for (const line of files) {
        const m = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(line)
        if (!m) continue
        const e = /^evidence\/(ch-[0-9]{4,})\/(.+)$/.exec(m[2])
        if (e) evidence.set(e[1], [...evidence.get(e[1]) ?? [], { name: e[2], path: m[2], size: Number(m[1]) }])
      }
      for (const line of files) {
        const m = /^\d+ blob [0-9a-f]+\s+\d+\tchallenges\/(ch-[0-9]{4,})\.md$/.exec(line)
        if (!m) continue
        const id = m[1]
        const text = await this.g(['show', `${head}:challenges/${id}.md`])
        const mine = log.filter(e => e.paths.some(p => p === `challenges/${id}.md` || p.startsWith(`evidence/${id}/`)))
        const first = mine.at(-1), last = mine[0]
        const r = parseRecord(id, text)
        rows.push({
          id, title: r.title, state: r.state, projects: JSON.stringify(r.projects), body: r.body, commit_id: last?.commit ?? head, sha256: sha256(text),
          created: JSON.stringify(first ? { at: first.at, by: first.actor, commit: first.commit } : { at: '', by: '', commit: head }),
          updated: JSON.stringify(last ? { at: last.at, by: last.actor, commit: last.commit } : { at: '', by: '', commit: head }),
          evidence: JSON.stringify(evidence.get(id) ?? []), extra: JSON.stringify(r.extra), problem: r.problem ?? null,
        })
      }
    }
    this.tx(() => {
      this.db.exec('DELETE FROM records')
      const ins = this.db.prepare('INSERT INTO records (id, title, state, projects, body, commit_id, sha256, created, updated, evidence, extra, problem) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const r of rows) ins.run(r.id, r.title, r.state, r.projects, r.body, r.commit_id, r.sha256, r.created, r.updated, r.evidence, r.extra, r.problem)
      this.setMeta('indexed', head ?? '')
      this.setMeta('indexed-at', now())
    })
  }

  // The log of the repository at `rev` (optionally of one record), newest
  // first, with the actor and the trailers each commit carries.
  private async history(rev: string, id: string | null): Promise<LogEntry[]> {
    const paths = id ? [`challenges/${id}.md`, `evidence/${id}`] : ['challenges', 'evidence']
    const out = await this.g(['log', '--format=%x1e%H%x1f%an%x1f%aI%x1f%s%x1f%B%x1f', '--name-only', rev, '--', ...paths])
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
      const p = await git(this.clone, ['push', '-q', url, `${head}:refs/heads/${c.branch}`], { env: await this.env(), timeoutMs: 120_000 })
      const rec = p.code === 0 ? { commit: head, at: now(), error: null } : { commit: was.commit ?? null, at: now(), error: (p.stderr.trim() || `exit ${p.code}`).slice(0, 500) }
      this.setMeta(`mirror:${url}`, JSON.stringify(rec))
      notes.push(`challenge mirror ${url}: ${rec.error ? `failed — ${rec.error}` : `at ${head.slice(0, 12)}`}`)
    }
    return notes
  }

  // ---- reading -----------------------------------------------------------------------

  private recordOf(r: RecordRow): Challenge {
    return {
      id: r.id, title: r.title, state: r.state as ChallengeState, projects: JSON.parse(r.projects) as string[], body: r.body, path: `challenges/${r.id}.md`,
      commit: r.commit_id, sha256: r.sha256, created: JSON.parse(r.created) as Person, updated: JSON.parse(r.updated) as Person,
      evidence: JSON.parse(r.evidence) as EvidenceFile[], extra: JSON.parse(r.extra) as Record<string, unknown>, ...(r.problem ? { problem: r.problem } : {}),
    }
  }

  // Published records by text, project and state, newest change first; with
  // counts per state (for the same text and project) and every project named.
  list(q: { text?: string; project?: string; state?: ChallengeState | 'all'; limit?: number; offset?: number } = {}) {
    const where: string[] = []
    const args: string[] = []
    if (q.text?.trim()) {
      for (const word of q.text.trim().split(/\s+/).slice(0, 8)) {
        where.push('(id LIKE ? ESCAPE \'\\\' OR title LIKE ? ESCAPE \'\\\' OR body LIKE ? ESCAPE \'\\\' OR projects LIKE ? ESCAPE \'\\\')')
        const like = `%${word.replace(/[\\%_]/g, c => `\\${c}`)}%`
        args.push(like, like, like, like)
      }
    }
    if (q.project) { where.push('EXISTS (SELECT 1 FROM json_each(records.projects) WHERE value = ?)'); args.push(q.project) }
    const base = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const counts = Object.fromEntries(CHALLENGE_STATES.map(s => [s, 0])) as Record<ChallengeState, number>
    for (const r of this.all<{ state: string; n: number }>(`SELECT state, count(*) AS n FROM records ${base} GROUP BY state`, ...args)) if (r.state in counts) counts[r.state as ChallengeState] = r.n
    const state = q.state ?? 'all'
    const filtered = state === 'all' ? base : `${base ? `${base} AND` : 'WHERE'} state = ?`
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500)
    const offset = Math.max(q.offset ?? 0, 0)
    const rows = this.all<RecordRow>(`SELECT * FROM records ${filtered} ORDER BY json_extract(updated, '$.at') DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, ...args, ...(state === 'all' ? [] : [state]))
    const total = this.one<{ n: number }>(`SELECT count(*) AS n FROM records ${filtered}`, ...args, ...(state === 'all' ? [] : [state]))!.n
    const projects = this.all<{ value: string; n: number }>('SELECT value, count(*) AS n FROM records, json_each(records.projects) GROUP BY value ORDER BY value').map(r => ({ project: r.value, count: r.n }))
    return { counts, total, offset, projects, challenges: rows.map(r => this.recordOf(r)) }
  }

  // The current record (the index, at the remote head it last read).
  current(id: string): Challenge | null {
    const r = this.one<RecordRow>('SELECT * FROM records WHERE id = ?', id)
    return r ? this.recordOf(r) : null
  }

  // The record as one revision has it: `at` names a commit of its history
  // (abbreviated or full). Its creator and its last change are those up to
  // that revision.
  async at(id: string, at: string): Promise<Challenge> {
    validId(id)
    const c = this.need()
    if (!/^[0-9a-f]{4,64}$/i.test(at)) throw new RequestError(400, `${at} is not a commit id`)
    return withLock(join(this.dir, 'writer'), async () => {
      if (!existsSync(join(this.clone, '.git')) || (await this.gt(['cat-file', '-e', `${at}^{commit}`])).code !== 0) await this.fetched(c)
      const full = await this.gt(['rev-parse', '--verify', '-q', `${at}^{commit}`])
      if (full.code !== 0) throw new RequestError(404, `no commit ${at} in the challenge repository`)
      const commit = full.stdout.trim()
      const mine = await this.history(commit, id)
      if (!mine.length) throw new RequestError(404, `${id} has no revision at or before ${commit.slice(0, 12)}`)
      const text = await this.gt(['show', `${commit}:challenges/${id}.md`])
      if (text.code !== 0) throw new RequestError(404, `${id} does not exist at ${commit.slice(0, 12)} (it was removed there)`)
      const files = (await this.g(['ls-tree', '-r', '-l', commit, '--', `evidence/${id}`])).split('\n').filter(Boolean)
      const evidence = files.map(l => /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map(m => ({ name: m[2].slice(`evidence/${id}/`.length), path: m[2], size: Number(m[1]) }))
      const r = parseRecord(id, text.stdout)
      const first = mine.at(-1)!, last = mine[0]!
      return { ...r, id, path: `challenges/${id}.md`, commit: last.commit, sha256: sha256(text.stdout), created: { at: first.at, by: first.actor, commit: first.commit }, updated: { at: last.at, by: last.actor, commit: last.commit }, evidence }
    }, { timeoutMs: 60_000, what: 'the challenge repository' })
  }

  // The file's bytes as that revision has them (what a run is given).
  async text(id: string, commit: string): Promise<string> {
    await this.at(id, commit)
    return this.g(['show', `${commit}:challenges/${id}.md`])
  }

  async evidence(id: string, name: string, at?: string): Promise<{ bytes: Buffer; commit: string; path: string }> {
    validId(id)
    if (!EVIDENCE_NAME.test(name)) throw new RequestError(400, `"${name}" is not an evidence file name`)
    const rec = at ? await this.at(id, at) : this.current(id)
    if (!rec) throw new RequestError(404, `no challenge ${id}`)
    const f = rec.evidence.find(e => e.name === name)
    if (!f) throw new RequestError(404, `${id} has no evidence ${name} at ${rec.commit.slice(0, 12)}`)
    const r = await gitBytes(this.clone, ['show', `${rec.commit}:${f.path}`], { env: await this.env() })
    if (r.code !== 0) throw new RequestError(404, `${f.path} cannot be read at ${rec.commit.slice(0, 12)}`)
    return { bytes: r.stdout, commit: rec.commit, path: f.path }
  }

  // Every revision of one record, newest first: who (the actor), when, what
  // the request was, the run and source it came from, and the title and
  // state that revision has.
  async log(id: string) {
    validId(id)
    const c = this.need()
    return withLock(join(this.dir, 'writer'), async () => {
      const head = await this.fetched(c)
      if (!head) return []
      const out = []
      for (const e of await this.history(head, id)) {
        const t = await this.gt(['show', `${e.commit}:challenges/${id}.md`])
        const r = t.code === 0 ? parseRecord(id, t.stdout) : null
        out.push({ commit: e.commit, at: e.at, actor: e.actor, subject: e.subject, request: e.trailers['Challenge-Request'] ?? null, onBehalfOf: e.trailers['Challenge-On-Behalf-Of'] ?? null,
          run: e.trailers['Challenge-Run'] ?? null, attempt: e.trailers['Challenge-Attempt'] ?? null, source: e.trailers['Challenge-Source'] ?? null, via: e.trailers['Challenge-Via'] ?? null,
          title: r?.title ?? null, state: r?.state ?? null, paths: e.paths })
      }
      return out
    }, { timeoutMs: 60_000, what: 'the challenge repository' })
  }

  // ---- the journal -------------------------------------------------------------------

  private opOf(r: OperationRow): Operation {
    return {
      id: r.id, request: r.request, kind: r.kind, challenge: r.challenge, base: r.base, fields: JSON.parse(r.fields) as Fields,
      evidence: JSON.parse(r.evidence) as Operation['evidence'], drop: JSON.parse(r.drop_names) as string[], actor: r.actor, onBehalfOf: r.on_behalf, run: r.run, attempt: r.attempt,
      source: r.source ? JSON.parse(r.source) as Source : null, via: r.via, note: r.note, state: r.state, commit: r.commit_id, current: r.current, error: r.error, tries: r.tries, created: r.created, updated: r.updated,
    }
  }
  operation(id: number): Operation | null { const r = this.one<OperationRow>('SELECT * FROM operations WHERE id = ?', id); return r ? this.opOf(r) : null }
  operations(o: { open?: boolean; challenge?: string } = {}): Operation[] {
    const where = [o.open ? `state IN (${OPEN_OPS.map(s => `'${s}'`).join(', ')})` : null, o.challenge ? 'challenge = ?' : null].filter(Boolean)
    return this.all<OperationRow>(`SELECT * FROM operations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 200`, ...(o.challenge ? [o.challenge] : [])).map(r => this.opOf(r))
  }
  private byRequest(request: string): Operation | null { const r = this.one<OperationRow>('SELECT * FROM operations WHERE request = ?', request); return r ? this.opOf(r) : null }

  // The next identity: past every record published, every one journaled and
  // every one named in the remote head the index read. Taken inside the
  // journal's write transaction, so two writers never take one id.
  private nextId(): string {
    const ids = [
      ...this.all<{ id: string }>('SELECT id FROM records'),
      ...this.all<{ id: string }>('SELECT challenge AS id FROM operations WHERE kind = \'create\''),
    ].map(r => Number(/^ch-([0-9]+)$/.exec(r.id)?.[1] ?? 0))
    return `ch-${String(Math.max(0, ...ids) + 1).padStart(4, '0')}`
  }

  private validate(f: Fields, evidence: AddEvidence[], drop: string[] = []) {
    if (!f.title.trim()) throw new RequestError(400, 'a challenge needs a title')
    if (/[\r\n]/.test(f.title.trim()) || f.title.trim().length > MAX_TITLE) throw new RequestError(400, `a title is one line of at most ${MAX_TITLE} characters`)
    if (!(CHALLENGE_STATES as readonly string[]).includes(f.state)) throw new RequestError(400, `state is one of ${CHALLENGE_STATES.join(', ')}`)
    if (!Array.isArray(f.projects) || !f.projects.every(p => typeof p === 'string' && PROJECT.test(p))) throw new RequestError(400, 'projects are project ids (lower-case letters, digits, . _ -)')
    if (f.body.length > MAX_BODY) throw new RequestError(413, `a body is at most ${MAX_BODY} characters`)
    const names = new Set<string>()
    for (const e of evidence) {
      if (!EVIDENCE_NAME.test(e.name)) throw new RequestError(400, `evidence "${e.name}": a file name of letters, digits, . _ - (no folders)`)
      if (names.has(e.name)) throw new RequestError(400, `evidence "${e.name}" is named twice`)
      if (e.bytes.length > MAX_EVIDENCE) throw new RequestError(413, `evidence "${e.name}" is ${e.bytes.length} bytes; at most ${MAX_EVIDENCE} (the repository has no large-file storage: link a durable store instead)`)
      names.add(e.name)
    }
    for (const d of drop) if (!EVIDENCE_NAME.test(d)) throw new RequestError(400, `"${d}" is not an evidence file name`)
  }
  private validActor(a: Actor) {
    if (!ACTOR.test(a.by.trim())) throw new RequestError(400, 'who writes (by) is a name of one line')
    if (a.onBehalfOf && !ACTOR.test(a.onBehalfOf)) throw new RequestError(400, 'on behalf of is a name of one line')
  }

  private journal(o: { request: string; kind: 'create' | 'edit'; challenge?: string; base: string | null; fields: Fields; evidence: AddEvidence[]; drop: string[]; actor: Actor; source?: Source | null; note?: string }): { operation: Operation; duplicate: boolean } {
    return this.tx(() => {
      const seen = this.byRequest(o.request)
      if (seen) return { operation: seen, duplicate: true }
      if (o.kind === 'edit') {
        const open = this.all<OperationRow>(`SELECT * FROM operations WHERE challenge = ? AND state IN (${OPEN_OPS.map(s => `'${s}'`).join(', ')}) ORDER BY id`, o.challenge!)
        if (open.length) throw new RequestError(409, `${o.challenge} has an edit not yet published (operation ${open[0].id}, ${open[0].state}): retry or discard it first (wfe challenge ops)`, { code: 'pending-edit', operation: this.opOf(open[0]) })
      }
      const challenge = o.challenge ?? this.nextId()
      const blobs = this.db.prepare('INSERT INTO blobs (sha256, bytes) VALUES (?, ?) ON CONFLICT (sha256) DO NOTHING')
      const evidence = o.evidence.map(e => { const h = sha256(e.bytes); blobs.run(h, e.bytes); return { name: e.name, sha256: h, size: e.bytes.length } })
      const at = now()
      const id = Number(this.db.prepare('INSERT INTO operations (request, kind, challenge, base, fields, evidence, drop_names, actor, on_behalf, run, attempt, source, via, note, state, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'pending\', ?, ?)')
        .run(o.request, o.kind, challenge, o.base, JSON.stringify(o.fields), JSON.stringify(evidence), JSON.stringify(o.drop), o.actor.by.trim(), o.actor.onBehalfOf ?? null, o.actor.run ?? null, o.actor.attempt ?? null,
          o.source ? JSON.stringify(o.source) : null, o.actor.via, o.note?.trim() ?? '', at, at).lastInsertRowid)
      return { operation: this.operation(id)!, duplicate: false }
    })
  }

  // A new challenge: journaled, then published. The identity is allocated
  // here and never changes.
  async create(i: CreateInput): Promise<Accepted> {
    this.need()
    if (!REQUEST.test(i.request)) throw new RequestError(400, 'a write needs a request identity (8–200 of A-Z a-z 0-9 : . _ / # -)')
    this.validActor(i)
    const fields: Fields = { title: i.title.trim(), state: i.state ?? 'open', projects: [...new Set(i.projects ?? [])], body: normalizeBody(i.body) }
    this.validate(fields, i.evidence ?? [])
    await this.sync()
    const j = this.journal({ request: i.request, kind: 'create', base: null, fields, evidence: i.evidence ?? [], drop: [], actor: i, source: i.source, note: i.note })
    return this.accepted(j)
  }

  // An edit of the revision `base` (the commit the writer read). Fields not
  // given are those of that revision. A base that is not the record's
  // current revision is refused at once, with the current one, and nothing is
  // journaled: the draft stays with the writer.
  async edit(id: string, i: EditInput): Promise<Accepted> {
    validId(id)
    this.need()
    if (!REQUEST.test(i.request)) throw new RequestError(400, 'a write needs a request identity (8–200 of A-Z a-z 0-9 : . _ / # -)')
    this.validActor(i)
    const seen = this.byRequest(i.request)
    if (seen) return this.accepted({ operation: seen, duplicate: true })
    await this.sync({ force: true })
    const cur = this.current(id)
    if (!cur) {
      const pending = this.all<OperationRow>('SELECT * FROM operations WHERE challenge = ? AND kind = \'create\' AND state != \'published\'', id)
      throw new RequestError(pending.length ? 409 : 404, pending.length ? `${id} is not published yet (operation ${pending[0].id}, ${pending[0].state}); it can be edited once it is` : `no challenge ${id}`, { code: pending.length ? 'unpublished' : 'missing' })
    }
    const base = await this.resolveCommit(i.base)
    if (base !== cur.commit) throw new RequestError(409, `${id} changed since ${i.base.slice(0, 12)}: its current revision is ${cur.commit.slice(0, 12)} (${cur.updated.by}, ${cur.updated.at}). Read it again and apply your change to it; nothing was written.`, { code: 'conflict', current: cur })
    const fields: Fields = { title: (i.title ?? cur.title).trim(), state: i.state ?? cur.state, projects: [...new Set(i.projects ?? cur.projects)], body: normalizeBody(i.body ?? cur.body) }
    this.validate(fields, i.evidence ?? [], i.drop ?? [])
    for (const d of i.drop ?? []) if (!cur.evidence.some(e => e.name === d)) throw new RequestError(400, `${id} has no evidence ${d}`)
    const same = fields.title === cur.title && fields.state === cur.state && JSON.stringify(fields.projects) === JSON.stringify(cur.projects) && fields.body === cur.body && !(i.evidence?.length) && !(i.drop?.length)
    if (same) throw new RequestError(400, `the edit changes nothing in ${id}`, { code: 'unchanged' })
    const j = this.journal({ request: i.request, kind: 'edit', challenge: id, base, fields, evidence: i.evidence ?? [], drop: i.drop ?? [], actor: i, source: i.source, note: i.note })
    return this.accepted(j)
  }

  private async resolveCommit(rev: string): Promise<string> {
    if (!/^[0-9a-f]{4,64}$/i.test(rev)) throw new RequestError(400, `base ${rev} is not a commit id (the revision you read: wfe challenge show prints it)`)
    const r = existsSync(join(this.clone, '.git')) ? await this.gt(['rev-parse', '--verify', '-q', `${rev}^{commit}`]) : { code: 1, stdout: '' }
    if (r.code !== 0) throw new RequestError(409, `base ${rev} is no revision of the challenge repository`, { code: 'conflict' })
    return r.stdout.trim()
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
          const log = head ? await this.history(head, null) : []
          const seen = head ? await this.requests(head) : new Map<string, string>()
          const made: Operation[] = []
          ops = due()
          for (const op of ops) {
            // Already in the remote history: a crash after the push, or a push
            // whose outcome was not seen. Recorded, never written again.
            const there = seen.get(op.request)
            if (there) { this.mark(op.id, 'published', { commit: there }); result.published.push(op.id); continue }
            const file = join(this.clone, 'challenges', `${op.challenge}.md`)
            const exists = existsSync(file)
            if (op.kind === 'create' && exists) {
              this.mark(op.id, 'refused', { error: `${op.challenge} already exists in the repository (written outside this journal); the draft is kept here (wfe challenge ops)` })
              result.refused.push(op.id); continue
            }
            if (op.kind === 'edit') {
              const last = log.find(e => e.paths.some(p => p === `challenges/${op.challenge}.md` || p.startsWith(`evidence/${op.challenge}/`)))?.commit ?? null
              // An edit made on top of an operation published in this round
              // has that operation's commit as its base only after the push;
              // the journal refuses a second open edit of one record, so the
              // base is always a published revision.
              if (!exists || last !== op.base) {
                this.mark(op.id, 'conflict', { current: last, error: exists ? `${op.challenge} changed on the remote after ${op.base?.slice(0, 12)} (now ${last?.slice(0, 12)}); the draft is kept` : `${op.challenge} was removed from the repository` })
                result.conflicts.push(op.id); continue
              }
            }
            const prior = exists ? parseRecord(op.challenge, readFileSync(file, 'utf8')) : null
            await mkdir(join(this.clone, 'challenges'), { recursive: true })
            await writeFile(file, renderRecord(op.challenge, op.fields, prior?.extra ?? {}))
            const paths = [`challenges/${op.challenge}.md`]
            for (const e of op.evidence) {
              const blob = this.one<{ bytes: Uint8Array }>('SELECT bytes FROM blobs WHERE sha256 = ?', e.sha256)
              if (!blob) throw new Error(`operation ${op.id}: the bytes of evidence ${e.name} are missing from the journal`)
              await mkdir(join(this.clone, 'evidence', op.challenge), { recursive: true })
              await writeFile(join(this.clone, 'evidence', op.challenge, e.name), Buffer.from(blob.bytes))
              paths.push(`evidence/${op.challenge}/${e.name}`)
            }
            for (const d of op.drop) {
              const p = join(this.clone, 'evidence', op.challenge, d)
              if (existsSync(p)) { await unlink(p); paths.push(`evidence/${op.challenge}/${d}`) }
            }
            if (existsSync(join(this.clone, 'evidence', op.challenge)) && !(await readdir(join(this.clone, 'evidence', op.challenge))).length) await rm(join(this.clone, 'evidence', op.challenge), { recursive: true })
            await this.g(['add', '-A', '--', ...paths])
            const verb = op.kind === 'create' ? 'Record' : prior && prior.state !== op.fields.state ? ({ open: 'Reopen', resolved: 'Resolve', withdrawn: 'Withdraw' } as const)[op.fields.state] : 'Edit'
            const trailers = [
              `Challenge-Id: ${op.challenge}`, `Challenge-Request: ${op.request}`, `Challenge-Actor: ${op.actor}`,
              ...(op.onBehalfOf ? [`Challenge-On-Behalf-Of: ${op.onBehalfOf}`] : []), ...(op.base ? [`Challenge-Base: ${op.base}`] : []),
              ...(op.run ? [`Challenge-Run: ${op.run}`] : []), ...(op.attempt ? [`Challenge-Attempt: ${op.attempt}`] : []),
              ...(op.source ? [`Challenge-Source: conversation ${op.source.conversation}#${op.source.message}`] : []), `Challenge-Via: ${op.via}`,
            ]
            const message = [`${verb} ${op.challenge}: ${op.fields.title}`, ...(op.note ? [op.note] : []), trailers.join('\n')]
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
  // current one, or the named commit), title and the file's hash.
  async pin(id: string, at?: string): Promise<{ id: string; commit: string; title: string; state: ChallengeState; sha256: string }> {
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

function validId(id: string) { if (!CHALLENGE_ID.test(id)) throw new RequestError(400, `"${id}" is not a challenge id (ch-0001)`) }
const normalizeBody = (b: string) => b.replace(/\r\n/g, '\n').replace(/\s+$/, '')

function trailersOf(message: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of message.split('\n')) { const m = /^(Challenge-[A-Za-z-]+): (.*)$/.exec(line.trim()); if (m) out[m[1]] = m[2] }
  return out
}

// The file: frontmatter with the four management fields (and whatever else
// someone wrote there, kept), then the body.
export function renderRecord(id: string, f: Fields, extra: Record<string, unknown> = {}): string {
  const front = stringifyYaml({ id, title: f.title, state: f.state, projects: f.projects, ...Object.fromEntries(Object.entries(extra).filter(([k]) => !['id', 'title', 'state', 'projects'].includes(k))) }, { lineWidth: 0 }).trimEnd()
  return `---\n${front}\n---\n\n${f.body ? `${f.body}\n` : ''}`
}

export function parseRecord(id: string, text: string): Fields & { extra: Record<string, unknown>; problem?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  const fallback = { title: id, state: 'open' as ChallengeState, projects: [] as string[], body: text.trim(), extra: {} }
  if (!m) return { ...fallback, problem: 'the file has no frontmatter' }
  let front: Record<string, unknown>
  try { front = (parseYaml(m[1]) ?? {}) as Record<string, unknown> } catch (e) { return { ...fallback, problem: `the frontmatter is not YAML: ${(e as Error).message}` } }
  const problems: string[] = []
  if (front.id !== id) problems.push(`its id is ${JSON.stringify(front.id)}, not ${id}`)
  const state = (CHALLENGE_STATES as readonly unknown[]).includes(front.state) ? front.state as ChallengeState : (problems.push(`state ${JSON.stringify(front.state)} is not one of ${CHALLENGE_STATES.join(', ')}`), 'open')
  const projects = Array.isArray(front.projects) ? front.projects.filter((p): p is string => typeof p === 'string') : (front.projects !== undefined && problems.push('projects is not a list'), [])
  const extra = Object.fromEntries(Object.entries(front).filter(([k]) => !['id', 'title', 'state', 'projects'].includes(k)))
  return { title: typeof front.title === 'string' && front.title.trim() ? front.title.trim() : id, state, projects, body: m[2].replace(/^\n+/, '').replace(/\s+$/, ''), extra, ...(problems.length ? { problem: problems.join('; ') } : {}) }
}
