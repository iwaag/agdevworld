// tidy p3: a result the receiver requested itself (wfe request) and awaited
// (conversation ask --run) gets the evidence a delegated result gets, and
// only its requester — as recorded in its input — may return it. In p2's
// fixture rooms (conduct/run-050, run-051) ponderer used this route; the
// await said "unanswered: ended without a message here" and nothing else.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { RequestError } from '../server/workspace.ts'
import { assessRequested, awaitedStanding, requestedLines, returnRequested } from '../server/requestedResult.ts'
import { as, claim, delegationSuite, rec, setup, type S } from './delegateFixture.ts'

delegationSuite('wfe-requested-')

const code = (e: unknown) => ((e as RequestError).detail as { code?: string } | undefined)?.code
const PARENT = 'par/use/run-001'
const kidTarget = { workspace: 'kid', ref: { workflow: 'make', run: 'run-001' } }

// The person's request starts the parent; the parent's agent requests the
// kid's work with wfe request (the kid's input names the parent run), and
// the kid completes with a file and a report claiming more than it did.
async function requested(s: S) {
  const { ref } = await s.x.request({ workspace: 'par', workflow: 'use', text: 'I need an icon.', author: 'Pat', receipt: 'person-request-1', via: 'browser' })
  const a = await claim(s)
  assert.deepEqual(a.ref, ref)
  const kid = await s.x.request({ workspace: 'kid', workflow: 'make', text: 'Make a 64x64 icon with tests.', author: 'par-agent', receipt: 'par-requests-kid-1', via: 'cli', input: { kind: 'request', text: 'Make a 64x64 icon with tests.', requester: 'par-agent', onBehalfOf: 'Pat', entrustedBy: { kind: 'run', project: 'par', workflow: 'use', run: 'run-001' } } })
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  const c = await claim(s)
  assert.deepEqual(c.ref, kid.ref)
  const k = as(s.kid, kid.ref, c.attempt.id, 'kid-agent')
  const space = await runSpace(s.kid, kid.ref)
  await mkdir(join(space.root, 'icon'), { recursive: true })
  await writeFile(join(space.root, 'icon', 'test_icon.py'), 'import unittest\n')
  for (const n of ['scope', 'build', 'confirm']) { await k({ op: 'node.start', node: n }); await k({ op: 'node.complete', node: n, outcome: n === 'confirm' ? '4 tests OK; works anywhere' : `${n} done` }) }
  await s.x.finished(c.attempt.id, { code: 0, signal: null })
  return { kidRef: kid.ref }
}

