// Integration of an accepted result into the project's shared branches (p9,
// docs/integration.md). Saving (checkpoints, server/publish.ts) puts a run's
// work on its own branches; integration is the separate, later operation
// that brings the accepted work into the targets its storage records.
//
// - The decision binds to an exact revision: when `accepted` is recorded,
//   the file layer records the tree of every repository the run owns, as
//   the copy held it at that moment (`acceptedRevision`), uncommitted files
//   included. Integration takes the commits saved after every attempt
//   ended and refuses them when they differ from that revision anywhere but
//   in the run's own run.json (administrative state) or the gitlinks
//   of submodules the run owns (checked in those submodules).
// - Each repository is one step of a durable journal: target, observed
//   target commit, candidate (the run branch), method, resulting commit,
//   pushed. Submodules go first; the root records their integrated commits
//   as its gitlinks. The whole is not atomic: a failure leaves the steps
//   done as they are, and a retry continues from the journal after checking
//   the remote again (a push that happened before a crash is found, not
//   repeated).
// - A target that has not moved is fast-forwarded. One that moved gets a
//   combined result made in an integration working tree (a git worktree of
//   the run's copy), merged and checked: a conflict, or a combination that
//   changes files the run itself changed, stops before anything is pushed
//   and is the agent's work (a linked repair run). Nothing is ever forced.
// - Updates of one remote branch take turns across runs and projects (a
//   lock per remote URL and target branch on this host).
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFolder, runKey, type RunRef, type RunStorage } from '../shared/run.ts'
import { git, gitOk } from './git.ts'
import { withLock } from './lock.ts'
import { copyDir } from './runspace.ts'
import type { Workspace } from './workspace.ts'

export interface RevisionEntry { path: string; tree: string }

export type StepState = 'pending' | 'done' | 'conflict' | 'needs-agreement' | 'attention' | 'failed' | 'planned'
export interface IntegrationStep {
  repo: string // project-relative ('.' root)
  target: string // the shared branch
  branch: string // the run branch (the candidate's)
  observed?: string // the target's commit as last fetched before integrating
  candidate?: string // the run branch's commit integrated
  method?: 'already' | 'fast-forward' | 'merge'
  result?: string // the target's commit after integration
  pushed?: boolean
  state: StepState
  files?: string[] // conflicts, or reviewed files the combination would change
  error?: string
}
export type IntegrationState = 'integrated' | 'partial' | 'conflict' | 'needs-agreement' | 'refused' | 'attention' | 'failed' | 'planned'
export interface IntegrationOutcome { state: IntegrationState; steps: IntegrationStep[]; error?: string }

const isAncestor = async (dir: string, a: string, b: string) => (await git(dir, ['merge-base', '--is-ancestor', a, b])).code === 0
const revOf = async (dir: string, ref: string) => { const r = await git(dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]); return r.code === 0 ? r.stdout.trim() : null }
const names = (out: string) => out.split('\n').map(s => s.trim()).filter(Boolean)

// The tree a repository's working copy holds now, uncommitted and untracked
// files included (ignored ones not), computed in a temporary index so that
// nothing of the repository's own index or work changes.
export async function workingTree(dir: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'wfe-tree-'))
  try {
    const env = { GIT_INDEX_FILE: join(tmp, 'index') }
    await gitOk(dir, ['read-tree', 'HEAD'], { env })
    await gitOk(dir, ['add', '-A'], { env })
    return (await gitOk(dir, ['write-tree'], { env })).trim()
  } finally { await rm(tmp, { recursive: true, force: true }) }
}

// What an acceptance binds to: the tree of each repository the run owns.
// Each tree is kept reachable (refs/wfe/accepted/<tree>) so that garbage
// collection never removes it before the integration compares with it.
export async function acceptedRevision(space: Workspace, storage: RunStorage): Promise<RevisionEntry[]> {
  const out: RevisionEntry[] = []
  for (const r of storage.repositories.filter(x => x.branch)) {
    const dir = r.path === '.' ? space.root : join(space.root, r.path)
    const tree = await workingTree(dir)
    await gitOk(dir, ['update-ref', `refs/wfe/accepted/${tree}`, tree])
    out.push({ path: r.path, tree })
  }
  return out
}

// Paths in a repository that are administrative: the run's own run.json
// (in whichever repository owns devdocs), and in the root the
// gitlinks of submodules the run owns.
// Plans, reports and presentation files in the same folder are reviewed
// content: changing them after acceptance requires agreement again.
async function administrative(space: Workspace, ref: RunRef, storage: RunStorage): Promise<(repo: string, path: string) => boolean> {
  const info = await space.devdocs()
  const owner = info.owner === 'devdocs' ? 'devdocs' : '.'
  const folder = info.owner === 'devdocs' ? runFolder(ref).slice('devdocs/'.length) : runFolder(ref)
  const subs = storage.repositories.filter(r => r.path !== '.' && r.branch).map(r => r.path)
  return (repo, path) => (repo === owner && path === `${folder}/run.json`) || (repo === '.' && subs.includes(path))
}

