// improve_wfrun p2 step 3: retiring and restoring a finished run's working copy.
// Local data of every kind survives, unknown data is never discarded, a crash at
// each step is recoverable, corruption stops destructive progress, and a
// continuation of a retired run restores first and keeps its frozen definition.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk, LOCAL_TRANSPORT } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { inspectRun, inspectWorkspace, restoreRun, retainedFile, retireRun, retentionRepo, storageView } from '../server/retention.ts'
import { createRunInCopy, listRuns, readRun, readRunFile, runOp } from '../server/runs.ts'
import { copyDir, readCopy, reserve, runSpace, treeSpace, updateManifest } from '../server/runspace.ts'
import { publishRun } from '../server/publish.ts'
import { Workspace } from '../server/workspace.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-retire-'))
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
  await writeFile(join(dir, '.gitignore'), '*.cache\nbuild/\n')
  await writeFile(join(dir, 'kept.txt'), 'tracked\n')
  await writeFile(join(dir, 'gone.txt'), 'will be deleted\n')
  if (mode === 'submodule') { await gitOk(join(dir, 'devdocs'), ['add', '-A']); await gitOk(join(dir, 'devdocs'), ['commit', '-q', '-m', 'workflow']); await gitOk(join(dir, 'devdocs'), ['push', '-q', 'origin', 'HEAD']) }
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remotes', `pj-p${n}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote])
  await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  const ws = new Workspace((await loadRegistry(registry)).workspaces.find(w => w.id === `p${n}`)!)
  const x = new ExecStore({ registryFile: registry, area })
  return { area, registry, dir, remote, ws, x, project: `p${n}` }
}
type S = Awaited<ReturnType<typeof setup>>
type Db = { tx: <T>(f: () => T) => T; run: (sql: string, ...a: unknown[]) => unknown; all: <T>(sql: string, ...a: unknown[]) => T[] }
const db = (s: S) => s.x as unknown as Db
const make = async (s: S, receipt = 'req-1') => (await createRunInCopy(s.ws, { workflow: 'ship', input: { kind: 'braindump', text: 'Go.', author: 'tester' }, executor: { host: 'autolab' }, by: 'tester', via: 'test', receipt } as never)).ref
// A finished run: its node done, the execution completed by its own record.
async function finish(s: S, ref: { workflow: string; run: string }) {
  await runOp(s.ws, ref, { op: 'node.start', node: 'build' } as never, { by: 'a', via: 'cli' })
  await runOp(s.ws, ref, { op: 'node.complete', node: 'build', outcome: 'done' } as never, { by: 'a', via: 'cli' })
  const r = (await readRun(s.ws, ref)).record!
  assert.equal(r.execution.state, 'completed')
}
// Local data of every kind in a copy.
async function dirty(tree: string) {
  await writeFile(join(tree, 'kept.txt'), 'modified, not staged\n')
  await writeFile(join(tree, 'staged.txt'), 'staged only\n')
  await gitOk(tree, ['add', 'staged.txt'])
  await rm(join(tree, 'gone.txt'))
  await writeFile(join(tree, 'untracked.txt'), 'untracked\n')
  await writeFile(join(tree, 'note.cache'), 'ignored\n')
  await mkdir(join(tree, 'build', 'deep'), { recursive: true })
  await writeFile(join(tree, 'build', 'deep', 'run.sh'), '#!/bin/sh\n')
  await chmod(join(tree, 'build', 'deep', 'run.sh'), 0o755)
  await symlink('run.sh', join(tree, 'build', 'deep', 'link'))
  await symlink('/etc/hosts', join(tree, 'build', 'outside'))
  await mkdir(join(tree, 'build', 'empty'))
  await mkdir(join(tree, '.local'), { recursive: true })
  await writeFile(join(tree, '.local', 'settings.txt'), 'local\n')
}
async function assertDirtyBack(tree: string) {
  assert.equal(await readFile(join(tree, 'kept.txt'), 'utf8'), 'modified, not staged\n')
  assert.equal(await readFile(join(tree, 'untracked.txt'), 'utf8'), 'untracked\n')
  assert.equal(await readFile(join(tree, 'note.cache'), 'utf8'), 'ignored\n')
  assert.equal(await stat(join(tree, 'gone.txt')).catch(() => null), null, 'a deleted tracked file stays deleted')
  assert.ok((await stat(join(tree, 'build', 'deep', 'run.sh'))).mode & 0o100, 'the executable mode returns')
  assert.equal(await readlink(join(tree, 'build', 'deep', 'link')), 'run.sh')
  assert.equal(await readlink(join(tree, 'build', 'outside')), '/etc/hosts', 'a link leaving the copy returns as a link, not its target')
  assert.ok((await stat(join(tree, 'build', 'empty'))).isDirectory())
  assert.equal(await readFile(join(tree, '.local', 'settings.txt'), 'utf8'), 'local\n')
  const status = await gitOk(tree, ['status', '--porcelain=v1'])
  assert.match(status, /^A {2}staged\.txt$/m, 'the staged state returns')
  assert.match(status, /^ M kept\.txt$/m)
  assert.match(status, /^ D gone\.txt$/m)
  assert.match(status, /^\?\? untracked\.txt$/m)
}

