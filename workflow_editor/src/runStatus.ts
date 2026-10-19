// The run's status for the run view (project_migration p8 ex1): the shared
// reading (shared/status.ts) given what this view has besides the record —
// the execution host's jobs, the children as read now, the node names.
import type { RunRecord } from '../shared/run.ts'
import { runStatus, type RunStatus } from '../shared/status.ts'
import type { DelegationsView, RunExecView } from './api.ts'

export function viewStatus(rec: RunRecord, o: { names?: Record<string, string>; exec?: RunExecView | null; delegations?: DelegationsView | null } = {}): RunStatus {
  const job = o.exec ? o.exec.jobs.find(j => j.state === 'queued' || j.state === 'claimed') ?? null : undefined
  const children = o.delegations ? Object.fromEntries(o.delegations.delegations.filter(d => d.childNow).map(d => [d.id, { situation: d.childNow!.situation, hold: d.childNow!.hold ?? null, execution: d.childNow!.execution, run: d.child?.run ?? null }])) : undefined
  return runStatus(rec, { names: o.names, ...(job !== undefined ? { job: job && { state: job.state as 'queued' | 'claimed', reason: job.reason } } : {}), ...(children ? { children } : {}) })
}
