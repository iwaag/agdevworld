// The room's context panel (`give_context_easier` p1).
//
// A DOM panel beside the composer, shown and hidden with the `contexts`
// button on the bar, in both rooms the scene serves. It lists the context
// repositories of the shared catalog (the same set every agent reads with
// `agrefs`), searchable by name and description, with each one's newest
// publication; clicking one resolves its version to the full commit and
// inserts `<id>@<commit>` into the draft at the caret. A repository can be
// browsed — README and files — and a file's own reference inserted the same
// way. A reference already in the draft that has a newer version can be
// moved to it, but only on request: publication never rewrites a draft.
//
// Management is here too: create a repository (name, description, first
// README), register an existing one, edit its display name and description,
// archive or reactivate it, edit a Markdown file, add or upload files, and
// publish — each an explicit relay operation on the Developer's Gitea token,
// with no model run. A publication names the revision the editor started
// from; when somebody published in between, nothing is overwritten and the
// panel offers the two ways forward, with the edit kept.
//
// It is DOM because it needs what a canvas cannot give: selectable text, a
// search box that takes Japanese input, file pickers and keyboard focus.
// Nothing here touches the draft except `insert` and `replace` on the
// composer handle, so no failure in the panel can erase what was typed.

import type { FrontDeskInputHandle } from './frontDeskInput'
import {
  referenceOf,
  refsIn,
  type ContextBoard,
  type ContextRow,
  type ContextSource,
  type ContextTree,
  type Conflict,
  type PublishFile,
} from './contextState'

const STORE_KEY = 'agdevworld.contexts.open'
const STYLE_ID = 'context-panel-style'
const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Helvetica Neue", Arial, sans-serif'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const REFRESH_MS = 60_000

type View =
  | { kind: 'list' }
  | { kind: 'detail'; id: string; revision: string | null }
  | { kind: 'edit'; id: string; base: string; path: string; text: string; isNew: boolean; uploads: PublishFile[] }
  | { kind: 'create' }
  | { kind: 'register' }
  | { kind: 'meta'; id: string }

function readStored(): boolean {
  try { return window.localStorage.getItem(STORE_KEY) === '1' } catch { return false }
}

