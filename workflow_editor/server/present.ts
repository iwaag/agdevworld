// Serving instances of presentations on this host (p7, docs/presentations.md).
//
// What is durable evidence lives in run.json (shared/run.ts: registration
// and the lifecycle facts this host observed). What is a fact of this host
// lives here, in <area>/.local/present/present.sqlite: which instance serves
// which presentation, its process and the process's start signature, its
// port, bind address and owner token, and its log. Nothing here is copied
// into a tracked file; run.json names an instance by its id.
//
// An instance runs in a session of its own (detached), so the process group
// of the attempt that started it can be ended without ending it. Nothing
// restarts by itself: start, status, stop and reconcile are explicit.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { channelName, topicUrl } from '../shared/notify.ts'
import { isOpen, runKey, type Observation, type Presentation, type RunRecord, type RunRef } from '../shared/run.ts'
import { inside } from './files.ts'
import { readRun, runOp } from './runs.ts'
import type { ServeConfig } from './presentServer.ts'
import { named, openStore, transaction } from './sqlite.ts'
import { RequestError, type Workspace } from './workspace.ts'

const here = dirname(fileURLToPath(import.meta.url))
// The release (or checkout) an instance runs from, by its real path, so a
// later switch of service/current does not change what a running instance is.
const SERVER_SCRIPT = join(realpathSync(here), 'presentServer.ts')
const now = () => new Date().toISOString()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
export const PRESENTER = 'presenter'

// ---- configuration: <area>/present.json ------------------------------------------------------

