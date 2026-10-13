// p8/ex2 step 4: a run's work grown from its conversation — a talk is
// answered and completed, work is added at the boundary, done, and a new
// talk adds more — with the final report, with node reports, and without a
// final report, where the last completion and the added work are recorded
// together (run.adjust `completing`). Nothing here depends on a workflow's
// name: the workflow is called "adhoc".
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replay, RunError, type OpInput } from '../shared/run.ts'
import { createProject } from '../server/create.ts'
import { loadRegistry } from '../server/registry.ts'
import { adjustRun, createRun, readRun, runOp, type AdjustOptions } from '../server/runs.ts'
import { parseWorkflow, renderWorkflow } from '../server/yamlDoc.ts'
import { RequestError, Workspace } from '../server/workspace.ts'

let root = ''
let n = 0
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-growth-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const DOC = { finalOnly: '  policy: custom\n  plan: false\n  reports: false\n  final: true', reports: '  policy: custom\n  plan: false\n  reports: true\n  final: true', none: '  policy: custom\n  plan: false\n  reports: false\n  final: false' }
const WF = (id: string, doc: string) => `schema: ag.workflow.v2\nid: ${id}\nname: Ad hoc\nintent: Start from the braindump and grow the work in conversation.\ndocumentation:\n${doc}\nnodes:\n  talk:\n    type: talk\n    name: Talk\n    description: Understand the request, hold the consultation it needs, and make the next work concrete.\n`

async function setup(doc: string, id = 'adhoc') {
  const registry = join(root, `p${++n}.registry.json`)
  const dir = join(root, `pj-g${n}`)
  const made = await createProject({ dir, id: `g${n}`, name: `g${n}`, intent: 'x', goals: ['g'], devdocs: 'directory', sourcesDir: join(root, 'sources'), registryFile: registry })
  assert.ok(made.ok, made.message)
  await writeFile(join(dir, 'devdocs', 'workflows', `${id}.yaml`), WF(id, doc))
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  const { ref } = await createRun(ws, { workflow: id, input: { kind: 'braindump', text: 'Make me a small tool; ask what you need.', author: 'Person' }, executor: { name: 'Agent', backend: null }, by: 'Agent', via: 'cli' })
  const folder = join(dir, 'devdocs', 'runs', id, ref.run)
  const op = (i: OpInput & { attempt?: string }, by = 'Agent') => runOp(ws, ref, i, { via: 'cli', by }).then(r => r.record)
  // The definition in force, as `wfe run revisions --show` prints it.
  const active = async () => {
    const rec = (await readRun(ws, ref)).record!
    const rev = rec.definition.revisions?.at(-1)
    return readFile(join(folder, rev ? rev.file : `definition/${id}.yaml`), 'utf8')
  }
  // The active definition with nodes added after `after` (and whatever else `edit` does).
  const grown = async (nodes: Record<string, { type: string; name: string; description: string }>, edges: [string, string][]) => {
    const p = parseWorkflow(await active())
    assert.ok(p.ok)
    for (const [k, v] of Object.entries(nodes)) p.model.nodes[k] = { ...v, repositories: [] }
    for (const [from, to] of edges) p.model.edges.push({ from, to })
    return renderWorkflow(p.doc, p.model)
  }
  const adjust = async (text: string, o: Partial<AdjustOptions> = {}, ctx: { receipt?: string; attempt?: string; expectSeq?: number } = {}) =>
    adjustRun(ws, ref, { text, reason: 'the conversation agreed this work', source: { kind: 'answer', question: 'q1' }, ...o }, { via: 'cli', by: 'Agent', ...ctx })
  // A talk asks, is answered and takes the answer up.
  const converse = async (node: string, q: string, answer: string) => {
    await op({ op: 'question.ask', question: q, node, text: 'What should the tool do?', to: 'Person' } as OpInput)
    await op({ op: 'question.answer', question: q, text: answer }, 'Person')
    return op({ op: 'question.take-up', question: q })
  }
  return { ws, ref, dir, folder, op, active, grown, adjust, converse }
}
const work = (s: Awaited<ReturnType<typeof setup>>, node: string) => s.op({ op: 'node.start', node }).then(() => s.op({ op: 'node.complete', node, outcome: `${node} done` }))
const ready = async (s: Awaited<ReturnType<typeof setup>>) => (await readRun(s.ws, s.ref)).record!.execution.ready

