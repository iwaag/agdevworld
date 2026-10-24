// workflow_editor fix6: a delegated result assessed where the parent receives
// it, and returned to the same child for correction. The recorded failure is
// conversation 20261024-160217-forusr: misc/freework/run-001…004 completed
// without a presentation and ponderer judged each result satisfied within
// seconds. The fixtures reproduce that shape — a child that completes with a
// viewable file and presents nothing, a parent without work nodes of its own
// — and exercise the correction through the real transport, its crash points
// and its competing requests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assessDelegation, delegatedReminders } from '../server/delegate.ts'
import { adjustRun, readRun, registerPresentation, runOp } from '../server/runs.ts'
import { runSpace } from '../server/runspace.ts'
import { RequestError } from '../server/workspace.ts'
import { reminderText } from '../shared/reminders.ts'
import { openRevision } from '../shared/delegation.ts'
import { KID_STREAM, as, claim, delegationSuite, dispatched, rec, restart, setup, type S } from './delegateFixture.ts'

delegationSuite('wfe-correction-')

const kidRef = { workflow: 'make', run: 'run-001' }
const code = (e: unknown) => ((e as RequestError).detail as { code?: string } | undefined)?.code
const reminders = (e: unknown) => ((e as RequestError).detail as { reminders?: { code: string; summary: string }[] } | undefined)?.reminders?.map(r => r.code) ?? []

