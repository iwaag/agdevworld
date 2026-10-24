// wfe on a remote worker (project_migration p7, docs/workers.md). The worker
// keeps runs' working copies on its own disk; the coordinator keeps the
// records. This module is what `wfe` is on such a host (WFE_WORKER_AREA set,
// no registry):
//
// - `wfe exec …` is the executor's protocol over HTTP, plus what only the
//   worker can do: materializing a run's copy from its published branches
//   before an attempt, publishing the copy after it, shipping the attempt's
//   log, and judging its own processes after a restart.
// - `wfe share …` reads this host's shared areas (<worker area>/shares.json).
// - `wfe challenge …` talks to the coordinator's challenge routes directly.
// - every other command is forwarded: the run folder and the files the
//   command names are uploaded into the coordinator's record copy, the
//   coordinator's wfe runs it there, and the run folder comes back.
//
// <worker area>/worker.json: { "coordinator": "<service URL>", "worker": "<id>",
//   "label": "…", "tokenFile": "worker.token", "facts": { "os": "…", … } }
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { atomicWrite } from '../server/files.ts'
import { git } from '../server/git.ts'
import { Gitea, loadGiteaSetting } from '../server/gitea.ts'
import { publishRun, type RepoStep } from '../server/publish.ts'
import type { Workspace } from '../server/workspace.ts'
import { workerTree } from '../server/workers.ts'
import { runFolder } from '../shared/run.ts'
import type { InputManifestFile } from '../server/shares.ts'

export const WORKER_FILE = 'worker.json'
const LAUNCH_STALE_MS = 120_000
const LOG_CHUNK = 4 * 1024 * 1024

interface WorkerConfig { area: string; coordinator: string; worker: string; label: string; token: string; facts: Record<string, string> }
interface Dispatched { path: string; kind: string; initialized: boolean; branch: string | null; target: string | null; base: string | null; head: string | null; url: string | null }
interface Held { workspace: string; workflow: string; run: string; project: string; tree: string; log: string; shipped: number; pid: number | null; began: string; copy: Dispatched[] }
interface State { attempts: Record<string, Held>; claim?: { receipt: string; at: string }; offer?: unknown }

class Failure extends Error {}

export function workerArea(): string | null { return process.env.WFE_WORKER_AREA ? resolve(process.env.WFE_WORKER_AREA) : null }

function loadConfig(area: string): WorkerConfig {
  const file = join(area, WORKER_FILE)
  let raw: Record<string, unknown>
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { throw new Failure(`${file}: ${(e as Error).message}`) }
  const tokenFile = resolve(area, String(raw.tokenFile ?? 'worker.token'))
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : ''
  if (typeof raw.coordinator !== 'string' || typeof raw.worker !== 'string') throw new Failure(`${file} needs "coordinator" (the WFE service URL) and "worker" (this node's id)`)
  return { area, coordinator: raw.coordinator.replace(/\/?$/, '/'), worker: raw.worker, label: typeof raw.label === 'string' ? raw.label : hostname(), token, facts: (raw.facts ?? {}) as Record<string, string> }
}
const copiesRoot = (c: WorkerConfig) => join(c.area, 'copies')
const logsDir = (c: WorkerConfig) => join(c.area, '.local', 'exec', 'logs')
const stateFile = (c: WorkerConfig) => join(c.area, '.local', 'worker', 'state.json')
async function readState(c: WorkerConfig): Promise<State> {
  try { return JSON.parse(await readFile(stateFile(c), 'utf8')) as State } catch { return { attempts: {} } }
}
async function saveState(c: WorkerConfig, s: State) { await mkdir(dirname(stateFile(c)), { recursive: true }); await atomicWrite(stateFile(c), `${JSON.stringify(s, null, 2)}\n`) }

// ---- HTTP ------------------------------------------------------------------------------

