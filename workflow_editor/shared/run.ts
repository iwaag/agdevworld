// Workflow runs (ag.workflow-run.v1): the one reducer that turns a run's
// history into its current state, readiness and the execution summary.
// Shared by the service, the CLI and the browser; it touches no files.
// See docs/runs.md for the contract.
import { canonicalJson } from './canonical.ts'
import { contextChanges, changeWords, type AttemptContext, type ContextDelivery } from './context.ts'
import { docStepsOf, type EffectiveGraph, type StepSpec } from './compile.ts'
import type { DocSteps } from './model.ts'
import type { AttemptCatalog, CatalogContext } from './catalog.ts'
import { INSTRUCTION_RESPONSES, sourceLabel, type SourceRef } from './intake.ts'
import {
  CANDIDATE, INPUT_ID, OUTPUT_ID, SET_OBSERVATIONS, STAGINGS, outputNumber, parseRef,
  type ExternalOutput, type InputSet, type SetObservation, type ShareRef, type Staging,
} from './shares.ts'
import { ID_PATTERN, NODE_PATTERN, PROFILE_PATTERN, normalizeRepoPath, type Edge } from './model.ts'
import {
  DELEGATION_ID, DISPOSITIONS, EVENT_TYPES, WAKING, isOpenDelegation, latestResult, pendingEvents, questionEvent,
  type ChildRef, type Delegation, type DelegationEvent, type DelegationTarget, type ResultManifest, type TransportRef,
} from './delegation.ts'

export const RUN_SCHEMA = 'ag.workflow-run.v2'
// "plan, reports, final report" / "no generated documents", for messages.
export const describeSteps = (d: DocSteps) => [d.plan && 'plan talk', d.reports && 'node reports', d.final && 'final report'].filter(Boolean).join(', ') || 'no generated documents'
// Where run folders live in a project (docs/runs.md).
export const RUNS_ROOT = 'devdocs/runs'
export const runFolder = (r: RunRef) => `${RUNS_ROOT}/${r.workflow}/${r.run}`
export const RUN_ID = /^run-[a-z0-9][a-z0-9_.-]{0,59}$/
export const QUESTION_ID = /^q[0-9]{1,6}$/
export const NODE_STATES = ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'] as const
export type NodeState = typeof NODE_STATES[number]
export const EXECUTION_STATES = ['not-started', 'in-progress', 'stopped', 'completed', 'cancelled'] as const
export type ExecutionState = typeof EXECUTION_STATES[number]

export class RunError extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}
const fail = (code: string, message: string): never => { throw new RunError(code, message) }

// ---- record shape -------------------------------------------------------------

// A run is identified by Project, Workflow and Run together. Inside one
// project's records the project is implicit; `run.json` names it.
export interface RunRef { workflow: string; run: string }
export type EntrustRef =
  // `project` (project_migration p8): a run of another project, e.g. the
  // conversational run of Front that wrote the request.
  | { kind: 'run'; workflow: string; run: string; node?: string; project?: string }
  | { kind: 'file'; path: string }
  | { kind: 'note'; text: string }
  // p10 (docs/delegation.md): a child created from a delegation's request.
  | { kind: 'delegation'; delegation: string; parent: { project: string; workflow: string; run: string; creation: string; node: string }; accepts: 'person' | 'parent' }

export interface RunInput {
  kind: 'braindump' | 'request'
  file: 'braindump.md' | 'request.md'
  author?: string // braindump: the person whose words these are
  recordedBy?: string // braindump: who saved them, when not the author
  requester?: string // request: the agent that constructed it
  onBehalfOf?: string
  entrustedBy?: EntrustRef
  original?: string // run-relative file keeping the input a request was derived from
  source?: SourceRef // where the person's words were posted (p6: the Zulip post that became the braindump)
  sha256?: string // of the input file as written at creation (p7/ex1); what a request-sourced adjustment binds to
  // Shared-area references written in the input (project_migration p6,
  // docs/shares.md), in order: what the person pointed at. Whether a host
  // can reach them is observed when they are used, never recorded here.
  references?: ShareRef[]
}
// `name` is the agent identity the run is performed as (p6: the workflow's
// execution.agent); `host` the execution host that launches it, when that is
// not the agent itself (autolab executing for ppt-agent).
// node (project_migration p7): the execution node (worker) that performs the
// run's attempts, chosen at creation (request, workflow, project or area
// default) and changed only by run.assign between attempts. Absent: the
// area's default worker (records made before p7).
// lane (project_migration p8): the worker lane its attempts are claimed in,
// frozen at creation like the node; absent = `default`.
export interface Executor { name: string; backend: string | null; host?: string; node?: string; lane?: string }
export const hostOf = (e: Executor) => e.host ?? e.name
export { NODE_PATTERN }
// Who assigned the run's node, when it was not chosen at creation (p7).
export interface NodeAssignment { node: string; previous: string | null; at: string; by: string; reason: string; seq: number }
// What one attempt was launched with (p6), recorded with attempt.begin so its
// behaviour can be explained later: the agent identity, the host's profile
// and the backend it resolved to, and the guides composed into its
// instructions — the host's common contract and the project's guides — by
// content hash.
// catalog (p7/ex1): the run's node-catalog snapshot this attempt was given.
// session (agent_session p1): the run's session policy and the harness
// conversation this attempt was launched in.
// context (workflow_editor p13, docs/context.md): the scoped context bundle
// it was prepared with — the local snapshot's opaque id, the fingerprint
// and each source's identity and hash, never override text or a host path.
// Attempts before p13 recorded only `guides` (the workflow's guides by hash).
export interface AttemptSettings { agent: string; profile: string | null; backend: string | null; contract: { name: string; sha256: string } | null; guides?: { path: string; sha256: string }[]; context?: AttemptContext; catalog?: AttemptCatalog; session?: AttemptSession }
// How an attempt uses a harness conversation (agent_session p1,
// docs/sessions.md). `mode` new: a session created for this attempt, under
// `id` when the host's harness takes a caller-chosen id (null otherwise:
// the id becomes known only from the harness, attempt.session). `resume`:
// the run's current session, by its id — never "the latest conversation".
// `replaces`: the session this one supersedes and why. `reconstruct`
// (agent_session p1 ex2): why a resumed session is given the whole
// bootstrap again instead of a continuation (it was compacted, or a
// compaction cannot be ruled out).
export interface AttemptSession { policy: 'fresh' | 'run'; mode: 'new' | 'resume'; id: string | null; replaces?: { id: string | null; reason: string }; reconstruct?: string }
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
// One harness conversation of this run. Portable identity only: the id, the
// configuration it was created under (by hash) and the attempts it served;
// transcripts stay on the execution host. `state`: open (the run's current
// session), replaced (a later session superseded it: `reason`) or retired
// (a person or a recovering agent ended it: `reason`; the next attempt
// starts a new one). `attached`: the id the harness itself reported, when
// it reported one; `mismatch` when that differs from the intended id.
export interface SessionRecord {
  id: string | null
  policy: 'fresh' | 'run'
  began: string
  attempt: string // the attempt that created it
  attempts: string[] // every attempt it served, in order
  config: SessionConfig // what it was created under (sessionConfig)
  state: 'open' | 'replaced' | 'retired'
  attached?: string
  attachedIn?: string // the attempt whose harness last reported it
  mismatch?: boolean
  ended?: { at: string; by: string; reason: string }
}
// The configuration a retained session is bound to: what the conversation
// was instructed with and runs as. A later attempt with another
// configuration starts a new session (an old conversation does not learn
// new instructions by itself).
export interface SessionConfig { agent: string; profile: string | null; backend: string | null; contract: { name: string; sha256: string } | null; guides?: { path: string; sha256: string }[]; context?: { fingerprint: string; sources: { key: string; delivery: ContextDelivery; sha256: string | null }[] } }
type ConfigInput = Pick<AttemptSettings, 'agent' | 'profile' | 'backend' | 'contract' | 'guides' | 'context'>
// The context part of a configuration: the effective sources (no run input,
// no common contract — compared by its own hash) by identity and content.
// Metadata-only changes of a source leave it as it was.
const effectiveContext = (c: AttemptContext) => ({ fingerprint: c.fingerprint, sources: c.sources.filter(x => x.scope !== 'run' && x.key !== 'system/contract').map(x => ({ key: x.key, delivery: x.delivery, sha256: x.sha256 ?? null })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) })
export function sessionConfig(st: ConfigInput | SessionConfig): SessionConfig {
  const base = { agent: st.agent, profile: st.profile ?? null, backend: st.backend ?? null, contract: st.contract ? { name: st.contract.name, sha256: st.contract.sha256 } : null }
  const c = st.context
  if (c) return { ...base, context: 'snapshot' in c ? effectiveContext(c as AttemptContext) : c }
  return { ...base, guides: [...(st.guides ?? [])].map(g => ({ path: g.path, sha256: g.sha256 })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) }
}
export const sameConfig = (a: SessionConfig, b: SessionConfig) => canonicalJson(sessionConfig(a)) === canonicalJson(sessionConfig(b))
// What differs between a session's configuration and an attempt's, in words.
export function configChanges(was: SessionConfig | undefined, nowIn: ConfigInput | SessionConfig): string[] {
  if (!was) return ['the configuration it was created under is not recorded']
  const now = sessionConfig(nowIn)
  const out: string[] = []
  if (was.agent !== now.agent) out.push(`agent ${was.agent} → ${now.agent}`)
  if ((was.profile ?? null) !== (now.profile ?? null)) out.push(`profile ${was.profile ?? '(host default)'} → ${now.profile ?? '(host default)'}`)
  if ((was.backend ?? null) !== (now.backend ?? null)) out.push(`backend ${was.backend ?? '(unknown)'} → ${now.backend ?? '(unknown)'}`)
  if ((was.contract?.sha256 ?? null) !== (now.contract?.sha256 ?? null)) out.push(`common contract ${was.contract?.name ?? ''} changed`)
  if (was.context && now.context) out.push(...contextChanges(was.context.sources, now.context.sources).map(c => `context ${changeWords(c)}`))
  else if (!was.context && now.context) out.push('context: the session was created before scoped context (it was given guides only)')
  else {
    const g = (l: { path: string; sha256: string }[]) => new Map(l.map(x => [x.path, x.sha256]))
    const a = g(was.guides ?? []), b = g(now.guides ?? [])
    for (const [path, h] of b) if (!a.has(path)) out.push(`guide ${path} added`); else if (a.get(path) !== h) out.push(`guide ${path} changed`)
    for (const path of a.keys()) if (!b.has(path)) out.push(`guide ${path} removed`)
  }
  return out
}
export const currentSession = (s: Pick<RunState, 'sessions'>): SessionRecord | null => { const l = s.sessions?.at(-1); return l && l.state === 'open' ? l : null }
// The run's current session when it must not be continued automatically
// (agent_session p1 ex1): under `run`, a session whose harness reported
// another id than the one it was launched with. Nothing resumes it; a person
// or a recovering agent looks at the run and what that attempt did, then
// retires it (session.retire), and the next attempt starts a new session.
export function unverifiedSession(s: Pick<RunState, 'sessions'>): SessionRecord | null {
  const cur = currentSession(s)
  return cur && cur.policy === 'run' && cur.mismatch ? cur : null
}
export const unverifiedReason = (cur: SessionRecord, run = '<run>') =>
  `session ${cur.id} is unverified: the harness reported ${cur.attached ?? '(another id)'} instead${cur.attachedIn ? ` in attempt ${cur.attachedIn}` : ''}, so that attempt was stopped. The run does not continue in that conversation: look at the run and what the attempt did, then retire the session (wfe run session ${run} --retire --reason "<what you found>"); the next attempt starts a new session from the records`
export interface BundleEntry {
  file: string // run-relative, definition/<id>.yaml
  source: string // project-relative file it was copied from
  sha256: string // of the copied bytes
  definitionDigest: string
  approvals: { intent: string; definition: string }
}
// `effective` (p5): the graph the run follows, compiled from the root
// workflow and its documentation policy at creation and frozen here. A run
// created before p5 has none and follows its authored graph.
// `revisions` and `active` (p7, docs/adjustments.md): adjustments of the
// run's future work, each a complete authored definition (by file and hash)
// and its complete compiled graph; `effective` stays the original (r1).
export interface DefinitionRef { root: string; workflows: Record<string, BundleEntry>; warnings: string[]; effective?: EffectiveGraph; active?: string; revisions?: Revision[] }
export const REVISION_ID = /^r[0-9]{1,4}$/
export type AdjustSource =
  | { kind: 'answer'; question: string; answer?: number } // the person asked for it in an answer that was taken up
  | { kind: 'instruction'; instruction: string } // an acknowledged additional instruction asked for it
  | { kind: 'agreement'; question: string } // the person agreed to this exact proposal (the question's document)
  | { kind: 'agent' } // an agent-selected revision, recorded with its actual actor
  | { kind: 'person'; by?: string } // a person applies it themselves
  | { kind: 'request'; input: string; sha256: string } // the run's original braindump or entrusted request asks for this work (p7/ex1); by file and hash
export interface AdjustDiff { added: string[]; removed: string[]; changed: string[]; edgesAdded: [string, string][]; edgesRemoved: [string, string][] }
export interface Revision {
  revision: string // r2, r3, …
  parent: string // the revision it was made from (r1 = the original)
  file: string // run-relative: definition/<revision>/<workflow>.yaml
  sha256: string // of the file's bytes
  definitionDigest: string // the definition-approval projection of that file
  effective: EffectiveGraph // the whole compiled graph, frozen
  reason: string
  source: AdjustSource
  diff: AdjustDiff
  at: string
  by: string
}
// The revision in force and its graph: the latest adjustment, or the
// original snapshot.
export const activeRevision = (d: Pick<DefinitionRef, 'active' | 'revisions'>): string => d.active ?? 'r1'
export const effectiveOf = (r: { definition: DefinitionRef }): EffectiveGraph | undefined => r.definition.revisions?.at(-1)?.effective ?? r.definition.effective
// Every node any revision of the run had, for reading history entries
// (a node id means the same thing in every revision that has it).
export function anyRevisionNode(r: { definition: DefinitionRef }, id: string): EffectiveGraph['nodes'][string] | undefined {
  for (const rev of [...(r.definition.revisions ?? [])].reverse()) if (rev.effective.nodes[id]) return rev.effective.nodes[id]
  return r.definition.effective?.nodes[id]
}
export interface RepoContext { path: string; head: string | null; branch: string | null; dirty: number | null }

