// Delegation (p10, docs/delegation.md): one run entrusting work to a run of
// another managed workflow. The relationship lives in the parent's run.json
// (`delegations.<d>`, reduced by shared/run.ts); this module holds its shape,
// the state a reader derives from it, and which facts of a child's history
// are relayed to the parent. Pure: no files, no stores, no clocks.
import type { Because, DocumentEvidence, RunRecord } from './run.ts'

export const DELEGATION_ID = /^d[0-9]{1,4}$/
export const DISPOSITIONS = ['satisfied', 'rejected', 'abandoned'] as const
export type DispositionKind = typeof DISPOSITIONS[number]

// Where a dispatch goes: identities, and the workspace resolved for it.
export interface DelegationTarget { project: string; workflow: string; workspace: string }
// The child once the intake created it from the request post.
export interface ChildRef { uid: string; workspace: string; project: string; workflow: string; run: string; created: string }
// The request post (a reference, not an identity).
export interface TransportRef { realm: string; message: number; stream: number; topic: string }

// Facts of the child relayed to the parent. `wakes`: the parent's agent is
// owed a look (a continuation is queued, and an attempt that ends without
// taking it up is interrupted); the others are recorded for the record.
export const EVENT_TYPES = ['question', 'withdrawn', 'answer-refused', 'completed', 'failed', 'held', 'resumed', 'decided', 'integrated', 'cancelled'] as const
export type DelegationEventType = typeof EVENT_TYPES[number]
export const WAKING: ReadonlySet<string> = new Set(['question', 'answer-refused', 'completed', 'failed', 'cancelled'])

// What the parent receives with a completed child: its outcome, its final
// report and artifacts by hash (and the published commit holding them, when
// one does), its latest decision and its branch. `digest` names the
// manifest a disposition judged.
export interface ManifestFile { path: string; sha256: string; bytes: number; commit: string | null }
export interface ResultManifest {
  digest: string // sha256:<hex> of the canonical manifest without it
  child: string // uid
  execution: string
  outcome: string
  report: ManifestFile | null
  artifacts: ManifestFile[]
  decision: { decision: string; by: string; at: string } | null
  branch: string | null
}

export interface DelegationEvent {
  n: number
  type: DelegationEventType
  at: string // when the parent recorded it
  seq: number // the parent's history entry
  during: string | null // the parent attempt open when it was recorded
  child: { seq: number; at: string; by: string } // the child's entry it comes from (seq 0: not from the child's history)
  wakes: boolean
  text: string
  question?: string
  to?: string
  confirms?: boolean // asked from the child's result-confirmation node
  plan?: boolean // asked from the child's plan step, or about its revised plan
  document?: DocumentEvidence // the child's plan.md (or proposal) the question asks about, by hash
  subject?: DocumentEvidence[] // what a result confirmation presents, by hash
  presentation?: { id: string; revision: string }
  answer?: number // answer-refused: the parent's answer that was not applied
  hold?: string
  decision?: string
  manifest?: ResultManifest
  takenUp: { at: string; by: string; attempt: string | null } | null
}
// What the parent's agent sent. `from` is whose words they are: the agent's
// own, or the person's it relays (`because`).
export interface DelegationAnswer { n: number; question: string; event: number; text: string; from: string; by: string; at: string; attempt: string | null; seq: number; because?: Because }
export interface DelegationInstruction { n: number; text: string; from: string; by: string; at: string; attempt: string | null; seq: number; because?: Because }
export interface Disposition { kind: DispositionKind; note: string; event: number | null; manifest: string | null; at: string; by: string }

export interface Delegation {
  id: string
  uid: string // <parent uid>/<id>
  node: string
  target: DelegationTarget
  targetDigest?: string // the target definition's digest the dispatch saw; the child freezes its own
  request: DocumentEvidence // delegations/<id>/request.md
  original?: DocumentEvidence // delegations/<id>/original-input.md
  requester: string
  onBehalfOf: string | null
  accepts: 'person' | 'parent'
  dispatched: { at: string; by: string; attempt: string | null; seq: number }
  predecessor?: string
  child: ChildRef | null
  transport: TransportRef | null
  events: DelegationEvent[]
  answers: DelegationAnswer[]
  instructions: DelegationInstruction[]
  disposition: Disposition | null
  closed: { at: string; by: string; reason: string } | null
}

export const delegationFolder = (runFolder: string, id: string) => `${runFolder}/delegations/${id}`
export const isOpenDelegation = (d: Pick<Delegation, 'disposition' | 'closed'>) => !d.disposition && !d.closed
export const pendingEvents = (d: Pick<Delegation, 'events'>) => d.events.filter(e => e.wakes && !e.takenUp)

