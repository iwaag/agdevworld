// DOM overlay popup showing full details for a clicked panel. Same pattern as
// chatPanel.ts: absolutely-positioned sibling of the Phaser #app canvas.

import {
  deviceHardwareFacts,
  type ActualDeviceModel,
  type DriftDiff,
  type DriftTarget,
  type WorkspaceRow,
} from './clusterState'
import {
  gateText,
  iterationText,
  loadAutolabJob,
  loadIterationSummary,
  moneyText,
  requestIterationSummary,
  type AutolabIteration,
  type AutolabJobRow,
  type AutolabProject,
  type AutolabSummary,
} from './autolabState'
import { postedAt, type RoomAgent, type RoomWorkRow } from './agentRoomState'
import { ago, at, healthLine, type OpsBoard, type OpsInstance, type OpsRow } from './opsState'
import {
  routineDetail,
  type InflightBoard,
  type RoutineDetail,
  type RoutineRow,
  type SessionNode,
} from './routineState'
import type { PanelSelection } from './views'
import { openCompletionPanel } from './completionPanel'

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
.dp-iter {
  border: 1px solid #262b3d; border-radius: 10px; padding: 8px 12px; margin-bottom: 8px;
  background: #12151f;
}
.dp-iter-head { display: flex; align-items: baseline; gap: 10px; }
.dp-iter-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #f4f1ff;
}
.dp-iter-meta {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #9a9db5;
}
.dp-iter-btn {
  margin-left: auto; border: 1px solid #2c3450; border-radius: 8px; background: #1b2030;
  color: #70c7ff; font-size: 11px; padding: 3px 10px; cursor: pointer; white-space: nowrap;
}
.dp-iter-btn:hover:enabled { background: #232a3d; }
.dp-iter-btn:disabled { color: #777a91; cursor: default; }
.dp-summary.collapsed { display: none; }
.dp-summary-text {
  margin: 8px 0 0; font-size: 13px; line-height: 1.55; color: #e8e5f7; white-space: pre-wrap;
}
.dp-summary-meta {
  margin: 6px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px; color: #777a91;
}
.dp-summary-error { margin: 8px 0 0; font-size: 12.5px; color: #ff8aa8; }
.dp-iter-ask {
  margin-top: 8px; border: none; border-radius: 8px; background: #232a3d; color: #70c7ff;
  font-size: 11.5px; padding: 5px 11px; cursor: pointer;
}
.dp-iter-ask:hover { background: #2c3450; }
.dp-node {
  border-left: 2px solid #262b3d; padding: 5px 0 5px 10px; margin: 0 0 6px 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
}
.dp-node .dp-node-name { color: #f4f1ff; word-break: break-all; }
.dp-node .dp-node-meta { color: #777a91; font-size: 10.5px; display: block; margin-top: 2px; }
.dp-node .dp-node-state { font-size: 10px; letter-spacing: 1px; padding: 1px 7px;
  border-radius: 999px; border: 1px solid currentColor; margin-right: 6px; }
.dp-session { border: 1px solid #262b3d; border-radius: 10px; padding: 9px 12px;
  margin-bottom: 9px; background: #12151f; }
.dp-session-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 7px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: #c3c7de; }
.dp-session-head .dp-session-when { color: #777a91; font-size: 10.5px; margin-left: auto; }
.dp-flight { color: #67e8a5; }
.dp-flight.idle { color: #777a91; }
.dp-flight.unknown { color: #ffc56d; }
.dp-finish {
  margin-left: auto; border: 1px solid #3d7a5e; border-radius: 8px; background: #1b2030;
  color: #67e8a5; font-size: 11px; padding: 2px 9px; cursor: pointer; white-space: nowrap;
}
.dp-finish:hover { background: #232a3d; }
.dp-topic-row { display: flex; align-items: center; gap: 8px; margin: 5px 0 0; }
.dp-topic-row .dp-msg { margin: 0; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dp-topic-row .dp-resolved { color: #777a91; font-size: 10px; letter-spacing: 1px; }
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
let askButton: HTMLButtonElement | undefined
// When an outside-pointerdown closes the popup and the very same click's
// pointerup re-selects the same panel, treat it as a toggle: skip reopening.
let dismissed: { key: string; at: number } | null = null

function selectionKey(selection: PanelSelection): string {
  if (selection.view === 'nodes') {
    const t = selection.target.target
    return `nodes:${t.id ?? t.slug ?? t.name ?? 'unnamed'}`
  }
  if (selection.view === 'autolab') return `autolab:${selection.node}/${selection.job.name}`
  if (selection.view === 'agent-room') return `agent-room:${selection.agent.instance}`
  if (selection.view === 'agent-room-board') return `agent-room-board:${selection.group}`
  if (selection.view === 'autolab-project') {
    return `autolab-project:${selection.node}/${selection.project.name}`
  }
  if (selection.view === 'ops-row') {
    return `ops-row:${selection.row.instance}/${selection.row.channel}/${selection.row.topic}`
  }
  if (selection.view === 'ops-instance') return `ops-instance:${selection.instance.instance}`
  if (selection.view === 'ops-health') return 'ops-health'
  if (selection.view === 'routine') return `routine:${selection.routine.name}`
  return `workspaces:${selection.row.slug}`
}

function selectionPayload(selection: PanelSelection): unknown {
  if (selection.view === 'agent-room') return { agent: selection.agent, open: selection.work }
  if (selection.view === 'agent-room-board') return selection.rows
  if (selection.view === 'nodes') return selection.target
  if (selection.view === 'autolab') return selection.job
  if (selection.view === 'autolab-project') {
    return { project: selection.project, profiles: selection.profiles }
  }
  if (selection.view === 'ops-row') return selection.row
  if (selection.view === 'ops-instance') return selection.instance
  if (selection.view === 'ops-health') return selection.board.health
  if (selection.view === 'routine') {
    return { routine: selection.routine, sessions: selection.detail?.sessions ?? null }
  }
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

// The completion door (`front_desk` p4): previews first, in the shared
// overlay; the relay decides what the request owns. A task topic is told
// which request to go to instead. The popup stays open underneath.
function finishButton(channel: string, topic: string): HTMLButtonElement {
  const button = el('button', 'dp-finish', 'finish ✔')
  button.title = `preview what finishing #${channel} › ${topic} would change`
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    openCompletionPanel({ channel, topic })
  })
  return button
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
  // "Ask Front", not "Ask agent": the embedded assistant this button used to
  // reach was deleted in `modernize_agdevworld` p1, and the only conversation
  // this application can now reach is a routine's own topic with Front. The
  // button composes a message; a human sends it, because sending buys a run.
  const ask = el('button', undefined, 'Ask Front')
  ask.id = 'dp-ask'
  ask.addEventListener('click', () => {
    if (currentSelection) askHandler?.(currentSelection)
  })
  footer.append(ask)
  askButton = ask
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

function iterationLine(entry: AutolabIteration): string {
  const gates = entry.gates?.length
    ? `${entry.gates.filter((gate) => gate.exit_code === 0).length}/${entry.gates.length} gates`
    : undefined
  return [
    typeof entry.exit_code === 'number' ? `exit ${entry.exit_code}` : undefined,
    entry.is_error ? 'errored' : undefined,
    entry.timed_out ? 'timed out' : undefined,
    typeof entry.num_turns === 'number' ? `${entry.num_turns} turns` : undefined,
    gates,
    moneyText(entry.cost_usd),
  ]
    .filter(Boolean)
    .join(' · ')
}

// One iteration row: the numbers from the envelope, and a summary the user can
// ask for. The summary itself is produced on the node — this side never sees
// the evidence files it was written from.
function renderIteration(node: string, job: string, entry: AutolabIteration): HTMLDivElement {
  const box = el('div', 'dp-iter')
  const head = el('div', 'dp-iter-head')
  head.append(el('span', 'dp-iter-name', entry.iter))
  head.append(el('span', 'dp-iter-meta', iterationLine(entry)))
  const button = el('button', 'dp-iter-btn')
  head.append(button)
  box.append(head)
  const out = el('div', 'dp-summary')
  box.append(out)

  let state: 'idle' | 'loading' | 'done' | 'error' = 'idle'

  function setButton() {
    button.textContent =
      state === 'loading' ? 'summarizing…' : state === 'done' ? 'summary ↑' : 'summary'
    button.disabled = state === 'loading'
  }

  function showSummary(result: AutolabSummary) {
    state = 'done'
    setButton()
    out.replaceChildren()
    // Unabridged, verbatim: this text is Claude's, and re-summarizing it
    // through the small local model would lose exactly what it is for.
    out.append(el('p', 'dp-summary-text', result.summary ?? ''))
    const cost = moneyText(result.summarizer?.cost_usd)
    if (cost) out.append(el('p', 'dp-summary-meta', `summarizer cost ${cost}`))
    const ask = el('button', 'dp-iter-ask', 'Ask agent about this iteration')
    ask.addEventListener('click', () => {
      if (currentSelection?.view !== 'autolab') return
      currentSelection.summary = { iter: entry.iter, text: result.summary ?? '' }
      askHandler?.(currentSelection)
    })
    out.append(ask)
  }

  function fail(message: string) {
    state = 'error'
    setButton()
    out.replaceChildren(el('p', 'dp-summary-error', message))
  }

  // Pending is the normal case for a first request: a paid Claude run takes
  // ~15 s. Poll it the way the forge image flow does, and keep saying so.
  async function poll(attempt: number) {
    if (currentKey !== `autolab:${node}/${job}`) return
    if (attempt > 40) return fail('the summarizer is still running after two minutes — try again later')
    try {
      const result = await loadIterationSummary(node, job, entry.iter)
      if (result.status === 'done') return showSummary(result)
      if (result.status === 'error') return fail(result.error ?? 'the summarizer failed on the node')
      window.setTimeout(() => void poll(attempt + 1), 3000)
    } catch (error) {
      fail(error instanceof Error ? error.message : 'summary request failed')
    }
  }

  button.addEventListener('click', async () => {
    if (state === 'done') {
      out.classList.toggle('collapsed')
      return
    }
    state = 'loading'
    setButton()
    out.replaceChildren(el('p', 'dp-summary-meta', 'asking the node to summarize this iteration…'))
    try {
      const result = await requestIterationSummary(node, job, entry.iter)
      if (result.status === 'done') return showSummary(result)
      if (result.status === 'error') return fail(result.error ?? 'the summarizer failed on the node')
      void poll(1)
    } catch (error) {
      // A 409 means another summary is being produced right now; the node's
      // own message says so, so show it rather than a generic failure.
      fail(error instanceof Error ? error.message : 'summary request failed')
    }
  })

  setButton()
  return box
}

function renderIterations(node: string, job: string, section: HTMLElement): void {
  const key = currentKey
  loadAutolabJob(node, job)
    .then((detail) => {
      if (currentKey !== key) return
      if (currentSelection?.view === 'autolab') currentSelection.detail = detail
      section.replaceChildren(el('h3', undefined, `ITERATIONS (${detail.evidence.length})`))
      if (detail.evidence.length === 0) {
        section.append(el('p', 'dp-msg', 'No iteration evidence on disk yet.'))
        return
      }
      for (const entry of [...detail.evidence].reverse()) {
        section.append(renderIteration(node, job, entry))
      }
    })
    .catch((error: unknown) => {
      if (currentKey !== key) return
      section.replaceChildren(
        el('h3', undefined, 'ITERATIONS'),
        el('p', 'dp-summary-error', error instanceof Error ? error.message : 'iteration list unavailable'),
      )
    })
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
      ['project', job.project],
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

  const iterations = el('section')
  iterations.append(el('h3', undefined, 'ITERATIONS'), el('p', 'dp-msg', 'loading iterations…'))
  body!.append(iterations)
  renderIterations(node, job.name, iterations)
}

function renderProject(node: string, project: AutolabProject, profiles: string[]): void {
  headerName.textContent = project.name
  headerKind.textContent = `autolab project @ ${node}`
  headerStatus.textContent = project.error ? 'ERROR' : 'PROJECT'
  headerStatus.style.color = project.error ? '#ff8aa8' : '#9b8cff'

  const section = el('section')
  section.append(el('h3', undefined, 'PROJECT PROFILES'))
  section.append(
    kvList([
      ['node', node],
      ['coding', project.roles?.coding?.profile],
      ['coding source', project.roles?.coding?.source],
      ['director', project.roles?.director?.profile],
      ['director source', project.roles?.director?.source],
      ['available profiles', profiles.join(', ')],
      ['settings error', project.error],
    ]),
  )
  section.append(el('p', 'dp-msg', 'Profile changes go through the assistant conversation.'))
  body!.append(section)
}


// The agent room. An introduction is a contract other agents act on, so it is
// shown as it was posted — no summarising, no re-ordering, and no harness or
// model line, which the introductions do not carry and this view does not add.
function renderRoomAgent(agent: RoomAgent, open: RoomWorkRow[]): void {
  headerName.textContent = agent.instance
  // The entrance is nearly always the instance's own name; saying it twice in
  // one header is noise. It is worth a word only when it differs, or is absent.
  headerKind.textContent =
    agent.entrance === null
      ? 'no own channel'
      : agent.entrance === agent.instance
        ? 'own channel is its entrance'
        : `entrance ${agent.entrance}`
  headerStatus.textContent = open.length === 0 ? 'NOTHING OPEN' : `${open.length} OPEN`
  headerStatus.style.color = open.length === 0 ? '#67e8a5' : '#70c7ff'

  const intro = el('section')
  intro.append(el('h3', undefined, 'INTRODUCTION'))
  if (agent.intro) {
    intro.append(el('p', 'dp-summary-meta', `#agents / ${agent.topic} · posted ${postedAt(agent.intro)}`))
    intro.append(el('pre', undefined, agent.intro.content))
  } else {
    intro.append(el('p', 'dp-msg', 'this topic holds no readable introduction'))
  }
  body!.append(intro)

  const work = el('section')
  work.append(el('h3', undefined, `OPEN IN ${(agent.entrance ?? agent.instance).toUpperCase()}`))
  if (open.length === 0) {
    work.append(el('p', 'dp-msg', 'every topic in this channel is resolved'))
  } else {
    // Every row here is in the one channel the heading already names, so the
    // channel is not repeated under each topic.
    for (const row of open) {
      const box = el('div', 'dp-diff')
      const head = el('div', 'dp-diff-head')
      // Front's conversations are in `#front`, not in a channel of its own
      // name, so a row outside the heading's channel says where it is.
      head.append(el('span', undefined, row.channel === (agent.entrance ?? agent.instance) ? row.topic : `${row.channel}/${row.topic}`))
      if (row.resolved) head.append(el('span', 'dp-resolved', 'RESOLVED'))
      head.append(finishButton(row.channel, row.topic))
      box.append(head)
      work.append(box)
    }
  }
  // Project work is not attributed to an agent on purpose: a `pj-` channel is
  // the project's board, and no topic name says whose task it is.
  work.append(el('p', 'dp-summary-meta', 'project work is listed under its project, in the open-work mode; finish ✔ previews a request’s completion — an agent’s own plan here, a project’s workplan there'))
  body!.append(work)

  if (agent.history.length > 1) {
    const history = el('section')
    const details = el('details')
    details.append(el('summary', undefined, `EARLIER INTRODUCTIONS (${agent.history.length - 1})`))
    for (const post of agent.history.slice(0, -1).reverse()) {
      details.append(el('p', 'dp-summary-meta', `${post.sender} · ${postedAt(post)}`))
      details.append(el('pre', undefined, post.content))
    }
    history.append(details)
    body!.append(history)
  }
}

function renderRoomBoard(group: string, kind: 'project' | 'agent', rows: RoomWorkRow[]): void {
  headerName.textContent = group
  headerKind.textContent = kind
  const open = rows.filter((row) => !row.resolved).length
  headerStatus.textContent = open === rows.length ? `${rows.length} OPEN` : `${open} OPEN · ${rows.length - open} ✔`
  headerStatus.style.color = kind === 'project' ? '#9b8cff' : '#70c7ff'

  // The flat list the plan asks for: channel name and raw topic name, nothing
  // read into either. `workplan-`/`assetplan-`/`workrun-` are each agent's own
  // vocabulary; the only thing interpreted anywhere here is Zulip's `✔ `.
  const byChannel = new Map<string, RoomWorkRow[]>()
  for (const row of rows) byChannel.set(row.channel, [...(byChannel.get(row.channel) ?? []), row])

  const section = el('section')
  section.append(el('h3', undefined, 'UNRESOLVED TOPICS'))
  for (const [channel, channelRows] of byChannel) {
    const box = el('div', 'dp-diff')
    const head = el('div', 'dp-diff-head')
    head.append(el('span', undefined, channel))
    head.append(el('span', 'dp-sev info', `${channelRows.length}`))
    box.append(head)
    for (const row of channelRows) {
      const line = el('div', 'dp-topic-row')
      line.append(el('p', 'dp-msg', row.topic))
      if (row.resolved) line.append(el('span', 'dp-resolved', 'RESOLVED'))
      line.append(finishButton(row.channel, row.topic))
      box.append(line)
    }
    section.append(box)
  }
  section.append(
    el('p', 'dp-summary-meta', 'open means the topic carries no ✔ prefix — nothing else is read. ' +
      'finish ✔ previews what completing that request would change (its topics, channels and Plane Works); ' +
      'a task topic answers with the request to go to instead'),
  )
  body!.append(section)
}


// --- the operation room ---------------------------------------------------
//
// Everything here is provenance. The relay decided the state; this shows what
// it decided it from, because a board built entirely on absence of evidence
// has no other defence against a confident wrong answer.

const OPS_COLOR: Record<string, string> = {
  stalled: '#ff8aa8',
  awaiting: '#70c7ff',
  acked: '#9b8cff',
  done: '#67e8a5',
  unknown: '#ffc56d',
}

function opsHealthSection(board: OpsBoard): HTMLElement {
  const section = el('section')
  section.append(el('h3', undefined, 'RELAY'))
  section.append(el('p', 'dp-msg', healthLine(board)))
  section.append(
    kvList([
      ['state', board.health.state],
      ['reason', board.health.reason],
      ['event queue', board.health.queue ? 'registered' : 'none'],
      ['last event', at(board.health.last_event_at)],
      ['last full sweep', at(board.health.last_sweep_at)],
      ['sweeps', board.health.sweeps],
      ['sweep cost', `${board.health.sweep_calls} Zulip calls`],
      ['stalled after', `${Math.round(board.settings.stalled_seconds / 60)} min`],
    ]),
  )
  if (board.errors.length > 0) {
    const errors = el('details')
    errors.append(el('summary', undefined, `CHANNELS NOT READ (${board.errors.length})`))
    for (const error of board.errors) {
      errors.append(el('p', 'dp-msg', `${error.channel}: ${error.error}`))
    }
    section.append(errors)
  }
  return section
}

function renderOpsRow(row: OpsRow, board: OpsBoard): void {
  headerName.textContent = row.topic ? `${row.channel}/${row.topic}` : row.instance
  // A row with no conversation behind it is named after its instance already;
  // repeating it beside the heading is the noise the agent room's popup had.
  headerKind.textContent = row.topic ? row.instance : 'standing'
  headerStatus.textContent =
    row.state === 'unknown' && row.stale_state
      ? `UNKNOWN (was ${row.stale_state.toUpperCase()})`
      : row.state.toUpperCase()
  headerStatus.style.color = OPS_COLOR[row.state] ?? '#b7b5d8'

  const why = el('section')
  why.append(el('h3', undefined, 'WHY THIS STATE'))
  why.append(el('p', 'dp-msg', row.provenance.text))
  // A row that stands for an agent nobody can route for has no post behind it,
  // and a table of eight em-dashes reads as missing data rather than as the
  // point. The sentence above is the whole of what is known.
  const hasEvidence = row.provenance.message_id != null || row.route != null
  if (hasEvidence) why.append(
    kvList([
      ['route', row.route ?? 'none'],
      ['owed since', ago(row.age_seconds)],
      ['last real post', row.provenance.message_id ? `#${row.provenance.message_id}` : '—'],
      ['posted', at(row.provenance.message_at)],
      ['by', row.provenance.by ?? '—'],
      // The mention route is answered at home, so this note is the only
      // record that a callback was ever dealt with. Its absence is half the
      // reason a row is here at all.
      ['served note', row.provenance.served_mark ? `up to #${row.provenance.served_mark}` : 'none'],
      ['live topic name', row.live_topic ?? '—'],
      ['resolved (✔)', row.provenance.resolved ? 'yes' : 'no'],
    ]),
  )
  why.append(
    el(
      'p',
      'dp-summary-meta',
      hasEvidence
        ? 'every state on this board is read off traces left for other purposes — ' +
            'the evidence above is the whole of what it was read from'
        : 'there is no evidence to show: the observer refuses to guess a roster, ' +
            'because guessing one is what produced 66 phantom stalled rows in p1',
    ),
  )
  body!.append(why)
  if (row.channel && row.topic) {
    // Two different verbs, kept apart on purpose: the board's "confirmed"
    // dismisses a done row from this display and writes nothing; finishing
    // changes Zulip and Plane, after a preview (`front_desk` p4).
    const finish = el('section')
    finish.append(el('h3', undefined, 'FINISH THIS REQUEST'))
    const line = el('div', 'dp-topic-row')
    line.append(el('p', 'dp-msg', `${row.channel}/${row.topic}`))
    line.append(finishButton(row.channel, row.topic))
    finish.append(line)
    finish.append(el('p', 'dp-summary-meta',
      '“confirmed” on the board only hides a done row here and writes nothing; ' +
      'finish ✔ previews and then resolves this request’s topics, archives its work channel and marks its Plane Work Done'))
    body!.append(finish)
  }
  body!.append(opsHealthSection(board))
}

function renderOpsInstance(instance: OpsInstance, board: OpsBoard): void {
  headerName.textContent = instance.instance
  headerKind.textContent = instance.roster === 'intro' ? 'roster from #agents' : 'no roster'
  const counts = instance.counts
  headerStatus.textContent =
    instance.state === 'ok'
      ? `${counts.stalled} STALLED · ${counts.awaiting} AWAITING`
      : 'UNKNOWN'
  headerStatus.style.color = instance.state === 'ok' ? OPS_COLOR.awaiting : OPS_COLOR.unknown

  const routing = el('section')
  routing.append(el('h3', undefined, 'HOW IT IS ROUTED'))
  if (instance.roster === 'missing') {
    routing.append(
      el(
        'p',
        'dp-msg',
        'This instance has an introduction on #agents with no roster block, so nothing ' +
          'here can say what it answers for. That is unknown, not idle: the observer ' +
          'refuses to guess, because guessing a roster is what produced 66 phantom ' +
          'stalled rows in the investigation this screen came out of.',
      ),
    )
  } else {
    routing.append(
      kvList([
        ['mentioned as', instance.bot ? `@**${instance.bot}**` : '—'],
        ['zulip user id', instance.bot_id ?? '—'],
        ['answers every topic in', instance.channel ?? '—'],
        // Declared, not assumed — Front declares a channel that does not exist
        // and is served by its prefix alone.
        ['that channel exists', instance.channel_exists === null ? '—' : instance.channel_exists ? 'yes' : 'no'],
        ['sweeps prefixes', instance.prefixes.length > 0 ? instance.prefixes.join('  ') : 'none'],
        ['served notes seen', instance.served_marks],
      ]),
    )
    routing.append(
      el(
        'p',
        'dp-summary-meta',
        'read from its own introduction in #agents — no roster is compiled into this view',
      ),
    )
  }
  body!.append(routing)

  const owed = el('section')
  owed.append(el('h3', undefined, 'WHAT IT OWES'))
  const rows = board.rows.filter((row) => row.instance === instance.instance)
  if (rows.length === 0) {
    owed.append(el('p', 'dp-msg', 'nothing is waiting on this instance'))
  } else {
    for (const row of rows) {
      const box = el('div', 'dp-diff')
      const head = el('div', 'dp-diff-head')
      head.append(el('span', undefined, row.topic ? `${row.channel}/${row.topic}` : row.instance))
      const badge = el('span', 'dp-sev info', row.state.toUpperCase())
      badge.style.color = OPS_COLOR[row.state] ?? '#b7b5d8'
      head.append(badge)
      box.append(head)
      box.append(el('p', 'dp-msg', row.provenance.text))
      owed.append(box)
    }
  }
  body!.append(owed)
  body!.append(opsHealthSection(board))
}

function renderOpsHealth(board: OpsBoard): void {
  headerName.textContent = 'operation room'
  headerKind.textContent = 'relay'
  headerStatus.textContent = board.health.state.toUpperCase()
  headerStatus.style.color = board.health.state === 'live' ? OPS_COLOR.done : OPS_COLOR.unknown

  const section = el('section')
  section.append(el('h3', undefined, 'NOTHING CAN BE SAID RIGHT NOW'))
  section.append(
    el(
      'p',
      'dp-msg',
      'This board is unknown, which is not the same as quiet. An agent that is not ' +
        'running cannot report that it is not running — that is the whole reason this ' +
        'screen is computed outside the agents — so a relay that cannot read Zulip must ' +
        'say so rather than show an empty, calm board.',
    ),
  )
  body!.append(section)
  body!.append(opsHealthSection(board))
}


// --- the routine board -----------------------------------------------------
//
// The tree is the point here: one run, and every conversation it opened. Each
// node wears the state the ops relay gave it and says which selfnote named it,
// because a link the reader cannot account for is indistinguishable from a
// guess — and this whole view is built out of other people's leftovers.

const NODE_COLOR: Record<string, string> = {
  ...OPS_COLOR,
  quiet: '#9a9db5',
}

function renderSessionNode(node: SessionNode, flight?: InflightBoard): HTMLDivElement {
  const row = el('div', 'dp-node')
  row.style.marginLeft = `${(node.depth - 1) * 12}px`
  const state = el('span', 'dp-node-state', node.state.toUpperCase())
  state.style.color = NODE_COLOR[node.state] ?? '#b7b5d8'
  const name = el('span', 'dp-node-name', `${node.channel}/${node.topic}`)
  const head = el('div')
  head.append(state, name)
  row.append(head)

  const why =
    node.known === 'note-only'
      ? `known only from the ${node.via} note #${node.link_id} — never read, because a ✔ topic is never swept`
      : `linked by the ${node.via} note #${node.link_id}`
  const meta = el('span', 'dp-node-meta', why)
  row.append(meta)
  for (const owed of node.rows) {
    row.append(
      el('span', 'dp-node-meta', `${owed.instance}: ${owed.provenance?.short ?? owed.state}`),
    )
  }
  // The one non-Zulip signal, and only for the agents of this session.
  for (const seen of flight?.topics ?? []) {
    if (seen.channel !== node.channel || seen.topic !== node.topic) continue
    const line = el(
      'span',
      `dp-node-meta dp-flight ${seen.in_flight ? '' : seen.known ? 'idle' : 'unknown'}`,
      // The separator is not decoration: without it the screenshot read
      // "no run in flightgeneration 1 is older than…" as one word.
      `${seen.instance}: ${
        seen.known ? (seen.in_flight ? '● a run is in flight' : '○ no run in flight') : '? unknown'
      } · ${seen.reason}`,
    )
    row.append(line)
  }
  return row
}

function renderRoutine(
  routine: RoutineRow,
  detail: RoutineDetail | undefined,
  flight: InflightBoard | undefined,
): void {
  headerName.textContent = routine.name
  headerKind.textContent = routine.retired ? 'retired routine' : 'routine'
  headerStatus.textContent = routine.state.toUpperCase()
  headerStatus.style.color = OPS_COLOR[routine.state] ?? '#b7b5d8'
  const now = detail?.generated_at ?? Date.now() / 1000

  const latest = el('section')
  latest.append(el('h3', undefined, 'THE LATEST RUN'))
  latest.append(el('p', 'dp-msg', routineDetail(routine, now)))
  const run = routine.latest
  latest.append(
    kvList([
      ['run topic', run ? `#${run.channel} › ${run.topic}` : 'none on the realm'],
      ['opened at', at(run?.opened?.at)],
      ['opened by', run?.opened?.by],
      ['requested from', run?.origin ? `#${run.origin.channel} › ${run.origin.topic}` : run ? 'opened by hand' : undefined],
      ['state', run ? `${run.run.state} — ${run.run.evidence}` : undefined],
      ['finished', run?.finish ? `${run.finish.achieved ? 'goal reached' : 'goal not reached'} — ${run.finish.reason}` : undefined],
      ['resolution', run?.resolution.state],
      ['runs held', `${routine.runs} (${routine.open_runs} open)`],
    ]),
  )
  body!.append(latest)

  const guide = el('section')
  guide.append(el('h3', undefined, 'GUIDE'))
  if (routine.guide) {
    guide.append(
      el('p', 'dp-summary-meta', `#${routine.channel} › guide · #${routine.guide.message_id} by ${routine.guide.by}, ${at(routine.guide.at)} · ${routine.guide.posts} version${routine.guide.posts === 1 ? '' : 's'}`),
    )
    guide.append(el('p', 'dp-summary-text', routine.guide.text))
    if (routine.guide.authors.length > 1) {
      guide.append(el('p', 'dp-msg', `Posted by more than one author (${routine.guide.authors.join(', ')}): the newest post is the guide whoever wrote it, so check that it is one.`))
    }
  } else {
    guide.append(el('p', 'dp-msg', `no post in #${routine.channel} › guide`))
  }
  body!.append(guide)

  const sessions = el('section')
  sessions.append(el('h3', undefined, 'RUNS (LAST 3)'))
  if (!detail) {
    sessions.append(el('p', 'dp-msg', 'reading the runs…'))
  } else if (detail.sessions.length === 0) {
    sessions.append(el('p', 'dp-msg', 'no run of this routine is held'))
  }
  for (const session of detail?.sessions ?? []) {
    const card = el('div', 'dp-session')
    const head = el('div', 'dp-session-head')
    head.append(
      el('span', undefined, session.topic),
      el('span', undefined, session.run.state),
      el('span', undefined, session.resolution.state),
    )
    head.append(el('span', 'dp-session-when', session.opened ? at(session.opened.at) : ''))
    card.append(head)
    if (session.opened) card.append(el('p', 'dp-summary-text', session.opened.text))
    card.append(el('p', 'dp-summary-meta', session.origin
      ? `requested from #${session.origin.channel} › ${session.origin.topic} (note #${session.origin.message_id})`
      : 'opened by hand — no requesting conversation'))
    if (session.last_entry) {
      card.append(el('p', 'dp-summary-meta', `last entry #${session.last_entry.message_id}, ${at(session.last_entry.at)} · ${session.entries} entries`))
      card.append(el('p', 'dp-summary-text', session.last_entry.excerpt))
    }
    if (session.finish) {
      card.append(el('p', 'dp-summary-meta', `${session.finish.achieved ? 'goal reached' : 'goal not reached'} — ${session.finish.reason}`))
      card.append(el('p', 'dp-summary-text', session.finish.report))
    }
    if (session.nodes.length === 0) {
      card.append(el('p', 'dp-msg', 'nothing was opened on behalf of this run'))
    }
    for (const node of session.nodes) card.append(renderSessionNode(node, flight))
    sessions.append(card)
  }
  body!.append(sessions)

  if (flight) {
    const host = el('section')
    host.append(el('h3', undefined, 'IS ANYTHING RUNNING (HOST, NOT ZULIP)'))
    host.append(
      el(
        'p',
        'dp-msg',
        'A role workspace with no run record newer than it is a run in flight. This is ' +
          'the only signal on this screen that does not come from the realm, which is why ' +
          'it is the only one polled.',
      ),
    )
    for (const agent of flight.agents) {
      host.append(
        el(
          'p',
          `dp-summary-meta dp-flight ${agent.in_flight ? '' : agent.known ? 'idle' : 'unknown'}`,
          `${agent.instance}: ${agent.reason}`,
        ),
      )
    }
    if (flight.agents.length === 0) {
      host.append(el('p', 'dp-msg', 'no agent of this realm owns any topic of this run'))
    }
    body!.append(host)
  }
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

  // Set before rendering, not after: the autolab drill-down fetches while it
  // renders and checks `currentKey` to know whether its result is still the
  // popup the user is looking at.
  currentKey = key
  currentSelection = selection

  body!.replaceChildren()
  if (selection.view === 'agent-room') renderRoomAgent(selection.agent, selection.work)
  else if (selection.view === 'agent-room-board') {
    renderRoomBoard(selection.group, selection.kind, selection.rows)
  }
  else if (selection.view === 'nodes') renderNode(selection.target, selection.device)
  else if (selection.view === 'autolab') renderJob(selection.node, selection.job)
  else if (selection.view === 'autolab-project') {
    renderProject(selection.node, selection.project, selection.profiles)
  }
  else if (selection.view === 'ops-row') renderOpsRow(selection.row, selection.board)
  else if (selection.view === 'ops-instance') renderOpsInstance(selection.instance, selection.board)
  else if (selection.view === 'ops-health') renderOpsHealth(selection.board)
  else if (selection.view === 'routine') {
    renderRoutine(selection.routine, selection.detail, selection.flight)
  }
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

  // Every other view's selection has nobody to ask: there is no assistant in
  // this application any more, and a button that quietly does nothing is worse
  // than no button.
  if (askButton) askButton.hidden = selection.view !== 'routine'

  node.classList.add('open')
  body!.scrollTop = 0
}
