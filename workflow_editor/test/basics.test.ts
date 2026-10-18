// p8/ex2 step 5: the basic workflow freework — in every new project, added
// to existing ones by one explicit mechanism, never over what is there.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '../shared/compile.ts'
import { validateWorkflow } from '../shared/validate.ts'
import { FREEWORK, placeBasics, placeBasicsEverywhere, resolveSettings } from '../server/basics.ts'
import { createProject } from '../server/create.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { createRun } from '../server/runs.ts'
import { Workspace } from '../server/workspace.ts'
import { parseWorkflow } from '../server/yamlDoc.ts'

let root = ''
let n = 0
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-basics-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[commit]\n\tgpgsign = false\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

async function project(devdocs: 'directory' | 'submodule' = 'directory') {
  const id = `b${++n}`
  const registry = join(root, `${id}.registry.json`)
  const dir = join(root, `pj-${id}`)
  const made = await createProject({ dir, id, name: id, intent: 'x', goals: ['g'], devdocs, sourcesDir: join(root, 'sources'), registryFile: registry })
  assert.ok(made.ok, made.message)
  return { id, dir, registry, made, ws: new Workspace((await loadRegistry(registry)).workspaces[0]) }
}
const file = (dir: string) => join(dir, 'devdocs', 'workflows', `${FREEWORK}.yaml`)
const model = async (path: string) => { const p = parseWorkflow(await readFile(path, 'utf8')); assert.ok(p.ok); return p.model }

test('a new project has freework: one talk, final report only, its root editable, committed with the project', async () => {
  const p = await project()
  assert.ok(p.made.steps.some(s => s.name === 'basic workflows' && s.status === 'done'))
  const w = await model(file(p.dir))
  assert.equal(w.id, FREEWORK)
  assert.deepEqual(Object.keys(w.nodes), ['talk'])
  assert.equal(w.nodes.talk.type, 'talk')
  assert.match(w.nodes.talk.description, /make the next work concrete/)
  assert.deepEqual(w.documentation, { policy: 'custom', plan: false, reports: false, final: true })
  assert.deepEqual(w.repositories, { project: { path: '.', access: 'editable' } })
  assert.deepEqual(w.execution, { agent: '', profile: '', guides: [] })
  assert.equal(w.intake.zulip, 'requests', 'Zulip requests enabled by default')
  assert.deepEqual(validateWorkflow(w, { repositories: await p.ws.repositories() }).filter(i => i.severity === 'error'), [])
  const g = compile(w)
  assert.ok(g.ok && Object.keys(g.graph.nodes).sort().join() === '_final-report,talk')
  assert.equal((await gitOk(p.dir, ['status', '--porcelain'])).trim(), '', 'it is part of the initial commit')
  assert.match(await gitOk(p.dir, ['log', '--name-only', '--format=%s']), /devdocs\/workflows\/freework\.yaml/)
  // A run of it is created like any other.
  const run = await createRun(p.ws, { workflow: FREEWORK, input: { kind: 'braindump', text: 'Hello.', author: 'Person' }, executor: { name: 'Agent', backend: null }, by: 'Agent', via: 'cli' })
  assert.deepEqual(Object.keys(run.record.nodes).sort(), ['_final-report', 'talk'])
})

test('a new project with devdocs as a submodule has it in the devdocs repository', async () => {
  const p = await project('submodule')
  const w = await model(file(p.dir))
  assert.equal(w.id, FREEWORK)
  assert.equal((await gitOk(join(p.dir, 'devdocs'), ['status', '--porcelain'])).trim(), '')
  assert.match(await gitOk(join(p.dir, 'devdocs'), ['log', '--name-only', '--format=%s']), /workflows\/freework\.yaml/)
})

