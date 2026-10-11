// The graph canvas: DOM cards on a pannable, zoomable surface with SVG edges.
// It renders a workflow draft and reports user intents (select, move,
// connect) through callbacks; the view owns the draft.
import type { RepositoryStatus, WorkflowSummary } from '../shared/api.ts'
import { NODE_TYPES, normalizeRepoPath, type Point, type Workflow } from '../shared/model.ts'
import { h } from './dom.ts'
import { icon } from './icons.ts'
import { METRICS, PAD, positions, type DisplayMode } from '../shared/layout.ts'

const NS = 'http://www.w3.org/2000/svg'
export const TYPE_LABEL: Record<string, string> = { study: 'Study', do: 'Do', delegate: 'Delegate', talk: 'Talk' }
const EDGE_COLOR: Record<string, string> = { study: '#9aaedc', do: '#e2b867', delegate: '#9c84c4', talk: '#8fd3c0', unknown: '#a9afb8' }

export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; index: number } | null

export interface CanvasContext {
  repositories: RepositoryStatus[]
  workflows: WorkflowSummary[]
  errorNodes: Set<string>
  readonly: boolean
  // Run view: each node's recorded state, shown as text and color.
  run?: Record<string, { state: string; label: string; title?: string }>
}

export interface CanvasEvents {
  select(sel: Selection): void
  move(id: string, p: Point): void
  connect(from: string, to: string): void
}

const typeKey = (t: string) => ((NODE_TYPES as readonly string[]).includes(t) ? t : 'unknown')

export function bindingCategory(path: string): string {
  const p = normalizeRepoPath(path) ?? path
  if (p === '.') return 'folder'
  if (p === 'devdocs') return 'doc'
  if (p.startsWith('study/')) return 'study'
  if (p.startsWith('wedo/')) return 'do'
  return 'repo'
}

export class Canvas {
  readonly el: HTMLElement
  private surface: HTMLElement
  private svg: SVGSVGElement
  private view = { x: 0, y: 0, k: 1 }
  private draft!: Workflow
  private ctx!: CanvasContext
  private mode: DisplayMode = 'compact'
  private selection: Selection = null
  private points = new Map<string, Point>()
  private events: CanvasEvents
  private fitted = false

  constructor(events: CanvasEvents) {
    this.events = events
    this.svg = document.createElementNS(NS, 'svg')
    this.svg.classList.add('edges')
    this.surface = h('div.surface')
    this.surface.append(this.svg)
    this.el = h('div.canvas', { tabIndex: 0, 'aria-label': 'Workflow canvas' }, this.surface,
      h('div.zoom-controls',
        h('button', { title: 'Zoom in', onclick: () => this.zoomBy(1.2) }, '+'),
        h('button', { title: 'Zoom out', onclick: () => this.zoomBy(1 / 1.2) }, '−'),
        h('button', { title: 'Fit graph', onclick: () => this.fit() }, 'Fit')))
    this.installPanZoom()
    // Focus and scrollIntoView scroll even an overflow-hidden box. Turn such a
    // scroll into a pan so the surface, edges and controls stay consistent.
    this.el.addEventListener('scroll', () => {
      if (!this.el.scrollLeft && !this.el.scrollTop) return
      this.view.x -= this.el.scrollLeft; this.view.y -= this.el.scrollTop
      this.el.scrollLeft = 0; this.el.scrollTop = 0
      this.applyView()
    })
  }

  // Pans just enough to bring a card fully into view.
  reveal(id: string) {
    const card = this.surface.querySelector<HTMLElement>(`.node[data-id="${CSS.escape(id)}"]`)
    if (!card) return
    const c = card.getBoundingClientRect(), r = this.el.getBoundingClientRect(), m = 24
    let dx = 0, dy = 0
    if (c.right > r.right - m) dx = r.right - m - c.right
    if (c.left + dx < r.left + m) dx = r.left + m - c.left
    if (c.bottom > r.bottom - m) dy = r.bottom - m - c.bottom
    if (c.top + dy < r.top + m) dy = r.top + m - c.top
    if (dx || dy) { this.view.x += dx; this.view.y += dy; this.applyView() }
  }

  setMode(mode: DisplayMode) { this.mode = mode; this.el.dataset.mode = mode }
  getView() { return { ...this.view } }

