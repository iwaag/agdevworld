// Publication of a run's work at a checkpoint (p4): commit and push what the
// attempt changed, submodules (devdocs first) before the root that records
// their gitlinks, without sweeping in changes that were already there.
//
// - Before an attempt begins, `baseline` notes every uncommitted path of the
//   workspace's repositories with a hash of its content.
// - At a checkpoint, a path is the run's change when it is uncommitted now and
//   was not in the baseline. A baseline path that is unchanged since is left
//   out (pre-existing). A baseline path that changed again cannot be
//   separated from the person's own edit: it is left out and the checkpoint
//   needs attention.
// - Each repository's commit and push is a step in the checkpoint's journal.
//   A retry pushes what was committed and commits only what was not, so the
//   work is never repeated; a push rejected because the remote moved needs
//   attention (nothing is forced).
//
// File saves and publication are separate: nothing here runs while an
// attempt's process may still be writing.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from './git.ts'
import type { Workspace } from './workspace.ts'

export type Baseline = Record<string, Record<string, string>> // repo path → file path → content hash ('-' deleted)

export interface RepoStep {
  repo: string // project-relative ('.' root)
  include: string[] // paths committed
  excluded: string[] // pre-existing, unchanged since the baseline
  conflicts: string[] // pre-existing and changed again: left out, needs a person
  commit?: string
  pushed?: boolean
  branch?: string
  error?: string
}
export interface PublishResult { state: 'published' | 'nothing' | 'attention' | 'failed'; steps: RepoStep[]; error?: string }

// Repositories in publication order: initialized submodules (devdocs first),
// then the root.
async function repos(ws: Workspace): Promise<string[]> {
  const subs: string[] = []
  for (const r of await ws.repositories()) if (r.kind === 'submodule' && r.initialized) subs.push(r.path)
  subs.sort((a, b) => (a === 'devdocs' ? -1 : b === 'devdocs' ? 1 : a < b ? -1 : 1))
  return [...subs, '.']
}

async function dirtyPaths(dir: string): Promise<{ path: string; deleted: boolean }[]> {
  // Submodules show only when their checked-out commit differs from the
  // recorded gitlink; their own uncommitted files are their own repository's.
  const r = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty'])
  const out: { path: string; deleted: boolean }[] = []
  const parts = r.stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]
    if (e.length < 4) continue
    const xy = e.slice(0, 2)
    out.push({ path: e.slice(3), deleted: xy.includes('D') })
    if (xy[0] === 'R' || xy[0] === 'C') i++ // the rename's source follows
  }
  return out
}

// A file's content hash; for a submodule path, its checked-out commit.
async function hashOf(file: string): Promise<string> {
  try { return createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 20) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EISDIR') return `commit:${(await git(file, ['rev-parse', 'HEAD'])).stdout.trim()}`
    return '\0missing'
  }
}

export async function baseline(ws: Workspace): Promise<Baseline> {
  const out: Baseline = {}
  for (const repo of await repos(ws)) {
    const dir = join(ws.root, repo)
    out[repo] = {}
    for (const d of await dirtyPaths(dir)) out[repo][d.path] = d.deleted ? '-' : await hashOf(join(dir, d.path))
  }
  return out
}

// `own`: the run's record folder as a path in each repository (repo →
// prefix); everything under it is the run's to publish, whatever the
// baseline says (its records are the run's reporting).
export async function publish(ws: Workspace, base: Baseline, message: string, previous: RepoStep[], env: Record<string, string>, own: Record<string, string> = {}): Promise<PublishResult> {
  const steps: RepoStep[] = []
  let attention = false, failed = ''
  const committedSubs: string[] = []
  for (const repo of await repos(ws)) {
    const dir = join(ws.root, repo)
    const prev = previous.find(s => s.repo === repo)
    const step: RepoStep = prev?.commit ? { ...prev, error: undefined } : { repo, include: [], excluded: [], conflicts: [] }
    steps.push(step)
    try {
      if (!step.commit) {
        const before = base[repo] ?? {}
        for (const d of await dirtyPaths(dir)) {
          // A submodule's gitlink in the root: ours when we published it now.
          if (repo === '.' && committedSubs.includes(d.path)) { step.include.push(d.path); continue }
          if (own[repo] && (d.path === own[repo] || d.path.startsWith(`${own[repo]}/`))) { step.include.push(d.path); continue }
          const h = d.deleted ? '-' : await hashOf(join(dir, d.path))
          if (!(d.path in before)) step.include.push(d.path)
          else if (before[d.path] === h) step.excluded.push(d.path)
          else step.conflicts.push(d.path)
        }
        if (step.conflicts.length) attention = true
        if (step.include.length) {
          const add = await git(dir, ['add', '-A', '--', ...step.include])
          if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`)
          const staged = await git(dir, ['diff', '--cached', '--quiet'])
          if (staged.code === 1) {
            const c = await git(dir, ['commit', '-q', '-m', message, '--', ...step.include], { env })
            if (c.code !== 0) throw new Error(`git commit failed: ${c.stderr.trim() || c.stdout.trim()}`)
            step.commit = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()
          }
        }
      }
      if (step.conflicts.length) attention = true
      if (step.commit && !step.pushed) {
        const branch = (await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim()
        // A detached submodule checkout publishes to its remote default branch.
        const target = branch || ((await git(dir, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])).stdout.trim().replace(/^origin\//, '') || 'main')
        step.branch = target
        const p = await git(dir, ['push', 'origin', `${step.commit}:refs/heads/${target}`], { env, timeoutMs: 120_000 })
        if (p.code !== 0) {
          if (/rejected|non-fast-forward|fetch first/i.test(p.stderr)) { attention = true; step.error = `the remote ${target} moved; integrate it by hand (nothing was forced): ${p.stderr.trim().split('\n').pop()}` }
          else throw new Error(`git push failed: ${p.stderr.trim()}`)
        } else {
          step.pushed = true
          await git(dir, ['fetch', '-q', 'origin', target], { env, timeoutMs: 60_000 }) // remote-tracking refs say it is published
        }
      }
      if (repo !== '.' && step.commit) committedSubs.push(repo)
      if (repo !== '.' && step.commit && !step.pushed) { attention = true; break } // never record a gitlink the remote does not have
    } catch (e) {
      step.error = (e as Error).message
      failed = `${repo}: ${step.error}`
      break // the root waits for its submodules
    }
  }
  if (failed) return { state: 'failed', steps, error: failed }
  if (attention) return { state: 'attention', steps }
  return { state: steps.some(s => s.commit) ? 'published' : 'nothing', steps }
}
