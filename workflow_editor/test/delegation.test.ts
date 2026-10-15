// p10 (docs/delegation.md): delegation across managed projects. Step 1 —
// the definition: a portable target (project + workflow), who may accept
// the child's result, validation against the registry's projects, and
// digests that stay as they were for workflows without the new fields.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { semanticDigest } from '../shared/canonical.ts'
import { compile } from '../shared/compile.ts'
import { cloneWorkflow, emptyWorkflow, type Workflow } from '../shared/model.ts'
import { delegateTargets, validateWorkflow, type ValidationContext } from '../shared/validate.ts'
import { newWorkflowText, parseWorkflow } from '../server/yamlDoc.ts'

const codes = (issues: { code: string; severity: string }[], severity = 'error') =>
  issues.filter(i => i.severity === severity).map(i => i.code).sort()

function parent(node: Partial<Workflow['nodes'][string]>): Workflow {
  const w = emptyWorkflow('use-asset', 'Use an asset')
  w.intent = 'Get an asset from forge and use it.'
  w.documentation = { policy: 'manual' }
  w.nodes.prepare = { type: 'do', name: '', description: 'Prepare.', repositories: [] }
  w.nodes.asset = { type: 'delegate', name: 'Get the asset', description: 'Ask forge.', repositories: [], ...node }
  w.edges.push({ from: 'prepare', to: 'asset' })
  return w
}

const registry = (forge: { id: string; delegates?: string[]; intake?: boolean }[]): ValidationContext => ({
  project: 'agops',
  workflows: [{ id: 'use-asset', file: 'use-asset.yaml', delegates: ['forge/provide'] }, { id: 'local', file: 'local.yaml', delegates: [], intake: true }],
  file: 'use-asset.yaml',
  projects: { forge: forge.map(f => ({ id: f.id, file: `${f.id}.yaml`, delegates: f.delegates ?? [], intake: f.intake ?? true })) },
})

test('a delegate names a portable target: project and workflow, read and written back', () => {
  const w = parent({ project: 'forge', workflow: 'provide', accepts: 'parent' })
  const text = newWorkflowText(w)
  assert.match(text, /project: forge/)
  assert.match(text, /accepts: parent/)
  const back = parseWorkflow(text)
  assert.ok(back.ok)
  assert.deepEqual({ project: back.model.nodes.asset.project, workflow: back.model.nodes.asset.workflow, accepts: back.model.nodes.asset.accepts }, { project: 'forge', workflow: 'provide', accepts: 'parent' })
  assert.deepEqual(delegateTargets(back.model, 'agops'), ['forge/provide'])
  // The same project, named explicitly, is the same target as none.
  assert.deepEqual(delegateTargets(parent({ project: 'agops', workflow: 'local' }), 'agops'), ['local'])
  const compiled = compile(back.model)
  assert.ok(compiled.ok)
  assert.deepEqual(compiled.graph.nodes.asset, { type: 'delegate', workflow: 'provide', project: 'forge', accepts: 'parent' })
})

test('cross-project targets are validated against the registry', () => {
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'forge', workflow: 'provide' }), registry([{ id: 'provide' }]))), [])
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'forge', workflow: 'nope' }), registry([{ id: 'provide' }]))), ['delegate-target-unknown'])
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'nobody', workflow: 'provide' }), registry([{ id: 'provide' }]))), ['delegate-project-unknown'])
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'Bad Id', workflow: 'provide' }), registry([]))), ['delegate-project-unknown'])
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'forge', workflow: 'provide', accepts: 'anyone' }), registry([{ id: 'provide' }]))), ['delegate-accepts'])
  assert.ok(codes(validateWorkflow(parent({ project: 'forge', workflow: 'provide' }), registry([{ id: 'provide', intake: false }])), 'warning').includes('delegate-no-intake'))
  // Without a registry, another project's workflow cannot be checked and is not called unknown.
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'forge', workflow: 'provide' }), { project: 'agops', workflows: [], file: 'use-asset.yaml' })), [])
  // Its own workflow in its own project is itself; the same id in another project is not.
  assert.deepEqual(codes(validateWorkflow(parent({ workflow: 'use-asset' }), registry([]))), ['delegate-self'])
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'agops', workflow: 'use-asset' }), registry([]))), ['delegate-self'])
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'forge', workflow: 'use-asset' }), registry([{ id: 'use-asset' }]))), [])
})

test('delegation that comes back across projects is recursive', () => {
  const back = registry([{ id: 'provide', delegates: ['agops/use-asset'] }])
  const issues = validateWorkflow(parent({ project: 'forge', workflow: 'provide' }), back)
  assert.ok(codes(issues).includes('delegate-recursive'), JSON.stringify(issues))
  assert.match(issues.find(i => i.code === 'delegate-recursive')!.message, /use-asset → forge\/provide → use-asset/)
  // Through a third workflow of the target project.
  const via = registry([{ id: 'provide', delegates: ['helper'] }, { id: 'helper', delegates: ['agops/use-asset'] }])
  assert.ok(codes(validateWorkflow(parent({ project: 'forge', workflow: 'provide' }), via)).includes('delegate-recursive'))
  // Not recursive: the target delegates elsewhere.
  const other = registry([{ id: 'provide', delegates: ['helper'] }, { id: 'helper' }])
  assert.deepEqual(codes(validateWorkflow(parent({ project: 'forge', workflow: 'provide' }), other)), [])
})

test('the new fields on another node type are flagged, and digests without them are unchanged', async () => {
  const w = parent({ workflow: 'local' })
  const odd = cloneWorkflow(w)
  odd.nodes.prepare.accepts = 'parent'
  assert.ok(codes(validateWorkflow(odd, registry([])), 'warning').includes('workflow-on-non-delegate'))
  // A delegate without project/accepts projects exactly as before p10.
  const before = await semanticDigest('definition', w)
  const same = cloneWorkflow(w)
  delete same.nodes.asset.project
  delete same.nodes.asset.accepts
  assert.equal(await semanticDigest('definition', same), before)
  // Declaring them is a change of the definition.
  assert.notEqual(await semanticDigest('definition', parent({ workflow: 'local', accepts: 'parent' })), before)
  assert.notEqual(await semanticDigest('definition', parent({ project: 'forge', workflow: 'local' })), before)
})
