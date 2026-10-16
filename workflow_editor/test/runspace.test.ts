// p9 step 1: the run storage contract (server/runspace.ts, docs/storage.md)
// on fixture projects — each run gets its own root, manifest and branches;
// numbers are unique under concurrency; the same request, an interrupted
// creation and a restart find the same identity; submodules are owned by
// the run, nested ones too (project_migration p6 ex1); damaged copies are reported and
// reconstructed only when asked.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { gitOk, LOCAL_TRANSPORT } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { createRun, readRun } from '../server/runs.ts'
import { copyDir, inspectIndex, listCopies, materialize, prepareCopy, readCopy, reserve, runBranch, runSpace, storageOf } from '../server/runspace.ts'
import { RequestError, Workspace } from '../server/workspace.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-runspace-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
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
    description: Build.
edges: []
`

let n = 0
async function setup(mode: 'directory' | 'submodule' = 'directory') {
  const area = join(root, `area-${++n}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, `pj-p${n}`)
  const r = await createProject({ dir, id: `p${n}`, name: `P${n}`, intent: 'x', goals: [], devdocs: mode, sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), WF)
  if (mode === 'submodule') { await gitOk(join(dir, 'devdocs'), ['add', '-A']); await gitOk(join(dir, 'devdocs'), ['commit', '-q', '-m', 'workflow']); await gitOk(join(dir, 'devdocs'), ['push', '-q', 'origin', 'HEAD:main']) }
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remotes', `pj-p${n}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote])
  await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  const ws = new Workspace((await loadRegistry(registry)).workspaces.find(w => w.id === `p${n}`)!)
  return { area, dir, remote, ws, project: `p${n}` }
}

// A bare repository with one commit, usable as a submodule source.
async function bare(area: string, name: string, files: Record<string, string>, subs: { path: string; url: string }[] = []) {
  const src = join(area, 'src', name)
  await gitOk(area, ['init', '-q', '--initial-branch=main', src])
  for (const [f, t] of Object.entries(files)) await writeFile(join(src, f), t)
  for (const s of subs) await gitOk(src, ['submodule', 'add', '-q', s.url, s.path], { config: LOCAL_TRANSPORT })
  await gitOk(src, ['add', '-A']); await gitOk(src, ['commit', '-q', '-m', `${name} start`])
  const b = join(area, 'remotes', `${name}.git`)
  await gitOk(area, ['clone', '-q', '--bare', src, b])
  return b
}

const exists = (p: string) => stat(p).then(() => true, () => false)
const head = (dir: string) => gitOk(dir, ['rev-parse', 'HEAD']).then(s => s.trim())
const branch = (dir: string) => gitOk(dir, ['symbolic-ref', '--short', 'HEAD']).then(s => s.trim())

test('two runs get separate roots, manifests and branches from the committed project; uncommitted edits stay out; local notes are copied and ignored', async () => {
  const { ws, dir, project, remote } = await setup()
  await writeFile(join(dir, 'README.md'), 'an uncommitted edit of the person\n')
  await mkdir(join(dir, '.local', 'outputs'), { recursive: true })
  await writeFile(join(dir, '.local', 'localenv.md'), 'ComfyUI is on another host\n')
  await writeFile(join(dir, '.local', 'outputs', 'big.bin'), 'x')
  const base = await head(dir)
  const a = await prepareCopy(ws, { project, workflow: 'ship', receipt: 'req-a' })
  const b = await prepareCopy(ws, { project, workflow: 'ship', receipt: 'req-b' })
  assert.deepEqual([a.copy.ref.run, b.copy.ref.run], ['run-001', 'run-002'])
  assert.notEqual(a.copy.tree, b.copy.tree)
  for (const c of [a.copy, b.copy]) {
    const m = c.manifest!
    assert.equal(m.state, 'ready')
    assert.equal(m.branch, runBranch(project, c.ref))
    assert.equal(await branch(c.tree), m.branch)
    assert.equal(await head(c.tree), base, 'the copy starts from the committed HEAD')
    assert.deepEqual(m.repositories.map(r => [r.path, r.base, r.branch, r.target]), [['.', base, m.branch, 'main']])
    assert.equal((await gitOk(c.tree, ['remote', 'get-url', 'origin'])).trim(), remote, 'the copy pushes to the project remote, not the workspace')
    assert.notEqual(await readFile(join(c.tree, 'README.md'), 'utf8').catch(() => null), 'an uncommitted edit of the person\n')
    assert.deepEqual(m.local, ['localenv.md'])
    assert.equal(await readFile(join(c.tree, '.local', 'localenv.md'), 'utf8'), 'ComfyUI is on another host\n')
    assert.equal(await exists(join(c.tree, '.local', 'outputs')), false, 'output folders are not shared')
    assert.equal((await gitOk(c.tree, ['status', '--porcelain', '--untracked-files=all'])).trim(), '', '.local/ is ignored in the copy')
    assert.deepEqual(storageOf(m), { kind: 'run-copy', branch: m.branch, repositories: [{ path: '.', base, branch: m.branch, target: 'main' }] })
  }
  // A change in one copy is invisible in the other and in the workspace.
  await writeFile(join(a.copy.tree, 'shared.txt'), 'A\n')
  assert.equal(await exists(join(b.copy.tree, 'shared.txt')), false)
  assert.equal(await exists(join(dir, 'shared.txt')), false)
  assert.match((await gitOk(dir, ['status', '--porcelain'])).trim(), /^(\?\?| M) README\.md$/, 'the workspace shows only the person\'s own edit')
})

