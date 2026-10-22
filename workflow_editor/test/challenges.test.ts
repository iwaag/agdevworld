// Challenges (challenge p1, docs/challenges.md): durable records in one Git
// repository, written through a journal. Concurrent edits conflict without
// losing either draft; a repeated request is one record and one commit; a
// failed push and a crash after a successful push recover with the right
// publication state; the index is rebuilt from a fresh clone with records
// and history; a pinned read still returns the original after later edits.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChallengeStore, parseRecord, renderRecord } from '../server/challenges.ts'
import { gitOk } from '../server/git.ts'
import { RequestError } from '../server/workspace.ts'

let root = ''
let remote = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-challenges-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
  remote = join(root, 'remote.git')
  await gitOk(root, ['init', '-q', '--bare', '-b', 'main', remote])
  await writeFile(join(root, 'challenges.json'), JSON.stringify({ repository: remote }))
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const actor = { by: 'front-agent', via: 'cli', run: 'front/converse/run-055', onBehalfOf: 'iwaag' }
const store = (dir: string, hooks?: ConstructorParameters<typeof ChallengeStore>[0]['hooks']) => new ChallengeStore({ area: root, dir: join(root, dir), hooks })
const commits = async () => Number((await gitOk(remote, ['rev-list', '--count', 'main'])).trim())
const refused = async (p: Promise<unknown>, code: string) => { await assert.rejects(p, (e: unknown) => e instanceof RequestError && (e.detail as { code?: string })?.code === code) }

