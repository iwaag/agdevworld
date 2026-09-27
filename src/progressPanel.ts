// The Front Room's progress panel (`progress_panel` p1).
//
// A DOM panel beside the conversation, shown and hidden with the `progress`
// toggle in the room's button row; whether it is open survives a reload.
// It lists every request in flight in *any* Front conversation as a card —
// the one open in the room pinned first — with a plan meter per plan, a
// small run band under each task, what each one waits for and whose move it
// is. Cards expand into their child work; each unit links to its evidence in
// Zulip, and a Front Desk card opens its conversation here.
//
// **Nothing here decides a state** (`progressState.ts`): the relay's
// `/progress` is pyagag's `agag.progress` read of the records, Observer's
// files and the health checks. What this file adds is only the drawing, and
// three drawing rules that keep it honest:
//
// - motion means fresh evidence of work: a band moves only for a unit whose
//   health check is current (`confirmed`), never for a claim read off a
//   conversation, and nothing moves while the board is stale or unreadable;
// - every state has its words and icon beside its colour;
// - the last board stays on screen when the relay stops answering, marked
//   as last known with its time — never a blank panel.
//
// Showing or hiding the panel starts nothing and stops nothing: it only
// decides whether this page asks the relay (a read of its memory) for the
// board. Work and Observer's monitoring go on either way.

import {
  ACTIVITY_WORDS,
  EVIDENCE_WORDS,
  STAGE_WORDS,
  STATE_WORDS,
  ageOf,
  clockOf,
  meterWords,
  segmentOf,
  since,
  titleOf,
  unitsOf,
  type ProgressBoard,
  type ProgressCard,
  type ProgressSource,
  type ProgressUnit,
  type Tone,
} from './progressState'

const STORE_KEY = 'agdevworld.progress.open'
const EXPANDED_KEY = 'agdevworld.progress.expanded'
const STYLE_ID = 'progress-panel-style'
const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Helvetica Neue", Arial, sans-serif'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const OPEN_REFRESH_MS = 8_000
const CLOSED_REFRESH_MS = 60_000

const TONE: Record<Tone, { fg: string; bg: string }> = {
  ok: { fg: '#0d0f14', bg: '#67e8a5' },
  live: { fg: '#0d0f14', bg: '#70c7ff' },
  wait: { fg: '#0d0f14', bg: '#ffc56d' },
  you: { fg: '#0d0f14', bg: '#ffb3d9' },
  bad: { fg: '#0d0f14', bg: '#ff8aa8' },
  unknown: { fg: '#f7f4ff', bg: '#5a5f78' },
  dim: { fg: '#dfe2f2', bg: '#343a52' },
}

function readStored(): boolean {
  try { return window.localStorage.getItem(STORE_KEY) === '1' } catch { return false }
}

function store(open: boolean) {
  try { window.localStorage.setItem(STORE_KEY, open ? '1' : '0') } catch { /* private window: per session only */ }
}

function readExpanded(): Set<number> {
  try { return new Set((JSON.parse(window.localStorage.getItem(EXPANDED_KEY) ?? '[]') as number[]).filter(Number.isFinite)) } catch { return new Set() }
}

