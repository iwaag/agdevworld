// workflow_editor p18 step 2: one standing conductor per conversation,
// through the executor. Several messages and replies keep one conductor run
// while attempts end and its graph grows; at rest it holds no slot, so
// another room's conductor runs meanwhile; concurrent words, the end of an
// attempt and repeated wakers append one node and queue one attempt; a
// restart finds lost wakes and deliveries by their receipts; facilitation
// and the room's open/closed state move the same run, holding what waited;
// a cancelled conductor is replaced only explicitly; a turn that stayed
// silent settles its request.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationService } from '../server/conversationService.ts'
import { ConversationStore } from '../server/conversations.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { Observer } from '../server/observe.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { listRuns, readRun, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'
import { runStatus } from '../shared/status.ts'
import { situation, type RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-standing-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const CONDUCT = `schema: ag.workflow.v2
id: conduct
name: Conduct
intent: |
  Conduct the conversation.
documentation: {policy: custom, plan: false, reports: false, final: false}
execution: {agent: ponderer-agent, lane: conversation}
repositories:
  root: {path: ., access: editable}
nodes:
  ponder:
    type: do
    activity: ponder
    description: Decide.
`
const TALK = (id: string, agent: string) => `schema: ag.workflow.v2
id: ${id}
name: ${id}
intent: |
  Serve what the person says.
documentation: {policy: custom, plan: false, reports: false, final: false}
execution: {agent: ${agent}}
repositories:
  root: {path: ., access: editable}
nodes:
  talk:
    type: talk
    description: Speak.
`
const OFFER = { profiles: { '': 'fake / m' } }

let k = 0
async function setup() {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  for (const [id, wfs] of [['ponderer', { conduct: CONDUCT, converse: TALK('converse', 'ponderer-agent') }], ['kid', { converse: TALK('converse', 'kid-agent'), discuss: TALK('discuss', 'kid-agent') }]] as const) {
    const dir = join(area, `pj-${id}`)
    const r = await createProject({ dir, id, name: id, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
    assert.ok(r.ok, r.message)
    for (const [wf, text] of Object.entries(wfs)) await writeFile(join(dir, 'devdocs', 'workflows', `${wf}.yaml`), text)
    await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflows'])
  }
  const bare = join(area, 'ponderer-origin.git')
  await gitOk(area, ['init', '-q', '--bare', '-b', 'main', bare])
  await gitOk(join(area, 'pj-ponderer'), ['remote', 'remove', 'origin']).catch(() => '')
  await gitOk(join(area, 'pj-ponderer'), ['remote', 'add', 'origin', bare])
  await gitOk(join(area, 'pj-ponderer'), ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
  await writeFile(join(area, 'workers.json'), JSON.stringify({ default: 'studio', workers: { studio: { local: true, label: 'studio', lanes: { conversation: 1 } } } }))
  await writeFile(join(area, 'conversations.json'), JSON.stringify({
    person: 'Pat',
    projects: [{ workspace: 'kid', converse: 'converse', discuss: 'discuss' }, { workspace: 'ponderer', converse: 'converse' }],
    facilitator: { workspace: 'ponderer', workflow: 'conduct' },
    archive: { workspace: 'ponderer' },
  }))
  const x = new ExecStore({ registryFile: registry, area })
  const cs = new ConversationStore({ area, exec: x })
  const ds = new ConversationService(cs)
  const regs = (await loadRegistry(registry)).workspaces
  const ws = (id: string) => new Workspace(regs.find(w => w.project === id)!)
  return { area, registry, x, cs, ds, ws }
}
type S = Awaited<ReturnType<typeof setup>>
const refOf = (run: string): RunRef => { const [, workflow, r] = run.split('/'); return { workflow: workflow!, run: r! } }
const rec = async (s: S, run: string) => { const r = refOf(run); return (await readRun(await runSpace(s.ws(run.split('/')[0]!), r), r)).record! }
const op = async (s: S, run: string, o: Parameters<typeof runOp>[2], by = 'ponderer-agent') => { const r = refOf(run); return runOp(await runSpace(s.ws(run.split('/')[0]!), r), r, o, { by, via: 'cli' }) }
const runsOf = async (s: S, ws: string) => (await listRuns(s.ws(ws))).length
const queued = (s: S, run: string) => s.x.db.prepare('SELECT * FROM jobs WHERE workspace = ? AND workflow = ? AND run = ? AND state = \'queued\'').all(...run.split('/')) as { id: number; receipt: string; reason: string }[]
// The conversation lane's next claim: the attempt and its run.
async function claim(s: S) {
  const c = await s.x.claim('fake / m', OFFER, { lane: 'conversation' })
  if (!('attempt' in c)) return null
  s.x.started(c.attempt.id, process.pid)
  return { attempt: c.attempt.id, run: `${c.attempt.workspace}/${c.ref.workflow}/${c.ref.run}` }
}
// One conductor turn in an open attempt: ponder its ready node and reply to `re`.
async function speak(s: S, conv: string, a: { attempt: string; run: string }, re: number[], text: string, o: { next?: { activity: string; node: string }[]; topic?: string } = {}) {
  const r = await rec(s, a.run)
  const node = r.execution.ready.find(n => r.nodes[n]) ?? r.execution.active[0]
  assert.ok(node, `${a.run} has a node to work on`)
  await s.ds.ponder(conv, { run: a.run, attempt: a.attempt, author: 'ponderer-agent', node: node!, decision: `Answer ${re.map(n => `#${n}`).join(' ')}.`, sources: re, next: o.next, topic: o.topic })
  // As `wfe conversation reply` does: the attempt speaks for its run's own request.
  await s.ds.contribute(conv, { text, author: 'ponderer-agent', run: a.run, attempt: a.attempt, re, invitation: (await s.ds.runSource(a.run))?.invitation ?? null })
}
const end = (s: S, a: { attempt: string }) => s.x.finished(a.attempt, { code: 0, signal: null })

test('several messages and replies keep one conductor run: attempts end, it rests holding no slot while another room runs, and its graph grows by one ponder node per wake', async () => {
  const s = await setup()
  s.ds.create('room-a', { title: 'Room A', by: 'Pat', members: ['kid'], facilitate: true })
  const m1 = (await s.ds.post('room-a', { text: 'Plan the demo.', author: 'Pat', token: 'tok-a-0001' })).message
  const C = s.cs.conversation('room-a')!.conductor!
  assert.equal((await rec(s, C)).standing!.state, 'open', 'created standing')
  const a1 = (await claim(s))!
  assert.equal(a1.run, C)
  await speak(s, 'room-a', a1, [m1.id], 'Here is a plan.', { topic: 'demo plan' })
  await end(s, a1)
  let r = await rec(s, C)
  assert.deepEqual([r.execution.state, situation(r), r.control.hold], ['idle', 'awaiting-input', null])
  assert.equal(runStatus(r).text, 'Idle · Ready for the conversation\'s next message')
  assert.equal(queued(s, C).length, 0, 'at rest: nothing queued, no polling')
  // Another room uses the free conversation slot meanwhile.
  s.ds.create('room-b', { title: 'Room B', by: 'Pat', members: ['kid'], facilitate: true })
  const b1 = (await s.ds.post('room-b', { text: 'Something else.', author: 'Pat', token: 'tok-b-0001' })).message
  const B = s.cs.conversation('room-b')!.conductor!
  assert.notEqual(B, C)
  const ab = (await claim(s))!
  assert.equal(ab.run, B, 'the slot was free')
  // Room A's next message while B holds the slot: woken (one node), queued.
  const m2 = (await s.ds.post('room-a', { text: 'And the budget?', author: 'Pat', token: 'tok-a-0002' })).message
  assert.equal(s.cs.conversation('room-a')!.conductor, C, 'the same conductor')
  r = await rec(s, C)
  assert.deepEqual(r.execution.ready, ['ponder-w1'])
  assert.deepEqual(r.standing!.wakes.map(w => [w.node, w.events]), [['ponder-w1', ['i1']]])
  assert.equal(r.instructions!.i1.text, 'And the budget?')
  assert.deepEqual((r.instructions!.i1.source as { message: number }).message, m2.id)
  assert.equal(queued(s, C).length, 1)
  assert.equal(await claim(s), null, 'one conversation slot, held by room B')
  await speak(s, 'room-b', ab, [b1.id], 'Done.')
  await end(s, ab)
  const a2 = (await claim(s))!
  assert.equal(a2.run, C)
  // A third message arrives while this attempt works: it is not this attempt's.
  const m3 = (await s.ds.post('room-a', { text: 'One more thing.', author: 'Pat', token: 'tok-a-0003' })).message
  assert.equal((await rec(s, C)).standing!.wakes.length, 1, 'no wake while an attempt is open')
  await speak(s, 'room-a', a2, [m2.id], 'The budget is fine.')
  const ended = await end(s, a2)
  assert.ok(ended.resumeJob?.receipt.startsWith('wake:'), 'the end of the attempt woke it for the word it did not read')
  r = await rec(s, C)
  assert.deepEqual(r.standing!.wakes.map(w => w.events), [['i1'], ['i2']])
  assert.equal(r.control.hold, null)
  const a3 = (await claim(s))!
  await speak(s, 'room-a', a3, [m3.id], 'Noted.')
  await end(s, a3)
  r = await rec(s, C)
  assert.equal(r.execution.state, 'idle')
  assert.deepEqual(Object.keys(r.nodes).sort(), ['ponder', 'ponder-w1', 'ponder-w2'], 'the graph grew; earlier nodes stay completed')
  assert.ok(Object.values(r.nodes).every(n => n.state === 'completed'))
  assert.equal(await runsOf(s, 'ponderer'), 2, 'one run per room')
  assert.deepEqual(s.ds.invitations('room-a').map(i => [i.role, i.state, i.run]), [['conduct', 'answered', C], ['deliver', 'answered', C], ['deliver', 'answered', C]])
  // The room reads as idle, not working.
  const st = await s.ds.status('room-a')
  assert.equal(st.working, 0, JSON.stringify(await s.ds.obligations('room-a')))
  // Integration of what a turn changed is queued at rest, as at completion.
  assert.ok(s.x.integrations('ponderer', refOf(C)).length >= 1)
  // Observation names the conversation as the next move, not the executor or a person.
  const seen = (await new Observer(s.x, s.registry).observe()).runs.find(x => x.identity.workflow === 'conduct' && x.identity.run === refOf(C).run)!
  assert.deepEqual([seen.situation, seen.waiting?.responsible], ['awaiting-input', 'conversation:room-a'])
  s.cs.close(); s.x.close()
})

test('concurrent words, wakers and the end of an attempt: one conductor run for an empty room, one wake node and one queued attempt', async () => {
  const s = await setup()
  s.ds.create('room-c', { title: 'Room C', by: 'Pat', members: ['kid'], facilitate: true })
  const posts = await Promise.all([1, 2, 3].map(n => s.ds.post('room-c', { text: `Words ${n}.`, author: 'Pat', token: `tok-c-000${n}` })))
  assert.equal(await runsOf(s, 'ponderer'), 1, 'one conductor, however many messages raced to create it')
  const C = s.cs.conversation('room-c')!.conductor!
  assert.deepEqual(posts.flatMap(p => p.invitations).map(i => i.run), [C, C, C])
  assert.ok(posts.flatMap(p => p.invitations).every(i => i.state === 'started'))
  const a1 = (await claim(s))!
  await speak(s, 'room-c', a1, posts.map(p => p.message.id), 'All three read.')
  // Every word arrived before the attempt began: it was briefed with them.
  await end(s, a1)
  let r = await rec(s, C)
  assert.deepEqual([r.execution.state, r.standing!.wakes.length], ['idle', 0], 'nothing left to wake for')
  // Two words recorded at once, then five wakers at once.
  const [w1, w2] = await Promise.all([s.ds.post('room-c', { text: 'Next A.', author: 'Pat', token: 'tok-c-0011' }), s.ds.post('room-c', { text: 'Next B.', author: 'Pat', token: 'tok-c-0012' })])
  const ref = refOf(C)
  const ws = await s.x.workspace('ponderer')
  const jobs = await Promise.all([1, 2, 3, 4, 5].map(() => s.x.afterStanding(ws, ref)))
  r = await rec(s, C)
  assert.equal(r.standing!.wakes.length, 1, 'one wake node')
  assert.equal(new Set(r.standing!.wakes.flatMap(w => w.events)).size, r.standing!.wakes[0].events.length)
  assert.equal(queued(s, C).length, 1, 'one queued attempt')
  assert.equal(new Set(jobs.filter(Boolean).map(j => j!.id)).size, 1)
  const a2 = (await claim(s))!
  await speak(s, 'room-c', a2, [w1.message.id, w2.message.id], 'Both read.')
  await end(s, a2)
  r = await rec(s, C)
  // Words 2 and 3 (delivered to the run the first created) and Next A/B: four instructions, one wake.
  assert.deepEqual([r.execution.state, r.standing!.wakes.length, Object.keys(r.instructions!).length], ['idle', 1, 4], 'both words in one wake, nothing lost')
  assert.ok(Object.values(r.instructions!).every(i => i.seen), 'every word was briefed to an attempt')
  // The same submission again is the same message: nothing new reaches the run.
  await s.ds.post('room-c', { text: 'Next A.', author: 'Pat', token: 'tok-c-0011' })
  assert.equal(Object.keys((await rec(s, C)).instructions!).length, 4)
  s.cs.close(); s.x.close()
})

test('restarts: a lost wake or job is found by reconcile, once; a delivery cut short is delivered once by its receipt', async () => {
  const s = await setup()
  s.ds.create('room-r', { title: 'Room R', by: 'Pat', members: ['kid'], facilitate: true })
  const m1 = (await s.ds.post('room-r', { text: 'Start.', author: 'Pat', token: 'tok-r-0001' })).message
  const C = s.cs.conversation('room-r')!.conductor!
  const a1 = (await claim(s))!
  await speak(s, 'room-r', a1, [m1.id], 'Started.')
  await end(s, a1)
  // An instruction recorded, then the process died before the wake.
  await op(s, C, { op: 'instruction.receive', text: 'Lost wake.', from: 'Pat', receipt: 'test:lost-wake' } as never, 'Pat')
  assert.equal(situation(await rec(s, C)), 'due')
  const x2 = new ExecStore({ registryFile: s.registry, area: s.area })
  const notes = await x2.reconcile()
  assert.ok(notes.some(n => /standing conductor continued/.test(n)), notes.join('\n'))
  await x2.reconcile()
  let r = await rec(s, C)
  assert.equal(r.standing!.wakes.length, 1)
  assert.equal(queued(s, C).length, 1)
  // The queue row lost too: reconcile queues it again under its receipt.
  s.x.db.prepare('DELETE FROM jobs WHERE state = \'queued\'').run()
  await new ExecStore({ registryFile: s.registry, area: s.area }).reconcile()
  r = await rec(s, C)
  assert.deepEqual([r.standing!.wakes.length, queued(s, C).length], [1, 1], 'the ready wake node is continued, not woken again')
  const a2 = (await claim(s))!
  await speak(s, 'room-r', a2, [m1.id], 'Read it.')
  await end(s, a2)
  // A delivery cut short after its request was recorded: reconcile delivers it once.
  const p = await s.ds.post('room-r', { text: 'Cut short.', author: 'Pat', token: 'tok-r-0002' })
  const req = p.invitations[0]
  s.cs.db.prepare('UPDATE invitations SET state = \'pending\' WHERE id = ?').run(req.id)
  const ds2 = new ConversationService(new ConversationStore({ area: s.area, exec: s.x }))
  await ds2.reconcile(); await ds2.reconcile()
  r = await rec(s, C)
  assert.equal(Object.values(r.instructions!).filter(i => i.text === 'Cut short.').length, 1, 'one instruction by its receipt')
  assert.equal(r.standing!.wakes.length, 2)
  s.cs.close(); s.x.close()
})

test('facilitation end and start, close and reopen: the same conductor run throughout; nothing unsolicited while suspended; held outcomes; no child cancelled; nothing replayed', async () => {
  const s = await setup()
  s.ds.create('room-f', { title: 'Room F', by: 'Pat', members: ['kid'], facilitate: true })
  const m1 = (await s.ds.post('room-f', { text: 'Ask kid.', author: 'Pat', token: 'tok-f-0001' })).message
  const C = s.cs.conversation('room-f')!.conductor!
  const a1 = (await claim(s))!
  // The conductor asks kid and ends its attempt; kid's run works.
  await s.ds.ponder('room-f', { run: C, attempt: a1.attempt, author: 'ponderer-agent', node: 'ponder', decision: 'Ask kid.', sources: [m1.id], next: [{ activity: 'ask', node: 'ask-kid' }] })
  const asked = await s.ds.ask('room-f', { run: C, attempt: a1.attempt, author: 'ponderer-agent', node: 'ask-kid', participants: ['kid'], question: 'Facts?', re: [m1.id] })
  const K = asked.invitations[0].run!
  await end(s, a1)
  assert.equal(situation(await rec(s, C)), 'awaiting-external')
  // Facilitation ends: suspended, the same run; words go to the default addressee or are refused.
  await s.ds.endFacilitation('room-f', { by: 'Pat' })
  assert.equal((await rec(s, C)).standing!.state, 'suspended')
  await assert.rejects(s.ds.post('room-f', { text: 'Anyone?', author: 'Pat', token: 'tok-f-0002' }), /whom is this for/)
  // Facilitation starts again: the same run takes the brief (it was waiting, so no wake node).
  await s.ds.startFacilitation('room-f', { text: 'Carry on.', author: 'Pat', token: 'tok-f-0003' })
  let r = await rec(s, C)
  assert.deepEqual([r.standing!.state, s.cs.conversation('room-f')!.conductor], ['open', C])
  assert.equal(await runsOf(s, 'ponderer'), 1)
  // Its wake for the brief (nothing was ready: the ask waits).
  assert.deepEqual(r.standing!.wakes.map(w => w.events), [['i1']])
  const a2 = (await claim(s))!
  await speak(s, 'room-f', a2, [s.ds.messages('room-f').at(-1)!.id], 'Carrying on; kid is still on it.')
  await end(s, a2)
  // The room closes while kid works: kid is not cancelled; the conductor keeps waiting.
  await s.ds.close('room-f', { by: 'Pat' })
  r = await rec(s, C)
  assert.deepEqual([r.standing!.state, r.execution.state, situation(r)], ['closed', 'in-progress', 'awaiting-external'])
  assert.equal((await rec(s, K)).cancelled, null, 'the child is not cancelled')
  // kid answers while closed: recorded, held, nothing continues the conductor.
  await s.ds.contribute('room-f', { text: 'The facts.', author: 'kid-agent', run: K, invitation: asked.invitations[0].id, re: [m1.id], kind: 'result' })
  assert.match(s.ds.invitation(asked.invitations[0].id)!.held!, /closed/)
  r = await rec(s, C)
  assert.equal(r.nodes['ask-kid'].state, 'waiting', 'the ask is not completed while closed')
  assert.equal(queued(s, C).length, 0)
  // Reopening reuses the run and replays nothing; resume continues it once.
  await s.ds.reopen('room-f', { by: 'Pat' })
  await s.ds.reconcile()
  r = await rec(s, C)
  assert.deepEqual([r.standing!.state, r.nodes['ask-kid'].state, queued(s, C).length], ['open', 'waiting', 0], 'nothing replayed on reopening')
  await s.ds.resume('room-f', { by: 'Pat' })
  r = await rec(s, C)
  assert.equal(r.nodes['ask-kid'].state, 'completed', 'resumed: the ask completes with the held outcome')
  assert.equal(queued(s, C).length, 1)
  await s.ds.resume('room-f', { by: 'Pat' })
  assert.equal(queued(s, C).length, 1, 'once')
  assert.equal(await runsOf(s, 'ponderer'), 1, 'one conductor run all along')
  s.cs.close(); s.x.close()
})

test('closed at rest: finalized; the person\'s next message reopens the room and wakes the same run', async () => {
  const s = await setup()
  s.ds.create('room-h', { title: 'Room H', by: 'Pat', members: ['kid'], facilitate: true })
  const m1 = (await s.ds.post('room-h', { text: 'Hello.', author: 'Pat', token: 'tok-h-0001' })).message
  const C = s.cs.conversation('room-h')!.conductor!
  const a1 = (await claim(s))!
  await speak(s, 'room-h', a1, [m1.id], 'Hello.')
  await end(s, a1)
  await s.ds.close('room-h', { by: 'Pat' })
  let r = await rec(s, C)
  assert.deepEqual([r.execution.state, runStatus(r).state], ['completed', 'closed'])
  // A person's message reopens it: the same run is woken for it.
  const m2 = (await s.ds.post('room-h', { text: 'Back again.', author: 'Pat', token: 'tok-h-0002' })).message
  r = await rec(s, C)
  assert.deepEqual([s.cs.conversation('room-h')!.state, r.standing!.state, r.execution.ready], ['open', 'open', ['ponder-w1']])
  assert.equal((r.instructions!.i1.source as { message: number }).message, m2.id)
  s.cs.close(); s.x.close()
})

test('a cancelled conductor is never replaced silently: the request fails with the reason; an explicit replacement names it; retrying reaches the new run', async () => {
  const s = await setup()
  s.ds.create('room-x', { title: 'Room X', by: 'Pat', members: ['kid'], facilitate: true })
  await s.ds.post('room-x', { text: 'Go.', author: 'Pat', token: 'tok-x-0001' })
  const C = s.cs.conversation('room-x')!.conductor!
  const a1 = (await claim(s))!
  await end(s, a1).catch(() => null)
  await op(s, C, { op: 'run.cancel', reason: 'Pat cancelled the conductor' } as never, 'Pat')
  const p = await s.ds.post('room-x', { text: 'Still there?', author: 'Pat', token: 'tok-x-0002' })
  assert.equal(p.invitations[0].state, 'failed')
  assert.match(p.invitations[0].error!, /cancelled.*not replaced silently/)
  assert.equal(await runsOf(s, 'ponderer'), 1, 'nothing started')
  await assert.rejects(s.ds.replaceConductor('room-x', { by: 'Pat', reason: '' }), /say why/)
  const rp = await s.ds.replaceConductor('room-x', { by: 'Pat', reason: 'the first one was cancelled by mistake' })
  const N = s.cs.conversation('room-x')!.conductor!
  assert.notEqual(N, C)
  assert.deepEqual([rp.replaces, (await rec(s, N)).standing!.replaces], [C, C])
  assert.ok((await rec(s, C)).cancelled, 'the cancelled run stays cancelled')
  const again = await s.ds.retry('room-x', p.invitations[0].id)
  assert.deepEqual([again.state, again.run], ['started', N])
  await assert.rejects(s.ds.replaceConductor('room-x', { by: 'Pat', reason: 'again' }), /not cancelled/)
  s.cs.close(); s.x.close()
})

test('a turn that stays silent settles the request it took up as unanswered; a reply answers the words it names, not later ones', async () => {
  const s = await setup()
  s.ds.create('room-s', { title: 'Room S', by: 'Pat', members: ['kid'], facilitate: true })
  const m1 = (await s.ds.post('room-s', { text: 'First.', author: 'Pat', token: 'tok-s-0001' })).message
  const C = s.cs.conversation('room-s')!.conductor!
  const a1 = (await claim(s))!
  await speak(s, 'room-s', a1, [m1.id], 'Reply to first.')
  await end(s, a1)
  const p2 = await s.ds.post('room-s', { text: 'Second.', author: 'Pat', token: 'tok-s-0002' })
  const a2 = (await claim(s))!
  // Words arrive while the conductor replies to the second.
  const p3 = await s.ds.post('room-s', { text: 'Third.', author: 'Pat', token: 'tok-s-0003' })
  await speak(s, 'room-s', a2, [p2.message.id], 'Reply to second.')
  assert.deepEqual([s.ds.invitation(p2.invitations[0].id)!.state, s.ds.invitation(p3.invitations[0].id)!.state], ['answered', 'started'], 'the reply names #2 only')
  await end(s, a2)
  // The third wakes it; this turn stays silent (ponders, says nothing).
  const a3 = (await claim(s))!
  const r = await rec(s, C)
  await s.ds.ponder('room-s', { run: C, attempt: a3.attempt, author: 'ponderer-agent', node: r.execution.ready[0], decision: 'Nothing to add: already said.', sources: [p3.message.id] })
  await end(s, a3)
  await s.ds.reconcile()
  assert.equal(s.ds.invitation(p3.invitations[0].id)!.state, 'unanswered')
  assert.equal((await s.ds.status('room-s')).working, 0)
  s.cs.close(); s.x.close()
})
