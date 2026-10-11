// pre1 step 2: project creation, registration, the registry's states, the
// service's setup routes and the CLI, on real Git repositories in a
// temporary directory. Git identity comes from a temporary global config.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { approvalStates } from '../shared/canonical.ts'
import { autoArrange } from '../shared/layout.ts'
import { createHandler } from '../server/api.ts'
import { createProject } from '../server/create.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry, registerWorkspace, RegistryError } from '../server/registry.ts'
import { Workspace } from '../server/workspace.ts'
import { parseWorkflow } from '../server/yamlDoc.ts'

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let root = ''
let area = ''
let registry = ''

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-setup-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = test.person@example.invalid\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[k]
  area = join(root, 'area')
  registry = join(area, 'registry.json')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const exists = (p: string) => stat(p).then(() => true, () => false)
const opts = (id: string, extra: Partial<Parameters<typeof createProject>[0]> = {}) => ({
  dir: join(area, `pj-${id}`), id, name: `Project ${id}`, intent: 'Why it exists.\nSecond line.', goals: ['First goal.', 'Second goal.'],
  sourcesDir: join(area, 'sources'), registryFile: registry, devdocs: 'submodule' as const, ...extra,
})

test('a missing registry is empty; a malformed one is an error naming the file', async () => {
  assert.deepEqual(await loadRegistry(join(root, 'none.json')), { approver: '', workspaces: [], projects: [], repositories: [], exists: false })
  const bad = join(root, 'bad.json')
  await writeFile(bad, '{"workspaces": [')
  await assert.rejects(loadRegistry(bad), (e: Error) => e instanceof RegistryError && e.message.includes(bad))
  await writeFile(bad, '{"workspaces": [{"id": "x"}]}')
  await assert.rejects(loadRegistry(bad), /workspaces\[0\] needs text "id" and "path"/)
})

test('create: a new project from an empty area, with real submodule and two commits by the person', async () => {
  const r = await createProject(opts('alpha'))
  assert.ok(r.ok, r.message)
  const dir = join(area, 'pj-alpha')
  assert.equal(r.workspace, 'alpha')
  assert.deepEqual(r.commits.map(c => c.message), ['Initialize devdocs for alpha', 'Create project alpha'])
  assert.equal(await readFile(join(dir, '.gitmodules'), 'utf8'), '[submodule "devdocs"]\n\tpath = devdocs\n\turl = ../sources/alpha-devdocs.git\n')
  assert.match(await readFile(join(dir, '.gitignore'), 'utf8'), /^\.local\/$/m)
  assert.ok(await exists(join(dir, '.local')))
  assert.ok(await exists(join(dir, 'devdocs', '.git')))
  assert.ok(await exists(join(dir, 'devdocs', 'workflows')))
  const project = await readFile(join(dir, 'project.yaml'), 'utf8')
  assert.match(project, /^id: alpha$/m)
  assert.match(project, /^intent: \|-?\n {2}Why it exists\.\n {2}Second line\.$/m)
  assert.match(project, /^goals:\n {2}- First goal\.\n {2}- Second goal\.$/m)
  assert.equal((await gitOk(dir, ['log', '--format=%an <%ae>|%s'])).trim(), 'Test Person <test.person@example.invalid>|Create project alpha')
  assert.equal((await gitOk(dir, ['status', '--porcelain'])).trim(), '', 'nothing left uncommitted')
  assert.match(await gitOk(dir, ['ls-tree', 'HEAD', 'devdocs']), /^160000 commit /)
  assert.equal(await exists(join(dir, '.local', 'wfe-create.json')), false, 'the marker is removed at the end')
  const reg = await loadRegistry(registry)
  assert.deepEqual(reg.workspaces.map(w => [w.id, w.label]), [['alpha', 'Project alpha']])
  const st = await new Workspace(reg.workspaces[0]).structure()
  assert.deepEqual(st.diagnostics, [])
})

