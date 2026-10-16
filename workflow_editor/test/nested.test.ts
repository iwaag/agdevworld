// project_migration p6 ex1: a submodule's own submodules are the run's too.
// A backend superproject (`backend/super`) pins the repositories that carry
// the work (`lib`); a run changes `lib`, its copy owns every repository the
// workspace has checked out, the checkpoint publishes the deepest first, and
// integration records each integrated commit in the repository above it —
// never a run-branch commit its target lacks.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk, LOCAL_TRANSPORT } from '../server/git.ts'
import { publicationOrder } from '../server/publish.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runOp } from '../server/runs.ts'
import { ownerOf } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'
import type { OpInput, RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-nested-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = `schema: ag.workflow.v2
documentation: {policy: manual}
id: develop
name: Develop
intent: |
  Change the backend.
repositories:
  project: {path: ., access: readonly}
  backend: {path: backend/super, access: editable}
nodes:
  build:
    type: do
    description: Build.
    repositories: [backend]
edges: []
`

let n = 0
async function bare(area: string, name: string, files: Record<string, string>) {
  const src = join(area, `${name}-src`)
  await gitOk(area, ['init', '-q', src])
  for (const [p, t] of Object.entries(files)) await writeFile(join(src, p), t)
  await gitOk(src, ['add', '-A']); await gitOk(src, ['commit', '-q', '-m', name])
  const remote = join(area, 'remotes', `${name}.git`)
  await gitOk(area, ['clone', '-q', '--bare', src, remote])
  return remote
}
async function setup() {
  const area = join(root, `area-${++n}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, `pj-n${n}`)
  const id = `n${n}`
  const r = await createProject({ dir, id, name: `N${n}`, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  // lib, and a superproject whose gitlink pins it.
  const lib = await bare(area, 'lib', { 'code.txt': 'one\ntwo\nthree\nfour\nfive\n' })
  const superSrc = join(area, 'super-src')
  await gitOk(area, ['init', '-q', superSrc])
  await writeFile(join(superSrc, 'README.md'), 'super\n')
  await gitOk(superSrc, ['submodule', 'add', '-q', lib, 'lib'], { config: LOCAL_TRANSPORT })
  await gitOk(superSrc, ['add', '-A']); await gitOk(superSrc, ['commit', '-q', '-m', 'super'])
  const sup = join(area, 'remotes', 'super.git')
  await gitOk(area, ['clone', '-q', '--bare', superSrc, sup])
  await gitOk(dir, ['submodule', 'add', '-q', sup, 'backend/super'], { config: LOCAL_TRANSPORT })
  await gitOk(join(dir, 'backend/super'), ['submodule', 'update', '-q', '--init'], { config: LOCAL_TRANSPORT })
  await writeFile(join(dir, 'devdocs', 'workflows', 'develop.yaml'), WF)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remotes', `pj-n${n}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote]); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  return { area, dir, remote, lib, sup, ws, id, x: new ExecStore({ registryFile: registry, area }) }
}
type S = Awaited<ReturnType<typeof setup>>
const report = (s: S, ref: RunRef, attempt: string, op: OpInput) => runOp(s.ws, ref, { ...op, attempt }, { by: 'autolab', via: 'cli' })
const head = (repo: string, ref = 'main') => gitOk(repo, ['rev-parse', ref]).then(x => x.trim())
const link = async (repo: string, ref: string, path: string) => /^160000 commit ([0-9a-f]+)\t/.exec(await gitOk(repo, ['ls-tree', ref, '--', path]))?.[1]

async function completed(s: S, receipt: string, text: string) {
  const { ref } = await s.x.request({ workspace: s.id, workflow: 'develop', text: 'Change lib.', author: 'Test Person', receipt, via: 'browser' })
  const c = await s.x.claim('t')
  assert.ok('attempt' in c, JSON.stringify(c))
  s.x.started(c.attempt.id, process.pid)
  await report(s, ref, c.attempt.id, { op: 'node.start', node: 'build' })
  await writeFile(join(c.cwd, 'backend/super/lib/code.txt'), text)
  await report(s, ref, c.attempt.id, { op: 'node.complete', node: 'build', outcome: 'built' })
  const f = await s.x.finished(c.attempt.id, { code: 0, signal: null })
  assert.equal(f.checkpoint?.state, 'published', JSON.stringify(f.checkpoint))
  return { ref, cwd: c.cwd }
}
async function accept(s: S, ref: RunRef) {
  await runOp(s.ws, ref, { op: 'run.decide', decision: 'accepted', evidence: 'looked at it' }, { by: 'Test Person', via: 'browser' })
  await s.x.afterDecision(s.ws, ref, 'accepted')
}

