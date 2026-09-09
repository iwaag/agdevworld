// The completion overlay: one DOM panel every non-Phaser view opens.
//
// The operation room opens it for the selected routine run; the agent room
// and the ops board open it from their popups for a conversation. It draws
// exactly the lines `completionState.planLines` produces — the same words the
// Front Desk's Phaser panel draws — and sends back the fingerprint of the
// plan the human read. A row that is blocked or failed stays on screen with
// its reason, a partial run is told apart from a finished one, and a parent
// line is a button that re-opens the panel on that request.
//
// Absolutely positioned like `chatPanel.ts` and `detailPopup.ts`, above both
// (z-index 30), so the popup that opened it stays where it was.

import {
  announceCompleted,
  isCompletionPlan,
  planButtons,
  planLines,
  refLabel,
  relayCompletion,
  summaryLine,
  summaryTone,
  titleLine,
  type CompletionPlan,
  type CompletionRef,
  type CompletionSource,
  type PlanPhase,
  type Tone,
} from './completionState'

const PANEL_CSS = `
#completion-panel {
  position: fixed; top: 64px; right: 24px; bottom: 44px; width: min(600px, calc(100% - 48px));
  display: none; flex-direction: column; box-sizing: border-box;
  background: rgba(13, 15, 20, 0.97); border: 1px solid #3a4060; border-radius: 12px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55); color: #f7f4ff; z-index: 30; overflow: hidden;
  font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Helvetica Neue", Arial, sans-serif;
}
#completion-panel.open { display: flex; }
#completion-panel header { padding: 12px 16px 8px; border-bottom: 1px solid #1c2130; }
#completion-panel .cm-title { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; letter-spacing: 2px; color: #70c7ff; }
#completion-panel .cm-root { display: block; margin-top: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: #c3c7de; word-break: break-all; }
#completion-panel .cm-summary { display: block; margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
#completion-body { flex: 1; overflow-y: auto; padding: 10px 16px; }
#completion-body p { margin: 0 0 3px; line-height: 1.4; word-break: break-word; }
#completion-body p.body { font-size: 12.5px; }
#completion-body p.small { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
#completion-body p.row { margin-top: 6px; }
#completion-body button.nav { background: none; border: 1px solid #2c3450; border-radius: 8px; color: #70c7ff; font: inherit; font-size: 12px; padding: 3px 9px; cursor: pointer; text-align: left; }
#completion-body button.nav:hover { background: #1b2030; }
#completion-panel footer { padding: 10px 16px; border-top: 1px solid #1c2130; display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
#completion-panel footer button { background: #1b2030; border: none; border-radius: 8px; padding: 6px 12px; cursor: pointer; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.cm-ink { color: #f7f4ff; } .cm-muted { color: #b9bdd6; } .cm-dim { color: #7d8199; }
.cm-accent { color: #70c7ff; } .cm-ready { color: #67e8a5; } .cm-warn { color: #ffc56d; } .cm-bad { color: #ff8aa8; }
@media (max-width: 720px) {
  #completion-panel { top: 12px; right: 12px; left: 12px; bottom: 12px; width: auto; }
}
`

type Phase =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'unreadable'; text: string }
  | { kind: 'preview'; plan: CompletionPlan }
  | { kind: 'working'; plan: CompletionPlan }
  | { kind: 'done'; plan: CompletionPlan }

export interface CompletionPanelOptions {
  // Called after anything moved (and after a refresh), with the request.
  onChanged?: (root: CompletionRef) => void
  source?: CompletionSource
}

let panel: HTMLDivElement | null = null
let body: HTMLDivElement | null = null
let footer: HTMLElement | null = null
let title: HTMLSpanElement, rootLabel: HTMLSpanElement, summary: HTMLSpanElement
let phase: Phase = { kind: 'closed' }
let current: CompletionRef | undefined
let options: CompletionPanelOptions = {}
// The request a fetch was made for. An answer that arrives after the
// selection moved is dropped, never drawn.
let generation = 0

const same = (a: CompletionRef | undefined, b: CompletionRef | undefined) =>
  !!a && !!b && a.channel === b.channel && a.topic === b.topic

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function ensurePanel(): HTMLDivElement {
  if (panel) return panel
  const style = document.createElement('style')
  style.textContent = PANEL_CSS
  document.head.append(style)
  panel = el('div')
  panel.id = 'completion-panel'
  const header = el('header')
  title = el('span', 'cm-title')
  rootLabel = el('span', 'cm-root')
  summary = el('span', 'cm-summary')
  header.append(title, rootLabel, summary)
  body = el('div')
  body.id = 'completion-body'
  footer = el('footer')
  panel.append(header, body, footer)
  document.body.append(panel)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && phase.kind !== 'closed') closeCompletionPanel()
  })
  return panel
}

