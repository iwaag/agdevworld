// improve_wfrun p4: agent-directed execution coordination (docs/coordination.md).
// With `coordination` in workers.json, ordinary work is admitted by warden's
// decisions, not by a slot count; the coordination lane serves coordination
// runs by itself, one at a time. Covered: a job awaits a decision; start
// admits it and stands for the run's later jobs; defer waits and its wake time
// returns it; two attempts on one worker at once; a coordination turn is
// opened when something awaits, takes its events and is closed by its
// attempt's end; a stale basis applies nothing; a person's placement is not
// moved while warden's move is recorded with provenance; turns that keep
// ending without a decision stall visibly and a forced wake overrides it;
// racing decisions and claims make neither a second attempt nor lost work;
// the observation and the views say what waits for what.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { Observer } from '../server/observe.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'
import { runStatus } from '../shared/status.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-coord-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = (id: string, extra = '') => `schema: ag.workflow.v2
documentation: {policy: manual}
id: ${id}
name: ${id}
intent: |
  Do it.
${extra}repositories:
  root: {path: ., access: editable}
nodes:
  work:
    type: do
    description: Do it.
`
const COORDINATE = `schema: ag.workflow.v2
documentation: {policy: manual}
id: coordinate
name: Coordinate
intent: |
  Decide what runs where.
execution:
  agent: coordination-agent
  lane: coordination
  node: studio
intake:
  zulip: ""
repositories:
  root: {path: ., access: editable}
nodes:
  coordinate:
    type: do
    description: Look, decide, apply.
