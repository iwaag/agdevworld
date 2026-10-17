// p7 steps 3–4: presentations — a frozen bundle bound to the confirmation
// question and decision, and serving instances on this host that outlive the
// attempt, stop only what they own, and say what they observe.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { Presenter } from '../server/present.ts'
import { byteRange } from '../server/presentServer.ts'
import { loadRegistry } from '../server/registry.ts'
import { createRun, readRun, registerPresentation, runOp } from '../server/runs.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import { renderReview, safeHref } from '../shared/review.ts'
import { notableEvents, type OpInput, type RunRef } from '../shared/run.ts'
import { renderMessage, type RenderContext } from '../shared/notify.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-present-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
const presenters: Presenter[] = []
after(async () => {
  // Never leave an instance behind.
  for (const pr of presenters) {
    for (const row of pr['all']<{ id: string; pid: number | null }>('SELECT * FROM instances')) if (row.pid && Presenter.command(row.pid).includes(row.id)) { try { process.kill(row.pid, 'SIGKILL') } catch { /* gone */ } }
    pr.close()
  }
  await rm(root, { recursive: true, force: true })
})

const FLOW = `schema: ag.workflow.v2
id: show
name: Show
intent: |
  Build, present, confirm, clean up.
documentation: {policy: manual}
repositories:
  root: {path: ., access: editable}
nodes:
  build: {type: do, description: Build.}
  present: {type: do, description: Present., appearance: {icon: present, color: teal}}
  check: {type: talk, confirms: result, description: Ask.}
  cleanup: {type: do, description: Stop the server.}
edges:
  - {from: build, to: present}
  - {from: present, to: check}
  - {from: check, to: cleanup}
`
let k = 0
async function setup() {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-p')
  const r = await createProject({ dir, id: 'p', name: 'P', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'show.yaml'), FLOW)
  await mkdir(join(dir, 'game'), { recursive: true })
  await writeFile(join(dir, 'game', 'index.html'), '<!doctype html><title>game</title><script src="main.js"></script><p>Play</p>')
  await writeFile(join(dir, 'game', 'main.js'), 'document.title = "game v1"\n')
  await writeFile(join(dir, 'game', '.secret'), 'not presented\n')
  await writeFile(join(dir, 'review.md'), '# What changed\n\n- Upgrades at the **barracks**\n- Keys: `E`, `R`\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [ok](content/index.html)\n')
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  // Ports of this test area: away from the host's 8300–8399.
  await writeFile(join(area, 'present.json'), JSON.stringify({ ports: [18300 + k * 10, 18309 + k * 10], answerBase: 'http://localhost:8093/wfe/' }))
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  const created = await createRun(ws, { workflow: 'show', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'make it so', author: 'Pat' } })
  const pr = new Presenter({ registryFile: registry, area })
  presenters.push(pr)
  return { ws, ref: created.ref, dir, area, registry, pr }
}
const op = (ws: Workspace, ref: RunRef, o: OpInput, by = 'agent') => runOp(ws, ref, o, { by, via: 'cli' })
const code = (e: unknown) => ((e as RequestError).detail as { code?: string } | undefined)?.code
const rec = async (ws: Workspace, ref: RunRef) => (await readRun(ws, ref)).record!
const register = (ws: Workspace, ref: RunRef, title = 'Upgrades') => registerPresentation(ws, ref, { node: 'present', source: 'game', entry: 'index.html', review: 'review.md', title }, { via: 'cli', by: 'agent' })
const get = async (url: string) => { const r = await fetch(url); return { status: r.status, text: await r.text(), csp: r.headers.get('content-security-policy') ?? '' } }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

async function toPresent(ws: Workspace, ref: RunRef) {
  await op(ws, ref, { op: 'node.start', node: 'build' })
  await op(ws, ref, { op: 'node.complete', node: 'build', outcome: 'built' })
  await op(ws, ref, { op: 'node.start', node: 'present' })
}