export type WaitOn = { question: string } | { external: string } | { delegation: string }
// `deadline` (observer p3): when the awaited result is expected at the latest,
// as the waiter declared it; a monitor treats a wait past it as uncertain. A
// statement, not a timer: nothing changes state because of it.
export interface Wait { reason: string; holder: string; on: WaitOn; deadline?: string }
export interface Note { at: string; by: string; text: string }
// A document a step was checked to have written (p5): project-relative path,
// content hash and size at the moment of the check. File presence, not a
// claim that the prose is right.
export interface DocumentEvidence { path: string; sha256: string; bytes: number }
export interface NodeRecord {
  state: NodeState
  updated: string | null
  started: string | null
  ended: string | null
  wait: Wait | null
  outcome: { text: string; artifacts: string[] } | null
  failure: { reason: string; at: string; by: string } | null
  cancellation: { reason: string; at: string; by: string } | null
  notes: Note[]
  document?: DocumentEvidence // a documentation step's checked document (p5)
  agreement?: { question: string } // the plan step: the question whose taken-up answer agreed to that document
}
// `from` gave the answer; `by` recorded it (the same unless someone relays it).
// `delegation` (p10): the answer came from the parent's agent of a delegated
// request — which delegation and which of its answers.
export interface Answer { text: string; from: string; by: string; at: string; via: string; source?: SourceRef; delegation?: { uid: string; answer: number } }
// An additional instruction (p6): the person's further input to a run that
// is not an answer. Receiving it changes no node; the executing attempt
// acknowledges it at a node boundary with what it will do.
export interface Instruction {
  id: string
  text: string
  from: string // the person whose words these are
  by: string // who recorded them
  at: string
  via: string
  source?: SourceRef
  during: string[] // nodes recorded as running when it arrived
  ack: { by: string; at: string; attempt: string | null; response: string; note: string } | null
}
export const INSTRUCTION_ID = /^i[0-9]{1,6}$/
export interface Question {
  id: string
  node: string | null
  text: string
  to: string
  askedBy: string
  asked: string
  answers: Answer[]
  takenUp: { by: string; at: string; answer: number } | null
  withdrawn: { by: string; at: string; reason: string } | null
  document?: DocumentEvidence // asked from the plan step: the plan.md it asked about (p5)
  subject?: DocumentEvidence[] // asked from the result-confirmation node: the deliverables it presents (p6)
  presentation?: { id: string; revision: string } // the presentation it asks about (p7); subject = its files
  output?: { id: string; digest: string } // the external output it asks about (project_migration p6); its manifest is in the subject
}
export interface Artifact { path: string; node: string | null; title: string; by: string; at: string }
// A presentation (p7, docs/presentations.md): one frozen revision of the
// run's result, copied into the run folder by the file layer, served on this
// host for a person's review. The record names its files by hash, the
// revision (the manifest digest) and the lifecycle facts this host
// observed; where it is served (port, process) is host state, referenced
// here only by the instance id.
export const PRESENTATION_ID = /^p[0-9]{1,6}$/
export const PRESENTATION_STATES = ['registered', 'available', 'stopped', 'failed', 'stop-failed'] as const
export type PresentationState = typeof PRESENTATION_STATES[number]
export const OBSERVATIONS = ['available', 'stopped', 'failed', 'stop-failed'] as const
export type Observation = typeof OBSERVATIONS[number]
export interface PresentationManifest {
  revision: string // sha256:<hex> of the canonical manifest
  entry: string // folder-relative: content/<path>
  review: string // folder-relative: review.md
  files: DocumentEvidence[] // project-relative paths inside the presentation folder
}
export interface Presentation extends PresentationManifest {
  id: string
  node: string // the node that registered it
  title: string
  folder: string // project-relative: devdocs/runs/<wf>/<run>/presentations/<p>
  registered: { at: string; by: string; attempt: string | null }
  state: PresentationState
  instance: string | null // the serving instance last observed (a logical reference)
  last: { at: string; by: string; status: Observation; detail: string } | null
}
// Open: something may still be serving it.
export const isOpen = (p: Pick<Presentation, 'state'>) => p.state === 'available' || p.state === 'stop-failed'
export const openPresentations = (s: Pick<RunState, 'presentations'>): Presentation[] => Object.values(s.presentations ?? {}).filter(isOpen)
export const presentationFolder = (r: RunRef, id: string) => `${runFolder(r)}/presentations/${id}`
const presentationNumber = (id: string) => Number(id.slice(1))
// The exact revision an acceptance is of (p9): the tree of each repository
// the run owns, as its copy held it when the decision was recorded.
export interface RevisionEntry { path: string; tree: string }
// A completed integration of an accepted result (p9, docs/integration.md):
// per repository, the shared target, the target commit it found, the run
// branch commit it integrated, how and the resulting commit.
export interface IntegrationRecord {
  decision: number // index into decisions
  at: string; by: string
  repositories: { path: string; target: string; observed: string; candidate: string; method: 'already' | 'fast-forward' | 'merge'; result: string }[]
}
export interface Decision {
  decision: 'accepted' | 'rejected'; by: string; at: string; evidence: string; note: string
  revision?: RevisionEntry[] // p9: what an acceptance binds to (recorded by the file layer)
  // A decision the person gave by answering the result-confirmation
  // question (p6): which question and answer, whose words, and the
  // deliverables (by hash) it confirmed.
  confirmation?: { question: string; answer: number; from: string; source?: SourceRef; subject: DocumentEvidence[]; presentation?: { id: string; revision: string }; output?: { id: string; digest: string } }
}
export interface Execution {
  state: ExecutionState
  counts: Record<NodeState, number>
  ready: string[]
  blocked: string[]
  active: string[]
  waiting: { node: string; holder: string; on: WaitOn }[]
  failed: string[]
}

// Execution control (p4): which launch of the executor is current, how the
// last one ended, and whether the work is held until a person resumes it.
// `running` on a node says work started; whether a process is alive is a
// fact of the execution host, not of this record.
export const ATTEMPT_OUTCOMES = ['exited', 'stopped', 'interrupted', 'unknown'] as const
export type AttemptOutcome = typeof ATTEMPT_OUTCOMES[number]
export type HoldKind = 'stopped' | 'interrupted' | 'unknown'
// Why an attempt's end held the run (project_migration p8 ex1), recorded on
// holds derived from entries that ask for it (`attempt.end` `explain:
// cause`); the hold's reason keeps the full sentence. `left-running` and
// `left-ready`: work the attempt left; `nothing-recorded`: it ended with no
// work ever recorded (agops recover/run-013…025 ran, recovered their target
// and recorded nothing of their own); `missed-event`: a child's fact it was
// launched for and did not take up; `process`: the executor saw the process
// fail (`detail`); `lost`: the process was gone and its outcome is unknown.
export type HoldCause =
  | { code: 'left-running' | 'left-ready' | 'nothing-recorded'; nodes: string[] }
  | { code: 'missed-event'; events: { delegation: string; n: number; type: string }[] }
  | { code: 'process'; detail: string }
  | { code: 'lost' }
// The person's words a recorder acted on (p9): when an agent stops, resumes
// or cancels a run because of an answer or an instruction, it records the
// operation as itself and names them here.
export type Because = { kind: 'answer'; question: string; answer: number; from: string } | { kind: 'instruction'; instruction: string; from: string }
export interface Control {
  attempt: { id: string; reason: string; began: string; backend: string | null; settings?: AttemptSettings } | null // the open attempt; backend: what served it (Agent ≠ Model)
  attempts: number
  last: { id: string; outcome: AttemptOutcome; ended: string; detail: string; backend: string | null } | null
  hold: { kind: HoldKind; since: string; by: string; reason: string; because?: Because; cause?: HoldCause } | null // nothing resumes it but run.resume
  stop: { at: string; by: string; reason: string; because?: Because } | null // stop requested; not yet confirmed by the attempt's end
  // The execution profile a person chose when resuming (project_migration
  // p6 ex2): later attempts resolve it instead of the definition's. Which
  // model serves the run is the person's choice; who performs it (the
  // agent) and what it may touch stay the definition's. Absent: the
  // definition's profile. `previous`: the choice it replaced (null: the
  // definition's).
  profile?: { name: string; seq: number; at: string; by: string; previous: string | null }
}

// A recovery (observer p3, docs/observation.md): an interrupted or unknown
// hold lifted by a recovering agent for an incident, naming the attempt
// whose end held the run and the recovering agent's own run and attempt.
export interface RecoveryAgent { workspace: string; workflow: string; run: string; attempt: string }
// `lifted`: the hold the recovery lifted, or null for an unowned continuation
// (work left ready or an answer recorded, nothing queued, no hold).
export interface Recovery { seq: number; at: string; by: string; incident: string; attempt: string; lifted: HoldKind | null; reason: string; agent?: RecoveryAgent }
export const INCIDENT_ID = /^[A-Za-z0-9][A-Za-z0-9:._#-]{0,79}$/
export const RECOVERY_BUDGET = 2 // recoveries since the last person-originated control, or the run's creation

// Where the run's work is kept (p9, docs/storage.md): its own branch in
// each repository it owns, the commit each started from and the branch an
// integration goes to. Portable: names and commits, never paths or URLs.
// Absent for a run kept in the project workspace (created there by an IDE
// agent, or recorded before p9 and not migrated).
export interface RunStorage {
  kind: 'run-copy'
  branch: string
  repositories: { path: string; base: string | null; branch: string | null; target: string | null }[]
}

export interface RunState {
  schema: string
  project: string
  workflow: string
  run: string
  created: string
  input: RunInput
  executor: Executor
  predecessor: RunRef | null
  definition: DefinitionRef
  context: { repositories: RepoContext[]; catalog?: CatalogContext } // catalog (p7/ex1): what the run was given of the person's node catalog
  storage?: RunStorage // p9: present when the run has its own working copy
  nodes: Record<string, NodeRecord>
  questions: Record<string, Question>
  instructions?: Record<string, Instruction> // present once the first one arrives (p6)
  presentations?: Record<string, Presentation> // present once the first one is registered (p7)
  inputs?: Record<string, InputSet> // present once the first input set is selected (project_migration p6)
  outputs?: Record<string, ExternalOutput> // present once the first external output is published (project_migration p6)
  integrations?: IntegrationRecord[] // present once the first one completed (p9)
  recoveries?: Recovery[] // present once the first run.recover is recorded (observer p3)
  assignments?: NodeAssignment[] // present once the first run.assign is recorded (project_migration p7)
  sessions?: SessionRecord[] // present once an attempt recorded its session (agent_session p1); the last open one is current
  delegations?: Record<string, Delegation> // present once the first dispatch is recorded (p10, docs/delegation.md)
  artifacts: Artifact[]
  decisions: Decision[]
  cancelled: { reason: string; at: string; by: string; because?: Because } | null
  control: Control
  execution: Execution
  started: string | null
  ended: string | null
  updated: string
  seq: number
}

// ---- operations (history entries) ---------------------------------------------

export type OpInput =
  | { op: 'run.create'; project: string; workflow: string; run: string; input: RunInput; executor: Executor; predecessor: RunRef | null; definition: DefinitionRef; context: RunState['context']; nodes: string[]; storage?: RunStorage }
  | { op: 'node.start'; node: string; reason?: string }
  | { op: 'node.progress'; node: string; text: string }
  | { op: 'node.wait'; node: string; reason: string; holder: string; external: string; deadline?: string }
  | { op: 'node.complete'; node: string; outcome: string; artifacts?: string[]; document?: DocumentEvidence; agreement?: string }
  | { op: 'node.fail'; node: string; reason: string }
  | { op: 'node.cancel'; node: string; reason: string }
  | { op: 'question.ask'; question: string; node?: string; text: string; to: string; document?: DocumentEvidence; plan?: boolean; subjects?: string[]; subject?: DocumentEvidence[]; presentation?: string; output?: string; adjustment?: string }
  | { op: 'question.answer'; question: string; text: string; from?: string; source?: SourceRef; delegation?: { uid: string; answer: number } }
  | { op: 'instruction.receive'; instruction?: string; text: string; from: string; source?: SourceRef }
  | { op: 'instruction.ack'; instructions: string[]; response: string; note: string }
  | { op: 'question.take-up'; question: string; answer?: number }
  | { op: 'question.withdraw'; question: string; reason: string }
  | { op: 'artifact.attach'; path: string; node?: string; title?: string }
  | { op: 'run.cancel'; reason: string; because?: BecauseRef }
  | { op: 'run.decide'; decision: 'accepted' | 'rejected'; evidence?: string; note?: string; question?: string; answer?: number; subject?: DocumentEvidence[]; revision?: RevisionEntry[] }
  | { op: 'run.integrate'; decision: number; repositories: IntegrationRecord['repositories']; integration?: string }
  // p9 migration: a run recorded in the project workspace now lives in its
  // own copy. Nothing else changes: nodes, questions, holds and decisions
  // stay as they were; what it published before stays published.
  | { op: 'run.relocate'; storage: RunStorage; note: string }
  // project_migration p7: the run is performed by another execution node
  // from its next attempt on. Never automatic: recorded with who and why,
  // only while no attempt is open.
  | { op: 'run.assign'; node: string; reason: string }
  | { op: 'attempt.begin'; attempt: string; reason: string; backend?: string; settings?: AttemptSettings }
  // `waits` (project_migration p8): ready work beside a wait is left for the
  // attempt the wait's answer starts. Absent on entries written before, which
  // replay as they were decided.
  // `explain` (project_migration p8 ex1): a hold this end derives records its
  // structured cause; absent on entries written before, which replay as they were.
  | { op: 'attempt.end'; attempt: string; outcome: AttemptOutcome; detail?: string; waits?: 'defer-ready'; explain?: 'cause' }
  // agent_session p1: what the harness reported of the open attempt's
  // session (`attached`: its id), or a replacement before anything was
  // launched in it (`replaced`: the resumed session is missing on the host;
  // `id` is the new one).
  | { op: 'attempt.session'; attempt: string; event: 'attached' | 'replaced'; id: string | null; reason?: string }
  // workflow_editor p13: whether the prepared context reached the launched
  // process (`delivered`: the prompt carrying it was written to the
  // harness; `undelivered`: the launch failed before that). Delivery is not
  // proof that the agent read or used it.
  | { op: 'attempt.context'; attempt: string; event: 'delivered' | 'undelivered'; snapshot: string; detail?: string }
  // A person or a recovering agent ends the run's current session; the next
  // attempt starts a new one from the records.
  | { op: 'session.retire'; reason: string; because?: BecauseRef }
  | { op: 'run.stop'; reason: string; because?: BecauseRef }
  | { op: 'run.resume'; reason: string; because?: BecauseRef; profile?: string }
  // observer p3: a recovering agent continues an interrupted/unknown hold for an incident.
  | { op: 'run.recover'; incident: string; attempt: string; reason: string; agent?: RecoveryAgent }
  | { op: 'presentation.register'; presentation?: string; node: string; title: string; manifest?: PresentationManifest }
  | { op: 'presentation.observe'; presentation: string; status: Observation; instance?: string; detail?: string }
  // project_migration p6 (docs/shares.md). The file layer reads the share,
  // writes the manifest and gives its facts; select and publish are the
  // executor's, observe is a host fact (like presentation.observe).
  | { op: 'input.select'; input?: string; node: string; ref: string; staging: Staging; manifest?: { file: string; digest: string; count: number; bytes: number } }
  | { op: 'input.observe'; input: string; status: SetObservation; detail?: string }
  | { op: 'output.publish'; output?: string; node: string; title: string; candidate: string; ref?: string; manifest?: { file: string; digest: string; count: number; bytes: number; inputs: string[] } }
  | { op: 'output.observe'; output: string; status: SetObservation; detail?: string }
  // completing (p8/ex2): the adjustment is made at the completion of that
  // running node; the next entry is its node.complete (one locked write).
  | { op: 'run.adjust'; revision: string; parent: string; file: string; sha256: string; definitionDigest: string; effective: EffectiveGraph; reason: string; source: AdjustSource; diff?: AdjustDiff; completing?: string }
  // p10 (docs/delegation.md). The parent agent's: dispatch, take-up, answer,
  // instruct, dispose. The system's: bind (the child the intake created
  // from the request post) and event (a fact of the child relayed).
  | { op: 'delegation.dispatch'; delegation: string; uid: string; node: string; target: DelegationTarget; request?: DocumentEvidence; original?: DocumentEvidence; onBehalfOf?: string; predecessor?: string; targetDigest?: string }
  | { op: 'delegation.bind'; delegation: string; child: ChildRef; transport: TransportRef }
  | { op: 'delegation.event'; delegation: string; event: Omit<DelegationEvent, 'n' | 'at' | 'seq' | 'during' | 'wakes' | 'takenUp'> }
  | { op: 'delegation.take-up'; delegation: string; events: number[] }
  | { op: 'delegation.answer'; delegation: string; question: string; text: string; because?: BecauseRef }
  | { op: 'delegation.instruct'; delegation: string; text: string; because?: BecauseRef }
  | { op: 'delegation.dispose'; delegation: string; disposition: string; note: string; event?: number }

// What a recorder gives: the answer (by question and index, default the
// latest) or the instruction; the reducer resolves and records whose words.
export type BecauseRef = { kind: 'answer'; question: string; answer?: number } | { kind: 'instruction'; instruction: string }
// Control operations (p9): an executing agent records them as itself; when
// it carries its attempt id, that attempt must be the open one.
export const CONTROL_OPS: readonly string[] = ['run.stop', 'run.resume', 'run.cancel']

export const OPS = ['run.create', 'node.start', 'node.progress', 'node.wait', 'node.complete', 'node.fail', 'node.cancel',
  'question.ask', 'question.answer', 'question.take-up', 'question.withdraw', 'instruction.receive', 'instruction.ack', 'artifact.attach', 'run.cancel', 'run.decide',
  'attempt.begin', 'attempt.end', 'run.stop', 'run.resume', 'presentation.register', 'presentation.observe', 'run.adjust', 'run.integrate', 'run.relocate', 'run.assign', 'run.recover', 'attempt.session', 'attempt.context', 'session.retire',
  'delegation.dispatch', 'delegation.bind', 'delegation.event', 'delegation.take-up', 'delegation.answer', 'delegation.instruct', 'delegation.dispose',
  'input.select', 'input.observe', 'output.publish', 'output.observe'] as const
// The executor's own reports. While an attempt is open they must carry its
// id (`attempt`), so a stopped or superseded attempt cannot write into the
// record of the one that replaced it.
export const EXECUTOR_OPS: readonly string[] = ['node.start', 'node.progress', 'node.wait', 'node.complete', 'node.fail', 'question.ask', 'question.take-up', 'question.withdraw', 'instruction.ack', 'artifact.attach', 'presentation.register',
  'delegation.dispatch', 'delegation.take-up', 'delegation.answer', 'delegation.instruct', 'delegation.dispose',
  'input.select', 'output.publish']

// Received instructions the executor has not acknowledged, in arrival order.
export const pendingInstructions = (s: Pick<RunState, 'instructions'>): Instruction[] => Object.values(s.instructions ?? {}).filter(i => !i.ack)
// Every entry may carry `attempt` (the executor's launch) and `receipt` (an
// idempotency key: a retransmitted request with the same receipt is not
// recorded twice).
// `operator` (project_migration p8): the executing attempt of *another* run
// that recorded this entry — an agent operating this run from its own work,
// as a person does from the run view. `by` is that run's agent; `attempt`
// stays this run's own attempt fencing and is never the other run's.
export interface OperatorRef { run: string; attempt: string }
export interface EntryMeta { attempt?: string; receipt?: string; operator?: OperatorRef }

// What one entry changed, kept in the entry for readers of the raw history.
export interface Change {
  nodes?: Record<string, [NodeState | null, NodeState]>
  question?: [string | null, string]
  instruction?: [string | null, string]
  execution?: [ExecutionState | null, ExecutionState]
  hold?: [HoldKind | null, HoldKind | null]
  presentation?: [string, PresentationState | null, PresentationState] // id, from, to (p7)
  revision?: [string, string] // the revision in force before and after (p7)
}
export type HistoryEntry = OpInput & EntryMeta & { seq: number; at: string; by: string; via: string; change: Change }
export interface RunRecord extends RunState { history: HistoryEntry[] }

// One title rule for the run list and the opened run, including stopped
// presentations: their title still names the result after serving ends.
export function runDisplayTitle(rec: Pick<RunRecord, 'workflow' | 'presentations'>, workflowName?: string): string {
  return Object.values(rec.presentations ?? {}).at(-1)?.title || workflowName || rec.workflow
}

// The graph the run follows: its frozen effective graph (p5), or, for a run
// created before p5, the root workflow of its bundle. A node with `step` is a
// generated documentation step.
export interface RunGraph { nodes: Record<string, { type: string; workflow?: string; project?: string; accepts?: string; confirms?: string; activity?: string; step?: StepSpec }>; edges: Edge[] }
export const stepOf = (graph: RunGraph, node: string): StepSpec | undefined => graph.nodes[node]?.step
// The document a step writes, project-relative.
export const documentPath = (r: RunRef, step: StepSpec) => `${runFolder(r)}/${step.output}`

// A run's delegate nodes. Since p10 they execute (docs/delegation.md): a
// dispatch entrusts their work to another workflow's run.
export const delegateNodes = (graph: RunGraph) => Object.entries(graph.nodes).filter(([, n]) => n.type === 'delegate').map(([id]) => id).sort()

// ---- readiness and summary ------------------------------------------------------

export function predecessors(graph: RunGraph): Map<string, string[]> {
  const preds = new Map<string, string[]>(Object.keys(graph.nodes).map(id => [id, []]))
  for (const e of graph.edges) {
    const list = preds.get(e.to)
    if (list && e.from in graph.nodes && e.from !== e.to && !list.includes(e.from)) list.push(e.from)
  }
  return preds
}

// Ready: pending with every predecessor completed. Blocked: pending behind a
// failed, cancelled or blocked predecessor (failure never satisfies a dependency).
export function readiness(nodes: Record<string, { state: NodeState }>, graph: RunGraph): { ready: string[]; blocked: string[] } {
  const preds = predecessors(graph)
  const memo = new Map<string, boolean>()
  const isBlocked = (id: string, seen = new Set<string>()): boolean => {
    if (memo.has(id)) return memo.get(id)!
    if (seen.has(id)) return false
    seen.add(id)
    const b = (preds.get(id) ?? []).some(p => ['failed', 'cancelled'].includes(nodes[p]?.state) || (nodes[p]?.state === 'pending' && isBlocked(p, seen)))
    memo.set(id, b)
    return b
  }
  const ready: string[] = [], blocked: string[] = []
  for (const id of Object.keys(graph.nodes).sort()) {
    if (nodes[id]?.state !== 'pending') continue
    if ((preds.get(id) ?? []).every(p => nodes[p]?.state === 'completed')) ready.push(id)
    else if (isBlocked(id)) blocked.push(id)
  }
  return { ready, blocked }
}

export function summarize(s: Pick<RunState, 'nodes' | 'cancelled'>, graph: RunGraph): Execution {
  const counts = Object.fromEntries(NODE_STATES.map(k => [k, 0])) as Record<NodeState, number>
  const ids = Object.keys(s.nodes).sort()
  for (const id of ids) counts[s.nodes[id].state]++
  const { ready, blocked } = readiness(s.nodes, graph)
  const active = ids.filter(id => s.nodes[id].state === 'running')
  const waiting = ids.filter(id => s.nodes[id].state === 'waiting').map(id => ({ node: id, holder: s.nodes[id].wait?.holder ?? '', on: s.nodes[id].wait?.on ?? { external: '' } }))
  const failed = ids.filter(id => s.nodes[id].state === 'failed')
  let state: ExecutionState
  if (s.cancelled) state = 'cancelled'
  else if (ids.length > 0 && ids.filter(id => !graph.nodes[id]?.step || ['running', 'waiting', 'failed'].includes(s.nodes[id].state)).every(id => s.nodes[id].state === 'completed' || s.nodes[id].state === 'cancelled')) state = 'completed'
  else if (counts.pending === ids.length) state = 'not-started'
  else if (active.length || waiting.length || ready.length) state = 'in-progress'
  else state = 'stopped'
  return { state, counts, ready, blocked, active, waiting, failed }
}

// Who holds the next move on a waiting node, as the view states it.
export function holderOf(s: RunState, node: string): string {
  const w = s.nodes[node]?.wait
  if (!w) return ''
  if ('question' in w.on) {
    const q = s.questions[w.on.question]
    if (q && q.answers.length && !q.takenUp && !q.withdrawn) return `${s.executor.name} (answer recorded, not yet taken up)`
  }
  if ('delegation' in w.on) {
    const d = s.delegations?.[w.on.delegation]
    const pending = d ? pendingEvents(d) : []
    if (pending.length) return `${s.executor.name} (delegation ${d!.id}: ${pending.map(e => `${e.type} #${e.n}`).join(', ')} not yet taken up)`
  }
  return w.holder
}

export function questionState(q: Question): 'open' | 'answered' | 'taken-up' | 'withdrawn' {
  return q.withdrawn ? 'withdrawn' : q.takenUp ? 'taken-up' : q.answers.length ? 'answered' : 'open'
}

// ---- the reducer --------------------------------------------------------------

const text = (v: unknown, what: string): string => (typeof v === 'string' && v.trim() ? v : fail('missing', `${what} is required`))
const optText = (v: unknown, what: string): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : fail('shape', `${what} must be text`))
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function validRunRef(r: unknown, what: string): RunRef {
  if (!isObj(r) || typeof r.workflow !== 'string' || !ID_PATTERN.test(r.workflow) || typeof r.run !== 'string' || !RUN_ID.test(r.run)) fail('shape', `${what} must be {workflow, run} with valid ids`)
  return { workflow: (r as RunRef).workflow, run: (r as RunRef).run }
}

