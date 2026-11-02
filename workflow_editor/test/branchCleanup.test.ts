// improve_wfrun p3 step 4: recoverable cleanup of run branches. Eligibility is one
// answer; an advanced branch is never deleted; a partial deletion continues; a deleted
// branch comes back at its object; a run keeps its identity, reads and publication after it.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assess, cleanupContext, deleteSelection, inventory, previewWorkspace, readCleanupRecord, recreateBranches, selectionFrom, type Selection } from '../server/branchCleanup.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { git, gitOk, LOCAL_TRANSPORT } from '../server/git.ts'
import { publishRun } from '../server/publish.ts'
import { loadRegistry } from '../server/registry.ts'
import { restoreRun, retireRun, retentionRepo } from '../server/retention.ts'
import { createBackup, Dest, loadBackupConfig, readManifest } from '../server/runBackup.ts'
import { createRunInCopy, readRun, readRunFile, runOp } from '../server/runs.ts'
import { copyByReceipt, readCopy, reserve, runSpace, updateManifest, usedRuns } from '../server/runspace.ts'
import { setShareArea } from '../server/shares.ts'
import { Workspace } from '../server/workspace.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-branches-'))
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
async function setup() {
  const area = join(root, `area-${++n}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, `pj-p${n}`)
  const r = await createProject({ dir, id: `p${n}`, name: `P${n}`, intent: 'x', goals: [], devdocs: 'submodule', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), WF)
  await writeFile(join(dir, 'kept.txt'), 'tracked\n')
  await gitOk(join(dir, 'devdocs'), ['add', '-A']); await gitOk(join(dir, 'devdocs'), ['commit', '-q', '-m', 'workflow']); await gitOk(join(dir, 'devdocs'), ['push', '-q', 'origin', 'HEAD'])
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remotes', `pj-p${n}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote])
  await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  await writeFile(join(area, 'run-backup.json'), JSON.stringify({ path: join(root, `backup-${n}`) }))
  setShareArea(area)
  const ws = new Workspace((await loadRegistry(registry)).workspaces.find(w => w.id === `p${n}`)!)
  const x = new ExecStore({ registryFile: registry, area })
  const nested = (await gitOk(join(dir, 'devdocs'), ['remote', 'get-url', 'origin'])).trim()
  return { area, dir, remote, ws, x, project: `p${n}`, nested, dest: new Dest((await loadBackupConfig(area))!) }
}
type S = Awaited<ReturnType<typeof setup>>
const make = async (s: S, receipt: string) => (await createRunInCopy(s.ws, { workflow: 'ship', input: { kind: 'braindump', text: 'Go.', author: 'tester' }, executor: { host: 'autolab' }, by: 'tester', via: 'test', receipt } as never)).ref
const wsOf = (s: S) => async () => s.ws
// A finished run with commits on its branch in both repositories, pushed.
async function finished(s: S, receipt: string, o: { cancel?: boolean } = {}) {
  const ref = await make(s, receipt)
  const tree = (await readCopy(s.ws, ref))!.tree
  await runOp(s.ws, ref, { op: 'node.start', node: 'build' } as never, { by: 'a', via: 'cli' })
  await writeFile(join(tree, `work-${ref.run}.txt`), 'root work\n')
  await gitOk(tree, ['add', '-A', '.', ':!devdocs']); await gitOk(tree, ['commit', '-q', '-m', 'root work'])
  await writeFile(join(tree, 'devdocs', `note-${ref.run}.txt`), 'nested work\n')
  await gitOk(join(tree, 'devdocs'), ['add', `note-${ref.run}.txt`]); await gitOk(join(tree, 'devdocs'), ['commit', '-q', '-m', 'nested work'])
  const branch = (await readCopy(s.ws, ref))!.manifest!.branch
  await gitOk(join(tree, 'devdocs'), ['push', '-q', 'origin', `${branch}:${branch}`], { config: LOCAL_TRANSPORT })
  await gitOk(tree, ['push', '-q', 'origin', `${branch}:${branch}`], { config: LOCAL_TRANSPORT })
  if (o.cancel) await runOp(s.ws, ref, { op: 'run.cancel', reason: 'no longer wanted' } as never, { by: 'a', via: 'cli' })
  else await runOp(s.ws, ref, { op: 'node.complete', node: 'build', outcome: 'done' } as never, { by: 'a', via: 'cli' })
  return { ref, branch, name: `refs/heads/${branch}` }
}
async function retiredAndBacked(s: S, receipt: string, o: { cancel?: boolean } = {}) {
  const f = await finished(s, receipt, o)
  const r = await retireRun(s.x, s.ws, f.ref, { by: 'tester' })
  assert.equal(r.outcome, 'retired', r.reasons.join('; '))
  const b = await createBackup(s.x, { by: 'tester' })
  assert.equal(b.outcome, 'published', b.failures.join('; '))
  return f
}
const remoteTip = async (url: string, name: string) => (await gitOk(root, ['ls-remote', url, name], { config: LOCAL_TRANSPORT })).split('\t')[0] || null
const key = (f: { ref: { workflow: string; run: string } }) => `${f.ref.workflow}/${f.ref.run}`