test('review text: a safe Markdown subset; raw HTML and unsafe links are text', () => {
  const html = renderReview('# T\n\nA **b** `c` <img src=x onerror=1>\n\n- [x](https://example.com/a) [y](../up) [z](javascript:x)\n\n```\n<b>\n```')
  assert.match(html, /<h2>T<\/h2>/)
  assert.match(html, /&lt;img src=x onerror=1&gt;/)
  assert.match(html, /<a href="https:\/\/example.com\/a"/)
  assert.doesNotMatch(html, /href="\.\.\/up"|href="javascript/)
  assert.match(html, /<pre><code>&lt;b&gt;<\/code><\/pre>/)
  assert.equal(safeHref('content/index.html'), 'content/index.html')
  assert.equal(safeHref('/etc/passwd'), null)
  assert.equal(safeHref('data:text/html,x'), null)
})

test('register freezes a copy with a manifest; later edits of the source do not reach it', async () => {
  const { ws, ref, dir } = await setup()
  await assert.rejects(register(ws, ref), (e: unknown) => /running node/.test((e as Error).message))
  await assert.rejects(op(ws, ref, { op: 'presentation.register', node: 'present', title: 't' }), (e: unknown) => /presentation-missing|is pending/.test(`${code(e)} ${(e as Error).message}`))
  await toPresent(ws, ref)
  const { presentation: p } = await register(ws, ref)
  assert.equal(p.id, 'p1')
  assert.equal(p.state, 'registered')
  assert.match(p.revision, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(p.files.map(f => f.path.replace(`${p.folder}/`, '')), ['content/index.html', 'content/main.js', 'review.md'], 'dot-files are not presented; the review is part of the subject')
  const manifest = JSON.parse(await readFile(join(dir, p.folder, 'manifest.json'), 'utf8'))
  assert.equal(manifest.revision, p.revision)
  await writeFile(join(dir, 'game', 'main.js'), 'document.title = "game v2"\n')
  assert.equal(await readFile(join(dir, p.folder, 'content', 'main.js'), 'utf8'), 'document.title = "game v1"\n', 'the bundle is a copy')
  // A second registration is a new revision with a new id.
  const second = (await register(ws, ref, 'Upgrades, again')).presentation
  assert.equal(second.id, 'p2')
  assert.notEqual(second.revision, p.revision)
})

test('serving: one click shows the result and its explanation; nothing else is served; a second start reuses the instance', async () => {
  const { ws, ref, pr } = await setup()
  await toPresent(ws, ref)
  await register(ws, ref)
  const s = await pr.start(ws, ref, 'p1')
  assert.equal(s.state, 'serving')
  assert.equal(s.local, true)
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:183\d\d\/$/)
  const page = await get(s.url)
  assert.equal(page.status, 200)
  assert.match(page.text, /<iframe src="\/content\/index.html"/, 'the result, in the same screen')
  assert.match(page.text, /Upgrades at the <strong>barracks<\/strong>/, 'the explanation, rendered')
  assert.match(page.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'raw HTML in the review is text')
  assert.match(page.text, /#\/ws\/p\/run\/show\/run-001/, 'where to answer: the run view')
  assert.match(page.csp, /default-src 'none'/, 'the review screen runs no script')
  assert.equal((await get(`${s.url}content/main.js`)).text, 'document.title = "game v1"\n')
  // Safari plays <video> only from byte ranges (project_migration p1).
  const part = await fetch(`${s.url}content/main.js`, { headers: { range: 'bytes=0-7' } })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), `bytes 0-7/${'document.title = "game v1"\n'.length}`)
  assert.equal(part.headers.get('accept-ranges'), 'bytes')
  assert.equal(await part.text(), 'document')
  const tail = await fetch(`${s.url}content/main.js`, { headers: { range: 'bytes=-3' } })
  assert.equal(await tail.text(), 'v1"\n'.slice(-3))
  assert.equal((await fetch(`${s.url}content/main.js`, { headers: { range: 'bytes=9999-' } })).status, 416)
  for (const path of ['content/.secret', 'manifest.json', 'review.md', 'content/../manifest.json', '..%2f..%2frun.json', '.wfe-present/shutdown'])
    assert.equal((await get(`${s.url}${path}`)).status === 200, false, `${path} is not served`)
  const forged = await fetch(`${s.url}.wfe-present/shutdown`, { method: 'POST', headers: { 'x-wfe-present-token': 'guess' } })
  assert.equal(forged.status, 403, 'only the owner stops it')
  let r = await rec(ws, ref)
  assert.equal(r.presentations!.p1.state, 'available')
  assert.equal(r.presentations!.p1.instance, s.instance.id)
  assert.ok(!JSON.stringify(r).includes(String(s.instance.port)), 'no port in run.json')
  const again = await pr.start(ws, ref, 'p1')
  assert.equal(again.reused, true)
  assert.equal(again.instance.id, s.instance.id)
  assert.equal(pr.instancesOf(ws.reg.id, ref).length, 1, 'no duplicate instance')
  const stop = await pr.stop(ws, ref, 'p1')
  assert.deepEqual(stop.map(x => x.ok), [true])
  assert.equal(alive(s.instance.pid!), false)
  r = await rec(ws, ref)
  assert.equal(r.presentations!.p1.state, 'stopped')
  assert.deepEqual(await pr.stop(ws, ref, 'p1'), [], 'stopping again is harmless')
  const view = (await pr.view(ws, r))[0]
  assert.equal(view.live, false, 'a stopped presentation offers no live link')
})

