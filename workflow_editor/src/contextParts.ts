// Context inside the editors (workflow_editor p13 ex1, p14, p14 ex1;
// docs/context.md): the parts every editor uses to show and change what
// agents are told, where the person already works on the object.
//
// - Reader: one side panel per page. A block (or another context item)
//   opens in it in place, so the editor, the selected run, the scroll
//   position and other drafts stay where they are.
// - BlockCard: one local context block — a Developer instruction, or
//   environment information an agent such as cagent maintains — as a
//   compact row (title, manager, scope where needed, an exception) and a
//   reading surface (full text, details, edit, evidence & history). It is
//   built once and kept, so a live refresh, a display switch, closing the
//   panel or a re-render of the host never replaces the text being typed.
// - BlockList: the blocks of one scope as rows, with one "Add" for new
//   ones; inherited lists name their scope and edit it in place.
// - ListEditor: a list of short values (goals, guide references) edited in
//   place, writing into the host's draft; the host owns the save.
// - ContextSection: the collapsible Context section of Home, a project or a
//   workflow — a summary that is always shown, the host's repository-owned
//   controls ("In the repository"), the local blocks ("Only in this
//   environment") and the wider scopes' blocks and defaults ("Inherited").
//
// Storage is the p14 block store and the p13 resolver: blocks through
// api.blocks/block/putBlock, everything shown as inherited from api.context.
// Default edits stay in the host's own save (project.yaml, the workflow
// file); nothing here saves both kinds at once. Ownership is shown, not
// enforced: anyone may edit any block, and the card says whose it is.
// Disclosure is presentation only: what is delivered and fingerprinted is
// the saved block, never what a row shows.
import type { BlockKind, BlockRevision, BlockState, ContextSource, EvidenceRef, ScopeTarget } from '../shared/context.ts'
import { api, ApiError, type ContextMatrixView } from './api.ts'
import { append, h, when } from './dom.ts'
import { icon } from './icons.ts'

const ACTOR_KEY = 'workflow-editor.actor'
export const storedActor = () => { try { return localStorage.getItem(ACTOR_KEY) ?? '' } catch { return '' } }
const storeActor = (v: string) => { try { localStorage.setItem(ACTOR_KEY, v) } catch { /* per-viewer convenience only */ } }

// Who a block applies to, in the words the person chose by.
export function scopeWords(t: ScopeTarget): string {
  return t.scope === 'system' ? 'all projects' : t.scope === 'project' ? `every workflow of project ${t.project}` : `every run of workflow ${t.workflow}`
}
// The scope a card names (inherited cards say where they really live).
export const scopeName = (t: ScopeTarget) => t.scope === 'system' ? 'All projects' : t.scope === 'project' ? `Project ${t.project}` : `Workflow ${t.workflow}`
const sameTarget = (a: ScopeTarget, b: ScopeTarget) => a.scope === b.scope && a.project === b.project && a.workflow === b.workflow

// A textarea that grows with its text, within bounds.
export function fitRows(ta: HTMLTextAreaElement, min = 3, max = 14) {
  ta.rows = Math.min(max, Math.max(min, ta.value.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 80)), 0)))
}

// "3 h ago", from a recorded time; the prompt never carries this.
export function ago(at: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(at)) / 1000)
  if (!Number.isFinite(s)) return at
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`
}
const KIND_WORD: Record<BlockKind, string> = { instruction: 'Instruction', information: 'Environment information' }
const STATUS_WORD: Record<EvidenceRef['status'], string> = { ok: 'verified', unknown: 'not verified', partial: 'partly verified', failed: 'check failed' }
// The newest and the oldest observation the block's evidence rests on, and the worst status.
export function freshness(evidence: EvidenceRef[]): { newest: string | null; oldest: string | null; unknownTime: boolean; worst: EvidenceRef['status'] | null } {
  const times = evidence.map(e => e.observed).filter((t): t is string => !!t).sort()
  const order = ['ok', 'unknown', 'partial', 'failed'] as const
  const worst = evidence.reduce<EvidenceRef['status'] | null>((w, e) => (w === null || order.indexOf(e.status) > order.indexOf(w) ? e.status : w), null)
  return { newest: times.at(-1) ?? null, oldest: times[0] ?? null, unknownTime: evidence.some(e => !e.observed), worst }
}
// A system block reaches every run of every project: a few short lines.
const SYSTEM_LINES = 5
const fill = (el: HTMLElement, ...kids: Parameters<typeof append>[1]) => { el.replaceChildren(); append(el, kids) }
const slug = (title: string) => title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'block'

// How many rows a text takes at a list's reading width: wide (CJK) characters
// count twice, so a few explicit newlines do not make long sentences short.
const ROW_COLUMNS = 96
export function renderedRows(text: string, columns = ROW_COLUMNS): number {
  return text.split('\n').reduce((n, line) => {
    let w = 0
    for (const ch of line) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
    return n + Math.max(1, Math.ceil(w / columns))
  }, 0)
}
// Short human guidance stays readable in the list; anything longer opens.
export const inlineText = (kind: BlockKind | 'guide', text: string) => kind === 'instruction' && text.trim() !== '' && renderedRows(text.trim()) <= 2

// Ordinary prose for reading: paragraphs, lists, headings and `code`, built
// as DOM text (never HTML from the text), so a body reads as text, not as a
// diagnostic block.
export function prose(text: string): HTMLElement {
  const root = h('div.ctx-prose')
  const inline = (s: string) => s.split(/(`[^`\n]+`)/).filter(Boolean).map(p => p.length > 2 && p.startsWith('`') && p.endsWith('`') ? h('code', p.slice(1, -1)) : p)
  let list: HTMLElement | null = null
  let fence: string[] | null = null
  for (const line of text.replace(/\r\n/g, '\n').trim().split('\n')) {
    if (fence) { if (/^```/.test(line)) { root.append(h('pre.ctx-prose-code', fence.join('\n'))); fence = null } else fence.push(line); continue }
    if (/^```/.test(line)) { list = null; fence = []; continue }
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      const ordered = /^\s*\d/.test(line)
      if (!list || (list.tagName === 'OL') !== ordered) { list = h(ordered ? 'ol' : 'ul'); root.append(list) }
      list.append(h('li', ...inline(item[1])))
      continue
    }
    list = null
    if (!line.trim()) continue
    const head = /^(#{1,4})\s+(.*)$/.exec(line)
    root.append(head ? h('h3', ...inline(head[2])) : h('p', ...inline(line)))
  }
  if (fence) root.append(h('pre.ctx-prose-code', fence.join('\n')))
  return root
}

// ---- the reading surface ------------------------------------------------------

// One side panel for the page. What it shows belongs to its owner and is
// only attached here, so closing it or opening another item keeps every
// draft; focus returns to the row it was opened from.
class Reader {
  private aside: HTMLElement | null = null
  private readonly slot = h('div.ctx-reader-content')
  private owner: object | null = null
  private opener: HTMLElement | null = null
  private onClose: (() => void) | null = null

