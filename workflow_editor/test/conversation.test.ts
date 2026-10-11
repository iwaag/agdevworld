// p6 step 6: a run requested in a Zulip request topic talks with the person
// there and reports progress in its run topic — two destinations of the one
// durable notifier, with distinct delivery identities, linked to each other;
// answers bind to the posted question; the result confirmation becomes the
// result decision; replies about posts that changed nothing are told.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InboundMessage } from '../shared/intake.ts'
import { createProject } from '../server/create.ts'
import { ExecStore } from '../server/exec.ts'
import { gitOk } from '../server/git.ts'
import { IntakeStore } from '../server/intake.ts'
import { NotifyStore, type Delivery } from '../server/notify.ts'
import { loadRegistry } from '../server/registry.ts'
import { readRun, runOp } from '../server/runs.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import type { OpInput, RunRef } from '../shared/run.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-conv-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const REALM = 'chat.example:8543'
const STREAM = 601, PERSON = 8
const WF = `schema: ag.workflow.v2
id: make
name: Make
intent: |
  Make a deck and have the person confirm it.
documentation: {policy: default}
execution: {agent: maker}
intake: {zulip: requests}
repositories:
  root: {path: ., access: editable}
nodes:
  build:
    type: do
    description: Build it.
  present:
    type: talk
    confirms: result
    description: Present it.
edges:
  - {from: build, to: present}
`

let k = 0
async function setup() {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-p')
  const r = await createProject({ dir, id: 'p', name: 'P', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'make.yaml'), WF)
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  await writeFile(join(area, 'zulip.json'), JSON.stringify({
    enabled: true, zulipUrl: `https://${REALM}`, viewBase: null, since: '2026-01-01T00:00:00.000Z', person: 'Pat',
    intake: { enabled: true, since: '2026-01-01T00:00:00.000Z', projects: { p: {} }, requesters: [{ id: PERSON, name: 'Pat' }] },
  }))
  const x = new ExecStore({ registryFile: registry, area })
  const n = new NotifyStore({ area, registryFile: registry, exec: x })
  const i = new IntakeStore({ area, registryFile: registry, exec: x, notify: n, posted: n.postedLookup() })
  n.intake = i
  await n.due()
  n.recordTarget('channel:p/make', { zulipId: STREAM })
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  return { area, dir, x, n, i, ws }
}

// The transport, simulated: claims, begins and acknowledges every delivery
// with increasing Zulip ids, as the real one does after a successful POST.
// Zulip message ids are one increasing sequence for every sender.
let nextMessage = 50_000
interface Posted { id: number; streamId: number; topic: string; content: string; delivery: Delivery }
async function deliver(n: NotifyStore, posted: Posted[], o: { lose?: (d: Delivery) => boolean } = {}) {
  for (let round = 0; round < 10; round++) {
    const c = await n.claim({ owner: 'test', pid: process.pid })
    if (!c.deliveries.length) return
    for (const d of c.deliveries) {
      n.begin(d.delivery, d.claim, { destination: d.destination, events: d.events, checkedAbsent: d.reconcile ? 'searched in the test' : undefined })
      const id = ++nextMessage
      posted.push({ id, streamId: d.destination.streamId, topic: d.destination.topic, content: d.content, delivery: d })
      if (o.lose?.(d)) { n.fail(d.delivery, d.claim, 'answer lost', true, { events: d.events }); continue }
      n.acknowledge(d.delivery, d.claim, { messageId: id, destination: d.destination, events: d.events })
    }
  }
}
const post = (topicFirst: number | null, content: string, id = ++nextMessage): InboundMessage => ({
  realm: REALM, id, streamId: STREAM, topic: 'request-deck', sender: { id: PERSON, name: 'Pat Person', email: 'p@x', bot: false }, content, timestamp: 1_790_000_000, topicFirst: topicFirst ?? id,
})
const receive = (i: IntakeStore, m: InboundMessage) => i.receive({ realm: REALM, streamId: STREAM, through: m.id, messages: [JSON.parse(JSON.stringify(m))] })
const agent = (ws: Workspace, ref: RunRef, op: OpInput, attempt?: string) => runOp(ws, ref, { ...op, ...(attempt ? { attempt } : {}) }, { by: 'maker', via: 'cli' })
const code = (e: unknown) => ((e as RequestError).detail as { code?: string } | undefined)?.code

