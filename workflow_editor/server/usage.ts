// Usage (retire_old_ui p1, docs/usage.md): what this area's executions used,
// read from evidence that already exists — the coordinator's exec store
// (one row per attempt) and each attempt's harness log, which a remote
// worker ships to the coordinator (workerApi.ts). Nothing new is recorded.
//
// What a harness tells is kept apart, never folded into one number:
//
// - claude_code's final `result` event gives token counts for this process
//   and `total_cost_usd`. Under a subscription login that USD is the API list
//   price (`modelUsage.*.costBasis: list`): API-equivalent, not a charge. On a
//   resumed session the USD (and modelUsage) is cumulative for the session
//   while `usage` is this process's own, so a resumed attempt's USD is its
//   total minus the same session's previous attempt's.
// - codex's `turn.completed` events give tokens only (a ChatGPT login meters
//   the plan, not the run): no USD is invented.
// - An attempt whose log has no usage (interrupted before the harness
//   counted, a log not shipped, an unknown harness) is `unknown`, and one
//   still running is `running` — neither is ever zero.
//
// Subscription windows and the pre-WFE agents' records are read from the
// agentroom relay on this host (`/budget`, `/cost`), each with its own
// timeout and cache, so one failing source marks its own section only. The
// windows are their own route: a cold read asks the vendors and may take
// seconds, and the executions' own figures never wait for it.
import { open, stat } from 'node:fs/promises'
import type { ExecStore } from './exec.ts'
import { PERIODS, USAGE_SCHEMA, type AttemptUsage, type Period, type SourceState, type Tokens, type UsageDay, type UsageGroup, type UsageResponse, type UsageState, type UsageTotals, type UsdBasis } from '../shared/usage.ts'

export { PERIODS, type Period }

const TAIL = 256 * 1024
const FULL_LIMIT = 16 * 1024 * 1024
const DAYS = 14
const ATTEMPTS_SHOWN = 200
const RELAY_TIMEOUT_MS = 20_000
const BUDGET_CACHE_MS = 30_000
const HISTORY_CACHE_MS = 60_000

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const zeroTokens = (): Tokens => ({ input: 0, cached_input: 0, cache_write: 0, output: 0, reasoning: 0 })

// The token quartet every harness is read into (the relay's normalize_usage,
// agentroom/cost.py): `input` uncached, `cached_input` served from a cache,
// `cache_write` written into one, `output` the completion; `reasoning` is
// informational (inside output for claude, beside it for codex).
export function normalizeUsage(harness: string | null, usage: unknown): Tokens | null {
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  const get = (...keys: string[]) => num(u[keys.find(k => typeof u[k] === 'number') ?? ''])
  if (harness === 'codex') {
    const cached = get('cached_input_tokens')
    return { input: Math.max(get('input_tokens') - cached, 0), cached_input: cached, cache_write: get('cache_write_input_tokens'), output: get('output_tokens'), reasoning: get('reasoning_output_tokens') }
  }
  const details = u.output_tokens_details as Record<string, unknown> | undefined
  return {
    input: get('input_tokens', 'prompt_tokens'),
    cached_input: get('cache_read_input_tokens', 'cache_read_tokens', 'cached_content_tokens'),
    cache_write: get('cache_creation_input_tokens', 'cache_write_tokens'),
    output: get('output_tokens', 'candidates_tokens', 'completion_tokens'),
    reasoning: get('thinking_tokens', 'reasoning_tokens') || num(details?.thinking_tokens),
  }
}

const addTokens = (a: Tokens, b: Tokens) => { for (const k of Object.keys(a) as (keyof Tokens)[]) a[k] += b[k] }

export const harnessOf = (backend: string | null) => (backend ? backend.split(' / ')[0].trim() || null : null)
const modelOfBackend = (backend: string | null) => (backend?.includes(' / ') ? backend.split(' / ').slice(1).join(' / ').trim() || null : null)

// What one log says, before attempts are related to each other.
export interface LogReading {
  found: boolean; reason: string | null
  tokens: Tokens | null; usdTotal: number | null; usdBasis: UsdBasis | null
  model: string | null; session: string | null
}

