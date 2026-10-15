// The run view's persistent parts (p7/ex2, p8): the focus card in the main
// column — the person's current task — and the side pane with the selected
// node and the run's records. Every section keeps one root, its display is
// brought up to date in place (patch.ts), and its controls — the name,
// answers, the resume instruction, the adjusted definition and its reason,
// the decision's evidence — are created once and never rebuilt, so focus,
// selection, composition and internal scrolling survive whatever the run,
// the host or the connection does meanwhile.
//
// A control's home can change with the run's state (an open question is
// answered in the focus card, a resolved one is a record at the side; the
// decision is offered in the focus card when a completed run has none). It
// moves only while it holds no draft and is not being typed into: a control
// in use stays where the person is, with the reason it no longer applies.
//
// runView.ts keeps the server snapshot and the operations; this module reads
// the data it is given and asks the view to act.
import type { RunOpResponse, RunResponse } from '../shared/api.ts'
import { effectiveOf, holderOf, isOpen, questionState, runKey, situation, type Because, type Question, type RunRecord } from '../shared/run.ts'
import { reportStep } from '../shared/compile.ts'
import { sessionPolicyOf } from '../shared/model.ts'
import type { AdjustView, DelegationsView, DelegationView, PresentationView, RunExecView, RunNotifyView } from './api.ts'
import { STATE_GLYPH, TYPE_LABEL } from './canvas.ts'
import { stepFacts, stepLabel } from './inspector.ts'
import { h, when } from './dom.ts'
import { icon } from './icons.ts'
import { patchContent } from './patch.ts'
import { activeWorkflow, ago, chip, descendants, fileLink, nodeLabel, nodeLink, runHash, topoOrder } from './runCommon.ts'
import { approvalOf, integrationStatus, type Approval } from './integrationState.ts'
export { integrationStatus }

// Who a hold or a stop acted for (p9): the person's words named by the recorder.
const becauseText = (b: Because | undefined) => b ? ` (on ${b.from}'s ${b.kind === 'answer' ? `answer to ${b.question}` : `instruction ${b.instruction}`})` : ''
const STOP_TITLE = 'Hold the run: execution stops; its plan and work are kept and it can be resumed. Other requests in this project can run meanwhile.'

export interface RunData {
  wsId: string
  rev?: string
  shown: RunResponse | null // the last reading with a usable record
  resp: RunResponse | null // the latest reading, usable or not
  execView: RunExecView | null
  execError: string
  notifyView: RunNotifyView | null
  presentViews: PresentationView[]
  selection: string | null
  viewing: { path: string; text?: string; error?: string } | null
  connected?: boolean
  delegView?: DelegationsView | null // p10: the run's delegations with each child now; for a child, its parent
}

// What became of one submission, said beside the control that sent it.
export interface OpResult { ok: boolean; kind: 'ok' | 'warn' | 'error'; text: string }

export interface SideActions {
  // Records one run operation as the declared actor.
  record(op: Record<string, unknown> & { op: string }, done: string | ((r: RunOpResponse & { job?: { id: number; state: string } | null }) => string)): Promise<OpResult>
  // Inspects (dryRun) or applies an adjustment; null when the request failed.
  adjust(body: { text: string; reason: string; dryRun: boolean; expectRevision: string; expectSeq: number }): Promise<AdjustView | null>
  notice(kind: 'ok' | 'error' | 'warn', text: string): void
}

// A side section (p8): a labelled disclosure. The label carries the
// section's name, its counts and — through `attention` — any problem or
// action it holds, so a closed section still says what needs the person.
// Its open state is the person's: background updates never open or close
// it; explicit navigation (a link to a file, a question, a section) opens it.
interface Section { key: string; root: HTMLElement; title: HTMLElement; toggle: HTMLButtonElement; content: HTMLElement }

function section(key: string, ...body: Node[]): Section {
  const title = h('h3')
  const toggle = h('button.sec-toggle', { type: 'button', 'aria-expanded': 'false', 'aria-controls': `sec-${key}` }, icon('chevron', 'icon small sec-chevron'), title)
  const content = h('div.sec-content', { id: `sec-${key}`, hidden: true }, ...body)
  return { key, root: h('section.side-sec', { dataset: { key: `sec:${key}`, section: key } }, toggle, content), title, toggle, content }
}
// The selected node: always shown while a node is selected, not a disclosure.
function card(key: string, ...body: Node[]): Section {
  const title = h('h3.d-only')
  const content = h('div.sec-content', ...body)
  return { key, root: h('section.side-sec.side-card', { dataset: { key: `sec:${key}`, section: key } }, title, content), title, toggle: h('button'), content }
}
const OPEN_KEY = 'workflow-editor.run-sections'
function storedOpen(): Record<string, boolean> { try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean> } catch { return {} } }
function storeOpen(v: Record<string, boolean>) { try { localStorage.setItem(OPEN_KEY, JSON.stringify(v)) } catch { /* per-viewer convenience only */ } }
const setText = (el: HTMLElement, text: string) => { if (el.textContent !== text) el.textContent = text }
const show = (el: HTMLElement, on: boolean) => { if (el.hidden === on) el.hidden = !on }
const setDisabled = (el: HTMLButtonElement, off: boolean) => { if (el.disabled !== off) el.disabled = off }
// A delegated child's situation in plain words (p10).
const CHILD_WORDS: Record<string, string> = { executing: 'working', stopping: 'stopping', 'awaiting-person': 'waiting for an answer', stopped: 'stopped by a person', interrupted: 'interrupted', unknown: 'interrupted (execution lost)', completed: 'done', cancelled: 'cancelled', 'not-started': 'queued to start', idle: 'between steps' }
const childWords = (s?: string) => (s ? CHILD_WORDS[s] ?? s : 'not readable here')
const list = (xs: string[]) => xs.filter(x => !x.startsWith('_')).join(', ') || '—'
// Recorded text as one sentence: its own final stop, or one added.
const sentence = (t: string) => (/[.!?。！？]\s*$/.test(t) ? t.trim() : `${t.trim()}.`)
// Never move what the person is typing in (moving a focused control blurs it).
const inUse = (el: Element) => el.contains(document.activeElement)
function place(el: HTMLElement, parent: HTMLElement, before: ChildNode | null = null): boolean {
  if (el.parentElement === parent && el.nextSibling === before) return true
  if (el.isConnected && inUse(el)) return false
  parent.insertBefore(el, before)
  return true
}

// A control the person types into. Its text is the draft: no background
// update assigns its value. Edits are versioned, so a submission clears only
// the exact text it sent and never what was typed while it was in flight; a
// second submission waits for the first. When the operation stops applying,
// its buttons are disabled at once, but a composing control stays attached
// and editable until the composition ends — only then does it become
// read-only, its text kept, with the reason beside it.
class Owned<E extends HTMLTextAreaElement | HTMLInputElement = HTMLTextAreaElement> {
  readonly el: E
  readonly note = h('p.small.warn-text.closed-note')
  // The submission's own feedback (project_migration p3/ex1): sending, then
  // what was recorded or why nothing was — beside the button, not only in
  // the page's banner. A failure keeps the text.
  readonly status = h('p.small.submit-state', { role: 'status', 'aria-live': 'polite', hidden: true })
  private composing = false
  private busy = false
  private version = 0
  private closed: string | null = null
  private allowed = true
  private readonly buttons: HTMLButtonElement[] = []
  constructor(el: E) {
    this.el = el
    this.note.hidden = true
    el.addEventListener('input', () => { this.version++ })
    el.addEventListener('compositionstart', () => { this.composing = true })
    el.addEventListener('compositionend', () => { this.composing = false; this.sync() })
  }
  controls(...buttons: HTMLButtonElement[]) { this.buttons.push(...buttons); this.sync(); return this }
  // Being typed into: focused or composing.
  get active() { return this.composing || document.activeElement === this.el }
  get kept() { return this.el.value.trim() !== '' || this.active }
  // Open (null) or closed for a reason; `allowed` gates the buttons only.
  set(closed: string | null, allowed = closed === null) { this.closed = closed; this.allowed = allowed; this.sync() }
  private sync() {
    setText(this.note, this.closed ?? '')
    show(this.note, this.closed !== null)
    const ro = this.closed !== null && !this.composing
    if (this.el.readOnly !== ro) this.el.readOnly = ro
    for (const b of this.buttons) setDisabled(b, !this.allowed || this.closed !== null || this.busy)
  }
  say(kind: 'pending' | OpResult['kind'] | null, text = '') {
    setText(this.status, text)
    const cls = `small submit-state${kind ? ` s-${kind}` : ''}`
    if (this.status.className !== cls) this.status.className = cls
    show(this.status, !!kind)
  }
  get sending() { return this.busy }
  // Sends the text as it is now; a second submission waits for the first.
  async submit(send: (text: string) => Promise<OpResult>, pending = 'Recording…'): Promise<boolean> {
    if (this.busy) return false
    const text = this.el.value, version = this.version
    this.busy = true; this.sync()
    this.say('pending', pending)
    try {
      const r = await send(text)
      if (r.ok && this.version === version && this.el.value === text) this.el.value = ''
      this.say(r.kind, r.text)
      return r.ok
    } catch (e) {
      this.say('error', `Not recorded: ${(e as Error).message} Your text is kept.`)
      return false
    } finally { this.busy = false; this.sync() }
  }
}

// One question's card: its display, and the one canonical answer form.
// `another`: an answered question offers its form for a further answer only
// when the person asks for it (or is already using it).
interface QuestionItem { id: string; root: HTMLElement; display: HTMLElement; another: HTMLButtonElement; showForm: boolean; form?: { root: HTMLElement; draft: Owned; button: HTMLButtonElement } }
// An inspected adjustment, bound to exactly what it inspected.
interface Preview { text: string; reason: string; revision: string; seq: number; view: AdjustView }

export class RunSide {
  readonly el = h('aside.run-side', { 'aria-label': 'Run details' })
  // The focus card (main column): the current task, then the open
  // questions with their forms, the resume form while held, the decision
  // while a completed run has none, and the links to the outcome.
  readonly focus = h('section.focus', { 'aria-label': 'Current task' })
  private readonly focusDisplay = h('div.focus-display')
  private readonly focusQuestions = h('div.questions.focus-questions')
  private readonly holdSlot = h('div.focus-slot.hold-slot')
  private readonly decideSlot = h('div.focus-slot.decide-slot')
  private readonly focusLinks = h('div.focus-links')
  private data!: RunData
  private readonly act: SideActions
  private readonly placeholder = h('p.muted.side-placeholder')
  private readonly actor: HTMLInputElement
  private readonly actorRow: HTMLElement
  private readonly selected = card('selected', h('div.sec-body'))
  private readonly questions = section('questions', h('div.questions'), h('p.muted.small', 'No resolved questions yet.'))
  private readonly qItems = new Map<string, QuestionItem>()
  private readonly instructions = section('instructions', h('div.questions'))
  private readonly presentations = section('presentations', h('div.sec-body'))
  private readonly definition = section('definition', h('div.sec-body'))
  private readonly adjust: { root: HTMLDetailsElement; ta: Owned; reason: Owned<HTMLInputElement>; preview: HTMLElement; previewButton: HTMLButtonElement; apply: HTMLButtonElement; base: string | null; result: Preview | null; busy: boolean }
  private readonly catalog = section('catalog', h('div.sec-body'))
  private readonly related = section('related', h('div.sec-body'))
  private readonly files = section('files', h('div.sec-body'))
  private readonly fileView = { root: h('div.file-view'), head: h('div.row.tight'), status: h('p.small'), pre: h('pre'), path: '' }
  // The open file (p8/ex1): its own card at the top of the pane, in both
  // modes — "Read final report" opens it in Simple too. One element, so its
  // offsets survive the switch.
  private readonly fileCard = h('section.side-sec.side-card.file-card', { dataset: { key: 'sec:file', section: 'file' }, hidden: true })
  // Simple: what the pane is for while nothing is selected or open.
  private readonly sideHint = h('div.side-hint.s-only', icon('flag', 'icon'), h('p', 'Select a step in the graph to see what it recorded.'))

  private readonly execution = section('execution', h('div.sec-body'))
  private readonly resume: { root: HTMLElement; draft: Owned; button: HTMLButtonElement }
  private readonly execMore = h('div.sec-body')
  private readonly coordination = section('coordination', h('div.sec-body'))
  private readonly result = section('result', h('div.sec-body'))
  private readonly delegations = section('delegations', h('div.sec-body')) // p10
  private readonly decide: { root: HTMLElement; evidence: Owned<HTMLInputElement>; accept: HTMLButtonElement; reject: HTMLButtonElement; cancel: HTMLButtonElement; busy: boolean }
  private readonly history = section('history', h('ol.history', { reversed: true }))
  private historyShown = ''
  private approval: Approval | null = null // the result's standing with the person, as last read
  private readonly opened = storedOpen() // the person's open sections (per viewer)
  private readonly disclosures: Section[]