test('eligibility is reported, not guessed: every reason to stay, and only a run branch can go', async () => {
  const s = await setup()
  const live = await finished(s, 'not-retired')
  let c = await cleanupContext(s.x)
  let p = await assess(c, s.ws, live.ref)
  assert.equal(p.eligible, false); assert.match(p.reasons.join(), /is ready, not retired/)
  // Retired with no backup.
  const f = await finished(s, 'r1')
  assert.equal((await retireRun(s.x, s.ws, f.ref, { by: 't' })).outcome, 'retired')
  c = await cleanupContext(s.x)
  p = await assess(c, s.ws, f.ref)
  assert.equal(p.eligible, false); assert.match(p.reasons.join(), /no verified backup/)
  await createBackup(s.x, { by: 't' })
  c = await cleanupContext(s.x)
  p = await assess(c, s.ws, f.ref)
  assert.ok(p.eligible, p.reasons.join('; '))
  assert.deepEqual(p.refs.map(r => [r.path, r.state, r.eligible]).sort(), [['.', 'present', true], ['devdocs', 'present', true]])
  for (const r of p.refs) assert.equal(r.ref, f.name)
  // A worker that has not removed its copy holds it back.
  await updateManifest(s.ws, f.ref, m => { m.lifecycle!.hosts.gpupc = { state: 'remove-pending', at: 'x', generation: m.generation ?? 0 } })
  p = await assess(c, s.ws, f.ref)
  assert.equal(p.eligible, false); assert.match(p.reasons.join(), /worker gpupc is at remove-pending/)
  await updateManifest(s.ws, f.ref, m => { delete m.lifecycle!.hosts.gpupc })
  // A newer generation than the backup holds.
  const back = await restoreRun(s.x, s.ws, f.ref, { by: 't' }); assert.equal(back.outcome, 'restored')
  assert.equal((await retireRun(s.x, s.ws, f.ref, { by: 't' })).outcome, 'retired')
  c = await cleanupContext(s.x)
  p = await assess(c, s.ws, f.ref)
  assert.equal(p.eligible, false); assert.match(p.reasons.join(), /holds its generation/)
  await createBackup(s.x, { by: 't' })
  // A tip no retained ref reaches: pushed after retirement.
  c = await cleanupContext(s.x)
  assert.ok((await assess(c, s.ws, f.ref)).eligible)
  const other = join(root, `elsewhere-${n}`)
  await gitOk(root, ['clone', '-q', '-b', f.branch, s.remote, other], { config: LOCAL_TRANSPORT })
  await writeFile(join(other, 'late.txt'), 'late\n'); await gitOk(other, ['add', '-A']); await gitOk(other, ['commit', '-q', '-m', 'late'])
  await gitOk(other, ['push', '-q', 'origin', f.branch], { config: LOCAL_TRANSPORT })
  c = await cleanupContext(s.x)
  p = await assess(c, s.ws, f.ref)
  assert.equal(p.refs.find(r => r.path === '.')!.eligible, false)
  assert.match(p.refs.find(r => r.path === '.')!.why.join(), /not in retained storage/)
  s.x.close()
})

