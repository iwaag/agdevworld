// The Project Editor's Boast area (p12, docs/boast.md): the project's own
// `boast/index.html`, in a sandboxed frame across the page's width. WFE gives
// the space; what is shown is the project's.
//
// The frame is created once per view and never detached: the project view's
// re-renders leave it in place (detaching an iframe reloads its document, which
// would restart a demo or a video). Published content changing is offered as a
// reload, never applied by itself.
//
// A page may post a few optional messages (height, copy, resolve-shared). They
// are accepted only from this frame, whose origin is opaque, and only in the
// documented shapes; this is not a general API of the editor.
import { ApiError, api } from './api.ts'
import { h, short } from './dom.ts'
import { icon } from './icons.ts'

export interface BoastStateView {
  schema: string; project: string; source: 'committed' | 'worktree'; state: 'present' | 'absent'; commit: string; entry: string | null
  provenance: { revision: { commit: string; ref?: string }; observed: string; fetch?: { state: 'fresh' | 'recent' | 'stale'; at: string; error?: string }; repository: { fullName: string } }
  workspace?: { id: string; head: string | null; branch: string | null; dirty: boolean }
  detail?: string
}

// The page's sandbox: the same list the service sends as its CSP (server/boast.ts).
const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-forms allow-modals allow-pointer-lock'
const POLL_MS = 60_000
const MAX_COPY = 64 * 1024
const HEIGHT = { min: 120, max: 4000 }

export interface BoastPanel { el: HTMLElement; show: (project: string | null, workspace: string) => void; check: () => void; dispose: () => void }

