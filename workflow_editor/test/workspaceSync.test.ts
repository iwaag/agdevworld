// improve_wfrun p1 step 3: the workspace beside the published source — its
// relation (same, behind, ahead, diverged; dirtiness apart), the optional
// fast-forward synchronization (refusals change nothing; a partial update
// is reported and continued by running it again), and a trial of editing
// content (the exact bytes on the published code).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccessContext, RepoHost } from '../server/access.ts'
import { gitOk, LOCAL_TRANSPORT } from '../server/git.ts'
import type { GiteaRepo } from '../server/gitea.ts'
import { createRunInCopy } from '../server/runs.ts'
import { readCopy } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'
import { syncWorkspace, workspaceRelation } from '../server/workspaceSync.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-wssync-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = (intent: string) => `schema: ag.workflow.v2
documentation: {policy: manual}
id: freework
name: Free work
intent: |
  ${intent}
repositories:
  root: {path: ., access: editable}
nodes:
  build:
    type: do
    description: Build.
edges: []
`

function stubHost(dir: string, repos: Record<number, [string, string]>): RepoHost {
  const info = (id: number, owner: string, name: string): GiteaRepo => ({ id, owner, name, fullName: `${owner}/${name}`, cloneUrl: join(dir, owner, `${name}.git`), htmlUrl: '', description: '', empty: false, defaultBranch: 'main', archived: false })
  return {
    url: 'http://gitea.test', cloneUrl: (o, n) => join(dir, o, `${n}.git`), gitEnv: async () => ({}),
    repoById: async id => (repos[id] ? info(id, ...repos[id]) : null),
    repo: async (o, n) => { const hit = Object.entries(repos).find(([, [ow, nm]]) => ow === o && nm === n); return hit ? info(Number(hit[0]), o, n) : null },
  }
}
const head = (dir: string, ref = 'HEAD') => gitOk(dir, ['rev-parse', ref]).then(s => s.trim())
async function commitIn(dir: string, files: Record<string, string>, push = true) {
  for (const [p, t] of Object.entries(files)) { await mkdir(join(dir, p, '..'), { recursive: true }); await writeFile(join(dir, p), t) }
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'change'])
  if (push) await gitOk(dir, ['push', '-q', 'origin', 'HEAD:main'])
}

let s: { ctx: AccessContext; ws: Workspace; dir: string; other: string; area: string }

test('setup: a project with a submodule, a workspace, and another clone that publishes', async () => {
  const gitea = join(root, 'gitea'), area = join(root, 'area')
  await mkdir(join(gitea, 'dev'), { recursive: true })
  const modSrc = join(root, 'mod-src')
  await gitOk(root, ['init', '-q', modSrc]); await writeFile(join(modSrc, 'M.md'), 'm1\n'); await gitOk(modSrc, ['add', '-A']); await gitOk(modSrc, ['commit', '-q', '-m', 'm1'])
  await gitOk(root, ['clone', '-q', '--bare', modSrc, join(gitea, 'dev', 'mod.git')])
  const src = join(root, 'w-src')
  await gitOk(root, ['init', '-q', src])
  await gitOk(src, ['remote', 'add', 'origin', join(gitea, 'dev', 'pj-w.git')])
  await writeFile(join(src, 'project.yaml'), 'schema: ag.project.v2\nid: w\nname: W\ndevdocs: directory\nintent: x\ngoals: []\n')
  await writeFile(join(src, '.gitignore'), '.local/\n')
  await mkdir(join(src, 'devdocs', 'workflows'), { recursive: true }); await writeFile(join(src, 'devdocs', 'workflows', 'freework.yaml'), WF('Published one.'))
  await gitOk(src, ['submodule', 'add', '-q', '../mod.git', 'lib/mod'], { config: LOCAL_TRANSPORT })
  await gitOk(src, ['add', '-A']); await gitOk(src, ['commit', '-q', '-m', 'w'])
  await gitOk(root, ['clone', '-q', '--bare', src, join(gitea, 'dev', 'pj-w.git')])
  const dir = join(area, 'pj-w'), other = join(root, 'other')
  for (const d of [dir, other]) await gitOk(root, ['clone', '-q', '--recurse-submodules', join(gitea, 'dev', 'pj-w.git'), d], { config: LOCAL_TRANSPORT })
  const registry = join(area, 'registry.json')
  await writeFile(registry, JSON.stringify({ approver: 'Test Person', workspaces: [{ id: 'w', label: 'W', host: 'this machine', path: dir, project: 'w' }], projects: [{ id: 'w', root: 'gitea:1', registered: '' }], repositories: [{ gitea: { id: 1, owner: 'dev', name: 'pj-w' }, category: 'root', description: '', registered: '' }, { gitea: { id: 2, owner: 'dev', name: 'mod' }, category: 'other', description: '', registered: '' }] }))
  s = { ctx: { registryFile: registry, area, gitea: stubHost(gitea, { 1: ['dev', 'pj-w'], 2: ['dev', 'mod'] }), fetchTtlMs: 0 }, ws: new Workspace({ id: 'w', label: 'W', host: 'this machine', path: dir, project: 'w' }), dir, other, area }
  const r = await workspaceRelation(s.ctx, s.ws)
  assert.equal(r.root.relation, 'same'); assert.equal(r.next, 'none')
  assert.deepEqual(r.submodules.map(x => [x.path, x.relation]), [['lib/mod', 'same']])
})

test('behind, with dirtiness apart; sync fast-forwards the root and a submodule whose pin moved', async () => {
  await commitIn(join(s.other, 'lib', 'mod'), { 'M.md': 'm2\n' })
  await commitIn(s.other, { 'devdocs/workflows/freework.yaml': WF('Published two.') })
  await writeFile(join(s.dir, 'scratch.txt'), 'untracked\n')
  const r = await workspaceRelation(s.ctx, s.ws)
  assert.equal(r.root.relation, 'behind'); assert.equal(r.root.behind, 1); assert.equal(r.root.ahead, 0)
  assert.equal(r.root.dirty, 1, 'counted apart from the relation')
  assert.equal(r.submodules[0].relation, 'behind')
  assert.equal(r.next, 'resolve-by-hand', 'an uncommitted file blocks the automatic update')
  const refused = await syncWorkspace(s.ctx, s.ws)
  assert.equal(refused.ok, false); assert.match(refused.message, /Nothing was changed\. the root has 1 uncommitted change/)
  assert.equal(await head(s.dir), r.root.head)
  await rm(join(s.dir, 'scratch.txt'))
  const dry = await syncWorkspace(s.ctx, s.ws, { dryRun: true })
  assert.deepEqual(dry.steps.map(x => [x.path, x.state]), [['.', 'planned'], ['lib/mod', 'planned']])
  assert.equal(await head(s.dir), r.root.head, 'a dry run moves nothing')
  const done = await syncWorkspace(s.ctx, s.ws)
  assert.equal(done.ok, true, done.message)
  assert.deepEqual(done.steps.map(x => [x.path, x.state]), [['.', 'moved'], ['lib/mod', 'moved']])
  assert.equal(await head(s.dir), await head(s.other))
  assert.equal(await head(join(s.dir, 'lib', 'mod')), await head(join(s.other, 'lib', 'mod')))
  assert.equal(done.relation.next, 'none')
})

test('ahead and diverged are reported, and sync refuses them without changing anything', async () => {
  await commitIn(s.dir, { 'LOCAL.md': 'mine\n' }, false)
  let r = await workspaceRelation(s.ctx, s.ws)
  assert.equal(r.root.relation, 'ahead'); assert.equal(r.root.ahead, 1)
  await commitIn(s.other, { 'THEIRS.md': 'theirs\n' })
  r = await workspaceRelation(s.ctx, s.ws)
  assert.equal(r.root.relation, 'diverged')
  assert.equal(r.next, 'resolve-by-hand')
  const before = await head(s.dir)
  const res = await syncWorkspace(s.ctx, s.ws)
  assert.equal(res.ok, false)
  assert.equal(await head(s.dir), before)
  await gitOk(s.dir, ['reset', '-q', '--hard', 'origin/main']) // the person reconciles it by hand
  await gitOk(s.dir, ['pull', '-q', '--ff-only'])
})

test('another branch checked out is refused with the reason', async () => {
  await commitIn(s.other, { 'MORE.md': 'more\n' })
  await gitOk(s.dir, ['checkout', '-q', '-b', 'editing'])
  const res = await syncWorkspace(s.ctx, s.ws)
  assert.equal(res.ok, false)
  assert.match(res.message, /branch editing checked out, not main/)
  await gitOk(s.dir, ['checkout', '-q', 'main'])
})

test('a partial update says what moved and what did not; running it again continues', async () => {
  await commitIn(join(s.other, 'lib', 'mod'), { 'M.md': 'm3\n' })
  await commitIn(s.other, { 'NOTE.md': 'pin moves\n' })
  // The submodule cannot reach its remote now.
  const url = (await gitOk(join(s.dir, 'lib', 'mod'), ['remote', 'get-url', 'origin'])).trim()
  await gitOk(join(s.dir, 'lib', 'mod'), ['remote', 'set-url', 'origin', join(root, 'nowhere.git')])
  const res = await syncWorkspace(s.ctx, s.ws)
  assert.equal(res.ok, false)
  assert.deepEqual(res.steps.map(x => [x.path, x.state]), [['.', 'moved'], ['lib/mod', 'failed']], res.message)
  assert.match(res.message, /Partly synchronized: \. moved; lib\/mod:/)
  assert.match(res.recovery ?? '', /run the synchronization again/)
  assert.equal(res.relation.submodules[0].relation, 'behind', 'diagnosable: the submodule is still at its old pin')
  await gitOk(join(s.dir, 'lib', 'mod'), ['remote', 'set-url', 'origin', url])
  const again = await syncWorkspace(s.ctx, s.ws)
  assert.equal(again.ok, true, again.message)
  assert.deepEqual(again.steps.map(x => [x.path, x.state]), [['lib/mod', 'moved']])
  assert.equal(await head(join(s.dir, 'lib', 'mod')), await head(join(s.other, 'lib', 'mod')))
})

test('a trial runs the exact editing bytes on the published code, and says so', async () => {
  await writeFile(join(s.dir, 'devdocs', 'workflows', 'freework.yaml'), WF('Edited, not committed.'))
  await writeFile(join(s.dir, 'CODE.md'), 'uncommitted project code\n')
  const text = await readFile(join(s.dir, 'devdocs', 'workflows', 'freework.yaml'), 'utf8')
  const sha = createHash('sha256').update(text).digest('hex')
  const o = { workflow: 'freework', executor: { host: 'autolab' }, by: 'Test Person', via: 'cli', access: s.ctx, input: { kind: 'braindump' as const, text: 'try it', author: 'Test Person' } }
  await assert.rejects(createRunInCopy(s.ws, { ...o, receipt: 'trial-0001', trial: { file: 'freework.yaml', sha256: '0'.repeat(64) } }), /changed since it was shown/)
  const created = await createRunInCopy(s.ws, { ...o, receipt: 'trial-0002', trial: { file: 'freework.yaml', sha256: sha } })
  const src = created.record.definition.source!
  assert.equal(src.kind, 'trial')
  if (src.kind !== 'trial') return
  assert.equal(src.sha256, sha)
  assert.equal(src.file, 'devdocs/workflows/freework.yaml')
  assert.equal(src.dirty, true)
  assert.deepEqual(src.baseline, { project: 'w', repository: 'dev/pj-w', branch: 'main', commit: await head(s.other) })
  const copy = (await readCopy(s.ws, created.ref))!
  assert.equal(await readFile(join(copy.tree, created.dir, 'definition', 'freework.yaml'), 'utf8'), text, 'the definition is the editing bytes')
  assert.equal(copy.manifest!.repositories[0].base, await head(s.other), 'the code is the published commit')
  await assert.rejects(readFile(join(copy.tree, 'CODE.md'), 'utf8'), /ENOENT/, 'uncommitted project code is not included')
  await gitOk(s.dir, ['checkout', '-q', '--', 'devdocs/workflows/freework.yaml']); await rm(join(s.dir, 'CODE.md'))
})
