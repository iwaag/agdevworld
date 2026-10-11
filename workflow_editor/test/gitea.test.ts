// p4 stage 2: Gitea and global resources against a disposable Gitea
// (test/giteaFixture.ts) — creation in both modes with relative URLs and no
// credentials in files, fresh workspaces from Gitea, recovery after partial
// failure, collisions and intentional reuse, shared repositories pinned per
// project, registration of existing projects, and the dashboard's sources.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { gitOk } from '../server/git.ts'
import { Gitea } from '../server/gitea.ts'
import { addSharedRepository, createSharedRepository, dashboard, obtainWorkspace, registerGiteaProject, registerSharedRepository, type AgdevContext } from '../server/agdev.ts'
import { loadRegistry } from '../server/registry.ts'
import { createRun, readRun, runOp, runResponse } from '../server/runs.ts'
import { Workspace } from '../server/workspace.ts'
import { dockerAvailable, startGitea, type TestGitea } from './giteaFixture.ts'

const skip = !(await dockerAvailable()) && !process.env.WFE_TEST_GITEA
let tg: TestGitea
let root = '', area = '', registry = ''
let ctx: AgdevContext

before(async () => {
  if (skip) return
  root = await mkdtemp(join(tmpdir(), 'wfe-gitea-test-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  area = join(root, 'area')
  registry = join(area, 'registry.json')
  tg = await startGitea()
  ctx = { registryFile: registry, area, gitea: tg.gitea }
})
after(async () => {
  if (skip) return
  await tg.stop()
  await rm(root, { recursive: true, force: true })
})

const WF = `schema: ag.workflow.v1
id: ship
name: Ship
intent: |
  Ship something.
repositories:
  docs: {path: devdocs, access: editable}
nodes:
  build:
    type: do
    description: Build it.
edges: []
`
const create = (id: string, devdocs: 'directory' | 'submodule', extra = {}) =>
  createProject({ dir: join(area, `pj-${id}`), id, name: id.toUpperCase(), intent: `Why ${id} exists.`, goals: ['g'], devdocs, registryFile: registry, gitea: tg.gitea, ...extra })
const token = async () => (await readFile(tg.gitea.setting.tokenFile, 'utf8')).trim()
const ownerOf = () => tg.gitea.owner

// Everything under `dir` that Git tracks or configures, as text.
async function trackedText(dir: string): Promise<string> {
  const files = (await gitOk(dir, ['ls-files', '--recurse-submodules'])).split('\n').filter(Boolean)
  const parts = await Promise.all(files.map(f => readFile(join(dir, f), 'utf8').catch(() => '')))
  return [...parts, await gitOk(dir, ['config', '--list', '--local']).catch(() => '')].join('\n')
}

test('directory mode: created on Gitea, pushed, registered; no credentials or host paths in tracked files', { skip }, async () => {
  const r = await create('alpha', 'directory')
  assert.ok(r.ok, r.message)
  assert.deepEqual(r.steps.map(s => s.name), ['destination', 'gitea root', 'root repository', 'project.yaml', '.gitignore', 'devdocs directory', 'initial commit', 'push', 'project registration', 'registration'].filter(Boolean))
  const repo = await tg.gitea.repo(ownerOf(), 'pj-alpha')
  assert.ok(repo && await tg.gitea.hasContent(repo.owner, repo.name), 'the root is on Gitea with content')
  const reg = await loadRegistry(registry)
  assert.deepEqual(reg.projects.map(p => p.id), ['alpha'])
  assert.equal(reg.repositories.find(x => x.gitea.id === repo!.id)?.category, 'root')
  assert.equal(reg.workspaces.find(w => w.id === 'alpha')?.project, 'alpha')
  const dir = join(area, 'pj-alpha')
  const text = await trackedText(dir)
  assert.ok(!text.includes(await token()), 'the token is in no tracked file or local Git config')
  assert.ok(!text.includes(root), 'no machine path')
  assert.equal(await gitOk(dir, ['remote', 'get-url', 'origin']).then(s => s.trim()), tg.gitea.cloneUrl(ownerOf(), 'pj-alpha'))
})

test('submodule mode: devdocs is pushed before the root; relative URL; a fresh workspace from Gitea reads runs and history', { skip }, async () => {
  const r = await create('beta', 'submodule')
  assert.ok(r.ok, r.message)
  const dir = join(area, 'pj-beta')
  assert.match(await readFile(join(dir, '.gitmodules'), 'utf8'), /url = \.\.\/pj-beta-devdocs\.git/)
  const ws = new Workspace((await loadRegistry(registry)).workspaces.find(w => w.id === 'beta')!)
  assert.equal((await ws.devdocs()).mode, 'submodule')
  // Record a run, publish devdocs, then the root that records it.
  await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), WF)
  const c = await createRun(ws, { workflow: 'ship', input: { kind: 'braindump', text: 'Words.', author: 'Test Person' }, executor: { name: 'autolab', backend: null }, by: 'autolab', via: 'cli' })
  await runOp(ws, c.ref, { op: 'node.start', node: 'build' }, { via: 'cli' })
  const env = await tg.gitea.gitEnv()
  await gitOk(join(dir, 'devdocs'), ['add', '-A']); await gitOk(join(dir, 'devdocs'), ['commit', '-q', '-m', 'run started'])
  await gitOk(join(dir, 'devdocs'), ['push', 'origin', 'HEAD:main'], { env })
  await gitOk(dir, ['add', 'devdocs']); await gitOk(dir, ['commit', '-q', '-m', 'record devdocs'])
  await gitOk(dir, ['push', 'origin', 'main'], { env })
  const rootCommit = (await gitOk(dir, ['rev-parse', 'HEAD'])).trim()
  // A fresh workspace obtained from Gitea.
  const o = await obtainWorkspace(ctx, 'beta')
  assert.ok(o.ok, o.message)
  assert.equal(o.workspace, 'beta-2')
  const fresh = new Workspace((await loadRegistry(registry)).workspaces.find(w => w.id === 'beta-2')!)
  assert.equal((await fresh.devdocs()).mode, 'submodule')
  const read = await readRun(fresh, c.ref)
  assert.equal(read.record?.nodes.build.state, 'running', 'the run reads in a fresh workspace')
  const hist = await runResponse(fresh, c.ref, { rev: `root:${rootCommit}` })
  assert.equal(hist.record?.seq, 2)
  assert.ok(hist.revInfo?.root, 'the gitlink was followed')
})

