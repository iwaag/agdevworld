// Where a run's result stands with the person (project_migration p3/ex1):
// the result review, the decision, and the integration of an accepted
// result (p9, docs/integration.md). One reading of the record and this
// host's integration journal, used alike by the run view's header and
// focus card, the CLI's `integrate --status` and the tests. No DOM.
import { questionState, type Question, type RunRecord } from './run.ts'

// The integration journal as this host reports it (exec.sqlite rows).
export interface IntegrationRowLike {
  id: number; decision: number; state: string; error: string | null; updated?: string
  steps: { repo: string; state: string; method?: string; files?: string[] }[]
}
type Place = { kind: 'run-copy'; branch: string | null } | { kind: 'project' } | undefined
type Tone = 'ok' | 'warn' | 'muted' | 'error'
export interface IntegrationStatus { tone: Tone; text: string; detail?: string; state: 'none' | 'integrated' | 'queued' | 'running' | 'partial' | 'needs-agreement' | 'target-changed' | 'problem' | 'unbound'; decision: number; changed?: string[] }

const repoName = (p: string) => (p === '.' ? 'root' : p)

// The journal row that speaks for a decision: its latest row. A row is
// never read for another decision, and run.json's record of a completed
// integration outranks whatever a row says (it is written last).
export function currentRow(rows: IntegrationRowLike[] | undefined, decision: number): IntegrationRowLike | undefined {
  return (rows ?? []).filter(i => i.decision === decision).sort((a, b) => a.id - b.id).at(-1)
}

// Saved, accepted, partially integrated, integrated (p9): separate facts,
// said apart, for the latest decision only. Null for a run without a copy
// of its own (what it published is already on the project's branches).
export function integrationStatus(rec: RunRecord, exec: { integrations?: IntegrationRowLike[] } | null, place: Place): IntegrationStatus | null {
  if (place?.kind !== 'run-copy' || !rec.storage) return null
  const di = rec.decisions.length - 1
  const last = rec.decisions[di]
  const targets = [...new Set(rec.storage.repositories.filter(r => r.branch).map(r => r.target).filter(Boolean))].join(', ') || 'the shared branch'
  const done = (rec.integrations ?? []).find(i => i.decision === di)
  if (done) return { state: 'integrated', decision: di, tone: 'ok', text: `Integrated into ${targets}`, detail: done.repositories.map(r => `${repoName(r.path)}: ${r.method} ${r.result.slice(0, 10)}`).join(' · ') }
  if (!last || last.decision !== 'accepted') return { state: 'none', decision: di, tone: 'muted', text: rec.execution.state === 'completed' ? 'Saved on its branch — not integrated (no accepted result)' : 'Saved on its branch', detail: rec.storage.branch }
  // An acceptance recorded before p9 names no revision: it cannot be integrated.
  if (!last.revision) return { state: 'unbound', decision: di, tone: 'warn', text: 'Accepted before integration existed — accept again to integrate', detail: 'the acceptance names no revision' }
  const row = currentRow(exec?.integrations, di)
  // The same result integrated under an earlier acceptance (recorded before
  // duplicate acceptances were refused): integrated, said with its decision.
  if (row?.state === 'superseded') {
    const earlier = (rec.integrations ?? []).at(-1)
    if (earlier) return { state: 'integrated', decision: di, tone: 'ok', text: `Integrated into ${targets}`, detail: `as decision ${earlier.decision}; ${row.error ?? ''}`.trim() }
  }
  if (!row) return { state: 'queued', decision: di, tone: 'muted', text: rec.execution.state === 'completed' ? 'Accepted — integration not queued yet' : 'Accepted — integrated once the run is completed' }
  if (row.state === 'queued') return { state: 'queued', decision: di, tone: 'muted', text: rec.execution.state === 'completed' ? 'Accepted — integration queued' : 'Accepted — integrated once the run is completed' }
  if (row.state === 'running') return { state: 'running', decision: di, tone: 'muted', text: 'Accepted — integrating…' }
  if (row.state === 'partial') {
    const reached = row.steps.filter(st => st.state === 'done' && st.method !== 'already').map(st => repoName(st.repo))
    return { state: 'partial', decision: di, tone: 'error', text: `Partially integrated (${reached.join(', ')} done)`, detail: row.error ?? undefined }
  }
  if (row.state === 'needs-agreement') {
    const changed = [...new Set(row.steps.flatMap(st => st.state === 'needs-agreement' ? (st.files ?? []).map(f => (st.repo === '.' ? f : `${st.repo}/${f}`)) : []))]
    return { state: 'needs-agreement', decision: di, tone: 'warn', text: 'The result changed after it was accepted — accept it again to integrate', detail: row.error ?? undefined, changed }
  }
  // A guarded binding's target changed since the run built on it
  // (project_migration p4): the result is not published; a successor run
  // reassesses it against the current target.
  if (row.state === 'target-changed') {
    const changed = [...new Set(row.steps.flatMap(st => st.state === 'target-changed' ? (st.files ?? []).map(f => (st.repo === '.' ? f : `${st.repo}/${f}`)) : []))]
    return { state: 'target-changed', decision: di, tone: 'warn', text: 'Not integrated: the target changed since this run prepared its result — reassess it in a successor run', detail: row.error ?? undefined, changed }
  }
  return { state: 'problem', decision: di, tone: row.state === 'refused' ? 'warn' : 'error', text: `Accepted — not integrated: ${row.state}`, detail: row.error ?? undefined }
}