test('an agent that exits — its whole process group killed — leaves the presentation served', async () => {
  const { ws, ref, pr, registry, area } = await setup()
  await toPresent(ws, ref)
  await register(ws, ref)
  // The "agent": a process group of its own that starts the presentation
  // through the CLI and then waits; the executor kills the group.
  const cli = join(import.meta.dirname, '..', 'cli', 'wfe.ts')
  const agent = spawn('/bin/sh', ['-c', `node "${cli}" present start show/run-001 p1 --workspace p --registry "${registry}" --area "${area}" --json; sleep 60`], { detached: true, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, WFE_REGISTRY: registry } })
  let out = ''
  agent.stdout!.on('data', d => { out += d })
  for (let i = 0; i < 100 && !/"url"/.test(out); i++) await new Promise(r => setTimeout(r, 100))
  const started = JSON.parse(out) as { url: string; instance: { pid: number; id: string } }
  process.kill(-agent.pid!, 'SIGKILL') // what wfexec does when the agent's leader exits
  await new Promise(r => setTimeout(r, 500))
  assert.equal(alive(agent.pid!), false, 'the agent is gone')
  assert.equal(alive(started.instance.pid), true, 'the server is not in the agent\'s process group')
  assert.equal((await get(started.url)).status, 200)
  const r = await rec(ws, ref)
  assert.equal(r.presentations!.p1.state, 'available')
  await pr.stop(ws, ref, 'all')
})

test('restart recovery: a lost instance is seen as not live, reconciled, and started again; a startup failure is recorded and retryable', async () => {
  const { ws, ref, pr, dir } = await setup()
  await toPresent(ws, ref)
  const p = (await register(ws, ref)).presentation
  const s = await pr.start(ws, ref, 'p1')
  process.kill(s.instance.pid!, 'SIGKILL') // the host restarted, or the process died
  await new Promise(r => setTimeout(r, 300))
  let r = await rec(ws, ref)
  assert.equal(r.presentations!.p1.state, 'available', 'the record still claims it')
  const v = (await pr.view(ws, r))[0]
  assert.equal(v.live, false, 'observation says otherwise')
  assert.equal(v.observed?.detail, 'gone')
  const notes = await pr.reconcile()
  assert.match(notes.join('\n'), /p1: instance pi-.* is gone/)
  const again = await pr.start(ws, ref, 'p1')
  assert.notEqual(again.instance.id, s.instance.id)
  assert.equal((await get(again.url)).status, 200)
  await pr.stop(ws, ref, 'p1')
  // A changed bundle refuses to start: the revision is never served with other content.
  await writeFile(join(dir, p.folder, 'content', 'main.js'), 'tampered\n')
  await assert.rejects(pr.start(ws, ref, 'p1'), (e: unknown) => code(e) === 'presentation-start' && /differs from the manifest/.test((e as Error).message))
  r = await rec(ws, ref)
  assert.equal(r.presentations!.p1.state, 'failed')
  assert.equal(pr.instancesOf(ws.reg.id, ref).filter(x => x.state === 'serving' || x.state === 'starting').length, 0)
})

