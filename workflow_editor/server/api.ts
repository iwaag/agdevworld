// HTTP routes of the local service. JSON in, JSON out; the UI is one client.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, normalize, sep } from 'node:path'
import type { RepositoryStatus, WorkspaceSummary, WorkspacesResponse } from '../shared/api.ts'
import { APPROVAL_KINDS, type ApprovalKind, type Project, type Workflow } from '../shared/model.ts'
import { addNewRepository, createProject } from './create.ts'
import { addSharedRepository, createSharedRepository, dashboard, obtainWorkspace, registerGiteaProject, registerSharedRepository, type AgdevContext } from './agdev.ts'
import type { Gitea } from './gitea.ts'
import type { ExecStore } from './exec.ts'
import { REPO_CATEGORIES, type RepoCategory } from './registry.ts'
import { BoundaryError, inside } from './files.ts'
import { loadRegistry, observe, registerWorkspace, RegistryError, type Registry } from './registry.ts'
import { listRuns, readRunFile, runOp, runResponse } from './runs.ts'
import { OPS, type OpInput, type RunRef } from '../shared/run.ts'
import type { Watcher } from './watch.ts'
import { codeVersion } from './version.ts'
import { assertNotRetired, assertWorkspaceAllowed, loadBoundary, retiredByUrl } from './boundary.ts'
import { RequestError, Workspace } from './workspace.ts'

export interface ServiceConfig {
  registryFile: string
  // The authoring area: browser-created projects go beneath it and new
  // devdocs sources into its sources/. Defaults to the registry's directory.
  area?: string
  allowedOrigins: string[]
  allowedHosts: string[]
  distDir?: string // serve the built UI from the same origin
  watcher?: Watcher
  gitea?: Gitea
  giteaProblem?: string
  exec?: ExecStore // this host's execution management (queue, attempts, publication)
}

// Requests forwarded by agdevworld's same-origin route carry this header
// (set by its nginx). Through that route the service offers the agdev and
// editor operations, but no operation that takes an arbitrary host path or
// repository location: those stay with local processes (the CLI).
export const ROUTE_HEADER = 'x-wfe-route'

