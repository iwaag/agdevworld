// improve_wfnode p1 step 2: run semantics of examples, list groups and
// expectations. The same three examples specialize into two, five and zero
// concrete tasks in separate runs; examples cannot be performed, inflate no
// counts and do not vanish; expectations stay distinguishable and frozen.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { adjustRun, createRun, readRun, runOp } from '../server/runs.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import { compile, FINAL_STEP, reportStep, splitCounts } from '../shared/compile.ts'
import { assessmentWords, checkRecord, definitionMeaningBrief, effectiveOf, expectationStates, graphOfState, summarize, type OpInput, type RunRef } from '../shared/run.ts'
import { evaluate } from '../shared/reminders.ts'
import { runStatus } from '../shared/status.ts'
import { parseWorkflow } from '../server/yamlDoc.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-specialize-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(() => rm(root, { recursive: true, force: true }))

const example = (id: string) => `  ${id}:\n    type: do\n    name: Landscape\n    description: One landscape of the scene.\n    example: true\n    expectations:\n      - {key: webbrowser, strength: required}\n`
const concrete = (id: string, examples: string[], extra = '') => `  ${id}:\n    type: do\n    description: ${id}.\n    specializes: {examples: [${examples.join(', ')}], revision: r1}\n    expectations:\n      - {key: webbrowser, strength: required}\n${extra}`
const plain = (id: string, extra = '') => `  ${id}:\n    type: do\n    description: ${id}.\n${extra}`
const def = (nodes: string, edges: [string, string][], members: string[], policy = 'default') => `schema: ag.workflow.v2
id: world
name: World
intent: Build a world.
documentation: {policy: ${policy}}
nodes:
${nodes}edges:
${edges.map(([a, b]) => `  - {from: ${a}, to: ${b}}`).join('\n')}
groups:
  scenes:
    name: Landscape scenes
    kind: list
    cardinality: variable
    members: [${members.join(', ')}]
    description: Choose the landscapes the composition requires.
`
const EX = ['scene1', 'scene2', 'scene3']
const ORIGINAL = def(plain('design') + EX.map(example).join('') + plain('assemble'), [['design', 'scene1'], ['design', 'scene2'], ['design', 'scene3'], ['scene1', 'assemble'], ['scene2', 'assemble'], ['scene3', 'assemble']], EX)

let k = 0
async function setup(text = ORIGINAL) {
  const area = join(root, `area-${++k}`)
  const dir = join(area, 'pj-p')
  const registry = join(area, 'registry.json')
  const r = await createProject({ dir, id: 'p', name: 'P', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'world.yaml'), text)
  await writeFile(join(dir, 'shown.html'), '<p>shown</p>')
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  const newRun = async () => (await createRun(ws, { workflow: 'world', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'a world', author: 'Pat' } })).ref
  return { ws, dir, ref: await newRun(), newRun }
}
const op = (ws: Workspace, ref: RunRef, o: OpInput) => runOp(ws, ref, o, { by: 'agent', via: 'cli' })
const rec = async (ws: Workspace, ref: RunRef) => { const r = await readRun(ws, ref); assert.ok(r.record, r.problem?.message); return r.record! }
const code = (e: unknown) => ((e as RequestError).detail as { code?: string } | undefined)?.code
const adjust = (ws: Workspace, ref: RunRef, text: string, reason = 'the composition needs these', dryRun = false) => adjustRun(ws, ref, { text, reason, source: { kind: 'agent' }, dryRun }, { by: 'agent', via: 'cli' })
const applied = async (ws: Workspace, ref: RunRef, text: string, reason?: string) => { const r = await adjust(ws, ref, text, reason); assert.ok(r.ok, JSON.stringify(r.problems)); return r }
const finish = async (ws: Workspace, ref: RunRef, ids: string[]) => { for (const node of ids) { await op(ws, ref, { op: 'node.start', node }); await op(ws, ref, { op: 'node.complete', node, outcome: `${node} done` }) } }
const replays = async (ws: Workspace, ref: RunRef, dir: string, run: string) => {
  const r = await rec(ws, ref)
  const raw = JSON.parse(await readFile(join(dir, 'devdocs', 'runs', 'world', run, 'run.json'), 'utf8'))
  const parsed = parseWorkflow(ORIGINAL)
  assert.ok(parsed.ok)
  const original = compile(parsed.model)
  assert.ok(original.ok)
  const check = checkRecord(raw, { nodes: original.graph.nodes, edges: original.graph.edges, groups: original.graph.groups })
  assert.ok(check.ok, check.ok ? '' : check.message)
  return r
}

