// p6 step 4: the durable inbox — posts stored once per realm and id with
// the cursor, settled in order, applied through run operations by receipt,
// so repeated delivery and restarts at every stage leave exactly one run,
// answer or instruction.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sourceReceipt, type InboundMessage } from '../shared/intake.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { IntakeStore } from '../server/intake.ts'
import { NotifyStore } from '../server/notify.ts'
import { loadRegistry } from '../server/registry.ts'
import { createRun, listRuns, readRun, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'
import type { RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-intake-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const REALM = 'chat.example:8543'
const STREAM = 501, PERSON = 8, BOT = 11, STRANGER = 9
const WF = `schema: ag.workflow.v2
id: make
name: Make
intent: |
  Make what the person asks.
documentation: {policy: manual}
execution: {agent: maker}
intake: {zulip: requests}
repositories:
  root: {path: ., access: editable}
nodes:
  scope:
    type: talk
    description: Agree on the scope.
  build:
    type: do
    description: Build it.
edges:
  - {from: scope, to: build}
`

let k = 0
async function setup() {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-p')
  const r = await createProject({ dir, id: 'p', name: 'P', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'make.yaml'), WF)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  await writeFile(join(area, 'zulip.json'), JSON.stringify({
    enabled: true, zulipUrl: `https://${REALM}`, viewBase: null, since: '2026-01-01T00:00:00.000Z', person: 'Pat',
    intake: { enabled: true, since: '2026-01-01T00:00:00.000Z', projects: { p: {} }, requesters: [{ id: PERSON, name: 'Pat' }] },
  }))
  const x = new ExecStore({ registryFile: registry, area })
  const n = new NotifyStore({ area, registryFile: registry, exec: x })
  await n.due() // records the targets
  n.recordTarget('channel:p/make', { zulipId: STREAM })
  const posted = new Map<string, number>()
  const open = () => new IntakeStore({ area, registryFile: registry, exec: x, notify: n, posted: (_k, _r, q) => posted.get(q) ?? null })
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  return { area, registry, dir, x, n, ws, posted, open, i: open() }
}

let nextId = 1000
const post = (o: Partial<InboundMessage> = {}): InboundMessage => {
  const id = o.id ?? ++nextId
  return { realm: REALM, id, streamId: STREAM, topic: 'request-thing', sender: { id: PERSON, name: 'Pat Person', email: 'pat@x', bot: false }, content: 'Please make a thing.', timestamp: 1_790_000_000, topicFirst: id, ...o }
}
const receive = (i: IntakeStore, msgs: InboundMessage[]) => i.receive({ realm: REALM, streamId: STREAM, through: Math.max(0, ...msgs.map(m => m.id)), messages: JSON.parse(JSON.stringify(msgs)) })
const record = async (ws: Workspace, ref: RunRef) => (await readRun(ws, ref)).record!

test('routes: the recorded channel of a workflow that declares intake, in an enabled project', async () => {
  const { i } = await setup()
  const due = await i.due()
  assert.equal(due.realm, REALM)
  assert.deepEqual(due.channels, [{ streamId: STREAM, project: 'p', workflow: 'make', cursor: 0 }])
  i.close()
})

test('a request topic: bots, strangers and run topics change nothing; the first eligible post becomes the run, once', async () => {
  const { i, ws, x } = await setup()
  const first = post({ sender: { id: BOT, name: 'bot', email: 'b@x', bot: true }, content: 'bot noise' })
  const stranger = post({ topicFirst: first.id, sender: { id: STRANGER, name: 'S', email: 's@x', bot: false }, content: 'do my thing instead' })
  const request = post({ topicFirst: first.id, content: 'Please make a **blue** thing.\n\nTwo lines.' })
  const runTopic = post({ topic: 'run-001', content: 'is it done?' })
  const stored = receive(i, [first, stranger, request, runTopic])
  assert.deepEqual(stored, { stored: 4, duplicates: 0, cursor: runTopic.id })
  assert.deepEqual(receive(i, [first, stranger, request, runTopic]), { stored: 0, duplicates: 4, cursor: runTopic.id }, 'repeated delivery stores nothing')
  await i.process()
  await i.process()
  const runs = await listRuns(ws)
  assert.equal(runs.length, 1, 'exactly one run')
  const rec = await record(ws, { workflow: 'make', run: 'run-001' })
  assert.equal(await readFile(join((await runSpace(ws, { workflow: 'make', run: 'run-001' })).root, 'devdocs/runs/make/run-001/braindump.md'), 'utf8'), 'Please make a **blue** thing.\n\nTwo lines.', 'the post\'s own words, unchanged')
  assert.deepEqual(rec.input.source, { kind: 'zulip', realm: REALM, message: request.id, stream: STREAM, topic: 'request-thing', sender: PERSON, senderName: 'Pat Person', at: new Date(request.timestamp * 1000).toISOString() })
  assert.equal(rec.input.author, 'Pat')
  assert.equal(rec.history[0].receipt, sourceReceipt(REALM, request.id))
  assert.deepEqual(rec.executor, { name: 'maker', backend: null, host: 'autolab' })
  const jobs = (await x.runView(ws.reg.id, { workflow: 'make', run: 'run-001' })).jobs
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].receipt, `request:${sourceReceipt(REALM, request.id)}`)
  const states = Object.fromEntries(i.messages().map(m => [m.id, [m.state, m.route ? JSON.parse(m.route).reason ?? JSON.parse(m.route).kind : null, m.classification ? JSON.parse(m.classification).kind : null]]))
  assert.deepEqual(states[first.id], ['done', 'new', 'ignored'])
  assert.deepEqual(states[stranger.id], ['done', 'new', 'ignored'])
  assert.deepEqual(states[request.id], ['done', 'new', 'request'])
  assert.deepEqual(states[runTopic.id], ['done', 'run-topic', null])
  const st = i.status()
  assert.equal(st.requests.length, 1)
  assert.equal(st.requests[0].key, `r${request.id}`)
  assert.equal(st.requests[0].topic_first, first.id, 'identity: the topic\'s first message')
  assert.equal(st.requests[0].run, 'run-001')
  i.close()
})

