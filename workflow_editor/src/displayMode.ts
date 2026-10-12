// Simple and Detail (workflow_editor p8/ex1): one viewer preference for every
// screen. Simple shows the purpose, the situation and the person's next
// action; Detail adds the inspection and adjustment capabilities. It is a
// per-browser convenience, never project or workflow data, and it starts as
// Simple when nothing (or something unreadable) is stored.
//
// The switch changes presentation only. Both modes are the same DOM: an
// element marked `.d-only` is shown in Detail, `.s-only` in Simple
// (styles.css, keyed on <html data-display>). No control is rebuilt or
// cloned for a mode, so drafts, selection and disclosure states stay with
// their one element. What the switch does beyond the attribute:
//
// - it is deferred while an IME composition is in progress, and applied
//   when the composition ends;
// - each mode's scroll positions (the window and every element marked
//   `data-keep-scroll`) are remembered per screen and restored on return;
// - a focused control the new mode hides gives its focus to the toggle;
// - listeners (onDisplay) are told, so a view can redraw what is not CSS
//   (the canvas's card metrics). Views remove their listeners on dispose.
import { h } from './dom.ts'

export type Display = 'simple' | 'detail'
export const DISPLAY_KEY = 'workflow-editor.display'

function read(): Display {
  try { return localStorage.getItem(DISPLAY_KEY) === 'detail' ? 'detail' : 'simple' } catch { return 'simple' }
}
let current: Display = read()
let pending: Display | null = null
let composing = false
const listeners = new Set<(d: Display) => void>()
// Scroll positions per screen (location.hash) and mode.
const scrolls = new Map<string, { win: number; els: Record<string, number> }>()

export const display = () => current
export const isSimple = () => current === 'simple'

export function onDisplay(fn: (d: Display) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function remember(mode: Display) {
  const els: Record<string, number> = {}
  for (const el of document.querySelectorAll<HTMLElement>('[data-keep-scroll]')) els[el.dataset.keepScroll!] = el.scrollTop
  scrolls.set(`${location.hash}|${mode}`, { win: window.scrollY, els })
}
function restore(mode: Display) {
  const s = scrolls.get(`${location.hash}|${mode}`)
  for (const el of document.querySelectorAll<HTMLElement>('[data-keep-scroll]')) {
    const v = s?.els[el.dataset.keepScroll!]
    // Clamped by the browser to the range the content has now.
    if (v !== undefined) el.scrollTop = v
  }
  window.scrollTo(window.scrollX, s?.win ?? 0)
}

const visible = (el: Element) => (el as HTMLElement).checkVisibility?.() ?? (el as HTMLElement).offsetParent !== null

// Switches the mode (one click; never navigates, saves or submits). While a
// composition is in progress the switch waits for it to end.
export function setDisplay(next: Display) {
  if (composing) { pending = next; return }
  pending = null
  if (next === current) return
  remember(current)
  const focused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  current = next
  try { localStorage.setItem(DISPLAY_KEY, next) } catch { /* per-viewer convenience only */ }
  apply()
  for (const fn of [...listeners]) fn(next)
  restore(next)
  // A control that is no longer shown gives the keyboard to the toggle.
  if (focused && (!focused.isConnected || !visible(focused))) document.querySelector<HTMLElement>(`.display-toggle button[data-display="${next}"]`)?.focus({ preventScroll: true })
}

// A contextual entry ("Project settings", "More details", …): Detail, then
// the target revealed by the caller.
export function showDetail(reveal?: () => void) {
  setDisplay('detail')
  if (current === 'detail') reveal?.()
}

function apply() {
  document.documentElement.dataset.display = current
  for (const b of document.querySelectorAll<HTMLButtonElement>('.display-toggle button')) {
    const on = b.dataset.display === current
    if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on))
  }
}

// The labelled Simple/Detail control of a screen's top bar. Its state is
// the document's; it needs no listener of its own.
export function displayToggle(): HTMLElement {
  const button = (d: Display, label: string, title: string) => h('button', { type: 'button', dataset: { display: d }, 'aria-pressed': String(current === d), title, onclick: () => setDisplay(d) }, label)
  return h('div.display-toggle', { role: 'group', 'aria-label': 'Display' },
    button('simple', 'Simple', 'Only what you need now: the purpose, the situation and your next action'),
    button('detail', 'Detail', 'Every record, setting and technical fact, with the inspection and adjustment controls'))
}

// Composition anywhere in the document defers a switch until it ends.
document.addEventListener('compositionstart', () => { composing = true }, true)
document.addEventListener('compositionend', () => {
  composing = false
  if (pending) { const p = pending; queueMicrotask(() => setDisplay(p)) }
}, true)
apply()
