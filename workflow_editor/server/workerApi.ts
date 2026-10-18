// The coordinator's routes for remote workers (project_migration p7,
// docs/workers.md): `/api/workers/<id>/<action>`. Every state transition is
// the ExecStore's own operation, the one the local worker reaches through the
// CLI; these routes only carry it. Writes need the worker's token
// (Authorization: Bearer, the content of its tokenFile in workers.json) and
// act for that worker only. `GET /api/workers` (every worker's state) is a read.
//
// Besides the executor's protocol a worker moves files of the runs assigned
// to it between its copy and the coordinator's record copy (tar streams,
// confined to the record copy's tree, never its run.json), ships its attempt
// logs, and forwards its agents' `wfe` commands (`cli`): the coordinator's
// own wfe runs them in the record copy.
import { spawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, readFile, readdir, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExecStore, HostOffer, WorkerFacts } from './exec.ts'
import type { RepoStep } from './publish.ts'
import { readRun, RUN_FILE, runDir } from './runs.ts'
import { runSpace } from './runspace.ts'
import { loadRegistry, observe } from './registry.ts'
import { RequestError, Workspace } from './workspace.ts'
import type { RunRef } from '../shared/run.ts'

const WFE_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'wfe.ts')
const MAX_JSON = 8 * 1024 * 1024
const CLI_TIMEOUT_MS = 30 * 60_000

export interface WorkerRouteConfig { exec: ExecStore; registryFile: string; area: string }

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_JSON) throw new RequestError(413, 'request body too large'); chunks.push(c as Buffer) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw new RequestError(400, 'invalid JSON body') }
}
const str = (v: unknown, what: string) => { if (typeof v !== 'string' || !v) throw new RequestError(400, `${what} is required`); return v }

// The worker's token, compared in constant time; a worker without a
// tokenFile cannot write over HTTP (the local one uses the CLI).
async function authorize(cfg: WorkerRouteConfig, req: IncomingMessage, worker: string) {
  const w = cfg.exec.workers().workers[worker]
  if (!w) throw new RequestError(404, `worker "${worker}" is not a worker of this area`, { code: 'worker-unknown' })
  if (!w.tokenFile) throw new RequestError(403, `worker "${worker}" has no token on the coordinator (workers.json tokenFile)`)
  const want = (await readFile(w.tokenFile, 'utf8')).trim()
  const got = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1]?.trim() ?? ''
  const a = Buffer.from(want), b = Buffer.from(got)
  if (!want || a.length !== b.length || !timingSafeEqual(a, b)) throw new RequestError(401, `not authorized as worker "${worker}"`)
}

// The record copy of a run assigned to this worker; refused for any other run.
async function runOfWorker(cfg: WorkerRouteConfig, worker: string, workspace: string, ref: RunRef): Promise<{ ws: Workspace; tree: string }> {
  const reg = (await loadRegistry(cfg.registryFile)).workspaces.find(w => w.id === workspace)
  if (!reg) throw new RequestError(404, `workspace "${workspace}" is not registered`)
  if (!(await observe(reg)).available) throw new RequestError(409, `workspace "${workspace}" is not available`)
  const ws = new Workspace(reg)
  const space = await runSpace(ws, ref)
  if (!space.copyOf) throw new RequestError(409, `run ${ref.workflow}/${ref.run} has no record copy`)
  const rec = (await readRun(space, ref)).record
  if (!rec) throw new RequestError(409, `run ${ref.workflow}/${ref.run} cannot be read`)
  const node = cfg.exec.nodeOf(rec)
  if (node !== worker) throw new RequestError(403, `run ${ref.workflow}/${ref.run} is performed by ${node}, not by ${worker}`, { code: 'run-foreign' })
  return { ws, tree: space.root }
}
const refOf = (q: URLSearchParams | Record<string, unknown>) => {
  const get = (k: string) => (q instanceof URLSearchParams ? q.get(k) : q[k]) as string | null | undefined
  return { workspace: str(get('workspace'), 'workspace'), ref: { workflow: str(get('workflow'), 'workflow'), run: str(get('run'), 'run') } }
}
// A path relative to a record copy's tree: no absolute path, no `..`, not
// into Git's own data.
function confined(tree: string, rel: string): string {
  const n = normalize(rel)
  if (!rel || n.startsWith('..') || n.startsWith(sep) || n.split(sep).includes('.git') || n.split(sep).includes('..')) throw new RequestError(400, `path "${rel}" is outside the run's copy`)
  return join(tree, n)
}

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256')
  for await (const c of createReadStream(file)) h.update(c as Buffer)
  return h.digest('hex')
}
// Every regular file below these paths of the tree, with its digest.
export async function manifestOf(tree: string, paths: string[], skip: (rel: string) => boolean = () => false): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (rel: string) => {
    const abs = join(tree, rel)
    const st = await stat(abs).catch(() => null)
    if (!st) return
    if (st.isDirectory()) { for (const e of await readdir(abs)) if (e !== '.git') await walk(rel === '.' ? e : join(rel, e)); return }
    if (st.isFile() && !skip(rel)) out[rel.split(sep).join('/')] = await sha256File(abs)
  }
  for (const p of paths) await walk(normalize(p))
  return out
}

