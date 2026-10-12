// p7/ex1 step 5: the run's original request as the source of an adjustment.
// The formation-movement request of improve-game/run-004 asked for Web
// research before implementing; here the agent agrees a plan that names the
// research, adds `research → implement` from the request (from the run's own
// catalog snapshot) before either authored activity starts, and the study's
// report precedes implementation. Every existing refusal still applies, and
// nothing in the catalog changes a graph by itself.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { createTemplate } from '../server/catalog.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { adjustRun, readRun, runOp, type AdjustOptions } from '../server/runs.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import { compile } from '../shared/compile.ts'
import { checkRecord, operate, type OpInput, type RunGraph, type RunRecord } from '../shared/run.ts'
import { parseWorkflow } from '../server/yamlDoc.ts'
import { main } from '../cli/wfe.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-reqadjust-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = `schema: ag.workflow.v2
id: improve
name: Improve
intent: |
  Implement and verify a change the person asks for.
documentation: {policy: default}
repositories:
  game: {path: ., access: editable}
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
const BRAINDUMP = '複数選択し移動目標選択した後のフォーメーション移動を実装してください。実装に入る前に事前にrtsの基本的なフォーメーション移動の実装についてwebを調査してください。'
const RESEARCH = { name: 'Preliminary research', type: 'study', description: 'Research how this is usually done; record sources, findings, the choice and uncertainties.', expectation: 'When I ask for research before implementing, a study node before the work it informs.' }
const sha = (t: string) => createHash('sha256').update(t).digest('hex')
const code = (e: unknown) => ((e as RequestError).detail as { code?: string } | undefined)?.code

let k = 0
async function setup() {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-rts')
  const r = await createProject({ dir, id: 'rts', name: 'RTS', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'improve.yaml'), WF)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  await createTemplate(area, 'preliminary-research', RESEARCH, 'Pat')
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  const x = new ExecStore({ registryFile: registry, area })
  const req = await x.request({ workspace: 'rts', workflow: 'improve', text: BRAINDUMP, author: 'Pat', receipt: `browser-req-${k}-000001`, via: 'browser' })
  const c = await x.claim('test-harness')
  assert.ok('attempt' in c)
  x.started(c.attempt.id, process.pid)
  const folder = join(dir, 'devdocs', 'runs', 'improve', req.ref.run)
  return { ws, x, area, registry, dir, folder, ref: req.ref, attempt: c.attempt.id, brief: c.brief }
}
type S = Awaited<ReturnType<typeof setup>>
const op = (s: S, o: OpInput, attempt: string | undefined = s.attempt) => runOp(s.ws, s.ref, { ...o, ...(attempt ? { attempt } : {}) } as OpInput, { by: 'autolab', via: 'cli' })
const adjust = (s: S, text: string, o: Partial<AdjustOptions> = {}, attempt: string | null = s.attempt) => adjustRun(s.ws, s.ref, { text, reason: o.reason ?? 'The request asks for Web research before implementing.', source: o.source ?? { kind: 'request' }, ...o }, { by: 'autolab', via: 'cli', ...(attempt ? { attempt } : {}) })
const record = async (s: S) => { const r = await readRun(s.ws, s.ref); assert.ok(r.record, r.problem?.message); return r.record! }
async function agreePlan(s: S) {
  await op(s, { op: 'node.start', node: '_plan' })
  await writeFile(join(s.folder, 'plan.md'), '# Plan\n\n1. research (study, from your template preliminary-research): RTS formation movement on the Web; sources and findings in report-research.md.\n2. implement\n3. verify\n')
  await op(s, { op: 'question.ask', question: '', node: '_plan', text: 'Agree to plan.md?', to: 'Pat' })
  await runOp(s.ws, s.ref, { op: 'question.answer', question: 'q1', text: 'ok', from: 'Pat' }, { by: 'Pat', via: 'browser' })
  await op(s, { op: 'question.take-up', question: 'q1' })
  await op(s, { op: 'node.complete', node: '_plan', outcome: 'agreed: research, implement, verify' })
}
// The draft the agent builds: the definition in force plus the template from
// the run's own snapshot, inserted before implement.
async function draft(s: S): Promise<string> {
  const file = join(s.folder, 'draft.yaml')
  await writeFile(file, await readFile(join(s.folder, 'definition', 'improve.yaml'), 'utf8'))
  const log = console.log
  console.log = () => {}
  try { assert.equal(await main(['nodes', 'instantiate', 'preliminary-research', '--run', s.ref.run, '--file', file, '--id', 'research', '--before', 'implement', '--workspace', 'rts', '--registry', s.registry, '--area', s.area]), 0) } finally { console.log = log }
  return readFile(file, 'utf8')
}

