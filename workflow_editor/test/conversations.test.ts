// project_migration p8 step 3 (docs/conversations.md): a conversation with
// the entrance. Each person's message starts one bounded run, once, also
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
  const config = () => writeFile(join(area, 'conversations.json'), JSON.stringify({ entrance: { workspace: 'front', workflow: 'converse' }, person: 'Pat' }))
  if (o.config !== false) await config()
  const x = new ExecStore({ registryFile: registry, area })
  const cs = new ConversationStore({ area, exec: x })
  const regs = (await loadRegistry(registry)).workspaces
  const ws = (id: string) => new Workspace(regs.find(w => w.project === id)!)
  return { area, registry, x, cs, ws, config }
}
const rec = async (ws: Workspace, ref: RunRef) => (await readRun(await runSpace(ws, ref), ref)).record!

test('a message starts one run with the person\'s words and where they were said; the same submission is one message', async () => {
  const s = await setup()
  const a = await s.cs.post('d1', { text: 'Make me a blue icon.', author: 'Pat', token: 'tok-00000001' })
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
  const s = await setup({ config: false })
  const a = await s.cs.post('d2', { text: 'first', author: 'Pat', token: 'tok-00000002' })
  assert.equal(a.message.dispatch_state, 'failed')
  assert.match(a.message.dispatch_error ?? '', /conversations\.json/)
  await s.config()
  // A restart: a new store over the same file.
  s.cs.close()
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
  const m1 = (await s.cs.post('d3', { text: 'Make an icon.', author: 'Pat', token: 'tok-00000031' })).message
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
  const m1 = (await s.cs.post('d4', { text: 'Make an icon.', author: 'Pat', token: 'tok-00000041' })).message
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
  const m1 = (await s.cs.post('d5', { text: 'Make an icon.', author: 'Pat', token: 'tok-00000051' })).message
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
  const m = (await s.cs.post('d9', { text: 'From the phone.', author: 'Pat', token: 'slack:T1:D1:1.000001', via: 'slack' })).message
  const desk = (await s.cs.post('d9', { text: 'From the desk.', author: 'Pat', token: 'tok-00000091' })).message
  const v = await s.cs.view('d9')
  assert.deepEqual(v.messages.filter(x => x.role === 'person').map(x => [x.id, x.via]), [[m.id, 'slack'], [desk.id, null]])
  await assert.rejects(s.cs.post('d9', { text: 'x', author: 'Pat', token: 'tok-00000092', via: 'Not a Way!' }), /via must match/)
  s.cs.db.exec('ALTER TABLE messages DROP COLUMN via; PRAGMA user_version = 1')
  s.cs.close()
  const reopened = new ConversationStore({ area: s.area, exec: s.x })
  assert.deepEqual((await reopened.view('d9')).messages.filter(x => x.role === 'person').map(x => [x.id, x.via]), [[m.id, null], [desk.id, null]])
  reopened.close(); s.x.close()
})
