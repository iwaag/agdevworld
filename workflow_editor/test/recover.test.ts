// observer p3 step 4: `run.recover` — a recovering agent continues an
// interrupted or unknown hold for an incident (docs/observation.md). Only the
// holds a process end derived; the attempt and sequence guards; one writer per
// copy; the budget since the last person-originated control; the recovering
// run's own attempt as the actor; the brief that says so; the HTTP ops route
// closed to it; the CLI's refusals.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createHandler } from '../server/api.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runOp } from '../server/runs.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import { notableEvents, situation, type OpInput, type RunRef } from '../shared/run.ts'

const pexec = promisify(execFile)
const pkg = fileURLToPath(new URL('..', import.meta.url))
let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-recover-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = (id: string, agent: string) => `schema: ag.workflow.v2
documentation: {policy: manual}
id: ${id}
name: ${id}
intent: |
  Do it.
execution: {agent: ${agent}}
repositories:
  root: {path: ., access: editable}
nodes:
  work:
    type: do
    description: Do the work.
  more:
    type: do
    description: Do more.
edges:
  - {from: work, to: more}
`

let n = 0
async function setup() {
  const area = join(root, `area-${++n}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, `pj-p${n}`)
  const r = await createProject({ dir, id: `p${n}`, name: `P${n}`, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), WF('ship', 'ship-agent'))
  await writeFile(join(dir, 'devdocs', 'workflows', 'recover.yaml'), WF('recover', 'recovery-agent'))
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflows'])
  const remote = join(area, 'remotes', `pj-p${n}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote])
  await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  const x = new ExecStore({ registryFile: registry, area })
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  return { area, registry, x, ws, id: `p${n}` }
}
const report = (ws: Workspace, ref: RunRef, attempt: string, op: OpInput) => runOp(ws, ref, { ...op, attempt }, { by: 'autolab', via: 'cli' })
const claimed = async (x: ExecStore) => { const c = await x.claim('test-harness'); assert.ok('attempt' in c, JSON.stringify(c)); return c as Exclude<typeof c, { idle: string }> }
const record = async (ws: Workspace, ref: RunRef) => (await readRun(ws, ref)).record!
// A process that has already ended: its pid is not alive.
async function deadPid(): Promise<number> {
  const c = spawn('true')
  await new Promise(r => c.on('exit', r))
  return c.pid!
}
// Runs the target to an interruption: an attempt that exits with `work` running.
async function interrupt(x: ExecStore, ws: Workspace, ref: RunRef, started = true) {
  const c = await claimed(x)
  assert.equal(c.ref.run, ref.run)
  x.started(c.attempt.id, await deadPid())
  if (started) await report(ws, ref, c.attempt.id, { op: 'node.start', node: 'work' })
  await x.finished(c.attempt.id, { code: 0, signal: null })
  return c.attempt.id
}
const code = (re: RegExp) => (e: unknown) => e instanceof RequestError || (e as Error).name === 'RunError' ? re.test(`${(e as RequestError).detail ? JSON.stringify((e as RequestError).detail) : ''} ${(e as Error).message}`) : false

test('an interrupted run is continued by recovery: recorded with the incident and the ended attempt, queued, and briefed as such', async () => {
  const { x, ws, id } = await setup()
  const a = (await x.request({ workspace: id, workflow: 'ship', text: 'build', author: 'Pat', receipt: 'req-recover-1', via: 'browser' })).ref
  const ended = await interrupt(x, ws, a)
  let rec = await record(ws, a)
  assert.equal(rec.control.hold?.kind, 'interrupted')
  const res = await x.recover(ws, a, { incident: 'iabc123', attempt: ended, reason: 'the copy has no uncommitted work; work was only started', by: 'Omni Agent', via: 'cli', expectSeq: rec.seq })
  rec = res.record
  assert.equal(rec.control.hold, null)
  assert.deepEqual(rec.recoveries?.map(r => [r.incident, r.attempt, r.lifted, r.by]), [['iabc123', ended, 'interrupted', 'Omni Agent']])
  assert.equal(rec.history.at(-1)!.receipt, `recover:iabc123:${ended}`)
  assert.equal(res.job?.kind, 'resume')
  assert.match(res.job!.reason, /^recover: incident iabc123/)
  // The same incident and attempt again: nothing new.
  const dup = await x.recover(ws, a, { incident: 'iabc123', attempt: ended, reason: 'again', by: 'Omni Agent', via: 'cli' })
  assert.equal(dup.duplicate, true)
  assert.equal((await record(ws, a)).recoveries?.length, 1)
  assert.equal(dup.job?.id, res.job?.id)
  // The continuation's brief says it was continued by recovery.
  const c = await claimed(x)
  assert.match(c.brief, /This run was continued by recovery: Omni Agent lifted the interrupted hold after attempt .* for incident iabc123/)
  // Coordination says it in words.
  assert.ok(notableEvents(await record(ws, a)).some(e => e.type === 'resumed' && /continued by recovery \(Omni Agent, incident iabc123\)/.test(e.text)))
})

