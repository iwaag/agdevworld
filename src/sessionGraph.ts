import { at, type RoutineDetail, type RoutineSession, type SessionNode } from './routineState'

const NS = 'http://www.w3.org/2000/svg'
const colors: Record<string, string> = {
  unknown: '#f4bd57', quiet: '#9caabd', stalled: '#ff8585', awaiting: '#72bbff',
  acked: '#d2adff', done: '#6ee0b0',
}
// A symbol beside every colour, so a state is readable without the legend
// and without colour vision. Chosen to be distinct at 12px.
const marks: Record<string, string> = {
  unknown: '?', quiet: '·', stalled: '⛔', awaiting: '⏳', acked: '✉', done: '✔',
}
export const topicKey = (node: { channel: string; topic: string }) => JSON.stringify([node.channel, node.topic])
export interface GraphPoint { key: string; x: number; y: number; node?: SessionNode }

// Two renderings of the same topology (`operation_room` p6). The layout
// walks the same tree either way; only the card box and the spacing differ,
// so a branch that is visible in one mode is visible in the other.
export type GraphMode = 'compact' | 'detailed'
export interface GraphMetrics { width: number; height: number; dx: number; dy: number; pad: number }
export const METRICS: Record<GraphMode, GraphMetrics> = {
  detailed: { width: 300, height: 170, dx: 360, dy: 196, pad: 24 },
  compact: { width: 168, height: 58, dx: 208, dy: 76, pad: 16 },
}

// Fixed readable cards, unbounded scroll surface. No scale-to-fit or hidden nodes
// at the outlier boundary. Parent identity comes exclusively from the relay.
export function graphLayout(
  session: RoutineSession,
  root: { channel: string; topic: string },
  metrics: GraphMetrics = METRICS.detailed,
): GraphPoint[] {
  const rootKey = topicKey(root)
  const children = new Map<string, SessionNode[]>()
  for (const node of session.nodes) {
    const key = topicKey(node.parent)
    children.set(key, [...(children.get(key) ?? []), node])
  }
  const points: GraphPoint[] = []
  const visited = new Set<string>()
  let row = 0
  function branch(key: string, depth: number, node?: SessionNode) {
    if (visited.has(key)) return
    visited.add(key)
    const firstRow = row
    points.push({ key, x: metrics.pad + depth * metrics.dx, y: metrics.pad + row * metrics.dy, node })
    for (const child of children.get(key) ?? []) branch(topicKey(child), depth + 1, child)
    // A whole subtree occupies its own vertical band. Its parent aligns with
    // the first child; unrelated branches never interleave in the next lane.
    if (row === firstRow) row++
  }
  branch(rootKey, 0)
  for (const node of session.nodes) {
    if (!visited.has(topicKey(node))) branch(topicKey(node), Math.max(1, node.depth), node)
  }
  return points
}

export function nodeEvidence(node: SessionNode): string {
  return node.rows.map(row => row.provenance?.short).filter(Boolean).join(' · ') ||
    (node.known === 'note-only' ? 'Unknown — linked topic has not been read' :
      node.rows.length ? 'Relay verdict — provenance unavailable; inspect rows' : 'Swept topic — no owed reply row')
}

// The short label of a compact card: the topic alone, cut to what the card
// holds. The full `channel / topic` is the tooltip, the accessible name and
// the selection readout, so nothing is lost — only deferred to a click.
export function shortLabel(topic: string, max = 22): string {
  return topic.length > max ? `${topic.slice(0, max - 1)}…` : topic
}

