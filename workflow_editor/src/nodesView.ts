// User nodes (p7/ex1, docs/catalog.md): the person's node catalog — the
// activities they recognize as distinct workflow steps, each a reusable
// template over an existing node type. A list of card previews, an editor
// for one template at a time, and the examples on offer. The service's
// catalog operations do the validation and the stale-edit check; a catalog
// that cannot be read is shown as such and nothing is written over it.
import { contentProblems, TEMPLATE_TYPES, type NodeTemplate, type TemplateContent } from '../shared/catalog.ts'
import { APPEARANCE_COLORS, APPEARANCE_ICONS, ID_PATTERN } from '../shared/model.ts'
import { api, type CatalogView } from './api.ts'
import { colorOf, iconOf, TYPE_LABEL } from './canvas.ts'
import { append, h, when } from './dom.ts'
import { icon } from './icons.ts'
import type { ViewHandle } from './main.ts'
import { displayToggle, showDetail } from './displayMode.ts'

const ACTOR_KEY = 'workflow-editor.actor'
const stored = () => { try { return localStorage.getItem(ACTOR_KEY) ?? '' } catch { return '' } }
const store = (v: string) => { try { localStorage.setItem(ACTOR_KEY, v) } catch { /* per-viewer convenience only */ } }

// A card as the workflow editor draws it, for previews.
export function templateCard(t: Pick<TemplateContent, 'type' | 'name' | 'description' | 'appearance'>, extra?: HTMLElement | null): HTMLElement {
  const color = colorOf(t.appearance)
  return h(`div.node.preview.type-${(TEMPLATE_TYPES as readonly string[]).includes(t.type) ? t.type : 'unknown'}${color ? `.color-${color}` : ''}`,
    h('div.node-head', icon(iconOf(t.type, t.appearance), 'icon type-icon'), h('span.type-label', TYPE_LABEL[t.type] ?? (t.type || 'no type'))),
    h('div.node-title', t.name || '(no name)'),
    h('div.node-desc', t.description || '—'),
    extra ?? null)
}

interface Draft { id: string; content: TemplateContent; revision: number | null } // revision null: a new template

