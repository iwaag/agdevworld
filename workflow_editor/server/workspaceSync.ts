// A workspace beside the published source (improve_wfrun p1, docs/storage.md
// *The workspace and the published source*): how the editing checkout
// relates to the project's default branch on Gitea, and an optional,
// conservative way to bring it forward.
//
// Relation and dirtiness are separate facts. `same`, `behind`, `ahead` and
// `diverged` are decided from commits both sides are known to have: the
// access cache holds every Gitea branch, the workspace its own objects. A
// head the cache does not know carries unpublished commits; a published
// commit the workspace does not have is work it lacks. Nothing here reads
// `atCommitted` alone, and reading never fetches into or changes the
// workspace.
//
// Synchronization only fast-forwards: the root on the published default
// branch, clean, only behind; each submodule whose pin moves, clean and at
// its old pin. Anything else is refused with the reason and the
// differences. State is read again just before each change; nothing is
// stashed, reset, merged or rebased. Several repositories are updated in
// order (root, then submodules outermost first); each step is reported, so
// a partial update says what moved and what did not, and running it again
// continues from there.
import { join } from 'node:path'
import { normalizeRepoPath } from '../shared/model.ts'
import { gitmodules } from './agdev.ts'
import { locate, type AccessContext } from './access.ts'
import { git } from './git.ts'
import { resolvePublished, type PublishedSource } from './published.ts'
import { RequestError, type Workspace } from './workspace.ts'

export type Relation = 'same' | 'behind' | 'ahead' | 'diverged' | 'unknown'

export interface RepoRelation {
  path: string // '.' the root
  head: string | null // what the workspace has checked out
  branch: string | null // null: detached
  published: string | null // the root commit, or the gitlink it records
  relation: Relation
  behind: number | null // published commits the workspace lacks
  ahead: number | null // workspace commits the published side lacks
  dirty: number // changed tracked entries and untracked files
  initialized: boolean
  problem?: string
}

export interface WorkspaceRelation {
  workspace: string
  project: string
  source: PublishedSource
  observed: string
  root: RepoRelation
  submodules: RepoRelation[]
  // The situation in a few words, and what can be done next.
  summary: string
  next: 'none' | 'sync' | 'resolve-by-hand'
}

const now = () => new Date().toISOString()
const has = async (dir: string, commit: string) => (await git(dir, ['cat-file', '-e', `${commit}^{commit}`])).code === 0
const count = async (dir: string, range: string[]) => { const r = await git(dir, ['rev-list', '--count', ...range]); return r.code === 0 ? Number(r.stdout.trim()) : null }

// How a checkout's head stands against a published commit, deciding only
// from objects one side is known to have.
async function relate(wsDir: string, cacheDir: string | null, head: string | null, published: string | null): Promise<Pick<RepoRelation, 'relation' | 'behind' | 'ahead'>> {
  if (!head || !published) return { relation: 'unknown', behind: null, ahead: null }
  if (head === published) return { relation: 'same', behind: 0, ahead: 0 }
  // Both in the cache: every commit of the head is on some Gitea branch.
  if (cacheDir && await has(cacheDir, head) && await has(cacheDir, published)) {
    const ahead = await count(cacheDir, [head, `^${published}`])
    const behind = await count(cacheDir, [published, `^${head}`])
    return { relation: ahead && behind ? 'diverged' : behind ? 'behind' : ahead ? 'ahead' : 'same', behind, ahead }
  }
  // The head has commits Gitea does not: ahead, or diverged when the
  // workspace also lacks published commits.
  if (await has(wsDir, published)) {
    const ahead = await count(wsDir, [head, `^${published}`])
    const behind = await count(wsDir, [published, `^${head}`])
    return { relation: ahead && behind ? 'diverged' : behind ? 'behind' : ahead ? 'ahead' : 'same', behind, ahead }
  }
  return { relation: 'diverged', behind: null, ahead: await count(wsDir, [head, '--not', '--remotes']) }
}

