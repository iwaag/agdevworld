// p10 (docs/delegation.md): delegation across managed projects. Step 1 —
// the definition: a portable target (project + workflow), who may accept
// the child's result, validation against the registry's projects, and
// digests that stay as they were for workflows without the new fields.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { semanticDigest } from '../shared/canonical.ts'
import { compile } from '../shared/compile.ts'
import { cloneWorkflow, emptyWorkflow, type Workflow } from '../shared/model.ts'
import { delegateTargets, validateWorkflow, type ValidationContext } from '../shared/validate.ts'
import { newWorkflowText, parseWorkflow } from '../server/yamlDoc.ts'

const codes = (issues: { code: string; severity: string }[], severity = 'error') =>
  issues.filter(i => i.severity === severity).map(i => i.code).sort()

function parent(node: Partial<Workflow['nodes'][string]>): Workflow {
  const w = emptyWorkflow('use-asset', 'Use an asset')
  w.intent = 'Get an asset from forge and use it.'
  w.documentation = { policy: 'manual' }
  w.nodes.prepare = { type: 'do', name: '', description: 'Prepare.', repositories: [] }
  w.nodes.asset = { type: 'delegate', name: 'Get the asset', description: 'Ask forge.', repositories: [], ...node }
  w.edges.push({ from: 'prepare', to: 'asset' })
  return w
}

const registry = (forge: { id: string; delegates?: string[]; intake?: boolean }[]): ValidationContext => ({
  project: 'agops',
  workflows: [{ id: 'use-asset', file: 'use-asset.yaml', delegates: ['forge/provide'] }, { id: 'local', file: 'local.yaml', delegates: [], intake: true }],
  file: 'use-asset.yaml',
  projects: { forge: forge.map(f => ({ id: f.id, file: `${f.id}.yaml`, delegates: f.delegates ?? [], intake: f.intake ?? true })) },
})

test('a delegate names a portable target: project and workflow, read and written back', () => {
  const w = parent({ project: 'forge', workflow: 'provide', accepts: 'parent' })
  const text = newWorkflowText(w)
  assert.match(text, /project: forge/)
  assert.match(text, /accepts: parent/)
  const back = parseWorkflow(text)
  assert.ok(back.ok)
  assert.deepEqual({ project: back.model.nodes.asset.project, workflow: back.model.nodes.asset.workflow, accepts: back.model.nodes.asset.accepts }, { project: 'forge', workflow: 'provide', accepts: 'parent' })
  assert.deepEqual(delegateTargets(back.model, 'agops'), ['forge/provide'])
  // The same project, named explicitly, is the same target as none.
  assert.deepEqual(delegateTargets(parent({ project: 'agops', workflow: 'local' }), 'agops'), ['local'])
  const compiled = compile(back.model)
  assert.ok(compiled.ok)
  assert.deepEqual(compiled.graph.nodes.asset, { type: 'delegate', workflow: 'provide', project: 'forge', accepts: 'parent' })
})

test('cross-project targets are validated against the registry', () => {
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'forge', workflow: 'provide' }), registry([{ id: 'provide' }]))), [])
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'forge', workflow: 'nope' }), registry([{ id: 'provide' }]))), ['delegate-target-unknown'])
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'nobody', workflow: 'provide' }), registry([{ id: 'provide' }]))), ['delegate-project-unknown'])
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'Bad Id', workflow: 'provide' }), registry([]))), ['delegate-project-unknown'])
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'forge', workflow: 'provide', accepts: 'anyone' }), registry([{ id: 'provide' }]))), ['delegate-accepts'])
  assert.ok(codes(validateWorkflow(parent({ project: 'forge', workflow: 'provide' }), registry([{ id: 'provide', intake: false }])), 'warning').includes('delegate-no-intake'))
  // Without a registry, another project's workflow cannot be checked and is not called unknown.
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'forge', workflow: 'provide' }), { project: 'agops', workflows: [], file: 'use-asset.yaml' })), [])
  // Its own workflow in its own project is itself; the same id in another project is not.
  assert.deepEqual(codes(validateWorkflow(parent({ workflow: 'use-asset' }), registry([]))), ['delegate-self'])
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'agops', workflow: 'use-asset' }), registry([]))), ['delegate-self'])
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'forge', workflow: 'use-asset' }), registry([{ id: 'use-asset' }]))), [])
})

