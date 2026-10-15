// p7/ex1 step 3: templates of the person's catalog become ordinary workflow
// nodes — copied content and appearance, a unique id, declared bindings
// only, and provenance that round-trips in YAML but stays outside every
// digest, the compiled graph and the run's executable meaning. Catalog
// edits never reach a workflow or a run.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvalStates, semanticDigest } from '../shared/canonical.ts'
import { instantiate, SEEDS } from '../shared/catalog.ts'
import { compile } from '../shared/compile.ts'
import { emptyWorkflow } from '../shared/model.ts'
import { createProject } from '../server/create.ts'
import { createTemplate, deleteTemplate, instantiateText, updateTemplate } from '../server/catalog.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { adjustRun, createRun, readRun, runOp } from '../server/runs.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import { parseWorkflow } from '../server/yamlDoc.ts'
import { main } from '../cli/wfe.ts'
import { createHandler } from '../server/api.ts'
import { createServer } from 'node:http'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-instantiate-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = `# the person's improvement workflow
schema: ag.workflow.v2
id: improve
name: Improve
intent: |
  Implement and verify a change.
documentation: {policy: default}
repositories:
  game: {path: ., access: editable}
  docs: {path: devdocs, access: readonly}
nodes:
  implement:
    type: do
    description: Change the game.
    repositories: [game]
  verify:
    type: do
    description: Check it.
edges:
  - {from: implement, to: verify}
`
const RESEARCH = { id: 'preliminary-research', revision: 2, type: 'study', name: 'Preliminary research', description: 'Research first.\nRecord sources and findings.', expectation: 'A study node before the work it informs.', appearance: { icon: 'study', color: 'violet' } }
const code = (e: unknown) => ((e as RequestError).detail as { code?: string } | undefined)?.code ?? (e as { code?: string }).code

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
  return { ws, area, registry, dir, file: join(dir, 'devdocs', 'workflows', 'improve.yaml') }
}

test('a template becomes an ordinary node: unique id, copied content, declared bindings only, provenance', () => {
  const parsed = parseWorkflow(WF)
  assert.ok(parsed.ok)
  const w = parsed.model
  const r = instantiate(w, RESEARCH, { repositories: ['docs'], before: ['implement'] })
  assert.equal(r.node, 'preliminary-research')
  assert.deepEqual(r.workflow.nodes[r.node], { type: 'study', name: 'Preliminary research', description: RESEARCH.description, repositories: ['docs'], appearance: { icon: 'study', color: 'violet' }, template: { id: 'preliminary-research', revision: 2, expectation: RESEARCH.expectation } })
  assert.deepEqual(r.workflow.edges.at(-1), { from: 'preliminary-research', to: 'implement' })
  assert.equal(Object.keys(w.nodes).length, 2, 'the input model is not changed')
  // Ids are made unique; an explicit one that is taken is refused.
  assert.equal(instantiate(r.workflow, RESEARCH).node, 'preliminary-research-2')
  assert.throws(() => instantiate(w, RESEARCH, { id: 'implement' }), (e: unknown) => code(e) === 'node-id-taken')
  // Instantiation never adds access or a result confirmation; a delegate
  // template (p10) brings only the target it states.
  assert.throws(() => instantiate(w, RESEARCH, { repositories: ['secrets'] }), (e: unknown) => code(e) === 'template-binding')
  const dl = instantiate(w, { ...RESEARCH, id: 'ask-forge', type: 'delegate', target: { project: 'forge', workflow: 'provide', accepts: 'parent' } })
  assert.deepEqual([dl.workflow.nodes[dl.node].type, dl.workflow.nodes[dl.node].project, dl.workflow.nodes[dl.node].workflow, dl.workflow.nodes[dl.node].accepts], ['delegate', 'forge', 'provide', 'parent'])
  const open = instantiate(w, { ...RESEARCH, id: 'ask-someone', type: 'delegate' })
  assert.ok(!('workflow' in open.workflow.nodes[open.node]), 'without a target the author chooses one')
  const node = r.workflow.nodes[r.node]
  assert.ok(!('workflow' in node) && !('confirms' in node))
  // Inserted between two connected nodes, the direct edge goes.
  const between = instantiate(w, RESEARCH, { id: 'probe', after: ['implement'], before: ['verify'] }).workflow
  assert.deepEqual(between.edges, [{ from: 'implement', to: 'probe' }, { from: 'probe', to: 'verify' }])
})

