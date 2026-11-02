// Retiring and restoring a finished run's working copy (improve_wfrun p2,
// docs/storage.md *Retirement*). "Retired" is a storage state in the run's
// manifest, independent of its status; no run event records it.
//
//   ready -> retiring -> retired -> restoring -> ready
//
// What a tree holds is inventoried per repository, and each item has a place:
// the durable record (the run folder), the project's retention repository
// (every commit the copy's refs reach), the run's archive (non-committed bytes,
// index files), a verified published output, or an explicit discard with its
// reason. Anything that cannot be classified keeps the copy. Archives are written
// to staging and verified, and the transition is committed before the tree is
// released; every step can be run again after a crash. Lock order: the run's
// lifecycle lock, its publication lock, its record lock, its manifest lock.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { runFolder, runKey, type RunRecord, type RunRef } from '../shared/run.ts'
import { readTextOrNull } from './files.ts'
import { git, gitOk, LOCAL_TRANSPORT, type GitResult } from './git.ts'
import { withLock } from './lock.ts'
import { linkRecord, recordFolderOf } from './runrecord.ts'
import { readRun, RUN_FILE } from './runs.ts'
import { tarCreate, tarExtract } from './tarball.ts'
import { copyDir, listCopies, ownerOf, readCopy, recordOwner, runSpace, updateManifest, type CopyManifest, type RunCopy } from './runspace.ts'
import { RequestError, type Workspace } from './workspace.ts'
import type { ExecStore } from './exec.ts'

export const ARCHIVE = 'archive'
const ARCHIVE_STAGING = 'archive.staging'
export const FILES = 'files.tgz'
const CONTENTS = 'contents.json'
const TREE_RESTORING = 'tree.restoring'
const TREE_REMOVING = 'tree.removing'
export const RETENTION_DIR = '.local/wfe/retention' // under the project workspace
export const CLEANUP_RECORD = 'branch-cleanup.json' // beside copy.json: refs deleted from remotes, docs/storage.md
const GIT_LONG = 3_600_000

export type ItemClass = 'archive' | 'published-output' | 'discard'
export interface Entry { path: string; type: 'file' | 'link' | 'dir'; mode: number; size: number; sha256?: string; link?: string; class: ItemClass; reason?: string }
export interface RetainedRef { ref: string; oid: string; type: string }
export interface InventoryRepo { path: string; url: string | null; head: string | null; branch: string | null; refs: RetainedRef[]; modified: number; untracked: number; ignored: number; deleted: string[]; key: string }
export interface Unclassified { path: string; why: string }
export interface Discard { path: string; reason: string }
export interface HostProgress { state: 'requested' | 'archived' | 'absent' | 'remove-pending' | 'removed' | 'refused' | 'restored'; at: string; detail?: string; archive?: { sha256: string; bytes: number } | null; files?: number; treeBytes?: number | null; generation: number }
export interface Lifecycle {
  requestedBy: string
  requestedAt: string
  phase: string // the last completed step of the current or latest operation
  failure: { at: string; step: string; message: string } | null
  repositories?: { path: string; head: string | null; branch: string | null; refs: number; key: string }[]
  archive?: { sha256: string | null; bytes: number; files: number; contents: string; verified: string; discarded: number; published: number } | null
  sizes?: { treeBytes: number | null; integrationBytes: number | null }
  hosts: Record<string, HostProgress>
  history: { at: string; op: string; by: string; result: string }[]
}

const now = () => new Date().toISOString()
const fail = (ref: RunRef, message: string, code = 'run-storage') => new RequestError(409, `run ${runKey(ref)}: ${message}`, { code })
const mustCopy = async (ws: Workspace, ref: RunRef): Promise<RunCopy & { manifest: CopyManifest }> => {
  const c = await readCopy(ws.shared, ref)
  if (!c?.manifest) throw fail(ref, c?.problem ?? 'it has no managed working copy here (legacy or IDE run): nothing to retire')
  return c as RunCopy & { manifest: CopyManifest }
}

// ---- eligibility -------------------------------------------------------------------------

export interface Eligibility { ref: string; workspace: string; managed: boolean; state: string; eligible: boolean; reasons: string[]; hosts: string[] }

export function recordReasons(r: RunRecord): string[] {
  const out: string[] = []
  if (r.standing && !r.cancelled) out.push(`a standing conductor run (${r.execution.state}) is not finished`)
  else if (!r.cancelled && r.execution.state !== 'completed') out.push(`the run is ${r.execution.state}, not completed or cancelled`)
  if (r.control.attempt) out.push(`attempt ${r.control.attempt.id} is open`)
  if (r.control.hold) out.push(`the run is held (${r.control.hold.kind})`)
  for (const p of Object.values(r.presentations ?? {})) if (p.state === 'available' || p.state === 'stop-failed') out.push(`presentation ${p.id} is ${p.state}; stop it first (wfe present stop)`)
  for (const [id, v] of Object.entries(r.reviews ?? {})) if (!['approved', 'closed', 'superseded', 'cancelled'].includes((v as { state: string }).state)) out.push(`review ${id} is ${(v as { state: string }).state} and reads the tree`)
  return out
}