test('delegation that comes back across projects is recursive', () => {
  const back = registry([{ id: 'provide', delegates: ['agops/use-asset'] }])
  const issues = validateWorkflow(parent({ project: 'forge', workflow: 'provide' }), back)
  assert.ok(codes(issues).includes('delegate-recursive'), JSON.stringify(issues))
  assert.match(issues.find(i => i.code === 'delegate-recursive')!.message, /use-asset → forge\/provide → use-asset/)
  // Through a third workflow of the target project.
  const via = registry([{ id: 'provide', delegates: ['helper'] }, { id: 'helper', delegates: ['agops/use-asset'] }])
  assert.ok(codes(validateWorkflow(parent({ project: 'forge', workflow: 'provide' }), via)).includes('delegate-recursive'))
  // Not recursive: the target delegates elsewhere.
  const other = registry([{ id: 'provide', delegates: ['helper'] }, { id: 'helper' }])
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'forge', workflow: 'provide' }), other)), [])
})

test('the new fields on another node type are flagged, and digests without them are unchanged', async () => {
  const w = parent({ workflow: 'local' })
  const odd = cloneWorkflow(w)
  odd.nodes.prepare.accepts = 'parent'
  assert.ok(codes(validateWorkflow(odd, registry([])), 'warning').includes('workflow-on-non-delegate'))
  // A delegate without project/accepts projects exactly as before p10.
  const before = await semanticDigest('definition', w)
  const same = cloneWorkflow(w)
  delete same.nodes.asset.project
  delete same.nodes.asset.accepts
  assert.equal(await semanticDigest('definition', same), before)
  // Declaring them is a change of the definition.
  assert.notEqual(await semanticDigest('definition', parent({ workflow: 'local', accepts: 'parent' })), before)
  assert.notEqual(await semanticDigest('definition', parent({ project: 'forge', workflow: 'local' })), before)
})

// ---- step 2: the reducer's rules for the relationship ------------------------------------

import { checkRecord, operate, RunError, type OpInput, type RunGraph } from '../shared/run.ts'

const DG = (accepts?: string): RunGraph => ({ nodes: { asset: { type: 'delegate', project: 'kid', workflow: 'make', ...(accepts ? { accepts } : {}) }, use: { type: 'do' } }, edges: [{ from: 'asset', to: 'use' }] })
let clock = Date.parse('2026-10-15T00:00:00.000Z')
const tick = () => new Date(clock += 1000).toISOString()
const H = '0'.repeat(64)
const doc = (path: string) => ({ path, sha256: H, bytes: 10 })
function parentRun(graph: RunGraph) {
  let r = operate(null, {
    op: 'run.create', project: 'par', workflow: 'use', run: 'run-001', nodes: Object.keys(graph.nodes),
    input: { kind: 'braindump', file: 'braindump.md', author: 'Pat' }, executor: { name: 'par-agent', backend: null, host: 'autolab' },
    predecessor: null, definition: { root: 'use', workflows: {}, warnings: [] }, context: { repositories: [] },
  }, { at: tick(), by: 'autolab', via: 'test', graph })
  const step = (op: OpInput, meta: { attempt?: string; receipt?: string } = {}, by = 'par-agent') => { r = operate(r, { ...op, ...meta } as never, { at: tick(), by, via: 'test', graph }); return r }
  return { get r() { return r }, step, graph }
}
const refused = (f: () => unknown, code: string) => assert.throws(f, (e: unknown) => e instanceof RunError && e.code === code, `expected ${code}`)
const UID = 'par/use/run-001#0123456789abcdef'
const dispatch = (p: ReturnType<typeof parentRun>, id = 'd1', extra: Record<string, unknown> = {}, meta = {}) => p.step({ op: 'delegation.dispatch', delegation: id, uid: `${UID}/${id}`, node: 'asset', target: { project: 'kid', workflow: 'make', workspace: 'kid' }, request: doc(`devdocs/runs/use/run-001/delegations/${id}/request.md`), ...extra } as never, meta)
const bind = (p: ReturnType<typeof parentRun>, id = 'd1', run = 'run-001') => p.step({ op: 'delegation.bind', delegation: id, child: { uid: `kid/make/${run}#fedcba9876543210`, workspace: 'kid', project: 'kid', workflow: 'make', run, created: tick() }, transport: { realm: 'z', message: 5, stream: 7, topic: 'request-x' } } as never, {}, 'wfe')
const relay = (p: ReturnType<typeof parentRun>, event: Record<string, unknown>, id = 'd1') => p.step({ op: 'delegation.event', delegation: id, event: { child: { seq: 3, at: tick(), by: 'kid-agent' }, text: '', ...event } } as never, {}, 'wfe')
const manifest = { digest: `sha256:${H}`, child: 'kid/make/run-001#fedcba9876543210', execution: 'completed', outcome: 'done', report: null, artifacts: [], decision: null, branch: null }

