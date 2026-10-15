// p10 step 2 (docs/delegation.md): durable dispatch and two-way
// communication between a parent run and a child run of another project,
// through the notifier's deliveries and the child workflow's intake. The
// Zulip transport is played in-process (posts get message ids; a send can
// be begun and never acknowledged), so every crash point is exercised:
// duplicate dispatch, a post whose acknowledgment was lost, a bind that
// failed after the child was created, an answer applied twice — each
// leaves one child, one answer. Unrelated senders change nothing.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InboundMessage } from '../shared/intake.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { IntakeStore } from '../server/intake.ts'
import { NotifyStore } from '../server/notify.ts'
import { loadRegistry } from '../server/registry.ts'
import { listRuns, readRun, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'
import type { OpInput, RunRecord, RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-delegate-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const REALM = 'chat.example:8543'
const PARENT_STREAM = 601, KID_STREAM = 701, PERSON = 8, BOT = 11, STRANGER = 9

const PARENT_WF = `schema: ag.workflow.v2
id: use
name: Use an asset
intent: |
  Get an asset from the kid project and use it.
documentation: {policy: manual}
execution: {agent: par-agent}
intake: {zulip: requests}
repositories:
  root: {path: ., access: editable}
nodes:
  asset:
    type: delegate
    description: Ask the kid project for the asset.
    project: kid
    workflow: make
    accepts: parent
  use:
    type: do
    description: Use it.
edges:
  - {from: asset, to: use}
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
  await project(area, registry, 'par', { file: 'use.yaml', text: PARENT_WF })
  await project(area, registry, 'kid', { file: 'make.yaml', text: KID_WF })
  await writeFile(join(area, 'zulip.json'), JSON.stringify({
    enabled: true, zulipUrl: `https://${REALM}`, viewBase: null, since: '2026-01-01T00:00:00.000Z', person: 'Pat',
    intake: { enabled: true, since: '2026-01-01T00:00:00.000Z', projects: {}, requesters: [{ id: PERSON, name: 'Pat' }] },
  }))
  const x = new ExecStore({ registryFile: registry, area })
  const n = new NotifyStore({ area, registryFile: registry, exec: x })
  await n.due()
  for (const [key, id] of [['folder:par', 100], ['folder:kid', 101], ['channel:par/use', PARENT_STREAM], ['channel:kid/make', KID_STREAM]] as const) n.recordTarget(key, { zulipId: id })
  // The request topic of a question posted there (what the notifier's sent deliveries record).
  const i = new IntakeStore({ area, registryFile: registry, exec: x, notify: n, posted: n.postedLookup() })
  n.intake = i
  const regs = (await loadRegistry(registry)).workspaces
  const par = new Workspace(regs.find(w => w.project === 'par')!)
  const kid = new Workspace(regs.find(w => w.project === 'kid')!)
  const zulip = new Zulip(n, i)
  return { area, registry, x, n, i, par, kid, zulip }
}

