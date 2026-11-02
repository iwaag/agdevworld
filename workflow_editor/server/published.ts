// Published workflows (improve_wfrun p1, docs/access.md *Published workflows*):
// what a project offers is what its committed default branch on Gitea holds,
// not what a workspace on this host happens to have checked out.
//
// A source is resolved once, to an immutable root commit, from the access
// caches (server/access.ts): the root repository, its default branch and
// commit, the repository and commit devdocs/workflows is read from (the
// root's pin when devdocs is a submodule), and the fetch state. A published
// view is a Workspace whose project.yaml, workflow files and repositories
// come from that commit, so listing, validation and run creation read one
// revision through the same code an editing workspace uses. It is read-only:
// editing happens in a draft (server/drafts.ts), which is this same view with
// one definition's bytes laid over it (`overlaid`), so a draft validates against
// the revision it would be published on and never against a checkout.
//
// Freshness and identity are separate facts. Discovery (the editor list,
// intake routes, notifier targets, delegate targets) may read a cache a few
// seconds old and says so; ordinary execution resolves the default branch
// with a fetch that succeeded, or a revision named explicitly. A source that
// cannot be read is an error, never an empty list and never the workspace.
import { createHash } from 'node:crypto'
import type { DefinitionDescriptor, FileProblem, PeerProject, RepositoryStatus } from '../shared/api.ts'
import { normalizeRepoPath, type Project, type Workflow } from '../shared/model.ts'
import { delegateTargets } from '../shared/validate.ts'
import { gitmodules } from './agdev.ts'
import { AccessError, locate, parseLsTree, type AccessContext, type FetchInfo } from './access.ts'
import { assertWorkspaceAllowed, loadBoundary } from './boundary.ts'
import type { DevdocsInfo } from './devdocs.ts'
import { git } from './git.ts'
import { loadRegistry, observe, type Registration } from './registry.ts'
import { RequestError, Workspace, WORKFLOW_FILE, WORKFLOWS_DIR } from './workspace.ts'
import { parseProject, parseWorkflow } from './yamlDoc.ts'

export const PUBLISHED_SCHEMA = 'ag.wfe-published-source.v1'
export const DESCRIPTOR_SCHEMA = 'ag.wfe-definition-source.v1'
// How old a cache discovery may read without fetching (the editor list,
// intake routes, notifier targets, delegate targets). An integration marks
// the caches it changed as due (access.ts invalidate), so a new workflow is
// not hidden for this long.
export const DISCOVERY_TTL_MS = 30_000
// An open view's check of the default branch (workflow_editor p20): with the
// browser's 3 s poll, a push is seen within about 7 s plus one fetch, inside
// the 10 s the contract promises. Only open views ask.
export const OPEN_VIEW_TTL_MS = 4_000

// The portable identity of a published source: what a run or a delegation
// records. No host paths, no URLs.
export interface PublishedSource {
  schema: typeof PUBLISHED_SCHEMA
  kind: 'published'
  project: string
  selector: 'default-branch' | 'commit'
  repository: string // the root, owner/name on Gitea
  branch: string // its default branch
  commit: string // the root commit everything is read at
  definitions: { path: string; repository: string; commit: string } | null // devdocs/workflows; null when the revision has none
  fetch: FetchInfo
}

export interface Resolved { source: PublishedSource; rootDir: string; defs: { dir: string; commit: string; inner: string } | null; defsProblem?: string }

const isCommit = (s: string) => /^[0-9a-f]{40,64}$/.test(s)

// Resolves a project's published source: its default branch now, or the
// root commit `rev` names. `fresh` (ordinary execution) refuses a default
// branch that could not be fetched now rather than describing a cached
// commit as the latest.
export async function resolvePublished(ctx: AccessContext, project: string, o: { rev?: string; fresh?: boolean } = {}): Promise<PublishedSource> {
  return (await resolve(ctx, project, o)).source
}

