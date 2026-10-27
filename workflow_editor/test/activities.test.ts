// argue p4 (docs/discussions.md *Conductor*, *Activities*): the conductor run
// owns a discussion's progression; its nodes carry announce / ask / ponder /
// talk, each bound to its messages, invitations and decision. An ask node is
// completed by WFE when its invitations are resolved and its run continued
// once; a person's untargeted reply goes to the conductor's question instead
// of a new run (p3 ex1: facilitate/run-009 waited forever); a turn that
// spoke and left its node running is completed with what it delivered (p3:
// rts-vs-bot/discuss/run-001, run-004); retries, restarts and late replies
// duplicate nothing; a conclusion accounts for what is still owed.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../cli/wfe.ts'
import { ConversationStore } from '../server/conversations.ts'
import { createProject } from '../server/create.ts'
import { ConversationArchive } from '../server/conversationArchive.ts'
import { ConversationService } from '../server/conversationService.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runOp, usableRun } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'
import { parseWorkflow } from '../server/yamlDoc.ts'
import { validateWorkflow } from '../shared/validate.ts'
import type { RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-act-p4-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const CONDUCT = `schema: ag.workflow.v2
id: conduct
name: Conduct
intent: |
  Conduct a discussion.
documentation: {policy: custom, plan: false, reports: false, final: false}
execution: {agent: ponderer-agent}
repositories:
  root: {path: ., access: editable}
nodes:
  ponder:
    type: do
    activity: ponder
    description: Decide.
`
const DISCUSS = (agent: string) => `schema: ag.workflow.v2
id: discuss
name: discuss
intent: |
  Speak in a discussion.
documentation: {policy: custom, plan: false, reports: false, final: false}
execution: {agent: ${agent}}
repositories:
  root: {path: ., access: editable}
nodes:
  talk:
    type: talk
    description: Speak.
`

let k = 0
async function setup(o: { participants?: string[] } = {}) {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  for (const [id, wf, text] of [['ponderer', 'conduct', CONDUCT], ['argue', 'synthesize', DISCUSS('argue-agent').replace(/discuss/g, 'synthesize')], ['forge', 'discuss', DISCUSS('forge-agent')], ['sage', 'discuss', DISCUSS('sage-agent')]] as const) {
    const dir = join(area, `pj-${id}`)
    const r = await createProject({ dir, id, name: id, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
    assert.ok(r.ok, r.message)
    await writeFile(join(dir, 'devdocs', 'workflows', `${wf}.yaml`), text)
    await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  }
  const bare = join(area, 'argue-origin.git')
  await gitOk(area, ['init', '-q', '--bare', '-b', 'main', bare])
  await gitOk(join(area, 'pj-argue'), ['remote', 'remove', 'origin']).catch(() => '')
  await gitOk(join(area, 'pj-argue'), ['remote', 'add', 'origin', bare])
  await gitOk(join(area, 'pj-argue'), ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
  const participants = o.participants ?? ['forge', 'sage']
  await writeFile(join(area, 'conversations.json'), JSON.stringify({
    person: 'Pat', targets: [],
    discussions: { facilitator: { workspace: 'ponderer', workflow: 'conduct' }, participants: [...participants.map(workspace => ({ workspace, workflow: 'discuss' })), { workspace: 'argue', workflow: 'synthesize' }], archive: { workspace: 'argue' } },
  }))
  const x = new ExecStore({ registryFile: registry, area })
  const cs = new ConversationStore({ area, exec: x })
  const ds = new ConversationService(cs)
  const regs = (await loadRegistry(registry)).workspaces
  const ws = (id: string) => new Workspace(regs.find(w => w.project === id)!)
  return { area, x, cs, ds, ws }
}
type S = Awaited<ReturnType<typeof setup>>
const ref = (run: string): RunRef => { const [, workflow, r] = run.split('/'); return { workflow, run: r } }
const rec = async (s: S, run: string) => { const r = ref(run); return (await readRun(await runSpace(s.ws(run.split('/')[0]), r), r)).record! }
const op = (s: S, run: string, o: Parameters<typeof runOp>[2], by = 'exec') => runOp(s.ws(run.split('/')[0]), ref(run), o, { by, via: 'cli' })
const begin = (s: S, run: string, a: string) => op(s, run, { op: 'attempt.begin', attempt: a, reason: 'test' } as never)
const end = (s: S, run: string, a: string) => op(s, run, { op: 'attempt.end', attempt: a, outcome: 'exited', explain: 'cause', waits: 'defer-ready' } as never)
const P = 'ponderer/conduct/run-001'
const who = { author: 'ponderer-agent' }
// A talk node's question (workflow_editor fix3): the run asks it like any
// question (wfe run ask) and WFE posts it in the discussion.
async function talk(s: S, conv: string, o: { run: string; attempt: string; node: string; question: string; to: string }) {
  await op(s, o.run, { op: 'node.start', node: o.node, attempt: o.attempt } as never, 'ponderer-agent')
  const r = await op(s, o.run, { op: 'question.ask', node: o.node, text: o.question, to: o.to, attempt: o.attempt } as never, 'ponderer-agent')
  const q = Object.values(r.record.questions).at(-1)!
  await s.ds.postQuestions({ run: o.run, conv })
  const activity = s.ds.activityRows(conv).find(a => a.run === o.run && a.question === q.id)!
  return { to: q.to, activity, message: s.cs.message(activity.message!) }
}
// A conductor whose first decision adds an announcement, a parallel ask and
// a second ponder.
async function opened(s: S, conv: string) {
  s.ds.create(conv, { facilitate: true, title: 'Facts first', by: 'Pat', members: ['forge', 'sage'] })
  const brief = (await s.ds.post(conv, { text: 'Find out what the game and the model can do.', author: 'Pat', token: `tok-${conv}-001` })).message
  assert.equal(s.cs.conversation(conv)!.conductor, P, 'the invited facilitator run conducts')
  s.x.db.prepare('UPDATE jobs SET state = \'done\' WHERE workspace = \'ponderer\'').run()
  return brief
}

test('activity is node metadata: a talk activity is a talk node, the others do nodes; unknown activities are errors', () => {
  const ok = parseWorkflow(CONDUCT)
  assert.ok(ok.ok)
  assert.equal(ok.model.nodes.ponder.activity, 'ponder')
  assert.deepEqual(validateWorkflow(ok.model).filter(i => i.severity === 'error'), [])
  const bad = parseWorkflow(CONDUCT.replace('activity: ponder', 'activity: debate').replace('    type: do\n', '    type: talk\n'))
  assert.ok(bad.ok)
  assert.deepEqual(validateWorkflow(bad.model).filter(i => i.severity === 'error').map(i => i.code), ['activity-kind'])
  const wrong = parseWorkflow(CONDUCT.replace('    type: do\n', '    type: talk\n'))
  assert.ok(wrong.ok)
  assert.deepEqual(validateWorkflow(wrong.model).filter(i => i.severity === 'error').map(i => i.code), ['activity-type'])
})

test('ponder adds the next activities as a run revision; announce speaks and completes; a parallel ask waits, then WFE completes it with the outcomes and continues the run once', async () => {
  const s = await setup()
  const brief = await opened(s, 'p4-a')
  await begin(s, P, 'a1')
  const d = await s.ds.ponder('p4-a', { run: P, attempt: 'a1', ...who, node: 'ponder', decision: 'Facts first: the game and the model are unknown here; forge and sage hold them.', sources: [brief.id], next: [{ activity: 'announce', node: 'agenda' }, { activity: 'ask', node: 'facts' }, { activity: 'ponder', node: 'after-facts' }] })
  assert.equal(d.revision, 'r2')
  let r = await rec(s, P)
  assert.equal(r.nodes.ponder.state, 'completed')
  assert.match(r.nodes.ponder.outcome!.text, /Facts first/)
  assert.deepEqual(['agenda', 'facts', 'after-facts'].map(n => r.nodes[n].state), ['pending', 'pending', 'pending'])
  const g = (await usableRun(await runSpace(s.ws('ponderer'), ref(P)), ref(P))).graph
  assert.deepEqual([g.nodes.agenda.activity, g.nodes.facts.activity, g.nodes['after-facts'].activity], ['announce', 'ask', 'ponder'])
  assert.equal((await s.ds.ponder('p4-a', { run: P, attempt: 'a1', ...who, node: 'ponder', decision: 'again', sources: [] })).duplicate, true, 'a retried decision is the same')

  const a = await s.ds.announce('p4-a', { run: P, attempt: 'a1', ...who, node: 'agenda', text: 'Agenda: facts from forge and sage, then a decision.', re: [brief.id], invitation: 1 })
  assert.equal(a.message.kind, 'announce')
  assert.equal(s.ds.invitation(1)!.state, 'answered', 'the conductor\'s announcement answers its own invitation')
  assert.equal((await rec(s, P)).nodes.agenda.state, 'completed')
  const again = await s.ds.announce('p4-a', { run: P, attempt: 'a1', ...who, node: 'agenda', text: 'Agenda: facts from forge and sage, then a decision.', re: [brief.id] })
  assert.equal(again.message.id, a.message.id, 'a retried announcement posts nothing twice')
  await assert.rejects(s.ds.ask('p4-a', { run: P, attempt: 'a1', ...who, node: 'agenda', participants: ['forge'], question: 'x', re: [brief.id] }), /announce activity, not ask/)

  const q = await s.ds.ask('p4-a', { run: P, attempt: 'a1', ...who, node: 'facts', participants: ['forge', 'sage'], question: 'What can you tell us?', re: [brief.id] })
  assert.deepEqual(q.invitations.map(i => [i.participant, i.state, i.activity, i.awaited_by]), [['forge', 'started', q.activity.id, P], ['sage', 'started', q.activity.id, P]])
  r = await rec(s, P)
  assert.equal(r.nodes.facts.state, 'waiting')
  assert.deepEqual(r.nodes.facts.wait!.on, { external: `discussion:p4-a:activity:${q.activity.id}` })
  await end(s, P, 'a1')
  assert.equal((await rec(s, P)).control.hold, null, 'an attempt that ends with only the ask waiting ends normally')

  const f = await s.ds.contribute('p4-a', { text: 'The game ticks every 1.5 s.', author: 'forge-agent', run: q.invitations[0].run!, invitation: q.invitations[0].id, re: [brief.id] })
  assert.equal((await rec(s, P)).nodes.facts.state, 'waiting', 'one answer of two continues nothing')
  await s.ds.contribute('p4-a', { text: 'The model chooses among letters.', author: 'sage-agent', run: q.invitations[1].run!, invitation: q.invitations[1].id, re: [brief.id, f.message.id] })
  r = await rec(s, P)
  assert.equal(r.nodes.facts.state, 'completed', 'WFE completes the ask with the outcomes')
  assert.match(r.nodes.facts.outcome!.text, /invitation \d+ to forge: answered by #\d+/)
  assert.match(r.nodes.facts.outcome!.text, /invitation \d+ to sage: answered by #\d+/)
  const ins = Object.values(r.instructions ?? {})
  assert.equal(ins.length, 1)
  assert.match(ins[0].text, /ask node facts .* is resolved; node facts completed/)
  assert.equal(s.x.runRows('ponderer', ref(P)).jobs.filter(j => j.state === 'queued').length, 1, 'the run is continued')
  assert.equal(s.ds.activityRow(q.activity.id)!.state, 'completed')
  // Restart: reconcile again changes nothing.
  await s.ds.reconcile(); await s.ds.reconcile()
  assert.equal(Object.keys((await rec(s, P)).instructions ?? {}).length, 1)
  assert.equal((await rec(s, P)).history.filter(h => h.op === 'node.complete' && h.node === 'facts').length, 1)
  s.cs.close(); s.x.close()
})

test('an ask resolved while the conductor\'s attempt is open is completed after it ends; an unavailable participant fails at once; settle moves on and a later reply is a late outcome', async () => {
  const s = await setup({ participants: ['forge', 'sage', 'ghost'] })
  const brief = await opened(s, 'p4-b')
  await begin(s, P, 'a1')
  await s.ds.ponder('p4-b', { run: P, attempt: 'a1', ...who, node: 'ponder', decision: 'Ask the ghost and forge.', sources: [brief.id], next: [{ activity: 'ask', node: 'probe' }, { activity: 'ask', node: 'facts' }, { activity: 'ponder', node: 'next' }] })
  const g = await s.ds.ask('p4-b', { run: P, attempt: 'a1', ...who, node: 'probe', participants: ['ghost'], question: 'Are you there?', re: [brief.id] })
  assert.equal(g.invitations[0].state, 'failed')
  assert.equal((await rec(s, P)).nodes.probe.state, 'waiting', 'resolved during the attempt: nothing is completed under it')
  const q = await s.ds.ask('p4-b', { run: P, attempt: 'a1', ...who, node: 'facts', participants: ['forge', 'sage'], question: 'Facts?', re: [brief.id] })
  await end(s, P, 'a1')
  const notes = await s.ds.reconcile()
  let r = await rec(s, P)
  assert.equal(r.nodes.probe.state, 'completed', notes.join('\n'))
  assert.match(r.nodes.probe.outcome!.text, /ghost: failed/)
  // forge answers; sage does not; the conductor settles.
  await s.ds.contribute('p4-b', { text: 'Facts.', author: 'forge-agent', run: q.invitations[0].run!, invitation: q.invitations[0].id, re: [brief.id] })
  s.x.db.prepare('UPDATE jobs SET state = \'done\' WHERE workspace = \'ponderer\'').run()
  await begin(s, P, 'a2')
  const st = await s.ds.settle('p4-b', { run: P, attempt: 'a2', ...who, node: 'facts', reason: 'forge answered what matters' })
  assert.equal(st.activity.state, 'settled')
  r = await rec(s, P)
  assert.equal(r.nodes.facts.state, 'completed')
  assert.match(r.nodes.facts.outcome!.text, /settled by the conductor: forge answered what matters/)
  assert.match(r.nodes.facts.outcome!.text, /sage .*started/)
  await end(s, P, 'a2')
  const before = Object.keys(r.instructions ?? {}).length
  await s.ds.contribute('p4-b', { text: 'Late facts.', author: 'sage-agent', run: q.invitations[1].run!, invitation: q.invitations[1].id, re: [brief.id] })
  r = await rec(s, P)
  const ins = Object.values(r.instructions ?? {})
  assert.equal(ins.length, before + 1, 'the late reply is told once')
  assert.match(ins.at(-1)!.text, /a later outcome of your settled ask node facts/)
  assert.doesNotMatch(ins.at(-1)!.text, /forge/, 'what was already told is not told again')
  s.cs.close(); s.x.close()
})

test('talk: the person\'s reply, addressed to nobody, is the conductor\'s answer — no second run (p3 ex1 run-009); without re, the only open question is answered', async () => {
  const s = await setup()
  const brief = await opened(s, 'p4-c')
  await begin(s, P, 'a1')
  await s.ds.ponder('p4-c', { run: P, attempt: 'a1', ...who, node: 'ponder', decision: 'The scope is unclear: ask the requester.', sources: [brief.id], next: [{ activity: 'talk', node: 'clarify' }, { activity: 'ponder', node: 'scope' }] })
  const t = await talk(s, 'p4-c', { run: P, attempt: 'a1', node: 'clarify', question: 'Is one match enough?', to: 'Pat' })
  assert.equal(t.activity.kind, 'talk', 'a question on the talk node is the talk activity')
  assert.equal(t.message!.kind, 'question')
  let r = await rec(s, P)
  assert.equal(r.nodes.clarify.state, 'waiting')
  assert.equal(r.questions[t.activity.question!].to, 'Pat')
  await end(s, P, 'a1')
  const runs = s.ds.invitations('p4-c').length
  const reply = await s.ds.post('p4-c', { text: 'Yes, one is enough.', author: 'Pat', token: 'tok-p4-c-002', re: [t.message!.id] })
  assert.deepEqual(reply.invitations.map(i => [i.participant, i.run]), [['ponderer', P]], 'delivered to the conductor run')
  r = await rec(s, P)
  const q = r.questions[t.activity.question!]
  assert.equal(q.answers.length, 1)
  assert.equal(q.answers[0].text, 'Yes, one is enough.')
  assert.equal(q.answers[0].from, 'Pat')
  assert.equal(s.ds.invitations('p4-c').length, runs + 1)
  assert.ok(!s.ds.invitations('p4-c').some(i => i.run && i.run !== P && i.participant === 'ponderer'), 'no second conductor run')
  // The run takes the answer up; reconcile records the talk as completed.
  await op(s, P, { op: 'question.take-up', question: q.id } as never, 'ponderer-agent')
  await op(s, P, { op: 'node.complete', node: 'clarify', outcome: 'one match' } as never, 'ponderer-agent')
  await s.ds.reconcile()
  assert.equal(s.ds.activityRow(t.activity.id)!.state, 'completed')

  // Without re: the only open question of the conductor is answered.
  await begin(s, P, 'a2')
  await s.ds.ponder('p4-c', { run: P, attempt: 'a2', ...who, node: 'scope', decision: 'Ask about the seat too.', sources: [reply.message.id], next: [{ activity: 'talk', node: 'seat' }, { activity: 'ponder', node: 'then' }] })
  const t2 = await talk(s, 'p4-c', { run: P, attempt: 'a2', node: 'seat', question: 'Which seat?', to: 'Pat' })
  await end(s, P, 'a2')
  await s.ds.post('p4-c', { text: 'Seat 0.', author: 'Pat', token: 'tok-p4-c-003' })
  assert.equal((await rec(s, P)).questions[t2.activity.question!].answers[0]?.text, 'Seat 0.')
  s.cs.close(); s.x.close()
})

test('a conductor run created by a delegation: the requesting run is the requester and talk is addressed to its agent; it stands for the room (p18), and an outcome after its turn ended continues the same run', async () => {
  const s = await setup()
  const req = { kind: 'run' as const, run: 'front/converse/run-007', agent: 'front-agent' }
  // The conductor run requested as work (not invited), then opening the discussion.
  const created = await s.x.request({ workspace: 'ponderer', workflow: 'conduct', text: 'Hold a discussion about seats.', author: 'front-agent', receipt: 'test:conduct:1', via: 'cli' })
  const run = `ponderer/${created.ref.workflow}/${created.ref.run}`
  s.ds.create('p4-d', { facilitate: true, title: 'Seats', by: 'front-agent', members: ['forge'], conductor: run, requester: req })
  assert.equal(await s.ds.syncStanding('p4-d'), null, 'reconcile alone never establishes a run that does not stand')
  assert.match((await s.ds.syncStanding('p4-d', { establish: true }))!, /standing.establish/, 'what wfe conversation create does from the attempt')
  assert.equal((await rec(s, run)).standing!.state, 'open')
  assert.equal(s.ds.requester('p4-d')!.kind, 'run')
  assert.deepEqual(s.ds.members('p4-d').map(m => m.participant), ['forge', 'ponderer'], 'an agent requester does not join as a person')
  s.x.db.prepare('UPDATE jobs SET state = \'done\' WHERE workspace = \'ponderer\'').run()
  await begin(s, run, 'a1')
  await s.ds.ponder('p4-d', { run, attempt: 'a1', ...who, node: 'ponder', decision: 'Ask front which seat.', sources: [], next: [{ activity: 'announce', node: 'open' }, { activity: 'talk', node: 'ask-front' }, { activity: 'ask', node: 'facts' }] })
  const brief = (await s.ds.post('p4-d', { text: 'Context from front: seats matter.', author: 'Pat', token: 'tok-p4-d-001', to: ['forge'] })).message
  await s.ds.announce('p4-d', { run, attempt: 'a1', ...who, node: 'open', text: 'We discuss seats.', re: [brief.id] })
  const t = await talk(s, 'p4-d', { run, attempt: 'a1', node: 'ask-front', question: 'Seat 0 or 1?', to: 'front-agent' })
  assert.equal(t.to, 'front-agent')
  assert.equal((await rec(s, run)).questions[t.activity.question!].to, 'front-agent')
  await op(s, run, { op: 'question.withdraw', question: t.activity.question!, reason: 'front said seat 0 elsewhere', attempt: 'a1' } as never, 'ponderer-agent')
  await op(s, run, { op: 'node.complete', node: 'ask-front', outcome: 'withdrawn', attempt: 'a1' } as never, 'ponderer-agent')
  const q = await s.ds.ask('p4-d', { run, attempt: 'a1', ...who, node: 'facts', participants: ['forge'], question: 'Facts?', re: [brief.id] })
  await end(s, run, 'a1')
  // forge's run ends silent: the ask completes, the run (no node left)
  // rests, and the outcome wakes the same run with one new ponder node.
  const fr = q.invitations[0].run!
  await op(s, fr, { op: 'node.start', node: 'talk' } as never); await op(s, fr, { op: 'node.complete', node: 'talk', outcome: 'x' } as never)
  const notes = await s.ds.reconcile()
  const after = await rec(s, run)
  assert.equal(after.nodes.facts.state, 'completed', notes.join('\n'))
  assert.deepEqual(after.execution.ready, ['ponder-w1'], notes.join('\n'))
  assert.equal(after.standing!.wakes.length, 1)
  assert.ok(!s.ds.invitations('p4-d').some(i => i.participant === 'ponderer' && i.by === 'discussion'), 'no new conductor turn')
  assert.equal(s.cs.conversation('p4-d')!.conductor, run, 'the same run conducts')
  s.cs.close(); s.x.close()
})

test('a turn that spoke and left its node running is completed with what it delivered and its hold lifted (p3 rts-vs-bot run-001); contribute --complete does it in one command', async () => {
  const s = await setup()
  const brief = await opened(s, 'p4-e')
  const forge = (await s.ds.invite('p4-e', { participant: 'forge', question: 'Facts?', re: [brief.id], by: 'Pat' })).invitation
  const F = forge.run!
  s.x.db.prepare('UPDATE jobs SET state = \'done\' WHERE workspace = \'forge\'').run()
  await begin(s, F, 'a1')
  await op(s, F, { op: 'node.start', node: 'talk', attempt: 'a1' } as never, 'forge-agent')
  await s.ds.contribute('p4-e', { text: 'Facts.', author: 'forge-agent', run: F, attempt: 'a1', invitation: forge.id, re: [brief.id] })
  await end(s, F, 'a1')
  let r = await rec(s, F)
  assert.equal(r.control.hold?.kind, 'interrupted')
  const notes = await s.ds.reconcile()
  r = await rec(s, F)
  assert.equal(r.nodes.talk.state, 'completed', notes.join('\n'))
  assert.match(r.nodes.talk.outcome!.text, /delivered #\d+/)
  assert.equal(r.control.hold, null)
  assert.equal(r.execution.state, 'completed')
  await s.ds.reconcile()
  assert.equal((await rec(s, F)).history.filter(h => h.op === 'node.complete').length, 1, 'repaired once')

  const sage = (await s.ds.invite('p4-e', { participant: 'sage', question: 'And you?', re: [brief.id], by: 'Pat' })).invitation
  s.x.db.prepare('UPDATE jobs SET state = \'done\' WHERE workspace = \'sage\'').run()
  await begin(s, sage.run!, 'a1')
  const c = await s.ds.contribute('p4-e', { text: 'More facts.', author: 'sage-agent', run: sage.run!, attempt: 'a1', invitation: sage.id, re: [brief.id], node: 'talk', complete: true })
  assert.equal(c.completed, 'talk')
  assert.equal((await rec(s, sage.run!)).nodes.talk.state, 'completed')
  s.cs.close(); s.x.close()
})

test('a conclusion records what is still owed and who receives it; annotations stay apart from speech; the archive exports activities and annotations', async () => {
  const s = await setup()
  const brief = await opened(s, 'p4-f')
  await begin(s, P, 'a1')
  await s.ds.ponder('p4-f', { run: P, attempt: 'a1', ...who, node: 'ponder', decision: 'Ask forge, then conclude.', sources: [brief.id], next: [{ activity: 'ask', node: 'facts' }, { activity: 'announce', node: 'end' }] })
  await s.ds.ask('p4-f', { run: P, attempt: 'a1', ...who, node: 'facts', participants: ['forge'], question: 'Facts?', re: [brief.id] })
  await s.ds.settle('p4-f', { run: P, attempt: 'a1', ...who, node: 'facts', reason: 'concluding without it' })
  const ann = s.ds.annotate('p4-f', { kind: 'intervention', author: 'Omni Agent', text: 'Hint: the review is next.', re: [brief.id] })
  assert.equal(s.ds.annotate('p4-f', { kind: 'intervention', author: 'Omni Agent', text: 'Hint: the review is next.', re: [brief.id] }).duplicate, true)
  const c = await s.ds.announce('p4-f', { run: P, attempt: 'a1', ...who, node: 'end', text: 'Conclusion: forge still owes facts.', re: [brief.id], conclude: true, close: true })
  const ob = c.activity.obligations!
  assert.equal(ob.length, 1)
  assert.equal(ob[0].kind, 'invitation')
  assert.match(ob[0].owner, /forge\/discuss\/run-001/)
  assert.match(ob[0].receiver, /recorded only: the conversation is closed/)
  assert.equal(s.cs.conversation('p4-f')!.state, 'closed')
  const v = await s.ds.view('p4-f')
  assert.equal(v.messages.some(m => m.text.includes('Hint')), false, 'an annotation is not speech')
  assert.equal(v.annotations[0].id, ann.annotation.id)
  assert.deepEqual(v.activities.map(a => [a.kind, a.state]), [['ponder', 'completed'], ['ask', 'settled'], ['announce', 'completed']])
  const arch = new ConversationArchive(s.ds)
  const pub = await arch.publish(['p4-f'])
  assert.deepEqual(pub.failed, [])
  const lines = (await readFile(join(arch.dir, 'conversations', 'p4-f', 'transcript.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l) as { type: string; kind?: string })
  assert.ok(lines.some(l => l.type === 'activity' && l.kind === 'conductor'))
  assert.equal(lines.filter(l => l.type === 'activity' && l.kind === 'activity').length >= 4, true)
  assert.equal(lines.filter(l => l.type === 'annotation').length, 1)
  const m = JSON.parse(await readFile(join(arch.dir, 'conversations', 'p4-f', 'manifest.json'), 'utf8')) as { conductor: string; horizon: { activity: number; annotation: number }; activities: unknown[] }
  assert.equal(m.conductor, P)
  assert.equal(m.horizon.annotation, 1)
  assert.equal(m.activities.length, 3)
  assert.equal((await arch.status('p4-f')).state, 'current')
  assert.deepEqual((await arch.publish(['p4-f'])).published, [], 'a second export publishes nothing twice')
  s.cs.close(); s.x.close()
})

test('the archive project\'s synthesize run contributes a synthesis; a participant cannot announce', async () => {
  const s = await setup()
  const brief = await opened(s, 'p4-g')
  const inv = (await s.ds.invite('p4-g', { participant: 'argue', question: 'Synthesize.', re: [brief.id], by: 'ponderer-agent', byRun: P })).invitation
  assert.equal(inv.run, 'argue/synthesize/run-001', 'argue is invitable through its synthesize workflow')
  const syn = await s.ds.contribute('p4-g', { text: 'Summary (argue@abc).', author: 'argue-agent', run: inv.run!, invitation: inv.id, re: [brief.id], kind: 'synthesis' })
  assert.equal(syn.invitation!.state, 'answered')
  // A requested (not invited) synthesize run may speak too.
  await s.ds.contribute('p4-g', { text: 'Revised summary.', author: 'argue-agent', run: 'argue/synthesize/run-009', re: [brief.id], kind: 'synthesis' })
  await assert.rejects(s.ds.contribute('p4-g', { text: 'hello', author: 'forge-agent', run: 'forge/discuss/run-001', re: [brief.id], kind: 'announce' }), /facilitator/)
  s.cs.close(); s.x.close()
})

test('a question answered through a delegation (an agent requester) is no longer waiting for the person nor owed (argue p4 step 5: conduct/run-004 q1)', async () => {
  const s = await setup()
  const created = await s.x.request({ workspace: 'ponderer', workflow: 'conduct', text: 'Conduct.', author: 'front-agent', receipt: 'test:conduct:q', via: 'cli' })
  const run = `ponderer/${created.ref.workflow}/${created.ref.run}`
  s.ds.create('p4-h', { facilitate: true, title: 'Agent requester', by: 'front-agent', members: ['forge'], conductor: run, requester: { kind: 'run', run: 'front/converse/run-001', agent: 'front-agent' } })
  s.x.db.prepare('UPDATE jobs SET state = \'done\' WHERE workspace = \'ponderer\'').run()
  await begin(s, run, 'a1')
  await s.ds.ponder('p4-h', { run, attempt: 'a1', ...who, node: 'ponder', decision: 'Open, then ask front.', sources: [], next: [{ activity: 'announce', node: 'open' }, { activity: 'talk', node: 'ask-front' }, { activity: 'ponder', node: 'then' }] })
  await s.ds.announce('p4-h', { run, attempt: 'a1', ...who, node: 'open', text: 'Requested by front/converse/run-001: one line.', re: [] })
  const t = await talk(s, 'p4-h', { run, attempt: 'a1', node: 'ask-front', question: 'How detailed?', to: 'front-agent' })
  assert.deepEqual((await s.ds.view('p4-h')).asking, [t.message!.id])
  assert.equal((await s.ds.obligations('p4-h')).filter(o => o.kind === 'question').length, 1)
  await end(s, run, 'a1')
  await op(s, run, { op: 'question.answer', question: t.activity.question!, text: 'As is.', from: 'front-agent' } as never, 'front-agent')
  assert.deepEqual((await s.ds.view('p4-h')).asking, [], 'answered in the run: not waiting')
  assert.equal((await s.ds.obligations('p4-h')).filter(o => o.kind === 'question').length, 0, 'and not owed')
  s.cs.close(); s.x.close()
})

test('a conductor\'s question on any node is posted by WFE, awaits the person and takes the reply as its answer (workflow_editor fix3: ponderer/conduct/run-020 relayed a delegated child\'s question with wfe run ask and the discussion awaited nobody)', async () => {
  const s = await setup()
  const brief = await opened(s, 'fix3-a')
  await begin(s, P, 'a1')
  await s.ds.ponder('fix3-a', { run: P, attempt: 'a1', ...who, node: 'ponder', decision: 'Hand it on.', sources: [brief.id], next: [{ activity: 'ask', node: 'try' }, { activity: 'ponder', node: 'after' }] })
  await op(s, P, { op: 'node.start', node: 'try', attempt: 'a1' } as never, 'ponderer-agent')
  await op(s, P, { op: 'question.ask', node: 'try', text: 'The child is done: enough?', to: 'Pat', attempt: 'a1' } as never, 'ponderer-agent')
  await end(s, P, 'a1')
  assert.deepEqual((await s.ds.status('fix3-a')).awaiting, [], 'not posted yet: the asking command did not run here')
  await s.ds.reconcile()
  const st = await s.ds.status('fix3-a')
  assert.equal(st.awaiting.length, 1, 'the reconcile posted it')
  const m = s.cs.message(st.awaiting[0].message)!
  assert.deepEqual([m.kind, m.question, m.participant, m.node, st.awaiting[0].receiver.id, st.awaiting[0].you], ['question', 'q1', 'ponderer', 'try', 'Pat', true])
  assert.ok(!s.ds.activityRows('fix3-a').some(a => a.kind === 'talk'), 'a question off a talk node is not a talk activity')
  const reply = await s.ds.post('fix3-a', { text: 'Enough.', author: 'Pat', token: 'tok-fix3-a-002' })
  assert.deepEqual(reply.invitations.map(i => i.run), [P], 'to the conductor, no second run')
  assert.equal((await rec(s, P)).questions.q1.answers[0]?.text, 'Enough.')
  s.cs.close(); s.x.close()
})

test('wfe run complete on a conductor\'s ponder node warns and records nothing; --yes completes it, and the standing conductor rests (workflow_editor fix3: ponderer/conduct/run-020; p18)', async () => {
  const s = await setup()
  const brief = await opened(s, 'fix3-b')
  await begin(s, P, 'a1')
  await s.ds.ponder('fix3-b', { run: P, attempt: 'a1', ...who, node: 'ponder', decision: 'Wait for the result.', sources: [brief.id], next: [{ activity: 'ponder', node: 'after' }] })
  await end(s, P, 'a1')
  await op(s, P, { op: 'node.start', node: 'after' } as never, 'ponderer-agent')
  const cli = async (extra: string[]) => {
    const prev = { log: console.log, error: console.error }
    const err: string[] = []
    console.log = () => {}
    console.error = (...m: unknown[]) => { err.push(m.join(' ')) }
    try { return { code: await main(['run', 'complete', 'conduct/run-001', 'after', '--outcome', 'Accepted; nothing owed.', '--by', 'ponderer-agent', '--workspace', 'ponderer', ...extra, '--registry', join(s.area, 'registry.json'), '--area', s.area]), err: err.join('\n') } } finally { console.log = prev.log; console.error = prev.error }
  }
  const warned = await cli([])
  assert.equal(warned.code, 1)
  assert.match(warned.err, /Not recorded — 2 reminders before completing after: conversation-unanswered, discussion-activity/)
  assert.match(warned.err, /discussion-activity: after is the ponder activity of a discussion.*\n.*wfe discussion ponder --node after/)
  assert.doesNotMatch(warned.err, /unrecorded-activity/, 'the run\'s own records are no sign of work')
  // p18: the standing conductor's last node leaves it at rest, not ended: it
  // speaks again at the room's next words, so discussion-open does not apply.
  assert.doesNotMatch(warned.err, /discussion-open/)
  // tidy p1: but at rest it says nothing, so the person's unanswered words are named (ponderer/conduct/run-048).
  assert.match(warned.err, new RegExp(`conversation-unanswered: This puts ponderer/conduct/run-001 to rest, and the person's latest words \\(fix3-b #${brief.id}\\) have no reply`))
  assert.match(warned.err, /--yes/)
  assert.equal((await rec(s, P)).nodes.after.state, 'running', 'nothing recorded')
  // tidy p2: the HTTP completion gets the same rest checks (server/restChecks.ts).
  {
    const { createHandler } = await import('../server/api.ts')
    const { createServer } = await import('node:http')
    const server = createServer(createHandler({ registryFile: join(s.area, 'registry.json'), allowedOrigins: [], exec: s.x, conversations: s.cs }))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/workspaces/ponderer/runs/conduct/run-001/ops`
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'node.complete', node: 'after', outcome: 'done', by: 'Pat' }) })
      assert.equal(r.status, 409)
      assert.match(((await r.json()) as { error: string }).error, /conversation-unanswered/)
    } finally { server.close() }
  }
  const inv = s.ds.invitations('fix3-b').find(i => i.run === P)!
  await s.ds.contribute('fix3-b', { text: 'Accepted; nothing owed.', author: 'ponderer-agent', run: P, invitation: inv.id, re: [brief.id], kind: 'result' } as never)
  assert.doesNotMatch((await cli([])).err, /conversation-unanswered/, 'a result answers it')
  assert.equal((await cli(['--yes'])).code, 0)
  assert.equal((await rec(s, P)).execution.state, 'idle', 'accepted with --yes; the conductor rests')
  s.cs.close(); s.x.close()
})
