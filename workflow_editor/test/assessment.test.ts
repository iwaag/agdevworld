// workflow_editor fix6: the delegated-result assessment (shared/assessment.ts)
// and the wider coverage of the child's own presentation reminder. Child
// runs are real records made through the operations; the delegation around
// them is the parent's record shape. Observations are kept apart from
// judgement: a coordination or report-only result raises nothing, a file
// extension is a signal, a missing human answer is unknown, not a violation.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { createTemplate } from '../server/catalog.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { adjustRun, catalogOf, createRun, readRun, registerPresentation, runOp } from '../server/runs.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import { assessResult, assessmentLines, assessmentReminders, type ChildEvidence } from '../shared/assessment.ts'
import type { Delegation, DelegationEvent } from '../shared/delegation.ts'
import { graphOfState, type OpInput, type RunRecord } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-assessment-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const HEAD = `schema: ag.workflow.v2
id: freework
name: Free work
intent: |
  Serve the request.
documentation: {policy: manual}
repositories:
  project: {path: ., access: editable}
nodes:
  talk:
    type: talk
    description: Consult.
    repositories: []
`
const tpl = (id: string) => `    template: {id: ${id}, revision: 1, expectation: "${id} as its own node."}\n`
const node = (id: string, type: string, extra = '') => `  ${id}:\n    type: ${type}\n    description: ${id}.\n    repositories: []\n${extra}`
const flow = (nodes: string, edges: [string, string][]) => `${HEAD}${nodes}edges:\n${edges.map(([a, b]) => `  - {from: ${a}, to: ${b}}`).join('\n')}\n`

let k = 0
async function child(workflow = flow('', []).replace('edges:\n\n', 'edges: []\n')) {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-kid')
  const r = await createProject({ dir, id: 'kid', name: 'Kid', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'freework.yaml'), workflow)
  await mkdir(join(dir, 'out'), { recursive: true })
  await writeFile(join(dir, 'out', 'index.html'), '<p>result</p>')
  await writeFile(join(dir, 'review.md'), '# Review\n')
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  await createTemplate(area, 'work', { name: 'Work', type: 'do', description: 'Do it.', expectation: 'The work on its own nodes.' }, 'Pat')
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  const created = await createRun(ws, { workflow: 'freework', executor: { host: 'autolab' }, by: 'par-agent', via: 'cli', area, input: { kind: 'request', text: 'make it', requester: 'par-agent', onBehalfOf: 'Pat', entrustedBy: { kind: 'note', text: 'test' } } })
  const ref = created.ref
  const op = (o: OpInput, by = 'kid-agent') => runOp(ws, ref, o, { by, via: 'cli' })
  const adjust = async (text: string) => { const a = await adjustRun(ws, ref, { text, reason: 'test', source: { kind: 'agent' } }, { by: 'kid-agent', via: 'cli' }); assert.ok(a.ok, JSON.stringify(a.problems)); return a }
  const read = async () => { const x = await readRun(ws, ref); assert.ok(x.record, x.problem?.message); return { record: x.record!, bundle: x.bundle } }
  return { ws, ref, op, adjust, read, dir }
}
type C = Awaited<ReturnType<typeof child>>

const event = (n = 1): DelegationEvent => ({ n, type: 'completed', at: '2026-10-24T00:00:00.000Z', seq: 9, during: null, child: { seq: 9, at: '2026-10-24T00:00:00.000Z', by: 'kid-agent' }, wakes: true, text: 'done', manifest: { digest: 'sha256:' + 'a'.repeat(64), child: 'kid/freework/run-001#x', execution: 'completed', outcome: 'done', report: null, artifacts: [], decision: null, branch: null }, takenUp: null })
const delegation = (o: Partial<Delegation> = {}): Delegation => ({
  id: 'd1', uid: 'par/use/run-001#p/d1', node: 'asset', target: { project: 'kid', workflow: 'freework', workspace: 'kid' }, request: { path: 'r', sha256: 'x', bytes: 1 },
  requester: 'par-agent', onBehalfOf: 'Pat', accepts: 'person', dispatched: { at: '', by: 'par-agent', attempt: null, seq: 1 }, child: { uid: 'kid/freework/run-001#x', workspace: 'kid', project: 'kid', workflow: 'freework', run: 'run-001', created: '' },
  transport: null, events: [event()], answers: [], instructions: [], disposition: null, closed: null, ...o,
})
const parent = { executor: { name: 'par-agent' }, workflow: 'use', run: 'run-001' } as unknown as RunRecord