const SHA = /^[0-9a-f]{40,64}$/
export function validStorage(v: unknown): RunStorage {
  if (!isObj(v) || v.kind !== 'run-copy' || typeof v.branch !== 'string' || !/^wfe\/[a-z0-9][a-z0-9_.\/-]*$/.test(v.branch) || !Array.isArray(v.repositories) || !v.repositories.length) fail('shape', 'storage must be {kind: run-copy, branch: wfe/…, repositories: [...]}')
  const s = v as unknown as RunStorage
  const repositories = s.repositories.map((r, i) => {
    const path = isObj(r) && typeof r.path === 'string' ? normalizeRepoPath(r.path) : null
    if (!path) fail('shape', `storage.repositories[${i}] needs a project-relative path`)
    for (const k of ['base', 'branch', 'target'] as const) if (r[k] !== null && typeof r[k] !== 'string') fail('shape', `storage.repositories[${i}].${k} must be text or null`)
    if (r.base !== null && !SHA.test(r.base)) fail('shape', `storage.repositories[${i}].base must be a commit id`)
    return { path: path!, base: r.base, branch: r.branch, target: r.target }
  })
  if (!repositories.some(r => r.path === '.')) fail('shape', 'storage names the project root (".")')
  return { kind: 'run-copy', branch: s.branch, repositories }
}

// The revision evidence the file layer adds to an acceptance (p9).
function revisionOf(e: { decision?: string; revision?: unknown }): { revision?: RevisionEntry[] } {
  if (e.revision === undefined || e.revision === null) return {}
  if (e.decision !== 'accepted') fail('shape', 'only an acceptance records a revision')
  if (!Array.isArray(e.revision) || !e.revision.every(r => isObj(r) && typeof r.path === 'string' && typeof r.tree === 'string' && /^[0-9a-f]{40,64}$/.test(r.tree))) fail('shape', 'revision must list {path, tree} per repository')
  return { revision: (e.revision as RevisionEntry[]).map(r => ({ path: r.path, tree: r.tree })) }
}

export function validArtifactPath(p: unknown): string {
  const n = typeof p === 'string' ? normalizeRepoPath(p) : null
  if (!n || n === '.') fail('artifact-path', `artifact path "${String(p)}" must be project-relative, inside the project`)
  return n!
}

function evidence(v: unknown, what: string, expected: string): DocumentEvidence {
  if (!isObj(v)) return fail('document-missing', `${what} needs the checked document ${expected} (the file layer records it; write the file first)`)
  const d = v as Record<string, unknown>
  if (d.path !== expected) fail('document-path', `${what}: the document is ${expected}, not ${String(d.path)}`)
  if (typeof d.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(d.sha256)) fail('shape', `${what}: document sha256 must be 64 hex digits`)
  if (typeof d.bytes !== 'number' || !Number.isInteger(d.bytes) || d.bytes <= 0) fail('document-empty', `${what}: ${expected} is empty`)
  return { path: expected, sha256: d.sha256 as string, bytes: d.bytes as number }
}

export function sourceOf(v: unknown): SourceRef {
  if (!isObj(v)) return fail('shape', 'a source must be an object')
  const o = v as Record<string, unknown>
  const int = (x: unknown, what: string) => (typeof x === 'number' && Number.isInteger(x) && x > 0 ? x : fail('shape', `source.${what} must be a positive integer`))
  if (o.kind === 'conversation') return { kind: 'conversation', conversation: text(o.conversation, 'source.conversation'), message: int(o.message, 'message'), author: text(o.author, 'source.author'), at: text(o.at, 'source.at'), ...(o.invitation !== undefined ? { invitation: int(o.invitation, 'invitation') } : {}) }
  if (o.kind !== 'zulip') fail('shape', 'source.kind must be zulip or conversation')
  return { kind: 'zulip', realm: text(o.realm, 'source.realm'), message: int(o.message, 'message'), stream: int(o.stream, 'stream'), topic: text(o.topic, 'source.topic'), sender: int(o.sender, 'sender'), senderName: text(o.senderName, 'source.senderName'), at: text(o.at, 'source.at') }
}

// A deliverable's evidence: a project-relative file, its hash and size.
function subjectOf(v: unknown, what: string): DocumentEvidence {
  if (!isObj(v)) return fail('shape', `${what} must be {path, sha256, bytes}`)
  const d = v as Record<string, unknown>
  const path = typeof d.path === 'string' ? normalizeRepoPath(d.path) : null
  if (!path || path === '.') fail('shape', `${what}: path must be project-relative`)
  if (typeof d.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(d.sha256)) fail('shape', `${what}: sha256 must be 64 hex digits`)
  if (typeof d.bytes !== 'number' || !Number.isInteger(d.bytes) || d.bytes <= 0) fail('document-empty', `${what}: ${path} is empty`)
  return { path: path!, sha256: d.sha256 as string, bytes: d.bytes as number }
}

function adjustSource(v: unknown): AdjustSource {
  if (v === undefined) return { kind: 'agent' }
  if (!isObj(v)) return fail('shape', 'source must be an object')
  const o = v as Record<string, unknown>
  if (o.kind === 'agent') return { kind: 'agent' }
  if (o.kind === 'answer') return { kind: 'answer', question: text(o.question, 'source.question'), ...(o.answer !== undefined ? { answer: Number(o.answer) } : {}) }
  if (o.kind === 'instruction') return { kind: 'instruction', instruction: text(o.instruction, 'source.instruction') }
  if (o.kind === 'agreement') return { kind: 'agreement', question: text(o.question, 'source.question') }
  if (o.kind === 'person') return { kind: 'person', ...(typeof o.by === 'string' && o.by.trim() ? { by: o.by.trim() } : {}) }
  if (o.kind === 'request') {
    if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha256)) fail('shape', 'a request source names the input by hash (source.sha256)')
    return { kind: 'request', input: text(o.input, 'source.input'), sha256: o.sha256 as string }
  }
  return fail('shape', 'source.kind is answer, instruction, agreement, person or request')
}

const hasCycle = (ids: string[], next: (id: string) => string[]): boolean => {
  const st = new Map<string, number>()
  const visit = (id: string): boolean => { st.set(id, 1); for (const t of next(id)) { if (st.get(t) === 1) return true; if (!st.has(t) && visit(t)) return true } st.set(id, 2); return false }
  return ids.some(id => !st.has(id) && visit(id))
}

// What an adjustment changed, node by node and edge by edge.
export function graphDiff(a: RunGraph, b: RunGraph): AdjustDiff {
  const key = (e: Edge) => `${e.from}\0${e.to}`
  const ea = new Set(a.edges.map(key)), eb = new Set(b.edges.map(key))
  return {
    added: Object.keys(b.nodes).filter(n => !(n in a.nodes)).sort(),
    removed: Object.keys(a.nodes).filter(n => !(n in b.nodes)).sort(),
    changed: Object.keys(b.nodes).filter(n => n in a.nodes && canonicalJson(a.nodes[n]) !== canonicalJson(b.nodes[n])).sort(),
    edgesAdded: b.edges.filter(e => !ea.has(key(e))).map(e => [e.from, e.to] as [string, string]).sort(),
    edgesRemoved: a.edges.filter(e => !eb.has(key(e))).map(e => [e.from, e.to] as [string, string]).sort(),
  }
}

// A registered presentation's manifest (p7): computed by the file layer;
// here only its shape and that every path lies in the presentation's folder.
function manifestOf(v: unknown, folder: string): PresentationManifest {
  if (!isObj(v)) return fail('presentation-missing', 'a presentation needs the manifest the file layer writes (wfe present register copies the files first)')
  const m = v as Record<string, unknown>
  if (typeof m.revision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(m.revision)) fail('shape', 'the manifest revision must be sha256:<64 hex digits>')
  if (!Array.isArray(m.files) || !m.files.length) fail('shape', 'the manifest lists no files')
  const files = (m.files as unknown[]).map((f, i) => subjectOf(f, `manifest file ${i + 1}`))
  for (const f of files) if (!f.path.startsWith(`${folder}/`)) fail('shape', `manifest file ${f.path} is outside ${folder}/`)
  const local = (x: unknown, what: string) => {
    const p = typeof x === 'string' ? normalizeRepoPath(x) : null
    if (!p || p === '.' || !files.some(f => f.path === `${folder}/${p}`)) fail('shape', `the manifest ${what} "${String(x)}" is not one of its files`)
    return p!
  }
  return { revision: m.revision as string, entry: local(m.entry, 'entry'), review: local(m.review, 'review'), files }
}

// A child's result manifest (p10): computed by the file layer from the
// child's record and files; here only its shape.
function manifestShape(v: unknown): ResultManifest {
  if (!isObj(v)) return fail('shape', 'a result manifest is an object')
  const m = v as Record<string, unknown>
  if (typeof m.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(m.digest)) fail('shape', 'manifest.digest is sha256:<hex>')
  const file = (f: unknown, what: string) => {
    if (!isObj(f) || typeof f.path !== 'string' || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256) || typeof f.bytes !== 'number' || (f.commit !== null && typeof f.commit !== 'string')) return fail('shape', `${what} is {path, sha256, bytes, commit}`)
    return { path: f.path, sha256: f.sha256, bytes: f.bytes, commit: (f.commit as string | null) ?? null }
  }
  if (!Array.isArray(m.artifacts)) fail('shape', 'manifest.artifacts is a list')
  const dec = m.decision as Record<string, unknown> | null
  return {
    digest: m.digest as string, child: text(m.child, 'manifest.child'), execution: text(m.execution, 'manifest.execution'), outcome: optText(m.outcome, 'manifest.outcome'),
    report: m.report === null || m.report === undefined ? null : file(m.report, 'manifest.report'),
    artifacts: (m.artifacts as unknown[]).map((f, i) => file(f, `manifest.artifacts[${i}]`)),
    decision: isObj(dec) ? { decision: String(dec.decision), by: String(dec.by), at: String(dec.at) } : null,
    branch: typeof m.branch === 'string' ? m.branch : null,
  }
}

