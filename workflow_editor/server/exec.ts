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
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_LANE, sessionPolicyOf, type Workflow } from '../shared/model.ts'
import { attemptContext, renderContext, type AttemptContext } from '../shared/context.ts'
import { contextErrors, resolveContext } from './context.ts'
import { ContextStore } from './contextStore.ts'
import { configChanges, currentSession, definitionMeaningBrief, unverifiedReason, unverifiedSession, describeSteps, effectiveOf, holderOf, hostOf, openCorrections, pendingInstructions, runKey, sameConfig, sessionConfig, situation, standingEvents, type AttemptSession, type AttemptSettings, type BecauseRef, type RecoveryAgent, type RunRecord, type RunRef } from '../shared/run.ts'
import { wake } from './standing.ts'
import { git } from './git.ts'
import { docStepsOf } from '../shared/compile.ts'
import { WORKFLOW_TALK, WORKFLOW_TALK_INSTRUCTIONS } from '../shared/workflowTalk.ts'
import { assertWorkspaceAllowed, loadBoundary } from './boundary.ts'
import type { Gitea } from './gitea.ts'
import { baseline, publish, publishRun, type Baseline, type RepoStep } from './publish.ts'
import { guardsFor, integrate, type Guard, type IntegrationState, type IntegrationStep } from './integrate.ts'
import { loadRegistry, observe, recordedWorkspace, type Registration } from './registry.ts'
import { catalogOf, createRunInCopy, listRuns, readRun, RUN_FILE, runDir, runOp } from './runs.ts'
import { readCopy, runSpace, treeSpace } from './runspace.ts'
import { atomicWrite } from './files.ts'
import type { DefinitionCheck } from '../shared/run.ts'
import { withLock } from './lock.ts'
import { catalogBrief } from '../shared/catalog.ts'
import { activityOf } from './activity.ts'
import { DelegateStore, assessDelegation } from './delegate.ts'
import { ReviewHost } from './reviews.ts'
import { hostOwes, openContinuations, openReleases, owedContinuation, owedRelease, roundLine, roundOf, startedInstances, stillServing } from '../shared/humanReview.ts'
import { assessmentLines } from '../shared/assessment.ts'
import { delegationState, isOpenDelegation, pendingEvents } from '../shared/delegation.ts'
import { named, openStore, transaction } from './sqlite.ts'
import { briefedSteps, changeLines, newStepLines, pendingAnswerLines, stateLines } from './continuation.ts'
import { RequestError, Workspace } from './workspace.ts'
import { alignRecordCopy, isCoordinationLane, isCoordinationRun, isLocalNode, laneOn, loadWorkers, nodeOfRecord, workerTree, type WorkersConfig } from './workers.ts'

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
// `busy` is the first open attempt of the default lane (what "the slot" was
// before improve_wfrun p4); `slots` every open attempt of the worker with its
// lane, `lanes` the extra lane names it serves, `load` what its executor last
// measured of its host (p4: evidence for warden's judgment, never a gate).
export interface WorkerState { id: string; label: string; local: boolean; default: boolean; state: 'available' | 'unavailable' | 'unknown'; at: string | null; ageSeconds: number | null; pid: number | null; reported: string | null; detail: string
  busy: { attempt: string; workspace: string; workflow: string; run: string; state: string; stopRequested: string | null } | null
  slots: { attempt: string; workspace: string; workflow: string; run: string; state: string; stopRequested: string | null; lane: string; decision: number | null }[]
  lanes: string[]
  coordination: boolean
  queued: { id: number; workspace: string; workflow: string; run: string; kind: string; note: string | null; decision: string | null; deferUntil: string | null }[]
  profiles: string[] | null; facts: WorkerFacts | null; load: WorkerLoad | null }
export interface HostOffer { profiles?: Record<string, string>; contract?: { name: string; sha256: string }; sessions?: Record<string, 'explicit'> }
// What a worker says about itself (p7) beside its offer: a label, where its
// run copies are, the facts of its host an agent works under (OS, tools,
// display) and the software it runs. Shown in briefs and views; not a gate.
// `load` (improve_wfrun p4): what the executor measured when it reported.
export interface WorkerFacts { label?: string; root?: string; host?: Record<string, string>; software?: Record<string, string>; load?: WorkerLoad }
export interface WorkerLoad { at: string; cpus?: number; load1?: number; load5?: number; memTotalMB?: number; memFreeMB?: number; gpu?: { name?: string; memUsedMB?: number; memTotalMB?: number; utilPercent?: number }[]; processes?: number; detail?: string }
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
// The run folder is named as a path whatever the policy (tidy p1): "this
// run's folder" in a request or a node's description was resolved against
// the copy's root about half the time, so root report.md / answer.md /
// review.md files read as the project's own and each run overwrote the last.
export const runFolderLine = (r: RunRef) => `Run folder: ${runDir(r)}/ (relative to your working directory, the copy's root). The run's own documents go there: its plan and reports, an answer or review notes, whatever the request or a node asks to write "in the run folder". A file of the same name at the project root reads as the project's own and the next run overwrites it (tidy p1: protoprey freework/run-003 wrote its final report as the root report.md, replacing another run's; agops recover runs did the same eleven times). Saving a file there is enough: WFE publishes the folder itself, so leave it out of your own git commands (git refuses them there, improve_wfrun p2).`

// Deliver the built-in contract even while the node follows the initial talk.
// It must not depend on an optional guide read or an editable local catalog.
export function workflowTalkBrief(r: RunRecord): string[] {
  const nodes = Object.entries(effectiveOf(r)?.nodes ?? {}).filter(([id, n]) => n.type === WORKFLOW_TALK && ['pending', 'running', 'waiting'].includes(r.nodes[id]?.state))
  return nodes.length ? ['', `Workflow consultation (${nodes.map(([id]) => `${id}: ${r.nodes[id].state}`).join('; ')}):`, WORKFLOW_TALK_INSTRUCTIONS] : []
}

export function documentationBrief(r: RunRecord): string[] {
  const eff = effectiveOf(r) // the revision in force (p7)
  if (!eff) return ['Documentation policy: none (this run was created before p5); plans and reports are available as optional records.', runFolderLine(r)]
  const d = docStepsOf(eff)
  if (!d.plan && !d.reports && !d.final) return [`Documentation policy: ${eff.policy}. No plan or report is a step of this run; documents can still be written when useful.`, runFolderLine(r)]
  // The steps this run has (p8/ex2: any of the three), by name.
  const named = [d.plan && '_plan', d.reports && '_report.<node>', d.final && '_final-report'].filter(Boolean).join(', ')
  const absent = [!d.plan && 'no plan talk', !d.reports && 'no per-node reports', !d.final && 'no final report'].filter(Boolean)
  const out = [`Documentation policy: ${eff.policy} (${describeSteps(d)}). ${named} ${named.includes(',') ? 'are steps' : 'is a step'} of this run, recorded like any node (start, complete); each is optional; available documents are recorded by hash.${absent.length ? ` This run has ${absent.join(' and ')}: documents can still be written when useful.` : ''}`, runFolderLine(r)]
  const now = [...new Set([...r.execution.active, ...r.execution.ready, ...r.execution.waiting.map(w => w.node)])]
  for (const id of now) {
    const step = eff.nodes[id]?.step
    if (!step) continue
    const state = r.nodes[id]?.state
    out.push('', `Step ${id} (${state === 'pending' ? 'ready' : state}): ${step.purpose}. Document: ${runDir(r)}/${step.output}.${step.for && r.nodes[step.for]?.state === 'completed' ? ` Node ${step.for} is completed; only its report remains.` : ''}`, step.instructions)
  }
  // Steps not reached yet still have a place (tidy p1: run-003 was briefed
  // while only its talk was ready, and never learned where report.md goes).
  const later = Object.entries(eff.nodes).filter(([id, n]) => n.step && !now.includes(id) && r.nodes[id]?.state === 'pending')
  if (later.length) out.push('', `Documents of steps not reached yet: ${later.map(([id, n]) => `${id} → ${runDir(r)}/${n.step!.output}`).join('; ')}.`)
  return out
}
// The person's additional instructions as the attempt starts (p6): the
// unacknowledged ones in full, in arrival order. More may arrive while it
// works; wfe run state shows them. Acknowledgment is a record, not a gate (p11).
// Challenges the input carried (challenge p1, docs/challenges.md): each as
// it was when attached, its summary in the run folder, and how to read its
// files and trials then and its current revision — a separate, explicit read.
// Files a message carried (p19, docs/message-files.md): each occurrence with
// its source message and how to get its verified bytes on this host.
const fileLine = (a: import('../shared/intake.ts').FileAttachmentRef) => `"${a.name}" (${a.mime}, ${a.bytes} bytes, sha256 ${a.sha256.slice(0, 12)}…) from ${a.conversation} #${a.message}, file ${a.ordinal}: wfe conversation fetch ${a.conversation} --message ${a.message} --attachment ${a.id}`
export function attachmentBrief(r: RunRecord, dir: string): string[] {
  const all = r.input.attachments ?? []
  if (!all.length) return []
  const challenges = all.filter(a => a.kind === 'challenge'), files = all.filter(a => a.kind === 'file')
  const words = r.input.kind === 'request' ? 'request' : 'person\'s words'
  return [
    ...(challenges.length ? [`Attached to the ${words} (${challenges.length}): durable challenges, each as it was when attached (wfe challenge help):`,
      ...challenges.map(a => `- ${a.id} "${a.title}" at ${a.commit.slice(0, 12)}: ${dir}/${a.file}; its files and trials then: wfe challenge show ${a.id} --at ${a.commit.slice(0, 12)}; its latest revision: wfe challenge show ${a.id}`)] : []),
    ...(files.length ? [`Files the ${words} carried (${files.length}; the original bytes are on the share, checked against their hash when fetched; fetch writes into .local/attachments/ unless --out says otherwise):`,
      ...files.map(a => `- ${fileLine(a)}`)] : []),
  ]
}
// What an answer's or an instruction's source carried.
export const attachedLines = (s: import('../shared/intake.ts').SourceRef | undefined, indent = '    ') =>
  s?.kind === 'conversation' && s.attachments?.length ? s.attachments.map(a => a.kind === 'file' ? `${indent}file: ${fileLine(a)}` : `${indent}attached: ${a.id} "${a.title}" at ${a.commit.slice(0, 12)} — wfe challenge show ${a.id} --at ${a.commit.slice(0, 12)}`) : []

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

// p18: a long-lived run's lists stay short — what is open in full, the
// latest few closed ones, and a count of the rest with where to read them.
const BRIEF_CLOSED = 3
function recentClosed<T>(all: T[], open: (x: T) => boolean): { shown: T[]; folded: number } {
  const closed = all.filter(x => !open(x))
  const keep = new Set(closed.slice(-BRIEF_CLOSED))
  const shown = all.filter(x => open(x) || keep.has(x))
  return { shown, folded: all.length - shown.length }
}
// A standing conductor's own facts (p18, docs/runs.md *Standing runs*).
export function standingBrief(r: RunRecord): string[] {
  const st = r.standing
  if (!st) return []
  const out = ['', `This run is the standing conductor of conversation ${st.conversation} (${st.state} since ${st.since}): one run for the conversation's whole life. When nothing of it is ready or running it rests, holding no attempt and no slot, and the conversation's next words wake it with a new ponder node. Its graph keeps every earlier turn as recorded; wfe conversation state ${st.conversation} shows the current stretch and what is open in full and folds completed stretches.`]
  const w = st.wakes.at(-1)
  if (w && r.nodes[w.node] && r.nodes[w.node].state !== 'completed') out.push(`This turn: wake ${w.n}, node ${w.node}, for ${w.events.join(', ')} (the instructions below). Completed nodes stay completed and are not repeated; earlier work that is still open (an ask, a review, a child) keeps its own nodes and does not wait on this one.`)
  if (st.held.length) out.push(`Held until the person resumes (wfe conversation resume ${st.conversation}): ${st.held.join(', ')}. They waited while the room was closed (or before this run stood); they are here for context, not to be taken up unless the person asks.`)
  return out
}

