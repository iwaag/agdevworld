// argue p5 (docs/dialogue.md): character dialogue, the short reading view.
// A line is keyed by everything it depends on (renderer, model, the
// speaker's voice, the original target and context), so the same inputs are
// rendered once and a changed source, context or character is a new line,
// never an old one passed off as current. Reads queue a bounded window and
// call no model; the worker renders, retries, fails visibly and recovers a
// stopped worker's lease without a second result. The lines live in the
// archive workspace's ignored .local/character-dialogue/ and reach no
// discussion read, archive publication or run copy.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../server/conversations.ts'
import { createProject } from '../server/create.ts'
import { DialogueStore, DialogueWorker, DIALOGUE_DIR, type DialogueConfig } from '../server/dialogue.ts'
import { DiscussionArchive } from '../server/discussionArchive.ts'
import { DiscussionStore } from '../server/discussions.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { prepareCopy } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-dialogue-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

// A stand-in renderer: its voice for forge is read from voice.txt (a
// character change), it fails for a message listed in fail.txt, and it says
// what it was given so the test can see the inputs.
const RENDERER = `import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
const here = dirname(new URL(import.meta.url).pathname)
const voice = () => existsSync(join(here, 'voice.txt')) ? readFileSync(join(here, 'voice.txt'), 'utf8').trim() : 'v1'
const cmd = process.argv[2]
if (cmd === 'describe') console.log(JSON.stringify({ schema: 'ag.dialogue-renderer.v1', renderer: 'fake-1', profile: { model: 'fake' }, characters: { commit: 'c0ffee' }, languages: ['ja', 'en'], participants: { forge: { character: 'forge', voice: voice() } }, neutral: 'n1' }))
else {
  let s = ''; for await (const c of process.stdin) s += c
  const r = JSON.parse(s)
  appendFileSync(join(here, 'calls.log'), r.target.id + '\\n')
  const fail = existsSync(join(here, 'fail.txt')) ? readFileSync(join(here, 'fail.txt'), 'utf8').split(/\\s+/) : []
  if (fail.includes(String(r.target.id))) { console.error('render: the model call failed: overloaded'); process.exit(1) }
  const p = r.target.participant
  console.log(JSON.stringify({ schema: 'ag.dialogue-result.v1', renderer: 'fake-1', voice: p === 'forge' ? voice() : 'n1', character: p === 'forge' ? 'forge' : null, language: r.language,
    text: '[' + r.language + '] ' + r.target.text.slice(0, 12) + ' ctx=' + r.context.map(c => c.id).join(','), usage: { model: 'fake', costUsd: 0 } }))
}
`