function attemptSettings(v: unknown): AttemptSettings {
  if (!isObj(v)) return fail('shape', 'attempt settings must be an object')
  const o = v as Record<string, unknown>
  const hash = (h: unknown, what: string) => (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h) ? h : fail('shape', `${what}: sha256 must be 64 hex digits`))
  const contract = o.contract === null || o.contract === undefined ? null : isObj(o.contract) ? { name: text((o.contract as Record<string, unknown>).name, 'the contract name'), sha256: hash((o.contract as Record<string, unknown>).sha256, 'the contract') } : fail('shape', 'settings.contract must be {name, sha256}')
  if (o.guides !== undefined && !Array.isArray(o.guides)) fail('shape', 'settings.guides must be a list')
  if (o.guides === undefined && o.context === undefined) fail('shape', 'settings name their context (or, before p13, their guides)')
  const guides = o.guides === undefined ? undefined : (o.guides as unknown[]).map((g, i) => {
    if (!isObj(g)) return fail('shape', `settings.guides[${i}] must be {path, sha256}`)
    const path = normalizeRepoPath(String((g as Record<string, unknown>).path ?? ''))
    if (!path || path === '.') fail('shape', `settings.guides[${i}] path must be project-relative`)
    return { path: path!, sha256: hash((g as Record<string, unknown>).sha256, `settings.guides[${i}]`) }
  })
  let context: AttemptContext | undefined
  if (o.context !== undefined) {
    const c = o.context as Record<string, unknown>
    if (!isObj(c) || typeof c.snapshot !== 'string' || !/^ctx-[0-9a-f]{24}$/.test(c.snapshot) || typeof c.fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(c.fingerprint) || !Array.isArray(c.sources)) fail('shape', 'settings.context must be {snapshot: ctx-<hex>, fingerprint: sha256:<hex>, sources}')
    const sources = (c.sources as unknown[]).map((x, i) => {
      const y = x as Record<string, unknown>
      if (!isObj(y) || typeof y.key !== 'string' || !['system', 'project', 'workflow', 'run'].includes(y.scope as string) || !['default', 'override', 'input'].includes(y.category as string) || !['body', 'reference', 'absent', 'error'].includes(y.delivery as string)) return fail('shape', `settings.context.sources[${i}] must be {key, scope, category, delivery, sha256?}`)
      return { key: y.key, scope: y.scope, category: y.category, delivery: y.delivery, ...(y.sha256 !== undefined ? { sha256: hash(y.sha256, `settings.context.sources[${i}]`) } : {}) } as AttemptContext['sources'][number]
    })
    context = { snapshot: c.snapshot as string, fingerprint: c.fingerprint as string, sources }
  }
  let catalog: AttemptCatalog | undefined
  if (o.catalog !== undefined) {
    const c = o.catalog as Record<string, unknown>
    if (isObj(c) && c.state === 'unavailable') catalog = { state: 'unavailable' }
    else if (isObj(c) && c.state === 'supplied' && typeof c.templates === 'number' && Number.isInteger(c.templates) && c.templates >= 0) catalog = { state: 'supplied', sha256: hash(c.sha256, 'settings.catalog'), templates: c.templates }
    else fail('shape', 'settings.catalog must be {state: supplied, sha256, templates} or {state: unavailable}')
  }
  let session: AttemptSession | undefined
  if (o.session !== undefined) {
    const x = o.session as Record<string, unknown>
    if (!isObj(x) || (x.policy !== 'fresh' && x.policy !== 'run') || (x.mode !== 'new' && x.mode !== 'resume')) fail('shape', 'settings.session must be {policy: fresh|run, mode: new|resume, id}')
    const id = x.id === null || x.id === undefined ? null : typeof x.id === 'string' && SESSION_ID.test(x.id) ? x.id : fail('shape', `settings.session.id must match ${SESSION_ID.source}`)
    if (x.mode === 'resume' && !id) fail('shape', 'a resumed session names its id')
    let replaces: AttemptSession['replaces']
    if (x.replaces !== undefined && x.replaces !== null) {
      const r = x.replaces as Record<string, unknown>
      if (!isObj(r)) fail('shape', 'settings.session.replaces must be {id, reason}')
      replaces = { id: typeof r.id === 'string' ? r.id : null, reason: text(r.reason, 'settings.session.replaces.reason') }
    }
    if (x.reconstruct !== undefined && x.mode !== 'resume') fail('shape', 'settings.session.reconstruct belongs to a resumed session')
    const reconstruct = x.reconstruct === undefined ? undefined : text(x.reconstruct, 'settings.session.reconstruct')
    session = { policy: x.policy as 'fresh' | 'run', mode: x.mode as 'new' | 'resume', id, ...(replaces ? { replaces } : {}), ...(reconstruct ? { reconstruct } : {}) }
  }
  return { agent: text(o.agent, 'settings.agent'), profile: optText(o.profile, 'settings.profile') || null, backend: optText(o.backend, 'settings.backend') || null, contract, ...(guides ? { guides } : {}), ...(context ? { context } : {}), ...(catalog ? { catalog } : {}), ...(session ? { session } : {}) }
}

function emptyNode(): NodeRecord {
  return { state: 'pending', updated: null, started: null, ended: null, wait: null, outcome: null, failure: null, cancellation: null, notes: [] }
}

const TERMINAL: ExecutionState[] = ['completed', 'stopped', 'cancelled']

// Applies one entry. Returns the next state and what changed; throws RunError
// for an operation the current state does not allow.
export const emptyControl = (): Control => ({ attempt: null, attempts: 0, last: null, hold: null, stop: null })