  private ensure(): HTMLElement {
    if (this.aside) return this.aside
    const close = h('button.ctx-reader-close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon('close', 'icon small'), h('span', 'Close'))
    this.aside = h('aside.ctx-reader', { hidden: true, role: 'dialog', 'aria-modal': 'false' }, h('div.ctx-reader-bar', close), this.slot)
    // Esc closes it wherever the focus is (a re-rendered control may have dropped it).
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented && this.aside && !this.aside.hidden) { e.preventDefault(); this.close() } })
    window.addEventListener('resize', () => this.place())
    document.body.append(this.aside)
    return this.aside
  }
  // Below the page's sticky header, so its display switch and crumbs stay usable.
  private place() {
    if (!this.aside || this.aside.hidden) return
    const header = document.querySelector<HTMLElement>('#app > header.topbar, #app > header.app-header')
    this.aside.style.top = `${Math.max(0, header?.getBoundingClientRect().bottom ?? 0)}px`
  }
  isShowing(owner: object) { return this.owner === owner && !!this.aside && !this.aside.hidden }
  show(owner: object, content: HTMLElement, opts: { label: string; opener?: HTMLElement | null; onClose?: () => void }) {
    const aside = this.ensure()
    if (this.owner && this.owner !== owner) this.close(false)
    this.owner = owner
    this.opener = opts.opener ?? (document.activeElement as HTMLElement | null)
    this.onClose = opts.onClose ?? null
    aside.setAttribute('aria-label', opts.label)
    if (content.parentElement !== this.slot) this.slot.replaceChildren(content)
    aside.hidden = false
    this.place()
    document.documentElement.classList.add('ctx-reading')
    const first = content.querySelector<HTMLElement>('[data-reader-focus]') ?? aside.querySelector<HTMLElement>('.ctx-reader-close')
    first?.focus({ preventScroll: true })
  }
  close(restoreFocus = true) {
    if (!this.aside || this.aside.hidden) { this.owner = null; return }
    const opener = this.opener, done = this.onClose
    this.aside.hidden = true
    document.documentElement.classList.remove('ctx-reading')
    this.slot.replaceChildren()
    this.owner = null; this.opener = null; this.onClose = null
    done?.()
    if (restoreFocus && opener?.isConnected) opener.focus({ preventScroll: true })
  }
  closeFor(owner: object) { if (this.owner === owner) this.close() }
}
export const reader = new Reader()
// The page changes (a new route): the panel belongs to the old view.
export const closeReader = () => reader.close(false)

// A row of a context list, in the shape of the Workflows list: a title at
// the same level as a workflow's, one short line under it, one action.
export function contextRow(opts: { kind?: string; iconName?: Parameters<typeof icon>[0]; title: string; inline?: HTMLElement | null; meta: (string | HTMLElement | null)[]; action: HTMLElement }): HTMLElement {
  return h('div.ctx-row', { dataset: { kind: opts.kind ?? 'source' } },
    h('span.ctx-row-icon', icon(opts.iconName ?? 'doc', 'icon')),
    h('div.ctx-row-main', h('strong.ctx-row-title', opts.title), opts.inline ?? null, metaLine(opts.meta)),
    opts.action)
}
function metaLine(bits: (string | HTMLElement | null)[]): HTMLElement {
  const line = h('span.ctx-row-meta')
  bits.filter((b): b is string | HTMLElement => !!b).forEach((b, i) => { if (i) line.append(h('span.ctx-sep', ' · ')); line.append(typeof b === 'string' ? h('span', b) : b) })
  return line
}

export interface BlockCardOptions {
  // An inherited card: edited in place, but saving says it applies to a wider scope.
  wider?: boolean
  // Name the scope on the row (the grouping does not already say it).
  showScope?: boolean
  // A new block of this kind (no id yet): opens in edit mode.
  create?: BlockKind
  taken?: () => string[] // ids already used in the scope (a new block picks a free one)
  onChange?: () => void // the draft or its saved state changed
  onSaved?: (s: BlockState) => void
  onCancelNew?: () => void
}

export class BlockCard {
  // The row in its list; the reading surface is `panel`, shown in the Reader.
  readonly el: HTMLElement
  readonly panel: HTMLElement
  private target: ScopeTarget
  private id: string | null
  private readonly opts: BlockCardOptions
  private readonly rowIcon = h('span.ctx-row-icon')
  private readonly rowMain = h('div.ctx-row-main')
  private readonly rowAction: HTMLButtonElement
  private readonly readHead = h('header.ctx-read-head')
  private readonly readBody = h('div.ctx-read-body')
  private readonly readActions = h('div.ctx-read-actions')
  private readonly editBox = h('div.ctx-block-edit')
  private readonly titleIn: HTMLInputElement
  private readonly kindIn: HTMLSelectElement
  private readonly kindField: HTMLElement
  private readonly ta: HTMLTextAreaElement
  private readonly by: HTMLInputElement
  private readonly sizeNote = h('p.small.ctx-size')
  private readonly buttons = h('div.row.tight.ctx-save-row')
  private readonly status = h('div.ctx-status')
  private readonly evidence = h('details.ctx-evidence-box')
  private readonly evidenceNote = h('span.small.muted')
  private readonly evidenceBody = h('div.ctx-evidence-body')
  private readonly detail = h('div.d-only.ctx-block-detail')
  private base: BlockState | null = null // the block as last read (what a save replaces)
  private remote: BlockState | null = null // a newer saved state seen while the draft was dirty
  private revisions: BlockRevision[] | null = null
  private editing = false
  private busy = false
  private message: { kind: 'ok' | 'error' | 'warn'; text: string; extra?: HTMLElement } | null = null

  constructor(target: ScopeTarget, state: BlockState | null, opts: BlockCardOptions = {}) {
    this.target = target
    this.opts = opts
    this.id = state?.id ?? null
    const uid = `blk-${Math.random().toString(36).slice(2, 9)}`
    this.titleIn = h('input.ctx-block-title', { id: `${uid}-t`, placeholder: 'A short title', oninput: () => this.changed() }) as HTMLInputElement
    this.kindIn = h('select.ctx-block-kind', { id: `${uid}-k`, onchange: () => this.changed() },
      h('option', { value: 'instruction' }, 'Instruction — guidance agents follow'), h('option', { value: 'information' }, 'Environment information — facts and advice')) as HTMLSelectElement
    this.kindField = h('label.field.small', { htmlFor: this.kindIn.id }, h('span', 'Kind'), this.kindIn)
    this.ta = h('textarea.context-editor', { id: `${uid}-b`, rows: 3, spellcheck: false, placeholder: 'In your words. Keep blocks for all projects to a few short lines.' }) as HTMLTextAreaElement
    this.ta.addEventListener('input', () => { fitRows(this.ta); this.changed() })
    this.by = h('input.ctx-by', { 'aria-label': 'Revision author', placeholder: 'your name', value: storedActor(), size: 12, oninput: () => storeActor(this.by.value.trim()) }) as HTMLInputElement
    this.editBox.append(
      h('label.field.small', { htmlFor: this.titleIn.id }, h('span', 'Title'), this.titleIn),
      this.kindField,
      h('label.ctx-label', { htmlFor: this.ta.id }, 'Text'), this.ta, this.sizeNote, this.buttons)
    this.rowAction = h('button.ctx-row-action', { type: 'button', onclick: () => this.open(this.rowEdits()) }) as HTMLButtonElement
    this.el = h('div.ctx-row.ctx-block-row', { dataset: { scope: target.scope } }, this.rowIcon, this.rowMain, this.rowAction)
    this.evidence.append(h('summary', 'Evidence & history', this.evidenceNote), this.evidenceBody)
    this.evidence.addEventListener('toggle', () => { if (this.evidence.open && this.revisions === null) void this.loadHistory() })
    this.panel = h('article.ctx-block', { dataset: { scope: target.scope } }, this.readHead, this.status, this.readBody, this.editBox, this.readActions, this.evidence, this.detail)
    if (state) this.update(state)
    else { this.editing = true; this.kindIn.value = opts.create ?? 'instruction'; this.setDraft('', '') }
    this.renderAll()
  }