export function completionPanelOpen(): boolean {
  return phase.kind !== 'closed'
}

export function completionPanelRoot(): CompletionRef | undefined {
  return phase.kind === 'closed' ? undefined : current
}

// Open (or re-target) the panel on one request and read its plan.
export function openCompletionPanel(root: CompletionRef, given: CompletionPanelOptions = {}): void {
  ensurePanel()
  options = { ...options, ...given }
  // A row copied from a resolved topic carries Zulip's ✔; the request is
  // the bare name, which is also what the relay reads.
  current = { channel: root.channel, topic: root.topic.replace(/^✔ /, '') }
  void load()
}

export function closeCompletionPanel(): void {
  phase = { kind: 'closed' }
  generation += 1
  panel?.classList.remove('open')
}

async function load(): Promise<void> {
  const root = current
  if (!root) return
  const mine = ++generation
  phase = { kind: 'loading' }
  render()
  const found = await (options.source ?? relayCompletion).plan(root)
  if (mine !== generation || !same(root, current)) return
  phase = isCompletionPlan(found)
    ? { kind: 'preview', plan: found }
    : { kind: 'unreadable', text: found.error ?? 'the plan could not be read' }
  render()
}

async function apply(): Promise<void> {
  const root = current
  if (!root || (phase.kind !== 'preview' && phase.kind !== 'done')) return
  const plan = phase.plan
  const mine = ++generation
  phase = { kind: 'working', plan }
  render()
  const found = await (options.source ?? relayCompletion).apply(root, plan.fingerprint)
  if (mine !== generation || !same(root, current)) return
  if (!isCompletionPlan(found)) {
    phase = { kind: 'unreadable', text: found.error ?? 'the relay did not answer' }
    render()
    options.onChanged?.(root)
    announceCompleted(root)
    return
  }
  // A refusal is a preview again — the targets changed and nothing moved,
  // so what the human sees next is the plan to approve, not a result.
  phase = found.refused ? { kind: 'preview', plan: found } : { kind: 'done', plan: found }
  render()
  if (body) body.scrollTop = 0
  options.onChanged?.(root)
  announceCompleted(root)
}

function render(): void {
  if (!panel || !body || !footer) return
  panel.classList.toggle('open', phase.kind !== 'closed')
  if (phase.kind === 'closed') return
  body.replaceChildren()
  footer.replaceChildren()
  rootLabel.textContent = current ? refLabel(current) : ''
  const add = (text: string, tone: Tone, size: 'body' | 'small', indent = 0, row = false, navigate?: CompletionRef) => {
    const p = el('p', `${size} cm-${tone}${row ? ' row' : ''}`)
    p.style.paddingLeft = `${indent}px`
    if (navigate) {
      const button = el('button', 'nav', text)
      button.onclick = () => openCompletionPanel(navigate)
      p.append(button)
    } else p.textContent = text
    body!.append(p)
  }
  let planPhase: PlanPhase | 'loading' | 'unreadable'
  let plan: CompletionPlan | undefined
  if (phase.kind === 'loading') {
    planPhase = 'loading'
    title.textContent = 'FINISH THIS REQUEST'
    summary.textContent = 'reading the realm and Plane…'
    summary.className = 'cm-summary cm-dim'
    add('Nothing is changed by asking. This reads Zulip and Plane and writes to neither.', 'dim', 'body')
  } else if (phase.kind === 'unreadable') {
    planPhase = 'unreadable'
    title.textContent = 'FINISH THIS REQUEST'
    summary.textContent = 'the plan could not be read'
    summary.className = 'cm-summary cm-warn'
    add(phase.text, 'warn', 'body')
    add('Nothing was changed by this attempt unless a result below says so.', 'dim', 'body')
  } else {
    plan = phase.plan
    planPhase = phase.kind
    title.textContent = titleLine(plan, phase.kind)
    summary.textContent = summaryLine(plan, phase.kind)
    summary.className = `cm-summary cm-${summaryTone(plan, phase.kind)}`
    let previousBody = false
    for (const line of planLines(plan, phase.kind)) {
      // A body line after an indented small one starts a new row.
      const row = line.size === 'body' && line.indent === 0 && previousBody
      add(line.text, line.tone, line.size, line.indent, row, line.navigate)
      previousBody = previousBody || line.size === 'body'
    }
  }
  for (const button of planButtons(plan, planPhase)) {
    const node = el('button', `cm-${button.tone}`, button.label)
    node.dataset.action = button.id
    node.onclick = () => {
      if (button.id === 'close') closeCompletionPanel()
      else if (button.id === 'refresh') void load()
      else void apply()
    }
    footer.append(node)
  }
}