export function boastPanel(): BoastPanel {
  let project: string | null = null
  let workspace = ''
  let source: 'committed' | 'worktree' = 'committed'
  let shown: BoastStateView | null = null // what the frame displays
  let latest: BoastStateView | null = null // the last state read
  let error: ApiError | null = null
  let loading = false
  let disposed = false
  let toastTimer: ReturnType<typeof setTimeout> | undefined

  const frame = h('iframe.boast-frame', { title: 'Boast — the project\'s showcase page' }) as HTMLIFrameElement
  frame.setAttribute('sandbox', SANDBOX)
  frame.setAttribute('allow', 'fullscreen; autoplay; clipboard-write')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  const head = h('div.boast-head')
  const note = h('div.boast-note')
  const toast = h('div.boast-toast', { role: 'status', 'aria-live': 'polite' })
  const el = h('section.boast', { 'aria-label': 'Boast' }, head, note, frame, toast)

  const stateUrl = (refresh: boolean) => `api/boast/${encodeURIComponent(project!)}?${new URLSearchParams({
    ...(source === 'worktree' ? { source, workspace } : {}), ...(refresh ? { refresh: '1' } : {}),
  })}`
  const abs = (rel: string) => new URL(rel, location.href).href
  const changed = () => !!shown && !!latest && (shown.commit !== latest.commit || shown.state !== latest.state || (source === 'worktree' && shown.workspace?.dirty !== latest.workspace?.dirty))

  async function read(refresh: boolean): Promise<BoastStateView | null> {
    if (!project) return null
    try {
      const r = await fetch(stateUrl(refresh))
      const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
      if (!r.ok) throw new ApiError(r.status, (body as { error?: string }).error ?? `HTTP ${r.status}`, (body as { detail?: unknown }).detail)
      error = null
      return body as BoastStateView
    } catch (e) {
      error = e instanceof ApiError ? e : new ApiError(0, `The editor service is not reachable (${(e as Error).message}).`)
      return null
    }
  }

  // Reads the state and shows it in the frame (an explicit reload, or the first view).
  async function load(refresh: boolean) {
    loading = true; draw()
    const s = await read(refresh)
    loading = false
    if (disposed) return
    latest = s
    if (s) {
      shown = s
      if (s.state === 'present' && s.entry) frame.src = abs(s.entry) // setting src navigates even when it is unchanged
      else frame.removeAttribute('src')
    }
    draw()
  }

  // Looks for a change without touching the frame.
  async function check() {
    if (!project || loading || document.hidden) return
    const s = await read(false)
    if (disposed) return
    if (s) latest = s
    if (!shown && s) return load(false)
    draw()
  }

  function setSource(next: 'committed' | 'worktree') {
    if (next === source) return
    source = next; shown = null; latest = null
    void load(true)
  }

  function draw() {
    const s = shown
    const sourceSwitch = h('div.boast-source', { role: 'group', 'aria-label': 'Which content' },
      h(`button.seg${source === 'committed' ? '.on' : ''}`, { type: 'button', 'aria-pressed': String(source === 'committed'), title: 'The page as published on the project\'s main branch', onclick: () => setSource('committed') }, 'Published'),
      h(`button.seg${source === 'worktree' ? '.on' : ''}`, { type: 'button', 'aria-pressed': String(source === 'worktree'), title: `Preview the working tree of workspace ${workspace} (uncommitted files included; may differ from what is published)`, onclick: () => setSource('worktree') }, 'Preview workspace'))
    const where = !s ? null
      : s.source === 'committed'
        ? h('span.chip', { title: `${s.provenance.repository.fullName} ${s.provenance.revision.ref ?? 'main'} at ${s.commit}` }, `${s.provenance.revision.ref ?? 'main'} @ ${short(s.commit)}`)
        : h('span.chip.warn', { title: `Working tree of workspace ${s.workspace?.id} at ${s.workspace?.head ?? '?'}` }, `preview · ${s.workspace?.id} @ ${short(s.workspace?.head)}${s.workspace?.dirty ? ' · uncommitted' : ''}`)
    const stale = s?.provenance.fetch?.state === 'stale' ? h('span.chip.warn', { title: s.provenance.fetch.error }, `not refreshed since ${new Date(s.provenance.fetch.at).toLocaleString()}`) : null
    const open = s?.state === 'present' && s.entry ? h('a.button', { href: abs(s.entry), target: '_blank', rel: 'noopener', title: 'Open the page alone in a new tab' }, icon('external', 'icon small'), 'Open in new tab') : null
    head.replaceChildren(
      h('h2', 'Boast'),
      h('div.boast-meta', where, stale, s?.provenance.observed ? h('span.muted.small.d-only', `read ${new Date(s.provenance.observed).toLocaleTimeString()}`) : null),
      h('div.boast-actions', sourceSwitch,
        h('button', { type: 'button', disabled: loading || !project, title: 'Read the page\'s state again and reload it (media included)', onclick: () => void load(true) }, icon('history', 'icon small'), loading ? 'Loading…' : 'Reload'),
        open))
    const notes: (HTMLElement | null)[] = []
    if (changed()) notes.push(h('div.banner.boast-update', source === 'committed' ? 'A newer version of this page is published. ' : 'The working tree changed. ',
      h('button', { type: 'button', onclick: () => void load(false) }, 'Show it')))
    if (error) notes.push(h('div.banner.error', icon('alert', 'icon small'), `The Boast page cannot be read${s ? ' now; the page below is the last one read' : ''}: ${error.message}`))
    if (!project) notes.push(h('p.muted.small', 'The project id is not known yet.'))
    else if (s?.state === 'absent') notes.push(h('p.boast-absent.muted', `No showcase page${s.source === 'worktree' ? ' in this working tree' : ''}. `,
      h('span.small', { title: 'boast/index.html is the page displayed in the Project Editor\'s Boast area. It can freely introduce the project\'s capabilities and outputs using HTML, CSS and JavaScript. Related files can live in the same directory.' }, h('code', 'boast/index.html'), ' is shown here.')))
    else if (!s && loading) notes.push(h('p.muted.small', 'Loading…'))
    note.replaceChildren(...notes.filter((x): x is HTMLElement => !!x))
    const present = s?.state === 'present'
    frame.hidden = !present
    el.classList.toggle('empty', !present)
    el.classList.toggle('failed', !!error && !s)
  }

  // ---- messages from the page --------------------------------------------------

  const reply = (msg: Record<string, unknown>) => frame.contentWindow?.postMessage({ wfeBoast: 1, ...msg }, '*')
  const flash = (text: string) => {
    toast.textContent = text; toast.classList.add('on')
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('on'), 2400)
  }

  async function copy(text: string): Promise<'clipboard' | 'execCommand' | 'manual'> {
    // navigator.clipboard exists only in secure contexts (not on a LAN http:// origin).
    try { if (window.isSecureContext && navigator.clipboard) { await navigator.clipboard.writeText(text); return 'clipboard' } } catch { /* fall through */ }
    const ta = h('textarea.boast-copy-src', { readOnly: true, value: text }) as HTMLTextAreaElement
    document.body.append(ta)
    ta.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    ta.remove()
    frame.focus()
    if (ok) return 'execCommand'
    manualCopy(text)
    return 'manual'
  }

  // The fallback: the text, selected, for the person to copy themselves.
  function manualCopy(text: string) {
    const ta = h('textarea.boast-manual-text', { readOnly: true, rows: Math.min(8, text.split('\n').length + 1), value: text }) as HTMLTextAreaElement
    const close = () => dlg.remove()
    const dlg = h('div.boast-manual', { role: 'dialog', 'aria-label': 'Copy this text' },
      h('div.boast-manual-box',
        h('strong', 'Copy this text'),
        h('p.muted.small', 'The browser does not allow this page to copy on its own here. The text is selected: press ⌘C / Ctrl+C.'),
        ta,
        h('div.save-row', h('button', { type: 'button', onclick: close }, 'Close'))))
    dlg.addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Escape') close() })
    dlg.addEventListener('click', e => { if (e.target === dlg) close() })
    document.body.append(dlg)
    ta.focus(); ta.select()
  }

  async function onMessage(e: MessageEvent) {
    if (e.source !== frame.contentWindow || !frame.contentWindow) return
    // The page runs in an opaque origin (the sandbox has no allow-same-origin).
    if (e.origin !== 'null') return
    const m = e.data as Record<string, unknown> | null
    if (!m || typeof m !== 'object' || Array.isArray(m) || m.wfeBoast !== 1 || typeof m.type !== 'string') return
    const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : undefined
    if (m.type === 'height') {
      const n = Number(m.height)
      if (Number.isFinite(n)) frame.style.height = `${Math.round(Math.min(HEIGHT.max, Math.max(HEIGHT.min, n)))}px`
    } else if (m.type === 'copy') {
      if (typeof m.text !== 'string' || m.text.length > MAX_COPY) return reply({ type: 'copy-result', id, ok: false, error: `text must be a string of at most ${MAX_COPY} characters` })
      const method = await copy(m.text)
      if (method !== 'manual') flash('Copied to the clipboard')
      reply({ type: 'copy-result', id, ok: method !== 'manual', method })
    } else if (m.type === 'resolve-shared') {
      if (typeof m.ref !== 'string' || !m.ref.startsWith('shared://') || m.ref.length > 2048) return reply({ type: 'resolve-shared-result', id, state: 'invalid', detail: 'ref must be a shared:// reference' })
      try {
        const r = await api.shareRef(m.ref)
        reply({ type: 'resolve-shared-result', id, ...r, url: r.url ? abs(r.url) : null, download: r.download ? abs(r.download) : null })
      } catch (err) { reply({ type: 'resolve-shared-result', id, state: 'error', detail: (err as Error).message }) }
    }
  }
  window.addEventListener('message', onMessage)
  const poll = setInterval(() => void check(), POLL_MS)
  const onVisible = () => { if (!document.hidden) void check() }
  document.addEventListener('visibilitychange', onVisible)

  draw()
  return {
    el,
    show(p, ws) {
      if (p === project && ws === workspace) return
      project = p; workspace = ws; shown = null; latest = null
      void load(false)
    },
    check: () => void check(),
    dispose() {
      disposed = true
      clearInterval(poll); clearTimeout(toastTimer)
      window.removeEventListener('message', onMessage)
      document.removeEventListener('visibilitychange', onVisible)
      document.querySelectorAll('.boast-manual').forEach(x => x.remove())
    },
  }
}