export type DelegationState = 'dispatching' | 'working' | 'attention' | 'result' | 'stopped' | DispositionKind | 'orphaned'
export function delegationState(d: Delegation): DelegationState {
  if (d.disposition) return d.disposition.kind
  if (d.closed) return 'orphaned'
  if (pendingEvents(d).length) return 'attention'
  const last = [...d.events].reverse().find(e => ['completed', 'failed', 'cancelled', 'resumed'].includes(e.type))
  if (last?.type === 'completed') return 'result'
  if (last?.type === 'failed' || last?.type === 'cancelled') return 'stopped'
  return d.child ? 'working' : 'dispatching'
}
// The latest question event for a child question, and whether the child has
// closed it since (withdrawn, or an answer the intake could not apply).
export function questionEvent(d: Pick<Delegation, 'events'>, question: string): DelegationEvent | undefined {
  return [...d.events].reverse().find(e => e.type === 'question' && e.question === question)
}
export const latestResult = (d: Pick<Delegation, 'events'>) => [...d.events].reverse().find(e => e.type === 'completed')

// ---- relaying a child's history --------------------------------------------------

// One fact of the child's history the parent is told, with its receipt
// (`delegation:<uid>:<child seq>:<type>`: recorded once however often the
// relay passes). `manifest` is added by the file layer for `completed`.
// `due`: when the child's history made it tellable (a completion: when the
// attempt that completed it ended), for readers judging a delay.
export interface ChildFact { receipt: string; event: Omit<DelegationEvent, 'n' | 'at' | 'seq' | 'during' | 'wakes' | 'takenUp'>; due: string }
// A completed execution is told once the child's attempt that completed it
// has ended (or at once when it was completed outside an attempt), under the
// completing entry's identity: documentation steps reopen and recomplete
// the execution within one attempt, and front/converse/run-027 was told the
// one result of jevlab study/run-002 five times (project_migration p8 ex1).
// Reopened and completed again after that is a new result.
export function childFacts(uid: string, child: RunRecord, sinceSeq = 0): ChildFact[] {
  const out: ChildFact[] = []
  const graph = child.definition.revisions?.at(-1)?.effective ?? child.definition.effective
  let open = false // an attempt of the child is open
  let completing: { seq: number; at: string; by: string; text: string } | null = null // the latest entry that completed the execution
  let told = 0 // the completing entry last told
  for (const h of child.history) {
    if (h.op === 'attempt.begin') open = true
    if (h.op === 'attempt.end') open = false
    const exec = h.change.execution?.[1]
    if (exec === 'completed') completing = { seq: h.seq, at: h.at, by: h.by, text: String((h as unknown as { outcome?: unknown }).outcome ?? 'every node completed') }
    else if (exec) completing = null
    if (completing && !open && completing.seq !== told) {
      told = completing.seq
      if (h.seq > sinceSeq) out.push({ receipt: `delegation:${uid}:${completing.seq}:completed`, event: { type: 'completed', child: { seq: completing.seq, at: completing.at, by: completing.by }, text: completing.text }, due: h.at })
    }
    if (h.seq <= sinceSeq) continue
    const at = { seq: h.seq, at: h.at, by: h.by }
    const push = (type: DelegationEventType, text: string, extra: Partial<ChildFact['event']> = {}) =>
      out.push({ receipt: `delegation:${uid}:${h.seq}:${type}`, event: { type, child: at, text, ...extra }, due: h.at })
    const e = h as unknown as Record<string, unknown>
    if (h.op === 'question.ask') {
      const q = child.questions[e.question as string]
      const node = q?.node ? graph?.nodes[q.node] : undefined
      push('question', String(e.text ?? ''), {
        question: e.question as string, to: e.to as string,
        ...(node?.confirms === 'result' ? { confirms: true } : {}),
        ...(node?.step?.kind === 'plan' || e.plan ? { plan: true } : {}),
        ...(q?.document ? { document: q.document } : {}),
        ...(q?.subject ? { subject: q.subject } : {}),
        ...(q?.presentation ? { presentation: q.presentation } : {}),
      })
    }
    if (h.op === 'question.withdraw') push('withdrawn', String(e.reason ?? ''), { question: e.question as string })
    if (h.op === 'node.fail') push('failed', `${String(e.node)} failed: ${String(e.reason ?? '')}`)
    if (h.change.hold?.[1]) push('held', h.op === 'attempt.end' ? String(e.detail || e.outcome || '') : String(e.reason ?? ''), { hold: h.change.hold[1] })
    if (h.op === 'run.resume' || h.op === 'run.recover') push('resumed', String(e.reason ?? ''))
    if (h.op === 'run.decide') push('decided', String(e.evidence ?? e.note ?? ''), { decision: e.decision as string })
    if (h.op === 'run.integrate') push('integrated', 'the accepted result was integrated into the child project\'s shared branches')
    if (h.op === 'run.cancel') push('cancelled', String(e.reason ?? ''))
  }
  return out
}