// The transport, in-process: what the notifier hands out is posted (or
// begun and lost), what is posted is handed to the intake per channel.
class Zulip {
  posts: InboundMessage[] = []
  next = 50_000
  firsts = new Map<string, number>()
  n: NotifyStore
  i: IntakeStore
  constructor(n: NotifyStore, i: IntakeStore) { this.n = n; this.i = i }
  post(o: { streamId: number; topic: string; content: string; sender?: InboundMessage['sender'] }): InboundMessage {
    const id = ++this.next
    const key = `${o.streamId}\0${o.topic}`
    if (!this.firsts.has(key)) this.firsts.set(key, id)
    const m: InboundMessage = { realm: REALM, id, streamId: o.streamId, topic: o.topic, sender: o.sender ?? { id: BOT, name: 'autolab', email: 'bot@x', bot: true }, content: o.content, timestamp: 1_790_000_000, topicFirst: this.firsts.get(key)! }
    this.posts.push(m)
    return m
  }
  // Delivers everything the notifier owes. `lose`: the delivery whose first
  // event matches is posted but its acknowledgment is lost (a crash).
  async deliver(o: { lose?: (events: string[]) => boolean } = {}): Promise<number> {
    let sent = 0
    for (let round = 0; round < 30; round++) {
      const c = await this.n.claim({ owner: 'test-transport', pid: process.pid })
      if (!c.deliveries.length) break
      let progress = 0
      for (const d of c.deliveries) {
        if (d.reconcile) {
          const found = this.posts.find(p => p.content.trimEnd().split('\n').at(-1) === d.marker && d.reconcile!.searchIn.concat([d.destination]).some(s => s.streamId === p.streamId))
          if (found) { this.n.acknowledge(d.delivery, d.claim, { messageId: found.id, destination: { ...d.destination, topic: found.topic }, found: true, events: d.events }); progress++; continue }
          this.n.begin(d.delivery, d.claim, { destination: d.destination, checkedAbsent: 'absent (test transport)', events: d.events })
        } else this.n.begin(d.delivery, d.claim, { destination: d.destination, events: d.events })
        const m = this.post({ streamId: d.destination.streamId, topic: d.destination.topic, content: d.content })
        if (o.lose?.(d.events)) return sent // the process "crashed" here
        this.n.acknowledge(d.delivery, d.claim, { messageId: m.id, destination: d.destination, events: d.events })
        sent++; progress++
      }
      if (!progress) break
    }
    return sent
  }
  // The intake's side: every post of a routed channel after its cursor.
  async receive() {
    for (const stream of [PARENT_STREAM, KID_STREAM]) {
      const cursor = this.i.cursor(REALM, stream)
      const msgs = this.posts.filter(p => p.streamId === stream && p.id > cursor)
      if (msgs.length) this.i.receive({ realm: REALM, streamId: stream, through: Math.max(...msgs.map(m => m.id)), messages: JSON.parse(JSON.stringify(msgs)) })
    }
    return this.i.process()
  }
  async cycle() { await this.deliver(); const notes = await this.receive(); if (process.env.DEBUG_DELEGATE) console.error(notes); return notes }
}

type S = Awaited<ReturnType<typeof setup>>
const rec = async (ws: Workspace, ref: RunRef): Promise<RunRecord> => (await readRun(await runSpace(ws, ref), ref)).record!
const claim = async (s: S) => { const c = await s.x.claim('test'); assert.ok('attempt' in c, JSON.stringify(c)); return c as Exclude<typeof c, { idle: string }> }
const as = (ws: Workspace, ref: RunRef, attempt: string, by: string) => (op: OpInput) => runOp(ws, ref, { ...op, attempt } as never, { by, via: 'cli' })

// The parent requested by the person, its delegate node started and dispatched.
async function dispatched(s: S) {
  const { ref } = await s.x.request({ workspace: 'par', workflow: 'use', text: 'I need a blue icon for the game.', author: 'Pat', receipt: 'person-request-1', via: 'browser' })
  const a = await claim(s)
  assert.deepEqual(a.ref, ref)
  await as(s.par, ref, a.attempt.id, 'par-agent')({ op: 'node.start', node: 'asset' })
  const d1 = await s.x.delegate.dispatch(s.par, ref, 'asset', { request: 'Make a 64x64 blue icon (PNG) for a game button.', attempt: a.attempt.id, by: 'par-agent', via: 'cli' })
  return { ref, a, d1 }
}

