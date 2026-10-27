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
// `correcting` (fix6): the child received a correction the parent returned
// its result with, and is open for it again (no wake: the next completion is
// what the parent waits for).
export const EVENT_TYPES = ['question', 'withdrawn', 'answer-refused', 'completed', 'failed', 'held', 'resumed', 'decided', 'integrated', 'cancelled', 'correcting'] as const
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
  revision?: number // answer-refused: the parent's correction request that was not applied; correcting: the one received (fix6)
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
// A completed result the parent returned to the same child for correction
// (fix6, `wfe delegate revise`): the result it returns (event and manifest
// digest), why, and what the child is asked to add. The child adds and
// performs the missing work itself; its next completion is a new result.
// tidy p3: `origin` is whose finding the correction is — the recording
// agent's own (`agent`, with what it checked in `evidence`), the person's
// words it relays (`person`, `because`), or a human review's requested
// changes (`review`). Records before p3 have none: read with originOf.
// `attributed`: later, explicit corrections of who the finding was (the
// original `from` stays as recorded).
export type CorrectionOrigin = 'agent' | 'person' | 'review'
export interface Attribution { origin: CorrectionOrigin; from: string; reason: string; by: string; at: string; seq: number }
export interface DelegationRevision { n: number; event: number; manifest: string | null; childSeq: number; instruction: string; reason: string; from: string; by: string; at: string; attempt: string | null; seq: number; because?: Because; origin?: CorrectionOrigin; evidence?: string; followUp?: string; attributed?: Attribution[] }

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
  revisions?: DelegationRevision[] // present once the first correction is requested (fix6)
  // p17: dispositions set aside by a follow-up after a person's requested
  // changes (the agent had judged the result satisfied; the person's review
  // asked for more). Kept in order; the delegation is open again.
  // tidy p3: or the agent's own finding (`origin: agent`, with its evidence).
  reopened?: { disposition: Disposition; review: string | null; because?: Because; origin?: CorrectionOrigin; evidence?: string; at: string; by: string; seq: number }[] // p17 a review's follow-up; p18 the person's words
  disposition: Disposition | null
  closed: { at: string; by: string; reason: string } | null
}

export const delegationFolder = (runFolder: string, id: string) => `${runFolder}/delegations/${id}`
export const isOpenDelegation = (d: Pick<Delegation, 'disposition' | 'closed'>) => !d.disposition && !d.closed
export const pendingEvents = (d: Pick<Delegation, 'events'>) => d.events.filter(e => e.wakes && !e.takenUp)

export type DelegationState = 'dispatching' | 'working' | 'attention' | 'result' | 'correcting' | 'stopped' | DispositionKind | 'orphaned'
export function delegationState(d: Delegation): DelegationState {
  if (d.disposition) return d.disposition.kind
  if (d.closed) return 'orphaned'
  if (pendingEvents(d).length) return 'attention'
  if (openRevision(d)) return 'correcting'
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
// The correction request that returned the latest result and still stands
// (fix6): no newer result came back, and the child did not refuse it.
// Whose finding a correction is, as last attributed (tidy p3). A record
// before p3 carries none: a follow-up is a review's, relayed words are the
// person's, anything else the recording agent's.
// A review's follow-up is known by the reopening recorded with the same
// entry (`d`); without it, a correction relaying no words is the agent's.
export function originOf(r: DelegationRevision, d?: Pick<Delegation, 'reopened'>): { origin: CorrectionOrigin; from: string; corrected: Attribution | null; review: string | null } {
  const a = r.attributed?.at(-1)
  const review = r.followUp ?? d?.reopened?.find(x => x.seq === r.seq && x.review)?.review ?? null
  if (a) return { origin: a.origin, from: a.from, corrected: a, review }
  return { origin: r.origin ?? (review ? 'review' : r.because ? 'person' : 'agent'), from: r.from, corrected: null, review }
}
export function originText(r: DelegationRevision, d?: Pick<Delegation, 'reopened'>): string {
  const o = originOf(r, d)
  const what = o.origin === 'agent' ? `${o.from}'s own finding${r.evidence ? ` (checked: ${r.evidence.replace(/\s+/g, ' ').slice(0, 160)})` : ''}`
    : o.origin === 'review' ? `${o.from}'s requested changes in human review ${o.review ?? ''}`.trim()
      : `${o.from}'s words, relayed by ${r.by}`
  return o.corrected ? `${what}; attributed so by ${o.corrected.by} at ${o.corrected.at} (${o.corrected.reason.replace(/\s+/g, ' ').slice(0, 160)}), recorded at first as from ${r.from}` : what
}

export function openRevision(d: Pick<Delegation, 'events' | 'revisions'>): DelegationRevision | undefined {
  const r = d.revisions?.at(-1)
  const latest = latestResult(d)
  if (!r || !latest || r.event !== latest.n) return undefined
  if (d.events.some(e => e.type === 'answer-refused' && e.revision === r.n)) return undefined
  return r
}

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
    if (h.op === 'correction.receive') {
      const dl = e.delegation as { uid?: string; revision?: number } | undefined
      if (dl?.uid === uid) push('correcting', `the child received correction ${String(h.change.correction?.[1] ?? '')} and is open for it again`, { revision: dl.revision })
    }
  }
  return out
}
