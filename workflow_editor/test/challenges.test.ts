// Challenges (challenge p1, p3; docs/challenges.md): one directory per
// challenge in one Git repository, written through a journal. A conflict is
// about the files a write changes: two trials added on the same stale
// revision both publish, two edits of one file conflict without losing
// either draft; a repeated request is one commit; a failed push and a crash
// after a successful push recover with the right publication state; files
// written by an ordinary Git commit are part of the challenge; custom and
// absent states are kept and shown as they are, and an edit changes only
// what it names; a commit of the layout before p3 still reads as it was; the
// index is rebuilt from a fresh clone.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectFiles } from '../cli/challenge.ts'
import { ChallengeStore, materialName, parseRecord, renderRecord, updateSummary } from '../server/challenges.ts'
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
const bytes = (s: string) => Buffer.from(s)
// An ordinary Git commit to the shared repository, outside WFE.
async function direct(name: string, files: Record<string, string | null>, message: string) {
  const w = join(root, `direct-${name}`)
  await rm(w, { recursive: true, force: true })
  await gitOk(root, ['clone', '-q', remote, w])
  for (const [p, t] of Object.entries(files)) {
    if (t === null) await gitOk(w, ['rm', '-q', p])
    else { await mkdir(join(w, p, '..'), { recursive: true }); await writeFile(join(w, p), t) }
  }
  await gitOk(w, ['add', '-A'])
  await gitOk(w, ['-c', 'user.name=Someone By Hand', '-c', 'user.email=h@example.invalid', 'commit', '-q', '-m', message])
  await gitOk(w, ['push', '-q', 'origin', 'HEAD:main'])
  return (await gitOk(w, ['rev-parse', 'HEAD'])).trim()
}