export function apply(prev: RunState | null, e: HistoryEntry | (OpInput & EntryMeta & { seq: number; at: string; by: string; via: string }), graph: RunGraph): { state: RunState; change: Change } {
  const at = text(e.at, 'at'), by = text(e.by, 'by')
  text(e.via, 'via')
  if (Number.isNaN(Date.parse(at))) fail('shape', `history ${e.seq}: "at" is not a timestamp`)
  if (e.op === 'run.create') {
    if (prev) fail('order', 'run.create may only be the first entry')
    if (typeof e.project !== 'string' || !ID_PATTERN.test(e.project)) fail('shape', `project id "${String(e.project)}" is invalid`)
    if (!ID_PATTERN.test(e.workflow)) fail('shape', `workflow id "${e.workflow}" is invalid`)
    if (!RUN_ID.test(e.run)) fail('run-id', `run id "${e.run}" must match ${RUN_ID.source}`)
    const ids = [...(e.nodes ?? [])].sort()
    if (canonicalJson(ids) !== canonicalJson(Object.keys(graph.nodes).sort())) fail('graph', 'the nodes in run.create differ from the bundled definition')
    const eff = e.definition?.effective
    if (eff && canonicalJson({ nodes: eff.nodes, edges: eff.edges }) !== canonicalJson({ nodes: graph.nodes, edges: graph.edges })) fail('graph', 'the graph followed differs from the frozen effective graph')
    if (e.executor?.node !== undefined && (typeof e.executor.node !== 'string' || !NODE_PATTERN.test(e.executor.node))) fail('shape', `executor.node "${String(e.executor.node)}" must match ${NODE_PATTERN.source}`)
    if (e.executor?.lane !== undefined && (typeof e.executor.lane !== 'string' || !NODE_PATTERN.test(e.executor.lane))) fail('shape', `executor.lane "${String(e.executor.lane)}" must match ${NODE_PATTERN.source}`)
    if (e.input?.source !== undefined) sourceOf(e.input.source) // checked, recorded as given
    if (e.input?.references !== undefined) {
      if (!Array.isArray(e.input.references)) fail('shape', 'input.references must be a list')
      for (const r of e.input.references) if (!isObj(r) || typeof r.ref !== 'string' || parseRef(r.ref)?.ref !== r.ref) fail('shape', `input reference "${String((r as { ref?: unknown })?.ref)}" is not a shared:// reference`)
    }
    const nodes = Object.fromEntries(ids.map(id => [id, emptyNode()]))
    const state: RunState = {
      schema: RUN_SCHEMA, project: e.project, workflow: e.workflow, run: e.run, created: at,
      input: e.input, executor: e.executor, predecessor: e.predecessor ?? null,
      definition: e.definition, context: e.context, ...(e.storage !== undefined ? { storage: validStorage(e.storage) } : {}),
      nodes, questions: {}, artifacts: [], decisions: [], cancelled: null, control: emptyControl(),
      execution: summarize({ nodes, cancelled: null }, graph), started: null, ended: null, updated: at, seq: e.seq,
    }
    return { state, change: { execution: [null, state.execution.state] } }
  }
  if (!prev) return fail('order', 'the first history entry must be run.create')
  const s: RunState = structuredClone(prev)
  s.seq = e.seq
  s.updated = at
  const change: Change = {}
  const node = (id: unknown): NodeRecord => {
    if (typeof id !== 'string' || !(id in s.nodes)) fail('node-unknown', `node "${String(id)}" is not in this run's definition`)
    return s.nodes[id as string]
  }
  const move = (id: string, to: NodeState) => {
    const n = s.nodes[id]
    const from = change.nodes?.[id]?.[0] ?? n.state
    n.state = to
    n.updated = at
    change.nodes = { ...change.nodes, [id]: [from, to] }
  }
  const question = (id: unknown): Question => {
    if (typeof id !== 'string' || !(id in s.questions)) fail('question-unknown', `question "${String(id)}" does not exist in this run`)
    return s.questions[id as string]
  }
  const live = () => { if (s.cancelled) fail('run-cancelled', 'the run is cancelled; no further execution is recorded') }
  const ctl = s.control
  const holdBefore = ctl.hold?.kind ?? null
  // Fencing: the executor's reports belong to the open attempt.
  if (EXECUTOR_OPS.includes(e.op)) {
    if (e.attempt !== undefined && e.attempt !== null) {
      if (!ctl.attempt || ctl.attempt.id !== e.attempt) fail('attempt-stale', `attempt ${e.attempt} is not the current attempt of this run (${ctl.attempt ? `${ctl.attempt.id} is` : 'none is open'}); a stopped or superseded attempt records nothing`)
    } else if (ctl.attempt) fail('attempt-required', `attempt ${ctl.attempt.id} is executing this run; its reports carry its id (WFE_ATTEMPT), and nobody else records execution meanwhile`)
  }
  if (CONTROL_OPS.includes(e.op) && e.attempt !== undefined && e.attempt !== null && (!ctl.attempt || ctl.attempt.id !== e.attempt)) fail('attempt-stale', `attempt ${e.attempt} is not the current attempt of this run (${ctl.attempt ? `${ctl.attempt.id} is` : 'none is open'}); a stopped or superseded attempt records nothing`)
  // The person's words a control operation names must exist in this run.
  const because = (v: unknown): Because | undefined => {
    if (v === undefined || v === null) return undefined
    if (!isObj(v)) return fail('shape', 'because must be {kind: answer, question, answer?} or {kind: instruction, instruction}')
    if (v.kind === 'answer') {
      const q = question(v.question)
      if (!q.answers.length) fail('because', `question ${q.id} has no answer to act on`)
      const i = v.answer === undefined || v.answer === null ? q.answers.length - 1 : v.answer
      if (typeof i !== 'number' || !Number.isInteger(i) || !q.answers[i]) fail('because', `question ${q.id} has no answer ${String(v.answer)}`)
      return { kind: 'answer', question: q.id, answer: i as number, from: q.answers[i as number].from }
    }
    if (v.kind === 'instruction') {
      const ins = typeof v.instruction === 'string' ? s.instructions?.[v.instruction] : undefined
      if (!ins) fail('because', `instruction ${String(v.instruction)} does not exist in this run`)
      return { kind: 'instruction', instruction: ins!.id, from: ins!.from }
    }
    return fail('shape', 'because.kind must be answer or instruction')
  }

  switch (e.op) {
    case 'node.start': {
      live()
      const n = node(e.node)
      if (n.state === 'pending') {
        n.started = at
        if (!s.started) s.started = at
      } else if (n.state === 'waiting') {
        n.wait = null
      } else if (n.state === 'failed') {
        n.failure = null; n.ended = null
      } else {
        n.ended = null; n.wait = null; n.failure = null; n.cancellation = null
      }
      if (e.reason) n.notes.push({ at, by, text: e.reason })
      move(e.node, 'running')
      break
    }
    case 'node.progress': {
      live()
      const n = node(e.node)
      if (n.state !== 'running' && n.state !== 'waiting') fail('state', `node "${e.node}" is ${n.state}; progress notes apply to running or waiting nodes`)
      n.notes.push({ at, by, text: text(e.text, 'the note text') })
      n.updated = at
      break
    }
    case 'node.wait': {
      live()
      const n = node(e.node)
      if (n.state !== 'running') fail('state', `node "${e.node}" is ${n.state}; only a running node can start waiting`)
      n.wait = { reason: text(e.reason, 'the reason'), holder: text(e.holder, 'the holder of the next move'), on: { external: text(e.external, 'the external result reference') } }
      if (e.deadline !== undefined && e.deadline !== null) {
        if (typeof e.deadline !== 'string' || Number.isNaN(Date.parse(e.deadline))) fail('shape', 'deadline must be an ISO 8601 time')
        n.wait.deadline = new Date(e.deadline).toISOString()
      }
      move(e.node, 'waiting')
      break
    }
    case 'node.complete': {
      live()
      const n = node(e.node)
      if (n.state !== 'running') fail('state', `node "${e.node}" is ${n.state}; only a running node completes${n.state === 'waiting' ? ' (resume it with start first)' : ''}`)
      const artifacts = (e.artifacts ?? []).map(validArtifactPath)
      const step = stepOf(graph, e.node)
      let doc: DocumentEvidence | undefined
      if (step) {
        if (e.document) {
          doc = evidence(e.document, `completing ${e.node}`, documentPath(s, step))
          n.document = doc
          if (!artifacts.includes(doc.path)) artifacts.unshift(doc.path)
        }
        const recordedAgreement = e.agreement ? s.questions[e.agreement] : Object.values(s.questions).filter(q => q.node === e.node && q.takenUp && q.document?.sha256 === doc?.sha256).at(-1)
        if (step.kind === 'plan' && doc && recordedAgreement?.takenUp && recordedAgreement.document?.sha256 === doc.sha256) n.agreement = { question: recordedAgreement.id }
      } else if (e.document !== undefined || e.agreement !== undefined) fail('shape', `node "${e.node}" is authored work; documents and plan agreement belong to documentation steps`)
      n.outcome = { text: text(e.outcome, 'the outcome'), artifacts }
      n.ended = at
      for (const path of artifacts) s.artifacts.push({ path, node: e.node, title: '', by, at })
      move(e.node, 'completed')
      break
    }
    case 'node.fail': {
      live()
      const n = node(e.node)
      if (n.state !== 'running' && n.state !== 'waiting') fail('state', `node "${e.node}" is ${n.state}; only running or waiting nodes fail`)
      n.failure = { reason: text(e.reason, 'the reason'), at, by }
      n.wait = null; n.ended = at
      move(e.node, 'failed')
      break
    }
    case 'node.cancel': {
      live()
      const n = node(e.node)
      if (n.state === 'completed' || n.state === 'cancelled') fail('state', `node "${e.node}" is ${n.state}; it cannot be cancelled`)
      n.cancellation = { reason: text(e.reason, 'the reason'), at, by }
      n.wait = null; n.ended = at
      move(e.node, 'cancelled')
      break
    }
    case 'question.ask': {
      live()
      if (!QUESTION_ID.test(e.question)) fail('shape', `question id "${e.question}" must match ${QUESTION_ID.source}`)
      if (e.question in s.questions) fail('question-exists', `question ${e.question} already exists`)
      const q: Question = { id: e.question, node: e.node ?? null, text: text(e.text, 'the question'), to: text(e.to, 'to whom the question is addressed'), askedBy: by, asked: at, answers: [], takenUp: null, withdrawn: null }
      const step = e.node ? stepOf(graph, e.node) : undefined
      // The plan is written before it is consulted on, and the question
      // records which plan.md it asked about.
      if (step?.kind === 'plan' && e.document) q.document = evidence(e.document, `asking from ${e.node}`, documentPath(s, step))
      else if (e.plan) {
        // A revised plan after the plan step (p6: an instruction changed the
        // agreed work): asked about with the same document evidence, so the
        // renewed agreement names the plan.md it agreed to.
        const plan = Object.values(graph.nodes).find(n => n.step?.kind === 'plan')?.step
        if (!plan) fail('shape', 'this run has no plan step; there is no plan.md to ask about')
        q.document = evidence(e.document, 'asking about the revised plan', documentPath(s, plan!))
      } else if (e.adjustment) {
        // A proposed adjustment (p7): the question records the proposal's
        // file by hash, so an agreement names exactly what it agreed to.
        if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(e.adjustment)) fail('shape', `proposal name "${e.adjustment}" is invalid`)
        q.document = evidence(e.document, 'asking about a proposed adjustment', `${runFolder(s)}/definition/proposals/${e.adjustment}.yaml`)
      } else if (e.document !== undefined) fail('shape', 'only a question about the plan records a document')
      // The result confirmation presents deliverables; the question records
      // them by hash (the file layer checks them), so a confirmation is of
      // exactly those files.
      if (e.node && graph.nodes[e.node]?.confirms === 'result') {
        if (!Array.isArray(e.subject) || !e.subject.length) fail('subject-missing', `${e.node} confirms the result: name the deliverables it presents (--presentation <p>, --output <o>, or --subject <path> written first)`)
        q.subject = e.subject!.map((d, i) => subjectOf(d, `subject ${i + 1}`))
        // A presentation (p7): the question asks about exactly its files,
        // checked on disk by the file layer against the registered manifest.
        if (e.presentation !== undefined) {
          const p = s.presentations?.[e.presentation]
          if (!p) fail('presentation-unknown', `presentation "${e.presentation}" does not exist in this run`)
          if (p!.state !== 'available') fail('presentation-unavailable', `presentation ${p!.id} is ${p!.state}; ask about it once it is served (wfe present start)`)
          const same = p!.files.every(f => q.subject!.some(x => x.path === f.path && x.sha256 === f.sha256))
          if (!same) fail('presentation-changed', `the files of presentation ${p!.id} differ from its manifest; register the result again`)
          q.presentation = { id: p!.id, revision: p!.revision }
        }
        // An external output (project_migration p6): its manifest, by hash,
        // is a subject; the file layer verified the payload against it in
        // full just before (an earlier failed check does not block a repaired one).
        if (e.output !== undefined) {
          const o = s.outputs?.[e.output]
          if (!o) fail('output-unknown', `output "${e.output}" does not exist in this run`)
          if (!q.subject.some(x => x.path === o!.file)) fail('output-unverified', `the manifest ${o!.file} of output ${o!.id} is not among the subjects`)
          q.output = { id: o!.id, digest: o!.digest }
        }
        // With a presentation, the subjects are exactly its files (and an
        // output's manifest, when one is presented with it).
        if (q.presentation) {
          const p = s.presentations![q.presentation.id]
          const extra = q.subject.filter(x => !p.files.some(f => f.path === x.path) && x.path !== (q.output ? s.outputs![q.output.id].file : null))
          if (extra.length) fail('presentation-changed', `${extra.map(x => x.path).join(', ')} ${extra.length === 1 ? 'is' : 'are'} not in presentation ${p.id}; present loose files without a presentation`)
        }
      } else if (e.subject !== undefined || e.presentation !== undefined || e.output !== undefined) fail('shape', 'only a question from the result-confirmation node presents deliverables')
      if (e.node !== undefined && e.node !== null) {
        const n = node(e.node)
        if (n.state !== 'running') fail('state', `node "${e.node}" is ${n.state}; a question waits from a running node${n.state === 'waiting' ? ' (it already waits on something)' : ''}`)
        n.wait = { reason: `question ${q.id}`, holder: q.to, on: { question: q.id } }
        move(e.node, 'waiting')
      }
      s.questions[q.id] = q
      change.question = [null, q.id]
      break
    }
    case 'question.answer': {
      const q = question(e.question)
      if (q.withdrawn) fail('question-closed', `question ${q.id} was withdrawn`)
      if (q.takenUp) fail('question-closed', `the answer to ${q.id} was already taken up; ask a new question`)
      const answer: Answer = { text: text(e.text, 'the answer'), from: optText(e.from, 'from').trim() || by, by, at, via: e.via }
      if (e.source !== undefined) answer.source = sourceOf(e.source)
      if (e.delegation !== undefined && e.delegation !== null) {
        const dl = e.delegation as unknown as Record<string, unknown>
        if (!isObj(dl) || typeof dl.uid !== 'string' || !dl.uid || typeof dl.answer !== 'number' || !Number.isInteger(dl.answer) || dl.answer < 1) fail('shape', 'delegation is {uid, answer}: the delegation and which of its answers this is')
        if (s.input.entrustedBy?.kind !== 'delegation' || s.input.entrustedBy.delegation !== dl.uid) fail('delegate-relation', `this run was not created from delegation ${String(dl.uid)}; an answer for that delegation does not belong here`)
        answer.delegation = { uid: dl.uid as string, answer: dl.answer as number }
      }
      q.answers.push(answer)
      change.question = [q.id, 'answered']
      if (q.node) s.nodes[q.node].updated = at
      break
    }
    case 'question.take-up': {
      live()
      const q = question(e.question)
      if (q.withdrawn || q.takenUp) fail('question-closed', `question ${q.id} is ${questionState(q)}`)
      if (!q.answers.length) fail('no-answer', `question ${q.id} has no answer to take up`)
      const index = e.answer ?? q.answers.length - 1
      if (!Number.isInteger(index) || index < 0 || index >= q.answers.length) fail('shape', `question ${q.id} has no answer ${index}`)
      q.takenUp = { by, at, answer: index }
      change.question = [q.id, 'taken-up']
      resumeFrom(q)
      break
    }
    case 'question.withdraw': {
      live()
      const q = question(e.question)
      if (q.withdrawn || q.takenUp) fail('question-closed', `question ${q.id} is ${questionState(q)}`)
      q.withdrawn = { by, at, reason: text(e.reason, 'the reason') }
      change.question = [q.id, 'withdrawn']
      resumeFrom(q)
      break
    }
    case 'instruction.receive': {
      // Received, not read: no node changes, nothing is interrupted. On a
      // completed run it is kept for an attempt that reopens work; nothing
      // continues the run for it (server/exec.ts afterInstruction).
      live()
      const all = s.instructions ?? {}
      const id = e.instruction || `i${Object.keys(all).length + 1}`
      if (!INSTRUCTION_ID.test(id)) fail('shape', `instruction id "${id}" must match ${INSTRUCTION_ID.source}`)
      if (id in all) fail('instruction-exists', `instruction ${id} already exists`)
      const ins: Instruction = { id, text: text(e.text, 'the instruction'), from: text(e.from, 'whose instruction it is (from)'), by, at, via: e.via, during: Object.keys(s.nodes).filter(n => s.nodes[n].state === 'running').sort(), ack: null }
      if (e.source !== undefined) ins.source = sourceOf(e.source)
      s.instructions = { ...all, [id]: ins }
      change.instruction = [null, id]
      break
    }
    case 'instruction.ack': {
      live()
      if (!(INSTRUCTION_RESPONSES as readonly string[]).includes(e.response)) fail('shape', `response must be one of ${INSTRUCTION_RESPONSES.join(', ')}`)
      const ids = Array.isArray(e.instructions) ? [...new Set(e.instructions)] : []
      if (!ids.length) fail('missing', 'name the instructions acknowledged')
      const note = text(e.note, 'what you will do about it (the note)')
      const all = { ...(s.instructions ?? {}) }
      for (const id of ids) {
        const ins = all[id]
        if (!ins) fail('instruction-unknown', `instruction "${id}" does not exist in this run`)
        if (ins.ack) fail('instruction-acknowledged', `instruction ${id} was already acknowledged (${ins.ack.response}) by ${ins.ack.by} at ${ins.ack.at}`)
        all[id] = { ...ins, ack: { by, at, attempt: e.attempt ?? null, response: e.response, note } }
      }
      s.instructions = all
      change.instruction = [ids.join(','), 'acknowledged']
      break
    }
    case 'artifact.attach': {
      const path = validArtifactPath(e.path)
      if (e.node !== undefined && e.node !== null) node(e.node).updated = at
      s.artifacts.push({ path, node: e.node ?? null, title: optText(e.title, 'title'), by, at })
      break
    }
    case 'run.cancel': {
      live()
      const reason = text(e.reason, 'the reason')
      const why = because(e.because)
      s.cancelled = { reason, at, by, ...(why ? { because: why } : {}) }
      // Open delegations close with the parent (p10); their children are
      // not cancelled by this — that is an explicit act of its own.
      for (const d of Object.values(s.delegations ?? {})) if (isOpenDelegation(d)) d.closed = { at, by, reason: `the parent run was cancelled: ${reason}; the child ${d.child ? `${d.child.workflow}/${d.child.run} in ${d.child.project}` : '(not created yet)'} is left as it is` }
      for (const [id, n] of Object.entries(s.nodes)) {
        if (n.state === 'pending' || n.state === 'running' || n.state === 'waiting') {
          n.cancellation = { reason: `run cancelled: ${reason}`, at, by }
          n.wait = null; n.ended = at
          move(id, 'cancelled')
        }
      }
      break
    }
    case 'attempt.begin': {
      live()
      if (typeof e.attempt !== 'string' || !/^a[0-9a-z-]{1,64}$/.test(e.attempt)) fail('shape', 'attempt id must match a[0-9a-z-]+')
      if (ctl.attempt) fail('attempt-open', `attempt ${ctl.attempt.id} is still open; it ends before another begins`)
      if (ctl.hold) fail('held', `the run is held (${ctl.hold.kind}: ${ctl.hold.reason}); a person resumes it first (run.resume)`)
      if (ctl.stop) fail('held', 'a stop was requested; nothing begins until it is confirmed and the run is resumed')
      ctl.attempt = { id: e.attempt, reason: text(e.reason, 'the reason'), began: at, backend: optText(e.backend, 'backend') || null }
      if (e.settings !== undefined) ctl.attempt.settings = attemptSettings(e.settings)
      ctl.attempts++
      // The attempt's session (agent_session p1): a resumed one must be the
      // run's current session; a new one supersedes it.
      const ss = ctl.attempt.settings?.session
      if (ss) {
        const cur = currentSession(s)
        if (ss.mode === 'resume') {
          if (!cur || cur.id !== ss.id) fail('session-mismatch', `attempt ${e.attempt} resumes session ${ss.id}, but the run's current session is ${cur ? cur.id ?? '(id not known)' : 'none'}`)
          cur!.attempts.push(e.attempt)
        } else {
          if (ss.id && s.sessions?.some(x => x.id === ss.id)) fail('session-mismatch', `session ${ss.id} already belongs to this run; a new session has a new id`)
          if (cur) { cur.state = 'replaced'; cur.ended = { at, by, reason: ss.replaces?.reason ?? (ss.policy === 'fresh' ? 'fresh policy: every attempt starts a new session' : 'replaced by a new session') } }
          const st = ctl.attempt.settings!
          s.sessions = [...(s.sessions ?? []), { id: ss.id, policy: ss.policy, began: at, attempt: e.attempt, attempts: [e.attempt], config: sessionConfig(st), state: 'open' }]
        }
      }
      break
    }
    case 'attempt.session': {
      live()
      if (!ctl.attempt || ctl.attempt.id !== e.attempt) fail('attempt-stale', `attempt ${String(e.attempt)} is not open (${ctl.attempt ? `${ctl.attempt.id} is` : 'none is'}); its session is recorded only while it is open`)
      const cur = currentSession(s)
      if (!cur || !cur.attempts.includes(e.attempt)) fail('session-mismatch', `attempt ${e.attempt} has no session recorded with it`)
      const id = e.id === null || e.id === undefined ? null : typeof e.id === 'string' && SESSION_ID.test(e.id) ? e.id : fail('shape', `session id must match ${SESSION_ID.source}`)
      if (e.event === 'attached') {
        if (!id) fail('shape', 'an attached session names the id the harness reported')
        cur!.attached = id!
        cur!.attachedIn = e.attempt
        if (!cur!.id) cur!.id = id // a harness that chooses its own ids
        else if (cur!.id !== id) cur!.mismatch = true
      } else if (e.event === 'replaced') {
        // Only before anything ran in it: the resumed session is missing on
        // the host, so this attempt starts a new one instead.
        if (cur!.attempts.at(-1) !== e.attempt || cur!.attachedIn === e.attempt) fail('state', `session ${cur!.id} is attached to attempt ${e.attempt}; it is not replaced now`)
        if (id && s.sessions?.some(x => x.id === id)) fail('session-mismatch', `session ${id} already belongs to this run`)
        const reason = text(e.reason, 'the reason for the replacement')
        cur!.attempts.pop()
        cur!.state = 'replaced'; cur!.ended = { at, by, reason }
        const st = ctl.attempt!.settings!
        s.sessions!.push({ id, policy: cur!.policy, began: at, attempt: e.attempt, attempts: [e.attempt], config: sessionConfig(st), state: 'open' })
        if (st.session) { const { reconstruct: _, ...rest } = st.session; st.session = { ...rest, mode: 'new', id, replaces: { id: cur!.id, reason } } }
      } else fail('shape', 'event must be attached or replaced')
      break
    }
    case 'attempt.context': {
      live()
      if (!ctl.attempt || ctl.attempt.id !== e.attempt) fail('attempt-stale', `attempt ${String(e.attempt)} is not open (${ctl.attempt ? `${ctl.attempt.id} is` : 'none is'}); its context delivery is recorded only while it is open`)
      const c = ctl.attempt!.settings?.context
      if (!c) fail('state', `attempt ${e.attempt} was not prepared with a context bundle`)
      if (c!.snapshot !== e.snapshot) fail('shape', `attempt ${e.attempt} was prepared with snapshot ${c!.snapshot}, not ${String(e.snapshot)}`)
      if (e.event !== 'delivered' && e.event !== 'undelivered') fail('shape', 'event must be delivered or undelivered')
      optText(e.detail, 'detail')
      break
    }
    case 'session.retire': {
      live()
      if (ctl.attempt) fail('attempt-open', `attempt ${ctl.attempt.id} is still open; a session is retired between attempts`)
      const cur = currentSession(s)
      if (!cur) fail('state', 'the run has no current session')
      const reason = text(e.reason, 'the reason')
      const why = because(e.because)
      cur!.state = 'retired'; cur!.ended = { at, by, reason: why ? `${reason} (${why.kind === 'answer' ? `answer ${why.answer} to ${why.question}` : `instruction ${why.instruction}`} from ${why.from})` : reason }
      break
    }
    case 'attempt.end': {
      if (!ctl.attempt || ctl.attempt.id !== e.attempt) fail('attempt-stale', `attempt ${String(e.attempt)} is not open (${ctl.attempt ? `${ctl.attempt.id} is` : 'none is'})`)
      if (!(ATTEMPT_OUTCOMES as readonly string[]).includes(e.outcome)) fail('shape', `outcome must be one of ${ATTEMPT_OUTCOMES.join(', ')}`)
      const detail = optText(e.detail, 'detail')
      if (e.explain !== undefined && e.explain !== 'cause') fail('shape', 'explain is "cause" or absent')
      // An exit is a normal end only when nothing is left as running and
      // the remaining work waits on someone; anything else needs a person to
      // look and resume (side effects may have happened after the last record).
      // Ready work beside a wait is left for the attempt the wait's answer
      // starts, on entries that say so (`waits: defer-ready`, written since
      // project_migration p8: agsfx create/run-002 and front converse/run-002
      // asked, ended, and were held interrupted for their report steps, so the
      // answer could not continue them). Older entries replay as decided.
      const ex = summarize(s, graph)
      let outcome: AttemptOutcome = e.outcome
      let why = detail
      let cause: HoldCause | undefined = outcome === 'unknown' ? { code: 'lost' } : outcome === 'interrupted' ? { code: 'process', detail: detail || 'the process did not end normally' } : undefined
      const deferred = e.waits === 'defer-ready' && ex.waiting.length > 0
      if (outcome === 'exited' && !s.cancelled && ex.state === 'in-progress' && (ex.active.length || (ex.ready.length && !deferred))) {
        outcome = 'interrupted'
        why = `the executor exited with ${ex.active.length ? `${ex.active.join(', ')} recorded as running` : `${ex.ready.join(', ')} ready and nothing waiting`}${detail ? `; ${detail}` : ''}`
        cause = ex.active.length ? { code: 'left-running', nodes: ex.active } : { code: 'left-ready', nodes: ex.ready }
      }
      // An attempt after which nothing of the run's work is recorded (p8 ex1,
      // new entries only): the work it did is in no record.
      if (e.explain === 'cause' && outcome === 'exited' && !s.cancelled && ex.state === 'not-started' && ex.ready.length && !Object.values(s.delegations ?? {}).length && !Object.values(s.questions).some(q => !q.takenUp && !q.withdrawn)) {
        outcome = 'interrupted'
        why = `the executor exited with nothing of the run's work recorded (${ex.ready.join(', ')} never started)${detail ? `; ${detail}` : ''}`
        cause = { code: 'nothing-recorded', nodes: ex.ready }
      }
      // A child's fact that was waiting for this attempt and was not taken
      // up (p10): like work left ready. One that arrived during it queues
      // the next attempt instead.
      const missedEvents = Object.values(s.delegations ?? {}).filter(isOpenDelegation).flatMap(d => pendingEvents(d).filter(x => x.during !== e.attempt).map(x => ({ delegation: d.id, n: x.n, type: x.type })))
      const missed = missedEvents.map(x => `${x.delegation} ${x.type} #${x.n}`)
      if (outcome === 'exited' && !s.cancelled && missed.length) {
        outcome = 'interrupted'
        why = `the executor exited without taking up delegation event${missed.length === 1 ? '' : 's'} ${missed.join(', ')}${detail ? `; ${detail}` : ''}`
        cause = { code: 'missed-event', events: missedEvents }
      }
      if (ctl.stop && outcome !== 'unknown') outcome = 'stopped'
      ctl.last = { id: ctl.attempt!.id, outcome, ended: at, detail: why, backend: ctl.attempt!.backend }
      ctl.attempt = null
      // A stop is the person's: the hold names who stopped and why.
      if (!s.cancelled && outcome !== 'exited') ctl.hold = outcome === 'stopped' && ctl.stop ? { kind: 'stopped', since: at, by: ctl.stop.by, reason: ctl.stop.reason, ...(ctl.stop.because ? { because: ctl.stop.because } : {}) } : { kind: outcome as HoldKind, since: at, by, reason: why || outcome, ...(e.explain === 'cause' && cause && outcome !== 'stopped' ? { cause } : {}) }
      ctl.stop = null
      break
    }
    case 'run.stop': {
      live()
      const reason = text(e.reason, 'the reason')
      if (ctl.hold?.kind === 'stopped' || ctl.stop) fail('state', 'the run is already stopped or stopping')
      const why = because(e.because)
      if (ctl.attempt) ctl.stop = { at, by, reason, ...(why ? { because: why } : {}) } // confirmed by the attempt's end
      else ctl.hold = { kind: 'stopped', since: at, by, reason, ...(why ? { because: why } : {}) }
      break
    }
    case 'run.recover': {
      // Only the holds the executor derived from how a process ended. A
      // person's stop, a pending stop and a cancellation stay binding.
      live()
      const held = ctl.hold
      if (ctl.attempt) fail('attempt-open', `attempt ${ctl.attempt.id} is still open`)
      if (held?.kind === 'stopped') fail('recover-human-hold', `the run is held by ${held.by} (stopped: ${held.reason}); a recovery never lifts a person's hold`)
      if (typeof e.incident !== 'string' || !INCIDENT_ID.test(e.incident)) fail('shape', `incident "${String(e.incident)}" must match ${INCIDENT_ID.source}`)
      const lastAttempt = ctl.last?.id ?? 'none'
      if (lastAttempt !== e.attempt) fail('recover-stale', `the run's last attempt is ${lastAttempt}, not ${String(e.attempt)}; the recovery was decided on another episode`)
      const unverified = unverifiedSession(s)
      if (unverified) fail('session-mismatch', unverifiedReason(unverified, runKey({ workflow: s.workflow, run: s.run })))
      if (!held) {
        // An unowned continuation: no hold, and work that only the executor
        // can take up — ready work, a node recorded as running, an answer
        // recorded and not taken up, or a run never started. (Whether a job
        // is queued is the execution host's fact: ExecStore.recover checks it.)
        const answered = s.execution.waiting.some(w => 'question' in w.on && (() => { const q = s.questions[w.on.question]; return !!q && q.answers.length > 0 && !q.takenUp && !q.withdrawn })())
        const relayed = Object.values(s.delegations ?? {}).some(d => isOpenDelegation(d) && pendingEvents(d).length > 0)
        if (!s.execution.ready.length && !s.execution.active.length && !answered && !relayed && s.execution.state !== 'not-started') fail('state', 'the run is not held and nothing in it waits for the executor; there is nothing to recover')
      }
      const reason = text(e.reason, 'the reason for the recovery')
      let agent: RecoveryAgent | undefined
      if (e.agent !== undefined && e.agent !== null) {
        const a = e.agent as unknown as Record<string, unknown>
        if (!isObj(a) || ![a.workspace, a.workflow, a.run, a.attempt].every(v => typeof v === 'string' && v)) fail('shape', 'agent is {workspace, workflow, run, attempt}: the recovering agent\'s own run and attempt')
        agent = { workspace: a.workspace as string, workflow: a.workflow as string, run: a.run as string, attempt: a.attempt as string }
      }
      s.recoveries = [...(s.recoveries ?? []), { seq: e.seq, at, by, incident: e.incident, attempt: e.attempt, lifted: held?.kind ?? null, reason, ...(agent ? { agent } : {}) }]
      ctl.hold = null
      break
    }
    case 'run.resume': {
      live()
      if (ctl.attempt) fail('attempt-open', `attempt ${ctl.attempt.id} is still open`)
      const unverified = unverifiedSession(s)
      if (unverified) fail('session-mismatch', unverifiedReason(unverified, runKey({ workflow: s.workflow, run: s.run })))
      text(e.reason, 'the resume instruction')
      because(e.because)
      if (e.profile !== undefined && e.profile !== null) {
        if (typeof e.profile !== 'string' || !PROFILE_PATTERN.test(e.profile)) fail('shape', `profile "${String(e.profile)}" is not a profile name (${PROFILE_PATTERN.source})`)
        const previous = ctl.profile?.name ?? null // null: the definition's
        ctl.profile = { name: e.profile, seq: e.seq, at, by, previous }
      }
      ctl.hold = null
      break
    }
    case 'run.decide': {
      if (e.decision !== 'accepted' && e.decision !== 'rejected') fail('shape', 'decision must be accepted or rejected')
      if (e.question === undefined || e.question === null) {
        // The person's own decision (browser, CLI).
        s.decisions.push({ decision: e.decision, by, at, evidence: text(e.evidence, 'the evidence'), note: optText(e.note, 'note'), ...revisionOf(e) })
        break
      }
      // The decision the person's answer to the result-confirmation question
      // is (p6), recorded by the executor that took it up. It may precede the
      // execution's completion; the two stay separate facts.
      live()
      if (ctl.attempt && e.attempt !== ctl.attempt.id) fail(e.attempt ? 'attempt-stale' : 'attempt-required', `attempt ${ctl.attempt.id} is executing this run; the decision it records from a confirmation carries its id`)
      if (!ctl.attempt && e.attempt) fail('attempt-stale', `attempt ${e.attempt} is not open`)
      const q = question(e.question)
      const confirming = q.node ? graph.nodes[q.node]?.confirms === 'result' : false
      if (!confirming) fail('not-result-confirmation', `question ${q.id} was ${q.node ? `asked from ${q.node}` : 'asked from no node'}, which does not confirm the result${q.node && stepOf(graph, q.node)?.kind === 'plan' ? ' (plan agreement is not acceptance of the result)' : ''}; only the result-confirmation question's answer becomes a decision`)
      // The latest question from any result-confirmation node (p7: a
      // correction adds a new confirming node; the old one keeps its meaning).
      const latest = Object.values(s.questions).filter(x => x.node && graph.nodes[x.node]?.confirms === 'result').at(-1)!
      if (latest.id !== q.id) fail('not-result-confirmation', `question ${latest.id} was asked after ${q.id}; the decision is the answer to the latest confirmation question`)
      const taken = q.takenUp
      if (!taken) return fail('no-answer', `question ${q.id} is ${questionState(q)}; a decision is an answer that was taken up`)
      const index = e.answer ?? taken.answer
      if (index !== taken.answer) fail('shape', `answer ${index} of ${q.id} was not the one taken up (${taken.answer})`)
      if (s.decisions.some(d => d.confirmation?.question === q.id)) fail('decision-exists', `a decision from ${q.id} is already recorded`)
      // An answer about one presentation never accepts a later one (p7).
      if (q.presentation) {
        const later = Object.values(s.presentations ?? {}).filter(p => presentationNumber(p.id) > presentationNumber(q.presentation!.id)).map(p => p.id)
        if (later.length) fail('presentation-superseded', `${q.id} asked about presentation ${q.presentation.id}; ${later.join(', ')} ${later.length === 1 ? 'was' : 'were'} registered after it. Ask about the latest presentation`)
      }
      // An answer about one output never accepts a later output of the same
      // candidate (project_migration p6): a replaced result is a new revision.
      if (q.output) {
        const asked = s.outputs?.[q.output.id]
        const later = Object.values(s.outputs ?? {}).filter(o => asked && o.candidate === asked.candidate && outputNumber(o.id) > outputNumber(asked.id)).map(o => o.id)
        if (later.length) fail('output-superseded', `${q.id} asked about output ${q.output.id}; ${later.join(', ')} of the same candidate ${later.length === 1 ? 'was' : 'were'} published after it. Ask about the latest output`)
      }
      const now = (e.subject ?? []).map((d, i) => subjectOf(d, `subject ${i + 1}`))
      const asked = q.subject ?? []
      const changed = asked.filter(a => !now.some(n => n.path === a.path && n.sha256 === a.sha256))
      if (changed.length) fail('subject-changed', `${changed.map(c => c.path).join(', ')} changed since ${q.id} presented ${changed.length === 1 ? 'it' : 'them'}; present the current deliverables again`)
      const a = q.answers[index]
      // A delegated child (p10): the parent's agent accepts only when the
      // delegate node granted it (accepts: parent); otherwise acceptance is
      // the parent's person's, relayed with their words.
      s.decisions.push({
        decision: e.decision, by, at, note: optText(e.note, 'note'),
        evidence: optText(e.evidence, 'evidence') || `${q.id} answer ${index} from ${a.from}${a.source ? ` (${sourceLabel(a.source)})` : ''}, confirming ${q.output ? `output ${q.output.id} (${q.output.digest.slice(7, 19)})${q.presentation ? ` and presentation ${q.presentation.id}` : ''}` : q.presentation ? `presentation ${q.presentation.id} (revision ${q.presentation.revision.slice(7, 19)}, ${asked.length} files)` : asked.map(x => `${x.path} (${x.sha256.slice(0, 12)})`).join(', ')}`,
        confirmation: { question: q.id, answer: index, from: a.from, ...(a.source ? { source: a.source } : {}), subject: asked, ...(q.presentation ? { presentation: q.presentation } : {}), ...(q.output ? { output: q.output } : {}) },
        ...revisionOf(e),
      })
      break
    }
    case 'run.relocate': {
      if (s.storage) fail('state', `the run already has its own working copy (${s.storage.branch})`)
      if (ctl.attempt) fail('attempt-open', `attempt ${ctl.attempt.id} is still open; a run moves only while nothing executes it`)
      text(e.note, 'a note on what moved')
      s.storage = validStorage(e.storage)
      break
    }
    case 'run.assign': {
      if (ctl.attempt) fail('attempt-open', `attempt ${ctl.attempt.id} is still open; a run changes its execution node only between attempts`)
      const node = text(e.node, 'the execution node')
      if (!NODE_PATTERN.test(node)) fail('shape', `node "${node}" must match ${NODE_PATTERN.source}`)
      const previous = s.executor.node ?? null
      if (previous === node) fail('state', `the run is already assigned to ${node}`)
      s.executor = { ...s.executor, node }
      s.assignments = [...(s.assignments ?? []), { node, previous, at, by, reason: text(e.reason, 'the reason'), seq: e.seq }]
      break
    }
    case 'run.integrate': {
      // Recorded once every repository's integration is done (p9); partial
      // progress is the execution host's journal, not this record.
      if ((s.integrations ?? []).some(i => i.decision === e.decision)) fail('state', `decision ${e.decision} is already integrated`)
      if (!Array.isArray(e.repositories) || !e.repositories.length) fail('shape', 'repositories must list each integrated repository')
      const repositories = e.repositories.map((r, i) => {
        if (!isObj(r) || !normalizeRepoPath(String(r.path)) || ![r.target, r.observed, r.candidate, r.result].every(v => typeof v === 'string' && v) || !['already', 'fast-forward', 'merge'].includes(r.method)) fail('shape', `repositories[${i}] needs path, target, observed, candidate, method and result`)
        return { path: r.path, target: r.target, observed: r.observed, candidate: r.candidate, method: r.method, result: r.result }
      })
      s.integrations = [...(s.integrations ?? []), { decision: e.decision as number, at, by, repositories }]
      break
    }
    case 'presentation.register': {
      live()
      const n = node(e.node)
      if (n.state !== 'running') fail('state', `node "${e.node}" is ${n.state}; a presentation is registered from a running node`)
      const all = s.presentations ?? {}
      const id = e.presentation || `p${Object.keys(all).length + 1}`
      if (!PRESENTATION_ID.test(id)) fail('shape', `presentation id "${id}" must match ${PRESENTATION_ID.source}`)
      if (id in all) fail('presentation-exists', `presentation ${id} already exists`)
      const m = manifestOf(e.manifest, presentationFolder(s, id))
      const p: Presentation = { id, node: e.node, title: text(e.title, 'the title'), folder: presentationFolder(s, id), ...m, registered: { at, by, attempt: e.attempt ?? null }, state: 'registered', instance: null, last: null }
      s.presentations = { ...all, [id]: p }
      n.updated = at
      change.presentation = [id, null, 'registered']
      break
    }
    case 'input.select': {
      // An input set (project_migration p6): the files a reference held when
      // the file layer read and hashed them, by manifest. A later selection
      // of the same reference is a new set; nothing replaces one.
      live()
      const n = node(e.node)
      if (n.state !== 'running') fail('state', `node "${e.node}" is ${n.state}; input is selected from a running node`)
      const r = typeof e.ref === 'string' ? parseRef(e.ref) : null
      if (!r) fail('shape', `"${String(e.ref)}" is not a shared:// reference`)
      if (!STAGINGS.includes(e.staging)) fail('shape', `staging is ${STAGINGS.join(' or ')}`)
      const all = s.inputs ?? {}
      const id = e.input || `i${Object.keys(all).length + 1}`
      if (!INPUT_ID.test(id)) fail('shape', `input id "${id}" must match ${INPUT_ID.source}`)
      if (id in all) fail('input-exists', `input set ${id} already exists`)
      const m = e.manifest
      if (!isObj(m) || m.file !== `${runFolder(s)}/inputs/${id}.json` || typeof m.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(m.digest) || !Number.isInteger(m.count) || m.count < 1 || !Number.isInteger(m.bytes) || m.bytes < 0) fail('input-missing', 'an input set needs the manifest the file layer writes (wfe run input reads and hashes the files first)')
      s.inputs = { ...all, [id]: { id, ref: r!.ref, node: e.node, file: m!.file, digest: m!.digest, count: m!.count, bytes: m!.bytes, staging: e.staging, selected: { at, by, attempt: e.attempt ?? null }, last: { at, by, status: 'verified', detail: e.staging === 'copy' ? 'staged and verified' : 'read and hashed in place' } } }
      n.updated = at
      break
    }
    case 'output.publish': {
      // An external output (project_migration p6): a finished publication
      // folder on a share, by manifest; the payload stays outside Git.
      live()
      const n = node(e.node)
      if (n.state !== 'running') fail('state', `node "${e.node}" is ${n.state}; an output is published from a running node`)
      const all = s.outputs ?? {}
      const id = e.output || `o${Object.keys(all).length + 1}`
      if (!OUTPUT_ID.test(id)) fail('shape', `output id "${id}" must match ${OUTPUT_ID.source}`)
      if (id in all) fail('output-exists', `output ${id} already exists`)
      if (typeof e.candidate !== 'string' || !CANDIDATE.test(e.candidate)) fail('shape', `candidate "${String(e.candidate)}" must match ${CANDIDATE.source}`)
      const r = typeof e.ref === 'string' ? parseRef(e.ref) : null
      if (!r || !r.folder) fail('output-missing', 'an output names its publication folder on a share (the file layer publishes it first)')
      const m = e.manifest
      if (!isObj(m) || m.file !== `${runFolder(s)}/outputs/${id}.json` || typeof m.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(m.digest) || !Number.isInteger(m.count) || m.count < 1 || !Number.isInteger(m.bytes) || m.bytes < 0 || !Array.isArray(m.inputs)) fail('output-missing', 'an output needs the manifest the file layer writes (wfe run publish copies and verifies the files first)')
      for (const d of m!.inputs) if (!Object.values(s.inputs ?? {}).some(i => i.digest === d)) fail('input-unknown', `input digest ${String(d).slice(0, 19)}… is not an input set of this run`)
      s.outputs = { ...all, [id]: { id, ref: r!.ref, node: e.node, title: text(e.title, 'the title'), candidate: e.candidate, file: m!.file, digest: m!.digest, count: m!.count, bytes: m!.bytes, inputs: [...m!.inputs], published: { at, by, attempt: e.attempt ?? null }, last: { at, by, status: 'verified', detail: 'published and verified' } } }
      n.updated = at
      break
    }
    case 'input.observe':
    case 'output.observe': {
      // What a check on this host found about the bytes (a host fact, not
      // an execution report): verified, changed or missing.
      const which = e.op === 'input.observe' ? s.inputs?.[e.input] : s.outputs?.[e.output]
      if (!which) return fail(e.op === 'input.observe' ? 'input-unknown' : 'output-unknown', `${e.op === 'input.observe' ? `input set "${String(e.input)}"` : `output "${String(e.output)}"`} does not exist in this run`)
      if (!(SET_OBSERVATIONS as readonly string[]).includes(e.status)) fail('shape', `status must be one of ${SET_OBSERVATIONS.join(', ')}`)
      which.last = { at, by, status: e.status, detail: optText(e.detail, 'detail') }
      break
    }
    case 'run.adjust': {
      // A change of the run's future work (p7, docs/adjustments.md), at a
      // node boundary, authorized by the person's records.
      live()
      const source = adjustSource(e.source)
      if (ctl.attempt) {
        if (e.attempt !== ctl.attempt.id) fail(e.attempt ? 'attempt-stale' : 'attempt-open', `attempt ${ctl.attempt.id} is executing this run; only it adjusts the run meanwhile${source.kind === 'person' ? ' (a person\'s adjustment waits until no attempt is open)' : ''}`)
      } else if (e.attempt) fail('attempt-stale', `attempt ${e.attempt} is not open`)
      const revisions = s.definition.revisions ?? []
      const active = activeRevision(s.definition)
      if (e.parent !== active) fail('revision-outdated', `the adjustment was made from ${String(e.parent)}, but ${active} is in force; read the run again and adjust the current revision`)
      const id = `r${revisions.length + 2}`
      if (e.revision !== id) fail('shape', `the next revision is ${id}, not ${String(e.revision)}`)
      if (typeof e.file !== 'string' || e.file !== `definition/${id}/${s.workflow}.yaml`) fail('shape', `the revision file is definition/${id}/${s.workflow}.yaml`)
      if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) fail('shape', 'sha256 must be 64 hex digits')
      if (typeof e.definitionDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(e.definitionDigest)) fail('shape', 'definitionDigest must be sha256:<hex>')
      // At a node's completion (p8/ex2): that node may still be running —
      // its completion is the next entry — and nothing else may.
      const completing = e.completing
      if (completing !== undefined) {
        if (typeof completing !== 'string' || !(completing in s.nodes)) fail('node-unknown', `node "${String(completing)}" is not in this run's definition`)
        if (s.nodes[completing].state !== 'running') fail('state', `${completing} is ${s.nodes[completing].state}; an adjustment at a completion names the running node it completes`)
      }
      const next = e.effective
      if (!isObj(next) || !isObj(next.nodes) || !Array.isArray(next.edges) || typeof next.compiler !== 'string') fail('shape', 'the adjustment carries its whole compiled graph')
      const nodes = next.nodes as Record<string, RunGraph['nodes'][string]>
      const edges = next.edges as Edge[]
      for (const ed of edges) if (!(ed?.from in nodes) || !(ed?.to in nodes) || ed.from === ed.to) fail('adjust-graph', `edge ${String(ed?.from)} → ${String(ed?.to)} names an unknown node or loops`)
      const outs = new Map<string, string[]>()
      for (const ed of edges) outs.set(ed.from, [...(outs.get(ed.from) ?? []), ed.to])
      if (hasCycle(Object.keys(nodes), x => outs.get(x) ?? [])) fail('adjust-graph', 'the adjusted graph has a cycle')
      for (const [nid, n] of Object.entries(nodes)) if (n.type === 'delegate' && !n.workflow) fail('adjust-graph', `delegate node "${nid}" names no target workflow`)
      for (const nid of Object.keys(nodes)) if (!(nid.startsWith('_') ? /^_[a-z0-9_.-]+$/.test(nid) : ID_PATTERN.test(nid))) fail('adjust-graph', `node id "${nid}" is invalid`)
      // An explicitly cited source is provenance, never authority. Agent
      // revisions need no citation; a named request still names actual bytes.
      if (source.kind === 'request') {
        if (source.input !== s.input.file || !s.input.sha256 || source.sha256 !== s.input.sha256) fail('adjust-source', 'the request citation does not identify the original input; use source kind agent for an agent-selected revision')
      }
      const diff = graphDiff(graph, { nodes, edges })
      const rev: Revision = { revision: id, parent: active, file: e.file, sha256: e.sha256, definitionDigest: e.definitionDigest, effective: next as EffectiveGraph, reason: text(e.reason, 'the reason'), source, diff, at, by }
      s.definition = { ...s.definition, active: id, revisions: [...revisions, rev] }
      // Unchanged nodes keep their records; new work starts pending; removed
      // (pending) work leaves the state, its history stays as it was.
      for (const nid of Object.keys(s.nodes)) if (!(nid in nodes)) delete s.nodes[nid]
      for (const nid of Object.keys(nodes).sort()) if (!(nid in s.nodes)) s.nodes[nid] = emptyNode()
      s.nodes = Object.fromEntries(Object.keys(s.nodes).sort().map(k2 => [k2, s.nodes[k2]]))
      change.revision = [active, id]
      graph = { nodes, edges }
      break
    }
    case 'presentation.observe': {
      // A fact this host observed about a serving instance: not an
      // execution report, not fenced by an attempt. After a cancellation
      // only the shutdown is still recorded.
      const p = s.presentations?.[e.presentation]
      if (!p) return fail('presentation-unknown', `presentation "${String(e.presentation)}" does not exist in this run`)
      if (!(OBSERVATIONS as readonly string[]).includes(e.status)) fail('shape', `status must be one of ${OBSERVATIONS.join(', ')}`)
      if (e.status === 'available' || e.status === 'failed') {
        live()
      }
      if (e.status === 'failed' && p.state === 'available') fail('state', `presentation ${p.id} is available (instance ${p.instance}); a failed start does not replace it`)
      const instance = optText(e.instance, 'instance') || null
      if (e.status === 'available' && !instance) fail('missing', 'an available presentation names its serving instance')
      if (instance && !/^pi-[0-9a-z-]{4,64}$/.test(instance)) fail('shape', 'an instance id is pi-<letters and digits>')
      const before = p.state
      const next: Presentation = { ...p, state: e.status, instance: instance ?? p.instance, last: { at, by, status: e.status, detail: optText(e.detail, 'detail') } }
      s.presentations = { ...s.presentations, [p.id]: next }
      change.presentation = [p.id, before, e.status]
      break
    }
    case 'delegation.dispatch': {
      // The parent's agent entrusts its running delegate node's work to
      // another workflow (p10). The file layer resolved the target and wrote
      // the request; here, identity, the node and the one open delegation.
      live()
      const n = node(e.node)
      const gn = graph.nodes[e.node]
      if (gn?.type !== 'delegate') fail('state', `node "${e.node}" is ${gn?.type ?? 'unknown'}; only a delegate node dispatches`)
      const all = s.delegations ?? {}
      const id = `d${Object.keys(all).length + 1}`
      if (e.delegation !== id) fail('shape', `the next delegation is ${id}, not ${String(e.delegation)}`)
      if (typeof e.uid !== 'string' || !e.uid.endsWith(`/${id}`) || !e.uid.startsWith(`${s.project}/${s.workflow}/${s.run}#`)) fail('shape', `the delegation uid is <this run's uid>/${id}`)
      const t = e.target as unknown as Record<string, unknown>
      if (!isObj(t) || ![t.project, t.workflow].every(v => typeof v === 'string' && ID_PATTERN.test(v)) || typeof t.workspace !== 'string' || !t.workspace) fail('shape', 'target is {project, workflow, workspace}')
      if (t.project !== (gn!.project ?? s.project) || t.workflow !== gn!.workflow) fail('delegate-target', `${e.node} delegates to ${gn!.project ?? s.project}/${gn!.workflow}, not ${String(t.project)}/${String(t.workflow)}`)
      const mine = Object.values(all).filter(d => d.node === e.node)
      const open = mine.find(isOpenDelegation)
      if (open) fail('delegation-open', `${e.node} already has delegation ${open.id} (${open.child ? `child ${open.child.workflow}/${open.child.run}` : 'not bound yet'}); one child per delegate node: judge or abandon it first (wfe delegate dispose)`)
      if (mine.length && e.predecessor !== mine.at(-1)!.id) fail('delegation-predecessor', `${e.node} delegated before (${mine.at(-1)!.id}, ${mine.at(-1)!.disposition?.kind ?? 'closed'}); a replacement names it as its predecessor (--replaces ${mine.at(-1)!.id})`)
      if (!mine.length && e.predecessor !== undefined && e.predecessor !== null) fail('delegation-predecessor', `${e.node} has no earlier delegation to replace`)
      if (n.state !== 'running') fail('state', `node "${e.node}" is ${n.state}; a delegate node dispatches while it is running (start it first)`)
      const folder = `${runFolder(s)}/delegations/${id}`
      const request = evidence(e.request, `dispatching ${id}`, `${folder}/request.md`)
      const original = e.original !== undefined && e.original !== null ? evidence(e.original, `dispatching ${id}`, `${folder}/original-input.md`) : undefined
      const d: Delegation = {
        id, uid: e.uid, node: e.node, target: { project: t.project as string, workflow: t.workflow as string, workspace: t.workspace as string },
        ...(typeof e.targetDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(e.targetDigest) ? { targetDigest: e.targetDigest } : {}),
        request, ...(original ? { original } : {}),
        requester: s.executor.name, onBehalfOf: optText(e.onBehalfOf, 'onBehalfOf').trim() || null, accepts: gn!.accepts === 'parent' ? 'parent' : 'person',
        dispatched: { at, by, attempt: e.attempt ?? null, seq: e.seq }, ...(e.predecessor ? { predecessor: e.predecessor } : {}),
        child: null, transport: null, events: [], answers: [], instructions: [], disposition: null, closed: null,
      }
      s.delegations = { ...all, [id]: d }
      n.wait = { reason: `delegation ${id} to ${d.target.project}/${d.target.workflow}`, holder: `${d.target.project}/${d.target.workflow}`, on: { delegation: id } }
      move(e.node, 'waiting')
      break
    }
    case 'delegation.bind': {
      // The intake created the child from the request post (p10).
      live()
      const d = delegation(e.delegation)
      if (!isOpenDelegation(d)) fail('delegation-closed', `delegation ${d.id} is closed (${d.disposition?.kind ?? d.closed?.reason}); a child is not bound to it`)
      const c = e.child as unknown as Record<string, unknown>
      if (!isObj(c) || ![c.uid, c.workspace, c.project, c.workflow, c.run, c.created].every(v => typeof v === 'string' && v)) fail('shape', 'child is {uid, workspace, project, workflow, run, created}')
      if (c.project !== d.target.project || c.workflow !== d.target.workflow) fail('delegate-relation', `delegation ${d.id} goes to ${d.target.project}/${d.target.workflow}, not ${String(c.project)}/${String(c.workflow)}`)
      if (d.child && d.child.uid !== c.uid) fail('delegate-relation', `delegation ${d.id} is bound to ${d.child.uid}; one child per delegation`)
      const tr = e.transport as unknown as Record<string, unknown>
      if (!isObj(tr) || typeof tr.realm !== 'string' || ![tr.message, tr.stream].every(v => typeof v === 'number' && Number.isInteger(v) && v > 0) || typeof tr.topic !== 'string') fail('shape', 'transport is {realm, message, stream, topic}')
      d.child = { uid: c.uid as string, workspace: c.workspace as string, project: c.project as string, workflow: c.workflow as string, run: c.run as string, created: c.created as string }
      d.transport = { realm: tr.realm as string, message: tr.message as number, stream: tr.stream as number, topic: tr.topic as string }
      break
    }
    case 'delegation.event': {
      // A fact of the child relayed (p10). Recorded while the parent lives;
      // a cancelled parent records nothing more (the child stays readable).
      live()
      const d = delegation(e.delegation)
      if (d.closed) fail('delegation-closed', `delegation ${d.id} is closed: ${d.closed.reason}`)
      const v = e.event as unknown as Record<string, unknown>
      if (!isObj(v) || !(EVENT_TYPES as readonly string[]).includes(v.type as string)) fail('shape', `event.type is one of ${EVENT_TYPES.join(', ')}`)
      const ch = v.child as Record<string, unknown>
      if (!isObj(ch) || typeof ch.seq !== 'number' || typeof ch.at !== 'string' || typeof ch.by !== 'string') fail('shape', 'event.child is {seq, at, by}: the child\'s entry it comes from')
      if (v.type !== 'answer-refused' && !d.child) fail('delegation-unbound', `delegation ${d.id} has no child yet`)
      const ev: DelegationEvent = { ...(v as unknown as DelegationEvent), n: d.events.length + 1, at, seq: e.seq, during: ctl.attempt?.id ?? null, wakes: WAKING.has(v.type as string), text: optText(v.text, 'event.text'), takenUp: null }
      if (ev.type === 'completed' && v.manifest !== undefined) ev.manifest = manifestShape(v.manifest)
      d.events.push(ev)
      // A result after the delegation was judged is kept and changes nothing.
      if (d.disposition) ev.wakes = false
      if (d.node in s.nodes) s.nodes[d.node].updated = at
      break
    }
    case 'delegation.take-up': {
      live()
      const d = delegation(e.delegation)
      const ns = Array.isArray(e.events) ? [...new Set(e.events)] : []
      if (!ns.length) fail('missing', 'name the events taken up')
      for (const k of ns) {
        const ev = d.events.find(x => x.n === k)
        if (!ev) fail('delegation-event', `delegation ${d.id} has no event ${String(k)}`)
        if (ev!.takenUp) fail('delegation-event', `event ${k} of ${d.id} was already taken up by ${ev!.takenUp.by} at ${ev!.takenUp.at}`)
        ev!.takenUp = { at, by, attempt: e.attempt ?? null }
      }
      resumeDelegate(d)
      break
    }
    case 'delegation.answer': {
      live()
      const d = delegation(e.delegation)
      if (!isOpenDelegation(d)) fail('delegation-closed', `delegation ${d.id} is ${d.disposition?.kind ?? 'closed'}; nothing more is sent to its child`)
      if (!d.child) fail('delegation-unbound', `delegation ${d.id} has no child yet; there is no question to answer`)
      const q = typeof e.question === 'string' ? questionEvent(d, e.question) : undefined
      if (!q) fail('question-unknown', `the child of ${d.id} asked no question "${String(e.question)}" that reached this run`)
      if (d.events.some(x => x.n > q!.n && x.type === 'withdrawn' && x.question === q!.question)) fail('question-closed', `the child withdrew ${q!.question}; nothing is answered`)
      const why = because(e.because)
      if (why && why.from === s.executor.name) fail('because', `the words named are ${s.executor.name}'s own; because names a person's answer or instruction`)
      const n = d.answers.length + 1
      d.answers.push({ n, question: q!.question!, event: q!.n, text: text(e.text, 'the answer'), from: why?.from ?? by, by, at, attempt: e.attempt ?? null, seq: e.seq, ...(why ? { because: why } : {}) })
      waitOnDelegation(d)
      break
    }
    case 'delegation.instruct': {
      live()
      const d = delegation(e.delegation)
      if (!isOpenDelegation(d)) fail('delegation-closed', `delegation ${d.id} is ${d.disposition?.kind ?? 'closed'}; nothing more is sent to its child`)
      if (!d.child) fail('delegation-unbound', `delegation ${d.id} has no child yet; wait for its creation before instructing it`)
      const why = because(e.because)
      if (why && why.from === s.executor.name) fail('because', `the words named are ${s.executor.name}'s own; because names a person's answer or instruction`)
      d.instructions.push({ n: d.instructions.length + 1, text: text(e.text, 'the instruction'), from: why?.from ?? by, by, at, attempt: e.attempt ?? null, seq: e.seq, ...(why ? { because: why } : {}) })
      waitOnDelegation(d)
      break
    }
    case 'delegation.dispose': {
      live()
      const d = delegation(e.delegation)
      if (d.disposition) fail('delegation-closed', `delegation ${d.id} was already judged ${d.disposition.kind} by ${d.disposition.by}`)
      if (d.closed) fail('delegation-closed', `delegation ${d.id} is closed: ${d.closed.reason}`)
      if (!(DISPOSITIONS as readonly string[]).includes(e.disposition)) fail('shape', `disposition is one of ${DISPOSITIONS.join(', ')}`)
      const note = text(e.note, 'what you found (the note)')
      let ev: DelegationEvent | undefined
      if (e.disposition !== 'abandoned') {
        const latest = latestResult(d)
        ev = e.event !== undefined && e.event !== null ? d.events.find(x => x.n === e.event) : latest
        if (!ev || ev.type !== 'completed') fail('delegation-result', `delegation ${d.id} has ${ev ? `no result at event ${e.event} (it is ${ev.type})` : 'no result yet'}; a result is judged once the child completed (abandoned needs none)`)
        if (latest && ev!.n !== latest.n) fail('result-superseded', `event ${ev!.n} is not ${d.id}'s latest result (event ${latest.n} is); judge the latest`)
      }
      d.disposition = { kind: e.disposition as typeof DISPOSITIONS[number], note, event: ev?.n ?? null, manifest: ev?.manifest?.digest ?? null, at, by }
      break
    }
    default:
      fail('op-unknown', `unknown operation "${(e as { op: string }).op}"`)
  }

  // The plan step completes on agreement to the plan.md it completes with: a
  function delegation(id: unknown): Delegation {
    if (typeof id !== 'string' || !DELEGATION_ID.test(id) || !s.delegations?.[id]) fail('delegation-unknown', `delegation "${String(id)}" does not exist in this run`)
    return s.delegations![id as string]
  }
  // The delegate node resumes when its agent takes up a fact of the child,
  // and waits again once it sent the child an answer or an instruction.
  function resumeDelegate(d: Delegation) {
    const n = s.nodes[d.node]
    if (n?.state === 'waiting' && n.wait && 'delegation' in n.wait.on && n.wait.on.delegation === d.id) { n.wait = null; move(d.node, 'running') }
  }
  function waitOnDelegation(d: Delegation) {
    const n = s.nodes[d.node]
    if (n?.state !== 'running') return
    n.wait = { reason: `delegation ${d.id} to ${d.target.project}/${d.target.workflow}`, holder: `${d.target.project}/${d.target.workflow}`, on: { delegation: d.id } }
    move(d.node, 'waiting')
  }

  function resumeFrom(q: Question) {
    if (!q.node) return
    const n = s.nodes[q.node]
    if (n.state === 'waiting' && n.wait && 'question' in n.wait.on && n.wait.on.question === q.id) {
      n.wait = null
      move(q.node, 'running')
    }
  }

  const before = prev.execution.state
  s.execution = summarize(s, graph)
  if (s.execution.state !== before) {
    change.execution = [before, s.execution.state]
    s.ended = TERMINAL.includes(s.execution.state) ? at : null
  }
  if ((ctl.hold?.kind ?? null) !== holdBefore) change.hold = [holdBefore, ctl.hold?.kind ?? null]
  return { state: s, change }
}

