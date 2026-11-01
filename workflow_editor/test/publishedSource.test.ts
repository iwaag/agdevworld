// improve_wfrun p1: the published source. A workflow reaches the project's
// default branch on Gitea (as an integrated run puts it there) while the
// registered workspace stays where it was, is edited, or moves elsewhere.
// Listing and ordinary run creation read the published revision, resolved
// once to a root commit that both the definition and the run's copy come
// from; the workspace is never read for it and never changed. Step 1 of the
// episode reproduced the mismatch with this fixture before the fix.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessError, invalidate, show, type AccessContext, type RepoHost } from '../server/access.ts'
import { createProject } from '../server/create.ts'
import { gitOk, LOCAL_TRANSPORT } from '../server/git.ts'
import type { GiteaRepo } from '../server/gitea.ts'
import { publishedWorkflows, publishedWorkspace, resolvePublished } from '../server/published.ts'
import { loadRegistry } from '../server/registry.ts'
import { createRunInCopy, readRun } from '../server/runs.ts'
import { prepareCopy, readCopy } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-published-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const wf = (id: string, intent = 'Build it.', extra = '') => `schema: ag.workflow.v2
documentation: {policy: manual}
id: ${id}
name: ${id}
intent: |
  ${intent}
repositories:
  root: {path: ., access: editable}
${extra}nodes:
  build:
    type: do
    description: Build.
edges: []
`

// A Gitea stand-in that can be taken down.
const net = { down: false }
function stubHost(dir: string, repos: Record<number, [string, string]>): RepoHost {
  const info = (id: number, owner: string, name: string): GiteaRepo => ({ id, owner, name, fullName: `${owner}/${name}`, cloneUrl: join(dir, owner, `${name}.git`), htmlUrl: '', description: '', empty: false, defaultBranch: 'main', archived: false })
  const up = () => { if (net.down) throw new Error('connect ECONNREFUSED gitea.test') }
  return {
    url: 'http://gitea.test',
    cloneUrl: (o, n) => join(dir, o, `${n}.git`),
    gitEnv: async () => ({}),
    repoById: async id => { up(); return repos[id] ? info(id, ...repos[id]) : null },
    repo: async (o, n) => { up(); const hit = Object.entries(repos).find(([, [ow, nm]]) => ow === o && nm === n); return hit ? info(Number(hit[0]), o, n) : null },
  }
}

const head = (dir: string, ref = 'HEAD') => gitOk(dir, ['rev-parse', ref]).then(s => s.trim())
// Another clone pushes to main, as an integration does.
async function pushTo(bare: string, files: Record<string, string>, opts: { submodules?: boolean } = {}) {
  const other = join(root, `push-${Math.random().toString(36).slice(2, 8)}`)
  await gitOk(root, ['clone', '-q', ...(opts.submodules ? ['--recurse-submodules'] : []), bare, other], { config: LOCAL_TRANSPORT })
  for (const [p, t] of Object.entries(files)) { await mkdir(join(other, p, '..'), { recursive: true }); await writeFile(join(other, p), t) }
  await gitOk(other, ['add', '-A']); await gitOk(other, ['commit', '-q', '-m', 'integrated elsewhere']); await gitOk(other, ['push', '-q', 'origin', 'HEAD:main'])
  return other
}
async function bareRepo(path: string, files: Record<string, string>, subs: { path: string; url: string }[] = []) {
  const src = `${path}.src`
  await gitOk(root, ['init', '-q', src])
  for (const [p, t] of Object.entries(files)) { await mkdir(join(src, p, '..'), { recursive: true }); await writeFile(join(src, p), t) }
  for (const sm of subs) await gitOk(src, ['submodule', 'add', '-q', sm.url, sm.path], { config: LOCAL_TRANSPORT })
  await gitOk(src, ['add', '-A']); await gitOk(src, ['commit', '-q', '-m', 'start'])
  await gitOk(root, ['clone', '-q', '--bare', src, path])
}

