// workflow_editor p18 (docs/runs.md *Standing runs*): a conversation's
// conductor is one standing run for the conversation's life. Its last
// completed node leaves it at rest (`idle`), not completed; the room's
// transitions are its own records (suspended, closed — finalized while at
// rest —, reopened, facilitated again); a wake appends one ponder node for
// the words no attempt was briefed with; what a transition finds waiting is
// held until the person resumes it; ordinary runs complete as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dueReason, operate, replay, situation, standingEvents, standingHold, type OpInput, type RunGraph, type RunRecord } from '../shared/run.ts'
import { runStatus } from '../shared/status.ts'

const G: RunGraph = { nodes: { ponder: { type: 'do', activity: 'ponder' } }, edges: [] }
let t = Date.parse('2026-10-25T10:00:00Z')
const at = () => new Date(t += 1000).toISOString()
const op = (r: RunRecord | null, o: OpInput & { attempt?: string; receipt?: string }, by = 'ponderer-agent', via = 'cli', graph = G): RunRecord => operate(r, o, { at: at(), by, via, graph })
const create = (standing?: { conversation: string; replaces?: string }) => op(null, { op: 'run.create', project: 'ponderer', workflow: 'conduct', run: 'run-001', input: { kind: 'braindump', file: 'braindump.md', author: 'Pat' }, executor: { name: 'ponderer-agent', backend: null }, predecessor: null, definition: { root: 'conduct', workflows: {}, warnings: [] }, context: { repositories: [] }, nodes: ['ponder'], ...(standing ? { standing } : {}) }, 'wfe', 'cli')
// One turn: an attempt that ponders and ends.
function turn(r: RunRecord, a: string, node = 'ponder', graph = G): RunRecord {
  r = op(r, { op: 'attempt.begin', attempt: a, reason: 'turn' }, 'autolab', 'exec', graph)
  r = op(r, { op: 'node.start', node, attempt: a }, 'ponderer-agent', 'cli', graph)
  r = op(r, { op: 'node.complete', node, outcome: 'replied #2', attempt: a } as OpInput, 'ponderer-agent', 'cli', graph)
  return op(r, { op: 'attempt.end', attempt: a, outcome: 'exited', waits: 'defer-ready', explain: 'cause' } as OpInput, 'autolab', 'exec', graph)
}
// The revision a wake records: the graph with one new ponder node after `after`.
function wake(r: RunRecord, node: string, events: string[], after = 'ponder'): { r: RunRecord; graph: RunGraph } {
  const prev = r.definition.revisions?.at(-1)?.effective ?? r.definition.effective ?? { nodes: G.nodes, edges: G.edges }
  const graph: RunGraph = { nodes: { ...prev.nodes, [node]: { type: 'do', activity: 'ponder' } }, edges: [...prev.edges, { from: after, to: node }] }
  const n = (r.definition.revisions?.length ?? 0) + 2
  const prevGraph: RunGraph = { nodes: prev.nodes, edges: prev.edges }
  r = op(r, { op: 'run.adjust', revision: `r${n}`, parent: r.definition.active ?? 'r1', file: `definition/r${n}/conduct.yaml`, sha256: 'a'.repeat(64), definitionDigest: `sha256:${'b'.repeat(64)}`, effective: { compiler: 'ag.wfe-compile.v5', ...graph } as never, reason: `woken for ${events.join(', ')}`, source: { kind: 'wake', events } } as OpInput, 'conversation', 'conversation', prevGraph)
  return { r, graph }
}

test('an ordinary run completes with its last node; a standing one rests idle, holds no attempt and reads as idle, not stalled or done', () => {
  const plain = turn(create(), 'atest-000001')
  assert.equal(plain.execution.state, 'completed')
  assert.equal(plain.standing, undefined)
  const r = turn(create({ conversation: 'room-a' }), 'atest-000001')
  assert.equal(r.execution.state, 'idle')
  assert.equal(r.ended, null)
  assert.equal(r.control.attempt, null)
  assert.equal(r.control.hold, null, 'an exit with all work done is a normal end')
  assert.equal(situation(r), 'awaiting-input')
  assert.equal(dueReason(r), null)
  const st = runStatus(r)
  assert.equal(st.state, 'listening')
  assert.equal(st.text, 'Idle · Ready for the conversation\'s next message')
  assert.deepEqual(r.standing, { role: 'conductor', conversation: 'room-a', state: 'open', since: r.history[0].at, seq: 1, by: 'wfe', reason: 'created as the conversation\'s conductor', wakes: [], held: [] })
  assert.deepEqual(r.history[0].change, { execution: [null, 'not-started'], standing: [null, 'open'] })
  assert.deepEqual(replay(r.history, G).state, (({ history: _, ...x }) => x)(r), 'replays to the same state')
})

