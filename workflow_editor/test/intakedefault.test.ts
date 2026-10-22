// workflow_editor fix2: intake is on unless the file opts out. In
// front/converse/run-045 Front could not delegate to aghangout/change or
// freework because their files had no intake, which the loader read as off
// while every new workflow was created with requests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { definitionProjection, semanticDigest } from '../shared/canonical.ts'
import { emptyWorkflow, type Workflow } from '../shared/model.ts'
import { validateWorkflow } from '../shared/validate.ts'
import { newWorkflowText, parseWorkflow, renderWorkflow } from '../server/yamlDoc.ts'

const HEAD = `schema: ag.workflow.v2
id: w
name: W
intent: x
documentation: {policy: default}
`
const TAIL = `nodes:
  a: {type: talk, description: d}
`
const read = (intake: string) => {
  const r = parseWorkflow(HEAD + intake + TAIL)
  return r
}

test('omitted intake, an empty mapping or an omitted zulip read as requests', () => {
  for (const intake of ['', 'intake: {}\n', 'intake:\n', 'intake: {zulip: null}\n', 'intake: {zulip: requests}\n']) {
    const r = read(intake)
    assert.ok(r.ok, intake)
    assert.equal(r.model.intake.zulip, 'requests', JSON.stringify(intake))
    assert.deepEqual(validateWorkflow(r.model).filter(i => i.severity === 'error'), [], intake)
  }
})

test('zulip: "" is the opt-out and stays one', () => {
  const r = read('intake: {zulip: ""}\n')
  assert.ok(r.ok)
  assert.equal(r.model.intake.zulip, '')
  assert.deepEqual(validateWorkflow(r.model).filter(i => i.severity === 'error'), [])
})

test('invalid types are shape problems, never the default or the opt-out', () => {
  for (const intake of ['intake: {zulip: 1}\n', 'intake: {zulip: true}\n', 'intake: {zulip: [requests]}\n', 'intake: {zulip: {a: b}}\n', 'intake: requests\n', 'intake: [requests]\n', 'intake: ""\n']) {
    const r = read(intake)
    assert.ok(!r.ok, intake)
    assert.equal(r.problem.kind, 'shape', intake)
    assert.match(r.problem.message, /\$\.intake/, intake)
  }
  const r = read('intake: {zulip: everything}\n')
  assert.ok(r.ok)
  assert.deepEqual(validateWorkflow(r.model).filter(i => i.severity === 'error').map(i => i.code), ['intake-mode'])
})

test('edit, save and reload keep enabled and disabled intake apart', () => {
  // A file without intake, edited and saved: it stays enabled and keeps
  // its text (no declaration is added).
  const plain = read('')
  assert.ok(plain.ok)
  plain.model.nodes.a.description = 'edited'
  const plainText = renderWorkflow(plain.doc, plain.model)
  assert.doesNotMatch(plainText, /intake/)
  const saved = parseWorkflow(plainText)
  assert.ok(saved.ok)
  assert.equal(saved.model.intake.zulip, 'requests')
  // Turned off where the file had no key: the opt-out is written.
  saved.model.intake.zulip = ''
  const offText = renderWorkflow(saved.doc, saved.model)
  assert.match(offText, /intake:\n {2}zulip: ""/)
  const off = parseWorkflow(offText)
  assert.ok(off.ok)
  assert.equal(off.model.intake.zulip, '')
  // An unrelated edit keeps it off; turning it on writes requests.
  off.model.nodes.a.description = 'again'
  const still = parseWorkflow(renderWorkflow(off.doc, off.model))
  assert.ok(still.ok)
  assert.equal(still.model.intake.zulip, '')
  still.model.intake.zulip = 'requests'
  const on = parseWorkflow(renderWorkflow(still.doc, still.model))
  assert.ok(on.ok)
  assert.equal(on.model.intake.zulip, 'requests')
  // A new file (export, template, basic) declares either value.
  for (const zulip of ['requests', '']) {
    const w: Workflow = { ...emptyWorkflow('n', 'N'), intent: 'x', intake: { zulip } }
    const text = newWorkflowText(w)
    assert.match(text, zulip ? /zulip: requests/ : /zulip: ""/)
    const again = parseWorkflow(text)
    assert.ok(again.ok)
    assert.equal(again.model.intake.zulip, zulip)
  }
  // An empty mapping is kept as the file wrote it.
  const empty = read('intake: {}\n')
  assert.ok(empty.ok)
  assert.match(renderWorkflow(empty.doc, empty.model), /intake: \{\}/)
})

test('the canonical definition: omitted equals requests, the opt-out differs', async () => {
  const omitted = read(''), explicit = read('intake: {zulip: requests}\n'), off = read('intake: {zulip: ""}\n')
  assert.ok(omitted.ok && explicit.ok && off.ok)
  assert.deepEqual((definitionProjection(omitted.model) as Record<string, unknown>).intake, { zulip: 'requests' })
  assert.deepEqual((definitionProjection(off.model) as Record<string, unknown>).intake, { zulip: '' })
  assert.equal(await semanticDigest('definition', omitted.model), await semanticDigest('definition', explicit.model))
  assert.notEqual(await semanticDigest('definition', off.model), await semanticDigest('definition', explicit.model))
})