let s: { area: string; gitea: string; registry: string; dir: string; remote: string; ctx: AccessContext; ws: Workspace; hdir: string; hws: Workspace; hDevdocs: string; hRemote: string }

// What published execution must never change: the workspace's refs, HEAD and status.
const workspaceState = async (dir: string) => [
  await gitOk(dir, ['for-each-ref', '--format=%(refname) %(objectname)']),
  await gitOk(dir, ['rev-parse', 'HEAD']), await gitOk(dir, ['symbolic-ref', '-q', 'HEAD']).catch(() => 'detached'),
  await gitOk(dir, ['status', '--porcelain=v1']),
].join('\n')

test('setup: project g (devdocs directory, a study with a nested module) and project h (devdocs submodule), each with a workspace and a Gitea remote', async () => {
  const area = join(root, 'area')
  const gitea = join(root, 'gitea')
  const registry = join(area, 'registry.json')
  await mkdir(join(gitea, 'dev'), { recursive: true })
  // A study the workspace never checks out, with a nested module of its own.
  await bareRepo(join(gitea, 'dev', 'inner.git'), { 'INNER.md': 'inner\n' })
  await bareRepo(join(gitea, 'dev', 'study-s.git'), { 'notes.md': 'study\n' }, [{ path: 'lib/inner', url: '../inner.git' }])
  const dir = join(area, 'pj-g')
  const c = await createProject({ dir, id: 'g', name: 'G', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(c.ok, c.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'freework.yaml'), wf('freework'))
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'freework'])
  const remote = join(gitea, 'dev', 'pj-g.git')
  await gitOk(gitea, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote]); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  // h: devdocs is its own repository, pinned by the root.
  await bareRepo(join(gitea, 'dev', 'pj-h-devdocs.git'), { 'workflows/freework.yaml': wf('freework') })
  const hRemote = join(gitea, 'dev', 'pj-h.git')
  const hSrc = join(root, 'h-src')
  await gitOk(root, ['init', '-q', hSrc])
  await gitOk(hSrc, ['remote', 'add', 'origin', hRemote])
  await writeFile(join(hSrc, 'project.yaml'), 'schema: ag.project.v2\nid: h\nname: H\ndevdocs: submodule\nintent: x\ngoals: []\n')
  await writeFile(join(hSrc, '.gitignore'), '.local/\n')
  await gitOk(hSrc, ['submodule', 'add', '-q', '../pj-h-devdocs.git', 'devdocs'], { config: LOCAL_TRANSPORT })
  await gitOk(hSrc, ['add', '-A']); await gitOk(hSrc, ['commit', '-q', '-m', 'h'])
  await gitOk(root, ['clone', '-q', '--bare', hSrc, hRemote])
  const hdir = join(area, 'pj-h')
  await gitOk(root, ['clone', '-q', '--recurse-submodules', hRemote, hdir], { config: LOCAL_TRANSPORT })
  const raw = JSON.parse(await readFile(registry, 'utf8'))
  raw.workspaces[0].project = 'g'
  raw.workspaces.push({ id: 'h', label: 'H', host: raw.workspaces[0].host, path: hdir, project: 'h' })
  raw.repositories = [
    { gitea: { id: 1, owner: 'dev', name: 'pj-g' }, category: 'root', description: '' },
    { gitea: { id: 2, owner: 'dev', name: 'pj-h' }, category: 'root', description: '' },
    { gitea: { id: 3, owner: 'dev', name: 'pj-h-devdocs' }, category: 'devdocs', description: '' },
    { gitea: { id: 4, owner: 'dev', name: 'study-s' }, category: 'study', description: '' },
    { gitea: { id: 5, owner: 'dev', name: 'inner' }, category: 'other', description: '' },
    { gitea: { id: 6, owner: 'dev', name: 'pj-n' }, category: 'root', description: '' },
  ]
  raw.projects = [{ id: 'g', root: 'gitea:1' }, { id: 'h', root: 'gitea:2' }, { id: 'n', root: 'gitea:6' }]
  await writeFile(registry, JSON.stringify(raw, null, 2))
  await bareRepo(join(gitea, 'dev', 'pj-n.git'), { 'project.yaml': 'schema: ag.project.v2\nid: n\nname: N\ndevdocs: directory\nintent: x\ngoals: []\n', 'devdocs/workflows/freework.yaml': wf('freework') })
  const ctx: AccessContext = { registryFile: registry, area, gitea: stubHost(gitea, { 1: ['dev', 'pj-g'], 2: ['dev', 'pj-h'], 3: ['dev', 'pj-h-devdocs'], 4: ['dev', 'study-s'], 5: ['dev', 'inner'], 6: ['dev', 'pj-n'] }), fetchTtlMs: 0 }
  const regs = (await loadRegistry(registry)).workspaces
  s = { area, gitea, registry, dir, remote, ctx, ws: new Workspace(regs.find(w => w.id === 'g')!), hdir, hws: new Workspace(regs.find(w => w.id === 'h')!), hDevdocs: join(gitea, 'dev', 'pj-h-devdocs.git'), hRemote }
})

