// The inspector edits the selected node or edge, or the workflow's repository
// bindings when nothing is selected. It mutates the draft and tells the view
// whether the inspector itself must be rebuilt (structure) or not (typing).
import type { RepositoryStatus, WorkflowSummary } from '../shared/api.ts'
import { ACCESS_LEVELS, ID_PATTERN, NODE_TYPES, normalizeRepoPath, type Issue, type Workflow } from '../shared/model.ts'
import { bindingCategory, TYPE_LABEL, type Selection } from './canvas.ts'
import { h } from './dom.ts'
import { icon } from './icons.ts'

export interface InspectorContext {
  draft: Workflow
  selection: Selection
  repositories: RepositoryStatus[]
  workflows: WorkflowSummary[]
  issues: Issue[]
  readonly: boolean
  file: string
}

export interface InspectorActions {
  changed(rebuild: boolean): void
  select(sel: Selection): void
  deleteNode(id: string): void
  deleteEdge(index: number): void
  connect(from: string, to: string): void
}

const nodeLabel = (w: Workflow, id: string) => (w.nodes[id]?.name || id)

function issueList(issues: Issue[], actions: InspectorActions): HTMLElement {
  return h('ul.issues', issues.map(i => h(`li.${i.severity}`, {
    onclick: () => { if (i.node) actions.select({ kind: 'node', id: i.node }); else if (i.edge !== undefined) actions.select({ kind: 'edge', index: i.edge }) },
    style: { cursor: i.node || i.edge !== undefined ? 'pointer' : 'default' },
  }, i.message)))
}

function resolveRepo(ctx: InspectorContext, path: string) {
  const p = normalizeRepoPath(path)
  if (p === '.') return ctx.repositories.find(r => r.path === '.')
  return p ? ctx.repositories.find(r => r.path === p) : undefined
}

export function renderInspector(panel: HTMLElement, ctx: InspectorContext, actions: InspectorActions) {
  panel.replaceChildren()
  const sel = ctx.selection
  if (sel?.kind === 'node' && ctx.draft.nodes[sel.id]) panel.append(...nodePanel(ctx, sel.id, actions))
  else if (sel?.kind === 'edge' && ctx.draft.edges[sel.index]) panel.append(...edgePanel(ctx, sel.index, actions))
  else panel.append(...workflowPanel(ctx, actions))
}

