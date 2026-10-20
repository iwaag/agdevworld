// Project access (project_migration p4, docs/access.md): reading any managed
// project — its definition, structure, files, workflows and runs — for any
// system agent or operator, with no knowledge of who asks or why.
//
// Committed content is the default and is read from system-managed caches:
// one bare repository per Gitea repository under <area>/.local/access-cache/,
// fetched under a lock with the existing Gitea credentials. Nothing is fetched
// into, checked out in or written to any workspace. A submodule path is read
// at the commit its project pins, unless the caller asks for the upstream
// tip. A workspace's working tree is read only when asked for, and labelled.
// Every result says which repository, commit and path it is, when it was
// observed, and whether the cache was fresh; failures are one of absent,
// inaccessible, uninitialized or fetch-failed, never an empty answer.
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ID_PATTERN, normalizeRepoPath, type Project, type Workflow } from '../shared/model.ts'
import { runKey, RUN_ID, RUNS_ROOT, type RunRef } from '../shared/run.ts'
import type { RunSummary } from '../shared/api.ts'
import { gitmodules } from './agdev.ts'
import { assertWorkspaceAllowed, loadBoundary, retiredById, retiredByName } from './boundary.ts'
import { inside } from './files.ts'
import { git, gitBytes } from './git.ts'
import { repoOfUrl, type GiteaRepo } from './gitea.ts'
import { withLock } from './lock.ts'
import { loadRegistry, observe, type Registration, type RepoCategory, type RepoEntry } from './registry.ts'
import { listRuns, readFrom, readRun, summaryOf, type Source } from './runs.ts'
import { runSpace } from './runspace.ts'
import { RequestError, Workspace } from './workspace.ts'
import { parseProject, parseWorkflow } from './yamlDoc.ts'

export const ACCESS_SCHEMA = 'ag.wfe-access.v1'

// Where repositories are fetched from: the Gitea of this registry (server/gitea.ts
// satisfies it). Tests give a local stand-in.
export interface RepoHost {
  url: string
  cloneUrl(owner: string, name: string): string
  gitEnv(): Promise<Record<string, string>>
  repoById(id: number): Promise<GiteaRepo | null>
  repo(owner: string, name: string): Promise<GiteaRepo | null>
}

export interface AccessContext {
  registryFile: string
  area: string
  gitea?: RepoHost
  giteaProblem?: string
  // A repository fetched less than this long ago (by any process) is read
  // from its cache without fetching again; `refresh` fetches regardless.
  fetchTtlMs?: number
  refresh?: boolean
  now?: () => Date
}

export type FailureState = 'absent' | 'inaccessible' | 'uninitialized' | 'fetch-failed'
const STATUS: Record<FailureState, number> = { absent: 404, inaccessible: 403, uninitialized: 409, 'fetch-failed': 502 }

export class AccessError extends RequestError {
  state: FailureState
  constructor(state: FailureState, message: string, detail: Record<string, unknown> = {}) {
    super(STATUS[state], message, { state, ...detail })
    this.state = state
  }
}

export interface FetchInfo { state: 'fresh' | 'recent' | 'stale'; at: string; error?: string }
export interface RepoRef {
  key: string | null // registry key (gitea:<id>) when registered
  fullName: string // owner/name on Gitea now
  path: string // where the project mounts it ('.' for the root)
  category: RepoCategory
  registered: boolean
  defaultBranch: string
}
export interface Revision {
  selector: 'branch' | 'commit' | 'pinned' | 'upstream' | 'worktree'
  ref?: string // the branch or commit the caller named
  commit: string
  pinnedBy?: { repository: string; commit: string } // the repository and commit whose gitlink this is
}
export interface Provenance {
  schema: typeof ACCESS_SCHEMA
  project: string
  source: 'committed' | 'worktree' | 'live'
  repository: RepoRef
  revision: Revision
  path: string // project-relative
  observed: string
  fetch?: FetchInfo
  workspace?: { id: string; dirty: boolean } // worktree and live reads
}

export interface ReadOptions {
  rev?: string // a branch or commit of the project root (or of the addressed repository)
  upstream?: boolean // read the first submodule on the path at its default-branch tip
  require?: string // the read source must contain this commit
  source?: 'committed' | 'worktree'
  workspace?: string // which workspace, for the worktree
}

export const LIMITS = {
  read: { default: 256 * 1024, max: 4 * 1024 * 1024 },
  tree: { default: 2000, max: 20000 },
  search: { default: 200, max: 2000 },
  runs: 500,
}

const now = (ctx: AccessContext) => (ctx.now?.() ?? new Date()).toISOString()
const exists = (p: string) => stat(p).then(() => true, () => false)
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const isHex = (s: string) => /^[0-9a-f]{7,64}$/.test(s)
const categoryOf = (path: string, fallback?: RepoCategory): RepoCategory =>
  path === '.' ? 'root' : path === 'devdocs' ? 'devdocs' : path === 'study' || path.startsWith('study/') ? 'study' : path === 'wedo' || path.startsWith('wedo/') ? 'wedo' : fallback ?? 'other'

// ---- caches -------------------------------------------------------------------------

interface Cached { dir: string; fetch: FetchInfo; repo: GiteaRepo }

const cacheRoot = (ctx: AccessContext) => join(ctx.area, '.local', 'access-cache')

function host(ctx: AccessContext): RepoHost {
  if (!ctx.gitea) throw new AccessError('inaccessible', `committed content is read from Gitea, which is not available here: ${ctx.giteaProblem ?? 'no Gitea setting'}`)
  return ctx.gitea
}

