// improve_wfrun p2 step 2: a run's durable record beside its working copy. The
// agent's path reaches one set of bytes; Git sees a snapshot only; the lock is one
// lock; worker sync reaches the record; a pre-p2 copy relocates and resumes after a crash.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { withLock } from '../server/lock.ts'
import { publishRun } from '../server/publish.ts'
import { relocate, relocationPlan } from '../server/relocate.ts'
import { relocateFolder, withoutLink } from '../server/runrecord.ts'
import { createRunInCopy, listRuns, readRun, runOp } from '../server/runs.ts'
import { readCopy, runSpace, treeSpace, updateManifest } from '../server/runspace.ts'
import { loadRegistry } from '../server/registry.ts'
import { Workspace } from '../server/workspace.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-record-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = T\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
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
  await writeFile(join(dir, '.gitignore'), '*.cache\n')
  if (mode === 'submodule') { await gitOk(join(dir, 'devdocs'), ['add', '-A']); await gitOk(join(dir, 'devdocs'), ['commit', '-q', '-m', 'workflow']); await gitOk(join(dir, 'devdocs'), ['push', '-q', 'origin', 'HEAD']) }
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remotes', `pj-p${n}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote])
  await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  const ws = new Workspace((await loadRegistry(registry)).workspaces.find(w => w.id === `p${n}`)!)
  return { area, registry, dir, remote, ws, project: `p${n}` }
}
const make = async (ws: Workspace, receipt = 'req-1') => (await createRunInCopy(ws, { workflow: 'ship', input: { kind: 'braindump', text: 'Go.', author: 'tester' }, executor: { host: 'autolab' }, by: 'tester', via: 'test', receipt } as never)).ref
const FOLDER = 'devdocs/runs/ship/run-001'

test('the documented run path is a link to one durable folder; records read and write there, and the lock is one lock', async () => {
  const { ws } = await setup()
  const ref = await make(ws)
  const c = (await readCopy(ws, ref))!
  assert.equal(c.manifest!.record, 'durable')
  const path = join(c.tree, FOLDER)
  assert.ok((await lstat(path)).isSymbolicLink())
  assert.equal(await readlink(path), '../../../../record/devdocs/runs/ship/run-001', 'relative, so the copy folder can move')
  await writeFile(join(path, 'plan.md'), 'the plan\n')
  assert.equal(await readFile(join(c.dir, 'record', FOLDER, 'plan.md'), 'utf8'), 'the plan\n')
  await runOp(ws, ref, { op: 'node.start', node: 'build' } as never, { by: 'a', via: 'cli' })
  assert.equal(JSON.parse(await readFile(join(c.dir, 'record', FOLDER, 'run.json'), 'utf8')).nodes.build.state, 'running')
  // A writer holding the lock through either spelling excludes the other.
  let inner = false
  await withLock(join(path, 'run.json'), async () => {
    await assert.rejects(withLock(join(c.dir, 'record', FOLDER, 'run.json'), async () => { inner = true }, { timeoutMs: 50 }))
  })
  assert.equal(inner, false)
  assert.equal((await gitOk(c.tree, ['status', '--porcelain', '--untracked-files=all'])).trim(), '', 'Git does not see the link')
})

for (const mode of ['directory', 'submodule'] as const) test(`a publication commits the record as a snapshot; the agent's git add -A does not capture the link (${mode} devdocs)`, async () => {
  const { ws } = await setup(mode)
  const ref = await make(ws)
  const c = (await readCopy(ws, ref))!
  const space = await treeSpace(ws, ref)
  await writeFile(join(c.tree, FOLDER, 'plan.md'), 'the plan\n')
  await writeFile(join(c.tree, FOLDER, 'notes.cache'), 'ignored\n')
  await writeFile(join(c.tree, 'work.txt'), 'code\n')
  const owner = mode === 'submodule' ? 'devdocs' : '.'
  const folder = mode === 'submodule' ? FOLDER.slice('devdocs/'.length) : FOLDER
  const repo = owner === '.' ? c.tree : join(c.tree, owner)
  const targets: Record<string, string> = Object.fromEntries(c.manifest!.repositories.filter(r => r.initialized).map(r => [r.path, c.manifest!.branch]))
  const r = await publishRun(space, 'ship/run-001: save', [], {}, targets, f => f())
  assert.equal(r.state, 'published', JSON.stringify(r))
  const list = (await gitOk(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])).split('\n')
  assert.ok(list.includes(`${folder}/plan.md`) && list.includes(`${folder}/run.json`))
  // The root's .gitignore applies to a folder of the root, not to a submodule's.
  assert.equal(list.includes(`${folder}/notes.cache`), mode === 'submodule', 'the owning repository\'s ignore rules apply to the snapshot')
  assert.equal((await gitOk(repo, ['cat-file', '-t', `HEAD:${folder}`])).trim(), 'tree', 'a folder, not a link')
  // The agent's habits.
  await writeFile(join(c.tree, 'more.txt'), 'x\n')
  await writeFile(join(c.tree, FOLDER, 'plan.md'), 'plan two\n')
  await gitOk(c.tree, ['add', '-A']); await gitOk(c.tree, ['commit', '-q', '-m', 'agent'])
  assert.equal((await gitOk(repo, ['cat-file', '-t', `HEAD:${folder}`])).trim(), 'tree')
  assert.equal((await gitOk(repo, ['show', `HEAD:${folder}/plan.md`])), 'the plan\n', 'a snapshot moves at publications only')
  assert.equal((await gitOk(repo, ['status', '--porcelain', '--untracked-files=all'])).trim(), '')
  const r2 = await publishRun(space, 'ship/run-001: save', [], {}, targets, f => f())
  assert.equal(r2.state, 'published')
  assert.equal(await gitOk(repo, ['show', `HEAD:${folder}/plan.md`]), 'plan two\n')
  // A removed document leaves the next snapshot; nothing is left to publish then.
  await rm(join(c.tree, FOLDER, 'plan.md'))
  await publishRun(space, 'ship/run-001: save', [], {}, targets, f => f())
  assert.ok(!(await gitOk(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])).includes(`${folder}/plan.md`))
  assert.equal((await publishRun(space, 'again', [], {}, targets, f => f())).state, 'nothing')
})