test('restart after the run was created and before it was recorded: the run is found by its receipt', async () => {
  const { i, ws, x } = await setup()
  const request = post()
  receive(i, [request])
  // Simulate the crash: classify only, then create the run by hand as the
  // interrupted application did, leaving the inbox at `classified`.
  const routed = await i.routes()
  assert.ok(!('disabled' in routed))
  await (i as unknown as { classifyRow: (r: unknown, x: unknown) => Promise<string> }).classifyRow(i.message(REALM, request.id), routed)
  assert.equal(i.message(REALM, request.id)!.state, 'classified')
  await createRun(ws, { workflow: 'make', receipt: sourceReceipt(REALM, request.id), executor: { host: 'autolab' }, by: 'Pat', via: 'zulip', input: { kind: 'braindump', text: request.content, author: 'Pat' } })
  // Restart: a new store over the same files.
  i.close()
  const again = new IntakeStore({ area: (i as unknown as { area: string }).area, registryFile: (i as unknown as { registryFile: string }).registryFile, exec: x })
  await again.process()
  assert.equal((await listRuns(ws)).length, 1, 'no second run')
  assert.equal(again.message(REALM, request.id)!.state, 'done')
  assert.equal(again.status().requests[0].run, 'run-001')
  assert.equal((await x.runView(ws.reg.id, { workflow: 'make', run: 'run-001' })).jobs.length, 1, 'queued once')
  again.close()
})

