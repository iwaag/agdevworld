// The workflow observation (observer p3, docs/observation.md): a read-only
// snapshot of every run this host knows, for monitors that must tell work
// that moves from work that waits legitimately and work that stopped.
//
// It reads the same authorities every other entrance reads — the registry,
// each run's live record through `runSpace`, the executor's store, the
// attempt's log on this host — and changes none of them: it reconciles
// nothing, queues nothing, creates no copy, writes no record and posts
// nothing. Unavailable evidence is said (`unavailable`, `source.state`),
// never filled in, so absence is never read as completion.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { promisify } from 'node:util'
import { canonicalJson } from '../shared/canonical.ts'
import { EXECUTOR_OPS, hostOf, questionState, runKey, situation, type RunRecord, type RunRef } from '../shared/run.ts'
import { DEFAULT_LANE, sessionPolicyOf } from '../shared/model.ts'
import { laneOn } from './workers.ts'
import { activityOf, logFacts } from './activity.ts'
import type { AttemptRow, ExecStore, JobRow } from './exec.ts'
import { loadRegistry, observe as observeRegistration } from './registry.ts'
import { readRun, runRefs } from './runs.ts'
import { readCopy } from './runspace.ts'
import { codeVersion } from './version.ts'
import { Workspace } from './workspace.ts'

export const OBSERVATION_SCHEMA = 'ag.wfe-observation.v1'
const MAX_READS = 3
const pexec = promisify(execFile)

export interface ObserveOptions {
  workspace?: string // only this workspace
  runs?: string[] // only these runs: "<workspace>:<workflow>/<run>" or "<workflow>/<run>"
  terminal?: boolean // also completed/cancelled runs with nothing outstanding
  now?: () => Date
  between?: (ref: RunRef) => Promise<void> // tests: runs between the executor rows and the second record read
}