test('stop touches only the owned instance: an unrelated process on a recorded pid or port survives, and an unverifiable stop is stop-failed and retryable', async () => {
  const { ws, ref, pr, area } = await setup()
  await toPresent(ws, ref)
  await register(ws, ref)
  const s = await pr.start(ws, ref, 'p1')
  // An unrelated process; the store is made to point at it, as after a
  // pid reuse. Stop must not signal it.
  const bystander = spawn('sleep', ['60'], { stdio: 'ignore' })
  const db = pr.db
  const fake = `pi-${Date.now().toString(36)}-feed00`
  db.prepare('INSERT INTO instances (id, workspace, workflow, run, presentation, revision, host, pid, signature, port, bind, state, created, updated, log) SELECT ?, workspace, workflow, run, presentation, revision, host, ?, \'Mon Jan  1 00:00:00 2001\', ?, bind, \'serving\', created, updated, log FROM instances WHERE id = ?')
    .run(fake, bystander.pid!, s.instance.port + 1, s.instance.id)
  // The real instance cannot be verified as ours: wrong token, wrong signature.
  await writeFile(join(area, '.local', 'present', 'instances', s.instance.id, 'token'), 'wrong')
  db.prepare('UPDATE instances SET signature = ? WHERE id = ?').run('Mon Jan  1 00:00:00 2001', s.instance.id)
  const res = await pr.stop(ws, ref, 'p1')
  assert.equal(res[0].ok, false, 'not verified')
  assert.equal(alive(bystander.pid!), true, 'the unrelated process was not signalled')
  assert.equal(alive(s.instance.pid!), true, 'nothing was killed on a weak identity')
  let r = await rec(ws, ref)
  assert.equal(r.presentations!.p1.state, 'stop-failed')
  await op(ws, ref, { op: 'node.complete', node: 'present', outcome: 'x' })
  await op(ws, ref, { op: 'node.start', node: 'check' }); await op(ws, ref, { op: 'node.complete', node: 'check', outcome: 'ok' })
  await op(ws, ref, { op: 'node.start', node: 'cleanup' }); await op(ws, ref, { op: 'node.complete', node: 'cleanup', outcome: 'done' })
  assert.equal((await rec(ws, ref)).execution.state, 'completed', 'serving a presentation does not veto completion')

  // Retry once the identity is right again.
  execFileSync('true')
  db.prepare('UPDATE instances SET signature = ? WHERE id = ?').run(Presenter.signature(s.instance.pid!), s.instance.id)
  db.prepare('DELETE FROM instances WHERE id = ?').run(fake)
  const retry = await pr.stop(ws, ref, 'p1')
  assert.equal(retry[0].ok, true)
  assert.equal(alive(s.instance.pid!), false)
  r = await rec(ws, ref)
  assert.equal(r.presentations!.p1.state, 'stopped')
  await op(ws, ref, { op: 'node.start', node: 'cleanup' })
  await op(ws, ref, { op: 'node.complete', node: 'cleanup', outcome: 'done' })
  assert.equal((await rec(ws, ref)).execution.state, 'completed')
  bystander.kill('SIGKILL')
  // A port taken by someone else is skipped.
  const blocker = createServer().listen(18300 + k * 10, '127.0.0.1')
  await new Promise(r2 => blocker.once('listening', r2))
  blocker.close()
})