async function assess(c: C, o: { d?: Partial<Delegation>; changed?: ChildEvidence['changed'] } = {}) {
  const { record, bundle } = await c.read()
  const authored = bundle.revisions?.at(-1)?.workflow ?? bundle.entries[record.definition.root]?.workflow
  return assessResult(parent, delegation(o.d), event(), { frozen: record, graph: graphOfState(record) ?? null, authored, now: record, catalog: catalogOf(record, bundle), changed: o.changed ?? [], unavailable: [] })
}
const status = (a: Awaited<ReturnType<typeof assess>>, code: string) => a.checks.find(c => c.code === code)?.status

test('work-template output with nothing presented is missing; a later or linked presentation covers it; an older page does not cover later work', async () => {
  const c = await child()
  await c.op({ op: 'node.start', node: 'talk' })
  await c.adjust(flow(node('present', 'do', tpl('present')) + node('build', 'do', tpl('work')), [['talk', 'present'], ['present', 'build']]))
  await c.op({ op: 'node.complete', node: 'talk', outcome: 'ok' })
  await c.op({ op: 'node.start', node: 'present' })
  await registerPresentation(c.ws, c.ref, { node: 'present', source: 'out', entry: 'index.html', review: 'review.md', title: 'Old page' }, { by: 'kid-agent', via: 'cli' })
  await c.op({ op: 'node.complete', node: 'present', outcome: 'presented the plan' })
  await c.op({ op: 'node.start', node: 'build' })
  await c.op({ op: 'node.complete', node: 'build', outcome: 'built' })
  const a = await assess(c)
  assert.equal(status(a, 'presentation-missing'), 'missing')
  const facts = a.checks.find(x => x.code === 'presentation-missing')!.facts.join('\n')
  assert.match(facts, /build completed after the latest presentation: an earlier page does not cover later work/)
  assert.match(a.checks.find(x => x.code === 'presentation-missing')!.expectations.join('\n'), /^present r1: /m, 'the frozen expectation beside the evidence')
  // A presentation registered after the work covers it.
  await c.adjust(flow(node('present', 'do', tpl('present')) + node('build', 'do', tpl('work')) + node('show', 'do', tpl('present')), [['talk', 'present'], ['present', 'build'], ['build', 'show']]))
  await c.op({ op: 'node.start', node: 'show' })
  await registerPresentation(c.ws, c.ref, { node: 'show', source: 'out', entry: 'index.html', review: 'review.md', title: 'New page' }, { by: 'kid-agent', via: 'cli' })
  await c.op({ op: 'node.complete', node: 'show', outcome: 'presented' })
  assert.equal(status(await assess(c), 'presentation-missing'), 'ok')
})

test('untemplated substantive work and screenshots/video are covered; a report-only or coordination result raises nothing', async () => {
  const c = await child()
  await c.op({ op: 'node.start', node: 'talk' })
  // As misc/freework/run-002/003: work nodes written by hand, files beyond notes.
  await c.adjust(flow(node('godot-demo', 'do') + node('notes', 'do') + node('relay', 'do'), [['talk', 'godot-demo'], ['godot-demo', 'notes'], ['notes', 'relay']]))
  await c.op({ op: 'node.complete', node: 'talk', outcome: 'ok' })
  for (const [n, artifacts] of [['godot-demo', ['out/index.html']], ['notes', ['out/notes.md']], ['relay', []]] as const) {
    await c.op({ op: 'node.start', node: n })
    await c.op({ op: 'node.complete', node: n, outcome: 'done', artifacts: [...artifacts] })
  }
  const a = await assess(c, { changed: [{ path: 'wedo/trial/shots/a.png', nodes: ['godot-demo'] }, { path: 'wedo/trial/video/spin.mp4', nodes: ['godot-demo'] }] })
  const pm = a.checks.find(x => x.code === 'presentation-missing')!
  assert.equal(pm.status, 'missing')
  assert.match(pm.facts.join('\n'), /completed work: godot-demo \(added by the child, with files\)$/m, 'notes (only .md) and relay (no files) are not work')
  assert.match(pm.facts.join('\n'), /viewable candidates \(by extension, a signal not proof\): wedo\/trial\/shots\/a\.png, wedo\/trial\/video\/spin\.mp4, out\/index\.html/)
  assert.match(pm.summary, /^d1 \(freework\/run-001\) completed godot-demo with .* and presented nothing → wfe delegate revise use\/run-001 d1/)

  // A study's report: a node with only notes, nothing viewable.
  const r = await child()
  await r.op({ op: 'node.start', node: 'talk' })
  await r.adjust(flow(node('survey', 'study'), [['talk', 'survey']]))
  await r.op({ op: 'node.complete', node: 'talk', outcome: 'ok' })
  await r.op({ op: 'node.start', node: 'survey' })
  await r.op({ op: 'node.complete', node: 'survey', outcome: 'surveyed', artifacts: ['out/notes.md'] })
  const b = await assess(r)
  assert.equal(status(b, 'presentation-missing'), 'ok')
  assert.equal(status(b, 'review-unrecorded'), undefined, 'nothing to review: no obligation from accepts alone')
  assert.deepEqual(assessmentReminders([b]), [])
})

