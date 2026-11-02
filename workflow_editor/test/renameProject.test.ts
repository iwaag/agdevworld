// rename/warden: a renamed project's existing runs keep their creation identity
// and follow the project; the migration previews, repeats and stops safely.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, replay, runUid, type RunGraph } from '../shared/run.ts'
import { holdsProject, recordedWorkspace } from '../server/registry.ts'

const graph: RunGraph = { nodes: { a: { type: 'do' } }, edges: [] }
const meta = (seq: number) => ({ seq, at: `2026-11-02T00:00:0${seq}.000Z`, by: 'tester', via: 'test' })
const create = {
  op: 'run.create', project: 'agops', workflow: 'recover', run: 'run-001',
  input: { kind: 'request', file: 'request.md', requester: 'Observer', sha256: 'a'.repeat(64) },
  executor: { name: 'recovery-agent', backend: null, host: 'autolab' }, predecessor: null,
  definition: { root: 'recover', workflows: {} }, context: { repositories: [] }, nodes: ['a'],
  ...meta(1),
} as never
const rename = { op: 'run.rename-project', from: 'agops', to: 'warden', note: 'renamed', ...meta(2) } as never

test('the operation moves the current project and keeps the uid', () => {
  const first = apply(null, create, graph).state
  const s = apply(first, rename, graph).state
  assert.equal(s.project, 'warden')
  assert.equal(s.createdAs, 'agops')
  assert.equal(runUid(s, 'abc'), 'agops/recover/run-001#abc')
  assert.equal(runUid(first, 'abc'), 'agops/recover/run-001#abc')
  assert.equal(runUid({ project: 'warden', workflow: 'recover', run: 'run-070' }, 'def'), 'warden/recover/run-070#def')
})

test('a second rename keeps the project the run was created in', () => {
  const s = apply(apply(apply(null, create, graph).state, rename, graph).state, { op: 'run.rename-project', from: 'warden', to: 'keeper', note: 'again', ...meta(3) } as never, graph).state
  assert.equal(s.project, 'keeper')
  assert.equal(s.createdAs, 'agops')
})

test('the operation is refused from another project or to an invalid id', () => {
  const first = apply(null, create, graph).state
  assert.throws(() => apply(first, { op: 'run.rename-project', from: 'other', to: 'warden', note: 'x', ...meta(2) } as never, graph), /project is agops/)
  assert.throws(() => apply(first, { op: 'run.rename-project', from: 'agops', to: 'agops', note: 'x', ...meta(2) } as never, graph), /invalid/)
  assert.throws(() => apply(first, { op: 'run.rename-project', from: 'agops', to: 'Bad Name', note: 'x', ...meta(2) } as never, graph), /invalid/)
})

test('replay reaches the same state', () => {
  const s = apply(apply(null, create, graph).state, rename, graph).state
  const again = replay([create, rename] as never, graph).state
  assert.equal(again.project, s.project)
  assert.equal(again.createdAs, s.createdAs)
})

test('former names resolve existing records only by explicit lookup', () => {
  const w = [{ id: 'warden', label: 'warden', host: 'this machine', path: '/x', project: 'warden', formerly: ['agops'] }, { id: 'misc', label: 'misc', host: 'this machine', path: '/y', project: 'misc' }]
  assert.equal(recordedWorkspace(w, 'agops')?.id, 'warden')
  assert.equal(recordedWorkspace(w, 'warden')?.id, 'warden')
  assert.equal(recordedWorkspace(w, 'nothing'), undefined)
  assert.equal(holdsProject(w[0], 'agops'), true)
  assert.equal(holdsProject(w[1], 'agops'), false)
})

test('a run renamed while held goes on working, and its uid does not change', () => {
  let s = apply(apply(null, create, graph).state, rename, graph).state
  s = apply(s, { op: 'node.start', node: 'a', ...meta(3) } as never, graph).state
  s = apply(s, { op: 'node.complete', node: 'a', outcome: 'done under the new name', ...meta(4) } as never, graph).state
  assert.equal(s.nodes.a.state, 'completed')
  assert.equal(s.project, 'warden')
  assert.equal(runUid(s, 'abc'), 'agops/recover/run-001#abc')
  const again = replay([create, rename, { op: 'node.start', node: 'a', ...meta(3) }, { op: 'node.complete', node: 'a', outcome: 'done under the new name', ...meta(4) }] as never, graph).state
  assert.equal(again.nodes.a.state, 'completed')
})