test('a pinned commit reachable only through the branch keeps it', async () => {
  const s = await setup()
  const f = await finished(s, 'r1')
  const tree = (await readCopy(s.ws, f.ref))!.tree
  const tip = (await gitOk(join(tree, 'devdocs'), ['rev-parse', 'HEAD'])).trim()
  // The project's default branch pins that commit.
  await gitOk(join(s.dir, 'devdocs'), ['fetch', '-q', 'origin', f.branch], { config: LOCAL_TRANSPORT })
  await gitOk(join(s.dir, 'devdocs'), ['checkout', '-q', tip])
  await gitOk(s.dir, ['add', 'devdocs']); await gitOk(s.dir, ['commit', '-q', '-m', 'pin']); await gitOk(s.dir, ['push', '-q', 'origin', 'main'])
  assert.equal((await retireRun(s.x, s.ws, f.ref, { by: 't' })).outcome, 'retired')
  await createBackup(s.x, { by: 't' })
  const c = await cleanupContext(s.x)
  const p = await assess(c, s.ws, f.ref)
  const nested = p.refs.find(r => r.path === 'devdocs')!
  assert.equal(nested.eligible, false); assert.match(nested.why.join(), /pins .* reachable only through/)
  assert.equal(p.refs.find(r => r.path === '.')!.eligible, true, 'the root branch can still go')
  s.x.close()
})

test('inventory finds nested repositories and names what no run here owns', async () => {
  const s = await setup()
  const f = await retiredAndBacked(s, 'r1')
  const stray = `refs/heads/wfe/${s.project}/ship/run-900`
  await gitOk(s.remote, ['update-ref', stray, (await remoteTip(s.remote, f.name))!])
  const c = await cleanupContext(s.x)
  const inv = await inventory(c, s.ws)
  const run = inv.runs.find(r => r.ref === key(f))!
  assert.deepEqual(run.refs.map(r => r.path).sort(), ['.', 'devdocs'])
  assert.deepEqual(inv.unknown.map(u => u.ref), [stray])
  assert.equal(inv.totals.refs, 3)
  s.x.close()
})

test('a deleted branch comes back at its object; deletion and recreation touch nothing else', async () => {
  const s = await setup()
  const a = await retiredAndBacked(s, 'a')
  const b = await retiredAndBacked(s, 'b')
  const c = await cleanupContext(s.x)
  const tipA = await remoteTip(s.remote, a.name), tipB = await remoteTip(s.remote, b.name), tipN = await remoteTip(s.nested, a.name)
  const main = await remoteTip(s.remote, 'refs/heads/main')
  const preview = await previewWorkspace(c, s.ws, [key(a)])
  assert.equal(preview.expected.refs, 2)
  assert.match(preview.limits, /frees no bytes/)
  assert.equal(await remoteTip(s.remote, a.name), tipA, 'a preview changes nothing')
  const selection = selectionFrom(preview.runs)
  const dry = await deleteSelection(c, wsOf(s), selection, { by: 'tester', dryRun: true })
  assert.equal(dry[0].outcome, 'done'); assert.equal(await remoteTip(s.remote, a.name), tipA, 'a dry run changes nothing')
  const r = await deleteSelection(c, wsOf(s), selection, { by: 'tester' })
  assert.equal(r[0].outcome, 'done', JSON.stringify(r[0]))
  assert.equal(await remoteTip(s.remote, a.name), null); assert.equal(await remoteTip(s.nested, a.name), null)
  assert.equal(await remoteTip(s.remote, b.name), tipB, 'another run keeps its branch'); assert.equal(await remoteTip(s.remote, 'refs/heads/main'), main)
  const rec = (await readCleanupRecord(s.ws, a.ref))!
  assert.deepEqual(rec.entries.map(e => [e.path, e.oid, e.state]).sort(), [['.', tipA, 'deleted'], ['devdocs', tipN, 'deleted']].sort())
  // Retention refs untouched: the deleted tip is still fully there.
  const m = (await readManifest(s.dest))!
  for (const p of m.runs.find(x => x.ref === key(a))!.repositories) assert.ok((await git(retentionRepo(s.ws, p.key), ['for-each-ref', `refs/retained/${a.ref.workflow}/${a.ref.run}/`])).stdout.includes(p.head!))
  // Running the same selection again: nothing left to do, no error.
  const again = await deleteSelection(c, wsOf(s), selection, { by: 'tester' })
  assert.ok(again[0].refs.every(v => v.result === 'already-absent'), JSON.stringify(again[0].refs))
  // Dry run of recreation changes nothing; then exact recreation.
  const d = await recreateBranches(c, s.ws, a.ref, { by: 'tester', dryRun: true })
  assert.ok(d.refs.every(v => v.result === 'would-recreate'))
  assert.equal(await remoteTip(s.remote, a.name), null)
  const back = await recreateBranches(c, s.ws, a.ref, { by: 'tester' })
  assert.ok(back.refs.every(v => v.result === 'recreated'), JSON.stringify(back.refs))
  assert.equal(await remoteTip(s.remote, a.name), tipA); assert.equal(await remoteTip(s.nested, a.name), tipN)
  s.x.close()
})