`

let n = 0
async function setup(o: { pc?: boolean } = {}) {
  const area = join(root, `area-${++n}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, `pj-c${n}`)
  const r = await createProject({ dir, id: `c${n}`, name: `C${n}`, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'long.yaml'), WF('long'))
  await writeFile(join(dir, 'devdocs', 'workflows', 'quick.yaml'), WF('quick'))
  await writeFile(join(dir, 'devdocs', 'workflows', 'front.yaml'), WF('front', 'execution:\n  lane: conversation\n'))
  await writeFile(join(dir, 'devdocs', 'workflows', 'onpc.yaml'), WF('onpc', 'execution:\n  node: pc\n'))
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflows'])
  const wdir = join(area, `pj-warden${n}`)
  const w = await createProject({ dir: wdir, id: `warden${n}`, name: `Warden${n}`, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(w.ok, w.message)
  await writeFile(join(wdir, 'devdocs', 'workflows', 'coordinate.yaml'), COORDINATE)
  await gitOk(wdir, ['add', '-A']); await gitOk(wdir, ['commit', '-q', '-m', 'coordinate'])
  await writeFile(join(area, 'pc.token'), 'secret\n')
  await writeFile(join(area, 'workers.json'), JSON.stringify({
    default: 'studio', coordination: { worker: 'studio', lane: 'coordination', workspace: `warden${n}`, workflow: 'coordinate' },
    workers: { studio: { local: true, label: 'the studio', lanes: ['conversation', 'coordination'] }, ...(o.pc === false ? {} : { pc: { label: 'the PC', tokenFile: 'pc.token' } }) },
  }))
  const x = new ExecStore({ registryFile: registry, area })
  const reg = await loadRegistry(registry)
  const ws = new Workspace(reg.workspaces.find(w => w.id === `c${n}`)!)
  const wws = new Workspace(reg.workspaces.find(w => w.id === `warden${n}`)!)
  const request = (workflow: string, receipt: string, node?: string) => x.request({ workspace: `c${n}`, workflow, text: 'Do the thing.', author: 'Test Person', receipt, via: 'browser', ...(node ? { node } : {}) })
  const rec = async (ref: { workflow: string; run: string }, space = ws) => (await readRun(await runSpace(space, ref), ref)).record!
  return { area, x, ws, wws, id: `c${n}`, wid: `warden${n}`, request, rec }
}
const OFFER = { profiles: { '': 'fake / m' } }
const claimed = async (x: ExecStore, o: Parameters<ExecStore['claim']>[2] = {}) => { const c = await x.claim('fake / m', OFFER, o); assert.ok('attempt' in c, JSON.stringify(c)); return c }
const idle = async (x: ExecStore, o: Parameters<ExecStore['claim']>[2] = {}) => { const c = await x.claim('fake / m', OFFER, o); assert.ok('idle' in c, JSON.stringify(c)); return c.idle }

test('coordination: a job awaits warden; start admits it and stands for the run; defer waits until its time; two attempts share one worker', async () => {
  const s = await setup()
  const a = await s.request('long', 'coord-req-0001')
  const b = await s.request('quick', 'coord-req-0002')
  // Nothing is claimed by itself: both await a decision, and a coordination turn is opened for them.
  const why = await idle(s.x)
  assert.match(why, /awaiting warden's coordination decision/)
  const turn = s.x.openBatch()
  assert.ok(turn && turn.state === 'open' && turn.run, JSON.stringify(turn))
  assert.equal(turn.workflow, 'coordinate')
  const view = await s.x.coordinationView()
  assert.deepEqual(view.queued.map(q => [q.run, q.admission]), [[a.ref.run, 'awaiting'], [b.ref.run, 'awaiting']])
  assert.ok(view.queued[0].basis, 'each queued job has a basis token')
  assert.deepEqual(view.events.map(e => e.kind), ['queued', 'queued'], 'the queued events are pending')
  assert.ok(view.needs.yes)
  // The coordination lane takes the coordination run without any decision; a second claim there is held.
  const c = await claimed(s.x, { lane: 'coordination' })
  assert.equal(c.ref.workflow, 'coordinate')
  assert.equal(c.lane, 'coordination')
  assert.match(await idle(s.x, { lane: 'coordination' }), /the coordination lane is held by attempt/)
  assert.equal(s.x.openBatch()?.attempt, c.attempt.id)
  // The coordination attempt takes the events and decides: start both (the long one stands for its run).
  const taken = s.x.takeEvents(c.attempt.id)
  assert.equal(taken.length, 2)
  assert.equal(s.x.pendingEvents().length, 0)
  const d1 = await s.x.decide({ action: 'start', workspace: s.id, ref: a.ref, reason: 'cpu work, nothing else runs', basis: view.queued[0].basis!, attempt: c.attempt.id, via: 'cli' })
  assert.ok(d1.applied)
  assert.equal(d1.decision.by, 'coordination-agent', 'inside the coordination attempt the decider is its agent')
  assert.equal(d1.decision.scope, 'run')
  const d2 = await s.x.decide({ action: 'start', workspace: s.id, ref: b.ref, scope: 'job', reason: 'a short question', observations: ['load 0.3'], attempt: c.attempt.id, via: 'cli' })
  assert.ok(d2.applied)
  // Both start on studio, at once: no capacity holds the second.
  const a1 = await claimed(s.x)
  const b1 = await claimed(s.x)
  assert.deepEqual([a1.ref.run, b1.ref.run].sort(), [a.ref.run, b.ref.run].sort())
  assert.equal(a1.attempt.decision, d1.decision.id)
  assert.equal(s.x.workersState().find(w => w.id === 'studio')!.slots.length, 3, 'two ordinary attempts beside the coordination one')
  assert.match(b1.brief, /sharing this execution node now: .*long\//, 'the brief says who shares the node')
  assert.doesNotMatch(b1.brief, /sharing this execution node now: .*coordinate\//, 'the coordination run is not work on the node')
  assert.match(a1.brief, /starts by decision \d+ \(coordination-agent/)
  // The coordination attempt ends: its turn closes with its decisions counted, and nothing awaits now.
  s.x.started(c.attempt.id, process.pid)
  await s.x.finished(c.attempt.id, { code: 0, signal: null })
  const turns = s.x.recentBatches(3)
  assert.equal(turns.at(-1)!.state, 'ended')
  assert.equal(turns.at(-1)!.decisions, 2)
  assert.equal(s.x.openBatch(), null, 'nothing awaits a decision: no new turn')
  // The long run waits for a person and resumes: its standing admission admits the resume job at once.
  for (const [ref, at] of [[a.ref, a1.attempt.id], [b.ref, b1.attempt.id]] as const) { s.x.started(at, process.pid) ; void ref }
  await runOp(s.ws, a.ref, { op: 'node.start', node: 'work', attempt: a1.attempt.id } as never, { by: 'autolab', via: 'exec' })
  await runOp(s.ws, a.ref, { op: 'question.ask', question: 'q1', node: 'work', text: 'Which?', to: 'Test Person', attempt: a1.attempt.id } as never, { by: 'autolab', via: 'exec' })
  await s.x.finished(a1.attempt.id, { code: 0, signal: null })
  await runOp(s.ws, a.ref, { op: 'question.answer', question: 'q1', text: 'this', from: 'Test Person' }, { by: 'Test Person', via: 'browser' })
  const resume = await s.x.afterAnswer(s.ws, a.ref, 'q1')
  assert.ok(resume)
  assert.equal(resume.decision, 'start', 'admitted by the standing decision when queued')
  assert.equal(resume.decision_id, d1.decision.id)
  assert.equal(s.x.openBatch(), null, 'a standing admission asks warden nothing')
  const a2 = await claimed(s.x)
  assert.equal(a2.ref.run, a.ref.run)
  // A later deferral of the run supersedes the standing start for its next job.
  await runOp(s.ws, a.ref, { op: 'question.take-up', question: 'q1', attempt: a2.attempt.id } as never, { by: 'autolab', via: 'exec' })
  await runOp(s.ws, a.ref, { op: 'question.ask', question: 'q2', node: 'work', text: 'And?', to: 'Test Person', attempt: a2.attempt.id } as never, { by: 'autolab', via: 'exec' })
  s.x.started(a2.attempt.id, process.pid)
  await s.x.finished(a2.attempt.id, { code: 0, signal: null })
  const past = new Date(Date.now() - 1000).toISOString()
  const d3 = await s.x.decide({ action: 'defer', workspace: s.id, ref: a.ref, reason: 'the render on this node needs the memory', reconsider: { until: past }, by: 'warden-cli', via: 'cli' })
  assert.ok(d3.applied)
  await runOp(s.ws, a.ref, { op: 'question.answer', question: 'q2', text: 'that', from: 'Test Person' }, { by: 'Test Person', via: 'browser' })
  const r2 = (await s.x.afterAnswer(s.ws, a.ref, 'q2'))!
  assert.equal(r2.decision, 'defer')
  assert.match(await idle(s.x), /deferred by warden-cli \(decision \d+\): the render on this node needs the memory; reconsidered at/)
  // Its time has come: the reconcile emits the wake event and opens a turn.
  const notes = await s.x.reconcileCoordination()
  assert.ok(notes.some(x => /deferral \d+ of .* is due/.test(x)), notes.join('\n'))
  assert.ok(s.x.pendingEvents().some(e => e.kind === 'wake'))
  assert.ok(s.x.openBatch(), 'a turn is open for the due deferral')
  assert.equal((await s.x.reconcileCoordination()).filter(x => /is due/.test(x)).length, 0, 'the wake is emitted once')
  // The status reading says what the job waits for.
  const st = runStatus(await s.rec(a.ref), { job: { state: 'queued', decision: 'defer', deferUntil: past, deferReason: d3.decision.reason } })
  assert.equal(st.label, 'Deferred')
  assert.match(st.reason, /By warden, until/)
  const c3 = await s.request('quick', 'coord-req-0003')
  const st2 = runStatus(await s.rec(c3.ref), { job: { state: 'queued', decision: null } })
  assert.equal(st2.reason, 'Awaiting warden\'s decision')
  const st3 = runStatus(await s.rec(c3.ref), { job: { state: 'queued', decision: 'start' } })
  assert.equal(st3.reason, 'Starts when its execution node next claims')
  s.x.close()
})

test('coordination: a stale basis applies nothing; a person\'s placement is kept; warden\'s move is recorded with provenance; the view shows it', async () => {
  const s = await setup()
  const a = await s.request('long', 'coord-req-0101')
  const chosen = await s.request('quick', 'coord-req-0102', 'pc') // the request named the node: a constraint
  const onpc = await s.request('onpc', 'coord-req-0103') // the workflow's node: movable
  assert.equal((await s.rec(chosen.ref)).executor.placed, 'request')
  assert.equal((await s.rec(onpc.ref)).executor.placed, 'workflow')
  const view = await s.x.coordinationView()
  const qa = view.queued.find(q => q.run === a.ref.run && q.workflow === 'long')!
  const qc = view.queued.find(q => q.workflow === 'quick')!
  assert.match(qc.constraint!, /the request named pc/)
  assert.equal(qa.constraint, null)
  // The basis changes when another attempt opens on the worker: the decision is stale, nothing applied.
  const other = await s.request('quick', 'coord-req-0104')
  await s.x.decide({ action: 'start', workspace: s.id, ref: other.ref, reason: 'go', by: 'warden-cli', via: 'cli' })
  await claimed(s.x)
  const stale = await s.x.decide({ action: 'start', workspace: s.id, ref: a.ref, reason: 'go', basis: qa.basis!, by: 'warden-cli', via: 'cli' })
  assert.equal(stale.applied, false)
  assert.equal(stale.decision.state, 'stale')
  assert.ok(stale.changed?.facts.attemptsOn, JSON.stringify(stale.changed))
  assert.equal((await s.x.runView(s.id, a.ref)).jobs[0].decision, null, 'still awaiting')
  // A person's placement is not moved; the refusal is recorded.
  await assert.rejects(s.x.decide({ action: 'start', workspace: s.id, ref: chosen.ref, worker: 'studio', reason: 'studio is idle', by: 'warden-cli', via: 'cli' }), /stays on pc: the request named pc/)
  assert.equal(s.x.decisionsOf(s.id, chosen.ref).at(-1)!.state, 'refused')
  // The workflow's node is a preference: warden moves the run and admits it; the record names who and why.
  const onpcBasis = (await s.x.coordinationView()).queued.find(q => q.workflow === 'onpc')!.basis!
  const moved = await s.x.decide({ action: 'start', workspace: s.id, ref: onpc.ref, worker: 'studio', reason: 'pc is unavailable; studio can serve it', basis: onpcBasis, by: 'warden-cli', via: 'cli' })
  assert.ok(moved.applied)
  assert.match(moved.notes.join(' '), /Moved: from its next attempt .* runs on studio \(was pc\)/)
  const r = await s.rec(onpc.ref)
  assert.equal(r.executor.node, 'studio')
  assert.equal(r.assignments!.at(-1)!.by, 'warden-cli')
  assert.match(r.assignments!.at(-1)!.reason, /^coordination: /)
  assert.equal(s.x.placementConstraint(r), null, 'warden\'s own move is no constraint')
  const c2 = await claimed(s.x)
  assert.equal(c2.ref.run, onpc.ref.run)
  assert.equal(c2.worker, 'studio')
  // After a person assigns, warden does not move it again.
  await s.x.finished(c2.attempt.id, { code: 0, signal: null })
  const held = await s.rec(onpc.ref)
  assert.ok(held.control.hold, 'ended with its work not recorded: held')
  await s.x.resume(s.ws, onpc.ref, 'Test Person', 'go on', 'browser')
  await s.x.assign(s.ws, onpc.ref, 'pc', 'Test Person', 'I want it on the PC', 'cli')
  await assert.rejects(s.x.decide({ action: 'assign', workspace: s.id, ref: onpc.ref, worker: 'studio', reason: 'pc is slow', by: 'warden-cli', via: 'cli' }), /Test Person assigned it to pc/)
  // A note reaches the next brief.
  const note = await s.x.decide({ action: 'note', workspace: s.id, ref: a.ref, reason: 'use /tmp/long-<run> for scratch; quick/run-002 shares the node', by: 'warden-cli', via: 'cli' })
  assert.ok(note.applied)
  await s.x.decide({ action: 'start', workspace: s.id, ref: a.ref, reason: 'go', by: 'warden-cli', via: 'cli' })
  const a1 = await claimed(s.x)
  assert.match(a1.brief, /note from warden-cli .*use \/tmp\/long-<run> for scratch/)
  assert.match(a1.brief, /wfe coordinate reconsider/)
  s.x.close()
})

test('coordination: turns that end without a decision stall visibly; a forced wake overrides; the observation says so', async () => {
  const s = await setup({ pc: false })
  await s.request('long', 'coord-req-0201')
  await idle(s.x)
  for (let i = 0; i < 3; i++) {
    const t = s.x.openBatch()
    assert.ok(t, `turn ${i + 1} opens`)
    const c = await claimed(s.x, { lane: 'coordination' })
    assert.equal(c.ref.run, t.run)
    s.x.started(c.attempt.id, process.pid)
    // The coordination attempt dies without deciding (a model failure): its turn ends with no decision.
    await s.x.finished(c.attempt.id, { code: 1, signal: null })
    assert.equal(s.x.recentBatches(1)[0].decisions, 0)
    if (i < 2) { await idle(s.x); assert.ok(s.x.openBatch(), 'the next turn is opened for the job still awaiting') }
  }
  await idle(s.x)
  assert.equal(s.x.openBatch(), null, 'three turns without a decision: no automatic turn now')
  const stall = s.x.coordinationStall()
  assert.ok(stall && stall.failures === 3, JSON.stringify(stall))
  const o = await new Observer(s.x, join(s.area, 'registry.json')).observe()
  assert.equal(o.coordination.configured, true)
  assert.ok(o.coordination.stalled, 'the observation reports the stall')
  assert.equal(o.coordination.awaiting, 1)
  const run = o.runs.find(r => r.identity.workflow === 'long')!
  assert.equal(run.queue.job?.admission, 'awaiting')
  assert.equal(run.waiting?.responsible, 'coordination')
  const notes = await s.x.reconcileCoordination()
  assert.ok(notes.some(x => /turns ended without a decision/.test(x)), notes.join('\n'))
  // A forced wake opens a turn regardless.
  const forced = await s.x.ensureCoordination({ force: true })
  assert.ok(forced && forced.state === 'open')
  // A turn whose run is gone (its job dropped) is closed as lost by the next look, and a fresh one follows after the stall.
  s.x.db.prepare('UPDATE jobs SET state = \'dropped\' WHERE id = ?').run(forced!.job)
  assert.equal(s.x.openBatch(), null)
  assert.equal(s.x.recentBatches(1)[0].state, 'lost')
  s.x.close()
})

test('coordination: racing decisions and claims — one attempt per run, the second decision superseded, a decision on a claimed job refused, nothing lost', async () => {
  const s = await setup({ pc: false })
  const a = await s.request('long', 'coord-req-0301')
  await idle(s.x)
  const [d1, d2] = await Promise.all([
    s.x.decide({ action: 'start', workspace: s.id, ref: a.ref, reason: 'first', by: 'w1', via: 'cli' }),
    s.x.decide({ action: 'defer', workspace: s.id, ref: a.ref, reason: 'second', by: 'w2', via: 'cli' }),
  ])
  assert.ok(d1.applied && d2.applied)
  const job = (await s.x.runView(s.id, a.ref)).jobs[0]
  const last = [d1, d2].find(d => d.decision.id === job.decision_id)!
  const first = [d1, d2].find(d => d !== last)!
  assert.equal(job.decision, last.decision.action)
  assert.equal(s.x.decisionsOf(s.id, a.ref).find(d => d.id === first.decision.id)!.state, 'superseded', 'the earlier of two decisions on one job is superseded')
  if (job.decision === 'defer') await s.x.decide({ action: 'start', workspace: s.id, ref: a.ref, reason: 'go', by: 'w1', via: 'cli' })
  // Two claims at once take the one job once.
  const results = await Promise.all([s.x.claim('fake / m', OFFER), s.x.claim('fake / m', OFFER)])
  assert.equal(results.filter(r => 'attempt' in r).length, 1, JSON.stringify(results))
  // A decision on the run while its attempt is open is refused; nothing changes.
  await assert.rejects(s.x.decide({ action: 'start', workspace: s.id, ref: a.ref, reason: 'again', by: 'w1', via: 'cli' }), /already executing/)
  // Concurrent enqueues of two runs each get one job, each awaiting.
  const [b, c] = await Promise.all([s.request('quick', 'coord-req-0302'), s.request('quick', 'coord-req-0303')])
  const jobs = s.x.queueView().jobs.filter(j => j.state === 'queued' && j.workflow !== 'coordinate')
  assert.deepEqual(jobs.map(j => [j.run, j.decision]).sort(), [[b.ref.run, null], [c.ref.run, null]].sort())
  assert.equal(s.x.pendingEvents().filter(e => e.kind === 'queued').length, 3)
  s.x.close()
})
