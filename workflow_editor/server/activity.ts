// What an attempt's own output says about its activity (p8/ex2): a small
// summary for the run view, never the log's text. The execution host writes
// the agent's stdout to the attempt's log (agautolab wfexec); only the agent
// process writes there, so the file's modification time is its last
// activity. Heartbeats, reconnections and the view's polling never touch it.
//
// Counting: a log in Claude Code's stream-json format holds one JSON event
// per line; one model response arrives as several `assistant` events that
// share a `message.id`. A turn is one distinct assistant message id. A log in
// any other format is not counted: the summary then says only when the log
// was last written. The count is per attempt (one session of the agent); a
// new attempt starts again from zero.
//
// The reader keeps, per log file, the byte offset up to the last complete
// line and the ids seen, so a re-read costs only what was appended and
// yields the same count however often it is asked. A file that shrank or was
// replaced (another inode) is read again from the start.
import { open, stat } from 'node:fs/promises'

export interface ActivitySummary {
  unit: 'turn' | null // null: the log's format is not one whose turns can be counted
  count: number | null
  last: string | null // the log's last write (ISO); null when there is no log yet
  bytes: number
  problem?: string // the log is there but cannot be read: nothing is counted or claimed
}

interface Cursor { ino: number; offset: number; ids: Set<string>; format: 'stream-json' | 'other' | null; mtimeMs: number; size: number; capped: boolean }
const cursors = new Map<string, Cursor>()
const MAX_READ = 8 * 1024 * 1024 // per call; a larger backlog is read over later calls

const reading = new Map<string, Promise<ActivitySummary>>()

// One read per log at a time: two views asking at once share it, so a
// cursor never advances twice over the same bytes.
export async function activityOf(path: string | null): Promise<ActivitySummary | null> {
  if (!path) return null
  const busy = reading.get(path)
  if (busy) return busy
  const p = summarize(path).catch((e: Error) => ({ unit: null, count: null, last: null, bytes: 0, problem: e.message } as ActivitySummary)).finally(() => reading.delete(path))
  reading.set(path, p)
  return p
}

async function summarize(path: string): Promise<ActivitySummary> {
  const st = await stat(path).catch(() => null)
  if (!st?.isFile()) return { unit: null, count: null, last: null, bytes: 0 }
  let c = cursors.get(path)
  if (!c || c.ino !== st.ino || st.size < c.offset) { c = { ino: st.ino, offset: 0, ids: new Set(), format: null, mtimeMs: 0, size: 0, capped: false }; cursors.set(path, c) }
  if (st.size > c.offset && (st.size !== c.size || st.mtimeMs !== c.mtimeMs || c.capped)) await advance(path, c, st.size)
  c.size = st.size; c.mtimeMs = st.mtimeMs
  const counted = c.format === 'stream-json'
  return { unit: counted ? 'turn' : null, count: counted ? c.ids.size : null, last: st.size ? new Date(st.mtimeMs).toISOString() : null, bytes: st.size }
}

async function advance(path: string, c: Cursor, size: number) {
  const fh = await open(path, 'r')
  try {
    const want = Math.min(size - c.offset, MAX_READ)
    c.capped = want < size - c.offset
    const buf = Buffer.alloc(want)
    const { bytesRead } = await fh.read(buf, 0, want, c.offset)
    const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
    if (end < 0) return // no complete line yet
    const text = buf.subarray(0, end).toString('utf8')
    c.offset += end + 1
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      let ev: unknown
      try { ev = JSON.parse(t) } catch { ev = undefined }
      const obj = ev && typeof ev === 'object' && !Array.isArray(ev) ? ev as Record<string, unknown> : null
      // The format is decided by the first line: stream-json events are objects with a type.
      if (c.format === null) c.format = obj && typeof obj.type === 'string' ? 'stream-json' : 'other'
      if (c.format !== 'stream-json' || !obj) continue
      if (obj.type === 'assistant') {
        const id = (obj.message as { id?: unknown } | undefined)?.id
        if (typeof id === 'string' && id) c.ids.add(id)
      }
    }
  } finally {
    await fh.close()
  }
}

// For tests: forget what was read.
export const resetActivity = () => cursors.clear()
