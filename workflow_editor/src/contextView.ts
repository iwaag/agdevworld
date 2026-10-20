// Context overview (workflow_editor p13, p13 ex1; docs/context.md): the
// scope matrix of a project (and one of its workflows) — what is kept as a
// default in the project's repositories and which local blocks (p14) each
// scope has, with their kind and manager — with links to the editor that
// owns each cell, the same block cards the editors use, and the bundle the
// same resolver as execution produces. #/context/<workspace>[/<workflow>].
import { sourceLabel, type BlockState, type ContextBundle, type ContextSource, type ScopeTarget } from '../shared/context.ts'
import { api, type ContextMatrixView } from './api.ts'
import { append, h, when } from './dom.ts'
import type { ViewHandle } from './main.ts'
import { displayToggle } from './displayMode.ts'
import { ago, BlockList } from './contextParts.ts'
import { keepingFocus } from './createWorkflow.ts'

type Scope = 'system' | 'project' | 'workflow'
const DELIVERY: Record<string, string> = { body: 'included', reference: 'reference', absent: 'not set', error: 'unreadable' }

export async function copyText(text: string, near: HTMLElement): Promise<string> {
  // navigator.clipboard exists only in secure contexts (not on a LAN http:// origin).
  try { if (window.isSecureContext && navigator.clipboard) { await navigator.clipboard.writeText(text); return 'Copied.' } } catch { /* fall through */ }
  const ta = h('textarea', { readOnly: true, value: text, style: { position: 'fixed', opacity: '0' } }) as HTMLTextAreaElement
  document.body.append(ta); ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  ta.remove()
  if (ok) return 'Copied.'
  const manual = h('textarea.context-manual', { readOnly: true, rows: 6, value: text }) as HTMLTextAreaElement
  near.after(manual); manual.select()
  return 'This page cannot reach the clipboard: the text is selected below, copy it with your keyboard.'
}

export function deliveryPill(s: Pick<ContextSource, 'delivery'>): HTMLElement {
  return h(`span.pill.ctx-${s.delivery}`, DELIVERY[s.delivery] ?? s.delivery)
}

export function sourceRow(s: ContextSource, link?: string | null): HTMLElement {
  const origin = [s.origin.host && `execution host ${s.origin.host}`, s.origin.file && (s.origin.project ? `${s.origin.project}:${s.origin.file}` : s.origin.file), s.origin.commit && `at ${s.origin.commit.slice(0, 12)}`, s.origin.revision !== undefined && `revision ${s.origin.revision}`, s.origin.updated && `${when(s.origin.updated.at)} by ${s.origin.updated.by}`].filter(Boolean).join(' · ')
  return h('div.ctx-source', { dataset: { key: s.key } },
    h('div.ctx-source-head', deliveryPill(s), link ? h('a', { href: link }, s.title) : h('span', s.title), h('span.chip.muted', s.applies.length === 2 ? 'execution + authoring' : `${s.applies[0]} only`)),
    origin ? h('div.small.muted', origin) : null,
    s.provenance.length > 1 ? h('div.small.muted', `declared by ${s.provenance.join(' and ')}; delivered once`) : null,
    s.note ? h(`div.small${s.delivery === 'error' ? '.error-text' : '.muted'}`, s.note) : null,
    s.delivery === 'reference' && s.reference ? h('div.small.muted', `named, not included: ${s.reference}`) : null)
}

export const projectContextHref = (wsId: string) => `#/ws/${encodeURIComponent(wsId)}/context`
export const workflowContextHref = (wsId: string, workflow: string) => `#/ws/${encodeURIComponent(wsId)}/wf/${encodeURIComponent(`${workflow}.yaml`)}/context`
export const systemContextHref = '#/home/context'