  get blockId() { return this.id }
  get saved(): BlockState | null { return this.base }
  get title() { return this.base?.block?.title ?? this.id ?? '' }
  isNew() { return this.id === null }
  isOpen() { return reader.isShowing(this) }
  isDirty() {
    if (!this.editing) return false
    const b = this.base?.block
    if (!b) return this.ta.value.trim() !== '' || this.titleIn.value.trim() !== ''
    return this.ta.value !== b.body || this.titleIn.value !== b.title || this.kindIn.value !== b.kind
  }
  // The row's action: a short instruction already reads in full in the row, so it edits.
  private rowEdits() { const b = this.base?.block; return !this.editing && !!b && inlineText(b.kind, b.body) }
  focus() { this.rowAction.focus({ preventScroll: true }); this.el.scrollIntoView({ block: 'nearest' }) }

  // Opens the reading surface in the page's panel (editing, if asked).
  open(edit = false) {
    if (edit && !this.editing) { this.editing = true; this.resetDraft(); this.message = null; this.renderAll() }
    reader.show(this, this.panel, { label: this.base?.block?.title ?? 'New context block', opener: this.rowAction, onClose: () => this.closed() })
    if (this.editing) (this.isNew() ? this.titleIn : this.ta).focus({ preventScroll: true })
  }
  edit() { this.open(true) }
  // Closing keeps a draft (the row says so); an untouched edit ends; an
  // untouched new block is dropped.
  private closed() {
    if (this.isNew() && !this.isDirty()) { this.opts.onCancelNew?.(); return }
    if (this.editing && !this.isDirty()) { this.editing = false; this.resetDraft() }
    this.message = null
    this.renderAll()
    this.opts.onChange?.()
  }

  // A newer read of the block. A clean card follows it; a draft is never
  // replaced: a newer saved state is announced, and saving then conflicts.
  update(state: BlockState) {
    if (this.id !== null && state.id !== this.id) return
    if (!this.isDirty()) {
      this.base = state; this.remote = null
      if (!this.editing) this.resetDraft()
    } else if (state.base !== this.base?.base) this.remote = state
    else this.remote = null
    if (this.revisions && state.revision !== this.base?.revision) this.revisions = null
    this.renderAll()
  }
  setTarget(t: ScopeTarget) { if (!sameTarget(t, this.target)) { this.target = t; this.renderAll() } }

  private changed() { this.renderButtons(); this.renderRow(); this.opts.onChange?.() }
  private resetDraft() { const b = this.base?.block; this.setDraft(b?.title ?? '', b?.body ?? ''); if (b) this.kindIn.value = b.kind }
  // Replaces the text without losing the caret of someone typing in it.
  private setDraft(title: string, body: string) {
    if (this.titleIn.value !== title && document.activeElement !== this.titleIn) this.titleIn.value = title
    if (this.ta.value === body) return
    const focused = document.activeElement === this.ta
    const sel = focused ? [this.ta.selectionStart, this.ta.selectionEnd] as const : null
    this.ta.value = body
    fitRows(this.ta)
    if (sel) try { this.ta.setSelectionRange(Math.min(sel[0], body.length), Math.min(sel[1], body.length)) } catch { /* not focused */ }
  }
  private say(kind: 'ok' | 'error' | 'warn', text: string, extra?: HTMLElement) { this.message = { kind, text, extra }; this.renderStatus() }

  private async loadHistory() {
    if (!this.id) return
    try { this.revisions = (await api.block(this.target, this.id)).revisions } catch (e) { this.revisions = []; this.say('error', `History not read: ${(e as Error).message}`) }
    this.renderEvidence()
  }

  async save(remove = false) {
    const by = this.by.value.trim()
    if (!by) { this.say('error', `Enter your name next to ${remove ? 'Remove' : 'Save'}: every revision records who wrote it.`); this.by.focus(); return }
    const title = this.titleIn.value.trim()
    if (!remove && (!title || !this.ta.value.trim())) { this.say('error', 'A block needs a title and some text.'); return }
    this.busy = true; this.renderButtons()
    let id = this.id
    if (id === null) {
      const taken = new Set(this.opts.taken?.() ?? [])
      const s = slug(title)
      id = s
      for (let n = 2; taken.has(id); n++) id = `${s}-${n}`
    }
    const t = this.target
    let removed = false
    try {
      const r = await api.putBlock(remove
        ? { ...t, op: 'remove', block: id, base: this.base?.base ?? 0, by }
        : { ...t, op: 'set', block: id, base: this.base?.base ?? 0, by, title, kind: this.kindIn.value as BlockKind, body: this.ta.value })
      this.id = id
      this.base = r.state; this.remote = null; this.revisions = r.revisions
      this.editing = false
      this.resetDraft()
      removed = remove && r.changed
      this.say('ok', !r.changed ? 'Unchanged: that is already the saved block.'
        : `${remove ? 'Removed' : 'Saved'} for ${scopeWords(t)}. It is used from the next attempt${this.opts.wider ? ' of every affected run' : ''}; nothing was started or resumed, and work in progress keeps what it was given.`)
      this.opts.onSaved?.(r.state)
    } catch (e) {
      const conflict = e instanceof ApiError && (e.detail as { code?: string } | undefined)?.code === 'context-conflict'
      const cur = conflict ? (e.detail as { current: BlockState }).current : null
      if (cur) {
        const cb = cur.block
        this.say('error', `Not ${remove ? 'removed' : 'saved'}: ${cb ? `${cb.editor.by} changed this block (${when(cb.editor.at)})` : 'it was removed'} after you started. Your text is kept here.`,
          h('div.ctx-conflict', h('p.small', 'Saved now:'), h('pre.small', cb?.body ?? '(removed)'),
            h('div.row.tight',
              h('button', { type: 'button', onclick: () => { this.base = cur; this.remote = null; this.editing = false; this.resetDraft(); this.message = null; this.renderAll(); this.opts.onChange?.() } }, 'Use the saved text (discard mine)'),
              h('button', { type: 'button', onclick: () => { this.base = cur; this.remote = null; this.message = null; void this.save(remove) } }, remove ? 'Remove it anyway' : 'Save mine over it'))))
      } else this.say('error', `Not ${remove ? 'removed' : 'saved'}: ${(e as Error).message} Your text is kept; try again.`)
    }
    this.busy = false
    this.renderAll()
    this.opts.onChange?.()
    // A removed block leaves its list; its history stays in the store.
    if (removed) reader.closeFor(this)
  }

  private renderAll() { this.renderRow(); this.renderHead(); this.renderBody(); this.renderActions(); this.renderButtons(); this.renderStatus(); this.renderEvidence(); this.renderDetail() }

  // The exceptions worth a glance in the list; times and coverage are in the panel.
  private states(): HTMLElement[] {
    const s = this.base, b = s?.block
    const out: HTMLElement[] = []
    const add = (kind: 'warn' | 'error' | 'muted', text: string) => out.push(h(`span.ctx-row-state.${kind}`, text))
    if (s?.problem) add('error', 'Cannot be read')
    if (this.isDirty()) add('warn', this.remote ? 'Unsaved changes · changed elsewhere' : 'Unsaved changes')
    if (b?.refresh) add(b.refresh.outcome === 'failed' ? 'error' : 'warn', b.refresh.outcome === 'failed' ? 'Last refresh failed' : 'Last refresh was partial')
    if (b?.kind === 'information') {
      const worst = freshness(b.evidence).worst
      if (!b.evidence.length) add('warn', 'No evidence recorded')
      else if (worst === 'failed') add('error', 'A check failed')
      else if (worst === 'partial') add('warn', 'Partly verified')
      else if (worst === 'unknown') add('muted', 'Not verified')
    }
    if (s?.external) add('warn', 'Edited outside WFE')
    return out.slice(0, 2)
  }

