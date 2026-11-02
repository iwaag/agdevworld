// improve_wfrun p3 step 2: a backup of retired runs. A generation is published only
// verified; interruption, concurrent change and corruption cannot replace the last
// usable one; recovery works in an isolated area with the originals gone, and lost
// pieces come back without overwriting newer events.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { restoreRun, retentionRepo, retireRun } from '../server/retention.ts'
import { backupOverview, coverageOf, createBackup, Dest, expire, isRecoveryArea, loadBackupConfig, readManifest, rehearse, reinstate, restoreGeneration, verifyGeneration } from '../server/runBackup.ts'
import { createRunInCopy, readRun, runOp } from '../server/runs.ts'
import { copyDir, readCopy } from '../server/runspace.ts'
import { publishOutput, setShareArea } from '../server/shares.ts'
import { Workspace } from '../server/workspace.ts'
import { main } from '../cli/wfe.ts'

const run = promisify(execFile)
let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-backup-'))
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
  await writeFile(join(dir, 'kept.txt'), 'tracked\n')
  if (mode === 'submodule') { await gitOk(join(dir, 'devdocs'), ['add', '-A']); await gitOk(join(dir, 'devdocs'), ['commit', '-q', '-m', 'workflow']); await gitOk(join(dir, 'devdocs'), ['push', '-q', 'origin', 'HEAD']) }
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remotes', `pj-p${n}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote])
  await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  const backup = join(root, `backup-${n}`)
  await writeFile(join(area, 'run-backup.json'), JSON.stringify({ path: backup, keep: 2 }))
  await writeFile(join(area, 'shares.json'), JSON.stringify({ shares: { s: { root: join(root, `share-${n}`) } } }))
  await mkdir(join(root, `share-${n}`), { recursive: true })
  await writeFile(join(root, `share-${n}`, '.wfe-share.json'), JSON.stringify({ share: 's' }))
  setShareArea(area)
  const ws = new Workspace((await loadRegistry(registry)).workspaces.find(w => w.id === `p${n}`)!)
  const x = new ExecStore({ registryFile: registry, area })
  return { area, registry, dir, remote, ws, x, backup, project: `p${n}`, dest: new Dest((await loadBackupConfig(area))!) }
}
type S = Awaited<ReturnType<typeof setup>>
// A finished run with staged, untracked and ignored data and an unpublished commit, retired.
async function retired(s: S, receipt: string) {
  const ref = (await createRunInCopy(s.ws, { workflow: 'ship', input: { kind: 'braindump', text: 'Go.', author: 'tester' }, executor: { host: 'autolab' }, by: 'tester', via: 'test', receipt } as never)).ref
  await runOp(s.ws, ref, { op: 'node.start', node: 'build' } as never, { by: 'a', via: 'cli' })
  await runOp(s.ws, ref, { op: 'node.complete', node: 'build', outcome: 'done' } as never, { by: 'a', via: 'cli' })
  const tree = (await readCopy(s.ws, ref))!.tree
  await writeFile(join(tree, 'commit.txt'), `unpublished ${ref.run}\n`)
  await gitOk(tree, ['add', 'commit.txt']); await gitOk(tree, ['commit', '-q', '-m', 'local only'])
  await writeFile(join(tree, 'staged.txt'), 'staged\n'); await gitOk(tree, ['add', 'staged.txt'])
  await writeFile(join(tree, 'untracked.txt'), 'untracked\n')
  await writeFile(join(tree, 'note.cache'), 'ignored\n')
  await writeFile(join(tree, 'run.sh'), '#!/bin/sh\n'); await chmod(join(tree, 'run.sh'), 0o755)
  const res = await retireRun(s.x, s.ws, ref, { by: 'tester' })
  assert.equal(res.outcome, 'retired', res.reasons.join('; '))
  return ref
}
const generationDir = (s: S, id: string) => join(s.backup, 'generations', id)

