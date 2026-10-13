// Creating a workflow from the project's workflow list (p8/ex2). One entry,
// "Create workflow", in Simple and Detail alike, also when the list is
// empty. The form asks only for a name. The id (derived from the name), the
// starting template and the documentation policy are behind "More
// settings", which opens by itself when one of them needs attention.
//
// The form is built once and moved, never rebuilt, when the project view
// renders again (a background reload, a Simple/Detail switch), so what was
// typed, the open state and the keyboard stay where they were.
import { ID_PATTERN, type Documentation } from '../shared/model.ts'
import { docPolicyEditor } from './docPolicy.ts'
import { api, ApiError } from './api.ts'
import { h } from './dom.ts'
import { icon } from './icons.ts'

export interface WorkflowCreator {
  button: HTMLButtonElement // "+ Create workflow", for the card head
  form: HTMLElement // the form itself, hidden until opened
  update: (o: { existing: string[]; enabled: boolean; reason?: string }) => void
  open: () => void
}

// A workflow id from a display name: lowercase ASCII words joined by "-".
// A name without such words (Japanese, say) gives "" and the caller falls
// back to a numbered id.
export function idFromName(name: string): string {
  const slug = name.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '')
  return ID_PATTERN.test(slug) ? slug : ''
}
export function freeId(base: string, taken: Set<string>): string {
  const root = base || 'workflow'
  if (!taken.has(root) && base) return root
  for (let n = 2; ; n++) if (!taken.has(`${root}-${n}`)) return `${root}-${n}`
}

