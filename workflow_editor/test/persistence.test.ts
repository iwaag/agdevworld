// Steps 3–4: saving through the service, reopening, and the HTTP boundary.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seed } from '../scripts/seed.ts'
import { createHandler } from '../server/api.ts'
import { loadRegistry } from '../server/registry.ts'
import { Workspace } from '../server/workspace.ts'
import { cloneWorkflow, type Workflow } from '../shared/model.ts'

let root = ''
let ws: Workspace
let server: Server
let base = ''
const ORIGIN = 'http://127.0.0.1:5175'

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-persist-'))
  await rm(root, { recursive: true })
  await seed(root, false)
  const reg = await loadRegistry(join(root, 'registry.json'))
  ws = new Workspace(reg.workspaces.find(w => w.id === 'a')!)
  server = createServer(createHandler({ registryFile: join(root, 'registry.json'), allowedOrigins: [ORIGIN], allowedHosts: ['127.0.0.1', 'localhost'] }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
after(async () => {
  server.close()
  await rm(root, { recursive: true, force: true })
})

const path = (file: string) => join(ws.root, 'devdocs/workflows', file)

async function model(file: string): Promise<Workflow> {
  const r = await ws.readWorkflowFile(file)
  assert.ok(r.workflow, r.problem?.message)
  return r.workflow
}

test('a UI-style edit saves, reopens to the same model and text, and a no-op save writes nothing', async () => {
  const w = await model('onboarding.yaml')
  const original = await readFile(path('onboarding.yaml'), 'utf8')
  const draft = cloneWorkflow(w)
  draft.nodes.check = { type: 'study', name: 'Check', description: 'A new study node.', repositories: ['tools'] }
  draft.edges.push({ from: 'survey', to: 'check' }, { from: 'check', to: 'integrate' })
  draft.layout.nodes = { survey: { x: 40, y: 40 }, check: { x: 340, y: 400 } }
  draft.nodes.review.description = 'Agree on scope with the owner.'
  const saved = await ws.saveWorkflow('onboarding.yaml', draft)
  const text = await readFile(path('onboarding.yaml'), 'utf8')
  assert.equal(saved.text, text)
  assert.notEqual(text, original)
  assert.match(text, /^# Onboarding: all four node types/) // header comment kept
  assert.match(text, /  - \{from: survey, to: check\}\n/) // flow style continued
  const reopened = await model('onboarding.yaml')
  assert.deepEqual(reopened, draft)
  const { mtimeMs } = await import('node:fs/promises').then(fs => fs.stat(path('onboarding.yaml')))
  await new Promise(r => setTimeout(r, 20))
  await ws.saveWorkflow('onboarding.yaml', reopened)
  assert.equal(await readFile(path('onboarding.yaml'), 'utf8'), text)
  assert.equal((await import('node:fs/promises').then(fs => fs.stat(path('onboarding.yaml')))).mtimeMs, mtimeMs, 'no write for an unchanged model')
})

test('deleting a node removes it, its edges and its position from the file', async () => {
  const draft = await model('onboarding.yaml')
  delete draft.nodes.check
  draft.edges = draft.edges.filter(e => e.from !== 'check' && e.to !== 'check')
  delete draft.layout.nodes.check
  await ws.saveWorkflow('onboarding.yaml', draft)
  const text = await readFile(path('onboarding.yaml'), 'utf8')
  assert.doesNotMatch(text, /\bcheck\b/)
  assert.deepEqual(await model('onboarding.yaml'), draft)
})

test('saves are atomic: no temporary files remain, and a failed rename leaves the old file', async () => {
  const fs = await import('node:fs/promises')
  const files = await fs.readdir(join(ws.root, 'devdocs/workflows'))
  assert.ok(!files.some(f => f.endsWith('.tmp')))
  // Make the directory unwritable: the temp file cannot be created; the
  // original is untouched and the error surfaces.
  const before = await readFile(path('repo-setup.yaml'), 'utf8')
  const draft = await model('repo-setup.yaml')
  draft.name = 'Changed while unwritable'
  await fs.chmod(join(ws.root, 'devdocs/workflows'), 0o555)
  try {
    await assert.rejects(ws.saveWorkflow('repo-setup.yaml', draft), (e: NodeJS.ErrnoException) => e.code === 'EACCES')
  } finally {
    await fs.chmod(join(ws.root, 'devdocs/workflows'), 0o755)
  }
  assert.equal(await readFile(path('repo-setup.yaml'), 'utf8'), before)
  assert.ok(!(await fs.readdir(join(ws.root, 'devdocs/workflows'))).some(f => f.endsWith('.tmp')))
})

test('malformed or unsupported content on disk is never overwritten by a save', async () => {
  const draft = await model('repo-setup.yaml')
  for (const bad of ['schema: ag.workflow.v1\nnodes: {a: [unclosed\n', 'schema: ag.workflow.v1\nid: &x repo-setup\nname: *x\n']) {
    await writeFile(path('repo-setup.yaml'), bad)
    await assert.rejects(ws.saveWorkflow('repo-setup.yaml', draft), /cannot be read/)
    assert.equal(await readFile(path('repo-setup.yaml'), 'utf8'), bad)
  }
  await writeFile(path('repo-setup.yaml'), await readFile(new URL('../examples/project/workflows/repo-setup.yaml', import.meta.url), 'utf8'))
})

test('HTTP: browser writes need the configured origin; hosts are local only', async () => {
  const draft = await model('repo-setup.yaml')
  const put = (headers: Record<string, string>) => fetch(`${base}/api/workspaces/a/workflows/repo-setup.yaml`, {
    method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ workflow: draft }),
  })
  assert.equal((await put({ origin: 'http://evil.example' })).status, 403)
  assert.equal((await put({ origin: ORIGIN })).status, 200)
  assert.equal((await put({})).status, 200, 'non-browser local clients send no Origin')
  const form = await fetch(`${base}/api/workspaces/a/workflows/repo-setup.yaml`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: '{}' })
  assert.equal(form.status, 415)
  // fetch() drops a custom Host header, so this request goes through node:http.
  const { request } = await import('node:http')
  const rebinding = await new Promise<number>((resolve, reject) => {
    request(`${base}/api/workspaces`, { headers: { host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode ?? 0) }).on('error', reject).end()
  })
  assert.equal(rebinding, 403)
  const traversal = await fetch(`${base}/api/workspaces/a/workflows/..%2F..%2Fproject.yaml`)
  assert.equal(traversal.status, 400)
  const bad = await fetch(`${base}/api/workspaces/a/workflows/repo-setup.yaml`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow: { nodes: [] } }) })
  assert.equal(bad.status, 400)
  const missing = await fetch(`${base}/api/workspaces/gone/project`)
  assert.equal(missing.status, 409)
})

test('HTTP: a workflow response carries validation, approvals and the project context', async () => {
  const r = await fetch(`${base}/api/workspaces/a/workflows/draft-gaps.yaml`).then(x => x.json())
  assert.equal(r.issues.filter((i: { severity: string }) => i.severity === 'error').length, 4)
  assert.equal(r.approvals.intent.status, 'unapproved')
  assert.ok(r.repositories.some((x: { path: string }) => x.path === 'assets/shared'))
  assert.deepEqual(r.workflows.map((x: { id: string }) => x.id).sort(), ['draft-gaps', 'onboarding', 'repo-setup'])
})