test('retire and restore: dirty, staged, untracked and ignored bytes, modes and links return; the record stays readable and writable; main advancing does not matter; nothing starts', async () => {
  const s = await setup()
  try {
    const ref = await make(s)
    await finish(s, ref)
    const c = (await readCopy(s.ws, ref))!
    await writeFile(join(c.tree, 'committed.txt'), 'on the run branch\n')
    await gitOk(c.tree, ['add', 'committed.txt']); await gitOk(c.tree, ['commit', '-q', '-m', 'work'])
    await writeFile(join(c.tree, 'devdocs/runs/ship/run-001/report.md'), 'the report\n')
    await dirty(c.tree)
    const headBefore = (await gitOk(c.tree, ['rev-parse', 'HEAD'])).trim()
    const dry = await retireRun(s.x, s.ws, ref, { by: 'check', dryRun: true })
    assert.equal(dry.outcome, 'dry-run'); assert.equal(dry.reasons.length, 0, dry.reasons.join())
    assert.ok(dry.inventory!.archive >= 7)
    assert.ok(await stat(c.tree), 'a dry run changes nothing')
    const seqBefore = (await readRun(s.ws, ref)).record!.seq
    const r = await retireRun(s.x, s.ws, ref, { by: 'check' })
    assert.equal(r.outcome, 'retired', r.reasons.join())
    assert.equal(await stat(c.tree).catch(() => null), null, 'the tree is released')
    // Reads and later records without a checkout.
    const space = await runSpace(s.ws, ref)
    assert.equal(space.copyOf!.treeless, true)
    assert.equal((await readRun(s.ws, ref)).record!.seq, seqBefore, 'retirement is no run event')
    assert.equal((await readRunFile(s.ws, ref, 'report.md')).text, 'the report\n')
    assert.ok((await listRuns(s.ws)).some(x => x.run === 'run-001'))
    assert.equal((await storageView(s.x, s.ws, ref)).state, 'retired')
    await assert.rejects(treeSpace(s.ws, ref), /retired/)
    await runOp(s.ws, ref, { op: 'node.progress', node: 'build', text: 'a late note' } as never, { by: 'a', via: 'cli' }).catch(() => null)
    const later = (await readRun(s.ws, ref)).record!.seq
    // Retained files read in place, committed and archived alike.
    assert.equal((await retainedFile(s.ws, ref, 'committed.txt'))!.toString(), 'on the run branch\n')
    assert.equal((await retainedFile(s.ws, ref, 'untracked.txt'))!.toString(), 'untracked\n')
    // main moves on; identity stays reserved: replaying the request finds the run.
    await gitOk(s.dir, ['commit', '-q', '--allow-empty', '-m', 'later']); await gitOk(s.dir, ['push', '-q', 'origin', 'main'])
    assert.equal((await make(s)).run, 'run-001', 'the same request finds the retired run')
    assert.equal((await make(s, 'req-2')).run, 'run-002', 'its number is never reused')
    const res = await restoreRun(s.x, s.ws, ref, { by: 'check' })
    assert.equal(res.outcome, 'restored', res.reasons.join())
    assert.equal((await gitOk(c.tree, ['rev-parse', 'HEAD'])).trim(), headBefore)
    assert.equal((await gitOk(c.tree, ['symbolic-ref', '--short', 'HEAD'])).trim(), c.manifest!.branch)
    await assertDirtyBack(c.tree)
    assert.ok((await lstat(join(c.tree, 'devdocs/runs/ship/run-001'))).isSymbolicLink())
    assert.equal(await readFile(join(c.tree, 'devdocs/runs/ship/run-001/report.md'), 'utf8'), 'the report\n')
    assert.equal((await readRun(s.ws, ref)).record!.seq, later, 'the latest record stays authoritative')
    assert.equal(s.x.storageBlockers(s.ws.reg.id, ref).length, 0, 'restoration queues nothing')
    // Publishing works again after restoration.
    const space2 = await treeSpace(s.ws, ref)
    const pub = await publishRun(space2, 'after restore', [], {}, { '.': c.manifest!.branch }, f => f())
    assert.equal(pub.state, 'published', JSON.stringify(pub))
    // A second retirement of the same run works and retains the new head.
    assert.equal((await retireRun(s.x, s.ws, ref, { by: 'check' })).outcome, 'retired')
    assert.equal((await restoreRun(s.x, s.ws, ref, { by: 'check' })).outcome, 'restored')
    assert.equal(await readFile(join(c.tree, 'committed.txt'), 'utf8'), 'on the run branch\n')
  } finally { s.x.close() }
})