test('a generation holds a retired run whole and verifies at the destination', async () => {
  const s = await setup()
  const ref = await retired(s, 'r1')
  const b = await createBackup(s.x, { by: 'tester' })
  assert.equal(b.outcome, 'published', b.failures.join('; '))
  assert.equal(await s.dest.latest(), b.id)
  const g = generationDir(s, b.id!)
  for (const f of ['manifest.json', 'manifest.sha256', 'hashes.sha256', `runs/${s.project}/ship/${ref.run}/copy.json`, `runs/${s.project}/ship/${ref.run}/archive/contents.json`, 'stores/exec/exec.sqlite', 'settings/registry.json']) assert.ok(await stat(join(g, f)), f)
  const m = (await readManifest(s.dest))!
  assert.equal(m.runs.length, 1)
  assert.ok(m.runs[0].covered)
  assert.ok(m.runs[0].repositories[0].refs.some(r => r.ref === 'refs/wfe/retain-index'), 'the index tree is listed')
  assert.equal(m.schema, 'ag.wfe-run-backup.v1')
  assert.ok(m.source.git && m.source.node)
  assert.ok((await verifyGeneration(s.dest)).ok)
  assert.deepEqual(coverageOf(m, s.project, `ship/${ref.run}`, m.runs[0].generation).covered, true)
  assert.equal(coverageOf(m, s.project, `ship/${ref.run}`, m.runs[0].generation + 1).covered, false)
  const o = await backupOverview(s.x) as { uncovered: string[]; retired: number; ageSeconds: number }
  assert.equal(o.retired, 1); assert.deepEqual(o.uncovered, [])
  assert.ok(o.ageSeconds >= 0)
  s.x.close()
})

test('runs that are not retired are named, and kept for their identity only', async () => {
  const s = await setup()
  await retired(s, 'r1')
  const live = (await createRunInCopy(s.ws, { workflow: 'ship', input: { kind: 'braindump', text: 'Go.', author: 'tester' }, executor: { host: 'autolab' }, by: 'tester', via: 'test', receipt: 'r2' } as never)).ref
  const b = await createBackup(s.x, { by: 'tester' })
  assert.equal(b.outcome, 'published', b.failures.join('; '))
  const m = (await readManifest(s.dest))!
  assert.deepEqual(m.identityOnly.map(i => [i.ref, i.receipt]), [[`ship/${live.run}`, 'r2']])
  assert.ok(await stat(join(generationDir(s, b.id!), `runs/${s.project}/ship/${live.run}/copy.json`)))
  assert.equal(await stat(join(generationDir(s, b.id!), `runs/${s.project}/ship/${live.run}/tree`)).catch(() => null), null)
  s.x.close()
})

test('an interrupted, corrupted or concurrently changed capture leaves the last generation', async () => {
  const s = await setup()
  const ref = await retired(s, 'r1')
  const first = await createBackup(s.x, { by: 'tester' })
  assert.equal(first.outcome, 'published')
  // Interruption after the transfer.
  const a = await createBackup(s.x, { by: 'tester', hook: st => { if (st === 'transferred') throw new Error('power lost') } })
  assert.equal(a.outcome, 'failed'); assert.match(a.failures[0], /power lost/)
  assert.equal(await s.dest.latest(), first.id)
  // A byte changed in staging.
  const b = await createBackup(s.x, { by: 'tester', hook: async (st, c) => { if (st === 'hashed') { const f = join(c.partial, `runs/${s.project}/ship/${ref.run}/copy.json`); const t = await readFile(f, 'utf8'); await rm(f); await writeFile(f, `${t} `) } } })
  assert.equal(b.outcome, 'failed'); assert.match(b.failures[0], /does not verify/); assert.match(b.failures[0], /copy\.json/)
  assert.equal(await s.dest.latest(), first.id)
  // A retained object lost in staging.
  const c = await createBackup(s.x, { by: 'tester', hook: async (st, k) => { if (st === 'hashed') await rm(join(k.partial, 'hashes.sha256')) } })
  assert.equal(c.outcome, 'failed')
  assert.equal(await s.dest.latest(), first.id)
  // A restoration while bytes move: the generation would mix two states.
  const d = await createBackup(s.x, { by: 'tester', hook: async st => { if (st === 'transferred') { const r = await restoreRun(s.x, s.ws, ref, { by: 'tester' }); assert.equal(r.outcome, 'restored', r.reasons.join('; ')) } } })
  assert.equal(d.outcome, 'failed'); assert.match(d.failures[0], /changed during capture/)
  assert.equal(await s.dest.latest(), first.id)
  assert.deepEqual(await s.dest.generations(), [first.id])
  assert.ok((await verifyGeneration(s.dest)).ok, 'the last generation is intact')
  const status = await backupOverview(s.x) as { status: { lastAttempt: { outcome: string }; last: { id: string } } }
  assert.equal(status.status.lastAttempt.outcome, 'failed')
  assert.equal(status.status.last.id, first.id)
  s.x.close()
})

