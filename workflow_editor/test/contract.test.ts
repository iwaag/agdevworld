// Step 1: the file contract — YAML subset, model reading, validation,
// canonicalization and semantic digests, and round-trip preservation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { approvalStates, canonicalJson, normalizeText, semanticDigest } from '../shared/canonical.ts'
import { cloneWorkflow, type Workflow } from '../shared/model.ts'
import { delegateTargets, validateWorkflow, type RepositoryInfo, type ValidationContext, type WorkflowRef } from '../shared/validate.ts'
import { newWorkflowText, parseProject, parseWorkflow, renderWorkflow, STRINGIFY } from '../server/yamlDoc.ts'

const examples = new URL('../examples/', import.meta.url).pathname
const read = (p: string) => readFile(join(examples, p), 'utf8')

async function load(p: string): Promise<Workflow> {
  const r = parseWorkflow(await read(p))
  assert.ok(r.ok, `${p} should parse: ${!r.ok ? r.problem.message : ''}`)
  return r.model
}

const repos: RepositoryInfo[] = [
  { path: '.', kind: 'root', initialized: true },
  { path: 'devdocs', kind: 'submodule', initialized: true },
  { path: 'study/agentic-patterns', kind: 'submodule', initialized: true },
  { path: 'study/tools', kind: 'submodule', initialized: true },
  { path: 'wedo/runtime', kind: 'submodule', initialized: true },
  { path: 'wedo/pipeline', kind: 'submodule', initialized: true },
  { path: 'assets/shared', kind: 'submodule', initialized: false },
]

async function projectContext(file: string): Promise<ValidationContext> {
  const workflows: WorkflowRef[] = []
  for (const f of ['onboarding.yaml', 'repo-setup.yaml', 'draft-gaps.yaml']) {
    const w = await load(`project/workflows/${f}`)
    workflows.push({ id: w.id, file: f, delegates: delegateTargets(w) })
  }
  return { repositories: repos, workflows, file }
}

const codes = (issues: { code: string; severity: string }[], severity = 'error') =>
  issues.filter(i => i.severity === severity).map(i => i.code).sort()

test('example project and valid workflows parse and validate cleanly', async () => {
  const p = parseProject(await read('project/project.yaml'))
  assert.ok(p.ok)
  assert.equal(p.model.id, 'demo')
  assert.equal(p.model.goals.length, 3)
  const onboarding = await load('project/workflows/onboarding.yaml')
  assert.deepEqual(codes(validateWorkflow(onboarding, await projectContext('onboarding.yaml'))), [])
  const types = new Set(Object.values(onboarding.nodes).map(n => n.type))
  assert.deepEqual([...types].sort(), ['delegate', 'do', 'study', 'talk'])
  // parallel branch from survey, all-predecessor join at integrate
  assert.equal(onboarding.edges.filter(e => e.from === 'survey').length, 2)
  assert.equal(onboarding.edges.filter(e => e.to === 'integrate').length, 2)
  assert.deepEqual(codes(validateWorkflow(await load('project/workflows/repo-setup.yaml'), await projectContext('repo-setup.yaml'))), [])
})

test('the gaps draft reports each broken reference', async () => {
  const w = await load('project/workflows/draft-gaps.yaml')
  const issues = validateWorkflow(w, await projectContext('draft-gaps.yaml'))
  assert.deepEqual(codes(issues), ['delegate-target-unknown', 'edge-to-missing', 'node-binding-missing', 'repository-missing'])
  assert.ok(codes(issues, 'warning').includes('repository-uninitialized'))
})

test('unsupported YAML is rejected without a model', async () => {
  const malformed = parseWorkflow(await read('invalid/malformed.yaml'))
  assert.ok(!malformed.ok && malformed.problem.kind === 'malformed')
  assert.ok(!malformed.ok && malformed.problem.line !== undefined)
  const anchor = parseWorkflow(await read('invalid/anchor.yaml'))
  assert.ok(!anchor.ok && anchor.problem.kind === 'unsupported' && /anchor/.test(anchor.problem.message))
  const shape = parseWorkflow(await read('invalid/shape.yaml'))
  assert.ok(!shape.ok && shape.problem.kind === 'shape')
  for (const [text, pattern] of [
    ['a: 1\n---\nb: 2\n', /multiple/],
    ['a: !!str 1\n', /tags/],
    ['base: {x: 1}\nother:\n  <<: {y: 2}\n', /merge/],
    ['? [a, b]\n: 1\n', /keys/],
  ] as const) {
    const r = parseWorkflow(text)
    assert.ok(!r.ok && pattern.test(r.problem.message), `${JSON.stringify(text)} -> ${!r.ok ? r.problem.message : 'ok'}`)
  }
  const dup = parseWorkflow('id: a\nid: b\n')
  assert.ok(!dup.ok && dup.problem.kind === 'malformed')
})