// The person's part in the result, now: what the header says and which
// control the focus card offers beside it.
export type ApprovalKind = 'none' | 'review' | 'answered' | 'decide' | 'rejected' | 'accepted' | 'reaccept' | 'integrating' | 'integration-problem' | 'integrated'
export interface Approval {
  kind: ApprovalKind
  chip: string | null // the header's decision chip (null: none shown)
  tone: Tone
  canAccept: boolean // an acceptance would record something new
  integration: IntegrationStatus | null
  question?: Question // the review question (review, answered)
}

// `review(q)`: whether a question presents the result (asked from a
// `confirms: result` node or about a presentation).
export function approvalOf(rec: RunRecord, exec: { integrations?: IntegrationRowLike[] } | null, place: Place, review: (q: Question) => boolean): Approval {
  const integration = integrationStatus(rec, exec, place)
  const last = rec.decisions.at(-1)
  const completed = rec.execution.state === 'completed'
  const base = { integration, canAccept: false }
  if (rec.cancelled) return { ...base, kind: 'none', chip: last ? (last.decision === 'accepted' ? 'Accepted' : 'Rejected') : null, tone: last?.decision === 'accepted' ? 'ok' : 'muted' }
  // A review question the person has not answered, or whose answer the
  // executor has not taken up yet: the answer is the person's path, not a
  // second, direct acceptance.
  const reviews = Object.values(rec.questions).filter(review)
  const open = reviews.find(q => questionState(q) === 'open')
  if (open) return { ...base, kind: 'review', chip: 'Review needed', tone: 'warn', question: open }
  const answered = reviews.find(q => questionState(q) === 'answered')
  if (answered) return { ...base, kind: 'answered', chip: `Answer recorded · waiting for ${rec.executor.name}`, tone: 'muted', question: answered }
  if (!last) return completed ? { ...base, kind: 'decide', chip: 'Decision needed', tone: 'warn', canAccept: true } : { ...base, kind: 'none', chip: null, tone: 'muted' }
  if (last.decision === 'rejected') return { ...base, kind: 'rejected', chip: 'Rejected', tone: 'error', canAccept: completed }
  if (!completed) return { ...base, kind: 'accepted', chip: 'Accepted · cleanup pending', tone: 'ok' }
  if (!integration) return { ...base, kind: 'accepted', chip: 'Accepted', tone: 'ok' }
  switch (integration.state) {
    case 'integrated': return { ...base, kind: 'integrated', chip: 'Accepted · integrated', tone: 'ok' }
    case 'needs-agreement': return { ...base, kind: 'reaccept', chip: 'Changed since acceptance — accept again', tone: 'warn', canAccept: true }
    case 'target-changed': return { ...base, kind: 'integration-problem', chip: 'Accepted · target changed — reassess', tone: 'warn' }
    case 'unbound': return { ...base, kind: 'reaccept', chip: 'Accept again to integrate', tone: 'warn', canAccept: true }
    case 'queued': case 'running': return { ...base, kind: 'integrating', chip: 'Accepted · integrating', tone: 'ok' }
    default: return { ...base, kind: 'integration-problem', chip: 'Accepted · not integrated', tone: 'error' }
  }
}
