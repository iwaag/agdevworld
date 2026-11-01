// Message files (workflow_editor p19, docs/message-files.md): a person's
// message carries files as one bundle on a share, each file an occurrence of
// exactly that message. File-only and mixed messages, adjacent duplicate
// names, the submit token as an upload operation (same retry, changed retry,
// concurrent retries), crashes at each boundary, a route that moves or
// becomes invalid while the files publish, limits and malformed input, a
// share that is down (text still works), safe serving, missing and altered
// bytes, every delivery path (new run, answer, instruction, conductor wake,
// a later request citing the message), export/restore, and the existing
// challenge attachments beside them.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../server/conversations.ts'
import { createProject } from '../server/create.ts'
import { ConversationArchive } from '../server/conversationArchive.ts'
import { ConversationService } from '../server/conversationService.ts'
import { ExecStore, attachmentBrief, attachedLines } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { decodeFiles, FILE_LIMITS, manifestDigest, restorePackage, servedAs, type Manifest } from '../server/messageFiles.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runDir, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { setShareArea } from '../server/shares.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import type { RunRecord, RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-files-'))
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
    description: Speak.
`

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFklEQVR4nGN8ocDA8IKBQYyBgYEBACU0AhBf+8STAAAAAElFTkSuQmCC', 'base64')
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const wire = (name: string, bytes: Buffer | string, mime?: string) => ({ name, base64: Buffer.from(bytes).toString('base64'), ...(mime ? { mime } : {}) })

async function setup() {
  const area = join(root, 'area')
  const registry = join(area, 'registry.json')
  for (const [id, wfs] of [['front', ['converse']], ['ponderer', ['conduct']], ['forge', ['converse', 'discuss']]] as const) {
    const dir = join(area, `pj-${id}`)
    const r = await createProject({ dir, id, name: id, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
    assert.ok(r.ok, r.message)
    for (const wf of wfs) await writeFile(join(dir, 'devdocs', 'workflows', `${wf}.yaml`), WF(wf, `${id}-agent`))
    await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  }
  const archive = join(area, 'ponderer-origin.git')
  await gitOk(area, ['init', '-q', '--bare', '-b', 'main', archive])
  await gitOk(join(area, 'pj-ponderer'), ['remote', 'remove', 'origin']).catch(() => '')
  await gitOk(join(area, 'pj-ponderer'), ['remote', 'add', 'origin', archive])
  await gitOk(join(area, 'pj-ponderer'), ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
  await writeFile(join(area, 'conversations.json'), JSON.stringify({
    person: 'Pat', projects: [{ workspace: 'front', converse: 'converse' }, { workspace: 'forge', converse: 'converse', discuss: 'discuss' }],
    facilitator: { workspace: 'ponderer', workflow: 'conduct' }, archive: { workspace: 'ponderer' },
  }))
  const share = join(root, 'share')
  await mkdir(share, { recursive: true })
  await writeFile(join(share, '.wfe-share.json'), JSON.stringify({ share: 'testshare' }))
  await writeFile(join(area, 'shares.json'), JSON.stringify({ shares: { testshare: { root: share } } }))
  await writeFile(join(area, 'attachments.json'), JSON.stringify({ share: 'testshare', prefix: 'conversations' }))
  setShareArea(area)
  const x = new ExecStore({ registryFile: registry, area })
  const cs = new ConversationStore({ area, exec: x })
  const ds = new ConversationService(cs)
  const regs = (await loadRegistry(registry)).workspaces
  const ws = (id: string) => new Workspace(regs.find(w => w.project === id)!)
  return { area, share, x, cs, ds, ws, registry }
}
type S = Awaited<ReturnType<typeof setup>>
const refOf = (run: string): RunRef => { const [, workflow, r] = run.split('/'); return { workflow: workflow!, run: r! } }
const rec = async (s: S, run: string) => { const r = refOf(run); return (await readRun(await runSpace(s.ws(run.split('/')[0]!), r), r)).record! as RunRecord }
const bundleDir = (s: S, conv: string, bundle: string) => join(s.share, 'conversations', conv, 'attachments', bundle)
const fileRows = (s: S, conv: string) => s.cs.fileRows({ conv })
const counts = (s: S, conv: string) => ({ messages: s.cs.messages(conv).length, requests: s.ds.invitations(conv).length, files: fileRows(s, conv).length, uploads: s.ds.uploads(conv).length })

let s: S
test('a file-only first message: exact association, original bytes, title from the file, a run that names it', async () => {
  s = await setup()
  const files = decodeFiles([wire('clipboard image.png', PNG, 'image/png'), wire('notes.txt', 'notes\n')])
  const p = await s.ds.post('mf-a', { text: '', author: 'Pat', token: 'tok-mf-a-0001', with: 'front', files })
  assert.equal(p.created, true)
  assert.equal(s.ds.conversation('mf-a')!.title, 'clipboard image.png')
  assert.equal(p.message.text, '')
  const rows = fileRows(s, 'mf-a')
  assert.deepEqual(rows.map(r => [r.message, r.ordinal, r.name, r.bytes, r.preview]), [[p.message.id, 1, 'clipboard image.png', PNG.length, 'image'], [p.message.id, 2, 'notes.txt', 6, 'text']])
  assert.ok(rows.every(r => /^f-[0-9a-f]{24}$/.test(r.attachment)) && rows[0]!.bundle === rows[1]!.bundle)
  // the bytes on the share are the originals, under WFE's identities, with a manifest whose digest holds
  const dir = bundleDir(s, 'mf-a', rows[0]!.bundle)
  assert.deepEqual((await readdir(dir)).sort(), [rows[0]!.attachment, rows[1]!.attachment, 'manifest.json'].sort())
  assert.ok((await readFile(join(dir, rows[0]!.attachment))).equals(PNG))
  const man = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Manifest
  assert.equal(manifestDigest(man), man.digest)
  assert.equal(s.ds.upload('mf-a', 'tok-mf-a-0001')!.manifest, man.digest)
  // the run started for it is given the files by occurrence, and its brief says how to fetch them
  const inv = p.invitations[0]!
  assert.equal(inv.state, 'started', inv.error ?? '')
  const r = await rec(s, inv.run!)
  assert.deepEqual(r.input.attachments!.map(a => [a.kind, a.id]), rows.map(x => ['file', x.attachment]))
  const brief = attachmentBrief(r, runDir(refOf(inv.run!))).join('\n')
  assert.match(brief, /"clipboard image\.png" \(image\/png, 78 bytes, sha256 [0-9a-f]{12}…\) from mf-a #\d+, file 1: wfe conversation fetch mf-a --message \d+ --attachment f-/)
  // the view carries both files with preview and their routes
  const v = await s.ds.view('mf-a', { viewBase: 'http://wfe.example/wfe/' })
  const att = v.messages[0]!.attachments!
  assert.deepEqual(att.map(a => a.kind === 'file' ? [a.name, a.preview, a.api] : []), [['clipboard image.png', 'image', `api/conversations/mf-a/messages/${p.message.id}/attachments/${rows[0]!.attachment}`], ['notes.txt', 'text', `api/conversations/mf-a/messages/${p.message.id}/attachments/${rows[1]!.attachment}`]])
})

test('mixed text and files; the same name on adjacent messages stays two occurrences', async () => {
  const one = await s.ds.post('mf-a', { text: 'here is the plan', author: 'Pat', token: 'tok-mf-a-0002', files: decodeFiles([wire('plan.txt', 'v1')]) })
  const two = await s.ds.post('mf-a', { text: 'and the revised plan', author: 'Pat', token: 'tok-mf-a-0003', files: decodeFiles([wire('plan.txt', 'v2'), wire('plan.txt', 'v2')]) })
  const of = (m: number) => fileRows(s, 'mf-a').filter(r => r.message === m)
  assert.deepEqual(of(one.message.id).map(r => r.sha256), [sha('v1')])
  assert.deepEqual(of(two.message.id).map(r => [r.ordinal, r.sha256]), [[1, sha('v2')], [2, sha('v2')]])
  const ids = fileRows(s, 'mf-a').map(r => r.attachment)
  assert.equal(new Set(ids).size, ids.length)
  assert.notEqual(of(one.message.id)[0]!.bundle, of(two.message.id)[0]!.bundle)
  // each run gets its own message's files, both occurrences of the second
  const r2 = await rec(s, two.invitations[0]!.run!)
  assert.deepEqual(r2.input.attachments!.map(a => a.id), of(two.message.id).map(r => r.attachment))
})

test('the token is the operation: same retry, changed content, changed author, concurrent retries', async () => {
  const files = () => decodeFiles([wire('a.bin', 'abc')])
  const first = await s.ds.post('mf-a', { text: 'x', author: 'Pat', token: 'tok-mf-a-0010', files: files() })
  const before = counts(s, 'mf-a')
  const again = await s.ds.post('mf-a', { text: 'x', author: 'Pat', token: 'tok-mf-a-0010', files: files() })
  assert.equal(again.duplicate, true)
  assert.equal(again.message.id, first.message.id)
  assert.deepEqual(again.invitations.map(i => i.id), first.invitations.map(i => i.id))
  assert.deepEqual(counts(s, 'mf-a'), before)
  const conflict = (e: unknown) => e instanceof RequestError && e.status === 409 && (e.detail as { code: string }).code === 'token-conflict'
  await assert.rejects(s.ds.post('mf-a', { text: 'x', author: 'Pat', token: 'tok-mf-a-0010', files: decodeFiles([wire('a.bin', 'abd')]) }), conflict)
  await assert.rejects(s.ds.post('mf-a', { text: 'y', author: 'Pat', token: 'tok-mf-a-0010', files: files() }), conflict)
  await assert.rejects(s.ds.post('mf-a', { text: 'x', author: 'Sam', token: 'tok-mf-a-0010', files: files() }), conflict)
  await assert.rejects(s.ds.post('mf-a', { text: 'x', author: 'Pat', token: 'tok-mf-a-0010' }), conflict)
  // a text-only message's token cannot become a file submission
  await s.ds.post('mf-a', { text: 'plain', author: 'Pat', token: 'tok-mf-a-0011' })
  await assert.rejects(s.ds.post('mf-a', { text: 'plain', author: 'Pat', token: 'tok-mf-a-0011', files: files() }), conflict)
  assert.equal(counts(s, 'mf-a').files, before.files)
  // concurrent identical submissions: one message, one request set, one bundle
  const c0 = counts(s, 'mf-a')
  const all = await Promise.all([0, 1, 2].map(() => s.ds.post('mf-a', { text: 'race', author: 'Pat', token: 'tok-mf-a-0012', files: decodeFiles([wire('race.txt', 'r')]) })))
  assert.equal(new Set(all.map(r => r.message.id)).size, 1)
  assert.equal(all.filter(r => !r.duplicate).length, 1)
  const c1 = counts(s, 'mf-a')
  assert.deepEqual([c1.messages - c0.messages, c1.requests - c0.requests, c1.files - c0.files, c1.uploads - c0.uploads], [1, 1, 1, 1])
})

test('a crash while staging, after publication, or after acceptance: no text-only substitute, no duplicate', async () => {
  const files = () => decodeFiles([wire('crash.png', PNG)])
  const c0 = counts(s, 'mf-a')
  // 1. staging: the files were written, the folder never renamed into place
  s.ds.testHooks.afterStaging = async () => { throw new Error('killed while staging') }
  await assert.rejects(s.ds.post('mf-a', { text: 'crash 1', author: 'Pat', token: 'tok-mf-a-0020', files: files() }), /killed while staging/)
  s.ds.testHooks = {}
  const op1 = s.ds.upload('mf-a', 'tok-mf-a-0020')!
  assert.equal(op1.state, 'failed')
  assert.deepEqual([counts(s, 'mf-a').messages, counts(s, 'mf-a').files], [c0.messages, c0.files])
  const parent = join(s.share, 'conversations', 'mf-a', 'attachments')
  assert.ok(!(await readdir(parent)).some(n => n.startsWith('.staging-')), 'no staging folder is left behind')
  const r1 = await s.ds.post('mf-a', { text: 'crash 1', author: 'Pat', token: 'tok-mf-a-0020', files: files() })
  assert.equal(r1.duplicate, false)
  assert.equal(s.ds.upload('mf-a', 'tok-mf-a-0020')!.bundle, op1.bundle, 'the retry keeps the identities it reserved')
  // 2. after publication, before the message: the bundle is complete and unassociated
  s.ds.testHooks.afterPublish = async () => { throw new Error('killed after publishing') }
  await assert.rejects(s.ds.post('mf-a', { text: 'crash 2', author: 'Pat', token: 'tok-mf-a-0021', files: files() }), /killed after publishing/)
  s.ds.testHooks = {}
  const op2 = s.ds.upload('mf-a', 'tok-mf-a-0021')!
  assert.equal(op2.state, 'published')
  assert.ok((await readdir(bundleDir(s, 'mf-a', op2.bundle))).includes('manifest.json'))
  assert.equal(s.cs.messages('mf-a').filter(m => m.token === 'tok-mf-a-0021').length, 0, 'a published bundle is not a sent message')
  const r2 = await s.ds.post('mf-a', { text: 'crash 2', author: 'Pat', token: 'tok-mf-a-0021', files: files() })
  assert.equal(fileRows(s, 'mf-a').filter(r => r.message === r2.message.id && r.bundle === op2.bundle).length, 1, 'the retry adopts the bundle, never writes another')
  assert.ok(s.ds.uploadEvents(op2.id).some(e => e.state === 'published' && /written/.test(e.note)))
  // 3. accepted, the process dies before dispatching or answering
  s.ds.testHooks.afterAccept = async () => { throw new Error('killed after accepting') }
  await assert.rejects(s.ds.post('mf-a', { text: 'crash 3', author: 'Pat', token: 'tok-mf-a-0022', files: files() }), /killed after accepting/)
  s.ds.testHooks = {}
  const m3 = s.cs.messages('mf-a').find(m => m.token === 'tok-mf-a-0022')!
  const pending = s.ds.invitations('mf-a').filter(i => i.token?.startsWith(`message:${m3.id}:`))
  assert.deepEqual(pending.map(i => i.state), ['pending'])
  // the executor's reconcile dispatches it once; the client's retry returns the same message
  await s.ds.reconcile()
  const r3 = await s.ds.post('mf-a', { text: 'crash 3', author: 'Pat', token: 'tok-mf-a-0022', files: files() })
  assert.equal(r3.duplicate, true)
  assert.equal(r3.message.id, m3.id)
  assert.deepEqual(r3.invitations.map(i => [i.id, i.state]), [[pending[0]!.id, 'started']])
  const runs = s.ds.invitations('mf-a').filter(i => i.token?.startsWith(`message:${m3.id}:`)).map(i => i.run)
  assert.equal(runs.length, 1)
  // nothing text-only was ever recorded for these tokens
  assert.ok(s.cs.messages('mf-a').filter(m => ['tok-mf-a-0020', 'tok-mf-a-0021', 'tok-mf-a-0022'].includes(m.token ?? '')).every(m => fileRows(s, 'mf-a').some(r => r.message === m.id)))
})

test('a route that becomes invalid or moves while the files publish: nothing partial, nothing elsewhere', async () => {
  s.ds.create('mf-g', { title: 'group', by: 'Pat', members: ['front', 'forge'], defaultTo: null })
  // the addressee leaves while the bundle is being written: refused, no message, the bundle kept for the retry
  s.ds.testHooks.afterPublish = async () => { s.ds.leave('mf-g', 'forge', { by: 'Pat' }) }
  const c0 = counts(s, 'mf-g')
  await assert.rejects(s.ds.post('mf-g', { text: 'for forge', author: 'Pat', token: 'tok-mf-g-0001', to: ['forge'], files: decodeFiles([wire('f.txt', 'f')]) }), (e: unknown) => e instanceof RequestError && (e.detail as { code: string }).code === 'left')
  s.ds.testHooks = {}
  assert.deepEqual([counts(s, 'mf-g').messages, counts(s, 'mf-g').requests, counts(s, 'mf-g').files], [c0.messages, c0.requests, c0.files])
  assert.equal(s.ds.upload('mf-g', 'tok-mf-g-0001')!.state, 'published')
  s.ds.join('mf-g', 'forge', { by: 'Pat' })
  const ok = await s.ds.post('mf-g', { text: 'for forge', author: 'Pat', token: 'tok-mf-g-0001', to: ['forge'], files: decodeFiles([wire('f.txt', 'f')]) })
  assert.deepEqual(ok.invitations.map(i => i.participant), ['forge'])
  // the default addressee changes between routing and writing: routed again from the new state
  s.ds.setDefault('mf-g', 'front', { by: 'Pat' })
  let n = 0
  s.ds.testHooks.beforeAccept = async () => { if (n++ === 0) s.ds.setDefault('mf-g', 'forge', { by: 'Pat' }) }
  const moved = await s.ds.post('mf-g', { text: 'to whoever is default', author: 'Pat', token: 'tok-mf-g-0002', files: decodeFiles([wire('d.txt', 'd')]) })
  s.ds.testHooks = {}
  assert.equal(n, 2)
  assert.deepEqual(moved.invitations.map(i => i.participant), ['forge'])
  assert.deepEqual(JSON.parse(moved.message.addressed!), ['forge'])
  // the storage destination changes while publishing: the reserved destination is kept
  s.ds.testHooks.afterStaging = async () => { await writeFile(join(s.area, 'attachments.json'), JSON.stringify({ share: 'testshare', prefix: 'elsewhere' })) }
  const kept = await s.ds.post('mf-g', { text: 'dest', author: 'Pat', token: 'tok-mf-g-0003', to: ['front'], files: decodeFiles([wire('k.txt', 'k')]) })
  s.ds.testHooks = {}
  const row = fileRows(s, 'mf-g').find(r => r.message === kept.message.id)!
  assert.match(row.ref, /^shared:\/\/testshare\/conversations\/mf-g\/attachments\//)
  await writeFile(join(s.area, 'attachments.json'), JSON.stringify({ share: 'testshare', prefix: 'conversations' }))
  // a message nobody can receive publishes nothing
  s.ds.setDefault('mf-g', null, { by: 'Pat' })
  const u0 = counts(s, 'mf-g').uploads
  await assert.rejects(s.ds.post('mf-g', { text: 'to nobody', author: 'Pat', token: 'tok-mf-g-0004', files: decodeFiles([wire('n.txt', 'n')]) }), (e: unknown) => e instanceof RequestError && (e.detail as { code: string }).code === 'choose-recipient')
  assert.equal(counts(s, 'mf-g').uploads, u0)
})

test('limits and malformed input are refused before decoding; a share outage refuses files and keeps text working', async () => {
  const code = (c: string) => (e: unknown) => e instanceof RequestError && (e.detail as { code: string }).code === c
  assert.throws(() => decodeFiles(Array.from({ length: FILE_LIMITS.files + 1 }, (_, i) => wire(`${i}.txt`, 'x'))), code('attachment-limit'))
  assert.equal(decodeFiles(Array.from({ length: FILE_LIMITS.files }, (_, i) => wire(`${i}.txt`, 'x'))).length, FILE_LIMITS.files)
  const big = 'A'.repeat(Math.ceil((FILE_LIMITS.fileBytes + 3) / 3) * 4)
  assert.throws(() => decodeFiles([{ name: 'big.bin', base64: big }]), code('attachment-limit'))
  const atLimit = Buffer.alloc(FILE_LIMITS.fileBytes, 1).toString('base64')
  assert.equal(decodeFiles([{ name: 'edge.bin', base64: atLimit }])[0]!.bytes.length, FILE_LIMITS.fileBytes)
  assert.throws(() => decodeFiles([{ name: 'a', base64: atLimit }, { name: 'b', base64: atLimit }, { name: 'c', base64: 'AAAA' }]), code('attachment-limit'))
  for (const b64 of ['abc', 'ab!=', 'data:image/png;base64,AAAA', 'AA==AA==', 'AAAA\nAAAA']) assert.throws(() => decodeFiles([{ name: 'x', base64: b64 }]), code('invalid-attachment'), b64)
  for (const name of ['', '../x', 'a/b', 'a\\b', 'a\u0000b', 'x'.repeat(256)]) assert.throws(() => decodeFiles([{ name, base64: 'AAAA' }]), code('invalid-attachment'), JSON.stringify(name))
  assert.throws(() => decodeFiles([{ name: 'x', base64: 'AAAA', mime: 'not a type' }]), code('invalid-attachment'))
  assert.throws(() => decodeFiles('nope'), code('invalid-attachment'))
  // the share is down: files are refused as unavailable, nothing is reserved, text still goes
  await rm(join(s.share, '.wfe-share.json'))
  const u0 = counts(s, 'mf-a').uploads
  await assert.rejects(s.ds.post('mf-a', { text: 'with a file', author: 'Pat', token: 'tok-mf-a-0030', files: decodeFiles([wire('o.txt', 'o')]) }), code('storage-unavailable'))
  assert.equal(counts(s, 'mf-a').uploads, u0)
  const text = await s.ds.post('mf-a', { text: 'text still works', author: 'Pat', token: 'tok-mf-a-0031' })
  assert.equal(text.invitations[0]!.state, 'started')
  await writeFile(join(s.share, '.wfe-share.json'), JSON.stringify({ share: 'testshare' }))
})

test('serving: images by their bytes, active content as downloads, missing and altered bytes explicit', async () => {
  assert.deepEqual(servedAs('x.png', PNG), { preview: 'image', served: 'image/png' })
  assert.deepEqual(servedAs('photo.png', Buffer.from('<svg onload=alert(1)>')), { preview: null, served: 'application/octet-stream' })
  assert.deepEqual(servedAs('x.svg', Buffer.from('<svg/>')), { preview: null, served: 'application/octet-stream' })
  assert.deepEqual(servedAs('x.html', Buffer.from('<script>')), { preview: null, served: 'application/octet-stream' })
  const p = await s.ds.post('mf-a', { text: 'media', author: 'Pat', token: 'tok-mf-a-0040', files: decodeFiles([wire('pic.png', PNG, 'image/png'), wire('page.html', '<script>alert(1)</script>', 'text/html'), wire('fake.png', '<svg onload=alert(1)/>', 'image/png')]) })
  const rows = fileRows(s, 'mf-a').filter(r => r.message === p.message.id)
  const { createHandler } = await import('../server/api.ts')
  const server: Server = createServer(createHandler({ registryFile: s.registry, allowedOrigins: [], exec: s.x, conversations: s.cs }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/conversations/mf-a`
  try {
    const get = (path: string, method = 'GET') => fetch(`${base}${path}`, { method })
    const img = await get(`/messages/${p.message.id}/attachments/${rows[0]!.attachment}`)
    assert.equal(img.status, 200)
    assert.equal(img.headers.get('content-type'), 'image/png')
    assert.match(img.headers.get('content-disposition')!, /^inline; filename="pic.png"/)
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(img.headers.get('content-security-policy'), 'sandbox')
    assert.ok(Buffer.from(await img.arrayBuffer()).equals(PNG))
    const dl = await get(`/messages/${p.message.id}/attachments/${rows[0]!.attachment}?download=1`)
    assert.match(dl.headers.get('content-disposition')!, /^attachment;/)
    assert.equal(dl.headers.get('content-type'), 'application/octet-stream')
    for (const r of rows.slice(1)) {
      const a = await get(`/messages/${p.message.id}/attachments/${r.attachment}`)
      assert.equal(a.headers.get('content-type'), 'application/octet-stream', r.name)
      assert.match(a.headers.get('content-disposition')!, /^attachment;/)
    }
    const head = await get(`/messages/${p.message.id}/attachments/${rows[0]!.attachment}`, 'HEAD')
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(PNG.length))
    // the whole identity: another message's id with this file is not found
    const other = fileRows(s, 'mf-a').find(r => r.message !== p.message.id)!
    assert.equal((await get(`/messages/${p.message.id}/attachments/${other.attachment}`)).status, 404)
    assert.equal(((await (await get(`/messages/${p.message.id}/attachments/f-000000000000000000000000`)).json()) as { detail: { code: string } }).detail.code, 'attachment-not-found')
    const list = await (await get(`/messages/${p.message.id}/attachments`)).json() as { attachments: { id: string }[] }
    assert.deepEqual(list.attachments.map(a => a.id), rows.map(r => r.attachment))
    const limits = await (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/conversations`)).json() as { attachmentFiles: { available: boolean; files: number } }
    assert.deepEqual([limits.attachmentFiles.available, limits.attachmentFiles.files], [true, 20])
    // altered: same size, other bytes; missing: gone. Metadata and history stay.
    const dir = bundleDir(s, 'mf-a', rows[0]!.bundle)
    const flipped = Buffer.from(PNG); flipped[PNG.length - 1] ^= 1
    await writeFile(join(dir, rows[0]!.attachment), flipped)
    const alt = await get(`/messages/${p.message.id}/attachments/${rows[0]!.attachment}`)
    assert.deepEqual([alt.status, ((await alt.json()) as { detail: { code: string } }).detail.code], [409, 'attachment-integrity'])
    await rm(join(dir, rows[1]!.attachment))
    const gone = await get(`/messages/${p.message.id}/attachments/${rows[1]!.attachment}`)
    assert.deepEqual([gone.status, ((await gone.json()) as { detail: { code: string } }).detail.code], [410, 'attachment-missing'])
    const ver = await (await get(`/attachments/verify?message=${p.message.id}`)).json() as { files: { name: string; state: string }[] }
    assert.deepEqual(ver.files.map(f => [f.name, f.state]), [['pic.png', 'altered'], ['page.html', 'missing'], ['fake.png', 'verified']])
    const v = await s.ds.view('mf-a')
    assert.equal(v.messages.find(m => m.id === p.message.id)!.attachments!.length, 3)
    // a POST over HTTP: a file-only message through the route a page uses
    const post = await fetch(`${base}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'tok-mf-a-0041', files: [wire('http.png', PNG, 'image/png')] }) })
    const pb = await post.json() as { message: { text: string; attachments: { kind: string; name: string; preview: string }[] } }
    assert.equal(post.status, 200, JSON.stringify(pb))
    assert.deepEqual([pb.message.text, pb.message.attachments.map(a => [a.kind, a.name, a.preview])], ['', [['file', 'http.png', 'image']]])
    const bad = await fetch(`${base}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'tok-mf-a-0042', files: [{ name: 'x', base64: '@@@@' }] }) })
    assert.deepEqual([bad.status, ((await bad.json()) as { detail: { code: string } }).detail.code], [400, 'invalid-attachment'])
    const empty = await fetch(`${base}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'tok-mf-a-0043', text: '' }) })
    assert.equal(empty.status, 400)
  } finally { server.close() }
})

