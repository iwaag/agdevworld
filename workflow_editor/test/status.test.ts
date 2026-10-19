// project_migration p8 ex1 step 4: one shared reading of a run's status —
// a short state and reason for each representative situation, from the
// record's facts (and the host's job and a child's situation where known).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { operate, situation, type OpInput, type RunGraph, type RunRecord } from '../shared/run.ts'
import { causeText, runStatus } from '../shared/status.ts'

const GRAPH: RunGraph = { nodes: { talk: { type: 'talk' }, survey: { type: 'delegate', project: 'jevlab', workflow: 'study' }, render: { type: 'do' } }, edges: [] }
let t = Date.parse('2026-10-19T10:00:00Z')
function run(...ops: (OpInput & { attempt?: string; by?: string })[]): RunRecord {
  let r: RunRecord | null = null
  const create: OpInput = {
    op: 'run.create', project: 'front', workflow: 'converse', run: 'run-027', input: { kind: 'braindump', file: 'braindump.md', author: 'iwaag' },
    executor: { name: 'front-agent', backend: null }, predecessor: null, definition: { root: 'converse', workflows: {}, warnings: [] }, context: { repositories: [] }, nodes: Object.keys(GRAPH.nodes),
  }
  for (const { by, ...op } of [create, ...ops] as (OpInput & { by?: string })[]) r = operate(r, op as OpInput, { at: new Date(t += 1000).toISOString(), by: by ?? (op.op.startsWith('attempt.') ? 'autolab' : 'front-agent'), via: 'cli', graph: GRAPH })
  return r!
}
const A = 'atest-000001'
const began = { op: 'attempt.begin', attempt: A, reason: 'start' } as const
const ended = (o: Partial<{ outcome: string; detail: string }> = {}) => ({ op: 'attempt.end', attempt: A, outcome: o.outcome ?? 'exited', detail: o.detail ?? '', waits: 'defer-ready', explain: 'cause' }) as unknown as OpInput
const dispatch = { op: 'delegation.dispatch', delegation: 'd1', uid: 'front/converse/run-027#x/d1', node: 'survey', target: { project: 'jevlab', workflow: 'study', workspace: 'jevlab' }, request: { path: 'devdocs/runs/converse/run-027/delegations/d1/request.md', sha256: 'a'.repeat(64), bytes: 10 }, attempt: A } as unknown as OpInput
const bind = { op: 'delegation.bind', delegation: 'd1', child: { uid: 'jevlab/study/run-002#y', workspace: 'jevlab', project: 'jevlab', workflow: 'study', run: 'run-002', created: '2026-10-19T10:00:00Z' }, transport: { realm: 'r', message: 1, stream: 1, topic: 't' } } as unknown as OpInput
const finish = (n: string) => [{ op: 'node.start', node: n, attempt: A }, { op: 'node.complete', node: n, outcome: 'done', attempt: A }] as unknown as OpInput[]

test('a person\'s answer pending reads "Waiting · Your answer"; an answer recorded and not taken up is the executor\'s move', () => {
  let r = run(began, ...finish('survey'), ...finish('render'), { op: 'node.start', node: 'talk', attempt: A } as OpInput, { op: 'question.ask', question: 'q1', node: 'talk', text: 'Which one?', to: 'iwaag', attempt: A } as OpInput, ended())
  assert.equal(situation(r), 'awaiting-person')
  assert.equal(runStatus(r).text, 'Waiting · Your answer')
  r = operate(r, { op: 'question.answer', question: 'q1', text: 'The first.', from: 'iwaag' }, { at: new Date(t += 1000).toISOString(), by: 'iwaag', via: 'browser', graph: GRAPH })
  assert.equal(situation(r), 'due')
  assert.equal(runStatus(r).text, 'Continuing · Answer to q1 arrived')
  assert.equal(runStatus(r, { job: { state: 'queued' } }).text, 'Queued · Waiting for an execution slot')
  assert.equal(runStatus(r, { job: null }).state, 'stalled', 'host facts say nothing is queued: a missing continuation')
})

