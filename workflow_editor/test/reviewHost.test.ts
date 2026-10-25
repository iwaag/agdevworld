// workflow_editor p17 step 2: a human review serves the exact frozen
// presentation of a completed run again, through the owning run, and stops
// what it started. Changed worktree files never change what is reviewed;
// corrupt bundles fail visibly; double clicks, restarts and a second round
// on the same page neither duplicate instances nor stop what another round
// still uses.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { gitOk } from '../server/git.ts'
import { Presenter } from '../server/present.ts'
import { loadRegistry } from '../server/registry.ts'
import { ReviewHost } from '../server/reviews.ts'
import { createRun, readRun, registerPresentation, runOp } from '../server/runs.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import type { OpInput, RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-review-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
const hosts: ReviewHost[] = []
after(async () => {
  for (const h of hosts) {
    const pr = h.presenter
    for (const row of pr['all']<{ id: string; pid: number | null }>('SELECT * FROM instances')) if (row.pid && Presenter.command(row.pid).includes(row.id)) { try { process.kill(row.pid, 'SIGKILL') } catch { /* gone */ } }
    h.close()
  }
  await rm(root, { recursive: true, force: true })
})

const SHOW = `schema: ag.workflow.v2
id: show
name: Show
intent: |
  Build and present.
documentation: {policy: manual}
repositories:
  root: {path: ., access: editable}
nodes:
  build: {type: do, description: Build.}
  present: {type: do, description: Present., appearance: {icon: present, color: teal}}
edges:
  - {from: build, to: present}
`
const CONDUCT = `schema: ag.workflow.v2
id: conduct
name: Conduct
intent: |
  Have work done, review it, hand it to the person.
documentation: {policy: manual}
nodes:
  work: {type: do, description: Get it done.}
  review: {type: review, name: Human review, description: The person reviews it.}
edges:
  - {from: work, to: review}
`
// A run that reviews its own page, with explicit cleanup after the review
// (p17 ex1, gimmickimg/freework/run-013's shape).
const GATE = `schema: ag.workflow.v2
id: gate
name: Gate
intent: |
  Present, have it reviewed, clean up.
documentation: {policy: manual}
repositories:
  root: {path: ., access: editable}
nodes:
  present: {type: do, description: Present.}
  review: {type: review, name: Human review, description: The person reviews it.}
  cleanup: {type: do, description: Stop what this run started.}
edges:
  - {from: present, to: review}
  - {from: review, to: cleanup}
`
let k = 0
async function setup() {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-p')
  const r = await createProject({ dir, id: 'p', name: 'P', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'show.yaml'), SHOW)
  await writeFile(join(dir, 'devdocs', 'workflows', 'conduct.yaml'), CONDUCT)
  await writeFile(join(dir, 'devdocs', 'workflows', 'gate.yaml'), GATE)
  await mkdir(join(dir, 'game'), { recursive: true })
  await writeFile(join(dir, 'game', 'index.html'), '<!doctype html><title>game</title><script src="main.js"></script><p>Play</p>')
  await writeFile(join(dir, 'game', 'main.js'), 'document.title = "game v1"\n')
  await writeFile(join(dir, 'review.md'), '# What changed\n\n- A torus\n')
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflows'])
  await writeFile(join(area, 'present.json'), JSON.stringify({ ports: [18600 + k * 10, 18609 + k * 10], answerBase: 'http://localhost:8093/wfe/' }))
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  const host = new ReviewHost({ registryFile: registry, area })
  hosts.push(host)
  return { ws, dir, area, registry, host }
}
const op = (ws: Workspace, ref: RunRef, o: OpInput, by = 'agent') => runOp(ws, ref, o, { by, via: 'cli' })
const rec = async (ws: Workspace, ref: RunRef) => (await readRun(ws, ref)).record!
const code = (e: unknown) => ((e as RequestError).detail as { code?: string } | undefined)?.code
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

