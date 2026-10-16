// Detailed IO (p10 step 4): one Zulip channel per run, carrying what its
// attempts' harness output recorded — the agent's public messages, tool
// calls and their results, and the attempts' lifecycle — so a person can
// follow the work in detail from the request receipt. Output only: nothing
// posted there is read by the intake or wakes anyone.
//
// The source is each attempt's own log (the agent's stdout, written by the
// execution host; server/activity.ts reads the same files). This module
// reads them incrementally — a position per attempt, persisted in the
// notifier's store — renders entries into messages, and queues them in the
// run's IO conversation of the notifier (server/notify.ts, `runs.kind =
// io`), which delivers them like any other message: frozen, journaled,
// retried, looked for by marker. Delivery never runs in the execution slot;
// a Zulip outage leaves the messages queued.
//
// What is never shown: model reasoning (`thinking` blocks — they are not
// public output), the harness's configuration (its init event beyond the
// session, model and version), rate-limit and token-accounting events, and
// anything the redaction below recognizes as a credential.
import { open, readFile, stat } from 'node:fs/promises'
import { quietMentions } from '../shared/notify.ts'

// ---- configuration ------------------------------------------------------------------------

// zulip.json `io`: {enabled, since, secretFiles?}. Runs created before
// `since` get no IO channel (no backfill: nothing is manufactured for logs
// that were never relayed). `secretFiles`: host credential files (KEY=VALUE, a single raw value
// or JSON) whose values are masked wherever they appear.
export interface IoConfig { enabled: boolean; since: string; secretFiles: string[] }
export function ioConfig(raw: unknown): IoConfig | null {
  const o = raw as Partial<IoConfig> | undefined
  if (!o || typeof o !== 'object' || o.enabled !== true || typeof o.since !== 'string' || Number.isNaN(Date.parse(o.since))) return null
  return { enabled: true, since: o.since, secretFiles: Array.isArray(o.secretFiles) ? o.secretFiles.filter((f): f is string => typeof f === 'string') : [] }
}

// ---- names --------------------------------------------------------------------------------

export const IO_TOPIC = 'io'
// The IO identity of a run: its project, workflow, run id and creation.
// (The notifier's transport derives a refused channel's target from the
// conversation key, so the target is `channel:<ioKey>` and the conversation
// `<ioKey>/io`.)
export const ioKey = (r: { project: string; workflow: string; run: string }, creation: string) => `${r.project}/${r.workflow}/${r.run}@${creation}`
export const ioDescription = (r: { project: string; workflow: string; run: string }, creation: string, uid: string) =>
  `[wfe] project ${r.project} · workflow ${r.workflow}/${r.run}@${creation}: detailed IO of run ${r.workflow}/${r.run} (${uid}) — agent messages, tool calls and results, attempts. Output only: nothing posted here is read.`

// ---- redaction ----------------------------------------------------------------------------

const PATTERNS: [RegExp, string][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, 'sk-ant-***'],
  [/\bsk-[A-Za-z0-9]{20,}/g, 'sk-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_***'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, 'glpat-***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'AIza***'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jwt ***>'],
  [/(\b[Bb]earer\s+)[A-Za-z0-9._~+/=-]{12,}/g, '$1***'],
  [/(\b[Bb]asic\s+)[A-Za-z0-9+/=]{12,}/g, '$1***'],
  [/(:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1***@'],
  [/((?:api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd|credentials?)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1***'],
]
export class Redactor {
  private values: string[] = []
  static async from(files: string[]): Promise<Redactor> {
    const r = new Redactor()
    for (const f of files) {
      const text = await readFile(f, 'utf8').catch(() => '')
      if (!text) continue
      try {
        const walk = (v: unknown, key = ''): void => {
          if (typeof v === 'string') { if (/token|key|secret|password|pass|auth/i.test(key)) r.add(v) }
          else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k)
        }
        walk(JSON.parse(text))
      } catch {
        let pairs = 0
        for (const line of text.split('\n')) {
          const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*["']?(.*?)["']?\s*$/.exec(line)
          if (m && m[1]) { r.add(m[1]); pairs++ }
        }
        // A raw-value file (a bare token, a vault password: project_migration p5) holds
        // its secret as the whole content; it is redacted as one value.
        const whole = text.trim()
        if (!pairs && whole && !/\n/.test(whole)) r.add(whole)
      }
    }
    return r
  }
  add(v: string) { if (v.length >= 8 && !this.values.includes(v)) this.values.push(v) }
  apply(text: string): string {
    let t = text
    for (const v of this.values) t = t.split(v).join('***')
    for (const [re, to] of PATTERNS) t = t.replace(re, to)
    return t
  }
}

// ---- reading a log -----------------------------------------------------------------------

// One entry of an attempt's IO: a line of its log (stream-json events
// become a heading and an optional body; other formats are raw text).
export interface IoEntry { line: number; kind: 'session' | 'text' | 'tool' | 'result' | 'end' | 'note' | 'raw'; head: string; body?: string; error?: boolean }
// What the reader keeps per attempt between passes: tool names by call id,
// so a result names the call it answers.
export interface ReaderState { tools: Record<string, string>; format: 'stream-json' | 'other' | null }

const toolSummary = (name: string, input: Record<string, unknown>) => {
  const pick = input.command ?? input.description ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.prompt
  const words = typeof pick === 'string' ? pick : JSON.stringify(input)
  return { head: `→ ${name}`, body: words }
}
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : (c && typeof c === 'object' && (c as { type?: string }).type === 'image' ? '[image]' : ''))).filter(Boolean).join('\n')
  return ''
}

