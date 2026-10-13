// p8/ex2 step 3: the custom documentation policy — the three generated
// documents chosen one by one. Every one of the eight combinations compiles
// to a connected graph that validation, the run reducer, the brief and the
// views read the same way; default and manual stay what they were.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvalStates, semanticDigest, canonicalJson } from '../shared/canonical.ts'
import { COMPILER_VERSION, compile, docStepsOf, FINAL_STEP, hasDocSteps, PLAN_STEP, reportStep, type EffectiveGraph } from '../shared/compile.ts'
import { cloneWorkflow, docSteps, emptyWorkflow, type DocSteps, type Workflow } from '../shared/model.ts'
import { notableEvents, operate, readiness, RunError, type OpInput, type RunGraph, type RunRecord } from '../shared/run.ts'
import { validateWorkflow } from '../shared/validate.ts'
import { newWorkflowText, parseWorkflow, renderWorkflow } from '../server/yamlDoc.ts'
import { createProject } from '../server/create.ts'
import { documentationBrief } from '../server/exec.ts'
import { loadRegistry } from '../server/registry.ts'
import { adjustRun, createRun, readRun } from '../server/runs.ts'
import { Workspace } from '../server/workspace.ts'

const COMBOS: DocSteps[] = [false, true].flatMap(plan => [false, true].flatMap(reports => [false, true].map(final => ({ plan, reports, final }))))
const custom = (d: DocSteps) => ({ policy: 'custom', ...d })

// a → b, a → c, (b, c) → j: an entry, a branch, a join and one terminal.
function wf(documentation: Workflow['documentation'], nodes = ['a', 'b', 'c', 'j'], edges: [string, string][] = [['a', 'b'], ['a', 'c'], ['b', 'j'], ['c', 'j']]): Workflow {
  const w = emptyWorkflow('w', 'W')
  w.intent = 'Test.'
  w.documentation = documentation
  for (const id of nodes) w.nodes[id] = { type: 'do', name: '', description: id, repositories: [] }
  w.edges = edges.map(([from, to]) => ({ from, to }))
  return w
}
function ok(w: Workflow): EffectiveGraph {
  const r = compile(w)
  assert.ok(r.ok, !r.ok ? r.message : '')
  return r.graph
}
const edgeSet = (g: Pick<EffectiveGraph, 'edges'>) => g.edges.map(e => `${e.from}>${e.to}`).sort()

test('all eight combinations: the generated steps chosen, wired so that every authored dependency still holds', () => {
  for (const d of COMBOS) {
    const w = wf(custom(d))
    assert.deepEqual(validateWorkflow(w).filter(i => i.severity === 'error'), [], `valid: ${JSON.stringify(d)}`)
    const g = ok(w)
    const what = JSON.stringify(d)
    assert.equal(g.compiler, COMPILER_VERSION)
    assert.equal(g.policy, 'custom')
    assert.deepEqual(g.documentation, d, what)
    assert.deepEqual(docStepsOf(g), d)
    assert.equal(PLAN_STEP in g.nodes, d.plan, `${what}: plan`)
    assert.equal(FINAL_STEP in g.nodes, d.final, `${what}: final`)
    for (const id of ['a', 'b', 'c', 'j']) assert.equal(reportStep(id) in g.nodes, d.reports, `${what}: report on ${id}`)
    assert.equal(hasDocSteps(g), d.plan || d.reports || d.final)
    const after = (id: string) => (d.reports ? reportStep(id) : id)
    const expected = [
      ...(d.plan ? ['_plan>a'] : []),
      ...(d.reports ? ['a', 'b', 'c', 'j'].map(id => `${id}>${reportStep(id)}`) : []),
      `${after('a')}>b`, `${after('a')}>c`, `${after('b')}>j`, `${after('c')}>j`,
      ...(d.final ? [`${after('j')}>_final-report`] : []),
    ].sort()
    assert.deepEqual(edgeSet(g), expected, what)
    // Every edge names a node of the graph, and the graph runs to its end.
    for (const e of g.edges) assert.ok(e.from in g.nodes && e.to in g.nodes, `${what}: ${e.from} → ${e.to}`)
    let states: Record<string, { state: 'pending' | 'completed' }> = Object.fromEntries(Object.keys(g.nodes).map(id => [id, { state: 'pending' as const }]))
    for (let i = 0; i < 20; i++) {
      const { ready } = readiness(states, g)
      if (!ready.length) break
      states = { ...states, ...Object.fromEntries(ready.map(id => [id, { state: 'completed' as const }])) }
    }
    assert.ok(Object.values(states).every(s => s.state === 'completed'), `${what}: every node becomes ready in turn`)
    // The final report's instructions only point at reports that exist.
    if (d.final) assert.equal(/its reports are complete/.test(g.nodes[FINAL_STEP].step!.instructions), d.reports, `${what}: final instructions`)
  }
})