  private renderRow() {
    const b = this.base?.block
    const kind = (b?.kind ?? this.kindIn.value) as BlockKind
    this.el.dataset.kind = kind
    if (this.id) this.el.dataset.block = this.id
    this.el.classList.toggle('editing', this.editing)
    const title = b?.title ?? (this.titleIn.value.trim() || (kind === 'information' ? 'New environment information' : 'New instruction'))
    const inline = b && !this.isDirty() && inlineText(b.kind, b.body) ? h('p.ctx-row-inline', b.body.trim()) : null
    this.rowIcon.replaceChildren(icon(kind === 'information' ? 'doc' : 'person', 'icon'))
    this.rowMain.replaceChildren(...[h('strong.ctx-row-title', title), inline].filter((x): x is HTMLElement => !!x),
      metaLine([b ? h('span.ctx-row-manager', b.manager) : null, this.opts.showScope ? h('span.ctx-row-scope', scopeName(this.target)) : null, ...this.states()]))
    const edits = this.rowEdits()
    this.rowAction.textContent = edits ? 'Edit' : 'Open'
    this.rowAction.setAttribute('aria-label', `${edits ? 'Edit' : 'Open'} ${title}`)
  }

  private renderHead() {
    const b = this.base?.block
    const kind = (b?.kind ?? this.kindIn.value) as BlockKind
    this.panel.dataset.kind = kind
    this.panel.classList.toggle('editing', this.editing)
    this.panel.classList.toggle('removed', !!this.base && !b)
    const title = b?.title ?? (this.isNew() ? (kind === 'information' ? 'New environment information' : 'New instruction') : this.id ?? '')
    this.readHead.replaceChildren(
      h('h2.ctx-read-title', { tabIndex: -1, dataset: { readerFocus: '' } }, title),
      h('p.ctx-read-sub', [b || this.isNew() ? KIND_WORD[kind] : null, b ? `Managed by ${b.manager}` : null, scopeName(this.target)].filter(Boolean).join(' · ')))
  }

  private renderBody() {
    const s = this.base, b = s?.block
    this.readBody.hidden = this.editing
    if (this.editing) { this.readBody.replaceChildren(); return }
    this.readBody.replaceChildren(!b ? h('p.muted', s ? `Removed (revision ${s.revision}); its history stays.` : '') : prose(b.body))
  }

  // Details, consultation and Edit: one deliberate step from the text.
  private renderActions() {
    const b = this.base?.block
    this.readActions.hidden = this.editing || !b
    if (!b || this.editing) { this.readActions.replaceChildren(); return }
    const consult = b.consult ? /^([^/\s]+)\/([^/\s]+)$/.exec(b.consult) : null
    fill(this.readActions,
      ...b.details.map(d => h('a.button.ctx-detail-link', { href: api.detailUrl(`context:${this.scopePath()}/${b.id}/${d.name}`), target: '_blank', rel: 'noopener', title: `context:${this.scopePath()}/${b.id}/${d.name}` }, b.details.length === 1 ? 'View resource details' : `Details: ${d.name}`)),
      b.consult ? (consult ? h('a.button.ctx-consult', { href: `#/ws/${encodeURIComponent(consult[1])}`, target: '_blank', rel: 'noopener', title: `Request a run of ${b.consult} in a new tab` }, `Ask ${b.manager}`) : h('span.small.muted', `Ask ${b.manager}: ${b.consult}`)) : null,
      h('button.ctx-edit', { type: 'button', onclick: () => this.edit() }, 'Edit'))
  }
  private scopePath() { const t = this.target; return t.scope === 'system' ? 'system' : t.scope === 'project' ? `project/${t.project}` : `workflow/${t.project}/${t.workflow}` }

  private renderButtons() {
    this.editBox.hidden = !this.editing
    this.kindField.hidden = !this.isNew()
    if (!this.editing) { this.buttons.replaceChildren(); this.sizeNote.replaceChildren(); return }
    const dirty = this.isDirty()
    const b = this.base?.block
    // The size: the body's rows are the editorial measure (a few for all
    // projects); the bytes are the whole delivered section.
    const rows = renderedRows(this.ta.value.trimEnd())
    const heavy = this.target.scope === 'system' && rows > SYSTEM_LINES
    const size = this.base?.size
    this.sizeNote.className = `small ctx-size ${heavy ? 'warn-text' : 'muted'}`
    this.sizeNote.textContent = `${rows} row${rows === 1 ? '' : 's'} of text${size ? ` · ${size.bytes} bytes delivered as saved` : ''}${heavy ? ` — every run of every project gets this; aim for ${SYSTEM_LINES} rows or fewer` : ''}`
    const theirs = b && b.manager !== this.by.value.trim() ? h('p.small.muted.ctx-theirs', `This block is managed by ${b.manager}. Your edit is kept in its history with your name; ${b.manager} reads it before its next update.`) : null
    fill(this.buttons,
      h('button.primary', { type: 'button', disabled: this.busy || !dirty, onclick: () => void this.save() }, this.busy ? 'Saving…' : 'Save'),
      h('button', { type: 'button', disabled: this.busy, onclick: () => { if (this.isNew()) { this.opts.onCancelNew?.(); return } this.editing = false; this.resetDraft(); this.message = null; this.renderAll(); this.opts.onChange?.() } }, dirty ? 'Discard changes' : 'Cancel'),
      h('label.small.ctx-by-label', 'as ', this.by),
      h(`span.small.ctx-state${dirty ? '.warn-text' : '.muted'}`, dirty ? 'Unsaved changes' : 'No changes'),
      b ? h('button.small.danger.ctx-remove', { type: 'button', disabled: this.busy, title: 'Remove this block; other blocks and repository-owned context stay', onclick: () => { if (confirm(`Remove "${b.title}" for ${scopeWords(this.target)}? Other blocks stay; its history is kept.`)) void this.save(true) } }, 'Remove') : null,
      theirs,
      this.opts.wider ? h('p.small.muted.ctx-wider-note', `You are editing a wider scope: this applies to ${scopeWords(this.target)}, not only here.`) : null)
  }

  private renderStatus() {
    const parts: HTMLElement[] = []
    if (this.base?.problem) parts.push(h('div.banner.error.small', this.base.problem))
    if (this.base?.external) parts.push(h('div.banner.warn.small', 'This block\'s file was edited outside WFE since its last revision; saving keeps that content as a revision first.'))
    const r = this.base?.block?.refresh
    if (r) parts.push(h(`div.banner.${r.outcome === 'failed' ? 'error' : 'warn'}.small.ctx-refresh`, icon('alert', 'icon small'), ` Refresh ${r.outcome} ${ago(r.at)}: ${r.detail}. The text below is from the earlier evidence.`))
    if (this.remote) parts.push(h('div.banner.warn.small', `Changed elsewhere while you were editing${this.remote.block ? ` (${this.remote.block.editor.by}, ${when(this.remote.block.editor.at)})` : ' (removed)'}. Your text is kept; saving it will ask which one to keep.`))
    if (this.message) parts.push(h(`div.banner.${this.message.kind}.small`, this.message.text, this.message.extra ?? null))
    this.status.replaceChildren(...parts)
  }