async function call(c: WorkerConfig, method: string, action: string, o: { body?: unknown; raw?: Buffer; query?: Record<string, string | string[]> } = {}): Promise<{ status: number; json?: unknown; bytes?: Buffer }> {
  const url = new URL(`api/workers/${encodeURIComponent(c.worker)}/${action}`, c.coordinator)
  for (const [k, v] of Object.entries(o.query ?? {})) for (const x of [v].flat()) url.searchParams.append(k, x)
  const headers: Record<string, string> = { authorization: `Bearer ${c.token}` }
  let body: BodyInit | undefined
  if (o.raw) { headers['content-type'] = 'application/octet-stream'; body = new Uint8Array(o.raw) }
  else if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body) }
  let res: Response
  try { res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(35 * 60_000) }) } catch (e) { throw new Failure(`the coordinator (${c.coordinator}) cannot be reached: ${(e as Error).message}`) }
  const type = res.headers.get('content-type') ?? ''
  if (type.startsWith('application/json')) {
    const j = await res.json() as { error?: string }
    if (res.status >= 400) throw new Failure(`coordinator ${method} ${action}: ${res.status} ${j.error ?? JSON.stringify(j)}`)
    return { status: res.status, json: j }
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (res.status >= 400) throw new Failure(`coordinator ${method} ${action}: ${res.status} ${bytes.toString('utf8').slice(0, 300)}`)
  return { status: res.status, bytes }
}

// ---- files -------------------------------------------------------------------------------

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256')
  for await (const ch of createReadStream(file)) h.update(ch as Buffer)
  return h.digest('hex')
}
async function localManifest(tree: string, paths: string[], skip: (rel: string) => boolean): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (rel: string) => {
    const st = await stat(join(tree, rel)).catch(() => null)
    if (!st) return
    if (st.isDirectory()) { for (const e of await readdir(join(tree, rel))) if (e !== '.git') await walk(rel === '.' ? e : join(rel, e)); return }
    if (st.isFile() && !skip(rel)) out[rel.split(sep).join('/')] = await sha256File(join(tree, rel))
  }
  for (const p of paths) await walk(normalize(p))
  return out
}
function run(cmd: string, args: string[], cwd: string, input?: Buffer): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, COPYFILE_DISABLE: '1' } }) // no AppleDouble entries from a macOS tar
    const out: Buffer[] = []; let err = ''
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => { err += d })
    p.on('error', rej)
    p.on('close', code => res({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }))
    p.stdin.end(input ?? Buffer.alloc(0))
  })
}
const runKeyOf = (h: Pick<Held, 'workspace' | 'workflow' | 'run'>) => ({ workspace: h.workspace, workflow: h.workflow, run: h.run })

// Uploads the files under `paths` that differ from the record copy's (the
// run's run.json never: it is the coordinator's).
async function upload(c: WorkerConfig, h: Pick<Held, 'workspace' | 'workflow' | 'run' | 'tree'>, paths: string[]) {
  const record = `${runFolder(h)}/run.json`
  const mine = await localManifest(h.tree, paths, rel => rel.split(sep).join('/') === record)
  if (!Object.keys(mine).length) return 0
  const theirs = ((await call(c, 'POST', 'manifest', { body: { ...runKeyOf(h), paths } })).json as { files: Record<string, string> }).files
  const send = Object.keys(mine).filter(f => mine[f] !== theirs[f])
  if (!send.length) return 0
  const t = await run('tar', ['-cf', '-', ...send], h.tree)
  if (t.code !== 0) throw new Failure(`tar failed: ${t.stderr.trim()}`)
  await call(c, 'PUT', 'files', { raw: t.stdout, query: runKeyOf(h) })
  return send.length
}
// Brings the record copy's files under `paths` into this copy.
async function download(c: WorkerConfig, h: Pick<Held, 'workspace' | 'workflow' | 'run' | 'tree'>, paths: string[]) {
  const r = await call(c, 'GET', 'files', { query: { ...runKeyOf(h), path: paths } })
  if (r.status === 204 || !r.bytes?.length) return
  const t = await run('tar', ['-xf', '-'], h.tree, r.bytes)
  if (t.code !== 0) throw new Failure(`tar failed: ${t.stderr.trim()}`)
}

