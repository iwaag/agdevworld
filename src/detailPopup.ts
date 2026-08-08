// DOM overlay popup showing full details for a clicked panel. Same pattern as
// chatPanel.ts: absolutely-positioned sibling of the Phaser #app canvas.

import {
  deviceHardwareFacts,
  type ActualDeviceModel,
  type DriftDiff,
  type DriftTarget,
  type WorkspaceRow,
} from './clusterState'
import { gateText, iterationText, moneyText, type AutolabJobRow } from './autolabState'
import type { PanelSelection } from './views'

const POPUP_CSS = `
#detail-popup {
  position: absolute; top: 64px; bottom: 44px; right: 372px;
  width: min(540px, calc(100% - 460px)); min-width: 320px;
  display: none; flex-direction: column; box-sizing: border-box;
  background: rgba(16, 19, 28, 0.97); border: 1px solid #262b3d;
  border-radius: 16px; box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #f4f1ff; z-index: 9; overflow: hidden;
}
#detail-popup.open { display: flex; }
#detail-popup header {
  display: flex; align-items: baseline; gap: 10px; padding: 14px 18px 10px;
  border-bottom: 1px solid #1c2130;
}
#detail-popup header .dp-name { font-size: 18px; font-weight: 700; }
#detail-popup header .dp-kind {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; letter-spacing: 2px; color: #777a91;
}
#detail-popup header .dp-status {
  margin-left: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; letter-spacing: 2px; padding: 3px 10px; border-radius: 999px;
  border: 1px solid currentColor;
}
#detail-popup header .dp-close {
  border: none; background: none; color: #777a91; font-size: 16px;
  cursor: pointer; padding: 0 0 0 10px; line-height: 1;
}
#detail-popup header .dp-close:hover { color: #f4f1ff; }
#detail-body { flex: 1; overflow-y: auto; padding: 12px 18px 16px; }
#detail-body section { margin-bottom: 14px; }
#detail-body h3 {
  margin: 0 0 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; letter-spacing: 2px; color: #70c7ff; font-weight: 600;
}
.dp-kv { display: grid; grid-template-columns: max-content 1fr; gap: 3px 14px; font-size: 12.5px; }
.dp-kv dt { color: #9a9db5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.dp-kv dd { margin: 0; word-break: break-word; }
.dp-diff {
  border: 1px solid #262b3d; border-radius: 10px; padding: 8px 12px; margin-bottom: 8px;
  background: #12151f;
}
.dp-diff .dp-diff-head {
  display: flex; gap: 8px; align-items: baseline;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
}
.dp-diff .dp-sev { font-size: 10px; letter-spacing: 1px; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; }
.dp-sev.error { color: #ff8aa8; }
.dp-sev.warning { color: #ffc56d; }
.dp-sev.info { color: #70c7ff; }
.dp-sev.unknown { color: #b7b5d8; }
.dp-diff .dp-msg { font-size: 12.5px; color: #d9d6ef; margin: 5px 0 0; }
.dp-da { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
.dp-da.single { grid-template-columns: 1fr; }
.dp-da h4 {
  margin: 0 0 3px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px; letter-spacing: 2px; color: #9a9db5; font-weight: 600;
}
#detail-popup pre {
  margin: 0; padding: 7px 9px; background: #0c0e16; border: 1px solid #1c2130;
  border-radius: 8px; font-size: 11px; line-height: 1.45; overflow-x: auto;
  white-space: pre-wrap; word-break: break-word; color: #c3c7de; max-height: 240px; overflow-y: auto;
}
#detail-popup details summary {
  cursor: pointer; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; letter-spacing: 2px; color: #777a91; margin-bottom: 6px;
}
#detail-popup details summary:hover { color: #70c7ff; }
#detail-popup footer {
  padding: 10px 18px; border-top: 1px solid #1c2130; display: flex; justify-content: flex-end;
}
#dp-ask {
  border: none; border-radius: 10px; background: #70c7ff; color: #0d0f14;
  font-weight: 700; font-size: 13px; padding: 7px 16px; cursor: pointer;
}
#dp-ask:hover { background: #9ad8ff; }
`

const STATUS_COLOR: Record<string, string> = {
  converged: '#67e8a5',
  converging: '#70c7ff',
  drifting: '#ffc56d',
  unknown: '#b7b5d8',
  active_development: '#67e8a5',
  behind_origin: '#ffc56d',
  idle: '#b7b5d8',
}