// The overview (p13 ex1): routine editing is in Home, the project and the
// workflow editors; this page compares scopes side by side, links to the
// editor that owns each cell, and keeps the same editor for a quick change.
export function renderContextView(root: HTMLElement, wsId: string, workflowId?: string): ViewHandle {
  let view: ContextMatrixView | null = null
  let loadError = ''
  let selected: Scope = workflowId ? 'workflow' : 'project'
  let preview: 'execution' | 'authoring' = workflowId ? 'execution' : 'authoring'
  let disposed = false
  const editors = new Map<Scope, BlockList>()

  const header = h('header.topbar', h('div.crumbs', h('a', { href: '#/' }, 'agdev'), h('span.sep', '/'), h('a', { href: `#/ws/${encodeURIComponent(wsId)}` }, wsId),
    workflowId ? [h('span.sep', '/'), h('span', workflowId)] : null, h('span.sep', '/'), h('span.muted', 'Context overview')),
    h('div.top-actions', h('button', { onclick: () => void load() }, 'Refresh'), displayToggle()))
  const main = h('main.context-view')
  const editorSlot = h('section.card.ctx-edit')
  root.append(header, main)

  const target = (s: Scope): ScopeTarget => s === 'system' ? { scope: s } : s === 'project' ? { scope: s, project: view!.project } : { scope: s, project: view!.project, workflow: view!.workflow! }
  const blocksOf = (s: Scope): BlockState[] | null => !view ? null : s === 'system' ? view.blocks.system : s === 'project' ? view.blocks.project : view.blocks.workflow
  const dirty = () => [...editors.values()].some(e => e.isDirty())
  const ownerHref = (s: Scope) => s === 'system' ? systemContextHref : s === 'project' ? projectContextHref(wsId) : workflowContextHref(wsId, view!.workflow!)
  const editorOf = (s: Scope) => {
    let e = editors.get(s)
    if (!e) {
      e = new BlockList(target(s), { wider: s !== 'workflow', onSaved: () => void load() })
      editors.set(s, e)
    }
    const b = blocksOf(s)
    if (b) e.set(b)
    return e
  }

  async function load() {
    try { view = await api.context(wsId, workflowId ?? null); loadError = '' } catch (e) { loadError = (e as Error).message }
    if (view && selected === 'workflow' && !view.workflow) selected = 'project'
    if (!disposed) render()
  }

  // The scope matrix: columns are scopes, rows are storage.
  function matrix(v: ContextMatrixView): HTMLElement {
    const all = new Map<string, ContextSource>()
    for (const s of [...(v.execution?.sources ?? []), ...v.authoring.sources]) if (!all.has(s.key) || s.applies.length > all.get(s.key)!.applies.length) all.set(s.key, s)
    const of = (scope: string, category: string) => [...all.values()].filter(s => s.scope === scope && s.category === category && s.scope !== 'run')
    const link = (s: ContextSource) => s.scope === 'project' && s.category === 'default' ? projectContextHref(wsId) : s.scope === 'workflow' && s.category === 'default' && v.workflow ? workflowContextHref(wsId, v.workflow) : null
    const overrideCell = (s: Scope) => {
      const all = blocksOf(s)
      if (!all) return h('td.ctx-cell.muted', 'choose a workflow')
      const present = all.filter(b => b.block || b.problem)
      return h(`td.ctx-cell.ctx-override${selected === s ? '.selected' : ''}`, { dataset: { scope: s } },
        present.length ? present.map(b => h('div.ctx-cell-block', { dataset: { block: b.id } },
          h('div.ctx-source-head', h(`span.pill.ctx-${b.problem ? 'error' : 'body'}`, b.problem ? 'unreadable' : b.block!.kind === 'information' ? 'information' : 'instruction'), h('strong.small', b.block?.title ?? b.id)),
          b.block ? h('div.small.muted', `managed by ${b.block.manager}`) : h('div.small.error-text', b.problem ?? ''),
          b.block?.refresh ? h('div.small.error-text', `last refresh ${b.block.refresh.outcome}`) : null,
          h('div.small.muted.d-only', `last edited by ${b.block?.editor.by ?? '—'}${b.block ? ` ${ago(b.block.editor.at)}` : ''}${b.size ? ` · ${b.size.lines} lines · ${b.size.bytes} bytes` : ''}`),
          h('code.small.d-only', b.file))) : h(`span.pill.ctx-absent`, 'not set'),
        h('div.row.tight', h('a.button.small', { href: ownerHref(s), title: 'Open the editor where this instruction belongs' }, s === 'system' ? 'Open in Home' : s === 'project' ? 'Open in the project' : 'Open in the workflow'),
          h('button.small', { disabled: selected === s, onclick: () => { selected = s; render() } }, selected === s ? 'Editing below' : 'Quick edit')))
    }
    const defaults = (scope: Scope) => h('td.ctx-cell', of(scope, 'default').length ? of(scope, 'default').map(s => sourceRow(s, link(s))) : h('span.muted.small', scope === 'workflow' && !v.workflow ? 'choose a workflow' : 'none'))
    return h('section.card.ctx-matrix',
      h('div.card-head', h('h2', 'Scope matrix'), h('label.small', 'Workflow ', h('select', { onchange: (e: Event) => { const id = (e.target as HTMLSelectElement).value; location.hash = `#/context/${encodeURIComponent(wsId)}${id ? `/${encodeURIComponent(id)}` : ''}` } },
        h('option', { value: '', selected: !v.workflow }, '(project only)'), ...v.workflows.map(w => h('option', { value: w.id, selected: w.id === v.workflow }, w.name === w.id ? w.id : `${w.name} (${w.id})`))))),
      h('p.small.muted', 'Compare scopes side by side; each is edited where you work on it. ', h('span.d-only', 'Scope says how widely a source applies, not which one wins: an explicit request or a more specific instruction refines a general one.')),
      h('div.ctx-table-wrap', h('table.ctx-table',
        h('thead', h('tr', h('th', ''), h('th', 'System', h('div.small.muted', 'every project')), h('th', 'Project', h('div.small.muted', v.project)), h('th', 'Workflow', h('div.small.muted', v.workflow ?? '—')), h('th', 'Run', h('div.small.muted', 'each run')))),
        h('tbody',
          h('tr', h('th', 'Shared', h('div.small.muted', 'in the repository')), defaults('system'), defaults('project'), defaults('workflow'), h('td.ctx-cell.muted.small', 'none: runs are created, not pre-authored')),
          h('tr', h('th', 'Local', h('div.small.muted', 'this host, not in Git')), overrideCell('system'), overrideCell('project'), overrideCell('workflow'), h('td.ctx-cell.small', h('span.muted', 'run input: the request and later instructions, in each run\'s view')))))))
  }

  function editor(): HTMLElement {
    const e = editorOf(selected)
    editorSlot.replaceChildren(h('div.card-head', h('h2', 'Quick edit'), e.addControl), e.el)
    return editorSlot
  }

  function resolved(v: ContextMatrixView): HTMLElement {
    const b: ContextBundle | null = preview === 'execution' ? v.execution : v.authoring
    const text = preview === 'execution' ? v.rendered.execution : v.rendered.authoring
    const status = h('span.small.muted')
    const cmd = `wfe context show --workspace ${wsId}${v.workflow ? ` --workflow ${v.workflow}` : ''} --rendered`
    const pre = h('pre.ctx-rendered', text ?? '')
    return h('section.card.ctx-resolved',
      h('div.card-head', h('h2', 'Resolved'), h('div.pills',
        h(`button.panel-toggle${preview === 'execution' ? '.active' : ''}`, { disabled: !v.execution, title: v.execution ? '' : 'choose a workflow', onclick: () => { preview = 'execution'; render() } }, 'Next run of the workflow'),
        h(`button.panel-toggle${preview === 'authoring' ? '.active' : ''}`, { onclick: () => { preview = 'authoring'; render() } }, 'Authoring'))),
      !b ? h('p.muted', 'Choose a workflow to see what its next run would be prepared with.') : [
        h('p.small.muted', preview === 'execution'
          ? 'Saved settings: what a new run of this workflow would be prepared with now, by the same resolver as the claim. The common execution contract is the execution host\'s and is composed before this text at claim; a run reads its defaults from its own copy, made from the committed project.'
          : 'Guidance for a workflow author: available to copy, not injected. WFE does not launch IDE sessions, so nothing here is verified as delivered to one.'),
        h('div.ctx-sources', b.sources.filter(s => s.scope !== 'run').map(s => h('div.ctx-line', h('span.chip', sourceLabel(s)), deliveryPill(s)))),
        h('div.row.tight', h('button', { onclick: async () => { status.textContent = await copyText(text ?? '', pre) } }, 'Copy text'),
          h('button', { onclick: async () => { status.textContent = await copyText(cmd, pre) } }, 'Copy command'), h('code.small', cmd), status),
        pre,
      ])
  }

  function render() {
    if (disposed) return
    keepingFocus(main, () => {
      main.replaceChildren()
      if (loadError) main.append(h('div.banner.error', loadError))
      if (!view) { main.append(h('p.muted', loadError ? '' : 'Loading…')); return }
      append(main, [matrix(view), editor(), resolved(view)])
    })
  }
  void load()
  return { dispose: () => { disposed = true }, isDirty: dirty }
}

