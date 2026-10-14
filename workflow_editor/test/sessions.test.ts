// agent_session p1: the session policy — declared beside the workflow's
// execution settings, frozen with the run, and resolved at each claim into
// a new or a resumed harness conversation recorded in run.json. The
// executor's steps are driven here directly (the daemon's own tests are in
// agautolab); nothing launches an agent.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { definitionProjection, semanticDigest } from '../shared/canonical.ts'
import { emptyWorkflow, type Workflow } from '../shared/model.ts'
import { validateWorkflow } from '../shared/validate.ts'
import { createProject } from '../server/create.ts'
import { ExecStore, type HostOffer } from '../server/exec.ts'
import { Observer } from '../server/observe.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import { newWorkflowText, parseWorkflow, renderWorkflow } from '../server/yamlDoc.ts'
import { parseDocument } from 'yaml'
import type { OpInput, RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-sessions-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = (session: string) => `schema: ag.workflow.v2
documentation: {policy: manual}
id: keep
name: Keep
intent: |
  Agree on a scope, then build it.
execution:
  guides: [agent/g.md]${session ? `\n  session: ${session}` : ''}
repositories:
  root: {path: ., access: editable}
nodes:
  scope:
    type: talk
    description: Agree on the scope with the person.
  build:
    type: do
    description: Build what was agreed.
edges:
  - {from: scope, to: build}
`
const base = (): Workflow => ({ ...emptyWorkflow('w', 'W'), intake: { zulip: '' }, intent: 'x', nodes: { a: { type: 'talk', name: '', description: 'd', repositories: [] } } })

test('model: the session policy is read, written back, validated and part of the approved definition when declared', async () => {
  const r = parseWorkflow(WF('run'))
  assert.ok(r.ok)
  assert.equal(r.model.execution.session, 'run')
  const again = parseWorkflow(newWorkflowText(r.model))
  assert.ok(again.ok)
  assert.equal(again.model.execution.session, 'run', 'survives save and reload')
  // An edit in the editor: fresh declared, then the declaration removed.
  const doc = parseDocument(WF('run'))
  const m = structuredClone(r.model); m.execution.session = 'fresh'
  assert.match(renderWorkflow(doc, m), /session: fresh/)
  delete m.execution.session
  assert.doesNotMatch(renderWorkflow(doc, m), /session:/, 'not declared = removed from the file')
  const none = parseWorkflow(WF(''))
  assert.ok(none.ok)
  assert.equal(none.model.execution.session, undefined, 'omitted stays omitted (fresh)')
  assert.doesNotMatch(newWorkflowText(none.model), /session/)
  const codes = (w: Workflow) => validateWorkflow(w).filter(i => i.severity === 'error').map(i => i.code)
  assert.deepEqual(codes({ ...base(), execution: { agent: '', profile: '', guides: [], session: 'forever' } }), ['execution-session'])
  assert.deepEqual(codes({ ...base(), execution: { agent: '', profile: '', guides: [], session: 'run' } }), [])
  const w = base()
  const digest = await semanticDigest('definition', w)
  assert.ok(!('execution' in (definitionProjection(w) as Record<string, unknown>)), 'a workflow without settings keeps its projection')
  assert.notEqual(await semanticDigest('definition', { ...w, execution: { agent: '', profile: '', guides: [], session: 'run' } }), digest, 'changing the policy stales the approval')
})

let n = 0
async function setup(session: string) {
  const area = join(root, `area-${++n}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, `pj-s${n}`)
  const r = await createProject({ dir, id: `s${n}`, name: `S${n}`, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'keep.yaml'), WF(session))
  await mkdir(join(dir, 'agent'))
  await writeFile(join(dir, 'agent', 'g.md'), '# guide\nFact one.\n')
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remotes', `pj-s${n}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote])
  await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  const x = new ExecStore({ registryFile: registry, area })
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  return { x, ws, dir }
}
const OFFER: HostOffer = { profiles: { sonnet: 'claude_code / anthropic/claude-sonnet-5' }, contract: { name: 'wfrun/guide.md', sha256: 'a'.repeat(64) }, sessions: { sonnet: 'explicit', '': 'explicit' } }
const report = (ws: Workspace, ref: RunRef, attempt: string, op: OpInput) => runOp(ws, ref, { ...op, attempt }, { by: 'autolab', via: 'cli' })
const record = async (ws: Workspace, ref: RunRef) => (await readRun(ws, ref)).record!
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function claim(x: ExecStore, offer: HostOffer = OFFER) {
  const c = await x.claim('claude_code / anthropic/claude-sonnet-5', offer)
  assert.ok('attempt' in c, JSON.stringify(c))
  return c as Exclude<typeof c, { idle: string }>
}
// One attempt that asks and ends normally (the process exits during the wait).
async function askAndEnd(x: ExecStore, ws: Workspace, ref: RunRef, c: Awaited<ReturnType<typeof claim>>) {
  x.started(c.attempt.id, process.pid)
  await report(ws, ref, c.attempt.id, { op: 'node.start', node: 'scope' })
  await report(ws, ref, c.attempt.id, { op: 'question.ask', question: '', node: 'scope', text: 'Small or large?', to: 'Test Person' })
  await x.finished(c.attempt.id, { code: 0, signal: null })
}

