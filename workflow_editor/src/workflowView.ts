// The one graph of a workflow definition, by source (p20, docs/drafts.md): the
// published definition, a draft, what a run started with, or what a checkout
// holds. Only a draft edits. A slim header (crumbs, the source's actions), a band
// saying what this definition is, a title band (name, purpose, approval states,
// validation and the two explicit entry points — "Intent & approvals" and
// "Workflow settings"), the canvas with its toolbar, and an inspector that opens
// for a selection or for settings (p8). The service holds the saved state; the
// view holds unsaved edits until an explicit save, and guards them against
// external changes. Opening or closing a panel never saves or discards anything:
// every panel edits the same edits.
import type { FileProblem, PublishedSourceView, WorkflowResponse } from '../shared/api.ts'
import type { DraftConflict, DraftMeta, DraftResponse } from '../shared/drafts.ts'
import { approvalStates, canonicalJson, type ApprovalState } from '../shared/canonical.ts'
import { compile, hasDocSteps } from '../shared/compile.ts'
import { policySummary } from './docPolicy.ts'
import { NODE_TYPES, cloneWorkflow, docSteps, type ApprovalKind, type Issue, type NodeType, type Workflow } from '../shared/model.ts'
import { instantiate, type NodeTemplate } from '../shared/catalog.ts'
import { WORKFLOW_TALK, workflowTalkNode } from '../shared/workflowTalk.ts'
import { hasErrors, validateWorkflow, type ValidationContext } from '../shared/validate.ts'
import { api, ApiError } from './api.ts'
import { conflictPanel, draftHash, draftsChooser } from './draftPanels.ts'
import { sourceText } from './runCommon.ts'
import { live, serial } from './live.ts'
import { Canvas, TYPE_LABEL, type Selection } from './canvas.ts'
import { h, short, when } from './dom.ts'
import { icon } from './icons.ts'
import { renderInspector } from './inspector.ts'
import { detailFor, pickFor, type KnowledgeHost } from './knowledgePanel.ts'
import type { StripEvents } from './knowledgeUi.ts'
import { displayToggle, isSimple, onDisplay, setDisplay } from './displayMode.ts'
import { ContextSection, ListEditor } from './contextParts.ts'
import { autoArrange, completeLayout, freeSlot, type DisplayMode } from '../shared/layout.ts'
import type { ViewHandle } from './main.ts'

const MODE_KEY = 'workflow-editor.mode'
const APPROVER_KEY = 'workflow-editor.approver'
const ACTOR_KEY = 'workflow-editor.actor'
// What an open published or draft view checks, and how often (docs/drafts.md).
const POLL_MS = 3_000
// Said once on the next view: what a finished apply did.
let flash = ''

export type DefinitionView = { kind: 'published' } | { kind: 'draft'; id: string } | { kind: 'run'; workflow: string; run: string; revision?: string } | { kind: 'checkout' }
function stored(key: string, fallback: string) { try { return localStorage.getItem(key) ?? fallback } catch { return fallback } }
function store(key: string, value: string) { try { localStorage.setItem(key, value) } catch { /* per-viewer convenience only */ } }

// What each base type is for, in the Add node palette.
const TYPE_HINT: Record<string, string> = {
  study: 'Read, research, compare',
  do: 'Change or produce something',
  talk: 'Ask or agree with a person',
  workflow__talk: 'Build and present the run graph for agreement',
  delegate: 'Entrust work to another workflow and use its result',
  review: 'The person reviews finished work later (WFE serves it, records the decision, cleans up)',
}