test('a fresh directory-mode workspace from Gitea works too', { skip }, async () => {
  const o = await obtainWorkspace(ctx, 'alpha')
  assert.ok(o.ok, o.message)
  const fresh = new Workspace((await loadRegistry(registry)).workspaces.find(w => w.id === o.workspace)!)
  assert.equal((await fresh.devdocs()).mode, 'directory')
  assert.deepEqual((await fresh.structure()).diagnostics.filter(d => d.severity === 'error'), [])
})

test('partial failure resumes after the finished steps; nothing is created twice', { skip }, async () => {
  const stopped = await create('gamma', 'submodule', { failAfter: 'gitea' })
  assert.equal(stopped.ok, false)
  const ids = [(await tg.gitea.repo(ownerOf(), 'pj-gamma'))!.id, (await tg.gitea.repo(ownerOf(), 'pj-gamma-devdocs'))!.id]
  const refused = await create('gamma', 'submodule')
  assert.equal(refused.ok, false, 'an unfinished creation needs resume')
  const atPush = await create('gamma', 'submodule', { resume: true, failAfter: 'initial commit' })
  assert.equal(atPush.ok, false)
  assert.equal(await tg.gitea.hasContent(ownerOf(), 'pj-gamma'), false, 'the root was not pushed yet')
  const done = await create('gamma', 'submodule', { resume: true })
  assert.ok(done.ok, done.message)
  assert.deepEqual(done.steps.filter(s => s.name.startsWith('gitea')).map(s => s.status), ['kept', 'kept'])
  assert.deepEqual([(await tg.gitea.repo(ownerOf(), 'pj-gamma'))!.id, (await tg.gitea.repo(ownerOf(), 'pj-gamma-devdocs'))!.id], ids, 'the same repositories')
  assert.ok(await tg.gitea.hasContent(ownerOf(), 'pj-gamma'))
})

