// p5/ex1 step 4: both stores under concurrent opens and held write locks,
// across independent processes. A file barrier releases the openers
// together; a separate process holds the write lock for a chosen time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecStore } from '../server/exec.ts'
import { NotifyStore } from '../server/notify.ts'

const PKG = join(import.meta.dirname, '..')

// A child: wait for the barrier, open the store with the package's own
// constructor, write `writes` rows that name it, close; report JSON.
const CHILD = `
const [pkg, area, which, name, writes, barrier] = process.argv.slice(1)
const { existsSync } = await import('node:fs')
for (const end = Date.now() + 30000; !existsSync(barrier); await new Promise(r => setTimeout(r, 2))) if (Date.now() > end) { console.log(JSON.stringify({ ok: false, ms: 0, message: 'barrier never opened' })); process.exit(0) }
const t0 = Date.now()
try {
  const Store = which === 'exec' ? (await import(pkg + '/server/exec.ts')).ExecStore : (await import(pkg + '/server/notify.ts')).NotifyStore
  const { transaction } = await import(pkg + '/server/sqlite.ts')
  const s = new Store({ area, registryFile: area + '/registry.json' })
  try {
    for (let i = 0; i < Number(writes); i++) transaction(s.db, () => {
      if (which === 'exec') s.db.prepare('INSERT INTO heartbeat (name, at) VALUES (?, ?)').run(name + '-' + i, new Date().toISOString())
      else s.db.prepare("INSERT INTO targets (key, kind, project, name, description, state, created, updated) VALUES (?, 'folder', 'p', 'n', 'd', 'pending', 'x', 'x')").run(name + '-' + i)
    }, which + ' store')
  } finally { s.close() }
  console.log(JSON.stringify({ ok: true, ms: Date.now() - t0 }))
} catch (e) { console.log(JSON.stringify({ ok: false, ms: Date.now() - t0, message: e.message, errcode: e.errcode ?? null })) }
`

function child(args: string[]): Promise<{ ok: boolean; ms: number; message?: string; errcode?: number | null }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
    p.on('exit', () => { try { resolve(JSON.parse(out.trim().split('\n').at(-1)!)) } catch { reject(new Error(`child output: ${out} ${err}`)) } })
  })
}

// Holds the write lock of a database file from another process until `release` exists.
function holder(file: string, release: string): Promise<() => Promise<void>> {
  const code = `
    const { DatabaseSync } = await import('node:sqlite'); const { existsSync } = await import('node:fs')
    const db = new DatabaseSync(process.argv[1], { timeout: 5000 }); db.exec('BEGIN IMMEDIATE'); console.log('held')
    for (const end = Date.now() + 60000; !existsSync(process.argv[2]) && Date.now() < end; ) await new Promise(r => setTimeout(r, 5))
    db.exec('ROLLBACK'); db.close()`
  const p = spawn(process.execPath, ['--input-type=module', '-e', code, file, release], { stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = new Promise(r => p.once('exit', r)) // listened to from the start: an early exit is not missed
  return new Promise((resolve, reject) => {
    p.stdout.once('data', () => resolve(async () => { await writeFile(release, ''); await exited }))
    void exited.then(() => reject(new Error('the lock holder exited before holding the lock')))
  })
}

async function area(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wfe-sqlite-'))
  await writeFile(join(dir, 'registry.json'), JSON.stringify({ workspaces: [] }))
  return dir
}

for (const which of ['exec', 'notify'] as const) {
  test(`${which} store: independent processes first-open and reopen together without failures or lost rows`, async () => {
    const PROCS = 8, WRITES = 3, ROUNDS = 4
    for (let round = 0; round < ROUNDS; round++) {
      const dir = await area()
      try {
        for (const phase of ['first-open', 'reopen']) {
          const barrier = join(dir, `go-${phase}`)
          const runs = Array.from({ length: PROCS }, (_, i) => child([PKG, dir, which, `${phase}-${i}`, String(WRITES), barrier]))
          await new Promise(r => setTimeout(r, 300)) // the children are waiting at the barrier
          await writeFile(barrier, '')
          const results = await Promise.all(runs)
          assert.deepEqual(results.filter(r => !r.ok), [], `${which} round ${round} ${phase}`)
        }
        const s = which === 'exec' ? new ExecStore({ area: dir, registryFile: join(dir, 'registry.json') }) : new NotifyStore({ area: dir, registryFile: join(dir, 'registry.json') })
        const n = (s.db.prepare(which === 'exec' ? 'SELECT count(*) AS n FROM heartbeat' : 'SELECT count(*) AS n FROM targets').get() as { n: number }).n
        assert.equal(n, 2 * PROCS * WRITES, 'every row written is there')
        assert.equal((s.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
        assert.equal((s.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal')
        s.close()
      } finally { await rm(dir, { recursive: true, force: true }) }
    }
  })

  test(`${which} store: a short write lock is waited out; a prolonged one fails within the bound, named; a later attempt succeeds`, async () => {
    const dir = await area()
    try {
      // Create the store first, so the lock holder has a file to lock.
      const s = which === 'exec' ? new ExecStore({ area: dir, registryFile: join(dir, 'registry.json') }) : new NotifyStore({ area: dir, registryFile: join(dir, 'registry.json') })
      s.close()
      const file = join(dir, '.local', which, `${which}.sqlite`)
      // Short: released after ~1 s, well inside the 5 s busy timeout.
      let release = await holder(file, join(dir, 'release-short'))
      const short = child([PKG, dir, which, 'short', '1', join(dir, 'go-short')])
      await writeFile(join(dir, 'go-short'), '')
      await new Promise(r => setTimeout(r, 1000))
      await release()
      const a = await short
      assert.ok(a.ok, JSON.stringify(a))
      assert.ok(a.ms >= 800, `it waited for the lock (${a.ms} ms)`)
      // Prolonged: held until the writer has given up (busy timeout 5 s).
      release = await holder(file, join(dir, 'release-long'))
      await writeFile(join(dir, 'go-long'), '')
      const b = await child([PKG, dir, which, 'long', '1', join(dir, 'go-long')])
      await release()
      assert.equal(b.ok, false)
      assert.equal(b.errcode, 5, 'SQLITE_BUSY, carried by the store error')
      assert.match(b.message ?? '', new RegExp(`^${which} store: (taking the write lock|a write transaction) failed \\(SQLite code 5, database is locked\\)`))
      assert.ok(b.ms >= 4500 && b.ms < 9000, `bounded by the busy timeout (${b.ms} ms)`)
      // Once the lock is gone the same write succeeds.
      await writeFile(join(dir, 'go-after'), '')
      const c = await child([PKG, dir, which, 'after', '1', join(dir, 'go-after')])
      assert.ok(c.ok, JSON.stringify(c))
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}