// An existing project from before p8/ex2: freework removed, workflows of its own.
async function existing() {
  const p = await project()
  await rm(file(p.dir))
  await mkdir(join(p.dir, 'agent'), { recursive: true })
  await writeFile(join(p.dir, 'agent', 'guide.md'), 'Project-wide guidance.\n')
  await mkdir(join(p.dir, 'lab'), { recursive: true })
  await writeFile(join(p.dir, 'lab', 'README.md'), 'lab\n')
  await writeFile(join(p.dir, 'project.yaml'), (await readFile(join(p.dir, 'project.yaml'), 'utf8')) + 'areas:\n  lab: Experiments\n  study/notes: Notes kept here\n')
  await mkdir(join(p.dir, 'study', 'notes'), { recursive: true })
  await writeFile(join(p.dir, 'study', 'notes', 'a.md'), 'a\n')
  const wf = (id: string, repos: string, guides: string, agent = 'proj-agent') => `schema: ag.workflow.v2\nid: ${id}\nname: ${id}\nintent: x\ndocumentation:\n  policy: default\nexecution:\n  agent: ${agent}\n  profile: sonnet\n  guides: [${guides}]\nrepositories:\n${repos}\nnodes:\n  a: {type: do, name: A, description: a}\n`
  await writeFile(join(p.dir, 'devdocs', 'workflows', 'make.yaml'), wf('make', '  project: {path: ., access: readonly}\n  lab: {path: lab, access: editable}\n  notes: {path: study/notes, access: readonly}', 'agent/guide.md, agent/make.md'))
  await writeFile(join(p.dir, 'devdocs', 'workflows', 'learn.yaml'), wf('learn', '  root: {path: ., access: readonly}\n  study: {path: study/notes, access: editable}', 'agent/guide.md, agent/learn.md'))
  await writeFile(join(p.dir, 'devdocs', 'workflows', 'broken.yaml'), 'schema: ag.workflow.v2\nid: broken\nname: [unclosed\n')
  await gitOk(p.dir, ['add', '-A'])
  await gitOk(p.dir, ['commit', '-qm', 'an existing project'])
  return p
}

test('an existing project: dry run, then added once with settings learned from its workflows; again is present', async () => {
  const p = await existing()
  // Reading the project never places anything.
  await p.ws.workflowSummaries()
  await p.ws.repositories()
  await assert.rejects(readFile(file(p.dir), 'utf8'), /ENOENT/)
  const [dry] = await placeBasics(p.ws, { dryRun: true })
  assert.equal(dry.status, 'would-add')
  assert.ok(dry.notes!.some(x => /learned from learn, make; not from broken\.yaml/.test(x)), dry.notes!.join(' | '))
  await assert.rejects(readFile(file(p.dir), 'utf8'), /ENOENT/, 'a dry run writes nothing')
  const [added] = await placeBasics(p.ws)
  assert.equal(added.status, 'added')
  const w = await model(file(p.dir))
  // Every path an existing workflow binds, editable (p11: no inherited
  // readonly); keys from the first file (by name) that bound it.
  assert.deepEqual(w.repositories, { root: { path: '.', access: 'editable' }, lab: { path: 'lab', access: 'editable' }, study: { path: 'study/notes', access: 'editable' } })
  assert.deepEqual(w.execution, { agent: 'proj-agent', profile: 'sonnet', guides: [] }, 'project guidance is inherited from project.yaml, not copied (p13)')
  assert.deepEqual(validateWorkflow(w, { repositories: await p.ws.repositories() }).filter(i => i.severity === 'error'), [])
  const text = await readFile(file(p.dir), 'utf8')
  const [again] = await placeBasics(p.ws)
  assert.equal(again.status, 'present')
  assert.equal(await readFile(file(p.dir), 'utf8'), text, 'nothing changes the second time')
  // The person's edit stays theirs.
  const edited = text.replace('name: Free work', 'name: My own free work')
  await writeFile(file(p.dir), edited)
  assert.equal((await placeBasics(p.ws))[0].status, 'present')
  assert.equal(await readFile(file(p.dir), 'utf8'), edited)
})

test('settings: disagreeing agents use the host; project guidance does not depend on workflow guide lists', async () => {
  const p = await existing()
  const t = await readFile(join(p.dir, 'devdocs', 'workflows', 'learn.yaml'), 'utf8')
  await writeFile(join(p.dir, 'devdocs', 'workflows', 'learn.yaml'), t.replace('agent: proj-agent', 'agent: other-agent').replace('agent/guide.md, ', ''))
  const s = await resolveSettings(p.ws)
  assert.deepEqual(s.execution, { agent: '', profile: 'sonnet', guides: [] }, 'p13: project guidance is project.yaml\'s, inherited, never copied')
  assert.ok(s.notes.includes('no project guides declared in project.yaml'), s.notes.join('; '))
})