async function checkout(dir: string): Promise<{ head: string | null; branch: string | null; dirty: number; initialized: boolean }> {
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return { head: null, branch: null, dirty: 0, initialized: false }
  const head = await git(dir, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])
  const branch = await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'])
  const status = await git(dir, ['status', '--porcelain=v1', '--ignore-submodules=all'])
  return { head: head.code === 0 ? head.stdout.trim() : null, branch: branch.code === 0 ? branch.stdout.trim() : null, dirty: status.stdout.split('\n').filter(Boolean).length, initialized: true }
}

// The workspace's root and every submodule the published revision pins,
// related to it. `fresh` fetches the published side now.
export async function workspaceRelation(ctx: AccessContext, ws: Workspace, o: { fresh?: boolean } = {}): Promise<WorkspaceRelation> {
  ws = ws.shared
  const project = ws.reg.project
  if (!project) throw new RequestError(409, `workspace ${ws.reg.id} names no registered project`)
  const source = await resolvePublished(ctx, project, { fresh: o.fresh })
  const rootLoc = await locate(ctx, project, '.', { rev: source.commit })
  const c = await checkout(ws.root)
  const root: RepoRelation = { path: '.', head: c.head, branch: c.branch, published: source.commit, ...(await relate(ws.root, rootLoc.dir, c.head, source.commit)), dirty: c.dirty, initialized: true }
  const submodules: RepoRelation[] = []
  const walk = async (cacheDir: string, commit: string, prefix: string, depth: number) => {
    const mods = await git(cacheDir, ['show', `${commit}:.gitmodules`])
    for (const m of mods.code === 0 && depth < 8 ? gitmodules(mods.stdout) : []) {
      const rel = normalizeRepoPath(m.path) ?? m.path
      const path = prefix ? `${prefix}/${rel}` : rel
      const pin = /^160000 commit ([0-9a-f]+)\t/.exec((await git(cacheDir, ['ls-tree', commit, '--', rel])).stdout)?.[1] ?? null
      const dir = join(ws.root, path)
      const sc = await checkout(dir)
      const isOwn = sc.initialized && (await git(dir, ['rev-parse', '--show-toplevel'])).stdout.trim() !== (await git(join(dir, '..'), ['rev-parse', '--show-toplevel'])).stdout.trim()
      if (!sc.initialized || !isOwn) { submodules.push({ path, head: null, branch: null, published: pin, relation: 'unknown', behind: null, ahead: null, dirty: 0, initialized: false, problem: 'not checked out in the workspace' }); continue }
      let sub: string | null = null, problem: string | undefined
      try { sub = (await locate(ctx, project, path, { rev: source.commit })).dir } catch (e) { problem = (e as Error).message }
      submodules.push({ path, head: sc.head, branch: sc.branch, published: pin, ...(await relate(dir, sub, sc.head, pin)), dirty: sc.dirty, initialized: true, ...(problem ? { problem } : {}) })
      if (sub && pin) await walk(sub, pin, path, depth + 1)
    }
  }
  await walk(rootLoc.dir, source.commit, '', 0)
  const all = [root, ...submodules.filter(s => s.initialized)]
  const dirty = all.filter(r => r.dirty)
  let summary: string, next: WorkspaceRelation['next']
  if (all.every(r => r.relation === 'same')) { summary = `The workspace is at the published ${source.branch}${dirty.length ? `, with uncommitted changes in ${dirty.map(r => r.path).join(', ')}` : ''}.`; next = 'none' }
  else if (root.relation === 'behind' || (root.relation === 'same' && all.every(r => r.relation === 'same' || r.relation === 'behind'))) {
    const blocked = syncBlockers(source, root, submodules)
    summary = `The workspace is ${root.relation === 'behind' ? `${root.behind} commit${root.behind === 1 ? '' : 's'} behind` : 'behind in a submodule of'} the published ${source.branch}. Published workflows run as published; editing here starts from an older version.`
    next = blocked.length ? 'resolve-by-hand' : 'sync'
    if (blocked.length) summary += ` It cannot be brought forward automatically: ${blocked.join('; ')}.`
  } else {
    const r = all.find(x => x.relation !== 'same')!
    summary = `The workspace${r.path === '.' ? '' : `'s ${r.path}`} is ${r.relation} ${r.relation === 'unknown' ? 'against' : 'relative to'} the published ${source.branch}${r.ahead ? ` (${r.ahead} local commit${r.ahead === 1 ? '' : 's'})` : ''}${r.behind ? ` (${r.behind} published commit${r.behind === 1 ? '' : 's'} missing)` : ''}. Published workflows still run as published; the workspace is left for you to reconcile.`
    next = 'resolve-by-hand'
  }
  return { workspace: ws.reg.id, project, source, observed: now(), root, submodules, summary, next }
}