test('a run created into its copy records its storage there; the resolver routes to the copy, the project tree has nothing of it', async () => {
  const { ws, dir, project } = await setup()
  const p = await prepareCopy(ws, { project, workflow: 'ship', receipt: 'req-1' })
  const created = await createRun(ws, { workflow: 'ship', name: p.copy.ref.run, into: p.workspace, storage: storageOf(p.copy.manifest!), input: { kind: 'braindump', text: 'Build.', author: 'Test Person' }, executor: { host: 'autolab' }, by: 'Test Person', via: 'browser' })
  assert.equal(created.ref.run, 'run-001')
  assert.equal(await exists(join(dir, 'devdocs', 'runs', 'ship', 'run-001')), false)
  assert.equal(await exists(join(p.copy.tree, 'devdocs', 'runs', 'ship', 'run-001', 'run.json')), true)
  const space = await runSpace(ws, created.ref)
  assert.equal(space.root, p.copy.tree)
  assert.equal(space.reg.id, ws.reg.id, 'the logical workspace is the same')
  assert.equal(space.shared, ws)
  const rec = (await readRun(space, created.ref)).record!
  assert.equal(rec.storage?.branch, `wfe/${project}/ship/run-001`)
  assert.equal(rec.context.repositories[0].branch, `wfe/${project}/ship/run-001`)
  // A run without a copy stays in the project workspace.
  assert.equal((await runSpace(ws, { workflow: 'ship', run: 'run-099' })).root, ws.root)
})

test('allocation: the same receipt finds its run; concurrent requests get distinct numbers; records, copies and run branches all count', async () => {
  const { ws, dir, project, area } = await setup()
  const first = await reserve(ws, { project, workflow: 'ship', receipt: 'same' })
  const again = await reserve(ws, { project, workflow: 'ship', receipt: 'same' })
  assert.equal(again.existing, true)
  assert.equal(again.ref.run, first.ref.run)
  const many = await Promise.all([1, 2, 3, 4, 5].map(i => reserve(ws, { project, workflow: 'ship', receipt: `c${i}` })))
  assert.equal(new Set(many.map(m => m.ref.run)).size, 5)
  assert.deepEqual(many.map(m => m.ref.run).sort(), ['run-002', 'run-003', 'run-004', 'run-005', 'run-006'])
  // A run recorded in the project tree (before p9), and a run branch some
  // other copy pushed, both hold their numbers.
  await mkdir(join(dir, 'devdocs', 'runs', 'ship', 'run-010'), { recursive: true })
  assert.equal((await reserve(ws, { project, workflow: 'ship' })).ref.run, 'run-011')
  const other = join(area, 'other')
  await gitOk(area, ['clone', '-q', join(area, 'remotes', `${project.replace('p', 'pj-p')}.git`), other])
  await gitOk(other, ['push', '-q', 'origin', `HEAD:refs/heads/wfe/${project}/ship/run-020`])
  await gitOk(dir, ['fetch', '-q', 'origin'])
  assert.equal((await reserve(ws, { project, workflow: 'ship' })).ref.run, 'run-021')
  await assert.rejects(reserve(ws, { project, workflow: 'ship', name: 'run-020' }), (e: unknown) => e instanceof RequestError && e.status === 409)
  // Another project sharing a repository never collides: the branch names it.
  assert.equal(runBranch('other-project', { workflow: 'ship', run: 'run-020' }), 'wfe/other-project/ship/run-020')
})

