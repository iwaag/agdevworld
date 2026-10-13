// Local areas (project_migration p1): folders of the root repository that a
// project declares in project.yaml and that workflows bind like submodules.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitOk } from '../server/git.ts'
import { Workspace } from '../server/workspace.ts'
import { parseProject } from '../server/yamlDoc.ts'
import { accessAt } from '../shared/access.ts'
import { emptyWorkflow } from '../shared/model.ts'
import { validateProject, validateWorkflow } from '../shared/validate.ts'

let root = ''
let dir = ''
const PROJECT = `schema: ag.project.v2
id: areas
name: Areas
devdocs: directory
intent: Keep study and lab material in the root repository.
areas:
  study/study-x: {description: Literature surveys kept locally}
  lab: Experiments and tools
  missing/area: {}
  shared: {description: Declared over a submodule}
`

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-areas-'))
  const sub = join(root, 'sub')
  await mkdir(sub)
  await gitOk(sub, ['init', '-q', '-b', 'main'])
  await writeFile(join(sub, 'README.md'), 'shared\n')
  await gitOk(sub, ['add', '.'])
  await gitOk(sub, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'])
  dir = join(root, 'pj-areas')
  await mkdir(join(dir, 'study/study-x'), { recursive: true })
  await mkdir(join(dir, 'lab'), { recursive: true })
  await mkdir(join(dir, 'devdocs/workflows'), { recursive: true })
  await writeFile(join(dir, 'project.yaml'), PROJECT)
  await writeFile(join(dir, 'study/study-x/README.md'), 'study\n')
  await writeFile(join(dir, 'lab/README.md'), 'lab\n')
  await writeFile(join(dir, 'devdocs/README.md'), 'docs\n')
  await gitOk(dir, ['init', '-q', '-b', 'main'])
  await gitOk(dir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'shared'])
  await gitOk(dir, ['add', '.'])
  await gitOk(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'])
  await writeFile(join(dir, 'lab/new.txt'), 'uncommitted\n')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

test('project.yaml areas parse as path and description, in either form', () => {
  const p = parseProject(PROJECT)
  assert.ok(p.ok)
  assert.deepEqual(p.model.areas, [
    { path: 'study/study-x', description: 'Literature surveys kept locally' },
    { path: 'lab', description: 'Experiments and tools' },
    { path: 'missing/area', description: '' },
    { path: 'shared', description: 'Declared over a submodule' },
  ])
  const bad = parseProject(PROJECT.replace('lab: Experiments and tools', 'lab: [1, 2]'))
  assert.ok(!bad.ok)
})

test('area declarations are validated: root, devdocs, .local, duplicates and nesting', () => {
  const p = parseProject(PROJECT)
  assert.ok(p.ok)
  const codes = (areas: string[]) => validateProject({ ...p.model, areas: areas.map(path => ({ path, description: '' })) }).map(i => i.code)
  assert.deepEqual(codes(['study/study-x', 'lab']), [])
  assert.deepEqual(codes(['.']), ['area-path-invalid'])
  assert.deepEqual(codes(['devdocs/notes']), ['area-path-invalid'])
  assert.deepEqual(codes(['../x']), ['area-path-invalid'])
  assert.deepEqual(codes(['.local/x']), ['area-path-invalid'])
  assert.deepEqual(codes(['lab', './lab/']), ['area-duplicate'])
  assert.deepEqual(codes(['lab', 'lab/tools']), ['area-nested'])
})

test('the workspace lists declared areas as folders of the root', async () => {
  const ws = new Workspace({ id: 'areas', label: 'Areas', host: 'this machine', path: dir })
  const by = new Map((await ws.repositories()).map(r => [r.path, r]))
  const study = by.get('study/study-x')!
  assert.equal(study.kind, 'directory')
  assert.equal(study.category, 'study')
  assert.equal(study.initialized, true)
  assert.equal(study.description, 'Literature surveys kept locally')
  assert.equal(study.dirty, 0)
  const lab = by.get('lab')!
  assert.equal(lab.category, 'other')
  assert.equal(lab.dirty, 1)
  assert.equal(by.get('missing/area')!.initialized, false)
  // An area over a submodule is reported, and the submodule is still listed.
  assert.equal(by.get('shared')!.kind, 'submodule')
  assert.match(by.get('shared')!.error ?? '', /also declared as a local area/)
  assert.equal([...by.values()].filter(r => r.path === 'shared').length, 1)
  assert.equal(by.get('devdocs')!.kind, 'directory')
})

test('workflows bind areas; a missing area is an error, an undeclared folder is repository-missing', async () => {
  const ws = new Workspace({ id: 'areas', label: 'Areas', host: 'this machine', path: dir })
  const repositories = await ws.repositories()
  const w = emptyWorkflow('research', 'Research')
  w.intent = 'Study and practise.'
  w.documentation.policy = 'default'
  w.repositories = {
    root: { path: '.', access: 'readonly' },
    study: { path: 'study/study-x', access: 'editable' },
    lab: { path: 'lab', access: 'editable' },
  }
  w.nodes = { survey: { type: 'study', name: 'Survey', description: 'Survey.', repositories: ['study'] } }
  const errors = (x: typeof w) => validateWorkflow(x, { repositories }).filter(i => i.severity === 'error').map(i => i.code)
  assert.deepEqual(errors(w), [])
  assert.deepEqual(errors({ ...w, repositories: { ...w.repositories, gone: { path: 'missing/area', access: 'readonly' } } }), ['area-missing'])
  assert.deepEqual(errors({ ...w, repositories: { ...w.repositories, undeclared: { path: 'devdocs/workflows', access: 'readonly' } } }), ['repository-missing'])
  // Access is a path scope: the area's binding governs inside it.
  assert.equal(accessAt(w.repositories, 'study/study-x/01.md').access, 'editable')
  assert.equal(accessAt(w.repositories, 'README.md').access, 'readonly')
})
