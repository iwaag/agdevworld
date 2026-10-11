// Workflow runs — the reducer (readiness, joins, failure, questions,
// summary, replay checks; p3/pre1) and the files under the p4 contract
// (devdocs/runs/<workflow>/<run>/, both devdocs storage modes, delegate
// refusal, authorship, collisions, malformed records, Git history).
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkRecord, operate, replay, RunError, summarize, type OpInput, type RunGraph, type RunRecord,
} from '../shared/run.ts'
import { createProject } from '../server/create.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { checkRun, createRun, listRuns, runOp, runResponse, readRun, readRunFile, type CreateRunOptions } from '../server/runs.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import { main } from '../cli/wfe.ts'

// ---- reducer -----------------------------------------------------------------------

// a → b, a → c, (b, c) → j: a branch and a join.
const G: RunGraph = {
  nodes: { a: { type: 'study' }, b: { type: 'do' }, c: { type: 'talk' }, j: { type: 'do' } },
  edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'j' }, { from: 'c', to: 'j' }],
}
let clock = Date.parse('2026-10-10T00:00:00.000Z')
const tick = () => new Date(clock += 1000).toISOString()
const create = (graph = G): RunRecord => operate(null, {
  op: 'run.create', project: 'p', workflow: 'w', run: 'run-001', nodes: Object.keys(graph.nodes),
  input: { kind: 'braindump', file: 'braindump.md', author: 'Person' }, executor: { name: 'Agent', backend: null },
  predecessor: null, definition: { root: 'w', workflows: {}, warnings: [] }, context: { repositories: [] },
}, { at: tick(), by: 'Agent', via: 'test', graph })
const step = (r: RunRecord, op: OpInput, by = 'Agent', graph = G) => operate(r, op, { at: tick(), by, via: 'test', graph })
const refused = (f: () => unknown, code: string) => assert.throws(f, (e: unknown) => e instanceof RunError && e.code === code)

test('readiness follows completed predecessors; a join waits for every branch', () => {
  let r = create()
  assert.equal(r.execution.state, 'not-started')
  assert.deepEqual(r.execution.ready, ['a'])
  refused(() => step(r, { op: 'node.start', node: 'b' }), 'not-ready')
  r = step(r, { op: 'node.start', node: 'a' })
  assert.equal(r.execution.state, 'in-progress')
  assert.ok(r.started)
  r = step(r, { op: 'node.complete', node: 'a', outcome: 'surveyed' })
  assert.deepEqual(r.execution.ready, ['b', 'c'])
  r = step(r, { op: 'node.start', node: 'b' })
  r = step(r, { op: 'node.start', node: 'c' })
  assert.deepEqual(r.execution.active, ['b', 'c'], 'both branches are visible as active')
  r = step(r, { op: 'node.complete', node: 'b', outcome: 'built' })
  refused(() => step(r, { op: 'node.start', node: 'j' }), 'not-ready')
  assert.deepEqual(r.execution.ready, [])
  r = step(r, { op: 'node.complete', node: 'c', outcome: 'agreed' })
  assert.deepEqual(r.execution.ready, ['j'])
  r = step(r, { op: 'node.start', node: 'j' })
  r = step(r, { op: 'node.complete', node: 'j', outcome: 'joined' })
  assert.equal(r.execution.state, 'completed')
  assert.ok(r.ended)
  assert.equal(r.decisions.length, 0, 'completion is not acceptance')
})

test('failure and cancellation never satisfy a dependency, and a failure stays visible beside other work', () => {
  let r = create()
  r = step(r, { op: 'node.start', node: 'a' })
  r = step(r, { op: 'node.complete', node: 'a', outcome: 'ok' })
  r = step(r, { op: 'node.start', node: 'b' })
  r = step(r, { op: 'node.start', node: 'c' })
  r = step(r, { op: 'node.fail', node: 'b', reason: 'tests do not pass' })
  assert.equal(r.execution.state, 'in-progress', 'c still runs')
  assert.deepEqual(r.execution.failed, ['b'])
  assert.deepEqual(r.execution.active, ['c'])
  r = step(r, { op: 'node.complete', node: 'c', outcome: 'ok' })
  assert.deepEqual(r.execution.blocked, ['j'])
  refused(() => step(r, { op: 'node.start', node: 'j' }), 'not-ready')
  assert.equal(r.execution.state, 'stopped')
  refused(() => step(r, { op: 'node.start', node: 'b' }), 'missing') // a failed node resumes only with a reason
  const resumed = step(r, { op: 'node.start', node: 'b', reason: 'fixed the fixture' })
  assert.equal(resumed.nodes.b.state, 'running')
  assert.equal(resumed.execution.state, 'in-progress')
  assert.equal(resumed.ended, null)
  const cancelled = step(r, { op: 'node.cancel', node: 'b', reason: 'not needed' })
  assert.deepEqual(cancelled.execution.blocked, ['j'])
  refused(() => step(cancelled, { op: 'node.start', node: 'b', reason: 'x' }), 'state')
  refused(() => step(r, { op: 'run.decide', decision: 'accepted', evidence: 'x' }, 'Person'), 'not-completed')
})

