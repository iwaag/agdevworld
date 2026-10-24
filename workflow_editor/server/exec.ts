// Execution management on this host (p4): the queue, the execution slots,
// execution attempts, publication checkpoints and the executors' heartbeats.
// Since project_migration p7 this host is the coordinator of several
// execution nodes (workers, server/workers.ts): one slot per worker (and,
// since p8, the extra slots of the lanes it declares), each
// job claimed only by the worker its run is assigned to, every report fenced
// by the attempt and the worker that owns it.
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
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, posix } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_LANE, sessionPolicyOf, type Workflow } from '../shared/model.ts'
import { attemptContext, renderContext, type AttemptContext } from '../shared/context.ts'
import { contextErrors, resolveContext } from './context.ts'
import { ContextStore } from './contextStore.ts'
import { configChanges, currentSession, unverifiedReason, unverifiedSession, describeSteps, effectiveOf, holderOf, hostOf, openCorrections, pendingInstructions, runKey, sameConfig, sessionConfig, situation, type AttemptSession, type AttemptSettings, type BecauseRef, type RecoveryAgent, type RunRecord, type RunRef } from '../shared/run.ts'
import { git } from './git.ts'
import { docStepsOf } from '../shared/compile.ts'
import { assertWorkspaceAllowed, loadBoundary } from './boundary.ts'
import type { Gitea } from './gitea.ts'
import { baseline, publish, publishRun, type Baseline, type RepoStep } from './publish.ts'
import { guardsFor, integrate, type Guard, type IntegrationState, type IntegrationStep } from './integrate.ts'
import { loadRegistry, observe, type Registration } from './registry.ts'
import { catalogOf, createRunInCopy, listRuns, readRun, RUN_FILE, runDir, runOp } from './runs.ts'
import { readCopy, runSpace } from './runspace.ts'
import { withLock } from './lock.ts'
import { catalogBrief } from '../shared/catalog.ts'
import { activityOf } from './activity.ts'
import { DelegateStore, assessDelegation } from './delegate.ts'
import { ReviewHost } from './reviews.ts'
import { hostOwes, openContinuations, owedContinuation, roundLine, roundOf, startedInstances } from '../shared/humanReview.ts'
import { assessmentLines } from '../shared/assessment.ts'
import { delegationState, isOpenDelegation, pendingEvents } from '../shared/delegation.ts'
import { named, openStore, transaction } from './sqlite.ts'
import { briefedSteps, changeLines, newStepLines, pendingAnswerLines, stateLines } from './continuation.ts'
import { RequestError, Workspace } from './workspace.ts'
import { alignRecordCopy, isLocalNode, laneOn, loadWorkers, nodeOfRecord, workerTree, type WorkersConfig } from './workers.ts'

export const EXECUTOR = 'autolab'

// What the execution host says about itself when it claims (p6): the
// profiles it can launch (name → backend label) and the common workflow
// contract it composes every prompt from. A run's workflow chooses among the
// profiles; the host never launches one it does not have.
//
// sessions (agent_session p1): per profile name ('' = the host's default
// profile), how its harness keeps conversations — `explicit`: a session is
// created under a caller-chosen id and resumed by that id. A profile absent
// here keeps no conversation the host can resume: the `run` policy is
// refused for it, and `fresh` attempts carry no session id.
// What the views say about one worker (p7).
// `busy` is the default lane's slot (what it was before p8); `slots` every
// open attempt of the worker with its lane, `lanes` the capacity per lane.
export interface WorkerState { id: string; label: string; local: boolean; default: boolean; state: 'available' | 'unavailable' | 'unknown'; at: string | null; ageSeconds: number | null; pid: number | null; reported: string | null; detail: string
  busy: { attempt: string; workspace: string; workflow: string; run: string; state: string; stopRequested: string | null } | null
  slots: { attempt: string; workspace: string; workflow: string; run: string; state: string; stopRequested: string | null; lane: string }[]
  lanes: Record<string, number>
  queued: { id: number; workspace: string; workflow: string; run: string; kind: string; note: string | null }[]
  profiles: string[] | null; facts: WorkerFacts | null }
export interface HostOffer { profiles?: Record<string, string>; contract?: { name: string; sha256: string }; sessions?: Record<string, 'explicit'> }
// What a worker says about itself (p7) beside its offer: a label, where its
// run copies are, the facts of its host an agent works under (OS, tools,
// display) and the software it runs. Shown in briefs and views; not a gate.
export interface WorkerFacts { label?: string; root?: string; host?: Record<string, string>; software?: Record<string, string> }
// How a remote worker sees one run (p7): its own copy, never the
// coordinator's paths.
export interface WorkerView { worker: string; root: string; facts: WorkerFacts }
// Options of a claim (p7): which worker claims (default: the local one), the
// worker's own receipt for this claim (a retransmitted claim gets the same
// answer) and its facts; p8: the lane it claims in (default: `default`).
export interface ClaimOptions { worker?: string; receipt?: string; facts?: WorkerFacts; lane?: string }
// The repositories a remote worker materializes (p7): per repository of the
// copy, its run branch at the commit the coordinator published at dispatch.
export interface DispatchRepo { path: string; kind: string; initialized: boolean; branch: string | null; target: string | null; base: string | null; head: string | null; url: string | null }
// What one attempt is launched with: the recorded settings plus the context
// text the host composes into the prompt.
// session: the conversation this attempt is launched in (agent_session p1);
// a resumed session gets a continuation prompt, a new one the whole bootstrap.
// context (workflow_editor p13, docs/context.md): the scoped context the
// attempt is prepared with, resolved once at claim and persisted as a local
// snapshot; `text` is the snapshot's rendered section, the exact bytes the
// host composes after its common contract (only identities and hashes are
// recorded in run.json).
export interface AttemptExecution { agent: string; profile: string | null; backend: string | null; context: AttemptContext & { text: string }; session?: AttemptSession }