// A run waiting on q1 (asked from scope), its question posted as message `at`.
async function waitingRun(s: Awaited<ReturnType<typeof setup>>, at: number) {
  const request = post({ id: at - 10, topicFirst: at - 10 })
  receive(s.i, [request])
  await s.i.process()
  const ref = { workflow: 'make', run: 'run-001' }
  // The start job ran (its attempt is not modelled here).
  s.x.db.prepare('UPDATE jobs SET state = \'done\'').run()
  await runOp(s.ws, ref, { op: 'node.start', node: 'scope' }, { by: 'maker', via: 'cli' })
  await runOp(s.ws, ref, { op: 'question.ask', question: 'q1', node: 'scope', text: 'Blue or red?', to: 'Pat' }, { by: 'maker', via: 'cli' })
  s.posted.set('q1', at)
  return { ref, topicFirst: request.id }
}

test('an answer is recorded with its real sender and source, once, and the resumption is queued once — also after a restart between them', async () => {
  const s = await setup()
  const { ref, topicFirst } = await waitingRun(s, 2000)
  const early = post({ id: 1995, topicFirst, content: 'by the way, keep it small' }) // written before q1 was posted
  const answer = post({ id: 2005, topicFirst, content: 'Blue, please.' })
  receive(s.i, [early, answer])
  // Crash after the run recorded the answer and before the inbox said so.
  const routed = await s.i.routes()
  assert.ok(!('disabled' in routed))
  const cls = (s.i as unknown as { classifyRow: (r: unknown, x: unknown) => Promise<string> })
  await cls.classifyRow(s.i.message(REALM, early.id), routed)
  await (s.i as unknown as { applyRow: (r: unknown) => Promise<string> }).applyRow(s.i.message(REALM, early.id))
  await (s.i as unknown as { followUp: (r: unknown) => Promise<string> }).followUp(s.i.message(REALM, early.id))
  await cls.classifyRow(s.i.message(REALM, answer.id), routed)
  assert.deepEqual(JSON.parse(s.i.message(REALM, answer.id)!.classification!), { kind: 'answer', question: 'q1', by: 'pending' })
  await runOp(s.ws, ref, { op: 'question.answer', question: 'q1', text: answer.content, from: 'Pat', receipt: sourceReceipt(REALM, answer.id) }, { by: 'Pat', via: 'zulip' })
  await s.i.process()
  await s.i.process()
  const rec = await record(s.ws, ref)
  assert.equal(rec.questions.q1.answers.length, 1, 'the answer is recorded once')
  assert.equal(rec.instructions?.i1.text, 'by the way, keep it small', 'the earlier post became an instruction, not the answer')
  assert.equal(rec.questions.q1.answers[0].from, 'Pat')
  assert.equal(rec.questions.q1.answers[0].via, 'zulip')
  assert.equal(rec.nodes.scope.state, 'waiting', 'recorded, not taken up')
  const jobs = (await s.x.runView(s.ws.reg.id, ref)).jobs.filter(j => j.kind === 'resume')
  assert.equal(jobs.length, 1, 'the resumption is queued once')
  assert.match(jobs[0].receipt, /^answer:/)
  // The full source is on the answer that the intake applied (the hand-made one above has none).
  const again = post({ id: 2006, topicFirst, content: 'Actually blue-green.' })
  receive(s.i, [again])
  await s.i.process()
  const rec2 = await record(s.ws, ref)
  assert.equal(rec2.questions.q1.answers.length, 2, 'a further answer before take-up is another answer to q1')
  assert.equal(rec2.questions.q1.answers[1].source?.message, again.id)
  assert.equal((await s.x.runView(s.ws.reg.id, ref)).jobs.filter(j => j.kind === 'resume').length, 1, 'still one resumption queued')
  s.i.close()
})