test('cycles and recursive delegation are errors', async () => {
  const cycle = await load('invalid/cycle.yaml')
  assert.ok(codes(validateWorkflow(cycle)).includes('graph-cycle'))
  const a = await load('invalid/recursive-a.yaml')
  const b = await load('invalid/recursive-b.yaml')
  const ctx: ValidationContext = {
    workflows: [a, b].map((w, i) => ({ id: w.id, file: `r${i}.yaml`, delegates: delegateTargets(w) })),
    file: 'r0.yaml',
  }
  assert.ok(codes(validateWorkflow(a, ctx)).includes('delegate-recursive'))
  const self = cloneWorkflow(a)
  self.nodes['call-b'].workflow = 'recursive-a'
  assert.ok(codes(validateWorkflow(self, ctx)).includes('delegate-self'))
})

test('duplicate workflow ids, bad paths, types and access are reported', async () => {
  const w = await load('project/workflows/repo-setup.yaml')
  const ctx = await projectContext('copy.yaml')
  assert.ok(codes(validateWorkflow(w, ctx)).includes('id-duplicate'))
  const bad = cloneWorkflow(w)
  bad.repositories.tools = { path: '../outside', access: 'write' }
  bad.nodes.check.type = 'review'
  bad.nodes.scaffold.workflow = 'x'
  bad.edges.push({ from: 'check', to: 'check' })
  const issues = validateWorkflow(bad, await projectContext('repo-setup.yaml'))
  // A self-edge is reported as such; cycle detection covers longer loops.
  assert.deepEqual(codes(issues), ['binding-access', 'binding-path-invalid', 'edge-self', 'node-type'])
  assert.ok(codes(issues, 'warning').includes('workflow-on-non-delegate'))
})

test('canonical JSON sorts keys and is whitespace-free', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}')
  assert.equal(normalizeText('\r\n line one  \r\nline two\t\n\n'), ' line one\nline two')
})

