// argue p4 ex2 (docs/discussions.md *Reading a discussion*): a discussion's
// purpose category and display title, and its overview — an interpretation
// with sources, kept apart from speech and from execution state. Metadata
// and overviews send nothing, invite nobody and reopen nothing; an overview
// cites the messages it rests on and says how far it covers; the status a
// reader sees is derived from WFE's records (a person is "awaited" only when
// the question's receiver is that person); the list is filtered and paged
// with every view's counts; the archive exports both kinds of record.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../server/conversations.ts'
import { createProject } from '../server/create.ts'
import { DiscussionArchive } from '../server/discussionArchive.ts'
import { citations, DiscussionStore } from '../server/discussions.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { runOp } from '../server/runs.ts'
import { Workspace } from '../server/workspace.ts'
import type { RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-read-p4ex2-'))
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
  const ds = new DiscussionStore(cs)
  const regs = (await loadRegistry(registry)).workspaces
  const ws = (id: string) => new Workspace(regs.find(w => w.project === id)!)
  return { area, x, cs, ds, ws }
}
type S = Awaited<ReturnType<typeof setup>>
const ref = (run: string): RunRef => { const [, workflow, r] = run.split('/'); return { workflow, run: r } }
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
  s.ds.create(conv, { title: 'Facts first', by: 'Pat', members: ['forge', 'sage'] })
  const brief = (await s.ds.post(conv, { text: 'Find out what the game and the model can do.', author: 'Pat', token: `tok-${conv}-001` })).message
  assert.equal(s.cs.conversation(conv)!.conductor, P, 'the invited facilitator run conducts')
  s.x.db.prepare('UPDATE jobs SET state = \'done\' WHERE workspace = \'ponderer\'').run()
  return brief
}


const jobs = (s: S) => (s.x.db.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number }).n
const counts = (s: S, conv: string) => ({ messages: s.ds.messages(conv).length, invitations: s.ds.invitations(conv).length, jobs: jobs(s), updated: s.cs.conversation(conv)!.updated, state: s.cs.conversation(conv)!.state })

test('citations are [#n] (several in one bracket); a bare #n is text', () => {
  assert.deepEqual(citations('結論 [#12] と [#14 #15]、issue #3 は本文'), [12, 14, 15])
  assert.deepEqual(citations('no sources here'), [])
})

test('a category is set at creation (default discussion) and corrected later with its reason; nothing is sent, invited, started or reopened, and the list order stays', async () => {
  const s = await setup()
  s.ds.create('rd-a', { title: 'Seats (trial 3)', by: 'Pat', members: ['forge'] })
  s.ds.create('rd-b', { title: 'Fixture: two lines', by: 'Pat', category: 'check' })
  assert.throws(() => s.ds.create('rd-c', { title: 'x', by: 'Pat', category: 'trial' }), /discussion or check/)
  assert.equal(s.cs.conversation('rd-a')!.category, 'discussion')
  assert.equal(s.cs.conversation('rd-b')!.category, 'check')
  assert.deepEqual(s.ds.metaRows('rd-b').map(m => [m.field, m.value, m.note]), [['category', 'check', 'at creation']])
  await s.ds.post('rd-a', { text: 'Which seat should the bot take?', author: 'Pat', token: 'tok-rd-a-001' })
  s.ds.close('rd-a', { by: 'Pat' })
  const was = counts(s, 'rd-a')
  const r = s.ds.setMeta('rd-a', { category: 'check', displayTitle: '席の選び方（3回目）', by: 'Omni Agent', note: 'migration map: a check (report1)' })
  assert.deepEqual(r.changed.map(m => [m.field, m.value, m.by, m.note]), [['category', 'check', 'Omni Agent', 'migration map: a check (report1)'], ['displayTitle', '席の選び方（3回目）', 'Omni Agent', 'migration map: a check (report1)']])
  assert.deepEqual(counts(s, 'rd-a'), was, 'no message, invitation, job, reopening or reordering')
  assert.equal(s.cs.conversation('rd-a')!.title, 'Seats (trial 3)', 'the original title stays')
  assert.deepEqual(s.ds.setMeta('rd-a', { category: 'check', by: 'Omni Agent', note: 'again' }).changed, [], 'the same value again records nothing')
  s.ds.setMeta('rd-a', { category: 'discussion', displayTitle: null, by: 'Pat', note: 'it was a real question after all' })
  const v = await s.ds.view('rd-a')
  assert.equal(v.discussion.category, 'discussion')
  assert.equal(v.discussion.displayTitle, null)
  assert.deepEqual(v.meta.map(m => `${m.field}=${m.value}`), ['category=discussion', 'category=check', 'displayTitle=席の選び方（3回目）', 'category=discussion', 'displayTitle=null'])
  assert.throws(() => s.ds.setMeta('rd-a', { by: 'Pat' }), /nothing to change/)
  assert.throws(() => s.ds.setMeta('rd-a', { displayTitle: 'two\nlines', by: 'Pat' }), /one line/)
  s.cs.close(); s.x.close()
})