// A child that presented p1 and completed with its page stopped (the agent
// reviewed it and stopped it early, as in fix6 trial A).
async function child(ws: Workspace, host: ReviewHost) {
  const { ref } = await createRun(ws, { workflow: 'show', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'a torus', author: 'Pat' } })
  await op(ws, ref, { op: 'node.start', node: 'build' }); await op(ws, ref, { op: 'node.complete', node: 'build', outcome: 'built' })
  await op(ws, ref, { op: 'node.start', node: 'present' })
  await registerPresentation(ws, ref, { node: 'present', source: 'game', entry: 'index.html', review: 'review.md', title: 'Torus' }, { via: 'cli', by: 'agent' })
  await host.presenter.start(ws, ref, 'p1', { by: 'agent' })
  await host.presenter.stop(ws, ref, 'p1', { by: 'agent' })
  await op(ws, ref, { op: 'node.complete', node: 'present', outcome: 'presented and stopped' })
  assert.equal((await rec(ws, ref)).execution.state, 'completed')
  return ref
}
async function parent(ws: Workspace) {
  const { ref } = await createRun(ws, { workflow: 'conduct', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'have a torus made', author: 'Pat' } })
  await op(ws, ref, { op: 'node.start', node: 'work' }); await op(ws, ref, { op: 'node.complete', node: 'work', outcome: 'the child delivered; I looked at it' })
  return ref
}

test('a completed child\'s stopped page is served again, exactly as frozen; approval stops it and completes the round and the run', async () => {
  const { ws, dir, host } = await setup()
  const c = await child(ws, host)
  const p = await parent(ws)
  // The child cannot serve its completed run's page again on its own.
  await assert.rejects(host.presenter.start(ws, c, 'p1'), /served again only for a human review/)
  const prep = await host.prepare(ws, p, 'review', { summary: 'A torus; check the shading.', subjects: [`p:${c.workflow}/${c.run}:p1`] }, { by: 'agent', via: 'cli' })
  assert.equal(prep.round.subjects[0].run, c.run)
  assert.equal(prep.round.state, 'awaiting')
  // A later edit of the worktree does not reach the frozen bundle.
  await writeFile(join(dir, 'game', 'main.js'), 'document.title = "game v2 (not reviewed)"\n')
  const s1 = await host.start(ws, p, 'rv1', { by: 'Pat', via: 'browser' })
  assert.equal(s1.round.state, 'reviewing', JSON.stringify(s1.round.serving))
  const view = (await host.view(ws, await rec(ws, p)))[0]
  assert.ok(view.subjectsNow[0].live && view.subjectsNow[0].url)
  const body = await (await fetch(`${view.subjectsNow[0].url!.replace('localhost', '127.0.0.1')}content/main.js`)).text()
  assert.equal(body, 'document.title = "game v1"\n')
  const screen = await (await fetch(view.subjectsNow[0].url!.replace('localhost', '127.0.0.1'))).text()
  assert.match(screen, /Approve or request changes on: <a class="answer" href="http:\/\/localhost:8093\/wfe\/#\/ws\/p\/review\/conduct\/run-\d+\/rv1"/, 'the review screen sends the person to the round\'s page')
  assert.equal((await rec(ws, c)).presentations!.p1.state, 'available', 'the owning run records its page serving again')
  // A second Start review reuses the instance; nothing is duplicated.
  const s2 = await host.start(ws, p, 'rv1', { by: 'Pat', via: 'browser' })
  assert.equal(s2.round.state, 'reviewing')
  assert.equal(s2.round.serving[0].instance, s1.round.serving[0].instance)
  assert.equal(s2.round.serving[0].mode, 'started', 'still the review\'s own instance')
  assert.equal(host.presenter.instancesOf('p', c, 'p1').filter(r => r.state === 'serving').length, 1)
  const pid = host.presenter.row(s1.round.serving[0].instance!)!.pid!
  const d = await host.decide(ws, p, 'rv1', { outcome: 'approved', revisions: [prep.round.subjects[0].revision] }, { by: 'Pat', via: 'browser' })
  assert.equal(d.round.state, 'complete', JSON.stringify(d.round.cleanup))
  assert.ok(!alive(pid), 'the review\'s instance is gone')
  assert.equal((await rec(ws, c)).presentations!.p1.state, 'stopped')
  const pr = await rec(ws, p)
  assert.equal(pr.nodes.review.state, 'completed')
  assert.equal(pr.execution.state, 'completed')
  // Approving again (an old browser) records nothing.
  await assert.rejects(host.decide(ws, p, 'rv1', { outcome: 'approved' }, { by: 'Pat', via: 'browser' }), (e: unknown) => code(e) === 'review-closed')
})