test('conflicts and what cannot be placed are reported with their reason, nothing replaced', async () => {
  const p = await existing()
  // A file with the name but another id.
  await writeFile(file(p.dir), 'schema: ag.workflow.v2\nid: something-else\nname: S\nintent: x\ndocumentation: {policy: manual}\nnodes: {a: {type: do, description: a}}\n')
  let [r] = await placeBasics(p.ws)
  assert.equal(r.status, 'conflict'); assert.match(r.reason, /holds workflow "something-else"/)
  // A file with the name that cannot be read.
  await writeFile(file(p.dir), 'schema: ag.workflow.v2\nname: [unclosed\n')
  ;[r] = await placeBasics(p.ws)
  assert.equal(r.status, 'conflict'); assert.match(r.reason, /cannot be read/)
  assert.equal(await readFile(file(p.dir), 'utf8'), 'schema: ag.workflow.v2\nname: [unclosed\n')
  // The id in another file is the person's freework.
  await rm(file(p.dir))
  await writeFile(join(p.dir, 'devdocs', 'workflows', 'mine.yaml'), 'schema: ag.workflow.v2\nid: freework\nname: Mine\nintent: x\ndocumentation: {policy: manual}\nnodes: {a: {type: do, description: a}}\n')
  ;[r] = await placeBasics(p.ws)
  assert.equal(r.status, 'present'); assert.equal(r.file, 'devdocs/workflows/mine.yaml')
  // No workflow directory.
  const q = await project()
  await rm(join(q.dir, 'devdocs', 'workflows'), { recursive: true })
  ;[r] = await placeBasics(q.ws)
  assert.equal(r.status, 'unplaceable'); assert.match(r.reason, /does not exist/)
})

test('several workspaces of one project are placed once; commit records only the file; push needs an upstream', async () => {
  const p = await existing()
  await writeFile(join(p.dir, 'NOTES.md'), 'the person\'s own uncommitted work\n')
  // A second workspace: a clone of the same project.
  const bare = join(root, `${p.id}-origin.git`)
  await gitOk(root, ['clone', '-q', '--bare', p.dir, bare])
  await gitOk(p.dir, ['remote', 'add', 'origin', bare])
  await gitOk(p.dir, ['fetch', '-q', 'origin'])
  await gitOk(p.dir, ['branch', '-q', '--set-upstream-to=origin/main'])
  const clone = join(root, `${p.id}-second`)
  await gitOk(root, ['clone', '-q', bare, clone])
  const second = new Workspace({ id: `${p.id}-2`, label: 'second', host: 'this machine', path: clone, project: p.id })
  const results = await placeBasicsEverywhere([p.ws, second], { commit: true, push: true })
  assert.deepEqual(results.map(r => r.status), ['added', 'covered'])
  assert.match(results[1].reason, new RegExp(`workspace ${p.ws.reg.id}`))
  assert.ok(results[0].commit && results[0].pushed, JSON.stringify(results[0]))
  assert.match(await gitOk(p.dir, ['status', '--porcelain']), /^\?\? NOTES\.md$/m, 'the person\'s file is not committed')
  assert.equal((await gitOk(p.dir, ['show', '--name-only', '--format=', 'HEAD'])).trim(), 'devdocs/workflows/freework.yaml')
  assert.equal((await gitOk(bare, ['log', '-1', '--format=%s', 'main'])).trim(), 'Add the basic workflow freework (talk first; the run grows its work in conversation)')
  // Run again: present, nothing new.
  const again = await placeBasicsEverywhere([p.ws, second], { commit: true, push: true })
  assert.deepEqual(again.map(r => r.status), ['present', 'covered'])
  // Without an upstream the commit stays local and the reason is told.
  const q = await existing()
  const [local] = await placeBasics(q.ws, { commit: true, push: true })
  assert.equal(local.status, 'added'); assert.ok(local.commit); assert.equal(local.pushed, false); assert.match(local.publishError!, /no upstream/)
})

test('the Free work template makes the same definition under another id', async () => {
  const p = await existing()
  await p.ws.createWorkflow('ask-first', 'Ask first', undefined, 'freework')
  const w = await model(join(p.dir, 'devdocs', 'workflows', 'ask-first.yaml'))
  assert.equal(w.id, 'ask-first')
  assert.equal(w.name, 'Ask first')
  assert.deepEqual(Object.keys(w.nodes), ['talk'])
  assert.deepEqual(w.documentation, { policy: 'custom', plan: false, reports: false, final: true })
  assert.deepEqual(w.execution.agent, 'proj-agent')
})


test('a basic workflow copies no guide; project.yaml guides are named as inherited (p13)', async () => {
  const p = await existing()
  await rm(join(p.dir, 'devdocs', 'workflows', 'learn.yaml'))
  assert.deepEqual((await resolveSettings(p.ws)).execution.guides, [], 'neither make.md nor guide.md becomes a copied guide')
  await rm(join(p.dir, 'devdocs', 'workflows', 'make.yaml'))
  const y = join(p.dir, 'project.yaml')
  await writeFile(y, `${await readFile(y, 'utf8')}guides: [agent/guide.md]\n`)
  const s = await resolveSettings(p.ws)
  assert.deepEqual(s.execution.guides, [])
  assert.ok(s.notes.includes('project guides inherited from project.yaml: agent/guide.md'), s.notes.join('; '))
})
