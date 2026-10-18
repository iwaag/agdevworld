// project_migration p4: project access. Any registered project is read —
// with or without a workspace here, devdocs as a directory or a submodule —
// at its committed revision by default, a submodule at the commit its project
// pins or at its upstream tip, with provenance, explicit failure states, and
// without touching any workspace. Runs: the live record beside the published
// snapshot.
import { emptyWorkflow } from '../shared/model.ts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessError, list, locate, read, run, runFile, runs, search, show, tree, type AccessContext, type RepoHost } from '../server/access.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk, LOCAL_TRANSPORT } from '../server/git.ts'
import type { GiteaRepo } from '../server/gitea.ts'
import { loadRegistry } from '../server/registry.ts'
import { runOp } from '../server/runs.ts'
import { Workspace } from '../server/workspace.ts'
import type { OpInput, RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-access-'))
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
intake: {zulip: requests}
repositories:
  root: {path: ., access: editable}
  study: {path: study/study-x, access: readonly}
nodes:
  build:
    type: do
    description: Build.
edges: []
`

// A Gitea stand-in: bare repositories at <gitea>/<owner>/<name>.git, by id.
function stubHost(dir: string, repos: Record<number, [string, string]>): RepoHost {
  const info = (id: number, owner: string, name: string): GiteaRepo => ({ id, owner, name, fullName: `${owner}/${name}`, cloneUrl: join(dir, owner, `${name}.git`), htmlUrl: '', description: '', empty: false, defaultBranch: 'main', archived: false })
  return {
    url: 'http://gitea.test',
    cloneUrl: (o, n) => join(dir, o, `${n}.git`),
    gitEnv: async () => ({}),
    repoById: async id => (repos[id] ? info(id, ...repos[id]) : null),
    repo: async (o, n) => { const hit = Object.entries(repos).find(([, [ow, nm]]) => ow === o && nm === n); return hit ? info(Number(hit[0]), o, n) : null },
  }
}

async function bareWith(dir: string, files: Record<string, string>) {
  const src = `${dir}.src`
  await mkdir(src, { recursive: true })
  await gitOk(src, ['init', '-q'])
  for (const [p, t] of Object.entries(files)) { await mkdir(join(src, p, '..'), { recursive: true }); await writeFile(join(src, p), t) }
  await gitOk(src, ['add', '-A']); await gitOk(src, ['commit', '-q', '-m', 'initial'])
  await gitOk(root, ['clone', '-q', '--bare', src, dir])
  return src
}
const head = (repo: string, ref = 'main') => gitOk(repo, ['rev-parse', ref]).then(x => x.trim())
async function pushTo(bare: string, files: Record<string, string>, message = 'more') {
  const other = join(root, `push-${Math.random().toString(36).slice(2, 8)}`)
  await gitOk(root, ['clone', '-q', bare, other])
  for (const [p, t] of Object.entries(files)) { await mkdir(join(other, p, '..'), { recursive: true }); await writeFile(join(other, p), t) }
  await gitOk(other, ['add', '-A']); await gitOk(other, ['commit', '-q', '-m', message]); await gitOk(other, ['push', '-q', 'origin', 'HEAD:main'])
  return head(bare)
}

let s: Awaited<ReturnType<typeof setup>>
async function setup() {
  const area = join(root, 'area')
  const gitea = join(root, 'gitea')
  const registry = join(area, 'registry.json')
  await mkdir(join(gitea, 'dev'), { recursive: true })
  // A shared study.
  const study = join(gitea, 'dev', 'study-x.git')
  await bareWith(study, { 'README.md': '# study-x\n', 'notes/economy.md': 'Economy: gold and wood.\nBots expand early.\n' })
  // Project a: devdocs directory, a workspace here, the study as a submodule
  // (relative URL), a local area, and a submodule outside this Gitea.
  const dir = join(area, 'pj-a')
  const c = await createProject({ dir, id: 'a', name: 'Project A', intent: 'Ship things.', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(c.ok, c.message)
  const remote = join(gitea, 'dev', 'pj-a.git')
  await gitOk(gitea, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote])
  await gitOk(dir, ['submodule', 'add', '-q', '../study-x.git', 'study/study-x'], { config: LOCAL_TRANSPORT })
  const yaml = await readFile(join(dir, 'project.yaml'), 'utf8')
  await writeFile(join(dir, 'project.yaml'), `${yaml}areas:\n  wedo: {description: Procedures kept here}\n`)
  await mkdir(join(dir, 'wedo'), { recursive: true })
  await writeFile(join(dir, 'wedo', 'knowledge.yaml'), 'schema: ag.knowledge.v1\nkind: wedo\nmaintenance: supplemented\n')
  await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), WF)
  await writeFile(join(dir, '.gitmodules'), `${await readFile(join(dir, '.gitmodules'), 'utf8')}[submodule "ext/elsewhere"]\n\tpath = ext/elsewhere\n\turl = https://github.example/someone/elsewhere.git\n`)
  await gitOk(dir, ['add', '-A'])
  await gitOk(dir, ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},ext/elsewhere`])
  await gitOk(dir, ['commit', '-q', '-m', 'project a']); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  // Project b: devdocs as a submodule, and no workspace on this host.
  const bDevdocs = join(gitea, 'dev', 'pj-b-devdocs.git')
  await bareWith(bDevdocs, { 'workflows/survey.yaml': WF.replace('id: ship', 'id: survey').replace(/repositories:[\s\S]*?nodes:/, 'repositories: {}\nnodes:'), 'README.md': 'b devdocs\n' })
  const bSrc = await bareWith(join(gitea, 'dev', 'pj-b.git.tmp'), {
    'project.yaml': 'schema: ag.project.v2\nid: b\nname: Project B\ndevdocs: submodule\nintent: Survey things.\ngoals: []\n',
    '.gitignore': '.local/\n',
    '.gitmodules': '[submodule "devdocs"]\n\tpath = devdocs\n\turl = ../pj-b-devdocs.git\n',
  })
  await gitOk(bSrc, ['update-index', '--add', '--cacheinfo', `160000,${await head(bDevdocs)},devdocs`])
  await gitOk(bSrc, ['commit', '-q', '-m', 'devdocs gitlink'])
  await gitOk(root, ['clone', '-q', '--bare', bSrc, join(gitea, 'dev', 'pj-b.git')])
  // The registry: identities only.
  const raw = JSON.parse(await readFile(registry, 'utf8'))
  raw.workspaces[0].project = 'a'
  raw.repositories = [
    { gitea: { id: 1, owner: 'dev', name: 'pj-a' }, category: 'root', description: '' },
    { gitea: { id: 2, owner: 'dev', name: 'study-x' }, category: 'study', description: 'shared study' },
    { gitea: { id: 3, owner: 'dev', name: 'pj-b' }, category: 'root', description: '' },
    { gitea: { id: 5, owner: 'dev', name: 'pj-b-devdocs' }, category: 'devdocs', description: '' },
  ]
  raw.projects = [{ id: 'a', root: 'gitea:1' }, { id: 'b', root: 'gitea:3' }]
  await writeFile(registry, JSON.stringify(raw, null, 2))
  const host = stubHost(gitea, { 1: ['dev', 'pj-a'], 2: ['dev', 'study-x'], 3: ['dev', 'pj-b'], 5: ['dev', 'pj-b-devdocs'] })
  const ctx: AccessContext = { registryFile: registry, area, gitea: host, fetchTtlMs: 0 }
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  return { area, gitea, registry, dir, remote, study, bDevdocs, ctx, ws, x: new ExecStore({ registryFile: registry, area }) }
}

const report = (ref: RunRef, attempt: string, op: OpInput) => runOp(s.ws, ref, { ...op, attempt }, { by: 'autolab', via: 'cli' })
async function completed(receipt: string, files: Record<string, string>) {
  const { ref } = await s.x.request({ workspace: 'a', workflow: 'ship', text: 'Build it.', author: 'Test Person', receipt, via: 'browser' })
  const c = await s.x.claim('t')
  assert.ok('attempt' in c, JSON.stringify(c))
  s.x.started(c.attempt.id, process.pid)
  await report(ref, c.attempt.id, { op: 'node.start', node: 'build' })
  for (const [p, t] of Object.entries(files)) await writeFile(join(c.cwd, p), t)
  await report(ref, c.attempt.id, { op: 'node.complete', node: 'build', outcome: 'built' })
  const f = await s.x.finished(c.attempt.id, { code: 0, signal: null })
  assert.equal(f.checkpoint?.state, 'published', JSON.stringify(f.checkpoint))
  return ref
}
// What a read must never change: the workspace's refs, HEADs and status.
async function workspaceState() {
  return [
    await gitOk(s.dir, ['for-each-ref', '--format=%(refname) %(objectname)']),
    await gitOk(s.dir, ['status', '--porcelain=v1', '--ignored']),
    await gitOk(join(s.dir, 'study', 'study-x'), ['for-each-ref', '--format=%(refname) %(objectname)']),
  ].join('\n')
}

test('setup', async () => { s = await setup() })

test('discovery: every project, with or without a workspace; shared repositories and who uses them', async () => {
  const l = await list(s.ctx)
  assert.deepEqual(l.projects.map(p => [p.id, p.name, p.devdocs]), [['a', 'Project A', 'directory'], ['b', 'Project B', 'submodule']])
  const a = l.projects[0], b = l.projects[1]
  assert.equal(a.commit, await head(s.remote))
  assert.deepEqual(a.workspaces.map(w => [w.id, w.available, w.atCommitted]), [['a', true, true]])
  assert.deepEqual(b.workspaces, [], 'b has no workspace here and is still read')
  assert.deepEqual(a.uses, [{ path: 'study/study-x', repository: 'dev/study-x' }, { path: 'ext/elsewhere', repository: null }])
  assert.deepEqual(l.repositories.find(r => r.key === 'gitea:2')!.usedBy, [{ project: 'a', path: 'study/study-x' }])
})

test('structure: project.yaml, areas, submodules pinned against upstream, workflows in either devdocs mode', async () => {
  const a = await show(s.ctx, 'a')
  assert.equal(a.provenance.revision.commit, await head(s.remote))
  assert.equal(a.provenance.source, 'committed')
  assert.deepEqual(a.areas, [{ path: 'wedo', description: 'Procedures kept here', category: 'wedo', present: true }])
  const study = a.submodules.find(x => x.path === 'study/study-x')!
  assert.equal(study.repository?.key, 'gitea:2')
  assert.equal(study.upstream?.relation, 'same')
  const ext = a.submodules.find(x => x.path === 'ext/elsewhere')!
  assert.equal(ext.state, 'inaccessible', 'a submodule outside this Gitea is said to be unreadable')
  const ship = a.workflows.find(w => w.id === 'ship')!
  assert.deepEqual([ship.intake, ship.repositories?.study], [true, { path: 'study/study-x', access: 'readonly' }])
  assert.ok(a.workflows.some(w => w.id === 'freework'), 'the basic workflow creation placed')
  const b = await show(s.ctx, 'b')
  assert.equal(b.devdocs.observed, 'submodule')
  assert.deepEqual(b.workflows.map(w => w.id), ['survey'], 'workflows read from the devdocs repository at the pinned commit')
  assert.deepEqual(b.workspaces, [])
})

test('content: tree, read and search at the pinned commit by default; upstream explicitly; a required commit is checked', async () => {
  const before = await workspaceState()
  const pinned = await head(s.study)
  const next = await pushTo(s.study, { 'notes/economy.md': 'Economy: gold and wood.\nBots expand early.\nBots also tech up.\n' })
  const r = await read(s.ctx, 'a', 'study/study-x/notes/economy.md')
  assert.equal(r.provenance.revision.selector, 'pinned')
  assert.equal(r.provenance.revision.commit, pinned)
  assert.deepEqual(r.provenance.revision.pinnedBy, { repository: 'dev/pj-a', commit: await head(s.remote) })
  assert.equal(r.provenance.repository.key, 'gitea:2')
  assert.doesNotMatch(r.text!, /tech up/)
  const up = await read(s.ctx, 'a', 'study/study-x/notes/economy.md', { upstream: true })
  assert.equal(up.provenance.revision.selector, 'upstream')
  assert.equal(up.provenance.revision.commit, next)
  assert.match(up.text!, /tech up/)
  const shown = await show(s.ctx, 'a')
  assert.deepEqual([shown.submodules[0].upstream?.relation, shown.submodules[0].upstream?.behind], ['behind', 1], 'the project pins an older commit than its repository has')
  await assert.rejects(read(s.ctx, 'a', 'study/study-x/README.md', { require: next }), (e: unknown) => e instanceof AccessError && e.state === 'absent' && /does not contain the required commit/.test(e.message))
  assert.equal((await read(s.ctx, 'a', 'study/study-x/README.md', { upstream: true, require: next })).provenance.revision.commit, next)
  const t = await tree(s.ctx, 'a', '.', { depth: 2 })
  assert.ok(t.entries.some(e => e.path === 'study/study-x' && e.type === 'submodule' && e.object === pinned))
  assert.ok(t.entries.some(e => e.path === 'wedo' && e.type === 'dir'))
  const deep = await tree(s.ctx, 'a', 'study/study-x', { depth: 3 })
  assert.deepEqual(deep.entries.map(e => e.path), ['study/study-x/README.md', 'study/study-x/notes', 'study/study-x/notes/economy.md'])
  const found = await search(s.ctx, 'a', 'expand', 'study/study-x')
  assert.deepEqual(found.matches, [{ path: 'study/study-x/notes/economy.md', line: 2, text: 'Bots expand early.' }])
  const top = await search(s.ctx, 'a', 'supplemented', '.')
  assert.deepEqual(top.matches.map(m => m.path), ['wedo/knowledge.yaml'])
  assert.deepEqual(top.notSearched.sort(), ['ext/elsewhere', 'study/study-x'])
  const capped = await read(s.ctx, 'a', 'study/study-x/notes/economy.md', { maxBytes: 10 })
  assert.equal(capped.truncated, true); assert.equal(capped.text, 'Economy: g'); assert.equal(capped.size, 43)
  // An earlier revision of the root, by commit.
  const first = (await gitOk(s.remote, ['rev-list', '--max-parents=0', 'main'])).trim()
  assert.equal((await tree(s.ctx, 'a', '.', { rev: first })).provenance.revision.commit, first)
  // Project b (no workspace, devdocs a submodule): its devdocs files.
  const b = await read(s.ctx, 'b', 'devdocs/README.md')
  assert.equal(b.text, 'b devdocs\n')
  assert.equal(b.provenance.repository.fullName, 'dev/pj-b-devdocs')
  assert.equal(b.provenance.repository.category, 'devdocs')
  // A registered repository on its own.
  assert.equal((await read(s.ctx, 'repo:dev/study-x', 'notes/economy.md')).provenance.revision.commit, next)
  assert.equal(await workspaceState(), before, 'no read changed the workspace')
})

test('failure states: absent, inaccessible, uninitialized, fetch-failed (a stale cache is said, never silent)', async () => {
  const state = (p: Promise<unknown>, st: string, re?: RegExp) => assert.rejects(p, (e: unknown) => e instanceof AccessError && e.state === st && (!re || re.test(e.message)))
  await state(read(s.ctx, 'a', 'nope.md'), 'absent', /does not exist/)
  await state(read(s.ctx, 'zzz', 'x'), 'absent', /not registered/)
  await state(read(s.ctx, 'a', 'ext/elsewhere/README.md'), 'inaccessible', /not a repository of this Gitea/)
  await state(read(s.ctx, 'a', '.local/secret.env'), 'inaccessible', /host-local/)
  await state(read(s.ctx, 'a', 'x', { rev: 'no-such-branch' }), 'absent', /no branch no-such-branch/)
  await state(read({ ...s.ctx, gitea: undefined, giteaProblem: 'unset' }, 'a', 'project.yaml'), 'inaccessible', /not available here: unset/)
  // Gitea unreachable for the study: the cached commit is used and labelled stale.
  await rename(s.study, `${s.study}.away`)
  try {
    const r = await read(s.ctx, 'a', 'study/study-x/README.md')
    assert.equal(r.provenance.fetch?.state, 'stale')
    assert.match(r.provenance.fetch?.error ?? '', /./)
    // Nothing cached at all: fetch-failed.
    await state(read({ ...s.ctx, area: join(root, 'empty-area') }, 'a', 'study/study-x/README.md'), 'fetch-failed', /nothing is cached/)
  } finally { await rename(`${s.study}.away`, s.study) }
  // The working tree, explicitly: a submodule not checked out is uninitialized.
  const plain = join(root, 'plain-clone')
  await gitOk(root, ['clone', '-q', s.remote, plain])
  const raw = JSON.parse(await readFile(s.registry, 'utf8'))
  raw.workspaces.push({ id: 'a-2', label: 'a-2', host: 'this machine', path: plain, project: 'a' })
  await writeFile(s.registry, JSON.stringify(raw, null, 2))
  try {
    await state(read(s.ctx, 'a', 'study/study-x/README.md', { source: 'worktree', workspace: 'a-2' }), 'uninitialized')
    await assert.rejects(read(s.ctx, 'a', 'project.yaml', { source: 'worktree' }), /several workspaces/)
  } finally { raw.workspaces.pop(); await writeFile(s.registry, JSON.stringify(raw, null, 2)) }
})

test('working tree: only when asked, labelled, never ignored files', async () => {
  await writeFile(join(s.dir, 'wedo', 'draft.md'), 'not committed\n')
  await writeFile(join(s.dir, '.local', 'note.md'), 'host\n').catch(async () => { await mkdir(join(s.dir, '.local'), { recursive: true }); await writeFile(join(s.dir, '.local', 'note.md'), 'host\n') })
  await assert.rejects(read(s.ctx, 'a', 'wedo/draft.md'), (e: unknown) => e instanceof AccessError && e.state === 'absent', 'committed by default: the uncommitted draft is not there')
  const w = await read(s.ctx, 'a', 'wedo/draft.md', { source: 'worktree' })
  assert.equal(w.text, 'not committed\n')
  assert.equal(w.provenance.source, 'worktree')
  assert.equal(w.provenance.workspace?.id, 'a')
  assert.equal(w.provenance.workspace?.dirty, true)
  const t = await tree(s.ctx, 'a', 'wedo', { source: 'worktree' })
  assert.deepEqual(t.entries.map(e => e.path), ['wedo/draft.md', 'wedo/knowledge.yaml'])
  await assert.rejects(read(s.ctx, 'a', '.local/note.md', { source: 'worktree' }), /host-local/)
  await writeFile(join(s.dir, '.gitignore'), '.local/\n*.secret\n')
  await writeFile(join(s.dir, 'wedo', 'x.secret'), 'nope\n')
  await assert.rejects(read(s.ctx, 'a', 'wedo/x.secret', { source: 'worktree' }), (e: unknown) => e instanceof AccessError && e.state === 'inaccessible')
  await rm(join(s.dir, 'wedo', 'draft.md')); await rm(join(s.dir, 'wedo', 'x.secret'))
  await gitOk(s.dir, ['checkout', '--', '.gitignore'])
})

test('execution: the live record beside the published snapshot; a run only on this host; files of either', async () => {
  const a = await completed('acc-run-0001', { 'app.txt': 'built\n' })
  await runOp(s.ws, a, { op: 'run.decide', decision: 'accepted', evidence: 'looked at it' }, { by: 'Test Person', via: 'browser' })
  await s.x.afterDecision(s.ws, a, 'accepted')
  await s.x.reconcile()
  const b = await completed('acc-run-0002', { 'other.txt': 'not accepted\n' })
  const before = await workspaceState()
  const l = await runs(s.ctx, 'a')
  const ra = l.runs.find(r => r.ref === 'ship/run-001')!
  assert.equal(ra.live?.place, 'run-copy')
  assert.equal(ra.live?.decision, 'accepted')
  assert.equal(ra.published?.commit, await head(s.remote), 'the snapshot integration brought to main')
  const rb = l.runs.find(r => r.ref === `${b.workflow}/${b.run}`)!
  assert.ok(rb.live && !rb.published, 'an unintegrated run exists only on this host')
  const v = await run(s.ctx, 'a', 'ship/run-001')
  const live = v.live!.record as { history: { op: string }[]; integrations?: unknown[] }
  const pub = v.published!.record as { integrations?: unknown[] }
  assert.equal(live.history.at(-1)!.op, 'run.integrate')
  assert.equal(pub.integrations, undefined, 'the snapshot on main is not the live record')
  assert.ok(v.live!.files.includes('run.json'))
  const pubOnly = await run(s.ctx, 'a', 'ship/run-001', { published: true })
  assert.equal(pubOnly.live, undefined)
  const f = await runFile(s.ctx, 'a', 'ship/run-001', 'braindump.md')
  assert.equal(f.provenance.source, 'live')
  assert.equal((await runFile(s.ctx, 'a', 'ship/run-001', 'braindump.md', { published: true })).provenance.source, 'committed')
  // Without a workspace the published records still answer.
  const reg = JSON.parse(await readFile(s.registry, 'utf8'))
  const saved = reg.workspaces
  reg.workspaces = []
  await writeFile(s.registry, JSON.stringify(reg, null, 2))
  try {
    const remote = await runs(s.ctx, 'a')
    assert.ok('unavailable' in remote.live)
    assert.deepEqual(remote.runs.map(r => [r.ref, !!r.live, !!r.published]), [['ship/run-001', false, true]])
    await assert.rejects(run(s.ctx, 'a', `${b.workflow}/${b.run}`), (e: unknown) => e instanceof AccessError && e.state === 'absent')
  } finally { reg.workspaces = saved; await writeFile(s.registry, JSON.stringify(reg, null, 2)) }
  assert.equal(await workspaceState(), before, 'reading runs changed nothing in the workspace')
})

test('search distinguishes an absent target from an existing target with no matches', async () => {
  for (const source of ['committed', 'worktree'] as const) {
    for (const path of ['missing-review-folder', 'wedo/missing.md', 'study/study-x/notes/missing.md']) {
      await assert.rejects(search(s.ctx, 'a', 'anything', path, { source }),
        (e: unknown) => e instanceof AccessError && e.state === 'absent')
    }
    for (const path of ['.', 'wedo', 'wedo/knowledge.yaml', 'study/study-x/notes']) {
      const r = await search(s.ctx, 'a', 'no-such-review-phrase', path, { source })
      assert.equal(r.total, 0)
      assert.deepEqual(r.matches, [])
    }
  }
})

test('run discovery keeps live records when published content cannot be read, with an explicit failure', async () => {
  const offline = { ...s.ctx, gitea: undefined, giteaProblem: 'review outage' }
  const unavailable: AccessContext = {
    ...s.ctx, area: join(root, 'no-access-cache'),
    gitea: { ...s.ctx.gitea!, repoById: async () => { throw new Error('Gitea unavailable') } },
  }
  for (const [ctx, state] of [[offline, 'inaccessible'], [unavailable, 'fetch-failed']] as const) {
    const r = await runs(ctx, 'a')
    assert.equal(r.provenance, undefined, 'no committed provenance is invented')
    assert.equal(r.publishedUnavailable?.state, state)
    assert.deepEqual(r.live, { workspace: 'a' })
    assert.ok(r.runs.some(r => r.ref === 'ship/run-001' && r.live))
    assert.ok(r.runs.every(r => !r.published))
    await assert.rejects(runs(ctx, 'a', { published: true }), (e: unknown) => e instanceof AccessError && e.state === state)
    await assert.rejects(runs(ctx, 'b'), (e: unknown) => e instanceof AccessError && e.state === state, 'no source is available for b')
  }
  await assert.rejects(runs(offline, 'unknown-project'), (e: unknown) => e instanceof AccessError && e.state === 'absent')
  const empty = await runs(offline, 'a', { workflow: 'no-runs' })
  assert.deepEqual(empty.runs, [])
  assert.equal(empty.publishedUnavailable?.state, 'inaccessible', 'an empty live list still discloses the failure')

  const { projectsCommand } = await import('../cli/projects.ts')
  let human = '', data: unknown
  assert.equal(await projectsCommand({
    positional: ['runs', 'a'], opt: () => undefined, flag: () => false,
    ctx: async () => offline, json: () => false, usage: m => new Error(m),
    out: (h, d) => { human = h; data = d },
  }), 0)
  assert.match(human, /Published records: unavailable \[inaccessible\]/)
  assert.match(human, /ship\/run-001/)
  assert.equal((data as Awaited<ReturnType<typeof runs>>).publishedUnavailable?.state, 'inaccessible')
})

test('the CLI reads with no project of its own; --json carries the failure state', async () => {
  const { main } = await import('../cli/wfe.ts')
  const out: string[] = []
  const log = console.log
  console.log = (...m: unknown[]) => { out.push(m.join(' ')) }
  // The CLI's Gitea is the registry's setting; the stand-in is reached through an env override.
  try {
    const code = await main(['projects', 'read', 'a', 'nope.md', '--json', '--registry', s.registry, '--area', s.area])
    assert.equal(code, 1)
    const body = JSON.parse(out.join('\n'))
    assert.equal(body.ok, false)
    assert.equal(body.detail.state, 'inaccessible', 'no Gitea setting beside this registry: committed content is inaccessible, and said so')
  } finally { console.log = log }
  const l = await locate(s.ctx, 'a', 'study/study-x')
  assert.deepEqual(l.chain.map(c => c.path), ['study/study-x'])
})

test('a guide of another managed project is read at claim from its committed default branch, by hash; an unreadable one refuses', async () => {
  const x = new ExecStore({ registryFile: s.registry, area: s.area, gitea: s.ctx.gitea as unknown as ConstructorParameters<typeof ExecStore>[0]['gitea'] })
  try {
    const rec = { executor: { name: 'archsage-agent', host: 't' }, workflow: 'w', run: 'run-001', input: { kind: 'braindump', file: 'braindump.md', author: 'P' }, control: {} } as unknown as Parameters<ExecStore['execution']>[1]
    const wf = (guides: string[]) => { const w = emptyWorkflow('w', 'W'); w.execution = { agent: 'archsage-agent', profile: '', guides }; return w }
    const ok = await x.execution(s.ws, rec, wf(['b:devdocs/README.md']), null, {})
    assert.ok(!('refused' in ok), JSON.stringify(ok))
    if ('refused' in ok) return
    const g = ok.context.sources.find(c => c.key === 'guide/b:devdocs/README.md')
    assert.ok(g && g.scope === 'workflow' && g.delivery === 'body', JSON.stringify(ok.context.sources))
    assert.match(g!.sha256 ?? '', /^[0-9a-f]{64}$/)
    assert.match(ok.context.text, /## Workflow default — guide b:devdocs\/README\.md \(b:devdocs\/README\.md, at [0-9a-f]{12}\)\n\nb devdocs/)
    const missing = await x.execution(s.ws, rec, wf(['b:agent/none.md']), null, {})
    assert.ok('refused' in missing && /guide\/b:agent\/none\.md: cannot be read from project b: .*does not exist/.test(missing.refused), JSON.stringify(missing))
    const unknown = await x.execution(s.ws, rec, wf(['nosuch:agent/g.md']), null, {})
    assert.ok('refused' in unknown && /not registered/.test(unknown.refused))
  } finally { x.close() }
})