test('the requester reads the requested run\'s result with the claim beside its records and the return route; an observer is told who requested it', async () => {
  const s = await setup()
  await requested(s)
  const a = await assessRequested(s.x.delegate, kidTarget, PARENT)
  assert.deepEqual([a.relation, a.requestedBy, a.state], ['requester', PARENT, 'completed'])
  assert.ok(a.resultSeq && a.manifest?.startsWith('sha256:'))
  const text = requestedLines(a, '').join('\n')
  assert.match(text, /claim — outcome: "4 tests OK; works anywhere"/)
  assert.match(text, /records — changed outside its run folder \(1\): icon\/test_icon\.py/)
  assert.match(text, /Tests: the output in the report is the requested run's claim/)
  assert.match(text, new RegExp(`wfe run return kid/make/run-001 --requester ${PARENT} --result-seq ${a.resultSeq}`))
  assert.match(text, /No go-ahead is needed for what the request asked/)
  const o = await assessRequested(s.x.delegate, kidTarget, 'par/use/run-009')
  assert.equal(o.relation, 'observer')
  assert.match(o.route.join(' '), /You did not request kid\/make\/run-001 \(requested by par\/use\/run-001\); observing it gives no authority to return it/)
  assert.doesNotMatch(requestedLines(o).join('\n'), /wfe run return/)
  s.i.close(); s.n.close(); s.x.close()
})

test('only the recorded requester returns it, for the result it assessed: the run reopens with a correction from the requester and is continued; a retransmission records once; an open correction is not returned again', async () => {
  const s = await setup()
  const { kidRef } = await requested(s)
  const a = await assessRequested(s.x.delegate, kidTarget, PARENT)
  const base = { instruction: 'Make the fourth test run.', reason: 'Claimed 4 tests; 3 run.', evidence: 'ran python3 -m unittest: 3 tests', by: 'par-agent', via: 'cli' }
  assert.equal(code(await returnRequested(s.x.delegate, kidTarget, { ...base, requester: 'kid/make/run-001' }).catch(x => x)), 'not-requester', 'a run that did not request it')
  assert.equal(code(await returnRequested(s.x.delegate, kidTarget, { ...base, requester: PARENT, resultSeq: a.resultSeq! - 1 }).catch(x => x)), 'result-superseded', 'not the result assessed')
  const r = await returnRequested(s.x.delegate, kidTarget, { ...base, requester: PARENT, resultSeq: a.resultSeq!, receipt: 'return-1' })
  assert.equal(r.correction, 'c1')
  const kid = await rec(s.kid, kidRef)
  assert.equal(kid.execution.state, 'in-progress', 'reopened for the correction')
  assert.deepEqual([kid.corrections?.c1.request?.run, kid.corrections?.c1.delegation, kid.corrections?.c1.from, kid.corrections?.c1.by, kid.corrections?.c1.evidence], [PARENT, undefined, 'par-agent', 'par-agent', 'ran python3 -m unittest: 3 tests'])
  assert.ok(r.job, 'the run is continued')
  const again = await returnRequested(s.x.delegate, kidTarget, { ...base, requester: PARENT, resultSeq: a.resultSeq!, receipt: 'return-1' })
  assert.deepEqual([again.duplicate, Object.keys((await rec(s.kid, kidRef)).corrections ?? {})], [true, ['c1']])
  assert.equal(code(await returnRequested(s.x.delegate, kidTarget, { ...base, requester: PARENT, receipt: 'return-2' }).catch(x => x)), 'correction-state', 'open for c1 already')
  assert.match((await assessRequested(s.x.delegate, kidTarget, PARENT)).route.join(' '), /open for correction c1; its next completion is a new result/)
  // Inside an attempt, the attempt must be the requester's own.
  assert.equal(code(await returnRequested(s.x.delegate, kidTarget, { ...base, requester: PARENT, attempt: 'not-its-attempt' }).catch(x => x)), 'not-requester')
  // Where the conductor accounts to the room: the awaited run, with its correction.
  const ds = { invitations: () => [{ awaited_by: PARENT, awaits: 'result', run: 'kid/make/run-001' }, { awaited_by: 'other/x/run-001', awaits: 'result', run: 'kid/make/run-002' }], exec: s.x }
  const st = await awaitedStanding(ds, ['room'], PARENT)
  assert.deepEqual(st.map(x => x.text), ['kid/make/run-001 (requested): returned for correction c1, not back yet'])
  s.i.close(); s.n.close(); s.x.close()
})

test('the reducer keeps the relation: a requested correction on a run nobody requested, or with a delegation as well, is refused', async () => {
  const s = await setup()
  const { ref } = await s.x.request({ workspace: 'par', workflow: 'use', text: 'x', author: 'Pat', receipt: 'person-request-9', via: 'browser' })
  await assert.rejects(runOp(await runSpace(s.par, ref), ref, { op: 'correction.receive', request: { run: 'par/use/run-009' }, result: { seq: 1 }, text: 't', reason: 'r', from: 'par-agent' } as never, { by: 'par-agent', via: 'cli' }), (e: unknown) => code(e) === 'request-relation')
  await assert.rejects(runOp(await runSpace(s.par, ref), ref, { op: 'correction.receive', request: { run: 'par/use/run-009' }, delegation: { uid: 'x', revision: 1 }, result: { seq: 1 }, text: 't', reason: 'r', from: 'par-agent' } as never, { by: 'par-agent', via: 'cli' }), /not both/)
  s.i.close(); s.n.close(); s.x.close()
})
