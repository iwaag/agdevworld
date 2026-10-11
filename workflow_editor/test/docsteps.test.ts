// p5 step 2: generated documentation steps in runs — the frozen effective
// graph, plan agreement, report evidence, failure and resumption, and the
// file layer's document checks.
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile, FINAL_STEP, PLAN_STEP, reportStep } from '../shared/compile.ts'
import { emptyWorkflow } from '../shared/model.ts'
import { operate, RunError, type DocumentEvidence, type OpInput, type RunGraph, type RunRecord } from '../shared/run.ts'
import { createProject } from '../server/create.ts'
import { documentationBrief } from '../server/exec.ts'
import { loadRegistry } from '../server/registry.ts'
import { createRun, readRun, runOp, type CreateRunOptions } from '../server/runs.ts'
import { RequestError, Workspace } from '../server/workspace.ts'

// ---- reducer -----------------------------------------------------------------------

// a → b, a → c, (b, c) → j under the default policy.
function graphOf(nodes: string[], edges: [string, string][], policy = 'default') {
  const w = emptyWorkflow('w', 'W')
  w.documentation.policy = policy
  for (const id of nodes) w.nodes[id] = { type: 'do', name: '', description: id, repositories: [] }
  w.edges = edges.map(([from, to]) => ({ from, to }))
  const r = compile(w)
  assert.ok(r.ok)
  return r.graph
}
const EFF = graphOf(['a', 'b', 'c', 'j'], [['a', 'b'], ['a', 'c'], ['b', 'j'], ['c', 'j']])
const G: RunGraph = { nodes: EFF.nodes, edges: EFF.edges }
let clock = Date.parse('2026-10-11T00:00:00.000Z')
const tick = () => new Date(clock += 1000).toISOString()
const create = (graph = G, effective = EFF): RunRecord => operate(null, {
  op: 'run.create', project: 'p', workflow: 'w', run: 'run-001', nodes: Object.keys(graph.nodes),
  input: { kind: 'braindump', file: 'braindump.md', author: 'Person' }, executor: { name: 'Agent', backend: null },
  predecessor: null, definition: { root: 'w', workflows: {}, warnings: [], effective }, context: { repositories: [] },
}, { at: tick(), by: 'Agent', via: 'test', graph })
const op = (r: RunRecord, input: OpInput & { attempt?: string }, by = 'Agent') => operate(r, input, { at: tick(), by, via: 'test', graph: G })
const refused = (f: () => unknown, code: string) => assert.throws(f, (e: unknown) => e instanceof RunError && e.code === code, `expected ${code}`)
const doc = (name: string, sha = 'a'.repeat(64), bytes = 120): DocumentEvidence => ({ path: `devdocs/runs/w/run-001/${name}`, sha256: sha, bytes })
const PLAN_A = doc('plan.md', 'a'.repeat(64)), PLAN_B = doc('plan.md', 'b'.repeat(64))

// Plan agreed in q1, as the executor records it.
function planned(): RunRecord {
  let r = create()
  r = op(r, { op: 'node.start', node: PLAN_STEP })
  r = op(r, { op: 'question.ask', question: 'q1', node: PLAN_STEP, text: 'Agree to plan.md?', to: 'Person', document: PLAN_A })
  r = op(r, { op: 'question.answer', question: 'q1', text: 'OK' }, 'Person')
  r = op(r, { op: 'question.take-up', question: 'q1' })
  return op(r, { op: 'node.complete', node: PLAN_STEP, outcome: 'Plan agreed.', document: PLAN_A })
}
const work = (r: RunRecord, id: string) => op(op(r, { op: 'node.start', node: id }), { op: 'node.complete', node: id, outcome: `${id} done` })
const report = (r: RunRecord, id: string) => op(op(r, { op: 'node.start', node: reportStep(id) }), { op: 'node.complete', node: reportStep(id), outcome: `${id} reported`, document: doc(`report-${id}.md`) })

