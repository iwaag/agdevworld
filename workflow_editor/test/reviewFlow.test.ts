// workflow_editor p17 step 5: the deferred human review end to end, through
// the executor, the notifier and the intake. The parent's agent accepts the
// child's work itself and the child's page is stopped (fix6 trial A's
// shape); the parent prepares a human review, ends its attempt and frees its
// slot; the person starts it once, requests a change; the parent is
// continued once, asks the same child again although it had judged the
// result satisfied, and prepares a new round; the person approves and every
// instance either round started is stopped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Presenter } from '../server/present.ts'
import { ConversationStore } from '../server/conversations.ts'
import { adjustRun, readRun, registerPresentation, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { situation } from '../shared/run.ts'
import { runStatus } from '../shared/status.ts'
import { KID_STREAM, as, claim, delegationSuite, rec, setup, type S } from './delegateFixture.ts'

delegationSuite('wfe-reviewflow-')

const PARENT = `schema: ag.workflow.v2
id: use
name: Use an asset
intent: |
  Get a figure made and hand it to the person.
documentation: {policy: manual}
execution: {agent: par-agent}
intake: {zulip: requests}
repositories:
  root: {path: ., access: editable}
nodes:
  asset:
    type: delegate
    description: Ask the kid project for the figure.
    project: kid
    workflow: make
    accepts: parent
  review:
    type: review
    name: Human review
    description: The person reviews the figure.
edges:
  - {from: asset, to: review}
`
const KID = `schema: ag.workflow.v2
id: make
name: Make
intent: |
  Make what is asked and present it.
documentation: {policy: manual}
execution: {agent: kid-agent}
intake: {zulip: requests}
repositories:
  root: {path: ., access: editable}
nodes:
  build:
    type: do
    description: Build and present it.
edges: []
`
const kidRef = { workflow: 'make', run: 'run-001' }
const jobs = (s: S) => (s.x.db.prepare('SELECT * FROM jobs WHERE state IN (\'queued\', \'claimed\')').all() as { workspace: string; run: string; receipt: string }[])
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

test('a room discovers a delegated child review before the child completes, deduplicates linked children and retains completed rounds', async () => {
  const s = await setup({ parent: PARENT, kid: KID.replace('edges: []', '  review:\n    type: review\n    description: Review the figure.\nedges:\n  - {from: build, to: review}') })
  await writeFile(join(s.area, 'present.json'), JSON.stringify({ ports: [18830, 18849], answerBase: 'http://localhost:8093/wfe/' }))
  const cs = new ConversationStore({ area: s.area, exec: s.x })
  try {
    const { ref } = await s.x.request({ workspace: 'par', workflow: 'use', text: 'A figure.', author: 'Pat', receipt: 'room-child-review', via: 'browser' })
    const p = await claim(s)
    await as(s.par, ref, p.attempt.id, 'par-agent')({ op: 'node.start', node: 'asset' })
    await s.x.delegate.dispatch(s.par, ref, 'asset', { request: 'Make a figure.', attempt: p.attempt.id, by: 'par-agent', via: 'cli' })
    await s.x.finished(p.attempt.id, { code: 0, signal: null })
    await s.zulip.cycle()
    const k = await claim(s)
    await present(s, k.attempt.id, 'build', 1, 'a figure for the person')
    await s.x.reviews.prepare(s.kid, kidRef, 'review', { summary: 'Please check the figure.', subjects: ['p1'] }, { by: 'kid-agent', via: 'cli', attempt: k.attempt.id })
    await s.x.finished(k.attempt.id, { code: 0, signal: null })
    const keys = [{ key: 'par/use/run-001', relation: 'turn' }]
    assert.equal((await cs.runEntries(keys)).length, 1, 'other readers retain direct-run behavior')
    const view = await cs.runEntries(keys, 'http://localhost/wfe/', true)
    assert.equal(view.length, 2)
    const child = view.find(r => r.key === 'kid/make/run-001')!
    assert.equal(child.reviews![0].state, 'awaiting')
    assert.match(child.reviews![0].page!, /kid\/review\/make\/run-001\/rv1/)
    assert.match(child.relation, /delegated by par\/use\/run-001/)
    assert.equal((await cs.runEntries([...keys, { key: child.key, relation: 'linked' }], undefined, true)).filter(r => r.key === child.key).length, 1)
    await s.x.reviews.start(s.kid, kidRef, 'rv1', { by: 'Pat', via: 'browser' })
    await s.x.reviews.decide(s.kid, kidRef, 'rv1', { outcome: 'approved' }, { by: 'Pat', via: 'browser' })
    assert.equal((await cs.runEntries(keys, undefined, true)).find(r => r.key === child.key)!.reviews![0].state, 'complete', 'the room keeps the review history after approval')
  } finally { cs.close(); s.i.close(); s.n.close(); s.x.close() }
})

// The child builds a page, presents it, starts and stops it (its own look),
// and completes.
async function present(s: S, attempt: string, node: string, n: number, text: string) {
  const kid = as(s.kid, kidRef, attempt, 'kid-agent')
  await kid({ op: 'node.start', node })
  const space = await runSpace(s.kid, kidRef)
  await mkdir(join(space.root, 'page'), { recursive: true })
  await writeFile(join(space.root, 'page', 'index.html'), `<p>${text}</p>`)
  await writeFile(join(space.root, 'page', 'review.md'), `# Figure ${n}\n`)
  await registerPresentation(s.kid, kidRef, { node, source: 'page', entry: 'index.html', review: 'page/review.md', title: `Figure ${n}` }, { by: 'kid-agent', via: 'cli', attempt, advice: { yes: true } })
  const pr = new Presenter({ registryFile: s.registry, area: s.area, by: 'kid-agent' })
  try { await pr.start(s.kid, kidRef, `p${n}`); await pr.stop(s.kid, kidRef, `p${n}`) } finally { pr.close() }
  await kid({ op: 'node.complete', node, outcome: `figure ${n} made and presented` })
}

test('deferred human review: prepared without a waiting process, one start, changes requested and answered by the same child, a new round approved, every instance stopped', async () => {
  const s = await setup({ parent: PARENT, kid: KID })
  await writeFile(join(s.area, 'present.json'), JSON.stringify({ ports: [18800, 18829], answerBase: 'http://localhost:8093/wfe/' }))
  const { ref } = await s.x.request({ workspace: 'par', workflow: 'use', text: 'I need a torus figure.', author: 'Pat', receipt: 'person-request-1', via: 'browser' })
  const a1 = await claim(s)
  await as(s.par, ref, a1.attempt.id, 'par-agent')({ op: 'node.start', node: 'asset' })
  await s.x.delegate.dispatch(s.par, ref, 'asset', { request: 'Make a torus figure and present it.', attempt: a1.attempt.id, by: 'par-agent', via: 'cli' })
  await s.x.finished(a1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const k1 = await claim(s)
  assert.deepEqual(k1.ref, kidRef)
  await present(s, k1.attempt.id, 'build', 1, 'a torus')
  await s.x.finished(k1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()

  // The parent's agent judges it itself and prepares the deferred review.
  const a2 = await claim(s)
  const par2 = as(s.par, ref, a2.attempt.id, 'par-agent')
  await par2({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  await s.x.delegate.dispose(s.par, ref, 'd1', { disposition: 'satisfied', note: 'Looks right; page stopped after my look.', yes: true }, { by: 'par-agent', via: 'cli', attempt: a2.attempt.id })
  await par2({ op: 'node.complete', node: 'asset', outcome: 'figure 1 judged satisfied' })
  const prep = await s.x.reviews.prepare(s.par, ref, 'review', { summary: 'トーラスの図です。陰影を確認してください。', subjects: ['d1'] }, { by: 'par-agent', via: 'cli', attempt: a2.attempt.id })
  assert.equal(prep.round.subjects[0].presentation, 'p1')
  assert.equal(prep.round.subjects[0].result?.event, 1)
  await s.x.finished(a2.attempt.id, { code: 0, signal: null })
  let p = await rec(s.par, ref)
  assert.equal(p.control.hold, null, 'a normal end: the review needs no process')
  assert.equal(situation(p), 'awaiting-review')
  assert.equal(runStatus(p, { job: null }).text, 'Work complete · Awaiting human review', 'not stalled, though nothing is queued')
  assert.equal(jobs(s).length, 0, 'the slot is free and nothing is queued for the review')
  await s.x.reconcile()
  assert.equal(jobs(s).length, 0, 'reconcile queues nothing for a person\'s review: no executor churn')

  // One Start review serves the child's completed, stopped page again.
  const st = await s.x.reviews.start(s.par, ref, 'rv1', { by: 'Pat', via: 'browser' })
  assert.equal(st.round.state, 'reviewing', JSON.stringify(st.round.serving))
  const pid1 = new Presenter({ registryFile: s.registry, area: s.area }).row(st.round.serving[0].instance!)!.pid!
  assert.ok(alive(pid1))
  // The person asks for a change (an identified check actor here).
  await s.x.reviews.decide(s.par, ref, 'rv1', { outcome: 'changes', feedback: 'Make the torus blue.', synthetic: true }, { by: 'flow-check', via: 'cli' })
  p = await rec(s.par, ref)
  assert.equal(p.reviews!.rv1.state, 'changes-requested')
  assert.equal(p.execution.state, 'in-progress', 'the run is not complete')
  assert.equal(jobs(s).filter(j => j.receipt.startsWith('review:')).length, 1, 'one continuation queued')
  await s.x.reconcile()
  assert.equal(jobs(s).length, 1, 'still one: reconcile finds the same receipt')

  // The parent is continued with the feedback, reopens the same child.
  const a3 = await claim(s)
  assert.deepEqual(a3.ref, ref)
  assert.match(a3.brief, /requested changes at .*: Make the torus blue\./)
  assert.match(a3.brief, /--follow-up rv1/)
  const par3 = as(s.par, ref, a3.attempt.id, 'par-agent')
  await par3({ op: 'review.take-up', review: 'rv1', note: 'asking the child again' } as never)
  // The child's result was accepted before (a historical fact bound to its tree).
  await runOp(s.kid, kidRef, { op: 'run.decide', decision: 'accepted', evidence: 'par-agent judged it' } as never, { by: 'par-agent', via: 'cli' })
  const rv = await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'Make the torus blue (the person\'s review rv1).', reason: 'The person requested a change in human review rv1.', followUp: 'rv1' }, { by: 'par-agent', via: 'cli', attempt: a3.attempt.id, receipt: 'follow-up-1' })
  assert.equal(rv.record.delegations!.d1.reopened?.[0].disposition.kind, 'satisfied')
  assert.equal(rv.record.nodes.asset.state, 'waiting')
  assert.equal(rv.record.reviews!.rv1.continuation!.addressed?.how, 'work')
  await s.x.finished(a3.attempt.id, { code: 0, signal: null })
  assert.equal((await rec(s.par, ref)).control.hold, null)
  // Delivery with a lost acknowledgment once; the child is corrected once.
  await s.zulip.deliver({ lose: ev => ev.some(x => x.includes(':delegation-revision@')) })
  await s.zulip.receive()
  await s.zulip.cycle()
  assert.equal(s.zulip.posts.filter(x => x.streamId === KID_STREAM && x.content.includes('Result returned for correction')).length, 1)
  const kc = await rec(s.kid, kidRef)
  assert.deepEqual(Object.keys(kc.corrections ?? {}), ['c1'])
  const k2 = await claim(s)
  assert.deepEqual(k2.ref, kidRef)
  const space = await runSpace(s.kid, kidRef)
  const def = (await (await import('node:fs/promises')).readFile(join(space.root, 'devdocs/runs/make/run-001/definition/make.yaml'), 'utf8'))
  const adj = await adjustRun(s.kid, kidRef, { text: def.replace('edges: []', '  blue:\n    type: do\n    description: Make it blue and present it.\nedges:\n  - {from: build, to: blue}'), reason: 'correction c1', source: { kind: 'agent' } }, { by: 'kid-agent', via: 'cli', attempt: k2.attempt.id })
  assert.ok(adj.ok, JSON.stringify(adj.problems))
  await present(s, k2.attempt.id, 'blue', 2, 'a blue torus')
  await s.x.finished(k2.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()

  // The corrected result comes back; a new round of its new page.
  const a4 = await claim(s)
  assert.deepEqual(a4.ref, ref)
  const par4 = as(s.par, ref, a4.attempt.id, 'par-agent')
  p = await rec(s.par, ref)
  const result2 = p.delegations!.d1.events.filter(e => e.type === 'completed').at(-1)!
  await par4({ op: 'delegation.take-up', delegation: 'd1', events: [result2.n] } as never)
  await s.x.delegate.dispose(s.par, ref, 'd1', { disposition: 'satisfied', note: 'Blue now.', yes: true }, { by: 'par-agent', via: 'cli', attempt: a4.attempt.id })
  await par4({ op: 'node.complete', node: 'asset', outcome: 'figure 2 judged satisfied' })
  const pspace = await runSpace(s.par, ref)
  const pdef = p.definition.active ? `definition/${p.definition.active}/use.yaml` : 'definition/use.yaml'
  const ptext = await (await import('node:fs/promises')).readFile(join(pspace.root, 'devdocs/runs/use/run-001', pdef), 'utf8')
  const adjp = await adjustRun(s.par, ref, { text: ptext.replace('edges:', '  review-2:\n    type: review\n    name: Human review\n    description: The person reviews the blue torus.\nedges:\n  - {from: asset, to: review-2}'), reason: 'a new review of the corrected figure', source: { kind: 'agent' } }, { by: 'par-agent', via: 'cli', attempt: a4.attempt.id })
  assert.ok(adjp.ok, JSON.stringify(adjp.problems))
  const prep2 = await s.x.reviews.prepare(s.par, ref, 'review-2', { summary: '青いトーラスです。', subjects: ['d1'] }, { by: 'par-agent', via: 'cli', attempt: a4.attempt.id })
  assert.equal(prep2.round.subjects[0].presentation, 'p2', 'the corrected output, frozen anew')
  assert.equal(prep2.round.previous, 'rv1')
  await s.x.finished(a4.attempt.id, { code: 0, signal: null })
  assert.equal(situation(await rec(s.par, ref)), 'awaiting-review')

  // An old browser cannot approve the closed round; the new round is approved.
  await assert.rejects(s.x.reviews.decide(s.par, ref, 'rv1', { outcome: 'approved' }, { by: 'Pat', via: 'browser' }), /already decided/)
  const st2 = await s.x.reviews.start(s.par, ref, 'rv2', { by: 'Pat', via: 'browser' })
  assert.equal(st2.round.state, 'reviewing')
  const pid2 = new Presenter({ registryFile: s.registry, area: s.area }).row(st2.round.serving[0].instance!)!.pid!
  const d2 = await s.x.reviews.decide(s.par, ref, 'rv2', { outcome: 'approved', revisions: [prep2.round.subjects[0].revision] }, { by: 'Pat', via: 'browser' })
  assert.equal(d2.round.state, 'complete', JSON.stringify(d2.round.cleanup))
  p = await rec(s.par, ref)
  assert.equal(p.reviews!.rv1.cleanup!.state, 'done', 'what rv1 handed over and nobody stopped went with the approval')
  assert.ok(!alive(pid1) && !alive(pid2), 'no review instance is left serving')
  assert.equal(p.execution.state, 'completed')
  assert.equal(jobs(s).length, 0, 'a final review completes the run on the host: no agent turn (p17 ex1)')
  await s.x.reconcile()
  assert.equal(jobs(s).length, 0)
  const kid = (await readRun(await runSpace(s.kid, kidRef), kidRef)).record!
  assert.equal(kid.presentations!.p1.state, 'stopped')
  assert.equal(kid.presentations!.p2.state, 'stopped')
  assert.equal(kid.decisions[0].decision, 'accepted', 'the earlier acceptance stays a historical fact')
  assert.equal(p.reviews!.rv1.decision!.synthetic, true)
  assert.equal(p.reviews!.rv2.decision!.by, 'Pat')
  s.i.close(); s.n.close(); s.x.close()
})
