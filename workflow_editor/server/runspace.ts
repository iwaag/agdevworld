// Where a run lives (p9, docs/storage.md): every run the execution host
// performs has its own working copy of the project — the root and its
// initialized submodules, each on the run's own branch — so a held run
// keeps its plan, records and unfinished work while other runs of the same
// project go on, and nothing a run saves reaches a shared branch until it
// is integrated.
//
// Host-local facts only. The copy of run <wf>/<run> of a workspace is
//
//   <workspace>/.local/wfe/runs/<wf>/<run>/copy.json   the manifest
//   <workspace>/.local/wfe/runs/<wf>/<run>/tree/       the working copy
//
// and the set of these folders is the index: one manifest per run, no
// second database to drift from it. The manifest says what the copy was
// made from (base commits, integration targets) and which branches it owns;
// it never leaves the host. What the run itself records about its storage
// (`storage` in run.json) is portable: branch names, base commits and
// targets, no paths.
//
// Allocation holds the workspace's allocation lock: a run number is
// reserved by creating its folder and manifest under that lock, after
// looking at the runs recorded in the project tree, the existing copies and
// the run branches Git knows. Creating the copy is idempotent: an
// interrupted creation is finished by the next call for the same run (or
// the same request receipt), never started over under another number.
// Reading never creates or repairs: a missing or damaged copy is a problem
// that names the run.
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ID_PATTERN } from '../shared/model.ts'
import { RUN_ID, RUNS_ROOT, runFolder, runKey, type RunRef, type RunStorage } from '../shared/run.ts'
import { atomicWrite, readTextOrNull } from './files.ts'
import { git, gitOk, LOCAL_TRANSPORT } from './git.ts'
import { withLock } from './lock.ts'
import { RequestError, Workspace } from './workspace.ts'

export const COPY_SCHEMA = 'ag.wfe-run-copy.v1'
export const COPIES_DIR = '.local/wfe/runs' // under the project workspace
const MANIFEST = 'copy.json'
const TREE = 'tree'
const LOCAL_FILE_MAX = 1024 * 1024

// A run's branch in every repository it owns. The project id keeps runs of
// different projects apart in a repository they share (a study, a wedo).
export const runBranch = (project: string, ref: RunRef) => `wfe/${project}/${ref.workflow}/${ref.run}`
const BRANCH = /^wfe\/([a-z0-9][a-z0-9_.-]{0,63})\/([a-z0-9][a-z0-9_.-]{0,63})\/(run-[a-z0-9][a-z0-9_.-]{0,59})$/

export interface CopyRepo {
  path: string // project-relative ('.' the root)
  kind: 'root' | 'submodule'
  initialized: boolean // a submodule the project workspace has not checked out stays so here
  base: string | null // the commit the run started from (a submodule: the root base's gitlink)
  branch: string | null // the run's branch (null until the copy is made, and for an uninitialized submodule)
  target: string | null // where integration goes: the branch the project workspace had checked out
  url: string | null // its remote (host-local; never written into run.json)
}
export interface CopyManifest {
  schema: string
  project: string
  workspace: string
  workflow: string
  run: string
  branch: string
  state: 'creating' | 'ready'
  created: string
  ready: string | null
  receipt: string | null // the request that reserved it: the same request finds it again
  baseFrom?: 'workspace' | 'upstream' // the workspace's HEAD, or its branch's upstream when the workspace was only behind it
  repositories: CopyRepo[]
  local: string[] // files of the project workspace's .local/ copied into the copy's .local/
  reconstructed?: string // when the manifest was rebuilt from the copy itself
}

export interface RunCopy { ref: RunRef; dir: string; tree: string; manifest: CopyManifest | null; problem: string | null }

const now = () => new Date().toISOString()
const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false

export function storageOf(m: CopyManifest): RunStorage {
  return { kind: 'run-copy', branch: m.branch, repositories: m.repositories.filter(r => r.initialized).map(r => ({ path: r.path, base: r.base, branch: r.branch, target: r.target })) }
}

// ---- reading the index ------------------------------------------------------------

const copiesRoot = (ws: Workspace) => join(ws.shared.root, COPIES_DIR)
export const copyDir = (ws: Workspace, ref: RunRef) => join(copiesRoot(ws), ref.workflow, ref.run)