function storeExpanded(expanded: Set<number>) {
  try { window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded].slice(-50))) } catch { /* per session only */ }
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  const tones = Object.entries(TONE).map(([tone, c]) => `#pg-panel .pg-chip.t-${tone}{color:${c.fg};background:${c.bg}}`).join('\n')
  style.textContent = `
#pg-toggle{position:fixed;z-index:31;font:12px ${MONO};color:#b9bdd6;background:#1b2030;border:1px solid #3a4060;border-radius:6px;padding:0 10px;cursor:pointer;white-space:nowrap}
#pg-toggle[aria-pressed="true"]{color:#0d0f14;background:#70c7ff;border-color:#70c7ff}
#pg-toggle:focus-visible{outline:2px solid #ffb3d9;outline-offset:1px}
#pg-toggle .pg-badge{display:inline-block;margin-left:6px;padding:0 5px;border-radius:8px;font-size:10.5px;color:#0d0f14;background:#ffb3d9}
#pg-toggle .pg-badge.bad{background:#ff8aa8}
#pg-panel{position:fixed;z-index:29;box-sizing:border-box;display:flex;flex-direction:column;background:rgba(13,15,20,0.96);border:1px solid #3a4060;border-radius:12px;color:#f7f4ff;font:13px/1.45 ${FONT};box-shadow:0 8px 28px rgba(0,0,0,0.45)}
#pg-panel[hidden]{display:none}
#pg-panel header{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid #262b3d}
#pg-panel header h2{margin:0;font:600 12px ${MONO};letter-spacing:2px;color:#70c7ff;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#pg-panel button{font:12px ${MONO};color:#dfe2f2;background:#1b2030;border:1px solid #3a4060;border-radius:6px;padding:2px 8px;cursor:pointer}
#pg-panel button:hover{border-color:#70c7ff}
#pg-panel button:focus-visible,#pg-panel a:focus-visible,#pg-panel summary:focus-visible{outline:2px solid #ffb3d9;outline-offset:1px}
#pg-panel .pg-status{font:11px ${MONO};color:#7d8199;padding:4px 10px;border-bottom:1px solid #262b3d}
#pg-panel .pg-status.warn{color:#ffc56d}
#pg-panel .pg-status.bad{color:#ff8aa8}
#pg-panel .pg-body{flex:1;overflow:auto;overflow-x:hidden;padding:6px 8px 10px}
#pg-panel h3{margin:10px 2px 4px;font:600 10.5px ${MONO};letter-spacing:2px;color:#7d8199}
#pg-panel .pg-card{border:1px solid #2b3148;border-radius:10px;padding:7px 9px;margin:6px 0;background:#11141d}
#pg-panel .pg-card.current{border-color:#70c7ff;box-shadow:0 0 0 1px rgba(112,199,255,.25) inset}
#pg-panel .pg-card.s-awaiting_you{border-color:#ffb3d9}
#pg-panel .pg-card.s-stopped{border-color:#ff8aa8}
#pg-panel .pg-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
#pg-panel .pg-title{font-weight:600;flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#pg-panel .pg-chip{display:inline-block;font:600 10.5px ${MONO};border-radius:4px;padding:1px 6px;white-space:nowrap}
${tones}
#pg-panel .pg-tag{display:inline-block;font:10.5px ${MONO};border:1px solid #3a4060;border-radius:4px;padding:0 5px;color:#b9bdd6;white-space:nowrap}
#pg-panel .pg-tag.cur{border-color:#70c7ff;color:#70c7ff}
#pg-panel .pg-tag.warn{border-color:#ffc56d;color:#ffc56d}
#pg-panel .pg-reason{color:#dfe2f2;margin:3px 0 0;word-break:break-word}
#pg-panel .pg-meta{font:11px ${MONO};color:#7d8199;word-break:break-word}
#pg-panel .pg-meta b{color:#b9bdd6;font-weight:600}
#pg-panel .pg-meter{margin:6px 0 2px}
#pg-panel .pg-meter-label{font:11px ${MONO};color:#b9bdd6;display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap}
#pg-panel .pg-bar{display:flex;gap:2px;height:10px;margin-top:3px}
#pg-panel .pg-seg{flex:1;border-radius:2px;background:#232838;border:1px solid #2f3550;position:relative;overflow:hidden}
#pg-panel .pg-seg.done{background:#67e8a5;border-color:#67e8a5}
#pg-panel .pg-seg.agreement{background:#ffc56d;border-color:#ffc56d}
#pg-panel .pg-seg.working{background:#2f6d95;border-color:#70c7ff}
#pg-panel .pg-seg.waiting{background:#6b5a2e;border-color:#ffc56d}
#pg-panel .pg-seg.stopped{background:#ff8aa8;border-color:#ff8aa8}
#pg-panel .pg-seg.unknown{background:repeating-linear-gradient(45deg,#3a3f50 0 4px,#23273a 4px 8px);border-color:#5a5f78}
#pg-panel .pg-planning{height:10px;margin-top:3px;border:1px dashed #70c7ff;border-radius:3px;font:9.5px/10px ${MONO};color:#70c7ff;text-align:center;letter-spacing:1px}
#pg-panel .pg-note{font:10.5px ${MONO};color:#ffc56d;margin-top:2px}
#pg-panel .pg-stages{display:flex;flex-wrap:wrap;gap:4px;margin:5px 0 1px}
#pg-panel .pg-stage{font:10.5px ${MONO};border-radius:4px;padding:0 5px;border:1px solid #3a4060;color:#7d8199;white-space:nowrap}
#pg-panel .pg-stage.done{border-color:#67e8a5;color:#67e8a5}
#pg-panel .pg-stage.pending{border-color:#ffc56d;color:#ffc56d}
#pg-panel details{margin-top:5px}
#pg-panel summary{cursor:pointer;font:11px ${MONO};color:#8dccff;list-style:none}
#pg-panel summary::-webkit-details-marker{display:none}
#pg-panel .pg-unit{border-left:2px solid #2b3148;margin:5px 0 0;padding:1px 0 2px 8px}
#pg-panel .pg-unit.k-task{margin-left:10px}
#pg-panel .pg-unit.k-plan,#pg-panel .pg-unit.k-routine_run{margin-left:4px}
#pg-panel .pg-unit-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
#pg-panel .pg-unit-label{font:12px ${MONO};color:#dfe2f2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
#pg-panel .pg-run{display:flex;align-items:center;gap:6px;margin:3px 0 0}
#pg-panel .pg-band{width:84px;height:6px;border-radius:3px;background:#232838;border:1px solid #2f3550;position:relative;overflow:hidden;flex:none}
#pg-panel .pg-band.active{background:#2f6d95;border-color:#70c7ff}
#pg-panel .pg-band.waiting{background:#6b5a2e;border-color:#ffc56d}
#pg-panel .pg-band.claimed{background:repeating-linear-gradient(90deg,#2f6d95 0 3px,#232838 3px 6px);border-color:#3a5d7a}
#pg-panel .pg-band.stopped{background:#ff8aa8;border-color:#ff8aa8}
#pg-panel .pg-band.unknown{background:repeating-linear-gradient(45deg,#3a3f50 0 3px,#23273a 3px 6px);border-color:#5a5f78}
#pg-panel .pg-band.ended{background:#343a52}
#pg-panel:not(.frozen) .pg-band.active.fresh::after,#pg-panel:not(.frozen) .pg-seg.working.fresh::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:pg-sweep 1.4s linear infinite}
#pg-panel:not(.frozen) .pg-band.waiting.fresh::after{content:"";position:absolute;inset:0;background:rgba(255,255,255,.35);animation:pg-pulse 2.6s ease-in-out infinite}
@keyframes pg-sweep{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
@keyframes pg-pulse{0%,100%{opacity:0}50%{opacity:1}}
@media (prefers-reduced-motion: reduce){#pg-panel .pg-band::after,#pg-panel .pg-seg::after{animation:none!important;display:none}}
#pg-panel a{color:#8dccff;text-decoration:none}
#pg-panel a:hover{text-decoration:underline}
#pg-panel .pg-links{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
#pg-panel .pg-empty{color:#7d8199;padding:12px 4px}
#pg-panel .pg-fail{color:#ff8aa8;font:11px ${MONO}}
`
  document.head.append(style)
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child)
  return node
}

