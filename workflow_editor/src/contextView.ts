// Context (workflow_editor p13, docs/context.md): the scope matrix of a
// project (and one of its workflows) — what is kept as a default in the
// project's repositories and what is the Developer's local override, at each
// scope — with the override editor, its revision history, and the bundle the
// same resolver as execution produces. #/context/<workspace>[/<workflow>].
import { sourceLabel, type ContextBundle, type ContextSource, type OverrideRevision, type OverrideState } from '../shared/context.ts'
import { api, ApiError, type ContextMatrixView } from './api.ts'
import { append, h, when } from './dom.ts'
import type { ViewHandle } from './main.ts'
import { displayToggle } from './displayMode.ts'

const ACTOR_KEY = 'workflow-editor.actor'
const stored = () => { try { return localStorage.getItem(ACTOR_KEY) ?? '' } catch { return '' } }
const store = (v: string) => { try { localStorage.setItem(ACTOR_KEY, v) } catch { /* per-viewer convenience only */ } }

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

export function renderContextView(root: HTMLElement, wsId: string, workflowId?: string): ViewHandle {
  let view: ContextMatrixView | null = null
  let loadError = ''
  let selected: Scope = workflowId ? 'workflow' : 'project'
  let draft = '' // the editor's text
  let base: OverrideState | null = null // the override as last read (what a save replaces)
  let revisions: (OverrideRevision & { text: string | null })[] = []
  let message: HTMLElement | null = null
  let preview: 'execution' | 'authoring' = workflowId ? 'execution' : 'authoring'
  let busy = false
  let disposed = false

  const agdevworld = location.pathname.startsWith('/wfe/') ? '/' : 'http://localhost:8093/'
  const header = h('header.topbar', h('div.crumbs', h('a.back-to-world', { href: agdevworld }, '← agdevworld'), h('span.sep', '|'),
    h('a', { href: '#/' }, 'agdev'), h('span.sep', '/'), h('a', { href: `#/ws/${encodeURIComponent(wsId)}` }, wsId),
    workflowId ? [h('span.sep', '/'), h('span', workflowId)] : null, h('span.sep', '/'), h('span.muted', 'Context')),
    h('div.top-actions', h('button', { onclick: () => void load(true) }, 'Refresh'), displayToggle()))
  const main = h('main.context-view')
  root.append(header, main)
  const by = h('input', { 'aria-label': 'Your name', placeholder: 'your name', value: stored(), oninput: () => store(by.value.trim()) })
  const textarea = h('textarea.context-editor', { rows: 10, spellcheck: false, 'aria-label': 'Override text', oninput: () => { draft = textarea.value; renderButtons() } }) as HTMLTextAreaElement
  const buttons = h('div.row.tight')

  const target = (s: Scope) => s === 'system' ? { scope: s } : s === 'project' ? { scope: s, project: view!.project } : { scope: s, project: view!.project, workflow: view!.workflow! }
  const overrideOf = (s: Scope): OverrideState | null => !view ? null : s === 'system' ? view.overrides.system : s === 'project' ? view.overrides.project : view.overrides.workflow
  const dirty = () => !!base && draft !== (base.text ?? '')

  async function load(keepDraft = false) {
    try { view = await api.context(wsId, workflowId ?? null); loadError = '' } catch (e) { loadError = (e as Error).message }
    if (view) await select(selected, keepDraft)
    if (!disposed) render()
  }
  async function select(s: Scope, keepDraft = false) {
    if (s === 'workflow' && !view?.workflow) s = 'project'
    selected = s
    const t = target(s)
    const r = await api.override(t.scope, (t as { project?: string }).project, (t as { workflow?: string }).workflow).catch(e => { loadError = (e as Error).message; return null })
    if (!r) return
    base = r.state; revisions = r.revisions
    if (!keepDraft) { draft = r.state.text ?? ''; textarea.value = draft }
  }

  async function save(text: string | null) {
    if (!by.value.trim()) { message = h('div.banner.error', 'Enter your name: every revision records who wrote it.'); render(); return }
    busy = true; render()
    try {
      const t = target(selected)
      const r = await api.saveOverride({ ...t, text, base: base?.sha256 ?? null, by: by.value.trim() })
      message = h('div.banner.ok', r.changed ? `${text === null ? 'Cleared' : 'Saved'} revision ${r.revisions.at(-1)?.rev}. It applies to the next attempt of affected runs and to authoring sessions that read it. Nothing was started or resumed, and no attempt in progress changes; to steer a run now, send it an instruction from its run view's Conversation, or wfe run instruct.` : 'Unchanged: that is already the saved text.')
      base = r.state; revisions = r.revisions; draft = r.state.text ?? ''; textarea.value = draft
      view = await api.context(wsId, workflowId ?? null).catch(() => view)
    } catch (e) {
      const conflict = e instanceof ApiError && (e.detail as { code?: string } | undefined)?.code === 'context-conflict'
      const cur = conflict ? (e.detail as { current: OverrideState }).current : null
      message = h('div.banner.error', (e as Error).message,
        cur ? h('div.ctx-conflict', h('p.small', `Now saved${cur.updated ? ` (${when(cur.updated.at)}, ${cur.updated.by})` : ''}:`), h('pre.small', cur.text ?? '(not set)'),
          h('div.row.tight',
            h('button', { onclick: () => { base = cur; draft = cur.text ?? ''; textarea.value = draft; message = null; render() } }, 'Load it (discard my edit)'),
            h('button', { onclick: () => { base = cur; message = null; void save(text) } }, 'Save mine over it'))) : null)
    }
    busy = false
    render()
  }

  function renderButtons() {
    buttons.replaceChildren(
      h('button.primary', { disabled: busy || !dirty(), onclick: () => void save(draft) }, 'Save'),
      h('button', { disabled: busy || !dirty(), onclick: () => { draft = base?.text ?? ''; textarea.value = draft; renderButtons() } }, 'Discard changes'),
      h('button.danger', { disabled: busy || !base?.text, onclick: () => { if (confirm('Clear this override? Its contribution is removed; inherited defaults stay.')) void save(null) } }, 'Clear'),
      ...(dirty() ? [h('span.small.warn-text', 'Unsaved changes')] : []))
  }

  // The scope matrix: columns are scopes, rows are storage.
  function matrix(v: ContextMatrixView): HTMLElement {
    const all = new Map<string, ContextSource>()
    for (const s of [...(v.execution?.sources ?? []), ...v.authoring.sources]) if (!all.has(s.key) || s.applies.length > all.get(s.key)!.applies.length) all.set(s.key, s)
    const of = (scope: string, category: string) => [...all.values()].filter(s => s.scope === scope && s.category === category && s.scope !== 'run')
    const link = (s: ContextSource) => s.key === 'project/intent' ? `#/ws/${encodeURIComponent(wsId)}` : s.key === 'workflow/intent' && v.workflow ? `#/ws/${encodeURIComponent(wsId)}/wf/${encodeURIComponent(`${v.workflow}.yaml`)}` : null
    const overrideCell = (s: Scope) => {
      const o = overrideOf(s)
      if (!o) return h('td.ctx-cell.muted', 'choose a workflow')
      return h(`td.ctx-cell.ctx-override${selected === s ? '.selected' : ''}`,
        h('div.ctx-source-head', h(`span.pill.ctx-${o.problem ? 'error' : o.text === null ? 'absent' : 'body'}`, o.problem ? 'unreadable' : o.text === null ? 'not set' : 'set'), h('code.small', o.file)),
        o.text !== null ? h('div.small.muted', o.revision !== null ? `revision ${o.revision} · ${when(o.updated!.at)} by ${o.updated!.by}` : 'edited outside WFE') : null,
        o.text ? h('div.ctx-excerpt.small', o.text.length > 160 ? `${o.text.slice(0, 160)}…` : o.text) : null,
        h('button.small', { disabled: selected === s, onclick: () => { if (dirty() && !confirm('Discard the unsaved override text?')) return; message = null; void select(s).then(render) } }, selected === s ? 'Editing below' : 'Edit'))
    }
    const defaults = (scope: Scope) => h('td.ctx-cell', of(scope, 'default').length ? of(scope, 'default').map(s => sourceRow(s, link(s))) : h('span.muted.small', scope === 'workflow' && !v.workflow ? 'choose a workflow' : 'none'))
    return h('section.card.ctx-matrix',
      h('div.card-head', h('h2', 'Scope matrix'), h('label.small', 'Workflow ', h('select', { onchange: (e: Event) => { const id = (e.target as HTMLSelectElement).value; location.hash = `#/context/${encodeURIComponent(wsId)}${id ? `/${encodeURIComponent(id)}` : ''}` } },
        h('option', { value: '', selected: !v.workflow }, '(project only)'), ...v.workflows.map(w => h('option', { value: w.id, selected: w.id === v.workflow }, w.name === w.id ? w.id : `${w.name} (${w.id})`))))),
      h('p.small.muted', 'Scope says how widely a source applies, not which one wins: an explicit request or a more specific instruction refines a general one. Defaults live in the project\'s repositories; overrides are your local settings in this WFE area, never in Git.'),
      h('div.ctx-table-wrap', h('table.ctx-table',
        h('thead', h('tr', h('th', ''), h('th', 'System', h('div.small.muted', 'every project')), h('th', 'Project', h('div.small.muted', v.project)), h('th', 'Workflow', h('div.small.muted', v.workflow ?? '—')), h('th', 'Run', h('div.small.muted', 'each run')))),
        h('tbody',
          h('tr', h('th', 'Default', h('div.small.muted', 'repository-owned')), defaults('system'), defaults('project'), defaults('workflow'), h('td.ctx-cell.muted.small', 'none: runs are created, not pre-authored')),
          h('tr', h('th', 'Override', h('div.small.muted', 'local, not in Git')), overrideCell('system'), overrideCell('project'), overrideCell('workflow'), h('td.ctx-cell.small', h('span.muted', 'run input: the request, answers and instructions, in each run\'s view (Context shows what an attempt was given)')))))))
  }

  function editor(): HTMLElement {
    const label = selected === 'system' ? 'System override — every project in this area' : selected === 'project' ? `Project override — ${view!.project}, every workflow` : `Workflow override — ${view!.project}/${view!.workflow}, its runs and its authoring`
    renderButtons()
    return h('section.card.ctx-edit',
      h('h2', label),
      base?.problem ? h('div.banner.error', base.problem) : null,
      base?.external ? h('div.banner.warn', 'The file was edited outside WFE since its last recorded revision; saving keeps that content as a revision first.') : null,
      textarea,
      h('div.row.tight', h('label.small', 'Saving as ', by), h('span.small.muted', base?.sha256 ? `replaces ${base.sha256.slice(0, 12)}` : 'nothing saved yet')),
      buttons,
      h('p.small.muted', 'Changes affect the next attempt of affected runs (a run whose session policy is run starts a new session then); an attempt in progress keeps what it was given. Saving starts nothing.'),
      h('details.ctx-history', h('summary.small', `Revision history (${revisions.length})`),
        revisions.length ? h('ol.ctx-revisions', { reversed: true }, ...[...revisions].reverse().map(r => h('li',
          h('div.small', h('strong', `revision ${r.rev}`), ` · ${when(r.at)} · ${r.by}${r.external ? ' (found edited outside WFE)' : ''} · ${r.sha256 ? r.sha256.slice(0, 12) : 'removed'}`),
          r.text !== null ? h('pre.small', r.text) : h('p.small.muted', 'removed')))) : h('p.small.muted', 'No revision yet.')))
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
          ? 'What a new run of this workflow would be prepared with now, by the same resolver as the claim. The common execution contract is the execution host\'s and is composed before this text at claim; a run reads its defaults from its own copy, made from the committed project.'
          : 'Guidance for a workflow author: available to copy, not injected. WFE does not launch IDE sessions, so nothing here is verified as delivered to one.'),
        h('div.ctx-sources', b.sources.filter(s => s.scope !== 'run').map(s => h('div.ctx-line', h('span.chip', sourceLabel(s)), deliveryPill(s)))),
        h('div.row.tight', h('button', { onclick: async () => { status.textContent = await copyText(text ?? '', pre) } }, 'Copy text'),
          h('button', { onclick: async () => { status.textContent = await copyText(cmd, pre) } }, 'Copy command'), h('code.small', cmd), status),
        pre,
      ])
  }

  function render() {
    if (disposed) return
    main.replaceChildren()
    if (loadError) main.append(h('div.banner.error', loadError))
    if (!view) { main.append(h('p.muted', loadError ? '' : 'Loading…')); return }
    append(main, [message, matrix(view), editor(), resolved(view)])
  }
  void load()
  return { dispose: () => { disposed = true }, isDirty: dirty }
}

