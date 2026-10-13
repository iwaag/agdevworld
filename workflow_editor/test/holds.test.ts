// p9 step 3: holds that reserve nothing, and who recorded them. The main
// sequence — A held with its plan and unfinished work, B runs in the same
// project, A resumes in its own copy with its plan and files — is repeated
// with an answer wait, a running process, an interrupted save and a
// restart of the execution host. The executor's steps are driven directly,
// as in test/exec.test.ts; the agent's CLI calls go through `wfe` itself.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../cli/wfe.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { git, gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runOp } from '../server/runs.ts'
import { Workspace } from '../server/workspace.ts'
import type { OpInput, RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-holds-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

// The default policy: a plan talk, the work, its report, the final report.
const WF = `schema: ag.workflow.v2
documentation: {policy: default}
id: exp
name: Experiment
intent: |
  Plan an experiment with the person, then run it.
execution: {agent: lab-agent}
repositories:
  root: {path: ., access: editable}
nodes:
  run:
    type: do
    description: Run the agreed experiment.
edges: []
`

let n = 0
async function setup() {
  const area = join(root, `area-${++n}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, `pj-lab${n}`)
  const id = `lab${n}`
  const r = await createProject({ dir, id, name: `Lab ${n}`, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'exp.yaml'), WF)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remote.git')
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote]); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  return { area, registry, dir, remote, ws, id, x: new ExecStore({ registryFile: registry, area }) }
}
type S = Awaited<ReturnType<typeof setup>>

const request = (s: S, receipt: string, text = 'Run the experiment.') => s.x.request({ workspace: s.id, workflow: 'exp', text, author: 'Test Person', receipt, via: 'browser' })
const claimed = async (x: ExecStore) => { const c = await x.claim('test-harness'); assert.ok('attempt' in c, JSON.stringify(c)); x.started(c.attempt.id, process.pid); return c as Exclude<typeof c, { idle: string }> }
const report = (s: S, ref: RunRef, attempt: string, op: OpInput) => runOp(s.ws, ref, { ...op, attempt }, { by: 'lab-agent', via: 'cli' })
const record = async (s: S, ref: RunRef) => (await readRun(s.ws, ref)).record!
const exists = (p: string) => stat(p).then(() => true, () => false)
// The agent's own CLI call, inside its attempt (WFE_ATTEMPT), from its copy.
async function agentCli(s: S, attempt: string, cwd: string, args: string[]): Promise<{ code: number; err: string }> {
  const prev = { env: process.env.WFE_ATTEMPT, cwd: process.cwd(), log: console.log, error: console.error }
  const err: string[] = []
  process.env.WFE_ATTEMPT = attempt
  console.log = () => {}
  console.error = (...m: unknown[]) => { err.push(m.join(' ')) }
  try {
    process.chdir(cwd)
    return { code: await main([...args, '--registry', s.registry, '--area', s.area]), err: err.join('\n') }
  } finally {
    if (prev.env === undefined) delete process.env.WFE_ATTEMPT; else process.env.WFE_ATTEMPT = prev.env
    process.chdir(prev.cwd); console.log = prev.log; console.error = prev.error
  }
}

// Run A up to a planned question: plan.md written, q1 asked, the process gone.
async function planned(s: S) {
  const a = await request(s, `req-a-planned-${n}`)
  const c = await claimed(s.x)
  await report(s, a.ref, c.attempt.id, { op: 'node.start', node: '_plan' })
  await writeFile(join(c.cwd, 'devdocs/runs/exp', a.ref.run, 'plan.md'), '# Plan\n\nReproduce step 1 in lab/exp-a/.\n')
  await mkdir(join(c.cwd, 'lab', 'exp-a'), { recursive: true })
  await writeFile(join(c.cwd, 'lab', 'exp-a', 'wip.py'), 'print("half done")\n') // unfinished, untracked
  await mkdir(join(c.cwd, '.local'), { recursive: true })
  await writeFile(join(c.cwd, '.local', 'venv-marker'), 'an environment; ignored by Git\n') // ignored
  await report(s, a.ref, c.attempt.id, { op: 'question.ask', question: '', node: '_plan', text: 'Agree to plan.md?', to: 'Test Person' })
  const f = await s.x.finished(c.attempt.id, { code: 0, signal: null })
  assert.equal(f.checkpoint?.state, 'published')
  return { ref: a.ref, cwd: c.cwd }
}

// Run B to completion in the same workspace, changing the same path.
async function runB(s: S, receipt: string) {
  const b = await request(s, receipt, 'Something else.')
  const c = await claimed(s.x)
  assert.equal(c.ref.run, b.ref.run)
  await mkdir(join(c.cwd, 'lab', 'exp-a'), { recursive: true })
  await writeFile(join(c.cwd, 'lab', 'exp-a', 'wip.py'), 'print("B")\n')
  await report(s, b.ref, c.attempt.id, { op: 'node.start', node: '_plan' })
  await s.x.finished(c.attempt.id, { code: 0, signal: null }) // B is interrupted; enough to have worked
  return { ref: b.ref, cwd: c.cwd }
}

// A resumes: same copy, same plan, its own unfinished files, nothing of B.
async function assertResumedInPlace(s: S, a: { ref: RunRef; cwd: string }) {
  const c = await claimed(s.x)
  assert.equal(c.ref.run, a.ref.run)
  assert.equal(c.cwd, a.cwd, 'the same copy')
  assert.equal(await readFile(join(c.cwd, 'devdocs/runs/exp', a.ref.run, 'plan.md'), 'utf8'), '# Plan\n\nReproduce step 1 in lab/exp-a/.\n', 'its plan')
  assert.equal(await readFile(join(c.cwd, 'lab/exp-a/wip.py'), 'utf8'), 'print("half done")\n', 'its unfinished work, not B\'s')
  assert.equal(await readFile(join(c.cwd, '.local/venv-marker'), 'utf8'), 'an environment; ignored by Git\n', 'its ignored files')
  return c
}

test('the incident: the agent holds the run on the person\'s answer, as itself; B runs in the same project; A resumes with its plan and files', async () => {
  const s = await setup()
  const a = await planned(s)
  await runOp(s.ws, a.ref, { op: 'question.answer', question: 'q1', text: 'ちょっと事情が変わりました、この実験を保留としてください。', receipt: 'hold-answer-0001' }, { by: 'Test Person', via: 'browser' })
  assert.ok(await s.x.afterAnswer(s.ws, a.ref, 'q1'))
  const c2 = await claimed(s.x)
  await report(s, a.ref, c2.attempt.id, { op: 'question.take-up', question: 'q1' })
  // The agent may not record in the person's name.
  const refused = await agentCli(s, c2.attempt.id, c2.cwd, ['run', 'stop', a.ref.run, '--reason', 'held at the person\'s request', '--by', 'Test Person'])
  assert.equal(refused.code, 1)
  assert.match(refused.err, /records as lab-agent, not as Test Person.*--because/)
  const ok = await agentCli(s, c2.attempt.id, c2.cwd, ['run', 'stop', a.ref.run, '--reason', 'held at the person\'s request before plan agreement', '--because', 'answer:q1'])
  assert.equal(ok.code, 0, ok.err)
  let rec = await record(s, a.ref)
  assert.equal(rec.control.stop?.by, 'lab-agent')
  const entry = rec.history.at(-1)!
  assert.deepEqual([entry.op, entry.by, entry.attempt, (entry as unknown as { because: unknown }).because], ['run.stop', 'lab-agent', c2.attempt.id, { kind: 'answer', question: 'q1' }])
  const f = await s.x.finished(c2.attempt.id, { code: 0, signal: null })
  assert.equal(f.outcome, 'stopped')
  rec = await record(s, a.ref)
  assert.deepEqual([rec.control.hold?.kind, rec.control.hold?.by, rec.control.hold?.because], ['stopped', 'lab-agent', { kind: 'answer', question: 'q1', answer: 0, from: 'Test Person' }])
  assert.equal(f.checkpoint?.state, 'published', 'the stop is final once its checkpoint saved the copy')
  // B: requested and executed in the same workspace while A is held.
  const b = await runB(s, 'req-b-incident')
  assert.equal(await readFile(join(b.cwd, 'lab/exp-a/wip.py'), 'utf8'), 'print("B")\n')
  // The person moves the project on meanwhile; nothing of it enters A's copy.
  await writeFile(join(s.dir, 'NEWS.md'), 'unrelated\n')
  await gitOk(s.dir, ['add', 'NEWS.md']); await gitOk(s.dir, ['commit', '-q', '-m', 'news'])
  // The person resumes A in the browser: their own act.
  const res = await s.x.resume(s.ws, a.ref, 'Test Person', 'Circumstances are back; continue the plan.', 'browser')
  assert.ok(res.job)
  assert.equal(res.record.history.at(-1)!.by, 'Test Person')
  const c3 = await assertResumedInPlace(s, a)
  assert.equal(await exists(join(c3.cwd, 'NEWS.md')), false, 'the shared branch is not merged in')
  assert.match(c3.brief, /the project gained 1 commit on main \(git -C .* none of them is in this copy/)
  rec = await record(s, a.ref)
  assert.equal(rec.nodes._plan.state, 'running', 'the plan step is where it was; agreement is not reset or assumed')
  assert.equal(rec.questions.q1.takenUp?.answer, 0)
})

test('an answer wait reserves nothing: B runs; the answer resumes A in its copy; the brief names what reached the remote meanwhile', async () => {
  const s = await setup()
  const a = await planned(s)
  await runB(s, 'req-b-wait')
  // Something reaches the remote's main only (another run's integration, another clone).
  const other = join(s.area, 'other-clone')
  await gitOk(s.area, ['clone', '-q', s.remote, other])
  await writeFile(join(other, 'INTEGRATED.md'), 'from elsewhere\n')
  await gitOk(other, ['add', '-A']); await gitOk(other, ['commit', '-q', '-m', 'elsewhere']); await gitOk(other, ['push', '-q', 'origin', 'HEAD:main'])
  await runOp(s.ws, a.ref, { op: 'question.answer', question: 'q1', text: 'Agreed.', receipt: 'wait-answer-0001' }, { by: 'Test Person', via: 'browser' })
  assert.ok(await s.x.afterAnswer(s.ws, a.ref, 'q1'))
  const c = await assertResumedInPlace(s, a)
  assert.match(c.brief, /the project gained 1 commit on main \(git -C .*\.\.origin\/main\); none of them is in this copy/)
  assert.equal(await exists(join(c.cwd, 'INTEGRATED.md')), false)
})

test('a running process: a stop waits for it to end (B waits for the slot, not for A); stopping A drops only A\'s queue', async () => {
  const s = await setup()
  const a = await request(s, 'req-a-running')
  const c = await claimed(s.x)
  await report(s, a.ref, c.attempt.id, { op: 'node.start', node: '_plan' })
  await writeFile(join(c.cwd, 'lab-notes.md'), 'notes in progress\n')
  const b = await request(s, 'req-b-running', 'Something else.')
  const rec = await s.x.stop(s.ws, a.ref, 'Test Person', 'not now', 'browser')
  assert.ok(rec.control.stop && !rec.control.hold, 'a stop request is not a hold until the process is gone')
  assert.match(JSON.stringify(await s.x.claim('t')), /slot is held by attempt/, 'one execution slot: B waits for it')
  assert.deepEqual(s.x.stopsDue().map(x => x.id), [c.attempt.id], 'only A\'s attempt is to be terminated')
  const f = await s.x.finished(c.attempt.id, { code: null, signal: 'SIGTERM' })
  assert.equal(f.outcome, 'stopped')
  assert.equal(f.checkpoint?.state, 'published')
  assert.equal(await gitOk(s.remote, ['show', `wfe/${s.id}/exp/${a.ref.run}:lab-notes.md`]), 'notes in progress\n', 'A\'s unfinished work is saved on its branch')
  const cb = await claimed(s.x)
  assert.equal(cb.ref.run, b.ref.run, 'B\'s queued job survived A\'s stop')
  await s.x.finished(cb.attempt.id, { code: 0, signal: null })
  await s.x.resume(s.ws, a.ref, 'Test Person', 'go on', 'browser')
  const ca = await claimed(s.x)
  assert.equal(ca.cwd, c.cwd)
  assert.equal(await readFile(join(ca.cwd, 'lab-notes.md'), 'utf8'), 'notes in progress\n')
})

test('an interrupted save stays A\'s: B is not blocked; A\'s retry publishes its work later', async () => {
  const s = await setup()
  const a = await request(s, 'req-a-save')
  const c = await claimed(s.x)
  await report(s, a.ref, c.attempt.id, { op: 'node.start', node: '_plan' })
  await writeFile(join(c.cwd, 'unsaved.md'), 'A\'s work\n')
  await s.x.stop(s.ws, a.ref, 'Test Person', 'hold', 'browser')
  await gitOk(c.cwd, ['remote', 'set-url', 'origin', join(s.area, 'unreachable.git')])
  const f = await s.x.finished(c.attempt.id, { code: null, signal: 'SIGTERM' })
  assert.equal(f.checkpoint?.state, 'failed', 'the save did not finish')
  assert.equal((await record(s, a.ref)).control.hold?.kind, 'stopped')
  const b = await runB(s, 'req-b-save')
  assert.equal((await gitOk(s.remote, ['rev-parse', '--verify', `wfe/${s.id}/exp/${b.ref.run}`])).trim().length, 40, 'B published while A\'s save failed')
  assert.equal(await readFile(join(c.cwd, 'unsaved.md'), 'utf8'), 'A\'s work\n', 'A\'s files are untouched')
  await gitOk(c.cwd, ['remote', 'set-url', 'origin', s.remote])
  const retried = await s.x.publishCheckpoint(f.checkpoint!.id)
  assert.equal(retried.state, 'published')
  assert.equal(await gitOk(s.remote, ['show', `wfe/${s.id}/exp/${a.ref.run}:unsaved.md`]), 'A\'s work\n')
})

test('a restart of the execution host: a held run stays held with its files; a lost attempt is unknown, held, and B goes on', async () => {
  const s = await setup()
  const a = await planned(s)
  await s.x.stop(s.ws, a.ref, 'Test Person', 'hold before restart', 'browser')
  // B's attempt is executing when the host restarts and its process is gone.
  const b = await request(s, 'req-b-restart', 'Something else.')
  const cb = await s.x.claim('t')
  assert.ok('attempt' in cb)
  s.x.started(cb.attempt.id, 999_999) // a pid that is not alive
  await writeFile(join(cb.cwd, 'b-partial.md'), 'B was here\n')
  s.x.close()
  const x2 = new ExecStore({ registryFile: s.registry, area: s.area })
  const notes = await x2.reconcile()
  assert.match(notes.join('\n'), new RegExp(`attempt ${cb.attempt.id} .*process gone; recorded unknown`))
  assert.equal((await readRun(s.ws, b.ref)).record!.control.hold?.kind, 'unknown')
  assert.equal((await readRun(s.ws, a.ref)).record!.control.hold?.kind, 'stopped', 'A stays held: nothing resumes it by itself')
  assert.deepEqual(await x2.claim('t'), { idle: 'no queued job' })
  assert.equal(await readFile(join(cb.cwd, 'b-partial.md'), 'utf8'), 'B was here\n')
  assert.equal(await gitOk(s.remote, ['show', `wfe/${s.id}/exp/${b.ref.run}:b-partial.md`]), 'B was here\n', 'the lost attempt\'s work is saved too')
  // A third request runs while both are held; then A resumes in place.
  const s2 = { ...s, x: x2 }
  const c3 = await request(s2, 'req-c-restart', 'A third thing.')
  const cc = await x2.claim('t')
  assert.ok('attempt' in cc && cc.ref.run === c3.ref.run)
  x2.started(cc.attempt.id, process.pid)
  await x2.finished(cc.attempt.id, { code: 0, signal: null })
  await x2.resume(s.ws, a.ref, 'Test Person', 'continue', 'browser')
  await assertResumedInPlace(s2, a)
  x2.close()
})

test('who records: outside an attempt a host-performed run needs --by; a browser act keeps its person; a stale attempt\'s control is refused', async () => {
  const s = await setup()
  const a = await planned(s)
  const cwd = process.cwd()
  const err: string[] = []
  const log = { out: console.log, err: console.error }
  console.log = () => {}; console.error = (...m: unknown[]) => { err.push(m.join(' ')) }
  try {
    process.chdir(s.dir)
    assert.equal(await main(['run', 'stop', a.ref.run, '--reason', 'x', '--registry', s.registry, '--area', s.area]), 1)
    assert.match(err.join('\n'), /who records this\? Pass --by <your name>: run exp\/run-001 is performed by lab-agent on the execution host autolab/)
    assert.equal(await main(['run', 'answer', a.ref.run, 'q1', '--answer', 'yes', '--registry', s.registry, '--area', s.area]), 1, 'no default name on someone else\'s answer')
    assert.equal(await main(['run', 'stop', a.ref.run, '--reason', 'x', '--by', 'Omni Agent', '--registry', s.registry, '--area', s.area]), 0)
  } finally { process.chdir(cwd); console.log = log.out; console.error = log.err }
  const rec = await record(s, a.ref)
  assert.deepEqual([rec.control.hold?.by, rec.history.at(-1)!.via], ['Omni Agent', 'cli'])
  // A control operation carrying an attempt id that is not open is refused.
  await assert.rejects(runOp(s.ws, a.ref, { op: 'run.resume', reason: 'go', attempt: 'aold-000000' }, { by: 'lab-agent', via: 'cli' }), /attempt aold-000000 is not the current attempt/)
  // --because must name words that exist.
  await assert.rejects(s.x.resume(s.ws, a.ref, 'lab-agent', 'go', 'cli', undefined, { because: { kind: 'instruction', instruction: 'i9' } }), /instruction i9 does not exist/)
  void git
})