export async function resolve(ctx: AccessContext, project: string, o: { rev?: string; fresh?: boolean }): Promise<Resolved> {
  if (project.includes(':')) throw new RequestError(400, 'workflows belong to projects; a repository has none')
  if (o.rev !== undefined && !isCommit(o.rev)) throw new RequestError(400, `"${o.rev}" is not a full commit id; a published revision is named by its root commit`)
  const c: AccessContext = o.fresh && !o.rev ? { ...ctx, refresh: true } : ctx
  let root
  try { root = await locate(c, project, '.', o.rev ? { rev: o.rev } : {}) } catch (e) {
    // A named revision the cache does not have yet: fetch once and look again.
    if (!(o.rev && e instanceof AccessError && e.state === 'absent' && !c.refresh)) throw e
    root = await locate({ ...c, refresh: true }, project, '.', { rev: o.rev })
  }
  if (o.fresh && !o.rev && root.fetch.state === 'stale') {
    throw new AccessError('fetch-failed', `${root.repository.fullName} could not be refreshed from Gitea (${root.fetch.error}); the cache has ${root.commit.slice(0, 10)} from ${root.fetch.at}, which is not known to be the default branch now. Retry, or name that revision explicitly.`, { fetch: root.fetch, cached: root.commit, repository: root.repository.fullName })
  }
  let defs: Resolved['defs'] = null, defsProblem: string | undefined, definitions: PublishedSource['definitions'] = null
  try {
    const l = await locate(c, project, WORKFLOWS_DIR, { rev: root.commit })
    const t = await git(l.dir, ['cat-file', '-t', `${l.commit}:${l.inner}`])
    if (t.code !== 0 || t.stdout.trim() !== 'tree') defsProblem = `${WORKFLOWS_DIR} does not exist at ${root.repository.fullName}@${root.commit.slice(0, 10)}`
    else { defs = { dir: l.dir, commit: l.commit, inner: l.inner }; definitions = { path: WORKFLOWS_DIR, repository: l.repository.fullName, commit: l.commit } }
  } catch (e) {
    if (!(e instanceof AccessError) || e.state === 'fetch-failed') throw e
    defsProblem = e.message
  }
  const fetch = root.fetch
  return {
    source: { schema: PUBLISHED_SCHEMA, kind: 'published', project, selector: o.rev ? 'commit' : 'default-branch', repository: root.repository.fullName, branch: root.repository.defaultBranch, commit: root.commit, definitions, fetch },
    rootDir: root.dir, defs, ...(defsProblem ? { defsProblem } : {}),
  }
}

// Parsed workflow files by repository and commit: a commit never changes,
// so a reading is kept until the table is full.
const parsed = new Map<string, { text: string; workflow?: Workflow; problem?: FileProblem }>()

// A workspace's view of a published source: the same logical workspace (its
// registry id and project), with every read at the resolved commit.
export class PublishedWorkspace extends Workspace {
  readonly source: PublishedSource
  private readonly r: Resolved
  // One definition's bytes in place of the revision's: a draft (p20).
  private readonly overlay?: { file: string; text: string }
  constructor(reg: Registration, r: Resolved, overlay?: { file: string; text: string }) { super(reg); this.r = r; this.source = r.source; this.overlay = overlay }

  // This revision with `file` holding `text`: what validation, approval and a
  // trial read for a draft. Other files, repositories and peers stay the revision's.
  overlaid(file: string, text: string): PublishedWorkspace {
    const o = new PublishedWorkspace(this.reg, this.r, { file, text })
    o.peers = this.peers
    return o
  }
  // Where the definitions and the root are, for the service's publication.
  get located(): Resolved { return this.r }

  private async show(path: string): Promise<string | null> {
    const g = await git(this.r.rootDir, ['show', `${this.r.source.commit}:${path}`])
    return g.code === 0 ? g.stdout : null
  }
  private readOnly(): never {
    throw new RequestError(409, `the published workflows of ${this.r.source.project} (${this.r.source.repository}@${this.r.source.commit.slice(0, 10)}) are read-only; edit them in the workspace and publish`, { code: 'published-read-only' })
  }