test('compile: an example keeps its meaning and gets no report; what follows waits for it; meanings and groups are frozen', () => {
  const p = parseWorkflow(ORIGINAL)
  assert.ok(p.ok)
  const c = compile(p.model)
  assert.ok(c.ok)
  assert.equal(c.graph.nodes.scene1.example, true)
  assert.deepEqual(c.graph.nodes.scene1.expectations, [{ key: 'webbrowser', strength: 'required' }])
  assert.equal(c.graph.nodes[reportStep('scene1')], undefined)
  assert.ok(c.graph.edges.some(e => e.from === 'scene1' && e.to === 'assemble'))
  assert.ok(c.graph.edges.some(e => e.from === reportStep('design') && e.to === 'scene1'))
  assert.deepEqual(c.graph.groups?.scenes.members, EX)
  assert.match(c.graph.meanings?.webbrowser.meaning ?? '', /web browser/)
  // The list order makes no edge between members.
  assert.ok(!c.graph.edges.some(e => EX.includes(e.from) && EX.includes(e.to)))
})

test('an example terminal node holds the final report until it is resolved', () => {
  const p = parseWorkflow(def(plain('design') + example('scene1'), [['design', 'scene1']], ['scene1']))
  assert.ok(p.ok)
  const c = compile(p.model)
  assert.ok(c.ok)
  assert.ok(c.graph.edges.some(e => e.from === 'scene1' && e.to === FINAL_STEP))
})

test('an example is not offered, cannot be started or cancelled, and counts for nothing', async () => {
  const { ws, ref } = await setup()
  await finish(ws, ref, ['_plan', 'design', reportStep('design')])
  const r = await rec(ws, ref)
  assert.deepEqual(r.execution.examples, EX)
  assert.deepEqual(r.execution.ready, [])
  assert.ok(!r.execution.blocked.some(n => EX.includes(n)))
  assert.equal(r.execution.counts.pending, 3) // assemble, its report, the final report: no example
  const split = splitCounts(effectiveOf(r)!, r.nodes)
  assert.equal(split.work.completed, 1)
  assert.equal(split.work.pending, 1)
  assert.equal(r.execution.state, 'in-progress')
  await assert.rejects(op(ws, ref, { op: 'node.start', node: 'scene1' }), (e: unknown) => code(e) === 'example-not-executable' && /model for concrete work/.test((e as Error).message))
  await assert.rejects(op(ws, ref, { op: 'node.cancel', node: 'scene1', reason: 'skip' }), (e: unknown) => code(e) === 'example-not-executable')
  assert.equal(r.nodes.scene1.state, 'pending')
  // The agent is told what they are.
  assert.match(definitionMeaningBrief(r).join('\n'), /Examples not yet specialized: scene1, scene2, scene3/)
  assert.match(definitionMeaningBrief(r).join('\n'), /Landscape scenes.*list, variable/)
})

test('an attempt that ends with examples unresolved is held, naming them', async () => {
  const { ws, ref } = await setup(def(example('scene1'), [], ['scene1'], 'manual').replace('edges:\n', 'edges: []\n'))
  await op(ws, ref, { op: 'attempt.begin', attempt: 'a1', reason: 'test' } as never)
  await op(ws, ref, { op: 'attempt.end', attempt: 'a1', outcome: 'exited', explain: 'cause' } as never)
  const r = await rec(ws, ref)
  assert.equal(r.control.hold?.cause?.code, 'left-examples')
  assert.match(runStatus(r).text, /scene1 not specialized at exit/i)
})