const parseLines = (text: string) => {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try { const v = JSON.parse(line); if (v && typeof v === 'object') out.push(v as Record<string, unknown>) } catch { /* a cut line at the tail's start */ }
  }
  return out
}

export function readClaude(tail: string): LogReading {
  const events = parseLines(tail)
  const result = [...events].reverse().find(e => e.type === 'result')
  if (!result) return { found: false, reason: 'no result event in its log', tokens: null, usdTotal: null, usdBasis: null, model: null, session: null }
  const models = result.modelUsage && typeof result.modelUsage === 'object' ? result.modelUsage as Record<string, Record<string, unknown>> : {}
  const list = Object.values(models).some(m => m?.costBasis === 'list')
  const usd = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null
  const tokens = normalizeUsage('claude_code', result.usage)
  return {
    found: !!tokens, reason: tokens ? null : 'its result event carries no usage', tokens, usdTotal: usd,
    usdBasis: usd === null ? null : list ? 'api-equivalent' : 'reported',
    model: Object.keys(models).join(', ') || null, session: typeof result.session_id === 'string' ? result.session_id : null,
  }
}

export function readCodex(text: string): LogReading {
  let session: string | null = null
  let tokens: Tokens | null = null
  for (const e of parseLines(text)) {
    if (e.type === 'thread.started' && typeof e.thread_id === 'string') session = e.thread_id
    if (e.type === 'turn.completed') { const t = normalizeUsage('codex', e.usage); if (t) { tokens ??= zeroTokens(); addTokens(tokens, t) } }
  }
  return { found: !!tokens, reason: tokens ? null : 'no completed turn in its log', tokens, usdTotal: null, usdBasis: null, model: null, session }
}

async function readSlice(path: string, size: number, full: boolean): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const length = full ? size : Math.min(size, TAIL)
    const buf = Buffer.alloc(length)
    await fh.read(buf, 0, length, size - length)
    return buf.toString('utf8')
  } finally { await fh.close() }
}

interface AttemptRowLike { id: string; workspace: string; workflow: string; run: string; host: string; state: string; began: string; ended: string | null; log: string | null; backend: string | null; worker: string | null; lane: string | null }

export class UsageReader {
  private cache = new Map<string, { size: number; mtime: number; reading: LogReading }>()
  private budgetCache: { at: number; value: SourceState<unknown> } | null = null
  private budgetLast: { at: string; data: unknown } | null = null
  private historyCache: { at: number; value: SourceState<unknown> } | null = null
  private historyLast: { at: string; data: unknown } | null = null

  private exec: ExecStore | null
  private relayUrl: string
  private fetcher: typeof fetch
  constructor(exec: ExecStore | null, relayUrl: string, fetcher: typeof fetch = fetch) { this.exec = exec; this.relayUrl = relayUrl; this.fetcher = fetcher }

  private async reading(a: AttemptRowLike): Promise<LogReading> {
    const harness = harnessOf(a.backend)
    const none = (reason: string): LogReading => ({ found: false, reason, tokens: null, usdTotal: null, usdBasis: null, model: null, session: null })
    if (harness !== 'claude_code' && harness !== 'codex') return none(harness ? `usage of harness ${harness} is not read` : 'no backend recorded')
    if (!a.log) return none('no log recorded')
    const st = await stat(a.log).catch(() => null)
    if (!st) return none(`log missing on the coordinator${a.worker ? ` (worker ${a.worker})` : ''}`)
    const hit = this.cache.get(a.id)
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.reading
    let reading: LogReading
    try {
      reading = harness === 'claude_code' ? readClaude(await readSlice(a.log, st.size, false))
        : readCodex(await readSlice(a.log, st.size, st.size <= FULL_LIMIT))
    } catch (e) { reading = none(`log unreadable: ${(e as Error).message}`) }
    this.cache.set(a.id, { size: st.size, mtime: st.mtimeMs, reading })
    return reading
  }

