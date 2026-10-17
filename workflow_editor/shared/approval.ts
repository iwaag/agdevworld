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
  const targets = [...new Set(rec.storage.repositories.filter(r => r.branch).map(r => r.target).filter(Boolean))].join(', ') || 'the shared branch'
  const done = rec.integrations?.at(-1)
  const row = exec?.integrations?.at(-1)
  if (row && row.state !== 'integrated' && (!done || (row.updated && row.updated > done.at))) return { state: row.state === 'running' ? 'running' : row.state === 'queued' ? 'queued' : 'problem', decision: row.decision, tone: row.state === 'queued' || row.state === 'running' ? 'muted' : 'error', text: `Integration ${row.state}`, detail: row.error ?? undefined }
  if (done) return { state: 'integrated', decision: done.decision, tone: 'ok', text: `Integrated into ${targets}`, detail: done.repositories.map(r => `${repoName(r.path)}: ${r.method} ${r.result.slice(0, 10)}`).join(' · ') }
  return { state: 'none', decision: rec.seq, tone: 'muted', text: 'Saved on its branch — integration available', detail: rec.storage.branch }
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
  const question = Object.values(rec.questions).filter(review).find(q => questionState(q) === 'open' || questionState(q) === 'answered')
  const kind: ApprovalKind = question ? (questionState(question) === 'open' ? 'review' : 'answered') : integration?.state === 'integrated' ? 'integrated' : integration?.state === 'running' || integration?.state === 'queued' ? 'integrating' : integration?.state === 'problem' || integration?.state === 'partial' ? 'integration-problem' : last?.decision ?? 'none'
  return { kind, integration, canAccept: !rec.cancelled, tone: kind === 'integration-problem' ? 'error' : 'muted', chip: last ? (last.decision === 'accepted' ? 'Accepted' : 'Rejected') : null, ...(question ? { question } : {}) }
}