test('a person\'s hold, another episode, an outdated view and a live process are refused', async () => {
  const { x, ws, id } = await setup()
  const a = (await x.request({ workspace: id, workflow: 'ship', text: 'build', author: 'Pat', receipt: 'req-recover-2', via: 'browser' })).ref
  const ended = await interrupt(x, ws, a)
  const seq = (await record(ws, a)).seq
  await assert.rejects(x.recover(ws, a, { incident: 'i1', attempt: 'a-other', reason: 'r', by: 'R', via: 'cli' }), code(/recover-stale/))
  await assert.rejects(x.recover(ws, a, { incident: 'i1', attempt: ended, reason: 'r', by: 'R', via: 'cli', expectSeq: seq - 1 }), code(/outdated|changed since it was read/))
  await assert.rejects(x.recover(ws, a, { incident: 'i1', attempt: ended, reason: 'r', via: 'cli' }), code(/recover-actor|who recovers/))
  // A process of the run still alive on this host: one writer per copy.
  x.db.prepare('UPDATE attempts SET pid = ? WHERE id = ?').run(process.pid, ended)
  await assert.rejects(x.recover(ws, a, { incident: 'i1', attempt: ended, reason: 'r', by: 'R', via: 'cli' }), code(/recover-process-alive/))
  x.db.prepare('UPDATE attempts SET pid = ? WHERE id = ?').run(await deadPid(), ended)
  // A person's stop is binding.
  await x.resume(ws, a, 'Pat', 'go on', 'browser')
  const c = await claimed(x)
  x.started(c.attempt.id, await deadPid())
  await x.stop(ws, a, 'Pat', 'hold it', 'browser')
  await x.finished(c.attempt.id, { code: null, signal: 'SIGTERM' })
  assert.equal((await record(ws, a)).control.hold?.kind, 'stopped')
  await assert.rejects(x.recover(ws, a, { incident: 'i2', attempt: c.attempt.id, reason: 'r', by: 'R', via: 'cli' }), code(/recover-human-hold/))
  // A cancelled run.
  await x.cancel(ws, a, 'Pat', 'not needed', 'browser')
  await assert.rejects(x.recover(ws, a, { incident: 'i3', attempt: c.attempt.id, reason: 'r', by: 'R', via: 'cli' }), code(/run-cancelled/))
})

test('the budget: two recoveries since the last person-originated control, then a person decides; a person\'s resume restores it', async () => {
  const { x, ws, id } = await setup()
  const a = (await x.request({ workspace: id, workflow: 'ship', text: 'build', author: 'Pat', receipt: 'req-recover-3', via: 'browser' })).ref
  let ended = await interrupt(x, ws, a)
  await x.recover(ws, a, { incident: 'i1', attempt: ended, reason: 'first', by: 'R', via: 'cli' })
  ended = await interrupt(x, ws, a, false)
  await x.recover(ws, a, { incident: 'i2', attempt: ended, reason: 'second', by: 'R', via: 'cli' })
  ended = await interrupt(x, ws, a, false)
  await assert.rejects(x.recover(ws, a, { incident: 'i3', attempt: ended, reason: 'third', by: 'R', via: 'cli' }), code(/recover-budget/))
  // A re-described incident of the same episode does not buy another one either.
  await assert.rejects(x.recover(ws, a, { incident: 'i3-reworded', attempt: ended, reason: 'third', by: 'R', via: 'cli' }), code(/recover-budget/))
  await x.resume(ws, a, 'Pat', 'looked; continue', 'browser')
  ended = await interrupt(x, ws, a, false)
  const ok = await x.recover(ws, a, { incident: 'i4', attempt: ended, reason: 'after the person', by: 'R', via: 'cli' })
  assert.equal(ok.record.recoveries?.length, 3)
})