test('the summary format: four fields and the body; other frontmatter, comments and the body survive an edit', () => {
  const text = renderRecord('ch-0001', { title: 'Edges', state: 'open', projects: ['gimmickimg'], body: '# Free\n\ntext' }, { note: 'kept' })
  assert.match(text, /^---\nid: ch-0001\ntitle: Edges\nstate: open\nprojects:\n {2}- gimmickimg\nnote: kept\n---\n\n# Free\n\ntext\n$/)
  const r = parseRecord('ch-0001', text)
  assert.deepEqual({ ...r }, { title: 'Edges', state: 'open', projects: ['gimmickimg'], body: '# Free\n\ntext', extra: { note: 'kept' } })
  assert.match(parseRecord('ch-0002', 'no front').problem!, /no frontmatter/)
  // absent and custom states are what they are
  assert.equal(parseRecord('x', '---\ntitle: t\n---\nb').state, null)
  assert.equal(parseRecord('x', '---\ntitle: t\nstate: parked\n---\nb').state, 'parked')
  assert.equal(parseRecord('x', '---\ntitle: t\nstate: parked\n---\nb').problem, undefined)
  // an edit of the title changes the title only
  const hand = '---\n# kept comment\nid: ch-0009\ntitle:   Old\nstate: parked   # local meaning\npriority: [a, b]\n---\n\n  Body  with  odd   spacing\n\n\n'
  const out = updateSummary('ch-0009', hand, { title: 'New' })
  assert.match(out, /^---\n# kept comment\nid: ch-0009\ntitle: New\n/)
  assert.match(out, /priority: /)
  assert.match(out, /# kept comment/)
  assert.match(out, /state: parked/)
  assert.ok(out.endsWith('\n\n  Body  with  odd   spacing\n\n\n'))
  // unchanged values change nothing at all
  assert.equal(updateSummary('ch-0009', hand, { title: 'Old', state: 'parked' }), hand)
  assert.throws(() => materialName('../x'), /segments/)
  assert.throws(() => materialName('a/.git/config'), /\.git/)
  assert.equal(materialName('./wedo/t/日本語 ファイル.wav'), 'wedo/t/日本語 ファイル.wav')
})

test('create, read, edit, pin, history: a revision stays readable after later edits', async () => {
  const s = store('a')
  const a = await s.create({ ...actor, request: 'req-create-1', title: 'Object extraction leaves edge remnants', body: 'Halo around cut-outs.', projects: ['gimmickimg'], source: { kind: 'conversation', conversation: 'c1', message: 310 }, files: [{ name: 'frame.png', bytes: bytes('PNG1') }, { name: 'input/voice.wav', bytes: bytes('RIFF') }] })
  assert.equal(a.operation.challenge, 'ch-0001')
  assert.equal(a.publication.state, 'published')
  assert.equal(a.record!.commit, a.operation.commit)
  assert.equal(a.record!.layout, 'directory')
  assert.deepEqual(a.record!.files.map(e => e.name), ['frame.png', 'input/voice.wav'])
  assert.equal(a.record!.created.by, 'front-agent')
  assert.deepEqual((await gitOk(remote, ['ls-tree', '-r', '--name-only', 'main'])).trim().split('\n'), ['challenges/ch-0001/frame.png', 'challenges/ch-0001/input/voice.wav', 'challenges/ch-0001/summary.md'])
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
  assert.equal((await s.file('ch-0001', { name: 'input/voice.wav' })).bytes.toString(), 'RIFF')
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
  s.close()
})

test('trials: work on a resolved challenge changes no state; independent trials on one stale revision both publish', async () => {
  const s1 = store('t1'), s2 = store('t2')
  await s2.sync({ force: true })
  const stale = s2.current('ch-0001')!.commit
  const idea = await s1.edit('ch-0001', { by: 'forge-agent', via: 'cli', request: 'req-trial-idea', trial: 'sam-idea', files: [{ name: 'summary.md', bytes: bytes('# Use SAM masks\n\nOnly an idea so far: ![](sketch.png)') }, { name: 'sketch.png', bytes: bytes('PNG2') }] })
  assert.equal(idea.publication.state, 'published')
  assert.equal(idea.record!.state, 'resolved')
  assert.equal(idea.operation.trial, 'sam-idea')
  assert.match((await gitOk(remote, ['log', '-1', '--format=%s%n%B', 'main'])), /^Record work in ch-0001: wedo\/sam-idea[\s\S]*Challenge-Trial: sam-idea/)
  // the second writer still holds the revision before that trial: another trial is no conflict
  const failed = await s2.edit('ch-0001', { by: 'archsage-agent', via: 'cli', request: 'req-trial-fail', base: stale, trial: 'matting-try', files: [{ name: 'out/take1.wav', bytes: bytes('W1') }, { name: 'out/nested/deep/log.txt', bytes: bytes('it did not work') }] })
  assert.equal(failed.publication.state, 'published')
  const cur = s2.current('ch-0001')!
  assert.deepEqual(cur.trials.map(t => [t.name, t.summary?.title ?? null, t.files.length]), [['matting-try', null, 2], ['sam-idea', 'Use SAM masks', 2]])
  assert.equal(cur.trials.find(t => t.name === 'sam-idea')!.updated.by, 'forge-agent')
  assert.equal(cur.trials.find(t => t.name === 'matting-try')!.updated.by, 'archsage-agent')
  assert.equal(cur.commit, failed.operation.commit)
  // trial summaries are searchable, with the trial named; files are not
  const found = s2.list({ text: 'SAM masks' }).challenges[0] as unknown as { id: string; matches: { trial: string }[] }
  assert.deepEqual(found.matches.map(m => m.trial), ['sam-idea'])
  assert.equal(s2.list({ text: 'did not work' }).total, 0)
  assert.deepEqual((await s2.log('ch-0001', { trial: 'sam-idea' })).map(e => e.actor), ['forge-agent'])
  // without a base a file that exists is not overwritten
  await refused(s2.edit('ch-0001', { by: 'archsage-agent', via: 'cli', request: 'req-trial-over', trial: 'sam-idea', files: [{ name: 'sketch.png', bytes: bytes('mine') }] }), 'conflict')
  s1.close(); s2.close()
})

test('the same file: the stale write is refused with the current revision; a conflict found at publication keeps the draft', async () => {
  const s1 = store('a'), s2 = store('b')
  await s2.sync({ force: true })
  const base = s1.current('ch-0001')!.commit
  const one = await s1.edit('ch-0001', { by: 'iwaag', via: 'page', request: 'req-conc-1', base, title: 'Edge remnants on extracted objects' })
  assert.equal(one.publication.state, 'published')
  // the second writer still holds the old base and writes the summary too: refused before anything is journaled
  await refused(s2.edit('ch-0001', { by: 'forge-agent', via: 'cli', request: 'req-conc-2', base, body: 'mine' }), 'conflict')
  assert.equal(s2.operations().length, 0)
  // a conflict found only at publication (the remote moved after the base was accepted): the draft is kept
  const s3 = store('c', { beforePush: async () => { await rename(remote, `${remote}.away`) } })
  await s3.sync({ force: true })
  const cur = s3.current('ch-0001')!.commit
  const failed = await s3.edit('ch-0001', { by: 'archsage-agent', via: 'cli', request: 'req-conc-3', base: cur, trial: 'sam-idea', files: [{ name: 'summary.md', bytes: bytes('# Use SAM masks\n\narchsage tried it') }] })
  await rename(`${remote}.away`, remote)
  assert.equal(failed.publication.state, 'unsynced')
  assert.match(failed.publication.error!, /push failed/)
  // meanwhile someone writes the same file, and another writes a different one
  await s1.edit('ch-0001', { by: 'forge-agent', via: 'cli', request: 'req-conc-4', base: cur, trial: 'sam-idea', files: [{ name: 'summary.md', bytes: bytes('# Use SAM masks\n\nforge tried it') }] })
  await s1.edit('ch-0001', { by: 'iwaag', via: 'page', request: 'req-conc-4b', base: cur, body: 'the person edited meanwhile' })
  const s3b = store('c')
  const r = await s3b.publish()
  assert.deepEqual(r.conflicts, [failed.operation.id])
  const op = s3b.operation(failed.operation.id)!
  assert.equal(op.state, 'conflict')
  assert.equal(s3b.draftFile(op.id, 'wedo/sam-idea/summary.md').toString(), '# Use SAM masks\n\narchsage tried it')
  assert.match(op.error!, /wedo\/sam-idea\/summary\.md/)
  assert.equal(s3b.current('ch-0001')!.trials.find(t => t.name === 'sam-idea')!.summary!.body, '# Use SAM masks\n\nforge tried it')
  // a second write of the same file waits for the first to be settled; another file does not
  await refused(s3b.edit('ch-0001', { by: 'archsage-agent', via: 'cli', request: 'req-conc-5', base: s3b.current('ch-0001')!.commit, trial: 'sam-idea', files: [{ name: 'summary.md', bytes: bytes('x') }] }), 'pending-edit')
  const other = await s3b.edit('ch-0001', { by: 'archsage-agent', via: 'cli', request: 'req-conc-6', trial: 'archsage-notes', files: [{ name: 'notes.md', bytes: bytes('separately') }] })
  assert.equal(other.publication.state, 'published')
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
  const a = await s.edit('ch-0001', { by: 'forge-agent', via: 'cli', request: 'req-crash-1', trial: 'crash-trial', files: [{ name: 'a.txt', bytes: bytes('pushed once') }] })
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

test('direct Git writes: any file in a challenge directory is part of it; custom, absent and missing summaries stay as they are', async () => {
  const s = store('h')
  const hand = '---\n# written by hand\nid: ch-0050\ntitle: Parked by hand\nstate: parked\nowner: lab-3\n---\n\nKept   as  written.\n'
  await direct('a', {
    'challenges/ch-0001/wedo/by-hand/result.txt': 'from git',
    'challenges/ch-0050/summary.md': hand,
    'challenges/ch-0051/summary.md': '---\ntitle: No state\n---\nbody\n',
    'challenges/steam-game/notes.md': 'an idea with no summary',
    'challenges/ch-0052/summary.md': '---\ntitle: [unclosed\n---\nbody\n',
  }, 'Add by hand')
  await s.sync({ force: true })
  const one = s.current('ch-0001')!
  assert.equal(one.updated.by, 'Someone By Hand')
  assert.ok(one.trials.some(t => t.name === 'by-hand' && t.summary === null))
  assert.equal((await s.file('ch-0001', { name: 'wedo/by-hand/result.txt' })).bytes.toString(), 'from git')
  const parked = s.current('ch-0050')!
  assert.deepEqual([parked.state, parked.stateKind, parked.extra.owner, parked.problem], ['parked', 'custom', 'lab-3', undefined])
  assert.deepEqual([s.current('ch-0051')!.state, s.current('ch-0051')!.stateKind], [null, 'unspecified'])
  const free = s.current('steam-game')!
  assert.deepEqual([free.summary, free.title, free.state, free.files.map(f => f.name)], [false, 'steam-game', null, ['notes.md']])
  assert.match(await s.text('steam-game', free.commit), /has no summary\.md[\s\S]*notes\.md/)
  assert.match(s.current('ch-0052')!.problem!, /not YAML/)
  // counts keep every kind apart; filters find each
  const all = s.list()
  assert.equal(all.counts.custom, 1)
  assert.equal(all.counts.unspecified, 3) // ch-0052's frontmatter cannot be read: no state is read from it
  assert.deepEqual(all.custom, [{ state: 'parked', count: 1 }])
  assert.deepEqual(s.list({ state: 'unspecified' }).challenges.map(c => c.id).sort(), ['ch-0051', 'ch-0052', 'steam-game'])
  assert.deepEqual(s.list({ state: 'parked' }).challenges.map(c => c.id), ['ch-0050'])
  assert.equal(s.list({ state: 'open' }).challenges.some(c => ['ch-0050', 'ch-0051', 'steam-game'].includes(c.id)), false)
  // an ordinary edit changes only what it names
  const e = await s.edit('ch-0050', { by: 'iwaag', via: 'page', request: 'req-hand-1', base: parked.commit, projects: ['lab'] })
  assert.equal(e.publication.state, 'published')
  const text = await gitOk(remote, ['show', 'main:challenges/ch-0050/summary.md'])
  assert.equal(text, hand.replace('owner: lab-3\n', 'owner: lab-3\nprojects:\n  - lab\n'))
  // a summary can be given to a challenge that had none; its fields are not invented
  const g = await s.edit('steam-game', { by: 'iwaag', via: 'page', request: 'req-hand-2', base: free.commit, title: 'A very fun steampunk game' })
  assert.equal(await gitOk(remote, ['show', 'main:challenges/steam-game/summary.md']), '---\nid: steam-game\ntitle: A very fun steampunk game\n---\n\n')
  assert.equal(g.record!.state, null)
  await refused(s.edit('ch-0052', { by: 'iwaag', via: 'page', request: 'req-hand-3', base: s.current('ch-0052')!.commit, title: 'x' }), 'unreadable-summary')
  // a new id continues after the allocated ones, whatever other names exist
  const n = await s.create({ ...actor, request: 'req-next-1', title: 'Next', body: '', projects: [] })
  assert.equal(n.operation.challenge, 'ch-0053')
  s.close()
})

test('the layout before p3 still reads at its commits; after a move, history and pins carry through', async () => {
  const s = store('legacy')
  const legacyText = '---\nid: ch-0100\ntitle: Old layout\nstate: open\nprojects:\n  - gimmickimg\n---\n\nSee ![](../evidence/ch-0100/edge.png).\n'
  const before = await direct('l1', { 'challenges/ch-0100.md': legacyText, 'evidence/ch-0100/edge.png': 'PNGOLD' }, 'Record ch-0100 the old way')
  await s.sync({ force: true })
  const old = s.current('ch-0100')!
  assert.deepEqual([old.layout, old.path, old.files.map(f => [f.name, f.path])], ['legacy', 'challenges/ch-0100.md', [['evidence/edge.png', 'evidence/ch-0100/edge.png']]])
  await refused(s.edit('ch-0100', { by: 'iwaag', via: 'page', request: 'req-legacy-1', base: old.commit, title: 'x' }), 'legacy-layout')
  const pin = await s.pin('ch-0100')
  // the move, as a plain Git commit
  const moved = await direct('l2', { 'challenges/ch-0100.md': null, 'evidence/ch-0100/edge.png': null, 'challenges/ch-0100/summary.md': legacyText.replace('../evidence/ch-0100/edge.png', 'evidence/edge.png'), 'challenges/ch-0100/evidence/edge.png': 'PNGOLD' }, 'Move ch-0100 into its directory')
  await s.sync({ force: true })
  const now = s.current('ch-0100')!
  assert.deepEqual([now.layout, now.files.map(f => f.name), now.created.by, now.created.commit], ['directory', ['evidence/edge.png'], 'Someone By Hand', before])
  assert.equal(now.commit, moved)
  // the pinned revision reads exactly as it was, with the same hash
  const then = await s.at('ch-0100', pin.commit)
  assert.equal(then.layout, 'legacy')
  assert.equal(then.sha256, pin.sha256)
  assert.equal((await s.text('ch-0100', pin.commit)), legacyText)
  assert.equal((await s.file('ch-0100', { name: 'evidence/edge.png' }, pin.commit)).path, 'evidence/ch-0100/edge.png')
  assert.equal((await s.file('ch-0100', { name: 'evidence/edge.png' })).path, 'challenges/ch-0100/evidence/edge.png')
  assert.deepEqual((await s.log('ch-0100')).map(e => e.commit), [moved, before])
  s.close()
})

test('nothing is written through a symbolic link; a local directory brings its tree, never what is outside it', async () => {
  const s = store('links')
  await direct('s1', { 'challenges/ch-0001/wedo/linked/.keep': '' }, 'prepare')
  const w = join(root, 'direct-s2')
  await rm(w, { recursive: true, force: true })
  await gitOk(root, ['clone', '-q', remote, w])
  await symlink('/tmp', join(w, 'challenges/ch-0001/wedo/escape'))
  await gitOk(w, ['add', '-A']); await gitOk(w, ['commit', '-q', '-m', 'a link']); await gitOk(w, ['push', '-q', 'origin', 'HEAD:main'])
  const r = await s.edit('ch-0001', { by: 'forge-agent', via: 'cli', request: 'req-link-1', trial: 'escape', files: [{ name: 'x.txt', bytes: bytes('no') }] })
  assert.equal(r.publication.state, 'unsynced')
  assert.match(r.publication.error!, /symbolic link/)
  s.discard(r.operation.id, { by: 'test', reason: 'fixture' })
  s.close()
  // collecting a local directory
  const src = join(root, 'work')
  await mkdir(join(src, 'out', 'deep'), { recursive: true })
  await mkdir(join(src, '.git'), { recursive: true })
  await writeFile(join(src, 'summary.md'), '# tried')
  await writeFile(join(src, 'out', 'deep', 'a.wav'), 'A')
  await writeFile(join(src, '.git', 'HEAD'), 'x')
  await symlink(join(src, 'summary.md'), join(src, 'again.md'))
  const ok = collectFiles([src], m => new Error(m))
  assert.deepEqual(ok.files.map(f => f.name), ['again.md', 'out/deep/a.wav', 'summary.md'])
  assert.deepEqual(collectFiles([`${src}=take1`], m => new Error(m)).files.map(f => f.name), ['take1/again.md', 'take1/out/deep/a.wav', 'take1/summary.md'])
  await symlink('/etc/hosts', join(src, 'leak'))
  assert.throws(() => collectFiles([src], m => new Error(m)), /outside/)
})

test('refusals name what to do and journal nothing', async () => {
  const s = store('f')
  await s.sync({ force: true })
  const base = s.current('ch-0001')!.commit
  await assert.rejects(s.create({ ...actor, request: 'short', title: 't', body: '' }), /request identity/)
  await assert.rejects(s.create({ ...actor, request: 'req-bad-1', title: 'two\nlines', body: '' }), /one line/)
  await assert.rejects(s.create({ ...actor, request: 'req-bad-2', title: 't', body: '', projects: ['Bad Name'] }), /project ids/)
  await assert.rejects(s.create({ ...actor, request: 'req-bad-3', title: 't', body: '', files: [{ name: '../x', bytes: bytes('') }] }), /segments/)
  await assert.rejects(s.edit('ch-0001', { ...actor, request: 'req-bad-4', base: 'zz', title: 'x' }), /not a commit id/)
  await refused(s.edit('ch-0001', { ...actor, request: 'req-bad-5', base }), 'unchanged')
  await assert.rejects(s.edit('ch-0001', { ...actor, request: 'req-bad-6', trial: 'a/b', files: [{ name: 'x', bytes: bytes('') }] }), /one directory name/)
  await assert.rejects(s.edit('ch-0001', { ...actor, request: 'req-bad-7', body: 'no base' }), /names the revision/)
  await assert.rejects(s.edit('ch-0001', { ...actor, request: 'req-bad-8', base, drop: ['nothing-here.txt'] }), /has no file/)
  await assert.rejects(s.edit('ch-0001', { ...actor, request: 'req-bad-9', trial: 't', files: [{ name: 'big.bin', bytes: Buffer.alloc(32 * 1024 * 1024 + 1) }] }), /at most 33554432/)
  assert.equal(s.operations().length, 0)
  s.close()
})

test('the index is rebuilt from a fresh clone with challenges, trials and history', async () => {
  const s = store('fresh')
  await s.sync({ force: true })
  const ids = s.list({ limit: 500 }).challenges.map(c => c.id)
  for (const id of ['ch-0001', 'ch-0002', 'ch-0050', 'ch-0100', 'steam-game']) assert.ok(ids.includes(id), id)
  const r = s.current('ch-0001')!
  assert.equal(r.created.by, 'front-agent')
  assert.ok(r.trials.length >= 4)
  assert.equal((await s.file('ch-0001', { name: 'frame.png' })).bytes.toString(), 'PNG1')
  assert.ok((await s.log('ch-0001')).length >= 8)
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