// A run's context (p13): what each attempt was prepared with and whether its
// prompt was delivered, the next attempt with the current settings, and what
// differs. Loaded when asked; nothing here writes.
export function runContextPanel(wsId: string, workflow: string, run: string, conversation: () => string | null): HTMLElement {
  const box = h('div.ctx-run')
  let loaded = false
  async function load() {
    loaded = true
    box.replaceChildren(h('p.small.muted', 'Loading…'))
    let v
    try { v = await api.runContext(wsId, workflow, run) } catch (e) { box.replaceChildren(h('div.banner.error', (e as Error).message), h('button', { onclick: () => void load() }, 'Try again')); return }
    const last = [...v.attempts].reverse().find(a => a.recorded)
    const changed = new Map(v.changes.map(c => [c.key, c.change]))
    const conv = conversation()
    const att = v.attempts.at(-1)
    box.replaceChildren(
      h('div.row.tight', h('a', { href: `#/context/${encodeURIComponent(wsId)}/${encodeURIComponent(workflow)}` }, 'Edit preferences for this workflow'), h('button.small', { onclick: () => void load() }, 'Refresh')),
      h('h4', `Used by attempt ${att?.attempt ?? '—'}`),
      !att ? h('p.small.muted', 'No attempt has begun.')
        : att.snapshot ? h('div', h('p.small.muted', `${when(att.began)} · snapshot ${att.recorded!.snapshot} · ${att.delivery ? `prompt ${att.delivery.event} ${when(att.delivery.at)}${att.delivery.detail ? ` — ${att.delivery.detail}` : ''} (delivery, not proof it was read)` : 'delivery not recorded'}`),
          ...att.snapshot.sources.filter(s => s.scope !== 'run').map(s => sourceRow(s)),
          h('details', h('summary.small', 'The exact text given'), h('pre.ctx-rendered', att.snapshot.rendered)))
          : h('div', h('p.small.muted', `Unavailable: ${att.unavailable}`), ...(att.legacy ?? []).map(g => h('div.small', `guide ${g.path} ${g.sha256.slice(0, 12)}`)), ...(att.recorded?.sources ?? []).map(s => h('div.small', `${s.key} — ${DELIVERY[s.delivery]}${s.sha256 ? ` ${s.sha256.slice(0, 12)}` : ''} (recorded identity only)`))),
      h('h4', 'Next attempt with current settings'),
      h('p.small.muted', v.changes.length ? 'Not yet applied to any attempt. Marked: what differs from the last prepared attempt.' : last ? 'Same sources as the last prepared attempt.' : 'Not yet applied to any attempt.'),
      ...v.next.sources.filter(s => s.scope !== 'run').map(s => { const row = sourceRow(s); const c = changed.get(s.key); if (c) { row.classList.add(`ctx-${c}`); row.querySelector('.ctx-source-head')!.append(h(`span.pill.ctx-change-${c}`, c)) } return row }),
      ...v.changes.filter(c => c.change === 'removed' && !v.next.sources.some(s => s.key === c.key)).map(c => h('div.ctx-source.ctx-removed', h('div.ctx-source-head', h('span.pill.ctx-change-removed', 'removed'), h('span', c.title ?? c.key)))),
      h('p.small', `Session: ${v.session.next}`),
      h('p.small.muted', 'Preferences reach the next attempt only. To steer the work now, send an instruction: ', conv ? h('a', { href: conv, target: '_blank', rel: 'noopener' }, 'post in the Conversation') : h('span', 'post in the run\'s request conversation'), `, or wfe run instruct ${workflow}/${run} --instruction "…". Nothing is sent or started from here.`),
      h('details', h('summary.small', 'The text the next attempt would get'), h('pre.ctx-rendered', v.nextRendered)))
  }
  box.append(h('button.small', { onclick: () => void load() }, 'Show context'))
  ;(box as HTMLElement & { ensure?: () => void }).ensure = () => { if (!loaded) void load() }
  return box
}

