// p9 step 4: integration of accepted results, separate from saving. Every
// case converges without losing work or publishing unaccepted changes:
// unchanged target (fast-forward), advanced target (combined), conflict,
// a combination that would change reviewed files, a result changed after
// its acceptance, a shared submodule whose target moved, a remote that
// rejects the push (partial, then retried), and a crash after the push.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { git, gitOk, LOCAL_TRANSPORT } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runOp } from '../server/runs.ts'
import { Workspace } from '../server/workspace.ts'
import type { OpInput, RunRef } from '../shared/run.ts'
import { integrationStatus } from '../src/integrationState.ts'
import type { RunExecView } from '../src/api.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-integration-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = (confirm = false) => `schema: ag.workflow.v2
documentation: {policy: manual}
id: ship
name: Ship
intent: |
  Build it${confirm ? ' and confirm it with the person' : ''}.
repositories:
  root: {path: ., access: editable}
  study: {path: study/study-x, access: editable}
nodes:
  build:
    type: do
    description: Build.
${confirm ? `  confirm:
    type: talk
    confirms: result
    description: Present the result.
edges:
  - {from: build, to: confirm}
` : 'edges: []\n'}`

let n = 0
async function setup(o: { mode?: 'directory' | 'submodule'; confirm?: boolean } = {}) {
  const area = join(root, `area-${++n}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, `pj-p${n}`)
  const id = `p${n}`
  const r = await createProject({ dir, id, name: `P${n}`, intent: 'x', goals: [], devdocs: o.mode ?? 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  // A study repository the project binds (shared by projects in real use).
  const studySrc = join(area, 'study-src')
  await gitOk(area, ['init', '-q', studySrc])
  await writeFile(join(studySrc, 'notes.md'), 'line 1\nline 2\nline 3\nline 4\nline 5\n')
  await gitOk(studySrc, ['add', '-A']); await gitOk(studySrc, ['commit', '-q', '-m', 'study'])
  const study = join(area, 'remotes', 'study-x.git')
  await gitOk(area, ['clone', '-q', '--bare', studySrc, study])
  await gitOk(dir, ['submodule', 'add', '-q', study, 'study/study-x'], { config: LOCAL_TRANSPORT })
  await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), WF(o.confirm))
  await writeFile(join(dir, 'app.txt'), 'a\nb\nc\nd\ne\n')
  if (o.mode === 'submodule') { await gitOk(join(dir, 'devdocs'), ['add', '-A']); await gitOk(join(dir, 'devdocs'), ['commit', '-q', '-m', 'workflow']); await gitOk(join(dir, 'devdocs'), ['push', '-q', 'origin', 'HEAD:main']) }
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remotes', `pj-p${n}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote]); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  return { area, registry, dir, remote, study, ws, id, x: new ExecStore({ registryFile: registry, area }) }
}
type S = Awaited<ReturnType<typeof setup>>
const report = (s: S, ref: RunRef, attempt: string, op: OpInput) => runOp(s.ws, ref, { ...op, attempt }, { by: 'autolab', via: 'cli' })
const record = async (s: S, ref: RunRef) => (await readRun(s.ws, ref)).record!
const head = (repo: string, ref = 'main') => gitOk(repo, ['rev-parse', ref]).then(x => x.trim())
const show = (repo: string, what: string) => gitOk(repo, ['show', what])

// A run that changes `files` (path → text) in its copy and completes.
async function completed(s: S, receipt: string, files: Record<string, string>) {
  const { ref } = await s.x.request({ workspace: s.id, workflow: 'ship', text: 'Build it.', author: 'Test Person', receipt, via: 'browser' })
  const c = await s.x.claim('t')
  assert.ok('attempt' in c, JSON.stringify(c))
  s.x.started(c.attempt.id, process.pid)
  await report(s, ref, c.attempt.id, { op: 'node.start', node: 'build' })
  for (const [p, t] of Object.entries(files)) await writeFile(join(c.cwd, p), t)
  await report(s, ref, c.attempt.id, { op: 'node.complete', node: 'build', outcome: 'built' })
  const f = await s.x.finished(c.attempt.id, { code: 0, signal: null })
  assert.equal(f.checkpoint?.state, 'published', JSON.stringify(f.checkpoint))
  return { ref, cwd: c.cwd }
}
// The person accepts in the browser: the decision and its checkpoint; the integration is queued.
async function accept(s: S, ref: RunRef) {
  await runOp(s.ws, ref, { op: 'run.decide', decision: 'accepted', evidence: 'looked at it' }, { by: 'Test Person', via: 'browser' })
  await s.x.afterDecision(s.ws, ref, 'accepted')
}
// Someone else moves a shared branch meanwhile (another clone).
async function elsewhere(s: S, remote: string, files: Record<string, string>, message = 'elsewhere') {
  const other = join(s.area, `other-${Math.random().toString(36).slice(2, 8)}`)
  await gitOk(s.area, ['clone', '-q', remote, other])
  for (const [p, t] of Object.entries(files)) await writeFile(join(other, p), t)
  await gitOk(other, ['add', '-A']); await gitOk(other, ['commit', '-q', '-m', message]); await gitOk(other, ['push', '-q', 'origin', 'HEAD:main'])
}

