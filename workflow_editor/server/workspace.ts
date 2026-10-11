// One registered workspace: Git inspection, project metadata, workflow
// discovery, creation and saving. All paths are bounded to the workspace root.
import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { approvalStates, type ApprovalState } from '../shared/canonical.ts'
import {
  ID_PATTERN, emptyWorkflow, normalizeRepoPath, PROJECT_SCHEMA,
  type ApprovalKind, type Project, type Workflow,
} from '../shared/model.ts'
import { delegateTargets, hasErrors, validateProject, validateWorkflow, type ValidationContext } from '../shared/validate.ts'
import type {
  AddSubmoduleResponse, Diagnostic, FileProblem, ProjectResponse, RepoCategory, RepositoryStatus,
  WorkflowResponse, WorkflowSummary,
} from '../shared/api.ts'
import { atomicWrite, createExclusive, inside, readTextOrNull, textHash } from './files.ts'
import { git, LOCAL_TRANSPORT } from './git.ts'
import type { Registration } from './registry.ts'
import { devdocsInfo, type DevdocsInfo } from './devdocs.ts'
import { newProjectText, newWorkflowText, parseProject, parseWorkflow, renderProject, renderWorkflow } from './yamlDoc.ts'

export const WORKFLOWS_DIR = 'devdocs/workflows'
const readCache = new Map<string, { sig: string; text: string; workflow?: Workflow; problem?: FileProblem }>()
export const WORKFLOW_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/

export class RequestError extends Error {
  status: number
  detail?: unknown
  constructor(status: number, message: string, detail?: unknown) {
    super(message); this.status = status; this.detail = detail
  }
}

function categoryOf(path: string): RepoCategory {
  if (path === '.') return 'root'
  if (path === 'devdocs') return 'devdocs'
  if (path.startsWith('study/')) return 'study'
  if (path.startsWith('wedo/')) return 'wedo'
  return 'other'
}

// Local commits that no remote-tracking ref contains (as last fetched; no
// network read), and the branch's upstream when it has one. A detached
// submodule checkout is published when some remote branch contains it.
async function publication(dir: string): Promise<RepositoryStatus['publication']> {
  const up = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  const ahead = await git(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])
  const behind = up.code === 0 ? await git(dir, ['rev-list', '--count', 'HEAD..@{upstream}']) : null
  return { upstream: up.code === 0 ? up.stdout.trim() : null, ahead: Number(ahead.stdout.trim()) || 0, behind: Number(behind?.stdout.trim()) || 0 }
}

async function isDir(p: string) { try { return (await stat(p)).isDirectory() } catch { return false } }

export class Workspace {
  readonly reg: Registration
  // Set by the service when the watcher vouches that Git state has not
  // changed since these were inspected; repositories() then reuses them.
  knownRepositories?: RepositoryStatus[]
  constructor(reg: Registration) { this.reg = reg }
  get root() { return this.reg.path }

  // ---- Git inspection -------------------------------------------------

  async submodulePaths(): Promise<{ name: string; path: string; url?: string }[]> {
    const r = await git(this.root, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url)$'])
    if (r.code !== 0) return [] // no .gitmodules, or no entries
    const byName = new Map<string, { name: string; path?: string; url?: string }>()
    for (const line of r.stdout.split('\n')) {
      const m = /^submodule\.(.+)\.(path|url) (.*)$/.exec(line)
      if (!m) continue
      const entry = byName.get(m[1]) ?? { name: m[1] }
      entry[m[2] as 'path' | 'url'] = m[3]
      byName.set(m[1], entry)
    }
    return [...byName.values()].filter((e): e is { name: string; path: string; url?: string } => !!e.path)
  }

  async repositories(): Promise<RepositoryStatus[]> {
    if (this.knownRepositories) return this.knownRepositories
    const rootHead = await git(this.root, ['rev-parse', 'HEAD'])
    const rootBranch = await git(this.root, ['symbolic-ref', '-q', '--short', 'HEAD'])
    const rootDirty = await git(this.root, ['status', '--porcelain=v1', '--ignore-submodules=all'])
    const rootUrl = await git(this.root, ['config', '--get', 'remote.origin.url'])
    const out: RepositoryStatus[] = [{
      path: '.', name: 'project root', kind: 'root', category: 'root', initialized: true,
      url: rootUrl.code === 0 ? rootUrl.stdout.trim() : undefined,
      head: rootHead.code === 0 ? rootHead.stdout.trim() : undefined,
      branch: rootBranch.code === 0 ? rootBranch.stdout.trim() : null,
      dirty: rootDirty.code === 0 ? rootDirty.stdout.split('\n').filter(Boolean).length : 0,
      publication: await publication(this.root),
    }]
    const subs = await this.submodulePaths()
    const inspected = await Promise.all(subs.map(sm => this.inspectSubmodule(sm)))
    // Directory mode: devdocs is a resource of the project, kept in the root
    // repository; it is not an independent repository.
    if (!subs.some(sm => normalizeRepoPath(sm.path) === 'devdocs')) {
      const dir = join(this.root, 'devdocs')
      if (await isDir(dir)) {
        const dirty = await git(this.root, ['status', '--porcelain=v1', '--', 'devdocs'])
        out.push({ path: 'devdocs', name: 'devdocs', kind: 'directory', category: 'devdocs', initialized: true, dirty: dirty.code === 0 ? dirty.stdout.split('\n').filter(Boolean).length : 0 })
      }
    }
    return [...out, ...inspected]
  }

