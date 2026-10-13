// Execution management on this host (p4): the queue, the one execution slot,
// execution attempts, publication checkpoints and the executor's heartbeat.
//
// What is durable work record lives in run.json (shared/run.ts: attempt
// begin and end, stop, hold, resume). What is a fact of this host lives here,
// in <area>/.local/exec/exec.sqlite: which jobs wait, which attempt holds the
// slot, its process id, when it started and ended, its log, and the state of
// publication. The executor (autolab) and the service reach it only through
// these functions (`wfe exec …`, the HTTP routes), so the rules live once.
//
// Recovery never repeats work by itself: a process that is gone without a
// recorded end becomes `unknown`, a non-zero exit `interrupted`; both hold the
// run until a person resumes it. A request or answer sent twice (same
// receipt) is queued once.
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { normalizeRepoPath } from '../shared/model.ts'
import { describeSteps, effectiveOf, holderOf, hostOf, pendingInstructions, runKey, situation, type AttemptSettings, type RunRecord, type RunRef } from '../shared/run.ts'
import { docStepsOf } from '../shared/compile.ts'
import { assertWorkspaceAllowed, loadBoundary } from './boundary.ts'
import type { Gitea } from './gitea.ts'
import { baseline, publish, type Baseline, type RepoStep } from './publish.ts'
import { loadRegistry, observe, type Registration } from './registry.ts'
import { catalogOf, createRun, listRuns, readRun, runDir, runOp } from './runs.ts'
import { catalogBrief } from '../shared/catalog.ts'
import { activityOf } from './activity.ts'
import { named, openStore, transaction } from './sqlite.ts'
import { inside } from './files.ts'
import { RequestError, Workspace } from './workspace.ts'

export const EXECUTOR = 'autolab'

// What the execution host says about itself when it claims (p6): the
// profiles it can launch (name → backend label) and the common workflow
// contract it composes every prompt from. A run's workflow chooses among the
// profiles; the host never launches one it does not have.
export interface HostOffer { profiles?: Record<string, string>; contract?: { name: string; sha256: string } }
// What one attempt is launched with: the recorded settings plus the guide
// texts the host composes into the prompt (the texts are not recorded; their
// hashes are).
export interface AttemptExecution { agent: string; profile: string | null; backend: string | null; guides: { path: string; sha256: string; text: string }[] }
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')

// What the run's frozen documentation policy asks of this attempt (p5): the
// policy, and for every documentation step that is running or ready, its
// purpose, its document and the instructions frozen with the run.
export function documentationBrief(r: RunRecord): string[] {
  const eff = effectiveOf(r) // the revision in force (p7)
  if (!eff) return ['Documentation policy: none (this run was created before p5); write plans and reports only where a node or the person asks.']
  const d = docStepsOf(eff)
  if (!d.plan && !d.reports && !d.final) return [`Documentation policy: ${eff.policy}. No plan or report is a step of this run; write documents only where a node description or the person asks for them.`]
  // The steps this run has (p8/ex2: any of the three), by name.
  const named = [d.plan && '_plan', d.reports && '_report.<node>', d.final && '_final-report'].filter(Boolean).join(', ')
  const absent = [!d.plan && 'no plan talk', !d.reports && 'no per-node reports', !d.final && 'no final report'].filter(Boolean)
  const out = [`Documentation policy: ${eff.policy} (${describeSteps(d)}). ${named} ${named.includes(',') ? 'are steps' : 'is a step'} of this run, recorded like any node (start, complete); each completes only when its document is a nonempty file of the run folder.${absent.length ? ` This run has ${absent.join(' and ')}: write those documents only where a node description or the person asks for them.` : ''}`]
  const now = [...r.execution.active, ...r.execution.ready, ...r.execution.waiting.map(w => w.node)]
  for (const id of [...new Set(now)]) {
    const step = eff.nodes[id]?.step
    if (!step) continue
    const state = r.nodes[id]?.state
    out.push('', `Step ${id} (${state === 'pending' ? 'ready' : state}): ${step.purpose}. Document: ${runDir(r)}/${step.output}.${step.for && r.nodes[step.for]?.state === 'completed' ? ` Node ${step.for} is completed; only its report remains.` : ''}`, step.instructions)
  }
  return out
}
// The person's additional instructions as the attempt starts (p6): the
// unacknowledged ones in full, in arrival order. More may arrive while it
// works; each node boundary shows them (wfe run start refuses until they are
// acknowledged).
export function instructionBrief(r: RunRecord): string[] {
  const all = Object.values(r.instructions ?? {})
  if (!all.length) return []
  const pending = pendingInstructions(r)
  if (!pending.length) return [`Additional instructions: ${all.length}, all acknowledged (wfe run instructions <run>).`]
  return [
    '', `Additional instructions received and not yet acknowledged (${pending.length}); acknowledge each with what you will do before starting a node (wfe run ack <run> <id>… --response incorporate|clarify|new-run --note …):`,
    ...pending.flatMap(i => [`- ${i.id}, from ${i.from} at ${i.at}${i.during.length ? ` (while ${i.during.join(', ')} ran)` : ''}:`, ...i.text.split('\n').map(l => `    ${l}`)]),
  ]
}
// The run's presentations as the attempt starts (p7): which revision each
// is, its recorded state, and which questions asked about it. Whether one
// is served now is `wfe present status <run>`.
export function presentationBrief(r: RunRecord): string[] {
  const all = Object.values(r.presentations ?? {})
  if (!all.length) return []
  return ['', 'Presentations of this run (wfe present status <run> says what is served now):',
    ...all.map(p => `- ${p.id} "${p.title}" from ${p.node}: ${p.state}${p.last ? ` (${p.last.detail})` : ''}; revision ${p.revision.slice(7, 19)}…${Object.values(r.questions).filter(q => q.presentation?.id === p.id).map(q => `; asked in ${q.id}`).join('')}`)]
}
const now = () => new Date().toISOString()
const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

