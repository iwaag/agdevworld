// workflow_editor p17 step 1: the Human review node and its durable round.
// The agent prepares the round after its own review and its work is done;
// the run reads "Work complete · Awaiting human review" and no process
// waits. Start review, the host's result, the person's decision and cleanup
// are separate records; requested changes close the round, keep the run
// open and are addressed by appended work. (Why: in fix6 trial A ponderer
// accepted misc/freework/run-007 itself and the page was stopped before the
// person saw it.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compile, FINAL_STEP, reportStep } from '../shared/compile.ts'
import { checkRecord, notableEvents, operate, replay, situation, type OpInput, type RunGraph, type RunRecord } from '../shared/run.ts'
import { runStatus } from '../shared/status.ts'
import { openContinuations } from '../shared/humanReview.ts'

const node = (type: string, extra: Record<string, unknown> = {}) => ({ type, name: '', description: 'x', repositories: [], ...extra })

test('compile v5: a review node gets no report and does not hold the final report; graphs without one are unchanged', () => {
  const g = compile({ nodes: { work: node('do'), review: node('review') }, edges: [{ from: 'work', to: 'review' }], documentation: { policy: 'default' } })
  assert.ok(g.ok)
  if (!g.ok) return
  assert.ok(!(reportStep('review') in g.graph.nodes), 'no report step for a human review')
  assert.deepEqual(g.graph.edges.filter(e => e.to === FINAL_STEP), [{ from: reportStep('work'), to: FINAL_STEP }], 'the final report follows the work, not the review')
  assert.ok(g.graph.edges.some(e => e.from === reportStep('work') && e.to === 'review'))
  // After requested changes: work → review → fix → review-2; the final report follows both work ends.
  const g2 = compile({ nodes: { work: node('do'), review: node('review'), fix: node('do'), 'review-2': node('review') }, edges: [{ from: 'work', to: 'review' }, { from: 'review', to: 'fix' }, { from: 'fix', to: 'review-2' }], documentation: { policy: 'custom', plan: false, reports: false, final: true } })
  assert.ok(g2.ok)
  if (g2.ok) assert.deepEqual(g2.graph.edges.filter(e => e.to === FINAL_STEP).map(e => e.from).sort(), ['fix', 'work'])
  const plain = compile({ nodes: { a: node('do'), b: node('do') }, edges: [{ from: 'a', to: 'b' }], documentation: { policy: 'default' } })
  assert.ok(plain.ok)
  if (plain.ok) assert.deepEqual(plain.graph.edges.filter(e => e.to === FINAL_STEP), [{ from: reportStep('b'), to: FINAL_STEP }])
})

// A conductor-like run: its delegate node is done, the final report is done,
// and the review node waits for the person.
let GRAPH: RunGraph = { nodes: { work: { type: 'do' }, review: { type: 'review' }, _final: { type: 'report', step: { kind: 'final-report', for: null, output: 'report.md', purpose: 'p', instructions: 'i' } } }, edges: [{ from: 'work', to: 'review' }, { from: 'work', to: '_final' }] }
let t = Date.parse('2026-10-24T10:00:00Z')
const A = 'atest-000001', B = 'atest-000002'
const SUBJECT = { workspace: 'misc', project: 'misc', workflow: 'freework', run: 'run-007', creation: '2026-10-24T09:00:00.000Z', presentation: 'p1', revision: `sha256:${'a'.repeat(64)}`, title: 'Torus figure', delegation: 'd1' }
function at() { return new Date(t += 1000).toISOString() }
function op(r: RunRecord | null, o: OpInput & { attempt?: string; operator?: { run: string; attempt: string } }, by = 'ponderer-agent', via = 'cli', graph = GRAPH): RunRecord {
  return operate(r, o, { at: at(), by, via, graph })
}
function prepared(): RunRecord {
  let r = op(null, { op: 'run.create', project: 'ponderer', workflow: 'conduct', run: 'run-040', input: { kind: 'request', file: 'request.md', requester: 'front-agent', onBehalfOf: 'iwaag' }, executor: { name: 'ponderer-agent', backend: null }, predecessor: null, definition: { root: 'conduct', workflows: {}, warnings: [] }, context: { repositories: [] }, nodes: Object.keys(GRAPH.nodes) }, 'wfe')
  r = op(r, { op: 'attempt.begin', attempt: A, reason: 'start' }, 'autolab')
  for (const n of ['work', '_final']) { r = op(r, { op: 'node.start', node: n, attempt: A }); r = op(r, { op: 'node.complete', node: n, outcome: 'done', attempt: A } as OpInput) }
  r = op(r, { op: 'review.prepare', review: 'rv1', uid: 'ponderer/conduct/run-040#abc/rv1', node: 'review', summary: 'A torus figure by misc; check the shading.', subjects: [SUBJECT], attempt: A } as OpInput)
  return op(r, { op: 'attempt.end', attempt: A, outcome: 'exited', waits: 'defer-ready', explain: 'cause' } as OpInput, 'autolab')
}

