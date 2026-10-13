// p6 step 3: workflow-scoped execution settings — the agent identity, the
// host profile and the project's guides are part of the definition, frozen
// with the run and recorded with each attempt; the execution host launches
// only what it offers.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { definitionProjection, semanticDigest } from '../shared/canonical.ts'
import { compile, COMPILER_VERSION } from '../shared/compile.ts'
import { emptyWorkflow, type Workflow } from '../shared/model.ts'
import { validateWorkflow } from '../shared/validate.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { listRuns, readRun } from '../server/runs.ts'
import { Workspace } from '../server/workspace.ts'
import { newWorkflowText, parseWorkflow } from '../server/yamlDoc.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-settings-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = `schema: ag.workflow.v2
id: make
name: Make
intent: |
  Make the thing and have the person confirm it.
documentation: {policy: default}
execution:
  agent: ppt-agent
  profile: sonnet
  guides: [agent/guide.md, agent/make.md]
intake:
  zulip: requests
repositories:
  root: {path: ., access: editable}
nodes:
  make:
    type: do
    description: Make it.
  present:
    type: talk
    confirms: result
    description: Present it and ask for confirmation.
edges:
  - {from: make, to: present}
`
const base = (): Workflow => ({ ...emptyWorkflow('w', 'W'), intake: { zulip: '' }, intent: 'x', nodes: { a: { type: 'talk', name: '', description: 'd', repositories: [] } } })

test('model: execution, intake and confirms are read, written back and validated', () => {
  const r = parseWorkflow(WF)
  assert.ok(r.ok)
  const w = r.model
  assert.deepEqual(w.execution, { agent: 'ppt-agent', profile: 'sonnet', guides: ['agent/guide.md', 'agent/make.md'] })
  assert.deepEqual(w.intake, { zulip: 'requests' })
  assert.equal(w.nodes.present.confirms, 'result')
  assert.deepEqual(validateWorkflow(w).filter(i => i.severity === 'error'), [])
  const again = parseWorkflow(newWorkflowText(w))
  assert.ok(again.ok)
  assert.deepEqual(again.model.execution, w.execution)
  assert.equal(again.model.nodes.present.confirms, 'result')
  // Legacy definitions with no intake retain their original settings and digest.
  const legacy = parseWorkflow(newWorkflowText(base()))
  assert.ok(legacy.ok)
  assert.equal(legacy.model.intake.zulip, '')
  assert.doesNotMatch(newWorkflowText(legacy.model), /execution|intake|confirms/)
  const codes = (w: Workflow) => validateWorkflow(w).filter(i => i.severity === 'error').map(i => i.code).sort()
  assert.deepEqual(codes({ ...base(), execution: { agent: 'Bad Agent', profile: 'x y', guides: ['../out.md', '/abs.md'] } }), ['execution-agent', 'execution-guide-path', 'execution-guide-path', 'execution-profile'])
  assert.deepEqual(codes({ ...base(), intake: { zulip: 'everything' } }), ['intake-mode'])
  const two = base(); two.nodes.b = { type: 'talk', name: '', description: 'd', repositories: [], confirms: 'result' }; two.nodes.a.confirms = 'result'
  assert.deepEqual(codes(two), ['confirms-duplicate'])
  const onDo = base(); onDo.nodes.a = { type: 'do', name: '', description: 'd', repositories: [], confirms: 'result' }
  assert.deepEqual(codes(onDo), ['confirms-type'])
  const odd = base(); odd.nodes.a.confirms = 'plan'
  assert.deepEqual(codes(odd), ['confirms-kind'])
})

test('definition approval covers the settings when declared; workflows without them keep their digest', async () => {
  const w = base()
  const plain = definitionProjection(w) as Record<string, unknown>
  assert.ok(!('execution' in plain) && !('intake' in plain), 'no new keys for a workflow that declares none')
  const before = await semanticDigest('definition', w)
  const withProfile = { ...w, execution: { agent: '', profile: 'opus', guides: [] } }
  assert.notEqual(await semanticDigest('definition', withProfile), before, 'changing the profile stales the approval')
  const withIntake = { ...w, intake: { zulip: 'requests' } }
  assert.notEqual(await semanticDigest('definition', withIntake), before)
  const confirming = structuredClone(w); confirming.nodes.a.confirms = 'result'
  assert.notEqual(await semanticDigest('definition', confirming), before)
})

test('the compiler (since v2) freezes the result confirmation with the graph', () => {
  const r = parseWorkflow(WF)
  assert.ok(r.ok)
  const c = compile(r.model)
  assert.ok(c.ok)
  assert.equal(COMPILER_VERSION, 'ag.wfe-compile.v3') // v3 (p8/ex2): the custom documentation policy
  assert.equal(c.graph.compiler, COMPILER_VERSION)
  assert.deepEqual(c.graph.nodes.present, { type: 'talk', confirms: 'result' })
  assert.deepEqual(c.graph.nodes.make, { type: 'do' })
})

async function setup(guides = true) {
  const area = join(root, `area-${Math.random().toString(36).slice(2, 8)}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-p')
  const r = await createProject({ dir, id: 'p', name: 'P', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'make.yaml'), WF)
  if (guides) {
    await mkdir(join(dir, 'agent'))
    await writeFile(join(dir, 'agent', 'guide.md'), '# p agent\nFacts of the project.\n')
    await writeFile(join(dir, 'agent', 'make.md'), '# make runs\n')
  }
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const x = new ExecStore({ registryFile: registry, area })
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  return { x, ws, dir }
}
const OFFER = { profiles: { sonnet: 'claude_code / anthropic/claude-sonnet-5', stub: 'fake / m' }, contract: { name: 'wfrun/guide.md', sha256: 'a'.repeat(64) } }
const hash = (t: string) => createHash('sha256').update(t).digest('hex')

