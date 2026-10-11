// The agdev resource operations (p4): projects and shared repositories on
// Gitea, workspaces obtained from Gitea on this host, and the dashboard's
// global listing. The registry holds identities only (server/registry.ts);
// project files, .gitmodules and gitlinks stay the authority, and every
// listed fact says where and when it was read.
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgdevResult, AgdevStep, DashboardProject, DashboardRepository, DashboardResponse, DashboardWorkspace, Observation, RepositoryUse } from '../shared/api.ts'
import { ID_PATTERN, normalizeRepoPath, PROJECT_SCHEMA } from '../shared/model.ts'
import { inside } from './files.ts'
import { git, gitOk } from './git.ts'
import { Gitea, GiteaError, relativeRepoUrl, repoOfUrl, type GiteaRepo } from './gitea.ts'
import {
  loadRegistry, observe, registerProject, registerRepository, registerWorkspace, repoKey,
  type Registration, type Registry, type RepoCategory, type RepoEntry,
} from './registry.ts'
import { listRuns } from './runs.ts'
import { RequestError, Workspace } from './workspace.ts'
import { parseProject } from './yamlDoc.ts'

export interface AgdevContext {
  registryFile: string
  area: string // where workspaces obtained from Gitea are checked out
  gitea?: Gitea
  giteaProblem?: string // why there is no Gitea (unconfigured, unreadable setting)
  executor?: () => Promise<DashboardResponse['executor']>
}

const needGitea = (ctx: AgdevContext): Gitea => {
  if (!ctx.gitea) throw new RequestError(503, `Gitea is not available: ${ctx.giteaProblem ?? 'no Gitea setting'}`)
  return ctx.gitea
}
const wrapGitea = async <T>(f: () => Promise<T>): Promise<T> => {
  try { return await f() } catch (e) {
    if (e instanceof GiteaError) throw new RequestError(e.status === 0 ? 502 : e.status >= 500 ? 502 : 409, e.message)
    throw e
  }
}
const exists = (p: string) => stat(p).then(() => true, () => false)
const cacheDir = (ctx: AgdevContext) => join(ctx.area, '.local', 'gitea-cache')

// Parses a .gitmodules text into path → url.
export function gitmodules(text: string): { path: string; url: string }[] {
  const out: { path: string; url: string }[] = []
  let cur: { path?: string; url?: string } | null = null
  for (const line of text.split('\n')) {
    if (/^\s*\[submodule\s/.test(line)) { if (cur?.path && cur.url) out.push(cur as { path: string; url: string }); cur = {}; continue }
    const m = /^\s*(path|url)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && cur) cur[m[1] as 'path' | 'url'] = m[2]
  }
  if (cur?.path && cur.url) out.push(cur as { path: string; url: string })
  return out
}

// ---- registration of what exists on Gitea --------------------------------------------

export async function registerSharedRepository(ctx: AgdevContext, owner: string, name: string, category: RepoCategory): Promise<AgdevResult> {
  const g = needGitea(ctx)
  if (category === 'root') throw new RequestError(400, 'a project root is registered as a project, not as a shared repository')
  const repo = await wrapGitea(() => g.repo(owner, name))
  if (!repo) throw new RequestError(404, `${owner}/${name} does not exist on Gitea`)
  const r = await registerRepository(ctx.registryFile, repo, category)
  return { ok: true, message: r.status === 'registered' ? `Registered ${repo.fullName} as a ${category} repository.` : `${repo.fullName} is already registered.`, repository: r.entry }
}