test('unchanged target: the acceptance queues the integration; the execution host fast-forwards main; the record says so; a completed run without acceptance stays unintegrated', async () => {
  const s = await setup()
  const a = await completed(s, 'int-ff-0001', { 'app.txt': 'a\nb\nC\nd\ne\n' })
  const b = await completed(s, 'int-ff-0002', { 'other.txt': 'never accepted\n' })
  const before = await head(s.remote)
  // What the person is told, at each stage (Simple and Detail say the same).
  const status = async (ref: RunRef) => integrationStatus(await record(s, ref), await s.x.runView(s.id, ref) as unknown as RunExecView, { kind: 'run-copy', branch: null })?.text
  assert.equal(await status(a.ref), 'Saved on its branch — not integrated (no accepted result)')
  await accept(s, a.ref)
  assert.equal(await status(a.ref), 'Accepted — integration queued')
  assert.deepEqual(s.x.integrations(s.id, a.ref).map(i => i.state), ['queued'], 'queued by the acceptance')
  assert.equal(await head(s.remote), before, 'saving and accepting change no shared branch')
  const notes = await s.x.reconcile()
  assert.match(notes.join('\n'), /integration 1 \(ship\/run-001\): integrated/)
  const rec = await record(s, a.ref)
  const it = rec.integrations![0]
  assert.deepEqual(it.repositories.map(x => [x.path, x.method]), [['study/study-x', 'already'], ['.', 'fast-forward']], 'the study, which the run did not change, is left as its target has it')
  const r0 = it.repositories[1]
  assert.deepEqual([r0.path, r0.target, r0.method, r0.observed], ['.', 'main', 'fast-forward', before])
  assert.equal(await head(s.remote), r0.result)
  assert.equal(await show(s.remote, 'main:app.txt'), 'a\nb\nC\nd\ne\n')
  assert.match(await show(s.remote, 'main:devdocs/runs/ship/run-001/run.json'), /"decision": "accepted"/, 'the run\'s folder reaches main as a snapshot')
  assert.notEqual((await git(s.remote, ['cat-file', '-e', 'main:other.txt'])).code, 0, 'the unaccepted run is not integrated')
  assert.deepEqual(s.x.integrations(s.id, b.ref), [])
  assert.equal(await status(a.ref), 'Integrated into main')
  // The CLI's own forms (p9 deployment: --status was parsed as an option needing a value).
  const { main } = await import('../cli/wfe.ts')
  const out: string[] = []
  const log = console.log
  console.log = (...m: unknown[]) => { out.push(m.join(' ')) }
  try {
    assert.equal(await main(['run', 'integrate', 'ship/run-001', '--status', '--workspace', s.id, '--registry', s.registry, '--area', s.area]), 0)
    assert.equal(await main(['runs', 'index', '--rebuild', '--workspace', s.id, '--registry', s.registry, '--area', s.area]), 0)
  } finally { console.log = log }
  assert.match(out.join('\n'), /Integration 1 of decision 0: integrated[\s\S]*root\s+→ main\s+done \(fast-forward\)/)
  assert.match(out.join('\n'), /ship\/run-001\s+ready/)
  assert.equal(await status(b.ref), 'Saved on its branch — not integrated (no accepted result)')
  await assert.rejects(s.x.integrateRun(s.ws, b.ref, { by: 'Test Person', via: 'cli' }), /no accepted result.*stays saved on its branch, unintegrated/)
  // The live record stays in the copy and goes on: the snapshot on main is not it.
  assert.ok((await record(s, a.ref)).history.at(-1)!.op === 'run.integrate')
  await assert.rejects(s.x.integrateRun(s.ws, a.ref, { by: 'Test Person', via: 'cli' }), /already integrated/)
})