test('the child\'s own completion warns for untemplated substantive work (run-002 was never asked)', async () => {
  const c = await child()
  await c.op({ op: 'node.start', node: 'talk' })
  await c.adjust(flow(node('work-2d', 'do'), [['talk', 'work-2d']]))
  await c.op({ op: 'node.complete', node: 'talk', outcome: 'ok' })
  await c.op({ op: 'node.start', node: 'work-2d' })
  await writeFile(join(c.dir, 'out', 'eqtc.cpp'), 'int main(){}')
  const e = await runOp(c.ws, c.ref, { op: 'node.complete', node: 'work-2d', outcome: 'built', artifacts: ['out/eqtc.cpp'] }, { by: 'kid-agent', via: 'cli', advice: {} }).catch(x => x)
  assert.ok(e instanceof RequestError, String(e))
  assert.deepEqual(((e as RequestError).detail as { reminders: { code: string }[] }).reminders.map(r => r.code), ['presentation-missing'])
  assert.match(e.message, /work-2d \(added by this run, with files\) is work this run completed/)
  assert.doesNotMatch(e.message, /records that need no viewing/)
})

test('the person\'s review: a confirm node and an agent\'s answer are unknown; the person\'s own or relayed answer is traceable; accepts: parent needs none', async () => {
  const c = await child()
  await c.op({ op: 'node.start', node: 'talk' })
  await c.adjust(flow(node('build', 'do', tpl('work')) + node('present', 'do', tpl('present')) + node('confirm', 'talk', '    confirms: result\n'), [['talk', 'build'], ['build', 'present'], ['present', 'confirm']]))
  await c.op({ op: 'node.complete', node: 'talk', outcome: 'ok' })
  await c.op({ op: 'node.start', node: 'build' })
  await c.op({ op: 'node.complete', node: 'build', outcome: 'built' })
  await c.op({ op: 'node.start', node: 'present' })
  await registerPresentation(c.ws, c.ref, { node: 'present', source: 'out', entry: 'index.html', review: 'review.md', title: 'Page' }, { by: 'kid-agent', via: 'cli' })
  await c.op({ op: 'presentation.observe', presentation: 'p1', status: 'available', instance: 'pi-test-0001', detail: 'serving' }, 'presenter')
  await c.op({ op: 'node.complete', node: 'present', outcome: 'presented' })
  await c.op({ op: 'node.start', node: 'confirm' })
  await c.op({ op: 'question.ask', question: '', node: 'confirm', text: 'OK?', to: 'par-agent', presentation: 'p1' })
  await c.op({ op: 'question.answer', question: 'q1', text: 'OK, finish', from: 'par-agent' }, 'par-agent')
  await c.op({ op: 'question.take-up', question: 'q1' })
  await c.op({ op: 'run.decide', decision: 'accepted', question: 'q1' })
  await c.op({ op: 'presentation.observe', presentation: 'p1', status: 'stopped', detail: 'process gone' }, 'presenter')
  // run-005: a decision from the requester agent's own answer.
  const a = await assess(c)
  assert.equal(status(a, 'review-unrecorded'), 'unknown')
  assert.match(a.checks.find(x => x.code === 'review-unrecorded')!.facts.join('\n'), /decision accepted by kid-agent from q1 answered by par-agent[\s\S]*no answer from Pat about this result is traceable/)
  const rs = assessmentReminders([a])
  assert.deepEqual(rs.map(r => r.code), ['delegated-review-unrecorded'])
  assert.match(rs[0].text, /Unknown is not a proven omission/)
  assert.ok(!rs[0].repair.some(x => /impersonat|answer for/.test(x)))
  // The parent relayed the person's words to the child (because → Pat).
  // (tidy p3: it answers the child's result-confirmation question, event 2.)
  const confirmQ: DelegationEvent = { ...event(2), type: 'question', question: 'q1', to: 'par-agent', confirms: true, presentation: { id: 'p1', revision: 'sha256:' + 'b'.repeat(64) }, manifest: undefined }
  const relayed = await assess(c, { d: { events: [event(), confirmQ], answers: [{ n: 1, question: 'q1', event: 2, text: 'OK', from: 'Pat', by: 'par-agent', at: '', attempt: null, seq: 5, because: { kind: 'answer', question: 'q3', answer: 0, from: 'Pat' } }] } })
  assert.equal(status(relayed, 'review-unrecorded'), 'ok')
  // tidy p3: a correction — relaying the person's go-ahead, or the agent's own
  // finding — is not their review of the result; nor is relayed words
  // answering a child question that was not about its result.
  const rv = { n: 1, event: 1, manifest: null, childSeq: 9, instruction: 'Fix the test.', reason: 'not collected', by: 'par-agent', at: '', attempt: null, seq: 6 }
  const corrected = await assess(c, { d: { revisions: [{ ...rv, from: 'Pat', because: { kind: 'instruction', instruction: 'i1', from: 'Pat' } }, { ...rv, n: 2, from: 'par-agent', origin: 'agent', evidence: 'ran the tests' }] } })
  assert.equal(status(corrected, 'review-unrecorded'), 'unknown')
  assert.match(corrected.checks.find(x => x.code === 'review-unrecorded')!.facts.join('\n'), /correction 1 \(of event 1\) is Pat's words, relayed by par-agent: a correction is not a review of the result[\s\S]*correction 2 \(of event 1\) is par-agent's own finding \(checked: ran the tests\)/)
  const unrelated = await assess(c, { d: { answers: [{ n: 1, question: 'q9', event: 99, text: 'go ahead', from: 'Pat', by: 'par-agent', at: '', attempt: null, seq: 5, because: { kind: 'instruction', instruction: 'i1', from: 'Pat' } }] } })
  assert.equal(status(unrelated, 'review-unrecorded'), 'unknown')
  assert.match(unrelated.checks.find(x => x.code === 'review-unrecorded')!.facts.join('\n'), /did not ask about its result, so this is not a review of it/)
  // accepts: parent: the parent's agent may accept; nothing to check.
  assert.equal(status(await assess(c, { d: { accepts: 'parent' } }), 'review-unrecorded'), undefined)
  // The person answered the child's question themselves.
  const p = await child()
  await p.op({ op: 'node.start', node: 'talk' })
  await p.adjust(flow(node('build', 'do', tpl('work')) + node('present', 'do', tpl('present')) + node('confirm', 'talk', '    confirms: result\n'), [['talk', 'build'], ['build', 'present'], ['present', 'confirm']]))
  await p.op({ op: 'node.complete', node: 'talk', outcome: 'ok' })
  await p.op({ op: 'node.start', node: 'build' })
  await p.op({ op: 'node.complete', node: 'build', outcome: 'built' })
  await p.op({ op: 'node.start', node: 'present' })
  await registerPresentation(p.ws, p.ref, { node: 'present', source: 'out', entry: 'index.html', review: 'review.md', title: 'Page' }, { by: 'kid-agent', via: 'cli' })
  await p.op({ op: 'presentation.observe', presentation: 'p1', status: 'available', instance: 'pi-test-0003', detail: 'serving' }, 'presenter')
  await p.op({ op: 'node.complete', node: 'present', outcome: 'presented' })
  await p.op({ op: 'node.start', node: 'confirm' })
  await p.op({ op: 'question.ask', question: '', node: 'confirm', text: 'Look?', to: 'Pat', presentation: 'p1' })
  await p.op({ op: 'question.answer', question: 'q1', text: 'Looks right.', from: 'Pat' }, 'Pat')
  assert.equal(status(await assess(p), 'review-unrecorded'), 'ok')
})