// Creates a new, empty shared repository on Gitea with an initial README,
// then registers it. A same-named repository is a collision.
export async function createSharedRepository(ctx: AgdevContext, name: string, category: RepoCategory, description: string, env: Record<string, string> = {}): Promise<AgdevResult> {
  const g = needGitea(ctx)
  if (category === 'root' || category === 'devdocs') throw new RequestError(400, `${category} repositories are created with their project`)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) throw new RequestError(400, `"${name}" is not a repository name`)
  const steps: AgdevStep[] = []
  const existing = await wrapGitea(() => g.repo(g.owner, name))
  if (existing && await wrapGitea(() => g.hasContent(existing.owner, existing.name))) throw new RequestError(409, `${existing.fullName} already exists with content. Register it instead (it may be meant), or choose another name; nothing was changed.`)
  const repo = existing ?? await wrapGitea(() => g.createRepo(name, description))
  steps.push({ name: 'gitea', status: existing ? 'kept' : 'done', detail: existing ? `${repo.fullName} exists and is empty; using it` : `created ${repo.fullName}` })
  const work = join(ctx.area, '.local', `new-${name}-${process.pid}`)
  const gEnv = { ...env, ...(await g.gitEnv()) }
  const run = (cwd: string, args: string[]) => gitOk(cwd, args, { env: gEnv, config: { 'init.defaultBranch': 'main' }, timeoutMs: 120_000 })
  try {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(work, { recursive: true })
    await run(work, ['init', '--initial-branch=main'])
    await writeFile(join(work, 'README.md'), `# ${name}\n\n${description || `A shared ${category} repository.`}\n`)
    await run(work, ['add', '-A'])
    await run(work, ['commit', '-m', `Initialize ${name}`])
    await run(work, ['push', g.cloneUrl(repo.owner, repo.name), 'main'])
    steps.push({ name: 'initial commit', status: 'done', detail: `README.md pushed to ${repo.fullName}` })
  } finally {
    const { rm } = await import('node:fs/promises')
    await rm(work, { recursive: true, force: true })
  }
  const r = await registerRepository(ctx.registryFile, repo, category)
  steps.push({ name: 'registration', status: r.status === 'registered' ? 'done' : 'kept', detail: `${repo.fullName} as ${category}` })
  return { ok: true, message: `Created and registered ${repo.fullName}.`, steps, repository: r.entry }
}

// Registers an existing project root on Gitea: its project.yaml (v2) names
// the project; its devdocs repository (submodule mode) is registered too.
export async function registerGiteaProject(ctx: AgdevContext, owner: string, name: string): Promise<AgdevResult> {
  const g = needGitea(ctx)
  const repo = await wrapGitea(() => g.repo(owner, name))
  if (!repo) throw new RequestError(404, `${owner}/${name} does not exist on Gitea`)
  const read = await wrapGitea(() => g.readFiles(owner, name, repo.defaultBranch, ['project.yaml', '.gitmodules'], cacheDir(ctx)))
  const text = read.files['project.yaml']
  if (text === null) throw new RequestError(409, `${repo.fullName} has no project.yaml on ${repo.defaultBranch}; it is not a project root`)
  const parsed = parseProject(text)
  if (!parsed.ok) throw new RequestError(409, `${repo.fullName}: project.yaml cannot be read (${parsed.problem.message})`)
  const p = parsed.model
  if (p.schema !== PROJECT_SCHEMA) throw new RequestError(409, `${repo.fullName}: project.yaml is ${p.schema || 'without a schema'}, not ${PROJECT_SCHEMA}; older projects are registered again under the current contract`)
  if (!ID_PATTERN.test(p.id)) throw new RequestError(409, `${repo.fullName}: project id "${p.id}" is invalid`)
  const steps: AgdevStep[] = []
  const reg = await loadRegistry(ctx.registryFile)
  const clash = reg.projects.find(x => x.id === p.id && x.root !== repoKey(repo.id))
  if (clash) throw new RequestError(409, `project id "${p.id}" is already registered for another root repository (${clash.root}); nothing was changed`)
  const r = await registerRepository(ctx.registryFile, repo, 'root')
  steps.push({ name: 'root repository', status: r.status === 'registered' ? 'done' : 'kept', detail: repo.fullName })
  if (p.devdocs === 'submodule') {
    const mods = gitmodules(read.files['.gitmodules'] ?? '')
    const d = mods.find(m => normalizeRepoPath(m.path) === 'devdocs')
    const at = d && repoOfUrl(d.url, { giteaUrl: g.url, owner: repo.owner, name: repo.name })
    const dr = at && await wrapGitea(() => g.repo(at.owner, at.name))
    if (!dr) steps.push({ name: 'devdocs repository', status: 'failed', detail: d ? `${d.url} is not a repository of this Gitea; register it by hand` : 'no devdocs entry in .gitmodules' })
    else {
      const x = await registerRepository(ctx.registryFile, dr, 'devdocs')
      steps.push({ name: 'devdocs repository', status: x.status === 'registered' ? 'done' : 'kept', detail: dr.fullName })
    }
  }
  const pr = await registerProject(ctx.registryFile, p.id, repoKey(repo.id))
  steps.push({ name: 'project', status: pr.status === 'registered' ? 'done' : 'kept', detail: `${p.id} (${p.name})` })
  return { ok: true, message: pr.status === 'registered' ? `Registered project ${p.id} from ${repo.fullName}.` : `Project ${p.id} is already registered.`, steps, project: pr.entry }
}

