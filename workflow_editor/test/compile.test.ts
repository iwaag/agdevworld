// p5 step 1: the documentation policy in the definition contract and the
// shared compiler that turns an authored graph into a run's effective graph.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalStates, canonicalJson, semanticDigest } from '../shared/canonical.ts'
import { COMPILER_VERSION, compile, FINAL_STEP, isGenerated, PLAN_STEP, reportStep, splitCounts, type EffectiveGraph } from '../shared/compile.ts'
import { cloneWorkflow, emptyWorkflow, type Workflow } from '../shared/model.ts'
import { validateWorkflow } from '../shared/validate.ts'
import { newWorkflowText, parseWorkflow, renderWorkflow } from '../server/yamlDoc.ts'

function wf(nodes: string[], edges: [string, string][], policy = 'default'): Workflow {
  const w = emptyWorkflow('w', 'W')
  w.intent = 'Test.'
  w.documentation.policy = policy
  for (const id of nodes) w.nodes[id] = { type: id === 'check' ? 'talk' : 'do', name: '', description: id, repositories: [] }
  w.edges = edges.map(([from, to]) => ({ from, to }))
  return w
}
function ok(w: Workflow): EffectiveGraph {
  const r = compile(w)
  assert.ok(r.ok, !r.ok ? r.message : '')
  return r.graph
}
const edgeList = (g: EffectiveGraph) => g.edges.map(e => `${e.from}>${e.to}`).sort()

test('default policy: one plan talk, one report per authored node, one final report', () => {
  const g = ok(wf(['study', 'implement', 'check'], [['study', 'implement'], ['implement', 'check']]))
  assert.equal(g.compiler, COMPILER_VERSION)
  assert.equal(g.policy, 'default')
  assert.deepEqual(Object.keys(g.nodes).sort(), ['_final-report', '_plan', '_report.check', '_report.implement', '_report.study', 'check', 'implement', 'study'])
  assert.deepEqual(edgeList(g), [
    '_plan>study', '_report.check>_final-report', '_report.implement>check', '_report.study>implement',
    'check>_report.check', 'implement>_report.implement', 'study>_report.study',
  ].sort())
  assert.equal(g.nodes[PLAN_STEP].type, 'talk')
  assert.deepEqual(g.nodes[PLAN_STEP].step && { kind: g.nodes[PLAN_STEP].step.kind, output: g.nodes[PLAN_STEP].step.output }, { kind: 'plan', output: 'plan.md' })
  assert.deepEqual({ ...g.nodes[reportStep('study')].step, instructions: undefined, purpose: undefined }, { kind: 'report', for: 'study', output: 'report-study.md', instructions: undefined, purpose: undefined })
  assert.equal(g.nodes[FINAL_STEP].step?.output, 'report.md')
  assert.match(g.nodes[reportStep('study')].step!.instructions, /report-study\.md/)
  // Authored nodes keep their type and carry no step.
  assert.deepEqual(g.nodes.study, { type: 'do' })
  assert.deepEqual(g.nodes.check, { type: 'talk' })
})

test('branches and joins: each report gates its own successors, a join waits for every report', () => {
  const g = ok(wf(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]))
  const into = (id: string) => g.edges.filter(e => e.to === id).map(e => e.from).sort()
  assert.deepEqual(into('b'), ['_report.a'])
  assert.deepEqual(into('c'), ['_report.a'])
  assert.deepEqual(into('d'), ['_report.b', '_report.c'])
  assert.deepEqual(into(FINAL_STEP), ['_report.d'])
  assert.deepEqual(into('a'), [PLAN_STEP])
})

test('several entries and terminals share the one plan and the one final report', () => {
  const g = ok(wf(['x', 'y', 'z'], [['x', 'z']]))
  const into = (id: string) => g.edges.filter(e => e.to === id).map(e => e.from).sort()
  assert.deepEqual(g.edges.filter(e => e.from === PLAN_STEP).map(e => e.to).sort(), ['x', 'y'])
  assert.deepEqual(into(FINAL_STEP), ['_report.y', '_report.z'])
  assert.equal(Object.keys(g.nodes).filter(id => id === PLAN_STEP || id === FINAL_STEP).length, 2)
})

test('no report of a report: 2n + 2 steps, and the graph stays acyclic', () => {
  for (const n of [1, 2, 5]) {
    const ids = Array.from({ length: n }, (_, i) => `n${i}`)
    const g = ok(wf(ids, ids.slice(1).map((id, i) => [ids[i], id])))
    assert.equal(Object.keys(g.nodes).length, 2 * n + 2)
    assert.equal(Object.keys(g.nodes).filter(id => id.startsWith('_report._')).length, 0)
    for (const id of Object.keys(g.nodes)) if (isGenerated(id)) assert.ok(g.nodes[id].step, `${id} has its step`)
  }
})

test('generated ids never collide with authored ids', () => {
  // Authored ids that look like the generated ones without the underscore.
  const g = ok(wf(['plan', 'report.plan', 'final-report'], [['plan', 'report.plan']]))
  assert.equal(Object.keys(g.nodes).length, 3 * 2 + 2)
  assert.ok(g.nodes.plan && !g.nodes.plan.step)
  assert.ok(g.nodes['_report.report.plan'].step?.for === 'report.plan')
  for (const id of ['plan', 'report.plan', 'final-report']) assert.ok(!isGenerated(id))
})