test('create: refuses an occupied destination and an existing source without touching them', async () => {
  const before = await readFile(join(area, 'pj-alpha', 'project.yaml'), 'utf8')
  const again = await createProject(opts('alpha'))
  assert.equal(again.ok, false)
  assert.match(again.message, /not empty/)
  assert.equal(await readFile(join(area, 'pj-alpha', 'project.yaml'), 'utf8'), before)
  const other = await createProject(opts('alpha', { dir: join(area, 'pj-alpha-2') }))
  assert.equal(other.ok, false)
  assert.match(other.message, /alpha-devdocs\.git already exists/)
  assert.equal((await loadRegistry(registry)).workspaces.length, 1)
})

test('create: a missing Git identity stops before anything is written', async () => {
  const r = await createProject(opts('nobody', { env: { GIT_CONFIG_GLOBAL: join(root, 'empty-config') } }))
  assert.equal(r.ok, false)
  assert.match(r.message, /no user\.name configured/)
  assert.equal(await exists(join(area, 'pj-nobody')), false)
  assert.equal(await exists(join(area, 'sources', 'nobody-devdocs.git')), false)
})

test('create: a creation stopped partway is reported, refused without resume, and continued with it', async () => {
  const stopped = await createProject(opts('beta', { failAfter: 'files' }))
  assert.equal(stopped.ok, false)
  assert.equal(stopped.resumable, true)
  assert.deepEqual(stopped.steps.map(s => s.name), ['destination', 'devdocs source', 'root repository', 'project.yaml', '.gitignore', 'stopped'])
  assert.match(stopped.message, /Nothing was rolled back/)
  const dir = join(area, 'pj-beta')
  await writeFile(join(dir, 'NOTES.md'), 'the person wrote this meanwhile\n')
  const refused = await createProject(opts('beta'))
  assert.equal(refused.ok, false)
  assert.equal(refused.resumable, true)
  const resumed = await createProject(opts('beta', { resume: true }))
  assert.ok(resumed.ok, resumed.message)
  assert.deepEqual(resumed.steps.filter(s => s.status === 'kept').map(s => s.name), ['destination', 'devdocs source', 'root repository', 'project.yaml', '.gitignore'])
  assert.equal(await readFile(join(dir, 'NOTES.md'), 'utf8'), 'the person wrote this meanwhile\n', 'unrelated work is kept')
  assert.match(await gitOk(dir, ['status', '--porcelain']), /^\?\? NOTES\.md$/m, 'and not committed for them')
  assert.deepEqual((await loadRegistry(registry)).workspaces.map(w => w.id), ['alpha', 'beta'])
})

test('create: an explicitly supplied existing devdocs source', async () => {
  const r = await createProject(opts('gamma', { devdocsSource: join(area, 'sources', 'alpha-devdocs.git') }))
  assert.ok(r.ok, r.message)
  assert.equal(r.commits.length, 1, 'only the root commit; the existing source is not changed')
  assert.match(await readFile(join(area, 'pj-gamma', '.gitmodules'), 'utf8'), /url = \.\.\/sources\/alpha-devdocs\.git/)
})

