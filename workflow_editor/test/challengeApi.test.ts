// The challenge contract over HTTP and the CLI (challenge p1,
// docs/challenges.md *HTTP*): the same store behind both; a page writes as
// the configured person, a trial as its named author, the CLI as --by; a
// stale base answers 409 with the current record; pinned and current reads
// are told apart; the CLI goes through a service with --service; reads and
// writes start no run; a trial is published from a local directory and
// read back file by file at a pinned commit; an oversized body is refused
// before it is read.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandler } from '../server/api.ts'
import { MAX_REQUEST } from '../server/challengeApi.ts'
import { gitOk } from '../server/git.ts'

let root = '', base = '', server: Server
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-challenge-api-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
  await gitOk(root, ['init', '-q', '--bare', '-b', 'main', join(root, 'remote.git')])
  await writeFile(join(root, 'challenges.json'), JSON.stringify({ repository: join(root, 'remote.git') }))
  await writeFile(join(root, 'conversations.json'), JSON.stringify({ person: 'iwaag', targets: [] }))
  await writeFile(join(root, 'registry.json'), JSON.stringify({ workspaces: [] }))
  server = createServer(createHandler({ registryFile: join(root, 'registry.json'), area: root, allowedOrigins: [] }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/challenges`
})
after(async () => { server.close(); await rm(root, { recursive: true, force: true }) })

const post = async (path: string, body: unknown, origin?: string) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() as Record<string, any> }
}
const get = async (path: string) => { const r = await fetch(`${base}${path}`); return { status: r.status, body: await r.json() as Record<string, any> } }
const wfe = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
  execFile('node', ['cli/wfe.ts', 'challenge', ...args], { env: { ...process.env, WFE_REGISTRY: join(root, 'registry.json'), ...env } }, (e, stdout, stderr) => resolve({ code: e ? (e as { code?: number }).code ?? 1 : 0, stdout, stderr }))
})

test('a page records, reads and edits as the person; pinned and current reads differ', async () => {
  const c = await post('', { request: 'page-create-001', title: 'Edge remnants', body: 'From the chat.', projects: ['gimmickimg'], source: { conversation: 'conv-a', message: 310 }, files: [{ name: 'note.txt', base64: Buffer.from('evidence').toString('base64') }] })
  assert.equal(c.status, 200)
  assert.equal(c.body.publication.state, 'published')
  assert.equal(c.body.record.created.by, 'iwaag')
  const id = c.body.record.id as string
  const first = c.body.record.commit as string
  // another site cannot write
  assert.equal((await post('', { request: 'page-create-002', title: 'x', body: '' }, 'http://evil.example')).status, 403)
  const e = await post(`/${id}`, { request: 'page-edit-0001', base: first, body: 'From the chat. Edited.', author: 'Omni Agent (test actor)' })
  assert.equal(e.status, 200)
  assert.equal(e.body.record.updated.by, 'Omni Agent (test actor)')
  const stale = await post(`/${id}`, { request: 'page-edit-0002', base: first, title: 'Mine' })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.detail.code, 'conflict')
  assert.equal(stale.body.detail.current.commit, e.body.record.commit)
  const pinned = await get(`/${id}?at=${first}`)
  assert.equal(pinned.body.pinned, true)
  assert.equal(pinned.body.challenge.body, 'From the chat.')
  assert.equal(pinned.body.latest.commit, e.body.record.commit)
  const ev = await fetch(`${base}/${id}/files/note.txt?at=${first}`)
  assert.equal(await ev.text(), 'evidence')
  assert.equal(ev.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(ev.headers.get('content-security-policy'), 'sandbox')
  const h = await get(`/${id}/history`)
  assert.deepEqual(h.body.history.map((x: { actor: string }) => x.actor), ['Omni Agent (test actor)', 'iwaag'])
  assert.equal(h.body.history[1].source, 'conversation conv-a#310')
  const list = await get('?text=remnants&state=open')
  assert.equal(list.body.total, 1)
  assert.equal(list.body.counts.open, 1)
  assert.deepEqual(list.body.projects, [{ project: 'gimmickimg', count: 1 }])
})

test('the CLI writes as --by, derives a request identity, and works through a service', async () => {
  const a = await wfe(['create', '--title', 'CLI fixture', '--body', 'body', '--project', 'forge', '--by', 'forge-agent', '--for', 'iwaag'], { WFE_ATTEMPT: 'att-1' })
  assert.equal(a.code, 0, a.stderr)
  assert.match(a.stdout, /Recorded ch-0002: published as [0-9a-f]{40}/)
  const again = await wfe(['create', '--title', 'CLI fixture', '--body', 'body', '--project', 'forge', '--by', 'forge-agent', '--for', 'iwaag'], { WFE_ATTEMPT: 'att-1' })
  assert.match(again.stdout, /the same request as before/)
  assert.match(await gitOk(join(root, 'remote.git'), ['log', '-1', '--format=%an %B', 'main']), /^forge-agent [\s\S]*Challenge-On-Behalf-Of: iwaag[\s\S]*Challenge-Attempt: att-1/)
  const show = await wfe(['show', 'ch-0002', '--service', base.replace(/api\/challenges$/, '')])
  assert.equal(show.code, 0, show.stderr)
  assert.match(show.stdout, /ch-0002: CLI fixture\nstate open; projects forge\nrevision [0-9a-f]{40} — edit on it with --base/)
  const rev = /revision ([0-9a-f]{40})/.exec(show.stdout)![1]!
  const r = await wfe(['resolve', 'ch-0002', '--base', rev, '--note', 'fixture resolved', '--by', 'forge-agent', '--service', base.replace(/api\/challenges$/, '')])
  assert.equal(r.code, 0, r.stderr)
  const stale = await wfe(['edit', 'ch-0002', '--base', rev, '--title', 'late', '--by', 'forge-agent'])
  assert.equal(stale.code, 1)
  assert.match(stale.stderr, /changed since/)
  const l = await wfe(['list', '--state', 'resolved'])
  assert.match(l.stdout, /1 challenge\(s\) resolved[\s\S]*ch-0002 {2}resolved/)
  const s = await wfe(['status'])
  assert.match(s.stdout, /index at [0-9a-f]{12}/)
  assert.equal((await wfe(['create', '--title', 'no writer', '--body', 'x'])).code, 2)
})

test('a trial from a local directory: published in one commit, listed, read at its commit; a later trial does not change that read', async () => {
  const svc = base.replace(/api\/challenges$/, '')
  const dir = join(root, 'take')
  await mkdir(join(dir, 'audio'), { recursive: true })
  await writeFile(join(dir, 'summary.md'), '# Stretched\n\n<script>alert(1)</script> [take](audio/out.wav) and [the input](../../voice.wav)\n')
  await writeFile(join(dir, 'audio', 'out.wav'), 'RIFFxxxx')
  const p = await wfe(['publish', 'ch-0002', '--trial', 'speech-stretch', dir, '--by', 'forge-agent', '--run', 'forge/freework/run-001', '--service', svc])
  assert.equal(p.code, 0, p.stderr)
  assert.match(p.stdout, /Published wedo\/speech-stretch of ch-0002: published as ([0-9a-f]{40}) \(operation \d+; 2 file\(s\) added\)/)
  const at = /published as ([0-9a-f]{40})/.exec(p.stdout)![1]!
  assert.match(await gitOk(join(root, 'remote.git'), ['log', '-1', '--format=%an %B', 'main']), /^forge-agent [\s\S]*Challenge-Trial: speech-stretch[\s\S]*Challenge-Run: forge\/freework\/run-001/)
  const later = await wfe(['publish', 'ch-0002', '--trial', 'another', `${join(dir, 'summary.md')}=notes.md`, '--by', 'archsage-agent'])
  assert.equal(later.code, 0, later.stderr)
  const pinned = await get(`/ch-0002?at=${at}`)
  assert.deepEqual(pinned.body.challenge.trials.map((t: { name: string }) => t.name), ['speech-stretch'])
  assert.deepEqual(pinned.body.latest.trials.map((t: { name: string }) => t.name), ['another', 'speech-stretch'])
  assert.equal(pinned.body.challenge.trials[0].summary.title, 'Stretched')
  const wav = await fetch(`${base}/ch-0002/files/wedo/speech-stretch/audio/out.wav?at=${at}`)
  assert.equal(wav.headers.get('content-type'), 'audio/wav')
  assert.equal(await wav.text(), 'RIFFxxxx')
  const dl = await fetch(`${base}/ch-0002/files/wedo/speech-stretch/audio/out.wav?download=1`)
  assert.match(dl.headers.get('content-disposition')!, /^attachment; filename="out.wav"/)
  const out = join(root, 'got', 'out.wav')
  const f = await wfe(['file', 'ch-0002', 'audio/out.wav', '--trial', 'speech-stretch', '--at', at.slice(0, 10), '--out', out, '--service', svc])
  assert.equal(f.code, 0, f.stderr)
  assert.match(f.stdout, /Wrote 8 bytes/)
  const ls = await wfe(['files', 'ch-0002', '--trial', 'speech-stretch'])
  assert.match(ls.stdout, /wedo\/speech-stretch\/audio\/out\.wav {2}8 bytes/)
  const show = await wfe(['show', 'ch-0002'])
  assert.match(show.stdout, /trials \(2;[\s\S]*wedo\/another\/ {2}1 file\(s\), no summary[\s\S]*wedo\/speech-stretch\/ {2}2 file\(s\), summary: Stretched/)
  const h = await get('/ch-0002/history?trial=speech-stretch')
  assert.deepEqual(h.body.history.map((e: { actor: string; trial: string }) => [e.actor, e.trial]), [['forge-agent', 'speech-stretch']])
  // a body larger than one write can be is refused from its declared length, before it is read
  const status = await new Promise<number>((resolve, reject) => {
    const r = request(`${base}/ch-0002`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(MAX_REQUEST + 1) } }, res => { res.resume(); resolve(res.statusCode!) })
    r.on('error', reject)
    r.write('{')
  })
  assert.equal(status, 413)
})
