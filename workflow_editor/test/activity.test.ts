// An attempt's activity from its own log (p8/ex2, server/activity.ts): turns
// are distinct assistant message ids, counted once however often and however
// concurrently the log is read; a partial line waits; another format is not
// counted; a replaced file starts again.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, rename, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activityOf, resetActivity } from '../server/activity.ts'

let dir = ''
before(async () => { dir = await mkdtemp(join(tmpdir(), 'wfe-activity-')) })
after(async () => { await rm(dir, { recursive: true, force: true }) })

const ev = (o: unknown) => `${JSON.stringify(o)}\n`
const init = ev({ type: 'system', subtype: 'init', session_id: 's', model: 'm' })
const say = (id: string, kind = 'text') => ev({ type: 'assistant', message: { id, content: [{ type: kind }] } })
const tool = ev({ type: 'user', message: { content: [{ type: 'tool_result' }] } })

test('a turn is one distinct assistant message, however many events it has', async () => {
  resetActivity()
  const f = join(dir, 'a.jsonl')
  await writeFile(f, init + say('m1', 'thinking') + say('m1', 'tool_use') + tool + say('m2') + ev({ type: 'system', subtype: 'thinking_tokens' }))
  const a = await activityOf(f)
  assert.equal(a?.unit, 'turn')
  assert.equal(a?.count, 2)
  assert.ok(a?.last && !Number.isNaN(Date.parse(a.last)))
  // Reading again changes nothing: no double counting on re-reads.
  assert.equal((await activityOf(f))?.count, 2)
  assert.equal((await activityOf(f))?.count, 2)
  // Appended work is counted once; a repeated id is the same turn.
  await appendFile(f, say('m2') + tool + say('m3'))
  assert.equal((await activityOf(f))?.count, 3)
})

test('a partial line waits for its end; concurrent reads share one advance', async () => {
  resetActivity()
  const f = join(dir, 'b.jsonl')
  const line = say('m9')
  await writeFile(f, init + say('m1') + line.slice(0, 20))
  assert.equal((await activityOf(f))?.count, 1, 'the half-written event is not read')
  await appendFile(f, line.slice(20))
  const both = await Promise.all([activityOf(f), activityOf(f), activityOf(f)])
  assert.deepEqual(both.map(x => x?.count), [2, 2, 2])
  await appendFile(f, say('m10'))
  assert.equal((await activityOf(f))?.count, 3, 'the cursor did not skip what came after')
})

test('another format is not counted; the last write is still told', async () => {
  resetActivity()
  const f = join(dir, 'c.log')
  await writeFile(f, 'Thinking about the request\nRunning tests…\n')
  const t = new Date('2026-10-13T08:00:00Z')
  await utimes(f, t, t)
  const a = await activityOf(f)
  assert.equal(a?.unit, null)
  assert.equal(a?.count, null)
  assert.equal(a?.last, t.toISOString())
})

test('a log that cannot be read is said so, never counted', async () => {
  resetActivity()
  const f = join(dir, 'locked.jsonl')
  await writeFile(f, init + say('m1'))
  const { chmod } = await import('node:fs/promises')
  await chmod(f, 0o000)
  try {
    const a = await activityOf(f)
    assert.equal(a?.count, null)
    assert.ok(a?.problem, 'the problem is told')
  } finally { await chmod(f, 0o644) }
})

test('no log yet, no path, and a replaced or truncated log', async () => {
  resetActivity()
  assert.equal(await activityOf(null), null)
  const missing = await activityOf(join(dir, 'none.jsonl'))
  assert.deepEqual(missing, { unit: null, count: null, last: null, bytes: 0 })
  const f = join(dir, 'd.jsonl')
  await writeFile(f, init + say('m1') + say('m2'))
  assert.equal((await activityOf(f))?.count, 2)
  // Replaced by another file (a new inode): read from the start.
  await writeFile(join(dir, 'd2.jsonl'), init + say('x1'))
  await rename(join(dir, 'd2.jsonl'), f)
  assert.equal((await activityOf(f))?.count, 1)
  // Truncated and rewritten in place: shorter than what was read, so read again.
  await writeFile(f, init)
  assert.equal((await activityOf(f))?.count, 0)
})