test('register: records the Git root, is idempotent, keeps other entries, and diagnoses incomplete projects', async () => {
  const raw = JSON.parse(await readFile(registry, 'utf8'))
  raw.note = 'kept'
  raw.workspaces.push({ id: 'elsewhere', label: 'Unrelated', host: 'another machine', path: '/nonexistent/elsewhere' })
  await writeFile(registry, JSON.stringify(raw))
  // An existing plain Git repository with only a project.yaml.
  const bare = join(root, 'plain')
  await mkdir(join(bare, 'sub'), { recursive: true })
  await gitOk(bare, ['init'])
  await writeFile(join(bare, 'project.yaml'), 'schema: ag.project.v1\nid: plain\nname: Plain\nintent: x\ngoals: []\n')
  const r = await registerWorkspace(registry, join(bare, 'sub'))
  assert.equal(r.status, 'registered')
  assert.equal(r.registration!.path, await gitOk(bare, ['rev-parse', '--show-toplevel']).then(s => s.trim()))
  assert.deepEqual(r.diagnostics.map(d => d.code).sort(), ['devdocs-missing', 'devdocs-mode-undeclared', 'gitignore-local', 'project-schema'], 'an old-format project.yaml is reported, not read as current')
  assert.ok(r.diagnostics.every(d => d.fix))
  const again = await registerWorkspace(registry, bare)
  assert.equal(again.status, 'already-registered')
  const after = JSON.parse(await readFile(registry, 'utf8'))
  assert.equal(after.note, 'kept')
  assert.deepEqual(after.workspaces.map((w: { id: string }) => w.id), ['alpha', 'beta', 'gamma', 'elsewhere', 'plain'])
  const clash = await registerWorkspace(registry, join(area, 'pj-alpha'), { id: 'plain' })
  assert.equal(clash.status, 'already-registered', 'the same root is never registered twice, whatever id is asked')
  const notGit = await registerWorkspace(registry, root)
  assert.equal(notGit.status, 'refused')
  // A malformed registry is never overwritten.
  await writeFile(join(root, 'broken.json'), '{')
  await assert.rejects(registerWorkspace(join(root, 'broken.json'), bare), RegistryError)
  assert.equal(await readFile(join(root, 'broken.json'), 'utf8'), '{')
})

// ---- service routes ----------------------------------------------------------

async function withService<T>(registryFile: string, fn: (base: string) => Promise<T>): Promise<T> {
  const handler = createHandler({ registryFile, area, allowedOrigins: [], allowedHosts: ['127.0.0.1'] })
  const server: Server = createServer((req, res) => void handler(req, res))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  try { return await fn(`http://127.0.0.1:${port}`) } finally { server.close() }
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('service: setup state without a registry, readable error for a malformed one', async () => {
  await withService(join(root, 'absent', 'registry.json'), async base => {
    const r = await fetch(`${base}/api/workspaces`)
    assert.equal(r.status, 200)
    const body = await r.json() as { workspaces: unknown[]; registry: { exists: boolean } }
    assert.deepEqual(body.workspaces, [])
    assert.equal(body.registry.exists, false)
  })
  await writeFile(join(root, 'malformed.json'), '[1,')
  await withService(join(root, 'malformed.json'), async base => {
    const r = await fetch(`${base}/api/workspaces`)
    assert.equal(r.status, 500)
    assert.match((await r.json() as { error: string }).error, /malformed\.json is not valid JSON/)
  })
})

test('service: create and register through the browser routes, bounded to the area', async () => {
  await withService(registry, async base => {
    const created = await post(`${base}/api/projects`, { id: 'delta', name: 'Delta', intent: 'From the browser.', goals: ['A goal.'] })
    assert.equal(created.status, 201)
    const body = await created.json() as { ok: boolean; workspace: string; root: string }
    assert.equal(body.workspace, 'delta')
    assert.equal(await realpath(body.root), await realpath(join(area, 'pj-delta')))
    const outside = await post(`${base}/api/projects`, { id: 'escape', name: 'Escape', dir: '../escape' })
    assert.equal(outside.status, 400)
    assert.equal(await exists(join(root, 'escape')), false)
    const reg = await post(`${base}/api/workspaces`, { path: 'pj-delta' })
    assert.equal(reg.status, 200)
    assert.equal((await reg.json() as { status: string }).status, 'already-registered')
    const list = await (await fetch(`${base}/api/workspaces`)).json() as { workspaces: { id: string; observed: { available: boolean } }[] }
    assert.ok(list.workspaces.find(w => w.id === 'delta')?.observed.available)
    const project = await (await fetch(`${base}/api/workspaces/delta/project`)).json() as { structure: unknown[] }
    assert.deepEqual(project.structure, [])
  })
})

// ---- CLI ---------------------------------------------------------------------

function wfe(args: string[], cwd = area): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(r => execFile(process.execPath, [join(pkg, 'cli', 'wfe.ts'), ...args], {
    cwd, env: { ...process.env, WFE_REGISTRY: registry, WFE_AREA: area, WFE_PORT: '1' },
  }, (e, stdout, stderr) => r({ code: e ? (e.code as number) : 0, stdout, stderr })))
}

