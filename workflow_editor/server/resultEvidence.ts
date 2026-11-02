// The file layer of the evidence guidance (tidy p2, shared/resultEvidence.ts):
// what the run's copy shows it changed, removed and published, and the advice
// its agent is given as the result goes back. Printed with the operation that
// reaches that point; it refuses nothing and records nothing.
import { roleOf } from '../shared/reminders.ts'
import { producerLines, templatesOf, workContext } from '../shared/resultEvidence.ts'
import { graphOfState, runFolder, type RunRecord, type RunRef } from '../shared/run.ts'
import { changedPaths } from './reminders.ts'
import { activeDefinition, readRun } from './runs.ts'
import { runSpace } from './runspace.ts'
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
  // The run's own copy, where its changes are (evidence-fixture/run-003: read
  // against the project workspace, nothing was chosen).
  const space = await runSpace(ws, ref).catch(() => ws)
  const lines = producerLines({ context: await contextOf(space, r, authored), requester: r.input.kind === 'request' ? r.input.requester ?? null : null, report: finalStep ? `${runFolder(r)}/${graph.nodes[finalStep].step!.output}` : null })
  return [...lines, ...await changedWorkflowLines(space, r)]
}

// A workflow this run changed and that does not validate in its copy: said while
// the agent can still correct it (improve_wfrun p2; gimmickimg freework/run-018
// added one it had not validated). Only its own content: peers are not read here.
async function changedWorkflowLines(space: Workspace, r: RunRecord): Promise<string[]> {
  const paths = await changedPaths(space, r).catch(() => null) ?? []
  const out: string[] = []
  for (const p of paths) {
    const m = /^devdocs\/workflows\/([^/]+\.ya?ml)$/.exec(p.path)
    if (!m || p.mtime === null) continue
    const res = await space.workflowResponse(m[1]).catch(() => null)
    if (!res) continue
    const errors = res.workflow ? res.issues.filter(i => i.severity === 'error') : [{ message: res.problem?.message ?? 'it cannot be read' }]
    if (errors.length) out.push(`  · ${p.path} does not validate, so the workflow would be published but could not run: ${errors.map(e => e.message).join('; ')}`)
  }
  return out
}

async function contextOf(ws: Workspace, r: RunRecord, authored: Parameters<typeof templatesOf>[1]) {
  const paths = await changedPaths(ws, r).catch(() => null) ?? []
  return workContext({ templates: templatesOf(r, authored), changed: paths.map(p => p.path), removed: paths.filter(p => p.mtime === null).map(p => p.path), outputs: Object.keys(r.outputs ?? {}) })
}