// The current identity of a Gitea repository (by id when known; a rename keeps
// the id), and its fetched cache.
async function cached(ctx: AccessContext, at: { id?: number; owner: string; name: string }): Promise<Cached> {
  const g = host(ctx)
  let repo: GiteaRepo | null
  let apiError: string | undefined
  try { repo = at.id !== undefined ? await g.repoById(at.id) : await g.repo(at.owner, at.name) } catch (e) { repo = null; apiError = (e as Error).message }
  if (repo === null && !apiError) throw new AccessError('absent', `${at.owner}/${at.name}${at.id !== undefined ? ` (Gitea id ${at.id})` : ''} does not exist on Gitea`, { repository: `${at.owner}/${at.name}` })
  const id = repo?.id ?? at.id
  const dir = join(cacheRoot(ctx), id !== undefined ? `gitea-${id}.git` : `${at.owner}--${at.name}.git`)
  const stampFile = join(dir, 'wfe-access.json')
  await mkdir(cacheRoot(ctx), { recursive: true })
  return withLock(dir, async () => {
    if (!(await exists(join(dir, 'HEAD')))) {
      const r = await git(cacheRoot(ctx), ['init', '--bare', '-q', dir])
      if (r.code !== 0) throw new AccessError('fetch-failed', `the access cache for ${at.owner}/${at.name} cannot be created: ${r.stderr.trim()}`)
    }
    const stamp = await readFile(stampFile, 'utf8').then(t => JSON.parse(t) as { fetchedAt: string; repo: GiteaRepo }, () => null)
    const ttl = ctx.fetchTtlMs ?? 10_000
    if (stamp && !ctx.refresh && !apiError && Date.now() - Date.parse(stamp.fetchedAt) < ttl && stamp.repo?.id === repo?.id) {
      return { dir, repo: repo!, fetch: { state: 'recent' as const, at: stamp.fetchedAt } }
    }
    const fail = (error: string): Cached => {
      if (!stamp) throw new AccessError('fetch-failed', `${at.owner}/${at.name} could not be read from Gitea and nothing is cached: ${error}`, { repository: `${at.owner}/${at.name}` })
      return { dir, repo: repo ?? stamp.repo, fetch: { state: 'stale', at: stamp.fetchedAt, error } }
    }
    if (apiError) return fail(apiError)
    const f = await git(dir, ['fetch', '-q', '--prune', '--', g.cloneUrl(repo!.owner, repo!.name), '+refs/heads/*:refs/heads/*'], { env: await g.gitEnv(), timeoutMs: 180_000 })
    if (f.code !== 0) return fail(f.stderr.trim().split('\n').at(-1) ?? `git fetch exited ${f.code}`)
    const at2 = now(ctx)
    await writeFile(stampFile, `${JSON.stringify({ fetchedAt: at2, repo })}\n`)
    return { dir, repo: repo!, fetch: { state: 'fresh' as const, at: at2 } }
  }, { what: `access cache ${at.owner}/${at.name}`, timeoutMs: 240_000 })
}

async function commitOf(dir: string, ref: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--verify', '-q', `${isHex(ref) ? ref : `refs/heads/${ref}`}^{commit}`])
  return r.code === 0 ? r.stdout.trim() : null
}

// ---- resolving a path to a repository and a commit ---------------------------------

interface Located {
  project: string
  dir: string // the cache of the repository holding the path
  commit: string
  inner: string // the path inside that repository ('' for its root)
  repository: RepoRef
  revision: Revision
  fetch: FetchInfo
  // Submodules between the project root and the path, outermost first.
  chain: { path: string; repository: string; pinned: string; commit: string }[]
}

interface Start { project: string; entry?: RepoEntry; at: { id?: number; owner: string; name: string }; category: RepoCategory }

// A project id, or `repo:<owner>/<name>` / `gitea:<id>` for a registered repository.
async function start(ctx: AccessContext, target: string): Promise<Start> {
  const reg = await loadRegistry(ctx.registryFile)
  const boundary = await loadBoundary(ctx.registryFile, ctx.area)
  let entry: RepoEntry | undefined
  if (target.startsWith('repo:') || target.startsWith('gitea:')) {
    const m = /^repo:([^/\s]+)\/([^/\s]+)$/.exec(target)
    entry = target.startsWith('gitea:') ? reg.repositories.find(r => r.key === target) : m ? reg.repositories.find(r => r.gitea.owner === m[1] && r.gitea.name === m[2].replace(/\.git$/, '')) : undefined
    if (!entry) throw new AccessError('absent', `${target} is not a registered repository (see: wfe projects list)`)
  } else {
    if (!ID_PATTERN.test(target)) throw new RequestError(400, `"${target}" is not a project id`)
    const p = reg.projects.find(x => x.id === target)
    if (!p) throw new AccessError('absent', `project "${target}" is not registered (see: wfe projects list)`)
    entry = reg.repositories.find(r => r.key === p.root)
  }
  if (!entry) throw new AccessError('absent', `the root repository of ${target} is not registered`)
  const retired = retiredById(boundary, entry.gitea.id)
  if (retired) throw new AccessError('inaccessible', `${entry.gitea.owner}/${entry.gitea.name} is a retired repository (${retired.why})`)
  return { project: target, entry, at: entry.gitea, category: entry.category }
}

function repoRef(c: Cached, path: string, registered: RepoEntry | undefined, fallback?: RepoCategory): RepoRef {
  return { key: registered?.key ?? null, fullName: c.repo.fullName, path, category: registered && path === '.' ? registered.category : categoryOf(path, registered?.category ?? fallback), registered: !!registered, defaultBranch: c.repo.defaultBranch }
}