  // The devdocs storage mode as declared and as Git shows it, and the
  // repository that owns devdocs (server/devdocs.ts).
  async devdocs(): Promise<DevdocsInfo> {
    const read = await this.readProject().catch(() => ({ project: undefined }))
    return devdocsInfo(this.root, read.project?.devdocs, (await this.submodulePaths()).map(s => s.path))
  }

  private async inspectSubmodule(sm: { path: string; url?: string }): Promise<RepositoryStatus> {
    const path = normalizeRepoPath(sm.path) ?? sm.path
    const status: RepositoryStatus = {
      path, name: path.split('/').pop() ?? path, kind: 'submodule', category: categoryOf(path),
      url: sm.url, initialized: false, dirty: 0,
    }
    const tree = await git(this.root, ['ls-tree', 'HEAD', '--', path])
    const treeMatch = /^160000 commit ([0-9a-f]+)\t/.exec(tree.stdout)
    if (treeMatch) status.recorded = treeMatch[1]
    const index = await git(this.root, ['ls-files', '--stage', '--', path])
    const indexMatch = /^160000 ([0-9a-f]+) \d\t/.exec(index.stdout)
    if (indexMatch && indexMatch[1] !== status.recorded) status.staged = indexMatch[1]
    try {
      const dir = await inside(this.root, path)
      // Initialized = the path is its own Git work tree: it has a .git entry
      // and Git reports it, not the project root, as the top level.
      const top = await git(dir, ['rev-parse', '--show-toplevel'])
      const hasGit = await stat(join(dir, '.git')).then(() => true, () => false)
      if (hasGit && top.code === 0 && top.stdout.trim() === await realpath(dir)) {
        status.initialized = true
        const head = await git(dir, ['rev-parse', 'HEAD'])
        if (head.code === 0) status.head = head.stdout.trim()
        const branch = await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'])
        status.branch = branch.code === 0 ? branch.stdout.trim() : null
        const dirty = await git(dir, ['status', '--porcelain=v1'])
        status.dirty = dirty.stdout.split('\n').filter(Boolean).length
        status.publication = await publication(dir)
        const expected = status.staged ?? status.recorded
        if (status.head && expected) status.matchesRecorded = status.head === expected
      }
    } catch (e) {
      status.error = (e as Error).message
    }
    return status
  }