test('a talk node keeps its question; answer, take-up and completion are separate records', () => {
  let r = create()
  r = step(r, { op: 'node.start', node: 'a' })
  r = step(r, { op: 'node.complete', node: 'a', outcome: 'ok' })
  r = step(r, { op: 'node.start', node: 'c' })
  r = step(r, { op: 'question.ask', question: 'q1', node: 'c', text: 'Which genre?', to: 'Person' })
  r = step(r, { op: 'question.ask', question: 'q2', text: 'Unrelated: preferred name?', to: 'Person' })
  assert.equal(r.nodes.c.state, 'waiting')
  assert.deepEqual(r.execution.waiting, [{ node: 'c', holder: 'Person', on: { question: 'q1' } }])
  refused(() => step(r, { op: 'question.ask', question: 'q3', node: 'c', text: 'again?', to: 'Person' }), 'state')
  r = step(r, { op: 'question.answer', question: 'q2', text: 'Call me P.' }, 'Person')
  assert.equal(r.nodes.c.state, 'waiting', 'an answer to another question leaves it waiting')
  r = step(r, { op: 'question.answer', question: 'q1', text: 'Strategy.' }, 'Person')
  assert.equal(r.nodes.c.state, 'waiting', 'recording an answer is not taking it up')
  assert.equal(r.questions.q1.answers[0].from, 'Person')
  const relayed = step(r, { op: 'question.answer', question: 'q1', text: 'Real-time strategy.', from: 'Person' }, 'Agent')
  assert.deepEqual([relayed.questions.q1.answers[1].from, relayed.questions.q1.answers[1].by], ['Person', 'Agent'])
  r = step(r, { op: 'question.take-up', question: 'q1' })
  assert.equal(r.nodes.c.state, 'running', 'taking up resumes the node')
  assert.equal(r.questions.q1.takenUp?.answer, 0)
  assert.notEqual(r.nodes.c.state, 'completed', 'taking up is not completing')
  r = step(r, { op: 'node.complete', node: 'c', outcome: 'genre agreed' })
  assert.equal(r.nodes.c.state, 'completed')
  refused(() => step(r, { op: 'question.answer', question: 'q1', text: 'late' }, 'Person'), 'question-closed')
  // Withdrawal closes a question without an answer.
  let w = create()
  w = step(w, { op: 'node.start', node: 'a' })
  w = step(w, { op: 'question.ask', question: 'q1', node: 'a', text: 'Need X?', to: 'Person' })
  w = step(w, { op: 'question.withdraw', question: 'q1', reason: 'found it in the docs' })
  assert.equal(w.nodes.a.state, 'running')
  assert.equal(w.questions.q1.answers.length, 0)
})

test('old timestamps alone change nothing', () => {
  clock = Date.parse('2026-01-01T00:00:00.000Z')
  let r = create()
  r = step(r, { op: 'node.start', node: 'a' })
  r = step(r, { op: 'question.ask', question: 'q1', node: 'a', text: '?', to: 'Person' })
  clock = Date.now()
  const after = summarize(r, G)
  assert.equal(r.nodes.a.state, 'waiting')
  assert.equal(after.state, 'in-progress')
  assert.ok(Date.now() - Date.parse(r.updated) > 1000 * 3600 * 24 * 30)
  assert.equal(checkRecord(JSON.parse(JSON.stringify(r)), G).ok, true)
})

test('replay is the authority: edited state, edited changes and gaps are inconsistent', () => {
  let r = create()
  r = step(r, { op: 'node.start', node: 'a' })
  r = step(r, { op: 'node.complete', node: 'a', outcome: 'ok' })
  assert.equal(checkRecord(structuredClone(r), G).ok, true)
  const state = structuredClone(r); state.nodes.b.state = 'completed'
  const s1 = checkRecord(state, G)
  assert.ok(!s1.ok && s1.code === 'inconsistent' && /nodes/.test(s1.message))
  const changed = structuredClone(r); changed.history[1].change = {}
  assert.equal((checkRecord(changed, G) as { code: string }).code, 'inconsistent')
  const gap = structuredClone(r); gap.history.splice(1, 1)
  assert.equal((checkRecord(gap, G) as { code: string }).code, 'sequence')
  const illegal = structuredClone(r); (illegal.history[1] as { node: string }).node = 'j'
  assert.equal((checkRecord(illegal, G) as { code: string }).code, 'not-ready')
  assert.equal((checkRecord({ schema: 'x' }, G) as { code: string }).code, 'schema')
  const { state: replayed } = replay(r.history, G)
  assert.equal(replayed.seq, 3)
  assert.throws(() => operate(r, { op: 'node.start', node: 'b' }, { at: tick(), by: 'P', via: 'test', graph: G, expectSeq: 2 }), (e: unknown) => (e as RunError).code === 'outdated')
})