test('manual policy: the effective graph is the authored graph', () => {
  const w = wf(['study', 'implement'], [['study', 'implement'], ['study', 'implement']], 'manual')
  const g = ok(w)
  assert.equal(g.policy, 'manual')
  assert.deepEqual(Object.keys(g.nodes).sort(), ['implement', 'study'])
  assert.deepEqual(g.edges, [{ from: 'study', to: 'implement' }]) // duplicates collapse
  assert.ok(Object.values(g.nodes).every(n => !n.step))
})

test('empty or invalid authored graphs are refused, not made executable by generated steps', () => {
  const codes = (w: Workflow) => { const r = compile(w); return r.ok ? 'ok' : r.code }
  assert.equal(codes(wf([], [])), 'nodes-empty')
  assert.equal(codes(wf([], [], 'manual')), 'nodes-empty')
  assert.equal(codes(wf(['a', 'b'], [['a', 'b'], ['b', 'a']])), 'graph-cycle')
  assert.equal(codes(wf(['a'], [['a', 'ghost']])), 'edge-broken')
  assert.equal(codes(wf(['a'], [['a', 'a']])), 'edge-self')
  assert.equal(codes(wf(['a'], [], 'always')), 'documentation-policy')
  assert.equal(codes(wf(['a'], [], '')), 'documentation-policy')
  const bad = wf(['a'], [])
  bad.nodes['_sneaky'] = { type: 'do', name: '', description: '', repositories: [] }
  assert.equal(codes(bad), 'node-id-invalid')
  // A delegate still compiles for the preview; execution refuses it elsewhere.
  const d = wf(['a'], [])
  d.nodes.a = { type: 'delegate', name: '', description: '', repositories: [], workflow: 'other' }
  assert.equal(ok(d).nodes.a.workflow, 'other')
})

test('compilation is deterministic: the same source gives the same graph', () => {
  const a = wf(['b', 'a', 'c'], [['b', 'c'], ['a', 'c']])
  const b = cloneWorkflow(a)
  b.edges.reverse()
  b.nodes = Object.fromEntries(Object.entries(b.nodes).reverse())
  b.layout.nodes.a = { x: 5, y: 9 }
  assert.equal(canonicalJson(ok(a)), canonicalJson(ok(b)))
})

test('the policy is validated and its absence is an error', () => {
  const codes = (w: Workflow) => validateWorkflow(w).filter(i => i.severity === 'error').map(i => i.code)
  assert.deepEqual(codes(wf(['a'], [])), [])
  assert.deepEqual(codes(wf(['a'], [], 'manual')), [])
  assert.deepEqual(codes(wf(['a'], [], '')), ['documentation-policy'])
  assert.deepEqual(codes(wf(['a'], [], 'sometimes')), ['documentation-policy'])
  const v1 = wf(['a'], [])
  v1.schema = 'ag.workflow.v1'
  const issue = validateWorkflow(v1).find(i => i.code === 'schema')!
  assert.match(issue.message, /ag\.workflow\.v2.*documentation/)
})

test('the policy is part of definition approval only', async () => {
  const w = wf(['a', 'b'], [['a', 'b']])
  w.approvals.intent = { digest: await semanticDigest('intent', w), approver: 't', at: 'now' }
  w.approvals.definition = { digest: await semanticDigest('definition', w), approver: 't', at: 'now' }
  const changed = cloneWorkflow(w)
  changed.documentation.policy = 'manual'
  const s = await approvalStates(changed)
  assert.equal(s.definition.status, 'stale')
  assert.equal(s.intent.status, 'approved')
  const moved = cloneWorkflow(w)
  moved.layout.nodes.a = { x: 1, y: 2 }
  assert.equal((await approvalStates(moved)).definition.status, 'approved')
})

test('YAML: new workflows declare the default policy; edits write the field back', () => {
  const text = newWorkflowText(emptyWorkflow('fresh', 'Fresh'))
  assert.match(text, /^documentation:\n {2}policy: default$/m)
  const r = parseWorkflow(text)
  assert.ok(r.ok)
  assert.equal(r.model.documentation.policy, 'default')

  const old = 'schema: ag.workflow.v2\nid: x\nname: X\nintent: y\nnodes:\n  a: {type: do, description: z}\n'
  const p = parseWorkflow(old)
  assert.ok(p.ok)
  assert.equal(p.model.documentation.policy, '') // absent: reported, never assumed
  assert.equal(renderWorkflow(p.doc, p.model), old, 'reading without editing writes nothing new')
  p.model.documentation.policy = 'manual'
  const edited = renderWorkflow(p.doc, p.model)
  assert.match(edited, /documentation:\n {2}policy: manual\n/)
  const again = parseWorkflow(edited)
  assert.ok(again.ok && again.model.documentation.policy === 'manual')

  const shaped = parseWorkflow('schema: ag.workflow.v2\nid: x\ndocumentation: default\n')
  assert.ok(!shaped.ok && shaped.problem.kind === 'shape')
})

test('split counts keep authored work and documentation apart', () => {
  const g = ok(wf(['a', 'b'], [['a', 'b']]))
  const states = Object.fromEntries(Object.keys(g.nodes).map(id => [id, { state: id === 'a' || id === 'b' || id === PLAN_STEP ? 'completed' : 'pending' }]))
  assert.deepEqual(splitCounts(g, states), { work: { completed: 2 }, docs: { completed: 1, pending: 3 } })
})