test('Git moving between snapshots refuses instead of overwriting, and the explicit path keeps the record', async () => {
  const { ws } = await setup()
  const ref = await make(ws)
  const c = (await readCopy(ws, ref))!
  const space = await treeSpace(ws, ref)
  const targets = { '.': c.manifest!.branch }
  await writeFile(join(c.tree, FOLDER, 'plan.md'), 'one\n')
  await publishRun(space, 'one', [], {}, targets, f => f())
  const first = (await gitOk(c.tree, ['rev-parse', 'HEAD'])).trim()
  await writeFile(join(c.tree, FOLDER, 'plan.md'), 'two\n')
  await publishRun(space, 'two', [], {}, targets, f => f())
  await assert.rejects(gitOk(c.tree, ['reset', '--hard', first]))
  assert.equal(await readFile(join(c.dir, 'record', FOLDER, 'plan.md'), 'utf8'), 'two\n')
  await withoutLink(c.tree, ref, '.', () => gitOk(c.tree, ['reset', '-q', '--hard', first]))
  assert.ok((await lstat(join(c.tree, FOLDER))).isSymbolicLink())
  assert.equal(await readFile(join(c.tree, FOLDER, 'plan.md'), 'utf8'), 'two\n', 'the durable record wins')
  assert.equal(await gitOk(c.tree, ['show', 'HEAD:devdocs/runs/ship/run-001/plan.md']), 'one\n')
  assert.equal((await gitOk(c.tree, ['status', '--porcelain', '--untracked-files=all'])).trim(), '')
})

test('a real folder that replaced the link is folded in on the next write; run.json is never taken from it', async () => {
  const { ws } = await setup()
  const ref = await make(ws)
  const c = (await readCopy(ws, ref))!
  const path = join(c.tree, FOLDER)
  const rec = await readFile(join(path, 'run.json'), 'utf8')
  await rm(path)
  await mkdir(path)
  await writeFile(join(path, 'report.md'), 'written in the replaced folder\n')
  await writeFile(join(path, 'run.json'), '{"tampered": true}\n')
  await runOp(ws, ref, { op: 'node.start', node: 'build' } as never, { by: 'a', via: 'cli' })
  assert.ok((await lstat(path)).isSymbolicLink())
  assert.equal(await readFile(join(c.dir, 'record', FOLDER, 'report.md'), 'utf8'), 'written in the replaced folder\n')
  const after = JSON.parse(await readFile(join(c.dir, 'record', FOLDER, 'run.json'), 'utf8'))
  assert.equal(after.tampered, undefined)
  assert.ok(after.seq > JSON.parse(rec).seq)
})

test('a missing tree is reported as missing, not retired; the record stays readable and code operations refuse', async () => {
  const { ws } = await setup()
  const ref = await make(ws)
  const c = (await readCopy(ws, ref))!
  await rm(c.tree, { recursive: true, force: true })
  const again = (await readCopy(ws, ref))!
  assert.match(again.problem!, /missing/)
  const space = await runSpace(ws, ref)
  assert.equal(space.copyOf!.treeless, true)
  assert.equal((await readRun(ws, ref)).record!.run, 'run-001')
  assert.equal((await listRuns(ws)).find(s => s.run === 'run-001')?.run, 'run-001')
  await assert.rejects(treeSpace(ws, ref), /missing/)
  // Git at a record root never reaches the workspace above it.
  await assert.rejects(gitOk(space.root, ['rev-parse', 'HEAD']))
})