  // A commit never changes: each reading is made once per view.
  private memo = new Map<string, Promise<unknown>>()
  private once<T>(key: string, f: () => Promise<T>): Promise<T> {
    if (!this.memo.has(key)) this.memo.set(key, f())
    return this.memo.get(key) as Promise<T>
  }

  override async submodulePaths(): Promise<{ name: string; path: string; url?: string }[]> {
    return this.once('modules', async () => {
      const text = await this.show('.gitmodules')
      return text ? gitmodules(text).map(m => ({ name: m.path, path: m.path, url: m.url })) : []
    })
  }

  override async readProject(): Promise<{ text: string | null; project?: Project; problem?: FileProblem }> {
    return this.once('project', () => this.readProjectNow())
  }
  private async readProjectNow(): Promise<{ text: string | null; project?: Project; problem?: FileProblem }> {
    const text = await this.show('project.yaml')
    if (text === null) return { text, problem: { kind: 'missing', message: `project.yaml does not exist at ${this.r.source.commit.slice(0, 10)}` } }
    const p = parseProject(text)
    return p.ok ? { text, project: p.model } : { text, problem: p.problem }
  }

  // The repositories as the revision records them: the root at the commit,
  // each submodule at its gitlink, devdocs as a directory, declared areas.
  override async repositories(): Promise<RepositoryStatus[]> {
    return structuredClone(await this.once('repositories', () => this.repositoriesNow()))
  }
  private async repositoriesNow(): Promise<RepositoryStatus[]> {
    const { commit, branch } = this.r.source
    const out: RepositoryStatus[] = [{ path: '.', name: 'project root', kind: 'root', category: 'root', initialized: true, head: commit, branch, dirty: 0 }]
    const subs = await this.submodulePaths()
    // Only the paths that matter: submodules, devdocs and declared areas.
    const wanted = [...subs.map(sm => normalizeRepoPath(sm.path) ?? sm.path), 'devdocs', ...((await this.readProject()).project?.areas ?? []).map(a => normalizeRepoPath(a.path) ?? a.path)].filter(p => p && p !== '.')
    const tree = wanted.length ? parseLsTree((await git(this.r.rootDir, ['ls-tree', '-z', commit, '--', ...wanted])).stdout) : []
    for (const sm of subs) {
      const path = normalizeRepoPath(sm.path) ?? sm.path
      const link = tree.find(e => e.path === path && e.type === 'commit')?.object
      out.push({ path, name: path.split('/').pop() ?? path, kind: 'submodule', category: categoryOf(path), url: sm.url, initialized: !!link, dirty: 0, ...(link ? { recorded: link, head: link, matchesRecorded: true } : { error: 'no gitlink at this revision' }) })
    }
    if (!subs.some(sm => normalizeRepoPath(sm.path) === 'devdocs') && tree.some(e => e.path === 'devdocs' && e.type === 'tree')) out.push({ path: 'devdocs', name: 'devdocs', kind: 'directory', category: 'devdocs', initialized: true, dirty: 0 })
    for (const a of (await this.readProject()).project?.areas ?? []) {
      const path = normalizeRepoPath(a.path)
      if (!path || path === '.' || out.some(r => r.path === path)) continue
      out.push({ path, name: path.split('/').pop() ?? path, kind: 'directory', category: categoryOf(path), initialized: tree.some(e => e.path === path && e.type === 'tree'), dirty: 0, description: a.description || undefined })
    }
    return out
  }