// #/context without a project: the system override is edited from any
// project's matrix; choose one (the system scope is this WFE area).
export function renderContextChooser(root: HTMLElement): ViewHandle {
  const agdevworld = location.pathname.startsWith('/wfe/') ? '/' : 'http://localhost:8093/'
  const main = h('main.context-view')
  root.append(h('header.topbar', h('div.crumbs', h('a.back-to-world', { href: agdevworld }, '← agdevworld'), h('span.sep', '|'), h('a', { href: '#/' }, 'agdev'), h('span.sep', '/'), h('span.muted', 'Context')), h('div.top-actions', displayToggle())), main)
  main.append(h('p.muted', 'Loading…'))
  void api.workspaces().then(r => main.replaceChildren(h('section.card',
    h('h2', 'Context'),
    h('p', 'The system override (every project in this area) and each project\'s and workflow\'s defaults and overrides are shown in one matrix per project. Choose a project:'),
    h('ul.ctx-projects', r.workspaces.filter(w => w.observed.available).map(w => h('li', h('a', { href: `#/context/${encodeURIComponent(w.id)}` }, w.label || w.id), h('span.small.muted', ` ${w.id}`)))))))
    .catch(e => main.replaceChildren(h('div.banner.error', (e as Error).message)))
  return { dispose: () => {}, isDirty: () => false }
}