test('run cancellation cancels open nodes in the same entry and stops further records', () => {
  let r = create()
  r = step(r, { op: 'node.start', node: 'a' })
  r = step(r, { op: 'run.cancel', reason: 'priorities changed' }, 'Person')
  assert.equal(r.execution.state, 'cancelled')
  assert.deepEqual(Object.values(r.nodes).map(n => n.state), ['cancelled', 'cancelled', 'cancelled', 'cancelled'])
  assert.deepEqual(Object.keys(r.history.at(-1)!.change.nodes!).sort(), ['a', 'b', 'c', 'j'])
  refused(() => step(r, { op: 'node.start', node: 'b' }), 'run-cancelled')
  const rejected = step(r, { op: 'run.decide', decision: 'rejected', evidence: 'cancelled' }, 'Person')
  assert.equal(rejected.decisions[0].decision, 'rejected')
})

test('a graph with a delegate node is refused by the reducer itself', () => {
  const D: RunGraph = { nodes: { a: { type: 'do' }, d: { type: 'delegate', workflow: 'other' } }, edges: [{ from: 'a', to: 'd' }] }
  refused(() => create(D), 'delegate-unsupported')
  assert.throws(() => operate(create(), { op: 'node.delegate', node: 'a' } as unknown as OpInput, { at: tick(), by: 'A', via: 'test', graph: G }), (e: unknown) => (e as RunError).code === 'op-unknown')
})

// ---- files -------------------------------------------------------------------------

const wf = (id: string, nodes: string, edges: string) => `schema: ag.workflow.v1
id: ${id}
name: ${id}
intent: |
  Test workflow ${id}.
repositories:
  docs: {path: devdocs, access: editable}
nodes:
${nodes}
edges:
${edges}
`
const node = (id: string, type: string, extra = '') => `  ${id}:\n    type: ${type}\n    description: ${id} step\n${extra}`
const SHIP = wf('ship', [node('survey', 'study'), node('build', 'do'), node('ask', 'talk'), node('join', 'do')].join(''),
  '  - {from: survey, to: build}\n  - {from: survey, to: ask}\n  - {from: build, to: join}\n  - {from: ask, to: join}')
const HANDOFF = wf('handoff', [node('prepare', 'do'), node('pass', 'delegate', '    workflow: ship\n')].join(''), '  - {from: prepare, to: pass}')
const braindump = (text = 'I want a small game.'): CreateRunOptions['input'] => ({ kind: 'braindump', text, author: 'Test Person', recordedBy: 'Omni Agent' })
const base = (o: Partial<CreateRunOptions> = {}): CreateRunOptions => ({ workflow: 'ship', input: braindump(), executor: { name: 'Omni Agent', backend: 'test-harness' }, by: 'Omni Agent', via: 'cli', ...o })

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-runs-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