test('a same-named repository is a collision; an empty one can be reused on purpose', { skip }, async () => {
  const shared = await createSharedRepository(ctx, 'pj-delta', 'other', 'unrelated content')
  assert.ok(shared.ok)
  const r = await create('delta', 'directory')
  assert.equal(r.ok, false)
  assert.match(r.message, /already exists on Gitea and has content/)
  assert.ok((await tg.gitea.readFiles(ownerOf(), 'pj-delta', 'main', ['README.md'], join(root, 'cache'))).files['README.md']?.includes('unrelated content'), 'untouched')
  await tg.gitea.createRepo('pj-epsilon', 'made ahead, empty')
  assert.equal((await create('epsilon', 'directory')).ok, false, 'empty but not meant: refused')
  const reused = await create('epsilon', 'directory', { reuse: true, dir: join(area, 'pj-epsilon-2') })
  assert.ok(reused.ok, reused.message)
  assert.equal(reused.steps.find(s => s.name === 'gitea root')?.detail.includes('reused'), true)
})

test('shared repositories: one listing entry, each project pins its own revision', { skip }, async () => {
  const s = await createSharedRepository(ctx, 'study-rts', 'study', 'RTS study notes')
  assert.ok(s.ok, s.message)
  const key = (s.repository as { key: string }).key
  const reg = await loadRegistry(registry)
  const alpha = new Workspace(reg.workspaces.find(w => w.id === 'alpha')!)
  const beta = new Workspace(reg.workspaces.find(w => w.id === 'beta')!)
  await assert.rejects(addSharedRepository(ctx, alpha, key, 'devdocs'), /already exists/, 'collision with an existing path')
  for (const ws of [alpha, beta]) {
    const r = await addSharedRepository(ctx, ws, key, 'study/rts')
    assert.ok(r.ok, String(r.message))
    assert.equal(r.url, '../study-rts.git')
    await gitOk(ws.root, ['commit', '-q', '-m', 'add study/rts'])
  }
  const pinned = async (ws: Workspace) => (await gitOk(ws.root, ['ls-tree', 'HEAD', 'study/rts'])).split(/\s+/)[2]
  const betaBefore = await pinned(beta)
  // The shared repository moves on; alpha adopts the update, beta does not.
  const env = await tg.gitea.gitEnv()
  const sub = join(alpha.root, 'study', 'rts')
  await writeFile(join(sub, 'notes.md'), 'new note\n')
  await gitOk(sub, ['add', '-A']); await gitOk(sub, ['commit', '-q', '-m', 'note'])
  await gitOk(sub, ['push', 'origin', 'HEAD:main'], { env })
  await gitOk(alpha.root, ['add', 'study/rts']); await gitOk(alpha.root, ['commit', '-q', '-m', 'adopt study update'])
  assert.notEqual(await pinned(alpha), betaBefore)
  assert.equal(await pinned(beta), betaBefore, "another project's gitlink is unchanged")
  const d = await dashboard(ctx)
  const listed = d.repositories.filter(r => r.key === key)
  assert.equal(listed.length, 1, 'listed once globally')
  assert.deepEqual(listed[0].usedBy.map(u => `${u.project}:${u.path}`).sort(), ['alpha:study/rts', 'beta:study/rts'])
  assert.ok(listed[0].usedBy.every(u => u.source && u.at), 'usage carries its source and time')
})

