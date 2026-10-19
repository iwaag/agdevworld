// The Slack Web API calls the integration makes (manifest.yaml scopes), with
// their failures sorted into what the outbox can decide on:
// - `rate`: not sent; try again after `retryAfter` seconds;
// - `refused`: Slack answered with an error; nothing was posted;
// - `unknown`: no answer (timeout, connection loss, 5xx): it may have been posted.
import { ErrorCode, WebClient } from '@slack/web-api'

export interface SlackMessage {
  ts: string; thread_ts?: string; user?: string; bot_id?: string; app_id?: string; subtype?: string; text?: string
  files?: { name?: string; title?: string; mimetype?: string; filetype?: string }[]
  latest_reply?: string; reply_count?: number; edited?: { ts: string }
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> }
  team?: string
}

export class SlackCallError extends Error {
  readonly kind: 'rate' | 'refused' | 'unknown'; readonly code: string | null; readonly retryAfter: number
  constructor(message: string, kind: 'rate' | 'refused' | 'unknown', code: string | null = null, retryAfter = 0) {
    super(message); this.kind = kind; this.code = code; this.retryAfter = retryAfter
  }
}

export interface SlackApi {
  identity(): Promise<{ team: string; botUser: string; botId: string | null }>
  openDm(user: string): Promise<string>
  post(o: { channel: string; thread: string; text: string; key: string | null }): Promise<{ ts: string }>
  react(channel: string, ts: string, name: string): Promise<void>
  history(channel: string, oldest: string): Promise<SlackMessage[]>
  replies(channel: string, root: string, oldest: string): Promise<SlackMessage[]>
}

export const DELIVERY_EVENT = 'agdev_delivery'

export class Slack implements SlackApi {
  readonly web: WebClient
  constructor(botToken: string) {
    // No automatic retries: a retried post after a timeout could be a
    // duplicate. The outbox retries, after reconciling (README.md).
    this.web = new WebClient(botToken, { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 20_000 })
  }
  private async call<T>(f: () => Promise<T>): Promise<T> {
    try { return await f() } catch (e) { throw sorted(e) }
  }
  async identity() {
    const r = await this.call(() => this.web.auth.test())
    return { team: String(r.team_id), botUser: String(r.user_id), botId: r.bot_id ? String(r.bot_id) : null }
  }
  async openDm(user: string) {
    const r = await this.call(() => this.web.conversations.open({ users: user }))
    return String(r.channel?.id)
  }
  async post(o: { channel: string; thread: string; text: string; key: string | null }) {
    const r = await this.call(() => this.web.chat.postMessage({
      channel: o.channel, ...(o.thread ? { thread_ts: o.thread } : {}), text: o.text, mrkdwn: true, unfurl_links: false, unfurl_media: false,
      ...(o.key ? { metadata: { event_type: DELIVERY_EVENT, event_payload: { key: o.key } } } : {}),
    }))
    return { ts: String(r.ts) }
  }
  async react(channel: string, ts: string, name: string) {
    try { await this.call(() => this.web.reactions.add({ channel, timestamp: ts, name })) } catch (e) {
      if (e instanceof SlackCallError && e.code === 'already_reacted') return
      throw e
    }
  }
  async history(channel: string, oldest: string) {
    const out: SlackMessage[] = []
    let cursor: string | undefined
    do {
      const r = await this.call(() => this.web.conversations.history({ channel, oldest, inclusive: true, limit: 200, cursor }))
      out.push(...(r.messages ?? []) as SlackMessage[])
      cursor = r.response_metadata?.next_cursor || undefined
    } while (cursor)
    return out
  }
  async replies(channel: string, root: string, oldest: string) {
    const out: SlackMessage[] = []
    let cursor: string | undefined
    do {
      const r = await this.call(() => this.web.conversations.replies({ channel, ts: root, oldest, inclusive: true, limit: 200, cursor, include_all_metadata: true }))
      out.push(...(r.messages ?? []) as SlackMessage[])
      cursor = r.response_metadata?.next_cursor || undefined
    } while (cursor)
    return out
  }
}

function sorted(e: unknown): SlackCallError {
  const err = e as { code?: string; message?: string; retryAfter?: number; data?: { error?: string }; statusCode?: number }
  switch (err.code) {
    case ErrorCode.RateLimitedError: return new SlackCallError('rate limited', 'rate', 'ratelimited', err.retryAfter ?? 30)
    case ErrorCode.PlatformError: return new SlackCallError(`Slack refused: ${err.data?.error}`, 'refused', err.data?.error ?? null)
    case ErrorCode.HTTPError: return new SlackCallError(`Slack HTTP ${err.statusCode}`, (err.statusCode ?? 500) >= 500 ? 'unknown' : 'refused', `http_${err.statusCode}`)
    default: return new SlackCallError(`no answer from Slack: ${err.message ?? String(e)}`, 'unknown')
  }
}