test('interrupted creation is finished by the next call; a restart reads the same identity', async () => {
  const { ws, project } = await setup()
  const r = await reserve(ws, { project, workflow: 'ship', receipt: 'crash' })
  // Crash 1: a clone that never finished left a folder without a repository.
  await mkdir(join(copyDir(ws, r.ref), 'tree', 'half'), { recursive: true })
  let c = await readCopy(ws, r.ref)
  assert.match(c!.problem!, /being created/)
  await assert.rejects(runSpace(ws, r.ref), (e: unknown) => e instanceof RequestError && e.status === 409, 'an unfinished copy is not used')
  // The same request continues with the same run.
  const p = await prepareCopy(ws, { project, workflow: 'ship', receipt: 'crash' })
  assert.equal(p.existing, true)
  assert.equal(p.copy.ref.run, r.ref.run)
  assert.equal(p.copy.manifest!.state, 'ready')
  // Crash 2: the manifest still says creating although the copy is done
  // (the process died before its last write): materialize only finishes.
  const m = JSON.parse(await readFile(join(copyDir(ws, r.ref), 'copy.json'), 'utf8'))
  await writeFile(join(p.copy.tree, 'work.txt'), 'unsaved work\n')
  await writeFile(join(copyDir(ws, r.ref), 'copy.json'), JSON.stringify({ ...m, state: 'creating' }))
  c = await materialize(ws, r.ref)
  assert.equal(c.manifest!.state, 'ready')
  assert.equal(await readFile(join(c.tree, 'work.txt'), 'utf8'), 'unsaved work\n', 'finishing never discards the copy\'s files')
  // Restart: nothing is held in memory; a fresh read lists the same.
  const fresh = new Workspace(ws.reg)
  assert.deepEqual((await listCopies(fresh)).map(x => [x.ref.run, x.manifest?.branch, x.problem]), [[r.ref.run, `wfe/${project}/ship/${r.ref.run}`, null]])
  assert.equal((await reserve(fresh, { project, workflow: 'ship' })).ref.run, 'run-002')
})