test('the file format keeps four fields and the body; other frontmatter survives', () => {
  const text = renderRecord('ch-0001', { title: 'Edges', state: 'open', projects: ['gimmickimg'], body: '# Free\n\ntext' }, { note: 'kept' })
  assert.match(text, /^---\nid: ch-0001\ntitle: Edges\nstate: open\nprojects:\n {2}- gimmickimg\nnote: kept\n---\n\n# Free\n\ntext\n$/)
  const r = parseRecord('ch-0001', text)
  assert.deepEqual({ ...r }, { title: 'Edges', state: 'open', projects: ['gimmickimg'], body: '# Free\n\ntext', extra: { note: 'kept' } })
  assert.match(parseRecord('ch-0002', 'no front').problem!, /no frontmatter/)
})

test('create, read, edit, pin, history: a revision stays readable after later edits', async () => {
  const s = store('a')
  const a = await s.create({ ...actor, request: 'req-create-1', title: 'Object extraction leaves edge remnants', body: 'Halo around cut-outs.', projects: ['gimmickimg'], source: { kind: 'conversation', conversation: 'c1', message: 310 }, evidence: [{ name: 'frame.png', bytes: Buffer.from('PNG1') }] })
  assert.equal(a.operation.challenge, 'ch-0001')
  assert.equal(a.publication.state, 'published')
  assert.equal(a.record!.commit, a.operation.commit)
  assert.deepEqual(a.record!.evidence.map(e => e.name), ['frame.png'])
  assert.equal(a.record!.created.by, 'front-agent')
  // the same request again: the same operation, nothing new in the repository
  const again = await s.create({ ...actor, request: 'req-create-1', title: 'Object extraction leaves edge remnants', body: 'Halo around cut-outs.', projects: ['gimmickimg'] })
  assert.equal(again.duplicate, true)
  assert.equal(await commits(), 1)
  const log = await gitOk(remote, ['log', '-1', '--format=%an%n%B', 'main'])
  assert.match(log, /^front-agent\nRecord ch-0001: Object extraction/)
  assert.match(log, /Challenge-Request: req-create-1/)
  assert.match(log, /Challenge-Run: front\/converse\/run-055/)
  assert.match(log, /Challenge-Source: conversation c1#310/)
  assert.match(log, /Challenge-On-Behalf-Of: iwaag/)

  const first = a.record!.commit
  const pinned = await s.pin('ch-0001')
  assert.equal(pinned.commit, first)
  const b = await s.edit('ch-0001', { by: 'iwaag', via: 'page', request: 'req-edit-1', base: first, body: 'Halo around cut-outs. SAM masks may help.' })
  assert.equal(b.publication.state, 'published')
  const old = await s.at('ch-0001', first.slice(0, 10))
  assert.equal(old.body, 'Halo around cut-outs.')
  assert.equal((await s.text('ch-0001', first)).includes('SAM'), false)
  assert.equal(s.current('ch-0001')!.body, 'Halo around cut-outs. SAM masks may help.')
  // a status change is an ordinary versioned edit; resolved records stay findable
  const c = await s.edit('ch-0001', { by: 'iwaag', via: 'page', request: 'req-resolve-1', base: b.record!.commit, state: 'resolved', note: 'fixture: resolved for the check' })
  assert.equal(c.record!.state, 'resolved')
  assert.equal(s.list({ state: 'resolved' }).challenges.length, 1)
  assert.equal(s.list({ text: 'SAM' }).challenges[0]!.id, 'ch-0001')
  assert.equal(s.list({ project: 'gimmickimg' }).total, 1)
  assert.equal(s.list({ project: 'other' }).total, 0)
  const h = await s.log('ch-0001')
  assert.deepEqual(h.map(x => [x.actor, x.state]), [['iwaag', 'resolved'], ['iwaag', 'open'], ['front-agent', 'open']])
  assert.match((await gitOk(remote, ['log', '-1', '--format=%s', 'main'])).trim(), /^Resolve ch-0001/)
  const reopened = await s.edit('ch-0001', { by: 'iwaag', via: 'page', request: 'req-reopen-1', base: c.record!.commit, state: 'open' })
  assert.equal(reopened.record!.state, 'open')
  s.close()
})

test('concurrent edits: the stale one is refused with the current revision, nothing is lost', async () => {
  const s1 = store('a'), s2 = store('b')
  await s2.sync({ force: true })
  const base = s1.current('ch-0001')!.commit
  const one = await s1.edit('ch-0001', { by: 'iwaag', via: 'page', request: 'req-conc-1', base, title: 'Edge remnants on extracted objects' })
  assert.equal(one.publication.state, 'published')
  // the second writer still holds the old base: refused before anything is journaled
  await refused(s2.edit('ch-0001', { by: 'forge-agent', via: 'cli', request: 'req-conc-2', base, body: 'mine' }), 'conflict')
  assert.equal(s2.operations().length, 0)
  // a conflict found only at publication (the remote moved after the base was accepted): the draft is kept
  const s3 = store('c', { beforePush: async () => { await rename(remote, `${remote}.away`) } })
  await s3.sync({ force: true })
  const cur = s3.current('ch-0001')!.commit
  const failed = await s3.edit('ch-0001', { by: 'archsage-agent', via: 'cli', request: 'req-conc-3', base: cur, body: 'draft from archsage' })
  await rename(`${remote}.away`, remote)
  assert.equal(failed.publication.state, 'unsynced')
  assert.match(failed.publication.error!, /push failed/)
  await s1.edit('ch-0001', { by: 'iwaag', via: 'page', request: 'req-conc-4', base: cur, body: 'the person edited meanwhile' })
  const s3b = store('c')
  const r = (await s3b.publish())
  assert.deepEqual(r.conflicts, [failed.operation.id])
  const op = s3b.operation(failed.operation.id)!
  assert.equal(op.state, 'conflict')
  assert.equal(op.fields.body, 'draft from archsage')
  assert.equal(s3b.current('ch-0001')!.body, 'the person edited meanwhile')
  // a second edit of the same record waits for the first to be settled
  await refused(s3b.edit('ch-0001', { by: 'archsage-agent', via: 'cli', request: 'req-conc-5', base: s3b.current('ch-0001')!.commit, body: 'x' }), 'pending-edit')
  s3b.discard(op.id, { by: 'archsage-agent', reason: 'merged by hand' })
  assert.equal(s3b.operation(op.id)!.state, 'discarded')
  for (const s of [s1, s2, s3]) s.close()
  s3b.close()
})

test('a failed push keeps the content unsynced; a retry publishes it once', async () => {
  const s = store('d', { beforePush: async () => { await rename(remote, `${remote}.away`) } })
  const before = await commits().catch(() => 0)
  const a = await s.create({ ...actor, request: 'req-push-1', title: 'Push failure fixture', body: 'kept while unsynced', projects: ['fixture'] })
  await rename(`${remote}.away`, remote)
  assert.equal(a.publication.state, 'unsynced')
  assert.equal(a.record, null)
  assert.equal(await commits(), before)
  const id = a.operation.challenge
  s.close()
  // after a restart (a new process), the journal still has it
  const t = store('d')
  assert.equal(t.operation(a.operation.id)!.state, 'unsynced')
  assert.equal(t.operation(a.operation.id)!.fields.body, 'kept while unsynced')
  const r = await t.retry(a.operation.id)
  assert.equal(r.state, 'published')
  assert.equal(await commits(), before + 1)
  assert.equal(t.current(id)!.body, 'kept while unsynced')
  t.close()
})

test('a crash after a successful push: the next try finds it in the remote history', async () => {
  const s = store('e', { afterPush: async () => { throw new Error('crash after push') } })
  const before = await commits()
  const a = await s.create({ ...actor, request: 'req-crash-1', title: 'Crash fixture', body: 'pushed once', projects: ['fixture'] })
  assert.equal(a.publication.state, 'unsynced')
  assert.equal(await commits(), before + 1)
  s.close()
  const t = store('e')
  const r = await t.publish()
  assert.deepEqual(r.published, [a.operation.id])
  assert.equal(await commits(), before + 1)
  assert.equal(t.operation(a.operation.id)!.commit, (await gitOk(remote, ['rev-parse', 'main'])).trim())
  t.close()
})

test('the index is rebuilt from a fresh clone with records and history', async () => {
  const s = store('fresh')
  await s.sync({ force: true })
  const all = s.list().challenges.map(c => c.id).sort()
  assert.deepEqual(all, ['ch-0001', 'ch-0002', 'ch-0003'])
  const r = s.current('ch-0001')!
  assert.equal(r.created.by, 'front-agent')
  assert.equal(r.evidence[0]!.name, 'frame.png')
  assert.equal((await s.evidence('ch-0001', 'frame.png')).bytes.toString(), 'PNG1')
  assert.ok((await s.log('ch-0001')).length >= 5)
  // a new identity continues after the published ones, whatever the journal holds
  const n = await s.create({ ...actor, request: 'req-next-1', title: 'Next', body: '', projects: [] })
  assert.equal(n.operation.challenge, 'ch-0004')
  s.close()
})

test('refusals name what to do and journal nothing', async () => {
  const s = store('f')
  await assert.rejects(s.create({ ...actor, request: 'short', title: 't', body: '' }), /request identity/)
  await assert.rejects(s.create({ ...actor, request: 'req-bad-1', title: 'two\nlines', body: '' }), /one line/)
  await assert.rejects(s.create({ ...actor, request: 'req-bad-2', title: 't', body: '', projects: ['Bad Name'] }), /project ids/)
  await assert.rejects(s.create({ ...actor, request: 'req-bad-3', title: 't', body: '', evidence: [{ name: '../x', bytes: Buffer.from('') }] }), /file name/)
  await assert.rejects(s.edit('ch-0001', { ...actor, request: 'req-bad-4', base: 'zz' }), /not a commit id/)
  await refused(s.edit('ch-0001', { ...actor, request: 'req-bad-5', base: s.current('ch-0001')?.commit ?? (await s.sync({ force: true }), s.current('ch-0001')!.commit) }), 'unchanged')
  assert.equal(s.operations().length, 0)
  s.close()
})

test('a mirror receives every publication; one that cannot is recorded and caught up later', async () => {
  const mirror = join(root, 'mirror.git')
  await writeFile(join(root, 'challenges.json'), JSON.stringify({ repository: remote, mirrors: [mirror] }))
  const s = store('g')
  await s.create({ ...actor, request: 'req-mirror-1', title: 'Mirror fixture', body: '', projects: ['fixture'] })
  let m = (await s.status()).mirrors[0]!
  assert.match(m.error!, /mirror\.git|not a git|does not appear|No such/i)
  await gitOk(root, ['init', '-q', '--bare', '-b', 'main', mirror])
  await s.mirror()
  m = (await s.status()).mirrors[0]!
  assert.equal(m.error, null)
  assert.equal(m.commit, (await gitOk(remote, ['rev-parse', 'main'])).trim())
  assert.equal((await gitOk(mirror, ['rev-parse', 'main'])).trim(), m.commit)
  await writeFile(join(root, 'challenges.json'), JSON.stringify({ repository: remote }))
  s.close()
})