// A copy as a pre-p2 release left it: the folder really in the tree, committed.
async function preP2(ws: Workspace, ref: { workflow: string; run: string }) {
  const c = (await readCopy(ws, ref))!
  const folder = `devdocs/runs/${ref.workflow}/${ref.run}`
  const path = join(c.tree, folder)
  await rm(path)
  await cp(join(c.dir, 'record', folder), path, { recursive: true })
  await rm(join(c.dir, 'record'), { recursive: true, force: true })
  await updateManifest(ws, ref, m => { delete m.record })
  await gitOk(c.tree, ['add', '-f', '--', folder]); await gitOk(c.tree, ['commit', '-q', '-m', 'snapshot'])
  await writeFile(join(path, 'draft.md'), 'never published\n')
  await writeFile(join(c.tree, '.git', 'info', 'exclude'), '/.local/\n')
  return c
}

test('relocation: dry run changes nothing, moves under a journal with recovery copies, keeps unpublished documents, survives a crash at every step, and refuses an open attempt or a live executor', async () => {
  const { ws, registry, area, project } = await setup()
  const ref = await make(ws)
  const open = await make(ws, 'req-2')
  await make(ws, 'req-3') // made by this release: durable already
  const c = await preP2(ws, ref)
  await preP2(ws, open)
  await runOp(ws, open, { op: 'attempt.begin', attempt: 'a1', reason: 'start' } as never, { by: 'autolab', via: 'exec' })
  const x = new ExecStore({ registryFile: registry, area })
  try {
    const plan = await relocationPlan(x)
    assert.deepEqual(plan.runs.map(r => r.action), ['relocate', 'blocked', 'relocated'])
    assert.ok((await lstat(join(c.tree, FOLDER))).isDirectory(), 'a dry run changes nothing')
    // A pre-p2 copy still reads and writes through the tree.
    await runOp(ws, ref, { op: 'node.start', node: 'build' } as never, { by: 'a', via: 'cli' })
    x.heartbeat('local', process.pid, 'test')
    await assert.rejects(relocate(x, { by: 'test' }), /executor reported/)
    // A crash after staging, before the swap: the rerun continues.
    await relocateFolder(c.dir, ref, '.').then(async () => {
      // Roll the tree back to "record made, folder still real".
      const path = join(c.tree, FOLDER)
      await rm(path)
      await cp(join(c.dir, 'record', FOLDER), path, { recursive: true })
    })
    const r = await relocate(x, { by: 'test', allowLive: true })
    assert.equal(r.problems.length, 0, r.problems.join('\n'))
    assert.equal(r.moved.length, 1); assert.equal(r.already, 1)
    assert.match(r.blocked[0], /attempt a1 is open/)
    assert.ok(await stat(join(r.backup, 'exec.sqlite')))
    assert.ok(await stat(join(r.backup, 'manifests', project, 'ship', 'run-001.json')))
    assert.ok((await lstat(join(c.tree, FOLDER))).isSymbolicLink())
    assert.equal(await readFile(join(c.dir, 'record', FOLDER, 'draft.md'), 'utf8'), 'never published\n')
    const rec = (await readRun(ws, ref)).record!
    assert.equal(rec.nodes.build.state, 'running')
    assert.deepEqual(rec.history.map(h => h.op).filter(o => /relocat/.test(o)), [], 'a storage change is no run event')
    assert.equal((await gitOk(c.tree, ['status', '--porcelain', '--untracked-files=all'])).trim(), '', 'the snapshot and the link are out of Git\'s sight')
    const space = await treeSpace(ws, ref)
    assert.equal((await publishRun(space, 'after', [], {}, { '.': c.manifest!.branch }, f => f())).state, 'published')
    assert.equal(await gitOk(c.tree, ['show', `HEAD:${FOLDER}/draft.md`]), 'never published\n')
    assert.equal((await relocate(x, { by: 'test', allowLive: true })).moved.length, 0, 'a second pass moves nothing')
  } finally { x.close() }
})

test('wfe validate inside a run\'s copy reads the copy, not the registered workspace', async () => {
  const { registry, ws } = await setup()
  const ref = await make(ws)
  const c = (await readCopy(ws, ref))!
  await writeFile(join(c.tree, 'devdocs/workflows/added.yaml'), WF.replace('id: ship', 'id: added').replace('type: do', 'type: review\n    confirms: result'))
  const { execFile } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const cli = fileURLToPath(new URL('../cli/wfe.ts', import.meta.url))
  const r = await new Promise<{ code: number; out: string }>(res => execFile(process.execPath, [cli, 'validate', 'added'], { cwd: c.tree, env: { ...process.env, WFE_REGISTRY: registry } }, (e, out, err) => res({ code: e ? 1 : 0, out: out + err })))
  assert.equal(r.code, 1)
  assert.match(r.out, /confirms the result but is "review"/)
})