export function entriesOf(lines: { n: number; text: string }[], st: ReaderState): IoEntry[] {
  const out: IoEntry[] = []
  for (const { n, text } of lines) {
    const t = text.trim()
    if (!t) continue
    let ev: Record<string, unknown> | null = null
    try { const v = JSON.parse(t); ev = v && typeof v === 'object' && !Array.isArray(v) ? v : null } catch { ev = null }
    if (st.format === null) st.format = ev && typeof ev.type === 'string' ? 'stream-json' : 'other'
    if (st.format !== 'stream-json' || !ev) { out.push({ line: n, kind: 'raw', head: '', body: text }); continue }
    if (ev.type === 'system' && ev.subtype === 'init') {
      out.push({ line: n, kind: 'session', head: `session ${String(ev.session_id ?? '?')} started — ${String(ev.model ?? 'model ?')}${ev.claude_code_version ? `, Claude Code ${String(ev.claude_code_version)}` : ''}` })
    } else if (ev.type === 'assistant' || ev.type === 'user') {
      const content = (ev.message as { content?: unknown } | undefined)?.content
      for (const c of Array.isArray(content) ? content as Record<string, unknown>[] : []) {
        if (c.type === 'text' && ev.type === 'assistant' && String(c.text ?? '').trim()) out.push({ line: n, kind: 'text', head: '', body: String(c.text) })
        else if (c.type === 'tool_use') {
          st.tools[String(c.id)] = String(c.name ?? '?')
          const s = toolSummary(String(c.name ?? '?'), (c.input && typeof c.input === 'object' ? c.input : {}) as Record<string, unknown>)
          out.push({ line: n, kind: 'tool', head: s.head, body: s.body })
        } else if (c.type === 'tool_result') {
          const name = st.tools[String(c.tool_use_id)] ?? 'tool'
          delete st.tools[String(c.tool_use_id)]
          out.push({ line: n, kind: 'result', head: `← ${name}${c.is_error ? ' (error)' : ''}`, body: textOf(c.content), error: !!c.is_error })
        }
        // `thinking` and `redacted_thinking` blocks are the model's reasoning, not public output.
      }
    } else if (ev.type === 'result') {
      const cost = typeof ev.total_cost_usd === 'number' ? `, $${ev.total_cost_usd.toFixed(2)}` : ''
      const turns = typeof ev.num_turns === 'number' ? `, ${ev.num_turns} turns` : ''
      const dur = typeof ev.duration_ms === 'number' ? `, ${Math.round(ev.duration_ms / 1000)} s` : ''
      out.push({ line: n, kind: 'end', head: `session ended: ${String(ev.subtype ?? '?')}${ev.is_error ? ' (error)' : ''}${turns}${dur}${cost}`, error: !!ev.is_error })
    } else if (ev.type === 'system' && ev.subtype === 'task_notification') {
      out.push({ line: n, kind: 'note', head: `background task ${String(ev.status ?? '')}: ${String(ev.summary ?? ev.description ?? '')}`.trim() })
    }
    // rate_limit_event, thinking_tokens and other bookkeeping are not output.
  }
  return out
}