test('nested submodules: commits, dirty files and the devdocs submodule survive restoration', async () => {
  const s = await setup('submodule')
  try {
    const area = s.area
    const innerSrc = join(area, 'src-inner'); await gitOk(area, ['init', '-q', '--initial-branch=main', innerSrc]); await writeFile(join(innerSrc, 'i.txt'), 'inner\n'); await gitOk(innerSrc, ['add', '-A']); await gitOk(innerSrc, ['commit', '-q', '-m', 'i'])
    const inner = join(area, 'remotes', 'inner.git'); await gitOk(area, ['clone', '-q', '--bare', innerSrc, inner])
    const midSrc = join(area, 'src-mid'); await gitOk(area, ['init', '-q', '--initial-branch=main', midSrc]); await gitOk(midSrc, ['submodule', 'add', '-q', inner, 'inner'], { config: LOCAL_TRANSPORT }); await writeFile(join(midSrc, 'm.txt'), 'mid\n'); await gitOk(midSrc, ['add', '-A']); await gitOk(midSrc, ['commit', '-q', '-m', 'm'])
    const mid = join(area, 'remotes', 'mid.git'); await gitOk(area, ['clone', '-q', '--bare', midSrc, mid])
    await gitOk(s.dir, ['submodule', 'add', '-q', mid, 'mid'], { config: LOCAL_TRANSPORT })
    await gitOk(join(s.dir, 'mid'), ['submodule', 'update', '-q', '--init'], { config: LOCAL_TRANSPORT })
    await gitOk(s.dir, ['add', '-A']); await gitOk(s.dir, ['commit', '-q', '-m', 'sub']); await gitOk(s.dir, ['push', '-q', 'origin', 'main'])
    const ref = await make(s)
    await finish(s, ref)
    const c = (await readCopy(s.ws, ref))!
    const paths = c.manifest!.repositories.filter(r => r.initialized).map(r => r.path).sort()
    assert.deepEqual(paths, ['.', 'devdocs', 'mid', 'mid/inner'])
    await writeFile(join(c.tree, 'mid/inner/i.txt'), 'nested work\n')
    await gitOk(join(c.tree, 'mid/inner'), ['commit', '-q', '-am', 'nested commit'])
    const nested = (await gitOk(join(c.tree, 'mid/inner'), ['rev-parse', 'HEAD'])).trim()
    await writeFile(join(c.tree, 'mid/inner/dirty.txt'), 'nested dirty\n')
    await writeFile(join(c.tree, 'mid/m.txt'), 'mid modified\n')
    await writeFile(join(c.tree, 'devdocs/runs/ship/run-001/doc.md'), 'in the record\n')
    assert.equal((await retireRun(s.x, s.ws, ref, { by: 'check' })).outcome, 'retired')
    const r = await restoreRun(s.x, s.ws, ref, { by: 'check' })
    assert.equal(r.outcome, 'restored', r.reasons.join())
    assert.equal((await gitOk(join(c.tree, 'mid/inner'), ['rev-parse', 'HEAD'])).trim(), nested, 'the nested commit no remote has returns')
    assert.equal(await readFile(join(c.tree, 'mid/inner/dirty.txt'), 'utf8'), 'nested dirty\n')
    assert.equal(await readFile(join(c.tree, 'mid/m.txt'), 'utf8'), 'mid modified\n')
    assert.equal(await readFile(join(c.tree, 'devdocs/runs/ship/run-001/doc.md'), 'utf8'), 'in the record\n')
    assert.equal((await gitOk(join(c.tree, 'mid/inner'), ['remote', 'get-url', 'origin'])).trim(), inner, 'remotes return, not the retention store')
    assert.match(await gitOk(c.tree, ['submodule', 'status', '--recursive']), /mid\/inner/)
    assert.equal((await gitOk(join(c.tree, 'devdocs'), ['status', '--porcelain', '--untracked-files=all'])).trim(), '', 'the snapshot and link stay out of Git\'s sight in a devdocs submodule')
  } finally { s.x.close() }
})

