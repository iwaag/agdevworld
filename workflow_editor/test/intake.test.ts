// p6 step 1: the intake contract — routing by recorded identity, topic
// identity across renames, classification of posts, and the inbox stages.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canMove, classify, explicitQuestion, nextStage, noticeFor, realmId, referencedMessages, routeMessage, sourceReceipt, topicKind, validInbound,
  type ClassifyContext, type InboundMessage, type RequestBinding, type Route, type RunView,
} from '../shared/intake.ts'

const REALM = 'agstudio.local:8543'
const routes: Route[] = [
  { realm: REALM, streamId: 301, project: 'ppt', workflow: 'study', workspace: 'ppt' },
  { realm: REALM, streamId: 302, project: 'ppt', workflow: 'create', workspace: 'ppt' },
]
const PERSON = 8, OTHER = 9, BOT = 11
const msg = (o: Partial<InboundMessage> & { id: number }): InboundMessage => ({
  realm: REALM, streamId: 302, topic: 'request-deck', sender: { id: PERSON, name: 'iwaag', email: 'p@x', bot: false },
  content: 'make a deck', timestamp: 1_800_000_000, topicFirst: 100, ...o,
})
const binding = (o: Partial<RequestBinding> = {}): RequestBinding => ({
  key: 'r100', realm: REALM, streamId: 302, topic: 'request-deck', topicFirst: 100, origin: 100, project: 'ppt', workflow: 'create', workspace: 'ppt',
  run: { workflow: 'create', run: 'run-001' }, state: 'bound', ...o,
})
const ctx = (o: Partial<ClassifyContext> = {}): ClassifyContext => ({ requesters: new Set([PERSON]), binding: binding(), run: running(), ...o })
const running = (questions: RunView['questions'] = []): RunView => ({ execution: 'in-progress', cancelled: false, questions })

