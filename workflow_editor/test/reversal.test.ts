// p9 step 5: abandonment and reversal without erasing evidence. Cancelling
// keeps a run's work; unintegrated work needs no shared rollback; an
// integrated result is reversed as new work by a linked run, following the
// facts `wfe run reversal` gives: new commits, later changes kept, the run's
// records kept, a submodule reverted in its own repository and the root
// recording that commit.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { git, gitOk, LOCAL_TRANSPORT } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { reversalFacts } from '../server/reversal.ts'
import { readRun, runOp } from '../server/runs.ts'
import { Workspace } from '../server/workspace.ts'
import type { OpInput, RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-reversal-'))
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
  study: {path: study/study-x, access: editable}
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
  const dir = join(area, 'pj-demo')
  const r = await createProject({ dir, id: 'demo', name: 'Demo', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  const studySrc = join(area, 'study-src')
  await gitOk(area, ['init', '-q', studySrc])
  await writeFile(join(studySrc, 'notes.md'), 'study as it was\n')
  await gitOk(studySrc, ['add', '-A']); await gitOk(studySrc, ['commit', '-q', '-m', 'study'])
  const study = join(area, 'remotes', 'study-x.git')
  await gitOk(area, ['clone', '-q', '--bare', studySrc, study])
  await gitOk(dir, ['submodule', 'add', '-q', study, 'study/study-x'], { config: LOCAL_TRANSPORT })
  await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), WF)
  await writeFile(join(dir, 'app.txt'), 'original\n')
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remotes', 'pj-demo.git')
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote]); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  return { area, registry, dir, remote, study, ws, x: new ExecStore({ registryFile: registry, area }) }
}
type S = Awaited<ReturnType<typeof setup>>
const report = (s: S, ref: RunRef, attempt: string, op: OpInput) => runOp(s.ws, ref, { ...op, attempt }, { by: 'autolab', via: 'cli' })
const show = (repo: string, what: string) => gitOk(repo, ['show', what])
const exists = (p: string) => stat(p).then(() => true, () => false)

// One run: `work` acts in its copy (cwd); then it completes.
async function perform(s: S, receipt: string, work: (cwd: string, brief: string) => Promise<void>, predecessor?: RunRef) {
  const { ref } = await s.x.request({ workspace: 'demo', workflow: 'ship', text: 'Do it.', author: 'Test Person', receipt, via: 'browser', predecessor })
  const c = await s.x.claim('t')
  assert.ok('attempt' in c, JSON.stringify(c))
  s.x.started(c.attempt.id, process.pid)
  await report(s, ref, c.attempt.id, { op: 'node.start', node: 'build' })
  await work(c.cwd, c.brief)
  await report(s, ref, c.attempt.id, { op: 'node.complete', node: 'build', outcome: 'done' })
  const f = await s.x.finished(c.attempt.id, { code: 0, signal: null })
  assert.equal(f.checkpoint?.state, 'published')
  return { ref, cwd: c.cwd }
}
async function acceptAndIntegrate(s: S, ref: RunRef) {
  await runOp(s.ws, ref, { op: 'run.decide', decision: 'accepted', evidence: 'ok' }, { by: 'Test Person', via: 'browser' })
  await s.x.afterDecision(s.ws, ref, 'accepted')
  const r = await s.x.integrateRun(s.ws, ref, { by: 'Test Person', via: 'cli' })
  assert.equal(r.state, 'integrated', r.error)
}