function parseManifest(text: string, ref: RunRef): CopyManifest | string {
  let m: CopyManifest
  try { m = JSON.parse(text) } catch (e) { return `${MANIFEST} is not JSON (${(e as Error).message})` }
  if (!m || typeof m !== 'object' || m.schema !== COPY_SCHEMA) return `${MANIFEST} is not ${COPY_SCHEMA}`
  if (m.workflow !== ref.workflow || m.run !== ref.run) return `${MANIFEST} names ${m.workflow}/${m.run}, not ${runKey(ref)}`
  if (typeof m.project !== 'string' || typeof m.branch !== 'string' || !Array.isArray(m.repositories) || (m.state !== 'creating' && m.state !== 'ready')) return `${MANIFEST} is incomplete`
  return m
}

// The copy of one run, as it is now: null when the run has none.
export async function readCopy(ws: Workspace, ref: RunRef): Promise<RunCopy | null> {
  const dir = copyDir(ws, ref)
  if (!(await isDir(dir))) return null
  const tree = join(dir, TREE)
  const text = await readTextOrNull(join(dir, MANIFEST)).catch(e => { throw new RequestError(500, `${runKey(ref)}: ${MANIFEST} cannot be read: ${(e as Error).message}`) })
  const out: RunCopy = { ref, dir, tree, manifest: null, problem: null }
  if (text === null) { out.problem = `the run's working copy has no ${MANIFEST}${(await isDir(join(tree, '.git'))) ? ' (wfe runs index --rebuild reconstructs it from the copy)' : ''}`; return out }
  const m = parseManifest(text, ref)
  if (typeof m === 'string') { out.problem = `the run's working copy is damaged: ${m}`; return out }
  out.manifest = m
  if (m.state === 'creating') out.problem = 'the run\'s working copy is still being created (or its creation was interrupted; the same request finishes it)'
  else if (!(await isDir(join(tree, '.git')))) out.problem = `the run's working copy is missing (${COPIES_DIR}/${runKey(ref)}/${TREE} has no repository); its saved branch ${m.branch} is in the project's repositories`
  return out
}