test('identity: realm from the URL, receipts per realm and message', () => {
  assert.equal(realmId('https://agstudio.local:8543'), REALM)
  assert.equal(realmId('https://chat.example.org/'), 'chat.example.org')
  assert.equal(sourceReceipt(REALM, 15912), 'zulip:agstudio.local:8543:15912')
  assert.notEqual(sourceReceipt(REALM, 1), sourceReceipt('other.example', 1))
  assert.match(sourceReceipt('a b/c', 5), /^[A-Za-z0-9:._/#-]+$/, 'fits the run receipt pattern')
  assert.throws(() => sourceReceipt(REALM, 0))
})

test('topics: request-…, run-… and anything else; a resolved topic keeps its kind', () => {
  assert.equal(topicKind('request-deck'), 'request')
  assert.equal(topicKind('✔ request-deck'), 'request')
  assert.equal(topicKind('run-001'), 'run')
  assert.equal(topicKind('request-'), 'other', 'a bare prefix names nothing')
  assert.equal(topicKind('requests'), 'other')
  assert.equal(topicKind('Request-deck'), 'other', 'the prefix is exact')
  assert.equal(topicKind('workplan-x'), 'other')
})

test('inbound shape: everything the rules need is required', () => {
  const ok = msg({ id: 101 })
  assert.deepEqual(validInbound(JSON.parse(JSON.stringify(ok))), ok)
  assert.throws(() => validInbound({ ...ok, topicFirst: undefined }), /topicFirst/)
  assert.throws(() => validInbound({ ...ok, sender: { ...ok.sender, bot: undefined } }), /bot/)
})

test('routing: only a configured channel of the realm, only request topics', () => {
  assert.deepEqual(routeMessage(msg({ id: 101, realm: 'elsewhere' }), routes, []), { kind: 'ignore', reason: 'other-realm' })
  assert.deepEqual(routeMessage(msg({ id: 101, streamId: 999 }), routes, []), { kind: 'ignore', reason: 'unrouted-channel' })
  assert.deepEqual(routeMessage(msg({ id: 101, topic: 'run-001' }), routes, []), { kind: 'ignore', reason: 'run-topic' })
  assert.deepEqual(routeMessage(msg({ id: 101, topic: 'chat' }), routes, []), { kind: 'ignore', reason: 'not-a-request-topic' })
  const r = routeMessage(msg({ id: 101 }), routes, [])
  assert.equal(r.kind, 'new')
  assert.deepEqual(r.kind === 'new' && r.route, routes[1], 'the channel id selects project and workflow')
  const study = routeMessage(msg({ id: 101, streamId: 301 }), routes, [])
  assert.equal(study.kind === 'new' && study.route.workflow, 'study')
})

test('routing: a bound topic by identity; a rename is followed; a reused name is a problem', () => {
  const b = binding()
  const bound = routeMessage(msg({ id: 120 }), routes, [b])
  assert.equal(bound.kind, 'bound')
  const renamed = routeMessage(msg({ id: 121, topic: '✔ request-deck' }), routes, [b])
  assert.equal(renamed.kind, 'renamed')
  assert.deepEqual(renamed.kind === 'renamed' && [renamed.from, renamed.to, renamed.binding.key], ['request-deck', '✔ request-deck', 'r100'])
  const renamedToOther = routeMessage(msg({ id: 122, topic: 'deck discussion' }), routes, [b])
  assert.equal(renamedToOther.kind, 'renamed', 'identity, not the prefix, decides once a topic is bound')
  // The old name reused by a new topic: not routed to r100 by its name.
  const reused = routeMessage(msg({ id: 130, topicFirst: 129 }), routes, [b])
  assert.equal(reused.kind, 'problem')
  assert.equal(reused.kind === 'problem' && reused.reason, 'topic-name-reused')
  // Moved into the other workflow's channel: no guess, a problem.
  const moved = routeMessage(msg({ id: 131, streamId: 301 }), routes, [b])
  assert.equal(moved.kind === 'problem' && moved.reason, 'moved-across-channels')
  // Moved out of every configured channel: still recognized and reported.
  const away = routeMessage(msg({ id: 132, streamId: 999 }), routes, [b])
  assert.equal(away.kind === 'problem' && away.reason, 'moved-across-channels')
  // A run topic is never input, bound or not.
  assert.equal(routeMessage(msg({ id: 133, topic: 'run-001', topicFirst: 200 }), routes, [b]).kind, 'ignore')
})

test('classification: bots and unauthorized senders change nothing; the first eligible post is the request', () => {
  assert.deepEqual(classify(msg({ id: 101, sender: { id: BOT, name: 'bot', email: 'b@x', bot: true } }), ctx({ binding: null, run: null })), { kind: 'ignored', reason: 'bot' })
  assert.deepEqual(classify(msg({ id: 101, sender: { id: OTHER, name: 'o', email: 'o@x', bot: false } }), ctx({ binding: null, run: null })), { kind: 'ignored', reason: 'unauthorized' })
  assert.deepEqual(classify(msg({ id: 101 }), ctx({ binding: null, run: null })), { kind: 'request' })
  // Even an authorized bot is a bot.
  assert.deepEqual(classify(msg({ id: 101, sender: { id: PERSON, name: 'p', email: 'p@x', bot: true } }), ctx()), { kind: 'ignored', reason: 'bot' })
})

test('classification: later posts wait for an earlier unsettled one and for the run to exist', () => {
  assert.equal(classify(msg({ id: 110 }), ctx({ earlierUnsettled: 105 })).kind, 'wait')
  assert.equal(classify(msg({ id: 110 }), ctx({ binding: binding({ state: 'opening', run: null }), run: null })).kind, 'wait')
  assert.deepEqual(classify(msg({ id: 110 }), ctx({ binding: binding({ state: 'refused', refused: 'workflow invalid' }), run: null })), { kind: 'closed', reason: 'refused' })
})

test('classification: an answer binds by reference, by explicit id, or to the one visible open question', () => {
  const qs = running([{ id: 'q1', state: 'open', posted: 200 }])
  const quote = (id: number) => `@_**autolab|11** [said](https://agstudio.local:8543/#narrow/channel/302-wf-ppt.2Ecreate/topic/request-deck/near/${id}):\n\`\`\`quote\nQuestion…\n\`\`\`\nyes, go ahead`
  assert.deepEqual(classify(msg({ id: 210, content: quote(200) }), ctx({ run: qs })), { kind: 'answer', question: 'q1', by: 'reference' })
  assert.deepEqual(classify(msg({ id: 210, content: 'q1: yes' }), ctx({ run: qs })), { kind: 'answer', question: 'q1', by: 'explicit' })
  assert.deepEqual(classify(msg({ id: 210, content: 'yes' }), ctx({ run: qs })), { kind: 'answer', question: 'q1', by: 'pending' })
  // A further answer to a question answered but not yet taken up is still an answer.
  assert.deepEqual(classify(msg({ id: 211, content: 'and use blue' }), ctx({ run: running([{ id: 'q1', state: 'answered', posted: 200 }]) })), { kind: 'answer', question: 'q1', by: 'pending' })
})

test('classification: a post written before the question was posted never answers it', () => {
  // The person wrote at 205; q2 was posted at 220 (the receiver was down, or delivery was late).
  const qs = running([{ id: 'q1', state: 'taken-up', posted: 200 }, { id: 'q2', state: 'open', posted: 220 }])
  assert.deepEqual(classify(msg({ id: 205, content: 'also add a title slide' }), ctx({ run: qs })), { kind: 'instruction' })
  // Not yet delivered at all: the same.
  const undelivered = running([{ id: 'q2', state: 'open', posted: null }])
  assert.deepEqual(classify(msg({ id: 205, content: 'ok' }), ctx({ run: undelivered })), { kind: 'instruction' })
  assert.deepEqual(classify(msg({ id: 205, content: 'q2: ok' }), ctx({ run: undelivered })), { kind: 'clarify', reason: 'not-yet-asked', questions: ['q2'] })
})

test('classification: ambiguous and stale replies approve nothing', () => {
  const two = running([{ id: 'q1', state: 'open', posted: 200 }, { id: 'q2', state: 'open', posted: 201 }])
  assert.deepEqual(classify(msg({ id: 210, content: 'yes' }), ctx({ run: two })), { kind: 'clarify', reason: 'ambiguous', questions: ['q1', 'q2'] })
  // A reply naming two questions.
  assert.deepEqual(classify(msg({ id: 210, content: `q1: yes [x](https://z/#narrow/channel/1-a/topic/b/near/201)` }), ctx({ run: two })).kind, 'clarify')
  // A reply to a question already taken up: late, recorded, applied nowhere — not moved to the newer q2.
  const later = running([{ id: 'q1', state: 'taken-up', posted: 200 }, { id: 'q2', state: 'open', posted: 230 }])
  assert.deepEqual(classify(msg({ id: 240, content: 'q1: actually no' }), ctx({ run: later })), { kind: 'late', question: 'q1', state: 'taken-up' })
  const withdrawn = running([{ id: 'q1', state: 'withdrawn', posted: 200 }])
  assert.deepEqual(classify(msg({ id: 240, content: `[q](https://z/#narrow/channel/302-a/topic/request-deck/near/200) no` }), ctx({ run: withdrawn })), { kind: 'late', question: 'q1', state: 'withdrawn' })
  assert.deepEqual(classify(msg({ id: 240, content: 'q9: yes' }), ctx({ run: later })), { kind: 'clarify', reason: 'unknown-question', questions: ['q9'] })
  // A quote of a post that carried no question is not a reference.
  assert.deepEqual(classify(msg({ id: 240, content: '[mine](https://z/#narrow/channel/302-a/topic/request-deck/near/150) as I said' }), ctx({ run: later })), { kind: 'answer', question: 'q2', by: 'pending' })
})

test('classification: input with no open question is an instruction; a finished request needs a new topic', () => {
  assert.deepEqual(classify(msg({ id: 250, content: 'please use a dark theme' }), ctx()), { kind: 'instruction' })
  assert.deepEqual(classify(msg({ id: 250 }), ctx({ run: { execution: 'stopped', cancelled: false, questions: [] } })), { kind: 'instruction' }, 'a stopped run is not over')
  assert.deepEqual(classify(msg({ id: 250 }), ctx({ run: { execution: 'completed', cancelled: false, questions: [] } })), { kind: 'closed', reason: 'completed' })
  assert.deepEqual(classify(msg({ id: 250 }), ctx({ run: { execution: 'cancelled', cancelled: true, questions: [] } })), { kind: 'closed', reason: 'cancelled' })
  assert.equal(noticeFor({ kind: 'closed', reason: 'completed' }), 'closed')
  assert.equal(noticeFor({ kind: 'instruction' }), null)
})

test('references: quote-and-reply and message links; explicit ids only at the start of the own words', () => {
  assert.deepEqual(referencedMessages('[said](https://h/#narrow/channel/274-a.2Eb/topic/run-002/near/15911): x'), [15911])
  assert.deepEqual(referencedMessages('https://h/#narrow/channel/1-a/topic/b/with/77 and /near/5'), [77])
  assert.deepEqual(referencedMessages('no links'), [])
  assert.equal(explicitQuestion('q3: yes'), 'q3')
  assert.equal(explicitQuestion('Q3 ok'), 'q3')
  assert.equal(explicitQuestion('q3'), 'q3')
  assert.equal(explicitQuestion('re q3: yes'), null)
  assert.equal(explicitQuestion('q3x yes'), null)
  assert.equal(explicitQuestion('@_**autolab|11** [said](https://h/#narrow/x/near/1):\n```quote\nq1: what?\n```\nq2: yes'), 'q2')
})

test('inbox stages: each transition is explicit, retries resume at the failed stage', () => {
  assert.ok(canMove('received', 'classified'))
  assert.ok(!canMove('received', 'applied'), 'nothing is applied before its classification is stored')
  assert.ok(canMove('classified', 'done'))
  assert.ok(canMove('failed', 'applied'))
  assert.ok(!canMove('done', 'received'), 'a settled post is never processed again')
  assert.equal(nextStage('received', null), 'classified')
  assert.equal(nextStage('classified', { kind: 'answer', question: 'q1', by: 'pending' }), 'applied')
  assert.equal(nextStage('classified', { kind: 'late', question: 'q1', state: 'taken-up' }), 'done')
  assert.equal(nextStage('classified', { kind: 'ignored', reason: 'bot' }), 'done')
  assert.equal(nextStage('applied', { kind: 'instruction' }), 'done')
})