function nodePanel(ctx: InspectorContext, id: string, actions: InspectorActions): HTMLElement[] {
  const w = ctx.draft
  const n = w.nodes[id]
  const ro = ctx.readonly
  const typeOptions = (NODE_TYPES as readonly string[]).includes(n.type) ? [...NODE_TYPES] : [n.type, ...NODE_TYPES]
  const out: HTMLElement[] = [
    h('div.insp-head', icon((NODE_TYPES as readonly string[]).includes(n.type) ? n.type : 'unknown', 'icon'), h('h3', nodeLabel(w, id)), h('code', id)),
    h('label.field', h('span', 'Type'), h('select', {
      disabled: ro, 'aria-label': 'Node type',
      onchange: (e: Event) => { n.type = (e.target as HTMLSelectElement).value; actions.changed(true) },
    }, typeOptions.map(t => h('option', { value: t, selected: t === n.type }, TYPE_LABEL[t] ?? `${t || '(none)'} — unknown`)))),
    h('label.field', h('span', 'Name'), h('input', { value: n.name, disabled: ro, 'aria-label': 'Node name', placeholder: TYPE_LABEL[n.type] ?? '', oninput: (e: Event) => { n.name = (e.target as HTMLInputElement).value; actions.changed(false) } })),
    h('label.field', h('span', 'Description'), h('textarea', { rows: 5, value: n.description, disabled: ro, 'aria-label': 'Node description', oninput: (e: Event) => { n.description = (e.target as HTMLTextAreaElement).value; actions.changed(false) } })),
  ]
  if (n.type === 'delegate' || n.workflow) {
    const known = ctx.workflows.filter(s => s.id)
    const options = [h('option', { value: '' }, '— choose a workflow —'), ...known.map(s => h('option', { value: s.id!, selected: s.id === n.workflow }, `${s.name || s.id} (${s.id})${s.file === ctx.file ? ' — this workflow' : ''}`))]
    if (n.workflow && !known.some(s => s.id === n.workflow)) options.push(h('option', { value: n.workflow, selected: true }, `${n.workflow} (missing)`))
    out.push(h('label.field', h('span', n.type === 'delegate' ? 'Delegate to workflow' : 'Target workflow (only used by delegate nodes)'), h('select', {
      disabled: ro, 'aria-label': 'Delegate target',
      onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) n.workflow = v; else delete n.workflow; actions.changed(true) },
    }, options)))
    if (n.type === 'delegate') out.push(h('p.banner.warn.small', 'Delegate execution is not supported: this node is definition and display only, and runs of a workflow with a delegate node are refused by the browser, the API and the CLI alike.'))
  }
  // Repository bindings of this node
  const bindings = Object.entries(w.repositories)
  const repoBox = h('div.field', h('span', 'Repositories'))
  if (!bindings.length) repoBox.append(h('p.muted.small', 'This workflow declares no repository bindings. Add them with nothing selected.'))
  for (const [key, b] of bindings) {
    const repo = resolveRepo(ctx, b.path)
    repoBox.append(h('label.check', h('input', {
      type: 'checkbox', checked: n.repositories.includes(key), disabled: ro, 'aria-label': `Bind ${key}`,
      onchange: (e: Event) => {
        if ((e.target as HTMLInputElement).checked) n.repositories.push(key)
        else n.repositories = n.repositories.filter(r => r !== key)
        actions.changed(true)
      },
    }), icon(bindingCategory(b.path), 'icon small'), h('span', key), h('span.muted.small', b.path),
    h(`span.access-badge.${repo ? (b.access === 'editable' ? 'editable' : 'readonly') : 'unresolved'}`, repo ? (b.access === 'editable' ? 'Editable' : 'Read-only') : 'unresolved')))
  }
  for (const ref of n.repositories.filter(r => !(r in w.repositories))) {
    repoBox.append(h('div.check.unresolved', icon('alert', 'icon small'), h('span', `${ref} — not declared`),
      h('button.icon-btn', { disabled: ro, title: 'Remove reference', onclick: () => { n.repositories = n.repositories.filter(r => r !== ref); actions.changed(true) } }, '×')))
  }
  out.push(repoBox)
  // Connections
  const incoming = w.edges.map((e, i) => ({ e, i })).filter(x => x.e.to === id)
  const outgoing = w.edges.map((e, i) => ({ e, i })).filter(x => x.e.from === id)
  const edgeRow = (label: string, i: number) => h('li', h('a', { href: '#', onclick: (ev: Event) => { ev.preventDefault(); actions.select({ kind: 'edge', index: i }) } }, label),
    h('button.icon-btn', { disabled: ro, title: 'Delete connection', 'aria-label': `Delete connection ${label}`, onclick: () => actions.deleteEdge(i) }, '×'))
  const targets = Object.keys(w.nodes).filter(t => t !== id && !w.edges.some(e => e.from === id && e.to === t))
  const pick = h('select', { disabled: ro, 'aria-label': 'Connect to node' }, h('option', { value: '' }, '— node —'), targets.map(t => h('option', { value: t }, `${nodeLabel(w, t)} (${t})`)))
  out.push(h('div.field', h('span', 'Waits for'), incoming.length ? h('ul.edges-list', incoming.map(x => edgeRow(`${nodeLabel(w, x.e.from)} → this`, x.i))) : h('p.muted.small', 'Nothing: starts when the workflow starts.')),
    h('div.field', h('span', 'Then'), outgoing.length ? h('ul.edges-list', outgoing.map(x => edgeRow(`this → ${nodeLabel(w, x.e.to)}`, x.i))) : h('p.muted.small', 'Nothing: an end of the workflow.'),
      h('div.row.tight', pick, h('button', { disabled: ro, onclick: () => { if (pick.value) actions.connect(id, pick.value) } }, 'Connect'))))
  const nodeIssues = ctx.issues.filter(i => i.node === id)
  if (nodeIssues.length) out.push(issueList(nodeIssues, actions))
  out.push(h('div.insp-foot', h('button.danger', { disabled: ro, onclick: () => actions.deleteNode(id) }, 'Delete node')))
  return out
}

