// project_migration p8 step 3, workflow_editor p15 (docs/conversations.md):
// a conversation with one project's conversational workflow, its recorded
// destination. Each person's message starts one bounded run, once, also
// when its request failed or the process restarted; replies name their run
// and the messages they answer, so concurrent work is never attributed to
// the newest message; the entrance's interpretation is a link that a later
// one supersedes; the person's words reach another run with their source.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ConversationStore, pendingQuestions } from '../server/conversations.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { listRuns, readRun } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'
import type { RunRef } from '../shared/run.ts'

const pexec = promisify(execFile)
const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-conv-p8-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const CONVERSE = `schema: ag.workflow.v2
id: converse
name: Converse
intent: |
  Serve what the person says.
documentation: {policy: custom, plan: false, reports: false, final: false}
execution: {agent: front-agent}
repositories:
  root: {path: ., access: editable}
nodes:
  talk:
    type: talk
    description: Understand the message.
`

let k = 0
async function setup(o: { config?: boolean } = {}) {
  
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  for (const id of ['front', 'kid']) {
    const dir = join(area, `pj-${id}`)
    const r = await createProject({ dir, id, name: id, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
    assert.ok(r.ok, r.message)
    await writeFile(join(dir, 'devdocs', 'workflows', 'converse.yaml'), CONVERSE.replace('front-agent', `${id}-agent`))
    await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  }
  const config = (targets = ['front', 'kid']) => writeFile(join(area, 'conversations.json'), JSON.stringify({ person: 'Pat', targets: targets.map(workspace => ({ workspace, workflow: 'converse' })) }))
  if (o.config !== false) await config()
  const x = new ExecStore({ registryFile: registry, area })
  const cs = new ConversationStore({ area, exec: x })
  const regs = (await loadRegistry(registry)).workspaces
  const ws = (id: string) => new Workspace(regs.find(w => w.project === id)!)
  return { area, registry, x, cs, ws, config }
}
const FRONT = { workspace: 'front', workflow: 'converse' }
const KID = { workspace: 'kid', workflow: 'converse' }
const rec = async (ws: Workspace, ref: RunRef) => (await readRun(await runSpace(ws, ref), ref)).record!

test('a message starts one run with the person\'s words and where they were said; the same submission is one message', async () => {
  const s = await setup()
  const a = await s.cs.post('d1', { text: 'Make me a blue icon.', author: 'Pat', token: 'tok-00000001', target: FRONT })
  assert.equal(a.duplicate, false)
  assert.equal(a.message.dispatch_state, 'started')
  assert.equal(a.message.dispatch_run, 'front/converse/run-001')
  const again = await s.cs.post('d1', { text: 'Make me a blue icon.', author: 'Pat', token: 'tok-00000001' })
  assert.equal(again.duplicate, true)
  assert.equal((await listRuns(s.ws('front'))).length, 1, 'one run for one message')
  const r = await rec(s.ws('front'), { workflow: 'converse', run: 'run-001' })
  assert.equal(r.input.kind, 'braindump')
  assert.equal(r.input.author, 'Pat')
  assert.deepEqual(r.input.source, { kind: 'conversation', conversation: 'd1', message: a.message.id, author: 'Pat', at: a.message.at })
  const v = await s.cs.view('d1')
  assert.deepEqual(v.links.map(l => [l.message, l.relation, l.run]), [[a.message.id, 'turn', 'front/converse/run-001']])
  assert.equal(v.runs[0].situation, 'not-started')
  s.cs.close(); s.x.close()
})

test('a turn that could not be requested is started later, once; a restart keeps every message and starts nothing twice', async () => {
  const s = await setup()
  // A store whose request cannot be made (no execution here): the message is kept, its turn failed with the reason.
  const bare = new ConversationStore({ area: s.area })
  const a = await bare.post('d2', { text: 'first', author: 'Pat', token: 'tok-00000002', target: FRONT })
  assert.equal(a.message.dispatch_state, 'failed')
  assert.match(a.message.dispatch_error ?? '', /execution is not configured/)
  bare.close()
  // A restart: a new store over the same file.
  const cs = new ConversationStore({ area: s.area, exec: s.x })
  const notes = await cs.dispatchDue()
  assert.deepEqual(notes, [`conversation d2 #${a.message.id}: started front/converse/run-001`])
  assert.deepEqual(await cs.dispatchDue(), [], 'nothing is due twice')
  // A crash after the request and before the record: dispatching again finds the same run.
  cs.db.prepare('UPDATE messages SET dispatch_state = \'pending\' WHERE id = ?').run(a.message.id)
  await cs.dispatchDue()
  assert.equal((await listRuns(s.ws('front'))).length, 1, 'the request\'s receipt finds the run')
  assert.equal(cs.links('d2').filter(l => l.relation === 'turn').length, 1)
  cs.close(); s.x.close()
})

test('concurrent work: each reply names its run and what it answers; retried replies are one message; questions wait for the person', async () => {
  const s = await setup()
  const m1 = (await s.cs.post('d3', { text: 'Make an icon.', author: 'Pat', token: 'tok-00000031', target: FRONT })).message
  const m2 = (await s.cs.post('d3', { text: 'And what did playprey deliver last?', author: 'Pat', token: 'tok-00000032' })).message
  assert.equal(m2.dispatch_run, 'front/converse/run-002', 'the second message has its own run while the first is open')
  // The second run answers first; the first run's late completion still answers m1.
  const r2 = s.cs.reply('d3', { text: 'playprey delivered onboard/run-006.', author: 'front-agent', run: 'front/converse/run-002', re: [m2.id] })
  const r1 = s.cs.reply('d3', { text: 'Here is the icon.', author: 'front-agent', run: 'front/converse/run-001', re: [m1.id], kind: 'result' })
  assert.equal(s.cs.reply('d3', { text: 'Here is the icon.', author: 'front-agent', run: 'front/converse/run-001', re: [m1.id], kind: 'result' }).duplicate, true)
  const v = await s.cs.view('d3')
  assert.deepEqual(v.messages.filter(m => m.role === 'agent').map(m => [m.id, m.run, m.re]), [[r2.message.id, 'front/converse/run-002', [m2.id]], [r1.message.id, 'front/converse/run-001', [m1.id]]])
  assert.throws(() => s.cs.reply('d3', { text: 'x', author: 'front-agent', run: null, re: [99_999] }), /not in conversation/)
  // A question waits until the person answers it — by naming it, or as the next message when it is the only one.
  const q = s.cs.reply('d3', { text: 'Which size?', author: 'front-agent', run: 'front/converse/run-001', kind: 'question', question: 'q1' }).message
  assert.deepEqual((await s.cs.view('d3')).asking, [q.id])
  await s.cs.post('d3', { text: '64px', author: 'Pat', token: 'tok-00000033' })
  assert.deepEqual((await s.cs.view('d3')).asking, [])
  assert.deepEqual(pendingQuestions([
    { id: 1, role: 'agent', kind: 'question', re: '[]' }, { id: 2, role: 'agent', kind: 'question', re: '[]' }, { id: 3, role: 'person', kind: 'message', re: '[]' }, { id: 4, role: 'person', kind: 'message', re: '[2]' },
  ] as never), [1], 'with two pending, an unaddressed message answers neither; naming one answers it')
  s.cs.close(); s.x.close()
})

test('the entrance\'s interpretation is a link a correction supersedes; the original message stays as it was', async () => {
  const s = await setup()
  const m1 = (await s.cs.post('d4', { text: 'Make an icon.', author: 'Pat', token: 'tok-00000041', target: FRONT })).message
  const m2 = (await s.cs.post('d4', { text: 'make it red', author: 'Pat', token: 'tok-00000042' })).message
  const l1 = s.cs.link('d4', { message: m2.id, run: 'front/converse/run-001', relation: 'follow-up', note: 'about the icon', by: 'front-agent' })
  assert.equal(s.cs.link('d4', { message: m2.id, run: 'front/converse/run-001', relation: 'follow-up', note: 'about the icon', by: 'front-agent' }).duplicate, true)
  const l2 = s.cs.link('d4', { message: m2.id, run: 'front/converse/run-001', relation: 'steer', note: 'changes the running icon work', by: 'front-agent' })
  assert.equal(l2.link.supersedes, l1.link.id)
  assert.throws(() => s.cs.link('d4', { message: m2.id, run: 'front/converse/run-001', relation: 'turn', note: 'x', by: 'front-agent' }), /relation is one of/)
  assert.equal(s.cs.message(m2.id)!.text, 'make it red')
  assert.ok(m1)
  s.cs.close(); s.x.close()
})

test('from an attempt: show finds its conversation, reply names its run, and an instruction carries the message as its source', async () => {
  const s = await setup()
  const m1 = (await s.cs.post('d5', { text: 'Make an icon.', author: 'Pat', token: 'tok-00000051', target: FRONT })).message
  const c = await s.x.claim('test')
  assert.ok('attempt' in c)
  // The kid project's run the message is about.
  const kid = await s.x.request({ workspace: 'kid', workflow: 'converse', text: 'x', author: 'Pat', receipt: 'kid-request-1', via: 'cli' })
  const cli = (args: string[]) => pexec(process.execPath, [join(pkg, 'cli', 'wfe.ts'), ...args, '--registry', s.registry, '--area', s.area, '--json'], { env: { ...process.env, WFE_ATTEMPT: c.attempt.id } })
    .then(r => ({ code: 0, out: JSON.parse(r.stdout), err: r.stderr }), e => ({ code: e.code as number, out: JSON.parse(e.stdout || '{}'), err: String(e.stderr) }))
  const shown = await cli(['conversation', 'show'])
  assert.equal(shown.code, 0, shown.err)
  assert.equal(shown.out.conversation.id, 'd5')
  const rep = await cli(['conversation', 'reply', '--text', 'On it.', '--re', String(m1.id), '--kind', 'progress'])
  assert.equal(rep.code, 0, rep.err)
  assert.equal(rep.out.message.run, 'front/converse/run-001')
  assert.equal(rep.out.message.author, 'front-agent')
  const link = await cli(['conversation', 'link', String(m1.id), '--run', `kid/converse/${kid.ref.run}`, '--as', 'new', '--note', 'the icon work is kid\'s'])
  assert.equal(link.code, 0, link.err)
  const ins = await cli(['run', 'instruct', `converse/${kid.ref.run}`, '--workspace', 'kid', '--instruction', 'Make an icon.', '--from', 'Pat', '--source-message', `d5:${m1.id}`])
  assert.equal(ins.code, 0, ins.err)
  const r = await rec(s.ws('kid'), kid.ref)
  assert.deepEqual(r.instructions!.i1.source, { kind: 'conversation', conversation: 'd5', message: m1.id, author: 'Pat', at: m1.at })
  assert.equal(r.instructions!.i1.by, 'front-agent')
  s.cs.close(); s.x.close()
})

// slack_connect p1: a message that came another way than the Front Desk says
// so in the record, and a store written before `via` existed opens with it.
test('a message keeps the way it came (via); a version-1 store gains the column with its messages kept', async () => {
  const s = await setup()
  const m = (await s.cs.post('d9', { text: 'From the phone.', author: 'Pat', token: 'slack:T1:D1:1.000001', via: 'slack', target: FRONT })).message
  const desk = (await s.cs.post('d9', { text: 'From the desk.', author: 'Pat', token: 'tok-00000091' })).message
  const v = await s.cs.view('d9')
  assert.deepEqual(v.messages.filter(x => x.role === 'person').map(x => [x.id, x.via]), [[m.id, 'slack'], [desk.id, null]])
  await assert.rejects(s.cs.post('d9', { text: 'x', author: 'Pat', token: 'tok-00000092', via: 'Not a Way!' }), /via must match/)
  s.cs.db.exec('DROP TABLE activities; DROP TABLE activity_events; DROP TABLE annotations; ALTER TABLE conversations DROP COLUMN conductor; ALTER TABLE conversations DROP COLUMN requester; ALTER TABLE messages DROP COLUMN node; DROP TABLE membership; DROP TABLE invitations; DROP TABLE invitation_events; DROP TABLE archives; ALTER TABLE conversations DROP COLUMN kind; ALTER TABLE messages DROP COLUMN participant; ALTER TABLE messages DROP COLUMN invitation; ALTER TABLE messages DROP COLUMN addressed; ALTER TABLE messages DROP COLUMN via; ALTER TABLE conversations DROP COLUMN workspace; ALTER TABLE conversations DROP COLUMN workflow; PRAGMA user_version = 1')
  s.cs.close()
  const reopened = new ConversationStore({ area: s.area, exec: s.x })
  assert.deepEqual((await reopened.view('d9')).messages.filter(x => x.role === 'person').map(x => [x.id, x.via]), [[m.id, null], [desk.id, null]])
  reopened.close(); s.x.close()
})

// workflow_editor p15: every conversation has its own destination.
test('conversations with two projects: each turn goes to its conversation\'s destination, replies stay attributed, nothing defaults', async () => {
  const s = await setup()
  const f = (await s.cs.post('p15-f', { text: 'Hello Front.', author: 'Pat', token: 'tok-p15-f001', target: FRONT })).message
  const k = (await s.cs.post('p15-k', { text: 'Hello kid.', author: 'Pat', token: 'tok-p15-k001', target: KID })).message
  assert.equal(f.dispatch_run, 'front/converse/run-001')
  assert.equal(k.dispatch_run, 'kid/converse/run-001')
  // Later messages keep going where the conversation is, with or without naming it.
  const k2 = (await s.cs.post('p15-k', { text: 'And another thing.', author: 'Pat', token: 'tok-p15-k002' })).message
  const k3 = (await s.cs.post('p15-k', { text: 'One more.', author: 'Pat', token: 'tok-p15-k003', target: KID })).message
  assert.deepEqual([k2.dispatch_run, k3.dispatch_run], ['kid/converse/run-002', 'kid/converse/run-003'])
  assert.equal((await listRuns(s.ws('front'))).length, 1, 'no message of the kid conversation reached front')
  // Concurrent replies from both projects stay in their own conversations, named by run.
  s.cs.reply('p15-k', { text: 'kid answers the third.', author: 'kid-agent', run: 'kid/converse/run-003', re: [k3.id] })
  s.cs.reply('p15-f', { text: 'Front answers.', author: 'front-agent', run: 'front/converse/run-001', re: [f.id] })
  s.cs.reply('p15-k', { text: 'kid answers the first.', author: 'kid-agent', run: 'kid/converse/run-001', re: [k.id] })
  const vk = await s.cs.view('p15-k')
  assert.equal(vk.conversation.destination, 'kid/converse')
  assert.deepEqual(vk.messages.filter(m => m.role === 'agent').map(m => [m.author, m.run, m.re]), [['kid-agent', 'kid/converse/run-003', [k3.id]], ['kid-agent', 'kid/converse/run-001', [k.id]]])
  assert.deepEqual((await s.cs.view('p15-f')).messages.filter(m => m.role === 'agent').map(m => m.author), ['front-agent'])
  assert.deepEqual(s.cs.list({ target: KID }).map(c => c.id), ['p15-k'])
  // Another destination is another conversation; a new one names its destination; only configured targets.
  await assert.rejects(s.cs.post('p15-k', { text: 'to front?', author: 'Pat', token: 'tok-p15-k004', target: FRONT }), (e: Error & { status?: number }) => /is with kid\/converse/.test(e.message) && e.status === 409)
  await assert.rejects(s.cs.post('p15-new', { text: 'who?', author: 'Pat', token: 'tok-p15-n001' }), /names its destination/)
  await assert.rejects(s.cs.post('p15-new', { text: 'who?', author: 'Pat', token: 'tok-p15-n002', target: { workspace: 'nobody', workflow: 'converse' } }), /not a conversation target/)
  assert.equal(s.cs.conversation('p15-new'), undefined, 'a refused first message creates nothing')
  assert.equal(s.cs.messages('p15-k').length, 5, 'the refused message was not kept')
  s.cs.close(); s.x.close()
})

test('a recorded destination outlives a configuration change; one that cannot take the turn fails visibly and is retried there, never elsewhere', async () => {
  const s = await setup()
  await s.cs.post('p15-r', { text: 'first', author: 'Pat', token: 'tok-p15-r001', target: KID })
  // kid is no longer offered for new conversations; the existing one keeps going to kid.
  await s.config(['front'])
  const later = (await s.cs.post('p15-r', { text: 'second', author: 'Pat', token: 'tok-p15-r002' })).message
  assert.equal(later.dispatch_run, 'kid/converse/run-002')
  await assert.rejects(s.cs.post('p15-r2', { text: 'new with kid', author: 'Pat', token: 'tok-p15-r201', target: KID }), /not a conversation target/)
  const t = await s.cs.targets()
  assert.deepEqual(t.map(x => [x.target, x.state, x.agent]), [['front/converse', 'available', 'front-agent']])
  // The destination's workflow disappears: the turn fails with the reason and is not sent to front.
  await s.config(['front', 'kid'])
  const dir = join(s.area, 'pj-kid')
  await rm(join(dir, 'devdocs', 'workflows', 'converse.yaml'))
  const [kidView] = (await s.cs.targets()).filter(x => x.workspace === 'kid')
  assert.equal(kidView.state, 'unavailable')
  assert.match(kidView.problem ?? '', /no workflow "converse"/)
  const lost = (await s.cs.post('p15-r', { text: 'third', author: 'Pat', token: 'tok-p15-r003' })).message
  assert.equal(lost.dispatch_state, 'failed')
  assert.ok(lost.dispatch_error)
  assert.equal((await listRuns(s.ws('front'))).length, 0, 'nothing fell back to front')
  // Restored: the repair starts it at kid, once.
  await writeFile(join(dir, 'devdocs', 'workflows', 'converse.yaml'), CONVERSE.replace('front-agent', 'kid-agent'))
  const notes = await s.cs.dispatchDue()
  assert.deepEqual(notes, [`conversation p15-r #${lost.id}: started kid/converse/run-003`])
  assert.deepEqual(await s.cs.dispatchDue(), [])
  s.cs.close(); s.x.close()
})

test('a version-2 store maps every conversation once to the single entrance configured before', async () => {
  const s = await setup()
  await s.cs.post('p15-m', { text: 'old talk', author: 'Pat', token: 'tok-p15-m001', target: FRONT })
  s.cs.db.exec('DROP TABLE activities; DROP TABLE activity_events; DROP TABLE annotations; ALTER TABLE conversations DROP COLUMN conductor; ALTER TABLE conversations DROP COLUMN requester; ALTER TABLE messages DROP COLUMN node; DROP TABLE membership; DROP TABLE invitations; DROP TABLE invitation_events; DROP TABLE archives; ALTER TABLE conversations DROP COLUMN kind; ALTER TABLE messages DROP COLUMN participant; ALTER TABLE messages DROP COLUMN invitation; ALTER TABLE messages DROP COLUMN addressed; ALTER TABLE conversations DROP COLUMN workspace; ALTER TABLE conversations DROP COLUMN workflow; PRAGMA user_version = 2')
  s.cs.close()
  await writeFile(join(s.area, 'conversations.json'), JSON.stringify({ entrance: { workspace: 'front', workflow: 'converse' }, person: 'Pat' }))
  const cs = new ConversationStore({ area: s.area, exec: s.x })
  assert.equal((await cs.view('p15-m')).conversation.destination, 'front/converse')
  await s.config()
  const next = (await cs.post('p15-m', { text: 'continues', author: 'Pat', token: 'tok-p15-m002' })).message
  assert.equal(next.dispatch_run, 'front/converse/run-002')
  cs.close(); s.x.close()
})

test('HTTP: targets, a page\'s first message names its destination, another destination is 409, the view says where results open', async () => {
  const s = await setup()
  const { createHandler } = await import('../server/api.ts')
  const { createServer } = await import('node:http')
  await writeFile(join(s.area, 'present.json'), JSON.stringify({ answerBase: 'http://lan.invalid:8093/wfe/' }))
  const server = createServer(createHandler({ registryFile: s.registry, allowedOrigins: [], exec: s.x, conversations: s.cs }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/conversations`
  const post = (id: string, body: unknown, origin?: string) => fetch(`${base}/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
  try {
    const list = await (await fetch(base)).json() as { person: string; targets: { target: string; state: string }[] }
    assert.equal(list.person, 'Pat')
    assert.deepEqual(list.targets.map(t => [t.target, t.state]), [['front/converse', 'available'], ['kid/converse', 'available']])
    const first = await post('p15-h', { text: 'Hi kid', token: 'tok-p15-h001', target: 'kid/converse' })
    assert.equal(first.status, 200)
    const sent = await first.json() as { run: string; destination: string; message: { author: string } }
    assert.deepEqual([sent.run, sent.destination, sent.message.author], ['kid/converse/run-001', 'kid/converse', 'Pat'])
    assert.equal((await post('p15-h', { text: 'Hi front', token: 'tok-p15-h002', target: 'front/converse' })).status, 409)
    assert.equal((await post('p15-h2', { text: 'Hi?', token: 'tok-p15-h003' })).status, 400)
    assert.equal((await post('p15-h', { text: 'x', token: 'tok-p15-h004' }, 'http://evil.example')).status, 403, 'another site may not write')
    const filtered = await (await fetch(`${base}?target=kid/converse`)).json() as { conversations: { id: string; destination: string }[] }
    assert.deepEqual(filtered.conversations.map(c => [c.id, c.destination]), [['p15-h', 'kid/converse']])
    const v = await (await fetch(`${base}/p15-h`)).json() as { conversation: { destination: string }; runs: { key: string; url: string; files: string; presentations: unknown[] }[] }
    assert.equal(v.conversation.destination, 'kid/converse')
    assert.deepEqual(v.runs.map(r => [r.key, r.url, r.files, r.presentations]), [['kid/converse/run-001', 'http://lan.invalid:8093/wfe/#/ws/kid/run/converse/run-001', 'http://lan.invalid:8093/wfe/api/projects/kid/runs/converse/run-001/raw?path=', []]])
  } finally { server.closeAllConnections(); server.close(); s.cs.close(); s.x.close() }
})

// p15: archsage converse/run-001 gave its reply text without --text, read the
// tail of a long help as success and completed without replying.
test('a reply whose text is given without --text is refused with that said first and last, and nothing is posted', async () => {
  const s = await setup()
  await s.cs.post('p15-u', { text: 'Hi', author: 'Pat', token: 'tok-p15-u001', target: FRONT })
  const r = await pexec(process.execPath, [join(pkg, 'cli', 'wfe.ts'), 'conversation', 'reply', '--re', '1', 'The answer is 42.', '--by', 'x', '--registry', s.registry, '--area', s.area])
    .then(() => ({ code: 0, err: '' }), e => ({ code: e.code as number, err: String(e.stderr) }))
  assert.equal(r.code, 2)
  const lines = r.err.trim().split('\n')
  assert.match(lines[0], /"The answer is 42\." is not a conversation id; the text goes in --text/)
  assert.match(lines.at(-1)!, /Nothing was posted or recorded/)
  assert.equal(s.cs.messages('p15-u').length, 1)
  s.cs.close(); s.x.close()
})