test('a run the last generation covered and this one cannot does not move LATEST', async () => {
  const s = await setup()
  const ref = await retired(s, 'r1')
  const first = await createBackup(s.x, { by: 'tester' })
  await truncate(join(copyDir(s.ws, ref), 'archive', 'files.tgz'), 3)
  const b = await createBackup(s.x, { by: 'tester' })
  assert.equal(b.outcome, 'degraded'); assert.match(b.failures[0], /covered by/)
  assert.equal(await s.dest.latest(), first.id)
  s.x.close()
})

test('damage at the destination is found and names the runs it affects', async () => {
  const s = await setup()
  const a = await retired(s, 'r1'), b = await retired(s, 'r2')
  const g = await createBackup(s.x, { by: 'tester' })
  const dir = generationDir(s, g.id!)
  const tgz = join(dir, `runs/${s.project}/ship/${a.run}/archive/files.tgz`)
  await appendFile(tgz, 'x') // one generation here, so no other shares this file
  let v = await verifyGeneration(s.dest)
  assert.equal(v.ok, false)
  assert.deepEqual(v.affected, [`${s.project}:ship/${a.run}`])
  await truncate(tgz, (await stat(tgz)).size - 1)
  assert.ok((await verifyGeneration(s.dest)).ok)
  // One retention repository serves both runs.
  const retention = join(dir, 'retention', s.project)
  const bare = join(retention, (await readdir(retention))[0])
  const objects = join(bare, 'objects')
  const subs = (await readdir(objects)).filter(x => /^[0-9a-f]{2}$/.test(x) || x === 'pack')
  await rename(objects, `${objects}.x`); await mkdir(objects)
  v = await verifyGeneration(s.dest)
  assert.equal(v.ok, false)
  assert.deepEqual(v.affected.sort(), [`${s.project}:ship/${a.run}`, `${s.project}:ship/${b.run}`].sort())
  assert.ok(subs.length)
  await rm(objects, { recursive: true }); await rename(`${objects}.x`, objects)
  // A manifest that does not match is unusable, and restoring from it makes no area.
  await appendFile(join(dir, 'manifest.json'), ' ')
  assert.equal((await verifyGeneration(s.dest)).ok, false)
  const r = await restoreGeneration((await loadBackupConfig(s.area))!, { into: join(root, `rest-bad-${n}`) })
  assert.ok(r.failures.length)
  assert.equal(await isRecoveryArea(r.area), false)
  s.x.close()
})

