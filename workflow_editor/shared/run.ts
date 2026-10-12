// Workflow runs (ag.workflow-run.v1): the one reducer that turns a run's
// history into its current state, readiness and the execution summary.
// Shared by the service, the CLI and the browser; it touches no files.
// See docs/runs.md for the contract.
import { canonicalJson } from './canonical.ts'
import type { EffectiveGraph, StepSpec } from './compile.ts'
import { INSTRUCTION_RESPONSES, type SourceRef } from './intake.ts'
import { ID_PATTERN, normalizeRepoPath, type Edge } from './model.ts'

export const RUN_SCHEMA = 'ag.workflow-run.v2'
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
  | { kind: 'run'; workflow: string; run: string; node?: string }
  | { kind: 'file'; path: string }
  | { kind: 'note'; text: string }

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
}
// `name` is the agent identity the run is performed as (p6: the workflow's
// execution.agent); `host` the execution host that launches it, when that is
// not the agent itself (autolab executing for ppt-agent).
export interface Executor { name: string; backend: string | null; host?: string }
export const hostOf = (e: Executor) => e.host ?? e.name
// What one attempt was launched with (p6), recorded with attempt.begin so its
// behaviour can be explained later: the agent identity, the host's profile
// and the backend it resolved to, and the guides composed into its
// instructions — the host's common contract and the project's guides — by
// content hash.
export interface AttemptSettings { agent: string; profile: string | null; backend: string | null; contract: { name: string; sha256: string } | null; guides: { path: string; sha256: string }[] }
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
  | { kind: 'person'; by?: string } // a person applies it themselves
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