// Reads complete lines appended since `offset`. `max` is the usual batch
// budget; a single longer line is read through its newline so it cannot
// stall every later entry. Read only the size observed at the start, even
// while the log is growing. Incomplete lines wait for a later pass, and
// chunks are decoded together so UTF-8 and JSON are never split.
export async function readFrom(path: string, offset: number, line: number, max = 2 * 1024 * 1024): Promise<{ lines: { n: number; text: string }[]; offset: number; line: number; size: number; ino: number; mtimeMs: number } | null> {
  const st = await stat(path).catch(() => null)
  if (!st?.isFile()) return null
  if (st.size <= offset) return { lines: [], offset, line, size: st.size, ino: st.ino, mtimeMs: st.mtimeMs }
  const fh = await open(path, 'r')
  try {
    const want = Math.min(st.size - offset, max)
    const buf = Buffer.alloc(want)
    const { bytesRead } = await fh.read(buf, 0, want, offset)
    let end = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
    let complete = buf.subarray(0, Math.max(0, end))
    let consumed = end + 1
    if (end < 0) {
      const parts = [buf.subarray(0, bytesRead)]
      let scanned = bytesRead
      while (bytesRead > 0 && offset + scanned < st.size) {
        const next = Buffer.alloc(Math.min(max, st.size - offset - scanned))
        const read = await fh.read(next, 0, next.length, offset + scanned)
        if (!read.bytesRead) break // the file may have been truncated
        end = next.subarray(0, read.bytesRead).indexOf(0x0a)
        parts.push(next.subarray(0, end < 0 ? read.bytesRead : end))
        if (end >= 0) {
          consumed = scanned + end + 1
          complete = Buffer.concat(parts)
          break
        }
        scanned += read.bytesRead
      }
      if (end < 0) return { lines: [], offset, line, size: st.size, ino: st.ino, mtimeMs: st.mtimeMs }
    }
    const lines = complete.toString('utf8').split('\n').map((text, i) => ({ n: line + i + 1, text }))
    return { lines, offset: offset + consumed, line: line + lines.length, size: st.size, ino: st.ino, mtimeMs: st.mtimeMs }
  } finally { await fh.close() }
}

// One entry in full, for the full-output view (`wfe run io`, GET …/io).
export async function entryAt(path: string, n: number): Promise<IoEntry[]> {
  const text = await readFile(path, 'utf8')
  const all = text.split('\n')
  const st: ReaderState = { tools: {}, format: null }
  // Tool names come from earlier lines: read up to n.
  const entries = entriesOf(all.slice(0, n).map((t, i) => ({ n: i + 1, text: t })), st)
  return entries.filter(e => e.line === n)
}

// ---- rendering --------------------------------------------------------------------------------

export const IO_MESSAGE_MAX = 3500
const INLINE = 900 // characters of a body shown inline
const fence = (s: string) => { const ticks = Math.max(3, ...[...s.matchAll(/`+/g)].map(m => m[0].length + 1)); return '`'.repeat(ticks) }
// An entry as message lines; a long body is cut, and `full` says where the
// whole of it is.
export function renderEntry(e: IoEntry, redact: Redactor, full: (line: number) => string): string {
  const body = e.body !== undefined ? redact.apply(e.body) : undefined
  const cut = body !== undefined && body.length > INLINE
  const shown = cut ? `${body!.slice(0, INLINE)}\n…` : body
  const more = cut ? `\n_${body!.length} characters; the whole: ${full(e.line)}_` : ''
  switch (e.kind) {
    case 'session': case 'end': case 'note': return `_${quietMentions(redact.apply(e.head))}_`
    case 'text': return `${quietMentions(shown ?? '')}${more}`
    case 'tool': { const f = fence(shown ?? ''); return `**${e.head}**\n${f}\n${shown}\n${f}${more}` }
    case 'result': { const f = fence(shown ?? ''); return `${e.head}${shown?.trim() ? `\n${f}\n${shown}\n${f}` : ' (no output)'}${more}` }
    case 'raw': { const f = fence(shown ?? ''); return `${f}\n${shown}\n${f}${more}` }
  }
}

// Entries into messages of at most IO_MESSAGE_MAX characters, each with the
// line range it covers.
export function chunk(rendered: { line: number; text: string }[]): { from: number; to: number; text: string }[] {
  const out: { from: number; to: number; text: string }[] = []
  let cur: { from: number; to: number; parts: string[]; size: number } | null = null
  for (const r of rendered) {
    const text = r.text.length > IO_MESSAGE_MAX ? `${r.text.slice(0, IO_MESSAGE_MAX - 40)}\n…(cut)` : r.text
    if (cur && cur.size + text.length + 2 > IO_MESSAGE_MAX) { out.push({ from: cur.from, to: cur.to, text: cur.parts.join('\n\n') }); cur = null }
    if (!cur) cur = { from: r.line, to: r.line, parts: [], size: 0 }
    cur.parts.push(text); cur.size += text.length + 2; cur.to = r.line
  }
  if (cur) out.push({ from: cur.from, to: cur.to, text: cur.parts.join('\n\n') })
  return out
}