test('decision ownership: a result confirmation needs the person\'s words unless the node grants acceptance; answers need their question taken up', () => {
  const p = parentRun(DG())
  p.step({ op: 'attempt.begin', attempt: 'a1', reason: 'start' } as never, {}, 'autolab')
  p.step({ op: 'node.start', node: 'asset' }, { attempt: 'a1' })
  dispatch(p, 'd1', {}, { attempt: 'a1' })
  bind(p)
  relay(p, { type: 'question', question: 'q1', text: 'Accept the icon?', confirms: true, subject: [doc('icon.png')] })
  refused(() => p.step({ op: 'delegation.answer', delegation: 'd1', question: 'q1', text: 'Yes' } as never, { attempt: 'a1' }), 'delegation-event')
  p.step({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never, { attempt: 'a1' })
  assert.equal(p.r.nodes.asset.state, 'running', 'taking up resumes the node')
  refused(() => p.step({ op: 'delegation.answer', delegation: 'd1', question: 'q1', text: 'Yes' } as never, { attempt: 'a1' }), 'delegate-scope')
  // The parent asks its person, takes up their answer, relays it.
  p.step({ op: 'question.ask', question: 'q1', text: 'forge shows the icon; accept?', to: 'Pat' } as never, { attempt: 'a1' })
  p.step({ op: 'question.answer', question: 'q1', text: 'Yes, accept it.', from: 'Pat' } as never, {}, 'intake')
  p.step({ op: 'question.take-up', question: 'q1' } as never, { attempt: 'a1' })
  p.step({ op: 'delegation.answer', delegation: 'd1', question: 'q1', text: 'Accepted (Pat).', because: { kind: 'answer', question: 'q1' } } as never, { attempt: 'a1' })
  const a = p.r.delegations!.d1.answers[0]
  assert.deepEqual({ from: a.from, by: a.by, because: a.because?.kind }, { from: 'Pat', by: 'par-agent', because: 'answer' })
  assert.equal(p.r.nodes.asset.state, 'waiting', 'waits again once it answered')
  // With accepts: parent the agent answers itself.
  const q = parentRun(DG('parent'))
  q.step({ op: 'node.start', node: 'asset' }); dispatch(q); bind(q)
  relay(q, { type: 'question', question: 'q1', text: 'Accept?', confirms: true })
  q.step({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  q.step({ op: 'delegation.answer', delegation: 'd1', question: 'q1', text: 'Accepted.' } as never)
  assert.equal(q.r.delegations!.d1.answers[0].from, 'par-agent')
  assert.ok(checkRecord(JSON.parse(JSON.stringify(q.r)), q.graph).ok, 'the record replays')
})

test('a delegate node completes only on a satisfied, latest, taken-up result; a replacement names its predecessor', () => {
  const p = parentRun(DG())
  p.step({ op: 'node.start', node: 'asset' })
  refused(() => p.step({ op: 'node.complete', node: 'asset', outcome: 'x' }), 'delegation-unsatisfied')
  dispatch(p)
  refused(() => dispatch(p, 'd2'), 'delegation-open')
  bind(p)
  refused(() => p.step({ op: 'delegation.dispose', delegation: 'd1', disposition: 'satisfied', note: 'n' } as never), 'delegation-result')
  relay(p, { type: 'completed', text: 'done', manifest })
  relay(p, { type: 'completed', text: 'done again', manifest: { ...manifest, digest: `sha256:${'1'.repeat(64)}` } })
  p.step({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  refused(() => p.step({ op: 'delegation.dispose', delegation: 'd1', disposition: 'satisfied', note: 'n', event: 1 } as never), 'result-superseded')
  refused(() => p.step({ op: 'delegation.dispose', delegation: 'd1', disposition: 'satisfied', note: 'n' } as never), 'delegation-event')
  p.step({ op: 'delegation.take-up', delegation: 'd1', events: [2] } as never)
  p.step({ op: 'delegation.dispose', delegation: 'd1', disposition: 'rejected', note: 'wrong colour' } as never)
  refused(() => p.step({ op: 'node.complete', node: 'asset', outcome: 'x' }), 'delegation-unsatisfied')
  refused(() => dispatch(p, 'd2'), 'delegation-predecessor')
  dispatch(p, 'd2', { predecessor: 'd1' })
  assert.equal(p.r.delegations!.d2.predecessor, 'd1')
  bind(p, 'd2', 'run-002')
  relay(p, { type: 'completed', text: 'done', manifest }, 'd2')
  p.step({ op: 'delegation.take-up', delegation: 'd2', events: [1] } as never)
  p.step({ op: 'delegation.dispose', delegation: 'd2', disposition: 'satisfied', note: 'right colour' } as never)
  p.step({ op: 'node.complete', node: 'asset', outcome: 'got it' })
  assert.deepEqual(p.r.execution.ready, ['use'])
})

test('an attempt that ends with a waking fact it was started for untaken is interrupted; one that arrived during it is not', () => {
  const p = parentRun(DG())
  p.step({ op: 'node.start', node: 'asset' }); dispatch(p); bind(p)
  relay(p, { type: 'question', question: 'q1', text: 'Size?' })
  p.step({ op: 'attempt.begin', attempt: 'a1', reason: 'resume' } as never, {}, 'autolab')
  p.step({ op: 'attempt.end', attempt: 'a1', outcome: 'exited' } as never, {}, 'autolab')
  assert.equal(p.r.control.last?.outcome, 'interrupted')
  assert.match(p.r.control.last!.detail, /without taking up delegation event d1 question #1/)
  const q = parentRun(DG())
  q.step({ op: 'node.start', node: 'asset' }); dispatch(q); bind(q)
  q.step({ op: 'attempt.begin', attempt: 'a1', reason: 'resume' } as never, {}, 'autolab')
  relay(q, { type: 'question', question: 'q1', text: 'Size?' })
  q.step({ op: 'attempt.end', attempt: 'a1', outcome: 'exited' } as never, {}, 'autolab')
  assert.equal(q.r.control.last?.outcome, 'exited', 'it queues the next attempt instead')
  // Non-waking facts never interrupt.
  const n = parentRun(DG())
  n.step({ op: 'node.start', node: 'asset' }); dispatch(n); bind(n)
  relay(n, { type: 'held', text: 'interrupted', hold: 'interrupted' })
  n.step({ op: 'attempt.begin', attempt: 'a1', reason: 'resume' } as never, {}, 'autolab')
  n.step({ op: 'attempt.end', attempt: 'a1', outcome: 'exited' } as never, {}, 'autolab')
  assert.equal(n.r.control.last?.outcome, 'exited')
})

test('cancelling the parent closes its open delegation and records nothing more of the child; the child\'s acceptance needs the person when scoped so', () => {
  const p = parentRun(DG())
  p.step({ op: 'node.start', node: 'asset' }); dispatch(p); bind(p)
  p.step({ op: 'run.cancel', reason: 'not needed' }, {}, 'Pat')
  assert.match(p.r.delegations!.d1.closed!.reason, /parent run was cancelled: not needed; the child make\/run-001 in kid is left as it is/)
  refused(() => relay(p, { type: 'completed', text: 'late', manifest }), 'run-cancelled')
  // The child side: a confirmation answered by the requesting agent alone.
  const CG: RunGraph = { nodes: { confirm: { type: 'talk', confirms: 'result' } }, edges: [] }
  let c = operate(null, {
    op: 'run.create', project: 'kid', workflow: 'make', run: 'run-001', nodes: ['confirm'],
    input: { kind: 'request', file: 'request.md', requester: 'par-agent', onBehalfOf: 'Pat', entrustedBy: { kind: 'delegation', delegation: `${UID}/d1`, parent: { project: 'par', workflow: 'use', run: 'run-001', creation: '0123456789abcdef', node: 'asset' }, accepts: 'person' } },
    executor: { name: 'kid-agent', backend: null }, predecessor: null, definition: { root: 'make', workflows: {}, warnings: [] }, context: { repositories: [] },
  }, { at: tick(), by: 'intake', via: 'test', graph: CG })
  const st = (op: OpInput, by = 'kid-agent') => { c = operate(c, op, { at: tick(), by, via: 'test', graph: CG }); return c }
  st({ op: 'node.start', node: 'confirm' })
  st({ op: 'question.ask', question: 'q1', node: 'confirm', text: 'Accept?', to: 'par-agent', subject: [doc('icon.png')] } as never)
  refused(() => st({ op: 'question.answer', question: 'q1', text: 'Yes', from: 'par-agent', delegation: { uid: `${UID}/d9`, answer: 1 } } as never, 'par-agent'), 'delegate-relation')
  st({ op: 'question.answer', question: 'q1', text: 'Yes', from: 'par-agent', delegation: { uid: `${UID}/d1`, answer: 1 } } as never, 'par-agent')
  st({ op: 'question.take-up', question: 'q1' })
  refused(() => st({ op: 'run.decide', decision: 'accepted', question: 'q1', subject: [doc('icon.png')] } as never), 'delegate-scope')
  st({ op: 'run.decide', decision: 'rejected', question: 'q1', subject: [doc('icon.png')] } as never)
  assert.equal(c.decisions[0].decision, 'rejected', 'rejecting is not acceptance')
})