export async function locate(ctx: AccessContext, target: string, rawPath: string, opts: ReadOptions = {}): Promise<Located> {
  const path = rawPath === '' || rawPath === '.' ? '.' : normalizeRepoPath(rawPath)
  if (!path) throw new RequestError(400, `"${rawPath}" is not a project-relative path`)
  if (path === '.local' || path.startsWith('.local/') || path.split('/').includes('.git')) throw new AccessError('inaccessible', `${path} is host-local and never project content`)
  const s = await start(ctx, target)
  const reg = await loadRegistry(ctx.registryFile)
  const boundary = await loadBoundary(ctx.registryFile, ctx.area)
  const root = await cached(ctx, s.at)
  const ref = opts.rev ?? root.repo.defaultBranch
  const commit = await commitOf(root.dir, ref)
  if (!commit) throw new AccessError('absent', `${root.repo.fullName} has no ${isHex(ref) ? 'commit' : 'branch'} ${ref}${root.fetch.state === 'stale' ? ` in its cache (stale since ${root.fetch.at}: ${root.fetch.error})` : ''}`, { repository: root.repo.fullName, fetch: root.fetch })
  let cur: Located = {
    project: s.project, dir: root.dir, commit, inner: path === '.' ? '' : path,
    repository: repoRef(root, '.', s.entry), revision: { selector: opts.rev ? (isHex(opts.rev) ? 'commit' : 'branch') : 'branch', ref, commit },
    fetch: root.fetch, chain: [],
  }
  let mount = '.'
  for (let depth = 0; cur.inner && depth < 8; depth++) {
    const mods = await git(cur.dir, ['show', `${cur.commit}:.gitmodules`])
    const subs = mods.code === 0 ? gitmodules(mods.stdout) : []
    const sm = subs.map(m => ({ ...m, path: normalizeRepoPath(m.path) ?? m.path })).find(m => cur.inner === m.path || cur.inner.startsWith(`${m.path}/`))
    if (!sm) break
    const here = mount === '.' ? sm.path : `${mount}/${sm.path}`
    const tree = await git(cur.dir, ['ls-tree', cur.commit, '--', sm.path])
    const link = /^160000 commit ([0-9a-f]+)\t/.exec(tree.stdout)?.[1]
    if (!link) throw new AccessError('absent', `${here} is in .gitmodules of ${cur.repository.fullName} but has no gitlink at ${cur.commit.slice(0, 10)}`)
    const [owner, name] = cur.repository.fullName.split('/')
    const at = repoOfUrl(sm.url, { giteaUrl: host(ctx).url, owner, name })
    if (!at) throw new AccessError('inaccessible', `${here} is ${sm.url}, which is not a repository of this Gitea; its content cannot be read here`, { path: here, url: sm.url, pinned: link })
    const retired = retiredByName(boundary, at.owner, at.name)
    if (retired) throw new AccessError('inaccessible', `${here} is the retired repository ${at.owner}/${at.name} (${retired.why})`)
    const entry = reg.repositories.find(r => r.gitea.owner === at.owner && r.gitea.name === at.name)
    const sub = await cached(ctx, { id: entry?.gitea.id, ...at })
    const upstream = opts.upstream && depth === 0
    let subCommit = link
    if (upstream) {
      const tip = await commitOf(sub.dir, sub.repo.defaultBranch)
      if (!tip) throw new AccessError('absent', `${sub.repo.fullName} has no branch ${sub.repo.defaultBranch}`)
      subCommit = tip
    } else if (!(await commitOf(sub.dir, link))) {
      throw new AccessError('absent', `${cur.repository.fullName}@${cur.commit.slice(0, 10)} pins ${here} at ${link.slice(0, 10)}, which ${sub.repo.fullName} does not have on any branch${sub.fetch.state === 'stale' ? ` (its cache is stale: ${sub.fetch.error})` : ''}`, { pinned: link, repository: sub.repo.fullName })
    }
    cur = {
      ...cur, dir: sub.dir, commit: subCommit, inner: cur.inner === sm.path ? '' : cur.inner.slice(sm.path.length + 1),
      repository: repoRef(sub, here, entry, s.category === 'root' ? undefined : s.category),
      revision: { selector: upstream ? 'upstream' : 'pinned', ...(upstream ? { ref: sub.repo.defaultBranch } : {}), commit: subCommit, pinnedBy: { repository: cur.repository.fullName, commit: cur.commit } },
      fetch: sub.fetch.state === 'stale' ? sub.fetch : cur.fetch.state === 'stale' ? cur.fetch : sub.fetch,
      chain: [...cur.chain, { path: here, repository: sub.repo.fullName, pinned: link, commit: subCommit }],
    }
    mount = here
  }
  if (opts.require) {
    const req = await git(cur.dir, ['rev-parse', '--verify', '-q', `${opts.require}^{commit}`])
    const contained = req.code === 0 && (await git(cur.dir, ['merge-base', '--is-ancestor', req.stdout.trim(), cur.commit])).code === 0
    if (!contained) throw new AccessError('absent', `${cur.repository.fullName}@${cur.commit.slice(0, 10)} does not contain the required commit ${opts.require}`, { required: opts.require, commit: cur.commit, repository: cur.repository.fullName })
  }
  return cur
}

const provenance = (ctx: AccessContext, l: Located, path: string): Provenance => ({
  schema: ACCESS_SCHEMA, project: l.project, source: 'committed', repository: l.repository, revision: l.revision,
  path, observed: now(ctx), fetch: l.fetch,
})
const join2 = (a: string, b: string) => (!a || a === '.' ? b : !b ? a : `${a}/${b}`)
const projectPath = (l: Located, inner: string) => join2(l.repository.path === '.' ? '' : l.repository.path, inner) || '.'

// ---- the working tree (explicit only) -----------------------------------------------

export interface WorktreeLocated { ws: Workspace; root: string; repoRoot: string; inner: string; uninitialized?: string; dirty: boolean; head?: string; branch?: string | null }

async function projectWorkspace(ctx: AccessContext, project: string, id?: string): Promise<Registration> {
  const reg = await loadRegistry(ctx.registryFile)
  const candidates = reg.workspaces.filter(w => w.project === project && (!id || w.id === id))
  if (!candidates.length) throw new AccessError('absent', id ? `workspace "${id}" is not a workspace of ${project}` : `${project} has no workspace on this host (committed content is still readable)`)
  if (candidates.length > 1) throw new RequestError(409, `${project} has several workspaces here (${candidates.map(w => w.id).join(', ')}); name one with --workspace`)
  const w = candidates[0]
  try { await assertWorkspaceAllowed(await loadBoundary(ctx.registryFile, ctx.area), w, 'Reading') } catch (e) { throw new AccessError('inaccessible', (e as Error).message) }
  const o = await observe(w)
  if (!o.available) throw new AccessError('absent', `workspace ${w.id} is registered but not available: ${o.reason}`)
  return w
}

export async function locateWorktree(ctx: AccessContext, project: string, rawPath: string, workspaceId?: string): Promise<WorktreeLocated> {
  const path = rawPath === '' || rawPath === '.' ? '' : normalizeRepoPath(rawPath)
  if (path === null || path === undefined) throw new RequestError(400, `"${rawPath}" is not a project-relative path`)
  if (path === '.local' || path.startsWith('.local/') || path.split('/').includes('.git')) throw new AccessError('inaccessible', `${path} is host-local and never project content`)
  const reg = await projectWorkspace(ctx, project, workspaceId)
  const ws = new Workspace(reg)
  let repoRoot = ws.root, inner = path
  for (const sm of await ws.submodulePaths()) {
    const sp = normalizeRepoPath(sm.path) ?? sm.path
    if (path === sp || path.startsWith(`${sp}/`)) {
      const dir = join(ws.root, sp)
      const top = await git(dir, ['rev-parse', '--show-toplevel'])
      if (!(await exists(join(dir, '.git'))) || top.code !== 0 || top.stdout.trim() !== await realpath(dir).catch(() => '')) return { ws, root: ws.root, repoRoot: dir, inner: '', uninitialized: sp, dirty: false }
      repoRoot = dir; inner = path === sp ? '' : path.slice(sp.length + 1)
    }
  }
  const head = await git(repoRoot, ['rev-parse', 'HEAD'])
  const branch = await git(repoRoot, ['symbolic-ref', '-q', '--short', 'HEAD'])
  const dirty = await git(repoRoot, ['status', '--porcelain=v1', '--', inner || '.'])
  return { ws, root: ws.root, repoRoot, inner, dirty: dirty.stdout.trim() !== '', head: head.stdout.trim() || undefined, branch: branch.code === 0 ? branch.stdout.trim() : null }
}

function worktreeProvenance(ctx: AccessContext, project: string, w: WorktreeLocated, path: string): Provenance {
  const mount = w.repoRoot === w.root ? '.' : w.repoRoot.slice(w.root.length + 1)
  return {
    schema: ACCESS_SCHEMA, project, source: 'worktree',
    repository: { key: null, fullName: mount === '.' ? 'project root' : mount, path: mount, category: categoryOf(mount), registered: false, defaultBranch: w.branch ?? '' },
    revision: { selector: 'worktree', commit: w.head ?? '', ...(w.branch ? { ref: w.branch } : {}) },
    path, observed: now(ctx), workspace: { id: w.ws.reg.id, dirty: w.dirty },
  }
}

