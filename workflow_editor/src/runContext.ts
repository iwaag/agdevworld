// A run's context in its primary view (workflow_editor p13 ex1): what the
// run was asked, what it was told since, what the current attempt was
// given, what the next attempt would get with today's settings, and where
// those settings are changed. Shown in both modes; Detail adds every
// attempt, the exact texts and the provenance.
//
// - The request is the run's input file, read once and never edited here.
// - "Add an instruction" records the existing instruction.receive op (the
//   record a post in the request conversation or `wfe run instruct`
//   makes): once, for this run, read by the executor at its next step.
// - "Settings for future attempts" are the local context blocks (p14) of
//   the workflow, the project and all projects, edited in place with the
//   same cards as the editors use. A save changes no attempt and sends
//   nothing to the run; the next-attempt comparison is read again after it
//   and names each block that differs.
import type { RunRecord } from '../shared/run.ts'
import type { ContextSource } from '../shared/context.ts'
import { api, type RunContextView } from './api.ts'
import { append, h, when } from './dom.ts'
import { icon } from './icons.ts'
import { BlockList, fitRows, scopeWords } from './contextParts.ts'
import type { OpResult } from './runSide.ts'

export interface RunContextDeps {
  wsId: string
  workflow: string
  run: string
  historical: boolean // a past reading (#…/at/<commit>): nothing is recorded from it
  actor: () => string
  setActor: (name: string) => void
  record: (op: Record<string, unknown> & { op: string }, done: string) => Promise<OpResult>
}

const CHANGE_WORD: Record<string, string> = { added: 'added', removed: 'removed', changed: 'changed', delivery: 'delivery changed' }
const SCOPE_OF: Record<string, string> = { system: 'All projects', project: 'Project', workflow: 'Workflow', run: 'Run' }
const scopeLabel = (s: Pick<ContextSource, 'scope' | 'category' | 'kind' | 'title' | 'origin' | 'block'>) =>
  s.kind === 'block' ? `${SCOPE_OF[s.scope]} ${s.block?.kind === 'information' ? 'environment information' : 'instruction'}: ${s.title}${s.block ? ` (managed by ${s.block.manager})` : ''}`
  : s.kind === 'override' ? (s.scope === 'system' ? 'Instructions for all projects' : s.scope === 'project' ? 'Instructions for the project' : 'Instructions for the workflow')
    : s.kind === 'intent' ? (s.scope === 'project' ? 'Project purpose and goals' : 'Workflow purpose')
      : s.kind === 'guide' ? `${s.scope === 'project' ? 'Project' : 'Workflow'} guide ${s.origin.file ?? s.title.replace(/^guide /, '')}`
        : s.kind === 'contract' ? 'Common execution contract' : s.title

export class RunContextCard {
  readonly el: HTMLElement
  private readonly deps: RunContextDeps
  private readonly toggle: HTMLButtonElement
  private readonly summary = h('span.ctx-summary')
  private readonly body = h('div.ctx-body')
  private readonly requestBox = h('div.run-request')
  private readonly instructionsBox = h('div.run-instructions')
  private readonly usedBox = h('div.run-used')
  private readonly nextBox = h('div.run-next')
  private readonly settingsBox = h('div.run-settings')
  private readonly detailBox = h('details.run-ctx-detail.d-only')
  private readonly form: { root: HTMLElement; ta: HTMLTextAreaElement; send: HTMLButtonElement; name: HTMLInputElement; status: HTMLElement; note: HTMLElement }
  private readonly editors = new Map<string, { list: BlockList; box: HTMLElement; button: HTMLButtonElement }>()
  private rec: RunRecord | null = null
  private view: RunContextView | null = null
  private viewError = ''
  private viewKey = '' // the attempts the comparison was read for
  private request: { text?: string; error?: string } | null = null
  private sending = false
  private disposed = false