test('a page still serving: an answered review with no cleanup is serving; an open review, a request to keep it and a verified stop are not', async () => {
  const c = await child()
  await c.op({ op: 'node.start', node: 'talk' })
  await c.adjust(flow(node('present', 'do', tpl('present')) + node('confirm', 'talk', '    confirms: result\n'), [['talk', 'present'], ['present', 'confirm']]))
  await c.op({ op: 'node.complete', node: 'talk', outcome: 'ok' })
  await c.op({ op: 'node.start', node: 'present' })
  await registerPresentation(c.ws, c.ref, { node: 'present', source: 'out', entry: 'index.html', review: 'review.md', title: 'Page' }, { by: 'kid-agent', via: 'cli' })
  await c.op({ op: 'presentation.observe', presentation: 'p1', status: 'available', instance: 'pi-test-0001', detail: 'serving' }, 'presenter')
  await c.op({ op: 'node.complete', node: 'present', outcome: 'presented' })
  await c.op({ op: 'node.start', node: 'confirm' })
  await c.op({ op: 'question.ask', question: '', node: 'confirm', text: 'Look?', to: 'Pat', presentation: 'p1' })
  let a = await assess(c)
  assert.equal(status(a, 'presentation-serving'), 'ok')
  assert.match(a.checks.find(x => x.code === 'presentation-serving')!.facts.join('\n'), /its review is not answered yet/)
  await c.op({ op: 'question.answer', question: 'q1', text: 'Fine. Keep it up for my team until Friday.', from: 'Pat' }, 'Pat')
  a = await assess(c)
  assert.equal(status(a, 'presentation-serving'), 'serving')
  assert.match(a.checks.find(x => x.code === 'presentation-serving')!.facts.join('\n'), /last answer q1: "Fine\. Keep it up for my team until Friday\." \(Pat\)/, 'the answer shows whether it asks for changes or to keep it')
  assert.ok(a.checks.find(x => x.code === 'presentation-serving')!.repair.some(r => /never stop the child's page from this run/.test(r)))
  // The person's request to keep it, recorded with who stops it.
  await c.op({ op: 'presentation.retain', presentation: 'p1', note: 'until Friday for the team', owner: 'kid-agent', because: { kind: 'answer', question: 'q1' } } as never, 'kid-agent')
  a = await assess(c)
  assert.equal(status(a, 'presentation-serving'), 'ok')
  assert.match(a.checks.find(x => x.code === 'presentation-serving')!.facts.join('\n'), /kept on request \(until Friday for the team; stopped later by kid-agent\)/)
  const { record } = await c.read()
  assert.equal(record.presentations!.p1.retained?.because?.from, 'Pat')
  await c.op({ op: 'presentation.observe', presentation: 'p1', status: 'stopped', detail: 'process gone' }, 'presenter')
  a = await assess(c)
  assert.match(a.checks.find(x => x.code === 'presentation-serving')!.facts.join('\n'), /stopped: p1 \(stopped\)/)
})

// workflow_editor p17: a result handed to the person's human review is a
// deferred review, not an unknown one; its stopped or serving page is the
// review's, not a missing presentation or a forgotten cleanup.
test('a pending human review of the child\'s presentation reads deferred; a decided one is the person\'s review; neither is a reminder', async () => {
  const c = await child()
  await c.op({ op: 'node.start', node: 'talk' })
  await c.adjust(flow(node('show', 'do', tpl('present')), [['talk', 'show']]))
  await c.op({ op: 'node.complete', node: 'talk', outcome: 'ok' })
  await c.op({ op: 'node.start', node: 'show' })
  await registerPresentation(c.ws, c.ref, { node: 'show', source: 'out', entry: 'index.html', review: 'review.md', title: 'Page' }, { by: 'kid-agent', via: 'cli' })
  await c.op({ op: 'presentation.observe', presentation: 'p1', status: 'available', instance: 'pi-test-0001', detail: 'served' } as OpInput, 'wfe')
  await c.op({ op: 'node.complete', node: 'show', outcome: 'presented' })
  const subject = { n: 1, workspace: 'kid', project: 'kid', workflow: 'freework', run: c.ref.run, creation: 'x', presentation: 'p1', revision: `sha256:${'a'.repeat(64)}`, title: 'Page', delegation: 'd1' }
  const round = (state: string, decision: unknown = null) => ({ rv1: { id: 'rv1', uid: 'par/use/run-001#p/rv1', node: 'review', previous: null, prepared: { at: '', by: 'par-agent', attempt: null, seq: 5 }, summary: 's', responsible: 'par-agent', reviewer: 'Pat', subjects: [subject], state, starts: [], serving: [], decision, cleanup: null, continuation: null } })
  const withReviews = (reviews: unknown) => ({ ...parent, project: 'par', reviews }) as unknown as RunRecord
  const { record, bundle } = await c.read()
  const authored = bundle.revisions?.at(-1)?.workflow ?? bundle.entries[record.definition.root]?.workflow
  const ev = { frozen: record, graph: graphOfState(record) ?? null, authored, now: record, catalog: catalogOf(record, bundle), changed: [], unavailable: [] }
  const plain = assessResult(parent, delegation(), event(), ev)
  assert.equal(status(plain, 'review-unrecorded'), 'unknown', 'no review handed over: still unknown')
  assert.equal(status(plain, 'presentation-serving'), 'serving')
  const pending = assessResult(withReviews(round('awaiting')), delegation(), event(), ev)
  assert.equal(status(pending, 'review-unrecorded'), 'deferred')
  assert.match(pending.checks.find(x => x.code === 'review-unrecorded')!.facts.join('\n'), /handed to Pat's human review rv1 \(Awaiting human review\): their review is pending, not missing/)
  assert.equal(status(pending, 'presentation-serving'), 'ok')
  assert.match(pending.checks.find(x => x.code === 'presentation-serving')!.facts.join('\n'), /p1 serving now for human review rv1/)
  assert.deepEqual(assessmentReminders([pending]), [])
  const decided = assessResult(withReviews(round('complete', { outcome: 'approved', by: 'Pat', at: '', via: 'browser', seq: 9, feedback: '', subjects: [] })), delegation(), event(), ev)
  assert.equal(status(decided, 'review-unrecorded'), 'ok')
  assert.match(decided.checks.find(x => x.code === 'review-unrecorded')!.facts.join('\n'), /human review rv1: approved by Pat$/m)
  const synthetic = assessResult(withReviews(round('complete', { outcome: 'approved', by: 'check', at: '', via: 'cli', seq: 9, feedback: '', subjects: [], synthetic: true })), delegation(), event(), ev)
  assert.match(synthetic.checks.find(x => x.code === 'review-unrecorded')!.facts.join('\n'), /a synthetic check actor, not the person/)
})

test('a documentation step completed without its document is missing; with it, ok (tidy p1)', async () => {
  const c = await child(flow('', []).replace('edges:\n\n', 'edges: []\n').replace('documentation: {policy: manual}', 'documentation: {policy: custom, plan: false, reports: false, final: true}'))
  await c.op({ op: 'node.start', node: 'talk' })
  await c.op({ op: 'node.complete', node: 'talk', outcome: 'tidied' })
  await c.op({ op: 'node.start', node: '_final-report' })
  await c.op({ op: 'node.complete', node: '_final-report', outcome: 'Report written' })
  const a = await assess(c)
  assert.equal(status(a, 'document-missing'), 'missing')
  assert.match(a.checks.find(x => x.code === 'document-missing')!.summary, /_final-report with no devdocs\/runs\/freework\/run-001\/report\.md → wfe delegate revise/)
  assert.ok(assessmentReminders([a]).some(r => r.code === 'delegated-document-missing'))
  // A child that wrote it.
  const d = await child(flow('', []).replace('edges:\n\n', 'edges: []\n').replace('documentation: {policy: manual}', 'documentation: {policy: custom, plan: false, reports: false, final: true}'))
  await d.op({ op: 'node.start', node: 'talk' })
  await d.op({ op: 'node.complete', node: 'talk', outcome: 'tidied' })
  await d.op({ op: 'node.start', node: '_final-report' })
  await writeFile(join(d.dir, 'devdocs', 'runs', 'freework', 'run-001', 'report.md'), '# Report\n')
  await d.op({ op: 'node.complete', node: '_final-report', outcome: 'Report written' })
  assert.equal(status(await assess(d), 'document-missing'), 'ok')
})

// ---- tidy p2: the claim beside the evidence, and what WFE cannot judge ----

test('the assessment puts findings first, the claim beside the records, and asks to inspect what fits the child\'s changes (tidy p2)', async () => {
  const c = await child(flow('', []).replace('edges:\n\n', 'edges: []\n').replace('documentation: {policy: manual}', 'documentation: {policy: custom, plan: false, reports: false, final: true}'))
  await c.op({ op: 'node.start', node: 'talk' })
  await c.op({ op: 'node.complete', node: 'talk', outcome: 'tidied' })
  await c.op({ op: 'node.start', node: '_final-report' })
  await c.op({ op: 'node.complete', node: '_final-report', outcome: 'Report written' })
  const ev = { ...event(), manifest: { ...event().manifest!, outcome: 'README rewritten; the audit record is in report.md' } }
  const { record, bundle } = await c.read()
  const authored = bundle.revisions?.at(-1)?.workflow ?? bundle.entries[record.definition.root]?.workflow
  const a = assessResult(parent, delegation(), ev, { frozen: record, graph: graphOfState(record) ?? null, authored, now: record, catalog: catalogOf(record, bundle), changed: [{ path: 'README.md', nodes: ['talk'] }, { path: 'sheet-review.md', nodes: ['talk'] }], removed: ['sheet-review.md'], reportRefs: null, unavailable: [] })
  const lines = assessmentLines(a)
  const at = (re: RegExp) => lines.findIndex(l => re.test(l))
  assert.match(lines[1], /FINDINGS \(1\): MISSING document-missing, from the records; listed first below/)
  assert.ok(at(/MISSING document-missing/) < at(/ok presentation-missing/), 'the finding before the checks that passed')
  assert.match(lines.join('\n'), /claim — outcome: "README rewritten; the audit record is in report\.md"/)
  assert.match(lines.join('\n'), /claim — report: none recorded with the result/)
  assert.match(lines.join('\n'), /records — changed outside its run folder \(1\): README\.md/)
  assert.match(lines.join('\n'), /records — removed: sheet-review\.md/)
  assert.match(lines.join('\n'), /records — published outputs: none/)
  assert.match(lines.join('\n'), /to judge: WFE checked records, not content\. Compare the claim with the files before judging \(wfe delegate file use\/run-001 d1 <path>\)/)
  assert.match(lines.join('\n'), /· Documentation: .*one machine's facts \(hosts, home paths, LAN addresses\) out of portable text/)
  assert.match(lines.join('\n'), /· Removals and moves: /)
  assert.doesNotMatch(lines.join('\n'), /Tests: |Delivery: /, 'only what fits the changes')
  assert.match(lines.join('\n'), /a path chooses a question, it shows no defect/)

  // A small unrelated change: no finding, the general questions only.
  const plain = await child()
  const pr = await plain.read()
  const small = assessResult(parent, delegation(), event(), { frozen: pr.record, graph: graphOfState(pr.record) ?? null, authored: pr.bundle.entries[pr.record.definition.root]?.workflow, now: pr.record, catalog: catalogOf(pr.record, pr.bundle), changed: [{ path: 'src/main.py', nodes: [] }], unavailable: [] })
  const sl = assessmentLines(small).join('\n')
  assert.match(sl, /findings: none in what WFE checks .*; the content is not checked/)
  assert.doesNotMatch(sl, /Documentation: |Tests: |Delivery: |Removals and moves: |chosen from/)
  assert.match(sl, /What is missing goes back to the same child/)
  assert.deepEqual(assessmentReminders([small]), [], 'the questions are advice: no reminder')
})

test('a corrected result says which correction it answers; the result that was returned does not (tidy p2)', async () => {
  const c = await child()
  const { record, bundle } = await c.read()
  const rv = { n: 1, event: 1, manifest: null, childSeq: 9, instruction: 'Write the report in the run folder.', reason: 'report.md does not exist', from: 'Pat', by: 'par-agent', at: '2026-10-24T00:01:00.000Z', attempt: null, seq: 5 }
  const d = delegation({ events: [event(1), { ...event(2), at: '2026-10-24T00:02:00.000Z' }], revisions: [rv] })
  const ev = () => ({ frozen: record, graph: null, authored: undefined, now: record, catalog: catalogOf(record, bundle), changed: [], unavailable: [] }) as ChildEvidence
  const second = assessResult(parent, d, d.events[1], ev())
  assert.match(second.correction ?? '', /^This result follows correction request 1 \(it returned event 1\): "Write the report in the run folder\."\. Any check of event 1 does not cover it: check the correction itself\.$/)
  assert.match(assessmentLines(second).join('\n'), /This result follows correction request 1/)
  assert.equal(assessResult(parent, d, d.events[0], ev()).correction, null)
})

test('report paths: names with a folder are looked up in the child\'s copy and its run folder; URLs, shares, patterns and bare names are not (tidy p2)', async () => {
  const c = await child()
  const { record } = await c.read()
  const { namedPaths } = await import('../server/delegate.ts')
  await mkdir(join(c.dir, 'devdocs', 'runs', 'freework', 'run-001', 'notes'), { recursive: true })
  await writeFile(join(c.dir, 'devdocs', 'runs', 'freework', 'run-001', 'notes', 'a.md'), 'a\n')
  await writeFile(join(c.dir, 'devdocs', 'runs', 'freework', 'run-001', 'report.md'), [
    'Moved `out/index.html` and wrote `notes/a.md`; see `docs/missing.md:12` and `tools/gone.py`.',
    'Not paths: `report.md`, `__pycache__/`, `runs/run-001..003/report.md`, `https://x.invalid/a/b`, `shared://agshare/runs/x`, `src/*.ts`, `<run>/report.md`, `/abs/path`, `~/home/x`.',
  ].join('\n'))
  const r = await namedPaths(c.dir, record, 'devdocs/runs/freework/run-001/report.md')
  assert.deepEqual(r, { named: 4, missing: ['docs/missing.md', 'tools/gone.py'] })
})

test('the producer is advised once, as only reporting is left, and not when the run completes or work remains (tidy p2)', async () => {
  const { producerAdvice } = await import('../server/resultEvidence.ts')
  const c = await child()
  await c.op({ op: 'node.start', node: 'talk' })
  await c.adjust(flow(node('build', 'do', tpl('work')) + node('more', 'do') + node('present', 'do', tpl('present')), [['talk', 'build'], ['build', 'more'], ['more', 'present']]))
  await c.op({ op: 'node.complete', node: 'talk', outcome: 'ok' })
  await c.op({ op: 'node.start', node: 'build' })
  await c.op({ op: 'node.complete', node: 'build', outcome: 'built' })
  assert.equal(await producerAdvice(c.ws, c.ref, { completed: 'build' }), null, 'work remains')
  await c.op({ op: 'node.start', node: 'more' })
  await c.op({ op: 'node.complete', node: 'more', outcome: 'done' })
  const advice = (await producerAdvice(c.ws, c.ref, { completed: 'more' }))!.join('\n')
  assert.match(advice, /^Before the result goes back \(advice; nothing is refused\): par-agent compares what you report with your files and records\./)
  assert.match(advice, /Do the project's entry \(README\), guide and setup or acquisition instructions still match this change\?/)
  assert.doesNotMatch(advice, /chosen from/, 'nothing chose a specific question')
  await c.op({ op: 'node.start', node: 'present' })
  assert.equal(await producerAdvice(c.ws, c.ref, { completed: 'present' }), null, 'a reporting node itself is not the boundary')
  assert.equal(await producerAdvice(c.ws, c.ref, { started: 'present' }), null)

  // With a final-report step: advised when it starts, not at the completion before it.
  const f = await child(flow('', []).replace('edges:\n\n', 'edges: []\n').replace('documentation: {policy: manual}', 'documentation: {policy: custom, plan: false, reports: false, final: true}'))
  await f.op({ op: 'node.start', node: 'talk' })
  await f.op({ op: 'node.complete', node: 'talk', outcome: 'ok' })
  assert.equal(await producerAdvice(f.ws, f.ref, { completed: 'talk' }), null)
  await f.op({ op: 'node.start', node: '_final-report' })
  assert.match((await producerAdvice(f.ws, f.ref, { started: '_final-report' }))!.join('\n'), /The report \(devdocs\/runs\/freework\/run-001\/report\.md\) and every path it names are read where you say they are\./)
  await writeFile(join(f.dir, 'devdocs', 'runs', 'freework', 'run-001', 'report.md'), '# Report\n')
  await f.op({ op: 'node.complete', node: '_final-report', outcome: 'Report written' })
  assert.equal(await producerAdvice(f.ws, f.ref, { completed: '_final-report' }), null, 'a completed run is past it')
})
