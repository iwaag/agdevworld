// The transport store (README.md, "Store"): which Slack thread is which WFE
// conversation, what came in (inbox) and what goes out (outbox), and where
// recovery stands. It is no second execution ledger: conversations, messages
// and runs stay WFE's.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type InboxState = 'queued' | 'done' | 'ignored' | 'failed'
export type InboxOrigin = 'event' | 'backfill' | 'trial'
// queued → sending → sent; a call whose outcome is not known is `unknown`
// until reconciled against the thread; `failed` is a definite refusal;
// `coalesced` progress was replaced by a newer one; `dropped` by an operator.
export type OutState = 'queued' | 'sending' | 'sent' | 'unknown' | 'failed' | 'coalesced' | 'dropped'
export type OutKind = 'message' | 'reaction'

export interface ThreadRow {
  team: string; channel: string; root: string; conv: string; created: string
  cursor: number; activity: string; next_poll: number; poll_failures: number; poll_error: string | null
}
export interface InboxRow {
  id: number; source: string; event_id: string | null; team: string; channel: string; ts: string; thread: string | null
  user: string | null; origin: InboxOrigin; raw: string; received: string; state: InboxState; outcome: string | null
  conv: string | null; wfe_message: number | null; tries: number; next_try: number; error: string | null
}
export interface OutRow {
  id: number; key: string; kind: OutKind; conv: string | null; wfe_message: number | null; run: string | null; label: string | null
  part: number; parts: number; channel: string; thread: string; text: string; state: OutState; slack_ts: string | null
  tries: number; next_try: number; attempted: number | null; checks: number; error: string | null; created: string; updated: string
}
export interface NewOut { key: string; kind?: OutKind; conv?: string | null; wfe_message?: number | null; run?: string | null; label?: string | null; part?: number; parts?: number; channel: string; thread: string; text: string }

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE threads (team TEXT NOT NULL, channel TEXT NOT NULL, root TEXT NOT NULL, conv TEXT NOT NULL UNIQUE, created TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0, activity TEXT NOT NULL, next_poll INTEGER NOT NULL DEFAULT 0, poll_failures INTEGER NOT NULL DEFAULT 0, poll_error TEXT,
  PRIMARY KEY (team, channel, root));
CREATE TABLE events (event_id TEXT PRIMARY KEY, source TEXT, received TEXT NOT NULL, retry_num INTEGER);
CREATE TABLE inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL UNIQUE, event_id TEXT, team TEXT NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL,
  thread TEXT, user TEXT, origin TEXT NOT NULL, raw TEXT NOT NULL, received TEXT NOT NULL, state TEXT NOT NULL, outcome TEXT, conv TEXT, wfe_message INTEGER,
  tries INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE INDEX inbox_state ON inbox (state, ts);
CREATE TABLE posts (conv TEXT NOT NULL, wfe_message INTEGER NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL, origin TEXT NOT NULL, PRIMARY KEY (channel, ts));
CREATE INDEX posts_message ON posts (conv, wfe_message);
CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, conv TEXT, wfe_message INTEGER, run TEXT, label TEXT,
  part INTEGER NOT NULL DEFAULT 1, parts INTEGER NOT NULL DEFAULT 1, channel TEXT NOT NULL, thread TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, slack_ts TEXT,
  tries INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0, attempted INTEGER, checks INTEGER NOT NULL DEFAULT 0, error TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE INDEX outbox_state ON outbox (state, id);
