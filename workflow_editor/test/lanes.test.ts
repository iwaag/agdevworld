// project_migration p8: worker lanes. A worker declares extra lanes in
// workers.json; a workflow names the lane its runs are claimed in
// (execution.lane, frozen as executor.lane). Covered: a conversation-lane job
// is claimed while a long default-lane attempt holds the default slot, the
// lane's own capacity, a default claim never takes another lane's job, a lane
// the worker does not offer is served by its default lane, the views list
// every open attempt with `busy` still the default lane's, and a worker
// without lanes keeps exactly its one slot.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { loadWorkers } from '../server/workers.ts'
import { Workspace } from '../server/workspace.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-lanes-'))
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

let n = 0
async function setup(workers: unknown) {
  const area = join(root, `area-${++n}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, `pj-l${n}`)
  const r = await createProject({ dir, id: `l${n}`, name: `L${n}`, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'long.yaml'), WF('long'))
  await writeFile(join(dir, 'devdocs', 'workflows', 'front.yaml'), WF('front', 'execution:\n  lane: conversation\n'))
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflows'])
  await writeFile(join(area, 'workers.json'), JSON.stringify(workers))
  const x = new ExecStore({ registryFile: registry, area })
  const ws = new Workspace((await loadRegistry(registry)).workspaces.find(w => w.id === `l${n}`)!)
  const request = (workflow: string, receipt: string) => x.request({ workspace: `l${n}`, workflow, text: 'Do the thing.', author: 'Test Person', receipt, via: 'browser' })
  return { area, x, ws, id: `l${n}`, request }
}
const OFFER = { profiles: { '': 'fake / m' } }
const WITH_LANE = { default: 'studio', workers: { studio: { local: true, label: 'the studio', lanes: { conversation: 1 } } } }

test('lanes: a conversation is claimed while a long attempt holds the default slot', async () => {
  const s = await setup(WITH_LANE)
  assert.deepEqual(loadWorkers(s.area).workers.studio.lanes, { default: 1, conversation: 1 })
  const long = await s.request('long', 'lanes-req-0001')
  const c1 = await s.request('front', 'lanes-req-0002')
  const c2 = await s.request('front', 'lanes-req-0003')
  const rec = async (ref: typeof long.ref) => (await readRun(await runSpace(s.ws, ref), ref)).record!
  assert.equal((await rec(c1.ref)).executor.lane, 'conversation', 'the lane is frozen into the record')
  assert.equal((await rec(long.ref)).executor.lane, undefined, 'the default lane is not recorded')

  // The default claim takes the long run, though the conversation jobs are queued too.
  const a = await s.x.claim('fake / m', OFFER)
  assert.ok('attempt' in a, JSON.stringify(a))
  assert.equal(a.ref.workflow, 'long')
  assert.equal(a.attempt.lane, null)
  assert.equal(a.lane, 'default')
  // Held: the default lane is idle and never takes a conversation job.
  const idle = await s.x.claim('fake / m', OFFER)
  assert.ok('idle' in idle && /the slot is held by attempt/.test(idle.idle), JSON.stringify(idle))

  // The conversation lane claims the oldest conversation job.
  const b = await s.x.claim('fake / m', OFFER, { lane: 'conversation' })
  assert.ok('attempt' in b, JSON.stringify(b))
  assert.equal(b.ref.run, c1.ref.run)
  assert.equal(b.attempt.lane, 'conversation')
  assert.equal(b.lane, 'conversation')
  // Its one slot is held now: the second conversation waits.
  const held = await s.x.claim('fake / m', OFFER, { lane: 'conversation' })
  assert.ok('idle' in held && /in lane conversation is held by attempt/.test(held.idle), JSON.stringify(held))
  assert.equal((await s.x.runView(s.id, c2.ref)).jobs[0].state, 'queued')

  // The views: busy is the default lane's, slots list both.
  const w = s.x.workersState().find(x => x.id === 'studio')!
  assert.equal(w.busy?.attempt, a.attempt.id)
  assert.deepEqual(w.slots.map(x => [x.attempt, x.lane]), [[a.attempt.id, 'default'], [b.attempt.id, 'conversation']])
  assert.deepEqual(w.lanes, { default: 1, conversation: 1 })
  assert.match(w.detail, /conversation lane: front\//)
  const q = s.x.queueView()
  assert.equal(q.busy?.id, a.attempt.id)
  assert.equal(q.slots.length, 2)
  // A restart takes back the processes of every lane, each with its lane.
  assert.deepEqual(s.x.workerDue('studio').attempts.map(x => x.lane), [null, 'conversation'])

  // The conversation ends: the next one is the conversation lane's, not the default's.
  s.x.started(b.attempt.id, process.pid)
  await s.x.finished(b.attempt.id, { code: 0, signal: null })
  assert.ok('idle' in await s.x.claim('fake / m', OFFER), 'the default slot is still held')
  const d = await s.x.claim('fake / m', OFFER, { lane: 'conversation' })
  assert.ok('attempt' in d, JSON.stringify(d))
  assert.ok([c1.ref.run, c2.ref.run].includes(d.ref.run))
  assert.equal(d.ref.workflow, 'front')

  // A lane the worker does not declare is refused, not silently served.
  await assert.rejects(s.x.claim('fake / m', OFFER, { lane: 'batch' }), /worker "studio" has no lane "batch"/)
})

test('lanes: a default claim with only conversation jobs queued stays idle', async () => {
  const s = await setup(WITH_LANE)
  await s.request('front', 'lanes-req-0101')
  const r = await s.x.claim('fake / m', OFFER)
  assert.ok('idle' in r && r.idle === 'no queued job', JSON.stringify(r))
  const c = await s.x.claim('fake / m', OFFER, { lane: 'conversation' })
  assert.ok('attempt' in c, JSON.stringify(c))
})

test('lanes: a lane the worker does not offer is served by its default lane', async () => {
  const s = await setup({ default: 'studio', workers: { studio: { local: true } } })
  const c = await s.request('front', 'lanes-req-0201')
  assert.equal((await readRun(await runSpace(s.ws, c.ref), c.ref)).record!.executor.lane, 'conversation')
  const a = await s.x.claim('fake / m', OFFER)
  assert.ok('attempt' in a, JSON.stringify(a))
  assert.equal(a.ref.run, c.ref.run)
  assert.equal(a.attempt.lane, null)
  await assert.rejects(s.x.claim('fake / m', OFFER, { lane: 'conversation' }), /has no lane "conversation"/)
})

test('lanes: without lanes a worker keeps exactly one slot', async () => {
  const s = await setup({ default: 'studio', workers: { studio: { local: true } } })
  assert.deepEqual(loadWorkers(s.area).workers.studio.lanes, { default: 1 })
  await s.request('long', 'lanes-req-0301')
  await s.request('long', 'lanes-req-0302')
  const a = await s.x.claim('fake / m', OFFER)
  assert.ok('attempt' in a, JSON.stringify(a))
  const b = await s.x.claim('fake / m', OFFER)
  assert.ok('idle' in b && b.idle === `the slot is held by attempt ${a.attempt.id} (${s.id} long/${a.ref.run})`, JSON.stringify(b))
  const w = s.x.workersState()[0]
  assert.deepEqual(w.lanes, { default: 1 })
  assert.equal(w.slots.length, 1)
})

test('lanes: workers.json is checked', async () => {
  const bad = async (lanes: unknown, re: RegExp) => {
    const area = join(root, `bad-${++n}`)
    await rm(area, { recursive: true, force: true })
    await import('node:fs/promises').then(m => m.mkdir(area, { recursive: true }))
    await writeFile(join(area, 'workers.json'), JSON.stringify({ workers: { studio: { local: true, lanes } } }))
    assert.throws(() => loadWorkers(area), re)
  }
  await bad({ default: 2 }, /the "default" lane always has one slot/)
  await bad({ Chat: 1 }, /lane "Chat" must match/)
  await bad({ conversation: 0 }, /needs a capacity of 1 or more/)
  await bad(['conversation'], /"lanes" must map lane names/)
})

test('lanes: execution.lane round-trips, is validated and is part of the definition', async () => {
  const { parseWorkflow, newWorkflowText } = await import('../server/yamlDoc.ts')
  const { validateWorkflow } = await import('../shared/validate.ts')
  const { semanticDigest } = await import('../shared/canonical.ts')
  const p = parseWorkflow(WF('front', 'execution:\n  lane: conversation\n'))
  assert.ok(p.ok)
  const w = p.model
  assert.equal(w.execution.lane, 'conversation')
  const again = parseWorkflow(newWorkflowText(w))
  assert.ok(again.ok)
  assert.equal(again.model.execution.lane, 'conversation')
  assert.ok(!validateWorkflow(w).some(i => i.code === 'execution-lane'))
  assert.ok(validateWorkflow({ ...w, execution: { ...w.execution, lane: 'Chat Lane' } }).some(i => i.code === 'execution-lane'))
  const plain = parseWorkflow(WF('front'))
  assert.ok(plain.ok)
  assert.notEqual(await semanticDigest('definition', w), await semanticDigest('definition', plain.model))
})