  constructor(deps: RunContextDeps) {
    this.deps = deps
    this.toggle = h('button.ctx-toggle', { type: 'button', 'aria-expanded': 'false', onclick: () => this.setOpen(this.body.hidden === true) },
      icon('caret', 'icon small ctx-caret'), h('span.ctx-title', 'Context'), this.summary) as HTMLButtonElement
    const ta = h('textarea', { rows: 2, placeholder: 'What this run should do differently, from its next step on.', 'aria-label': 'Instruction for this run' }) as HTMLTextAreaElement
    ta.addEventListener('input', () => { fitRows(ta, 2, 8); this.renderForm() })
    const send = h('button.primary', { type: 'button', onclick: () => void this.send() }, 'Send to this run') as HTMLButtonElement
    const name = h('input.ctx-by', { 'aria-label': 'Instruction author', placeholder: 'your name', size: 12, oninput: () => this.deps.setActor(name.value.trim()) }) as HTMLInputElement
    this.form = { root: h('div.run-instruct-form', h('label.ctx-label', { htmlFor: `run-instruct-${deps.run}` }, 'Add an instruction for this run'), ta, h('div.row.tight', send, h('label.small.ctx-by-label', 'as ', name)), h('p.small.muted', 'Recorded once in this run, with your name; the agent reads it at its next step. It is not a preference for other runs.')), ta, send, name, status: h('div.ctx-status'), note: h('p.small.muted') }
    ta.id = `run-instruct-${deps.run}`
    this.form.root.append(this.form.status)
    this.body.hidden = true
    this.body.append(
      h('div.ctx-group', h('h3', 'Original request', h('span.small.muted', ' — as given; it does not change')), this.requestBox),
      h('div.ctx-group', h('h3', 'Instructions for this run', h('span.small.muted', ' — recorded in the run')), this.instructionsBox, this.form.note, this.form.root),
      h('div.ctx-group', h('h3', 'Used for this attempt'), this.usedBox),
      h('div.ctx-group', h('h3', 'Changes for the next attempt'), this.nextBox),
      h('div.ctx-group', h('h3', 'Settings for future attempts', h('span.small.muted', ' — preferences, not messages to this run')), this.settingsBox),
      this.detailBox)
    this.el = h('section.ctx-section.run-context', { dataset: { contextScope: 'run' }, 'aria-label': 'Context of this run' }, h('div.ctx-head', this.toggle), this.body)
    this.toggle.setAttribute('aria-controls', this.body.id = `run-ctx-${deps.run}`)
    try { if (localStorage.getItem('workflow-editor.run-context-open') === '1') this.setOpen(true, false) } catch { /* per-viewer convenience only */ }
    this.renderSettings()
  }

  get isOpen() { return !this.body.hidden }
  setOpen(open: boolean, remember = true) {
    this.body.hidden = !open
    this.toggle.setAttribute('aria-expanded', String(open))
    this.el.classList.toggle('open', open)
    if (remember) try { localStorage.setItem('workflow-editor.run-context-open', open ? '1' : '0') } catch { /* per-viewer convenience only */ }
  }
  reveal(focus?: 'instruct') {
    this.setOpen(true)
    this.el.scrollIntoView({ block: 'start' })
    if (focus === 'instruct' && !this.form.root.hidden) this.form.ta.focus({ preventScroll: true })
  }

  // Unsent instruction text or an unsaved preference.
  isDirty() { return this.form.ta.value.trim() !== '' || [...this.editors.values()].some(e => e.list.isDirty()) }

  // Every refresh of the run view: cheap; the comparison is read again only
  // when the attempts change (or on request).
  update(rec: RunRecord) {
    this.rec = rec
    if (!this.request && !this.deps.historical) void this.loadRequest(rec)
    const key = `${rec.history.filter(e => e.op === 'attempt.begin' || e.op === 'attempt.context').length}:${rec.control.attempt?.id ?? ''}`
    if (!this.deps.historical && key !== this.viewKey) { this.viewKey = key; void this.loadView() }
    if (document.activeElement !== this.form.name && this.form.name.value !== this.deps.actor()) this.form.name.value = this.deps.actor()
    this.renderRequest()
    this.renderInstructions()
    this.renderForm()
    this.renderUsed()
    this.renderNext()
    this.renderSummary()
  }

  private async loadRequest(rec: RunRecord) {
    this.request = {}
    try { this.request = { text: (await api.runFile(this.deps.wsId, this.deps.workflow, this.deps.run, rec.input.file)).text } } catch (e) { this.request = { error: (e as Error).message } }
    if (!this.disposed) { this.renderRequest(); this.renderSummary() }
  }

  async loadView() {
    try { this.view = await api.runContext(this.deps.wsId, this.deps.workflow, this.deps.run); this.viewError = '' } catch (e) { this.viewError = (e as Error).message }
    if (this.disposed) return
    this.renderUsed(); this.renderNext(); this.renderDetail(); this.renderSummary(); this.renderSettings()
  }

  // ---- request and instructions ----------------------------------------------

