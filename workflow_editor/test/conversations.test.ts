// One conversation (challenge p2, docs/conversations.md): a person talking
// with one project, several, or a room a conductor leads, through one service.
// A one-to-one room's messages each start one bounded run of the project's
// converse workflow by receipt; the room can gain members and a conductor
// without changing its id, history or work; a reply to an open question goes
// to the run that asked; an explicit instruction reaches the run it names or
// fails, never elsewhere; continuations that may not run now are held and run
// once on resume; v11 direct conversations migrate without replaying
// anything; every room is archived, at a path that never moves.
// (Earlier: project_migration p8 step 3, workflow_editor p15.)
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ConversationArchive } from '../server/conversationArchive.ts'
import { ConversationService } from '../server/conversationService.ts'
import { ConversationStore, pendingQuestions } from '../server/conversations.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { listRuns, readRun, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import type { RunRef } from '../shared/run.ts'

const pexec = promisify(execFile)
const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-conv-p2-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = (id: string, agent: string) => `schema: ag.workflow.v2
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
    description: Understand the message.
`

let k = 0
async function setup() {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  const workflows: Record<string, string[]> = { front: ['converse', 'discuss'], kid: ['converse', 'discuss'], ponderer: ['conduct', 'converse'] }
  for (const [id, wfs] of Object.entries(workflows)) {
    const dir = join(area, `pj-${id}`)
    const r = await createProject({ dir, id, name: id, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
    assert.ok(r.ok, r.message)
    for (const wf of wfs) await writeFile(join(dir, 'devdocs', 'workflows', `${wf}.yaml`), WF(wf, `${id}-agent`))
    await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflows'])
  }
  const bare = join(area, 'ponderer-origin.git')
  await gitOk(area, ['init', '-q', '--bare', '-b', 'main', bare])
  await gitOk(join(area, 'pj-ponderer'), ['remote', 'remove', 'origin']).catch(() => '')
  await gitOk(join(area, 'pj-ponderer'), ['remote', 'add', 'origin', bare])
  await gitOk(join(area, 'pj-ponderer'), ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
  await writeFile(join(area, 'conversations.json'), JSON.stringify({
    person: 'Pat',
    projects: [{ workspace: 'front', converse: 'converse', discuss: 'discuss' }, { workspace: 'kid', converse: 'converse', discuss: 'discuss' }, { workspace: 'ponderer', converse: 'converse' }],
    facilitator: { workspace: 'ponderer', workflow: 'conduct' },
    archive: { workspace: 'ponderer' },
  }))
  const x = new ExecStore({ registryFile: registry, area })
  const cs = new ConversationStore({ area, exec: x })
  const ds = new ConversationService(cs)
  const regs = (await loadRegistry(registry)).workspaces
  const ws = (id: string) => new Workspace(regs.find(w => w.project === id)!)
  return { area, registry, bare, x, cs, ds, ws }
}
type S = Awaited<ReturnType<typeof setup>>
const refOf = (run: string): RunRef => { const [, workflow, r] = run.split('/'); return { workflow: workflow!, run: r! } }
const rec = async (s: S, run: string) => { const r = refOf(run); return (await readRun(await runSpace(s.ws(run.split('/')[0]!), r), r)).record! }
const op = async (s: S, run: string, o: Parameters<typeof runOp>[2]) => { const r = refOf(run); return runOp(await runSpace(s.ws(run.split('/')[0]!), r), r, o, { by: 'agent', via: 'cli' }) }
const finish = async (s: S, run: string) => { await op(s, run, { op: 'node.start', node: 'talk' }); await op(s, run, { op: 'node.complete', node: 'talk', outcome: 'done' }) }
const ask = async (s: S, run: string, q: string, text: string) => { await op(s, run, { op: 'node.start', node: 'talk' }); await op(s, run, { op: 'question.ask', question: q, node: 'talk', text, to: 'Pat' } as Parameters<typeof runOp>[2]) }
const jobs = (s: S) => (s.x.db.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number }).n
const runsOf = async (s: S, ws: string) => (await listRuns(s.ws(ws))).length

test('one-to-one: the first message creates the room with its project, each message starts one converse run by receipt, nobody leads', async () => {
  const s = await setup()
  const a = await s.ds.post('c1', { text: 'Make me a blue icon.', author: 'Pat', token: 'tok-c1-0001', with: 'front' })
  assert.equal(a.created, true)
  const r1 = a.invitations[0]!
  assert.deepEqual([r1.participant, r1.role, `${r1.workspace}/${r1.workflow}`, r1.state, r1.run, r1.receipt], ['front', 'converse', 'front/converse', 'started', 'front/converse/run-001', `conversation:c1:request:${r1.id}`])
  const again = await s.ds.post('c1', { text: 'Make me a blue icon.', author: 'Pat', token: 'tok-c1-0001' })
  assert.equal(again.duplicate, true)
  assert.deepEqual(again.invitations.map(i => i.id), [r1.id], 'the same submission is the same request')
  assert.equal(await runsOf(s, 'front'), 1, 'one run for one message')
  const r = await rec(s, 'front/converse/run-001')
  assert.equal(r.input.author, 'Pat')
  assert.deepEqual(r.input.source, { kind: 'conversation', conversation: 'c1', message: a.message.id, author: 'Pat', at: a.message.at, invitation: r1.id })
  const c = s.cs.conversation('c1')!
  assert.deepEqual([c.default_to, s.ds.mode('c1'), s.ds.facilitation('c1'), c.conductor], ['front', 'direct', null, null], 'no conductor is created')
  assert.deepEqual(s.ds.members('c1').map(m => [m.participant, m.kind]), [['Pat', 'person'], ['front', 'project']])
  // The reply answers the request; it names its run and what it answers.
  const reply = await s.ds.contribute('c1', { text: 'Here it is.', author: 'front-agent', run: r1.run!, invitation: r1.id, re: [a.message.id], kind: 'result' })
  assert.equal(reply.invitation!.state, 'answered')
  const b = await s.ds.post('c1', { text: 'And a red one.', author: 'Pat', token: 'tok-c1-0002' })
  assert.deepEqual(b.invitations.map(i => [i.role, i.run]), [['converse', 'front/converse/run-002']], 'a later message goes to the default addressee with its own run')
  const v = await s.ds.view('c1')
  assert.deepEqual(v.messages.filter(m => m.role === 'person').map(m => m.requests), [[r1.id], [b.invitations[0]!.id]])
  assert.deepEqual(v.links.filter(l => l.relation === 'turn').map(l => [l.message, l.run]), [[a.message.id, 'front/converse/run-001'], [b.message.id, 'front/converse/run-002']])
  // A new id names whom it is with; only a configured project.
  await assert.rejects(s.ds.post('c-none', { text: 'who?', author: 'Pat', token: 'tok-cn-0001' }), (e: unknown) => e instanceof RequestError && (e.detail as { code?: string })?.code === 'no-destination')
  await assert.rejects(s.ds.post('c-none', { text: 'who?', author: 'Pat', token: 'tok-cn-0002', with: 'nobody' }), /not a project that can take part/)
  assert.equal(s.cs.conversation('c-none'), undefined, 'a refused first message creates nothing')
  await assert.rejects(s.ds.post('c1', { text: 'to kid?', author: 'Pat', token: 'tok-c1-0003', with: 'kid' }), (e: unknown) => e instanceof RequestError && e.status === 409)
  s.cs.close(); s.x.close()
})

test('direct consultation with ponderer is its converse workflow, not facilitation', async () => {
  const s = await setup()
  const a = await s.ds.post('c-pond', { text: 'What do you think of our discussion practice?', author: 'Pat', token: 'tok-cp-0001', with: 'ponderer' })
  assert.deepEqual(a.invitations.map(i => [i.participant, i.role, i.run]), [['ponderer', 'converse', 'ponderer/converse/run-001']])
  assert.equal(s.ds.facilitation('c-pond'), null)
  assert.equal(s.cs.conversation('c-pond')!.conductor, null, 'being present does not make ponderer the conductor')
  const b = await s.ds.post('c-pond', { text: 'And another thought.', author: 'Pat', token: 'tok-cp-0002' })
  assert.deepEqual(b.invitations.map(i => [i.role, i.run]), [['converse', 'ponderer/converse/run-002']])
  s.cs.close(); s.x.close()
})

test('a one-to-one room gains a member and a conductor: same id, history and work; its pending question is answered in the run that asked; routing follows', async () => {
  const s = await setup()
  const a = await s.ds.post('c-promo', { text: 'Plan the release.', author: 'Pat', token: 'tok-pr-0001', with: 'front' })
  const F = a.invitations[0]!.run!
  await ask(s, F, 'q1', 'Which day?')
  assert.deepEqual(await s.ds.postQuestions({ run: F }), [`discussion c-promo: ${F} q1 to Pat posted as #${a.message.id + 1}`])
  const qm = s.ds.messages('c-promo').find(m => m.kind === 'question')!
  assert.deepEqual(await s.ds.openAsking('c-promo'), [qm.id])
  // A member joins: nothing starts.
  const n = jobs(s)
  s.ds.join('c-promo', 'kid', { by: 'Pat', note: 'kid ships the release' })
  assert.equal(jobs(s), n, 'joining starts no work')
  assert.equal(s.ds.mode('c-promo'), 'group')
  // Facilitation starts explicitly, with a brief and the horizon it starts from.
  const before = s.ds.messages('c-promo').map(m => [m.id, m.text])
  const f = await s.ds.startFacilitation('c-promo', { text: 'ponderer, please lead the release plan with front and kid.', author: 'Pat', token: 'tok-pr-0002' })
  assert.equal(f.facilitation.horizon, qm.id)
  assert.equal(f.facilitation.brief, f.posted.message.id)
  const C = f.posted.invitations[0]!.run!
  assert.deepEqual([f.posted.invitations[0]!.role, C, s.cs.conversation('c-promo')!.conductor], ['conduct', 'ponderer/conduct/run-001', 'ponderer/conduct/run-001'])
  assert.equal((await s.ds.startFacilitation('c-promo', { text: 'ponderer, please lead the release plan with front and kid.', author: 'Pat', token: 'tok-pr-0002' })).duplicate, true)
  assert.deepEqual(s.ds.messages('c-promo').slice(0, before.length).map(m => [m.id, m.text]), before, 'the history is kept as it was')
  assert.equal(s.ds.mode('c-promo'), 'facilitated')
  // The question asked before is answered after the room gained participants: the run that asked gets it.
  const ans = await s.ds.post('c-promo', { text: 'Friday.', author: 'Pat', token: 'tok-pr-0003', re: [qm.id] })
  assert.deepEqual(ans.invitations.map(i => [i.participant, i.role, i.run, i.state]), [['front', 'deliver', F, 'started']])
  assert.equal((await rec(s, F)).questions.q1!.answers[0]!.text, 'Friday.')
  assert.equal(await runsOf(s, 'front'), 1, 'no independent turn for the answer')
  // A message naming nobody goes to the open conductor run.
  const nb = await s.ds.post('c-promo', { text: 'What comes next?', author: 'Pat', token: 'tok-pr-0004' })
  assert.deepEqual(nb.invitations.map(i => [i.role, i.run]), [['deliver', C]])
  assert.equal(Object.keys((await rec(s, C)).instructions ?? {}).length, 1)
  assert.equal(await runsOf(s, 'ponderer'), 1)
  // A project addressed in the group speaks through its discuss workflow, recorded with the request.
  const tf = await s.ds.post('c-promo', { text: 'front, the checklist?', author: 'Pat', token: 'tok-pr-0005', to: ['front'] })
  assert.deepEqual(tf.invitations.map(i => [i.role, i.run]), [['discuss', 'front/discuss/run-001']])
  // Ending facilitation changes routing only.
  assert.equal(s.ds.endFacilitation('c-promo', { by: 'Pat', note: 'enough' }).ended, true)
  assert.equal((await rec(s, C)).execution.state !== 'cancelled', true, 'nothing is stopped')
  const after = await s.ds.post('c-promo', { text: 'Thanks.', author: 'Pat', token: 'tok-pr-0006' })
  assert.deepEqual(after.invitations.map(i => [i.participant, i.role]), [['front', 'discuss']], 'the default addressee again')
  assert.equal(s.ds.conversation('c-promo')!.id, 'c-promo')
  s.cs.close(); s.x.close()
})

test('an explicit instruction reaches the run it names with the words and their source; an ended run fails visibly and nothing is redirected', async () => {
  const s = await setup()
  const a = await s.ds.post('c-ins', { text: 'Make an icon.', author: 'Pat', token: 'tok-ci-0001', with: 'front' })
  const F = a.invitations[0]!.run!
  const i = await s.ds.post('c-ins', { text: 'Use blue, please.', author: 'Pat', token: 'tok-ci-0002', runs: [F] })
  assert.deepEqual(i.invitations.map(x => [x.role, x.run, x.state]), [['deliver', F, 'started']])
  const ins = Object.values((await rec(s, F)).instructions!)[0]!
  assert.equal(ins.text, 'Use blue, please.')
  assert.deepEqual(ins.source, { kind: 'conversation', conversation: 'c-ins', message: i.message.id, author: 'Pat', at: i.message.at, invitation: i.invitations[0]!.id })
  await assert.rejects(s.ds.post('c-ins', { text: 'x', author: 'Pat', token: 'tok-ci-0003', runs: ['kid/converse/run-001'] }), /not work of this conversation/)
  await finish(s, F)
  const late = await s.ds.post('c-ins', { text: 'Also a border.', author: 'Pat', token: 'tok-ci-0004', runs: [F] })
  assert.equal(late.invitations[0]!.state, 'failed')
  assert.match(late.invitations[0]!.error!, /never redirected/)
  assert.equal(await runsOf(s, 'front'), 1, 'no new run started instead')
  s.cs.close(); s.x.close()
})

test('a group without a default addressee asks whom a message is for; nothing is recorded', async () => {
  const s = await setup()
  const c = s.ds.create('c-grp', { title: 'Front and kid', by: 'Pat', members: ['front', 'kid'] })
  assert.equal(c.conversation.default_to, null)
  await assert.rejects(s.ds.post('c-grp', { text: 'Hello?', author: 'Pat', token: 'tok-cg-0001' }), (e: unknown) => e instanceof RequestError && e.status === 409 && (e.detail as { code: string; members: string[] }).code === 'choose-recipient' && (e.detail as { members: string[] }).members.join() === 'front,kid')
  assert.equal(s.ds.messages('c-grp').length, 0)
  const both = await s.ds.post('c-grp', { text: 'Hello both.', author: 'Pat', token: 'tok-cg-0002', to: ['front', 'kid'] })
  assert.deepEqual(both.invitations.map(i => [i.participant, i.role]), [['front', 'discuss'], ['kid', 'discuss']])
  s.ds.setDefault('c-grp', 'kid', { by: 'Pat', note: 'kid answers first' })
  assert.deepEqual((await s.ds.post('c-grp', { text: 'Next?', author: 'Pat', token: 'tok-cg-0003' })).invitations.map(i => i.participant), ['kid'])
  assert.deepEqual(s.ds.metaRows('c-grp').filter(m => m.field === 'defaultTo').map(m => m.value), ['kid'])
  s.cs.close(); s.x.close()
})

test('a conductor that finished before its awaited result returns: continued once; held while no longer facilitated or while closed; resume runs it once; reopening replays nothing', async () => {
  const s = await setup()
  s.ds.create('c-late', { title: 'Late result', by: 'Pat', members: ['kid'], facilitate: true })
  const m1 = (await s.ds.post('c-late', { text: 'Go.', author: 'Pat', token: 'tok-cl-0001' })).message
  const C = s.cs.conversation('c-late')!.conductor!
  s.x.db.prepare('UPDATE jobs SET state = \'done\' WHERE workspace = \'ponderer\'').run()
  const inv = (await s.ds.invite('c-late', { participant: 'kid', question: 'Run it.', re: [m1.id], by: 'ponderer-agent', byRun: C })).invitation
  await s.ds.contribute('c-late', { text: 'Started.', author: 'kid-agent', run: inv.run!, invitation: inv.id, re: [m1.id] })
  const aw = await s.ds.awaitResult('c-late', { run: inv.run!, note: 'kid\'s result', by: 'ponderer-agent', byRun: C })
  await finish(s, C)
  // Facilitation ends before the result: the outcome is held, not a new conductor turn.
  s.ds.endFacilitation('c-late', { by: 'Pat' })
  await finish(s, inv.run!)
  await s.ds.reconcile(); await s.ds.reconcile()
  assert.equal(s.ds.invitation(aw.invitation.id)!.state, 'unanswered')
  assert.match(s.ds.invitation(aw.invitation.id)!.held!, /nobody facilitates/)
  assert.equal(await runsOf(s, 'ponderer'), 1, 'nothing started')
  const st = await s.ds.status('c-late')
  assert.deepEqual(st.continuations.map(h => h.awaitedBy), [C])
  assert.ok((await s.ds.obligations('c-late')).some(b => b.kind === 'continuation'))
  // Resume: one new conductor turn, once.
  const r = await s.ds.resume('c-late', { by: 'Pat' })
  assert.deepEqual(r.resumed, [inv.id, aw.invitation.id], 'both outcomes C awaited were held together')
  assert.equal(await runsOf(s, 'ponderer'), 2)
  assert.deepEqual((await s.ds.resume('c-late', { by: 'Pat' })).resumed, [])
  await s.ds.reconcile()
  assert.equal(await runsOf(s, 'ponderer'), 2, 'told once')
  // Closed: a result that comes due is held; reopening replays nothing; resume runs it once.
  s.ds.create('c-shut', { title: 'Closed room', by: 'Pat', members: ['kid'], facilitate: true })
  const m2 = (await s.ds.post('c-shut', { text: 'Go.', author: 'Pat', token: 'tok-cs-0001' })).message
  const C2 = s.cs.conversation('c-shut')!.conductor!
  s.x.db.prepare('UPDATE jobs SET state = \'done\' WHERE workspace = \'ponderer\'').run()
  const inv2 = (await s.ds.invite('c-shut', { participant: 'kid', question: 'Run it.', re: [m2.id], by: 'ponderer-agent', byRun: C2 })).invitation
  await finish(s, C2)
  s.ds.close('c-shut', { by: 'Pat' })
  await s.ds.contribute('c-shut', { text: 'Done: the result.', author: 'kid-agent', run: inv2.run!, invitation: inv2.id, re: [m2.id], kind: 'result' })
  assert.equal(s.ds.invitation(inv2.id)!.state, 'answered', 'a late result stays readable while closed')
  assert.match(s.ds.invitation(inv2.id)!.held!, /closed/)
  const n = await runsOf(s, 'ponderer')
  s.ds.reopen('c-shut', { by: 'Pat' })
  await s.ds.reconcile()
  assert.equal(await runsOf(s, 'ponderer'), n, 'reopening replays nothing')
  await s.ds.resume('c-shut', { by: 'Pat', request: inv2.id })
  assert.equal(await runsOf(s, 'ponderer'), n + 1)
  assert.equal(s.ds.invitation(inv2.id)!.held, null)
  s.cs.close(); s.x.close()
})

test('an unavailable recipient fails visibly and is retried there, never elsewhere; a restart between request and record finds the same run', async () => {
  const s = await setup()
  const kid = join(s.area, 'pj-kid', 'devdocs', 'workflows', 'converse.yaml')
  await rm(kid)
  const a = await s.ds.post('c-un', { text: 'Hello kid.', author: 'Pat', token: 'tok-cu-0001', with: 'kid' })
  assert.equal(a.invitations[0]!.state, 'failed')
  assert.ok(a.invitations[0]!.error)
  await s.ds.reconcile(); await s.ds.reconcile(); await s.ds.reconcile()
  assert.equal(s.ds.invitation(a.invitations[0]!.id)!.tries, 3, 'reconcile stops after its tries')
  assert.equal(await runsOf(s, 'front'), 0, 'nothing fell back to another project')
  await writeFile(kid, WF('converse', 'kid-agent'))
  const r = await s.ds.retry('c-un', a.invitations[0]!.id)
  assert.deepEqual([r.state, r.run], ['started', 'kid/converse/run-001'])
  // A crash after the run request and before its record: dispatching again finds the same run.
  const b = await s.ds.post('c-un', { text: 'Again.', author: 'Pat', token: 'tok-cu-0002' })
  s.cs.db.prepare('UPDATE invitations SET state = \'pending\', run = NULL WHERE id = ?').run(b.invitations[0]!.id)
  const cs2 = new ConversationStore({ area: s.area, exec: s.x })
  await new ConversationService(cs2).reconcile()
  assert.equal(new ConversationService(cs2).invitation(b.invitations[0]!.id)!.run, 'kid/converse/run-002')
  assert.equal(await runsOf(s, 'kid'), 2)
  cs2.close(); s.cs.close(); s.x.close()
})

test('a v11 store: direct conversations become rooms with their receipts and runs; completed work is never pending; a pending turn finds its run', async () => {
  const s = await setup()
  s.cs.db.exec(`DROP TABLE facilitations; ALTER TABLE conversations DROP COLUMN default_to; ALTER TABLE invitations DROP COLUMN role; ALTER TABLE invitations DROP COLUMN receipt;
    ALTER TABLE invitations DROP COLUMN held; ALTER TABLE archives DROP COLUMN path; PRAGMA user_version = 11`)
  const at = '2026-10-20T10:00:00.000Z'
  s.cs.db.prepare('INSERT INTO conversations (id, title, created, updated, state, by, workspace, workflow, kind, category) VALUES (\'old\', \'Old talk\', ?, ?, \'open\', \'Pat\', \'front\', \'converse\', \'conversation\', NULL)').run(at, at)
  const msg = (role: string, text: string, o: Record<string, string | number | null> = {}) => Number(s.cs.db.prepare('INSERT INTO messages (conv, role, author, text, at, token, kind, run, dispatch_state, dispatch_run, dispatch_error, dispatch_tries) VALUES (\'old\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(role, role === 'person' ? 'Pat' : 'front-agent', text, at, role === 'person' ? `tok-old-${text}` : null, role === 'person' ? 'message' : 'reply', o.run ?? null, o.state ?? null, o.drun ?? null, o.error ?? null, o.tries ?? 0).lastInsertRowid)
  const first = await s.x.request({ workspace: 'front', workflow: 'converse', text: 'one', author: 'Pat', receipt: 'conversation:old:1', via: 'conversation' })
  const m1 = msg('person', 'one', { state: 'started', drun: `front/converse/${first.ref.run}`, tries: 1 })
  const m2 = msg('agent', 'answer', { run: `front/converse/${first.ref.run}` })
  const m3 = msg('person', 'two', { state: 'failed', error: 'no workflow then', tries: 3 })
  const m4 = msg('person', 'three', { state: 'pending' })
  assert.deepEqual([m1, m2, m3, m4], [1, 2, 3, 4])
  // The request of #4 was made and the process died before recording it.
  const fourth = await s.x.request({ workspace: 'front', workflow: 'converse', text: 'three', author: 'Pat', receipt: 'conversation:old:4', via: 'conversation' })
  s.cs.db.prepare('INSERT INTO links (conv, message, run, relation, note, by, at) VALUES (\'old\', 1, ?, \'turn\', \'x\', \'conversation\', ?)').run(`front/converse/${first.ref.run}`, at)
  s.cs.close()
  const n = jobs(s)
  const cs = new ConversationStore({ area: s.area, exec: s.x })
  const ds = new ConversationService(cs)
  assert.equal(jobs(s), n, 'the migration starts nothing')
  const reqs = ds.invitations('old')
  assert.deepEqual(reqs.map(r => [r.role, r.receipt, r.state, r.run, r.answered_by]), [
    ['converse', 'conversation:old:1', 'answered', `front/converse/${first.ref.run}`, 2],
    ['converse', 'conversation:old:3', 'failed', null, null],
    ['converse', 'conversation:old:4', 'pending', null, null],
  ])
  assert.deepEqual([cs.conversation('old')!.default_to, ds.mode('old'), cs.conversation('old')!.category], ['front', 'direct', 'conversation'])
  assert.deepEqual(ds.members('old').map(m => [m.participant, m.by]), [['Pat', 'wfe migration v12'], ['front', 'wfe migration v12']])
  assert.equal(cs.message(m2)!.invitation, reqs[0]!.id)
  await ds.reconcile()
  assert.deepEqual(ds.invitations('old').map(r => r.state), ['answered', 'failed', 'started'], 'only the pending turn is dispatched; the failed one waits for retry')
  assert.equal(ds.invitations('old')[2]!.run, `front/converse/${fourth.ref.run}`, 'its receipt found the run already made')
  assert.equal(await runsOf(s, 'front'), 2)
  const next = await ds.post('old', { text: 'four', author: 'Pat', token: 'tok-old-four' })
  assert.deepEqual(next.invitations.map(i => [i.role, i.run]), [['converse', 'front/converse/run-003']])
  cs.close(); s.x.close()
})

test('archives: a one-to-one room at conversations/<id>, the same path after a conductor joins; a failed push keeps the room; a fresh clone restores every record once', async () => {
  const s = await setup()
  const a = new ConversationArchive(s.ds)
  const m = await s.ds.post('c-arc', { text: 'Archive me.', author: 'Pat', token: 'tok-ca-0001', with: 'front' })
  await s.ds.contribute('c-arc', { text: 'Archived soon.', author: 'front-agent', run: m.invitations[0]!.run!, invitation: m.invitations[0]!.id, re: [m.message.id] })
  assert.equal((await a.status('c-arc')).path, 'conversations/c-arc')
  const failed = await a.publish(['c-arc'], { beforePush: async () => { throw new Error('remote down') } })
  assert.match(failed.failed[0]!.error, /remote down/)
  assert.equal((await a.status('c-arc')).state, 'failed')
  assert.equal(s.ds.messages('c-arc').length, 2, 'the room is untouched')
  assert.equal((await a.publish(['c-arc'])).published.length, 1)
  await s.ds.startFacilitation('c-arc', { text: 'ponderer, lead us.', author: 'Pat', token: 'tok-ca-0002' })
  await a.publish(['c-arc'])
  assert.deepEqual((await a.publish(['c-arc'])).unchanged, ['c-arc'], 'a second backfill adds nothing')
  assert.equal((await a.status('c-arc')).path, 'conversations/c-arc', 'promotion does not move the archive')
  const fresh = join(s.area, 'fresh')
  await gitOk(s.area, ['clone', '-q', s.bare, fresh])
  const lines = (await readFile(join(fresh, 'conversations', 'c-arc', 'transcript.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l) as { type: string; id: number; author?: string; kind?: string; state?: string; role?: string; receipt?: string })
  assert.deepEqual(lines.filter(l => l.type === 'message').map(l => [l.id, l.author]), s.ds.messages('c-arc').map(x => [x.id, x.author]))
  assert.equal(new Set(lines.map(l => `${l.type}:${l.id}`)).size, lines.length, 'no duplicate record')
  assert.ok(lines.some(l => l.type === 'activity' && l.kind === 'facilitation' && l.state === 'started'))
  assert.ok(lines.some(l => l.type === 'invitation' && l.role === 'converse' && l.receipt === `conversation:c-arc:request:${m.invitations[0]!.id}`))
  const man = JSON.parse(await readFile(join(fresh, 'conversations', 'c-arc', 'manifest.json'), 'utf8')) as { format: string; path: string; defaultTo: string; facilitations: { state: string }[] }
  assert.deepEqual([man.format, man.path, man.defaultTo, man.facilitations.map(f => f.state)], ['ag.conversation.v1', 'conversations/c-arc', 'front', ['active']])
  s.cs.close(); s.x.close()
})

test('from an attempt: show finds its conversation, reply names its run and request, a question is wfe run ask; an instruction carries the message as its source', async () => {
  const s = await setup()
  const m1 = (await s.ds.post('c5', { text: 'Make an icon.', author: 'Pat', token: 'tok-c5-0001', with: 'front' })).message
  const c = await s.x.claim('test')
  assert.ok('attempt' in c)
  const kid = await s.x.request({ workspace: 'kid', workflow: 'converse', text: 'x', author: 'Pat', receipt: 'kid-request-1', via: 'cli' })
  const cli = (args: string[]) => pexec(process.execPath, [join(pkg, 'cli', 'wfe.ts'), ...args, '--registry', s.registry, '--area', s.area, '--json'], { env: { ...process.env, WFE_ATTEMPT: c.attempt.id } })
    .then(r => ({ code: 0, out: JSON.parse(r.stdout), err: r.stderr }), e => ({ code: e.code as number, out: JSON.parse(e.stdout || '{}'), err: String(e.stderr) }))
  const shown = await cli(['conversation', 'show'])
  assert.equal(shown.code, 0, shown.err)
  assert.equal(shown.out.conversation.id, 'c5')
  const rep = await cli(['conversation', 'reply', '--text', 'On it.', '--re', String(m1.id), '--kind', 'progress'])
  assert.equal(rep.code, 0, rep.err)
  assert.deepEqual([rep.out.message.run, rep.out.message.author, rep.out.message.participant, rep.out.message.invitation], ['front/converse/run-001', 'front-agent', 'front', 1])
  const q = await cli(['conversation', 'reply', '--text', 'Which size?', '--re', String(m1.id), '--kind', 'question'])
  assert.notEqual(q.code, 0, 'a question is wfe run ask')
  const link = await cli(['conversation', 'link', String(m1.id), '--run', `kid/converse/${kid.ref.run}`, '--as', 'new', '--note', 'the icon work is kid\'s'])
  assert.equal(link.code, 0, link.err)
  const ins = await cli(['run', 'instruct', `converse/${kid.ref.run}`, '--workspace', 'kid', '--instruction', 'Make an icon.', '--from', 'Pat', '--source-message', `c5:${m1.id}`])
  assert.equal(ins.code, 0, ins.err)
  const r = await rec(s, `kid/converse/${kid.ref.run}`)
  assert.deepEqual(r.instructions!.i1!.source, { kind: 'conversation', conversation: 'c5', message: m1.id, author: 'Pat', at: m1.at })
  // `wfe discussion` is the same command.
  const old = await cli(['discussion', 'show'])
  assert.equal(old.out.conversation.id, 'c5')
  s.cs.close(); s.x.close()
})

test('a message keeps the way it came (via); questions are pending until named, or followed while alone', async () => {
  const s = await setup()
  const m = (await s.ds.post('c9', { text: 'From the phone.', author: 'Pat', token: 'slack:T1:D1:1.000001', via: 'slack', with: 'front' })).message
  const desk = (await s.ds.post('c9', { text: 'From the desk.', author: 'Pat', token: 'tok-c9-0001' })).message
  assert.deepEqual(s.ds.messages('c9').filter(x => x.role === 'person').map(x => [x.id, x.via]), [[m.id, 'slack'], [desk.id, null]])
  await assert.rejects(s.ds.post('c9', { text: 'x', author: 'Pat', token: 'tok-c9-0002', via: 'Not a Way!' }), /via must match/)
  assert.deepEqual(pendingQuestions([
    { id: 1, role: 'agent', kind: 'question', re: '[]' }, { id: 2, role: 'agent', kind: 'question', re: '[]' }, { id: 3, role: 'person', kind: 'message', re: '[]' }, { id: 4, role: 'person', kind: 'message', re: '[2]' },
  ] as never), [1], 'with two pending, an unaddressed message answers neither; naming one answers it')
  s.cs.close(); s.x.close()
})

test('HTTP: participants, a first message with `with`, a group asks whom, facilitation and the default addressee, the view says where results open', async () => {
  const s = await setup()
  const { createHandler } = await import('../server/api.ts')
  const { createServer } = await import('node:http')
  await writeFile(join(s.area, 'present.json'), JSON.stringify({ answerBase: 'http://lan.invalid:8093/wfe/' }))
  const server = createServer(createHandler({ registryFile: s.registry, allowedOrigins: [], exec: s.x, conversations: s.cs }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/conversations`
  const post = (path: string, body: unknown, origin?: string) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
  try {
    const list = await (await fetch(base)).json() as { person: string; participants: { participant: string; kind: string; state: string; converse: string | null }[] }
    assert.equal(list.person, 'Pat')
    assert.deepEqual(list.participants.map(p => [p.participant, p.kind, p.state, p.converse]), [['front', 'project', 'available', 'converse'], ['kid', 'project', 'available', 'converse'], ['ponderer', 'project', 'available', 'converse'], ['ponderer', 'facilitator', 'available', null]])
    const first = await post('h1/messages', { text: 'Hi kid', token: 'tok-h1-0001', with: 'kid' })
    assert.equal(first.status, 200)
    const sent = await first.json() as { created: boolean; requests: { run: string; role: string }[]; message: { author: string } }
    assert.deepEqual([sent.created, sent.requests[0]!.run, sent.requests[0]!.role, sent.message.author], [true, 'kid/converse/run-001', 'converse', 'Pat'])
    assert.equal((await post('h1/messages', { text: 'Hi front', token: 'tok-h1-0002', with: 'front' })).status, 409)
    assert.equal((await post('h2/messages', { text: 'Hi?', token: 'tok-h2-0001' })).status, 404)
    assert.equal((await post('h1/messages', { text: 'x', token: 'tok-h1-0003' }, 'http://evil.example')).status, 403, 'another site may not write')
    assert.equal((await post('h1/members', { participant: 'front', action: 'join' })).status, 200)
    assert.equal((await post('h1/default', { participant: null, note: 'a group now' })).status, 200)
    const ask = await post('h1/messages', { text: 'Who?', token: 'tok-h1-0004' })
    assert.equal(ask.status, 409)
    assert.equal(((await ask.json()) as { detail: { code: string } }).detail.code, 'choose-recipient')
    const fac = await (await post('h1/facilitation', { action: 'start', text: 'Please lead.', token: 'tok-h1-0005' })).json() as { facilitation: { state: string }; requests: { role: string; run: string }[] }
    assert.deepEqual([fac.facilitation.state, fac.requests[0]!.role, fac.requests[0]!.run], ['active', 'conduct', 'ponderer/conduct/run-001'])
    const filtered = await (await fetch(`${base}?with=kid&mode=facilitated`)).json() as { conversations: { id: string; mode: string; members: string[] }[] }
    assert.deepEqual(filtered.conversations.map(c => [c.id, c.mode]), [['h1', 'facilitated']])
    const v = await (await fetch(`${base}/h1`)).json() as { conversation: { mode: string; defaultTo: string | null; facilitation: { brief: number } }; requests: { role: string }[]; runs: { key: string; url: string; files: string }[]; archive: { path: string } }
    assert.deepEqual([v.conversation.mode, v.conversation.defaultTo, v.archive.path], ['facilitated', null, 'conversations/h1'])
    assert.deepEqual(v.requests.map(r => r.role), ['converse', 'conduct'])
    assert.deepEqual(v.runs.find(r => r.key === 'kid/converse/run-001') && [v.runs.find(r => r.key === 'kid/converse/run-001')!.url, v.runs.find(r => r.key === 'kid/converse/run-001')!.files], ['http://lan.invalid:8093/wfe/#/ws/kid/run/converse/run-001', 'http://lan.invalid:8093/wfe/api/projects/kid/runs/converse/run-001/raw?path='])
    assert.equal((await post('h1/facilitation', { action: 'end', note: 'done' })).status, 200)
    assert.equal(((await (await post('h1/resume', {})).json()) as { resumed: number[] }).resumed.length, 0)
    assert.equal((await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/discussions')).status, 404, 'one tree for every conversation')
  } finally { server.closeAllConnections(); server.close(); s.cs.close(); s.x.close() }
})

// p15: archsage converse/run-001 gave its reply text without --text, read the
// tail of a long help as success and completed without replying.
test('a reply whose text is given without --text is refused with that said first and last, and nothing is posted', async () => {
  const s = await setup()
  await s.ds.post('c-u', { text: 'Hi', author: 'Pat', token: 'tok-cu-u001', with: 'front' })
  const r = await pexec(process.execPath, [join(pkg, 'cli', 'wfe.ts'), 'conversation', 'reply', '--re', '1', 'The answer is 42.', '--by', 'x', '--registry', s.registry, '--area', s.area])
    .then(() => ({ code: 0, err: '' }), e => ({ code: e.code as number, err: String(e.stderr) }))
  assert.equal(r.code, 2)
  const lines = r.err.trim().split('\n')
  assert.match(lines[0]!, /"The answer is 42\." is not a conversation id; text goes in --text/)
  assert.match(lines.at(-1)!, /Nothing was posted or recorded/)
  assert.equal(s.ds.messages('c-u').length, 1)
  s.cs.close(); s.x.close()
})
