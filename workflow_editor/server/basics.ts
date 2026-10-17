// Basic workflows (p8/ex2): ordinary workflow definitions every project has
// from the start. Today one, `freework`: the braindump and one talk; its run
// grows its work in that conversation (docs/adjustments.md, *Growing a
// run's work*). Nothing in the editor or the executor knows it by name.
//
// One mechanism places it in a new project (create.ts) and adds it to an
// existing one (`wfe workflow basics`), and the "Free work" template makes
// the same definition under another id. A definition cannot change its
// bindings or execution later in an adjustment, so they are resolved from
// the project when it is placed:
//
// - repositories: the union of the bindings of the project's valid
//   workflows, each path with the most permissive access one of them
//   already grants (nothing becomes editable that no workflow made
//   editable); a project with no valid workflow (a new one) binds its root
//   editable and every submodule and local area readonly;
// - execution: the agent and profile every valid workflow agrees on, and
//   a project guide at agent/guide.md when present; otherwise left to the execution host;
// - intake: requests, as for every newly created workflow.
//
// Placing never overwrites: a workflow with the id, or a file with the
// name, is reported (present, conflict) and left as it is, so the person's
// edits stay theirs. Reading a project never places anything.
import { join, relative } from 'node:path'
import { stat } from 'node:fs/promises'
import { ACCESS_LEVELS, emptyWorkflow, normalizeRepoPath, type RepositoryBinding, type Workflow } from '../shared/model.ts'
import { validateWorkflow } from '../shared/validate.ts'
import { createExclusive } from './files.ts'
import { git } from './git.ts'
import { newWorkflowText } from './yamlDoc.ts'
import type { Workspace } from './workspace.ts'

export const FREEWORK = 'freework'

export interface BasicSettings {
  repositories: Record<string, RepositoryBinding>
  execution: Workflow['execution']
  // How each part was resolved, for the dry run and the report.
  notes: string[]
}

// The definition, with its settings. `id` and `name` differ when the
// template makes it under another id.
export function freeworkWorkflow(settings: Pick<BasicSettings, 'repositories' | 'execution'>, id = FREEWORK, name = 'Free work'): Workflow {
  const w = emptyWorkflow(id, name)
  w.intent = [
    'Serve the person\'s request starting from their braindump and one conversation.',
    'Agree in that conversation what to do, add that work to the run, do it,',
    'and talk again whenever the person needs to be consulted, until the request is served.',
  ].join('\n')
  w.documentation = { policy: 'custom', plan: false, reports: false, final: true }
  w.repositories = structuredClone(settings.repositories)
  w.execution = structuredClone(settings.execution)
  w.nodes.talk = {
    type: 'talk', name: 'Talk',
    description: 'Understand the request, hold the consultation it needs, and make the next work concrete.',
    repositories: [],
  }
  return w
}

// A project that has nothing to learn from yet: its own root is the work,
// what it shares or keeps aside is read only.
export function newProjectSettings(others: string[]): BasicSettings {
  const repositories: Record<string, RepositoryBinding> = { project: { path: '.', access: 'editable' } }
  for (const p of others.filter(p => p !== '.' && p !== 'devdocs')) repositories[keyFor(p, repositories)] = { path: p, access: 'editable' }
  return {
    repositories, execution: { agent: '', profile: '', guides: [] },
    notes: ['no valid workflow to learn from: the project root editable, every other repository readonly', 'execution: the execution host\'s defaults'],
  }
}

const KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/
function keyFor(path: string, taken: Record<string, unknown>, wanted?: string): string {
  const base = (wanted && KEY.test(wanted) ? wanted : path === '.' ? 'project' : path.split('/').at(-1)!.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '')) || 'repo'
  if (!(base in taken)) return base
  for (let n = 2; ; n++) if (!(`${base}-${n}` in taken)) return `${base}-${n}`
}

// Use the conventional project-wide guide, never infer one from a workflow.
async function projectGuides(ws: Workspace): Promise<string[]> {
  try { return (await stat(join(ws.root, 'agent', 'guide.md'))).isFile() ? ['agent/guide.md'] : [] }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
}