test('instructions do not touch nodes; ambiguity, late replies and completed runs are explained, not applied', async () => {
  const s = await setup()
  const { ref, topicFirst } = await waitingRun(s, 3000)
  await runOp(s.ws, ref, { op: 'question.answer', question: 'q1', text: 'red', from: 'Pat' }, { by: 'Pat', via: 'browser' })
  await runOp(s.ws, ref, { op: 'question.take-up', question: 'q1' }, { by: 'maker', via: 'cli' })
  await runOp(s.ws, ref, { op: 'node.complete', node: 'scope', outcome: 'red' }, { by: 'maker', via: 'cli' })
  await runOp(s.ws, ref, { op: 'node.start', node: 'build' }, { by: 'maker', via: 'cli' })
  const instr = post({ id: 3010, topicFirst, content: 'make it bigger' })
  const late = post({ id: 3011, topicFirst, content: 'q1: actually blue' })
  receive(s.i, [instr, late])
  await s.i.process()
  let rec = await record(s.ws, ref)
  assert.deepEqual(Object.keys(rec.instructions ?? {}), ['i1'])
  assert.equal(rec.instructions!.i1.text, 'make it bigger')
  assert.deepEqual(rec.instructions!.i1.during, ['build'], 'it arrived while build ran')
  assert.equal(rec.instructions!.i1.ack, null, 'received, not acknowledged')
  assert.equal(rec.nodes.build.state, 'running', 'the running node is untouched')
  assert.equal(rec.questions.q1.answers.length, 1, 'a late reply is applied nowhere')
  assert.equal(s.i.message(REALM, late.id)!.notice, 'late')
  // Completion: a further post is kept and explained; no new run, nothing reopened.
  await runOp(s.ws, ref, { op: 'instruction.ack', instructions: ['i1'], response: 'incorporate', note: 'bigger' }, { by: 'maker', via: 'cli' })
  await runOp(s.ws, ref, { op: 'node.complete', node: 'build', outcome: 'built' }, { by: 'maker', via: 'cli' })
  const after = post({ id: 3020, topicFirst, content: 'one more thing' })
  receive(s.i, [after])
  await s.i.process()
  rec = await record(s.ws, ref)
  assert.equal(rec.execution.state, 'completed')
  assert.deepEqual(Object.keys(rec.instructions ?? {}), ['i1'])
  assert.deepEqual(JSON.parse(s.i.message(REALM, after.id)!.classification!), { kind: 'closed', reason: 'completed' })
  assert.equal(s.i.message(REALM, after.id)!.notice, 'closed')
  assert.equal((await listRuns(s.ws)).length, 1)
  s.i.close()
})

test('posts of a request settle in order; a second request in the same workspace is a run of its own (p9: no run reserves the project)', async () => {
  const s = await setup()
  const a = post({ id: 4000, topicFirst: 4000, topic: 'request-a' })
  const b = post({ id: 4001, topicFirst: 4001, topic: 'request-b', content: 'another thing' })
  receive(s.i, [a, b])
  await s.i.process()
  const reqs = s.i.status().requests
  assert.deepEqual(reqs.map(r => [r.key, r.state]), [['r4000', 'bound'], ['r4001', 'bound']])
  assert.deepEqual((await listRuns(s.ws)).map(r => r.ref), ['make/run-001', 'make/run-002'], 'each request its own run, in arrival order')
  // A later post in the second topic belongs to the second run.
  const c = post({ id: 4002, topicFirst: 4001, topic: 'request-b', content: 'hello?' })
  receive(s.i, [c])
  await s.i.process()
  assert.notEqual(JSON.parse(s.i.message(REALM, c.id)!.classification!).kind, 'closed')
  assert.equal((await listRuns(s.ws)).length, 2)
  s.i.close()
})