  // Controls are created here once and attached by the updates when their
  // operation applies, so a historical view never carries a form.
  constructor(actions: SideActions, actorName: string) {
    this.act = actions
    this.actor = h('input', { value: actorName, placeholder: 'your name', 'aria-label': 'Your name', size: 14 })
    this.actorRow = h('div.actor-row', h('label.small', 'Recording as ', this.actor), h('span.muted.small.d-only', 'declared, like an approver; saved in this browser'))

    const ta = new Owned(h('textarea.yaml', { rows: 12, 'aria-label': 'Adjusted definition', spellcheck: false }))
    const reason = new Owned(h('input', { placeholder: 'why the run changes', 'aria-label': 'Adjustment reason' }))
    const preview = h('div.adjust-preview-slot')
    const previewButton = h('button', 'Preview')
    const apply = h('button.primary', { disabled: true, title: 'Preview first' }, 'Apply')
    const adjustRoot = h('details.adjust', h('summary.small', 'Adjust future work'),
      h('p.small.muted', 'Edit the definition in force. Only pending work may change; started and finished work, bindings and execution settings stay. The reusable workflow file is not changed.'),
      ta.el, reason.el, ta.note, preview, h('div.row.tight', previewButton, apply))
    previewButton.addEventListener('click', () => void this.sendAdjust(true))
    apply.addEventListener('click', () => void this.sendAdjust(false))
    this.adjust = { root: adjustRoot, ta, reason, preview, previewButton, apply, base: null, result: null, busy: false }
    for (const c of [ta.el, reason.el]) c.addEventListener('input', () => this.renderPreview())

    const fv = this.fileView
    fv.root.append(fv.head, fv.status, fv.pre)
    this.fileCard.append(fv.root)

    const resumeButton = h('button.primary', 'Resume')
    const instruction = new Owned(h('textarea', { rows: 2, placeholder: 'what the executor should do now (after looking at the working tree)', 'aria-label': 'Resume instruction' })).controls(resumeButton)
    resumeButton.addEventListener('click', () => {
      if (!instruction.el.value.trim()) { this.act.notice('error', 'A resume needs your instruction.'); return }
      if (!this.data.shown?.record?.control.hold) { this.act.notice('error', 'The run is not held: there is nothing to resume.'); return }
      void instruction.submit(text => this.act.record({ op: 'run.resume', reason: text }, 'Resumed: the executor is queued.'))
    })
    this.resume = { root: h('div.resume-form', h('label.small', { htmlFor: 'resume-instruction' }, 'Your instruction for the executor'), instruction.el, instruction.note, h('div.row.tight', resumeButton), instruction.status), draft: instruction, button: resumeButton }
    instruction.el.id = 'resume-instruction'
    this.execution.content.append(this.execMore)

    const evidence = new Owned(h('input', { placeholder: 'evidence: what you checked (report, commit, demo…)', 'aria-label': 'Decision evidence' }))
    const decide = (decision: 'accepted' | 'rejected') => {
      const rec = this.data.shown?.record
      const appr = this.approval
      // A renewed acceptance (the result changed after the last one) says
      // what it accepts by itself; the person's words are added when given.
      const renewed = decision === 'accepted' && appr?.kind === 'reaccept'
      if (!evidence.el.value.trim() && !renewed) { evidence.say('error', 'A decision needs its evidence: what you checked.'); evidence.el.focus(); return }
      if (decision === 'accepted' && rec?.execution.state !== 'completed') { evidence.say('error', 'A result can be accepted once every node is completed.'); return }
      if (decision === 'accepted' && appr && !appr.canAccept) { evidence.say('warn', 'This result is already accepted: there is nothing more to accept.'); return }
      this.decide.busy = true
      this.updateDecideButtons()
      const changed = appr?.integration?.changed ?? []
      const evidenceOf = (text: string) => renewed ? `${text.trim() ? `${text.trim()} — ` : ''}accepted again after decision ${appr!.integration!.decision}${changed.length ? `; changed since then: ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ' …' : ''}` : ''}` : text
      void evidence.submit(text => this.act.record({ op: 'run.decide', decision, evidence: evidenceOf(text) }, decision === 'accepted'
        ? `Recorded: result accepted. Its integration is queued; this host carries it out within about a minute (the status above follows).`
        : 'Recorded: result rejected.'))
        .finally(() => { this.decide.busy = false; this.updateDecideButtons() })
    }
    const accept = h('button.primary', { onclick: () => decide('accepted') }, 'Accept result')
    const reject = h('button.danger', { onclick: () => decide('rejected') }, 'Reject result')
    const cancel = h('button', {
      title: 'Discontinue the run: every pending, running or waiting node is cancelled',
      onclick: () => {
        const why = prompt('Cancel this run? Every pending, running or waiting node is cancelled. Reason:')
        if (why?.trim()) void this.act.record({ op: 'run.cancel', reason: why }, 'Recorded: the run is cancelled.')
      },
    }, 'Cancel run')
    this.decide = { root: h('div.decide', evidence.el, h('div.row.tight', accept, reject, cancel), evidence.status), evidence, accept, reject, cancel, busy: false }

