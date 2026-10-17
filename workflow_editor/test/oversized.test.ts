// p11: checkpoints and agent commits can publish files above the former 50 MiB limit.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { runOp } from '../server/runs.ts'
import { Workspace } from '../server/workspace.ts'
import type { OpInput, RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-oversized-'))
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
  build: {type: do, description: Build.}
  more: {type: do, description: More.}
edges:
  - {from: build, to: more}
`
let k = 0
async function setup() {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-demo')
  const r = await createProject({ dir, id: 'demo', name: 'Demo', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), WF)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remote.git')
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote]); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  return { dir, remote, ws, x: new ExecStore({ registryFile: registry, area }) }
}
const report = (ws: Workspace, ref: RunRef, attempt: string, op: OpInput) => runOp(ws, ref, { ...op, attempt }, { by: 'autolab', via: 'cli' })

test('p11: a checkpoint commits and publishes intended content above the former size limit', async () => {
  const s = await setup()
  const { ref } = await s.x.request({ workspace: 'demo', workflow: 'ship', text: 'Build.', author: 'Test Person', receipt: 'receipt-oversized-1', via: 'browser' })
  const c = await s.x.claim('test'); assert.ok('attempt' in c)
  s.x.started(c.attempt.id, process.pid)
  await report(s.ws, ref, c.attempt.id, { op: 'node.start', node: 'build' })
  await mkdir(join(c.cwd, 'materials'), { recursive: true })
  await writeFile(join(c.cwd, 'materials', 'small.tres'), 'small\n')
  await writeFile(join(c.cwd, 'materials', 'huge.tres'), Buffer.alloc(51 * 1024 * 1024, 1))
  await report(s.ws, ref, c.attempt.id, { op: 'node.complete', node: 'build', outcome: 'built' })
  const f = await s.x.finished(c.attempt.id, { code: 0, signal: null })
  const root = (JSON.parse(f.checkpoint!.steps) as import('../server/publish.ts').RepoStep[]).find(st => st.repo === '.')!
  assert.equal(f.checkpoint?.state, 'published', JSON.stringify(f.checkpoint))
  assert.equal(root.oversized, undefined)
  assert.equal(root.error, undefined)
  const tree = await gitOk(s.remote, ['ls-tree', '-r', '--name-only', `refs/heads/${root.branch}`])
  assert.ok(tree.includes('materials/small.tres'))
  assert.ok(tree.includes('materials/huge.tres'))
  assert.equal(Number(await gitOk(s.remote, ['cat-file', '-s', `refs/heads/${root.branch}:materials/huge.tres`])), 51 * 1024 * 1024)
  s.x.close()
})

test('p11: the agent can commit and publish a file above the former size limit', async () => {
  const s = await setup()
  const { ref } = await s.x.request({ workspace: 'demo', workflow: 'ship', text: 'Build.', author: 'Test Person', receipt: 'receipt-oversized-2', via: 'browser' })
  const c = await s.x.claim('test'); assert.ok('attempt' in c)
  s.x.started(c.attempt.id, process.pid)
  await report(s.ws, ref, c.attempt.id, { op: 'node.start', node: 'build' })
  await writeFile(join(c.cwd, 'blob.bin'), Buffer.alloc(51 * 1024 * 1024, 2))
  await gitOk(c.cwd, ['add', 'blob.bin']); await gitOk(c.cwd, ['commit', '-q', '-m', 'the agent commits a large file'])
  await report(s.ws, ref, c.attempt.id, { op: 'node.complete', node: 'build', outcome: 'built' })
  const f = await s.x.finished(c.attempt.id, { code: 0, signal: null })
  const root = (JSON.parse(f.checkpoint!.steps) as import('../server/publish.ts').RepoStep[]).find(st => st.repo === '.')!
  assert.equal(f.checkpoint?.state, 'published', JSON.stringify(f.checkpoint))
  assert.equal(root.error, undefined)
  const remoteBranches = await gitOk(s.remote, ['branch', '--list'])
  assert.ok(remoteBranches.includes(root.branch!), 'the agent commit is published')
  assert.equal(Number(await gitOk(s.remote, ['cat-file', '-s', `refs/heads/${root.branch}:blob.bin`])), 51 * 1024 * 1024)
  s.x.close()
})