function store(open: boolean) {
  try { window.localStorage.setItem(STORE_KEY, open ? '1' : '0') } catch { /* private window: per session only */ }
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
#ctx-toggle{position:fixed;z-index:31;font:12px ${MONO};color:#b9bdd6;background:#1b2030;border:1px solid #3a4060;border-radius:8px;padding:0 10px;cursor:pointer}
#ctx-toggle[aria-pressed="true"]{color:#0d0f14;background:#70c7ff;border-color:#70c7ff}
#ctx-toggle:focus-visible{outline:2px solid #ffb3d9;outline-offset:1px}
#ctx-panel{position:fixed;z-index:29;box-sizing:border-box;display:flex;flex-direction:column;background:rgba(13,15,20,0.96);border:1px solid #3a4060;border-radius:12px;color:#f7f4ff;font:13px/1.45 ${FONT};box-shadow:0 8px 28px rgba(0,0,0,0.45)}
#ctx-panel[hidden]{display:none}
#ctx-panel header{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid #262b3d}
#ctx-panel header h2{margin:0;font:600 12px ${MONO};letter-spacing:2px;color:#70c7ff;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ctx-panel button{font:12px ${MONO};color:#dfe2f2;background:#1b2030;border:1px solid #3a4060;border-radius:6px;padding:3px 8px;cursor:pointer}
#ctx-panel button:hover{border-color:#70c7ff}
#ctx-panel button:focus-visible,#ctx-panel input:focus-visible,#ctx-panel textarea:focus-visible,#ctx-panel [role=option]:focus-visible{outline:2px solid #ffb3d9;outline-offset:1px}
#ctx-panel button.primary{background:#70c7ff;color:#0d0f14;border-color:#70c7ff}
#ctx-panel button.warn{background:#ffc56d;color:#0d0f14;border-color:#ffc56d}
#ctx-panel button:disabled{opacity:.45;cursor:not-allowed}
#ctx-panel .ctx-body{flex:1;overflow:auto;padding:8px 10px}
#ctx-panel .ctx-status{font:11px ${MONO};color:#7d8199;padding:4px 10px;border-bottom:1px solid #262b3d}
#ctx-panel .ctx-status.warn{color:#ffc56d}
#ctx-panel .ctx-status.bad{color:#ff8aa8}
#ctx-panel input,#ctx-panel textarea{box-sizing:border-box;width:100%;font:13px ${FONT};color:#f7f4ff;background:#10131c;border:1px solid #3a4060;border-radius:6px;padding:5px 8px}
#ctx-panel textarea{font:12.5px/1.5 ${MONO};resize:vertical;min-height:140px}
#ctx-panel label{display:block;font:11px ${MONO};color:#b9bdd6;margin:8px 0 3px}
#ctx-panel .ctx-row{display:block;width:100%;text-align:left;background:transparent;border:1px solid transparent;border-radius:8px;padding:6px 8px;margin:2px 0;cursor:pointer;color:inherit;font:inherit}
#ctx-panel .ctx-row:hover,#ctx-panel .ctx-row[aria-selected="true"]{background:#1b2030;border-color:#3a4060}
#ctx-panel .ctx-name{font-weight:600}
#ctx-panel .ctx-id,#ctx-panel .ctx-meta{font:11px ${MONO};color:#7d8199}
#ctx-panel .ctx-desc{color:#b9bdd6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
#ctx-panel .ctx-chip{display:inline-block;font:10.5px ${MONO};border-radius:4px;padding:0 5px;margin-left:6px;color:#0d0f14;background:#7d8199}
#ctx-panel .ctx-chip.warn{background:#ffc56d}
#ctx-panel .ctx-chip.bad{background:#ff8aa8}
#ctx-panel .ctx-chip.ok{background:#67e8a5}
#ctx-panel .ctx-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:6px 0}
#ctx-panel pre{white-space:pre-wrap;word-break:break-word;font:12px/1.5 ${MONO};background:#10131c;border:1px solid #262b3d;border-radius:6px;padding:8px;margin:6px 0;max-height:40vh;overflow:auto;user-select:text}
#ctx-panel .ctx-file{display:flex;align-items:center;gap:6px;padding:2px 0}
#ctx-panel .ctx-file .ctx-row{flex:1;margin:0;padding:3px 6px;font:12px ${MONO}}
#ctx-panel .ctx-file button{padding:1px 6px}
#ctx-panel .ctx-drafts{border:1px dashed #3a4060;border-radius:8px;padding:6px 8px;margin:0 0 8px}
#ctx-panel .ctx-conflict{border:1px solid #ffc56d;border-radius:8px;padding:8px;margin:8px 0;color:#ffe2ad}
#ctx-panel img{max-width:100%;border-radius:6px;border:1px solid #262b3d}
#ctx-panel a{color:#8dccff}
#ctx-panel .ctx-empty{color:#7d8199;padding:12px 4px}
`
  document.head.append(style)
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  for (const child of children) if (child !== null && child !== undefined) node.append(child)
  return node
}

function ago(stamp: number | null | undefined): string {
  if (!stamp) return 'never'
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - stamp))
  if (seconds < 90) return `${seconds}s ago`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86400)} days ago`
}