test('a branch that moved is left alone, before and during the deletion', async () => {
  const s = await setup()
  const a = await retiredAndBacked(s, 'a')
  const c = await cleanupContext(s.x)
  const selection = selectionFrom((await previewWorkspace(c, s.ws, [key(a)])).runs)
  const other = join(root, `mover-${n}`)
  await gitOk(root, ['clone', '-q', '-b', a.branch, s.remote, other], { config: LOCAL_TRANSPORT })
  await writeFile(join(other, 'moved.txt'), 'moved\n'); await gitOk(other, ['add', '-A']); await gitOk(other, ['commit', '-q', '-m', 'moved'])
  const moved = (await gitOk(other, ['rev-parse', 'HEAD'])).trim()
  // Between the recheck and the push: the lease refuses.
  const during = await deleteSelection(c, wsOf(s), selection, { by: 'tester', after: async (_s, ref) => { if ((await remoteTip(s.remote, ref)) !== moved) await gitOk(other, ['push', '-q', 'origin', a.branch], { config: LOCAL_TRANSPORT }) } })
  const rootRow = during[0].refs.find(v => v.repository === s.remote)!
  assert.equal(rootRow.result, 'changed', JSON.stringify(during[0].refs))
  assert.equal(await remoteTip(s.remote, a.name), moved)
  assert.ok((await readCleanupRecord(s.ws, a.ref))!.entries.some(e => e.state === 'changed'))
  // A selection older than the remote: recheck sees it.
  const stale = await deleteSelection(c, wsOf(s), selection, { by: 'tester' })
  const row = stale[0].refs.find(v => v.repository === s.remote)!
  assert.ok(row.result === 'not-selected' || row.result === 'changed', row.result)
  assert.equal(await remoteTip(s.remote, a.name), moved)
  assert.equal(stale[0].outcome === 'done', false)
  // Recreation does not overwrite a branch that exists at another object.
  const rec = await recreateBranches(c, s.ws, a.ref, { by: 'tester' })
  assert.ok(rec.refs.every(v => v.repository !== s.remote), 'a changed entry is not a deleted one')
  s.x.close()
})

test('a partial deletion across repositories is journaled and continues', async () => {
  const s = await setup()
  const a = await retiredAndBacked(s, 'a')
  const b = await retiredAndBacked(s, 'b')
  const c = await cleanupContext(s.x)
  const selection: Selection[] = selectionFrom((await previewWorkspace(c, s.ws, [key(a)])).runs)
  const tipB = await remoteTip(s.remote, b.name)
  // The root's remote goes away after the record is written.
  let moved = false
  const r = await deleteSelection(c, wsOf(s), selection, { by: 'tester', after: async (_s, _ref) => { if (selection[0].refs[0].repository === s.remote && !moved) { moved = true; await rename(s.remote, `${s.remote}.away`) } } })
  assert.equal(r[0].outcome, 'partial', JSON.stringify(r[0]))
  assert.ok(r[0].refs.some(v => v.result === 'failed'))
  assert.equal(await remoteTip(s.nested, a.name), null, 'the other repository went ahead')
  const rec = (await readCleanupRecord(s.ws, a.ref))!
  assert.ok(rec.entries.some(e => e.state === 'failed' && e.oid), 'the failure is journaled with its object')
  await rename(`${s.remote}.away`, s.remote)
  assert.ok(await remoteTip(s.remote, a.name), 'nothing was deleted there')
  const again = await deleteSelection(await cleanupContext(s.x), wsOf(s), selection, { by: 'tester' })
  assert.equal(again[0].outcome, 'done', JSON.stringify(again[0]))
  assert.equal(await remoteTip(s.remote, a.name), null)
  assert.equal(await remoteTip(s.remote, b.name), tipB)
  assert.deepEqual((await readCleanupRecord(s.ws, a.ref))!.entries.map(e => e.state), ['deleted', 'deleted'])
  s.x.close()
})