test('a failure is kept with its stage and retried from there; a rename keeps the binding, a reused name does not', async () => {
  const s = await setup()
  const request = post({ id: 5000, topicFirst: 5000 })
  receive(s.i, [request])
  // The workspace disappears from the registry between classification and application.
  const reg = await readFile(s.registry, 'utf8')
  await s.i.process()
  const ref = { workflow: 'make', run: 'run-001' }
  await runOp(s.ws, ref, { op: 'node.start', node: 'scope' }, { by: 'maker', via: 'cli' })
  const instr = post({ id: 5001, topicFirst: 5000, content: 'note this' })
  receive(s.i, [instr])
  const routed = await s.i.routes()
  assert.ok(!('disabled' in routed))
  await (s.i as unknown as { classifyRow: (r: unknown, x: unknown) => Promise<string> }).classifyRow(s.i.message(REALM, instr.id), routed)
  await writeFile(s.registry, JSON.stringify({ ...JSON.parse(reg), workspaces: [] }))
  const notes = await s.i.process()
  assert.match(notes.join('\n'), /5001: failed at classified/)
  const failed = s.i.message(REALM, instr.id)!
  assert.equal(failed.state, 'failed')
  assert.equal(failed.stage, 'classified')
  assert.match(s.i.problems().join('\n'), /post 5001 failed at classified/)
  await writeFile(s.registry, reg)
  assert.equal(s.i.retry(REALM, instr.id), 1)
  await s.i.process()
  assert.equal(s.i.message(REALM, instr.id)!.state, 'done')
  assert.equal(Object.keys((await record(s.ws, ref)).instructions ?? {}).length, 1)
  // The name reused by a new topic while the request still holds it: a
  // problem, not routed by name.
  const reused = post({ id: 5002, topicFirst: 5002, topic: 'request-thing', content: 'new thing?' })
  // Then the request's topic is renamed (resolved): same first message,
  // new name → the same request.
  const renamed = post({ id: 5003, topicFirst: 5000, topic: '✔ request-thing', content: 'still here' })
  receive(s.i, [reused, renamed])
  await s.i.process()
  assert.equal(s.i.message(REALM, renamed.id)!.state, 'done')
  assert.equal(JSON.parse(s.i.message(REALM, renamed.id)!.classification!).kind, 'instruction')
  assert.equal(s.i.status().requests[0].topic, '✔ request-thing')
  assert.deepEqual(s.i.relocations('r5000').map(r => [r.from_topic, r.to_topic]), [['request-thing', '✔ request-thing']])
  assert.equal(s.i.message(REALM, reused.id)!.notice, 'problem')
  assert.equal(JSON.parse(s.i.message(REALM, reused.id)!.route!).reason, 'topic-name-reused')
  assert.equal(Object.keys((await record(s.ws, ref)).instructions ?? {}).length, 2)
  s.i.close()
})

test('the cursor moves only with stored posts; a transport failure stays visible', async () => {
  const s = await setup()
  assert.equal(s.i.cursor(REALM, STREAM), 0)
  s.i.receive({ realm: REALM, streamId: STREAM, through: 7000, messages: [] })
  assert.equal(s.i.cursor(REALM, STREAM), 7000, 'read up to 7000, nothing to store')
  assert.throws(() => s.i.receive({ realm: REALM, streamId: STREAM, through: 7000, messages: [JSON.parse(JSON.stringify(post({ id: 7005 })))] }), /--through/)
  assert.equal(s.i.cursor(REALM, STREAM), 7000, 'a refused receipt moves nothing')
  assert.throws(() => s.i.receive({ realm: REALM, streamId: STREAM, through: 7010, messages: [{ id: 7006 }] }))
  assert.equal(s.i.cursor(REALM, STREAM), 7000)
  s.i.transportResult({ ok: false, error: 'HTTP 401: invalid API key' })
  assert.match(s.i.problems().join('\n'), /last pass failed .*401/)
  s.i.transportResult({ ok: true })
  assert.doesNotMatch(s.i.problems().join('\n'), /transport/)
  s.i.close()
})


test('all registered projects route without an intake project allowlist; renamed basic template accepts a request', async () => {
  const { i, ws, area, n } = await setup()
  const path = join(area, 'zulip.json')
  const cfg = JSON.parse(await readFile(path, 'utf8'))
  delete cfg.intake.projects
  await writeFile(path, JSON.stringify(cfg))
  await ws.createWorkflow('conversation', 'Conversation', undefined, 'freework')
  await n.due()
  const stream = STREAM + 1
  n.recordTarget('channel:p/conversation', { zulipId: stream })
  const due = await i.due()
  assert.deepEqual(due.channels.map(c => c.workflow).sort(), ['conversation', 'make'])
  assert.ok(due.channels.some(c => c.workflow === 'conversation' && c.streamId === stream))
  const request = post({ streamId: stream })
  i.receive({ realm: REALM, streamId: stream, through: request.id, messages: [request] })
  await i.process()
  const rec = await record(ws, { workflow: 'conversation', run: 'run-001' })
  assert.equal(rec.input.author, 'Pat')
  assert.deepEqual(Object.keys(rec.nodes).sort(), ['_final-report', 'talk'])
  i.close()
})