test('the plan is written before it is consulted on', () => {
  let r = create()
  assert.deepEqual(r.execution.ready, [PLAN_STEP], 'only the plan talk is ready at first')
  r = op(r, { op: 'node.start', node: PLAN_STEP })
  refused(() => op(r, { op: 'question.ask', question: 'q1', node: PLAN_STEP, text: '?', to: 'Person' }), 'document-missing')
  refused(() => op(r, { op: 'question.ask', question: 'q1', node: PLAN_STEP, text: '?', to: 'Person', document: doc('report.md') }), 'document-path')
  const asked = op(r, { op: 'question.ask', question: 'q1', node: PLAN_STEP, text: '?', to: 'Person', document: PLAN_A })
  assert.deepEqual(asked.questions.q1.document, PLAN_A)
})

test('work waits for agreement to the applicable plan; a revision needs a new question', () => {
  let r = create()
  r = op(r, { op: 'node.start', node: PLAN_STEP })
  r = op(r, { op: 'question.ask', question: 'q1', node: PLAN_STEP, text: 'Agree?', to: 'Person', document: PLAN_A })
  refused(() => op(r, { op: 'node.start', node: 'a' }), 'not-ready')
  r = op(r, { op: 'question.answer', question: 'q1', text: 'Change the order.' }, 'Person')
  refused(() => op(op(r, { op: 'question.take-up', question: 'q1' }), { op: 'node.complete', node: PLAN_STEP, outcome: 'x', document: PLAN_B }), 'plan-not-agreed')
  r = op(r, { op: 'question.take-up', question: 'q1' })
  // The plan is revised (B) and asked about again.
  r = op(r, { op: 'question.ask', question: 'q2', node: PLAN_STEP, text: 'Revised; agree?', to: 'Person', document: PLAN_B })
  refused(() => op(r, { op: 'node.complete', node: PLAN_STEP, outcome: 'x', document: PLAN_B }), 'state') // it waits on q2
  r = op(r, { op: 'question.answer', question: 'q2', text: 'Yes.' }, 'Person')
  r = op(r, { op: 'question.take-up', question: 'q2' })
  refused(() => op(r, { op: 'node.complete', node: PLAN_STEP, outcome: 'x', document: PLAN_A, agreement: 'q1' }), 'plan-not-agreed')
  r = op(r, { op: 'node.complete', node: PLAN_STEP, outcome: 'Plan agreed.', document: PLAN_B })
  assert.deepEqual(r.nodes[PLAN_STEP].agreement, { question: 'q2' })
  assert.deepEqual(r.execution.ready, ['a'])
  assert.equal(r.decisions.length, 0, 'plan agreement is not acceptance')
})

test('a withdrawal alone is not agreement', () => {
  let r = create()
  r = op(r, { op: 'node.start', node: PLAN_STEP })
  r = op(r, { op: 'question.ask', question: 'q1', node: PLAN_STEP, text: 'Agree?', to: 'Person', document: PLAN_A })
  r = op(r, { op: 'question.withdraw', question: 'q1', reason: 'asked too early' })
  refused(() => op(r, { op: 'node.complete', node: PLAN_STEP, outcome: 'x', document: PLAN_A }), 'plan-not-agreed')
  refused(() => op(r, { op: 'node.complete', node: PLAN_STEP, outcome: 'x', document: PLAN_A, agreement: 'q1' }), 'plan-not-agreed')
})

test('reports gate successors; work and reporting are separately observable', () => {
  let r = work(planned(), 'a')
  assert.equal(r.nodes.a.state, 'completed')
  assert.deepEqual(r.execution.ready, [reportStep('a')], 'b and c wait for the report of a')
  refused(() => op(r, { op: 'node.start', node: 'b' }), 'not-ready')
  r = op(r, { op: 'node.start', node: reportStep('a') })
  assert.equal(r.nodes.a.state, 'completed')
  assert.equal(r.nodes[reportStep('a')].state, 'running')
  refused(() => op(r, { op: 'node.complete', node: reportStep('a'), outcome: 'x' }), 'document-missing')
  refused(() => op(r, { op: 'node.complete', node: reportStep('a'), outcome: 'x', document: doc('report-b.md') }), 'document-path')
  refused(() => op(r, { op: 'node.complete', node: reportStep('a'), outcome: 'x', document: doc('report-a.md', 'c'.repeat(64), 0) }), 'document-empty')
  r = op(r, { op: 'node.complete', node: reportStep('a'), outcome: 'Surveyed.', document: doc('report-a.md') })
  assert.deepEqual(r.nodes[reportStep('a')].outcome?.artifacts, ['devdocs/runs/w/run-001/report-a.md'])
  assert.deepEqual(r.execution.ready, ['b', 'c'])
  refused(() => op(op(r, { op: 'node.start', node: 'b' }), { op: 'node.complete', node: 'b', outcome: 'x', document: doc('report-b.md') }), 'shape')
})

