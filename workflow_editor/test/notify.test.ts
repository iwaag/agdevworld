// p5 step 4: Zulip coordination on the editor's side — names, the selection
// of coordination events, message text, and the durable outbox with its
// bindings and links. The transport is autolab's (tests/test_wfnotify.py).
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { channelName, folderName, fitName, MESSAGE_BUDGET, NAME_MAX, ownsDescription, renderMessage, topicUrl, type RenderContext } from '../shared/notify.ts'
import { notableEvents, type OpInput, type RunRef } from '../shared/run.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { NotifyStore, type Delivery } from '../server/notify.ts'
import { loadRegistry, registerWorkspace } from '../server/registry.ts'
import { createRun, runOp } from '../server/runs.ts'
import { Workspace } from '../server/workspace.ts'

// ---- names ---------------------------------------------------------------------------

test('names: wf- prefix, within the limit, distinct when cut', () => {
  assert.equal(folderName('rts-vs-bot'), 'wf-rts-vs-bot')
  assert.equal(channelName('rts-vs-bot', 'improve-game'), 'wf-rts-vs-bot.improve-game')
  const long = 'p'.repeat(64), a = channelName(long, 'w'.repeat(64)), b = channelName(long, `${'w'.repeat(63)}x`)
  assert.ok(a.length <= NAME_MAX && b.length <= NAME_MAX)
  assert.notEqual(a, b, 'two long identities never share a label')
  assert.equal(fitName('short'), 'short')
  assert.ok(!/^(pj-|work-)/.test(channelName('pj', 'x')), 'never a legacy autolab surface')
  assert.ok(ownsDescription('channel', '[wfe] project p · workflow w: one topic per run; details in devdocs/runs/w/.', 'p', 'w'))
  assert.ok(!ownsDescription('channel', 'someone else\'s channel', 'p', 'w'))
  assert.ok(!ownsDescription('folder', '[wfe] project p2: x', 'p'))
  assert.match(topicUrl('https://z.example', 41, 'wf-p.w', 'run-001'), /#narrow\/channel\/41-wf-p\.2Ew\/topic\/run-001$/)
})

// ---- rendering -----------------------------------------------------------------------

const ctx = (o: Partial<RenderContext> = {}): RenderContext => ({
  ref: 'ship/run-001', executor: 'autolab', request: 'Add a heavy warrior unit.', answerRoute: () => 'in agdevworld on the execution host',
  link: p => ({ path: p, name: p.split('/').pop()! }), label: id => id, openQuestion: () => true, now: new Date('2026-10-11T12:00:00Z'), person: 'Person', ...o,
})
const ev = (o: Record<string, unknown>) => ({ id: 'p/ship/run-001#3:question', seq: 3, type: 'question', at: '2026-10-11T11:59:00Z', by: 'autolab', critical: true, text: '', ...o }) as never

test('messages: actionable lines survive the budget; the marker is last', () => {
  const long = 'Which map size should the first version use? '.repeat(60)
  const m = renderMessage([ev({ text: long, question: 'q1', holder: 'Person', step: '_plan', document: 'devdocs/runs/ship/run-001/plan.md' })], ctx())
  assert.ok(m.length <= MESSAGE_BUDGET + 40, `${m.length} characters`)
  assert.match(m, /^\*\*Question for Person\*\* — agree to the plan \(q1\)/)
  assert.match(m, /Plan: plan\.md \(not yet published: only on the execution host\)/)
  assert.match(m, /Answer: in agdevworld on the execution host/)
  assert.equal(m.split('\n').at(-1), 'ref ship/run-001 #3:question')
  assert.doesNotMatch(m, /@\*\*/, 'no mentions')
})

test('messages: completion is not acceptance; delayed and stale messages say so; links when published', () => {
  const done = renderMessage([ev({ type: 'completed', critical: true, step: '_final-report', text: 'Delivered the unit.', document: 'devdocs/runs/ship/run-001/report.md' })],
    ctx({ link: p => ({ path: p, name: 'report.md', url: 'http://g/x/src/commit/abc/' + p, commit: 'abc' }) }))
  assert.match(done, /Execution completed/)
  assert.match(done, /Not accepted yet: Person reviews the result and decides/)
  assert.match(done, /\[report\.md\]\(http:\/\/g\/x\/src\/commit\/abc\//)
  const late = renderMessage([ev({ text: 'Small or large?', question: 'q1', holder: 'Person', at: '2026-10-11T10:00:00Z' })], ctx({ openQuestion: () => false }), { delayedFrom: '2026-10-11T10:00:00Z' })
  assert.match(late, /^_Delayed: recorded 2026-10-11 10:00 UTC/)
  assert.match(late, /already answered or closed; no action needed/)
  assert.doesNotMatch(late, /Answer:/)
  const two = renderMessage([ev({ seq: 5, type: 'reported', critical: false, node: 'study', text: 'Read three sources.' }), ev({ seq: 7, type: 'reported', critical: false, node: 'build', text: 'Built it.' })], ctx())
  assert.equal(two.split('\n').at(-1), 'ref ship/run-001 #5:reported #7:reported')
})

// ---- the store -----------------------------------------------------------------------

const WF = (policy: string) => `schema: ag.workflow.v2
id: ship
name: Ship
intent: |
  Notify test.
documentation: {policy: ${policy}}
repositories:
  docs: {path: devdocs, access: editable}
nodes:
  study: {type: study, name: Study, description: Learn}
  build: {type: do, name: Build, description: Build}
edges:
  - {from: study, to: build}
`
let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-notify-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

async function area(name: string, o: { mode?: 'directory' | 'submodule'; config?: object | null; policy?: string } = {}) {
  const dir = join(root, name)
  const registryFile = join(dir, 'registry.json')
  const proj = join(dir, 'pj-demo')
  const r = await createProject({ dir: proj, id: 'demo', name: 'Demo', intent: 'x', goals: ['g'], devdocs: o.mode ?? 'directory', sourcesDir: join(dir, 'sources'), registryFile })
  assert.ok(r.ok, r.message)
  await writeFile(join(proj, 'devdocs', 'workflows', 'ship.yaml'), WF(o.policy ?? 'default'))
  if (o.config !== null) await writeFile(join(dir, 'zulip.json'), JSON.stringify(o.config ?? { enabled: true, zulipUrl: 'https://z.example', viewBase: null, since: '2026-01-01T00:00:00.000Z', person: 'Test Person' }))
  const ws = new Workspace((await loadRegistry(registryFile)).workspaces[0])
  const exec = new ExecStore({ registryFile, area: dir })
  const store = () => new NotifyStore({ area: dir, registryFile, exec })
  return { dir, proj, ws, exec, store, registryFile }
}
const by = (ws: Workspace, ref: RunRef) => async (input: OpInput, who?: string) => (await runOp(ws, ref, input, { by: who, via: 'cli' })).record
// The transport's side of the claim protocol, in process: one sender.
const SENDER = { owner: 'test-sender', pid: process.pid }
const claim = async (n: NotifyStore, at?: Date) => (await n.claim(SENDER, at)).deliveries
const post = (n: NotifyStore, d: Delivery, messageId: number) => { n.begin(d.delivery, d.claim, { destination: d.destination }); n.acknowledge(d.delivery, d.claim, { messageId, destination: d.destination }) }
async function provisionAll(n: NotifyStore) {
  for (let i = 0; i < 3; i++) {
    const d = await n.due()
    for (const t of d.provision) n.recordTarget(t.key, { zulipId: t.kind === 'folder' ? 7 : 41 })
  }
}

test('without configuration nothing is owed; with it the folder comes before the channel, the channel before the messages', async () => {
  const off = await area('off', { config: null })
  assert.match((await off.store().due()).disabled ?? '', /not configured/)
  const a = await area('order')
  const { ref } = await createRun(a.ws, { workflow: 'ship', input: { kind: 'braindump', text: '# Add a unit\nplease', author: 'Test Person' }, executor: { name: 'autolab', backend: null }, by: 'Test Person', via: 'cli' })
  const n = a.store()
  let d = await n.due()
  assert.deepEqual(d.provision.map(t => t.kind), ['folder'])
  assert.equal(d.provision[0].name, 'wf-demo')
  assert.deepEqual(await claim(n), [])
  n.recordTarget('folder:demo', { zulipId: 7 })
  d = await n.due()
  assert.deepEqual(d.provision.map(t => [t.kind, t.name, 'folderId' in t ? t.folderId : null]), [['channel', 'wf-demo.ship', 7]])
  n.recordTarget('channel:demo/ship', { zulipId: 41 })
  const rec = by(a.ws, ref)
  await rec({ op: 'node.start', node: '_plan' })
  assert.deepEqual((await claim(n)).filter(x => !x.events[0].endsWith(':started')), [], 'node starts are not news')
  void rec
})

test('ordered, combined, critical alone; restart keeps state; a crash before queueing loses nothing', async () => {
  const a = await area('flow')
  const { ref, dir } = await createRun(a.ws, { workflow: 'ship', input: { kind: 'braindump', text: 'Add a unit.', author: 'Test Person' }, executor: { name: 'autolab', backend: null }, by: 'Test Person', via: 'cli' })
  const n = a.store()
  await provisionAll(n)
  const rec = by(a.ws, ref)
  await rec({ op: 'attempt.begin', attempt: 'a1', reason: 'start' } as OpInput, 'autolab')
  await rec({ op: 'node.start', node: '_plan', attempt: 'a1' } as OpInput)
  await writeFile(join(a.proj, dir, 'plan.md'), '# Plan\n\nStudy then build.\n')
  await rec({ op: 'question.ask', question: '', node: '_plan', text: 'Agree to plan.md?', to: 'Test Person', attempt: 'a1' } as OpInput)
  await rec({ op: 'attempt.end', attempt: 'a1', outcome: 'exited' } as OpInput, 'autolab')
  // A new store instance: what a restarted service or CLI sees.
  const n2 = a.store()
  let d = await claim(n2)
  assert.equal(d.length, 1)
  assert.deepEqual(d[0].events, ['demo/ship/run-001#2:started'], 'the routine start goes first, alone before a critical question')
  assert.match(d[0].content, /\*\*Started\*\* — autolab took up the request: “Add a unit\.”/)
  assert.equal(d[0].destination.topic, 'run-001')
  assert.equal(d[0].destination.streamId, 41)
  assert.equal(d[0].reconcile, null)
  post(n2, d[0], 1001)
  d = await claim(n2)
  assert.deepEqual(d[0].events, ['demo/ship/run-001#4:question'])
  assert.match(d[0].content, /Question for Test Person/)
  assert.equal(d[0].lastMessageId, 1001)
  // The transport's answer was lost: the next attempt is told to look first.
  n2.begin(d[0].delivery, d[0].claim, { destination: d[0].destination })
  n2.fail(d[0].delivery, d[0].claim, 'timed out after the request', true)
  assert.deepEqual(await claim(n2), [], 'a failed delivery waits for its retry time; nothing passes it')
  n2.db.prepare('UPDATE deliveries SET next_try = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', d[0].delivery)
  const again = (await claim(n2))[0]
  assert.equal(again.delivery, d[0].delivery, 'the same delivery')
  assert.equal(again.content, d[0].content)
  assert.equal(again.marker, 'ref ship/run-001 #4:question')
  assert.ok(again.reconcile, 'it may have been posted: look first')
  assert.throws(() => n2.begin(again.delivery, again.claim, { destination: again.destination }), /search for its marker first/)
  assert.throws(() => n2.acknowledge(again.delivery, d[0].claim, { messageId: 1002, destination: again.destination, found: true }), /stale/)
  n2.acknowledge(again.delivery, again.claim, { messageId: 1002, destination: again.destination, found: true })
  assert.equal(n2.acknowledge(again.delivery, again.claim, { messageId: 1002, destination: again.destination, found: true }), 'already recorded', 'repeating the acknowledgment is harmless')
  // Recorded in run.json, not yet scanned: the next due() finds it.
  await rec({ op: 'question.answer', question: 'q1', text: 'Agreed.' }, 'Test Person')
  await rec({ op: 'attempt.begin', attempt: 'a2', reason: 'resume' } as OpInput, 'autolab')
  await rec({ op: 'question.take-up', question: 'q1', attempt: 'a2' } as OpInput)
  await rec({ op: 'node.complete', node: '_plan', outcome: 'Agreed.', attempt: 'a2' } as OpInput)
  await rec({ op: 'node.start', node: 'study', attempt: 'a2' } as OpInput)
  await rec({ op: 'node.complete', node: 'study', outcome: 'Learned.', attempt: 'a2' } as OpInput)
  await rec({ op: 'node.start', node: '_report.study', attempt: 'a2' } as OpInput)
  await writeFile(join(a.proj, dir, 'report-study.md'), '# study\n\nRead three sources.\n')
  await rec({ op: 'node.complete', node: '_report.study', outcome: 'Read three sources. Next: build.', attempt: 'a2' } as OpInput)
  // The attempt is open in this host's records: the report waits for its publication.
  a.exec.db.prepare('INSERT INTO attempts (id, job, workspace, workflow, run, host, state, began) VALUES (?, 1, ?, ?, ?, \'h\', \'running\', ?)').run('a2', a.ws.reg.id, 'ship', 'run-001', new Date().toISOString())
  d = await claim(a.store())
  assert.deepEqual(d.map(x => x.events.map(i => i.replace(/#\d+/, ''))), [['demo/ship/run-001:answered']], 'the answer notice goes; the report waits for publication while the attempt is open')
  post(a.store(), d[0], 1003)
  a.exec.db.prepare('UPDATE attempts SET state = \'ended\' WHERE id = ?').run('a2')
  d = await claim(a.store())
  assert.deepEqual(d[0].events.map(i => i.replace(/#\d+/, '')), ['demo/ship/run-001:reported'])
  assert.match(d[0].content, /\*\*Report — Study:\*\* Read three sources/)
  assert.match(d[0].content, /report-study\.md \(not yet published/)
  assert.ok(n2.outbox('demo/ship/run-001').every(o => o.id.startsWith('demo/ship/run-001#')))
})

test('a published checkpoint answers earlier unpublished details; failures and recovery are announced', async () => {
  const a = await area('publish')
  const { ref, dir } = await createRun(a.ws, { workflow: 'ship', input: { kind: 'braindump', text: 'x', author: 'Test Person' }, executor: { name: 'autolab', backend: null }, by: 'Test Person', via: 'cli' })
  const n = a.store()
  await provisionAll(n)
  const rec = by(a.ws, ref)
  await rec({ op: 'node.start', node: '_plan' })
  await writeFile(join(a.proj, dir, 'plan.md'), '# Plan\n')
  await rec({ op: 'question.ask', question: '', node: '_plan', text: 'Agree?', to: 'Test Person' })
  let d = await claim(n)
  assert.match(d[0].content, /plan\.md \(not yet published/)
  post(n, d[0], 2001)
  // The publication fails first, then succeeds.
  const steps = JSON.stringify([{ repo: '.', include: [], excluded: [], conflicts: [], error: 'remote unreachable' }])
  a.exec.db.prepare('INSERT INTO checkpoints (id, workspace, workflow, run, kind, attempt, state, created, updated, steps, error) VALUES (1, ?, \'ship\', \'run-001\', \'after attempt\', NULL, \'failed\', ?, ?, ?, ?)').run(a.ws.reg.id, new Date().toISOString(), new Date().toISOString(), steps, 'git push failed: remote unreachable')
  d = await claim(n)
  assert.deepEqual(d[0].events, ['demo/ship/run-001#cp1:failed'])
  assert.match(d[0].content, /Publication failed.*remote unreachable/)
  post(n, d[0], 2002)
  await gitOk(a.proj, ['add', '-A'])
  await gitOk(a.proj, ['commit', '-q', '-m', 'run'])
  const head = (await gitOk(a.proj, ['rev-parse', 'HEAD'])).trim()
  await gitOk(a.proj, ['remote', 'add', 'origin', 'http://gitea.example/developer/pj-demo.git']).catch(() => gitOk(a.proj, ['remote', 'set-url', 'origin', 'http://gitea.example/developer/pj-demo.git']))
  a.exec.db.prepare('UPDATE checkpoints SET state = \'published\', error = NULL, steps = ? WHERE id = 1').run(JSON.stringify([{ repo: '.', include: [dir], excluded: [], conflicts: [], commit: head, pushed: true, branch: 'main' }]))
  d = await claim(n)
  assert.deepEqual(d.map(x => x.events).flat(), ['demo/ship/run-001#cp1:recovered'])
  post(n, d[0], 2003)
  d = await claim(n)
  assert.deepEqual(d[0].events, ['demo/ship/run-001#cp1:published'])
  assert.match(d[0].content, new RegExp(`Details published.*\\[plan\\.md\\]\\(http://gitea\\.example/developer/pj-demo/src/commit/${head}/devdocs/runs/ship/run-001/plan\\.md\\)`))
  assert.equal(d[0].marker, `ref ship/run-001 cp1:published ${head.slice(0, 7)}`, 'the follow-up\'s marker names its own event')
  assert.match(n.deliveries('demo/ship/run-001')[0].unpublished ?? '', /plan\.md/, 'the frozen record keeps what the first message called unpublished')
})

test('submodule devdocs: links point into the devdocs repository at its commit', async () => {
  const a = await area('submod', { mode: 'submodule' })
  const { ref, dir } = await createRun(a.ws, { workflow: 'ship', input: { kind: 'braindump', text: 'x', author: 'Test Person' }, executor: { name: 'autolab', backend: null }, by: 'Test Person', via: 'cli' })
  const docs = join(a.proj, 'devdocs')
  await gitOk(docs, ['add', '-A'])
  await gitOk(docs, ['commit', '-q', '-m', 'run'])
  const head = (await gitOk(docs, ['rev-parse', 'HEAD'])).trim()
  await gitOk(docs, ['remote', 'set-url', 'origin', 'https://user:secret@gitea.example/developer/demo-devdocs.git']).catch(() => gitOk(docs, ['remote', 'add', 'origin', 'https://user:secret@gitea.example/developer/demo-devdocs.git']))
  a.exec.db.prepare('INSERT INTO checkpoints (workspace, workflow, run, kind, state, created, updated, steps) VALUES (?, \'ship\', \'run-001\', \'k\', \'published\', ?, ?, ?)').run(a.ws.reg.id, new Date().toISOString(), new Date().toISOString(), JSON.stringify([{ repo: 'devdocs', include: [], excluded: [], conflicts: [], commit: head, pushed: true }]))
  const links = await a.store().links(a.ws, ref)
  const l = links.get(`${dir}/braindump.md`)!
  assert.equal(l.url, `https://gitea.example/developer/demo-devdocs/src/commit/${head}/runs/ship/run-001/braindump.md`, 'path inside the devdocs repository, no credentials')
})

test('runs before announcements began are not backfilled; a duplicate identity is refused, not merged', async () => {
  const a = await area('ident', { config: { enabled: true, zulipUrl: 'https://z.example', viewBase: null, since: '2030-01-01T00:00:00.000Z' } })
  await createRun(a.ws, { workflow: 'ship', input: { kind: 'braindump', text: 'x', author: 'P' }, executor: { name: 'autolab', backend: null }, by: 'P', via: 'cli' })
  const n = a.store()
  await provisionAll(n)
  assert.deepEqual(await claim(n), [])
  assert.match(n.overview().runs[0].skipped ?? '', /not backfilled/)

  const b = await area('dup')
  const first = await createRun(b.ws, { workflow: 'ship', input: { kind: 'braindump', text: 'x', author: 'P' }, executor: { name: 'autolab', backend: null }, by: 'P', via: 'cli' })
  const nb = b.store()
  await provisionAll(nb)
  await by(b.ws, first.ref)({ op: 'question.ask', question: '', text: 'General question?', to: 'P' })
  // A second workspace of the same project with a different run-001.
  const clone = join(b.dir, 'pj-demo-2')
  await gitOk(b.dir, ['clone', '-q', b.proj, clone])
  await rm(join(clone, 'devdocs', 'runs'), { recursive: true, force: true })
  await writeFile(join(clone, 'devdocs', 'workflows', 'ship.yaml'), WF('default'))
  await registerWorkspace(b.registryFile, clone, { id: 'demo-2' })
  const ws2 = new Workspace((await loadRegistry(b.registryFile)).workspaces.find(w => w.id === 'demo-2')!)
  await new Promise(r => setTimeout(r, 5))
  await createRun(ws2, { workflow: 'ship', input: { kind: 'braindump', text: 'other', author: 'P' }, executor: { name: 'autolab', backend: null }, by: 'P', via: 'cli' })
  const d = await nb.claim(SENDER)
  assert.deepEqual(d.deliveries, [])
  assert.match(d.problems.join('\n'), /ambiguous identity: demo\/ship\/run-001 exists in workspace demo .* and in demo-2/)
  assert.match(nb.reset('demo/ship/run-001').join('\n'), /cleared/)
})

test('manual policy: authored completions and the completed execution are announced, no reports exist', async () => {
  const a = await area('manual', { policy: 'manual' })
  const { ref } = await createRun(a.ws, { workflow: 'ship', input: { kind: 'braindump', text: 'x', author: 'P' }, executor: { name: 'autolab', backend: null }, by: 'P', via: 'cli' })
  const rec = by(a.ws, ref)
  for (const id of ['study', 'build']) { await rec({ op: 'node.start', node: id }); await rec({ op: 'node.complete', node: id, outcome: `${id} done` }) }
  const r = (await rec({ op: 'run.decide', decision: 'accepted', evidence: 'demo checked' }, 'P'))
  assert.deepEqual(notableEvents(r).map(e => e.type), ['node-completed', 'completed', 'decided'], 'the last node is told once, as the completion')
  assert.equal(notableEvents(r).find(e => e.type === 'completed')!.text, 'build done')
})

test('a hold carries the reducer\'s reason; resumption and cancellation are announced', async () => {
  const a = await area('hold')
  const { ref } = await createRun(a.ws, { workflow: 'ship', input: { kind: 'braindump', text: 'x', author: 'P' }, executor: { name: 'autolab', backend: null }, by: 'P', via: 'cli' })
  const rec = by(a.ws, ref)
  await rec({ op: 'attempt.begin', attempt: 'a1', reason: 'start' } as OpInput, 'autolab')
  await rec({ op: 'node.start', node: '_plan', attempt: 'a1' } as OpInput)
  await rec({ op: 'attempt.end', attempt: 'a1', outcome: 'exited' } as OpInput, 'autolab')
  await rec({ op: 'run.resume', reason: 'continue the plan' }, 'P')
  const r = await rec({ op: 'run.cancel', reason: 'not needed' }, 'P')
  const evs = notableEvents(r)
  assert.deepEqual(evs.map(e => e.type), ['started', 'held', 'resumed', 'cancelled'])
  assert.match(evs[1].text, /_plan recorded as running/)
  assert.equal(evs[1].hold, 'interrupted')
  assert.ok(evs.filter(e => e.type !== 'started' && e.type !== 'resumed').every(e => e.critical))
})
