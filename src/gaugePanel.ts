// The cost gauge (`gauge_panel`): its own window beside the operation room.
// Everything it draws is `/cost`, polled every 20 s — host files on the
// relay's side, so the poll costs the agents nothing.

import {
  HARNESS_ORDER, at, clock, compact, harnessHue, healthLine, loadCost, money, uncovered, usd,
  type Bucket, type CostBoard, type Day, type RecentRow,
} from './costState'
import { loadBudget, percentText, resetsIn, type BudgetBoard, type BudgetCard, type BudgetWindow } from './budgetState'
import './operationParts.css'
import './gaugePanel.css'

const POLL_MS = 20_000

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

function esc(text: string | null | undefined): string {
  return String(text ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
}

function kindChip(kind: string): string {
  return `<span class="kind-chip ${esc(kind)}">${esc(kind)}</span>`
}

// --- the budgets strip (`gauge_panel` ex1) --------------------------------------
// One card per harness: the plan, one meter per window (the harness's own
// slot colour, the percent always as text beside it), "resets in", and when
// it was read. A card that could not read says why in amber and greys its
// last good numbers, if it has any. Percent is what the vendor said; an
// absence is a `?`, never 0 or 100.

function meter(window: BudgetWindow, hue: string, stale = false): HTMLElement {
  const node = element('div', `budget-meter${stale ? ' stale' : ''}`)
  const percent = window.percent === null || window.percent === undefined ? null : Math.max(0, Math.min(100, window.percent))
  const severity = window.severity && window.severity !== 'normal' ? ` <span class="annotation">${esc(window.severity)}</span>` : ''
  node.innerHTML = `<span class="meter-label">${esc(window.label)}${severity}</span>
    <div class="meter-track" role="meter" aria-valuemin="0" aria-valuemax="100" ${percent === null ? '' : `aria-valuenow="${percent}"`} aria-label="${esc(window.label)} used"><div class="meter-fill" style="width:${percent ?? 0}%;background:${stale ? '#4e6984' : hue}"></div></div>
    <span class="meter-pct">${esc(percentText(window.percent))}</span>
    <span class="meter-reset">${window.resets_at ? `resets in ${esc(resetsIn(window.resets_at))}` : 'reset unknown'}</span>`
  return node
}

function budgetFooter(card: BudgetCard | NonNullable<BudgetCard['stale']>): string {
  const bits: string[] = []
  if (card.reset_credits && card.reset_credits.available) bits.push(`${card.reset_credits.available} reset credit${card.reset_credits.available === 1 ? '' : 's'} available`)
  if (card.credits && (card.credits.has || card.credits.unlimited)) bits.push(`credits: ${card.credits.unlimited ? 'unlimited' : card.credits.balance}`)
  if (card.extra_usage?.enabled) bits.push('extra usage enabled')
  if (typeof card.remaining_credits === 'number' && card.remaining_credits > 0) bits.push(`${card.remaining_credits} AI credits remaining`)
  if (card.credits_error) bits.push(`AI credits unknown: ${card.credits_error}`)
  return bits.join(' · ')
}

function budgetCard(harness: string, card: BudgetCard): HTMLElement {
  const hue = harnessHue(harness)
  const node = element('article', `budget-card${card.ok ? '' : ' unknown'}`)
  const plan = card.ok ? card.plan : card.stale?.plan ?? card.plan
  node.innerHTML = `<div class="budget-head"><span class="swatch" style="background:${hue}"></span><strong>${esc(harness)}</strong><span class="budget-plan">${esc(plan ?? 'plan unknown')}${card.tier ? ` · ${esc(card.tier)}` : ''}</span></div>`
  if (card.ok) {
    card.windows.forEach(window => node.append(meter(window, hue)))
  } else {
    const why = element('p', 'budget-error', `⚠ unknown — ${card.error ?? 'no reason given'}`)
    node.append(why)
    if (card.stale) {
      card.stale.windows.forEach(window => node.append(meter(window, hue, true)))
      node.append(element('small', 'budget-stale', `greyed: last good read ${clock(card.stale.read_at)}`))
    }
  }
  const foot = element('small', 'budget-foot')
  const read = card.ok ? `read ${clock(card.read_at)}` : `tried ${clock(card.read_at)}`
  const footer = budgetFooter(card.ok ? card : card.stale ?? card)
  foot.textContent = [read, footer, card.note ?? (card.ok ? '' : card.stale?.note ?? '')].filter(Boolean).join(' · ')
  node.append(foot)
  return node
}

function budgets(board: BudgetBoard | { error: string }): HTMLElement {
  const node = element('section', 'gauge-budgets')
  node.innerHTML = '<h2>Budgets <small>how much of each plan\'s window is used · read through the CLIs\' own routes, cached on the relay</small></h2>'
  if ('error' in board) {
    node.append(element('p', 'budget-error', `⚠ UNKNOWN — ${board.error}`))
    return node
  }
  const grid = element('div', 'budget-grid')
  const present = Object.keys(board.harnesses)
  const order = [...HARNESS_ORDER.filter(h => present.includes(h)), ...present.filter(h => !HARNESS_ORDER.includes(h)).sort()]
  order.forEach(harness => grid.append(budgetCard(harness, board.harnesses[harness])))
  node.append(grid)
  return node
}

// --- the tiles ---------------------------------------------------------------

function tile(label: string, bucket: Bucket): HTMLElement {
  const node = element('div', 'gauge-tile')
  node.innerHTML = `<small>${esc(label)}</small><strong>${esc(money(bucket))}</strong>
    <span>${bucket.runs} runs${bucket.failed ? ` · ${bucket.failed} failed` : ''} · ${compact(bucket.tokens_in)} in / ${compact(bucket.tokens_out)} out</span>
    <span class="uncovered">${esc(uncovered(bucket)) || 'every run priced'}</span>`
  return node
}

// --- the two day charts ------------------------------------------------------

type Measure = { key: string; value: (bucket: Bucket) => number; format: (value: number) => string }
const USD: Measure = { key: 'usd', value: b => b.usd_reported + b.usd_estimated, format: v => usd(v) }
const RUNS: Measure = { key: 'runs', value: b => b.runs, format: v => `${v} runs` }

function harnessesOf(days: Day[]): string[] {
  const seen = new Set<string>()
  days.forEach(day => Object.keys(day.by_harness).forEach(h => seen.add(h)))
  // Fixed order, then anything the palette does not know, alphabetically.
  return [...HARNESS_ORDER.filter(h => seen.has(h)), ...[...seen].filter(h => !HARNESS_ORDER.includes(h)).sort()]
}

function chart(title: string, days: Day[], measure: Measure, harnesses: string[], tooltip: HTMLElement): HTMLElement {
  const node = element('section', 'gauge-chart')
  node.innerHTML = `<h2>${esc(title)}</h2>`
  const max = Math.max(...days.map(day => measure.value(day)), 0)
  const plot = element('div', 'chart-plot')
  plot.setAttribute('role', 'img')
  plot.setAttribute('aria-label', `${title}, last ${days.length} days`)
  days.forEach(day => {
    const column = element('div', 'chart-column')
    const total = measure.value(day)
    const bar = element('div', 'chart-bar')
    // Stacked segments in fixed harness order, bottom-up; 2px surface gaps.
    harnesses.forEach(harness => {
      const bucket = day.by_harness[harness]
      const value = bucket ? measure.value(bucket) : 0
      if (value <= 0 || max <= 0) return
      const segment = element('div', 'chart-segment')
      segment.style.height = `${(value / max) * 100}%`
      segment.style.background = harnessHue(harness)
      segment.dataset.harness = harness
      segment.dataset.value = measure.format(value)
      bar.append(segment)
    })
    if (total > 0) column.append(element('span', 'chart-value', measure.key === 'usd' ? usd(total, total >= 10 ? 0 : 1) : String(total)))
    column.append(bar, element('span', 'chart-day', day.day.slice(5)))
    column.addEventListener('mousemove', event => {
      const lines = harnesses
        .map(h => ({ h, b: day.by_harness[h] }))
        .filter(x => x.b && measure.value(x.b) > 0)
        .map(x => `<span class="swatch" style="background:${harnessHue(x.h)}"></span>${esc(x.h)} ${esc(measure.format(measure.value(x.b)))}`)
      tooltip.innerHTML = `<strong>${esc(day.day)}</strong> ${esc(measure.format(total))}${lines.length ? '<br>' + lines.join('<br>') : ''}`
      tooltip.hidden = false
      tooltip.style.left = `${event.clientX + 14}px`
      tooltip.style.top = `${event.clientY + 14}px`
    })
    column.addEventListener('mouseleave', () => { tooltip.hidden = true })
    plot.append(column)
  })
  node.append(plot)
  return node
}

function legend(harnesses: string[]): HTMLElement {
  const node = element('div', 'chart-legend')
  harnesses.forEach(harness => {
    const item = element('span', 'legend-item')
    item.innerHTML = `<span class="swatch" style="background:${harnessHue(harness)}"></span>${esc(harness)}`
    node.append(item)
  })
  return node
}

// --- routines ------------------------------------------------------------------

function routines(board: CostBoard): HTMLElement {
  const node = element('section', 'gauge-routines')
  node.innerHTML = '<h2>Routine sessions <small>the sessions the operation room lists · cost is the runs matched to their conversations</small></h2>'
  const grid = element('div', 'routine-grid')
  board.routines.forEach(routine => {
    const card = element('article', 'routine-cost')
    const sessions = routine.sessions.slice(0, 3)
    card.innerHTML = `<h3>${esc(routine.name)}</h3>` + (sessions.length ? '' : '<p class="muted">no session listed</p>')
    sessions.forEach(session => {
      const row = element('div', 'session-cost')
      const agents = session.agents.map(agent =>
        `<li><span class="swatch" style="background:${harnessHue(agent.harness)}"></span>${esc(agent.instance)} · ${esc(agent.role)} · ${agent.runs} runs · ${esc(money(agent))}</li>`).join('')
      const guessed = session.attribution.window ? ` · ${session.attribution.window} of ${session.runs} matched by mtime window` : ''
      row.innerHTML = `<div class="session-head"><strong>${esc(session.stamp ?? session.topic)}</strong><span class="state-chip ${session.resolution === 'resolved' ? 'done' : 'awaiting'}">${esc(session.resolution ?? 'unknown')}</span></div>
        <div class="session-money">${esc(money(session))} <small>${session.runs} runs${esc(uncovered(session) ? ' · ' + uncovered(session) : '')}${esc(guessed)}</small></div>
        <ul class="session-agents">${agents || '<li class="muted">no run matched yet</li>'}</ul>
        <small class="muted">${session.conversations.map(c => `${esc(c.channel)} › ${esc(c.topic)} (${c.runs})`).join(' · ')}</small>`
      card.append(row)
    })
    grid.append(card)
  })
  node.append(grid)
  return node
}

// --- tables ----------------------------------------------------------------------

function table(board: CostBoard): HTMLElement {
  const node = element('section', 'gauge-table')
  node.innerHTML = '<h2>By instance and role <small>all records on this host</small></h2>'
  const rows = [...board.table].sort((a, b) => b.last_at - a.last_at)
  const wrap = element('div', 'table-wrap')
  wrap.innerHTML = `<table><thead><tr><th>Instance</th><th>Role</th><th>Harness</th><th>Model</th><th>Kind</th><th class="num">Runs</th><th class="num">Failed</th><th class="num">USD</th><th class="num">Tokens in</th><th class="num">Tokens out</th><th>Last run</th></tr></thead>
    <tbody>${rows.map(row => `<tr><td>${esc(row.instance)}</td><td>${esc(row.role)}</td><td><span class="swatch" style="background:${harnessHue(row.harness)}"></span>${esc(row.harness)}</td><td class="model">${esc(row.model)}</td><td>${kindChip(row.cost_kind)}</td><td class="num">${row.runs}</td><td class="num">${row.failed || ''}</td><td class="num">${esc(money(row))}</td><td class="num">${compact(row.tokens_in)}</td><td class="num">${compact(row.tokens_out)}</td><td>${esc(at(row.last_at))}</td></tr>`).join('')}</tbody></table>`
  node.append(wrap)
  return node
}

function recent(rows: RecentRow[]): HTMLElement {
  const node = element('section', 'gauge-recent')
  node.innerHTML = '<h2>Recent runs <small>newest first</small></h2>'
  const wrap = element('div', 'table-wrap')
  wrap.innerHTML = `<table><thead><tr><th>Ended</th><th>Instance</th><th>Role</th><th>Harness</th><th>Kind</th><th class="num">USD</th><th class="num">In</th><th class="num">Out</th><th class="num">Turns</th><th class="num">Duration</th><th>Outcome</th><th>Conversation</th></tr></thead>
    <tbody>${rows.map(row => `<tr class="${row.outcome === 'done' ? '' : 'failed'}"><td>${esc(clock(row.ended_at))}</td><td>${esc(row.instance)}</td><td>${esc(row.role)}</td><td><span class="swatch" style="background:${harnessHue(row.harness ?? '')}"></span>${esc(row.harness)}</td><td>${kindChip(row.cost_kind)}</td><td class="num">${esc(usd(row.cost_usd, 3))}</td><td class="num">${row.tokens ? compact(row.tokens.input + row.tokens.cached_input + row.tokens.cache_write) : '—'}</td><td class="num">${row.tokens ? compact(row.tokens.output) : '—'}</td><td class="num">${row.num_turns ?? '—'}</td><td class="num">${row.duration_ms ? `${Math.round(row.duration_ms / 1000)}s` : '—'}</td><td>${esc(row.outcome)}</td><td class="conversation">${row.channel ? `${esc(row.channel)} › ${esc(row.topic)}${row.attribution === 'window' ? ' <span class="muted">(by window)</span>' : ''}` : '<span class="muted">unattributed</span>'}</td></tr>`).join('')}</tbody></table>`
  node.append(wrap)
  return node
}

// --- the page --------------------------------------------------------------------

export async function initGaugePanel(): Promise<void> {
  document.title = 'agdevworld · cost gauge'
  const host = element('main', 'operation-parts gauge')
  host.innerHTML = `<header class="dashboard-header"><div><span class="eyebrow">AGDEVWORLD</span><h1>Cost gauge</h1></div><nav class="parts-toolbar"><a href="/">Operation room</a><span class="poll-note">polls /cost and /budget every ${POLL_MS / 1000}s</span><button class="refresh">Refresh</button></nav><p class="parts-health" role="status">Reading relay…</p></header><div class="gauge-body"></div>`
  const tooltip = element('div', 'chart-tooltip')
  tooltip.hidden = true
  document.body.append(host, tooltip)
  const health = host.querySelector<HTMLElement>('.parts-health')!
  const body = host.querySelector<HTMLElement>('.gauge-body')!
  let generation = 0

  async function refresh(): Promise<void> {
    const current = ++generation
    // Both on the same tick; the budget half never blanks the cost half.
    const [board, budget] = await Promise.all([loadCost(), loadBudget()])
    if (current !== generation) return
    if ('error' in board) {
      health.textContent = `⚠ UNKNOWN — ${board.error}. Everything below is the last thing read, not the state now.`
      health.classList.add('unknown')
      return
    }
    health.classList.remove('unknown')
    health.textContent = healthLine(board)
    const harnesses = harnessesOf(board.days)
    const tiles = element('div', 'gauge-tiles')
    tiles.append(tile('Today', board.totals.today), tile('Last 7 days', board.totals.days7), tile('Last 30 days', board.totals.days30), tile('All records', board.totals.all))
    const charts = element('div', 'gauge-charts')
    charts.append(
      chart('USD per day (reported + estimated)', board.days, USD, harnesses, tooltip),
      chart('Runs per day', board.days, RUNS, harnesses, tooltip),
    )
    // The page scrolls inside `main` (operation-parts is fixed), so keep the
    // reader where they were across a poll.
    const scroll = host.scrollTop
    body.replaceChildren(budgets(budget), tiles, legend(harnesses), charts, routines(board), table(board), recent(board.recent))
    host.scrollTop = scroll
  }

  host.querySelector('.refresh')!.addEventListener('click', () => void refresh())
  await refresh()
  setInterval(() => void refresh(), POLL_MS)
}
