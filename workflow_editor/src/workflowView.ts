// Workflow editor: a slim header (crumbs, save), a title band (name,
// purpose, approval states, validation and the two explicit entry points —
// "Intent & approvals" and "Workflow settings"), the canvas with its toolbar,
// and an inspector that opens for a selection or for settings (p8). The file
// on disk is the authority; the view holds a draft until an explicit Save,
// and guards the draft against external changes. Opening or closing a panel
// never saves or discards anything: every panel edits the same draft.
import type { FileProblem, WorkflowResponse } from '../shared/api.ts'
import { approvalStates, canonicalJson, type ApprovalState } from '../shared/canonical.ts'
import { compile, hasDocSteps } from '../shared/compile.ts'
import { policySummary } from './docPolicy.ts'
import { NODE_TYPES, cloneWorkflow, docSteps, type ApprovalKind, type Issue, type NodeType, type Workflow } from '../shared/model.ts'
import { instantiate, type NodeTemplate } from '../shared/catalog.ts'
import { hasErrors, validateWorkflow, type ValidationContext } from '../shared/validate.ts'
import { api } from './api.ts'
import { live, serial } from './live.ts'
import { Canvas, TYPE_LABEL, type Selection } from './canvas.ts'
import { h, when } from './dom.ts'
import { icon } from './icons.ts'
import { renderInspector } from './inspector.ts'
import { displayToggle, isSimple, onDisplay, setDisplay } from './displayMode.ts'
import { autoArrange, completeLayout, freeSlot, type DisplayMode } from '../shared/layout.ts'
import type { ViewHandle } from './main.ts'

const MODE_KEY = 'workflow-editor.mode'
const APPROVER_KEY = 'workflow-editor.approver'
function stored(key: string, fallback: string) { try { return localStorage.getItem(key) ?? fallback } catch { return fallback } }
function store(key: string, value: string) { try { localStorage.setItem(key, value) } catch { /* per-viewer convenience only */ } }

// What each base type is for, in the Add node palette.
const TYPE_HINT: Record<string, string> = {
  study: 'Read, research, compare',
  do: 'Change or produce something',
  talk: 'Ask or agree with a person',
  delegate: 'Hand off to another workflow (display only)',
}