test('optional confirmation keeps content provenance; cleanup needs no renewed acceptance', async () => {
  const { ws, ref, pr, dir } = await setup()
  await toPresent(ws, ref)
  await register(ws, ref)
  await op(ws, ref, { op: 'node.complete', node: 'present', outcome: 'presented' }).catch(() => {})
  await op(ws, ref, { op: 'node.start', node: 'check' })
  await assert.rejects(op(ws, ref, { op: 'question.ask', question: '', node: 'check', text: 'OK?', to: 'Pat', presentation: 'p1' }), (e: unknown) => code(e) === 'presentation-unavailable')
  await pr.start(ws, ref, 'p1')
  await op(ws, ref, { op: 'question.ask', question: '', node: 'check', text: 'Does it work?', to: 'Pat', presentation: 'p1' })
  let r = await rec(ws, ref)
  assert.deepEqual(r.questions.q1.presentation, { id: 'p1', revision: r.presentations!.p1.revision })
  assert.equal(r.questions.q1.subject!.length, 3)
  await op(ws, ref, { op: 'question.answer', question: 'q1', text: 'Looks good!', from: 'Pat' }, 'Pat')
  await op(ws, ref, { op: 'question.take-up', question: 'q1' })
  // A newer presentation registered meanwhile: the answer about p1 cannot accept it.
  await writeFile(join(dir, 'game', 'main.js'), 'document.title = "v2"\n')
  await op(ws, ref, { op: 'node.start', node: 'check' }).catch(() => {})
  // (registering needs a running node: the confirming node is running again after take-up)
  await registerPresentation(ws, ref, { node: 'check', source: 'game', entry: 'index.html', review: 'review.md', title: 'v2' }, { via: 'cli', by: 'agent' })
  await assert.rejects(op(ws, ref, { op: 'run.decide', decision: 'accepted', question: 'q1' }), (e: unknown) => code(e) === 'presentation-superseded')
  // Without the newer one (a fresh run of the same steps), the decision binds p1.
  const b = await setup()
  await toPresent(b.ws, b.ref)
  await register(b.ws, b.ref)
  await b.pr.start(b.ws, b.ref, 'p1')
  await op(b.ws, b.ref, { op: 'node.complete', node: 'present', outcome: 'presented' })
  await op(b.ws, b.ref, { op: 'node.start', node: 'check' })
  await op(b.ws, b.ref, { op: 'question.ask', question: '', node: 'check', text: 'OK?', to: 'Pat', presentation: 'p1' })
  await op(b.ws, b.ref, { op: 'question.answer', question: 'q1', text: 'Accepted.', from: 'Pat' }, 'Pat')
  await op(b.ws, b.ref, { op: 'question.take-up', question: 'q1' })
  await op(b.ws, b.ref, { op: 'run.decide', decision: 'accepted', question: 'q1' })
  r = await rec(b.ws, b.ref)
  assert.deepEqual(r.decisions[0].confirmation?.presentation, { id: 'p1', revision: r.presentations!.p1.revision })
  await op(b.ws, b.ref, { op: 'node.complete', node: 'check', outcome: 'accepted' })
  await op(b.ws, b.ref, { op: 'node.start', node: 'cleanup' })
  // The decision is recorded, the presentation still served: accepted, cleanup pending.
  const ev = notableEvents(r).find(e => e.type === 'decided')!
  const ctx: RenderContext = { ref: 'show/run-001', executor: 'agent', answerRoute: () => '', link: path => ({ path, name: path }), label: x => x, openQuestion: () => false, now: new Date(), openPresentations: ['p1'] }
  assert.match(renderMessage([ev], ctx), /Cleanup pending: presentation p1 still served/)
  const presented = notableEvents(r).find(e => e.type === 'presented')!
  assert.match(renderMessage([presented], { ...ctx, presentation: () => ({ url: 'http://127.0.0.1:8300/', local: true, live: true }) }), /\[Open the review\]\(http:\/\/127\.0\.0\.1:8300\/\) — opens on the execution host/)
  const stopped = await b.pr.stop(b.ws, b.ref, 'all')
  assert.ok(stopped.every(x => x.ok))
  await op(b.ws, b.ref, { op: 'node.complete', node: 'cleanup', outcome: 'stopped p1, verified' })
  r = await rec(b.ws, b.ref)
  assert.equal(r.execution.state, 'completed')
  assert.equal(r.decisions.length, 1, 'no second acceptance was asked for')
})