  private renderRequest() {
    const rec = this.rec
    if (!rec) return
    const who = rec.input.kind === 'braindump' ? `${rec.input.author}'s words` : `request by ${rec.input.requester}${rec.input.onBehalfOf ? ` on behalf of ${rec.input.onBehalfOf}` : ''}`
    const r = this.request
    const text = r?.text?.trim() ?? ''
    const lines = text.split('\n')
    const long = lines.length > 8 || text.length > 600
    this.requestBox.replaceChildren(
      h('p.small.muted', `${who} · ${when(rec.created)}`),
      this.deps.historical ? h('p.small.muted', 'Shown in the file list of this past reading.')
        : !r || (!r.text && !r.error) ? h('p.small.muted', 'Loading…')
          : r.error ? h('p.small.error-text', `Not read: ${r.error}`)
            : h('pre.ctx-text.run-request-text', long ? `${lines.slice(0, 8).join('\n').slice(0, 600)}…` : text),
      h('a.small', { href: '#', dataset: { action: 'file', path: rec.input.file } }, long ? 'Read the whole request' : `Open ${rec.input.file}`))
  }

  private renderInstructions() {
    const ins = Object.values(this.rec?.instructions ?? {})
    this.instructionsBox.replaceChildren(...(ins.length ? ins.slice().reverse().map(i => h('div.run-instruction', { dataset: { instruction: i.id } },
      h('div.ctx-src-head', h('strong', i.id), h(`span.chip${i.ack ? '.ok' : '.warn'}`, i.ack ? `acknowledged: ${i.ack.response}` : 'not acknowledged yet'), h('span.small.muted', `${i.from} · ${when(i.at)}${i.via ? ` · via ${i.via}` : ''}`)),
      h('pre.ctx-text', i.text),
      i.ack ? h('p.small.muted', `${i.ack.by}: ${i.ack.note}`) : null)) : [h('p.small.muted', 'None yet. Questions and answers are in the run\'s Conversation and its side pane.')]))
  }

  // Offered as the run's record allows it (instruction.receive): not on a
  // past reading, a cancelled run or a completed one.
  private renderForm() {
    const rec = this.rec
    const closed = !rec ? 'Loading…' : this.deps.historical ? 'This is a past reading of the run: nothing is recorded from it.' : rec.cancelled ? 'The run is cancelled: it takes no more instructions.' : rec.execution.state === 'completed' ? 'The run is completed: it takes no more instructions. Start a new request for further work.' : null
    this.form.root.hidden = closed !== null
    this.form.note.textContent = closed ?? ''
    this.form.note.hidden = closed === null
    this.form.send.disabled = this.sending || !this.form.ta.value.trim()
  }

  private async send() {
    const text = this.form.ta.value
    if (!text.trim() || this.sending) return
    if (!this.deps.actor().trim()) { this.say('error', 'Enter your name next to Send: the instruction records whose words it is.'); this.form.name.focus(); return }
    this.sending = true; this.renderForm(); this.say('pending', 'Recording…')
    const r = await this.deps.record({ op: 'instruction.receive', text, from: this.deps.actor().trim() }, 'Recorded in this run. The agent reads it at its next step; nothing else changed.')
    this.sending = false
    if (r.ok && this.form.ta.value === text) { this.form.ta.value = ''; fitRows(this.form.ta, 2, 8) }
    this.say(r.kind, r.text)
    this.renderForm()
  }
  private say(kind: OpResult['kind'] | 'pending', text: string) {
    this.form.status.replaceChildren(h(`div.banner.${kind === 'pending' ? 'warn' : kind}.small`, text))
  }

  // ---- attempts ---------------------------------------------------------------