export interface ExecContext { registryFile: string; area: string; gitea?: Gitea; executor?: string }

export interface JobRow { id: number; receipt: string; kind: 'start' | 'resume'; workspace: string; workflow: string; run: string; reason: string; state: 'queued' | 'claimed' | 'done' | 'dropped'; created: string; claimed: string | null; attempt: string | null; note: string | null }
export interface AttemptRow { id: string; job: number; workspace: string; workflow: string; run: string; host: string; pid: number | null; state: 'launching' | 'running' | 'ended'; began: string; ended: string | null; exit_code: number | null; signal: string | null; outcome: string | null; log: string | null; stop_requested: string | null; backend: string | null; baseline: string | null }
export interface CheckpointRow { id: number; workspace: string; workflow: string; run: string; kind: string; attempt: string | null; state: 'pending' | 'published' | 'nothing' | 'attention' | 'failed'; created: string; updated: string; steps: string; error: string | null; baseline: string | null }

export class ExecStore {
  readonly db: DatabaseSync
  readonly ctx: ExecContext
  constructor(ctx: ExecContext) {
    this.ctx = ctx
    const dir = join(ctx.area, '.local', 'exec')
    mkdirSync(join(dir, 'logs'), { recursive: true })
    this.db = openStore('exec store', join(dir, 'exec.sqlite'), [{
      version: 1, // p4/p5 tables (created before versions were kept; adopted as they are)
      up: db => db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, receipt TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, workspace TEXT NOT NULL, workflow TEXT NOT NULL, run TEXT NOT NULL,
          reason TEXT NOT NULL, state TEXT NOT NULL, created TEXT NOT NULL, claimed TEXT, attempt TEXT, note TEXT);
        CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, job INTEGER NOT NULL, workspace TEXT NOT NULL, workflow TEXT NOT NULL, run TEXT NOT NULL, host TEXT NOT NULL,
          pid INTEGER, state TEXT NOT NULL, began TEXT NOT NULL, ended TEXT, exit_code INTEGER, signal TEXT, outcome TEXT, log TEXT, stop_requested TEXT, backend TEXT, baseline TEXT);
        CREATE TABLE IF NOT EXISTS checkpoints (id INTEGER PRIMARY KEY, workspace TEXT NOT NULL, workflow TEXT NOT NULL, run TEXT NOT NULL, kind TEXT NOT NULL, attempt TEXT,
          state TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, steps TEXT NOT NULL, error TEXT, baseline TEXT);
        CREATE TABLE IF NOT EXISTS heartbeat (name TEXT PRIMARY KEY, at TEXT NOT NULL, pid INTEGER, detail TEXT);
      `),
    }])
  }
  close() { this.db.close() }
  get logsDir() { return join(this.ctx.area, '.local', 'exec', 'logs') }
  get executor() { return this.ctx.executor ?? EXECUTOR }

  private tx<T>(f: () => T): T { return transaction(this.db, f, 'exec store') }
  private all<T>(sql: string, ...a: (string | number | null)[]): T[] { return named('exec store', 'a read', () => this.db.prepare(sql).all(...a) as T[]) }
  private one<T>(sql: string, ...a: (string | number | null)[]): T | undefined { return named('exec store', 'a read', () => this.db.prepare(sql).get(...a) as T | undefined) }
  private run(sql: string, ...a: (string | number | null)[]) { return named('exec store', 'a write', () => this.db.prepare(sql).run(...a)) }

  async workspace(id: string): Promise<Workspace> {
    const reg = (await loadRegistry(this.ctx.registryFile)).workspaces.find(w => w.id === id)
    if (!reg) throw new RequestError(404, `workspace "${id}" is not registered`)
    await assertWorkspaceAllowed(await loadBoundary(this.ctx.registryFile, this.ctx.area), reg, 'Execution')
    const o = await observe(reg)
    if (!o.available) throw new RequestError(409, `workspace "${id}" is not available: ${o.reason}`)
    return new Workspace(reg)
  }

  // ---- requests and the queue ------------------------------------------------------

  // The run that holds a workspace: a run of this executor there that has
  // begun and is neither completed nor cancelled. Another run does not start
  // there meanwhile (one workspace, one run's working tree).
  async holder(ws: Workspace, except?: RunRef): Promise<string | null> {
    for (const r of await listRuns(ws)) {
      if (r.problem || r.executorHost !== this.executor || (except && r.workflow === except.workflow && r.run === except.run)) continue
      if (r.execution === 'completed' || r.execution === 'cancelled') continue
      const begun = this.one<{ n: number }>('SELECT count(*) AS n FROM attempts WHERE workspace = ? AND workflow = ? AND run = ?', ws.reg.id, r.workflow, r.run)!.n > 0
      if (begun || this.one('SELECT 1 FROM jobs WHERE workspace = ? AND workflow = ? AND run = ? AND state IN (\'queued\', \'claimed\')', ws.reg.id, r.workflow, r.run)) return r.ref
    }
    return null
  }

  // A person's request: create the run (their words as braindump.md) and
  // queue its start. The receipt makes a retransmitted request a no-op.
  async request(o: { workspace: string; workflow: string; text: string; author: string; receipt: string; by?: string; via: string }): Promise<{ job: JobRow; ref: RunRef; duplicate: boolean }> {
    if (!/^[A-Za-z0-9:._/#-]{8,200}$/.test(o.receipt)) throw new RequestError(400, 'a request needs a receipt id (8–200 of A-Z a-z 0-9 : . _ / # -)')
    const seen = this.one<JobRow>('SELECT * FROM jobs WHERE receipt = ?', `request:${o.receipt}`)
    if (seen) return { job: seen, ref: { workflow: seen.workflow, run: seen.run }, duplicate: true }
    const ws = await this.workspace(o.workspace)
    const held = await this.holder(ws)
    if (held) throw new RequestError(409, `workspace ${ws.reg.id} is held by run ${held}, which has not completed (it may be awaiting a person). Finish or cancel it, or request the run in another workspace of the project.`)
    const created = await createRun(ws, { workflow: o.workflow, input: { kind: 'braindump', text: o.text, author: o.author, recordedBy: o.by }, executor: { host: this.executor }, by: o.by ?? o.author, via: o.via, area: this.ctx.area })
    const job = this.enqueue(ws.reg.id, created.ref, 'start', `request:${o.receipt}`, 'start: the person\'s request')
    return { job, ref: created.ref, duplicate: false }
  }

  // Queues one job; an existing job with the same receipt, or a queued or
  // claimed job of the same run, is returned instead.
  enqueue(workspace: string, ref: RunRef, kind: 'start' | 'resume', receipt: string, reason: string): JobRow {
    return this.tx(() => {
      const same = this.one<JobRow>('SELECT * FROM jobs WHERE receipt = ?', receipt)
      if (same) return same
      const open = this.one<JobRow>('SELECT * FROM jobs WHERE workspace = ? AND workflow = ? AND run = ? AND state IN (\'queued\', \'claimed\')', workspace, ref.workflow, ref.run)
      if (open) return open
      const id = Number(this.run('INSERT INTO jobs (receipt, kind, workspace, workflow, run, reason, state, created) VALUES (?, ?, ?, ?, ?, ?, \'queued\', ?)', receipt, kind, workspace, ref.workflow, ref.run, reason, now()).lastInsertRowid)
      return this.one<JobRow>('SELECT * FROM jobs WHERE id = ?', id)!
    })
  }

  // After an answer is recorded (persisted first), the run resumes when the
  // answered question is what its node waits on and nothing holds it.
  async afterAnswer(ws: Workspace, ref: RunRef, question: string): Promise<JobRow | null> {
    const r = (await readRun(ws, ref)).record
    if (!r || hostOf(r.executor) !== this.executor || r.cancelled || r.control.hold || r.control.attempt) return null
    const q = r.questions[question]
    if (!q || !q.answers.length || q.takenUp || q.withdrawn) return null
    if (!r.execution.waiting.some(w => 'question' in w.on && w.on.question === question)) return null
    return this.enqueue(ws.reg.id, ref, 'resume', `answer:${ws.reg.id}/${runKey(ref)}/${question}/${q.answers.length - 1}`, `resume: answer ${q.answers.length - 1} to ${question} recorded`)
  }

  // ---- the slot ----------------------------------------------------------------------

  // Takes the oldest queued job when the slot is free and records the
  // attempt's beginning in run.json. Jobs whose run is cancelled, held or
  // already open are dropped with the reason.
  async claim(backend: string | null, offer: HostOffer = {}): Promise<{ job: JobRow; attempt: AttemptRow; workspace: Registration; ref: RunRef; brief: string; execution: AttemptExecution } | { idle: string }> {
    const busy = this.one<AttemptRow>('SELECT * FROM attempts WHERE state != \'ended\'')
    if (busy) return { idle: `the slot is held by attempt ${busy.id} (${busy.workspace} ${busy.workflow}/${busy.run})` }
    for (;;) {
      const job = this.one<JobRow>('SELECT * FROM jobs WHERE state = \'queued\' ORDER BY id LIMIT 1')
      if (!job) return { idle: 'no queued job' }
      const ref = { workflow: job.workflow, run: job.run }
      const drop = (note: string) => this.run('UPDATE jobs SET state = \'dropped\', note = ? WHERE id = ?', note, job.id)
      let ws: Workspace
      try { ws = await this.workspace(job.workspace) } catch (e) { drop((e as Error).message); continue }
      const reading = await readRun(ws, ref)
      const rec = reading.record
      if (!rec) { drop('the run cannot be read'); continue }
      if (rec.cancelled) { drop('the run is cancelled'); continue }
      if (rec.control.hold) { drop(`the run is held (${rec.control.hold.kind}); a person resumes it`); continue }
      if (rec.control.attempt) { drop(`attempt ${rec.control.attempt.id} is still open in run.json`); continue }
      const execution = await this.execution(ws, rec, reading.bundle.entries[rec.definition.root]?.workflow?.execution, backend, offer)
      if ('refused' in execution) { drop(execution.refused); continue }
      const id = `a${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
      const claimed = this.tx(() => {
        if (this.one('SELECT 1 FROM attempts WHERE state != \'ended\'')) return false
        const r = this.run('UPDATE jobs SET state = \'claimed\', claimed = ?, attempt = ? WHERE id = ? AND state = \'queued\'', now(), id, job.id)
        if (Number(r.changes) !== 1) return false
        this.run('INSERT INTO attempts (id, job, workspace, workflow, run, host, state, began, backend) VALUES (?, ?, ?, ?, ?, ?, \'launching\', ?, ?)', id, job.id, job.workspace, job.workflow, job.run, hostname(), now(), execution.backend)
        return true
      })
      if (!claimed) return { idle: 'another executor claimed it first' }
      const base: Baseline = await baseline(ws)
      try {
        // The run's catalog snapshot (p7/ex1): every attempt is given the same one.
        const cat = rec.context?.catalog
        const catalog = cat ? (cat.state === 'supplied' ? { state: 'supplied' as const, sha256: cat.sha256, templates: cat.templates } : { state: 'unavailable' as const }) : undefined
        const settings: AttemptSettings = { agent: execution.agent, profile: execution.profile, backend: execution.backend, contract: offer.contract ?? null, guides: execution.guides.map(g => ({ path: g.path, sha256: g.sha256 })), ...(catalog ? { catalog } : {}) }
        await runOp(ws, ref, { op: 'attempt.begin', attempt: id, reason: job.kind, ...(execution.backend ? { backend: execution.backend } : {}), settings }, { by: this.executor, via: 'exec' })
      } catch (e) {
        this.run('UPDATE attempts SET state = \'ended\', ended = ?, outcome = \'refused\' WHERE id = ?', now(), id)
        this.run('UPDATE jobs SET state = \'dropped\', note = ? WHERE id = ?', `attempt refused: ${(e as Error).message}`, job.id)
        continue
      }
      this.run('UPDATE attempts SET baseline = ?, log = ? WHERE id = ?', JSON.stringify(base), join(this.logsDir, `${id}.jsonl`), id)
      return { job: this.one<JobRow>('SELECT * FROM jobs WHERE id = ?', job.id)!, attempt: this.attemptRow(id)!, workspace: ws.reg, ref, brief: await this.brief(ws, ref, job), execution }
    }
  }

  // The settings an attempt of this run is launched with (p6), from the
  // run's frozen definition: the agent it is performed as, the host profile
  // the workflow asks for, and its guides as they are in the workspace now
  // (by content hash). A profile the host does not offer, or a guide that is
  // missing, refuses the job with the reason instead of launching something
  // else.
  async execution(ws: Workspace, rec: RunRecord, ex: { agent: string; profile: string; guides: string[] } | undefined, backend: string | null, offer: HostOffer): Promise<AttemptExecution | { refused: string }> {
    const profile = ex?.profile || null
    let chosen = backend
    if (profile && offer.profiles) {
      if (!(profile in offer.profiles)) return { refused: `the workflow asks for execution profile "${profile}", which this execution host does not offer (${Object.keys(offer.profiles).sort().join(', ')})` }
      chosen = offer.profiles[profile]
    }
    const guides: AttemptExecution['guides'] = []
    for (const g of ex?.guides ?? []) {
      const path = normalizeRepoPath(g)
      if (!path || path === '.') return { refused: `guide "${g}" is not a project-relative path` }
      try {
        const abs = await inside(ws.root, path)
        const l = await lstat(abs)
        if (!l.isFile() || l.isSymbolicLink() || !(await realpath(abs)).startsWith(await realpath(ws.root))) return { refused: `guide ${path} is not a regular file of the workspace` }
        const bytes = await readFile(abs)
        guides.push({ path, sha256: sha256(bytes), text: bytes.toString('utf8') })
      } catch (e) {
        return { refused: `guide ${path} cannot be read in workspace ${ws.reg.id}: ${(e as Error).message}` }
      }
    }
    return { agent: rec.executor.name, profile, backend: chosen, guides }
  }

  // Work of these workspaces that is not finished here: queued or claimed
  // jobs and attempts that have not ended. A catalog removal waits for none.
  pendingFor(workspaces: string[]): { jobs: JobRow[]; attempts: AttemptRow[] } {
    const jobs = this.all<JobRow>('SELECT * FROM jobs WHERE state IN (\'queued\', \'claimed\')').filter(j => workspaces.includes(j.workspace))
    const attempts = this.all<AttemptRow>('SELECT * FROM attempts WHERE state != \'ended\'').filter(a => workspaces.includes(a.workspace))
    return { jobs, attempts }
  }

  attemptRow(id: string): AttemptRow | undefined { return this.one<AttemptRow>('SELECT * FROM attempts WHERE id = ?', id) }

  started(attempt: string, pid: number) {
    const r = this.run('UPDATE attempts SET pid = ?, state = \'running\' WHERE id = ? AND state = \'launching\'', pid, attempt)
    if (Number(r.changes) !== 1) throw new RequestError(409, `attempt ${attempt} is not launching`)
  }

  // The facts an attempt starts from, for its prompt: what to do now and
  // where the record is. The guide (autolab's) says how.
  async brief(ws: Workspace, ref: RunRef, job: JobRow): Promise<string> {
    const reading = await readRun(ws, ref)
    const r = reading.record!
    const lines = [`Run: ${r.project} / ${runKey(ref)} (record ${runDir(ref)}/run.json)`, `Agent: you perform this run as ${r.executor.name}${hostOf(r.executor) !== r.executor.name ? `; the execution host ${hostOf(r.executor)} launched you and publishes your work` : ''}.`, `Workspace: ${ws.root}`, `Why this attempt: ${job.reason}`]
    if (job.kind === 'start') lines.push(`The person's request is ${runDir(ref)}/${r.input.file} (author ${r.input.author ?? r.input.requester}).`)
    const resume = [...r.history].reverse().find(e => e.op === 'run.resume') as (RunRecord['history'][number] & { reason?: string }) | undefined
    if (job.kind === 'resume') {
      if (r.control.last) lines.push(`The previous attempt ${r.control.last.id} ended: ${r.control.last.outcome}${r.control.last.detail ? ` — ${r.control.last.detail}` : ''}.`)
      if (resume && (!r.control.last || resume.at > r.control.last.ended)) lines.push(`The person resumed the run: "${resume.reason}" (${resume.by}).`)
      for (const w of r.execution.waiting) lines.push(`Node ${w.node} waits; next move: ${holderOf(r, w.node)}.`)
    }
    lines.push(`Ready: ${r.execution.ready.join(', ') || '(none)'}; running: ${r.execution.active.join(', ') || '(none)'}.`)
    lines.push(...instructionBrief(r))
    lines.push(...presentationBrief(r))
    lines.push(...catalogBrief(catalogOf(r, reading.bundle), runKey(ref)))
    if (r.definition.revisions?.length) lines.push('', `Definition: revision ${r.definition.active} is in force (adjusted ${r.definition.revisions.length} time${r.definition.revisions.length === 1 ? '' : 's'}; wfe run revisions <run>); the original is definition/${r.definition.root}.yaml.`)
    lines.push(...documentationBrief(r))
    return lines.join('\n')
  }

  // ---- the end of an attempt ------------------------------------------------------------

  // Records how the process ended and publishes the checkpoint. The record
  // derives the hold (shared/run.ts attempt.end); this only says how the
  // process ended.
  async finished(attempt: string, exit: { code: number | null; signal: string | null; lost?: boolean }): Promise<{ outcome: string; checkpoint: CheckpointRow | null; resumeJob: JobRow | null }> {
    const a = this.attemptRow(attempt)
    if (!a) throw new RequestError(404, `no attempt ${attempt}`)
    if (a.state === 'ended') return { outcome: a.outcome ?? 'ended', checkpoint: null, resumeJob: null }
    const outcome = exit.lost ? 'unknown' : a.stop_requested ? 'stopped' : exit.code === 0 ? 'exited' : 'interrupted'
    const detail = exit.lost ? 'the process was gone when the execution host looked; whether its work finished is not known' : exit.code === 0 ? '' : `process ended with ${exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`}`
    this.run('UPDATE attempts SET state = \'ended\', ended = ?, exit_code = ?, signal = ?, outcome = ? WHERE id = ?', now(), exit.code, exit.signal, outcome, attempt)
    this.run('UPDATE jobs SET state = \'done\' WHERE attempt = ?', attempt)
    const ws = await this.workspace(a.workspace)
    const ref = { workflow: a.workflow, run: a.run }
    let rec: RunRecord | undefined
    try {
      rec = (await runOp(ws, ref, { op: 'attempt.end', attempt, outcome: outcome as 'exited', detail }, { by: this.executor, via: 'exec' })).record
    } catch (e) {
      rec = (await readRun(ws, ref)).record // already ended, or unreadable: keep what is there
      if (!rec) throw e
    }
    const kind = situation(rec)
    const checkpoint = await this.checkpoint(ws, ref, `after attempt ${attempt}: ${kind}`, attempt, a.baseline)
    // An answer may have arrived while the attempt was still running.
    let resumeJob: JobRow | null = null
    if (kind === 'awaiting-person') {
      for (const w of rec.execution.waiting) if ('question' in w.on) resumeJob = resumeJob ?? await this.afterAnswer(ws, ref, w.on.question)
    }
    return { outcome: rec.control.last?.outcome ?? outcome, checkpoint, resumeJob }
  }

  // ---- stop, resume, cancel ---------------------------------------------------------

  async stop(ws: Workspace, ref: RunRef, by: string, reason: string, via: string) {
    const r = await runOp(ws, ref, { op: 'run.stop', reason }, { by, via })
    this.run('UPDATE attempts SET stop_requested = ? WHERE workspace = ? AND workflow = ? AND run = ? AND state != \'ended\'', now(), ws.reg.id, ref.workflow, ref.run)
    this.run('UPDATE jobs SET state = \'dropped\', note = \'stopped\' WHERE workspace = ? AND workflow = ? AND run = ? AND state = \'queued\'', ws.reg.id, ref.workflow, ref.run)
    return r.record
  }

  async resume(ws: Workspace, ref: RunRef, by: string, reason: string, via: string, receipt?: string) {
    const r = await runOp(ws, ref, { op: 'run.resume', reason, ...(receipt ? { receipt: `resume:${receipt}` } : {}) }, { by, via })
    const job = hostOf(r.record.executor) === this.executor ? this.enqueue(ws.reg.id, ref, 'resume', `resume:${ws.reg.id}/${runKey(ref)}/${r.record.seq}`, `resume: ${reason}`) : null
    return { record: r.record, job }
  }

  // Cancellation is final; what the run serves is stopped through this path
  // of its own (p7), whatever successors the graph has. A failed stop is
  // recorded (stop-failed) beside the cancellation and retried with
  // `wfe present stop <run> --all`.
  async cancel(ws: Workspace, ref: RunRef, by: string, reason: string, via: string): Promise<{ record: RunRecord; cleanup: { presentation: string; ok: boolean; detail: string }[] }> {
    const r = await runOp(ws, ref, { op: 'run.cancel', reason }, { by, via })
    this.run('UPDATE attempts SET stop_requested = ? WHERE workspace = ? AND workflow = ? AND run = ? AND state != \'ended\'', now(), ws.reg.id, ref.workflow, ref.run)
    this.run('UPDATE jobs SET state = \'dropped\', note = \'cancelled\' WHERE workspace = ? AND workflow = ? AND run = ? AND state = \'queued\'', ws.reg.id, ref.workflow, ref.run)
    let cleanup: { presentation: string; ok: boolean; detail: string }[] = []
    if (r.record.presentations) {
      const { Presenter } = await import('./present.ts')
      const pr = new Presenter({ registryFile: this.ctx.registryFile, area: this.ctx.area, by })
      try { cleanup = await pr.stop(ws, ref, 'all', { by }) } catch (e) { cleanup = [{ presentation: '*', ok: false, detail: (e as Error).message }] } finally { pr.close() }
    }
    return { record: (await readRun(ws, ref)).record ?? r.record, cleanup }
  }

  // Attempts whose process should be terminated now (stop or cancel requested).
  stopsDue(): AttemptRow[] { return this.all<AttemptRow>('SELECT * FROM attempts WHERE state != \'ended\' AND stop_requested IS NOT NULL') }

  // ---- publication ------------------------------------------------------------------------

  async checkpoint(ws: Workspace, ref: RunRef, kind: string, attempt: string | null, base: string | null): Promise<CheckpointRow> {
    const id = Number(this.run('INSERT INTO checkpoints (workspace, workflow, run, kind, attempt, state, created, updated, steps, baseline) VALUES (?, ?, ?, ?, ?, \'pending\', ?, ?, \'[]\', ?)', ws.reg.id, ref.workflow, ref.run, kind, attempt, now(), now(), base).lastInsertRowid)
    return this.publishCheckpoint(id)
  }

  // Publishes (or retries) one checkpoint. Finished steps are not repeated.
  async publishCheckpoint(id: number): Promise<CheckpointRow> {
    const cp = this.one<CheckpointRow>('SELECT * FROM checkpoints WHERE id = ?', id)
    if (!cp) throw new RequestError(404, `no checkpoint ${id}`)
    if (cp.state === 'published' || cp.state === 'nothing') return cp
    const live = this.one<AttemptRow>('SELECT * FROM attempts WHERE workspace = ? AND state != \'ended\'', cp.workspace)
    if (live) throw new RequestError(409, `attempt ${live.id} is executing in ${cp.workspace}; publication waits until it has ended`)
    const ws = await this.workspace(cp.workspace)
    const ref = { workflow: cp.workflow, run: cp.run }
    const env = this.ctx.gitea ? await this.ctx.gitea.gitEnv() : {}
    const message = `${runKey(ref)}: ${cp.kind}`
    let result
    try {
      const info = await ws.devdocs()
      const dir = runDir(ref)
      const own: Record<string, string> = info.owner === 'devdocs' ? { devdocs: dir.slice('devdocs/'.length) } : { '.': dir }
      result = await publish(ws, cp.baseline ? JSON.parse(cp.baseline) as Baseline : {}, message, JSON.parse(cp.steps) as RepoStep[], env, own)
    } catch (e) {
      result = { state: 'failed' as const, steps: JSON.parse(cp.steps) as RepoStep[], error: (e as Error).message }
    }
    this.run('UPDATE checkpoints SET state = ?, steps = ?, error = ?, updated = ? WHERE id = ?', result.state, JSON.stringify(result.steps), result.error ?? null, now(), id)
    return this.one<CheckpointRow>('SELECT * FROM checkpoints WHERE id = ?', id)!
  }

  // The result decision is a checkpoint of its own (only run.json changes).
  async afterDecision(ws: Workspace, ref: RunRef, decision: string): Promise<CheckpointRow> {
    return this.checkpoint(ws, ref, `result ${decision}`, null, JSON.stringify(await baseline(ws)))
  }

  // ---- recovery -------------------------------------------------------------------------------

  // After a restart of the executor or the service: attempts whose process
  // is gone end as `unknown` (never completed, failed or rerun by
  // themselves); runs a request created but never queued, and answers
  // recorded but never queued, are queued again under their receipts.
  async reconcile(): Promise<string[]> {
    const notes: string[] = []
    for (const a of this.all<AttemptRow>('SELECT * FROM attempts WHERE state != \'ended\'')) {
      if (a.host !== hostname()) continue
      const stale = a.state === 'launching' ? Date.now() - Date.parse(a.began) > 120_000 : !alive(a.pid)
      if (!stale) continue
      const r = await this.finished(a.id, { code: null, signal: null, lost: true }).catch(e => ({ outcome: `not recorded: ${(e as Error).message}` }))
      notes.push(`attempt ${a.id} (${a.workflow}/${a.run}): process gone; recorded ${r.outcome}`)
    }
    const reg = await loadRegistry(this.ctx.registryFile)
    for (const w of reg.workspaces) {
      if (!(await observe(w)).available) continue
      const ws = new Workspace(w)
      for (const s of await listRuns(ws)) {
        if (s.problem || s.executorHost !== this.executor) continue
        const ref = { workflow: s.workflow, run: s.run }
        const rec = (await readRun(ws, ref)).record
        if (!rec || rec.cancelled || rec.control.hold || rec.control.attempt) continue
        const jobs = this.all<JobRow>('SELECT * FROM jobs WHERE workspace = ? AND workflow = ? AND run = ?', w.id, s.workflow, s.run)
        if (rec.execution.state === 'not-started' && rec.control.attempts === 0 && !jobs.length) {
          this.enqueue(w.id, ref, 'start', `start:${w.id}/${s.ref}`, 'start: recovered (the request created the run but was not queued)')
          notes.push(`${w.id} ${s.ref}: start queued again`)
        }
        for (const wt of rec.execution.waiting) {
          if (!('question' in wt.on)) continue
          const j = await this.afterAnswer(ws, ref, wt.on.question)
          if (j && !jobs.some(x => x.id === j.id)) notes.push(`${w.id} ${s.ref}: resume after the answer to ${wt.on.question} queued again`)
        }
      }
    }
    return notes
  }

  // ---- views ------------------------------------------------------------------------------

  heartbeat(name: string, pid: number, detail: string) {
    this.run('INSERT INTO heartbeat (name, at, pid, detail) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET at = excluded.at, pid = excluded.pid, detail = excluded.detail', name, now(), pid, detail)
  }

  executorState(): { state: 'available' | 'unavailable' | 'unknown'; detail?: string; at?: string } {
    const hb = this.one<{ name: string; at: string; detail: string }>('SELECT * FROM heartbeat ORDER BY at DESC LIMIT 1')
    if (!hb) return { state: 'unknown', detail: 'the executor has never reported on this host' }
    const age = (Date.now() - Date.parse(hb.at)) / 1000
    const busy = this.one<AttemptRow>('SELECT * FROM attempts WHERE state != \'ended\'')
    const queued = this.one<{ n: number }>('SELECT count(*) AS n FROM jobs WHERE state = \'queued\'')!.n
    const what = `${hb.name}${busy ? `; executing ${busy.workflow}/${busy.run} (${busy.id})` : '; idle'}${queued ? `; ${queued} queued` : ''}`
    return age < 45 ? { state: 'available', detail: what, at: hb.at } : { state: 'unavailable', detail: `${hb.name} last reported ${Math.round(age)} s ago`, at: hb.at }
  }

  // `activity` (p8/ex2, server/activity.ts): what the attempt's own log says,
  // observed only on the host that has the log (null elsewhere).
  async runView(workspace: string, ref: RunRef) {
    const rows = this.all<AttemptRow>('SELECT * FROM attempts WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY began', workspace, ref.workflow, ref.run)
    const attempts = await Promise.all(rows.map(async a => ({ ...a, baseline: undefined, alive: a.state === 'ended' ? false : a.host === hostname() ? alive(a.pid) : null,
      activity: a.host === hostname() ? await activityOf(a.log) : null })))
    const jobs = this.all<JobRow>('SELECT * FROM jobs WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY id', workspace, ref.workflow, ref.run)
    const checkpoints = this.all<CheckpointRow>('SELECT * FROM checkpoints WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY id', workspace, ref.workflow, ref.run)
      .map(c => ({ ...c, baseline: undefined, steps: JSON.parse(c.steps) as RepoStep[] }))
    return { attempts, jobs, checkpoints, executor: this.executorState() }
  }
}