test('provenance round-trips in YAML and stays outside digests and the compiled graph', async () => {
  const added = instantiateText(WF, RESEARCH, { id: 'research', before: ['implement'] })
  assert.match(added.text, /^# the person's improvement workflow/, 'the rest of the file stays as it was')
  assert.match(added.text, /  research:\n    type: study\n    name: Preliminary research\n/)
  assert.match(added.text, /    template:\n      id: preliminary-research\n      revision: 2\n      expectation: A study node before the work it informs.\n/)
  const back = parseWorkflow(added.text)
  assert.ok(back.ok)
  assert.deepEqual(back.model.nodes.research.template, { id: 'preliminary-research', revision: 2, expectation: RESEARCH.expectation })
  // The same node written by hand, without provenance: same digests, same compiled graph.
  const hand = structuredClone(back.model)
  delete hand.nodes.research.template
  for (const kind of ['intent', 'definition'] as const) assert.equal(await semanticDigest(kind, hand), await semanticDigest(kind, back.model))
  const a = compile(hand), b = compile(back.model)
  assert.ok(a.ok && b.ok)
  assert.deepEqual(a.graph, b.graph)
  // Copied content is semantic: a description edit makes an approval stale; a provenance edit does not.
  const approved = structuredClone(back.model)
  approved.approvals.definition = { digest: (await approvalStates(back.model)).definition.digest, approver: 'Pat', at: '2026-10-12T00:00:00.000Z' }
  const provenanceOnly = structuredClone(approved)
  provenanceOnly.nodes.research.template!.revision = 9
  assert.equal((await approvalStates(provenanceOnly)).definition.status, 'approved')
  const described = structuredClone(approved)
  described.nodes.research.description = 'Research less.'
  assert.equal((await approvalStates(described)).definition.status, 'stale')
  // A hand-written provenance with the wrong shape is a shape problem.
  assert.ok(!parseWorkflow(added.text.replace('      revision: 2\n', '      revision: two\n')).ok)
})

test('catalog edits and deletion leave workflows and runs as they were', async () => {
  const s = await setup()
  await createTemplate(s.area, 'research', { name: 'Research', type: 'study', description: 'Look first.', expectation: 'A study node first.' }, 'Pat')
  assert.equal(await main(['nodes', 'instantiate', 'research', '--workflow', 'improve', '--before', 'implement', '--bind', 'docs', '--workspace', 'p', '--registry', s.registry, '--area', s.area]), 0)
  const withNode = await readFile(s.file, 'utf8')
  assert.match(withNode, /  research:\n    type: study\n    name: Research\n    description: Look first.\n    repositories: \[docs\]\n    template:\n      id: research\n      revision: 1\n/)
  const run = await createRun(s.ws, { workflow: 'improve', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'go', author: 'Pat' }, area: s.area })
  await updateTemplate(s.area, 'research', { name: 'Research', type: 'study', description: 'Look much more.', expectation: 'Always first.' }, 1, 'Pat')
  await deleteTemplate(s.area, 'research', 2, 'Pat')
  assert.equal(await readFile(s.file, 'utf8'), withNode, 'the workflow file is unchanged')
  const r = await readRun(s.ws, run.ref)
  assert.ok(r.record, r.problem?.message)
  assert.match(r.bundle.entries.improve.text!, /template:\n      id: research\n      revision: 1\n      expectation: A study node first./)
  assert.deepEqual(r.bundle.catalog?.templates.map(t => [t.id, t.revision, t.description]), [['present', 1, SEEDS.present.description], ['cleanup', 1, SEEDS.cleanup.description], ['research', 1, 'Look first.']])
  // Unknown templates are not errors: the catalog is a source of copies, not a dependency.
  assert.equal(await main(['validate', 'improve', '--workspace', 'p', '--registry', s.registry, '--area', s.area]), 0)
})

