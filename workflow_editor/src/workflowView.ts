// Workflow editor: top area (name, intent, validation, save, approvals),
// canvas and inspector. The file on disk is the authority; the view holds a
// draft until an explicit Save, and guards the draft against external changes.
import type { FileProblem, WorkflowResponse } from '../shared/api.ts'
import { approvalStates, canonicalJson, type ApprovalState } from '../shared/canonical.ts'
import { NODE_TYPES, cloneWorkflow, type ApprovalKind, type NodeType, type Workflow } from '../shared/model.ts'
import { hasErrors, validateWorkflow, type ValidationContext } from '../shared/validate.ts'
import { api } from './api.ts'
import { live, serial } from './live.ts'
import { Canvas, TYPE_LABEL, type Selection } from './canvas.ts'
import { h, when } from './dom.ts'
import { icon } from './icons.ts'
import { renderInspector } from './inspector.ts'
import { autoArrange, completeLayout, freeSlot, type DisplayMode } from '../shared/layout.ts'
import type { ViewHandle } from './main.ts'

const MODE_KEY = 'workflow-editor.mode'
const APPROVER_KEY = 'workflow-editor.approver'
function stored(key: string, fallback: string) { try { return localStorage.getItem(key) ?? fallback } catch { return fallback } }
function store(key: string, value: string) { try { localStorage.setItem(key, value) } catch { /* per-viewer convenience only */ } }

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
  let mode = stored(MODE_KEY, 'compact') as DisplayMode
  let projectName = 'Project'
  let approvals: Record<ApprovalKind, ApprovalState> | null = null
  let approvalError = ''
  let defaultApprover = ''
  let disposed = false
  let connected = true

  const dirty = () => !!draft && !!saved && canonicalJson(draft) !== canonicalJson(saved)
  const readonly = () => !!problem

  // ---- static structure (inputs keep focus across updates) --------------
  // Disabled until the file is loaded, so nothing typed early is overwritten.
  const nameInput = h('input.wf-name', { 'aria-label': 'Workflow name', placeholder: 'Workflow name', disabled: true })
  const intentInput = h('textarea.intent-text', { rows: 3, 'aria-label': 'Workflow intent', placeholder: 'What this workflow is for. Everything else is reviewed against it.', disabled: true })
  const crumbs = h('div.crumbs')
  const saveButton = h('button.primary', { onclick: () => void save() }, 'Save')
  const refreshButton = h('button', { title: 'Re-read the file and the repositories\' Git state now', onclick: () => void load({ refresh: true }) }, 'Refresh')
  const saveStateEl = h('span.save-state')
  const modeSwitch = h('div.mode-switch', { role: 'group', 'aria-label': 'Display mode' })
  const approvalBox = h('div.approval-box')
  const statusLine = h('div.status-line')
  const banners = h('div.banners')
  const toolbar = h('div.toolbar')
  const inspector = h('aside.inspector', { 'aria-label': 'Inspector' })
  const canvas = new Canvas({
    select: sel => { selection = sel; update(true) },
    move: (id, p) => {
      if (!draft || readonly()) return
      if (Object.keys(draft.nodes).some(n => !draft!.layout.nodes[n])) completeLayout(draft)
      draft.layout.nodes[id] = p
      update(false)
    },
    connect: (from, to) => connect(from, to),
  })
  canvas.setMode(mode)
  const rawView = h('pre.raw')

  root.append(
    h('header.wf-top',
      h('div.wf-row1', crumbs, h('div.top-actions', modeSwitch, refreshButton, saveStateEl, saveButton)),
      h('div.wf-row2',
        h('div.wf-title', nameInput, approvalBox),
        h('div.intent-box', icon('intent', 'icon intent-icon'), h('div.intent-main', h('label', { htmlFor: 'intent' }, 'Workflow Intent (Ground Truth)'), intentInput))),
      statusLine, banners),
    h('main.wf-body', h('div.canvas-col', toolbar, canvas.el, rawView), inspector),
  )
  intentInput.id = 'intent'

  nameInput.addEventListener('input', () => { if (draft) { draft.name = nameInput.value; update(false) } })
  intentInput.addEventListener('input', () => { if (draft) { draft.intent = intentInput.value; update(false) } })

  for (const t of NODE_TYPES) {
    toolbar.append(h(`button.add-node.type-${t}`, { onclick: () => addNode(t), 'aria-label': `Add ${TYPE_LABEL[t]} node` }, icon(t, 'icon small'), `+ ${TYPE_LABEL[t]}`))
  }
  toolbar.append(h('button.arrange', {
    title: 'Lay the graph out by rank. Only positions change; approvals are unaffected.',
    onclick: () => { if (!draft || readonly()) return; autoArrange(draft); update(false); canvas.fit() },
  }, 'Auto-arrange'))
  toolbar.append(h('span.toolbar-hint', 'Drag a card to move it, drag its right handle onto another card to connect, drag the background to pan.'))

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
    defaultApprover = list?.approver ?? ''
    renderCrumbs()
    renderApprovals()
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
    selection = { kind: 'node', id }
    update(true)
    canvas.reveal(id)
  }

  function connect(from: string, to: string) {
    if (!draft || readonly()) return
    if (draft.edges.some(e => e.from === from && e.to === to)) { notice = `${from} → ${to} already exists.`; update(false); return }
    draft.edges.push({ from, to })
    selection = { kind: 'edge', index: draft.edges.length - 1 }
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
    const approver = (document.getElementById('approver') as HTMLInputElement | null)?.value.trim() ?? ''
    if (!approver) { approvalError = 'Enter the approver name.'; renderApprovals(); return }
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

  // ---- rendering ----------------------------------------------------------

  function renderCrumbs() {
    crumbs.replaceChildren(
      h('a', { href: '#/' }, 'Projects'), h('span.sep', '/'),
      h('a', { href: `#/ws/${encodeURIComponent(wsId)}` }, projectName), h('span.sep', '/'),
      h('span.muted', `workflows/${file}`), h('span.pill', `workspace ${wsId}`))
  }

  function renderModeSwitch() {
    modeSwitch.replaceChildren(...(['compact', 'mini'] as DisplayMode[]).map(m => h(`button${m === mode ? '.active' : ''}`, {
      'aria-pressed': String(m === mode),
      onclick: () => { mode = m; store(MODE_KEY, m); canvas.setMode(m); update(false); canvas.fit() },
    }, m === 'compact' ? 'Compact' : 'Mini')))
  }

  function renderApprovals() {
    approvalBox.replaceChildren()
    if (!draft) return
    const states = approvals
    const pill = (kind: ApprovalKind) => {
      const s = states?.[kind]
      const status = s?.status ?? 'unapproved'
      const label = `${kind === 'intent' ? 'Intent' : 'Definition'}: ${status === 'approved' ? 'approved' : status === 'stale' ? 'changed since approval' : 'draft'}`
      const title = s?.record ? `Approved by ${s.record.approver} at ${when(s.record.at)}\napproved ${s.record.digest}\ncurrent  ${s.digest}` : `current ${s?.digest ?? ''}`
      return h(`span.approval-pill.${status}`, { title, dataset: { kind, status } }, icon(status === 'approved' ? 'check' : status === 'stale' ? 'alert' : 'doc', 'icon small'), label,
        s?.record ? h('span.by', ` · ${s.record.approver}`) : null)
    }
    const both = states?.intent.status === 'approved' && states.definition.status === 'approved'
    approvalBox.append(h('div.pills', both ? h('span.approval-pill.approved.author', icon('check', 'icon small'), 'Author Approved') : null, pill('intent'), pill('definition')))
    if (dirty()) approvalBox.append(h('span.muted.small', 'States reflect the unsaved draft. Save before approving.'))
    const issues = validateWorkflow(draft, context())
    const canAct = !dirty() && !readonly()
    const approver = h('input#approver', { value: stored(APPROVER_KEY, defaultApprover), placeholder: 'approver', 'aria-label': 'Approver', size: 12 })
    approvalBox.append(h('div.approve-actions',
      h('label.small', 'Declared approver ', approver),
      h('button', { disabled: !canAct || !draft.intent.trim(), onclick: () => void approve('intent'), title: 'Approve the saved intent' }, 'Approve intent'),
      h('button', { disabled: !canAct || hasErrors(issues), onclick: () => void approve('definition'), title: hasErrors(issues) ? 'The definition has validation errors' : 'Approve the saved definition' }, 'Approve definition')))
    if (approvalError) approvalBox.append(h('p.error.small', approvalError))
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
    if (notice) banners.append(h('div.banner.warn', notice, h('button.icon-btn', { onclick: () => { notice = ''; renderBanners() } }, '×')))
  }

  function update(rebuildInspector: boolean, fromDisk = false) {
    if (disposed) return
    renderCrumbs()
    renderModeSwitch()
    if (!draft) {
      nameInput.disabled = intentInput.disabled = true
      rawView.textContent = resp?.text ?? ''
      rawView.hidden = !resp?.text
      canvas.el.hidden = true
      renderBanners()
      statusLine.replaceChildren()
      saveButton.disabled = true
      return
    }
    canvas.el.hidden = false
    rawView.hidden = true
    if (fromDisk || document.activeElement !== nameInput) nameInput.value = draft.name
    if (fromDisk || document.activeElement !== intentInput) intentInput.value = draft.intent
    intentInput.rows = Math.min(8, Math.max(2, intentInput.value.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 56)), 0)))
    nameInput.disabled = intentInput.disabled = readonly()
    for (const b of toolbar.querySelectorAll('button')) (b as HTMLButtonElement).disabled = readonly()
    const issues = validateWorkflow(draft, context())
    const errors = issues.filter(i => i.severity === 'error'), warnings = issues.filter(i => i.severity === 'warning')
    statusLine.replaceChildren(
      h(`span.v-summary${errors.length ? '.error' : warnings.length ? '.warn' : '.ok'}`, icon(errors.length ? 'alert' : 'check', 'icon small'),
        errors.length || warnings.length ? `${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : 'Structure and references valid'),
      ...(errors.length ? [h('span.muted.small', 'Drafts with errors can be saved but not approved. Select nothing to see the full list.')] : []),
    )
    saveButton.disabled = readonly() || !dirty()
    saveStateEl.textContent = saveError ? 'Save failed' : problem ? 'Read-only' : dirty() ? 'Unsaved changes' : (saveState || 'Saved')
    saveStateEl.className = `save-state${saveError ? ' error' : dirty() ? ' dirty' : ''}`
    if (selection?.kind === 'node' && !draft.nodes[selection.id]) selection = null
    if (selection?.kind === 'edge' && !draft.edges[selection.index]) selection = null
    canvas.render(draft, { repositories: resp?.repositories ?? [], workflows: resp?.workflows ?? [], errorNodes: new Set(errors.map(i => i.node).filter((n): n is string => !!n)), readonly: readonly() }, selection)
    if (rebuildInspector) renderInspector(inspector, {
      draft, selection, repositories: resp?.repositories ?? [], workflows: resp?.workflows ?? [], issues, readonly: readonly(), file,
    }, { changed: rebuild => update(rebuild), select: sel => { selection = sel; update(true) }, deleteNode, deleteEdge, connect })
    renderBanners()
    const snapshot = draft
    void approvalStates(snapshot).then(s => { if (draft === snapshot) { approvals = s; renderApprovals() } })
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
    if (t.closest('input, textarea, select')) return
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection) {
      e.preventDefault()
      if (selection.kind === 'node') deleteNode(selection.id); else deleteEdge(selection.index)
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save() }
  }
  window.addEventListener('keydown', onKey)

  renderCrumbs()
  void load({}).then(() => canvas.fit())
  void loadProjectName()

  return {
    dispose: () => { disposed = true; stream.close(); window.removeEventListener('keydown', onKey) },
    isDirty: dirty,
  }
}