test('with a final report: talk, add work at the boundary, do it, talk again, add more, end', async () => {
  const s = await setup(DOC.finalOnly)
  assert.deepEqual(await ready(s), ['talk'])
  await s.op({ op: 'node.start', node: 'talk' })
  await s.converse('talk', 'q1', 'A CSV to JSON converter, then show me.')
  await s.op({ op: 'node.complete', node: 'talk', outcome: 'Agreed: a CSV to JSON converter.' })
  assert.deepEqual(await ready(s), ['_final-report'], 'after the talk only the final report is ready: the boundary')
  const r2 = await s.adjust(await s.grown({ build: { type: 'do', name: 'Build', description: 'Write the converter.' } }, [['talk', 'build']]))
  assert.ok(r2.ok, JSON.stringify(r2.problems))
  assert.equal(r2.revision, 'r2')
  assert.deepEqual(await ready(s), ['build'], 'the final report now waits for the added work')
  await work(s, 'build')
  // The next conversation is a new talk: the finished one is never reused or rewritten.
  const reuse = await s.adjust((await s.active()).replace('Understand the request, hold', 'Talk again; hold'), { dryRun: true })
  assert.ok(!reuse.ok && reuse.problems.some(p => p.code === 'adjust-started'), 'a completed talk is not rewritten')
  const r3 = await s.adjust(await s.grown({ review: { type: 'talk', name: 'Review', description: 'Show the converter and agree what comes next.' } }, [['build', 'review']]))
  assert.ok(r3.ok, JSON.stringify(r3.problems))
  await s.op({ op: 'node.start', node: 'review' })
  await s.converse('review', 'q2', 'Add a --pretty flag.')
  await s.op({ op: 'node.complete', node: 'review', outcome: 'Asked for --pretty.' })
  const r4 = await s.adjust(await s.grown({ pretty: { type: 'do', name: 'Pretty output', description: 'Add --pretty.' } }, [['review', 'pretty']]), { source: { kind: 'answer', question: 'q2' } })
  assert.ok(r4.ok, JSON.stringify(r4.problems))
  await work(s, 'pretty')
  await s.op({ op: 'node.start', node: '_final-report' })
  await writeFile(join(s.folder, 'report.md'), '# Report\n\nConverter with --pretty.\n')
  const done = await s.op({ op: 'node.complete', node: '_final-report', outcome: 'Converter delivered.' })
  assert.equal(done.execution.state, 'completed')
  assert.deepEqual(done.definition.revisions!.map(r => r.revision), ['r2', 'r3', 'r4'])
  assert.deepEqual(Object.keys(done.nodes).sort(), ['_final-report', 'build', 'pretty', 'review', 'talk'])
  assert.ok(replay(done.history, { nodes: done.definition.effective!.nodes, edges: done.definition.effective!.edges }), 'the history replays')
})

test('with node reports: the talk\'s report stays its report; work is added before or after it', async () => {
  const s = await setup(DOC.reports)
  await s.op({ op: 'node.start', node: 'talk' })
  await s.converse('talk', 'q1', 'Do it.')
  await s.op({ op: 'node.complete', node: 'talk', outcome: 'Agreed.' })
  assert.deepEqual(await ready(s), ['_report.talk'])
  // Added while the talk's report is pending.
  const r2 = await s.adjust(await s.grown({ build: { type: 'do', name: 'Build', description: 'Build.' } }, [['talk', 'build']]))
  assert.ok(r2.ok, JSON.stringify(r2.problems))
  assert.deepEqual(r2.graph.edgesAdded.map(e => e.join('>')).sort(), ['_report.build>_final-report', '_report.talk>build', 'build>_report.build'])
  await s.op({ op: 'node.start', node: '_report.talk' })
  await writeFile(join(s.folder, 'report-talk.md'), '# talk\n\nAgreed.\n')
  await s.op({ op: 'node.complete', node: '_report.talk', outcome: 'Reported.' })
  await work(s, 'build')
  // Added after a completed report: that report keeps its edges.
  await s.op({ op: 'node.start', node: '_report.build' })
  await writeFile(join(s.folder, 'report-build.md'), '# build\n\nBuilt.\n')
  await s.op({ op: 'node.complete', node: '_report.build', outcome: 'Reported.' })
  const r3 = await s.adjust(await s.grown({ check: { type: 'do', name: 'Check', description: 'Check.' } }, [['build', 'check']]))
  assert.ok(r3.ok, JSON.stringify(r3.problems))
  assert.deepEqual(await ready(s), ['check'])
})

