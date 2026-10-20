// Usage pieces shared by the dashboard's summary and the Usage view
// (retire_old_ui p1): the words and numbers, and the subscription windows.
//
// What a figure is stays visible wherever it is drawn: API-equivalent USD is
// the harness's list price under a subscription, not a charge; an execution
// whose harness reports tokens only has no USD (never $0); unknown and
// running usage are counted and said, never folded into a total as zero.
import type { BudgetBoard, BudgetCard, BudgetWindow, SourceState, UsageTotals } from '../shared/usage.ts'
import { h } from './dom.ts'
import { icon } from './icons.ts'

// Fixed hue per harness (the dataviz slots the cost gauge used), so a harness
// keeps its colour wherever it appears.
const HARNESS_ORDER = ['claude_code', 'codex', 'agy', 'gemini_cli', 'agcode', 'opencode']
const HUES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300']
export const harnessHue = (harness: string) => HUES[HARNESS_ORDER.indexOf(harness)] ?? '#7d8794'
export const HARNESS_LABEL: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex', agy: 'Antigravity' }
export const harnessLabel = (harness: string) => HARNESS_LABEL[harness] ?? harness

// A window or reading older than this is drawn as stale (the relay asks a
// vendor at most once a minute; ten minutes means it has stopped answering).
export const STALE_SECONDS = 600

