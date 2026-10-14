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

// ---- what a monitor needs from the log (observer p3) ----------------------------------
//
// The turn count says the harness moved; a monitor also needs to tell a long
// foreground command from a hung one and a session that ended from one that
// still runs. These facts come from the log's ends only — the session id from
// its first event, the rest from its last `TAIL` bytes — so a look costs the
// same however long the attempt has run:
//
// - `session`: the harness session id (stream-json `system/init`), when named;
// - `openTool`: the last tool call without its result, its declared timeout
//   (Bash `timeout`, else the harness default of 120 s; null for tools that
//   declare none) and a short summary; `since` is the log's last write when
//   the call was the newest line, so it never claims more age than seen;
// - `ended`: the harness's own end of the session (`result`), with its reason;
// - `backgroundStopped`: background tasks the harness reported stopped or
//   killed (they die with the session: project_migration p2 step 3a).
export interface LogFacts {
  session: string | null
  openTool: { name: string; since: string | null; timeoutSeconds: number | null; summary: string } | null
  ended: { subtype: string; stopReason: string | null } | null
  backgroundStopped: number
  partial: boolean // the tail did not reach the log's start: older events were not read
}
const HEAD = 64 * 1024
const TAIL = 1024 * 1024
const DEFAULT_BASH_TIMEOUT_S = 120

export async function logFacts(path: string | null): Promise<LogFacts | null> {
  if (!path) return null
  const st = await stat(path).catch(() => null)
  if (!st?.isFile()) return null
  const fh = await open(path, 'r')
  try {
    const headBuf = Buffer.alloc(Math.min(HEAD, st.size))
    await fh.read(headBuf, 0, headBuf.length, 0)
    let session: string | null = null
    for (const line of headBuf.toString('utf8').split('\n').slice(0, 50)) {
      const ev = parse(line)
      if (ev && typeof ev.session_id === 'string') { session = ev.session_id; break }
    }
    const from = Math.max(0, st.size - TAIL)
    const tailBuf = Buffer.alloc(st.size - from)
    await fh.read(tailBuf, 0, tailBuf.length, from)
    let text = tailBuf.toString('utf8')
    if (from > 0) text = text.slice(text.indexOf('\n') + 1) // a partial first line
    const open_ = new Map<string, { name: string; input: Record<string, unknown>; at: number }>()
    let lastTalk = -1 // the newest assistant/user event: nothing the agent did came after it
    let ended: LogFacts['ended'] = null
    let backgroundStopped = 0
    const lines = text.split('\n').filter(l => l.trim())
    lines.forEach((line, i) => {
      const ev = parse(line)
      if (!ev) return
      if (ev.type === 'assistant' || ev.type === 'user') {
        lastTalk = i
        const content = (ev.message as { content?: unknown } | undefined)?.content
        for (const c of Array.isArray(content) ? content : []) {
          if (c?.type === 'tool_use' && typeof c.id === 'string') { open_.set(c.id, { name: String(c.name ?? '?'), input: (c.input && typeof c.input === 'object' ? c.input : {}) as Record<string, unknown>, at: i }); ended = null }
          else if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') open_.delete(c.tool_use_id)
        }
        if (ev.type === 'assistant') ended = null
      } else if (ev.type === 'result') {
        ended = { subtype: String(ev.subtype ?? ''), stopReason: typeof ev.stop_reason === 'string' ? ev.stop_reason : null }
      } else if (ev.type === 'system' && (ev.subtype === 'task_notification' || ev.subtype === 'task_updated')) {
        const status = String(ev.status ?? (ev.patch as { status?: unknown } | undefined)?.status ?? '')
        if (ev.subtype === 'task_notification' && (status === 'stopped' || status === 'killed')) backgroundStopped++
      }
    })
    const pending = [...open_.values()].at(-1)
    let openTool: LogFacts['openTool'] = null
    if (pending) {
      const bash = pending.name === 'Bash'
      const declared = bash ? (typeof pending.input.timeout === 'number' ? pending.input.timeout / 1000 : DEFAULT_BASH_TIMEOUT_S) : null
      const words = String(pending.input.description ?? pending.input.command ?? pending.input.prompt ?? pending.input.file_path ?? '').replace(/\s+/g, ' ').trim()
      openTool = { name: pending.name, since: pending.at === lastTalk ? new Date(st.mtimeMs).toISOString() : null, timeoutSeconds: bash && pending.input.run_in_background === true ? null : declared, summary: words.length > 160 ? `${words.slice(0, 157)}…` : words }
    }
    return { session, openTool, ended, backgroundStopped, partial: from > 0 }
  } finally {
    await fh.close()
  }
}

function parse(line: string): Record<string, unknown> | null {
  const t = line.trim()
  if (!t) return null
  try { const v = JSON.parse(t); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null } catch { return null }
}
