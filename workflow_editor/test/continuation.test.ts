// agent_session p1 ex2: what a resumed conversation is told at the start of
// a new attempt, and the compact state read. The executor's steps are driven
// here directly; nothing launches an agent.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, unlink, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { ExecStore, type HostOffer } from '../server/exec.ts'
import { describeState, changeLines, DELTA_LINES } from '../server/continuation.ts'
import { describeRun } from '../cli/run.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runOp, runResponse } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { Workspace } from '../server/workspace.ts'
import type { OpInput, RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-continuation-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const WF = (policy: string) => `schema: ag.workflow.v2
documentation: {policy: ${policy}}
id: keep
name: Keep
intent: |
  Agree on a scope, then build it.
execution:
  guides: [agent/g.md]
  session: run
repositories:
  root: {path: ., access: editable}
nodes:
  scope:
    type: talk
    description: Agree on the scope with the person.
  build:
    type: do
    description: Build what was agreed.
edges:
  - {from: scope, to: build}
`
let n = 0
async function setup(policy = 'manual') {
  const area = join(root, `area-${++n}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, `pj-c${n}`)
  const r = await createProject({ dir, id: `c${n}`, name: `C${n}`, intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'keep.yaml'), WF(policy))
  await mkdir(join(dir, 'agent'))
  await writeFile(join(dir, 'agent', 'g.md'), '# guide\nFact one.\n')
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const remote = join(area, 'remotes', `pj-c${n}.git`)
  await gitOk(area, ['init', '-q', '--bare', '--initial-branch=main', remote])
  await gitOk(dir, ['remote', 'add', 'origin', remote])
  await gitOk(dir, ['push', '-q', '-u', 'origin', 'main'])
  const x = new ExecStore({ registryFile: registry, area })
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  const req = await x.request({ workspace: ws.reg.id, workflow: 'keep', text: 'Build a small thing.\nIt must keep the count visible.', author: 'Test Person', receipt: `cont-req-${n}`, via: 'browser' })
  const space = await runSpace(ws, req.ref)
  return { x, ws, space, ref: req.ref }
}
const OFFER: HostOffer = { profiles: { sonnet: 'claude_code / anthropic/claude-sonnet-5' }, contract: { name: 'wfrun/guide.md', sha256: 'a'.repeat(64) }, sessions: { sonnet: 'explicit', '': 'explicit' } }
const report = (ws: Workspace, ref: RunRef, attempt: string, op: OpInput) => runOp(ws, ref, { ...op, attempt }, { by: 'autolab', via: 'cli' })
const person = (ws: Workspace, ref: RunRef, op: OpInput) => runOp(ws, ref, op, { by: 'Test Person', via: 'cli' })
const record = async (ws: Workspace, ref: RunRef) => (await readRun(ws, ref)).record!
async function claim(x: ExecStore) {
  const c = await x.claim('claude_code / anthropic/claude-sonnet-5', OFFER)
  assert.ok('attempt' in c, JSON.stringify(c))
  x.started(c.attempt.id, process.pid)
  await mkdir(join(c.attempt.log!, '..'), { recursive: true })
  await writeFile(c.attempt.log!, '') // the executor opens the attempt's log before it launches anything
  return c as Exclude<typeof c, { idle: string }>
}
const end = async (x: ExecStore, a: string, code = 0) => { await x.finished(a, { code, signal: null }); x.db.prepare('UPDATE attempts SET pid = NULL').run() }
// Stable material a continuation must not repeat.
const STABLE = [/Working copy:/, /Project workspace:/, /node catalog, as it was/, /Documentation policy:/, /--history/]

test('ordinary resume: the answer in full, the delta and the compact state; no history read and no stable material', async () => {
  const { x, space, ref } = await setup()
  const c1 = await claim(x)
  assert.equal(c1.continuation, null, 'a new session gets the whole brief')
  assert.match(c1.brief, /request is devdocs\/runs\/keep\/run-001\/braindump\.md \(author Test Person\)/)
  await report(space, ref, c1.attempt.id, { op: 'node.start', node: 'scope' })
  await report(space, ref, c1.attempt.id, { op: 'question.ask', question: '', node: 'scope', text: 'Small or large?', to: 'Test Person' })
  await end(x, c1.attempt.id)
  await person(space, ref, { op: 'question.answer', question: 'q1', text: 'Small.\nAnd keep it blue.', from: 'Test Person' })
  await x.afterAnswer(space, ref, 'q1')
  const c2 = await claim(x)
  assert.equal(c2.execution.session?.mode, 'resume')
  const t = c2.continuation!
  assert.ok(t, 'an ordinary resume gets a continuation')
  assert.match(t, /- q1 answer 0 from Test Person via cli at .*; your question from scope: "Small or large\?"\n {4}Small\.\n {4}And keep it blue\./, 'exact text, ids and author')
  assert.match(t, /Recorded since your previous attempt began \(after seq 2\), not by it \(1\):\n {2}\d+ question\.answer by Test Person \(question q1\): Small\.…/)
  assert.match(t, /State at seq \d+: in-progress\./)
  assert.match(t, /Waiting: scope — question q1; next move: autolab \(answer recorded, not yet taken up\)/)
  assert.match(t, /The previous attempt .* ended: exited\./)
  assert.doesNotMatch(t, /did not end normally/)
  for (const re of STABLE) assert.doesNotMatch(t, re, `continuation repeats ${re}`)
  assert.match(t, /wfe run state keep\/run-001 --since \d+/)
  assert.ok(t.length < 2000, `compact: ${t.length} chars`)
  // The whole brief is still produced (the executor uses it when the stored
  // conversation turns out to be missing), with the answer in it too.
  assert.match(c2.brief, /Working copy:/)
  assert.match(c2.brief, /And keep it blue\./)
  // Taken up: no longer pending, and a later state read does not repeat it.
  await report(space, ref, c2.attempt.id, { op: 'question.take-up', question: 'q1' })
  assert.doesNotMatch(describeState(await record(space, ref)), /keep it blue/)
  x.close()
})

test('pending input survives a failed launch and an interruption; several inputs during a wait are all delivered', async () => {
  const { x, space, ref } = await setup()
  const c1 = await claim(x)
  await report(space, ref, c1.attempt.id, { op: 'node.start', node: 'scope' })
  await report(space, ref, c1.attempt.id, { op: 'question.ask', question: '', node: 'scope', text: 'Small or large?', to: 'Test Person' })
  await end(x, c1.attempt.id)
  await person(space, ref, { op: 'instruction.receive', text: 'Use the red palette.', from: 'Test Person' })
  await person(space, ref, { op: 'question.answer', question: 'q1', text: 'Small.', from: 'Test Person' })
  await person(space, ref, { op: 'question.answer', question: 'q1', text: 'Actually: medium.', from: 'Test Person' })
  await x.afterAnswer(space, ref, 'q1')
  const c2 = await claim(x)
  for (const t of [c2.continuation!, c2.brief]) {
    assert.match(t, /Answers recorded and not yet taken up \(2\)/)
    assert.match(t, /q1 answer 0 [^\n]*\n {4}Small\./)
    assert.match(t, /q1 answer 1 [^\n]*\n {4}Actually: medium\./)
    assert.match(t, /- i1, from Test Person at .*:\n {4}Use the red palette\./)
  }
  // The launch fails: nothing was taken up. The process ends non-zero.
  await end(x, c2.attempt.id, 1)
  let rec = await record(space, ref)
  assert.equal(rec.control.hold?.kind, 'interrupted')
  await x.resume(space, ref, 'Test Person', 'go on', 'cli')
  const c3 = await claim(x)
  const t3 = c3.continuation!
  assert.match(t3, /The previous attempt .* ended: interrupted/)
  assert.match(t3, /did not end normally: .*Look at the files \(git status, git diff\) and the record before repeating/)
  assert.match(t3, /Actually: medium\./, 'still pending: delivered again, never dropped')
  assert.match(t3, /Use the red palette\./)
  assert.match(t3, /The person resumed the run: "go on" \(Test Person\)\./)
  assert.match(t3, /run\.resume by Test Person \[hold interrupted→—\]: go on/, 'the resume is in the delta')
  // Taken up once; the next continuation no longer carries it.
  await report(space, ref, c3.attempt.id, { op: 'question.take-up', question: 'q1', answer: 1 })
  await report(space, ref, c3.attempt.id, { op: 'instruction.ack', instructions: ['i1'], response: 'incorporate', note: 'red' })
  rec = await record(space, ref)
  assert.doesNotMatch(describeState(rec), /not yet taken up|not yet acknowledged/)
  x.close()
})

test('input after the snapshot remains visible without blocking work', async () => {
  const { x, space, ref } = await setup()
  const c1 = await claim(x)
  const seq = (await record(space, ref)).seq
  await person(space, ref, { op: 'instruction.receive', text: 'Also add a legend.', from: 'Test Person' })
  const rec = await record(space, ref)
  const s = describeState(rec, seq)
  assert.match(s, /Recorded after seq \d+ \(1\):\n {2}\d+ instruction\.receive by Test Person \(instruction i1\): Also add a legend\./)
  assert.match(s, /not yet acknowledged \(1\)/)
  await report(space, ref, c1.attempt.id, { op: 'node.start', node: 'scope' })
  assert.equal((await record(space, ref)).nodes.scope.state, 'running')
  x.close()
})

test('holds, cancellation, decisions and adjustments by others are in the delta and the state; the record decides', async () => {
  const { x, space, ref } = await setup()
  const c1 = await claim(x)
  await report(space, ref, c1.attempt.id, { op: 'node.start', node: 'scope' })
  await report(space, ref, c1.attempt.id, { op: 'question.ask', question: '', node: 'scope', text: 'Small or large?', to: 'Test Person' })
  await end(x, c1.attempt.id)
  await x.stop(space, ref, 'Test Person', 'wait for Monday', 'cli')
  await person(space, ref, { op: 'question.answer', question: 'q1', text: 'Small.', from: 'Test Person' })
  assert.equal(await x.afterAnswer(space, ref, 'q1'), null, 'the hold queues nothing')
  await x.resume(space, ref, 'Test Person', 'Monday now', 'cli')
  const c2 = await claim(x)
  const t = c2.continuation!
  assert.match(t, /run\.stop by Test Person[^\n]*: wait for Monday/)
  assert.match(t, /run\.resume by Test Person[^\n]*: Monday now/)
  assert.ok(t.indexOf('run.stop') < t.indexOf('run.resume'), 'in record order')
  // A person's decision recorded during a wait: in the next delta and the state.
  await report(space, ref, c2.attempt.id, { op: 'question.take-up', question: 'q1' })
  await report(space, ref, c2.attempt.id, { op: 'question.ask', question: '', node: 'scope', text: 'Shall I go on?', to: 'Test Person' })
  await end(x, c2.attempt.id)
  await person(space, ref, { op: 'run.decide', decision: 'rejected', evidence: 'the scope is wrong' })
  await person(space, ref, { op: 'question.answer', question: 'q2', text: 'See my decision.', from: 'Test Person' })
  await x.afterAnswer(space, ref, 'q2')
  const c3 = await claim(x)
  assert.match(c3.continuation!, /run\.decide by Test Person: the scope is wrong/)
  assert.match(c3.continuation!, /Decision: rejected by Test Person at /)
  await end(x, c3.attempt.id)
  // Cancelled while waiting: nothing is claimed, and the state read says so.
  await x.cancel(space, ref, 'Test Person', 'not needed', 'cli')
  const rec = await record(space, ref)
  assert.match(describeState(rec), /cancelled by Test Person: not needed/)
  x.close()
})

test('documentation steps: instructions already briefed are not repeated; a step reached first in this conversation is', async () => {
  const { x, space, ref } = await setup('default')
  const c1 = await claim(x)
  assert.match(c1.brief, /Step _plan \(ready\)/)
  await report(space, ref, c1.attempt.id, { op: 'node.start', node: '_plan' })
  await writeFile(join(space.root, 'devdocs/runs/keep/run-001/plan.md'), '# plan\nsmall\n')
  await report(space, ref, c1.attempt.id, { op: 'question.ask', question: '', node: '_plan', text: 'Agree to plan.md?', to: 'Test Person', plan: true })
  await end(x, c1.attempt.id)
  await person(space, ref, { op: 'question.answer', question: 'q1', text: 'Agreed.', from: 'Test Person' })
  await x.afterAnswer(space, ref, 'q1')
  const c2 = await claim(x)
  assert.doesNotMatch(c2.continuation!, /Step _plan/, 'briefed in attempt 1 of this conversation')
  assert.match(c2.brief, /Step _plan \(waiting\)/, 'a new session would still get it')
  await report(space, ref, c2.attempt.id, { op: 'question.take-up', question: 'q1' })
  await report(space, ref, c2.attempt.id, { op: 'node.complete', node: '_plan', outcome: 'agreed', agreement: 'q1' })
  await report(space, ref, c2.attempt.id, { op: 'node.start', node: 'scope' })
  await report(space, ref, c2.attempt.id, { op: 'node.complete', node: 'scope', outcome: 'small' })
  await end(x, c2.attempt.id) // ready work left: interrupted
  await x.resume(space, ref, 'Test Person', 'continue', 'cli')
  const c3 = await claim(x)
  assert.match(c3.continuation!, /Step _report\.scope \(ready\), first reached in this conversation: .*Document: devdocs\/runs\/keep\/run-001\/report-scope\.md/)
  assert.match(c3.brief, /The current plan is devdocs\/runs\/keep\/run-001\/plan\.md \(agreed in q1\)\./, 'a replacement session is told the plan')
  x.close()
})

test('compaction: a compacted (or unprovable) conversation is resumed with the whole bootstrap, recorded; then continuations again', async () => {
  const { x, space, ref } = await setup()
  const c1 = await claim(x)
  await report(space, ref, c1.attempt.id, { op: 'node.start', node: 'scope' })
  await report(space, ref, c1.attempt.id, { op: 'question.ask', question: '', node: 'scope', text: 'Small or large?', to: 'Test Person' })
  await appendFile(c1.attempt.log!, '{"type":"system","subtype":"init","session_id":"x"}\n{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":170000}}\n')
  await end(x, c1.attempt.id)
  await person(space, ref, { op: 'question.answer', question: 'q1', text: 'Small.', from: 'Test Person' })
  await x.afterAnswer(space, ref, 'q1')
  const c2 = await claim(x)
  assert.equal(c2.execution.session?.mode, 'resume', 'the same conversation')
  assert.equal(c2.execution.session?.reconstruct, `the conversation was compacted in attempt ${c1.attempt.id}`)
  assert.equal(c2.continuation, null, 'the whole bootstrap')
  assert.equal((await record(space, ref)).control.attempt?.settings?.session?.reconstruct, c2.execution.session?.reconstruct, 'recorded before launch')
  await report(space, ref, c2.attempt.id, { op: 'question.take-up', question: 'q1' })
  await report(space, ref, c2.attempt.id, { op: 'node.complete', node: 'scope', outcome: 'small' })
  await report(space, ref, c2.attempt.id, { op: 'node.start', node: 'build' })
  await report(space, ref, c2.attempt.id, { op: 'question.ask', question: '', node: 'build', text: 'Blue?', to: 'Test Person' })
  await end(x, c2.attempt.id)
  await person(space, ref, { op: 'question.answer', question: 'q2', text: 'Yes.', from: 'Test Person' })
  await x.afterAnswer(space, ref, 'q2')
  const c3 = await claim(x)
  assert.equal(c3.execution.session?.reconstruct, undefined, 'the reconstruction attempt reset the span')
  assert.ok(c3.continuation)
  await report(space, ref, c3.attempt.id, { op: 'question.take-up', question: 'q2' })
  await report(space, ref, c3.attempt.id, { op: 'question.ask', question: '', node: 'build', text: 'Shade?', to: 'Test Person' })
  await end(x, c3.attempt.id)
  await unlink(c3.attempt.log!).catch(() => {})
  await person(space, ref, { op: 'question.answer', question: 'q3', text: 'Dark.', from: 'Test Person' })
  await x.afterAnswer(space, ref, 'q3')
  const c4 = await claim(x)
  assert.match(c4.execution.session?.reconstruct ?? '', /cannot be ruled out/, 'a missing log is not evidence of no compaction')
  assert.equal(c4.continuation, null)
  x.close()
})

test('size: the state read and the delta stay bounded on a long history; show --history grows with it', async () => {
  const { x, space, ref } = await setup()
  const c1 = await claim(x)
  await report(space, ref, c1.attempt.id, { op: 'node.start', node: 'scope' })
  for (let k = 0; k < 150; k++) await report(space, ref, c1.attempt.id, { op: 'node.progress', node: 'scope', text: `step ${k}: ${'detail '.repeat(30)}` })
  await report(space, ref, c1.attempt.id, { op: 'question.ask', question: '', node: 'scope', text: 'Small or large?', to: 'Test Person' })
  await end(x, c1.attempt.id)
  for (let k = 0; k < 60; k++) await person(space, ref, { op: 'instruction.receive', text: `note ${k}`, from: 'Test Person' })
  const rec = await record(space, ref)
  const full = describeRun(await runResponse(space, ref), { history: true })
  const state = describeState(rec)
  assert.ok(full.length > 10 * state.length, `show --history ${full.length} chars vs state ${state.length}`)
  assert.ok(state.length < 8000, `state ${state.length}`)
  const delta = changeLines(rec, 1, [c1.attempt.id]) // after run.create
  assert.equal(delta.count, 60, 'the agent\'s own 150 notes are not news to it')
  assert.equal(delta.lines.length, DELTA_LINES + 1)
  assert.match(delta.lines.at(-1)!, /… 30 more: wfe run state keep\/run-001 --since \d+/)
  x.close()
})