test('advanced target: combined in an integration worktree, checked, and pushed without force; a submodule first, the root records its integrated commit', async () => {
  const s = await setup()
  const a = await completed(s, 'int-adv-0001', { 'app.txt': 'a\nb\nC\nd\ne\n', 'study/study-x/notes.md': 'line 1\nline 2 by the run\nline 3\nline 4\nline 5\n' })
  // Meanwhile: the project's main gains an unrelated file; the shared
  // study's main gains another project's file.
  await elsewhere(s, s.remote, { 'NEWS.md': 'news\n' })
  await elsewhere(s, s.study, { 'other-project.md': 'from another project\n' })
  await accept(s, a.ref)
  const plan = await s.x.integrateRun(s.ws, a.ref, { by: 'Test Person', via: 'cli', dryRun: true })
  assert.deepEqual(plan.steps.map(x => [x.repo, x.state, x.method]), [['study/study-x', 'planned', 'merge'], ['.', 'planned', 'merge']])
  assert.deepEqual(s.x.integrations(s.id, a.ref).map(i => i.state), ['queued'], 'a dry run records nothing')
  const r = await s.x.integrateRun(s.ws, a.ref, { by: 'Test Person', via: 'browser' })
  assert.equal(r.state, 'integrated', r.error)
  assert.equal(await show(s.study, 'main:notes.md'), 'line 1\nline 2 by the run\nline 3\nline 4\nline 5\n', 'the run\'s change in the shared study')
  assert.equal(await show(s.study, 'main:other-project.md'), 'from another project\n', 'beside the other project\'s')
  const studyMain = await head(s.study)
  assert.match(await gitOk(s.remote, ['ls-tree', 'main', '--', 'study/study-x']), new RegExp(`160000 commit ${studyMain}`), 'the root records the study\'s integrated commit')
  assert.equal(await show(s.remote, 'main:NEWS.md'), 'news\n')
  assert.equal(await show(s.remote, 'main:app.txt'), 'a\nb\nC\nd\ne\n')
  const rec = await record(s, a.ref)
  assert.deepEqual(rec.integrations![0].repositories.map(x => [x.path, x.method]), [['study/study-x', 'merge'], ['.', 'merge']])
  assert.equal((await gitOk(s.remote, ['rev-list', '--count', `${rec.integrations![0].repositories[1].observed}..main`])).trim() !== '0', true)
})

test('conflict and changed reviewed files stop before anything is pushed; the work stays saved on the run branch', async () => {
  const s = await setup()
  const a = await completed(s, 'int-conf-0001', { 'app.txt': 'a\nb\nRUN\nd\ne\n' })
  await elsewhere(s, s.remote, { 'app.txt': 'a\nb\nOTHER\nd\ne\n' })
  await accept(s, a.ref)
  const main = await head(s.remote)
  const r = await s.x.integrateRun(s.ws, a.ref, { by: 'Test Person', via: 'cli' })
  assert.equal(r.state, 'conflict')
  assert.deepEqual(r.steps.find(x => x.repo === '.')!.files, ['app.txt'])
  assert.match(r.error ?? '', /conflicts in app\.txt: the repair is agent work/)
  assert.equal(await head(s.remote), main, 'nothing pushed')
  assert.equal(await show(s.remote, `wfe/${s.id}/ship/run-001:app.txt`), 'a\nb\nRUN\nd\ne\n', 'the run\'s work is kept on its branch')
  assert.equal((await record(s, a.ref)).integrations, undefined)
  // A clean merge that would still change a file the run changed is not the accepted result.
  const s2 = await setup()
  const b = await completed(s2, 'int-agree-0001', { 'app.txt': 'A\nb\nc\nd\ne\n' })
  await elsewhere(s2, s2.remote, { 'app.txt': 'a\nb\nc\nd\nE\n' })
  await accept(s2, b.ref)
  const main2 = await head(s2.remote)
  const r2 = await s2.x.integrateRun(s2.ws, b.ref, { by: 'Test Person', via: 'cli' })
  assert.equal(r2.state, 'needs-agreement')
  assert.match(r2.error ?? '', /changed files this run changed too \(app\.txt\).*presented for agreement first/)
  assert.equal(await head(s2.remote), main2)
})

