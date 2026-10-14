// observer p3 step 2: the workflow observation (server/observe.ts,
// docs/observation.md). Real runs in their own copies, a real process group
// standing in for the agent, a stream-json log with an open tool call, an
// interruption, a person's hold, the queue, a missing copy, a stale
// executor, two registrations of one run, a record that changes while it is
// read, and the CLI and the HTTP route agreeing. Nothing here launches an agent.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createHandler } from '../server/api.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { Observer, cpuSeconds, type Observation, type ObservedRun } from '../server/observe.ts'
import { loadRegistry, registerWorkspace } from '../server/registry.ts'
import { createRun, runOp } from '../server/runs.ts'
import { copyDir } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'
import type { OpInput, RunRef } from '../shared/run.ts'

const pexec = promisify(execFile)
const pkg = fileURLToPath(new URL('..', import.meta.url))
let root = ''
const children: ChildProcess[] = []
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-observe-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => {
  for (const c of children) { try { process.kill(-c.pid!, 'SIGKILL') } catch { /* gone */ } }
  await rm(root, { recursive: true, force: true })
})

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

let n = 0
async function setup(workspaces = 1) {
  const area = join(root, `area-${++n}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, `pj-p${n}`)
  const r = await createProject({ dir, id: `p${n}`, name: `P${n}`, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), WF)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remotes', `pj-p${n}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote])
  await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  const extra: string[] = []
  for (let i = 2; i <= workspaces; i++) {
    const other = join(area, `pj-p${n}-${i}`)
    await gitOk(area, ['clone', '-q', remote, other])
    const reg = await registerWorkspace(registry, other, { id: `p${n}-${i}` })
    assert.ok(reg.ok, reg.message)
    extra.push(`p${n}-${i}`)
  }
  const x = new ExecStore({ registryFile: registry, area })
  const wsOf = async (id = `p${n}`) => new Workspace((await loadRegistry(registry)).workspaces.find(w => w.id === id)!)
  return { area, registry, dir, x, ws: await wsOf(), wsOf, extra, id: `p${n}`, observer: new Observer(x, registry) }
}
const request = (x: ExecStore, workspace: string, receipt: string) => x.request({ workspace, workflow: 'ship', text: 'Please build a small thing.', author: 'Test Person', receipt, via: 'browser' })
const report = (ws: Workspace, ref: RunRef, attempt: string | undefined, op: OpInput) => runOp(ws, ref, { ...op, ...(attempt ? { attempt } : {}) }, { by: 'autolab', via: 'cli' })
const claimed = async (x: ExecStore) => { const c = await x.claim('test-harness'); assert.ok('attempt' in c, JSON.stringify(c)); return c as Exclude<typeof c, { idle: string }> }
const runOf = (o: Observation, ref: RunRef, ws?: string) => o.runs.find(r => r.identity.workflow === ref.workflow && r.identity.run === ref.run && (!ws || r.identity.workspace === ws))
// A process group of its own standing in for the agent (the executor starts agents so).
function agentProcess(): ChildProcess {
  const c = spawn('sh', ['-c', 'sleep 120 & wait'], { detached: true, stdio: 'ignore' })
  children.push(c)
  return c
}
const line = (v: unknown) => `${JSON.stringify(v)}\n`

test('cpu time as ps prints it', () => {
  assert.equal(cpuSeconds('0:01.50'), 1.5)
  assert.equal(cpuSeconds('12:03.00'), 723)
  assert.equal(cpuSeconds('1:00:00'), 3600)
  assert.equal(cpuSeconds('2-01:00:00'), 2 * 86400 + 3600)
  assert.equal(cpuSeconds('n/a'), null)
})

