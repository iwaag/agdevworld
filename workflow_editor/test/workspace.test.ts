// Step 2: project read/write surface against real Git fixtures.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seed } from '../scripts/seed.ts'
import { gitOk } from '../server/git.ts'
import { inside } from '../server/files.ts'
import { loadRegistry, observe } from '../server/registry.ts'
import { RequestError, Workspace } from '../server/workspace.ts'

let root = ''
let a: Workspace
let b: Workspace

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-ws-'))
  await rm(root, { recursive: true })
  await seed(root, false)
  const reg = await loadRegistry(join(root, 'registry.json'))
  a = new Workspace(reg.workspaces.find(w => w.id === 'a')!)
  b = new Workspace(reg.workspaces.find(w => w.id === 'b')!)
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const rev = (dir: string, ...args: string[]) => gitOk(dir, ['rev-parse', ...args]).then(s => s.trim())

test('registration is distinguished from observed availability', async () => {
  const reg = await loadRegistry(join(root, 'registry.json'))
  const obs = await Promise.all(reg.workspaces.map(observe))
  assert.deepEqual(obs.map(o => o.available), [true, true, false])
  assert.equal(obs[0].projectId, 'demo')
  assert.match(obs[2].reason ?? '', /not found/)
})

test('repository inspection matches Git: recorded, HEAD, detached, branch, uninitialized', async () => {
  const repos = await a.repositories()
  const by = new Map(repos.map(r => [r.path, r]))
  assert.equal(by.get('.')!.category, 'root')
  assert.equal(by.get('devdocs')!.category, 'devdocs')
  assert.equal(by.get('study/tools')!.category, 'study')
  assert.equal(by.get('wedo/runtime')!.category, 'wedo')
  assert.equal(by.get('assets/shared')!.category, 'other')
  for (const path of ['devdocs', 'study/agentic-patterns', 'study/tools', 'wedo/runtime', 'wedo/pipeline']) {
    const r = by.get(path)!
    const lsTree = (await gitOk(a.root, ['ls-tree', 'HEAD', path])).split(/\s+/)[2]
    assert.equal(r.recorded, lsTree, `${path} recorded`)
    assert.equal(r.head, await rev(join(a.root, path), 'HEAD'), `${path} head`)
    assert.equal(r.initialized, true)
  }
  assert.equal(by.get('study/tools')!.branch, null, 'detached after submodule update')
  assert.equal(by.get('study/agentic-patterns')!.branch, 'main')
  const shared = by.get('assets/shared')!
  assert.equal(shared.initialized, false)
  assert.equal(shared.head, undefined)
  assert.ok(shared.recorded)
  assert.equal(shared.url, '../shared-assets.git')
  // B initialized everything.
  assert.equal((await b.repositories()).find(r => r.path === 'assets/shared')!.initialized, true)
})

test('dirty checkouts and moved HEADs are reported as they are', async () => {
  await writeFile(join(a.root, 'wedo/runtime/notes.md'), 'local change\n')
  await gitOk(join(a.root, 'study/tools'), ['commit', '--allow-empty', '-m', 'local commit'], { config: { 'user.name': 't', 'user.email': 't@example.invalid', 'commit.gpgsign': 'false' } })
  const by = new Map((await a.repositories()).map(r => [r.path, r]))
  assert.equal(by.get('wedo/runtime')!.dirty, 1)
  assert.equal(by.get('wedo/runtime')!.matchesRecorded, true)
  assert.equal(by.get('study/tools')!.matchesRecorded, false)
  assert.equal(by.get('study/tools')!.branch, null)
  assert.notEqual(by.get('study/tools')!.head, by.get('study/tools')!.recorded)
  await gitOk(join(a.root, 'study/tools'), ['checkout', '-q', by.get('study/tools')!.recorded!])
})

