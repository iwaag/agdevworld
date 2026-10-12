// p7 step 5: adjustments of a run's future work — immutable revisions, replay
// across them, refusals that leave nothing behind, authorization by the
// person's records, and the correction-after-review sequence.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { adjustRun, createRun, readRun, registerPresentation, runOp, type AdjustOptions } from '../server/runs.ts'
import { Presenter } from '../server/present.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import { checkRecord, notableEvents, type OpInput, type RunGraph, type RunRef } from '../shared/run.ts'
import { renderMessage } from '../shared/notify.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-adjust-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
const presenters: Presenter[] = []
after(async () => {
  for (const pr of presenters) { for (const r of pr['all']<{ id: string; pid: number | null }>('SELECT * FROM instances')) if (r.pid && Presenter.command(r.pid).includes(r.id)) { try { process.kill(r.pid, 'SIGKILL') } catch { /* gone */ } } pr.close() }
  await rm(root, { recursive: true, force: true })
})

const node = (id: string, type: string, extra = '') => `  ${id}:\n    type: ${type}\n    description: ${id}.\n${extra}`
const FLOW = (nodes: string, edges: [string, string][], policy = 'default') => `schema: ag.workflow.v2
id: improve
name: Improve
intent: |
  Implement, verify, present, confirm, clean up.
documentation: {policy: ${policy}}
repositories:
  game: {path: ., access: editable}
nodes:
${nodes}edges:
${edges.map(([a, b]) => `  - {from: ${a}, to: ${b}}`).join('\n')}
`
const BASE_NODES = node('implement', 'do') + node('verify', 'do') + node('present', 'do', '    appearance: {icon: present, color: teal}\n') + node('check', 'talk', '    confirms: result\n') + node('cleanup', 'do')
const BASE_EDGES: [string, string][] = [['implement', 'verify'], ['verify', 'present'], ['present', 'check'], ['check', 'cleanup']]

let k = 0
async function setup(policy = 'default') {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-p')
  const r = await createProject({ dir, id: 'p', name: 'P', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'improve.yaml'), FLOW(BASE_NODES, BASE_EDGES, policy))
  await mkdir(join(dir, 'game'), { recursive: true })
  await writeFile(join(dir, 'game', 'index.html'), '<p>v1</p>')
  await writeFile(join(dir, 'review.md'), '# Review\n\nCheck it.\n')
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  await writeFile(join(area, 'present.json'), JSON.stringify({ ports: [18500 + k * 10, 18509 + k * 10] }))
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  const created = await createRun(ws, { workflow: 'improve', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'make it so', author: 'Pat' } })
  const pr = new Presenter({ registryFile: registry, area })
  presenters.push(pr)
  return { ws, ref: created.ref, dir, area, pr, folder: join(dir, 'devdocs', 'runs', 'improve', created.ref.run) }
}
const op = (ws: Workspace, ref: RunRef, o: OpInput, by = 'agent') => runOp(ws, ref, o, { by, via: 'cli' })
const rec = async (ws: Workspace, ref: RunRef) => { const r = await readRun(ws, ref); assert.ok(r.record, r.problem?.message); return r.record! }
const code = (e: unknown) => ((e as RequestError).detail as { code?: string } | undefined)?.code
const adjust = (ws: Workspace, ref: RunRef, text: string, o: Partial<AdjustOptions> = {}, by = 'agent') => adjustRun(ws, ref, { text, reason: o.reason ?? 'test', source: o.source ?? { kind: 'person', by }, ...o }, { by, via: 'cli' })

// Agrees the plan and completes nodes up to (not including) `until`.
async function advance(ws: Workspace, ref: RunRef, folder: string, upto: string[]) {
  await op(ws, ref, { op: 'node.start', node: '_plan' })
  await writeFile(join(folder, 'plan.md'), '# Plan\n')
  await op(ws, ref, { op: 'question.ask', question: '', node: '_plan', text: 'Agree?', to: 'Pat' })
  await op(ws, ref, { op: 'question.answer', question: 'q1', text: 'Yes', from: 'Pat' }, 'Pat')
  await op(ws, ref, { op: 'question.take-up', question: 'q1' })
  await op(ws, ref, { op: 'node.complete', node: '_plan', outcome: 'agreed' })
  for (const n of upto) {
    await op(ws, ref, { op: 'node.start', node: n })
    await op(ws, ref, { op: 'node.complete', node: n, outcome: `${n} done` })
    await op(ws, ref, { op: 'node.start', node: `_report.${n}` })
    await writeFile(join(folder, `report-${n}.md`), `# ${n}\n`)
    await op(ws, ref, { op: 'node.complete', node: `_report.${n}`, outcome: `reported ${n}` })
  }
}

