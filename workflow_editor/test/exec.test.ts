// p4 stage 3: execution management, synthetically — the queue and one slot,
// requests and answers sent twice, attempts fenced by their ids, human waits
// that end the process, stop / cancel / interruption / unknown, explicit
// resumption, cross-process locking, and publication with retries. The
// executor's steps are driven here directly (the daemon's own tests are in
// agautolab); nothing launches an agent.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { createHandler } from '../server/api.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { git, gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import { situation, type OpInput, type RunRef } from '../shared/run.ts'

const pexec = promisify(execFile)
const pkg = fileURLToPath(new URL('..', import.meta.url))
let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-exec-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = `schema: ag.workflow.v2
documentation: {policy: manual}
id: ship
name: Ship
intent: |
  Agree on a scope, then build it.
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

// A project with a local bare remote (origin), in its own area and registry.
let n = 0
async function setup(mode: 'directory' | 'submodule' = 'directory', workspaces = 1) {
  const area = join(root, `area-${++n}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, `pj-p${n}`)
  const r = await createProject({ dir, id: `p${n}`, name: `P${n}`, intent: 'x', goals: [], devdocs: mode, sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), WF)
  const commitDocs = async () => {
    if (mode === 'submodule') { await gitOk(join(dir, 'devdocs'), ['add', '-A']); await gitOk(join(dir, 'devdocs'), ['commit', '-q', '-m', 'workflow']); await gitOk(join(dir, 'devdocs'), ['push', '-q', 'origin', 'HEAD:main']) }
    await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  }
  await commitDocs()
  const remote = join(area, 'remotes', `pj-p${n}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote])
  await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  if (mode === 'submodule') await gitOk(join(dir, 'devdocs'), ['fetch', '-q', 'origin'])
  const extra: string[] = []
  for (let i = 2; i <= workspaces; i++) {
    const other = join(area, `pj-p${n}-${i}`)
    await gitOk(area, ['clone', '-q', '--recurse-submodules', remote, other])
    const { registerWorkspace } = await import('../server/registry.ts')
    const reg = await registerWorkspace(registry, other, { id: `p${n}-${i}` })
    assert.ok(reg.ok, reg.message)
    extra.push(`p${n}-${i}`)
  }
  const x = new ExecStore({ registryFile: registry, area })
  const wsOf = async (id = `p${n}`) => new Workspace((await loadRegistry(registry)).workspaces.find(w => w.id === id)!)
  return { area, registry, dir, remote, x, ws: await wsOf(), wsOf, extra, id: `p${n}` }
}

const request = (x: ExecStore, workspace: string, receipt: string) => x.request({ workspace, workflow: 'ship', text: 'Please build a small thing.', author: 'Test Person', receipt, via: 'browser' })
// The executor's report, carrying its attempt id.
const report = (ws: Workspace, ref: RunRef, attempt: string | undefined, op: OpInput) => runOp(ws, ref, { ...op, ...(attempt ? { attempt } : {}) }, { by: 'autolab', via: 'cli' })
const record = async (ws: Workspace, ref: RunRef) => (await readRun(ws, ref)).record!
// Where a run works (p9): its own copy of the project.
const copyOf = async (ws: Workspace, ref: RunRef) => (await runSpace(ws, ref)).root
const branchOf = (project: string, ref: RunRef) => `wfe/${project}/${ref.workflow}/${ref.run}`
const claimed = async (x: ExecStore) => { const c = await x.claim('test-harness'); assert.ok('attempt' in c, JSON.stringify(c)); return c as Exclude<typeof c, { idle: string }> }

test('request → human wait (process exits) → answer → resume → completion → acceptance; one slot; duplicates queued once', async () => {
  const { x, ws, id, dir, remote } = await setup()
  const r1 = await request(x, id, 'browser-req-0001')
  const again = await request(x, id, 'browser-req-0001')
  assert.equal(again.duplicate, true)
  assert.equal(again.job.id, r1.job.id, 'a retransmitted request is queued once')
  const ref = r1.ref
  // Attempt 1: talk asks and the process ends.
  const c1 = await claimed(x)
  assert.equal(c1.ref.run, ref.run)
  assert.match(c1.brief, /request is devdocs\/runs\/ship\/run-001\/braindump\.md/)
  assert.deepEqual(await x.claim(null), { idle: `the slot is held by attempt ${c1.attempt.id} (${id} ship/${ref.run})` })
  x.started(c1.attempt.id, process.pid)
  await assert.rejects(report(ws, ref, undefined, { op: 'node.start', node: 'scope' }), (e: unknown) => e instanceof RequestError && /attempt-required|its reports carry its id/.test(e.message), 'nobody else records execution meanwhile')
  await report(ws, ref, c1.attempt.id, { op: 'node.start', node: 'scope' })
  await report(ws, ref, c1.attempt.id, { op: 'question.ask', question: '', node: 'scope', text: 'Small or large?', to: 'Test Person' })
  const f1 = await x.finished(c1.attempt.id, { code: 0, signal: null })
  assert.equal(f1.outcome, 'exited')
  let rec = await record(ws, ref)
  assert.equal(situation(rec), 'awaiting-person', 'no process runs through the wait')
  assert.equal(rec.control.attempt, null)
  assert.equal(f1.checkpoint?.state, 'published', `checkpoint: ${JSON.stringify(f1.checkpoint)}`)
  assert.match(await gitOk(remote, ['log', '-1', '--format=%s', branchOf(id, ref)]), /ship\/run-001: after attempt .*awaiting-person/, 'saved on the run branch')
  assert.equal((await gitOk(remote, ['log', '-1', '--format=%s', 'main'])).trim(), 'workflow', 'the shared branch is untouched')
  assert.equal(c1.cwd, await copyOf(ws, ref), 'the attempt works in the run\'s own copy')
  assert.match(c1.brief, /Working copy: .*saved to branch wfe\/p\d+\/ship\/run-001/)
  // The answer: recorded first, then the resumption is queued; twice is once.
  const ans = { op: 'question.answer' as const, question: 'q1', text: 'Small.', receipt: 'browser-answer-q1-0001' }
  await runOp(ws, ref, ans, { by: 'Test Person', via: 'browser' })
  const dupe = await runOp(ws, ref, ans, { by: 'Test Person', via: 'browser' })
  assert.equal(dupe.duplicate, true)
  assert.equal((await record(ws, ref)).questions.q1.answers.length, 1, 'a retransmitted answer is recorded once')
  const j1 = await x.afterAnswer(ws, ref, 'q1')
  const j2 = await x.afterAnswer(ws, ref, 'q1')
  assert.equal(j1?.id, j2?.id, 'resumption queued once')
  rec = await record(ws, ref)
  assert.equal(rec.nodes.scope.state, 'waiting', 'recording an answer is not taking it up')
  // Attempt 2: a new process, from the record.
  const c2 = await claimed(x)
  assert.match(c2.brief, /resume: answer 0 to q1 recorded/)
  x.started(c2.attempt.id, process.pid)
  await assert.rejects(report(ws, ref, c1.attempt.id, { op: 'node.progress', node: 'scope', text: 'late' }), /not the current attempt/, 'the old attempt records nothing')
  await report(ws, ref, c2.attempt.id, { op: 'question.take-up', question: 'q1' })
  await report(ws, ref, c2.attempt.id, { op: 'node.complete', node: 'scope', outcome: 'small' })
  await report(ws, ref, c2.attempt.id, { op: 'node.start', node: 'build' })
  await writeFile(join(c2.cwd, 'thing.txt'), 'built\n')
  await report(ws, ref, c2.attempt.id, { op: 'node.complete', node: 'build', outcome: 'built thing.txt', artifacts: ['thing.txt'] })
  const f2 = await x.finished(c2.attempt.id, { code: 0, signal: null })
  rec = await record(ws, ref)
  assert.equal(situation(rec), 'completed')
  assert.equal(rec.decisions.length, 0, 'completion is not acceptance')
  assert.equal(f2.checkpoint?.state, 'published')
  assert.equal((await gitOk(remote, ['show', `${branchOf(id, ref)}:thing.txt`])), 'built\n', 'the work reached the remote, on the run branch')
  assert.notEqual((await git(remote, ['cat-file', '-e', 'main:thing.txt'])).code, 0, 'and not the shared branch')
  assert.equal(await import('node:fs/promises').then(f => f.stat(join(dir, 'thing.txt')).then(() => true, () => false)), false, 'nor the project workspace')
  await runOp(ws, ref, { op: 'run.decide', decision: 'accepted', evidence: 'looked at thing.txt' }, { by: 'Test Person', via: 'browser' })
  const cp = await x.afterDecision(ws, ref, 'accepted')
  assert.equal(cp.state, 'published')
  assert.match(await gitOk(remote, ['show', `${branchOf(id, ref)}:devdocs/runs/ship/${ref.run}/run.json`]), /"decision": "accepted"/)
  // History keeps the distinct steps.
  const ops = (await record(ws, ref)).history.map(e => e.op)
  for (const o of ['question.answer', 'question.take-up', 'node.complete', 'run.decide']) assert.ok(ops.includes(o as never), o)
})

test('a workflow that names its agent: browser answers queue the resumption and browser decisions publish (project_migration p1)', async () => {
  const { x, ws, id, dir, remote, registry, area } = await setup()
  await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), WF.replace('repositories:', 'execution: {agent: ship-agent}\nrepositories:'))
  await gitOk(dir, ['commit', '-qam', 'agent']); await gitOk(dir, ['push', '-q', 'origin', 'main'])
  const ref = (await request(x, id, 'browser-req-agent')).ref
  assert.equal((await record(ws, ref)).executor.name, 'ship-agent', 'the agent identity differs from the execution host')
  const c1 = await claimed(x)
  x.started(c1.attempt.id, process.pid)
  await report(ws, ref, c1.attempt.id, { op: 'node.start', node: 'scope' })
  await report(ws, ref, c1.attempt.id, { op: 'question.ask', question: '', node: 'scope', text: 'Small or large?', to: 'Test Person' })
  await x.finished(c1.attempt.id, { code: 0, signal: null })
  const srv = createServer(createHandler({ registryFile: registry, area, allowedOrigins: [], allowedHosts: ['127.0.0.1'], exec: x }))
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  try {
    const ops = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/workspaces/${id}/runs/${ref.workflow}/${ref.run}/ops`
    const post = async (op: Record<string, unknown>) => { const res = await fetch(ops, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...op, by: 'Test Person' }) }); assert.equal(res.status, 200, await res.clone().text()); return await res.json() as { job?: { id: number } | null; checkpoint?: { state: string } } }
    const answered = await post({ op: 'question.answer', question: 'q1', text: 'Small.', receipt: 'browser-answer-agent' })
    assert.ok(answered.job?.id, 'the resumption is queued at once, not left to reconcile')
    const c2 = await claimed(x)
    x.started(c2.attempt.id, process.pid)
    await report(ws, ref, c2.attempt.id, { op: 'question.take-up', question: 'q1' })
    await report(ws, ref, c2.attempt.id, { op: 'node.complete', node: 'scope', outcome: 'small' })
    await report(ws, ref, c2.attempt.id, { op: 'node.start', node: 'build' })
    await report(ws, ref, c2.attempt.id, { op: 'node.complete', node: 'build', outcome: 'built' })
    await x.finished(c2.attempt.id, { code: 0, signal: null })
    const decided = await post({ op: 'run.decide', decision: 'accepted', evidence: 'looked at it' })
    assert.equal(decided.checkpoint?.state, 'published', 'the decision is published')
    assert.match(await gitOk(remote, ['show', `${branchOf(id, ref)}:devdocs/runs/ship/${ref.run}/run.json`]), /"decision": "accepted"/)
  } finally { srv.close() }
})