// What differs between two revisions of the run's result, apart from the
// administrative records (project_migration p3/ex1): `repo:path` per
// reviewed file. Null when the two do not name the same repositories (no
// comparison is possible). An empty list is the same result.
export async function resultChanges(space: Workspace, ref: RunRef, storage: RunStorage, from: RevisionEntry[], to: RevisionEntry[]): Promise<string[] | null> {
  const admin = await administrative(space, ref, storage)
  const out: string[] = []
  for (const r of storage.repositories.filter(x => x.branch)) {
    const a = from.find(x => x.path === r.path), b = to.find(x => x.path === r.path)
    if (!a || !b) return null
    if (a.tree === b.tree) continue
    const dir = r.path === '.' ? space.root : join(space.root, r.path)
    const diff = await git(dir, ['diff', '--name-only', a.tree, b.tree])
    if (diff.code !== 0) return null
    out.push(...names(diff.stdout).filter(p => !admin(r.path, p)).map(p => `${r.path}:${p}`))
  }
  return out
}

// Orders the repositories as they are published: submodules (devdocs
// first), then the root.
function ordered(storage: RunStorage) {
  const subs = storage.repositories.filter(r => r.path !== '.' && r.branch).sort((a, b) => (a.path === 'devdocs' ? -1 : b.path === 'devdocs' ? 1 : a.path < b.path ? -1 : 1))
  return [...subs, ...storage.repositories.filter(r => r.path === '.')]
}

export interface IntegrateOptions {
  space: Workspace // the run's copy
  ref: RunRef
  project: string
  storage: RunStorage
  accepted: RevisionEntry[] // the decision's revision
  previous: IntegrationStep[] // the journal so far
  env: Record<string, string>
  lockDir: string // where per-target locks live (this host)
  dryRun?: boolean
  save: (steps: IntegrationStep[]) => void // durable journal write, before and after each push
}