// A fresh project in the given devdocs mode, registered in its own registry.
async function project(id: string, mode: 'directory' | 'submodule') {
  const registry = join(root, `${id}.registry.json`)
  const dir = join(root, `pj-${id}`)
  const r = await createProject({ dir, id, name: id.toUpperCase(), intent: 'x', goals: ['g'], devdocs: mode, sourcesDir: join(root, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  for (const [wid, text] of [['ship', SHIP], ['handoff', HANDOFF]]) await writeFile(join(dir, 'devdocs', 'workflows', `${wid}.yaml`), text)
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  // Commits devdocs in its owning repository (and, in submodule mode, the root's gitlink).
  const commit = async (message: string) => {
    if (mode === 'submodule') {
      await gitOk(join(dir, 'devdocs'), ['add', '-A'])
      await gitOk(join(dir, 'devdocs'), ['commit', '-q', '-m', message])
      await gitOk(dir, ['add', 'devdocs'])
      await gitOk(dir, ['commit', '-q', '-m', `root: ${message}`])
      return { owner: (await gitOk(join(dir, 'devdocs'), ['rev-parse', 'HEAD'])).trim(), root: (await gitOk(dir, ['rev-parse', 'HEAD'])).trim() }
    }
    await gitOk(dir, ['add', '-A'])
    await gitOk(dir, ['commit', '-q', '-m', message])
    const h = (await gitOk(dir, ['rev-parse', 'HEAD'])).trim()
    return { owner: h, root: h }
  }
  return { dir, ws, registry, commit }
}

test('creation in both modes: the new layout, project identity, authorship and context; no machine paths', async () => {
  for (const mode of ['directory', 'submodule'] as const) {
    const { dir, ws } = await project(`c-${mode.slice(0, 3)}`, mode)
    assert.equal((await ws.devdocs()).mode, mode)
    assert.deepEqual((await ws.structure()).diagnostics.filter(d => d.severity === 'error'), [])
    const c = await createRun(ws, base())
    assert.equal(c.dir, 'devdocs/runs/ship/run-001')
    assert.equal(c.record.project, `c-${mode.slice(0, 3)}`)
    assert.equal(c.record.schema, 'ag.workflow-run.v2')
    assert.deepEqual(Object.keys(c.record.definition.workflows), ['ship'])
    assert.equal(await readFile(join(dir, c.dir, 'definition', 'ship.yaml'), 'utf8'), SHIP)
    assert.deepEqual(c.record.input, { kind: 'braindump', file: 'braindump.md', author: 'Test Person', recordedBy: 'Omni Agent' })
    assert.equal(await readFile(join(dir, c.dir, 'braindump.md'), 'utf8'), 'I want a small game.')
    assert.deepEqual(c.record.context.repositories.map(r => r.path).sort(), ['.', 'devdocs'])
    assert.ok(!JSON.stringify(c.record).includes(root), 'no machine paths in the record')
    assert.ok((await readRun(ws, c.ref)).record)
    assert.equal((await createRun(ws, base())).ref.run, 'run-002', 'the next number')
    assert.deepEqual((await listRuns(ws)).map(r => r.ref), ['ship/run-001', 'ship/run-002'])
  }
})

test('delegate execution is refused before anything is written; the definition stays valid with a warning', async () => {
  const { dir, ws } = await project('deleg', 'directory')
  const wr = await ws.workflowResponse('handoff.yaml')
  assert.equal(wr.issues.filter(i => i.severity === 'error').length, 0)
  assert.ok(wr.issues.some(i => i.code === 'delegate-not-executable' && i.node === 'pass'))
  await assert.rejects(createRun(ws, base({ workflow: 'handoff' })), (e: unknown) => e instanceof RequestError && e.status === 422 && /delegate/.test(e.message))
  await assert.rejects(stat(join(dir, 'devdocs', 'runs', 'handoff')), 'nothing was written')
})

test('requests keep their requester and entrusting reference; collisions never overwrite', async () => {
  const { dir, ws } = await project('req', 'directory')
  const req = await createRun(ws, base({ name: 'run-derived', input: { kind: 'request', text: 'Build the game, focusing on bots.', requester: 'Omni Agent', entrustedBy: { kind: 'note', text: 'VS Code conversation 2026-10-10' }, onBehalfOf: 'Test Person', original: 'raw words of the person' } }))
  assert.deepEqual(req.record.input, { kind: 'request', file: 'request.md', requester: 'Omni Agent', entrustedBy: { kind: 'note', text: 'VS Code conversation 2026-10-10' }, onBehalfOf: 'Test Person', original: 'original-input.md' })
  assert.equal(req.record.input.author, undefined, 'no human author is invented for a request')
  assert.equal(await readFile(join(dir, req.dir, 'original-input.md'), 'utf8'), 'raw words of the person')
  const before = await readFile(join(dir, req.dir, 'run.json'), 'utf8')
  await assert.rejects(createRun(ws, base({ name: 'run-derived', input: braindump('other words') })), (e: unknown) => e instanceof RequestError && e.status === 409)
  assert.equal(await readFile(join(dir, req.dir, 'run.json'), 'utf8'), before)
  await assert.rejects(createRun(ws, base({ name: 'bad name' })), (e: unknown) => e instanceof RequestError && e.status === 400)
  await assert.rejects(createRun(ws, base({ input: { kind: 'braindump', text: 'x', author: '' } })), /author/)
})

test('a run keeps its captured definition when the source is edited, renamed or deleted', async () => {
  const { dir, ws } = await project('fixed', 'directory')
  const c = await createRun(ws, base({ name: 'run-fixed' }))
  const src = join(dir, 'devdocs', 'workflows')
  await writeFile(join(src, 'ship.yaml'), SHIP.replace('survey step', 'survey step, edited later'))
  let v = await runResponse(ws, c.ref)
  assert.equal(v.bundle.ship.workflow?.nodes.survey.description, 'survey step')
  assert.equal(v.sources.find(s => s.workflow === 'ship')?.status, 'changed')
  await rename(join(src, 'ship.yaml'), join(src, 'ship-renamed.yaml'))
  v = await runResponse(ws, c.ref)
  assert.equal(v.sources.find(s => s.workflow === 'ship')?.renamed, true)
  await unlink(join(src, 'ship-renamed.yaml'))
  v = await runResponse(ws, c.ref)
  assert.equal(v.sources.find(s => s.workflow === 'ship')?.status, 'deleted')
  const r = await runOp(ws, c.ref, { op: 'node.start', node: 'survey' }, { via: 'cli' })
  assert.equal(r.record.nodes.survey.state, 'running', 'the run follows its own copy')
})

test('malformed, inconsistent, foreign, old-format or tampered records are visible problems and never rewritten', async () => {
  const { dir, ws } = await project('broken', 'directory')
  const c = await createRun(ws, base({ name: 'run-broken' }))
  const file = join(dir, c.dir, 'run.json')
  const good = await readFile(file, 'utf8')
  await writeFile(file, good.slice(0, 50))
  let list = await listRuns(ws, 'ship')
  assert.equal(list.find(s => s.run === 'run-broken')?.problem?.code, 'malformed')
  await assert.rejects(runOp(ws, c.ref, { op: 'node.start', node: 'survey' }, { via: 'cli' }), (e: unknown) => e instanceof RequestError && e.status === 409)
  assert.equal(await readFile(file, 'utf8'), good.slice(0, 50), 'not overwritten')
  const tampered = JSON.parse(good); tampered.nodes.survey.state = 'completed'
  await writeFile(file, JSON.stringify(tampered))
  list = await listRuns(ws, 'ship')
  assert.equal(list.find(s => s.run === 'run-broken')?.problem?.code, 'inconsistent')
  const old = JSON.parse(good); old.schema = 'ag.workflow-run.v1'
  await writeFile(file, JSON.stringify(old))
  assert.equal((await listRuns(ws, 'ship')).find(s => s.run === 'run-broken')?.problem?.code, 'schema', 'an old format is unsupported, not empty')
  const foreign = JSON.parse(good); foreign.project = 'other'; foreign.history[0].project = 'other'
  await writeFile(file, JSON.stringify(foreign))
  assert.equal((await listRuns(ws, 'ship')).find(s => s.run === 'run-broken')?.problem?.code, 'location', 'a record of another project')
  await writeFile(file, good)
  await writeFile(join(dir, c.dir, 'definition', 'ship.yaml'), SHIP.replace('build step', 'sneaky'))
  const check = await checkRun(ws, c.ref)
  assert.equal(check.code, 'bundle')
  assert.match(check.problem!, /sha256/)
  await writeFile(join(dir, c.dir, 'definition', 'ship.yaml'), SHIP)
  assert.equal((await checkRun(ws, c.ref)).ok, true)
  // The p3 layout is reported, not listed or converted.
  await mkdir(join(dir, 'devdocs', 'ship', 'runs', 'run-001'), { recursive: true })
  const diags = (await ws.structure()).diagnostics
  assert.ok(diags.some(d => d.code === 'runs-old-layout'))
  assert.deepEqual((await listRuns(ws)).map(r => r.ref), ['ship/run-broken'])
})

test('a declared mode that disagrees with Git is reported and blocks run creation', async () => {
  const { dir, ws } = await project('mismatch', 'directory')
  await writeFile(join(dir, 'project.yaml'), (await readFile(join(dir, 'project.yaml'), 'utf8')).replace('devdocs: directory', 'devdocs: submodule'))
  const diags = (await ws.structure()).diagnostics
  assert.ok(diags.some(d => d.code === 'devdocs-mode-mismatch'), JSON.stringify(diags))
  await assert.rejects(createRun(ws, base()), /submodule/)
  await writeFile(join(dir, 'project.yaml'), (await readFile(join(dir, 'project.yaml'), 'utf8')).replace('devdocs: submodule', ''))
  assert.ok((await ws.structure()).diagnostics.some(d => d.code === 'devdocs-mode-undeclared'))
})

test('in both modes, two commits each reconstruct the fixed workflow and the stage; root commits resolve through the gitlink', async () => {
  for (const mode of ['directory', 'submodule'] as const) {
    const { dir, ws, commit } = await project(`hist-${mode.slice(0, 3)}`, mode)
    const c = await createRun(ws, base({ name: 'run-git' }))
    await runOp(ws, c.ref, { op: 'node.start', node: 'survey' }, { via: 'cli' })
    await writeFile(join(dir, c.dir, 'report.md'), 'Report at the first commit.')
    const first = await commit('run-git: survey started')
    await runOp(ws, c.ref, { op: 'node.complete', node: 'survey', outcome: 'ok' }, { via: 'cli' })
    await runOp(ws, c.ref, { op: 'node.start', node: 'build' }, { via: 'cli' })
    await runOp(ws, c.ref, { op: 'node.start', node: 'ask' }, { via: 'cli' })
    await runOp(ws, c.ref, { op: 'question.ask', question: '', node: 'ask', text: 'Which map size?', to: 'Test Person' }, { via: 'cli' })
    await writeFile(join(dir, c.dir, 'report.md'), 'Report at the second commit.')
    await commit('run-git: ask waits')
    await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), SHIP.replace('join step', 'join step v2'))
    await writeFile(join(dir, c.dir, 'report.md'), 'Uncommitted report.')
    const a = await runResponse(ws, c.ref, { rev: first.owner })
    assert.ok(a.record, `${mode}: ${a.problem?.message}`)
    assert.equal(a.revInfo?.owner, mode === 'directory' ? 'root' : 'devdocs')
    assert.equal(a.record!.seq, 2)
    assert.equal(a.record!.nodes.survey.state, 'running')
    assert.equal(a.bundle.ship.workflow?.nodes.join.description, 'join step')
    const viaRoot = await runResponse(ws, c.ref, { rev: `root:${first.root}` })
    assert.equal(viaRoot.record?.seq, 2, `${mode}: a root commit reaches the same stage`)
    assert.equal(viaRoot.revInfo?.commit, first.owner)
    if (mode === 'submodule') assert.equal(viaRoot.revInfo?.root, first.root, 'the displayed revision names the followed gitlink')
    const b = await runResponse(ws, c.ref, { rev: 'HEAD' })
    assert.equal(b.record!.seq, 6)
    assert.equal(b.record!.questions.q1.text, 'Which map size?')
    assert.equal((await readRunFile(ws, c.ref, 'report.md', { rev: first.owner })).text, 'Report at the first commit.')
    assert.equal((await readRunFile(ws, c.ref, 'report.md', { rev: 'HEAD' })).text, 'Report at the second commit.')
    assert.equal((await readRunFile(ws, c.ref, 'report.md')).text, 'Uncommitted report.')
    await writeFile(join(dir, c.dir, 'later.md'), 'Only in the working tree.')
    await assert.rejects(readRunFile(ws, c.ref, 'later.md', { rev: first.owner }), (e: unknown) => e instanceof RequestError && e.status === 404, 'never falls back to current files')
    await assert.rejects(runResponse(ws, c.ref, { rev: 'not-a-commit' }), (e: unknown) => e instanceof RequestError && e.status === 404)
  }
})

test('wfe run: create, show, answer and check from the command line', async () => {
  const { dir, registry } = await project('cli', 'directory')
  const cwd = process.cwd()
  process.chdir(dir)
  const logs: string[] = []
  const log = console.log
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')) }
  try {
    await writeFile(join(root, 'bd.md'), 'The person\'s words.')
    const env = ['--registry', registry]
    assert.equal(await main(['run', 'create', 'ship', '--braindump', join(root, 'bd.md'), '--author', 'Test Person', '--executor', 'Omni Agent', '--name', 'run-cli', ...env]), 0)
    assert.equal(await main(['run', 'create', 'handoff', '--braindump', join(root, 'bd.md'), '--author', 'Test Person', '--executor', 'Omni Agent', ...env]), 1, 'delegate refused in the CLI')
    assert.equal(await main(['run', 'delegate', 'ship/run-cli', 'survey', ...env]), 2, 'no delegate subcommand')
    assert.equal(await main(['run', 'start', 'ship/run-cli', 'survey', ...env]), 0)
    assert.equal(await main(['run', 'start', 'run-cli', 'build', ...env]), 1, 'not ready: refused')
    assert.equal(await main(['run', 'ask', 'run-cli', 'survey', '--question', 'Scope?', '--to', 'Test Person', ...env]), 0)
    assert.equal(await main(['run', 'answer', 'run-cli', 'q1', '--answer', 'Small.', '--by', 'Test Person', '--expect-seq', '1', ...env]), 1, 'outdated view refused')
    assert.equal(await main(['run', 'answer', 'run-cli', 'q1', '--answer', 'Small.', '--by', 'Test Person', '--expect-seq', '3', ...env]), 0)
    logs.length = 0
    assert.equal(await main(['run', 'show', 'run-cli', ...env]), 0)
    const shown = logs.join('\n')
    assert.match(shown, /survey\s+waiting\s+waits: question q1; next move: Omni Agent \(answer recorded, not yet taken up\)/)
    assert.match(shown, /the words of Test Person/)
    assert.match(shown, /Project: cli/)
    await writeFile(join(dir, 'devdocs', 'runs', 'ship', 'run-cli', 'report1.md'), '# Survey\n')
    assert.equal(await main(['run', 'attach', 'run-cli', 'report1.md', '--node', 'survey', ...env]), 0)
    logs.length = 0
    assert.equal(await main(['run', 'list', 'ship', '--json', ...env]), 0)
    const list = JSON.parse(logs.join('\n')) as { runs: { run: string; waiting: unknown[] }[] }
    assert.deepEqual(list.runs.find(r => r.run === 'run-cli')?.waiting, [{ node: 'survey', holder: 'Omni Agent (answer recorded, not yet taken up)' }])
    const rec = JSON.parse(await readFile(join(dir, 'devdocs', 'runs', 'ship', 'run-cli', 'run.json'), 'utf8')) as RunRecord
    assert.deepEqual(rec.artifacts.map(a => a.path), ['devdocs/runs/ship/run-cli/report1.md'])
    assert.deepEqual(rec.history.map(e => e.via), ['cli', 'cli', 'cli', 'cli', 'cli'])
    assert.equal(rec.questions.q1.answers[0].by, 'Test Person')
  } finally {
    console.log = log
    process.chdir(cwd)
  }
})

async function serve(registry: string) {
  const { createHandler } = await import('../server/api.ts')
  const { createServer } = await import('node:http')
  const handler = createHandler({ registryFile: registry, area: root, allowedOrigins: [], allowedHosts: ['127.0.0.1'] })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  return { server, port: (server.address() as { port: number }).port }
}

test('HTTP: list, read, answer with the stale-view guard, read history; delegate refused', async () => {
  const { ws, registry, commit, dir } = await project('http', 'submodule')
  const { server, port } = await serve(registry)
  const url = `http://127.0.0.1:${port}/api/workspaces/http`
  const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const c = await createRun(ws, base({ name: 'run-http' }))
    await runOp(ws, c.ref, { op: 'node.start', node: 'survey' }, { via: 'cli' })
    await runOp(ws, c.ref, { op: 'question.ask', question: '', node: 'survey', text: 'Scope?', to: 'Test Person' }, { via: 'cli' })
    const list = await (await fetch(`${url}/runs`)).json() as { ref: string; waiting?: unknown[] }[]
    assert.deepEqual(list.find(r => r.ref === 'ship/run-http')?.waiting, [{ node: 'survey', holder: 'Test Person' }])
    const view = await (await fetch(`${url}/runs/ship/run-http`)).json() as { record: RunRecord; bundle: Record<string, unknown> }
    assert.equal(view.record.seq, 3)
    let r = await post('/runs/ship/run-http/ops', { op: 'question.answer', question: 'q1', text: 'Small', by: 'Test Person', expectSeq: 2 })
    assert.equal(r.status, 409)
    r = await post('/runs/ship/run-http/ops', { op: 'question.answer', question: 'q1', text: 'Small', expectSeq: 3 })
    assert.equal(r.status, 400, 'a name is required')
    r = await post('/runs/ship/run-http/ops', { op: 'question.answer', question: 'q1', text: 'Small', by: 'Test Person', expectSeq: 3 })
    assert.equal(r.status, 200)
    const rec = (await r.json() as { record: RunRecord }).record
    assert.deepEqual([rec.questions.q1.answers[0].via, rec.questions.q1.answers[0].by, rec.nodes.survey.state], ['browser', 'Test Person', 'waiting'])
    assert.equal((await post('/runs/ship/run-http/ops', { op: 'run.create', by: 'x' })).status, 400)
    assert.equal((await post('/runs/ship/run-http/ops', { op: 'node.delegate', node: 'survey', by: 'x' })).status, 400, 'no delegate operation over HTTP')
    assert.equal((await post('/runs/ship/run-http/ops', { op: 'node.start', node: 'join', by: 'Test Person' })).status, 422)
    const file = await (await fetch(`${url}/runs/ship/run-http/file?path=braindump.md`)).json() as { text: string }
    assert.equal(file.text, 'I want a small game.')
    await writeFile(join(dir, c.dir, 'report.md'), 'committed')
    const at = await commit('http report')
    await writeFile(join(dir, c.dir, 'report.md'), 'uncommitted')
    const reportUrl = `${url}/runs/ship/run-http/file?path=report.md`
    assert.equal((await (await fetch(`${reportUrl}&rev=${at.owner}`)).json()).text, 'committed')
    assert.equal((await (await fetch(`${reportUrl}&rev=root:${at.root}`)).json()).text, 'committed')
    assert.equal((await (await fetch(reportUrl)).json()).text, 'uncommitted')
    assert.equal((await fetch(`${reportUrl}&rev=not-a-commit`)).status, 404)
    assert.equal((await fetch(`${url}/runs/ship/run-http/file?path=../../workflows/ship.yaml`)).status, 404)
    assert.equal((await fetch(`${url}/runs/ship/run-nope`)).status, 200, 'a missing run is a response with its problem')
  } finally {
    server.closeAllConnections(); server.close()
  }
})

