// workflow_editor fix5: reminders at operation boundaries — evaluated in the
// operation, under its lock, before anything is recorded; --yes continues
// past them and nothing else; WFE's own records are never evaluated.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../server/create.ts'
import { createTemplate } from '../server/catalog.ts'
import { gitOk } from '../server/git.ts'
import { loadRegistry } from '../server/registry.ts'
import { adjustRun, createRun, readRun, registerPresentation, runOp, type AdjustOptions } from '../server/runs.ts'
import type { Advice } from '../server/reminders.ts'
import { pendingAnswerLines } from '../server/continuation.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import type { OpInput } from '../shared/run.ts'
import { main } from '../cli/wfe.ts'

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wfe-reminders-'))
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
const flow = (nodes: string, edges: [string, string][]) => `${HEAD}${nodes}edges:\n${edges.length ? edges.map(([a, b]) => `  - {from: ${a}, to: ${b}}`).join('\n') : '  []'}\n`.replace('edges:\n  []', 'edges: []')

let k = 0
async function setup() {
  const area = join(root, `area-${++k}`)
  const registry = join(area, 'registry.json')
  const dir = join(area, 'pj-p')
  const r = await createProject({ dir, id: 'p', name: 'P', intent: 'x', goals: [], devdocs: 'directory', sourcesDir: join(area, 'sources'), registryFile: registry })
  assert.ok(r.ok, r.message)
  await writeFile(join(dir, 'devdocs', 'workflows', 'freework.yaml'), flow('', []))
  await mkdir(join(dir, 'out'), { recursive: true })
  await writeFile(join(dir, 'out', 'index.html'), '<p>result</p>')
  await writeFile(join(dir, 'review.md'), '# Review\n\nLook at it.\n')
  await gitOk(dir, ['add', '-A']); await gitOk(dir, ['commit', '-q', '-m', 'workflow'])
  await createTemplate(area, 'work', { name: 'Work', type: 'do', description: 'Do one piece of the work.', expectation: 'The work on its own nodes.' }, 'Pat')
  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  const created = await createRun(ws, { workflow: 'freework', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'try it', author: 'Pat' }, area })
  return { ws, ref: created.ref, dir, area, registry, folder: join(dir, 'devdocs', 'runs', 'freework', created.ref.run) }
}
type S = Awaited<ReturnType<typeof setup>>
const ADVISE: Advice = {}
const op = (s: S, o: OpInput, advice?: Advice, by = 'autolab') => runOp(s.ws, s.ref, o, { by, via: 'cli', ...(advice ? { advice } : {}) })
const rec = async (s: S) => { const r = await readRun(s.ws, s.ref); assert.ok(r.record, r.problem?.message); return r.record! }
const adjust = (s: S, text: string, o: Partial<AdjustOptions> = {}, advice?: Advice) => adjustRun(s.ws, s.ref, { text, reason: o.reason ?? 'test', source: { kind: 'agent' }, ...o }, { by: 'autolab', via: 'cli', ...(advice ? { advice } : {}) })
const reminded = async (p: Promise<unknown>): Promise<{ codes: string[]; message: string }> => {
  try { await p } catch (e) {
    assert.ok(e instanceof RequestError, String(e))
    const d = e.detail as { code: string; reminders: { code: string }[] }
    assert.equal(d.code, 'reminder', e.message)
    return { codes: d.reminders.map(r => r.code), message: e.message }
  }
  return assert.fail('no reminder')
}
// talk → build (a work node), as freework/run-010 did.
const WORK = flow(node('build', 'do', tpl('work')), [['talk', 'build']])

