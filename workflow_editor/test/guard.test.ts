// project_migration p4: a binding declared `integrate: if-unchanged`. A
// supplementation prepared against one revision of a knowledge target is not
// published over a target that changed under it meanwhile — a new file, an
// ownership change, a line nowhere near the run's — even when Git would merge
// it cleanly. A change elsewhere in the repository still merges, and a run
// that brought the current target into its branch passes.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { semanticDigest } from '../shared/canonical.ts'
import { validateWorkflow } from '../shared/validate.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { git, gitOk, LOCAL_TRANSPORT } from '../server/git.ts'
import { guardsFor } from '../server/integrate.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runOp } from '../server/runs.ts'
import { Workspace } from '../server/workspace.ts'
import { parseWorkflow } from '../server/yamlDoc.ts'
import type { OpInput, RunRef } from '../shared/run.ts'
import { integrationStatus } from '../src/integrationState.ts'
import type { RunExecView } from '../src/api.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-guard-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = `schema: ag.workflow.v2
documentation: {policy: manual}
id: backfill
name: Backfill
intent: |
  Supplement the knowledge.
repositories:
  root: {path: ., access: readonly}
  wedo: {path: wedo/local, access: editable, integrate: if-unchanged}
  shared: {path: wedo/wedo-x, access: editable, integrate: if-unchanged}
nodes:
  write:
    type: do
    description: Write.