test('prepared: the agent\'s work is complete, the run is not; no hold, no executor move, the person holds it', () => {
  const r = prepared()
  assert.equal(r.control.hold, null, 'a review wait is a normal end of the attempt')
  assert.equal(r.execution.state, 'in-progress')
  assert.equal(situation(r), 'awaiting-review')
  assert.equal(runStatus(r).text, 'Work complete · Awaiting human review')
  assert.equal(r.reviews!.rv1.reviewer, 'iwaag')
  assert.equal(r.reviews!.rv1.state, 'awaiting')
  const ev = notableEvents(r)
  assert.ok(ev.some(e => e.type === 'review-ready' && e.review === 'rv1'))
  assert.ok(!ev.some(e => e.type === 'completed'), 'the final report is not announced as the run\'s completion while the review is pending')
  assert.ok(checkRecord(JSON.parse(JSON.stringify(r)), GRAPH).ok)
})

test('a review is prepared only on a ready review node, once, with subjects', () => {
  let r = op(null, { op: 'run.create', project: 'ponderer', workflow: 'conduct', run: 'run-041', input: { kind: 'braindump', file: 'braindump.md', author: 'iwaag' }, executor: { name: 'ponderer-agent', backend: null }, predecessor: null, definition: { root: 'conduct', workflows: {}, warnings: [] }, context: { repositories: [] }, nodes: Object.keys(GRAPH.nodes) }, 'wfe')
  r = op(r, { op: 'attempt.begin', attempt: A, reason: 'start' }, 'autolab')
  assert.throws(() => op(r, { op: 'review.prepare', review: 'rv1', uid: 'ponderer/conduct/run-041#abc/rv1', node: 'review', summary: 's', subjects: [SUBJECT], attempt: A } as OpInput), /not ready: work/)
  assert.throws(() => op(r, { op: 'review.prepare', review: 'rv1', uid: 'ponderer/conduct/run-041#abc/rv1', node: 'work', summary: 's', subjects: [SUBJECT], attempt: A } as OpInput), /review node/)
  r = op(r, { op: 'node.start', node: 'work', attempt: A }); r = op(r, { op: 'node.complete', node: 'work', outcome: 'done', attempt: A } as OpInput)
  assert.throws(() => op(r, { op: 'review.prepare', review: 'rv1', uid: 'ponderer/conduct/run-041#abc/rv1', node: 'review', summary: 's', subjects: [], attempt: A } as OpInput), /at least one presentation/)
  assert.throws(() => op(r, { op: 'review.prepare', review: 'rv1', uid: 'ponderer/conduct/run-041#abc/rv1', node: 'review', summary: 's', subjects: [SUBJECT] } as OpInput), /attempt-required|carry its id/, 'the agent\'s own operation, fenced by its attempt')
})

