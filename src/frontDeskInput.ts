// The room's composer: a visible textarea over the Phaser-drawn bar.
//
// A canvas cannot host an IME. Japanese input needs a real editable element
// for composition, candidate windows and paste, so the element that
// receives keys is a DOM textarea. Until `argue` p2 ex1 it was laid over the
// bar at near-zero opacity with the scene mirroring its tail on one line —
// no caret, no selection, no wrapping, no way to edit the middle of a
// draft. Now the textarea *is* the composer: its own font, caret, selection
// and placeholder, growing upward from the bar to a few rows as the draft
// wraps, dimmed and read-only when the relay cannot post.
//
// Enter sends only when it is not the Enter that confirms a composition
// (`isComposing`, or the legacy keyCode 229 some IMEs still report), and
// Shift+Enter is a newline. Every change is mirrored into the scene through
// `onChange` for the counter and the Send button; the scene draws no text
// of the draft any more.
//
// Because the textarea is a DOM element beside the canvas, its clicks,
// drags and wheel never reach Phaser: typing, selecting and scrolling a
// draft cannot advance the dialogue or scroll the history.

export interface FrontDeskInputHandle {
  value: () => string
  set: (text: string) => void
  focus: () => void
  // The bar's inner rect: the composer sits on its bottom edge and grows
  // upward from there.
  place: (rect: { x: number; y: number; width: number; height: number }) => void
  setDisabled: (disabled: boolean) => void
  setPlaceholder: (text: string) => void
  destroy: () => void
  composing: () => boolean
}

const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji", sans-serif'
const FONT_PX = 16
const LINE_PX = 24
const MAX_ROWS = 5
const PAD_Y = 8
const STYLE_ID = 'frontdesk-input-style'

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '#frontdesk-input::placeholder{color:#7d8199;opacity:1}',
    '#frontdesk-input::selection{background:rgba(112,199,255,0.45);color:#ffffff}',
    '#frontdesk-input:focus{border-color:#70c7ff;box-shadow:0 0 0 1px rgba(112,199,255,0.35)}',
    '#frontdesk-input:disabled{color:#7d8199;background:rgba(16,19,28,0.6);border-style:dashed;cursor:not-allowed}',
    '#frontdesk-input:disabled::placeholder{color:#ffc56d}',
  ].join('\n')
  document.head.append(style)
}

export function createFrontDeskInput(options: {
  onChange: (text: string) => void
  onSubmit: () => void
  onEscape?: () => void
}): FrontDeskInputHandle {
  ensureStyle()
  const area = document.createElement('textarea')
  area.id = 'frontdesk-input'
  area.setAttribute('aria-label', 'Message')
  area.autocomplete = 'off'
  area.spellcheck = false
  area.rows = 1
  area.style.cssText = [
    'position:fixed', 'left:0', 'top:0', 'width:10px', 'height:10px', 'box-sizing:border-box',
    `font:${FONT_PX}px/${LINE_PX}px ${FONT}`, 'color:#f7f4ff', 'caret-color:#70c7ff',
    'background:rgba(16,19,28,0.94)', 'border:1px solid #3a4060', 'border-radius:10px',
    `padding:${PAD_Y}px 12px`, 'margin:0', 'outline:none', 'resize:none', 'overflow-y:auto',
    'z-index:30', 'transition:border-color 120ms',
  ].join(';')
  document.body.append(area)

  let composing = false
  let disabled = false
  let rect = { x: 0, y: 0, width: 10, height: 10 }

  // Grow upward from the bar's bottom edge: one row for an empty draft, up
  // to MAX_ROWS, then the draft scrolls inside the box.
  const grow = () => {
    const bottom = rect.y + rect.height
    area.style.height = 'auto'
    const wanted = Math.min(area.scrollHeight + 2, MAX_ROWS * LINE_PX + 2 * PAD_Y + 2)
    const height = Math.max(rect.height, wanted)
    area.style.height = `${Math.round(height)}px`
    area.style.top = `${Math.round(bottom - height)}px`
  }

  area.addEventListener('compositionstart', () => { composing = true })
  area.addEventListener('compositionend', () => {
    composing = false
    options.onChange(area.value)
    grow()
  })
  area.addEventListener('input', (event) => {
    // The event says whether a composition is still open; a missed
    // `compositionend` must not leave the bar unable to send forever.
    if (event instanceof InputEvent) composing = event.isComposing
    options.onChange(area.value)
    grow()
  })
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { options.onEscape?.(); return }
    if (event.key !== 'Enter') return
    // The Enter that confirms a composition must never send. The event
    // itself says so (`isComposing`, or the legacy keyCode 229).
    if (event.isComposing || event.keyCode === 229) return
    if (event.shiftKey) return
    event.preventDefault()
    if (!disabled) options.onSubmit()
  })

  return {
    value: () => area.value,
    set(text) {
      area.value = text
      options.onChange(text)
      grow()
    },
    focus() {
      if (!disabled) area.focus({ preventScroll: true })
    },
    place(next) {
      rect = { ...next }
      area.style.left = `${Math.round(rect.x)}px`
      area.style.width = `${Math.max(10, Math.round(rect.width))}px`
      grow()
    },
    setDisabled(value) {
      disabled = value
      area.disabled = value
    },
    setPlaceholder(text) {
      if (area.placeholder !== text) area.placeholder = text
    },
    destroy() {
      area.remove()
    },
    composing: () => composing,
  }
}