test('after deletion: identity, reads, receipts, numbering, restoration and a new publication', async () => {
  const s = await setup()
  const a = await retiredAndBacked(s, 'a-receipt')
  const c = await cleanupContext(s.x)
  const tip = await remoteTip(s.remote, a.name)
  const before = (await readRun(s.ws, a.ref)).record!
  await deleteSelection(c, wsOf(s), selectionFrom((await previewWorkspace(c, s.ws, [key(a)])).runs), { by: 'tester' })
  assert.equal(await remoteTip(s.remote, a.name), null)
  // Reads, with nothing from the branch.
  const space = await runSpace(s.ws, a.ref)
  assert.equal((await readRun(s.ws, a.ref)).record!.seq, before.seq)
  assert.ok((await readRunFile(space, a.ref, 'input.md').catch(() => ({ text: '' }))) !== null)
  // Receipt and numbering, with the branch and its local copy-of-remote ref gone.
  const replay = await reserve(s.ws, { project: s.project, workflow: 'ship', receipt: 'a-receipt' })
  assert.equal(replay.existing, true); assert.deepEqual(replay.ref, a.ref)
  assert.equal((await copyByReceipt(s.ws, 'a-receipt'))?.ref.run, a.ref.run)
  assert.ok((await usedRuns(s.ws, s.project, 'ship')).has(a.ref.run))
  const next = await reserve(s.ws, { project: s.project, workflow: 'ship', receipt: 'next' })
  assert.notEqual(next.ref.run, a.ref.run, 'a retired run without a branch keeps its number')
  // Restoration has its saved commit, and a publication makes the branch again.
  const back = await restoreRun(s.x, s.ws, a.ref, { by: 'tester' })
  assert.equal(back.outcome, 'restored', back.reasons.join('; '))
  const tree = (await readCopy(s.ws, a.ref))!.tree
  assert.equal((await gitOk(tree, ['rev-parse', 'HEAD'])).trim(), tip)
  assert.equal(await readFile(join(tree, `work-${a.ref.run}.txt`), 'utf8'), 'root work\n')
  await writeFile(join(tree, 'correction.txt'), 'corrected\n')
  const pub = await publishRun(await runSpace(s.ws, a.ref), 'correction', [], {}, { '.': a.branch, devdocs: a.branch }, f => f())
  assert.ok(pub.state === 'published', JSON.stringify(pub))
  const now = await remoteTip(s.remote, a.name)
  assert.ok(now && now !== tip, 'the branch is on the remote again, advanced')
  assert.equal((await git(tree, ['merge-base', '--is-ancestor', tip!, now!])).code, 0)
  assert.equal((await readRun(s.ws, a.ref)).record!.seq, before.seq)
  s.x.close()
})

test('a cancelled, unintegrated run: its work survives deletion, and the record is in the next backup', async () => {
  const s = await setup()
  const a = await retiredAndBacked(s, 'a', { cancel: true })
  assert.equal((await readRun(s.ws, a.ref)).record!.cancelled !== undefined, true)
  const c = await cleanupContext(s.x)
  const tip = (await remoteTip(s.remote, a.name))!
  const main = (await remoteTip(s.remote, 'refs/heads/main'))!
  const reachable = await git(s.dir, ['merge-base', '--is-ancestor', tip, main], { config: LOCAL_TRANSPORT })
  assert.notEqual(reachable.code, 0, 'not on main')
  const r = await deleteSelection(c, wsOf(s), selectionFrom((await previewWorkspace(c, s.ws, [key(a)])).runs), { by: 'tester' })
  assert.equal(r[0].outcome, 'done', JSON.stringify(r[0]))
  const b = await createBackup(s.x, { by: 'tester' })
  assert.equal(b.outcome, 'published')
  const inBackup = JSON.parse(await readFile(join(s.dest.c.path, 'generations', b.id!, 'runs', s.project, 'ship', a.ref.run, 'branch-cleanup.json'), 'utf8'))
  assert.deepEqual(inBackup.entries.map((e: { oid: string }) => e.oid).includes(tip), true)
  const bk = await recreateBranches(c, s.ws, a.ref, { by: 'tester' })
  assert.ok(bk.refs.every(v => v.result === 'recreated'))
  assert.equal(await remoteTip(s.remote, a.name), tip)
  s.x.close()
})