test('one workspace, one run: another request is refused while a run awaits a person; another workspace proceeds', async () => {
  const { x, id, extra } = await setup('directory', 2)
  const a = await request(x, id, 'req-hold-0001')
  const c = await claimed(x)
  const ws = await (await import('../server/registry.ts')).loadRegistry(x.ctx.registryFile).then(r => new Workspace(r.workspaces.find(w => w.id === id)!))
  await report(ws, a.ref, c.attempt.id, { op: 'node.start', node: 'scope' })
  await report(ws, a.ref, c.attempt.id, { op: 'question.ask', question: '', node: 'scope', text: '?', to: 'Test Person' })
  await x.finished(c.attempt.id, { code: 0, signal: null })
  await assert.rejects(request(x, id, 'req-hold-0002'), /held by run ship\/run-001/)
  const b = await request(x, extra[0], 'req-other-0001')
  const c2 = await claimed(x)
  assert.equal(c2.workspace.id, extra[0], 'eligible work in another workspace runs while the first waits')
  assert.equal(c2.ref.run, b.ref.run)
})

test('interruption after a side effect: held, never rerun or completed by itself; explicit resume continues from the working tree', async () => {
  const { x, ws, id } = await setup()
  const { ref } = await request(x, id, 'req-intr-0001')
  const c = await claimed(x)
  await report(ws, ref, c.attempt.id, { op: 'node.start', node: 'scope' })
  await report(ws, ref, c.attempt.id, { op: 'node.complete', node: 'scope', outcome: 'agreed without asking' })
  await report(ws, ref, c.attempt.id, { op: 'node.start', node: 'build' })
  await writeFile(join(c.cwd, 'half.txt'), 'side effect before completion was recorded\n') // then the process dies
  const f = await x.finished(c.attempt.id, { code: 137, signal: 'SIGKILL' })
  assert.equal(f.outcome, 'interrupted')
  let rec = await record(ws, ref)
  assert.deepEqual([rec.control.hold?.kind, rec.nodes.build.state], ['interrupted', 'running'], 'not completed, not failed')
  assert.deepEqual(await x.claim(null), { idle: 'no queued job' }, 'nothing is queued by itself')
  x.enqueue(id, ref, 'resume', 'sneaky-0001', 'an automatic retry')
  assert.match(JSON.stringify(await x.claim(null)), /no queued job/, 'a held run is not executed even if queued')
  const resumed = await x.resume(ws, ref, 'Test Person', 'half.txt exists; finish build from it', 'browser')
  assert.ok(resumed.job)
  const c2 = await claimed(x)
  assert.match(c2.brief, /resumed the run: "half.txt exists; finish build from it"/)
  assert.match(c2.brief, /previous attempt .* ended: interrupted/)
  await report(ws, ref, c2.attempt.id, { op: 'node.complete', node: 'build', outcome: 'finished from half.txt' })
  await x.finished(c2.attempt.id, { code: 0, signal: null })
  rec = await record(ws, ref)
  assert.equal(situation(rec), 'completed')
  assert.equal(rec.control.attempts, 2)
})

