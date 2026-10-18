// Context inside the editors (workflow_editor p13 ex1, docs/context.md):
// the parts every editor uses to show and change what agents are told,
// where the person already works on the object.
//
// - OverrideEditor: one local instruction (system, project or workflow
//   override) with its own draft, save, conflict recovery and history. It is
//   built once and kept, so a live refresh, a display switch or a re-render
//   of the host never replaces the text being typed.
// - ListEditor: a list of short values (goals, guide references) edited in
//   place, writing into the host's draft; the host owns the save.
// - ContextSection: the collapsible Context section of Home, a project or a
//   workflow — a summary that is always shown, the host's repository-owned
//   controls ("Shared with this project"), the local instructions ("Only in
//   this environment") and the wider scopes' content ("Inherited
//   instructions") with in-place editors for those scopes.
//
// Storage is the p13 store and resolver: overrides through
// api.override/saveOverride, everything shown as inherited from api.context.
// Default edits stay in the host's own save (project.yaml, the workflow
// file); nothing here saves both kinds at once.
import type { ContextSource, OverrideRevision, OverrideState, OverrideTarget } from '../shared/context.ts'
import { api, ApiError, type ContextMatrixView } from './api.ts'
import { append, h, when } from './dom.ts'
import { icon } from './icons.ts'

const ACTOR_KEY = 'workflow-editor.actor'
export const storedActor = () => { try { return localStorage.getItem(ACTOR_KEY) ?? '' } catch { return '' } }
const storeActor = (v: string) => { try { localStorage.setItem(ACTOR_KEY, v) } catch { /* per-viewer convenience only */ } }

// Who an instruction applies to, in the words the person chose by.
export function scopeWords(t: OverrideTarget): string {
  return t.scope === 'system' ? 'all projects' : t.scope === 'project' ? `every workflow of project ${t.project}` : `every run of workflow ${t.workflow}`
}
const sameTarget = (a: OverrideTarget, b: OverrideTarget) => a.scope === b.scope && a.project === b.project && a.workflow === b.workflow

// A textarea that grows with its text, within bounds.
export function fitRows(ta: HTMLTextAreaElement, min = 3, max = 14) {
  ta.rows = Math.min(max, Math.max(min, ta.value.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 80)), 0)))
}

export interface OverrideEditorOptions {
  // Shown above the text: what this instruction is.
  label: string
  // Shown under it in both modes: who it applies to and what saving does.
  hint?: string
  placeholder?: string
  // A wider scope edited from a narrower editor says so at its save.
  wider?: boolean
  onChange?: () => void // the draft or its saved state changed
  onSaved?: (s: OverrideState) => void
}

export class OverrideEditor {
  readonly el: HTMLElement
  private target: OverrideTarget
  private readonly opts: OverrideEditorOptions
  private readonly ta: HTMLTextAreaElement
  private readonly by: HTMLInputElement
  private readonly buttons = h('div.row.tight.ctx-save-row')
  private readonly status = h('div.ctx-status')
  private readonly meta = h('p.small.muted.d-only.ctx-meta')
  private readonly history = h('details.ctx-history.d-only')
  private readonly labelEl = h('span')
  private readonly hintEl = h('p.small.muted.ctx-hint')
  private base: OverrideState | null = null // the override as last read (what a save replaces)
  private remote: OverrideState | null = null // a newer saved state seen while the draft was dirty
  private revisions: (OverrideRevision & { text: string | null })[] = []
  private busy = false
  private loaded = false
  private loadError = ''

  constructor(target: OverrideTarget, opts: OverrideEditorOptions) {
    this.target = target
    this.opts = opts
    this.ta = h('textarea.context-editor', { rows: 3, spellcheck: false, placeholder: opts.placeholder ?? 'Instructions agents should follow, in your words.', disabled: true }) as HTMLTextAreaElement
    this.ta.addEventListener('input', () => { fitRows(this.ta); this.renderButtons(); this.opts.onChange?.() })
    this.by = h('input.ctx-by', { 'aria-label': 'Revision author', placeholder: 'your name', value: storedActor(), size: 12, oninput: () => storeActor(this.by.value.trim()) }) as HTMLInputElement
    const id = `ctx-${Math.random().toString(36).slice(2, 9)}`
    this.ta.id = id
    this.el = h('div.ctx-override', { dataset: { scope: target.scope } },
      h('label.ctx-label', { htmlFor: id }, this.labelEl),
      this.hintEl, this.ta, this.buttons, this.status, this.meta, this.history)
    this.relabel()
    this.renderButtons()
  }