// Resolves the settings from the project's valid workflows (see the head).
export async function resolveSettings(ws: Workspace): Promise<BasicSettings> {
  const repos = await ws.repositories()
  const files = await ws.workflowFiles()
  const valid: Workflow[] = []
  const skipped: string[] = []
  for (const f of files) {
    const r = await ws.readWorkflowFile(f)
    if (!r.workflow) { skipped.push(`${f} (cannot be read)`); continue }
    if (r.workflow.id === FREEWORK) continue
    if (validateWorkflow(r.workflow, { repositories: repos }).some(i => i.severity === 'error')) { skipped.push(`${f} (has validation errors)`); continue }
    valid.push(r.workflow)
  }
  if (!valid.length) {
    const s = newProjectSettings(repos.filter(r => r.kind === 'submodule' || (r.kind === 'directory' && r.path !== 'devdocs')).map(r => r.path))
    s.execution.guides = await projectGuides(ws)
    if (s.execution.guides.length) s.notes.push('project guide: agent/guide.md')
    if (skipped.length) s.notes.push(`not learned from: ${skipped.join(', ')}`)
    return s
  }
  const notes = [`learned from ${valid.map(w => w.id).join(', ')}${skipped.length ? `; not from ${skipped.join(', ')}` : ''}`]
  // Paths with the most permissive access any workflow grants them.
  const byPath = new Map<string, { access: string; key: string }>()
  for (const w of valid) {
    for (const [key, b] of Object.entries(w.repositories)) {
      const path = normalizeRepoPath(b.path)
      if (!path || !(ACCESS_LEVELS as readonly string[]).includes(b.access)) continue
      const cur = byPath.get(path)
      if (!cur) byPath.set(path, { access: b.access, key })
      else if (b.access === 'editable') cur.access = 'editable'
    }
  }
  const repositories: Record<string, RepositoryBinding> = {}
  for (const [path, { access, key }] of [...byPath].sort(([a], [b]) => (a === '.' ? -1 : b === '.' ? 1 : a < b ? -1 : 1))) repositories[keyFor(path, repositories, key)] = { path, access }
  notes.push(`repositories: ${Object.entries(repositories).map(([k, b]) => `${k} ${b.path} ${b.access}`).join('; ')}`)
  // Execution: what every workflow agrees on.
  const same = (f: (w: Workflow) => string) => { const v = valid.map(f); return v.every(x => x === v[0]) ? v[0] : '' }
  const agent = same(w => w.execution.agent), profile = same(w => w.execution.profile)
  const guides = await projectGuides(ws)
  notes.push(`execution: ${agent ? `agent ${agent}` : 'the host\'s agent'}${profile ? `, profile ${profile}` : ''}${guides.length ? `, guides ${guides.join(', ')}` : ', no project guide'}`)
  return { repositories, execution: { agent, profile, guides }, notes }
}

export type BasicStatus = 'added' | 'would-add' | 'present' | 'conflict' | 'unplaceable' | 'covered'
export interface BasicResult {
  workspace: string
  project: string
  workflow: string
  status: BasicStatus
  file?: string // project-relative
  reason: string
  notes?: string[]
  commit?: string
  pushed?: boolean
  publishError?: string
}

// What placing the basic workflows in one workspace would do, or does.
// `commit` commits the added file in the repository that owns devdocs (a
// path-limited commit, nothing else), and the root's gitlink in submodule
// mode; `push` pushes those commits when the branch has an upstream.
export async function placeBasics(ws: Workspace, opts: { dryRun?: boolean; commit?: boolean; push?: boolean; gitEnv?: Record<string, string> } = {}): Promise<BasicResult[]> {
  const project = (await ws.readProject().catch(() => ({ project: undefined }))).project?.id ?? ws.reg.project ?? ws.reg.id
  const base = { workspace: ws.reg.id, project, workflow: FREEWORK }
  const dir = await ws.workflowsDir()
  if (!dir.exists) return [{ ...base, status: 'unplaceable', reason: `devdocs/workflows cannot hold it here: ${dir.reason}` }]
  const file = `devdocs/workflows/${FREEWORK}.yaml`
  const { list } = await ws.workflowSummaries()
  const same = list.find(s => s.id === FREEWORK)
  if (same) return [{ ...base, status: 'present', file: `devdocs/workflows/${same.file}`, reason: `already defined in ${same.file}${same.errors ? ` (${same.errors} validation error${same.errors === 1 ? '' : 's'}; left as it is)` : ''}` }]
  const byName = list.find(s => s.file === `${FREEWORK}.yaml` || s.file === `${FREEWORK}.yml`)
  if (byName) return [{ ...base, status: 'conflict', file: `devdocs/workflows/${byName.file}`, reason: byName.problem ? `${byName.file} exists and cannot be read (${byName.problem.message}); fix or rename it by hand` : `${byName.file} holds workflow "${byName.id}"; rename it, or give freework another file by hand` }]
  const settings = await resolveSettings(ws)
  const text = newWorkflowText(freeworkWorkflow(settings))
  if (opts.dryRun) return [{ ...base, status: 'would-add', file, reason: 'not defined in this project', notes: settings.notes }]
  try {
    await createExclusive(join(dir.path, `${FREEWORK}.yaml`), text)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return [{ ...base, status: 'conflict', file, reason: `${FREEWORK}.yaml appeared meanwhile; left as it is` }]
    throw e
  }
  const result: BasicResult = { ...base, status: 'added', file, reason: 'not defined in this project', notes: settings.notes }
  if (opts.commit) Object.assign(result, await commitPlaced(ws, file, opts.push ?? false, opts.gitEnv ?? {}))
  return [result]
}

