// The run view's right pane (p7/ex2). Its shell is built once: every section
// keeps one root, its display is brought up to date in place (patch.ts), and
// its controls — the name, answers, the resume instruction, the adjusted
// definition and its reason, the decision's evidence — are created once and
// never rebuilt, so focus, selection, composition and internal scrolling
// survive whatever the run, the host or the connection does meanwhile.
// runView.ts keeps the server snapshot and the operations; the pane reads the
// data it is given and asks the view to act.
import type { RunResponse } from '../shared/api.ts'
import { effectiveOf, holderOf, isOpen, questionState, runKey, situation, type Question, type RunRecord } from '../shared/run.ts'
import { reportStep } from '../shared/compile.ts'
import type { AdjustView, PresentationView, RunExecView, RunNotifyView } from './api.ts'
import { STATE_GLYPH, TYPE_LABEL } from './canvas.ts'
import { stepFacts, stepLabel } from './inspector.ts'
import { h, when } from './dom.ts'
import { icon } from './icons.ts'
import { patchContent } from './patch.ts'
import { activeWorkflow, ago, chip, fileLink, nodeLabel, nodeLink, runHash } from './runCommon.ts'

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
}

export interface SideActions {
  // Records one run operation as the declared actor; true when recorded.
  record(op: Record<string, unknown> & { op: string }, done: string): Promise<boolean>
  // Inspects (dryRun) or applies an adjustment; null when the request failed.
  adjust(body: { text: string; reason: string; dryRun: boolean; expectRevision: string; expectSeq: number }): Promise<AdjustView | null>
  notice(kind: 'ok' | 'error' | 'warn', text: string): void
}

interface Section { root: HTMLElement; title: HTMLElement }

function section(key: string, ...body: Node[]): Section {
  const title = h('h3')
  return { root: h('section.side-sec', { dataset: { key: `sec:${key}`, section: key } }, title, ...body), title }
}
const setText = (el: HTMLElement, text: string) => { if (el.textContent !== text) el.textContent = text }
const show = (el: HTMLElement, on: boolean) => { if (el.hidden === on) el.hidden = !on }
const setDisabled = (el: HTMLButtonElement, off: boolean) => { if (el.disabled !== off) el.disabled = off }
const list = (xs: string[]) => xs.filter(x => !x.startsWith('_')).join(', ') || '—'

// One question's card: its display, and the one canonical answer form.
interface QuestionItem { id: string; root: HTMLElement; display: HTMLElement; form?: { root: HTMLElement; ta: HTMLTextAreaElement; button: HTMLButtonElement } }

export class RunSide {
  readonly el = h('aside.run-side', { 'aria-label': 'Run details' })
  private data!: RunData
  private readonly act: SideActions
  private readonly placeholder = h('p.muted.side-placeholder')
  private readonly actor: HTMLInputElement
  private readonly selected = section('selected', h('div.sec-body'))
  private readonly questions = section('questions', h('div.questions'), h('p.muted.small', 'No questions recorded.'))
  private readonly qItems = new Map<string, QuestionItem>()
  private readonly instructions = section('instructions', h('div.questions'))
  private readonly presentations = section('presentations', h('div.sec-body'))
  private readonly definition = section('definition', h('div.sec-body'))
  private readonly adjust: { root: HTMLDetailsElement; ta: HTMLTextAreaElement; reason: HTMLInputElement; preview: HTMLElement; apply: HTMLButtonElement; base: string | null; result: AdjustView | null }
  private readonly catalog = section('catalog', h('div.sec-body'))
  private readonly related = section('related', h('div.sec-body'))
  private readonly files = section('files', h('div.sec-body'))
  private readonly fileView = { root: h('div.file-view'), head: h('div.row.tight'), status: h('p.small'), pre: h('pre'), path: '' }
  private readonly execution = section('execution', h('div.sec-body'))
  private readonly resume: { root: HTMLElement; ta: HTMLTextAreaElement; button: HTMLButtonElement }
  private readonly execMore = h('div.sec-body')
  private readonly coordination = section('coordination', h('div.sec-body'))
  private readonly result = section('result', h('div.sec-body'))
  private readonly decide: { root: HTMLElement; evidence: HTMLInputElement; accept: HTMLButtonElement; reject: HTMLButtonElement; cancel: HTMLButtonElement }
  private readonly history = section('history', h('ol.history', { reversed: true }))
  private historyShown = ''