test('project metadata edits keep comments and are written atomically', async () => {
  const before = await a.readProject()
  assert.ok(before.project)
  const p = structuredClone(before.project)
  p.name = 'Demo Delivery Project (edited)'
  p.goals.push('A goal added from the editor.')
  const saved = await a.saveProject(p)
  const text = await readFile(join(a.root, 'project.yaml'), 'utf8')
  assert.equal(saved.text, text)
  assert.match(text, /^# Project definition \(ag\.project\.v2\)\.\n# Repositories are not listed here/)
  assert.match(text, /- A goal added from the editor\.\n$/)
  const again = await a.readProject()
  assert.deepEqual(again.project, p)
  // An unchanged save does not touch the file.
  assert.equal((await a.saveProject(p)).text, text)
})

test('a malformed project.yaml is not overwritten', async () => {
  const path = join(b.root, 'project.yaml')
  const original = await readFile(path, 'utf8')
  await writeFile(path, 'schema: ag.project.v1\nname: [unclosed\n')
  const read = await b.readProject()
  assert.equal(read.problem?.kind, 'malformed')
  await assert.rejects(b.saveProject({ schema: 'ag.project.v2', id: 'demo', name: 'x', devdocs: 'submodule', intent: '', goals: [] }), (e: unknown) => e instanceof RequestError && e.status === 409)
  assert.equal(await readFile(path, 'utf8'), 'schema: ag.project.v1\nname: [unclosed\n')
  await writeFile(path, original)
})

test('workflows are discovered by content and created with unique ids', async () => {
  const { list } = await a.workflowSummaries()
  assert.deepEqual(list.map(w => w.id), ['draft-gaps', 'onboarding', 'repo-setup'])
  assert.equal(list.find(w => w.id === 'draft-gaps')!.errors, 4)
  const created = await a.createWorkflow('release-check', 'Release Check')
  assert.equal(created.file, 'release-check.yaml')
  const text = await readFile(join(a.root, 'devdocs/workflows/release-check.yaml'), 'utf8')
  assert.match(text, /^# Workflow definition/)
  assert.match(text, /id: release-check\nname: Release Check\n/)
  await assert.rejects(a.createWorkflow('release-check', 'again'), /already used/)
  await assert.rejects(a.createWorkflow('Bad Id', 'x'), /must match/)
  // A file whose name differs from its id is still found by id.
  await writeFile(join(a.root, 'devdocs/workflows/renamed-file.yml'), text.replace('id: release-check', 'id: other-id'))
  const after = (await a.workflowSummaries()).list
  assert.ok(after.some(w => w.file === 'renamed-file.yml' && w.id === 'other-id'))
  await rm(join(a.root, 'devdocs/workflows/renamed-file.yml'))
})

test('adding a local repository as a submodule uses real Git state', async () => {
  const result = await a.addSubmodule('study/evals', '../study-evals.git')
  assert.ok(result.ok, result.stderr)
  const status = await gitOk(a.root, ['status', '--porcelain'])
  assert.match(status, /^A {2}study\/evals$/m)
  assert.match(status, /^M {2}\.gitmodules$/m)
  const repo = (await a.repositories()).find(r => r.path === 'study/evals')!
  assert.equal(repo.initialized, true)
  assert.equal(repo.category, 'study')
  assert.equal(repo.recorded, undefined, 'not committed yet')
  assert.equal(repo.staged, repo.head)
  // The dirty change in wedo/runtime from an earlier test is untouched.
  assert.equal((await a.repositories()).find(r => r.path === 'wedo/runtime')!.dirty, 1)
  await assert.rejects(a.addSubmodule('study/evals', '../study-evals.git'), /already a submodule/)
  await assert.rejects(a.addSubmodule('../outside', '../study-evals.git'), /not a project-relative path/)
})

test('a failed submodule add reports what Git left and resets nothing', async () => {
  const before = await gitOk(a.root, ['status', '--porcelain'])
  const result = await a.addSubmodule('other/missing', '../no-such-repo.git')
  assert.equal(result.ok, false)
  assert.ok(result.stderr && result.stderr.length > 0)
  assert.ok(result.partial)
  assert.equal(result.partial.gitmodulesEntry, false)
  assert.equal(await gitOk(a.root, ['status', '--porcelain']), before)
})

test('file access is bounded to the workspace root', async () => {
  await assert.rejects(inside(a.root, '../b/project.yaml'), /leaves the workspace/)
  await assert.rejects(inside(a.root, '/etc/hosts'), /leaves the workspace/)
  await symlink(b.root, join(a.root, '.local', 'link-to-b'))
  await assert.rejects(inside(a.root, '.local/link-to-b/project.yaml'), /outside the workspace/)
  await assert.rejects(a.readWorkflowFile('../../project.yaml'), /invalid workflow file name/)
})