test('the formation example: plan agreed, research added from the request, its report precedes implementation', async () => {
  const s = await setup()
  assert.match(s.brief, /- preliminary-research "Preliminary research" \(study, revision 1\)/)
  await op(s, { op: 'node.start', node: '_plan' })
  const text = await draft(s)
  // While _plan runs, no adjustment applies (mid-node).
  const early = await adjust(s, text, { dryRun: true })
  assert.ok(early.problems.some(p => p.code === 'mid-node'), JSON.stringify(early.problems))
  await writeFile(join(s.folder, 'plan.md'), '# Plan\n\n1. research (study): sources and findings in report-research.md.\n2. implement\n3. verify\n')
  await op(s, { op: 'question.ask', question: '', node: '_plan', text: 'Agree to plan.md?', to: 'Pat' })
  await runOp(s.ws, s.ref, { op: 'question.answer', question: 'q1', text: 'ok', from: 'Pat' }, { by: 'Pat', via: 'browser' })
  await op(s, { op: 'question.take-up', question: 'q1' })
  await op(s, { op: 'node.complete', node: '_plan', outcome: 'agreed' })
  const originalBytes = await readFile(join(s.folder, 'definition', 'improve.yaml'), 'utf8')
  // At the boundary after the agreed plan, from the request: applied.
  const r = await adjust(s, text)
  assert.ok(r.ok, JSON.stringify(r.problems))
  assert.equal(r.revision, 'r2')
  assert.deepEqual(r.graph.added, ['_report.research', 'research'])
  const rec = await record(s)
  const rev = rec.definition.revisions![0]
  assert.deepEqual(rev.source, { kind: 'request', input: 'braindump.md', sha256: sha(BRAINDUMP) })
  assert.equal(rec.input.sha256, sha(BRAINDUMP))
  const edges = rev.effective.edges.map(e => `${e.from}→${e.to}`)
  for (const e of ['_plan→research', 'research→_report.research', '_report.research→implement']) assert.ok(edges.includes(e), `${e} in ${edges.join(', ')}`)
  assert.ok(!edges.includes('_plan→implement'))
  assert.deepEqual(rec.execution.ready, ['research'])
  // The study runs; implementation waits for its report, which needs its document.
  await op(s, { op: 'node.start', node: 'research' })
  await op(s, { op: 'node.complete', node: 'research', outcome: 'surveyed formation approaches' })
  await assert.rejects(op(s, { op: 'node.start', node: 'implement' }), (e: unknown) => code(e) === 'not-ready')
  await op(s, { op: 'node.start', node: '_report.research' })
  await assert.rejects(op(s, { op: 'node.complete', node: '_report.research', outcome: 'x' }), (e: unknown) => code(e) === 'document-missing')
  await writeFile(join(s.folder, 'report-research.md'), '# Research\n\n## Sources\n- https://example.invalid/formations\n\n## Findings\n…\n\n## Choice\nGrid slots.\n\n## Uncertain\nSlot assignment.\n')
  await op(s, { op: 'node.complete', node: '_report.research', outcome: 'sources and findings in report-research.md' })
  assert.deepEqual((await record(s)).execution.ready, ['implement'])
  // The original stays; the record replays from it across the revision.
  assert.equal(await readFile(join(s.folder, 'definition', 'improve.yaml'), 'utf8'), originalBytes)
  const raw = JSON.parse(await readFile(join(s.folder, 'run.json'), 'utf8'))
  const parsed = parseWorkflow(originalBytes)
  assert.ok(parsed.ok)
  const c = compile(parsed.model)
  assert.ok(c.ok)
  assert.ok(checkRecord(raw, { nodes: c.graph.nodes, edges: c.graph.edges }).ok)
  // The research node keeps its provenance in the revision.
  assert.match(await readFile(join(s.folder, 'definition', 'r2', 'improve.yaml'), 'utf8'), /template:\n      id: preliminary-research\n      revision: 1\n/)
})