test('recovery in an isolated area, with the originals gone', async () => {
  const s = await setup()
  const ref = await retired(s, 'r1')
  const before = (await readRun(s.ws, ref)).record!
  await createBackup(s.x, { by: 'tester' })
  const cfg = (await loadBackupConfig(s.area))!
  const into = join(root, `recover-${n}`)
  const r = await restoreGeneration(cfg, { into })
  assert.deepEqual(r.failures, [])
  assert.ok(await isRecoveryArea(r.area))
  for (const absent of ['gitea.json', 'zulip.json', 'present.json', 'attachments.json', 'workers.json']) assert.equal(await stat(join(r.area, absent)).catch(() => null), null, absent)
  s.x.close()
  // Originals out of reach: the retention store, the archive and the whole operating area.
  await rename(s.area, `${s.area}.gone`)
  const lockDir = process.env.WFE_LOCK_DIR, allow = process.env.GIT_ALLOW_PROTOCOL
  try {
    const out = await rehearse({ into, by: 'tester' })
    assert.ok(out.ok, JSON.stringify(out.checks.filter(c => !c.ok), null, 1))
    const names = out.checks.map(c => c.check)
    for (const c of ['record read and replayed', 'reports read', 'receipt replay', 'run number stays taken', 'restoration', 'nothing dispatched', 'damaged archive is refused', 'lost retention repository names its runs']) assert.ok(names.includes(c), c)
    const tree = join(r.area, s.project, '.local/wfe/runs/ship', ref.run, 'tree')
    assert.equal(await readFile(join(tree, 'untracked.txt'), 'utf8'), 'untracked\n')
    assert.equal(await readFile(join(tree, 'note.cache'), 'utf8'), 'ignored\n')
    assert.equal(await readFile(join(tree, 'commit.txt'), 'utf8'), `unpublished ${ref.run}\n`)
    assert.match((await run('git', ['-C', tree, 'status', '--porcelain', 'staged.txt'])).stdout, /^A /)
    assert.ok(((await stat(join(tree, 'run.sh'))).mode & 0o111) !== 0)
    assert.ok(out.checks.some(c => c.check === 'record read and replayed' && c.detail.includes(`sequence ${before.seq}`)))
    // The operating commands refuse the area.
    process.env.WFE_REGISTRY = join(r.area, 'registry.json')
    assert.equal(await main(['exec', 'status', '--registry', join(r.area, 'registry.json')]), 1)
    delete process.env.WFE_REGISTRY
    assert.ok(JSON.parse(await readFile(join(into, 'rehearsal.json'), 'utf8')).ok)
  } finally {
    await rename(`${s.area}.gone`, s.area)
    process.env.WFE_LOCK_DIR = lockDir
    if (allow === undefined) delete process.env.GIT_ALLOW_PROTOCOL; else process.env.GIT_ALLOW_PROTOCOL = allow
    delete process.env.GIT_TERMINAL_PROMPT; delete process.env.GIT_CEILING_DIRECTORIES
  }
})

test('published output bytes and a nested repository\'s unpublished commit recover in isolation', async () => {
  const s = await setup('submodule')
  const ref = (await createRunInCopy(s.ws, { workflow: 'ship', input: { kind: 'braindump', text: 'Go.', author: 'tester' }, executor: { host: 'autolab' }, by: 'tester', via: 'test', receipt: 'r1' } as never)).ref
  await runOp(s.ws, ref, { op: 'node.start', node: 'build' } as never, { by: 'a', via: 'cli' })
  const tree = (await readCopy(s.ws, ref))!.tree
  await mkdir(join(tree, 'out'), { recursive: true })
  await writeFile(join(tree, '.git', 'info', 'exclude'), `${await readFile(join(tree, '.git', 'info', 'exclude'), 'utf8')}out/\n`)
  await writeFile(join(tree, 'out', 'rig.bin'), 'the published bytes\n')
  await publishOutput(s.ws, ref, { node: 'build', source: 'out', title: 'Rig', candidate: 'rig', share: 's' }, { by: 'agent', via: 'cli' })
  await runOp(s.ws, ref, { op: 'node.complete', node: 'build', outcome: 'done' } as never, { by: 'a', via: 'cli' })
  await writeFile(join(tree, 'devdocs', 'nested.txt'), 'nested work\n')
  await gitOk(join(tree, 'devdocs'), ['add', 'nested.txt']); await gitOk(join(tree, 'devdocs'), ['commit', '-q', '-m', 'nested only here'])
  const nested = (await gitOk(join(tree, 'devdocs'), ['rev-parse', 'HEAD'])).trim()
  const res = await retireRun(s.x, s.ws, ref, { by: 'tester' })
  assert.equal(res.outcome, 'retired', res.reasons.join('; '))
  assert.equal(res.archive!.published, 1)
  const b = await createBackup(s.x, { by: 'tester' })
  assert.equal(b.outcome, 'published', b.failures.join('; '))
  const m = (await readManifest(s.dest))!
  assert.deepEqual(m.runs[0].outputs.map(o => o.id), Object.keys((await readRun(s.ws, ref)).record!.outputs ?? {}))
  assert.equal(m.runs[0].repositories.length, 2)
  const r = await restoreGeneration((await loadBackupConfig(s.area))!, { into: join(root, `recover-out-${n}`) })
  assert.deepEqual(r.failures, [])
  s.x.close()
  await rename(s.area, `${s.area}.gone`)
  const liveShare = join(root, `share-${n}`)
  await rename(liveShare, `${liveShare}.gone`)
  const lockDir = process.env.WFE_LOCK_DIR
  try {
    const out = await rehearse({ into: r.into, by: 'tester' })
    assert.ok(out.ok, JSON.stringify(out.checks.filter(c => !c.ok), null, 1))
    assert.ok(out.checks.some(c => c.check === 'output bytes' && c.detail.includes('verified')))
    const back = join(r.area, s.project, '.local/wfe/runs/ship', ref.run, 'tree')
    assert.equal(await readFile(join(back, 'out', 'rig.bin'), 'utf8'), 'the published bytes\n')
    assert.equal((await run('git', ['-C', join(back, 'devdocs'), 'rev-parse', 'HEAD'])).stdout.trim(), nested)
    assert.equal(await readFile(join(back, 'devdocs', 'nested.txt'), 'utf8'), 'nested work\n')
  } finally {
    await rename(`${s.area}.gone`, s.area)
    await rename(`${liveShare}.gone`, liveShare)
    process.env.WFE_LOCK_DIR = lockDir
    delete process.env.GIT_ALLOW_PROTOCOL; delete process.env.GIT_TERMINAL_PROMPT; delete process.env.GIT_CEILING_DIRECTORIES
  }
})