// The child does its work, writes a viewable file and completes without a
// presentation (run-004's shape: a video, no present node, no confirmation).
async function completedWithoutPresentation(s: S) {
  const { ref, a } = await dispatched(s)
  await s.x.finished(a.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const c1 = await claim(s)
  const kid = as(s.kid, kidRef, c1.attempt.id, 'kid-agent')
  await kid({ op: 'node.start', node: 'scope' })
  await kid({ op: 'node.complete', node: 'scope', outcome: 'Clear.' })
  await kid({ op: 'node.start', node: 'build' })
  const kspace = await runSpace(s.kid, kidRef)
  await mkdir(join(kspace.root, 'out'), { recursive: true })
  await writeFile(join(kspace.root, 'out', 'icon.png'), 'png bytes')
  await kid({ op: 'node.complete', node: 'build', outcome: 'out/icon.png made.', artifacts: ['out/icon.png'] })
  await kid({ op: 'node.start', node: 'confirm' })
  await kid({ op: 'node.complete', node: 'confirm', outcome: 'Done; the requester has the file paths.' })
  await s.x.finished(c1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  const p1 = await claim(s)
  assert.deepEqual(p1.ref, ref)
  return { ref, p1, par: as(s.par, ref, p1.attempt.id, 'par-agent') }
}

test('the parent\'s brief and take-up carry the assessment; satisfied is refused with the child\'s omission and records nothing; --yes passes it; a stale result never passes', async () => {
  const s = await setup()
  const { ref, p1, par } = await completedWithoutPresentation(s)
  assert.match(p1.brief, /assessment of result event 1/)
  assert.match(p1.brief, /MISSING presentation-missing: .*viewable candidates .*out\/icon\.png/)
  await par({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  const before = (await rec(s.par, ref)).seq
  const e = await s.x.delegate.dispose(s.par, ref, 'd1', { disposition: 'satisfied', note: 'looks fine' }, { by: 'par-agent', via: 'cli', attempt: p1.attempt.id }).catch(x => x)
  assert.equal(code(e), 'reminder', String(e))
  assert.deepEqual(reminders(e), ['delegated-presentation-missing'])
  assert.match(e.message, /wfe delegate revise use\/run-001 d1/)
  assert.match(e.message.split('\n').at(-1), /^In short: delegated-presentation-missing: d1 \(make\/run-001\) completed .*out\/icon\.png and presented nothing → wfe delegate revise/)
  assert.equal((await rec(s.par, ref)).seq, before, 'nothing recorded')
  // A result named that is not the one recorded is a correctness error, also with yes.
  const stale = await s.x.delegate.dispose(s.par, ref, 'd1', { disposition: 'satisfied', note: 'x', manifest: 'sha256:' + '0'.repeat(64), yes: true }, { by: 'par-agent', via: 'cli', attempt: p1.attempt.id }).catch(x => x)
  assert.equal(code(stale), 'result-superseded')
  const ok = await s.x.delegate.dispose(s.par, ref, 'd1', { disposition: 'satisfied', note: 'a file is enough here', yes: true }, { by: 'par-agent', via: 'cli', attempt: p1.attempt.id })
  assert.equal(ok.record.delegations!.d1.disposition?.kind, 'satisfied')
  // Already satisfied, the result is still assessed when the parent reports.
  const rs = await delegatedReminders(s.x.delegate, ok.record)
  assert.deepEqual(rs.map(r => r.code), ['delegated-presentation-missing'])
  assert.match(rs[0].text, /judged satisfied/)
  s.i.close(); s.n.close(); s.x.close()
})

test('a parent without work nodes is reminded when it completes its run; the reminder merges with its own; --yes passes it once', async () => {
  const s = await setup()
  const { ref, p1, par } = await completedWithoutPresentation(s)
  await par({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  await s.x.delegate.dispose(s.par, ref, 'd1', { disposition: 'satisfied', note: 'ok', yes: true }, { by: 'par-agent', via: 'cli', attempt: p1.attempt.id })
  await par({ op: 'node.complete', node: 'asset', outcome: 'came back' })
  await par({ op: 'node.start', node: 'use' })
  const assess = async (r: Parameters<typeof delegatedReminders>[1]) => delegatedReminders(s.x.delegate, r)
  const e = await runOp(s.par, ref, { op: 'node.complete', node: 'use', outcome: 'used', attempt: p1.attempt.id } as never, { by: 'par-agent', via: 'cli', advice: { assess } }).catch(x => x)
  assert.equal(code(e), 'reminder', String(e))
  assert.ok(reminders(e).includes('delegated-presentation-missing'), reminders(e).join())
  assert.equal((await rec(s.par, ref)).nodes.use.state, 'running', 'nothing recorded')
  await runOp(s.par, ref, { op: 'node.complete', node: 'use', outcome: 'used', attempt: p1.attempt.id } as never, { by: 'par-agent', via: 'cli', advice: { yes: true, assess } })
  assert.equal((await rec(s.par, ref)).execution.state, 'completed')
  s.i.close(); s.n.close(); s.x.close()
})

test('same-child correction: the result returned, delivered, the child reopened once, the work added and presented, a new result assessed clean; the earlier result cannot be judged', async () => {
  const s = await setup()
  const { ref, p1, par } = await completedWithoutPresentation(s)
  await par({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  const p0 = await rec(s.par, ref)
  const manifest = p0.delegations!.d1.events[0].manifest!.digest
  const r = await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'Present out/icon.png through a present node, ask me about it, and plan its cleanup.', reason: 'The person has not seen the icon.', manifest }, { by: 'par-agent', via: 'cli', attempt: p1.attempt.id, receipt: 'revise-1' })
  assert.equal(r.record.nodes.asset.state, 'waiting', 'the delegate node waits for the corrected result')
  assert.equal(openRevision(r.record.delegations!.d1)?.n, 1)
  // A retransmission is one request; a second one while correcting is refused.
  const again = await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'x', reason: 'y' }, { by: 'par-agent', via: 'cli', attempt: p1.attempt.id, receipt: 'revise-1' })
  assert.equal(again.duplicate, true)
  // The earlier result is not judged while returned, with or without yes.
  const back = await s.x.delegate.dispose(s.par, ref, 'd1', { disposition: 'satisfied', note: 'x', yes: true }, { by: 'par-agent', via: 'cli', attempt: p1.attempt.id }).catch(x => x)
  assert.equal(code(back), 'result-returned')
  await s.x.finished(p1.attempt.id, { code: 0, signal: null })
  // Delivery: posted in the child's request topic; the ack is lost once.
  await s.zulip.deliver({ lose: ev => ev.some(x => x.includes(':delegation-revision@')) })
  await s.zulip.receive()
  assert.equal((await rec(s.kid, kidRef)).corrections, undefined, 'nothing applied while the delivery is uncertain')
  await s.zulip.cycle()
  const posts = s.zulip.posts.filter(p => p.streamId === KID_STREAM && p.content.includes('Result returned for correction'))
  assert.equal(posts.length, 1, 'found by its marker, not posted twice')
  assert.match(posts[0].content, /Why: The person has not seen the icon\./)
  let child = await rec(s.kid, kidRef)
  assert.deepEqual(Object.keys(child.corrections ?? {}), ['c1'])
  assert.equal(child.execution.state, 'in-progress', 'reopened: not completed while the correction is open')
  assert.equal(child.history.filter(h => h.op === 'correction.receive').length, 1)
  // The parent learns the child took it, without being woken.
  let p = await rec(s.par, ref)
  assert.deepEqual(p.delegations!.d1.events.map(e => [e.type, e.wakes]), [['completed', true], ['correcting', false]])
  assert.equal(p.delegations!.d1.events.filter(e => e.type === 'completed').length, 1, 'the old result is not announced again')
  // The intake applying the post again changes nothing.
  s.i.db.prepare('UPDATE messages SET state = \'classified\', applied = NULL WHERE id = ?').run(posts[0].id)
  await s.zulip.receive()
  assert.equal((await rec(s.kid, kidRef)).history.filter(h => h.op === 'correction.receive').length, 1, 'the receipt holds')
  // The child is continued once, and told the correction.
  const c2 = await claim(s)
  assert.deepEqual(c2.ref, kidRef)
  assert.match(c2.brief, /returned your completed result for correction/)
  assert.match(c2.brief, /add: Present out\/icon\.png/)
  assert.match(c2.brief, /on behalf of Pat/)
  assert.equal((s.x.db.prepare('SELECT count(*) AS n FROM jobs WHERE state = \'queued\'').get() as { n: number }).n, 0, 'one continuation')
  // It adds a present node and a cleanup after the completed work; completed work stays.
  const kid = as(s.kid, kidRef, c2.attempt.id, 'kid-agent')
  await kid({ op: 'correction.take-up', correction: 'c1', note: 'adding a present node' } as never)
  const text = (await import('node:fs/promises')).readFile
  const kspace = await runSpace(s.kid, kidRef)
  const def = await text(join(kspace.root, 'devdocs/runs/make/run-001/definition/make.yaml'), 'utf8')
  const revised = def.replace('edges:', `  present:\n    type: do\n    description: Present the icon.\n    template: {id: present, revision: 1, expectation: "present"}\n  cleanup:\n    type: do\n    description: Stop it.\n    template: {id: cleanup, revision: 1, expectation: "cleanup"}\nedges:\n  - {from: confirm, to: present}\n  - {from: present, to: cleanup}`)
  const adj = await adjustRun(s.kid, kidRef, { text: revised, reason: 'correction c1: present the icon', source: { kind: 'agent' } }, { by: 'kid-agent', via: 'cli', attempt: c2.attempt.id })
  assert.ok(adj.ok, JSON.stringify(adj.problems))
  child = await rec(s.kid, kidRef)
  assert.equal(child.corrections!.c1.addressed?.how, 'work')
  assert.equal(child.nodes.build.state, 'completed', 'completed work kept')
  await kid({ op: 'node.start', node: 'present' })
  await mkdir(join(kspace.root, 'page'), { recursive: true })
  await writeFile(join(kspace.root, 'page', 'index.html'), '<img src="icon.png">')
  await writeFile(join(kspace.root, 'page', 'review.md'), '# The icon\n')
  await registerPresentation(s.kid, kidRef, { node: 'present', source: 'page', entry: 'index.html', review: 'page/review.md', title: 'The icon' }, { by: 'kid-agent', via: 'cli', attempt: c2.attempt.id })
  await kid({ op: 'node.complete', node: 'present', outcome: 'presented as p1' })
  await kid({ op: 'node.start', node: 'cleanup' })
  await kid({ op: 'node.complete', node: 'cleanup', outcome: 'nothing was served' })
  await s.x.finished(c2.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  // A new result comes back; the earlier one stays as it was.
  p = await rec(s.par, ref)
  const results = p.delegations!.d1.events.filter(e => e.type === 'completed')
  assert.equal(results.length, 2)
  assert.notEqual(results[1].manifest!.digest, results[0].manifest!.digest)
  assert.equal(openRevision(p.delegations!.d1), undefined)
  const p2 = await claim(s)
  await as(s.par, ref, p2.attempt.id, 'par-agent')({ op: 'delegation.take-up', delegation: 'd1', events: [results[1].n] } as never)
  const a = await assessDelegation(s.x.delegate, await rec(s.par, ref), p.delegations!.d1)
  assert.equal(a?.event, results[1].n)
  assert.equal(a?.checks.find(c => c.code === 'presentation-missing')?.status, 'ok', JSON.stringify(a?.checks))
  // The old result is superseded; the new one is judged without reminders.
  const old = await s.x.delegate.dispose(s.par, ref, 'd1', { disposition: 'satisfied', note: 'x', event: results[0].n, yes: true }, { by: 'par-agent', via: 'cli', attempt: p2.attempt.id }).catch(x => x)
  assert.equal(code(old), 'result-superseded')
  const done = await s.x.delegate.dispose(s.par, ref, 'd1', { disposition: 'satisfied', note: 'presented now' }, { by: 'par-agent', via: 'cli', attempt: p2.attempt.id })
  assert.equal(done.record.delegations!.d1.disposition?.event, results[1].n)
  // Replay keeps both identities.
  const again2 = await readRun(await runSpace(s.par, ref), ref)
  assert.ok(again2.record, again2.problem?.message)
  assert.equal(again2.record!.delegations!.d1.revisions?.[0].event, results[0].n)
  s.i.close(); s.n.close(); s.x.close()
})

test('a correction left unaddressed holds the child as interrupted; a lost continuation is queued again; --no-change completes it again as a new result', async () => {
  const s = await setup()
  const { ref, p1, par } = await completedWithoutPresentation(s)
  await par({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'Say why no page is needed.', reason: 'Unclear.' }, { by: 'par-agent', via: 'cli', attempt: p1.attempt.id })
  await s.x.finished(p1.attempt.id, { code: 0, signal: null })
  await s.zulip.cycle()
  // The continuation is lost (a crash after the record, before the queue).
  s.x.db.prepare('DELETE FROM jobs WHERE receipt LIKE \'correction:%\'').run()
  const s2 = await restart(s)
  const notes = await s2.x.reconcile()
  assert.ok(notes.some(n => /resume for correction c1 queued again/.test(n)), notes.join('\n'))
  const c2 = await claim(s2)
  assert.deepEqual(c2.ref, kidRef)
  // The attempt ends without addressing it: held, like work left ready.
  const f = await s2.x.finished(c2.attempt.id, { code: 0, signal: null })
  assert.equal(f.outcome, 'interrupted')
  let child = await rec(s2.kid, kidRef)
  assert.equal(child.control.hold?.cause?.code, 'missed-correction')
  await s2.x.resume(s2.kid, kidRef, 'Pat', 'go on', 'browser')
  const c3 = await claim(s2)
  await as(s2.kid, kidRef, c3.attempt.id, 'kid-agent')({ op: 'correction.take-up', correction: 'c1', note: 'The icon file is the deliverable; the requester shows it.', noChange: true } as never)
  child = await rec(s2.kid, kidRef)
  assert.equal(child.execution.state, 'completed')
  await s2.x.finished(c3.attempt.id, { code: 0, signal: null })
  await s2.zulip.cycle()
  const p = await rec(s2.par, ref)
  assert.deepEqual(p.delegations!.d1.events.filter(e => e.type === 'completed').map(e => e.n).length, 2, 'a new result')
  s2.i.close(); s2.n.close(); s2.x.close()
})

test('competing and closed: dispose abandoned after revise closes it; revise after dispose, on a cancelled child, before take-up and for a stale result is refused; a refused correction reopens the choice', async () => {
  const s = await setup()
  const { ref, p1, par } = await completedWithoutPresentation(s)
  const ctx = { by: 'par-agent', via: 'cli', attempt: p1.attempt.id }
  const notYet = await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'x', reason: 'y' }, ctx).catch(x => x)
  assert.equal(code(notYet), 'delegation-result', 'read the result first')
  await par({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  const wrong = await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'x', reason: 'y', manifest: 'sha256:' + '1'.repeat(64) }, ctx).catch(x => x)
  assert.equal(code(wrong), 'result-superseded')
  // The child completed again by someone else's hand before delivery: the
  // child refuses the stale correction and the parent is told (woken).
  await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'Present it.', reason: 'Not seen.' }, ctx)
  await s.x.finished(p1.attempt.id, { code: 0, signal: null })
  await runOp(s.kid, kidRef, { op: 'node.start', node: 'confirm' } as never, { by: 'Pat', via: 'cli' }).catch(() => null)
  await runOp(s.kid, kidRef, { op: 'node.complete', node: 'confirm', outcome: 'again' } as never, { by: 'Pat', via: 'cli' }).catch(() => null)
  await s.zulip.cycle()
  let p = await rec(s.par, ref)
  const refused = p.delegations!.d1.events.find(e => e.type === 'answer-refused')
  assert.ok(refused, p.delegations!.d1.events.map(e => e.type).join())
  assert.equal(refused!.revision, 1)
  assert.equal(openRevision(p.delegations!.d1), undefined, 'a refused correction no longer stands')
  // Abandon closes it; nothing reopens a closed delegation.
  const p2 = await claim(s)
  const par2 = as(s.par, ref, p2.attempt.id, 'par-agent')
  p = await rec(s.par, ref)
  await par2({ op: 'delegation.take-up', delegation: 'd1', events: p.delegations!.d1.events.filter(e => e.wakes && !e.takenUp).map(e => e.n) } as never)
  await par2({ op: 'delegation.dispose', delegation: 'd1', disposition: 'abandoned', note: 'replacing it' } as never)
  const closed = await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'x', reason: 'y' }, { by: 'par-agent', via: 'cli', attempt: p2.attempt.id }).catch(x => x)
  assert.equal(code(closed), 'delegation-closed')
  s.i.close(); s.n.close(); s.x.close()
})

