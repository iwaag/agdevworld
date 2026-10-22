// The bridge between the Developer's Slack DM with the bot and WFE's
// conversations (README.md). Everything that arrives is stored before it is
// acknowledged; one loop then carries the inbox to WFE, WFE's new messages to
// the outbox, and the outbox to Slack. Each step records its result before
// the next, so a restart continues where it stopped and nothing starts twice.
import type { Config } from './config.ts'
import { chunk, markdownToMrkdwn, plainForSlack, slackToPlain } from './format.ts'
import { SlackCallError, type SlackApi, type SlackMessage } from './slack.ts'
import type { InboxRow, OutRow, Store, ThreadRow } from './store.ts'
import { WfeError, type WfeApi, type WfeMessage, type WfeView } from './wfe.ts'

const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR
const OVERLAP = 5 * MINUTE // backfill re-reads this much before the last live moment
const SWEEP_EVERY = 15 * MINUTE // a backfill while connected, for events Slack never delivered
const SETTLE = 15 * SECOND // an unknown send is looked for after this
const UNKNOWN_BLOCKS = 10 * MINUTE // later posts in its thread wait this long for reconciliation
const MAX_SENDS = 3 // sends of one row (a resend only after it was found absent)
const MAX_CHECKS = 20 // reconciliation attempts before an unknown row is left to the operator
const RETENTION = 90 * DAY // the free plan hides older history
const ACTIVE = new Set(['executing', 'stopping', 'not-started', 'due'])
export const RECEIVED_REACTION = 'inbox_tray'

export type Classified =
  | { action: 'ignore'; reason: string }
  | { action: 'accept'; text: string; attachments: string[] }
  | { action: 'notice'; notice: 'edit' | 'delete' | 'unsupported' | 'stranger'; target: string; top?: boolean }
  | { action: 'command'; command: 'status' | 'help' }

export interface SlackEvent extends SlackMessage {
  type?: string; channel?: string; channel_type?: string; event_ts?: string; deleted_ts?: string
  message?: SlackMessage; previous_message?: SlackMessage
}
export interface Who { team: string; developer: string; botUser: string; botId: string | null }

