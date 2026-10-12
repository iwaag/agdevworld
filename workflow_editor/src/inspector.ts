// The inspector edits the selected node or edge, explains a generated step,
// or holds the workflow's settings (documentation policy, repository
// bindings, validation) when they are opened explicitly. It mutates the
// draft and tells the view whether the inspector itself must be rebuilt
// (structure) or not (typing). Its groups keep their open state across
// rebuilds (p8): a rebuild after a checkbox never folds what the person opened.
import type { RepositoryStatus, WorkflowSummary } from '../shared/api.ts'
import type { EffectiveGraph } from '../shared/compile.ts'
import type { NodeTemplate } from '../shared/catalog.ts'
import { ACCESS_LEVELS, APPEARANCE_COLORS, APPEARANCE_ICONS, DOC_POLICIES, ID_PATTERN, NODE_TYPES, normalizeRepoPath, type Issue, type Workflow } from '../shared/model.ts'
import { bindingCategory, iconOf, TYPE_LABEL, type Selection } from './canvas.ts'
import { h } from './dom.ts'
import { icon } from './icons.ts'
import { setDisplay } from './displayMode.ts'

export interface InspectorContext {
  draft: Workflow
  selection: Selection
  repositories: RepositoryStatus[]
  workflows: WorkflowSummary[]
  issues: Issue[]
  readonly: boolean
  file: string
  effective?: EffectiveGraph | null // the compiled draft (default policy), for step details
  templates?: Pick<NodeTemplate, 'id' | 'revision'>[] // the person's catalog now (p7/ex1), to say how a node's template has moved on
}

export interface InspectorActions {
  changed(rebuild: boolean): void
  select(sel: Selection): void
  deleteNode(id: string): void
  deleteEdge(index: number): void
  connect(from: string, to: string): void
  close(): void // closes the inspector (deselects, or closes settings)
  issue(i: Issue): void // leads to what an issue is about
}

const nodeLabel = (w: Workflow, id: string) => (w.nodes[id]?.name || id)

// Simple shows a selection's compact explanation and its everyday edit;
// "More details" is the same inspector in Detail (p8/ex1).
function moreDetails(what: string): HTMLElement {
  return h('div.insp-more.s-only', h('button.more-link', { type: 'button', onclick: (e: Event) => { const panel = (e.currentTarget as HTMLElement).closest('.inspector'); setDisplay('detail'); panel?.querySelector<HTMLElement>('.insp-head h3')?.focus({ preventScroll: true }) } }, icon('settings', 'icon small'), 'More details'), h('span.small.muted', ` ${what}`))
}

// Which groups the person has opened or closed, by name; the defaults
// apply until they choose.
const groupState = new Map<string, boolean>()
function group(key: string, title: string, summary: string | null, open: boolean, ...body: (HTMLElement | null)[]): HTMLDetailsElement {
  const head = h('summary', h('span.group-title', title), summary ? h('span.group-summary', summary) : null)
  const d = h('details.insp-group.d-only', { dataset: { group: key } }, head, h('div.group-body', ...body.filter((x): x is HTMLElement => !!x)))
  d.open = groupState.get(key) ?? open
  // Recorded at the activation itself (click, Enter or Space on the summary):
  // the toggle event comes later, possibly after a rebuild has replaced this
  // element.
  head.addEventListener('click', () => groupState.set(key, !d.open))
  return d
}

function head(iconName: string | null, title: string, id: string | null, actions: InspectorActions): HTMLElement {
  return h('div.insp-head', iconName ? icon(iconName, 'icon') : null, h('h3', { tabIndex: -1 }, title), id ? h('code.d-only', id) : null,
    h('button.icon-btn.insp-close', { title: 'Close (Esc)', 'aria-label': 'Close the inspector', onclick: () => actions.close() }, icon('close', 'icon small')))
}

function issueList(issues: Issue[], actions: InspectorActions): HTMLElement {
  return h('ul.issues', issues.map(i => {
    const goes = !!(i.node || i.edge !== undefined || i.binding)
    return h(`li.${i.severity}`, goes ? h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); actions.issue(i) } }, i.message) : i.message)
  }))
}

