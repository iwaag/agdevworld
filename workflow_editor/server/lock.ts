// A cross-process lock on a file path, for writers that may be the CLI, the
// service and the executor at once (registry, run records, the queue).
//
// Each locked path has a small SQLite file in a host-local lock directory
// (WFE_LOCK_DIR, default ~/.cache/wfe/locks), keyed by the target's real
// path. Holding the lock is holding `BEGIN IMMEDIATE` on it: SQLite's file
// lock, which the operating system releases when the holder exits or dies,
// so a crashed writer never leaves a lock behind and there is no stale-lock
// takeover to get wrong. Waiting never blocks the event loop: attempts are
// non-blocking and retried with a timer. Nothing here crosses hosts.
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class LockTimeout extends Error {}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
export const lockDir = () => process.env.WFE_LOCK_DIR ?? join(homedir(), '.cache', 'wfe', 'locks')

async function keyOf(target: string): Promise<string> {
  const abs = resolve(target)
  const dir = await realpath(dirname(abs)).catch(() => dirname(abs))
  return createHash('sha256').update(join(dir, basename(abs))).digest('hex').slice(0, 32)
}

export async function withLock<T>(target: string, fn: () => Promise<T>, opts: { timeoutMs?: number; what?: string } = {}): Promise<T> {
  const dir = lockDir()
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, `${await keyOf(target)}.sqlite`))
  try {
    db.exec('PRAGMA busy_timeout = 0')
    const deadline = Date.now() + (opts.timeoutMs ?? 15_000)
    for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
      try { db.exec('BEGIN IMMEDIATE'); break } catch (e) {
        if (!/locked|busy/i.test((e as Error).message)) throw e
        if (Date.now() > deadline) throw new LockTimeout(`${opts.what ?? target} is being changed by another process; try again`)
        await sleep(wait)
      }
    }
    try { return await fn() } finally { db.exec('ROLLBACK') }
  } finally {
    db.close()
  }
}