test('the acceptance binds to the reviewed revision: a deliverable changed after it is refused; administrative records may change', async () => {
  const s = await setup({ confirm: true })
  const { ref } = await s.x.request({ workspace: s.id, workflow: 'ship', text: 'Build it.', author: 'Test Person', receipt: 'int-bind-0001', via: 'browser' })
  const c = await s.x.claim('t')
  assert.ok('attempt' in c)
  s.x.started(c.attempt.id, process.pid)
  const A = c.attempt.id
  await report(s, ref, A, { op: 'node.start', node: 'build' })
  await writeFile(join(c.cwd, 'app.txt'), 'reviewed\n')
  await report(s, ref, A, { op: 'node.complete', node: 'build', outcome: 'built' })
  await report(s, ref, A, { op: 'node.start', node: 'confirm' })
  await report(s, ref, A, { op: 'question.ask', question: '', node: 'confirm', text: 'Is app.txt right?', to: 'Test Person', subjects: ['app.txt'] })
  await runOp(s.ws, ref, { op: 'question.answer', question: 'q1', text: 'Yes.' }, { by: 'Test Person', via: 'browser' })
  await report(s, ref, A, { op: 'question.take-up', question: 'q1' })
  await runOp(s.ws, ref, { op: 'run.decide', decision: 'accepted', question: 'q1', attempt: A }, { by: 'autolab', via: 'cli' })
  const d = (await record(s, ref)).decisions[0]
  assert.equal(d.revision?.length, 2, 'the root and the study, by tree')
  // The final attempt goes on editing after the acceptance.
  await writeFile(join(c.cwd, 'app.txt'), 'edited after acceptance\n')
  await report(s, ref, A, { op: 'node.complete', node: 'confirm', outcome: 'confirmed' })
  await s.x.finished(A, { code: 0, signal: null })
  assert.equal((await record(s, ref)).execution.state, 'completed')
  assert.deepEqual(s.x.integrations(s.id, ref).map(i => i.state), ['queued'], 'queued once the run completed')
  const main = await head(s.remote)
  await s.x.integrateDue()
  const row = s.x.integrations(s.id, ref)[0]
  assert.equal(row.state, 'needs-agreement')
  assert.match(row.error ?? '', /the result changed after it was accepted: app\.txt/)
  assert.equal(await head(s.remote), main, 'later edits are not published to the shared branch')
})

test('a remote that rejects the push: partial (the study done, the root not), then a retry finishes; a crash after the push is found, not pushed twice', async () => {
  const s = await setup()
  const a = await completed(s, 'int-rej-0001', { 'app.txt': 'a\nb\nC\nd\ne\n', 'study/study-x/notes.md': 'line 1 by the run\nline 2\nline 3\nline 4\nline 5\n' })
  await accept(s, a.ref)
  const hook = join(s.remote, 'hooks', 'pre-receive')
  await writeFile(hook, '#!/bin/sh\necho "main is protected right now" >&2\nexit 1\n')
  await chmod(hook, 0o755)
  const r = await s.x.integrateRun(s.ws, a.ref, { by: 'Test Person', via: 'cli' })
  assert.equal(r.state, 'partial')
  assert.deepEqual(r.steps.map(x => [x.repo, x.state]), [['study/study-x', 'done'], ['.', 'attention']])
  assert.match(r.steps[1].error ?? '', /pushing main failed|moved while integrating/)
  const studyDone = r.steps[0].result!
  const st = integrationStatus((await readRun(s.ws, a.ref)).record!, await s.x.runView(s.id, a.ref) as unknown as RunExecView, { kind: 'run-copy', branch: null })
  assert.deepEqual([st?.text, st?.tone], ['Partially integrated (study/study-x done)', 'error'], 'partial progress is said as such')
  assert.equal(await head(s.study), studyDone, 'the child repository is published before the parent records it')
  await rm(hook)
  const again = await s.x.integrateRun(s.ws, a.ref, { by: 'Test Person', via: 'cli' })
  assert.equal(again.state, 'integrated', again.error)
  assert.equal(again.steps[0].result, studyDone, 'the study is not integrated twice')
  assert.match(await gitOk(s.remote, ['ls-tree', 'main', '--', 'study/study-x']), new RegExp(studyDone))
  // A crash after the push, before the journal said so.
  const s2 = await setup()
  const b = await completed(s2, 'int-crash-0001', { 'app.txt': 'crash\n' })
  await accept(s2, b.ref)
  const row = s2.x.integrations(s2.id, b.ref)[0]
  const candidate = await head(s2.remote, `wfe/${s2.id}/ship/run-001`)
  const observed = await head(s2.remote)
  await gitOk(join(s2.area, '..'), ['--git-dir', s2.remote, 'update-ref', 'refs/heads/main', candidate, observed]) // the push happened
  s2.x.db.prepare('UPDATE integrations SET state = \'running\', steps = ? WHERE id = ?').run(JSON.stringify([{ repo: '.', target: 'main', branch: `wfe/${s2.id}/ship/run-001`, observed, candidate, method: 'fast-forward', result: candidate, pushed: false, state: 'pending' }]), row.id)
  const healed = await s2.x.integrateRun(s2.ws, b.ref, { by: 'Test Person', via: 'cli' })
  assert.equal(healed.state, 'integrated', healed.error)
  assert.equal(await head(s2.remote), candidate, 'found on the target, not pushed again')
  const rootStep = healed.steps.find(x => x.repo === '.')!
  assert.deepEqual([rootStep.pushed, rootStep.observed, rootStep.result], [true, observed, candidate], 'the journal keeps the target it integrated onto')
  void readFile
})