  private relabel() {
    this.labelEl.textContent = this.opts.label
    this.ta.setAttribute('aria-label', `${this.opts.label} (${scopeWords(this.target)})`)
    this.hintEl.textContent = this.opts.hint ?? `Applies to ${scopeWords(this.target)}. Kept on this host only, never in Git. Used from the next attempt; saving starts nothing.`
  }

  get scope() { return this.target.scope }
  get saved(): OverrideState | null { return this.base }
  get text() { return this.ta.value }
  isDirty() { return this.loaded && this.ta.value !== (this.base?.text ?? '') }
  focus() { this.ta.focus({ preventScroll: true }); this.ta.scrollIntoView({ block: 'nearest' }) }

  // A workflow's id can change with its file; a different target starts
  // from what is saved there at the next refresh.
  setTarget(t: OverrideTarget) {
    if (sameTarget(t, this.target)) return
    this.target = t
    this.loaded = false
    this.base = null; this.remote = null; this.message = null
    this.setText('')
    this.relabel()
    this.renderAll()
  }

  // Reads the saved state. A clean editor follows it; a draft is never
  // replaced: a newer saved text is announced, and a save then conflicts.
  async refresh(): Promise<void> {
    const t = this.target
    let r
    try { r = await api.override(t.scope, t.project, t.workflow) } catch (e) { this.loadError = (e as Error).message; this.renderStatus(); return }
    if (!sameTarget(t, this.target)) return
    this.loadError = ''
    this.revisions = r.revisions
    if (!this.loaded || !this.isDirty()) {
      this.base = r.state; this.remote = null
      this.setText(r.state.text ?? '')
      this.loaded = true
    } else if ((r.state.sha256 ?? null) !== (this.base?.sha256 ?? null)) this.remote = r.state
    else this.remote = null
    this.ta.disabled = !!r.state.problem && r.state.text === null
    this.renderButtons(); this.renderMeta(); this.renderStatus()
    this.opts.onChange?.()
  }

  // Replaces the text without losing the caret of someone typing in it.
  private setText(text: string) {
    if (this.ta.value === text) return
    const focused = document.activeElement === this.ta
    const sel = focused ? [this.ta.selectionStart, this.ta.selectionEnd] as const : null
    this.ta.value = text
    fitRows(this.ta)
    if (sel) try { this.ta.setSelectionRange(Math.min(sel[0], text.length), Math.min(sel[1], text.length)) } catch { /* not focused */ }
  }

  private message: { kind: 'ok' | 'error' | 'warn'; text: string; extra?: HTMLElement } | null = null
  private say(kind: 'ok' | 'error' | 'warn', text: string, extra?: HTMLElement) { this.message = { kind, text, extra }; this.renderStatus() }

  async save(text: string | null) {
    const by = this.by.value.trim()
    if (!by) { this.say('error', 'Enter your name next to Save: every revision records who wrote it.'); this.by.focus(); return }
    this.busy = true; this.renderButtons()
    const t = this.target
    try {
      const r = await api.saveOverride({ ...t, text, base: this.base?.sha256 ?? null, by })
      this.base = r.state; this.remote = null; this.revisions = r.revisions
      this.setText(r.state.text ?? '')
      const where = scopeWords(t)
      this.say('ok', !r.changed ? 'Unchanged: that is already the saved text.'
        : `${text === null ? 'Cleared' : 'Saved'} for ${where}. It is used from the next attempt${this.opts.wider ? ' of every affected run' : ''}; nothing was started or resumed, and work in progress keeps what it was given.`)
      this.opts.onSaved?.(r.state)
    } catch (e) {
      const conflict = e instanceof ApiError && (e.detail as { code?: string } | undefined)?.code === 'context-conflict'
      const cur = conflict ? (e.detail as { current: OverrideState }).current : null
      if (cur) {
        this.say('error', `Not saved: someone saved this instruction${cur.updated ? ` (${when(cur.updated.at)}, ${cur.updated.by})` : ''} after you started. Your text is kept here.`,
          h('div.ctx-conflict', h('p.small', 'Saved now:'), h('pre.small', cur.text ?? '(not set)'),
            h('div.row.tight',
              h('button', { type: 'button', onclick: () => { this.base = cur; this.remote = null; this.setText(cur.text ?? ''); this.message = null; this.renderAll() } }, 'Use the saved text (discard mine)'),
              h('button', { type: 'button', onclick: () => { this.base = cur; this.remote = null; this.message = null; void this.save(text) } }, 'Save mine over it'))))
      } else this.say('error', `Not saved: ${(e as Error).message} Your text is kept; try again.`)
    }
    this.busy = false
    this.renderAll()
    this.opts.onChange?.()
  }