export function renderWorkflowView(root: HTMLElement, wsId: string, fileName: string, opts: { context?: boolean; source?: DefinitionView } = {}): ViewHandle {
  const source: DefinitionView = opts.source ?? { kind: 'published' }
  let file = fileName
  let resp: WorkflowResponse | null = null
  let saved: Workflow | null = null // last valid content read from its source
  let draft: Workflow | null = null // what is shown and, in a draft, edited
  let rev: string | null = null
  // A draft (the record): saved revision, its base, its apply journal.
  let meta: DraftMeta | null = null
  // The saved revision the browser's edits were made on: a save names it, so
  // another tab's newer save refuses this one instead of being overwritten.
  let editRevision = 0
  let latest: DraftResponse['latest'] = null
  let pubSource: PublishedSourceView | null = null // the revision this view read
  let head: PublishedSourceView | null = null // the last check of the default branch
  let sourceProblem = '' // the source cannot be read now
  let existingDrafts: DraftMeta[] = []
  let chooser = false
  let conflict: DraftConflict | null = null
  let comparedAt: string | null = null // the latest digest a comparison was asked for
  let mergeNote = ''
  let applying = false
  let applyKey = ''
  let applyNote: { tone: string; text: string; link?: { href: string; label: string } } | null = null
  let tryOpen = false
  let tryKey = ''
  let tryResult: HTMLElement | null = null
  let runFacts: { href: string; text: string; revisions: string[]; active: string } | null = null
  let textOpen = false
  let flashText = flash
  flash = ''
  let problem: FileProblem | undefined
  let externalChange = false
  let saveError = ''
  let saveState = ''
  let notice = ''
  let selection: Selection = null
  let settingsOpen = false // the inspector shows Workflow settings (explicitly opened)
  let opener: HTMLElement | null = null // what opened the inspector, for focus on close
  let mode = stored(MODE_KEY, 'compact') as DisplayMode
  let projectName = 'Project'
  let approvals: Record<ApprovalKind, ApprovalState> | null = null
  let approvalError = ''
  let disposed = false
  let connected = true

  const dirty = () => !!draft && !!saved && canonicalJson(draft) !== canonicalJson(saved)
  const draftOpen = () => source.kind === 'draft' && meta?.state === 'open'
  const readonly = () => !!problem || !draftOpen()
  const inspectorOpen = () => !!selection || settingsOpen

  // ---- static structure (inputs keep focus across updates) --------------
  // Disabled until the file is loaded, so nothing typed early is overwritten.
  const nameInput = h('input.wf-name', { 'aria-label': 'Workflow name', placeholder: 'Workflow name', disabled: true })
  const intentInput = h('textarea.intent-text', { rows: 4, 'aria-label': 'Workflow intent', placeholder: 'What this workflow is for. Everything else is reviewed against it.', disabled: true })
  intentInput.id = 'intent'
  const approverInput = h('input#approver', { placeholder: 'approver', 'aria-label': 'Approver', size: 14, value: stored(APPROVER_KEY, '') })
  const approveIntent = h('button', { onclick: () => void approve('intent'), title: 'Approve the saved intent' }, 'Approve intent')
  const approveDefinition = h('button', { onclick: () => void approve('definition') }, 'Approve definition')
  const crumbs = h('nav.crumbs', { 'aria-label': 'Breadcrumb' })
  const saveButton = h('button', { onclick: () => void save() }, 'Save draft')
  const refreshButton = h('button.ghost-dark.d-only', { title: 'Read this definition again now', onclick: () => void load({ refresh: true }) }, 'Refresh')
  const editButton = h('button.primary', { onclick: () => void edit(false) }, 'Edit')
  const textButton = h('button.ghost-dark', { 'aria-pressed': 'false', title: 'This definition as text', onclick: () => { textOpen = !textOpen; update(false) } }, 'Text')
  const tryButton = h('button', { title: 'Run a saved revision of this draft, on the published code', onclick: () => { tryOpen = !tryOpen; renderSource() } }, 'Try draft')
  const applyButton = h('button', { title: 'Publish the saved draft: later runs use it', onclick: () => void apply(false) }, 'Apply')
  const saveApplyButton = h('button.primary', { title: 'Save these changes and publish them: later runs use them', onclick: () => void apply(true) }, 'Save and apply')
  const discardButton = h('button.ghost-dark', { title: 'Remove this draft', onclick: () => void discard() }, 'Discard draft')
  // Who edits: asked only where it is not known.
  const whoInput = h('input.who-input', { placeholder: 'your name', 'aria-label': 'Your name', size: 14, value: stored(ACTOR_KEY, '') }) as HTMLInputElement
  const sourceBand = h('section.source-band', { 'aria-label': 'What this definition is' })
  const textEdit = h('textarea.yaml.definition-text', { rows: 24, spellcheck: false, 'aria-label': 'The draft as text' }) as HTMLTextAreaElement
  let textBase = ''
  const textSave = h('button.primary', { onclick: () => void saveText() }, 'Save text')
  const textPanel = h('div.definition-text-panel', { hidden: true }, textEdit, h('div.save-row', textSave, h('span.small.muted', 'Saved in this draft, readable or not. Applying needs a valid definition.')))
  const saveStateEl = h('span.save-state')
  const purpose = h('p.wf-purpose')
  const fileLine = h('p.wf-file.d-only')
  const approvalPills = h('div.pills.approval-pills.d-only', { 'aria-label': 'Approval states' })
  // Simple (p8/ex1): one approval state, which is also the entry to Intent & approvals.
  const simpleApproval = h('button.simple-approval.s-only', { onclick: () => toggleIntent(true) })
  const validation = h('button.v-summary', { title: 'Validation: open the full list in Workflow settings', onclick: () => openSettings(validation, 'validation') })
  const intentToggle = h('button.panel-toggle.d-only', { 'aria-expanded': 'false', 'aria-controls': 'intent-panel', onclick: () => toggleIntent() }, icon('person', 'icon small'), 'Intent & approvals')
  const settingsToggle = h('button.panel-toggle.d-only', { 'aria-pressed': 'false', onclick: () => (settingsOpen ? closeInspector() : openSettings(settingsToggle)) }, icon('settings', 'icon small'), 'Workflow settings')
  const approvalRecords = h('div.approval-records')
  const approvalNote = h('p.small.muted')
  const approvalErrorEl = h('p.error.small')
  // The intent is edited in Context (p13 ex1); this panel shows the saved
  // text it approves.
  const savedIntent = h('pre.ctx-text.saved-intent')
  const intentPanel = h('section.intent-panel.d-only#intent-panel', { hidden: true, 'aria-label': 'Intent and approvals' },
    h('div.intent-col',
      h('div.panel-label', icon('intent', 'icon small'), 'Workflow intent (ground truth), as saved'),
      savedIntent,
      h('p.small.muted', 'Everything else in the workflow is reviewed against this text. Approving it records the saved text and its digest. ', h('button.link-btn', { onclick: () => ctxSection.editShared(() => intentInput.focus({ preventScroll: true })) }, 'Edit it in Context'))),
    h('div.approval-col',
      h('div.panel-label', 'Approvals'),
      approvalRecords,
      h('div.approve-actions', h('label.small', 'Declared approver ', approverInput), approveIntent, approveDefinition),
      approvalNote, approvalErrorEl))
  const banners = h('div.banners')
  const modeSwitch = h('div.mode-switch.d-only', { role: 'group', 'aria-label': 'Display mode' })
  const palette = h('div.palette', { hidden: true, role: 'menu', 'aria-label': 'Add node' })
  const addButton = h('button.add-trigger', { 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => togglePalette() }, icon('plus', 'icon small'), 'Add node', icon('caret', 'icon small'))
  const arrangeButton = h('button.arrange.d-only', {
    title: 'Lay the graph out by rank. Only positions change; approvals are unaffected.',
    onclick: () => { if (!draft || readonly()) return; autoArrange(draft); update(false); canvas.fit() },
  }, 'Auto-arrange')
  const policyChip = h('button.policy-state.d-only', { title: 'Documentation policy: open Workflow settings', onclick: () => openSettings(policyChip, 'policy') })
  const toolbar = h('div.toolbar', h('div.add-wrap', addButton, palette), h('span.toolbar-sep.d-only'), modeSwitch, arrangeButton, h('span.toolbar-fill'), policyChip)
  const inspector = h('aside.inspector', { 'aria-label': 'Inspector', hidden: true })
  const canvas = new Canvas({
    select: sel => { if (sel) { settingsOpen = false; opener = null } selection = sel; update(true); if (sel) revealSoon(sel) },
    move: (id, p) => {
      if (!draft || readonly()) return
      if (Object.keys(draft.nodes).some(n => !draft!.layout.nodes[n])) completeLayout(draft)
      draft.layout.nodes[id] = p
      update(false)
    },
    moveMany: points => {
      if (!draft || readonly()) return
      if (Object.keys(draft.nodes).some(n => !draft!.layout.nodes[n])) completeLayout(draft)
      Object.assign(draft.layout.nodes, points)
      update(false)
    },
    connect: (from, to) => connect(from, to),
  })
  canvas.setMode(mode)
  canvas.setSimple(isSimple())
  // Simple and Detail draw different cards: redraw them, keep the selection
  // and the person's place, and bring a selected card into view (p8/ex1).
  const offDisplay = onDisplay(d => {
    canvas.setSimple(d === 'simple')
    update(false)
    if (selection && selection.kind !== 'edge') revealSoon(selection)
  })
  const hint = h('div.canvas-hint.d-only', 'Select a card to inspect it. Drag a card to move it, its right handle onto another card to connect; drag the background to pan.')
  canvas.el.append(hint)
  const rawView = h('pre.raw')
  // Scoped context of this workflow (p13): its defaults and the local overrides.
  const contextLink = h('a.button.d-only', { href: `#/context/${encodeURIComponent(wsId)}`, title: 'Compare this workflow\'s instructions with the project\'s and all projects\', side by side' }, 'Context overview')
  const body = h('main.wf-body', h('div.canvas-col', toolbar, canvas.el, rawView, textPanel), inspector)

  // Context (p13 ex1): the workflow's purpose and guides (this view's one
  // draft and Save) and its local instructions, with what it inherits from
  // the project and from all projects; shown in both modes.
  const guidesEditor = new ListEditor({ label: 'Guides', item: 'Guide', placeholder: 'agent/guide.md, or <project>:<path>', addLabel: 'Add guide', onInput: (v, structural) => { if (draft) { draft.execution.guides = v; update(structural) } } })
  const sharedSave = h('button.primary', { onclick: () => void save() }, 'Save draft')
  const sharedState = h('span.ctx-save-state')
  const sharedControls = h('div.ctx-workflow-shared',
    h('label.field', h('span', 'Purpose (intent)'), intentInput),
    h('p.small.muted', 'Everything else in the workflow is reviewed against this text; runs and authors are given it.'),
    guidesEditor.el,
    h('p.small.muted', 'Guides the project declares are given to every workflow already (Inherited); list here only this workflow\'s own.'),
    h('div.save-row', sharedSave, sharedState, h('span.small.muted', 'Saved in the draft: not used by runs until applied.')))
  const ctxSection = new ContextSection({
    scope: 'workflow', wsId, shared: sharedControls,
    sharedSummary: () => { const w = draft ?? saved; return !w ? 'workflow not read' : [w.intent.trim() ? 'purpose set' : 'no purpose', `${w.execution.guides.length} guide${w.execution.guides.length === 1 ? '' : 's'}`].join(' · ') },
    sharedDirty: () => dirty(),
    projectHref: () => `#/ws/${encodeURIComponent(wsId)}/context`,
  })

  root.append(
    h('header.app-header', crumbs, h('div.top-actions', contextLink, refreshButton, saveStateEl, textButton, discardButton, tryButton, saveButton, applyButton, saveApplyButton, editButton, displayToggle())),
    sourceBand,
    h('section.title-band',
      h('div.title-main', nameInput, purpose, fileLine),
      h('div.title-side', approvalPills, h('div.title-actions', simpleApproval, validation, intentToggle, settingsToggle))),
    ctxSection.el,
    intentPanel,
    banners,
    body,
  )

  nameInput.addEventListener('input', () => { if (draft) { draft.name = nameInput.value; update(false) } })
  intentInput.addEventListener('input', () => { if (draft) { draft.intent = intentInput.value; update(false) } })

  // ---- panels ---------------------------------------------------------------

  // Intent & approvals and Workflow settings are Detail's: opening either
  // from Simple (its status, a validation issue, the policy) switches first.
  function toggleIntent(open = intentPanel.hidden === true) {
    if (open) setDisplay('detail')
    intentPanel.hidden = !open
    intentToggle.setAttribute('aria-expanded', String(open))
    intentToggle.classList.toggle('active', open)
    if (open) approverInput.focus({ preventScroll: true })
  }

  function openSettings(from: HTMLElement, section?: string) {
    setDisplay('detail')
    selection = null
    settingsOpen = true
    opener = from
    update(true)
    const target = section ? inspector.querySelector<HTMLElement>(`[data-section="${section}"]`) : null
    const head = inspector.querySelector<HTMLElement>('.insp-head h3')
    ;(target ?? head)?.scrollIntoView({ block: 'nearest' })
    ;(target ?? head)?.focus({ preventScroll: true })
  }

  function closeInspector() {
    const back = opener
    const wasNode = selection?.kind === 'node' ? selection.id : null
    selection = null
    settingsOpen = false
    opener = null
    update(true)
    if (back?.isConnected) back.focus()
    else if (wasNode) canvas.focusCard(wasNode)
  }

  // The inspector takes width from the canvas: after it opens, the selected
  // card is brought into view if it was covered.
  function revealSoon(sel: NonNullable<Selection>) {
    if (sel.kind === 'edge') return
    requestAnimationFrame(() => { if (!disposed) canvas.reveal(sel.id) })
  }

  // ---- Add node palette (base types and the person's templates) -----------

  function togglePalette(open = palette.hidden === true) {
    if (open && (readonly() || !draft)) return
    palette.hidden = !open
    addButton.setAttribute('aria-expanded', String(open))
    if (open) palette.querySelector<HTMLElement>('button:not([disabled])')?.focus()
  }
  const closePalette = (focusTrigger = false) => { if (!palette.hidden) { togglePalette(false); if (focusTrigger) addButton.focus() } }
  palette.addEventListener('keydown', e => {
    const items = [...palette.querySelectorAll<HTMLElement>('button:not([disabled]), a')]
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus() }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(true) }
  })
  const onOutside = (e: PointerEvent) => { if (!palette.hidden && !(e.target as Element).closest('.add-wrap')) closePalette() }
  document.addEventListener('pointerdown', onOutside)

  const typeItems = NODE_TYPES.map(t => h(`button.add-node.type-${t}`, { role: 'menuitem', onclick: () => { closePalette(); addNode(t) }, 'aria-label': `Add ${TYPE_LABEL[t]} node` },
    icon(t, 'icon small'), h('span.item-main', h('strong', TYPE_LABEL[t]), h('span.item-hint', TYPE_HINT[t] ?? ''))))
  // The person's templates (p7/ex1, docs/catalog.md): each adds an ordinary
  // node with the template's copy, appearance and provenance.
  const templateBar = h('div.palette-templates', { 'aria-label': 'Your node templates' })
  palette.append(h('div.palette-head', 'Basic types'), h('div.palette-group', ...typeItems), h('div.palette-head', 'Your templates'), templateBar)
  let templates: NodeTemplate[] = []
  async function loadTemplates() {
    try {
      const c = await api.catalog()
      if (c.state !== 'ok') { templates = []; templateBar.replaceChildren(h('p.chip.error', { title: c.problem }, 'Your node catalog is unavailable'), h('a.small.palette-link', { href: '#/nodes' }, 'Open User nodes')); return }
      templates = c.catalog.templates
      templateBar.replaceChildren(
        ...templates.map(t => h(`button.add-node.template${t.appearance?.color ? `.color-${t.appearance.color}` : ''}`, {
          role: 'menuitem', onclick: () => { closePalette(); addFromTemplate(t.id) }, dataset: { template: t.id },
          'aria-label': `Add ${t.name} node (your template ${t.id}, a ${TYPE_LABEL[t.type] ?? t.type} node)`,
          title: `Your template ${t.id} (revision ${t.revision}), a ${TYPE_LABEL[t.type] ?? t.type} node.\nYou expect: ${t.expectation}`,
        }, icon(t.appearance?.icon || t.type, 'icon small'), h('span.item-main', h('strong', t.name), h('span.item-hint', `${TYPE_LABEL[t.type] ?? t.type} · ${t.expectation.split('\n')[0]}`)))),
        ...(templates.length ? [] : [h('p.small.muted', 'None yet.')]),
        h('a.small.palette-link', { href: '#/nodes', title: 'Edit your node templates' }, 'Manage templates in User nodes'))
    } catch (e) { templateBar.replaceChildren(h('p.chip.error', { title: (e as Error).message }, 'Templates not read')) }
  }
  void loadTemplates()

  // ---- data ---------------------------------------------------------------

  function context(): ValidationContext {
    return {
      repositories: resp?.repositories ?? [],
      workflows: (resp?.workflows ?? []).filter(s => s.id).map(s => ({ id: s.id!, file: s.file, delegates: s.delegates, intake: s.intake })),
      file,
      // p10: delegate targets in the other registered projects.
      ...(resp?.project ? { project: resp.project } : {}),
      ...(resp?.peers ? { projects: Object.fromEntries(resp.peers.map(p => [p.project, p.workflows.map(w => ({ id: w.id, file: w.file, delegates: w.delegates, intake: w.intake }))])) } : {}),
    }
  }

  // A definition by source, as the graph reads it.
  async function read(refresh?: boolean): Promise<WorkflowResponse> {
    if (source.kind === 'published') {
      const r = await api.publishedWorkflow(wsId, file, refresh)
      pubSource = r.source
      head ??= r.source
      existingDrafts = (await api.drafts(wsId, file).catch(() => ({ drafts: [] as DraftMeta[] }))).drafts
      return r
    }
    if (source.kind === 'draft') {
      const r = await api.draft(wsId, source.id)
      adoptDraft(r)
      return r
    }
    if (source.kind === 'checkout') return api.workflow(wsId, file, refresh)
    const r = await api.run(wsId, source.workflow, source.run)
    const rec = r.record
    if (!rec) throw new Error(r.problem?.message ?? `the run ${source.workflow}/${source.run} cannot be read`)
    const root = rec.definition.root
    const revisions = ['r1', ...(r.revisions ?? []).map(x => x.revision)]
    const shown = source.revision ?? 'r1'
    const entry = shown === 'r1' ? r.bundle[root] : r.revisions?.find(x => x.revision === shown)
    if (!entry) throw new Error(`${source.workflow}/${source.run} has no definition revision ${shown}`)
    file = (rec.definition.workflows[root]?.source ?? `${root}.yaml`).replace(/^devdocs\/workflows\//, '')
    runFacts = { href: `#/ws/${encodeURIComponent(wsId)}/run/${encodeURIComponent(source.workflow)}/${encodeURIComponent(source.run)}`, text: sourceText(rec), revisions, active: rec.definition.active ?? 'r1' }
    return {
      workspace: wsId, file, rev: entry.text ?? shown, text: entry.text ?? null, workflow: entry.workflow, issues: [],
      ...(entry.workflow ? {} : { problem: { kind: 'unsupported' as const, message: 'problem' in entry && entry.problem ? String(entry.problem) : 'this definition cannot be read' } }),
      repositories: rec.context.repositories.map(c => ({ path: c.path, name: c.path, kind: c.path === '.' ? 'root' as const : 'submodule' as const, category: 'other' as const, initialized: true, dirty: c.dirty ?? 0 })),
      workflows: Object.entries(r.bundle).filter(([, b]) => b.workflow).map(([id, b]) => ({ file: b.file, id, name: b.workflow!.name, errors: 0, warnings: 0, delegates: [] })),
    }
  }

  function adoptDraft(r: DraftResponse) {
    meta = r.draft
    latest = r.latest
    pubSource = r.source
    if (r.source) head ??= r.source
    sourceProblem = r.sourceProblem ?? ''
    file = r.draft.file
    // A comparison is asked for once per published version this draft has not taken in.
    if (r.draft.state === 'open' && r.latest?.changed && comparedAt !== r.latest.sha256) { comparedAt = r.latest.sha256; void compare() }
    if (!r.latest?.changed) { comparedAt = null; mergeNote = ''; if (conflict?.kind !== 'exists') conflict = null }
  }

  interface LoadOpts { force?: boolean; contextOnly?: boolean; refresh?: boolean }
  // Loads run one at a time; merged requests never lose a content reload.
  const load = serial<LoadOpts>(async opts => {
    try {
      const r = await read(opts.refresh)
      if (disposed) return
      resp = r
      if (source.kind !== 'draft') sourceProblem = ''
      connected = true
      // A refresh that keeps the edits does not rebuild the inspector while
      // someone is typing in it; it is rebuilt on the next selection or edit.
      const typing = inspector.contains(document.activeElement)
      if (opts.contextOnly) { update(!typing); void ctxSection.reload(); return }
      const changedAtSource = r.rev !== rev
      const before = draft
      rev = r.rev
      if (r.workflow) {
        const wasDirty = dirty()
        problem = undefined
        saved = cloneWorkflow(r.workflow)
        if (!wasDirty || opts.force || !draft) {
          if (opts.force || !draft || canonicalJson(draft) !== canonicalJson(r.workflow)) draft = cloneWorkflow(r.workflow)
          if (meta) editRevision = meta.revision
          externalChange = false; saveError = ''
        } else if (changedAtSource) externalChange = true // saved elsewhere meanwhile
        if (opts.force && source.kind === 'draft') saveState = 'Reloaded the saved draft'
      } else {
        // Keep the last valid rendering (if any) and show why it cannot be used.
        problem = r.problem
        if (opts.force && saved) draft = cloneWorkflow(saved)
        if (meta) editRevision = meta.revision
        externalChange = false
      }
      syncText(r.text ?? '')
      const replaced = draft !== before
      update(replaced || !typing, replaced)
      if (changedAtSource) void ctxSection.reload()
    } catch (e) {
      if (disposed) return
      // The last graph stays, marked as what it is; a checkout never replaces it.
      sourceProblem = (e as Error).message
      if (e instanceof ApiError && e.status === 0) connected = false
      sourceState = e instanceof ApiError ? (e.detail as { state?: string } | undefined)?.state ?? '' : ''
      update(true)
    }
  }, (a, b) => ({ force: a.force || b.force, refresh: a.refresh || b.refresh, contextOnly: !!a.contextOnly && !!b.contextOnly }))
  let sourceState = ''

  function syncText(text: string) {
    if (textEdit.value === textBase || textEdit.disabled) textEdit.value = text
    textBase = text
  }
  const textDirty = () => source.kind === 'draft' && textEdit.value !== textBase

  async function loadProjectName() {
    const p = await api.project(wsId).catch(() => null)
    if (p?.project?.name) projectName = p.project.name
    const list = await api.workspaces().catch(() => null)
    // The registry's approver, only into a name nobody has typed.
    if (list?.approver && !approverInput.value && document.activeElement !== approverInput) approverInput.value = list.approver
    if (list?.approver && !whoInput.value && document.activeElement !== whoInput) whoInput.value = list.approver
    renderSource()
    renderCrumbs()
  }

  // ---- edits --------------------------------------------------------------

  function addNode(type: NodeType) {
    if (!draft || readonly()) return
    let n = 1
    while (`${type}-${n}` in draft.nodes) n++
    const id = `${type}-${n}`
    if (Object.keys(draft.nodes).some(k => !draft!.layout.nodes[k])) completeLayout(draft)
    const at = freeSlot(draft, canvas.visibleCentre(), selection?.kind === 'node' ? selection.id : undefined)
    draft.nodes[id] = type === WORKFLOW_TALK ? workflowTalkNode() : { type, name: '', description: '', repositories: [] }
    draft.layout.nodes[id] = at
    selectNew(id)
  }

  // A node from one of the person's templates: the shared instantiation
  // (unique id, copied content and appearance, provenance). Bindings are
  // chosen afterwards in the inspector, among the workflow's own.
  function addFromTemplate(templateId: string) {
    const t = templates.find(x => x.id === templateId)
    if (!draft || readonly() || !t) return
    if (Object.keys(draft.nodes).some(k => !draft!.layout.nodes[k])) completeLayout(draft)
    const at = freeSlot(draft, canvas.visibleCentre(), selection?.kind === 'node' ? selection.id : undefined)
    const r = instantiate(draft, t)
    draft.nodes[r.node] = r.workflow.nodes[r.node]
    draft.layout.nodes[r.node] = at
    selectNew(r.node)
  }

  function selectNew(id: string) {
    selection = { kind: 'node', id }
    settingsOpen = false
    update(true)
    // The new node's name, at once (a later focus could take the keyboard
    // from wherever the person went meanwhile); the card is revealed once
    // the narrower canvas is laid out.
    inspector.querySelector<HTMLInputElement>('input[aria-label="Node name"]')?.focus({ preventScroll: true })
    requestAnimationFrame(() => { if (!disposed) canvas.reveal(id) })
  }

  function connect(from: string, to: string) {
    if (!draft || readonly()) return
    if (draft.edges.some(e => e.from === from && e.to === to)) { notice = `${from} → ${to} already exists.`; update(false); return }
    draft.edges.push({ from, to })
    selection = { kind: 'edge', index: draft.edges.length - 1 }
    settingsOpen = false
    update(true)
  }

  function deleteNode(id: string) {
    if (!draft || readonly()) return
    delete draft.nodes[id]
    draft.edges = draft.edges.filter(e => e.from !== id && e.to !== id)
    delete draft.layout.nodes[id]
    for (const g of Object.values(draft.groups ?? {})) g.members = g.members.filter(m => m !== id)
    selection = null
    update(true)
  }

  function deleteEdge(index: number) {
    if (!draft || readonly()) return
    draft.edges.splice(index, 1)
    selection = null
    update(true)
  }

  // Who is acting; a person who has not said so is asked in the band.
  function actor(): string {
    const who = whoInput.value.trim()
    if (who) store(ACTOR_KEY, who)
    else { whoInput.hidden = false; renderSource(); whoInput.focus(); notice = 'Give your name: drafts and what is applied record who did it.'; renderBanners() }
    return who
  }
  const draftId = () => (source.kind === 'draft' ? source.id : '')

  // A save names the saved revision the edits were made on; another tab's
  // newer save refuses it, with these edits still here.
  async function save(): Promise<boolean> {
    if (!draft || readonly()) return false
    if (!dirty()) return true
    const by = actor()
    if (!by) return false
    saveError = ''
    saveButton.disabled = true
    saveStateEl.textContent = 'Saving…'
    try {
      const shown = draft
      const r = await api.saveDraft(wsId, draftId(), { revision: editRevision, by, workflow: shown })
      adoptDraft(r)
      editRevision = r.draft.revision
      resp = r
      rev = r.rev
      saved = cloneWorkflow(shown)
      externalChange = false
      saveState = `Draft saved ${new Date().toLocaleTimeString()}`
      syncText(r.text ?? '')
      update(false)
      void ctxSection.reload()
      return true
    } catch (e) {
      const code = e instanceof ApiError ? (e.detail as { code?: string } | undefined)?.code : undefined
      if (code === 'draft-revision-conflict') externalChange = true
      saveError = `Not saved: ${(e as Error).message}. Your edits are kept here.`
      update(false)
      return false
    }
  }

  async function saveText() {
    if (!draftOpen() || !meta) return
    const by = actor()
    if (!by) return
    try {
      await api.saveDraft(wsId, draftId(), { revision: dirty() ? editRevision : meta.revision, by, text: textEdit.value })
      saveError = ''
      textEdit.disabled = true // the saved text replaces what was typed
      await load({ force: true })
      textEdit.disabled = false
    } catch (e) { textEdit.disabled = false; saveError = `Not saved: ${(e as Error).message}. Your text is kept here.`; update(false) }
  }

  // Edit: the saved draft when one exists and the person has not asked for
  // another; a new one starts from the published definition fetched now.
  async function edit(another: boolean) {
    const by = actor()
    if (!by) return
    try {
      const r = await api.startDraft(wsId, file, by, another)
      location.hash = draftHash(wsId, file, r.draft.id)
    } catch (e) {
      const d = e instanceof ApiError ? e.detail as { code?: string; drafts?: DraftMeta[] } | undefined : undefined
      if (d?.code === 'draft-exists' && d.drafts) { existingDrafts = d.drafts; chooser = true; renderSource(); return }
      notice = `A draft could not be started: ${(e as Error).message}`
      renderBanners()
    }
  }

  async function compare() {
    if (source.kind !== 'draft') return
    try {
      const c = await api.compareDraft(wsId, source.id)
      if (disposed) return
      const cmp = c.comparison
      conflict = cmp.state === 'conflict' ? cmp.conflict : null
      mergeNote = cmp.state === 'merged' ? 'Applying keeps both: the latest version\'s changes and this draft\'s do not touch the same places.' + (c.check?.issues.length || c.check?.problem ? ' The combined definition would have validation errors.' : '') : ''
      renderSource()
    } catch { /* the band already says when the source cannot be read */ }
  }

  // Apply publishes a saved revision. A timeout, lost response or a second click
  // is answered by the journal, and the key stays until the outcome is known.
  async function apply(saving: boolean) {
    if (applying || !meta || !draftOpen()) return
    const by = actor()
    if (!by) return
    if (saving && !(await save())) return
    applying = true
    applyNote = { tone: 'warn', text: 'Applying…' }
    applyKey ||= `browser-${Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('')}`
    renderSource()
    updateActions()
    try {
      const r = await api.applyDraft(wsId, draftId(), { revision: meta!.revision, by, key: applyKey })
      meta = r.draft
      if (r.ok) {
        applyKey = ''
        const done = r.apply.noChange ? 'The published definition already was this.' : `Applied${r.duplicate ? ' (found applied earlier)' : ''}. New runs use this version; runs already created keep theirs.`
        if (r.draft.state === 'applied') { flash = done; location.hash = `#/ws/${encodeURIComponent(wsId)}/wf/${encodeURIComponent(file)}`; return }
        applyNote = { tone: 'ok', text: `${done} Newer edits saved meanwhile stay in this draft, not yet applied.` }
      } else {
        if (r.apply.outcome === 'conflict' || r.apply.outcome === 'invalid') applyKey = ''
        conflict = r.conflict ?? null
        const issues = r.issues?.map(i => i.message).join('; ')
        applyNote = {
          tone: 'error',
          text: r.apply.outcome === 'conflict' ? 'Not applied: the latest version has to be taken into account first. This draft is intact.'
            : r.apply.outcome === 'invalid' ? `Not applied: ${r.problem ?? issues ?? r.apply.error}. This draft is intact.`
              : r.apply.outcome === 'uncertain' ? `Not known yet: ${r.apply.error} Apply again to finish; nothing is published twice.`
                : `Not applied: ${r.apply.error}`,
        }
      }
      await load({})
    } catch (e) {
      // No answer: what happened is in the journal.
      applyNote = { tone: 'error', text: `No answer from the service (${(e as Error).message}). Whether it was applied is not known yet; this view checks when it reconnects, and Apply finishes it without publishing twice.` }
      await load({}).catch(() => undefined)
      if (meta?.state === 'applied' || meta?.apply?.outcome === 'applied') applyNote = { tone: 'ok', text: 'Applied: the service had finished it.' }
    } finally {
      applying = false
      renderSource()
      updateActions()
    }
  }

  async function resolveConflict(r: { text?: string; recreate?: boolean; retarget?: string }) {
    if (!meta || !conflict) return
    const by = actor()
    if (!by) return
    try {
      const res = await api.resolveDraft(wsId, draftId(), { revision: meta.revision, by, latest: conflict.latest.sha256, ...r })
      conflict = null; comparedAt = null
      applyNote = { tone: 'ok', text: 'Resolved in this draft. Apply publishes it.' }
      if (r.retarget) { location.hash = draftHash(wsId, r.retarget, draftId()); return }
      adoptDraft(res)
      textEdit.disabled = true
      await load({ force: true })
      textEdit.disabled = false
    } catch (e) {
      applyNote = { tone: 'error', text: `Not resolved: ${(e as Error).message}` }
      comparedAt = null
      await load({})
    }
    renderSource()
  }

  async function discard() {
    if (!meta || !draftOpen()) return
    const by = actor()
    if (!by || !confirm('Remove this draft? Its changes are not applied.')) return
    try {
      await api.discardDraft(wsId, draftId(), meta.revision, by)
      draft = saved // nothing left to warn about on the way out
      location.hash = `#/ws/${encodeURIComponent(wsId)}/wf/${encodeURIComponent(file)}`
    } catch (e) { saveError = `Not discarded: ${(e as Error).message}`; update(false) }
  }

  async function approve(kind: ApprovalKind) {
    approvalError = ''
    const approver = approverInput.value.trim()
    if (!approver) { approvalError = 'Enter the approver name.'; renderApprovals(); approverInput.focus(); return }
    store(APPROVER_KEY, approver)
    try {
      await api.approveDraft(wsId, draftId(), meta!.revision, kind, approver)
      await load({})
    } catch (e) {
      approvalError = `Approval refused: ${(e as Error).message}`
      renderApprovals()
    }
  }

  // An issue leads to what it is about: a node or a connection on the
  // canvas, or the settings that hold a binding or the policy.
  function showIssue(i: Issue) {
    if (i.node && draft?.nodes[i.node]) { canvas.events.select({ kind: 'node', id: i.node }); return }
    if (i.edge !== undefined && draft?.edges[i.edge]) { canvas.events.select({ kind: 'edge', index: i.edge }); return }
    openSettings(validation, i.binding ? 'bindings' : i.field === 'documentation' ? 'policy' : 'validation')
  }

  // ---- rendering ----------------------------------------------------------

  function renderCrumbs() {
    crumbs.replaceChildren(
      h('a', { href: '#/' }, 'Projects'), h('span.sep', '/'),
      h('a', { href: `#/ws/${encodeURIComponent(wsId)}` }, projectName), h('span.sep', '/'),
      ...(runFacts ? [h('a', { href: runFacts.href }, `${source.kind === 'run' ? `${source.workflow}/${source.run}` : ''}`), h('span.sep', '/')] : []),
      h('span.here', source.kind === 'run' ? 'Definition' : source.kind === 'draft' ? 'Draft' : source.kind === 'checkout' ? 'Checkout' : 'Workflow'))
  }

  function renderModeSwitch() {
    modeSwitch.replaceChildren(...(['compact', 'mini'] as DisplayMode[]).map(m => h(`button${m === mode ? '.active' : ''}`, {
      'aria-pressed': String(m === mode),
      onclick: () => { mode = m; store(MODE_KEY, m); canvas.setMode(m); update(false); canvas.fit() },
    }, m === 'compact' ? 'Compact' : 'Mini')))
  }

  const STATUS_TEXT: Record<string, string> = { approved: 'approved', stale: 'changed since approval', unapproved: 'draft' }
  function renderApprovals() {
    if (!draft) { approvalPills.replaceChildren(); return }
    const states = approvals
    const pill = (kind: ApprovalKind) => {
      const s = states?.[kind]
      const status = s?.status ?? 'unapproved'
      const label = `${kind === 'intent' ? 'Intent' : 'Definition'}: ${STATUS_TEXT[status]}`
      const title = s?.record ? `Approved by ${s.record.approver} at ${when(s.record.at)}\napproved ${s.record.digest}\ncurrent  ${s.digest}` : `current ${s?.digest ?? ''}`
      return h(`span.approval-pill.${status}`, { title, dataset: { kind, status } }, icon(status === 'approved' ? 'check' : status === 'stale' ? 'alert' : 'doc', 'icon small'), label)
    }
    const both = states?.intent.status === 'approved' && states.definition.status === 'approved'
    approvalPills.replaceChildren(...(both ? [h('span.approval-pill.approved.author', { title: 'Intent and definition are both approved as saved' }, 'Author approved')] : []), pill('intent'), pill('definition'))
    const stale = states?.intent.status === 'stale' || states?.definition.status === 'stale'
    const simple = both ? 'approved' : stale ? 'stale' : 'unapproved'
    simpleApproval.className = `simple-approval s-only approval-pill ${simple}`
    simpleApproval.dataset.status = simple
    simpleApproval.title = 'Intent & approvals: the whole intent, the approval records and the two approvals'
    simpleApproval.replaceChildren(icon(both ? 'check' : stale ? 'alert' : 'doc', 'icon small'), both ? 'Approved' : stale ? 'Changed since approval' : 'Not approved yet', icon('chevron', 'icon tiny'))
    // The panel: each approval's record, and the two separate actions.
    approvalRecords.replaceChildren(...(['intent', 'definition'] as ApprovalKind[]).map(kind => {
      const s = states?.[kind]
      const status = s?.status ?? 'unapproved'
      return h(`div.approval-record.${status}`, { dataset: { kind } },
        h('strong', kind === 'intent' ? 'Intent' : 'Definition'), ' ',
        h(`span.state-tag.${status}`, STATUS_TEXT[status]),
        h('div.small.muted', s?.record ? `${status === 'stale' ? 'Last approved' : 'Approved'} by ${s.record.approver}, ${when(s.record.at)}` : 'Not approved yet.'))
    }))
    const issues = validateWorkflow(draft, context())
    const canAct = !dirty() && !readonly()
    approveIntent.disabled = !canAct || !draft.intent.trim()
    approveDefinition.disabled = !canAct || hasErrors(issues)
    approveDefinition.title = hasErrors(issues) ? 'The definition has validation errors' : 'Approve the saved definition'
    approveIntent.hidden = approveDefinition.hidden = !draftOpen()
    approvalNote.textContent = !draftOpen() ? 'Approvals are recorded in a draft: Edit to record one.' : problem ? 'The draft cannot be read now; nothing can be approved.' : dirty() ? 'States reflect unsaved edits. Save the draft before approving.' : 'Approvals record the saved draft; a later change shows here as "changed since approval".'
    approvalErrorEl.textContent = approvalError
    approvalErrorEl.hidden = !approvalError
  }

  const publishedHash = (f = file) => `#/ws/${encodeURIComponent(wsId)}/wf/${encodeURIComponent(f)}`
  function renderBanners() {
    banners.replaceChildren()
    if (flashText) banners.append(h('div.banner.ok', flashText, h('button.icon-btn', { 'aria-label': 'Dismiss', onclick: () => { flashText = ''; renderBanners() } }, '×')))
    if (!connected) {
      banners.append(h('div.banner.warn', h('strong', 'Not connected to the editor service.'), ` What is shown may be out of date${head ? `; last checked ${when(head.fetch.at)}` : ''}. This view reads everything again when it reconnects.`))
    }
    const where = source.kind === 'draft' ? 'this draft' : source.kind === 'checkout' ? 'the checkout' : source.kind === 'run' ? 'the run\'s record' : 'the published version'
    if (problem?.kind === 'missing') {
      const moved = saved && resp?.workflows.find(w => w.id === saved!.id && w.file !== file)
      banners.append(h('div.banner.error', h('strong', `${file} is not in ${where}`), source.kind === 'published' ? ' (deleted, renamed or not applied yet). ' : ' (deleted or renamed). ',
        saved ? 'The last version is shown read-only. ' : '',
        moved ? h('a.button', { href: source.kind === 'checkout' ? `${publishedHash(moved.file)}/checkout` : publishedHash(moved.file) }, `Open ${moved.file} (same workflow id)`) : source.kind === 'published' ? 'Open the workflow from the project.' : ''))
    } else if (problem) {
      banners.append(h('div.banner.error', h('strong', `The definition in ${where} cannot be used: ${problem.kind}`), ` — ${problem.message}${problem.line ? ` (line ${problem.line}${problem.col ? `, column ${problem.col}` : ''})` : ''}. `,
        draftOpen() ? 'Repair it as text below.' : source.kind === 'published' ? 'A run of it would be refused. Edit opens its text for repair.' : ''))
    }
    if (source.kind === 'published' && sourceProblem && connected) {
      banners.append(h('div.banner.error', h('strong', sourceState === 'absent' && !resp ? 'Not yet applied.' : 'The published version cannot be read now.'), ` ${sourceProblem}`, saved ? ' The last version read is shown; it may be out of date.' : ' Nothing from a checkout is shown in its place.'))
    }
    if (source.kind === 'draft' && sourceProblem && connected) banners.append(h('div.banner.warn', `The published version cannot be read now: ${sourceProblem}. Your draft is safe; validation and applying wait for it.`))
    if (externalChange) {
      banners.append(h('div.banner.warn', `This draft was saved elsewhere${meta ? ` (revision ${meta.revision}, by ${meta.updatedBy})` : ''} while you have unsaved edits. Yours are kept here and that save is kept there. `,
        h('button', { onclick: () => void load({ force: true }) }, 'Show the saved draft (discard my edits)')))
    }
    if (saveError) banners.append(h('div.banner.error', saveError))
    if (notice) banners.append(h('div.banner.warn', notice, h('button.icon-btn', { 'aria-label': 'Dismiss', onclick: () => { notice = ''; renderBanners() } }, '×')))
  }

  // What this definition is, in simple mode too: the effect in words, revisions
  // in the details, and what a draft or a change upstream means for the next run.
  function renderSource() {
    const facts: (HTMLElement | string | null)[] = []
    const tag = (cls: string, text: string) => h(`span.source-tag.${cls}`, { dataset: { source: text } }, text)
    const d = (pubSource ?? head)
    if (source.kind === 'published') {
      facts.push(tag(sourceProblem || problem ? 'warn' : 'ok', 'Applied'), h('span', problem || (!resp && sourceProblem) ? 'The project\'s published version.' : 'What a new run uses.'))
      if (head?.fetch.state === 'stale') facts.push(h('span.source-stale', { dataset: { state: 'stale' } }, `Not up to date: Gitea could not be read (${head.fetch.error ?? 'unknown'}). Last checked ${when(head.fetch.at)}.`))
      else if (head) facts.push(h('span.small.muted', { dataset: { checked: head.fetch.at } }, `Checked ${when(head.fetch.at)}`))
    } else if (source.kind === 'draft') {
      if (meta?.state === 'applied') facts.push(tag('ok', 'Applied'), h('span', `This draft was applied${meta.apply?.updated ? ` ${when(meta.apply.updated)}` : ''}. `), h('a', { href: publishedHash() }, 'See what runs use now'))
      else if (meta?.state === 'discarded') facts.push(tag('warn', 'Discarded'), h('span', `This draft was discarded by ${meta.discarded?.by ?? 'someone'}. `), h('a', { href: publishedHash() }, 'See what runs use now'))
      else if (!meta) facts.push(h('span.small.muted', sourceProblem || 'Reading the draft…'))
      else {
        facts.push(tag('edit', 'Editing'), h('span.source-state', { dataset: { state: 'not-applied' } }, 'Changes not yet applied'), h('span.small.muted', `Draft by ${meta.author} · revision ${meta.revision}, saved ${when(meta.updated)}${meta.updatedBy !== meta.author ? ` by ${meta.updatedBy}` : ''}`))
        if (meta.provenance.kind === 'import') facts.push(h('span.small.muted', `Imported from ${meta.provenance.workspace}'s checkout (${meta.provenance.edit})`))
        if (meta.provenance.kind === 'new') facts.push(h('span.small.muted', 'A new workflow: it does not exist for runs until applied'))
      }
    } else if (source.kind === 'run' && runFacts) {
      facts.push(tag('run', 'Definition used by this run'), h('span', source.revision && source.revision !== 'r1' ? `Revision ${source.revision} of this run's definition.` : 'What this run started with.'), h('span.small.muted', `In force now: ${runFacts.active}`), h('a', { href: runFacts.href }, 'Back to the run\'s progress'), h('a', { href: publishedHash() }, 'Latest version'))
      if (runFacts.revisions.length > 1) facts.push(h('span.run-revisions', ...runFacts.revisions.map(r => h(`a.button${(source.revision ?? 'r1') === r ? '.active' : ''}`, { href: `${runFacts!.href}/definition/${r}` }, r))))
    } else if (source.kind === 'checkout') {
      facts.push(tag('warn', 'Checkout'), h('span', 'What one host\'s checkout holds. Runs do not read it.'), h('a', { href: publishedHash() }, 'See what runs use'))
    }
    if (whoNeeded()) facts.push(h('label.small.who-label', 'Your name ', whoInput))
    const details = source.kind === 'run' && runFacts ? runFacts.text
      : d ? `${d.definitions?.repository ?? d.repository}@${short(d.definitions?.commit ?? d.commit)}:${d.definitions?.path ?? 'devdocs/workflows'}/${file}${d.definitions && d.definitions.repository !== d.repository ? ` · pinned by ${d.repository}@${short(d.commit)}` : ''} on ${d.branch}${rev && source.kind === 'published' ? ` · sha256 ${(resp as { descriptor?: { digest?: string | null } } | null)?.descriptor?.digest?.slice(0, 12) ?? ''}` : ''}` : ''
    const panels: (HTMLElement | null)[] = []
    if (source.kind === 'published') {
      const newer = head && pubSource && head.commit !== pubSource.commit
      if (newer) panels.push(h('div.banner.warn', 'Latest version changed; reading it…'))
      const mine = existingDrafts
      if (chooser && mine.length) panels.push(draftsChooser(wsId, mine, (resp as { descriptor?: { digest?: string | null } } | null)?.descriptor?.digest ?? null, () => void edit(true)))
      else if (mine.length) panels.push(h('div.banner.draft-note', h('span', mine.length === 1 ? `A draft by ${mine[0]!.author} is not yet applied.` : `${mine.length} drafts are not yet applied.`), h('a.button', { href: draftHash(wsId, file, mine[0]!.id) }, mine.length === 1 ? 'Resume draft' : 'Resume the latest'), mine.length > 1 ? h('button', { type: 'button', onclick: () => { chooser = true; renderSource() } }, 'See all') : null))
    }
    if (source.kind === 'draft' && draftOpen()) {
      if (latest?.changed && !conflict) panels.push(h('div.banner.warn', h('strong', 'Latest version changed'), ` since this draft began. ${mergeNote || 'Applying takes it into account.'}`, h('a.small', { href: publishedHash(), target: '_blank' }, ' See the latest')))
      if (latest?.deleted && !conflict) panels.push(h('div.banner.warn', `${file} is not in the published version any more.`))
      if (tryOpen) panels.push(renderTry())
      if (conflict) panels.push(conflictPanel(conflict, { busy: applying, resolve: r => void resolveConflict(r), discard: () => void discard() }))
    }
    if (applyNote && source.kind === 'draft') panels.push(h(`div.banner.${applyNote.tone}`, { dataset: { apply: meta?.apply?.outcome ?? '' }, role: 'status' }, applyNote.text))
    sourceBand.replaceChildren(h('div.source-line', ...facts), details ? h('p.small.muted.d-only.source-details', details) : '', ...panels.filter((x): x is HTMLElement => !!x))
  }
  const whoNeeded = () => (source.kind === 'published' || source.kind === 'draft') && (!whoInput.value.trim() || document.activeElement === whoInput)

  // A trial: the exact saved revision, on the published code. Unsaved edits are
  // saved by the action, so the run tries what was on the screen.
  const tryText = h('textarea', { rows: 3, 'aria-label': 'What to ask this trial', placeholder: 'Your words: what this trial should do.' }) as HTMLTextAreaElement
  function renderTry(): HTMLElement {
    const src = pubSource
    const go = h('button.primary', { onclick: async () => {
      const by = actor()
      if (!by) return
      if (!tryText.value.trim()) { tryResult = h('div.banner.error', 'Give your words for the trial.'); renderSource(); return }
      if (dirty() && !(await save())) return
      tryKey ||= `browser-${Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')}`
      go.disabled = true
      try {
        const r = await api.tryDraft(wsId, draftId(), { revision: meta!.revision, text: tryText.value, author: by, receipt: tryKey, by })
        tryResult = h('div.banner.ok', `${r.duplicate ? 'Already started' : 'Started'}: `, h('a', { href: `#/ws/${encodeURIComponent(wsId)}/run/${encodeURIComponent(r.ref.workflow)}/${encodeURIComponent(r.ref.run)}` }, `${r.ref.workflow}/${r.ref.run}`), ` trying revision ${meta!.revision} of this draft.`)
        tryText.value = ''; tryKey = ''
      } catch (e) { tryResult = h('div.banner.error', `Not started: ${(e as Error).message}`) }
      renderSource()
    } }, dirty() ? 'Save and try' : 'Try this revision')
    return h('section.try-panel', { 'aria-label': 'Try this draft' },
      h('p.small', `Runs revision ${meta?.revision ?? ''} of this draft${dirty() ? ', after saving your edits as the next revision,' : ''} on the project's published code${src ? ` (${src.repository}@${short(src.commit)})` : ''}. It tries the definition: project code that is not published is not part of it. The run records this draft and revision.`),
      tryText, h('div.save-row', go), tryResult)
  }

  // The header's actions follow the source and what can be done now.
  function updateActions() {
    const open = draftOpen()
    editButton.hidden = source.kind !== 'published' || (!!sourceProblem && !resp)
    editButton.textContent = problem ? 'Edit text' : 'Edit'
    saveButton.hidden = applyButton.hidden = saveApplyButton.hidden = tryButton.hidden = discardButton.hidden = !open
    const canSave = !problem && dirty()
    saveButton.disabled = !canSave || applying
    tryButton.disabled = !!problem || applying
    applyButton.hidden ||= canSave
    applyButton.disabled = !!problem || applying
    applyButton.textContent = applying ? 'Applying…' : 'Apply'
    saveApplyButton.hidden ||= !canSave
    saveApplyButton.disabled = applying
    saveApplyButton.textContent = applying ? 'Applying…' : 'Save and apply'
    textButton.setAttribute('aria-pressed', String(textOpen))
    textButton.classList.toggle('active', textOpen)
  }

  function update(rebuildInspector: boolean, fromDisk = false) {
    if (draft?.id || saved?.id) contextLink.setAttribute('href', `#/context/${encodeURIComponent(wsId)}/${encodeURIComponent(saved?.id || draft!.id)}`)
    if (disposed) return
    renderCrumbs()
    renderModeSwitch()
    fileLine.textContent = `workflows/${file}`
    renderSource()
    updateActions()
    // The text: read-only, or a draft's own to repair.
    const textWanted = textOpen || !draft
    const writing = textWanted && draftOpen()
    textPanel.hidden = !writing
    if (!writing) rawView.textContent = resp?.text ?? ''
    rawView.hidden = !textWanted || writing || !resp?.text
    canvas.el.hidden = textWanted
    toolbar.hidden = textWanted
    if (!draft) {
      nameInput.disabled = intentInput.disabled = true
      renderBanners()
      validation.hidden = true
      policyChip.hidden = true
      addButton.disabled = arrangeButton.disabled = settingsToggle.disabled = intentToggle.disabled = true
      purpose.textContent = ''
      return
    }
    if (fromDisk || document.activeElement !== nameInput) nameInput.value = draft.name
    if (fromDisk || document.activeElement !== intentInput) intentInput.value = draft.intent
    intentInput.rows = Math.min(10, Math.max(3, intentInput.value.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 72)), 0)))
    nameInput.disabled = intentInput.disabled = readonly()
    addButton.disabled = arrangeButton.disabled = readonly()
    settingsToggle.disabled = intentToggle.disabled = false
    if (readonly()) closePalette()
    // The purpose preview: the intent's first line; the whole text is in the panel.
    // The intent's first paragraph (a hard-wrapped sentence reads as one).
    const first = draft.intent.trim().split(/\n\s*\n/)[0]?.split('\n').map(x => x.trim()).join(' ')
    purpose.replaceChildren(first ? h('span', { title: draft.intent }, first) : h('span.warn-text', 'No purpose yet — write it in Context.'))
    if (savedIntent.textContent !== (saved?.intent ?? '')) savedIntent.textContent = saved?.intent ?? ''
    guidesEditor.set(draft.execution.guides, readonly())
    sharedSave.hidden = !draftOpen()
    sharedSave.disabled = readonly() || !dirty()
    sharedState.textContent = saveStateEl.textContent
    // A workflow that exists only as this draft has no published context yet.
    ctxSection.setWorkflow(source.kind === 'draft' && meta?.base.sha256 === null ? null : saved?.id || draft.id || null)
    ctxSection.updateSummary()
    const issues = validateWorkflow(draft, context())
    const errors = issues.filter(i => i.severity === 'error'), warnings = issues.filter(i => i.severity === 'warning')
    validation.hidden = source.kind === 'run' // a run's record is what it was, not checked again
    validation.className = `v-summary${errors.length ? ' error' : warnings.length ? ' warn' : ' ok'}`
    validation.replaceChildren(icon(errors.length || warnings.length ? 'alert' : 'check', 'icon small'),
      errors.length || warnings.length ? `${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : 'Valid')
    // The same compiler run creation uses: what a run of this draft adds.
    const compiled = compile(draft)
    const effective = compiled.ok && hasDocSteps(compiled.graph) ? compiled.graph : null
    const reports = effective ? Object.values(effective.nodes).filter(n => n.step?.kind === 'report').length : 0
    const policy = draft.documentation.policy
    const steps = docSteps(draft.documentation)
    policyChip.hidden = false
    policyChip.dataset.policy = steps ? policy : 'none'
    // What a run of this draft adds, in words (p8/ex2: any of the three).
    const generated = steps ? [steps.plan && 'plan talk', steps.reports && `${reports} report${reports === 1 ? '' : 's'}`, steps.final && 'final report'].filter(Boolean).join(', ') : ''
    policyChip.replaceChildren(icon('doc', 'icon tiny'),
      !steps ? `Documentation: ${policySummary(draft.documentation)}`
        : !compiled.ok && generated ? `${policy === 'custom' ? 'Custom' : 'Default'} documentation — preview unavailable: ${compiled.message}`
          : generated ? `${policy === 'custom' ? 'Custom' : 'Default'} documentation: ${generated}` : `${policy === 'custom' ? 'Custom' : 'Manual'} documentation: no plan or reports`)
    updateActions()
    saveStateEl.textContent = source.kind !== 'draft' ? (source.kind === 'checkout' ? 'Read-only' : '') : saveError ? 'Not saved' : !draftOpen() ? 'Read-only' : problem ? 'Cannot be read' : dirty() ? 'Unsaved changes' : (saveState || 'Saved in the draft')
    saveStateEl.className = `save-state${saveError ? ' error' : dirty() ? ' dirty' : ''}`
    sharedState.textContent = saveError ? 'Not saved — see the banner above' : saveStateEl.textContent
    if (selection?.kind === 'node' && !draft.nodes[selection.id]) selection = null
    if (selection?.kind === 'edge' && !draft.edges[selection.index]) selection = null
    if (selection?.kind === 'step' && !effective?.nodes[selection.id]) selection = null
    if (selection?.kind === 'group' && !draft.groups?.[selection.id]) selection = null
    canvas.render(draft, { knowledge: knowledgeEvents, repositories: resp?.repositories ?? [], workflows: resp?.workflows ?? [], project: resp?.project, peers: resp?.peers, errorNodes: new Set(errors.map(i => i.node).filter((n): n is string => !!n)), readonly: readonly(), effective }, selection)
    const open = inspectorOpen()
    if (inspector.hidden === open) { inspector.hidden = !open; body.classList.toggle('with-inspector', open) }
    // Workflow settings are Detail's: Simple keeps them open but out of sight (p8/ex1).
    body.classList.toggle('settings-open', settingsOpen)
    settingsToggle.setAttribute('aria-pressed', String(settingsOpen))
    settingsToggle.classList.toggle('active', settingsOpen)
    hint.hidden = !!selection
    if (rebuildInspector && open) renderInspector(inspector, {
      draft, selection, repositories: resp?.repositories ?? [], workflows: resp?.workflows ?? [], issues, readonly: readonly(), file, effective, templates, project: resp?.project, peers: resp?.peers,
    }, { changed: rebuild => update(rebuild), select: sel => canvas.events.select(sel), deleteNode, deleteEdge, connect, close: closeInspector, issue: showIssue })
    renderBanners()
    renderApprovals()
    const snapshot = draft
    void approvalStates(snapshot).then(s => { if (draft === snapshot && !disposed) { approvals = s; renderApprovals() } })
  }

  // improve_workflow p3: the strip's controls edit the draft like the inspector does.
  function knowledgeHost(node: string): KnowledgeHost {
    const n = draft!.nodes[node]
    return { node, nodeName: n.name || node, project: resp?.project, readonly: readonly(), list: () => n.knowledge ?? [], set: list => { if (list.length) n.knowledge = list; else delete n.knowledge; update(true) } }
  }
  const knowledgeEvents: StripEvents = {
    category: (node, category) => { if (draft?.nodes[node]) pickFor(knowledgeHost(node), category) },
    finding: (node, ref) => { if (draft?.nodes[node]) detailFor(knowledgeHost(node), ref) },
  }

  // ---- external changes ----------------------------------------------------

  // A checkout's file changes on its disk; the service says so while this is open.
  const stream = source.kind !== 'checkout' ? null : live(api.eventsUrl(wsId), {
    classify: ev => {
      if (ev.kind === 'workflow' && ev.file === file) return ev.rev !== null && ev.rev === rev ? null : ['content']
      // Run progress never touches a definition.
      if (ev.kind === 'registry' || ev.kind === 'run' || ev.kind === 'runs') return null
      // Other workflows, the project, .gitmodules or Git state: references and repositories.
      return ['context']
    },
    flush: (needs, all) => load(all || needs.has('content') ? {} : { contextOnly: true }),
    state: c => { connected = c; renderBanners() },
  })

  // A published or draft view keeps up with the project: the default branch's
  // head, cheap and coalesced by the service, and in a draft its own revision.
  // Unsaved edits are never replaced by either.
  let polling = false
  async function poll() {
    if (disposed || polling || document.hidden || (source.kind !== 'published' && source.kind !== 'draft')) return
    polling = true
    try {
      const was = connected
      const check = await api.publishedHead(wsId).catch(e => {
        if (e instanceof ApiError && e.status !== 0) { sourceProblem = e.message; sourceState = (e.detail as { state?: string } | undefined)?.state ?? ''; return null }
        throw e
      })
      if (disposed) return
      connected = true
      if (check) head = check.source
      const moved = !!check && check.source.commit !== pubSource?.commit
      let again = !was || moved
      if (source.kind === 'draft' && meta) {
        const mine = (await api.drafts(wsId, file)).drafts.find(x => x.id === source.id)
        // Gone from the open list, or saved elsewhere, or an apply elsewhere went on.
        if (!mine || mine.revision !== meta.revision || mine.apply?.updated !== meta.apply?.updated) again = true
      }
      if (again) await load({})
      else { if (check && source.kind === 'published' && sourceProblem) { sourceProblem = ''; await load({}) } renderSource(); renderBanners() }
    } catch {
      if (connected) { connected = false; renderBanners() }
    } finally { polling = false }
  }
  const timer = setInterval(() => void poll(), POLL_MS)
  const onVisible = () => { if (!document.hidden) void poll() }
  document.addEventListener('visibilitychange', onVisible)
  whoInput.addEventListener('blur', () => { if (whoInput.value.trim()) { store(ACTOR_KEY, whoInput.value.trim()); renderSource() } })

  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (draftOpen()) void save(); return }
    if (t.closest('input, textarea, select')) return
    if (e.key === 'Escape') {
      if (!palette.hidden) { closePalette(true); return }
      if (inspectorOpen() && !t.closest('.palette')) { e.preventDefault(); closeInspector(); return }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection && !t.closest('.inspector')) {
      e.preventDefault()
      if (selection.kind === 'node') deleteNode(selection.id); else if (selection.kind === 'edge') deleteEdge(selection.index)
    }
  }
  window.addEventListener('keydown', onKey)

  renderCrumbs()
  void load({})
  renderSource()
  updateActions()
  void loadProjectName()
  if (opts.context) requestAnimationFrame(() => ctxSection.reveal(false))

  return {
    dispose: () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); offDisplay(); stream?.close(); canvas.dispose(); ctxSection.dispose(); window.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onOutside) },
    isDirty: () => dirty() || textDirty() || ctxSection.isDirty(),
  }
}
