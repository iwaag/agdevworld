// Human review (workflow_editor p17, docs/reviews.md): a person's review of
// completed work, kept apart from an agent's acceptance of it. The run's
// agent prepares a round on a `review` node — a summary and the
// presentations to look at, frozen by revision — and its work is done; no
// process waits. WFE then manages the round for the person: one Start
// review starts every subject through its owning run, the person approves
// or requests changes, and approval stops what the review started. Requested
// changes close the round and hand the work back to the responsible agent,
// which appends work and a new review node.
//
// This module holds the round's shape and what a reader derives from it.
// The reducer (shared/run.ts) applies the review.* operations; the file and
// host layer (server/reviews.ts) resolves subjects, starts and stops
// presentations and records what it observed. Pure: no files, no stores.
import type { Because, RevisionEntry } from './run.ts'

export const REVIEW_ID = /^rv[0-9]{1,4}$/
// awaiting: prepared, nothing started; starting: a start was asked for and
// the host is starting the subjects; reviewing: every subject answered;
// start-failed: some did not (retryable, nothing rebuilt); approved: the
// person's decision is recorded and cleanup is pending or failed;
// complete: cleanup verified, the node is done; changes-requested: the
// round closed with the person's feedback; cancelled: the run was cancelled.
export const REVIEW_STATES = ['awaiting', 'starting', 'reviewing', 'start-failed', 'approved', 'complete', 'changes-requested', 'cancelled'] as const
export type ReviewState = typeof REVIEW_STATES[number]
export const REVIEW_OUTCOMES = ['approved', 'changes'] as const
export type ReviewOutcome = typeof REVIEW_OUTCOMES[number]

// One presentation the person reviews, frozen when the round was prepared:
// its owning run (by workspace and creation-qualified identity), the
// presentation and manifest revision, and what result it represents — a
// delegated result (event and manifest digest) and the trees of the
// owning run's repositories then.
export interface ReviewSubject {
  n: number
  workspace: string
  project: string
  workflow: string
  run: string
  creation: string
  presentation: string
  revision: string // the presentation's manifest digest
  title: string
  delegation?: string // the reviewing run's delegation it came back through
  result?: { event: number; manifest: string | null; childSeq: number }
  repositories?: RevisionEntry[]
}
export const subjectRun = (x: Pick<ReviewSubject, 'project' | 'workflow' | 'run'>) => `${x.project}/${x.workflow}/${x.run}`
export const subjectLabel = (x: ReviewSubject) => `${subjectRun(x)} ${x.presentation}`

// What the host found when it started (or reused) a subject's instance for
// the latest start request. `mode`: started for this review, or an
// instance already serving it that the review uses.
export interface SubjectServing { subject: number; start: number; status: 'available' | 'failed'; instance: string | null; mode: 'started' | 'reused' | null; detail: string; at: string }
// What cleanup did with an instance: stopped (verified), stop-failed
// (retried), kept (another active review needs it, or the person asked to
// keep it), left (it serves its own run's unfinished review).
export interface CleanupResult { subject: number; instance: string | null; status: 'stopped' | 'stop-failed' | 'kept' | 'left'; detail: string; at: string }

export interface ReviewDecision {
  outcome: ReviewOutcome
  by: string // whose decision: the person (or an identified synthetic actor)
  at: string
  via: string
  seq: number
  feedback: string
  subjects: { n: number; revision: string }[] // exactly what it is about
  synthetic?: boolean // a check actor standing in for nobody's real review
  relayed?: { by: string; because: Because } // an agent recorded the person's own words
}

export interface ReviewRound {
  id: string
  uid: string // <run uid>/<id>
  node: string
  previous: string | null // the round whose requested changes this one answers
  prepared: { at: string; by: string; attempt: string | null; seq: number }
  summary: string
  responsible: string // the agent the outcome goes back to
  reviewer: string | null // the person it waits for
  subjects: ReviewSubject[]
  state: ReviewState
  starts: { n: number; at: string; by: string; via: string; seq: number }[]
  serving: SubjectServing[] // latest per subject
  decision: ReviewDecision | null
  // Cleanup after approval (or of a cancelled round); `owner` after requested
  // changes: who stops the instances the review started (the responsible
  // agent, which may keep them for comparison).
  cleanup: { state: 'pending' | 'failed' | 'done' | 'handed'; owner: string; results: CleanupResult[]; attempts: number } | null
  // After requested changes: the responsible agent read the feedback, and
  // the run has work again (or the agent recorded that nothing changes).
  // `during`: the attempt open when the decision was recorded (one that
  // arrived before an attempt and was left unaddressed holds the run).
  continuation: { takenUp: { at: string; by: string; attempt: string | null; note: string } | null; addressed: { seq: number; at: string; how: 'work' | 'no-change' } | null; during: string | null } | null
  cancelled?: { at: string; by: string; reason: string }
}