// Every copy of this workspace, damaged ones included.
export async function listCopies(ws: Workspace, workflow?: string): Promise<RunCopy[]> {
  const root = copiesRoot(ws)
  const wfs = workflow ? [workflow] : (await readdir(root, { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory() && ID_PATTERN.test(d.name)).map(d => d.name).sort()
  const out: RunCopy[] = []
  for (const wf of wfs) {
    const runs = (await readdir(join(root, wf), { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory() && RUN_ID.test(d.name)).map(d => d.name).sort()
    for (const run of runs) { const c = await readCopy(ws, { workflow: wf, run }); if (c) out.push(c) }
  }
  return out
}

// The workspace a run's files are read and written in: its copy when it
// has one, else the project workspace (runs recorded before p9's migration
// that stay where they are, and runs created there by an IDE agent). A copy
// that cannot be used is refused with its problem, never replaced by the
// project tree's snapshot of the same run.
export async function runSpace(ws: Workspace, ref: RunRef): Promise<Workspace> {
  if (ws.copyOf) {
    if (ws.copyOf.ref.workflow === ref.workflow && ws.copyOf.ref.run === ref.run) return ws
    ws = ws.copyOf.shared
  }
  const c = await readCopy(ws, ref)
  if (!c) return ws
  if (c.problem || !c.manifest) throw new RequestError(409, `run ${runKey(ref)}: ${c.problem}`, { code: 'run-copy' })
  return copyWorkspace(ws, c)
}

export function copyWorkspace(ws: Workspace, c: RunCopy): Workspace {
  const shared = ws.shared
  return new Workspace({ ...shared.reg, path: c.tree }, { shared, ref: c.ref })
}

// ---- allocation ---------------------------------------------------------------------

// Run numbers already taken for a workflow: recorded in the project tree,
// held by a copy, or named by a run branch Git knows (local, or as last
// fetched from the remote).
export async function usedRuns(ws: Workspace, project: string, workflow: string): Promise<Set<string>> {
  const used = new Set<string>()
  for (const d of await readdir(join(ws.root, RUNS_ROOT, workflow), { withFileTypes: true }).catch(() => [])) if (d.isDirectory() && RUN_ID.test(d.name)) used.add(d.name)
  for (const d of await readdir(join(copiesRoot(ws), workflow), { withFileTypes: true }).catch(() => [])) if (d.isDirectory() && RUN_ID.test(d.name)) used.add(d.name)
  const refs = await git(ws.root, ['for-each-ref', '--format=%(refname)', `refs/heads/wfe/${project}/${workflow}/`, `refs/remotes/origin/wfe/${project}/${workflow}/`])
  for (const line of refs.stdout.split('\n')) { const m = /\/(run-[a-z0-9][a-z0-9_.-]*)$/.exec(line.trim()); if (m) used.add(m[1]) }
  return used
}

// Runs `f` holding the workspace's allocation lock (run numbers).
export async function allocating<T>(ws: Workspace, f: () => Promise<T>): Promise<T> {
  const root = copiesRoot(ws.shared)
  await mkdir(root, { recursive: true })
  return withLock(join(root, '.allocation'), f, { what: `run allocation in workspace ${ws.shared.reg.id}` })
}

// adopt (p9 migration): the named run is already recorded in the project
// tree and moves into a copy under the same id; only a copy or a run branch
// of that name refuses it.
export interface ReserveOptions { project: string; workflow: string; name?: string; receipt?: string; adopt?: boolean }

// Reserves a run identity and its copy folder. With a receipt, a second call
// for the same request returns the run it reserved (finished or not).
export async function reserve(ws: Workspace, o: ReserveOptions, env: Record<string, string> = {}): Promise<{ ref: RunRef; manifest: CopyManifest; existing: boolean }> {
  ws = ws.shared
  // What other runs integrated reaches the remote, not the person's
  // workspace: its branch's upstream is fetched first (best effort; offline,
  // the workspace's own HEAD is used).
  const branch = (await git(ws.root, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim()
  if (branch) await git(ws.root, ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { env, timeoutMs: 60_000 })
  if (!ID_PATTERN.test(o.project)) throw new RequestError(409, `project id "${o.project}" is invalid`)
  if (!ID_PATTERN.test(o.workflow)) throw new RequestError(400, `workflow id "${o.workflow}" is invalid`)
  if (o.name !== undefined && !RUN_ID.test(o.name)) throw new RequestError(400, `run id "${o.name}" must match ${RUN_ID.source}`)
  const root = copiesRoot(ws)
  return allocating(ws, async () => {
    if (o.receipt) {
      for (const c of await listCopies(ws)) if (c.manifest?.receipt === o.receipt) return { ref: c.ref, manifest: c.manifest, existing: true }
    }
    const used = await usedRuns(ws, o.project, o.workflow)
    let run = o.name
    if (o.adopt) {
      if (!run) throw new RequestError(400, 'adopting a run needs its name')
      const branch = await git(ws.root, ['for-each-ref', '--format=%(refname)', `refs/heads/${runBranch(o.project, { workflow: o.workflow, run })}`, `refs/remotes/origin/${runBranch(o.project, { workflow: o.workflow, run })}`])
      if (await isDir(copyDir(ws, { workflow: o.workflow, run })) || branch.stdout.trim()) throw new RequestError(409, `run ${o.workflow}/${run} already has a working copy or a run branch; nothing was changed`)
    } else if (run) { if (used.has(run)) throw new RequestError(409, `run ${o.workflow}/${run} already exists (a record, a working copy or a run branch); nothing was changed. Choose another name or omit it for the next number.`) }
    else {
      const nums = [...used].map(r => /^run-(\d+)$/.exec(r)?.[1]).filter((x): x is string => !!x).map(Number)
      run = `run-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')}`
    }
    const ref = { workflow: o.workflow, run }
    const { repositories, from } = await planRepositories(ws)
    const manifest: CopyManifest = { schema: COPY_SCHEMA, project: o.project, workspace: ws.reg.id, workflow: o.workflow, run, branch: runBranch(o.project, ref), state: 'creating', created: now(), ready: null, receipt: o.receipt ?? null, baseFrom: from, repositories, local: [] }
    const dir = copyDir(ws, ref)
    await mkdir(join(root, o.workflow), { recursive: true })
    await mkdir(dir) // exclusive: the reservation
    await atomicWrite(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
    return { ref, manifest, existing: false }
  })
}

// What the copy is made from: the project's committed state (never the
// workspace's uncommitted edits) — the workspace's HEAD, or its branch's
// upstream as last fetched when the workspace is only behind it (results
// integrated from other runs' copies reach the remote, not the workspace);
// each initialized submodule at the gitlink that commit records, and the
// branches they are integrated into later.
async function planRepositories(ws: Workspace): Promise<{ repositories: CopyRepo[]; from: 'workspace' | 'upstream' }> {
  const head = await git(ws.root, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (head.code !== 0) throw new RequestError(409, `workspace ${ws.reg.id} has no commit to start a run from; commit the project first`)
  let base = head.stdout.trim()
  const branch = (await git(ws.root, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim() || null
  let from: 'workspace' | 'upstream' = 'workspace'
  if (branch) {
    const up = (await git(ws.root, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${branch}^{commit}`])).stdout.trim()
    if (up && up !== base && (await git(ws.root, ['merge-base', '--is-ancestor', base, up])).code === 0) { base = up; from = 'upstream' }
  }
  const url = await remoteUrl(ws.root)
  const out: CopyRepo[] = [{ path: '.', kind: 'root', initialized: true, base, branch: null, target: branch, url }]
  await submodulesOf(ws.root, '', base, out)
  return { repositories: out, from }
}

// The submodules of one repository of the workspace (`prefix`: its
// project-relative path, '' the root) at the commit `base`, and theirs in
// turn: every repository the workspace has checked out, at any depth, is
// the run's (project_migration p6 ex1: a backend superproject whose own
// submodules carry the work and whose gitlinks are their pins).
async function submodulesOf(dir: string, prefix: string, base: string, out: CopyRepo[]) {
  const r = await git(dir, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'])
  if (r.code !== 0) return
  for (const line of r.stdout.split('\n')) {
    const m = /^submodule\.(.+)\.path (.*)$/.exec(line)
    if (!m) continue
    const rel = m[2].replace(/\/+$/, '')
    const tree = await git(dir, ['ls-tree', base, '--', rel])
    const link = /^160000 commit ([0-9a-f]+)\t/.exec(tree.stdout)?.[1] ?? null
    const sub = join(dir, rel)
    const initialized = await isRepoTop(sub) && !!link
    const path = prefix ? `${prefix}/${rel}` : rel
    out.push({ path, kind: 'submodule', initialized, base: link, branch: null, target: initialized ? await targetOf(sub) : null, url: initialized ? await remoteUrl(sub) : null })
    if (initialized) await submodulesOf(sub, path, link!, out)
  }
}

// The owned repository a project-relative path belongs to: the longest
// owned path that contains it ('.' the root).
export function ownerOf(path: string, owned: string[]): string {
  let best = '.'
  for (const o of owned) if (o !== '.' && path.startsWith(`${o}/`) && o.length > best.length) best = o
  return best
}

async function remoteUrl(dir: string): Promise<string | null> {
  const r = await git(dir, ['remote', 'get-url', 'origin'])
  return r.code === 0 ? r.stdout.trim() : null
}
async function isRepoTop(dir: string): Promise<boolean> {
  if (!(await stat(join(dir, '.git')).then(() => true, () => false))) return false
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  return top.code === 0 && top.stdout.trim() === await realpath(dir).catch(() => dir)
}
// The branch a repository's work is integrated into: the one checked out,
// or for a detached checkout its remote's default branch.
async function targetOf(dir: string): Promise<string> {
  const b = (await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim()
  if (b) return b
  return (await git(dir, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])).stdout.trim().replace(/^origin\//, '') || 'main'
}

// ---- creating the copy ----------------------------------------------------------------

// Makes (or finishes making) the copy a reservation describes. Every step
// checks what is already there, so a call after an interruption continues
// rather than starting over; a finished copy is returned unchanged.
export async function materialize(ws: Workspace, ref: RunRef, env: Record<string, string> = {}): Promise<RunCopy> {
  ws = ws.shared
  const dir = copyDir(ws, ref)
  return withLock(join(dir, MANIFEST), async () => {
    const c = await readCopy(ws, ref)
    if (!c?.manifest) throw new RequestError(409, `run ${runKey(ref)}: ${c?.problem ?? 'no reservation'}`)
    const m = c.manifest
    if (m.state === 'ready') return c
    const tree = c.tree
    const root = m.repositories.find(r => r.path === '.')!
    if (!(await isDir(join(tree, '.git')))) {
      await rm(tree, { recursive: true, force: true }) // a clone that did not finish
      await gitOk(dir, ['clone', '-q', '--no-checkout', '--', ws.root, TREE], { timeoutMs: 600_000 })
    }
    // Remotes: the project's own, not the workspace it was cloned from.
    if ((await remoteUrl(tree)) !== root.url) {
      await git(tree, ['remote', 'remove', 'origin'])
      if (root.url) await gitOk(tree, ['remote', 'add', 'origin', root.url])
    }
    await ownBranch(tree, m.branch, root.base!)
    root.branch = m.branch
    await exclude(tree, '/.local/')
    // Parents before their own submodules, each on the run branch at its base.
    const subs = m.repositories.filter(r => r.kind === 'submodule' && r.initialized)
    const depth = (p: string) => p.split('/').length
    for (const sub of [...subs].sort((a, b) => depth(a.path) - depth(b.path))) {
      const parent = ownerOf(sub.path, subs.map(s => s.path))
      const rel = parent === '.' ? sub.path : sub.path.slice(parent.length + 1)
      await submodule(join(ws.root, parent), join(tree, parent), rel, sub.url, env)
      await ownBranch(join(tree, sub.path), m.branch, sub.base!)
      sub.branch = m.branch
    }
    m.local = await localFiles(ws.root, tree)
    m.state = 'ready'
    m.ready = now()
    await atomicWrite(join(dir, MANIFEST), `${JSON.stringify(m, null, 2)}\n`)
    return { ...c, manifest: m, problem: null }
  }, { what: `the working copy of run ${runKey(ref)}`, timeoutMs: 600_000 })
}

// The run's branch, checked out at its base. An existing branch is kept as
// it is (its commits are the run's saved work).
async function ownBranch(dir: string, branch: string, base: string) {
  const has = (await git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])).code === 0
  const current = (await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim()
  if (current === branch) return
  await gitOk(dir, has ? ['checkout', '-q', branch] : ['checkout', '-q', '-b', branch, base])
}

async function exclude(dir: string, pattern: string) {
  const file = (await gitOk(dir, ['rev-parse', '--git-path', 'info/exclude'])).trim()
  const abs = file.startsWith('/') ? file : join(dir, file)
  const text = (await readTextOrNull(abs)) ?? ''
  if (text.split('\n').includes(pattern)) return
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${pattern}\n`)
}

// One submodule of the copy, cloned from the project workspace's checkout
// (local, with its unpublished commits) and then pointed at its own remote;
// when the workspace lacks the recorded commit, from that remote.
async function submodule(sharedRoot: string, tree: string, path: string, url: string | null, env: Record<string, string>) {
  const dir = join(tree, path)
  const name = await submoduleName(tree, path)
  if (!(await isRepoTop(dir))) {
    await gitOk(tree, ['submodule', 'init', '--', path])
    await gitOk(tree, ['config', `submodule.${name}.url`, join(sharedRoot, path)])
    let r = await git(tree, ['submodule', 'update', '--', path], { config: LOCAL_TRANSPORT, timeoutMs: 600_000 })
    if (r.code !== 0 && url) {
      await gitOk(tree, ['config', `submodule.${name}.url`, url])
      r = await git(tree, ['submodule', 'update', '--', path], { env, timeoutMs: 600_000 })
    }
    if (r.code !== 0) throw new RequestError(409, `submodule ${path} cannot be checked out in the run's copy: ${r.stderr.trim() || r.stdout.trim()}`)
  }
  if (url) {
    await gitOk(tree, ['config', `submodule.${name}.url`, url])
    if ((await remoteUrl(dir)) !== url) await gitOk(dir, ['remote', 'set-url', 'origin', url])
  }
}

async function submoduleName(tree: string, path: string): Promise<string> {
  const r = await git(tree, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'])
  for (const line of r.stdout.split('\n')) {
    const m = /^submodule\.(.+)\.path (.*)$/.exec(line)
    if (m && m[2].replace(/\/+$/, '') === path) return m[1]
  }
  throw new RequestError(409, `${path} is not a submodule of the run's base commit`)
}

// The project workspace's local notes and settings (regular files directly
// in its .local/, up to 1 MiB each) are copied into the copy's .local/,
// which Git ignores there. Folders (outputs, environments, other runs'
// copies) are not shared; a run that needs more names it from the project
// workspace.
async function localFiles(sharedRoot: string, tree: string): Promise<string[]> {
  const src = join(sharedRoot, '.local')
  const out: string[] = []
  for (const d of await readdir(src, { withFileTypes: true }).catch(() => [])) {
    if (!d.isFile()) continue
    const s = await lstat(join(src, d.name))
    if (s.size > LOCAL_FILE_MAX) continue
    await mkdir(join(tree, '.local'), { recursive: true })
    await copyFile(join(src, d.name), join(tree, '.local', d.name))
    out.push(d.name)
  }
  return out.sort()
}

// Reserve and create in one call (requests): the same receipt continues an
// interrupted creation of the same run.
export async function prepareCopy(ws: Workspace, o: ReserveOptions, env: Record<string, string> = {}): Promise<{ copy: RunCopy; workspace: Workspace; existing: boolean }> {
  const r = await reserve(ws, o, env)
  const copy = await materialize(ws, r.ref, env)
  return { copy, workspace: copyWorkspace(ws, copy), existing: r.existing }
}

// ---- reconstruction -------------------------------------------------------------------

export interface IndexEntry { ref: string; state: 'ready' | 'creating' | 'damaged' | 'rebuilt'; branch?: string; problem?: string }

// The index as it is, or rebuilt: a copy whose manifest is missing or
// damaged gets one reconstructed from the copy itself — the run branch it
// has checked out (wfe/<project>/<workflow>/<run> naming this folder) and
// the storage its run.json records. Nothing is cloned, checked out or
// restarted; a copy whose repository is gone stays reported.
export async function inspectIndex(ws: Workspace, o: { rebuild?: boolean } = {}): Promise<IndexEntry[]> {
  ws = ws.shared
  const out: IndexEntry[] = []
  for (const c of await listCopies(ws)) {
    const ref = runKey(c.ref)
    if (c.manifest && !c.problem) { out.push({ ref, state: 'ready', branch: c.manifest.branch }); continue }
    if (c.manifest?.state === 'creating') { out.push({ ref, state: 'creating', branch: c.manifest.branch, problem: c.problem! }); continue }
    if (!o.rebuild || c.manifest) { out.push({ ref, state: 'damaged', problem: c.problem! }); continue }
    const rebuilt = await reconstruct(ws, c).catch(e => (e as Error).message)
    out.push(typeof rebuilt === 'string' ? { ref, state: 'damaged', problem: `${c.problem}; not reconstructed: ${rebuilt}` } : { ref, state: 'rebuilt', branch: rebuilt.branch })
  }
  return out
}

async function reconstruct(ws: Workspace, c: RunCopy): Promise<CopyManifest> {
  if (!(await isRepoTop(c.tree))) throw new Error('the copy has no repository')
  const branch = (await git(c.tree, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim()
  const m = BRANCH.exec(branch)
  if (!m || m[2] !== c.ref.workflow || m[3] !== c.ref.run) throw new Error(`the copy has ${branch || 'a detached HEAD'} checked out, not a branch of this run`)
  const rec = JSON.parse(await readFile(join(c.tree, runFolder(c.ref), 'run.json'), 'utf8')) as { project?: string; storage?: RunStorage }
  if (rec.project !== m[1]) throw new Error(`run.json names project ${rec.project}, the branch ${m[1]}`)
  const recorded = rec.storage?.repositories ?? []
  const repositories: CopyRepo[] = []
  for (const r of (await planRepositories(ws)).repositories) {
    const dir = r.path === '.' ? c.tree : join(c.tree, r.path)
    const had = recorded.find(x => x.path === r.path)
    const initialized = r.path === '.' || await isRepoTop(dir)
    repositories.push({ ...r, initialized, base: had?.base ?? null, branch: initialized ? branch : null, target: had?.target ?? r.target, url: initialized ? await remoteUrl(dir) : null })
  }
  const manifest: CopyManifest = { schema: COPY_SCHEMA, project: m[1], workspace: ws.reg.id, workflow: c.ref.workflow, run: c.ref.run, branch, state: 'ready', created: now(), ready: now(), receipt: null, repositories, local: [], reconstructed: now() }
  await atomicWrite(join(c.dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}