  constructor(actions: SideActions, actorName: string) {
    this.act = actions
    this.actor = h('input', { value: actorName, placeholder: 'your name', 'aria-label': 'Your name', size: 14 })

    const ta = h('textarea.yaml', { rows: 12, 'aria-label': 'Adjusted definition', spellcheck: false })
    const reason = h('input', { placeholder: 'why the run changes', 'aria-label': 'Adjustment reason' })
    const preview = h('div.adjust-preview-slot')
    const apply = h('button.primary', { disabled: true, title: 'Preview first' }, 'Apply')
    const adjustRoot = h('details.adjust', h('summary.small', 'Adjust future work'),
      h('p.small.muted', 'Edit the definition in force. Only pending work may change; started and finished work, bindings and execution settings stay. The reusable workflow file is not changed.'),
      ta, reason, preview, h('div.row.tight', h('button', { onclick: () => void this.sendAdjust(true) }, 'Preview'), apply))
    apply.addEventListener('click', () => void this.sendAdjust(false))
    this.adjust = { root: adjustRoot, ta, reason, preview, apply, base: null, result: null }
    ta.addEventListener('input', () => { this.adjust.result = null; this.renderPreview() })
    this.definition.root.append(adjustRoot)

    const fv = this.fileView
    fv.root.append(fv.head, fv.status, fv.pre)
    fv.root.hidden = true
    this.files.root.append(fv.root)

    const instruction = h('textarea', { rows: 2, placeholder: 'what the executor should do now (after looking at the working tree)', 'aria-label': 'Resume instruction' })
    const resumeButton = h('button.primary', 'Resume')
    resumeButton.addEventListener('click', () => {
      const text = instruction.value
      if (!text.trim()) { this.act.notice('error', 'A resume needs your instruction.'); return }
      void this.act.record({ op: 'run.resume', reason: text }, 'Resumed: the executor is queued.').then(ok => { if (ok && instruction.value === text) instruction.value = '' })
    })
    this.resume = { root: h('div.resume-form', instruction, h('div.row.tight', resumeButton)), ta: instruction, button: resumeButton }
    this.execution.root.append(this.resume.root, this.execMore)

    const evidence = h('input', { placeholder: 'evidence: what you checked (report, commit, demo…)', 'aria-label': 'Decision evidence' })
    const decide = (decision: 'accepted' | 'rejected') => {
      const text = evidence.value
      if (!text.trim()) { this.act.notice('error', 'A decision needs its evidence.'); return }
      void this.act.record({ op: 'run.decide', decision, evidence: text }, `Recorded: result ${decision}.`).then(ok => { if (ok && evidence.value === text) evidence.value = '' })
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
    this.decide = { root: h('div.decide', evidence, h('div.row.tight', accept, reject, cancel)), evidence, accept, reject, cancel }
    this.result.root.append(this.decide.root)

    this.el.append(this.placeholder,
      h('div.actor-row', h('label.small', 'Recording as ', this.actor), h('span.muted.small', 'declared, like an approver; saved in this browser')),
      ...[this.selected, this.questions, this.instructions, this.presentations, this.definition, this.catalog, this.related, this.files, this.execution, this.coordination, this.result, this.history].map(s => s.root))
  }

  // ---- what the view reads --------------------------------------------------

  get actorName() { return this.actor.value }
  // The approver from the registry, only into a name nobody has typed.
  suggestActor(name: string) { if (!this.actor.value && document.activeElement !== this.actor) this.actor.value = name }

  // Text the person typed that is not recorded yet.
  isDirty(): boolean {
    const typed = [...this.qItems.values()].map(q => q.form?.ta.value ?? '').concat(this.resume.ta.value, this.decide.evidence.value, this.adjust.reason.value)
    return typed.some(v => v.trim() !== '') || (this.adjust.base !== null && this.adjust.ta.value !== this.adjust.base)
  }

  // An explicit request to answer a question: reveal its one form.
  revealQuestion(id: string) {
    const item = this.qItems.get(id)
    if (!item) return
    item.root.scrollIntoView({ block: 'nearest' })
    item.form?.ta.focus({ preventScroll: true })
  }

  // ---- update -----------------------------------------------------------------

  update(d: RunData) {
    this.data = d
    const r = d.shown
    const rec = r?.record
    const sections = [this.selected, this.questions, this.instructions, this.presentations, this.definition, this.catalog, this.related, this.files, this.execution, this.coordination, this.result, this.history]
    if (!r || !rec) {
      setText(this.placeholder, d.resp?.problem ? 'No usable record.' : 'Loading…')
      show(this.placeholder, true)
      for (const s of sections) show(s.root, false)
      return
    }
    show(this.placeholder, false)
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
    this.updateResult(rec)
    this.updateHistory(rec)
  }

  private get frozen() { return !!(this.data.resp && !this.data.resp.record) }

  private updateSelected(rec: RunRecord) {
    const id = this.data.selection
    const on = !!id && !!rec.nodes[id]
    show(this.selected.root, on)
    if (!on) return
    setText(this.selected.title, 'Selected node')
    patchContent(this.selected.root.children[1] as HTMLElement, this.nodeDetail(rec, id!))
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
    box.append(h('div.insp-head', icon(step ? 'doc' : def?.type ?? 'unknown', 'icon'), h('h3', step ? label2(id) : def?.name || id), h('code', id), h('button.icon-btn', { title: 'Close', dataset: { action: 'close-node' } }, '×')))
    box.append(h('div.chips', chip(state, `${STATE_GLYPH[state] ?? ''} ${label}`), h('span.chip', step ? 'Documentation step' : TYPE_LABEL[def?.type ?? ''] ?? def?.type ?? '?')))
    if (def?.description) box.append(h('p.small', def.description))
    // Made from one of the person's templates (p7/ex1): its provenance as written in this revision.
    if (def?.template) box.append(h('div.template-field.small', h('span.muted', 'From template '), h('code', def.template.id), ` revision ${def.template.revision}. `,
      h('div.template-provenance', h('span.muted', 'Expected: '), def.template.expectation)))
    if (step && eff) {
      // The document: missing, written but unrecorded, or checked.
      const file = r.files.find(f => f.name === step.output)
      const path = `${r.dir}/${step.output}`
      const docState = n.document ? `checked when recorded: ${n.document.bytes} bytes, sha256 ${n.document.sha256.slice(0, 12)}…${file ? '' : ' — the file is gone now'}` : file ? (state === 'running' ? 'being written — not yet recorded' : 'written, not recorded as complete') : 'not written yet'
      box.append(h(`div.doc-state${n.document ? '.ok' : file ? '.unfinished' : '.missing'}`, h('strong', step.output), ': ', docState, ' ', file ? fileLink(path, 'Open') : null))
      if (n.agreement) box.append(h('p.small.ok-text', `Agreed: the answer to ${n.agreement.question} was taken up for this plan.md.`))
      box.append(...stepFacts(eff, id, label2))
    } else if (eff?.nodes[reportStep(id)]) {
      const rs = reportStep(id)
      box.append(h('p.small', 'Its report: ', nodeLink(rs, `report-${id}.md`), ` — ${nodeLabel(rec, rs).label}. Successors wait for the report, not only for this work.`))
    }
    const rows: [string, string][] = [['Started', n.started ? when(n.started) : '—'], ['Ended', n.ended ? when(n.ended) : '—'], ['Last update', n.updated ? `${when(n.updated)} (${ago(n.updated)})` : '—']]
    box.append(h('dl.kv', ...rows.flatMap(([k, v]) => [h('dt', k), h('dd', v)])))
    if (n.wait) {
      const on = n.wait.on
      box.append(h('div.wait-box', h('strong', 'Waiting: '), n.wait.reason, h('br'), 'Next move: ', h('strong', holderOf(rec, id)),
        'external' in on ? h('div.small', `Awaiting: ${on.external}`) : null))
    }
    if (n.outcome) box.append(h('div.outcome', h('strong', 'Outcome: '), n.outcome.text, ...n.outcome.artifacts.map(a => h('div.small', fileLink(a)))))
    if (n.failure) box.append(h('div.banner.error', `Failed (${n.failure.by}, ${when(n.failure.at)}): ${n.failure.reason}`))
    if (n.cancellation) box.append(h('div.banner.warn', `Cancelled (${n.cancellation.by}, ${when(n.cancellation.at)}): ${n.cancellation.reason}`))
    if (n.notes.length) box.append(h('h4', 'Notes'), h('ul.notes', ...n.notes.map(x => h('li', h('span.muted.small', `${when(x.at)} · ${x.by}: `), x.text))))
    // The node's questions as summaries; each is answered in its one form under Questions.
    const qs = Object.values(rec.questions).filter(q => q.node === id)
    if (qs.length) box.append(h('h4', 'Questions of this node'), ...qs.map(q => {
      const st = questionState(q)
      return h(`div.question-summary.q-${st}`, { dataset: { question: q.id, key: `qs:${q.id}` } }, h('strong', q.id), ' ', chip(questionChip(st), st), ' ',
        h('span.small', q.text.split('\n')[0].slice(0, 160)), ' ',
        h('a.small', { href: '#', dataset: { action: 'goto-question', question: q.id } }, this.answerable(rec, q) ? 'Answer under Questions' : 'Show under Questions'))
    }))
    return box
  }

  private answerable(rec: RunRecord, q: Question) {
    const st = questionState(q)
    return (st === 'open' || st === 'answered') && !this.data.rev && !rec.cancelled
  }

  private updateQuestions(rec: RunRecord) {
    const qs = Object.values(rec.questions).slice().reverse()
    setText(this.questions.title, `Questions (${qs.filter(q => ['open', 'answered'].includes(questionState(q))).length} open)`)
    const box = this.questions.root.children[1] as HTMLElement
    show(this.questions.root.children[2] as HTMLElement, !qs.length)
    let at = box.firstElementChild
    for (const q of qs) {
      let item = this.qItems.get(q.id)
      if (!item) {
        const display = h('div.q-display')
        item = { id: q.id, root: h('div.question', { dataset: { question: q.id, key: `q:${q.id}` } }, display), display }
        this.qItems.set(q.id, item)
      }
      if (item.root === at) at = at.nextElementSibling
      else box.insertBefore(item.root, at)
      this.updateQuestion(rec, q, item)
    }
  }

  private updateQuestion(rec: RunRecord, q: Question, item: QuestionItem) {
    const st = questionState(q)
    const cls = `question q-${st}`
    if (item.root.className !== cls) item.root.className = cls
    const v = q.presentation ? this.data.presentViews.find(x => x.id === q.presentation!.id) : undefined
    patchContent(item.display,
      h('div.q-head', h('strong', q.id), chip(questionChip(st), st), h('span.muted.small', ` to ${q.to}${q.node ? ` · node ${q.node}` : ''} · asked by ${q.askedBy}, ${ago(q.asked)}`)),
      h('p.q-text', q.text),
      q.presentation ? h('p.small', 'About presentation ', h('strong', q.presentation.id), ` (revision ${q.presentation.revision.slice(7, 19)}) — `, v?.live ? h('a', { href: v.url!, target: '_blank', rel: 'noopener' }, 'open the review ↗') : h('span.muted', 'not served now')) : null,
      ...q.answers.map((a, i) => h('div.answer', { dataset: { key: `a:${i}` } }, h('span.muted.small', `Answer ${i}${q.takenUp?.answer === i ? ' — taken up' : ''} · from ${a.from}${a.by !== a.from ? `, recorded by ${a.by}` : ''} via ${a.via} · ${when(a.at)}`), h('div', a.text))),
      q.takenUp ? h('p.small.ok-text', `Taken up by ${q.takenUp.by} ${ago(q.takenUp.at)}.`) : null,
      q.withdrawn ? h('p.small', `Withdrawn by ${q.withdrawn.by}: ${q.withdrawn.reason}`) : null,
      st === 'answered' ? h('p.small.muted', `The answer is recorded; ${rec.executor.name} has not recorded taking it up yet.`) : null)
    const open = this.answerable(rec, q)
    if (open && !item.form) item.form = this.answerForm(q.id)
    const f = item.form
    if (!f) return
    if (open) {
      if (!f.root.isConnected) item.root.append(f.root)
      setText(f.button, st === 'answered' ? 'Record another answer' : 'Record answer')
      setDisabled(f.button, this.frozen)
    } else {
      setDisabled(f.button, true)
      if (!f.ta.value.trim() && document.activeElement !== f.ta) f.root.remove()
    }
  }

  private answerForm(id: string) {
    const ta = h('textarea', { rows: 3, 'aria-label': `Answer to ${id}`, placeholder: 'Your answer' })
    const button = h('button.primary', 'Record answer')
    button.addEventListener('click', () => {
      const text = ta.value
      if (!text.trim()) return
      const name = this.data.shown?.record?.executor.name ?? 'the executor'
      void this.act.record({ op: 'question.answer', question: id, text }, `Answer to ${id} recorded in run.json. Continue the conversation with ${name} in VS Code; recording does not notify it.`)
        .then(ok => { if (ok && ta.value === text) ta.value = '' })
    })
    return { root: h('div.answer-form', ta, h('div.row.tight', button), h('p.small.muted', 'Stored in run.json as your answer. It does not start or wake the IDE agent; tell it in VS Code.')), ta, button }
  }

  // Additional instructions (p6): received from the person, acknowledged by
  // the executor at a node boundary. Received is not read.
  private updateInstructions(rec: RunRecord) {
    const ins = Object.values(rec.instructions ?? {})
    show(this.instructions.root, ins.length > 0)
    if (!ins.length) return
    const pending = ins.filter(i => !i.ack).length
    setText(this.instructions.title, `Instructions (${pending ? `${pending} not acknowledged` : 'all acknowledged'})`)
    patchContent(this.instructions.root.children[1] as HTMLElement, ...ins.slice().reverse().map(i => h(`div.question.q-${i.ack ? 'taken-up' : 'answered'}`, { dataset: { instruction: i.id, key: `i:${i.id}` } },
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
    setText(this.presentations.title, 'Presentations')
    const rev = this.data.rev
    const finished = !!rec.cancelled || rec.execution.state === 'completed'
    const STATE: Record<string, string> = { registered: 'completed', available: 'running', stopped: 'cancelled', failed: 'failed', 'stop-failed': 'failed' }
    patchContent(this.presentations.root.children[1] as HTMLElement, ...Object.values(rec.presentations).slice().reverse().map(p => {
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
    patchContent(this.definition.root.children[1] as HTMLElement,
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
    if (a.base === null) { a.base = active; a.ta.value = active }
    if (open) { if (!a.root.isConnected) this.definition.root.append(a.root) }
    else if (a.ta.value === a.base && !a.reason.value.trim() && !a.root.contains(document.activeElement)) a.root.remove()
    this.renderPreview()
  }

  private renderPreview() {
    const a = this.adjust
    const p = a.result
    patchContent(a.preview, p ? h(`div.banner.${p.ok ? 'ok' : 'error'}.small.adjust-preview`,
      p.ok ? `Applicable to ${p.parent}: ` : `Not applicable (${p.problems.map(x => x.code).join(', ')}): `,
      `work added ${list(p.authored.added)}; removed ${list(p.authored.removed)}; changed ${p.authored.changed.map(c => `${c.id} (${c.fields.join(', ')})`).join(', ') || '—'}; new edges ${p.graph.edgesAdded.filter(([x, y]) => !x.startsWith('_') || !y.startsWith('_')).map(([x, y]) => `${x} → ${y}`).join('; ') || '—'}`,
      ...p.problems.map(x => h('div', `${x.code}: ${x.message}`))) : null)
    setDisabled(a.apply, !p?.ok)
    const title = p?.ok ? 'Apply as a new revision' : 'Preview first'
    if (a.apply.title !== title) a.apply.title = title
  }

  private async sendAdjust(dryRun: boolean) {
    const a = this.adjust
    const rec = this.data.shown?.record
    if (!rec) return
    if (!a.reason.value.trim()) { this.act.notice('error', 'An adjustment needs its reason.'); return }
    const r = await this.act.adjust({ text: a.ta.value, reason: a.reason.value, dryRun, expectRevision: rec.definition.active ?? 'r1', expectSeq: rec.seq })
    a.result = r
    if (!dryRun && r?.ok) { a.result = null; a.reason.value = ''; a.base = null }
    this.renderPreview()
  }

  private updateCatalog(rec: RunRecord) {
    const cat = this.data.shown?.catalog
    const body = this.catalog.root.children[1] as HTMLElement
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

  private updateRelated(r: RunResponse, rec: RunRecord) {
    const wsId = this.data.wsId
    const input = rec.input
    const rel = [
      r.predecessor ? h('div', 'Predecessor: ', h('a', { href: runHash(wsId, r.predecessor.ref) }, r.predecessor.ref)) : null,
      input.kind === 'request' && input.entrustedBy ? h('div.small', 'Entrusted by: ', input.entrustedBy.kind === 'run' ? h('a', { href: runHash(wsId, runKey(input.entrustedBy)) }, `${runKey(input.entrustedBy)}${input.entrustedBy.node ? ` node ${input.entrustedBy.node}` : ''}`) : input.entrustedBy.kind === 'file' ? input.entrustedBy.path : input.entrustedBy.text) : null,
    ].filter((x): x is HTMLDivElement => !!x)
    show(this.related.root, rel.length > 0)
    if (!rel.length) return
    setText(this.related.title, 'Related runs')
    patchContent(this.related.root.children[1] as HTMLElement, ...rel)
  }

  private updateFiles(r: RunResponse) {
    setText(this.files.title, 'Reports and files')
    // Recorded artifacts outside the run folder; the folder's own files are listed above.
    const recorded = r.artifacts.filter(a => !(a.path.startsWith(`${r.dir}/`) && !a.path.slice(r.dir.length + 1).includes('/')))
    patchContent(this.files.root.children[1] as HTMLElement,
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
    show(fv.root, !!v)
    if (!v) { fv.path = ''; return }
    if (v.path !== fv.path) {
      fv.path = v.path
      patchContent(fv.head, h('strong', v.path), h('button.icon-btn', { dataset: { action: 'close-file' } }, '×'))
      fv.pre.textContent = ''
      fv.pre.scrollTop = 0; fv.pre.scrollLeft = 0
    }
    setText(fv.status, v.error ?? (v.text === undefined ? 'Loading…' : ''))
    const cls = v.error ? 'small error' : 'small muted'
    if (fv.status.className !== cls) fv.status.className = cls
    show(fv.status, !!v.error || v.text === undefined)
    show(fv.pre, v.text !== undefined)
    if (v.text !== undefined && fv.pre.textContent !== v.text) fv.pre.textContent = v.text
  }

  // What runs, what waits and what is published: the record's control state
  // with this host's facts (process, queue, checkpoints) beside it.
  private updateExecution(rec: RunRecord) {
    const d = this.data
    show(this.execution.root, !d.rev)
    if (d.rev) return
    setText(this.execution.title, 'Execution')
    const sit = situation(rec)
    const open = d.execView?.attempts.find(a => a.state !== 'ended')
    const SIT: Record<string, string> = {
      executing: 'Executing', stopping: 'Stop requested — waiting for the process to end', 'awaiting-person': 'Awaiting a person — no process runs meanwhile',
      stopped: 'Stopped — resumes only when you resume it', interrupted: 'Interrupted — look at the working tree, then resume', unknown: 'Unknown — the process was lost; look, then resume',
      completed: 'Completed', cancelled: 'Cancelled', 'not-started': 'Not started', idle: 'Idle',
    }
    const process = open ? (open.alive === true ? `process ${open.pid} alive` : open.alive === false ? (open.pid ? `process ${open.pid} not seen alive` : 'launching') : 'process on another host') : ''
    const frozen = this.frozen || !!rec.cancelled
    patchContent(this.execution.root.children[1] as HTMLElement,
      h('div.row.tight', h(`span.chip.sit-${sit}`, SIT[sit] ?? sit), process ? h('span.muted.small', process) : null),
      rec.control.hold ? h('p.small', `Held (${rec.control.hold.kind}) since ${when(rec.control.hold.since)} by ${rec.control.hold.by}: ${rec.control.hold.reason}`) : null,
      d.execError ? h('div.banner.warn', `Execution facts of this host could not be read: ${d.execError}`) : null,
      d.execView ? h('p.small.muted', `Executor: ${d.execView.executor.state}${d.execView.executor.detail ? ` — ${d.execView.executor.detail}` : ''}`) : null,
      h('div.row.tight', h('button', { disabled: frozen || !!rec.control.hold || !!rec.control.stop || sit === 'completed', title: 'Stop execution; the run stays resumable', dataset: { action: 'stop-run' } }, 'Stop')))
    const held = !!rec.control.hold
    if (held) { if (!this.resume.root.isConnected) this.execution.root.insertBefore(this.resume.root, this.execMore) }
    else if (!this.resume.ta.value.trim() && document.activeElement !== this.resume.ta) this.resume.root.remove()
    setDisabled(this.resume.button, frozen || !held)
    const ev = d.execView
    const queued = ev?.jobs.filter(j => j.state === 'queued' || j.state === 'claimed') ?? []
    patchContent(this.execMore,
      queued.length ? h('p.small', 'Queued: ', ...queued.map(j => `${j.kind} (${j.state}) — ${j.reason}`)) : null,
      ev?.attempts.length ? h('h4', `Attempts (${ev.attempts.length})`) : null,
      ev?.attempts.length ? h('ul.attempts', ...ev.attempts.slice().reverse().map(a => h('li.small', { dataset: { key: `at:${a.id}` } },
        h('code', a.id), ` ${a.state === 'ended' ? `${a.outcome}${a.exit_code !== null ? ` (exit ${a.exit_code})` : a.signal ? ` (${a.signal})` : ''}` : a.state}`,
        h('span.muted', ` · ${when(a.began)}${a.ended ? ` → ${when(a.ended)}` : ''}${a.backend ? ` · ${a.backend}` : ''}${a.stop_requested ? ' · stop requested' : ''}`)))) : null,
      ev?.checkpoints.length ? h('h4', 'Publication') : null,
      ...(ev?.checkpoints ?? []).slice().reverse().slice(0, 6).map(c => h('div.checkpoint.small', { dataset: { key: `cp:${c.id}` } },
        h(`span.chip.${c.state === 'published' || c.state === 'nothing' ? 'ok' : c.state === 'pending' ? 'muted' : 'warn'}`, c.state === 'nothing' ? 'nothing to publish' : c.state), ` ${c.kind}`,
        ...c.steps.map(st => h('div.muted', `${st.repo === '.' ? 'root' : st.repo}: ${st.commit ? `${st.commit.slice(0, 7)} ${st.pushed ? `pushed to ${st.branch}` : 'not pushed'}` : 'no commit'}${st.excluded.length ? `; left out (already changed before): ${st.excluded.join(', ')}` : ''}${st.conflicts.length ? `; needs you: ${st.conflicts.join(', ')} changed before the run and again by it` : ''}${st.error ? `; ${st.error}` : ''}`)),
        c.error ? h('div.error', c.error) : null,
        c.state === 'failed' || c.state === 'attention' ? h('button', { dataset: { action: 'retry-checkpoint', checkpoint: String(c.id) } }, 'Retry publication') : null)))
  }

  // Where this run's progress is announced, and what is still owed there.
  // A delivery problem never changes the run's own state.
  private updateCoordination() {
    const v = this.data.notifyView
    show(this.coordination.root, !this.data.rev && !!v)
    if (this.data.rev || !v) return
    setText(this.coordination.title, 'Coordination (Zulip)')
    const body = this.coordination.root.children[1] as HTMLElement
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
    setText(this.result.title, 'Result')
    const completed = rec.execution.state === 'completed'
    patchContent(this.result.root.children[1] as HTMLElement,
      ...rec.decisions.map((d, i) => h(`div.banner.${d.decision === 'accepted' ? 'ok' : 'error'}`, { dataset: { key: `d:${i}` } }, `${d.decision} by ${d.by} (${when(d.at)}) — evidence: ${d.evidence}${d.note ? ` — ${d.note}` : ''}`)),
      h('p.small.muted', completed
        ? 'Execution completed: every node recorded completion. Accepting the result is your separate decision.'
        : `Execution is ${rec.execution.state}. A result can be accepted once every node is completed; it can be rejected at any time.`))
    const frozen = this.frozen
    setDisabled(this.decide.accept, !completed || frozen)
    setDisabled(this.decide.reject, frozen)
    setDisabled(this.decide.cancel, !!rec.cancelled || frozen)
  }

  // Newest first; every entry keeps its element while it exists.
  private updateHistory(rec: RunRecord) {
    const shownKey = `${rec.seq}:${rec.history.length}`
    if (shownKey === this.historyShown) return
    this.historyShown = shownKey
    const history = rec.history.slice().reverse()
    setText(this.history.title, `History (${history.length})`)
    patchContent(this.history.root.children[1] as HTMLElement, ...history.map(e => {
      const d = e as unknown as Record<string, unknown>
      const moves = Object.entries(e.change.nodes ?? {}).map(([n, [a, b]]) => `${n}: ${a ?? '—'} → ${b}`)
      if (e.change.execution) moves.push(`run: ${e.change.execution[0] ?? '—'} → ${e.change.execution[1]}`)
      const detail = (d.reason ?? d.outcome ?? d.text ?? d.evidence ?? d.external ?? d.path ?? '') as string
      return h('li', { value: e.seq, dataset: { key: `h:${e.seq}` } }, h('div', h('code', e.op), ` ${d.node ? `${d.node} ` : ''}${d.question ? `${d.question} ` : ''}`, h('span.muted.small', `· ${e.by} via ${e.via} · ${when(e.at)}`)),
        moves.length ? h('div.small', moves.join('; ')) : null, detail ? h('div.small.muted', detail.split('\n')[0].slice(0, 200)) : null)
    }))
  }
}

const questionChip = (st: string) => (st === 'open' ? 'waiting' : st === 'answered' ? 'running' : st === 'taken-up' ? 'completed' : 'cancelled')