  private renderAll() { this.renderButtons(); this.renderMeta(); this.renderStatus() }

  private renderButtons() {
    const dirty = this.isDirty()
    this.buttons.replaceChildren(
      h('button.primary', { type: 'button', disabled: this.busy || !dirty, onclick: () => void this.save(this.ta.value) }, this.busy ? 'Saving…' : 'Save'),
      h('button', { type: 'button', disabled: this.busy || !dirty, onclick: () => { this.setText(this.base?.text ?? ''); this.message = null; this.renderAll(); this.opts.onChange?.() } }, 'Discard changes'),
      h('button.ghost', { type: 'button', disabled: this.busy || !this.base?.text, title: 'Remove this instruction; wider and repository-owned ones stay', onclick: () => { if (confirm(`Remove the instruction for ${scopeWords(this.target)}? Wider and repository-owned instructions stay.`)) void this.save(null) } }, 'Remove'),
      h('label.small.ctx-by-label', 'as ', this.by),
      h(`span.small.ctx-state${dirty ? '.warn-text' : '.muted'}`, dirty ? 'Unsaved changes' : !this.loaded ? 'Loading…' : this.base?.text ? 'Saved' : 'Not set'))
  }

  private renderMeta() {
    const b = this.base
    this.meta.textContent = !b ? '' : [b.file, b.revision !== null ? `revision ${b.revision}` : b.text !== null ? 'edited outside WFE' : null, b.updated ? `${when(b.updated.at)} by ${b.updated.by}` : null, b.sha256 ? `sha256 ${b.sha256.slice(0, 12)}` : null].filter(Boolean).join(' · ')
    this.history.replaceChildren(h('summary.small', `Revision history (${this.revisions.length})`),
      this.revisions.length ? h('ol.ctx-revisions', { reversed: true }, ...[...this.revisions].reverse().map(r => h('li',
        h('div.small', h('strong', `revision ${r.rev}`), ` · ${when(r.at)} · ${r.by}${r.external ? ' (found edited outside WFE)' : ''} · ${r.sha256 ? r.sha256.slice(0, 12) : 'removed'}`),
        r.text !== null ? h('pre.small', r.text) : h('p.small.muted', 'removed')))) : h('p.small.muted', 'No revision yet.'))
  }