test('the same examples specialize into two tasks: group identity, provenance, membership and history', async () => {
  const { ws, ref, dir } = await setup()
  await finish(ws, ref, ['_plan', 'design', reportStep('design')])
  const two = def(plain('design') + concrete('coast', ['scene1', 'scene2']) + concrete('forest', ['scene3']) + plain('assemble'),
    [['design', 'coast'], ['design', 'forest'], ['coast', 'assemble'], ['forest', 'assemble']], ['forest', 'coast'])
  const res = await applied(ws, ref, two, 'A coast and a forest are what the composition needs.')
  assert.equal(res.revision, 'r2')
  assert.deepEqual(res.authored.groups?.changed, [{ id: 'scenes', fields: ['members'] }])
  const r = await rec(ws, ref)
  assert.equal(r.execution.examples, undefined)
  assert.deepEqual(r.execution.ready, ['coast', 'forest'])
  assert.deepEqual(effectiveOf(r)!.groups?.scenes.members, ['forest', 'coast'])
  const rev = r.definition.revisions![0]
  assert.deepEqual(rev.examples, [{ example: 'scene1', group: 'scenes', replacedBy: ['coast'] }, { example: 'scene2', group: 'scenes', replacedBy: ['coast'] }, { example: 'scene3', group: 'scenes', replacedBy: ['forest'] }])
  assert.deepEqual(rev.diff.groups, { added: [], removed: [], changed: ['scenes'], reordered: [] })
  // The original revision keeps the examples and their membership.
  assert.deepEqual(r.definition.effective?.groups?.scenes.members, EX)
  assert.equal(r.definition.effective?.nodes.scene1.example, true)
  assert.equal(effectiveOf(r)!.nodes.coast.specializes?.revision, 'r1')
  await finish(ws, ref, ['coast', reportStep('coast'), 'forest', reportStep('forest'), 'assemble', reportStep('assemble')])
  await replays(ws, ref, dir, ref.run)
})