const request = (ws: Workspace, workflow: string, receipt: string, o: { rev?: string } = {}) => createRunInCopy(ws, {
  workflow, receipt, executor: { host: 'autolab' }, by: 'Test Person', via: 'cli', access: s.ctx, ...o,
  input: { kind: 'braindump', text: 'Do the thing.', author: 'Test Person' },
})
const frozenAndCode = async (ws: Workspace, created: Awaited<ReturnType<typeof request>>, file: string) => {
  const copy = (await readCopy(ws, created.ref))!
  return {
    copy, manifest: copy.manifest!,
    frozen: await readFile(join(copy.tree, created.dir, 'definition', file), 'utf8'),
    code: await readFile(join(copy.tree, 'devdocs', 'workflows', file), 'utf8'),
  }
}

test('stale workspace: the published list and run creation see a workflow the workspace lacks, without moving it', async () => {
  const before = await workspaceState(s.dir)
  await pushTo(s.remote, { 'devdocs/workflows/partial-animation.yaml': wf('partial-animation'), 'devdocs/workflows/freework.yaml': wf('freework', 'Published intent.') })
  const published = await head(s.remote, 'main')
  assert.deepEqual((await show(s.ctx, 'g')).workflows.map(w => w.id).sort(), ['freework', 'partial-animation'], 'wfe projects show')
  const list = await publishedWorkflows(s.ctx, 'g')
  assert.deepEqual(list.workflows.map(w => w.id), ['freework', 'partial-animation'], 'the published list (editor, intake, delegation)')
  assert.equal(list.source.commit, published)
  assert.equal(list.source.selector, 'default-branch')
  assert.equal(list.source.fetch.state, 'fresh')
  assert.deepEqual((await s.ws.workflowSummaries()).list.map(w => w.id), ['freework'], 'the workspace (editing view) is still as it was')
  const created = await request(s.ws, 'partial-animation', 'published-0001')
  assert.deepEqual(created.record.definition.source, {
    kind: 'published', project: 'g', selector: 'default-branch', repository: 'dev/pj-g', branch: 'main', commit: published,
    definitions: { path: 'devdocs/workflows', repository: 'dev/pj-g', commit: published }, fetch: created.record.definition.source!.kind === 'published' ? created.record.definition.source!.fetch : { state: '', at: '' },
  })
  const { manifest } = await frozenAndCode(s.ws, created, 'partial-animation.yaml')
  assert.equal(manifest.baseFrom, 'published')
  assert.deepEqual(manifest.source, { project: 'g', repository: 'dev/pj-g', branch: 'main', commit: published, selector: 'default-branch' })
  assert.equal(manifest.repositories[0].base, published)
  assert.equal(created.record.storage?.repositories[0].target, 'main')
  assert.equal(await workspaceState(s.dir), before, 'the workspace is unchanged: refs, HEAD, status')
})