// Why a fast-forward is not possible, each reason concrete.
function syncBlockers(source: PublishedSource, root: RepoRelation, subs: RepoRelation[]): string[] {
  const out: string[] = []
  if (root.branch !== source.branch) out.push(`the root has ${root.branch ? `branch ${root.branch}` : 'a detached HEAD'} checked out, not ${source.branch}`)
  if (root.dirty) out.push(`the root has ${root.dirty} uncommitted change${root.dirty === 1 ? '' : 's'}`)
  if (root.relation !== 'behind' && root.relation !== 'same') out.push(`the root is ${root.relation}`)
  for (const s of subs) {
    if (!s.initialized) continue
    if (s.dirty) out.push(`${s.path} has ${s.dirty} uncommitted change${s.dirty === 1 ? '' : 's'}`)
    if (s.relation === 'ahead' || s.relation === 'diverged') out.push(`${s.path} is ${s.relation} of its published pin`)
  }
  return out
}

export interface SyncStep { path: string; before: string | null; after: string | null; state: 'moved' | 'unchanged' | 'refused' | 'failed' | 'planned'; detail: string }
export interface SyncResult { ok: boolean; workspace: string; source: PublishedSource; steps: SyncStep[]; relation: WorkspaceRelation; message: string; recovery?: string }

