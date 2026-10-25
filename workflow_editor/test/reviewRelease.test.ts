// workflow_editor p17 ex1: approval finishes the review's cleanup through the
// page's actual owner and continues the work it unlocked, without a
// recovering agent. The shape of conversation 20261025-013759-jz8ebz: the
// child presents its page and leaves it serving, prepares its own human
// review, writes its final report and ends its attempt; the person approves;
// the explicit cleanup node after the review is the only work left.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Presenter } from '../server/present.ts'
import { registerPresentation } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import type { RunRecord } from '../shared/run.ts'
import { as, claim, delegationSuite, rec, restart, setup, type S } from './delegateFixture.ts'

delegationSuite('wfe-reviewrelease-')

const PARENT = `schema: ag.workflow.v2
id: use
name: Use an asset
intent: |
  Get an animation made for the person.
documentation: {policy: manual}
execution: {agent: par-agent}
intake: {zulip: requests}
repositories:
  root: {path: ., access: editable}
nodes:
  asset:
    type: delegate
    description: Ask the kid project for the animation.
    project: kid
    workflow: make
    accepts: parent
edges: []
`
// The child's graph as run-013 had it: work and present, its own human
// review, the explicit cleanup after it, and the final report (compiler v5
// puts it after the work before the review).
const KID = `schema: ag.workflow.v2
id: make
name: Make
intent: |
  Make what is asked, present it and hand it to the person's review.
documentation: {policy: custom, plan: false, reports: false, final: true}
execution: {agent: kid-agent}
intake: {zulip: requests}
repositories:
  root: {path: ., access: editable}
nodes:
  present:
    type: do
    description: Build it, present it and start its server.
  review:
    type: review
    name: Human review
    description: The person reviews the animation.
  cleanup:
    type: do
    description: Stop what this run started for the review and verify that it stopped.
edges:
  - {from: present, to: review}
  - {from: review, to: cleanup}
`
const kidRef = { workflow: 'make', run: 'run-001' }
const ACTOR = 'p17ex1-check' // an identified check actor, never the person
type Job = { id: number; workspace: string; run: string; receipt: string; state: string; kind: string }
const jobs = (s: S, ws?: string) => (s.x.db.prepare('SELECT * FROM jobs ORDER BY id').all() as Job[]).filter(j => !ws || j.workspace === ws)
const open = (s: S, ws?: string) => jobs(s, ws).filter(j => j.state === 'queued' || j.state === 'claimed')
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const ops = (r: RunRecord) => r.history.map(h => h.op as string)

// What each boundary looked like, for the report (DEBUG_RELEASE=1).
function boundary(s: S, what: string, r: RunRecord) {
  if (!process.env.DEBUG_RELEASE) return
  const v = r.reviews?.rv1
  console.error(JSON.stringify({ at: what, seq: r.seq, round: v?.state, cleanup: v?.cleanup?.state, results: v?.cleanup?.results.map(c => `${c.instance}:${c.status}`), presentation: r.presentations?.p1?.state, ready: r.execution.ready, waiting: r.execution.waiting.map(w => w.node), attempt: r.control.attempt?.id ?? null, hold: r.control.hold?.kind ?? null, jobs: open(s, 'kid').map(j => `${j.kind}:${j.receipt}`) }))
}

