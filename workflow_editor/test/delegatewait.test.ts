// project_migration p8 ex1: a delegation's wait is the parent's record, not
// a live process. front/converse/run-027 adjusted its one-node run to add a
// delegate node beside its running talk node, dispatched, and ended with
// talk still running: the attempt was held interrupted twice although the
// wait itself was normal. These tests reproduce that shape, prove the
// corrected one (talk completes at the delegation, the result is handled by
// a node after the delegate node) ends normally and frees the slot, and that
// work genuinely left running still ends as an interruption.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adjustRun, runOp } from '../server/runs.ts'
import type { AdjustOptions } from '../server/runs.ts'
import { graphOfState, replay, type RunRef } from '../shared/run.ts'
import { as, claim, delegationSuite, dispatched, KID_WF, rec, restart, setup, type S } from './delegateFixture.ts'

delegationSuite('wfe-delegatewait-')

// Front's converse: one talk node; delegations are added by adjustment.
const CONVERSE = `schema: ag.workflow.v2
id: use
name: Converse
intent: |
  Serve one message of the person's conversation.
documentation: {policy: manual}
execution: {agent: par-agent}
repositories:
  root: {path: ., access: editable}
nodes:
  talk:
    type: talk
    description: Understand the message and make the next work concrete.
`
const SURVEY = `  survey:
    type: delegate
    description: Ask the kid project for it.
    project: kid
    workflow: make
    accepts: parent
`
const DELIVER = `  deliver:
    type: talk
    description: Tell the person what came back.
`

const adjust = (s: S, ref: RunRef, attempt: string, text: string, o: Partial<AdjustOptions> = {}) =>
  adjustRun(s.par, ref, { text, reason: 'the request is the kid project\'s work', source: { kind: 'agent' }, ...o }, { by: 'par-agent', via: 'cli', attempt })

async function talking(s: S) {
  const { ref } = await s.x.request({ workspace: 'par', workflow: 'use', text: 'Find me a blue icon.', author: 'Pat', receipt: 'person-request-1', via: 'browser' })
  const a = await claim(s)
  await as(s.par, ref, a.attempt.id, 'par-agent')({ op: 'node.start', node: 'talk' })
  return { ref, a }
}

test('run-027 reproduced: a talk node left running beside a dispatched delegation ends the attempt interrupted, with the node named', async () => {
  const s = await setup({ parent: CONVERSE })
  const { ref, a } = await talking(s)
  // As run-027 did: the delegate node beside talk, no edge, talk still running.
  const r = await adjust(s, ref, a.attempt.id, CONVERSE + SURVEY)
  assert.ok(r.ok, JSON.stringify(r.problems))
  const op = as(s.par, ref, a.attempt.id, 'par-agent')
  await op({ op: 'node.start', node: 'survey' })
  await s.x.delegate.dispatch(s.par, ref, 'survey', { request: 'A 64x64 blue icon.', attempt: a.attempt.id, by: 'par-agent', via: 'cli' })
  const f = await s.x.finished(a.attempt.id, { code: 0, signal: null })
  assert.equal(f.outcome, 'interrupted', 'an exit with talk still running is not a normal wait')
  const p = await rec(s.par, ref)
  assert.equal(p.control.hold?.kind, 'interrupted')
  assert.match(p.control.hold!.reason, /talk recorded as running/)
  assert.equal(p.nodes.survey.state, 'waiting', 'the wait itself was recorded')
  s.i.close(); s.n.close(); s.x.close()
})