// Replays a whole history. Throws RunError naming the entry that fails.
export function replay(history: unknown[], graph: RunGraph): { state: RunState; changes: Change[] } {
  let state: RunState | null = null
  // The graph in force: the original until an adjustment, then the one it carries (p7).
  let g = graph
  const changes: Change[] = []
  // An adjustment made at a node's completion is followed by that
  // completion (p8/ex2), so no record shows work changed in mid-node.
  let owed: { node: string; seq: number } | null = null
  history.forEach((raw, i) => {
    if (!isObj(raw)) fail('shape', `history entry ${i + 1} is not an object`)
    const e = raw as HistoryEntry
    if (e.seq !== i + 1) fail('sequence', `history entry ${i + 1} has seq ${String(e.seq)}; expected ${i + 1}`)
    if (!(OPS as readonly string[]).includes(e.op)) fail('op-unknown', `history ${e.seq}: unknown operation "${String(e.op)}"`)
    if (owed && !(e.op === 'node.complete' && (e as { node?: string }).node === owed.node)) fail('completion-owed', `history ${e.seq} (${e.op}): the adjustment at ${owed.seq} was made at the completion of ${owed.node}, so the next entry completes ${owed.node}`)
    owed = e.op === 'run.adjust' && typeof (e as { completing?: unknown }).completing === 'string' ? { node: (e as { completing: string }).completing, seq: e.seq } : null
    try {
      const r = apply(state, e, g)
      state = r.state
      changes.push(r.change)
      if (e.op === 'run.adjust') g = graphOfState(r.state) ?? g
    } catch (err) {
      if (err instanceof RunError) throw new RunError(err.code, `history ${e.seq} (${e.op}): ${err.message}`)
      throw new RunError('shape', `history ${e.seq} (${e.op}): ${(err as Error).message}`)
    }
  })
  if (!state) fail('empty', 'the history is empty')
  if (owed) fail('completion-owed', `the adjustment at ${(owed as { seq: number }).seq} was made at the completion of ${(owed as { node: string }).node}, which is not recorded`)
  return { state: state!, changes }
}