  render(draft: Workflow, ctx: CanvasContext, selection: Selection) {
    this.draft = draft; this.ctx = ctx; this.selection = selection
    this.points = positions(draft)
    for (const old of this.surface.querySelectorAll('.node')) old.remove()
    const m = METRICS[this.mode]
    for (const [id, node] of Object.entries(draft.nodes)) {
      const p = this.points.get(id)!
      this.surface.append(this.card(id, node, p, m))
    }
    this.drawEdges()
    this.applyView()
    if (!this.fitted && this.el.isConnected) { this.fitted = true; requestAnimationFrame(() => this.fit()) }
  }

  // ---- cards ------------------------------------------------------------

  private bindingBadges(refs: string[]): HTMLElement {
    const box = h('div.badges')
    for (const ref of refs) {
      const b = this.draft.repositories[ref]
      const path = b ? normalizeRepoPath(b.path) : null
      const repo = path === '.' ? { initialized: true } : this.ctx.repositories.find(r => r.path === path)
      const unresolved = !b || !repo
      const cls = unresolved ? 'unresolved' : b.access === 'editable' ? 'editable' : 'readonly'
      const title = !b ? `binding "${ref}" is not declared` : !repo ? `${ref}: ${b.path} is not a repository of this project` : `${ref}: ${b.path} (${b.access})${repo.initialized ? '' : ' — not initialized here'}`
      box.append(h(`span.badge.${cls}`, { title }, icon(b ? bindingCategory(b.path) : 'alert', 'icon tiny'), h('span.badge-text', ref)))
    }
    return box
  }

  private card(id: string, node: Workflow['nodes'][string], p: Point, m: { width: number; height: number; scale: number }): HTMLElement {
    const t = typeKey(node.type)
    const selected = this.selection?.kind === 'node' && this.selection.id === id
    const title = node.name || TYPE_LABEL[t] || node.type || id
    const target = node.type === 'delegate' && node.workflow ? this.ctx.workflows.find(w => w.id === node.workflow) : undefined
    const card = h(`div.node.type-${t}${selected ? '.selected' : ''}${this.ctx.errorNodes.has(id) ? '.has-error' : ''}`, {
      dataset: { id },
      role: 'button',
      tabIndex: 0,
      'aria-label': `${TYPE_LABEL[t] ?? node.type} node ${title}`,
      title: `${id} · ${TYPE_LABEL[t] ?? node.type}\n${node.description}`,
      style: { left: `${p.x * m.scale}px`, top: `${p.y * m.scale}px`, width: `${m.width}px`, minHeight: `${m.height}px` },
    })
    const head = h('div.node-head', icon(t, 'icon type-icon'), h('span.type-label', TYPE_LABEL[t] ?? (node.type || 'no type')))
    card.append(head, h('div.node-title', title))
    const run = this.ctx.run?.[id]
    if (run) {
      card.classList.add('in-run', `run-${run.state}`)
      card.dataset.state = run.state
      card.setAttribute('aria-label', `${card.getAttribute('aria-label')}, ${run.label}`)
      card.append(h(`div.run-status.state-${run.state}`, { title: run.title ?? run.label }, run.label))
    }
    if (this.mode === 'compact') {
      if (node.type === 'delegate') {
        card.append(h(`div.delegate-target${target ? '' : '.missing'}`, '→ ', target ? (target.name || target.id) : node.workflow ? `${node.workflow} (missing)` : 'no target'))
        card.append(h('div.unsupported.small', { title: 'Delegate nodes are definition and display only; a run of this workflow is refused' }, 'execution not supported'))
      }
      card.append(h('div.node-desc', node.description || '—'))
    } else if (node.type === 'delegate') {
      card.append(h(`div.delegate-target.small${target ? '' : '.missing'}`, '→ ', target ? (target.name || target.id) : node.workflow || 'no target'))
    }
    if (node.repositories.length) card.append(this.bindingBadges(node.repositories))
    if (!this.ctx.readonly) card.append(h('span.port', { title: 'Drag to another node to connect', dataset: { port: id } }))
    this.installCardDrag(card, id)
    return card
  }

  // ---- edges ------------------------------------------------------------