async function shipLog(c: WorkerConfig, id: string, h: Held): Promise<number> {
  const size = (await stat(h.log).catch(() => null))?.size ?? 0
  let at = h.shipped
  while (at < size) {
    const fh = await import('node:fs/promises').then(m => m.open(h.log, 'r'))
    const buf = Buffer.alloc(Math.min(LOG_CHUNK, size - at))
    try { await fh.read(buf, 0, buf.length, at) } finally { await fh.close() }
    try {
      const r = (await call(c, 'POST', 'log', { raw: buf, query: { attempt: id, offset: String(at) } })).json as { size: number }
      at = r.size
    } catch (e) {
      const m = /has (\d+) bytes/.exec((e as Error).message)
      if (m) { at = Number(m[1]); continue }
      throw e
    }
  }
  h.shipped = at
  return at
}

// ---- git -------------------------------------------------------------------------------------

async function gitEnv(c: WorkerConfig): Promise<Record<string, string>> {
  const file = join(c.area, 'gitea.json')
  if (!existsSync(file)) return { GIT_TERMINAL_PROMPT: '0' }
  return new Gitea(await loadGiteaSetting(file)).gitEnv()
}
const depth = (p: string) => (p === '.' ? 0 : p.split('/').length)
async function must(dir: string, args: string[], env: Record<string, string>, what: string, timeoutMs = 600_000) {
  const r = await git(dir, args, { env, timeoutMs })
  if (r.code !== 0) throw new Failure(`${what}: ${r.stderr.trim() || r.stdout.trim()}`)
  return r.stdout.trim()
}