test('the CLI and the HTTP route instantiate the same way', async () => {
  const s1 = await setup(), s2 = await setup()
  for (const s of [s1, s2]) await createTemplate(s.area, 'research', { name: 'Research', type: 'study', description: 'Look first.', expectation: 'A study node first.', appearance: { icon: 'study', color: 'violet' } }, 'Pat')
  assert.equal(await main(['nodes', 'instantiate', 'research', '--workflow', 'improve.yaml', '--after', 'implement', '--before', 'verify', '--workspace', 'p', '--registry', s1.registry, '--area', s1.area]), 0)
  const handler = createHandler({ registryFile: s2.registry, area: s2.area, allowedOrigins: [], allowedHosts: ['127.0.0.1'] })
  const srv = createServer((req, res) => void handler(req, res))
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  try {
    const res = await fetch(`http://127.0.0.1:${(srv.address() as { port: number }).port}/api/workspaces/p/workflows/improve.yaml/instantiate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template: 'research', after: ['implement'], before: ['verify'] }) })
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { node: string }).node, 'research')
    const bad = await fetch(`http://127.0.0.1:${(srv.address() as { port: number }).port}/api/workspaces/p/workflows/improve.yaml/instantiate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template: 'research', repositories: ['secrets'] }) })
    assert.equal(bad.status, 422)
  } finally { srv.close() }
  assert.equal(await readFile(s1.file, 'utf8'), await readFile(s2.file, 'utf8'))
})

test('an adjustment of provenance alone is nothing; started work keeps its provenance', async () => {
  const s = await setup()
  const withNode = instantiateText(WF, RESEARCH, { id: 'research', before: ['implement'] }).text
  await writeFile(s.file, withNode)
  const run = await createRun(s.ws, { workflow: 'improve', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'go', author: 'Pat' }, area: s.area })
  const folder = join(s.dir, 'devdocs', 'runs', 'improve', run.ref.run)
  const op = (o: Parameters<typeof runOp>[2]) => runOp(s.ws, run.ref, o, { by: 'agent', via: 'cli' })
  const adjust = (text: string) => adjustRun(s.ws, run.ref, { text, reason: 'r', source: { kind: 'person', by: 'Pat' }, dryRun: true }, { by: 'Pat', via: 'cli' })
  const restamped = withNode.replace('      revision: 2\n', '      revision: 3\n')
  let r = await adjust(restamped)
  assert.deepEqual(r.problems.map(p => p.code), ['adjust-nothing'])
  await op({ op: 'node.start', node: '_plan' })
  await writeFile(join(folder, 'plan.md'), '# Plan\n')
  await op({ op: 'question.ask', question: '', node: '_plan', text: 'Agree?', to: 'Pat' })
  await runOp(s.ws, run.ref, { op: 'question.answer', question: 'q1', text: 'Yes', from: 'Pat' }, { by: 'Pat', via: 'cli' })
  await op({ op: 'question.take-up', question: 'q1' })
  await op({ op: 'node.complete', node: '_plan', outcome: 'agreed' })
  await op({ op: 'node.start', node: 'research' })
  await op({ op: 'node.complete', node: 'research', outcome: 'done' })
  r = await adjust(restamped)
  assert.ok(r.problems.some(p => p.code === 'adjust-started' && /template/.test(p.message)), JSON.stringify(r.problems))
})

test('instantiation into an empty draft and the seeds behave like the p7 presets', () => {
  const w = emptyWorkflow('w', 'W')
  const r = instantiate(w, { id: 'cleanup', revision: 1, ...SEEDS.cleanup })
  assert.equal(r.node, 'cleanup')
  assert.deepEqual(r.workflow.nodes.cleanup.appearance, { icon: 'cleanup', color: 'slate' })
  assert.equal(r.workflow.nodes.cleanup.type, 'do')
})
