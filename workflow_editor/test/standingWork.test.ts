// workflow_editor p18 step 3: a standing conductor's commissions stay their
// recipients' runs. The child of the conductor's delegate node keeps its own
// identity, records and completion: its result returned for correction goes
// back to the same child, the conductor is continued (not replaced) by the
// corrected result, and coming to rest afterwards decides nothing about the
// child — no cancellation, acceptance or integration is inferred from it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readRun, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { openRevision } from '../shared/delegation.ts'
import { as, claim, delegationSuite, dispatched, rec } from './delegateFixture.ts'

delegationSuite('wfe-standing-work-')

const kidRef = { workflow: 'make', run: 'run-001' }

test('a standing parent: its child\'s result goes back to the same child for correction; the corrected result continues the same parent run; at rest the parent decides nothing about the child', async () => {
  const s = await (await import('./delegateFixture.ts')).setup()
  const { ref, a } = await dispatched(s)
  // The parent stands for a conversation (as a conductor does).
  await runOp(await runSpace(s.par, ref), ref, { op: 'standing.establish', conversation: 'room-p', state: 'open', reason: 'test: the conductor of room-p' } as never, { by: 'conversation', via: 'conversation' })
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  assert.equal((await rec(s.par, ref)).execution.state, 'in-progress', 'waiting for its child: not at rest')
  await s.zulip.cycle()
  // The child does its work and completes on its own.
  const c1 = await claim(s)
  assert.deepEqual(c1.ref, kidRef)
  const kid = as(s.kid, kidRef, c1.attempt.id, 'kid-agent')
  for (const n of ['scope', 'build', 'confirm']) { await kid({ op: 'node.start', node: n }); await kid({ op: 'node.complete', node: n, outcome: `${n} done` }) }
  await s.x.finished(c1.attempt.id, { code: 0, signal: null })
  assert.equal((await rec(s.kid, kidRef)).execution.state, 'completed', 'the child completes independently')
  await s.zulip.cycle()
  // The parent is continued by the result and returns it to the same child.
  const p1 = await claim(s)
  assert.deepEqual(p1.ref, ref)
  const par = as(s.par, ref, p1.attempt.id, 'par-agent')
  await par({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  const manifest = (await rec(s.par, ref)).delegations!.d1.events[0].manifest!.digest
  await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'Add a 32x32 variant.', reason: 'The person asked for a smaller size too.', manifest }, { by: 'par-agent', via: 'cli', attempt: p1.attempt.id, receipt: 'revise-1' })
  await s.x.finished(p1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const child = await rec(s.kid, kidRef)
  assert.deepEqual(Object.keys(child.corrections ?? {}), ['c1'], 'the correction reached the original child')
  const c2 = await claim(s)
  assert.deepEqual(c2.ref, kidRef, 'the same child run continues; no new child')
  const kid2 = as(s.kid, kidRef, c2.attempt.id, 'kid-agent')
  await kid2({ op: 'correction.take-up', correction: 'c1', note: 'nothing more to add after all', noChange: true } as never)
  await s.x.finished(c2.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  // The new result continues the same parent run, which judges it and comes to rest.
  const p2 = await claim(s)
  assert.deepEqual(p2.ref, ref, 'the same parent run')
  const par2 = as(s.par, ref, p2.attempt.id, 'par-agent')
  const p = await rec(s.par, ref)
  const results = p.delegations!.d1.events.filter(e => e.type === 'completed')
  assert.equal(results.length, 2, 'a new result, the first kept')
  assert.equal(openRevision(p.delegations!.d1), undefined)
  await par2({ op: 'delegation.take-up', delegation: 'd1', events: [results[1].n] } as never)
  await s.x.delegate.dispose(s.par, ref, 'd1', { disposition: 'satisfied', note: 'as asked', yes: true }, { by: 'par-agent', via: 'cli', attempt: p2.attempt.id })
  await par2({ op: 'node.complete', node: 'asset', outcome: 'the icon, corrected once' })
  await par2({ op: 'node.start', node: 'use' })
  await par2({ op: 'node.complete', node: 'use', outcome: 'used' })
  await s.x.finished(p2.attempt.id, { code: 0, signal: null })
  const parent = await rec(s.par, ref)
  assert.equal(parent.execution.state, 'idle', 'the standing parent rests')
  const kidNow = await rec(s.kid, kidRef)
  assert.deepEqual([kidNow.cancelled, kidNow.decisions.length], [null, 0], 'resting decides nothing about the child: not cancelled, not accepted')
  assert.deepEqual(s.x.integrations('kid', kidRef).map(i => i.requested_by), s.x.integrations('kid', kidRef).map(() => 'autolab'), 'only the child\'s own completion queued its integration')
  assert.equal((await readRun(await runSpace(s.kid, kidRef), kidRef)).record!.history.filter(h => h.op === 'correction.receive').length, 1)
  s.i.close(); s.n.close(); s.x.close()
})

test('a result the standing parent accepted, which the person later wants changed: their words reopen the same child; the acceptance is kept; nothing else reopens it', async () => {
  const s = await (await import('./delegateFixture.ts')).setup()
  const { ref, a } = await dispatched(s)
  await runOp(await runSpace(s.par, ref), ref, { op: 'standing.establish', conversation: 'room-q', state: 'open', reason: 'test: the conductor of room-q' } as never, { by: 'conversation', via: 'conversation' })
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const c1 = await claim(s)
  const kid = as(s.kid, kidRef, c1.attempt.id, 'kid-agent')
  for (const n of ['scope', 'build', 'confirm']) { await kid({ op: 'node.start', node: n }); await kid({ op: 'node.complete', node: n, outcome: `${n} done` }) }
  await s.x.finished(c1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  // The parent accepts the result and comes to rest.
  const p1 = await claim(s)
  const par = as(s.par, ref, p1.attempt.id, 'par-agent')
  await par({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  await s.x.delegate.dispose(s.par, ref, 'd1', { disposition: 'satisfied', note: 'as asked', yes: true }, { by: 'par-agent', via: 'cli', attempt: p1.attempt.id })
  await par({ op: 'node.complete', node: 'asset', outcome: 'the icon' })
  await par({ op: 'node.start', node: 'use' })
  await par({ op: 'node.complete', node: 'use', outcome: 'used' })
  await s.x.finished(p1.attempt.id, { code: 0, signal: null })
  assert.equal((await rec(s.par, ref)).execution.state, 'idle')
  // Later the person asks for a change; the parent is continued with their words.
  await runOp(await runSpace(s.par, ref), ref, { op: 'instruction.receive', text: 'Make the icon blue, please.', from: 'Pat' } as never, { by: 'Pat', via: 'conversation' })
  await runOp(await runSpace(s.par, ref), ref, { op: 'run.adjust', revision: 'wake', source: { kind: 'wake', events: ['i1'] }, nodes: { 'ponder-w1': { type: 'do', name: 'Ponder', description: 'x' } }, edges: [{ from: 'use', to: 'ponder-w1' }] } as never, { by: 'conversation', via: 'conversation' }).catch(() => null)
  const manifest = (await rec(s.par, ref)).delegations!.d1.events[0].manifest!.digest
  // Without the person's words it stays closed.
  await assert.rejects(s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'blue', reason: 'r', manifest }, { by: 'par-agent', via: 'cli', receipt: 'revise-x' }), /judged satisfied.*--because/)
  await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'Make it blue.', reason: 'The person asked for a blue icon after it was accepted.', manifest, because: { kind: 'instruction', instruction: 'i1' } }, { by: 'par-agent', via: 'cli', receipt: 'revise-q' })
  const p = await rec(s.par, ref)
  const d = p.delegations!.d1
  assert.deepEqual([d.disposition, d.reopened?.length, d.reopened?.[0]?.disposition.kind, d.reopened?.[0]?.review, d.reopened?.[0]?.because?.from], [null, 1, 'satisfied', null, 'Pat'], 'reopened by the person\'s words; the acceptance kept')
  assert.ok(openRevision(d), 'the result went back for correction')
  assert.equal(p.nodes.asset!.state, 'waiting', 'the delegate node waits for the corrected result')
  await s.zulip.cycle()
  const child = await rec(s.kid, kidRef)
  assert.deepEqual(Object.keys(child.corrections ?? {}), ['c1'], 'the same child receives it')
  s.i.close(); s.n.close(); s.x.close()
})
