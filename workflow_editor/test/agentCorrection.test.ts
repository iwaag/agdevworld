// tidy p3: an agent returns deficient work honestly. In p2's fixture trial
// (ponderer conduct/run-051 d1) ponderer judged a partial correction
// satisfied, then found the unchanged test itself; reopening required the
// person's words, so it cited an Omni go-ahead (#464). The correction was
// recorded "from Omni Agent (for Developer)", and review-unrecorded read ok.
// Here the agent's own finding reopens its own judgement with its evidence,
// the person's words stay a separate path, and no correction reads as the
// person's review.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { RequestError } from '../server/workspace.ts'
import { openRevision, originOf, originText } from '../shared/delegation.ts'
import { as, claim, delegationSuite, dispatched, rec, type S } from './delegateFixture.ts'

delegationSuite('wfe-agent-correction-')

const kidRef = { workflow: 'make', run: 'run-001' }
const code = (e: unknown) => ((e as RequestError).detail as { code?: string } | undefined)?.code

// The child completes, the standing parent judges it satisfied and rests.
async function accepted(s: S) {
  const { ref, a } = await dispatched(s)
  await runOp(await runSpace(s.par, ref), ref, { op: 'standing.establish', conversation: 'room-a', state: 'open', reason: 'test: the conductor of room-a' } as never, { by: 'conversation', via: 'conversation' })
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const c1 = await claim(s)
  const kid = as(s.kid, kidRef, c1.attempt.id, 'kid-agent')
  for (const n of ['scope', 'build', 'confirm']) { await kid({ op: 'node.start', node: n }); await kid({ op: 'node.complete', node: n, outcome: `${n} done` }) }
  await s.x.finished(c1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const p1 = await claim(s)
  const par = as(s.par, ref, p1.attempt.id, 'par-agent')
  await par({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  await s.x.delegate.dispose(s.par, ref, 'd1', { disposition: 'satisfied', note: 'read the report', yes: true }, { by: 'par-agent', via: 'cli', attempt: p1.attempt.id })
  await par({ op: 'node.complete', node: 'asset', outcome: 'the icon' })
  await par({ op: 'node.start', node: 'use' })
  await par({ op: 'node.complete', node: 'use', outcome: 'used' })
  await s.x.finished(p1.attempt.id, { code: 0, signal: null })
  assert.equal((await rec(s.par, ref)).execution.state, 'idle')
  return { ref, manifest: (await rec(s.par, ref)).delegations!.d1.events[0].manifest!.digest }
}

test('the agent reopens its own satisfied judgement with its evidence: recorded as its finding, the acceptance kept, the same child corrected; no person\'s words are needed or borrowed', async () => {
  const s = await (await import('./delegateFixture.ts')).setup()
  const { ref, manifest } = await accepted(s)
  const ctx = { by: 'par-agent', via: 'cli' }
  const plain = await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'x', reason: 'y', manifest }, ctx).catch(x => x)
  assert.match((plain as Error).message, /--reopen --evidence/, 'the refusal names the agent-origin route')
  assert.equal(code(await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'x', reason: 'y', manifest, reopen: true }, ctx).catch(x => x)), 'evidence', 'its own finding names what it checked')
  assert.equal(code(await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'x', reason: 'y', manifest, reopen: true, evidence: 'e', because: { kind: 'instruction', instruction: 'i1' } }, ctx).catch(x => x)), 'because', 'own finding or the person\'s words, not both')
  await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'Move test_longest_line into the TestCase.', reason: 'The claimed fix is not in the file.', manifest, reopen: true, evidence: 'read test_icon.py: the test is still outside the class; python3 -m unittest ran 3, not 4' }, { ...ctx, receipt: 'reopen-1' })
  const d = (await rec(s.par, ref)).delegations!.d1
  assert.deepEqual([d.disposition, d.reopened?.length, d.reopened?.[0]?.origin, d.reopened?.[0]?.because, d.reopened?.[0]?.disposition.kind], [null, 1, 'agent', undefined, 'satisfied'], 'reopened by its own finding; the acceptance kept')
  assert.match(d.reopened![0].evidence!, /ran 3, not 4/)
  const r = d.revisions![0]
  assert.deepEqual([r.from, r.by, r.origin, r.because], ['par-agent', 'par-agent', 'agent', undefined])
  assert.match(originText(r), /^par-agent's own finding \(checked: read test_icon\.py/)
  assert.ok(openRevision(d))
  await s.zulip.cycle()
  const child = await rec(s.kid, kidRef)
  assert.deepEqual([Object.keys(child.corrections ?? {}), child.corrections?.c1.from], [['c1'], 'par-agent'], 'the same child receives it, from the agent')
  // A retransmission records once.
  await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'Move test_longest_line into the TestCase.', reason: 'The claimed fix is not in the file.', manifest, reopen: true, evidence: 'read test_icon.py' }, { ...ctx, receipt: 'reopen-1' })
  assert.equal((await rec(s.par, ref)).delegations!.d1.revisions!.length, 1)
  s.i.close(); s.n.close(); s.x.close()
})