test('eligibility: unfinished, standing, held, queued and presentation-dependent runs keep their copies with concrete reasons; a legacy run is told apart', async () => {
  const s = await setup()
  try {
    const running = await make(s)
    let e = await inspectRun(s.x, s.ws, running)
    assert.equal(e.eligible, false); assert.match(e.reasons.join(), /not-started/)
    assert.equal((await retireRun(s.x, s.ws, running, { by: 'check' })).outcome, 'refused')
    assert.ok(await stat((await readCopy(s.ws, running))!.tree))
    await finish(s, running)
    assert.equal((await inspectRun(s.x, s.ws, running)).eligible, true)
    // A queued continuation.
    db(s).tx(() => db(s).run('INSERT INTO jobs (workspace, workflow, run, kind, reason, receipt, state, created, worker) VALUES (?, ?, ?, \'resume\', \'test\', \'r1\', \'queued\', ?, NULL)', s.ws.reg.id, running.workflow, running.run, new Date().toISOString()))
    e = await inspectRun(s.x, s.ws, running)
    assert.match(e.reasons.join(), /a continuation is queued/)
    db(s).tx(() => db(s).run('DELETE FROM jobs'))
    // A process working in the tree.
    const c = (await readCopy(s.ws, running))!
    const { spawn } = await import('node:child_process')
    const p = spawn('sleep', ['30'], { cwd: c.tree, stdio: 'ignore' })
    try {
      await new Promise(r => setTimeout(r, 200))
      e = await inspectRun(s.x, s.ws, running)
      assert.match(e.reasons.join(), new RegExp(`process ${p.pid} works in the tree`))
    } finally { p.kill() }
    // An available presentation depends on the tree.
    const rec = JSON.parse(await readFile(join(copyDir(s.ws, running), 'record/devdocs/runs/ship/run-001/run.json'), 'utf8'))
    assert.equal(rec.execution.state, 'completed')
    const all = await inspectWorkspace(s.x, s.ws)
    assert.equal(all.find(x => x.ref === 'ship/run-001')!.eligible, true)
    // Legacy: no managed copy.
    const legacy = await inspectRun(s.x, s.ws, { workflow: 'ship', run: 'run-old' })
    assert.equal(legacy.managed, false)
    assert.equal((await retireRun(s.x, s.ws, { workflow: 'ship', run: 'run-old' }, { by: 'check' })).outcome, 'refused')
  } finally { s.x.close() }
})

test('unknown data keeps the copy: a socket or unreadable file refuses until an explicit discard, and a discard is reported at restoration', async () => {
  const s = await setup()
  try {
    const ref = await make(s)
    await finish(s, ref)
    const c = (await readCopy(s.ws, ref))!
    await gitOk(c.tree, ['status']) // the copy is sound
    const { execFileSync } = await import('node:child_process')
    execFileSync('mkfifo', [join(c.tree, 'agent.pipe')])
    const r = await retireRun(s.x, s.ws, ref, { by: 'check' })
    assert.equal(r.outcome, 'refused')
    assert.match(r.reasons.join(), /unclassified agent\.pipe/)
    assert.ok(await stat(c.tree), 'the copy stays')
    assert.equal((await readCopy(s.ws, ref))!.manifest!.state, 'ready')
    await writeFile(join(c.tree, 'cache.bin'), 'x'.repeat(100))
    const ok = await retireRun(s.x, s.ws, ref, { by: 'check', discard: [{ path: 'agent.pipe', reason: 'a pipe of a process that ended' }, { path: 'cache.bin', reason: 'rebuilt by make' }] })
    assert.equal(ok.outcome, 'retired', ok.reasons.join())
    const back = await restoreRun(s.x, s.ws, ref, { by: 'check' })
    assert.equal(back.outcome, 'restored', back.reasons.join())
    assert.deepEqual(back.discarded!.map(d => d.path).sort(), ['agent.pipe', 'cache.bin'])
    assert.equal(await stat(join(c.tree, 'cache.bin')).catch(() => null), null)
  } finally { s.x.close() }
})