// The graph a run follows now: its latest revision's, or the one it was
// created with (p7). Undefined for records without a frozen graph.
export function graphOfState(s: { definition: DefinitionRef }): RunGraph | undefined {
  const eff = effectiveOf(s)
  return eff ? { nodes: eff.nodes, edges: eff.edges } : undefined
}

export function stateOf(record: RunRecord): RunState {
  const { history: _, ...state } = record
  return state
}

// Reads a parsed run.json against its graph: the history must replay and the
// stored state and per-entry changes must equal the replay.
export function checkRecord(raw: unknown, graph: RunGraph): { ok: true; record: RunRecord } | { ok: false; code: string; message: string } {
  try {
    if (!isObj(raw)) fail('shape', 'run.json must be an object')
    const r = raw as Record<string, unknown>
    if (r.schema !== RUN_SCHEMA) fail('schema', `schema is "${String(r.schema)}"; expected ${RUN_SCHEMA}`)
    if (!Array.isArray(r.history)) fail('shape', 'history must be a list')
    const { state, changes } = replay(r.history as unknown[], graph)
    const record = raw as unknown as RunRecord
    if (canonicalJson(stateOf(record)) !== canonicalJson(state)) {
      const keys = new Set([...Object.keys(state), ...Object.keys(stateOf(record))])
      const differ = [...keys].filter(k => canonicalJson((state as unknown as Record<string, unknown>)[k] ?? null) !== canonicalJson((stateOf(record) as unknown as Record<string, unknown>)[k] ?? null))
      fail('inconsistent', `the stored state differs from its history in: ${differ.join(', ')}`)
    }
    record.history.forEach((e, i) => {
      if (canonicalJson(e.change ?? null) !== canonicalJson(changes[i])) fail('inconsistent', `history ${e.seq}: the recorded change differs from what the operation does`)
    })
    return { ok: true, record }
  } catch (e) {
    if (e instanceof RunError) return { ok: false, code: e.code, message: e.message }
    return { ok: false, code: 'shape', message: (e as Error).message }
  }
}

