// tidy p2: the questions at the boundaries where a result is reported and
// received (shared/resultEvidence.ts), and the account a resting conductor
// owes for the results it commissioned (server/restChecks.ts). A path or a
// template chooses a question, never a finding; an earlier reply does not
// account for a result that moved after it; the check clears once the run
// speaks, so it cannot loop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changedSince, delegationStanding, producerLines, receiverQuestions, workContext } from '../shared/resultEvidence.ts'
import { restReminders } from '../server/restChecks.ts'
import type { Delegation, DelegationEvent } from '../shared/delegation.ts'
import type { RunRecord } from '../shared/run.ts'
import type { ConversationService } from '../server/conversationService.ts'

test('work context: a tidy node, documentation, tests, delivery manifests, outputs and removals choose questions; other changes choose none', () => {
  const none = workContext({ templates: ['work'], changed: ['src/game.gd', 'data/preds/wolf/predation.json'], removed: [], outputs: [] })
  assert.deepEqual([none.tidy, none.kinds], [false, []])
  const tidy = workContext({ templates: ['tidy'], changed: [], removed: [], outputs: [] })
  assert.deepEqual([tidy.tidy, tidy.kinds, tidy.basis], [true, ['documentation'], ['a tidy node']])
  const all = workContext({ templates: [], changed: ['README.md', 'agent/guide.md', 'tests/test_deliveries.py', 'data/deliveries.json', '.gitignore', 'sheet-review.md'], removed: ['sheet-review.md'], outputs: [] })
  assert.deepEqual(all.kinds, ['documentation', 'delivery', 'moves', 'tests'])
  assert.ok(all.basis.includes('sheet-review.md (removed)') && !all.basis.includes('sheet-review.md'), 'a removed file is a removal, not documentation')
  assert.deepEqual(workContext({ templates: [], changed: [], removed: [], outputs: ['o1'] }).kinds, ['delivery'])
  assert.deepEqual(workContext({ templates: [], changed: ['tools/deliveries_test.py', 'src/foo.spec.ts'], removed: [], outputs: [] }).kinds, ['tests'])
  assert.deepEqual(workContext({ templates: [], changed: ['devdocs/notes/today.md', 'src/x/readme_parser.py'], removed: [], outputs: [] }).kinds, [], 'a note in a domain folder or a name containing "readme" is not the entry')
})

