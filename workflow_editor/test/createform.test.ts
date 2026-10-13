// The creation form's id rules (p8/ex2, src/createWorkflow.ts): an id is
// derived from the name until the person changes it, and never collides.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freeId, idFromName } from '../src/createWorkflow.ts'

test('a workflow id is derived from its name', () => {
  assert.equal(idFromName('Release Check'), 'release-check')
  assert.equal(idFromName('  Ünïcode / Säfe!  '), 'unicode-safe')
  assert.equal(idFromName('自由作業'), '')
  assert.equal(idFromName('---'), '')
  assert.ok(idFromName('x'.repeat(100)).length <= 48)
})

test('a derived id never collides with an existing one', () => {
  assert.equal(freeId('release-check', new Set()), 'release-check')
  assert.equal(freeId('release-check', new Set(['release-check'])), 'release-check-2')
  assert.equal(freeId('release-check', new Set(['release-check', 'release-check-2'])), 'release-check-3')
  assert.equal(freeId('', new Set()), 'workflow-2')
  assert.equal(freeId('', new Set(['workflow-2'])), 'workflow-3')
})