test('an executing attempt in its own copy: identity, live process group, an open tool call within its declared timeout, the slot and the work queued behind it', async () => {
  const { x, ws, id, observer } = await setup()
  const a = await request(x, id, 'observe-req-a')
  const b = await request(x, id, 'observe-req-b')
  const c = await claimed(x)
  assert.equal(c.ref.run, a.ref.run)
  const proc = agentProcess()
  x.started(c.attempt.id, proc.pid!)
  await report(ws, a.ref, c.attempt.id, { op: 'node.start', node: 'scope' })
  // The agent's stream: a session, a turn, then a long foreground command.
  await writeFile(c.attempt.log!, line({ type: 'system', subtype: 'init', session_id: 'sess-1' }) +
    line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'looking' }] } }) +
    line({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'for i in 1 2 3; do curl -s x; sleep 45; done', timeout: 600000, description: 'paced retry loop' } }] } }))
  const o = await observer.observe()
  const ra = runOf(o, a.ref)!
  assert.ok(ra, 'the executing run is observed')
  assert.match(ra.identity.uid, new RegExp(`^p\\d+/ship/run-001#[0-9a-f]{16}$`))
  assert.equal(ra.identity.branch, `wfe/${id}/ship/run-001`)
  assert.equal(ra.source.state, 'ok'); assert.equal(ra.source.location, 'copy'); assert.equal(ra.source.consistent, true)
  assert.equal(ra.situation, 'executing')
  assert.equal(ra.attempts.open?.id, c.attempt.id)
  assert.equal(ra.process?.alive, true)
  assert.ok((ra.process?.group?.members ?? 0) >= 1, 'the process group is seen')
  assert.equal(ra.process?.log?.session, 'sess-1')
  assert.equal(ra.process?.log?.turns, 2)
  const tool = ra.process?.log?.openTool as { name: string; timeoutSeconds: number; summary: string; since: string }
  assert.equal(tool.name, 'Bash'); assert.equal(tool.timeoutSeconds, 600); assert.equal(tool.summary, 'paced retry loop'); assert.ok(tool.since)
  assert.equal(ra.waiting?.responsible, `agent:${ra.executor?.name}`)
  assert.equal(ra.progress?.op, 'node.start')
  assert.equal(o.executor.slot?.uid, ra.identity.uid, 'the slot names the run by uid')
  const rb = runOf(o, b.ref)!
  assert.equal(rb.situation, 'not-started')
  assert.equal(rb.queue.job?.state, 'queued')
  assert.equal(rb.queue.position, 1)
  assert.deepEqual(rb.queue.ahead.map(w => [w.kind, w.uid]), [['attempt', ra.identity.uid]], 'the work ahead is the healthy attempt')
  assert.equal(rb.waiting?.responsible, 'executor')
  // The command's result arrives: no tool is open any more.
  await appendFile(c.attempt.log!, line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }))
  assert.equal(runOf(await observer.observe(), a.ref)!.process?.log?.openTool, null)
  process.kill(-proc.pid!, 'SIGKILL')
})