test('one Start review; the host\'s result; approval only when every subject is available; cleanup completes the node and the run', () => {
  let r = prepared()
  r = op(r, { op: 'review.start', review: 'rv1' }, 'iwaag', 'browser')
  assert.throws(() => op(r, { op: 'review.start', review: 'rv1' }, 'iwaag', 'browser'), /starting already/, 'a double click records nothing twice')
  assert.throws(() => op(r, { op: 'review.decide', review: 'rv1', outcome: 'approved' } as OpInput, 'iwaag', 'browser'), /every subject is available/, 'a click on Start review is not an approval')
  r = op(r, { op: 'review.serve', review: 'rv1', start: 1, subjects: [{ subject: 1, status: 'failed', instance: null, mode: null, detail: 'the bundle is missing' }] } as OpInput, 'wfe', 'review')
  assert.equal(r.reviews!.rv1.state, 'start-failed')
  assert.throws(() => op(r, { op: 'review.decide', review: 'rv1', outcome: 'approved' } as OpInput, 'iwaag', 'browser'), /did not start: the bundle is missing/, 'an unavailable subject is never silently left out of an approval')
  r = op(r, { op: 'review.start', review: 'rv1' }, 'iwaag', 'browser')
  assert.throws(() => op(r, { op: 'review.serve', review: 'rv1', start: 1, subjects: [] } as OpInput, 'wfe', 'review'), /latest start/)
  r = op(r, { op: 'review.serve', review: 'rv1', start: 2, subjects: [{ subject: 1, status: 'available', instance: 'pi-test-0001', mode: 'started', detail: 'served' }] } as OpInput, 'wfe', 'review')
  assert.equal(r.reviews!.rv1.state, 'reviewing')
  assert.throws(() => op(r, { op: 'review.decide', review: 'rv1', outcome: 'approved', attempt: B } as OpInput), /agent's own review/, 'an agent (even a stale one) never records the person\'s decision')
  assert.throws(() => op(r, { op: 'review.decide', review: 'rv1', outcome: 'approved', revisions: [`sha256:${'b'.repeat(64)}`] } as OpInput, 'iwaag', 'browser'), /other material/)
  r = op(r, { op: 'review.decide', review: 'rv1', outcome: 'approved', revisions: [SUBJECT.revision] } as OpInput, 'iwaag', 'browser')
  assert.equal(r.reviews!.rv1.state, 'approved')
  assert.equal(r.execution.state, 'in-progress', 'approved, cleanup pending: not complete yet')
  assert.equal(runStatus(r).text, 'Work complete · Approved · cleanup pending')
  assert.throws(() => op(r, { op: 'review.decide', review: 'rv1', outcome: 'changes', feedback: 'x' } as OpInput, 'iwaag', 'browser'), /already decided/, 'an old browser cannot decide again')
  r = op(r, { op: 'review.cleanup', review: 'rv1', results: [{ subject: 1, instance: 'pi-test-0001', status: 'stop-failed', detail: 'port still answers' }] } as OpInput, 'wfe', 'review')
  assert.equal(r.reviews!.rv1.state, 'approved')
  assert.equal(r.reviews!.rv1.cleanup!.state, 'failed')
  assert.equal(r.reviews!.rv1.decision!.by, 'iwaag', 'a failed cleanup does not touch the decision')
  r = op(r, { op: 'review.cleanup', review: 'rv1', results: [{ subject: 1, instance: 'pi-test-0001', status: 'stopped', detail: 'verified gone' }] } as OpInput, 'wfe', 'review')
  assert.equal(r.reviews!.rv1.state, 'complete')
  assert.equal(r.nodes.review.state, 'completed')
  assert.equal(r.execution.state, 'completed')
  const ev = notableEvents(r)
  assert.ok(ev.some(e => e.type === 'reviewed' && e.outcome === 'approved'))
  assert.ok(ev.some(e => e.type === 'review-cleanup-failed'))
  assert.equal(ev.filter(e => e.type === 'completed').length, 1, 'completed once, when the review completed')
  assert.ok(checkRecord(JSON.parse(JSON.stringify(r)), GRAPH).ok)
})

test('an agent\'s own assessment is not the person\'s review; relayed words are, attributed', () => {
  let r = prepared()
  r = op(r, { op: 'review.start', review: 'rv1' }, 'iwaag', 'browser')
  r = op(r, { op: 'review.serve', review: 'rv1', start: 1, subjects: [{ subject: 1, status: 'available', instance: 'pi-test-0001', mode: 'started', detail: 'served' }] } as OpInput, 'wfe', 'review')
  r = op(r, { op: 'attempt.begin', attempt: B, reason: 'instruction' }, 'autolab')
  assert.throws(() => op(r, { op: 'review.decide', review: 'rv1', outcome: 'approved', attempt: B } as OpInput), /an agent's own review is not the person's/)
  r = op(r, { op: 'instruction.receive', text: '見ました。OKです。', from: 'iwaag' } as OpInput, 'iwaag', 'conversation')
  r = op(r, { op: 'review.decide', review: 'rv1', outcome: 'approved', attempt: B, because: { kind: 'instruction', instruction: 'i1' } } as OpInput)
  assert.equal(r.reviews!.rv1.decision!.by, 'iwaag')
  assert.equal(r.reviews!.rv1.decision!.relayed!.by, 'ponderer-agent')
})