test('every delivery path carries the files with their source message: answer, instruction, conductor wake, a later request', async () => {
  // an answer to an open question of the run that asked
  const p = await s.ds.post('mf-q', { text: 'start', author: 'Pat', token: 'tok-mf-q-0001', with: 'front' })
  const run = p.invitations[0]!.run!
  const ws = s.ws('front'), ref = refOf(run)
  const sp = await runSpace(ws, ref)
  await runOp(sp, ref, { op: 'node.start', node: 'talk' }, { by: 'front-agent', via: 'cli' })
  await runOp(sp, ref, { op: 'question.ask', node: 'talk', question: 'q1', text: 'Which screenshot?', to: 'Pat' }, { by: 'front-agent', via: 'cli' })
  const asked = await s.ds.contribute('mf-q', { text: 'Which screenshot?', author: 'front-agent', run, kind: 'question', question: 'q1', re: [p.message.id] })
  const ans = await s.ds.post('mf-q', { text: '', author: 'Pat', token: 'tok-mf-q-0002', re: [asked.message.id], files: decodeFiles([wire('answer.png', PNG)]) })
  assert.equal(ans.invitations[0]!.role, 'deliver')
  assert.equal(ans.invitations[0]!.state, 'started', ans.invitations[0]!.error ?? '')
  const r1 = await rec(s, run)
  const answer = r1.questions.q1!.answers.at(-1)!
  assert.equal(answer.text, '')
  const src = answer.source!
  assert.ok(src.kind === 'conversation' && src.message === ans.message.id)
  assert.deepEqual(src.kind === 'conversation' ? src.attachments!.map(a => [a.kind, a.kind === 'file' ? a.name : '']) : [], [['file', 'answer.png']])
  assert.match(attachedLines(src).join('\n'), /file: "answer\.png" .*wfe conversation fetch mf-q --message \d+ --attachment f-/)
  // an explicit instruction to that run
  const ins = await s.ds.post('mf-q', { text: 'also this', author: 'Pat', token: 'tok-mf-q-0003', runs: [run], files: decodeFiles([wire('extra.txt', 'e')]) })
  assert.equal(ins.invitations[0]!.state, 'started', ins.invitations[0]!.error ?? '')
  const r2 = await rec(s, run)
  const i = Object.values(r2.instructions ?? {}).at(-1)!
  assert.ok(i.source?.kind === 'conversation' && i.source.attachments!.some(a => a.kind === 'file' && a.name === 'extra.txt' && a.message === ins.message.id))
  // a later request citing the attached message gives that occurrence to the new run
  const later = await s.ds.invite('mf-q', { participant: 'forge', question: 'Look at the screenshot the person sent', re: [ans.message.id], by: 'Pat' })
  assert.equal(later.invitation.state, 'started', later.invitation.error ?? '')
  const r3 = await rec(s, later.invitation.run!)
  assert.deepEqual(r3.input.attachments!.map(a => a.kind === 'file' ? [a.name, a.message] : []), [['answer.png', ans.message.id]])
  // a standing conductor: the first words start it; files sent while it rests wake it with them
  s.ds.create('mf-c', { title: 'led', by: 'Pat', members: ['forge'], facilitate: true })
  const led = await s.ds.post('mf-c', { text: 'lead this', author: 'Pat', token: 'tok-mf-c-0001', files: decodeFiles([wire('brief.txt', 'b')]) })
  const conductor = led.invitations[0]!.run!
  const rc = await rec(s, conductor)
  assert.ok(rc.standing, 'the conductor stands')
  assert.deepEqual(rc.input.attachments!.map(a => a.kind === 'file' ? a.name : ''), ['brief.txt'])
  const cref = refOf(conductor)
  const csp = await runSpace(s.ws('ponderer'), cref)
  await runOp(csp, cref, { op: 'node.start', node: 'talk' }, { by: 'ponderer-agent', via: 'cli' })
  await runOp(csp, cref, { op: 'node.complete', node: 'talk', outcome: 'spoke' }, { by: 'ponderer-agent', via: 'cli' })
  const wake = await s.ds.post('mf-c', { text: '', author: 'Pat', token: 'tok-mf-c-0002', files: decodeFiles([wire('second.png', PNG)]) })
  assert.equal(wake.invitations[0]!.run, conductor)
  assert.equal(wake.invitations[0]!.state, 'started', wake.invitations[0]!.error ?? '')
  const rw = await rec(s, conductor)
  const wi = Object.values(rw.instructions ?? {}).at(-1)!
  assert.ok(wi.source?.kind === 'conversation' && wi.source.attachments!.some(a => a.kind === 'file' && a.name === 'second.png'))
  // reading starts nothing
  const before = s.ds.invitations('mf-q').length
  await s.ds.view('mf-q')
  assert.equal(s.ds.invitations('mf-q').length, before)
})

