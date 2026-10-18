// workflow_editor p13, p14: scoped context — the local block store
// (independent blocks, revisions, conflicts, checks, failed refreshes,
// details, conversion of p13 overrides), the resolver (scope isolation,
// guide deduplication, unreadable sources), the attempt's snapshot, the
// session fingerprint and writes through the service.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { contextChanges, fingerprintOf, renderContext, type ScopeTarget } from '../shared/context.ts'
import { configChanges, sessionConfig } from '../shared/run.ts'
import { createProject } from '../server/create.ts'
import { resolveContext } from '../server/context.ts'
import { createHandler } from '../server/api.ts'
import { ContextStore, scopeTarget } from '../server/contextStore.ts'
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
const SYS: ScopeTarget = { scope: 'system' }
const P: ScopeTarget = { scope: 'project', project: 'p' }
const conflict = (e: unknown) => e instanceof RequestError && e.status === 409 && (e.detail as { code: string }).code === 'context-conflict'
const OBS = '2026-10-18T03:39:41.000Z'
const ev = (status = 'ok', observed: string | null = OBS) => [{ ref: 'context:system/cluster/hosts.md', title: 'scan snapshot', basis: 'observed' as const, status: status as 'ok', ...(observed ? { observed } : {}), coverage: '6 of 7 hosts' }]

test('blocks: independent managers, conflicts on an unseen revision, a human edit keeps the manager, idempotent publication, ids validated', async () => {
  const { store } = await setup()
  const dev = await store.set(SYS, 'developer', { title: 'Developer instructions', kind: 'instruction', body: 'Write files in English.' }, { by: 'iwaag', base: 0 })
  const cl = await store.set(SYS, 'cluster', { title: 'Cluster summary', kind: 'information', manager: 'cagent', body: 'agstudio has large memory.', evidence: ev() }, { by: 'cagent-agent', base: 0, run: 'cagent/context/run-001' })
  assert.equal(dev.state.block!.manager, 'iwaag', 'the first writer manages a block unless named')
  assert.equal(cl.state.block!.manager, 'cagent')
  // Two managers write their own blocks; neither touches the other.
  await store.set(SYS, 'cluster', { body: 'agstudio has 512 GB.' }, { by: 'cagent-agent', base: cl.state.base })
  assert.equal((await store.read(SYS, 'developer')).block!.body, 'Write files in English.\n')
  assert.equal((await store.read(SYS, 'developer')).revision, 1)
  // A second writer of the same block with the revision it read before is refused.
  await assert.rejects(store.set(SYS, 'cluster', { body: 'stale view' }, { by: 'other-agent', base: cl.state.base }), conflict)
  // A human edits the agent's block: manager stays, the human is the last editor.
  const cur = await store.read(SYS, 'cluster')
  const h = await store.set(SYS, 'cluster', { body: 'agstudio has 512 GB; ask before using it.' }, { by: 'iwaag', base: cur.base, via: 'browser' })
  assert.equal(h.state.block!.manager, 'cagent')
  assert.equal(h.state.block!.editor.by, 'iwaag')
  assert.deepEqual(h.state.block!.evidence, ev(), 'evidence stays when the edit gives none')
  // The agent did not see that edit: its next write conflicts; after reading it, it may revise deliberately.
  await assert.rejects(store.set(SYS, 'cluster', { body: 'agstudio has 512 GB.' }, { by: 'cagent-agent', base: cur.base }), conflict)
  const re = await store.read(SYS, 'cluster')
  const again = await store.set(SYS, 'cluster', { body: 'agstudio has 512 GB (the Developer asks to be asked first).' }, { by: 'cagent-agent', base: re.base })
  assert.equal(again.state.block!.editor.by, 'cagent-agent')
  // Publishing what is there is no revision, even with a stale base.
  const n = (await store.history(SYS, 'cluster')).length
  assert.equal((await store.set(SYS, 'cluster', { body: 'agstudio has 512 GB (the Developer asks to be asked first).' }, { by: 'cagent-agent', base: 1 })).changed, false)
  assert.equal((await store.history(SYS, 'cluster')).length, n)
  const hist = await store.history(SYS, 'cluster')
  assert.deepEqual(hist.map(r => [r.op, r.by]), [['set', 'cagent-agent'], ['set', 'cagent-agent'], ['set', 'iwaag'], ['set', 'cagent-agent']])
  assert.equal(hist[0].run, 'cagent/context/run-001')
  assert.equal(hist[2].block!.body, 'agstudio has 512 GB; ask before using it.\n', 'the human edit is kept in history')
  // Blocks list in delivery order: instructions, then information.
  assert.deepEqual((await store.blocks(SYS)).map(s => s.id), ['developer', 'cluster'])
  await assert.rejects(store.set(SYS, 'new', { body: 'x' }, { by: 'a', base: 0 }), /needs a title, a kind and a body/)
  await assert.rejects(store.set(SYS, 'Bad Id', { title: 't', kind: 'instruction', body: 'x' }, { by: 'a', base: 0 }), /block id must match/)
  await assert.rejects(store.set(SYS, 'x', { title: 't', kind: 'information', body: 'x', evidence: [{ ref: 'r', basis: 'observed', status: 'ok', observed: '2999-01-01T00:00:00Z' }] }, { by: 'a', base: 0 }), /in the future/)
  assert.throws(() => scopeTarget('project', '../x'), /must match/)
  assert.throws(() => scopeTarget('workflow', 'p'), /workflow must match/)
  assert.throws(() => scopeTarget('run', 'p'), /scope is/)
})