test('order and owner: the deepest first, each repository under its nearest owned parent', () => {
  assert.deepEqual(publicationOrder(['.', 'backend/super', 'devdocs', 'backend/super/lib', 'study/x']), ['backend/super/lib', 'devdocs', 'backend/super', 'study/x', '.'])
  assert.equal(ownerOf('backend/super/lib', ['backend/super', 'backend/super/lib']), 'backend/super')
  assert.equal(ownerOf('backend/super/lib/code.txt', ['backend/super', 'backend/super/lib']), 'backend/super/lib')
  assert.equal(ownerOf('backend/super', ['backend/super']), '.')
})

test('a nested submodule gets the run branch; the checkpoint publishes it first and each parent records its commit; integration pins integrated commits up to the root', async () => {
  const s = await setup()
  const libBase = await head(s.lib)
  const a = await completed(s, 'nested-0001', 'one\nTWO\nthree\nfour\nfive\n')
  const branch = `wfe/${s.id}/develop/run-001`
  // The copy: every repository on the run branch, the storage names all three.
  assert.equal((await gitOk(join(a.cwd, 'backend/super/lib'), ['symbolic-ref', '--short', 'HEAD'])).trim(), branch)
  assert.equal((await gitOk(join(a.cwd, 'backend/super'), ['symbolic-ref', '--short', 'HEAD'])).trim(), branch)
  const rec = (await readRun(s.ws, a.ref)).record!
  assert.deepEqual(rec.storage!.repositories.map(r => [r.path, r.branch, r.target]), [['.', branch, 'main'], ['backend/super', branch, 'main'], ['backend/super/lib', branch, 'main']])
  assert.equal(rec.storage!.repositories[2].base, libBase)
  // The checkpoint: lib's commit on its run branch, recorded by super's, recorded by the root's.
  const libRun = await head(s.lib, branch)
  assert.notEqual(libRun, libBase)
  assert.equal(await link(s.sup, branch, 'lib'), libRun)
  assert.equal(await link(s.remote, branch, 'backend/super'), await head(s.sup, branch))
  assert.equal(await head(s.lib), libBase, 'saving changes no shared branch')
  await accept(s, a.ref)
  const notes = await s.x.reconcile()
  assert.match(notes.join('\n'), /integration 1 \(develop\/run-001\): integrated/)
  const it = (await readRun(s.ws, a.ref)).record!.integrations![0]
  assert.deepEqual(it.repositories.map(x => [x.path, x.method]), [['backend/super/lib', 'fast-forward'], ['backend/super', 'fast-forward'], ['.', 'fast-forward']])
  assert.equal(await gitOk(s.lib, ['show', 'main:code.txt']), 'one\nTWO\nthree\nfour\nfive\n')
  assert.equal(await link(s.sup, 'main', 'lib'), await head(s.lib), 'super records lib\'s integrated commit')
  assert.equal(await link(s.remote, 'main', 'backend/super'), await head(s.sup), 'the root records super\'s')
})

test('a moved nested target is combined, and the parent records the combined commit, not the run branch', async () => {
  const s = await setup()
  const a = await completed(s, 'nested-0002', 'one\nTWO\nthree\nfour\nfive\n')
  // Meanwhile lib's main gains another change elsewhere.
  const other = join(s.area, 'other-lib')
  await gitOk(s.area, ['clone', '-q', s.lib, other])
  await writeFile(join(other, 'NEWS.md'), 'news\n')
  await gitOk(other, ['add', '-A']); await gitOk(other, ['commit', '-q', '-m', 'elsewhere']); await gitOk(other, ['push', '-q', 'origin', 'HEAD:main'])
  await accept(s, a.ref)
  const r = await s.x.integrateRun(s.ws, a.ref, { by: 'Test Person', via: 'cli' })
  assert.equal(r.state, 'integrated', r.error)
  assert.deepEqual(r.steps.map(x => [x.repo, x.method]), [['backend/super/lib', 'merge'], ['backend/super', 'merge'], ['.', 'merge']])
  const libMain = await head(s.lib)
  assert.equal(await gitOk(s.lib, ['show', 'main:NEWS.md']), 'news\n')
  assert.equal(await gitOk(s.lib, ['show', 'main:code.txt']), 'one\nTWO\nthree\nfour\nfive\n')
  assert.equal(await link(s.sup, 'main', 'lib'), libMain, 'super pins the combined lib commit')
  assert.notEqual(libMain, await head(s.lib, `wfe/${s.id}/develop/run-001`))
  assert.equal(await link(s.remote, 'main', 'backend/super'), await head(s.sup))
  assert.ok((await readFile(join(a.cwd, 'backend/super/lib/code.txt'), 'utf8')).includes('TWO'), 'the copy keeps the run\'s work')
})