test('cancellation stops the run\'s presentations through its own path and keeps the run cancelled', async () => {
  const { ws, ref, pr, registry, area } = await setup()
  await toPresent(ws, ref)
  await register(ws, ref)
  const s = await pr.start(ws, ref, 'p1')
  const x = new ExecStore({ registryFile: registry, area })
  try {
    const { record, cleanup } = await x.cancel(ws, ref, 'Pat', 'not needed any more', 'cli')
    assert.deepEqual(cleanup.map(c => c.ok), [true])
    assert.equal(record.cancelled?.by, 'Pat')
    assert.equal(record.presentations!.p1.state, 'stopped')
    assert.equal(alive(s.instance.pid!), false)
    assert.equal(record.execution.state, 'cancelled')
    await assert.rejects(pr.start(ws, ref, 'p1'), /cancelled/)
    await assert.rejects(op(ws, ref, { op: 'presentation.observe', presentation: 'p1', status: 'available', instance: s.instance.id }), (e: unknown) => code(e) === 'run-cancelled')
  } finally { x.close() }
})

test('byte ranges: one range, suffix, open end, clamped end, unsatisfiable, ignored forms', () => {
  assert.deepEqual(byteRange('bytes=0-1', 10), { start: 0, end: 1 })
  assert.deepEqual(byteRange('bytes=4-', 10), { start: 4, end: 9 })
  assert.deepEqual(byteRange('bytes=-3', 10), { start: 7, end: 9 })
  assert.deepEqual(byteRange('bytes=-30', 10), { start: 0, end: 9 })
  assert.deepEqual(byteRange('bytes=5-99', 10), { start: 5, end: 9 })
  assert.equal(byteRange('bytes=10-', 10), 'unsatisfiable')
  assert.equal(byteRange('bytes=6-5', 10), 'unsatisfiable')
  assert.equal(byteRange('bytes=-0', 10), 'unsatisfiable')
  assert.equal(byteRange(undefined, 10), null)
  assert.equal(byteRange('bytes=0-1,4-5', 10), null, 'several ranges: the whole file')
  assert.equal(byteRange('items=0-1', 10), null)
})

test('p9: a run in its own copy presents its copy — the project tree\'s files are not served', async () => {
  const { ws, dir, pr } = await setup()
  const { createRunInCopy } = await import('../server/runs.ts')
  const { runSpace } = await import('../server/runspace.ts')
  const created = await createRunInCopy(ws, { workflow: 'show', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'make it so', author: 'Pat' }, receipt: 'present-copy-0001' })
  const ref = created.ref
  const copy = (await runSpace(ws, ref)).root
  await writeFile(join(copy, 'game', 'main.js'), 'document.title = "the run\'s own"\n')
  await writeFile(join(dir, 'game', 'main.js'), 'document.title = "the person\'s edit"\n')
  await toPresent(ws, ref)
  await register(ws, ref)
  const s = await pr.start(ws, ref, 'p1')
  assert.equal(s.state, 'serving')
  assert.equal((await get(`${s.url}content/main.js`)).text, 'document.title = "the run\'s own"\n', 'served from the run\'s copy')
  assert.ok((await rec(ws, ref)).presentations!.p1.folder.startsWith(`devdocs/runs/show/${ref.run}/presentations/`))
  const stop = await pr.stop(ws, ref, 'p1')
  assert.deepEqual(stop.map(x => x.ok), [true])
})