const MAX_BODY = 2 * 1024 * 1024

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function body(req: IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type'] ?? ''
  if (!type.startsWith('application/json')) throw new RequestError(415, 'writes require content-type: application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new RequestError(413, 'request body too large')
    chunks.push(chunk as Buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new RequestError(400, 'invalid JSON body') }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Minimal structural check of a model sent by a client. Validation of content
// happens in shared/validate.ts; this only keeps wrong types out of the YAML.
function asWorkflow(v: unknown): Workflow {
  if (!isObj(v) || !isObj(v.repositories) || !isObj(v.nodes) || !Array.isArray(v.edges) || !isObj(v.approvals) || !isObj(v.layout) || !isObj((v.layout as Record<string, unknown>).nodes)) {
    throw new RequestError(400, 'body.workflow is not a workflow model')
  }
  for (const k of ['schema', 'id', 'name', 'intent']) if (typeof v[k] !== 'string') throw new RequestError(400, `workflow.${k} must be text`)
  for (const [id, n] of Object.entries(v.nodes)) {
    if (!isObj(n) || typeof n.type !== 'string' || typeof n.description !== 'string' || typeof n.name !== 'string' ||
      !Array.isArray(n.repositories) || !n.repositories.every(r => typeof r === 'string') ||
      (n.workflow !== undefined && typeof n.workflow !== 'string')) throw new RequestError(400, `workflow.nodes.${id} is malformed`)
  }
  for (const [k, b] of Object.entries(v.repositories)) {
    if (!isObj(b) || typeof b.path !== 'string' || typeof b.access !== 'string') throw new RequestError(400, `workflow.repositories.${k} is malformed`)
  }
  for (const e of v.edges) if (!isObj(e) || typeof e.from !== 'string' || typeof e.to !== 'string') throw new RequestError(400, 'workflow.edges is malformed')
  for (const [k, p] of Object.entries((v.layout as Record<string, Record<string, unknown>>).nodes)) {
    if (!isObj(p) || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new RequestError(400, `workflow.layout.nodes.${k} is malformed`)
  }
  return v as unknown as Workflow
}

function asProject(v: unknown): Project {
  if (!isObj(v)) throw new RequestError(400, 'body.project is not a project model')
  for (const k of ['schema', 'id', 'name', 'intent']) if (typeof v[k] !== 'string') throw new RequestError(400, `project.${k} must be text`)
  if (!Array.isArray(v.goals) || !v.goals.every(g => typeof g === 'string')) throw new RequestError(400, 'project.goals must be a list of text')
  return v as unknown as Project
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png',
}

export function createHandler(config: ServiceConfig) {
  async function registry(): Promise<Registry> { return loadRegistry(config.registryFile) }
  const area = config.area ?? dirname(config.registryFile)
  const texts = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string')

  const agdev: AgdevContext = { registryFile: config.registryFile, area, gitea: config.gitea, giteaProblem: config.giteaProblem, executor: config.exec ? async () => config.exec!.executorState() : undefined }
  const needExec = () => { if (!config.exec) throw new RequestError(503, 'execution is not configured on this service'); return config.exec }
  const str = (v: unknown, what: string) => { if (typeof v !== 'string' || !v.trim()) throw new RequestError(400, `${what} is required`); return v.trim() }
  const category = (v: unknown): RepoCategory => { if (!REPO_CATEGORIES.includes(v as RepoCategory)) throw new RequestError(400, `category must be one of ${REPO_CATEGORIES.join(', ')}`); return v as RepoCategory }

  async function workspace(id: string): Promise<Workspace> {
    const reg = (await registry()).workspaces.find(w => w.id === id)
    if (!reg) throw new RequestError(404, `workspace "${id}" is not registered`)
    await assertWorkspaceAllowed(await loadBoundary(config.registryFile, area), reg, 'Opening')
    const obs = await observe(reg)
    if (!obs.available) throw new RequestError(409, `workspace "${id}" is registered but not available: ${obs.reason}`)
    return new Workspace(reg)
  }

  // Repository inspection costs several Git commands per submodule. While a
  // watcher observes a workspace, its result is reused until the Git
  // fingerprint or .gitmodules changes; `?refresh=1` always inspects anew.
  const repoCache = new Map<string, { key: string; repos: RepositoryStatus[] }>()
  async function withRepositories(ws: Workspace, refresh: boolean) {
    const gitKey = config.watcher?.gitKey(ws.reg.id)
    if (!gitKey) return
    const modules = await readFile(join(ws.root, '.gitmodules'), 'utf8').catch(() => '')
    const key = `${gitKey}\0${modules}`
    const hit = repoCache.get(ws.reg.id)
    if (hit && hit.key === key && !refresh) { ws.knownRepositories = hit.repos; return }
    const repos = await ws.repositories()
    repoCache.set(ws.reg.id, { key, repos })
    ws.knownRepositories = repos
  }

  async function serveStatic(res: ServerResponse, url: URL): Promise<boolean> {
    if (!config.distDir) return false
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
    let file = join(config.distDir, rel)
    if (!file.startsWith(config.distDir + sep) && file !== config.distDir) return false
    const st = await stat(file).catch(() => null)
    if (!st || st.isDirectory()) file = join(config.distDir, 'index.html')
    const data = await readFile(file).catch(() => null)
    if (!data) return false
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(data)
    return true
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      // Only answer to local host names (DNS-rebinding guard).
      const host = (req.headers.host ?? '').replace(/:\d+$/, '')
      if (!config.allowedHosts.includes(host)) throw new RequestError(403, `host "${host}" is not allowed`)
      const url = new URL(req.url ?? '/', 'http://local')
      const method = req.method ?? 'GET'
      // Browser writes only from the editor's configured origin. Clients that
      // send no Origin (curl, tests) are local processes and are allowed.
      if (method !== 'GET' && method !== 'HEAD') {
        const origin = req.headers.origin
        if (origin !== undefined && !config.allowedOrigins.includes(origin)) throw new RequestError(403, `origin "${origin}" may not write`)
      }
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      if (parts[0] !== 'api') {
        if (method === 'GET' && await serveStatic(res, url)) return
        if (method === 'GET' && !config.distDir && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('This is the workflow editor API only.\nOpen the UI through the Vite dev server (npm run dev → http://127.0.0.1:5175),\nor run `npm start` to serve the built UI here.\n')
          return
        }
        throw new RequestError(404, 'not found')
      }
      const [, a, wsId, b, file, action] = parts
      const routed = req.headers[ROUTE_HEADER] !== undefined
      const localOnly = (what: string) => { if (routed) throw new RequestError(403, `${what} takes a host path or repository location and is not offered through agdevworld; use the wfe command line on this host`) }

      // The code this service runs (an installed release names its agdevworld commit).
      if (a === 'version' && !wsId && method === 'GET') return send(res, 200, { ...codeVersion(), registry: config.registryFile })

      // ---- the agdev dashboard and resources (p4) ----
      if (a === 'agdev') {
        if (!wsId && method === 'GET') return send(res, 200, await dashboard(agdev))
        if (wsId === 'projects' && !b && method === 'POST') {
          const input = await body(req) as Record<string, unknown>
          const id = str(input.id, 'id')
          if (input.goals !== undefined && !texts(input.goals)) throw new RequestError(400, 'goals must be a list of text')
          if (input.devdocs !== undefined && input.devdocs !== 'directory' && input.devdocs !== 'submodule') throw new RequestError(400, 'devdocs is directory or submodule')
          if (!config.gitea) throw new RequestError(503, `Gitea is not available: ${config.giteaProblem ?? 'no Gitea setting'}`)
          await mkdir(area, { recursive: true })
          const result = await createProject({
            dir: await inside(area, `pj-${id}`), id, name: str(input.name, 'name'), intent: typeof input.intent === 'string' ? input.intent : '',
            goals: (input.goals as string[] | undefined) ?? [], devdocs: (input.devdocs as 'directory' | 'submodule' | undefined) ?? 'directory',
            registryFile: config.registryFile, gitea: config.gitea, resume: input.resume === true, reuse: input.reuse === true,
          })
          return send(res, result.ok ? 201 : 422, result)
        }
        if (wsId === 'projects' && b === 'register' && method === 'POST') {
          const input = await body(req) as Record<string, unknown>
          return send(res, 200, await registerGiteaProject(agdev, str(input.owner, 'owner'), str(input.name, 'name')))
        }
        if (wsId === 'projects' && b && file === 'workspaces' && method === 'POST') return send(res, 201, await obtainWorkspace(agdev, b))
        if (wsId === 'repositories' && !b && method === 'POST') {
          const input = await body(req) as Record<string, unknown>
          if (input.create === true) return send(res, 201, await createSharedRepository(agdev, str(input.name, 'name'), category(input.category), typeof input.description === 'string' ? input.description : ''))
          return send(res, 200, await registerSharedRepository(agdev, str(input.owner, 'owner'), str(input.name, 'name'), category(input.category)))
        }
        throw new RequestError(404, `no route for ${method} ${url.pathname}`)
      }

      // ---- the person's node catalog (p7/ex1, docs/catalog.md) ----
      if (a === 'nodes') {
        const { addExample, createTemplate, deleteTemplate, readCatalog, updateTemplate } = await import('./catalog.ts')
        const { EXAMPLES } = await import('../shared/catalog.ts')
        const content = (input: Record<string, unknown>) => ({
          name: typeof input.name === 'string' ? input.name : '', type: typeof input.type === 'string' ? input.type : '',
          description: typeof input.description === 'string' ? input.description : '', expectation: typeof input.expectation === 'string' ? input.expectation : '',
          ...(isObj(input.appearance) ? { appearance: { icon: String(input.appearance.icon ?? ''), color: String(input.appearance.color ?? '') } } : {}),
        })
        if (!wsId && method === 'GET') {
          const r = await readCatalog(area)
          return send(res, 200, { ...r, examples: Object.entries(EXAMPLES).map(([id, c]) => ({ id, ...c })) })
        }
        if (!wsId && method === 'POST') {
          const input = await body(req) as Record<string, unknown>
          return send(res, 201, { ok: true, ...(await createTemplate(area, str(input.id, 'id'), content(input), typeof input.by === 'string' ? input.by : '')) })
        }
        if (wsId === 'examples' && b && method === 'POST') {
          const input = await body(req) as Record<string, unknown>
          return send(res, 201, { ok: true, ...(await addExample(area, b, typeof input.by === 'string' ? input.by : '', typeof input.id === 'string' && input.id.trim() ? input.id.trim() : undefined)) })
        }
        if (wsId && !b && method === 'PUT') {
          const input = await body(req) as Record<string, unknown>
          if (typeof input.expectRevision !== 'number') throw new RequestError(400, 'expectRevision is required: the revision the edit was based on')
          return send(res, 200, { ok: true, ...(await updateTemplate(area, wsId, content(input), input.expectRevision, typeof input.by === 'string' ? input.by : '')) })
        }
        if (wsId && !b && method === 'DELETE') {
          const rev = Number(url.searchParams.get('revision'))
          if (!Number.isInteger(rev) || rev < 1) throw new RequestError(400, 'revision is required: the revision being deleted')
          return send(res, 200, { ok: true, ...(await deleteTemplate(area, wsId, rev, url.searchParams.get('by') ?? '')) })
        }
        throw new RequestError(404, `no route for ${method} ${url.pathname}`)
      }

      // The home page's stream: registry changes only.
      if (a === 'events' && method === 'GET') {
        if (!config.watcher) throw new RequestError(404, 'watching is disabled')
        return await config.watcher.stream(undefined, req, res)
      }

      if (a === 'workspaces' && !wsId && method === 'GET') {
        const reg = await registry()
        const list: WorkspaceSummary[] = await Promise.all(reg.workspaces.map(async w => {
          const o = await observe(w)
          return { id: w.id, label: w.label, host: w.host, observed: { available: o.available, reason: o.reason, projectId: o.projectId, projectName: o.projectName, branch: o.branch, head: o.head } }
        }))
        const out: WorkspacesResponse = { approver: reg.approver, workspaces: list, registry: { path: config.registryFile, exists: reg.exists }, area: { path: area, sources: join(area, 'sources') } }
        return send(res, 200, out)
      }
      // Registration writes only the registry. A relative path is taken from the authoring area.
      if (a === 'workspaces' && !wsId && method === 'POST') {
        localOnly('Registering a workspace by path')
        const input = await body(req) as Record<string, unknown>
        if (typeof input.path !== 'string' || !input.path.trim()) throw new RequestError(400, 'path is required')
        const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : undefined
        const path = input.path.trim()
        const result = await registerWorkspace(config.registryFile, isAbsolute(path) ? path : join(area, path), { id, area })
        return send(res, result.ok ? 200 : 422, result)
      }
      // Creation writes only beneath the authoring area (the CLI takes any destination).
      if (a === 'projects' && !wsId && method === 'POST') {
        localOnly('Creating a local project without Gitea')
        const input = await body(req) as Record<string, unknown>
        for (const k of ['id', 'name']) if (typeof input[k] !== 'string') throw new RequestError(400, `${k} is required`)
        if (input.goals !== undefined && !texts(input.goals)) throw new RequestError(400, 'goals must be a list of text')
        await mkdir(area, { recursive: true })
        const rel = typeof input.dir === 'string' && input.dir.trim() ? input.dir.trim() : `pj-${input.id}`
        const dir = await inside(area, rel)
        const result = await createProject({
          dir, id: String(input.id).trim(), name: String(input.name), intent: typeof input.intent === 'string' ? input.intent : '',
          goals: (input.goals as string[] | undefined) ?? [], sourcesDir: join(area, 'sources'),
          devdocsSource: typeof input.devdocsSource === 'string' && input.devdocsSource.trim() ? input.devdocsSource.trim() : undefined,
          registryFile: config.registryFile, resume: input.resume === true,
        })
        return send(res, result.ok ? 201 : 422, result)
      }
      if (a !== 'workspaces' || !wsId) throw new RequestError(404, 'not found')

      if (b === 'events' && method === 'GET') {
        if (!config.watcher) throw new RequestError(404, 'watching is disabled')
        const ws = await workspace(wsId)
        return await config.watcher.stream(ws, req, res)
      }

      const ws = await workspace(wsId)
      if (method === 'GET') await withRepositories(ws, url.searchParams.get('refresh') === '1')
      if (b === 'project' && !file) {
        if (method === 'GET') return send(res, 200, await ws.projectResponse())
        if (method === 'PUT') {
          const input = await body(req) as Record<string, unknown>
          const saved = await ws.saveProject(asProject(input.project))
          config.watcher?.noteOwnWrite(ws, 'project.yaml', saved.rev)
          return send(res, 200, { ok: true, ...saved })
        }
      }
      // Runs (docs/runs.md): GET runs, GET runs/<wf>/<run>[?rev=], GET runs/<wf>/<run>/file?path=,
      // POST runs/<wf>/<run>/ops {op, …, by, expectSeq}.
      if (b === 'runs') {
        if (!file && method === 'GET') return send(res, 200, await listRuns(ws))
        // A person's request: the run with their words, queued for the executor.
        if (!file && method === 'POST') {
          const input = await body(req) as Record<string, unknown>
          const r = await needExec().request({ workspace: ws.reg.id, workflow: str(input.workflow, 'workflow'), text: str(input.text, 'the request text'), author: str(input.author, 'author'), receipt: str(input.receipt, 'receipt'), by: typeof input.by === 'string' ? input.by : undefined, via: 'browser' })
          return send(res, r.duplicate ? 200 : 201, { ok: true, ...r })
        }
        const ref: RunRef = { workflow: parts[4] ?? '', run: parts[5] ?? '' }
        const sub = parts[6]
        if (!ref.workflow || !ref.run || (parts.length > 7 && sub !== 'checkpoints' && sub !== 'presentations')) throw new RequestError(404, 'not found')
        if (!sub && method === 'GET') return send(res, 200, await runResponse(ws, ref, { rev: url.searchParams.get('rev') || undefined }))
        if (sub === 'exec' && method === 'GET') return send(res, 200, needExec().runView(ws.reg.id, ref))
        // Zulip coordination of this run: its topic, what is still owed, problems.
        if (sub === 'notify' && method === 'GET') {
          const { NotifyStore } = await import('./notify.ts')
          const n = new NotifyStore({ area, registryFile: config.registryFile, exec: config.exec })
          try { return send(res, 200, n.runStatus((await ws.readProject()).project?.id ?? '', ref)) } finally { n.close() }
        }
        if (sub === 'checkpoints' && parts[7] && parts[8] === 'publish' && method === 'POST') return send(res, 200, await needExec().publishCheckpoint(Number(parts[7])))
        // Presentations (p7): what each record says and what this host
        // observes now; the person's start (recovery) and stop.
        if (sub === 'presentations') {
          const { Presenter } = await import('./present.ts')
          if (!parts[7] && method === 'GET') {
            const rec = (await runResponse(ws, ref)).record
            if (!rec?.presentations) return send(res, 200, { presentations: [] })
            const pr = new Presenter({ registryFile: config.registryFile, area })
            try { return send(res, 200, { presentations: await pr.view(ws, rec) }) } finally { pr.close() }
          }
          if (parts[7] && (parts[8] === 'start' || parts[8] === 'stop') && method === 'POST') {
            const input = await body(req) as Record<string, unknown>
            const by = typeof input.by === 'string' && input.by.trim() ? input.by.trim() : ''
            if (!by) throw new RequestError(400, 'by is required: the name of who asks for it')
            const pr = new Presenter({ registryFile: config.registryFile, area, by })
            try {
              if (parts[8] === 'start') return send(res, 200, { ok: true, ...(await pr.start(ws, ref, parts[7], { by })) })
              const results = await pr.stop(ws, ref, parts[7] === 'all' ? 'all' : parts[7], { by })
              return send(res, results.every(x => x.ok) ? 200 : 409, { ok: results.every(x => x.ok), results })
            } finally { pr.close() }
          }
          throw new RequestError(404, `no route for ${method} ${url.pathname}`)
        }
        if (sub === 'file' && method === 'GET') return send(res, 200, await readRunFile(ws, ref, url.searchParams.get('path') ?? '', { rev: url.searchParams.get('rev') ?? undefined }))
        // An adjustment of the run's future work (p7): inspect (dryRun) or apply.
        if (sub === 'adjust' && method === 'POST') {
          const input = await body(req) as Record<string, unknown>
          const by = typeof input.by === 'string' ? input.by.trim() : ''
          if (!by) throw new RequestError(400, 'by is required: the name of who adjusts the run')
          const { adjustRun } = await import('./runs.ts')
          const source = (input.source && typeof input.source === 'object' ? input.source : { kind: 'person', by }) as never
          const r = await adjustRun(ws, ref, { text: str(input.text, 'the adjusted definition'), reason: str(input.reason, 'the reason'), source, dryRun: input.dryRun === true, expectRevision: typeof input.expectRevision === 'string' ? input.expectRevision : undefined }, { by, via: 'browser', expectSeq: typeof input.expectSeq === 'number' ? input.expectSeq : undefined })
          return send(res, r.ok ? 200 : 422, r)
        }
        if (sub === 'ops' && method === 'POST') {
          const input = await body(req) as Record<string, unknown>
          // Attempts and presentation facts are the execution host's; adjustments have their own route.
          const offered = OPS.filter(o => o !== 'run.create' && !o.startsWith('attempt.') && !o.startsWith('presentation.') && (o as string) !== 'run.adjust')
          if (!(offered as readonly string[]).includes(input.op as string)) throw new RequestError(400, `op must be one of ${offered.join(', ')} (attempts and presentation facts are the execution host's)`)
          const by = typeof input.by === 'string' ? input.by : ''
          if (!by.trim()) throw new RequestError(400, 'by is required: the name of who records this')
          const expectSeq = typeof input.expectSeq === 'number' ? input.expectSeq : undefined
          const { by: _b, expectSeq: _e, ...op } = input
          const x = config.exec
          const reason = typeof op.reason === 'string' ? op.reason : ''
          // The person's control operations go through execution management,
          // which also terminates, queues or publishes as they require.
          if (x && op.op === 'run.stop') { const rec = await x.stop(ws, ref, by, reason, 'browser'); return send(res, 200, { ok: true, seq: rec.seq, record: rec }) }
          if (x && op.op === 'run.cancel') { const { record: rec, cleanup } = await x.cancel(ws, ref, by, reason, 'browser'); return send(res, 200, { ok: true, seq: rec.seq, record: rec, cleanup }) }
          if (x && op.op === 'run.resume') { const r = await x.resume(ws, ref, by, reason, 'browser', typeof op.receipt === 'string' ? op.receipt : undefined); return send(res, 200, { ok: true, seq: r.record.seq, record: r.record, job: r.job }) }
          const r = await runOp(ws, ref, op as unknown as OpInput, { by, via: 'browser', expectSeq })
          const extra: Record<string, unknown> = { duplicate: r.duplicate ?? false }
          if (x && r.record.executor.name === x.executor) {
            if (op.op === 'question.answer') extra.job = await x.afterAnswer(ws, ref, String(op.question)) // persisted first, then queued
            if (op.op === 'run.decide' && !r.duplicate) extra.checkpoint = await x.afterDecision(ws, ref, String(op.decision)).catch(e => ({ state: 'failed', error: (e as Error).message }))
          }
          return send(res, 200, { ok: true, seq: r.record.seq, record: r.record, ...extra })
        }
        throw new RequestError(404, `no route for ${method} ${url.pathname}`)
      }
      if (b === 'shared' && !file && method === 'POST') {
        const input = await body(req) as Record<string, unknown>
        const result = await addSharedRepository(agdev, ws, str(input.repository, 'repository'), str(input.path, 'path'))
        return send(res, result.ok ? 200 : 422, result)
      }
      if (b === 'submodules' && !file && method === 'POST') {
        localOnly('Adding a submodule from a location')
        const input = await body(req) as Record<string, unknown>
        if (typeof input.path !== 'string') throw new RequestError(400, 'path is required')
        if (input.create === true) {
          const result = await addNewRepository(ws, input.path, join(area, 'sources'))
          return send(res, result.ok ? 200 : 422, result)
        }
        if (typeof input.url !== 'string') throw new RequestError(400, 'url is required (or create: true for a new local repository)')
        assertNotRetired(retiredByUrl(await loadBoundary(config.registryFile, area), input.url), `Adding ${input.url} as a submodule`)
        const result = await ws.addSubmodule(input.path, input.url)
        return send(res, result.ok ? 200 : 422, result)
      }
      if (b === 'workflows' && !file) {
        if (method === 'GET') return send(res, 200, (await ws.workflowSummaries()).list)
        if (method === 'POST') {
          const input = await body(req) as Record<string, unknown>
          if (typeof input.id !== 'string') throw new RequestError(400, 'id is required')
          return send(res, 201, await ws.createWorkflow(input.id, typeof input.name === 'string' ? input.name : '', typeof input.policy === 'string' ? input.policy : 'default'))
        }
      }
      if (b === 'workflows' && file && !action) {
        if (method === 'GET') return send(res, 200, await ws.workflowResponse(file))
        if (method === 'PUT') {
          const input = await body(req) as Record<string, unknown>
          const saved = await ws.saveWorkflow(file, asWorkflow(input.workflow))
          config.watcher?.noteOwnWrite(ws, `devdocs/workflows/${file}`, saved.rev)
          return send(res, 200, { ok: true, ...saved })
        }
      }
      // A node from a template of the person's catalog (p7/ex1), into the saved file.
      if (b === 'workflows' && file && action === 'instantiate' && method === 'POST') {
        const input = await body(req) as Record<string, unknown>
        const list = (v: unknown, what: string) => { if (v === undefined) return undefined; if (!texts(v)) throw new RequestError(400, `${what} must be a list of text`); return v as string[] }
        const { instantiateIntoWorkflow } = await import('./catalog.ts')
        const r = await instantiateIntoWorkflow(area, ws, file, str(input.template, 'template'), { id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : undefined, repositories: list(input.repositories, 'repositories'), after: list(input.after, 'after'), before: list(input.before, 'before') })
        config.watcher?.noteOwnWrite(ws, `devdocs/workflows/${file}`, r.rev)
        return send(res, 200, { ok: true, ...r })
      }
      if (b === 'workflows' && file && action === 'approve' && method === 'POST') {
        const input = await body(req) as Record<string, unknown>
        if (!(APPROVAL_KINDS as readonly string[]).includes(input.kind as string)) throw new RequestError(400, 'kind must be intent or definition')
        const result = await ws.approve(file, input.kind as ApprovalKind, typeof input.approver === 'string' ? input.approver : '')
        config.watcher?.noteOwnWrite(ws, `devdocs/workflows/${file}`, result.rev)
        return send(res, 200, { ok: true, ...result })
      }
      throw new RequestError(404, `no route for ${method} ${url.pathname}`)
    } catch (e) {
      if (res.headersSent) { res.end(); return }
      if (e instanceof RequestError) return send(res, e.status, { error: e.message, detail: e.detail })
      if (e instanceof BoundaryError) return send(res, 400, { error: e.message })
      if (e instanceof RegistryError) return send(res, 500, { error: e.message })
      const err = e as NodeJS.ErrnoException
      // File system failures (permissions, disk) are reported, not hidden.
      if (err.code) return send(res, 500, { error: `${err.code}: ${err.message}` })
      console.error(e)
      return send(res, 500, { error: String((e as Error).message ?? e) })
    }
  }
}