const WORKFLOW = `schema: ag.workflow.v2
documentation: {policy: manual}
id: review
name: Review
intent: |
  Review the release notes.
repositories:
  docs: {path: devdocs, access: editable}
nodes:
  read:
    type: study
    description: Read the notes.
    repositories: [docs]
  fix:
    type: do
    description: Fix what is wrong.
    repositories: [docs]
edges:
  - {from: read, to: fix}
`

test('cli: help index names only real commands, each with its own help', async () => {
  const r = await wfe(['help'])
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes(registry) && r.stdout.includes(join(pkg, 'docs', 'contract.md')))
  const commands = [...r.stdout.matchAll(/^ {2}([a-z-]+)(?: [a-z]+)? /gm)].map(m => m[1])
  assert.ok(commands.length >= 10, commands.join())
  for (const c of commands) {
    const h = await wfe([c, '--help'])
    assert.equal(h.code, 0, c)
    assert.match(h.stdout, new RegExp(`^wfe ${c}`), c)
  }
  assert.equal((await wfe(['frobnicate'])).code, 2)
})

test('cli: create, status and the workspace of the current directory', async () => {
  const r = await wfe(['create', 'pj-epsilon', '--devdocs', 'submodule', '--name', 'Epsilon', '--intent', 'CLI made.', '--goal', 'One.'])
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /Created epsilon/)
  const dir = join(area, 'pj-epsilon')
  assert.match(await readFile(join(dir, '.gitmodules'), 'utf8'), /url = \.\.\/sources\/epsilon-devdocs\.git/, 'relative URL even through a symlinked prefix')
  const s = await wfe(['status', '--json'], join(dir, 'devdocs'))
  assert.equal(s.code, 0, s.stderr)
  const status = JSON.parse(s.stdout)
  assert.equal(status.workspace, 'epsilon')
  assert.equal(status.editor.running, false)
  assert.equal((await wfe(['status'], root)).code, 1, 'outside any workspace without --workspace')
})

test('cli: workflow new, validate, approve and arrange use the editor\'s logic', async () => {
  const dir = join(area, 'pj-epsilon')
  const n = await wfe(['workflow', 'new', 'review', '--name', 'Review'], dir)
  assert.equal(n.code, 0, n.stderr)
  const file = join(dir, 'devdocs', 'workflows', 'review.yaml')
  const v0 = await wfe(['validate', 'review'], dir)
  assert.equal(v0.code, 1, 'the empty template has errors (no intent)')
  assert.match(v0.stdout, /intent-missing/)
  await writeFile(file, WORKFLOW)
  const v1 = await wfe(['validate', '--json'], dir)
  assert.equal(v1.code, 0, v1.stdout)
  assert.equal(JSON.parse(v1.stdout).workflows[0].issues.length, 0)
  assert.equal((await wfe(['approve', 'review', 'definition'], dir)).code, 2, 'the approver is never implied')
  const a = await wfe(['approve', 'review.yaml', 'definition', '--approver', 'Test Person'], dir)
  assert.equal(a.code, 0, a.stderr)
  const parsed = parseWorkflow(await readFile(file, 'utf8'))
  assert.ok(parsed.ok)
  const states = await approvalStates(parsed.model)
  assert.equal(states.definition.status, 'approved')
  assert.equal(parsed.model.approvals.definition?.approver, 'Test Person')
  assert.equal(states.intent.status, 'unapproved', 'one kind at a time')
  const ar = await wfe(['arrange', 'review'], dir)
  assert.equal(ar.code, 0, ar.stderr)
  const arranged = parseWorkflow(await readFile(file, 'utf8'))
  assert.ok(arranged.ok)
  const expected = structuredClone(parsed.model)
  autoArrange(expected)
  assert.deepEqual(arranged.model.layout, expected.layout, 'same positions as the editor\'s Auto-arrange')
  assert.equal((await approvalStates(arranged.model)).definition.status, 'approved', 'layout does not stale approvals')
  await writeFile(file, WORKFLOW.replace('{from: read, to: fix}', '{from: read, to: nowhere}'))
  const refused = await wfe(['approve', 'review', 'definition', '--approver', 'Test Person'], dir)
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /validation errors/)
})