test('removing future cleanup and adding a step: a new revision; past state kept; replay and re-read agree; the original stays', async () => {
  const { ws, ref, folder } = await setup()
  await advance(ws, ref, folder, ['implement'])
  const before = await rec(ws, ref)
  const original = await readFile(join(folder, 'definition', 'improve.yaml'), 'utf8')
  const text = FLOW(node('implement', 'do') + node('verify', 'do') + node('lint', 'do') + node('present', 'do') + node('check', 'talk', '    confirms: result\n'),
    [['implement', 'verify'], ['verify', 'lint'], ['lint', 'present'], ['present', 'check']])
  const dry = await adjust(ws, ref, text, { dryRun: true })
  assert.ok(dry.ok, JSON.stringify(dry.problems))
  assert.deepEqual(dry.authored.added, ['lint'])
  assert.deepEqual(dry.authored.removed, ['cleanup'])
  assert.ok(dry.graph.added.includes('_report.lint') && dry.graph.removed.includes('_report.cleanup'), 'generated steps follow')
  assert.equal((await rec(ws, ref)).seq, before.seq, 'a dry run writes nothing')
  const res = await adjust(ws, ref, text, { reason: 'no server to stop; lint first' })
  assert.equal(res.revision, 'r2')
  const r = await rec(ws, ref)
  assert.equal(r.definition.active, 'r2')
  assert.equal(r.definition.revisions![0].parent, 'r1')
  assert.deepEqual(r.definition.revisions![0].source, { kind: 'person', by: 'agent' })
  assert.equal(r.nodes.implement.state, 'completed', 'completed work keeps its record')
  assert.deepEqual(r.nodes.implement, before.nodes.implement)
  assert.equal(r.nodes.lint.state, 'pending')
  assert.equal(r.nodes.cleanup, undefined, 'removed pending work leaves the state')
  assert.equal(await readFile(join(folder, 'definition', 'improve.yaml'), 'utf8'), original, 'the original snapshot is unchanged')
  assert.equal(await readFile(join(folder, 'definition', 'r2', 'improve.yaml'), 'utf8'), text)
  // The whole history replays from the original graph across the revision.
  const eff = r.definition.effective!
  const replayed = checkRecord(JSON.parse(await readFile(join(folder, 'run.json'), 'utf8')), { nodes: eff.nodes, edges: eff.edges } as RunGraph)
  assert.ok(replayed.ok, !replayed.ok ? replayed.message : '')
  // Work continues on the new graph.
  await op(ws, ref, { op: 'node.start', node: 'verify' })
  await op(ws, ref, { op: 'node.complete', node: 'verify', outcome: 'verified' })
  await op(ws, ref, { op: 'node.start', node: '_report.verify' })
  await writeFile(join(folder, 'report-verify.md'), '# v\n')
  await op(ws, ref, { op: 'node.complete', node: '_report.verify', outcome: 'ok' })
  assert.deepEqual((await rec(ws, ref)).execution.ready, ['lint'])
  const ev = notableEvents(await rec(ws, ref)).find(e => e.type === 'adjusted')!
  assert.deepEqual(ev.adjusted, { added: ['lint'], removed: ['cleanup'] })
  assert.match(renderMessage([ev], { ref: 'improve/run-001', executor: 'agent', answerRoute: () => '', link: p => ({ path: p, name: p }), label: x => x, openQuestion: () => false, now: new Date() }), /\*\*Plan adjusted\*\* \(r2\) by agent — added lint; removed cleanup/)
})

