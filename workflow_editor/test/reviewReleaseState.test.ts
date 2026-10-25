// workflow_editor p17 ex1: the record of work an approval made ready. The
// cleanup that completes an approved round names the review node's
// successors it made ready (`release`), with the attempt open then; the
// first attempt that begins afterwards owns them; an attempt open at the
// approval is not blamed for them at its end, but still for its own work.
// Entries written before p17 ex1 (no `release`) replay as they were decided.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { operate, replay, type OpInput, type RunGraph, type RunRecord } from '../shared/run.ts'
import { openReleases, owedRelease, reviewStateText, stillServing } from '../shared/humanReview.ts'

const GRAPH: RunGraph = { nodes: { work: { type: 'do' }, extra: { type: 'do' }, review: { type: 'review' }, cleanup: { type: 'do' } }, edges: [{ from: 'work', to: 'review' }, { from: 'work', to: 'extra' }, { from: 'review', to: 'cleanup' }] }
const FINAL: RunGraph = { nodes: { work: { type: 'do' }, review: { type: 'review' } }, edges: [{ from: 'work', to: 'review' }] }
let t = Date.parse('2026-10-25T10:00:00Z')
const A = 'atest-000001', B = 'atest-000002'
const SUBJECT = { workspace: 'kid', project: 'kid', workflow: 'make', run: 'run-013', creation: 'b5c81131044bf659', presentation: 'p1', revision: `sha256:${'c'.repeat(64)}`, title: 'Waterfall' }
const at = () => new Date(t += 1000).toISOString()
const op = (r: RunRecord | null, o: OpInput & { attempt?: string }, by = 'kid-agent', via = 'cli', graph = GRAPH): RunRecord => operate(r, o, { at: at(), by, via, graph })

// The child's own review prepared in attempt A on its reused page; `extra`
// is ready work of its own that A has not done.
function prepared(graph = GRAPH, end = true): RunRecord {
  let r = op(null, { op: 'run.create', project: 'kid', workflow: 'make', run: 'run-013', input: { kind: 'braindump', file: 'braindump.md', author: 'iwaag' }, executor: { name: 'kid-agent', backend: null }, predecessor: null, definition: { root: 'make', workflows: {}, warnings: [] }, context: { repositories: [] }, nodes: Object.keys(graph.nodes) }, 'wfe', 'cli', graph)
  r = op(r, { op: 'attempt.begin', attempt: A, reason: 'start' }, 'autolab', 'exec', graph)
  r = op(r, { op: 'node.start', node: 'work', attempt: A }, 'kid-agent', 'cli', graph)
  r = op(r, { op: 'node.complete', node: 'work', outcome: 'presented p1', attempt: A } as OpInput, 'kid-agent', 'cli', graph)
  r = op(r, { op: 'review.prepare', review: 'rv1', uid: 'kid/make/run-013#b5c81131044bf659/rv1', node: 'review', summary: 'Check the loop.', subjects: [SUBJECT], attempt: A } as OpInput, 'kid-agent', 'cli', graph)
  if (end && !graph.nodes.extra) r = op(r, { op: 'attempt.end', attempt: A, outcome: 'exited', waits: 'defer-ready', explain: 'cause' } as OpInput, 'autolab', 'exec', graph)
  r = op(r, { op: 'review.start', review: 'rv1' }, 'iwaag', 'browser', graph)
  r = op(r, { op: 'review.serve', review: 'rv1', start: 1, subjects: [{ subject: 1, status: 'available', instance: 'pi-test-0001', mode: 'reused', detail: 'already served' }] } as OpInput, 'wfe-review', 'review', graph)
  return op(r, { op: 'review.decide', review: 'rv1', outcome: 'approved', revisions: [SUBJECT.revision] } as OpInput, 'iwaag', 'browser', graph)
}
const stopped = (release = true) => ({ op: 'review.cleanup', review: 'rv1', results: [{ subject: 1, instance: 'pi-test-0001', status: 'stopped', detail: 'verified gone' }], ...(release ? { release: true } : {}) } as OpInput)

test('approval during an attempt: the unlocked successor is the next attempt\'s, the attempt\'s own ready work still holds it', () => {
  let r = prepared()
  r = op(r, stopped(), 'wfe-review', 'review')
  assert.deepEqual(r.reviews!.rv1.release, { seq: r.seq, at: r.updated, during: A, unlocked: ['cleanup'], continued: null })
  assert.deepEqual(openReleases(r).map(v => v.id), ['rv1'])
  r = op(r, { op: 'attempt.end', attempt: A, outcome: 'exited', waits: 'defer-ready', explain: 'cause' } as OpInput, 'autolab', 'exec')
  assert.equal(r.control.hold?.kind, 'interrupted', 'extra was A\'s and is left undone')
  assert.deepEqual(r.control.hold?.cause, { code: 'left-ready', nodes: ['extra'] }, 'cleanup arrived during A and is not counted against it')
  assert.ok(owedRelease(r.reviews!.rv1, r), 'still owed: a resume of the hold picks it up')
  r = op(r, { op: 'run.resume', reason: 'go on' }, 'iwaag', 'browser')
  r = op(r, { op: 'attempt.begin', attempt: B, reason: 'resume' }, 'autolab', 'exec')
  assert.deepEqual(r.reviews!.rv1.release!.continued, { attempt: B, seq: r.seq })
  assert.equal(openReleases(r).length, 0, 'consumed by the attempt that began after it')
  // B is subject to the ordinary rules for it.
  const left = op(r, { op: 'attempt.end', attempt: B, outcome: 'exited', waits: 'defer-ready', explain: 'cause' } as OpInput, 'autolab', 'exec')
  assert.deepEqual(left.control.hold?.cause, { code: 'left-ready', nodes: ['cleanup', 'extra'] })
})