// The parent delegates; the child is claimed.
async function child(s: S, ports: [number, number]) {
  await writeFile(join(s.area, 'present.json'), JSON.stringify({ ports, answerBase: 'http://localhost:8093/wfe/' }))
  const { ref } = await s.x.request({ workspace: 'par', workflow: 'use', text: 'A waterfall animation.', author: 'Pat', receipt: `release-${ports[0]}`, via: 'browser' })
  const p = await claim(s)
  await as(s.par, ref, p.attempt.id, 'par-agent')({ op: 'node.start', node: 'asset' })
  await s.x.delegate.dispatch(s.par, ref, 'asset', { request: 'Animate the waterfall and hand it to the person.', attempt: p.attempt.id, by: 'par-agent', via: 'cli' })
  await s.x.finished(p.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const k = await claim(s)
  assert.deepEqual(k.ref, kidRef)
  return { ref, k }
}

// The child presents and leaves its page serving (started before the
// review), prepares its own review and writes its final report.
async function presentAndPrepare(s: S, attempt: string): Promise<number> {
  const kid = as(s.kid, kidRef, attempt, 'kid-agent')
  await kid({ op: 'node.start', node: 'present' })
  const space = await runSpace(s.kid, kidRef)
  await mkdir(join(space.root, 'page'), { recursive: true })
  await writeFile(join(space.root, 'page', 'index.html'), '<p>a waterfall</p>')
  await writeFile(join(space.root, 'page', 'review.md'), '# Waterfall\n')
  await registerPresentation(s.kid, kidRef, { node: 'present', source: 'page', entry: 'index.html', review: 'page/review.md', title: 'Waterfall' }, { by: 'kid-agent', via: 'cli', attempt, advice: { yes: true } })
  const pr = new Presenter({ registryFile: s.registry, area: s.area, by: 'kid-agent' })
  let pid: number
  try { pid = (await pr.start(s.kid, kidRef, 'p1')).instance.pid! } finally { pr.close() }
  await kid({ op: 'node.complete', node: 'present', outcome: 'p1 registered and served' })
  await s.x.reviews.prepare(s.kid, kidRef, 'review', { summary: 'The waterfall loops; check the seam.', subjects: ['p1'] }, { by: 'kid-agent', via: 'cli', attempt })
  await kid({ op: 'node.start', node: '_final-report' })
  await writeFile(join(space.root, 'devdocs/runs/make/run-001/report.md'), '# Report\n\nThe waterfall loops.\n')
  await kid({ op: 'node.complete', node: '_final-report', outcome: 'report.md written' })
  return pid
}

// The child's continuation does its explicit cleanup: the page is already
// stopped, so its stop is an idempotent success.
async function cleanupNode(s: S, attempt: string) {
  const kid = as(s.kid, kidRef, attempt, 'kid-agent')
  await kid({ op: 'node.start', node: 'cleanup' })
  const pr = new Presenter({ registryFile: s.registry, area: s.area, by: 'kid-agent' })
  try {
    const res = await pr.stop(s.kid, kidRef, 'all')
    assert.ok(res.every(x => x.ok), JSON.stringify(res))
  } finally { pr.close() }
  await kid({ op: 'node.complete', node: 'cleanup', outcome: 'p1 is stopped (verified)' })
}

test('incident shape: same-run reused page stopped on approval, the cleanup successor continued once, the child completes and its parent receives it, with no recovery', { todo: 'fails before p17 ex1 steps 2–3' }, async () => {
  const s = await setup({ parent: PARENT, kid: KID })
  try {
    const { ref } = await child(s, [18900, 18919])
    const pid = await presentAndPrepare(s, (await claimOf(s)).id)
    let k = await rec(s.kid, kidRef)
    await s.x.finished(k.control.attempt!.id, { code: 0, signal: null })
    k = await rec(s.kid, kidRef)
    boundary(s, 'attempt ended', k)
    assert.equal(k.control.hold, null, 'a normal end: only the review waits')
    assert.equal(open(s, 'kid').length, 0)

    await s.x.reviews.start(s.kid, kidRef, 'rv1', { by: ACTOR, via: 'browser' })
    k = await rec(s.kid, kidRef)
    boundary(s, 'review started', k)
    assert.equal(k.reviews!.rv1.serving[0].mode, 'reused', 'the page was serving before the review')
    const d = await s.x.reviews.decide(s.kid, kidRef, 'rv1', { outcome: 'approved', synthetic: true }, { by: ACTOR, via: 'browser' })
    k = await rec(s.kid, kidRef)
    boundary(s, 'approved', k)
    assert.equal(d.round.state, 'complete')
    assert.deepEqual(d.round.cleanup!.results.map(c => c.status), ['stopped'], 'the review\'s own run stops its own page')
    assert.equal(k.presentations!.p1.state, 'stopped', 'verified stopping recorded on the owning run')
    assert.ok(!alive(pid), 'nothing serves the page any more')
    assert.deepEqual(k.execution.ready, ['cleanup'])
    assert.equal(open(s, 'kid').length, 1, 'the work approval unlocked is continued by its executor')

    await s.x.reconcile()
    assert.equal(open(s, 'kid').length, 1, 'reconcile finds the same continuation')
    const c = await claim(s)
    assert.deepEqual(c.ref, kidRef)
    await cleanupNode(s, c.attempt.id)
    await s.x.finished(c.attempt.id, { code: 0, signal: null })
    k = await rec(s.kid, kidRef)
    boundary(s, 'completed', k)
    assert.equal(k.execution.state, 'completed')
    assert.equal(k.control.hold, null)
    assert.ok(!ops(k).includes('run.recover'), 'no recovering agent')
    assert.equal(k.control.attempts, 2)
    await s.x.reconcile()
    assert.equal(open(s, 'kid').length, 0, 'nothing more is launched for the handled approval')

    // The parent receives the child's completion as its result.
    await s.zulip.cycle()
    const p = await rec(s.par, ref)
    assert.ok(p.delegations!.d1.events.some(e => e.type === 'completed'), JSON.stringify(p.delegations!.d1.events))
  } finally { sweep(s); s.i.close(); s.n.close(); s.x.close() }
})

test('approval while the attempt is still open: no concurrent execution, a normal end, one later attempt', { todo: 'fails before p17 ex1 steps 2–3' }, async () => {
  const s = await setup({ parent: PARENT, kid: KID })
  try {
    await child(s, [18920, 18939])
    const a = await claimOf(s)
    const pid = await presentAndPrepare(s, a.id)
    // The person approves before the attempt's end is recorded.
    await s.x.reviews.start(s.kid, kidRef, 'rv1', { by: ACTOR, via: 'browser' })
    await s.x.reviews.decide(s.kid, kidRef, 'rv1', { outcome: 'approved', synthetic: true }, { by: ACTOR, via: 'browser' })
    let k = await rec(s.kid, kidRef)
    boundary(s, 'approved during the attempt', k)
    assert.equal(k.reviews!.rv1.state, 'complete')
    assert.ok(!alive(pid))
    assert.equal(open(s, 'kid').filter(j => j.state === 'queued').length, 0, 'nothing is queued beside the open attempt')
    await s.x.reconcile()
    assert.equal(open(s, 'kid').filter(j => j.state === 'queued').length, 0, 'nor by reconcile')
    const end = await s.x.finished(a.id, { code: 0, signal: null })
    k = await rec(s.kid, kidRef)
    boundary(s, 'attempt ended', k)
    assert.equal(k.control.hold, null, 'the unlocked work arrived during the attempt: not left-ready')
    assert.ok(end.resumeJob, 'the end reassesses and queues the continuation')
    await s.x.reconcile()
    assert.equal(open(s, 'kid').length, 1)
    const c = await claim(s)
    await cleanupNode(s, c.attempt.id)
    await s.x.finished(c.attempt.id, { code: 0, signal: null })
    k = await rec(s.kid, kidRef)
    assert.equal(k.execution.state, 'completed')
    assert.ok(!ops(k).includes('run.recover'))
  } finally { sweep(s); s.i.close(); s.n.close(); s.x.close() }
})

test('a lost continuation after the review completed is queued again by reconcile after a restart', { todo: 'fails before p17 ex1 steps 2–3' }, async () => {
  let s = await setup({ parent: PARENT, kid: KID })
  try {
    await child(s, [18940, 18959])
    const a = await claimOf(s)
    await presentAndPrepare(s, a.id)
    await s.x.finished(a.id, { code: 0, signal: null })
    await s.x.reviews.start(s.kid, kidRef, 'rv1', { by: ACTOR, via: 'browser' })
    await s.x.reviews.decide(s.kid, kidRef, 'rv1', { outcome: 'approved', synthetic: true }, { by: ACTOR, via: 'browser' })
    // The queue write was lost (a crash after the record).
    s.x.db.prepare('DELETE FROM jobs WHERE workspace = \'kid\' AND state = \'queued\'').run()
    s = await restart(s)
    assert.equal(open(s, 'kid').length, 0)
    await s.x.reconcile()
    assert.equal(open(s, 'kid').length, 1, 'repaired from the durable run facts')
    await s.x.reconcile()
    assert.equal(open(s, 'kid').length, 1, 'not duplicated')
  } finally { sweep(s); s.i.close(); s.n.close(); s.x.close() }
})

// No test leaves a page serving, whatever it asserted.
function sweep(s: S) {
  const pr = new Presenter({ registryFile: s.registry, area: s.area })
  try {
    for (const row of pr['all']<{ id: string; pid: number | null }>('SELECT * FROM instances')) if (row.pid && Presenter.command(row.pid).includes(row.id)) { try { process.kill(row.pid, 'SIGKILL') } catch { /* gone */ } }
  } finally { pr.close() }
}

async function claimOf(s: S) {
  const k = await rec(s.kid, kidRef)
  if (k.control.attempt) return k.control.attempt
  const c = await claim(s)
  return (await rec(s.kid, kidRef)).control.attempt ?? { id: c.attempt.id }
}