  // What this project root lacks, each with the action that fixes it.
  async structure(): Promise<{ projectId?: string; projectName?: string; diagnostics: Diagnostic[] }> {
    const root = this.root
    const out: Diagnostic[] = []
    let projectId: string | undefined, projectName: string | undefined
    const text = await readTextOrNull(join(root, 'project.yaml')).catch(() => null)
    if (text === null) {
      out.push({ severity: 'error', code: 'project-missing', message: 'project.yaml does not exist', fix: 'Write project.yaml (schema ag.project.v1, see docs/contract.md), or use "Create project.yaml" in the project view.' })
    } else {
      const parsed = parseProject(text)
      if (!parsed.ok) {
        out.push({ severity: 'error', code: 'project-unreadable', message: `project.yaml: ${parsed.problem.message}${'line' in parsed.problem && parsed.problem.line ? ` (line ${parsed.problem.line})` : ''}`, fix: 'Fix the YAML by hand.' })
      } else {
        projectId = parsed.model.id || undefined
        projectName = parsed.model.name || undefined
        // The storage mode is diagnosed below with what Git shows.
        for (const i of validateProject(parsed.model).filter(i => i.code !== 'devdocs-mode')) out.push({ severity: 'warning', code: `project-${i.code}`, message: `project.yaml: ${i.message}`, fix: 'Edit project.yaml or the project view.' })
      }
    }
    const ignore = await readTextOrNull(join(root, '.gitignore')).catch(() => null)
    if (!ignore || !ignore.split('\n').some(l => /^\/?\.local\/?\s*$/.test(l))) {
      out.push({ severity: 'warning', code: 'gitignore-local', message: '.gitignore does not ignore .local/', fix: 'Add the line ".local/" to .gitignore.' })
    }
    const info = await this.devdocs()
    if (info.problem) out.push(info.problem)
    if (info.observed === 'missing' && info.declared !== 'submodule') {
      out.push({ severity: 'error', code: 'devdocs-missing', message: 'devdocs/ does not exist', fix: 'Create the directory devdocs/workflows/ in the project root.' })
    } else {
      const dir = await this.workflowsDir()
      if (!dir.exists && dir.reason === 'devdocs submodule is not initialized') {
        out.push({ severity: 'error', code: 'devdocs-uninitialized', message: 'devdocs is not checked out in this workspace', fix: 'git submodule update --init devdocs' })
      } else if (!dir.exists && info.observed !== 'missing') {
        out.push({ severity: 'warning', code: 'workflows-missing', message: 'devdocs/workflows/ does not exist yet', fix: 'Create the directory devdocs/workflows/.' })
      }
    }
    // The p3 layout kept runs at devdocs/<workflow>/runs/. It is not read or
    // converted; its presence is said, so runs do not seem to have vanished.
    const devdocsDir = join(root, 'devdocs')
    const old = (await readdir(devdocsDir, { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory() && d.name !== 'runs' && d.name !== 'workflows' && ID_PATTERN.test(d.name))
    const legacy: string[] = []
    for (const d of old) if (await isDir(join(devdocsDir, d.name, 'runs'))) legacy.push(`devdocs/${d.name}/runs/`)
    if (legacy.length) out.push({ severity: 'warning', code: 'runs-old-layout', message: `${legacy.join(', ')} use${legacy.length === 1 ? 's' : ''} the old run layout, which is not supported; those runs are not listed`, fix: 'Runs live in devdocs/runs/<workflow>/<run>/. Old runs are not converted; keep them as history or remove them by hand.' })
    return { projectId, projectName, diagnostics: out }
  }

  // ---- project.yaml ---------------------------------------------------

  async readProject(): Promise<{ text: string | null; project?: Project; problem?: FileProblem }> {
    const text = await readTextOrNull(await inside(this.root, 'project.yaml'))
    if (text === null) return { text, problem: { kind: 'missing', message: 'project.yaml does not exist' } }
    const parsed = parseProject(text)
    if (!parsed.ok) return { text, problem: parsed.problem }
    return { text, project: parsed.model }
  }

  async projectResponse(): Promise<ProjectResponse> {
    const repositories = await this.repositories()
    const [read, wf, structure] = await Promise.all([this.readProject(), this.workflowSummaries(repositories), this.structure()])
    return {
      workspace: this.reg.id,
      rev: read.text === null ? null : textHash(read.text),
      project: read.project, problem: read.problem,
      issues: read.project ? validateProject(read.project) : [],
      repositories, workflows: wf.list, workflowsDir: wf.dir, structure: structure.diagnostics,
    }
  }

  async saveProject(project: Project): Promise<{ rev: string; text: string }> {
    const path = await inside(this.root, 'project.yaml')
    const current = await readTextOrNull(path)
    let text: string
    if (current === null) {
      text = newProjectText({ ...project, schema: project.schema || PROJECT_SCHEMA })
    } else {
      const parsed = parseProject(current)
      if (!parsed.ok) throw new RequestError(409, `project.yaml on disk cannot be read (${parsed.problem.message}); fix the file before saving from the editor`, parsed.problem)
      text = renderProject(parsed.doc, project)
      if (text === current) return { rev: textHash(text), text }
    }
    await atomicWrite(path, text)
    return { rev: textHash(text), text }
  }

  // ---- workflows ------------------------------------------------------

  async workflowsDir(): Promise<{ path: string; exists: boolean; reason?: string }> {
    const path = await inside(this.root, WORKFLOWS_DIR)
    if (await isDir(path)) return { path, exists: true }
    const devdocs = await inside(this.root, 'devdocs')
    const submodule = (await this.submodulePaths()).some(s => normalizeRepoPath(s.path) === 'devdocs')
    const reason = !(await isDir(devdocs)) ? 'devdocs is missing'
      : submodule && !(await stat(join(devdocs, '.git')).then(() => true, () => false)) ? 'devdocs submodule is not initialized'
        : `${WORKFLOWS_DIR} does not exist yet`
    return { path, exists: false, reason }
  }

  async workflowFiles(): Promise<string[]> {
    const dir = await this.workflowsDir()
    if (!dir.exists) return []
    return (await readdir(dir.path)).filter(f => WORKFLOW_FILE.test(f)).sort()
  }

  async readWorkflowFile(file: string): Promise<{ text: string | null; workflow?: Workflow; problem?: FileProblem }> {
    if (!WORKFLOW_FILE.test(file)) throw new RequestError(400, `invalid workflow file name "${file}"`)
    const path = await inside(this.root, `${WORKFLOWS_DIR}/${file}`)
    // Parsing every workflow on every refresh dominated large projects; an
    // unchanged file (same size, mtime and inode) reuses its last reading.
    const st = await stat(path).catch(() => null)
    const sig = st ? `${st.size}:${st.mtimeMs}:${st.ino}` : null
    const hit = sig ? readCache.get(path) : undefined
    if (hit && hit.sig === sig) return { text: hit.text, problem: hit.problem, workflow: hit.workflow && structuredClone(hit.workflow) }
    const text = await readTextOrNull(path)
    if (text === null) { readCache.delete(path); return { text, problem: { kind: 'missing', message: `${file} does not exist` } } }
    const parsed = parseWorkflow(text)
    const reading = parsed.ok ? { text, workflow: parsed.model } : { text, problem: parsed.problem }
    if (sig) {
      if (readCache.size > 2000) readCache.clear()
      readCache.set(path, { sig, ...reading, workflow: reading.workflow && structuredClone(reading.workflow) })
    }
    return reading
  }

  async workflowSummaries(repos?: RepositoryStatus[]): Promise<{ list: WorkflowSummary[]; dir: { exists: boolean; reason?: string } }> {
    const dir = await this.workflowsDir()
    const files = await this.workflowFiles()
    const reads = await Promise.all(files.map(async f => ({ file: f, ...(await this.readWorkflowFile(f)) })))
    const refs = reads.filter(r => r.workflow).map(r => ({ id: r.workflow!.id, file: r.file, delegates: delegateTargets(r.workflow!) }))
    const repositories = repos ?? await this.repositories()
    const list: WorkflowSummary[] = []
    for (const r of reads) {
      if (!r.workflow) { list.push({ file: r.file, problem: r.problem, errors: 1, warnings: 0, delegates: [] }); continue }
      const issues = validateWorkflow(r.workflow, { repositories, workflows: refs, file: r.file })
      const states = await approvalStates(r.workflow)
      list.push({
        file: r.file, id: r.workflow.id, name: r.workflow.name,
        errors: issues.filter(i => i.severity === 'error').length,
        warnings: issues.filter(i => i.severity === 'warning').length,
        approvals: { intent: states.intent.status, definition: states.definition.status },
        delegates: delegateTargets(r.workflow),
      })
    }
    return { list, dir: { exists: dir.exists, reason: dir.reason } }
  }

  async validationContext(file: string, repositories: RepositoryStatus[]): Promise<ValidationContext> {
    const { list } = await this.workflowSummaries(repositories)
    return {
      repositories,
      workflows: list.filter(s => s.id).map(s => ({ id: s.id!, file: s.file, delegates: s.delegates })),
      file,
    }
  }

  async workflowResponse(file: string): Promise<WorkflowResponse> {
    const repositories = await this.repositories()
    const [read, summaries] = await Promise.all([this.readWorkflowFile(file), this.workflowSummaries(repositories)])
    const ctx: ValidationContext = {
      repositories,
      workflows: summaries.list.filter(s => s.id).map(s => ({ id: s.id!, file: s.file, delegates: s.delegates })),
      file,
    }
    return {
      workspace: this.reg.id, file,
      rev: read.text === null ? null : textHash(read.text), text: read.text,
      workflow: read.workflow, problem: read.problem,
      issues: read.workflow ? validateWorkflow(read.workflow, ctx) : [],
      approvals: read.workflow ? await approvalStates(read.workflow) : undefined,
      repositories, workflows: summaries.list,
    }
  }

  async createWorkflow(id: string, name: string): Promise<{ file: string }> {
    if (!ID_PATTERN.test(id)) throw new RequestError(400, `workflow id must match ${ID_PATTERN.source}`)
    const dir = await this.workflowsDir()
    if (!dir.exists) throw new RequestError(409, `cannot create a workflow: ${dir.reason}`)
    const { list } = await this.workflowSummaries()
    const clash = list.find(s => s.id === id)
    if (clash) throw new RequestError(409, `workflow id "${id}" is already used by ${clash.file}`)
    const file = `${id}.yaml`
    const target = await inside(this.root, `${WORKFLOWS_DIR}/${file}`)
    try {
      await createExclusive(target, newWorkflowText(emptyWorkflow(id, name)))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new RequestError(409, `${file} already exists`)
      throw e
    }
    return { file }
  }

  // Saves a draft. Refuses to write over a file that is currently malformed or
  // unsupported: the stale rendering in the UI must not replace it.
  async saveWorkflow(file: string, workflow: Workflow): Promise<{ rev: string; text: string }> {
    const read = await this.readWorkflowFile(file)
    if (read.text === null) throw new RequestError(409, `${file} no longer exists; create it again or restore it`)
    const parsed = parseWorkflow(read.text)
    if (!parsed.ok) throw new RequestError(409, `${file} on disk cannot be read (${parsed.problem.message}); fix the file before saving from the editor`, parsed.problem)
    const text = renderWorkflow(parsed.doc, workflow)
    if (text === read.text) return { rev: textHash(text), text }
    await atomicWrite(await inside(this.root, `${WORKFLOWS_DIR}/${file}`), text)
    return { rev: textHash(text), text }
  }

  // Records an approval of the saved content. Definition approval requires
  // content without validation errors; intent approval requires an intent.
  async approve(file: string, kind: ApprovalKind, approver: string, now = new Date()): Promise<{ rev: string; text: string; state: ApprovalState }> {
    if (!approver.trim()) throw new RequestError(400, 'an approver name is required')
    const read = await this.readWorkflowFile(file)
    if (!read.workflow || read.text === null) throw new RequestError(409, `${file} cannot be approved: ${read.problem?.message ?? 'unreadable'}`)
    const repositories = await this.repositories()
    const issues = validateWorkflow(read.workflow, await this.validationContext(file, repositories))
    if (kind === 'intent' && issues.some(i => i.code === 'intent-missing')) throw new RequestError(409, 'the intent is empty')
    if (kind === 'definition' && hasErrors(issues)) {
      throw new RequestError(409, 'the saved definition has validation errors', issues.filter(i => i.severity === 'error'))
    }
    const states = await approvalStates(read.workflow)
    const next = structuredClone(read.workflow)
    next.approvals[kind] = { digest: states[kind].digest, approver: approver.trim(), at: now.toISOString() }
    const saved = await this.saveWorkflow(file, next)
    return { ...saved, state: (await approvalStates(next))[kind] }
  }

  // ---- submodules -----------------------------------------------------

  async addSubmodule(rawPath: string, url: string, env: Record<string, string> = {}): Promise<AddSubmoduleResponse> {
    const path = normalizeRepoPath(rawPath)
    if (!path || path === '.') throw new RequestError(400, `"${rawPath}" is not a project-relative path`)
    if (!url.trim()) throw new RequestError(400, 'a repository location is required')
    if (/^-/.test(url) || /^-/.test(path)) throw new RequestError(400, 'locations and paths may not start with "-"')
    const existing = await this.submodulePaths()
    if (existing.some(s => normalizeRepoPath(s.path) === path)) throw new RequestError(409, `${path} is already a submodule`)
    const target = await inside(this.root, path) // bounds check before Git touches anything
    if (await stat(target).then(() => true, () => false)) throw new RequestError(409, `${path} already exists in the workspace; choose another path (nothing was changed)`)
    // Local sources need file transport, which Git disables for submodules by
    // default. Enable it for this one command when the source is local.
    const local = (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !env.GIT_CONFIG_COUNT) || url.startsWith('file://')
    const r = await git(this.root, ['submodule', 'add', '--', url.trim(), path], { config: local ? LOCAL_TRANSPORT : {}, env, timeoutMs: 120_000 })
    if (r.code === 0) return { ok: true, message: `Added ${path}. The change is staged in the project root; commit it when ready.`, stderr: r.stderr.trim() || undefined }
    const after = await this.submodulePaths()
    const staged = await git(this.root, ['ls-files', '--stage', '--', path])
    const pathAbs = await inside(this.root, path)
    const gitDir = await git(this.root, ['rev-parse', '--git-path', `modules/${path}`])
    return {
      ok: false,
      message: `git submodule add failed (exit ${r.code}). Nothing was reset; the state below is what Git left.`,
      stderr: r.stderr.trim(),
      partial: {
        gitmodulesEntry: after.some(s => normalizeRepoPath(s.path) === path),
        pathExists: await stat(pathAbs).then(() => true, () => false),
        staged: staged.stdout.trim() !== '',
        gitDirExists: gitDir.code === 0 && await isDir(join(this.root, gitDir.stdout.trim())),
      },
    }
  }
}