export function renderWorkflowView(root: HTMLElement, wsId: string, file: string): ViewHandle {
  let resp: WorkflowResponse | null = null
  let saved: Workflow | null = null // last valid content read from disk
  let draft: Workflow | null = null
  let rev: string | null = null
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
  const readonly = () => !!problem
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
  const saveButton = h('button.primary', { onclick: () => void save() }, 'Save')
  const refreshButton = h('button.ghost-dark.d-only', { title: 'Re-read the file and the repositories\' Git state now', onclick: () => void load({ refresh: true }) }, 'Refresh')
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
  const intentPanel = h('section.intent-panel.d-only#intent-panel', { hidden: true, 'aria-label': 'Intent and approvals' },
    h('div.intent-col',
      h('label.panel-label', { htmlFor: 'intent' }, icon('intent', 'icon small'), 'Workflow intent (ground truth)'),
      intentInput,
      h('p.small.muted', 'Everything else in the workflow is reviewed against this text. Approving it records the saved text and its digest.')),
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
  const body = h('main.wf-body', h('div.canvas-col', toolbar, canvas.el, rawView), inspector)

  root.append(
    h('header.app-header', crumbs, h('div.top-actions', refreshButton, saveStateEl, saveButton, displayToggle())),
    h('section.title-band',
      h('div.title-main', nameInput, purpose, fileLine),
      h('div.title-side', approvalPills, h('div.title-actions', simpleApproval, validation, intentToggle, settingsToggle))),
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
    if (open) intentInput.focus({ preventScroll: true })
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
      workflows: (resp?.workflows ?? []).filter(s => s.id).map(s => ({ id: s.id!, file: s.file, delegates: s.delegates })),
      file,
    }
  }

  interface LoadOpts { force?: boolean; contextOnly?: boolean; refresh?: boolean }
  // Loads run one at a time; merged requests never lose a content reload.
  const load = serial<LoadOpts>(async opts => {
    try {
      const r = await api.workflow(wsId, file, opts.refresh)
      if (disposed) return
      resp = r
      // A refresh that keeps the draft does not rebuild the inspector while
      // someone is typing in it; it is rebuilt on the next selection or edit.
      const typing = inspector.contains(document.activeElement)
      if (opts.contextOnly) { update(!typing); return }
      const changedOnDisk = r.rev !== rev
      const before = draft
      rev = r.rev
      if (r.workflow) {
        const wasDirty = dirty()
        problem = undefined
        saved = cloneWorkflow(r.workflow)
        if (!wasDirty || opts.force || !draft) {
          if (opts.force || !draft || canonicalJson(draft) !== canonicalJson(r.workflow)) draft = cloneWorkflow(r.workflow)
          externalChange = false; saveError = ''
        } else if (changedOnDisk) externalChange = true // e.g. edited while the stream was down
        if (opts.force) saveState = 'Reloaded from disk'
      } else {
        // Keep the last valid rendering (if any) and show why the file cannot be used.
        problem = r.problem
        if (opts.force && saved) draft = cloneWorkflow(saved)
        externalChange = false
      }
      const replaced = draft !== before
      update(replaced || !typing, replaced)
    } catch (e) {
      notice = (e as Error).message
      update(true)
    }
  }, (a, b) => ({ force: a.force || b.force, refresh: a.refresh || b.refresh, contextOnly: !!a.contextOnly && !!b.contextOnly }))

  async function loadProjectName() {
    const p = await api.project(wsId).catch(() => null)
    if (p?.project?.name) projectName = p.project.name
    const list = await api.workspaces().catch(() => null)
    // The registry's approver, only into a name nobody has typed.
    if (list?.approver && !approverInput.value && document.activeElement !== approverInput) approverInput.value = list.approver
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
    draft.nodes[id] = { type, name: '', description: '', repositories: [] }
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
    selection = null
    update(true)
  }

  function deleteEdge(index: number) {
    if (!draft || readonly()) return
    draft.edges.splice(index, 1)
    selection = null
    update(true)
  }

  async function save() {
    if (!draft || readonly() || !dirty()) return
    saveError = ''
    saveButton.disabled = true
    saveStateEl.textContent = 'Saving…'
    try {
      const r = await api.saveWorkflow(wsId, file, draft)
      rev = r.rev
      saved = cloneWorkflow(draft)
      externalChange = false
      saveState = `Saved ${new Date().toLocaleTimeString()}`
      await load({ contextOnly: true })
    } catch (e) {
      saveError = `Save failed: ${(e as Error).message}. The draft is kept; retry when resolved.`
      update(false)
    }
  }

  async function approve(kind: ApprovalKind) {
    approvalError = ''
    const approver = approverInput.value.trim()
    if (!approver) { approvalError = 'Enter the approver name.'; renderApprovals(); approverInput.focus(); return }
    store(APPROVER_KEY, approver)
    try {
      const r = await api.approve(wsId, file, kind, approver)
      rev = r.rev
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
      h('span.here', 'Workflow'))
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
    approvalNote.textContent = readonly() ? 'The file cannot be used now; nothing can be approved.' : dirty() ? 'States reflect the unsaved draft. Save before approving.' : 'Approvals record the saved file; a later change shows here as "changed since approval".'
    approvalErrorEl.textContent = approvalError
    approvalErrorEl.hidden = !approvalError
  }

  function renderBanners() {
    banners.replaceChildren()
    if (!connected) {
      banners.append(h('div.banner.warn', h('strong', 'Not connected to the editor service.'), ' Changes on disk are not shown until it reconnects; this view re-reads everything when it does.'))
    }
    if (problem?.kind === 'missing') {
      const moved = saved && resp?.workflows.find(w => w.id === saved!.id && w.file !== file)
      banners.append(h('div.banner.error', h('strong', `${file} no longer exists on disk`), ' (deleted or renamed). ',
        saved ? 'The last version is shown read-only; saving is disabled and nothing is recreated. ' : '',
        moved ? h('a.button', { href: `#/ws/${encodeURIComponent(wsId)}/wf/${encodeURIComponent(moved.file)}` }, `Open ${moved.file} (same workflow id)`) : 'Restore the file, or open the workflow under its new name from the project.'))
    } else if (problem) {
      banners.append(h('div.banner.error', h('strong', `The file on disk cannot be used: ${problem.kind}`), ` — ${problem.message}${problem.line ? ` (line ${problem.line}${problem.col ? `, column ${problem.col}` : ''})` : ''}. `,
        saved ? 'Showing the last valid version read-only; saving is disabled so it cannot overwrite the file. Fix the file and the editor recovers.' : 'Fix the file; the editor reloads when it changes.'))
    }
    if (externalChange) {
      banners.append(h('div.banner.warn', 'The file changed on disk while you have unsaved edits. Your draft is kept. ',
        h('button', { onclick: () => void load({ force: true }) }, 'Reload from disk (discard my edits)')))
    }
    if (saveError) banners.append(h('div.banner.error', saveError))
    if (notice) banners.append(h('div.banner.warn', notice, h('button.icon-btn', { 'aria-label': 'Dismiss', onclick: () => { notice = ''; renderBanners() } }, '×')))
  }

  function update(rebuildInspector: boolean, fromDisk = false) {
    if (disposed) return
    renderCrumbs()
    renderModeSwitch()
    fileLine.textContent = `workflows/${file} · workspace ${wsId}`
    if (!draft) {
      nameInput.disabled = intentInput.disabled = true
      rawView.textContent = resp?.text ?? ''
      rawView.hidden = !resp?.text
      canvas.el.hidden = true
      renderBanners()
      validation.hidden = true
      policyChip.hidden = true
      saveButton.disabled = true
      addButton.disabled = arrangeButton.disabled = settingsToggle.disabled = intentToggle.disabled = true
      purpose.textContent = ''
      return
    }
    canvas.el.hidden = false
    rawView.hidden = true
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
    purpose.replaceChildren(first ? h('span', { title: draft.intent }, first) : h('span.warn-text', 'No intent yet — write it under Intent & approvals.'))
    const issues = validateWorkflow(draft, context())
    const errors = issues.filter(i => i.severity === 'error'), warnings = issues.filter(i => i.severity === 'warning')
    validation.hidden = false
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
    saveButton.disabled = readonly() || !dirty()
    saveStateEl.textContent = saveError ? 'Save failed' : problem ? 'Read-only' : dirty() ? 'Unsaved changes' : (saveState || 'Saved')
    saveStateEl.className = `save-state${saveError ? ' error' : dirty() ? ' dirty' : ''}`
    if (selection?.kind === 'node' && !draft.nodes[selection.id]) selection = null
    if (selection?.kind === 'edge' && !draft.edges[selection.index]) selection = null
    if (selection?.kind === 'step' && !effective?.nodes[selection.id]) selection = null
    canvas.render(draft, { repositories: resp?.repositories ?? [], workflows: resp?.workflows ?? [], errorNodes: new Set(errors.map(i => i.node).filter((n): n is string => !!n)), readonly: readonly(), effective }, selection)
    const open = inspectorOpen()
    if (inspector.hidden === open) { inspector.hidden = !open; body.classList.toggle('with-inspector', open) }
    // Workflow settings are Detail's: Simple keeps them open but out of sight (p8/ex1).
    body.classList.toggle('settings-open', settingsOpen)
    settingsToggle.setAttribute('aria-pressed', String(settingsOpen))
    settingsToggle.classList.toggle('active', settingsOpen)
    hint.hidden = !!selection
    if (rebuildInspector && open) renderInspector(inspector, {
      draft, selection, repositories: resp?.repositories ?? [], workflows: resp?.workflows ?? [], issues, readonly: readonly(), file, effective, templates,
    }, { changed: rebuild => update(rebuild), select: sel => canvas.events.select(sel), deleteNode, deleteEdge, connect, close: closeInspector, issue: showIssue })
    renderBanners()
    renderApprovals()
    const snapshot = draft
    void approvalStates(snapshot).then(s => { if (draft === snapshot && !disposed) { approvals = s; renderApprovals() } })
  }

  // ---- external changes ----------------------------------------------------

  const stream = live(api.eventsUrl(wsId), {
    classify: ev => {
      if (ev.kind === 'workflow' && ev.file === file) {
        if (ev.rev !== null && ev.rev === rev) return null // our own save, or content we already show
        if (dirty() && ev.rev !== null) { externalChange = true; renderBanners(); return null }
        return ['content']
      }
      // Run progress never touches a definition or its draft.
      if (ev.kind === 'registry' || ev.kind === 'run' || ev.kind === 'runs') return null
      // Other workflows, the project, .gitmodules or Git state: references and repositories.
      return ['context']
    },
    flush: (needs, all) => load(all || needs.has('content') ? {} : { contextOnly: true }),
    state: c => { connected = c; renderBanners() },
  })

  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save(); return }
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
  void loadProjectName()

  return {
    dispose: () => { disposed = true; offDisplay(); stream.close(); canvas.dispose(); window.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onOutside) },
    isDirty: dirty,
  }
}