test('a run is performed as the definition\'s agent; the host is recorded beside it and owns the run', async () => {
  const { x, ws } = await setup()
  const r = await x.request({ workspace: ws.reg.id, workflow: 'make', text: 'Make a thing.', author: 'Test Person', receipt: 'settings-req-0001', via: 'browser' })
  const rec = (await readRun(ws, r.ref)).record!
  assert.deepEqual(rec.executor, { name: 'ppt-agent', backend: null, host: 'autolab' })
  const [s] = await listRuns(ws)
  assert.equal(s.executor, 'ppt-agent')
  assert.equal(s.executorHost, 'autolab')
  assert.equal(await x.holder(ws), 'make/run-001', 'the host owns it although the agent has another name')
  // So a second request waits while this one is queued.
  await assert.rejects(x.request({ workspace: ws.reg.id, workflow: 'make', text: 'Another.', author: 'Test Person', receipt: 'settings-req-0002', via: 'browser' }), /held by run make\/run-001/)
  x.close()
})

test('claim: the workflow\'s profile and guides are resolved, recorded with attempt.begin and handed to the host', async () => {
  const { x, ws } = await setup()
  const r = await x.request({ workspace: ws.reg.id, workflow: 'make', text: 'Make a thing.', author: 'Test Person', receipt: 'settings-req-0003', via: 'browser' })
  const c = await x.claim('fallback / label', OFFER)
  assert.ok('attempt' in c, JSON.stringify(c))
  assert.equal(c.execution.agent, 'ppt-agent')
  assert.equal(c.execution.profile, 'sonnet')
  assert.equal(c.execution.backend, 'claude_code / anthropic/claude-sonnet-5', 'the workflow\'s profile, not the host default')
  assert.deepEqual(c.execution.guides.map(g => [g.path, g.sha256, g.text.split('\n')[0]]), [['agent/guide.md', hash('# p agent\nFacts of the project.\n'), '# p agent'], ['agent/make.md', hash('# make runs\n'), '# make runs']])
  assert.match(c.brief, /you perform this run as ppt-agent; the execution host autolab launched you/)
  const rec = (await readRun(ws, r.ref)).record!
  assert.deepEqual(rec.control.attempt?.settings, {
    agent: 'ppt-agent', profile: 'sonnet', backend: 'claude_code / anthropic/claude-sonnet-5', contract: OFFER.contract,
    guides: [{ path: 'agent/guide.md', sha256: hash('# p agent\nFacts of the project.\n') }, { path: 'agent/make.md', sha256: hash('# make runs\n') }],
    catalog: { state: 'supplied', sha256: (rec.context.catalog as { sha256: string }).sha256, templates: 2 }, // p7/ex1: the run's snapshot
  })
  assert.equal(rec.control.attempt?.backend, 'claude_code / anthropic/claude-sonnet-5')
  const entry = rec.history.find(h => h.op === 'attempt.begin') as unknown as { settings: unknown }
  assert.deepEqual(entry.settings, rec.control.attempt?.settings, 'the history entry carries the settings')
  assert.equal(x.attemptRow(c.attempt.id)?.backend, 'claude_code / anthropic/claude-sonnet-5')
  x.close()
})

test('claim refuses what the host cannot launch as declared: an unknown profile, a missing guide', async () => {
  {
    const { x, ws } = await setup()
    await x.request({ workspace: ws.reg.id, workflow: 'make', text: 'Make.', author: 'Test Person', receipt: 'settings-req-0004', via: 'browser' })
    const c = await x.claim('fallback', { profiles: { stub: 'fake / m' } })
    assert.deepEqual(c, { idle: 'no queued job' })
    const job = (await x.runView(ws.reg.id, { workflow: 'make', run: 'run-001' })).jobs[0]
    assert.equal(job.state, 'dropped')
    assert.match(job.note ?? '', /asks for execution profile "sonnet", which this execution host does not offer \(stub\)/)
    const rec = (await readRun(ws, { workflow: 'make', run: 'run-001' })).record!
    assert.equal(rec.control.attempts, 0, 'nothing began')
    x.close()
  }
  {
    const { x, ws } = await setup(false)
    await x.request({ workspace: ws.reg.id, workflow: 'make', text: 'Make.', author: 'Test Person', receipt: 'settings-req-0005', via: 'browser' })
    assert.deepEqual(await x.claim('fallback', OFFER), { idle: 'no queued job' })
    assert.match((await x.runView(ws.reg.id, { workflow: 'make', run: 'run-001' })).jobs[0].note ?? '', /guide agent\/guide\.md cannot be read/)
    x.close()
  }
})