  // Evidence & history: who edited it last, what it rests on (observed
  // times, coverage, status), checks and refreshes, and every revision.
  private renderEvidence() {
    const s = this.base, b = s?.block
    this.evidence.hidden = !s || this.editing && this.isNew()
    if (!s) return
    const f = b ? freshness(b.evidence) : null
    this.evidenceNote.textContent = b?.kind === 'information' && f?.newest ? ` — observed ${ago(f.newest)}` : ''
    const r = this.revisions
    fill(this.evidenceBody,
      b ? h('p.small.ctx-editor', `Last edited by ${b.editor.by} · ${when(b.editor.at)} (${ago(b.editor.at)})`, b.editor.run ? ` · ${b.editor.run}` : '', b.editor.via ? h('span.muted', ` · via ${b.editor.via}`) : null) : null,
      b && b.kind === 'information' && !b.evidence.length ? h('p.small.warn-text', 'No evidence is recorded for this information.') : null,
      b?.evidence.length ? h('div.ctx-evidence', h('p.small', h('strong', 'Evidence')), h('ul.small', ...b.evidence.map(e => h('li',
        h(`span.chip${e.status === 'ok' ? '.ok' : e.status === 'unknown' ? '.muted' : '.warn'}`, STATUS_WORD[e.status]), ' ', h('span.chip.muted', e.basis), ' ',
        e.observed ? `observed ${when(e.observed)} (${ago(e.observed)})` : 'observation time not known', e.coverage ? ` · ${e.coverage}` : '', ' — ',
        e.ref.startsWith('context:') ? h('a', { href: api.detailUrl(e.ref), target: '_blank', rel: 'noopener' }, e.title ?? e.ref) : h('span', e.title ? `${e.title}: ` : '', h('code', e.ref)))))) : null,
      b?.checked ? h('p.small.muted.ctx-checked', `Checked ${when(b.checked.at)} by ${b.checked.by}${b.checked.run ? ` (${b.checked.run})` : ''}${b.checked.note ? ` — ${b.checked.note}` : ''}. A check is bookkeeping: it changes no prompt.`) : null,
      b?.refresh ? h('p.small.error-text', `Refresh ${b.refresh.outcome} ${when(b.refresh.at)} by ${b.refresh.by}${b.refresh.run ? ` (${b.refresh.run})` : ''}: ${b.refresh.detail}.`) : null,
      h('p.small', h('strong', `Revision history (${s.revisions})`)),
      !this.evidence.open && r === null ? null : r === null ? h('p.small.muted', 'Loading…')
        : r.length ? h('ol.ctx-revisions', { reversed: true }, ...[...r].reverse().map(x => h('li',
          h('div.small', h('strong', `revision ${x.rev}`), ` · ${x.op}${x.content ? '' : ' (bookkeeping)'} · ${when(x.at)} · ${x.by}${x.run ? ` · ${x.run}` : ''}${x.via ? ` · ${x.via}` : ''}${x.note ? ` — ${x.note}` : ''}`),
          x.block && (x.op === 'set' || x.op === 'external' || x.op === 'converted') ? h('pre.small', x.block.body) : x.block ? null : h('p.small.muted', 'removed'))))
          : h('p.small.muted', 'No revision yet.'))
  }

  // Detail: the technical identity (file, revisions, hashes, sizes).
  private renderDetail() {
    const s = this.base, b = s?.block
    if (!s) { this.detail.replaceChildren(); return }
    fill(this.detail,
      h('p.small.muted', [s.file, `revision ${s.revision}`, `content revision ${s.base}`, s.sha256 ? `section sha256 ${s.sha256.slice(0, 12)}` : null, s.size ? `${s.size.lines} lines · ${s.size.bytes} bytes delivered` : null, b ? `id ${b.id}` : null].filter(Boolean).join(' · ')),
      b?.details.length ? h('p.small.muted', 'Details: ', ...b.details.flatMap((d, i) => [i ? ', ' : '', h('code', `context:${this.scopePath()}/${b.id}/${d.name}`), ` (${d.bytes} bytes, ${when(d.at)})`])) : null,
      b?.consult ? h('p.small.muted', `Consultation workflow: ${b.consult}`) : null)
  }
}

// The blocks of one scope as rows, with one "Add" for new ones. Cards are
// kept by id across refreshes, so drafts survive.
export class BlockList {
  readonly el: HTMLElement
  private target: ScopeTarget
  private readonly opts: { wider?: boolean; showScope?: boolean; empty?: string; onChange?: () => void; onSaved?: () => void }
  private readonly cards = new Map<string, BlockCard>()
  private readonly fresh: BlockCard[] = []
  private readonly list = h('div.ctx-blocks.ctx-rows')
  private readonly addButton: HTMLButtonElement
  private readonly addMenu = h('div.ctx-add-menu', { hidden: true, role: 'menu' })
  // The list's one Add entry, placed by the host (in its heading).
  readonly addControl: HTMLElement
  private states: BlockState[] = []
  private loaded = false
  private error = ''

  constructor(target: ScopeTarget, opts: BlockList['opts'] = {}) {
    this.target = target
    this.opts = opts
    this.addButton = h('button.ctx-add-button', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => this.toggleMenu() }, icon('plus', 'icon small'), 'Add') as HTMLButtonElement
    const choice = (kind: BlockKind, label: string, note: string) => h('button.ctx-add-choice', { type: 'button', role: 'menuitem', onclick: () => { this.toggleMenu(false); this.add(kind) } }, h('strong', label), h('span.small.muted', note))
    this.addMenu.append(choice('instruction', 'Instruction', 'Guidance agents follow'), choice('information', 'Environment information', 'Facts and advice about resources'))
    this.addMenu.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); this.toggleMenu(false); this.addButton.focus() } })
    this.addControl = h('div.ctx-add', this.addButton, this.addMenu)
    // Closes when the keyboard or a pointer leaves it (Safari does not focus a clicked button).
    this.addControl.addEventListener('focusout', e => { if (e.relatedTarget && !this.addControl.contains(e.relatedTarget as Node)) this.toggleMenu(false) })
    this.el = h('div.ctx-block-list', { dataset: { scope: target.scope } }, this.list)
    this.render()
  }

  get scope() { return this.target }
  isDirty() { return [...this.cards.values(), ...this.fresh].some(c => c.isDirty()) }
  present() { return this.states.filter(s => s.block) }
  cardsShown(): BlockCard[] { return [...this.present().map(s => this.cards.get(s.id)).filter((c): c is BlockCard => !!c), ...this.fresh] }
  setTarget(t: ScopeTarget) {
    if (sameTarget(t, this.target)) return
    this.target = t
    // Saved cards belong to the old scope; a new, unsaved card follows the
    // list to its real scope (the first read names it), its draft kept.
    this.cards.clear(); this.states = []; this.loaded = false
    for (const c of this.fresh) c.setTarget(t)
    this.render()
  }
  focus() { (this.fresh[0] ?? this.cardsShown()[0])?.focus() }
  // Focus the first block, or the Add entry when there is none.
  focusFirst() { if (this.cardsShown().length) this.focus(); else this.addButton.focus({ preventScroll: true }) }
  private readonly outside = (e: Event) => { if (!this.addControl.contains(e.target as Node)) this.toggleMenu(false) }
  private toggleMenu(open = this.addMenu.hidden) {
    if (open === !this.addMenu.hidden) return
    this.addMenu.hidden = !open
    this.addButton.setAttribute('aria-expanded', String(open))
    if (open) document.addEventListener('pointerdown', this.outside, true)
    else document.removeEventListener('pointerdown', this.outside, true)
    if (open) this.addMenu.querySelector<HTMLElement>('button')?.focus()
  }

  add(kind: BlockKind) {
    const card: BlockCard = new BlockCard(this.target, null, {
      create: kind, wider: this.opts.wider, showScope: this.opts.showScope, taken: () => this.states.map(s => s.id),
      onChange: () => { this.render(); this.opts.onChange?.() },
      onSaved: s => { this.fresh.splice(this.fresh.indexOf(card), 1); this.cards.set(s.id, card); this.states = [...this.states.filter(x => x.id !== s.id), s]; this.render(); this.opts.onSaved?.() },
      onCancelNew: () => { const i = this.fresh.indexOf(card); if (i >= 0) this.fresh.splice(i, 1); reader.closeFor(card); this.render(); this.opts.onChange?.(); this.addButton.focus({ preventScroll: true }) },
    })
    this.fresh.push(card)
    this.render()
    card.open(true)
    this.opts.onChange?.()
  }

  // Blocks as read by the host (the matrix) or by this list itself.
  set(states: BlockState[]) {
    this.loaded = true; this.error = ''
    this.states = states
    for (const s of states) {
      const c = this.cards.get(s.id)
      if (c) c.update(s)
      else if (s.block) this.cards.set(s.id, new BlockCard(this.target, s, { wider: this.opts.wider, showScope: this.opts.showScope, onChange: () => this.opts.onChange?.(), onSaved: () => this.opts.onSaved?.() }))
    }
    this.render()
  }
  async refresh() {
    try { this.set((await api.blocks(this.target)).blocks) } catch (e) { this.error = (e as Error).message; this.loaded = true; this.render() }
  }

  private render() {
    this.addButton.disabled = !this.loaded; this.addButton.title = this.loaded ? '' : 'Loading…'
    const shown = this.states.filter(s => s.block || this.cards.get(s.id)?.isDirty()).map(s => this.cards.get(s.id)).filter((c): c is BlockCard => !!c)
    const removed = this.states.filter(s => !s.block && !this.cards.get(s.id)?.isDirty())
    this.list.replaceChildren(
      ...(this.error ? [h('div.banner.error.small', `Cannot read these blocks now: ${this.error}`)] : []),
      ...shown.map(c => c.el), ...this.fresh.filter(c => c.isDirty() || c.isOpen()).map(c => c.el),
      ...(!shown.length && !this.fresh.length && (this.opts.empty !== '' || !this.loaded) ? [h('p.small.muted.ctx-none', !this.loaded ? 'Loading…' : this.opts.empty ?? 'None set.')] : []),
      ...(removed.length ? [h('p.small.muted.d-only', `Removed blocks (history kept): ${removed.map(s => s.id).join(', ')}`)] : []))
  }
}

