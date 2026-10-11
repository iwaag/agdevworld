// p6 step 5: additional instructions at node boundaries — received while a
// node runs without touching it, considered before the next node starts and
// before the run's last completion, acknowledged only by the executing
// attempt, durable across re-reads, and ordered against transitions by the
// run's lock.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { ExecStore, instructionBrief } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { createRun, readRun, runOp } from '../server/runs.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import { pendingInstructions, type OpInput, type RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-instr-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const flow = (policy: 'manual' | 'default') => `schema: ag.workflow.v2
id: two
name: Two
intent: |
  Do a, then b.
documentation: {policy: ${policy}}
repositories:
  root: {path: ., access: editable}
nodes:
  a:
    type: do
    description: First.
  b:
    type: do
    description: Second.
edges:
  - {from: a, to: b}
`
let k = 0
async function setup(policy: 'manual' | 'default' = 'manual') {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-p')
  const r = await createProject({ dir, id: 'p', name: 'P', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'two.yaml'), flow(policy))
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  const created = await createRun(ws, { workflow: 'two', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'do it', author: 'Pat' } })
  const x = new ExecStore({ registryFile: registry, area })
  return { ws, ref: created.ref, x, dir }
}
const exec = (ws: Workspace, ref: RunRef, op: OpInput, attempt?: string) => runOp(ws, ref, { ...op, ...(attempt ? { attempt } : {}) }, { by: 'two-agent', via: 'cli' })
const person = (ws: Workspace, ref: RunRef, text: string, receipt?: string) => runOp(ws, ref, { op: 'instruction.receive', text, from: 'Pat', ...(receipt ? { receipt } : {}) }, { by: 'Pat', via: 'zulip' })
const code = (e: unknown) => ((e as RequestError).detail as { code?: string } | undefined)?.code
const rec = async (ws: Workspace, ref: RunRef) => (await readRun(ws, ref)).record!
const begin = async (ws: Workspace, ref: RunRef, id: string) => runOp(ws, ref, { op: 'attempt.begin', attempt: id, reason: 'start' }, { by: 'autolab', via: 'exec' })

test('received during a node: the node is untouched; the next start is refused until acknowledged, then proceeds', async () => {
  const { ws, ref } = await setup()
  await begin(ws, ref, 'a-one')
  await exec(ws, ref, { op: 'node.start', node: 'a' }, 'a-one')
  await person(ws, ref, 'Use the blue palette.')
  let r = await rec(ws, ref)
  assert.equal(r.nodes.a.state, 'running', 'no interruption, no state change')
  assert.deepEqual(r.instructions?.i1.during, ['a'])
  await exec(ws, ref, { op: 'node.complete', node: 'a', outcome: 'did a' }, 'a-one')
  await assert.rejects(exec(ws, ref, { op: 'node.start', node: 'b' }, 'a-one'), (e: unknown) => {
    assert.equal(code(e), 'instructions-pending')
    assert.match((e as Error).message, /starting b is a node boundary/)
    assert.match((e as Error).message, /i1 from Pat .*"Use the blue palette\."/)
    assert.match((e as Error).message, /wfe run ack <run> i1 --response incorporate\|clarify\|new-run/)
    return true
  })
  await assert.rejects(exec(ws, ref, { op: 'instruction.ack', instructions: ['i1'], response: 'later', note: 'x' }, 'a-one'), /response must be one of incorporate, clarify, new-run/)
  await assert.rejects(exec(ws, ref, { op: 'instruction.ack', instructions: ['i9'], response: 'incorporate', note: 'x' }, 'a-one'), /instruction "i9" does not exist/)
  await exec(ws, ref, { op: 'instruction.ack', instructions: ['i1'], response: 'incorporate', note: 'b uses the blue palette' }, 'a-one')
  await assert.rejects(exec(ws, ref, { op: 'instruction.ack', instructions: ['i1'], response: 'incorporate', note: 'again' }, 'a-one'), /already acknowledged/)
  await exec(ws, ref, { op: 'node.start', node: 'b' }, 'a-one')
  r = await rec(ws, ref)
  assert.deepEqual(r.instructions?.i1.ack, { by: 'two-agent', at: r.instructions!.i1.ack!.at, attempt: 'a-one', response: 'incorporate', note: 'b uses the blue palette' })
  assert.equal(r.nodes.b.state, 'running')
})

test('the last completion is a boundary: input received while the last node runs is not lost', async () => {
  const { ws, ref } = await setup()
  await exec(ws, ref, { op: 'node.start', node: 'a' })
  await exec(ws, ref, { op: 'node.complete', node: 'a', outcome: 'a' })
  await exec(ws, ref, { op: 'node.start', node: 'b' })
  await person(ws, ref, 'Also mention the budget.')
  await assert.rejects(exec(ws, ref, { op: 'node.complete', node: 'b', outcome: 'b' }), (e: unknown) => code(e) === 'instructions-pending' && /completing b, the last node of the run/.test((e as Error).message))
  assert.equal((await rec(ws, ref)).execution.state, 'in-progress')
  await exec(ws, ref, { op: 'instruction.ack', instructions: ['i1'], response: 'clarify', note: 'asking which budget' })
  await exec(ws, ref, { op: 'node.complete', node: 'b', outcome: 'b' })
  assert.equal((await rec(ws, ref)).execution.state, 'completed')
  // After completion the run takes no instruction (the intake explains that
  // a new request topic is needed); nothing reopens it.
  await assert.rejects(person(ws, ref, 'one more'), (e: unknown) => code(e) === 'run-completed')
  assert.equal((await rec(ws, ref)).execution.state, 'completed')
})

test('documentation steps are boundaries like authored nodes, including the final report', async () => {
  const { ws, ref, dir } = await setup('default')
  const folder = join(dir, 'devdocs/runs/two/run-001')
  await exec(ws, ref, { op: 'node.start', node: '_plan' })
  await writeFile(join(folder, 'plan.md'), '# plan\n')
  await exec(ws, ref, { op: 'question.ask', question: 'q1', node: '_plan', text: 'ok?', to: 'Pat' })
  await runOp(ws, ref, { op: 'question.answer', question: 'q1', text: 'yes' }, { by: 'Pat', via: 'zulip' })
  await exec(ws, ref, { op: 'question.take-up', question: 'q1' })
  await exec(ws, ref, { op: 'node.complete', node: '_plan', outcome: 'agreed' })
  for (const [n, doc] of [['a', 'report-a.md'], ['b', 'report-b.md']] as const) {
    await exec(ws, ref, { op: 'node.start', node: n })
    if (n === 'a') {
      // An instruction changed the agreed work: the revised plan.md is asked
      // about again with the same document evidence.
      await writeFile(join(folder, 'plan.md'), '# plan\n\nrevised: b is smaller\n')
      await exec(ws, ref, { op: 'question.ask', question: 'q2', node: 'a', text: 'Agree to the revised plan?', to: 'Pat', plan: true })
      const q2 = (await rec(ws, ref)).questions.q2
      assert.equal(q2.document?.path, 'devdocs/runs/two/run-001/plan.md')
      assert.notEqual(q2.document?.sha256, (await rec(ws, ref)).questions.q1.document?.sha256, 'it names the revised content')
      await runOp(ws, ref, { op: 'question.answer', question: 'q2', text: 'agreed' }, { by: 'Pat', via: 'zulip' })
      await exec(ws, ref, { op: 'question.take-up', question: 'q2' })
    }
    await exec(ws, ref, { op: 'node.complete', node: n, outcome: n })
    await exec(ws, ref, { op: 'node.start', node: `_report.${n}` })
    if (n === 'b') await person(ws, ref, 'Name the renderer in the report.')
    await writeFile(join(folder, doc), `# ${n}\n`)
    await exec(ws, ref, { op: 'node.complete', node: `_report.${n}`, outcome: `${n} reported` })
  }
  await assert.rejects(exec(ws, ref, { op: 'node.start', node: '_final-report' }), (e: unknown) => code(e) === 'instructions-pending')
  await exec(ws, ref, { op: 'instruction.ack', instructions: ['i1'], response: 'incorporate', note: 'the final report names it' })
  await exec(ws, ref, { op: 'node.start', node: '_final-report' })
  await person(ws, ref, 'And thank the team.')
  await writeFile(join(folder, 'report.md'), '# report\n')
  await assert.rejects(exec(ws, ref, { op: 'node.complete', node: '_final-report', outcome: 'done' }), (e: unknown) => code(e) === 'instructions-pending' && /completing _final-report, the last node/.test((e as Error).message))
  await exec(ws, ref, { op: 'instruction.ack', instructions: ['i2'], response: 'incorporate', note: 'added to report.md' })
  await exec(ws, ref, { op: 'node.complete', node: '_final-report', outcome: 'done' })
  assert.equal((await rec(ws, ref)).execution.state, 'completed')
})