test('refusals: stale, cyclic, mid-node, started work, question-destroying, access-expanding, nothing executable — atomically', async () => {
  const { ws, ref, folder } = await setup()
  await advance(ws, ref, folder, ['implement'])
  const r0 = await rec(ws, ref)
  const ok = FLOW(BASE_NODES + node('extra', 'do'), [...BASE_EDGES, ['cleanup', 'extra']])
  const expect = async (text: string, want: string, o: Partial<AdjustOptions> = {}) => {
    const res = await adjust(ws, ref, text, o)
    assert.equal(res.ok, false, `${want} expected`)
    assert.ok(res.problems.some(p => p.code === want), `${want} expected, got ${res.problems.map(p => p.code).join(', ')}`)
  }
  await expect(ok, 'revision-outdated', { expectRevision: 'r2' })
  await expect(FLOW(BASE_NODES, [...BASE_EDGES, ['cleanup', 'verify']]), 'adjust-graph')
  await expect(FLOW(BASE_NODES.replace('implement.', 'implement differently.'), BASE_EDGES), 'adjust-started')
  await expect(FLOW(BASE_NODES.replace(node('implement', 'do'), ''), BASE_EDGES.slice(1)), 'adjust-started')
  await expect(FLOW(node('pre', 'do') + BASE_NODES, [['pre', 'implement'], ...BASE_EDGES]), 'adjust-dependencies')
  await expect(FLOW(BASE_NODES, BASE_EDGES).replace('game: {path: ., access: editable}', 'game: {path: ., access: editable}\n  docs: {path: devdocs, access: editable}'), 'adjust-access')
  await expect(FLOW(BASE_NODES, BASE_EDGES).replace('policy: default', 'policy: manual'), 'adjust-access')
  await expect(FLOW(BASE_NODES.replace('color: teal', 'color: rose'), BASE_EDGES), 'adjust-nothing')
  // Mid-node: verify is running.
  await op(ws, ref, { op: 'node.start', node: 'verify' })
  await expect(ok, 'mid-node')
  await op(ws, ref, { op: 'node.complete', node: 'verify', outcome: 'v' })
  await op(ws, ref, { op: 'node.start', node: '_report.verify' })
  await writeFile(join(folder, 'report-verify.md'), '# v\n')
  await op(ws, ref, { op: 'node.complete', node: '_report.verify', outcome: 'v' })
  // A question waits on a node: it is not removed or rewritten.
  await op(ws, ref, { op: 'node.start', node: 'present' })
  await op(ws, ref, { op: 'question.ask', question: '', node: 'present', text: 'Which colour?', to: 'Pat' })
  await expect(FLOW(BASE_NODES.replace(node('present', 'do', '    appearance: {icon: present, color: teal}\n'), node('present', 'do', '    name: Show\n')), BASE_EDGES), 'adjust-question')
  const after = await rec(ws, ref)
  assert.equal(after.definition.revisions, undefined, 'no refusal changed the record')
  assert.equal(after.seq, r0.seq + 6, 'only the six work entries were recorded')
  assert.deepEqual((await readdir(join(folder, 'definition'))).sort(), ['improve.yaml'], 'no revision file was left behind')
  // A refusal by the record itself (here: the executor's attempt is open) writes nothing either.
  await op(ws, ref, { op: 'question.answer', question: 'q2', text: 'teal', from: 'Pat' }, 'Pat')
  await op(ws, ref, { op: 'question.take-up', question: 'q2' })
  await op(ws, ref, { op: 'node.complete', node: 'present', outcome: 'p' })
  await runOp(ws, ref, { op: 'attempt.begin', attempt: 'a-x1', reason: 'resume' }, { by: 'autolab', via: 'exec' })
  const held = await adjustRun(ws, ref, { text: ok, reason: 'r', source: { kind: 'person', by: 'Pat' } }, { by: 'Pat', via: 'cli' })
  assert.ok(held.problems.some(p => p.code === 'attempt-open' && /attempt a-x1 is executing/.test(p.message)), 'a person\'s adjustment waits until no attempt is open')
  assert.deepEqual((await readdir(join(folder, 'definition'))).sort(), ['improve.yaml'])
})