// A list of short values in place (goals, guide references). The host owns
// the values and their save; `set` reconciles without replacing the input
// being typed in.
export class ListEditor {
  readonly el: HTMLElement
  private readonly list = h('ol.ctx-list')
  private readonly addButton: HTMLButtonElement
  private values: string[] = []
  private disabled = false
  private readonly opts: { label: string; item: string; placeholder: string; addLabel: string; onInput: (values: string[], structural: boolean) => void }
  constructor(opts: ListEditor['opts']) {
    this.opts = opts
    this.addButton = h('button.ghost', { type: 'button', onclick: () => { this.values.push(''); this.draw(); this.opts.onInput([...this.values], true); (this.list.lastElementChild?.querySelector('input') as HTMLInputElement | null)?.focus() } }, `+ ${opts.addLabel}`)
    this.el = h('div.field.ctx-list-field', h('span', opts.label), this.list, this.addButton)
  }
  set(values: string[], disabled = false) {
    this.disabled = disabled
    if (values.length === this.values.length && values.every((v, i) => v === this.values[i]) && this.list.childElementCount === values.length) { this.applyDisabled(); return }
    this.values = [...values]
    this.draw()
  }
  private applyDisabled() {
    for (const c of this.el.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) c.disabled = this.disabled
  }
  private draw() {
    const inputs = [...this.list.querySelectorAll<HTMLInputElement>('input')]
    // Reuse the rows that exist (the focused one keeps its caret), add or drop the rest.
    while (inputs.length > this.values.length) inputs.pop()!.closest('li')!.remove()
    this.values.forEach((v, i) => {
      let input = inputs[i]
      if (!input) {
        input = h('input', { placeholder: this.opts.placeholder, oninput: () => { const at = [...this.list.querySelectorAll('input')].indexOf(input!); this.values[at] = input!.value; this.opts.onInput([...this.values], false) } }) as HTMLInputElement
        const li = h('li', input, h('button.icon-btn', { type: 'button', title: `Remove ${this.opts.item}`, onclick: () => { const at = [...this.list.querySelectorAll('input')].indexOf(input!); this.values.splice(at, 1); this.draw(); this.opts.onInput([...this.values], true) } }, '×'))
        this.list.append(li)
      }
      input.setAttribute('aria-label', `${this.opts.item} ${i + 1}`)
      if (input.value !== v && document.activeElement !== input) input.value = v
    })
    this.applyDisabled()
  }
}

// One repository-owned or wider-scope source (a purpose, a guide, the
// preview of what a run is given) as a row, opened in the Reader. Kept by
// key across reloads, so the row a person opened from stays focusable.
type SourceLike = Pick<ContextSource, 'key' | 'kind' | 'delivery' | 'text' | 'reference' | 'note' | 'origin' | 'sha256' | 'provenance'>
export class SourceItem {
  readonly el: HTMLElement
  private readonly panel = h('article.ctx-block.ctx-source-panel')
  private readonly action: HTMLButtonElement
  private s: SourceLike | null = null
  private opts: { title: string; owner: string; edit?: HTMLElement | null; preformatted?: boolean } = { title: '', owner: '' }
  constructor() {
    this.action = h('button.ctx-row-action', { type: 'button', onclick: () => this.open() }, 'Open') as HTMLButtonElement
    this.el = h('div.ctx-row.ctx-source-row', { dataset: { kind: 'source' } })
  }
  update(s: SourceLike, opts: SourceItem['opts']) {
    this.s = s; this.opts = opts
    this.el.dataset.key = s.key
    const state = s.delivery === 'body' ? null : s.delivery === 'absent' ? h('span.ctx-row-state.muted', 'Not set') : s.delivery === 'reference' ? h('span.ctx-row-state.muted', 'Named, not included') : h('span.ctx-row-state.error', 'Cannot be read')
    this.el.replaceChildren(h('span.ctx-row-icon', icon(s.kind === 'guide' ? 'doc' : 'intent', 'icon')),
      h('div.ctx-row-main', h('strong.ctx-row-title', opts.title), metaLine([opts.owner, state])), this.action)
    this.action.setAttribute('aria-label', `Open ${opts.title}`)
    this.render()
  }
  private render() {
    const s = this.s
    if (!s) return
    const text = s.delivery === 'body' ? (s.text ?? '').trim() : ''
    const state = s.delivery === 'body' ? null : s.delivery === 'absent' ? 'Not set.' : s.delivery === 'reference' ? `Named, not included: ${s.reference ?? ''}` : `Cannot be read: ${s.note ?? ''}`
    const origin = [s.origin.file && (s.origin.project ? `${s.origin.project}:${s.origin.file}` : s.origin.file), s.origin.commit && `at ${s.origin.commit.slice(0, 12)}`, s.origin.revision !== undefined && `revision ${s.origin.revision}`, s.origin.updated && `${when(s.origin.updated.at)} by ${s.origin.updated.by}`, s.sha256 && `sha256 ${s.sha256.slice(0, 12)}`].filter(Boolean).join(' · ')
    fill(this.panel,
      h('header.ctx-read-head', h('h2.ctx-read-title', { tabIndex: -1, dataset: { readerFocus: '' } }, this.opts.title), h('p.ctx-read-sub', this.opts.owner)),
      state ? h(`p${s.delivery === 'error' ? '.error-text' : '.muted'}`, state) : null,
      text ? (this.opts.preformatted ? h('pre.ctx-rendered', text) : h('div.ctx-read-body', prose(text))) : null,
      this.opts.edit ? h('div.ctx-read-actions', this.opts.edit) : null,
      origin || s.provenance.length > 1 ? h('div.d-only.ctx-block-detail', origin ? h('p.small.muted', origin) : null, s.provenance.length > 1 ? h('p.small.muted', `declared by ${s.provenance.join(' and ')}; given once`) : null) : null)
  }
  open() { reader.show(this, this.panel, { label: this.opts.title, opener: this.action }) }
}