export async function ignored(repoRoot: string, rel: string): Promise<boolean> {
  return (await git(repoRoot, ['check-ignore', '-q', '--', rel])).code === 0
}

// ---- content ------------------------------------------------------------------------

export interface TreeEntry { path: string; type: 'file' | 'dir' | 'submodule' | 'symlink'; size?: number; object?: string }
export interface TreeResult { provenance: Provenance; entries: TreeEntry[]; truncated: boolean; total: number }

function parseLsTree(out: string): { mode: string; type: string; object: string; size: string; path: string }[] {
  return out.split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t')
    const [mode, type, object, size] = line.slice(0, tab).split(/\s+/)
    return { mode, type, object, size, path: line.slice(tab + 1) }
  })
}
const entryType = (mode: string, type: string): TreeEntry['type'] => (type === 'tree' ? 'dir' : type === 'commit' ? 'submodule' : mode === '120000' ? 'symlink' : 'file')

export async function tree(ctx: AccessContext, target: string, path: string, opts: ReadOptions & { depth?: number; max?: number } = {}): Promise<TreeResult> {
  const max = Math.min(opts.max ?? LIMITS.tree.default, LIMITS.tree.max)
  const depth = Math.max(1, opts.depth ?? 1)
  if (opts.source === 'worktree') return worktreeTree(ctx, target, path, opts.workspace, depth, max)
  const l = await locate(ctx, target, path, opts)
  if (l.inner) {
    const t = await git(l.dir, ['cat-file', '-t', `${l.commit}:${l.inner}`])
    if (t.code !== 0) throw new AccessError('absent', `${projectPath(l, l.inner)} does not exist in ${l.repository.fullName}@${l.commit.slice(0, 10)}`, { provenance: provenance(ctx, l, projectPath(l, l.inner)) })
    if (t.stdout.trim() !== 'tree') {
      const one = parseLsTree((await git(l.dir, ['ls-tree', '-l', '-z', l.commit, '--', l.inner])).stdout)
      return { provenance: provenance(ctx, l, projectPath(l, l.inner)), entries: one.map(e => ({ path: projectPath(l, e.path), type: entryType(e.mode, e.type), ...(e.size !== '-' ? { size: Number(e.size) } : {}), object: e.object })), truncated: false, total: one.length }
    }
  }
  const r = await git(l.dir, ['ls-tree', '-l', '-z', ...(depth > 1 ? ['-r', '-t'] : []), l.commit, ...(l.inner ? ['--', `${l.inner}/`] : [])], { timeoutMs: 60_000 })
  const base = l.inner ? l.inner.split('/').length : 0
  const all = parseLsTree(r.stdout).filter(e => e.path.split('/').length - base <= depth)
  return {
    provenance: provenance(ctx, l, projectPath(l, l.inner)), total: all.length, truncated: all.length > max,
    entries: all.slice(0, max).map(e => ({ path: projectPath(l, e.path), type: entryType(e.mode, e.type), ...(e.size !== '-' ? { size: Number(e.size) } : {}), object: e.object })),
  }
}