export function renderNodesView(root: HTMLElement): ViewHandle {
  let view: CatalogView | null = null
  let loadError = ''
  let draft: Draft | null = null
  let saved = '' // canonical text of the draft as last loaded or saved
  let message: HTMLElement | null = null
  let busy = false
  let disposed = false

  const agdevworld = location.pathname.startsWith('/wfe/') ? '/' : 'http://localhost:8093/'
  const header = h('header.topbar', h('div.crumbs', h('a.back-to-world', { href: agdevworld, title: 'agdevworld operation room' }, '← agdevworld'), h('span.sep', '|'),
    h('a', { href: '#/' }, 'agdev'), h('span.sep', '/'), h('span.muted', 'User nodes')),
    h('div.top-actions', h('button.d-only', { onclick: () => void load() }, 'Refresh'), displayToggle()))
  const main = h('main.nodes-view')
  root.append(header, main)
  const by = h('input', { 'aria-label': 'Your name', placeholder: 'your name', value: stored(), oninput: () => store(by.value.trim()) })

  const textOf = (d: Draft | null) => JSON.stringify(d)
  const dirty = () => !!draft && textOf(draft) !== saved
  const templates = () => (view?.state === 'ok' ? view.catalog.templates : [])

  async function load(keep?: string) {
    try { view = await api.catalog(); loadError = '' } catch (e) { loadError = (e as Error).message }
    if (keep !== undefined) {
      const t = templates().find(x => x.id === keep)
      draft = t ? { id: t.id, content: contentFrom(t), revision: t.revision } : null
      saved = textOf(draft)
    }
    if (!disposed) render()
  }
  const contentFrom = (t: TemplateContent): TemplateContent => ({ name: t.name, type: t.type, description: t.description, expectation: t.expectation, appearance: { icon: t.appearance?.icon ?? '', color: t.appearance?.color ?? '' } })

  function select(t: NodeTemplate | null) {
    if (dirty() && !confirm('Discard the unsaved changes to this template?')) return
    message = null
    draft = t ? { id: t.id, content: contentFrom(t), revision: t.revision } : { id: '', content: { name: '', type: 'do', description: '', expectation: '', appearance: { icon: '', color: '' } }, revision: null }
    saved = t ? textOf(draft) : ''
    render()
  }

  async function act(f: () => Promise<unknown>, done: string, keep?: string) {
    if (!by.value.trim()) { message = h('div.banner.error', 'Enter your name: the catalog records who changed what.'); render(); return }
    busy = true; render()
    try {
      await f()
      message = h('div.banner.ok', done)
      await load(keep)
    } catch (e) {
      const stale = /revision|changed since/.test((e as Error).message)
      message = h('div.banner.error', (e as Error).message, stale ? h('button', { onclick: () => { saved = ''; void load(draft?.id) } }, 'Reload it (discards your edit)') : null)
    }
    busy = false
    render()
  }

  function save() {
    if (!draft) return
    const d = draft
    const content = { ...d.content, ...(d.content.appearance?.icon || d.content.appearance?.color ? {} : { appearance: undefined }) }
    if (d.revision === null) void act(() => api.createTemplate({ id: d.id.trim(), ...content, by: by.value.trim() }), `Created template ${d.id.trim()}.`, d.id.trim())
    else void act(() => api.updateTemplate(d.id, { ...content, expectRevision: d.revision!, by: by.value.trim() }), `Saved ${d.id}.`, d.id)
  }

  function editor(): HTMLElement {
    const card = h('section.card.node-editor')
    if (!draft) { card.append(h('h2', 'Template'), h('p.muted', 'Select a template to edit it, or create a new one.')); return card }
    const d = draft
    // Typing updates the draft and what derives from it (preview, problems,
    // buttons) without rebuilding the inputs, so focus and a click into the
    // next field are never lost.
    const derived = h('div.derived')
    const refresh = () => { message = null; main.querySelector('.message-slot')?.replaceChildren(); derived.replaceChildren(...derivedParts(d)) }
    const set = (k: keyof TemplateContent) => (e: Event) => { (d.content as unknown as Record<string, unknown>)[k] = (e.target as HTMLInputElement).value; refresh() }
    const setA = (k: 'icon' | 'color') => (e: Event) => { d.content.appearance = { icon: d.content.appearance?.icon ?? '', color: d.content.appearance?.color ?? '', [k]: (e.target as HTMLSelectElement).value }; refresh() }
    const opt = (list: readonly string[], cur: string, label: string) => [h('option', { value: '', selected: !cur }, `${label}: type default`), ...list.map(v => h('option', { value: v, selected: v === cur }, `${label}: ${v}`))]
    append(card, [
      h('h2', d.revision === null ? 'New template' : h('span.d-only', `Template ${d.id}`), d.revision === null ? null : h('span.s-only', d.content.name || d.id), d.revision !== null ? h('span.chip.d-only', `revision ${d.revision}`) : null),
      h('div.editor-fields.d-only',
      d.revision === null ? h('label.field', h('span', 'Id (stable; never reused)'), h('input', { value: d.id, 'aria-label': 'Template id', placeholder: 'preliminary-research', oninput: (e: Event) => { d.id = (e.target as HTMLInputElement).value; refresh() } })) : null,
      h('label.field', h('span', 'Name — the card label'), h('input', { value: d.content.name, 'aria-label': 'Template name', oninput: set('name') })),
      h('label.field', h('span', 'Type — how it runs'), h('select', { 'aria-label': 'Template type', onchange: set('type') },
        TEMPLATE_TYPES.map(t => h('option', { value: t, selected: t === d.content.type }, `${TYPE_LABEL[t]} (${t})`)))),
      h('label.field', h('span', 'Description — for the agent performing it: what to do and record'), h('textarea', { rows: 5, value: d.content.description, 'aria-label': 'Template description', oninput: set('description') })),
      h('p.muted.small', 'Copied into the node\'s description when the template is used. The node then runs like any node of its type.'),
      h('label.field', h('span', 'Expectation — for whoever designs the workflow: how you expect this to appear'), h('textarea', { rows: 3, value: d.content.expectation, 'aria-label': 'Template expectation', oninput: set('expectation') })),
      h('p.muted.small', 'Agents planning a run are told that you recognize this activity as a distinct step and generally expect it as a visible node when it is relevant. They still decide whether and where.'),
      h('div.field', h('span', 'Appearance (display only)'), h('div.appearance-row',
        h('select', { 'aria-label': 'Template icon', onchange: setA('icon') }, opt(APPEARANCE_ICONS, d.content.appearance?.icon ?? '', 'icon')),
        h('select', { 'aria-label': 'Template color', onchange: setA('color') }, opt(APPEARANCE_COLORS, d.content.appearance?.color ?? '', 'color'))))),
      derived,
      h('div.row.s-only', h('button.primary', { onclick: () => showDetail(() => card.querySelector<HTMLElement>('input, textarea')?.focus()) }, icon('settings', 'icon small'), 'Edit template')),
    ])
    derived.replaceChildren(...derivedParts(d))
    return card
  }
  function derivedParts(d: Draft): HTMLElement[] {
    const problems = [...(d.revision === null && !ID_PATTERN.test(d.id.trim()) ? ['id must match a-z 0-9 . _ - (start with a letter or digit)'] : []), ...contentProblems(d.content)]
    return [
      h('div.field', h('span.d-only', 'Preview'), h('div.preview-slot', templateCard(d.content))),
      ...(problems.length ? [h('ul.diagnostics.d-only', problems.map(p => h('li.warning', p)))] : []),
      h('div.row.d-only',
        h('button.primary', { disabled: busy || !!problems.length || (d.revision !== null && !dirty()), onclick: save }, d.revision === null ? 'Create' : 'Save'),
        d.revision !== null ? h('button', { disabled: busy || !dirty(), onclick: () => { draft = JSON.parse(saved) as Draft; render() } }, 'Discard changes') : null,
        d.revision !== null ? h('button.danger', { disabled: busy, onclick: () => { if (confirm(`Delete template ${d.id}? Nodes made from it keep their content and provenance; the id is not reused.`)) void act(() => api.deleteTemplate(d.id, d.revision!, by.value.trim()), `Deleted ${d.id}.`, '') } }, 'Delete') : null),
    ]
  }

  function list(): HTMLElement {
    const card = h('section.card.node-list', h('h2', 'Your templates'))
    if (loadError) { card.append(h('div.banner.error', 'The catalog cannot be read from the service: ', loadError)); return card }
    if (!view) { card.append(h('p.muted', 'Loading…')); return card }
    if (view.state !== 'ok') {
      card.append(h('div.banner.error', h('strong', 'Your node catalog is unavailable: '), view.problem, ' — nothing is shown or written until the file is fixed by hand. It is never replaced with defaults.'), h('p.muted.small', view.file))
      return card
    }
    const items = view.catalog.templates
    card.append(items.length ? h('div.template-list', items.map(t => h(`div.template-item${draft?.id === t.id && draft.revision !== null ? '.selected' : ''}`, { dataset: { template: t.id }, role: 'button', tabIndex: 0, onclick: () => select(t) },
      templateCard(t), h('div.small.d-only', h('code', t.id), ` r${t.revision} · changed ${when(t.updated)} by ${t.by}`), h('div.small.expectation.d-only', h('span.muted', 'Expects: '), t.expectation))))
      : h('p.muted', 'No templates. An empty catalog says that you have not named any activity you expect as its own node.'))
    card.append(h('div.row', h('button', { disabled: busy, onclick: () => showDetail(() => select(null)) }, '+ New template')))
    const deleted = view.catalog.deleted
    const offered = view.examples.filter(x => !items.some(t => t.id === x.id) && !deleted.some(d => d.id === x.id))
    if (offered.length) {
      card.append(h('h3.d-only', 'Examples'), h('p.muted.small.d-only', 'Nothing is added for you. Choose one to make it your own template, then edit it.'),
        ...offered.map(x => h('div.template-item.example.d-only', { dataset: { example: x.id } }, templateCard(x), h('div.small.expectation', h('span.muted', 'Expects: '), x.expectation),
          h('button', { disabled: busy, onclick: () => void act(() => api.addExample(x.id, by.value.trim()), `Added ${x.id} as your template. Edit it to say what you expect.`, x.id) }, `Add "${x.name}"`))))
    }
    card.append(h('p.muted.small.source.d-only', `${view.file} · generation ${view.catalog.generation}${view.catalog.initialized ? ` · initialized ${when(view.catalog.initialized.at)} with ${view.catalog.initialized.seeded.join(', ') || 'nothing'}` : ''}`))
    return card
  }

  function render() {
    const scroll = main.scrollTop
    main.replaceChildren()
    append(main, [
      h('section.card.nodes-intro', h('h2', 'User nodes'),
        h('p.s-only.hero-purpose', 'The activities you recognize as distinct steps. "Add node" in a workflow offers them.'),
        h('p.d-only', 'Activities you recognize as distinct workflow steps. Each is a reusable node over an existing type. In the workflow editor, "Add node" offers them beside the basic types. Agents performing a run receive this catalog (as it was when the run was created) as your expectations, with the tools to add such a node. Nothing is added to a workflow by itself.'),
        h('label.field.inline', h('span', 'Your name'), by)),
      h('div.message-slot', message),
      h('div.nodes-grid', list(), editor())])
    main.scrollTop = scroll
  }

  render()
  void load()
  return { dispose: () => { disposed = true }, isDirty: dirty }
}