// ---- the Context section -------------------------------------------------------

export type SectionScope = 'system' | 'project' | 'workflow'
export interface ContextSectionOptions {
  scope: SectionScope
  wsId?: string
  // The host's repository-owned controls (purpose, goals, guides), opened
  // from the "In the repository" row; their draft and save are the host's.
  shared?: HTMLElement
  // A short description of the shared part for the summary and the row.
  sharedSummary?: () => string
  // Unsaved text in the host's shared controls (counted in the summary).
  sharedDirty?: () => boolean
  onDirty?: () => void
  // Where an inherited project default is edited.
  projectHref?: () => string
}

const OPEN_KEY = 'workflow-editor.context-open'
const openState = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean> } catch { return {} } }
const storeOpenState = (k: string, v: boolean) => { try { localStorage.setItem(OPEN_KEY, JSON.stringify({ ...openState(), [k]: v })) } catch { /* per-viewer convenience only */ } }
// Inherited rows shown before "Show all": short instructions always stay.
const INHERITED_SHOWN = 4

// "Only in this environment", once per section; the fuller explanation on request.
function help(label: string, text: string): HTMLElement {
  return h('details.ctx-help', h('summary', { 'aria-label': label, title: label }, '?'), h('p.small', text))
}

export class ContextSection {
  readonly el: HTMLElement
  private readonly opts: ContextSectionOptions
  private readonly toggle: HTMLButtonElement
  private readonly summary = h('span.ctx-summary')
  private readonly body = h('div.ctx-body')
  private readonly sharedRows = h('div.ctx-rows.ctx-shared-rows')
  private readonly sharedAction: HTMLButtonElement
  private readonly sharedRow: HTMLElement
  private readonly sharedPanel: HTMLElement | null
  private readonly inheritedBox = h('div.ctx-inherited-list')
  private readonly inheritedMore: HTMLButtonElement
  private inheritedAll = false
  private readonly previewRows = h('div.ctx-rows.ctx-preview')
  private readonly local: BlockList
  // Blocks of wider scopes, edited in place; kept so drafts survive.
  private readonly wider = new Map<string, BlockList>()
  private readonly sources = new Map<string, SourceItem>()
  private workflow: string | null = null
  private view: ContextMatrixView | null = null
  private loadError = ''
  private disposed = false

  constructor(opts: ContextSectionOptions) {
    this.opts = opts
    const key = opts.scope
    this.toggle = h('button.ctx-toggle', { type: 'button', 'aria-expanded': 'false', onclick: () => this.setOpen(this.body.hidden === true) },
      icon('caret', 'icon small ctx-caret'), h('span.ctx-title', 'Context'), this.summary) as HTMLButtonElement
    this.local = new BlockList(opts.scope === 'system' ? { scope: 'system' } : { scope: opts.scope, project: '', workflow: '' }, {
      empty: opts.scope === 'system' ? 'Nothing is set for all projects yet.' : 'Nothing is set only here.',
      onChange: () => this.changed(), onSaved: () => void this.reload(),
    })
    const sharedTitle = opts.scope === 'workflow' ? 'Purpose and guides' : 'Purpose, goals and guides'
    this.sharedAction = h('button.ctx-row-action', { type: 'button', 'aria-label': `Edit ${sharedTitle}`, onclick: () => this.editShared() }, 'Edit') as HTMLButtonElement
    this.sharedRow = h('div.ctx-row.ctx-shared-row', { dataset: { kind: 'source' } })
    this.sharedPanel = opts.shared ? h('article.ctx-block.ctx-shared-panel',
      h('header.ctx-read-head', h('h2.ctx-read-title', { tabIndex: -1, dataset: { readerFocus: '' } }, sharedTitle),
        h('p.ctx-read-sub', `In the repository · travels with the ${opts.scope === 'workflow' ? 'workflow' : 'project'} · saved with its file; local blocks save separately`)),
      opts.shared) : null
    this.inheritedMore = h('button.link-btn.ctx-inherited-more', { type: 'button', onclick: () => { this.inheritedAll = !this.inheritedAll; this.foldInherited() } }) as HTMLButtonElement
    const localHead = opts.scope === 'system' ? 'For all projects' : opts.scope === 'project' ? 'For this project' : 'For this workflow'
    const localHelp = opts.scope === 'system'
      ? 'Applies to every project and workflow on this host: your instructions, and environment information agents such as cagent maintain. Kept on this host only, never in Git. Every run of every project is given these, so keep them short. A saved change is used from the next attempt; saving starts nothing.'
      : `Applies to ${opts.scope === 'project' ? 'every workflow of this project' : 'every run of this workflow'}. Kept on this host only, never in Git. A saved change is used from the next attempt; saving starts nothing.`
    this.body.hidden = true
    append(this.body, [
      opts.shared ? h('div.ctx-group.ctx-shared', h('div.ctx-group-head', h('h3', 'In the repository', h('span.ctx-group-note', ' · travels with the project'))), this.sharedRows) : null,
      h('div.ctx-group.ctx-local', h('div.ctx-group-head', h('div.ctx-group-title', h('h3', localHead, h('span.ctx-group-note', ' · only in this environment')), help('About these blocks', localHelp)), this.local.addControl), this.local.el),
      opts.scope === 'system' ? null : h('div.ctx-group.ctx-inherited', h('div.ctx-group-head', h('h3', 'Inherited', h('span.ctx-group-note', ' · from wider scopes; they apply here too'))), this.inheritedBox, this.inheritedMore),
      opts.scope === 'workflow' ? this.previewRows : null])
    this.el = h(`section.ctx-section.ctx-scope-${key}`, { dataset: { contextScope: key }, 'aria-label': 'Context' }, h('div.ctx-head', this.toggle), this.body)
    this.toggle.setAttribute('aria-controls', this.body.id = `ctx-body-${key}`)
    if (openState()[key]) this.setOpen(true, false)
    this.renderShared()
    this.updateSummary()
  }

  get isOpen() { return !this.body.hidden }
  setOpen(open: boolean, remember = true) {
    this.body.hidden = !open
    this.toggle.setAttribute('aria-expanded', String(open))
    this.el.classList.toggle('open', open)
    if (remember) storeOpenState(this.opts.scope, open)
  }
  // An entrance from elsewhere (a matrix link, a hero button): open, show,
  // and put the keyboard on the first row (never an empty new block).
  reveal(focus = false, then?: () => void) {
    this.setOpen(true)
    this.el.scrollIntoView({ block: 'start' })
    if (focus) (this.body.querySelector<HTMLElement>('.ctx-row-action') ?? this.local.addControl.querySelector('button'))?.focus({ preventScroll: true })
    then?.()
  }
  // The repository-owned controls, in the reading panel.
  editShared(then?: () => void) {
    if (!this.sharedPanel) return
    this.setOpen(true)
    reader.show(this, this.sharedPanel, { label: this.sharedPanel.querySelector('h2')!.textContent ?? 'Context', opener: this.sharedAction, onClose: () => this.renderSharedRow() })
    then?.()
  }

  isDirty(): boolean { return this.local.isDirty() || [...this.wider.values()].some(w => w.isDirty()) }
  localBlocks() { return this.local }

  // The workflow the section follows (the project is the editor's own).
  setWorkflow(workflow: string | null) {
    if (workflow === this.workflow) return
    this.workflow = workflow
    void this.reload()
  }