// #/context without a project: the instructions for all projects (the
// system scope is this WFE area, no project is needed), and the projects
// whose matrices compare the other scopes.
export function renderContextChooser(root: HTMLElement): ViewHandle {
  const main = h('main.context-view')
  const system = new BlockList({ scope: 'system' })
  const list = h('section.card', h('h2', 'Projects'), h('p.muted', 'Loading…'))
  root.append(h('header.topbar', h('div.crumbs', h('a', { href: '#/' }, 'agdev'), h('span.sep', '/'), h('span.muted', 'Context overview')), h('div.top-actions', displayToggle())), main)
  main.append(h('section.card.ctx-edit', h('div.card-head', h('h2', 'All projects'), system.addControl), system.el), list)
  void system.refresh()
  void api.workspaces().then(r => list.replaceChildren(h('h2', 'Projects'),
    h('p', 'Each project\'s scope matrix compares its shared and local context with its workflows\'. Choose a project:'),
    h('ul.ctx-projects', r.workspaces.filter(w => w.observed.available).map(w => h('li', h('a', { href: `#/context/${encodeURIComponent(w.id)}` }, w.label || w.id), h('span.small.muted', ` ${w.id}`))))))
    .catch(e => list.replaceChildren(h('div.banner.error', (e as Error).message)))
  return { dispose: () => {}, isDirty: () => system.isDirty() }
}