test('an exit that leaves work running or ready is an interruption, not success', async () => {
  const { x, ws, id } = await setup()
  const { ref } = await request(x, id, 'req-exit-0001')
  const c = await claimed(x)
  await report(ws, ref, c.attempt.id, { op: 'node.start', node: 'scope' })
  await x.finished(c.attempt.id, { code: 0, signal: null })
  const rec = await record(ws, ref)
  assert.equal(rec.control.hold?.kind, 'interrupted')
  assert.match(rec.control.last!.detail, /scope recorded as running/)
})

test('stop: requested, then confirmed by the end; a late report is refused; resume immediately after; cancel refuses everything after', async () => {
  const { x, ws, id } = await setup()
  const { ref } = await request(x, id, 'req-stop-0001')
  const c = await claimed(x)
  x.started(c.attempt.id, process.pid)
  await report(ws, ref, c.attempt.id, { op: 'node.start', node: 'scope' })
  let rec = await x.stop(ws, ref, 'Test Person', 'wrong direction', 'browser')
  assert.equal(situation(rec), 'stopping', 'a stop request is not confirmed termination')
  assert.deepEqual(x.stopsDue().map(a => a.id), [c.attempt.id])
  await x.finished(c.attempt.id, { code: null, signal: 'SIGTERM' })
  rec = await record(ws, ref)
  assert.equal(situation(rec), 'stopped')
  await assert.rejects(report(ws, ref, c.attempt.id, { op: 'node.progress', node: 'scope', text: 'after the stop' }), /not the current attempt/)
  await x.resume(ws, ref, 'Test Person', 'go on, smaller', 'browser')
  const c2 = await claimed(x)
  x.started(c2.attempt.id, process.pid)
  await assert.rejects(report(ws, ref, c.attempt.id, { op: 'node.progress', node: 'scope', text: 'stale' }), /not the current attempt/, 'the stopped attempt cannot write into the new one')
  await x.cancel(ws, ref, 'Test Person', 'not needed after all', 'browser')
  await assert.rejects(report(ws, ref, c2.attempt.id, { op: 'node.progress', node: 'scope', text: 'after cancel' }), /cancelled/)
  assert.deepEqual(x.stopsDue().map(a => a.id), [c2.attempt.id], 'the executor terminates it')
  await x.finished(c2.attempt.id, { code: null, signal: 'SIGTERM' })
  await assert.rejects(x.resume(ws, ref, 'Test Person', 'again?', 'browser'), /cancelled/, 'no resumption after cancellation')
  assert.equal(situation(await record(ws, ref)), 'cancelled')
})

