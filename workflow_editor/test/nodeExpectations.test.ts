// improve_wfnode p1 step 1: expectations, example status and explicit list
// groups in the definition contract: reading, validation, the digest and the
// round trip through the file (docs/contract.md).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { semanticDigest } from '../shared/canonical.ts'
import { cloneWorkflow, workflowFromData } from '../shared/model.ts'
import { validateWorkflow } from '../shared/validate.ts'
import { parseWorkflow, renderWorkflow } from '../server/yamlDoc.ts'

const TEXT = `schema: ag.workflow.v2
id: world
name: World
intent: Build the world.
documentation: {policy: default}
nodes:
  # the scenes are examples
  scene_example_1:
    type: delegate
    name: Scene one
    description: A landscape.
    workflow: scene
    example: true
    expectations:
      - key: webbrowser
        strength: required
      - key: native
        note: Launchable on the person's review PC.
      - key: hologram
        note: Whatever comes next.
    future_field: kept
  scene_example_2: {type: delegate, name: Scene two, description: Another., workflow: scene, example: true}
  scene_example_3: {type: delegate, name: Scene three, description: Another., workflow: scene, example: true}
  assemble: {type: do, name: Assemble, description: Put it together.}
edges:
  - {from: scene_example_1, to: assemble}
groups:
  scenes:
    name: Landscape scenes
    kind: list
    cardinality: variable
    members:
      - scene_example_1
      - scene_example_2
      - scene_example_3
    description: Choose the landscapes the composition requires.
    owner_note: kept too
`
const read = (text = TEXT) => {
  const p = parseWorkflow(text)
  assert.ok(p.ok, p.ok ? '' : p.problem.message)
  return p as Extract<typeof p, { ok: true }>
}
const codes = (w: Parameters<typeof validateWorkflow>[0]) => validateWorkflow(w).filter(i => i.severity === 'error').map(i => i.code)

test('the file reads into expectations, example status and a group, without errors', () => {
  const { model: w } = read()
  assert.equal(w.nodes.scene_example_1.example, true)
  assert.equal(w.nodes.assemble.example, undefined)
  assert.deepEqual(w.nodes.scene_example_1.expectations, [{ key: 'webbrowser', strength: 'required' }, { key: 'native', note: 'Launchable on the person\'s review PC.' }, { key: 'hologram', note: 'Whatever comes next.' }])
  assert.deepEqual(w.groups?.scenes.members, ['scene_example_1', 'scene_example_2', 'scene_example_3'])
  assert.deepEqual(codes(w), [])
  // An unknown key is preserved and said, not refused.
  assert.ok(validateWorkflow(w).some(i => i.code === 'expectation-unknown' && i.severity === 'warning' && /hologram/.test(i.message)))
})

test('a definition with none of the fields keeps its meaning and writes none of them', async () => {
  const plain = TEXT.replace(/ {4}example: true\n/, '').replace(/example: true/g, 'name2: x').replace(/ {4}expectations:[\s\S]*?future_field/, '    future_field').replace(/groups:[\s\S]*$/, '')
  const p = read(plain)
  assert.equal(p.model.groups, undefined)
  const out = renderWorkflow(p.doc, p.model)
  assert.doesNotMatch(out, /^groups:|example:|expectations:|specializes:/m)
})