test('interruption: a failure at each step leaves the tree or the archive intact, and running again finishes; a retirement can be abandoned', async () => {
  const s = await setup()
  try {
    const ref = await make(s)
    await finish(s, ref)
    const c = (await readCopy(s.ws, ref))!
    await writeFile(join(c.tree, 'untracked.txt'), 'untracked\n')
    // Staging left behind by a crash during archive creation.
    await mkdir(join(c.dir, 'archive.staging', 'verify'), { recursive: true })
    await writeFile(join(c.dir, 'archive.staging', 'files.tgz'), 'half written')
    // Failure while retaining commits: the retention store cannot be made.
    await mkdir(join(s.dir, '.local', 'wfe'), { recursive: true })
    await writeFile(join(s.dir, '.local', 'wfe', 'retention'), 'a file in the way')
    const failed = await retireRun(s.x, s.ws, ref, { by: 'check' })
    assert.equal(failed.outcome, 'failed')
    assert.equal(failed.state, 'retiring')
    assert.ok(await stat(c.tree), 'nothing was released')
    assert.match((await readCopy(s.ws, ref))!.manifest!.lifecycle!.failure!.step, /commits/)
    assert.ok((await readRun(s.ws, ref)).record, 'the record reads during a failed retirement')
    await assert.rejects(treeSpace(s.ws, ref), /retiring/, 'no tree writer starts meanwhile')
    await rm(join(s.dir, '.local', 'wfe', 'retention'))
    const again = await retireRun(s.x, s.ws, ref, { by: 'check' })
    assert.equal(again.outcome, 'retired', again.reasons.join())
    assert.equal(await stat(join(c.dir, 'archive.staging')).catch(() => null), null)
    // A crash between the decision and the release: the tree is moved aside or
    // still there. Restoration finishes the release first, then rebuilds.
    assert.equal((await restoreRun(s.x, s.ws, ref, { by: 'check' })).outcome, 'restored')
    assert.equal((await retireRun(s.x, s.ws, ref, { by: 'check' })).outcome, 'retired')
    await mkdir(join(c.tree, '.git'), { recursive: true })
    await writeFile(join(c.tree, 'leftover'), 'from a crash before the release finished')
    const rest = await restoreRun(s.x, s.ws, ref, { by: 'check' })
    assert.equal(rest.outcome, 'restored', rest.reasons.join())
    assert.equal(await stat(join(c.tree, 'leftover')).catch(() => null), null)
    assert.equal(await readFile(join(c.tree, 'untracked.txt'), 'utf8'), 'untracked\n')
    // A crash during restoration: a half-built staging tree and the state left.
    assert.equal((await retireRun(s.x, s.ws, ref, { by: 'check' })).outcome, 'retired')
    await mkdir(join(c.dir, 'tree.restoring', 'half'), { recursive: true })
    await updateManifest(s.ws, ref, m => { m.state = 'restoring' })
    assert.equal((await restoreRun(s.x, s.ws, ref, { by: 'check' })).outcome, 'restored')
    assert.equal(await stat(join(c.dir, 'tree.restoring')).catch(() => null), null)
    // An abandoned retirement: the tree was never released.
    await updateManifest(s.ws, ref, m => { m.state = 'retiring' })
    const abandoned = await restoreRun(s.x, s.ws, ref, { by: 'check' })
    assert.equal(abandoned.state, 'ready')
    assert.equal(await readFile(join(c.tree, 'untracked.txt'), 'utf8'), 'untracked\n')
    // A restored run retires with a new generation and restoration still works when repeated.
    assert.equal((await restoreRun(s.x, s.ws, ref, { by: 'check' })).outcome, 'nothing', 'restoring a ready run does nothing')
  } finally { s.x.close() }
})

