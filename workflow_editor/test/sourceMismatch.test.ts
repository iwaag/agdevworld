// improve_wfrun p1 step 1: the source mismatch, reproduced before the fix.
// A workflow reaches the project's default branch on Gitea (as an integrated
// run puts it there) while the registered workspace stays where it was. The
// committed reader (wfe projects show) sees it; the editor's list and run
// creation read the workspace and do not; and a run of an existing workflow
// follows the workspace's definition on top of the upstream's code.
// These assertions describe the behaviour before improve_wfrun p1; step 2
// replaces them with the published-source contract.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { show, type AccessContext, type RepoHost } from '../server/access.ts'
import { createProject } from '../server/create.ts'
import { gitOk, LOCAL_TRANSPORT } from '../server/git.ts'
import type { GiteaRepo } from '../server/gitea.ts'
import { loadRegistry } from '../server/registry.ts'
import { createRunInCopy } from '../server/runs.ts'
import { readCopy } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-mismatch-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const wf = (id: string, intent = 'Build it.') => `schema: ag.workflow.v2
documentation: {policy: manual}
id: ${id}
name: ${id}
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
    url: 'http://gitea.test',
    cloneUrl: (o, n) => join(dir, o, `${n}.git`),
    gitEnv: async () => ({}),
    repoById: async id => (repos[id] ? info(id, ...repos[id]) : null),
    repo: async (o, n) => { const hit = Object.entries(repos).find(([, [ow, nm]]) => ow === o && nm === n); return hit ? info(Number(hit[0]), o, n) : null },
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

let s: { area: string; gitea: string; registry: string; dir: string; remote: string; ctx: AccessContext; ws: Workspace; hdir: string; hws: Workspace; hDevdocs: string; hRemote: string }

test('setup: project g (devdocs directory) and project h (devdocs submodule), each with a workspace and a Gitea remote', async () => {
  const area = join(root, 'area')
  const gitea = join(root, 'gitea')
  const registry = join(area, 'registry.json')
  await mkdir(join(gitea, 'dev'), { recursive: true })
  const dir = join(area, 'pj-g')
  const c = await createProject({ dir, id: 'g', name: 'G', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(c.ok, c.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'freework.yaml'), wf('freework'))
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'freework'])
  const remote = join(gitea, 'dev', 'pj-g.git')
  await gitOk(gitea, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote]); await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  // h: devdocs is its own repository, pinned by the root.
  const hDevdocsSrc = join(root, 'h-devdocs-src')
  await gitOk(root, ['init', '-q', hDevdocsSrc])
  await mkdir(join(hDevdocsSrc, 'workflows'), { recursive: true })
  await writeFile(join(hDevdocsSrc, 'workflows', 'freework.yaml'), wf('freework'))
  await gitOk(hDevdocsSrc, ['add', '-A']); await gitOk(hDevdocsSrc, ['commit', '-q', '-m', 'devdocs'])
  const hDevdocs = join(gitea, 'dev', 'pj-h-devdocs.git')
  await gitOk(root, ['clone', '-q', '--bare', hDevdocsSrc, hDevdocs])
  const hSrc = join(root, 'h-src')
  await gitOk(root, ['init', '-q', hSrc])
  await writeFile(join(hSrc, 'project.yaml'), 'schema: ag.project.v2\nid: h\nname: H\ndevdocs: submodule\nintent: x\ngoals: []\n')
  await writeFile(join(hSrc, '.gitignore'), '.local/\n')
  await gitOk(hSrc, ['submodule', 'add', '-q', '../pj-h-devdocs.git', 'devdocs'], { config: LOCAL_TRANSPORT, env: {} }).catch(async () => {
    // A relative URL resolves against the superproject's origin, which a fresh
    // repository lacks: point it at the bare one first.
    await gitOk(hSrc, ['remote', 'add', 'origin', join(gitea, 'dev', 'pj-h.git')])
    await gitOk(hSrc, ['submodule', 'add', '-q', '../pj-h-devdocs.git', 'devdocs'], { config: LOCAL_TRANSPORT })
  })
  await gitOk(hSrc, ['add', '-A']); await gitOk(hSrc, ['commit', '-q', '-m', 'h'])
  const hRemote = join(gitea, 'dev', 'pj-h.git')
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
  ]
  raw.projects = [{ id: 'g', root: 'gitea:1' }, { id: 'h', root: 'gitea:2' }]
  await writeFile(registry, JSON.stringify(raw, null, 2))
  const ctx: AccessContext = { registryFile: registry, area, gitea: stubHost(gitea, { 1: ['dev', 'pj-g'], 2: ['dev', 'pj-h'], 3: ['dev', 'pj-h-devdocs'] }), fetchTtlMs: 0 }
  const regs = (await loadRegistry(registry)).workspaces
  s = { area, gitea, registry, dir, remote, ctx, ws: new Workspace(regs.find(w => w.id === 'g')!), hdir, hws: new Workspace(regs.find(w => w.id === 'h')!), hDevdocs, hRemote }
})

const request = (ws: Workspace, workflow: string, receipt: string) => createRunInCopy(ws, {
  workflow, receipt, executor: { host: 'autolab' }, by: 'Test Person', via: 'cli',
  input: { kind: 'braindump', text: 'Do the thing.', author: 'Test Person' },
})

test('stale workspace: the committed reader sees the new workflow, the editor list and run creation do not', async () => {
  const before = await head(s.dir)
  await pushTo(s.remote, { 'devdocs/workflows/partial-animation.yaml': wf('partial-animation'), 'devdocs/workflows/freework.yaml': wf('freework', 'Published intent.') })
  const committed = await show(s.ctx, 'g')
  assert.deepEqual(committed.workflows.map(w => w.id).sort(), ['freework', 'partial-animation'], 'wfe projects show reads Gitea main')
  assert.equal(committed.workspaces[0].atCommitted, false)
  const editor = await s.ws.workflowSummaries()
  assert.deepEqual(editor.list.map(w => w.id), ['freework'], 'the editor list reads the workspace working tree')
  await assert.rejects(request(s.ws, 'partial-animation', 'mismatch-0001'), /no workflow "partial-animation" in devdocs\/workflows/, 'run creation reads the workspace too')
  assert.equal(await head(s.dir), before, 'nothing moved the workspace')
})

test('mixed sources: an existing workflow runs the workspace definition on top of the upstream code', async () => {
  const created = await request(s.ws, 'freework', 'mismatch-0002')
  const copy = (await readCopy(s.ws, created.ref))!
  assert.equal(copy.manifest!.baseFrom, 'upstream')
  assert.equal(copy.manifest!.repositories[0].base, await head(s.remote, 'main'))
  const frozen = await readFile(join(copy.tree, created.dir, 'definition', 'freework.yaml'), 'utf8')
  const inCode = await readFile(join(copy.tree, 'devdocs', 'workflows', 'freework.yaml'), 'utf8')
  assert.match(frozen, /Build it\./, 'the definition is the workspace\'s')
  assert.match(inCode, /Published intent\./, 'the code tree is the upstream\'s')
  assert.equal(created.record.definition.workflows.freework.source, 'devdocs/workflows/freework.yaml')
  assert.equal((created.record.definition as { source?: unknown }).source, undefined, 'the record does not say which revision the definition came from')
})

test('dirty workspace: uncommitted definition bytes become the run definition', async () => {
  await gitOk(s.dir, ['pull', '-q', '--ff-only'])
  await writeFile(join(s.dir, 'devdocs', 'workflows', 'freework.yaml'), wf('freework', 'An uncommitted edit.'))
  const created = await request(s.ws, 'freework', 'mismatch-0003')
  const copy = (await readCopy(s.ws, created.ref))!
  assert.match(await readFile(join(copy.tree, created.dir, 'definition', 'freework.yaml'), 'utf8'), /An uncommitted edit\./)
  assert.match(await readFile(join(copy.tree, 'devdocs', 'workflows', 'freework.yaml'), 'utf8'), /Published intent\./)
  await gitOk(s.dir, ['checkout', '-q', '--', 'devdocs/workflows/freework.yaml'])
})

test('ahead workspace: an unpushed local commit becomes the run base and its integration target is the editing branch', async () => {
  await gitOk(s.dir, ['checkout', '-q', '-b', 'editing'])
  await writeFile(join(s.dir, 'NOTES.md'), 'local only\n')
  await gitOk(s.dir, ['add', '-A']); await gitOk(s.dir, ['commit', '-q', '-m', 'local'])
  const created = await request(s.ws, 'freework', 'mismatch-0004')
  const m = (await readCopy(s.ws, created.ref))!.manifest!
  assert.equal(m.baseFrom, 'workspace')
  assert.equal(m.repositories[0].base, await head(s.dir))
  assert.equal(m.repositories[0].target, 'editing', 'integration would go to the editing branch, not the published one')
  await gitOk(s.dir, ['checkout', '-q', 'main'])
})

test('devdocs as a submodule: a workflow pinned by the published root is missing from a stale workspace', async () => {
  const other = await pushTo(s.hDevdocs, { 'workflows/partial-animation.yaml': wf('partial-animation') })
  // The root pins the new devdocs commit (as integrating a run's devdocs does).
  const bump = join(root, 'h-bump')
  await gitOk(root, ['clone', '-q', '--recurse-submodules', s.hRemote, bump], { config: LOCAL_TRANSPORT })
  await gitOk(join(bump, 'devdocs'), ['fetch', '-q', 'origin'], { config: LOCAL_TRANSPORT })
  await gitOk(join(bump, 'devdocs'), ['checkout', '-q', await head(other)])
  await gitOk(bump, ['add', 'devdocs']); await gitOk(bump, ['commit', '-q', '-m', 'pin devdocs']); await gitOk(bump, ['push', '-q', 'origin', 'HEAD:main'])
  const committed = await show(s.ctx, 'h')
  assert.deepEqual(committed.workflows.map(w => w.id).sort(), ['freework', 'partial-animation'])
  assert.deepEqual((await s.hws.workflowSummaries()).list.map(w => w.id), ['freework'])
  await assert.rejects(request(s.hws, 'partial-animation', 'mismatch-0005'), /no workflow "partial-animation"/)
})