test('default and manual compile exactly as before (v2 nodes and edges); custom with all or none equals them', () => {
  const def = ok(wf({ policy: 'default' })), man = ok(wf({ policy: 'manual' }))
  const all = ok(wf(custom({ plan: true, reports: true, final: true }))), none = ok(wf(custom({ plan: false, reports: false, final: false })))
  assert.equal(canonicalJson({ n: def.nodes, e: def.edges }), canonicalJson({ n: all.nodes, e: all.edges }))
  assert.equal(canonicalJson({ n: man.nodes, e: man.edges }), canonicalJson({ n: none.nodes, e: none.edges }))
  assert.deepEqual(docStepsOf(def), { plan: true, reports: true, final: true })
  assert.deepEqual(docStepsOf(man), { plan: false, reports: false, final: false })
  // A v2 graph (no documentation field) is read by its policy.
  assert.deepEqual(docStepsOf({ policy: 'default' }), { plan: true, reports: true, final: true })
  assert.deepEqual(docStepsOf({ policy: 'manual' }), { plan: false, reports: false, final: false })
  // The v2 final report instructions are unchanged under default.
  assert.match(def.nodes[FINAL_STEP].step!.instructions, /^All authored work and its reports are complete; write report\.md in the run folder\./)
})

test('validation: custom declares all three; default and manual declare none; values are booleans', () => {
  const codes = (w: Workflow) => validateWorkflow(w).filter(i => i.severity === 'error').map(i => i.code)
  assert.deepEqual(codes(wf({ policy: 'custom', plan: true, reports: false })), ['documentation-steps'])
  assert.deepEqual(codes(wf({ policy: 'custom' })), ['documentation-steps'])
  assert.deepEqual(codes(wf({ policy: 'default', plan: false })), ['documentation-steps'])
  assert.deepEqual(codes(wf({ policy: 'manual', final: true })), ['documentation-steps'])
  assert.equal(docSteps({ policy: 'default', plan: false }), null, 'a contradiction is not reconciled')
  const c = compile(wf({ policy: 'custom', plan: true }))
  assert.ok(!c.ok && c.code === 'documentation-steps')
  for (const bad of ['plan: "true"', 'plan: yes-please', 'plan: 1', 'plan: [true]']) {
    const r = parseWorkflow(`schema: ag.workflow.v2\nid: x\nname: X\nintent: y\ndocumentation:\n  policy: custom\n  ${bad}\n  reports: false\n  final: true\nnodes:\n  a: {type: do, description: z}\n`)
    assert.ok(!r.ok && r.problem.kind === 'shape', `${bad} is a shape problem`)
  }
})

test('approval: default and manual keep their digests; each custom step is part of the definition', async () => {
  const w = wf({ policy: 'default' })
  const old = { kind: 'ag.workflow.v2/definition', intent: 'Test.', documentation: { policy: 'default' } }
  const digest = await semanticDigest('definition', w)
  // The projection of a default workflow has only the policy, as in p5.
  const { definitionProjection } = await import('../shared/canonical.ts')
  assert.deepEqual((definitionProjection(w) as { documentation: unknown }).documentation, old.documentation)
  const c = wf(custom({ plan: false, reports: false, final: true }))
  c.approvals.definition = { digest: await semanticDigest('definition', c), approver: 't', at: 'now' }
  assert.notEqual(c.approvals.definition.digest, digest)
  for (const k of ['plan', 'reports', 'final'] as const) {
    const changed = cloneWorkflow(c)
    changed.documentation[k] = !changed.documentation[k]
    assert.equal((await approvalStates(changed)).definition.status, 'stale', `${k} changes the definition approval`)
  }
})