test('one revision: the frozen definition and the copy\'s code come from the same commit', async () => {
  const created = await request(s.ws, 'freework', 'published-0002')
  const { frozen, code, manifest } = await frozenAndCode(s.ws, created, 'freework.yaml')
  assert.match(frozen, /Published intent\./)
  assert.equal(frozen, code)
  assert.equal(manifest.repositories[0].base, created.record.definition.source!.kind === 'published' && created.record.definition.source!.commit)
})

test('dirty, ahead and diverged workspace: published execution uses the remote revision; the editing files, refs and changes stay', async () => {
  // Dirty: an uncommitted edit of the definition.
  await writeFile(join(s.dir, 'devdocs', 'workflows', 'freework.yaml'), wf('freework', 'An uncommitted edit.'))
  // Ahead and diverged: a local commit on an editing branch, not pushed.
  await gitOk(s.dir, ['checkout', '-q', '-b', 'editing'])
  await writeFile(join(s.dir, 'NOTES.md'), 'local only\n')
  await gitOk(s.dir, ['add', 'NOTES.md']); await gitOk(s.dir, ['commit', '-q', '-m', 'local'])
  const before = await workspaceState(s.dir)
  const created = await request(s.ws, 'freework', 'published-0003')
  const { frozen, code, manifest, copy } = await frozenAndCode(s.ws, created, 'freework.yaml')
  assert.match(frozen, /Published intent\./, 'not the uncommitted edit')
  assert.equal(frozen, code)
  assert.equal(manifest.repositories[0].base, await head(s.remote, 'main'), 'not the local commit')
  assert.equal(manifest.repositories[0].target, 'main', 'integration targets the published branch, not the editing one')
  await assert.rejects(readFile(join(copy.tree, 'NOTES.md'), 'utf8'), /ENOENT/)
  assert.equal(await workspaceState(s.dir), before)
  assert.match(await readFile(join(s.dir, 'devdocs', 'workflows', 'freework.yaml'), 'utf8'), /An uncommitted edit\./)
  await gitOk(s.dir, ['checkout', '-q', '--', 'devdocs/workflows/freework.yaml'])
  await gitOk(s.dir, ['checkout', '-q', 'main'])
})

test('no fallback: a workflow only the workspace has is not started; a missing or invalid published one is refused with its reason', async () => {
  await writeFile(join(s.dir, 'devdocs', 'workflows', 'local-only.yaml'), wf('local-only'))
  await assert.rejects(request(s.ws, 'local-only', 'published-0004'), /no workflow "local-only" in devdocs\/workflows/)
  await rm(join(s.dir, 'devdocs', 'workflows', 'local-only.yaml'))
  await pushTo(s.remote, { 'devdocs/workflows/broken.yaml': wf('broken').replace('edges: []', 'edges:\n  - {from: build, to: nowhere}') })
  await assert.rejects(request(s.ws, 'broken', 'published-0005'), (e: Error & { status?: number }) => e.status === 409 && /validation errors/.test(e.message))
})

test('revision race: a retried request keeps the revision its copy was reserved with; an explicit revision is honoured for definition and code', async () => {
  const c1 = await head(s.remote, 'main')
  // A request reserved and made its copy, then crashed before run.json.
  const src = await resolvePublished(s.ctx, 'g', { fresh: true })
  await prepareCopy(s.ws, { project: 'g', workflow: 'freework', receipt: 'request:published-0006', published: { ctx: s.ctx, source: src } })
  await pushTo(s.remote, { 'devdocs/workflows/freework.yaml': wf('freework', 'Changed after the reservation.') })
  const c2 = await head(s.remote, 'main')
  assert.notEqual(c1, c2)
  const retried = await request(s.ws, 'freework', 'request:published-0006')
  const r = await frozenAndCode(s.ws, retried, 'freework.yaml')
  assert.equal(retried.record.definition.source!.kind === 'published' && retried.record.definition.source!.commit, c1)
  assert.equal(r.manifest.repositories[0].base, c1)
  assert.match(r.frozen, /Published intent\./)
  assert.equal(r.frozen, r.code)
  // The same request once more: the same run.
  const again = await request(s.ws, 'freework', 'request:published-0006')
  assert.deepEqual(again.ref, retried.ref)
  assert.equal(again.existing, true)
  // A named revision (a delegation's dispatched one) after the remote moved on.
  const pinned = await request(s.ws, 'freework', 'published-0007', { rev: c1 })
  const p = await frozenAndCode(s.ws, pinned, 'freework.yaml')
  assert.equal(p.manifest.repositories[0].base, c1)
  assert.equal(pinned.record.definition.source!.kind === 'published' && pinned.record.definition.source!.selector, 'commit')
  assert.equal(p.frozen, p.code)
  // And without one: the new default branch, for both.
  const fresh = await request(s.ws, 'freework', 'published-0008')
  const f = await frozenAndCode(s.ws, fresh, 'freework.yaml')
  assert.equal(f.manifest.repositories[0].base, c2)
  assert.match(f.frozen, /Changed after the reservation\./)
  assert.equal(f.frozen, f.code)
})