export async function integrate(o: IntegrateOptions): Promise<IntegrationOutcome> {
  const repos = ordered(o.storage)
  const steps: IntegrationStep[] = repos.map(r => {
    const prev = o.previous.find(s => s.repo === r.path)
    return prev && !o.dryRun ? { ...prev, error: undefined } : { repo: r.path, target: r.target ?? '', branch: r.branch!, state: 'pending' }
  })
  const admin = await administrative(o.space, o.ref, o.storage)
  const results = new Map<string, string>() // submodule → its integrated commit
  const message = `Integrate ${o.project}/${runKey(o.ref)} into `
  for (const step of steps) {
    const dir = step.repo === '.' ? o.space.root : join(o.space.root, step.repo)
    const fail = (state: StepState, error: string, files?: string[]) => { step.state = state; step.error = error; if (files) step.files = files; return state }
    try {
      if (!step.target) { fail('attention', `${step.repo}: no integration target was recorded (the project workspace had no branch checked out)`); break }
      const accepted = o.accepted.find(a => a.path === step.repo)
      if (!accepted) { fail('attention', `${step.repo}: the accepted revision does not name this repository`); break }
      // The candidate: the run branch as saved and published.
      const fetchRun = await git(dir, ['fetch', '-q', 'origin', `+refs/heads/${step.branch}:refs/remotes/origin/${step.branch}`], { env: o.env, timeoutMs: 120_000 })
      if (fetchRun.code !== 0) { fail('failed', `fetching the run branch failed: ${fetchRun.stderr.trim()}`); break }
      const candidate = await revOf(dir, `refs/heads/${step.branch}`)
      if (!candidate || candidate !== await revOf(dir, `refs/remotes/origin/${step.branch}`)) { fail('attention', `${step.repo}: the run branch ${step.branch} is not saved as published (local ${candidate?.slice(0, 10) ?? 'missing'}); its checkpoint is published first`); break }
      if (step.candidate && step.candidate !== candidate && step.state !== 'done') { step.observed = undefined; step.result = undefined; step.method = undefined; step.pushed = undefined }
      step.candidate ??= candidate
      // The binding: only administrative records may differ from what was accepted.
      const changed = names((await gitOk(dir, ['diff', '--name-only', accepted.tree, `${candidate}^{tree}`])).toString()).filter(p => !admin(step.repo, p))
      if (changed.length) { fail('needs-agreement', `the result changed after it was accepted: ${changed.slice(0, 20).join(', ')}${changed.length > 20 ? ' …' : ''}; present it again for agreement`, changed); break }
      // A repository the run made no commit in is left as its target has it:
      // nothing to integrate, and the root's gitlink for it is not touched.
      const base = o.storage.repositories.find(r => r.path === step.repo)?.base
      if (candidate === base && step.state !== 'done') {
        const fetched = await git(dir, ['fetch', '-q', 'origin', `+refs/heads/${step.target}:refs/remotes/origin/${step.target}`], { env: o.env, timeoutMs: 120_000 })
        if (fetched.code !== 0) { fail('failed', `fetching ${step.target} failed: ${fetched.stderr.trim()}`); break }
        const observed = (await revOf(dir, `refs/remotes/origin/${step.target}`))!
        Object.assign(step, { observed, method: 'already', result: observed, pushed: true, state: o.dryRun ? 'planned' : 'done', error: undefined })
        continue
      }
      if (candidate === base) continue // done before: unchanged by the run
      const url = (await gitOk(dir, ['remote', 'get-url', 'origin'])).trim()
      const key = createHash('sha256').update(`${url}\0${step.target}`).digest('hex').slice(0, 24)
      await mkdir(o.lockDir, { recursive: true })
      const outcome = await withLock(join(o.lockDir, `target-${key}`), () => integrateOne(o, step, dir, candidate, admin, results, `${message}${step.target}`, () => o.save(steps)), { what: `integration into ${step.target} of ${step.repo === '.' ? 'the project root' : step.repo}`, timeoutMs: 600_000 })
      if (outcome !== 'done' && outcome !== 'planned') break
      if (step.repo !== '.') results.set(step.repo, step.result!)
    } catch (e) {
      fail('failed', (e as Error).message)
      break
    } finally {
      if (!o.dryRun) o.save(steps)
    }
  }
  const states = steps.map(s => s.state)
  const stop = steps.find(s => s.state !== 'done' && s.state !== 'planned' && s.state !== 'pending')
  if (states.every(s => s === 'done')) return { state: 'integrated', steps }
  if (states.every(s => s === 'planned' || s === 'done')) return { state: 'planned', steps }
  const some = steps.some(s => s.state === 'done' && s.method !== 'already') // progress that reached a target
  const blocking: IntegrationState = stop?.state === 'conflict' ? 'conflict' : stop?.state === 'needs-agreement' ? 'needs-agreement' : stop?.state === 'failed' ? 'failed' : 'attention'
  return { state: some ? 'partial' : blocking, steps, error: stop ? `${stop.repo}: ${stop.error}` : undefined }
}

// One repository, under its target's lock.
async function integrateOne(o: IntegrateOptions, step: IntegrationStep, dir: string, candidate: string, admin: (repo: string, path: string) => boolean, results: Map<string, string>, message: string, saveAll: () => void): Promise<StepState> {
  const fetched = await git(dir, ['fetch', '-q', 'origin', `+refs/heads/${step.target}:refs/remotes/origin/${step.target}`], { env: o.env, timeoutMs: 120_000 })
  if (fetched.code !== 0) { step.state = 'failed'; step.error = `fetching ${step.target} failed: ${fetched.stderr.trim()}`; return step.state }
  const observed = (await revOf(dir, `refs/remotes/origin/${step.target}`))!
  // A retry: what an earlier try pushed is found on the target, not pushed again.
  if (step.result && await isAncestor(dir, step.result, observed)) { step.pushed = true; step.state = 'done'; step.error = undefined; return step.state }
  if (step.state === 'done' && step.result) { step.state = 'attention'; step.error = `${step.target} no longer contains the integrated commit ${step.result.slice(0, 10)} (rewritten by someone else); nothing was forced`; return step.state }
  step.observed = observed
  // Submodule commits the root must record: what each integration produced.
  const gitlinks = step.repo === '.' ? [...results.entries()] : []
  const linksMatch = async (commit: string) => {
    for (const [path, sha] of gitlinks) {
      const m = /^160000 commit ([0-9a-f]+)\t/.exec((await gitOk(dir, ['ls-tree', commit, '--', path])).toString())
      if (m?.[1] !== sha) return false
    }
    return true
  }
  let result: string
  if (await isAncestor(dir, candidate, observed) && await linksMatch(observed)) { step.method = 'already'; result = observed }
  else if (await isAncestor(dir, observed, candidate) && await linksMatch(candidate)) { step.method = 'fast-forward'; result = candidate }
  else {
    const combined = await combine(o, step, dir, candidate, observed, gitlinks, admin, message)
    if (typeof combined !== 'string') return combined.state
    step.method = 'merge'; result = combined
  }
  step.result = result
  if (o.dryRun) { step.state = 'planned'; return step.state }
  if (result === observed) { step.pushed = true; step.state = 'done'; return step.state }
  step.pushed = false
  saveAll() // the journal names the commit before it can reach the remote
  const p = await git(dir, ['push', '--porcelain', 'origin', `${result}:refs/heads/${step.target}`], { env: o.env, timeoutMs: 120_000 })
  if (p.code !== 0) {
    step.state = 'attention'
    step.error = /rejected|non-fast-forward|fetch first/i.test(p.stderr + p.stdout) ? `${step.target} moved while integrating (nothing was forced); retry to combine again: ${(p.stderr.trim() || p.stdout.trim()).split('\n').pop()}` : `pushing ${step.target} failed: ${p.stderr.trim()}`
    return step.state
  }
  step.pushed = true
  step.state = 'done'
  await git(dir, ['fetch', '-q', 'origin', `+refs/heads/${step.target}:refs/remotes/origin/${step.target}`], { env: o.env, timeoutMs: 60_000 })
  return step.state
}