test('YAML: custom writes three booleans; switching back to default removes them', () => {
  const w = emptyWorkflow('fresh', 'Fresh')
  w.documentation = custom({ plan: false, reports: false, final: true })
  const text = newWorkflowText(w)
  assert.match(text, /documentation:\n {2}policy: custom\n {2}plan: false\n {2}reports: false\n {2}final: true\n/)
  const r = parseWorkflow(text)
  assert.ok(r.ok)
  assert.deepEqual(r.model.documentation, { policy: 'custom', plan: false, reports: false, final: true })
  assert.equal(renderWorkflow(r.doc, r.model), text, 'an unchanged custom file is written back byte for byte')
  r.model.documentation = { policy: 'default' }
  const back = renderWorkflow(r.doc, r.model)
  assert.match(back, /documentation:\n {2}policy: default\n(?! {2}(plan|reports|final))/)
  assert.ok(!/plan: false|reports: false|final: true/.test(back))
})

// ---- runs ----------------------------------------------------------------------------------

let clock = Date.parse('2026-10-13T00:00:00.000Z')
const tick = () => new Date(clock += 1000).toISOString()
function runOf(eff: EffectiveGraph): { r: RunRecord; op: (r: RunRecord, i: OpInput, by?: string) => RunRecord; g: RunGraph } {
  const g: RunGraph = { nodes: eff.nodes, edges: eff.edges }
  const r = operate(null, {
    op: 'run.create', project: 'p', workflow: 'w', run: 'run-001', nodes: Object.keys(g.nodes),
    input: { kind: 'braindump', file: 'braindump.md', author: 'Person' }, executor: { name: 'Agent', backend: null },
    predecessor: null, definition: { root: 'w', workflows: {}, warnings: [], effective: eff }, context: { repositories: [] },
  }, { at: tick(), by: 'Agent', via: 'test', graph: g })
  return { r, g, op: (x, i, by = 'Agent') => operate(x, i, { at: tick(), by, via: 'test', graph: g }) }
}

test('a run without reports tells of each completed node; a run with them tells of the reports', () => {
  const finalOnly = runOf(ok(wf(custom({ plan: false, reports: false, final: true }), ['a', 'b'], [['a', 'b']])))
  let r = finalOnly.r
  assert.deepEqual(r.execution.ready, ['a'])
  r = finalOnly.op(finalOnly.op(r, { op: 'node.start', node: 'a' }), { op: 'node.complete', node: 'a', outcome: 'a done' })
  assert.ok(notableEvents(r).some(e => e.type === 'node-completed' && e.node === 'a'), 'node a is news')
  const withReports = runOf(ok(wf(custom({ plan: false, reports: true, final: false }), ['a', 'b'], [['a', 'b']])))
  let s = withReports.op(withReports.op(withReports.r, { op: 'node.start', node: 'a' }), { op: 'node.complete', node: 'a', outcome: 'a done' })
  assert.ok(!notableEvents(s).some(e => e.type === 'node-completed'), 'its report tells of it instead')
  // Without a final report the last authored completion completes the run.
  const plain = runOf(ok(wf(custom({ plan: false, reports: false, final: false }), ['a'], [])))
  s = plain.op(plain.op(plain.r, { op: 'node.start', node: 'a' }), { op: 'node.complete', node: 'a', outcome: 'a done' })
  assert.equal(s.execution.state, 'completed')
})