test('delegated work pending reads "Waiting · jevlab study result"; a child pause or interruption shows in it', () => {
  const r = run(began, ...finish('talk'), ...finish('render'), { op: 'node.start', node: 'survey', attempt: A } as OpInput, dispatch, bind, ended())
  assert.equal(r.control.hold, null)
  assert.equal(situation(r), 'awaiting-delegation')
  const st = runStatus(r)
  assert.equal(st.text, 'Waiting · jevlab study result')
  assert.deepEqual(st.waits.map(w => [w.kind, w.target, w.condition]), [['delegation', 'jevlab study', 'the child\'s question or result continues it']])
  assert.equal(runStatus(r, { children: { d1: { situation: 'interrupted', hold: 'interrupted' } } }).text, 'Waiting · jevlab study result (child interrupted)')
  // The relayed hold of the child, without reading it.
  const held = operate(r, { op: 'delegation.event', delegation: 'd1', event: { type: 'held', child: { seq: 9, at: 'x', by: 'autolab' }, text: 'stopped', hold: 'stopped' } } as never, { at: new Date(t += 1000).toISOString(), by: 'wfe', via: 'delegation', graph: GRAPH })
  assert.equal(runStatus(held).text, 'Waiting · jevlab study result (child paused by its person)')
})

test('an external result reads "Waiting · <its reason>"', () => {
  const r = run(began, ...finish('talk'), ...finish('survey'), { op: 'node.start', node: 'render', attempt: A } as OpInput, { op: 'node.wait', node: 'render', reason: 'ComfyUI render 42', holder: 'comfy', external: 'comfy:42', attempt: A } as OpInput, ended())
  assert.equal(situation(r), 'awaiting-external')
  assert.equal(runStatus(r).text, 'Waiting · ComfyUI render 42')
})

test('holds: paused with its recorded reason; interrupted with its cause in short; unknown; the sentence stays as detail', () => {
  const left = run(began, { op: 'node.start', node: 'talk', attempt: A } as OpInput, ended())
  const st = runStatus(left)
  assert.equal(st.text, 'Interrupted · Talk node left running at exit')
  assert.match(st.detail!, /talk recorded as running/)
  assert.equal(runStatus(left, { names: { talk: 'Talk' } }).text, 'Interrupted · Talk node left running at exit')
  const lost = run(began, { op: 'node.start', node: 'talk', attempt: A } as OpInput, ended({ outcome: 'unknown', detail: 'the process was gone when the execution host looked' }))
  assert.equal(runStatus(lost).text, 'Unknown · Process lost; outcome unconfirmed')
  const paused = run({ op: 'run.stop', reason: 'Circumstances changed; hold this experiment', by: 'iwaag' } as OpInput)
  assert.equal(runStatus(paused).text, 'Paused · Circumstances changed; hold this experiment')
  // A hold recorded before causes existed is read from its sentence.
  assert.equal(causeText(undefined, 'the executor exited with talk recorded as running'), 'Talk node left running at exit')
  assert.equal(causeText(undefined, 'the executor exited without taking up delegation event d1 completed #1'), 'Delegation fact not taken up')
})

test('a hold stays the status while a question is also pending: answering alone does not resume it', () => {
  const r = run(began, ...finish('survey'), ...finish('render'), { op: 'node.start', node: 'talk', attempt: A } as OpInput, { op: 'question.ask', question: 'q1', node: 'talk', text: 'Which?', to: 'iwaag', attempt: A } as OpInput, { op: 'run.stop', reason: 'not now', by: 'iwaag', attempt: A } as OpInput, ended())
  const st = runStatus(r)
  assert.equal(st.state, 'paused')
  assert.deepEqual(st.waits.map(w => w.text), ['Your answer'], 'the question is still listed')
})

test('several waits: a summary with each target accessible; completed and cancelled runs', () => {
  const r = run(began, { op: 'node.start', node: 'survey', attempt: A } as OpInput, dispatch, bind, { op: 'node.start', node: 'render', attempt: A } as OpInput, { op: 'node.wait', node: 'render', reason: 'ComfyUI render 42', holder: 'comfy', external: 'comfy:42', attempt: A } as OpInput, ...finish('talk'), ended())
  const st = runStatus(r)
  assert.equal(st.text, 'Waiting · jevlab study result (+1 more)')
  assert.deepEqual(st.waits.map(w => w.kind).sort(), ['delegation', 'external'])
  const done = run(began, ...finish('talk'), ...finish('survey'), ...finish('render'), ended())
  assert.equal(runStatus(done).text, 'Done · Every step completed')
  const cancelled = run({ op: 'run.cancel', reason: 'not needed', by: 'iwaag' } as OpInput)
  assert.equal(runStatus(cancelled).text, 'Cancelled · not needed')
})