// What the run's frozen documentation policy asks of this attempt (p5): the
// policy, and for every documentation step that is running or ready, its
// purpose, its document and the instructions frozen with the run.
export function documentationBrief(r: RunRecord): string[] {
  const eff = effectiveOf(r) // the revision in force (p7)
  if (!eff) return ['Documentation policy: none (this run was created before p5); plans and reports are available as optional records.']
  const d = docStepsOf(eff)
  if (!d.plan && !d.reports && !d.final) return [`Documentation policy: ${eff.policy}. No plan or report is a step of this run; documents can still be written when useful.`]
  // The steps this run has (p8/ex2: any of the three), by name.
  const named = [d.plan && '_plan', d.reports && '_report.<node>', d.final && '_final-report'].filter(Boolean).join(', ')
  const absent = [!d.plan && 'no plan talk', !d.reports && 'no per-node reports', !d.final && 'no final report'].filter(Boolean)
  const out = [`Documentation policy: ${eff.policy} (${describeSteps(d)}). ${named} ${named.includes(',') ? 'are steps' : 'is a step'} of this run, recorded like any node (start, complete); each is optional; available documents are recorded by hash.${absent.length ? ` This run has ${absent.join(' and ')}: documents can still be written when useful.` : ''}`]
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
// works; wfe run state shows them. Acknowledgment is a record, not a gate (p11).
// Challenges the input carried (challenge p1, docs/challenges.md): each as
// it was when attached, its summary in the run folder, and how to read its
// files and trials then and its current revision — a separate, explicit read.
export function attachmentBrief(r: RunRecord, dir: string): string[] {
  const all = r.input.attachments ?? []
  if (!all.length) return []
  return [`Attached to the ${r.input.kind === 'request' ? 'request' : 'person\'s words'} (${all.length}): durable challenges, each as it was when attached (wfe challenge help):`,
    ...all.map(a => `- ${a.id} "${a.title}" at ${a.commit.slice(0, 12)}: ${dir}/${a.file}; its files and trials then: wfe challenge show ${a.id} --at ${a.commit.slice(0, 12)}; its latest revision: wfe challenge show ${a.id}`)]
}
// Challenges carried by an answer's or an instruction's source.
export const attachedLines = (s: import('../shared/intake.ts').SourceRef | undefined, indent = '    ') =>
  s?.kind === 'conversation' && s.attachments?.length ? s.attachments.map(a => `${indent}attached: ${a.id} "${a.title}" at ${a.commit.slice(0, 12)} — wfe challenge show ${a.id} --at ${a.commit.slice(0, 12)}`) : []

export function instructionBrief(r: RunRecord): string[] {
  const all = Object.values(r.instructions ?? {})
  if (!all.length) return []
  const pending = pendingInstructions(r)
  if (!pending.length) return [`Additional instructions: ${all.length}, all acknowledged (wfe run instructions <run>).`]
  return [
    '', `Additional instructions received and not yet acknowledged (${pending.length}); optional acknowledgment records what you will do (wfe run ack <run> <id>… --response incorporate|clarify|new-run --note …):`,
    ...pending.flatMap(i => [`- ${i.id}, from ${i.from} at ${i.at}${i.during.length ? ` (while ${i.during.join(', ')} ran)` : ''}:`, ...i.text.split('\n').map(l => `    ${l}`), ...attachedLines(i.source)]),
  ]
}
// The run's presentations as the attempt starts (p7): which revision each
// is, its recorded state, and which questions asked about it. Whether one
// is served now is `wfe present status <run>`.
// Shared areas (project_migration p6, docs/shares.md): the references the
// input wrote and the run's input sets and outputs, with this host's state.
// A continued attempt first re-checks each input set (sizes, bounded) and
// records what it found, so a changed or missing set is a recorded fact and
// never silently consumed.
async function shareBrief(ws: Workspace, ref: RunRef, r: RunRecord, check: { by: string } | null, view: WorkerView | null = null): Promise<string[]> {
  if (!r.input.references?.length && !r.inputs && !r.outputs) return []
  const m = await import('./shares.ts')
  const run = runKey(ref)
  if (check) {
    for (const i of Object.values(r.inputs ?? {})) {
      const found = await m.verifyInput(ws, ref, i.id, { by: check.by, via: 'exec', quick: true }).catch(e => ({ record: null, status: 'missing' as const, detail: (e as Error).message }))
      if (found.record) r = found.record
      else i.last = { at: new Date().toISOString(), by: check.by, status: found.status, detail: found.detail }
    }
  }
  const a = await m.availability(r).catch(() => null)
  const out = ['', `Shared areas (wfe run inputs / outputs ${run}; wfe share):`]
  const where = view ? 'on the coordinator (wfe share resolve says where it is on this node)' : 'on this host'
  for (const [k, x] of (r.input.references ?? []).entries()) out.push(`  the input names ${x.ref} — ${a?.references[k]?.state ?? 'unknown'} ${where}`)
  for (const i of Object.values(r.inputs ?? {})) out.push(`  input set ${i.id} from ${i.ref}: ${i.count} files, ${i.digest.slice(0, 19)}…, ${i.staging === 'copy' ? `staged in .local/inputs/${i.id}/ of your copy` : 'read in place on the share'}; last check ${i.last ? `${i.last.status}${i.last.status !== 'verified' ? ` — ${i.last.detail}. Do not work from it as if it were the selected set: select again (a new set) or report it` : ''}` : 'none'}`)
  for (const o of Object.values(r.outputs ?? {})) out.push(`  output ${o.id} (${o.candidate}) "${o.title}": ${o.digest.slice(0, 19)}… at ${o.ref}; last check ${o.last?.status ?? 'none'}`)
  if (r.input.references?.length && !r.inputs) out.push(`  No input set is selected yet: wfe run input ${run} <node> --ref <reference> records exactly what you use.`)
  return out
}

// The facts a remote worker offered about its host (p7), for the brief.
function workerFactLines(f: WorkerFacts): string[] {
  const host = Object.entries(f.host ?? {})
  return host.length ? ['This execution node:', ...host.map(([k, v]) => `  ${k}: ${v}`)] : []
}

export function presentationBrief(r: RunRecord): string[] {
  const all = Object.values(r.presentations ?? {})
  if (!all.length) return []
  return ['', 'Presentations of this run (wfe present status <run> says what is served now):',
    ...all.map(p => `- ${p.id} "${p.title}" from ${p.node}: ${p.state}${p.last ? ` (${p.last.detail})` : ''}; revision ${p.revision.slice(7, 19)}…${Object.values(r.questions).filter(q => q.presentation?.id === p.id).map(q => `; asked in ${q.id}`).join('')}`)]
}
// The run's delegations as the attempt starts (p10, docs/delegation.md):
// each with its state, the facts relayed and not yet taken up in full, and
// what is owed. A child created from a delegation is told who asked.
// `assessed` (fix6): the assessment lines of each delegation's result that
// is not taken up yet, from the file layer (ExecStore.assessedLines).
export function delegationBrief(r: RunRecord, assessed: Record<string, string[]> = {}): string[] {
  const out: string[] = []
  const ent = r.input.entrustedBy
  if (ent?.kind === 'delegation') {
    // Whom the work is for, and who relays it (fix6): misc/freework/run-001…004
    // were asked by ponderer's agent and ended with a file-path report to it;
    // the person it asked for never saw a presentation.
    const person = r.input.onBehalfOf
    out.push('', `This run was requested by another run's agent: ${r.input.requester}, delegating node ${ent.parent.node} of ${ent.parent.project}/${ent.parent.workflow}/${ent.parent.run}${person ? `, on behalf of ${person}` : ''}. Its request is ${runDir(r)}/${r.input.file}, exactly as that agent wrote it${r.input.original ? ` (the person's own words: ${runDir(r)}/${r.input.original})` : ''}.`,
      `${person ? `The work is for ${person}; ` : ''}${r.input.requester} relays between you: your questions reach it through the request topic, as they would a person (ask them --to ${r.input.requester}), and what you present reaches ${person ?? 'its person'} through it — a presentation you register and ask about is relayed with its link. A report of file paths to ${r.input.requester} is not a presentation to ${person ?? 'the person'}. Who accepts the result: ${ent.accepts === 'person' ? `${person ?? 'the person'} (their answer, relayed)` : `${r.input.requester}`}; the requesting agent records its own answers and decisions.`)
  }
  out.push(...correctionBrief(r))
  out.push(...reviewBrief(r))
  const all = Object.values(r.delegations ?? {})
  if (!all.length) return out
  out.push('', 'Delegations of this run (wfe delegate show <run> <d>; help: wfe delegate help):')
  for (const d of all) {
    out.push(`- ${d.id} from ${d.node} to ${d.target.project}/${d.target.workflow}: ${delegationState(d)}${d.child ? `; child ${d.child.workflow}/${d.child.run} in ${d.child.workspace}` : '; no child yet (the request is being delivered)'}${d.disposition ? ` — judged ${d.disposition.kind}: ${d.disposition.note}` : ''}`)
    for (const e of pendingEvents(d)) {
      out.push(`  - event ${e.n} (${e.type}${e.question ? ` ${e.question}` : ''}${e.confirms ? ', confirms the result' : e.plan ? ', agrees the plan' : ''}), not taken up:`, ...e.text.split('\n').map(l => `      ${l}`))
      if (e.document) out.push(`      document: ${e.document.path} (${e.document.sha256.slice(0, 12)})`)
      for (const f of e.subject ?? []) out.push(`      presented: ${f.path} (${f.sha256.slice(0, 12)})`)
      if (e.manifest) out.push(`      result manifest ${e.manifest.digest.slice(7, 19)}: ${e.manifest.execution}; report ${e.manifest.report?.path ?? '(none)'}; ${e.manifest.artifacts.length} artifact(s)`)
      if (e.type === 'completed' && assessed[d.id]) out.push(...assessed[d.id].map(l => `    ${l}`))
    }
    const rv = (d.revisions ?? []).at(-1)
    if (rv && delegationState(d) === 'correcting') out.push(`  - result event ${rv.event} was returned for correction (request ${rv.n}, ${rv.at}); the child continues and its next completion comes back as a new result.`)
  }
  if (all.some(d => isOpenDelegation(d) && pendingEvents(d).length)) out.push('Facts can be marked taken up (wfe delegate take-up <run> <d> <n>…); answer with wfe delegate answer, record a result judgment with wfe delegate dispose, or return a result to the same child for what it left out with wfe delegate revise. When only the child\'s work remains, end the attempt: your attempt holds your worker\'s slot, the child may need it, and its next fact resumes you.')
  return out
}

// Human reviews (p17, docs/reviews.md): a review node ready to be prepared,
// rounds and where they stand, and requested changes in full.
export function reviewBrief(r: RunRecord): string[] {
  const run = runKey(r)
  const graph = effectiveOf(r)
  const ready = r.execution.ready.filter(id => graph?.nodes[id]?.type === 'review' && !roundOf(r, id))
  const rounds = Object.values(r.reviews ?? {})
  if (!ready.length && !rounds.length) return []
  const out = ['', 'Human review (wfe review help):']
  for (const id of ready) out.push(`- ${id} is a human review node, ready: after your own review, hand the result to the person with wfe review prepare ${run} ${id} --summary "<what was done, what to check>" --subject <p1 | d1[:p2] | workspace:workflow/run:p1>…. Their review needs no process: end the attempt once your other work is done; the person starts it with one button, and approval or requested changes come back as records.`)
  for (const v of rounds) {
    out.push(`- ${roundLine(v)}`)
    if (owedContinuation(v)) {
      const handed = v.cleanup?.state === 'handed' ? startedInstances(v) : []
      out.push(`    ${v.decision!.by}${v.decision!.synthetic ? ' (a synthetic check actor)' : ''} requested changes at ${v.decision!.at}: ${v.decision!.feedback.split('\n').join('\n    ')}`,
        `    Take them up (wfe review take-up ${run} ${v.id}) and append the work as nodes after ${v.node} — your own work node, or the same child again (reopen its delegate node with wfe run start ${run} <node> --reason "…", then wfe delegate revise ${run} <d> --follow-up ${v.id} --instruction "…" --reason "…") — and a new human review node after it (wfe nodes instantiate human-review --run ${run} --after <work>), prepared with the corrected presentations. The run stays open until then. If nothing should change: wfe review take-up ${run} ${v.id} --no-change --note "why".`,
        ...(handed.length ? [`    The review left ${handed.map(x => x.instance).join(', ')} serving; it is yours now: keep it to compare, or stop it (wfe review cleanup ${run} ${v.id}). The next approval stops what is left.`] : []))
    }
  }
  return out
}

// Corrections the delegating run returned this run's result with, not yet
// addressed (fix6), in full.
export function correctionBrief(r: RunRecord): string[] {
  const open = openCorrections(r)
  if (!open.length) return []
  const run = runKey(r)
  return ['', `The delegating run returned your completed result for correction; this run is open for it again (wfe run correction ${run}):`,
    ...open.flatMap(k => [`- ${k.id} from ${k.from}${k.by !== k.from ? ` (relayed by ${k.by})` : ''} at ${k.at}, returning the result completed at seq ${k.result.seq}:`, `    why: ${k.reason.split('\n').join(' ')}`, `    add: ${k.text.split('\n').join('\n    ')}`]),
    `Add the missing work as new nodes with your ordinary adjustment (wfe nodes instantiate <template> --run ${run} --file <draft> …, then wfe run adjust ${run} --definition <draft> --reason "…") and perform it; completed work stays as it is and is not repeated to obtain a new result. Present what the person should see through a present node, take its feedback and plan its cleanup as the catalog expects. If nothing needs to change: wfe run correction ${run} ${open[0].id} --no-change --note "why". Your next completion is a new result for the delegating run.`]
}

// The attempts of a session from the last one that was given the whole
// bootstrap (the session's first attempt, or a reconstruction) on, of
// `attempts` (the session's attempts, in order).
function sinceBootstrap(r: RunRecord, attempts: string[]): string[] {
  const cur = currentSession(r)
  const out: string[] = []
  for (const a of [...attempts].reverse()) {
    out.unshift(a)
    const begin = r.history.find(e => e.op === 'attempt.begin' && (e as { attempt?: string }).attempt === a) as { settings?: AttemptSettings } | undefined
    if (a === cur?.attempt || begin?.settings?.session?.reconstruct) break
  }
  return out
}

// `operator` (project_migration p8): the executing attempt of another run
// that performs this control act (an agent operating the run, as a person would).
export interface ControlMeta { because?: BecauseRef; attempt?: string; operator?: { run: string; attempt: string } }
const controlMeta = (m: ControlMeta) => ({ ...(m.because ? { because: m.because } : {}), ...(m.attempt ? { attempt: m.attempt } : {}), ...(m.operator ? { operator: m.operator } : {}) })
const now = () => new Date().toISOString()
const posixJoin = posix.join
// The end the executor's launch gate wrote beside an attempt's log
// (`exit <code>` / `signal <name>`, project_migration p7), or null.
function exitFile(file: string): { code: number | null; signal: string | null } | null {
  let t: string
  try { t = readFileSync(file, 'utf8').trim() } catch { return null }
  const [kind, v] = t.split(/\s+/)
  if (kind === 'exit' && /^\d+$/.test(v ?? '')) return { code: Number(v), signal: null }
  if (kind === 'signal' && v) return { code: null, signal: v }
  return null
}
const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

export interface ExecContext { registryFile: string; area: string; gitea?: Gitea; executor?: string }

export interface JobRow { id: number; receipt: string; kind: 'start' | 'resume'; workspace: string; workflow: string; run: string; reason: string; state: 'queued' | 'claimed' | 'done' | 'dropped'; created: string; claimed: string | null; attempt: string | null; note: string | null; worker: string | null }
export interface AttemptRow { id: string; job: number; workspace: string; workflow: string; run: string; host: string; pid: number | null; state: 'launching' | 'running' | 'ended'; began: string; ended: string | null; exit_code: number | null; signal: string | null; outcome: string | null; log: string | null; stop_requested: string | null; backend: string | null; baseline: string | null; worker: string | null; claim: string | null; response: string | null; lane: string | null }
// One integration of an accepted result (p9, server/integrate.ts): queued
// when the acceptance exists, carried out once the run is completed and
// saved, its steps the per-repository journal.
export interface IntegrationRow { id: number; workspace: string; workflow: string; run: string; decision: number; state: 'queued' | 'running' | 'superseded' | IntegrationState; created: string; updated: string; steps: string; error: string | null; requested_by: string }
export interface CheckpointRow { id: number; workspace: string; workflow: string; run: string; kind: string; attempt: string | null; state: 'pending' | 'published' | 'nothing' | 'attention' | 'failed'; created: string; updated: string; steps: string; error: string | null; baseline: string | null; mode: 'run-copy' | 'worker' | null }

// The workflow definition in force for a run: its active adjusted revision
// (p7), or the frozen root definition.
export function activeWorkflow(rec: RunRecord, bundle: import('./runs.ts').Bundle): Workflow | undefined {
  const rev = rec.definition.active ? bundle.revisions?.find(x => x.revision === rec.definition.active)?.workflow : undefined
  return rev ?? bundle.entries[rec.definition.root]?.workflow
}

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
    }, {
      version: 2, // p9: the integration journal, one row per accepted decision of a run
      up: db => db.exec(`
        CREATE TABLE integrations (id INTEGER PRIMARY KEY, workspace TEXT NOT NULL, workflow TEXT NOT NULL, run TEXT NOT NULL, decision INTEGER NOT NULL,
          state TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, steps TEXT NOT NULL, error TEXT, requested_by TEXT NOT NULL,
          UNIQUE (workspace, workflow, run, decision));
        -- How a checkpoint publishes, fixed when it is made: 'run-copy' (its
        -- run branches) or NULL (the project workspace's branches, before p9).
        -- A retry never reinterprets an old checkpoint after its run moved.
        ALTER TABLE checkpoints ADD COLUMN mode TEXT;
      `),
    }, {
      version: 3, // project_migration p7: execution nodes. Everything recorded so far ran on the local worker.
      up: db => {
        db.exec(`
          ALTER TABLE attempts ADD COLUMN worker TEXT;
          -- the worker's receipt of the claim that made the attempt, and the
          -- claim's answer for a retransmission (remote workers)
          ALTER TABLE attempts ADD COLUMN claim TEXT;
          ALTER TABLE attempts ADD COLUMN response TEXT;
          ALTER TABLE jobs ADD COLUMN worker TEXT;
          ALTER TABLE heartbeat ADD COLUMN offer TEXT;
        `)
        const local = loadWorkers(ctx.area).local
        db.prepare('UPDATE attempts SET worker = ?').run(local)
        db.prepare('UPDATE jobs SET worker = ?').run(local)
        // The heartbeat was keyed by the executor's name; it is the local worker's.
        db.prepare('DELETE FROM heartbeat WHERE name = ?').run(local)
        db.prepare('UPDATE heartbeat SET name = ?').run(local)
      },
    }, {
      // project_migration p8: worker lanes. The lane an attempt was claimed
      // in; NULL is the default lane, which every attempt so far held.
      version: 4,
      up: db => db.exec('ALTER TABLE attempts ADD COLUMN lane TEXT'),
    }])
  }
  // The workers of this area (p7), read from <area>/workers.json when it changes.
  workers(): WorkersConfig { return loadWorkers(this.ctx.area) }
  get localWorker(): string { return this.workers().local }
  nodeOf(r: Pick<RunRecord, 'executor'>): string { return nodeOfRecord(this.workers(), r.executor) }
  isRemote(worker: string | null | undefined): boolean { return !!worker && !isLocalNode(this.workers(), worker) }
  // A report of an attempt is accepted only from the worker that owns it (p7).
  fence(attempt: string, worker?: string | null): AttemptRow {
    const a = this.attemptRow(attempt)
    if (!a) throw new RequestError(404, `no attempt ${attempt}`)
    if (worker && (a.worker ?? this.localWorker) !== worker) throw new RequestError(409, `attempt ${attempt} belongs to worker ${a.worker ?? this.localWorker}, not to ${worker}`, { code: 'attempt-foreign' })
    return a
  }
  // Whether the process of an attempt can be looked at from this process:
  // only the local worker's pids are this host's (p7).
  private localPid(a: AttemptRow): boolean { return !this.isRemote(a.worker) && a.host === hostname() }
  close() { this.db.close(); this._delegate?.close(); this._reviews?.close() }
  get logsDir() { return join(this.ctx.area, '.local', 'exec', 'logs') }
  get executor() { return this.ctx.executor ?? EXECUTOR }

  private tx<T>(f: () => T): T { return transaction(this.db, f, 'exec store') }
  private all<T>(sql: string, ...a: (string | number | null)[]): T[] { return named('exec store', 'a read', () => this.db.prepare(sql).all(...a) as T[]) }
  private one<T>(sql: string, ...a: (string | number | null)[]): T | undefined { return named('exec store', 'a read', () => this.db.prepare(sql).get(...a) as T | undefined) }
  private run(sql: string, ...a: (string | number | null)[]) { return named('exec store', 'a write', () => this.db.prepare(sql).run(...a)) }

  // The run an attempt belongs to (<workspace>/<workflow>/<run>), for
  // provenance of what an executing attempt writes elsewhere (p14 context).
  attemptRun(id: string): string | null {
    const a = this.one<{ workspace: string; workflow: string; run: string }>('SELECT workspace, workflow, run FROM attempts WHERE id = ?', id)
    return a ? `${a.workspace}/${a.workflow}/${a.run}` : null
  }

  async workspace(id: string): Promise<Workspace> {
    const reg = (await loadRegistry(this.ctx.registryFile)).workspaces.find(w => w.id === id)
    if (!reg) throw new RequestError(404, `workspace "${id}" is not registered`)
    await assertWorkspaceAllowed(await loadBoundary(this.ctx.registryFile, this.ctx.area), reg, 'Execution')
    const o = await observe(reg)
    if (!o.available) throw new RequestError(409, `workspace "${id}" is not available: ${o.reason}`)
    return new Workspace(reg)
  }

  // ---- requests and the queue ------------------------------------------------------

  // A person's request: create the run (their words as braindump.md) in its
  // own working copy and queue its start. The receipt makes a retransmitted
  // request a no-op. No other run reserves the project (p9): a held, waiting
  // or working run keeps its own copy; the execution slots (one per worker,
  // p7) are the only
  // thing requests share.
  // `input` (project_migration p8): an agent's request instead of a person's
  // words — the run's request.md, with its requester, what entrusted it, the
  // person it serves and the original words it was derived from.
  // `source`: where the person's words were said (a conversation message, p8).
  // `attachments` (challenge p1): challenges the words carried, each with its
  // file's text at the attached commit, written into the new run's folder.
  async request(o: { workspace: string; workflow: string; text: string; author: string; receipt: string; by?: string; via: string; predecessor?: RunRef; node?: string; source?: import('../shared/intake.ts').SourceRef; input?: Extract<import('./runs.ts').CreateRunOptions['input'], { kind: 'request' }>; attachments?: import('./runs.ts').PinnedAttachment[] }): Promise<{ job: JobRow; ref: RunRef; duplicate: boolean }> {
    if (!/^[A-Za-z0-9:._/#-]{8,200}$/.test(o.receipt)) throw new RequestError(400, 'a request needs a receipt id (8–200 of A-Z a-z 0-9 : . _ / # -)')
    const seen = this.one<JobRow>('SELECT * FROM jobs WHERE receipt = ?', `request:${o.receipt}`)
    if (seen) return { job: seen, ref: { workflow: seen.workflow, run: seen.run }, duplicate: true }
    const ws = await this.workspace(o.workspace)
    // The run gets its own working copy (p9); the same receipt finds it again.
    const env = this.ctx.gitea ? await this.ctx.gitea.gitEnv() : {}
    const attachments = o.attachments?.length ? { attachments: o.attachments } : {}
    const created = await createRunInCopy(ws, { workflow: o.workflow, input: o.input ? { ...o.input, ...attachments } : { kind: 'braindump', text: o.text, author: o.author, recordedBy: o.by, ...(o.source ? { source: o.source } : {}), ...attachments }, executor: { host: this.executor, ...(o.node ? { node: o.node } : {}) }, by: o.by ?? o.author, via: o.via, area: this.ctx.area, receipt: `request:${o.receipt}`, ...(o.predecessor ? { predecessor: o.predecessor } : {}) }, env)
    const job = this.enqueue(ws.reg.id, created.ref, 'start', `request:${o.receipt}`, o.input ? `start: ${o.input.requester}'s request` : 'start: the person\'s request', this.nodeOf(created.record))
    return { job, ref: created.ref, duplicate: false }
  }

  // Queues one job; an existing job with the same receipt, or a queued or
  // claimed job of the same run, is returned instead.
  // `worker`: the node the run is assigned to, when the caller knows it (a
  // view fact; the claim reads the record again).
  enqueue(workspace: string, ref: RunRef, kind: 'start' | 'resume', receipt: string, reason: string, worker: string | null = null): JobRow {
    return this.tx(() => {
      const same = this.one<JobRow>('SELECT * FROM jobs WHERE receipt = ?', receipt)
      if (same) return same
      const open = this.one<JobRow>('SELECT * FROM jobs WHERE workspace = ? AND workflow = ? AND run = ? AND state IN (\'queued\', \'claimed\')', workspace, ref.workflow, ref.run)
      if (open) return open
      const id = Number(this.run('INSERT INTO jobs (receipt, kind, workspace, workflow, run, reason, state, created, worker) VALUES (?, ?, ?, ?, ?, ?, \'queued\', ?, ?)', receipt, kind, workspace, ref.workflow, ref.run, reason, now(), worker).lastInsertRowid)
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
    return this.enqueue(ws.reg.id, ref, 'resume', `answer:${ws.reg.id}/${runKey(ref)}/${question}/${q.answers.length - 1}`, `resume: answer ${q.answers.length - 1} to ${question} recorded`, this.nodeOf(r))
  }

  // After an instruction is recorded (project_migration p8): a run nobody is
  // executing now — waiting on a question, a delegation or an external result,
  // or left with ready work — is continued so its agent reads the instruction
  // at once instead of at whatever wakes it next. One job per instruction; a
  // held, cancelled, completed or executing run is left as it is (the open
  // attempt reads it at its next boundary, a hold waits for its resume).
  async afterInstruction(ws: Workspace, ref: RunRef, instruction: string): Promise<JobRow | null> {
    const r = (await readRun(ws, ref)).record
    if (!r || hostOf(r.executor) !== this.executor || r.cancelled || r.control.hold || r.control.attempt) return null
    const ins = r.instructions?.[instruction]
    if (!ins || ins.ack || r.execution.state === 'completed') return null
    return this.enqueue(ws.reg.id, ref, 'resume', `instruction:${ws.reg.id}/${runKey(ref)}/${instruction}`, `resume: instruction ${instruction} received`, this.nodeOf(r))
  }

  // After a correction is recorded (fix6): the completed child it reopened is
  // continued so its agent adds the work. One job per correction; a held,
  // cancelled or executing child is left as it is (the open attempt reads it
  // at its next boundary, a hold waits for its resume). Queued again by
  // reconcile while the correction is not addressed.
  async afterCorrection(ws: Workspace, ref: RunRef, correction: string): Promise<JobRow | null> {
    const r = (await readRun(ws, ref)).record
    if (!r || hostOf(r.executor) !== this.executor || r.cancelled || r.control.hold || r.control.attempt) return null
    const k = r.corrections?.[correction]
    if (!k || k.addressed) return null
    return this.enqueue(ws.reg.id, ref, 'resume', `correction:${ws.reg.id}/${runKey(ref)}/${correction}`, `resume: correction ${correction} from ${k.from} (the delegating run returned the result)`, this.nodeOf(r))
  }

  // After a person requested changes in a human review (p17, docs/reviews.md):
  // the responsible agent is continued once per round to take them up;
  // queued again by reconcile and after an attempt while not addressed.
  async afterReview(ws: Workspace, ref: RunRef, review: string): Promise<JobRow | null> {
    const r = (await readRun(ws, ref)).record
    if (!r || hostOf(r.executor) !== this.executor || r.cancelled || r.control.hold || r.control.attempt) return null
    const v = r.reviews?.[review]
    if (!v || !owedContinuation(v)) return null
    return this.enqueue(ws.reg.id, ref, 'resume', `review:${ws.reg.id}/${runKey(ref)}/${review}`, `resume: changes requested in review ${review} by ${v.decision?.by ?? 'the person'}`, this.nodeOf(r))
  }
  // The host side of human reviews: starting subjects, cleanup (p17).
  private _reviews?: ReviewHost
  get reviews(): ReviewHost { return this._reviews ??= new ReviewHost({ registryFile: this.ctx.registryFile, area: this.ctx.area }) }

  // The assessment of each delegated result the run has not taken up yet
  // (fix6), as brief lines: shown once with the result, not on every attempt.
  async assessedLines(r: RunRecord): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {}
    for (const d of Object.values(r.delegations ?? {})) {
      if (!isOpenDelegation(d) || !pendingEvents(d).some(e => e.type === 'completed')) continue
      const a = await assessDelegation(this.delegate, r, d).catch(() => null)
      if (a) out[d.id] = assessmentLines(a, '')
    }
    return out
  }

  // The parent's continuation for a delegation fact (p10): one job per fact.
  private _delegate?: DelegateStore
  get delegate(): DelegateStore { return this._delegate ??= new DelegateStore({ registryFile: this.ctx.registryFile, area: this.ctx.area, exec: this }) }
  async afterDelegation(ws: Workspace, ref: RunRef): Promise<JobRow | null> { return this.delegate.continuation(ws, ref) }

  // ---- the slot ----------------------------------------------------------------------

  // Takes the oldest queued job of the claiming worker when its slot is free
  // and records the attempt's beginning in run.json. Jobs whose run is
  // cancelled, held or already open are dropped with the reason.
  // `workspace` is the logical workspace; `cwd` is where the attempt works:
  // the run's own copy (p9), or the project workspace for a run without one.
  // `brief` is the whole "This attempt" text a new session is given;
  // `continuation` (agent_session p1 ex2) the compact text an ordinary resume
  // of the run's session is given instead (null: the session is new, or it is
  // resumed for a reconstruction and gets the whole bootstrap).
  // Workers (project_migration p7): a job is claimed only by the worker its
  // run is assigned to; one another worker cannot serve is left queued for its
  // own, untouched. A job its worker cannot serve now (a profile it does not
  // offer, a dispatch that could not be published) waits with the reason in
  // its note: it is neither dropped nor given to another worker. A remote
  // worker's claim publishes the run's branches first (dispatch), carries the
  // repositories to materialize (`copy`) and a brief written for its own copy.
  // Lanes (project_migration p8): a claim is made in one lane of the worker
  // and is idle while that lane's slots are all held; it takes only the jobs
  // whose run is claimed in that lane there (laneOn: the lane its record
  // names when the worker offers it, else `default`), so a conversation is
  // answered while a long attempt holds the default slot, and the default
  // lane behaves exactly as the one slot of before.
  async claim(backend: string | null, offer: HostOffer = {}, o: ClaimOptions = {}): Promise<{ job: JobRow; attempt: AttemptRow; workspace: Registration; cwd: string; ref: RunRef; brief: string; continuation: string | null; execution: AttemptExecution; worker: string; lane: string; copy?: DispatchRepo[] } | { idle: string }> {
    const cfg = this.workers()
    const worker = o.worker ?? cfg.local
    if (!cfg.workers[worker]) throw new RequestError(404, `worker "${worker}" is not a worker of this area (${Object.keys(cfg.workers).sort().join(', ')})`, { code: 'worker-unknown' })
    const remote = this.isRemote(worker)
    const lane = o.lane ?? DEFAULT_LANE
    const capacity = cfg.workers[worker].lanes[lane]
    if (!capacity) throw new RequestError(400, `worker "${worker}" has no lane "${lane}" (${Object.keys(cfg.workers[worker].lanes).sort().join(', ')}); declare it in workers.json`, { code: 'lane-unknown' })
    const laneHeld = () => this.all<AttemptRow>('SELECT * FROM attempts WHERE state != \'ended\' AND worker = ? AND coalesce(lane, ?) = ? ORDER BY began', worker, DEFAULT_LANE, lane)
    const where = lane === DEFAULT_LANE ? '' : ` in lane ${lane}`
    if (o.receipt) {
      const again = this.one<AttemptRow>('SELECT * FROM attempts WHERE worker = ? AND claim = ?', worker, o.receipt)
      if (again?.response && again.state === 'launching') return JSON.parse(again.response)
      if (again) return { idle: `claim ${o.receipt} was answered with attempt ${again.id}, which is ${again.state}` }
    }
    const held = laneHeld()
    if (held.length >= capacity) return { idle: `the slot${capacity > 1 ? 's' : ''}${remote ? ` of ${worker}` : ''}${where} ${capacity > 1 ? 'are' : 'is'} held by ${held.map(b => `attempt ${b.id} (${b.workspace} ${b.workflow}/${b.run})`).join(', ')}` }
    const waiting: string[] = []
    for (const job of this.all<JobRow>('SELECT * FROM jobs WHERE state = \'queued\' ORDER BY id')) {
      const ref = { workflow: job.workflow, run: job.run }
      const mine = (job.worker ?? cfg.default) === worker
      const drop = (note: string) => this.run('UPDATE jobs SET state = \'dropped\', note = ? WHERE id = ?', note, job.id)
      const wait = (note: string) => { if (job.note !== note) this.run('UPDATE jobs SET note = ? WHERE id = ? AND state = \'queued\'', note, job.id); waiting.push(`job ${job.id} (${runKey(ref)}): ${note}`) }
      let ws: Workspace, space: Workspace
      try { ws = await this.workspace(job.workspace); space = await runSpace(ws, ref) } catch (e) { if (mine) drop((e as Error).message); continue }
      const reading = await readRun(space, ref)
      const rec = reading.record
      if (!rec) { if (mine) drop('the run cannot be read'); continue }
      const node = this.nodeOf(rec)
      if (job.worker !== node) this.run('UPDATE jobs SET worker = ? WHERE id = ?', node, job.id)
      if (node !== worker) continue
      // Another lane's job is left to that lane's claims, untouched (p8).
      if (laneOn(cfg.workers[worker], rec.executor.lane) !== lane) continue
      // One execution mode (p9): a run works in its own copy. A run recorded
      // in the project workspace before p9 is migrated first.
      if (!space.copyOf) { drop(`the run has no working copy of its own (recorded before p9); migrate it first (wfe runs migrate --workspace ${job.workspace})`); continue }
      if (rec.cancelled) { drop('the run is cancelled'); continue }
      if (rec.control.hold) { drop(`the run is held (${rec.control.hold.kind}); a person resumes it`); continue }
      if (rec.control.attempt) { drop(`attempt ${rec.control.attempt.id} is still open in run.json`); continue }
      const execution = await this.execution(space, rec, activeWorkflow(rec, reading.bundle), backend, offer)
      if ('refused' in execution) { if (execution.wait) wait(`waiting for worker ${worker}: ${execution.refused}`); else drop(execution.refused); continue }
      const session = this.sessionFor(rec, execution, sessionPolicyOf(reading.bundle.entries[rec.definition.root]?.workflow?.execution), offer)
      if ('refused' in session) { wait(`waiting for worker ${worker}: ${session.refused}`); continue }
      // A resumed conversation that was compacted (or whose compaction cannot
      // be ruled out) no longer reliably holds its bootstrap: it is resumed
      // with the whole bootstrap again, and the attempt records why.
      if (session.mode === 'resume') {
        const why = this.reconstructionNeeded(rec)
        if (why) session.reconstruct = why
      }
      execution.session = session
      // A remote worker materializes the run from its published branches.
      if (remote) {
        const cp = await this.checkpoint(ws.shared, ref, `dispatch to ${worker}`, null, null).catch(e => ({ state: 'failed', error: (e as Error).message, id: 0 }))
        if (cp.state !== 'published' && cp.state !== 'nothing') { wait(`dispatch to ${worker}: the run's branches could not be published (checkpoint ${cp.id || '—'}: ${cp.state}${cp.error ? `, ${cp.error}` : ''})`); continue }
      }
      const id = `a${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
      const label = remote ? (o.facts?.label || cfg.workers[worker].label) : hostname()
      const claimed = this.tx(() => {
        if (laneHeld().length >= capacity) return false
        const r = this.run('UPDATE jobs SET state = \'claimed\', claimed = ?, attempt = ? WHERE id = ? AND state = \'queued\'', now(), id, job.id)
        if (Number(r.changes) !== 1) return false
        this.run('INSERT INTO attempts (id, job, workspace, workflow, run, host, state, began, backend, worker, claim, lane) VALUES (?, ?, ?, ?, ?, ?, \'launching\', ?, ?, ?, ?, ?)', id, job.id, job.workspace, job.workflow, job.run, label, now(), execution.backend, worker, o.receipt ?? null, lane === DEFAULT_LANE ? null : lane)
        return true
      })
      if (!claimed) return { idle: 'another executor claimed it first' }
      const base: Baseline = space.copyOf ? {} : await baseline(ws) // a copy holds only the run's own work
      try {
        // The run's catalog snapshot (p7/ex1): every attempt is given the same one.
        const cat = rec.context?.catalog
        const catalog = cat ? (cat.state === 'supplied' ? { state: 'supplied' as const, sha256: cat.sha256, templates: cat.templates } : { state: 'unavailable' as const }) : undefined
        const settings: AttemptSettings = { agent: execution.agent, profile: execution.profile, backend: execution.backend, contract: offer.contract ?? null, context: { snapshot: execution.context.snapshot, fingerprint: execution.context.fingerprint, sources: execution.context.sources }, ...(catalog ? { catalog } : {}), ...(execution.session ? { session: execution.session } : {}) }
        await runOp(space, ref, { op: 'attempt.begin', attempt: id, reason: job.kind, ...(execution.backend ? { backend: execution.backend } : {}), settings }, { by: this.executor, via: 'exec' })
      } catch (e) {
        this.run('UPDATE attempts SET state = \'ended\', ended = ?, outcome = \'refused\' WHERE id = ?', now(), id)
        this.run('UPDATE jobs SET state = \'dropped\', note = ? WHERE id = ?', `attempt refused: ${(e as Error).message}`, job.id)
        continue
      }
      this.run('UPDATE attempts SET baseline = ?, log = ? WHERE id = ?', JSON.stringify(base), join(this.logsDir, `${id}.jsonl`), id)
      const view: WorkerView | null = remote ? { worker, root: workerTree(o.facts?.root ?? '', job.workspace, ref), facts: o.facts ?? {} } : null
      const continuation = execution.session?.mode === 'resume' && !execution.session.reconstruct ? await this.continuation(space, ref, job, view) : null
      const answer = { job: this.one<JobRow>('SELECT * FROM jobs WHERE id = ?', job.id)!, attempt: this.attemptRow(id)!, workspace: ws.reg, cwd: space.root, ref, brief: await this.brief(space, ref, job, view), continuation, execution, worker, lane, ...(remote ? { copy: await this.dispatchCopy(ws, ref) } : {}) }
      if (remote) this.run('UPDATE attempts SET response = ? WHERE id = ?', JSON.stringify({ ...answer, attempt: { ...answer.attempt, response: null } }), id)
      return answer
    }
    return { idle: waiting.length ? `nothing ${worker}${where} can take now: ${waiting.join('; ')}` : `no queued job${where}` }
  }

  // What a remote worker materializes for a run (p7): every repository of
  // the run's copy with its run branch at the commit the dispatch published.
  async dispatchCopy(ws: Workspace, ref: RunRef): Promise<DispatchRepo[]> {
    const copy = await readCopy(ws.shared, ref)
    const out: DispatchRepo[] = []
    for (const r of copy?.manifest?.repositories ?? []) {
      const head = r.initialized && r.branch ? (await git(join(copy!.tree, r.path), ['rev-parse', '--verify', '-q', `refs/heads/${r.branch}`])).stdout.trim() || null : null
      out.push({ path: r.path, kind: r.kind, initialized: r.initialized, branch: r.branch ?? null, target: r.target ?? null, base: r.base ?? null, head, url: r.url ?? null })
    }
    return out
  }

  // The settings an attempt of this run is launched with (p6), from the
  // run's frozen definition: the agent it is performed as, the host profile
  // the workflow asks for, and its scoped context (p13): resolved from the
  // run's copy, its definition in force and this area's overrides, and saved
  // as the snapshot the attempt is prepared with. A profile the host does
  // not offer, or a configured source that cannot be read, refuses the job
  // with the reason instead of launching something else.
  // `wait` (p7): the refusal is about what this worker offers, not about the
  // run; the job waits for its worker instead of being dropped.
  async execution(ws: Workspace, rec: RunRecord, workflow: Workflow | undefined, backend: string | null, offer: HostOffer): Promise<AttemptExecution | { refused: string; wait?: boolean }> {
    // A profile a person chose when resuming (project_migration p6 ex2)
    // replaces the definition's for every later attempt.
    const resumed = rec.control?.profile
    const ex = workflow?.execution
    const profile = resumed?.name || ex?.profile || null
    let chosen = backend
    if (profile && offer.profiles) {
      const asker = resumed ? `the run was resumed (seq ${resumed.seq}, by ${resumed.by}) on execution profile` : 'the workflow asks for execution profile'
      if (!(profile in offer.profiles)) return { refused: `${asker} "${profile}", which this execution host does not offer (${Object.keys(offer.profiles).sort().join(', ')})`, wait: true }
      chosen = offer.profiles[profile]
    }
    const bundle = await resolveContext(this.accessContext(), { purpose: 'execution', ws, workflow: workflow ?? null, run: rec, contract: offer.contract ?? null, host: this.executor })
    const errors = contextErrors(bundle)
    if (errors.length) return { refused: `the run's context cannot be prepared: ${errors.join('; ')}` }
    const text = renderContext(bundle)
    const saved = await new ContextStore(this.ctx.area).saveSnapshot(bundle, text)
    return { agent: rec.executor.name, profile, backend: chosen, context: { ...attemptContext(bundle, saved.id), text } }
  }

  accessContext(): import('./access.ts').AccessContext {
    return { registryFile: this.ctx.registryFile, area: this.ctx.area, gitea: this.ctx.gitea, giteaProblem: this.ctx.gitea ? undefined : 'no Gitea setting' }
  }

  // The context the next attempt of a run would be prepared with now, and
  // the one each earlier attempt was (p13): read-only; nothing is saved or
  // queued. The common contract is the host's at claim; the last attempt's
  // is shown for it.
  async nextContext(ws: Workspace, ref: RunRef) {
    const space = await runSpace(ws, ref)
    const reading = await readRun(space, ref)
    const rec = reading.record
    if (!rec) throw new RequestError(409, `run ${runKey(ref)} cannot be read: ${reading.problem?.message ?? 'no record'}`)
    const last = [...rec.history].reverse().find(e => e.op === 'attempt.begin' && (e as { settings?: AttemptSettings }).settings?.contract) as { settings?: AttemptSettings } | undefined
    return { record: rec, bundle: await resolveContext(this.accessContext(), { purpose: 'execution', ws: space, workflow: activeWorkflow(rec, reading.bundle) ?? null, run: rec, contract: last?.settings?.contract ?? null, host: this.executor }) }
  }

  // Whether the prepared context reached the launched process (p13), as
  // the execution host saw it. Fenced like every executor report.
  async contextDelivery(attempt: string, report: { delivered: boolean; detail?: string }, worker?: string) {
    const a = this.fence(attempt, worker)
    const ws = await this.workspace(a.workspace)
    const ref = { workflow: a.workflow, run: a.run }
    const space = await runSpace(ws, ref)
    const rec = (await readRun(space, ref)).record
    const c = rec?.control.attempt?.id === attempt ? rec.control.attempt.settings?.context : undefined
    if (!c) throw new RequestError(409, `attempt ${attempt} is not open with a prepared context`, { code: 'attempt-stale' })
    await runOp(space, ref, { op: 'attempt.context', attempt, event: report.delivered ? 'delivered' : 'undelivered', snapshot: c.snapshot, ...(report.detail ? { detail: report.detail } : {}), receipt: `context:${attempt}:${report.delivered ? 'delivered' : 'undelivered'}` } as never, { by: this.executor, via: 'exec' })
    return { snapshot: c.snapshot, event: report.delivered ? 'delivered' : 'undelivered' }
  }

  // The session an attempt is launched in (agent_session p1), from the run's
  // frozen policy, its recorded sessions and what the host's harness can do.
  // `run` resumes the current session when it was created under the same
  // configuration (agent, profile, backend, contract, context fingerprint
  // and sources); otherwise a
  // new one replaces it, and the reason is recorded. `run` on a profile
  // whose harness keeps no resumable conversation is refused: it never
  // silently becomes fresh. Ids are minted here (UUIDs) for harnesses that
  // take a caller-chosen id, so the record names the session before launch.
  sessionFor(rec: RunRecord, ex: AttemptExecution, policy: 'fresh' | 'run', offer: HostOffer): AttemptSession | { refused: string } {
    const capability = offer.sessions?.[ex.profile ?? ''] ?? null
    if (policy === 'run' && capability !== 'explicit') return { refused: `the workflow's session policy is "run", but ${ex.profile ? `profile "${ex.profile}"` : 'the host\'s default profile'} (${ex.backend ?? 'unknown backend'}) keeps no conversation this host can resume; choose fresh, or a profile that supports sessions` }
    const mint = () => (capability === 'explicit' ? randomUUID() : null)
    const cur = currentSession(rec)
    if (policy === 'fresh') return { policy, mode: 'new', id: mint() }
    // A session whose harness reported another id is never reused by itself.
    const unverified = unverifiedSession(rec)
    if (unverified) return { refused: unverifiedReason(unverified, runKey({ workflow: rec.workflow, run: rec.run })) }
    const now = sessionConfig({ agent: ex.agent, profile: ex.profile, backend: ex.backend, contract: offer.contract ?? null, context: ex.context })
    if (cur && cur.id && sameConfig(cur.config, now)) return { policy, mode: 'resume', id: cur.id }
    const last = rec.sessions?.at(-1)
    const replaces = cur
      ? { id: cur.id, reason: cur.id ? `configuration changed: ${configChanges(cur.config, now).join('; ') || 'not comparable'}` : 'the previous session\'s id was never reported by the harness' }
      : last?.state === 'retired' ? { id: last.id, reason: `retired: ${last.ended?.reason ?? ''}`.trim() }
        : last ? { id: last.id, reason: `the previous session ended: ${last.ended?.reason ?? last.state}` } : undefined
    return { policy, mode: 'new', id: mint(), ...(replaces ? { replaces } : {}) }
  }

  // The harness's report of the open attempt's session (agent_session p1):
  // `attached` with the id it reported; `missing` when the session to resume
  // is not on this host — nothing was launched in it yet, so a new session
  // replaces it now (a new id when the harness takes one) and the reason is
  // recorded. Fenced like every executor report: only the open attempt.
  async session(attempt: string, report: { attached?: string; missing?: string }, worker?: string): Promise<{ id: string | null; event: 'attached' | 'replaced' }> {
    const a = this.attemptRow(attempt)
    if (a) this.fence(attempt, worker)
    if (!a || a.state === 'ended') throw new RequestError(409, `attempt ${attempt} is not open on this host`, { code: 'attempt-stale' })
    const ws = await this.workspace(a.workspace)
    const ref = { workflow: a.workflow, run: a.run }
    const space = await runSpace(ws, ref)
    if (report.attached) {
      await runOp(space, ref, { op: 'attempt.session', attempt, event: 'attached', id: report.attached, receipt: `session:${attempt}:attached:${report.attached}` } as never, { by: this.executor, via: 'exec' })
      return { id: report.attached, event: 'attached' }
    }
    const rec = (await readRun(space, ref)).record
    // A repeated report (same attempt) is the replacement already recorded.
    const done = rec?.history.find(h => h.receipt === `session:${attempt}:replaced`) as { id?: string | null } | undefined
    if (done) return { id: done.id ?? null, event: 'replaced' }
    const cur = rec ? currentSession(rec) : null
    // Only a resumed session can be missing, and only explicit-id harnesses
    // resume: the replacement gets a new caller-chosen id.
    const id = randomUUID()
    await runOp(space, ref, { op: 'attempt.session', attempt, event: 'replaced', id, reason: `session ${cur?.id ?? '(unknown)'} is missing on ${a.host}${report.missing ? `: ${report.missing}` : ''}; nothing ran in it in this attempt, so a new session starts from the run's records`, receipt: `session:${attempt}:replaced` } as never, { by: this.executor, via: 'exec' })
    return { id, event: 'replaced' }
  }

  // A person or a recovering agent ends the run's current session; the next
  // attempt starts a new one (agent_session p1). Refused while any process
  // of the run lives here: a conversation has one writer at a time.
  async retireSession(ws: Workspace, ref: RunRef, by: string, reason: string, via: string, meta: ControlMeta = {}) {
    for (const a of this.all<AttemptRow>('SELECT * FROM attempts WHERE workspace = ? AND workflow = ? AND run = ?', ws.reg.id, ref.workflow, ref.run)) {
      if (a.state !== 'ended') throw new RequestError(409, `attempt ${a.id} of run ${runKey(ref)} is ${a.state}; a session is retired between attempts`, { code: 'attempt-open' })
      if (this.localPid(a) && a.pid && alive(a.pid)) throw new RequestError(409, `process ${a.pid} of attempt ${a.id} still lives`, { code: 'attempt-open' })
    }
    const space = await runSpace(ws, ref)
    return (await runOp(space, ref, { op: 'session.retire', reason, ...controlMeta(meta) } as never, { by, via })).record
  }

  // Work of these workspaces that is not finished here: queued or claimed
  // jobs and attempts that have not ended. A catalog removal waits for none.
  pendingFor(workspaces: string[]): { jobs: JobRow[]; attempts: AttemptRow[] } {
    const jobs = this.all<JobRow>('SELECT * FROM jobs WHERE state IN (\'queued\', \'claimed\')').filter(j => workspaces.includes(j.workspace))
    const attempts = this.all<AttemptRow>('SELECT * FROM attempts WHERE state != \'ended\'').filter(a => workspaces.includes(a.workspace))
    return { jobs, attempts }
  }

  attemptRow(id: string): AttemptRow | undefined { return this.one<AttemptRow>('SELECT * FROM attempts WHERE id = ?', id) }
  // Every attempt this store holds, for the usage read (server/usage.ts).
  allAttempts(): AttemptRow[] { return this.all<AttemptRow>('SELECT * FROM attempts ORDER BY began') }

  // Idempotent (p7): the same report again (a retransmission) is accepted.
  started(attempt: string, pid: number, worker?: string) {
    const a = this.fence(attempt, worker)
    if (a.state === 'running' && a.pid === pid) return
    const r = this.run('UPDATE attempts SET pid = ?, state = \'running\' WHERE id = ? AND state = \'launching\'', pid, attempt)
    if (Number(r.changes) !== 1) throw new RequestError(409, `attempt ${attempt} is not launching`)
  }

  // The facts an attempt starts from, for its prompt: what to do now and
  // where the record is. The guide (autolab's) says how.
  // `view` (p7): the attempt runs on a remote worker, in a copy of its own;
  // the brief names that copy and that host, never the coordinator's paths.
  async brief(ws: Workspace, ref: RunRef, job: JobRow, view: WorkerView | null = null): Promise<string> {
    const reading = await readRun(ws, ref)
    const r = reading.record!
    const lines = [`Run: ${r.project} / ${runKey(ref)} (record ${runDir(ref)}/run.json)`, `Agent: you perform this run as ${r.executor.name}${hostOf(r.executor) !== r.executor.name ? `; the execution host ${hostOf(r.executor)} launched you and publishes your work` : ''}.`]
    if (view && r.storage) {
      const owned = r.storage.repositories.filter(x => x.branch).map(x => x.path === '.' ? 'the root' : x.path)
      lines.push(`Working copy: ${view.root} — this run's own copy of the project on execution node ${view.worker}${view.facts.label ? ` (${view.facts.label})` : ''}; it is saved to branch ${r.storage.branch} (${owned.join(', ')}), never to a shared branch.`,
        'The run\'s record is kept by the coordinator. `wfe` here sends every run operation there; before it does, it uploads your run folder and the files you name in the command, and afterwards brings the record back into this copy. Your copy\'s run.json is that copy of the record: read it, never edit it.',
        'The person\'s project workspace and its .local/ notes are not on this node.')
      for (const line of workerFactLines(view.facts)) lines.push(line)
    } else if (ws.copyOf && r.storage) {
      const owned = r.storage.repositories.filter(x => x.branch).map(x => x.path === '.' ? 'the root' : x.path)
      lines.push(`Working copy: ${ws.root} — this run's own copy of the project; it is saved to branch ${r.storage.branch} (${owned.join(', ')}), never to a shared branch.`, `Project workspace: ${ws.shared.root} — the person's; this run reads its .local/ resources from there by name and changes nothing in it.`)
    } else lines.push(`Workspace: ${ws.root}`)
    lines.push(`Why this attempt: ${job.reason}`)
    // The original requirement and the current plan, on every attempt of a
    // new session (agent_session p1 ex2): a replacement or a fresh session
    // reconstructs from them, not only the run's first attempt.
    lines.push(`The ${r.input.kind === 'request' ? 'request' : 'person\'s request'} is ${runDir(ref)}/${r.input.file} (${r.input.kind === 'request' ? `requester ${r.input.requester}` : `author ${r.input.author}`})${r.input.original ? `; the person's own words are ${runDir(ref)}/${r.input.original}` : ''}.`)
    lines.push(...attachmentBrief(r, runDir(ref)))
    if (job.kind !== 'start' && existsSync(join(ws.root, runDir(ref), 'plan.md'))) lines.push(`The current plan is ${runDir(ref)}/plan.md${r.nodes._plan?.agreement ? ` (agreed in ${r.nodes._plan.agreement.question})` : ''}.`)
    // The run this one follows (p9): its records and saved work, to reuse,
    // repair or reverse; wfe run reversal <run> lists what its integration brought.
    if (r.predecessor) {
      const pred = await runSpace(ws.shared, r.predecessor).catch(() => null)
      const pr = pred ? (await readRun(pred, r.predecessor)).record : undefined
      lines.push(`This run follows ${runKey(r.predecessor)}: ${pr ? `its records are ${view ? 'with the coordinator' : `in ${join(pred!.root, runDir(r.predecessor))}`} (wfe run show ${runKey(r.predecessor)})${pr.storage ? `, its work saved on branch ${pr.storage.branch}` : ''}${pr.integrations?.length ? `; its result is integrated (wfe run reversal ${runKey(r.predecessor)})` : ''}.` : 'its record cannot be read on this host.'}`)
    }
    const resume = [...r.history].reverse().find(e => e.op === 'run.resume') as (RunRecord['history'][number] & { reason?: string }) | undefined
    if (job.kind === 'resume') {
      if (r.control.last) lines.push(`The previous attempt ${r.control.last.id} ended: ${r.control.last.outcome}${r.control.last.detail ? ` — ${r.control.last.detail}` : ''}.`)
      // Continued by a recovery (observer p3): who decided it, for which incident, and why.
      const rc = r.recoveries?.at(-1)
      if (rc && (!r.control.last || rc.at >= r.control.last.ended)) lines.push(`This run was continued by recovery: ${rc.by}${rc.agent ? ` (run ${rc.agent.workflow}/${rc.agent.run} in ${rc.agent.workspace})` : ''} ${rc.lifted ? `lifted the ${rc.lifted} hold after attempt ${rc.attempt}` : `queued its continuation, which nothing had queued (after attempt ${rc.attempt})`} for incident ${rc.incident}: "${rc.reason}". That is the recovering agent's finding, not a fact about side effects: look at your copy and the record before repeating anything that may already have happened.`)
      if (resume && (!r.control.last || resume.at > r.control.last.ended)) lines.push(`The person resumed the run: "${resume.reason}" (${resume.by}).`)
      lines.push(...await this.sinceBase(ws, r, view))
      for (const w of r.execution.waiting) lines.push(`Node ${w.node} waits; next move: ${holderOf(r, w.node)}.`)
    }
    lines.push(`Ready: ${r.execution.ready.join(', ') || '(none)'}; running: ${r.execution.active.join(', ') || '(none)'}.`)
    lines.push(...pendingAnswerLines(r))
    lines.push(...instructionBrief(r))
    lines.push(...presentationBrief(r))
    lines.push(...await shareBrief(ws, ref, r, job.kind === 'start' ? null : { by: this.executor }, view))
    lines.push(...delegationBrief(r, await this.assessedLines(r)))
    lines.push(...catalogBrief(catalogOf(r, reading.bundle), runKey(ref)))
    if (r.definition.revisions?.length) lines.push('', `Definition: revision ${r.definition.active} is in force (adjusted ${r.definition.revisions.length} time${r.definition.revisions.length === 1 ? '' : 's'}; wfe run revisions <run>); the original is definition/${r.definition.root}.yaml.`)
    lines.push(...documentationBrief(r))
    return lines.join('\n')
  }

  // What an ordinary resume of the run's session is told (agent_session p1
  // ex2, server/continuation.ts): why it runs and how the previous attempt
  // ended, what was recorded since the session's previous attempt began
  // that it did not write, the compact state, the pending input in full and
  // the instructions of documentation steps it reaches for the first time.
  // Identity paths, the catalog, the documentation policy and the steps it
  // was already briefed with are in the conversation and unchanged.
  async continuation(ws: Workspace, ref: RunRef, job: JobRow, view: WorkerView | null = null): Promise<string> {
    const r = (await readRun(ws, ref)).record!
    const cur = currentSession(r)!
    const attempts = cur.attempts
    const previous = attempts.at(-2)
    const begin = (a?: string) => r.history.find(e => e.op === 'attempt.begin' && (e as { attempt?: string }).attempt === a)
    const since = begin(previous)?.seq ?? 0
    const lines = [`Run: ${r.project} / ${runKey(ref)} (record ${runDir(ref)}/run.json).`, `Why this attempt: ${job.reason}`]
    const last = r.control.last
    if (last) {
      lines.push(`The previous attempt ${last.id} ended: ${last.outcome}${last.detail ? ` — ${last.detail}` : ''}.`)
      if (last.outcome !== 'exited') lines.push('It did not end normally: work may have happened after its last record, and commands it started may or may not have taken effect. Look at the files (git status, git diff) and the record before repeating any of them.')
    }
    const rc = r.recoveries?.at(-1)
    if (rc && (!last || rc.at >= last.ended)) lines.push(`This run was continued by recovery: ${rc.by}${rc.agent ? ` (run ${rc.agent.workflow}/${rc.agent.run} in ${rc.agent.workspace})` : ''} ${rc.lifted ? `lifted the ${rc.lifted} hold after attempt ${rc.attempt}` : `queued its continuation, which nothing had queued (after attempt ${rc.attempt})`} for incident ${rc.incident}: "${rc.reason}". That is the recovering agent's finding, not a fact about side effects.`)
    const resume = [...r.history].reverse().find(e => e.op === 'run.resume') as (RunRecord['history'][number] & { reason?: string }) | undefined
    if (resume && (!last || resume.at > last.ended)) lines.push(`The person resumed the run: "${resume.reason}" (${resume.by}).`)
    lines.push(...await this.sinceBase(ws, r, view))
    const delta = changeLines(r, since, [previous, attempts.at(-1)].filter((a): a is string => !!a))
    lines.push('', delta.count ? `Recorded since your previous attempt began (after seq ${since}), not by it (${delta.count}):` : `Nothing was recorded since your previous attempt began (seq ${since}) except by it.`, ...delta.lines)
    lines.push('', ...stateLines(r))
    lines.push(...pendingAnswerLines(r), ...instructionBrief(r), ...delegationBrief(r, await this.assessedLines(r)))
    lines.push(...await shareBrief(ws, ref, r, { by: this.executor }, view))
    lines.push(...newStepLines(r, briefedSteps(r, sinceBootstrap(r, attempts.slice(0, -1)))))
    lines.push('', `Unchanged and not repeated: the contract, the context (the same bundle, fingerprint ${currentSession(r)?.config.context?.fingerprint.slice(7, 19) ?? 'not recorded'}), the node catalog (wfe run nodes ${runKey(ref)}) and the documentation policy you were given. This is the record at seq ${r.seq}; wfe run state ${runKey(ref)} --since ${r.seq} shows what is recorded after it, wfe run show ${runKey(ref)} the full record.`)
    return lines.join('\n')
  }

  // Whether a resume of the run's current session must give the whole
  // bootstrap again (agent_session p1 ex2): a compaction in any of its
  // attempts since it was last given the bootstrap (the harness's
  // `compact_boundary` in the attempt's log), or a log that cannot be read,
  // so that a compaction cannot be ruled out. Null: an ordinary
  // continuation.
  reconstructionNeeded(r: RunRecord): string | null {
    const cur = currentSession(r)
    if (!cur) return null
    for (const a of sinceBootstrap(r, cur.attempts)) {
      const log = this.attemptRow(a)?.log
      let text: string
      try { text = log ? readFileSync(log, 'utf8') : '' } catch { return `the log of attempt ${a} cannot be read, so a compaction of the conversation cannot be ruled out` }
      if (!log) return `attempt ${a} has no log on this host, so a compaction of the conversation cannot be ruled out`
      if (/"subtype"\s*:\s*"compact_boundary"/.test(text)) return `the conversation was compacted in attempt ${a}`
    }
    return null
  }

  // What happened in the project while this run was held or waiting (p9):
  // the commits its shared targets gained since its base. Nothing of them is
  // in the copy; the agent looks and, when they change the plan or the
  // reviewed result, asks again.
  async sinceBase(ws: Workspace, r: RunRecord, view: WorkerView | null = null): Promise<string[]> {
    if (!ws.copyOf || !r.storage) return []
    const out: string[] = []
    const env = this.ctx.gitea ? await this.ctx.gitea.gitEnv() : {}
    for (const repo of r.storage.repositories) {
      if (!repo.base || !repo.target) continue
      const dir = join(ws.shared.root, repo.path)
      // Other runs' integrations reach the remote, the person's commits the
      // workspace: both are counted (the remote fetched first, best effort).
      await git(dir, ['fetch', '-q', 'origin', `+refs/heads/${repo.target}:refs/remotes/origin/${repo.target}`], { env, timeoutMs: 30_000 })
      const count = async (ref: string) => Number((await git(dir, ['rev-list', '--count', `${repo.base}..${ref}`])).stdout.trim()) || 0
      const [local, remote] = [await count(`refs/heads/${repo.target}`), await count(`refs/remotes/origin/${repo.target}`)]
      const n = Math.max(local, remote)
      const ref = remote > local ? `origin/${repo.target}` : repo.target
      const how = view ? `git -C ${posixJoin(view.root, repo.path)} log ${repo.base.slice(0, 12)}..origin/${repo.target}, fetched when this attempt was prepared` : `git -C ${dir} log ${repo.base.slice(0, 12)}..${ref}`
      if (n > 0) out.push(`Since this run's copy was made, ${repo.path === '.' ? 'the project' : repo.path} gained ${n} commit${n === 1 ? '' : 's'} on ${repo.target} (${how}); none of them is in this copy. Look before relying on files they may change; when they change the agreed plan or a reviewed result, ask again.`)
    }
    return out
  }

  // ---- the end of an attempt ------------------------------------------------------------

  // Records how the process ended and publishes the checkpoint. The record
  // derives the hold (shared/run.ts attempt.end); this only says how the
  // process ended.
  // agent_session p1 ex1: `interrupted` — the execution host ended the
  // attempt itself for this reason (a failed launch, a session mismatch), so
  // it holds the run whatever the exit code; `attached` — a session id the
  // harness reported that is not recorded yet, recorded before the end (or
  // named in the end's detail when that fails).
  // A repeated end report of an ended attempt (a retransmission) answers
  // what was recorded, with its checkpoint (p7: a worker retries it).
  async finished(attempt: string, exit: { code: number | null; signal: string | null; lost?: boolean; interrupted?: string; attached?: string }, worker?: string): Promise<{ outcome: string; checkpoint: CheckpointRow | null; resumeJob: JobRow | null }> {
    const a = this.fence(attempt, worker)
    if (a.state === 'ended') return { outcome: a.outcome ?? 'ended', checkpoint: this.one<CheckpointRow>('SELECT * FROM checkpoints WHERE attempt = ? ORDER BY id DESC LIMIT 1', attempt) ?? null, resumeJob: null }
    let unrecorded = ''
    if (exit.attached) await this.session(attempt, { attached: exit.attached }, worker).catch(e => { unrecorded = `the harness reported session ${exit.attached}, which could not be recorded: ${(e as Error).message}` })
    const how = `process ended with ${exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`}`
    const outcome = exit.lost ? 'unknown' : a.stop_requested ? 'stopped' : exit.code === 0 && !exit.interrupted ? 'exited' : 'interrupted'
    const detail = [exit.lost ? 'the process was gone when the execution host looked; whether its work finished is not known' : exit.interrupted ? `${exit.interrupted} (${how})` : exit.code === 0 ? '' : how, unrecorded].filter(Boolean).join('; ')
    this.run('UPDATE attempts SET state = \'ended\', ended = ?, exit_code = ?, signal = ?, outcome = ? WHERE id = ?', now(), exit.code, exit.signal, outcome, attempt)
    this.run('UPDATE jobs SET state = \'done\' WHERE attempt = ?', attempt)
    const ws = await this.workspace(a.workspace)
    const ref = { workflow: a.workflow, run: a.run }
    let rec: RunRecord | undefined
    try {
      rec = (await runOp(ws, ref, { op: 'attempt.end', attempt, outcome: outcome as 'exited', detail, waits: 'defer-ready', explain: 'cause' }, { by: this.executor, via: 'exec' })).record
    } catch (e) {
      rec = (await readRun(ws, ref)).record // already ended, or unreadable: keep what is there
      if (!rec) throw e
    }
    const kind = situation(rec)
    const checkpoint = await this.checkpoint(ws, ref, `after attempt ${attempt}: ${kind}`, attempt, a.baseline)
    // A completed run is integrated (p9). So is an acceptance the attempt
    // recorded from a confirmation, as a person's decision through the
    // service or the CLI is (afterDecision): it need not wait for the run's
    // completion, which may itself wait on a delegation that wants this
    // result on main (workflow_editor p12).
    const accepted = rec.decisions.at(-1)?.decision === 'accepted' && rec.decisions.some(d => d.decision === 'accepted' && d.at >= a.began)
    if ((rec.execution.state === 'completed' || accepted) && rec.storage) await this.queueIntegration(ws, ref, this.executor).catch(() => null)
    // An answer may have arrived while the attempt was still running.
    let resumeJob: JobRow | null = null
    for (const w of rec.execution.waiting) if ('question' in w.on) resumeJob = resumeJob ?? await this.afterAnswer(ws, ref, w.on.question)
    // A child's fact relayed while the attempt ran (p10) queues the next one.
    if (!resumeJob && Object.values(rec.delegations ?? {}).some(d => isOpenDelegation(d) && pendingEvents(d).length)) resumeJob = await this.afterDelegation(ws, ref)
    // A correction that arrived while the attempt ran (fix6) queues the next one.
    for (const k of openCorrections(rec)) resumeJob = resumeJob ?? await this.afterCorrection(ws, ref, k.id)
    // So do changes requested in a human review meanwhile (p17).
    for (const v of openContinuations(rec)) resumeJob = resumeJob ?? await this.afterReview(ws, ref, v.id)
    return { outcome: rec.control.last?.outcome ?? outcome, checkpoint, resumeJob }
  }

  // ---- stop, resume, cancel ---------------------------------------------------------

  // `meta` (p9): the person's words an agent acted on (`because`) and the
  // attempt that records it; a browser stop is the person's own.
  async stop(ws: Workspace, ref: RunRef, by: string, reason: string, via: string, meta: ControlMeta = {}) {
    const r = await runOp(ws, ref, { op: 'run.stop', reason, ...controlMeta(meta) }, { by, via })
    this.run('UPDATE attempts SET stop_requested = ? WHERE workspace = ? AND workflow = ? AND run = ? AND state != \'ended\'', now(), ws.reg.id, ref.workflow, ref.run)
    this.run('UPDATE jobs SET state = \'dropped\', note = \'stopped\' WHERE workspace = ? AND workflow = ? AND run = ? AND state = \'queued\'', ws.reg.id, ref.workflow, ref.run)
    return r.record
  }

  // `profile` (project_migration p6 ex2): the execution profile later
  // attempts resolve instead of the definition's.
  async resume(ws: Workspace, ref: RunRef, by: string, reason: string, via: string, receipt?: string, meta: ControlMeta & { profile?: string } = {}) {
    const r = await runOp(ws, ref, { op: 'run.resume', reason, ...controlMeta(meta), ...(meta.profile ? { profile: meta.profile } : {}), ...(receipt ? { receipt: `resume:${receipt}` } : {}) }, { by, via })
    const job = hostOf(r.record.executor) === this.executor ? this.enqueue(ws.reg.id, ref, 'resume', `resume:${ws.reg.id}/${runKey(ref)}/${r.record.seq}`, `resume: ${reason}`, this.nodeOf(r.record)) : null
    return { record: r.record, job }
  }

  // The run is performed by another execution node from its next attempt on
  // (project_migration p7): a person's or an operator's explicit choice,
  // recorded with why, between attempts. Never done by itself.
  async assign(ws: Workspace, ref: RunRef, node: string, by: string, reason: string, via: string) {
    if (!this.workers().workers[node]) throw new RequestError(400, `execution node "${node}" is not a worker of this area (${Object.keys(this.workers().workers).sort().join(', ')})`, { code: 'node-unknown' })
    const space = await runSpace(ws, ref)
    const r = await runOp(space, ref, { op: 'run.assign', node, reason } as never, { by, via })
    this.run('UPDATE jobs SET worker = ?, note = NULL WHERE workspace = ? AND workflow = ? AND run = ? AND state = \'queued\'', node, ws.reg.id, ref.workflow, ref.run)
    return r.record
  }

  // project_migration p7: every run of this area that an execution host
  // performs and that is not finished gets its node recorded (run.assign,
  // via migration), so no live or held run depends on the area's default.
  // Completed and cancelled runs stay as recorded and are read as the
  // default's. A dry run lists what would be assigned.
  async migrateNodes(o: { dryRun?: boolean; by: string }): Promise<string[]> {
    const notes: string[] = []
    const local = this.localWorker
    for (const w of (await loadRegistry(this.ctx.registryFile)).workspaces) {
      if (!(await observe(w)).available) continue
      const ws = new Workspace(w)
      for (const s of await listRuns(ws)) {
        if (s.problem || s.executorHost !== this.executor) continue
        const ref = { workflow: s.workflow, run: s.run }
        const space = await runSpace(ws, ref).catch(() => null)
        const rec = space ? (await readRun(space, ref)).record : undefined
        if (!rec || rec.executor.node || rec.cancelled || rec.execution.state === 'completed') continue
        if (rec.control.attempt) { notes.push(`${w.id} ${s.ref}: attempt ${rec.control.attempt.id} is open; assign it after it ends`); continue }
        if (!o.dryRun) await runOp(space!, ref, { op: 'run.assign', node: local, reason: 'project_migration p7: every unfinished run was performed by the local worker; recorded explicitly' } as never, { by: o.by, via: 'migration' })
        notes.push(`${w.id} ${s.ref}: ${o.dryRun ? 'would be assigned' : 'assigned'} to ${local} (${rec.execution.state}${rec.control.hold ? `, held ${rec.control.hold.kind}` : ''})`)
      }
    }
    return notes
  }

  // A recovering agent continues an interrupted or unknown hold (observer
  // p3, docs/observation.md *wfe run recover*). Not a person's resume: the
  // record names the incident, the attempt whose end held the run and the
  // recovering agent's own run and attempt. Refused while any process of the
  // run lives here (one writer per copy), beyond the budget since the last
  // person-originated control, and on a person's hold (the reducer).
  async recover(ws: Workspace, ref: RunRef, o: { incident: string; attempt: string; reason: string; by?: string; recoveryAttempt?: string; expectSeq?: number; via: string }): Promise<{ record: RunRecord; job: JobRow | null; duplicate: boolean }> {
    const space = await runSpace(ws, ref)
    const rec = (await readRun(space, ref)).record
    if (!rec) throw new RequestError(409, `run ${runKey(ref)} cannot be read`)
    // Who recovers: inside an attempt of another run, that run's agent.
    let by = o.by?.trim() || ''
    let agent: RecoveryAgent | undefined
    if (o.recoveryAttempt) {
      const own = this.attemptRow(o.recoveryAttempt)
      if (!own || own.state === 'ended') throw new RequestError(409, `attempt ${o.recoveryAttempt} is not an open attempt on this host; a recovery is recorded by the recovering run's open attempt, or with --by outside one`, { code: 'recover-actor' })
      if (own.workspace === ws.reg.id && own.workflow === ref.workflow && own.run === ref.run) throw new RequestError(409, `attempt ${own.id} belongs to run ${runKey(ref)} itself; a run does not recover its own hold`, { code: 'recover-actor' })
      const ownWs = await this.workspace(own.workspace)
      const ownRec = (await readRun(ownWs, { workflow: own.workflow, run: own.run })).record
      if (!ownRec) throw new RequestError(409, `the recovering run ${own.workflow}/${own.run} cannot be read`, { code: 'recover-actor' })
      if (by && by !== ownRec.executor.name) throw new RequestError(409, `this process is attempt ${own.id} of ${ownRec.executor.name}; it records as ${ownRec.executor.name}, not as ${by}`, { code: 'recover-actor' })
      by = ownRec.executor.name
      agent = { workspace: own.workspace, workflow: own.workflow, run: own.run, attempt: own.id }
    }
    if (!by) throw new RequestError(400, 'who recovers? Pass --by <name>, or run it from the recovering run\'s attempt (WFE_ATTEMPT)', { code: 'recover-actor' })
    const receipt = `recover:${o.incident}:${o.attempt}`
    if (rec.history.some(h => h.receipt === receipt)) return { record: rec, job: this.one<JobRow>('SELECT * FROM jobs WHERE receipt = ?', `recover:${ws.reg.id}/${runKey(ref)}/${o.incident}/${o.attempt}`) ?? null, duplicate: true }
    // One writer per copy: no attempt of this run may be open or alive here.
    for (const a of this.all<AttemptRow>('SELECT * FROM attempts WHERE workspace = ? AND workflow = ? AND run = ?', ws.reg.id, ref.workflow, ref.run)) {
      if (a.state !== 'ended') throw new RequestError(409, `attempt ${a.id} of run ${runKey(ref)} is ${a.state}; a recovery waits until it has ended`, { code: 'recover-process-alive' })
      if (this.localPid(a) && a.pid && alive(a.pid)) throw new RequestError(409, `process ${a.pid} of attempt ${a.id} still lives; the run's copy has one writer at a time`, { code: 'recover-process-alive' })
    }
    // An unowned continuation (no hold): only when nothing is queued for it.
    if (!rec.control.hold) {
      const job = this.one<JobRow>('SELECT * FROM jobs WHERE workspace = ? AND workflow = ? AND run = ? AND state IN (\'queued\', \'claimed\')', ws.reg.id, ref.workflow, ref.run)
      if (job) throw new RequestError(409, `run ${runKey(ref)} is not held and job ${job.id} (${job.kind}) is ${job.state}: its continuation is owned`, { code: 'recover-owned' })
    }
    // The budget: recoveries since the last control that came from a person.
    const r = await runOp(space, ref, { op: 'run.recover', incident: o.incident, attempt: o.attempt, reason: o.reason, ...(agent ? { agent } : {}), receipt } as never, { by, via: o.via, expectSeq: o.expectSeq })
    const job = hostOf(r.record.executor) === this.executor ? this.enqueue(ws.reg.id, ref, 'resume', `recover:${ws.reg.id}/${runKey(ref)}/${o.incident}/${o.attempt}`, `recover: incident ${o.incident} (${o.reason})`, this.nodeOf(r.record)) : null
    return { record: r.record, job, duplicate: !!r.duplicate }
  }

  // Cancellation is final; what the run serves is stopped through this path
  // of its own (p7), whatever successors the graph has. A failed stop is
  // recorded (stop-failed) beside the cancellation and retried with
  // `wfe present stop <run> --all`.
  async cancel(ws: Workspace, ref: RunRef, by: string, reason: string, via: string, meta: ControlMeta = {}): Promise<{ record: RunRecord; cleanup: { presentation: string; ok: boolean; detail: string }[] }> {
    const r = await runOp(ws, ref, { op: 'run.cancel', reason, ...controlMeta(meta) }, { by, via })
    this.run('UPDATE attempts SET stop_requested = ? WHERE workspace = ? AND workflow = ? AND run = ? AND state != \'ended\'', now(), ws.reg.id, ref.workflow, ref.run)
    this.run('UPDATE jobs SET state = \'dropped\', note = \'cancelled\' WHERE workspace = ? AND workflow = ? AND run = ? AND state = \'queued\'', ws.reg.id, ref.workflow, ref.run)
    let cleanup: { presentation: string; ok: boolean; detail: string }[] = []
    if (r.record.presentations) {
      const { Presenter } = await import('./present.ts')
      const pr = new Presenter({ registryFile: this.ctx.registryFile, area: this.ctx.area, by })
      try { cleanup = await pr.stop(ws, ref, 'all', { by }) } catch (e) { cleanup = [{ presentation: '*', ok: false, detail: (e as Error).message }] } finally { pr.close() }
    }
    // What its human reviews started (p17) is stopped through the owning runs.
    for (const v of Object.values(r.record.reviews ?? {}).filter(hostOwes)) {
      const after = await this.reviews.cleanup(ws, ref, v.id).catch(e => { cleanup.push({ presentation: `${v.id}`, ok: false, detail: (e as Error).message }); return null })
      if (after) cleanup.push({ presentation: `review ${v.id}`, ok: after.cleanup?.state === 'done', detail: after.cleanup?.results.map(c => `${c.instance}: ${c.status} (${c.detail})`).join('; ') || 'nothing to stop' })
    }
    return { record: (await readRun(ws, ref)).record ?? r.record, cleanup }
  }

  // Attempts whose process should be terminated now (stop or cancel requested).
  // `worker` (p7): only the attempts that worker owns; it alone stops them.
  stopsDue(worker?: string): AttemptRow[] {
    const all = this.all<AttemptRow>('SELECT * FROM attempts WHERE state != \'ended\' AND stop_requested IS NOT NULL')
    return worker ? all.filter(a => (a.worker ?? this.localWorker) === worker) : all
  }

  // ---- publication ------------------------------------------------------------------------

  // The end of an attempt on a remote worker (p7) is published by that
  // worker from its own copy (mode `worker`): the row waits for its report
  // (workerCheckpoint). Every other checkpoint is the coordinator's.
  async checkpoint(ws: Workspace, ref: RunRef, kind: string, attempt: string | null, base: string | null): Promise<CheckpointRow> {
    const by = attempt ? this.attemptRow(attempt)?.worker : null
    if (attempt && this.isRemote(by)) {
      const id = Number(this.run('INSERT INTO checkpoints (workspace, workflow, run, kind, attempt, state, created, updated, steps, baseline, mode) VALUES (?, ?, ?, ?, ?, \'pending\', ?, ?, \'[]\', NULL, \'worker\')', ws.reg.id, ref.workflow, ref.run, kind, attempt, now(), now()).lastInsertRowid)
      return this.one<CheckpointRow>('SELECT * FROM checkpoints WHERE id = ?', id)!
    }
    const mode = (await runSpace(ws, ref)).copyOf ? 'run-copy' : null
    const id = Number(this.run('INSERT INTO checkpoints (workspace, workflow, run, kind, attempt, state, created, updated, steps, baseline, mode) VALUES (?, ?, ?, ?, ?, \'pending\', ?, ?, \'[]\', ?, ?)', ws.reg.id, ref.workflow, ref.run, kind, attempt, now(), now(), base, mode).lastInsertRowid)
    return this.publishCheckpoint(id)
  }

  // Publishes (or retries) one checkpoint. Finished steps are not repeated.
  // A run with its own copy (p9) publishes to its run branches and waits
  // only for its own attempt; other runs work in other copies. A run kept in
  // the project workspace waits for every attempt there, as before.
  // Publications of one run take turns (another try, a decision's checkpoint).
  async publishCheckpoint(id: number): Promise<CheckpointRow> {
    const cp = this.one<CheckpointRow>('SELECT * FROM checkpoints WHERE id = ?', id)
    if (!cp) throw new RequestError(404, `no checkpoint ${id}`)
    if (cp.state === 'published' || cp.state === 'nothing') return cp
    if (cp.mode === 'worker') throw new RequestError(409, `checkpoint ${id} is published by worker ${this.attemptRow(cp.attempt ?? '')?.worker ?? '?'} from its own copy, which holds the work; that worker retries it`, { code: 'checkpoint-worker' })
    const ws = await this.workspace(cp.workspace)
    const ref = { workflow: cp.workflow, run: cp.run }
    // The record copy holds a remote worker's work only once the worker's
    // own checkpoint is published and aligned (p7).
    const owed = this.workerCheckpointOwed(cp.workspace, ref)
    if (owed) throw new RequestError(409, `run ${runKey(ref)} waits for worker ${this.attemptRow(owed.attempt ?? '')?.worker ?? '?'} to publish checkpoint ${owed.id} (${owed.state}${owed.error ? `: ${owed.error}` : ''}); the coordinator publishes after it`, { code: 'checkpoint-worker' })
    // The checkpoint's own mode decides (p9): one made before the run moved
    // to its copy still publishes the project workspace's branches.
    const space = cp.mode === 'run-copy' ? await runSpace(ws, ref) : ws.shared
    const live = space.copyOf
      ? this.one<AttemptRow>('SELECT * FROM attempts WHERE workspace = ? AND workflow = ? AND run = ? AND state != \'ended\'', cp.workspace, cp.workflow, cp.run)
      : this.one<AttemptRow>('SELECT * FROM attempts WHERE workspace = ? AND state != \'ended\'', cp.workspace)
    if (live) throw new RequestError(409, `attempt ${live.id} is executing ${space.copyOf ? `run ${runKey(ref)}` : `in ${cp.workspace}`}; publication waits until it has ended`)
    return withLock(join(space.root, '.git', 'wfe-publication'), async () => {
      const fresh = this.one<CheckpointRow>('SELECT * FROM checkpoints WHERE id = ?', id)!
      if (fresh.state === 'published' || fresh.state === 'nothing') return fresh
      const env = this.ctx.gitea ? await this.ctx.gitea.gitEnv() : {}
      const message = `${runKey(ref)}: ${fresh.kind}`
      const previous = JSON.parse(fresh.steps) as RepoStep[]
      let result
      try {
        if (space.copyOf) {
          const copy = await readCopy(ws, ref)
          const targets = Object.fromEntries((copy?.manifest?.repositories ?? []).filter(r => r.initialized && r.branch).map(r => [r.path, r.branch!]))
          const record = join(space.root, runDir(ref), RUN_FILE)
          result = await publishRun(space, message, previous, env, targets, f => withLock(record, f, { what: `run ${runKey(ref)}` }))
        } else {
          const info = await ws.devdocs()
          const dir = runDir(ref)
          const own: Record<string, string> = info.owner === 'devdocs' ? { devdocs: dir.slice('devdocs/'.length) } : { '.': dir }
          result = await publish(ws, fresh.baseline ? JSON.parse(fresh.baseline) as Baseline : {}, message, previous, env, own)
        }
      } catch (e) {
        result = { state: 'failed' as const, steps: previous, error: (e as Error).message }
      }
      this.run('UPDATE checkpoints SET state = ?, steps = ?, error = ?, updated = ? WHERE id = ?', result.state, JSON.stringify(result.steps), result.error ?? null, now(), id)
      return this.one<CheckpointRow>('SELECT * FROM checkpoints WHERE id = ?', id)!
    }, { what: `publication of run ${runKey(ref)}`, timeoutMs: 600_000 })
  }

  // A remote worker's checkpoint of this run that is not published yet (p7).
  workerCheckpointOwed(workspace: string, ref: RunRef): CheckpointRow | undefined {
    return this.one<CheckpointRow>('SELECT * FROM checkpoints WHERE workspace = ? AND workflow = ? AND run = ? AND mode = \'worker\' AND state NOT IN (\'published\', \'nothing\') ORDER BY id LIMIT 1', workspace, ref.workflow, ref.run)
  }

  // A remote worker's report of the checkpoint it published from its copy
  // (p7): its steps, as publishRun gives them. Once published, the record
  // copy is aligned with the pushed commits (alignRecordCopy) so the
  // coordinator's views, later checkpoints and integration build on them.
  // A repeated report of a settled checkpoint answers the row.
  async workerCheckpoint(id: number, worker: string, result: { state: CheckpointRow['state']; steps: RepoStep[]; error?: string }): Promise<CheckpointRow> {
    const cp = this.one<CheckpointRow>('SELECT * FROM checkpoints WHERE id = ?', id)
    if (!cp) throw new RequestError(404, `no checkpoint ${id}`)
    if (cp.mode !== 'worker') throw new RequestError(409, `checkpoint ${id} is the coordinator's`, { code: 'checkpoint-foreign' })
    this.fence(cp.attempt ?? '', worker)
    if (cp.state === 'published' || cp.state === 'nothing') return cp
    if (!['published', 'nothing', 'attention', 'failed'].includes(result.state) || !Array.isArray(result.steps)) throw new RequestError(400, 'state is published, nothing, attention or failed, with the steps')
    let state = result.state, error = result.error ?? null
    if (state === 'published' || state === 'nothing') {
      const ws = await this.workspace(cp.workspace)
      const ref = { workflow: cp.workflow, run: cp.run }
      const env = this.ctx.gitea ? await this.ctx.gitea.gitEnv() : {}
      const aligned = await alignRecordCopy(ws, ref, result.steps, env).catch(e => (e as Error).message)
      if (typeof aligned === 'string') { state = 'attention'; error = `published by ${worker}, but the coordinator's record copy could not follow: ${aligned}` }
    }
    this.run('UPDATE checkpoints SET state = ?, steps = ?, error = ?, updated = ? WHERE id = ?', state, JSON.stringify(result.steps), error, now(), id)
    return this.one<CheckpointRow>('SELECT * FROM checkpoints WHERE id = ?', id)!
  }

  // What a remote worker owes or holds (p7): its open attempts (it alone
  // judges their processes) and its checkpoints still to publish.
  workerDue(worker: string): { attempts: AttemptRow[]; checkpoints: CheckpointRow[] } {
    const attempts = this.all<AttemptRow>('SELECT * FROM attempts WHERE state != \'ended\' AND worker = ?', worker).map(a => ({ ...a, response: null }))
    const checkpoints = this.all<CheckpointRow>('SELECT c.* FROM checkpoints c JOIN attempts a ON a.id = c.attempt WHERE c.mode = \'worker\' AND c.state NOT IN (\'published\', \'nothing\') AND a.worker = ? ORDER BY c.id', worker)
    return { attempts, checkpoints }
  }

  // The result decision is a checkpoint of its own (only run.json changes).
  async afterDecision(ws: Workspace, ref: RunRef, decision: string): Promise<CheckpointRow> {
    const space = await runSpace(ws, ref)
    const cp = await this.checkpoint(ws.shared, ref, `result ${decision}`, null, space.copyOf ? null : JSON.stringify(await baseline(ws.shared)))
    // An acceptance queues its integration (p9); it is carried out once the
    // run is completed and saved (integrateDue).
    if (decision === 'accepted' && space.copyOf) await this.queueIntegration(ws, ref, this.executor).catch(() => null)
    return cp
  }

  // ---- integration (p9, docs/integration.md) ------------------------------------------

  integrations(workspace: string, ref: RunRef): IntegrationRow[] {
    return this.all<IntegrationRow>('SELECT * FROM integrations WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY id', workspace, ref.workflow, ref.run)
  }

  // Why the run's latest decision cannot be integrated now, or null: the
  // acceptance, the run's own copy and storage, the revision it binds to,
  // a completed execution and no open attempt.
  private async integrable(ws: Workspace, ref: RunRef): Promise<{ space: Workspace; record: RunRecord; decision: number } | { refused: string; wait?: boolean; superseded?: boolean }> {
    const space = await runSpace(ws, ref)
    const record = (await readRun(space, ref)).record
    if (!record) return { refused: `run ${runKey(ref)} cannot be read` }
    if (record.cancelled || record.control.hold?.kind === 'stopped' || record.control.stop) return { refused: `run ${runKey(ref)} was explicitly stopped or cancelled; resume it before integration` }
    if (!space.copyOf || !record.storage) return { refused: `run ${runKey(ref)} has no working copy of its own; what it published is already on the project's branches` }
    if (record.control.attempt) return { refused: `attempt ${record.control.attempt.id} is executing run ${runKey(ref)}; integration waits until it has ended and its work is saved`, wait: true }
    const owed = this.workerCheckpointOwed(ws.reg.id, ref)
    if (owed) return { refused: `run ${runKey(ref)} waits for its worker to publish checkpoint ${owed.id} (${owed.state}); integration builds on it`, wait: true }
    return { space, record, decision: record.seq }
  }

  // The guarded bindings (project_migration p4) of the definition the run
  // follows now: its latest adjusted revision, else its frozen root.
  private async guards(space: Workspace, ref: RunRef, record: RunRecord): Promise<Guard[]> {
    const { bundle } = await readRun(space, ref)
    const w = bundle.revisions?.at(-1)?.workflow ?? bundle.entries[record.definition.root]?.workflow
    return w && record.storage ? guardsFor(w.repositories, record.storage) : []
  }

  // Queues the integration of the latest accepted decision (once per decision).
  async queueIntegration(ws: Workspace, ref: RunRef, by: string): Promise<IntegrationRow> {
    const space = await runSpace(ws, ref)
    const record = (await readRun(space, ref)).record
    if (!record) throw new RequestError(409, `run ${runKey(ref)} cannot be read`)
    const decision = record.seq
    return this.tx(() => {
      const have = this.one<IntegrationRow>('SELECT * FROM integrations WHERE workspace = ? AND workflow = ? AND run = ? AND state NOT IN (\'integrated\', \'superseded\', \'refused\') ORDER BY id DESC LIMIT 1', ws.reg.id, ref.workflow, ref.run)
      if (have) return have
      const id = Number(this.run('INSERT INTO integrations (workspace, workflow, run, decision, state, created, updated, steps, requested_by) VALUES (?, ?, ?, ?, \'queued\', ?, ?, \'[]\', ?)', ws.reg.id, ref.workflow, ref.run, decision, now(), now(), by).lastInsertRowid)
      return this.one<IntegrationRow>('SELECT * FROM integrations WHERE id = ?', id)!
    })
  }

  // Integrates the run's accepted result now, or shows the plan (dryRun:
  // the combined commits are made locally and nothing is pushed or
  // recorded). The copy is saved first when it holds unsaved records; the
  // binding to the accepted revision decides whether anything else changed.
  async integrateRun(ws: Workspace, ref: RunRef, o: { by: string; via: string; dryRun?: boolean; integration?: number }): Promise<{ state: IntegrationRow['state']; steps: IntegrationStep[]; error?: string; row: IntegrationRow | null }> {
    const ok = await this.integrable(ws, ref)
    if ('refused' in ok) throw new RequestError(409, ok.refused)
    const { space } = ok
    const copy = await readCopy(ws, ref)
    const env = this.ctx.gitea ? await this.ctx.gitea.gitEnv() : {}
    const lockDir = join(this.ctx.area, '.local', 'exec', 'integration-locks')
    const guards = await this.guards(space, ref, ok.record)
    if (o.dryRun) {
      const r = await integrate({ space, ref, project: ok.record.project, storage: ok.record.storage!, accepted: [], previous: [], env, lockDir, dryRun: true, guards, save: () => {} })
      return { state: r.state, steps: r.steps, error: r.error, row: null }
    }
    // The final checkpoint: everything in the copy saved on its branches.
    const cp = await this.checkpoint(ws.shared, ref, 'before integration', null, null)
    if (cp.state !== 'published' && cp.state !== 'nothing') throw new RequestError(409, `the run's copy could not be saved before integration (checkpoint ${cp.id}: ${cp.state}${cp.error ? `, ${cp.error}` : ''}); retry the publication first`)
    const row = o.integration ? this.one<IntegrationRow>('SELECT * FROM integrations WHERE id = ?', o.integration)! : await this.queueIntegration(ws, ref, o.by)
    if (row.state === 'integrated') return { state: row.state, steps: JSON.parse(row.steps), row }
    return withLock(join(copy!.dir, 'integration'), async () => {
      this.run('UPDATE integrations SET state = \'running\', error = NULL, updated = ? WHERE id = ?', now(), row.id)
      const save = (steps: IntegrationStep[]) => this.run('UPDATE integrations SET steps = ?, updated = ? WHERE id = ?', JSON.stringify(steps), now(), row.id)
      let r
      try {
        r = await integrate({ space, ref, project: ok.record.project, storage: ok.record.storage!, accepted: [], previous: JSON.parse(row.steps) as IntegrationStep[], env, lockDir, guards, save })
      } catch (e) {
        r = { state: 'failed' as const, steps: JSON.parse(this.one<IntegrationRow>('SELECT * FROM integrations WHERE id = ?', row.id)!.steps) as IntegrationStep[], error: (e as Error).message }
      }
      if (r.state === 'integrated') {
        const repositories = r.steps.map(s => ({ path: s.repo, target: s.target, observed: s.observed!, candidate: s.candidate!, method: s.method!, result: s.result! }))
        try {
          await runOp(space, ref, { op: 'run.integrate', decision: row.decision, repositories, integration: String(row.id), receipt: `integration:${row.id}` }, { by: o.by, via: o.via })
        } catch (e) {
          r = { ...r, state: 'attention' as const, error: `integrated, but the record could not say so: ${(e as Error).message}; retry to record it` }
        }
      }
      this.run('UPDATE integrations SET state = ?, steps = ?, error = ?, updated = ? WHERE id = ?', r.state, JSON.stringify(r.steps), r.error ?? null, now(), row.id)
      if (r.state === 'integrated') await this.checkpoint(ws.shared, ref, 'integrated', null, null).catch(() => null) // the record of it, on the run branch
      return { state: r.state, steps: r.steps, error: r.error, row: this.one<IntegrationRow>('SELECT * FROM integrations WHERE id = ?', row.id)! }
    }, { what: `integration of run ${runKey(ref)}`, timeoutMs: 600_000 })
  }

  // Queued integrations whose run is now completed and saved are carried out
  // (by the executor's periodic reconcile). A failure or a refusal stays on
  // its row for a person or agent; nothing is retried by itself.
  async integrateDue(): Promise<string[]> {
    const notes: string[] = []
    for (const { id } of this.all<{ id: number }>('SELECT id FROM integrations WHERE state = \'queued\' ORDER BY id')) {
      // Each row as it is now: an earlier row's integration may have settled it
      // (project_migration p3/ex1 found a stale list overwrite an integrated row).
      const row = this.one<IntegrationRow>('SELECT * FROM integrations WHERE id = ?', id)
      if (!row || row.state !== 'queued') continue
      const ref = { workflow: row.workflow, run: row.run }
      let ws: Workspace
      try { ws = await this.workspace(row.workspace) } catch (e) { notes.push(`integration ${row.id} (${runKey(ref)}): ${(e as Error).message}`); continue }
      const ok = await this.integrable(ws, ref).catch(e => ({ refused: (e as Error).message, wait: false, superseded: false }))
      if ('refused' in ok) {
        if (!ok.wait) { this.run('UPDATE integrations SET state = ?, error = ?, updated = ? WHERE id = ? AND state = \'queued\'', ok.superseded ? 'superseded' : 'refused', ok.refused, now(), row.id); notes.push(`integration ${row.id} (${runKey(ref)}): ${ok.superseded ? 'superseded' : 'refused'} — ${ok.refused}`) }
        continue
      }
      const r = await this.integrateRun(ws, ref, { by: this.executor, via: 'exec', integration: row.id }).catch(e => ({ state: 'failed', error: (e as Error).message }))
      notes.push(`integration ${row.id} (${runKey(ref)}): ${r.state}${r.error ? ` — ${r.error}` : ''}`)
    }
    return notes
  }

  // ---- recovery -------------------------------------------------------------------------------

  // After a restart of the executor or the service: attempts whose process
  // is gone end as `unknown` (never completed, failed or rerun by
  // themselves); runs a request created but never queued, and answers
  // recorded but never queued, are queued again under their receipts.
  // `holding` (agent_session p1 ex1): attempts whose process the calling
  // executor still owns — e.g. one it spawned but could not register or
  // confirm stopped. They keep the slot whatever their row says. A
  // `launching` row the caller does not hold is stale after two minutes:
  // the executor's launch gate lets a process start work only after
  // `started` registered it, so an unregistered process never worked.
  async reconcile(holding: string[] = []): Promise<string[]> {
    const notes: string[] = []
    for (const a of this.all<AttemptRow>('SELECT * FROM attempts WHERE state != \'ended\'')) {
      if (!this.localPid(a) || holding.includes(a.id)) continue // a remote worker judges its own (p7)
      const stale = a.state === 'launching' ? Date.now() - Date.parse(a.began) > 120_000 : !alive(a.pid)
      if (!stale) continue
      // How it ended, when the executor's launch gate could record it (p7).
      const ended = a.state === 'running' && a.log ? exitFile(`${a.log}.exit`) : null
      const r = await this.finished(a.id, ended ?? { code: null, signal: null, lost: true }).catch(e => ({ outcome: `not recorded: ${(e as Error).message}` }))
      notes.push(`attempt ${a.id} (${a.workflow}/${a.run}): process gone; recorded ${r.outcome}`)
    }
    const reg = await loadRegistry(this.ctx.registryFile)
    for (const w of reg.workspaces) {
      if (!(await observe(w)).available) continue
      const ws = new Workspace(w)
      for (const s of await listRuns(ws)) {
        if (s.problem) continue
        const ref = { workflow: s.workflow, run: s.run }
        const rec = (await readRun(ws, ref)).record
        // Human review rounds whose start or cleanup is owed (p17): WFE's
        // host work, whatever the run's executor or hold.
        if (rec && Object.values(rec.reviews ?? {}).some(hostOwes)) notes.push(...await this.reviews.reconcileRun(ws, rec).catch(e => [`${w.id} ${s.ref}: reviews: ${(e as Error).message}`]))
        if (s.executorHost !== this.executor) continue
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
        // A relayed delegation fact whose continuation was lost (p10).
        if (Object.values(rec.delegations ?? {}).some(d => isOpenDelegation(d) && pendingEvents(d).length)) {
          const j = await this.afterDelegation(ws, ref)
          if (j && !jobs.some(x => x.id === j.id)) notes.push(`${w.id} ${s.ref}: resume for a relayed delegation fact queued again`)
        }
        // A correction not addressed whose continuation was lost (fix6).
        for (const k of openCorrections(rec)) {
          const j = await this.afterCorrection(ws, ref, k.id)
          if (j && !jobs.some(x => x.id === j.id)) notes.push(`${w.id} ${s.ref}: resume for correction ${k.id} queued again`)
        }
        // Requested changes whose continuation was lost (p17).
        for (const v of openContinuations(rec)) {
          const j = await this.afterReview(ws, ref, v.id)
          if (j && !jobs.some(x => x.id === j.id)) notes.push(`${w.id} ${s.ref}: resume for review ${v.id} queued again`)
        }
        // An instruction for a run nobody executes, whose continuation was
        // lost (project_migration p8 ex1): queued again under its receipt.
        for (const ins of Object.values(rec.instructions ?? {})) {
          if (ins.ack) continue
          const j = await this.afterInstruction(ws, ref, ins.id)
          if (j && !jobs.some(x => x.id === j.id)) notes.push(`${w.id} ${s.ref}: resume for instruction ${ins.id} queued again`)
        }
        // A resume or recovery recorded after the last attempt ended whose
        // job was lost (p8 ex1): the record says the run continues, so it does.
        const lastEnd = [...rec.history].reverse().find(h => h.op === 'attempt.end')
        const lift = [...rec.history].reverse().find(h => h.op === 'run.resume' || (h.op as string) === 'run.recover')
        if (lift && (!lastEnd || lift.seq > lastEnd.seq) && rec.execution.state !== 'completed' && !jobs.some(x => x.state === 'queued' || x.state === 'claimed')) {
          const receipt = lift.op === 'run.resume' ? `resume:${w.id}/${s.ref}/${lift.seq}` : `recover:${w.id}/${s.ref}/${String((lift as { incident?: string }).incident)}/${String((lift as { attempt?: string }).attempt)}`
          if (!this.one<JobRow>('SELECT * FROM jobs WHERE receipt = ?', receipt)) {
            this.enqueue(w.id, ref, 'resume', receipt, `${lift.op === 'run.resume' ? 'resume' : 'recover'}: queued again (its job was lost after seq ${lift.seq})`, this.nodeOf(rec))
            notes.push(`${w.id} ${s.ref}: ${lift.op} at seq ${lift.seq} queued again`)
          }
        }
      }
    }
    // Delegations: indexed from their records, then relayed (p10).
    try { notes.push(...await this.delegate.rebuild(), ...await this.delegate.relay()) } catch (e) { notes.push(`delegation relay: ${(e as Error).message}`) }
    notes.push(...await this.integrateDue())
    return notes
  }

  // ---- views ------------------------------------------------------------------------------

  // One heartbeat per worker (p7), keyed by the worker id. A remote worker
  // sends its offer and facts with it, so the views say what it can do.
  heartbeat(worker: string, pid: number, detail: string, offer?: { offer?: HostOffer; facts?: WorkerFacts }) {
    if (!this.workers().workers[worker]) throw new RequestError(404, `worker "${worker}" is not a worker of this area`, { code: 'worker-unknown' })
    this.run('INSERT INTO heartbeat (name, at, pid, detail, offer) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET at = excluded.at, pid = excluded.pid, detail = excluded.detail, offer = coalesce(excluded.offer, heartbeat.offer)', worker, now(), pid, detail, offer ? JSON.stringify(offer) : null)
  }

  // The local worker's state: what "the executor" meant before p7, and what
  // the dashboard and the watchdog read.
  executorState(): { state: 'available' | 'unavailable' | 'unknown'; detail?: string; at?: string } {
    const w = this.workersState().find(x => x.id === this.localWorker)!
    if (!w.at) return { state: 'unknown', detail: 'the executor has never reported on this host' }
    return w.state === 'available' ? { state: 'available', detail: w.detail, at: w.at } : { state: 'unavailable', detail: `${w.id} last reported ${Math.round(w.ageSeconds ?? 0)} s ago`, at: w.at }
  }

  // Every worker (p7): when it last reported (`unavailable` past 45 s: contact
  // is lost, which is not a statement about its processes), what it holds,
  // what waits for it and what it offered.
  workersState(): WorkerState[] {
    const cfg = this.workers()
    return Object.values(cfg.workers).map(w => {
      const hb = this.one<{ name: string; at: string; pid: number | null; detail: string; offer: string | null }>('SELECT * FROM heartbeat WHERE name = ?', w.id)
      const age = hb ? (Date.now() - Date.parse(hb.at)) / 1000 : null
      const open = this.all<AttemptRow>('SELECT * FROM attempts WHERE state != \'ended\' AND worker = ? ORDER BY began', w.id)
      const busy = open.find(a => !a.lane || a.lane === DEFAULT_LANE) ?? null
      const extra = open.filter(a => a !== busy)
      const jobs = this.all<JobRow>('SELECT * FROM jobs WHERE state = \'queued\' AND coalesce(worker, ?) = ? ORDER BY id', cfg.default, w.id)
      const offered = hb?.offer ? JSON.parse(hb.offer) as { offer?: HostOffer; facts?: WorkerFacts } : null
      const state = !hb ? 'unknown' as const : age! < 45 ? 'available' as const : 'unavailable' as const
      const detail = `${w.id}${busy ? `; executing ${busy.workflow}/${busy.run} (${busy.id})` : '; idle'}${extra.map(a => `; ${a.lane ?? DEFAULT_LANE} lane: ${a.workflow}/${a.run} (${a.id})`).join('')}${jobs.length ? `; ${jobs.length} queued` : ''}`
      return { id: w.id, label: w.label, local: w.local, default: cfg.default === w.id, state, at: hb?.at ?? null, ageSeconds: age, pid: hb?.pid ?? null, reported: hb?.detail ?? null, detail,
        busy: busy ? { attempt: busy.id, workspace: busy.workspace, workflow: busy.workflow, run: busy.run, state: busy.state, stopRequested: busy.stop_requested } : null,
        slots: open.map(a => ({ attempt: a.id, workspace: a.workspace, workflow: a.workflow, run: a.run, state: a.state, stopRequested: a.stop_requested, lane: a.lane ?? DEFAULT_LANE })),
        lanes: { ...w.lanes },
        queued: jobs.map(j => ({ id: j.id, workspace: j.workspace, workflow: j.workflow, run: j.run, kind: j.kind, note: j.note })),
        profiles: offered?.offer?.profiles ? Object.keys(offered.offer.profiles).sort() : null, facts: offered?.facts ?? null }
    })
  }

  // ---- observation (observer p3, docs/observation.md) -----------------------------------

  // Reads in one SQLite read transaction, so the rows of one look agree
  // with each other (WAL: a snapshot, no write lock).
  readSnapshot<T>(f: () => T): T {
    named('exec store', 'a read transaction', () => this.db.exec('BEGIN'))
    try { return f() } finally { try { this.db.exec('COMMIT') } catch { /* nothing to commit */ } }
  }

  // The host facts of the whole queue: the attempt holding the slot, the
  // queued and claimed jobs in claim order, and the heartbeat.
  // `busy` and `heartbeat` are the local worker's (what they were before
  // p7; `busy` is its default lane's slot, p8); `slots` has every open
  // attempt of every lane, `workers` every worker.
  queueView(): { busy: AttemptRow | null; slots: AttemptRow[]; jobs: JobRow[]; heartbeat: { name: string; at: string; pid: number | null; detail: string } | null; workers: WorkerState[] } {
    const local = this.localWorker
    return this.readSnapshot(() => ({
      busy: this.one<AttemptRow>('SELECT * FROM attempts WHERE state != \'ended\' AND coalesce(worker, ?) = ? AND coalesce(lane, ?) = ? ORDER BY began LIMIT 1', local, local, DEFAULT_LANE, DEFAULT_LANE) ?? null,
      slots: this.all<AttemptRow>('SELECT * FROM attempts WHERE state != \'ended\' ORDER BY began'),
      jobs: this.all<JobRow>('SELECT * FROM jobs WHERE state IN (\'queued\', \'claimed\') ORDER BY id'),
      heartbeat: this.one<{ name: string; at: string; pid: number | null; detail: string }>('SELECT name, at, pid, detail FROM heartbeat WHERE name = ?', local) ?? null,
      workers: this.workersState(),
    }))
  }

  // One run's rows, read together.
  runRows(workspace: string, ref: RunRef): { attempts: AttemptRow[]; jobs: JobRow[]; checkpoints: CheckpointRow[]; integrations: IntegrationRow[] } {
    const w = [workspace, ref.workflow, ref.run] as const
    return this.readSnapshot(() => ({
      attempts: this.all<AttemptRow>('SELECT * FROM attempts WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY began', ...w),
      jobs: this.all<JobRow>('SELECT * FROM jobs WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY id', ...w),
      checkpoints: this.all<CheckpointRow>('SELECT * FROM checkpoints WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY id', ...w),
      integrations: this.all<IntegrationRow>('SELECT * FROM integrations WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY id', ...w),
    }))
  }

  // `activity` (p8/ex2, server/activity.ts): what the attempt's own log says,
  // observed only on the host that has the log (null elsewhere).
  async runView(workspace: string, ref: RunRef) {
    const rows = this.all<AttemptRow>('SELECT * FROM attempts WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY began', workspace, ref.workflow, ref.run)
    // A remote worker's process is not this host's to look at (p7); its log is
    // shipped here, so its activity is read like the local worker's.
    const attempts = await Promise.all(rows.map(async a => ({ ...a, baseline: undefined, response: undefined, alive: a.state === 'ended' ? false : this.localPid(a) ? alive(a.pid) : null,
      activity: this.localPid(a) || this.isRemote(a.worker) ? await activityOf(a.log) : null })))
    const jobs = this.all<JobRow>('SELECT * FROM jobs WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY id', workspace, ref.workflow, ref.run)
    const checkpoints = this.all<CheckpointRow>('SELECT * FROM checkpoints WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY id', workspace, ref.workflow, ref.run)
      .map(c => ({ ...c, baseline: undefined, steps: JSON.parse(c.steps) as RepoStep[] }))
    const integrations = this.integrations(workspace, ref).map(i => ({ ...i, steps: JSON.parse(i.steps) as IntegrationStep[] }))
    return { attempts, jobs, checkpoints, integrations, executor: this.executorState(), workers: this.workersState() }
  }
}