test('an adjustment keeps the policy and its steps: a name or a step that changes is refused', () => {
  const base = ok(wf(custom({ plan: false, reports: false, final: true }), ['a'], []))
  const { r, op } = runOf(base)
  const started = op(r, { op: 'node.start', node: 'a' })
  const done = op(started, { op: 'node.complete', node: 'a', outcome: 'ok' })
  const adjust = (next: EffectiveGraph) => operate(done, { op: 'run.adjust', revision: 'r2', parent: 'r1', file: 'definition/r2/w.yaml', sha256: 'a'.repeat(64), definitionDigest: `sha256:${'b'.repeat(64)}`, effective: next, reason: 'more', source: { kind: 'person', by: 'P' } }, { at: tick(), by: 'P', via: 'test', graph: { nodes: base.nodes, edges: base.edges } })
  const grown = ok(wf(custom({ plan: false, reports: false, final: true }), ['a', 'b'], [['a', 'b']]))
  assert.equal(adjust(grown).definition.active, 'r2', 'the same setting adjusts')
  const refused = (g: EffectiveGraph) => assert.throws(() => adjust(g), (e: unknown) => e instanceof RunError && e.code === 'adjust-access')
  refused(ok(wf(custom({ plan: false, reports: true, final: true }), ['a', 'b'], [['a', 'b']])))
  refused({ ...grown, policy: 'default' })
})

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-custompolicy-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const FILE = (doc: string) => `schema: ag.workflow.v2\nid: free\nname: Free\nintent: Grow the work in conversation.\ndocumentation:\n${doc}\nnodes:\n  talk: {type: talk, name: Talk, description: Understand the request and agree the next work.}\n`

test('file layer: a custom run freezes its steps, briefs them, refuses a changed setting in an adjustment', async () => {
  const registry = join(root, 'r.registry.json')
  const dir = join(root, 'pj-cp')
  const made = await createProject({ dir, id: 'cp', name: 'cp', intent: 'x', goals: ['g'], devdocs: 'directory', sourcesDir: join(root, 'sources'), registryFile: registry })
  assert.ok(made.ok, made.message)
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  const text = FILE('  policy: custom\n  plan: false\n  reports: false\n  final: true')
  await writeFile(join(dir, 'devdocs', 'workflows', 'free.yaml'), text)
  const run = await createRun(ws, { workflow: 'free', input: { kind: 'braindump', text: 'Please.', author: 'Person' }, executor: { name: 'Agent', backend: null }, by: 'Agent', via: 'cli' })
  const eff = run.record.definition.effective!
  assert.equal(eff.compiler, 'ag.wfe-compile.v3')
  assert.deepEqual(eff.documentation, { plan: false, reports: false, final: true })
  assert.deepEqual(Object.keys(run.record.nodes).sort(), ['_final-report', 'talk'])
  // The run reads back usable; a later edit of the source does not touch it.
  await writeFile(join(dir, 'devdocs', 'workflows', 'free.yaml'), FILE('  policy: default'))
  const again = await readRun(ws, run.ref)
  assert.ok(again.record, again.problem?.message)
  const brief = documentationBrief(again.record!).join('\n')
  assert.match(brief, /^Documentation policy: custom \(final report\)\. _final-report is a step of this run/)
  assert.match(brief, /no plan talk and no per-node reports/)
  // An adjustment that changes the setting is refused, whatever else it does.
  const frozen = await readFile(join(dir, 'devdocs', 'runs', 'free', run.ref.run, 'definition', 'free.yaml'), 'utf8')
  const changed = frozen.replace('  reports: false', '  reports: true').replace('nodes:\n', 'nodes:\n  more: {type: do, name: More, description: More work.}\n') + 'edges:\n  - {from: talk, to: more}\n'
  const res = await adjustRun(ws, run.ref, { text: changed, reason: 'more', source: { kind: 'person', by: 'P' }, dryRun: true }, { via: 'cli', by: 'P' })
  assert.ok(!res.ok && res.problems.some(p => p.code === 'adjust-access'), JSON.stringify(res.problems))
  const same = frozen.replace('nodes:\n', 'nodes:\n  more: {type: do, name: More, description: More work.}\n') + 'edges:\n  - {from: talk, to: more}\n'
  const fine = await adjustRun(ws, run.ref, { text: same, reason: 'more', source: { kind: 'person', by: 'P' }, dryRun: true }, { via: 'cli', by: 'P' })
  assert.ok(fine.ok, JSON.stringify(fine.problems))
  assert.deepEqual(fine.graph.added.sort(), ['more'])
  assert.deepEqual(fine.graph.edgesAdded.map(e => e.join('>')).sort(), ['more>_final-report', 'talk>more'])
})