// `env`: the host's Git credentials for pushing (the Gitea token's askpass,
// as run publication uses).
async function commitPlaced(ws: Workspace, file: string, push: boolean, env: Record<string, string>): Promise<Pick<BasicResult, 'commit' | 'pushed' | 'publishError'>> {
  const info = await ws.devdocs()
  const message = 'Add the basic workflow freework (talk first; the run grows its work in conversation)'
  const run = async (cwd: string, args: string[]) => { const r = await git(cwd, args); if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`); return r.stdout.trim() }
  try {
    const inOwner = relative(info.ownerDir, join(ws.root, file))
    await run(info.ownerDir, ['add', '--', inOwner])
    await run(info.ownerDir, ['commit', '-m', message, '--only', '--', inOwner])
    let commit = await run(info.ownerDir, ['rev-parse', 'HEAD'])
    const pushes = [info.ownerDir]
    if (info.owner === 'devdocs') {
      // The root records the new devdocs commit.
      await run(ws.root, ['add', '--', 'devdocs'])
      await run(ws.root, ['commit', '-m', `devdocs: ${message}`, '--only', '--', 'devdocs'])
      commit = `${commit.slice(0, 12)} (devdocs), ${(await run(ws.root, ['rev-parse', 'HEAD'])).slice(0, 12)} (root)`
      pushes.push(ws.root)
    }
    if (!push) return { commit, pushed: false }
    for (const repo of pushes) {
      const up = await git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      if (up.code !== 0) return { commit, pushed: false, publishError: `${relative(ws.root, repo) || '.'} has no upstream branch; push it by hand` }
      const r = await git(repo, ['push'], { env, timeoutMs: 120_000 })
      await git(repo, ['fetch', '-q'], { env, timeoutMs: 60_000 }) // remote-tracking refs say it is published
      if (r.code !== 0) return { commit, pushed: false, publishError: `push of ${relative(ws.root, repo) || '.'} failed: ${(r.stderr || r.stdout).trim()}` }
    }
    return { commit, pushed: true }
  } catch (e) {
    return { publishError: (e as Error).message }
  }
}

// Every registered workspace, once per project (and once per devdocs
// repository, when projects share one): the first workspace that can hold
// it places it; the others are covered by it.
export async function placeBasicsEverywhere(workspaces: Workspace[], opts: { dryRun?: boolean; commit?: boolean; push?: boolean; gitEnv?: Record<string, string> } = {}): Promise<BasicResult[]> {
  const out: BasicResult[] = []
  const done = new Map<string, string>() // project id or devdocs identity → workspace that placed it
  for (const ws of workspaces) {
    const project = (await ws.readProject().catch(() => ({ project: undefined }))).project?.id ?? ws.reg.project ?? ws.reg.id
    const devdocs = await devdocsIdentity(ws)
    const by = done.get(`project:${project}`) ?? (devdocs ? done.get(devdocs) : undefined)
    if (by) { out.push({ workspace: ws.reg.id, project, workflow: FREEWORK, status: 'covered', reason: `the same ${done.get(`project:${project}`) ? 'project' : 'devdocs repository'} as workspace ${by}` }); continue }
    const [r] = await placeBasics(ws, opts)
    out.push(r)
    if (r.status !== 'unplaceable') { done.set(`project:${project}`, ws.reg.id); if (devdocs) done.set(devdocs, ws.reg.id) }
  }
  return out
}

// A devdocs repository shared by projects (submodule mode) is one place.
async function devdocsIdentity(ws: Workspace): Promise<string | null> {
  const info = await ws.devdocs().catch(() => null)
  if (!info || info.owner !== 'devdocs') return null
  const url = await git(info.ownerDir, ['remote', 'get-url', 'origin'])
  if (url.code === 0 && url.stdout.trim()) return `devdocs:${url.stdout.trim()}`
  const st = await stat(info.ownerDir).catch(() => null)
  return st ? `devdocs-dir:${st.ino}` : null
}

// For new projects (create.ts): the file a fresh project starts with.
export const newProjectFreework = (others: string[] = []) => newWorkflowText(freeworkWorkflow(newProjectSettings(others)))