  private renderStatus() {
    const parts: HTMLElement[] = []
    if (this.loadError) parts.push(h('div.banner.error.small', `Cannot read this instruction now: ${this.loadError}`))
    if (this.base?.problem) parts.push(h('div.banner.error.small', this.base.problem))
    if (this.base?.external) parts.push(h('div.banner.warn.small', 'This file was edited outside WFE since its last revision; saving keeps that content as a revision first.'))
    if (this.remote) parts.push(h('div.banner.warn.small', `Saved elsewhere while you were editing${this.remote.updated ? ` (${when(this.remote.updated.at)}, ${this.remote.updated.by})` : ''}. Your text is kept; saving it will ask which one to keep.`))
    if (this.message) parts.push(h(`div.banner.${this.message.kind}.small`, this.message.text, this.message.extra ?? null))
    this.status.replaceChildren(...parts)
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

// One wider-scope or repository-owned source, readable in place.
export function sourceBlock(s: ContextSource, opts: { title?: string; owner?: string; action?: HTMLElement | null; open?: boolean } = {}): HTMLElement {
  const excerpt = s.delivery === 'body' ? (s.text ?? '').trim() : ''
  const state = s.delivery === 'body' ? null : s.delivery === 'absent' ? 'not set' : s.delivery === 'reference' ? `named, not included: ${s.reference ?? ''}` : `cannot be read: ${s.note ?? ''}`
  const origin = [s.origin.file && (s.origin.project ? `${s.origin.project}:${s.origin.file}` : s.origin.file), s.origin.commit && `at ${s.origin.commit.slice(0, 12)}`, s.origin.revision !== undefined && `revision ${s.origin.revision}`, s.origin.updated && `${when(s.origin.updated.at)} by ${s.origin.updated.by}`, s.sha256 && `sha256 ${s.sha256.slice(0, 12)}`].filter(Boolean).join(' · ')
  const long = excerpt.length > 280 || excerpt.split('\n').length > 6
  return h(`div.ctx-src${s.delivery === 'error' ? '.problem' : ''}`, { dataset: { key: s.key } },
    h('div.ctx-src-head', h('strong', opts.title ?? s.title), opts.owner ? h('span.chip.muted', opts.owner) : null, opts.action ?? null),
    state ? h(`p.small${s.delivery === 'error' ? '.error-text' : '.muted'}`, state) : null,
    excerpt ? (long ? h('details.ctx-src-text', { open: !!opts.open }, h('summary.small', excerpt.split('\n').find(l => l.trim())!.slice(0, 120)), h('pre.ctx-text', excerpt)) : h('pre.ctx-text', excerpt)) : null,
    origin ? h('p.small.muted.d-only', origin) : null,
    s.provenance.length > 1 ? h('p.small.muted.d-only', `declared by ${s.provenance.join(' and ')}; given once`) : null)
}

// ---- the Context section -------------------------------------------------------

export type SectionScope = 'system' | 'project' | 'workflow'
export interface ContextSectionOptions {
  scope: SectionScope
  wsId?: string
  // The host's repository-owned controls (purpose, goals, guides), shown
  // under "Shared with this project"; their draft and save are the host's.
  shared?: HTMLElement
  // A short description of the shared part for the summary line.
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

export class ContextSection {
  readonly el: HTMLElement
  private readonly opts: ContextSectionOptions
  private readonly toggle: HTMLButtonElement
  private readonly summary = h('span.ctx-summary')
  private readonly body = h('div.ctx-body')
  private readonly inheritedBox = h('div.ctx-inherited-list')
  private readonly preview = h('div.ctx-preview')
  private readonly ownBox = h('div.ctx-own')
  private readonly local: OverrideEditor
  // Editors of wider scopes, opened from an inherited instruction; kept so
  // closing and reopening one keeps its draft.
  private readonly wider = new Map<string, { editor: OverrideEditor; box: HTMLElement }>()
  private workflow: string | null = null
  private view: ContextMatrixView | null = null
  private loadError = ''
  private disposed = false

  constructor(opts: ContextSectionOptions) {
    this.opts = opts
    const key = opts.scope
    this.toggle = h('button.ctx-toggle', { type: 'button', 'aria-expanded': 'false', onclick: () => this.setOpen(this.body.hidden === true) },
      icon('caret', 'icon small ctx-caret'), h('span.ctx-title', 'Context'), this.summary) as HTMLButtonElement
    const localLabel = opts.scope === 'system' ? 'Instructions for all projects' : opts.scope === 'project' ? 'Your instructions for this project' : 'Your instructions for this workflow'
    this.local = new OverrideEditor(opts.scope === 'system' ? { scope: 'system' } : { scope: opts.scope, project: '', workflow: '' }, {
      label: localLabel,
      hint: opts.scope === 'system' ? 'Applies to every project and workflow on this host: your general preferences and local environment facts. Kept on this host only, never in Git. Used from the next attempt; saving starts nothing.' : undefined,
      placeholder: opts.scope === 'system' ? 'For example: write produced text in English unless a request asks otherwise.' : 'Instructions you want here but not in the repository.',
      onChange: () => this.changed(), onSaved: () => void this.reload(),
    })
    this.body.hidden = true
    append(this.body, [
      opts.shared ? h('div.ctx-group.ctx-shared', h('h3', 'Shared with this project', h('span.small.muted', ' — in the repository; travels with the project')), opts.shared, this.ownBox) : null,
      h('div.ctx-group.ctx-local', opts.scope === 'system' ? null : h('h3', 'Only in this environment', h('span.small.muted', ' — on this host, not in Git')), this.local.el),
      opts.scope === 'system' ? null : h('div.ctx-group.ctx-inherited', h('h3', 'Inherited instructions', h('span.small.muted', ' — from wider scopes; they apply here too')), this.inheritedBox),
      this.preview])
    this.el = h(`section.ctx-section.ctx-scope-${key}`, { dataset: { contextScope: key }, 'aria-label': 'Context' }, h('div.ctx-head', this.toggle), this.body)
    this.toggle.setAttribute('aria-controls', this.body.id = `ctx-body-${key}`)
    if (openState()[key]) this.setOpen(true, false)
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
  // and put the keyboard on the local instruction.
  reveal(focusLocal = false, then?: () => void) {
    this.setOpen(true)
    this.el.scrollIntoView({ block: 'start' })
    if (focusLocal) this.local.focus()
    then?.()
  }

  isDirty(): boolean { return this.local.isDirty() || [...this.wider.values()].some(w => w.editor.isDirty()) }
  localEditor() { return this.local }

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
      const p = this.view.project
      this.local.setTarget(this.opts.scope === 'project' ? { scope: 'project', project: p } : { scope: 'workflow', project: p, workflow: this.view.workflow ?? this.workflow! })
      await Promise.all([this.local.refresh(), ...[...this.wider.values()].map(w => w.editor.refresh())])
    }
    this.renderOwn()
    this.renderInherited()
    this.renderPreview()
    this.updateSummary()
  }

  // The content of this scope's own guides, as saved (the references are
  // edited in the shared controls above).
  private renderOwn() {
    const v = this.view
    if (!v || this.opts.scope === 'system') { this.ownBox.replaceChildren(); return }
    const b = this.opts.scope === 'workflow' ? (v.execution ?? v.authoring) : v.authoring
    const guides = b.sources.filter(s => s.scope === this.opts.scope && s.kind === 'guide')
    this.ownBox.replaceChildren(...(guides.length ? [h('p.small.muted.ctx-own-head', 'Guide content, as saved:'), ...guides.map(s => sourceBlock(s, { title: `Guide ${s.origin.file ?? s.title.replace(/^guide /, '')}`, owner: s.origin.project ? `project ${s.origin.project} · repository` : 'repository' }))] : []))
  }

  private changed() { this.updateSummary(); this.renderPreviewNote(); this.opts.onDirty?.() }

  updateSummary() {
    const bits: string[] = []
    if (this.opts.sharedSummary) bits.push(this.opts.sharedSummary())
    const own = this.local.saved?.text ? 'local instructions set' : 'no local instructions'
    bits.push(this.opts.scope === 'system' ? (this.local.saved?.text ? 'instructions for all projects set' : 'no instructions for all projects') : own)
    if (this.opts.scope !== 'system' && this.view) {
      const inherited = this.inheritedSources().filter(s => s.delivery !== 'absent').length
      bits.push(`${inherited} inherited`)
    }
    const dirty = this.isDirty() || !!this.opts.sharedDirty?.()
    this.summary.replaceChildren(h('span.small.muted', bits.join(' · ')), ...(dirty ? [h('span.small.warn-text.ctx-unsaved', ' · unsaved changes')] : []))
  }

  // Sources of wider scopes as the next run (workflow) or authoring (project) sees them.
  private inheritedSources(): ContextSource[] {
    const v = this.view
    if (!v) return []
    const b = this.opts.scope === 'workflow' ? (v.execution ?? v.authoring) : v.authoring
    const wider = this.opts.scope === 'workflow' ? ['system', 'project'] : ['system']
    return b.sources.filter(s => wider.includes(s.scope) && s.kind !== 'contract')
  }

  private widerEditor(t: OverrideTarget, label: string): { editor: OverrideEditor; box: HTMLElement } {
    const k = `${t.scope}:${t.project ?? ''}`
    let w = this.wider.get(k)
    if (!w) {
      const editor = new OverrideEditor(t, {
        label, wider: true,
        hint: `You are editing a wider scope: this applies to ${scopeWords(t)}, not only here. Kept on this host only. Used from the next attempt; saving starts nothing.`,
        onChange: () => this.changed(), onSaved: () => void this.reload(),
      })
      const box = h('div.ctx-wider', { hidden: true }, editor.el, h('button.link-btn.small', { type: 'button', onclick: () => { box.hidden = true; this.renderInherited() } }, 'Close (an unsaved draft is kept)'))
      w = { editor, box }
      this.wider.set(k, w)
      void editor.refresh()
    }
    return w
  }

  private renderInherited() {
    if (this.opts.scope === 'system') return
    const v = this.view
    if (!v) { this.inheritedBox.replaceChildren(h('p.small.muted', this.loadError ? `Not read: ${this.loadError}` : 'Loading…')); return }
    const blocks: HTMLElement[] = []
    for (const s of this.inheritedSources()) {
      if (s.category === 'override') {
        const t: OverrideTarget = s.scope === 'system' ? { scope: 'system' } : { scope: 'project', project: v.project }
        const label = s.scope === 'system' ? 'Instructions for all projects' : `Instructions for project ${v.project}`
        const w = this.widerEditor(t, label)
        const action = h('button.small', { type: 'button', 'aria-expanded': String(!w.box.hidden), onclick: () => { w.box.hidden = !w.box.hidden; this.renderInherited(); if (!w.box.hidden) w.editor.focus() } },
          w.box.hidden ? (s.scope === 'system' ? 'Edit instructions for all projects' : 'Edit project instructions') : 'Hide editor')
        blocks.push(h('div.ctx-inherit-item', sourceBlock(s, { title: label, owner: s.scope === 'system' ? 'all projects · this host' : `project ${v.project} · this host`, action }),
          w.editor.isDirty() && w.box.hidden ? h('p.small.warn-text', 'Unsaved draft — open the editor to save or discard it.') : null, w.box))
      } else {
        const owner = `project ${v.project} · repository`
        const title = s.kind === 'intent' ? `Project purpose and goals` : `Project guide ${s.origin.file ?? s.title.replace(/^guide /, '')}`
        const href = this.opts.projectHref?.()
        blocks.push(h('div.ctx-inherit-item', sourceBlock(s, { title, owner, action: href ? h('a.button.small', { href }, 'Edit in the project') : null })))
      }
    }
    this.inheritedBox.replaceChildren(...(blocks.length ? blocks : [h('p.small.muted', 'Nothing is inherited.')]),
      h('p.small.muted.d-only', 'Not shown: the execution host\'s common contract (composed before this context at claim) and each run\'s own input.'))
  }

  // What a new run of the workflow is given now, from saved settings only.
  private previewNote = h('p.small.ctx-preview-note')
  private renderPreview() {
    const v = this.view
    if (this.opts.scope !== 'workflow' || !v?.execution) { this.preview.replaceChildren(); return }
    const pre = h('pre.ctx-rendered', v.rendered.execution ?? '')
    const overview = this.opts.wsId ? h('a.small', { href: `#/context/${encodeURIComponent(this.opts.wsId)}/${encodeURIComponent(v.workflow!)}` }, 'Scope overview') : null
    this.preview.replaceChildren(h('details.ctx-preview-box', h('summary', 'What a new run is given (saved settings)'), this.previewNote, pre, h('p.small.muted.d-only', 'The same resolver as the claim; the execution host composes its common contract before this text.', ' ', overview)))
    this.renderPreviewNote()
  }
  private renderPreviewNote() {
    const pending = this.isDirty() || !!this.opts.sharedDirty?.()
    this.previewNote.className = `small ctx-preview-note${pending ? ' warn-text' : ' muted'}`
    this.previewNote.textContent = pending ? 'Saved context only: your unsaved changes are not included until you save them.' : 'Saved context: what the next run would be prepared with now.'
  }

  dispose() { this.disposed = true }
}