  override async devdocs(): Promise<DevdocsInfo> {
    const declaredText = (await this.readProject()).project?.devdocs
    const declared = declaredText === 'directory' || declaredText === 'submodule' ? declaredText : null
    const inModules = (await this.submodulePaths()).some(s => normalizeRepoPath(s.path) === 'devdocs')
    const top = parseLsTree((await git(this.r.rootDir, ['ls-tree', '-z', this.r.source.commit, '--', 'devdocs'])).stdout)[0]
    const observed = inModules ? 'submodule' as const : top ? 'directory' as const : 'missing' as const
    const info: DevdocsInfo = { declared, observed, mode: null, owner: declared === 'submodule' ? 'devdocs' : 'root', ownerDir: '', prefix: declared === 'submodule' ? '' : 'devdocs/' }
    if (!declared) info.problem = { severity: 'error', code: 'devdocs-mode-undeclared', message: 'project.yaml does not declare the devdocs storage mode at this revision' }
    else if ((declared === 'submodule') !== (observed === 'submodule')) info.problem = { severity: 'error', code: 'devdocs-mode-mismatch', message: `project.yaml declares devdocs as a ${declared}, but the revision has it as ${observed === 'missing' ? 'nothing' : `a ${observed}`}` }
    else info.mode = declared
    return info
  }

  override async structure() {
    const read = await this.readProject()
    const info = await this.devdocs()
    const diagnostics = [
      ...(read.problem ? [{ severity: 'error' as const, code: 'project-unreadable', message: `project.yaml: ${read.problem.message}` }] : []),
      ...(info.problem ? [info.problem] : []),
      ...(this.r.defsProblem ? [{ severity: 'warning' as const, code: 'workflows-missing', message: this.r.defsProblem }] : []),
    ]
    return { projectId: read.project?.id || undefined, projectName: read.project?.name || undefined, diagnostics }
  }

  override async workflowsDir(): Promise<{ path: string; exists: boolean; reason?: string }> {
    const d = this.r.source.definitions
    return d ? { path: `${d.repository}@${d.commit.slice(0, 10)}:${WORKFLOWS_DIR}`, exists: true } : { path: WORKFLOWS_DIR, exists: false, reason: this.r.defsProblem ?? `${WORKFLOWS_DIR} does not exist at this revision` }
  }

  override async workflowFiles(): Promise<string[]> {
    const d = this.r.defs
    const files = d ? parseLsTree((await git(d.dir, ['ls-tree', '-z', d.commit, '--', `${d.inner}/`])).stdout)
      .filter(e => e.type === 'blob').map(e => e.path.split('/').pop()!).filter(f => WORKFLOW_FILE.test(f)) : []
    return [...new Set([...files, ...(this.overlay ? [this.overlay.file] : [])])].sort()
  }

  override async readWorkflowFile(file: string): Promise<{ text: string | null; workflow?: Workflow; problem?: FileProblem }> {
    if (!WORKFLOW_FILE.test(file)) throw new RequestError(400, `invalid workflow file name "${file}"`)
    if (this.overlay?.file === file) {
      const p = parseWorkflow(this.overlay.text)
      return p.ok ? { text: this.overlay.text, workflow: p.model } : { text: this.overlay.text, problem: p.problem }
    }
    const d = this.r.defs
    if (!d) return { text: null, problem: { kind: 'missing', message: this.r.defsProblem ?? `${WORKFLOWS_DIR} does not exist` } }
    const key = `${d.dir}@${d.commit}:${file}`
    const hit = parsed.get(key)
    if (hit) return { text: hit.text, problem: hit.problem, workflow: hit.workflow && structuredClone(hit.workflow) }
    const g = await git(d.dir, ['show', `${d.commit}:${d.inner}/${file}`])
    if (g.code !== 0) return { text: null, problem: { kind: 'missing', message: `${file} does not exist at ${this.r.source.definitions!.repository}@${d.commit.slice(0, 10)}` } }
    const p = parseWorkflow(g.stdout)
    const reading = p.ok ? { text: g.stdout, workflow: p.model } : { text: g.stdout, problem: p.problem }
    if (parsed.size > 4000) parsed.clear()
    parsed.set(key, { ...reading, workflow: reading.workflow && structuredClone(reading.workflow) })
    return reading
  }

  override async saveProject(): Promise<never> { this.readOnly() }
  override async createWorkflow(): Promise<never> { this.readOnly() }
  override async saveWorkflow(): Promise<never> { this.readOnly() }
  override async approve(): Promise<never> { this.readOnly() }
  override async addSubmodule(): Promise<never> { this.readOnly() }
}