function tar(args: string[], cwd: string, input?: Buffer): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', args, { cwd })
    const out: Buffer[] = []; let err = ''
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => { err += d })
    p.on('error', reject)
    p.on('close', code => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }))
    if (input) p.stdin.end(input); else p.stdin.end()
  })
}
async function rawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0
  for await (const c of req) { size += (c as Buffer).length; if (size > limit) throw new RequestError(413, 'body too large'); chunks.push(c as Buffer) }
  return Buffer.concat(chunks)
}

export async function workerRoute(cfg: WorkerRouteConfig, req: IncomingMessage, res: ServerResponse, parts: string[], url: URL): Promise<void> {
  const method = req.method ?? 'GET'
  const [worker, action] = parts
  const x = cfg.exec
  if (!worker) {
    if (method === 'GET') return send(res, 200, { workers: x.workersState() })
    throw new RequestError(404, 'no route')
  }
  await authorize(cfg, req, worker)
  const q = url.searchParams
  switch (`${method} ${action}`) {
    case 'POST heartbeat': {
      const b = await json(req)
      x.heartbeat(worker, Number(b.pid) || 0, typeof b.detail === 'string' ? b.detail : '', { offer: b.offer as HostOffer | undefined, facts: b.facts as WorkerFacts | undefined })
      return send(res, 200, { ok: true })
    }
    case 'POST claim': {
      const b = await json(req)
      return send(res, 200, await x.claim(typeof b.backend === 'string' ? b.backend : null, (b.offer ?? {}) as HostOffer, { worker, receipt: typeof b.receipt === 'string' ? b.receipt : undefined, facts: (b.facts ?? {}) as WorkerFacts }))
    }
    case 'POST started': { const b = await json(req); x.started(str(b.attempt, 'attempt'), Number(b.pid), worker); return send(res, 200, { ok: true }) }
    case 'POST finished': {
      const b = await json(req)
      const r = await x.finished(str(b.attempt, 'attempt'), { code: typeof b.code === 'number' ? b.code : null, signal: typeof b.signal === 'string' ? b.signal : null, lost: b.lost === true, interrupted: typeof b.interrupted === 'string' ? b.interrupted : undefined, attached: typeof b.attached === 'string' ? b.attached : undefined }, worker)
      return send(res, 200, { ok: true, ...r })
    }
    case 'POST session': {
      const b = await json(req)
      return send(res, 200, { ok: true, ...await x.session(str(b.attempt, 'attempt'), typeof b.attached === 'string' ? { attached: b.attached } : { missing: typeof b.missing === 'string' ? b.missing : '' }, worker) })
    }
    case 'POST context': {
      const b = await json(req)
      return send(res, 200, { ok: true, ...await x.contextDelivery(str(b.attempt, 'attempt'), { delivered: b.delivered === true, detail: typeof b.detail === 'string' ? b.detail : undefined }, worker) })
    }
    case 'GET stops': return send(res, 200, x.stopsDue(worker).map(a => ({ id: a.id, pid: a.pid, run: `${a.workflow}/${a.run}`, workspace: a.workspace, requested: a.stop_requested })))
    case 'GET due': return send(res, 200, x.workerDue(worker))
    case 'POST checkpoint': {
      const b = await json(req)
      return send(res, 200, await x.workerCheckpoint(Number(b.id), worker, { state: b.state as never, steps: (b.steps ?? []) as RepoStep[], error: typeof b.error === 'string' ? b.error : undefined }))
    }
    // An attempt's log: appended at the offset the worker shipped to.
    case 'GET log': case 'POST log': {
      const a = x.fence(str(q.get('attempt'), 'attempt'), worker)
      if (!a.log) throw new RequestError(409, `attempt ${a.id} has no log here`)
      await mkdir(dirname(a.log), { recursive: true })
      const size = (await stat(a.log).catch(() => null))?.size ?? 0
      if (method === 'GET') return send(res, 200, { size })
      const offset = Number(q.get('offset'))
      const data = await rawBody(req, 16 * 1024 * 1024)
      if (!Number.isInteger(offset) || offset < 0) throw new RequestError(400, 'offset is required')
      if (offset > size) return send(res, 409, { error: `the log here has ${size} bytes; ship from there`, size })
      const skip = size - offset
      if (skip < data.length) { const f = await open(a.log, 'a'); try { await f.write(data.subarray(skip)) } finally { await f.close() } }
      return send(res, 200, { size: Math.max(size, offset + data.length) })
    }
    case 'POST manifest': {
      const b = await json(req)
      const { workspace, ref } = refOf(b)
      const { tree } = await runOfWorker(cfg, worker, workspace, ref)
      const paths = (Array.isArray(b.paths) ? b.paths : []).map(p => { confined(tree, String(p)); return String(p) })
      return send(res, 200, { files: await manifestOf(tree, paths) })
    }
    // Files from the worker's copy into the record copy (a tar stream).
    // The run's run.json is the coordinator's: an entry for it is refused.
    case 'PUT files': {
      const { workspace, ref } = refOf(q)
      const { tree } = await runOfWorker(cfg, worker, workspace, ref)
      const data = await rawBody(req, 8 * 1024 * 1024 * 1024)
      const list = await tar(['-tf', '-'], tree, data)
      if (list.code !== 0) throw new RequestError(400, `not a tar stream: ${list.stderr.trim()}`)
      const record = `${runDir(ref)}/${RUN_FILE}`
      const names = list.stdout.toString('utf8').split('\n').filter(Boolean)
      for (const n of names) { confined(tree, n.replace(/\/$/, '') || '.'); if (normalize(n) === normalize(record)) throw new RequestError(400, `${record} is the coordinator's record; it is never uploaded`) }
      const x2 = await tar(['-xf', '-'], tree, data)
      if (x2.code !== 0) throw new RequestError(500, `tar failed: ${x2.stderr.trim()}`)
      return send(res, 200, { ok: true, files: names.filter(n => !n.endsWith('/')).length })
    }
    // Files of the record copy for the worker (a tar stream of the paths).
    case 'GET files': {
      const { workspace, ref } = refOf(q)
      const { tree } = await runOfWorker(cfg, worker, workspace, ref)
      const paths = q.getAll('path').filter(p => { confined(tree, p); return existsSync(join(tree, p)) })
      if (!paths.length) { res.writeHead(204); res.end(); return }
      const t = await tar(['-cf', '-', '--exclude', '.git', ...paths], tree)
      if (t.code !== 0) throw new RequestError(500, `tar failed: ${t.stderr.trim()}`)
      res.writeHead(200, { 'content-type': 'application/x-tar', 'cache-control': 'no-store' })
      res.end(t.stdout)
      return
    }
    // An agent's wfe command, run by the coordinator's own wfe in the record
    // copy (or in the area when it names no run).
    case 'POST cli': {
      const b = await json(req)
      const argv = (Array.isArray(b.argv) ? b.argv : []).map(v => {
        if (typeof v === 'string') return v
        if (v && typeof v === 'object' && typeof (v as { tree?: unknown }).tree === 'string') return { tree: String((v as { tree: string }).tree) }
        throw new RequestError(400, 'argv entries are text or {tree: <relative path>}')
      })
      let cwd = cfg.area, root: string | null = null
      if (typeof b.workspace === 'string' && b.workspace) {
        const { workspace, ref } = refOf(b)
        const { tree } = await runOfWorker(cfg, worker, workspace, ref)
        root = tree
        cwd = typeof b.rel === 'string' && b.rel && b.rel !== '.' ? confined(tree, b.rel) : tree
        if (!existsSync(cwd)) cwd = tree
      }
      const attempt = typeof b.attempt === 'string' && b.attempt ? x.fence(b.attempt, worker).id : null
      const args = argv.map(v => (typeof v === 'string' ? v : root ? confined(root, v.tree) : (() => { throw new RequestError(400, 'a tree path needs a run') })()))
      const r = await runCli(cfg, args, cwd, attempt, typeof b.stdin === 'string' ? b.stdin : null)
      return send(res, 200, { ...r, root })
    }
  }
  throw new RequestError(404, `no route for ${method} /api/workers/${worker}/${action ?? ''}`)
}

function runCli(cfg: WorkerRouteConfig, args: string[], cwd: string, attempt: string | null, stdin: string | null): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...process.env as Record<string, string>, WFE_REGISTRY: cfg.registryFile, WFE_AREA: cfg.area, NO_COLOR: '1' }
    delete env.WFE_ATTEMPT; delete env.WFE_COORDINATOR
    if (attempt) env.WFE_ATTEMPT = attempt
    const p = spawn(process.execPath, [WFE_CLI, ...args], { cwd, env })
    let out = '', err = ''
    const timer = setTimeout(() => p.kill('SIGTERM'), CLI_TIMEOUT_MS)
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
    p.on('error', reject)
    p.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout: out, stderr: err }) })
    p.stdin.end(stdin ?? '')
  })
}