// Makes or advances the run's copy on this host from the branches the
// dispatch published. Only forward: a branch that went another way than its
// published commit is a preparation problem, never a reset.
async function materialize(c: WorkerConfig, tree: string, copy: Dispatched[]) {
  const env = await gitEnv(c)
  const repos = copy.filter(r => r.initialized && r.branch).sort((a, b) => depth(a.path) - depth(b.path))
  const root = repos.find(r => r.path === '.')
  if (!root?.url || !root.head) throw new Failure('the dispatch names no published root branch')
  if (!existsSync(join(tree, '.git'))) {
    const partial = `${tree}.partial`
    await rm(partial, { recursive: true, force: true })
    await mkdir(dirname(tree), { recursive: true })
    await must(dirname(tree), ['clone', '-q', '--no-checkout', root.url, partial], env, 'git clone')
    await must(partial, ['checkout', '-q', '-B', root.branch!, `origin/${root.branch}`], env, `checkout ${root.branch}`)
    await rename(partial, tree)
  }
  for (const r of repos) {
    const dir = join(tree, r.path)
    if (r.path !== '.' && !existsSync(join(dir, '.git'))) {
      const parent = repos.filter(p => p.path === '.' || r.path.startsWith(`${p.path}/`)).sort((a, b) => depth(b.path) - depth(a.path))[0]
      const rel = parent.path === '.' ? r.path : r.path.slice(parent.path.length + 1)
      await must(join(tree, parent.path), ['submodule', 'update', '--init', '--', rel], env, `submodule ${r.path}`)
    }
    await must(dir, ['fetch', '-q', 'origin', `+refs/heads/${r.branch}:refs/remotes/origin/${r.branch}`, ...(r.target ? [`+refs/heads/${r.target}:refs/remotes/origin/${r.target}`] : [])], env, `fetch ${r.path}`)
    if (!r.head) throw new Failure(`${r.path}: the dispatch published no commit of ${r.branch}`)
    if ((await git(dir, ['cat-file', '-e', `${r.head}^{commit}`])).code !== 0) throw new Failure(`${r.path}: commit ${r.head.slice(0, 12)} of ${r.branch} is not reachable from its remote`)
    const current = (await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim()
    const local = (await git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${r.branch}`])).stdout.trim()
    if (!local) { await must(dir, ['checkout', '-q', '-B', r.branch!, r.head], env, `checkout ${r.branch}`); continue }
    if (current !== r.branch) await must(dir, ['checkout', '-q', r.branch!], env, `checkout ${r.branch}`)
    if (local === r.head) continue
    if ((await git(dir, ['merge-base', '--is-ancestor', local, r.head])).code === 0) await must(dir, ['merge', '-q', '--ff-only', r.head], env, `fast-forward ${r.path}`)
    else if ((await git(dir, ['merge-base', '--is-ancestor', r.head, local])).code !== 0) throw new Failure(`${r.path}: this copy's ${r.branch} (${local.slice(0, 12)}) and the published ${r.head.slice(0, 12)} went different ways`)
  }
  const exclude = join(tree, '.git', 'info', 'exclude')
  const text = await readFile(exclude, 'utf8').catch(() => '')
  if (!text.split('\n').includes('.local/')) { await mkdir(dirname(exclude), { recursive: true }); await writeFile(exclude, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.local/\n`) }
}

// Input sets staged as copies are staged here too, from this host's share,
// and checked against the recorded hashes (docs/shares.md).
async function stageInputs(c: WorkerConfig, h: Pick<Held, 'workflow' | 'run' | 'tree'>): Promise<string[]> {
  const notes: string[] = []
  const rec = JSON.parse(await readFile(join(h.tree, runFolder(h), 'run.json'), 'utf8').catch(() => '{}')) as { inputs?: Record<string, { id: string; staging: string; manifest?: { file: string } }> }
  for (const i of Object.values(rec.inputs ?? {})) {
    if (i.staging !== 'copy' || !i.manifest?.file) continue
    const m = JSON.parse(await readFile(join(h.tree, i.manifest.file), 'utf8')) as InputManifestFile
    const dest = join(h.tree, m.staged ?? `.local/inputs/${i.id}`)
    if (existsSync(join(dest, '.wfe-staged'))) continue
    const shares = await import('../server/shares.ts')
    shares.setShareArea(c.area)
    const at = await shares.resolveRef(m.ref)
    if (at.state !== 'ok' || !at.abs) throw new Failure(`input ${i.id}: ${m.ref} is ${at.state} on this host${at.detail ? ` (${at.detail})` : ''}`)
    const tmp = `${dest}.staging`
    await rm(tmp, { recursive: true, force: true })
    for (const f of m.files) {
      const from = (await stat(at.abs)).isDirectory() ? join(at.abs, ...f.path.split('/')) : at.abs
      const to = join(tmp, ...f.path.split('/'))
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
      if (await sha256File(to) !== f.sha256) throw new Failure(`input ${i.id}: ${f.path} on this host's share differs from the recorded set`)
    }
    await writeFile(join(tmp, '.wfe-staged'), `${m.digest}\n`)
    await rm(dest, { recursive: true, force: true })
    await mkdir(dirname(dest), { recursive: true })
    await rename(tmp, dest)
    notes.push(`input ${i.id}: ${m.files.length} files staged and verified`)
  }
  return notes
}

// The host's own overlay of a project's local notes (<area>/overlays/<project>/).
async function overlay(c: WorkerConfig, project: string, tree: string) {
  const dir = join(c.area, 'overlays', project)
  if (!existsSync(dir)) return
  await mkdir(join(tree, '.local'), { recursive: true })
  for (const e of await readdir(dir)) if ((await stat(join(dir, e))).isFile()) await copyFile(join(dir, e), join(tree, '.local', e))
}

// ---- the executor's protocol -------------------------------------------------------------------

interface Parsed { positional: string[]; opts: Map<string, string[]>; flags: Set<string> }
const FLAGS = new Set(['json', 'lost', 'missing', 'delivered', 'undelivered'])
function parse(argv: string[]): Parsed {
  const p: Parsed = { positional: [], opts: new Map(), flags: new Set() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2)
      if (FLAGS.has(k)) { p.flags.add(k); continue }
      p.opts.set(k, [...(p.opts.get(k) ?? []), inline ?? argv[++i]])
    } else p.positional.push(a)
  }
  return p
}
const opt = (p: Parsed, k: string) => p.opts.get(k)?.at(-1)
const pidAlive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
const exitOf = async (log: string): Promise<{ code: number | null; signal: string | null } | null> => {
  const t = await readFile(`${log}.exit`, 'utf8').catch(() => null)
  if (t === null) return null
  const [kind, v] = t.trim().split(/\s+/)
  return kind === 'signal' ? { code: null, signal: v } : { code: Number(v), signal: null }
}