  // Re-reads the saved context; drafts stay.
  async reload(): Promise<void> {
    if (this.opts.scope === 'system') { await this.local.refresh(); this.updateSummary(); return }
    if (!this.opts.wsId) return
    if (this.opts.scope === 'workflow' && !this.workflow) return
    try { this.view = await api.context(this.opts.wsId, this.workflow); this.loadError = '' } catch (e) { this.loadError = (e as Error).message }
    if (this.disposed) return
    if (this.view) {
      const v = this.view
      this.local.setTarget(this.opts.scope === 'project' ? { scope: 'project', project: v.project } : { scope: 'workflow', project: v.project, workflow: v.workflow ?? this.workflow! })
      this.local.set(this.opts.scope === 'project' ? v.blocks.project : v.blocks.workflow ?? [])
      this.widerList({ scope: 'system' }).set(v.blocks.system)
      if (this.opts.scope === 'workflow') this.widerList({ scope: 'project', project: v.project }).set(v.blocks.project)
    }
    this.renderShared()
    this.renderInherited()
    this.renderPreview()
    this.updateSummary()
  }

  private source(key: string): SourceItem {
    let s = this.sources.get(key)
    if (!s) { s = new SourceItem(); this.sources.set(key, s) }
    return s
  }

  // "In the repository": the host's controls behind one row, and the
  // content of this scope's own guides, as saved.
  private renderSharedRow() {
    if (!this.opts.shared) return
    const dirty = !!this.opts.sharedDirty?.()
    const title = this.opts.scope === 'workflow' ? 'Purpose and guides' : 'Purpose, goals and guides'
    this.sharedRow.replaceChildren(h('span.ctx-row-icon', icon('intent', 'icon')),
      h('div.ctx-row-main', h('strong.ctx-row-title', title), metaLine([this.opts.sharedSummary?.() ?? null, dirty ? h('span.ctx-row-state.warn', 'Unsaved changes') : null])), this.sharedAction)
  }
  private renderShared() {
    if (!this.opts.shared) return
    this.renderSharedRow()
    const v = this.view
    const b = v ? (this.opts.scope === 'workflow' ? (v.execution ?? v.authoring) : v.authoring) : null
    const guides = b?.sources.filter(s => s.scope === this.opts.scope && s.kind === 'guide') ?? []
    this.sharedRows.replaceChildren(this.sharedRow, ...guides.map(s => {
      const item = this.source(s.key)
      item.update(s, { title: `Guide ${s.origin.file ?? s.title.replace(/^guide /, '')}`, owner: s.origin.project && s.origin.project !== v?.project ? `Project ${s.origin.project} · repository` : 'Repository' })
      return item.el
    }))
  }

  private changed() { this.updateSummary(); this.foldInherited(); this.opts.onDirty?.() }

  updateSummary() {
    const bits: string[] = []
    if (this.opts.sharedSummary) bits.push(this.opts.sharedSummary())
    const own = this.local.present()
    const count = (l: BlockState[]) => { const i = l.filter(s => s.block?.kind === 'instruction').length, f = l.length - i; return [i ? `${i} instruction${i === 1 ? '' : 's'}` : '', f ? `${f} environment note${f === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ') }
    bits.push(own.length ? `${this.opts.scope === 'system' ? 'for all projects' : 'local'}: ${count(own)}` : this.opts.scope === 'system' ? 'nothing set for all projects' : 'no local blocks')
    if (this.opts.scope !== 'system' && this.view) {
      const inherited = this.inheritedSources().filter(s => s.delivery !== 'absent').length
      bits.push(`${inherited} inherited`)
    }
    const dirty = this.isDirty() || !!this.opts.sharedDirty?.()
    this.summary.replaceChildren(h('span.small.muted', bits.join(' · ')), ...(dirty ? [h('span.small.warn-text.ctx-unsaved', ' · unsaved changes')] : []))
    this.renderSharedRow()
  }

  // Sources of wider scopes as the next run (workflow) or authoring (project) sees them.
  private inheritedSources(): ContextSource[] {
    const v = this.view
    if (!v) return []
    const b = this.opts.scope === 'workflow' ? (v.execution ?? v.authoring) : v.authoring
    const wider = this.opts.scope === 'workflow' ? ['system', 'project'] : ['system']
    return b.sources.filter(s => wider.includes(s.scope) && s.kind !== 'contract')
  }

  private widerList(t: ScopeTarget): BlockList {
    const k = `${t.scope}:${t.project ?? ''}`
    let w = this.wider.get(k)
    if (!w) {
      w = new BlockList(t, { wider: true, showScope: true, empty: '', onChange: () => this.changed(), onSaved: () => void this.reload() })
      this.wider.set(k, w)
    }
    w.setTarget(t)
    return w
  }

  // One list: the project's defaults (workflow editor), then the wider
  // scopes' blocks; each row names its scope.
  private renderInherited() {
    if (this.opts.scope === 'system') return
    const v = this.view
    if (!v) { this.inheritedBox.replaceChildren(h('p.small.muted', this.loadError ? `Not read: ${this.loadError}` : 'Loading…')); return }
    const href = this.opts.projectHref?.()
    const defaults = this.inheritedSources().filter(s => s.category === 'default').map(s => {
      const item = this.source(s.key)
      item.update(s, {
        title: s.kind === 'intent' ? 'Project purpose and goals' : `Project guide ${s.origin.file ?? s.title.replace(/^guide /, '')}`,
        owner: `Project ${v.project} · repository`,
        edit: href ? h('a.button', { href }, 'Edit in the project') : null,
      })
      return item.el
    })
    const lists = [...(this.opts.scope === 'workflow' ? [this.widerList({ scope: 'project', project: v.project })] : []), this.widerList({ scope: 'system' })]
    this.inheritedBox.replaceChildren(h('div.ctx-rows', ...defaults), ...lists.map(l => l.el))
    const none = !defaults.length && lists.every(l => !l.present().length)
    if (none) this.inheritedBox.append(h('p.small.muted.ctx-none', 'Nothing is inherited.'))
    this.foldInherited()
  }
  // Many inherited rows fold behind "Show all"; a short instruction, a
  // draft and the first few rows stay.
  private foldInherited() {
    const rows = [...this.inheritedBox.querySelectorAll<HTMLElement>('.ctx-row')]
    let shown = 0, folded = 0
    for (const r of rows) {
      const keep = this.inheritedAll || rows.length <= INHERITED_SHOWN + 1 || !!r.querySelector('.ctx-row-inline') || r.classList.contains('editing') || shown < INHERITED_SHOWN
      r.hidden = !keep
      if (keep) shown++; else folded++
    }
    this.inheritedMore.hidden = !folded && !this.inheritedAll
    this.inheritedMore.textContent = this.inheritedAll ? 'Show fewer' : `Show all ${rows.length} inherited`
  }

  // What a new run of the workflow is given now, from saved settings only.
  private previewItem: SourceItem | null = null
  private renderPreview() {
    const v = this.view
    if (this.opts.scope !== 'workflow' || !v?.execution) { this.previewRows.replaceChildren(); return }
    this.previewItem ??= new SourceItem()
    const pending = this.isDirty() || !!this.opts.sharedDirty?.()
    const overview = this.opts.wsId ? h('a.button', { href: `#/context/${encodeURIComponent(this.opts.wsId)}/${encodeURIComponent(v.workflow!)}` }, 'Scope overview') : null
    this.previewItem.update({ key: 'preview/execution', kind: 'contract', delivery: 'body', text: v.rendered.execution ?? '', provenance: [], origin: {} },
      { title: 'What a new run is given', owner: pending ? 'Saved settings only: unsaved changes are not included' : 'Saved settings · the same resolver as the claim', edit: overview, preformatted: true })
    this.previewRows.replaceChildren(this.previewItem.el)
  }

  dispose() { this.disposed = true; reader.closeFor(this) }
}