function categoryOf(path: string): RepositoryStatus['category'] {
  return path === 'devdocs' ? 'devdocs' : path === 'study' || path.startsWith('study/') ? 'study' : path === 'wedo' || path.startsWith('wedo/') ? 'wedo' : 'other'
}

// The published view for a registered workspace (or, for a project without
// one here, a registration naming only the project). Its peers — the
// other projects' delegate targets — are published too.
// `discovery`: a cache up to DISCOVERY_TTL_MS old is read without fetching.
// `ttlMs`: this one resolution's cache age (an open view's), peers keeping their own.
export async function publishedWorkspace(ctx: AccessContext, reg: Registration, o: { rev?: string; fresh?: boolean; discovery?: boolean; ttlMs?: number } = {}): Promise<PublishedWorkspace> {
  if (!reg.project) throw new RequestError(409, `workspace ${reg.id} names no registered project, so it has no published workflows`)
  const c: AccessContext = o.ttlMs !== undefined ? { ...ctx, fetchTtlMs: o.ttlMs } : o.discovery ? { ...ctx, fetchTtlMs: ctx.fetchTtlMs ?? DISCOVERY_TTL_MS } : ctx
  const ws = new PublishedWorkspace(reg, await resolve(c, reg.project, o))
  ws.peers = () => publishedPeers(ctx, reg.project)
  return ws
}

// The head of a project's published source for an open view: at most one
// reading per project at a time, however many views ask (p20; the earlier
// intake delays came from readings per caller).
const heads = new Map<string, Promise<PublishedSource>>()
export function publishedHead(ctx: AccessContext, project: string, o: { refresh?: boolean } = {}): Promise<PublishedSource> {
  const key = `${ctx.registryFile}\0${project}\0${o.refresh ? 'r' : ''}`
  const hit = heads.get(key)
  if (hit) return hit
  const p = resolvePublished({ ...ctx, fetchTtlMs: OPEN_VIEW_TTL_MS, refresh: o.refresh }, project).finally(() => heads.delete(key))
  heads.set(key, p)
  return p
}

export const digestOf = (text: string) => createHash('sha256').update(text).digest('hex')

// What a definition reading is, whichever its kind (docs/drafts.md): the
// project, the workflow, the repository and path its bytes are at, the
// revision of that repository, the project root's revision apart, and the digest.
export function publishedDescriptor(s: PublishedSource, file: string, workflow: string | null, text: string | null): DefinitionDescriptor {
  return {
    schema: DESCRIPTOR_SCHEMA, kind: 'published', project: s.project, workflow, file,
    definition: s.definitions ? { repository: s.definitions.repository, path: `${s.definitions.path}/${file}`, revision: s.definitions.commit } : null,
    root: { repository: s.repository, branch: s.branch, commit: s.commit },
    digest: text === null ? null : digestOf(text), fetch: s.fetch,
  }
}

// What a request needs to know about one published workflow before
// delegating to it or posting to it: it exists at the revision, validates,
// and accepts requests. Readiness of its channel is the notifier's (a
// separate fact the caller adds).
export interface PublishedWorkflow { id?: string; file: string; name?: string; errors: number; warnings: number; intake: boolean; delegates: string[]; problem?: string }
export interface PublishedList { source: PublishedSource; workspace: string | null; workflows: PublishedWorkflow[]; problem?: string }

export async function publishedWorkflows(ctx: AccessContext, project: string, o: { rev?: string; fresh?: boolean } = {}): Promise<PublishedList> {
  const reg = await loadRegistry(ctx.registryFile)
  const wsReg = reg.workspaces.find(w => w.project === project)
  const ws = await publishedWorkspace(ctx, wsReg ?? { id: project, label: project, host: '', path: '', project }, o)
  const { list, dir } = await ws.workflowSummaries()
  return {
    source: ws.source, workspace: wsReg?.id ?? null, ...(dir.exists ? {} : { problem: dir.reason }),
    workflows: list.map(s => ({ file: s.file, ...(s.id ? { id: s.id } : {}), ...(s.name ? { name: s.name } : {}), errors: s.errors, warnings: s.warnings, intake: !!s.intake, delegates: s.delegates, ...(s.problem ? { problem: s.problem.message } : {}) })),
  }
}