test('run policy: a new session under a minted id, resumed by that id after the answer; another run has its own', async () => {
  const { x, ws } = await setup('run')
  const req = await x.request({ workspace: ws.reg.id, workflow: 'keep', text: 'Build.', author: 'Test Person', receipt: 'sess-req-0001', via: 'browser' })
  const space = await runSpace(ws, req.ref)
  const c1 = await claim(x)
  assert.equal(c1.execution.session?.mode, 'new')
  assert.match(c1.execution.session?.id ?? '', UUID)
  const sid = c1.execution.session!.id!
  let rec = await record(space, req.ref)
  assert.deepEqual(rec.control.attempt?.settings?.session, { policy: 'run', mode: 'new', id: sid }, 'recorded before launch')
  await x.session(c1.attempt.id, { attached: sid })
  await askAndEnd(x, space, req.ref, c1)
  rec = await record(space, req.ref)
  assert.equal(rec.sessions?.[0].attached, sid)
  await runOp(space, req.ref, { op: 'question.answer', question: 'q1', text: 'Small.', from: 'Test Person' }, { by: 'Test Person', via: 'cli' })
  assert.ok(await x.afterAnswer(space, req.ref, 'q1'))
  // Observation (Observer's read): during the wait no process runs; the
  // record still names the run's retained session.
  const observer = new Observer(x, x.ctx.registryFile)
  const waiting = (await observer.observe()).runs.find(o => o.identity.run === req.ref.run)!
  assert.equal(waiting.situation, 'awaiting-person')
  assert.deepEqual(waiting.session && { policy: waiting.session.policy, id: waiting.session.current?.id, attempts: waiting.session.current?.attempts.length }, { policy: 'run', id: sid, attempts: 1 })
  assert.equal(waiting.process?.alive, false, 'a retained session is not a live process')
  const c2 = await claim(x)
  assert.deepEqual(c2.execution.session, { policy: 'run', mode: 'resume', id: sid })
  const running = (await observer.observe()).runs.find(o => o.identity.run === req.ref.run)!
  assert.deepEqual(running.process?.session, { id: sid, resumed: true }, 'the attempt\'s session comes from the record')
  assert.equal(running.process?.attempt, c2.attempt.id, 'activity stays scoped to the current attempt')
  rec = await record(space, req.ref)
  assert.deepEqual(rec.sessions?.map(s => [s.id, s.state, s.attempts]), [[sid, 'open', [c1.attempt.id, c2.attempt.id]]])
  // Stale attempt references cannot write session facts either.
  await assert.rejects(x.session(c1.attempt.id, { attached: sid }), (e: unknown) => e instanceof RequestError && /not open/.test(e.message))
  await report(space, req.ref, c2.attempt.id, { op: 'question.take-up', question: 'q1' })
  await report(space, req.ref, c2.attempt.id, { op: 'node.complete', node: 'scope', outcome: 'small' })
  await report(space, req.ref, c2.attempt.id, { op: 'node.start', node: 'build' })
  await report(space, req.ref, c2.attempt.id, { op: 'node.complete', node: 'build', outcome: 'built' })
  await x.finished(c2.attempt.id, { code: 0, signal: null })
  const other = await x.request({ workspace: ws.reg.id, workflow: 'keep', text: 'Again.', author: 'Test Person', receipt: 'sess-req-0002', via: 'browser' })
  const c3 = await claim(x)
  assert.equal(c3.ref.run, other.ref.run)
  assert.equal(c3.execution.session?.mode, 'new')
  assert.notEqual(c3.execution.session?.id, sid, 'an independent run never inherits a session')
  x.close()
})