test('an interruption, a person\'s hold and an answered question are told apart; a background task stopped with the session is counted', async () => {
  const { x, ws, id, observer } = await setup()
  const a = await request(x, id, 'observe-int')
  const c = await claimed(x)
  x.started(c.attempt.id, process.pid)
  await report(ws, a.ref, c.attempt.id, { op: 'node.start', node: 'scope' })
  await writeFile(c.attempt.log!, line({ type: 'system', subtype: 'init', session_id: 'sess-2' }) +
    line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 60 && curl x', run_in_background: true } }] } }) +
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'started in background' }] } }) +
    line({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'I will wait for the background task.' }] } }) +
    line({ type: 'result', subtype: 'success', stop_reason: 'end_turn' }) +
    line({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'stopped' }))
  // The process exits normally with scope recorded as running: interrupted.
  await x.finished(c.attempt.id, { code: 0, signal: null })
  let o = await observer.observe()
  let r = runOf(o, a.ref)!
  assert.equal(r.situation, 'interrupted')
  assert.equal(r.hold?.kind, 'interrupted'); assert.equal(r.hold?.human, false)
  assert.equal(r.waiting?.responsible, 'recovery')
  assert.equal(r.attempts.last?.id, c.attempt.id)
  assert.equal(r.process?.alive, false)
  assert.deepEqual(r.process?.log?.ended, { subtype: 'success', stopReason: 'end_turn' })
  assert.equal(r.process?.log?.backgroundStopped, 1)
  assert.equal(r.process?.log?.openTool, null, 'a background command is not an open foreground call')
  // A person resumes; the agent asks and the person answers: the executor holds the next move.
  await x.resume(ws, a.ref, 'Test Person', 'looked: go on', 'cli')
  const c2 = await claimed(x)
  x.started(c2.attempt.id, process.pid)
  await report(ws, a.ref, c2.attempt.id, { op: 'question.ask', question: '', node: 'scope', text: 'Small?', to: 'Test Person' })
  await x.finished(c2.attempt.id, { code: 0, signal: null })
  r = runOf(await observer.observe(), a.ref)!
  assert.equal(r.situation, 'awaiting-person'); assert.equal(r.waiting?.responsible, 'person:Test Person')
  await runOp(ws, a.ref, { op: 'question.answer', question: 'q1', text: 'yes' }, { by: 'Test Person', via: 'browser' })
  r = runOf(await observer.observe(), a.ref)!
  assert.deepEqual(r.inputs.answeredNotTakenUp, ['q1'])
  assert.equal(r.waiting?.responsible, 'executor', 'an answer recorded and no job: the executor\'s move')
  assert.equal(r.queue.job, null, 'observing queues nothing')
  // An external wait with a declared deadline: observable, named, nobody's turn but the external party's.
  await x.afterAnswer(ws, a.ref, 'q1')
  assert.equal(runOf(await observer.observe(), a.ref)!.queue.job?.kind, 'resume', 'queued as the API queues it')
  const c3 = await claimed(x)
  x.started(c3.attempt.id, process.pid)
  await report(ws, a.ref, c3.attempt.id, { op: 'question.take-up', question: 'q1' })
  await report(ws, a.ref, c3.attempt.id, { op: 'node.wait', node: 'scope', reason: 'render on the GPU node', holder: 'comfyui', external: 'comfyui:prompt/abc', deadline: '2026-10-14T06:00:00Z' })
  await x.finished(c3.attempt.id, { code: 0, signal: null })
  r = runOf(await observer.observe(), a.ref)!
  assert.equal(r.situation, 'awaiting-person')
  assert.equal(r.execution?.waiting[0].deadline, '2026-10-14T06:00:00.000Z')
  assert.equal(r.waiting?.responsible, 'external:comfyui:prompt/abc')
  // The person stops the run: a human hold.
  await x.stop(ws, a.ref, 'Test Person', 'circumstances changed', 'browser')
  o = await observer.observe()
  r = runOf(o, a.ref)!
  assert.equal(r.hold?.kind, 'stopped'); assert.equal(r.hold?.human, true)
  assert.equal(r.waiting?.responsible, 'person:Test Person')
})

test('a missing copy is an observation problem, never a finished run; a stale heartbeat makes the executor unavailable', async () => {
  const { x, id, observer, ws } = await setup()
  const a = await request(x, id, 'observe-missing')
  await rename(join(copyDir(ws, a.ref), 'tree'), join(copyDir(ws, a.ref), 'tree-moved'))
  x.heartbeat('autolab', 4242, 'idle')
  x.db.prepare('UPDATE heartbeat SET at = ?').run(new Date(Date.now() - 600_000).toISOString())
  const o = await observer.observe()
  const r = runOf(o, a.ref)!
  assert.ok(r, 'the run is still listed')
  assert.equal(r.source.state, 'copy-missing')
  assert.match(r.source.problem ?? '', /missing/)
  assert.equal(r.situation, null); assert.equal(r.execution, null)
  assert.ok(r.unavailable.record)
  assert.equal(r.queue.job?.state, 'queued', 'its queued job is still seen')
  assert.equal(o.executor.state, 'unavailable')
  assert.ok((o.executor.ageSeconds ?? 0) >= 599)
})