export interface RunIdentity { project: string; workspace: string; workflow: string; run: string; creation: string; uid: string; created: string; receipt: string | null; branch: string | null }
type SourceState = 'ok' | 'unreadable' | 'copy-missing' | 'copy-damaged' | 'copy-creating'
export interface ObservedRun {
  identity: RunIdentity
  source: { state: SourceState; problem: string | null; location: 'copy' | 'workspace'; readAt: string; reads: number; consistent: boolean }
  seq: number | null
  updated: string | null
  situation: string | null
  execution: { state: string; ready: string[]; active: string[]; failed: string[]; blocked: string[]; waiting: { node: string; on: unknown; holder: string; since: string | null; deadline: string | null }[] } | null
  hold: { kind: string; since: string; by: string; reason: string; because: unknown; human: boolean } | null
  stop: unknown
  cancelled: unknown
  attempts: { count: number; beganSeq: number | null; open: { id: string; began: string; reason: string; backend: string | null; agent: string | null } | null; last: { id: string; outcome: string; ended: string; detail: string } | null }
  // agent_session p1: the run's frozen session policy and its sessions, from
  // the record (a session is a conversation, not a process: it says nothing
  // about liveness and its age is no stall timer).
  session: SessionFacts | null
  process: ProcessFacts | null
  queue: { job: Pick<JobRow, 'id' | 'kind' | 'state' | 'created' | 'reason' | 'receipt'> | null; position: number | null; ahead: { uid: string | null; ref: string; workspace: string; kind: 'attempt' | 'job'; state: string }[] }
  inputs: { questions: { id: string; node: string | null; to: string; asked: string; state: string }[]; answeredNotTakenUp: string[]; instructionsPending: number }
  waiting: { reason: string; responsible: string; since: string | null } | null
  progress: { seq: number; at: string; op: string; by: string; attempt: string | null } | null
  recoveries: { seq: number; at: string; by: string; incident: string; attempt: string; agent: unknown }[]
  publication: { failed: CheckpointFact[]; attention: CheckpointFact[]; pending: CheckpointFact[] }
  integration: Record<'queued' | 'running' | 'failed' | 'refused' | 'attention', { id: number; decision: number; error: string | null; updated: string }[]>
  input: { kind: string; requester: string | null; source: unknown }
  executor: { name: string; host: string; node: string | null; lane: string } | null // node (p7): the worker that performs it; lane (p8): the lane its record names (`default` when none)
  problems: { code: string; message: string }[]
  unavailable: Record<string, string>
  // p10 (docs/delegation.md): the run's delegations — present when it has any.
  delegations?: DelegationFacts[]
}
// One delegation as a monitor needs it: whose move it is, the child's
// situation now, the parent's facts not yet taken up, the child's facts not
// yet relayed (a stalled relay), and how the request's delivery stands (an
// unbound dispatch).
export interface DelegationFacts {
  id: string; uid: string; node: string; state: string; target: string; dispatchedAt: string; closed: boolean
  child: { uid: string; workspace: string; ref: string; situation: string | null; execution: string | null; waitingFor: string[]; hold: string | null; failed: string[] } | null
  pending: { n: number; type: string; at: string }[]
  unrelayed: { type: string; childSeq: number; at: string; wakes: boolean }[]
  delivery: { state: string; error: string | null; message: number | null; since: string } | null
  problem: string | null
}
export interface SessionFacts {
  policy: 'fresh' | 'run'
  current: { id: string | null; began: string; attempts: string[]; attached: string | null; mismatch: boolean } | null
  count: number
  ended: { id: string | null; state: string; at: string; by: string; reason: string }[] // the last three replaced or retired sessions
}
interface CheckpointFact { id: number; kind: string; state: string; error: string | null; updated: string }
export interface ProcessFacts {
  attempt: string; state: string; host: string; local: boolean; pid: number | null; alive: boolean | null
  began: string; ended: string | null; exit: number | null; signal: string | null; outcome: string | null; stopRequested: string | null
  group: { members: number; cpuSeconds: number } | null
  log: { last: string | null; bytes: number; turns: number | null; session: string | null; problem: string | null; openTool: unknown; ended: unknown; backgroundStopped: number; partial: boolean } | null
  // agent_session p1: the session the record says this attempt ran in, and
  // whether it was resumed (an earlier attempt served it) — read from the
  // record, the log's session id being supporting evidence.
  session: { id: string | null; resumed: boolean } | null
}
export interface Observation {
  schema: string
  observedAt: string
  host: string
  release: string | null
  executor: { state: string; heartbeatAt: string | null; ageSeconds: number | null; name: string | null; pid: number | null; detail: string | null; slot: { attempt: string; workspace: string; run: string; uid: string | null } | null; queued: number }
  // project_migration p7: every execution node. `executor` above is the
  // local worker's (what it always was); a remote worker's state is its last
  // contact — `unavailable` means contact is lost, not that its work ended.
  workers: { id: string; label: string; local: boolean; default: boolean; state: string; heartbeatAt: string | null; ageSeconds: number | null; detail: string; slot: { attempt: string; workspace: string; run: string; uid: string | null; stopRequested: string | null } | null; slots: { attempt: string; workspace: string; run: string; uid: string | null; stopRequested: string | null; lane: string }[]; lanes: Record<string, number>; queued: number; waiting: { job: number; run: string; note: string }[]; profiles: string[] | null }[]
  workspaces: { id: string; available: boolean; problem: string | null }[]
  runs: ObservedRun[]
  problems: { code: string; message: string }[]
}

const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

// "[[dd-]hh:]mm:ss[.ss]" → seconds (ps's cumulative CPU time).
export function cpuSeconds(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim())
  if (!m) return null
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])
}

// One `ps` for the whole look: members and CPU time per process group.
async function processGroups(): Promise<Map<number, { members: number; cpuSeconds: number }> | string> {
  try {
    const { stdout } = await pexec('ps', ['-axo', 'pid=,pgid=,time='], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })
    const groups = new Map<number, { members: number; cpuSeconds: number }>()
    for (const line of stdout.split('\n')) {
      const [pid, pgid, time] = line.trim().split(/\s+/)
      if (!pid || !pgid || !time) continue
      const g = groups.get(Number(pgid)) ?? { members: 0, cpuSeconds: 0 }
      g.members++
      g.cpuSeconds += cpuSeconds(time) ?? 0
      groups.set(Number(pgid), g)
    }
    return groups
  } catch (e) {
    return `ps failed: ${(e as Error).message}`
  }
}

export const creationOf = (r: RunRecord) => createHash('sha256').update(canonicalJson(r.history[0] ?? null)).digest('hex').slice(0, 16)

// The run's source: where its live record is and whether it can be read.
async function sourceOf(ws: Workspace, ref: RunRef): Promise<{ state: SourceState; problem: string | null; location: 'copy' | 'workspace' }> {
  const c = await readCopy(ws, ref).catch(e => ({ problem: (e as Error).message, manifest: null }))
  if (!c) return { state: 'ok', problem: null, location: 'workspace' }
  if (!c.problem && c.manifest) return { state: 'ok', problem: null, location: 'copy' }
  const p = c.problem ?? 'the copy cannot be read'
  return { state: /still being created/.test(p) ? 'copy-creating' : /is missing|has no/.test(p) ? 'copy-missing' : 'copy-damaged', problem: p, location: 'copy' }
}