// Brings the workspace forward to the published revision when it can do so
// without losing anything; otherwise changes nothing and says why.
export async function syncWorkspace(ctx: AccessContext, ws: Workspace, o: { dryRun?: boolean; env?: Record<string, string> } = {}): Promise<SyncResult> {
  ws = ws.shared
  const rel = await workspaceRelation(ctx, ws, { fresh: true })
  const { source } = rel
  const steps: SyncStep[] = []
  const blockers = syncBlockers(source, rel.root, rel.submodules)
  if (rel.next === 'none') return { ok: true, workspace: ws.reg.id, source, steps: [{ path: '.', before: rel.root.head, after: rel.root.head, state: 'unchanged', detail: 'already at the published revision' }], relation: rel, message: rel.summary }
  if (rel.next !== 'sync' || blockers.length) return { ok: false, workspace: ws.reg.id, source, steps: [], relation: rel, message: `Nothing was changed. ${blockers.length ? blockers.join('; ') : rel.summary}` }
  const moving = rel.submodules.filter(s => s.initialized && s.relation === 'behind')
  if (o.dryRun) {
    return { ok: true, workspace: ws.reg.id, source, relation: rel, message: 'Dry run: nothing was changed.', steps: [
      ...(rel.root.relation === 'behind' ? [{ path: '.', before: rel.root.head, after: source.commit, state: 'planned' as const, detail: `fast-forward ${source.branch}` }] : []),
      ...moving.map(s => ({ path: s.path, before: s.head, after: s.published, state: 'planned' as const, detail: s.branch ? `fast-forward ${s.branch}` : 'check out the pinned commit' })),
    ] }
  }
  const env = o.env ?? (ctx.gitea ? await ctx.gitea.gitEnv() : {})
  // The root: fetched from its own remote, checked again, fast-forwarded.
  if (rel.root.relation === 'behind') {
    const f = await git(ws.root, ['fetch', '-q', '--no-recurse-submodules', 'origin', `+refs/heads/${source.branch}:refs/remotes/origin/${source.branch}`], { env, timeoutMs: 120_000 })
    if (f.code !== 0) return failed(ws, source, rel, steps, { path: '.', before: rel.root.head, after: rel.root.head, state: 'failed', detail: `fetch failed: ${f.stderr.trim()}` })
    const again = await checkout(ws.root)
    if (again.head !== rel.root.head || again.branch !== source.branch || again.dirty) return failed(ws, source, rel, steps, { path: '.', before: rel.root.head, after: again.head, state: 'refused', detail: 'the root changed while it was being synchronized; nothing was moved' })
    if (!(await has(ws.root, source.commit))) return failed(ws, source, rel, steps, { path: '.', before: rel.root.head, after: rel.root.head, state: 'failed', detail: `the workspace's origin does not have ${source.commit.slice(0, 10)}; is origin the project's Gitea repository?` })
    const m = await git(ws.root, ['merge', '--ff-only', '-q', source.commit])
    if (m.code !== 0) return failed(ws, source, rel, steps, { path: '.', before: rel.root.head, after: rel.root.head, state: 'refused', detail: `git refused the fast-forward: ${m.stderr.trim() || m.stdout.trim()}` })
    steps.push({ path: '.', before: rel.root.head, after: source.commit, state: 'moved', detail: `fast-forwarded ${source.branch}` })
  }
  // Submodules whose pin moved, outermost first; one never checked out stays so.
  const after = await workspaceRelation(ctx, ws)
  const subs = after.submodules.filter(s => s.initialized && s.relation === 'behind').sort((a, b) => a.path.split('/').length - b.path.split('/').length)
  for (const s of subs) {
    const dir = join(ws.root, s.path)
    const now2 = await checkout(dir)
    if (now2.dirty || now2.head !== s.head) { steps.push({ path: s.path, before: s.head, after: now2.head, state: 'refused', detail: 'changed while being synchronized, or has uncommitted changes' }); continue }
    if (!(await has(dir, s.published!))) {
      const f = await git(dir, ['fetch', '-q', '--no-recurse-submodules', 'origin'], { env, timeoutMs: 120_000 })
      if (f.code !== 0 || !(await has(dir, s.published!))) { steps.push({ path: s.path, before: s.head, after: s.head, state: 'failed', detail: `the pinned commit ${s.published!.slice(0, 10)} could not be fetched: ${f.stderr.trim()}` }); continue }
    }
    const r = s.branch ? await git(dir, ['merge', '--ff-only', '-q', s.published!]) : await git(dir, ['checkout', '-q', '--detach', s.published!])
    steps.push(r.code === 0 ? { path: s.path, before: s.head, after: s.published, state: 'moved', detail: s.branch ? `fast-forwarded ${s.branch}` : 'checked out the pinned commit' } : { path: s.path, before: s.head, after: s.head, state: 'failed', detail: r.stderr.trim() || r.stdout.trim() })
  }
  for (const s of after.submodules.filter(x => !x.initialized)) steps.push({ path: s.path, before: null, after: null, state: 'unchanged', detail: 'not checked out in the workspace; left so' })
  const final = await workspaceRelation(ctx, ws)
  const bad = steps.filter(x => x.state === 'failed' || x.state === 'refused')
  return {
    ok: !bad.length, workspace: ws.reg.id, source, steps, relation: final,
    message: bad.length ? `Partly synchronized: ${steps.filter(x => x.state === 'moved').map(x => x.path).join(', ') || 'nothing'} moved; ${bad.map(x => `${x.path}: ${x.detail}`).join('; ')}.` : `Synchronized to ${source.repository}@${source.commit.slice(0, 10)}.`,
    ...(bad.length ? { recovery: 'Nothing was reset or discarded. Resolve the named repositories by hand (commit or move their changes), then run the synchronization again: what already moved stays, the rest continues.' } : {}),
  }
}

function failed(ws: Workspace, source: PublishedSource, rel: WorkspaceRelation, steps: SyncStep[], step: SyncStep): SyncResult {
  return { ok: false, workspace: ws.reg.id, source, steps: [...steps, step], relation: rel, message: `Nothing was changed: ${step.detail}`, recovery: 'The workspace is as it was. Retry when the reason is gone.' }
}