test('a corrupt bundle is a visible, recoverable start failure, never a substitute; it cannot be approved', async () => {
  const { ws, dir, host } = await setup()
  const c = await child(ws, host)
  const p = await parent(ws)
  await host.prepare(ws, p, 'review', { summary: 's', subjects: [`p:${c.workflow}/${c.run}:p1`] }, { by: 'agent', via: 'cli' })
  const file = join(dir, (await rec(ws, c)).presentations!.p1.folder, 'content', 'main.js')
  const good = await readFile(file, 'utf8')
  await writeFile(file, 'tampered\n')
  const s = await host.start(ws, p, 'rv1', { by: 'Pat', via: 'browser' })
  assert.equal(s.round.state, 'start-failed')
  assert.match(s.round.serving[0].detail, /did not start|hash|mismatch|exited/i)
  assert.equal(host.presenter.instancesOf('p', c, 'p1').filter(r => r.state === 'serving').length, 0)
  await assert.rejects(host.decide(ws, p, 'rv1', { outcome: 'approved' }, { by: 'Pat', via: 'browser' }), (e: unknown) => code(e) === 'review-unavailable')
  // Repaired: the same round starts; nothing was rebuilt or lost.
  await writeFile(file, good)
  const again = await host.start(ws, p, 'rv1', { by: 'Pat', via: 'browser' })
  assert.equal(again.round.state, 'reviewing')
  assert.equal(again.round.starts.length, 2)
  // A changed bundle is refused at preparation too.
  await writeFile(file, 'tampered again\n')
  const p2 = await parent(ws)
  await assert.rejects(host.prepare(ws, p2, 'review', { summary: 's', subjects: [`p:${c.workflow}/${c.run}:p1`] }, { by: 'agent', via: 'cli' }), /no longer matches its manifest/)
  await writeFile(file, good)
  await host.decide(ws, p, 'rv1', { outcome: 'changes', feedback: 'more shading' }, { by: 'Pat', via: 'browser' })
  await host.cleanup(ws, p, 'rv1', { by: 'agent' })
})

test('two rounds on one page: cleanup of one keeps what the other still uses; a restart finishes a start left in progress', async () => {
  const { ws, host } = await setup()
  const c = await child(ws, host)
  const a = await parent(ws), b = await parent(ws)
  for (const p of [a, b]) await host.prepare(ws, p, 'review', { summary: 's', subjects: [`p:${c.workflow}/${c.run}:p1`] }, { by: 'agent', via: 'cli' })
  const sa = await host.start(ws, a, 'rv1', { by: 'Pat', via: 'browser' })
  // b's start is recorded, then the process "dies" before the host work.
  await op(ws, b, { op: 'review.start', review: 'rv1' } as OpInput, 'Pat')
  assert.equal((await rec(ws, b)).reviews!.rv1.state, 'starting')
  const notes = await host.reconcileRun(ws, await rec(ws, b))
  assert.ok(notes.some(n => /start finished \(reviewing\)/.test(n)), notes.join('\n'))
  const vb = (await rec(ws, b)).reviews!.rv1
  assert.equal(vb.serving[0].instance, sa.round.serving[0].instance, 'the serving instance was reused, not duplicated')
  assert.equal(vb.serving[0].mode, 'reused')
  const pid = host.presenter.row(sa.round.serving[0].instance!)!.pid!
  const da = await host.decide(ws, a, 'rv1', { outcome: 'approved' }, { by: 'Pat', via: 'browser' })
  assert.equal(da.round.state, 'complete')
  assert.equal(da.round.cleanup!.results[0].status, 'kept')
  assert.match(da.round.cleanup!.results[0].detail, /still used by review/)
  assert.ok(alive(pid), 'still serving for the other round')
  const db = await host.decide(ws, b, 'rv1', { outcome: 'approved' }, { by: 'Pat', via: 'browser' })
  assert.equal(db.round.state, 'complete', JSON.stringify(db.round.cleanup))
  assert.equal(db.round.cleanup!.results[0].status, 'stopped', 'reused, its run is completed: nobody else stops it')
  assert.ok(!alive(pid))
})