test('round trip: an untouched file is unchanged; unknown content and comments survive edits', () => {
  const p = read()
  assert.equal(renderWorkflow(p.doc, p.model), TEXT)
  const q = read()
  q.model.groups!.scenes.members.reverse()
  q.model.nodes.assemble.expectations = [{ key: 'human', strength: 'required', note: 'For the person.' }]
  const out = renderWorkflow(q.doc, q.model)
  assert.match(out, /# the scenes are examples/)
  assert.match(out, /future_field: kept/)
  assert.match(out, /owner_note: kept too/)
  const back = read(out)
  assert.deepEqual(back.model.groups?.scenes.members, ['scene_example_3', 'scene_example_2', 'scene_example_1'])
  assert.deepEqual(back.model.nodes.assemble.expectations, [{ key: 'human', strength: 'required', note: 'For the person.' }])
})

test('an empty list stays representable; removing the only group removes it from the file', () => {
  const p = read()
  p.model.groups!.scenes.members = []
  const out = renderWorkflow(p.doc, p.model)
  assert.match(out, /members: \[\]|members:\s*\[\]/)
  assert.deepEqual(read(out).model.groups?.scenes.members, [])
  const q = read()
  delete q.model.groups
  assert.doesNotMatch(renderWorkflow(q.doc, q.model), /^groups:/m)
})

test('the digest follows meaning: member order, example status, strength; not layout, color or expectation order', async () => {
  const base = read().model
  const digest = (w: typeof base) => semanticDigest('definition', w)
  const d0 = await digest(base)
  const changed = async (f: (w: typeof base) => void) => { const w = cloneWorkflow(base); f(w); return digest(w) }
  assert.notEqual(await changed(w => { w.groups!.scenes.members.reverse() }), d0)
  assert.notEqual(await changed(w => { delete w.nodes.scene_example_2.example }), d0)
  assert.notEqual(await changed(w => { w.nodes.scene_example_1.expectations![0].strength = 'preferred' }), d0)
  assert.notEqual(await changed(w => { w.groups!.scenes.name = 'Scenes' }), d0)
  assert.equal(await changed(w => { w.layout.nodes.assemble = { x: 1, y: 2 } }), d0)
  assert.equal(await changed(w => { w.groups!.scenes.appearance = { color: 'teal' } }), d0)
  assert.equal(await changed(w => { w.nodes.scene_example_1.expectations!.reverse() }), d0)
  // Omitted strength means preferred.
  assert.equal(await changed(w => { w.nodes.scene_example_1.expectations![1].strength = 'preferred' }), d0)
})

test('invalid membership and strengths are actionable errors, kept for repair', () => {
  const broken = (f: (w: ReturnType<typeof read>['model']) => void) => { const w = cloneWorkflow(read().model); f(w); return validateWorkflow(w).filter(i => i.severity === 'error') }
  assert.match(broken(w => { w.groups!.scenes.members.push('nowhere') })[0].message, /"nowhere", which is not a node/)
  assert.deepEqual(broken(w => { w.groups!.scenes.members.push('scene_example_1') }).map(i => i.code), ['group-member-duplicate'])
  assert.deepEqual(broken(w => { w.groups!.other = { name: 'Other', kind: 'list', cardinality: 'variable', description: '', members: ['scene_example_2'] } }).map(i => i.code), ['group-member-overlap'])
  assert.match(broken(w => { w.groups!.scenes.members.push('_report.assemble') })[0].message, /generated documentation step/)
  assert.deepEqual(broken(w => { w.groups!.scenes.kind = 'bag' }).map(i => i.code), ['group-kind'])
  assert.deepEqual(broken(w => { w.groups!.scenes.cardinality = '1..3' }).map(i => i.code), ['group-cardinality'])
  assert.deepEqual(broken(w => { w.groups!.scenes.name = ' ' }).map(i => i.code), ['group-name'])
  assert.match(broken(w => { w.nodes.scene_example_1.expectations![0].strength = 'mandatory' })[0].message, /strength "mandatory"; expected preferred or required/)
  assert.deepEqual(broken(w => { w.nodes.assemble.expectations = [{ key: 'human' }, { key: 'human' }] }).map(i => i.code), ['expectation-duplicate'])
  assert.deepEqual(broken(w => { w.nodes.assemble.expectations = [{ key: 'Not A Key' }] }).map(i => i.code), ['expectation-key'])
  assert.deepEqual(broken(w => { w.nodes.assemble.specializes = { examples: [], revision: 'latest' } }).map(i => i.code), ['specializes-revision', 'specializes-examples'])
})

test('wrongly shaped fields are shape issues, not silently dropped', () => {
  const issues = (over: Record<string, unknown>, top: Record<string, unknown> = {}) => workflowFromData({ schema: 'ag.workflow.v2', id: 'w', nodes: { a: { type: 'do', ...over } }, ...top }).issues.map(i => i.path)
  assert.deepEqual(issues({ example: 'yes' }), ['$.nodes.a.example'])
  assert.deepEqual(issues({ expectations: ['webbrowser'] }), ['$.nodes.a.expectations[0]'])
  assert.deepEqual(issues({ expectations: 'webbrowser' }), ['$.nodes.a.expectations'])
  assert.deepEqual(issues({}, { groups: ['scenes'] }), ['$.groups'])
  assert.deepEqual(issues({}, { groups: { scenes: 'x' } }), ['$.groups.scenes'])
  assert.deepEqual(issues({}, { groups: { scenes: { name: 'S', members: 'a' } } }), ['$.groups.scenes.members'])
})