test('submodules: the copy has every module the root pins — one absent from the workspace, and its nested module — at the pins', async () => {
  const other = join(root, 'g-study')
  await gitOk(root, ['clone', '-q', s.remote, other])
  await gitOk(other, ['submodule', 'add', '-q', '../study-s.git', 'study/study-s'], { config: LOCAL_TRANSPORT })
  await writeFile(join(other, 'devdocs', 'workflows', 'study.yaml'), wf('study', 'Read the study.', '  study: {path: study/study-s, access: readonly}\n'))
  await gitOk(other, ['add', '-A']); await gitOk(other, ['commit', '-q', '-m', 'study']); await gitOk(other, ['push', '-q', 'origin', 'HEAD:main'])
  const studyPin = await head(join(other, 'study', 'study-s'))
  const innerPin = (await gitOk(join(other, 'study', 'study-s'), ['ls-tree', 'HEAD', 'lib/inner'])).split(/\s+/)[2]
  assert.equal((await s.ws.submodulePaths()).length, 0, 'the workspace has not even heard of the study')
  const created = await request(s.ws, 'study', 'published-0009')
  const { manifest, copy } = await frozenAndCode(s.ws, created, 'study.yaml')
  const byPath = Object.fromEntries(manifest.repositories.map(r => [r.path, r]))
  assert.equal(byPath['study/study-s'].initialized, true)
  assert.equal(byPath['study/study-s'].base, studyPin)
  assert.equal(byPath['study/study-s'].target, 'main')
  assert.equal(byPath['study/study-s/lib/inner'].initialized, true)
  assert.equal(byPath['study/study-s/lib/inner'].base, innerPin)
  assert.equal(await head(join(copy.tree, 'study', 'study-s', 'lib', 'inner')), innerPin)
  assert.match(await readFile(join(copy.tree, 'study', 'study-s', 'lib', 'inner', 'INNER.md'), 'utf8'), /inner/)
  assert.deepEqual(created.record.storage!.repositories.map(r => r.path), ['.', 'study/study-s', 'study/study-s/lib/inner'])
  assert.equal((await s.ws.submodulePaths()).length, 0, 'the workspace is still untouched')
})

test('devdocs as a submodule: definitions are read at the root\'s pin, and the run copy has devdocs at it', async () => {
  const other = await pushTo(s.hDevdocs, { 'workflows/partial-animation.yaml': wf('partial-animation') })
  const bump = join(root, 'h-bump')
  await gitOk(root, ['clone', '-q', '--recurse-submodules', s.hRemote, bump], { config: LOCAL_TRANSPORT })
  await gitOk(join(bump, 'devdocs'), ['fetch', '-q', 'origin'], { config: LOCAL_TRANSPORT })
  await gitOk(join(bump, 'devdocs'), ['checkout', '-q', await head(other)])
  await gitOk(bump, ['add', 'devdocs']); await gitOk(bump, ['commit', '-q', '-m', 'pin devdocs']); await gitOk(bump, ['push', '-q', 'origin', 'HEAD:main'])
  // Unpinned work on devdocs' own main is not published for h.
  await pushTo(s.hDevdocs, { 'workflows/unpinned.yaml': wf('unpinned') })
  const list = await publishedWorkflows(s.ctx, 'h')
  assert.deepEqual(list.workflows.map(w => w.id), ['freework', 'partial-animation'])
  assert.deepEqual(list.source.definitions, { path: 'devdocs/workflows', repository: 'dev/pj-h-devdocs', commit: await head(other) })
  assert.deepEqual((await s.hws.workflowSummaries()).list.map(w => w.id), ['freework'], 'the stale workspace')
  const created = await request(s.hws, 'partial-animation', 'published-0010')
  const m = (await readCopy(s.hws, created.ref))!.manifest!
  assert.equal(m.repositories.find(r => r.path === 'devdocs')!.base, await head(other))
  await assert.rejects(request(s.hws, 'unpinned', 'published-0011'), /no workflow "unpinned"/)
})

