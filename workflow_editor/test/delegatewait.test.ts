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
import { adjustRun } from '../server/runs.ts'
import type { AdjustOptions } from '../server/runs.ts'
import type { RunRef } from '../shared/run.ts'
import { as, claim, delegationSuite, KID_WF, rec, setup, type S } from './delegateFixture.ts'

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