test('an instruction to the resting run is due until a wake gives it a node; the attempt that begins is briefed with it and, once ended, it wakes nothing again', () => {
  let r = turn(create({ conversation: 'room-a' }), 'atest-000001')
  r = op(r, { op: 'instruction.receive', text: 'And the second topic?', from: 'Pat', receipt: 'conversation:room-a:request:2' } as OpInput, 'Pat', 'conversation')
  assert.deepEqual(standingEvents(r), ['i1'])
  assert.equal(situation(r), 'due')
  assert.equal(dueReason(r), 'instruction i1 arrived')
  const w = wake(r, 'ponder-w1', ['i1'])
  r = w.r
  assert.equal(r.execution.state, 'in-progress')
  assert.deepEqual(r.execution.ready, ['ponder-w1'])
  assert.deepEqual(r.standing!.wakes, [{ n: 1, node: 'ponder-w1', seq: r.seq, at: r.updated, by: 'conversation', events: ['i1'] }])
  assert.deepEqual(r.nodes.ponder.state, 'completed', 'the earlier turn and its evidence stay')
  r = op(r, { op: 'attempt.begin', attempt: 'atest-000002', reason: 'wake' }, 'autolab', 'exec', w.graph)
  assert.deepEqual(r.instructions!.i1.seen, { attempt: 'atest-000002', seq: r.seq })
  assert.deepEqual(standingEvents(r), [], 'briefed: not an event to wake for')
  // A message while the attempt works is not seen by it.
  r = op(r, { op: 'instruction.receive', text: 'One more thing.', from: 'Pat' } as OpInput, 'Pat', 'conversation', w.graph)
  r = op(r, { op: 'node.start', node: 'ponder-w1', attempt: 'atest-000002' }, 'ponderer-agent', 'cli', w.graph)
  r = op(r, { op: 'node.complete', node: 'ponder-w1', outcome: 'answered #4', attempt: 'atest-000002' } as OpInput, 'ponderer-agent', 'cli', w.graph)
  r = op(r, { op: 'attempt.end', attempt: 'atest-000002', outcome: 'exited', waits: 'defer-ready', explain: 'cause' } as OpInput, 'autolab', 'exec', w.graph)
  assert.equal(r.execution.state, 'idle')
  assert.equal(r.control.hold, null)
  assert.deepEqual(standingEvents(r), ['i2'], 'the word that arrived during the attempt still wakes it')
  assert.throws(() => wake(r, 'ponder-w2', ['i1'], 'ponder-w1'), /standing-event|not an event/)
  const w2 = wake(r, 'ponder-w2', ['i2'], 'ponder-w1')
  assert.equal(w2.r.standing!.wakes.length, 2)
  assert.deepEqual(replay(w2.r.history, G).state.standing, w2.r.standing)
})

test('a wake is refused while something is ready or running, and on a run that does not stand', () => {
  let r = create({ conversation: 'room-a' })
  r = op(r, { op: 'instruction.receive', text: 'x', from: 'Pat' } as OpInput, 'Pat', 'conversation')
  assert.throws(() => wake(r, 'ponder-w1', ['i1']), /standing-busy|is ready/)
  let plain = turn(create(), 'atest-000001')
  plain = op(plain, { op: 'instruction.receive', text: 'x', from: 'Pat' } as OpInput, 'Pat', 'conversation')
  assert.throws(() => wake(plain, 'ponder-w1', ['i1']), /only a standing run/)
})

test('facilitation ended: the resting conductor is suspended, its words wake nothing; facilitation again reopens it for them', () => {
  let r = turn(create({ conversation: 'room-a' }), 'atest-000001')
  r = op(r, { op: 'standing.suspend', reason: 'Pat ended facilitation' }, 'conversation', 'conversation')
  assert.equal(r.standing!.state, 'suspended')
  assert.equal(r.execution.state, 'idle')
  assert.equal(situation(r), 'suspended')
  assert.equal(runStatus(r).text, 'Suspended · Facilitation ended; nothing unsolicited comes to it')
  r = op(r, { op: 'instruction.receive', text: 'late', from: 'Pat' } as OpInput, 'Pat', 'conversation')
  assert.equal(dueReason(r), null, 'nothing is owed while it is suspended')
  assert.equal(situation(r), 'suspended', 'not due: WFE wakes a suspended conductor only on the person\'s resume (server/standing.ts)')
  assert.throws(() => op(r, { op: 'standing.suspend', reason: 'again' }, 'conversation', 'conversation'), /standing-state|stands suspended/)
  r = op(r, { op: 'standing.facilitate', reason: 'Pat asked ponderer to lead again' }, 'conversation', 'conversation')
  assert.equal(r.standing!.state, 'open')
  assert.equal(dueReason(r), 'instruction i1 arrived')
})