test('the person\'s words keep their own path; reopening needs a judged result, never a closed one; a human hold stays a hold', async () => {
  const s = await (await import('./delegateFixture.ts')).setup()
  const { ref, manifest } = await accepted(s)
  await runOp(await runSpace(s.par, ref), ref, { op: 'run.stop', reason: 'Pat holds it for now' } as never, { by: 'Pat', via: 'browser' })
  await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'Fix the test.', reason: 'Found by reading the test.', manifest, reopen: true, evidence: 'read the test file' }, { by: 'par-agent', via: 'cli' })
  const p = await rec(s.par, ref)
  assert.equal(p.control.hold?.by, 'Pat', 'an agent-origin correction does not lift the person\'s hold')
  assert.equal(code(await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'x', reason: 'y', reopen: true, evidence: 'e' }, { by: 'par-agent', via: 'cli' }).catch(x => x)), 'state', 'not judged: nothing to reopen')
  // A delegation judged rejected or abandoned is closed for every origin.
  await runOp(await runSpace(s.par, ref), ref, { op: 'delegation.dispose', delegation: 'd1', disposition: 'abandoned', note: 'replacing it' } as never, { by: 'par-agent', via: 'cli' })
  assert.equal(code(await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'x', reason: 'y', reopen: true, evidence: 'e' }, { by: 'par-agent', via: 'cli' }).catch(x => x)), 'delegation-closed')
  s.i.close(); s.n.close(); s.x.close()
})

test('a recorded attribution is corrected by an appended entry: the original from stays, readers show both, the child is told nothing', async () => {
  const s = await (await import('./delegateFixture.ts')).setup()
  const { ref, manifest } = await accepted(s)
  await runOp(await runSpace(s.par, ref), ref, { op: 'instruction.receive', text: 'Go ahead and send it back.', from: 'Pat' } as never, { by: 'Pat', via: 'conversation' })
  await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'Fix the test.', reason: 'Claimed fix not present.', manifest, because: { kind: 'instruction', instruction: 'i1' } }, { by: 'par-agent', via: 'cli' })
  let r = (await rec(s.par, ref)).delegations!.d1.revisions![0]
  assert.deepEqual([r.from, r.origin, originOf(r).origin], ['Pat', 'person', 'person'], 'as recorded: relayed words')
  const before = (await rec(s.kid, kidRef)).seq
  await assert.rejects(runOp(await runSpace(s.par, ref), ref, { op: 'delegation.attribute', delegation: 'd1', revision: 1, origin: 'agent', from: 'par-agent', reason: '' } as never, { by: 'Omni', via: 'cli' }), /reason/)
  await runOp(await runSpace(s.par, ref), ref, { op: 'delegation.attribute', delegation: 'd1', revision: 1, origin: 'agent', from: 'par-agent', reason: 'i1 was a go-ahead; the defect was par-agent\'s own finding (its note at seq 12)' } as never, { by: 'Omni', via: 'cli' })
  r = (await rec(s.par, ref)).delegations!.d1.revisions![0]
  assert.deepEqual([r.from, r.because?.from, originOf(r).origin, originOf(r).from], ['Pat', 'Pat', 'agent', 'par-agent'], 'the original stays; the attribution is beside it')
  assert.match(originText(r), /par-agent's own finding; attributed so by Omni at .* recorded at first as from Pat/)
  await s.zulip.cycle()
  assert.equal((await rec(s.kid, kidRef)).corrections?.c1.from, 'Pat', 'the child keeps what it received')
  assert.ok((await rec(s.kid, kidRef)).seq >= before)
  await assert.rejects(runOp(await runSpace(s.par, ref), ref, { op: 'delegation.attribute', delegation: 'd1', revision: 9, origin: 'agent', from: 'x', reason: 'y' } as never, { by: 'Omni', via: 'cli' }), /no correction request 9/)
  s.i.close(); s.n.close(); s.x.close()
})