edges: []
`

let n = 0
async function setup() {
  const area = join(root, `area-${++n}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, `pj-g${n}`)
  const id = `g${n}`
  const r = await createProject({ dir, id, name: `G${n}`, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  const src = join(area, 'wedo-src')
  await gitOk(area, ['init', '-q', src])
  await writeFile(join(src, 'knowledge.yaml'), 'maintenance: supplemented\n')
  await writeFile(join(src, 'cases.md'), 'case 1\n')
  await gitOk(src, ['add', '-A']); await gitOk(src, ['commit', '-q', '-m', 'wedo'])
  const shared = join(area, 'remotes', 'wedo-x.git')
  await gitOk(area, ['clone', '-q', '--bare', src, shared])
  await gitOk(dir, ['submodule', 'add', '-q', shared, 'wedo/wedo-x'], { config: LOCAL_TRANSPORT })
  // A root-local area beside the shared repository.
  await writeFile(join(dir, 'project.yaml'), `${await readFile(join(dir, 'project.yaml'), 'utf8')}areas:\n  wedo/local: {description: Procedures kept in the root}\n`)
  await mkdir(join(dir, 'wedo', 'local'), { recursive: true })
  await writeFile(join(dir, 'wedo', 'local', 'procedures.md'), 'step 1\n')
  await writeFile(join(dir, 'devdocs', 'workflows', 'backfill.yaml'), WF)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remotes', `pj-g${n}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote]); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  return { area, registry, dir, remote, shared, ws, id, x: new ExecStore({ registryFile: registry, area }) }
}
type S = Awaited<ReturnType<typeof setup>>
const report = (s: S, ref: RunRef, attempt: string, op: OpInput) => runOp(s.ws, ref, { ...op, attempt }, { by: 'autolab', via: 'cli' })
const head = (repo: string, ref = 'main') => gitOk(repo, ['rev-parse', ref]).then(x => x.trim())

// A run that writes `files` in its copy (after `prepare`, run in the copy) and completes.
async function completed(s: S, receipt: string, files: Record<string, string>, prepare?: (cwd: string) => Promise<void>) {
  const { ref } = await s.x.request({ workspace: s.id, workflow: 'backfill', text: 'Supplement.', author: 'Test Person', receipt, via: 'browser' })
  const c = await s.x.claim('t')
  assert.ok('attempt' in c, JSON.stringify(c))
  s.x.started(c.attempt.id, process.pid)
  await report(s, ref, c.attempt.id, { op: 'node.start', node: 'write' })
  if (prepare) await prepare(c.cwd)
  for (const [p, t] of Object.entries(files)) { await mkdir(join(c.cwd, p, '..'), { recursive: true }); await writeFile(join(c.cwd, p), t) }
  await report(s, ref, c.attempt.id, { op: 'node.complete', node: 'write', outcome: 'written' })
  const f = await s.x.finished(c.attempt.id, { code: 0, signal: null })
  assert.equal(f.checkpoint?.state, 'published', JSON.stringify(f.checkpoint))
  return { ref, cwd: c.cwd }
}
async function accept(s: S, ref: RunRef) {
  await runOp(s.ws, ref, { op: 'run.decide', decision: 'accepted', evidence: 'looked at it' }, { by: 'Test Person', via: 'browser' })
  await s.x.afterDecision(s.ws, ref, 'accepted')
}
async function elsewhere(s: S, remote: string, files: Record<string, string>) {
  const other = join(s.area, `other-${Math.random().toString(36).slice(2, 8)}`)
  await gitOk(s.area, ['clone', '-q', remote, other])
  for (const [p, t] of Object.entries(files)) { await mkdir(join(other, p, '..'), { recursive: true }); await writeFile(join(other, p), t) }
  await gitOk(other, ['add', '-A']); await gitOk(other, ['commit', '-q', '-m', 'elsewhere']); await gitOk(other, ['push', '-q', 'origin', 'HEAD:main'])
}
const status = async (s: S, ref: RunRef) => integrationStatus((await readRun(s.ws, ref)).record!, await s.x.runView(s.id, ref) as unknown as RunExecView, { kind: 'run-copy', branch: null })

test('definition: integrate is validated, digested only when declared, and resolved against the run\'s repositories', () => {
  const w = parseWorkflow(WF)
  assert.ok(w.ok)
  if (!w.ok) return
  assert.deepEqual(validateWorkflow(w.model).filter(i => i.code.startsWith('binding-')), [])
  const plain = parseWorkflow(WF.replace(/, integrate: if-unchanged/g, ''))
  const bad = parseWorkflow(WF.replace('integrate: if-unchanged}\n  shared', 'integrate: sometimes}\n  shared'))
  assert.ok(plain.ok && bad.ok)
  if (!plain.ok || !bad.ok) return
  assert.deepEqual(validateWorkflow(bad.model).filter(i => i.code === 'binding-integrate').map(i => i.severity), ['error'])
  const ro = parseWorkflow(WF.replace('root: {path: ., access: readonly}', 'root: {path: ., access: readonly, integrate: if-unchanged}'))
  assert.ok(ro.ok && validateWorkflow(ro.model).some(i => i.code === 'binding-integrate-readonly'))
  const merge = parseWorkflow(WF.replace(/, integrate: if-unchanged/g, ', integrate: merge'))
  assert.ok(merge.ok)
  if (!merge.ok) return
  return Promise.all([semanticDigest('definition', w.model), semanticDigest('definition', plain.model), semanticDigest('definition', merge.model)]).then(([guarded, unguarded, merged]) => {
    assert.notEqual(guarded, unguarded, 'declaring the guard is a definition change')
    assert.notEqual(merged, unguarded, 'any declared value is projected')
    const storage = { branch: 'b', repositories: [{ path: '.', base: 'x', branch: 'b', target: 'main' }, { path: 'wedo/wedo-x', base: 'y', branch: 'b', target: 'main' }] }
    assert.deepEqual(guardsFor(w.model.repositories, storage as never), [
      { binding: 'wedo', repo: '.', paths: ['wedo/local'] },
      { binding: 'shared', repo: 'wedo/wedo-x', paths: [''] },
    ])
  })
})

test('a shared repository that changed since the run built on it stops as target-changed; nothing is pushed', async () => {
  const s = await setup()
  const a = await completed(s, 'guard-0001', { 'wedo/wedo-x/cases.md': 'case 1\ncase 2 from the runs\n' })
  // The owning project records knowledge of its own meanwhile, in another file.
  await elsewhere(s, s.shared, { 'cases-by-project.md': 'case 2, as the project wrote it\n' })
  await accept(s, a.ref)
  const sharedMain = await head(s.shared), rootMain = await head(s.remote)
  const plan = await s.x.integrateRun(s.ws, a.ref, { by: 'Test Person', via: 'cli', dryRun: true })
  assert.equal(plan.state, 'target-changed', 'the dry run says so too')
  const r = await s.x.integrateRun(s.ws, a.ref, { by: 'Test Person', via: 'cli' })
  assert.equal(r.state, 'target-changed')
  const step = r.steps.find(x => x.repo === 'wedo/wedo-x')!
  assert.deepEqual(step.files, ['cases-by-project.md'])
  assert.match(r.error ?? '', /changed under the guarded binding shared \(the repository\).*reassess against the current target in a successor run/)
  assert.equal(await head(s.shared), sharedMain, 'nothing pushed to the shared repository')
  assert.equal(await head(s.remote), rootMain, 'nor to the root')
  const st = await status(s, a.ref)
  assert.equal(st?.state, 'target-changed')
  assert.deepEqual(st?.changed, ['wedo/wedo-x/cases-by-project.md'])
  assert.equal((await readRun(s.ws, a.ref)).record!.integrations, undefined)
  // The CLI's standing names the target's changes as such, not as changes since the acceptance.
  const { main } = await import('../cli/wfe.ts')
  const out: string[] = []
  const log = console.log
  console.log = (...m: unknown[]) => { out.push(m.join(' ')) }
  try { assert.equal(await main(['run', 'integrate', 'backfill/run-001', '--status', '--workspace', s.id, '--registry', s.registry, '--area', s.area]), 0) } finally { console.log = log }
  assert.match(out.join('\n'), /changed on the target since this run built on it: wedo\/wedo-x\/cases-by-project\.md/)
  assert.doesNotMatch(out.join('\n'), /changed since the acceptance/)
})

test('the root-local area: a change elsewhere in the root still merges; a change inside the guarded folder stops', async () => {
  const s = await setup()
  const a = await completed(s, 'guard-0002', { 'wedo/local/procedures.md': 'step 1\nstep 2 from the runs\n' })
  await elsewhere(s, s.remote, { 'NEWS.md': 'unrelated\n' })
  await accept(s, a.ref)
  const r = await s.x.integrateRun(s.ws, a.ref, { by: 'Test Person', via: 'cli' })
  assert.equal(r.state, 'integrated', r.error)
  assert.equal(r.steps.find(x => x.repo === '.')!.method, 'merge')
  const b = await completed(s, 'guard-0003', { 'wedo/local/procedures.md': 'step 1\nstep 2 from the runs\nstep 3\n' })
  // An ownership change in the guarded folder, in a file the run did not touch.
  await elsewhere(s, s.remote, { 'wedo/local/knowledge.yaml': 'maintenance: project\n' })
  await accept(s, b.ref)
  const main = await head(s.remote)
  const r2 = await s.x.integrateRun(s.ws, b.ref, { by: 'Test Person', via: 'cli' })
  assert.equal(r2.state, 'target-changed')
  assert.deepEqual(r2.steps.find(x => x.repo === '.')!.files, ['wedo/local/knowledge.yaml'])
  assert.equal(await head(s.remote), main)
})

test('a run that brought the current target into its branch passes the guard', async () => {
  const s = await setup()
  await elsewhere(s, s.shared, { 'cases-by-project.md': 'case 2, as the project wrote it\n' })
  // The copy was made from the pinned gitlink, behind the shared main; the
  // run fetches and fast-forwards before it writes (it saw the change).
  const a = await completed(s, 'guard-0004', { 'wedo/wedo-x/cases.md': 'case 1\ncase 3 from the runs\n' }, async cwd => {
    const sub = join(cwd, 'wedo', 'wedo-x')
    await gitOk(sub, ['fetch', '-q', 'origin', 'main'])
    await gitOk(sub, ['merge', '-q', '--ff-only', 'FETCH_HEAD'])
  })
  await accept(s, a.ref)
  const r = await s.x.integrateRun(s.ws, a.ref, { by: 'Test Person', via: 'cli' })
  assert.equal(r.state, 'integrated', r.error)
  assert.equal(r.steps.find(x => x.repo === 'wedo/wedo-x')!.method, 'fast-forward')
  assert.equal((await git(s.shared, ['show', 'main:cases-by-project.md'])).stdout, 'case 2, as the project wrote it\n')
  assert.equal((await git(s.shared, ['show', 'main:cases.md'])).stdout, 'case 1\ncase 3 from the runs\n')
})
