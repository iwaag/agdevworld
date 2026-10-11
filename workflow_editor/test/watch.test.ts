// pre1 step 4: the watcher's events, on a real project — definition files
// created, changed and deleted, Git state that touches no definition file,
// registry changes, the hello that follows the first snapshot — and the
// client's serial loader.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChangeEvent } from '../shared/api.ts'
import { createHandler } from '../server/api.ts'
import { createProject } from '../server/create.ts'
import { gitOk } from '../server/git.ts'
import { Watcher } from '../server/watch.ts'
import { serial } from '../src/live.ts'

let root = '', dir = '', registry = '', base = ''
let server: Server
let watcher: Watcher

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-watch-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  registry = join(root, 'registry.json')
  dir = join(root, 'pj-w')
  const r = await createProject({ dir, id: 'w', name: 'W', intent: 'x', goals: ['g'], sourcesDir: join(root, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  watcher = new Watcher(100, { gitIntervalMs: 150, registryFile: registry })
  const handler = createHandler({ registryFile: registry, area: root, allowedOrigins: [], allowedHosts: ['127.0.0.1'], watcher })
  server = createServer((req, res) => void handler(req, res))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
after(async () => { server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }) })

// Reads an SSE stream into a list of {event, data}.
async function listen(path: string) {
  const ctrl = new AbortController()
  const res = await fetch(`${base}${path}`, { signal: ctrl.signal })
  const events: { event: string; data: ChangeEvent & Record<string, unknown> }[] = []
  void (async () => {
    let buf = ''
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += Buffer.from(chunk).toString('utf8')
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          const ev = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1]
          if (ev && data) events.push({ event: ev, data: JSON.parse(data) })
        }
      }
    } catch { /* aborted */ }
  })()
  const until = async (pred: () => boolean, ms = 3000) => {
    const t = Date.now()
    while (!pred()) { if (Date.now() - t > ms) return false; await new Promise(r => setTimeout(r, 20)) }
    return true
  }
  return { events, until, close: () => ctrl.abort() }
}
const has = (events: { event: string; data: ChangeEvent }[], fn: (d: ChangeEvent) => boolean) => events.some(e => e.event === 'change' && fn(e.data))

test('hello comes after the first snapshot; definition files created, changed and deleted', async () => {
  const s = await listen('/api/workspaces/w/events')
  assert.ok(await s.until(() => s.events.some(e => e.event === 'hello')))
  assert.equal(watcher.gitKey('w') !== null, true, 'the Git fingerprint is taken before hello')
  const wf = join(dir, 'devdocs', 'workflows', 'a.yaml')
  await writeFile(wf, 'schema: ag.workflow.v1\nid: a\nname: A\nintent: x\n')
  assert.ok(await s.until(() => has(s.events, d => d.kind === 'workflow' && d.file === 'a.yaml' && d.rev !== null) && has(s.events, d => d.kind === 'workflows')), 'creation: file and list events')
  s.events.length = 0
  await writeFile(wf, 'schema: ag.workflow.v1\nid: a\nname: A2\nintent: x\n')
  assert.ok(await s.until(() => has(s.events, d => d.kind === 'workflow' && d.file === 'a.yaml')), 'change')
  s.events.length = 0
  await unlink(wf)
  assert.ok(await s.until(() => has(s.events, d => d.kind === 'workflow' && d.file === 'a.yaml' && d.rev === null) && has(s.events, d => d.kind === 'workflows')), 'deletion: rev null and list event')
  s.close()
})

test('Git state that touches no definition file is reported', async () => {
  const s = await listen('/api/workspaces/w/events')
  assert.ok(await s.until(() => s.events.some(e => e.event === 'hello')))
  const step = async (label: string, act: () => Promise<unknown>) => {
    s.events.length = 0
    await act()
    assert.ok(await s.until(() => has(s.events, d => d.kind === 'git')), label)
  }
  await step('root file created (untracked)', () => writeFile(join(dir, 'NOTES.md'), 'n\n'))
  await step('git add', () => gitOk(dir, ['add', 'NOTES.md']))
  await step('git commit', () => gitOk(dir, ['commit', '-qm', 'notes']))
  await step('submodule becomes dirty', () => writeFile(join(dir, 'devdocs', 'one.md'), '1\n'))
  await step('already dirty submodule changes further', () => writeFile(join(dir, 'devdocs', 'two.md'), '2\n'))
  await step('submodule HEAD moves', async () => { await gitOk(join(dir, 'devdocs'), ['add', '-A']); await gitOk(join(dir, 'devdocs'), ['commit', '-qm', 'docs']) })
  s.close()
})

test('registry changes reach the workspace-less stream; no clients, no work', async () => {
  const s = await listen('/api/events')
  assert.ok(await s.until(() => s.events.some(e => e.event === 'hello')))
  await writeFile(registry, JSON.stringify({ approver: '', workspaces: [{ id: 'w', path: dir }, { id: 'x', path: '/nowhere' }] }))
  assert.ok(await s.until(() => has(s.events, d => d.kind === 'registry')))
  s.close()
  await new Promise(r => setTimeout(r, 200))
  assert.equal(watcher.gitKey('w'), null, 'with every stream closed the workspace is no longer watched')
})

test('serial loads run in order and merge requests made meanwhile', async () => {
  const runs: string[] = []
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const load = serial<{ content: boolean }>(async o => {
    runs.push(o.content ? 'content' : 'context')
    if (runs.length === 1) await gate
  }, (a, b) => ({ content: a.content || b.content }))
  const first = load({ content: false })
  void load({ content: true })
  void load({ content: false }) // must not downgrade the pending content load
  release()
  await first
  assert.deepEqual(runs, ['context', 'content'])
})