test('dispatch: one delegation for a retransmitted request, the request and the original kept apart, the node waiting, the attempt not interrupted', async () => {
  const s = await setup()
  const { ref, a, d1 } = await dispatched(s)
  assert.equal(d1.delegation.id, 'd1')
  assert.match(d1.delegation.uid, /^par\/use\/run-001#[0-9a-f]{16}\/d1$/)
  assert.deepEqual(d1.delegation.target, { project: 'kid', workflow: 'make', workspace: s.kid.reg.id })
  const again = await s.x.delegate.dispatch(s.par, ref, 'asset', { request: 'Make a 64x64 blue icon (PNG) for a game button.', attempt: a.attempt.id, by: 'par-agent', via: 'cli' })
  assert.equal(again.duplicate, true)
  const r = await rec(s.par, ref)
  assert.deepEqual(Object.keys(r.delegations!), ['d1'], 'one delegation')
  assert.equal(r.nodes.asset.state, 'waiting')
  assert.deepEqual(r.nodes.asset.wait?.on, { delegation: 'd1' })
  const space = await runSpace(s.par, ref)
  assert.equal(await readFile(join(space.root, 'devdocs/runs/use/run-001/delegations/d1/request.md'), 'utf8'), 'Make a 64x64 blue icon (PNG) for a game button.')
  assert.equal(await readFile(join(space.root, 'devdocs/runs/use/run-001/delegations/d1/original-input.md'), 'utf8'), 'I need a blue icon for the game.', 'the person\'s own words, beside the constructed request')
  // A second dispatch from the same node while d1 is open is refused.
  await assert.rejects(s.x.delegate.dispatch(s.par, ref, 'asset', { request: 'Another one.', attempt: a.attempt.id, by: 'par-agent', via: 'cli' }), /delegation-open|already has delegation d1/)
  const f = await s.x.finished(a.attempt.id, { code: 0, signal: null })
  assert.equal(f.outcome, 'exited', 'waiting on a delegation is a normal end')
  s.i.close(); s.n.close(); s.x.close()
})

test('the request post becomes exactly one child, bound to the parent — also when its acknowledgment was lost and when the bind failed after the child was made', async () => {
  const s = await setup()
  const { ref, a } = await dispatched(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  // The post goes out, and its acknowledgment is lost.
  await s.zulip.deliver({ lose: ev => ev.some(e => e.includes(':delegation-request@')) })
  const request = s.zulip.posts.find(p => p.streamId === KID_STREAM)!
  assert.match(request.topic, /^request-par\.use\.run-001\.d1$/)
  assert.match(request.content, /Make a 64x64 blue icon/)
  // The intake sees the bot's post; its delivery is not acknowledged: it waits.
  await s.zulip.receive()
  assert.equal((await listRuns(s.kid)).length, 0, 'nothing is created while the delivery is uncertain')
  assert.equal(s.i.message(REALM, request.id)!.state, 'received')
  // Make the bind fail once after the child exists (a crash between the two).
  const bind = s.i.delegate.bind.bind(s.i.delegate)
  let failed = false
  s.i.delegate.bind = async (...args) => { if (!failed) { failed = true; throw new Error('crash after the child was created') } return bind(...args) }
  // The transport reconciles: the post is found by its marker, not posted again.
  await s.zulip.deliver()
  assert.equal(s.zulip.posts.filter(p => p.streamId === KID_STREAM).length, 1, 'found, not posted twice')
  await s.zulip.receive()
  assert.ok(failed)
  assert.equal(s.i.message(REALM, request.id)!.state, 'failed')
  assert.equal((await listRuns(s.kid)).length, 1, 'the child was created')
  s.i.retry(REALM, request.id)
  await s.zulip.receive()
  assert.equal(s.i.message(REALM, request.id)!.state, 'done')
  const kids = await listRuns(s.kid)
  assert.equal(kids.length, 1, 'exactly one child')
  const child = await rec(s.kid, { workflow: 'make', run: kids[0].run })
  assert.equal(child.input.kind, 'request')
  assert.equal(child.input.requester, 'par-agent')
  assert.equal(child.input.onBehalfOf, 'Pat')
  assert.equal(child.input.entrustedBy?.kind, 'delegation')
  const kspace = await runSpace(s.kid, { workflow: 'make', run: kids[0].run })
  assert.equal(await readFile(join(kspace.root, `devdocs/runs/make/${kids[0].run}/request.md`), 'utf8'), 'Make a 64x64 blue icon (PNG) for a game button.', 'the dispatched request, not the post\'s wording')
  assert.equal(await readFile(join(kspace.root, `devdocs/runs/make/${kids[0].run}/original-input.md`), 'utf8'), 'I need a blue icon for the game.')
  const p = await rec(s.par, ref)
  assert.equal(p.delegations!.d1.child?.run, kids[0].run)
  assert.equal(p.delegations!.d1.transport?.message, request.id)
  assert.equal(p.history.filter(h => h.op === 'delegation.bind').length, 1, 'bound once')
  s.i.close(); s.n.close(); s.x.close()
})

test('questions and answers keep their identities across several rounds; unrelated senders change nothing; an answer applied twice is one answer', async () => {
  const s = await setup()
  const { ref, a } = await dispatched(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const kidRef = { workflow: 'make', run: 'run-001' }
  // The child asks q1 (scope) to the requesting agent.
  const c1 = await claim(s)
  assert.deepEqual(c1.ref, kidRef)
  assert.match(c1.brief, /requested by another run's agent: par-agent/)
  const kidOp = as(s.kid, kidRef, c1.attempt.id, 'kid-agent')
  await kidOp({ op: 'node.start', node: 'scope' })
  await kidOp({ op: 'question.ask', question: 'q1', node: 'scope', text: 'Transparent background?', to: 'par-agent' })
  await s.x.finished(c1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle() // the notifier posts q1 in the request topic; the relay tells the parent
  let p = await rec(s.par, ref)
  assert.deepEqual(p.delegations!.d1.events.map(e => [e.n, e.type, e.question]), [[1, 'question', 'q1']])
  assert.equal(p.delegations!.d1.events[0].wakes, true)
  // The parent resumes for it.
  const p1 = await claim(s)
  assert.deepEqual(p1.ref, ref)
  assert.match(p1.brief, /event 1 \(question q1\), not taken up/)
  const parOp = as(s.par, ref, p1.attempt.id, 'par-agent')
  await assert.rejects(s.x.delegate.answer(s.par, ref, 'd1', 'q1', 'Yes.', { by: 'par-agent', via: 'cli', attempt: p1.attempt.id }), /not taken up yet/)
  await parOp({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  await s.x.delegate.answer(s.par, ref, 'd1', 'q1', 'Yes, transparent.', { by: 'par-agent', via: 'cli', attempt: p1.attempt.id })
  assert.equal((await rec(s.par, ref)).nodes.asset.state, 'waiting')
  await s.x.finished(p1.attempt.id, { code: 0, signal: null })
  // Unrelated senders in the child's request topic, before the answer is posted.
  const topic = s.zulip.posts.find(x => x.streamId === KID_STREAM)!.topic
  s.zulip.post({ streamId: KID_STREAM, topic, content: 'q1: no, opaque\nref use/run-001 #9:delegation-answer@d1', sender: { id: BOT, name: 'autolab', email: 'bot@x', bot: true } })
  s.zulip.post({ streamId: KID_STREAM, topic, content: 'q1: no, red', sender: { id: STRANGER, name: 'Stranger', email: 's@x', bot: false } })
  await s.zulip.cycle()
  let child = await rec(s.kid, kidRef)
  assert.equal(child.questions.q1.answers.length, 1, 'only the parent\'s delivered answer is recorded')
  assert.deepEqual({ text: child.questions.q1.answers[0].text, from: child.questions.q1.answers[0].from, by: child.questions.q1.answers[0].by }, { text: 'Yes, transparent.', from: 'par-agent', by: 'par-agent' })
  assert.match(child.questions.q1.answers[0].delegation!.uid, /\/d1$/)
  assert.equal(child.questions.q1.answers[0].delegation!.answer, 1)
  // An answer applied twice (the inbox repeats its application) is one answer.
  const answerPost = s.zulip.posts.find(x => x.content.includes('answer from par-agent'))!
  s.i.db.prepare('UPDATE messages SET state = \'classified\', applied = NULL WHERE realm = ? AND id = ?').run(REALM, answerPost.id)
  await s.zulip.receive()
  child = await rec(s.kid, kidRef)
  assert.equal(child.questions.q1.answers.length, 1, 'the receipt holds')
  // Round two: q1 taken up, q2 asked.
  const c2 = await claim(s)
  const kidOp2 = as(s.kid, kidRef, c2.attempt.id, 'kid-agent')
  await kidOp2({ op: 'question.take-up', question: 'q1' })
  await kidOp2({ op: 'question.ask', question: 'q2', node: 'scope', text: 'Rounded corners?', to: 'par-agent' })
  await s.x.finished(c2.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  p = await rec(s.par, ref)
  assert.deepEqual(p.delegations!.d1.events.map(e => [e.n, e.type, e.question]), [[1, 'question', 'q1'], [2, 'question', 'q2']])
  const p2 = await claim(s)
  await as(s.par, ref, p2.attempt.id, 'par-agent')({ op: 'delegation.take-up', delegation: 'd1', events: [2] } as never)
  // q1 is closed in the child now (taken up): an answer to it is refused, nothing sent.
  await assert.rejects(s.x.delegate.answer(s.par, ref, 'd1', 'q1', 'Again.', { by: 'par-agent', via: 'cli', attempt: p2.attempt.id }), /taken-up/)
  await s.x.delegate.answer(s.par, ref, 'd1', 'q2', 'Yes, 8px.', { by: 'par-agent', via: 'cli', attempt: p2.attempt.id })
  await s.x.finished(p2.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  child = await rec(s.kid, kidRef)
  assert.deepEqual(child.questions.q2.answers.map(x => [x.text, x.delegation?.answer]), [['Yes, 8px.', 2]])
  assert.deepEqual(child.questions.q1.answers.map(x => x.delegation?.answer), [1])
  p = await rec(s.par, ref)
  assert.deepEqual(p.delegations!.d1.answers.map(x => [x.n, x.question, x.event]), [[1, 'q1', 1], [2, 'q2', 2]])
  s.i.close(); s.n.close(); s.x.close()
})

test('a result confirmation is answered within scope, the child completes, the parent receives the manifest, judges it and completes its node', async () => {
  const s = await setup()
  const { ref, a } = await dispatched(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const kidRef = { workflow: 'make', run: 'run-001' }
  const c1 = await claim(s)
  const kid = as(s.kid, kidRef, c1.attempt.id, 'kid-agent')
  await kid({ op: 'node.start', node: 'scope' })
  await kid({ op: 'node.complete', node: 'scope', outcome: 'Scope is clear from the request.' })
  await kid({ op: 'node.start', node: 'build' })
  const kspace = await runSpace(s.kid, kidRef)
  await writeFile(join(kspace.root, 'icon.txt'), 'a blue icon\n')
  await kid({ op: 'node.complete', node: 'build', outcome: 'icon.txt made.', artifacts: ['icon.txt'] })
  await kid({ op: 'node.start', node: 'confirm' })
  await kid({ op: 'question.ask', question: 'q1', node: 'confirm', text: 'Here is the icon. Accept?', to: 'par-agent', subjects: ['icon.txt'] } as never)
  await s.x.finished(c1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const p1 = await claim(s)
  const par = as(s.par, ref, p1.attempt.id, 'par-agent')
  let p = await rec(s.par, ref)
  const q = p.delegations!.d1.events[0]
  assert.equal(q.confirms, true)
  assert.equal(q.subject?.[0].path, 'icon.txt')
  await par({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  const f = await s.x.delegate.childFile(p.delegations!.d1, 'icon.txt')
  assert.equal(f.bytes.toString(), 'a blue icon\n')
  assert.equal(f.expected, f.sha256, 'the bytes it presented')
  await s.x.delegate.answer(s.par, ref, 'd1', 'q1', 'Accepted.', { by: 'par-agent', via: 'cli', attempt: p1.attempt.id }) // accepts: parent
  await s.x.finished(p1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const c2 = await claim(s)
  const kid2 = as(s.kid, kidRef, c2.attempt.id, 'kid-agent')
  await kid2({ op: 'question.take-up', question: 'q1' })
  await runOp(s.kid, kidRef, { op: 'run.decide', decision: 'accepted', question: 'q1', attempt: c2.attempt.id } as never, { by: 'kid-agent', via: 'cli' })
  await kid2({ op: 'node.complete', node: 'confirm', outcome: 'Accepted by the requester.' })
  await s.x.finished(c2.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  p = await rec(s.par, ref)
  const types = p.delegations!.d1.events.map(e => e.type)
  assert.ok(types.includes('decided') && types.includes('completed'), types.join(','))
  const result = p.delegations!.d1.events.find(e => e.type === 'completed')!
  assert.equal(result.manifest?.execution, 'completed')
  assert.deepEqual(result.manifest?.artifacts.map(x => x.path), ['icon.txt'])
  assert.equal(result.manifest?.decision?.decision, 'accepted')
  const p2 = await claim(s)
  const par2 = as(s.par, ref, p2.attempt.id, 'par-agent')
  await par2({ op: 'delegation.take-up', delegation: 'd1', events: [result.n] } as never)
  await assert.rejects(par2({ op: 'node.complete', node: 'asset', outcome: 'got it' }), /not judged yet/)
  await par2({ op: 'delegation.dispose', delegation: 'd1', disposition: 'satisfied', note: 'icon.txt is the blue icon asked for.' } as never)
  await par2({ op: 'node.complete', node: 'asset', outcome: 'The icon came back.' })
  p = await rec(s.par, ref)
  assert.equal(p.delegations!.d1.disposition?.manifest, result.manifest?.digest)
  assert.deepEqual(p.execution.ready, ['use'])
  s.i.close(); s.n.close(); s.x.close()
})

// ---- step 3: waits, resumption and controls -----------------------------------------------

const PLAN_KID = KID_WF.replace('documentation: {policy: manual}', 'documentation: {policy: custom, plan: true, reports: false, final: false}')

test('a parent hold keeps the child\'s facts and queues nothing; resuming takes them up; stopping the parent never touches the child', async () => {
  const s = await setup()
  const { ref, a } = await dispatched(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  // The person stops the parent while the child works.
  await s.x.stop(s.par, ref, 'Pat', 'pause this', 'browser')
  const kidRef = { workflow: 'make', run: 'run-001' }
  const c1 = await claim(s)
  assert.deepEqual(c1.ref, kidRef, 'the child runs; the hold is the parent\'s')
  const kid = as(s.kid, kidRef, c1.attempt.id, 'kid-agent')
  await kid({ op: 'node.start', node: 'scope' })
  await kid({ op: 'question.ask', question: 'q1', node: 'scope', text: 'Size?', to: 'par-agent' })
  await s.x.finished(c1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  let p = await rec(s.par, ref)
  assert.equal(p.delegations!.d1.events.length, 1, 'the fact is recorded while held')
  assert.deepEqual(await s.x.claim('test'), { idle: 'no queued job' }, 'and nothing resumes the parent')
  await s.x.reconcile()
  assert.deepEqual(await s.x.claim('test'), { idle: 'no queued job' }, 'not even the reconcile')
  const child = await rec(s.kid, kidRef)
  assert.equal(child.cancelled, null, 'the child is not cancelled by the parent\'s stop')
  // Resuming: the next attempt is told the fact.
  await s.x.resume(s.par, ref, 'Pat', 'go on', 'browser')
  const p1 = await claim(s)
  assert.deepEqual(p1.ref, ref)
  assert.match(p1.brief, /event 1 \(question q1\), not taken up/)
  await as(s.par, ref, p1.attempt.id, 'par-agent')({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  await s.x.delegate.answer(s.par, ref, 'd1', 'q1', '64px.', { by: 'par-agent', via: 'cli', attempt: p1.attempt.id })
  await s.x.finished(p1.attempt.id, { code: 0, signal: null })
  p = await rec(s.par, ref)
  assert.equal(p.control.last?.outcome, 'exited')
  s.i.close(); s.n.close(); s.x.close()
})

test('cancelling the parent leaves the child running and its late result readable; cancelling the child is explicit', async () => {
  const s = await setup()
  const { ref, a } = await dispatched(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  await s.x.cancel(s.par, ref, 'Pat', 'not needed any more', 'browser')
  const kidRef = { workflow: 'make', run: 'run-001' }
  const c1 = await claim(s)
  assert.deepEqual(c1.ref, kidRef, 'the child still runs')
  const kid = as(s.kid, kidRef, c1.attempt.id, 'kid-agent')
  await kid({ op: 'node.start', node: 'scope' })
  await kid({ op: 'question.ask', question: 'q1', node: 'scope', text: 'Size?', to: 'par-agent' })
  await s.x.finished(c1.attempt.id, { code: 0, signal: null })
  const notes = await s.zulip.cycle()
  assert.ok(notes.some(n => /closed with its parent/.test(n)), notes.join('\n'))
  const p = await rec(s.par, ref)
  assert.equal(p.delegations!.d1.events.length, 0, 'nothing more is recorded on a cancelled parent')
  assert.match(p.delegations!.d1.closed!.reason, /not needed any more/)
  assert.equal((await rec(s.kid, kidRef)).questions.q1.text, 'Size?', 'the child stays readable')
  s.i.close(); s.n.close(); s.x.close()
})

test('the child\'s plan agreement binds its plan.md; acceptance binds the presented bytes; the requester cancels the child explicitly', async () => {
  const s = await setup()
  await writeFile(join(s.area, 'pj-kid', 'devdocs', 'workflows', 'make.yaml'), PLAN_KID)
  await gitOk(join(s.area, 'pj-kid'), ['commit', '-qam', 'plan step']); await gitOk(join(s.area, 'pj-kid'), ['push', '-q'])
  const { ref, a } = await dispatched(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const kidRef = { workflow: 'make', run: 'run-001' }
  const kspace = await runSpace(s.kid, kidRef)
  const c1 = await claim(s)
  const kid = as(s.kid, kidRef, c1.attempt.id, 'kid-agent')
  await kid({ op: 'node.start', node: '_plan' })
  await writeFile(join(kspace.root, 'devdocs/runs/make/run-001/plan.md'), '# Plan\n\nA 64px blue icon.\n')
  await kid({ op: 'question.ask', question: 'q1', node: '_plan', text: 'Agree to plan.md?', to: 'par-agent' })
  await s.x.finished(c1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  let p = await rec(s.par, ref)
  const q1 = p.delegations!.d1.events[0]
  assert.equal(q1.plan, true)
  assert.equal(q1.document?.path, 'devdocs/runs/make/run-001/plan.md')
  const p1 = await claim(s)
  await as(s.par, ref, p1.attempt.id, 'par-agent')({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  const planFile = await s.x.delegate.childFile(p.delegations!.d1, q1.document!.path)
  assert.equal(planFile.sha256, q1.document!.sha256, 'the plan it asked about')
  await s.x.delegate.answer(s.par, ref, 'd1', 'q1', 'Agreed.', { by: 'par-agent', via: 'cli', attempt: p1.attempt.id })
  await s.x.finished(p1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  // The child takes the agreement up and completes its plan on it.
  const c2 = await claim(s)
  const kid2 = as(s.kid, kidRef, c2.attempt.id, 'kid-agent')
  await kid2({ op: 'question.take-up', question: 'q1' })
  await kid2({ op: 'node.complete', node: '_plan', outcome: 'Plan agreed by par-agent.' })
  assert.equal((await rec(s.kid, kidRef)).nodes._plan.agreement?.question, 'q1', 'plan agreement, from the delegated answer')
  await kid2({ op: 'node.start', node: 'scope' }); await kid2({ op: 'node.complete', node: 'scope', outcome: 'ok' })
  await kid2({ op: 'node.start', node: 'build' })
  await writeFile(join(kspace.root, 'icon.txt'), 'blue v1\n')
  await kid2({ op: 'node.complete', node: 'build', outcome: 'icon.txt', artifacts: ['icon.txt'] })
  await kid2({ op: 'node.start', node: 'confirm' })
  await kid2({ op: 'question.ask', question: 'q2', node: 'confirm', text: 'Accept icon.txt?', to: 'par-agent', subjects: ['icon.txt'] } as never)
  await s.x.finished(c2.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const p2 = await claim(s)
  await as(s.par, ref, p2.attempt.id, 'par-agent')({ op: 'delegation.take-up', delegation: 'd1', events: [2] } as never)
  await s.x.delegate.answer(s.par, ref, 'd1', 'q2', 'Accepted.', { by: 'par-agent', via: 'cli', attempt: p2.attempt.id })
  await s.x.finished(p2.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  // The deliverable changed after it was presented: the acceptance is refused.
  const c3 = await claim(s)
  await writeFile(join(kspace.root, 'icon.txt'), 'blue v2 (changed after review)\n')
  await as(s.kid, kidRef, c3.attempt.id, 'kid-agent')({ op: 'question.take-up', question: 'q2' })
  await assert.rejects(runOp(s.kid, kidRef, { op: 'run.decide', decision: 'accepted', question: 'q2', attempt: c3.attempt.id } as never, { by: 'kid-agent', via: 'cli' }), /subject-changed|changed since q2/)
  await s.x.finished(c3.attempt.id, { code: 0, signal: null }) // confirm still running: interrupted
  // The requester cancels the child, explicitly.
  p = await rec(s.par, ref)
  const res = await s.x.cancel(s.kid, kidRef, 'par-agent', `cancelled by its requester par-agent (delegation ${p.delegations!.d1.uid}): the icon changed after review`, 'delegation')
  assert.match(res.record.cancelled!.reason, /requester par-agent/)
  await s.zulip.cycle()
  p = await rec(s.par, ref)
  assert.ok(p.delegations!.d1.events.some(e => e.type === 'cancelled' && e.wakes), 'the cancellation wakes the parent')
  assert.ok(!p.delegations!.d1.events.some(e => e.type === 'decided'), 'no acceptance was recorded')
  s.i.close(); s.n.close(); s.x.close()
})

// ---- step 6: the remaining rows of the matrix ------------------------------------------------

test('a parent continuation lost after the relayed fact was recorded is queued again by reconcile — once', async () => {
  const s = await setup()
  const { ref, a } = await dispatched(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const c1 = await claim(s)
  const kid = as(s.kid, { workflow: 'make', run: 'run-001' }, c1.attempt.id, 'kid-agent')
  await kid({ op: 'node.start', node: 'scope' })
  await kid({ op: 'question.ask', question: 'q1', node: 'scope', text: 'Size?', to: 'par-agent' })
  await s.x.finished(c1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  // The process died after recording the fact, before (or while) queueing: the job is gone.
  s.x.db.prepare('DELETE FROM jobs WHERE workflow = ? AND run = ? AND state = \'queued\'').run('use', 'run-001')
  assert.deepEqual(await s.x.claim('test'), { idle: 'no queued job' })
  const notes = await s.x.reconcile()
  assert.ok(notes.some(n => /resume for a relayed delegation fact queued again/.test(n)), notes.join('\n'))
  await s.x.reconcile()
  const jobs = s.x.db.prepare('SELECT * FROM jobs WHERE workflow = ? AND run = ? AND state = \'queued\'').all('use', 'run-001')
  assert.equal(jobs.length, 1, 'one continuation, however often reconcile runs')
  const p = await claim(s)
  assert.deepEqual(p.ref, ref)
  assert.match(p.brief, /event 1 \(question q1\), not taken up/)
  s.i.close(); s.n.close(); s.x.close()
})

test('a child failure wakes the parent, which abandons it and dispatches an explicit replacement — never an automatic one', async () => {
  const s = await setup()
  const { ref, a } = await dispatched(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const c1 = await claim(s)
  const kid = as(s.kid, { workflow: 'make', run: 'run-001' }, c1.attempt.id, 'kid-agent')
  await kid({ op: 'node.start', node: 'scope' })
  await kid({ op: 'node.fail', node: 'scope', reason: 'the request cannot be met with the tools here' })
  await s.x.finished(c1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  let p = await rec(s.par, ref)
  const failed = p.delegations!.d1.events.find(e => e.type === 'failed')!
  assert.ok(failed?.wakes, 'the failure wakes the parent')
  assert.equal((await listRuns(s.kid)).length, 1, 'nothing replaced it by itself')
  const p1 = await claim(s)
  const par = as(s.par, ref, p1.attempt.id, 'par-agent')
  await par({ op: 'delegation.take-up', delegation: 'd1', events: [failed.n] } as never)
  await assert.rejects(s.x.delegate.dispatch(s.par, ref, 'asset', { request: 'Try again, simpler.', attempt: p1.attempt.id, by: 'par-agent', via: 'cli' }), /delegation-open|already has delegation d1/)
  await par({ op: 'delegation.dispose', delegation: 'd1', disposition: 'abandoned', note: 'the child failed: not possible with its tools' } as never)
  await assert.rejects(s.x.delegate.dispatch(s.par, ref, 'asset', { request: 'Try again, simpler.', attempt: p1.attempt.id, by: 'par-agent', via: 'cli' }), /predecessor/)
  const d2 = await s.x.delegate.dispatch(s.par, ref, 'asset', { request: 'Try again, simpler.', predecessor: 'd1', attempt: p1.attempt.id, by: 'par-agent', via: 'cli' })
  assert.equal(d2.delegation.id, 'd2')
  assert.equal(d2.delegation.predecessor, 'd1')
  await s.x.finished(p1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  p = await rec(s.par, ref)
  assert.equal(p.delegations!.d2.child?.run, 'run-002', 'the replacement is new work with its own child')
  assert.equal((await rec(s.kid, { workflow: 'make', run: 'run-001' })).execution.state, 'stopped', 'the failed child stays as it was, readable')
  s.i.close(); s.n.close(); s.x.close()
})