test('requested changes close the round, keep the run open, continue the agent and are addressed by appended work', () => {
  let r = prepared()
  r = op(r, { op: 'review.start', review: 'rv1' }, 'fix-check', 'cli')
  r = op(r, { op: 'review.serve', review: 'rv1', start: 1, subjects: [{ subject: 1, status: 'available', instance: 'pi-test-0001', mode: 'started', detail: 'served' }] } as OpInput, 'wfe', 'review')
  assert.throws(() => op(r, { op: 'review.decide', review: 'rv1', outcome: 'changes' } as OpInput, 'fix-check'), /feedback/)
  r = op(r, { op: 'review.decide', review: 'rv1', outcome: 'changes', feedback: 'Make the torus blue.', synthetic: true } as OpInput, 'fix-check')
  const v = r.reviews!.rv1
  assert.equal(v.state, 'changes-requested')
  assert.equal(v.decision!.synthetic, true)
  assert.equal(v.cleanup!.state, 'handed', 'the instance the review started is the responsible agent\'s now')
  assert.equal(v.cleanup!.owner, 'ponderer-agent')
  assert.equal(r.nodes.review.state, 'completed', 'the round is closed')
  assert.equal(r.execution.state, 'in-progress', 'closing the round does not complete the run')
  assert.equal(situation(r), 'due')
  assert.match(runStatus(r).text, /Changes requested in review rv1 by fix-check/)
  assert.ok(!notableEvents(r).some(e => e.type === 'completed'))
  // An attempt that ends without addressing it is held.
  r = op(r, { op: 'attempt.begin', attempt: B, reason: 'review rv1' }, 'autolab')
  r = op(r, { op: 'review.take-up', review: 'rv1', note: 'reading', attempt: B } as OpInput)
  const held = op(r, { op: 'attempt.end', attempt: B, outcome: 'exited', waits: 'defer-ready', explain: 'cause' } as OpInput, 'autolab')
  assert.equal(held.control.hold?.cause?.code, 'missed-review')
  // Appended work and a new review node address it.
  const g2: RunGraph = { nodes: { ...GRAPH.nodes, fix: { type: 'do' }, 'review-2': { type: 'review' } }, edges: [...GRAPH.edges, { from: 'review', to: 'fix' }, { from: 'fix', to: 'review-2' }] }
  r = op(r, { op: 'run.adjust', revision: 'r2', parent: 'r1', file: 'definition/r2/conduct.yaml', sha256: 'c'.repeat(64), definitionDigest: `sha256:${'d'.repeat(64)}`, effective: { compiler: 'ag.wfe-compile.v5', policy: 'manual', nodes: g2.nodes, edges: g2.edges }, reason: 'rv1 asked for a blue torus', source: { kind: 'agent' }, attempt: B } as OpInput)
  assert.equal(openContinuations(r).length, 0)
  assert.equal(r.reviews!.rv1.continuation!.addressed!.how, 'work')
  GRAPH = g2
  r = op(r, { op: 'node.start', node: 'fix', attempt: B }); r = op(r, { op: 'node.complete', node: 'fix', outcome: 'blue', attempt: B } as OpInput)
  r = op(r, { op: 'review.prepare', review: 'rv2', uid: 'ponderer/conduct/run-040#abc/rv2', node: 'review-2', summary: 'Blue now.', subjects: [{ ...SUBJECT, presentation: 'p2', revision: `sha256:${'e'.repeat(64)}` }], attempt: B } as OpInput)
  assert.equal(r.reviews!.rv2.previous, 'rv1')
  assert.throws(() => op(r, { op: 'review.decide', review: 'rv1', outcome: 'approved' } as OpInput, 'fix-check'), /already decided/, 'an old round is never approved again')
  assert.equal(replay(r.history, { nodes: { work: { type: 'do' }, review: { type: 'review' }, _final: GRAPH.nodes._final }, edges: [{ from: 'work', to: 'review' }, { from: 'work', to: '_final' }] }).state.reviews!.rv1.state, 'changes-requested', 'the rejected round stays in the record')
})

test('cancellation closes undecided rounds and leaves cleanup owned', () => {
  let r = prepared()
  r = op(r, { op: 'review.start', review: 'rv1' }, 'iwaag', 'browser')
  r = op(r, { op: 'review.serve', review: 'rv1', start: 1, subjects: [{ subject: 1, status: 'available', instance: 'pi-test-0001', mode: 'started', detail: 'served' }] } as OpInput, 'wfe', 'review')
  r = op(r, { op: 'run.cancel', reason: 'no longer needed' }, 'iwaag', 'browser')
  assert.equal(r.reviews!.rv1.state, 'cancelled')
  assert.equal(r.reviews!.rv1.cleanup!.state, 'pending')
  assert.throws(() => op(r, { op: 'review.decide', review: 'rv1', outcome: 'approved' } as OpInput, 'iwaag', 'browser'), /cancelled|run-cancelled/)
  r = op(r, { op: 'review.cleanup', review: 'rv1', results: [{ subject: 1, instance: 'pi-test-0001', status: 'stopped', detail: 'verified gone' }] } as OpInput, 'wfe', 'review')
  assert.equal(r.reviews!.rv1.cleanup!.state, 'done')
})
