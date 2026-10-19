// slack_connect p1: the transport's guarantees against a fake Slack and a
// fake WFE — one WFE message (and so one Front turn) per Slack message
// whatever route or retry brought it; replies in the thread of their
// conversation; nothing echoed back; unknown sends reconciled before any
// resend; missed input recovered from history; queued output survives a
// restart.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge, sameText, type SlackEvent } from '../src/bridge.ts'
import type { Config } from '../src/config.ts'
import { chunk } from '../src/format.ts'
import { SlackCallError, type SlackApi, type SlackMessage } from '../src/slack.ts'
import { Store } from '../src/store.ts'
import { WfeError, type WfeApi, type WfeMessage, type WfePosted, type WfeView } from '../src/wfe.ts'

const TEAM = 'T0TEAM01', DEV = 'U0DEV0001', BOT = 'U0BOT0001', DM = 'D0DM00001'

class FakeSlack implements SlackApi {
  msgs: (SlackMessage & { channel: string })[] = []
  clock = 1_800_000_000
  lose = 0 // posts that happen but whose answer is lost
  drop = 0 // posts that fail without happening, with no answer
  unreadable = false
  posts = 0
  reactions: string[] = []
  nextTs() { return `${++this.clock}.000100` }
  async identity() { return { team: TEAM, botUser: BOT, botId: 'B0BOT' } }
  async openDm() { return DM }
  human(text: string, thread?: string): SlackEvent {
    const m = { ts: this.nextTs(), user: DEV, text, ...(thread ? { thread_ts: thread } : {}), channel: DM }
    this.msgs.push(m)
    return { ...m, type: 'message', channel_type: 'im' }
  }
  async post(o: { channel: string; thread: string; text: string; key: string | null }) {
    if (this.drop > 0) { this.drop--; throw new SlackCallError('timeout', 'unknown') }
    const m = { ts: this.nextTs(), user: BOT, bot_id: 'B0BOT', text: o.text, channel: o.channel, ...(o.thread ? { thread_ts: o.thread } : {}), ...(o.key ? { metadata: { event_type: 'agdev_delivery', event_payload: { key: o.key } } } : {}) }
    this.msgs.push(m); this.posts++
    if (this.lose > 0) { this.lose--; throw new SlackCallError('timeout', 'unknown') }
    return { ts: m.ts }
  }
  async react(_c: string, ts: string, name: string) { this.reactions.push(`${ts}:${name}`) }
  async history(channel: string, oldest: string) { if (this.unreadable) throw new SlackCallError('down', 'unknown'); return this.msgs.filter(m => m.channel === channel && (!m.thread_ts || m.thread_ts === m.ts) && m.ts >= oldest) }
  async replies(channel: string, root: string, oldest: string) {
    if (this.unreadable) throw new SlackCallError('down', 'unknown')
    return this.msgs.filter(m => m.channel === channel && (m.ts === root || m.thread_ts === root) && (m.ts === root || m.ts >= oldest))
  }
  thread(root: string) { return this.msgs.filter(m => m.thread_ts === root && m.user === BOT).map(m => m.text ?? '') }
}