`

const iso = () => new Date().toISOString()
type Param = string | number | null

export class Store {
  readonly db: DatabaseSync
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file, { timeout: 5000 })
    this.db.exec('PRAGMA busy_timeout = 5000')
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    const v = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (v > 1) throw new Error(`the store ${file} is schema ${v}, newer than this release (1)`)
    if (v < 1) this.tx(() => { this.db.exec(SCHEMA); this.db.exec('PRAGMA user_version = 1') })
  }
  close() { this.db.close() }

  tx<T>(f: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const r = f(); this.db.exec('COMMIT'); return r } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  all<T>(sql: string, ...a: Param[]): T[] { return this.db.prepare(sql).all(...a) as T[] }
  one<T>(sql: string, ...a: Param[]): T | undefined { return this.db.prepare(sql).get(...a) as T | undefined }
  run(sql: string, ...a: Param[]) { return this.db.prepare(sql).run(...a) }

  // ---- meta: connection state, cursors, fault switches ----
  get(key: string): string | null { return this.one<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null }
  set(key: string, value: string | null) {
    if (value === null) this.run('DELETE FROM meta WHERE key = ?', key)
    else this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value)
  }

  // ---- threads ----
  thread(team: string, channel: string, root: string) { return this.one<ThreadRow>('SELECT * FROM threads WHERE team = ? AND channel = ? AND root = ?', team, channel, root) }
  threadOf(conv: string) { return this.one<ThreadRow>('SELECT * FROM threads WHERE conv = ?', conv) }
  threads() { return this.all<ThreadRow>('SELECT * FROM threads ORDER BY activity DESC') }
  addThread(team: string, channel: string, root: string, conv: string): ThreadRow {
    const at = iso()
    this.run('INSERT OR IGNORE INTO threads (team, channel, root, conv, created, activity) VALUES (?, ?, ?, ?, ?, ?)', team, channel, root, conv, at, at)
    return this.thread(team, channel, root)!
  }
  touch(conv: string) { this.run('UPDATE threads SET activity = ?, next_poll = 0 WHERE conv = ?', iso(), conv) }

  // ---- inbox ----
  // An envelope seen before (by event id) is acknowledged again and nothing
  // else; a message seen before by another route (event vs backfill) is one
  // inbox row. Returns whether the message is new.
  receive(o: { source: string; event_id?: string | null; retry_num?: number | null; team: string; channel: string; ts: string; thread?: string | null; user?: string | null; origin: InboxOrigin; raw: unknown }): 'new' | 'seen-event' | 'seen-message' {
    return this.tx(() => {
      if (o.event_id) {
        if (this.one('SELECT 1 FROM events WHERE event_id = ?', o.event_id)) return 'seen-event'
        this.run('INSERT INTO events (event_id, source, received, retry_num) VALUES (?, ?, ?, ?)', o.event_id, o.source, iso(), o.retry_num ?? null)
      }
      if (this.one('SELECT 1 FROM inbox WHERE source = ?', o.source)) return 'seen-message'
      this.run('INSERT INTO inbox (source, event_id, team, channel, ts, thread, user, origin, raw, received, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'queued\')',
        o.source, o.event_id ?? null, o.team, o.channel, o.ts, o.thread ?? null, o.user ?? null, o.origin, JSON.stringify(o.raw), iso())
      return 'new'
    })
  }
  // Oldest Slack message first: order within a conversation is Slack's order,
  // whichever route (event, backfill) brought a message in.
  nextInbox(): InboxRow | undefined { return this.one<InboxRow>('SELECT * FROM inbox WHERE state = \'queued\' ORDER BY ts, id LIMIT 1') }
  inbox(id: number) { return this.one<InboxRow>('SELECT * FROM inbox WHERE id = ?', id) }
  settle(id: number, state: InboxState, o: { outcome?: string | null; conv?: string | null; wfe_message?: number | null; error?: string | null } = {}) {
    this.run('UPDATE inbox SET state = ?, outcome = ?, conv = COALESCE(?, conv), wfe_message = COALESCE(?, wfe_message), error = ? WHERE id = ?', state, o.outcome ?? null, o.conv ?? null, o.wfe_message ?? null, o.error ?? null, id)
  }
  retryLater(id: number, error: string, delayMs: number) {
    this.run('UPDATE inbox SET tries = tries + 1, next_try = ?, error = ? WHERE id = ?', Date.now() + delayMs, error, id)
  }

  // ---- posts: Slack messages ↔ WFE messages ----
  mapPost(conv: string, wfe_message: number, channel: string, ts: string, origin: 'slack' | 'bot') {
    this.run('INSERT OR IGNORE INTO posts (conv, wfe_message, channel, ts, origin) VALUES (?, ?, ?, ?, ?)', conv, wfe_message, channel, ts, origin)
  }
  postOf(channel: string, ts: string) { return this.one<{ conv: string; wfe_message: number; origin: string }>('SELECT * FROM posts WHERE channel = ? AND ts = ?', channel, ts) }

  // ---- outbox ----
  enqueue(o: NewOut): boolean {
    const at = iso()
    return Number(this.run('INSERT OR IGNORE INTO outbox (key, kind, conv, wfe_message, run, label, part, parts, channel, thread, text, state, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'queued\', ?, ?)',
      o.key, o.kind ?? 'message', o.conv ?? null, o.wfe_message ?? null, o.run ?? null, o.label ?? null, o.part ?? 1, o.parts ?? 1, o.channel, o.thread, o.text, at, at).changes) > 0
  }
  out(id: number) { return this.one<OutRow>('SELECT * FROM outbox WHERE id = ?', id) }
  outs(states: OutState[]) { return this.all<OutRow>(`SELECT * FROM outbox WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY id`, ...states) }
  mark(id: number, state: OutState, o: { slack_ts?: string | null; error?: string | null; next_try?: number; attempted?: number | null; tries?: 1; checks?: 1 } = {}) {
    this.run(`UPDATE outbox SET state = ?, slack_ts = COALESCE(?, slack_ts), error = ?, next_try = COALESCE(?, next_try), attempted = COALESCE(?, attempted),
      tries = tries + ?, checks = checks + ?, updated = ? WHERE id = ?`, state, o.slack_ts ?? null, o.error ?? null, o.next_try ?? null, o.attempted ?? null, o.tries ?? 0, o.checks ?? 0, iso(), id)
  }
  // A send interrupted by a crash or restart has an unknown outcome.
  interruptedSends(): number { return Number(this.run('UPDATE outbox SET state = \'unknown\', error = \'interrupted while sending (restart)\', updated = ? WHERE state = \'sending\'', iso()).changes) }

  counts() {
    const group = (t: string) => Object.fromEntries(this.all<{ state: string; n: number }>(`SELECT state, count(*) AS n FROM ${t} GROUP BY state`).map(r => [r.state, r.n]))
    return { inbox: group('inbox'), outbox: group('outbox'), threads: this.one<{ n: number }>('SELECT count(*) AS n FROM threads')!.n }
  }
}