// ---- workspaces from Gitea -----------------------------------------------------------

// Clones a registered project, with its submodules, into the area and
// registers the clone as a workspace. Never reuses or overwrites a folder.
export async function obtainWorkspace(ctx: AgdevContext, projectId: string, env: Record<string, string> = {}): Promise<AgdevResult> {
  const g = needGitea(ctx)
  const reg = await loadRegistry(ctx.registryFile)
  const project = reg.projects.find(p => p.id === projectId)
  if (!project) throw new RequestError(404, `project "${projectId}" is not registered`)
  const entry = reg.repositories.find(r => r.key === project.root)!
  const repo = await wrapGitea(() => g.repoById(entry.gitea.id))
  if (!repo) throw new RequestError(409, `the root repository of ${projectId} (Gitea id ${entry.gitea.id}, registered as ${entry.gitea.owner}/${entry.gitea.name}) no longer exists on Gitea`)
  let n = 1, dir = '', id = ''
  for (;; n++) {
    id = n === 1 ? projectId : `${projectId}-${n}`
    dir = join(ctx.area, n === 1 ? `pj-${projectId}` : `pj-${projectId}-${n}`)
    if (!(await exists(dir)) && !reg.workspaces.some(w => w.id === id)) break
  }
  const gEnv = { ...env, ...(await g.gitEnv()) }
  const r = await git(ctx.area, ['clone', '--recurse-submodules', '--', g.cloneUrl(repo.owner, repo.name), dir], { env: gEnv, timeoutMs: 300_000 })
  if (r.code !== 0) throw new RequestError(502, `cloning ${repo.fullName} failed: ${r.stderr.trim()}${await exists(dir) ? ` (the partial clone is left at ${dir})` : ''}`)
  const registered = await registerWorkspace(ctx.registryFile, dir, { id })
  if (!registered.ok) throw new RequestError(409, `cloned into ${dir}, but registration was refused: ${registered.message}`)
  return { ok: true, message: `Cloned ${repo.fullName} into ${dir} and registered it as workspace "${id}".`, workspace: id, path: dir, diagnostics: registered.diagnostics }
}

