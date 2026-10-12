// p7/ex1 step 4: a run is given the person's node catalog once, at creation —
// an immutable snapshot by hash, an explicit empty one, or a visible
// "unavailable" — and every attempt, first or resumed, receives that same
// snapshot in its brief and records it. Catalog edits reach new runs only;
// runs created before catalogs are not rewritten to claim one.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { createTemplate, deleteTemplate, readCatalog, updateTemplate } from '../server/catalog.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { createRun, readRun, runOp, runResponse } from '../server/runs.ts'
import { Workspace } from '../server/workspace.ts'
import { CATALOG_MEANING } from '../shared/catalog.ts'
import { main } from '../cli/wfe.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-catalogrun-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = `schema: ag.workflow.v2
id: improve
name: Improve
intent: |
  Implement a change the person asks for.
documentation: {policy: default}
repositories:
  game: {path: ., access: editable}
nodes:
  implement:
    type: do
    description: Change the game.
    repositories: [game]
edges: []
`
let k = 0
async function setup() {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-p')
  const r = await createProject({ dir, id: 'p', name: 'P', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'improve.yaml'), WF)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  return { ws, area, registry, dir, x: new ExecStore({ registryFile: registry, area }) }
}
const RESEARCH = { name: 'Preliminary research', type: 'study', description: 'Research first; record sources.', expectation: 'When I ask for research before implementing, a study node before the work.' }
const claimed = async (x: ExecStore) => { const c = await x.claim('test-harness'); assert.ok('attempt' in c, JSON.stringify(c)); return c as Exclude<typeof c, { idle: string }> }

test('a request freezes the catalog; new and resumed attempts receive the same snapshot', async () => {
  const s = await setup()
  await createTemplate(s.area, 'preliminary-research', RESEARCH, 'Pat')
  const req = await s.x.request({ workspace: 'p', workflow: 'improve', text: 'Research formations on the web first, then implement them.', author: 'Pat', receipt: 'browser-req-cat-0001', via: 'browser' })
  const folder = join(s.dir, 'devdocs', 'runs', 'improve', req.ref.run)
  let rec = (await readRun(s.ws, req.ref)).record!
  const cat = rec.context.catalog
  assert.equal(cat?.state, 'supplied')
  if (cat?.state !== 'supplied') return
  assert.equal(cat.file, 'context/node-catalog.json')
  assert.equal(cat.templates, 3)
  const snapText = await readFile(join(folder, cat.file), 'utf8')
  assert.match(snapText, /"schema": "ag.node-catalog-snapshot.v1"/)
  assert.match(rec.input.sha256 ?? '', /^[0-9a-f]{64}$/)
  // Attempt 1: the brief states the meaning and lists each expectation; settings record the snapshot.
  const c1 = await claimed(s.x)
  assert.ok(c1.brief.includes(CATALOG_MEANING), c1.brief)
  assert.match(c1.brief, /- preliminary-research "Preliminary research" \(study, revision 1\): When I ask for research before implementing/)
  assert.match(c1.brief, /wfe nodes instantiate <template> --run improve\/run-001 --file <draft>/)
  rec = (await readRun(s.ws, req.ref)).record!
  assert.deepEqual(rec.control.attempt?.settings?.catalog, { state: 'supplied', sha256: cat.sha256, templates: 3 })
  s.x.started(c1.attempt.id, process.pid)
  const op = (o: Parameters<typeof runOp>[2], attempt?: string) => runOp(s.ws, req.ref, { ...o, ...(attempt ? { attempt } : {}) }, { by: 'autolab', via: 'cli' })
  await op({ op: 'node.start', node: '_plan' }, c1.attempt.id)
  await writeFile(join(folder, 'plan.md'), '# Plan\n')
  await op({ op: 'question.ask', question: '', node: '_plan', text: 'Agree?', to: 'Pat' }, c1.attempt.id)
  await s.x.finished(c1.attempt.id, { code: 0, signal: null })
  // The person edits and deletes templates meanwhile; the run keeps what it was given.
  await updateTemplate(s.area, 'preliminary-research', { ...RESEARCH, expectation: 'Never mind research.' }, 1, 'Pat')
  await deleteTemplate(s.area, 'cleanup', 1, 'Pat')
  await runOp(s.ws, req.ref, { op: 'question.answer', question: 'q1', text: 'ok', from: 'Pat' }, { by: 'Pat', via: 'browser' })
  await s.x.afterAnswer(s.ws, req.ref, 'q1')
  const c2 = await claimed(s.x)
  assert.match(c2.brief, /When I ask for research before implementing/)
  assert.doesNotMatch(c2.brief, /Never mind research/)
  assert.match(c2.brief, /- cleanup "Clean up"/)
  rec = (await readRun(s.ws, req.ref)).record!
  assert.deepEqual(rec.control.attempt?.settings?.catalog, { state: 'supplied', sha256: cat.sha256, templates: 3 })
  assert.equal(await readFile(join(folder, cat.file), 'utf8'), snapText)
  // Inspection shows it, from the snapshot.
  const resp = await runResponse(s.ws, req.ref)
  assert.equal(resp.catalog?.state, 'supplied')
  assert.deepEqual(resp.catalog?.state === 'supplied' && resp.catalog.snapshot.templates.map(t => t.id), ['present', 'cleanup', 'preliminary-research'])
  // A new run gets the edited catalog.
  await s.x.finished(c2.attempt.id, { code: 0, signal: null }).catch(() => null)
  const other = await createRun(s.ws, { workflow: 'improve', name: 'run-002', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'x', author: 'Pat' }, area: s.area })
  const otherCat = other.record.context.catalog
  assert.ok(otherCat?.state === 'supplied' && otherCat.templates === 2 && otherCat.sha256 !== cat.sha256)
})

test('a changed snapshot makes the record unusable; it is never re-read from the live catalog', async () => {
  const s = await setup()
  const run = await createRun(s.ws, { workflow: 'improve', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'x', author: 'Pat' }, area: s.area })
  const file = join(s.dir, 'devdocs', 'runs', 'improve', run.ref.run, 'context', 'node-catalog.json')
  await writeFile(file, (await readFile(file, 'utf8')).replace('Clean up', 'Tidy'))
  const r = await readRun(s.ws, run.ref)
  assert.equal(r.problem?.code, 'bundle')
  assert.match(r.problem?.message ?? '', /catalog snapshot was changed/)
})

test('an empty catalog is an explicit empty snapshot; an unreadable one is said, not hidden', async () => {
  const s = await setup()
  await readCatalog(s.area)
  await deleteTemplate(s.area, 'present', 1, 'Pat')
  await deleteTemplate(s.area, 'cleanup', 1, 'Pat')
  const empty = await createRun(s.ws, { workflow: 'improve', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'x', author: 'Pat' }, area: s.area })
  const ec = empty.record.context.catalog
  assert.ok(ec?.state === 'supplied' && ec.templates === 0)
  assert.ok(empty.files.some(f => f.endsWith('/context/node-catalog.json')), 'the empty snapshot is written')
  await writeFile(join(s.area, 'node-catalog.json'), '{ broken')
  const blind = await createRun(s.ws, { workflow: 'improve', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'y', author: 'Pat' }, area: s.area })
  const bc = blind.record.context.catalog
  assert.ok(bc?.state === 'unavailable' && /not valid JSON/.test(bc.problem), JSON.stringify(bc))
  assert.ok(!blind.files.some(f => f.includes('node-catalog')))
  assert.equal(await readFile(join(s.area, 'node-catalog.json'), 'utf8'), '{ broken', 'run creation does not replace the person\'s file')
  // The briefs say each case.
  const x = s.x
  for (const [ref, re] of [[empty.ref, /node catalog was empty when this run was created/], [blind.ref, /could not be read when this run was created \(node-catalog.json is not valid JSON/]] as const) {
    const brief = await x.brief(s.ws, ref, { id: 0, receipt: 'r', kind: 'start', workspace: 'p', workflow: ref.workflow, run: ref.run, reason: 'start', state: 'claimed', created: '', claimed: null, attempt: null, note: null })
    assert.match(brief, re)
  }
})

test('a run created before catalogs is not given one after the fact', async () => {
  const s = await setup()
  const old = await createRun(s.ws, { workflow: 'improve', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'x', author: 'Pat' } })
  assert.equal(old.record.context.catalog, undefined)
  const brief = await s.x.brief(s.ws, old.ref, { id: 0, receipt: 'r', kind: 'start', workspace: 'p', workflow: 'improve', run: old.ref.run, reason: 'start', state: 'claimed', created: '', claimed: null, attempt: null, note: null })
  assert.doesNotMatch(brief, /node catalog/)
  assert.equal((await runResponse(s.ws, old.ref)).catalog?.state, 'none')
  const lines: string[] = []
  const log = console.log
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')) }
  try { assert.equal(await main(['run', 'nodes', old.ref.run, '--workspace', 'p', '--registry', s.registry, '--area', s.area]), 0) } finally { console.log = log }
  assert.match(lines.join('\n'), /created before node catalogs/)
})

test('wfe run nodes shows the snapshot; instantiate --run takes the template from it', async () => {
  const s = await setup()
  await createTemplate(s.area, 'preliminary-research', RESEARCH, 'Pat')
  const run = await createRun(s.ws, { workflow: 'improve', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'x', author: 'Pat' }, area: s.area })
  await updateTemplate(s.area, 'preliminary-research', { ...RESEARCH, description: 'Live description.' }, 1, 'Pat')
  const lines: string[] = []
  const log = console.log
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')) }
  const draft = join(s.dir, 'devdocs', 'runs', 'improve', run.ref.run, 'draft.yaml')
  await writeFile(draft, WF)
  try {
    assert.equal(await main(['run', 'nodes', run.ref.run, '--workspace', 'p', '--registry', s.registry, '--area', s.area]), 0)
    assert.equal(await main(['nodes', 'instantiate', 'preliminary-research', '--run', run.ref.run, '--file', draft, '--before', 'implement', '--workspace', 'p', '--registry', s.registry, '--area', s.area]), 0)
  } finally { console.log = log }
  const text = lines.join('\n')
  assert.ok(text.includes(CATALOG_MEANING))
  assert.match(text, /Research first; record sources\./)
  assert.doesNotMatch(text, /Live description/)
  const d = await readFile(draft, 'utf8')
  assert.match(d, /  preliminary-research:\n    type: study\n    name: Preliminary research\n    description: Research first; record sources.\n/)
  assert.match(d, /  - from: preliminary-research\n    to: implement|\{from: preliminary-research, to: implement\}/)
})