test('from a recovery run\'s attempt the actor is that run\'s agent with its run and attempt; a run cannot recover itself', async () => {
  const { x, ws, id } = await setup()
  const a = (await x.request({ workspace: id, workflow: 'ship', text: 'build', author: 'Pat', receipt: 'req-recover-4', via: 'browser' })).ref
  const ended = await interrupt(x, ws, a)
  const rr = (await x.request({ workspace: id, workflow: 'recover', text: 'investigate incident i9', author: 'Observer', receipt: 'req-recover-5', via: 'zulip' })).ref
  const rc = await claimed(x)
  assert.equal(rc.ref.workflow, 'recover')
  x.started(rc.attempt.id, process.pid)
  await assert.rejects(x.recover(ws, rr, { incident: 'i9', attempt: 'x', reason: 'r', recoveryAttempt: rc.attempt.id, via: 'cli' }), code(/recover-actor|its own hold|not held/))
  await assert.rejects(x.recover(ws, a, { incident: 'i9', attempt: ended, reason: 'r', by: 'Someone Else', recoveryAttempt: rc.attempt.id, via: 'cli' }), code(/records as recovery-agent/))
  const res = await x.recover(ws, a, { incident: 'i9', attempt: ended, reason: 'nothing ran after the last record', recoveryAttempt: rc.attempt.id, via: 'cli' })
  const r = res.record.recoveries!.at(-1)!
  assert.equal(r.by, 'recovery-agent')
  assert.deepEqual(r.agent, { workspace: id, workflow: 'recover', run: rr.run, attempt: rc.attempt.id })
  assert.equal(situation(res.record), 'idle', 'not held; its continuation is queued behind the recovery run in the slot')
  assert.equal(res.job?.state, 'queued')
  // The recovery run ends; the continuation takes the slot.
  await x.finished(rc.attempt.id, { code: 0, signal: null })
  const next = await claimed(x)
  assert.equal(next.ref.run, a.run)
})

test('the HTTP ops route does not offer run.recover; the CLI records it and refuses a person\'s hold', async () => {
  const { x, ws, id, registry, area } = await setup()
  const a = (await x.request({ workspace: id, workflow: 'ship', text: 'build', author: 'Pat', receipt: 'req-recover-6', via: 'browser' })).ref
  const ended = await interrupt(x, ws, a)
  const srv = createServer(createHandler({ registryFile: registry, area, allowedOrigins: [], allowedHosts: ['127.0.0.1'], exec: x }))
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  try {
    const res = await fetch(`http://127.0.0.1:${(srv.address() as { port: number }).port}/api/workspaces/${id}/runs/ship/${a.run}/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'run.recover', incident: 'i1', attempt: ended, reason: 'r', by: 'Mallory' }) })
    assert.equal(res.status, 400)
  } finally { srv.close() }
  x.close()
  const cli = (args: string[]) => pexec(process.execPath, [join(pkg, 'cli', 'wfe.ts'), 'run', ...args, '--registry', registry, '--area', area, '--workspace', id, '--json'], { env: { ...process.env, WFE_ATTEMPT: '' } }).then(r => ({ code: 0, out: JSON.parse(r.stdout) }), e => ({ code: e.code as number, out: JSON.parse(e.stdout || '{}') }))
  const ok = await cli(['recover', `ship/${a.run}`, '--incident', 'icli1', '--attempt', ended, '--reason', 'looked at the copy', '--by', 'Omni Agent'])
  assert.equal(ok.code, 0, JSON.stringify(ok.out))
  assert.equal(ok.out.ok, true)
  const x2 = new ExecStore({ registryFile: registry, area })
  const rec = await record(ws, a)
  assert.equal(rec.recoveries?.at(-1)?.incident, 'icli1')
  // A person's stop: refused with the code.
  const c = await claimed(x2)
  x2.started(c.attempt.id, await deadPid())
  await x2.stop(ws, a, 'Pat', 'hold it', 'browser')
  await x2.finished(c.attempt.id, { code: null, signal: 'SIGTERM' })
  x2.close()
  const refused = await cli(['recover', `ship/${a.run}`, '--incident', 'icli2', '--attempt', c.attempt.id, '--reason', 'r', '--by', 'Omni Agent'])
  assert.equal(refused.code, 1)
  assert.match(refused.out.error, /never lifts a person's hold/)
})