export const usd = (v: number) => `$${v >= 100 ? v.toFixed(0) : v.toFixed(2)}`
export function compact(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`
  return String(v)
}
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
export const clock = (epoch: number) => new Date(epoch * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
export const isoClock = (iso: string) => clock(Date.parse(iso) / 1000)

// "3 h 40 m" until a reset; "now" once it has passed; "unknown" without one.
export function resetsIn(resetsAt: number | null | undefined, now = Date.now() / 1000): string {
  if (!resetsAt) return 'reset unknown'
  const s = resetsAt - now
  if (s <= 0) return 'resets now'
  const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return `resets in ${d > 0 ? `${d} d ${hr} h` : hr > 0 ? `${hr} h ${m} m` : `${Math.max(m, 1)} m`}`
}

export const tokensIn = (t: UsageTotals['tokens']) => t.input + t.cached_input + t.cache_write

// The USD of a set of executions, by basis: API-equivalent first, a reported
// amount (no basis named) apart; none when nothing carries USD.
export function usdLine(t: UsageTotals): string {
  const parts: string[] = []
  if (t.usd['api-equivalent'] > 0 || (t.withUsd > 0 && t.usd.reported === 0)) parts.push(`${usd(t.usd['api-equivalent'])} API-equivalent`)
  if (t.usd.reported > 0) parts.push(`${usd(t.usd.reported)} reported`)
  return parts.length ? parts.join(' + ') : 'no USD reported'
}

// What the USD figure does not cover, so a small number never reads as cheap.
export function gaps(t: UsageTotals): string[] {
  const out: string[] = []
  if (t.withoutUsd) out.push(`${plural(t.withoutUsd, 'execution')} tokens only (subscription, no per-run USD)`)
  if (t.unknown) out.push(`${plural(t.unknown, 'execution')} with unknown usage`)
  if (t.running) out.push(`${plural(t.running, 'execution')} still running`)
  return out
}

// The same, short, for a table cell.
export function gapsShort(t: UsageTotals): string {
  return [t.withoutUsd ? `${t.withoutUsd} tokens only` : '', t.unknown ? `${t.unknown} unknown` : '', t.running ? `${t.running} running` : ''].filter(Boolean).join(' · ') || '—'
}

// ---- subscription windows ----------------------------------------------------------------

function meter(w: BudgetWindow, hue: string, stale: boolean): HTMLElement {
  const pct = w.percent === null || w.percent === undefined ? null : Math.max(0, Math.min(100, w.percent))
  const fill = h('div.meter-fill', { style: { width: `${pct ?? 0}%`, background: stale ? '#b0b5bd' : hue } })
  return h(`div.u-meter${stale ? '.stale' : ''}`,
    h('span.u-meter-label', w.label, w.severity && w.severity !== 'normal' ? h('span.chip.warn', w.severity) : null),
    h('div.meter-track', { role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', ...(pct === null ? {} : { 'aria-valuenow': String(pct) }), 'aria-label': `${w.label} used` }, fill),
    h('span.u-meter-pct', pct === null ? '?' : `${Math.round(w.percent!)}%`),
    h('span.u-meter-reset.muted', resetsIn(w.resets_at)))
}

function cardFoot(c: BudgetCard | NonNullable<BudgetCard['stale']>): string[] {
  const bits: string[] = []
  if (c.reset_credits?.available) bits.push(`${plural(c.reset_credits.available, 'reset credit')} available`)
  if (c.credits && (c.credits.has || c.credits.unlimited)) bits.push(`credits: ${c.credits.unlimited ? 'unlimited' : c.credits.balance}`)
  if (c.extra_usage?.enabled) bits.push('extra usage enabled')
  if (typeof c.remaining_credits === 'number' && c.remaining_credits > 0) bits.push(`${c.remaining_credits} AI credits remaining`)
  if (c.credits_error) bits.push(`AI credits unknown: ${c.credits_error}`)
  return bits
}

// One harness login: its plan, a meter per window (the percent always as text
// beside it), when each resets, and when it was read. A card that could not
// read says why and greys its last good numbers, if it has any.
export function budgetCard(c: BudgetCard, opts: { windows?: number; detail?: boolean } = {}): HTMLElement {
  const hue = harnessHue(c.harness)
  const now = Date.now() / 1000
  const shown = c.ok ? c : c.stale ?? null
  const old = c.ok && now - c.read_at > STALE_SECONDS
  const windows = shown ? (opts.windows ? shown.windows.slice(0, opts.windows) : shown.windows) : []
  return h(`article.u-budget${c.ok && !old ? '' : '.unknown'}`, { dataset: { harness: c.harness } },
    h('div.u-budget-head', h('span.swatch', { style: { background: hue } }), h('strong', harnessLabel(c.harness)), h('span.muted.small', [shown?.plan ?? c.plan ?? 'plan unknown', shown?.tier && opts.detail ? ` · ${shown.tier}` : ''].join(''))),
    c.ok ? null : h('p.u-why.warn', icon('alert', 'icon small'), `Unknown now — ${c.error ?? 'no reason given'}`),
    old ? h('p.u-why.warn', icon('alert', 'icon small'), `Stale: last read ${clock(c.read_at)}`) : null,
    ...windows.map(w => meter(w, hue, !c.ok || old)),
    shown && opts.windows && shown.windows.length > opts.windows ? h('p.muted.small', `${plural(shown.windows.length - opts.windows, 'more window')} in Usage`) : null,
    h('p.u-foot.muted.small', [c.ok ? `read ${clock(c.read_at)}` : c.stale ? `greyed: last good read ${clock(c.stale.read_at)} · tried ${clock(c.read_at)}` : `tried ${clock(c.read_at)}`,
      ...(opts.detail ? [...cardFoot(shown ?? c), c.source ? `source ${c.source}` : '', c.note ?? ''] : [])].filter(Boolean).join(' · ')))
}

// Every harness's card, or why there are none. The relay's own failure keeps
// the last answer greyed under its time; a provider's failure is its card's.
export function budgetCards(state: SourceState<BudgetBoard> | null, error: string, opts: { windows?: number; detail?: boolean } = {}): HTMLElement {
  const box = h('div.u-budgets')
  if (error) { box.append(h('div.banner.warn', icon('alert', 'icon small'), `Subscription windows cannot be read: ${error}`)); return box }
  if (!state) { box.append(h('p.muted', 'Reading subscription windows…')); return box }
  let board: BudgetBoard | null = state.state === 'ok' ? state.data : state.last?.data ?? null
  if (state.state === 'unavailable') {
    box.append(h('div.banner.warn', icon('alert', 'icon small'), `Subscription windows unavailable — ${state.error}`, state.last ? h('span.small', ` · showing the last answer, read ${isoClock(state.last.at)}`) : null))
    if (board) board = { ...board, harnesses: Object.fromEntries(Object.entries(board.harnesses).map(([k, c]) => [k, { ...c, ok: false, error: 'not read now', stale: c.ok ? c : c.stale ?? null }])) }
  }
  if (board) {
    const cards = Object.values(board.harnesses)
    box.append(cards.length ? h('div.u-budget-grid', ...cards.map(c => budgetCard(c, opts))) : h('p.muted', 'No harness login on this host reports a window.'))
  }
  return box
}
