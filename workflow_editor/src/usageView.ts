// Usage (retire_old_ui p1, #/usage): the subscription windows of this host's
// harness logins, and what this area's executions used — read from the exec
// store's attempts and their logs (server/usage.ts, docs/usage.md). Simple
// shows the windows, the period's totals with what they do not cover, and
// the projects; Detail adds every breakdown, the days, the executions with
// links to their runs, and the pre-WFE agents' records as history.
import { PERIODS, type AttemptUsage, type BudgetBoard, type HistoryBoard, type HistoryBucket, type Period, type SourceState, type UsageGroup, type UsageResponse, type UsageTotals } from '../shared/usage.ts'
import { api } from './api.ts'
import { h, when } from './dom.ts'
import { displayToggle } from './displayMode.ts'
import { icon } from './icons.ts'
import type { ViewHandle } from './main.ts'
import { siteLinks } from './site.ts'
import { budgetCards, compact, gaps, gapsShort, harnessHue, isoClock, plural, tokensIn, usd, usdLine } from './usageParts.ts'

const PERIOD_LABEL: Record<Period, string> = { today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All recorded' }
const PERIOD_KEY = 'workflow-editor.usage-period'
const POLL_MS = 60_000

const storedPeriod = (): Period => { try { const v = localStorage.getItem(PERIOD_KEY); return (PERIODS as readonly string[]).includes(v ?? '') ? v as Period : '7d' } catch { return '7d' } }
const storePeriod = (p: Period) => { try { localStorage.setItem(PERIOD_KEY, p) } catch { /* a per-viewer convenience */ } }

const runHref = (a: AttemptUsage) => `#/ws/${encodeURIComponent(a.workspace)}/run/${encodeURIComponent(a.workflow)}/${encodeURIComponent(a.run)}`

function figure(label: string, value: string, note?: string | HTMLElement | null, cls = ''): HTMLElement {
  return h(`div.u-figure${cls}`, h('span.u-figure-label', label), h('strong.u-figure-value', value), note ? h('span.u-figure-note.muted.small', note) : null)
}

export function periodFigures(t: UsageTotals): HTMLElement {
  const usdValue = t.withUsd ? usd(t.usd['api-equivalent'] + t.usd.reported) : '—'
  return h('div.u-figures',
    figure('Executions', String(t.attempts), t.attempts ? `${t.measured} measured` : 'none in this period'),
    figure('API-equivalent USD', usdValue, t.withUsd ? `list price over ${plural(t.withUsd, 'execution')}${t.usd.reported ? ` · ${usd(t.usd.reported)} reported without a basis` : ''} — not a charge` : 'no execution reported USD'),
    figure('Tokens', `${compact(tokensIn(t.tokens))} in · ${compact(t.tokens.output)} out`, `${compact(t.tokens.cached_input)} of the input from cache`),
    figure('Not covered', String(t.withoutUsd + t.unknown + t.running), gaps(t).join(' · ') || 'every execution carries USD', t.unknown || t.running ? '.attention' : ''))
}

function groupTable(title: string, groups: UsageGroup[], hint: string): HTMLElement {
  return h('section.card.u-table-card', h('h2', title), h('p.muted.small', `${hint} Not covered: tokens only (no per-run USD), unknown or running.`),
    groups.length ? h('div.u-scroll', h('table.u-table',
      h('thead', h('tr', h('th', ''), h('th.num', 'Executions'), h('th.num', 'API-equiv. USD'), h('th.num', 'Tokens in'), h('th.num', 'Tokens out'), h('th', 'Not covered'))),
      h('tbody', ...groups.map(g => h('tr',
        h('td', g.href ? h('a', { href: g.href }, g.label) : g.label),
        h('td.num', String(g.attempts)),
        h('td.num', g.withUsd ? usd(g.usd['api-equivalent'] + g.usd.reported) : '—'),
        h('td.num', compact(tokensIn(g.tokens))), h('td.num', compact(g.tokens.output)),
        h('td.small', gapsShort(g))))))) : h('p.muted', 'No execution in this period.'))
}

function dayTable(r: UsageResponse): HTMLElement {
  const max = Math.max(1, ...r.days.map(d => d.usd['api-equivalent'] + d.usd.reported))
  return h('section.card.u-table-card', h('h2', 'Days'), h('p.muted.small', 'The last 14 days by the end of each execution, local time. The bar is API-equivalent USD.'),
    h('div.u-scroll', h('table.u-table',
      h('thead', h('tr', h('th', 'Day'), h('th.num', 'Executions'), h('th', 'API-equivalent USD'), h('th.num', 'Tokens out'), h('th', 'Not covered'))),
      h('tbody', ...[...r.days].reverse().map(d => h('tr',
        h('td', d.day), h('td.num', String(d.attempts)),
        h('td', h('div.u-bar', h('div.u-bar-fill', { style: { width: `${((d.usd['api-equivalent'] + d.usd.reported) / max) * 100}%` } }), h('span', d.withUsd ? usd(d.usd['api-equivalent'] + d.usd.reported) : '—'))),
        h('td.num', compact(d.tokens.output)), h('td.small', gapsShort(d))))))))
}

function attemptsTable(r: UsageResponse): HTMLElement {
  return h('section.card.u-table-card', h('h2', 'Executions'),
    h('p.muted.small', `The ${plural(r.attemptsShown, 'newest execution')} of the period. Each is one attempt of a run on an execution node; a resumed session's USD is its own part of the session total.`),
    h('div.u-scroll', h('table.u-table.u-attempts',
      h('thead', h('tr', h('th', 'Ended'), h('th', 'Run'), h('th', 'Node'), h('th', 'Model'), h('th.num', 'Tokens in'), h('th.num', 'Tokens out'), h('th.num', 'USD'), h('th', 'Usage'))),
      h('tbody', ...r.attempts.map(a => h(`tr.u-${a.state}`, { dataset: { attempt: a.attempt } },
        h('td.small', when(a.ended ?? a.began)),
        h('td', h('a', { href: runHref(a) }, `${a.workspace} · ${a.workflow}/${a.run}`)),
        h('td.small', a.worker ?? a.host),
        h('td.small', h('span.swatch', { style: { background: harnessHue(a.harness ?? '') } }), ` ${a.model ?? a.backend ?? '—'}`),
        h('td.num', a.tokens ? compact(tokensIn(a.tokens)) : '—'), h('td.num', a.tokens ? compact(a.tokens.output) : '—'),
        h('td.num', a.usd !== null ? usd(a.usd) : '—'),
        h('td.small', a.state === 'measured' ? [a.usd === null ? 'tokens only' : a.usdBasis === 'api-equivalent' ? 'API-equivalent' : 'reported', a.adjusted === 'resumed' ? ' · resumed session' : a.adjusted === 'continued' ? ' · continued thread' : '']
          : h(`span.${a.state === 'running' ? 'muted' : 'warn-text'}`, a.state === 'running' ? 'running' : `unknown — ${a.reason ?? ''}`))))))))
}

const bucketUsd = (b: HistoryBucket) => (b.usd_reported || b.usd_estimated ? `${usd(b.usd_reported)}${b.usd_estimated ? ` + ~${usd(b.usd_estimated)} est.` : ''}` : '—')

function historySection(state: SourceState<HistoryBoard> | undefined): HTMLElement {
  const card = h('section.card.u-table-card.u-history', h('h2', 'History before workflow runs'),
    h('p.muted.small', 'The agents that ran outside workflow runs on this host (ag.agent-run.v1 records under their own roots, among them the retired Front). Kept readable as history; none of it is current activity. Their USD is the harness report (API-equivalent under a subscription) or an estimate from the price table.'))
  if (!state) return card
  const board = state.state === 'ok' ? state.data : state.last?.data
  if (state.state === 'unavailable') card.append(h('div.banner.warn', icon('alert', 'icon small'), state.error, state.last ? h('span.small', ` · last answer ${isoClock(state.last.at)}`) : null))
  if (!board?.totals) return card
  const all = board.totals.all
  card.append(h('p.small', `${plural(all.runs, 'run')} recorded · ${bucketUsd(all)} · ${compact(all.tokens_in)} tokens in, ${compact(all.tokens_out)} out · last 30 days: ${plural(board.totals.days30.runs, 'run')}`),
    h('div.u-scroll', h('table.u-table',
      h('thead', h('tr', h('th', 'Agent'), h('th', 'Role'), h('th', 'Model'), h('th.num', 'Runs'), h('th.num', 'USD'), h('th', 'Last run'))),
      h('tbody', ...[...board.table].sort((x, y) => y.last_at - x.last_at).map(t => h('tr',
        h('td', t.instance), h('td.small', t.role), h('td.small', `${t.harness}${t.model ? ` · ${t.model}` : ''}`),
        h('td.num', String(t.runs)), h('td.num', bucketUsd(t)), h('td.small', new Date(t.last_at * 1000).toLocaleDateString())))))),
    h('p.muted.small', `Roots: ${board.roots.map(r => `${r.instance} (${r.ok ? `${r.records} records` : 'not readable'})`).join(', ')}`))
  return card
}

export function renderUsageView(root: HTMLElement): ViewHandle {
  let period = storedPeriod()
  let data: UsageResponse | null = null
  let loadError = ''
  let budget: SourceState<BudgetBoard> | null = null
  let budgetError = ''
  let disposed = false
  let ctrl = new AbortController()

  const select = h('select.u-period', { 'aria-label': 'Period', onchange: () => { period = select.value as Period; storePeriod(period); data = null; render(); void load() } },
    ...PERIODS.map(p => h('option', { value: p, selected: p === period }, PERIOD_LABEL[p])))
  const header = h('header.topbar', h('div.crumbs', h('a', { href: '#/' }, 'agdev'), h('span.sep', '/'), h('span.muted', 'Usage')),
    h('div.top-actions', select, ...siteLinks('usage'), h('button.d-only', { onclick: () => { void load(); void loadBudget() } }, 'Refresh'), displayToggle()))
  const main = h('main.dashboard.usage-view')
  root.append(header, main)

  async function load() {
    const mine = ctrl
    try { const r = await api.usage(period, mine.signal); if (!disposed && r.period === period) { data = r; loadError = '' } } catch (e) { if (!mine.signal.aborted) loadError = (e as Error).message }
    if (!disposed) render()
  }
  async function loadBudget() {
    const mine = ctrl
    try { budget = await api.usageBudget(mine.signal); budgetError = '' } catch (e) { if (!mine.signal.aborted) budgetError = (e as Error).message }
    if (!disposed) render()
  }

  function render() {
    const windows = h('section.card.u-windows', h('div.card-head', h('h2', 'Subscription windows'), h('span.muted.small', 'This host\'s harness logins, as their vendors report them')),
      budgetCards(budget, budgetError, { detail: true }))
    const head = h('section.card.u-period-card', h('div.card-head', h('h2', `${PERIOD_LABEL[period]} — workflow executions`), data ? h('span.muted.small', `read ${isoClock(data.at)}`) : null))
    if (loadError) head.append(h('div.banner.error', icon('alert', 'icon small'), `Usage cannot be read: ${loadError}`, data ? ' — the figures below are from the last read.' : ''))
    if (!data) { head.append(h('p.muted', loadError ? '' : 'Reading…')); main.replaceChildren(windows, head); return }
    const cov = data.coverage
    const t = data.periods[period]
    head.append(periodFigures(t),
      h('p.small.u-coverage', icon(cov.unknown ? 'alert' : 'check', 'icon small'),
        `Coverage: ${plural(cov.attempts, 'execution')} recorded since ${cov.since ? when(cov.since) : '—'} — ${cov.measured} measured, ${cov.unknown} unknown, ${cov.running} running.`,
        Object.keys(cov.reasons).length ? h('span.muted', ` Unknown: ${Object.entries(cov.reasons).map(([k, n]) => `${k} (${n})`).join(', ')}.`) : null),
      h('p.muted.small', `${usdLine(t)}. ${cov.note} API-equivalent USD is the harness's list price for the tokens; under a subscription no money is charged per run.`))
    main.replaceChildren(windows, head,
      groupTable('Projects', data.groups.project, 'Executions by the project whose run they served.'),
      h('div.d-only.u-detail',
        h('div.u-two', groupTable('Workflows', data.groups.workflow, 'By project and workflow.'), groupTable('Harness and model', data.groups.model, 'The model is what the harness reported, else the profile\'s.')),
        groupTable('Execution nodes', data.groups.worker, 'Where each execution ran; remote nodes ship their logs to the coordinator.'),
        dayTable(data), attemptsTable(data), historySection(data.history as SourceState<HistoryBoard>)))
  }

  render()
  void load(); void loadBudget()
  // Polling stops with the view; a navigation aborts the reads in flight.
  const timer = setInterval(() => { void load(); void loadBudget() }, POLL_MS)
  return { dispose: () => { disposed = true; clearInterval(timer); ctrl.abort(); ctrl = new AbortController() }, isDirty: () => false }
}
