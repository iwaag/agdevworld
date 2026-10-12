// p7 step 2: node appearance is display only. It round-trips through YAML,
// is validated as display (warnings), and changes neither a digest, the
// compiled graph nor anything a run does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalStates, canonicalJson, semanticDigest } from '../shared/canonical.ts'
import { compile } from '../shared/compile.ts'
import { cloneWorkflow, emptyWorkflow, type Workflow } from '../shared/model.ts'
import { instantiate, SEEDS } from '../shared/catalog.ts'
import { operate, type RunGraph, type RunRecord } from '../shared/run.ts'
import { validateWorkflow } from '../shared/validate.ts'
import { parseWorkflow, renderWorkflow } from '../server/yamlDoc.ts'

const TEXT = `# a hand-written workflow
schema: ag.workflow.v2
id: w
name: W
intent: Show a result.
documentation:
  policy: default
nodes:
  build:
    type: do
    description: Build it.
  present:
    type: do
    name: Present
    appearance: {icon: present, color: teal} # how it looks
    description: Show it.
  check:
    type: talk
    confirms: result
    description: Ask.
edges:
  - {from: build, to: present}
  - {from: present, to: check}
`

function parsed(text: string): { w: Workflow; doc: NonNullable<ReturnType<typeof parseWorkflow> & { ok: true }>['doc'] } {
  const r = parseWorkflow(text)
  assert.ok(r.ok, !r.ok ? r.problem.message : '')
  return { w: r.model, doc: r.doc }
}

test('appearance is read, kept byte for byte, written in flow style and removed when cleared', () => {
  const { w, doc } = parsed(TEXT)
  assert.deepEqual(w.nodes.present.appearance, { icon: 'present', color: 'teal' })
  assert.equal(w.nodes.build.appearance, undefined)
  assert.equal(renderWorkflow(doc, w), TEXT, 'an unchanged document is written back byte for byte')

  const edit = cloneWorkflow(w)
  edit.nodes.build.appearance = { icon: 'build', color: '' }
  edit.nodes.present.appearance = { icon: 'present', color: 'rose' }
  const out = renderWorkflow(parsed(TEXT).doc, edit)
  assert.match(out, /build:\n    type: do\n    description: Build it\.\n    appearance: \{icon: build\}\n/, 'a new appearance is added to its node in flow style')
  assert.match(out, /appearance: \{icon: present, color: rose\} # how it looks/, 'the comment of an edited entry stays')
  assert.deepEqual(parsed(out).w.nodes.build.appearance, { icon: 'build', color: '' })

  const cleared = cloneWorkflow(w)
  delete cleared.nodes.present.appearance
  const plain = renderWorkflow(parsed(TEXT).doc, cleared)
  assert.doesNotMatch(plain, /appearance/)
  assert.equal(parsed(plain).w.nodes.present.appearance, undefined)
})

test('appearance changes no digest, no approval state and no compiled graph', async () => {
  const { w } = parsed(TEXT)
  const bare = cloneWorkflow(w)
  for (const n of Object.values(bare.nodes)) delete n.appearance
  for (const kind of ['intent', 'definition'] as const) assert.equal(await semanticDigest(kind, w), await semanticDigest(kind, bare), kind)
  w.approvals.definition = { digest: await semanticDigest('definition', bare), approver: 'P', at: '2026-10-12T00:00:00.000Z' }
  w.nodes.check.appearance = { icon: 'review', color: 'violet' }
  assert.equal((await approvalStates(w)).definition.status, 'approved', 'restyling an approved definition keeps it approved')
  const a = compile(w), b = compile(bare)
  assert.ok(a.ok && b.ok)
  assert.equal(canonicalJson(a.graph), canonicalJson(b.graph), 'the effective graph carries no appearance')
  // A real change is still a change.
  const renamed = cloneWorkflow(w)
  renamed.nodes.present.description = 'Show it differently.'
  assert.notEqual(await semanticDigest('definition', renamed), await semanticDigest('definition', w))
})

test('unknown icons and colors are display warnings, never errors', () => {
  const { w } = parsed(TEXT)
  w.nodes.present.appearance = { icon: 'rocket', color: '#ff0000' }
  const issues = validateWorkflow(w)
  assert.deepEqual(issues.filter(i => i.code.startsWith('appearance-')).map(i => [i.code, i.severity]), [['appearance-icon', 'warning'], ['appearance-color', 'warning']])
  assert.ok(!issues.some(i => i.severity === 'error'))
  // A wrongly shaped appearance is a shape problem like any other field.
  const r = parseWorkflow(TEXT.replace('{icon: present, color: teal}', '[present]'))
  assert.ok(!r.ok && r.problem.kind === 'shape' && /appearance/.test(r.problem.message))
})

// Since p7/ex1 the presets are the catalog's seed templates (shared/catalog.ts).
test('presets make ordinary do nodes that run like any do node', () => {
  for (const p of Object.values(SEEDS)) assert.equal(p.type, 'do')
  let w = emptyWorkflow('w', 'W')
  w.intent = 'x'; w.documentation.policy = 'manual'
  w = instantiate(w, { id: 'present', revision: 1, ...SEEDS.present }, { id: 'show' }).workflow
  w = instantiate(w, { id: 'cleanup', revision: 1, ...SEEDS.cleanup }, { id: 'tidy', after: ['show'] }).workflow
  const c = compile(w)
  assert.ok(c.ok)
  assert.deepEqual(c.graph.nodes, { show: { type: 'do' }, tidy: { type: 'do' } })
  const graph: RunGraph = { nodes: c.graph.nodes, edges: c.graph.edges }
  let at = Date.parse('2026-10-12T00:00:00.000Z')
  const ctx = () => ({ at: new Date(at += 1000).toISOString(), by: 'Agent', via: 'test', graph })
  let r: RunRecord = operate(null, { op: 'run.create', project: 'p', workflow: 'w', run: 'run-001', nodes: Object.keys(graph.nodes), input: { kind: 'braindump', file: 'braindump.md', author: 'P' }, executor: { name: 'Agent', backend: null }, predecessor: null, definition: { root: 'w', workflows: {}, warnings: [] }, context: { repositories: [] } }, ctx())
  for (const id of ['show', 'tidy']) {
    r = operate(r, { op: 'node.start', node: id }, ctx())
    r = operate(r, { op: 'node.complete', node: id, outcome: 'done' }, ctx())
  }
  assert.equal(r.execution.state, 'completed')
})