test('and into five in another run of the same definition, chained, ending completed', async () => {
  const { ws, ref, newRun } = await setup()
  const other = await newRun()
  const ids = ['a', 'b', 'c', 'd', 'e']
  const five = def(plain('design') + ids.map(i => concrete(i, EX)).join('') + plain('assemble'), [['design', 'a'], ['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'assemble']], ids)
  await applied(ws, other, five)
  assert.deepEqual((await rec(ws, ref)).definition.effective?.groups?.scenes.members, EX) // the first run is untouched
  await finish(ws, other, ['_plan', 'design', reportStep('design'), ...ids.flatMap(i => [i, reportStep(i)]), 'assemble', reportStep('assemble'), FINAL_STEP])
  const r = await rec(ws, other)
  assert.equal(r.execution.state, 'completed')
  assert.equal(Object.keys(r.nodes).filter(n => !n.startsWith('_')).length, 7)
})

test('zero items: the boundary must be repaired explicitly, the list stays and the omission is recorded', async () => {
  const { ws, ref } = await setup()
  const none = (edges: [string, string][]) => def(plain('design') + plain('assemble'), edges, [])
  const lost = await adjust(ws, ref, none([]), 'no landscapes needed', true)
  assert.equal(lost.ok, false)
  const boundary = lost.problems.find(p => p.code === 'example-boundary')
  assert.match(boundary?.message ?? '', /design led through it to assemble.*from: design, to: assemble/)
  await applied(ws, ref, none([['design', 'assemble']]), 'This scene is an interior: it needs no landscapes.')
  const r = await rec(ws, ref)
  assert.deepEqual(effectiveOf(r)!.groups?.scenes, { name: 'Landscape scenes', kind: 'list', cardinality: 'variable', description: 'Choose the landscapes the composition requires.', members: [] })
  assert.deepEqual(r.definition.revisions![0].examples?.map(x => x.replacedBy), [[], [], []])
  assert.match(r.definition.revisions![0].reason, /interior/)
  assert.equal(r.execution.examples, undefined)
})

test('replacements must take over the boundary; provenance must name real examples', async () => {
  const { ws, ref } = await setup()
  const without = await adjust(ws, ref, def(plain('design') + concrete('coast', EX) + plain('assemble'), [['design', 'assemble']], ['coast']), 'r', true)
  assert.match(without.problems.map(p => p.message).join(' '), /waited for design, and none of its replacements/)
  const fake = await adjust(ws, ref, def(plain('design') + concrete('coast', ['nothing']) + EX.map(example).join('') + plain('assemble'), [['design', 'coast'], ['design', 'scene1'], ['design', 'scene2'], ['design', 'scene3'], ['scene1', 'assemble'], ['scene2', 'assemble'], ['scene3', 'assemble']], ['coast', ...EX]), 'r', true)
  assert.ok(fake.problems.some(p => p.code === 'specializes-unknown'))
  const dangling = await adjust(ws, ref, def(plain('design') + concrete('coast', EX) + plain('assemble'), [['design', 'coast'], ['coast', 'assemble']], ['coast', 'scene1']), 'r', true)
  assert.match(dangling.problems.map(p => p.message).join(' '), /lists member "scene1", which is not a node/)
})

test('in place: an example may become the work; a node with history may not become an example', async () => {
  const { ws, ref } = await setup()
  const inPlace = ORIGINAL.replace('    example: true\n', '')
  await applied(ws, ref, inPlace)
  const r = await rec(ws, ref)
  assert.deepEqual(r.definition.revisions![0].examples, [{ example: 'scene1', group: 'scenes', replacedBy: ['scene1'] }])
  assert.deepEqual(r.execution.examples, ['scene2', 'scene3'])
  await finish(ws, ref, ['_plan', 'design'])
  const marked = await adjust(ws, ref, inPlace.replace('  design:\n    type: do\n    description: design.\n', '  design:\n    type: do\n    description: design.\n    example: true\n'), 'r', true)
  assert.ok(marked.problems.some(p => p.code === 'example-history'), JSON.stringify(marked.problems))
})

test('a stale revision is refused for a specialization like any other', async () => {
  const { ws, ref } = await setup()
  const r = await adjustRun(ws, ref, { text: ORIGINAL.replace('    example: true\n', ''), reason: 'r', source: { kind: 'agent' }, expectRevision: 'r9' }, { by: 'agent', via: 'cli' })
  assert.ok(r.problems.some(p => p.code === 'revision-outdated'))
})

test('expectations: required unmet, preferred alternative and unverified stay distinct; evidence is checked', async () => {
  const text = def(plain('show', '    expectations:\n      - {key: webbrowser, strength: required}\n      - {key: native, note: On the review PC.}\n      - {key: s3}\n      - {key: hologram, strength: required, note: Later.}\n'), [], [], 'manual').replace('edges:\n', 'edges: []\n')
  const { ws, ref } = await setup(text)
  await op(ws, ref, { op: 'node.start', node: 'show' })
  // Completing a node states nothing.
  await op(ws, ref, { op: 'node.complete', node: 'show', outcome: 'shown', artifacts: ['shown.html'] })
  let r = await rec(ws, ref)
  assert.deepEqual(expectationStates(r).map(assessmentWords), ['Unverified', 'Unverified', 'Unverified', 'Unverified'])
  assert.match(runStatus(r).text, /Done · Every step completed$/)
  await assert.rejects(op(ws, ref, { op: 'expectation.assess', node: 'show', key: 'webbrowser', status: 'met' }), (e: unknown) => code(e) === 'expectation-evidence')
  await assert.rejects(op(ws, ref, { op: 'expectation.assess', node: 'show', key: 'native', status: 'unmet' }), (e: unknown) => code(e) === 'expectation-evidence')
  await assert.rejects(op(ws, ref, { op: 'expectation.assess', node: 'show', key: 'nfs', status: 'met', note: 'x' }), (e: unknown) => code(e) === 'expectation-unknown')
  await assert.rejects(op(ws, ref, { op: 'expectation.assess', node: 'show', key: 'webbrowser', status: 'met', claims: { artifacts: ['missing.html'] } }), (e: unknown) => code(e) === 'evidence-unknown')
  await op(ws, ref, { op: 'expectation.assess', node: 'show', key: 'webbrowser', status: 'met', claims: { artifacts: ['shown.html'] } })
  await op(ws, ref, { op: 'expectation.assess', node: 'show', key: 'native', status: 'unmet', note: 'Browser only; no display on this worker.' })
  await op(ws, ref, { op: 'expectation.assess', node: 'show', key: 'hologram', status: 'unmet', note: 'No hologram exists.' })
  r = await rec(ws, ref)
  assert.deepEqual(expectationStates(r).map(x => [x.key, assessmentWords(x)]), [['webbrowser', 'Met'], ['native', 'Alternative'], ['s3', 'Unverified'], ['hologram', 'Unmet']])
  assert.equal(expectationStates(r)[0].assessment?.evidence[0].kind, 'artifact')
  assert.equal(expectationStates(r)[0].assessment?.reporter, 'person')
  // Finished work leaves a required unmet expectation visible.
  assert.equal(r.execution.state, 'completed')
  const st = runStatus(r)
  assert.equal(st.tone, 'warn')
  assert.match(st.text, /required unmet: hologram on show/)
  assert.equal(summarize(r, graphOfState(r)!).state, 'completed')
})

test('a run keeps the words it was created with: a later definition edit changes nothing', async () => {
  const { ws, ref, dir } = await setup()
  const before = effectiveOf(await rec(ws, ref))
  await writeFile(join(dir, 'devdocs', 'workflows', 'world.yaml'), ORIGINAL.replace('strength: required', 'strength: preferred').replace('Landscape scenes', 'Other'))
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'later'])
  const r = await rec(ws, ref)
  assert.deepEqual(effectiveOf(r), before)
  assert.equal(effectiveOf(r)!.nodes.scene1.expectations![0].strength, 'required')
})

test('completing a node with expectations nobody stated is a reminder that says what to record', async () => {
  const text = def(plain('show', '    expectations:\n      - {key: webbrowser, strength: required}\n      - {key: native}\n'), [], [], 'manual').replace('edges:\n', 'edges: []\n')
  const { ws, ref } = await setup(text)
  await op(ws, ref, { op: 'node.start', node: 'show' })
  const facts = (r: Awaited<ReturnType<typeof rec>>) => ({ record: r, after: r, graph: graphOfState(r)!, authored: undefined, catalog: { state: 'none' as const } })
  const said = evaluate({ kind: 'complete', node: 'show' }, facts(await rec(ws, ref))).find(x => x.code === 'expectation-unstated')
  assert.match(said?.text ?? '', /webbrowser \(required\), native \(preferred\)/)
  assert.equal(said?.repair.length, 2)
  await op(ws, ref, { op: 'expectation.assess', node: 'show', key: 'webbrowser', status: 'unverified' })
  const fewer = evaluate({ kind: 'complete', node: 'show' }, facts(await rec(ws, ref))).find(x => x.code === 'expectation-unstated')
  assert.deepEqual(fewer?.repair.length, 1) // saying it could not be checked is a statement
  await op(ws, ref, { op: 'expectation.assess', node: 'show', key: 'native', status: 'met', note: 'It launches.' })
  assert.equal(evaluate({ kind: 'complete', node: 'show' }, facts(await rec(ws, ref))).some(x => x.code === 'expectation-unstated'), false)
})
