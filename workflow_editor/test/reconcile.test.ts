// project_migration p8 ex1 step 3: deterministic reconciliation repairs the
// queue and delivery records a crash or a lost row leaves missing, from the
// run records alone, and never makes a second child or a second post.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listRuns, runOp } from '../server/runs.ts'
import { KID_STREAM, as, claim, delegationSuite, dispatched, rec, setup } from './delegateFixture.ts'

delegationSuite('wfe-reconcile-')

const queued = (s: Awaited<ReturnType<typeof setup>>, workflow: string, run: string) =>
  s.x.db.prepare('SELECT * FROM jobs WHERE workflow = ? AND run = ? AND state = \'queued\'').all(workflow, run) as { id: number; receipt: string }[]

test('missing queue records: a lost instruction job and a lost resume job are queued again — once each, from the record', async () => {
  const s = await setup()
  const { ref, a } = await dispatched(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  // The child's start job is not this test's subject.
  s.x.db.prepare('UPDATE jobs SET state = \'dropped\' WHERE workflow = \'make\'').run()
  // An instruction for the waiting parent; its job is lost.
  await runOp(s.par, ref, { op: 'instruction.receive', text: 'Make it bigger.', from: 'Pat' }, { by: 'Pat', via: 'browser' })
  assert.ok(await s.x.afterInstruction(s.par, ref, 'i1'))
  s.x.db.prepare('DELETE FROM jobs WHERE workflow = ? AND run = ?').run('use', 'run-001')
  let notes = await s.x.reconcile()
  assert.ok(notes.some(n => /resume for instruction i1 queued again/.test(n)), notes.join('\n'))
  await s.x.reconcile()
  assert.equal(queued(s, 'use', 'run-001').length, 1)
  // Held, resumed by the person, and the resume's job lost.
  await s.x.stop(s.par, ref, 'Pat', 'wait', 'browser')
  await s.x.resume(s.par, ref, 'Pat', 'go on', 'browser')
  s.x.db.prepare('DELETE FROM jobs WHERE workflow = ? AND run = ?').run('use', 'run-001')
  notes = await s.x.reconcile()
  assert.ok(notes.some(n => /run\.resume at seq \d+ queued again|instruction i1 queued again/.test(n)), notes.join('\n'))
  await s.x.reconcile()
  assert.equal(queued(s, 'use', 'run-001').length, 1, 'one continuation however often reconcile runs')
  const p = await claim(s)
  assert.deepEqual(p.ref, ref)
  s.i.close(); s.n.close(); s.x.close()
})

test('a request post whose delivery records were lost after it went out is found by its marker: one post, one child', async () => {
  const s = await setup()
  const { ref, a } = await dispatched(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.deliver()
  assert.equal(s.zulip.posts.filter(p => p.streamId === KID_STREAM && p.content.includes(':delegation-request@d1')).length, 1)
  // The notifier's records of it are lost before the intake saw the post.
  const ev = `par/use/run-001#${(await rec(s.par, ref)).delegations!.d1.dispatched.seq}:delegation-request@d1`
  const did = (s.n.db.prepare('SELECT delivery FROM delivery_events WHERE event = ?').get(ev) as { delivery: number }).delivery
  s.n.db.prepare('DELETE FROM delivery_events WHERE delivery = ?').run(did)
  s.n.db.prepare('DELETE FROM deliveries WHERE id = ?').run(did)
  s.n.db.prepare('DELETE FROM outbox WHERE id = ?').run(ev)
  const notes = await s.n.scan()
  assert.ok(notes.some(n => n.includes(ev) && /again/.test(n)), notes.join('\n'))
  await s.zulip.cycle()
  await s.zulip.cycle()
  assert.equal(s.zulip.posts.filter(p => p.streamId === KID_STREAM && p.content.includes(':delegation-request@d1')).length, 1, 'found, not posted again')
  assert.equal((await listRuns(s.kid)).length, 1, 'one child')
  assert.equal((await rec(s.par, ref)).delegations!.d1.child?.run, 'run-001')
  s.i.close(); s.n.close(); s.x.close()
})

test('an answer whose outbox row was lost before it went out is queued again: the child is answered once', async () => {
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
  const p1 = await claim(s)
  await as(s.par, ref, p1.attempt.id, 'par-agent')({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  await s.x.delegate.answer(s.par, ref, 'd1', 'q1', '64px.', { by: 'par-agent', via: 'cli', attempt: p1.attempt.id })
  await s.x.finished(p1.attempt.id, { code: 0, signal: null })
  await s.n.scan()
  const ev = (s.n.db.prepare('SELECT id FROM outbox WHERE id LIKE \'%:delegation-answer@d1\'').get() as { id: string }).id
  s.n.db.prepare('DELETE FROM outbox WHERE id = ?').run(ev)
  await s.zulip.cycle()
  await s.zulip.cycle()
  const child = await rec(s.kid, kidRef)
  assert.deepEqual(child.questions.q1.answers.map(x => x.text), ['64px.'], 'answered once')
  s.i.close(); s.n.close(); s.x.close()
})

test('the observation carries what Observer needs to tell a cause that keeps coming back: the hold\'s cause, recent ends and their recoveries, and the bound child by uid', async () => {
  const { Observer } = await import('../server/observe.ts')
  const s = await setup()
  const { ref, a } = await dispatched(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  s.x.db.prepare('UPDATE jobs SET state = \'dropped\' WHERE workflow = \'make\'').run() // the child waits; not this test's subject
  // An instruction continues the parent; its attempt leaves `use` running — twice, with a recovery between.
  await runOp(s.par, ref, { op: 'instruction.receive', text: 'Start using what you have.', from: 'Pat' }, { by: 'Pat', via: 'browser' })
  await s.x.afterInstruction(s.par, ref, 'i1')
  let c = await claim(s)
  await as(s.par, ref, c.attempt.id, 'par-agent')({ op: 'node.start', node: 'use' })
  await s.x.finished(c.attempt.id, { code: 0, signal: null })
  await s.x.recover(s.par, ref, { incident: 'itest000001', attempt: c.attempt.id, reason: 'looked: nothing happened outside the copy', by: 'Omni Agent', via: 'cli' })
  c = await claim(s)
  await s.x.finished(c.attempt.id, { code: 0, signal: null })
  const o = new Observer(s.x, s.registry)
  const run = (await o.observe()).runs.find(r => r.identity.workspace === 'par')!
  assert.deepEqual(run.hold?.cause, { code: 'left-running', nodes: ['use'] })
  assert.deepEqual(run.attempts.ends?.map(e => [e.outcome, e.cause?.code ?? null, e.recovered]), [['exited', null, false], ['interrupted', 'left-running', true], ['interrupted', 'left-running', false]])
  assert.equal(run.delegations?.[0].childUid, (await rec(s.par, ref)).delegations!.d1.child!.uid)
  s.i.close(); s.n.close(); s.x.close()
})