test('completing the last work with nothing presented or planned is refused before anything is recorded; repair or --yes continues', async () => {
  const s = await setup()
  await op(s, { op: 'node.start', node: 'talk' })
  await adjust(s, WORK)
  await op(s, { op: 'node.complete', node: 'talk', outcome: 'plan: build it' }, ADVISE)
  await op(s, { op: 'node.start', node: 'build' })
  const seq = (await rec(s)).seq
  const r = await reminded(op(s, { op: 'node.complete', node: 'build', outcome: 'built' }, ADVISE))
  assert.deepEqual(r.codes, ['presentation-missing'])
  assert.match(r.message, /build is work this run completed and the run has no presentation/)
  assert.match(r.message, /wfe nodes instantiate present --run freework\/run-001 --file <draft> --after build/)
  assert.match(r.message, /Nothing was recorded, posted or queued.*--yes/s)
  const now = await rec(s)
  assert.equal(now.seq, seq, 'nothing recorded')
  assert.equal(now.nodes.build.state, 'running')
  // Repair: a present node planned at the completion; the warning no longer applies.
  const planned = flow(node('build', 'do', tpl('work')) + node('present', 'do', tpl('present')), [['talk', 'build'], ['build', 'present']])
  const res = await adjust(s, planned, { completing: { node: 'build', outcome: 'built' } }, ADVISE)
  assert.ok(res.ok, JSON.stringify(res.problems))
  assert.equal((await rec(s)).nodes.build.state, 'completed')
})

test('--yes passes reminders only: correctness errors stay errors and it exempts nothing later', async () => {
  const s = await setup()
  await op(s, { op: 'node.start', node: 'talk' })
  await adjust(s, WORK)
  await assert.rejects(op(s, { op: 'node.complete', node: 'build', outcome: 'x' }, { yes: true }), (e: RequestError) => (e.detail as { code: string }).code === 'state')
  await op(s, { op: 'node.complete', node: 'talk', outcome: 'ok' }, ADVISE)
  await op(s, { op: 'node.start', node: 'build' })
  await op(s, { op: 'node.complete', node: 'build', outcome: 'built' }, { yes: true })
  assert.equal((await rec(s)).execution.state, 'completed')
  // WFE's own records are never evaluated (no advice).
  const t = await setup()
  await op(t, { op: 'node.start', node: 'talk' })
  await adjust(t, WORK)
  await op(t, { op: 'node.complete', node: 'talk', outcome: 'ok' })
  await op(t, { op: 'node.start', node: 'build' })
  await op(t, { op: 'node.complete', node: 'build', outcome: 'built' })
  assert.equal((await rec(t)).execution.state, 'completed')
})

test('an adjustment at a completion that warns writes no revision file and no record', async () => {
  const s = await setup()
  await op(s, { op: 'node.start', node: 'talk' })
  await adjust(s, WORK)
  await op(s, { op: 'node.complete', node: 'talk', outcome: 'ok' }, ADVISE)
  await op(s, { op: 'node.start', node: 'build' })
  const before = await rec(s)
  const r = await reminded(adjust(s, flow(node('build', 'do', tpl('work')) + node('notes', 'study'), [['talk', 'build'], ['build', 'notes']]), { completing: { node: 'build', outcome: 'built' } }, ADVISE))
  assert.ok(r.codes.includes('presentation-missing'), r.message)
  const now = await rec(s)
  assert.equal(now.seq, before.seq)
  assert.equal(now.definition.active, before.definition.active)
  assert.deepEqual((await readdir(join(s.folder, 'definition'))).sort(), ['freework.yaml', 'r2'], 'no r3 left behind')
})

test('a presentation registered from a talk, with no cleanup planned, is refused before its files are copied', async () => {
  const s = await setup()
  await op(s, { op: 'node.start', node: 'talk' })
  const o = { node: 'talk', source: 'out', entry: 'index.html', review: 'review.md', title: 'Result' }
  const r = await reminded(registerPresentation(s.ws, s.ref, o, { by: 'autolab', via: 'cli', advice: ADVISE }))
  assert.deepEqual(r.codes, ['presentation-inside-work', 'cleanup-unplanned'])
  assert.match(r.message, /talk is a talk node; a presentation registered from it does not appear as a step of its own/)
  await assert.rejects(readdir(join(s.folder, 'presentations')), 'nothing copied')
  assert.equal((await rec(s)).presentations, undefined)
  // From a present node of its own with a cleanup planned: no reminder.
  await adjust(s, flow(node('present', 'do', tpl('present')) + node('cleanup', 'do', tpl('cleanup')), [['talk', 'present'], ['present', 'cleanup']]))
  await op(s, { op: 'node.complete', node: 'talk', outcome: 'ok' }, ADVISE)
  await op(s, { op: 'node.start', node: 'present' })
  const ok = await registerPresentation(s.ws, s.ref, { ...o, node: 'present' }, { by: 'autolab', via: 'cli', advice: ADVISE })
  assert.equal(ok.presentation.id, 'p1')
})

