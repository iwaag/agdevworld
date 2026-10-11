// p4/ex1: the operating boundary (server/boundary.ts). The editor is system
// code, not a project of its own catalog: supported operations never
// register, create, request, claim or open a workspace on system code,
// releases or control data (also through a symbolic link or an ancestor
// directory), and a retired repository is not restored as a project, a
// shared repository, a submodule or a workspace. A removed project's
// identifiers resolve to nothing. All synthetic: temporary areas and
// registries, local remotes, no Gitea.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandler } from '../server/api.ts'
import { BoundaryError, loadBoundary } from '../server/boundary.ts'
import { createProject } from '../server/create.ts'
import { dashboard } from '../server/agdev.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry, registerProject, registerRepository, registerWorkspace, unregisterProject } from '../server/registry.ts'
import { PACKAGE_DIR } from '../server/version.ts'
import { main } from '../cli/wfe.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-boundary-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = `schema: ag.workflow.v2
documentation: {policy: manual}
id: ship
name: Ship
intent: |
  Build it.
repositories:
  root: {path: ., access: editable}
nodes:
  build:
    type: do
    description: Build it.
edges: []
`
const RETIRED = { gitea: 9132, owner: 'developer', name: 'pj-old-editor', why: 'the editor is system code' }

async function repo(dir: string, origin?: string) {
  await mkdir(dir, { recursive: true })
  await gitOk(dir, ['init', '-q', '--initial-branch=main'])
  await writeFile(join(dir, 'README.md'), 'x\n')
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'init'])
  if (origin) await gitOk(dir, ['remote', 'add', 'origin', origin])
}

// An operating area: system code beside it (configured as protected), one
// ordinary project with a workflow, and the retired repository in system.json.
let n = 0
async function area() {
  const base = join(root, `case-${++n}`)
  const a = join(base, 'area')
  const registry = join(a, 'registry.json')
  const sys = join(base, 'system-code')
  await repo(sys)
  await mkdir(join(sys, 'nested'), { recursive: true })
  await repo(join(sys, 'nested', 'pkg'))
  const outer = join(base, 'outer')
  await repo(outer)
  await mkdir(join(outer, 'frozen'), { recursive: true })
  await mkdir(a, { recursive: true })
  await writeFile(join(a, 'system.json'), JSON.stringify({
    protectedPaths: [{ path: '../system-code', why: 'agdevworld source' }, { path: '../outer/frozen', why: 'frozen archive' }],
    retiredRepositories: [RETIRED],
  }))
  const dir = join(a, 'pj-game')
  const r = await createProject({ dir, id: 'game', name: 'Game', intent: 'x', goals: [], devdocs: 'directory', registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), WF)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  return { base, a, registry, sys, outer, dir }
}

const refused = async (p: Promise<unknown>, re: RegExp) => {
  await assert.rejects(p, (e: unknown) => e instanceof BoundaryError && e.status === 403 && re.test((e as Error).message))
}

test('registration refuses protected paths: the path itself, a symlink, a path inside, an ancestor, implicit code and control data', async () => {
  const c = await area()
  await refused(registerWorkspace(c.registry, c.sys), /is .*system-code/)
  const link = join(c.base, 'innocent-name')
  await symlink(c.sys, link)
  await refused(registerWorkspace(c.registry, link), /system-code/)
  await refused(registerWorkspace(c.registry, join(c.sys, 'nested', 'pkg')), /is inside .*system-code/)
  await refused(registerWorkspace(c.registry, c.outer), /contains .*frozen/)
  // Implicit, without any system.json: the running package and the area's control data.
  await refused(registerWorkspace(c.registry, PACKAGE_DIR), /the workflow editor code this process runs/)
  await repo(join(c.a, 'service', 'releases', 'r1'))
  await refused(registerWorkspace(c.registry, join(c.a, 'service', 'releases', 'r1')), /control data/)
  // Nothing was registered by any of these.
  assert.deepEqual((await loadRegistry(c.registry)).workspaces.map(w => w.id), ['game'])
  // An ordinary project next to them is unaffected.
  const other = join(c.a, 'pj-other')
  await repo(other)
  assert.equal((await registerWorkspace(c.registry, other)).ok, true)
})

test('creation refuses a protected destination before writing anything', async () => {
  const c = await area()
  const dest = join(c.sys, 'nested', 'new-project')
  await refused(createProject({ dir: dest, id: 'sneaky', name: 'S', intent: '', goals: [], devdocs: 'directory', registryFile: c.registry }), /is inside .*system-code/)
  assert.deepEqual((await readdir(join(c.sys, 'nested'))).sort(), ['pkg'])
})

test('a retired repository is refused as a repository, a project root, a clone, and a submodule location', async () => {
  const c = await area()
  await refused(registerRepository(c.registry, { id: RETIRED.gitea, owner: 'developer', name: 'renamed-later' }, 'study'), /retired/)
  await refused(registerRepository(c.registry, { id: 777, owner: 'developer', name: 'pj-old-editor' }, 'root'), /retired/)
  // A hand-made root entry still cannot become a project.
  const raw = JSON.parse(await readFile(c.registry, 'utf8'))
  raw.repositories = [...(raw.repositories ?? []), { gitea: { id: RETIRED.gitea, owner: 'developer', name: 'pj-old-editor' }, category: 'root' }]
  await writeFile(c.registry, JSON.stringify(raw))
  await refused(registerProject(c.registry, 'old-editor', `gitea:${RETIRED.gitea}`), /retired/)
  // A clone of it, by its origin.
  const clone = join(c.a, 'pj-old-editor')
  await repo(clone, 'http://gitea.invalid:3000/developer/pj-old-editor.git')
  await refused(registerWorkspace(c.registry, clone), /retired/)
  // As a submodule: CLI and the local HTTP route.
  process.env.WFE_REGISTRY = c.registry
  try {
    const code = await main(['add-repo', 'tools/editor', '../pj-old-editor.git', '--workspace', 'game'])
    assert.equal(code, 1)
  } finally { delete process.env.WFE_REGISTRY }
  const srv = createServer(createHandler({ registryFile: c.registry, area: c.a, allowedOrigins: [], allowedHosts: ['127.0.0.1'] }))
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  try {
    const port = (srv.address() as { port: number }).port
    const res = await fetch(`http://127.0.0.1:${port}/api/workspaces/game/submodules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'tools/editor', url: 'http://gitea.invalid:3000/developer/pj-old-editor.git' }) })
    assert.equal(res.status, 403)
    assert.match((await res.json() as { error: string }).error, /retired/)
  } finally { srv.close() }
  assert.equal(await readFile(join(c.dir, '.gitmodules'), 'utf8').catch(() => ''), '')
})