function resolveRepo(ctx: InspectorContext, path: string) {
  const p = normalizeRepoPath(path)
  if (p === '.') return ctx.repositories.find(r => r.path === '.')
  return p ? ctx.repositories.find(r => r.path === p) : undefined
}

export function renderInspector(panel: HTMLElement, ctx: InspectorContext, actions: InspectorActions) {
  // The panel's own scroll position survives a rebuild of its content.
  const top = panel.scrollTop
  const same = panel.dataset.shows === JSON.stringify(ctx.selection)
  panel.replaceChildren()
  const sel = ctx.selection
  if (sel?.kind === 'node' && ctx.draft.nodes[sel.id]) panel.append(...nodePanel(ctx, sel.id, actions))
  else if (sel?.kind === 'edge' && ctx.draft.edges[sel.index]) panel.append(...edgePanel(ctx, sel.index, actions))
  else if (sel?.kind === 'step' && ctx.effective?.nodes[sel.id]?.step) panel.append(...stepPanel(ctx, sel.id, actions))
  else panel.append(...workflowPanel(ctx, actions))
  panel.dataset.shows = JSON.stringify(ctx.selection)
  panel.dataset.panel = sel?.kind ?? 'settings'
  panel.scrollTop = same ? top : 0
}

function nodePanel(ctx: InspectorContext, id: string, actions: InspectorActions): HTMLElement[] {
  const w = ctx.draft
  const n = w.nodes[id]
  const ro = ctx.readonly
  const typeOptions = (NODE_TYPES as readonly string[]).includes(n.type) ? [...NODE_TYPES] : [n.type, ...NODE_TYPES]
  const out: (HTMLElement | null)[] = [
    head(iconOf(n.type, n.appearance), nodeLabel(w, id), id, actions),
    h('label.field', h('span', 'Name'), h('input', { value: n.name, disabled: ro, 'aria-label': 'Node name', placeholder: TYPE_LABEL[n.type] ?? '', oninput: (e: Event) => { n.name = (e.target as HTMLInputElement).value; actions.changed(false) } })),
    h('label.field', h('span', 'Description'), h('textarea', { rows: 5, value: n.description, disabled: ro, 'aria-label': 'Node description', oninput: (e: Event) => { n.description = (e.target as HTMLTextAreaElement).value; actions.changed(false) } })),
    h('label.field.d-only', h('span', 'Type'), h('select', {
      disabled: ro, 'aria-label': 'Node type',
      onchange: (e: Event) => { n.type = (e.target as HTMLSelectElement).value; actions.changed(true) },
    }, typeOptions.map(t => h('option', { value: t, selected: t === n.type }, TYPE_LABEL[t] ?? `${t || '(none)'} — unknown`)))),
  ]
  if (n.type === 'delegate' || n.workflow) {
    const known = ctx.workflows.filter(s => s.id)
    const options = [h('option', { value: '' }, '— choose a workflow —'), ...known.map(s => h('option', { value: s.id!, selected: s.id === n.workflow }, `${s.name || s.id} (${s.id})${s.file === ctx.file ? ' — this workflow' : ''}`))]
    if (n.workflow && !known.some(s => s.id === n.workflow)) options.push(h('option', { value: n.workflow, selected: true }, `${n.workflow} (missing)`))
    out.push(h('label.field.d-only', h('span', n.type === 'delegate' ? 'Delegate to workflow' : 'Target workflow (only used by delegate nodes)'), h('select', {
      disabled: ro, 'aria-label': 'Delegate target',
      onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) n.workflow = v; else delete n.workflow; actions.changed(true) },
    }, options)))
    if (n.type === 'delegate') out.push(h('p.banner.warn.small.d-only', 'Delegate execution is not supported: this node is definition and display only, and runs of a workflow with a delegate node are refused by the browser, the API and the CLI alike.'))
  }
  out.push(moreDetails('type, appearance, repositories, connections'))
  out.push(appearanceField(n, ro, actions))
  // Repository bindings of this node
  const bindings = Object.entries(w.repositories)
  const repoBody = h('div.field-list')
  if (!bindings.length) repoBody.append(h('p.muted.small', 'This workflow declares no repository bindings. Add them in Workflow settings.'))
  for (const [key, b] of bindings) {
    const repo = resolveRepo(ctx, b.path)
    repoBody.append(h('label.check', h('input', {
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
    repoBody.append(h('div.check.unresolved', icon('alert', 'icon small'), h('span', `${ref} — not declared`),
      h('button.icon-btn', { disabled: ro, title: 'Remove reference', 'aria-label': `Remove reference ${ref}`, onclick: () => { n.repositories = n.repositories.filter(r => r !== ref); actions.changed(true) } }, '×')))
  }
  const bound = n.repositories.map(r => `${r}${w.repositories[r] ? ` · ${w.repositories[r].access === 'editable' ? 'editable' : 'read-only'}` : ' · not declared'}`).join(', ')
  out.push(group('repositories', 'Repositories', bound || 'none', true, repoBody))
  // Connections
  const incoming = w.edges.map((e, i) => ({ e, i })).filter(x => x.e.to === id)
  const outgoing = w.edges.map((e, i) => ({ e, i })).filter(x => x.e.from === id)
  const edgeRow = (label: string, i: number) => h('li', h('a', { href: '#', onclick: (ev: Event) => { ev.preventDefault(); actions.select({ kind: 'edge', index: i }) } }, label),
    h('button.icon-btn', { disabled: ro, title: 'Delete connection', 'aria-label': `Delete connection ${label}`, onclick: () => actions.deleteEdge(i) }, '×'))
  const targets = Object.keys(w.nodes).filter(t => t !== id && !w.edges.some(e => e.from === id && e.to === t))
  const pick = h('select', { disabled: ro, 'aria-label': 'Connect to node' }, h('option', { value: '' }, '— node —'), targets.map(t => h('option', { value: t }, `${nodeLabel(w, t)} (${t})`)))
  const chain = [incoming.map(x => nodeLabel(w, x.e.from)).join(', ') || 'start', 'this', outgoing.map(x => nodeLabel(w, x.e.to)).join(', ') || 'end'].join(' → ')
  out.push(group('connections', 'Connections', chain, false,
    h('div.field', h('span', 'Waits for'), incoming.length ? h('ul.edges-list', incoming.map(x => edgeRow(`${nodeLabel(w, x.e.from)} → this`, x.i))) : h('p.muted.small', 'Nothing: starts when the workflow starts.')),
    h('div.field', h('span', 'Then'), outgoing.length ? h('ul.edges-list', outgoing.map(x => edgeRow(`this → ${nodeLabel(w, x.e.to)}`, x.i))) : h('p.muted.small', 'Nothing: an end of the workflow.'),
      h('div.row.tight', pick, h('button', { disabled: ro, onclick: () => { if (pick.value) actions.connect(id, pick.value) } }, 'Connect')))))
  if (n.template) out.push(provenanceField(n.template, ctx.templates))
  const nodeIssues = ctx.issues.filter(i => i.node === id)
  if (nodeIssues.length) out.push(issueList(nodeIssues, actions))
  out.push(h('div.insp-foot.d-only', h('button.danger', { disabled: ro, onclick: () => actions.deleteNode(id) }, 'Delete node')))
  return out.filter((x): x is HTMLElement => !!x)
}

// Template provenance (p7/ex1): where the node came from and what the
// person expected of that activity. A record, not a link: the node does not
// follow the catalog, and nothing here changes what the node does.
function provenanceField(t: NonNullable<Workflow['nodes'][string]['template']>, catalog?: Pick<NodeTemplate, 'id' | 'revision'>[]): HTMLElement {
  const now = catalog?.find(x => x.id === t.id)
  const since = !catalog ? '' : !now ? ' The template is no longer in your catalog.' : now.revision !== t.revision ? ` Your catalog has revision ${now.revision} now; this node keeps what it was made from.` : ''
  return group('template', 'Made from your template', `${t.id} · revision ${t.revision}`, false,
    h('div.field.template-field',
      h('div.small', h('code', t.id), ` revision ${t.revision}.${since}`),
      h('div.template-provenance', { 'aria-label': 'Template expectation' }, h('span.muted', 'You expected: '), t.expectation || '—'),
      h('p.muted.small', 'Provenance only: outside approval and the executed graph. Edit the node freely; the catalog is not changed.')))
}

// Appearance (p7): how the card looks. Display only — it changes neither
// approval nor what the node does.
function appearanceField(n: Workflow['nodes'][string], ro: boolean, actions: InspectorActions): HTMLElement {
  const set = (k: 'icon' | 'color', v: string) => {
    const a = { icon: n.appearance?.icon ?? '', color: n.appearance?.color ?? '', [k]: v }
    if (a.icon || a.color) n.appearance = a; else delete n.appearance
    actions.changed(true)
  }
  const options = (known: readonly string[], current: string, label: (v: string) => string) => [
    h('option', { value: '', selected: !current }, 'type default'),
    ...(current && !known.includes(current) ? [h('option', { value: current, selected: true }, `${current} — unknown`)] : []),
    ...known.map(v => h('option', { value: v, selected: v === current }, label(v))),
  ]
  const summary = [n.appearance?.icon ? `icon ${n.appearance.icon}` : '', n.appearance?.color ? `color ${n.appearance.color}` : ''].filter(Boolean).join(' · ') || 'type default'
  return group('appearance', 'Appearance', summary, false,
    h('div.appearance-row',
      h('select', { disabled: ro, 'aria-label': 'Node icon', onchange: (e: Event) => set('icon', (e.target as HTMLSelectElement).value) }, options(APPEARANCE_ICONS, n.appearance?.icon ?? '', v => `icon: ${v}`)),
      h('select', { disabled: ro, 'aria-label': 'Node color', onchange: (e: Event) => set('color', (e.target as HTMLSelectElement).value) }, options(APPEARANCE_COLORS, n.appearance?.color ?? '', v => `color: ${v}`))),
    h('p.muted.small', 'Display only: the node does what its type says; approvals are not affected.'))
}

function edgePanel(ctx: InspectorContext, index: number, actions: InspectorActions): HTMLElement[] {
  const w = ctx.draft
  const e = w.edges[index]
  return [
    head(null, 'Connection', null, actions),
    h('p', h('a', { href: '#', onclick: (ev: Event) => { ev.preventDefault(); actions.select({ kind: 'node', id: e.from }) } }, nodeLabel(w, e.from)), ' → ',
      h('a', { href: '#', onclick: (ev: Event) => { ev.preventDefault(); actions.select({ kind: 'node', id: e.to }) } }, nodeLabel(w, e.to))),
    h('p.muted.small', `"${nodeLabel(w, e.to)}" waits for "${nodeLabel(w, e.from)}" to complete.`),
    issueList(ctx.issues.filter(i => i.edge === index), actions),
    moreDetails('delete the connection'),
    h('div.insp-foot.d-only', h('button.danger', { disabled: ctx.readonly, onclick: () => actions.deleteEdge(index) }, 'Delete connection')),
  ]
}

function pathSelect(ctx: InspectorContext, current: string, ro: boolean, onchange: (v: string) => void, label: string): HTMLSelectElement {
  const norm = normalizeRepoPath(current)
  const opts = ctx.repositories.map(r => h('option', { value: r.path, selected: r.path === norm }, `${r.path === '.' ? '. (project root)' : r.path}${r.initialized ? '' : ' — not initialized'}`))
  if (current && !ctx.repositories.some(r => r.path === norm)) opts.push(h('option', { value: current, selected: true }, `${current} — unresolved`))
  if (!current) opts.unshift(h('option', { value: '', selected: true }, '— repository —'))
  return h('select', { disabled: ro, 'aria-label': label, onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) }, opts)
}

// What a generated step is and what it waits for. Read-only: steps come
// from the policy, not from the author.
export function stepFacts(eff: Pick<EffectiveGraph, 'nodes' | 'edges'>, id: string, label: (id: string) => string): HTMLElement[] {
  const step = eff.nodes[id].step!
  const before = eff.edges.filter(e => e.to === id).map(e => label(e.from))
  const after = eff.edges.filter(e => e.from === id).map(e => label(e.to))
  const out: (HTMLElement | null)[] = [
    h('p.small', step.purpose, ' — ', h('code', step.output)),
    h('dl.kv.d-only', h('dt', 'Waits for'), h('dd', before.join(', ') || 'nothing: the run starts with it'), h('dt', 'Then'), h('dd', after.join(', ') || 'nothing: the run ends with it')),
    step.kind === 'report' ? h('p.small.muted.d-only', `Successors of ${label(step.for ?? '')} wait for this report, not only for its work.`) : null,
    h('details.instructions.d-only', h('summary.small', 'Instructions the executing agent is given'), h('pre.small', step.instructions)),
  ]
  return out.filter((x): x is HTMLElement => !!x)
}

export const stepLabel = (w: Pick<Workflow, 'nodes'>, eff: Pick<EffectiveGraph, 'nodes'>, id: string): string => {
  const step = eff.nodes[id]?.step
  if (!step) return w.nodes[id]?.name || id
  return step.kind === 'plan' ? 'Plan talk' : step.kind === 'report' ? `Report on ${w.nodes[step.for ?? '']?.name || step.for}` : 'Final report'
}

function stepPanel(ctx: InspectorContext, id: string, actions: InspectorActions): HTMLElement[] {
  const eff = ctx.effective!
  return [
    head('doc', stepLabel(ctx.draft, eff, id), id, actions),
    h('p.banner.ok.small.d-only', 'Generated by the default documentation policy. It is not part of the file and cannot be edited or moved; it follows the cards it belongs to.'),
    h('p.small.s-only', 'Generated by the documentation policy; it follows its card.'),
    ...stepFacts(eff, id, x => stepLabel(ctx.draft, eff, x)),
    moreDetails('what it waits for and its instructions'),
  ]
}

function workflowPanel(ctx: InspectorContext, actions: InspectorActions): HTMLElement[] {
  const w = ctx.draft
  const ro = ctx.readonly
  const known = (DOC_POLICIES as readonly string[]).includes(w.documentation.policy)
  const policy = h('select', {
    disabled: ro, 'aria-label': 'Documentation policy',
    onchange: (e: Event) => { w.documentation.policy = (e.target as HTMLSelectElement).value; actions.changed(true) },
  }, known ? null : h('option', { value: w.documentation.policy, selected: true }, w.documentation.policy ? `${w.documentation.policy} — unsupported` : '— not declared —'),
  h('option', { value: 'default', selected: w.documentation.policy === 'default' }, 'default — plan talk, a report per node, final report'),
  h('option', { value: 'manual', selected: w.documentation.policy === 'manual' }, 'manual — documents only when asked'))
  const sectionHead = (key: string, title: string) => h('h4.settings-head', { dataset: { section: key }, tabIndex: -1 }, title)
  const out: HTMLElement[] = [
    head('settings', 'Workflow settings', w.id || ctx.file, actions),
    sectionHead('policy', 'Documentation policy'),
    h('label.field.policy-field', policy),
    h('p.muted.small', w.documentation.policy === 'manual'
      ? 'Runs follow the graph as drawn. No plan or report is generated or required; a node description or the person can still ask for documents.'
      : 'Runs plan with the person first (plan.md), report every node (report-<node>.md) and end with report.md. Changing the policy changes the definition approval, never an existing run.'),
    sectionHead('bindings', 'Repository bindings'),
    h('p.muted.small', 'Bindings name the project repositories this workflow uses and declare its access. Each node chooses among them in its inspector.'),
  ]
  const table = h('div.bindings')
  for (const [key, b] of Object.entries(w.repositories)) {
    const used = Object.values(w.nodes).filter(n => n.repositories.includes(key)).length
    const bad = ctx.issues.some(i => i.binding === key)
    table.append(h(`div.binding-row${bad ? '.has-issue' : ''}`, { dataset: { binding: key } },
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
  out.push(h('div.add-binding', h('div.small.muted', 'Add binding'),
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
  out.push(sectionHead('validation', 'Validation'), ctx.issues.length ? issueList(ctx.issues, actions) : h('p.muted.small', 'No issues found. Validation checks structure and references, not whether the graph fulfils the intent.'))
  return out
}