test('an answer about a presentation reaches the agent with its reminder; completing the review prompts cleanup, and a verified stop removes it', async () => {
  const s = await setup()
  await op(s, { op: 'node.start', node: 'talk' })
  await adjust(s, flow(node('build', 'do', tpl('work')) + node('present', 'do', tpl('present')) + node('review', 'talk', '    confirms: result\n'), [['talk', 'build'], ['build', 'present'], ['present', 'review']]))
  for (const n of ['talk', 'build']) { if (n !== 'talk') await op(s, { op: 'node.start', node: n }); await op(s, { op: 'node.complete', node: n, outcome: 'ok' }, ADVISE) }
  await op(s, { op: 'node.start', node: 'present' })
  await registerPresentation(s.ws, s.ref, { node: 'present', source: 'out', entry: 'index.html', review: 'review.md', title: 'Result' }, { by: 'autolab', via: 'cli', advice: { yes: true } })
  await op(s, { op: 'presentation.observe', presentation: 'p1', status: 'available', instance: 'pi-test-0001', detail: 'serving' }, undefined, 'presenter')
  await op(s, { op: 'node.complete', node: 'present', outcome: 'served' }, ADVISE)
  await op(s, { op: 'node.start', node: 'review' })
  // A review question with the presentation: no reminder.
  await op(s, { op: 'question.ask', question: '', node: 'review', text: 'Good?', to: 'Pat', presentation: 'p1' }, ADVISE)
  await op(s, { op: 'question.answer', question: 'q1', text: 'Make it blue.', from: 'Pat' }, undefined, 'Pat')
  const lines = pendingAnswerLines(await rec(s)).join('\n')
  assert.match(lines, /Reminder: q1 asked about presentation p1 \(available\)\. Decide from the answer: if it asks for changes/)
  await op(s, { op: 'question.take-up', question: 'q1' })
  assert.doesNotMatch(pendingAnswerLines(await rec(s)).join('\n'), /Reminder/, 'once, with the answer')
  const r = await reminded(op(s, { op: 'node.complete', node: 'review', outcome: 'reviewed' }, ADVISE))
  assert.deepEqual(r.codes, ['presentation-serving'])
  assert.match(r.message, /review took the person's answer to q1 about p1; if the review is finished, cleanup is due: p1 "Result" \(available, registered from present; asked in q1, taken-up\)/)
  assert.match(r.message, /wfe present stop freework\/run-001 p1/)
  // The page stopped and verified: the reminder is gone.
  await op(s, { op: 'presentation.observe', presentation: 'p1', status: 'stopped', detail: 'process gone' }, undefined, 'presenter')
  await op(s, { op: 'node.complete', node: 'review', outcome: 'reviewed' }, ADVISE)
  assert.equal((await rec(s)).execution.state, 'completed')
})

test('a planned cleanup satisfies the review reminder; completing the cleanup with the page still recorded as serving does not', async () => {
  const s = await setup()
  await op(s, { op: 'node.start', node: 'talk' })
  await adjust(s, flow(node('present', 'do', tpl('present')) + node('review', 'talk', '    confirms: result\n') + node('tidy', 'do', '    appearance: {icon: cleanup, color: slate}\n'), [['talk', 'present'], ['present', 'review'], ['review', 'tidy']]))
  await op(s, { op: 'node.complete', node: 'talk', outcome: 'ok' }, ADVISE)
  await op(s, { op: 'node.start', node: 'present' })
  await registerPresentation(s.ws, s.ref, { node: 'present', source: 'out', entry: 'index.html', review: 'review.md', title: 'Result' }, { by: 'autolab', via: 'cli', advice: ADVISE })
  await op(s, { op: 'presentation.observe', presentation: 'p1', status: 'available', instance: 'pi-test-0002', detail: 'serving' }, undefined, 'presenter')
  await op(s, { op: 'node.complete', node: 'present', outcome: 'served' }, ADVISE)
  await op(s, { op: 'node.start', node: 'review' })
  await op(s, { op: 'question.ask', question: '', node: 'review', text: 'Good?', to: 'Pat', presentation: 'p1' }, ADVISE)
  await op(s, { op: 'question.answer', question: 'q1', text: 'Fine.', from: 'Pat' }, undefined, 'Pat')
  await op(s, { op: 'question.take-up', question: 'q1' })
  await op(s, { op: 'node.complete', node: 'review', outcome: 'accepted' }, ADVISE)
  await op(s, { op: 'node.start', node: 'tidy' })
  const r = await reminded(op(s, { op: 'node.complete', node: 'tidy', outcome: 'stopped' }, ADVISE))
  assert.deepEqual(r.codes, ['presentation-serving'])
  assert.match(r.message, /tidy is a cleanup node, yet this presentation is still recorded as serving/)
})

test('a consultation question at the start of a talk gets no reminder', async () => {
  const s = await setup()
  await op(s, { op: 'node.start', node: 'talk' })
  const r = await op(s, { op: 'question.ask', question: '', node: 'talk', text: 'Which colour?', to: 'Pat' }, ADVISE)
  assert.equal(r.record.questions.q1.text, 'Which colour?')
})

test('the CLI gives one refusal and exit 1; the same command with --yes records it once', async () => {
  const s = await setup()
  await op(s, { op: 'node.start', node: 'talk' })
  await adjust(s, WORK)
  await op(s, { op: 'node.complete', node: 'talk', outcome: 'ok' })
  await op(s, { op: 'node.start', node: 'build' })
  const cli = async (extra: string[]) => {
    const prev = { log: console.log, error: console.error }
    const out: string[] = [], err: string[] = []
    console.log = (...m: unknown[]) => { out.push(m.join(' ')) }
    console.error = (...m: unknown[]) => { err.push(m.join(' ')) }
    try { return { code: await main(['run', 'complete', 'freework/run-001', 'build', '--outcome', 'built', '--by', 'autolab', '--receipt', 'r-1', '--workspace', 'p', ...extra, '--registry', s.registry, '--area', s.area]), out: out.join('\n'), err: err.join('\n') } } finally { console.log = prev.log; console.error = prev.error }
  }
  const warned = await cli([])
  assert.equal(warned.code, 1)
  assert.match(warned.err, /Not recorded — a reminder before completing build:\n- presentation-missing/)
  assert.equal((await rec(s)).nodes.build.state, 'running')
  assert.equal((await cli(['--yes'])).code, 0)
  const seq = (await rec(s)).seq
  const again = await cli(['--yes'])
  assert.equal(again.code, 0)
  assert.match(again.out, /Already recorded \(same receipt\)/)
  assert.equal((await rec(s)).seq, seq, 'a retransmission records nothing')
})

test('HTTP: the operations route refuses with the same reminders and records nothing; yes continues; a person\'s answer is never refused', async () => {
  const s = await setup()
  const { createServer } = await import('node:http')
  const { createHandler } = await import('../server/api.ts')
  const srv = createServer(createHandler({ registryFile: s.registry, area: s.area, allowedOrigins: [] }))
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', () => res()))
  try {
    const base = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}/api/workspaces/p/runs/freework/run-001`
    const post = async (path: string, body: unknown) => { const r = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as { error?: string; detail?: { code: string; reminders: { code: string }[] }; ok?: boolean } } }
    await op(s, { op: 'node.start', node: 'talk' })
    await adjust(s, WORK)
    await op(s, { op: 'node.complete', node: 'talk', outcome: 'ok' })
    await op(s, { op: 'node.start', node: 'build' })
    const warned = await post('ops', { op: 'node.complete', node: 'build', outcome: 'built', by: 'Pat' })
    assert.equal(warned.status, 409)
    assert.equal(warned.body.detail?.code, 'reminder')
    assert.deepEqual(warned.body.detail?.reminders.map(r => r.code), ['presentation-missing'])
    assert.equal((await rec(s)).nodes.build.state, 'running')
    // The combined route behaves as wfe run adjust --completing.
    const combined = await post('adjust', { text: flow(node('build', 'do', tpl('work')) + node('notes', 'study'), [['talk', 'build'], ['build', 'notes']]), reason: 'notes', by: 'Pat', completing: { node: 'build', outcome: 'built' } })
    assert.equal(combined.status, 409)
    assert.equal(combined.body.detail?.code, 'reminder')
    assert.equal((await rec(s)).definition.active, 'r2')
    const ok = await post('ops', { op: 'node.complete', node: 'build', outcome: 'built', by: 'Pat', yes: true })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal((await rec(s)).execution.state, 'completed')
  } finally { srv.close() }
})

test('reminders are evaluated under the lock on the current record: a stale writer is refused as before, concurrent completions record once', async () => {
  const s = await setup()
  await op(s, { op: 'node.start', node: 'talk' })
  await adjust(s, WORK)
  await op(s, { op: 'node.complete', node: 'talk', outcome: 'ok' })
  await op(s, { op: 'node.start', node: 'build' })
  const seq = (await rec(s)).seq
  await assert.rejects(runOp(s.ws, s.ref, { op: 'node.complete', node: 'build', outcome: 'x' }, { by: 'autolab', via: 'cli', expectSeq: seq - 1, advice: { yes: true } }), (e: RequestError) => (e.detail as { code: string }).code === 'outdated')
  const both = await Promise.allSettled([1, 2].map(i => op(s, { op: 'node.complete', node: 'build', outcome: `built ${i}` }, { yes: true })))
  assert.equal(both.filter(r => r.status === 'fulfilled').length, 1)
  const loser = both.find(r => r.status === 'rejected') as PromiseRejectedResult
  assert.equal((loser.reason.detail as { code: string }).code, 'state')
  assert.equal((await rec(s)).history.filter(e => e.op === 'node.complete' && (e as { node?: string }).node === 'build').length, 1)
})

// ---- work recorded as done afterwards (fix5 step 3) ----------------------------------

const done = (s: S, o: Partial<import('../server/runs.ts').RecordDoneOptions>, receipt?: string) => import('../server/runs.ts').then(m => m.recordDone(s.ws, s.ref, { outcome: 'did it', reason: 'done inside the talk', ...o }, { by: 'autolab', via: 'cli', ...(receipt ? { receipt } : {}) }))

test('record-done adds and completes a catalog node in one entry: no start, no completion event, honest provenance, nothing executed', async () => {
  const s = await setup()
  await op(s, { op: 'node.start', node: 'talk' })
  await writeFile(join(s.dir, 'out', 'index.html'), '<p>made in the talk</p>')
  await gitOk(s.dir, ['add', '-A']); await gitOk(s.dir, ['commit', '-q', '-m', 'made in the talk'])
  const commit = (await gitOk(s.dir, ['rev-parse', 'HEAD'])).trim()
  await op(s, { op: 'node.complete', node: 'talk', outcome: 'Built the page while we talked.' }, { yes: true })
  const before = await rec(s)
  assert.equal(before.execution.state, 'completed')
  const r = await done(s, { template: 'work', node: 'page', after: ['talk'], artifacts: ['out/index.html'], commits: [{ commit: commit.slice(0, 10) }], entries: [before.seq], reported: { started: '2026-10-24T01:00:00Z' } }, 'rd-1')
  assert.equal(r.node, 'page')
  assert.equal(r.revision, 'r2')
  const now = await rec(s)
  assert.equal(now.history.length, before.history.length + 1, 'one entry')
  const e = now.history.at(-1)!
  assert.equal(e.op, 'run.record-done')
  assert.deepEqual(e.change.nodes, { page: [null, 'completed'] })
  assert.equal(e.change.execution, undefined, 'the run stays completed: no second completion')
  const n = now.nodes.page
  assert.equal(n.state, 'completed')
  assert.equal(n.started, null, 'no synthesized start')
  assert.equal(n.ended, null, 'no synthesized end')
  assert.deepEqual(n.retrospective?.reported, { started: '2026-10-24T01:00:00.000Z', ended: null })
  assert.equal(n.retrospective?.by, 'autolab')
  assert.deepEqual(n.retrospective?.evidence.map(x => x.kind), ['artifact', 'commit', 'entry'])
  assert.equal((n.retrospective?.evidence[1] as { commit: string }).commit, commit, 'the short commit is resolved to the full id')
  assert.equal(now.nodes.talk.outcome?.text, 'Built the page while we talked.', 'the talk keeps its words')
  assert.deepEqual(now.history.slice(0, before.history.length), before.history, 'history unchanged')
  const { notableEvents } = await import('../shared/run.ts')
  const evs = notableEvents(now)
  assert.equal(evs.filter(x => x.type === 'completed').length, 1, 'one completion notification')
  assert.match(evs.at(-1)!.text, /recorded afterwards as done: page/)
  // Its revision carries the template's provenance; older revisions do not have it.
  assert.equal(now.definition.revisions?.at(-1)?.source.kind, 'record-done')
  const { readFile } = await import('node:fs/promises')
  assert.match(await readFile(join(s.folder, 'definition', 'r2', 'freework.yaml'), 'utf8'), /page:[\s\S]*template:[\s\S]*id: work/)
  assert.ok(!('page' in (now.definition.effective?.nodes ?? {})), 'not retroactively in r1')
  // The record replays exactly.
  const { checkRun } = await import('../server/runs.ts')
  assert.ok((await checkRun(s.ws, s.ref)).ok)
  // A retransmission records nothing; on a completed run nothing is queued.
  const again = await done(s, { template: 'work', node: 'page', after: ['talk'], artifacts: ['out/index.html'] }, 'rd-1')
  assert.equal(again.duplicate, true)
  assert.equal((await rec(s)).seq, now.seq)
})

test('record-done validates its evidence and placement and refuses without leaving a revision file', async () => {
  const s = await setup()
  await op(s, { op: 'node.start', node: 'talk' })
  const seq = (await rec(s)).seq
  const refused = async (o: Partial<import('../server/runs.ts').RecordDoneOptions>, code: string) => {
    await assert.rejects(done(s, o), (e: RequestError) => (e.detail as { code?: string } | undefined)?.code === code || assert.fail(`${code}: ${e.message}`))
    assert.equal((await rec(s)).seq, seq)
    await assert.rejects(readdir(join(s.folder, 'definition', 'r2')), 'no revision file')
  }
  const refusedAt = async (o: Partial<import('../server/runs.ts').RecordDoneOptions>, code: string) => {
    const at = (await rec(s)).seq
    await assert.rejects(done(s, o), (e: RequestError) => (e.detail as { code?: string } | undefined)?.code === code || assert.fail(`${code}: ${e.message}`))
    assert.equal((await rec(s)).seq, at)
  }
  await refused({ template: 'work', artifacts: ['out/missing.html'] }, 'evidence-unknown')
  await refused({ template: 'work', commits: [{ commit: 'deadbeefdeadbeef' }] }, 'evidence-unknown')
  await refused({ template: 'work', entries: [99] }, 'evidence-unknown')
  await refused({ template: 'work', presentation: 'p9' }, 'evidence-unknown')
  await refused({ template: 'nope' }, 'template-unknown')
  await adjust(s, flow(node('later', 'do'), [['talk', 'later']]))
  await assert.rejects(readdir(join(s.folder, 'definition', 'r3')))
  await refusedAt({ template: 'work', after: ['later'] }, 'state') // later is future work
  await refusedAt({ type: 'do', name: 'X', node: 'talk' }, 'node-exists')
  // Work done inside the running talk follows it.
  const r = await done(s, { template: 'work', node: 'inside', after: ['talk'] })
  assert.equal(r.revision, 'r3')
})

test('record-done on a work node clears the self-check, keeps the presentation reminder, and a linked presentation satisfies it', async () => {
  const s = await setup()
  await op(s, { op: 'node.start', node: 'talk' })
  await op(s, { op: 'artifact.attach', path: 'out/index.html' })
  // Work hid in the talk (gimmickimg/freework/run-001…008): the self-check names it.
  let r = await reminded(op(s, { op: 'node.complete', node: 'talk', outcome: 'built it here' }, ADVISE))
  assert.deepEqual(r.codes, ['unrecorded-activity'])
  assert.match(r.message, /the graph shows no work node, yet artifacts outside the run folder are recorded \(out\/index\.html\)/)
  assert.match(r.message, /WFE cannot tell whether work was done/)
  assert.match(r.message, /wfe run record-done freework\/run-001 --template <id>/)
  // A presentation was registered from the talk earlier (with --yes).
  await registerPresentation(s.ws, s.ref, { node: 'talk', source: 'out', entry: 'index.html', review: 'review.md', title: 'Page' }, { by: 'autolab', via: 'cli', advice: { yes: true } })
  await adjust(s, flow(node('cleanup', 'do', tpl('cleanup')), [['talk', 'cleanup']]))
  await op(s, { op: 'node.complete', node: 'talk', outcome: 'built it here' }, { yes: true })
  await done(s, { template: 'work', node: 'page', after: ['talk'], artifacts: ['out/index.html'], presentation: 'p1' })
  const now = await rec(s)
  assert.deepEqual(now.presentations?.p1.links?.map(l => l.node), ['page'])
  assert.equal(now.presentations?.p1.node, 'talk', 'the registration stays as it was')
  // The work is visible and presented through the link: completing the cleanup warns of nothing.
  await op(s, { op: 'node.start', node: 'cleanup' })
  r = { codes: [], message: '' }
  await op(s, { op: 'node.complete', node: 'cleanup', outcome: 'nothing served' }, ADVISE)
  assert.equal((await rec(s)).execution.state, 'completed')
  // Without the link, the recorded work still asks for a presentation.
  const t = await setup()
  await op(t, { op: 'node.start', node: 'talk' })
  await adjust(t, flow(node('wrap', 'do', tpl('cleanup')), [['talk', 'wrap']]))
  await op(t, { op: 'node.complete', node: 'talk', outcome: 'built it here' }, { yes: true })
  await done(t, { template: 'work', node: 'page', after: ['talk'] })
  await op(t, { op: 'node.start', node: 'wrap' })
  r = await reminded(op(t, { op: 'node.complete', node: 'wrap', outcome: 'done' }, ADVISE))
  assert.deepEqual(r.codes, ['presentation-missing'])
})

test('wfe run record-done from the command line: the help owns the usage, the record says "recorded afterwards"', async () => {
  const s = await setup()
  await op(s, { op: 'node.start', node: 'talk' })
  await op(s, { op: 'node.complete', node: 'talk', outcome: 'did it in the talk' }, { yes: true })
  const cli = async (args: string[]) => {
    const prev = { log: console.log, error: console.error }
    const out: string[] = [], err: string[] = []
    console.log = (...m: unknown[]) => { out.push(m.join(' ')) }
    console.error = (...m: unknown[]) => { err.push(m.join(' ')) }
    try { return { code: await main([...args, '--workspace', 'p', '--registry', s.registry, '--area', s.area]), out: out.join('\n'), err: err.join('\n') } } finally { console.log = prev.log; console.error = prev.error }
  }
  const help = await cli(['run', 'help', 'record-done'])
  assert.match(help.out, /Records work that already happened, without its own node, as a completed\nnode/)
  const head = (await gitOk(s.dir, ['rev-parse', 'HEAD'])).trim()
  const r = await cli(['run', 'record-done', 'freework/run-001', '--template', 'work', '--id', 'page', '--after', 'talk', '--outcome', 'Made the page.', '--reason', 'It was done inside the talk.', '--artifact', 'out/index.html', '--commit-id', head.slice(0, 10), '--entry', '3', '--by', 'autolab'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, new RegExp(`Recorded afterwards: page is completed in r2 \\(nothing was run\\)\\. Evidence: out/index\\.html, commit ${head.slice(0, 10)}, entry 3 \\(node\\.complete\\)`))
  const show = await cli(['run', 'show', 'freework/run-001', '--history'])
  assert.match(show.out, /page +completed RECORDED AFTERWARDS by autolab at .* \(nothing ran it then: It was done inside the talk\.\); outcome: Made the page\./)
  assert.match(show.out, /run\.record-done +autolab \(cli\)  node page  \[page added as completed \(recorded afterwards\)\]/)
})

test('in a run\'s own copy, files written during a talk are a sign of work; files written while a node of their own ran are explained', async () => {
  const s = await setup()
  const { ExecStore } = await import('../server/exec.ts')
  const { runSpace } = await import('../server/runspace.ts')
  const x = new ExecStore({ registryFile: s.registry, area: s.area })
  try {
    const req = await x.request({ workspace: 'p', workflow: 'freework', text: 'make a page', author: 'Pat', receipt: 'rem-copy-0001', via: 'browser' })
    const t = { ...s, ref: req.ref }
    const root = (await runSpace(s.ws, req.ref)).root
    await op(t, { op: 'node.start', node: 'talk' })
    await writeFile(join(root, 'page.html'), '<p>made during the talk</p>')
    const r = await reminded(op(t, { op: 'node.complete', node: 'talk', outcome: 'talked' }, ADVISE))
    assert.deepEqual(r.codes, ['unrecorded-activity'])
    assert.match(r.message, /the run's copy has 1 changed path outside its records, written while no node of its own was running \(page\.html\)/)
    // The same kind of file written in a present node of its own: explained.
    const req2 = await x.request({ workspace: 'p', workflow: 'freework', text: 'present a page', author: 'Pat', receipt: 'rem-copy-0002', via: 'browser' })
    const u = { ...s, ref: req2.ref }
    const root2 = (await runSpace(s.ws, req2.ref)).root
    await op(u, { op: 'node.start', node: 'talk' })
    await adjustRun(s.ws, req2.ref, { text: flow(node('show', 'do', tpl('present')), [['talk', 'show']]), reason: 'present', source: { kind: 'agent' } }, { by: 'autolab', via: 'cli' })
    await op(u, { op: 'node.complete', node: 'talk', outcome: 'talked' }, ADVISE)
    await op(u, { op: 'node.start', node: 'show' })
    await writeFile(join(root2, 'shown.html'), '<p>copied for the presentation</p>')
    await op(u, { op: 'node.complete', node: 'show', outcome: 'nothing served' }, ADVISE)
    assert.equal((await readRun(s.ws, req2.ref)).record!.execution.state, 'completed')
  } finally { x.close() }
})

test('record-done in a workflow with a final report: the report step follows the new node; inserted between two nodes, their direct edge goes', async () => {
  const s = await setup()
  const final = (nodes: string, edges: [string, string][]) => flow(nodes, edges).replace('documentation: {policy: manual}', 'documentation: {policy: custom, plan: false, reports: false, final: true}')
  await writeFile(join(s.dir, 'devdocs', 'workflows', 'freework.yaml'), final(node('wrap', 'do'), [['talk', 'wrap']]))
  await gitOk(s.dir, ['add', '-A']); await gitOk(s.dir, ['commit', '-q', '-m', 'final report'])
  const created = await createRun(s.ws, { workflow: 'freework', name: 'run-002', executor: { host: 'autolab' }, by: 'Pat', via: 'cli', input: { kind: 'braindump', text: 'x', author: 'Pat' }, area: s.area })
  const t = { ...s, ref: created.ref }
  await op(t, { op: 'node.start', node: 'talk' })
  const m = await import('../server/runs.ts')
  const r = await m.recordDone(s.ws, created.ref, { template: 'work', node: 'page', after: ['talk'], before: ['wrap'], outcome: 'made', reason: 'inside the talk' }, { by: 'autolab', via: 'cli' })
  const g = (await rec(t)).definition.revisions!.at(-1)!.effective
  assert.ok(g.edges.some(e => e.from === 'page' && e.to === 'wrap') && !g.edges.some(e => e.from === 'talk' && e.to === 'wrap'), 'inserted between talk and wrap')
  assert.equal(r.revision, 'r2')
  assert.equal((await rec(t)).nodes.page.state, 'completed')
})
