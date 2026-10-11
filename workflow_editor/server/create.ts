// Creates a new project and registers it: a root Git repository with
// project.yaml, .gitignore (.local/) and devdocs as a directory (default) or
// a submodule. Shared by the service (browser "Create project") and the CLI
// (`wfe create`).
//
// With Gitea (p4, the operating path) the root — and in submodule mode the
// devdocs repository — are created on Gitea first, the initial commits are
// pushed (devdocs before the root that records its gitlink), and the
// repositories, the project and the workspace are registered. Submodule URLs
// are relative (`../<name>.git`). Without Gitea (tests, local fixtures) the
// submodule source is a local bare repository and nothing is pushed.
// Commits use the person's own Git identity.
//
// Every step is journaled in a marker (.local/wfe-create.json) in the
// destination, including the Gitea ids of the repositories it created, so a
// creation that stops partway is continued with `resume` after its finished
// steps: nothing is created twice and nothing that exists is deleted or
// replaced. A same-named Gitea repository that this creation did not make is
// a collision, unless `reuse` says it is meant for this project and it is
// still empty.
import { mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AddSubmoduleResponse, CreateProjectResult, CreateStep } from '../shared/api.ts'
import { DEVDOCS_MODES, ID_PATTERN, normalizeRepoPath, PROJECT_SCHEMA, type DevdocsMode } from '../shared/model.ts'
import { readTextOrNull } from './files.ts'
import { git, gitOk, LOCAL_TRANSPORT } from './git.ts'
import { Gitea, type GiteaRepo } from './gitea.ts'
import { registerProject, registerRepository, registerWorkspace, repoKey } from './registry.ts'
import { Workspace } from './workspace.ts'
import { newProjectText, parseProject } from './yamlDoc.ts'

export interface CreateProjectOptions {
  dir: string // destination, absolute
  id: string
  name: string
  intent: string
  goals: string[]
  devdocs?: DevdocsMode // storage mode; default directory
  sourcesDir?: string // without Gitea: where a new local devdocs source is created (submodule mode)
  gitea?: Gitea // the operating path: repositories on Gitea
  reuse?: boolean // an existing, empty same-named Gitea repository is meant for this project
  devdocsSource?: string // an existing devdocs repository (path or URL) instead (submodule mode)
  registryFile: string
  workspaceId?: string
  resume?: boolean
  env?: Record<string, string> // extra Git environment (tests)
  failAfter?: string // test hook: stop after this step
}

const MARKER = '.local/wfe-create.json'
interface Journal { id?: string; devdocs?: DevdocsMode; devdocsSource?: string | null; startedAt?: string; gitea?: Partial<Record<'root' | 'devdocs', { id: number; fullName: string }>> }

// A Gitea repository for a creation: made now, made earlier by this creation
// (the journal holds its id), or an empty one the person meant to reuse. A
// same-named repository that is none of these is a collision; nothing in it
// is touched.
export async function ensureRepo(g: Gitea, name: string, description: string, own: { id: number } | undefined, reuse: boolean): Promise<{ repo: GiteaRepo; status: 'created' | 'kept' | 'reused' }> {
  const existing = await g.repo(g.owner, name)
  if (!existing) return { repo: await g.createRepo(name, description), status: 'created' }
  if (own && existing.id === own.id) return { repo: existing, status: 'kept' }
  if (own) throw new Error(`${existing.fullName} is no longer the repository this creation made (Gitea id ${existing.id}, journaled ${own.id}); inspect it by hand`)
  const empty = !(await g.hasContent(existing.owner, existing.name))
  if (reuse && empty) return { repo: existing, status: 'reused' }
  throw new Error(`${existing.fullName} already exists on Gitea${empty ? ' (empty)' : ' and has content'} and was not made by this creation. ${empty ? 'If it is meant for this project, run again with reuse; otherwise choose another project id.' : 'Choose another project id, or register that project instead.'} Nothing in it was changed.`)
}
const exists = (p: string) => stat(p).then(() => true, () => false)
const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[^/\\]+@[^:]+:/.test(s)
const posix = (p: string) => p.split(sep).join('/')
// A submodule URL from `from` to `to`, relative and through real paths, so a
// symlinked prefix (/var vs /private/var) never yields a path via the root.
async function relativeUrl(from: string, to: string): Promise<string> {
  const [a, b] = await Promise.all([realpath(from).catch(() => resolve(from)), realpath(to).catch(() => resolve(to))])
  const url = posix(relative(a, b))
  return url.startsWith('.') ? url : `./${url}`
}