// The combined result of a moved target and the candidate, made in a
// worktree of the copy's repository: merged, the root's owned gitlinks set
// to their integrated commits, and checked that the run's own changes come
// through unchanged. Returns the commit, or the step state that stops.
async function combine(o: IntegrateOptions, step: IntegrationStep, dir: string, candidate: string, observed: string, gitlinks: [string, string][], admin: (repo: string, path: string) => boolean, message: string): Promise<string | { state: StepState }> {
  const wt = join(copyDir(o.space.shared, o.ref), 'integration', step.repo === '.' ? 'root' : step.repo.replace(/[^A-Za-z0-9_.-]+/g, '_'))
  await git(dir, ['worktree', 'remove', '--force', wt])
  await rm(wt, { recursive: true, force: true })
  await git(dir, ['worktree', 'prune'])
  await mkdir(join(wt, '..'), { recursive: true })
  await gitOk(dir, ['worktree', 'add', '-q', '--detach', wt, observed])
  try {
    const ff = await isAncestor(dir, observed, candidate)
    const m = ff ? await git(wt, ['merge', '-q', '--ff-only', candidate]) : await git(wt, ['merge', '-q', '--no-ff', '--no-edit', '-m', message, candidate], { env: o.env })
    const conflicted = names((await git(wt, ['diff', '--name-only', '--diff-filter=U'])).stdout)
    const owned = new Set(gitlinks.map(([p]) => p))
    const real = conflicted.filter(p => !owned.has(p))
    if (m.code !== 0 && (real.length || !conflicted.length)) {
      await git(wt, ['merge', '--abort'])
      step.state = 'conflict'; step.files = real; step.error = real.length ? `combining with ${step.target} conflicts in ${real.slice(0, 20).join(', ')}${real.length > 20 ? ' …' : ''}: the repair is agent work (a run that resolves it)` : `combining with ${step.target} failed: ${(m.stderr.trim() || m.stdout.trim()).split('\n').pop()}`
      return { state: step.state }
    }
    for (const [path, sha] of gitlinks) await gitOk(wt, ['update-index', '--cacheinfo', `160000,${sha},${path}`])
    const merging = (await git(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0
    if (merging) await gitOk(wt, ['commit', '-q', '--no-edit'], { env: o.env })
    else if ((await git(wt, ['diff', '--cached', '--quiet'])).code === 1) await gitOk(wt, ['commit', '-q', '-m', `${message}: record the integrated submodules`], { env: o.env })
    const head = (await gitOk(wt, ['rev-parse', 'HEAD'])).trim()
    // The run's own changes must come through as they were accepted.
    const base = (await gitOk(dir, ['merge-base', observed, candidate])).trim()
    const ours = names((await gitOk(dir, ['diff', '--name-only', base, candidate])).toString()).filter(p => !admin(step.repo, p))
    const altered = ours.length ? names((await gitOk(dir, ['diff', '--name-only', candidate, head, '--', ...ours])).toString()) : []
    if (altered.length) {
      step.state = 'needs-agreement'; step.files = altered
      step.error = `${step.target} changed files this run changed too (${altered.slice(0, 20).join(', ')}${altered.length > 20 ? ' …' : ''}); the combined result differs from what was accepted and is presented for agreement first (a run that combines them)`
      return { state: step.state }
    }
    return head
  } finally {
    await git(dir, ['worktree', 'remove', '--force', wt])
    await rm(wt, { recursive: true, force: true })
    await git(dir, ['worktree', 'prune'])
  }
}