async function execCommand(c: WorkerConfig, p: Parsed): Promise<unknown> {
  const [sub, arg] = p.positional
  const s = await readState(c)
  switch (sub) {
    case 'claim': {
      // Lanes (project_migration p8) are served by the local worker only for
      // now: this worker's bookkeeping (state.json, one pending claim) is
      // read and rewritten by one executor at a time, and two lanes claiming
      // at once would lose each other's attempts.
      const lane = opt(p, 'lane')
      if (lane && lane !== 'default') throw new Failure(`${c.worker} is a remote worker; extra lanes ("${lane}") are served on the local worker only (docs/workers.md, "Lanes")`)
      const profiles = opt(p, 'profiles-json'), sessions = opt(p, 'sessions-json'), contract = opt(p, 'contract')
      const m = contract ? /^([^=]+)=([0-9a-f]{64})$/.exec(contract) : null
      const offer = { ...(profiles ? { profiles: JSON.parse(profiles) } : {}), ...(sessions ? { sessions: JSON.parse(sessions) } : {}), ...(m ? { contract: { name: m[1], sha256: m[2] } } : {}) }
      s.offer = offer
      s.claim ??= { receipt: randomUUID(), at: new Date().toISOString() }
      await saveState(c, s)
      const answer = (await call(c, 'POST', 'claim', { body: { backend: opt(p, 'backend') ?? null, offer, receipt: s.claim.receipt, facts: { label: c.label, root: copiesRoot(c), host: c.facts } } })).json as Record<string, unknown>
      delete s.claim
      await saveState(c, s)
      if ('idle' in answer) return answer
      const attempt = answer.attempt as { id: string; log: string | null }
      const ref = answer.ref as { workflow: string; run: string }
      const ws = (answer.workspace as { id: string; project: string })
      const h: Held = { workspace: ws.id, workflow: ref.workflow, run: ref.run, project: ws.project, tree: workerTree(copiesRoot(c), ws.id, ref), log: join(logsDir(c), `${attempt.id}.jsonl`), shipped: 0, pid: null, began: new Date().toISOString(), copy: (answer.copy ?? []) as Dispatched[] }
      try {
        await materialize(c, h.tree, h.copy)
        await download(c, h, [runFolder(ref)])
        await stageInputs(c, h)
        await overlay(c, ws.project, h.tree)
      } catch (e) {
        // Nothing ran: the attempt ends interrupted (the run is held with the
        // reason) and its checkpoint has nothing of this host to publish.
        const why = `preparation on ${c.worker} failed: ${(e as Error).message}`
        const r = await call(c, 'POST', 'finished', { body: { attempt: attempt.id, code: 127, interrupted: why } }).then(x => x.json as { checkpoint?: { id: number; mode: string } | null }).catch(() => null)
        if (r?.checkpoint?.mode === 'worker') await call(c, 'POST', 'checkpoint', { body: { id: r.checkpoint.id, state: 'nothing', steps: [] } }).catch(() => null)
        return { idle: why }
      }
      s.attempts[attempt.id] = h
      await saveState(c, s)
      await mkdir(dirname(h.log), { recursive: true })
      return { ...answer, cwd: h.tree, attempt: { ...attempt, log: h.log } }
    }
    case 'started': {
      await call(c, 'POST', 'started', { body: { attempt: arg, pid: Number(opt(p, 'pid')) } })
      if (s.attempts[arg]) { s.attempts[arg].pid = Number(opt(p, 'pid')); await saveState(c, s) }
      return { ok: true }
    }
    case 'finished': {
      const code = opt(p, 'exit-code') !== undefined ? Number(opt(p, 'exit-code')) : null
      return finish(c, s, arg, { code, signal: opt(p, 'signal') ?? null, lost: p.flags.has('lost'), interrupted: opt(p, 'interrupted'), attached: opt(p, 'attached') })
    }
    case 'session': return (await call(c, 'POST', 'session', { body: { attempt: arg, ...(opt(p, 'attached') ? { attached: opt(p, 'attached') } : { missing: opt(p, 'detail') ?? '' }) } })).json
    case 'context': return (await call(c, 'POST', 'context', { body: { attempt: arg, delivered: p.flags.has('delivered'), detail: opt(p, 'detail') } })).json
    case 'stops': return (await call(c, 'GET', 'stops')).json
    case 'heartbeat': {
      await call(c, 'POST', 'heartbeat', { body: { pid: Number(opt(p, 'pid')) || process.pid, detail: opt(p, 'detail') ?? '', offer: s.offer, facts: { label: c.label, root: copiesRoot(c), host: c.facts } } })
      for (const [id, h] of Object.entries(s.attempts)) await shipLog(c, id, h).catch(() => null)
      await saveState(c, s)
      return { ok: true }
    }
    case 'reconcile': return { ok: true, notes: await reconcile(c, s, p.opts.get('holding') ?? []) }
    case 'adopt': {
      const due = (await call(c, 'GET', 'due')).json as { attempts: { id: string; pid: number | null; state: string; lane?: string | null }[] }
      return due.attempts.filter(a => a.state === 'running' && pidAlive(a.pid) && s.attempts[a.id]).map(a => ({ id: a.id, pid: a.pid, log: s.attempts[a.id].log, lane: a.lane ?? 'default' }))
    }
    case 'status': case 'workers': return (await fetch(new URL('api/workers', c.coordinator)).then(r => r.json()))
  }
  throw new Failure('wfe exec claim|started|session|context|finished|stops|heartbeat|reconcile|adopt|status (on a worker)')
}