test('entries written before p17 ex1 replay as decided: no release, the old left-ready', () => {
  let r = prepared()
  r = op(r, stopped(false), 'wfe-review', 'review')
  assert.equal(r.reviews!.rv1.release, undefined)
  r = op(r, { op: 'attempt.end', attempt: A, outcome: 'exited', waits: 'defer-ready', explain: 'cause' } as OpInput, 'autolab', 'exec')
  assert.deepEqual(r.control.hold?.cause, { code: 'left-ready', nodes: ['cleanup', 'extra'] })
  assert.deepEqual(replay(r.history, GRAPH).state.control, r.control, 'replays to the same state')
})

test('a stop that failed releases nothing; the verified retry does', () => {
  let r = prepared(FINAL)
  r = op(r, { op: 'review.cleanup', review: 'rv1', results: [{ subject: 1, instance: 'pi-test-0001', status: 'stop-failed', detail: 'port still answers' }], release: true } as OpInput, 'wfe-review', 'review', FINAL)
  assert.equal(r.reviews!.rv1.state, 'approved')
  assert.equal(r.reviews!.rv1.release, undefined)
  r = op(r, stopped(), 'wfe-review', 'review', FINAL)
  assert.equal(r.reviews!.rv1.state, 'complete')
  assert.deepEqual(r.reviews!.rv1.release!.unlocked, [], 'a final review makes nothing ready')
  assert.equal(r.execution.state, 'completed')
  assert.equal(openReleases(r).length, 0, 'no agent turn for a completed run')
})

test('requested changes release nothing; the next round\'s approval releases its own successors', () => {
  const G: RunGraph = { nodes: { work: { type: 'do' }, review: { type: 'review' }, fix: { type: 'do' }, 'review-2': { type: 'review' }, cleanup: { type: 'do' } }, edges: [{ from: 'work', to: 'review' }, { from: 'review', to: 'fix' }, { from: 'fix', to: 'review-2' }, { from: 'review-2', to: 'cleanup' }] }
  let r = op(null, { op: 'run.create', project: 'kid', workflow: 'make', run: 'run-014', input: { kind: 'braindump', file: 'braindump.md', author: 'iwaag' }, executor: { name: 'kid-agent', backend: null }, predecessor: null, definition: { root: 'make', workflows: {}, warnings: [] }, context: { repositories: [] }, nodes: Object.keys(G.nodes) }, 'wfe', 'cli', G)
  const o = (x: OpInput & { attempt?: string }, by = 'kid-agent', via = 'cli') => { r = op(r, x, by, via, G) }
  o({ op: 'attempt.begin', attempt: A, reason: 'start' }, 'autolab', 'exec')
  o({ op: 'node.start', node: 'work', attempt: A }); o({ op: 'node.complete', node: 'work', outcome: 'p1', attempt: A } as OpInput)
  o({ op: 'review.prepare', review: 'rv1', uid: 'kid/make/run-014#x/rv1', node: 'review', summary: 's', subjects: [SUBJECT], attempt: A } as OpInput)
  o({ op: 'attempt.end', attempt: A, outcome: 'exited', waits: 'defer-ready', explain: 'cause' } as OpInput, 'autolab', 'exec')
  o({ op: 'review.decide', review: 'rv1', outcome: 'changes', feedback: 'bluer' } as OpInput, 'iwaag', 'browser')
  assert.equal(r.reviews!.rv1.release, undefined)
  o({ op: 'attempt.begin', attempt: B, reason: 'review' }, 'autolab', 'exec')
  o({ op: 'node.start', node: 'fix', attempt: B }); o({ op: 'node.complete', node: 'fix', outcome: 'p2', attempt: B } as OpInput)
  o({ op: 'review.prepare', review: 'rv2', uid: 'kid/make/run-014#x/rv2', node: 'review-2', summary: 's', subjects: [SUBJECT], previous: 'rv1', attempt: B } as OpInput)
  o({ op: 'attempt.end', attempt: B, outcome: 'exited', waits: 'defer-ready', explain: 'cause' } as OpInput, 'autolab', 'exec')
  o({ op: 'review.start', review: 'rv2' }, 'iwaag', 'browser')
  o({ op: 'review.serve', review: 'rv2', start: 1, subjects: [{ subject: 1, status: 'available', instance: 'pi-test-0002', mode: 'started', detail: 'served' }] } as OpInput, 'wfe-review', 'review')
  o({ op: 'review.decide', review: 'rv2', outcome: 'approved' } as OpInput, 'iwaag', 'browser')
  o({ op: 'review.cleanup', review: 'rv2', results: [{ subject: 1, instance: 'pi-test-0002', status: 'stopped', detail: 'gone' }], release: true } as OpInput, 'wfe-review', 'review')
  assert.deepEqual(r.reviews!.rv2.release!.unlocked, ['cleanup'])
  assert.equal(r.reviews!.rv2.release!.during, null)
  assert.deepEqual(openReleases(r).map(v => v.id), ['rv2'])
})

test('a page left serving for a different run, or kept, is said so; complete does not read as stopped', () => {
  let r = prepared(FINAL)
  r = op(r, { op: 'review.cleanup', review: 'rv1', results: [{ subject: 1, instance: 'pi-test-0001', status: 'left', detail: 'serving for kid/make/run-099', owner: 'kid/make/run-099' }], release: true } as OpInput, 'wfe-review', 'review', FINAL)
  const v = r.reviews!.rv1
  assert.equal(v.state, 'complete')
  assert.deepEqual(stillServing(v).map(c => [c.status, c.owner]), [['left', 'kid/make/run-099']])
  assert.equal(reviewStateText(v), 'Approved · complete · a page still serving (for kid/make/run-099)')
})