test('a page the person asked to keep is kept by cleanup, with its owner', async () => {
  const { ws, host } = await setup()
  const c = await child(ws, host)
  const p = await parent(ws)
  await host.prepare(ws, p, 'review', { summary: 's', subjects: [`p:${c.workflow}/${c.run}:p1`] }, { by: 'agent', via: 'cli' })
  const s = await host.start(ws, p, 'rv1', { by: 'Pat', via: 'browser' })
  await op(ws, c, { op: 'presentation.retain', presentation: 'p1', note: 'Pat wants to show it tomorrow', owner: 'Pat' } as OpInput, 'Pat')
  const d = await host.decide(ws, p, 'rv1', { outcome: 'approved' }, { by: 'Pat', via: 'browser' })
  assert.equal(d.round.state, 'complete')
  assert.equal(d.round.cleanup!.results[0].status, 'kept')
  assert.ok(alive(host.presenter.row(s.round.serving[0].instance!)!.pid!))
  await host.presenter.stop(ws, c, 'p1', { by: 'Pat' })
})

test('several subjects in one round; the CLI and the HTTP routes agree; a cancelled run stops what its review started', async () => {
  const { ws, area, registry, host } = await setup()
  const c1 = await child(ws, host), c2 = await child(ws, host)
  const p = await parent(ws)
  const { main } = await import('../cli/wfe.ts')
  const cli = async (args: string[]) => {
    const prev = { log: console.log, error: console.error }
    const out: string[] = [], err: string[] = []
    console.log = (...m: unknown[]) => { out.push(m.join(' ')) }
    console.error = (...m: unknown[]) => { err.push(m.join(' ')) }
    try { return { code: await main([...args, '--workspace', ws.reg.id, '--registry', registry, '--area', area]), out: out.join('\n'), err: err.join('\n') } } finally { console.log = prev.log; console.error = prev.error }
  }
  const run = `${p.workflow}/${p.run}`
  const prep = await cli(['review', 'prepare', run, 'review', '--summary', 'Two figures.', '--subject', `p:${c1.workflow}/${c1.run}:p1`, '--subject', `p:${c2.workflow}/${c2.run}:p1`, '--by', 'agent'])
  assert.equal(prep.code, 0, prep.err)
  assert.match(prep.out, /Prepared rv1 on review: Awaiting human review, for Pat; 2 subjects/)
  const noName = await cli(['review', 'start', run, 'rv1'])
  assert.notEqual(noName.code, 0)
  assert.match(noName.err, /--by <name>/, 'a person\'s act is never recorded under a default name')
  const started = await cli(['review', 'start', run, 'rv1', '--by', 'Pat'])
  assert.equal(started.code, 0, started.err + started.out)
  assert.equal((started.out.match(/now: available — http/g) ?? []).length, 2, started.out)
  const { createServer } = await import('node:http')
  const { createHandler } = await import('../server/api.ts')
  const { ExecStore } = await import('../server/exec.ts')
  const x = new ExecStore({ registryFile: registry, area })
  const srv = createServer(createHandler({ registryFile: registry, area, allowedOrigins: [], exec: x } as never))
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', () => res()))
  try {
    const base = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}/api/workspaces/${ws.reg.id}/runs/${p.workflow}/${p.run}/reviews`
    const view = await (await fetch(`${base}/rv1`)).json() as { review: { state: string; subjectsNow: { live: boolean }[]; subjects: { revision: string }[] } }
    assert.equal(view.review.state, 'reviewing')
    assert.deepEqual(view.review.subjectsNow.map(x => x.live), [true, true])
    const post = async (path: string, body: unknown) => { const r = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as { detail?: { code: string }; review?: { state: string } } } }
    const stale = await post('rv1/decide', { by: 'Pat', outcome: 'approved', revisions: [`sha256:${'0'.repeat(64)}`, `sha256:${'0'.repeat(64)}`] })
    assert.equal(stale.status, 422)
    assert.equal(stale.body.detail?.code, 'review-superseded')
    const ops = await fetch(`http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}/api/workspaces/${ws.reg.id}/runs/${p.workflow}/${p.run}/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'review.serve', review: 'rv1', start: 1, subjects: [], by: 'Pat' }) })
    assert.equal(ops.status, 400, 'host facts are never posted through the generic route')
    const approve = await cli(['review', 'approve', run, 'rv1', '--by', 'Pat', '--feedback', 'Both fine.'])
    assert.equal(approve.code, 0, approve.err + approve.out)
    assert.match(approve.out, /cleanup: done/)
    for (const c of [c1, c2]) assert.equal((await rec(ws, c)).presentations!.p1.state, 'stopped')

    // A run cancelled while its review serves: the cancellation's cleanup stops it.
    const q = await parent(ws)
    await host.prepare(ws, q, 'review', { summary: 's', subjects: [`p:${c1.workflow}/${c1.run}:p1`] }, { by: 'agent', via: 'cli' })
    const qs = await fetch(`http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}/api/workspaces/${ws.reg.id}/runs/${q.workflow}/${q.run}/reviews/rv1/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'Pat', wait: true }) })
    assert.equal(qs.status, 200)
    const served = (await rec(ws, q)).reviews!.rv1
    assert.equal(served.state, 'reviewing')
    const pid = host.presenter.row(served.serving[0].instance!)!.pid!
    const cancelled = await x.cancel(ws, q, 'Pat', 'not needed any more', 'browser')
    assert.ok(cancelled.cleanup.some(cl => cl.presentation === 'review rv1' && cl.ok), JSON.stringify(cancelled.cleanup))
    assert.ok(!alive(pid))
    const after = (await rec(ws, q)).reviews!.rv1
    assert.equal(after.state, 'cancelled')
    assert.equal(after.cleanup!.state, 'done')
  } finally { srv.close(); x.close() }
})

test('a page serving for a different unfinished run is left to it, named, and not shown as stopped (p17 ex1)', async () => {
  const { ws, host } = await setup()
  const { ref: c } = await createRun(ws, { workflow: 'show', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'a torus', author: 'Pat' } })
  await op(ws, c, { op: 'node.start', node: 'build' }); await op(ws, c, { op: 'node.complete', node: 'build', outcome: 'built' })
  await op(ws, c, { op: 'node.start', node: 'present' })
  await registerPresentation(ws, c, { node: 'present', source: 'game', entry: 'index.html', review: 'review.md', title: 'Torus' }, { via: 'cli', by: 'agent' })
  const pid = (await host.presenter.start(ws, c, 'p1', { by: 'agent' })).instance.pid!
  const p = await parent(ws)
  await host.prepare(ws, p, 'review', { summary: 's', subjects: [`p:${c.workflow}/${c.run}:p1`] }, { by: 'agent', via: 'cli' })
  const s = await host.start(ws, p, 'rv1', { by: 'Pat', via: 'browser' })
  assert.equal(s.round.serving[0].mode, 'reused')
  const d = await host.decide(ws, p, 'rv1', { outcome: 'approved' }, { by: 'Pat', via: 'browser' })
  assert.equal(d.round.state, 'complete')
  assert.equal(d.round.cleanup!.results[0].status, 'left')
  assert.equal(d.round.cleanup!.results[0].owner, `p/${c.workflow}/${c.run}`)
  assert.ok(alive(pid), 'the other run still serves it')
  assert.equal((await rec(ws, c)).presentations!.p1.state, 'available')
  const v = (await host.view(ws, await rec(ws, p)))[0]
  assert.equal(v.subjectsNow[0].status, 'handed')
  assert.equal(v.subjectsNow[0].owner, `p/${c.workflow}/${c.run}`)
  assert.match(v.text, /still serving \(for p\/show\/run-/)
  await host.presenter.stop(ws, c, 'p1', { by: 'agent' })
  assert.ok(!alive(pid))
})

test('the review\'s own reused page: a failed stop keeps the approval and releases nothing; the verified retry stops it and releases the cleanup successor once (p17 ex1)', async () => {
  const { ws, registry, area } = await setup()
  const released: string[] = []
  const host = new ReviewHost({ registryFile: registry, area, released: async (_w, ref, id) => { released.push(`${ref.run}/${id}`) } })
  hosts.push(host)
  const { ref } = await createRun(ws, { workflow: 'gate', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'a torus', author: 'Pat' } })
  await op(ws, ref, { op: 'node.start', node: 'present' })
  await registerPresentation(ws, ref, { node: 'present', source: 'game', entry: 'index.html', review: 'review.md', title: 'Torus' }, { via: 'cli', by: 'agent' })
  const pid = (await host.presenter.start(ws, ref, 'p1', { by: 'agent' })).instance.pid!
  await op(ws, ref, { op: 'node.complete', node: 'present', outcome: 'presented, serving' })
  await host.prepare(ws, ref, 'review', { summary: 's', subjects: ['p1'] }, { by: 'agent', via: 'cli' })
  const s = await host.start(ws, ref, 'rv1', { by: 'Pat', via: 'browser' })
  assert.equal(s.round.serving[0].mode, 'reused')
  const real = host.presenter.stopInstance.bind(host.presenter)
  host.presenter.stopInstance = async () => ({ ok: false, detail: 'stop not verified: port still answers (test)' })
  const d = await host.decide(ws, ref, 'rv1', { outcome: 'approved' }, { by: 'Pat', via: 'browser' })
  assert.equal(d.round.state, 'approved')
  assert.equal(d.round.cleanup!.state, 'failed')
  assert.equal(d.round.decision!.by, 'Pat', 'the decision stands and is not asked again')
  assert.deepEqual(released, [])
  let r = await rec(ws, ref)
  assert.deepEqual(r.execution.ready, [], 'the successor waits for the verified stop')
  assert.ok(alive(pid))
  host.presenter.stopInstance = real
  const after = await host.cleanup(ws, ref, 'rv1')
  assert.equal(after!.state, 'complete')
  assert.deepEqual(after!.cleanup!.results.map(c => c.status), ['stop-failed', 'stopped'])
  assert.ok(!alive(pid))
  r = await rec(ws, ref)
  assert.equal(r.presentations!.p1.state, 'stopped')
  assert.deepEqual(r.execution.ready, ['cleanup'])
  assert.deepEqual(r.reviews!.rv1.release!.unlocked, ['cleanup'])
  assert.deepEqual(released, [`${ref.run}/rv1`])
  assert.equal(await host.cleanup(ws, ref, 'rv1').then(x => x!.state), 'complete', 'a repeated cleanup records nothing more')
  assert.deepEqual(released, [`${ref.run}/rv1`], 'and calls back once')
  // The explicit cleanup node: the page is already stopped; stopping again is an idempotent success.
  assert.deepEqual(await host.presenter.stop(ws, ref, 'all', { by: 'agent' }), [])
})
