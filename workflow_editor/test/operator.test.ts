// project_migration p8 step 2: the operations an agent performs on the
// system as a person does from the browser. A conversational run grows a
// delegate node by adjustment and carries it through the child's question,
// result and its own judgement; another run's attempt records as itself
// when it instructs, answers or stops a run it does not execute; an
// instruction continues a run nobody executes; an agent's request is queued
// once for a retried command; a definition saved from a stale read is refused
// with the current revision; and the browser's raw operation route cannot
// record delegations or assignments without their domain checks.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { InboundMessage } from '../shared/intake.ts'
import { createHandler } from '../server/api.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { IntakeStore } from '../server/intake.ts'
import { NotifyStore } from '../server/notify.ts'
import { loadRegistry } from '../server/registry.ts'
import { adjustRun, listRuns, readRun, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'
import { parseWorkflow } from '../server/yamlDoc.ts'
import type { OpInput, RunRecord, RunRef } from '../shared/run.ts'

const pexec = promisify(execFile)
const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-operator-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const REALM = 'chat.example:8543'
const FRONT_STREAM = 611, KID_STREAM = 711, PERSON = 8, BOT = 11

// A conversational workflow in the freework pattern: one talk node; the run
// adds what the conversation needs.
const CONVERSE = `schema: ag.workflow.v2
id: converse
name: Converse
intent: |
  Serve what the person says.
documentation: {policy: custom, plan: false, reports: false, final: false}
execution: {agent: front-agent}
intake: {zulip: requests}
repositories:
  root: {path: ., access: editable}
nodes:
  talk:
    type: talk
    description: Understand the request.
`
const GROWN = `${CONVERSE}  asset:
    type: delegate
    description: Get the icon from the kid project.
    project: kid
    workflow: make
    accepts: parent
edges:
  - {from: talk, to: asset}
`
const KID_WF = `schema: ag.workflow.v2
id: make
name: Make
intent: |
  Make what is asked.
documentation: {policy: manual}
execution: {agent: kid-agent}
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
  confirm:
    type: talk
    confirms: result
    description: Confirm the result.
edges:
  - {from: scope, to: build}
  - {from: build, to: confirm}
`

let k = 0
async function project(area: string, registry: string, id: string, wf: { file: string; text: string }) {
  const dir = join(area, `pj-${id}`)
  const r = await createProject({ dir, id, name: id, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', wf.file), wf.text)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, `${id}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote]); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
}

async function setup() {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  await project(area, registry, 'front', { file: 'converse.yaml', text: CONVERSE })
  await project(area, registry, 'kid', { file: 'make.yaml', text: KID_WF })
  await writeFile(join(area, 'zulip.json'), JSON.stringify({
    enabled: true, zulipUrl: `https://${REALM}`, viewBase: null, since: '2026-01-01T00:00:00.000Z', person: 'Pat',
    intake: { enabled: true, since: '2026-01-01T00:00:00.000Z', projects: {}, requesters: [{ id: PERSON, name: 'Pat' }] },
  }))
  const x = new ExecStore({ registryFile: registry, area })
  const n = new NotifyStore({ area, registryFile: registry, exec: x })
  await n.due()
  for (const [key, id] of [['folder:front', 100], ['folder:kid', 101], ['channel:front/converse', FRONT_STREAM], ['channel:kid/make', KID_STREAM]] as const) n.recordTarget(key, { zulipId: id })
  const i = new IntakeStore({ area, registryFile: registry, exec: x, notify: n, posted: n.postedLookup() })
  n.intake = i
  const regs = (await loadRegistry(registry)).workspaces
  const front = new Workspace(regs.find(w => w.project === 'front')!)
  const kid = new Workspace(regs.find(w => w.project === 'kid')!)
  return { area, registry, x, n, i, front, kid, zulip: new Zulip(n, i) }
}
type S = Awaited<ReturnType<typeof setup>>
const close = (s: S) => { s.i.close(); s.n.close(); s.x.close() }

// The Zulip transport, in-process (as in delegateflow.test.ts).
class Zulip {
  posts: InboundMessage[] = []
  next = 60_000
  firsts = new Map<string, number>()
  n: NotifyStore
  i: IntakeStore
  constructor(n: NotifyStore, i: IntakeStore) { this.n = n; this.i = i }
  post(o: { streamId: number; topic: string; content: string }): InboundMessage {
    const id = ++this.next
    const key = `${o.streamId}\0${o.topic}`
    if (!this.firsts.has(key)) this.firsts.set(key, id)
    const m: InboundMessage = { realm: REALM, id, streamId: o.streamId, topic: o.topic, sender: { id: BOT, name: 'autolab', email: 'bot@x', bot: true }, content: o.content, timestamp: 1_790_000_000, topicFirst: this.firsts.get(key)! }
    this.posts.push(m)
    return m
  }
  async cycle() {
    for (let round = 0; round < 30; round++) {
      const c = await this.n.claim({ owner: 'test-transport', pid: process.pid })
      if (!c.deliveries.length) break
      for (const d of c.deliveries) {
        this.n.begin(d.delivery, d.claim, { destination: d.destination, ...(d.reconcile ? { checkedAbsent: 'absent (test transport)' } : {}), events: d.events })
        const m = this.post({ streamId: d.destination.streamId, topic: d.destination.topic, content: d.content })
        this.n.acknowledge(d.delivery, d.claim, { messageId: m.id, destination: d.destination, events: d.events })
      }
    }
    for (const stream of [FRONT_STREAM, KID_STREAM]) {
      const cursor = this.i.cursor(REALM, stream)
      const msgs = this.posts.filter(p => p.streamId === stream && p.id > cursor)
      if (msgs.length) this.i.receive({ realm: REALM, streamId: stream, through: Math.max(...msgs.map(m => m.id)), messages: JSON.parse(JSON.stringify(msgs)) })
    }
    return this.i.process()
  }
}

const rec = async (ws: Workspace, ref: RunRef): Promise<RunRecord> => (await readRun(await runSpace(ws, ref), ref)).record!
const claim = async (s: S) => { const c = await s.x.claim('test'); assert.ok('attempt' in c, JSON.stringify(c)); return c as Exclude<typeof c, { idle: string }> }
const as = (ws: Workspace, ref: RunRef, attempt: string, by: string) => (op: OpInput) => runOp(ws, ref, { ...op, attempt } as never, { by, via: 'cli' })

// The person's message, a Front run for it, and its first attempt growing a
// delegate node and dispatching it.
async function grown(s: S) {
  const { ref } = await s.x.request({ workspace: 'front', workflow: 'converse', text: 'I need a blue icon for the game.', author: 'Pat', receipt: 'conversation:c1:m1', via: 'conversation' })
  const a = await claim(s)
  const front = as(s.front, ref, a.attempt.id, 'front-agent')
  await front({ op: 'node.start', node: 'talk' })
  const adj = await adjustRun(s.front, ref, { text: GROWN, reason: 'the icon is the kid project\'s work', source: { kind: 'agent' }, completing: { node: 'talk', outcome: 'An icon from the kid project.' } }, { by: 'front-agent', via: 'cli', attempt: a.attempt.id })
  assert.ok(adj.ok, JSON.stringify(adj.problems))
  assert.deepEqual((await rec(s.front, ref)).execution.ready, ['asset'])
  await front({ op: 'node.start', node: 'asset' })
  const d = await s.x.delegate.dispatch(s.front, ref, 'asset', { request: 'Make a 64x64 blue icon for a game button.', attempt: a.attempt.id, by: 'front-agent', via: 'cli' })
  assert.equal(d.delegation.id, 'd1')
  assert.deepEqual(d.delegation.target, { project: 'kid', workflow: 'make', workspace: s.kid.reg.id })
  const f = await s.x.finished(a.attempt.id, { code: 0, signal: null })
  assert.equal(f.outcome, 'exited', 'waiting on the added delegation is a normal end')
  return { ref }
}

test('a delegate node added by adjustment: dispatch, the child\'s question and result, the parent\'s judgement and its own completion', async () => {
  const s = await setup()
  const { ref } = await grown(s)
  await s.zulip.cycle()
  const kids = await listRuns(s.kid)
  assert.equal(kids.length, 1, 'one child, from the dispatched request')
  const kidRef = { workflow: 'make', run: kids[0].run }
  assert.equal((await rec(s.kid, kidRef)).input.requester, 'front-agent')
  // The child asks a question; the parent is continued for it and answers.
  const c1 = await claim(s)
  assert.deepEqual(c1.ref, kidRef)
  const kid = as(s.kid, kidRef, c1.attempt.id, 'kid-agent')
  await kid({ op: 'node.start', node: 'scope' })
  await kid({ op: 'question.ask', question: 'q1', node: 'scope', text: 'Transparent background?', to: 'front-agent' })
  await s.x.finished(c1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const p1 = await claim(s)
  assert.deepEqual(p1.ref, ref, 'the question continues the parent')
  assert.match(p1.brief, /event 1 \(question q1\), not taken up/)
  await as(s.front, ref, p1.attempt.id, 'front-agent')({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  await s.x.delegate.answer(s.front, ref, 'd1', 'q1', 'Yes, transparent.', { by: 'front-agent', via: 'cli', attempt: p1.attempt.id })
  await s.x.finished(p1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  // The child builds and asks for its result's confirmation.
  const c2 = await claim(s)
  const kid2 = as(s.kid, kidRef, c2.attempt.id, 'kid-agent')
  await kid2({ op: 'question.take-up', question: 'q1' })
  await kid2({ op: 'node.complete', node: 'scope', outcome: 'transparent' })
  await kid2({ op: 'node.start', node: 'build' })
  await writeFile(join((await runSpace(s.kid, kidRef)).root, 'icon.txt'), 'a blue icon\n')
  await kid2({ op: 'node.complete', node: 'build', outcome: 'icon.txt', artifacts: ['icon.txt'] })
  await kid2({ op: 'node.start', node: 'confirm' })
  await kid2({ op: 'question.ask', question: 'q2', node: 'confirm', text: 'Here it is. Accept?', to: 'front-agent', subjects: ['icon.txt'] } as never)
  await s.x.finished(c2.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const p2 = await claim(s)
  assert.deepEqual(p2.ref, ref)
  let p = await rec(s.front, ref)
  const confirm = p.delegations!.d1.events.find(e => e.question === 'q2')!
  assert.equal(confirm.confirms, true)
  await as(s.front, ref, p2.attempt.id, 'front-agent')({ op: 'delegation.take-up', delegation: 'd1', events: [confirm.n] } as never)
  await s.x.delegate.answer(s.front, ref, 'd1', 'q2', 'Accepted.', { by: 'front-agent', via: 'cli', attempt: p2.attempt.id })
  await s.x.finished(p2.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const c3 = await claim(s)
  const kid3 = as(s.kid, kidRef, c3.attempt.id, 'kid-agent')
  await kid3({ op: 'question.take-up', question: 'q2' })
  await runOp(s.kid, kidRef, { op: 'run.decide', decision: 'accepted', question: 'q2', attempt: c3.attempt.id } as never, { by: 'kid-agent', via: 'cli' })
  await kid3({ op: 'node.complete', node: 'confirm', outcome: 'Accepted by the requester.' })
  await s.x.finished(c3.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  // The result continues the parent; it judges it and completes.
  const p3 = await claim(s)
  assert.deepEqual(p3.ref, ref)
  p = await rec(s.front, ref)
  const result = p.delegations!.d1.events.find(e => e.type === 'completed')!
  assert.deepEqual(result.manifest?.artifacts.map(x => x.path), ['icon.txt'])
  const front = as(s.front, ref, p3.attempt.id, 'front-agent')
  await front({ op: 'delegation.take-up', delegation: 'd1', events: [result.n] } as never)
  await front({ op: 'delegation.dispose', delegation: 'd1', disposition: 'satisfied', note: 'the blue icon asked for' } as never)
  await front({ op: 'node.complete', node: 'asset', outcome: 'The icon came back and is what was asked.' })
  await s.x.finished(p3.attempt.id, { code: 0, signal: null })
  p = await rec(s.front, ref)
  assert.equal(p.execution.state, 'completed', 'the grown run completes with its added node')
  assert.equal(p.delegations!.d1.disposition?.kind, 'satisfied')
  // An instruction now continues nothing: the run is completed.
  await runOp(s.front, ref, { op: 'instruction.receive', text: 'and a red one', from: 'Pat' }, { by: 'Pat', via: 'browser' })
  assert.equal(await s.x.afterInstruction(s.front, ref, 'i1'), null)
  close(s)
})

test('an instruction continues a run nobody executes — once — and leaves a held one to its resume', async () => {
  const s = await setup()
  const { ref } = await grown(s)
  assert.deepEqual(await s.x.claim('test'), { idle: 'no queued job' }, 'waiting on its child, the parent is not queued')
  await runOp(s.front, ref, { op: 'instruction.receive', text: 'Make it red instead.', from: 'Pat' }, { by: 'front-agent', via: 'cli' })
  const job = await s.x.afterInstruction(s.front, ref, 'i1')
  assert.ok(job)
  assert.equal(job.receipt, 'instruction:front/converse/run-001/i1')
  assert.equal((await s.x.afterInstruction(s.front, ref, 'i1'))?.id, job.id, 'the same instruction twice is one job')
  const a = await claim(s)
  assert.deepEqual(a.ref, ref)
  assert.match(a.brief, /Make it red instead/)
  await as(s.front, ref, a.attempt.id, 'front-agent')({ op: 'instruction.ack', instructions: ['i1'], response: 'incorporate', note: 'tell the child' } as never)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  // Held: recorded, nothing queued.
  await s.x.stop(s.front, ref, 'Pat', 'pause', 'browser')
  await runOp(s.front, ref, { op: 'instruction.receive', text: 'Actually green.', from: 'Pat' }, { by: 'Pat', via: 'browser' })
  assert.equal(await s.x.afterInstruction(s.front, ref, 'i2'), null)
  close(s)
})

test('another run\'s attempt records as its own agent when it instructs, answers and stops a run it does not execute', async () => {
  const s = await setup()
  const { ref } = await grown(s)
  await s.zulip.cycle()
  const kidRef = { workflow: 'make', run: 'run-001' }
  const c1 = await claim(s)
  const kid = as(s.kid, kidRef, c1.attempt.id, 'kid-agent')
  await kid({ op: 'node.start', node: 'scope' })
  await kid({ op: 'question.ask', question: 'q1', node: 'scope', text: 'Size?', to: 'Pat' })
  await s.x.finished(c1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  // Front's run is continued (its child asked), so it has an open attempt.
  const p1 = await claim(s)
  assert.deepEqual(p1.ref, ref)
  const cli = (args: string[], attempt = p1.attempt.id) => pexec(process.execPath, [join(pkg, 'cli', 'wfe.ts'), 'run', ...args, '--registry', s.registry, '--area', s.area, '--workspace', 'kid', '--json'], { env: { ...process.env, WFE_ATTEMPT: attempt } })
    .then(r => ({ code: 0, out: JSON.parse(r.stdout), err: r.stderr }), e => ({ code: e.code as number, out: JSON.parse(e.stdout || '{}'), err: String(e.stderr) }))
  const ins = await cli(['instruct', 'make/run-001', '--instruction', 'Make it 64px.', '--from', 'Pat'])
  assert.equal(ins.code, 0, ins.err)
  let child = await rec(s.kid, kidRef)
  const entry = child.history.at(-1)!
  assert.equal(entry.op, 'instruction.receive')
  assert.equal(entry.by, 'front-agent', 'Front records as itself, not as the child\'s agent')
  assert.equal(entry.attempt, undefined, 'its attempt is not the child\'s fencing')
  assert.deepEqual(entry.operator, { run: 'front/converse/run-001', attempt: p1.attempt.id })
  assert.equal(child.instructions!.i1.from, 'Pat', 'the person\'s words stay the person\'s')
  // Another name is refused; the person's words are named with --from instead.
  const other = await cli(['instruct', 'make/run-001', '--instruction', 'x', '--by', 'Pat'])
  assert.equal(other.code, 1)
  assert.match(other.out.error ?? other.err, /records as front-agent/)
  // Answering the child's question to the person, on the person's words.
  const ans = await cli(['answer', 'make/run-001', 'q1', '--answer', '64px, as Pat said in the conversation.', '--from', 'Pat'])
  assert.equal(ans.code, 0, ans.err)
  child = await rec(s.kid, kidRef)
  assert.deepEqual([child.questions.q1.answers[0].by, child.questions.q1.answers[0].from], ['front-agent', 'Pat'])
  // Stopping it: a control act on a run it does not execute.
  const stop = await cli(['stop', 'make/run-001', '--reason', 'the person changed the plan'])
  assert.equal(stop.code, 0, stop.err)
  child = await rec(s.kid, kidRef)
  assert.equal(child.control.hold?.kind, 'stopped')
  assert.equal(child.history.at(-1)!.by, 'front-agent')
  // An ended attempt records nothing.
  await s.x.finished(p1.attempt.id, { code: 0, signal: null })
  const late = await cli(['instruct', 'make/run-001', '--instruction', 'late', '--from', 'Pat'])
  assert.equal(late.code, 1)
  assert.match(late.out.error ?? late.err, /has ended/)
  close(s)
})

test('an agent\'s request is queued as its request, with the person served and the original words, once for a retried command', async () => {
  const s = await setup()
  const { ref } = await grown(s)
  const p = await s.x.claim('test') // nothing: the parent waits
  assert.ok('idle' in p)
  // A command an attempt runs: requester and entrusted-by come from its run; the receipt from the attempt and the text.
  const { ref: fr } = await s.x.request({ workspace: 'front', workflow: 'converse', text: 'second message', author: 'Pat', receipt: 'conversation:c1:m2', via: 'conversation' })
  const a = await claim(s)
  assert.deepEqual(a.ref, fr)
  await writeFile(join(s.area, 'req.md'), 'Make a red icon, 64x64, transparent.')
  await writeFile(join(s.area, 'orig.md'), 'can I also have a red one?')
  const cli = () => pexec(process.execPath, [join(pkg, 'cli', 'wfe.ts'), 'request', 'make', '--request', join(s.area, 'req.md'), '--on-behalf-of', 'Pat', '--original', join(s.area, 'orig.md'), '--registry', s.registry, '--area', s.area, '--workspace', 'kid', '--json'], { env: { ...process.env, WFE_ATTEMPT: a.attempt.id } }).then(r => JSON.parse(r.stdout))
  const first = await cli()
  const again = await cli()
  assert.equal(first.duplicate, false)
  assert.equal(again.duplicate, true, 'the retried command finds the same run')
  assert.deepEqual(again.ref, first.ref)
  const runs = await listRuns(s.kid)
  assert.equal(runs.length, 1)
  const child = await rec(s.kid, first.ref)
  assert.equal(child.input.kind, 'request')
  assert.equal(child.input.requester, 'front-agent')
  assert.equal(child.input.onBehalfOf, 'Pat')
  assert.deepEqual(child.input.entrustedBy, { kind: 'run', project: 'front', workflow: 'converse', run: fr.run })
  const space = await runSpace(s.kid, first.ref)
  assert.equal(await readFile(join(space.root, `devdocs/runs/make/${first.ref.run}/original-input.md`), 'utf8'), 'can I also have a red one?')
  assert.ok(ref)
  close(s)
})

test('a definition saved from a stale read is refused with the current revision; the browser route checks the same base', async () => {
  const s = await setup()
  const read = await s.kid.workflowResponse('make.yaml')
  const base = read.rev!
  const edited = parseWorkflow(KID_WF.replace('Make what is asked.', 'Make what is asked, small.'))
  assert.ok(edited.ok)
  // Someone else saves first (the editor).
  const theirs = parseWorkflow(KID_WF.replace('Build it.', 'Build it carefully.'))
  assert.ok(theirs.ok)
  const saved = await s.kid.saveWorkflow('make.yaml', theirs.model, base)
  await assert.rejects(s.kid.saveWorkflow('make.yaml', edited.model, base), (e: Error & { status?: number; detail?: { code?: string; rev?: string } }) => e.detail?.code === 'definition-conflict' && e.detail.rev === saved.rev)
  assert.match(await readFile(join(s.kid.root, 'devdocs/workflows/make.yaml'), 'utf8'), /Build it carefully/, 'their edit stays')
  const mine = await s.kid.saveWorkflow('make.yaml', edited.model, saved.rev)
  assert.notEqual(mine.rev, saved.rev)
  // The project file has the same check, also through HTTP.
  const srv = createServer(createHandler({ registryFile: s.registry, area: s.area, allowedOrigins: [], allowedHosts: ['127.0.0.1'], exec: s.x }))
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/workspaces/${s.kid.reg.id}`
  try {
    const p = await (await fetch(`${url}/project`)).json() as { rev: string; project: Record<string, unknown> }
    const stale = await fetch(`${url}/project`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: { ...p.project, intent: 'changed' }, base: 'not-the-revision' }) })
    assert.equal(stale.status, 409)
    assert.equal((await stale.json() as { detail?: { code?: string } }).detail?.code, 'definition-conflict')
    const ok = await fetch(`${url}/project`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: { ...p.project, intent: 'changed' }, base: p.rev }) })
    assert.equal(ok.status, 200)
    // Raw operations: no delegation, assignment or session retirement without its domain checks.
    for (const op of [{ op: 'delegation.dispose', delegation: 'd1', disposition: 'satisfied' }, { op: 'run.assign', node: 'x' }, { op: 'session.retire', reason: 'x' }]) {
      const r = await fetch(`${url}/runs/make/run-001/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...op, by: 'Pat' }) })
      assert.equal(r.status, 400, op.op)
    }
  } finally { srv.close() }
  close(s)
})

test('an attempt that asks and leaves other work ready ends normally: the answer continues it (p8 trial b)', async () => {
  const s = await setup()
  const { ref } = await s.x.request({ workspace: 'front', workflow: 'converse', text: 'two things', author: 'Pat', receipt: 'conversation:c9:m1', via: 'conversation' })
  const c1 = await claim(s)
  const front = as(s.front, ref, c1.attempt.id, 'front-agent')
  await front({ op: 'node.start', node: 'talk' })
  const two = `${CONVERSE}  ask:\n    type: talk\n    description: Ask first.\n  report:\n    type: do\n    description: Write it up.\nedges:\n  - {from: talk, to: ask}\n  - {from: talk, to: report}\n`
  const adj = await adjustRun(s.front, ref, { text: two, reason: 'two things', source: { kind: 'agent' }, completing: { node: 'talk', outcome: 'two things' } }, { by: 'front-agent', via: 'cli', attempt: c1.attempt.id })
  assert.ok(adj.ok, JSON.stringify(adj.problems))
  await front({ op: 'node.start', node: 'ask' })
  await front({ op: 'question.ask', question: 'q1', node: 'ask', text: 'Which one first?', to: 'Pat' })
  const f = await s.x.finished(c1.attempt.id, { code: 0, signal: null })
  assert.equal(f.outcome, 'exited', 'ready work beside a wait is not an interruption')
  const r = await rec(s.front, ref)
  assert.equal(r.control.hold, null)
  assert.deepEqual(r.execution.ready, ['report'])
  await runOp(s.front, ref, { op: 'question.answer', question: 'q1', text: 'the report', from: 'Pat' }, { by: 'Pat', via: 'browser' })
  assert.ok(await s.x.afterAnswer(s.front, ref, 'q1'), 'the answer continues it')
  // Work left ready with nothing waiting still is an interruption.
  const c2 = await claim(s)
  const again = as(s.front, ref, c2.attempt.id, 'front-agent')
  await again({ op: 'question.take-up', question: 'q1' })
  await again({ op: 'node.complete', node: 'ask', outcome: 'report first' })
  assert.equal((await s.x.finished(c2.attempt.id, { code: 0, signal: null })).outcome, 'interrupted')
  close(s)
})