class FakeWfe implements WfeApi {
  convs = new Map<string, WfeMessage[]>()
  tokens = new Map<string, WfeMessage>()
  turns = 0
  down = false
  loseAnswer = 0 // the post is stored but the answer never arrives
  id = 0
  async view(conv: string, since: number): Promise<WfeView | null> {
    if (this.down) throw new WfeError('WFE unreachable', null)
    const ms = this.convs.get(conv)
    if (!ms) return null
    return { person: 'iwaag', conversation: { id: conv, title: '', state: 'open', updated: '' }, messages: ms.filter(m => m.id > since), runs: [], asking: [] }
  }
  async post(conv: string, b: { text: string; token: string; via: string; author?: string }): Promise<WfePosted> {
    if (this.down) throw new WfeError('WFE unreachable', null)
    const seen = this.tokens.get(`${conv}/${b.token}`)
    if (seen) return { sent: true, duplicate: true, reopened: false, message: seen, run: seen.dispatch!.run }
    this.turns++
    const m: WfeMessage = { id: ++this.id, role: 'person', author: b.author ?? 'iwaag', text: b.text, at: '', via: b.via, re: [], kind: 'message', run: null, runUrl: null, question: null, dispatch: { state: 'started', run: `front/converse/run-${this.turns}`, error: null } }
    this.tokens.set(`${conv}/${b.token}`, m)
    this.convs.set(conv, [...(this.convs.get(conv) ?? []), m])
    if (this.loseAnswer > 0) { this.loseAnswer--; throw new WfeError('WFE unreachable: socket hang up', null) }
    return { sent: true, duplicate: false, reopened: false, message: m, run: m.dispatch!.run }
  }
  add(conv: string, m: Partial<WfeMessage>) {
    const full: WfeMessage = { id: ++this.id, role: 'agent', author: 'front-agent', text: '', at: '', via: null, re: [], kind: 'reply', run: 'front/converse/run-1', runUrl: null, question: null, dispatch: null, ...m }
    this.convs.get(conv)!.push(full)
    return full
  }
}

const config = (store: string): Config => ({
  appToken: 'xapp-x', botToken: 'xoxb-x', developer: DEV, team: null, wfe: 'http://wfe.invalid/', linkBase: 'http://phone.invalid:8093/wfe/',
  linkMap: { 'http://lan.invalid:8093': 'http://phone.invalid:8093' }, deskUrl: 'http://phone.invalid:8093/?view=frontdesk', trialAuthor: 'Omni Agent (for Developer)', store,
})

async function setup(file = ':memory:', slack = new FakeSlack(), wfe = new FakeWfe()) {
  const store = new Store(file)
  const bridge = new Bridge({ config: config(file), store, slack, wfe, log: () => {}, sleep: async () => {} })
  await bridge.identify()
  return { store, bridge, slack, wfe }
}
const envelope = (ev: SlackEvent, id: string) => ({ team_id: TEAM, event_id: id, event: ev })
const settle = (s: Store) => s.run('UPDATE outbox SET attempted = attempted - 60000')
const due = (s: Store) => s.run('UPDATE threads SET next_poll = 0')
const convOf = (s: Store, root: string) => s.thread(TEAM, DM, root)!.conv

test('a root and its thread are one conversation; a redelivered event, a backfilled copy and a lost WFE answer are each one message and one turn', async () => {
  const { store, bridge, slack, wfe } = await setup()
  const root = slack.human('ロゴを作って')
  assert.equal(bridge.receiveEnvelope(envelope(root, 'Ev1')), 'new')
  assert.equal(bridge.receiveEnvelope(envelope(root, 'Ev1'), 1), 'seen-event')
  await bridge.tick()
  const reply = slack.human('青で', root.ts)
  wfe.loseAnswer = 1
  bridge.receiveEnvelope(envelope(reply, 'Ev2'))
  await bridge.tick()
  assert.equal(store.nextInbox()?.source, `${TEAM}:${DM}:${reply.ts}`, 'kept for retry after the lost answer')
  store.run('UPDATE inbox SET next_try = 0')
  await bridge.tick()
  store.set('live:last', String(Date.now()))
  await bridge.backfill('test', Date.now() - 3_600_000)
  await bridge.tick()
  const conv = convOf(store, root.ts)
  assert.deepEqual(wfe.convs.get(conv)!.map(m => [m.text, m.via]), [['ロゴを作って', 'slack'], ['青で', 'slack']])
  assert.equal(wfe.turns, 2)
  assert.deepEqual(slack.reactions.sort(), [`${reply.ts}:inbox_tray`, `${root.ts}:inbox_tray`].sort())
})