test('only the executing attempt acknowledges; a stale attempt cannot; acknowledgment survives a re-read', async () => {
  const { ws, ref } = await setup()
  await begin(ws, ref, 'a-old')
  await exec(ws, ref, { op: 'node.start', node: 'a' }, 'a-old')
  await person(ws, ref, 'Prefer short titles.')
  await runOp(ws, ref, { op: 'attempt.end', attempt: 'a-old', outcome: 'interrupted', detail: 'killed' }, { by: 'autolab', via: 'exec' })
  await runOp(ws, ref, { op: 'run.resume', reason: 'go on' }, { by: 'Pat', via: 'cli' })
  await begin(ws, ref, 'a-new')
  await assert.rejects(exec(ws, ref, { op: 'instruction.ack', instructions: ['i1'], response: 'incorporate', note: 'late' }, 'a-old'), /attempt a-old is not the current attempt/)
  await assert.rejects(exec(ws, ref, { op: 'instruction.ack', instructions: ['i1'], response: 'incorporate', note: 'nobody' }), /attempt a-new is executing this run/)
  await exec(ws, ref, { op: 'instruction.ack', instructions: ['i1'], response: 'incorporate', note: 'short titles' }, 'a-new')
  // A fresh read replays the history and agrees with the stored state.
  const again = await readRun(ws, ref)
  assert.ok(again.record, again.problem?.message)
  assert.equal(again.record.instructions?.i1.ack?.attempt, 'a-new')
  assert.equal(pendingInstructions(again.record).length, 0)
})