test('digests ignore formatting, layout, approvals, order, name and id', async () => {
  const w = await load('project/workflows/onboarding.yaml')
  const base = { intent: await semanticDigest('intent', w), definition: await semanticDigest('definition', w) }
  const reordered = cloneWorkflow(w)
  reordered.edges.reverse()
  reordered.nodes = Object.fromEntries(Object.entries(w.nodes).reverse())
  reordered.repositories = Object.fromEntries(Object.entries(w.repositories).reverse())
  reordered.nodes.integrate.repositories.reverse()
  reordered.layout.nodes.survey = { x: 999, y: 1 }
  reordered.approvals.intent = { digest: 'sha256:x', approver: 'someone', at: 'now' }
  reordered.name = 'Renamed'
  reordered.intent = `${w.intent.trimEnd()}   \n\n`
  reordered.repositories.docs.path = './devdocs/'
  assert.equal(await semanticDigest('intent', reordered), base.intent)
  assert.equal(await semanticDigest('definition', reordered), base.definition)
  // The YAML text form does not matter either: same content, different style.
  const restyled = parseWorkflow((await read('project/workflows/onboarding.yaml')).replace(/^# .*\n/m, '# other comment\n').replace('intent: |', 'intent: |-'))
  assert.ok(restyled.ok)
  assert.equal(await semanticDigest('definition', restyled.model), base.definition)
})

test('semantic edits make the right approvals stale', async () => {
  const w = await load('project/workflows/onboarding.yaml')
  w.approvals = { intent: { digest: await semanticDigest('intent', w), approver: 'a', at: 't' }, definition: { digest: await semanticDigest('definition', w), approver: 'a', at: 't' } }
  const status = async (x: Workflow) => { const s = await approvalStates(x); return [s.intent.status, s.definition.status] }
  assert.deepEqual(await status(w), ['approved', 'approved'])
  const desc = cloneWorkflow(w); desc.nodes.survey.description += ' More.'
  assert.deepEqual(await status(desc), ['approved', 'stale'])
  const edge = cloneWorkflow(w); edge.edges.pop()
  assert.deepEqual(await status(edge), ['approved', 'stale'])
  const access = cloneWorkflow(w); access.repositories.tools.access = 'editable'
  assert.deepEqual(await status(access), ['approved', 'stale'])
  const target = cloneWorkflow(w); target.nodes.setup.workflow = 'draft-gaps'
  assert.deepEqual(await status(target), ['approved', 'stale'])
  const intent = cloneWorkflow(w); intent.intent += 'And one more sentence.\n'
  assert.deepEqual(await status(intent), ['stale', 'stale'])
  const layout = cloneWorkflow(w); layout.layout.nodes.survey = { x: 10, y: 20 }
  assert.deepEqual(await status(layout), ['approved', 'approved'])
  const none = cloneWorkflow(w); none.approvals = {}
  assert.deepEqual(await status(none), ['unapproved', 'unapproved'])
})

test('an unchanged document round-trips byte for byte', async () => {
  for (const f of ['project/workflows/onboarding.yaml', 'project/workflows/repo-setup.yaml', 'project/workflows/draft-gaps.yaml']) {
    const text = await read(f)
    const r = parseWorkflow(text)
    assert.ok(r.ok)
    assert.equal(r.doc.toString(STRINGIFY), text, `${f} plain round trip`)
    assert.equal(renderWorkflow(r.doc, r.model), text, `${f} model round trip`)
  }
})

test('edits keep comments, unrelated fields and flow style', async () => {
  const text = `# heading comment
schema: ag.workflow.v1
id: keep
name: Keep  # trailing comment
owner: someone-else   # not in the model
intent: |
  Original intent.
nodes:
  a:
    type: do
    description: first
    note: preserved field
  b: {type: talk, description: second}
edges:
  - {from: a, to: b}
`
  const r = parseWorkflow(text)
  assert.ok(r.ok)
  const w = cloneWorkflow(r.model)
  w.nodes.a.description = 'first, edited'
  w.nodes.c = { type: 'study', name: 'C', description: 'third', repositories: [] }
  w.edges.push({ from: 'b', to: 'c' })
  w.layout.nodes.a = { x: 1, y: 2 }
  w.intent = 'Original intent.\nSecond line.\n'
  const out = renderWorkflow(r.doc, w)
  assert.match(out, /^# heading comment\n/)
  // Known normalization of the yaml library: one space before a trailing comment.
  assert.match(out, /name: Keep # trailing comment/)
  assert.match(out, /owner: someone-else # not in the model/)
  assert.match(out, /note: preserved field/)
  assert.match(out, /description: first, edited/)
  assert.match(out, /b: \{type: talk, description: second\}/)
  assert.match(out, /- \{from: b, to: c\}/)
  assert.match(out, /layout:\n {2}nodes:\n {4}a: \{x: 1, y: 2\}\n/)
  assert.match(out, /intent: \|\n {2}Original intent.\n {2}Second line.\n/)
  const again = parseWorkflow(out)
  assert.ok(again.ok)
  assert.deepEqual(again.model, w)
  // Deleting a node and its edges removes exactly those entries.
  const del = cloneWorkflow(w)
  delete del.nodes.b
  del.edges = del.edges.filter(e => e.from !== 'b' && e.to !== 'b')
  const out2 = renderWorkflow(again.doc, del)
  assert.doesNotMatch(out2, /\bb:/)
  assert.match(out2, /owner: someone-else/)
})

test('a new workflow file reads back as the same model', async () => {
  const w: Workflow = {
    schema: 'ag.workflow.v1', id: 'fresh', name: 'Fresh', intent: 'Line one.\nLine two.\n',
    repositories: { tools: { path: 'study/tools', access: 'readonly' } },
    nodes: { s: { type: 'study', name: 'S', description: 'look', repositories: ['tools'] } },
    edges: [], approvals: {}, layout: { nodes: {} },
  }
  const text = newWorkflowText(w)
  const r = parseWorkflow(text)
  assert.ok(r.ok, text)
  assert.deepEqual(r.model, w)
  assert.match(text, /^# Workflow definition/)
})