export interface PresentConfig { bind: string; publicBase: string | null; ports: [number, number]; answerBase: string | null }
const DEFAULTS: PresentConfig = { bind: '127.0.0.1', publicBase: null, ports: [8300, 8399], answerBase: null }
export function loadPresentConfig(area: string): PresentConfig {
  let raw: Record<string, unknown>
  try { raw = JSON.parse(readFileSync(join(area, 'present.json'), 'utf8')) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS }
    throw new RequestError(409, `${join(area, 'present.json')} cannot be read: ${(e as Error).message}`)
  }
  const c = { ...DEFAULTS, ...raw } as PresentConfig
  if (typeof c.bind !== 'string' || !/^[0-9a-fA-F:.]+$/.test(c.bind)) throw new RequestError(409, 'present.json: bind must be an IP address')
  if (!Array.isArray(c.ports) || c.ports.length !== 2 || !c.ports.every(p => Number.isInteger(p) && p > 1024 && p < 65536) || c.ports[0] > c.ports[1]) throw new RequestError(409, 'present.json: ports must be [first, last] above 1024')
  for (const k of ['publicBase', 'answerBase'] as const) if (c[k] !== null && (typeof c[k] !== 'string' || !/^https?:\/\//.test(c[k]!))) throw new RequestError(409, `present.json: ${k} must be an http(s) URL or null`)
  if (c.publicBase && /^https?:\/\/(localhost|127\.)/.test(c.publicBase)) throw new RequestError(409, 'present.json: publicBase is for a reachable address; leave it null for this host only')
  return c
}
const isLoopback = (bind: string) => bind === '127.0.0.1' || bind === '::1' || bind.startsWith('127.')

// ---- the store --------------------------------------------------------------------------------

export type InstanceState = 'starting' | 'serving' | 'stopping' | 'stopped' | 'failed'
export interface InstanceRow {
  id: string; workspace: string; workflow: string; run: string; presentation: string; revision: string
  host: string; pid: number | null; signature: string | null; port: number; bind: string
  state: InstanceState; created: string; updated: string; detail: string | null; log: string
}
export interface Observed { alive: boolean; identity: boolean; detail: string }
export interface PresentationView {
  id: string; title: string; node: string; revision: string; state: Presentation['state']; instance: string | null
  url: string | null; local: boolean
  observed: (Observed & { instance: string; port: number; pid: number | null; state: InstanceState }) | null
  live: boolean // recorded open and observed serving now
  files: number
}

export interface PresentContext { registryFile: string; area: string; by?: string }

export class Presenter {
  readonly db: DatabaseSync
  readonly ctx: PresentContext
  constructor(ctx: PresentContext) {
    this.ctx = ctx
    const dir = join(ctx.area, '.local', 'present')
    mkdirSync(join(dir, 'instances'), { recursive: true, mode: 0o700 })
    this.db = openStore('present store', join(dir, 'present.sqlite'), [{
      version: 1,
      up: db => db.exec(`
        CREATE TABLE IF NOT EXISTS instances (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, workflow TEXT NOT NULL, run TEXT NOT NULL, presentation TEXT NOT NULL, revision TEXT NOT NULL,
          host TEXT NOT NULL, pid INTEGER, signature TEXT, port INTEGER NOT NULL, bind TEXT NOT NULL, state TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, detail TEXT, log TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS instances_run ON instances (workspace, workflow, run, presentation);
      `),
    }])
  }
  close() { this.db.close() }
  config(): PresentConfig { return loadPresentConfig(this.ctx.area) }
  private get dir() { return join(this.ctx.area, '.local', 'present', 'instances') }
  private tx<T>(f: () => T): T { return transaction(this.db, f, 'present store') }
  private all<T>(sql: string, ...a: (string | number | null)[]): T[] { return named('present store', 'a read', () => this.db.prepare(sql).all(...a) as T[]) }
  private one<T>(sql: string, ...a: (string | number | null)[]): T | undefined { return named('present store', 'a read', () => this.db.prepare(sql).get(...a) as T | undefined) }
  private set(id: string, fields: Partial<InstanceRow>) {
    const keys = Object.keys(fields) as (keyof InstanceRow)[]
    named('present store', 'a write', () => this.db.prepare(`UPDATE instances SET ${keys.map(k => `${k} = ?`).join(', ')}, updated = ? WHERE id = ?`).run(...keys.map(k => fields[k] as string | number | null), now(), id))
  }
  row(id: string) { return this.one<InstanceRow>('SELECT * FROM instances WHERE id = ?', id) }
  instancesOf(workspace: string, ref: RunRef, presentation?: string): InstanceRow[] {
    return presentation
      ? this.all<InstanceRow>('SELECT * FROM instances WHERE workspace = ? AND workflow = ? AND run = ? AND presentation = ? ORDER BY created', workspace, ref.workflow, ref.run, presentation)
      : this.all<InstanceRow>('SELECT * FROM instances WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY created', workspace, ref.workflow, ref.run)
  }

  // ---- addresses ----------------------------------------------------------------------------

  urlOf(row: Pick<InstanceRow, 'port' | 'bind'>): { url: string; local: boolean } {
    const c = this.config()
    if (!isLoopback(row.bind) && c.publicBase) return { url: `${c.publicBase.replace(/\/$/, '')}:${row.port}/`, local: false }
    return { url: `http://${row.bind.includes(':') ? `[${row.bind}]` : row.bind === '0.0.0.0' ? '127.0.0.1' : row.bind}:${row.port}/`, local: true }
  }
  private probeHost(row: Pick<InstanceRow, 'bind'>) { return row.bind === '0.0.0.0' ? '127.0.0.1' : row.bind.includes(':') ? `[${row.bind}]` : row.bind }

  // Where the person answers: the request topic of a run that came from
  // Zulip, otherwise agdevworld's run view on this host.
  answerOf(ws: Workspace, rec: RunRecord): ServeConfig['answer'] {
    const src = rec.input.source
    if (src?.kind === 'zulip') {
      try {
        const z = JSON.parse(readFileSync(join(this.ctx.area, 'zulip.json'), 'utf8')) as { zulipUrl?: string }
        if (z.zulipUrl) return { url: topicUrl(z.zulipUrl, src.stream, channelName(rec.project, rec.workflow), src.topic), text: `in the Zulip request topic “${src.topic}” (reply there)` }
      } catch { /* fall through to the run view */ }
    }
    const base = this.config().answerBase
    const view = base ? `${base.replace(/\/?$/, '/')}#/ws/${encodeURIComponent(ws.reg.id)}/run/${encodeURIComponent(rec.workflow)}/${encodeURIComponent(rec.run)}` : null
    return view ? { url: view, text: `in agdevworld's run view of ${rec.workflow}/${rec.run} (answer the open question there)` } : { url: null, text: `in agdevworld's run view of ${rec.workflow}/${rec.run} on the execution host` }
  }

  // ---- observation ----------------------------------------------------------------------------

  // The process with this pid is still the one that was started: its start
  // time (ps lstart) is the recorded signature.
  static signature(pid: number): string | null {
    try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null } catch { return null }
  }
  static command(pid: number): string {
    try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() } catch { return '' }
  }
  private ours(row: InstanceRow): boolean {
    if (!row.pid || row.host !== hostname()) return false
    const sig = Presenter.signature(row.pid)
    return !!sig && (!row.signature || sig === row.signature) && Presenter.command(row.pid).includes(row.id)
  }
  async identity(row: Pick<InstanceRow, 'id' | 'port' | 'bind'>): Promise<boolean> {
    try {
      const r = await fetch(`http://${this.probeHost(row as InstanceRow)}:${row.port}/.wfe-present/identity`, { signal: AbortSignal.timeout(1500) })
      return r.ok && ((await r.json()) as { instance?: string }).instance === row.id
    } catch { return false }
  }
  async observe(row: InstanceRow): Promise<Observed> {
    const alive = this.ours(row)
    const identity = await this.identity(row)
    return { alive, identity, detail: alive && identity ? 'serving' : alive ? 'the process lives but does not answer with its identity' : identity ? 'its port answers with its identity, but the process is not the recorded one' : 'gone' }
  }

  // ---- start ------------------------------------------------------------------------------------

  private async freePort(): Promise<number> {
    const [first, last] = this.config().ports
    const taken = new Set(this.all<InstanceRow>('SELECT * FROM instances WHERE state IN (\'starting\', \'serving\', \'stopping\')').map(r => r.port))
    for (let p = first; p <= last; p++) {
      if (taken.has(p)) continue
      const ok = await new Promise<boolean>(res => { const s = createServer(); s.once('error', () => res(false)); s.listen(p, this.config().bind, () => s.close(() => res(true))) })
      if (ok) return p
    }
    throw new RequestError(409, `no free port in ${first}–${last} (present.json ports)`)
  }

  private async record(ws: Workspace, ref: RunRef, presentation: string, status: Observation, instance: string | null, detail: string, by?: string) {
    return (await runOp(ws, ref, { op: 'presentation.observe', presentation, status, ...(instance ? { instance } : {}), detail }, { by: by ?? this.ctx.by ?? PRESENTER, via: 'present' })).record
  }

  async start(ws: Workspace, ref: RunRef, presentation: string, o: { by?: string } = {}): Promise<{ state: 'serving' | 'starting'; reused: boolean; instance: InstanceRow; url: string; local: boolean }> {
    const reading = await readRun(ws, ref)
    const rec = reading.record
    if (!rec) throw new RequestError(409, `run ${runKey(ref)} cannot be used: ${reading.problem?.message}`)
    const p = rec.presentations?.[presentation]
    if (!p) throw new RequestError(404, `presentation "${presentation}" does not exist in ${runKey(ref)}`)
    if (rec.cancelled) throw new RequestError(409, `run ${runKey(ref)} is cancelled; its presentations are not served again`)
    if (rec.execution.state === 'completed') throw new RequestError(409, `run ${runKey(ref)} is completed; its presentations are not served again`)
    // One start per presentation: an instance observed serving is returned;
    // a start in progress is reported; one observed gone is replaced.
    for (const row of this.instancesOf(ws.reg.id, ref, presentation).filter(r => ['starting', 'serving', 'stopping'].includes(r.state))) {
      const seen = await this.observe(row)
      if (row.state === 'serving' && seen.alive && seen.identity) {
        if (p.state !== 'available' || p.instance !== row.id) await this.record(ws, ref, presentation, 'available', row.id, 'observed serving (recorded again)', o.by)
        return { state: 'serving', reused: true, instance: row, ...this.urlOf(row) }
      }
      if (row.state === 'starting' && Date.now() - Date.parse(row.created) < 30_000) return { state: 'starting', reused: true, instance: row, ...this.urlOf(row) }
      if (seen.alive || seen.identity) throw new RequestError(409, `instance ${row.id} of ${presentation} is in an unclear state (${seen.detail}); stop it first (wfe present stop ${runKey(ref)} ${presentation})`)
      this.set(row.id, { state: 'stopped', detail: `found gone before a new start (${seen.detail})` })
    }
    const id = `pi-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const cfg = this.config()
    const port = await this.freePort()
    const folder = await inside(ws.root, p.folder)
    const instDir = join(this.dir, id)
    mkdirSync(instDir, { recursive: true, mode: 0o700 })
    const tokenFile = join(instDir, 'token')
    writeFileSync(tokenFile, randomBytes(24).toString('hex'), { mode: 0o600 })
    const serve: ServeConfig = { instance: id, folder, bind: cfg.bind, port, tokenFile, title: p.title, run: `${rec.project} / ${runKey(ref)}`, presentation, revision: p.revision, answer: this.answerOf(ws, rec) }
    const configFile = join(instDir, 'config.json')
    writeFileSync(configFile, JSON.stringify(serve, null, 2), { mode: 0o600 })
    const log = join(instDir, 'serve.log')
    const inserted = this.tx(() => {
      if (this.one('SELECT 1 FROM instances WHERE workspace = ? AND workflow = ? AND run = ? AND presentation = ? AND state IN (\'starting\', \'serving\')', ws.reg.id, ref.workflow, ref.run, presentation)) return false
      named('present store', 'a write', () => this.db.prepare('INSERT INTO instances (id, workspace, workflow, run, presentation, revision, host, port, bind, state, created, updated, log) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, \'starting\', ?, ?, ?)')
        .run(id, ws.reg.id, ref.workflow, ref.run, presentation, p.revision, hostname(), port, cfg.bind, now(), now(), log))
      return true
    })
    if (!inserted) {
      const other = this.instancesOf(ws.reg.id, ref, presentation).find(r => r.state === 'starting' || r.state === 'serving')!
      return { state: 'starting', reused: true, instance: other, ...this.urlOf(other) }
    }
    // A session of its own: outside the caller's process group.
    const out = openSync(log, 'a')
    const child = spawn(process.execPath, [SERVER_SCRIPT, '--instance', id, '--config', configFile], { detached: true, stdio: ['ignore', out, out], cwd: instDir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '' } })
    closeSync(out)
    let exited: number | null = null
    child.once('exit', code => { exited = code ?? -1 })
    child.unref()
    const pid = child.pid ?? null
    this.set(id, { pid })
    const row = () => this.row(id)!
    const failed = async (why: string) => {
      if (pid && exited === null && Presenter.command(pid).includes(id)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
      const tail = (() => { try { return readFileSync(log, 'utf8').trim().split('\n').slice(-3).join(' | ') } catch { return '' } })()
      this.set(id, { state: 'failed', detail: `${why}${tail ? ` — ${tail}` : ''}` })
      await this.record(ws, ref, presentation, 'failed', id, `${why}${tail ? ` (${tail})` : ''}`, o.by).catch(() => {})
      throw new RequestError(422, `presentation ${presentation} did not start: ${why}${tail ? ` — log: ${tail}` : ''}`, { code: 'presentation-start', instance: id, log })
    }
    // Available only after it answered with its identity and served the
    // review screen and the entry.
    const deadline = Date.now() + 10_000
    for (;;) {
      if (exited !== null) return failed(`the server exited with ${exited}`)
      if (await this.identity(row())) break
      if (Date.now() > deadline) return failed('the server did not answer within 10 s')
      await sleep(150)
    }
    const base = `http://${this.probeHost(row())}:${port}`
    for (const path of ['/', `/${p.entry}`]) {
      const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000) }).catch(e => ({ ok: false, status: String(e) }))
      if (!r.ok) return failed(`${path} answered ${r.status}`)
    }
    this.set(id, { state: 'serving', signature: pid ? Presenter.signature(pid) : null, detail: null })
    await this.record(ws, ref, presentation, 'available', id, `served on this host; identity, review screen and ${p.entry} answered`, o.by)
    return { state: 'serving', reused: false, instance: row(), ...this.urlOf(row()) }
  }

  // ---- stop -------------------------------------------------------------------------------------

  // Stops one instance this store owns, verified: the process is gone and
  // the port no longer answers with its identity.
  async stopInstance(row: InstanceRow): Promise<{ ok: boolean; detail: string }> {
    const gone = async () => !this.ours(row) && !(await this.identity(row))
    if (await gone()) { this.set(row.id, { state: 'stopped', detail: 'found gone' }); return { ok: true, detail: 'found gone' } }
    this.set(row.id, { state: 'stopping' })
    try {
      const token = readFileSync(join(this.dir, row.id, 'token'), 'utf8').trim()
      await fetch(`http://${this.probeHost(row)}:${row.port}/.wfe-present/shutdown`, { method: 'POST', headers: { 'x-wfe-present-token': token }, signal: AbortSignal.timeout(2000) }).catch(() => null)
    } catch { /* no token: signals below */ }
    for (let i = 0; i < 25; i++) { if (await gone()) break; await sleep(200) }
    // Only the recorded process: same pid, same start signature, a command
    // line that names the instance.
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      if (await gone()) break
      if (row.pid && this.ours(row)) { try { process.kill(row.pid, sig) } catch { /* gone */ } }
      for (let i = 0; i < 15; i++) { if (await gone()) break; await sleep(200) }
    }
    if (await gone()) { this.set(row.id, { state: 'stopped', detail: 'stopped by its owner; verified gone' }); return { ok: true, detail: 'stopped; process gone and port no longer answers' } }
    const seen = await this.observe(row)
    this.set(row.id, { state: 'stopping', detail: `stop not verified: ${seen.detail}` })
    return { ok: false, detail: `stop not verified: ${seen.detail}` }
  }

  // Stops a presentation of a run (or every one: `all`) and records the
  // verified outcome. Records `stopped` for an open presentation whose
  // instance is found gone; repeating it is harmless.
  async stop(ws: Workspace, ref: RunRef, which: string | 'all', o: { by?: string } = {}): Promise<{ presentation: string; ok: boolean; detail: string }[]> {
    const rec = (await readRun(ws, ref)).record
    if (!rec) throw new RequestError(409, `run ${runKey(ref)} cannot be read`)
    const ids = which === 'all' ? Object.keys(rec.presentations ?? {}) : [which]
    if (which !== 'all' && !rec.presentations?.[which]) throw new RequestError(404, `presentation "${which}" does not exist in ${runKey(ref)}`)
    const out: { presentation: string; ok: boolean; detail: string }[] = []
    for (const id of ids) {
      const p = rec.presentations![id]
      const rows = this.instancesOf(ws.reg.id, ref, id).filter(r => ['starting', 'serving', 'stopping'].includes(r.state))
      if (!rows.length && !isOpen(p)) continue
      const results = await Promise.all(rows.map(r => this.stopInstance(r)))
      const ok = results.every(r => r.ok)
      const detail = results.length ? results.map((r, i) => `${rows[i].id}: ${r.detail}`).join('; ') : `no instance of ${id} is known on this host; nothing serves it`
      const fresh = (await readRun(ws, ref)).record?.presentations?.[id]
      if (ok ? fresh?.state !== 'stopped' : true) await this.record(ws, ref, id, ok ? 'stopped' : 'stop-failed', rows[0]?.id ?? fresh?.instance ?? null, detail, o.by)
      out.push({ presentation: id, ok, detail })
    }
    return out
  }

  // ---- views and recovery -------------------------------------------------------------------

  async view(ws: Workspace, rec: RunRecord): Promise<PresentationView[]> {
    const ref = { workflow: rec.workflow, run: rec.run }
    const out: PresentationView[] = []
    for (const p of Object.values(rec.presentations ?? {})) {
      const rows = this.instancesOf(ws.reg.id, ref, p.id)
      const row = rows.find(r => r.id === p.instance) ?? rows.at(-1)
      const observed = row && row.state !== 'stopped' && row.state !== 'failed' ? { ...(await this.observe(row)), instance: row.id, port: row.port, pid: row.pid, state: row.state } : row ? { alive: false, identity: false, detail: row.detail ?? row.state, instance: row.id, port: row.port, pid: row.pid, state: row.state } : null
      const addr = row ? this.urlOf(row) : null
      const live = isOpen(p) && !!observed?.alive && !!observed.identity
      out.push({ id: p.id, title: p.title, node: p.node, revision: p.revision, state: p.state, instance: p.instance, url: addr?.url ?? null, local: addr?.local ?? true, observed, live, files: p.files.length })
    }
    return out
  }

  // The address of an instance, for messages (resolved when rendered).
  async address(instance: string | null): Promise<{ url: string; local: boolean; live: boolean } | null> {
    const row = instance ? this.row(instance) : undefined
    if (!row) return null
    const seen = row.state === 'serving' ? await this.observe(row) : null
    return { ...this.urlOf(row), live: !!seen?.alive && !!seen.identity }
  }

  // After a restart: instances whose process is gone are marked so here.
  // Records change only through start or stop, which the person or the
  // executing agent chooses.
  async reconcile(): Promise<string[]> {
    const notes: string[] = []
    for (const row of this.all<InstanceRow>('SELECT * FROM instances WHERE state IN (\'starting\', \'serving\', \'stopping\')')) {
      if (row.host !== hostname()) continue
      const seen = await this.observe(row)
      if (seen.alive && seen.identity) continue
      if (row.state === 'starting' && Date.now() - Date.parse(row.created) < 30_000) continue
      if (!seen.alive && !seen.identity) {
        this.set(row.id, { state: 'stopped', detail: `found gone by reconcile (was ${row.state})` })
        notes.push(`${row.workspace} ${row.workflow}/${row.run} ${row.presentation}: instance ${row.id} is gone; the run still records it until \`wfe present start\` or \`stop\``)
      } else notes.push(`${row.workspace} ${row.workflow}/${row.run} ${row.presentation}: instance ${row.id}: ${seen.detail}`)
    }
    return notes
  }
}

// For a reader without a store of its own (the notifier): the address of
// an instance, or null when this area has no present store.
export function presenterOf(area: string, registryFile: string): Presenter | null {
  try { return new Presenter({ area, registryFile }) } catch { return null }
}
export const presentRoot = (area: string) => resolve(area, '.local', 'present')
