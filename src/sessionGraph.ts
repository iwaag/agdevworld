import { at, type RoutineDetail, type RoutineSession, type SessionNode } from './routineState'

const NS = 'http://www.w3.org/2000/svg'
const colors: Record<string, string> = {
  unknown: '#f4bd57', quiet: '#9caabd', stalled: '#ff8585', awaiting: '#72bbff',
  acked: '#d2adff', done: '#6ee0b0',
}
export const topicKey = (node: { channel: string; topic: string }) => JSON.stringify([node.channel, node.topic])
export interface GraphPoint { key: string; x: number; y: number; node?: SessionNode }

// Fixed readable cards, unbounded scroll surface. No scale-to-fit or hidden nodes
// at the outlier boundary. Parent identity comes exclusively from the relay.
export function graphLayout(session: RoutineSession, root: { channel: string; topic: string }): GraphPoint[] {
  const lanes = new Map<number, number>()
  return [{ key: topicKey(root), x: 24, y: 24 }, ...session.nodes.map(node => {
    const lane = Math.max(1, node.depth)
    const row = lanes.get(lane) ?? 0
    lanes.set(lane, row + 1)
    return { key: topicKey(node), x: 24 + lane * 330, y: 24 + row * 158, node }
  })]
}

export function nodeEvidence(node: SessionNode): string {
  return node.rows.map(row => row.provenance?.short).filter(Boolean).join(' · ') ||
    (node.known === 'note-only' ? 'Unknown — linked topic has not been read' :
      node.rows.length ? 'Relay verdict — provenance unavailable; inspect rows' : 'Swept topic — no owed reply row')
}

export function renderSessionGraph(host: HTMLElement, detail: RoutineDetail, session: RoutineSession): void {
  host.replaceChildren()
  host.classList.add('session-graph')
  const note = document.createElement('p')
  note.textContent = `${session.nodes.length} linked conversations · scroll to explore · select a node for evidence. States are current topic observations, not historical execution stages.`
  host.append(note)
  const viewport = document.createElement('div')
  viewport.className = 'graph-viewport'
  viewport.tabIndex = 0
  viewport.setAttribute('aria-label', 'Conversation flow, scrollable')
  const surface = document.createElement('div')
  surface.className = 'graph-surface'
  const root = { channel: detail.chat.channel ?? 'front', topic: detail.routine.fire_topic ?? 'No fire topic' }
  const points = graphLayout(session, root)
  const width = Math.max(...points.map(p => p.x)) + 306
  const height = Math.max(...points.map(p => p.y)) + 158
  surface.style.width = `${width}px`
  surface.style.height = `${height}px`
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height))
  svg.setAttribute('aria-hidden', 'true')
  const byKey = new Map(points.map(p => [p.key, p]))
  let missing = 0
  for (const point of points) {
    if (!point.node) continue
    const parent = byKey.get(topicKey(point.node.parent))
    if (!parent) { missing++; continue }
    const path = document.createElementNS(NS, 'path')
    const x = parent.x + 280, y = parent.y + 65, end = point.y + 65
    path.setAttribute('d', `M${x},${y} C${x + 25},${y} ${point.x - 25},${end} ${point.x},${end}`)
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#688ba8'); path.setAttribute('stroke-width', '2')
    svg.append(path)
  }
  surface.append(svg)
  const evidence = document.createElement('details')
  evidence.className = 'graph-evidence'
  const summary = document.createElement('summary'); summary.textContent = 'Node evidence'
  const pre = document.createElement('pre'); pre.textContent = 'Select a conversation to inspect the relay evidence.'
  evidence.append(summary, pre)
  for (const point of points) {
    const node = point.node
    const card = document.createElement('button')
    card.className = 'graph-node'
    card.style.left = `${point.x}px`; card.style.top = `${point.y}px`
    const state = detail.health.state === 'live' ? node?.state ?? 'unknown' : 'unknown'
    card.style.borderColor = colors[state] ?? colors.unknown
    const label = node ? `${node.channel} / ${node.topic}` : `${root.channel} / ${root.topic}`
    card.title = label
    const title = document.createElement('strong'); title.textContent = label
    const badge = document.createElement('span'); badge.textContent = node ? state : 'Session origin'; badge.style.color = colors[state]
    const provenance = document.createElement('small')
    provenance.textContent = detail.health.state !== 'live' ? `Unknown — ${detail.health.reason}; last known evidence available` :
      node ? nodeEvidence(node) : session.fire ? `Fire #${session.fire.message_id} · ${at(session.fire.at)}` : session.note ?? 'No dispatcher fire'
    card.append(title, badge, provenance)
    card.onclick = () => {
      pre.textContent = JSON.stringify(node ?? { ...root, fire: session.fire, note: session.note }, null, 2)
      evidence.open = true
    }
    surface.append(card)
  }
  if (missing) note.textContent += ` ${missing} parent links unavailable; no replacement edges invented.`
  viewport.append(surface); host.append(viewport, evidence)
}