export const OPEN_REVIEW_STATES: readonly ReviewState[] = ['awaiting', 'starting', 'reviewing', 'start-failed']
// The person still has the move: prepared and not decided.
export const isAwaitingPerson = (r: Pick<ReviewRound, 'state'>) => OPEN_REVIEW_STATES.includes(r.state)
// WFE still has host work to do for it: starting, or cleanup owed.
export const hostOwes = (r: Pick<ReviewRound, 'state' | 'cleanup'>) => r.state === 'starting' || (!!r.cleanup && (r.cleanup.state === 'pending' || r.cleanup.state === 'failed'))
// Requested changes the responsible agent has not addressed yet.
export const owedContinuation = (r: Pick<ReviewRound, 'state' | 'continuation'>) => r.state === 'changes-requested' && !!r.continuation && !r.continuation.addressed
export const openContinuations = (s: { reviews?: Record<string, ReviewRound> }): ReviewRound[] => Object.values(s.reviews ?? {}).filter(owedContinuation)
export const awaitingReviews = (s: { reviews?: Record<string, ReviewRound> }): ReviewRound[] => Object.values(s.reviews ?? {}).filter(isAwaitingPerson)
// The latest round of a node (a review node holds one round; a new round is a new node).
export const roundOf = (s: { reviews?: Record<string, ReviewRound> }, node: string): ReviewRound | undefined => Object.values(s.reviews ?? {}).filter(r => r.node === node).at(-1)
// Instances a round's review started and has not seen stopped or kept.
export function startedInstances(r: Pick<ReviewRound, 'serving' | 'cleanup'>): SubjectServing[] {
  const done = new Set((r.cleanup?.results ?? []).filter(c => c.status === 'stopped' || c.status === 'kept').map(c => c.instance))
  return r.serving.filter(x => x.status === 'available' && x.instance && x.mode === 'started' && !done.has(x.instance))
}
// The rounds that still name a presentation of a given run (for retention
// and for assessments): open, approved with cleanup owed, or handed to the agent.
export function roundsUsing(s: { reviews?: Record<string, ReviewRound> }, owner: { project: string; workflow: string; run: string }, presentation?: string): ReviewRound[] {
  return Object.values(s.reviews ?? {}).filter(r => r.state !== 'complete' && r.state !== 'cancelled' && !(r.state === 'changes-requested' && r.cleanup?.state === 'done')
    && r.subjects.some(x => x.project === owner.project && x.workflow === owner.workflow && x.run === owner.run && (!presentation || x.presentation === presentation)))
}

const STATE_WORDS: Record<ReviewState, string> = {
  awaiting: 'Awaiting human review',
  starting: 'Starting the review',
  reviewing: 'In review',
  'start-failed': 'Review start failed',
  approved: 'Approved · cleanup pending',
  complete: 'Approved · complete',
  'changes-requested': 'Changes requested',
  cancelled: 'Cancelled',
}
export function reviewStateText(r: ReviewRound): string {
  if (r.state === 'approved' && r.cleanup?.state === 'failed') return 'Approved · cleanup failed (retried)'
  if (r.state === 'changes-requested' && r.continuation?.addressed) return `Changes requested · ${r.continuation.addressed.how === 'no-change' ? 'answered without changes' : 'work added'}`
  return STATE_WORDS[r.state]
}

// One line per round, for briefs, `wfe review list` and messages.
export function roundLine(r: ReviewRound): string {
  const who = r.decision ? ` — ${r.decision.outcome === 'approved' ? 'approved' : 'changes requested'} by ${r.decision.by}${r.decision.synthetic ? ' (synthetic check actor)' : ''}${r.decision.relayed ? ` (relayed by ${r.decision.relayed.by})` : ''}` : r.reviewer ? `, for ${r.reviewer}` : ''
  return `${r.id} on ${r.node}: ${reviewStateText(r)}${who}; ${r.subjects.length} subject${r.subjects.length === 1 ? '' : 's'} (${r.subjects.map(subjectLabel).join(', ')})`
}
