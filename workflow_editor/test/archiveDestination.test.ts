// argue p4 ex1 (docs/discussions.md *Archive*, *Destination*): the archive
// project changes from argue to ponderer. A publication record names the
// repository it was verified in; one of another destination is `unverified`
// and due, never shown as current under the new repository; the writer's
// clone is rebuilt from the new destination; an imported history is adopted
// without appending anything twice; an empty destination receives the whole
// record; interruption, replay and another writer's integration lose and
// duplicate nothing; unchanged records stay byte for byte; old commit ids
// resolve in the new repository.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../server/conversations.ts'
import { createProject } from '../server/create.ts'
import { ConversationArchive, destinationOf } from '../server/conversationArchive.ts'
import { ConversationService } from '../server/conversationService.ts'
import { ExecStore } from '../server/exec.ts'
import { git, gitOk } from '../server/git.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-archive-dest-'))
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
async function setup() {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  for (const [id, wf] of [['argue', 'facilitate'], ['ponderer', 'conduct'], ['forge', 'discuss']] as const) {
    const dir = join(area, `pj-${id}`)
    const r = await createProject({ dir, id, name: id, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
    assert.ok(r.ok, r.message)
    await writeFile(join(dir, 'devdocs', 'workflows', `${wf}.yaml`), WF(wf, `${id}-agent`))
    await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  }
  const origins: Record<string, string> = {}
  for (const id of ['argue', 'ponderer']) {
    const bare = join(area, `${id}-origin.git`)
    await gitOk(area, ['init', '-q', '--bare', '-b', 'main', bare])
    await gitOk(join(area, `pj-${id}`), ['remote', 'remove', 'origin']).catch(() => '')
    await gitOk(join(area, `pj-${id}`), ['remote', 'add', 'origin', bare])
    await gitOk(join(area, `pj-${id}`), ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
    origins[id] = bare
  }
  const configure = (facilitator: string, workflow: string, archive: string) => writeFile(join(area, 'conversations.json'), JSON.stringify({
    person: 'Pat', targets: [],
    discussions: { facilitator: { workspace: facilitator, workflow }, participants: [{ workspace: 'forge', workflow: 'discuss' }], archive: { workspace: archive } },
  }))
  await configure('argue', 'facilitate', 'argue')
  const x = new ExecStore({ registryFile: registry, area })
  const cs = new ConversationStore({ area, exec: x })
  const ds = new ConversationService(cs)
  const close = () => { cs.close(); x.close() }
  return { area, origins, configure, x, cs, ds, close }
}
type S = Awaited<ReturnType<typeof setup>>

// Two discussions in argue's archive: one closed, one open.
async function history(s: S) {
  const a = new ConversationArchive(s.ds)
  s.ds.create('d-closed', { facilitate: true, title: 'Closed one', by: 'Pat', members: ['forge'] })
  s.ds.create('d-open', { facilitate: true, title: 'Open one', by: 'Pat', members: ['forge'] })
  // Discussions from before challenge p2: their archive stays at discussions/<id>.
  for (const id of ['d-closed', 'd-open']) s.cs.db.prepare('UPDATE conversations SET kind = \'discussion\' WHERE id = ?').run(id)
  await s.ds.post('d-closed', { text: 'First words.', author: 'Pat', token: 'tok-dest-c001', to: ['forge'] })
  await s.ds.post('d-open', { text: 'Other words.', author: 'Pat', token: 'tok-dest-o001', to: ['forge'] })
  s.ds.close('d-closed', { by: 'Pat' })
  const r = await a.publish()
  assert.deepEqual(r.failed, [])
  return a
}

// pj-ponderer takes argue's history without rewriting it (as argue p4 ex1).
async function importHistory(s: S) {
  const imp = join(s.area, `import-${++k}`)
  await gitOk(s.area, ['clone', '-q', s.origins.ponderer, imp])
  await gitOk(imp, ['fetch', '-q', s.origins.argue, '+refs/heads/main:refs/remotes/argue/main'])
  await gitOk(imp, ['merge', '-q', '-s', 'ours', '--no-commit', '--allow-unrelated-histories', 'argue/main'])
  await gitOk(imp, ['checkout', 'argue/main', '--', 'discussions'])
  await gitOk(imp, ['commit', '-q', '-m', 'Import argue history'])
  await gitOk(imp, ['push', '-q', 'origin', 'HEAD:main'])
  return imp
}

const tree = async (bare: string, path: string) => (await git(bare, ['show', `main:${path}`])).stdout
const writerOrigin = async (a: ConversationArchive) => destinationOf((await gitOk(a.dir, ['remote', 'get-url', 'origin'])).trim())

test('a switch to an imported history: unverified until read there, then current with the new repository\'s commit; nothing appended twice; the writer\'s clone rebuilt', async () => {
  const s = await setup()
  const a = await history(s)
  const before = await a.status('d-closed')
  assert.equal(before.state, 'current')
  assert.equal(before.published!.destination, destinationOf(s.origins.argue))
  const argueCommit = before.published!.commit
  const closedTranscript = await tree(s.origins.argue, 'discussions/d-closed/transcript.jsonl')

  await importHistory(s)
  await s.configure('ponderer', 'conduct', 'ponderer')
  // Nothing is assumed about the new repository.
  const un = await a.status('d-closed')
  assert.equal(un.state, 'unverified', 'a commit of argue is not current in ponderer')
  assert.equal(un.published!.destination, destinationOf(s.origins.argue), 'the record still names where it was verified')
  assert.match(un.error!, /not yet verified in/)
  assert.equal(un.repository, s.origins.ponderer)
  assert.deepEqual(a.due(Date.now(), destinationOf(s.origins.ponderer)).sort(), ['d-closed', 'd-open'])

  const r = await a.publish()
  assert.deepEqual(r.published, [], 'the imported horizon covers everything: nothing is appended')
  assert.deepEqual(r.unchanged.sort(), ['d-closed', 'd-open'])
  assert.equal(await writerOrigin(a), destinationOf(s.origins.ponderer), 'the clone is ponderer\'s now')
  for (const id of ['d-closed', 'd-open']) {
    const st = await a.status(id)
    assert.equal(st.state, 'current', id)
    assert.equal(st.published!.destination, destinationOf(s.origins.ponderer))
    assert.equal((await git(s.origins.ponderer, ['cat-file', '-t', st.published!.commit])).stdout.trim(), 'commit', 'the recorded commit is in the new repository')
  }
  // An old citation resolves in the new repository, and the record is unchanged.
  assert.equal((await git(s.origins.ponderer, ['cat-file', '-t', argueCommit])).stdout.trim(), 'commit')
  assert.equal(await tree(s.origins.ponderer, 'discussions/d-closed/transcript.jsonl'), closedTranscript)

  // The open discussion continues; only the new record lands, in ponderer.
  const argueMain = (await gitOk(s.origins.argue, ['rev-parse', 'main'])).trim()
  const m = (await s.ds.post('d-open', { text: 'Later words.', author: 'Pat', token: 'tok-dest-o002', to: ['forge'] })).message
  assert.equal((await a.status('d-open')).state, 'behind')
  const r2 = await a.publish()
  assert.deepEqual(r2.published.map(p => p.conv), ['d-open'])
  const lines = (await tree(s.origins.ponderer, 'discussions/d-open/transcript.jsonl')).trim().split('\n').map(l => JSON.parse(l) as { type: string; id: number })
  assert.deepEqual(lines.filter(l => l.type === 'message').map(l => l.id), s.ds.messages('d-open').map(x => x.id))
  assert.ok(lines.some(l => l.type === 'message' && l.id === m.id))
  assert.equal(new Set(lines.map(l => `${l.type}:${l.id}`)).size, lines.length, 'no duplicate record')
  assert.equal((await gitOk(s.origins.argue, ['rev-parse', 'main'])).trim(), argueMain, 'the old repository receives nothing')
  assert.equal(await tree(s.origins.ponderer, 'discussions/d-closed/transcript.jsonl'), closedTranscript, 'the closed record is unchanged')
  s.close()
})

test('a switch to an empty destination: the whole record is exported there once; interruption and replay add nothing; another writer\'s integration is kept', async () => {
  const s = await setup()
  const a = await history(s)
  await s.configure('ponderer', 'conduct', 'ponderer')
  // The push lands and the process dies before its bookkeeping.
  const r1 = await a.publish(undefined, { afterPush: async () => { throw new Error('killed after push') } })
  assert.match(r1.failed[0].error, /killed/)
  assert.equal((await a.status('d-open')).state, 'failed')
  // Replay: the repository is the truth; nothing is appended again.
  const r2 = await a.publish(['d-closed', 'd-open'])
  assert.deepEqual(r2.published, [])
  assert.deepEqual(r2.unchanged.sort(), ['d-closed', 'd-open'])
  for (const id of ['d-closed', 'd-open']) {
    const st = await a.status(id)
    assert.equal(st.state, 'current')
    assert.equal(st.published!.destination, destinationOf(s.origins.ponderer))
    const lines = (await tree(s.origins.ponderer, `discussions/${id}/transcript.jsonl`)).trim().split('\n').map(l => JSON.parse(l) as { type: string; id: number })
    assert.deepEqual(lines.filter(l => l.type === 'message').map(l => l.id), s.ds.messages(id).map(x => x.id), `${id}: every message once`)
    assert.equal(new Set(lines.map(l => `${l.type}:${l.id}`)).size, lines.length)
  }
  assert.equal(JSON.parse(await tree(s.origins.ponderer, 'discussions/d-closed/manifest.json')).state, 'closed')
  // A synthesize run of ponderer integrates a summary meanwhile.
  const other = join(s.area, 'other')
  await gitOk(s.area, ['clone', '-q', s.origins.ponderer, other])
  await writeFile(join(other, 'discussions', 'd-open', 'summary.md'), '# summary\n')
  await gitOk(other, ['add', '-A']); await gitOk(other, ['commit', '-q', '-m', 'summary']); await gitOk(other, ['push', '-q', 'origin', 'HEAD:main'])
  await s.ds.post('d-open', { text: 'After the summary.', author: 'Pat', token: 'tok-dest-o003', to: ['forge'] })
  assert.equal((await a.publish()).published.length, 1)
  assert.equal(await tree(s.origins.ponderer, 'discussions/d-open/summary.md'), '# summary\n', 'the other writer\'s work is kept')
  s.close()
})

test('a writer clone left pointing at the old repository is rebuilt, not reused; a record written before v8 is unverified until read', async () => {
  const s = await setup()
  const a = await history(s)
  // A record without a destination (as every row written before store v8).
  s.ds.db.prepare('UPDATE archives SET destination = NULL').run()
  const old = await a.status('d-open')
  assert.equal(old.state, 'unverified')
  assert.equal(old.published!.url, null, 'no link is made up for a repository not recorded')
  assert.match(old.error!, /not recorded/)
  // Same configured repository: the next export verifies it there.
  await a.publish()
  assert.equal((await a.status('d-open')).state, 'current')
  // A leftover file in the old clone must not travel to the new destination.
  await writeFile(join(a.dir, 'stray.txt'), 'old clone state\n')
  await importHistory(s)
  await s.configure('ponderer', 'conduct', 'ponderer')
  await a.publish()
  assert.equal(await writerOrigin(a), destinationOf(s.origins.ponderer))
  assert.equal((await git(s.origins.ponderer, ['show', 'main:stray.txt'])).code === 0, false)
  assert.equal((await a.status('d-open')).state, 'current')
  s.close()
})

test('destinationOf: credentials, .git and a final slash do not make another repository', () => {
  assert.equal(destinationOf('http://user:tok@host:3000/developer/pj-ponderer.git'), 'http://host:3000/developer/pj-ponderer')
  assert.equal(destinationOf('http://host:3000/developer/pj-ponderer/'), 'http://host:3000/developer/pj-ponderer')
  assert.notEqual(destinationOf('http://host:3000/developer/pj-argue.git'), destinationOf('http://host:3000/developer/pj-ponderer.git'))
})

test('a retired (unregistered) project\'s speech keeps its run names but gets no run-view link; the discussion stays readable', async () => {
  const s = await setup()
  await history(s)
  s.ds.create('d-old', { facilitate: true, title: 'Old', by: 'Pat', members: ['forge'] })
  s.cs.db.prepare('UPDATE conversations SET kind = \'discussion\' WHERE id = ?').run('d-old')
  const a = await s.ds.post('d-old', { text: 'Words for the facilitator.', author: 'Pat', token: 'tok-dest-r001' })
  const fr = a.invitations[0].run!
  assert.equal(fr, 'argue/facilitate/run-001')
  await s.ds.contribute('d-old', { text: 'The old facilitator speaks.', author: 'argue-agent', run: fr, invitation: a.invitations[0].id, re: [a.message.id] })
  const before = await s.ds.view('d-old', { viewBase: 'http://h/wfe/' })
  assert.match(before.messages.at(-1)!.runUrl!, /#\/ws\/argue\/run\/facilitate\/run-001$/)
  // As `wfe project unregister argue` leaves it: no workspace of argue.
  const regFile = join(s.area, 'registry.json')
  const reg = JSON.parse(await readFile(regFile, 'utf8')) as { workspaces: { id: string }[] }
  await writeFile(regFile, JSON.stringify({ ...reg, workspaces: reg.workspaces.filter(w => w.id !== 'argue') }))
  await s.configure('ponderer', 'conduct', 'ponderer')
  const v = await s.ds.view('d-old', { viewBase: 'http://h/wfe/' })
  const m = v.messages.at(-1)!
  assert.equal(m.run, fr, 'the run identity is kept')
  assert.equal(m.participant, 'argue', 'and so is the participant')
  assert.equal(m.runUrl, null, 'no link to a run view that opens nothing')
  assert.equal(v.requests[0].runUrl, null)
  const r = v.runs.find(x => x.key === fr)!
  assert.equal(r.url, null)
  assert.match(r.problem!, /not registered here \(a retired or unknown project\)/)
  // The conductor is ponderer now: an untargeted message goes there, not to argue.
  const b = await s.ds.post('d-old', { text: 'Who conducts now?', author: 'Pat', token: 'tok-dest-r002' })
  assert.deepEqual(b.invitations.map(i => [i.participant, i.run]), [['ponderer', 'ponderer/conduct/run-001']])
  s.close()
})
