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
}

export function icon(name: string, cls = 'icon'): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = cls
  span.innerHTML = ICONS[name] ?? ICONS.unknown
  return span
}