function day(date: string | undefined): string {
  return date ? date.slice(0, 10) : ''
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export class ContextPanel {
  readonly toggle: HTMLButtonElement
  private readonly root: HTMLElement
  private readonly title: HTMLElement
  private readonly statusLine: HTMLElement
  private readonly body: HTMLElement
  private readonly actions: HTMLElement
  private view: View = { kind: 'list' }
  private board: ContextBoard | undefined
  private boardError: string | undefined
  private loading = false
  private query = ''
  private showArchived = false
  private highlighted = 0
  private tree: ContextTree | undefined
  private note: { text: string; tone: '' | 'warn' | 'bad' } | undefined
  private busy = false
  private timer: number | undefined
  private searchBox: HTMLInputElement | undefined

  private readonly source: ContextSource
  private readonly composer: () => FrontDeskInputHandle
  private readonly onVisibility: (open: boolean) => void

  constructor(source: ContextSource, composer: () => FrontDeskInputHandle, onVisibility: (open: boolean) => void = () => {}) {
    this.source = source
    this.composer = composer
    this.onVisibility = onVisibility
    ensureStyle()
    this.toggle = el('button', { id: 'ctx-toggle', type: 'button', textContent: '▤ contexts', title: 'Show or hide the shared contexts (references every agent can read)' })
    this.toggle.setAttribute('aria-controls', 'ctx-panel')
    this.toggle.setAttribute('aria-pressed', 'false')
    this.toggle.addEventListener('mousedown', (event) => event.preventDefault()) // keep the caret where it is
    this.toggle.addEventListener('click', () => this.setOpen(!this.open))
    this.title = el('h2', { textContent: 'CONTEXTS' })
    this.actions = el('span', { className: 'ctx-actions' })
    const close = el('button', { type: 'button', textContent: '×', title: 'Hide (Esc)' })
    close.addEventListener('click', () => this.setOpen(false, true))
    this.statusLine = el('div', { className: 'ctx-status', textContent: '' })
    this.statusLine.setAttribute('role', 'status')
    this.body = el('div', { className: 'ctx-body' })
    this.root = el('section', { id: 'ctx-panel', hidden: true },
      el('header', {}, this.title, this.actions, close), this.statusLine, this.body)
    this.root.setAttribute('aria-label', 'Shared contexts')
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault()
        const view = this.view
        if (view.kind === 'list') this.setOpen(false, true)
        else if (view.kind === 'edit' || view.kind === 'meta') this.go({ kind: 'detail', id: view.id, revision: null })
        else this.go({ kind: 'list' })
      }
    })
    document.body.append(this.toggle, this.root)
    if (readStored()) this.setOpen(true)
    const w = window as unknown as { __contexts?: ContextPanel }
    w.__contexts = this
  }

  get open(): boolean {
    return this.root.hidden !== true
  }

  // The bar's rect and the space above it: the toggle sits at the bar's left
  // end, the panel opens above the bar from the left edge.
  place(bar: { x: number; y: number; width: number; height: number }, top: number, narrow: boolean) {
    const size = bar.height - 20
    this.toggle.style.left = `${Math.round(bar.x + 10)}px`
    this.toggle.style.top = `${Math.round(bar.y + 10)}px`
    this.toggle.style.height = `${Math.round(size)}px`
    this.toggle.textContent = narrow ? '▤' : '▤ contexts'
    this.toggle.setAttribute('aria-label', 'contexts')
    const width = narrow ? bar.width : Math.min(460, Math.max(320, bar.width * 0.4))
    const bottom = bar.y - 8
    const height = Math.max(180, bottom - top)
    Object.assign(this.root.style, { left: `${Math.round(bar.x)}px`, top: `${Math.round(bottom - height)}px`, width: `${Math.round(width)}px`, height: `${Math.round(height)}px` })
  }

  // The toggle's width, so the composer can start after it.
  toggleWidth(): number {
    return this.toggle.getBoundingClientRect().width || 0
  }

  setOpen(open: boolean, returnFocus = false) {
    this.root.hidden = !open
    this.toggle.setAttribute('aria-pressed', String(open))
    store(open)
    this.onVisibility(open)
    if (open) {
      void this.load()
      window.clearInterval(this.timer)
      this.timer = window.setInterval(() => { if (this.view.kind === 'list') void this.load() }, REFRESH_MS)
      this.render()
      window.setTimeout(() => this.searchBox?.focus({ preventScroll: true }), 0)
    } else {
      window.clearInterval(this.timer)
      if (returnFocus) this.composer().focus()
    }
  }

  destroy() {
    window.clearInterval(this.timer)
    this.toggle.remove()
    this.root.remove()
  }

  // Called by the scene when the draft changes, for the "in your draft" list.
  draftChanged() {
    if (this.open && this.view.kind === 'list') this.renderDrafts()
  }

  // --- data ----------------------------------------------------------------------

  private async load(refresh = false) {
    this.loading = true
    this.renderStatus()
    const found = await this.source.board({ all: this.showArchived, refresh })
    this.loading = false
    if (found.ok) {
      this.board = found.value
      this.boardError = undefined
    } else {
      // The last list stays on screen; the status says it could not be read.
      this.boardError = found.error
    }
    // The search box is never rebuilt under the user: a refresh while they
    // type (or compose with an IME) replaces the rows only.
    if (this.view.kind === 'list' && this.searchBox?.isConnected) {
      this.renderStatus()
      this.renderRows()
      this.renderDrafts()
    } else if (this.view.kind === 'list') {
      this.render()
    } else {
      this.renderStatus()
    }
  }

  private rows(): ContextRow[] {
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean)
    return (this.board?.sources ?? []).filter((row) => {
      const hay = `${row.id} ${row.name} ${row.description}`.toLowerCase()
      return words.every((word) => hay.includes(word))
    })
  }

  private say(text: string, tone: '' | 'warn' | 'bad' = '') {
    this.note = { text, tone }
    this.renderStatus()
  }

  // `keep` carries the note just said (a creation, a publication) into the
  // next view instead of clearing it.
  private go(view: View, keep = false) {
    this.view = view
    if (!keep) this.note = undefined
    this.render()
    if (view.kind === 'detail') void this.openDetail(view.id, view.revision)
  }

  // --- inserting -----------------------------------------------------------------

  private async insertLatest(row: ContextRow, path = '') {
    if (this.busy) return
    this.busy = true
    this.say(`resolving ${row.id}…`)
    const found = await this.source.resolve(row.id, 'latest')
    this.busy = false
    if (!found.ok) {
      this.say(`could not resolve ${row.id}: ${found.error} — your draft is unchanged`, 'bad')
      return
    }
    this.insert(referenceOf(row.id, found.value.revision, path), found.value.short)
  }

  private insert(reference: string, short: string) {
    this.composer().insert(reference)
    this.say(`inserted ${reference.replace(/@([0-9a-f]{7})[0-9a-f]{33}/, '@$1…')} (${short}); nothing was sent`)
    this.renderDrafts()
  }

  // --- rendering -------------------------------------------------------------------

  private renderStatus() {
    const parts: string[] = []
    let tone: '' | 'warn' | 'bad' = ''
    if (this.note) {
      parts.push(this.note.text)
      tone = this.note.tone
    } else if (this.loading && !this.board) {
      parts.push('reading the catalog…')
    } else if (this.boardError) {
      parts.push(`⚠ ${this.boardError}${this.board ? ' · last list shown' : ''}`)
      tone = 'bad'
    } else if (this.board) {
      const catalog = this.board.catalog
      if (catalog.state === 'unconfigured') {
        parts.push('no catalog is configured on this host')
        tone = 'warn'
      } else if (catalog.state === 'unavailable') {
        parts.push(`⚠ catalog unavailable: ${catalog.error ?? 'never read'}`)
        tone = 'bad'
      } else {
        parts.push(`catalog ${catalog.state}${catalog.revision ? ` at ${catalog.revision.slice(0, 7)}` : ''}, read ${ago(catalog.fetched_at)}`)
        if (catalog.state === 'last-known') {
          parts.push(`⚠ ${catalog.error ?? 'the newest read failed'}`)
          tone = 'warn'
        }
      }
      if (this.loading) parts.push('refreshing…')
    }
    this.statusLine.textContent = parts.join(' · ')
    this.statusLine.className = `ctx-status${tone ? ` ${tone}` : ''}`
  }

  private button(label: string, onClick: () => void, className = '', title = ''): HTMLButtonElement {
    const node = el('button', { type: 'button', textContent: label, className, title })
    node.addEventListener('click', onClick)
    return node
  }

  private render() {
    this.renderStatus()
    this.actions.replaceChildren()
    this.body.replaceChildren()
    this.searchBox = undefined
    switch (this.view.kind) {
      case 'list': return this.renderList()
      case 'detail': return this.renderDetail()
      case 'edit': return this.renderEdit(this.view)
      case 'create': return this.renderCreate()
      case 'register': return this.renderRegister()
      case 'meta': return this.renderMeta(this.view.id)
    }
  }

  private renderList() {
    this.title.textContent = 'CONTEXTS'
    const writable = this.board?.write.configured
    this.actions.append(
      this.button('⟳', () => { this.note = undefined; void this.load(true) }, '', 'Read the catalog and every newest publication again'),
      this.button('+ new', () => this.go({ kind: 'create' }), '', writable ? 'Create a context repository' : (this.board?.write.reason ?? 'writes unavailable')),
    )
    const search = el('input', { type: 'search', placeholder: 'search name or description…', value: this.query })
    search.setAttribute('aria-label', 'Search contexts')
    search.setAttribute('aria-controls', 'ctx-list')
    search.addEventListener('input', () => {
      this.query = search.value
      this.highlighted = 0
      this.renderRows()
    })
    search.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return
      const rows = this.rows()
      if (event.key === 'ArrowDown') { event.preventDefault(); this.highlighted = Math.min(rows.length - 1, this.highlighted + 1); this.renderRows() }
      else if (event.key === 'ArrowUp') { event.preventDefault(); this.highlighted = Math.max(0, this.highlighted - 1); this.renderRows() }
      else if (event.key === 'Enter' && rows[this.highlighted]) { event.preventDefault(); void this.insertLatest(rows[this.highlighted]) }
    })
    this.searchBox = search
    const archived = el('input', { type: 'checkbox', checked: this.showArchived })
    archived.style.width = 'auto'
    archived.addEventListener('change', () => { this.showArchived = archived.checked; void this.load() })
    const archivedLabel = el('label', {}, archived, ` show archived${this.board?.archived_hidden ? ` (${this.board.archived_hidden})` : ''}`)
    archivedLabel.style.display = 'inline'
    const register = this.button('register existing…', () => this.go({ kind: 'register' }))
    this.body.append(
      el('div', { className: 'ctx-drafts', id: 'ctx-drafts', hidden: true }),
      search,
      el('div', { id: 'ctx-list', className: 'ctx-list' }),
      el('div', { className: 'ctx-line' }, archivedLabel, register),
    )
    const list = this.body.querySelector('#ctx-list') as HTMLElement
    list.setAttribute('role', 'listbox')
    this.renderRows()
    this.renderDrafts()
  }

  private renderRows() {
    const list = this.body.querySelector('#ctx-list') as HTMLElement | null
    if (!list) return
    list.replaceChildren()
    const rows = this.rows()
    if (!this.board && this.loading) { list.append(el('div', { className: 'ctx-empty', textContent: 'loading…' })); return }
    if (!this.board) { list.append(el('div', { className: 'ctx-empty', textContent: 'the catalog could not be read; nothing to show yet' })); return }
    if (rows.length === 0) {
      list.append(el('div', { className: 'ctx-empty', textContent: this.query ? `nothing matches “${this.query}”` : 'no context repositories yet — “+ new” creates one' }))
      return
    }
    rows.forEach((row, index) => {
      const head = row.head
      const chip = head.state === 'current' ? null
        : el('span', { className: `ctx-chip ${head.state === 'empty' ? '' : head.state === 'last-known' ? 'warn' : 'bad'}`, textContent: head.state })
      const option = el('div', { className: 'ctx-row', tabIndex: -1 },
        el('div', {}, el('span', { className: 'ctx-name', textContent: row.name }), el('span', { className: 'ctx-id', textContent: `  ${row.id}` }),
          row.status === 'archived' ? el('span', { className: 'ctx-chip', textContent: 'archived' }) : null, chip),
        row.description ? el('div', { className: 'ctx-desc', textContent: row.description }) : null,
        el('div', { className: 'ctx-meta', textContent: head.short ? `${head.short} · ${day(head.date)} · ${head.subject ?? ''}` : head.error ?? 'nothing published yet' }))
      option.setAttribute('role', 'option')
      option.setAttribute('aria-selected', String(index === this.highlighted))
      option.title = `Insert ${row.id}@<newest commit> at the caret`
      option.addEventListener('mousedown', (event) => event.preventDefault())
      option.addEventListener('click', () => { this.highlighted = index; void this.insertLatest(row) })
      const browse = this.button('browse ▸', () => this.go({ kind: 'detail', id: row.id, revision: null }), '', 'README and files')
      browse.addEventListener('mousedown', (event) => event.stopPropagation())
      const line = el('div', { className: 'ctx-line' }, option, browse)
      option.style.flex = '1'
      line.style.margin = '0'
      list.append(line)
    })
  }

  private renderDrafts() {
    const box = this.body.querySelector('#ctx-drafts') as HTMLElement | null
    if (!box || !this.board) return
    const heads = new Map(this.board.sources.map((row) => [row.id, row]))
    const found = refsIn(this.composer().value(), new Set(heads.keys()))
    box.replaceChildren()
    box.hidden = found.length === 0
    if (found.length === 0) return
    box.append(el('div', { className: 'ctx-meta', textContent: 'IN YOUR DRAFT' }))
    for (const ref of found) {
      const row = heads.get(ref.id)!
      const newest = row.head.revision
      const current = newest && newest.startsWith(ref.revision)
      const line = el('div', { className: 'ctx-line' }, el('code', { textContent: ref.text.replace(/@([0-9a-f]{7})[0-9a-f]+/, '@$1…') }))
      if (current) line.append(el('span', { className: 'ctx-chip ok', textContent: 'newest' }))
      else if (newest) {
        line.append(el('span', { className: 'ctx-chip warn', textContent: `newer: ${row.head.short}` }),
          this.button('use newest', () => {
            const next = referenceOf(ref.id, newest, ref.path)
            if (this.composer().replace(ref.text, next)) this.say(`moved ${ref.id} to ${row.head.short} in your draft; nothing was sent`)
            this.renderDrafts()
          }, '', 'Replace this reference in the draft with the newest version'))
      }
      box.append(line)
    }
  }

  // --- a repository ------------------------------------------------------------------

  private async openDetail(id: string, revision: string | null) {
    this.tree = undefined
    const kept = this.note
    this.say(`reading ${id}…`)
    const found = await this.source.tree(id, revision ?? 'latest')
    if (this.view.kind !== 'detail' || this.view.id !== id) return
    if (!found.ok) {
      this.say(`could not read ${id}: ${found.error}`, 'bad')
      this.renderDetail()
      return
    }
    this.tree = found.value
    this.view = { kind: 'detail', id, revision: found.value.revision }
    this.note = kept
    this.render()
  }

  private rowOf(id: string): ContextRow | undefined {
    return this.board?.sources.find((row) => row.id === id)
  }

  private renderDetail() {
    const view = this.view as Extract<View, { kind: 'detail' }>
    const row = this.rowOf(view.id)
    const tree = this.tree && this.tree.id === view.id ? this.tree : undefined
    this.title.textContent = (row?.name ?? view.id).toUpperCase()
    this.actions.append(this.button('← list', () => this.go({ kind: 'list' })))
    if (!tree) {
      this.body.append(el('div', { className: 'ctx-empty', textContent: this.note?.tone === 'bad' ? 'not readable right now' : 'loading…' }))
      return
    }
    const writable = Boolean(this.board?.write.configured)
    const newest = row?.head.revision
    const behind = newest && newest !== tree.revision
    const revision = el('div', { className: 'ctx-line' },
      el('span', { className: 'ctx-meta', textContent: `${view.id} at ${tree.short} · ${day(tree.date)} · ${tree.subject ?? ''}` }))
    if (behind) {
      revision.append(el('span', { className: 'ctx-chip warn', textContent: `newer: ${row!.head.short}` }),
        this.button('view newest', () => this.go({ kind: 'detail', id: view.id, revision: null })))
    }
    const insertAll = this.button(`insert ${view.id}@${tree.short}`, () => this.insert(referenceOf(view.id, tree.revision), tree.short), 'primary', 'Insert a reference to this revision at the caret')
    insertAll.addEventListener('mousedown', (event) => event.preventDefault())
    const tools = el('div', { className: 'ctx-line' }, insertAll)
    if (row?.web) tools.append(el('a', { href: row.web, target: '_blank', rel: 'noopener', textContent: 'open in Gitea ↗' }))
    const manage = el('div', { className: 'ctx-line' })
    if (writable) {
      manage.append(
        this.button('✎ name & description', () => this.go({ kind: 'meta', id: view.id })),
        this.button('+ add / upload files', () => this.go({ kind: 'edit', id: view.id, base: tree.revision, path: '', text: '', isNew: true, uploads: [] })),
        row?.status === 'archived'
          ? this.button('reactivate', () => void this.setStatus(view.id, 'active'))
          : this.button('archive', () => void this.setStatus(view.id, 'archived'), '', 'Hide it from the picker; old references keep working'),
      )
    }
    this.body.append(revision, tools, manage)
    if (row?.description) this.body.append(el('div', { className: 'ctx-desc', textContent: row.description }))
    if (tree.readme) {
      this.body.append(el('label', { textContent: tree.readme.path }), el('pre', { textContent: tree.readme.text + (tree.readme.truncated ? '\n…' : '') }))
    }
    this.body.append(el('label', { textContent: `FILES (${tree.files.length})` }))
    const preview = el('div', {})
    for (const file of tree.files) {
      const pick = el('div', { className: 'ctx-row', tabIndex: 0, textContent: file.path, title: `Insert ${view.id}@${tree.short}:${file.path} at the caret` })
      pick.setAttribute('role', 'button')
      pick.addEventListener('mousedown', (event) => event.preventDefault())
      const choose = () => this.insert(referenceOf(view.id, tree.revision, file.path), tree.short)
      pick.addEventListener('click', choose)
      pick.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); choose() } })
      const line = el('div', { className: 'ctx-file' }, pick, el('span', { className: 'ctx-meta', textContent: `${file.size.toLocaleString()} B` }),
        this.button('view', () => void this.preview(preview, view.id, tree.revision, file.path, file.text)))
      if (writable && file.text && /\.(md|txt|markdown)$/i.test(file.path)) {
        line.append(this.button('edit', () => void this.startEdit(view.id, tree.revision, file.path)))
      }
      this.body.append(line)
    }
    this.body.append(preview)
  }

  private async preview(box: HTMLElement, id: string, revision: string, path: string, text: boolean) {
    box.replaceChildren(el('label', { textContent: path }))
    if (!text) {
      box.append(el('img', { src: this.source.fileUrl(id, revision, path), alt: path }))
      return
    }
    const found = await this.source.fileText(id, revision, path)
    box.append(el('pre', { textContent: found.ok ? found.value : `could not read it: ${found.error}` }))
  }

  private async setStatus(id: string, status: 'active' | 'archived') {
    this.say(`${status === 'archived' ? 'archiving' : 'reactivating'} ${id}…`)
    const found = await this.source.update(id, { status })
    if (!found.ok) { this.say(`could not change ${id}: ${found.error}`, 'bad'); return }
    await this.load(true)
    this.say(status === 'archived' ? `${id} archived: hidden from the picker, old references still resolve` : `${id} is active again`)
    if (this.view.kind === 'detail') this.renderDetail()
  }

  // --- editing and publishing ----------------------------------------------------------

  private async startEdit(id: string, base: string, path: string) {
    this.say(`reading ${path}…`)
    const found = await this.source.fileText(id, base, path)
    if (!found.ok) { this.say(`could not read ${path}: ${found.error}`, 'bad'); return }
    this.go({ kind: 'edit', id, base, path, text: found.value, isNew: false, uploads: [] })
  }

  private renderEdit(view: Extract<View, { kind: 'edit' }>) {
    this.title.textContent = `PUBLISH · ${view.id}`
    this.actions.append(this.button('← back', () => this.go({ kind: 'detail', id: view.id, revision: view.base })))
    const path = el('input', { value: view.path, placeholder: 'notes/idea.md (leave empty to only upload files)' })
    path.readOnly = !view.isNew
    const text = el('textarea', { value: view.text, placeholder: 'Markdown…' })
    text.addEventListener('input', () => { view.text = text.value })
    path.addEventListener('input', () => { view.path = path.value })
    const folder = el('input', { value: 'images/', placeholder: 'folder for uploads, e.g. images/' })
    const picker = el('input', { type: 'file', multiple: true })
    const uploads = el('div', {})
    const showUploads = () => {
      uploads.replaceChildren(...view.uploads.map((file, index) => el('div', { className: 'ctx-line' },
        el('code', { textContent: file.path }), this.button('remove', () => { view.uploads.splice(index, 1); showUploads() }))))
    }
    picker.addEventListener('change', async () => {
      const prefix = folder.value.trim().replace(/^\/+/, '')
      for (const file of Array.from(picker.files ?? [])) {
        const target = `${prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix}${file.name}`
        view.uploads = view.uploads.filter((one) => one.path !== target)
        view.uploads.push({ path: target, base64: toBase64(await file.arrayBuffer()) })
      }
      picker.value = ''
      showUploads()
    })
    showUploads()
    const message = el('input', { placeholder: 'what changed (commit message)' })
    const conflictBox = el('div', {})
    const publish = this.button('publish', () => void this.publish(view, message.value, conflictBox, publish), 'primary',
      'Commit and push these files; agents see it on their next read, existing references keep their commit')
    this.body.append(
      el('div', { className: 'ctx-meta', textContent: `on top of ${view.base.slice(0, 7)}${view.isNew ? '' : ` · editing ${view.path}`}` }),
      el('label', { textContent: 'FILE' }), path, text,
      el('label', { textContent: 'UPLOAD FILES (images, anything)' }), folder, picker, uploads,
      el('label', { textContent: 'MESSAGE' }), message,
      el('div', { className: 'ctx-line' }, publish), conflictBox,
    )
  }

  private async publish(view: Extract<View, { kind: 'edit' }>, message: string, conflictBox: HTMLElement, button: HTMLButtonElement) {
    const files: PublishFile[] = [...view.uploads]
    const path = view.path.trim()
    if (path) files.unshift({ path, text: view.text })
    if (files.length === 0) { this.say('nothing to publish: give a file path with text, or upload a file', 'warn'); return }
    button.disabled = true
    this.say('publishing…')
    const found = await this.source.publish(view.id, { base: view.base, message: message.trim(), files })
    button.disabled = false
    if (!found.ok) {
      if (found.conflict) { this.showConflict(view, found.conflict, conflictBox); this.say(found.error, 'warn'); return }
      this.say(`not published: ${found.error} — your edit is still here`, 'bad')
      return
    }
    await this.load(true)
    this.say(`published ${view.id}@${found.value.short} (${found.value.files.length} file${found.value.files.length === 1 ? '' : 's'}); new selections get it, existing references keep theirs`)
    this.go({ kind: 'detail', id: view.id, revision: found.value.revision }, true)
  }

  private showConflict(view: Extract<View, { kind: 'edit' }>, conflict: Conflict, box: HTMLElement) {
    const touched = conflict.touched.length ? `, including ${conflict.touched.join(', ')} which you are publishing` : ''
    box.replaceChildren(el('div', { className: 'ctx-conflict' },
      el('div', { textContent: `Somebody published ${conflict.short} after the version you started from (${conflict.base.slice(0, 7)}). Changed there: ${conflict.changed.join(', ') || '(unknown)'}${touched}. Nothing was overwritten; your edit is kept.` }),
      el('div', { className: 'ctx-line' },
        this.button(`publish mine on top of ${conflict.short}`, () => { view.base = conflict.head; this.render(); this.say(`now on top of ${conflict.short}; press publish to replace those files with yours`, 'warn') }, 'warn'),
        view.isNew ? null : this.button(`load ${conflict.short}'s version (keeps mine below)`, () => void this.rebase(view, conflict.head)),
      )))
  }

  private async rebase(view: Extract<View, { kind: 'edit' }>, head: string) {
    const found = await this.source.fileText(view.id, head, view.path)
    const theirs = found.ok ? found.value : ''
    view.text = `${theirs}\n\n<!-- your edit, from ${view.base.slice(0, 7)}: merge it above and delete this block -->\n${view.text}`
    view.base = head
    this.render()
    this.say(`showing ${head.slice(0, 7)}'s text with yours below it; merge, then publish`, 'warn')
  }

  // --- creating, registering, renaming --------------------------------------------------

  private renderCreate() {
    this.title.textContent = 'NEW CONTEXT'
    this.actions.append(this.button('← list', () => this.go({ kind: 'list' })))
    const write = this.board?.write
    if (write && !write.configured) this.body.append(el('div', { className: 'ctx-conflict', textContent: `Writes are off: ${write.reason}` }))
    const name = el('input', { placeholder: 'Display name, e.g. Meadow references' })
    const id = el('input', { placeholder: 'id: lower-case, digits, - . _ (never changes)' })
    let touched = false
    id.addEventListener('input', () => { touched = true })
    name.addEventListener('input', () => {
      if (!touched) id.value = name.value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
    })
    const description = el('input', { placeholder: 'What it is for — agents read this to decide' })
    const readme = el('textarea', { placeholder: '# Title\n\nWhat is in here and how it is organised.' })
    const create = this.button('create and publish', async () => {
      create.disabled = true
      this.say(`creating ${id.value}…`)
      const found = await this.source.create({ id: id.value.trim(), name: name.value.trim(), description: description.value.trim(), readme: readme.value })
      create.disabled = false
      if (!found.ok) { this.say(`not created: ${found.error} — press again to finish; nothing is duplicated`, 'bad'); return }
      await this.load(true)
      this.say(`${found.value.id} created (${found.value.steps.join(', ')}) at ${found.value.short}`)
      this.go({ kind: 'detail', id: found.value.id, revision: found.value.revision }, true)
    }, 'primary')
    this.body.append(el('label', { textContent: 'NAME' }), name, el('label', { textContent: 'ID' }), id,
      el('label', { textContent: 'DESCRIPTION' }), description, el('label', { textContent: 'README.md' }), readme,
      el('div', { className: 'ctx-line' }, create))
    window.setTimeout(() => name.focus({ preventScroll: true }), 0)
  }

  private renderRegister() {
    this.title.textContent = 'REGISTER EXISTING'
    this.actions.append(this.button('← list', () => this.go({ kind: 'list' })))
    const id = el('input', { placeholder: 'id (the <source> in references)' })
    const repository = el('input', { placeholder: 'owner/name on this Gitea, or a full git URL' })
    const name = el('input', { placeholder: 'Display name' })
    const description = el('input', { placeholder: 'What it is for' })
    const branch = el('input', { placeholder: 'branch (default: the repository default)' })
    const go = this.button('register', async () => {
      const where = repository.value.trim()
      const body = { id: id.value.trim(), name: name.value.trim(), description: description.value.trim(), branch: branch.value.trim(),
        ...(where.includes('://') || where.startsWith('/') ? { url: where } : { repository: where }) }
      go.disabled = true
      const found = await this.source.register(body)
      go.disabled = false
      if (!found.ok) { this.say(`not registered: ${found.error}`, 'bad'); return }
      await this.load(true)
      this.say(`${found.value.id} registered at ${found.value.short}`)
      this.go({ kind: 'detail', id: found.value.id, revision: found.value.revision }, true)
    }, 'primary')
    this.body.append(el('label', { textContent: 'ID' }), id, el('label', { textContent: 'REPOSITORY' }), repository,
      el('label', { textContent: 'NAME' }), name, el('label', { textContent: 'DESCRIPTION' }), description,
      el('label', { textContent: 'BRANCH' }), branch, el('div', { className: 'ctx-line' }, go),
      el('div', { className: 'ctx-meta', textContent: 'Ordinary git pushes to it keep working; this only adds it to the list every agent reads.' }))
  }

  private renderMeta(id: string) {
    const row = this.rowOf(id)
    this.title.textContent = `EDIT · ${id}`
    this.actions.append(this.button('← back', () => this.go({ kind: 'detail', id, revision: null })))
    const name = el('input', { value: row?.name ?? '' })
    const description = el('input', { value: row?.description ?? '' })
    const save = this.button('save', async () => {
      save.disabled = true
      const found = await this.source.update(id, { name: name.value.trim(), description: description.value.trim() })
      save.disabled = false
      if (!found.ok) { this.say(`not saved: ${found.error}`, 'bad'); return }
      await this.load(true)
      this.say(found.value.changed ? 'saved; references keep the id, so nothing already written changes' : 'nothing changed')
      this.go({ kind: 'detail', id, revision: null }, true)
    }, 'primary')
    this.body.append(el('div', { className: 'ctx-meta', textContent: `id ${id} stays — it is what references carry` }),
      el('label', { textContent: 'NAME' }), name, el('label', { textContent: 'DESCRIPTION' }), description,
      el('div', { className: 'ctx-line' }, save))
  }
}