test('a room closed at rest finalizes the run (completed, ended); reopening reuses it, holding what waited; release lets it continue', () => {
  let r = turn(create({ conversation: 'room-a' }), 'atest-000001')
  r = op(r, { op: 'standing.close', reason: 'Pat closed the room' }, 'conversation', 'conversation')
  assert.equal(r.execution.state, 'completed')
  assert.ok(r.ended)
  assert.equal(situation(r), 'completed')
  assert.equal(runStatus(r).text, 'Closed · Conversation closed; reopening continues this run')
  assert.ok(standingHold(r))
  // A word recorded directly while closed (not through the room, which reopens first).
  r = op(r, { op: 'instruction.receive', text: 'while closed', from: 'someone' } as OpInput, 'someone', 'cli')
  assert.throws(() => wake(r, 'ponder-w1', ['i1']), /stands closed/)
  r = op(r, { op: 'standing.reopen', reason: 'Pat reopened the room', state: 'open' }, 'conversation', 'conversation')
  assert.equal(r.execution.state, 'idle')
  assert.equal(r.ended, null)
  assert.deepEqual(r.standing!.held, ['i1'])
  assert.deepEqual(standingEvents(r), [], 'held: reopening replays nothing')
  assert.equal(situation(r), 'awaiting-input')
  assert.match(runStatus(r).detail ?? '', /Held until the person resumes: i1/)
  r = op(r, { op: 'standing.release', reason: 'Pat resumed' }, 'Pat', 'browser')
  assert.deepEqual(r.standing!.held, [])
  assert.deepEqual(standingEvents(r), ['i1'])
  assert.throws(() => op(r, { op: 'standing.release', reason: 'again' }, 'Pat', 'browser'), /nothing is held/)
})

test('a room closed while work is open finalizes nothing: the run keeps waiting; a cancelled conductor records no transition', () => {
  const W: RunGraph = { nodes: { ponder: { type: 'do', activity: 'ponder' }, ask: { type: 'do', activity: 'ask' } }, edges: [{ from: 'ponder', to: 'ask' }] }
  let r = op(null, { op: 'run.create', project: 'ponderer', workflow: 'conduct', run: 'run-002', input: { kind: 'braindump', file: 'braindump.md', author: 'Pat' }, executor: { name: 'ponderer-agent', backend: null }, predecessor: null, definition: { root: 'conduct', workflows: {}, warnings: [] }, context: { repositories: [] }, nodes: ['ask', 'ponder'], standing: { conversation: 'room-b' } }, 'wfe', 'cli', W)
  r = op(r, { op: 'attempt.begin', attempt: 'atest-000001', reason: 'turn' }, 'autolab', 'exec', W)
  for (const [o, n] of [['node.start', 'ponder'], ['node.complete', 'ponder'], ['node.start', 'ask']] as const) r = op(r, { op: o, node: n, outcome: 'x', attempt: 'atest-000001' } as OpInput, 'ponderer-agent', 'cli', W)
  r = op(r, { op: 'node.wait', node: 'ask', reason: 'asked forge', holder: 'forge', external: 'discussion:room-b:activity:1', attempt: 'atest-000001' } as OpInput, 'ponderer-agent', 'cli', W)
  r = op(r, { op: 'attempt.end', attempt: 'atest-000001', outcome: 'exited', waits: 'defer-ready', explain: 'cause' } as OpInput, 'autolab', 'exec', W)
  r = op(r, { op: 'standing.close', reason: 'closed' }, 'conversation', 'conversation', W)
  assert.equal(r.execution.state, 'in-progress', 'the open ask is not asserted done')
  assert.equal(situation(r), 'awaiting-external')
  r = op(r, { op: 'run.cancel', reason: 'Pat cancelled it' }, 'Pat', 'browser', W)
  assert.throws(() => op(r, { op: 'standing.reopen', reason: 'x', state: 'open' }, 'conversation', 'conversation', W), /cancelled/)
})