test('creation: a custom setting from the form or the CLI; a contradiction is refused by field', async () => {
  const registry = join(root, 'r2.registry.json')
  const dir = join(root, 'pj-cp2')
  const made = await createProject({ dir, id: 'cp2', name: 'cp2', intent: 'x', goals: ['g'], devdocs: 'directory', sourcesDir: join(root, 'sources'), registryFile: registry })
  assert.ok(made.ok, made.message)
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  await ws.createWorkflow('picked', 'Picked', custom({ plan: true, reports: false, final: false }))
  assert.match(await readFile(join(dir, 'devdocs', 'workflows', 'picked.yaml'), 'utf8'), /policy: custom\n {2}plan: true\n {2}reports: false\n {2}final: false/)
  await assert.rejects(ws.createWorkflow('half', 'Half', { policy: 'custom', plan: true }), (e: unknown) => (e as { detail?: { field?: string } }).detail?.field === 'policy')
  await assert.rejects(ws.createWorkflow('contra', 'Contra', { policy: 'manual', final: true }), (e: unknown) => (e as { detail?: { field?: string } }).detail?.field === 'policy')
  // The template's own setting applies when none is given.
  await ws.createWorkflow('templated', 'Templated')
  assert.match(await readFile(join(dir, 'devdocs', 'workflows', 'templated.yaml'), 'utf8'), /documentation:\n {2}policy: default\n/)
})

test('a run frozen by compiler v2 (no documentation field) reads, runs and adjusts under v3', async () => {
  const registry = join(root, 'r3.registry.json')
  const dir = join(root, 'pj-cp3')
  const made = await createProject({ dir, id: 'cp3', name: 'cp3', intent: 'x', goals: ['g'], devdocs: 'directory', sourcesDir: join(root, 'sources'), registryFile: registry })
  assert.ok(made.ok, made.message)
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  await writeFile(join(dir, 'devdocs', 'workflows', 'old.yaml'), 'schema: ag.workflow.v2\nid: old\nname: Old\nintent: x\ndocumentation:\n  policy: default\nnodes:\n  a: {type: do, name: A, description: a}\n')
  const run = await createRun(ws, { workflow: 'old', input: { kind: 'braindump', text: 'Please.', author: 'Person' }, executor: { name: 'Agent', backend: null }, by: 'Agent', via: 'cli' })
  // What a p5–p8/ex1 release wrote: compiler v2, no documentation field.
  const file = join(dir, 'devdocs', 'runs', 'old', run.ref.run, 'run.json')
  const raw = JSON.parse(await readFile(file, 'utf8'))
  for (const eff of [raw.definition.effective, raw.history[0].definition.effective]) { eff.compiler = 'ag.wfe-compile.v2'; delete eff.documentation }
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`)
  const read = await readRun(ws, run.ref)
  assert.ok(read.record, read.problem?.message)
  assert.equal(read.record!.definition.effective!.compiler, 'ag.wfe-compile.v2')
  assert.match(documentationBrief(read.record!).join('\n'), /^Documentation policy: default \(plan talk, node reports, final report\)/)
  const frozen = await readFile(join(dir, 'devdocs', 'runs', 'old', run.ref.run, 'definition', 'old.yaml'), 'utf8')
  const grown = frozen.replace('nodes:\n', 'nodes:\n  b: {type: do, name: B, description: b}\n') + 'edges:\n  - {from: a, to: b}\n'
  const res = await adjustRun(ws, run.ref, { text: grown, reason: 'more', source: { kind: 'person', by: 'P' } }, { via: 'cli', by: 'P' })
  assert.ok(res.ok, JSON.stringify(res.problems))
  const after = await readRun(ws, run.ref)
  assert.ok(after.record, after.problem?.message)
  assert.equal(after.record!.definition.revisions!.at(-1)!.effective.compiler, 'ag.wfe-compile.v3')
  assert.deepEqual(Object.keys(after.record!.nodes).sort(), ['_final-report', '_plan', '_report.a', '_report.b', 'a', 'b'])
})