test('authorization: an answer that was not taken up, an unacknowledged instruction, or a different proposal authorize nothing; pending instructions block an adjustment and the run\'s last completion', async () => {
  const { ws, ref, folder } = await setup()
  await advance(ws, ref, folder, ['implement'])
  const text = FLOW(BASE_NODES + node('extra', 'do'), [...BASE_EDGES, ['cleanup', 'extra']])
  await op(ws, ref, { op: 'instruction.receive', text: 'Also add a tutorial screen.', from: 'Pat' }, 'Pat')
  let res = await adjust(ws, ref, text, { source: { kind: 'instruction', instruction: 'i1' } })
  assert.ok(res.problems.some(p => p.code === 'instructions-pending'), 'an adjustment is a boundary: pending input is not bypassed')
  await op(ws, ref, { op: 'instruction.ack', instructions: ['i1'], response: 'incorporate', note: 'add a tutorial step' })
  res = await adjust(ws, ref, text, { source: { kind: 'answer', question: 'q1', answer: 5 } })
  assert.ok(res.problems.some(p => p.code === 'adjust-unauthorized'))
  // Agreement must be to this exact proposal.
  const proposed = await adjust(ws, ref, text, { propose: 'tutorial' })
  assert.equal(proposed.proposal, 'definition/proposals/tutorial.yaml')
  await op(ws, ref, { op: 'node.start', node: 'verify' })
  await op(ws, ref, { op: 'question.ask', question: '', node: 'verify', text: 'Add a tutorial step after cleanup?', to: 'Pat', adjustment: 'tutorial' })
  await op(ws, ref, { op: 'question.answer', question: 'q2', text: 'Yes', from: 'Pat' }, 'Pat')
  await op(ws, ref, { op: 'question.take-up', question: 'q2' })
  await op(ws, ref, { op: 'node.complete', node: 'verify', outcome: 'v' })
  res = await adjust(ws, ref, text.replace('extra.', 'something else.'), { source: { kind: 'agreement', question: 'q2' } })
  assert.ok(res.problems.some(p => p.code === 'adjust-unauthorized' && /exact definition/.test(p.message)))
  res = await adjust(ws, ref, text, { source: { kind: 'agreement', question: 'q2' }, reason: 'the person agreed in q2' })
  assert.ok(res.ok, JSON.stringify(res.problems))
  assert.equal((await rec(ws, ref)).definition.active, 'r2')
  // The run's last completion is refused while an instruction is pending.
  const m = await setup('manual')
  for (const n of ['implement', 'verify', 'present', 'check']) { await op(m.ws, m.ref, { op: 'node.start', node: n }); await op(m.ws, m.ref, { op: 'node.complete', node: n, outcome: n }) }
  await op(m.ws, m.ref, { op: 'node.start', node: 'cleanup' })
  await op(m.ws, m.ref, { op: 'instruction.receive', text: 'Wait, one more thing.', from: 'Pat' }, 'Pat')
  await assert.rejects(op(m.ws, m.ref, { op: 'node.complete', node: 'cleanup', outcome: 'done' }), (e: unknown) => code(e) === 'instructions-pending')
})