test('watcher: run.json changes, report files and new runs are separate events in the new layout', async () => {
  const { ws, registry, dir } = await project('watch', 'directory')
  const { Watcher } = await import('../server/watch.ts')
  const w = new Watcher(1000, { registryFile: registry })
  const c = await createRun(ws, base({ name: 'run-watch' }))
  const s0 = await w.snapshot({ ws, snapshot: null })
  await runOp(ws, c.ref, { op: 'node.start', node: 'survey' }, { via: 'cli' })
  const s1 = await w.snapshot({ ws, snapshot: s0 })
  assert.deepEqual(w.diff('r', s0, s1).map(e => [e.kind, e.run]), [['run', 'ship/run-watch']])
  await writeFile(join(dir, c.dir, 'report1.md'), '# r\n')
  const s2 = await w.snapshot({ ws, snapshot: s1 })
  const e2 = w.diff('r', s1, s2)
  assert.deepEqual(e2.map(e => [e.kind, e.run]), [['run', 'ship/run-watch']])
  assert.equal(e2[0].rev, s1.get('\0run:ship/run-watch')?.hash, 'the record itself did not change')
  const d = await createRun(ws, base({ name: 'run-watch2' }))
  const s3 = await w.snapshot({ ws, snapshot: s2 })
  assert.deepEqual(w.diff('r', s2, s3).map(e => [e.kind, e.run ?? null]), [['run', `ship/${d.ref.run}`], ['runs', null]])
  assert.equal(w.diff('r', s3, await w.snapshot({ ws, snapshot: s3 })).length, 0, 'an idle tick reports nothing')
})