test('submodules: devdocs and a study each get the run branch at the base gitlink; a nested submodule gets the run branch at its parent\'s gitlink too', async () => {
  const { ws, dir, project, area } = await setup('submodule')
  const nestedRemote = await bare(area, 'nested', { 'n.txt': 'n\n' })
  const studyRemote = await bare(area, 'study-x', { 's.txt': 's\n' }, [{ path: 'nest', url: nestedRemote }])
  await gitOk(dir, ['submodule', 'add', '-q', studyRemote, 'study/study-x'], { config: LOCAL_TRANSPORT })
  await gitOk(dir, ['submodule', 'update', '--init', '--recursive', '-q'], { config: LOCAL_TRANSPORT })
  await gitOk(dir, ['commit', '-q', '-m', 'study']); await gitOk(dir, ['push', '-q', 'origin', 'main'])
  // A commit of the study that only the workspace has (not pushed) and
  // that the root records: the copy gets it from the workspace.
  await writeFile(join(dir, 'study/study-x/s.txt'), 's2\n')
  await gitOk(join(dir, 'study/study-x'), ['commit', '-q', '-am', 'local study commit'])
  await gitOk(dir, ['add', 'study/study-x']); await gitOk(dir, ['commit', '-q', '-m', 'bump study'])
  const studyBase = await head(join(dir, 'study/study-x'))
  const docsBase = await head(join(dir, 'devdocs'))
  // An uncommitted edit inside the study is not taken either.
  await writeFile(join(dir, 'study/study-x/s.txt'), 'uncommitted\n')
  const p = await prepareCopy(ws, { project, workflow: 'ship', receipt: 'subs' })
  const m = p.copy.manifest!
  const byPath = Object.fromEntries(m.repositories.map(r => [r.path, r]))
  assert.deepEqual(Object.keys(byPath).sort(), ['.', 'devdocs', 'study/study-x', 'study/study-x/nest'])
  for (const [path, base] of [['devdocs', docsBase], ['study/study-x', studyBase]] as const) {
    const d = join(p.copy.tree, path)
    assert.equal(byPath[path].base, base)
    assert.equal(byPath[path].branch, m.branch)
    assert.equal(byPath[path].target, 'main')
    assert.equal(await branch(d), m.branch)
    assert.equal(await head(d), base)
    assert.match(await readFile(join(d, '.git'), 'utf8'), /^gitdir: /, 'the standard submodule layout (git dir under the copy\'s .git/modules)')
    assert.equal((await gitOk(d, ['remote', 'get-url', 'origin'])).trim(), (await gitOk(join(dir, path), ['remote', 'get-url', 'origin'])).trim())
  }
  assert.equal(await readFile(join(p.copy.tree, 'study/study-x/s.txt'), 'utf8'), 's2\n')
  // Nested (project_migration p6 ex1): the run's too, on its branch at the gitlink the study records.
  const nest = join(p.copy.tree, 'study/study-x/nest')
  assert.equal(await readFile(join(nest, 'n.txt'), 'utf8'), 'n\n')
  assert.equal(await branch(nest), m.branch)
  assert.equal(byPath['study/study-x/nest'].base, await head(join(dir, 'study/study-x/nest')))
  assert.equal(byPath['study/study-x/nest'].target, 'main')
  // Git sees the copy as clean and the gitlinks as recorded.
  assert.equal((await gitOk(p.copy.tree, ['status', '--porcelain'])).trim(), '')
  // The workspace's study is untouched (its branch, its uncommitted edit).
  assert.equal(await branch(join(dir, 'study/study-x')), 'main')
  assert.equal(await readFile(join(dir, 'study/study-x/s.txt'), 'utf8'), 'uncommitted\n')
})

test('a damaged or missing copy is reported, never replaced; the index is rebuilt from the copy only when asked', async () => {
  const { ws, project } = await setup()
  const p = await prepareCopy(ws, { project, workflow: 'ship', receipt: 'dmg' })
  await createRun(ws, { workflow: 'ship', name: p.copy.ref.run, into: p.workspace, storage: storageOf(p.copy.manifest!), input: { kind: 'braindump', text: 'Build.', author: 'Test Person' }, executor: { host: 'autolab' }, by: 'Test Person', via: 'browser' })
  const manifestFile = join(copyDir(ws, p.copy.ref), 'copy.json')
  const original = JSON.parse(await readFile(manifestFile, 'utf8'))
  await writeFile(manifestFile, '{ not json')
  await assert.rejects(runSpace(ws, p.copy.ref), (e: unknown) => e instanceof RequestError && /damaged/.test(e.message))
  assert.deepEqual((await inspectIndex(ws)).map(e => e.state), ['damaged'])
  await rm(manifestFile)
  assert.match((await readCopy(ws, p.copy.ref))!.problem!, /--rebuild/)
  const rebuilt = await inspectIndex(ws, { rebuild: true })
  assert.deepEqual(rebuilt.map(e => [e.state, e.branch]), [['rebuilt', original.branch]])
  const m = (await readCopy(ws, p.copy.ref))!.manifest!
  assert.deepEqual(m.repositories.map(r => [r.path, r.base, r.branch, r.target]), original.repositories.map((r: { path: string; base: string; branch: string; target: string }) => [r.path, r.base, r.branch, r.target]))
  assert.ok(m.reconstructed)
  assert.equal((await runSpace(ws, p.copy.ref)).root, p.copy.tree)
  // The working copy itself gone: reported with the branch that keeps its saved work.
  await rm(p.copy.tree, { recursive: true, force: true })
  await assert.rejects(runSpace(ws, p.copy.ref), (e: unknown) => e instanceof RequestError && /missing.*wfe\/p\d+\/ship\/run-001/.test(e.message))
  assert.deepEqual((await inspectIndex(ws, { rebuild: true })).map(e => e.state), ['damaged'], 'nothing is recreated')
  assert.equal(await exists(p.copy.tree), false)
})