test('restart recovery: a gone process becomes unknown (held), a live one keeps the slot; unqueued answers are queued again', async () => {
  const { x, ws, id, area, registry } = await setup()
  const { ref } = await request(x, id, 'req-unk-0001')
  const c = await claimed(x)
  const child = spawn('sleep', ['30'])
  x.started(c.attempt.id, child.pid!)
  x.close()
  // The executor (or the service) restarts: a new store over the same file.
  const y = new ExecStore({ registryFile: registry, area })
  assert.deepEqual(await y.reconcile(), [], 'a live process keeps its attempt')
  assert.match(JSON.stringify(await y.claim(null)), /slot is held/, 'no duplicate launch')
  child.kill('SIGKILL')
  await new Promise(r => child.once('exit', r))
  const notes = await y.reconcile()
  assert.match(notes.join('\n'), /process gone; recorded unknown/)
  const rec = await record(ws, ref)
  assert.deepEqual([situation(rec), rec.control.last?.outcome], ['unknown', 'unknown'])
  assert.match(JSON.stringify(await y.claim(null)), /no queued job/, 'nothing reruns by itself')
  // An answer recorded while the queue entry was lost is queued again.
  await y.resume(ws, ref, 'Test Person', 'checked the tree; continue', 'browser')
  const c2 = await claimed(y)
  await report(ws, ref, c2.attempt.id, { op: 'node.start', node: 'scope' })
  await report(ws, ref, c2.attempt.id, { op: 'question.ask', question: '', node: 'scope', text: '?', to: 'Test Person' })
  await y.finished(c2.attempt.id, { code: 0, signal: null })
  await runOp(ws, ref, { op: 'question.answer', question: 'q1', text: 'yes' }, { by: 'Test Person', via: 'browser' }) // the service died before queueing
  assert.match((await y.reconcile()).join('\n'), /resume after the answer to q1 queued again/)
  assert.deepEqual(await y.reconcile(), [], 'and only once')
  y.close()
})