  private renderUsed() {
    const v = this.view
    if (this.deps.historical) { this.usedBox.replaceChildren(h('p.small.muted', 'Not shown for a past reading; open the current run.')); return }
    if (!v) { this.usedBox.replaceChildren(h('p.small', this.viewError ? h('span.error-text', `Not read: ${this.viewError}`) : h('span.muted', 'Loading…'))); return }
    const att = v.attempts.at(-1)
    if (!att) { this.usedBox.replaceChildren(h('p.small', 'No attempt has started yet: nothing has been given to an agent.')); return }
    const state = att.snapshot
      ? (att.delivery?.event === 'delivered' ? `Prepared ${when(att.began)} and delivered to the agent.` : att.delivery?.event === 'undelivered' ? `Prepared ${when(att.began)}, but not delivered${att.delivery.detail ? `: ${att.delivery.detail}` : ''}.` : `Prepared ${when(att.began)}; its delivery is not recorded.`)
      : att.recorded ? `Prepared ${when(att.began)}, but its exact context is unavailable: ${att.unavailable}.`
        : `Started ${when(att.began)}, before context was recorded: only its guides are known.`
    const sources = att.snapshot?.sources.filter(s => s.scope !== 'run' && s.kind !== 'contract' && s.delivery !== 'absent') ?? []
    this.usedBox.replaceChildren()
    append(this.usedBox, [
      h('p.small', h('strong', `Attempt ${att.attempt}`), ' — ', state),
      sources.length ? h('ul.run-ctx-sources', ...sources.map(s => h('li', h('span', scopeLabel(s)), s.delivery === 'error' ? h('span.small.error-text', ' — unreadable') : s.delivery === 'reference' ? h('span.small.muted', ' — named') : null))) : null,
      att.snapshot ? h('details.ctx-src-text', h('summary.small', 'The exact text it was given'), h('pre.ctx-rendered', att.snapshot.rendered)) : null,
      v.attempts.length > 1 ? h('p.small.muted.d-only', `Earlier attempts: in "Every attempt" below.`) : null])
  }

  private renderNext() {
    const v = this.view
    if (this.deps.historical || !v) { this.nextBox.replaceChildren(); return }
    const ch = v.changes.filter(c => !c.key.startsWith('run/') && c.key !== 'system/contract')
    const title = (key: string, fallback?: string) => { const s = v.next.sources.find(x => x.key === key); return s ? scopeLabel(s) : fallback ?? key }
    const started = v.attempts.length > 0
    this.nextBox.replaceChildren(
      !started ? h('p.small', 'The first attempt will be prepared with the current settings.')
        : ch.length ? h('div', h('p.small.warn-text', icon('alert', 'icon small'), ` Settings changed since attempt ${v.attempts.at(-1)!.attempt}. The next attempt gets:`),
          h('ul.run-ctx-changes', ...ch.map(c => h(`li.ctx-${c.change}`, h(`span.pill.ctx-change-${c.change}`, CHANGE_WORD[c.change] ?? c.change), ' ', title(c.key, c.title)))))
          : h('p.small', 'No changes: the next attempt gets the same instructions.'),
      h('p.small.muted', 'This attempt keeps what it was given. Saved settings apply from the next attempt; nothing is started by saving.'),
      h('p.small.muted.d-only', `Session: ${v.session.next}`),
      h('details.ctx-src-text', h('summary.small', 'The text the next attempt would get'), h('pre.ctx-rendered', v.nextRendered)))
  }

  // ---- settings for future attempts ------------------------------------------------

  private renderSettings() {
    const project = this.view?.next.project ?? null
    const targets: { key: string; label: string; target: { scope: 'workflow' | 'project' | 'system'; project?: string; workflow?: string } | null }[] = [
      { key: 'workflow', label: 'Workflow context', target: project ? { scope: 'workflow', project, workflow: this.deps.workflow } : null },
      { key: 'project', label: 'Project context', target: project ? { scope: 'project', project } : null },
      { key: 'system', label: 'Context for all projects', target: { scope: 'system' } },
    ]
    if (this.deps.historical) { this.settingsBox.replaceChildren(h('p.small.muted', 'Open the current run to change settings.')); return }
    const row = h('div.row.tight.run-settings-buttons')
    const boxes: HTMLElement[] = []
    for (const t of targets) {
      if (!t.target) continue
      let e = this.editors.get(t.key)
      if (!e) {
        const target = t.target
        const list = new BlockList(target, { wider: true, empty: 'Nothing set here.', onChange: () => this.renderSummary(), onSaved: () => void this.loadView() })
        const hint = h('p.small.muted.ctx-hint', `Applies to future attempts of ${target.scope === 'workflow' ? `every run of workflow ${this.deps.workflow}` : scopeWords(target)}, this run included, and to new runs. The attempt in progress keeps what it was given; saving starts nothing and sends nothing to this run. To steer this run now, add an instruction above.`)
        const box = h('div.ctx-wider', { hidden: true, dataset: { settings: t.key } }, h('div.ctx-group-head', hint, list.addControl), list.el)
        const button = h('button', { type: 'button', 'aria-expanded': 'false', onclick: () => { box.hidden = !box.hidden; button.setAttribute('aria-expanded', String(!box.hidden)); button.classList.toggle('active', !box.hidden); if (!box.hidden) void list.refresh() } }, t.label) as HTMLButtonElement
        e = { list, box, button }
        this.editors.set(t.key, e)
      }
      row.append(e.button)
      boxes.push(e.box)
    }
    this.settingsBox.replaceChildren(row, ...boxes,
      h('p.small.muted', 'The workflow\'s and the project\'s shared purpose and guides are edited in their editors: ',
        h('a', { href: `#/ws/${encodeURIComponent(this.deps.wsId)}/context` }, 'project'), ' · ',
        h('a', { href: `#/ws/${encodeURIComponent(this.deps.wsId)}/wf/${encodeURIComponent(`${this.deps.workflow}.yaml`)}/context` }, 'workflow'), '.'))
  }