// Processes whose working directory is inside the tree (one bounded read).
async function processesIn(tree: string): Promise<string[]> {
  const r = await new Promise<{ code: number; out: string }>(resolve => {
    const p = spawn('lsof', ['-w', '-d', 'cwd', '-Fpn'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const t = setTimeout(() => p.kill('SIGKILL'), 30_000)
    p.stdout.on('data', d => { out += d })
    p.on('error', () => { clearTimeout(t); resolve({ code: 127, out: '' }) })
    p.on('close', code => { clearTimeout(t); resolve({ code: code ?? 1, out }) })
  })
  if (r.code === 127) return ['the processes on this host could not be inspected (no lsof)']
  const found: string[] = []
  let pid = ''
  for (const l of r.out.split('\n')) {
    if (l[0] === 'p') pid = l.slice(1)
    else if (l[0] === 'n' && (l.slice(1) === tree || l.slice(1).startsWith(`${tree}/`))) found.push(`process ${pid} works in the tree`)
  }
  return found
}

export async function inspectRun(x: ExecStore, ws: Workspace, ref: RunRef, o: { fast?: boolean } = {}): Promise<Eligibility> {
  const base = { ref: runKey(ref), workspace: ws.reg.id }
  const c = await readCopy(ws.shared, ref)
  if (!c) return { ...base, managed: false, state: 'none', eligible: false, reasons: ['a legacy or IDE run without a managed copy; its record stays where it is'], hosts: [] }
  const state = c.manifest?.state ?? 'damaged'
  const reasons: string[] = []
  if (c.problem) reasons.push(c.problem)
  else if (state !== 'ready' && state !== 'retiring') reasons.push(`its working copy is ${state}`)
  if (c.manifest && c.manifest.record !== 'durable') reasons.push('its record is still in the tree; wfe runs relocate moves it first')
  const reading = await readRun(ws.shared, ref).catch(e => ({ record: null, problem: { message: (e as Error).message } }))
  const r = reading.record
  if (!r) reasons.push(`its record cannot be read: ${reading.problem?.message ?? 'unknown'}`)
  else reasons.push(...recordReasons(r))
  reasons.push(...x.storageBlockers(ws.reg.id, ref))
  if (!o.fast && !c.problem && c.manifest && state !== 'retired') reasons.push(...await processesIn(c.tree))
  return { ...base, managed: true, state, eligible: reasons.length === 0, reasons, hosts: r ? x.remoteHostsOf(ws.reg.id, ref, r) : [] }
}

// Every run of a workspace, managed copies and the others apart.
export async function inspectWorkspace(x: ExecStore, ws: Workspace): Promise<Eligibility[]> {
  const out: Eligibility[] = []
  for (const c of await listCopies(ws.shared)) out.push(await inspectRun(x, ws, c.ref, { fast: true }))
  return out
}

// ---- inventory ---------------------------------------------------------------------------

const keyOf = (project: string, path: string, url: string | null) => `${(url ?? `${project}-${path}`).replace(/\.git$/, '').split('/').pop()!.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 40)}-${createHash('sha256').update(url ?? `${project}:${path}`).digest('hex').slice(0, 12)}`
const refSpace = (ref: RunRef, repo: string) => `refs/retained/${ref.workflow}/${ref.run}/${repo === '.' ? 'root' : `sub-${createHash('sha256').update(repo).digest('hex').slice(0, 12)}`}`
export const retentionRepo = (ws: Workspace, key: string) => join(ws.shared.root, RETENTION_DIR, `${key}.git`)

// Repositories really present in the copy: what the manifest names and what an
// agent initialized later.
async function repositoriesIn(c: RunCopy & { manifest: CopyManifest }): Promise<{ path: string; url: string | null }[]> {
  const out = new Map<string, string | null>([['.', c.manifest.repositories.find(r => r.path === '.')?.url ?? null]])
  for (const r of c.manifest.repositories) if (r.initialized) out.set(r.path, r.url)
  const s = await git(c.tree, ['submodule', 'status', '--recursive'], { timeoutMs: 120_000 })
  for (const l of s.stdout.split('\n')) {
    const m = /^[ +U]([0-9a-f]+) (\S+)/.exec(l)
    if (m && !out.has(m[2])) out.set(m[2], (await git(join(c.tree, m[2]), ['remote', 'get-url', 'origin'])).stdout.trim() || null)
  }
  return [...out].map(([path, url]) => ({ path, url }))
}

interface Walked { entries: Entry[]; unclassified: Unclassified[]; repos: InventoryRepo[] }

const matches = (rules: Discard[], path: string) => rules.find(d => path === d.path || path.startsWith(`${d.path.replace(/\/+$/, '')}/`))

// One walk that follows no symbolic link and stays in the copy.
async function walkItem(tree: string, path: string, skip: Set<string>, rules: Discard[], w: Walked) {
  const abs = join(tree, path)
  const st = await lstat(abs).catch(e => (e as Error))
  if (st instanceof Error) { w.unclassified.push({ path, why: st.message }); return }
  const rule = matches(rules, path)
  const mk = (type: Entry['type'], extra: Partial<Entry> = {}): Entry => ({ path, type, mode: st.mode & 0o7777, size: st.size, class: rule ? 'discard' : 'archive', ...(rule ? { reason: rule.reason } : {}), ...extra })
  if (st.isSymbolicLink()) { w.entries.push(mk('link', { link: await readlink(abs), size: 0 })); return }
  if (st.isFile()) {
    // A file that cannot be read cannot be archived.
    if (!rule && !(await open(abs, 'r').then(f => f.close().then(() => true), () => false))) { w.unclassified.push({ path, why: 'it cannot be read' }); return }
    w.entries.push(mk('file'))
    return
  }
  if (st.isDirectory()) {
    const names = await readdir(abs).catch(e => (e as Error))
    if (names instanceof Error) { if (!rule) w.unclassified.push({ path, why: names.message }); return }
    const real = names.filter(n => !skip.has(`${path}/${n}`))
    if (!real.length) { w.entries.push(mk('dir', { size: 0 })); return }
    for (const n of real) await walkItem(tree, `${path}/${n}`, skip, rules, w)
    return
  }
  if (rule) w.entries.push(mk('file', { size: 0 }))
  else w.unclassified.push({ path, why: 'neither a file, a folder nor a symbolic link' })
}

// Reads the copy without changing it. GIT_OPTIONAL_LOCKS keeps status from
// refreshing an index.
export async function inventoryCopy(c: RunCopy & { manifest: CopyManifest }, rules: Discard[] = []): Promise<Walked> {
  const w: Walked = { entries: [], unclassified: [], repos: [] }
  const env = { GIT_OPTIONAL_LOCKS: '0' }
  const present = await repositoriesIn(c)
  const paths = new Set(present.map(r => r.path).filter(p => p !== '.'))
  const link = runFolder(c.ref)
  for (const repo of present) {
    const dir = repo.path === '.' ? c.tree : join(c.tree, repo.path)
    const prefix = repo.path === '.' ? '' : `${repo.path}/`
    const s = await git(dir, ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=normal', '--ignore-submodules=dirty'], { env, timeoutMs: 600_000 })
    if (s.code !== 0) { w.unclassified.push({ path: repo.path, why: `its status cannot be read: ${s.stderr.trim()}` }); continue }
    const inv: InventoryRepo = { path: repo.path, url: repo.url, head: (await git(dir, ['rev-parse', '-q', '--verify', 'HEAD'], { env })).stdout.trim() || null, branch: (await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'], { env })).stdout.trim() || null, refs: [], modified: 0, untracked: 0, ignored: 0, deleted: [], key: keyOf(c.manifest.project, repo.path, repo.url) }
    const parts = s.stdout.split('\0')
    const items: string[] = []
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i]
      if (e.length < 4) continue
      const xy = e.slice(0, 2), rel = e.slice(3)
      if (xy[0] === 'R' || xy[0] === 'C') i++
      const full = `${prefix}${rel}`.replace(/\/+$/, '')
      if (full === link || full.startsWith(`${link}/`) || paths.has(full)) continue // the durable record; a repository of its own
      if (xy === '!!') inv.ignored++
      else if (xy === '??') inv.untracked++
      else inv.modified++
      if (xy !== '!!' && xy !== '??' && xy.includes('D')) { inv.deleted.push(full); continue }
      items.push(full)
    }
    for (const it of items) await walkItem(c.tree, it, paths, rules, w)
    const refs = await git(dir, ['for-each-ref', '--format=%(objectname) %(objecttype) %(refname)', 'refs/heads', 'refs/tags', 'refs/wfe', 'refs/stash'], { env })
    for (const l of refs.stdout.split('\n').filter(Boolean)) { const [oid, type, ref] = l.split(' '); inv.refs.push({ ref, oid, type }) }
    w.repos.push(inv)
  }
  // Git does not report sockets, pipes and devices at all: a walk of the tree
  // finds them, so they are classified like anything else.
  const others = await new Promise<string>(resolve => {
    const f = spawn('find', ['.', '-name', '.git', '-prune', '-o', '!', '-type', 'f', '!', '-type', 'd', '!', '-type', 'l', '-print0'], { cwd: c.tree, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    f.stdout.on('data', d => { out += d })
    f.on('close', () => resolve(out)); f.on('error', () => resolve(''))
  })
  for (const raw of others.split('\0').filter(Boolean)) {
    const path = raw.replace(/^\.\//, '')
    if (w.entries.some(e => e.path === path) || w.unclassified.some(u => u.path === path)) continue
    await walkItem(c.tree, path, paths, rules, w)
  }
  return w
}

// ---- commits -----------------------------------------------------------------------------

async function ensureBare(ws: Workspace, key: string): Promise<string> {
  const bare = retentionRepo(ws, key)
  if (!(await stat(join(bare, 'HEAD')).catch(() => null))) {
    await mkdir(dirname(bare), { recursive: true })
    await gitOk(dirname(bare), ['init', '-q', '--bare', bare])
    await gitOk(bare, ['config', 'gc.auto', '0']) // this store collects only when asked; every ref is a promise
  }
  return bare
}

// Every commit the copy's refs reach, plus its base, into the project's
// retention repository under this run's own refs. Safe to repeat.
async function retainCommits(ws: Workspace, c: RunCopy & { manifest: CopyManifest }, repos: InventoryRepo[]) {
  for (const r of repos) {
    const dir = r.path === '.' ? c.tree : join(c.tree, r.path)
    const bare = await ensureBare(ws, r.key)
    const space = refSpace(c.ref, r.path)
    const base = c.manifest.repositories.find(x => x.path === r.path)?.base
    if (base && (await git(dir, ['cat-file', '-e', `${base}^{commit}`])).code === 0) { await gitOk(dir, ['update-ref', 'refs/wfe/retain-base', base]); r.refs = r.refs.filter(x => x.ref !== 'refs/wfe/retain-base'); r.refs.push({ ref: 'refs/wfe/retain-base', oid: base, type: 'commit' }) }
    // Staged bytes are reachable from no ref: the index's own tree keeps them.
    const index = await git(dir, ['write-tree', '--missing-ok'])
    if (index.code !== 0) throw new Error(`${r.path}: its index cannot be saved (an unfinished merge?): ${index.stderr.trim()}`)
    await gitOk(dir, ['update-ref', 'refs/wfe/retain-index', index.stdout.trim()])
    r.refs = r.refs.filter(x => x.ref !== 'refs/wfe/retain-index')
    r.refs.push({ ref: 'refs/wfe/retain-index', oid: index.stdout.trim(), type: 'tree' })
    const specs = r.refs.map(x => `+${x.ref}:${space}/${x.ref.slice('refs/'.length)}`)
    if (r.head) specs.push(`+HEAD:${space}/HEAD`)
    if (specs.length) await withLock(`${bare}.lock`, () => gitOk(bare, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', dir, ...specs], { config: LOCAL_TRANSPORT, timeoutMs: GIT_LONG }), { what: `the retention repository ${r.key}`, timeoutMs: 600_000 })
  }
}

// That every recorded object is present with what it reaches.
export async function verifyRetained(ws: Workspace, ref: RunRef, repos: InventoryRepo[]): Promise<string[]> {
  const bad: string[] = []
  for (const r of repos) {
    const bare = retentionRepo(ws, r.key)
    if (!(await stat(join(bare, 'HEAD')).catch(() => null))) { bad.push(`${r.path}: the retention repository ${r.key} is unavailable`); continue }
    const check = async (oid: string, type: string) => {
      const t: GitResult = type === 'commit' ? await git(bare, ['rev-list', '--objects', '--quiet', oid], { timeoutMs: GIT_LONG }) : await git(bare, ['cat-file', '-e', oid])
      if (t.code !== 0) bad.push(`${r.path}: ${oid.slice(0, 12)} is not fully retained: ${t.stderr.trim().split('\n')[0]}`)
    }
    if (r.head) await check(r.head, 'commit')
    for (const o of new Map(r.refs.map(x => [x.oid, x.type]))) await check(o[0], o[1])
    if (r.head && (await git(bare, ['show-ref', '--verify', '-q', `${refSpace(ref, r.path)}/HEAD`])).code !== 0) bad.push(`${r.path}: its retained HEAD ref is gone`)
  }
  return bad
}

// ---- archive -----------------------------------------------------------------------------

export const sha256File = async (file: string) => {
  const h = createHash('sha256')
  for await (const d of createReadStream(file)) h.update(d as Buffer)
  return h.digest('hex')
}

// What is on disk under `root` is what the entries say.
async function compareEntries(root: string, entries: Entry[]): Promise<string[]> {
  const bad: string[] = []
  for (const e of entries.filter(x => x.class === 'archive')) {
    const abs = join(root, e.path)
    const st = await lstat(abs).catch(() => null)
    if (!st) { bad.push(`${e.path}: missing`); continue }
    if (e.type === 'link') { if (!st.isSymbolicLink() || await readlink(abs) !== e.link) bad.push(`${e.path}: not the same link`); continue }
    if (e.type === 'dir') { if (!st.isDirectory()) bad.push(`${e.path}: not a folder`); continue }
    if (!st.isFile() || st.size !== e.size) { bad.push(`${e.path}: size ${st.size}, expected ${e.size}`); continue }
    if ((st.mode & 0o111) !== (e.mode & 0o111)) bad.push(`${e.path}: executable bits differ`)
    if (e.sha256 && await sha256File(abs) !== e.sha256) bad.push(`${e.path}: content differs`)
  }
  return bad
}

// Files already kept as verified published outputs of this run, by content:
// where each is on the shared area. An output that does not verify gives none,
// and says why.
async function publishedSources(ws: Workspace, r: RunRecord): Promise<{ sources: Map<string, string>; problems: string[] }> {
  const sources = new Map<string, string>(), problems: string[] = []
  const { checkOutput, resolveRef } = await import('./shares.ts')
  const space = await runSpace(ws, r) // the run's own record, not a project tree's snapshot of it
  const dir = await readRun(space, r).then(x => x.dir)
  for (const o of Object.values(r.outputs ?? {})) {
    const check = await checkOutput(space, r, o.id).catch(e => ({ status: 'unavailable', detail: (e as Error).message }))
    if (check.status !== 'verified') { problems.push(`output ${o.id}: ${check.status} (${check.detail})`); continue }
    const text = await readTextOrNull(join(dir, 'outputs', `${o.id}.json`))
    const root = (await resolveRef(o.ref)).abs
    if (root) for (const f of (text ? JSON.parse(text).files ?? [] : []) as { path: string; sha256?: string }[]) if (f.sha256) sources.set(f.sha256, join(root, f.path))
  }
  return { sources, problems }
}

// Files classified as published outputs go back from the shared area, each checked
// by its hash. One that cannot be had is reported, by name: the rest of the copy
// is still the saved work, and the output's owner is the shared area.
async function restorePublished(ws: Workspace, ref: RunRef, staging: string, entries: Entry[]): Promise<string[]> {
  const wanted = entries.filter(e => e.class === 'published-output')
  if (!wanted.length) return []
  const r = (await readRun(ws, ref)).record
  const { sources, problems } = r ? await publishedSources(ws, r) : { sources: new Map<string, string>(), problems: ['the record cannot be read'] }
  const out = problems.map(p => `not verified on the shared area now: ${p}`)
  for (const e of wanted) {
    const src = e.sha256 ? sources.get(e.sha256) : undefined
    const to = join(staging, e.path)
    if (!src) { out.push(`${e.path}: its published output is unavailable; it was not restored`); continue }
    await mkdir(dirname(to), { recursive: true })
    await copyFile(src, to)
    if (await sha256File(to) !== e.sha256) { await rm(to, { force: true }); out.push(`${e.path}: the published bytes differ from what was saved; it was not restored`); continue }
    await chmod(to, e.mode & 0o777)
  }
  return out
}

export interface Contents { schema: 'ag.wfe-run-archive.v1'; ref: string; created: string; repositories: InventoryRepo[]; entries: Entry[]; notes: string[]; files: string | null }

// Writes and verifies the run's archive in staging, then moves it into place.
async function writeArchive(ws: Workspace, c: RunCopy & { manifest: CopyManifest }, inv: Walked, record: RunRecord) {
  const staging = join(c.dir, ARCHIVE_STAGING), final = join(c.dir, ARCHIVE)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  const { sources, problems } = await publishedSources(ws, record)
  for (const e of inv.entries.filter(x => x.class === 'archive' && x.type === 'file')) {
    e.sha256 = await sha256File(join(c.tree, e.path))
    if (sources.has(e.sha256)) { e.class = 'published-output'; e.reason = 'the same bytes are a verified published output of this run' }
  }
  // What an earlier restoration could not bring back from the shared area is still
  // the run's: it stays listed, so a later retirement does not forget it.
  const earlier = await readTextOrNull(join(final, CONTENTS)).then(t => (t ? JSON.parse(t) as Contents : null)).catch(() => null)
  const here = new Set(inv.entries.map(e => e.path))
  for (const e of earlier?.entries ?? []) if (e.class === 'published-output' && !here.has(e.path)) { inv.entries.push(e); problems.push(`${e.path}: listed from the previous retirement; it was not in the tree`) }
  const kept = inv.entries.filter(e => e.class === 'archive')
  const need = kept.reduce((n, e) => n + e.size, 0) * 2 + 64 * 1024 * 1024
  const fs = await statfs(c.dir)
  if (fs.bavail * fs.bsize < need) throw new Error(`the archive's disk has ${fs.bavail * fs.bsize} bytes free and needs ${need}; nothing was released`)
  if (kept.length) {
    await tarCreate(join(staging, FILES), c.tree, kept.map(e => e.path))
    const verify = join(staging, 'verify')
    await tarExtract(join(staging, FILES), verify)
    const bad = await compareEntries(verify, kept)
    if (bad.length) throw new Error(`the archive does not reproduce the files: ${bad.slice(0, 5).join('; ')}`)
    await rm(verify, { recursive: true, force: true })
  }
  // Index files and exclude rules, as they are.
  for (const r of inv.repos) {
    const dir = r.path === '.' ? c.tree : join(c.tree, r.path)
    for (const [name, gitPath] of [['index', 'index'], ['exclude', 'info/exclude']]) {
      const raw = (await gitOk(dir, ['rev-parse', '--git-path', gitPath])).trim()
      await copyFile(raw.startsWith('/') ? raw : join(dir, raw), join(staging, `${r.key}.${name}`)).catch(() => null)
    }
  }
  const contents: Contents = { schema: 'ag.wfe-run-archive.v1', ref: runKey(c.ref), created: now(), repositories: inv.repos, entries: inv.entries, notes: problems, files: kept.length ? FILES : null }
  await writeFile(join(staging, CONTENTS), `${JSON.stringify(contents, null, 1)}\n`)
  const sum = { sha256: kept.length ? await sha256File(join(staging, FILES)) : null, bytes: kept.length ? (await stat(join(staging, FILES))).size : 0, files: kept.length, contents: await sha256File(join(staging, CONTENTS)), verified: now(), discarded: inv.entries.filter(e => e.class === 'discard').length, published: inv.entries.filter(e => e.class === 'published-output').length }
  // A previous archive (an earlier retirement of a since restored run) is
  // replaced only by this verified one.
  await rm(final, { recursive: true, force: true })
  await rename(staging, final)
  return sum
}

export async function readContents(c: RunCopy & { manifest: CopyManifest }): Promise<Contents> {
  const a = c.manifest.lifecycle?.archive
  const file = join(c.dir, ARCHIVE, CONTENTS)
  const text = await readTextOrNull(file)
  if (!a || text === null) throw fail(c.ref, `its archive is unavailable (${ARCHIVE}/${CONTENTS} cannot be read); nothing was changed`, 'archive-unavailable')
  if (createHash('sha256').update(text).digest('hex') !== a.contents) throw fail(c.ref, `its archive's contents list does not match its recorded checksum; nothing was changed`, 'archive-corrupt')
  if (a.sha256) {
    const tgz = join(c.dir, ARCHIVE, FILES)
    if (!(await stat(tgz).catch(() => null))) throw fail(c.ref, `its archive ${FILES} is unavailable; nothing was changed`, 'archive-unavailable')
    if (await sha256File(tgz) !== a.sha256) throw fail(c.ref, `its archive ${FILES} does not match its recorded checksum; nothing was changed`, 'archive-corrupt')
  }
  return JSON.parse(text)
}

// ---- retirement --------------------------------------------------------------------------

const du = async (p: string): Promise<number | null> => new Promise(resolve => {
  const d = spawn('du', ['-sk', p], { stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  d.stdout.on('data', x => { out += x })
  d.on('error', () => resolve(null))
  d.on('close', code => resolve(code === 0 ? Number(out.split(/\s/)[0]) * 1024 : null))
})

export const lifecycleLock = (dir: string) => join(dir, 'lifecycle')
const note = (m: CopyManifest, op: string, by: string, result: string) => { (m.lifecycle ??= { requestedBy: by, requestedAt: now(), phase: op, failure: null, hosts: {}, history: [] }).history.push({ at: now(), op, by, result }) }

export interface RetireResult { ref: string; state: string; outcome: 'dry-run' | 'refused' | 'waiting' | 'retired' | 'failed'; reasons: string[]; inventory?: { repositories: Omit<InventoryRepo, 'refs'>[]; archive: number; discard: number; bytes: number; unclassified: Unclassified[] }; hosts?: Record<string, HostProgress>; failure?: string; treeBytes?: number | null; archive?: Lifecycle['archive'] }

const summary = (inv: Walked): RetireResult['inventory'] => ({
  repositories: inv.repos.map(({ refs: _r, ...x }) => x),
  archive: inv.entries.filter(e => e.class !== 'discard').length,
  discard: inv.entries.filter(e => e.class === 'discard').length,
  bytes: inv.entries.filter(e => e.class !== 'discard').reduce((n, e) => n + e.size, 0),
  unclassified: inv.unclassified,
})

export async function retireRun(x: ExecStore, ws: Workspace, ref: RunRef, o: { by: string; dryRun?: boolean; discard?: Discard[] }): Promise<RetireResult> {
  ws = ws.shared
  const dir = copyDir(ws, ref)
  const key = runKey(ref)
  const first = await inspectRun(x, ws, ref)
  if (!first.managed) return { ref: key, state: 'none', outcome: 'refused', reasons: first.reasons }
  if (first.state === 'retired') return { ref: key, state: 'retired', outcome: 'retired', reasons: [], hosts: (await mustCopy(ws, ref)).manifest.lifecycle?.hosts }
  if (o.dryRun) {
    if (!first.eligible) return { ref: key, state: first.state, outcome: 'dry-run', reasons: first.reasons }
    const c = await mustCopy(ws, ref)
    const inv = await inventoryCopy(c, o.discard)
    return { ref: key, state: first.state, outcome: 'dry-run', reasons: inv.unclassified.map(u => `unclassified ${u.path}: ${u.why}`), inventory: summary(inv), treeBytes: await du(c.tree) }
  }
  return withLock(lifecycleLock(dir), async () => {
    const fresh = await inspectRun(x, ws, ref)
    if (fresh.state === 'retired') return { ref: key, state: 'retired', outcome: 'retired' as const, reasons: [] }
    if (!fresh.eligible) {
      if (fresh.state === 'retiring') await updateManifest(ws, ref, m => { m.state = 'ready'; note(m, 'retire', o.by, `returned to ready: ${fresh.reasons.join('; ')}`) })
      return { ref: key, state: 'ready', outcome: 'refused' as const, reasons: fresh.reasons }
    }
    let step = 'inventory'
    try {
      const c0 = await mustCopy(ws, ref)
      const inv = await inventoryCopy(c0, o.discard)
      if (inv.unclassified.length) return { ref: key, state: c0.manifest.state, outcome: 'refused' as const, reasons: inv.unclassified.map(u => `unclassified ${u.path}: ${u.why} (the copy stays; --discard <path>=<reason> if it is expendable)`), inventory: summary(inv) }
      // From here no new claim or tree writer starts (attempt.begin and the
      // working-tree resolver look at this state, under the run's record lock).
      step = 'mark'
      const recordFile = join(recordFolderOf(dir, ref), RUN_FILE)
      await withLock(recordFile, async () => {
        const again = await inspectRun(x, ws, ref, { fast: true })
        if (!again.eligible) throw Object.assign(new Error(again.reasons.join('; ')), { refused: again.reasons })
        await updateManifest(ws, ref, m => {
          // Running this again continues the same retirement: same generation.
          if (m.state === 'retiring') { m.lifecycle!.failure = null; return }
          m.state = 'retiring'
          m.generation = (m.generation ?? 0) + 1
          m.lifecycle = { requestedBy: o.by, requestedAt: now(), phase: 'marked', failure: null, hosts: m.lifecycle?.hosts ?? {}, history: m.lifecycle?.history ?? [] }
        })
      }, { what: `run ${key}` })
      const c = await mustCopy(ws, ref)
      const record = (await readRun(ws, ref)).record!
      // Workers first: what only they hold must have a place before anything goes.
      step = 'workers'
      const generation = c.manifest.generation!
      const hosts = c.manifest.lifecycle!.hosts
      for (const h of fresh.hosts) if (!hosts[h] || hosts[h].generation !== generation) {
        hosts[h] = { state: 'requested', at: now(), generation }
        await x.storageTask(h, { workspace: ws.reg.id, workflow: ref.workflow, run: ref.run, action: 'archive', generation, repositories: inv.repos.map(r => ({ path: r.path, head: r.head })) })
      }
      await updateManifest(ws, ref, m => { m.lifecycle!.hosts = hosts })
      step = 'commits'
      await retainCommits(ws, c, inv.repos)
      const bad = await verifyRetained(ws, ref, inv.repos)
      if (bad.length) throw new Error(`commits are not retained: ${bad.slice(0, 5).join('; ')}`)
      await updateManifest(ws, ref, m => { m.lifecycle!.phase = 'commits-retained'; m.lifecycle!.repositories = inv.repos.map(r => ({ path: r.path, head: r.head, branch: r.branch, refs: r.refs.length, key: r.key })) })
      step = 'archive'
      const archive = await writeArchive(ws, c, inv, record)
      const treeBytes = await du(c.tree), integrationBytes = await du(join(dir, 'integration'))
      await updateManifest(ws, ref, m => { m.lifecycle!.phase = 'archived'; m.lifecycle!.archive = archive; m.lifecycle!.sizes = { treeBytes, integrationBytes } })
      // The decision: everything rechecked with writers excluded.
      step = 'commit'
      const current = (await mustCopy(ws, ref)).manifest.lifecycle!.hosts
      const open = fresh.hosts.filter(h => !['archived', 'absent'].includes(current[h]?.state ?? 'requested'))
      if (open.length) {
        await updateManifest(ws, ref, m => { m.lifecycle!.phase = 'waiting-for-workers' })
        return { ref: key, state: 'retiring', outcome: 'waiting' as const, reasons: open.map(h => `worker ${h} has not reported its copy (${current[h]?.state ?? 'requested'}); contact unknown means its data is not inventoried. Run this again once it has.`), hosts: current, treeBytes, archive }
      }
      const decided = await withLock(join(c.tree, '.git', 'wfe-publication'), () => withLock(join(dir, 'integration'), () => withLock(recordFile, async () => {
        const last = await inspectRun(x, ws, ref)
        if (!last.eligible) return last.reasons
        await updateManifest(ws, ref, m => {
          m.state = 'retired'
          m.lifecycle!.phase = 'committed'
          note(m, 'retire', o.by, 'retired')
          for (const h of fresh.hosts) if (m.lifecycle!.hosts[h]?.state === 'archived') m.lifecycle!.hosts[h] = { ...m.lifecycle!.hosts[h], state: 'remove-pending', at: now() }
        })
        return null
      }, { what: `run ${key}` }), { timeoutMs: 120_000 }), { timeoutMs: 120_000 })
      if (decided) {
        await updateManifest(ws, ref, m => { m.state = 'ready'; note(m, 'retire', o.by, `returned to ready: ${decided.join('; ')}`) })
        return { ref: key, state: 'ready', outcome: 'refused' as const, reasons: decided }
      }
      step = 'release'
      for (const h of fresh.hosts) if (current[h]?.state === 'archived') await x.storageTask(h, { workspace: ws.reg.id, workflow: ref.workflow, run: ref.run, action: 'remove', generation })
      await releaseTree(dir)
      await updateManifest(ws, ref, m => { m.lifecycle!.phase = 'released' })
      return { ref: key, state: 'retired', outcome: 'retired' as const, reasons: [], treeBytes, archive, hosts: (await mustCopy(ws, ref)).manifest.lifecycle!.hosts }
    } catch (e) {
      if ((e as { refused?: string[] }).refused) return { ref: key, state: 'ready', outcome: 'refused' as const, reasons: (e as unknown as { refused: string[] }).refused }
      const message = (e as Error).message
      const m = await updateManifest(ws, ref, m => { if (m.lifecycle) m.lifecycle.failure = { at: now(), step, message } }).catch(() => null)
      return { ref: key, state: m?.state ?? 'retiring', outcome: 'failed' as const, reasons: [`${step}: ${message}`], failure: message }
    }
  }, { what: `the lifecycle of run ${key}`, timeoutMs: 2_000 })
}

// Releases the tree: moved aside first, so a crash leaves a name that only
// means "finish removing this".
async function releaseTree(dir: string) {
  const tree = join(dir, 'tree'), removing = join(dir, TREE_REMOVING)
  if (await stat(tree).catch(() => null)) { await rm(removing, { recursive: true, force: true }); await rename(tree, removing) }
  await rm(removing, { recursive: true, force: true })
  await rm(join(dir, 'integration'), { recursive: true, force: true })
}

// ---- restoration -------------------------------------------------------------------------

async function fetchRetained(ws: Workspace, ref: RunRef, r: InventoryRepo, cwd: string) {
  const bare = retentionRepo(ws, r.key)
  const space = refSpace(ref, r.path)
  const specs = r.refs.map(x => `+${space}/${x.ref.slice('refs/'.length)}:${x.ref}`)
  if (specs.length) await gitOk(cwd, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--update-head-ok', bare, ...specs], { config: LOCAL_TRANSPORT, timeoutMs: GIT_LONG })
  if (r.head && !r.refs.some(x => x.oid === r.head)) await gitOk(cwd, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', bare, `+${space}/HEAD:refs/wfe/retain-head`], { config: LOCAL_TRANSPORT, timeoutMs: GIT_LONG })
  // The manifest's url: the contents list is hashed and keeps the url from before a rename.
  const url = (await readCopy(ws.shared, ref))?.manifest?.repositories.find(x => x.path === r.path)?.url ?? r.url
  if (url) { await git(cwd, ['remote', 'remove', 'origin']); await gitOk(cwd, ['remote', 'add', 'origin', url]) }
}

// Rebuilds the tree in staging with Git's standard layout (relative paths, so
// the finished tree can be renamed into place).
async function rebuildTree(ws: Workspace, ref: RunRef, stagingPath: string, contents: Contents, archiveDir: string) {
  await mkdir(stagingPath, { recursive: true })
  const staging = await realpath(stagingPath) // Git answers with real paths; the relative layout is computed from both
  const ordered = [...contents.repositories].sort((a, b) => a.path.split('/').length - b.path.split('/').length || (a.path === '.' ? -1 : 1))
  const paths = ordered.map(r => r.path).filter(p => p !== '.')
  for (const r of ordered) {
    if (r.path === '.') {
      await gitOk(staging, ['init', '-q'])
    } else {
      const parentPath = ownerOf(r.path, paths)
      const parent = parentPath === '.' ? staging : join(staging, parentPath)
      const rel = parentPath === '.' ? r.path : r.path.slice(parentPath.length + 1)
      const name = await moduleName(parent, rel)
      const parentGit = (await gitOk(parent, ['rev-parse', '--absolute-git-dir'])).trim()
      const gitDir = join(parentGit, 'modules', name)
      const work = join(parent, rel)
      await mkdir(gitDir, { recursive: true })
      await mkdir(work, { recursive: true })
      await gitOk(gitDir, ['init', '-q', '--bare'])
      await gitOk(gitDir, ['config', 'core.bare', 'false'])
      await gitOk(gitDir, ['config', 'core.worktree', relative(gitDir, work)])
      await writeFile(join(work, '.git'), `gitdir: ${relative(work, gitDir)}\n`)
      await gitOk(parent, ['config', `submodule.${name}.active`, 'true'])
      if (r.url) await gitOk(parent, ['config', `submodule.${name}.url`, r.url])
    }
    const dir = r.path === '.' ? staging : join(staging, r.path)
    await fetchRetained(ws, ref, r, dir)
    if (r.head) {
      if (r.branch) await gitOk(dir, ['symbolic-ref', 'HEAD', `refs/heads/${r.branch}`])
      await gitOk(dir, ['checkout', '-q', '-f', ...(r.branch ? [r.branch] : [r.head])], { timeoutMs: GIT_LONG })
    }
  }
  if (contents.files) await tarExtract(join(archiveDir, contents.files), staging)
  for (const r of ordered) {
    const dir = r.path === '.' ? staging : join(staging, r.path)
    for (const d of r.deleted) await rm(join(staging, d), { recursive: true, force: true })
    for (const [name, gitPath] of [['exclude', 'info/exclude'], ['index', 'index']]) {
      const src = join(archiveDir, `${r.key}.${name}`)
      if (!(await stat(src).catch(() => null))) continue
      const raw = (await gitOk(dir, ['rev-parse', '--git-path', gitPath])).trim()
      const to = raw.startsWith('/') ? raw : join(dir, raw)
      await mkdir(dirname(to), { recursive: true })
      await copyFile(src, to)
    }
    await git(dir, ['update-index', '-q', '--refresh'])
  }
}

async function moduleName(parent: string, rel: string): Promise<string> {
  const r = await git(parent, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'])
  for (const line of r.stdout.split('\n')) {
    const m = /^submodule\.(.+)\.path (.*)$/.exec(line)
    if (m && m[2].replace(/\/+$/, '') === rel) return m[1]
  }
  return rel
}

export interface RestoreResult { ref: string; state: string; outcome: 'dry-run' | 'restored' | 'nothing' | 'failed'; reasons: string[]; discarded?: { path: string; reason?: string }[] }

export async function restoreRun(_x: ExecStore, ws: Workspace, ref: RunRef, o: { by: string; dryRun?: boolean }): Promise<RestoreResult> {
  ws = ws.shared
  const dir = copyDir(ws, ref)
  const key = runKey(ref)
  const peek = await mustCopy(ws, ref)
  if (o.dryRun) {
    if (peek.manifest.state === 'ready' || peek.manifest.state === 'creating') return { ref: key, state: peek.manifest.state, outcome: 'dry-run', reasons: ['nothing to restore'] }
    const contents = await readContents(peek).catch(e => e as Error)
    if (contents instanceof Error) return { ref: key, state: peek.manifest.state, outcome: 'dry-run', reasons: [contents.message] }
    const bad = await verifyRetained(ws, ref, contents.repositories)
    return { ref: key, state: peek.manifest.state, outcome: 'dry-run', reasons: bad, discarded: contents.entries.filter(e => e.class === 'discard').map(e => ({ path: e.path, reason: e.reason })) }
  }
  return withLock(lifecycleLock(dir), async () => {
    const c = await mustCopy(ws, ref)
    const m0 = c.manifest
    if (m0.state === 'ready') return { ref: key, state: 'ready', outcome: 'nothing' as const, reasons: [] }
    // A retirement that never released the tree simply ends: the tree is as it was.
    if (m0.state !== 'retired' && m0.state !== 'restoring' && await stat(join(c.tree, '.git')).catch(() => null)) {
      await updateManifest(ws, ref, m => { m.state = 'ready'; m.generation = (m.generation ?? 0) + 1; note(m, 'restore', o.by, 'the retirement was abandoned; the tree was never released') })
      await rm(join(dir, ARCHIVE_STAGING), { recursive: true, force: true })
      return { ref: key, state: 'ready', outcome: 'restored' as const, reasons: [] }
    }
    const fresh = await stat(join(c.tree, '.git')).catch(() => null)
    let step = 'verify'
    try {
      // A retired run whose release was interrupted finishes that first.
      if (fresh && m0.state === 'retired') await releaseTree(dir)
      const contents = await readContents(c)
      const bad = await verifyRetained(ws, ref, contents.repositories)
      if (bad.length) throw fail(ref, `its commits cannot be restored: ${bad.slice(0, 5).join('; ')}; nothing was changed`, 'retention-unavailable')
      await updateManifest(ws, ref, m => { m.state = 'restoring'; m.lifecycle!.failure = null; m.lifecycle!.phase = 'restoring' })
      step = 'rebuild'
      const staging = join(dir, TREE_RESTORING)
      await rm(staging, { recursive: true, force: true })
      await rebuildTree(ws, ref, staging, contents, join(dir, ARCHIVE))
      step = 'compare'
      const wrong = await compareEntries(staging, contents.entries)
      for (const r of contents.repositories) {
        const d = r.path === '.' ? staging : join(staging, r.path)
        const head = (await git(d, ['rev-parse', '-q', '--verify', 'HEAD'])).stdout.trim() || null
        if (head !== r.head) wrong.push(`${r.path}: at ${head?.slice(0, 12)}, saved at ${r.head?.slice(0, 12)}`)
      }
      if (wrong.length) throw new Error(`the rebuilt copy differs from what was saved: ${wrong.slice(0, 5).join('; ')}`)
      const unavailable = await restorePublished(ws, ref, staging, contents.entries)
      step = 'commit'
      await rm(join(staging, runFolder(ref)), { recursive: true, force: true })
      await rename(staging, c.tree)
      await linkRecord(c.tree, ref, recordOwner(m0))
      await updateManifest(ws, ref, m => {
        m.state = 'ready'
        m.generation = (m.generation ?? 0) + 1
        m.lifecycle!.phase = 'restored'
        note(m, 'restore', o.by, unavailable.length ? `restored; ${unavailable.length} published files not restored` : 'restored')
      })
      return { ref: key, state: 'ready', outcome: 'restored' as const, reasons: unavailable, discarded: contents.entries.filter(e => e.class === 'discard').map(e => ({ path: e.path, reason: e.reason })) }
    } catch (e) {
      const message = (e as Error).message
      const m = await updateManifest(ws, ref, m => { if (step === 'verify') m.state = 'retired'; if (m.lifecycle) m.lifecycle.failure = { at: now(), step, message } }).catch(() => null)
      return { ref: key, state: m?.state ?? 'restoring', outcome: 'failed' as const, reasons: [`${step}: ${message}`] }
    }
  }, { what: `the lifecycle of run ${key}`, timeoutMs: 2_000 })
}

// ---- reads and views ---------------------------------------------------------------------

// A file a retired run no longer has on disk: from the retained commit, or from
// its archive. Nothing is written or restored by reading.
export async function retainedFile(ws: Workspace, ref: RunRef, path: string): Promise<Buffer | null> {
  const c = await readCopy(ws.shared, ref)
  if (!c?.manifest || c.manifest.state === 'ready') return null
  const text = await readTextOrNull(join(c.dir, ARCHIVE, CONTENTS))
  if (text === null) return null
  const contents = JSON.parse(text) as Contents
  const entry = contents.entries.find(e => e.path === path && e.class === 'archive' && e.type === 'file')
  if (entry && contents.files) {
    const out: Buffer[] = []
    const code = await new Promise<number>(resolve => {
      const t = spawn('tar', ['-xzOf', join(c.dir, ARCHIVE, contents.files!), `./${path}`], { stdio: ['ignore', 'pipe', 'ignore'] })
      t.stdout.on('data', d => out.push(d as Buffer))
      t.on('close', x => resolve(x ?? 1)); t.on('error', () => resolve(1))
    })
    if (code === 0) return Buffer.concat(out)
  }
  const published = contents.entries.find(e => e.path === path && e.class === 'published-output')
  if (published?.sha256) {
    const rec = (await readRun(ws.shared, ref)).record
    const src = rec ? (await publishedSources(ws.shared, rec)).sources.get(published.sha256) : undefined
    return src ? readFile(src) : null
  }
  const owner = ownerOf(path, contents.repositories.map(r => r.path))
  const r = contents.repositories.find(x => x.path === owner)
  if (!r?.head) return null
  const { gitBytes } = await import('./git.ts')
  const inner = owner === '.' ? path : path.slice(owner.length + 1)
  const b = await gitBytes(retentionRepo(ws, r.key), ['cat-file', 'blob', `${r.head}:${inner}`], { timeoutMs: 120_000, maxBuffer: 1024 * 1024 * 1024 })
  return b.code === 0 ? b.stdout : null
}

export interface StorageView {
  ref: string; managed: boolean; state: string; retained: string; action: 'retire' | 'restore' | null; eligible: boolean; reasons: string[]
  problem: string | null; lifecycle: Lifecycle | null; generation: number; hosts: Record<string, HostProgress>
}

export async function storageView(x: ExecStore, ws: Workspace, ref: RunRef): Promise<StorageView> {
  const e = await inspectRun(x, ws, ref, { fast: true })
  const c = await readCopy(ws.shared, ref)
  const lifecycle = c?.manifest?.lifecycle ?? null
  const state = e.state
  const retained = !e.managed ? 'This run has no working copy of its own; its record is in the project workspace.'
    : state === 'retired' ? `Its working copy is retired. The record stays readable here, and its saved commits${lifecycle?.archive?.files ? ` and ${lifecycle.archive.files} non-committed files` : ''} are kept; restoring brings the copy back.`
      : state === 'retiring' ? 'Its working copy is being retired. The record stays readable.'
        : state === 'restoring' ? 'Its working copy is being restored. The record stays readable.'
          : c?.problem ? `Its working copy has a problem: ${c.problem}`
            : 'Its working copy is in place.'
  return { ref: runKey(ref), managed: e.managed, state, retained, action: state === 'retired' ? 'restore' : state === 'ready' && e.eligible ? 'retire' : state === 'retiring' ? 'retire' : null, eligible: e.eligible, reasons: state === 'retired' ? [] : e.reasons, problem: c?.problem ?? null, lifecycle, generation: c?.manifest?.generation ?? 0, hosts: lifecycle?.hosts ?? {} }
}

// ---- worker reports (the coordinator's side) -------------------------------------------------

export interface WorkerReport { generation: number; state: 'archived' | 'absent' | 'removed' | 'refused'; detail?: string; archive?: { sha256: string; bytes: number } | null; files?: number; treeBytes?: number | null }

// A report for an older generation changes nothing: the run was retired or
// restored since, and that worker's message is stale.
export async function workerStorageReport(ws: Workspace, ref: RunRef, worker: string, r: WorkerReport): Promise<{ accepted: boolean; why?: string }> {
  const c = await mustCopy(ws, ref)
  if ((c.manifest.generation ?? 0) !== r.generation) return { accepted: false, why: `generation ${r.generation} is stale; the run is at ${c.manifest.generation ?? 0}` }
  if (r.state === 'archived' && r.archive) {
    const file = join(c.dir, 'worker-archive', worker, FILES)
    if (!(await stat(file).catch(() => null)) || await sha256File(file) !== r.archive.sha256) return { accepted: false, why: 'the uploaded archive does not match its checksum' }
  }
  await updateManifest(ws, ref, m => {
    const h = m.lifecycle!.hosts
    h[worker] = { ...h[worker], state: r.state, at: now(), generation: r.generation, ...(r.detail ? { detail: r.detail } : {}), ...(r.archive !== undefined ? { archive: r.archive } : {}), ...(r.files !== undefined ? { files: r.files } : {}), ...(r.treeBytes !== undefined ? { treeBytes: r.treeBytes } : {}) }
  })
  return { accepted: true }
}

// The worker's archive of a run, streamed in; verified when the report comes.
export async function receiveWorkerArchive(ws: Workspace, ref: RunRef, worker: string, generation: number, body: AsyncIterable<Buffer>): Promise<void> {
  const c = await mustCopy(ws, ref)
  if ((c.manifest.generation ?? 0) !== generation || c.manifest.state !== 'retiring') throw fail(ref, `generation ${generation} is stale, or the run is not being retired; nothing was stored`, 'run-retired')
  const dir = join(c.dir, 'worker-archive', worker)
  await mkdir(dir, { recursive: true })
  const part = join(dir, `${FILES}.part`)
  await pipeline(body as never, createWriteStream(part))
  await rename(part, join(dir, FILES))
}
export const workerArchiveFile = (ws: Workspace, ref: RunRef, worker: string) => join(copyDir(ws.shared, ref), 'worker-archive', worker, FILES)
