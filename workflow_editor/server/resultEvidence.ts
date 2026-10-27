// The file layer of the evidence guidance (tidy p2, shared/resultEvidence.ts):
// what the run's copy shows it changed, removed and published, and the advice
// its agent is given as the result goes back. Printed with the operation that
// reaches that point; it refuses nothing and records nothing.
import { roleOf } from '../shared/reminders.ts'
import { producerLines, templatesOf, workContext } from '../shared/resultEvidence.ts'
import { graphOfState, runFolder, type RunRecord, type RunRef } from '../shared/run.ts'
import { changedPaths } from './reminders.ts'
import { activeDefinition, readRun } from './runs.ts'
import type { Workspace } from './workspace.ts'

// Where a run's result starts going back:
// - `start <step>` of its final-report step (the report is about to be
//   written: protoprey freework/run-006 wrote "Report written" for a report
//   that did not exist, and run-007 reported a test count its new test was
//   not part of);
// - the completion after which only reporting is left (documentation steps,
//   present, cleanup, review, the result confirmation), when no final-report
//   step is pending to say it.
// Null elsewhere, so the advice is given once, not on every command.
export async function producerAdvice(ws: Workspace, ref: RunRef, at: { started?: string; completed?: string }): Promise<string[] | null> {
  const reading = await readRun(ws, ref)
  const r = reading.record
  if (!r || r.execution.state === 'completed' || r.standing) return null
  const graph = graphOfState(r)
  if (!graph) return null
  const authored = activeDefinition(r, reading.bundle).workflow
  const finalStep = Object.keys(graph.nodes).find(id => graph.nodes[id].step?.kind === 'final-report')
  if (at.started) {
    if (graph.nodes[at.started]?.step?.kind !== 'final-report') return null
  } else if (at.completed) {
    const reporting = (id: string) => ['step', 'present', 'cleanup', 'review', 'confirm'].includes(roleOf(id, r, graph, authored))
    if (reporting(at.completed)) return null
    if (finalStep && r.nodes[finalStep]?.state === 'pending') return null
    const left = Object.keys(r.nodes).filter(id => !['completed', 'cancelled'].includes(r.nodes[id].state))
    if (!left.length || !left.every(reporting)) return null
  } else return null
  return producerLines({ context: await contextOf(ws, r, authored), requester: r.input.kind === 'request' ? r.input.requester ?? null : null, report: finalStep ? `${runFolder(r)}/${graph.nodes[finalStep].step!.output}` : null })
}

async function contextOf(ws: Workspace, r: RunRecord, authored: Parameters<typeof templatesOf>[1]) {
  const paths = await changedPaths(ws, r).catch(() => null) ?? []
  return workContext({ templates: templatesOf(r, authored), changed: paths.map(p => p.path), removed: paths.filter(p => p.mtime === null).map(p => p.path), outputs: Object.keys(r.outputs ?? {}) })
}