test('receipt and transition are ordered by the run\'s lock: input applied before a start blocks it, after it belongs to the next boundary', async () => {
  for (let trial = 0; trial < 12; trial++) {
    const { ws, ref } = await setup()
    await exec(ws, ref, { op: 'node.start', node: 'a' })
    await exec(ws, ref, { op: 'node.complete', node: 'a', outcome: 'a' })
    const results = await Promise.allSettled([
      exec(ws, ref, { op: 'node.start', node: 'b' }),
      person(ws, ref, `trial ${trial}`, `zulip:test:${trial}`),
    ])
    assert.equal(results[1].status, 'fulfilled', 'receipt is never refused by a running transition')
    const r = await rec(ws, ref)
    const startSeq = r.history.find(h => h.op === 'node.start' && (h as { node?: string }).node === 'b')?.seq
    const recvSeq = r.history.find(h => h.op === 'instruction.receive')!.seq
    if (results[0].status === 'fulfilled') assert.ok(startSeq! < recvSeq, 'b started only because the instruction came after it')
    else {
      assert.equal(code(results[0].reason), 'instructions-pending')
      assert.equal(startSeq, undefined, 'the instruction came first and blocked the start')
    }
    assert.equal(r.instructions?.i1.ack, null)
  }
})

test('the brief shows unacknowledged instructions in full; a cancelled run takes none', async () => {
  const { ws, ref } = await setup()
  await exec(ws, ref, { op: 'node.start', node: 'a' })
  await assert.rejects(exec(ws, ref, { op: 'question.ask', question: 'q1', node: 'a', text: 'plan?', to: 'Pat', plan: true }), /no plan step/, 'a manual run has no plan.md to ask about')
  await person(ws, ref, 'Line one.\nLine two.')
  const r = await rec(ws, ref)
  const brief = instructionBrief(r).join('\n')
  assert.match(brief, /received and not yet acknowledged \(1\)/)
  assert.match(brief, /- i1, from Pat at .*:\n {4}Line one\.\n {4}Line two\./)
  await runOp(ws, ref, { op: 'run.cancel', reason: 'no longer needed' }, { by: 'Pat', via: 'cli' })
  await assert.rejects(person(ws, ref, 'too late'), (e: unknown) => code(e) === 'run-cancelled')
})