test('concurrent threads get their own replies; Front Desk words are mirrored once, Slack words never; queued output survives a restart', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'slack-front-')), 'store.sqlite')
  let { store, bridge, slack, wfe } = await setup(file)
  const a = slack.human('A をして'), b = slack.human('B をして')
  bridge.receiveEnvelope(envelope(a, 'EvA')); bridge.receiveEnvelope(envelope(b, 'EvB'))
  await bridge.tick()
  const ca = convOf(store, a.ts), cb = convOf(store, b.ts)
  wfe.add(cb, { text: 'B は **完了**。詳細: http://lan.invalid:8093/wfe/api/projects/p/raw?path=x', kind: 'result', run: 'front/converse/run-2' })
  wfe.add(ca, { role: 'person', author: 'iwaag', text: 'A は急ぎで', kind: 'message', run: null, via: null })
  wfe.add(ca, { text: 'どの色にしますか?', kind: 'question', run: 'front/converse/run-1' })
  due(store)
  await bridge.pollDue()
  store.close()
  ;({ store, bridge } = await setup(file, slack, wfe))
  await bridge.tick()
  const ta = slack.thread(a.ts), tb = slack.thread(b.ts)
  assert.equal(ta.length, 2)
  assert.match(ta[0], /^🖥 \*iwaag\*（Front Desk から）\nA は急ぎで$/)
  assert.match(ta[1], /^❓ \*質問\* · <http:\/\/phone\.invalid:8093\/wfe\/#\/ws\/front\/run\/converse\/run-1\|front\/converse\/run-1>/)
  assert.equal(tb.length, 1)
  assert.match(tb[0], /^✅ \*結果\*.*\nB は \*完了\*。詳細: <http:\/\/phone\.invalid:8093\/wfe\/api\/projects\/p\/raw\?path=x>/s)
  due(store)
  await bridge.tick()
  assert.equal(slack.thread(a.ts).length + slack.thread(b.ts).length, 3, 'nothing posted twice, the Slack messages not echoed')
  store.close()
})

test('bots, other people, edits, deletions and attachments start no turn; each is told what happened', async () => {
  const { store, bridge, slack, wfe } = await setup()
  const root = slack.human('はじめ')
  bridge.receiveEnvelope(envelope(root, 'E1'))
  const events: SlackEvent[] = [
    { type: 'message', channel: DM, channel_type: 'im', ts: slack.nextTs(), user: BOT, bot_id: 'B0BOT', text: 'echo', thread_ts: root.ts },
    { type: 'message', channel: DM, channel_type: 'im', ts: slack.nextTs(), user: 'U0OTHER01', text: 'hi' },
    { type: 'message', subtype: 'message_changed', channel: DM, channel_type: 'im', ts: slack.nextTs(), message: { ts: root.ts, user: DEV, text: 'はじめ!', edited: { ts: '1' } }, previous_message: { ts: root.ts, user: DEV, text: 'はじめ' } },
    { type: 'message', subtype: 'message_changed', channel: DM, channel_type: 'im', ts: slack.nextTs(), message: { ts: root.ts, user: DEV, text: 'はじめ', reply_count: 1 }, previous_message: { ts: root.ts, user: DEV, text: 'はじめ' } },
    { type: 'message', subtype: 'message_deleted', channel: DM, channel_type: 'im', ts: slack.nextTs(), deleted_ts: root.ts, previous_message: { ts: root.ts, user: DEV, text: 'はじめ' } },
    { type: 'message', subtype: 'file_share', channel: DM, channel_type: 'im', ts: slack.nextTs(), user: DEV, text: '', files: [{ name: 'voice.m4a' }], thread_ts: root.ts },
    { type: 'message', subtype: 'file_share', channel: DM, channel_type: 'im', ts: slack.nextTs(), user: DEV, text: 'この画像を見て', files: [{ name: 'a.png' }], thread_ts: root.ts },
  ]
  events.forEach((e, i) => bridge.receiveEnvelope(envelope(e, `E${i + 2}`)))
  await bridge.tick()
  const conv = convOf(store, root.ts)
  assert.deepEqual(wfe.convs.get(conv)!.map(m => m.text), ['はじめ', 'この画像を見て\n\n[Slack: 1 attachment(s) not passed on (a.png); Front has not seen them.]'])
  assert.equal(wfe.turns, 2)
  const notices = slack.msgs.filter(m => m.user === BOT).map(m => (m.text ?? '').slice(0, 2))
  assert.deepEqual(notices.sort(), ['この', '✏️', '🗑', '📎'].sort(), 'stranger, edit, delete and the attachment-only message are explained; the caption is passed on')
})