test('without a final report: the last completion and the added work are recorded together; plain work ends as before', async () => {
  const s = await setup(DOC.none)
  await s.op({ op: 'node.start', node: 'talk' })
  await s.converse('talk', 'q1', 'Write a script.')
  const text = await s.grown({ script: { type: 'do', name: 'Script', description: 'Write it.' } }, [['talk', 'script']])
  // The gap: a plain adjustment is mid-node while the talk runs …
  const mid = await s.adjust(text, { dryRun: true })
  assert.ok(!mid.ok && mid.problems.some(p => p.code === 'mid-node'))
  // … and after its plain completion the run is complete and stays so.
  const probe = await setup(DOC.none)
  await probe.op({ op: 'node.start', node: 'talk' })
  await probe.converse('talk', 'q1', 'x')
  const ended = await probe.op({ op: 'node.complete', node: 'talk', outcome: 'x' })
  assert.equal(ended.execution.state, 'completed')
  const late = await probe.adjust(await probe.grown({ more: { type: 'do', name: 'More', description: 'm' } }, [['talk', 'more']]), { dryRun: true })
  assert.ok(!late.ok && late.problems.some(p => p.code === 'run-completed'), 'a completed run is not revived')

  // The combined operation: a dry run writes nothing.
  const seq = (await readRun(s.ws, s.ref)).record!.seq
  const dry = await s.adjust(text, { dryRun: true, completing: { node: 'talk', outcome: 'Agreed: a script.' } })
  assert.ok(dry.ok, JSON.stringify(dry.problems))
  assert.equal((await readRun(s.ws, s.ref)).record!.seq, seq)
  const r2 = await s.adjust(text, { completing: { node: 'talk', outcome: 'Agreed: a script.' } }, { receipt: 'grow-0001' })
  assert.ok(r2.ok, JSON.stringify(r2.problems))
  const rec = (await readRun(s.ws, s.ref)).record!
  assert.deepEqual(rec.history.slice(-2).map(h => h.op), ['run.adjust', 'node.complete'])
  assert.equal(rec.nodes.talk.state, 'completed')
  assert.equal(rec.execution.state, 'in-progress')
  assert.deepEqual(rec.execution.ready, ['script'])
  // A retransmission records nothing again and leaves no stray revision.
  const again = await s.adjust(text, { completing: { node: 'talk', outcome: 'Agreed: a script.' } }, { receipt: 'grow-0001' })
  assert.ok(again.ok && again.duplicate)
  assert.equal((await readRun(s.ws, s.ref)).record!.seq, rec.seq)
  assert.deepEqual((await readdir(join(s.folder, 'definition'))).sort(), ['adhoc.yaml', 'r2'])
  // Work with nothing added after it completes the run as before.
  const fin = await work(s, 'script')
  assert.equal(fin.execution.state, 'completed')
})