test('a join waits for every predecessor report; completion waits for the final report', () => {
  let r = report(work(planned(), 'a'), 'a')
  r = report(work(work(r, 'b'), 'c'), 'b')
  assert.deepEqual(r.execution.ready, [reportStep('c')], 'j waits for the report of c')
  r = report(r, 'c')
  r = report(work(r, 'j'), 'j')
  assert.equal(r.execution.state, 'in-progress', 'all authored work done, final report pending')
  assert.deepEqual(r.execution.ready, [FINAL_STEP])
  r = op(r, { op: 'node.start', node: FINAL_STEP })
  refused(() => op(r, { op: 'node.complete', node: FINAL_STEP, outcome: 'x', document: doc('report-j.md') }), 'document-path')
  r = op(r, { op: 'node.complete', node: FINAL_STEP, outcome: 'Delivered.', document: doc('report.md') })
  assert.equal(r.execution.state, 'completed')
  assert.equal(r.decisions.length, 0, 'the final report is not acceptance')
})

test('failure blocks the report and the run; nothing fabricates success; a partial report is an attachment', () => {
  let r = op(planned(), { op: 'node.start', node: 'a' })
  r = op(r, { op: 'node.fail', node: 'a', reason: 'the data is gone' })
  assert.ok(r.execution.blocked.includes(reportStep('a')))
  assert.ok(r.execution.blocked.includes(FINAL_STEP))
  assert.equal(r.execution.state, 'stopped')
  refused(() => op(r, { op: 'node.start', node: reportStep('a') }), 'not-ready')
  r = op(r, { op: 'artifact.attach', path: 'devdocs/runs/w/run-001/report-a.md', node: 'a', title: 'partial report' })
  assert.equal(r.nodes[reportStep('a')].state, 'pending')
  assert.equal(r.execution.state, 'stopped')
})

test('interrupted while reporting: the report resumes, the work is not repeated, a replaced attempt stays refused', () => {
  let r = work(planned(), 'a')
  r = op(r, { op: 'attempt.begin', attempt: 'a1', reason: 'start' }, 'exec')
  r = op(r, { op: 'node.start', node: reportStep('a'), attempt: 'a1' })
  r = op(r, { op: 'attempt.end', attempt: 'a1', outcome: 'exited' }, 'exec')
  assert.equal(r.control.last?.outcome, 'interrupted')
  assert.equal(r.control.hold?.kind, 'interrupted')
  r = op(r, { op: 'run.resume', reason: 'finish the report' }, 'Person')
  r = op(r, { op: 'attempt.begin', attempt: 'a2', reason: 'resume' }, 'exec')
  refused(() => op(r, { op: 'node.complete', node: reportStep('a'), outcome: 'x', document: doc('report-a.md'), attempt: 'a1' }), 'attempt-stale')
  r = op(r, { op: 'node.complete', node: reportStep('a'), outcome: 'Reported.', document: doc('report-a.md'), attempt: 'a2' })
  assert.equal(r.history.filter(e => e.op === 'node.complete' && (e as { node?: string }).node === 'a').length, 1, 'a completed once')
  assert.deepEqual(r.execution.ready, ['b', 'c'])
})

test('manual policy: no generated steps, nothing asks for documents', () => {
  const M = graphOf(['a', 'b'], [['a', 'b']], 'manual')
  let r = create({ nodes: M.nodes, edges: M.edges }, M)
  assert.deepEqual(Object.keys(r.nodes).sort(), ['a', 'b'])
  r = operate(r, { op: 'node.start', node: 'a' }, { at: tick(), by: 'A', via: 't', graph: M })
  r = operate(r, { op: 'node.complete', node: 'a', outcome: 'done', artifacts: ['devdocs/runs/w/run-001/plan.md'] }, { at: tick(), by: 'A', via: 't', graph: M })
  assert.deepEqual(r.execution.ready, ['b'])
  assert.match(documentationBrief(r).join('\n'), /manual/)
  assert.doesNotMatch(documentationBrief(r).join('\n'), /_report|_plan/)
})