test('reinstating lost pieces: what is intact and newer is not overwritten', async () => {
  const s = await setup()
  const ref = await retired(s, 'r1')
  const g = await createBackup(s.x, { by: 'tester' })
  const cfg = (await loadBackupConfig(s.area))!
  const dir = copyDir(s.ws, ref)
  const key = (await readManifest(s.dest))!.runs[0].repositories[0].key
  const bare = retentionRepo(s.ws, key)
  // A newer record event after the backup, then the retention store and the archive lost.
  await runOp(s.ws, ref, { op: 'artifact.record', path: 'kept.txt', description: 'later' } as never, { by: 'a', via: 'cli' }).catch(() => null)
  const seq = (await readRun(s.ws, ref)).record!.seq
  await rm(bare, { recursive: true })
  await rm(join(dir, 'archive'), { recursive: true })
  const dry = await reinstate(s.x, cfg, { dryRun: true, by: 'tester' })
  assert.ok(dry.items.some(i => i.action === 'would-copy' && i.item.startsWith('retention')))
  assert.equal(await stat(bare).catch(() => null), null, 'a dry run changes nothing')
  assert.equal((await restoreRun(s.x, s.ws, ref, { by: 'tester' })).outcome, 'failed')
  const r = await reinstate(s.x, cfg, { by: 'tester' })
  assert.equal(r.generation, g.id)
  assert.ok(r.items.some(i => i.action === 'copied' && i.item.startsWith('retention')))
  assert.ok(r.items.some(i => i.action === 'copied' && i.item.endsWith('archive')))
  assert.equal((await readRun(s.ws, ref)).record!.seq, seq, 'the newer record stays')
  const again = await restoreRun(s.x, s.ws, ref, { by: 'tester' })
  assert.equal(again.outcome, 'restored', again.reasons.join('; '))
  assert.equal(await readFile(join(dir, 'tree', 'untracked.txt'), 'utf8'), 'untracked\n')
  s.x.close()
})

test('expiry keeps the newest generations and always LATEST', async () => {
  const s = await setup()
  await retired(s, 'r1')
  const ids: string[] = []
  for (let i = 0; i < 3; i++) { const b = await createBackup(s.x, { by: 'tester' }); assert.equal(b.outcome, 'published'); ids.push(b.id!); await new Promise(r => setTimeout(r, 1100)) }
  assert.deepEqual(await s.dest.generations(), ids.slice(-2))
  assert.deepEqual(await expire(s.dest, 1), [ids[1]])
  assert.deepEqual(await s.dest.generations(), [ids[2]])
  await writeFile(join(s.backup, 'LATEST'), `${ids[2]}\n`)
  assert.deepEqual(await expire(s.dest, 1), [])
  s.x.close()
})