  private anchor(id: string, side: 'out' | 'in'): Point {
    const m = METRICS[this.mode]
    const el = this.surface.querySelector<HTMLElement>(`.node[data-id="${CSS.escape(id)}"]`)
    const p = this.points.get(id) ?? { x: 0, y: 0 }
    const height = el?.offsetHeight || m.height
    return { x: p.x * m.scale + (side === 'out' ? m.width : 0), y: p.y * m.scale + height / 2 }
  }

  private drawEdges() {
    this.svg.replaceChildren()
    const defs = document.createElementNS(NS, 'defs')
    for (const [k, color] of Object.entries({ ...EDGE_COLOR, selected: '#3f6fd8' })) {
      const marker = document.createElementNS(NS, 'marker')
      marker.id = `arrow-${k}`
      for (const [a, v] of Object.entries({ viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' })) marker.setAttribute(a, v)
      const tip = document.createElementNS(NS, 'path')
      tip.setAttribute('d', 'M0,0 L10,5 L0,10 z'); tip.setAttribute('fill', color)
      marker.append(tip); defs.append(marker)
    }
    this.svg.append(defs)
    let maxX = 0, maxY = 0
    const m = METRICS[this.mode]
    for (const p of this.points.values()) { maxX = Math.max(maxX, p.x * m.scale + m.width); maxY = Math.max(maxY, p.y * m.scale + m.height * 2) }
    this.svg.setAttribute('width', String(maxX + PAD * 4)); this.svg.setAttribute('height', String(maxY + PAD * 4))
    this.draft.edges.forEach((e, i) => {
      if (!(e.from in this.draft.nodes) || !(e.to in this.draft.nodes)) return
      const a = this.anchor(e.from, 'out'), b = this.anchor(e.to, 'in')
      const bend = Math.max(30, Math.abs(b.x - a.x) / 2)
      const d = `M${a.x},${a.y} C${a.x + bend},${a.y} ${b.x - bend},${b.y} ${b.x - 2},${b.y}`
      const selected = this.selection?.kind === 'edge' && this.selection.index === i
      const color = selected ? 'selected' : typeKey(this.draft.nodes[e.from].type)
      const g = document.createElementNS(NS, 'g')
      g.classList.add('edge'); if (selected) g.classList.add('selected')
      g.dataset.index = String(i); g.dataset.from = e.from; g.dataset.to = e.to
      const hit = document.createElementNS(NS, 'path')
      hit.setAttribute('d', d); hit.classList.add('hit')
      const line = document.createElementNS(NS, 'path')
      line.setAttribute('d', d); line.classList.add('line')
      line.setAttribute('stroke', selected ? '#3f6fd8' : EDGE_COLOR[color])
      line.setAttribute('marker-end', `url(#arrow-${color})`)
      const title = document.createElementNS(NS, 'title'); title.textContent = `${e.from} → ${e.to}`
      g.append(title, hit, line)
      g.addEventListener('pointerdown', ev => { ev.stopPropagation(); this.events.select({ kind: 'edge', index: i }) })
      this.svg.append(g)
    })
  }

  // ---- interaction ------------------------------------------------------

  private toSurface(clientX: number, clientY: number): Point {
    const r = this.el.getBoundingClientRect()
    return { x: (clientX - r.left - this.view.x) / this.view.k, y: (clientY - r.top - this.view.y) / this.view.k }
  }

  private installCardDrag(card: HTMLElement, id: string) {
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.events.select({ kind: 'node', id }) } })
    card.addEventListener('pointerdown', e => {
      if (e.button !== 0) return
      e.stopPropagation()
      const port = (e.target as HTMLElement).closest('[data-port]')
      if (port) { this.startConnect(id, e); return }
      const m = METRICS[this.mode]
      const start = this.points.get(id)!
      const origin = this.toSurface(e.clientX, e.clientY)
      let moved = false
      card.setPointerCapture(e.pointerId)
      const move = (ev: PointerEvent) => {
        const cur = this.toSurface(ev.clientX, ev.clientY)
        const dx = (cur.x - origin.x) / m.scale, dy = (cur.y - origin.y) / m.scale
        if (!moved && Math.hypot(dx, dy) < 4) return
        if (this.ctx.readonly) return
        moved = true
        const p = { x: Math.round(start.x + dx), y: Math.round(start.y + dy) }
        this.points.set(id, p)
        card.style.left = `${p.x * m.scale}px`; card.style.top = `${p.y * m.scale}px`
        this.drawEdges()
      }
      const up = () => {
        card.removeEventListener('pointermove', move)
        card.removeEventListener('pointerup', up)
        card.removeEventListener('pointercancel', up)
        if (moved) this.events.move(id, this.points.get(id)!)
        else this.events.select({ kind: 'node', id })
      }
      card.addEventListener('pointermove', move)
      card.addEventListener('pointerup', up)
      card.addEventListener('pointercancel', up)
    })
  }