test('live discovery: an integration marks the caches due, so a new workflow is not hidden by the discovery window', async () => {
  const slow: AccessContext = { ...s.ctx, fetchTtlMs: 60_000 }
  await publishedWorkspace(slow, s.ws.reg, { discovery: true }) // fills the window
  await pushTo(s.remote, { 'devdocs/workflows/late.yaml': wf('late') })
  const within = await (await publishedWorkspace(slow, s.ws.reg, { discovery: true })).workflowSummaries()
  assert.ok(!within.list.some(w => w.id === 'late'), 'inside the window the cache is read, labelled recent')
  assert.deepEqual(await invalidate(slow, 'g'), ['gitea:1', 'gitea:4'], 'the root and the study it uses')
  const after = await publishedWorkspace(slow, s.ws.reg, { discovery: true })
  assert.ok((await after.workflowSummaries()).list.some(w => w.id === 'late'))
  assert.equal(after.source.fetch.state, 'fresh')
})

test('source failure: a stale cache is labelled for discovery and refused for execution; nothing cached is a failure, not an empty list', async () => {
  net.down = true
  try {
    const list = await publishedWorkflows(s.ctx, 'g')
    assert.equal(list.source.fetch.state, 'stale', 'discovery shows the cached revision, said to be stale')
    assert.match(list.source.fetch.error ?? '', /ECONNREFUSED/)
    await assert.rejects(request(s.ws, 'freework', 'published-0012'), (e: Error) => e instanceof AccessError && e.state === 'fetch-failed' && /not known to be the default branch now/.test(e.message))
    // A known revision is still usable, named explicitly.
    const named = await request(s.ws, 'freework', 'published-0013', { rev: list.source.commit })
    assert.equal(named.record.definition.source!.kind === 'published' && named.record.definition.source!.commit, list.source.commit)
    await assert.rejects(publishedWorkflows(s.ctx, 'n'), (e: Error) => e instanceof AccessError && e.state === 'fetch-failed')
  } finally { net.down = false }
})

test('existing runs keep their frozen definitions when the published source moves on', async () => {
  const created = await request(s.ws, 'freework', 'published-0014')
  const before = await readFile(join((await readCopy(s.ws, created.ref))!.tree, created.dir, 'definition', 'freework.yaml'), 'utf8')
  await pushTo(s.remote, { 'devdocs/workflows/freework.yaml': wf('freework', 'Later still.') })
  const copy = (await readCopy(s.ws, created.ref))!
  const reading = await readRun(new Workspace({ ...s.ws.reg, path: copy.tree }, { shared: s.ws, ref: created.ref }), created.ref)
  assert.equal(reading.bundle.entries.freework.text, before)
  assert.deepEqual(reading.record!.definition.source, created.record.definition.source)
})

test('without Gitea access a run follows the workspace and says so', async () => {
  const created = await createRunInCopy(s.ws, { workflow: 'freework', receipt: 'published-0015', executor: { host: 'autolab' }, by: 'Test Person', via: 'cli', input: { kind: 'braindump', text: 'x', author: 'Test Person' } })
  const src = created.record.definition.source!
  assert.equal(src.kind, 'workspace')
  assert.match(src.kind === 'workspace' ? src.reason : '', /no published source is configured/)
})