test('settled runs are left out unless asked for; the same run id in two registrations is ambiguous, never merged', async () => {
  const { x, observer, wsOf, extra, id } = await setup(2)
  // IDE runs created in each workspace: same display identity, two creations.
  for (const w of [id, extra[0]]) await createRun(await wsOf(w), { workflow: 'ship', input: { kind: 'braindump', text: 'x', author: 'Test Person' }, executor: { name: 'IDE agent', backend: null }, by: 'IDE agent', via: 'cli', name: 'run-001' })
  const o = await observer.observe()
  const both = o.runs.filter(r => r.identity.run === 'run-001')
  assert.equal(both.length, 2)
  assert.notEqual(both[0].identity.creation, both[1].identity.creation)
  for (const r of both) assert.ok(r.problems.some(p => p.code === 'ambiguous'), JSON.stringify(r.problems))
  // Cancel one: it is settled and left out, then asked for explicitly.
  const w1 = await wsOf(id)
  await runOp(w1, { workflow: 'ship', run: 'run-001' }, { op: 'run.cancel', reason: 'not needed' }, { by: 'Test Person', via: 'cli' })
  const left = (await observer.observe()).runs.filter(r => r.identity.run === 'run-001')
  assert.deepEqual(left.map(r => r.identity.workspace), [extra[0]])
  assert.equal((await observer.observe({ runs: [`${id}:ship/run-001`] })).runs.length, 1, 'an explicit --run is listed even when settled')
  assert.equal((await observer.observe({ terminal: true })).runs.filter(r => r.identity.run === 'run-001').length, 2)
  void x
})

test('a record that changes while it is read is read again; one that keeps changing is said to', async () => {
  const { x, ws, id, observer } = await setup()
  const a = await request(x, id, 'observe-churn')
  const c = await claimed(x)
  x.started(c.attempt.id, process.pid)
  let writes = 0
  const once = await observer.observe({ between: async ref => { if (ref.run === a.ref.run && writes++ === 0) await report(ws, a.ref, c.attempt.id, { op: 'node.start', node: 'scope' }) } })
  const r1 = runOf(once, a.ref)!
  assert.equal(r1.source.reads, 2); assert.equal(r1.source.consistent, true)
  assert.equal(r1.execution?.active.join(), 'scope', 'the second read is what is reported')
  let k = 0
  const churn = await observer.observe({ between: async ref => { if (ref.run === a.ref.run) await report(ws, a.ref, c.attempt.id, { op: 'node.progress', node: 'scope', text: `note ${k++}` }) } })
  const r2 = runOf(churn, a.ref)!
  assert.equal(r2.source.reads, 3); assert.equal(r2.source.consistent, false)
  assert.ok(r2.problems.some(p => p.code === 'changing'))
})

test('the CLI and the HTTP route agree on identity and state', async () => {
  const { x, ws, id, registry, area } = await setup()
  const a = await request(x, id, 'observe-parity')
  const c = await claimed(x)
  x.started(c.attempt.id, process.pid)
  await report(ws, a.ref, c.attempt.id, { op: 'node.start', node: 'scope' })
  await x.finished(c.attempt.id, { code: 0, signal: null })
  const { stdout } = await pexec(process.execPath, [join(pkg, 'cli', 'wfe.ts'), 'observe', '--json', '--registry', registry, '--area', area])
  const cli = JSON.parse(stdout) as Observation
  const srv = createServer(createHandler({ registryFile: registry, area, allowedOrigins: [], allowedHosts: ['127.0.0.1'], exec: x }))
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  try {
    const api = await (await fetch(`http://127.0.0.1:${(srv.address() as { port: number }).port}/api/observe`)).json() as Observation
    const facts = (o: Observation) => o.runs.map((r: ObservedRun) => ({ identity: r.identity, seq: r.seq, situation: r.situation, hold: r.hold, waiting: r.waiting, attempts: r.attempts, source: { ...r.source, readAt: '' } }))
    assert.equal(cli.schema, 'ag.wfe-observation.v1')
    assert.deepEqual(facts(cli), facts(api))
    assert.equal(cli.runs[0].situation, 'interrupted')
  } finally { srv.close() }
})