test('an injected registration is refused at request, claim, the HTTP API, the CLI and the dashboard', async () => {
  const c = await area()
  await mkdir(join(c.sys, 'devdocs', 'workflows'), { recursive: true })
  await writeFile(join(c.sys, 'devdocs', 'workflows', 'ship.yaml'), WF)
  const raw = JSON.parse(await readFile(c.registry, 'utf8'))
  raw.workspaces.push({ id: 'sysws', path: c.sys }, { id: 'linked', path: join(c.base, 'sys-link') })
  await symlink(c.sys, join(c.base, 'sys-link'))
  await writeFile(c.registry, JSON.stringify(raw))
  const x = new ExecStore({ registryFile: c.registry, area: c.a })
  try {
    await refused(x.request({ workspace: 'sysws', workflow: 'ship', text: 'do it', author: 'Test Person', receipt: 'req-boundary-1', via: 'test' }), /Execution \(workspace "sysws"\) refused/)
    await refused(x.request({ workspace: 'linked', workflow: 'ship', text: 'do it', author: 'Test Person', receipt: 'req-boundary-2', via: 'test' }), /system-code/)
    // A job put straight into the queue is dropped at claim, with no attempt.
    x.enqueue('sysws', { workflow: 'ship', run: 'run-001' }, 'start', 'injected-1', 'injected')
    const claim = await x.claim(null)
    assert.ok('idle' in claim, JSON.stringify(claim))
    const job = x.db.prepare('SELECT state, note FROM jobs WHERE receipt = ?').get('injected-1') as { state: string; note: string }
    assert.equal(job.state, 'dropped')
    assert.match(job.note, /refused/)
    assert.equal((x.db.prepare('SELECT count(*) AS n FROM attempts').get() as { n: number }).n, 0)
    // The ordinary workspace still runs.
    const ok = await x.request({ workspace: 'game', workflow: 'ship', text: 'do it', author: 'Test Person', receipt: 'req-boundary-3', via: 'test' })
    assert.equal(ok.job.state, 'queued')
  } finally { x.close() }
  const srv = createServer(createHandler({ registryFile: c.registry, area: c.a, allowedOrigins: [], allowedHosts: ['127.0.0.1'] }))
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  try {
    const port = (srv.address() as { port: number }).port
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/workspaces/sysws/project`)).status, 403)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/workspaces/game/project`)).status, 200)
    const reg = await fetch(`http://127.0.0.1:${port}/api/workspaces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: c.sys }) })
    assert.equal(reg.status, 403)
  } finally { srv.close() }
  process.env.WFE_REGISTRY = c.registry
  try { assert.equal(await main(['validate', '--workspace', 'sysws']), 1) } finally { delete process.env.WFE_REGISTRY }
  const d = await dashboard({ registryFile: c.registry, area: c.a })
  const listed = d.unlinkedWorkspaces.find(w => w.id === 'sysws')
  assert.equal(listed?.available, false)
  assert.match(listed?.reason ?? '', /^refused/)
})

test('unregistering a project removes it, its workspaces and its root entry; its ids then resolve to nothing', async () => {
  const c = await area()
  const second = join(c.a, 'pj-game-2')
  await gitOk(c.a, ['clone', '-q', c.dir, second])
  assert.equal((await registerWorkspace(c.registry, second, { id: 'game-2' })).ok, true)
  const raw = JSON.parse(await readFile(c.registry, 'utf8'))
  raw.repositories = [{ gitea: { id: 501, owner: 'developer', name: 'pj-game' }, category: 'root' }, { gitea: { id: 502, owner: 'developer', name: 'study-x' }, category: 'study' }]
  raw.projects = [{ id: 'game', root: 'gitea:501' }]
  await writeFile(c.registry, JSON.stringify(raw))
  // Refused while work is queued for it.
  const x = new ExecStore({ registryFile: c.registry, area: c.a })
  const job = await x.request({ workspace: 'game-2', workflow: 'ship', text: 'do it', author: 'Test Person', receipt: 'req-unreg-1', via: 'test' })
  x.close()
  process.env.WFE_REGISTRY = c.registry
  try {
    assert.equal(await main(['project', 'unregister', 'game']), 1)
    assert.equal((await loadRegistry(c.registry)).projects.length, 1)
    const y = new ExecStore({ registryFile: c.registry, area: c.a })
    y.db.prepare('UPDATE jobs SET state = \'dropped\', note = \'test\' WHERE id = ?').run(job.job.id)
    y.close()
    assert.equal(await main(['project', 'unregister', 'game']), 0)
  } finally { delete process.env.WFE_REGISTRY }
  const after = await loadRegistry(c.registry)
  assert.deepEqual(after.projects, [])
  assert.deepEqual(after.workspaces, [])
  assert.deepEqual(after.repositories.map(r => r.key), ['gitea:502'], 'the shared repository stays')
  // Folders are kept; the ids are gone everywhere.
  assert.ok((await readdir(c.a)).includes('pj-game-2'))
  const z = new ExecStore({ registryFile: c.registry, area: c.a })
  try {
    await assert.rejects(z.request({ workspace: 'game', workflow: 'ship', text: 'x', author: 'T', receipt: 'req-unreg-2', via: 'test' }), /not registered/)
    z.enqueue('game', { workflow: 'ship', run: 'run-009' }, 'start', 'stale-1', 'stale')
    assert.ok('idle' in await z.claim(null))
    assert.equal((z.db.prepare('SELECT state FROM jobs WHERE receipt = ?').get('stale-1') as { state: string }).state, 'dropped')
  } finally { z.close() }
  await assert.rejects(unregisterProject(c.registry, 'game'), /not registered/)
})

test('a malformed system.json refuses protected operations instead of reading as empty', async () => {
  const c = await area()
  await writeFile(join(c.a, 'system.json'), '{"protectedPaths": [')
  await refused(loadBoundary(c.registry), /not valid JSON/)
  const other = join(c.a, 'pj-other')
  await repo(other)
  await refused(registerWorkspace(c.registry, other), /not valid JSON/)
})