// The person's identity as Git would use it. Missing values are reported;
// no fallback identity is invented.
export async function gitIdentity(env: Record<string, string> = {}): Promise<{ name?: string; email?: string }> {
  const get = async (key: string, envKey: string) => {
    const fromEnv = env[envKey] ?? process.env[envKey]
    if (fromEnv) return fromEnv
    const r = await git(tmpdir(), ['config', '--get', key], { env })
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : undefined
  }
  return { name: await get('user.name', 'GIT_AUTHOR_NAME'), email: await get('user.email', 'GIT_AUTHOR_EMAIL') }
}

// A new local bare repository with one initial commit, made with the
// person's Git identity. Refuses an existing path.
export async function createLocalSource(bare: string, files: Record<string, string>, message: string, env: Record<string, string> = {}): Promise<{ commit: string }> {
  if (await exists(bare)) throw new Error(`${bare} already exists; nothing in it was changed`)
  const run = (cwd: string, args: string[]) => gitOk(cwd, args, { env, config: { 'init.defaultBranch': 'main' }, timeoutMs: 120_000 })
  const parent = dirname(bare)
  await mkdir(parent, { recursive: true })
  await run(parent, ['init', '--bare', '--initial-branch=main', bare])
  const work = join(parent, `.tmp-${basename(bare)}-${process.pid}`)
  try {
    await run(parent, ['init', '--initial-branch=main', work])
    for (const [name, text] of Object.entries(files)) {
      await mkdir(dirname(join(work, name)), { recursive: true })
      await writeFile(join(work, name), text)
    }
    await run(work, ['add', '-A'])
    await run(work, ['commit', '-m', message])
    const commit = (await run(work, ['rev-parse', 'HEAD'])).trim()
    await run(work, ['push', bare, 'main'])
    return { commit }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// `wfe add-repo <path> --new` and the project view's "new local repository":
// creates <sources>/<project id>-<path with / as ->.git with a README, then
// adds it as a submodule at <path> with a URL relative to the project root.
export async function addNewRepository(ws: Workspace, path: string, sourcesDir: string, env: Record<string, string> = {}): Promise<AddSubmoduleResponse & { source?: string; commit?: string }> {
  const norm = normalizeRepoPath(path)
  if (!norm || norm === '.') return { ok: false, message: `"${path}" is not a project-relative path` }
  if ((await ws.submodulePaths()).some(s => normalizeRepoPath(s.path) === norm)) return { ok: false, message: `${norm} is already a submodule` }
  const who = await gitIdentity(env)
  if (!who.name || !who.email) return { ok: false, message: 'Git has no user.name/user.email configured; set it and run this again. Nothing was created.' }
  const project = (await ws.readProject()).project
  const name = `${project?.id || ws.reg.id}-${norm.replace(/\//g, '-')}`
  const bare = join(sourcesDir, `${name}.git`)
  let made: { commit: string }
  try {
    made = await createLocalSource(bare, { 'README.md': `# ${name}\n\nRepository at ${norm} in ${project?.name || ws.reg.id}.\n` }, `Initialize ${name}`, env)
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
  const url = await relativeUrl(ws.root, bare)
  const added = await ws.addSubmodule(norm, url)
  return { ...added, message: `Created ${bare} (initial commit ${made.commit.slice(0, 7)}). ${added.message}`, source: bare, commit: made.commit }
}

export async function createProject(o: CreateProjectOptions): Promise<CreateProjectResult> {
  const dir = resolve(o.dir)
  const steps: CreateStep[] = []
  const commits: CreateProjectResult['commits'] = []
  const result = (ok: boolean, message: string, extra: Partial<CreateProjectResult> = {}): CreateProjectResult =>
    ({ ok, message, root: dir, steps, commits, ...extra })
  const step = (name: string, status: CreateStep['status'], detail: string) => { steps.push({ name, status, detail }) }
  const env = o.env ?? {}
  const run = (cwd: string, args: string[]) => gitOk(cwd, args, { env, config: { ...LOCAL_TRANSPORT, 'init.defaultBranch': 'main' }, timeoutMs: 120_000 })
  const stop = (name: string) => { if (o.failAfter === name) throw new Error(`stopped after "${name}" (test hook)`) }

  // ---- checks that write nothing ----
  if (!ID_PATTERN.test(o.id)) return result(false, `project id "${o.id}" must match ${ID_PATTERN.source}`)
  if (!o.name.trim()) return result(false, 'a project name is required')
  if (!isAbsolute(o.dir)) return result(false, 'the destination must be an absolute path')
  const mode: DevdocsMode = o.devdocs ?? 'directory'
  if (!(DEVDOCS_MODES as readonly string[]).includes(mode)) return result(false, `devdocs mode "${mode}" must be directory or submodule`)
  if (mode === 'directory' && o.devdocsSource) return result(false, 'a devdocs source repository applies to the submodule mode only')
  if (o.gitea && o.devdocsSource) return result(false, 'with Gitea the devdocs repository is created on Gitea; an existing source is added later as a shared repository')
  if (!o.gitea && mode === 'submodule' && !o.devdocsSource && !o.sourcesDir) return result(false, 'a submodule-mode project needs Gitea (or, for local fixtures, a sources directory)')
  if (o.gitea) {
    try { await o.gitea.login() } catch (e) { return result(false, `${(e as Error).message}; nothing was created`) }
  }
  const who = await gitIdentity(env)
  if (!who.name || !who.email) {
    return result(false, `Git has no ${!who.name ? 'user.name' : 'user.email'} configured. Set it (git config --global user.name "…" / user.email "…") and run this again; nothing was created.`)
  }
  const marker = join(dir, MARKER)
  let resuming = false
  if (await exists(dir)) {
    if (!(await stat(dir)).isDirectory()) return result(false, `${dir} exists and is not a directory`)
    const entries = await readdir(dir)
    if (entries.length) {
      if (!(await exists(marker))) return result(false, `${dir} is not empty and is not an unfinished creation; nothing was changed. Choose another destination, or use register for an existing project.`)
      if (!o.resume) return result(false, `${dir} holds an unfinished creation (${MARKER}). Run the same creation again with resume to continue it; nothing was changed.`, { resumable: true })
      resuming = true
    }
  }

  try {
    await mkdir(join(dir, '.local'), { recursive: true })
    const journal: Journal = resuming ? JSON.parse(await readTextOrNull(marker) ?? '{}') : {}
    if (resuming && (journal.id !== o.id || (journal.devdocs ?? 'submodule') !== mode)) throw new Error(`${MARKER} belongs to the creation of "${journal.id}" (${journal.devdocs}); resume it with the same id and devdocs mode`)
    Object.assign(journal, { id: o.id, devdocs: mode, devdocsSource: o.devdocsSource ?? null, startedAt: journal.startedAt ?? new Date().toISOString(), gitea: journal.gitea ?? {} })
    const save = () => writeFile(marker, `${JSON.stringify(journal, null, 2)}\n`)
    await save()
    step('destination', resuming ? 'kept' : 'done', resuming ? `continuing in ${dir}` : `created ${dir}`)
    stop('destination')

    // ---- Gitea repositories ----
    const g = o.gitea
    const gitEnv = g ? { ...env, ...(await g.gitEnv()) } : env
    const remoteRun = (cwd: string, args: string[]) => gitOk(cwd, args, { env: gitEnv, config: { 'init.defaultBranch': 'main' }, timeoutMs: 120_000 })
    const repos: Partial<Record<'root' | 'devdocs', GiteaRepo>> = {}
    if (g) {
      const wanted: [('root' | 'devdocs'), string, string][] = [['root', `pj-${o.id}`, `${o.name.trim()} — project root`]]
      if (mode === 'submodule') wanted.push(['devdocs', `pj-${o.id}-devdocs`, `${o.name.trim()} — devdocs`])
      for (const [role, name, description] of wanted) {
        const r = await ensureRepo(g, name, description, journal.gitea![role], !!o.reuse)
        repos[role] = r.repo
        journal.gitea![role] = { id: r.repo.id, fullName: r.repo.fullName }
        await save()
        step(`gitea ${role}`, r.status === 'created' ? 'done' : 'kept', `${r.repo.fullName} (${r.status})`)
      }
      stop('gitea')
    }

    // ---- devdocs source (submodule mode) ----
    let url = ''
    if (mode === 'directory') {
      // nothing: devdocs is a directory of the root repository
    } else if (g) {
      // The devdocs repository gets its initial commit and is pushed before
      // the root that will record its gitlink.
      const d = repos.devdocs!
      if (await g.hasContent(d.owner, d.name)) step('devdocs source', 'kept', `${d.fullName} already has its initial commit`)
      else {
        const work = join(dir, '.local', 'wfe-create-devdocs')
        await rm(work, { recursive: true, force: true })
        await run(dir, ['init', '--initial-branch=main', work])
        await mkdir(join(work, 'workflows'), { recursive: true })
        await writeFile(join(work, 'README.md'), `# ${o.name.trim()} — devdocs\n\nRequests, plans, reports, workflow definitions (workflows/) and runs (runs/) of ${o.id}.\n`)
        await writeFile(join(work, 'workflows', '.gitkeep'), '')
        await run(work, ['add', '-A'])
        await run(work, ['commit', '-m', `Initialize devdocs for ${o.id}`])
        const sha = (await run(work, ['rev-parse', 'HEAD'])).trim()
        await remoteRun(work, ['push', g.cloneUrl(d.owner, d.name), 'main'])
        await rm(work, { recursive: true, force: true })
        commits.push({ repository: d.fullName, commit: sha, message: `Initialize devdocs for ${o.id}` })
        step('devdocs source', 'done', `initial commit pushed to ${d.fullName}`)
      }
      url = `../${d.name}.git`
    } else if (o.devdocsSource) {
      const src = o.devdocsSource.trim()
      url = isUrl(src) ? src : await relativeUrl(dir, resolve(dir, src))
      step('devdocs source', 'kept', `using the existing repository ${src}`)
    } else {
      const bare = join(o.sourcesDir!, `${o.id}-devdocs.git`)
      if (await exists(bare)) {
        const head = await git(bare, ['rev-parse', '--verify', '-q', 'refs/heads/main'], { env })
        if (!resuming) throw new Error(`${bare} already exists. Use it with devdocsSource, or choose another project id; nothing in it was changed.`)
        if (head.code !== 0) throw new Error(`${bare} exists but has no main branch; inspect or remove it by hand, then resume`)
        step('devdocs source', 'kept', `${bare} already exists`)
      } else {
        const made = await createLocalSource(bare, { 'README.md': `# ${o.name} — devdocs\n\nRequests, plans, reports and workflow definitions of ${o.id}.\nWorkflows are in workflows/*.yaml.\n`, 'workflows/.gitkeep': '' }, `Initialize devdocs for ${o.id}`, env)
        commits.push({ repository: bare, commit: made.commit, message: `Initialize devdocs for ${o.id}` })
        step('devdocs source', 'done', `created ${bare} with an initial commit (README.md, workflows/)`)
      }
      url = await relativeUrl(dir, bare)
    }
    stop('devdocs source')

    // ---- root repository and files ----
    if (await exists(join(dir, '.git'))) step('root repository', 'kept', 'already a Git repository')
    else { await run(dir, ['init', '--initial-branch=main']); step('root repository', 'done', 'git init') }
    if (g) {
      const origin = await git(dir, ['remote', 'get-url', 'origin'], { env })
      const want = g.cloneUrl(repos.root!.owner, repos.root!.name)
      if (origin.code !== 0) await run(dir, ['remote', 'add', 'origin', want])
      else if (origin.stdout.trim() !== want) throw new Error(`origin is ${origin.stdout.trim()}, not ${want}; fix it by hand, then resume`)
    }
    stop('root repository')

    const projectFile = join(dir, 'project.yaml')
    const current = await readTextOrNull(projectFile)
    if (current === null) {
      await writeFile(projectFile, newProjectText({ schema: PROJECT_SCHEMA, id: o.id, name: o.name.trim(), devdocs: mode, intent: o.intent, goals: o.goals.filter(g => g.trim()) }))
      step('project.yaml', 'done', 'written')
    } else {
      const parsed = parseProject(current)
      if (!parsed.ok) throw new Error(`project.yaml exists and cannot be read (${parsed.problem.message}); fix it by hand, then resume`)
      if (parsed.model.id !== o.id) throw new Error(`project.yaml exists with id "${parsed.model.id}", not "${o.id}"; nothing was replaced`)
      if (parsed.model.devdocs !== mode) throw new Error(`project.yaml exists with devdocs "${parsed.model.devdocs}", not "${mode}"; nothing was replaced`)
      step('project.yaml', 'kept', 'already present; not rewritten')
    }
    const ignoreFile = join(dir, '.gitignore')
    const ignore = await readTextOrNull(ignoreFile)
    if (ignore === null) { await writeFile(ignoreFile, '.local/\n'); step('.gitignore', 'done', 'written with .local/') }
    else if (!ignore.split('\n').some(l => /^\/?\.local\/?\s*$/.test(l))) { await writeFile(ignoreFile, `${ignore}${ignore.endsWith('\n') || !ignore ? '' : '\n'}.local/\n`); step('.gitignore', 'done', 'added .local/') }
    else step('.gitignore', 'kept', 'already ignores .local/')
    stop('files')

    // ---- devdocs ----
    const ws = new Workspace({ id: o.id, label: o.name, host: 'this machine', path: dir })
    if (mode === 'directory') {
      if ((await ws.submodulePaths()).some(s => s.path === 'devdocs')) throw new Error('.gitmodules lists devdocs as a submodule, but the project is declared with devdocs as a directory; fix it by hand, then resume')
      const readme = join(dir, 'devdocs', 'README.md')
      await mkdir(join(dir, 'devdocs', 'workflows'), { recursive: true })
      if (!(await exists(readme))) await writeFile(readme, `# ${o.name.trim()} — devdocs\n\nRequests, plans, reports, workflow definitions (workflows/) and runs (runs/) of ${o.id}.\n`)
      if (!(await exists(join(dir, 'devdocs', 'workflows', '.gitkeep')))) await writeFile(join(dir, 'devdocs', 'workflows', '.gitkeep'), '')
      step('devdocs directory', 'done', 'devdocs/README.md and devdocs/workflows/ in the project root')
    } else if ((await ws.submodulePaths()).some(s => s.path === 'devdocs')) {
      step('devdocs submodule', 'kept', 'already in .gitmodules')
    } else {
      if (await exists(join(dir, 'devdocs'))) throw new Error('devdocs/ exists but is not a submodule; move it aside by hand (nothing was deleted), then resume')
      if (g) await remoteRun(dir, ['submodule', 'add', '--', url, 'devdocs'])
      else await run(dir, ['submodule', 'add', '--', url, 'devdocs'])
      step('devdocs submodule', 'done', `git submodule add ${url} devdocs`)
    }
    if (mode === 'submodule' && !(await exists(join(dir, 'devdocs', 'workflows')))) {
      await mkdir(join(dir, 'devdocs', 'workflows'), { recursive: true })
      step('devdocs/workflows', 'done', 'created (empty; the devdocs source had no workflows/)')
    }
    stop('devdocs submodule')

    // ---- initial commit ----
    await run(dir, ['add', '--', 'project.yaml', '.gitignore', ...(mode === 'submodule' ? ['.gitmodules'] : []), 'devdocs'])
    const staged = await git(dir, ['diff', '--cached', '--quiet'], { env })
    if (staged.code === 1) {
      const message = `Create project ${o.id}`
      await run(dir, ['commit', '-m', message])
      const sha = (await run(dir, ['rev-parse', 'HEAD'])).trim()
      commits.push({ repository: dir, commit: sha, message })
      step('initial commit', 'done', `${message} (${sha.slice(0, 7)})`)
    } else step('initial commit', 'kept', 'nothing left to commit')
    stop('initial commit')

    // ---- publication: the root, after the devdocs it records ----
    if (g) {
      await remoteRun(dir, ['push', '-u', 'origin', 'main'])
      step('push', 'done', `main pushed to ${repos.root!.fullName}`)
      stop('push')
      for (const role of ['root', 'devdocs'] as const) {
        const r = repos[role]
        if (r) await registerRepository(o.registryFile, { id: r.id, owner: r.owner, name: r.name, description: r.description }, role)
      }
      const p = await registerProject(o.registryFile, o.id, repoKey(repos.root!.id))
      step('project registration', p.status === 'registered' ? 'done' : 'kept', `project ${o.id} → ${repos.root!.fullName}${repos.devdocs ? ` (+ ${repos.devdocs.fullName})` : ''}`)
    }

    // ---- registration ----
    const reg = await registerWorkspace(o.registryFile, dir, { id: o.workspaceId ?? o.id, label: o.name })
    if (!reg.ok) throw new Error(`registration refused: ${reg.message}`)
    step('registration', reg.status === 'registered' ? 'done' : 'kept', reg.message)
    await rm(marker, { force: true })
    return result(true, `Created ${o.id} in ${dir} and registered it as workspace "${reg.registration!.id}".`, { workspace: reg.registration!.id, diagnostics: reg.diagnostics })
  } catch (e) {
    const done = steps.map(s => s.name).join(', ') || 'nothing'
    steps.push({ name: 'stopped', status: 'failed', detail: (e as Error).message })
    return result(false, `Creation stopped: ${(e as Error).message}. Finished so far: ${done}. Nothing was rolled back; fix the cause and run the same creation with resume.`, { resumable: await exists(marker) })
  }
}