  // ---- Detail: every attempt -----------------------------------------------------

  private renderDetail() {
    const v = this.view
    if (!v) { this.detailBox.replaceChildren(); return }
    this.detailBox.replaceChildren(h('summary', `Every attempt (${v.attempts.length}) — sources, provenance and exact texts`),
      ...v.attempts.slice().reverse().map(a => h('div.run-ctx-attempt', { dataset: { attempt: a.attempt } },
        h('p.small', h('strong', `Attempt ${a.attempt}`), ` · began ${when(a.began)} · ${a.reason}`),
        a.recorded ? h('p.small.muted', `snapshot ${a.recorded.snapshot} · fingerprint ${a.recorded.fingerprint.slice(7, 19)} · ${a.delivery ? `prompt ${a.delivery.event} ${when(a.delivery.at)}${a.delivery.detail ? ` — ${a.delivery.detail}` : ''} (delivery, not proof it was read)` : 'delivery not recorded'}`) : null,
        a.snapshot ? h('ul.run-ctx-sources', ...a.snapshot.sources.filter(s => s.scope !== 'run').map(s => h('li.small', `${scopeLabel(s)} — ${s.delivery}${s.sha256 ? ` ${s.sha256.slice(0, 12)}` : ''}${s.origin.file ? ` · ${s.origin.file}` : ''}${s.origin.revision !== undefined ? ` · revision ${s.origin.revision}` : ''}`)))
          : h('div', h('p.small.muted', `Unavailable: ${a.unavailable ?? 'not recorded'}`), ...(a.legacy ?? []).map(g => h('p.small', `guide ${g.path} ${g.sha256.slice(0, 12)}`)), ...(a.recorded?.sources ?? []).map(s => h('p.small', `${s.key} — ${s.delivery}${s.sha256 ? ` ${s.sha256.slice(0, 12)}` : ''} (recorded identity only)`))),
        a.snapshot ? h('details', h('summary.small', 'Exact text'), h('pre.ctx-rendered', a.snapshot.rendered)) : null)),
      h('p.small.muted', `wfe context run ${this.deps.workflow}/${this.deps.run} prints the same comparison.`),
      h('button.small', { type: 'button', onclick: () => void this.loadView() }, 'Read again'))
  }

  private renderSummary() {
    const rec = this.rec
    if (!rec) return
    const ins = Object.values(rec.instructions ?? {})
    const pending = ins.filter(i => !i.ack).length
    const v = this.view
    const att = v?.attempts.at(-1)
    const ch = v?.changes.filter(c => !c.key.startsWith('run/') && c.key !== 'system/contract') ?? []
    const bits = [
      rec.input.kind === 'braindump' ? 'braindump' : 'request',
      ins.length ? `${ins.length} instruction${ins.length === 1 ? '' : 's'}${pending ? ` (${pending} not acknowledged)` : ''}` : 'no instructions',
      this.deps.historical ? null : !v ? null : !att ? 'no attempt yet' : att.snapshot ? `attempt ${att.attempt}: context recorded` : `attempt ${att.attempt}: context unavailable`,
      this.deps.historical || !v || !att ? null : ch.length ? `${ch.length} change${ch.length === 1 ? '' : 's'} for the next attempt` : 'next attempt: same',
    ].filter(Boolean)
    const dirty = this.isDirty()
    this.summary.replaceChildren(h('span.small.muted', bits.join(' · ')), ...(dirty ? [h('span.small.warn-text.ctx-unsaved', ' · unsent or unsaved text')] : []))
  }

  dispose() { this.disposed = true }
}