export function workflowCreator(wsId: string, onCreated: (file: string) => void): WorkflowCreator {
  let existing = new Set<string>()
  let enabled = true
  let idTouched = false
  let busy = false
  let templatesLoaded = false
  const errors: Record<string, string> = {}

  const name = h('input', { 'aria-label': 'Name of the new workflow', placeholder: 'What this workflow does, e.g. Release check', autocomplete: 'off' })
  const id = h('input', { 'aria-label': 'Id of the new workflow', autocomplete: 'off', spellcheck: false })
  // The documentation setting starts as the chosen template's (p8/ex2).
  // A template's setting applies until the person changes the documents;
  // choosing a template again applies that template's.
  let documentation: Documentation = { policy: 'default' }
  let docTouched = false
  const docField = h('div.doc-field')
  const renderDoc = () => docField.replaceChildren(docPolicyEditor(documentation, { label: 'Documentation policy of the new workflow', onChange: () => { docTouched = true; clear('policy') } }))
  renderDoc()
  const policy = docField
  const template = h('div.template-choice', { role: 'radiogroup', 'aria-label': 'Start from' })
  const more = h('details.create-more', h('summary', 'More settings'))
  const fieldError = (key: string) => h('p.field-error', { id: `create-wf-${key}-error`, hidden: true, role: 'alert' })
  const nameError = fieldError('name'), idError = fieldError('id'), policyError = fieldError('policy'), templateError = fieldError('template')
  const formError = h('div.banner.error', { hidden: true, role: 'alert' })
  const disabledNote = h('p.muted.small', { hidden: true })
  const submit = h('button.primary', { type: 'submit' }, 'Create')
  const cancel = h('button', { type: 'button', onclick: () => close() }, 'Cancel')
  const templateField = h('div.field.template-field', { hidden: true }, h('span', 'Start from'), template, templateError)
  more.append(
    h('label.field', h('span', 'Id'), id, h('span.field-hint', 'Stable name used in files and links. Derived from the name until you change it.'), idError),
    h('div.field', h('span', 'Documents'), policy, policyError))
  const form = h('form.create-wf', { hidden: true, 'aria-label': 'Create a workflow', novalidate: true },
    h('h3', 'New workflow'),
    h('label.field', h('span', 'Name'), name, nameError),
    templateField, more, formError, disabledNote,
    h('div.save-row', submit, cancel))
  const button = h('button.create-wf-open', { type: 'button', 'aria-expanded': 'false', onclick: () => (form.hidden ? open() : close()) }, icon('plus', 'icon small'), 'Create workflow')

  const derived = () => freeId(idFromName(name.value), existing)
  const syncId = () => { if (!idTouched) id.value = derived() }
  name.addEventListener('input', () => { syncId(); clear('name'); clear('id') })
  id.addEventListener('input', () => { idTouched = id.value.trim() !== ''; clear('id') })
  id.addEventListener('blur', () => { if (!id.value.trim()) { idTouched = false; syncId() } })

  function show(key: string, el: HTMLElement, input?: HTMLElement) {
    const msg = errors[key] ?? ''
    el.textContent = msg
    el.hidden = !msg
    if (input) { if (msg) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', el.id) } else { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby') } }
  }
  function paint() {
    show('name', nameError, name); show('id', idError, id); show('policy', policyError, policy.querySelector('select') ?? undefined); show('template', templateError)
    formError.textContent = errors.form ?? ''
    formError.hidden = !errors.form
    submit.disabled = busy || !enabled
    disabledNote.hidden = enabled
  }
  function clear(key: string) { if (errors[key] || errors.form) { delete errors[key]; delete errors.form; paint() } }

  async function loadTemplates() {
    if (templatesLoaded) return
    try {
      const list = await api.workflowTemplates(wsId)
      templatesLoaded = true
      const current = (template.querySelector<HTMLInputElement>('input:checked'))?.value ?? 'empty'
      const chosen = list.find(t => t.id === current)
      if (chosen && !docTouched) { documentation = structuredClone(chosen.documentation); renderDoc() }
      template.replaceChildren(...list.map(t => h('label.template-option',
        h('input', { type: 'radio', name: 'create-wf-template', value: t.id, checked: t.id === current, onchange: () => { clear('template'); documentation = structuredClone(t.documentation); docTouched = false; renderDoc() } }),
        h('span.template-text', h('strong', t.name), h('span.muted.small', t.description)))))
      templateField.hidden = list.length < 2 // one starting point needs no choice
    } catch { /* the default (empty) stays; the service names any problem on Create */ }
  }

  function open() {
    form.hidden = false
    button.setAttribute('aria-expanded', 'true')
    syncId()
    void loadTemplates()
    name.focus()
  }
  function close() {
    form.hidden = true
    button.setAttribute('aria-expanded', 'false')
    button.focus()
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    if (busy) return
    for (const k of Object.keys(errors)) delete errors[k]
    const wid = (id.value.trim() || derived())
    if (!name.value.trim()) errors.name = 'Give the workflow a name.'
    if (!ID_PATTERN.test(wid)) errors.id = 'Use lowercase letters, digits and - _ . (starting with a letter or digit).'
    else if (existing.has(wid)) errors.id = `"${wid}" is already used by another workflow of this project.`
    if (errors.id) more.open = true
    if (errors.name || errors.id) { paint(); (errors.name ? name : id).focus(); return }
    busy = true; paint()
    try {
      const t = template.querySelector<HTMLInputElement>('input:checked')?.value ?? 'empty'
      const r = await api.createWorkflow(wsId, wid, name.value.trim(), documentation, t)
      name.value = ''; id.value = ''; idTouched = false; docTouched = false
      onCreated(r.file)
    } catch (e) {
      const field = (e instanceof ApiError ? (e.detail as { field?: string } | undefined)?.field : undefined) ?? 'form'
      errors[field] = (e as Error).message
      if (field === 'id' || field === 'policy') more.open = true
      paint()
      ;({ id, policy: policy.querySelector('select') ?? policy, name } as Record<string, HTMLElement>)[field]?.focus()
    } finally {
      busy = false; paint()
    }
  })

  return {
    button, form, open,
    update(o) {
      existing = new Set(o.existing)
      enabled = o.enabled
      disabledNote.textContent = o.reason ? `A workflow cannot be created here: ${o.reason}` : ''
      button.disabled = !enabled && !!form.hidden
      syncId()
      paint()
    },
  }
}

// Keeps the keyboard where it was while a view replaces its content around
// persistent controls (a reload re-inserts them, which drops focus).
export function keepingFocus(scope: HTMLElement, fn: () => void) {
  const a = document.activeElement
  const inside = a instanceof HTMLElement && scope.contains(a) ? a : null
  const range = inside instanceof HTMLInputElement || inside instanceof HTMLTextAreaElement ? [inside.selectionStart, inside.selectionEnd, inside.selectionDirection] as const : null
  fn()
  if (inside?.isConnected && document.activeElement !== inside) {
    inside.focus({ preventScroll: true })
    if (range && (inside instanceof HTMLInputElement || inside instanceof HTMLTextAreaElement)) { try { inside.setSelectionRange(range[0], range[1], range[2] ?? undefined) } catch { /* not a text input */ } }
  }
}