test('archive keeps associations and manifests; export packages the originals; restore verifies without replaying', async () => {
  const a = new ConversationArchive(s.ds)
  const pub = await a.publish(['mf-a'])
  assert.deepEqual(pub.failed, [], JSON.stringify(pub.failed))
  const st = await a.status('mf-a')
  const clone = join(root, 'archive-clone')
  await gitOk(root, ['clone', '-q', join(s.area, 'ponderer-origin.git'), clone])
  const lines = (await readFile(join(clone, st.path, 'transcript.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l) as { type: string; id?: number; attachments?: { kind: string; id: string; bundle?: string }[] })
  const withFiles = lines.filter(l => l.type === 'message' && l.attachments?.some(x => x.kind === 'file'))
  assert.ok(withFiles.length >= 3)
  const bundles = new Set(fileRows(s, 'mf-a').map(r => r.bundle))
  for (const b of bundles) {
    const m = JSON.parse(await readFile(join(clone, st.path, 'attachments', b, 'manifest.json'), 'utf8')) as Manifest
    assert.equal(manifestDigest(m), m.digest)
  }
  // export a conversation whose bytes are intact
  const out = join(root, 'export-q')
  const pkg = await a.exportPackage('mf-q', out, 'Pat')
  assert.ok(pkg.files.length >= 2)
  const into = join(root, 'restore-q')
  const inv0 = s.ds.invitations('mf-q').length
  const restored = await restorePackage(out, into)
  assert.deepEqual(restored.problems, [])
  assert.equal(restored.verified, 1 + pkg.manifests.length + pkg.files.length)
  for (const f of pkg.files) assert.equal(sha(await readFile(join(into, f.path))), f.sha256)
  assert.ok(restored.messages.every(m => m.files.every(f => pkg.files.find(p => p.attachment === f.attachment)!.message === m.message)))
  assert.equal(s.ds.invitations('mf-q').length, inv0, 'restoring started nothing')
  // a tampered package is reported, never silently restored
  const f0 = pkg.files[0]!
  await writeFile(join(out, f0.path), 'tampered')
  const bad = await restorePackage(out, join(root, 'restore-q2'))
  assert.ok(bad.problems.some(p => p.includes(f0.path)))
  // an export of a conversation with altered bytes stops with the reason
  await assert.rejects(a.exportPackage('mf-a', join(root, 'export-a'), 'Pat'), (e: unknown) => e instanceof RequestError && ['attachment-integrity', 'attachment-missing'].includes((e.detail as { code: string }).code))
})

test('the CLI: post --attach, list, fetch on this host, and fetch from another host without the share', async () => {
  const { execFile } = await import('node:child_process')
  const wfe = (args: string[], env: Record<string, string | undefined> = {}) => new Promise<{ code: number; stdout: string; stderr: string }>(done => {
    const e: Record<string, string | undefined> = { ...process.env, WFE_REGISTRY: s.registry, ...env }
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k]
    execFile('node', [join(import.meta.dirname, '..', 'cli', 'wfe.ts'), 'conversation', ...args], { env: e as NodeJS.ProcessEnv, cwd: root }, (err, stdout, stderr) => done({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout, stderr }))
  })
  const png = join(root, 'cli shot.png')
  await writeFile(png, PNG)
  const posted = await wfe(['post', 'mf-cli', '--with', 'front', '--author', 'Pat', '--attach', png, '--token', 'tok-mf-cli-0001', '--json'])
  assert.equal(posted.code, 0, posted.stderr)
  const pj = JSON.parse(posted.stdout) as { message: { id: number; text: string }; files: { attachment: string; name: string }[] }
  assert.deepEqual([pj.message.text, pj.files.map(f => f.name)], ['', ['cli shot.png']])
  const n = pj.message.id, id = pj.files[0]!.attachment
  const listed = await wfe(['attachments', 'mf-cli', '--message', String(n), '--check-bytes'])
  assert.equal(listed.code, 0, listed.stderr)
  assert.match(listed.stdout, new RegExp(`#${n}\\.1 ${id}  cli shot\\.png  image/png.*verified`))
  const here = await wfe(['fetch', 'mf-cli', '--message', String(n), '--attachment', id])
  assert.equal(here.code, 0, here.stderr)
  assert.match(here.stdout, /read from the share on this host/)
  assert.ok((await readFile(join(root, '.local', 'attachments', 'mf-cli', `m${n}`, '1-cli shot.png'))).equals(PNG))
  // another host: no registry, no share mounted, only the coordinator's address
  const { createHandler } = await import('../server/api.ts')
  const server: Server = createServer(createHandler({ registryFile: s.registry, allowedOrigins: [], exec: s.x, conversations: s.cs }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  try {
    const away = join(root, 'other-host')
    await mkdir(away, { recursive: true })
    const env = { WFE_REGISTRY: undefined, WFE_AREA: away, WFE_SERVICE: `http://127.0.0.1:${(server.address() as { port: number }).port}/` }
    const remoteList = await wfe(['attachments', 'mf-cli', '--message', String(n)], env)
    assert.equal(remoteList.code, 0, remoteList.stderr)
    assert.match(remoteList.stdout, new RegExp(id))
    const out = join(away, 'got.png')
    const remote = await wfe(['fetch', 'mf-cli', '--message', String(n), '--attachment', id, '--out', out], env)
    assert.equal(remote.code, 0, remote.stderr)
    assert.match(remote.stdout, /downloaded from the coordinator \(the share is unavailable here\)/)
    assert.equal(sha(await readFile(out)), sha(PNG))
    // a wrong identity is refused and writes nothing
    const wrong = await wfe(['fetch', 'mf-cli', '--message', String(n), '--attachment', 'f-000000000000000000000000', '--out', join(away, 'nothing')], env)
    assert.notEqual(wrong.code, 0)
    await assert.rejects(readFile(join(away, 'nothing')))
  } finally { server.close() }
  // export and restore through the CLI
  const ex = await wfe(['export', 'mf-cli', '--out', join(root, 'cli-export')])
  assert.equal(ex.code, 0, ex.stderr)
  const re = await wfe(['restore', join(root, 'cli-export'), '--into', join(root, 'cli-restore')])
  assert.equal(re.code, 0, re.stderr)
  assert.match(re.stdout, new RegExp(`#${n}: 1\\. cli shot\\.png \\(${id}\\)`))
})