test('operation parity: every operation through HTTP yields the same record as through the CLI module', async () => {
  const { ws, registry } = await project('parity', 'directory')
  const { server, port } = await serve(registry)
  const url = `http://127.0.0.1:${port}/api/workspaces/parity`
  const ops: (OpInput & Record<string, unknown>)[] = [
    { op: 'node.start', node: 'survey' },
    { op: 'node.progress', node: 'survey', text: 'half way' },
    { op: 'question.ask', question: '', node: 'survey', text: 'Scope?', to: 'Test Person' },
    { op: 'question.answer', question: 'q1', text: 'Small', from: 'Test Person' },
    { op: 'question.take-up', question: 'q1' },
    { op: 'artifact.attach', path: 'devdocs/README.md', node: 'survey', title: 'readme' },
    { op: 'node.complete', node: 'survey', outcome: 'ok', artifacts: ['devdocs/README.md'] },
    { op: 'node.start', node: 'build' },
    { op: 'node.wait', node: 'build', reason: 'CI', holder: 'CI service', external: 'build #12' },
    { op: 'node.start', node: 'build' },
    { op: 'node.fail', node: 'build', reason: 'red' },
    { op: 'node.start', node: 'build', reason: 'retry by hand' },
    { op: 'node.cancel', node: 'build', reason: 'dropped' },
    { op: 'node.start', node: 'ask' },
    { op: 'question.ask', question: '', node: 'ask', text: 'Withdrawn later', to: 'Test Person' },
    { op: 'question.withdraw', question: 'q2', reason: 'not needed' },
    { op: 'run.decide', decision: 'rejected', evidence: 'the build was dropped' },
    { op: 'run.cancel', reason: 'parity done' },
  ]
  try {
    const a = await createRun(ws, base({ name: 'run-parity-cli' }))
    const b = await createRun(ws, base({ name: 'run-parity-http' }))
    for (const o of ops) {
      await runOp(ws, a.ref, o, { via: 'cli', by: 'Omni Agent' })
      const r = await fetch(`${url}/runs/ship/run-parity-http/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...o, by: 'Omni Agent' }) })
      assert.equal(r.status, 200, `${o.op}: ${await r.clone().text()}`)
    }
    const norm = (rec: RunRecord) => JSON.parse(JSON.stringify(rec)
      .replace(/"\d{4}-\d\d-\d\dT[^"]+Z"/g, '"T"').replace(/"via":"(cli|browser)"/g, '"via":"V"').replace(/run-parity-(cli|http)/g, 'run-P').replace(/"dirty":\d+/g, '"dirty":0'))
    const ra = (await readRun(ws, a.ref)).record!, rb = (await readRun(ws, b.ref)).record!
    assert.deepEqual(norm(rb), norm(ra))
    assert.deepEqual([...new Set(rb.history.slice(1).map(e => e.via))], ['browser'])
  } finally {
    server.closeAllConnections(); server.close()
  }
})

test('access declarations are path scopes; the run may write only its own records under a readonly root', async () => {
  const { accessAt } = await import('../shared/access.ts')
  const b = { root: { path: '.', access: 'readonly' }, docs: { path: 'devdocs', access: 'readonly' }, game: { path: 'game', access: 'editable' } }
  const dir = 'devdocs/runs/ship/run-001'
  assert.equal(accessAt(b, 'src/main.ts', dir).access, 'readonly')
  assert.deepEqual([accessAt(b, 'game/a.js', dir).access, accessAt(b, 'game/a.js', dir).binding], ['editable', 'game'])
  assert.equal(accessAt(b, `${dir}/report1.md`, dir).access, 'report')
  assert.equal(accessAt(b, 'devdocs/runs/ship/run-002/run.json', dir).access, 'readonly', 'another run is not the run\'s own records')
  assert.equal(accessAt(b, 'devdocs/workflows/ship.yaml', dir).access, 'readonly', 'nor are workflow definitions')
  assert.equal(accessAt({ game: { path: 'game', access: 'editable' } }, 'README.md', dir).access, 'undeclared')
  assert.equal(accessAt(b, '../outside', dir).access, 'undeclared')
})