test('establishing an existing run (the p18 transition) turns a completed conductor idle and holds what it had left, so nothing starts by itself', () => {
  let r = turn(create(), 'atest-000001')
  r = op(r, { op: 'instruction.receive', text: 'old words', from: 'Pat' } as OpInput, 'Pat', 'conversation')
  assert.equal(r.execution.state, 'completed')
  r = op(r, { op: 'standing.establish', conversation: 'room-c', state: 'open', reason: 'p18 transition: the latest conductor continues the room' }, 'migration', 'migration')
  assert.equal(r.execution.state, 'idle')
  assert.deepEqual(r.history.at(-1)!.change, { execution: ['completed', 'idle'], standing: [null, 'open'] })
  assert.deepEqual(r.standing!.held, ['i1'])
  assert.deepEqual(standingEvents(r), [])
  assert.equal(situation(r), 'awaiting-input')
  assert.throws(() => op(r, { op: 'standing.establish', conversation: 'room-c', state: 'open', reason: 'again' }, 'migration', 'migration'), /already stands/)
  const closed = op(turn(create(), 'atest-000001'), { op: 'standing.establish', conversation: 'room-d', state: 'closed', reason: 'p18 transition of a closed room' }, 'migration', 'migration')
  assert.equal(closed.execution.state, 'completed', 'a closed room stays finalized')
  assert.deepEqual(closed.history.at(-1)!.change, { standing: [null, 'closed'] })
})

test('a child\'s fact that arrives while the room is closed is not the executor\'s move; reopening holds it (no missed event at the next attempt\'s end); release makes it due', () => {
  const D: RunGraph = { nodes: { asset: { type: 'delegate', project: 'kid', workflow: 'make' } }, edges: [] }
  const H = '0'.repeat(64)
  let r = op(null, { op: 'run.create', project: 'ponderer', workflow: 'conduct', run: 'run-003', input: { kind: 'braindump', file: 'braindump.md', author: 'Pat' }, executor: { name: 'ponderer-agent', backend: null, host: 'autolab' }, predecessor: null, definition: { root: 'conduct', workflows: {}, warnings: [] }, context: { repositories: [] }, nodes: ['asset'], standing: { conversation: 'room-e' } }, 'wfe', 'cli', D)
  const o = (x: OpInput & { attempt?: string }, by = 'ponderer-agent') => { r = op(r, x, by, 'cli', D) }
  o({ op: 'attempt.begin', attempt: 'atest-000001', reason: 'turn' }, 'autolab')
  o({ op: 'node.start', node: 'asset', attempt: 'atest-000001' })
  o({ op: 'delegation.dispatch', delegation: 'd1', uid: 'ponderer/conduct/run-003#0123456789abcdef/d1', node: 'asset', target: { project: 'kid', workflow: 'make', workspace: 'kid' }, request: { path: 'devdocs/runs/conduct/run-003/delegations/d1/request.md', sha256: H, bytes: 10 }, attempt: 'atest-000001' } as never)
  o({ op: 'attempt.end', attempt: 'atest-000001', outcome: 'exited', waits: 'defer-ready', explain: 'cause' } as OpInput, 'autolab')
  o({ op: 'delegation.bind', delegation: 'd1', child: { uid: 'kid/make/run-001#fedcba9876543210', workspace: 'kid', project: 'kid', workflow: 'make', run: 'run-001', created: at() }, transport: { realm: 'z', message: 5, stream: 7, topic: 'request-x' } } as never, 'wfe')
  o({ op: 'standing.close', reason: 'Pat closed the room' }, 'conversation')
  o({ op: 'delegation.event', delegation: 'd1', event: { child: { seq: 3, at: at(), by: 'kid-agent' }, text: 'done', type: 'completed' } } as never, 'wfe')
  assert.equal(dueReason(r), null, 'closed: the child\'s result continues nothing')
  assert.equal(situation(r), 'awaiting-delegation')
  o({ op: 'standing.reopen', reason: 'reopened', state: 'open' }, 'conversation')
  assert.deepEqual(r.standing!.held, ['d1#1'])
  assert.equal(dueReason(r), null, 'held across the reopening')
  // An attempt the room's next words start, ending without taking it up, is not interrupted for it.
  o({ op: 'instruction.receive', text: 'new words', from: 'Pat' } as OpInput, 'Pat')
  o({ op: 'attempt.begin', attempt: 'atest-000002', reason: 'wake' }, 'autolab')
  o({ op: 'attempt.end', attempt: 'atest-000002', outcome: 'exited', waits: 'defer-ready', explain: 'cause' } as OpInput, 'autolab')
  assert.equal(r.control.hold, null)
  o({ op: 'standing.release', reason: 'Pat resumed' }, 'Pat')
  assert.match(dueReason(r) ?? '', /result from kid make arrived/)
})

