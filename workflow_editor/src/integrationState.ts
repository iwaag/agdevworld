// Where a run's accepted result stands (p9, docs/integration.md), in the
// person's words. No DOM: the run view and the tests use it alike.
import type { RunResponse } from '../shared/api.ts'
import type { RunRecord } from '../shared/run.ts'
import type { RunExecView } from './api.ts'

// Saved, accepted, partially integrated, integrated (p9, docs/integration.md):
// four separate facts, said apart. Null for a run without a copy of its own
// (what it published is already on the project's branches).
export function integrationStatus(rec: RunRecord, exec: RunExecView | null, place: RunResponse['place']): { tone: 'ok' | 'warn' | 'muted' | 'error'; text: string; detail?: string } | null {
  if (place?.kind !== 'run-copy' || !rec.storage) return null
  const di = rec.decisions.length - 1
  const last = rec.decisions[di]
  const done = (rec.integrations ?? []).find(i => i.decision === di)
  const targets = [...new Set(rec.storage.repositories.filter(r => r.branch).map(r => r.target).filter(Boolean))].join(', ') || 'the shared branch'
  if (done) return { tone: 'ok', text: `Integrated into ${targets}`, detail: done.repositories.map(r => `${r.path === '.' ? 'root' : r.path}: ${r.method} ${r.result.slice(0, 10)}`).join(' · ') }
  const row = exec?.integrations?.filter(i => i.decision === di).at(-1)
  if (!last || last.decision !== 'accepted') return { tone: 'muted', text: rec.execution.state === 'completed' ? `Saved on its branch — not integrated (no accepted result)` : 'Saved on its branch', detail: rec.storage.branch }
  if (!row) return { tone: 'warn', text: 'Accepted — not integrated yet' }
  const reached = row.steps.filter(st => st.state === 'done' && st.method !== 'already').map(st => st.repo === '.' ? 'root' : st.repo)
  if (row.state === 'queued') return { tone: 'muted', text: rec.execution.state === 'completed' ? 'Accepted — integration queued' : 'Accepted — integrated once the run is completed' }
  if (row.state === 'running') return { tone: 'muted', text: 'Accepted — integrating…' }
  if (row.state === 'partial') return { tone: 'error', text: `Partially integrated (${reached.join(', ')} done)`, detail: row.error ?? undefined }
  return { tone: row.state === 'refused' ? 'warn' : 'error', text: `Accepted — not integrated: ${row.state === 'needs-agreement' ? 'needs agreement' : row.state}`, detail: row.error ?? undefined }
}

