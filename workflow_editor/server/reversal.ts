// What undoing a run involves (p9, docs/integration.md *Abandonment and
// reversal*): facts for the person and for the agent that would do it, never
// an operation. Cancelling keeps a run's work; discarding unintegrated work
// needs nothing on the shared branches; integrated work is undone as new
// work (new commits that revert it), with the exact commits each
// integration brought, per repository. History is never rewritten.
import { join } from 'node:path'
import { runFolder, runKey, type RunRef } from '../shared/run.ts'
import { git } from './git.ts'
import { readRun } from './runs.ts'
import { readCopy, runSpace } from './runspace.ts'
import { RequestError, type Workspace } from './workspace.ts'

export interface ReversalRepo {
  path: string
  target: string
  method: string
  before: string // the target's commit before the integration (observed)
  after: string // the integration's resulting commit
  commits: string[] // what the integration brought onto the target, oldest first
  files: string[] // paths it changed (the run's record folder included)
  later: number | null // commits the target gained since (null: not known on this host)
  submodule: boolean
}
export interface ReversalFacts {
  ref: string
  state: 'kept' | 'not-integrated' | 'integrated'
  summary: string
  saved: { branch: string; repositories: { path: string; head: string | null }[] } | null // the run's own branch, kept
  copy: string | null // where the run's files are on this host
  integrations: { decision: number; at: string; by: string; repositories: ReversalRepo[] }[]
  steps: string[] // how an agent prepares a reversal as new work
  external: string[] // what Git cannot undo
}

const names = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean)

export async function reversalFacts(ws: Workspace, ref: RunRef): Promise<ReversalFacts> {
  const space = await runSpace(ws, ref)
  const record = (await readRun(space, ref)).record
  if (!record) throw new RequestError(409, `run ${runKey(ref)} cannot be read`)
  const copy = space.copyOf ? await readCopy(ws, ref) : null
  const external = [
    'Effects outside Git — a service deployed, data written elsewhere, messages sent, files outside the repositories — are not undone by reverting commits; inspect and reverse them on their own.',
    ...Object.values(record.presentations ?? {}).filter(p => p.state === 'available' || p.state === 'stop-failed').map(p => `Presentation ${p.id} "${p.title}" may still be served (wfe present stop ${runKey(ref)} ${p.id}).`),
  ]
  if (!record.storage || !space.copyOf) {
    return {
      ref: runKey(ref), state: 'kept', copy: null, saved: null, integrations: [], external,
      summary: `Run ${runKey(ref)} has no copy of its own (recorded before p9): what it published went to the project's branches by its checkpoints; their commits are in the project's history (git log --grep "${runKey(ref)}:").`,
      steps: [`Find its commits: git log --format='%h %s' --grep '^${runKey(ref)}:' (in each repository it changed).`, 'Revert them as new commits in a new run; never rewrite history.'],
    }
  }
  const saved = { branch: record.storage.branch, repositories: await Promise.all(record.storage.repositories.filter(r => r.branch).map(async r => ({ path: r.path, head: (await git(r.path === '.' ? space.root : join(space.root, r.path), ['rev-parse', '-q', '--verify', `refs/heads/${r.branch}`])).stdout.trim() || null }))) }
  const integrations: ReversalFacts['integrations'] = []
  const folder = runFolder(ref)
  for (const i of record.integrations ?? []) {
    const repos: ReversalRepo[] = []
    for (const r of i.repositories.filter(x => x.method !== 'already')) {
      const dir = r.path === '.' ? space.root : join(space.root, r.path)
      const commits = names((await git(dir, ['rev-list', '--reverse', `${r.observed}..${r.result}`])).stdout)
      const files = names((await git(dir, ['diff', '--name-only', r.observed, r.result])).stdout)
      const tip = (await git(dir, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${r.target}`])).stdout.trim()
      const later = tip && (await git(dir, ['merge-base', '--is-ancestor', r.result, tip])).code === 0 ? Number((await git(dir, ['rev-list', '--count', `${r.result}..${tip}`])).stdout.trim()) : null
      repos.push({ path: r.path, target: r.target, method: r.method, before: r.observed, after: r.result, commits, files, later, submodule: r.path !== '.' })
    }
    integrations.push({ decision: i.decision, at: i.at, by: i.by, repositories: repos })
  }
  if (!integrations.length) {
    return {
      ref: runKey(ref), state: 'not-integrated', copy: copy?.tree ?? null, saved, integrations, external,
      summary: `Nothing of run ${runKey(ref)} is on the project's shared branches: its work is saved on its own branch ${record.storage.branch}${copy ? ' and in its copy on this host' : ''}. Discarding it needs no rollback; cancelling keeps it (nothing is deleted).`,
      steps: ['Nothing to revert on a shared branch.', `Its plan and work stay readable on ${record.storage.branch}${copy ? ` and in ${copy.tree}` : ''}; a new request can name this run as its predecessor to reuse them.`],
    }
  }
  const steps: string[] = ['Prepare the reversal as new work — a new run that names this one as its predecessor — with new commits that revert what the integration brought; history is never rewritten, and later changes on the targets stay.']
  for (const it of integrations) for (const r of it.repositories) {
    const keep = r.path === '.' || (r.path === 'devdocs' && folder.startsWith('devdocs/')) ? (r.path === '.' ? folder : folder.slice('devdocs/'.length)) : null
    const where = r.path === '.' ? 'the project root' : r.path
    const revert = r.method === 'merge' ? `git revert --no-commit -m 1 ${r.after}` : `git revert --no-commit ${r.before}..${r.after}`
    steps.push(`${where} (${r.target}, ${r.commits.length} commit${r.commits.length === 1 ? '' : 's'} from ${r.before.slice(0, 10)} to ${r.after.slice(0, 10)}${r.later ? `; ${r.later} later commit${r.later === 1 ? '' : 's'} since, kept` : ''}): ${revert}${keep ? `, then git checkout HEAD -- ${keep} (the run's records stay as evidence)` : ''}, and commit.`)
    if (r.submodule) steps.push(`${r.path} is a repository of its own${r.path.startsWith('study/') || r.path.startsWith('wedo/') ? ', possibly shared with other projects' : ''}: its revert is a commit on its ${r.target}; the root then records that new commit. Setting the root's gitlink back to ${r.before.slice(0, 10)} alone would not undo ${r.path}'s branch.`)
  }
  steps.push('The reversal run is accepted and integrated like any other result.')
  return {
    ref: runKey(ref), state: 'integrated', copy: copy?.tree ?? null, saved, integrations, external, steps,
    summary: `Run ${runKey(ref)}'s accepted result is integrated into ${[...new Set(integrations.flatMap(i => i.repositories.map(r => `${r.path === '.' ? 'root' : r.path} ${r.target}`)))].join(', ')}. Undoing it is new work that reverts the commits below.`,
  }
}