test('the corrected shape: talk completes at the delegation, the result has a node after the delegate node; the parent ends normally, its slot serves the child, and the result continues it', async () => {
  const s = await setup({ parent: CONVERSE, kid: KID_WF })
  const { ref, a } = await talking(s)
  const r = await adjust(s, ref, a.attempt.id, CONVERSE + SURVEY + DELIVER + 'edges:\n  - {from: survey, to: deliver}\n',
    { completing: { node: 'talk', outcome: 'The icon is the kid project\'s work: delegated as survey; deliver tells the person what came back.' } })
  assert.ok(r.ok, JSON.stringify(r.problems))
  const op = as(s.par, ref, a.attempt.id, 'par-agent')
  await op({ op: 'node.start', node: 'survey' })
  await s.x.delegate.dispatch(s.par, ref, 'survey', { request: 'A 64x64 blue icon.', attempt: a.attempt.id, by: 'par-agent', via: 'cli' })
  const f = await s.x.finished(a.attempt.id, { code: 0, signal: null })
  assert.equal(f.outcome, 'exited', 'a recorded wait is a normal end')
  let p = await rec(s.par, ref)
  assert.equal(p.control.hold, null)
  assert.deepEqual([p.nodes.talk.state, p.nodes.survey.state, p.nodes.deliver.state], ['completed', 'waiting', 'pending'])
  assert.equal(s.x.queueView().slots.length, 0, 'no attempt of the parent holds a slot')
  // The child is created and runs in the slot the parent released.
  await s.zulip.cycle()
  const kidRef = { workflow: 'make', run: 'run-001' }
  const c = await claim(s)
  assert.deepEqual(c.ref, kidRef)
  const kid = as(s.kid, kidRef, c.attempt.id, 'kid-agent')
  for (const n of ['scope', 'build', 'confirm']) {
    await kid({ op: 'node.start', node: n })
    await kid({ op: 'node.complete', node: n, outcome: `${n} done.` })
  }
  await s.x.finished(c.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  // The result wakes the parent: one continuation; the new attempt takes it up.
  const p1 = await claim(s)
  assert.deepEqual(p1.ref, ref)
  p = await rec(s.par, ref)
  const done = p.delegations!.d1.events.filter(e => e.type === 'completed')
  assert.equal(done.length, 1)
  const op1 = as(s.par, ref, p1.attempt.id, 'par-agent')
  await op1({ op: 'delegation.take-up', delegation: 'd1', events: [done[0].n] } as never)
  await op1({ op: 'delegation.dispose', delegation: 'd1', disposition: 'satisfied', note: 'the icon came back' } as never)
  await op1({ op: 'node.complete', node: 'survey', outcome: 'The kid project made it.' })
  await op1({ op: 'node.start', node: 'deliver' })
  await op1({ op: 'node.complete', node: 'deliver', outcome: 'Told the person.' })
  assert.equal((await s.x.finished(p1.attempt.id, { code: 0, signal: null })).outcome, 'exited')
  p = await rec(s.par, ref)
  assert.equal(p.execution.state, 'completed')
  assert.equal(p.control.attempts, 2, 'two attempts: nothing waited inside a process')
  s.i.close(); s.n.close(); s.x.close()
})

// ---- step 2: lifecycle ----------------------------------------------------------------------

test('a child with documentation steps is told complete once, after its attempt ended — one wake, one continuation', async () => {
  const kidDocs = KID_WF.replace('documentation: {policy: manual}', 'documentation: {policy: custom, plan: false, reports: true, final: true}')
  const s = await setup({ kid: kidDocs })
  const { ref, a } = await dispatched(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const kidRef = { workflow: 'make', run: 'run-001' }
  const c = await claim(s)
  const kid = as(s.kid, kidRef, c.attempt.id, 'kid-agent')
  for (const n of ['scope', 'build', 'confirm']) { await kid({ op: 'node.start', node: n }); await kid({ op: 'node.complete', node: n, outcome: `${n} done.` }) }
  // The execution is complete now and reopens with every report step.
  await s.x.delegate.relay()
  assert.equal((await rec(s.par, ref)).delegations!.d1.events.length, 0, 'not told while the child\'s attempt still works')
  const child = await rec(s.kid, kidRef)
  for (const step of [...child.execution.ready]) { await kid({ op: 'node.start', node: step }); await kid({ op: 'node.complete', node: step, outcome: `${step} written.` }) }
  let steps = (await rec(s.kid, kidRef)).execution.ready
  for (const step of steps) { await kid({ op: 'node.start', node: step }); await kid({ op: 'node.complete', node: step, outcome: `${step} written.` }) }
  const kidRec = await rec(s.kid, kidRef)
  assert.equal(kidRec.execution.state, 'completed')
  assert.ok(kidRec.history.filter(h => h.change.execution?.[1] === 'completed').length > 1, 'the child completed its execution more than once in the attempt')
  await s.x.finished(c.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  await s.x.delegate.relay(); await s.x.reconcile()
  const p = await rec(s.par, ref)
  const done = p.delegations!.d1.events.filter(e => e.type === 'completed')
  assert.equal(done.length, 1, 'one result')
  const last = kidRec.history.filter(h => h.change.execution?.[1] === 'completed').at(-1)!
  assert.equal(done[0].child.seq, last.seq, 'under the entry that completed it last')
  assert.equal(s.x.db.prepare('SELECT count(*) AS n FROM jobs WHERE workflow = ? AND run = ? AND state = \'queued\'').get('use', 'run-001')!.n, 1)
  s.i.close(); s.n.close(); s.x.close()
})

test('holds keep a structured cause on new ends: left running, missed fact, process failure, lost process', async () => {
  const s = await setup({ parent: CONVERSE })
  const { ref, a } = await talking(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  let p = await rec(s.par, ref)
  assert.deepEqual(p.control.hold?.cause, { code: 'left-running', nodes: ['talk'] })
  await s.x.resume(s.par, ref, 'Pat', 'go on', 'browser')
  const b = await claim(s)
  await s.x.finished(b.attempt.id, { code: 1, signal: null })
  p = await rec(s.par, ref)
  assert.deepEqual(p.control.hold?.cause, { code: 'process', detail: 'process ended with exit code 1' })
  await s.x.resume(s.par, ref, 'Pat', 'go on', 'browser')
  const c = await claim(s)
  await s.x.finished(c.attempt.id, { code: null, signal: null, lost: true })
  p = await rec(s.par, ref)
  assert.equal(p.control.hold?.kind, 'unknown')
  assert.deepEqual(p.control.hold?.cause, { code: 'lost' })
  s.i.close(); s.n.close(); s.x.close()
})

test('a fact recorded before the attempt and not taken up is a missed event; one recorded during it continues the run after its end', async () => {
  const s = await setup()
  const { ref, a } = await dispatched(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const kidRef = { workflow: 'make', run: 'run-001' }
  const c = await claim(s)
  const kid = as(s.kid, kidRef, c.attempt.id, 'kid-agent')
  await kid({ op: 'node.start', node: 'scope' })
  await kid({ op: 'question.ask', question: 'q1', node: 'scope', text: 'Size?', to: 'par-agent' })
  await s.x.finished(c.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  // The parent is launched for q1 and ends without taking it up.
  const p1 = await claim(s)
  assert.deepEqual(p1.ref, ref)
  await s.x.finished(p1.attempt.id, { code: 0, signal: null })
  let p = await rec(s.par, ref)
  assert.equal(p.control.hold?.kind, 'interrupted')
  assert.deepEqual(p.control.hold?.cause, { code: 'missed-event', events: [{ delegation: 'd1', n: 1, type: 'question' }] })
  // Resumed: it answers; while it still runs the child asks again; it ends.
  await s.x.resume(s.par, ref, 'Pat', 'take it up', 'browser')
  const p2 = await claim(s)
  const par = as(s.par, ref, p2.attempt.id, 'par-agent')
  await par({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  await s.x.delegate.answer(s.par, ref, 'd1', 'q1', '64px.', { by: 'par-agent', via: 'cli', attempt: p2.attempt.id })
  // The child (no attempt of its own open: the one slot is the parent's)
  // records another question meanwhile; the relay tells the running parent.
  await runOp(s.kid, kidRef, { op: 'question.ask', question: 'q2', text: 'Colour?', to: 'par-agent' }, { by: 'kid-agent', via: 'cli' })
  await s.zulip.deliver(); await s.zulip.receive()
  p = await rec(s.par, ref)
  const q2 = p.delegations!.d1.events.find(e => e.question === 'q2')!
  assert.equal(q2.during, p2.attempt.id, 'recorded while the parent ran')
  assert.equal((await s.x.finished(p2.attempt.id, { code: 0, signal: null })).outcome, 'exited', 'not a missed fact: it arrived during the attempt')
  // Queued behind the child's own resumption (its answer to q1 came first).
  const jobs = s.x.db.prepare('SELECT * FROM jobs WHERE state = \'queued\' ORDER BY id').all() as { workflow: string; receipt: string }[]
  assert.deepEqual(jobs.map(j => j.workflow), ['make', 'use'])
  assert.match(jobs[1].receipt, /\/d1\/2$/, 'the parent\'s continuation for event 2, queued at its attempt\'s end')
  s.i.close(); s.n.close(); s.x.close()
})

const PAIR = `schema: ag.workflow.v2
id: use
name: Use two assets
intent: |
  Get two assets from the kid project and use them.
documentation: {policy: manual}
execution: {agent: par-agent}
repositories:
  root: {path: ., access: editable}
nodes:
  icon:
    type: delegate
    description: Ask for an icon.
    project: kid
    workflow: make
    accepts: parent
  sound:
    type: delegate
    description: Ask for a sound.
    project: kid
    workflow: make
    accepts: parent
  use:
    type: do
    description: Use both.
edges:
  - {from: icon, to: use}
  - {from: sound, to: use}
`

test('several children: one child\'s question wakes the parent while the other works; the other\'s failure is not hidden behind the healthy wait', async () => {
  const s = await setup({ parent: PAIR })
  const { ref } = await s.x.request({ workspace: 'par', workflow: 'use', text: 'An icon and a sound.', author: 'Pat', receipt: 'pair-request-1', via: 'browser' })
  const a = await claim(s)
  const op = as(s.par, ref, a.attempt.id, 'par-agent')
  for (const n of ['icon', 'sound']) {
    await op({ op: 'node.start', node: n })
    await s.x.delegate.dispatch(s.par, ref, n, { request: `A ${n}.`, attempt: a.attempt.id, by: 'par-agent', via: 'cli' })
  }
  assert.equal((await s.x.finished(a.attempt.id, { code: 0, signal: null })).outcome, 'exited', 'two recorded waits')
  await s.zulip.cycle()
  // Child 1 asks; child 2 has not run yet.
  const c1 = await claim(s)
  assert.equal(c1.ref.workflow, 'make')
  const k1 = as(s.kid, c1.ref, c1.attempt.id, 'kid-agent')
  await k1({ op: 'node.start', node: 'scope' })
  await k1({ op: 'question.ask', question: 'q1', node: 'scope', text: 'Size?', to: 'par-agent' })
  await s.x.finished(c1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  // The queue: child 2's start, then the parent's continuation for d1's question.
  let next = await claim(s)
  assert.equal(next.ref.workflow, 'make', 'child 2 starts first: it was queued before the question')
  const k2 = as(s.kid, next.ref, next.attempt.id, 'kid-agent')
  await k2({ op: 'node.start', node: 'scope' })
  await k2({ op: 'node.fail', node: 'scope', reason: 'no sound tools here' })
  await s.x.finished(next.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  next = await claim(s)
  assert.deepEqual(next.ref, ref, 'the parent wakes for the question though the other delegation is still open')
  let p = await rec(s.par, ref)
  const pending = Object.values(p.delegations!).flatMap(d => d.events.filter(e => e.wakes && !e.takenUp).map(e => `${d.node}:${e.type}`))
  assert.deepEqual(pending.sort(), ['icon:question', 'sound:failed'], 'both facts reach the parent; neither is suppressed by the other wait')
  assert.match(next.brief, /question q1/)
  assert.match(next.brief, /failed/)
  s.i.close(); s.n.close(); s.x.close()
})

test('an hours-long wait is durable state: a coordinator restart, repeated reconciles and duplicate relays change nothing until the child\'s fact, which continues the parent once', async () => {
  let s = await setup()
  const { ref, a } = await dispatched(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const kidRef = { workflow: 'make', run: 'run-001' }
  const c = await claim(s)
  const kid = as(s.kid, kidRef, c.attempt.id, 'kid-agent')
  await kid({ op: 'node.start', node: 'scope' })
  await kid({ op: 'node.wait', node: 'scope', reason: 'a long render', holder: 'renderer', external: 'render-42' } as never)
  await s.x.finished(c.attempt.id, { code: 0, signal: null })
  // Hours pass: nothing runs, nothing is held, the stores are reopened.
  s = await restart(s)
  for (let i = 0; i < 3; i++) { await s.x.reconcile(); await s.zulip.cycle() }
  let p = await rec(s.par, ref)
  assert.equal(p.control.hold, null)
  assert.equal(p.control.attempt, null)
  assert.equal(p.nodes.asset.state, 'waiting')
  assert.deepEqual(await s.x.claim('test'), { idle: 'no queued job' }, 'a healthy wait queues nothing and holds no slot')
  // The child's long work ends (recorded by its host, outside an attempt).
  await runOp(s.kid, kidRef, { op: 'node.fail', node: 'scope', reason: 'the render farm gave up' }, { by: 'kid-agent', via: 'cli' })
  s = await restart(s)
  for (let i = 0; i < 3; i++) { await s.x.delegate.relay(); await s.x.reconcile(); await s.zulip.cycle() }
  p = await rec(s.par, ref)
  assert.deepEqual(p.delegations!.d1.events.map(e => e.type), ['failed'], 'relayed once by receipt')
  const jobs = s.x.db.prepare('SELECT * FROM jobs WHERE workflow = ? AND run = ? AND state = \'queued\'').all('use', 'run-001')
  assert.equal(jobs.length, 1, 'one effective continuation')
  const p1 = await claim(s)
  assert.deepEqual(p1.ref, ref)
  assert.deepEqual(await s.x.claim('test'), { idle: 'the slot is held by attempt ' + p1.attempt.id + ' (par use/run-001)' }, 'never two attempts of one parent')
  s.i.close(); s.n.close(); s.x.close()
})

test('a parent stopped by its person keeps every incoming fact and is not continued by them, by reconcile or by a restart', async () => {
  let s = await setup()
  const { ref, a } = await dispatched(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  await s.x.stop(s.par, ref, 'Pat', 'not now', 'browser')
  const kidRef = { workflow: 'make', run: 'run-001' }
  const c = await claim(s)
  const kid = as(s.kid, kidRef, c.attempt.id, 'kid-agent')
  for (const n of ['scope', 'build', 'confirm']) { await kid({ op: 'node.start', node: n }); await kid({ op: 'node.complete', node: n, outcome: `${n} done.` }) }
  await s.x.finished(c.attempt.id, { code: 0, signal: null })
  s = await restart(s)
  for (let i = 0; i < 2; i++) { await s.x.delegate.relay(); await s.x.reconcile(); await s.zulip.cycle() }
  const p = await rec(s.par, ref)
  assert.equal(p.control.hold?.kind, 'stopped')
  assert.ok(p.delegations!.d1.events.some(e => e.type === 'completed'), 'the result is recorded')
  assert.deepEqual(await s.x.claim('test'), { idle: 'no queued job' }, 'and continues nothing')
  s.i.close(); s.n.close(); s.x.close()
})

test('an attempt that records nothing of its work is an interruption with its own cause; entries written before keep their meaning on replay', async () => {
  const s = await setup({ parent: CONVERSE })
  const { ref } = await s.x.request({ workspace: 'par', workflow: 'use', text: 'Hello.', author: 'Pat', receipt: 'quiet-request-1', via: 'browser' })
  const a = await claim(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  const p = await rec(s.par, ref)
  assert.equal(p.control.hold?.kind, 'interrupted')
  assert.deepEqual(p.control.hold?.cause, { code: 'nothing-recorded', nodes: ['talk'] })
  assert.match(p.control.hold!.reason, /nothing of the run's work recorded \(talk never started\)/)
  // The same history as written before p8 ex1 (no explain): a plain exit.
  const old = p.history.map(h => { const { explain: _, ...rest } = h as typeof h & { explain?: string }; return rest })
  const graph = graphOfState(p)!
  const replayed = replay(old, graph).state
  assert.equal(replayed.control.hold, null)
  assert.equal(replayed.control.last?.outcome, 'exited')
  s.i.close(); s.n.close(); s.x.close()
})