function waitingOf(r: RunRecord, job: JobRow | null): ObservedRun['waiting'] {
  const ctl = r.control
  if (r.cancelled) return { reason: 'cancelled', responsible: 'none', since: r.cancelled.at }
  if (r.execution.state === 'completed') return null
  if (ctl.attempt) return ctl.stop
    ? { reason: `stopping (requested by ${ctl.stop.by})`, responsible: 'executor', since: ctl.stop.at }
    : { reason: `executing ${r.execution.active.join(', ') || '(between nodes)'}`, responsible: `agent:${r.executor.name}`, since: ctl.attempt.began }
  if (ctl.hold) {
    if (ctl.hold.kind === 'stopped') return { reason: `held by ${ctl.hold.by}: ${ctl.hold.reason}`, responsible: `person:${ctl.hold.because?.from ?? ctl.hold.by}`, since: ctl.hold.since }
    return { reason: `held: ${ctl.hold.kind} (${ctl.hold.reason})`, responsible: 'recovery', since: ctl.hold.since }
  }
  if (job) return { reason: `${job.kind} ${job.state}${job.worker ? ` for ${job.worker}` : ''} (${job.note ?? job.reason})`, responsible: 'executor', since: job.created }
  for (const w of r.execution.waiting) {
    if ('question' in w.on) {
      const q = r.questions[w.on.question]
      if (q && q.answers.length && !q.takenUp && !q.withdrawn) return { reason: `answer to ${q.id} recorded, not yet taken up, no job queued`, responsible: 'executor', since: q.answers.at(-1)!.at }
      if (q) return { reason: `question ${q.id} to ${q.to}`, responsible: `person:${q.to}`, since: q.asked }
    } else if ('delegation' in w.on) {
      // p10: a delegate node waits on its child; a fact of the child not
      // taken up is the parent's agent's to read.
      const d = r.delegations?.[w.on.delegation]
      const pending = d ? d.events.filter(e => e.wakes && !e.takenUp) : []
      if (d && pending.length) return { reason: `delegation ${d.id}: ${pending.map(e => `${e.type} #${e.n}`).join(', ')} relayed, not yet taken up, no job queued`, responsible: 'executor', since: pending[0].at }
      // The child's move (its own record says whose), or a dispatch that has no child yet.
      if (d?.child) return { reason: `delegation ${d.id} to ${d.target.project}/${d.target.workflow}: child ${d.child.run}`, responsible: `delegation:${d.child.uid}`, since: r.nodes[w.node]?.updated ?? null }
      if (d) return { reason: `delegation ${d.id} to ${d.target.project}/${d.target.workflow}: dispatched ${d.dispatched.at}, no child yet`, responsible: `delegation-unbound:${d.uid}`, since: d.dispatched.at }
    } else {
      const deadline = r.nodes[w.node]?.wait?.deadline
      return { reason: `external: ${w.on.external}${deadline ? ` (expected by ${deadline})` : ''}`, responsible: `external:${w.on.external}`, since: r.nodes[w.node]?.updated ?? null }
    }
  }
  if (r.execution.ready.length || r.execution.active.length) return { reason: `${r.execution.active.length ? `${r.execution.active.join(', ')} recorded as running` : `${r.execution.ready.join(', ')} ready`}, no attempt and no job`, responsible: 'executor', since: r.updated }
  if (r.execution.state === 'not-started') return { reason: 'not started, no job', responsible: 'executor', since: r.created }
  return { reason: `execution ${r.execution.state}`, responsible: 'none', since: r.updated }
}

function nodeSince(r: RunRecord, node: string): string | null { return r.nodes[node]?.updated ?? null }

// The last report the run's agent made itself (an executor operation in its name).
function progressOf(r: RunRecord): ObservedRun['progress'] {
  const last = [...r.history].reverse().find(e => EXECUTOR_OPS.includes(e.op) && e.by === r.executor.name)
  return last ? { seq: last.seq, at: last.at, op: last.op, by: last.by, attempt: last.attempt ?? null } : null
}

export class Observer {
  readonly exec: ExecStore | null
  readonly registryFile: string
  constructor(exec: ExecStore | null, registryFile: string) { this.exec = exec; this.registryFile = registryFile }

  async observe(o: ObserveOptions = {}): Promise<Observation> {
    const now = o.now ?? (() => new Date())
    const host = hostname()
    const problems: Observation['problems'] = []
    const reg = await loadRegistry(this.registryFile)
    const queue = this.exec ? this.exec.queueView() : null
    const groups = await processGroups()
    if (typeof groups === 'string') problems.push({ code: 'ps', message: groups })
    const workspaces: Observation['workspaces'] = []
    const runs: ObservedRun[] = []
    const wanted = (o.runs ?? []).map(s => { const m = /^(?:([^:]+):)?([a-z0-9][a-z0-9_.-]*)\/(run-[a-z0-9][a-z0-9_.-]*)$/.exec(s); if (!m) throw new Error(`--run "${s}" is <workspace>:<workflow>/<run> or <workflow>/<run>`); return { ws: m[1], workflow: m[2], run: m[3] } })
    for (const w of reg.workspaces) {
      if (o.workspace && w.id !== o.workspace) continue
      if (wanted.length && !wanted.some(x => !x.ws || x.ws === w.id)) continue
      const avail = await observeRegistration(w)
      workspaces.push({ id: w.id, available: avail.available, problem: avail.available ? null : avail.reason ?? 'unavailable' })
      if (!avail.available) continue
      const ws = new Workspace(w)
      let refs: RunRef[]
      try { refs = await runRefs(ws) } catch (e) { problems.push({ code: 'workspace', message: `${w.id}: runs cannot be listed: ${(e as Error).message}` }); continue }
      for (const ref of refs) {
        const pick = wanted.filter(x => (!x.ws || x.ws === w.id) && x.workflow === ref.workflow && x.run === ref.run)
        if (wanted.length && !pick.length) continue
        const run = await this.observeRun(ws, ref, groups, now, o.between)
        const explicit = pick.length > 0
        if (!explicit && !o.terminal && this.settled(run)) continue
        runs.push(run)
      }
    }
    // The same display identity from two registrations: listed apart, never merged.
    const byKey = new Map<string, ObservedRun[]>()
    for (const r of runs) if (r.identity.project) byKey.set(`${r.identity.project}/${r.identity.workflow}/${r.identity.run}`, [...(byKey.get(`${r.identity.project}/${r.identity.workflow}/${r.identity.run}`) ?? []), r])
    for (const [key, same] of byKey) {
      if (same.length < 2) continue
      for (const r of same) r.problems.push({ code: 'ambiguous', message: `${key} is also observed in workspace${same.length > 2 ? 's' : ''} ${same.filter(x => x !== r).map(x => `${x.identity.workspace} (creation ${x.identity.creation})`).join(', ')}; not merged` })
    }
    const uidOf = (workspace: string, ref: string) => runs.find(r => r.identity.workspace === workspace && `${r.identity.workflow}/${r.identity.run}` === ref)?.identity.uid ?? null
    const hb = queue?.heartbeat ?? null
    const age = hb ? Math.max(0, (now().getTime() - Date.parse(hb.at)) / 1000) : null
    const state = this.exec ? this.exec.executorState() : { state: 'unknown', detail: 'execution is not configured here' }
    const release = codeVersion().release?.agdevworld ?? null
    // Work ahead of each queued job: the slot's attempt, then earlier jobs.
    for (const r of runs) {
      if (!r.queue.job || r.queue.job.state !== 'queued' || !queue) continue
      // Work ahead is the run's own worker's (p7): its slot, then its earlier jobs.
      const worker = r.executor?.node ?? null
      const own = (w: string | null) => !worker || (w ?? this.exec!.workers().default) === worker
      const queued = queue.jobs.filter(j => j.state === 'queued' && own(j.worker))
      // The slot ahead is the one of the lane the run is claimed in (p8).
      const lane = worker ? laneOn(this.exec!.workers().workers[worker], r.executor?.lane) : DEFAULT_LANE
      const busy = queue.slots.find(a => own(a.worker) && (a.lane ?? DEFAULT_LANE) === lane) ?? null
      const i = queued.findIndex(j => j.id === r.queue.job!.id)
      r.queue.position = i >= 0 ? i + 1 : null
      r.queue.ahead = [
        ...(busy ? [{ uid: uidOf(busy.workspace, `${busy.workflow}/${busy.run}`), ref: `${busy.workflow}/${busy.run}`, workspace: busy.workspace, kind: 'attempt' as const, state: busy.state }] : []),
        ...queued.slice(0, Math.max(0, i)).map(j => ({ uid: uidOf(j.workspace, `${j.workflow}/${j.run}`), ref: `${j.workflow}/${j.run}`, workspace: j.workspace, kind: 'job' as const, state: j.state })),
      ]
    }
    return {
      schema: OBSERVATION_SCHEMA, observedAt: now().toISOString(), host, release,
      executor: {
        state: state.state, heartbeatAt: hb?.at ?? null, ageSeconds: age === null ? null : Math.round(age * 10) / 10, name: hb?.name ?? null, pid: hb?.pid ?? null, detail: state.detail ?? null,
        slot: queue?.busy ? { attempt: queue.busy.id, workspace: queue.busy.workspace, run: `${queue.busy.workflow}/${queue.busy.run}`, uid: uidOf(queue.busy.workspace, `${queue.busy.workflow}/${queue.busy.run}`) } : null,
        queued: queue ? queue.jobs.filter(j => j.state === 'queued' && (j.worker ?? this.exec!.localWorker) === this.exec!.localWorker).length : 0,
      },
      workers: (queue?.workers ?? []).map(w => ({ id: w.id, label: w.label, local: w.local, default: w.default, state: w.state, heartbeatAt: w.at, ageSeconds: w.ageSeconds === null ? null : Math.round(w.ageSeconds * 10) / 10, detail: w.detail,
        slot: w.busy ? { attempt: w.busy.attempt, workspace: w.busy.workspace, run: `${w.busy.workflow}/${w.busy.run}`, uid: uidOf(w.busy.workspace, `${w.busy.workflow}/${w.busy.run}`), stopRequested: w.busy.stopRequested } : null,
        // Every open attempt with its lane (p8); `slot` stays the default lane's.
        slots: w.slots.map(a => ({ attempt: a.attempt, workspace: a.workspace, run: `${a.workflow}/${a.run}`, uid: uidOf(a.workspace, `${a.workflow}/${a.run}`), stopRequested: a.stopRequested, lane: a.lane })), lanes: w.lanes,
        queued: w.queued.length, waiting: w.queued.filter(j => j.note).map(j => ({ job: j.id, run: `${j.workflow}/${j.run}`, note: j.note! })), profiles: w.profiles })),
      workspaces, runs, problems,
    }
  }

  // A run with nothing left to watch: completed or cancelled, nothing
  // unpublished or unintegrated, no recovery since its last attempt.
  private settled(r: ObservedRun): boolean {
    if (r.source.state !== 'ok' || r.problems.length) return false
    const terminal = r.execution?.state === 'completed' || r.cancelled
    if (!terminal) return false
    if (r.publication.failed.length || r.publication.attention.length || r.publication.pending.length) return false
    if (Object.entries(r.integration).some(([k, v]) => k !== 'refused' && v.length)) return false
    if (r.recoveries.length && r.recoveries.at(-1)!.seq > (r.attempts.beganSeq ?? 0)) return false
    return !r.attempts.open
  }

  async observeRun(ws: Workspace, ref: RunRef, groups: Map<number, { members: number; cpuSeconds: number }> | string, now: () => Date, between?: (ref: RunRef) => Promise<void>): Promise<ObservedRun> {
    const unavailable: Record<string, string> = {}
    const problems: ObservedRun['problems'] = []
    const source = await sourceOf(ws, ref)
    const blank = (state: SourceState, problem: string | null, location: 'copy' | 'workspace'): ObservedRun => ({
      identity: { project: '', workspace: ws.reg.id, workflow: ref.workflow, run: ref.run, creation: '', uid: '', created: '', receipt: null, branch: null },
      source: { state, problem, location, readAt: now().toISOString(), reads: 1, consistent: true },
      seq: null, updated: null, situation: null, execution: null, hold: null, stop: null, cancelled: null,
      attempts: { count: 0, beganSeq: null, open: null, last: null }, session: null, process: null, queue: { job: null, position: null, ahead: [] },
      inputs: { questions: [], answeredNotTakenUp: [], instructionsPending: 0 }, waiting: null, progress: null, recoveries: [],
      publication: { failed: [], attention: [], pending: [] }, integration: { queued: [], running: [], failed: [], refused: [], attention: [] },
      input: { kind: 'unknown', requester: null, source: null }, executor: null, problems, unavailable: { record: problem ?? state },
    })
    if (source.state !== 'ok') return this.withRows(blank(source.state, source.problem, source.location), ws, ref, groups)
    // Record, rows, record again: a transition in between is read again.
    let reads = 0
    let rec: RunRecord | undefined
    let rows: ReturnType<ExecStore['runRows']> | null = null
    let consistent = false
    let readProblem: string | null = null
    let policy: 'fresh' | 'run' = 'fresh'
    for (; reads < MAX_READS && !consistent;) {
      reads++
      const first = await readRun(ws, ref).catch(e => ({ record: undefined, problem: { message: (e as Error).message }, bundle: undefined }))
      if (!first.record) { readProblem = first.problem?.message ?? 'the record cannot be read'; break }
      policy = sessionPolicyOf(first.bundle?.entries[first.record.definition.root]?.workflow?.execution)
      rows = this.exec ? this.exec.runRows(ws.reg.id, ref) : null
      if (between) await between(ref)
      const second = await readRun(ws, ref).catch(() => ({ record: undefined }))
      rec = second.record ?? first.record
      consistent = !!second.record && second.record.seq === first.record.seq && (second.record.control.attempt?.id ?? null) === (first.record.control.attempt?.id ?? null)
    }
    if (!rec) return this.withRows(blank('unreadable', readProblem, source.location), ws, ref, groups)
    const r = rec
    const openJob = rows?.jobs.find(j => j.state === 'queued' || j.state === 'claimed') ?? null
    const hold = r.control.hold
    const out: ObservedRun = {
      identity: {
        project: r.project, workspace: ws.reg.id, workflow: r.workflow, run: r.run, creation: creationOf(r),
        uid: `${r.project}/${r.workflow}/${r.run}#${creationOf(r)}`, created: r.created,
        receipt: r.history[0]?.receipt ?? null, branch: r.storage?.branch ?? null,
      },
      source: { ...source, readAt: now().toISOString(), reads, consistent },
      seq: r.seq, updated: r.updated, situation: situation(r),
      execution: {
        state: r.execution.state, ready: r.execution.ready, active: r.execution.active, failed: r.execution.failed, blocked: r.execution.blocked,
        waiting: r.execution.waiting.map(w => ({ node: w.node, on: w.on, holder: w.holder, since: nodeSince(r, w.node), deadline: r.nodes[w.node]?.wait?.deadline ?? null })),
      },
      hold: hold ? { kind: hold.kind, since: hold.since, by: hold.by, reason: hold.reason, because: hold.because ?? null, human: hold.kind === 'stopped' } : null,
      stop: r.control.stop, cancelled: r.cancelled,
      attempts: {
        count: r.control.attempts,
        beganSeq: [...r.history].reverse().find(e => e.op === 'attempt.begin')?.seq ?? null,
        open: r.control.attempt ? { id: r.control.attempt.id, began: r.control.attempt.began, reason: r.control.attempt.reason, backend: r.control.attempt.backend, agent: r.control.attempt.settings?.agent ?? r.executor.name } : null,
        last: r.control.last ? { id: r.control.last.id, outcome: r.control.last.outcome, ended: r.control.last.ended, detail: r.control.last.detail } : null,
      },
      session: sessionFacts(r, policy),
      process: null,
      queue: { job: openJob ? { id: openJob.id, kind: openJob.kind, state: openJob.state, created: openJob.created, reason: openJob.reason, receipt: openJob.receipt } : null, position: null, ahead: [] },
      inputs: {
        questions: Object.values(r.questions).map(q => ({ id: q.id, node: q.node, to: q.to, asked: q.asked, state: questionState(q) })),
        answeredNotTakenUp: Object.values(r.questions).filter(q => questionState(q) === 'answered').map(q => q.id),
        instructionsPending: Object.values(r.instructions ?? {}).filter(i => !i.ack).length,
      },
      waiting: waitingOf(r, openJob),
      progress: progressOf(r),
      recoveries: r.history.filter(e => (e.op as string) === 'run.recover').map(e => { const x = e as unknown as { seq: number; at: string; by: string; incident: string; attempt: string; agent?: unknown }; return { seq: x.seq, at: x.at, by: x.by, incident: x.incident, attempt: x.attempt, agent: x.agent ?? null } }),
      publication: { failed: [], attention: [], pending: [] },
      integration: { queued: [], running: [], failed: [], refused: [], attention: [] },
      input: { kind: r.input.kind, requester: r.input.requester ?? null, source: r.input.source ?? null },
      executor: { name: r.executor.name, host: hostOf(r.executor), node: this.exec ? this.exec.nodeOf(r) : r.executor.node ?? null, lane: r.executor.lane ?? DEFAULT_LANE },
      problems, unavailable,
    }
    if (!consistent) problems.push({ code: 'changing', message: `the record changed while it was read ${reads} times; its facts may straddle a transition` })
    if (!rows) unavailable.executor = 'execution is not configured on this host'
    if (r.delegations) out.delegations = await this.delegationFacts(r).catch(e => { unavailable.delegations = (e as Error).message; return [] })
    return this.withRows(out, ws, ref, groups, rows ?? undefined, r)
  }

  // A run's delegations (p10): each child read from its own record, the
  // parent's untaken facts, the child's facts the relay has not recorded on
  // the parent yet, and the request's delivery from the notifier's journal.
  // Reads only.
  private async delegationFacts(r: RunRecord): Promise<DelegationFacts[]> {
    const { childFacts, delegationState, isOpenDelegation, WAKING } = await import('../shared/delegation.ts')
    const regs = (await loadRegistry(this.registryFile)).workspaces
    const notifyFile = join(this.exec?.ctx.area ?? dirname(this.registryFile), '.local', 'notify', 'notify.sqlite')
    let db: DatabaseSync | null = null
    try { if (existsSync(notifyFile)) db = new DatabaseSync(notifyFile, { readOnly: true }) } catch { db = null }
    try {
      const out: DelegationFacts[] = []
      for (const d of Object.values(r.delegations ?? {})) {
        let child: DelegationFacts['child'] = null
        let unrelayed: DelegationFacts['unrelayed'] = []
        let problem: string | null = null
        if (d.child) {
          const reg = regs.find(w => w.id === d.child!.workspace)
          const cref = { workflow: d.child.workflow, run: d.child.run }
          const c = reg ? (await readRun(new Workspace(reg), cref).catch(() => null))?.record : undefined
          if (!c) problem = `the child ${d.child.project} ${cref.workflow}/${cref.run} cannot be read here`
          else if (`${c.project}/${c.workflow}/${c.run}#${creationOf(c)}` !== d.child.uid) problem = `the child's record is another run now (bound ${d.child.uid})`
          else {
            child = { uid: d.child.uid, workspace: d.child.workspace, ref: `${cref.workflow}/${cref.run}`, situation: situation(c), execution: c.execution.state, waitingFor: c.execution.waiting.map(w => w.holder), hold: c.control.hold?.kind ?? null, failed: c.execution.failed }
            const recorded = new Set(r.history.map(h => h.receipt).filter(Boolean))
            if (isOpenDelegation(d) && !r.cancelled) unrelayed = childFacts(d.uid, c, 0).filter(f => !recorded.has(f.receipt)).map(f => ({ type: f.event.type, childSeq: f.event.child.seq, at: f.due, wakes: WAKING.has(f.event.type) }))
          }
        }
        let delivery: DelegationFacts['delivery'] = null
        if (db && !d.child) {
          const id = `${r.project}/${r.workflow}/${r.run}#${d.dispatched.seq}:delegation-request@${d.id}`
          const row = db.prepare('SELECT o.state AS ostate, o.created AS created, d.state AS dstate, d.last_error AS error, d.message_id AS message, d.uncertain AS uncertain FROM outbox o LEFT JOIN delivery_events e ON e.event = o.id LEFT JOIN deliveries d ON d.id = e.delivery WHERE o.id = ?').get(id) as { ostate: string; created: string; dstate: string | null; error: string | null; message: number | null; uncertain: number | null } | undefined
          delivery = row ? { state: row.dstate ? `${row.dstate}${row.uncertain ? ' (may have been posted)' : ''}` : row.ostate === 'sent' ? 'sent' : 'queued', error: row.error, message: row.message, since: row.created } : { state: 'not-queued', error: null, message: null, since: d.dispatched.at }
        }
        out.push({
          id: d.id, uid: d.uid, node: d.node, state: delegationState(d), target: `${d.target.project}/${d.target.workflow}`, dispatchedAt: d.dispatched.at, closed: !isOpenDelegation(d),
          child, pending: d.events.filter(e => e.wakes && !e.takenUp).map(e => ({ n: e.n, type: e.type, at: e.at })), unrelayed, delivery, problem,
        })
      }
      return out
    } finally { db?.close() }
  }

  // The executor's facts of one run: its process (the open or last
  // attempt), publication and integration problems.
  private async withRows(out: ObservedRun, ws: Workspace, ref: RunRef, groups: Map<number, { members: number; cpuSeconds: number }> | string, given?: ReturnType<ExecStore['runRows']>, rec?: RunRecord): Promise<ObservedRun> {
    const rows = given ?? (this.exec ? this.exec.runRows(ws.reg.id, ref) : null)
    if (!rows) return out
    if (!out.queue.job) { const j = rows.jobs.find(x => x.state === 'queued' || x.state === 'claimed'); if (j) out.queue.job = { id: j.id, kind: j.kind, state: j.state, created: j.created, reason: j.reason, receipt: j.receipt } }
    const a: AttemptRow | undefined = rows.attempts.find(x => x.state !== 'ended') ?? rows.attempts.at(-1)
    if (a) {
      const remote = this.exec?.isRemote(a.worker) ?? false
      const local = !remote && a.host === hostname()
      const isOpen = a.state !== 'ended'
      const group = local && isOpen && a.pid && typeof groups !== 'string' ? groups.get(a.pid) ?? { members: 0, cpuSeconds: 0 } : null
      if (local && isOpen && typeof groups === 'string') out.unavailable['process.group'] = groups
      // A remote worker's process is its own (p7): its log is shipped here, its
      // liveness is what the worker last reported.
      if (remote) {
        const w = this.exec!.workersState().find(x => x.id === a.worker)
        if (isOpen) out.unavailable.process = `attempt ${a.id} runs on worker ${a.worker} (${a.host}); its process is that worker's to observe — last contact ${w?.at ?? 'never'}${w?.ageSeconds != null ? ` (${Math.round(w.ageSeconds)} s ago, ${w.state})` : ''}`
      } else if (!local) out.unavailable.process = `attempt ${a.id} runs on ${a.host}; its process and log are observable there only`
      let log: ProcessFacts['log'] = null
      if ((local || remote) && a.log) {
        const [act, facts] = await Promise.all([activityOf(a.log).catch(e => ({ problem: (e as Error).message, last: null, bytes: 0, count: null, unit: null })), logFacts(a.log).catch(() => null)])
        log = { last: act?.last ?? null, bytes: act?.bytes ?? 0, turns: act?.count ?? null, session: facts?.session ?? null, problem: act?.problem ?? null, openTool: facts?.openTool ?? null, ended: facts?.ended ?? null, backgroundStopped: facts?.backgroundStopped ?? 0, partial: facts?.partial ?? false }
      }
      const ses = rec?.sessions?.find(x => x.attempts.includes(a.id))
      out.process = {
        attempt: a.id, state: a.state, host: a.host, local, pid: a.pid, alive: !isOpen ? false : local ? alive(a.pid) : null,
        began: a.began, ended: a.ended, exit: a.exit_code, signal: a.signal, outcome: a.outcome, stopRequested: a.stop_requested,
        group, log, session: ses ? { id: ses.id, resumed: ses.attempt !== a.id } : null,
      }
    }
    // A checkpoint superseded by a later published one of the same run is history, not a problem.
    const lastPublished = Math.max(0, ...rows.checkpoints.filter(c => c.state === 'published' || c.state === 'nothing').map(c => c.id))
    for (const c of rows.checkpoints) {
      if (c.id < lastPublished) continue
      const f = { id: c.id, kind: c.kind, state: c.state, error: c.error, updated: c.updated }
      if (c.state === 'failed') out.publication.failed.push(f)
      else if (c.state === 'attention') out.publication.attention.push(f)
      else if (c.state === 'pending') out.publication.pending.push(f)
    }
    for (const i of rows.integrations) {
      const k = i.state as keyof ObservedRun['integration']
      if (k in out.integration) out.integration[k].push({ id: i.id, decision: i.decision, error: i.error, updated: i.updated })
    }
    return out
  }
}

export const runKeyOf = (r: ObservedRun) => runKey({ workflow: r.identity.workflow, run: r.identity.run })

// agent_session p1: what the record says of the run's sessions.
function sessionFacts(r: RunRecord, policy: 'fresh' | 'run'): SessionFacts {
  const all = r.sessions ?? []
  const last = all.at(-1)
  const cur = last && last.state === 'open' ? last : null
  return {
    policy,
    current: cur ? { id: cur.id, began: cur.began, attempts: cur.attempts, attached: cur.attached ?? null, mismatch: !!cur.mismatch } : null,
    count: all.length,
    ended: all.filter(x => x.state !== 'open').slice(-3).map(x => ({ id: x.id, state: x.state, at: x.ended?.at ?? '', by: x.ended?.by ?? '', reason: x.ended?.reason ?? '' })),
  }
}