test('the combined operation refuses what is not a boundary, and records neither part on a refusal', async () => {
  const s = await setup(DOC.none)
  const text = await s.grown({ a: { type: 'do', name: 'A', description: 'a' }, b: { type: 'do', name: 'B', description: 'b' } }, [['talk', 'a'], ['talk', 'b']])
  // Not running yet: nothing to complete.
  const early = await s.adjust(text, { dryRun: true, completing: { node: 'talk', outcome: 'x' } })
  assert.ok(!early.ok && early.problems.some(p => p.code === 'state'))
  await s.op({ op: 'node.start', node: 'talk' })
  await s.converse('talk', 'q1', 'Two things.')
  const r2 = await s.adjust(text, { completing: { node: 'talk', outcome: 'Two things agreed.' } })
  assert.ok(r2.ok)
  // Another node running is still mid-node.
  await s.op({ op: 'node.start', node: 'a' })
  await s.op({ op: 'node.start', node: 'b' })
  const more = await s.grown({ c: { type: 'do', name: 'C', description: 'c' } }, [['a', 'c']])
  const busy = await s.adjust(more, { completing: { node: 'a', outcome: 'a done' }, source: { kind: 'answer', question: 'q1' } })
  assert.ok(!busy.ok && busy.problems.some(p => p.code === 'mid-node'), JSON.stringify(busy.problems))
  // A stale view: an adjustment made from r1 while r2 is in force.
  const stale = await s.adjust(more, { expectRevision: 'r1', dryRun: true })
  assert.ok(!stale.ok && stale.problems.some(p => p.code === 'revision-outdated'))
  // An attempt that is not open records nothing.
  await assert.rejects(s.adjust(more, {}, { attempt: 'a-gone' }).then(r => { if (!r.ok) throw new RequestError(422, r.problems.map(p => p.code).join(','), { code: r.problems[0].code }); return r }), /attempt/)
  // A failure partway: the completion is refused (an unacknowledged
  // instruction at the boundary), so the adjustment is not recorded either
  // and its revision file is removed.
  await s.op({ op: 'node.complete', node: 'b', outcome: 'b done' })
  await s.op({ op: 'instruction.receive', text: 'Also log it.', from: 'Person' }, 'Person')
  const blocked = await s.adjust(more, { completing: { node: 'a', outcome: 'a done' } })
  assert.ok(!blocked.ok && blocked.problems.some(p => p.code === 'instructions-pending'))
  const rec = (await readRun(s.ws, s.ref)).record!
  assert.equal(rec.nodes.a.state, 'running')
  assert.equal(rec.definition.active, 'r2')
  assert.deepEqual((await readdir(join(s.folder, 'definition'))).sort(), ['adhoc.yaml', 'r2'])
})

test('a history whose completing adjustment is not followed by that completion is not usable', async () => {
  const s = await setup(DOC.none)
  await s.op({ op: 'node.start', node: 'talk' })
  await s.converse('talk', 'q1', 'x')
  const r2 = await s.adjust(await s.grown({ x: { type: 'do', name: 'X', description: 'x' } }, [['talk', 'x']]), { completing: { node: 'talk', outcome: 'x' } })
  assert.ok(r2.ok)
  const file = join(s.folder, 'run.json')
  const raw = JSON.parse(await readFile(file, 'utf8'))
  const g = raw.definition.effective
  // Without the completion that belongs to it:
  assert.throws(() => replay(raw.history.slice(0, -1), { nodes: g.nodes, edges: g.edges }), (e: unknown) => e instanceof RunError && e.code === 'completion-owed')
  // With something else in between:
  const swapped = [...raw.history.slice(0, -2), raw.history.at(-1), raw.history.at(-2)].map((h: { seq: number }, i: number) => ({ ...h, seq: i + 1 }))
  assert.throws(() => replay(swapped, { nodes: g.nodes, edges: g.edges }), (e: unknown) => e instanceof RunError)
  assert.ok(replay(raw.history, { nodes: g.nodes, edges: g.edges }).state.nodes.talk.state === 'completed')
})

test('the same structure under another id behaves the same (no name-based branch)', async () => {
  for (const id of ['freework', 'conversation-first']) {
    const s = await setup(DOC.none, id)
    await s.op({ op: 'node.start', node: 'talk' })
    await s.converse('talk', 'q1', 'x')
    const r = await s.adjust(await s.grown({ x: { type: 'do', name: 'X', description: 'x' } }, [['talk', 'x']]), { completing: { node: 'talk', outcome: 'x' } })
    assert.ok(r.ok, `${id}: ${JSON.stringify(r.problems)}`)
    assert.deepEqual(await ready(s), ['x'], id)
  }
})