test('concurrent writers from several processes lose nothing', async () => {
  const { ws, registry, x, id } = await setup()
  const { ref } = await request(x, id, 'req-conc-0001')
  const c = await claimed(x)
  await report(ws, ref, c.attempt.id, { op: 'node.start', node: 'scope' })
  await report(ws, ref, c.attempt.id, { op: 'question.ask', question: '', text: 'Anything to add?', to: 'Test Person' })
  const script = `
    import { loadRegistry } from '${join(pkg, 'server/registry.ts')}'
    import { runOp } from '${join(pkg, 'server/runs.ts')}'
    import { Workspace } from '${join(pkg, 'server/workspace.ts')}'
    const [reg, wsId, wf, run, who, attempt] = process.argv.slice(2)
    const ws = new Workspace((await loadRegistry(reg)).workspaces.find(w => w.id === wsId))
    for (let i = 0; i < 10; i++) await runOp(ws, { workflow: wf, run }, { op: 'node.progress', node: 'scope', text: who + ' ' + i, attempt }, { by: who, via: 'cli' })
  `
  const file = join(root, 'writer.ts')
  await writeFile(file, script)
  // An executor writing progress and a person-side writer at the same time.
  await Promise.all([
    pexec(process.execPath, [file, registry, id, ref.workflow, ref.run, 'executor', c.attempt.id], { env: process.env }),
    pexec(process.execPath, [file, registry, id, ref.workflow, ref.run, 'executor2', c.attempt.id], { env: process.env }),
    ...[0, 1, 2, 3, 4].map(i => runOp(ws, ref, { op: 'question.answer', question: 'q1', text: `answer ${i}` }, { by: 'Test Person', via: 'browser' })),
  ])
  const rec = await record(ws, ref)
  assert.equal(rec.nodes.scope.notes.length, 20, 'every progress note of both writers is there')
  assert.equal(rec.questions.q1.answers.length, 5, 'every answer typed meanwhile is there')
  assert.deepEqual(rec.history.map(e => e.seq), rec.history.map((_, i) => i + 1), 'one contiguous history')
  assert.equal((await readRun(ws, ref)).problem, undefined)
})