// Adds a registered shared repository to a workspace's project as a
// submodule at `path`, with a URL relative to the project root on Gitea.
// Only this project's .gitmodules and index change; other projects keep
// their gitlinks.
export async function addSharedRepository(ctx: AgdevContext, ws: Workspace, key: string, rawPath: string): Promise<AgdevResult> {
  const g = needGitea(ctx)
  const reg = await loadRegistry(ctx.registryFile)
  const entry = reg.repositories.find(r => r.key === key)
  if (!entry) throw new RequestError(404, `${key} is not a registered repository`)
  if (entry.category === 'root') throw new RequestError(400, 'a project root cannot be added as a submodule')
  const path = normalizeRepoPath(rawPath)
  if (!path || path === '.') throw new RequestError(400, `"${rawPath}" is not a project-relative path`)
  const repo = await wrapGitea(() => g.repoById(entry.gitea.id))
  if (!repo) throw new RequestError(409, `${entry.gitea.owner}/${entry.gitea.name} (Gitea id ${entry.gitea.id}) no longer exists on Gitea`)
  const origin = await git(ws.root, ['remote', 'get-url', 'origin'])
  const at = origin.code === 0 ? repoOfUrl(origin.stdout.trim(), { giteaUrl: g.url, owner: '', name: '' }) : null
  if (!at) throw new RequestError(409, `the project root's origin is not a repository of ${g.url}; a shared repository is added relative to it`)
  const url = relativeRepoUrl(at.owner, repo.owner, repo.name)
  const r = await ws.addSubmodule(path, url, await g.gitEnv())
  return { ...r, url, repository: entry.key }
}

// ---- the dashboard --------------------------------------------------------------------

async function workspaceView(w: Registration): Promise<DashboardWorkspace> {
  const o = await observe(w)
  const view: DashboardWorkspace = { id: w.id, label: w.label, host: w.host, available: o.available, reason: o.reason }
  if (!o.available) return view
  try {
    const runs = await listRuns(new Workspace(w))
    const ongoing = runs.filter(r => r.execution === 'in-progress' || r.execution === 'not-started')
    view.runs = {
      ongoing: ongoing.length,
      waitingOnPerson: runs.reduce((n, r) => n + (r.waiting?.length ?? 0), 0),
      problems: runs.filter(r => r.problem).length,
      list: ongoing.map(r => ({ ref: r.ref, execution: r.execution, waiting: r.waiting ?? [] })),
    }
  } catch (e) { view.runsError = (e as Error).message }
  return view
}