test('a human review on the standing conductor: work complete, awaiting review; a new topic wakes a ponder beside it; approval and cleanup bring the run to rest, not completion', () => {
  const R: RunGraph = { nodes: { ponder: { type: 'do', activity: 'ponder' }, review: { type: 'review' } }, edges: [{ from: 'ponder', to: 'review' }] }
  const SUBJECT = { workspace: 'misc', project: 'misc', workflow: 'freework', run: 'run-007', creation: '2026-10-24T09:00:00.000Z', presentation: 'p1', revision: `sha256:${'a'.repeat(64)}`, title: 'Torus figure', delegation: 'd1' }
  let r = op(null, { op: 'run.create', project: 'ponderer', workflow: 'conduct', run: 'run-004', input: { kind: 'braindump', file: 'braindump.md', author: 'Pat' }, executor: { name: 'ponderer-agent', backend: null }, predecessor: null, definition: { root: 'conduct', workflows: {}, warnings: [], effective: { compiler: 'c', ...R } as never }, context: { repositories: [] }, nodes: ['ponder', 'review'], standing: { conversation: 'room-r' } }, 'wfe', 'cli', R)
  let g = R
  const o = (x: OpInput & { attempt?: string }, by = 'ponderer-agent', via = 'cli') => { r = op(r, x, by, via, g) }
  o({ op: 'attempt.begin', attempt: 'atest-000001', reason: 'turn' }, 'autolab')
  o({ op: 'node.start', node: 'ponder', attempt: 'atest-000001' }); o({ op: 'node.complete', node: 'ponder', outcome: 'judged misc\'s figure', attempt: 'atest-000001' } as OpInput)
  o({ op: 'review.prepare', review: 'rv1', uid: 'ponderer/conduct/run-004#abc/rv1', node: 'review', summary: 'トーラスの図です。陰影を確認してください。', subjects: [SUBJECT], attempt: 'atest-000001' } as OpInput)
  o({ op: 'attempt.end', attempt: 'atest-000001', outcome: 'exited', waits: 'defer-ready', explain: 'cause' } as OpInput, 'autolab')
  assert.deepEqual([r.execution.state, situation(r), runStatus(r).text], ['in-progress', 'awaiting-review', 'Work complete · Awaiting human review'])
  // A new topic while the review waits: woken beside it, not behind it.
  o({ op: 'instruction.receive', text: 'Unrelated: what about sound?', from: 'Pat' } as OpInput, 'Pat', 'conversation')
  assert.equal(situation(r), 'due')
  const w = wake(r, 'ponder-w1', ['i1'])
  r = w.r; g = w.graph
  assert.deepEqual(r.execution.ready, ['ponder-w1'])
  assert.equal(r.nodes.review.state, 'waiting', 'the review still waits for the person')
  o({ op: 'attempt.begin', attempt: 'atest-000002', reason: 'wake' }, 'autolab')
  o({ op: 'node.start', node: 'ponder-w1', attempt: 'atest-000002' }); o({ op: 'node.complete', node: 'ponder-w1', outcome: 'answered about sound', attempt: 'atest-000002' } as OpInput)
  o({ op: 'attempt.end', attempt: 'atest-000002', outcome: 'exited', waits: 'defer-ready', explain: 'cause' } as OpInput, 'autolab')
  assert.deepEqual([situation(r), r.control.hold], ['awaiting-review', null])
  // The person's review: start, serve, approve, cleanup — then the run rests.
  o({ op: 'review.start', review: 'rv1' }, 'Pat', 'browser')
  o({ op: 'review.serve', review: 'rv1', start: 1, subjects: [{ subject: 1, status: 'available', instance: 'pi-test-0001', mode: 'started', detail: 'served' }] } as OpInput, 'wfe', 'review')
  o({ op: 'review.decide', review: 'rv1', outcome: 'approved', revisions: [SUBJECT.revision] } as OpInput, 'Pat', 'browser')
  o({ op: 'review.cleanup', review: 'rv1', results: [{ subject: 1, instance: 'pi-test-0001', status: 'stopped', detail: 'verified gone' }], release: true } as OpInput, 'wfe', 'review')
  assert.equal(r.nodes.review.state, 'completed')
  assert.deepEqual([r.execution.state, situation(r)], ['idle', 'awaiting-input'], 'the conductor returns to rest')
  assert.deepEqual(r.reviews!.rv1.release!.unlocked, [], 'nothing was waiting on the review')
})