function edgePanel(ctx: InspectorContext, index: number, actions: InspectorActions): HTMLElement[] {
  const w = ctx.draft
  const e = w.edges[index]
  return [
    h('div.insp-head', h('h3', 'Connection')),
    h('p', h('a', { href: '#', onclick: (ev: Event) => { ev.preventDefault(); actions.select({ kind: 'node', id: e.from }) } }, nodeLabel(w, e.from)), ' → ',
      h('a', { href: '#', onclick: (ev: Event) => { ev.preventDefault(); actions.select({ kind: 'node', id: e.to }) } }, nodeLabel(w, e.to))),
    h('p.muted.small', `"${nodeLabel(w, e.to)}" waits for "${nodeLabel(w, e.from)}" to complete.`),
    issueList(ctx.issues.filter(i => i.edge === index), actions),
    h('div.insp-foot', h('button.danger', { disabled: ctx.readonly, onclick: () => actions.deleteEdge(index) }, 'Delete connection')),
  ]
}

function pathSelect(ctx: InspectorContext, current: string, ro: boolean, onchange: (v: string) => void, label: string): HTMLSelectElement {
  const norm = normalizeRepoPath(current)
  const opts = ctx.repositories.map(r => h('option', { value: r.path, selected: r.path === norm }, `${r.path === '.' ? '. (project root)' : r.path}${r.initialized ? '' : ' — not initialized'}`))
  if (current && !ctx.repositories.some(r => r.path === norm)) opts.push(h('option', { value: current, selected: true }, `${current} — unresolved`))
  if (!current) opts.unshift(h('option', { value: '', selected: true }, '— repository —'))
  return h('select', { disabled: ro, 'aria-label': label, onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) }, opts)
}

function workflowPanel(ctx: InspectorContext, actions: InspectorActions): HTMLElement[] {
  const w = ctx.draft
  const ro = ctx.readonly
  const out: HTMLElement[] = [h('div.insp-head', h('h3', 'Repository bindings'), h('code', w.id || ctx.file))]
  out.push(h('p.muted.small', 'Bindings name the project repositories this workflow uses and declare its access. Select a node to edit it.'))
  const table = h('div.bindings')
  for (const [key, b] of Object.entries(w.repositories)) {
    const used = Object.values(w.nodes).filter(n => n.repositories.includes(key)).length
    table.append(h('div.binding-row', { dataset: { binding: key } },
      h('strong', key),
      pathSelect(ctx, b.path, ro, v => { b.path = v; actions.changed(true) }, `Path of ${key}`),
      h('select', { disabled: ro, 'aria-label': `Access of ${key}`, onchange: (e: Event) => { b.access = (e.target as HTMLSelectElement).value; actions.changed(true) } },
        (ACCESS_LEVELS as readonly string[]).includes(b.access) ? null : h('option', { value: b.access, selected: true }, `${b.access} — invalid`),
        ACCESS_LEVELS.map(a => h('option', { value: a, selected: a === b.access }, a))),
      h('button.icon-btn', {
        disabled: ro, title: used ? `Remove binding and its ${used} node reference(s)` : 'Remove binding', 'aria-label': `Remove binding ${key}`,
        onclick: () => { delete w.repositories[key]; for (const n of Object.values(w.nodes)) n.repositories = n.repositories.filter(r => r !== key); actions.changed(true) },
      }, '×')))
  }
  if (!Object.keys(w.repositories).length) table.append(h('p.muted.small', 'No bindings yet.'))
  out.push(table)
  const key = h('input', { placeholder: 'tools', disabled: ro, 'aria-label': 'New binding key' })
  let path = ''
  const access = h('select', { disabled: ro, 'aria-label': 'New binding access' }, ACCESS_LEVELS.map(a => h('option', { value: a }, a)))
  const error = h('p.error.small')
  out.push(h('div.add-binding', h('h4', 'Add binding'),
    h('div.row.tight', key, pathSelect(ctx, '', ro, v => { path = v }, 'New binding path'), access,
      h('button', {
        disabled: ro,
        onclick: () => {
          const k = key.value.trim()
          if (!ID_PATTERN.test(k)) { error.textContent = `Key must match ${ID_PATTERN.source}.`; return }
          if (k in w.repositories) { error.textContent = `"${k}" already exists.`; return }
          if (!path) { error.textContent = 'Choose a repository.'; return }
          w.repositories[k] = { path, access: access.value }
          actions.changed(true)
        },
      }, 'Add')), error))
  out.push(h('h4', 'Validation'), ctx.issues.length ? issueList(ctx.issues, actions) : h('p.muted.small', 'No issues found. Validation checks structure and references, not whether the graph fulfils the intent.'))
  return out
}
