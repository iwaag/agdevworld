// The Front Desk prompt's keyboard: a hidden textarea under a Phaser bar.
//
// A canvas cannot host an IME. Japanese input needs a real editable element
// for composition, candidate windows and paste, so the bar the user *sees* is
// drawn by Phaser and the element that *receives* keys is this textarea, laid
// over the bar at near-zero opacity. Every change is mirrored into the scene
// through `onChange`; Enter sends only when it is not the Enter that confirms
// a composition (`isComposing`, or the legacy keyCode 229 some IMEs still
// report), and Shift+Enter is a newline.

export interface FrontDeskInputHandle {
  value: () => string
  set: (text: string) => void
  focus: () => void
  place: (rect: { x: number; y: number; width: number; height: number }) => void
  setDisabled: (disabled: boolean) => void
  destroy: () => void
  composing: () => boolean
}

export function createFrontDeskInput(options: {
  onChange: (text: string) => void
  onSubmit: () => void
  onEscape?: () => void
}): FrontDeskInputHandle {
  const area = document.createElement('textarea')
  area.id = 'frontdesk-input'
  area.setAttribute('aria-label', 'Message to Front')
  area.autocomplete = 'off'
  area.spellcheck = false
  area.rows = 1
  area.style.cssText = [
    'position:fixed', 'left:0', 'top:0', 'width:10px', 'height:10px',
    'opacity:0.02', 'color:transparent', 'caret-color:transparent',
    'background:transparent', 'border:none', 'outline:none', 'resize:none',
    'padding:0', 'margin:0', 'font:14px sans-serif', 'z-index:30',
    'overflow:hidden',
  ].join(';')
  document.body.append(area)

  let composing = false
  let disabled = false

  area.addEventListener('compositionstart', () => { composing = true })
  area.addEventListener('compositionend', () => {
    composing = false
    options.onChange(area.value)
  })
  area.addEventListener('input', (event) => {
    // The event says whether a composition is still open; a missed
    // `compositionend` must not leave the bar unable to send forever.
    if (event instanceof InputEvent) composing = event.isComposing
    options.onChange(area.value)
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
    },
    focus() {
      if (!disabled) area.focus({ preventScroll: true })
    },
    place(rect) {
      area.style.left = `${Math.round(rect.x)}px`
      area.style.top = `${Math.round(rect.y)}px`
      area.style.width = `${Math.max(10, Math.round(rect.width))}px`
      area.style.height = `${Math.max(10, Math.round(rect.height))}px`
    },
    setDisabled(value) {
      disabled = value
      area.disabled = value
    },
    destroy() {
      area.remove()
    },
    composing: () => composing,
  }
}
