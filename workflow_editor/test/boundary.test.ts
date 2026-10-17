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

import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'


import { createProject } from '../server/create.ts'

import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry, registerRepository, registerWorkspace, unregisterProject } from '../server/registry.ts'

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


test('registration accepts explicit paths formerly marked protected, including symlink targets', async () => {
  const c = await area()
  assert.equal((await registerWorkspace(c.registry, c.sys)).ok, true)
  const link = join(c.base, 'alias')
  await symlink(c.outer, link)
  assert.equal((await registerWorkspace(c.registry, link)).ok, true)
})

test('project creation accepts an explicit destination under a former protected path', async () => {
  const c = await area()
  const result = await createProject({ dir: join(c.sys, 'nested', 'new-project'), id: 'new-project', name: 'New', intent: '', goals: [], devdocs: 'directory', registryFile: c.registry })
  assert.ok(result.ok, result.message)
})

test('historical retirement metadata does not veto repository registration or a clone', async () => {
  const c = await area()
  assert.equal((await registerRepository(c.registry, { id: RETIRED.gitea, owner: 'developer', name: 'renamed-later' }, 'study')).status, 'registered')
  const clone = join(c.a, 'pj-old-editor')
  await repo(clone, 'http://gitea.invalid:3000/developer/pj-old-editor.git')
  assert.equal((await registerWorkspace(c.registry, clone)).ok, true)
})

test('a formerly protected workspace executes without changing system metadata', async () => {
  const c = await area()
  const raw = JSON.parse(await readFile(c.registry, 'utf8'))
  raw.workspaces[0].path = c.dir
  await writeFile(c.registry, JSON.stringify(raw))
  await writeFile(join(c.a, 'system.json'), JSON.stringify({ protectedPaths: [{ path: c.dir, why: 'old policy' }] }))
  const x = new ExecStore({ registryFile: c.registry, area: c.a })
  try {
    const created = await x.request({ workspace: 'game', workflow: 'ship', text: 'build', author: 'Agent', receipt: 'p11-boundary', via: 'cli' })
    assert.ok(created.ref)
    const claimed = await x.claim('worker')
    assert.ok('attempt' in claimed, JSON.stringify(claimed))
  } finally { x.close() }
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

test('obsolete boundary configuration is ignored rather than vetoing operations', async () => {
  const c = await area()
  await writeFile(join(c.a, 'system.json'), '{obsolete')
  assert.equal((await registerWorkspace(c.registry, c.sys)).ok, true)
})