// What this worker holds of an attempt it has no bookkeeping for (its state
// was lost, or the claim's answer never arrived): the copy on disk, if any,
// with every repository on the run's branch.
async function heldFrom(c: WorkerConfig, a: { id: string; workspace: string; workflow: string; run: string; pid: number | null; began: string }): Promise<Held | null> {
  const tree = workerTree(copiesRoot(c), a.workspace, a)
  if (!existsSync(join(tree, '.git'))) return null
  const branch = (await git(tree, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim()
  if (!branch) return null
  const subs = (await git(tree, ['submodule', 'status', '--recursive'])).stdout.split('\n').map(l => l.trim().split(/\s+/)[1]).filter(Boolean)
  const copy: Dispatched[] = []
  for (const path of ['.', ...subs]) {
    if ((await git(join(tree, path), ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim() === branch) copy.push({ path, kind: path === '.' ? 'root' : 'submodule', initialized: true, branch, target: null, base: null, head: null, url: null })
  }
  return { workspace: a.workspace, workflow: a.workflow, run: a.run, project: '', tree, log: join(logsDir(c), `${a.id}.jsonl`), shipped: 0, pid: a.pid, began: a.began, copy }
}

// The end of an attempt: the rest of its log, its run folder, the end
// report, then the checkpoint the worker publishes from its copy. Without a
// copy here there is nothing of this host to publish, and the checkpoint
// says so.
async function finish(c: WorkerConfig, s: State, id: string, exit: { code: number | null; signal: string | null; lost?: boolean; interrupted?: string; attached?: string }) {
  const h = s.attempts[id]
  if (h) {
    await shipLog(c, id, h).catch(() => null)
    await upload(c, h, [runFolder(h)])
  }
  const r = (await call(c, 'POST', 'finished', { body: { attempt: id, ...exit } })).json as { outcome: string; checkpoint: { id: number; mode: string; state: string } | null; resumeJob: unknown }
  let checkpoint = r.checkpoint
  if (checkpoint?.mode === 'worker' && !['published', 'nothing'].includes(checkpoint.state)) {
    checkpoint = h ? await publish(c, h, checkpoint as never) : (await call(c, 'POST', 'checkpoint', { body: { id: checkpoint.id, state: 'nothing', steps: [], error: `${c.worker} holds no copy of this attempt` } })).json as typeof checkpoint
  }
  if (h && (!checkpoint || ['published', 'nothing'].includes(checkpoint.state))) delete s.attempts[id]
  await saveState(c, s)
  return { ok: true, ...r, checkpoint }
}

// Publishes this copy's run branches with the record as the coordinator has
// it now, and reports the steps.
async function publish(c: WorkerConfig, h: Held, cp: { id: number; kind: string; steps: string | RepoStep[] }) {
  await download(c, h, [runFolder(h)])
  const targets = Object.fromEntries(h.copy.filter(r => r.initialized && r.branch).map(r => [r.path, r.branch!]))
  const previous = (typeof cp.steps === 'string' ? JSON.parse(cp.steps) : cp.steps) as RepoStep[]
  const result = await publishRun({ root: h.tree } as Workspace, `${h.workflow}/${h.run}: ${cp.kind}`, previous, await gitEnv(c), targets, f => f())
    .catch(e => ({ state: 'failed' as const, steps: previous, error: (e as Error).message }))
  return (await call(c, 'POST', 'checkpoint', { body: { id: cp.id, ...result } })).json as { id: number; mode: string; state: string }
}

// After a restart, and every minute: this worker's open attempts whose
// process is gone are ended with what the process left (its exit file), or
// as lost; a launch that never registered is lost after two minutes.
// Checkpoints still owed are published again.
async function reconcile(c: WorkerConfig, s: State, holding: string[]): Promise<string[]> {
  const notes: string[] = []
  const due = (await call(c, 'GET', 'due')).json as { attempts: { id: string; workspace: string; workflow: string; run: string; pid: number | null; state: string; began: string }[]; checkpoints: { id: number; attempt: string; workspace: string; workflow: string; run: string; kind: string; steps: string; state: string }[] }
  for (const a of due.attempts) {
    if (holding.includes(a.id)) continue
    // A claim whose answer never arrived holds no state here: an attempt of
    // this worker that was never registered (launching) is gone after the
    // launch window; its copy, if one was made, is found on disk.
    if (!s.attempts[a.id] && a.state !== 'launching') { const found = await heldFrom(c, a); if (found) s.attempts[a.id] = found }
    const h = s.attempts[a.id]
    const pid = a.pid ?? h?.pid ?? null
    if (a.state === 'launching' ? Date.now() - Date.parse(a.began) < LAUNCH_STALE_MS : pidAlive(pid)) continue
    const exit = h ? await exitOf(h.log) : null
    const r = await finish(c, s, a.id, exit ?? { code: null, signal: null, lost: true }).catch(e => ({ outcome: `not recorded: ${(e as Error).message}` }))
    notes.push(`attempt ${a.id}: process gone; recorded ${(r as { outcome: string }).outcome}`)
  }
  // Ends recorded above may have added checkpoints: read them again.
  for (const cp of ((await call(c, 'GET', 'due')).json as typeof due).checkpoints) {
    const h = s.attempts[cp.attempt] ?? await heldFrom(c, { id: cp.attempt, workspace: cp.workspace, workflow: cp.workflow, run: cp.run, pid: null, began: '' })
    const r = h ? await publish(c, h, cp).catch(e => ({ state: `failed: ${(e as Error).message}` }))
      : (await call(c, 'POST', 'checkpoint', { body: { id: cp.id, state: 'nothing', steps: [], error: `${c.worker} holds no copy of this attempt` } })).json as { state: string }
    if (['published', 'nothing'].includes(r.state)) { delete s.attempts[cp.attempt]; await saveState(c, s) }
    notes.push(`checkpoint ${cp.id}: ${r.state}`)
  }
  return notes
}

// ---- forwarding ---------------------------------------------------------------------------

// The run a command concerns: the copy the current directory is in, or the
// attempt the process belongs to.
async function runContext(c: WorkerConfig): Promise<(Pick<Held, 'workspace' | 'workflow' | 'run' | 'tree'> & { rel: string }) | null> {
  const root = copiesRoot(c)
  const here = resolve(process.cwd())
  const rel = relative(root, here)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    const [workspace, workflow, run, t, ...rest] = rel.split(sep)
    if (workspace && workflow && run && t === 'tree') return { workspace, workflow, run, tree: join(root, workspace, workflow, run, 'tree'), rel: rest.join('/') || '.' }
  }
  const attempt = process.env.WFE_ATTEMPT
  const h = attempt ? (await readState(c)).attempts[attempt] : undefined
  return h ? { ...runKeyOf(h), tree: h.tree, rel: '.' } : null
}

const PATH_OPTIONS = new Set(['file', 'from', 'braindump', 'original', 'document', 'subject', 'request', 'draft', 'manifest', 'out', 'dir', 'source', 'review']) // source, review: wfe present register, wfe run publish (fix5)
const looksLikePath = (v: string) => v.includes('/') || v.startsWith('.') || /\.[A-Za-z0-9]{1,8}$/.test(v)

export async function forward(c: WorkerConfig, argv: string[]): Promise<number> {
  const ctx = await runContext(c)
  const paths: string[] = []
  let stdin: string | null = null
  const out: (string | { tree: string })[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const prev = i > 0 && argv[i - 1].startsWith('--') ? argv[i - 1].slice(2).split('=')[0] : null
    if (a === '-' ) { stdin ??= readFileSync(0, 'utf8'); out.push(a); continue }
    if (!ctx || a.startsWith('-') || !(looksLikePath(a) || (prev && PATH_OPTIONS.has(prev)))) { out.push(a); continue }
    const abs = resolve(a)
    if (!existsSync(abs)) { out.push(a); continue }
    const rel = relative(ctx.tree, abs)
    if (!rel.startsWith('..') && !isAbsolute(rel)) { paths.push(rel || '.'); out.push(isAbsolute(a) ? { tree: rel || '.' } : a); continue }
    // Outside the copy: carried into the record copy's .local/wfe-forward/.
    const into = join('.local', 'wfe-forward', randomUUID(), abs.split(sep).pop()!)
    const st = await stat(abs)
    await mkdir(dirname(join(ctx.tree, into)), { recursive: true })
    if (st.isDirectory()) { const t = await run('cp', ['-R', abs, join(ctx.tree, into)], ctx.tree); if (t.code !== 0) throw new Failure(`cannot carry ${a}: ${t.stderr}`) }
    else await copyFile(abs, join(ctx.tree, into))
    paths.push(into)
    out.push({ tree: into })
  }
  if (ctx) await upload(c, ctx, [runFolder(ctx), ...paths])
  const r = (await call(c, 'POST', 'cli', { body: { argv: out, ...(ctx ? { workspace: ctx.workspace, workflow: ctx.workflow, run: ctx.run, rel: ctx.rel } : {}), attempt: process.env.WFE_ATTEMPT ?? null, stdin } })).json as { code: number; stdout: string; stderr: string; root: string | null }
  const fix = (t: string) => (r.root && ctx ? t.split(r.root).join(ctx.tree) : t)
  process.stdout.write(fix(r.stdout))
  process.stderr.write(fix(r.stderr))
  if (ctx) {
    await download(c, ctx, [runFolder(ctx)]).catch(e => process.stderr.write(`wfe (worker ${c.worker}): the record could not be brought back into this copy: ${(e as Error).message}\n`))
    await stageInputs(c, ctx).catch(e => process.stderr.write(`wfe (worker ${c.worker}): ${(e as Error).message}\n`))
  }
  return r.code
}

// ---- entry ----------------------------------------------------------------------------------

export async function remoteMain(argv: string[], local: (argv: string[]) => Promise<number>): Promise<number> {
  const area = workerArea()!
  let c: WorkerConfig
  try { c = loadConfig(area) } catch (e) { console.error(`wfe (worker): ${(e as Error).message}`); return 2 }
  process.env.WFE_AREA = area
  const cmd = argv.find(a => !a.startsWith('-'))
  try {
    if (cmd === 'share') return await local(argv)
    // Challenges (challenge p3) go to the coordinator's HTTP routes from
    // here: the files a write names are read on this node and `--out`
    // writes on this node, never in the coordinator's copy.
    if (cmd === 'challenge') { process.env.WFE_SERVICE ??= c.coordinator; return await local(argv) }
    if (cmd === 'exec') {
      const p = parse(argv.slice(argv.indexOf('exec') + 1))
      console.log(JSON.stringify(await execCommand(c, p), null, 2))
      return 0
    }
    if (cmd === 'worker') {
      const s = await readState(c)
      console.log(JSON.stringify({ worker: c.worker, coordinator: c.coordinator, area, copies: copiesRoot(c), attempts: s.attempts }, null, 2))
      return 0
    }
    return await forward(c, argv)
  } catch (e) {
    if (e instanceof Failure) {
      if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: e.message }))
      console.error(`wfe (worker ${c.worker}): ${e.message}`)
      return 1
    }
    throw e
  }
}