test('an overview cites what it rests on, covers the speech through one message and is stale (still readable) after newer messages; revisions stay; it starts nothing', async () => {
  const s = await setup()
  s.ds.create('rd-o', { title: 'Where should provenance live?', by: 'Pat', members: ['forge'] })
  assert.equal(s.ds.brief('rd-o'), null, 'no message: no brief either')
  assert.throws(() => s.ds.publishOverview('rd-o', { purpose: 'x [#1]', author: 'Pat' }), /no message to summarise/)
  const m1 = (await s.ds.post('rd-o', { text: 'Where should the provenance of a forge-made asset live?', author: 'Pat', token: 'tok-rd-o-001', to: ['forge'] })).message
  const fr = s.ds.invitations('rd-o')[0].run!
  const m2 = (await s.ds.contribute('rd-o', { text: 'In the delivery record; the shipping repository points to it.', author: 'forge-agent', run: fr, invitation: 1, re: [m1.id] })).message
  assert.deepEqual(s.ds.brief('rd-o'), { message: m1.id, author: 'Pat', participant: 'Pat', text: m1.text }, 'without an overview readers get the brief, labelled')
  const before = counts(s, 'rd-o')
  assert.throws(() => s.ds.publishOverview('rd-o', { purpose: '来歴の置き場所を決める', author: 'Omni Agent' }), /purpose cites no message/)
  assert.throws(() => s.ds.publishOverview('rd-o', { purpose: '来歴 [#1]', outcome: '納品記録が正', author: 'Omni Agent' }), /outcome cites no message/)
  assert.throws(() => s.ds.publishOverview('rd-o', { purpose: '来歴 [#999]', author: 'Omni Agent' }), /#999, which is not a message/)
  assert.throws(() => s.ds.publishOverview('rd-o', { purpose: `来歴 [#${m2.id}]`, through: m1.id, author: 'Omni Agent' }), /newer than the message it covers through/)
  assert.throws(() => s.ds.publishOverview('rd-o', { purpose: `来歴 [#${m1.id}]`, author: 'forge-agent', run: fr }), /facilitator's or the archive project's/)
  const o = s.ds.publishOverview('rd-o', { purpose: `forgeが作る素材の来歴をどこに置くか決める [#${m1.id}]`, outcome: `forgeの納品記録を正とし、配布側はそれを参照する（forgeの提案） [#${m2.id}]`, unresolved: [`衝突時にどちらを直すかは未合意 [#${m2.id}]`], title: '素材の来歴はどこに置くか', note: 'first overview', author: 'Omni Agent (for Developer)' })
  assert.equal(o.overview.through, m2.id)
  assert.deepEqual(o.overview.sources, [m1.id, m2.id])
  assert.equal(o.overview.after, 0)
  assert.equal(o.changed[0].value, '素材の来歴はどこに置くか', 'the display title came with it, recorded')
  assert.deepEqual({ ...counts(s, 'rd-o') }, before, 'an overview is not speech and starts nothing')
  assert.equal(s.ds.publishOverview('rd-o', { purpose: `forgeが作る素材の来歴をどこに置くか決める [#${m1.id}]`, outcome: `forgeの納品記録を正とし、配布側はそれを参照する（forgeの提案） [#${m2.id}]`, unresolved: [`衝突時にどちらを直すかは未合意 [#${m2.id}]`], author: 'Omni Agent (for Developer)', note: 'again' }).duplicate, true)
  for (const [i, t] of ['a', 'b', 'c'].entries()) await s.ds.post('rd-o', { text: `more ${t}`, author: 'Pat', token: `tok-rd-o-1${i}0`, to: ['forge'] })
  assert.equal(s.ds.overview('rd-o')!.after, 3, 'three messages after its horizon: stale, still the current overview')
  const p = s.ds.publishOverview('rd-o', { purpose: `来歴の置き場所 [#${m1.id}]`, author: 'ponderer-agent', run: 'ponderer/conduct/run-001', note: 'revised after more speech' })
  assert.equal(p.overview.after, 0)
  assert.equal(p.overview.outcome, null, 'no outcome is invented')
  const v = await s.ds.view('rd-o')
  assert.equal(v.overview!.id, p.overview.id)
  assert.equal(v.overviews.length, 2, 'the earlier revision stays')
  assert.equal(v.messages.some(m => m.text.includes('来歴')), false)
  s.cs.close(); s.x.close()
})

test('status: awaiting the person only when the question\'s receiver is that person; an agent requester\'s question is its own; failed invitations; a closed room still owes its work', async () => {
  const s = await setup({ participants: ['forge', 'sage', 'ghost'] })
  // The person is the requester: a talk awaits "you".
  const brief = await opened(s, 'rd-s')
  await begin(s, P, 'a1')
  await s.ds.ponder('rd-s', { run: P, attempt: 'a1', ...who, node: 'ponder', decision: 'Ask the requester, probe the ghost.', sources: [brief.id], next: [{ activity: 'talk', node: 'clarify' }, { activity: 'ask', node: 'probe' }, { activity: 'ponder', node: 'then' }] })
  const t = await talk(s, 'rd-s', { run: P, attempt: 'a1', node: 'clarify', question: 'Is one match enough?', to: 'Pat' })
  await s.ds.ask('rd-s', { run: P, attempt: 'a1', ...who, node: 'probe', participants: ['ghost'], question: 'There?', re: [brief.id] })
  await end(s, P, 'a1')
  let st = await s.ds.status('rd-s')
  assert.deepEqual(st.awaiting.map(a => [a.message, a.receiver.kind, a.receiver.id, a.you]), [[t.message!.id, 'person', 'Pat', true]])
  assert.deepEqual(st.failed.map(f => f.participant), ['ghost'])
  assert.equal(st.room, 'open')

  // An agent requester: the same kind of question is not the person's.
  const created = await s.x.request({ workspace: 'ponderer', workflow: 'conduct', text: 'Conduct.', author: 'front-agent', receipt: 'test:conduct:rd', via: 'cli' })
  const run = `ponderer/${created.ref.workflow}/${created.ref.run}`
  s.ds.create('rd-t', { title: 'Agent requester', by: 'front-agent', members: ['forge'], conductor: run, requester: { kind: 'run', run: 'front/converse/run-001', agent: 'front-agent' } })
  s.x.db.prepare('UPDATE jobs SET state = \'done\' WHERE workspace = \'ponderer\'').run()
  await begin(s, run, 'a3')
  await s.ds.ponder('rd-t', { run, attempt: 'a3', ...who, node: 'ponder', decision: 'Open, then ask front.', sources: [], next: [{ activity: 'announce', node: 'open' }, { activity: 'talk', node: 'ask-front' }, { activity: 'ponder', node: 'then' }] })
  const open = await s.ds.announce('rd-t', { run, attempt: 'a3', ...who, node: 'open', text: 'Requested by front/converse/run-001: one line.', re: [] })
  const t2 = await talk(s, 'rd-t', { run, attempt: 'a3', node: 'ask-front', question: 'How detailed?', to: 'front-agent' })
  await end(s, run, 'a3')
  st = await s.ds.status('rd-t')
  assert.deepEqual(st.awaiting.map(a => [a.message, a.receiver.kind, a.receiver.id, a.receiver.agent, a.you]), [[t2.message!.id, 'run', 'front/converse/run-001', 'front-agent', false]], 'never "waiting for you"')
  assert.deepEqual(s.ds.brief('rd-t'), { message: open.message.id, author: 'ponderer-agent', participant: 'ponderer', text: open.message.text }, 'a conductor-opened discussion\'s brief is its opening announcement')

  // A closed room whose invited participant is still working owes it.
  s.ds.create('rd-u', { title: 'Make it', by: 'Pat', members: ['forge'] })
  const fr = (await s.ds.post('rd-u', { text: 'forge, make it.', author: 'Pat', token: 'tok-rd-u-002', to: ['forge'] })).invitations[0].run!
  s.ds.close('rd-u', { by: 'Pat' })
  st = await s.ds.status('rd-u')
  assert.equal(st.room, 'closed')
  assert.ok(st.owed >= 1 && st.working >= 1, JSON.stringify(st))
  void fr
  s.cs.close(); s.x.close()
})

test('the list: one category and state at a time, paged, with every view\'s counts; no row is lost after the twelfth', async () => {
  const s = await setup()
  for (let i = 1; i <= 25; i++) s.ds.create(`rd-old-${String(i).padStart(2, '0')}`, { title: `Old discussion ${i}`, by: 'Pat' })
  for (let i = 1; i <= 3; i++) s.ds.create(`rd-chk-${i}`, { title: `Check ${i}`, by: 'Pat', category: 'check' })
  for (let i = 1; i <= 20; i++) s.ds.close(`rd-old-${String(i).padStart(2, '0')}`, { by: 'Pat' })
  const first = await s.ds.listing({ category: 'discussion', state: 'all', limit: 20 })
  assert.deepEqual(first.counts, { discussion: { open: 5, closed: 20 }, check: { open: 3, closed: 0 } })
  assert.equal(first.total, 25)
  assert.equal(first.discussions.length, 20)
  const rest = await s.ds.listing({ category: 'discussion', state: 'all', limit: 20, offset: 20 })
  assert.equal(rest.discussions.length, 5)
  assert.equal(new Set([...first.discussions, ...rest.discussions].map(d => d.id)).size, 25, 'every discussion is reachable')
  assert.equal((await s.ds.listing({ category: 'check' })).discussions.every(d => d.category === 'check'), true)
  assert.equal((await s.ds.listing({ category: 'discussion', state: 'open' })).total, 5)
  const row = first.discussions[0]
  assert.deepEqual(Object.keys(row.status).sort(), ['awaiting', 'failed', 'held', 'owed', 'room', 'working'])
  assert.equal(row.overview, null)
  await assert.rejects(s.ds.listing({ category: 'trial' }), /discussion or check/)
  await assert.rejects(s.ds.listing({ state: 'half' }), /open, closed or all/)
  s.cs.close(); s.x.close()
})

test('the archive exports metadata and overview records with their own horizons; the manifest carries the category, display title and current overview; a replay adds nothing', async () => {
  const s = await setup()
  s.ds.create('rd-x', { title: 'Archive me', by: 'Pat', category: 'check' })
  const m1 = (await s.ds.post('rd-x', { text: 'A check of the archive.', author: 'Pat', token: 'tok-rd-x-001', to: ['forge'] })).message
  const arch = new DiscussionArchive(s.ds)
  assert.deepEqual((await arch.publish(['rd-x'])).failed, [])
  s.ds.setMeta('rd-x', { displayTitle: 'アーカイブの確認', by: 'Pat', note: 'readable title' })
  assert.ok(arch.due().includes('rd-x'), 'a metadata change makes it due')
  assert.equal((await arch.status('rd-x')).state, 'behind')
  s.ds.publishOverview('rd-x', { purpose: `アーカイブの確認 [#${m1.id}]`, author: 'Pat', note: 'first' })
  assert.deepEqual((await arch.publish(['rd-x'])).failed, [])
  const lines = (await readFile(join(arch.dir, 'discussions', 'rd-x', 'transcript.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l) as { type: string; field?: string; value?: string; sources?: number[]; through?: number })
  assert.deepEqual(lines.filter(l => l.type === 'meta').map(l => `${l.field}=${l.value}`), ['category=check', 'displayTitle=アーカイブの確認'])
  const ov = lines.filter(l => l.type === 'overview')
  assert.equal(ov.length, 1)
  assert.deepEqual([ov[0].sources, ov[0].through], [[m1.id], m1.id])
  const man = JSON.parse(await readFile(join(arch.dir, 'discussions', 'rd-x', 'manifest.json'), 'utf8')) as { category: string; displayTitle: string; overview: { purpose: string; after?: number }; horizon: { meta: number; overview: number } }
  assert.equal(man.category, 'check')
  assert.equal(man.displayTitle, 'アーカイブの確認')
  assert.equal(man.overview.purpose, `アーカイブの確認 [#${m1.id}]`)
  assert.equal('after' in man.overview, false, 'the live staleness count is not frozen into the record')
  assert.ok(man.horizon.meta >= 2 && man.horizon.overview === 1)
  assert.equal((await arch.status('rd-x')).state, 'current')
  assert.deepEqual((await arch.publish(['rd-x'])).published, [], 'a replay publishes nothing twice')
  s.cs.close(); s.x.close()
})

test('store v9: a v8 store\'s discussions become `discussion` explicitly; categories, titles and overviews persist across a restart and a reopening', async () => {
  const s = await setup()
  s.ds.create('rd-m', { title: 'Before v9', by: 'Pat' })
  const m1 = (await s.ds.post('rd-m', { text: 'What did v8 know?', author: 'Pat', token: 'tok-rd-m-001', to: ['forge'] })).message
  // The same store as v8 had it: no category, no title, no meta, no overviews.
  s.cs.db.exec('DROP TABLE attachments; DROP TABLE workflow_refs; DROP TABLE workflow_ref_events; DROP TABLE workflow_snapshots; DROP TABLE workflow_meta; ALTER TABLE conversations DROP COLUMN category; ALTER TABLE conversations DROP COLUMN display_title; DROP TABLE discussion_meta; DROP TABLE overviews; PRAGMA user_version = 8')
  s.cs.close()
  const cs = new ConversationStore({ area: s.area, exec: s.x })
  const ds = new DiscussionStore(cs)
  assert.equal(cs.conversation('rd-m')!.category, 'discussion', 'migrated explicitly')
  assert.deepEqual(ds.metaRows('rd-m'), [], 'the migration writes no history: classification is a recorded act')
  ds.setMeta('rd-m', { category: 'check', displayTitle: 'v8の確認', by: 'Omni Agent', note: 'migration map' })
  ds.publishOverview('rd-m', { purpose: `v8の記録を確かめる [#${m1.id}]`, author: 'Omni Agent', note: 'first' })
  ds.close('rd-m', { by: 'Pat' })
  cs.close()
  const cs2 = new ConversationStore({ area: s.area, exec: s.x })
  const ds2 = new DiscussionStore(cs2)
  ds2.reopen('rd-m', { by: 'Pat' })
  const v = await ds2.view('rd-m')
  assert.deepEqual([v.discussion.state, v.discussion.category, v.discussion.displayTitle, v.overview?.purpose], ['open', 'check', 'v8の確認', `v8の記録を確かめる [#${m1.id}]`])
  cs2.close(); s.x.close()
})