test('a cancelled child is not corrected; a held parent records the request and launches nothing until resumed; cancelling the parent leaves the child', async () => {
  const s = await setup()
  const { ref, p1, par } = await completedWithoutPresentation(s)
  await par({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  await s.x.cancel(s.kid, kidRef, 'Pat', 'not needed', 'browser')
  const e = await s.x.delegate.revise(s.par, ref, 'd1', { instruction: 'x', reason: 'y' }, { by: 'par-agent', via: 'cli', attempt: p1.attempt.id }).catch(x => x)
  assert.equal(code(e), 'child-stopped')
  s.i.close(); s.n.close(); s.x.close()

  const t = await setup()
  const r2 = await completedWithoutPresentation(t)
  await r2.par({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  await t.x.delegate.revise(t.par, r2.ref, 'd1', { instruction: 'Present it.', reason: 'Not seen.' }, { by: 'par-agent', via: 'cli', attempt: r2.p1.attempt.id })
  await t.x.finished(r2.p1.attempt.id, { code: 0, signal: null })
  await t.x.stop(t.par, r2.ref, 'Pat', 'pause', 'browser')
  await t.zulip.cycle()
  const c2 = await claim(t)
  assert.deepEqual(c2.ref, kidRef, 'the child is continued; the hold is the parent\'s')
  const kid = as(t.kid, kidRef, c2.attempt.id, 'kid-agent')
  await kid({ op: 'correction.take-up', correction: 'c1', note: 'fine as is', noChange: true } as never)
  await t.x.finished(c2.attempt.id, { code: 0, signal: null })
  await t.zulip.cycle()
  assert.deepEqual(await t.x.claim('test'), { idle: 'no queued job' }, 'the held parent launches nothing')
  await t.x.cancel(t.par, r2.ref, 'Pat', 'stop it all', 'browser')
  assert.equal((await rec(t.kid, kidRef)).cancelled, null, 'cancelling the parent leaves the child')
  t.i.close(); t.n.close(); t.x.close()
})

test('the refusal tail keeps the facts and a repair for every reminder, also with several at once', () => {
  const text = reminderText([
    { code: 'presentation-missing', text: 'build is work…', repair: ['add a present node: wfe nodes instantiate present …'], refs: ['build'], summary: 'build completed with nothing presenting out/a.mp4 → add a present node after build (wfe nodes instantiate present …)' },
    { code: 'delegated-review-unrecorded', text: 'd1 …', repair: ['ask them'], refs: ['d1', 'event 1'], summary: 'd1 accepts: person, and no answer from Pat about this result is traceable → relay their actual answer, or ask them (wfe run ask … --to Pat)' },
    { code: 'cleanup-unplanned', text: 'no cleanup', repair: ['plan it'], refs: ['present'], summary: 'no cleanup node is planned for this page → plan one (wfe nodes instantiate cleanup …)' },
  ], 'completing build')
  const tail = text.split('\n').slice(-3).join('\n')
  for (const x of ['presentation-missing', 'out/a.mp4', 'wfe nodes instantiate present', 'delegated-review-unrecorded', 'wfe run ask', 'cleanup-unplanned', '--yes']) assert.ok(tail.includes(x), `${x} in the tail:\n${tail}`)
  assert.ok(!/records that need no viewing/.test(text), 'the presentation-specific escape is gone')
  assert.match(text.split('\n')[0], /3 reminders before completing build: presentation-missing, delegated-review-unrecorded, cleanup-unplanned\./)
})

test('CLI and HTTP: dispose refuses with the reminders (exit 1, 409) and records nothing; --yes / yes continues; revise has the same route; a retransmission records once', async () => {
  const s = await setup()
  const { ref, p1, par } = await completedWithoutPresentation(s)
  await par({ op: 'delegation.take-up', delegation: 'd1', events: [1] } as never)
  await s.x.finished(p1.attempt.id, { code: 0, signal: null })
  const { main } = await import('../cli/wfe.ts')
  const cli = async (args: string[]) => {
    const prev = { log: console.log, error: console.error }
    const out: string[] = [], err: string[] = []
    console.log = (...m: unknown[]) => { out.push(m.join(' ')) }
    console.error = (...m: unknown[]) => { err.push(m.join(' ')) }
    try { return { code: await main([...args, '--by', 'par-agent', '--workspace', s.par.reg.id, '--registry', s.registry, '--area', s.area]), out: out.join('\n'), err: err.join('\n') } } finally { console.log = prev.log; console.error = prev.error }
  }
  const show = await cli(['delegate', 'show', 'use/run-001', 'd1'])
  assert.equal(show.code, 0, show.err)
  assert.match(show.out, /MISSING presentation-missing/)
  const warned = await cli(['delegate', 'dispose', 'use/run-001', 'd1', '--disposition', 'satisfied', '--note', 'ok', '--receipt', 'disp-1'])
  assert.equal(warned.code, 1)
  assert.match(warned.err, /delegated-presentation-missing/)
  assert.match(warned.err.split('\n').at(-1)!, /In short: .*wfe delegate revise/)
  assert.equal((await rec(s.par, ref)).delegations!.d1.disposition, null)
  // HTTP: the same assessment, and revise through the same route family.
  const { createServer } = await import('node:http')
  const { createHandler } = await import('../server/api.ts')
  const srv = createServer(createHandler({ registryFile: s.registry, area: s.area, allowedOrigins: [], exec: s.x } as never))
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', () => res()))
  try {
    const base = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}/api/workspaces/${s.par.reg.id}/runs/use/run-001/delegations/d1`
    const post = async (path: string, body: unknown) => { const r = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as { detail?: { code: string; reminders: { code: string }[] }; ok?: boolean } } }
    const h = await post('dispose', { disposition: 'satisfied', note: 'ok', by: 'par-agent' })
    assert.equal(h.status, 409)
    assert.deepEqual(h.body.detail?.reminders.map(r => r.code), ['delegated-presentation-missing'])
    const view = await (await fetch(`${base}/assessment`)).json() as { assessment: { checks: { code: string; status: string }[] } }
    assert.equal(view.assessment.checks.find(c => c.code === 'presentation-missing')?.status, 'missing')
    const ok = await post('dispose', { disposition: 'satisfied', note: 'a file is fine', by: 'par-agent', yes: true, receipt: 'disp-http' })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    const again = await post('dispose', { disposition: 'satisfied', note: 'a file is fine', by: 'par-agent', yes: true, receipt: 'disp-http' })
    assert.equal(again.status, 200)
    assert.equal((await rec(s.par, ref)).history.filter(x => x.op === 'delegation.dispose').length, 1, 'once')
    const closed = await post('revise', { instruction: 'x', reason: 'y', by: 'par-agent' })
    assert.equal(closed.status, 422)
    assert.equal(closed.body.detail?.code, 'delegation-closed')
  } finally { srv.close() }
  s.i.close(); s.n.close(); s.x.close()
})