test('a correction after review: new repair, verification, presentation and confirmation; completed nodes and the earlier question, answer and presentation stay; the old answer never accepts', async () => {
  const { ws, ref, folder, pr, dir } = await setup()
  await advance(ws, ref, folder, ['implement', 'verify'])
  await op(ws, ref, { op: 'node.start', node: 'present' })
  await registerPresentation(ws, ref, { node: 'present', source: 'game', entry: 'index.html', review: 'review.md', title: 'v1' }, { via: 'cli', by: 'agent' })
  const before = await rec(ws, ref)
  assert.ok(before.presentations?.p1, 'p1 registered')
  await pr.start(ws, ref, 'p1')
  await op(ws, ref, { op: 'node.complete', node: 'present', outcome: 'presented p1' })
  await op(ws, ref, { op: 'node.start', node: '_report.present' })
  await writeFile(join(folder, 'report-present.md'), '# p\n')
  await op(ws, ref, { op: 'node.complete', node: '_report.present', outcome: 'p1 served' })
  await op(ws, ref, { op: 'node.start', node: 'check' })
  const q = (await op(ws, ref, { op: 'question.ask', question: '', node: 'check', text: 'Accept?', to: 'Pat', presentation: 'p1' })).record
  const qid = Object.keys(q.questions).at(-1)!
  await op(ws, ref, { op: 'question.answer', question: qid, text: 'Units are too slow; make them faster.', from: 'Pat' }, 'Pat')
  await op(ws, ref, { op: 'question.take-up', question: qid })
  await op(ws, ref, { op: 'node.complete', node: 'check', outcome: 'correction requested: faster units' })
  // The correction: repair → verify → present again → confirm again → cleanup.
  const text = FLOW(BASE_NODES.replace('    confirms: result\n', '    confirms: result\n') + node('repair', 'do') + node('reverify', 'do') + node('represent', 'do', '    appearance: {icon: present, color: teal}\n') + node('recheck', 'talk', '    confirms: result\n'),
    [['implement', 'verify'], ['verify', 'present'], ['present', 'check'], ['check', 'repair'], ['repair', 'reverify'], ['reverify', 'represent'], ['represent', 'recheck'], ['recheck', 'cleanup']])
  const res = await adjust(ws, ref, text, { source: { kind: 'answer', question: qid }, reason: `${qid}: the person asked for faster units` })
  assert.ok(res.ok, JSON.stringify(res.problems))
  let r = await rec(ws, ref)
  for (const n of ['implement', 'verify', 'present', 'check', '_plan', '_report.implement']) assert.equal(r.nodes[n].state, 'completed', `${n} stays completed`)
  assert.equal(r.nodes.cleanup.state, 'pending')
  assert.deepEqual(r.definition.revisions![0].diff.edgesAdded.find(([, b]) => b === 'cleanup'), ['_report.recheck', 'cleanup'], 'cleanup now follows the latest review')
  assert.equal(r.questions[qid].answers[0].text, 'Units are too slow; make them faster.', 'the earlier answer stays')
  assert.equal(r.presentations!.p1.state, 'available')
  assert.equal(r.decisions.length, 0, 'a correction is not a decision')
  // The old answer cannot become acceptance: a later presentation supersedes it.
  await op(ws, ref, { op: 'node.start', node: '_report.check' })
  await writeFile(join(folder, 'report-check.md'), '# check\n\ncorrection requested\n')
  await op(ws, ref, { op: 'node.complete', node: '_report.check', outcome: 'correction requested' })
  for (const n of ['repair', 'reverify']) {
    await op(ws, ref, { op: 'node.start', node: n }); await op(ws, ref, { op: 'node.complete', node: n, outcome: n })
    await op(ws, ref, { op: 'node.start', node: `_report.${n}` }); await writeFile(join(folder, `report-${n}.md`), `# ${n}\n`); await op(ws, ref, { op: 'node.complete', node: `_report.${n}`, outcome: n })
  }
  await op(ws, ref, { op: 'node.start', node: 'represent' })
  await pr.stop(ws, ref, 'p1')
  await writeFile(join(dir, 'game', 'index.html'), '<p>v2 faster</p>')
  await registerPresentation(ws, ref, { node: 'represent', source: 'game', entry: 'index.html', review: 'review.md', title: 'v2' }, { via: 'cli', by: 'agent' })
  await assert.rejects(op(ws, ref, { op: 'run.decide', decision: 'accepted', question: qid }), (e: unknown) => ['presentation-superseded', 'not-result-confirmation'].includes(code(e) ?? ''))
  await pr.start(ws, ref, 'p2')
  await op(ws, ref, { op: 'node.complete', node: 'represent', outcome: 'presented p2' })
  await op(ws, ref, { op: 'node.start', node: '_report.represent' }); await writeFile(join(folder, 'report-represent.md'), '# r\n'); await op(ws, ref, { op: 'node.complete', node: '_report.represent', outcome: 'p2' })
  await op(ws, ref, { op: 'node.start', node: 'recheck' })
  const q2 = Object.keys((await op(ws, ref, { op: 'question.ask', question: '', node: 'recheck', text: 'Faster now?', to: 'Pat', presentation: 'p2' })).record.questions).at(-1)!
  await op(ws, ref, { op: 'question.answer', question: q2, text: 'Yes, accepted.', from: 'Pat' }, 'Pat')
  await op(ws, ref, { op: 'question.take-up', question: q2 })
  await op(ws, ref, { op: 'run.decide', decision: 'accepted', question: q2 })
  r = await rec(ws, ref)
  assert.equal(r.decisions.length, 1)
  assert.equal(r.decisions[0].confirmation?.presentation?.id, 'p2')
  assert.notEqual(r.decisions[0].confirmation?.question, qid, 'the prior answer was not reused')
  await pr.stop(ws, ref, 'all')
})

test('a changed revision file makes the record unusable instead of being recompiled', async () => {
  const { ws, ref, folder } = await setup()
  await advance(ws, ref, folder, ['implement'])
  await adjust(ws, ref, FLOW(BASE_NODES + node('extra', 'do'), [...BASE_EDGES, ['cleanup', 'extra']]))
  const file = join(folder, 'definition', 'r2', 'improve.yaml')
  await writeFile(file, (await readFile(file, 'utf8')).replace('extra.', 'tampered.'))
  const r = await readRun(ws, ref)
  assert.equal(r.record, undefined)
  assert.equal(r.problem?.code, 'bundle')
  assert.match(r.problem!.message, /r2 was changed/)
})

test('an interrupted adjustment (revision file written, run.json not) leaves the run on its revision; the next adjustment replaces the leftover', async () => {
  const { ws, ref, folder } = await setup()
  await advance(ws, ref, folder, ['implement'])
  await mkdir(join(folder, 'definition', 'r2'), { recursive: true })
  await writeFile(join(folder, 'definition', 'r2', 'improve.yaml'), 'half-written: [')
  const r = await rec(ws, ref)
  assert.equal(r.definition.active, undefined, 'the run still follows r1; the leftover is not part of it')
  const text = FLOW(BASE_NODES + node('extra', 'do'), [...BASE_EDGES, ['cleanup', 'extra']])
  const res = await adjust(ws, ref, text)
  assert.equal(res.revision, 'r2')
  assert.equal(await readFile(join(folder, 'definition', 'r2', 'improve.yaml'), 'utf8'), text)
  assert.equal((await rec(ws, ref)).definition.active, 'r2')
})