const HUMAN_SUBTYPES = new Set([undefined, 'file_share', 'thread_broadcast', 'me_message'])
const rootOf = (m: SlackMessage) => m.thread_ts ?? m.ts
// Slack stores a post with emoji as :shortcodes: and & escaped (seen live,
// slack_connect p1 step 3): texts are compared without either.
const bare = (t: string) => t.replace(/:[a-z0-9_+-]+:/g, '').replace(/\p{Extended_Pictographic}\uFE0F?/gu, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
export const sameText = (stored: string, sent: string) => bare(stored) === bare(sent)

// What a DM event is to the integration. Only the configured Developer's
// own words in the configured workspace become WFE input; bots (this one
// included) never do; edits and deletions are explained, never applied.
export function classify(ev: SlackEvent, team: string | null, who: Who): Classified {
  if (ev.type !== 'message') return { action: 'ignore', reason: `event ${ev.type}` }
  if (ev.channel_type && ev.channel_type !== 'im') return { action: 'ignore', reason: `not a DM (${ev.channel_type})` }
  if (team && team !== who.team) return { action: 'ignore', reason: `another workspace (${team})` }
  if (ev.subtype === 'message_changed') {
    const m = ev.message, before = ev.previous_message
    // A deleted root that has replies stays as a tombstone (seen live, slack_connect p1 step 3).
    if (m?.subtype === 'tombstone') {
      if (!before || before.user !== who.developer || before.bot_id) return { action: 'ignore', reason: 'a deletion of a message not the Developer\'s' }
      return { action: 'notice', notice: 'delete', target: rootOf(before) }
    }
    if (!m || m.user !== who.developer || m.bot_id) return { action: 'ignore', reason: 'a change to a message not the Developer\'s' }
    if (!m.edited || (before && before.text === m.text)) return { action: 'ignore', reason: 'not an edit of the text (thread or unfurl update)' }
    return { action: 'notice', notice: 'edit', target: rootOf(m) }
  }
  if (ev.subtype === 'message_deleted') {
    const m = ev.previous_message
    if (!m || m.user !== who.developer || m.bot_id) return { action: 'ignore', reason: 'a deletion of a message not the Developer\'s' }
    const root = rootOf(m)
    return { action: 'notice', notice: 'delete', target: root, top: root === m.ts }
  }
  if (ev.bot_id || ev.user === who.botUser || ev.subtype === 'bot_message') return { action: 'ignore', reason: 'a bot\'s message' }
  if (!HUMAN_SUBTYPES.has(ev.subtype)) return { action: 'ignore', reason: `subtype ${ev.subtype}` }
  if (!ev.user) return { action: 'ignore', reason: 'no user' }
  if (ev.user !== who.developer) return { action: 'notice', notice: 'stranger', target: rootOf(ev) }
  const text = slackToPlain(ev.text ?? '').trim()
  const attachments = (ev.files ?? []).map(f => f.name || f.title || f.filetype || f.mimetype || 'file')
  if (text === '!status' || text === '!help') return { action: 'command', command: text.slice(1) as 'status' | 'help' }
  if (!text) return attachments.length ? { action: 'notice', notice: 'unsupported', target: rootOf(ev) } : { action: 'ignore', reason: 'empty' }
  return { action: 'accept', text, attachments }
}

// The inbox row of a Slack message, whichever route brought it.
export function inboxKey(team: string, ev: SlackEvent): { source: string; ts: string; thread: string | null } {
  const ch = ev.channel ?? ''
  if (ev.subtype === 'message_changed' && ev.message) return { source: `edit:${team}:${ch}:${ev.message.ts}:${ev.message.edited?.ts ?? ev.ts}`, ts: ev.ts, thread: rootOf(ev.message) }
  if (ev.subtype === 'message_deleted') return { source: `delete:${team}:${ch}:${ev.deleted_ts ?? ev.ts}`, ts: ev.ts, thread: ev.previous_message ? rootOf(ev.previous_message) : null }
  return { source: `${team}:${ch}:${ev.ts}`, ts: ev.ts, thread: ev.thread_ts ?? null }
}

// A conversation id for a Slack root: its local time and microseconds, so
// a retry after a crash names the same conversation.
export function conversationId(root: string): string {
  const [sec, frac = '0'] = root.split('.')
  const d = new Date(Number(sec) * 1000)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}-s${frac.padEnd(6, '0').slice(0, 6)}`
}

const NOTICES = {
  edit: '✏️ 編集は Front に伝わりません。最初の内容で受け付け済みです。訂正は新しいメッセージで送ってください。',
  delete: '🗑 削除しても、受け付け済みの依頼は取り消されません。取り消しや変更は新しいメッセージで伝えてください。',
  unsupported: '📎 添付ファイルや音声クリップは Front に渡せません（テキストのみ対応）。内容をテキストで送ってください（iPhone はキーボードの音声入力が使えます）。',
  stranger: 'この Front は設定された 1 人の開発者専用です。このメッセージは転送していません。',
}
const KIND_LABEL: Record<string, string> = { reply: '💬 *返答*', question: '❓ *質問*', progress: '⏳ *進捗*', result: '✅ *結果*' }

export const HELP = [
  '*Front（Slack）の使い方*',
  '• DM に新しく書くと新しい会話、スレッドに返信するとその会話の続きです（質問への回答・追加指示もスレッドで）。',
  '• 📥 は受け付け（WFE に記録され Front のターン開始を依頼済み）。Front の返答は同じスレッドに届きます。',
  '• 編集・削除は Front に伝わりません。訂正や取り消しは新しいメッセージで。添付ファイル・音声クリップは未対応です（キーボードの音声入力は使えます）。',
  '• run・成果物・aghangout のリンクは Tailscale 接続時に開けます。テキストのやりとりは VPN なしで使えます。',
  '• `!status` で中継の状態を表示します。',
].join('\n')

export interface BridgeDeps { config: Config; store: Store; slack: SlackApi; wfe: WfeApi; log?: (line: string) => void; sleep?: (ms: number) => Promise<void> }

export class Bridge {
  readonly config: Config; readonly store: Store; readonly slack: SlackApi; readonly wfe: WfeApi
  readonly log: (line: string) => void
  private sleep: (ms: number) => Promise<void>
  who: Who | null = null
  private lastPost = new Map<string, number>()
  private running = false
  private again = false

  constructor(d: BridgeDeps) {
    this.config = d.config; this.store = d.store; this.slack = d.slack; this.wfe = d.wfe
    this.log = d.log ?? (line => console.log(`${new Date().toISOString()} ${line}`))
    this.sleep = d.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  }

  // The bot's identity and the configured workspace, checked against each other.
  async identify(): Promise<Who> {
    const id = await this.slack.identity()
    if (this.config.team && this.config.team !== id.team) throw new Error(`the bot token is for workspace ${id.team}, the configuration names ${this.config.team}`)
    this.who = { team: id.team, developer: this.config.developer, botUser: id.botUser, botId: id.botId }
    this.store.set('slack:team', id.team)
    this.store.set('slack:bot', id.botUser)
    const resumed = this.store.interruptedSends()
    if (resumed) this.log(`${resumed} send(s) interrupted by the last stop are now unknown and will be reconciled`)
    return this.who
  }
  private get me(): Who { if (!this.who) throw new Error('identify() first'); return this.who }

  async dm(): Promise<string> {
    const known = this.store.get('slack:dm')
    if (known) return known
    const ch = await this.slack.openDm(this.config.developer)
    this.store.set('slack:dm', ch)
    return ch
  }

  // ---- receiving ------------------------------------------------------------

  // An Events API envelope, stored before it is acknowledged (the caller acks
  // after this returns; a throw leaves it unacknowledged for Slack to retry).
  receiveEnvelope(body: { team_id?: string; event_id?: string; event?: SlackEvent }, retryNum?: number | null): string {
    const ev = body.event
    if (!ev || ev.type !== 'message' || !ev.channel) return 'not a message event'
    const team = body.team_id ?? this.me.team
    const k = inboxKey(team, ev)
    const r = this.store.receive({ ...k, event_id: body.event_id ?? null, retry_num: retryNum ?? null, team, channel: ev.channel, user: ev.user ?? ev.message?.user ?? null, origin: 'event', raw: { team, event: ev } })
    this.store.set('live:last', String(Date.now()))
    return r
  }

  // ---- inbox → WFE ------------------------------------------------------------

  async processInbox() {
    for (;;) {
      const row = this.store.nextInbox()
      if (!row || row.next_try > Date.now()) return
      await this.handle(row)
    }
  }

  private async handle(row: InboxRow) {
    const raw = JSON.parse(row.raw) as { team: string; event?: SlackEvent; trial?: { text: string } }
    const c: Classified = raw.trial ? { action: 'accept', text: raw.trial.text, attachments: [] } : classify(raw.event!, raw.team, this.me)
    const notice = (kind: string, text: string, thread: string) => this.store.enqueue({ key: `notice:${kind}:${row.source}`, channel: row.channel, thread, text, label: 'notice' })
    switch (c.action) {
      case 'ignore': this.store.settle(row.id, 'ignored', { outcome: c.reason }); return
      case 'notice':
        this.store.tx(() => { notice(c.notice, NOTICES[c.notice], c.top ? '' : c.target); this.store.settle(row.id, 'done', { outcome: `notice: ${c.notice}` }) })
        return
      case 'command':
        this.store.tx(() => { notice(c.command, c.command === 'help' ? HELP : this.statusText(), row.thread ?? row.ts); this.store.settle(row.id, 'done', { outcome: `command: ${c.command}` }) })
        return
    }
    const root = row.thread ?? row.ts
    const conv = this.store.thread(row.team, row.channel, root)?.conv ?? conversationId(root)
    const note = c.attachments.length ? `\n\n[Slack: ${c.attachments.length} attachment(s) not passed on (${c.attachments.join(', ')}); Front has not seen them.]` : ''
    const trial = !!raw.trial
    let posted
    try {
      posted = await this.wfe.post(conv, {
        text: c.text + note, token: `${trial ? 'slack-trial' : 'slack'}:${row.team}:${row.channel}:${row.ts}`,
        via: trial ? 'slack-trial' : 'slack', with: this.config.with, ...(trial ? { author: this.config.trialAuthor } : {}),
      })
    } catch (e) {
      const msg = (e as Error).message
      if (e instanceof WfeError && e.permanent) {
        this.store.tx(() => { notice('wfe-refused', `⚠️ WFE に渡せませんでした（${plainForSlack(msg)}）。この内容は記録されていません。`, root); this.store.settle(row.id, 'failed', { error: msg, conv }) })
        this.log(`inbox ${row.source}: WFE refused — ${msg}`)
        return
      }
      if (row.tries === 0) notice('wfe-wait', '⏳ WFE に接続できません。メッセージは保持しており、復旧後に自動で渡します。', root)
      this.store.retryLater(row.id, msg, Math.min(5 * SECOND * 2 ** row.tries, 5 * MINUTE))
      this.store.set('wfe:error', `${new Date().toISOString()} ${msg}`)
      this.log(`inbox ${row.source}: WFE unavailable, retrying — ${msg}`)
      return
    }
    this.store.set('wfe:error', null)
    this.store.tx(() => {
      this.store.addThread(row.team, row.channel, root, conv)
      this.store.mapPost(conv, posted.message.id, row.channel, row.ts, 'slack')
      this.store.settle(row.id, 'done', { outcome: posted.duplicate ? 'accepted (already in WFE)' : 'accepted', conv, wfe_message: posted.message.id })
      this.store.touch(conv)
      this.store.enqueue({ key: `react:${row.channel}:${row.ts}`, kind: 'reaction', channel: row.channel, thread: row.ts, text: RECEIVED_REACTION })
      const failed = posted.requests.filter(r => r.state === 'failed')
      if (failed.length) notice('turn-failed', `⚠️ WFE は受け取りましたが、${failed.map(r => r.participant).join('、')} の作業を開始できませんでした（${plainForSlack(failed[0]!.error ?? '')}）。WFE 側で再試行されます。`, root)
      if (posted.reopened) notice('reopened', '↩ 閉じていた会話を再開しました（閉じても run は止まっていません）。', root)
    })
    this.log(`inbox ${row.source} → ${conv} #${posted.message.id}${posted.duplicate ? ' (duplicate)' : ''}; ${posted.requests.map(r => `${r.participant} ${r.state}${r.run ? ` ${r.run}` : ''}`).join(', ') || 'no request'}`)
  }

  // ---- WFE → outbox -------------------------------------------------------------

  async pollDue() {
    for (const t of this.store.all<ThreadRow>('SELECT * FROM threads WHERE next_poll <= ? ORDER BY next_poll', Date.now())) await this.poll(t)
  }

  async poll(t: ThreadRow) {
    let v: WfeView | null
    try { v = await this.wfe.view(t.conv, t.cursor) } catch (e) {
      const wait = Math.min(5 * SECOND * 2 ** t.poll_failures, 5 * MINUTE)
      this.store.run('UPDATE threads SET poll_failures = poll_failures + 1, poll_error = ?, next_poll = ? WHERE conv = ?', (e as Error).message, Date.now() + wait, t.conv)
      return
    }
    if (!v) { this.store.run('UPDATE threads SET next_poll = ?, poll_error = ? WHERE conv = ?', Date.now() + 30 * SECOND, 'not in WFE yet', t.conv); return }
    const fresh = v.messages.filter(m => m.id > t.cursor)
    const outs = this.render(t, v, fresh)
    const active = v.runs.some(r => ACTIVE.has(r.situation)) || Date.now() - Date.parse(t.activity) < 30 * MINUTE || fresh.length > 0
    const next = Date.now() + (active ? 5 * SECOND : Date.now() - Date.parse(t.activity) < DAY ? 30 * SECOND : 5 * MINUTE)
    this.store.tx(() => {
      for (const o of outs) {
        // A newer message of the same run makes its queued progress stale.
        if (o.run) this.store.run('UPDATE outbox SET state = \'coalesced\', updated = ? WHERE conv = ? AND run = ? AND label = \'progress\' AND state = \'queued\'', new Date().toISOString(), t.conv, o.run)
        this.store.enqueue(o)
      }
      const cursor = Math.max(t.cursor, ...fresh.map(m => m.id))
      this.store.run('UPDATE threads SET cursor = ?, poll_failures = 0, poll_error = NULL, next_poll = ? WHERE conv = ?', cursor, next, t.conv)
      if (outs.length) this.store.run('UPDATE threads SET activity = ? WHERE conv = ?', new Date().toISOString(), t.conv)
    })
  }

  // WFE messages as Slack posts: the destination's replies labelled by kind
  // with their run, the person's words from a page (aghangout) attributed as
  // such; the integration's own Slack posts are not sent back.
  render(t: ThreadRow, v: WfeView, fresh: WfeMessage[]) {
    const out: Parameters<Store['enqueue']>[0][] = []
    const desk = this.config.conversationUrl ? `<${this.config.conversationUrl.replace('{conv}', encodeURIComponent(t.conv)).replace(/&/g, '&amp;')}|aghangout で会話全体を見る>` : ''
    fresh.forEach((m, i) => {
      if (m.role === 'person') {
        if (m.via?.startsWith('slack') || this.store.one('SELECT 1 FROM posts WHERE conv = ? AND wfe_message = ? AND origin = \'slack\'', t.conv, m.id)) return
        const who = `*${plainForSlack(m.author)}*${m.author === v.person ? '' : '（開発者本人ではありません）'}`
        const text = `🖥 ${who}（${m.via ? plainForSlack(m.via) : 'aghangout'} から）\n${plainForSlack(m.text)}`
        this.parts(text, '').forEach((p, n, all) => out.push({ key: `wfe:${t.conv}:${m.id}:${n + 1}`, conv: t.conv, wfe_message: m.id, label: 'mirror', part: n + 1, parts: all.length, channel: t.channel, thread: t.root, text: p }))
        return
      }
      // A progress update followed by a newer message of its run is stale.
      if (m.kind === 'progress' && fresh.slice(i + 1).some(x => x.run === m.run)) return
      const run = m.run ? this.runLink(m.run) : null
      // A reply with no run is not a Front turn's: its author is named.
      const head = `${KIND_LABEL[m.kind] ?? KIND_LABEL.reply}${run ? ` · ${run}` : ` · *${plainForSlack(m.author)}*`}`
      const tail = [
        m.kind === 'question' ? '_このスレッドへの返信は Front が解釈します（質問が複数あるときは、どれへの回答か書いてください）。_' : '',
        m.kind === 'result' || m.kind === 'question' ? desk : '',
      ].filter(Boolean).join('\n')
      const parts = this.parts(markdownToMrkdwn(m.text, this.config.linkMap), head, tail, desk)
      parts.forEach((p, n) => out.push({ key: `wfe:${t.conv}:${m.id}:${n + 1}`, conv: t.conv, wfe_message: m.id, run: m.run, label: m.kind, part: n + 1, parts: parts.length, channel: t.channel, thread: t.root, text: p }))
    })
    return out
  }

  private parts(body: string, head: string, tail = '', desk = ''): string[] {
    const pieces = chunk(body)
    const many = pieces.length > 1
    return pieces.map((p, n) => {
      const top = head || many ? `${head}${many ? ` (${n + 1}/${pieces.length})` : ''}\n` : ''
      const last = n === pieces.length - 1
      const foot = last ? [tail, many && !tail.includes(desk) ? desk : ''].filter(Boolean).join('\n') : ''
      return `${top}${p}${foot ? `\n\n${foot}` : ''}`
    })
  }

  runLink(run: string): string {
    const [ws, wf, r] = run.split('/')
    const base = this.config.linkBase.replace(/\/?$/, '/')
    return `<${base}#/ws/${encodeURIComponent(ws)}/run/${encodeURIComponent(wf)}/${encodeURIComponent(r)}|${run}>`
  }

  // ---- outbox → Slack -------------------------------------------------------------

  async deliverDue() {
    const blocked = new Set<string>()
    for (const o of this.store.outs(['queued', 'unknown'])) {
      const thread = `${o.channel}:${o.thread}`
      if (o.state === 'unknown') { if (Date.now() - (o.attempted ?? 0) < UNKNOWN_BLOCKS) blocked.add(thread); continue }
      if (blocked.has(thread)) continue
      if (o.next_try > Date.now()) { blocked.add(thread); continue }
      await this.send(o)
      const after = this.store.out(o.id)!
      if (after.state !== 'sent' && after.state !== 'failed') blocked.add(thread)
    }
  }

  private async send(o: OutRow) {
    const gap = 1100 - (Date.now() - (this.lastPost.get(o.channel) ?? 0))
    if (gap > 0) await this.sleep(gap)
    this.store.mark(o.id, 'sending', { attempted: Date.now(), tries: 1 })
    try {
      if (o.kind === 'reaction') {
        await this.slack.react(o.channel, o.thread, o.text)
        this.store.mark(o.id, 'sent')
        return
      }
      const metadata = !this.store.get('slack:metadata-off')
      const r = await this.slack.post({ channel: o.channel, thread: o.thread, text: o.text, key: metadata ? o.key : null })
      if (this.store.get('fault:lose-next-response')) {
        // Fault injection (`slack-front fault lose-next-response`): the post
        // happened, but the answer is treated as lost.
        this.store.set('fault:lose-next-response', null)
        throw new SlackCallError('simulated lost response (fault injection)', 'unknown')
      }
      this.store.tx(() => {
        this.store.mark(o.id, 'sent', { slack_ts: r.ts })
        if (o.conv && o.wfe_message !== null) this.store.mapPost(o.conv, o.wfe_message, o.channel, r.ts, 'bot')
      })
    } catch (e) {
      const err = e instanceof SlackCallError ? e : new SlackCallError((e as Error).message, 'unknown')
      if (err.kind === 'rate') this.store.mark(o.id, 'queued', { next_try: Date.now() + err.retryAfter * SECOND, error: `rate limited; retry after ${err.retryAfter}s` })
      else if (o.kind === 'reaction' && err.kind === 'unknown') this.store.mark(o.id, 'queued', { next_try: Date.now() + 30 * SECOND, error: err.message })
      else if (err.kind === 'refused' && /metadata|token_type/.test(err.code ?? '') && !this.store.get('slack:metadata-off')) {
        this.store.set('slack:metadata-off', `${new Date().toISOString()} ${err.code}`)
        this.store.mark(o.id, 'queued', { error: `metadata refused (${err.code}); identity falls back to text` })
        this.log(`chat.postMessage refused metadata (${err.code}); delivery identity falls back to bot/thread/text`)
      } else if (err.kind === 'refused') {
        this.store.mark(o.id, 'failed', { error: err.message })
        this.log(`outbox #${o.id} ${o.key}: failed — ${err.message}`)
      } else {
        this.store.mark(o.id, 'unknown', { error: err.message })
        this.log(`outbox #${o.id} ${o.key}: outcome unknown — ${err.message}`)
      }
    } finally { this.lastPost.set(o.channel, Date.now()) }
  }

  // An unknown send is looked for in its thread (by its delivery key in the
  // message metadata, else by bot, thread and text). Found: sent. Absent from
  // a readable thread: sent again (at most MAX_SENDS in all). Unreadable: it
  // stays unknown and visible; later posts of its thread wait a while for it.
  async reconcile() {
    for (const o of this.store.outs(['unknown'])) {
      if (o.kind === 'reaction') { this.store.mark(o.id, 'queued', { error: 'a reaction is retried as it is (already_reacted is success)' }); continue }
      if (Date.now() - (o.attempted ?? 0) < SETTLE || o.checks >= MAX_CHECKS) continue
      const from = (((o.attempted ?? Date.now()) - 2 * MINUTE) / 1000).toFixed(6)
      let found: SlackMessage | undefined
      try {
        const msgs = o.thread ? await this.slack.replies(o.channel, o.thread, from) : await this.slack.history(o.channel, from)
        found = msgs.find(m => m.metadata?.event_payload?.key === o.key)
          ?? msgs.find(m => (m.user === this.me.botUser || (!!this.me.botId && m.bot_id === this.me.botId)) && sameText(m.text ?? '', o.text) && !this.store.postOf(o.channel, m.ts))
      } catch (e) {
        this.store.mark(o.id, 'unknown', { checks: 1, error: `cannot reconcile: ${(e as Error).message}` })
        continue
      }
      if (found) {
        this.store.tx(() => {
          this.store.mark(o.id, 'sent', { slack_ts: found.ts, checks: 1, error: 'reconciled: found in the thread' })
          if (o.conv && o.wfe_message !== null) this.store.mapPost(o.conv, o.wfe_message, o.channel, found.ts, 'bot')
        })
        this.log(`outbox #${o.id} ${o.key}: reconciled — it was posted (${found.ts})`)
      } else if (o.tries >= MAX_SENDS) {
        this.store.mark(o.id, 'unknown', { checks: 1, error: `absent from the thread after ${o.tries} sends; left for the operator (slack-front resolve)` })
      } else {
        this.store.mark(o.id, 'queued', { checks: 1, error: 'reconciled: absent from the thread; sending again' })
        this.log(`outbox #${o.id} ${o.key}: reconciled — not posted; sending again`)
      }
    }
  }

  // ---- recovery of missed input ---------------------------------------------------

  // The Developer's DM messages since the last moment the connection was known
  // live (less an overlap): roots from the history, replies of recent and
  // mapped threads. Each goes through the inbox like an event; a message
  // already received is the same row.
  async backfill(reason: string, from?: number) {
    const last = from === undefined ? this.store.get('live:last') : String(from + OVERLAP)
    const now = Date.now()
    if (!last) {
      this.store.set('live:last', String(now))
      this.store.set('backfill:last', JSON.stringify({ at: new Date(now).toISOString(), reason, note: 'first start: history before it is not imported' }))
      return { added: 0 }
    }
    const since = Math.max(Number(last) - OVERLAP, 0)
    const oldest = (since / 1000).toFixed(6)
    const gap = now - since > RETENTION ? `the connection was not live since ${new Date(Number(last)).toISOString()}; the free plan hides messages older than 90 days, so earlier input may be unrecoverable` : null
    const dm = await this.dm()
    const roots = await this.slack.history(dm, oldest)
    const threads = new Set<string>()
    for (const m of roots) if (m.latest_reply && m.latest_reply >= oldest) threads.add(m.ts)
    for (const t of this.store.threads()) if (t.channel === dm && now - Date.parse(t.activity) < 14 * DAY) threads.add(t.root)
    const found: SlackMessage[] = [...roots]
    for (const root of threads) found.push(...(await this.slack.replies(dm, root, oldest)).filter(m => m.ts !== root || m.ts >= oldest))
    let added = 0
    for (const m of found) {
      if (m.ts < oldest) continue
      const ev: SlackEvent = { ...m, type: 'message', channel: dm, channel_type: 'im' }
      const k = inboxKey(this.me.team, ev)
      if (this.store.receive({ ...k, team: this.me.team, channel: dm, user: m.user ?? null, origin: 'backfill', raw: { team: this.me.team, event: ev } }) === 'new') {
        const row = this.store.one<InboxRow>('SELECT * FROM inbox WHERE source = ?', k.source)!
        // Only what would be input counts as recovered; the rest is settled as it would be.
        if (classify(ev, this.me.team, this.me).action !== 'ignore') added++
        else this.store.settle(row.id, 'ignored', { outcome: 'backfill: not input' })
      }
    }
    this.store.set('backfill:last', JSON.stringify({ at: new Date(now).toISOString(), reason, from: new Date(since).toISOString(), roots: roots.length, threads: threads.size, added, gap }))
    if (added || gap) this.log(`backfill (${reason}) from ${new Date(since).toISOString()}: ${added} message(s) recovered${gap ? `; GAP: ${gap}` : ''}`)
    return { added, gap }
  }

  // A backfill while connected, for events Slack never delivered.
  // It reads from the previous sweep (with the overlap).
  async sweep() {
    const now = Date.now()
    const at = Number(this.store.get('sweep:last') ?? 0)
    if (now - at < SWEEP_EVERY) return
    await this.backfill('sweep', at || now - SWEEP_EVERY)
    this.store.set('sweep:last', String(now))
  }

  // ---- the loop -----------------------------------------------------------------

  // One pass: inbox, WFE, outbox, reconciliation. Passes never overlap; a
  // nudge during one runs another right after.
  async tick() {
    if (this.running) { this.again = true; return }
    this.running = true
    try {
      do {
        this.again = false
        for (const step of [() => this.processInbox(), () => this.pollDue(), () => this.reconcile(), () => this.deliverDue()]) {
          try { await step() } catch (e) { this.log(`tick: ${(e as Error).stack ?? e}`) }
        }
      } while (this.again)
    } finally { this.running = false }
  }

  statusText(): string {
    const c = this.store.counts()
    const unresolved = this.store.outs(['unknown', 'failed']).length
    const waiting = this.store.one<{ n: number }>('SELECT count(*) AS n FROM inbox WHERE state = \'queued\'')!.n
    const wfe = this.store.get('wfe:error')
    return [
      '*中継の状態*',
      `• Slack 接続: ${this.store.get('slack:connection') ?? '不明'}（${this.store.get('slack:connection-since') ?? '-'} から）`,
      `• WFE: ${wfe ? `接続できません — ${plainForSlack(wfe)}` : '応答あり'}`,
      `• 受信待ち ${waiting} 件 / 送信待ち ${c.outbox.queued ?? 0} 件 / 未解決 ${unresolved} 件 / 会話 ${c.threads} 件`,
    ].join('\n')
  }
}