export type WaitOn = { question: string } | { external: string }
export interface Wait { reason: string; holder: string; on: WaitOn }
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
export interface Answer { text: string; from: string; by: string; at: string; via: string; source?: SourceRef }
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
export interface Decision {
  decision: 'accepted' | 'rejected'; by: string; at: string; evidence: string; note: string
  // A decision the person gave by answering the result-confirmation
  // question (p6): which question and answer, whose words, and the
  // deliverables (by hash) it confirmed.
  confirmation?: { question: string; answer: number; from: string; source?: SourceRef; subject: DocumentEvidence[]; presentation?: { id: string; revision: string } }
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
export interface Control {
  attempt: { id: string; reason: string; began: string; backend: string | null; settings?: AttemptSettings } | null // the open attempt; backend: what served it (Agent ≠ Model)
  attempts: number
  last: { id: string; outcome: AttemptOutcome; ended: string; detail: string; backend: string | null } | null
  hold: { kind: HoldKind; since: string; by: string; reason: string } | null // nothing resumes it but run.resume
  stop: { at: string; by: string; reason: string } | null // stop requested; not yet confirmed by the attempt's end
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
  context: { repositories: RepoContext[] }
  nodes: Record<string, NodeRecord>
  questions: Record<string, Question>
  instructions?: Record<string, Instruction> // present once the first one arrives (p6)
  presentations?: Record<string, Presentation> // present once the first one is registered (p7)
  artifacts: Artifact[]
  decisions: Decision[]
  cancelled: { reason: string; at: string; by: string } | null
  control: Control
  execution: Execution
  started: string | null
  ended: string | null
  updated: string
  seq: number
}

// ---- operations (history entries) ---------------------------------------------

export type OpInput =
  | { op: 'run.create'; project: string; workflow: string; run: string; input: RunInput; executor: Executor; predecessor: RunRef | null; definition: DefinitionRef; context: { repositories: RepoContext[] }; nodes: string[] }
  | { op: 'node.start'; node: string; reason?: string }
  | { op: 'node.progress'; node: string; text: string }
  | { op: 'node.wait'; node: string; reason: string; holder: string; external: string }
  | { op: 'node.complete'; node: string; outcome: string; artifacts?: string[]; document?: DocumentEvidence; agreement?: string }
  | { op: 'node.fail'; node: string; reason: string }
  | { op: 'node.cancel'; node: string; reason: string }
  | { op: 'question.ask'; question: string; node?: string; text: string; to: string; document?: DocumentEvidence; plan?: boolean; subjects?: string[]; subject?: DocumentEvidence[]; presentation?: string; adjustment?: string }
  | { op: 'question.answer'; question: string; text: string; from?: string; source?: SourceRef }
  | { op: 'instruction.receive'; instruction?: string; text: string; from: string; source?: SourceRef }
  | { op: 'instruction.ack'; instructions: string[]; response: string; note: string }
  | { op: 'question.take-up'; question: string; answer?: number }
  | { op: 'question.withdraw'; question: string; reason: string }
  | { op: 'artifact.attach'; path: string; node?: string; title?: string }
  | { op: 'run.cancel'; reason: string }
  | { op: 'run.decide'; decision: 'accepted' | 'rejected'; evidence?: string; note?: string; question?: string; answer?: number; subject?: DocumentEvidence[] }
  | { op: 'attempt.begin'; attempt: string; reason: string; backend?: string; settings?: AttemptSettings }
  | { op: 'attempt.end'; attempt: string; outcome: AttemptOutcome; detail?: string }
  | { op: 'run.stop'; reason: string }
  | { op: 'run.resume'; reason: string }
  | { op: 'presentation.register'; presentation?: string; node: string; title: string; manifest?: PresentationManifest }
  | { op: 'presentation.observe'; presentation: string; status: Observation; instance?: string; detail?: string }
  | { op: 'run.adjust'; revision: string; parent: string; file: string; sha256: string; definitionDigest: string; effective: EffectiveGraph; reason: string; source: AdjustSource; diff?: AdjustDiff }

export const OPS = ['run.create', 'node.start', 'node.progress', 'node.wait', 'node.complete', 'node.fail', 'node.cancel',
  'question.ask', 'question.answer', 'question.take-up', 'question.withdraw', 'instruction.receive', 'instruction.ack', 'artifact.attach', 'run.cancel', 'run.decide',
  'attempt.begin', 'attempt.end', 'run.stop', 'run.resume', 'presentation.register', 'presentation.observe', 'run.adjust'] as const
// The executor's own reports. While an attempt is open they must carry its
// id (`attempt`), so a stopped or superseded attempt cannot write into the
// record of the one that replaced it.
export const EXECUTOR_OPS: readonly string[] = ['node.start', 'node.progress', 'node.wait', 'node.complete', 'node.fail', 'question.ask', 'question.take-up', 'question.withdraw', 'instruction.ack', 'artifact.attach', 'presentation.register']

// Received instructions the executor has not acknowledged, in arrival order.
export const pendingInstructions = (s: Pick<RunState, 'instructions'>): Instruction[] => Object.values(s.instructions ?? {}).filter(i => !i.ack)
// Every entry may carry `attempt` (the executor's launch) and `receipt` (an
// idempotency key: a retransmitted request with the same receipt is not
// recorded twice).
export interface EntryMeta { attempt?: string; receipt?: string }

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

// The graph the run follows: its frozen effective graph (p5), or, for a run
// created before p5, the root workflow of its bundle. A node with `step` is a
// generated documentation step.
export interface RunGraph { nodes: Record<string, { type: string; workflow?: string; confirms?: string; step?: StepSpec }>; edges: Edge[] }
export const stepOf = (graph: RunGraph, node: string): StepSpec | undefined => graph.nodes[node]?.step
// The document a step writes, project-relative.
export const documentPath = (r: RunRef, step: StepSpec) => `${runFolder(r)}/${step.output}`

// Delegate nodes are definition and display only (p4): a workflow that has
// one is refused at run creation, by every entrance, through this reducer.
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
  else if (ids.length > 0 && counts.completed === ids.length) state = 'completed'
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
  if (o.kind !== 'zulip') fail('shape', 'source.kind must be zulip')
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
  if (!isObj(v)) return fail('shape', 'an adjustment names its source: an answer, an instruction, an agreement or a person')
  const o = v as Record<string, unknown>
  if (o.kind === 'answer') return { kind: 'answer', question: text(o.question, 'source.question'), ...(o.answer !== undefined ? { answer: Number(o.answer) } : {}) }
  if (o.kind === 'instruction') return { kind: 'instruction', instruction: text(o.instruction, 'source.instruction') }
  if (o.kind === 'agreement') return { kind: 'agreement', question: text(o.question, 'source.question') }
  if (o.kind === 'person') return { kind: 'person', ...(typeof o.by === 'string' && o.by.trim() ? { by: o.by.trim() } : {}) }
  return fail('shape', 'source.kind is answer, instruction, agreement or person')
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

function attemptSettings(v: unknown): AttemptSettings {
  if (!isObj(v)) return fail('shape', 'attempt settings must be an object')
  const o = v as Record<string, unknown>
  const hash = (h: unknown, what: string) => (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h) ? h : fail('shape', `${what}: sha256 must be 64 hex digits`))
  const contract = o.contract === null || o.contract === undefined ? null : isObj(o.contract) ? { name: text((o.contract as Record<string, unknown>).name, 'the contract name'), sha256: hash((o.contract as Record<string, unknown>).sha256, 'the contract') } : fail('shape', 'settings.contract must be {name, sha256}')
  if (!Array.isArray(o.guides)) fail('shape', 'settings.guides must be a list')
  const guides = (o.guides as unknown[]).map((g, i) => {
    if (!isObj(g)) return fail('shape', `settings.guides[${i}] must be {path, sha256}`)
    const path = normalizeRepoPath(String((g as Record<string, unknown>).path ?? ''))
    if (!path || path === '.') fail('shape', `settings.guides[${i}] path must be project-relative`)
    return { path: path!, sha256: hash((g as Record<string, unknown>).sha256, `settings.guides[${i}]`) }
  })
  return { agent: text(o.agent, 'settings.agent'), profile: optText(o.profile, 'settings.profile') || null, backend: optText(o.backend, 'settings.backend') || null, contract, guides }
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
    const delegates = delegateNodes(graph)
    if (delegates.length) fail('delegate-unsupported', `the workflow has delegate node${delegates.length === 1 ? '' : 's'} ${delegates.join(', ')}; delegate execution is not supported, so no run of it is created`)
    if (e.input?.source !== undefined) sourceOf(e.input.source) // checked, recorded as given
    const nodes = Object.fromEntries(ids.map(id => [id, emptyNode()]))
    const state: RunState = {
      schema: RUN_SCHEMA, project: e.project, workflow: e.workflow, run: e.run, created: at,
      input: e.input, executor: e.executor, predecessor: e.predecessor ?? null,
      definition: e.definition, context: e.context,
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
  const ready = () => readiness(s.nodes, graph).ready

  switch (e.op) {
    case 'node.start': {
      live()
      const n = node(e.node)
      if (n.state === 'pending') {
        if (!ready().includes(e.node)) {
          const preds = predecessors(graph).get(e.node)!.filter(p => s.nodes[p].state !== 'completed')
          fail('not-ready', `node "${e.node}" is not ready: ${preds.map(p => `${p} is ${s.nodes[p].state}`).join(', ')}`)
        }
        boundary(`starting ${e.node}`)
        n.started = at
        if (!s.started) s.started = at
      } else if (n.state === 'waiting') {
        n.wait = null
      } else if (n.state === 'failed') {
        text(e.reason, `resuming failed node "${e.node}": a reason`)
        n.failure = null; n.ended = null
      } else fail('state', `node "${e.node}" is ${n.state}; start applies to pending (ready), waiting or failed nodes`)
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
        doc = evidence(e.document, `completing ${e.node}`, documentPath(s, step))
        if (step.kind === 'plan') n.agreement = { question: agreedPlan(e.node, doc, e.agreement) }
        n.document = doc
        if (!artifacts.includes(doc.path)) artifacts.unshift(doc.path)
      } else if (e.document !== undefined || e.agreement !== undefined) fail('shape', `node "${e.node}" is authored work; documents and plan agreement belong to documentation steps`)
      // The last completion of the run is a boundary too: input received
      // before it is considered, whichever node it is.
      if (Object.entries(s.nodes).every(([id, x]) => id === e.node || x.state === 'completed')) {
        boundary(`completing ${e.node}, the last node of the run`)
        // A run is complete only after what it serves has stopped (p7).
        const open = openPresentations(s)
        if (open.length) fail('presentation-open', `completing ${e.node} would complete the run, but ${open.map(p => `presentation ${p.id} is ${p.state}`).join(', ')}; stop it and verify the shutdown first (wfe present stop <run> --all)`)
      }
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
      if (step?.kind === 'plan') q.document = evidence(e.document, `asking from ${e.node}`, documentPath(s, step))
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
        if (!Array.isArray(e.subject) || !e.subject.length) fail('subject-missing', `${e.node} confirms the result: name the deliverables it presents (--presentation <p>, or --subject <path> written first)`)
        q.subject = e.subject!.map((d, i) => subjectOf(d, `subject ${i + 1}`))
        // A presentation (p7): the question asks about exactly its files,
        // checked on disk by the file layer against the registered manifest.
        if (e.presentation !== undefined) {
          const p = s.presentations?.[e.presentation]
          if (!p) fail('presentation-unknown', `presentation "${e.presentation}" does not exist in this run`)
          if (p!.state !== 'available') fail('presentation-unavailable', `presentation ${p!.id} is ${p!.state}; ask about it once it is served (wfe present start)`)
          const same = q.subject.length === p!.files.length && p!.files.every(f => q.subject!.some(x => x.path === f.path && x.sha256 === f.sha256))
          if (!same) fail('presentation-changed', `the files of presentation ${p!.id} differ from its manifest; register the result again`)
          q.presentation = { id: p!.id, revision: p!.revision }
        }
      } else if (e.subject !== undefined || e.presentation !== undefined) fail('shape', 'only a question from the result-confirmation node presents deliverables')
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
      // Received, not read: no node changes, nothing is interrupted. A
      // completed run is over: input for it needs a new request.
      live()
      if (s.execution.state === 'completed') fail('run-completed', 'the run\'s execution is completed; further input needs a new request, it does not reopen this run')
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
      s.cancelled = { reason, at, by }
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
      break
    }
    case 'attempt.end': {
      if (!ctl.attempt || ctl.attempt.id !== e.attempt) fail('attempt-stale', `attempt ${String(e.attempt)} is not open (${ctl.attempt ? `${ctl.attempt.id} is` : 'none is'})`)
      if (!(ATTEMPT_OUTCOMES as readonly string[]).includes(e.outcome)) fail('shape', `outcome must be one of ${ATTEMPT_OUTCOMES.join(', ')}`)
      const detail = optText(e.detail, 'detail')
      // An exit is a normal end only when nothing is left as running and
      // the remaining work waits on someone; anything else needs a person to
      // look and resume (side effects may have happened after the last record).
      const ex = summarize(s, graph)
      let outcome: AttemptOutcome = e.outcome
      let why = detail
      if (outcome === 'exited' && !s.cancelled && ex.state === 'in-progress' && (ex.active.length || ex.ready.length)) {
        outcome = 'interrupted'
        why = `the executor exited with ${ex.active.length ? `${ex.active.join(', ')} recorded as running` : `${ex.ready.join(', ')} ready and nothing waiting`}${detail ? `; ${detail}` : ''}`
      }
      if (ctl.stop && outcome !== 'unknown') outcome = 'stopped'
      ctl.last = { id: ctl.attempt!.id, outcome, ended: at, detail: why, backend: ctl.attempt!.backend }
      ctl.attempt = null
      // A stop is the person's: the hold names who stopped and why.
      if (!s.cancelled && outcome !== 'exited') ctl.hold = outcome === 'stopped' && ctl.stop ? { kind: 'stopped', since: at, by: ctl.stop.by, reason: ctl.stop.reason } : { kind: outcome as HoldKind, since: at, by, reason: why || outcome }
      ctl.stop = null
      break
    }
    case 'run.stop': {
      live()
      const reason = text(e.reason, 'the reason')
      if (ctl.hold?.kind === 'stopped' || ctl.stop) fail('state', 'the run is already stopped or stopping')
      if (ctl.attempt) ctl.stop = { at, by, reason } // confirmed by the attempt's end
      else ctl.hold = { kind: 'stopped', since: at, by, reason }
      break
    }
    case 'run.resume': {
      live()
      if (!ctl.hold) fail('state', 'the run is not held; there is nothing to resume')
      if (ctl.attempt) fail('attempt-open', `attempt ${ctl.attempt.id} is still open`)
      text(e.reason, 'the resume instruction')
      ctl.hold = null
      break
    }
    case 'run.decide': {
      if (e.decision !== 'accepted' && e.decision !== 'rejected') fail('shape', 'decision must be accepted or rejected')
      if (e.question === undefined || e.question === null) {
        // The person's own decision (browser, CLI).
        if (e.decision === 'accepted' && prev.execution.state !== 'completed') fail('not-completed', `the execution is ${prev.execution.state}; only a completed execution can be accepted`)
        s.decisions.push({ decision: e.decision, by, at, evidence: text(e.evidence, 'the evidence'), note: optText(e.note, 'note') })
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
      const now = (e.subject ?? []).map((d, i) => subjectOf(d, `subject ${i + 1}`))
      const asked = q.subject ?? []
      const changed = asked.filter(a => !now.some(n => n.path === a.path && n.sha256 === a.sha256))
      if (changed.length) fail('subject-changed', `${changed.map(c => c.path).join(', ')} changed since ${q.id} presented ${changed.length === 1 ? 'it' : 'them'}; present the current deliverables again`)
      const a = q.answers[index]
      s.decisions.push({
        decision: e.decision, by, at, note: optText(e.note, 'note'),
        evidence: optText(e.evidence, 'evidence') || `${q.id} answer ${index} from ${a.from}${a.source ? ` (Zulip message ${a.source.message})` : ''}, confirming ${asked.map(x => `${x.path} (${x.sha256.slice(0, 12)})`).join(', ')}`,
        confirmation: { question: q.id, answer: index, from: a.from, ...(a.source ? { source: a.source } : {}), subject: asked, ...(q.presentation ? { presentation: q.presentation } : {}) },
      })
      break
    }
    case 'presentation.register': {
      live()
      if (s.execution.state === 'completed') fail('run-completed', 'the run\'s execution is completed; nothing more is presented')
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
    case 'run.adjust': {
      // A change of the run's future work (p7, docs/adjustments.md), at a
      // node boundary, authorized by the person's records.
      live()
      if (s.execution.state === 'completed') fail('run-completed', 'the run\'s execution is completed; its definition is not adjusted any more')
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
      const running = Object.keys(s.nodes).filter(n => s.nodes[n].state === 'running')
      if (running.length) fail('mid-node', `${running.join(', ')} ${running.length === 1 ? 'is' : 'are'} running; an adjustment applies at a node boundary, when no node runs`)
      boundary('adjusting the run')
      const next = e.effective
      if (!isObj(next) || !isObj(next.nodes) || !Array.isArray(next.edges) || typeof next.compiler !== 'string') fail('shape', 'the adjustment carries its whole compiled graph')
      const cur = s.definition.effective
      if (cur && next.policy !== cur.policy) fail('adjust-access', `the documentation policy is ${cur.policy}; an adjustment does not change it`)
      const nodes = next.nodes as Record<string, RunGraph['nodes'][string]>
      const edges = next.edges as Edge[]
      for (const ed of edges) if (!(ed?.from in nodes) || !(ed?.to in nodes) || ed.from === ed.to) fail('adjust-graph', `edge ${String(ed?.from)} → ${String(ed?.to)} names an unknown node or loops`)
      const outs = new Map<string, string[]>()
      for (const ed of edges) outs.set(ed.from, [...(outs.get(ed.from) ?? []), ed.to])
      if (hasCycle(Object.keys(nodes), x => outs.get(x) ?? [])) fail('adjust-graph', 'the adjusted graph has a cycle')
      if (Object.values(nodes).some(n => n.type === 'delegate')) fail('adjust-graph', 'delegate nodes are not executed; an adjustment does not add one')
      for (const nid of Object.keys(nodes)) if (!(nid.startsWith('_') ? /^_[a-z0-9_.-]+$/.test(nid) : ID_PATTERN.test(nid))) fail('adjust-graph', `node id "${nid}" is invalid`)
      // Work that is not pending keeps its identity, meaning and dependencies.
      const incoming = (g: { edges: Edge[] }, nid: string) => g.edges.filter(x => x.to === nid).map(x => x.from).sort()
      for (const [nid, rec] of Object.entries(s.nodes)) {
        if (rec.state === 'pending') continue
        const what = Object.values(s.questions).some(q => q.node === nid && ['open', 'answered'].includes(questionState(q))) ? 'adjust-question' : nid.startsWith('_') ? 'adjust-generated' : 'adjust-started'
        if (!nodes[nid]) fail(what, `${nid} is ${rec.state}; started, waiting or finished work is not removed`)
        if (canonicalJson(nodes[nid]) !== canonicalJson(graph.nodes[nid])) fail(what, `${nid} is ${rec.state}; its type, step and meaning stay as they were`)
        if (canonicalJson(incoming({ edges }, nid)) !== canonicalJson(incoming(graph, nid))) fail('adjust-dependencies', `${nid} is ${rec.state}; the work it waited for (${incoming(graph, nid).join(', ') || 'nothing'}) stays its dependency`)
      }
      if (canonicalJson({ nodes, edges }) === canonicalJson({ nodes: graph.nodes, edges: graph.edges })) fail('adjust-nothing', 'the adjustment changes no executable work (appearance and layout alone are not adjustments)')
      // Authorized by the person's records.
      if (source.kind === 'answer') {
        const q = question(source.question)
        if (!q.takenUp) fail('adjust-unauthorized', `${q.id} has no answer taken up; an adjustment from an answer follows the answer the executor took up`)
        if (source.answer !== undefined && source.answer !== q.takenUp!.answer) fail('adjust-unauthorized', `answer ${source.answer} of ${q.id} is not the one taken up`)
      } else if (source.kind === 'instruction') {
        const ins = s.instructions?.[source.instruction]
        if (!ins) fail('adjust-unauthorized', `instruction "${source.instruction}" does not exist in this run`)
        if (!ins!.ack) fail('adjust-unauthorized', `instruction ${source.instruction} is not acknowledged; acknowledge it (wfe run ack) before adjusting the run for it`)
      } else if (source.kind === 'agreement') {
        const q = question(source.question)
        if (!q.takenUp) fail('adjust-unauthorized', `${q.id} has no answer taken up; agreement is an answer that was taken up`)
        if (!q.document || q.document.sha256 !== e.sha256) fail('adjust-unauthorized', `${q.id} did not ask about this exact definition (the proposal's hash differs); ask about the proposal you apply`)
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
        if (s.execution.state === 'completed') fail('run-completed', 'the run\'s execution is completed; its presentations are not served again')
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
    default:
      fail('op-unknown', `unknown operation "${(e as { op: string }).op}"`)
  }

  // The plan step completes on agreement to the plan.md it completes with: a
  // question from the step, asked about that same content, whose answer was
  // taken up. A withdrawal, or agreement to an earlier revision, is not it.
  function agreedPlan(step: string, doc: DocumentEvidence, named: unknown): string {
    if (named !== undefined && (typeof named !== 'string' || !(named in s.questions))) fail('question-unknown', `question "${String(named)}" does not exist in this run`)
    // Questions keep their asking order; a later question supersedes the
    // answers to earlier ones.
    const latest = Object.values(s.questions).filter(q => q.node === step).at(-1)
    const q = named ? s.questions[named as string] : latest
    if (!q) return fail('plan-not-agreed', `${step} has asked nothing; ask the person to agree to plan.md first`)
    if (q.node !== step) fail('plan-not-agreed', `question ${q.id} was not asked from ${step}`)
    if (q !== latest) fail('plan-not-agreed', `question ${latest!.id} was asked after ${q.id}; agreement is the answer to the latest question about the plan`)
    if (!q.takenUp) fail('plan-not-agreed', `question ${q.id} is ${questionState(q)}; agreement is an answer that was taken up`)
    if (!q.document || q.document.sha256 !== doc.sha256) fail('plan-not-agreed', `plan.md changed since question ${q.id} asked about it; ask about the current plan`)
    return q.id
  }

  // A node boundary: refused while a received instruction is unacknowledged.
  // Input applied before this entry (the run's lock orders them) is seen
  // here; input applied after it belongs to the next boundary.
  function boundary(what: string) {
    const pending = pendingInstructions(s)
    if (!pending.length) return
    fail('instructions-pending', `${what} is a node boundary, and ${pending.length === 1 ? 'an instruction was' : `${pending.length} instructions were`} received and not acknowledged: ${pending.map(i => `${i.id} from ${i.from} (${i.at}): "${i.text.replace(/\s+/g, ' ').slice(0, 200)}"`).join('; ')}. Read ${pending.length === 1 ? 'it' : 'them'} (wfe run instructions <run>) and record what you will do: wfe run ack <run> ${pending.map(i => i.id).join(' ')} --response incorporate|clarify|new-run --note "…"; then retry.`)
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
  history.forEach((raw, i) => {
    if (!isObj(raw)) fail('shape', `history entry ${i + 1} is not an object`)
    const e = raw as HistoryEntry
    if (e.seq !== i + 1) fail('sequence', `history entry ${i + 1} has seq ${String(e.seq)}; expected ${i + 1}`)
    if (!(OPS as readonly string[]).includes(e.op)) fail('op-unknown', `history ${e.seq}: unknown operation "${String(e.op)}"`)
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
  for (const k of ['attempt', 'receipt'] as const) if (input[k] === undefined || input[k] === null) delete input[k]
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
// the execution host.
export type Situation = 'executing' | 'stopping' | 'awaiting-person' | 'stopped' | 'interrupted' | 'unknown' | 'completed' | 'cancelled' | 'not-started' | 'idle'
export function situation(s: Pick<RunState, 'control' | 'execution' | 'cancelled'>): Situation {
  if (s.cancelled) return 'cancelled'
  if (s.control.attempt) return s.control.stop ? 'stopping' : 'executing'
  if (s.control.hold) return s.control.hold.kind
  if (s.execution.state === 'completed') return 'completed'
  if (s.execution.waiting.length) return 'awaiting-person'
  if (s.execution.state === 'not-started') return 'not-started'
  return 'idle'
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
}
// The hold an entry recorded, as the reducer worded it at that point (the
// state keeps only the current hold): replayed from the frozen graph.
function holdReason(r: RunRecord, seq: number): string {
  const lastHold = [...r.history].reverse().find(h => h.change.hold?.[1])
  if (lastHold?.seq === seq && r.control.hold) return r.control.hold.reason
  const eff = r.definition.effective
  if (!eff) return ''
  try { return replay(r.history.slice(0, seq), { nodes: eff.nodes, edges: eff.edges }).state.control.hold?.reason ?? '' } catch { return '' }
}

export function notableEvents(r: RunRecord, sinceSeq = 0): NotableEvent[] {
  const out: NotableEvent[] = []
  const eff = r.definition.effective
  const reporting = eff?.policy === 'default'
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
    if (e.change.hold?.[1]) push('held', true, holdReason(r, e.seq) || d.detail || d.reason || e.change.hold[1], { hold: e.change.hold[1] })
    if (e.op === 'run.resume') push('resumed', false, d.reason)
    if (e.change.execution?.[1] === 'completed' && !(step?.kind === 'final-report')) push('completed', true, d.outcome ?? 'every node completed', e.op === 'node.complete' && !step ? { node: d.node } : {})
    if (e.op === 'run.decide') {
      const dec = r.decisions.find(x => x.at === e.at && x.by === e.by && x.decision === d.decision)
      push('decided', true, dec?.evidence ?? d.evidence ?? '', { decision: d.decision as 'accepted' | 'rejected', ...(dec?.confirmation ? { confirmation: { question: dec.confirmation.question, from: dec.confirmation.from }, subject: dec.confirmation.presentation ? [] : dec.confirmation.subject.map(x => x.path), ...(dec.confirmation.presentation ? { presentation: dec.confirmation.presentation.id } : {}) } : {}) })
    }
    if (e.op === 'instruction.receive') push('instructed', false, d.text, { instructions: [e.change.instruction?.[1] ?? ''], holder: r.executor.name })
    if (e.op === 'instruction.ack') push('acknowledged', false, d.note, { instructions: (e as unknown as { instructions: string[] }).instructions, response: d.response })
    if (e.op === 'run.cancel') push('cancelled', true, d.reason)
    if (e.op === 'run.adjust') {
      const diff = (e as unknown as { diff?: AdjustDiff }).diff ?? r.definition.revisions?.find(x => x.revision === d.revision)?.diff
      push('adjusted', false, d.reason, { revision: d.revision, ...(diff ? { adjusted: { added: diff.added.filter(x => !x.startsWith('_')), removed: diff.removed.filter(x => !x.startsWith('_')) } } : {}) })
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