test('registration of existing projects and repositories; the dashboard keeps unavailable apart from empty', { skip }, async () => {
  // A project whose root exists on Gitea but is not registered here.
  const other = join(root, 'other-registry.json')
  const octx: AgdevContext = { registryFile: other, area: join(root, 'other-area'), gitea: tg.gitea }
  const p = await registerGiteaProject(octx, ownerOf(), 'pj-beta')
  assert.ok(p.ok, p.message)
  assert.deepEqual((p.steps as { name: string; status: string }[]).map(s => [s.name, s.status]), [['root repository', 'done'], ['devdocs repository', 'done'], ['project', 'done']])
  const unused = await registerSharedRepository(octx, ownerOf(), 'study-rts', 'study')
  assert.ok(unused.ok)
  let d = await dashboard(octx)
  const beta = d.projects.find(x => x.id === 'beta')!
  assert.deepEqual(beta.workspaces, [], 'a project without a workspace is listed')
  assert.equal(beta.name, 'BETA')
  assert.match(beta.definition.source, /^gitea /)
  assert.ok(d.repositories.some(r => r.category === 'devdocs'), 'its devdocs repository is listed')
  const study = d.repositories.find(r => r.registered.name === 'study-rts')!
  assert.deepEqual(study.usedBy, [], 'beta at its Gitea main does not use it yet: a valid empty usage')
  assert.equal(study.usageUnknown.length, 0)
  // Gitea down: not an empty listing.
  const down: AgdevContext = { ...octx, gitea: new Gitea({ ...tg.gitea.setting, url: 'http://127.0.0.1:9' }) }
  d = await dashboard(down)
  assert.equal(d.gitea.state, 'unreachable')
  assert.ok(d.repositories.every(r => r.gitea.state === 'unknown'), 'repositories are unknown, not missing')
  assert.ok(d.projects.find(x => x.id === 'beta')!.definition.error, 'the definition says it was not read')
  assert.ok(study.key && d.repositories.find(r => r.key === study.key)!.usageUnknown.length === 1, 'usage unknown, not unused')
  // An old-format project root is refused.
  const old = await createSharedRepository(octx, 'pj-old', 'other', 'old')
  assert.ok(old.ok)
  await assert.rejects(registerGiteaProject(octx, ownerOf(), 'pj-old'), /no project\.yaml/)
})

test('HTTP: agdev routes; through the agdevworld route no host path or location is accepted', { skip }, async () => {
  const { createHandler, ROUTE_HEADER } = await import('../server/api.ts')
  const { createServer } = await import('node:http')
  const handler = createHandler({ registryFile: registry, area, allowedOrigins: ['http://localhost:8093'], allowedHosts: ['127.0.0.1', 'localhost'], gitea: tg.gitea })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  const routed = { 'content-type': 'application/json', [ROUTE_HEADER]: 'agdevworld', origin: 'http://localhost:8093' }
  try {
    const d = await (await fetch(`${base}/agdev`, { headers: { [ROUTE_HEADER]: 'agdevworld' } })).json() as { projects: { id: string }[]; gitea: { state: string } }
    assert.equal(d.gitea.state, 'ok')
    assert.ok(d.projects.some(p => p.id === 'alpha'))
    let r = await fetch(`${base}/workspaces`, { method: 'POST', headers: routed, body: JSON.stringify({ path: '/etc' }) })
    assert.equal(r.status, 403, 'no path registration through the route')
    r = await fetch(`${base}/workspaces/alpha/submodules`, { method: 'POST', headers: routed, body: JSON.stringify({ path: 'x', url: 'file:///etc' }) })
    assert.equal(r.status, 403, 'no submodule from an arbitrary location through the route')
    r = await fetch(`${base}/agdev/repositories`, { method: 'POST', headers: routed, body: JSON.stringify({ create: true, name: 'wedo-http', category: 'wedo', description: 'made over HTTP' }) })
    assert.equal(r.status, 201, await r.clone().text())
    const key = ((await r.json()) as { repository: { key: string } }).repository.key
    r = await fetch(`${base}/workspaces/alpha/shared`, { method: 'POST', headers: routed, body: JSON.stringify({ repository: key, path: 'wedo/http' }) })
    assert.equal(r.status, 200, await r.clone().text())
    r = await fetch(`${base}/workspaces/alpha/shared`, { method: 'POST', headers: routed, body: JSON.stringify({ repository: key, path: 'wedo/http' }) })
    assert.equal(r.status, 409, 'an occupied path is refused')
    r = await fetch(`${base}/agdev`, { method: 'POST', headers: { ...routed, origin: 'http://evil.example' } })
    assert.equal(r.status, 403, 'other origins may not write')
  } finally {
    server.closeAllConnections(); server.close()
  }
})