test('the request source binds to the run\'s input; every existing refusal still applies', async () => {
  const s = await setup()
  await agreePlan(s)
  const text = await draft(s)
  // Another attempt or nobody: fenced as before.
  assert.ok((await adjust(s, text, { dryRun: true }, null)).problems.some(p => p.code === 'attempt-open'))
  assert.ok((await adjust(s, text, { dryRun: true }, 'a0-stale')).problems.some(p => p.code === 'attempt-stale'))
  // A stale view of the revision.
  assert.ok((await adjust(s, text, { dryRun: true, expectRevision: 'r2' })).problems.some(p => p.code === 'revision-outdated'))
  // Changed access is refused whatever the source.
  const wider = text.replace('  game: {path: ., access: editable}\n', '  game: {path: ., access: editable}\n  docs: {path: devdocs, access: editable}\n')
  assert.ok((await adjust(s, wider, { dryRun: true })).problems.some(p => p.code === 'adjust-access'))
  // A naming of another file, or of other content, is not the run's input.
  assert.ok((await adjust(s, text, { dryRun: true, source: { kind: 'request', input: 'plan.md' } })).problems.some(p => p.code === 'adjust-unauthorized'))
  assert.ok((await adjust(s, text, { dryRun: true, source: { kind: 'request', sha256: '0'.repeat(64) } })).problems.some(p => p.code === 'adjust-unauthorized'))
  // A pending instruction holds the boundary.
  await runOp(s.ws, s.ref, { op: 'instruction.receive', text: 'Also add a minimap.', from: 'Pat' }, { by: 'Pat', via: 'browser' })
  assert.ok((await adjust(s, text, { dryRun: true })).problems.some(p => p.code === 'instructions-pending'))
  await op(s, { op: 'instruction.ack', instructions: ['i1'], response: 'new-run', note: 'a minimap is another request' })
  // The input changed on disk since creation: not the request the run was given.
  const bd = join(s.folder, 'braindump.md')
  await writeFile(bd, `${BRAINDUMP}\nそしてミニマップも。`)
  const changed = await adjust(s, text, { dryRun: true })
  assert.ok(changed.problems.some(p => p.code === 'adjust-unauthorized' && /not the input this run was created with/.test(p.message)), JSON.stringify(changed.problems))
  await writeFile(bd, BRAINDUMP)
  assert.ok((await adjust(s, text, { dryRun: true })).ok)
  // Once implementation has started, it keeps its dependencies.
  await op(s, { op: 'node.start', node: 'implement' })
  await op(s, { op: 'node.complete', node: 'implement', outcome: 'done' })
  assert.ok((await adjust(s, text, { dryRun: true })).problems.some(p => p.code === 'adjust-dependencies'))
})

test('a run whose input was not recorded by hash cannot use the request source', () => {
  const graph: RunGraph = { nodes: { a: { type: 'do' }, b: { type: 'do' } }, edges: [] }
  let at = Date.parse('2026-10-12T00:00:00.000Z')
  const ctx = (g = graph) => ({ at: new Date(at += 1000).toISOString(), by: 'autolab', via: 'cli', graph: g })
  const r: RunRecord = operate(null, { op: 'run.create', project: 'p', workflow: 'w', run: 'run-001', nodes: ['a'], input: { kind: 'braindump', file: 'braindump.md', author: 'P' }, executor: { name: 'autolab', backend: null }, predecessor: null, definition: { root: 'w', workflows: {}, warnings: [] }, context: { repositories: [] } }, ctx({ nodes: { a: { type: 'do' } }, edges: [] }))
  assert.throws(() => operate(r, { op: 'run.adjust', revision: 'r2', parent: 'r1', file: 'definition/r2/w.yaml', sha256: 'a'.repeat(64), definitionDigest: `sha256:${'b'.repeat(64)}`, effective: { compiler: 'ag.wfe-compile.v2', policy: 'manual', nodes: graph.nodes, edges: [] }, reason: 'r', source: { kind: 'request', input: 'braindump.md', sha256: 'c'.repeat(64) } }, ctx({ nodes: { a: { type: 'do' } }, edges: [] })), /recorded no hash/)
})

test('the catalog never changes a graph by itself, adds no capability and no mandatory work', async () => {
  const s = await setup()
  const rec = await record(s)
  // The braindump asks for research and the catalog has a research template;
  // the run's graph is still exactly the workflow's.
  const parsed = parseWorkflow(WF)
  assert.ok(parsed.ok)
  const c = compile(parsed.model)
  assert.ok(c.ok)
  assert.deepEqual(rec.definition.effective, c.graph)
  assert.deepEqual(Object.keys(rec.nodes).sort(), ['_final-report', '_plan', '_report.implement', '_report.verify', 'implement', 'verify'])
  // A template node runs as an ordinary node of its type: the compiled graph
  // has no trace of the catalog, and the run's access is the workflow's.
  const text = await draft(s)
  const p2 = parseWorkflow(text)
  assert.ok(p2.ok)
  const c2 = compile(p2.model)
  assert.ok(c2.ok)
  assert.deepEqual(c2.graph.nodes.research, { type: 'study' })
  assert.deepEqual(p2.model.repositories, parsed.model.repositories)
  // Skipping a template is allowed: the run completes without one.
  await agreePlan(s)
  for (const n of ['implement', 'verify']) {
    await op(s, { op: 'node.start', node: n })
    await op(s, { op: 'node.complete', node: n, outcome: 'done' })
    await op(s, { op: 'node.start', node: `_report.${n}` })
    await writeFile(join(s.folder, `report-${n}.md`), `# ${n}\n`)
    await op(s, { op: 'node.complete', node: `_report.${n}`, outcome: 'reported' })
  }
  await op(s, { op: 'node.start', node: '_final-report' })
  await writeFile(join(s.folder, 'report.md'), '# Report\n')
  await op(s, { op: 'node.complete', node: '_final-report', outcome: 'done' })
  assert.equal((await record(s)).execution.state, 'completed')
})