test('producer: ordinary work is asked whether the entry still matches; a tidy run is asked for evidence, not another pass; the basis is said', () => {
  const plain = producerLines({ context: workContext({ templates: [], changed: ['src/a.py'], removed: [], outputs: [] }), requester: null, report: null }).join('\n')
  assert.match(plain, /whoever reads it compares what you report/)
  assert.match(plain, /Do the project's entry \(README\), guide and setup or acquisition instructions still match this change\? If not, correct them in a node of this run \(the catalog's tidy fits\), not only in the report\./)
  assert.doesNotMatch(plain, /chosen from|Tests: |Delivery: /)
  assert.ok(plain.split('\n').length <= 5, 'short when nothing specific applies')
  const tidied = producerLines({ context: workContext({ templates: ['tidy'], changed: ['README.md', 'data/deliveries.json', 'tests/test_x.py'], removed: [], outputs: [] }), requester: 'ponderer-agent', report: 'devdocs/runs/freework/run-006/report.md' }).join('\n')
  assert.match(tidied, /ponderer-agent compares what you report with your files and records/)
  assert.match(tidied, /This run tidied: report its evidence rather than tidy again\./)
  assert.doesNotMatch(tidied, /correct them in a node of this run/)
  assert.match(tidied, /Delivery: .*Run the acquisition or status check; reading the record is not that check\./)
  assert.match(tidied, /Tests: did the new and changed tests actually run \(listed by the runner, not only present in the source\)/)
  assert.match(tidied, /\(chosen from this run's changes: a tidy node, README\.md, tests\/test_x\.py, data\/deliveries\.json; a path chooses a question, it shows no defect\)/)
})

test('receiver: the general questions always; a kind\'s question only when chosen', () => {
  const q = receiverQuestions(workContext({ templates: [], changed: [], removed: [], outputs: [] }), 'READ', 'REVISE')
  const t = receiverQuestions(workContext({ templates: [], changed: ['tests/test_x.py'], removed: [], outputs: [] }), 'READ', 'REVISE').join('\n')
  assert.match(t, /Tests: the output in the report is the child's claim\. Run the named command on its files where you can .*say in your note whether the counts are your own or unverified\./, 'trial C: a count is not checked by reading the report')
  assert.deepEqual(q, ['WFE checked records, not content. Compare the claim with the files before judging (READ).', 'What is missing goes back to the same child (REVISE) as part of assessing it — no go-ahead is needed for what the request asked — and its next result is checked again; otherwise your judgement\'s note says what you checked.'])
})

// ---- the multi-child account ----

const ev = (n: number, at: string): DelegationEvent => ({ n, type: 'completed', at, seq: n, during: null, child: { seq: n, at, by: 'kid' }, wakes: true, text: 'done', takenUp: { at, by: 'ponderer-agent', attempt: null } })
const dl = (id: string, project: string, o: Partial<Delegation> = {}): Delegation => ({
  id, uid: `ponderer/conduct/run-048#x/${id}`, node: `tidy-${project}`, target: { project, workflow: 'freework', workspace: project }, request: { path: 'r', sha256: 'x', bytes: 1 },
  requester: 'ponderer-agent', onBehalfOf: 'Pat', accepts: 'person', dispatched: { at: '2026-10-26T20:07:00.000Z', by: 'ponderer-agent', attempt: null, seq: 1 },
  child: { uid: `${project}#c`, workspace: project, project, workflow: 'freework', run: 'run-006', created: '' }, transport: null, events: [], answers: [], instructions: [], disposition: null, closed: null, ...o,
})
const judged = (event: number, at: string) => ({ kind: 'satisfied' as const, note: 'ok', event, manifest: null, at, by: 'ponderer-agent' })
const corr = (event: number, at: string) => ({ n: 1, event, manifest: null, childSeq: 1, instruction: 'fix it', reason: 'r', from: 'Omni', by: 'ponderer-agent', at, attempt: null, seq: 2 })

// As run-048 at #453: d1 and d3 corrected and judged before #453, d2 judged long before #452.
const run048 = () => ({
  d1: dl('d1', 'protoprey', { events: [ev(1, '2026-10-26T20:13:00.000Z'), ev(4, '2026-10-26T20:37:50.000Z')], revisions: [corr(1, '2026-10-26T20:35:00.000Z')], disposition: judged(4, '2026-10-26T20:38:02.546Z') }),
  d2: dl('d2', 'gimmickimg', { events: [ev(1, '2026-10-26T20:16:00.000Z')], disposition: judged(1, '2026-10-26T20:17:00.000Z') }),
  d3: dl('d3', 'lowerpoly', { events: [ev(1, '2026-10-26T20:15:19.042Z'), ev(4, '2026-10-26T20:37:07.326Z')], revisions: [corr(1, '2026-10-26T20:35:06.750Z')], disposition: judged(4, '2026-10-26T20:37:27.675Z') }),
})

test('the account since a previous post lists every delegation that moved, with where it stands', () => {
  const ds = run048()
  assert.deepEqual(changedSince({ delegations: ds }, '2026-10-26T20:35:28.978Z'), [
    'd1 → protoprey freework/run-006: judged satisfied (event 4) after 1 correction request',
    'd3 → lowerpoly freework/run-006: judged satisfied (event 4) after 1 correction request',
  ], 'since #452: both corrections, not d2')
  assert.equal(changedSince({ delegations: ds }, null).length, 3)
  assert.equal(delegationStanding(dl('d4', 'agsfx', { events: [ev(1, 't1')], revisions: [corr(1, 't2')] })), 'd4 → agsfx freework/run-006: returned for correction (request 1), not back yet')
  assert.equal(delegationStanding(dl('d4', 'agsfx', { events: [ev(1, 't1'), ev(3, 't3')], revisions: [corr(1, 't2')] })), 'd4 → agsfx freework/run-006: result event 3 (a corrected result after 1 correction request), not judged yet')
  assert.equal(delegationStanding(dl('d5', 'agsfx')), 'd5 → agsfx freework/run-006: no result yet')
})

// A discussion service as restReminders reads it.
function room(messages: { id: number; role: 'person' | 'agent'; run: string | null; kind: string; at: string }[]) {
  return { conductedBy: () => ['tidy-p2'], conversation: () => ({ state: 'open' }), activityRows: () => [], messages: () => messages } as unknown as ConversationService
}
const RUN = 'ponderer/conduct/run-048'
const conductor = (delegations: Record<string, Delegation>) => ({ standing: { state: 'open' }, nodes: { 'ponder-w3': { state: 'running' }, earlier: { state: 'completed' } }, delegations }) as unknown as RunRecord

test('results-unreported: a result judged after the run last spoke is named at rest; an earlier reply does not hide it; speaking clears it', async () => {
  const ds = run048()
  // #452 replied to #451 (20:35:28); then both corrections came back and were judged; the run rests silently.
  const before453 = room([{ id: 451, role: 'person', run: null, kind: 'message', at: '2026-10-26T20:34:25.450Z' }, { id: 452, role: 'agent', run: RUN, kind: 'reply', at: '2026-10-26T20:35:28.978Z' }])
  const rs = await restReminders(before453, conductor(ds), RUN, 'ponder-w3')
  assert.deepEqual(rs.map(r => r.code), ['results-unreported'], 'conversation-unanswered cannot see it: #451 has a reply')
  assert.deepEqual(rs[0].refs, ['d1', 'd3'])
  assert.match(rs[0].text, /2 commissioned results have a fact the room has not heard from it since its last post \(tidy-p2 #452\): d1 → protoprey freework\/run-006: judged satisfied \(event 4\) after 1 correction request; d3 → lowerpoly freework\/run-006: judged satisfied \(event 4\) after 1 correction request\./)
  assert.match(rs[0].summary, /^d1, d3 not reported to the room since #452 → wfe conversation reply … first$/)
  // A post after them clears it (no loop); a progress note does not.
  const progress = room([{ id: 452, role: 'agent', run: RUN, kind: 'reply', at: '2026-10-26T20:35:28.978Z' }, { id: 453, role: 'agent', run: RUN, kind: 'progress', at: '2026-10-26T20:38:13.179Z' }])
  assert.deepEqual((await restReminders(progress, conductor(ds), RUN, 'ponder-w3')).map(r => r.code), ['results-unreported'])
  const spoke = room([{ id: 452, role: 'agent', run: RUN, kind: 'reply', at: '2026-10-26T20:35:28.978Z' }, { id: 453, role: 'agent', run: RUN, kind: 'reply', at: '2026-10-26T20:38:13.179Z' }])
  assert.deepEqual(await restReminders(spoke, conductor(ds), RUN, 'ponder-w3'), [])
  // Not at rest yet: nothing. A conductor with no delegations: nothing of this kind.
  const busy = { ...conductor(ds), nodes: { 'ponder-w3': { state: 'running' }, ask: { state: 'waiting' } } } as unknown as RunRecord
  assert.deepEqual(await restReminders(before453, busy, RUN, 'ponder-w3'), [])
  assert.deepEqual(await restReminders(before453, conductor({}), RUN, 'ponder-w3'), [])
  // Another run's post is not this run's account.
  const other = room([{ id: 452, role: 'agent', run: RUN, kind: 'reply', at: '2026-10-26T20:35:28.978Z' }, { id: 453, role: 'agent', run: 'lowerpoly/freework/run-004', kind: 'result', at: '2026-10-26T20:38:13.179Z' }])
  assert.deepEqual((await restReminders(other, conductor(ds), RUN, 'ponder-w3')).map(r => r.code), ['results-unreported'])
})

test('rest checks keep fix3\'s and tidy p1\'s: an unconcluded discussion of a run that ends; the person\'s unanswered words at rest', async () => {
  const ended = { nodes: { last: { state: 'running' } }, delegations: {} } as unknown as RunRecord
  assert.deepEqual((await restReminders(room([]), ended, RUN, 'last')).map(r => r.code), ['discussion-open'])
  const asked = room([{ id: 447, role: 'person', run: null, kind: 'message', at: '2026-10-26T20:06:00.000Z' }, { id: 448, role: 'agent', run: RUN, kind: 'progress', at: '2026-10-26T20:09:01.373Z' }])
  assert.deepEqual((await restReminders(asked, conductor(run048()), RUN, 'ponder-w3')).map(r => r.code), ['conversation-unanswered', 'results-unreported'], 'run-048 at its first rest: both')
})