export async function dashboard(ctx: AgdevContext): Promise<DashboardResponse> {
  const at = new Date().toISOString()
  const reg: Registry = await loadRegistry(ctx.registryFile) // a broken registry is an error, never an empty list
  const g = ctx.gitea
  const out: DashboardResponse = {
    at, registry: { path: ctx.registryFile, exists: reg.exists },
    gitea: g ? { state: 'ok', url: g.url, owner: g.owner } : { state: 'unconfigured', error: ctx.giteaProblem },
    executor: ctx.executor ? await ctx.executor().catch(e => ({ state: 'unknown' as const, detail: (e as Error).message })) : { state: 'not-configured' },
    projects: [], repositories: [], unlinkedWorkspaces: [],
  }
  // Gitea observation of every registered repository, by id.
  const observed = new Map<string, GiteaRepo | null | Error>()
  if (g) {
    try { await g.login() } catch (e) { out.gitea = { state: 'unreachable', url: g.url, owner: g.owner, error: (e as Error).message } }
    if (out.gitea.state === 'ok') {
      await Promise.all(reg.repositories.map(async r => {
        try { observed.set(r.key, await g.repoById(r.gitea.id)) } catch (e) { observed.set(r.key, e as Error) }
      }))
    }
  }
  const nameOf = (r: RepoEntry) => { const o = observed.get(r.key); return o && !(o instanceof Error) ? { owner: o.owner, name: o.name } : r.gitea }

  const uses = new Map<string, RepositoryUse[]>()
  const unknown = new Map<string, { project: string; error: string }[]>()
  for (const p of reg.projects) {
    const rootEntry = reg.repositories.find(r => r.key === p.root)!
    const rootObs = observed.get(p.root)
    const view: DashboardProject = {
      id: p.id,
      root: { key: p.root, ...(rootObs && !(rootObs instanceof Error) ? { fullName: rootObs.fullName, htmlUrl: rootObs.htmlUrl } : { fullName: `${rootEntry.gitea.owner}/${rootEntry.gitea.name}`, error: rootObs instanceof Error ? rootObs.message : rootObs === null ? 'missing on Gitea' : out.gitea.state !== 'ok' ? 'Gitea not read' : undefined }) },
      definition: { source: '', at },
      workspaces: await Promise.all(reg.workspaces.filter(w => w.project === p.id).map(workspaceView)),
    }
    // Definition and submodules: from an available workspace, else from Gitea.
    let modules: string | null = null
    let source: Observation = { source: '', at }
    const ws = reg.workspaces.find(w => w.project === p.id && view.workspaces.find(x => x.id === w.id)?.available)
    try {
      if (ws) {
        source = { source: `workspace ${ws.id} (working tree)`, at }
        const read = await new Workspace(ws).readProject()
        if (read.project) { view.name = read.project.name; view.intent = read.project.intent; view.devdocs = read.project.devdocs } else source.error = read.problem?.message
        modules = await readFile(await inside(ws.path, '.gitmodules'), 'utf8').catch(() => '')
      } else if (g && out.gitea.state === 'ok' && rootObs && !(rootObs instanceof Error)) {
        const read = await g.readFiles(rootObs.owner, rootObs.name, rootObs.defaultBranch, ['project.yaml', '.gitmodules'], cacheDir(ctx))
        source = { source: `gitea ${rootObs.fullName}@${read.commit ? read.commit.slice(0, 10) : `${rootObs.defaultBranch} (no commits)`}`, at }
        const text = read.files['project.yaml']
        const parsed = text === null ? null : parseProject(text)
        if (parsed?.ok) { view.name = parsed.model.name; view.intent = parsed.model.intent; view.devdocs = parsed.model.devdocs } else source.error = text === null ? 'no project.yaml' : parsed && !parsed.ok ? parsed.problem.message : 'unreadable'
        modules = read.files['.gitmodules'] ?? ''
      } else {
        source = { source: 'none', at, error: 'no available workspace, and Gitea was not read' }
      }
    } catch (e) { source.error = (e as Error).message }
    view.definition = source
    if (modules === null) {
      for (const r of reg.repositories) unknown.set(r.key, [...(unknown.get(r.key) ?? []), { project: p.id, error: source.error ?? 'not read' }])
    } else {
      const base = { giteaUrl: g?.url ?? '', ...nameOf(rootEntry) }
      for (const m of gitmodules(modules)) {
        const target = repoOfUrl(m.url, base)
        const hit = target && reg.repositories.find(r => { const n = nameOf(r); return n.owner === target.owner && n.name === target.name })
        if (hit) uses.set(hit.key, [...(uses.get(hit.key) ?? []), { project: p.id, path: normalizeRepoPath(m.path) ?? m.path, source: source.source, at }])
      }
    }
    out.projects.push(view)
  }
  for (const r of reg.repositories) {
    if (r.category === 'root') continue // listed as its project
    const o = observed.get(r.key)
    const gitea: DashboardRepository['gitea'] = o instanceof Error ? { state: 'unknown', error: o.message, at }
      : o === null ? { state: 'missing', at }
        : o ? { state: o.owner === r.gitea.owner && o.name === r.gitea.name ? 'ok' : 'renamed', fullName: o.fullName, htmlUrl: o.htmlUrl, description: o.description, empty: o.empty, at }
          : { state: 'unknown', error: out.gitea.error ?? out.gitea.state, at }
    out.repositories.push({ key: r.key, category: r.category, description: r.description || gitea.description || '', registered: { owner: r.gitea.owner, name: r.gitea.name }, gitea, usedBy: uses.get(r.key) ?? [], usageUnknown: unknown.get(r.key) ?? [] })
  }
  out.unlinkedWorkspaces = await Promise.all(reg.workspaces.filter(w => !w.project || !reg.projects.some(p => p.id === w.project)).map(workspaceView))
  return out
}