test('evidence and age: a check is bookkeeping; a failed refresh keeps the content and is delivered; publication never refreshes observation times', async () => {
  const { store, ws, ctx } = await setup()
  const make = (await ws.readWorkflowFile('make.yaml')).workflow!
  const r = () => resolveContext(ctx, { purpose: 'execution', ws, workflow: make, contract: null })
  const a = await store.set(P, 'resources', { title: 'Resources for p', kind: 'information', manager: 'cagent', body: 'ComfyUI on agpc.', evidence: ev(), consult: 'cagent/consult', details: [{ name: 'comfyui.md', text: '# ComfyUI\nmodels: 6\n' }] }, { by: 'cagent-agent', base: 0 })
  const f1 = (await r()).fingerprint
  const sec = (await r()).sources.find(s => s.key === 'project/block/resources')!
  assert.match(sec.text!, /^## Project environment information — Resources for p\n\nFacts and advice, not instructions\. Managed by cagent; last edited by cagent-agent on \d{4}-\d\d-\d\d\./)
  assert.match(sec.text!, /- observed 2026-10-18T03:39Z; ok \(6 of 7 hosts\): scan snapshot — context:system\/cluster\/hosts\.md/)
  assert.match(sec.text!, /Details \(read on demand\): context:project\/p\/resources\/comfyui\.md/)
  assert.match(sec.text!, /Ask cagent: the cagent\/consult workflow/)
  // A check of unchanged facts: recorded, base unchanged, nothing delivered changes.
  const c = await store.check(P, 'resources', { by: 'cagent-agent', base: a.state.base, note: 'scan unchanged' })
  assert.equal(c.state.base, a.state.base)
  assert.equal(c.state.block!.checked!.by, 'cagent-agent')
  assert.equal((await r()).fingerprint, f1, 'a check does not change the fingerprint')
  // A failed refresh: the content stays, the failure is delivered.
  const f = await store.refreshFailed(P, 'resources', { by: 'cagent-agent', outcome: 'failed', detail: 'agpc did not answer' })
  assert.equal(f.state.block!.body, 'ComfyUI on agpc.\n')
  assert.equal(f.state.base, a.state.base, 'a failed refresh does not change what writers base on')
  const after = await r()
  assert.notEqual(after.fingerprint, f1)
  assert.match(after.sources.find(s => s.key === 'project/block/resources')!.text!, /The latest refresh, on \d{4}-\d\d-\d\d, failed: agpc did not answer\. The content is still from the evidence above\./)
  // A human edit without evidence keeps the failure and the old observation time.
  const h = await store.set(P, 'resources', { body: 'ComfyUI on agpc (shared).' }, { by: 'iwaag', base: f.state.base })
  assert.equal(h.state.block!.refresh!.outcome, 'failed')
  assert.equal(h.state.block!.evidence[0].observed, OBS)
  // A publication with evidence clears it; the observation time is the evidence's own.
  const p2 = await store.set(P, 'resources', { evidence: ev('partial', null) }, { by: 'cagent-agent', base: h.state.base })
  assert.equal(p2.state.block!.refresh, undefined)
  assert.equal(p2.state.block!.evidence[0].observed, undefined, 'not filled with the publication time')
  assert.match((await r()).sources.find(s => s.key === 'project/block/resources')!.text!, /- observed, observation time not known; partial/)
  // A refresh failure of a block that has no content is refused, never an empty replacement.
  await assert.rejects(store.refreshFailed(P, 'none', { by: 'cagent-agent', outcome: 'failed', detail: 'x' }), /nothing a failed refresh keeps/)
  // Details are read by reference; earlier content stays content-addressed.
  assert.equal((await store.detail('context:project/p/resources/comfyui.md')).text, '# ComfyUI\nmodels: 6\n')
  await store.set(P, 'resources', { details: [{ name: 'comfyui.md', text: '# ComfyUI\nmodels: 7\n' }] }, { by: 'cagent-agent', base: p2.state.base })
  assert.match((await store.detail('context:project/p/resources/comfyui.md')).text, /models: 7/)
  await assert.rejects(store.detail('context:project/p/resources/missing.md'), /no such detail/)
  await assert.rejects(store.detail('/etc/passwd'), /not a detail reference/)
  // Removal: the contribution goes, the history stays.
  const cur = await store.read(P, 'resources')
  await store.remove(P, 'resources', { by: 'iwaag', base: cur.base })
  assert.ok(!(await r()).sources.some(s => s.key === 'project/block/resources'))
  assert.equal((await store.blocks(P))[0].block, null)
  assert.ok((await store.history(P, 'resources')).length >= 6)
})

test('a hand-edited block file is kept as an external revision; a writer who read it names it as base', async () => {
  const { store, area } = await setup()
  const a = await store.set(P, 'notes', { title: 'Notes', kind: 'instruction', body: 'One.' }, { by: 'Dev', base: 0 })
  const file = join(area, '.local', 'contexts', 'projects', 'p', 'project', 'notes.json')
  const j = JSON.parse(await readFile(file, 'utf8'))
  j.block.body = 'Hand edit.\n'
  await writeFile(file, JSON.stringify(j))
  const hand = await store.read(P, 'notes')
  assert.equal(hand.external, true)
  assert.equal(hand.base, a.state.revision + 1)
  await assert.rejects(store.set(P, 'notes', { body: 'Two.' }, { by: 'Dev', base: a.state.base }), conflict)
  await store.set(P, 'notes', { body: 'Two.' }, { by: 'Dev', base: hand.base })
  assert.deepEqual((await store.history(P, 'notes')).map(r => [r.op, r.by, r.block?.body]), [['set', 'Dev', 'One.\n'], ['external', 'edited outside WFE', 'Hand edit.\n'], ['set', 'Dev', 'Two.\n']])
})

test('conversion: p13 overrides become Developer-managed blocks with their revisions; the old files are archived and no longer read', async () => {
  const { area, ws, ctx } = await setup()
  const c = join(area, '.local', 'contexts')
  await mkdir(join(c, 'projects', 'p', 'workflows'), { recursive: true })
  const rev = (o: object) => `${JSON.stringify(o)}\n`
  await writeFile(join(c, 'system.md'), 'English unless asked.\n')
  await writeFile(join(c, 'system.md.revisions.jsonl'), rev({ rev: 1, at: '2026-10-18T06:10:45.788Z', by: 'Omni Agent (for Developer)', sha256: 'x', text: 'Trial.\n', note: 'p13 trial' }) + rev({ rev: 2, at: '2026-10-18T06:13:06.744Z', by: 'Omni Agent (for Developer)', sha256: null, text: null }) + rev({ rev: 3, at: '2026-10-18T11:08:15.973Z', by: 'iwaag', sha256: 'y', text: 'English unless asked.\n' }))
  await writeFile(join(c, 'projects', 'p', 'workflows', 'make.md.revisions.jsonl'), rev({ rev: 1, at: '2026-10-18T06:10:46Z', by: 'Dev', sha256: 'z', text: 'W\n' }) + rev({ rev: 2, at: '2026-10-18T06:11:58Z', by: 'Dev', sha256: null, text: null }))
  const store = new ContextStore(area)
  const s = await store.read(SYS, 'developer')
  assert.equal(s.block!.body, 'English unless asked.\n')
  assert.equal(s.block!.manager, 'Developer')
  assert.equal(s.block!.kind, 'instruction')
  assert.equal(s.block!.editor.by, 'iwaag')
  assert.equal(s.base, 3)
  assert.deepEqual((await store.history(SYS, 'developer')).map(r => [r.rev, r.op, r.by]), [[1, 'set', 'Omni Agent (for Developer)'], [2, 'remove', 'Omni Agent (for Developer)'], [3, 'set', 'iwaag'], [4, 'converted', 'WFE']])
  const w = await store.read({ scope: 'workflow', project: 'p', workflow: 'make' }, 'developer')
  assert.equal(w.block, null); assert.equal(w.revisions, 3)
  assert.equal(await readFile(join(c, 'archive', 'p13', 'system.md'), 'utf8'), 'English unless asked.\n')
  await assert.rejects(readFile(join(c, 'system.md')), /ENOENT/)
  // A second store (another process) finds nothing left to convert.
  assert.equal((await new ContextStore(area).history(SYS, 'developer')).length, 4)
  const b = await resolveContext(ctx, { purpose: 'authoring', ws, workflow: null })
  assert.match(renderContext(b), /## System instruction — Developer instructions\n\nManaged by Developer; last edited by iwaag on 2026-10-18\.\n\nEnglish unless asked\./)
})

test('resolver: scopes and provenance, one source per guide, project blocks stay in their project, an unreadable guide is an error', async () => {
  const { ws, ws2, ctx, store, dir } = await setup()
  await store.set(SYS, 'developer', { title: 'Developer', kind: 'instruction', body: 'Write deliverables in English unless asked otherwise.' }, { by: 'Dev', base: 0 })
  await store.set(SYS, 'cluster', { title: 'Cluster', kind: 'information', manager: 'cagent', body: 'Two GPUs exist.' }, { by: 'cagent-agent', base: 0 })
  await store.set(P, 'developer', { title: 'P', kind: 'instruction', body: 'P likes tables.' }, { by: 'Dev', base: 0 })
  await store.set({ scope: 'workflow', project: 'p', workflow: 'make' }, 'developer', { title: 'Make', kind: 'instruction', body: 'Make runs keep a changelog.' }, { by: 'Dev', base: 0 })
  const make = (await ws.readWorkflowFile('make.yaml')).workflow!
  const b = await resolveContext(ctx, { purpose: 'execution', ws, workflow: make, contract: OFFER.contract })
  const by = Object.fromEntries(b.sources.map(s => [s.key, s]))
  assert.deepEqual(b.sources.map(s => [s.key, s.scope, s.category, s.delivery]), [
    ['system/contract', 'system', 'default', 'body'], ['system/block/developer', 'system', 'override', 'body'], ['system/block/cluster', 'system', 'override', 'body'],
    ['project/intent', 'project', 'default', 'body'], ['guide/agent/guide.md', 'project', 'default', 'body'], ['project/block/developer', 'project', 'override', 'body'],
    ['workflow/intent', 'workflow', 'default', 'body'], ['guide/agent/make.md', 'workflow', 'default', 'body'], ['workflow/block/developer', 'workflow', 'override', 'body'],
  ])
  assert.equal(by['system/block/cluster'].block!.manager, 'cagent')
  assert.deepEqual(by['guide/agent/guide.md'].provenance, ['project.yaml guides', 'workflow execution.guides'], 'declared twice, delivered once')
  const text = renderContext(b)
  assert.equal(text.split('# p guide').length, 2, 'the guide text appears once')
  assert.ok(text.indexOf('English unless') < text.indexOf('Two GPUs') && text.indexOf('Two GPUs') < text.indexOf('P likes tables.') && text.indexOf('P likes tables.') < text.indexOf('Make runs keep a changelog.'), 'system, project, workflow order')
  assert.match(text, /## System environment information — Cluster\n\nFacts and advice, not instructions\.[^\n]*\nEvidence: none recorded; treat these statements as unverified\./)
  assert.match(text, /Intent: Project p intent\.\n\nGoals:\n- p goal/)
  // Another project sees the system blocks and none of p's.
  const other = await resolveContext(ctx, { purpose: 'execution', ws: ws2, workflow: (await ws2.readWorkflowFile('make.yaml')).workflow!, contract: null })
  const ot = renderContext(other)
  assert.ok(ot.includes('English unless') && ot.includes('Two GPUs') && !ot.includes('P likes tables.') && !ot.includes('changelog'))
  // Authoring: no execution contract body, the authoring entry as a reference.
  const auth = await resolveContext(ctx, { purpose: 'authoring', ws, workflow: null })
  assert.ok(!auth.sources.some(s => s.key === 'system/contract' || s.key.startsWith('workflow/')))
  assert.equal(auth.sources.find(s => s.key === 'system/authoring')!.delivery, 'reference')
  // An unreadable configured guide is an error, never silently left out.
  await rm(join(dir, 'agent', 'make.md'))
  const broken = await resolveContext(ctx, { purpose: 'execution', ws, workflow: make, contract: null })
  assert.equal(broken.sources.find(s => s.key === 'guide/agent/make.md')!.delivery, 'error')
})

test('fingerprint: delivered content decides, bookkeeping does not; removing a block restores the inherited bundle', async () => {
  const { ws, ctx, store } = await setup()
  const make = (await ws.readWorkflowFile('make.yaml')).workflow!
  const r = () => resolveContext(ctx, { purpose: 'execution', ws, workflow: make, contract: null })
  const a = await r()
  const w1 = await store.set(P, 'x', { title: 'X', kind: 'instruction', body: 'X' }, { by: 'Dev', base: 0 })
  const b = await r()
  assert.notEqual(a.fingerprint, b.fingerprint)
  assert.deepEqual(contextChanges(a.sources, b.sources).map(c => [c.key, c.change]), [['project/block/x', 'added']])
  await store.check(P, 'x', { by: 'Dev', base: w1.state.base })
  assert.equal((await r()).fingerprint, b.fingerprint, 'a check is not delivered')
  const w2 = await store.remove(P, 'x', { by: 'Dev', base: w1.state.base })
  assert.equal((await r()).fingerprint, a.fingerprint, 'removing restores the inherited bundle')
  await store.set(P, 'x', { title: 'X', kind: 'instruction', body: 'X' }, { by: 'Dev', base: w2.state.base })
  const c = await r()
  assert.equal(c.fingerprint, b.fingerprint, 'the same delivered section, the same fingerprint')
  assert.equal(fingerprintOf(c), c.fingerprint)
  assert.ok(c.sources.find(s => s.key === 'guide/agent/guide.md'), 'defaults stay')
})

test('claim: one bundle, persisted as the snapshot, recorded by identity, handed over as the same text; a later edit reaches the next attempt only', async () => {
  const { ws, x, store, area } = await setup()
  await store.set(P, 'pref', { title: 'Pref', kind: 'instruction', body: 'First preference.' }, { by: 'Dev', base: 0 })
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
  assert.ok(!runJson.includes('First preference') && !runJson.includes(area) && !runJson.includes('Managed by'), 'the record names hashes, not block text or host paths')
  // A provenance lookup of the attempt names its run.
  assert.equal(x.attemptRun(c.attempt.id), `${ws.reg.id}/make/run-001`)
  // An edit now does not touch the open attempt's snapshot.
  const cur = await store.read(P, 'pref')
  await store.set(P, 'pref', { body: 'Second preference.' }, { by: 'Dev', base: cur.base })
  assert.match((await store.readSnapshot(recorded.snapshot) as { rendered: string }).rendered, /First preference\./)
  await x.contextDelivery(c.attempt.id, { delivered: true })
  x.started(c.attempt.id, process.pid)
  await x.finished(c.attempt.id, { code: 0, signal: null })
  const v = await runContextView(x, ws, req.ref)
  assert.equal(v.attempts.length, 1)
  assert.equal(v.attempts[0].delivery?.event, 'delivered')
  assert.match(v.attempts[0].snapshot!.rendered, /First preference/)
  assert.match(v.nextRendered, /Second preference/)
  assert.deepEqual(v.changes.map(ch => [ch.key, ch.change, ch.title]), [['project/block/pref', 'changed', 'Pref']])
  // A check after the attempt: the next attempt is the same as without it.
  const fp = v.next.fingerprint
  await store.check(P, 'pref', { by: 'Dev', base: (await store.read(P, 'pref')).base })
  assert.equal((await runContextView(x, ws, req.ref)).next.fingerprint, fp)
  // A missing snapshot is reported unavailable, not rebuilt from today's settings.
  await rm(join(area, '.local', 'contexts', 'snapshots'), { recursive: true })
  const gone = await runContextView(x, ws, req.ref)
  assert.match(gone.attempts[0].unavailable ?? '', /not on this host/)
  assert.equal(gone.attempts[0].snapshot, null)
  x.close()
})

test('a p13 snapshot (ag.wfe-context.v1) stays readable', async () => {
  const { store, area } = await setup()
  const bundle = { schema: 'ag.wfe-context.v1', purpose: 'execution', project: 'p', workflow: 'make', run: 'run-001', resolved: OBS, sources: [{ key: 'system/override', scope: 'system', category: 'override', kind: 'override', applies: ['execution'], title: 'Developer-wide preferences', origin: {}, provenance: ['local override'], delivery: 'body', text: 'old', sha256: 'a'.repeat(64) }], fingerprint: `sha256:${'b'.repeat(64)}` }
  const bytes = `${JSON.stringify({ ...bundle, rendered: '# Context\nold' })}\n`
  const { createHash } = await import('node:crypto')
  const id = `ctx-${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}`
  await mkdir(join(area, '.local', 'contexts', 'snapshots'), { recursive: true })
  await writeFile(join(area, '.local', 'contexts', 'snapshots', `${id}.json`), bytes)
  const s = await store.readSnapshot(id)
  assert.ok(!('unavailable' in s))
  assert.equal(s.sources[0].key, 'system/override')
})

test('sessions: an unchanged effective context compares equal; a changed one names the source; an older session recorded guides only', () => {
  const ctxOf = (sha: string) => ({ snapshot: `ctx-${'1'.repeat(24)}`, fingerprint: `sha256:${'2'.repeat(64)}`, sources: [{ key: 'project/block/x', scope: 'project' as const, category: 'override' as const, delivery: 'body' as const, sha256: sha }, { key: 'run/input', scope: 'run' as const, category: 'input' as const, delivery: 'reference' as const, sha256: 'f'.repeat(64) }] })
  const base = { agent: 'a', profile: null, backend: null, contract: null }
  const was = sessionConfig({ ...base, context: ctxOf('a'.repeat(64)) })
  const other = { ...ctxOf('a'.repeat(64)), snapshot: `ctx-${'3'.repeat(24)}` }
  other.sources[1].sha256 = 'e'.repeat(64) // run input is not configuration
  assert.deepEqual(configChanges(was, { ...base, context: other }), [])
  assert.deepEqual(configChanges(was, { ...base, context: ctxOf('b'.repeat(64)) }), ['context project/block/x changed'])
  assert.deepEqual(configChanges(sessionConfig({ ...base, guides: [] }), { ...base, context: ctxOf('a'.repeat(64)) }), ['context: the session was created before scoped context (it was given guides only)'])
})

test('delegation scope: a child run of another project gets that project\'s context, none of the parent\'s blocks', async () => {
  const { ws, ws2, x, store } = await setup()
  await store.set(P, 'secret', { title: 'S', kind: 'instruction', body: 'Parent-only secret preference.' }, { by: 'Dev', base: 0 })
  await store.set({ scope: 'project', project: 'q' }, 'pref', { title: 'Q', kind: 'instruction', body: 'Child project preference.' }, { by: 'Dev', base: 0 })
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

test('service: a writer without the area reaches its store through the HTTP API, with conflicts, provenance and detail reads', async () => {
  const { registry, area, store, x } = await setup()
  const server = createServer(createHandler({ registryFile: registry, area, allowedOrigins: [], exec: x }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  try {
    const put = (b: object) => fetch(`${url}api/context/block`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
    const r1 = await put({ op: 'set', scope: 'project', project: 'q', block: 'resources', base: 0, by: 'cagent-agent', title: 'Resources', kind: 'information', manager: 'cagent', body: 'ComfyUI is on agpc.', evidence: ev(), details: [{ name: 'hosts.md', text: 'agpc: GPU\n' }], run: 'cagent/context/run-002' })
    assert.equal(r1.status, 200, await r1.clone().text())
    const j1 = await r1.json() as { changed: boolean; state: { base: number }; written: string }
    assert.equal(j1.changed, true)
    assert.match(j1.written, /context store of the WFE area/)
    const s = await store.read({ scope: 'project', project: 'q' }, 'resources')
    assert.equal(s.block!.editor.run, 'cagent/context/run-002')
    assert.equal(s.block!.editor.via, 'http')
    const stale = await put({ op: 'set', scope: 'project', project: 'q', block: 'resources', base: 7, by: 'x', body: 'Other.' })
    assert.equal(stale.status, 409)
    const d = await fetch(`${url}api/context/detail?ref=${encodeURIComponent('context:project/q/resources/hosts.md')}&raw=1`)
    assert.equal(await d.text(), 'agpc: GPU\n')
    const list = await (await fetch(`${url}api/context/blocks?scope=project&project=q`)).json() as { blocks: { id: string }[] }
    assert.deepEqual(list.blocks.map(b => b.id), ['resources'])
    const bad = await put({ op: 'set', scope: 'project', project: '../etc', block: 'x', base: 0, by: 'x', title: 't', kind: 'instruction', body: 'b' })
    assert.equal(bad.status, 400)
  } finally {
    await new Promise<void>(r => server.close(() => r()))
    x.close()
  }
})

test('CLI: a writer on another host (no area, no registry) goes through --service; the local CLI writes the area\'s store; both name where they wrote', async () => {
  const { registry, area, store, x } = await setup()
  const { execFile } = await import('node:child_process')
  const cli = join(import.meta.dirname, '..', 'cli', 'wfe.ts')
  const elsewhere = await mkdtemp(join(root, 'other-host-'))
  const run = (args: string[], env: Record<string, string | undefined>) => new Promise<{ code: number; out: string; err: string }>(res => {
    const e: NodeJS.ProcessEnv = { ...process.env, ...env }
    for (const k of Object.keys(env)) if (env[k] === undefined) delete e[k]
    execFile(process.execPath, [cli, 'context', ...args], { cwd: elsewhere, env: e }, (err, out, er) => res({ code: err ? (err as { code?: number }).code ?? 1 : 0, out, err: er }))
  })
  const server = createServer(createHandler({ registryFile: registry, area, allowedOrigins: [], exec: x }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  try {
    await writeFile(join(elsewhere, 'ev.json'), JSON.stringify(ev()))
    await writeFile(join(elsewhere, 'hosts.md'), 'agpc: CUDA\n')
    const noArea = { WFE_REGISTRY: undefined, WFE_AREA: undefined, WFE_SERVICE: url, WFE_ATTEMPT: undefined }
    const a = await run(['set', 'system', 'cluster', '--base', 'new', '--title', 'Cluster summary', '--kind', 'information', '--manager', 'cagent', '--text', 'agpc has a CUDA GPU.', '--evidence', 'ev.json', '--detail', 'hosts.md=hosts.md', '--consult', 'cagent/consult', '--by', 'cagent-agent', '--run', 'cagent/context/run-003', '--json'], noArea)
    assert.equal(a.code, 0, a.err + a.out)
    const j = JSON.parse(a.out) as { changed: boolean; written: string; state: { base: number } }
    assert.equal(j.changed, true)
    assert.equal((await store.read(SYS, 'cluster')).block!.editor.via, 'cli')
    // Unchanged republication through the service: no revision.
    const again = await run(['set', 'system', 'cluster', '--base', String(j.state.base), '--text', 'agpc has a CUDA GPU.', '--by', 'cagent-agent', '--json'], noArea)
    assert.equal(JSON.parse(again.out).changed, false)
    const stale = await run(['set', 'system', 'cluster', '--base', '0', '--text', 'other', '--by', 'x'], noArea)
    assert.notEqual(stale.code, 0)
    assert.match(stale.err + stale.out, /changed since it was read/)
    const d = await run(['detail', 'context:system/cluster/hosts.md'], noArea)
    assert.equal(d.out, 'agpc: CUDA\n')
    const g = await run(['get', 'system', 'cluster'], noArea)
    assert.match(g.out, /information, "Cluster summary", managed by cagent, last edited by cagent-agent/)
    // A project write needs its project named, locally and remotely.
    const np = await run(['set', 'project', 'x', '--base', 'new', '--title', 't', '--kind', 'instruction', '--text', 'b', '--by', 'x'], noArea)
    assert.match(np.err + np.out, /--project <id> is required/)
    // The local CLI (the launcher's area) writes the same store.
    const loc = await run(['check', 'system', 'cluster', '--base', String(j.state.base), '--by', 'iwaag', '--json'], { WFE_REGISTRY: registry, WFE_AREA: area, WFE_SERVICE: undefined, WFE_ATTEMPT: undefined })
    assert.equal(loc.code, 0, loc.err + loc.out)
    assert.match(JSON.parse(loc.out).written, /context store of the WFE area/)
    assert.equal((await store.read(SYS, 'cluster')).block!.checked!.by, 'iwaag')
    const h = await run(['history', 'system', 'cluster'], noArea)
    assert.match(h.out, /revision 2 .* check +iwaag \[bookkeeping\]/)
  } finally {
    await new Promise<void>(r => server.close(() => r()))
    x.close()
  }
})
