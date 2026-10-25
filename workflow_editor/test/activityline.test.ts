// The run view's activity line (p8/ex2, src/runActivity.ts): every state
// says what it is, and nothing unobserved is stated as a number.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeActivity, since, type ActivityInput } from '../src/runActivity.ts'
import type { RunExecView } from '../src/api.ts'

const attempt = (o: Partial<RunExecView['attempts'][number]> = {}): RunExecView['attempts'][number] => ({
  id: 'a1', state: 'running', began: '2026-10-13T08:00:00Z', ended: null, exit_code: null, signal: null, outcome: null, backend: 'b', pid: 42, alive: true, stop_requested: null, log: '/x.jsonl',
  activity: { unit: 'turn', count: 24, last: '2026-10-13T08:05:00Z', bytes: 100 }, ...o,
})
const exec = (attempts: RunExecView['attempts'] = [], jobs: RunExecView['jobs'] = []): RunExecView => ({ attempts, jobs, checkpoints: [], executor: { state: 'available' } })
const base: ActivityInput = { rev: false, connected: true, execError: false, exec: exec([attempt()]), situation: 'executing', state: 'in-progress', active: ['Implement'], waitingFor: null, failed: [], holdKind: null }

test('a working session: the current work, its turns and its last output', () => {
  const l = describeActivity(base)!
  assert.equal(l.tone, 'working')
  assert.equal(l.text, 'Working on Implement')
  assert.deepEqual(l.count, { n: 24, unit: 'turn', attempt: 'a1' })
  assert.equal(l.last, '2026-10-13T08:05:00Z')
  assert.equal(describeActivity({ ...base, active: [] })!.text, 'Between steps')
  assert.equal(describeActivity({ ...base, active: ['A', 'B', 'C'] })!.text, 'Working on A and 2 more')
})

test('what is not observed is not stated as a number', () => {
  const other = describeActivity({ ...base, exec: exec([attempt({ alive: null, activity: null })]) })!
  assert.equal(other.count, undefined); assert.match(other.note!, /another host/)
  const plain = describeActivity({ ...base, exec: exec([attempt({ activity: { unit: null, count: null, last: '2026-10-13T08:05:00Z', bytes: 9 } })]) })!
  assert.equal(plain.count, undefined); assert.equal(plain.last, '2026-10-13T08:05:00Z')
  const silent = describeActivity({ ...base, exec: exec([attempt({ activity: { unit: 'turn', count: 0, last: null, bytes: 0 } })]) })!
  assert.equal(silent.note, 'no output yet')
  const dead = describeActivity({ ...base, exec: exec([attempt({ alive: false })]) })!
  assert.equal(dead.tone, 'warn'); assert.equal(dead.count, undefined); assert.match(dead.note!, /not running/)
  const offline = describeActivity({ ...base, connected: false })!
  assert.equal(offline.tone, 'warn'); assert.equal(offline.count, undefined); assert.equal(offline.text, 'Not connected')
  const locked = describeActivity({ ...base, exec: exec([attempt({ activity: { unit: null, count: null, last: null, bytes: 0, problem: 'EACCES' } })]) })!
  assert.equal(locked.count, undefined); assert.match(locked.note!, /cannot be read on this host/); assert.doesNotMatch(locked.note!, /another host/)
  const unread = describeActivity({ ...base, execError: true })!
  assert.equal(unread.count, undefined); assert.match(unread.note!, /cannot be read/)
  assert.equal(describeActivity({ ...base, rev: true }), null, 'a history view shows no current activity')
})

test('waiting, queued, held, failed, finished and cancelled each say so', () => {
  const none = exec([attempt({ state: 'ended', alive: false })])
  assert.equal(describeActivity({ ...base, exec: none, situation: 'awaiting-person', active: [], waitingFor: 'Sample Person' })!.text, 'Waiting for Sample Person')
  assert.equal(describeActivity({ ...base, exec: exec([], [{ id: 1, kind: 'start', state: 'queued', reason: 'r', created: 'x', note: null }]), situation: 'not-started', state: 'not-started', active: [] })!.text, 'Queued')
  assert.equal(describeActivity({ ...base, exec: none, situation: 'stopped', holdKind: 'stopped' })!.tone, 'held')
  assert.equal(describeActivity({ ...base, exec: none, situation: 'idle', active: [], failed: ['Implement'] })!.text, 'Implement failed')
  assert.equal(describeActivity({ ...base, exec: none, situation: 'completed', state: 'completed' })!.text, 'Finished')
  assert.equal(describeActivity({ ...base, exec: none, situation: 'cancelled', state: 'cancelled' })!.text, 'Cancelled')
  assert.equal(describeActivity({ ...base, exec: exec([]), situation: 'not-started', state: 'not-started', active: [] })!.text, 'Not started')
  assert.equal(describeActivity({ ...base, exec: null, situation: 'idle', active: [] })!.text, 'Checking the executor')
  assert.equal(describeActivity({ ...base, exec: exec([attempt({ alive: false, pid: null })]) })!.text, 'Starting a session')
})

test('ages read in seconds first', () => {
  const now = Date.parse('2026-10-13T08:05:08Z')
  assert.equal(since('2026-10-13T08:05:00Z', now), '8 s ago')
  assert.equal(since('2026-10-13T08:02:00Z', now), '3 min ago')
  assert.equal(since('2026-10-13T06:05:00Z', now), '2 h ago')
})

test('a standing conductor at rest is idle, not waiting for a person (workflow_editor p18)', () => {
  const rest = { ...base, exec: exec(), situation: 'awaiting-input', state: 'idle', active: [] } as ActivityInput
  const l = describeActivity({ ...rest, status: { state: 'listening', label: 'Idle', reason: 'Ready for the conversation\'s next message', text: 'Idle · Ready for the conversation\'s next message', tone: 'muted' } } as ActivityInput)!
  assert.deepEqual([l.tone, l.text], ['muted', 'Idle · Ready for the conversation\'s next message'])
  assert.equal(describeActivity({ ...rest, situation: 'suspended', status: { state: 'suspended', label: 'Suspended', reason: 'x', text: 'Suspended · x', tone: 'muted' } } as ActivityInput)!.tone, 'muted')
})