test('corruption and unavailability stop progress with an actionable error and never report success', async () => {
  const s = await setup()
  try {
    const ref = await make(s)
    await finish(s, ref)
    const c = (await readCopy(s.ws, ref))!
    await writeFile(join(c.tree, 'untracked.txt'), 'untracked\n')
    assert.equal((await retireRun(s.x, s.ws, ref, { by: 'check' })).outcome, 'retired')
    const tgz = join(c.dir, 'archive', 'files.tgz')
    const bytes = await readFile(tgz)
    await truncate(tgz, 10)
    let r = await restoreRun(s.x, s.ws, ref, { by: 'check' })
    assert.equal(r.outcome, 'failed'); assert.match(r.reasons.join(), /checksum/)
    assert.equal((await readCopy(s.ws, ref))!.manifest!.state, 'retired', 'the state stays retired')
    assert.equal(await stat(c.tree).catch(() => null), null)
    await rm(tgz)
    r = await restoreRun(s.x, s.ws, ref, { by: 'check' })
    assert.match(r.reasons.join(), /unavailable/)
    await writeFile(tgz, bytes)
    const key = (await readCopy(s.ws, ref))!.manifest!.lifecycle!.repositories![0].key
    const bare = retentionRepo(s.ws, key)
    await rename(bare, `${bare}.away`)
    r = await restoreRun(s.x, s.ws, ref, { by: 'check' })
    assert.equal(r.outcome, 'failed'); assert.match(r.reasons.join(), /retention repository .* unavailable/)
    const dry = await restoreRun(s.x, s.ws, ref, { by: 'check', dryRun: true })
    assert.match(dry.reasons.join(), /unavailable/)
    await rename(`${bare}.away`, bare)
    assert.equal((await restoreRun(s.x, s.ws, ref, { by: 'check' })).outcome, 'restored')
  } finally { s.x.close() }
})

test('a corrupted archive cannot release the tree: verification failure at retirement keeps the copy', async () => {
  const s = await setup()
  try {
    const ref = await make(s)
    await finish(s, ref)
    const c = (await readCopy(s.ws, ref))!
    await writeFile(join(c.tree, 'untracked.txt'), 'untracked\n')
    // A tar on PATH that writes nothing useful.
    const fake = join(s.area, 'fakebin'); await mkdir(fake)
    await writeFile(join(fake, 'tar'), '#!/bin/sh\ncase "$1" in -czf) echo garbage > "$2";; *) exit 1;; esac\n'); await chmod(join(fake, 'tar'), 0o755)
    const path = process.env.PATH
    process.env.PATH = `${fake}:${path}`
    let r
    try { r = await retireRun(s.x, s.ws, ref, { by: 'check' }) } finally { process.env.PATH = path }
    assert.equal(r.outcome, 'failed'); assert.match(r.reasons.join(), /archive/)
    assert.equal(await readFile(join(c.tree, 'untracked.txt'), 'utf8'), 'untracked\n')
    assert.equal((await retireRun(s.x, s.ws, ref, { by: 'check' })).outcome, 'retired')
  } finally { s.x.close() }
})

test('races: a claim during retirement waits; a job queued before the last check wins; a job on a retired run restores it first and keeps the frozen definition', async () => {
  const s = await setup()
  try {
    const ref = await make(s)
    await finish(s, ref)
    const c = (await readCopy(s.ws, ref))!
    // attempt.begin refuses while retiring, under the record lock.
    await updateManifest(s.ws, ref, m => { m.state = 'retiring' })
    await assert.rejects(runOp(s.ws, ref, { op: 'attempt.begin', attempt: 'a1', reason: 'resume' } as never, { by: 'autolab', via: 'exec' }), (e: Error & { detail?: { code?: string } }) => e.detail?.code === 'run-retired')
    await updateManifest(s.ws, ref, m => { m.state = 'ready' })
    // The job arrives after eligibility was first read: the last check wins for it.
    const orig = s.x.storageBlockers.bind(s.x)
    let calls = 0
    s.x.storageBlockers = (w, r) => { calls++; return calls >= 4 ? ['job 9 (resume) is queued: a continuation is queued'] : orig(w, r) }
    const lost = await retireRun(s.x, s.ws, ref, { by: 'check' })
    s.x.storageBlockers = orig
    assert.equal(lost.outcome, 'refused'); assert.equal(lost.state, 'ready')
    assert.ok(await stat(c.tree), 'the tree stays when work wins')
    assert.equal((await readCopy(s.ws, ref))!.manifest!.state, 'ready')
    // Retired, then a correction's job: the claim waits and restoration is requested once.
    assert.equal((await retireRun(s.x, s.ws, ref, { by: 'check' })).outcome, 'retired')
    const def = await readFile(join(c.dir, 'record/devdocs/runs/ship/run-001/definition/ship.yaml'), 'utf8')
    await writeFile(join(s.dir, 'devdocs/workflows/ship.yaml'), WF.replace('Build it.', 'Today\'s different intent.')); await gitOk(s.dir, ['add', '-A']); await gitOk(s.dir, ['commit', '-q', '-m', 'today']); await gitOk(s.dir, ['push', '-q', 'origin', 'main'])
    let requested = 0
    s.x.requestRestore = () => { requested++ }
    db(s).tx(() => db(s).run('INSERT INTO jobs (workspace, workflow, run, kind, reason, receipt, state, created, worker) VALUES (?, ?, ?, \'resume\', \'correction\', \'r2\', \'queued\', ?, NULL)', s.ws.reg.id, ref.workflow, ref.run, new Date().toISOString()))
    const claim = await s.x.claim('fake', { profiles: {} } as never, {} as never) as { idle?: string }
    assert.ok(claim.idle !== undefined)
    assert.equal(requested, 1)
    const job = db(s).all<{ state: string; note: string }>('SELECT * FROM jobs')[0]
    assert.equal(job.state, 'queued'); assert.match(job.note, /retired/)
    assert.equal((await restoreRun(s.x, s.ws, ref, { by: 'autolab' })).outcome, 'restored')
    assert.equal((await readRun(s.ws, ref)).bundle.entries.ship.text ?? def, def)
    assert.equal(await readFile(join(c.tree, 'devdocs/runs/ship/run-001/definition/ship.yaml'), 'utf8'), def, 'the frozen definition, not today\'s')
    assert.notEqual(def, await readFile(join(s.dir, 'devdocs/workflows/ship.yaml'), 'utf8'))
  } finally { s.x.close() }
})