// Appends one operation: the next record, written by the caller in one
// atomic replacement. `expectSeq` refuses an operation based on an outdated view.
export function operate(record: RunRecord | null, input: OpInput & EntryMeta, ctx: { at: string; by: string; via: string; graph: RunGraph; expectSeq?: number }): RunRecord {
  if (input.receipt !== undefined && (typeof input.receipt !== 'string' || !/^[A-Za-z0-9:._/#-]{1,200}$/.test(input.receipt))) fail('shape', 'a receipt is 1–200 characters of A-Z a-z 0-9 : . _ / # -')
  const dup = input.receipt ? record?.history.find(h => h.receipt === input.receipt) : undefined
  if (dup) {
    if (dup.op !== input.op) fail('receipt-reused', `receipt ${input.receipt} already recorded ${dup.op} at seq ${dup.seq}`)
    return record! // a retransmission: already recorded, nothing changes
  }
  for (const k of ['attempt', 'receipt', 'operator'] as const) if (input[k] === undefined || input[k] === null) delete input[k]
  if (input.operator !== undefined && (!isObj(input.operator) || typeof input.operator.run !== 'string' || typeof input.operator.attempt !== 'string')) fail('shape', 'operator is {run, attempt}: the other run whose executing attempt records this')
  const seq = (record?.seq ?? 0) + 1
  if (ctx.expectSeq !== undefined && ctx.expectSeq !== (record?.seq ?? 0)) {
    fail('outdated', `the run changed since it was read (now at ${record?.seq ?? 0}, expected ${ctx.expectSeq}); reload and retry`)
  }
  const entry = { ...input, seq, at: ctx.at, by: ctx.by, via: ctx.via } as HistoryEntry
  const { state, change } = apply(record ? stateOf(record) : null, entry, ctx.graph)
  entry.change = change
  return { ...state, history: [...(record?.history ?? []), entry] }
}

export const runKey = (r: RunRef) => `${r.workflow}/${r.run}`

// ---- what the control state means to a reader -------------------------------------

// The run's situation as the views state it. `executing` means an attempt is
// open in the record; whether its process is alive is said separately by
// the execution host. Waits are told apart by whose move they are
// (project_migration p8 ex1): a person's answer, a child run's work, an
// external result — and `due` when the record owes the executor the next
// move (an answer or a child's fact not taken up, an instruction not read,
// work left ready). Short words and reasons: shared/status.ts.
export type Situation = 'executing' | 'stopping' | 'awaiting-person' | 'awaiting-delegation' | 'awaiting-external' | 'due' | 'stopped' | 'interrupted' | 'unknown' | 'completed' | 'cancelled' | 'not-started' | 'idle'
export function situation(s: Pick<RunState, 'control' | 'execution' | 'cancelled'> & Partial<Pick<RunState, 'questions' | 'delegations' | 'instructions'>>): Situation {
  if (s.cancelled) return 'cancelled'
  if (s.control.attempt) return s.control.stop ? 'stopping' : 'executing'
  if (s.control.hold) return s.control.hold.kind
  if (s.execution.state === 'completed') return 'completed'
  if (s.execution.state === 'not-started') return 'not-started'
  if (dueReason(s)) return 'due'
  const on = s.execution.waiting.map(w => w.on)
  if (on.some(o => 'question' in o)) return 'awaiting-person'
  if (on.some(o => 'delegation' in o)) return 'awaiting-delegation'
  if (on.length) return 'awaiting-external'
  return 'idle'
}

// Why the executor owes the run its next move, from the record alone; null
// when the next move is someone else's (or nobody's).
export function dueReason(s: Pick<RunState, 'execution'> & Partial<Pick<RunState, 'questions' | 'delegations' | 'instructions'>>): string | null {
  for (const w of s.execution.waiting) {
    if ('question' in w.on) { const q = s.questions?.[w.on.question]; if (q && questionState(q) === 'answered') return `answer to ${q.id} arrived` }
  }
  for (const d of Object.values(s.delegations ?? {})) {
    const e = isOpenDelegation(d) ? pendingEvents(d)[0] : undefined
    if (e) return `${e.type === 'completed' ? 'result' : e.type} from ${d.target.project} ${d.target.workflow} arrived`
  }
  const ins = Object.values(s.instructions ?? {}).find(i => !i.ack)
  if (ins && s.execution.state !== 'completed') return `instruction ${ins.id} arrived`
  const and = (xs: string[]) => xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`
  if (s.execution.ready.length && !s.execution.waiting.length) return `${and(s.execution.ready)} ready`
  if (s.execution.active.length) return `${and(s.execution.active)} recorded as running`
  return null
}

// ---- coordination events (p4 selection, p5 delivery) ----------------------------------

// What a coordinator announces, selected from committed history entries:
// the facts a person or another agent needs to know what happened, what is
// uncertain and who acts next — not every record. Each event has a stable
// id `<project>/<workflow>/<run>#<seq>:<type>` (one entry may give more than
// one type) and points at the record for details. Delivery (server/notify.ts)
// and its recovery use this one selection.
//
// `critical` events (questions, failures, holds, the completed execution, a
// decision, a cancellation) are always sent on their own; routine ones may
// be combined with adjacent routine ones.
export type NotableType = 'started' | 'question' | 'answered' | 'reported' | 'node-completed' | 'failed' | 'held' | 'resumed' | 'completed' | 'decided' | 'cancelled'
  | 'instructed' | 'acknowledged' // p6: an additional instruction received, and taken up
  | 'accepted' | 'notice' // p6, request topic only: the request became a run; a reply about a post (server/notify.ts)
  | 'presented' | 'cleanup-failed' // p7: a presentation became available for review; its shutdown could not be verified
  | 'adjusted' // p7: the run's future work was adjusted (a new revision)
  | 'integrated' // p9: the accepted result reached the project's shared branches
  | 'delegated' | 'delegation' // p10: a delegate node's dispatch; a child's result, failure or cancellation relayed
export interface NotableEvent {
  id: string
  seq: number
  type: NotableType
  at: string
  by: string
  critical: boolean
  node?: string // the authored node concerned (a report's node, not the step)
  step?: string // the documentation step, when it is one
  question?: string
  holder?: string // who holds the next move
  text: string // the event's own words: a question, an outcome, a reason
  document?: string // project-relative document the event refers to
  hold?: HoldKind
  heldBy?: string // held: who stopped it (p9), and the person's words they acted on
  because?: Because
  decision?: 'accepted' | 'rejected'
  subject?: string[] // the deliverables a result-confirmation question presents (p6)
  confirmation?: { question: string; from: string } // a decision from the person's confirmation (p6)
  instructions?: string[] // instructed / acknowledged (p6)
  response?: string // acknowledged: incorporate | clarify | new-run
  confirms?: boolean // a question from the result-confirmation node
  presentation?: string // presented / cleanup-failed, and a question about a presentation (p7)
  title?: string // the presentation's title
  revision?: string // adjusted: the revision now in force
  adjusted?: { added: string[]; removed: string[] } // adjusted: authored work added and removed
  delegation?: string // delegated / delegation: the delegation id (p10)
  delegationEvent?: string // delegation: the relayed fact's type
}
// The hold an entry recorded, as the reducer worded it at that point (the
// state keeps only the current hold): replayed from the frozen graph.
function holdAt(r: RunRecord, seq: number): Control['hold'] {
  const lastHold = [...r.history].reverse().find(h => h.change.hold?.[1])
  if (lastHold?.seq === seq && r.control.hold) return r.control.hold
  const eff = r.definition.effective
  if (!eff) return null
  try { return replay(r.history.slice(0, seq), { nodes: eff.nodes, edges: eff.edges }).state.control.hold } catch { return null }
}

export function notableEvents(r: RunRecord, sinceSeq = 0): NotableEvent[] {
  const out: NotableEvent[] = []
  const eff = r.definition.effective
  // Node completions are news when no report step tells of them (p8/ex2:
  // the reports setting, not the policy's name).
  const reporting = !!eff && docStepsOf(eff).reports
  const stepAt = (id: string) => anyRevisionNode(r, id)?.step
  let started = false
  for (const e of r.history) {
    const d = e as unknown as Record<string, string>
    if (e.op === 'attempt.begin' && !started) started = true
    else if (e.op === 'attempt.begin') { /* a later launch is not news; holds and resumptions are */ }
    if (e.seq <= sinceSeq) continue
    const push = (type: NotableType, critical: boolean, text: string, extra: Partial<NotableEvent> = {}) =>
      out.push({ id: `${r.project}/${r.workflow}/${r.run}#${e.seq}:${type}`, seq: e.seq, type, at: e.at, by: e.by, critical, text, ...extra })
    const step = typeof d.node === 'string' ? stepAt(d.node) : undefined
    if (e.op === 'attempt.begin' && r.history.find(h => h.op === 'attempt.begin')!.seq === e.seq) push('started', false, d.reason ?? '')
    else if (e.op === 'question.ask') {
      const q = r.questions[d.question]
      push('question', true, d.text, { question: d.question, holder: d.to, node: step ? undefined : d.node, step: step ? d.node : undefined, document: q?.document?.path, ...(q?.subject ? { subject: q.presentation ? [] : q.subject.map(x => x.path), confirms: true } : {}), ...(q?.presentation ? { presentation: q.presentation.id } : {}) })
    } else if (e.op === 'question.answer') push('answered', false, `answer to ${d.question} recorded`, { question: d.question, holder: r.executor.name })
    else if (e.op === 'node.complete' && step?.kind === 'report') push('reported', false, d.outcome, { node: step.for ?? undefined, step: d.node, document: (e as unknown as { document?: DocumentEvidence }).document?.path })
    else if (e.op === 'node.complete' && step?.kind === 'final-report') push('completed', true, d.outcome, { step: d.node, document: (e as unknown as { document?: DocumentEvidence }).document?.path })
    // The node whose completion completes the execution is told once, as
    // the completion.
    else if (e.op === 'node.complete' && !step && !reporting && e.change.execution?.[1] !== 'completed') push('node-completed', false, d.outcome, { node: d.node })
    else if (e.op === 'node.fail') push('failed', true, d.reason, { node: step ? step.for ?? undefined : d.node, step: step ? d.node : undefined })
    // The hold's reason is derived by the reducer (an exit with work left
    // running is an interruption); the latest hold carries it in the state.
    if (e.change.hold?.[1]) {
      const h = holdAt(r, e.seq)
      push('held', true, h?.reason || d.detail || d.reason || e.change.hold[1], { hold: e.change.hold[1], ...(h?.kind === 'stopped' ? { heldBy: h.by, ...(h.because ? { because: h.because } : {}) } : {}) })
    }
    if (e.op === 'run.resume') push('resumed', false, d.reason)
    // observer p3: continued by a recovering agent, said as such.
    if ((e.op as string) === 'run.recover') push('resumed', false, `continued by recovery (${e.by}, incident ${String(d.incident)}): ${String(d.reason)}`)
    if (e.change.execution?.[1] === 'completed' && !(step?.kind === 'final-report')) push('completed', true, d.outcome ?? 'every node completed', e.op === 'node.complete' && !step ? { node: d.node } : {})
    if (e.op === 'run.decide') {
      const dec = r.decisions.find(x => x.at === e.at && x.by === e.by && x.decision === d.decision)
      push('decided', true, dec?.evidence ?? d.evidence ?? '', { decision: d.decision as 'accepted' | 'rejected', ...(dec?.confirmation ? { confirmation: { question: dec.confirmation.question, from: dec.confirmation.from }, subject: dec.confirmation.presentation ? [] : dec.confirmation.subject.map(x => x.path), ...(dec.confirmation.presentation ? { presentation: dec.confirmation.presentation.id } : {}) } : {}) })
    }
    if (e.op === 'instruction.receive') push('instructed', false, d.text, { instructions: [e.change.instruction?.[1] ?? ''], holder: r.executor.name })
    if (e.op === 'instruction.ack') push('acknowledged', false, d.note, { instructions: (e as unknown as { instructions: string[] }).instructions, response: d.response })
    if (e.op === 'run.cancel') push('cancelled', true, d.reason)
    if (e.op === 'run.integrate') push('integrated', false, (d.repositories as unknown as IntegrationRecord['repositories']).filter(x => x.method !== 'already').map(x => `${x.path === '.' ? 'project root' : x.path} → ${x.target} (${x.method}, ${x.result.slice(0, 10)})`).join('; '))
    if (e.op === 'run.adjust') {
      const diff = (e as unknown as { diff?: AdjustDiff }).diff ?? r.definition.revisions?.find(x => x.revision === d.revision)?.diff
      push('adjusted', false, d.reason, { revision: d.revision, ...(diff ? { adjusted: { added: diff.added.filter(x => !x.startsWith('_')), removed: diff.removed.filter(x => !x.startsWith('_')) } } : {}) })
    }
    if (e.op === 'delegation.dispatch') {
      const dl = r.delegations?.[d.delegation]
      push('delegated', false, '', { node: d.node, delegation: d.delegation, holder: dl ? `${dl.target.project}/${dl.target.workflow}` : '' })
    }
    if (e.op === 'delegation.event') {
      const ev = (e as unknown as { event: { type: string; text?: string } }).event
      const dl = r.delegations?.[d.delegation]
      if (dl && ['completed', 'failed', 'cancelled'].includes(ev.type)) push('delegation', false, ev.text ?? '', { node: dl.node, delegation: dl.id, delegationEvent: ev.type, holder: `${dl.target.project}/${dl.target.workflow}` })
    }
    if (e.op === 'presentation.observe' && (d.status === 'available' || d.status === 'stop-failed')) {
      const p = r.presentations?.[d.presentation]
      const extra = { presentation: d.presentation, title: p?.title ?? d.presentation, node: p?.node }
      if (d.status === 'available') push('presented', true, d.detail ?? '', extra)
      else push('cleanup-failed', true, d.detail ?? '', extra)
    }
  }
  return out
}
