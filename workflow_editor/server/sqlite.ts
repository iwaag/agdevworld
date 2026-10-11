// Opening this host's SQLite stores (exec.sqlite, notify.sqlite) the same
// way (p5/ex1). Every `wfe` call is a process that opens and closes them, so
// opens race each other, WAL recovery and the last connection's checkpoint.
// The busy timeout is in force before anything that takes a lock; WAL and
// the versioned schema are set up in short steps that are retried only on
// lock contention, within a deadline; anything else fails at once. A failure
// closes the connection and names the store, the operation and the SQLite
// code — never a path's contents or run text.
import { DatabaseSync } from 'node:sqlite'

export const BUSY_TIMEOUT_MS = 5000
const OPEN_DEADLINE_MS = 15_000

// SQLITE_BUSY (5) and SQLITE_LOCKED (6), with their extended codes
// (BUSY_RECOVERY 261, BUSY_SNAPSHOT 517, BUSY_TIMEOUT 773, …).
export function transient(e: unknown): boolean {
  const code = (e as { errcode?: number }).errcode
  return typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6)
}

export class StoreError extends Error {
  readonly store: string; readonly operation: string; readonly errcode: number | null
  constructor(store: string, operation: string, cause: unknown) {
    const c = cause as { errcode?: number; errstr?: string; message?: string }
    const errcode = typeof c?.errcode === 'number' ? c.errcode : null
    super(`${store}: ${operation} failed${errcode !== null ? ` (SQLite code ${errcode}${c.errstr ? `, ${c.errstr}` : ''})` : ''}: ${c?.message ?? String(cause)}`)
    this.store = store; this.operation = operation; this.errcode = errcode
  }
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Runs `f` again while it fails on lock contention, with backoff, until the
// deadline. Only for steps whose failure leaves nothing behind (a pragma, a
// transaction that rolled back).
export function retryBusy<T>(f: () => T, deadline = Date.now() + OPEN_DEADLINE_MS): T {
  for (let wait = 10; ; wait = Math.min(wait * 2, 250)) {
    try { return f() } catch (e) {
      if (!transient(e) || Date.now() + wait > deadline) throw e
      pause(wait + Math.floor(Math.random() * wait))
    }
  }
}

// One short write transaction. BEGIN IMMEDIATE takes the write lock at once
// (waiting up to the busy timeout), so a transaction never fails half-way
// for lack of the lock; it rolls back on any error.
export function transaction<T>(db: DatabaseSync, f: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try { const r = f(); db.exec('COMMIT'); return r } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
    throw e
  }
}

export interface Migration { version: number; up: (db: DatabaseSync) => void }

// Opens a store: busy timeout first, then WAL, then the migrations not yet
// applied, each in one transaction that re-reads user_version inside it (two
// processes opening a fresh file apply each migration once).
export function openStore(store: string, file: string, migrations: Migration[]): DatabaseSync {
  let db: DatabaseSync
  try { db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS }) } catch (e) { throw new StoreError(store, 'open', e) }
  let op = 'busy timeout'
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    op = 'WAL mode'
    retryBusy(() => db.exec('PRAGMA journal_mode = WAL'))
    const latest = Math.max(0, ...migrations.map(m => m.version))
    op = 'schema version'
    const version = () => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (retryBusy(version) > latest) throw new Error(`the schema is version ${version()}, newer than this release understands (${latest}); use a newer release`)
    for (const m of migrations.sort((a, b) => a.version - b.version)) {
      if (retryBusy(version) >= m.version) continue
      op = `migration to version ${m.version}`
      retryBusy(() => transaction(db, () => {
        if (version() >= m.version) return
        m.up(db)
        db.exec(`PRAGMA user_version = ${m.version}`)
      }))
    }
    return db
  } catch (e) {
    try { db.close() } catch { /* closing a failed connection */ }
    throw e instanceof StoreError ? e : new StoreError(store, op, e)
  }
}