async function worktreeTree(ctx: AccessContext, project: string, path: string, workspaceId: string | undefined, depth: number, max: number): Promise<TreeResult> {
  const w = await locateWorktree(ctx, project, path, workspaceId)
  const prov = worktreeProvenance(ctx, project, w, path || '.')
  if (w.uninitialized) throw new AccessError('uninitialized', `${w.uninitialized} is not checked out in workspace ${w.ws.reg.id}`, { provenance: prov })
  const mount = w.repoRoot === w.root ? '' : w.repoRoot.slice(w.root.length + 1)
  // Files Git tracks or would track (not ignored), as the working tree has them.
  const r = await git(w.repoRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', w.inner || '.'], { timeoutMs: 60_000 })
  const base = w.inner ? w.inner.split('/').length : 0
  const seen = new Map<string, TreeEntry>()
  for (const f of r.stdout.split('\0').filter(Boolean)) {
    const parts = f.split('/')
    for (let i = base + 1; i <= Math.min(parts.length, base + depth); i++) {
      const rel = parts.slice(0, i).join('/')
      if (seen.has(rel)) continue
      const abs = join(w.repoRoot, rel)
      const st = await lstat(abs).catch(() => null)
      if (!st) continue
      seen.set(rel, { path: join2(mount, rel), type: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? (await exists(join(abs, '.git')) ? 'submodule' : 'dir') : 'file', ...(st.isFile() ? { size: st.size } : {}) })
    }
  }
  const all = [...seen.values()].sort((a, b) => a.path.localeCompare(b.path))
  return { provenance: prov, entries: all.slice(0, max), truncated: all.length > max, total: all.length }
}

export interface ReadResult {
  provenance: Provenance
  size: number
  sha256: string
  binary: boolean
  text?: string // absent for binary content
  truncated: boolean
  bytes?: Buffer // the whole content, for callers that save it (never serialized)
}

function textOf(buf: Buffer): string | null {
  if (buf.subarray(0, 8000).includes(0)) return null
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { return null }
}

function bounded(buf: Buffer, maxBytes: number): Pick<ReadResult, 'size' | 'sha256' | 'binary' | 'text' | 'truncated'> {
  const text = textOf(buf)
  if (text === null) return { size: buf.length, sha256: sha256(buf), binary: true, truncated: false }
  if (buf.length <= maxBytes) return { size: buf.length, sha256: sha256(buf), binary: false, text, truncated: false }
  let cut = maxBytes
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut-- // never split a character
  return { size: buf.length, sha256: sha256(buf), binary: false, text: buf.subarray(0, cut).toString('utf8'), truncated: true }
}

export async function read(ctx: AccessContext, target: string, path: string, opts: ReadOptions & { maxBytes?: number } = {}): Promise<ReadResult> {
  const maxBytes = Math.min(opts.maxBytes ?? LIMITS.read.default, LIMITS.read.max)
  if (opts.source === 'worktree') {
    const w = await locateWorktree(ctx, target, path, opts.workspace)
    const prov = worktreeProvenance(ctx, target, w, path)
    if (w.uninitialized) throw new AccessError('uninitialized', `${w.uninitialized} is not checked out in workspace ${w.ws.reg.id}`, { provenance: prov })
    if (!w.inner) throw new RequestError(400, `${path} is a repository; list it with tree`)
    if (await ignored(w.repoRoot, w.inner)) throw new AccessError('inaccessible', `${path} is ignored by Git in workspace ${w.ws.reg.id}; ignored files are not project content`, { provenance: prov })
    const abs = await inside(w.repoRoot, w.inner)
    const st = await lstat(abs).catch(() => null)
    if (!st) throw new AccessError('absent', `${path} does not exist in workspace ${w.ws.reg.id}`, { provenance: prov })
    if (!st.isFile()) throw new RequestError(400, `${path} is not a regular file${st.isDirectory() ? '; list it with tree' : ''}`)
    const buf = await readFile(abs)
    return { provenance: prov, ...bounded(buf, maxBytes), bytes: buf }
  }
  const l = await locate(ctx, target, path, opts)
  const prov = provenance(ctx, l, projectPath(l, l.inner))
  if (!l.inner) throw new RequestError(400, `${prov.path} is a repository; list it with tree`)
  const t = await git(l.dir, ['cat-file', '-t', `${l.commit}:${l.inner}`])
  if (t.code !== 0) throw new AccessError('absent', `${prov.path} does not exist in ${l.repository.fullName}@${l.commit.slice(0, 10)}`, { provenance: prov })
  if (t.stdout.trim() !== 'blob') throw new RequestError(400, `${prov.path} is a ${t.stdout.trim() === 'tree' ? 'directory; list it with tree' : t.stdout.trim()}`)
  const b = await gitBytes(l.dir, ['cat-file', 'blob', `${l.commit}:${l.inner}`])
  if (b.code !== 0) throw new AccessError('absent', `${prov.path} cannot be read: ${b.stderr.trim()}`, { provenance: prov })
  return { provenance: prov, ...bounded(b.stdout, maxBytes), bytes: b.stdout }
}

export interface SearchMatch { path: string; line: number; text: string }
export interface SearchResult { provenance: Provenance; pattern: string; matches: SearchMatch[]; total: number; truncated: boolean; notSearched: string[] }

export async function search(ctx: AccessContext, target: string, pattern: string, path: string, opts: ReadOptions & { max?: number; regex?: boolean; ignoreCase?: boolean } = {}): Promise<SearchResult> {
  if (!pattern) throw new RequestError(400, 'a search pattern is required')
  const max = Math.min(opts.max ?? LIMITS.search.default, LIMITS.search.max)
  const flags = ['-n', '-I', '--no-color', '--full-name', ...(opts.ignoreCase ? ['-i'] : []), opts.regex ? '-E' : '-F', '-e', pattern]
  let prov: Provenance, out: string, strip: (s: string) => string, mount: string, notSearched: string[]
  if (opts.source === 'worktree') {
    const w = await locateWorktree(ctx, target, path, opts.workspace)
    prov = worktreeProvenance(ctx, target, w, path || '.')
    if (w.uninitialized) throw new AccessError('uninitialized', `${w.uninitialized} is not checked out in workspace ${w.ws.reg.id}`, { provenance: prov })
    if (!(await exists(await inside(w.repoRoot, w.inner || '.')))) throw new AccessError('absent', `${path} does not exist in workspace ${w.ws.reg.id}`, { provenance: prov })
    const r = await git(w.repoRoot, ['grep', ...flags, '--', w.inner || '.'], { timeoutMs: 60_000 })
    if (r.code > 1) throw new RequestError(400, `search failed: ${r.stderr.trim()}`)
    out = r.stdout; strip = s => s; mount = w.repoRoot === w.root ? '' : w.repoRoot.slice(w.root.length + 1)
    notSearched = (await new Workspace(w.ws.reg).submodulePaths()).map(s => s.path).filter(sp => w.repoRoot === w.root && (!w.inner || sp === w.inner || sp.startsWith(`${w.inner}/`)))
  } else {
    const l = await locate(ctx, target, path, opts)
    prov = provenance(ctx, l, projectPath(l, l.inner))
    if (l.inner && (await git(l.dir, ['cat-file', '-e', `${l.commit}:${l.inner}`])).code !== 0) throw new AccessError('absent', `${prov.path} does not exist in ${l.repository.fullName}@${l.commit.slice(0, 10)}`, { provenance: prov })
    const r = await git(l.dir, ['grep', ...flags, l.commit, '--', ...(l.inner ? [l.inner] : [])], { timeoutMs: 60_000 })
    if (r.code > 1) throw new RequestError(400, `search failed: ${r.stderr.trim()}`)
    out = r.stdout; strip = s => s.slice(l.commit.length + 1); mount = l.repository.path === '.' ? '' : l.repository.path
    const links = parseLsTree((await git(l.dir, ['ls-tree', '-r', '-z', l.commit, ...(l.inner ? ['--', l.inner] : [])])).stdout).filter(e => e.type === 'commit')
    notSearched = links.map(e => join2(mount, e.path))
  }
  const lines = out.split('\n').filter(Boolean)
  const matches: SearchMatch[] = []
  for (const raw of lines.slice(0, max)) {
    const s = strip(raw)
    const m = /^(.*?):(\d+):(.*)$/s.exec(s)
    if (m) matches.push({ path: join2(mount, m[1]), line: Number(m[2]), text: m[3].length > 400 ? `${m[3].slice(0, 400)}…` : m[3] })
  }
  return { provenance: prov, pattern, matches, total: lines.length, truncated: lines.length > max, notSearched }
}

// The committed text of one file of a project at its default branch, as an
// execution host reads a guide of another project (contract.md, *Execution*).
export async function committedText(ctx: AccessContext, project: string, path: string): Promise<{ text: string; sha256: string; commit: string; repository: string }> {
  const r = await read(ctx, project, path, { maxBytes: LIMITS.read.max })
  if (r.binary || r.text === undefined) throw new RequestError(409, `${project}:${path} is not text`)
  if (r.truncated) throw new RequestError(409, `${project}:${path} is larger than ${LIMITS.read.max} bytes`)
  if (r.provenance.fetch?.state === 'stale') throw new AccessError('fetch-failed', `${project}:${path} could not be refreshed from Gitea (${r.provenance.fetch.error}); its cache dates from ${r.provenance.fetch.at}`)
  return { text: r.text, sha256: r.sha256, commit: r.provenance.revision.commit, repository: r.provenance.repository.fullName }
}

// ---- structure ----------------------------------------------------------------------

export interface WorkflowView {
  file: string
  id?: string
  name?: string
  intent?: string
  documentation?: string
  repositories?: Record<string, { path: string; access: string; integrate?: string }>
  nodes?: { id: string; type: string; name?: string; delegate?: { project?: string; workflow?: string } }[]
  execution?: Workflow['execution']
  intake?: boolean
  problem?: string
}
export interface SubmoduleView {
  path: string
  category: RepoCategory
  url: string
  repository?: { key: string | null; fullName: string; registered: boolean; defaultBranch: string }
  pinned?: string
  upstream?: { commit: string; branch: string; relation: 'same' | 'behind' | 'ahead' | 'diverged'; behind: number; ahead: number; fetch: FetchInfo }
  state?: FailureState
  problem?: string
}
export interface WorkspaceView { id: string; host: string; available: boolean; reason?: string; head?: string; branch?: string | null; atCommitted?: boolean }
export interface ProjectView {
  provenance: Provenance
  project?: Project
  problem?: string
  devdocs: { declared?: string; observed: 'directory' | 'submodule' | 'missing' }
  areas: { path: string; description: string; category: RepoCategory; present: boolean }[]
  submodules: SubmoduleView[]
  workflows: WorkflowView[]
  workflowsProblem?: string
  workspaces: WorkspaceView[]
}

function workflowView(file: string, text: string): WorkflowView {
  const p = parseWorkflow(text)
  if (!p.ok) return { file, problem: p.problem.message }
  const w = p.model
  return {
    file, id: w.id, name: w.name, intent: w.intent, documentation: w.documentation.policy,
    repositories: Object.fromEntries(Object.entries(w.repositories).map(([k, b]) => [k, { path: b.path, access: b.access, ...(b.integrate ? { integrate: b.integrate } : {}) }])),
    nodes: Object.entries(w.nodes).map(([id, n]) => ({ id, type: n.type, ...(n.name ? { name: n.name } : {}), ...(n.type === 'delegate' ? { delegate: { project: n.project, workflow: n.workflow } } : {}) })),
    execution: w.execution, intake: w.intake.zulip === 'requests',
  }
}

async function workspacesOf(ctx: AccessContext, project: string, committed?: string): Promise<WorkspaceView[]> {
  const reg = await loadRegistry(ctx.registryFile)
  const boundary = await loadBoundary(ctx.registryFile, ctx.area)
  return Promise.all(reg.workspaces.filter(w => w.project === project).map(async w => {
    try { await assertWorkspaceAllowed(boundary, w, 'Listing') } catch (e) { return { id: w.id, host: w.host, available: false, reason: `refused: ${(e as Error).message}` } }
    const o = await observe(w)
    return { id: w.id, host: w.host, available: o.available, ...(o.reason ? { reason: o.reason } : {}), ...(o.head ? { head: o.head } : {}), branch: o.branch ?? null, ...(committed && o.head ? { atCommitted: o.head === committed } : {}) }
  }))
}

async function relation(dir: string, pinned: string, tip: string): Promise<{ relation: 'same' | 'behind' | 'ahead' | 'diverged'; behind: number; ahead: number }> {
  if (pinned === tip) return { relation: 'same', behind: 0, ahead: 0 }
  const c = await git(dir, ['rev-list', '--left-right', '--count', `${pinned}...${tip}`])
  const [ahead, behind] = c.stdout.trim().split(/\s+/).map(Number)
  return { relation: ahead && behind ? 'diverged' : behind ? 'behind' : 'ahead', behind: behind || 0, ahead: ahead || 0 }
}

export async function show(ctx: AccessContext, target: string, opts: ReadOptions = {}): Promise<ProjectView> {
  if (opts.source === 'worktree') throw new RequestError(400, 'show reads the committed project; read single files with --source worktree')
  const l = await locate(ctx, target, '.', opts)
  const prov = provenance(ctx, l, '.')
  const text = await git(l.dir, ['show', `${l.commit}:project.yaml`])
  const parsed = text.code === 0 ? parseProject(text.stdout) : null
  const view: ProjectView = {
    provenance: prov, ...(parsed?.ok ? { project: parsed.model } : { problem: text.code !== 0 ? 'no project.yaml at this revision' : parsed && !parsed.ok ? `project.yaml: ${parsed.problem.message}` : 'unreadable' }),
    devdocs: { observed: 'missing' }, areas: [], submodules: [], workflows: [], workspaces: target.includes(':') ? [] : await workspacesOf(ctx, target, l.repository.path === '.' ? l.commit : undefined),
  }
  if (parsed?.ok) view.devdocs.declared = parsed.model.devdocs
  const mods = await git(l.dir, ['show', `${l.commit}:.gitmodules`])
  const subs = mods.code === 0 ? gitmodules(mods.stdout).map(m => ({ ...m, path: normalizeRepoPath(m.path) ?? m.path })) : []
  const top = parseLsTree((await git(l.dir, ['ls-tree', '-z', l.commit, '--', 'devdocs'])).stdout)[0]
  view.devdocs.observed = !top ? 'missing' : top.type === 'commit' ? 'submodule' : 'directory'
  for (const a of parsed?.ok ? parsed.model.areas ?? [] : []) {
    const t = await git(l.dir, ['cat-file', '-t', `${l.commit}:${normalizeRepoPath(a.path) ?? a.path}`])
    view.areas.push({ path: a.path, description: a.description, category: categoryOf(a.path), present: t.code === 0 && t.stdout.trim() === 'tree' })
  }
  view.submodules = await Promise.all(subs.map(async (sm): Promise<SubmoduleView> => {
    const v: SubmoduleView = { path: sm.path, category: categoryOf(sm.path), url: sm.url }
    try {
      const pinned = /^160000 commit ([0-9a-f]+)\t/.exec((await git(l.dir, ['ls-tree', l.commit, '--', sm.path])).stdout)?.[1]
      if (pinned) v.pinned = pinned
      const sub = await locate(ctx, target, sm.path, { rev: opts.rev, upstream: true })
      v.repository = { key: sub.repository.key, fullName: sub.repository.fullName, registered: sub.repository.registered, defaultBranch: sub.repository.defaultBranch }
      if (pinned) {
        const has = await commitOf(sub.dir, pinned)
        v.upstream = { commit: sub.commit, branch: sub.repository.defaultBranch, ...(has ? await relation(sub.dir, pinned, sub.commit) : { relation: 'diverged' as const, behind: 0, ahead: 0 }), fetch: sub.fetch }
        if (!has) { v.state = 'absent'; v.problem = `the pinned commit ${pinned.slice(0, 10)} is on no branch of ${sub.repository.fullName}` }
      } else { v.state = 'absent'; v.problem = 'no gitlink at this revision' }
    } catch (e) {
      v.state = e instanceof AccessError ? e.state : 'fetch-failed'
      v.problem = (e as Error).message
    }
    return v
  }))
  // Workflows, wherever devdocs is stored.
  try {
    const wl = await locate(ctx, target, 'devdocs/workflows', { rev: opts.rev })
    const t = await git(wl.dir, ['cat-file', '-t', `${wl.commit}:${wl.inner}`])
    if (t.code !== 0) view.workflowsProblem = 'devdocs/workflows does not exist at this revision'
    else {
      const files = parseLsTree((await git(wl.dir, ['ls-tree', '-z', wl.commit, '--', `${wl.inner}/`])).stdout).filter(e => e.type === 'blob' && /\.ya?ml$/.test(e.path))
      view.workflows = await Promise.all(files.map(async f => workflowView(f.path.split('/').pop()!, (await git(wl.dir, ['cat-file', 'blob', f.object])).stdout)))
    }
  } catch (e) { view.workflowsProblem = (e as Error).message }
  return view
}

export interface ProjectListItem {
  id: string
  root: { key: string; fullName: string }
  name?: string
  intent?: string
  devdocs?: string
  commit?: string
  branch?: string
  fetch?: FetchInfo
  workspaces: WorkspaceView[]
  uses: { path: string; repository: string | null }[]
  state?: FailureState
  problem?: string
}
export interface ProjectList {
  schema: typeof ACCESS_SCHEMA
  observed: string
  gitea: { available: boolean; url?: string; problem?: string }
  projects: ProjectListItem[]
  repositories: { key: string; fullName: string; category: RepoCategory; description: string; usedBy: { project: string; path: string }[] }[]
}

export async function list(ctx: AccessContext): Promise<ProjectList> {
  const reg = await loadRegistry(ctx.registryFile)
  const out: ProjectList = { schema: ACCESS_SCHEMA, observed: now(ctx), gitea: ctx.gitea ? { available: true, url: ctx.gitea.url } : { available: false, problem: ctx.giteaProblem ?? 'no Gitea setting' }, projects: [], repositories: [] }
  const usedBy = new Map<string, { project: string; path: string }[]>()
  out.projects = await Promise.all(reg.projects.map(async (p): Promise<ProjectListItem> => {
    const entry = reg.repositories.find(r => r.key === p.root)!
    const item: ProjectListItem = { id: p.id, root: { key: p.root, fullName: `${entry.gitea.owner}/${entry.gitea.name}` }, workspaces: [], uses: [] }
    try {
      const l = await locate(ctx, p.id, '.')
      item.root.fullName = l.repository.fullName; item.commit = l.commit; item.branch = l.repository.defaultBranch; item.fetch = l.fetch
      const y = await git(l.dir, ['show', `${l.commit}:project.yaml`])
      const parsed = y.code === 0 ? parseProject(y.stdout) : null
      if (parsed?.ok) { item.name = parsed.model.name; item.intent = parsed.model.intent; item.devdocs = parsed.model.devdocs } else item.problem = y.code !== 0 ? 'no project.yaml' : `project.yaml: ${parsed && !parsed.ok ? parsed.problem.message : 'unreadable'}`
      const mods = await git(l.dir, ['show', `${l.commit}:.gitmodules`])
      const [owner, name] = l.repository.fullName.split('/')
      for (const m of mods.code === 0 ? gitmodules(mods.stdout) : []) {
        const at = repoOfUrl(m.url, { giteaUrl: host(ctx).url, owner, name })
        const hit = at && reg.repositories.find(r => r.gitea.owner === at.owner && r.gitea.name === at.name)
        const path = normalizeRepoPath(m.path) ?? m.path
        item.uses.push({ path, repository: at ? `${at.owner}/${at.name}` : null })
        if (hit) usedBy.set(hit.key, [...(usedBy.get(hit.key) ?? []), { project: p.id, path }])
      }
    } catch (e) {
      item.state = e instanceof AccessError ? e.state : 'fetch-failed'
      item.problem = (e as Error).message
    }
    item.workspaces = await workspacesOf(ctx, p.id, item.commit)
    return item
  }))
  out.repositories = reg.repositories.filter(r => r.category !== 'root').map(r => ({ key: r.key, fullName: `${r.gitea.owner}/${r.gitea.name}`, category: r.category, description: r.description, usedBy: usedBy.get(r.key) ?? [] }))
  return out
}

// ---- execution ----------------------------------------------------------------------

export interface RunListItem {
  ref: string
  live?: RunSummary & { place: 'run-copy' | 'project'; workspace: string }
  published?: RunSummary & { commit: string; integrated: boolean }
}
export interface RunList {
  provenance?: Provenance // present only when the committed source was read
  publishedUnavailable?: { state: FailureState; message: string }
  runs: RunListItem[]
  live: { workspace: string } | { unavailable: string }
}

// A run folder in committed content, as the run reader expects its source.
function committedSource(l: Located, runInner: string): Source {
  return {
    async text(rel) { const r = await git(l.dir, ['show', `${l.commit}:${runInner}/${rel}`]); return r.code === 0 ? r.stdout : null },
    async list() {
      return parseLsTree((await git(l.dir, ['ls-tree', '-l', '-z', l.commit, '--', `${runInner}/`])).stdout).filter(e => e.type === 'blob').map(e => ({ name: e.path.split('/').pop()!, size: Number(e.size) || 0, modified: '' }))
    },
  }
}

async function publishedRuns(ctx: AccessContext, project: string, workflow: string | undefined, opts: ReadOptions): Promise<{ l: Located; refs: RunRef[] }> {
  const l = await locate(ctx, project, RUNS_ROOT, { rev: opts.rev })
  const t = await git(l.dir, ['cat-file', '-t', `${l.commit}:${l.inner}`])
  if (t.code !== 0) return { l, refs: [] }
  const entries = parseLsTree((await git(l.dir, ['ls-tree', '-r', '-t', '-z', l.commit, '--', `${l.inner}/`])).stdout)
  const refs: RunRef[] = []
  for (const e of entries) {
    const rel = e.path.slice(l.inner.length + 1).split('/')
    if (e.type === 'tree' && rel.length === 2 && ID_PATTERN.test(rel[0]) && RUN_ID.test(rel[1]) && (!workflow || rel[0] === workflow)) refs.push({ workflow: rel[0], run: rel[1] })
  }
  return { l, refs: refs.slice(0, LIMITS.runs) }
}

async function readPublished(l: Located, project: string, ref: RunRef) {
  const inner = `${l.inner}/${ref.workflow}/${ref.run}`
  const src = committedSource(l, inner)
  return { src, reading: await readFrom(src, { ...ref, project }) }
}

async function liveWorkspace(ctx: AccessContext, project: string, id?: string): Promise<Workspace | string> {
  try { return new Workspace(await projectWorkspace(ctx, project, id)) } catch (e) { return (e as Error).message }
}

export async function runs(ctx: AccessContext, project: string, opts: ReadOptions & { workflow?: string; published?: boolean } = {}): Promise<RunList> {
  if (project.includes(':')) throw new RequestError(400, 'runs belong to projects; a repository has none')
  // Validate identity and the operating boundary even when only live reads
  // are possible. Published-source failures must not hide this host's runs.
  await start(ctx, project)
  const byRef = new Map<string, RunListItem>()
  let prov: Provenance | undefined
  let publishedError: AccessError | undefined
  try {
    const { l, refs } = await publishedRuns(ctx, project, opts.workflow, opts)
    prov = provenance(ctx, l, RUNS_ROOT)
    for (const ref of refs) {
      const { reading } = await readPublished(l, project, ref)
      const s = summaryOf(ref, reading)
      byRef.set(runKey(ref), { ref: runKey(ref), published: { ...s, commit: l.commit, integrated: !!reading.record?.integrations?.length } })
    }
  } catch (e) {
    if (!(e instanceof AccessError) || opts.published) throw e
    publishedError = e
  }
  let live: RunList['live'] = { unavailable: 'not asked (--published)' }
  if (!opts.published) {
    const ws = await liveWorkspace(ctx, project, opts.workspace)
    if (typeof ws === 'string') live = { unavailable: ws }
    else {
      live = { workspace: ws.reg.id }
      for (const s of await listRuns(ws, opts.workflow)) {
        const place = await runSpace(ws, { workflow: s.workflow, run: s.run }).then(x => (x.copyOf ? 'run-copy' as const : 'project' as const), () => 'run-copy' as const)
        const item = byRef.get(s.ref) ?? { ref: s.ref }
        item.live = { ...s, place, workspace: ws.reg.id }
        byRef.set(s.ref, item)
      }
    }
  }
  if (publishedError && !('workspace' in live)) throw publishedError
  return {
    ...(prov ? { provenance: prov } : {}),
    ...(publishedError ? { publishedUnavailable: { state: publishedError.state, message: publishedError.message } } : {}),
    runs: [...byRef.values()].sort((a, b) => a.ref.localeCompare(b.ref)), live,
  }
}

export interface RunView {
  ref: string
  live?: { workspace: string; place: 'run-copy' | 'project'; branch?: string | null; record?: unknown; problem?: unknown; files: string[]; observed: string }
  liveUnavailable?: string
  published?: { provenance: Provenance; record?: unknown; problem?: unknown; files: string[] }
  publishedUnavailable?: string
}

async function walk(dir: string, base = '', max = LIMITS.tree.default): Promise<string[]> {
  const out: string[] = []
  const go = async (d: string, rel: string) => {
    for (const e of (await readdir(d, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= max || e.name.startsWith('.')) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await go(join(d, e.name), r)
      else if (e.isFile()) out.push(r)
    }
  }
  await go(dir, base)
  return out
}

export async function run(ctx: AccessContext, project: string, text: string, opts: ReadOptions & { published?: boolean } = {}): Promise<RunView> {
  const ref = parseRef(text)
  const view: RunView = { ref: runKey(ref) }
  try {
    const l = await locate(ctx, project, `${RUNS_ROOT}/${ref.workflow}/${ref.run}`, { rev: opts.rev })
    const t = await git(l.dir, ['cat-file', '-t', `${l.commit}:${l.inner}`])
    if (t.code !== 0) view.publishedUnavailable = `${runKey(ref)} is not in ${l.repository.fullName}@${l.commit.slice(0, 10)}`
    else {
      const runs = await locate(ctx, project, RUNS_ROOT, { rev: opts.rev })
      const { reading } = await readPublished(runs, project, ref)
      const files = parseLsTree((await git(l.dir, ['ls-tree', '-r', '-z', l.commit, '--', `${l.inner}/`])).stdout).map(e => e.path.slice(l.inner.length + 1))
      view.published = { provenance: provenance(ctx, l, `${RUNS_ROOT}/${runKey(ref)}`), ...(reading.record ? { record: reading.record } : {}), ...(reading.problem ? { problem: reading.problem } : {}), files }
    }
  } catch (e) { view.publishedUnavailable = (e as Error).message }
  if (!opts.published) {
    const ws = await liveWorkspace(ctx, project, opts.workspace)
    if (typeof ws === 'string') view.liveUnavailable = ws
    else {
      try {
        const space = await runSpace(ws, ref)
        const r = await readRun(ws, ref)
        if (r.problem?.code === 'missing' && !(await exists(r.dir))) view.liveUnavailable = `${runKey(ref)} does not exist in workspace ${ws.reg.id}`
        else view.live = { workspace: ws.reg.id, place: space.copyOf ? 'run-copy' : 'project', branch: r.record?.storage?.branch ?? null, ...(r.record ? { record: r.record } : {}), ...(r.problem ? { problem: r.problem } : {}), files: await walk(r.dir), observed: now(ctx) }
      } catch (e) { view.liveUnavailable = (e as Error).message }
    }
  }
  if (!view.live && !view.published) throw new AccessError('absent', `${runKey(ref)} of ${project} is neither on this host (${view.liveUnavailable}) nor published (${view.publishedUnavailable})`)
  return view
}

// A file of one run's folder: its live copy here (default), or as published.
export async function runFile(ctx: AccessContext, project: string, text: string, path: string, opts: ReadOptions & { published?: boolean; maxBytes?: number } = {}): Promise<ReadResult> {
  const ref = parseRef(text)
  // A path given from the project root (devdocs/runs/<wf>/<run>/…) names the
  // same file: links written that way open too (p15: forge provide/run-010's
  // result linked its deliverables so, and they answered 404).
  const own = `${RUNS_ROOT}/${ref.workflow}/${ref.run}/`
  const given = normalizeRepoPath(path)
  const rel = given?.startsWith(own) ? given.slice(own.length) : given
  if (!rel || rel === '.') throw new RequestError(400, `"${path}" is not a path inside the run folder`)
  if (opts.published) return read(ctx, project, `${RUNS_ROOT}/${ref.workflow}/${ref.run}/${rel}`, opts)
  const ws = await liveWorkspace(ctx, project, opts.workspace)
  if (typeof ws === 'string') throw new AccessError('absent', `no live record here: ${ws}; read the published one with --published`)
  const r = await readRun(ws, ref)
  const space = await runSpace(ws, ref)
  const abs = await inside(r.dir, rel)
  const st = await lstat(abs).catch(() => null)
  const prov: Provenance = {
    schema: ACCESS_SCHEMA, project, source: 'live',
    repository: { key: null, fullName: space.copyOf ? 'run copy' : 'project workspace', path: '.', category: 'root', registered: false, defaultBranch: '' },
    revision: { selector: 'worktree', commit: (await git(space.root, ['rev-parse', 'HEAD'])).stdout.trim(), ...(r.record?.storage?.branch ? { ref: r.record.storage.branch } : {}) },
    path: `${RUNS_ROOT}/${runKey(ref)}/${rel}`, observed: now(ctx), workspace: { id: ws.reg.id, dirty: true },
  }
  if (!st?.isFile()) throw new AccessError('absent', `${rel} is not a file of ${runKey(ref)}${st ? '' : ' (no such file)'}`, { provenance: prov })
  const buf = await readFile(abs)
  return { provenance: prov, ...bounded(buf, Math.min(opts.maxBytes ?? LIMITS.read.default, LIMITS.read.max)), bytes: buf }
}

function parseRef(text: string): RunRef {
  const parts = text.replace(/^(devdocs\/)?runs\//, '').replace(/\/$/, '').split('/')
  if (parts.length !== 2 || !ID_PATTERN.test(parts[0]) || !RUN_ID.test(parts[1])) throw new RequestError(400, `"${text}" is not a run reference; use <workflow>/<run>`)
  return { workflow: parts[0], run: parts[1] }
}

// JSON output never carries the raw bytes.
export function serializable<T extends { bytes?: Buffer }>(r: T): Omit<T, 'bytes'> {
  const { bytes: _bytes, ...rest } = r
  return rest
}