  async attempts(): Promise<AttemptUsage[]> {
    const rows = (this.exec?.allAttempts() ?? []) as AttemptRowLike[]
    rows.sort((x, y) => x.began.localeCompare(y.began))
    const readings = await Promise.all(rows.map(a => this.reading(a)))
    const sessionTotal = new Map<string, number>()
    const threads = new Set<string>()
    return rows.map((a, i) => {
      const r = readings[i]
      const harness = harnessOf(a.backend)
      let usd = r.usdTotal
      let adjusted: AttemptUsage['adjusted'] = null
      if (r.session && harness === 'claude_code' && usd !== null) {
        const before = sessionTotal.get(r.session)
        sessionTotal.set(r.session, usd)
        if (before !== undefined && usd >= before) { usd = Math.round((usd - before) * 1e6) / 1e6; adjusted = 'resumed' }
      }
      if (r.session && harness === 'codex') { if (threads.has(r.session)) adjusted = 'continued'; threads.add(r.session) }
      const state: UsageState = r.found ? 'measured' : a.state !== 'ended' ? 'running' : 'unknown'
      return {
        attempt: a.id, workspace: a.workspace, workflow: a.workflow, run: a.run, worker: a.worker, host: a.host, lane: a.lane,
        backend: a.backend, harness, model: r.model ?? modelOfBackend(a.backend), began: a.began, ended: a.ended,
        state, reason: state === 'measured' ? null : state === 'running' ? 'still running' : r.reason,
        tokens: r.tokens, usd: r.found ? usd : null, usdBasis: r.found ? r.usdBasis : null, session: r.session, adjusted,
      }
    })
  }

  private async relay(path: string): Promise<unknown> {
    const res = await this.fetcher(new URL(path, this.relayUrl), { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) })
    const data = await res.json().catch(() => null) as { error?: string } | null
    if (!res.ok) throw new Error(data?.error ?? `the relay answered ${res.status}`)
    if (!data || typeof data !== 'object') throw new Error('the relay returned an unreadable response')
    return data
  }

  private async source(path: string, ttl: number, cache: 'budget' | 'history', reduce: (v: unknown) => unknown): Promise<SourceState<unknown>> {
    const held = cache === 'budget' ? this.budgetCache : this.historyCache
    if (held && Date.now() - held.at < ttl) return held.value
    const at = new Date().toISOString()
    let value: SourceState<unknown>
    try {
      const data = reduce(await this.relay(path))
      value = { state: 'ok', at, data }
      if (cache === 'budget') this.budgetLast = { at, data }; else this.historyLast = { at, data }
    } catch (e) {
      const why = (e as Error).name === 'TimeoutError' ? `the relay did not answer within ${RELAY_TIMEOUT_MS / 1000} s` : (e as Error).message
      const last = cache === 'budget' ? this.budgetLast : this.historyLast
      value = { state: 'unavailable', at, error: `${path} on the agentroom relay: ${why}`, ...(last ? { last } : {}) }
    }
    if (cache === 'budget') this.budgetCache = { at: Date.now(), value }; else this.historyCache = { at: Date.now(), value }
    return value
  }

  budget() { return this.source('/budget', BUDGET_CACHE_MS, 'budget', v => v) }
  // The pre-WFE agents' records, reduced to what the history section draws.
  history() {
    return this.source('/cost', HISTORY_CACHE_MS, 'history', v => {
      const c = v as { generated_at?: number; totals?: Record<string, unknown>; table?: unknown[]; roots?: unknown[]; prices?: unknown }
      return { generated_at: c.generated_at ?? null, totals: c.totals ?? null, table: c.table ?? [], roots: c.roots ?? [], prices: c.prices ?? null }
    })
  }

  async usage(period: Period, now = new Date()): Promise<UsageResponse> {
    const [all, history] = await Promise.all([this.attempts(), this.history()])
    return { ...summarize(all, period, now), history }
  }
}

const endOf = (a: AttemptUsage) => Date.parse(a.ended ?? a.began)