let popup: HTMLDivElement | null = null
let body: HTMLDivElement | null = null
let headerName: HTMLSpanElement, headerKind: HTMLSpanElement, headerStatus: HTMLSpanElement
let currentKey: string | null = null
let currentSelection: PanelSelection | null = null
let askHandler: ((selection: PanelSelection) => void) | undefined
// When an outside-pointerdown closes the popup and the very same click's
// pointerup re-selects the same panel, treat it as a toggle: skip reopening.
let dismissed: { key: string; at: number } | null = null

function selectionKey(selection: PanelSelection): string {
  if (selection.view === 'nodes') {
    const t = selection.target.target
    return `nodes:${t.id ?? t.slug ?? t.name ?? 'unnamed'}`
  }
  if (selection.view === 'autolab') return `autolab:${selection.node}/${selection.job.name}`
  return `workspaces:${selection.row.slug}`
}

function selectionPayload(selection: PanelSelection): unknown {
  if (selection.view === 'nodes') return selection.target
  if (selection.view === 'autolab') return selection.job
  return selection.row
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function jsonPre(value: unknown): HTMLPreElement {
  return el('pre', undefined, JSON.stringify(value, null, 2))
}

function kvList(entries: Array<[string, unknown]>): HTMLDListElement {
  const dl = el('dl', 'dp-kv')
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === '') continue
    dl.append(el('dt', undefined, key))
    const rendered =
      typeof value === 'object' ? JSON.stringify(value) : String(value)
    dl.append(el('dd', undefined, rendered))
  }
  return dl
}

function ensurePopup(): HTMLDivElement {
  if (popup) return popup

  const style = document.createElement('style')
  style.textContent = POPUP_CSS
  document.head.append(style)

  popup = el('div')
  popup.id = 'detail-popup'
  const header = el('header')
  headerName = el('span', 'dp-name')
  headerKind = el('span', 'dp-kind')
  headerStatus = el('span', 'dp-status')
  const close = el('button', 'dp-close', '✕')
  close.addEventListener('click', hideDetailPopup)
  header.append(headerName, headerKind, headerStatus, close)
  body = el('div')
  body.id = 'detail-body'
  const footer = el('footer')
  const ask = el('button', undefined, 'Ask agent')
  ask.id = 'dp-ask'
  ask.addEventListener('click', () => {
    if (currentSelection) askHandler?.(currentSelection)
  })
  footer.append(ask)
  popup.append(header, body, footer)
  document.body.append(popup)

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideDetailPopup()
  })
  document.addEventListener('pointerdown', (event) => {
    if (!popup?.classList.contains('open')) return
    if (event.target instanceof Node && popup.contains(event.target)) return
    const key = currentKey
    hideDetailPopup()
    if (key) dismissed = { key, at: performance.now() }
  })

  return popup
}

export function hideDetailPopup(): void {
  popup?.classList.remove('open')
  currentKey = null
  currentSelection = null
}

// Called once from main.ts to wire the "Ask agent" button to the chat seam.
export function setAskHandler(handler: (selection: PanelSelection) => void): void {
  askHandler = handler
}

function renderDiff(diff: DriftDiff): HTMLDivElement {
  const box = el('div', 'dp-diff')
  const head = el('div', 'dp-diff-head')
  head.append(el('span', undefined, diff.code))
  const severity = diff.severity ?? 'unknown'
  head.append(el('span', `dp-sev ${severity}`, severity))
  box.append(head)
  if (diff.message) box.append(el('p', 'dp-msg', diff.message))

  const hasDesired = diff.desired !== undefined && diff.desired !== null
  const hasActual = diff.actual !== undefined && diff.actual !== null
  if (hasDesired || hasActual) {
    const grid = el('div', hasDesired && hasActual ? 'dp-da' : 'dp-da single')
    if (hasDesired) {
      const cell = el('div')
      cell.append(el('h4', undefined, 'DESIRED'), jsonPre(diff.desired))
      grid.append(cell)
    }
    if (hasActual) {
      const cell = el('div')
      cell.append(el('h4', undefined, 'ACTUAL'), jsonPre(diff.actual))
      grid.append(cell)
    }
    box.append(grid)
  }
  return box
}

// The intent_effect_summary diff carries the node's recorded intent under
// desired.node — surface that object prominently as a key/value list.
function intentEffectNode(target: DriftTarget): Record<string, unknown> | null {
  const diff = target.diffs.find((d) => d.code === 'intent_effect_summary')
  const desired = diff?.desired
  if (desired && typeof desired === 'object' && 'node' in desired) {
    const node = (desired as Record<string, unknown>).node
    if (node && typeof node === 'object') return node as Record<string, unknown>
  }
  return null
}