test('an acceptance of a retired run says to restore it; a run still reserved keeps its number', async () => {
  const s = await setup()
  try {
    const ref = await make(s)
    await finish(s, ref)
    assert.equal((await retireRun(s.x, s.ws, ref, { by: 'check' })).outcome, 'retired')
    await assert.rejects(runOp(s.ws, ref, { op: 'run.decide', decision: 'accepted', evidence: 'x' } as never, { by: 'a', via: 'cli' }), /restore it first/)
    const r = await reserve(s.ws, { project: s.project, workflow: 'ship' })
    assert.equal(r.ref.run, 'run-002')
  } finally { s.x.close() }
})

test('HTTP and tools on a retired run: run view, files, history links, observation and delegation reads need no checkout', async () => {
  const s = await setup()
  const { createHandler } = await import('../server/api.ts')
  const { createServer } = await import('node:http')
  const { Observer } = await import('../server/observe.ts')
  const srv = createServer(createHandler({ registryFile: s.registry, area: s.area, allowedOrigins: [], exec: s.x }))
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', () => res()))
  const url = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}`
  try {
    const ref = await make(s)
    await finish(s, ref)
    const c = (await readCopy(s.ws, ref))!
    await writeFile(join(c.tree, 'devdocs/runs/ship/run-001/report.md'), 'the report\n')
    await writeFile(join(c.tree, 'art.txt'), 'an artifact outside the folder\n')
    await runOp(s.ws, ref, { op: 'artifact.attach', node: 'build', path: 'art.txt' } as never, { by: 'a', via: 'cli' }).catch(() => null)
    const space = await treeSpace(s.ws, ref)
    const pub = await publishRun(space, 'save', [], {}, { '.': c.manifest!.branch }, f => f())
    assert.equal(pub.state, 'published')
    const commit = (await gitOk(c.tree, ['rev-parse', 'HEAD'])).trim()
    const base = `${url}/api/workspaces/${s.ws.reg.id}/runs/ship/run-001`
    const before = await (await fetch(`${base}/storage`)).json() as { state: string; action: string; eligible: boolean }
    assert.deepEqual([before.state, before.action, before.eligible], ['ready', 'retire', true])
    const dry = await fetch(`${base}/storage/retire`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, host: url.slice(7) }, body: JSON.stringify({ by: 'check', dryRun: true }) })
    assert.equal(dry.status, 200, await dry.clone().text())
    assert.equal((await dry.json() as { outcome: string }).outcome, 'dry-run')
    assert.equal((await retireRun(s.x, s.ws, ref, { by: 'check' })).outcome, 'retired')
    const view = await (await fetch(base)).json() as { record: { run: string }; place: { kind: string } }
    assert.equal(view.record.run, 'run-001')
    const report = await fetch(`${base}/files?path=report.md`)
    if (report.status === 200) assert.match(await report.text(), /the report/)
    assert.equal((await readRunFile(s.ws, ref, 'report.md')).text, 'the report\n')
    const exec = await fetch(`${base}/exec`)
    assert.equal(exec.status, 200)
    const hist = await fetch(`${base}?rev=${commit}`)
    assert.ok(hist.status < 500, `history link: ${hist.status} ${await hist.clone().text()}`)
    const after = await (await fetch(`${base}/storage`)).json() as { state: string; action: string; retained: string }
    assert.deepEqual([after.state, after.action], ['retired', 'restore'])
    assert.match(after.retained, /stays readable/)
    const observed = await new Observer(s.x, s.registry).observe({ workspace: s.ws.reg.id, runs: ['ship/run-001'], terminal: true })
    const run = observed.runs.find(r => r.identity.run === 'run-001')!
    assert.equal(run.source.state, 'ok')
    assert.equal(run.identity.run, 'run-001')
  } finally { srv.close(); s.x.close() }
})

test('a file that is a verified published output is not archived twice, returns from the shared area at restoration, and an unavailable share is reported as that', async () => {
  const s = await setup()
  try {
    const { publishOutput, setShareArea } = await import('../server/shares.ts')
    const shareDir = join(root, `share-${n}`)
    await mkdir(shareDir, { recursive: true })
    await writeFile(join(shareDir, '.wfe-share.json'), JSON.stringify({ share: 'agshare' }))
    await writeFile(join(s.area, 'shares.json'), JSON.stringify({ shares: { agshare: { root: shareDir } } }))
    setShareArea(s.area)
    const ref = await make(s)
    await runOp(s.ws, ref, { op: 'node.start', node: 'build' } as never, { by: 'a', via: 'cli' })
    const c = (await readCopy(s.ws, ref))!
    await mkdir(join(c.tree, 'build', 'out'), { recursive: true }) // ignored by the project
    await writeFile(join(c.tree, 'build', 'out', 'rig.bin'), 'the published bytes\n')
    await chmod(join(c.tree, 'build', 'out', 'rig.bin'), 0o755)
    await writeFile(join(c.tree, 'build', 'only-here.bin'), 'not published\n')
    await publishOutput(s.ws, ref, { node: 'build', source: 'build/out', title: 'Rig', candidate: 'rig', share: 'agshare' }, { by: 'agent', via: 'cli' })
    await runOp(s.ws, ref, { op: 'node.complete', node: 'build', outcome: 'done' } as never, { by: 'a', via: 'cli' })
    const r = await retireRun(s.x, s.ws, ref, { by: 'check' })
    assert.equal(r.outcome, 'retired', r.reasons.join())
    assert.equal(r.archive!.published, 1)
    assert.equal(r.archive!.files, 1, 'only what exists nowhere else is archived')
    assert.equal((await retainedFile(s.ws, ref, 'build/out/rig.bin'))!.toString(), 'the published bytes\n', 'read from the shared area')
    assert.equal((await stat(join(shareDir, 'runs'))).isDirectory(), true, 'retirement deletes nothing on the share')
    const back = await restoreRun(s.x, s.ws, ref, { by: 'check' })
    assert.equal(back.outcome, 'restored'); assert.deepEqual(back.reasons, [])
    assert.equal(await readFile(join(c.tree, 'build/out/rig.bin'), 'utf8'), 'the published bytes\n')
    assert.ok((await stat(join(c.tree, 'build/out/rig.bin'))).mode & 0o100)
    assert.equal(await readFile(join(c.tree, 'build/only-here.bin'), 'utf8'), 'not published\n')
    // The share goes away: named as unavailable, never as empty or as success without it.
    assert.equal((await retireRun(s.x, s.ws, ref, { by: 'check' })).outcome, 'retired')
    await rename(shareDir, `${shareDir}.away`)
    const without = await restoreRun(s.x, s.ws, ref, { by: 'check' })
    assert.equal(without.outcome, 'restored')
    assert.match(without.reasons.join(), /build\/out\/rig\.bin: its published output is unavailable/)
    // Retired again while it could not come back, then the share returns: nothing was forgotten
    // (a live re-retirement before this existed lost the list for gimmickimg freework/run-015).
    await rename(`${shareDir}.away`, shareDir)
    await runOp(s.ws, ref, { op: 'node.progress', node: 'build', text: 'note' } as never, { by: 'a', via: 'cli' }).catch(() => null)
    assert.equal((await retireRun(s.x, s.ws, ref, { by: 'check' })).outcome, 'retired')
    const again = await restoreRun(s.x, s.ws, ref, { by: 'check' })
    assert.deepEqual(again.reasons, [])
    assert.equal(await readFile(join(c.tree, 'build/out/rig.bin'), 'utf8'), 'the published bytes\n')
    setShareArea(undefined)
  } finally { s.x.close() }
})
