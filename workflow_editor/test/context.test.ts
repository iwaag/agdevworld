// workflow_editor p13: scoped context — the local override store (revisions,
// concurrent edits, removal), the resolver (scope isolation, guide
// deduplication, absent and unreadable sources), the attempt's snapshot
// and the session fingerprint.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextChanges, fingerprintOf, renderContext } from '../shared/context.ts'
import { configChanges, sessionConfig } from '../shared/run.ts'
import { createProject } from '../server/create.ts'
import { resolveContext } from '../server/context.ts'
import { ContextStore, overrideTarget } from '../server/contextStore.ts'
import { runContextView } from '../server/contextView.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { RequestError, Workspace } from '../server/workspace.ts'


let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-context-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = (id: string, guides: string) => `schema: ag.workflow.v2
id: ${id}
name: ${id}
intent: |
  Make ${id}.
documentation: {policy: manual}
execution:
  agent: p-agent
  guides: [${guides}]
repositories:
  root: {path: ., access: editable}
nodes:
  a:
    type: do
    description: Do it.
`

async function setup() {
  const area = join(root, `area-${Math.random().toString(36).slice(2, 8)}`)
  const registry = join(area, 'registry.json')
  const mk = async (id: string) => {
    const dir = join(area, `pj-${id}`)
    const r = await createProject({ dir, id, name: id.toUpperCase(), intent: `Project ${id} intent.`, goals: [`${id} goal`], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
    assert.ok(r.ok, r.message)
    await mkdir(join(dir, 'agent'))
    await writeFile(join(dir, 'agent', 'guide.md'), `# ${id} guide\n`)
    await writeFile(join(dir, 'agent', 'make.md'), `# ${id} make\n`)
    await writeFile(join(dir, 'devdocs', 'workflows', 'make.yaml'), WF('make', 'agent/guide.md, agent/make.md'))
    await writeFile(join(dir, 'devdocs', 'workflows', 'other.yaml'), WF('other', 'agent/guide.md'))
    const y = join(dir, 'project.yaml')
    await writeFile(y, `${await readFile(y, 'utf8')}guides: [agent/guide.md]\n`)
    await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflows'])
    return dir
  }
  const dir = await mk('p')
  await mk('q')
  const regs = (await loadRegistry(registry)).workspaces
  const ws = new Workspace(regs.find(w => w.project === 'p')!)
  const ws2 = new Workspace(regs.find(w => w.project === 'q')!)
  const x = new ExecStore({ registryFile: registry, area })
  const ctx = { registryFile: registry, area }
  return { area, registry, dir, ws, ws2, x, ctx, store: new ContextStore(area) }
}
const OFFER = { profiles: {}, contract: { name: 'wfrun/guide.md', sha256: 'c'.repeat(64) } }

test('store: revisions with author and exact content, removal, conflicts on an unseen revision, hand edits kept, ids validated', async () => {
  const { store, area } = await setup()
  const t = overrideTarget('project', 'p')
  const a = await store.write(t, 'Use metric units.', { by: 'Dev', base: null })
  assert.equal(a.changed, true)
  assert.equal(a.state.text, 'Use metric units.\n')
  assert.equal(a.state.revision, 1)
  await assert.rejects(store.write(t, 'Other', { by: 'Agent', base: null }), (e: unknown) => e instanceof RequestError && e.status === 409 && (e.detail as { code: string }).code === 'context-conflict')
  const b = await store.write(t, 'Use SI units.', { by: 'Agent', base: a.state.sha256 })
  assert.equal(b.state.revision, 2)
  assert.equal((await store.write(t, 'Use SI units.', { by: 'Agent', base: b.state.sha256 })).changed, false, 'the same content is no new revision')
  // A hand edit is recorded as its own revision before the next write.
  await writeFile(join(area, '.local', 'contexts', 'projects', 'p', 'project.md'), 'Hand edit.\n')
  const hand = await store.read(t)
  assert.equal(hand.external, true); assert.equal(hand.revision, null)
  const c = await store.write(t, null, { by: 'Dev', base: hand.sha256 })
  assert.equal(c.state.text, null)
  const h = await store.history(t)
  assert.deepEqual(h.map(r => [r.rev, r.by, r.text, !!r.external]), [[1, 'Dev', 'Use metric units.\n', false], [2, 'Agent', 'Use SI units.\n', false], [3, 'edited outside WFE', 'Hand edit.\n', true], [4, 'Dev', null, false]])
  assert.throws(() => overrideTarget('project', '../x'), /must match/)
  assert.throws(() => overrideTarget('workflow', 'p'), /workflow must match/)
  assert.throws(() => overrideTarget('run', 'p'), /scope is/)
})

test('resolver: scopes and provenance, one source per guide, project overrides stay in their project, a missing override is absent and an unreadable guide an error', async () => {
  const { ws, ws2, ctx, store, dir } = await setup()
  await store.write({ scope: 'system' }, 'Write deliverables in English unless asked otherwise.', { by: 'Dev', base: null })
  await store.write({ scope: 'project', project: 'p' }, 'P likes tables.', { by: 'Dev', base: null })
  await store.write({ scope: 'workflow', project: 'p', workflow: 'make' }, 'Make runs keep a changelog.', { by: 'Dev', base: null })
  const make = (await ws.readWorkflowFile('make.yaml')).workflow!
  const b = await resolveContext(ctx, { purpose: 'execution', ws, workflow: make, contract: OFFER.contract })
  const by = Object.fromEntries(b.sources.map(s => [s.key, s]))
  assert.deepEqual(b.sources.map(s => [s.key, s.scope, s.category, s.delivery]), [
    ['system/contract', 'system', 'default', 'body'], ['system/override', 'system', 'override', 'body'],
    ['project/intent', 'project', 'default', 'body'], ['guide/agent/guide.md', 'project', 'default', 'body'], ['project/override', 'project', 'override', 'body'],
    ['workflow/intent', 'workflow', 'default', 'body'], ['guide/agent/make.md', 'workflow', 'default', 'body'], ['workflow/override', 'workflow', 'override', 'body'],
  ])
  assert.deepEqual(by['guide/agent/guide.md'].provenance, ['project.yaml guides', 'workflow execution.guides'], 'declared twice, delivered once')
  const text = renderContext(b)
  assert.equal(text.split('# p guide').length, 2, 'the guide text appears once')
  assert.ok(text.indexOf('English unless') < text.indexOf('P likes tables.') && text.indexOf('P likes tables.') < text.indexOf('Make runs keep a changelog.'), 'system, project, workflow order')
  assert.match(text, /Intent: Project p intent\.\n\nGoals:\n- p goal/)
  // Another project sees the system override and none of p's.
  const other = await resolveContext(ctx, { purpose: 'execution', ws: ws2, workflow: (await ws2.readWorkflowFile('make.yaml')).workflow!, contract: null })
  const ot = renderContext(other)
  assert.ok(ot.includes('English unless') && !ot.includes('P likes tables.') && !ot.includes('changelog'))
  assert.equal(other.sources.find(s => s.key === 'project/override')!.delivery, 'absent')
  // Authoring: no execution contract body, the authoring entry as a reference.
  const auth = await resolveContext(ctx, { purpose: 'authoring', ws, workflow: null })
  assert.ok(!auth.sources.some(s => s.key === 'system/contract' || s.key.startsWith('workflow/')))
  assert.equal(auth.sources.find(s => s.key === 'system/authoring')!.delivery, 'reference')
  // An unreadable configured guide is an error, never silently left out.
  await rm(join(dir, 'agent', 'make.md'))
  const broken = await resolveContext(ctx, { purpose: 'execution', ws, workflow: make, contract: null })
  assert.equal(broken.sources.find(s => s.key === 'guide/agent/make.md')!.delivery, 'error')
})

test('fingerprint: content decides, metadata does not; clearing removes only the override', async () => {
  const { ws, ctx, store } = await setup()
  const make = (await ws.readWorkflowFile('make.yaml')).workflow!
  const r = () => resolveContext(ctx, { purpose: 'execution', ws, workflow: make, contract: null })
  const a = await r()
  const w1 = await store.write({ scope: 'project', project: 'p' }, 'X', { by: 'Dev', base: null })
  const b = await r()
  assert.notEqual(a.fingerprint, b.fingerprint)
  assert.deepEqual(contextChanges(a.sources, b.sources).map(c => [c.key, c.change]), [['project/override', 'added']])
  // Removed and written again by someone else: the same content, the same fingerprint.
  const w2 = await store.write({ scope: 'project', project: 'p' }, null, { by: 'Dev', base: w1.state.sha256 })
  assert.equal((await r()).fingerprint, a.fingerprint, 'clearing restores the inherited bundle')
  await store.write({ scope: 'project', project: 'p' }, 'X', { by: 'Other', base: w2.state.sha256 })
  const c = await r()
  assert.equal(c.fingerprint, b.fingerprint)
  assert.equal(fingerprintOf(c), c.fingerprint)
  assert.ok(c.sources.find(s => s.key === 'guide/agent/guide.md'), 'defaults stay')
})

test('claim: one bundle, persisted as the snapshot, recorded by identity, handed over as the same text; a later edit reaches the next attempt only', async () => {
  const { ws, x, store, area } = await setup()
  await store.write({ scope: 'project', project: 'p' }, 'First preference.', { by: 'Dev', base: null })
  const req = await x.request({ workspace: ws.reg.id, workflow: 'make', text: 'Make it.', author: 'Test Person', receipt: 'ctx-req-0001', via: 'browser' })
  const c = await x.claim('test', OFFER)
  assert.ok('attempt' in c, JSON.stringify(c))
  const snap = await store.readSnapshot(c.execution.context.snapshot)
  assert.ok(!('unavailable' in snap))
  assert.equal(snap.rendered, c.execution.context.text, 'the executor gets the snapshot\'s exact text')
  assert.match(c.execution.context.text, /First preference\./)
  const space = await runSpace(ws, req.ref)
  const rec = (await readRun(space, req.ref)).record!
  const recorded = rec.control.attempt!.settings!.context!
  assert.equal(recorded.snapshot, c.execution.context.snapshot)
  const runJson = await readFile(join(space.root, 'devdocs', 'runs', 'make', 'run-001', 'run.json'), 'utf8')
  assert.ok(!runJson.includes('First preference') && !runJson.includes(area), 'the record names hashes, not override text or host paths')
  // An edit now does not touch the open attempt's snapshot.
  const cur = await store.read({ scope: 'project', project: 'p' })
  await store.write({ scope: 'project', project: 'p' }, 'Second preference.', { by: 'Dev', base: cur.sha256 })
  assert.match((await store.readSnapshot(recorded.snapshot) as { rendered: string }).rendered, /First preference\./)
  await x.contextDelivery(c.attempt.id, { delivered: true })
  x.started(c.attempt.id, process.pid)
  await x.finished(c.attempt.id, { code: 0, signal: null })
  const v = await runContextView(x, ws, req.ref)
  assert.equal(v.attempts.length, 1)
  assert.equal(v.attempts[0].delivery?.event, 'delivered')
  assert.match(v.attempts[0].snapshot!.rendered, /First preference/)
  assert.match(v.nextRendered, /Second preference/)
  assert.deepEqual(v.changes.map(ch => [ch.key, ch.change]), [['project/override', 'changed']])
  // A missing snapshot is reported unavailable, not rebuilt from today's settings.
  await rm(join(area, '.local', 'contexts', 'snapshots'), { recursive: true })
  const gone = await runContextView(x, ws, req.ref)
  assert.match(gone.attempts[0].unavailable ?? '', /not on this host/)
  assert.equal(gone.attempts[0].snapshot, null)
  x.close()
})

test('sessions: an unchanged effective context compares equal; a changed one names the source; an older session recorded guides only', () => {
  const ctxOf = (sha: string) => ({ snapshot: `ctx-${'1'.repeat(24)}`, fingerprint: `sha256:${'2'.repeat(64)}`, sources: [{ key: 'project/override', scope: 'project' as const, category: 'override' as const, delivery: 'body' as const, sha256: sha }, { key: 'run/input', scope: 'run' as const, category: 'input' as const, delivery: 'reference' as const, sha256: 'f'.repeat(64) }] })
  const base = { agent: 'a', profile: null, backend: null, contract: null }
  const was = sessionConfig({ ...base, context: ctxOf('a'.repeat(64)) })
  const other = { ...ctxOf('a'.repeat(64)), snapshot: `ctx-${'3'.repeat(24)}` }
  other.sources[1].sha256 = 'e'.repeat(64) // run input is not configuration
  assert.deepEqual(configChanges(was, { ...base, context: other }), [])
  assert.deepEqual(configChanges(was, { ...base, context: ctxOf('b'.repeat(64)) }), ['context project/override changed'])
  assert.deepEqual(configChanges(sessionConfig({ ...base, guides: [] }), { ...base, context: ctxOf('a'.repeat(64)) }), ['context: the session was created before scoped context (it was given guides only)'])
})

test('delegation scope: a child run of another project gets that project\'s context, none of the parent\'s overrides', async () => {
  const { ws, ws2, x, store } = await setup()
  await store.write({ scope: 'project', project: 'p' }, 'Parent-only secret preference.', { by: 'Dev', base: null })
  await store.write({ scope: 'project', project: 'q' }, 'Child project preference.', { by: 'Dev', base: null })
  // A run of q's workflow, as the intake creates for a delegation.
  await x.request({ workspace: ws2.reg.id, workflow: 'other', text: 'Delegated work from p.', author: 'p-agent', receipt: 'ctx-req-0002', via: 'delegation' })
  const c = await x.claim('test', OFFER)
  assert.ok('attempt' in c)
  assert.equal(c.workspace.id, ws2.reg.id)
  assert.match(c.execution.context.text, /Child project preference\./)
  assert.ok(!c.execution.context.text.includes('Parent-only'))
  void ws
  x.close()
})