export function presentationBrief(r: RunRecord): string[] {
  const every = Object.values(r.presentations ?? {})
  if (!every.length) return []
  const { shown: all, folded } = recentClosed(every, p => p.state !== 'stopped')
  return ['', `Presentations of this run (wfe present status <run> says what is served now)${folded ? `; ${folded} earlier stopped one${folded === 1 ? ' is' : 's are'} not listed` : ''}:`,
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
      `${person ? `The work is for ${person}; ` : ''}${r.input.requester} relays between you: your questions reach it through the request topic, as they would a person (ask them --to ${r.input.requester}), and what you present reaches ${person ?? 'its person'} through it — a presentation you register and ask about is relayed with its link. A report of file paths to ${r.input.requester} is not a presentation to ${person ?? 'the person'}. Who accepts the result: ${ent.accepts === 'person' ? `${person ?? 'the person'} (their answer, relayed)` : `${r.input.requester}`}; the requesting agent records its own answers and decisions.`,
      `Your result is assessed where ${r.input.requester} receives it: your outcome and report beside the files your copy changed, removed and published (tidy p2). Say what changed and at which commit, which checks actually ran with their results, and what is unverified or left; the paths you name are looked up. When only reporting is left, WFE prints the questions that fit your changes.`)
  }
  out.push(...correctionBrief(r))
  out.push(...reviewBrief(r))
  const every = Object.values(r.delegations ?? {})
  if (!every.length) return out
  const { shown: all, folded } = recentClosed(every, d => isOpenDelegation(d) || pendingEvents(d).length > 0)
  out.push('', `Delegations of this run (wfe delegate show <run> <d>; help: wfe delegate help)${folded ? `; ${folded} earlier closed one${folded === 1 ? ' is' : 's are'} not listed (wfe delegate list ${runKey(r)})` : ''}:`)
  for (const d of all) {
    out.push(`- ${d.id} from ${d.node} to ${d.target.project}/${d.target.workflow}: ${delegationState(d)}${d.child ? `; child ${d.child.workflow}/${d.child.run} in ${d.child.workspace}` : '; no child yet (the request is being delivered)'}${d.disposition ? ` — judged ${d.disposition.kind}: ${d.disposition.note}` : ''}`)
    for (const e of pendingEvents(d)) {
      out.push(`  - event ${e.n} (${e.type}${e.question ? ` ${e.question}` : ''}${e.confirms ? ', confirms the result' : e.plan ? ', agrees the plan' : ''}), not taken up:`, ...e.text.split('\n').map(l => `      ${l}`))
      if (e.document) out.push(`      document: ${e.document.path} (${e.document.sha256.slice(0, 12)})`)
      for (const f of e.subject ?? []) out.push(`      presented: ${f.path} (${f.sha256.slice(0, 12)})`)
      if (e.manifest) out.push(`      result manifest ${e.manifest.digest.slice(7, 19)}: ${e.manifest.execution}; report ${e.manifest.report?.path ?? '(none)'}; ${e.manifest.artifacts.length} artifact(s)`)
      if (e.type === 'completed' && assessed[d.id]) out.push(...assessed[d.id].map(l => `    ${l}`))
    }
    // tidy p3: trial 6's account (#481) presented a result returned once as
    // simply done; the correction history reached it only in the reply's output.
    if ((d.revisions ?? []).length || d.reopened?.length) out.push(`  - its history, for your account: ${(d.revisions ?? []).map(r => `result event ${r.event} returned for correction (request ${r.n}: ${r.reason.replace(/\s+/g, ' ').slice(0, 100)})`).join('; ')}${d.reopened?.length ? `; ${d.reopened.length === 1 ? 'a satisfied judgement was' : `${d.reopened.length} satisfied judgements were`} set aside` : ''}`)
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
  const every = Object.values(r.reviews ?? {})
  if (!ready.length && !every.length) return []
  const { shown: rounds, folded } = recentClosed(every, v => v.state !== 'complete' && v.state !== 'cancelled' || owedContinuation(v) || !!v.release?.unlocked.some(n => r.execution.ready.includes(n)))
  const out = ['', `Human review (wfe review help)${folded ? `; ${folded} earlier finished round${folded === 1 ? ' is' : 's are'} not listed (wfe review list ${run})` : ''}:`]
  for (const id of ready) out.push(`- ${id} is a human review node, ready: after your own review, hand the result to the person with wfe review prepare ${run} ${id} --summary "<what was done, what to check>" --subject <p1 | d1[:p2] | workspace:workflow/run:p1>…. Their review needs no process: end the attempt once your other work is done; the person starts it with one button, and approval or requested changes come back as records.`)
  for (const v of rounds) {
    out.push(`- ${roundLine(v)}`)
    if (owedContinuation(v)) {
      const handed = v.cleanup?.state === 'handed' ? startedInstances(v) : []
      out.push(`    ${v.decision!.by}${v.decision!.synthetic ? ' (a synthetic check actor)' : ''} requested changes at ${v.decision!.at}: ${v.decision!.feedback.split('\n').join('\n    ')}`,
        `    Take them up (wfe review take-up ${run} ${v.id}) and append the work as nodes after ${v.node} — your own work node, or the same child again (reopen its delegate node with wfe run start ${run} <node> --reason "…", then wfe delegate revise ${run} <d> --follow-up ${v.id} --instruction "…" --reason "…") — and a new human review node after it (wfe nodes instantiate human-review --run ${run} --after <work>), prepared with the corrected presentations. The run stays open until then. If nothing should change: wfe review take-up ${run} ${v.id} --no-change --note "why".`,
        ...(handed.length ? [`    The review left ${handed.map(x => x.instance).join(', ')} serving; it is yours now: keep it to compare, or stop it (wfe review cleanup ${run} ${v.id}). The next approval stops what is left.`] : []))
    }
    // The work an approval made ready (p17 ex1), while it is still ready.
    const next = v.release?.unlocked.filter(n => r.execution.ready.includes(n)) ?? []
    if (v.state === 'complete' && next.length) {
      const stopped = v.cleanup?.results.filter(c => c.status === 'stopped').map(c => c.instance) ?? []
      const on = stillServing(v)
      out.push(`    ${v.decision!.by}${v.decision!.synthetic ? ' (a synthetic check actor)' : ''} approved it at ${v.decision!.at}${v.decision!.feedback ? `: ${v.decision!.feedback.split('\n').join('\n    ')}` : ''}`,
        `    Ready now because of it: ${next.join(', ')}. Do that work as usual. ${stopped.length ? `WFE's review cleanup already stopped and verified ${stopped.join(', ')}; stopping it again reports that nothing serves it. ` : ''}${on.length ? `Not stopped by the review: ${on.map(c => `${c.instance} (${c.status === 'left' ? `serving for ${c.owner ?? 'its run'}` : `kept${c.owner ? ` for ${c.owner}` : ''}`})`).join(', ')}. ` : ''}The approval asks for nothing more of the person.`)
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

// `decision` (improve_wfrun p4, docs/coordination.md): how the job is
// admitted — `start` (warden's decision, or a standing one of its run),
// `defer` (warden deferred it; `defer_until` when it is looked at again by
// time), NULL: awaiting warden's decision. `decision_id` names the row.
export interface JobRow { id: number; receipt: string; kind: 'start' | 'resume'; workspace: string; workflow: string; run: string; reason: string; state: 'queued' | 'claimed' | 'done' | 'dropped'; created: string; claimed: string | null; attempt: string | null; note: string | null; worker: string | null; decision: 'start' | 'defer' | null; decision_id: number | null; defer_until: string | null }
export interface AttemptRow { id: string; job: number; workspace: string; workflow: string; run: string; host: string; pid: number | null; state: 'launching' | 'running' | 'ended'; began: string; ended: string | null; exit_code: number | null; signal: string | null; outcome: string | null; log: string | null; stop_requested: string | null; backend: string | null; baseline: string | null; worker: string | null; claim: string | null; response: string | null; lane: string | null; decision: number | null }
// One coordination decision (improve_wfrun p4): what warden decided about a
// run's queued work, why, on what it looked at, and what came of it.
// `scope` run: a `start` stands for the run's later jobs on that worker and a
// `defer` for them too, until a later decision; job: this job only.
// `state`: applied, stale (the basis it was made on had changed; nothing
// applied), refused (a constraint or the record refused it), superseded.
export interface DecisionRow { id: number; at: string; by: string; action: 'start' | 'defer' | 'assign' | 'note'; workspace: string; workflow: string; run: string; job: number | null; worker: string | null; scope: 'run' | 'job'; reason: string; observations: string | null; assumptions: string | null; reconsider: string | null; basis: string | null; state: 'applied' | 'stale' | 'refused' | 'superseded'; detail: string | null; agent: string | null; attempt: string | null; woken: string | null; batch: number | null }
export interface Reconsider { until?: string; on?: string[] }
// What prompts warden to look (p4): a job queued, an attempt ended, a
// worker's contact gained or lost, an explicit request to reconsider, a
// deferral's wake time. `taken_by` is the coordination attempt that had it.
export type CoordinationEventKind = 'queued' | 'attempt-ended' | 'worker-available' | 'worker-unavailable' | 'reconsider' | 'wake'
export interface CoordinationEventRow { id: number; at: string; kind: CoordinationEventKind; workspace: string | null; workflow: string | null; run: string | null; job: number | null; attempt: string | null; worker: string | null; detail: string | null; taken_by: string | null; taken_at: string | null }
// One coordination run's turn (p4): created when something awaits a
// decision, one at a time; ended with how many decisions it applied.
export interface CoordinationBatchRow { id: number; created: string; state: 'creating' | 'open' | 'ended' | 'failed' | 'lost'; workspace: string | null; workflow: string | null; run: string | null; job: number | null; attempt: string | null; ended: string | null; outcome: string | null; decisions: number; error: string | null }
// Why a queued job is not claimable yet, or is (p4).
export type Admission = { ok: true; decision: number | null; how: 'decision' | 'standing' | 'coordination' } | { ok: false; why: string; awaiting: boolean; decision: number | null }
export interface CoordinationRunFacts { readable: boolean; project: string | null; request: string | null; active: string[]; ready: string[]; progress: { op: string; at: string; node: string | null; text: string | null } | null; situation: string | null; hold: string | null; placed: string | null; constraint: string | null; requester: string | null; created: string | null; seq: number | null }
// What warden reads before deciding (p4): every worker with its contact,
// load and open attempts; every queued ordinary job with its admission;
// recent decisions, pending events, the coordination path's own state.
export interface CoordinationView {
  schema: 'ag.wfe-coordination.v1'; observedAt: string; configured: boolean; coordination: import('./workers.ts').CoordinationSetting | null
  turn: { id: number; state: string; run: string | null; attempt: string | null; since: string } | null
  stalled: { since: string; failures: number; until: string; last: string } | null
  recentTurns: { id: number; state: string; run: string | null; created: string; ended: string | null; outcome: string | null; decisions: number; error: string | null }[]
  workers: { id: string; label: string; local: boolean; default: boolean; coordination: boolean; state: string; heartbeatAt: string | null; ageSeconds: number | null; load: WorkerLoad | null; profiles: string[] | null; host: Record<string, string> | null
    attempts: { attempt: string; workspace: string; workflow: string; run: string; project: string | null; lane: string; coordination: boolean; state: string; began: string; stopRequested: string | null; decision: number | null; request: string | null; active: string[]; progress: CoordinationRunFacts['progress']; logLast: string | null; pid: number | null }[] }[]
  queued: { job: number; workspace: string; workflow: string; run: string; project: string | null; kind: string; reason: string; created: string; worker: string; lane: string; admission: 'awaiting' | 'deferred' | 'admitted'; decision: { id: number; by: string; at: string; action: string; scope: string; reason: string; reconsider: Reconsider | null } | null; note: string | null; servable: boolean; request: string | null; requester: string | null; created_run: string | null; ready: string[]; situation: string | null; placed: string | null; constraint: string | null; basis: string | null }[]
  decisions: (Omit<DecisionRow, 'observations' | 'assumptions' | 'reconsider' | 'agent'> & { observations: string[] | null; assumptions: string[] | null; reconsider: Reconsider | null; agent: RecoveryAgent | null })[]
  events: CoordinationEventRow[]
  needs: { yes: boolean; why: string[] }
}
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

// A worker's part in a run's working-copy lifecycle (improve_wfrun p2).
export interface StorageTask { workspace: string; workflow: string; run: string; action: 'archive' | 'remove'; generation: number; repositories?: { path: string; head: string | null }[] }

// The coordination turn a job was queued for (improve_wfrun p4), from its receipt.
const turnOfReceipt = (receipt: string): number | null => { const m = /^request:coordinate:turn-(\d+)$/.exec(receipt); return m ? Number(m[1]) : null }

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
    }, {
      // improve_wfrun p4: agent-directed execution coordination. Jobs carry
      // warden's decision; decisions, the events that prompt them and the
      // coordination runs' turns are journaled here. Jobs queued before this
      // release await a decision like any other.
      version: 5,
      up: db => db.exec(`
        ALTER TABLE jobs ADD COLUMN decision TEXT;
        ALTER TABLE jobs ADD COLUMN decision_id INTEGER;
        ALTER TABLE jobs ADD COLUMN defer_until TEXT;
        ALTER TABLE attempts ADD COLUMN decision INTEGER;
        ALTER TABLE heartbeat ADD COLUMN seen_state TEXT;
        CREATE TABLE decisions (id INTEGER PRIMARY KEY, at TEXT NOT NULL, by TEXT NOT NULL, action TEXT NOT NULL, workspace TEXT NOT NULL, workflow TEXT NOT NULL, run TEXT NOT NULL,
          job INTEGER, worker TEXT, scope TEXT NOT NULL, reason TEXT NOT NULL, observations TEXT, assumptions TEXT, reconsider TEXT, basis TEXT, state TEXT NOT NULL, detail TEXT,
          agent TEXT, attempt TEXT, woken TEXT, batch INTEGER);
        CREATE INDEX decisions_run ON decisions (workspace, workflow, run, id);
        CREATE TABLE coordination_events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, workspace TEXT, workflow TEXT, run TEXT, job INTEGER, attempt TEXT, worker TEXT, detail TEXT, taken_by TEXT, taken_at TEXT);
        CREATE TABLE coordination_batches (id INTEGER PRIMARY KEY, created TEXT NOT NULL, state TEXT NOT NULL, workspace TEXT, workflow TEXT, run TEXT, job INTEGER, attempt TEXT, ended TEXT, outcome TEXT, decisions INTEGER NOT NULL DEFAULT 0, error TEXT);
      `),
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
    const reg = recordedWorkspace((await loadRegistry(this.ctx.registryFile)).workspaces, id)
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
  // `standing` (p18): the run is created as a conversation's standing conductor.
  async request(o: { workspace: string; workflow: string; text: string; author: string; receipt: string; by?: string; via: string; predecessor?: RunRef; node?: string; source?: import('../shared/intake.ts').SourceRef; input?: Extract<import('./runs.ts').CreateRunOptions['input'], { kind: 'request' }>; attachments?: import('./runs.ts').PinnedAttachment[]; standing?: { conversation: string; replaces?: string }; trial?: import('./runs.ts').CreateRunOptions['trial'] }): Promise<{ job: JobRow; ref: RunRef; duplicate: boolean }> {
    if (!/^[A-Za-z0-9:._/#-]{8,200}$/.test(o.receipt)) throw new RequestError(400, 'a request needs a receipt id (8–200 of A-Z a-z 0-9 : . _ / # -)')
    const seen = this.one<JobRow>('SELECT * FROM jobs WHERE receipt = ?', `request:${o.receipt}`)
    if (seen) return { job: seen, ref: { workflow: seen.workflow, run: seen.run }, duplicate: true }
    const ws = await this.workspace(o.workspace)
    // The run gets its own working copy (p9); the same receipt finds it again.
    const env = this.ctx.gitea ? await this.ctx.gitea.gitEnv() : {}
    const attachments = o.attachments?.length ? { attachments: o.attachments } : {}
    const created = await createRunInCopy(ws, { workflow: o.workflow, input: o.input ? { ...o.input, ...attachments } : { kind: 'braindump', text: o.text, author: o.author, recordedBy: o.by, ...(o.source ? { source: o.source } : {}), ...attachments }, executor: { host: this.executor, ...(o.node ? { node: o.node } : {}) }, by: o.by ?? o.author, via: o.via, area: this.ctx.area, receipt: `request:${o.receipt}`, ...(o.predecessor ? { predecessor: o.predecessor } : {}), ...(o.standing ? { standing: o.standing } : {}), ...(this.ctx.gitea ? { access: this.accessContext() } : {}), ...(o.trial ? { trial: o.trial } : {}) }, env)
    const job = this.enqueue(ws.reg.id, created.ref, 'start', `request:${o.receipt}`, o.input ? `start: ${o.input.requester}'s request` : 'start: the person\'s request', this.nodeOf(created.record))
    return { job, ref: created.ref, duplicate: false }
  }

  // Queues one job; an existing job with the same receipt, or a queued or
  // claimed job of the same run, is returned instead.
  // `worker`: the node the run is assigned to, when the caller knows it (a
  // view fact; the claim reads the record again).
  // improve_wfrun p4: an ordinary job is admitted by warden's decision. A
  // standing decision of its run (on this worker) admits or defers it at
  // once; otherwise it awaits one, and the queued event prompts warden.
  enqueue(workspace: string, ref: RunRef, kind: 'start' | 'resume', receipt: string, reason: string, worker: string | null = null): JobRow {
    return this.tx(() => {
      const same = this.one<JobRow>('SELECT * FROM jobs WHERE receipt = ?', receipt)
      if (same) return same
      const open = this.one<JobRow>('SELECT * FROM jobs WHERE workspace = ? AND workflow = ? AND run = ? AND state IN (\'queued\', \'claimed\')', workspace, ref.workflow, ref.run)
      if (open) return open
      const id = Number(this.run('INSERT INTO jobs (receipt, kind, workspace, workflow, run, reason, state, created, worker) VALUES (?, ?, ?, ?, ?, ?, \'queued\', ?, ?)', receipt, kind, workspace, ref.workflow, ref.run, reason, now(), worker).lastInsertRowid)
      const cfg = this.workers()
      if (cfg.coordination && !isCoordinationRun(cfg, workspace, ref.workflow)) {
        const job = this.one<JobRow>('SELECT * FROM jobs WHERE id = ?', id)!
        const a = this.standingAdmission(job, worker ?? cfg.default)
        this.event('queued', { workspace, workflow: ref.workflow, run: ref.run, job: id, worker, detail: `${kind}: ${reason}${a ? `; ${a.ok ? 'admitted' : 'deferred'} by standing decision ${a.decision}` : ''}` })
      }
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
    if (r?.standing) return this.afterStanding(ws, ref)
    if (!r || hostOf(r.executor) !== this.executor || r.cancelled || r.control.hold || r.control.attempt) return null
    const ins = r.instructions?.[instruction]
    if (!ins || ins.ack || r.execution.state === 'completed') return null
    return this.enqueue(ws.reg.id, ref, 'resume', `instruction:${ws.reg.id}/${runKey(ref)}/${instruction}`, `resume: instruction ${instruction} received`, this.nodeOf(r))
  }

  // A standing conductor (p18, docs/runs.md *Standing runs*) is continued for
  // the conversation's words no attempt was briefed with: with work ready,
  // as any run (one job); with nothing ready or running — at rest, or only
  // waiting on asks, reviews or children — WFE first appends one ponder node
  // (the wake, decided under the run's lock: two callers append one) and
  // queues one attempt for it. A room that is not open, a hold or an open
  // attempt wakes nothing: the attempt reads them at its next boundary and
  // the end of the attempt calls here again; a hold waits for its resume.
  // `resume`: the person's explicit resume also continues a conductor that
  // stands suspended (facilitation ended) for what it was given.
  async afterStanding(ws: Workspace, ref: RunRef, o: { resume?: boolean } = {}): Promise<JobRow | null> {
    let r = (await readRun(ws, ref)).record
    if (!r?.standing || hostOf(r.executor) !== this.executor || r.cancelled || r.control.hold || r.control.attempt || r.standing.state === 'closed' || (r.standing.state === 'suspended' && !o.resume)) return null
    const events = standingEvents(r)
    if (!events.length) return null
    if (!r.execution.ready.length && !r.execution.active.length) {
      const w = await wake(ws, ref, o)
      if (w.record) r = w.record
      if (w.wake) return this.enqueue(ws.reg.id, ref, 'resume', `wake:${ws.reg.id}/${runKey(ref)}/w${w.wake.n}`, `resume: woken by the conversation for ${w.wake.events.join(', ')} (node ${w.wake.node})`, this.nodeOf(r))
      r = (await readRun(ws, ref)).record ?? r
      if (!r.execution.ready.length && !r.execution.active.length) return null
    }
    const pending = standingEvents(r)
    if (!pending.length || r.control.attempt || r.control.hold) return null
    return this.enqueue(ws.reg.id, ref, 'resume', `instruction:${ws.reg.id}/${runKey(ref)}/${pending[0]}`, `resume: instruction ${pending.join(', ')} received; ${r.execution.ready.join(', ') || r.execution.active.join(', ')} takes ${pending.length === 1 ? 'it' : 'them'} up`, this.nodeOf(r))
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
    return this.enqueue(ws.reg.id, ref, 'resume', `correction:${ws.reg.id}/${runKey(ref)}/${correction}`, `resume: correction ${correction} from ${k.from} (${k.request ? `its requesting run ${k.request.run}` : "the delegating run"} returned the result)`, this.nodeOf(r))
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
  // After an approval's cleanup completed its round (p17 ex1): the work the
  // review node's completion made ready is continued once per completion,
  // by an ordinary attempt on the run's own node. The one rule for its three
  // deliveries — the cleanup's callback, the end of an attempt that was open
  // meanwhile, reconcile after a lost callback or queue write: nothing
  // executes the run now (an open attempt is reassessed when it ends), it is
  // not held (a resume picks the work up), cancelled or completed, and no
  // attempt has begun since the completion (the first one that did owns the
  // work: the release is consumed by its attempt.begin). The receipt binds
  // the job to the round (whose uid carries the run's creation) and the
  // completing entry, so a later round never reuses it.
  async afterRelease(ws: Workspace, ref: RunRef, review: string): Promise<JobRow | null> {
    const r = (await readRun(ws, ref)).record
    if (!r || hostOf(r.executor) !== this.executor || r.cancelled || r.control.hold || r.control.attempt || r.execution.state === 'completed') return null
    const v = r.reviews?.[review]
    if (!v || !owedRelease(v, r)) return null
    const ready = v.release!.unlocked.filter(n => r.execution.ready.includes(n))
    return this.enqueue(ws.reg.id, ref, 'resume', `review-approved:${ws.reg.id}/${v.uid}@${v.release!.seq}`, `resume: ${ready.join(', ')} ready after ${v.decision?.by ?? 'the person'} approved review ${review}`, this.nodeOf(r))
  }
  // The host side of human reviews: starting subjects, cleanup (p17).
  private _reviews?: ReviewHost
  get reviews(): ReviewHost { return this._reviews ??= new ReviewHost({ registryFile: this.ctx.registryFile, area: this.ctx.area, continued: (ws, ref, id) => this.afterReview(ws, ref, id), released: (ws, ref, id) => this.afterRelease(ws, ref, id) }) }

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
    if (lane !== DEFAULT_LANE && !cfg.workers[worker].lanes.includes(lane)) throw new RequestError(400, `worker "${worker}" has no lane "${lane}" (${[DEFAULT_LANE, ...cfg.workers[worker].lanes].join(', ')}); declare it in workers.json`, { code: 'lane-unknown' })
    // improve_wfrun p4: the coordination lane serves coordination runs, one
    // at a time, admitted by nothing but their queue; every other lane of the
    // worker serves ordinary work, each job once warden decided it starts.
    const coordination = isCoordinationLane(cfg, worker, lane)
    const where = lane === DEFAULT_LANE ? '' : ` in lane ${lane}`
    if (o.receipt) {
      const again = this.one<AttemptRow>('SELECT * FROM attempts WHERE worker = ? AND claim = ?', worker, o.receipt)
      if (again?.response && again.state === 'launching') return JSON.parse(again.response)
      if (again) return { idle: `claim ${o.receipt} was answered with attempt ${again.id}, which is ${again.state}` }
    }
    // An area without coordination (no `coordination` in workers.json: a
    // fixture, an isolated area) keeps one attempt per lane, as before p4.
    const legacy = !cfg.coordination
    const laneHeld = () => this.all<AttemptRow>('SELECT * FROM attempts WHERE state != \'ended\' AND worker = ? AND coalesce(lane, ?) = ? ORDER BY began', worker, DEFAULT_LANE, lane)
    if (coordination || legacy) {
      const held = laneHeld()
      if (held.length) return { idle: `the ${coordination ? 'coordination lane' : 'slot'}${remote ? ` of ${worker}` : ''}${coordination ? '' : where} is held by ${held.map(b => `attempt ${b.id} (${b.workspace} ${b.workflow}/${b.run})`).join(', ')}` }
    }
    const waiting: string[] = []
    let awaiting = 0
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
      if (job.worker !== node) { this.run('UPDATE jobs SET worker = ? WHERE id = ?', node, job.id); job.worker = node }
      if (node !== worker) continue
      // The coordination lane's jobs are its own; every other job is ordinary
      // work (p4). Without coordination each lane takes its own jobs (p8).
      const jobLane = laneOn(cfg.workers[worker], rec.executor.lane)
      if (legacy ? jobLane !== lane : isCoordinationLane(cfg, worker, jobLane) !== coordination) continue
      // One execution mode (p9): a run works in its own copy. A run recorded
      // in the project workspace before p9 is migrated first.
      if (!space.copyOf) { drop(`the run has no working copy of its own (recorded before p9); migrate it first (wfe runs migrate --workspace ${job.workspace})`); continue }
      if (rec.cancelled) { drop('the run is cancelled'); continue }
      if (rec.control.hold) { drop(`the run is held (${rec.control.hold.kind}); a person resumes it`); continue }
      if (rec.control.attempt) { drop(`attempt ${rec.control.attempt.id} is still open in run.json`); continue }
      // improve_wfrun p2: a continuation of a retired run restores it first;
      // one that arrives during a retirement wins at the retirement's last check.
      if (space.copyOf.treeless) {
        const state = (await readCopy(ws.shared, ref))?.manifest?.state
        if (state === 'retired') this.requestRestore(ws, ref)
        if (state === 'retired' || state === 'retiring' || state === 'restoring') wait(`the run's working copy is ${state}; this waits for its restoration`)
        else drop(`the run's working copy is missing; nothing can be executed there`)
        continue
      }
      // p18: a standing conductor at rest (or finalized with its room closed) has nothing to do; the conversation wakes it.
      if (rec.standing && (rec.execution.state === 'idle' || rec.execution.state === 'completed')) { drop(`the run rests (${rec.execution.state}): nothing is ready; the conversation's next event wakes it`); continue }
      // improve_wfrun p4: ordinary work starts when warden decided it does.
      let admission: Admission = { ok: true, decision: null, how: 'coordination' }
      if (!coordination && cfg.coordination) {
        admission = this.admission(job, worker)
        if (!admission.ok) { wait(admission.why); if (admission.awaiting) awaiting++; continue }
      }
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
        if ((coordination || legacy) && laneHeld().length) return false
        const r = this.run('UPDATE jobs SET state = \'claimed\', claimed = ?, attempt = ? WHERE id = ? AND state = \'queued\'', now(), id, job.id)
        if (Number(r.changes) !== 1) return false
        this.run('INSERT INTO attempts (id, job, workspace, workflow, run, host, state, began, backend, worker, claim, lane, decision) VALUES (?, ?, ?, ?, ?, ?, \'launching\', ?, ?, ?, ?, ?, ?)', id, job.id, job.workspace, job.workflow, job.run, label, now(), execution.backend, worker, o.receipt ?? null, jobLane === DEFAULT_LANE ? null : jobLane, admission.ok ? admission.decision : null)
        if (admission.ok && admission.decision) this.run('UPDATE decisions SET attempt = coalesce(attempt, ?) WHERE id = ?', id, admission.decision)
        // The turn is named by the job's receipt: the executor can claim the job
        // before ensureCoordination has written the job and run on the turn (p4, turn 14).
        const turn = coordination ? turnOfReceipt(job.receipt) : null
        if (turn) this.run('UPDATE coordination_batches SET attempt = ?, job = ?, run = ?, state = \'open\' WHERE id = ? AND state IN (\'creating\', \'open\')', id, job.id, job.run, turn)
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
        // A retirement took the run between the look above and the record's lock: the job waits for it.
        if (((e as RequestError).detail as { code?: string } | undefined)?.code === 'run-retired') this.run('UPDATE jobs SET state = \'queued\', claimed = NULL, attempt = NULL, note = ? WHERE id = ?', (e as Error).message, job.id)
        else this.run('UPDATE jobs SET state = \'dropped\', note = ? WHERE id = ?', `attempt refused: ${(e as Error).message}`, job.id)
        continue
      }
      this.run('UPDATE attempts SET baseline = ?, log = ? WHERE id = ?', JSON.stringify(base), join(this.logsDir, `${id}.jsonl`), id)
      const view: WorkerView | null = remote ? { worker, root: workerTree(o.facts?.root ?? '', job.workspace, ref), facts: o.facts ?? {} } : null
      const continuation = execution.session?.mode === 'resume' && !execution.session.reconstruct ? await this.continuation(space, ref, job, view) : null
      const answer = { job: this.one<JobRow>('SELECT * FROM jobs WHERE id = ?', job.id)!, attempt: this.attemptRow(id)!, workspace: ws.reg, cwd: space.root, ref, brief: await this.brief(space, ref, job, view), continuation, execution, worker, lane, ...(remote ? { copy: await this.dispatchCopy(ws, ref) } : {}) }
      if (remote) this.run('UPDATE attempts SET response = ? WHERE id = ?', JSON.stringify({ ...answer, attempt: { ...answer.attempt, response: null } }), id)
      return answer
    }
    // Something awaits a decision: the coordination path is woken (once; a
    // batch already open or being created is left to itself).
    if (awaiting && !coordination) await this.ensureCoordination().catch(() => null)
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
    lines.push(...standingBrief(r))
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
    lines.push(...workflowTalkBrief(r))
    lines.push(...pendingAnswerLines(r))
    lines.push(...instructionBrief(r))
    lines.push(...this.coordinationBrief(ws.reg.id, ref, job))
    lines.push(...presentationBrief(r))
    lines.push(...await shareBrief(ws, ref, r, job.kind === 'start' ? null : { by: this.executor }, view))
    lines.push(...delegationBrief(r, await this.assessedLines(r)))
    lines.push(...definitionMeaningBrief(r))
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
    const lines = [`Run: ${r.project} / ${runKey(ref)} (record ${runDir(ref)}/run.json).`, `Why this attempt: ${job.reason}`, ...standingBrief(r)]
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
    lines.push(...workflowTalkBrief(r))
    lines.push(...pendingAnswerLines(r), ...instructionBrief(r), ...this.coordinationBrief(ws.reg.id, ref, job), ...delegationBrief(r, await this.assessedLines(r)))
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
    if (!ws.copyOf || ws.copyOf.treeless || !r.storage) return []
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
    // improve_wfrun p4: the end is an event for warden; a coordination
    // attempt's end closes its turn, and what it left is looked at again.
    const cfg = this.workers()
    if (cfg.coordination) {
      if (isCoordinationRun(cfg, a.workspace, a.workflow)) this.closeBatch(a, outcome, kind)
      else this.event('attempt-ended', { workspace: a.workspace, workflow: a.workflow, run: a.run, attempt, worker: a.worker, detail: `${outcome}: ${kind}${detail ? ` — ${detail}` : ''}` })
    }
    const checkpoint = await this.checkpoint(ws, ref, `after attempt ${attempt}: ${kind}`, attempt, a.baseline)
    // A completed run is integrated (p9). So is an acceptance the attempt
    // recorded from a confirmation, as a person's decision through the
    // service or the CLI is (afterDecision): it need not wait for the run's
    // completion, which may itself wait on a delegation that wants this
    // result on main (workflow_editor p12).
    const accepted = rec.decisions.at(-1)?.decision === 'accepted' && rec.decisions.some(d => d.decision === 'accepted' && d.at >= a.began)
    // p18: a standing conductor at rest publishes what its turn changed, as a completed run does.
    if ((rec.execution.state === 'completed' || rec.execution.state === 'idle' || accepted) && rec.storage) await this.queueIntegration(ws, ref, this.executor).catch(() => null)
    // An answer may have arrived while the attempt was still running.
    let resumeJob: JobRow | null = null
    for (const w of rec.execution.waiting) if ('question' in w.on) resumeJob = resumeJob ?? await this.afterAnswer(ws, ref, w.on.question)
    // A child's fact relayed while the attempt ran (p10) queues the next one.
    if (!resumeJob && Object.values(rec.delegations ?? {}).some(d => isOpenDelegation(d) && pendingEvents(d).length)) resumeJob = await this.afterDelegation(ws, ref)
    // A correction that arrived while the attempt ran (fix6) queues the next one.
    for (const k of openCorrections(rec)) resumeJob = resumeJob ?? await this.afterCorrection(ws, ref, k.id)
    // So do changes requested in a human review meanwhile (p17), and work an
    // approval made ready meanwhile (p17 ex1).
    for (const v of openContinuations(rec)) resumeJob = resumeJob ?? await this.afterReview(ws, ref, v.id)
    for (const v of openReleases(rec)) resumeJob = resumeJob ?? await this.afterRelease(ws, ref, v.id)
    // p18: the conversation's words that arrived while the attempt ran wake
    // a standing conductor that has nothing else to do now.
    if (rec.standing) resumeJob = resumeJob ?? await this.afterStanding(ws, ref)
    if (cfg.coordination) await this.ensureCoordination().catch(() => null)
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
    // A later record of a run without a tree (a rejection, a late review) has
    // nothing to commit now: the durable record holds it, and the next
    // publication after a restoration snapshots it.
    if ((await runSpace(ws, ref)).copyOf?.treeless) {
      const id = Number(this.run('INSERT INTO checkpoints (workspace, workflow, run, kind, attempt, state, created, updated, steps, baseline, mode) VALUES (?, ?, ?, ?, ?, \'nothing\', ?, ?, \'[]\', NULL, \'run-copy\')', ws.reg.id, ref.workflow, ref.run, kind, attempt, now(), now()).lastInsertRowid)
      return this.one<CheckpointRow>('SELECT * FROM checkpoints WHERE id = ?', id)!
    }
    const mode = (await treeSpace(ws, ref)).copyOf ? 'run-copy' : null
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
    const space = cp.mode === 'run-copy' ? await treeSpace(ws, ref) : ws.shared
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
    if (space.copyOf?.treeless) return { refused: `run ${runKey(ref)} has no working copy now; integration waits for its restoration (wfe run restore ${runKey(ref)})`, wait: true }
    const record = (await readRun(space, ref)).record
    if (!record) return { refused: `run ${runKey(ref)} cannot be read` }
    if (record.cancelled || record.control.hold?.kind === 'stopped' || record.control.stop) return { refused: `run ${runKey(ref)} was explicitly stopped or cancelled; resume it before integration` }
    if (!space.copyOf || !record.storage) return { refused: `run ${runKey(ref)} has no working copy of its own; what it published is already on the project's branches` }
    if (record.control.attempt) return { refused: `attempt ${record.control.attempt.id} is executing run ${runKey(ref)}; integration waits until it has ended and its work is saved`, wait: true }
    const owed = this.workerCheckpointOwed(ws.reg.id, ref)
    if (owed) return { refused: `run ${runKey(ref)} waits for its worker to publish checkpoint ${owed.id} (${owed.state}); integration builds on it`, wait: true }
    return { space, record, decision: record.seq }
  }

  // The workflows this integration added or changed, validated at the revision
  // that reached the default branch (improve_wfrun p2). A failure of the check is
  // reported as its own state; it never affects the integration.
  private async integratedDefinitions(ws: Workspace, space: Workspace, project: string, repositories: { path: string; observed: string; result: string; method: string }[]): Promise<DefinitionCheck | null> {
    const { changedDefinitions, checkDefinitions } = await import('./definitionCheck.ts')
    const root = repositories.find(r => r.path === '.')
    const owner = (await space.devdocs().catch(() => null))?.owner === 'devdocs' ? 'devdocs' : '.'
    const step = repositories.find(r => r.path === owner)
    if (!root || !step || step.method === 'already') return null
    try {
      const changed = await changedDefinitions(owner === '.' ? space.root : join(space.root, owner), owner === '.' ? 'devdocs/workflows' : 'workflows', step.observed, step.result)
      if (!changed.some(c => c.status !== 'D')) return null
      if (this.ctx.gitea) await (await import('./access.ts')).invalidate(this.accessContext(), project).catch(() => [])
      return await checkDefinitions(this.ctx.gitea ? this.accessContext() : null, ws.reg, root.result, changed)
    } catch (e) {
      return { revision: root.result, state: 'incomplete', detail: (e as Error).message, findings: [] }
    }
  }

  // ---- working-copy lifecycle (improve_wfrun p2, docs/storage.md) -------------------------

  // What in this store still needs the run's tree.
  storageBlockers(workspace: string, ref: RunRef): string[] {
    const where = [workspace, ref.workflow, ref.run]
    const out: string[] = []
    for (const a of this.all<AttemptRow>('SELECT * FROM attempts WHERE workspace = ? AND workflow = ? AND run = ? AND state != \'ended\'', ...where)) out.push(`attempt ${a.id} is ${a.state}`)
    for (const j of this.all<JobRow>('SELECT * FROM jobs WHERE workspace = ? AND workflow = ? AND run = ? AND state IN (\'queued\', \'claimed\')', ...where)) out.push(`job ${j.id} (${j.kind}) is ${j.state}: a continuation is queued`)
    for (const c of this.all<CheckpointRow>('SELECT * FROM checkpoints WHERE workspace = ? AND workflow = ? AND run = ? AND state NOT IN (\'published\', \'nothing\')', ...where)) out.push(`checkpoint ${c.id} (${c.kind}) is ${c.state}: the run is not fully saved`)
    for (const i of this.all<IntegrationRow>('SELECT * FROM integrations WHERE workspace = ? AND workflow = ? AND run = ? AND state NOT IN (\'integrated\', \'superseded\', \'refused\')', ...where)) out.push(`integration ${i.id} is ${i.state}`)
    return out
  }

  // What a recovery rehearsal shows did not grow (docs/storage.md).
  countsForRehearsal() { return { jobs: this.all<{ n: number }>('SELECT count(*) AS n FROM jobs')[0].n, attempts: this.all<{ n: number }>('SELECT count(*) AS n FROM attempts')[0].n } }

  // The remote workers that may hold a copy of the run: every worker an attempt
  // ran on, and the one the record names.
  remoteHostsOf(workspace: string, ref: RunRef, record: RunRecord): string[] {
    const cfg = this.workers()
    const hosts = new Set(this.all<{ worker: string | null }>('SELECT DISTINCT worker FROM attempts WHERE workspace = ? AND workflow = ? AND run = ?', workspace, ref.workflow, ref.run).map(a => a.worker ?? cfg.default))
    hosts.add(this.nodeOf(record))
    return [...hosts].filter(h => cfg.workers[h] && !isLocalNode(cfg, h)).sort()
  }

  // A task for a worker's own copy; a file per run, picked up on its heartbeat.
  private storageTaskDir(worker: string) { return join(this.ctx.area, '.local', 'exec', 'storage-tasks', worker) }
  async storageTask(worker: string, t: StorageTask): Promise<void> {
    const dir = this.storageTaskDir(worker)
    await mkdir(dir, { recursive: true })
    await atomicWrite(join(dir, `${t.workspace}__${t.workflow}__${t.run}.json`), `${JSON.stringify(t)}\n`)
  }
  async storageTasks(worker: string): Promise<StorageTask[]> {
    const dir = this.storageTaskDir(worker)
    const out: StorageTask[] = []
    for (const f of await readdir(dir).catch(() => [] as string[])) if (f.endsWith('.json')) out.push(JSON.parse(await readFile(join(dir, f), 'utf8')))
    return out
  }
  async storageTaskDone(worker: string, t: Pick<StorageTask, 'workspace' | 'workflow' | 'run'>): Promise<void> {
    await rm(join(this.storageTaskDir(worker), `${t.workspace}__${t.workflow}__${t.run}.json`), { force: true })
  }

  // A job found a retired run: its restoration is started once, outside the
  // claim (it can take minutes), and the job waits. The lifecycle lock makes a
  // second start end at once; a crashed one is started again by the next claim.
  requestRestore(ws: Workspace, ref: RunRef) {
    const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'wfe.ts')
    const p = spawn(process.execPath, [cli, 'run', 'restore', runKey(ref), '--by', this.executor, '--workspace', ws.reg.id], { detached: true, stdio: 'ignore', env: { ...process.env, WFE_REGISTRY: this.ctx.registryFile, WFE_AREA: this.ctx.area } })
    p.on('error', () => null)
    p.unref()
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
        const definitions = await this.integratedDefinitions(ws, space, ok.record.project, repositories)
        try {
          await runOp(space, ref, { op: 'run.integrate', decision: row.decision, repositories, integration: String(row.id), receipt: `integration:${row.id}`, ...(definitions ? { definitions } : {}) }, { by: o.by, via: o.via })
        } catch (e) {
          r = { ...r, state: 'attention' as const, error: `integrated, but the record could not say so: ${(e as Error).message}; retry to record it` }
        }
      }
      this.run('UPDATE integrations SET state = ?, steps = ?, error = ?, updated = ? WHERE id = ?', r.state, JSON.stringify(r.steps), r.error ?? null, now(), row.id)
      if (r.state === 'integrated') await this.checkpoint(ws.shared, ref, 'integrated', null, null).catch(() => null) // the record of it, on the run branch
      // What reached Gitea is read on the next discovery, not after a cache
      // window (improve_wfrun p1): a workflow the run added becomes routable.
      if ((r.state === 'integrated' || r.state === 'partial') && this.ctx.gitea) await (await import('./access.ts')).invalidate(this.accessContext(), ok.record.project).catch(() => [])
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
        let rec = (await readRun(ws, ref)).record
        // Human review rounds whose start or cleanup is owed (p17): WFE's
        // host work, whatever the run's executor or hold. What it changed is
        // read again before anything is scheduled from it (p17 ex1).
        if (rec && Object.values(rec.reviews ?? {}).some(hostOwes)) {
          notes.push(...await this.reviews.reconcileRun(ws, rec).catch(e => [`${w.id} ${s.ref}: reviews: ${(e as Error).message}`]))
          rec = (await readRun(ws, ref)).record
        }
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
        // Work an approval made ready whose continuation was lost (p17 ex1).
        for (const v of openReleases(rec)) {
          const j = await this.afterRelease(ws, ref, v.id)
          if (j && !jobs.some(x => x.id === j.id)) notes.push(`${w.id} ${s.ref}: resume after the approval of review ${v.id} queued`)
        }
        // A standing conductor's words whose wake or job was lost (p18).
        if (rec.standing) {
          const j = await this.afterStanding(ws, ref)
          if (j && !jobs.some(x => x.id === j.id)) notes.push(`${w.id} ${s.ref}: standing conductor continued (${j.reason})`)
        }
        // An instruction for a run nobody executes, whose continuation was
        // lost (project_migration p8 ex1): queued again under its receipt.
        for (const ins of rec.standing ? [] : Object.values(rec.instructions ?? {})) {
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
    // Coordination (improve_wfrun p4): deferrals whose time came, workers
    // fallen silent, a coordination turn whose run is gone, and anything
    // awaiting a decision with no turn open.
    notes.push(...await this.reconcileCoordination().catch(e => [`coordination: ${(e as Error).message}`]))
    return notes
  }


  // ---- coordination (improve_wfrun p4, docs/coordination.md) ------------------------------

  // The latest standing decision about a run (a `start` or `defer` of scope
  // `run`, applied, on this worker), or null.
  private standing(workspace: string, ref: RunRef, worker: string): DecisionRow | null {
    const d = this.one<DecisionRow>('SELECT * FROM decisions WHERE workspace = ? AND workflow = ? AND run = ? AND action IN (\'start\', \'defer\') AND state = \'applied\' ORDER BY id DESC LIMIT 1', workspace, ref.workflow, ref.run)
    if (!d || d.scope !== 'run') return null
    return d.worker === null || d.worker === worker ? d : null
  }
  // Applies a run's standing decision to a job that has none yet; returns
  // what it did, or null when the job keeps awaiting a decision.
  private standingAdmission(job: JobRow, worker: string): { ok: boolean; decision: number } | null {
    if (job.decision) return null
    const d = this.standing(job.workspace, { workflow: job.workflow, run: job.run }, worker)
    if (!d) return null
    const rc = d.reconsider ? JSON.parse(d.reconsider) as Reconsider : {}
    this.run('UPDATE jobs SET decision = ?, decision_id = ?, defer_until = ? WHERE id = ? AND state = \'queued\' AND decision IS NULL', d.action, d.id, d.action === 'defer' ? rc.until ?? null : null, job.id)
    job.decision = d.action as 'start' | 'defer'; job.decision_id = d.id
    return { ok: d.action === 'start', decision: d.id }
  }
  // Whether a queued ordinary job may be claimed by this worker now (p4).
  admission(job: JobRow, worker: string): Admission {
    if (!job.decision) this.standingAdmission(job, worker)
    const d = job.decision_id ? this.one<DecisionRow>('SELECT * FROM decisions WHERE id = ?', job.decision_id) ?? null : null
    if (job.decision === 'start') {
      if (d && d.worker && d.worker !== worker) return { ok: false, why: `decided to start on ${d.worker} (decision ${d.id}), but the run is assigned to ${worker}; awaiting warden's decision`, awaiting: true, decision: d.id }
      return { ok: true, decision: job.decision_id, how: d?.scope === 'run' && d.job !== job.id ? 'standing' : 'decision' }
    }
    if (job.decision === 'defer') {
      const rc = d?.reconsider ? JSON.parse(d.reconsider) as Reconsider : {}
      const when = [rc.until ? `at ${rc.until}` : '', rc.on?.length ? `on ${rc.on.join(', ')}` : ''].filter(Boolean).join(' or ')
      return { ok: false, why: `deferred by ${d?.by ?? 'warden'} (decision ${d?.id ?? job.decision_id}): ${d?.reason ?? ''}${when ? `; reconsidered ${when}` : '; reconsidered at warden\'s next look'}`, awaiting: false, decision: d?.id ?? null }
    }
    return { ok: false, why: 'awaiting warden\'s coordination decision', awaiting: true, decision: null }
  }

  // Appends one event for warden (p4). Nothing is woken here: the claim,
  // the end of an attempt and the reconcile call ensureCoordination.
  event(kind: CoordinationEventKind, e: { workspace?: string | null; workflow?: string | null; run?: string | null; job?: number | null; attempt?: string | null; worker?: string | null; detail?: string | null }): number {
    return Number(this.run('INSERT INTO coordination_events (at, kind, workspace, workflow, run, job, attempt, worker, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', now(), kind, e.workspace ?? null, e.workflow ?? null, e.run ?? null, e.job ?? null, e.attempt ?? null, e.worker ?? null, e.detail ?? null).lastInsertRowid)
  }
  // Events not yet taken by a coordination attempt, oldest first.
  pendingEvents(): CoordinationEventRow[] { return this.all<CoordinationEventRow>('SELECT * FROM coordination_events WHERE taken_by IS NULL ORDER BY id') }
  recentEvents(n = 30): CoordinationEventRow[] { return this.all<CoordinationEventRow>('SELECT * FROM coordination_events ORDER BY id DESC LIMIT ?', n).reverse() }
  // A coordination attempt takes the pending events: they are its to consider.
  takeEvents(attempt: string, worker?: string): CoordinationEventRow[] {
    const a = this.fence(attempt, worker)
    if (a.state === 'ended') throw new RequestError(409, `attempt ${attempt} has ended`, { code: 'attempt-stale' })
    return this.tx(() => {
      const events = this.pendingEvents()
      if (events.length) this.run('UPDATE coordination_events SET taken_by = ?, taken_at = ? WHERE taken_by IS NULL AND id <= ?', attempt, now(), events.at(-1)!.id)
      return events
    })
  }

  // Whether something waits for warden's look (p4): a job with no decision,
  // a deferral whose time came or whose named event happened, or an explicit
  // request to reconsider. Informational events alone wake nothing.
  needsCoordination(): { yes: boolean; why: string[] } {
    const cfg = this.workers()
    if (!cfg.coordination) return { yes: false, why: [] }
    const why: string[] = []
    const queued = this.all<JobRow>('SELECT * FROM jobs WHERE state = \'queued\' ORDER BY id').filter(j => !isCoordinationRun(cfg, j.workspace, j.workflow))
    const awaiting = queued.filter(j => !j.decision)
    if (awaiting.length) why.push(`${awaiting.length} queued job${awaiting.length === 1 ? '' : 's'} awaiting a decision (${awaiting.slice(0, 5).map(j => `${j.workspace} ${j.workflow}/${j.run}`).join(', ')}${awaiting.length > 5 ? ', …' : ''})`)
    const t = now()
    const pending = this.pendingEvents()
    for (const j of queued.filter(j => j.decision === 'defer')) {
      const d = j.decision_id ? this.one<DecisionRow>('SELECT * FROM decisions WHERE id = ?', j.decision_id) : null
      const rc = d?.reconsider ? JSON.parse(d.reconsider) as Reconsider : {}
      if (rc.until && rc.until <= t) why.push(`deferral of ${j.workspace} ${j.workflow}/${j.run} is due since ${rc.until}`)
      else if (rc.on?.length && pending.some(e => rc.on!.includes(e.kind) && e.at > (d?.at ?? ''))) why.push(`deferral of ${j.workspace} ${j.workflow}/${j.run} named ${rc.on.join(', ')}, which happened`)
    }
    const asked = pending.filter(e => e.kind === 'reconsider')
    if (asked.length) why.push(`${asked.length} reconsideration request${asked.length === 1 ? '' : 's'} (${asked.slice(0, 3).map(e => e.detail ?? '').join('; ')})`)
    return { yes: why.length > 0, why }
  }

  // The coordination turn that is open now, if any (p4): its run's job is
  // queued or claimed, or its attempt is open.
  openBatch(): CoordinationBatchRow | null {
    const b = this.one<CoordinationBatchRow>('SELECT * FROM coordination_batches WHERE state IN (\'creating\', \'open\') ORDER BY id DESC LIMIT 1')
    if (!b) return null
    if (b.state === 'creating') return Date.now() - Date.parse(b.created) < 10 * 60_000 ? b : this.closeBatchRow(b, 'lost', 'the coordination run was never created (creation did not finish)')
    const job = b.job ? this.one<JobRow>('SELECT * FROM jobs WHERE id = ?', b.job) : null
    const open = b.run ? this.one<AttemptRow>('SELECT * FROM attempts WHERE workspace = ? AND workflow = ? AND run = ? AND state != \'ended\'', b.workspace!, b.workflow!, b.run!) : null
    if ((job && (job.state === 'queued' || job.state === 'claimed')) || open) return b
    return this.closeBatchRow(b, 'lost', job ? `its job ${job.id} is ${job.state}${job.note ? ` (${job.note})` : ''} and no attempt is open` : 'its run has no job and no open attempt')
  }
  private closeBatchRow(b: CoordinationBatchRow, state: 'ended' | 'failed' | 'lost', outcome: string): null {
    const n = b.attempt ? this.one<{ n: number }>('SELECT count(*) AS n FROM decisions WHERE attempt IS NOT NULL AND agent LIKE ? AND state = \'applied\'', `%"attempt":"${b.attempt}"%`)?.n ?? 0 : 0
    this.run('UPDATE coordination_batches SET state = ?, ended = ?, outcome = ?, decisions = ? WHERE id = ? AND state IN (\'creating\', \'open\')', state, now(), outcome, n, b.id)
    return null
  }
  // The end of a coordination attempt closes its turn (p4): events created
  // before it began were its to see, and are taken by it now.
  private closeBatch(a: AttemptRow, outcome: string, kind: string) {
    const b = this.one<CoordinationBatchRow>('SELECT * FROM coordination_batches WHERE attempt = ? AND state IN (\'creating\', \'open\')', a.id)
      ?? this.one<CoordinationBatchRow>('SELECT * FROM coordination_batches WHERE workspace = ? AND workflow = ? AND run = ? AND state IN (\'creating\', \'open\')', a.workspace, a.workflow, a.run)
    this.run('UPDATE coordination_events SET taken_by = ?, taken_at = ? WHERE taken_by IS NULL AND at <= ?', a.id, now(), a.began)
    const decided = this.one<{ n: number }>('SELECT count(*) AS n FROM decisions WHERE agent LIKE ? AND state = \'applied\'', `%"attempt":"${a.id}"%`)?.n ?? 0
    if (b) this.run('UPDATE coordination_batches SET state = \'ended\', ended = ?, outcome = ?, decisions = ?, attempt = coalesce(attempt, ?) WHERE id = ?', now(), `${outcome}: ${kind}; ${decided} decision${decided === 1 ? '' : 's'} applied`, decided, a.id, b.id)
  }
  // When coordination turns keep ending without a decision while something
  // awaits one, the next turn waits (p4): three such turns in a row pause
  // automatic creation for ten minutes; the state stays visible, and
  // `wfe coordinate wake` (or the next event after the pause) tries again.
  coordinationStall(): { since: string; failures: number; until: string; last: string } | null {
    const last = this.all<CoordinationBatchRow>('SELECT * FROM coordination_batches WHERE state IN (\'ended\', \'failed\', \'lost\') ORDER BY id DESC LIMIT 3')
    if (last.length < 3 || last.some(b => b.decisions > 0 || b.outcome?.startsWith('exited'))) return null
    const until = new Date(Date.parse(last[0].ended ?? last[0].created) + 10 * 60_000).toISOString()
    if (until <= now()) return null
    return { since: last[2].created, failures: last.length, until, last: `${last[0].state}: ${last[0].outcome ?? last[0].error ?? ''}` }
  }

  // Opens a coordination turn when something awaits a decision and none is
  // open (p4): one coordination run, created from the configured project's
  // published workflow and queued in the coordination lane. Idempotent: a
  // turn already open is answered; a stall pauses creation.
  async ensureCoordination(o: { force?: boolean } = {}): Promise<CoordinationBatchRow | null> {
    const cfg = this.workers()
    const c = cfg.coordination
    if (!c) return null
    // Checked and reserved together: the claim, an end and the reconcile may
    // ask at once from different processes, and one turn opens.
    const need = this.needsCoordination()
    const reserved = this.tx(() => {
      const open = this.openBatch()
      if (open) return open
      if (!need.yes && !o.force) return null
      if (!o.force && this.coordinationStall()) return null
      return Number(this.run('INSERT INTO coordination_batches (created, state, workspace, workflow) VALUES (?, \'creating\', ?, ?)', now(), c.workspace, c.workflow).lastInsertRowid)
    })
    if (reserved === null || typeof reserved !== 'number') return reserved
    const id = reserved
    const text = [`Coordination turn ${id}.`, '', ...(need.why.length ? need.why.map(w => `- ${w}`) : ['- requested explicitly']), '',
      'Look at the queue and the workers (wfe coordinate view), take the pending events (wfe coordinate events --take), decide what starts, moves or waits, apply it (wfe coordinate start|defer|assign|note), and end. wfe coordinate --help explains the operations.'].join('\n')
    try {
      const r = await this.request({ workspace: c.workspace, workflow: c.workflow, text, author: 'WFE', receipt: `coordinate:turn-${id}`, via: 'coordination', node: c.worker,
        input: { kind: 'request', text, requester: 'WFE', entrustedBy: { kind: 'note', text: `coordination turn ${id}: ${need.why.join('; ') || 'requested explicitly'}` } } })
      // The claim may already have linked it, or the turn may even have ended.
      this.run('UPDATE coordination_batches SET state = CASE WHEN state = \'creating\' THEN \'open\' ELSE state END, run = ?, job = ? WHERE id = ?', r.ref.run, r.job.id, id)
      return this.one<CoordinationBatchRow>('SELECT * FROM coordination_batches WHERE id = ?', id)!
    } catch (e) {
      this.run('UPDATE coordination_batches SET state = \'failed\', ended = ?, error = ? WHERE id = ?', now(), (e as Error).message, id)
      return null
    }
  }

  // The reconcile's part (p4): wake events for deferrals whose time came,
  // workers fallen silent, lost turns, and a turn for whatever awaits one.
  async reconcileCoordination(): Promise<string[]> {
    const cfg = this.workers()
    if (!cfg.coordination) return []
    const notes: string[] = []
    const t = now()
    for (const d of this.all<DecisionRow>('SELECT * FROM decisions WHERE action = \'defer\' AND state = \'applied\' AND woken IS NULL AND reconsider IS NOT NULL')) {
      const rc = JSON.parse(d.reconsider!) as Reconsider
      if (!rc.until || rc.until > t) continue
      const job = this.one<JobRow>('SELECT * FROM jobs WHERE workspace = ? AND workflow = ? AND run = ? AND state = \'queued\'', d.workspace, d.workflow, d.run)
      this.run('UPDATE decisions SET woken = ? WHERE id = ?', t, d.id)
      if (!job) continue
      this.event('wake', { workspace: d.workspace, workflow: d.workflow, run: d.run, job: job.id, worker: job.worker, detail: `deferral ${d.id} (${d.reason}) reached ${rc.until}` })
      notes.push(`coordination: deferral ${d.id} of ${d.workspace} ${d.workflow}/${d.run} is due`)
    }
    for (const hb of this.all<{ name: string; at: string; seen_state: string | null }>('SELECT name, at, seen_state FROM heartbeat')) {
      if (!cfg.workers[hb.name] || hb.seen_state !== 'available' || Date.now() - Date.parse(hb.at) < 45_000) continue
      this.run('UPDATE heartbeat SET seen_state = \'unavailable\' WHERE name = ?', hb.name)
      this.event('worker-unavailable', { worker: hb.name, detail: `${hb.name} has not reported since ${hb.at}` })
      notes.push(`coordination: worker ${hb.name} has not reported since ${hb.at}`)
    }
    const before = this.openBatch()
    const b = await this.ensureCoordination()
    if (b && !before) notes.push(`coordination: turn ${b.id} opened (${b.workflow}/${b.run})`)
    const stall = this.coordinationStall()
    if (stall && this.needsCoordination().yes) notes.push(`coordination: ${stall.failures} turns ended without a decision; the next automatic turn waits until ${stall.until} (wfe coordinate wake starts one now)`)
    return notes
  }

  // A decision of warden's about a run's queued work (p4). Who decides is
  // the coordination run's agent (inside its attempt) or --by. The job and
  // the record are read now; a basis the caller names that no longer holds
  // makes the decision stale: nothing is applied and the changed facts are
  // answered. A placement a person chose is not moved.
  async decide(o: { action: DecisionRow['action']; workspace: string; ref: RunRef; worker?: string; scope?: 'run' | 'job'; reason: string; observations?: string[]; assumptions?: string[]; reconsider?: Reconsider; basis?: string; by?: string; attempt?: string; via: string }): Promise<{ decision: DecisionRow; applied: boolean; changed?: { basis: string; facts: Record<string, unknown> }; job: JobRow | null; record: RunRecord | null; notes: string[] }> {
    const cfg = this.workers()
    const ws = await this.workspace(o.workspace)
    const space = await runSpace(ws, o.ref)
    const rec = (await readRun(space, o.ref)).record
    if (!rec) throw new RequestError(409, `run ${runKey(o.ref)} cannot be read`)
    let by = o.by?.trim() || ''
    let agent: RecoveryAgent | undefined
    if (o.attempt) {
      const own = this.attemptRow(o.attempt)
      if (!own || own.state === 'ended') throw new RequestError(409, `attempt ${o.attempt} is not an open attempt on this host; a decision is recorded by the coordination run's open attempt, or with --by outside one`, { code: 'decision-actor' })
      const ownRec = (await readRun(await this.workspace(own.workspace), { workflow: own.workflow, run: own.run })).record
      if (!ownRec) throw new RequestError(409, `the deciding run ${own.workflow}/${own.run} cannot be read`, { code: 'decision-actor' })
      by = ownRec.executor.name
      agent = { workspace: own.workspace, workflow: own.workflow, run: own.run, attempt: own.id }
    }
    if (!by) throw new RequestError(400, 'who decides? Pass --by <name>, or run it from the coordination run\'s attempt (WFE_ATTEMPT)', { code: 'decision-actor' })
    if (isCoordinationRun(cfg, o.workspace, o.ref.workflow)) throw new RequestError(409, `${runKey(o.ref)} is a coordination run; it is admitted by its own lane, not by a decision`, { code: 'decision-self' })
    const job = this.one<JobRow>('SELECT * FROM jobs WHERE workspace = ? AND workflow = ? AND run = ? AND state = \'queued\'', o.workspace, o.ref.workflow, o.ref.run) ?? null
    const node = this.nodeOf(rec)
    // The basis is the view's: over the run's current node, whatever node the decision names.
    const facts = () => this.basisFacts(o.workspace, o.ref, rec, job, node)
    const notes: string[] = []
    const scope = o.scope ?? (o.action === 'note' || o.action === 'assign' ? 'job' : 'run')
    const insert = (state: DecisionRow['state'], detail: string | null, worker: string | null, batch: number | null) => {
      const id = Number(this.run('INSERT INTO decisions (at, by, action, workspace, workflow, run, job, worker, scope, reason, observations, assumptions, reconsider, basis, state, detail, agent, batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        now(), by, o.action, o.workspace, o.ref.workflow, o.ref.run, job?.id ?? null, worker, scope, o.reason, o.observations?.length ? JSON.stringify(o.observations) : null, o.assumptions?.length ? JSON.stringify(o.assumptions) : null, o.reconsider && (o.reconsider.until || o.reconsider.on?.length) ? JSON.stringify(o.reconsider) : null, o.basis ?? null, state, detail, agent ? JSON.stringify(agent) : null, batch).lastInsertRowid)
      return this.one<DecisionRow>('SELECT * FROM decisions WHERE id = ?', id)!
    }
    const batch = agent ? this.one<CoordinationBatchRow>('SELECT * FROM coordination_batches WHERE attempt = ?', agent.attempt)?.id ?? null : null
    const current = facts()
    if (o.basis && o.basis !== current.basis) {
      const d = insert('stale', `the basis ${o.basis} no longer holds (now ${current.basis}): nothing applied`, o.worker ?? null, batch)
      return { decision: d, applied: false, changed: current, job, record: rec, notes }
    }
    if (o.action === 'note') {
      const d = insert('applied', null, null, batch)
      return { decision: d, applied: true, job, record: rec, notes: ['The note reaches the run\'s agent in its next brief (and wfe coordinate notes shows it now).'] }
    }
    // Where the run runs (p4): a move is a run.assign between attempts,
    // recorded as warden's; a placement a person chose, or anyone's explicit
    // assignment, is a constraint this does not override.
    let worker = o.worker ?? node
    let record = rec
    if ((o.action === 'assign' || o.action === 'start') && o.worker && o.worker !== node) {
      if (!cfg.workers[o.worker]) throw new RequestError(400, `execution node "${o.worker}" is not a worker of this area (${Object.keys(cfg.workers).sort().join(', ')})`, { code: 'node-unknown' })
      const constraint = this.placementConstraint(rec)
      if (constraint) { const d = insert('refused', `not moved: ${constraint}`, o.worker, batch); throw new RequestError(409, `run ${runKey(o.ref)} stays on ${node}: ${constraint} (decision ${d.id} recorded as refused)`, { code: 'placement-constraint', decision: d.id }) }
      if (rec.control.attempt) { const d = insert('refused', `not moved: attempt ${rec.control.attempt.id} is open`, o.worker, batch); throw new RequestError(409, `run ${runKey(o.ref)} is executing (attempt ${rec.control.attempt.id}); it moves between attempts (decision ${d.id} recorded as refused)`, { code: 'attempt-open', decision: d.id }) }
      try {
        record = (await runOp(space, o.ref, { op: 'run.assign', node: o.worker, reason: `coordination: ${o.reason}` } as never, { by, via: 'coordination' })).record
      } catch (e) {
        const d = insert('refused', `not moved: ${(e as Error).message}`, o.worker, batch)
        throw new RequestError(409, `${(e as Error).message} (decision ${d.id} recorded as refused)`, { code: 'assign-refused', decision: d.id })
      }
      this.run('UPDATE jobs SET worker = ?, note = NULL WHERE workspace = ? AND workflow = ? AND run = ? AND state = \'queued\'', o.worker, o.workspace, o.ref.workflow, o.ref.run)
      worker = o.worker
      notes.push(`Moved: from its next attempt ${runKey(o.ref)} runs on ${o.worker} (was ${node}).${this.sessionNote(rec, o.worker)}`)
    }
    if (o.action === 'assign') {
      const d = insert('applied', null, worker, batch)
      return { decision: d, applied: true, job, record, notes }
    }
    // start / defer: the job now, and (scope run) the run's later jobs.
    if (o.action === 'start' && rec.control.attempt) throw new RequestError(409, `run ${runKey(o.ref)} is already executing (attempt ${rec.control.attempt.id})`, { code: 'attempt-open' })
    if (o.action === 'start' && !job && scope === 'job') throw new RequestError(409, `run ${runKey(o.ref)} has no queued job to start; a standing admission for its later jobs is --scope run`, { code: 'no-job' })
    const d = insert('applied', null, worker, batch)
    if (job) {
      this.run('UPDATE jobs SET decision = ?, decision_id = ?, defer_until = ?, note = NULL WHERE id = ? AND state = \'queued\'', o.action as 'start' | 'defer', d.id, o.action === 'defer' ? o.reconsider?.until ?? null : null, job.id)
      // An earlier decision on this job is superseded by this one.
      this.run('UPDATE decisions SET state = \'superseded\' WHERE job = ? AND id != ? AND state = \'applied\' AND action IN (\'start\', \'defer\')', job.id, d.id)
    }
    if (o.action === 'start') notes.push(job ? `Job ${job.id} (${job.kind}) starts on ${worker} when its executor next claims${scope === 'run' ? '; the run\'s later jobs on that worker start without another decision until one says otherwise' : ''}.` : `Standing: the run's later jobs on ${worker} start without another decision until one says otherwise.`)
    else notes.push(`${job ? `Job ${job.id} waits` : 'The run\'s jobs wait'}${o.reconsider?.until ? ` until ${o.reconsider.until}` : ''}${o.reconsider?.on?.length ? ` or until ${o.reconsider.on.join(', ')}` : ''}${!o.reconsider?.until && !o.reconsider?.on?.length ? ' until a later decision' : ''}.`)
    return { decision: d, applied: true, job: job ? this.one<JobRow>('SELECT * FROM jobs WHERE id = ?', job.id)! : null, record, notes }
  }
  // Why a run's placement is not warden's to change (p4): the request named
  // the node, or someone other than coordination assigned it last.
  placementConstraint(rec: RunRecord): string | null {
    const last = rec.assignments?.at(-1)
    if (last) {
      const entry = rec.history.find(h => h.seq === last.seq) as { via?: string } | undefined
      if (entry?.via !== 'coordination') return `${last.by} assigned it to ${last.node} (${last.reason})`
      return null
    }
    if (rec.executor.placed === 'request') return `the request named ${rec.executor.node} as its execution node`
    return null
  }
  private sessionNote(rec: RunRecord, worker: string): string {
    const cur = currentSession(rec)
    return cur ? ` Its retained session ${cur.id ?? ''} is on its former node; ${worker} replaces it through the record at the next attempt.` : ''
  }
  // What a decision is made on (p4): the record's sequence, the job and the
  // worker's open attempts. A load sample is not part of it.
  basisFacts(workspace: string, ref: RunRef, rec: RunRecord, job: JobRow | null, worker: string): { basis: string; facts: Record<string, unknown> } {
    // Coordination attempts are not work on the node: they are left out.
    const cfg = this.workers()
    const open = this.all<AttemptRow>('SELECT id, lane FROM attempts WHERE state != \'ended\' AND worker = ? ORDER BY id', worker).filter(a => !isCoordinationLane(cfg, worker, a.lane ?? DEFAULT_LANE)).map(a => a.id)
    const facts = { run: `${workspace}/${runKey(ref)}`, seq: rec.seq, job: job ? { id: job.id, state: job.state, decision: job.decision } : null, worker, node: this.nodeOf(rec), attemptsOn: open, hold: rec.control.hold?.kind ?? null, openAttempt: rec.control.attempt?.id ?? null }
    const basis = `b${createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 10)}`
    return { basis, facts }
  }
  decisionsOf(workspace: string, ref: RunRef, n = 20): DecisionRow[] { return this.all<DecisionRow>('SELECT * FROM decisions WHERE workspace = ? AND workflow = ? AND run = ? ORDER BY id DESC LIMIT ?', workspace, ref.workflow, ref.run, n).reverse() }
  recentDecisions(n = 20): DecisionRow[] { return this.all<DecisionRow>('SELECT * FROM decisions ORDER BY id DESC LIMIT ?', n).reverse() }
  recentBatches(n = 5): CoordinationBatchRow[] { return this.all<CoordinationBatchRow>('SELECT * FROM coordination_batches ORDER BY id DESC LIMIT ?', n).reverse() }

  // What a run's agent is told of coordination at the start of an attempt
  // (p4): warden's notes to it, and who shares its node now.
  coordinationBrief(workspace: string, ref: RunRef, job: JobRow): string[] {
    const cfg = this.workers()
    if (!cfg.coordination || isCoordinationRun(cfg, workspace, ref.workflow)) return []
    const out: string[] = []
    const notes = this.all<DecisionRow>('SELECT * FROM decisions WHERE workspace = ? AND workflow = ? AND run = ? AND action = \'note\' ORDER BY id DESC LIMIT 5', workspace, ref.workflow, ref.run).reverse()
    const d = job.decision_id ? this.one<DecisionRow>('SELECT * FROM decisions WHERE id = ?', job.decision_id) : null
    const others = this.all<AttemptRow>('SELECT * FROM attempts WHERE state != \'ended\' AND worker = ? AND NOT (workspace = ? AND workflow = ? AND run = ?) ORDER BY began', job.worker ?? cfg.default, workspace, ref.workflow, ref.run).filter(a => !isCoordinationRun(cfg, a.workspace, a.workflow))
    if (!notes.length && !others.length && !d) return []
    out.push('', `Execution coordination (warden decides what runs where; wfe coordinate --help):`)
    if (d) out.push(`- this attempt starts by decision ${d.id} (${d.by}, ${d.at}): ${d.reason}${d.assumptions ? `; assumptions: ${(JSON.parse(d.assumptions) as string[]).join('; ')}` : ''}`)
    if (others.length) out.push(`- sharing this execution node now: ${others.map(a => `${a.workspace} ${a.workflow}/${a.run} (attempt ${a.id}, since ${a.began})`).join('; ')}. Shared host state (/tmp paths, ports, displays, process names) is shared with them; use paths and names of your own.`)
    for (const n of notes) out.push(`- note from ${n.by} (${n.at}): ${n.reason}`)
    out.push(`- if another run's work interferes with yours, or your work becomes much heavier than it looked: wfe coordinate reconsider --reason "<what you see>" (warden looks again; it may move, defer or note).`)
    return out
  }

  // The concise read view warden decides from (p4, docs/coordination.md).
  async coordinationView(): Promise<CoordinationView> {
    const cfg = this.workers()
    const observedAt = now()
    const workers: CoordinationView['workers'] = []
    const runFacts = async (workspace: string, ref: RunRef): Promise<CoordinationRunFacts> => {
      try {
        const ws = await this.workspace(workspace)
        const space = await runSpace(ws, ref)
        const r = (await readRun(space, ref)).record
        if (!r) return { readable: false, project: null, request: null, active: [], ready: [], progress: null, situation: null, hold: null, placed: null, constraint: null, requester: null, created: null, seq: null }
        let request: string | null = null
        try { request = readFileSync(join(space.copyOf?.recordRoot ?? space.root, runDir(ref), r.input.file), 'utf8').replace(/\s+/g, ' ').trim().slice(0, 280) } catch { request = null }
        const p = [...r.history].reverse().find(e => ['node.progress', 'node.start', 'node.complete', 'question.ask', 'node.wait', 'delegation.dispatch'].includes(e.op))
        return { readable: true, project: r.project, request, active: r.execution.active, ready: r.execution.ready, progress: p ? { op: p.op, at: p.at, node: (p as { node?: string }).node ?? null, text: (p as { text?: string; outcome?: string }).text ?? (p as { outcome?: string }).outcome ?? null } : null,
          situation: situation(r), hold: r.control.hold?.kind ?? null, placed: r.executor.placed ?? null, constraint: this.placementConstraint(r), requester: r.input.requester ?? r.input.author ?? null, created: r.created, seq: r.seq }
      } catch (e) { return { readable: false, project: null, request: `(${(e as Error).message})`, active: [], ready: [], progress: null, situation: null, hold: null, placed: null, constraint: null, requester: null, created: null, seq: null } }
    }
    for (const w of this.workersState()) {
      const attempts: CoordinationView['workers'][number]['attempts'] = []
      for (const a of this.all<AttemptRow>('SELECT * FROM attempts WHERE state != \'ended\' AND worker = ? ORDER BY began', w.id)) {
        const f = await runFacts(a.workspace, { workflow: a.workflow, run: a.run })
        const log = a.log && (this.localPid(a) || this.isRemote(a.worker)) ? await activityOf(a.log).catch(() => null) : null
        attempts.push({ attempt: a.id, workspace: a.workspace, workflow: a.workflow, run: a.run, project: f.project, lane: a.lane ?? DEFAULT_LANE, coordination: isCoordinationRun(cfg, a.workspace, a.workflow), state: a.state, began: a.began, stopRequested: a.stop_requested, decision: a.decision, request: f.request, active: f.active, progress: f.progress, logLast: log?.last ?? null, pid: a.pid })
      }
      workers.push({ id: w.id, label: w.label, local: w.local, default: w.default, coordination: w.coordination, state: w.state, heartbeatAt: w.at, ageSeconds: w.ageSeconds === null ? null : Math.round(w.ageSeconds), load: w.load, profiles: w.profiles, host: w.facts?.host ?? null, attempts })
    }
    const queued: CoordinationView['queued'] = []
    for (const j of this.all<JobRow>('SELECT * FROM jobs WHERE state = \'queued\' ORDER BY id')) {
      if (isCoordinationRun(cfg, j.workspace, j.workflow)) continue
      const ref = { workflow: j.workflow, run: j.run }
      const f = await runFacts(j.workspace, ref)
      const worker = j.worker ?? cfg.default
      const d = j.decision_id ? this.one<DecisionRow>('SELECT * FROM decisions WHERE id = ?', j.decision_id) ?? null : null
      const w = workers.find(x => x.id === worker)
      const servable = w?.profiles && j.note?.includes('does not offer') ? false : true
      queued.push({ job: j.id, workspace: j.workspace, workflow: j.workflow, run: j.run, project: f.project, kind: j.kind, reason: j.reason, created: j.created, worker, lane: j.worker ? laneOn(cfg.workers[worker], undefined) : DEFAULT_LANE,
        admission: j.decision === 'start' ? 'admitted' : j.decision === 'defer' ? 'deferred' : 'awaiting', decision: d ? { id: d.id, by: d.by, at: d.at, action: d.action, scope: d.scope, reason: d.reason, reconsider: d.reconsider ? JSON.parse(d.reconsider) as Reconsider : null } : null,
        note: j.note, servable, request: f.request, requester: f.requester, created_run: f.created, ready: f.ready, situation: f.situation, placed: f.placed, constraint: f.constraint, basis: f.seq !== null ? this.basisFacts(j.workspace, ref, { seq: f.seq, control: { hold: f.hold ? { kind: f.hold } : null, attempt: null }, executor: { node: worker } } as never, j, worker).basis : null })
    }
    const stall = this.coordinationStall()
    const open = this.openBatch()
    return { schema: 'ag.wfe-coordination.v1', observedAt, configured: !!cfg.coordination, coordination: cfg.coordination, turn: open ? { id: open.id, state: open.state, run: open.run, attempt: open.attempt, since: open.created } : null,
      stalled: stall, recentTurns: this.recentBatches(5).map(b => ({ id: b.id, state: b.state, run: b.run, created: b.created, ended: b.ended, outcome: b.outcome, decisions: b.decisions, error: b.error })),
      workers, queued, decisions: this.recentDecisions(12).map(d => ({ ...d, observations: d.observations ? JSON.parse(d.observations) as string[] : null, assumptions: d.assumptions ? JSON.parse(d.assumptions) as string[] : null, reconsider: d.reconsider ? JSON.parse(d.reconsider) as Reconsider : null, agent: d.agent ? JSON.parse(d.agent) as RecoveryAgent : null })),
      events: this.pendingEvents(), needs: this.needsCoordination() }
  }

  // ---- views ------------------------------------------------------------------------------

  // One heartbeat per worker (p7), keyed by the worker id. A remote worker
  // sends its offer and facts with it, so the views say what it can do.
  // `offer.facts.load` (improve_wfrun p4): what the executor measured of its
  // host now; kept with the heartbeat as evidence for coordination. A worker
  // heard from again after silence is an event for warden.
  heartbeat(worker: string, pid: number, detail: string, offer?: { offer?: HostOffer; facts?: WorkerFacts }) {
    const cfg = this.workers()
    if (!cfg.workers[worker]) throw new RequestError(404, `worker "${worker}" is not a worker of this area`, { code: 'worker-unknown' })
    this.tx(() => {
      const before = this.one<{ at: string; offer: string | null; seen_state: string | null }>('SELECT at, offer, seen_state FROM heartbeat WHERE name = ?', worker)
      let merged = offer ? JSON.stringify(offer) : null
      // The load alone, from a local executor that offers nothing else here, joins the kept offer.
      if (offer && !offer.offer && before?.offer) { try { const kept = JSON.parse(before.offer) as { offer?: HostOffer; facts?: WorkerFacts }; merged = JSON.stringify({ ...kept, facts: { ...kept.facts, ...offer.facts } }) } catch { /* keep the new one */ } }
      this.run('INSERT INTO heartbeat (name, at, pid, detail, offer, seen_state) VALUES (?, ?, ?, ?, ?, \'available\') ON CONFLICT(name) DO UPDATE SET at = excluded.at, pid = excluded.pid, detail = excluded.detail, offer = coalesce(excluded.offer, heartbeat.offer), seen_state = \'available\'', worker, now(), pid, detail, merged)
      if (cfg.coordination && before?.seen_state !== 'available') this.event('worker-available', { worker, detail: before ? `${worker} reports again (last heard ${before.at})` : `${worker} reports for the first time` })
    })
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
      const awaiting = jobs.filter(j => !j.decision).length, deferred = jobs.filter(j => j.decision === 'defer').length
      const detail = `${w.id}${busy ? `; executing ${busy.workflow}/${busy.run} (${busy.id})` : '; idle'}${extra.map(a => `; ${a.lane ?? DEFAULT_LANE} lane: ${a.workflow}/${a.run} (${a.id})`).join('')}${jobs.length ? `; ${jobs.length} queued${awaiting ? ` (${awaiting} awaiting a decision)` : ''}${deferred ? ` (${deferred} deferred)` : ''}` : ''}`
      return { id: w.id, label: w.label, local: w.local, default: cfg.default === w.id, state, at: hb?.at ?? null, ageSeconds: age, pid: hb?.pid ?? null, reported: hb?.detail ?? null, detail,
        busy: busy ? { attempt: busy.id, workspace: busy.workspace, workflow: busy.workflow, run: busy.run, state: busy.state, stopRequested: busy.stop_requested } : null,
        slots: open.map(a => ({ attempt: a.id, workspace: a.workspace, workflow: a.workflow, run: a.run, state: a.state, stopRequested: a.stop_requested, lane: a.lane ?? DEFAULT_LANE, decision: a.decision })),
        lanes: [...w.lanes], coordination: !!cfg.coordination && cfg.coordination.worker === w.id,
        queued: jobs.map(j => ({ id: j.id, workspace: j.workspace, workflow: j.workflow, run: j.run, kind: j.kind, note: j.note, decision: j.decision, deferUntil: j.defer_until })),
        profiles: offered?.offer?.profiles ? Object.keys(offered.offer.profiles).sort() : null, facts: offered?.facts ?? null, load: offered?.facts?.load ?? null }
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
    // improve_wfrun p4: how this host admits work, and warden's decisions about the run.
    const coordinated = !!this.workers().coordination
    const decisions = coordinated ? this.decisionsOf(workspace, ref, 20).map(d => ({ id: d.id, at: d.at, by: d.by, action: d.action, worker: d.worker, scope: d.scope, reason: d.reason, state: d.state, detail: d.detail, attempt: d.attempt, reconsider: d.reconsider })) : []
    return { attempts, jobs, checkpoints, integrations, executor: this.executorState(), workers: this.workersState(), coordinated, decisions }
  }
}