export function startOf(period: Period, now: Date): number {
  if (period === 'all') return -Infinity
  if (period === 'today') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime() }
  return now.getTime() - (period === '7d' ? 7 : 30) * 86_400_000
}

export function totals(list: AttemptUsage[]): UsageTotals {
  const t: UsageTotals = { attempts: 0, measured: 0, running: 0, unknown: 0, tokens: zeroTokens(), usd: { 'api-equivalent': 0, reported: 0 }, withUsd: 0, withoutUsd: 0 }
  for (const a of list) {
    t.attempts++
    t[a.state]++
    if (a.state !== 'measured') continue
    if (a.tokens) addTokens(t.tokens, a.tokens)
    if (a.usd !== null && a.usdBasis) { t.usd[a.usdBasis] = Math.round((t.usd[a.usdBasis] + a.usd) * 1e6) / 1e6; t.withUsd++ } else t.withoutUsd++
  }
  return t
}

function grouped(list: AttemptUsage[], key: (a: AttemptUsage) => string, label: (a: AttemptUsage) => string, href?: (a: AttemptUsage) => string): UsageGroup[] {
  const by = new Map<string, AttemptUsage[]>()
  for (const a of list) { const k = key(a); by.set(k, [...(by.get(k) ?? []), a]) }
  return [...by.entries()].map(([k, g]) => ({ key: k, label: label(g[0]), ...(href ? { href: href(g[0]) } : {}), ...totals(g) }))
    .sort((x, y) => (y.usd['api-equivalent'] + y.usd.reported) - (x.usd['api-equivalent'] + x.usd.reported) || y.tokens.output - x.tokens.output || y.attempts - x.attempts)
}

const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export function summarize(all: AttemptUsage[], period: Period, now = new Date()): Omit<UsageResponse, 'history'> {
  // `all` is every attempt, also one whose times cannot be read.
  const inPeriod = (p: Period) => { if (p === 'all') return all; const from = startOf(p, now); return all.filter(a => endOf(a) >= from) }
  const chosen = inPeriod(period)
  const reasons: Record<string, number> = {}
  for (const a of all) if (a.state === 'unknown') reasons[a.reason ?? 'unknown'] = (reasons[a.reason ?? 'unknown'] ?? 0) + 1
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const days: UsageDay[] = []
  for (let back = DAYS - 1; back >= 0; back--) {
    const start = new Date(today); start.setDate(today.getDate() - back)
    const end = new Date(start); end.setDate(start.getDate() + 1)
    days.push({ day: dayKey(start.getTime()), ...totals(all.filter(a => endOf(a) >= start.getTime() && endOf(a) < end.getTime())) })
  }
  const cov = totals(all)
  return {
    schema: USAGE_SCHEMA, at: now.toISOString(), period,
    coverage: {
      attempts: cov.attempts, measured: cov.measured, running: cov.running, unknown: cov.unknown, reasons,
      since: all.length ? all[0].began : null, logsOnCoordinator: true,
      note: 'Every execution attempt in this area\'s exec store, read from its log on the coordinator (remote workers ship theirs). Subscription windows are read for this host\'s harness logins only.',
    },
    periods: Object.fromEntries(PERIODS.map(p => [p, totals(inPeriod(p))])) as Record<Period, UsageTotals>,
    days,
    groups: {
      project: grouped(chosen, a => a.workspace, a => a.workspace, a => `#/ws/${encodeURIComponent(a.workspace)}`),
      workflow: grouped(chosen, a => `${a.workspace}/${a.workflow}`, a => `${a.workspace} · ${a.workflow}`),
      model: grouped(chosen, a => `${a.harness ?? '?'}|${a.model ?? '?'}`, a => `${a.harness ?? 'unknown harness'} · ${a.model ?? 'model unknown'}`),
      worker: grouped(chosen, a => a.worker ?? a.host, a => a.worker ?? a.host),
    },
    attempts: [...chosen].reverse().slice(0, ATTEMPTS_SHOWN).map(a => ({ ...a })),
    attemptsShown: Math.min(chosen.length, ATTEMPTS_SHOWN),
  }
}
