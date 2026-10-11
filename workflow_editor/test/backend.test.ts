// p5/ex1 step 5: the run header's backend comes from attempt evidence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backendFact } from '../shared/backend.ts'

const a = (state: string, began: string, backend: string | null) => ({ state, began, backend })

test('backend: completed, active, several backends, missing, none, not observed', () => {
  const sonnet = 'claude_code / anthropic/claude-sonnet-5'
  assert.equal(backendFact(null, [a('ended', '2026-10-11T08:33:51Z', sonnet), a('ended', '2026-10-11T08:35:26Z', sonnet), a('ended', '2026-10-11T08:41:43Z', sonnet)]),
    `backend ${sonnet} (latest attempt)`, 'improve-game/run-002: three ended attempts, one backend')
  assert.equal(backendFact(null, [a('ended', '2026-10-11T01:00:00Z', 'x / old'), a('running', '2026-10-11T02:00:00Z', 'y / new')]),
    'backend y / new (attempt in progress) · 2 backends across 2 attempts', 'the active attempt, not the latest ended')
  assert.equal(backendFact(null, [a('running', '2026-10-11T02:00:00Z', 'y / new'), a('ended', '2026-10-11T01:00:00Z', 'x / old')]),
    'backend y / new (attempt in progress) · 2 backends across 2 attempts', 'order of the rows does not matter')
  assert.equal(backendFact(null, [a('ended', '2026-10-11T01:00:00Z', 'x / old'), a('ended', '2026-10-11T02:00:00Z', null)]),
    'backend unknown (latest attempt recorded none) · 2 backends across 2 attempts', 'never borrowed from an earlier attempt')
  assert.equal(backendFact('x / configured', []), 'no attempt yet · configured: x / configured')
  assert.equal(backendFact('x / configured', [a('ended', '2026-10-11T01:00:00Z', 'y / ran')]), 'backend y / ran (latest attempt) · configured: x / configured', 'configured and observed kept apart')
  assert.equal(backendFact(null, null), 'backend not observed here')
})