test('run.create refuses a graph that differs from the frozen one', () => {
  const other = graphOf(['a'], [])
  refused(() => create(G, other), 'graph')
})

// ---- files -------------------------------------------------------------------------

const WF = (policy: string, nodes = '  study: {type: study, description: Learn}\n  build: {type: do, description: Build}\n', edges = '  - {from: study, to: build}\n') => `schema: ag.workflow.v2
id: docs
name: Docs
intent: |
  Test documentation steps.
documentation: {policy: ${policy}}
repositories:
  docs: {path: devdocs, access: editable}
nodes:
${nodes}edges:
${edges}`

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-docsteps-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

async function project(id: string, workflow: string) {
  const registry = join(root, `${id}.registry.json`)
  const dir = join(root, `pj-${id}`)
  const r = await createProject({ dir, id, name: id, intent: 'x', goals: ['g'], devdocs: 'directory', sourcesDir: join(root, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'docs.yaml'), workflow)
  return { dir, ws: new Workspace((await loadRegistry(registry)).workspaces[0]) }
}
const opts = (o: Partial<CreateRunOptions> = {}): CreateRunOptions => ({ workflow: 'docs', input: { kind: 'braindump', text: 'Please.', author: 'Person' }, executor: { name: 'Agent', backend: null }, by: 'Agent', via: 'cli', ...o })
const fails = async (p: Promise<unknown>, status: number, re: RegExp) => {
  await assert.rejects(p, (e: unknown) => e instanceof RequestError && e.status === status && re.test(e.message), `expected ${status} ${re}`)
}

test('creation freezes the effective graph; later edits of the source do not change the run', async () => {
  const { dir, ws } = await project('freeze', WF('default'))
  const made = await createRun(ws, opts())
  const eff = made.record.definition.effective!
  assert.equal(eff.policy, 'default')
  assert.deepEqual(Object.keys(made.record.nodes).sort(), ['_final-report', '_plan', '_report.build', '_report.study', 'build', 'study'])
  assert.deepEqual(made.record.execution.ready, [PLAN_STEP])
  await writeFile(join(dir, 'devdocs', 'workflows', 'docs.yaml'), WF('manual'))
  const again = await readRun(ws, made.ref)
  assert.ok(again.record, again.problem?.message)
  assert.deepEqual(Object.keys(again.record!.nodes).sort(), Object.keys(made.record.nodes).sort())
  // A tampered frozen graph is a visible problem, never silently recompiled.
  const file = join(dir, made.dir, 'run.json')
  const raw = JSON.parse(await readFile(file, 'utf8'))
  raw.definition.effective.edges.pop()
  raw.history[0].definition.effective.edges.pop()
  await writeFile(file, JSON.stringify(raw, null, 2))
  const broken = await readRun(ws, made.ref)
  assert.equal(broken.record, undefined)
  assert.equal(broken.problem?.code, 'bundle')
})

test('a run created before p5 (no frozen graph) follows its authored graph', async () => {
  const { dir, ws } = await project('legacy', WF('default'))
  const made = await createRun(ws, opts())
  const file = join(dir, made.dir, 'run.json')
  // Rebuild the record as p4 wrote it: no effective graph, authored nodes only.
  const raw = JSON.parse(await readFile(file, 'utf8'))
  const authored = ['build', 'study']
  for (const target of [raw, raw.history[0]]) delete target.definition.effective
  raw.history[0].nodes = authored
  raw.nodes = Object.fromEntries(authored.map(id => [id, raw.nodes[id]]))
  raw.execution = { ...raw.execution, counts: { ...raw.execution.counts, pending: 2 }, ready: ['study'] }
  await writeFile(file, JSON.stringify(raw, null, 2))
  const read = await readRun(ws, made.ref)
  assert.ok(read.record, read.problem?.message)
  assert.deepEqual(read.record!.execution.ready, ['study'])
  assert.match(documentationBrief(read.record!).join('\n'), /before p5/)
})

test('the file layer checks the document: missing, empty, symbolic link, then recorded evidence', async () => {
  const { dir, ws } = await project('files', WF('default'))
  const { ref, dir: rel } = await createRun(ws, opts())
  const run = join(dir, rel)
  const rec = (input: OpInput, by = 'Agent') => runOp(ws, ref, input, { by, via: 'cli' })
  await rec({ op: 'node.start', node: PLAN_STEP })
  await fails(rec({ op: 'question.ask', question: '', node: PLAN_STEP, text: 'Agree?', to: 'Person' }), 422, /plan\.md does not exist/)
  await writeFile(join(run, 'plan.md'), '# Plan\n\nStudy, then build.\n')
  const asked = await rec({ op: 'question.ask', question: '', node: PLAN_STEP, text: 'Agree to plan.md?', to: 'Person', document: { path: 'x', sha256: 'f'.repeat(64), bytes: 9 } } as OpInput)
  const q = asked.record.questions.q1
  assert.equal(q.document?.path, `${rel}/plan.md`, 'evidence is computed, never taken from the caller')
  await rec({ op: 'question.answer', question: 'q1', text: 'OK' }, 'Person')
  await rec({ op: 'question.take-up', question: 'q1' })
  // An edit after the question cannot appear agreed.
  await writeFile(join(run, 'plan.md'), '# Plan\n\nStudy, then build, then deploy.\n')
  await fails(rec({ op: 'node.complete', node: PLAN_STEP, outcome: 'Agreed.' }), 422, /changed since question q1/)
  await writeFile(join(run, 'plan.md'), '# Plan\n\nStudy, then build.\n')
  const agreed = await rec({ op: 'node.complete', node: PLAN_STEP, outcome: 'Agreed.' })
  assert.deepEqual(agreed.record.nodes[PLAN_STEP].agreement, { question: 'q1' })

  await rec({ op: 'node.start', node: 'study' })
  await rec({ op: 'node.complete', node: 'study', outcome: 'Learned.' })
  await rec({ op: 'node.start', node: reportStep('study') })
  await fails(rec({ op: 'node.complete', node: reportStep('study'), outcome: 'x' }), 422, /report-study\.md does not exist/)
  await writeFile(join(run, 'report-study.md'), '  \n\n')
  await fails(rec({ op: 'node.complete', node: reportStep('study'), outcome: 'x' }), 422, /is empty/)
  await rm(join(run, 'report-study.md'))
  await writeFile(join(root, 'outside.md'), 'not the run\'s')
  await symlink(join(root, 'outside.md'), join(run, 'report-study.md'))
  await fails(rec({ op: 'node.complete', node: reportStep('study'), outcome: 'x' }), 422, /symbolic link/)
  await rm(join(run, 'report-study.md'))
  await writeFile(join(run, 'report-study.md'), '# study\n\nRead three sources.\n')
  const done = await rec({ op: 'node.complete', node: reportStep('study'), outcome: 'Learned three things.' })
  const ev = done.record.nodes[reportStep('study')].document!
  assert.equal(ev.path, `${rel}/report-study.md`)
  assert.equal(ev.bytes, Buffer.byteLength('# study\n\nRead three sources.\n'))
  assert.match(ev.sha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(done.record.execution.ready, ['build'])
  const brief = documentationBrief(done.record).join('\n')
  assert.doesNotMatch(brief, /_report\.study/, 'a finished report is not in the brief')
})

test('the brief names the current step, its document and its instructions', async () => {
  const { ws } = await project('brief', WF('default'))
  const { record } = await createRun(ws, opts())
  const text = documentationBrief(record).join('\n')
  assert.match(text, /policy: default/)
  assert.match(text, /Step _plan \(ready\): Plan the work.*plan\.md/)
  assert.match(text, /write plan\.md in the run folder and agree it with the person/)
})

test('creation refuses an empty workflow and still refuses delegates under the default policy', async () => {
  const { ws, dir } = await project('refuse', WF('default', '  {}\n', '  []\n').replace('nodes:\n  {}', 'nodes: {}').replace('edges:\n  []', 'edges: []'))
  await fails(createRun(ws, opts()), 422, /no nodes/)
  await writeFile(join(dir, 'devdocs', 'workflows', 'docs.yaml'), WF('default', '  a: {type: do, description: A}\n  d: {type: delegate, description: D, workflow: other}\n  other: {type: do, description: O}\n', '  - {from: a, to: d}\n'))
  await writeFile(join(dir, 'devdocs', 'workflows', 'other.yaml'), WF('manual').replace('id: docs', 'id: other'))
  await fails(createRun(ws, opts()), 422, /delegate/)
})