test('cli: add-repo is the editor\'s submodule operation', async () => {
  const dir = join(area, 'pj-epsilon')
  const r = await wfe(['add-repo', 'study/notes', '../sources/alpha-devdocs.git'], dir)
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.match(await readFile(join(dir, '.gitmodules'), 'utf8'), /path = study\/notes/)
  const failed = await wfe(['add-repo', 'study/none', '../sources/none.git'], dir)
  assert.equal(failed.code, 1)
  assert.match(failed.stdout, /Left behind/)
  assert.ok((await readdir(join(dir, 'study'))).includes('notes'))
})

// ---- authoring area ----------------------------------------------------------

function sh(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const clean = { ...process.env }
  for (const k of ['WFE_REGISTRY', 'WFE_AREA', 'WFE_PORT']) delete clean[k]
  return new Promise(r => execFile(cmd, args, { cwd, env: { ...clean, ...env } }, (e, stdout, stderr) => r({ code: e ? (e.code as number) : 0, stdout, stderr })))
}

test('setup: a fresh area gets its guide, launcher and empty registry, and no project', async () => {
  const fresh = join(root, 'fresh-area')
  const r = await sh(process.execPath, [join(pkg, 'cli', 'wfe.ts'), 'setup', fresh, '--port', '8199'], root)
  assert.equal(r.code, 0, r.stderr)
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'START.md', 'wfe', 'registry.json', '.claude/settings.json', 'sources']) assert.ok(await exists(join(fresh, f)), f)
  assert.deepEqual((await readdir(fresh)).filter(f => f.startsWith('pj-')), [], 'no project is pre-created')
  assert.deepEqual(JSON.parse(await readFile(join(fresh, 'registry.json'), 'utf8')).workspaces, [])
  const guide = await readFile(join(fresh, 'AGENTS.md'), 'utf8')
  assert.ok(!guide.includes('{{'), 'all placeholders filled')
  const contract = /described in `([^`]+)`/.exec(guide)?.[1]
  assert.ok(contract && await exists(contract), 'the contract path in the guide exists')
  assert.ok(guide.includes(`at \`${join(fresh, 'wfe')}\``))
  assert.ok(r.stdout.includes('http://127.0.0.1:8199/') && r.stdout.includes(`${join(fresh, 'wfe')} serve`) && r.stdout.includes('Create a project in this authoring area'), 'setup names URL, service command and prompt')
  // The launcher works from the area itself, with the area's registry.
  const help = await sh(join(fresh, 'wfe'), ['help'], fresh)
  assert.equal(help.code, 0, help.stderr)
  assert.ok(help.stdout.includes(`Registry: ${join(fresh, 'registry.json')}`))
  // Every command the guide names exists.
  for (const c of [...guide.matchAll(/`wfe ([a-z-]+)/g)].map(m => m[1]).filter(c => c !== 'help')) {
    assert.equal((await sh(join(fresh, 'wfe'), [c, '--help'], fresh)).code, 0, c)
  }
  // p3/pre1: the run contract, every run subcommand the guide names, and the execution entry point.
  const runContract = /run contract\s+is `([^`]+)`/.exec(guide)?.[1]
  assert.ok(runContract && await exists(runContract) && runContract.endsWith('runs.md'), 'the run contract path in the guide exists')
  const subs = [...new Set([...guide.matchAll(/`wfe run ([a-z-]+)/g)].map(m => m[1]).filter(c => c !== 'help'))]
  assert.ok(subs.length >= 4, `the guide names run subcommands: ${subs}`)
  for (const c of subs) {
    const h = await sh(join(fresh, 'wfe'), ['run', c, '--help'], fresh)
    assert.equal(h.code, 0, `wfe run ${c}`)
    assert.ok(/Writes|Reads only|reads only/.test(h.stdout), `wfe run ${c} --help says what it reads or writes`)
  }
  const start = await readFile(join(fresh, 'START.md'), 'utf8')
  assert.ok(!start.includes('{{') && start.includes('Execute workflow <workflow id>') && start.includes('devdocs/runs/<workflow id>/<run id>/'), 'START.md has the execution entry point')
  assert.ok(r.stdout.includes('Execute workflow <workflow id> of project <project id>') && r.stdout.includes('run help'), 'setup prints the execution prompt and the run tool')
})

test('setup: refreshing keeps the registry, projects and hand-edited files', async () => {
  const fresh = join(root, 'fresh-area')
  const made = await sh(join(fresh, 'wfe'), ['create', 'pj-kept', '--name', 'Kept'], fresh)
  assert.equal(made.code, 0, made.stderr + made.stdout)
  const status = await sh(join(fresh, 'wfe'), ['status', '--json'], join(fresh, 'pj-kept'))
  assert.equal(JSON.parse(status.stdout).workspace, 'kept', 'the launcher works from inside a project')
  await writeFile(join(fresh, 'AGENTS.md'), '# my own guide\n')
  const registryBefore = await readFile(join(fresh, 'registry.json'), 'utf8')
  const r = await sh(process.execPath, [join(pkg, 'cli', 'wfe.ts'), 'setup', fresh, '--port', '8199', '--json'], root)
  assert.equal(r.code, 0, r.stderr)
  const files = Object.fromEntries((JSON.parse(r.stdout).files as { path: string; status: string }[]).map(f => [f.path.slice(fresh.length + 1), f.status]))
  assert.equal(files['AGENTS.md'], 'kept')
  assert.equal(files['registry.json'], 'kept')
  assert.equal(files['START.md'], 'unchanged')
  assert.equal(await readFile(join(fresh, 'AGENTS.md'), 'utf8'), '# my own guide\n')
  assert.equal(await readFile(join(fresh, 'registry.json'), 'utf8'), registryBefore)
  assert.ok(await exists(join(fresh, 'pj-kept', 'project.yaml')))
  await writeFile(join(fresh, 'registry.json'), '{oops')
  const bad = await sh(process.execPath, [join(pkg, 'cli', 'wfe.ts'), 'setup', fresh], root)
  assert.equal(bad.code, 1)
  assert.equal(await readFile(join(fresh, 'registry.json'), 'utf8'), '{oops', 'a malformed registry is reported, not replaced')
})

test('add-repo --new creates a local repository and adds it, from the CLI and the browser route', async () => {
  const dir = join(area, 'pj-epsilon')
  const r = await wfe(['add-repo', 'wedo/tool', '--new'], dir)
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.ok(await exists(join(area, 'sources', 'epsilon-wedo-tool.git')))
  assert.match(await readFile(join(dir, '.gitmodules'), 'utf8'), /path = wedo\/tool\n\turl = \.\.\/sources\/epsilon-wedo-tool\.git/)
  assert.ok(await exists(join(dir, 'wedo', 'tool', 'README.md')))
  assert.equal((await wfe(['add-repo', 'wedo/tool', '--new'], dir)).code, 1, 'an existing submodule is refused')
  assert.equal((await wfe(['add-repo', 'wedo/x', '../a.git', '--new'], dir)).code, 2, 'location and --new exclude each other')
  await withService(registry, async base => {
    const res = await post(`${base}/api/workspaces/epsilon/submodules`, { path: 'study/notes2', create: true })
    assert.equal(res.status, 200, await res.clone().text())
    assert.ok(await exists(join(area, 'sources', 'epsilon-study-notes2.git')))
  })
})