test('an unknown send is found in the thread rather than resent; one that never happened is sent once more; an unreadable thread stays unknown and visible', async () => {
  const { store, bridge, slack, wfe } = await setup()
  const root = slack.human('x')
  bridge.receiveEnvelope(envelope(root, 'E1'))
  await bridge.tick()
  const conv = convOf(store, root.ts)
  wfe.add(conv, { text: 'one' })
  slack.lose = 1
  due(store)
  await bridge.tick()
  assert.equal(store.outs(['unknown']).length, 1)
  wfe.add(conv, { text: 'two' })
  due(store)
  await bridge.tick()
  assert.deepEqual(slack.thread(root.ts), ['💬 *返答* · <http://phone.invalid:8093/wfe/#/ws/front/run/converse/run-1|front/converse/run-1>\none'], 'two waits behind the unknown one')
  settle(store)
  await bridge.tick()
  assert.deepEqual(slack.thread(root.ts).map(t => t.split('\n')[1]), ['one', 'two'], 'reconciled as sent, not resent')

  wfe.add(conv, { text: 'three' })
  slack.drop = 1
  due(store)
  await bridge.tick()
  settle(store)
  slack.unreadable = true
  await bridge.tick()
  assert.equal(store.outs(['unknown']).length, 1, 'unreadable history: still unknown')
  slack.unreadable = false
  await bridge.tick()
  assert.deepEqual(slack.thread(root.ts).map(t => t.split('\n')[1]), ['one', 'two', 'three'], 'absent from the thread: sent once more')
  assert.equal(store.outs(['unknown', 'failed', 'queued']).length, 0)
})

test('messages missed while disconnected are recovered from history in Slack order; WFE being down keeps them with one notice', async () => {
  const { store, bridge, slack, wfe } = await setup()
  const root = slack.human('first')
  bridge.receiveEnvelope(envelope(root, 'E1'))
  await bridge.tick()
  store.set('live:last', String(Date.now()))
  // Disconnected: a reply in the mapped thread and a new root arrive unseen.
  slack.human('reply while away', root.ts)
  const late = slack.human('new while away')
  wfe.down = true
  const r = await bridge.backfill('reconnected')
  assert.equal(r.added, 2)
  await bridge.tick()
  assert.equal(slack.msgs.filter(m => m.user === BOT && (m.text ?? '').startsWith('⏳')).length, 1, 'one notice while WFE is down')
  wfe.down = false
  store.run('UPDATE inbox SET next_try = 0')
  await bridge.tick()
  assert.deepEqual(wfe.convs.get(convOf(store, root.ts))!.map(m => m.text), ['first', 'reply while away'])
  assert.deepEqual(wfe.convs.get(convOf(store, late.ts))!.map(m => m.text), ['new while away'])
  bridge.receiveEnvelope(envelope({ ...late, type: 'message', channel_type: 'im' }, 'E-late'))
  await bridge.tick()
  assert.equal(wfe.turns, 3, 'the late-delivered event is the same message')
})

test('a long answer is cut the same way every time, and a code fence never spans two parts open', () => {
  const text = `intro\n\n\`\`\`\n${'line of code\n'.repeat(600)}\`\`\`\n\n${'tail paragraph. '.repeat(300)}`
  const parts = chunk(text, 3500)
  assert.deepEqual(chunk(text, 3500), parts)
  assert.ok(parts.length > 2)
  for (const p of parts) {
    assert.ok(p.length <= 3500)
    assert.equal((p.match(/^```/gm) ?? []).length % 2, 0, 'every part has balanced fences')
  }
})

test('a stored post is recognised by its text although Slack rewrote its emoji and escapes', () => {
  assert.ok(sameText(':white_check_mark: *結果* · <http://h/?view=frontdesk&amp;conv=1|desk>', '✅ *結果* · <http://h/?view=frontdesk&conv=1|desk>'))
  assert.ok(!sameText(':white_check_mark: *結果* one', '✅ *結果* two'))
})