test('publication (p9): the copy is saved to its run branch only; the person\'s edits stay out; a push failure is retried without new commits; submodules before the root', async () => {
  const { x, ws, id, dir, area, remote } = await setup('submodule')
  await writeFile(join(dir, 'notes-of-the-person.txt'), 'mine, before the run\n')
  await writeFile(join(dir, 'README.md'), 'edited by the person before the run\n')
  const mainBefore = (await gitOk(remote, ['rev-parse', 'main'])).trim()
  const { ref } = await request(x, id, 'req-pub-0001')
  const c = await claimed(x)
  const cwd = c.cwd
  await report(ws, ref, c.attempt.id, { op: 'node.start', node: 'scope' })
  await report(ws, ref, c.attempt.id, { op: 'node.complete', node: 'scope', outcome: 'ok' })
  await report(ws, ref, c.attempt.id, { op: 'node.start', node: 'build' })
  await writeFile(join(cwd, 'made-by-run.txt'), 'the run\n')
  await writeFile(join(cwd, 'README.md'), 'edited by the run\n')
  await report(ws, ref, c.attempt.id, { op: 'node.complete', node: 'build', outcome: 'ok' })
  // The root's remote is unreachable during this checkpoint; devdocs' is not.
  const rootRemote = (await gitOk(cwd, ['remote', 'get-url', 'origin'])).trim()
  assert.equal(rootRemote, remote, 'the copy publishes to the project\'s remote')
  await gitOk(cwd, ['remote', 'set-url', 'origin', join(area, 'nowhere.git')])
  const f = await x.finished(c.attempt.id, { code: 0, signal: null })
  const cp = f.checkpoint!
  assert.equal(cp.state, 'failed')
  const steps1 = (await x.runView(id, ref)).checkpoints.at(-1)!.steps
  const docs = steps1.find(s => s.repo === 'devdocs')!, rootStep = steps1.find(s => s.repo === '.')!
  const branch = branchOf(id, ref)
  assert.deepEqual([docs.branch, rootStep.branch], [branch, branch], 'each step records its run branch before writing')
  assert.ok(docs.commit && docs.pushed, 'the child repository was published first')
  assert.ok(rootStep.commit && !rootStep.pushed, 'the root was committed, its push failed')
  assert.deepEqual(rootStep.include.sort(), ['README.md', 'devdocs', 'made-by-run.txt'], 'everything in the copy is the run\'s own work')
  const docsRemote = (await gitOk(join(cwd, 'devdocs'), ['remote', 'get-url', 'origin'])).trim()
  assert.equal((await gitOk(docsRemote, ['rev-parse', branch])).trim(), docs.commit)
  // The agent checks out something else before the retry: the retry still
  // publishes the recorded run branch, nothing else.
  await gitOk(cwd, ['remote', 'set-url', 'origin', rootRemote])
  await gitOk(cwd, ['checkout', '-q', '-b', 'scratch'])
  const retried = await x.publishCheckpoint(cp.id)
  const steps2 = (await x.runView(id, ref)).checkpoints.at(-1)!.steps
  assert.equal(steps2.find(s => s.repo === '.')!.commit, rootStep.commit, 'the retry pushes the same commit; the work is not repeated')
  assert.equal(steps2.find(s => s.repo === 'devdocs')!.commit, docs.commit)
  assert.equal(retried.state, 'published')
  assert.equal((await gitOk(remote, ['rev-parse', branch])).trim(), rootStep.commit)
  assert.equal((await gitOk(remote, ['rev-parse', 'main'])).trim(), mainBefore, 'no shared branch changed')
  assert.equal(await gitOk(remote, ['show', `${branch}:README.md`]), 'edited by the run\n')
  assert.notEqual((await git(remote, ['cat-file', '-e', `${branch}:notes-of-the-person.txt`])).code, 0, 'the person\'s files are not the run\'s')
  assert.match(await gitOk(dir, ['status', '--porcelain']), /notes-of-the-person\.txt/, 'and stay in their workspace')
  // A later checkpoint while another branch is checked out commits nothing there.
  await writeFile(join(cwd, 'on-scratch.txt'), 'x\n')
  const cp2 = await x.checkpoint(ws, ref, 'a later save', null, null)
  assert.equal(cp2.state, 'attention')
  assert.match(cp2.steps, /has scratch checked out, not the run branch/)
  assert.notEqual((await git(remote, ['rev-parse', '--verify', '-q', 'refs/heads/scratch'])).code, 0, 'the other branch is never pushed')
})

test('notification boundary: notable events from committed entries, with stable ids', async () => {
  const { notableEvents } = await import('../shared/run.ts')
  const { x, ws, id } = await setup()
  const { ref } = await request(x, id, 'req-note-0001')
  const c = await claimed(x)
  await report(ws, ref, c.attempt.id, { op: 'node.start', node: 'scope' })
  await report(ws, ref, c.attempt.id, { op: 'question.ask', question: '', node: 'scope', text: 'Small or large?', to: 'Test Person' })
  await x.finished(c.attempt.id, { code: 0, signal: null })
  await runOp(ws, ref, { op: 'question.answer', question: 'q1', text: 'Small.' }, { by: 'Test Person', via: 'browser' })
  const rec = await record(ws, ref)
  const ev = notableEvents(rec)
  assert.deepEqual(ev.map(e => e.type), ['started', 'question', 'answered'])
  assert.equal(ev[1].id, `${rec.project}/ship/${ref.run}#${ev[1].seq}:question`)
  assert.equal(ev[1].critical, true)
  assert.equal(ev[1].holder, 'Test Person')
  assert.equal(ev[1].question, 'q1')
  assert.deepEqual(notableEvents(rec, ev[1].seq).map(e => e.type), ['answered'], 'selection after a sequence')
})