  private startConnect(from: string, e: PointerEvent) {
    const a = this.anchor(from, 'out')
    const temp = document.createElementNS(NS, 'path')
    temp.classList.add('connecting')
    this.svg.append(temp)
    const move = (ev: PointerEvent) => {
      const b = this.toSurface(ev.clientX, ev.clientY)
      temp.setAttribute('d', `M${a.x},${a.y} L${b.x},${b.y}`)
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      temp.remove()
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('.node')
      const to = target?.dataset.id
      if (to && to !== from) this.events.connect(from, to)
    }
    move(e)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  private installPanZoom() {
    this.el.addEventListener('pointerdown', e => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('.node, .zoom-controls, .edge')) return
      this.events.select(null)
      const start = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y }
      this.el.setPointerCapture(e.pointerId)
      this.el.classList.add('panning')
      const move = (ev: PointerEvent) => { this.view.x = start.vx + ev.clientX - start.x; this.view.y = start.vy + ev.clientY - start.y; this.applyView() }
      const up = () => { this.el.classList.remove('panning'); this.el.removeEventListener('pointermove', move); this.el.removeEventListener('pointerup', up) }
      this.el.addEventListener('pointermove', move)
      this.el.addEventListener('pointerup', up)
    })
    this.el.addEventListener('wheel', e => {
      e.preventDefault()
      // Pinch (reported with ctrlKey) or Ctrl/⌘ + wheel zooms; plain wheel pans.
      if (e.ctrlKey || e.metaKey) {
        this.zoomBy(Math.exp(-e.deltaY / 500), e.clientX, e.clientY)
      } else {
        this.view.x -= e.deltaX; this.view.y -= e.deltaY; this.applyView()
      }
    }, { passive: false })
  }

  zoomBy(factor: number, clientX?: number, clientY?: number) {
    const r = this.el.getBoundingClientRect()
    const cx = (clientX ?? r.left + r.width / 2) - r.left, cy = (clientY ?? r.top + r.height / 2) - r.top
    const k = Math.min(2.5, Math.max(0.25, this.view.k * factor))
    this.view.x = cx - (cx - this.view.x) * (k / this.view.k)
    this.view.y = cy - (cy - this.view.y) * (k / this.view.k)
    this.view.k = k
    this.applyView()
  }

  fit() {
    const cards = [...this.surface.querySelectorAll<HTMLElement>('.node')]
    const r = this.el.getBoundingClientRect()
    if (!cards.length || !r.width) { this.view = { x: 0, y: 0, k: 1 }; this.applyView(); return }
    const minX = Math.min(...cards.map(c => c.offsetLeft)), minY = Math.min(...cards.map(c => c.offsetTop))
    const maxX = Math.max(...cards.map(c => c.offsetLeft + c.offsetWidth)), maxY = Math.max(...cards.map(c => c.offsetTop + c.offsetHeight))
    const k = Math.min(1.2, (r.width - 80) / (maxX - minX || 1), (r.height - 80) / (maxY - minY || 1))
    this.view.k = Math.max(0.25, k)
    this.view.x = (r.width - (maxX - minX) * this.view.k) / 2 - minX * this.view.k
    this.view.y = (r.height - (maxY - minY) * this.view.k) / 2 - minY * this.view.k
    this.applyView()
  }

  // Where a new node should go: the centre of the visible area, in compact units.
  visibleCentre(): Point {
    const r = this.el.getBoundingClientRect()
    const c = this.toSurface(r.left + r.width / 2, r.top + r.height / 2)
    const s = METRICS[this.mode].scale
    return { x: Math.round(c.x / s - METRICS.compact.width / 2), y: Math.round(c.y / s - METRICS.compact.height / 2) }
  }

  private applyView() {
    this.surface.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.k})`
    this.el.style.backgroundPosition = `${this.view.x}px ${this.view.y}px`
    this.el.style.backgroundSize = `${22 * this.view.k}px ${22 * this.view.k}px`
  }
}