test('cancelling keeps the work; unintegrated work needs no rollback; the facts name the saved branch', async () => {
  const s = await setup()
  const main = (await gitOk(s.remote, ['rev-parse', 'main'])).trim()
  const a = await perform(s, 'rev-cancel-0001', async cwd => { await writeFile(join(cwd, 'app.txt'), 'abandoned work\n') })
  // The run is held, then cancelled (it is completed here; cancel a fresh held one instead).
  const b = await (async () => {
    const { ref } = await s.x.request({ workspace: 'demo', workflow: 'ship', text: 'Another.', author: 'Test Person', receipt: 'rev-cancel-0002', via: 'browser' })
    const c = await s.x.claim('t'); assert.ok('attempt' in c); s.x.started(c.attempt.id, process.pid)
    await report(s, ref, c.attempt.id, { op: 'node.start', node: 'build' })
    await writeFile(join(c.cwd, 'half.txt'), 'half done\n')
    await s.x.stop(s.ws, ref, 'Test Person', 'not now', 'browser')
    await s.x.finished(c.attempt.id, { code: null, signal: 'SIGTERM' })
    await s.x.cancel(s.ws, ref, 'Test Person', 'no longer wanted', 'browser')
    return { ref, cwd: c.cwd }
  })()
  const f = await reversalFacts(s.ws, b.ref)
  assert.equal(f.state, 'not-integrated')
  assert.match(f.summary, /Nothing of run ship\/run-002 is on the project's shared branches: its work is saved on its own branch wfe\/demo\/ship\/run-002 and in its copy/)
  assert.match(f.summary, /cancelling keeps it \(nothing is deleted\)/)
  assert.equal(await readFile(join(b.cwd, 'half.txt'), 'utf8'), 'half done\n', 'the cancelled run\'s copy is kept')
  assert.equal(await show(s.remote, 'wfe/demo/ship/run-002:half.txt'), 'half done\n', 'and its saved branch')
  assert.equal((await gitOk(s.remote, ['rev-parse', 'main'])).trim(), main, 'nothing to roll back on the shared branch')
  assert.equal((await reversalFacts(s.ws, a.ref)).state, 'not-integrated')
  assert.ok(f.external.some(x => /not undone by reverting commits/.test(x)), 'effects outside Git are named, never claimed undone')
})

test('an integrated result is reversed as new work: a linked run reverts exactly what the integration brought, keeping later changes, the records and the submodule\'s own history', async () => {
  const s = await setup()
  const a = await perform(s, 'rev-int-0001', async cwd => {
    await writeFile(join(cwd, 'app.txt'), 'changed by run 1\n')
    await writeFile(join(cwd, 'study/study-x/notes.md'), 'study changed by run 1\n')
  })
  await acceptAndIntegrate(s, a.ref)
  // Later work lands on main from elsewhere; it must survive the reversal.
  const other = join(s.area, 'other')
  await gitOk(s.area, ['clone', '-q', s.remote, other])
  await writeFile(join(other, 'NEWS.md'), 'later work\n')
  await gitOk(other, ['add', 'NEWS.md']); await gitOk(other, ['commit', '-q', '-m', 'later']); await gitOk(other, ['push', '-q', 'origin', 'main'])
  await gitOk(a.cwd, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
  const f = await reversalFacts(s.ws, a.ref)
  assert.equal(f.state, 'integrated')
  const [studyRev, rootRev] = f.integrations[0].repositories
  assert.deepEqual([studyRev.path, studyRev.submodule, rootRev.path, rootRev.later], ['study/study-x', true, '.', 1])
  assert.deepEqual(studyRev.files, ['notes.md'])
  assert.ok(rootRev.files.includes('app.txt') && rootRev.files.includes('study/study-x') && rootRev.files.some(x => x.startsWith('devdocs/runs/ship/run-001/')))
  assert.ok(f.steps.some(x => /study\/study-x is a repository of its own, possibly shared with other projects: its revert is a commit on its main; the root then records that new commit\. Setting the root's gitlink back to .* alone would not undo/.test(x)))
  const rootStep = f.steps.find(x => x.startsWith('the project root'))!
  assert.match(rootStep, new RegExp(`git revert --no-commit ${rootRev.before}\\.\\.${rootRev.after}, then git checkout HEAD -- devdocs/runs/ship/run-001`))
  // The reversal run, linked to the first, does what the facts say.
  const b = await perform(s, 'rev-int-0002', async (cwd, brief) => {
    assert.match(brief, /This run follows ship\/run-001: its records are in .* its work saved on branch wfe\/demo\/ship\/run-001; its result is integrated \(wfe run reversal ship\/run-001\)/)
    assert.equal(await readFile(join(cwd, 'app.txt'), 'utf8'), 'changed by run 1\n', 'the new copy starts from the integrated project (the upstream, not the stale workspace)')
    const sub = join(cwd, 'study/study-x')
    await gitOk(sub, ['revert', '--no-commit', `${studyRev.before}..${studyRev.after}`])
    await gitOk(sub, ['commit', '-q', '-m', 'Revert ship/run-001 in the study'])
    await gitOk(cwd, ['revert', '--no-commit', `${rootRev.before}..${rootRev.after}`])
    await gitOk(cwd, ['checkout', 'HEAD', '--', 'devdocs/runs/ship/run-001'])
    await gitOk(cwd, ['add', 'study/study-x'])
    await gitOk(cwd, ['commit', '-q', '-m', 'Revert ship/run-001'])
  }, a.ref)
  assert.deepEqual((await readRun(s.ws, b.ref)).record!.predecessor, a.ref)
  await acceptAndIntegrate(s, b.ref)
  assert.equal(await show(s.remote, 'main:app.txt'), 'original\n', 'the integrated change is reverted')
  assert.equal(await show(s.remote, 'main:NEWS.md'), 'later work\n', 'later changes stay')
  assert.match(await show(s.remote, 'main:devdocs/runs/ship/run-001/run.json'), /"decision": "accepted"/, 'the reverted run\'s records stay as evidence (the snapshot integrated with it)')
  assert.match(JSON.stringify((await readRun(s.ws, a.ref)).record!.integrations), /"method":"fast-forward"/, 'and its live record says what was integrated')
  assert.equal(await show(s.study, 'main:notes.md'), 'study as it was\n', 'the study is reverted in its own repository')
  const studyMain = (await gitOk(s.study, ['rev-parse', 'main'])).trim()
  assert.match(await gitOk(s.remote, ['ls-tree', 'main', '--', 'study/study-x']), new RegExp(studyMain), 'the root records the study\'s new commit')
  const log = await gitOk(s.remote, ['log', '--format=%s', 'main'])
  assert.match(log, /Revert ship\/run-001[\s\S]*later[\s\S]*ship\/run-001: after attempt/, 'history keeps the original and adds the reversal')
  assert.equal(await exists(join(a.cwd, 'app.txt')), true, 'the first run\'s copy is untouched')
  void git
})