test('an empty template declares intake too, while an explicit workflow opt-out is respected', async () => {
  const { i, ws, n } = await setup()
  await ws.createWorkflow('blank', 'Blank')
  const path = join(ws.root, 'devdocs', 'workflows', 'blank.yaml')
  const text = await readFile(path, 'utf8')
  assert.match(text, /zulip: requests/)
  await n.due()
  n.recordTarget('channel:p/blank', { zulipId: STREAM + 1 })
  assert.ok((await i.due()).channels.some(c => c.workflow === 'blank'))
  await writeFile(path, text.replace('zulip: requests', 'zulip: ""'))
  assert.ok(!(await i.due()).channels.some(c => c.workflow === 'blank'))
  i.close()
})

// observer p3: an agent named in intake.agents may open a request in the
// workflows it is named for — the post becomes a `request` input in the
// agent's own name; its other posts, and its posts elsewhere, are ignored.
test('an agent requester opens a request only in its named workflows; its words are a request, not a braindump', async () => {
  const { area, i, ws, x } = await setup()
  const OBSERVER = 23
  const cfg = JSON.parse(await readFile(join(area, 'zulip.json'), 'utf8'))
  cfg.intake.agents = [{ id: OBSERVER, name: 'Observer', workflows: ['p/make'] }]
  await writeFile(join(area, 'zulip.json'), JSON.stringify(cfg))
  const req = post({ topic: 'request-incident-i1', sender: { id: OBSERVER, name: 'agobserver', email: 'o@x', bot: true }, content: 'Investigate incident i1.' })
  const again = post({ topic: 'request-incident-i1', topicFirst: req.id, sender: { id: OBSERVER, name: 'agobserver', email: 'o@x', bot: true }, content: 'still there?' })
  receive(i, [req, again])
  await i.process(); await i.process()
  const ref = { workflow: 'make', run: 'run-001' }
  const rec = await record(ws, ref)
  assert.equal(rec.input.kind, 'request')
  assert.equal(rec.input.requester, 'Observer')
  assert.deepEqual(rec.input.entrustedBy, { kind: 'note', text: `Zulip post ${req.id} in request-incident-i1` })
  assert.equal(rec.input.source?.message, req.id)
  assert.equal(rec.history[0].by, 'Observer')
  assert.equal(await readFile(join((await runSpace(ws, ref)).root, 'devdocs/runs/make/run-001/request.md'), 'utf8'), 'Investigate incident i1.')
  assert.equal((await x.runView(ws.reg.id, ref)).jobs.length, 1, 'queued like any request')
  const states = Object.fromEntries(i.messages().map(m => [m.id, m.classification ? JSON.parse(m.classification) : null]))
  assert.deepEqual(states[again.id], { kind: 'ignored', reason: 'bot' }, 'an agent\'s later posts are not input')
  // The same agent in a workflow it is not named for: ignored.
  cfg.intake.agents = [{ id: OBSERVER, name: 'Observer', workflows: ['p/other'] }]
  await writeFile(join(area, 'zulip.json'), JSON.stringify(cfg))
  const elsewhere = post({ topic: 'request-incident-i2', sender: { id: OBSERVER, name: 'agobserver', email: 'o@x', bot: true }, content: 'Investigate incident i2.' })
  receive(i, [elsewhere])
  await i.process()
  assert.equal((await listRuns(ws)).length, 1)
  assert.deepEqual(JSON.parse(i.messages().find(m => m.id === elsewhere.id)!.classification!), { kind: 'ignored', reason: 'bot' })
  i.close()
})