let k = 0
async function setup(o: { window?: number; ignore?: boolean } = {}) {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-ponderer')
  const r = await createProject({ dir, id: 'ponderer', name: 'ponderer', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'conduct.yaml'), `schema: ag.workflow.v2
id: conduct
name: conduct
intent: |
  Conduct.
documentation: {policy: custom, plan: false, reports: false, final: false}
execution: {agent: ponderer-agent}
repositories:
  root: {path: ., access: editable}
nodes:
  talk: {type: talk, description: Talk.}
`)
  if (o.ignore === false) await writeFile(join(dir, '.gitignore'), '# nothing ignored\n')
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const bare = join(area, 'ponderer-origin.git')
  await gitOk(area, ['init', '-q', '--bare', '-b', 'main', bare])
  await gitOk(dir, ['remote', 'add', 'origin', bare])
  await gitOk(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
  await writeFile(join(area, 'conversations.json'), JSON.stringify({ person: 'Pat', targets: [], discussions: { facilitator: { workspace: 'ponderer', workflow: 'conduct' }, participants: [{ workspace: 'forge', workflow: 'discuss' }], archive: { workspace: 'ponderer' } } }))
  const rdir = join(area, 'renderer')
  await gitOk(area, ['init', '-q', rdir])
  await writeFile(join(rdir, 'render.ts'), RENDERER)
  const config: DialogueConfig = { renderer: join(rdir, 'render.ts'), languages: ['ja', 'en'], follow: ['ja'], concurrency: 2, window: o.window ?? 40, tries: 2, env: {} }
  const x = new ExecStore({ registryFile: registry, area })
  const cs = new ConversationStore({ area, exec: x })
  const ds = new DiscussionStore(cs)
  const dl = new DialogueStore(ds, { config, backoffMs: 1 })
  const close = () => { dl.close(); cs.close(); x.close() }
  return { area, dir, rdir, registry, x, cs, ds, dl, close }
}
type S = Awaited<ReturnType<typeof setup>>

// A discussion of the person and forge: the person asks, forge answers at length.
let seq = 0
function speak(s: S, conv: string, role: 'person' | 'agent', text: string, re: number[] = []): number {
  const at = new Date(Date.UTC(2026, 9, 21, 0, 0, ++seq)).toISOString()
  const r = s.cs.db.prepare(`INSERT INTO messages (conv, role, author, text, at, re, kind, participant, run) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conv, role, role === 'person' ? 'Pat' : 'forge-agent', text, at, JSON.stringify(re), role === 'person' ? 'message' : 'reply', role === 'person' ? 'Pat' : 'forge', role === 'agent' ? 'forge/discuss/run-001' : null)
  return Number(r.lastInsertRowid)
}
function discussion(s: S, id: string) {
  s.ds.create(id, { title: `About ${id}`, by: 'Pat', members: [] })
  s.cs.db.prepare("INSERT INTO membership (conv, participant, kind, workspace, workflow, action, by, at, note) VALUES (?, 'forge', 'project', 'forge', 'discuss', 'join', 'Pat', ?, '')").run(id, new Date().toISOString())
}
const work = (s: S) => new DialogueWorker(s.dl, () => {}).drain(30_000)
const calls = async (s: S) => (await readFile(join(s.rdir, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number)

test('lines are kept in the archive workspace\'s ignored .local/, and refused where Git would commit them', async () => {
  const s = await setup()
  assert.equal(await s.dl.dir(), join(await realpath(s.dir), DIALOGUE_DIR))
  s.close()
  const t = await setup({ ignore: false })
  discussion(t, 'd-unignored')
  speak(t, 'd-unignored', 'agent', 'hello')
  const r = await t.dl.read('d-unignored', 'ja', { queue: true })
  assert.equal(r.available, false)
  assert.match(r.problem!, /not ignored by Git/)
  assert.deepEqual(r.items.map(i => i.state), ['unrequested'], 'the original stays readable')
  t.close()
})

test('a read queues the missing lines once, calls no model, and the worker renders each for its own message; the person stays original', async () => {
  const s = await setup()
  discussion(s, 'd1')
  const q = speak(s, 'd1', 'person', 'What should the meeting room show?')
  const a = speak(s, 'd1', 'agent', 'One table with a record, and seats per participant.', [q])
  const b = speak(s, 'd1', 'agent', 'I cannot verify the provenance yet.')
  const first = await s.dl.read('d1', 'ja')
  assert.deepEqual(first.items.map(i => [i.message, i.state]), [[q, 'original'], [a, 'pending'], [b, 'pending']])
  assert.equal(first.queued, 2)
  const again = await s.dl.read('d1', 'ja')
  assert.equal(again.queued, 0, 'reading again queues nothing more')
  assert.deepEqual(await calls(s), [], 'reads never call the renderer')
  await work(s)
  const ready = await s.dl.read('d1', 'ja')
  assert.deepEqual(ready.items.map(i => i.state), ['original', 'ready', 'ready'])
  assert.equal(ready.items[1]!.text, `[ja] One table wi ctx=${q}`)
  assert.equal(ready.items[1]!.character, 'forge')
  assert.equal(ready.items[2]!.text, `[ja] I cannot ver ctx=${q},${a}`)
  assert.deepEqual((await calls(s)).sort(), [a, b].sort(), 'one render per line')
  await s.dl.read('d1', 'ja'); await work(s)
  assert.equal((await calls(s)).length, 2, 'ready lines are never rendered again by reading')
  const en = await s.dl.read('d1', 'en')
  assert.deepEqual(en.items.map(i => i.state), ['original', 'pending', 'pending'], 'another language is another line')
  s.close()
})

test('the context is the replied-to and the few earlier originals only: nothing later, never a rendering, long text cut', async () => {
  const s = await setup()
  discussion(s, 'd2')
  const ids = [speak(s, 'd2', 'person', 'x'.repeat(4000))]
  for (let i = 0; i < 6; i++) ids.push(speak(s, 'd2', 'agent', `turn ${i}`))
  const later = speak(s, 'd2', 'agent', 'a later message that must not be known')
  const { request, horizon } = await s.dl.request('d2', ids[6]!, 'ja')
  assert.deepEqual(request.context.map(c => c.id), ids.slice(2, 6), 'the four before it')
  assert.equal(horizon, ids[6])
  assert.ok(!JSON.stringify(request).includes('later message'))
  const withRe = await s.dl.request('d2', ids[6]!, 'ja', s.ds.messages('d2').map(m => m.id === ids[6] ? { ...m, re: JSON.stringify([ids[0], later]) } : m))
  assert.deepEqual(withRe.request.context.map(c => c.id), [ids[0]!, ...ids.slice(2, 6)], 'an earlier replied-to message is added; a later one never')
  assert.equal(withRe.request.context[0]!.text.length, 1500)
  assert.equal(withRe.request.context[0]!.truncated, true)
  assert.equal(withRe.request.participants.Pat!.kind, 'person')
  s.close()
})

test('a changed character or source is a new line: the old one is kept but not shown as current', async () => {
  const s = await setup()
  discussion(s, 'd3')
  const a = speak(s, 'd3', 'agent', 'Version one of the answer.')
  await s.dl.read('d3', 'ja'); await work(s)
  assert.equal((await s.dl.read('d3', 'ja')).items[0]!.state, 'ready')
  await writeFile(join(s.rdir, 'voice.txt'), 'v2') // forge's character changed
  await s.dl.describe(true)
  const changed = await s.dl.read('d3', 'ja', { queue: false })
  assert.deepEqual([changed.items[0]!.state, changed.items[0]!.stale, changed.items[0]!.text], ['unrequested', true, undefined], 'the old line is not passed off as current')
  await s.dl.read('d3', 'ja'); await work(s)
  assert.equal((await s.dl.read('d3', 'ja')).items[0]!.state, 'ready')
  assert.equal((await s.dl.history('d3', a, 'ja')).length, 2, 'the older rendering stays as local data')
  s.cs.db.prepare('UPDATE messages SET text = ? WHERE id = ?').run('Edited answer.', a) // a source change (WFE never edits speech; the key still covers it)
  assert.equal((await s.dl.read('d3', 'ja', { queue: false })).items[0]!.state, 'unrequested')
  s.close()
})

test('a failing line is retried, then failed with its reason, and the original stays; retry queues it again', async () => {
  const s = await setup()
  discussion(s, 'd4')
  const a = speak(s, 'd4', 'agent', 'This one fails.')
  await writeFile(join(s.rdir, 'fail.txt'), String(a))
  await s.dl.read('d4', 'ja'); await work(s)
  const f = (await s.dl.read('d4', 'ja')).items[0]!
  assert.deepEqual([f.state, f.tries], ['failed', 2])
  assert.match(f.error!, /overloaded/)
  assert.deepEqual((await s.dl.read('d4', 'ja')).queued, 0, 'a failed line is not queued again by reading')
  await rm(join(s.rdir, 'fail.txt'))
  assert.equal((await s.dl.retry('d4', a, 'ja', 'Pat')).state, 'queued')
  assert.equal((await s.dl.retry('d4', a, 'ja', 'Pat')).state, 'unchanged', 'a second retry while queued does nothing')
  await work(s)
  assert.equal((await s.dl.read('d4', 'ja')).items[0]!.state, 'ready')
  assert.match((await s.dl.retry('d4', a, 'ja', 'Pat')).reason, /rendering again/)
  assert.equal((await s.dl.read('d4', 'ja')).items[0]!.state, 'ready', 'the current line stays while it is rendered again')
  await work(s)
  assert.equal((await s.dl.history('d4', a, 'ja')).length, 2)
  await assert.rejects(s.dl.retry('d4', speak(s, 'd4', 'person', 'mine'), 'ja', 'Pat'), /always shown as written/)
  s.close()
})

test('a stopped worker\'s lease returns to the queue, at once when its process is gone; a job is completed once, by its holder, with one result', async () => {
  const s = await setup()
  discussion(s, 'd5')
  const a = speak(s, 'd5', 'agent', 'Interrupted line.')
  await s.dl.read('d5', 'ja')
  const job = (await s.dl.claim())!
  assert.equal(job.state, 'running')
  assert.equal(await s.dl.claim(), null, 'a running job is not claimed twice')
  const db = await s.dl.db()
  db.prepare('UPDATE jobs SET lease_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), job.id) // the worker died
  assert.equal(await s.dl.reclaim(), 1)
  const again = (await s.dl.claim())!
  assert.equal(again.id, job.id)
  assert.equal(await s.dl.perform(again), 'done')
  assert.equal(await s.dl.perform(again), 'dropped', 'a late second completion of the same job writes nothing')
  assert.equal((await s.dl.history('d5', a, 'ja')).length, 1)
  // A worker process that died holding a job: taken back at once, not after the lease;
  // and the dead holder's late completion (say it was only frozen) writes nothing.
  const b = speak(s, 'd5', 'agent', 'Held by a dead process.')
  await s.dl.read('d5', 'ja')
  const held = (await s.dl.claim())!
  db.prepare('UPDATE jobs SET owner = ? WHERE id = ?').run(`${hostname()}:999999:x`, held.id)
  assert.equal(await s.dl.reclaim(), 1, 'its process is gone: back to the queue at once')
  const taken = (await s.dl.claim())!
  assert.equal(taken.id, held.id)
  assert.equal(await s.dl.perform({ ...held, owner: `${hostname()}:999999:x` }), 'dropped', 'the old holder cannot complete it')
  assert.equal(await s.dl.perform(taken), 'done')
  assert.equal((await s.dl.history('d5', b, 'ja')).length, 1, 'one result')
  s.close()
})

test('the worker follows new agent speech from its first start only', async () => {
  const s = await setup()
  discussion(s, 'd6')
  const old = speak(s, 'd6', 'agent', 'Before the worker started.')
  assert.equal(await s.dl.follow(), 0, 'the first call only sets the checkpoint')
  const fresh = speak(s, 'd6', 'agent', 'After it started.')
  speak(s, 'd6', 'person', 'A person line is never rendered.')
  assert.equal(await s.dl.follow(), 1)
  await new DialogueWorker(s.dl, () => {}).drain(30_000)
  assert.deepEqual(await calls(s), [fresh])
  const r = await s.dl.read('d6', 'ja', { queue: false })
  assert.deepEqual(r.items.filter(i => i.message === old || i.message === fresh).map(i => i.state), ['unrequested', 'ready'])
  s.close()
})

test('the boundary: discussion views, the archive and run copies carry no line', async () => {
  const s = await setup()
  discussion(s, 'd7')
  speak(s, 'd7', 'agent', 'Original speech only.')
  await s.dl.read('d7', 'ja'); await work(s)
  const line = (await s.dl.read('d7', 'ja')).items[0]!.text!
  assert.ok(line)
  const view = JSON.stringify(await s.ds.view('d7', {}))
  assert.ok(!view.includes(line) && !view.includes('ctx='), 'the discussion view has no rendering')
  const pub = await new DiscussionArchive(s.ds).publish(['d7'])
  assert.deepEqual(pub.failed, [])
  const archive = join(s.area, '.local', 'discussions', 'archive', 'discussions', 'd7')
  for (const f of await readdir(archive)) assert.ok(!(await readFile(join(archive, f), 'utf8')).includes('ctx='), `${f} has no rendering`)
  const ws = new Workspace((await loadRegistry(s.registry)).workspaces.find(w => w.id === 'ponderer')!)
  const { copy } = await prepareCopy(ws, { project: 'ponderer', workflow: 'conduct', receipt: 'boundary' })
  await assert.rejects(stat(join(copy.tree, DIALOGUE_DIR)), 'a run copy of the archive project does not get the dialogue folder')
  assert.equal((await gitOk(s.dir, ['status', '--porcelain', '--untracked-files=all'])).trim(), '', 'the archive workspace stays clean: the folder is ignored')
  s.close()
})