test('fresh policy (and an undeclared one): every attempt a new session; run on an incapable profile is refused, never fresh', async () => {
  {
    const { x, ws } = await setup('')
    const req = await x.request({ workspace: ws.reg.id, workflow: 'keep', text: 'Build.', author: 'Test Person', receipt: 'sess-req-0003', via: 'browser' })
    const space = await runSpace(ws, req.ref)
    const c1 = await claim(x)
    assert.equal(c1.execution.session?.policy, 'fresh')
    await askAndEnd(x, space, req.ref, c1)
    await runOp(space, req.ref, { op: 'question.answer', question: 'q1', text: 'Small.', from: 'Test Person' }, { by: 'Test Person', via: 'cli' })
    await x.afterAnswer(space, req.ref, 'q1')
    const c2 = await claim(x)
    assert.equal(c2.execution.session?.mode, 'new')
    assert.notEqual(c2.execution.session?.id, c1.execution.session?.id)
    const rec = await record(space, req.ref)
    assert.deepEqual(rec.sessions?.map(s => s.state), ['replaced', 'open'])
    assert.match(rec.sessions![0].ended!.reason, /fresh policy/)
    x.close()
  }
  {
    const { x, ws } = await setup('run')
    const req = await x.request({ workspace: ws.reg.id, workflow: 'keep', text: 'Build.', author: 'Test Person', receipt: 'sess-req-0004', via: 'browser' })
    assert.deepEqual(await x.claim('fake', { ...OFFER, sessions: {} }), { idle: 'no queued job' })
    const job = (await x.runView(ws.reg.id, req.ref)).jobs[0]
    assert.equal(job.state, 'dropped')
    assert.match(job.note ?? '', /session policy is "run", but the host's default profile .* keeps no conversation/)
    assert.equal((await record(await runSpace(ws, req.ref), req.ref)).control.attempts, 0)
    x.close()
  }
})

test('replacement: a changed guide, a retirement and a missing conversation each start a new session with the reason recorded', async () => {
  const { x, ws } = await setup('run')
  const req = await x.request({ workspace: ws.reg.id, workflow: 'keep', text: 'Build.', author: 'Test Person', receipt: 'sess-req-0005', via: 'browser' })
  const space = await runSpace(ws, req.ref)
  const c1 = await claim(x)
  await askAndEnd(x, space, req.ref, c1)
  await writeFile(join(space.root, 'agent', 'g.md'), '# guide\nFact two.\n')
  await runOp(space, req.ref, { op: 'question.answer', question: 'q1', text: 'Small.', from: 'Test Person' }, { by: 'Test Person', via: 'cli' })
  await x.afterAnswer(space, req.ref, 'q1')
  const c2 = await claim(x)
  assert.equal(c2.execution.session?.mode, 'new')
  assert.match(c2.execution.session?.replaces?.reason ?? '', /configuration changed: guide agent\/g\.md changed/)
  // The attempt is interrupted (build left running); resumed, its session is missing on the host: replaced before launch.
  x.started(c2.attempt.id, process.pid)
  await report(space, req.ref, c2.attempt.id, { op: 'question.take-up', question: 'q1' })
  await report(space, req.ref, c2.attempt.id, { op: 'node.complete', node: 'scope', outcome: 'small' })
  await report(space, req.ref, c2.attempt.id, { op: 'node.start', node: 'build' })
  await x.finished(c2.attempt.id, { code: 0, signal: null })
  let rec = await record(space, req.ref)
  assert.equal(rec.control.hold?.kind, 'interrupted')
  await x.resume(space, req.ref, 'Test Person', 'continue', 'cli')
  const c3 = await claim(x)
  assert.deepEqual(c3.execution.session, { policy: 'run', mode: 'resume', id: c2.execution.session!.id })
  const got = await x.session(c3.attempt.id, { missing: 'no transcript' })
  assert.equal(got.event, 'replaced')
  rec = await record(space, req.ref)
  assert.deepEqual(rec.sessions?.map(s => s.state), ['replaced', 'replaced', 'open'])
  assert.match(rec.sessions![1].ended!.reason, /is missing on .*nothing ran in it/)
  assert.deepEqual(rec.sessions![1].attempts, [c2.attempt.id], 'the attempt moved to the new session')
  assert.deepEqual(rec.sessions![2].attempts, [c3.attempt.id])
  assert.equal(rec.control.attempt?.settings?.session?.mode, 'new')
  assert.equal(rec.control.attempt?.settings?.session?.id, got.id)
  // A repeated report is the same replacement, not another one.
  x.started(c3.attempt.id, process.pid)
  await x.session(c3.attempt.id, { attached: got.id! })
  assert.deepEqual(await x.session(c3.attempt.id, { missing: 'again' }), got)
  assert.equal((await record(space, req.ref)).sessions!.length, 3)
  // Retirement waits for the attempt to end; then a new session is chosen.
  await assert.rejects(x.retireSession(space, req.ref, 'Test Person', 'clean start', 'cli'), (e: unknown) => e instanceof RequestError && /retired between attempts|still lives/.test(e.message))
  await report(space, req.ref, c3.attempt.id, { op: 'node.complete', node: 'build', outcome: 'built' })
  await x.finished(c3.attempt.id, { code: 0, signal: null })
  // x.started recorded this test process as the attempt's pid: it lives, so
  // the host refuses — one writer per conversation. Forget the pid to go on.
  await assert.rejects(x.retireSession(space, req.ref, 'Test Person', 'clean start', 'cli'), (e: unknown) => e instanceof RequestError && /still lives/.test(e.message))
  x.db.prepare('UPDATE attempts SET pid = NULL').run()
  await x.retireSession(space, req.ref, 'Test Person', 'clean start', 'cli')
  rec = await record(space, req.ref)
  assert.equal(rec.sessions!.at(-1)!.state, 'retired')
  const next = x.sessionFor(rec, { agent: 'autolab', profile: null, backend: 'claude_code / anthropic/claude-sonnet-5', guides: [] }, 'run', OFFER)
  assert.ok(!('refused' in next) && next.mode === 'new')
  assert.match((next as { replaces?: { reason: string } }).replaces?.reason ?? '', /^retired: clean start/)
  x.close()
})

test('reducer: a resume must name the current session; a new session never reuses an id', async () => {
  const { x, ws } = await setup('run')
  const req = await x.request({ workspace: ws.reg.id, workflow: 'keep', text: 'Build.', author: 'Test Person', receipt: 'sess-req-0006', via: 'browser' })
  const space = await runSpace(ws, req.ref)
  const settings = { agent: 'autolab', profile: null, backend: null, contract: null, guides: [] }
  await assert.rejects(runOp(space, req.ref, { op: 'attempt.begin', attempt: 'a1-x', reason: 'start', settings: { ...settings, session: { policy: 'run', mode: 'resume', id: 'nope' } } }, { by: 'autolab', via: 'exec' }),
    (e: unknown) => e instanceof RequestError && /session-mismatch|current session is none/.test(e.message))
  await runOp(space, req.ref, { op: 'attempt.begin', attempt: 'a1-y', reason: 'start', settings: { ...settings, session: { policy: 'run', mode: 'new', id: 's-1' } } }, { by: 'autolab', via: 'exec' })
  await runOp(space, req.ref, { op: 'attempt.end', attempt: 'a1-y', outcome: 'exited' }, { by: 'autolab', via: 'exec' })
  await assert.rejects(runOp(space, req.ref, { op: 'attempt.begin', attempt: 'a2-y', reason: 'resume', settings: { ...settings, session: { policy: 'run', mode: 'new', id: 's-1' } } }, { by: 'autolab', via: 'exec' }),
    (e: unknown) => e instanceof RequestError && /already belongs to this run/.test(e.message))
  x.close()
})

test('mismatch (p1 ex1): the attempt ends interrupted with both ids kept; claim, resume and recover refuse the session until it is retired', async () => {
  const { x, ws } = await setup('run')
  const req = await x.request({ workspace: ws.reg.id, workflow: 'keep', text: 'Build.', author: 'Test Person', receipt: 'sess-req-0007', via: 'browser' })
  const space = await runSpace(ws, req.ref)
  const c1 = await claim(x)
  const intended = c1.execution.session!.id!
  x.started(c1.attempt.id, process.pid)
  // The host stops the attempt and reports the harness's id with its end.
  await x.finished(c1.attempt.id, { code: null, signal: 'SIGTERM', interrupted: `session mismatch: launched in session ${intended}, the harness reported other-1`, attached: 'other-1' })
  let rec = await record(space, req.ref)
  assert.deepEqual([rec.sessions![0].id, rec.sessions![0].attached, rec.sessions![0].mismatch, rec.sessions![0].state], [intended, 'other-1', true, 'open'])
  assert.equal(rec.control.hold?.kind, 'interrupted')
  assert.match(rec.control.hold!.reason, /session mismatch.*signal SIGTERM/)
  const refusal = (e: unknown) => e instanceof RequestError && /unverified.*--retire/.test(e.message)
  x.db.prepare('UPDATE attempts SET pid = NULL').run() // this test process stood in for the attempt's pid
  await assert.rejects(x.resume(space, req.ref, 'Test Person', 'go on', 'cli'), refusal)
  await assert.rejects(x.recover(space, req.ref, { incident: 'i-1', attempt: c1.attempt.id, reason: 'looked', by: 'Observer', via: 'cli' }), refusal)
  // Claim's own choice refuses it too (a held run's job is dropped earlier, for the hold).
  const choice = x.sessionFor(rec, { agent: 'autolab', profile: null, backend: 'claude_code / anthropic/claude-sonnet-5', guides: [] }, 'run', OFFER)
  assert.ok('refused' in choice)
  assert.match(choice.refused, /unverified.*wfe run session keep\/run-001 --retire/)
  // Retired after a look: a recovery is permitted and starts a new session.
  await x.retireSession(space, req.ref, 'Observer', 'looked: nothing ran', 'cli')
  assert.equal((await record(space, req.ref)).control.hold?.kind, 'interrupted', 'retiring lifts no hold')
  await x.recover(space, req.ref, { incident: 'i-1', attempt: c1.attempt.id, reason: 'session retired', by: 'Observer', via: 'cli' })
  const c2 = await claim(x)
  assert.equal(c2.execution.session?.mode, 'new')
  assert.notEqual(c2.execution.session?.id, intended)
  assert.match(c2.execution.session?.replaces?.reason ?? '', /^retired: looked: nothing ran/)
  rec = await record(space, req.ref)
  assert.deepEqual(rec.sessions!.map(s => [s.state, !!s.mismatch]), [['retired', true], ['open', false]], 'the mismatch stays on the retired session')
  x.close()
})

test('mismatch under fresh: the attempt is held, but nothing resumes that session, so resuming is not refused', async () => {
  const { x, ws } = await setup('fresh')
  const req = await x.request({ workspace: ws.reg.id, workflow: 'keep', text: 'Build.', author: 'Test Person', receipt: 'sess-req-0008', via: 'browser' })
  const space = await runSpace(ws, req.ref)
  const c1 = await claim(x)
  x.started(c1.attempt.id, process.pid)
  await x.session(c1.attempt.id, { attached: 'other-2' })
  await x.finished(c1.attempt.id, { code: 0, signal: null, interrupted: 'session mismatch: test' })
  assert.equal((await record(space, req.ref)).control.hold?.kind, 'interrupted', 'an exit 0 the host interrupted still holds')
  await x.resume(space, req.ref, 'Test Person', 'looked', 'cli')
  x.db.prepare('UPDATE attempts SET pid = NULL').run()
  const c2 = await claim(x)
  assert.equal(c2.execution.session?.mode, 'new')
  x.close()
})