// The other registered projects' published workflows (delegate targets): a
// project is offered when it has an allowed, available workspace here — the
// child's run copy lives there — and its source can be read. A project whose
// source cannot be read is left out of the list; dispatch says why.
// Several validations in one pass ask for the same peers: one reading of
// every project is kept for a few seconds per registry, each caller gets it
// without its own project (improve_wfrun p1: a reading per validation made
// the intake pass exceed its time).
const peerMemo = new Map<string, { at: number; peers: Promise<PeerProject[]> }>()
const PEER_MEMO_MS = 5_000
export async function publishedPeers(ctx: AccessContext, self?: string): Promise<PeerProject[]> {
  const key = `${ctx.registryFile}\0${ctx.fetchTtlMs ?? ''}`
  let hit = peerMemo.get(key)
  if (!hit || Date.now() - hit.at >= PEER_MEMO_MS || ctx.refresh) {
    const peers = readPeers(ctx)
    hit = { at: Date.now(), peers }
    peerMemo.set(key, hit)
    peers.catch(() => peerMemo.delete(key))
  }
  return (await hit.peers).filter(p => p.project !== self)
}
// A peer's workflows need only their identity, delegate targets and intake:
// parsed, not validated.
async function readPeers(ctx: AccessContext): Promise<PeerProject[]> {
  const reg = await loadRegistry(ctx.registryFile)
  const boundary = await loadBoundary(ctx.registryFile, ctx.area)
  const c: AccessContext = { ...ctx, fetchTtlMs: ctx.fetchTtlMs ?? DISCOVERY_TTL_MS }
  const seen = new Set<string>()
  const out = await Promise.all(reg.workspaces.map(async (w): Promise<PeerProject | null> => {
    if (!w.project || seen.has(w.project)) return null
    seen.add(w.project)
    try { await assertWorkspaceAllowed(boundary, w, 'Delegation') } catch { return null }
    if (!(await observe(w)).available) return null
    const ws = await resolve(c, w.project, {}).then(r => new PublishedWorkspace(w, r), () => null)
    if (!ws) return null
    const workflows: PeerProject['workflows'] = []
    for (const f of await ws.workflowFiles().catch(() => [])) {
      const r = await ws.readWorkflowFile(f)
      if (r.workflow) workflows.push({ id: r.workflow.id, name: r.workflow.name, file: f, delegates: delegateTargets(r.workflow, w.project), intake: r.workflow.intake.zulip === 'requests' })
    }
    return { project: w.project, workspace: w.id, label: w.label, workflows }
  }))
  return out.filter((p): p is PeerProject => !!p).sort((a, b) => (a.project < b.project ? -1 : 1))
}

// Every published workflow's delegate targets, as <project>/<workflow>
// keys, for the cycle check at dispatch. A project whose source cannot be
// read contributes nothing and is named in `unread`.
export async function publishedGraph(ctx: AccessContext): Promise<{ graph: Map<string, string[]>; unread: string[] }> {
  const reg = await loadRegistry(ctx.registryFile)
  const graph = new Map<string, string[]>()
  const unread: string[] = []
  const c: AccessContext = { ...ctx, fetchTtlMs: ctx.fetchTtlMs ?? DISCOVERY_TTL_MS }
  for (const p of reg.projects) {
    try {
      const ws = new PublishedWorkspace({ id: p.id, label: p.id, host: '', path: '', project: p.id }, await resolve(c, p.id, {}))
      for (const f of await ws.workflowFiles()) {
        const r = await ws.readWorkflowFile(f)
        if (r.workflow) graph.set(`${p.id}/${r.workflow.id}`, delegateTargets(r.workflow, p.id).map(t => (t.includes('/') ? t : `${p.id}/${t}`)))
      }
    } catch (e) { unread.push(`${p.id}: ${(e as Error).message}`) }
  }
  return { graph, unread }
}