test('request topic and run topic: what goes where, linked, with distinct identities; answers and the confirmation flow through Zulip', async () => {
  const { x, n, i, ws, dir } = await setup()
  const posted: Posted[] = []
  const origin = post(null, 'Make a three-slide deck about tea.')
  receive(i, origin)
  await i.process()
  const ref = { workflow: 'make', run: 'run-001' }
  const folder = join(dir, 'devdocs/runs/make/run-001')
  await deliver(n, posted)
  const inRequest = () => posted.filter(p => p.topic === 'request-deck')
  const inRun = () => posted.filter(p => p.topic === 'run-001')
  assert.equal(inRequest().length, 1)
  assert.match(inRequest()[0].content, /^\*\*Request received\*\* — maker performs it as run make\/run-001\./)
  assert.match(inRequest()[0].content, /Progress: https:\/\/chat\.example:8543\/#narrow\/channel\/601-.*\/topic\/run-001/, 'linked to the run topic')
  assert.match(inRequest()[0].content, /ref make\/run-001 #1:accepted@request$/)
  // The executor begins and plans.
  const c1 = await x.claim('test', {})
  assert.ok('attempt' in c1)
  const A1 = c1.attempt.id
  await agent(ws, ref, { op: 'node.start', node: '_plan' }, A1)
  await writeFile(join(folder, 'plan.md'), '# Plan\n\nThree slides.\n')
  await agent(ws, ref, { op: 'question.ask', question: 'q1', node: '_plan', text: 'Agree to the plan?', to: 'Pat' }, A1)
  await x.finished(A1, { code: 0, signal: null })
  await deliver(n, posted)
  const started = inRun().find(p => /\*\*Started\*\*/.test(p.content))!
  assert.ok(started, 'progress goes to the run topic')
  assert.match(started.content, /Request and conversation: https:\/\/chat\.example:8543\/#narrow\/channel\/601-.*\/topic\/request-deck/, 'linked back to the request topic')
  const q1 = inRequest().find(p => /\*\*Question for Pat\*\* — agree to the plan \(q1\)/.test(p.content))!
  assert.ok(q1, 'the question is asked in the request topic')
  assert.match(q1.content, /Answer: reply in this topic — quote this message, or start your reply with `q1:`/)
  assert.ok(!inRun().some(p => /Question for/.test(p.content)), 'not in the run topic')
  // The person answers in Zulip, after the question was posted.
  const yes = post(origin.id, 'Yes, go ahead.')
  receive(i, yes)
  await i.process()
  let rec = (await readRun(ws, ref)).record!
  assert.equal(rec.questions.q1.answers[0].source?.message, yes.id, 'bound to q1 through its post')
  assert.equal(x.runView(ws.reg.id, ref).jobs.filter(j => j.kind === 'resume').length, 1, 'the existing resume')
  await deliver(n, posted)
  assert.ok(inRequest().some(p => /\*\*Recorded\*\* as your answer to q1\. maker reads it when it resumes \(recorded, not yet read\)/.test(p.content)))
  // Attempt 2: work, then present the deliverables for confirmation.
  const c2 = await x.claim('test', {})
  assert.ok('attempt' in c2)
  const A2 = c2.attempt.id
  await agent(ws, ref, { op: 'question.take-up', question: 'q1' }, A2)
  await agent(ws, ref, { op: 'node.complete', node: '_plan', outcome: 'agreed' }, A2)
  await agent(ws, ref, { op: 'node.start', node: 'build' }, A2)
  await mkdir(join(folder, 'deck'), { recursive: true })
  await writeFile(join(folder, 'deck', 'tea.pptx'), Buffer.from('PK\x03\x04 not really a pptx'))
  await writeFile(join(folder, 'deck', 'preview.pdf'), '%PDF-1.4 preview')
  await agent(ws, ref, { op: 'node.complete', node: 'build', outcome: 'built' }, A2)
  await agent(ws, ref, { op: 'node.start', node: '_report.build' }, A2)
  await writeFile(join(folder, 'report-build.md'), '# build\n')
  await agent(ws, ref, { op: 'node.complete', node: '_report.build', outcome: 'Built tea.pptx. Next: present it.' }, A2)
  await agent(ws, ref, { op: 'node.start', node: 'present' }, A2)
  await assert.rejects(agent(ws, ref, { op: 'question.ask', question: 'q2', node: 'present', text: 'Confirm?', to: 'Pat' }, A2), (e: unknown) => code(e) === 'subject-missing', 'the confirmation names its deliverables')
  await agent(ws, ref, { op: 'question.ask', question: 'q2', node: 'present', text: 'Is the deck right, or what should change?', to: 'Pat', subjects: ['devdocs/runs/make/run-001/deck/tea.pptx', 'devdocs/runs/make/run-001/deck/preview.pdf'] }, A2)
  await x.finished(A2, { code: 0, signal: null })
  await deliver(n, posted)
  const q2 = inRequest().find(p => /confirm the result \(q2\)/.test(p.content))!
  assert.ok(q2)
  assert.match(q2.content, /Deliverables: tea\.pptx .*, preview\.pdf /)
  assert.ok(inRun().some(p => /\*\*Report — build:\*\*/.test(p.content)), 'reports in the run topic')
  // A reply that names a closed question is told it is late, and applied nowhere.
  const late = post(origin.id, 'q1: actually four slides')
  receive(i, late)
  await i.process()
  await deliver(n, posted)
  const lateReply = inRequest().find(p => /Too late for q1/.test(p.content))!
  assert.ok(lateReply)
  assert.match(lateReply.content, new RegExp(`/near/${late.id}`))
  assert.match(lateReply.content, new RegExp(`ref make/run-001 #z${late.id}:late$`))
  rec = (await readRun(ws, ref)).record!
  assert.equal(rec.questions.q1.answers.length, 1)
  assert.equal(rec.questions.q2.answers.length, 0, 'not moved to the open q2 either')
  // The person confirms; the agent records the decision their answer is.
  const ok = post(origin.id, 'Looks good, thanks!')
  receive(i, ok)
  await i.process()
  const c3 = await x.claim('test', {})
  assert.ok('attempt' in c3)
  const A3 = c3.attempt.id
  await agent(ws, ref, { op: 'question.take-up', question: 'q2' }, A3)
  await assert.rejects(agent(ws, ref, { op: 'run.decide', decision: 'accepted', question: 'q1' }, A3), (e: unknown) => code(e) === 'not-result-confirmation' && /plan agreement is not acceptance/.test((e as Error).message))
  await agent(ws, ref, { op: 'run.decide', decision: 'accepted', question: 'q2' }, A3)
  rec = (await readRun(ws, ref)).record!
  assert.equal(rec.execution.state, 'in-progress', 'the decision precedes completion; they are separate')
  const d = rec.decisions[0]
  assert.equal(d.decision, 'accepted')
  assert.equal(d.by, 'maker')
  assert.deepEqual([d.confirmation?.question, d.confirmation?.answer, d.confirmation?.from, d.confirmation?.source?.message], ['q2', 0, 'Pat', ok.id])
  assert.deepEqual(d.confirmation?.subject.map(s => s.path), ['devdocs/runs/make/run-001/deck/tea.pptx', 'devdocs/runs/make/run-001/deck/preview.pdf'])
  await assert.rejects(agent(ws, ref, { op: 'run.decide', decision: 'accepted', question: 'q2' }, A3), (e: unknown) => code(e) === 'decision-exists', 'no duplicate approval')
  await agent(ws, ref, { op: 'node.complete', node: 'present', outcome: 'confirmed' }, A3)
  await agent(ws, ref, { op: 'node.start', node: '_report.present' }, A3)
  await writeFile(join(folder, 'report-present.md'), '# present\n')
  await agent(ws, ref, { op: 'node.complete', node: '_report.present', outcome: 'Confirmed by Pat.' }, A3)
  await agent(ws, ref, { op: 'node.start', node: '_final-report' }, A3)
  await writeFile(join(folder, 'report.md'), '# report\n')
  await agent(ws, ref, { op: 'node.complete', node: '_final-report', outcome: 'Delivered tea.pptx.' }, A3)
  await x.finished(A3, { code: 0, signal: null })
  await deliver(n, posted)
  const decidedReq = inRequest().find(p => /\*\*Result accepted\*\* — Pat's answer to q2, recorded by maker\./.test(p.content))!
  assert.ok(decidedReq)
  assert.match(decidedReq.content, /Confirmed: tea\.pptx/)
  const doneReq = inRequest().find(p => /\*\*Execution completed\*\*/.test(p.content))!
  assert.match(doneReq.content, /Result accepted by Pat's answer to q2 \(a separate record from this completion\)\./)
  assert.match(doneReq.content, /a new request needs a new request topic/)
  const doneRun = inRun().find(p => /\*\*Execution completed\*\*/.test(p.content))!
  assert.ok(doneRun, 'completion in both topics')
  // One event, two messages: distinct identities and markers per destination.
  const doneIds = [doneReq, doneRun].map(p => p.delivery.events.join(' '))
  assert.notEqual(doneIds[0], doneIds[1])
  assert.ok(doneIds[0].endsWith('@request') && !doneIds[1].endsWith('@request'))
  assert.notEqual(doneReq.content.split('\n').at(-1), doneRun.content.split('\n').at(-1))
  // After completion: kept, told, not applied.
  const more = post(origin.id, 'Can you add a fourth slide?')
  receive(i, more)
  await i.process()
  await deliver(n, posted)
  assert.ok(inRequest().some(p => /\*\*This request is complete\*\* \(run make\/run-001\)/.test(p.content)))
  assert.equal(Object.keys((await readRun(ws, ref)).record!.instructions ?? {}).length, 0)
  // The run's coordination status names both topics.
  const st = n.runStatus('p', ref)
  assert.equal(st.request?.topic, 'request-deck')
  assert.equal(st.topic?.topic, 'run-001')
})

test('a confirmation is of the presented files: changed deliverables need presenting again; ambiguity is asked about', async () => {
  const { x, n, i, ws, dir } = await setup()
  const posted: Posted[] = []
  const origin = post(null, 'Make a deck.')
  receive(i, origin)
  await i.process()
  const ref = { workflow: 'make', run: 'run-001' }
  const folder = join(dir, 'devdocs/runs/make/run-001')
  const c = await x.claim('test', {})
  assert.ok('attempt' in c)
  const A = c.attempt.id
  // Fast-forward to present, by the same operations.
  await agent(ws, ref, { op: 'node.start', node: '_plan' }, A)
  await writeFile(join(folder, 'plan.md'), '# Plan\n')
  await agent(ws, ref, { op: 'question.ask', question: 'q1', node: '_plan', text: 'ok?', to: 'Pat' }, A)
  await runOp(ws, ref, { op: 'question.answer', question: 'q1', text: 'ok' }, { by: 'Pat', via: 'browser' })
  await agent(ws, ref, { op: 'question.take-up', question: 'q1' }, A)
  await agent(ws, ref, { op: 'node.complete', node: '_plan', outcome: 'agreed' }, A)
  await agent(ws, ref, { op: 'node.start', node: 'build' }, A)
  await writeFile(join(folder, 'deck.pptx'), 'v1')
  await agent(ws, ref, { op: 'node.complete', node: 'build', outcome: 'built' }, A)
  await agent(ws, ref, { op: 'node.start', node: '_report.build' }, A)
  await writeFile(join(folder, 'report-build.md'), '# b\n')
  await agent(ws, ref, { op: 'node.complete', node: '_report.build', outcome: 'b' }, A)
  await agent(ws, ref, { op: 'node.start', node: 'present' }, A)
  await agent(ws, ref, { op: 'question.ask', question: 'q2', node: 'present', text: 'Confirm deck.pptx?', to: 'Pat', subjects: ['devdocs/runs/make/run-001/deck.pptx'] }, A)
  await assert.rejects(agent(ws, ref, { op: 'run.decide', decision: 'accepted', question: 'q2' }, A), (e: unknown) => code(e) === 'no-answer', 'nothing to decide from before an answer is taken up')
  await x.finished(A, { code: 0, signal: null })
  await deliver(n, posted)
  // Two questions open at once (q2 and a node-less q3): a bare reply is ambiguous.
  const c2 = await x.claim('test', {})
  if ('attempt' in c2) await x.finished(c2.attempt.id, { code: 0, signal: null })
  await runOp(ws, ref, { op: 'question.ask', question: 'q3', text: 'Also: which font?', to: 'Pat' }, { by: 'maker', via: 'cli' })
  await deliver(n, posted)
  const bare = post(origin.id, 'yes')
  receive(i, bare)
  await i.process()
  assert.deepEqual(JSON.parse(i.message(REALM, bare.id)!.classification!), { kind: 'clarify', reason: 'ambiguous', questions: ['q2', 'q3'] })
  await deliver(n, posted)
  assert.ok(posted.some(p => /\*\*Which question\?\*\* Your \[post\]\(.*\) could answer q2 or q3; nothing was recorded\. Reply again quoting the question, or start with `q2:`\./.test(p.content)))
  // Explicit: q2 confirmed; but the deck changed after it was presented.
  const yes = post(origin.id, 'q2: yes')
  receive(i, yes)
  await i.process()
  const c3 = await x.claim('test', {})
  assert.ok('attempt' in c3)
  await agent(ws, ref, { op: 'question.take-up', question: 'q2' }, c3.attempt.id)
  await writeFile(join(folder, 'deck.pptx'), 'v2 — changed after it was presented')
  await assert.rejects(agent(ws, ref, { op: 'run.decide', decision: 'accepted', question: 'q2' }, c3.attempt.id), (e: unknown) => code(e) === 'subject-changed' && /deck\.pptx changed since q2 presented it/.test((e as Error).message))
  assert.equal((await readRun(ws, ref)).record!.decisions.length, 0)
})

test('an answer arriving before the asking attempt exits resumes through the existing lifecycle', async () => {
  const { x, n, i, ws, dir } = await setup()
  const posted: Posted[] = []
  const origin = post(null, 'Make a deck.')
  receive(i, origin)
  await i.process()
  const ref = { workflow: 'make', run: 'run-001' }
  const c = await x.claim('test', {})
  assert.ok('attempt' in c)
  const A = c.attempt.id
  await agent(ws, ref, { op: 'node.start', node: '_plan' }, A)
  await writeFile(join(dir, 'devdocs/runs/make/run-001/plan.md'), '# Plan\n')
  await agent(ws, ref, { op: 'question.ask', question: 'q1', node: '_plan', text: 'Agree?', to: 'Pat' }, A)
  // Delivered while the attempt is still open (the plan link waits at most
  // briefly; make it due now), and answered before the process ends.
  n.db.prepare('UPDATE outbox SET created = \'2000-01-01T00:00:00.000Z\'').run()
  await deliver(n, posted, {})
  const q1 = posted.find(p => /\(q1\)/.test(p.content))
  if (!q1) {
    // The question waits for publication while the attempt is open: answer
    // after it is posted, whenever that is — here, after the 90 s bound.
    const outbox = n.outbox().find(o => o.type === 'question')!
    const ev = JSON.parse(outbox.event); ev.at = '2000-01-01T00:00:00.000Z'
    n.db.prepare('UPDATE outbox SET event = ? WHERE id = ?').run(JSON.stringify(ev), outbox.id)
    await deliver(n, posted, {})
  }
  assert.ok(posted.some(p => /\(q1\)/.test(p.content)), 'the question is posted while the attempt is open')
  assert.ok(x.attemptRow(A)!.state !== 'ended')
  const yes = post(origin.id, 'Yes.')
  receive(i, yes)
  await i.process()
  assert.equal((await readRun(ws, ref)).record!.questions.q1.answers.length, 1, 'recorded at once')
  assert.equal(x.runView(ws.reg.id, ref).jobs.filter(j => j.kind === 'resume').length, 0, 'no resume while the asking attempt is open')
  const f = await x.finished(A, { code: 0, signal: null })
  assert.equal(f.outcome, 'exited')
  assert.ok(f.resumeJob, 'its end queues the resumption')
  assert.equal(x.runView(ws.reg.id, ref).jobs.filter(j => j.kind === 'resume').length, 1)
  const c2 = await x.claim('test', {})
  assert.ok('attempt' in c2)
  assert.match(c2.brief, /resume: answer 0 to q1 recorded/)
})

test('an uncertain send is reconciled where it was sent: request and run topics are searched separately', async () => {
  const { n, i } = await setup()
  const posted: Posted[] = []
  receive(i, post(null, 'Make a deck.'))
  await i.process()
  await deliver(n, posted, { lose: d => d.destination.topic === 'request-deck' })
  const c = await n.claim({ owner: 'test', pid: process.pid })
  const again = c.deliveries.find(d => d.destination.topic === 'request-deck')
  // The failed delivery waits for its backoff; make it due.
  if (!again) {
    n.db.prepare('UPDATE deliveries SET next_try = NULL WHERE state = \'failed\'').run()
    const c2 = await n.claim({ owner: 'test', pid: process.pid })
    const d = c2.deliveries.find(x => x.destination.topic === 'request-deck')!
    assert.ok(d.reconcile, 'it may have been posted: looked for first')
    assert.deepEqual(d.reconcile.searchIn.map(p => p.topic), ['request-deck'], 'only where it was sent')
    assert.ok(d.events.every(e => e.endsWith('@request')))
  } else assert.ok(again.reconcile)
})
