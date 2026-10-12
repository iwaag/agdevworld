// Line icons for node types and repositories (24px grid, currentColor).
const svg = (body: string) => `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const ICONS: Record<string, string> = {
  // open book with a magnifier
  study: svg('<path d="M3 5.5c2.5-1 5-1 7.5.5v12c-2.5-1.5-5-1.5-7.5-.5z"/><path d="M10.5 6c1.6-1 3.3-1.4 5-1.2"/><circle cx="16.5" cy="14.5" r="3"/><path d="m18.7 16.7 2.3 2.3"/>'),
  // gear beside a terminal prompt
  do: svg('<path d="M8 3.5v1.6M8 10.9v1.6M3.5 8h1.6M10.9 8h1.6M4.8 4.8l1.1 1.1M10.1 10.1l1.1 1.1M4.8 11.2l1.1-1.1M10.1 5.9l1.1-1.1"/><circle cx="8" cy="8" r="2.2"/><rect x="10" y="11" width="11" height="9" rx="1.5"/><path d="m12.5 14 2 1.5-2 1.5M16 17.5h2.5"/>'),
  // branch: hand-off to another workflow
  delegate: svg('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 4-4 4-10 7"/>'),
  // speech bubble
  talk: svg('<path d="M4 12c0-4 3.6-7 8-7s8 3 8 7-3.6 7-8 7c-1.2 0-2.3-.2-3.3-.6L4.5 20l1.2-3.6C4.6 15.2 4 13.7 4 12z"/>'),
  unknown: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M10 10a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5M12 16.5v.01"/>'),
  repo: svg('<path d="M6 4h11a1 1 0 0 1 1 1v14H7a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1z"/><path d="M5 17a2 2 0 0 1 2-2h11"/>'),
  intent: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/><path d="m12 12 7-7M16 5h3v3"/>'),
  check: svg('<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>'),
  alert: svg('<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17v.01"/>'),
  doc: svg('<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"/><path d="M14 3.5V8h4M9 12h6M9 15.5h6"/>'),
  folder: svg('<path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17.5z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  // appearance icons (p7)
  // an easel with a play mark: a result shown to a person
  present: svg('<rect x="3.5" y="4" width="17" height="11" rx="1.5"/><path d="m10.5 7.5 4 2-4 2z"/><path d="M12 15v3M8 21l4-3 4 3"/>'),
  // a broom: stopping what the run started
  cleanup: svg('<path d="M14.5 3.5 10 12"/><path d="M7 12h7l2.5 8.5h-12z"/><path d="M8.5 16.5 8 20.5M12 16.5v4"/>'),
  // a flask
  test: svg('<path d="M9.5 3.5h5M10.5 3.5v6L5 19a1 1 0 0 0 .9 1.5h12.2a1 1 0 0 0 .9-1.5l-5.5-9.5v-6"/><path d="M7.5 15h9"/>'),
  // a hammer
  build: svg('<path d="m13 7 4 4-9 9-4-4z"/><path d="m14.5 5.5 2-2 4 4-2 2"/>'),
  // an eye
  review: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  // a flag
  flag: svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
  // interface glyphs (p8)
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>'),
  close: svg('<path d="m6 6 12 12M18 6 6 18"/>'),
  chevron: svg('<path d="m9 6 6 6-6 6"/>'),
  caret: svg('<path d="m6 9 6 6 6-6"/>'),
  person: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>'),
  external: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  history: svg('<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5M12 8v4.5l3 2"/>'),
  question: svg('<circle cx="12" cy="12" r="8.5"/><path d="M9.8 9.6a2.3 2.3 0 1 1 3.1 2.2c-.6.3-.9.8-.9 1.4v.6M12 16.6v.01"/>'),
  list: svg('<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
  play: svg('<path d="M8 5.5v13l10-6.5z"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
}

export function icon(name: string, cls = 'icon'): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = cls
  span.innerHTML = ICONS[name] ?? ICONS.unknown
  return span
}