export function renderSessionGraph(
  host: HTMLElement,
  detail: RoutineDetail,
  session: RoutineSession,
  mode: GraphMode = 'detailed',
): void {
  const metrics = METRICS[mode]
  host.replaceChildren()
  host.classList.add('session-graph')
  host.dataset.mode = mode
  const note = document.createElement('p')
  note.textContent = `${session.nodes.length} linked conversations · scroll to explore · select a node for evidence. States are current topic observations, not historical session outcomes.`
  host.append(note)
  const bounds = document.createElement('p')
  bounds.className = 'graph-bounds'
  bounds.textContent = !session.truncation
    ? 'Reconstruction completeness unknown — this relay did not report its bounds.'
    : session.truncation.truncated
      ? `Truncated — reconstruction reached ${session.truncation.reasons.join(' / ')} bound (${session.truncation.max_nodes} nodes / ${session.truncation.max_depth} hops). More linked conversations are omitted.`
      : `Reconstructed within ${session.truncation.max_nodes}-node / ${session.truncation.max_depth}-hop bounds; unread linked topics can still be unknown.`
  if (!session.truncation || session.truncation.truncated) bounds.classList.add('annotation')
  host.append(bounds)
  const viewport = document.createElement('div')
  viewport.className = 'graph-viewport'
  viewport.tabIndex = 0
  viewport.setAttribute('aria-label', `Conversation flow, ${mode}, scrollable`)
  const surface = document.createElement('div')
  surface.className = `graph-surface ${mode}`
  const root = { channel: detail.chat.channel ?? 'front', topic: detail.routine.fire_topic ?? 'No fire topic' }
  const points = graphLayout(session, root, metrics)
  const width = Math.max(...points.map(p => p.x)) + metrics.width + metrics.pad + 2
  const height = Math.max(...points.map(p => p.y)) + metrics.height + metrics.pad
  surface.style.width = `${width}px`
  surface.style.height = `${height}px`
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height))
  svg.setAttribute('aria-hidden', 'true')
  const byKey = new Map(points.map(p => [p.key, p]))
  const mid = metrics.height / 2
  let missing = 0
  for (const point of points) {
    if (!point.node) continue
    const parent = byKey.get(topicKey(point.node.parent))
    if (!parent) { missing++; continue }
    const path = document.createElementNS(NS, 'path')
    const x = parent.x + metrics.width, y = parent.y + mid, end = point.y + mid
    const bend = Math.min(25, (point.x - x) / 2)
    path.setAttribute('d', `M${x},${y} C${x + bend},${y} ${point.x - bend},${end} ${point.x},${end}`)
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#688ba8'); path.setAttribute('stroke-width', '2')
    svg.append(path)
  }
  surface.append(svg)
  const selected = document.createElement('p')
  selected.className = 'graph-selected'
  selected.textContent = mode === 'compact'
    ? 'Compact cards show the topic, a state symbol and the state word; select one for its channel, full topic name and evidence.'
    : 'Select a card for its relay evidence.'
  const evidence = document.createElement('details')
  evidence.className = 'graph-evidence'
  const summary = document.createElement('summary'); summary.textContent = 'Node evidence'
  const pre = document.createElement('pre'); pre.textContent = 'Select a conversation to inspect the relay evidence.'
  evidence.append(summary, pre)
  for (const point of points) {
    const node = point.node
    const card = document.createElement('button')
    card.className = `graph-node ${mode}`
    card.style.left = `${point.x}px`; card.style.top = `${point.y}px`
    card.style.width = `${metrics.width}px`; card.style.height = `${metrics.height}px`
    const state = detail.health.state === 'live' ? node?.state ?? 'unknown' : 'unknown'
    card.style.borderColor = colors[state] ?? colors.unknown
    const label = node ? `${node.channel} / ${node.topic}` : `${root.channel} / ${root.topic}`
    card.title = `${label} · ${node ? state : 'session origin'}${node?.known === 'note-only' ? ' · not read' : ''}`
    card.dataset.topic = label
    card.dataset.state = node ? state : 'origin'
    card.setAttribute('aria-label', `${label}, ${node ? state : 'session origin'}`)
    const mark = node ? (marks[state] ?? '?') : '🔥'
    const provenanceText = detail.health.state !== 'live' ? `Unknown — ${detail.health.reason}; last known evidence available` :
      node ? nodeEvidence(node) : session.fire ? `Fire #${session.fire.message_id} · ${at(session.fire.at)}` : session.note ?? 'No dispatcher fire'
    if (mode === 'compact') {
      const icon = document.createElement('span'); icon.className = 'gn-icon'; icon.textContent = mark
      icon.style.color = node ? colors[state] : '#f4bd57'
      const text = document.createElement('span'); text.className = 'gn-text'
      const title = document.createElement('strong'); title.textContent = node ? shortLabel(node.topic) : 'Fire topic'
      const badge = document.createElement('small'); badge.textContent = node ? `${state}${node.known === 'note-only' ? ' · not read' : ''}` : 'session origin'
      badge.style.color = node ? colors[state] : '#f4bd57'
      text.append(title, badge)
      card.append(icon, text)
    } else {
      const title = document.createElement('strong'); title.textContent = label
      const badge = document.createElement('span'); badge.textContent = node ? `${mark} ${state}` : `${mark} Session origin`; badge.style.color = node ? colors[state] : '#f4bd57'
      const provenance = document.createElement('small')
      provenance.textContent = provenanceText
      card.append(title, badge, provenance)
    }
    card.onclick = () => {
      for (const other of surface.querySelectorAll('.graph-node')) other.setAttribute('aria-pressed', 'false')
      card.setAttribute('aria-pressed', 'true')
      selected.textContent = `Selected · ${label} · ${node ? state : 'session origin'} · ${provenanceText}`
      pre.textContent = JSON.stringify(node ?? { ...root, fire: session.fire, note: session.note }, null, 2)
      summary.textContent = `Node evidence · ${label}`
      evidence.open = true
    }
    surface.append(card)
  }
  if (missing) note.textContent += ` ${missing} parent links unavailable; no replacement edges invented.`
  viewport.append(surface); host.append(viewport, selected, evidence)
}