function chip(state: ProgressUnit['display']['state'], small = false): HTMLElement {
  const words = STATE_WORDS[state] ?? STATE_WORDS.unknown
  const node = el('span', { className: `pg-chip t-${words.tone}`, textContent: `${words.icon} ${words.label}` })
  if (small) node.style.fontSize = '10px'
  node.setAttribute('data-state', state)
  return node
}

export interface ProgressPanelOptions {
  // The Front Desk conversation open in the room, asked at every read.
  current: () => string | null
  // Open a Front Desk conversation in the room.
  onOpen: (desk: string) => void
  // The panel was shown or hidden: the room lays itself out again.
  onVisibility: (open: boolean) => void
}

export class ProgressPanel {
  readonly toggle: HTMLButtonElement
  private readonly root: HTMLElement
  private readonly statusLine: HTMLElement
  private readonly body: HTMLElement
  private readonly source: ProgressSource
  private readonly options: ProgressPanelOptions
  private board: ProgressBoard | undefined
  private boardAt = 0
  private error: string | undefined
  private loading = false
  private timer: number | undefined
  private expanded = readExpanded()
  private asked = 0

  constructor(source: ProgressSource, options: ProgressPanelOptions) {
    this.source = source
    this.options = options
    ensureStyle()
    this.toggle = el('button', { id: 'pg-toggle', type: 'button', title: 'Show or hide the progress of every request in flight (every Front conversation)' })
    this.toggle.setAttribute('aria-controls', 'pg-panel')
    this.toggle.setAttribute('aria-pressed', 'false')
    this.toggle.addEventListener('mousedown', (event) => event.preventDefault())
    this.toggle.addEventListener('click', () => this.setOpen(!this.open))
    const refresh = el('button', { type: 'button', textContent: '⟳', title: 'Read the board again' })
    refresh.addEventListener('click', () => void this.load())
    const close = el('button', { type: 'button', textContent: '×', title: 'Hide (Esc)' })
    close.addEventListener('click', () => this.setOpen(false))
    this.statusLine = el('div', { className: 'pg-status' })
    this.statusLine.setAttribute('role', 'status')
    this.body = el('div', { className: 'pg-body' })
    this.root = el('section', { id: 'pg-panel', hidden: true },
      el('header', {}, el('h2', { textContent: 'PROGRESS' }), refresh, close), this.statusLine, this.body)
    this.root.setAttribute('aria-label', 'Progress of requests')
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); this.setOpen(false) }
    })
    document.body.append(this.toggle, this.root)
    this.renderToggle()
    this.schedule()
    if (readStored()) this.setOpen(true)
    else void this.load()
    const w = window as unknown as { __progress?: ProgressPanel }
    w.__progress = this
  }

  get open(): boolean {
    return this.root.hidden !== true
  }

  // For a driver or a test: what is on screen, as data.
  snapshot(): { open: boolean; cards: { title: string; state: string; current: boolean; meter: string[]; runs: string[] }[]; status: string; frozen: boolean } {
    return {
      open: this.open,
      status: this.statusLine.textContent ?? '',
      frozen: this.root.classList.contains('frozen'),
      cards: (this.board?.cards ?? []).map((card) => ({
        title: titleOf(card), state: card.state, current: Boolean(card.current),
        meter: unitsOf(card).filter((u) => u.meter?.known).map((u) => `${u.meter!.completed}/${u.meter!.total}`),
        runs: unitsOf(card).filter((u) => u.run).map((u) => `${u.label}:${u.run!.activity}/${u.run!.evidence}`),
      })),
    }
  }

  static widthFor(width: number, narrow: boolean): number {
    return narrow ? width : Math.min(460, Math.max(330, width * 0.34))
  }

  // The toggle sits right-aligned at `right` (the room's button row) or
  // left-aligned at `left` (the prompt bar, on a narrow screen); the panel
  // fills `rect`.
  place(toggle: { right?: number; left?: number; y: number; height: number }, rect: { x: number; y: number; width: number; height: number }) {
    const compactBefore = this.anchor?.left !== undefined
    this.anchor = toggle
    if (compactBefore !== (toggle.left !== undefined)) this.renderToggle()
    this.placeToggle()
    Object.assign(this.root.style, {
      left: `${Math.round(rect.x)}px`, top: `${Math.round(rect.y)}px`,
      width: `${Math.round(rect.width)}px`, height: `${Math.round(Math.max(160, rect.height))}px`,
    })
  }

  private anchor: { right?: number; left?: number; y: number; height: number } | undefined

  // Again whenever its words change: a badge makes it wider, and a
  // right-aligned toggle must grow to the left, not over its neighbour.
  private placeToggle() {
    const anchor = this.anchor
    if (!anchor) return
    Object.assign(this.toggle.style, { top: `${Math.round(anchor.y)}px`, height: `${Math.round(anchor.height)}px` })
    const width = this.toggle.getBoundingClientRect().width || 90
    this.toggle.style.left = `${Math.round(anchor.left ?? (anchor.right ?? width) - width)}px`
  }

  toggleWidth(): number {
    return this.toggle.getBoundingClientRect().width || 0
  }

  setOpen(open: boolean) {
    if (open === this.open) return
    this.root.hidden = !open
    this.toggle.setAttribute('aria-pressed', String(open))
    store(open)
    this.options.onVisibility(open)
    this.schedule()
    if (open) {
      this.render()
      void this.load()
    }
  }

  // The room switched conversations: the pinned card follows at once.
  currentChanged() {
    if (this.open) void this.load()
  }

  destroy() {
    window.clearInterval(this.timer)
    this.toggle.remove()
    this.root.remove()
  }

  private schedule() {
    window.clearInterval(this.timer)
    this.timer = window.setInterval(() => void this.load(), this.open ? OPEN_REFRESH_MS : CLOSED_REFRESH_MS)
  }

  // --- data --------------------------------------------------------------------

  private async load() {
    if (this.loading) return
    this.loading = true
    const asked = ++this.asked
    const current = this.options.current()
    const found = await this.source.board(current)
    this.loading = false
    if (asked !== this.asked) return
    if ('error' in found && !('cards' in found)) {
      this.error = found.error
    } else {
      this.error = undefined
      this.board = found as ProgressBoard
      this.boardAt = Date.now() / 1000
    }
    this.renderToggle()
    if (this.open) this.render()
  }

  // --- drawing -------------------------------------------------------------------

  private renderToggle() {
    const cards = this.board?.cards ?? []
    const you = cards.filter((c) => c.state === 'awaiting_you').length
    const bad = cards.filter((c) => c.state === 'stopped').length
    const active = cards.filter((c) => c.group !== 'recent').length
    // Compact at a narrow screen's left end.
    const compact = this.anchor?.left !== undefined
    this.toggle.replaceChildren(`▦${compact ? '' : ' progress'}${active ? ` ${active}` : ''}`)
    if (bad) this.toggle.append(el('span', { className: 'pg-badge bad', textContent: `■ ${bad}` }))
    if (you) this.toggle.append(el('span', { className: 'pg-badge', textContent: `✋ ${you}` }))
    this.toggle.setAttribute('aria-label', `progress: ${active} active${you ? `, ${you} need you` : ''}${bad ? `, ${bad} stopped` : ''}`)
    this.placeToggle()
  }

  private frozen(): boolean {
    return Boolean(this.error) || !this.board || this.board.source.mirror !== 'live'
  }

  private render() {
    const board = this.board
    const frozen = this.frozen()
    this.root.classList.toggle('frozen', frozen)
    // The status line: where the facts come from and how fresh they are.
    this.statusLine.className = 'pg-status'
    if (this.error && board) {
      this.statusLine.classList.add('warn')
      this.statusLine.textContent = `⚠ ${this.error} — showing the last board, read ${clockOf(this.boardAt)} (${since(this.boardAt)}); nothing below is current`
    } else if (this.error) {
      this.statusLine.classList.add('bad')
      this.statusLine.textContent = `✖ ${this.error}`
    } else if (board && board.source.mirror !== 'live') {
      this.statusLine.classList.add('warn')
      this.statusLine.textContent = `⚠ the realm's copy is ${board.source.mirror} (${board.source.reason}) — every card is last known`
    } else if (board) {
      const monitor = board.observer.monitor
      this.statusLine.textContent = `observed ${clockOf(board.generated_at)} · realm live · Observer ${monitor.state}`
        + ` · health checks: ${board.health.owners.length ? board.health.owners.join(', ') : 'none'} (others: conversation only)`
      if (monitor.state !== 'ok') this.statusLine.classList.add('warn')
    } else {
      this.statusLine.textContent = 'reading the board…'
    }
    this.body.replaceChildren()
    if (!board) {
      if (!this.error) this.body.append(el('div', { className: 'pg-empty', textContent: 'reading…' }))
      return
    }
    const current = board.cards.filter((c) => c.current)
    const active = board.cards.filter((c) => !c.current && c.group !== 'recent')
    const recent = board.cards.filter((c) => !c.current && c.group === 'recent')
    if (current.length) {
      this.body.append(el('h3', { textContent: 'THIS CONVERSATION' }))
      current.forEach((card) => this.body.append(this.card(card, frozen)))
    } else if (board.current_note && this.options.current()) {
      this.body.append(el('div', { className: 'pg-meta', textContent: `this conversation: ${board.current_note}` }))
    }
    this.body.append(el('h3', { textContent: `ACTIVE · ${active.length}` }))
    if (!active.length) this.body.append(el('div', { className: 'pg-empty', textContent: 'nothing else is in flight' }))
    active.forEach((card) => this.body.append(this.card(card, frozen)))
    if (recent.length) {
      this.body.append(el('h3', { textContent: `RECENT RESULTS · ${recent.length} (last ${board.bounds.recent_hours} h)` }))
      recent.forEach((card) => this.body.append(this.card(card, frozen)))
    }
  }

  private card(card: ProgressCard, frozen: boolean): HTMLElement {
    const node = el('article', { className: `pg-card s-${card.state}${card.current ? ' current' : ''}` })
    node.dataset.origin = String(card.origin)
    const top = el('div', { className: 'pg-top' }, chip(card.state),
      el('span', { className: 'pg-title', textContent: titleOf(card), title: `#front › ${card.live_topic} (request o${card.origin})` }))
    if (card.current) top.append(el('span', { className: 'pg-tag cur', textContent: 'open here' }))
    if (card.resolved) top.append(el('span', { className: 'pg-tag', textContent: '✔' }))
    if (card.stale) top.append(el('span', { className: 'pg-tag warn', textContent: 'last known' }))
    if (card.observer_held) top.append(el('span', { className: 'pg-tag warn', textContent: 'held by a person' }))
    node.append(top)
    node.append(el('div', { className: 'pg-reason', textContent: card.reason || '—' }))
    node.append(el('div', { className: 'pg-meta' },
      card.next ? el('b', { textContent: `next: ${card.next}` }) : '',
      card.next ? ' · ' : '',
      `last work ${since(card.latest_work_at)} · last post ${since(card.last_at)}`))
    // Plan meters, one per plan in the tree.
    for (const unit of unitsOf(card)) {
      if (unit.kind === 'plan' && unit.meter) node.append(this.meter(unit, frozen))
    }
    if (card.stages.length) {
      const stages = el('div', { className: 'pg-stages' })
      for (const stage of card.stages) {
        const mark = stage.status === 'done' ? '✓' : '…'
        const item = el('span', { className: `pg-stage ${stage.status}`, textContent: `${mark} ${STAGE_WORDS[stage.stage]}`, title: `${stage.label}: ${stage.detail}` })
        stages.append(item)
      }
      node.append(stages)
    }
    // The child work, expandable; remembered per request.
    if (card.root && card.root.children.length) {
      const details = el('details')
      details.open = this.expanded.has(card.origin)
      details.addEventListener('toggle', () => {
        if (details.open) this.expanded.add(card.origin)
        else this.expanded.delete(card.origin)
        storeExpanded(this.expanded)
      })
      const count = unitsOf(card).length - 1
      details.append(el('summary', { textContent: `▸ ${count} conversation${count === 1 ? '' : 's'} opened for it` }))
      for (const child of card.root.children) this.unit(details, child, card, frozen)
      node.append(details)
    }
    const links = el('div', { className: 'pg-links' })
    if (card.desk && !card.current) {
      const open = el('button', { type: 'button', textContent: 'open conversation', title: `Open front-desk-${card.desk} in this room` })
      open.addEventListener('click', () => this.options.onOpen(card.desk!))
      links.append(open)
    }
    const zulip = card.links[String(card.anchor)]
    if (zulip) links.append(el('a', { href: zulip, target: '_blank', rel: 'noopener', textContent: 'Zulip ↗' }))
    if (links.childElementCount) node.append(links)
    return node
  }

  private meter(unit: ProgressUnit, frozen: boolean): HTMLElement {
    const meter = unit.meter!
    const wrap = el('div', { className: 'pg-meter' })
    wrap.append(el('div', { className: 'pg-meter-label' },
      el('span', { textContent: unit.label }), el('span', { textContent: meterWords(meter) })))
    if (!meter.known || meter.total === null) {
      wrap.append(el('div', { className: 'pg-planning', textContent: 'PLANNING', title: 'no task is known yet: no percentage is shown' }))
    } else {
      const bar = el('div', { className: 'pg-bar' })
      bar.setAttribute('role', 'img')
      bar.setAttribute('aria-label', `${unit.label}: ${meterWords(meter)}`)
      const tasks = unit.children.filter((c) => c.kind === 'task' && c.display.state !== 'cancelled').sort((a, b) => a.serial - b.serial)
      ;(meter.segments ?? []).forEach((state, index) => {
        const task = tasks[index]
        const segment = segmentOf(state)
        const fresh = task?.execution.evidence === 'confirmed' && !frozen
        const seg = el('span', { className: `pg-seg ${segment}${fresh ? ' fresh' : ''}`,
          title: task ? `${task.label}: ${STATE_WORDS[task.display.state]?.label ?? task.display.state}${task.awaiting_agreement ? ' (result shown, awaiting agreement)' : ''} — ${task.display.reason}` : state })
        bar.append(seg)
      })
      wrap.append(bar)
    }
    if (meter.note) wrap.append(el('div', { className: 'pg-note', textContent: `⚑ ${meter.note}` }))
    return wrap
  }

  private unit(parent: HTMLElement, unit: ProgressUnit, card: ProgressCard, frozen: boolean) {
    const row = el('div', { className: `pg-unit k-${unit.kind}` })
    const kind = { plan: 'plan', task: 'task', run: 'run', routine_run: 'routine run', conversation: 'conversation', request: 'request' }[unit.kind]
    const top = el('div', { className: 'pg-unit-top' }, chip(unit.display.state, true),
      el('span', { className: 'pg-unit-label', textContent: `${kind}: ${unit.label}`, title: `#${unit.channel} › ${unit.topic}` }))
    if (unit.owner) top.append(el('span', { className: 'pg-meta', textContent: unit.owner }))
    if (unit.awaiting_agreement) top.append(el('span', { className: 'pg-tag warn', textContent: 'awaiting agreement' }))
    row.append(top)
    row.append(el('div', { className: 'pg-reason', textContent: unit.display.reason }))
    if (unit.run) row.append(this.run(unit, frozen))
    const facts: string[] = [`record: ${unit.work.record ?? '—'}`, `serving: ${unit.execution.serving}`, `holder: ${unit.holder}`]
    if (unit.display.next) facts.unshift(`next: ${unit.display.next}`)
    row.append(el('div', { className: 'pg-meta', textContent: facts.join(' · ') }))
    const recovery = unit.recovery
    if (recovery && (recovery.kind || recovery.held || recovery.retired)) {
      const words = recovery.held ? `held by a person — ${recovery.held_why ?? ''}`
        : recovery.retired ? `retired by a person — ${recovery.retired_why ?? ''}`
          : `Observer: ${recovery.kind} (${recovery.state}${recovery.unrecovered ? ', not recovered' : ''})${recovery.fact ? ` — ${recovery.fact}` : ''}`
      row.append(el('div', { className: 'pg-meta', textContent: words }))
    }
    for (const failure of unit.failures) row.append(el('div', { className: 'pg-fail', textContent: `! ${failure}` }))
    if (unit.execution.health_note) row.append(el('div', { className: 'pg-meta', textContent: unit.execution.health_note }))
    const link = card.links[String(unit.anchor)]
    if (link) row.append(el('div', { className: 'pg-links' }, el('a', { href: link, target: '_blank', rel: 'noopener', textContent: `#${unit.channel} › ${unit.topic} ↗` })))
    parent.append(row)
    for (const child of unit.children) this.unit(parent, child, card, frozen)
  }

  private run(unit: ProgressUnit, frozen: boolean): HTMLElement {
    const run = unit.run!
    const fresh = run.evidence === 'confirmed' && !frozen
    const band = el('span', { className: `pg-band ${run.activity}${fresh ? ' fresh' : ''}` })
    band.setAttribute('role', 'img')
    band.setAttribute('aria-label', `run ${ACTIVITY_WORDS[run.activity]}`)
    const health = unit.execution.health
    const evidence = run.evidence === 'conversation' ? EVIDENCE_WORDS.conversation
      : `${EVIDENCE_WORDS[run.evidence]} ${clockOf(health?.observed_at ?? run.observed_at)} (${ageOf(health?.age ?? null)} old)`
    const action = run.action ? `${run.action}${run.action_age !== null ? ` · ${ageOf(run.action_age)}` : ''}` : ''
    return el('div', { className: 'pg-run' }, band,
      el('span', { className: 'pg-meta', textContent: `${ACTIVITY_WORDS[run.activity]}${action ? ` — ${action}` : ''} · ${evidence}` }))
  }
}
