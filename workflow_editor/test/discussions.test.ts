// workflow_editor p16 (docs/discussions.md): a discussion of a person, a
// facilitator and project agents. Invitations are the only thing that starts
// a run: the person's message invites whom it addresses, or the facilitator;
// the facilitator's invitations are awaited and its run is told once when
// all are resolved; a contribution starts nothing. Retries and restarts find
// the same runs; an unavailable participant is visible and blocks nobody;
// closing withdraws what has not started and continues nobody; the archive is
// published by one writer from the repository's own horizon.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ConversationStore } from '../server/conversations.ts'
import { createProject } from '../server/create.ts'
import { DiscussionArchive } from '../server/discussionArchive.ts'
import { DiscussionStore } from '../server/discussions.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'
import type { RunRef } from '../shared/run.ts'

const pexec = promisify(execFile)
const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-disc-p16-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = (id: string, agent: string) => `schema: ag.workflow.v2
id: ${id}
name: ${id}
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
  for (const [id, wf] of [['argue', 'facilitate'], ['forge', 'discuss'], ['sage', 'discuss']] as const) {
    const dir = join(area, `pj-${id}`)
    const r = await createProject({ dir, id, name: id, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
    assert.ok(r.ok, r.message)
    await writeFile(join(dir, 'devdocs', 'workflows', `${wf}.yaml`), WF(wf, `${id}-agent`))
    await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  }
  // The archive project's origin: a bare repository with main.
  const bare = join(area, 'argue-origin.git')
  await gitOk(area, ['init', '-q', '--bare', '-b', 'main', bare])
  await gitOk(join(area, 'pj-argue'), ['remote', 'remove', 'origin']).catch(() => '')
  await gitOk(join(area, 'pj-argue'), ['remote', 'add', 'origin', bare])
  await gitOk(join(area, 'pj-argue'), ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
  const participants = o.participants ?? ['forge', 'sage']
  await writeFile(join(area, 'conversations.json'), JSON.stringify({
    person: 'Pat', targets: [],
    discussions: { facilitator: { workspace: 'argue', workflow: 'facilitate' }, participants: participants.map(workspace => ({ workspace, workflow: 'discuss' })), archive: { workspace: 'argue' } },
  }))
  const x = new ExecStore({ registryFile: registry, area })
  const cs = new ConversationStore({ area, exec: x })
  const ds = new DiscussionStore(cs)
  const regs = (await loadRegistry(registry)).workspaces
  const ws = (id: string) => new Workspace(regs.find(w => w.project === id)!)
  return { area, registry, bare, x, cs, ds, ws }
}
const ref = (run: string): RunRef => { const [, workflow, r] = run.split('/'); return { workflow, run: r } }
const rec = async (s: Awaited<ReturnType<typeof setup>>, run: string) => { const r = ref(run); return (await readRun(await runSpace(s.ws(run.split('/')[0]), r), r)).record! }
const op = (s: Awaited<ReturnType<typeof setup>>, run: string, o: Parameters<typeof runOp>[2]) => runOp(s.ws(run.split('/')[0]), ref(run), o, { by: 'agent', via: 'cli' })
const finish = async (s: Awaited<ReturnType<typeof setup>>, run: string) => { await op(s, run, { op: 'node.start', node: 'talk' }); await op(s, run, { op: 'node.complete', node: 'talk', outcome: 'done' }) }
const waitOn = async (s: Awaited<ReturnType<typeof setup>>, run: string) => { await op(s, run, { op: 'node.start', node: 'talk' }); await op(s, run, { op: 'node.wait', node: 'talk', reason: 'awaiting participants', holder: 'participants', external: 'discussion' }) }

test('a discussion starts with its members; an unaddressed message invites the facilitator once; an addressed one only those named', async () => {
  const s = await setup()
  const d = s.ds.create('p16-a', { title: 'How should knowledge outlive projects?', by: 'Pat', members: ['forge'] })
  assert.equal(d.duplicate, false)
  assert.deepEqual(s.ds.members('p16-a').map(m => [m.participant, m.kind]), [['Pat', 'person'], ['argue', 'facilitator'], ['forge', 'project']])
  assert.equal(s.ds.create('p16-a', { title: 'again', by: 'Pat' }).duplicate, true, 'a retried create is the same discussion')

  const a = await s.ds.post('p16-a', { text: 'Where should our cross-project decisions live?', author: 'Pat', token: 'tok-p16-a001' })
  assert.deepEqual(a.invitations.map(i => [i.participant, i.state, i.run]), [['argue', 'started', 'argue/facilitate/run-001']])
  const r1 = await rec(s, 'argue/facilitate/run-001')
  assert.equal(r1.input.author, 'Pat', 'the person\'s words, as theirs')
  assert.deepEqual(r1.input.source, { kind: 'conversation', conversation: 'p16-a', message: a.message.id, author: 'Pat', at: a.message.at, invitation: a.invitations[0].id })
  const again = await s.ds.post('p16-a', { text: 'Where should our cross-project decisions live?', author: 'Pat', token: 'tok-p16-a001' })
  assert.equal(again.duplicate, true)
  assert.deepEqual(again.invitations.map(i => i.id), a.invitations.map(i => i.id), 'the same submission is the same invitation')
  assert.equal(s.ds.invitations('p16-a').length, 1)

  const b = await s.ds.post('p16-a', { text: 'sage, is a single repository enough?', author: 'Pat', token: 'tok-p16-a002', to: ['sage'] })
  assert.deepEqual(b.invitations.map(i => [i.participant, i.state, i.run, i.by_run]), [['sage', 'started', 'sage/discuss/run-001', null]])
  assert.ok(s.ds.members('p16-a').some(m => m.participant === 'sage'), 'a participant invited for the first time joins, by the inviter')
  assert.equal(s.ds.membership('p16-a').at(-1)!.by, 'Pat')
  assert.equal((await s.ds.view('p16-a')).messages.find(m => m.id === b.message.id)!.addressed[0], 'sage')
  // A discussion is not a conversation, and the other way round.
  await assert.rejects(s.cs.post('p16-a', { text: 'x', author: 'Pat', token: 'tok-p16-a003' }), /is a discussion/)
  await assert.rejects(s.cs.view('p16-a'), /is a discussion/)
  assert.deepEqual(s.cs.list().map(c => c.id), [], 'conversation lists leave discussions out')
  s.cs.close(); s.x.close()
})

test('the facilitator invites two projects, each contribution is attributed to its run, and the facilitator is told once, after both', async () => {
  const s = await setup()
  s.ds.create('p16-b', { title: 'Archive layout', by: 'Pat' })
  const m1 = (await s.ds.post('p16-b', { text: 'Which layout should the archive have?', author: 'Pat', token: 'tok-p16-b001' })).message
  const F = 'argue/facilitate/run-001'
  const f1 = await s.ds.contribute('p16-b', { text: 'I will ask forge and sage.', author: 'argue-agent', run: F, invitation: 1, re: [m1.id] })
  assert.equal(f1.invitation!.state, 'answered')
  const i2 = (await s.ds.invite('p16-b', { participant: 'forge', question: 'What does an asset need from an archive?', re: [m1.id], by: 'argue-agent', byRun: F })).invitation
  const i3 = (await s.ds.invite('p16-b', { participant: 'sage', question: 'What does knowledge need?', re: [m1.id], by: 'argue-agent', byRun: F })).invitation
  assert.equal(i2.awaited_by, F)
  assert.equal((await s.ds.invite('p16-b', { participant: 'forge', question: 'What does an asset need from an archive?', re: [m1.id], by: 'argue-agent', byRun: F })).duplicate, true, 'a retried invite is the same invitation')
  // The executor took the facilitator's start job; its node waits.
  s.x.db.prepare('UPDATE jobs SET state = \'done\' WHERE run = \'run-001\' AND workspace = \'argue\'').run()
  await waitOn(s, F)
  // A participant cannot invite.
  await assert.rejects(s.ds.invite('p16-b', { participant: 'sage', question: 'and you?', re: [m1.id], by: 'forge-agent', byRun: i2.run }), /only the facilitator/)

  const c2 = await s.ds.contribute('p16-b', { text: 'Assets need content hashes.', author: 'forge-agent', run: i2.run!, attempt: 'att-f1', invitation: i2.id, re: [m1.id] })
  assert.deepEqual([c2.message.participant, c2.message.run, c2.message.attempt, c2.message.invitation], ['forge', 'forge/discuss/run-001', 'att-f1', i2.id])
  assert.equal((await rec(s, F)).instructions ? Object.keys((await rec(s, F)).instructions!).length : 0, 0, 'nothing is told while sage is still open')
  const dup = await s.ds.contribute('p16-b', { text: 'Assets need content hashes.', author: 'forge-agent', run: i2.run!, attempt: 'att-f2', invitation: i2.id, re: [m1.id] })
  assert.equal(dup.duplicate, true, 'a retried contribution is one message')
  // Concurrent: sage answers citing forge.
  const c3 = await s.ds.contribute('p16-b', { text: 'Knowledge needs revisions; I disagree with #3 on hashes alone.', author: 'sage-agent', run: i3.run!, invitation: i3.id, re: [m1.id, c2.message.id] })
  assert.equal(c3.invitation!.state, 'answered')
  const r = await rec(s, F)
  const ins = Object.values(r.instructions ?? {})
  assert.equal(ins.length, 1, 'one instruction after both')
  assert.match(ins[0].text, /invitation 2 to forge: answered by #\d+/)
  assert.match(ins[0].text, /invitation 3 to sage: answered by #\d+/)
  assert.equal(ins[0].source?.kind === 'conversation' && ins[0].source.conversation, 'p16-b')
  const jobs = s.x.runRows('argue', ref(F)).jobs.filter(j => j.kind === 'resume')
  assert.equal(jobs.length, 1, 'the waiting facilitator is continued')
  // Telling again (reconcile after a crash) changes nothing.
  await s.ds.reconcile()
  assert.equal(Object.keys((await rec(s, F)).instructions ?? {}).length, 1)
  // A synthesis is the facilitator's only.
  await assert.rejects(s.ds.contribute('p16-b', { text: 'my synthesis', author: 'forge-agent', run: i2.run!, invitation: i2.id, re: [m1.id], kind: 'synthesis' }), /facilitator/)
  s.cs.close(); s.x.close()
})

test('an unavailable participant fails visibly and blocks nobody; a run that ends silent is unanswered, and a late answer is told again', async () => {
  const s = await setup({ participants: ['forge', 'sage', 'ghost'] })
  s.ds.create('p16-c', { title: 'Failure', by: 'Pat' })
  const m1 = (await s.ds.post('p16-c', { text: 'Ask everyone.', author: 'Pat', token: 'tok-p16-c001' })).message
  const F = 'argue/facilitate/run-001'
  const ghost = (await s.ds.invite('p16-c', { participant: 'ghost', question: 'Anything?', re: [m1.id], by: 'argue-agent', byRun: F })).invitation
  assert.equal(ghost.state, 'failed')
  assert.match(ghost.error!, /ghost/)
  const forge = (await s.ds.invite('p16-c', { participant: 'forge', question: 'Anything?', re: [m1.id], by: 'argue-agent', byRun: F })).invitation
  assert.equal(forge.state, 'started', 'the others are not blocked')
  await waitOn(s, F)
  // forge's run ends without contributing.
  await finish(s, forge.run!)
  const notes = await s.ds.reconcile()
  assert.ok(notes.some(n => n.includes(`invitation ${forge.id}: unanswered`)), notes.join('\n'))
  assert.ok(notes.some(n => /ghost: failed/.test(n)), 'a failed dispatch is retried by reconcile')
  let ins = Object.values((await rec(s, F)).instructions ?? {})
  assert.equal(ins.length, 1)
  assert.match(ins[0].text, /ghost: failed/)
  assert.match(ins[0].text, /forge: unanswered/)
  // Reconcile stops after DISPATCH_TRIES.
  await s.ds.reconcile(); await s.ds.reconcile()
  assert.equal(s.ds.invitation(ghost.id)!.tries, 3)
  // A late contribution.
  const late = await s.ds.contribute('p16-c', { text: 'Sorry, here it is.', author: 'forge-agent', run: forge.run!, invitation: forge.id, re: [m1.id] })
  assert.equal(late.invitation!.late, 1)
  ins = Object.values((await rec(s, F)).instructions ?? {})
  assert.equal(ins.length, 2)
  assert.match(ins[1].text, /forge: answered late/)
  s.cs.close(); s.x.close()
})

test('a direct question reaches only its participant; membership changes are history; a member who left cannot be invited', async () => {
  const s = await setup()
  s.ds.create('p16-d', { title: 'Members', by: 'Pat', members: ['forge', 'sage'] })
  const m1 = (await s.ds.post('p16-d', { text: 'forge: can you render this?', author: 'Pat', token: 'tok-p16-d001', to: ['forge'] })).message
  assert.deepEqual(s.ds.invitations('p16-d').map(i => i.participant), ['forge'])
  const c = await s.ds.contribute('p16-d', { text: 'Yes.', author: 'forge-agent', run: 'forge/discuss/run-001', invitation: 1, re: [m1.id] })
  assert.equal(c.invitation!.awaited_by, null)
  assert.equal(s.ds.invitations('p16-d').length, 1, 'a contribution starts nothing')
  assert.equal(s.ds.leave('p16-d', 'sage', { by: 'Pat', note: 'not needed' }).left, true)
  await assert.rejects(s.ds.post('p16-d', { text: 'sage?', author: 'Pat', token: 'tok-p16-d002', to: ['sage'] }), /left this discussion/)
  s.ds.join('p16-d', 'sage', { by: 'Pat', note: 'back' })
  assert.deepEqual(s.ds.membership('p16-d').filter(r => r.participant === 'sage').map(r => r.action), ['join', 'leave', 'join'])
  // A late joiner reads everything said before.
  const v = await s.ds.view('p16-d')
  assert.equal(v.messages.length, 2)
  await assert.rejects(s.ds.post('p16-d', { text: 'x', author: 'Pat', token: 'tok-p16-d003', to: ['nobody'] }), /not a participant here/)
  s.cs.close(); s.x.close()
})

test('closing withdraws invitations not started, keeps started ones and continues nobody; reopening replays nothing', async () => {
  const s = await setup({ participants: ['forge', 'sage', 'ghost'] })
  s.ds.create('p16-e', { title: 'Close', by: 'Pat' })
  const m1 = (await s.ds.post('p16-e', { text: 'Go.', author: 'Pat', token: 'tok-p16-e001' })).message
  const F = 'argue/facilitate/run-001'
  const started = (await s.ds.invite('p16-e', { participant: 'sage', question: 'Q', re: [m1.id], by: 'argue-agent', byRun: F })).invitation
  const failed = (await s.ds.invite('p16-e', { participant: 'ghost', question: 'Q', re: [m1.id], by: 'argue-agent', byRun: F })).invitation
  await waitOn(s, F)
  const closed = s.ds.close('p16-e', { by: 'Pat' })
  assert.deepEqual(closed.withdrawn, [failed.id])
  await s.ds.contribute('p16-e', { text: 'Answer after close.', author: 'sage-agent', run: started.run!, invitation: started.id, re: [m1.id] })
  assert.equal(s.ds.invitation(started.id)!.state, 'answered', 'its contribution is recorded')
  assert.equal(Object.keys((await rec(s, F)).instructions ?? {}).length, 0, 'nobody is continued while closed')
  await assert.rejects(s.ds.invite('p16-e', { participant: 'forge', question: 'Q', re: [m1.id], by: 'Pat' }), /closed/)
  await s.ds.reconcile()
  assert.equal(s.ds.invitation(failed.id)!.state, 'withdrawn', 'reconcile starts nothing in a closed discussion')
  s.ds.reopen('p16-e', { by: 'Pat' })
  await s.ds.reconcile()
  assert.equal(s.ds.invitation(failed.id)!.state, 'withdrawn', 'reopening replays nothing withdrawn')
  assert.equal(s.ds.invitations('p16-e').length, 3, 'the facilitator\'s, sage\'s and ghost\'s')
  s.cs.close(); s.x.close()
})

test('the person\'s reply to a participant\'s question reaches the run that asked, as the answer to its question; after that run ended, a new run', async () => {
  const s = await setup()
  s.ds.create('p16-q', { title: 'Questions', by: 'Pat', members: ['sage'] })
  const m1 = (await s.ds.post('p16-q', { text: 'sage, what do you think?', author: 'Pat', token: 'tok-p16-q001', to: ['sage'] })).message
  const R = 'sage/discuss/run-001'
  s.x.db.prepare('UPDATE jobs SET state = \'done\' WHERE workspace = \'sage\'').run()
  await op(s, R, { op: 'node.start', node: 'talk' })
  await op(s, R, { op: 'question.ask', question: 'q1', node: 'talk', text: 'Which scope: v1 or later?', to: 'Pat' })
  const q = await s.ds.contribute('p16-q', { text: 'Which scope: v1 or later?', author: 'sage-agent', run: R, invitation: 1, re: [m1.id], kind: 'question', question: 'q1' })
  assert.equal(s.ds.invitation(1)!.state, 'started', 'a question does not answer the invitation')
  const a = await s.ds.post('p16-q', { text: 'v1 only.', author: 'Pat', token: 'tok-p16-q002', to: ['sage'], re: [q.message.id] })
  assert.deepEqual(a.invitations.map(i => [i.participant, i.run, i.state]), [['sage', R, 'started']], 'delivered to the run that asked, no new run')
  const r = await rec(s, R)
  assert.equal(r.questions.q1.answers[0].text, 'v1 only.')
  assert.equal(r.questions.q1.answers[0].from, 'Pat')
  assert.deepEqual(r.questions.q1.answers[0].source, { kind: 'conversation', conversation: 'p16-q', message: a.message.id, author: 'Pat', at: a.message.at, invitation: a.invitations[0].id })
  assert.equal(s.x.runRows('sage', ref(R)).jobs.filter(j => j.kind === 'resume').length, 1, 'the run waiting on its question is resumed')
  assert.equal((await s.ds.post('p16-q', { text: 'v1 only.', author: 'Pat', token: 'tok-p16-q002', to: ['sage'], re: [q.message.id] })).invitations[0].id, a.invitations[0].id, 'a resubmission is the same delivery')
  assert.equal((await rec(s, R)).questions.q1.answers.length, 1)
  // Its reply answers both its own invitation and the delivered one.
  await s.ds.contribute('p16-q', { text: 'Then v1: reuse the lobby.', author: 'sage-agent', run: R, invitation: 1, re: [a.message.id] })
  assert.deepEqual(s.ds.invitations('p16-q').map(i => i.state), ['answered', 'answered'])
  // Once that run has ended, a reply to its question starts a new run.
  await op(s, R, { op: 'question.take-up', question: 'q1' })
  await op(s, R, { op: 'node.start', node: 'talk' })
  await op(s, R, { op: 'node.complete', node: 'talk', outcome: 'done' })
  const late = await s.ds.post('p16-q', { text: 'Also later?', author: 'Pat', token: 'tok-p16-q003', to: ['sage'], re: [q.message.id] })
  assert.equal(late.invitations[0].run, 'sage/discuss/run-002')
  s.cs.close(); s.x.close()
})

test('a restart between an invitation\'s request and its record finds the same run', async () => {
  const s = await setup()
  s.ds.create('p16-f', { title: 'Restart', by: 'Pat' })
  const m1 = (await s.ds.post('p16-f', { text: 'First.', author: 'Pat', token: 'tok-p16-f001' })).message
  // Simulate the crash: the run was requested, the record says pending.
  s.cs.db.prepare('UPDATE invitations SET state = \'pending\', run = NULL WHERE id = 1').run()
  const cs2 = new ConversationStore({ area: s.area, exec: s.x })
  const ds2 = new DiscussionStore(cs2)
  await ds2.reconcile()
  assert.equal(ds2.invitation(1)!.run, 'argue/facilitate/run-001', 'the receipt finds the same run')
  assert.equal(s.x.runRows('argue', ref('argue/facilitate/run-001')).jobs.length, 1)
  void m1
  cs2.close(); s.cs.close(); s.x.close()
})

test('archive: published incrementally from the repository\'s own horizon; a crash after the push publishes nothing twice; two discussions both land; a fresh clone reads them', async () => {
  const s = await setup()
  const a = new DiscussionArchive(s.ds)
  s.ds.create('p16-g', { title: 'One', by: 'Pat', members: ['forge'] })
  s.ds.create('p16-h', { title: 'Two', by: 'Pat', members: ['sage'] })
  const g1 = (await s.ds.post('p16-g', { text: 'First words.', author: 'Pat', token: 'tok-p16-g001' })).message
  await s.ds.post('p16-h', { text: 'Other words.', author: 'Pat', token: 'tok-p16-h001' })
  assert.deepEqual(a.due().sort(), ['p16-g', 'p16-h'])
  const r1 = await a.publish()
  assert.deepEqual(r1.published.map(p => p.conv).sort(), ['p16-g', 'p16-h'])
  assert.deepEqual(a.due(), [])
  assert.equal((await a.status('p16-g')).state, 'current')
  // More speech; the push succeeds and the process "dies" before recording.
  await s.ds.contribute('p16-g', { text: 'A reply.', author: 'argue-agent', run: 'argue/facilitate/run-001', invitation: 1, re: [g1.id] })
  assert.equal((await a.status('p16-g')).state, 'behind')
  assert.match((await a.publish(['p16-g'], { afterPush: async () => { throw new Error('killed after push') } })).failed[0].error, /killed/)
  // The bookkeeping says failed, the repository has it: the next export adopts it.
  const r2 = await a.publish(['p16-g'])
  assert.deepEqual(r2.published, [])
  assert.deepEqual(r2.unchanged, ['p16-g'])
  assert.equal((await a.status('p16-g')).state, 'current')
  // A push that fails leaves the live discussion and reports it.
  await s.ds.post('p16-h', { text: 'More.', author: 'Pat', token: 'tok-p16-h002' })
  const failed = await a.publish(['p16-h'], { beforePush: async () => { throw new Error('remote down') } })
  assert.match(failed.failed[0].error, /remote down/)
  assert.equal((await a.status('p16-h')).state, 'failed')
  assert.ok(s.ds.messages('p16-h').length >= 2, 'no accepted message is lost')
  await a.publish(['p16-h'])
  // Another writer changed main meanwhile (an argue run's synthesis): the export rebuilds on it.
  const other = join(s.area, 'other')
  await gitOk(s.area, ['clone', '-q', s.bare, other])
  await writeFile(join(other, 'knowledge.md'), '# knowledge\n')
  await gitOk(other, ['add', '-A']); await gitOk(other, ['commit', '-q', '-m', 'synthesis']); await gitOk(other, ['push', '-q', 'origin', 'HEAD:main'])
  await s.ds.post('p16-g', { text: 'Later.', author: 'Pat', token: 'tok-p16-g002' })
  assert.equal((await a.publish(['p16-g'])).published.length, 1)
  // A fresh clone: each record exactly once, matching the declared horizon.
  const fresh = join(s.area, 'fresh')
  await gitOk(s.area, ['clone', '-q', s.bare, fresh])
  for (const id of ['p16-g', 'p16-h']) {
    const lines = (await readFile(join(fresh, 'discussions', id, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l) as { type: string; id: number })
    const msgs = lines.filter(l => l.type === 'message').map(l => l.id)
    assert.deepEqual(msgs, s.ds.messages(id).map(m => m.id), `${id}: every message once`)
    assert.equal(new Set(lines.map(l => `${l.type}:${l.id}`)).size, lines.length, `${id}: no duplicate record`)
    const man = JSON.parse(await readFile(join(fresh, 'discussions', id, 'manifest.json'), 'utf8')) as { horizon: { message: number }; format: string; members: unknown[] }
    assert.equal(man.horizon.message, Math.max(...msgs))
    assert.equal(man.format, 'ag.argue.discussion.v1')
  }
  assert.ok((await readFile(join(fresh, 'knowledge.md'), 'utf8')).includes('knowledge'), 'the other writer\'s work is kept')
  // Closing is published as the final catch-up.
  s.ds.close('p16-g', { by: 'Pat' })
  assert.deepEqual(a.due(), ['p16-g'])
  await a.publish()
  const { stdout } = await pexec('git', ['-C', fresh, 'pull', '-q'])
  void stdout
  assert.equal((JSON.parse(await readFile(join(fresh, 'discussions', 'p16-g', 'manifest.json'), 'utf8')) as { state: string }).state, 'closed')
  s.cs.close(); s.x.close()
})

test('HTTP: participants, create with a brief, an addressed post, the view with invitations and archive; the conversation route refuses a discussion; CLI show and archive', async () => {
  const s = await setup()
  const { createHandler } = await import('../server/api.ts')
  const { createServer } = await import('node:http')
  await writeFile(join(s.area, 'present.json'), JSON.stringify({ answerBase: 'http://lan.invalid:8093/wfe/' }))
  const server = createServer(createHandler({ registryFile: s.registry, allowedOrigins: [], exec: s.x, conversations: s.cs }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  const post = (path: string, body: unknown, origin?: string) => fetch(`${root}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
  try {
    const list = await (await fetch(`${root}/discussions`)).json() as { person: string; participants: { participant: string; kind: string; state: string }[] }
    assert.equal(list.person, 'Pat')
    assert.deepEqual(list.participants.map(p => [p.participant, p.kind, p.state]), [['argue', 'facilitator', 'available'], ['forge', 'project', 'available'], ['sage', 'project', 'available']])
    const created = await post('discussions', { id: 'p16-http', title: 'Over HTTP', members: ['forge'], text: 'The brief, verbatim.  ', token: 'tok-p16-http1' })
    assert.equal(created.status, 201)
    const c = await created.json() as { posted: { invitations: { participant: string; state: string }[] }; messages: { text: string; author: string }[] }
    assert.deepEqual(c.posted.invitations.map(i => [i.participant, i.state]), [['argue', 'started']])
    assert.equal(c.messages[0].text, 'The brief, verbatim.  ', 'words are kept as written')
    assert.equal(c.messages[0].author, 'Pat')
    const sent = await (await post('discussions/p16-http/messages', { text: 'sage, what do you think?', token: 'tok-p16-http2', to: ['sage'] })).json() as { invitations: { participant: string; run: string; runUrl: string }[] }
    assert.deepEqual(sent.invitations.map(i => [i.participant, i.run, i.runUrl]), [['sage', 'sage/discuss/run-001', 'http://lan.invalid:8093/wfe/#/ws/sage/run/discuss/run-001']])
    assert.equal((await post('discussions/p16-http/messages', { text: 'x', token: 'tok-p16-http3' }, 'http://evil.example')).status, 403, 'another site may not write')
    assert.equal((await post('conversations/p16-http/messages', { text: 'x', token: 'tok-p16-http4' })).status, 409)
    const v = await (await fetch(`${root}/discussions/p16-http`)).json() as { members: { participant: string }[]; invitations: unknown[]; runs: { key: string }[]; archive: { state: string } }
    assert.deepEqual(v.members.map(m => m.participant), ['Pat', 'argue', 'forge', 'sage'])
    assert.equal(v.invitations.length, 2)
    assert.deepEqual(v.runs.map(r => r.key).sort(), ['argue/facilitate/run-001', 'sage/discuss/run-001'])
    assert.equal(v.archive.state, 'never')
    const pub = await (await post('discussions/p16-http/archive', {})).json() as { status: { state: string; published: { commit: string } } }
    assert.equal(pub.status.state, 'current')
    const closed = await (await post('discussions/p16-http/close', {})).json() as { discussion: { state: string } }
    assert.equal(closed.discussion.state, 'closed')
    // The CLI reads the same store.
    const { stdout } = await pexec(process.execPath, [join(pkg, 'cli', 'wfe.ts'), 'discussion', 'show', 'p16-http', '--registry', s.registry, '--area', s.area])
    assert.match(stdout, /Discussion p16-http \(closed\): Over HTTP/)
    assert.match(stdout, /Pat \(person\) to sage/)
    assert.match(stdout, /Archive: behind|Archive: current/)
    const st = await pexec(process.execPath, [join(pkg, 'cli', 'wfe.ts'), 'discussion', 'archive', '--registry', s.registry, '--area', s.area])
    assert.match(st.stdout, /published p16-http/)
  } finally { server.closeAllConnections(); server.close(); s.cs.close(); s.x.close() }
})
