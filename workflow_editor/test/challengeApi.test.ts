// The challenge contract over HTTP and the CLI (challenge p1,
// docs/challenges.md *HTTP*): the same store behind both; a page writes as
// the configured person, a trial as its named author, the CLI as --by; a
// stale base answers 409 with the current record; pinned and current reads
// are told apart; the CLI goes through a service with --service; reads and
// writes start no run.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandler } from '../server/api.ts'
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
  const c = await post('', { request: 'page-create-001', title: 'Edge remnants', body: 'From the chat.', projects: ['gimmickimg'], source: { conversation: 'conv-a', message: 310 }, evidence: [{ name: 'note.txt', base64: Buffer.from('evidence').toString('base64') }] })
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
  const ev = await fetch(`${base}/${id}/evidence/note.txt?at=${first}`)
  assert.equal(await ev.text(), 'evidence')
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