function renderHardware(device: ActualDeviceModel): void {
  const rows = deviceHardwareFacts(device)
  if (rows.length === 0) return
  const section = el('section')
  section.append(el('h3', undefined, 'HARDWARE'))
  section.append(kvList(rows))
  body!.append(section)
}

function renderNode(target: DriftTarget, device?: ActualDeviceModel): void {
  const name = target.target.slug ?? target.target.name ?? target.target.id ?? 'unnamed'
  headerName.textContent = String(name)
  headerKind.textContent = target.target.kind
  headerStatus.textContent = target.status.toUpperCase()
  headerStatus.style.color = STATUS_COLOR[target.status] ?? '#b7b5d8'

  const intentNode = intentEffectNode(target)
  if (intentNode) {
    const section = el('section')
    section.append(el('h3', undefined, 'INTENT'))
    section.append(kvList(Object.entries(intentNode)))
    body!.append(section)
  }

  if (device) renderHardware(device)

  const section = el('section')
  section.append(el('h3', undefined, `DIFFS (${target.diffs.length})`))
  if (target.diffs.length === 0) {
    section.append(el('p', 'dp-msg', 'No diffs — desired and actual state agree.'))
  }
  for (const diff of target.diffs) section.append(renderDiff(diff))
  body!.append(section)
}

function renderWorkspace(row: WorkspaceRow): void {
  headerName.textContent = row.name
  headerKind.textContent = `workspace @ ${row.node}`
  const activity = row.activity_class ?? 'unknown'
  headerStatus.textContent = activity.toUpperCase().replace(/_/g, ' ')
  headerStatus.style.color = STATUS_COLOR[activity] ?? '#b7b5d8'

  const section = el('section')
  section.append(el('h3', undefined, 'WORKSPACE'))
  section.append(
    kvList([
      ['slug', row.slug],
      ['node', row.node],
      ['desired presence', row.desired_presence],
      ['presence', row.presence],
      ['identity', row.identity],
      ['identity reason', row.identity_reason],
      ['activity', row.activity_class],
      ['activity reasons', row.activity_reasons],
      ['freshness', row.freshness],
      ['checked at', row.checked_at],
      ['gap codes', row.gap_codes.join(', ')],
    ]),
  )
  body!.append(section)
}

function renderJob(node: string, job: AutolabJobRow): void {
  headerName.textContent = job.name
  headerKind.textContent = `autolab job @ ${node}`
  const status = job.not_started ? 'not started' : (job.status ?? 'unknown')
  headerStatus.textContent = status.toUpperCase().replace(/_/g, ' ')
  headerStatus.style.color = STATUS_COLOR[status] ?? '#b7b5d8'

  const section = el('section')
  section.append(el('h3', undefined, 'JOB'))
  section.append(
    kvList([
      ['node', node],
      ['status', status],
      ['phase', job.phase],
      ['iteration', iterationText(job)],
      ['adapter', job.adapter],
      ['no progress', job.consecutive_no_progress],
      ['gates', gateText(job.last_gate_summary)],
      ['failing gates', job.last_gate_summary?.failing?.join('; ')],
      ['cost', moneyText(job.cost_usd)],
      ['iterations on disk', job.iterations_on_disk],
      ['job error', job.error],
      ['state error', job.state_error],
    ]),
  )
  body!.append(section)
}

export function showDetailPopup(selection: PanelSelection): void {
  const node = ensurePopup()
  const key = selectionKey(selection)

  // Same-panel re-click: the pointerdown already closed the popup — keep it
  // closed instead of instantly reopening.
  if (dismissed && dismissed.key === key && performance.now() - dismissed.at < 500) {
    dismissed = null
    return
  }
  dismissed = null

  body!.replaceChildren()
  if (selection.view === 'nodes') renderNode(selection.target, selection.device)
  else if (selection.view === 'autolab') renderJob(selection.node, selection.job)
  else renderWorkspace(selection.row)

  const rawSection = el('section')
  const raw = el('details')
  raw.append(el('summary', undefined, 'RAW JSON'))
  raw.append(jsonPre(selectionPayload(selection)))
  rawSection.append(raw)
  if (selection.view === 'nodes' && selection.device) {
    const rawFacts = el('details')
    rawFacts.append(el('summary', undefined, 'RAW FACTS (actual --detail)'))
    rawFacts.append(jsonPre(selection.device))
    rawSection.append(rawFacts)
  }
  body!.append(rawSection)

  currentKey = key
  currentSelection = selection
  node.classList.add('open')
  body!.scrollTop = 0
}