    this.disclosures = [this.questions, this.instructions, this.delegations, this.presentations, this.definition, this.catalog, this.related, this.files, this.execution, this.coordination, this.result, this.history]
    for (const sec of this.disclosures) {
      sec.root.classList.add('d-only')
      this.setOpen(sec, this.opened[sec.key] ?? false)
      sec.toggle.addEventListener('click', () => { this.setOpen(sec, sec.content.hidden === true); this.opened[sec.key] = !sec.content.hidden; storeOpen(this.opened) })
    }
    this.focus.append(this.focusDisplay, this.focusQuestions, this.holdSlot, this.decideSlot, this.focusLinks)
    this.el.dataset.keepScroll = 'run-side'
    this.el.append(this.placeholder, this.actorRow, this.sideHint, this.fileCard,
      ...[this.selected, this.questions, this.instructions, this.delegations, this.presentations, this.definition, this.catalog, this.related, this.files, this.execution, this.coordination, this.result, this.history].map(s => s.root))
  }

  // ---- what the view reads --------------------------------------------------

  get actorName() { return this.actor.value }
  // The approver from the registry, only into a name nobody has typed.
  suggestActor(name: string) { if (!this.actor.value && document.activeElement !== this.actor) this.actor.value = name }
  focusActor() { this.actor.scrollIntoView({ block: 'nearest' }); this.actor.focus() }

  private setOpen(sec: Section, open: boolean) {
    if (sec.content.hidden === !open) return
    sec.content.hidden = !open
    sec.toggle.setAttribute('aria-expanded', String(open))
    sec.root.classList.toggle('open', open)
  }
  // A problem or an action a closed section holds, in its label.
  private attend(sec: Section, kind: 'error' | 'warn' | null) {
    const v = kind ?? ''
    if ((sec.root.dataset.attention ?? '') !== v) { if (kind) sec.root.dataset.attention = kind; else delete sec.root.dataset.attention }
  }

  // Text the person typed that is not recorded yet.
  isDirty(): boolean {
    const typed = [...this.qItems.values()].map(q => q.form?.draft.el.value ?? '').concat(this.resume.draft.el.value, this.decide.evidence.el.value, this.adjust.reason.el.value)
    return typed.some(v => v.trim() !== '') || (this.adjust.base !== null && this.adjust.ta.el.value !== this.adjust.base)
  }

  // ---- explicit navigation (may move the viewport) ---------------------------

  // A request to answer a question: reveal its one form.
  revealQuestion(id: string) {
    const item = this.qItems.get(id)
    if (!item) return
    if (this.questions.content.contains(item.root)) this.setOpen(this.questions, true)
    if (item.form && !item.form.root.isConnected && this.data.shown?.record && this.answerable(this.data.shown.record, this.data.shown.record.questions[id])) { item.showForm = true; this.updateQuestions(this.data.shown.record) }
    item.root.scrollIntoView({ block: 'nearest' })
    item.form?.draft.el.focus({ preventScroll: true })
  }
  revealResume() {
    if (!this.resume.root.isConnected) return
    this.resume.root.scrollIntoView({ block: 'nearest' })
    this.resume.draft.el.focus({ preventScroll: true })
  }
  revealSection(key: string, focus?: string) {
    const sec = this.disclosures.find(s => s.key === key)
    if (!sec || sec.root.hidden) return
    this.setOpen(sec, true)
    sec.root.scrollIntoView({ block: 'start' })
    if (focus === 'adjust' && this.adjust.root.isConnected) { this.adjust.root.open = true; this.adjust.ta.el.focus({ preventScroll: true }) }
  }
  revealFile() { this.fileCard.scrollIntoView({ block: 'nearest' }) }
  revealSelected() { if (!this.selected.root.hidden) this.selected.root.scrollIntoView({ block: 'nearest' }) }
  // "All records" from Simple: the first section, with the keyboard on it.
  revealRecords() { const first = this.disclosures.find(s => !s.root.hidden); first?.root.scrollIntoView({ block: 'start' }); first?.toggle.focus({ preventScroll: true }) }

  // ---- update -----------------------------------------------------------------

  // `explicit` marks the person's own navigation (selecting a node, opening a
  // file), which may move the viewport; every other update keeps the reader's
  // place in the pane.
  update(d: RunData, explicit = false) {
    const anchor = explicit ? null : this.captureAnchor()
    this.apply(d)
    if (anchor) this.restoreAnchor(anchor)
  }

  // The reading position (p7/ex2): the first keyed item the reader sees at
  // the top of the pane, and its offset from the pane's top edge. At the very
  // top nothing is held, so new history entries show. When the newest
  // history entry is the first visible one, the History heading is held
  // instead of it, so newer entries appear beneath the heading rather than
  // above the viewport. The pane has overflow-anchor: none: this is its one
  // anchoring mechanism.
  private captureAnchor(): { el: HTMLElement; offset: number; scrollTop: number } | null {
    const pane = this.el
    if (pane.scrollTop <= 0 || !this.data) return null
    const top = pane.getBoundingClientRect().top
    const below = (el: Element) => el.getBoundingClientRect().bottom > top + 1
    // Sections are disclosures (p8): a closed one is held by its label, and
    // only displayed items are candidates.
    const sec = [...pane.querySelectorAll<HTMLElement>(':scope > section.side-sec:not([hidden])')].find(below)
    if (!sec) return null
    let el: HTMLElement = sec
    const label = sec.querySelector<HTMLElement>(':scope > .sec-toggle, :scope > h3') ?? sec
    const shown = (x: Element) => !x.closest('[hidden]')
    if (sec === this.history.root) {
      const list = this.history.content.children[0] as HTMLElement
      const first = shown(list) ? [...list.children].find(below) as HTMLElement | undefined : undefined
      el = !first || (first === list.firstElementChild && this.history.toggle.getBoundingClientRect().top >= top) ? this.history.toggle : first
    } else {
      const items = [...sec.querySelectorAll<HTMLElement>('[data-key]')].filter(shown)
      el = items.find(x => x.getBoundingClientRect().top >= top) ?? (label.getBoundingClientRect().top >= top ? label : sec)
    }
    return { el, offset: el.getBoundingClientRect().top - top, scrollTop: pane.scrollTop }
  }

  private restoreAnchor(a: { el: HTMLElement; offset: number; scrollTop: number }) {
    const pane = this.el
    if (!a.el.isConnected || a.el.closest('[hidden]')) { pane.scrollTop = a.scrollTop; return } // removed: the previous offset, clamped
    const delta = a.el.getBoundingClientRect().top - pane.getBoundingClientRect().top - a.offset
    if (Math.abs(delta) >= 1) pane.scrollTop += delta
  }

  // This host's facts changed (execution, coordination, presentations): only
  // the parts that show them are brought up to date.
  updateHost(d: RunData) {
    const rec = d.shown?.record
    if (!rec) return
    const anchor = this.captureAnchor()
    this.data = d
    this.approval = this.approvalOf(d.shown!, rec)
    this.updateQuestions(rec) // presentation links in questions
    this.updateResult(rec)
    this.updatePresentations(rec)
    this.updateExecution(rec)
    this.updateCoordination()
    this.updateDelegations(rec)
    this.updateSelected(rec)
    this.updateFocus(d.shown!, rec)
    if (anchor) this.restoreAnchor(anchor)
  }

  private apply(d: RunData) {
    this.data = d
    const r = d.shown
    const rec = r?.record
    const sections = [this.selected, this.questions, this.instructions, this.delegations, this.presentations, this.definition, this.catalog, this.related, this.files, this.execution, this.coordination, this.result, this.history]
    if (!r || !rec) {
      setText(this.placeholder, d.resp?.problem ? 'No usable record.' : 'Loading…')
      show(this.placeholder, true)
      show(this.actorRow, false)
      show(this.sideHint, false)
      for (const s of sections) show(s.root, false)
      this.el.classList.add('quiet')
      patchContent(this.focusDisplay, h('h2.focus-head', d.resp?.problem ? 'No usable record' : 'Loading…'), d.resp?.problem ? h('p.focus-lead', 'run.json cannot be read; the banner above says why. Nothing can be recorded until the files are fixed.') : null)
      return
    }
    this.approval = this.approvalOf(r, rec)
    show(this.placeholder, false)
    show(this.actorRow, !d.rev)
    show(this.sideHint, !(d.selection && rec.nodes[d.selection]) && !d.viewing)
    for (const s of [this.questions, this.definition, this.catalog, this.files, this.history]) show(s.root, true)
    this.updateSelected(rec)
    this.updateQuestions(rec)
    this.updateInstructions(rec)
    this.updatePresentations(rec)
    this.updateDefinition(rec)
    this.updateCatalog(rec)
    this.updateRelated(r, rec)
    this.updateFiles(r)
    this.updateExecution(rec)
    this.updateCoordination()
    this.updateDelegations(rec)
    this.updateResult(rec)
    this.updateHistory(rec)
    this.updateFocus(r, rec)
  }

  private get frozen() { return !!(this.data.resp && !this.data.resp.record) }

  // One reading for the header, the focus card and the decision control.
  private approvalOf(r: RunResponse, rec: RunRecord): Approval | null {
    if (this.data.rev) return null
    const wf = activeWorkflow(r, rec)
    return approvalOf(rec, this.data.execView, this.data.resp?.place, q => !!q.presentation || (!!q.node && wf?.nodes[q.node]?.confirms === 'result'))
  }

  // ---- the focus card ---------------------------------------------------------

  // The person's current task, chosen from the run's recorded state: a
  // question to answer (a result review first), an answer waiting to be
  // taken up, a hold to resume, a failure, an accepted result still cleaning
  // up, the outcome of a completed or cancelled run, or the work in
  // progress. Everything here comes from the record and this host's facts.
  private updateFocus(r: RunResponse, rec: RunRecord) {
    const d = this.data
    const ex = rec.execution
    const wf = activeWorkflow(r, rec)
    const name = (id: string) => (wf && effectiveOf(rec) ? stepLabel(wf, effectiveOf(rec)!, id) : wf?.nodes[id]?.name || id)
    const answerable = Object.values(rec.questions).filter(q => this.answerable(rec, q))
    const asking = answerable.filter(q => questionState(q) === 'open')
    const last = rec.decisions.at(-1)
    const accepted = last?.decision === 'accepted'
    const hold = rec.control.hold
    const isReview = (q: Question) => !!q.presentation || (!!q.node && wf?.nodes[q.node]?.confirms === 'result')
    let kind: string, head: string, lead: string | Node
    if (d.rev) { kind = 'history'; head = 'A recorded state'; lead = h('span', h('span.d-only', `As committed at ${d.rev.slice(0, 10)}: what`), h('span.s-only', 'What'), ' was recorded then, read-only. This host\'s live facts and the operations are not shown.') }
    else if (rec.cancelled) { kind = 'cancelled'; head = 'Cancelled'; lead = h('span', `${rec.cancelled.by}`, h('span.d-only', `, ${when(rec.cancelled.at)}`), `: ${rec.cancelled.reason}`) }
    else if (asking.length) {
      const review = asking.some(isReview)
      kind = review ? 'review' : 'question'
      head = review ? 'Ready for your review' : asking.length > 1 ? `${asking.length} questions wait for your answer` : 'A question waits for your answer'
      lead = review ? h('span', 'Open the review, then answer below.', h('span.d-only', ' Your answer is recorded; the executor records the decision when it takes the answer up.'))
        : this.hosted() ? h('span', `${rec.executor.name} asked.`, h('span.s-only', ' Your answer lets it continue.'), h('span.d-only', ' Your answer is recorded in run.json, and this host queues the executor to continue the run.'))
          : h('span', `${rec.executor.name} asked.`, h('span.s-only', ' Recording your answer does not wake it.'), h('span.d-only', ' Your answer is recorded in run.json and does not wake the executor — tell it where you work with it.'))
    } else if (answerable.length) {
      kind = 'answered'; head = 'Your answer is recorded'
      lead = h('span', `${rec.executor.name} has not taken it up yet: the next move is theirs.`, h('span.d-only', ' Recording an answer does not wake the executor.'))
    } else if (hold) {
      kind = 'held'; head = `Held (${hold.kind})`
      // observer p3: an interrupted or unknown hold is also Observer's to take to a recovery agent; a stop is only the person's.
      const recovery = hold.kind === 'stopped' ? 'nothing of it runs until it is resumed with an instruction' : 'Observer asks a recovery agent to look and continue it (or you resume it with an instruction)'
      lead = h('span', `${hold.by}${becauseText(hold.because)}`, h('span.d-only', `, ${when(hold.since)}`), `: ${sentence(hold.reason)} Its plan and work are kept, and ${recovery}. Other requests in this project can run meanwhile.`)
    }
    else if (ex.failed.length) {
      kind = 'failed'; head = `${ex.failed.map(name).join(', ')} failed`
      const work = ex.blocked.filter(n => !effectiveOf(rec)?.nodes[n]?.step), docs = ex.blocked.length - work.length
      lead = ex.blocked.length ? `Blocked by it: ${work.map(name).join(', ') || 'no work'}${docs ? ` (and ${docs} documentation step${docs === 1 ? '' : 's'})` : ''}.` : 'Nothing depends on it.'
    }
    else if (this.approval?.kind === 'reaccept') {
      // The renewed acceptance, with what changed, beside its control (project_migration p3/ex1).
      kind = 'reaccept'
      const unbound = this.approval.integration?.state === 'unbound'
      head = unbound ? 'Accept the result again to integrate it' : 'The result changed after it was accepted'
      lead = unbound ? 'Its acceptance was recorded before integration existed and names no revision. Look at the result, then accept it again below.'
        : h('span', 'Integration stopped: what is in the run now is not what was accepted, so nothing of it is on the shared branch yet. Look at what changed, then accept it again below — or reject it.')
    }
    else if (this.approval?.kind === 'integration-problem') { kind = 'integration'; head = 'Accepted — not integrated'; lead = 'The accepted result could not be brought into the shared branch. The integration record below says why.' }
    else if (accepted && ex.state !== 'completed') { kind = 'accepted'; head = 'Accepted — cleanup is still running'; lead = h('span', 'The result was accepted', last!.confirmation ? h('span.d-only', ` from ${last!.confirmation.question}`) : null, '; the run completes after its remaining steps.') }
    else if (ex.state === 'completed') { kind = 'completed'; head = !last ? 'Completed — your decision is needed' : accepted ? (this.approval?.kind === 'integrated' ? 'Completed, accepted and integrated' : this.approval?.kind === 'integrating' ? 'Accepted — integrating' : 'Completed and accepted') : 'Completed — result rejected'; lead = !last ? 'Every node recorded completion. Accepting the result is your separate decision.' : h('span', `${last.decision === 'accepted' ? 'Accepted' : 'Rejected'}${last.confirmation ? ` from ${last.confirmation.from}'s answer` : ` by ${last.by}`}`, h('span.d-only', `${last.confirmation ? ` (${last.confirmation.question}, recorded by ${last.by})` : ''}, ${when(last.at)}`), '.') }
    else if (ex.active.length || rec.control.attempt) { kind = 'working'; head = 'Work in progress'; lead = this.observation(rec)[0] === 'warn' ? 'Recorded as in progress, but this host does not see the work running: look below.' : 'Nothing is needed from you now.' }
    else if (ex.state === 'not-started') { kind = 'not-started'; head = 'Not started'; lead = `Waiting for ${rec.executor.name} to start.` }
    // A delegate node waits on its child (p10): the next move is the child's, or this run's agent's when a fact came back.
    else if (ex.waiting.some(w => 'delegation' in w.on)) {
      const w = ex.waiting.find(x => 'delegation' in x.on)!
      const dl = d.delegView?.delegations.find(x => x.id === (w.on as { delegation: string }).delegation)
      kind = 'delegated'
      head = dl?.pending.length ? `${rec.executor.name} has news from ${dl.target.project}/${dl.target.workflow}` : `Waiting for ${dl ? `${dl.target.project}/${dl.target.workflow}` : w.holder}`
      lead = dl?.pending.length ? 'The delegated run asked or delivered something; this run continues when the executor takes it up.' : dl?.child ? h('span', `Its child ${dl.child.workflow}/${dl.child.run} is ${childWords(dl.childNow?.situation)}. `, h('a', { href: `#/ws/${encodeURIComponent(dl.child.workspace)}/run/${encodeURIComponent(dl.child.workflow)}/${encodeURIComponent(dl.child.run)}` }, 'Open the child run'), '.') : 'The request is on its way to that workflow\'s channel; its intake creates the child.'
    }
    else { kind = 'idle'; head = 'Waiting for the executor'; lead = ex.ready.length ? `Ready to start: ${ex.ready.map(name).join(', ')}.` : 'Nothing is running and nothing is ready.' }
    if (this.focus.dataset.kind !== kind) this.focus.dataset.kind = kind

    // The situation's icon, large: what kind of task this is before any word is read (p8/ex1).
    const FOCUS_ICON: Record<string, string> = { delegated: 'delegate', reaccept: 'alert', integration: 'alert', review: 'present', question: 'question', answered: 'history', held: 'stop', failed: 'alert', accepted: 'check', completed: 'check', cancelled: 'stop', working: 'play', history: 'history', 'not-started': 'play', idle: 'play' }
    const done = kind === 'completed' && last?.decision === 'rejected' ? 'failed' : kind === 'completed' && !last ? 'pending' : kind
    const blocks: (Node | null)[] = [h('div.focus-top', h(`span.focus-icon.tone-${done}`, icon(FOCUS_ICON[kind] ?? 'flag', 'icon')), h('div.focus-words', h('h2.focus-head', head), h('p.focus-lead', lead)))]
    // The one-click review, while it is served (p7); otherwise what became of it.
    if (!d.rev) blocks.push(this.reviewLink(rec, kind))
    if (kind === 'working' || kind === 'accepted') blocks.push(this.activeBlock(rec, name))
    // Where the accepted result stands (p9): saved, accepted, integrated.
    const integ = !d.rev && (kind === 'completed' || kind === 'accepted' || kind === 'reaccept' || kind === 'integration') ? integrationStatus(rec, d.execView, d.resp?.place) : null
    if (integ) blocks.push(h(`p.small.integration-state.tone-${integ.tone}`, h(`span.chip.${integ.tone === 'ok' ? 'ok' : integ.tone === 'muted' ? 'muted' : 'warn'}`, integ.text), integ.detail ? h('span.d-only.muted', ` ${integ.detail}`) : null,
      integ.tone !== 'ok' && integ.tone !== 'muted' && rec.decisions.at(-1)?.decision === 'accepted' ? h('span', ' ', h('a', { href: '#', dataset: { action: 'goto-section', section: 'execution' } }, 'Integration')) : null))
    // What a renewed acceptance accepts: the files changed since the last one, readable here.
    if (kind === 'reaccept' && integ?.changed?.length) blocks.push(h('div.changed-since',
      h('p.small', h('strong', 'Changed since the acceptance'), ` (${integ.changed.length})`),
      h('ul.files.small', ...integ.changed.slice(0, 12).map(f => h('li', { dataset: { key: `chg:${f}` } }, fileLink(f)))),
      integ.changed.length > 12 ? h('p.small.muted', `and ${integ.changed.length - 12} more (Execution and publication → Integration).`) : null))
    if (kind === 'held') blocks.push(h('p.small.muted', 'Look at the run\'s files first (they are in its own copy of the project); the instruction tells the executor what to do now. ', h('a', { href: '#', dataset: { action: 'goto-section', section: 'execution' } }, 'Execution details')))
    if (kind === 'failed') blocks.push(
      h('ul.failures', ...ex.failed.map(n => { const f = rec.nodes[n].failure; return h('li', { dataset: { key: `fail:${n}` } }, nodeLink(n, name(n)), f ? `: ${f.reason}` : '', f ? h('span.d-only.muted', ` (${f.by}, ${when(f.at)})`) : null) })),
      h('p.small', `${rec.executor.name} can start a failed node again. You can change the work that is still pending, or end the run.`),
      h('div.row.tight.focus-actions',
        h('button', { dataset: { action: 'goto-section', section: 'definition', focus: 'adjust' } }, 'Adjust future work'),
        h('button.danger', { dataset: { action: 'cancel-run' }, disabled: this.frozen }, 'Cancel run')))
    // The full list of recorded outcomes is Detail's (p8/ex1).
    if (kind === 'completed' || kind === 'accepted' || kind === 'reaccept' || kind === 'integration' || kind === 'cancelled' || kind === 'history') blocks.push(this.outcomes(rec, wf, name))
    if (kind === 'cancelled') {
      const still = Object.values(rec.presentations ?? {}).filter(isOpen)
      if (still.length) blocks.push(h('div.banner.warn.small', `${still.map(p => p.id).join(', ')} still recorded as ${still[0].state}: `, ...still.map(p => h('button', { dataset: { action: 'present-stop', presentation: p.id } }, `Stop ${p.id}`))))
      const unfinished = Object.entries(rec.nodes).filter(([, n]) => n.state === 'cancelled' && n.started).map(([id]) => name(id))
      if (unfinished.length) blocks.push(h('p.small.muted', `Started and then cancelled: ${unfinished.join(', ')}. Anything they had begun (a server, a branch) may need cleaning up by hand.`))
    }
    // Problems that need the person, wherever their section is (closed or not).
    if (!d.rev) {
      const pubs = (d.execView?.checkpoints ?? []).filter(c => c.state === 'failed' || c.state === 'attention').length
      const stuck = Object.values(rec.presentations ?? {}).filter(p => p.state === 'stop-failed' || p.state === 'failed')
      const need: (Node | null)[] = [
        pubs ? h('li', `Publication: ${pubs} checkpoint${pubs === 1 ? '' : 's'} need${pubs === 1 ? 's' : ''} you — `, h('a', { href: '#', dataset: { action: 'goto-section', section: 'execution' } }, 'Execution and publication')) : null,
        ...stuck.map(p => h('li', `${p.id}: ${p.state === 'stop-failed' ? 'its stop could not be verified' : 'its last start failed'} — `, h('a', { href: '#', dataset: { action: 'goto-section', section: 'presentations' } }, 'Presentations'))),
        d.notifyView?.failed || d.notifyView?.problem ? h('li', 'Zulip coordination is failing — ', h('a', { href: '#', dataset: { action: 'goto-section', section: 'coordination' } }, 'Coordination')) : null,
        d.execError ? h('li', `This host's execution facts could not be read (${d.execError}); the executor line shows the last facts.`) : null,
      ].filter(Boolean)
      if (need.length) blocks.push(h('div.needs.banner.warn', h('strong', 'Needs attention'), h('ul', ...need)))
    }
    // Conditions beside the main one, so none is hidden by it.
    if (hold && kind !== 'held' && !d.rev) blocks.push(h('p.small.warn-text', `The run is also held (${hold.kind}): `, h('a', { href: '#', dataset: { action: 'goto-resume' } }, 'resume it below')))
    if (ex.failed.length && kind !== 'failed' && !rec.cancelled) blocks.push(h('p.small.error', `Failed: ${ex.failed.map(name).join(', ')}.`))
    patchContent(this.focusDisplay, ...blocks)

    // The resume form lives here while the run is held.
    const r2 = this.resume.draft
    if (hold && !d.rev) { place(this.resume.root, this.holdSlot); r2.set(null, !this.frozen && !rec.cancelled) }
    else if (r2.kept && this.resume.root.isConnected) r2.set('The run is no longer held: there is nothing to resume. Your text is kept, not sent.')
    else if (!inUse(this.resume.root)) this.resume.root.remove()
    // The decision: here when a completed run has none; otherwise at the side (Result).
    const decideHere = !d.rev && !rec.cancelled && (this.approval?.kind === 'decide' || this.approval?.kind === 'reaccept')
    if (!d.rev) {
      if (!this.decide.evidence.kept) place(this.decide.root, decideHere ? this.decideSlot : this.result.content)
      else if (!this.decide.root.isConnected) place(this.decide.root, this.result.content)
    }
    show(this.decideSlot, this.decideSlot.childElementCount > 0)
    show(this.holdSlot, this.holdSlot.childElementCount > 0)
    // Simple (p8/ex1): the pane is shown for a selection, an open file, or a
    // form that records under the person's name; otherwise the main column
    // takes its width. Detail always shows it.
    const forms = !d.rev && (this.focusQuestions.childElementCount > 0 || this.holdSlot.childElementCount > 0 || this.decideSlot.childElementCount > 0 || kind === 'working' || kind === 'accepted' || kind === 'failed' || kind === 'integration')
    const quiet = !forms && !(d.selection && rec.nodes[d.selection]) && !d.viewing
    this.el.classList.toggle('quiet', quiet)

    // Links to the outcome and the request.
    const files = new Set(r.files.map(f => f.name))
    patchContent(this.focusLinks,
      files.has('report.md') ? docLink('report.md', 'Read final report') : null,
      files.has(rec.input.file) ? docLink(rec.input.file, 'Original request') : null,
      h('a.focus-link', { href: '#', dataset: { action: 'goto-section', section: 'files' } }, icon('list', 'icon small'), `Reports & files (${r.files.length})`),
      h('a.focus-link.d-only', { href: '#', dataset: { action: 'details' } }, 'Run details'),
      h('a.focus-link.s-only.records-entry', { href: '#', dataset: { action: 'records' }, title: 'Every record of the run: questions, presentations, the definition, files, execution, coordination, the decision and history' }, icon('history', 'icon small'), 'All records'))
  }

  // The review link (p7): the latest live presentation, prominently; one
  // recorded but not served says so instead of offering a dead link.
  private reviewLink(rec: RunRecord, kind: string): HTMLElement | null {
    if (!rec.presentations) return null
    const live = this.data.presentViews.filter(v => v.live).at(-1)
    if (live) return h('div.review-link', h('a.button.primary', { href: live.url!, target: '_blank', rel: 'noopener', dataset: { presentation: live.id } }, icon('present', 'icon small'), `Open the review: ${live.title}`),
      h('span.small.d-only', ` ${live.id} · revision ${live.revision.slice(7, 19)}${live.local ? ' · opens on this host' : ''}`))
    const open = Object.values(rec.presentations).filter(isOpen)
    if (open.length && kind === 'cancelled') return null // the cancelled card offers their stop
    if (open.length) return h('div.review-link.not-live', h('span.chip.warn', `${open.map(p => p.id).join(', ')} recorded as ${open[0].state}, but not served now`), h('span.small', ' — '), h('a.small', { href: '#', dataset: { action: 'goto-section', section: 'presentations' } }, 'start it again or record its stop'))
    if (kind === 'working' || kind === 'question') return null
    const last = Object.values(rec.presentations).at(-1)!
    return h('div.review-link.stopped', icon('present', 'icon small'), h('span', h('strong', `${last.title}`), h('span.d-only', ` — ${last.id} ${last.state}`), h('span.s-only', last.state === 'stopped' ? ' — review stopped, no longer served' : ` — ${last.state}`)), h('span.small.muted.d-only', last.state === 'stopped' ? ' · no longer served; its files and the decision stay in the run folder' : ''))
  }

  // What runs now: recorded activity beside this host's facts, with Stop.
  private activeBlock(rec: RunRecord, name: (id: string) => string): HTMLElement {
    const ex = rec.execution
    const d = this.data
    const open = d.execView?.attempts.find(a => a.state !== 'ended')
    const host = d.execError ? `this host's execution facts could not be read (${d.execError})`
      : open ? (open.alive === true ? `attempt ${open.id}: process ${open.pid} alive on this host` : open.alive === false ? (open.pid ? `attempt ${open.id}: process ${open.pid} not seen alive` : `attempt ${open.id} launching`) : `attempt ${open.id} runs on another host`)
        : rec.control.attempt ? `attempt ${rec.control.attempt.id} is open in the record; this host shows no process for it` : 'no attempt is open'
    const steps = ex.active.map(n => { const st = effectiveOf(rec)?.nodes[n]?.step; return h('li', { dataset: { key: `act:${n}` } }, st?.kind === 'report' ? h('span', 'Writing ', nodeLink(n, name(n))) : nodeLink(n, name(n)), rec.nodes[n].notes.at(-1) ? h('span.muted.small', ` — ${rec.nodes[n].notes.at(-1)!.text.split('\n')[0].slice(0, 140)}`) : null) })
    const sit = situation(rec)
    const [tone, seen] = this.observation(rec)
    return h('div.active-block',
      steps.length ? h('ul.active-list', ...steps) : h('p.small.muted', 'No node is recorded as running.'),
      seen ? h(`p.s-only.observation.${tone}`, icon(tone === 'ok' ? 'play' : tone === 'warn' ? 'alert' : 'history', 'icon small'), seen) : null,
      h('p.small.executor-line.d-only', `Executor: ${host}${d.execView ? ` · executor ${d.execView.executor.state}` : ''}`),
      h('div.row.tight.focus-actions', h('button', { title: STOP_TITLE, dataset: { action: 'stop-run' }, disabled: this.frozen || !!rec.control.hold || !!rec.control.stop || sit === 'completed' }, icon('stop', 'icon tiny'), 'Stop'),
        rec.control.stop ? h('span.small.warn-text', `Stop requested by ${rec.control.stop.by}${becauseText(rec.control.stop.because)}; waiting for the process to end, then its work is saved.`) : null))
  }

  // Whether this host executes the run (it has queued jobs for it): an answer
  // recorded here then queues the executor's resumption (server/api.ts).
  private hosted(): boolean { return !this.data.rev && (this.data.execView?.jobs.length ?? 0) > 0 }

  // Simple (p8/ex1): what this host observes of the executor, in a few words
  // with a tone. A missing or failed observation never reads as healthy.
  private observation(rec: RunRecord): ['ok' | 'warn' | 'muted', string] {
    const d = this.data
    const open = d.execView?.attempts.find(a => a.state !== 'ended')
    if (d.rev) return ['muted', '']
    if (d.connected === false) return ['warn', 'Not connected: what runs now is not known']
    if (d.execError) return ['warn', 'This host\'s execution facts cannot be read']
    if (!d.execView) return ['muted', 'Checking the executor…']
    if (open) return open.alive === true ? ['ok', 'The executor is working on this host'] : open.alive === false ? (open.pid ? ['warn', 'No executor process is seen'] : ['muted', 'The executor is starting']) : ['muted', 'The executor runs on another host']
    if (rec.control.attempt) return ['warn', 'No executor process is seen for the open attempt']
    return rec.execution.active.length ? ['warn', 'Recorded as running, but no attempt is open'] : ['muted', 'No attempt is open']
  }

  // The recorded outcomes, each with the step it came from, in dependency
  // order. A run with a result confirmation lists what came after it (its
  // cleanup) apart, so the delivered work is not read from the last event.
  private outcomes(rec: RunRecord, wf: ReturnType<typeof activeWorkflow>, name: (id: string) => string): HTMLElement | null {
    if (!wf) return null
    const ids = topoOrder(Object.keys(wf.nodes).filter(id => rec.nodes[id]), wf.edges)
    const confirm = ids.find(id => wf.nodes[id].confirms === 'result')
    const after = confirm ? descendants(confirm, wf.edges) : new Set<string>()
    const item = (id: string) => h('li', { dataset: { key: `out:${id}` } }, h('strong', nodeLink(id, name(id))), h('span', `: ${rec.nodes[id].outcome!.text}`))
    const main = ids.filter(id => rec.nodes[id].outcome && !after.has(id)), later = ids.filter(id => rec.nodes[id].outcome && after.has(id))
    if (!main.length && !later.length) return h('p.small.muted.d-only', 'No outcome is recorded.')
    return h('div.outcomes.d-only',
      h('h3', 'Recorded outcomes'),
      h('ol.outcome-list', ...main.map(item)),
      later.length ? h('h4', `After ${name(confirm!)}`) : null,
      later.length ? h('ol.outcome-list.after', ...later.map(item)) : null)
  }

  // ---- the selected node (side, read-only) --------------------------------------

  private updateSelected(rec: RunRecord) {
    const id = this.data.selection
    const on = !!id && !!rec.nodes[id]
    show(this.selected.root, on)
    if (!on) return
    setText(this.selected.title, 'Selected node')
    patchContent(this.selected.content.children[0] as HTMLElement, this.nodeDetail(rec, id!))
  }

  private nodeDetail(rec: RunRecord, id: string): HTMLElement {
    const r = this.data.shown!
    const n = rec.nodes[id]
    const wf = activeWorkflow(r, rec)
    const def = wf?.nodes[id]
    const eff = effectiveOf(rec)
    const step = eff?.nodes[id]?.step
    const { state, label } = nodeLabel(rec, id)
    const box = h('div.node-detail', { dataset: { node: id, key: `node:${id}` } })
    const label2 = (x: string) => (wf && eff ? stepLabel(wf, eff, x) : x)
    box.append(h('div.insp-head', icon(step ? 'doc' : def?.type ?? 'unknown', 'icon'), h('h3', step ? label2(id) : def?.name || id), h('code.d-only', id), h('button.icon-btn', { title: 'Close', 'aria-label': 'Close the selected node', dataset: { action: 'close-node' } }, '×')))
    box.append(h('div.chips', chip(state, `${STATE_GLYPH[state] ?? ''} ${label}`), h('span.chip.d-only', step ? 'Documentation step' : TYPE_LABEL[def?.type ?? ''] ?? def?.type ?? '?'), h('span.chip.muted.d-only', icon('lock', 'icon tiny'), 'Read-only')))
    if (def?.description) box.append(h('p.small', def.description))
    // A delegate node (p10): its delegation and child, in both modes.
    const dl = this.data.delegView?.delegations.filter(x => x.node === id).at(-1)
    if (def?.type === 'delegate') box.append(dl ? this.delegationCard(dl, true) : h('p.small.muted', `Delegates to ${def.project ? `${def.project}/` : ''}${def.workflow ?? '?'}; nothing dispatched yet.`))
    // Made from one of the person's templates (p7/ex1): its provenance as written in this revision.
    if (def?.template) box.append(h('div.template-field.small.d-only', h('span.muted', 'From template '), h('code', def.template.id), ` revision ${def.template.revision}. `,
      h('div.template-provenance', h('span.muted', 'Expected: '), def.template.expectation)))
    // Added by an adjustment (p7): which revision brought it in.
    const added = (rec.definition.revisions ?? []).find(v => v.diff.added.includes(id))
    if (added) box.append(h('p.small.muted.d-only', `Added in revision ${added.revision}: ${added.reason}`))
    if (step && eff) {
      // The document: missing, written but unrecorded, or checked.
      const file = r.files.find(f => f.name === step.output)
      const path = `${r.dir}/${step.output}`
      const docState = n.document ? `checked when recorded: ${n.document.bytes} bytes, sha256 ${n.document.sha256.slice(0, 12)}…${file ? '' : ' — the file is gone now'}` : file ? (state === 'running' ? 'being written — not yet recorded' : 'written, not recorded as complete') : 'not written yet'
      box.append(h(`div.doc-state${n.document ? (file ? '.ok' : '.missing') : file ? '.unfinished' : '.missing'}`, h('strong', step.output), h('span.d-only', ': ', docState), h('span.s-only', `: ${n.document ? (file ? 'written and checked' : 'the file is gone') : file ? (state === 'running' ? 'being written' : 'written, not recorded') : 'not written yet'}`), ' ', file ? fileLink(path, 'Open') : null))
      if (n.agreement) box.append(h('p.small.ok-text.d-only', `Agreed: the answer to ${n.agreement.question} was taken up for this plan.md.`))
      box.append(...stepFacts(eff, id, label2))
    } else if (eff?.nodes[reportStep(id)]) {
      const rs = reportStep(id)
      const rf = r.files.find(f => f.name === `report-${id}.md`)
      box.append(h('p.small', 'Its report: ', nodeLink(rs, `report-${id}.md`), ` — ${nodeLabel(rec, rs).label}`, h('span.d-only', '. Successors wait for the report, not only for this work.'), rf ? h('span.s-only', ' · ', fileLink(`${r.dir}/${rf.name}`, 'Read it')) : null))
    }
    if (n.outcome) box.append(h('div.outcome', h('strong', 'Recorded outcome: '), n.outcome.text, ...n.outcome.artifacts.map(a => h('div.small', fileLink(a)))))
    if (n.wait) {
      const on = n.wait.on
      box.append(h('div.wait-box', h('strong', 'Waiting: '), n.wait.reason, h('br'), 'Next move: ', h('strong', holderOf(rec, id)),
        'external' in on ? h('div.small', `Awaiting: ${on.external}`) : null))
    }
    if (n.failure) box.append(h('div.banner.error', 'Failed', h('span.d-only', ` (${n.failure.by}, ${when(n.failure.at)})`), `: ${n.failure.reason}`))
    if (n.cancellation) box.append(h('div.banner.warn', 'Cancelled', h('span.d-only', ` (${n.cancellation.by}, ${when(n.cancellation.at)})`), `: ${n.cancellation.reason}`))
    const rows: [string, string][] = [['Started', n.started ? when(n.started) : '—'], ['Ended', n.ended ? when(n.ended) : '—'], ['Last update', n.updated ? `${when(n.updated)} (${ago(n.updated)})` : '—']]
    box.append(h('dl.kv.d-only', ...rows.flatMap(([k, v]) => [h('dt', k), h('dd', v)])))
    // Simple: the latest observation of a node at work, nothing older.
    if (n.notes.length && (n.state === 'running' || n.state === 'waiting')) box.append(h('p.small.s-only.latest-note', h('span.muted', 'Latest: '), n.notes.at(-1)!.text.split('\n')[0].slice(0, 200)))
    box.append(h('div.insp-more.s-only', h('button.more-link', { type: 'button', dataset: { action: 'more-details' } }, icon('list', 'icon small'), 'More details'), h('span.small.muted', ' times, notes, its questions')))
    if (n.notes.length) box.append(h('h4.d-only', 'Notes'), h('ul.notes.d-only', ...n.notes.map(x => h('li', h('span.muted.small', `${when(x.at)} · ${x.by}: `), x.text))))
    // The node's questions as summaries; each is answered in its one form.
    const qs = Object.values(rec.questions).filter(q => q.node === id)
    if (qs.length) box.append(h('h4.d-only', 'Questions of this node'), ...qs.map(q => {
      const st = questionState(q)
      return h(`div.question-summary.d-only.q-${st}`, { dataset: { question: q.id, key: `qs:${q.id}` } }, h('strong', q.id), ' ', chip(questionChip(st), st), ' ',
        h('span.small', q.text.split('\n')[0].slice(0, 160)), ' ',
        h('a.small', { href: '#', dataset: { action: 'goto-question', question: q.id } }, this.answerable(rec, q) ? 'Answer it' : 'Show it'))
    }))
    return box
  }

  // ---- questions ------------------------------------------------------------------

  private answerable(rec: RunRecord, q: Question) {
    const st = questionState(q)
    return (st === 'open' || st === 'answered') && !this.data.rev && !rec.cancelled
  }

  // Open and answered questions are the person's task (the focus card,
  // oldest first); taken-up and withdrawn ones are records (the side,
  // newest first). A question whose form holds a draft stays in the focus
  // card until the draft is gone.
  private updateQuestions(rec: RunRecord) {
    const qs = Object.values(rec.questions)
    for (const q of qs) {
      if (this.qItems.has(q.id)) continue
      const display = h('div.q-display')
      const another = h('button.link-btn.another', 'Record another answer')
      const item: QuestionItem = { id: q.id, root: h('div.question', { dataset: { question: q.id, key: `q:${q.id}` } }, display), display, another, showForm: false }
      another.addEventListener('click', () => { item.showForm = true; const r = this.data.shown?.record; if (r) this.updateQuestions(r); item.form?.draft.el.focus() })
      this.qItems.set(q.id, item)
    }
    const kept = (q: Question) => !!this.qItems.get(q.id)!.form?.draft.kept
    const focusList = qs.filter(q => this.answerable(rec, q) || kept(q))
    const sideList = qs.filter(q => !focusList.includes(q)).reverse()
    const resolved = sideList.length
    setText(this.questions.title, `Questions (${resolved} resolved)`)
    const box = this.questions.content.children[0] as HTMLElement
    show(this.questions.content.children[1] as HTMLElement, !resolved)
    const arrange = (container: HTMLElement, items: Question[]) => {
      let at = container.firstChild
      for (const q of items) {
        const item = this.qItems.get(q.id)!
        if (item.root === at) at = at.nextSibling
        else place(item.root, container, at)
        this.updateQuestion(rec, q, item)
      }
    }
    arrange(this.focusQuestions, focusList)
    arrange(box, sideList)
    show(this.focusQuestions, this.focusQuestions.childElementCount > 0)
  }

  private updateQuestion(rec: RunRecord, q: Question, item: QuestionItem) {
    const st = questionState(q)
    const cls = `question q-${st}`
    if (item.root.className !== cls) item.root.className = cls
    const v = q.presentation ? this.data.presentViews.find(x => x.id === q.presentation!.id) : undefined
    const doc = q.document ? this.data.shown?.files.find(f => `${this.data.shown!.dir}/${f.name}` === q.document!.path || f.name === q.document!.path.split('/').pop()) : undefined
    patchContent(item.display,
      h('div.q-head', h('strong', q.id), chip(questionChip(st), st), h('span.muted.small.d-only', ` to ${q.to}${q.node ? ` · node ${q.node}` : ''} · asked by ${q.askedBy}, ${ago(q.asked)}`)),
      h('p.q-text', q.text),
      q.presentation ? h('p.small.d-only', 'About presentation ', h('strong', q.presentation.id), h('span.d-only', ` (revision ${q.presentation.revision.slice(7, 19)})`), ' — ', v?.live ? h('a', { href: v.url!, target: '_blank', rel: 'noopener' }, 'open the review ↗') : h('span.muted', 'not served now')) : null,
      q.document ? h('p.small', 'About ', doc ? fileLink(`${this.data.shown!.dir}/${doc.name}`, q.document.path.split('/').pop()!) : h('code', q.document.path), doc ? '' : ' (not in the run folder now)') : null,
      ...q.answers.map((a, i) => h('div.answer', { dataset: { key: `a:${i}` } }, h('span.muted.small.d-only', `Answer ${i}${q.takenUp?.answer === i ? ' — taken up' : ''} · from ${a.from}${a.by !== a.from ? `, recorded by ${a.by}` : ''} via ${a.via} · ${when(a.at)}`), h('div', a.text))),
      q.takenUp ? h('p.small.ok-text', `Taken up by ${q.takenUp.by} ${ago(q.takenUp.at)}.`) : null,
      q.withdrawn ? h('p.small', `Withdrawn by ${q.withdrawn.by}: ${q.withdrawn.reason}`) : null,
      // Recorded and waiting for the executor: said apart from a failed
      // submission (which stays in the form, with its text and the reason).
      st === 'answered' ? h('p.small.receipt.recorded', icon('check', 'icon tiny'), h('span', h('strong', 'Recorded'), ` ${ago(q.answers.at(-1)!.at)}. Waiting for ${rec.executor.name} to take it up${this.hosted() ? ' — its continuation is queued on this host' : ' — tell it where you work with it'}. Nothing more is needed from you here.`)) : null)
    const open = this.answerable(rec, q)
    if (open && !item.form) item.form = this.answerForm(q.id)
    const f = item.form
    // An answered question offers another answer on request; an open one always.
    const wantForm = open && (st === 'open' || item.showForm || !!f?.draft.kept)
    if (open && st === 'answered' && !wantForm) { if (!item.another.isConnected) item.root.append(item.another) } else item.another.remove()
    if (!f) return
    if (wantForm) {
      if (!f.root.isConnected) item.root.append(f.root)
      setText(f.button, st === 'answered' ? 'Record another answer' : 'Record answer')
      f.draft.set(null, !this.frozen)
    } else if (f.draft.kept) {
      if (!f.root.isConnected) item.root.append(f.root)
      f.draft.set(`${q.withdrawn ? 'The question was withdrawn' : rec.cancelled ? 'The run is cancelled' : q.takenUp ? 'The answer was taken up' : 'The question is closed'}: nothing more can be recorded here. Your text is kept, not sent.`)
    } else f.root.remove()
  }

  private answerForm(id: string) {
    const button = h('button.primary', 'Record answer')
    const draft = new Owned(h('textarea', { rows: 3, 'aria-label': `Answer to ${id}`, placeholder: 'Your answer' })).controls(button)
    button.addEventListener('click', () => {
      if (!draft.el.value.trim()) return
      // The question and the run as last read, not as they were when the form was made.
      const rec = this.data.shown?.record
      const q = rec?.questions[id]
      if (!rec || !q || !this.answerable(rec, q)) { this.act.notice('error', `${id} can no longer be answered here.`); return }
      void draft.submit(text => this.act.record({ op: 'question.answer', question: id, text }, r => r.job
        ? `Answer to ${id} recorded. ${rec.executor.name} continues the run (its resumption is queued on this host).`
        : `Answer to ${id} recorded in run.json. Continue the conversation with ${rec.executor.name} where you work with it; recording does not notify it.`)).then(ok => {
        const item = this.qItems.get(id)
        if (ok && item && draft.el.value === '') { item.showForm = false; const r = this.data.shown?.record; if (r) this.updateQuestions(r) }
      })
    })
    return { root: h('div.answer-form', draft.el, draft.note, h('div.row.tight', button), draft.status, h('p.small.muted.d-only', this.hosted() ? 'Stored in run.json as your answer; this host queues the executor to continue the run.' : 'Stored in run.json as your answer. It does not start or wake the executor; tell it where you work with it.')), draft, button }
  }

  // Additional instructions (p6): received from the person, acknowledged by
  // the executor at a node boundary. Received is not read.
  private updateInstructions(rec: RunRecord) {
    const ins = Object.values(rec.instructions ?? {})
    show(this.instructions.root, ins.length > 0)
    if (!ins.length) return
    const pending = ins.filter(i => !i.ack).length
    setText(this.instructions.title, `Instructions (${pending ? `${pending} not acknowledged` : 'all acknowledged'})`)
    this.attend(this.instructions, pending ? 'warn' : null)
    patchContent(this.instructions.content.children[0] as HTMLElement, ...ins.slice().reverse().map(i => h(`div.question.q-${i.ack ? 'taken-up' : 'answered'}`, { dataset: { instruction: i.id, key: `i:${i.id}` } },
      h('div.q-head', h('strong', i.id), chip(i.ack ? 'completed' : 'waiting', i.ack ? `acknowledged: ${i.ack.response}` : 'received'), h('span.muted.small', ` from ${i.from} via ${i.via} · ${when(i.at)}${i.during.length ? ` · while ${i.during.join(', ')} ran` : ''}`)),
      h('p.q-text', i.text),
      i.ack ? h('p.small.ok-text', `${i.ack.by}: ${i.ack.note}`) : h('p.small.muted', `${rec.executor.name} reads it at the next node boundary; no node starts before it is acknowledged.`))))
  }

  // Presentations (p7): the record's state beside this host's observation;
  // a link only while it is observed serving. Start again (recovery) and
  // stop are the person's operations as well as the executor's.
  private updatePresentations(rec: RunRecord) {
    show(this.presentations.root, !!rec.presentations)
    if (!rec.presentations) return
    const all = Object.values(rec.presentations)
    const live = all.filter(p => this.data.presentViews.find(x => x.id === p.id)?.live).length
    const unserved = all.filter(p => isOpen(p)).length - live
    const stopped = all.filter(p => p.state === 'stopped').length
    const parts = [live ? `${live} live` : '', unserved > 0 ? `${unserved} recorded open, not served` : '', stopped ? `${stopped} stopped` : '', all.some(p => p.state === 'failed' || p.state === 'stop-failed') ? 'a problem' : ''].filter(Boolean)
    setText(this.presentations.title, `Presentations (${parts.join(', ') || `${all.length} registered`})`)
    this.attend(this.presentations, all.some(p => p.state === 'failed' || p.state === 'stop-failed') ? 'error' : unserved > 0 && !rec.cancelled && rec.execution.state !== 'completed' ? 'warn' : unserved > 0 ? 'error' : null)
    const rev = this.data.rev
    const finished = !!rec.cancelled || rec.execution.state === 'completed'
    const STATE: Record<string, string> = { registered: 'completed', available: 'running', stopped: 'cancelled', failed: 'failed', 'stop-failed': 'failed' }
    patchContent(this.presentations.content.children[0] as HTMLElement, ...all.slice().reverse().map(p => {
      const v = this.data.presentViews.find(x => x.id === p.id)
      const asked = Object.values(rec.questions).filter(q => q.presentation?.id === p.id)
      const decided = rec.decisions.filter(d => d.confirmation?.presentation?.id === p.id)
      return h(`div.presentation.p-${p.state}`, { dataset: { presentation: p.id, key: `p:${p.id}` } },
        h('div.q-head', h('strong', p.id), chip(STATE[p.state] ?? 'pending', p.state), h('span.muted.small', ` ${p.title} · from ${p.node} · revision ${p.revision.slice(7, 19)} · ${p.files.length} files`)),
        v?.live ? h('p.small', h('a.button.small-btn', { href: v.url!, target: '_blank', rel: 'noopener' }, 'Open the review ↗'), h('span.muted', ` ${v.url}${v.local ? ' (this host)' : ''}`))
          : h('p.small.muted', isOpen(p) ? `Recorded ${p.state}, not served now${v?.observed ? `: ${v.observed.detail}` : ''}.` : p.state === 'stopped' ? `Stopped${p.last ? ` ${ago(p.last.at)}` : ''}: no longer served. ${p.last?.detail ?? ''}` : p.state === 'failed' ? `The last start failed: ${p.last?.detail ?? ''}` : 'Not served yet.'),
        asked.length ? h('p.small', `Asked about in ${asked.map(q => `${q.id} (${questionState(q)})`).join(', ')}${decided.length ? `; result ${decided.map(d => d.decision).join(', ')} from ${decided.map(d => d.confirmation!.question).join(', ')}` : ''}.`) : null,
        rev ? null : h('div.row.tight',
          !finished && !v?.live ? h('button', { title: 'Serve this revision again on this host', dataset: { action: 'present-start', presentation: p.id } }, p.state === 'registered' ? 'Start' : 'Start again') : null,
          isOpen(p) || v?.live ? h('button', { title: 'Stop the run\'s own instance and verify it is gone', dataset: { action: 'present-stop', presentation: p.id } }, p.state === 'stop-failed' ? 'Retry stop' : 'Stop') : null))
    }))
  }

  // Revisions (p7): the original snapshot, each adjustment with its reason,
  // source and difference, and the person's own adjustment of future work
  // (inspect first, then apply; the same operation as wfe run adjust).
  private updateDefinition(rec: RunRecord) {
    setText(this.definition.title, `Definition (${rec.definition.active ?? 'r1'} in force)`)
    const revs = rec.definition.revisions ?? []
    patchContent(this.definition.content.children[0] as HTMLElement,
      h('p.small', h('strong', 'r1'), ` original snapshot — definition/${rec.definition.root}.yaml, ${when(rec.created)}`),
      ...revs.map(v => h('div.revision', { dataset: { revision: v.revision, key: `r:${v.revision}` } },
        h('p.small', h('strong', v.revision), ` from ${v.parent} · ${v.by} · ${when(v.at)} · source: ${v.source.kind === 'request' ? `the original request (${v.source.input})` : v.source.kind}${'question' in v.source ? ` ${v.source.question}` : 'instruction' in v.source ? ` ${v.source.instruction}` : ''}`),
        h('p.small', v.reason),
        h('p.small.muted', `added ${list(v.diff.added)}; removed ${list(v.diff.removed)}; ${v.file}`))),
      revs.length ? null : h('p.small.muted', 'Not adjusted: the run follows its original snapshot.'))
    const a = this.adjust
    const open = !this.data.rev && !rec.cancelled && rec.execution.state !== 'completed'
    // The definition in force fills the form once; the text is the person's from then on.
    const active = this.data.shown?.revisions?.at(-1)?.text ?? this.data.shown?.bundle[rec.definition.root]?.text ?? ''
    if (a.base === null) { a.base = active; a.ta.el.value = active }
    const closed = open ? null : `The run is ${rec.cancelled ? 'cancelled' : 'completed'}: it can no longer be adjusted. Your text is kept, not sent.`
    a.ta.set(closed); a.reason.set(closed)
    if (open) { if (!a.root.isConnected) this.definition.content.append(a.root) }
    else if (a.ta.el.value === a.base && !a.reason.el.value.trim() && !a.ta.active && !a.reason.active) a.root.remove()
    this.renderPreview()
  }

  // The preview counts only for what it inspected: the same text and reason,
  // the same revision in force and the same run sequence (the server checks
  // both again on apply). Anything else leaves Apply disabled.
  private renderPreview() {
    const a = this.adjust
    const rec = this.data?.shown?.record
    const p = a.result
    const edited = !!p && (a.ta.el.value !== p.text || a.reason.el.value !== p.reason)
    const moved = !!p && !!rec && ((rec.definition.active ?? 'r1') !== p.revision || rec.seq !== p.seq)
    const current = !!p && !edited && !moved
    const v = p?.view
    patchContent(a.preview, v ? h(`div.banner.${v.ok ? 'ok' : 'error'}.small.adjust-preview${current ? '' : '.stale'}`,
      v.ok ? `Applicable to ${v.parent}: ` : `Not applicable (${v.problems.map(x => x.code).join(', ')}): `,
      `work added ${list(v.authored.added)}; removed ${list(v.authored.removed)}; changed ${v.authored.changed.map(c => `${c.id} (${c.fields.join(', ')})`).join(', ') || '—'}; new edges ${v.graph.edgesAdded.filter(([x, y]) => !x.startsWith('_') || !y.startsWith('_')).map(([x, y]) => `${x} → ${y}`).join('; ') || '—'}`,
      ...v.problems.map(x => h('div', `${x.code}: ${x.message}`)),
      ...(v.notes ?? []).map(x => h('div.muted', `Note: ${x}`)),
      current ? null : h('div.stale-note', edited ? 'Edited since this preview: preview again before applying.' : `The run moved on since this preview (${p!.revision}, seq ${p!.seq} → ${rec!.definition.active ?? 'r1'}, seq ${rec!.seq}): preview again before applying.`)) : null)
    const ok = current && !!v?.ok && !a.busy && !a.ta.el.readOnly
    setDisabled(a.apply, !ok)
    setDisabled(a.previewButton, a.busy || a.ta.el.readOnly)
    const title = ok ? 'Apply as a new revision' : 'Preview first'
    if (a.apply.title !== title) a.apply.title = title
  }

  private async sendAdjust(dryRun: boolean) {
    const a = this.adjust
    const rec = this.data.shown?.record
    if (!rec || a.busy || (!dryRun && !a.result)) return
    const sent: Omit<Preview, 'view'> = dryRun
      ? { text: a.ta.el.value, reason: a.reason.el.value, revision: rec.definition.active ?? 'r1', seq: rec.seq }
      : a.result!
    if (!sent.reason.trim()) { this.act.notice('error', 'An adjustment needs its reason.'); return }
    a.busy = true
    this.renderPreview()
    try {
      const view = await this.act.adjust({ text: sent.text, reason: sent.reason, dryRun, expectRevision: sent.revision, expectSeq: sent.seq })
      if (dryRun) {
        // A preview of text that has changed meanwhile is not shown at all.
        a.result = view && a.ta.el.value === sent.text && a.reason.el.value === sent.reason ? { ...sent, view } : null
      } else if (view?.ok) {
        a.result = null
        if (a.reason.el.value === sent.reason) a.reason.el.value = ''
        // The applied text becomes the base; the next reading fills the form with the new revision only if it was not edited.
        if (a.ta.el.value === sent.text) a.base = null
      } else if (view) a.result = { ...sent, view }
    } finally {
      a.busy = false
      this.renderPreview()
    }
  }

  private updateCatalog(rec: RunRecord) {
    const cat = this.data.shown?.catalog
    const body = this.catalog.content.children[0] as HTMLElement
    const given = rec.history.filter(e => e.op === 'attempt.begin').map(e => (e as { attempt: string; settings?: { catalog?: { state: string; sha256?: string } } }))
    if (!cat || cat.state === 'none') { setText(this.catalog.title, 'Node catalog'); patchContent(body, h('p.muted.small', 'None supplied: this run was created before node catalogs (p7/ex1).')); return }
    if (cat.state === 'unavailable') { setText(this.catalog.title, 'Node catalog (unavailable)'); patchContent(body, h('div.banner.warn.small', 'Your node catalog could not be read when this run was created: ', cat.problem, '. The agent was told that your expectations are not known for this run.')); return }
    const same = given.filter(a => a.settings?.catalog?.state === 'supplied' && a.settings.catalog.sha256 === cat.sha256).length
    const t = cat.snapshot.templates
    setText(this.catalog.title, `Node catalog (${t.length} template${t.length === 1 ? '' : 's'}, as given)`)
    patchContent(body,
      h('p.muted.small', `Frozen when the run was created (${when(cat.snapshot.taken)}). Edits to your catalog since then do not reach this run. ${given.length ? `${same} of ${given.length} attempt${given.length === 1 ? '' : 's'} recorded receiving this snapshot (sha256 ${cat.sha256.slice(0, 12)}…).` : 'No attempt has begun yet.'}`),
      t.length ? h('ul.catalog-given', ...t.map(x => h('li', { dataset: { template: x.id, key: `t:${x.id}` } }, h('strong', x.name), ' ', h('code', x.id), h('span.muted.small', ` ${x.type}, revision ${x.revision}`), h('div.small.expectation', h('span.muted', 'Expects: '), x.expectation))))
        : h('p.muted.small', 'Your catalog was empty: the agent was told you named no activity you expect as its own node.'))
  }

  // A run's delegations (p10): each child where it lives, whose move it is,
  // what it asked, what it delivered and how this run judged it. A child's
  // own work is read in the child's run view, never copied here.
  private updateDelegations(rec: RunRecord) {
    const v = this.data.delegView
    const all = v?.delegations ?? []
    show(this.delegations.root, !this.data.rev && all.length > 0)
    if (this.data.rev || !all.length) return
    const attention = all.some(d => d.pending.length)
    setText(this.delegations.title, `Delegations (${all.length})${attention ? ' — the agent has facts to take up' : ''}`)
    this.attend(this.delegations, attention ? 'warn' : null)
    patchContent(this.delegations.content.children[0] as HTMLElement, ...all.map(d => this.delegationCard(d, false)))
    void rec
  }

  private delegationCard(d: DelegationView, compact: boolean): HTMLElement {
    const childHref = d.child ? `#/ws/${encodeURIComponent(d.child.workspace)}/run/${encodeURIComponent(d.child.workflow)}/${encodeURIComponent(d.child.run)}` : null
    const links = d.childNow?.links
    const a = (label: string, url: string | null | undefined) => (url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, label) : null)
    const linkRow = [childHref ? h('a', { href: childHref }, 'child run view') : null, a('conversation', links?.conversation), a('progress', links?.progress), a('detailed IO', links?.io)].filter(Boolean)
    const next = d.closed ? 'nobody (closed)' : d.disposition ? 'nobody (judged)' : d.pending.length ? `${d.requester}: take up ${d.pending.map(n => `#${n}`).join(', ')}` : d.childNow?.waiting.length ? `the child: ${d.childNow.waiting.map(w => `${w.node} waits for ${w.holder}`).join('; ')}` : d.child ? `the child (${d.childNow?.situation ?? 'its record cannot be read here'})` : 'the delivery of the request'
    const result = [...d.events].reverse().find(e => e.type === 'completed')?.manifest
    const questions = d.events.filter(e => e.type === 'question')
    return h('div.delegation', { dataset: { key: `dl:${d.id}`, delegation: d.id, state: d.state } },
      h('div.row.tight', h('strong', `${d.id} · ${d.node} → ${d.target.project}/${d.target.workflow}`), chip(d.state, d.state)),
      h('p.small', d.child ? `Child: ${d.child.project} ${d.child.workflow}/${d.child.run}${d.childNow ? ` — ${childWords(d.childNow.situation)}` : ''}` : 'No child yet: the request is being delivered to that workflow\'s channel.'),
      linkRow.length ? h('p.small.dl-links', ...linkRow.flatMap((l, i) => (i ? [' · ', l!] : [l!]))) : null,
      h('p.small', h('span.muted', 'Next move: '), next),
      compact ? null : h('p.small.muted', `Requested by ${d.requester}${d.onBehalfOf ? ` for ${d.onBehalfOf}` : ''}; the child's result is accepted by ${d.accepts === 'parent' ? 'this run\'s agent' : 'the person'}.${d.predecessor ? ` Replaces ${d.predecessor}.` : ''}`),
      questions.length ? h('ul.small.dl-questions', ...questions.map(q => h('li', `${q.question}${q.confirms ? ' (confirm the result)' : q.plan ? ' (agree the plan)' : ''}: ${q.text}`, q.takenUp ? h('span.muted', ` — taken up; ${d.answers.filter(x => x.question === q.question).map(x => `answered “${x.text.slice(0, 80)}” (${x.from})`).join('; ') || 'not answered yet'}`) : h('span.warn-text', ' — not taken up yet')))) : null,
      result ? h('div.small.dl-result', h('span.muted', `Result (${result.digest.slice(7, 19)}): `), result.outcome || result.execution, result.decision ? h('span.muted', ` · the child's decision: ${result.decision.decision} by ${result.decision.by}`) : null,
        h('ul', ...[...(result.report ? [result.report] : []), ...result.artifacts].map(f => h('li', h('code', f.path), h('span.muted', ` ${f.bytes} B · ${f.sha256.slice(0, 12)}`))))) : null,
      d.disposition ? h(`p.small.${d.disposition.kind === 'satisfied' ? 'ok-text' : 'warn-text'}`, `Judged ${d.disposition.kind} by ${d.disposition.by}: ${d.disposition.note}`) : d.closed ? h('p.small.muted', d.closed.reason) : null)
  }

  private updateRelated(r: RunResponse, rec: RunRecord) {
    const wsId = this.data.wsId
    const input = rec.input
    const parent = this.data.delegView?.parent
    const rel = [
      r.predecessor ? h('div', 'Predecessor: ', h('a', { href: runHash(wsId, r.predecessor.ref) }, r.predecessor.ref)) : null,
      // A delegated child (p10): the run that asked for it.
      parent ? h('div', 'Delegated by: ', parent.workspace ? h('a', { href: runHash(parent.workspace, `${parent.parent.workflow}/${parent.parent.run}`) }, `${parent.parent.project} ${parent.parent.workflow}/${parent.parent.run}`) : `${parent.parent.project} ${parent.parent.workflow}/${parent.parent.run}`, h('span.muted', ` (node ${parent.parent.node})`)) : null,
      input.kind === 'request' && input.entrustedBy ? h('div.small', 'Entrusted by: ', input.entrustedBy.kind === 'run' ? h('a', { href: runHash(wsId, runKey(input.entrustedBy)) }, `${runKey(input.entrustedBy)}${input.entrustedBy.node ? ` node ${input.entrustedBy.node}` : ''}`) : input.entrustedBy.kind === 'file' ? input.entrustedBy.path : input.entrustedBy.kind === 'delegation' ? `delegation from ${input.entrustedBy.parent.project}/${input.entrustedBy.parent.workflow}/${input.entrustedBy.parent.run} (node ${input.entrustedBy.parent.node})` : input.entrustedBy.text) : null,
    ].filter((x): x is HTMLDivElement => !!x)
    show(this.related.root, rel.length > 0)
    if (!rel.length) return
    setText(this.related.title, 'Related runs')
    patchContent(this.related.content.children[0] as HTMLElement, ...rel)
  }

  private updateFiles(r: RunResponse) {
    // Recorded artifacts outside the run folder; the folder's own files are listed above.
    const recorded = r.artifacts.filter(a => !(a.path.startsWith(`${r.dir}/`) && !a.path.slice(r.dir.length + 1).includes('/')))
    const missing = recorded.filter(a => !a.exists).length
    setText(this.files.title, `Reports and files (${r.files.length}${missing ? `, ${missing} missing` : ''})`)
    this.attend(this.files, missing ? 'warn' : null)
    patchContent(this.files.content.children[0] as HTMLElement,
      h('p.small.muted', `${r.dir}/ — open these in VS Code to edit; here they are read-only.`),
      h('ul.files', ...r.files.map(f => h('li', { dataset: { key: `f:${f.name}` } }, fileLink(f.name), h('span.muted.small', ` ${f.size} B${f.modified ? ` · ${ago(f.modified)}` : ''}`)))),
      recorded.length ? h('h4', 'Recorded artifacts') : null,
      recorded.length ? h('ul.files', ...recorded.map(a => h('li', { dataset: { key: `a:${a.path}` } }, a.exists ? fileLink(a.path) : h('span', a.path), a.exists ? null : h('span.chip.error', 'missing')))) : null)
    this.updateFileView()
  }

  // The open file keeps its scroll container for as long as it is open.
  private updateFileView() {
    const fv = this.fileView
    const v = this.data.viewing
    show(this.fileCard, !!v)
    if (!v) { fv.path = ''; return }
    if (v.path !== fv.path) {
      fv.path = v.path
      patchContent(fv.head, h('strong', v.path), h('button.icon-btn', { 'aria-label': 'Close the file', dataset: { action: 'close-file' } }, '×'))
      fv.pre.textContent = ''
      fv.pre.scrollTop = 0; fv.pre.scrollLeft = 0
    }
    // A read error after content was shown is reported beside it, never by blanking it.
    setText(fv.status, v.error ? `${v.text !== undefined ? 'Could not read it again' : 'Could not read it'}: ${v.error}` : v.text === undefined ? 'Loading…' : '')
    const cls = v.error ? 'small error' : 'small muted'
    if (fv.status.className !== cls) fv.status.className = cls
    show(fv.status, !!v.error || v.text === undefined)
    show(fv.pre, v.text !== undefined)
    if (v.text !== undefined && fv.pre.textContent !== v.text) {
      // The same file changed: its offsets stay, clamped to the new content.
      const { scrollTop, scrollLeft } = fv.pre
      fv.pre.textContent = v.text
      fv.pre.scrollTop = scrollTop
      fv.pre.scrollLeft = scrollLeft
    }
  }

  // What runs, what waits and what is published: the record's control state
  // with this host's facts (process, queue, checkpoints) beside it.
  private updateExecution(rec: RunRecord) {
    const d = this.data
    show(this.execution.root, !d.rev)
    if (d.rev) return
    const sit = situation(rec)
    const ev = d.execView
    const problems = (ev?.checkpoints ?? []).filter(c => c.state === 'failed' || c.state === 'attention').length
    setText(this.execution.title, `Execution and publication${d.execError ? ' (host facts unavailable)' : problems ? ` (${problems} publication problem${problems === 1 ? '' : 's'})` : rec.control.hold ? ' (held)' : ''}`)
    this.attend(this.execution, problems ? 'error' : d.execError || rec.control.hold ? 'warn' : null)
    const open = ev?.attempts.find(a => a.state !== 'ended')
    const SIT: Record<string, string> = {
      executing: 'Executing', stopping: 'Stop requested — waiting for the process to end', 'awaiting-person': 'Awaiting a person — no process runs meanwhile',
      stopped: 'Stopped (held) — its work is kept; resumes only when you resume it', interrupted: 'Interrupted — a recovery agent or you look at the working tree, then continue it', unknown: 'Unknown — the process was lost; a recovery agent or you look, then continue it',
      completed: 'Completed', cancelled: 'Cancelled', 'not-started': 'Not started', idle: 'Idle',
    }
    const process = open ? (open.alive === true ? `process ${open.pid} alive` : open.alive === false ? (open.pid ? `process ${open.pid} not seen alive` : 'launching') : 'process on another host') : ''
    const frozen = this.frozen || !!rec.cancelled
    patchContent(this.execution.content.children[0] as HTMLElement,
      h('div.row.tight', h(`span.chip.sit-${sit}`, SIT[sit] ?? sit), process ? h('span.muted.small', process) : null),
      rec.control.hold ? h('p.small', `Held (${rec.control.hold.kind}) since ${when(rec.control.hold.since)} by ${rec.control.hold.by}${becauseText(rec.control.hold.because)}: ${sentence(rec.control.hold.reason)} Its work is kept in its own copy; other requests can run meanwhile.${rec.control.hold.kind === 'stopped' ? '' : ' Observer takes an interrupted run to a recovery agent, which may continue it (wfe run recover).'} `, h('a', { href: '#', dataset: { action: 'goto-resume' } }, 'Resume with an instruction')) : null,
      // Recoveries (observer p3): who continued the run, for which incident.
      ...(rec.recoveries ?? []).slice(-3).map(r => h('p.small.muted', `Continued by recovery: ${r.by}${r.agent ? ` (${r.agent.workflow}/${r.agent.run})` : ''}, ${when(r.at)}, incident ${r.incident}, after attempt ${r.attempt} (${r.lifted ?? 'continuation nothing had queued'}): ${sentence(r.reason)}`)),
      d.execError ? h('div.banner.warn', `Execution facts of this host could not be read: ${d.execError}`) : null,
      ev ? h('p.small.muted', `Executor: ${ev.executor.state}${ev.executor.detail ? ` — ${ev.executor.detail}` : ''}`) : null,
      this.sessionLine(rec),
      // Where the run's work is kept (p9, docs/storage.md).
      d.resp?.place?.kind === 'run-copy' ? h('p.small.muted.run-place', `Work: this run's own copy of the project, saved to branch ${d.resp.place.branch ?? '(unknown)'} — not on the project's shared branch until it is integrated.`) : null,
      h('div.row.tight', h('button', { disabled: frozen || !!rec.control.hold || !!rec.control.stop || sit === 'completed', title: STOP_TITLE, dataset: { action: 'stop-run' } }, 'Stop')))
    const queued = ev?.jobs.filter(j => j.state === 'queued' || j.state === 'claimed') ?? []
    patchContent(this.execMore,
      queued.length ? h('p.small', 'Queued: ', ...queued.map(j => `${j.kind} (${j.state}) — ${j.reason}`)) : null,
      ev?.attempts.length ? h('h4', `Attempts (${ev.attempts.length})`) : null,
      ev?.attempts.length ? h('ul.attempts', ...ev.attempts.slice().reverse().map(a => h('li.small', { dataset: { key: `at:${a.id}` } },
        h('code', a.id), ` ${a.state === 'ended' ? `${a.outcome}${a.exit_code !== null ? ` (exit ${a.exit_code})` : a.signal ? ` (${a.signal})` : ''}` : a.state}`,
        h('span.muted', ` · ${when(a.began)}${a.ended ? ` → ${when(a.ended)}` : ''}${a.backend ? ` · ${a.backend}` : ''}${a.stop_requested ? ' · stop requested' : ''}`),
        h('span.muted.attempt-session', sessionOfAttempt(rec, a.id)),
        h('span.muted.attempt-activity', a.activity === undefined ? '' : a.activity === null ? ' · activity observed on its host only' : a.activity.problem ? ` · output cannot be read (${a.activity.problem})` : a.activity.unit === 'turn' ? ` · ${a.activity.count} turn${a.activity.count === 1 ? '' : 's'}${a.activity.last ? `, last output ${when(a.activity.last)}` : ''}` : a.activity.last ? ` · output last written ${when(a.activity.last)} (not counted: not stream-json)` : ' · no output')))) : null,
      ev?.checkpoints.length ? h('h4', 'Publication') : null,
      ...(ev?.checkpoints ?? []).slice().reverse().slice(0, 6).map(c => h('div.checkpoint.small', { dataset: { key: `cp:${c.id}` } },
        h(`span.chip.${c.state === 'published' || c.state === 'nothing' ? 'ok' : c.state === 'pending' ? 'muted' : 'warn'}`, c.state === 'nothing' ? 'nothing to publish' : c.state), ` ${c.kind}`,
        ...c.steps.map(st => h('div.muted', `${st.repo === '.' ? 'root' : st.repo}: ${st.commit ? `${st.commit.slice(0, 7)} ${st.pushed ? `pushed to ${st.branch}` : 'not pushed'}` : 'no commit'}${st.excluded.length ? `; left out (already changed before): ${st.excluded.join(', ')}` : ''}${st.conflicts.length ? `; needs you: ${st.conflicts.join(', ')} changed before the run and again by it` : ''}${st.error ? `; ${st.error}` : ''}`)),
        c.error ? h('div.error', c.error) : null,
        c.state === 'failed' || c.state === 'attention' ? h('button', { dataset: { action: 'retry-checkpoint', checkpoint: String(c.id) } }, 'Retry publication') : null)),
      ...this.integrationBlock(rec))
  }

  // The run's frozen session policy and its sessions (agent_session p1):
  // which conversation is current, how many attempts it served, and why an
  // earlier one was replaced or retired. Transcripts stay on the host.
  private sessionLine(rec: RunRecord): HTMLElement | null {
    const wf = this.data.resp?.bundle?.[rec.definition.root]?.workflow
    const policy = sessionPolicyOf(wf?.execution)
    const all = rec.sessions ?? []
    const cur = all.at(-1)
    const ended = all.filter(x => x.state !== 'open').slice(-3)
    return h('div.small.muted.run-session', { dataset: { policy } },
      h('div', `Session policy: ${policy === 'run' ? 'run — later attempts resume the run\'s session' : 'fresh — a new session every attempt'}${wf?.execution?.session ? '' : ' (not declared)'}.`,
        cur ? ` Current: ${cur.state === 'open' ? '' : `none (last ${cur.state}) — `}${shortSession(cur.id)}, ${cur.attempts.length} attempt${cur.attempts.length === 1 ? '' : 's'}.` : ' No session recorded yet.'),
      ...ended.map(x => h('div.session-ended', `${x.state === 'retired' ? 'Retired' : 'Replaced'}: ${shortSession(x.id)} (${x.attempts.length} attempt${x.attempts.length === 1 ? '' : 's'}) — ${x.ended?.reason ?? ''}`)),
      cur?.mismatch ? h('div.warn', `The harness reported session ${cur.attached}, not the intended ${cur.id}.`) : null)
  }

  // Integration of the accepted result into the project's branches (p9):
  // where it stands, each repository's step, and the person's operations.
  private integrationBlock(rec: RunRecord): (HTMLElement | null)[] {
    const d = this.data
    const st = integrationStatus(rec, d.execView, d.resp?.place)
    if (!st) return []
    const di = rec.decisions.length - 1
    const row = d.execView?.integrations?.filter(i => i.decision === di).at(-1)
    const accepted = rec.decisions[di]?.decision === 'accepted'
    const done = (rec.integrations ?? []).some(i => i.decision === di)
    // A result changed since its acceptance is accepted again, not retried (project_migration p3/ex1).
    const can = accepted && !done && st.state !== 'integrated' && st.state !== 'needs-agreement' && st.state !== 'target-changed' && st.state !== 'unbound' && rec.execution.state === 'completed' && !rec.control.attempt && !this.frozen
    return [
      h('h4', 'Integration'),
      h('p.small', h(`span.chip.${st.tone === 'ok' ? 'ok' : st.tone === 'muted' ? 'muted' : 'warn'}`, st.text), st.detail ? h('span.muted', ` ${st.detail}`) : null),
      h('p.small.muted', 'Saving puts the run\'s work on its own branch; integrating brings an accepted result into the project\'s shared branches. They are separate steps.'),
      // Abandonment and reversal (p9): facts, not an operation.
      h('p.small.muted.reversal-note', done
        ? `Undoing it is new work: a run that names this one as its predecessor and reverts the integrated commits with new ones (wfe run reversal ${runKey(rec)} lists them); later changes stay, and effects outside Git need their own check.`
        : 'Nothing of it is on the project\'s shared branches: cancelling or abandoning it needs no rollback, and its work stays on its own branch.'),
      ...(row?.steps ?? []).map(x => h('div.small.muted', { dataset: { key: `int:${row!.id}:${x.repo}` } }, `${x.repo === '.' ? 'root' : x.repo} → ${x.target}: ${x.state}${x.method ? ` (${x.method})` : ''}${x.result ? ` ${x.result.slice(0, 7)}${x.pushed ? ' pushed' : ''}` : ''}${x.files?.length ? `; files: ${x.files.join(', ')}` : ''}${x.error ? `; ${x.error}` : ''}`)),
      st.state === 'needs-agreement' || st.state === 'unbound' ? h('p.small.warn-text', 'Accept the result again in the card at the top of the run; its integration is queued then.') : null,
      st.state === 'target-changed' ? h('p.small.warn-text', 'A guarded target changed after this run prepared its result. Request a successor run (this one as predecessor) to reassess against the current target.') : null,
      can ? h('div.row.tight', h('button', { dataset: { action: 'integrate-check' }, title: 'Combine locally and show what would happen; nothing is pushed' }, 'Check integration'),
        h('button', { dataset: { action: 'integrate-run' }, title: 'Bring the accepted result into the shared branches now' }, row && row.state !== 'queued' ? 'Retry integration' : 'Integrate now')) : null,
    ]
  }

  // Where this run's progress is announced, and what is still owed there.
  // A delivery problem never changes the run's own state.
  private updateCoordination() {
    const v = this.data.notifyView
    show(this.coordination.root, !this.data.rev && !!v)
    if (this.data.rev || !v) return
    setText(this.coordination.title, `Coordination (Zulip)${v.failed || v.problem ? ' — needs attention' : !v.configured ? ' — not configured' : ''}`)
    this.attend(this.coordination, v.failed || v.problem ? 'error' : v.uncertain ? 'warn' : null)
    const body = this.coordination.content.children[0] as HTMLElement
    if (!v.configured) { patchContent(body, h('p.small.muted', `Not announced: Zulip coordination is not configured on this host${v.problem ? ` (${v.problem})` : ''}.`)); return }
    patchContent(body,
      v.skipped ? h('p.small.muted', `Not announced: ${v.skipped}.`) : null,
      v.request ? h('p.small', 'Request and conversation: ', v.request.url ? h('a', { href: v.request.url, target: '_blank', rel: 'noopener' }, `${v.request.channel} › ${v.request.topic}`) : `${v.request.channel} › ${v.request.topic}`, h('span.muted', ' — questions are answered there')) : null,
      v.topic ? h('p.small', v.request ? 'Progress: ' : 'Topic: ', v.topic.url ? h('a', { href: v.topic.url, target: '_blank', rel: 'noopener' }, `${v.topic.channel} › ${v.topic.topic}`) : `${v.topic.channel} › ${v.topic.topic}`) : h('p.small.muted', 'No message sent yet.'),
      h(`p.small${v.failed ? '.error' : ''}`, `Delivery: ${v.pending} pending, ${v.failed} waiting for a retry${v.lastSent ? ` · last sent ${ago(v.lastSent)}` : ''}`),
      v.uncertain ? h('p.small.warn', 'A message may already have been posted; it is looked for in Zulip before any retry (wfe notify deliveries).') : null,
      v.lastError ? h('p.small.error', `Last error: ${v.lastError}`) : null,
      v.provisioning ? h('p.small.warn-text', `Channel: ${v.provisioning}`) : null,
      v.problem ? h('div.banner.error.small', `${v.problem}`) : null,
      !v.viewBase && !v.request ? h('p.small.muted', 'No remote address of this view is configured: messages tell readers to answer on the execution host.') : null)
  }

  private updateResult(rec: RunRecord) {
    show(this.result.root, !this.data.rev)
    if (this.data.rev) return
    const last = rec.decisions.at(-1)
    setText(this.result.title, `Result and decision${last ? ` (${last.decision})` : ''}`)
    const completed = rec.execution.state === 'completed'
    patchContent(this.result.content.children[0] as HTMLElement,
      ...rec.decisions.map((d, i) => h(`div.banner.${d.decision === 'accepted' ? 'ok' : 'error'}`, { dataset: { key: `d:${i}` } }, `${d.decision} by ${d.by} (${when(d.at)}) — evidence: ${d.evidence}${d.note ? ` — ${d.note}` : ''}`)),
      h('p.small.muted', completed
        ? (this.decide.root.parentElement === this.decideSlot ? 'Execution completed: every node recorded completion. Accepting the result is your separate decision (offered above).'
          : this.approval && !this.approval.canAccept && rec.decisions.at(-1)?.decision === 'accepted' ? 'Execution completed and the result is accepted: nothing more to accept unless the result changes.'
            : 'Execution completed: every node recorded completion. Accepting the result is your separate decision.')
        : `Execution is ${rec.execution.state}. A result can be accepted once every node is completed; it can be rejected, or the run cancelled, at any time.`))
    this.updateDecideButtons()
  }

  // Acceptance is offered only when it would record something new: no
  // decision yet, a rejection, or a result changed since the last acceptance
  // (project_migration p3/ex1: an accepted result offered Accept again).
  private updateDecideButtons() {
    const rec = this.data.shown?.record
    const off = this.frozen || this.decide.busy || this.decide.evidence.sending || !rec
    const appr = this.approval
    const can = !appr || appr.canAccept
    show(this.decide.accept, can)
    setText(this.decide.accept, appr?.kind === 'reaccept' ? 'Accept the changed result' : 'Accept result')
    const ph = appr?.kind === 'reaccept' ? 'what you checked (optional for a renewed acceptance)' : 'evidence: what you checked (report, commit, demo…)'
    if (this.decide.evidence.el.placeholder !== ph) this.decide.evidence.el.placeholder = ph
    setDisabled(this.decide.accept, off || rec!.execution.state !== 'completed' || !can)
    setDisabled(this.decide.reject, off)
    setDisabled(this.decide.cancel, off || !!rec!.cancelled)
  }

  // Newest first; every entry keeps its element while it exists.
  private updateHistory(rec: RunRecord) {
    const shownKey = `${rec.seq}:${rec.history.length}`
    if (shownKey === this.historyShown) return
    this.historyShown = shownKey
    const history = rec.history.slice().reverse()
    setText(this.history.title, `History (${history.length})`)
    patchContent(this.history.content.children[0] as HTMLElement, ...history.map(e => {
      const d = e as unknown as Record<string, unknown>
      const moves = Object.entries(e.change.nodes ?? {}).map(([n, [a, b]]) => `${n}: ${a ?? '—'} → ${b}`)
      if (e.change.execution) moves.push(`run: ${e.change.execution[0] ?? '—'} → ${e.change.execution[1]}`)
      const detail = (d.reason ?? d.outcome ?? d.text ?? d.evidence ?? d.external ?? d.path ?? '') as string
      return h('li', { value: e.seq, dataset: { key: `h:${e.seq}` } }, h('div', h('code', e.op), ` ${d.node ? `${d.node} ` : ''}${d.question ? `${d.question} ` : ''}`, h('span.muted.small', `· ${e.by} via ${e.via} · ${when(e.at)}`)),
        moves.length ? h('div.small', moves.join('; ')) : null, detail ? h('div.small.muted', detail.split('\n')[0].slice(0, 200)) : null)
    }))
  }
}

const docLink = (path: string, label: string) => { const a = fileLink(path, label); a.classList.add('focus-link'); a.prepend(icon('doc', 'icon small')); return a }
const questionChip = (st: string) => (st === 'open' ? 'waiting' : st === 'answered' ? 'running' : st === 'taken-up' ? 'completed' : 'cancelled')

// agent_session p1: a session id, shortened for display (the full id is in
// wfe run session <run>).
function shortSession(id: string | null): string { return id ? `session ${id.slice(0, 8)}` : 'session (id not reported)' }
function sessionOfAttempt(rec: RunRecord, attempt: string): string {
  const x = (rec.sessions ?? []).find(s => s.attempts.includes(attempt))
  if (!x) return ''
  return ` · ${shortSession(x.id)}${x.attempt === attempt ? ' (new)' : ' (resumed)'}`
}
