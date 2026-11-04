// A node's knowledge (improve_workflow p3, docs/knowledge.md *On a node*): the
// strip on a card, the candidate picker, a finding's detail, and what a run
// selected beside what its agent stated. A selection points at knowledge; these
// views never say that a finding was read, used or worked.
import { categoryLabel, KNOWLEDGE_CATEGORIES, limitSections, replacingFinding, selectedFindings, shortTitle, withCategory, withFinding, withoutCategory, withoutFinding, type KnowledgeAttachment, type KnowledgeRef } from '../shared/knowledge.ts'
import { api, type KnowledgeCandidate, type KnowledgeDecision, type KnowledgeDecisions, type KnowledgeDetail, type KnowledgeListing } from './api.ts'
import { h } from './dom.ts'
import { icon } from './icons.ts'
import { categoryIcon, findingIcon, findingLabel } from './knowledgeIcons.ts'

const MAX_SHOWN = 2 // findings under a category before they collapse to +N
const expanded = new Set<string>() // `${node}\0${category}` opened by their +N: survives a rerender

export const refName = (f: Pick<KnowledgeRef, 'id' | 'title'>) => findingLabel(f.id) ?? (f.title ? shortTitle(f.title) : f.id.split('#')[1] ?? f.id)

export interface StripEvents {
  category(node: string, category: string | undefined): void
  finding(node: string, ref: KnowledgeRef): void
}
// Controls take their own pointer and key events: they never start a node drag or select the card.
const own = (el: HTMLElement) => {
  for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick']) el.addEventListener(type, e => e.stopPropagation())
  el.addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') e.stopPropagation() })
  return el
}

export function knowledgeStrip(node: string, list: KnowledgeAttachment[] | undefined, o: { iconsOnly: boolean; readonly: boolean; events: StripEvents }): HTMLElement | null {
  if (!list?.length) return null
  const rows = list.map(a => {
    const name = categoryLabel(a.category)
    const key = `${node}\0${a.category ?? ''}`
    const all = a.findings ?? []
    const open = expanded.has(key)
    const shown = open || all.length <= MAX_SHOWN ? all : all.slice(0, MAX_SHOWN)
    const hidden = all.length - shown.length
    return h('div.k-row', { dataset: { category: a.category ?? '' } },
      own(h('button.k-cat', { type: 'button', title: `${name}: knowledge category.${a.note ? `\n${a.note}` : ''}\n${o.readonly ? 'See candidates' : 'Choose findings'}`, 'aria-label': `Knowledge category ${name}, ${all.length ? `${all.length} selected` : 'nothing selected'}. ${o.readonly ? 'See candidates' : 'Choose findings'}`, onclick: () => o.events.category(node, a.category) },
        categoryIcon(a.category), o.iconsOnly ? null : h('span.k-name', name))),
      all.length ? h('span.k-sep', { 'aria-hidden': 'true' }) : null,
      all.length ? h('div.k-findings',
      ...shown.map(f => own(h('button.k-finding', { type: 'button', dataset: { finding: f.id }, title: `${f.title ?? f.id}\n${f.id} at ${f.commit.slice(0, 10)}\nSelected, which does not show it was read or used.`, 'aria-label': `Selected finding ${f.title ?? f.id}. Open its detail`, onclick: () => o.events.finding(node, f) },
        findingIcon(f.id), o.iconsOnly ? null : h('span.k-name', refName(f))))),
      hidden > 0 || (open && all.length > MAX_SHOWN) ? own(h('button.k-more', { type: 'button', 'aria-expanded': String(open), title: open ? 'Show fewer' : all.slice(MAX_SHOWN).map(f => f.title ?? f.id).join('\n'), 'aria-label': open ? 'Show fewer findings' : `Show ${hidden} more finding${hidden === 1 ? '' : 's'}`, onclick: (e: Event) => {
        if (open) expanded.delete(key); else expanded.add(key)
        const strip = (e.currentTarget as HTMLElement).closest('.k-strip')
        const again = knowledgeStrip(node, list, o)
        if (strip && again) strip.replaceWith(again)
      } }, open ? '−' : `+${hidden}`)) : null) : null,
      !all.length && !o.readonly ? own(h('button.k-add', { type: 'button', title: `Choose findings under ${name}`, 'aria-label': `Choose findings under ${name}`, onclick: () => o.events.category(node, a.category) }, o.iconsOnly ? '+' : '+ choose')) : null)
  })
  return h(`div.k-strip${o.iconsOnly ? '.k-mini' : ''}`, { role: 'group', 'aria-label': 'Knowledge' }, ...rows)
}

// The quiet way to attach a first category. In the corner, so it takes no height.
export function knowledgeAdd(node: string, events: StripEvents): HTMLElement {
  return own(h('button.k-add-first', { type: 'button', title: 'Attach knowledge: a category and findings', 'aria-label': 'Attach knowledge to this node', onclick: () => events.category(node, undefined) }, '+ Knowledge'))
}

function dialog(cls: string, title: string, ...body: (Node | null)[]): { el: HTMLDialogElement; content: HTMLElement } {
  const content = h('div.k-dialog-body', ...body.filter((x): x is Node => !!x))
  const el = h(`dialog.k-dialog.${cls}`, { 'aria-label': title },
    h('div.k-dialog-head', h('h3', title), h('button.icon-btn', { type: 'button', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => el.close() }, icon('close', 'icon small'))), content) as HTMLDialogElement
  el.addEventListener('close', () => el.remove())
  el.addEventListener('click', e => { if (e.target === el) el.close() }) // the backdrop
  document.body.append(el)
  el.showModal()
  return { el, content }
}

const revisionWords = (r: { repository: string; commit: string }) => `${r.repository}@${r.commit.slice(0, 10)}`
const refOf = (f: KnowledgeCandidate): KnowledgeRef => ({ id: f.qid, repository: f.repository, commit: f.commit, path: f.path, sha256: f.sha256, title: f.title, summary: f.summary, ...(f.status ? { status: f.status } : {}) })
const whose = (references: { role: string; by?: string }[]) => references.filter(r => r.role === 'acceptance').map(r => r.by ?? 'not stated')

function limitsBlock(body: string | undefined): HTMLElement {
  const sections = limitSections(body ?? '')
  if (!sections.length) return h('p.small.muted', 'This document has no section named for its limits or conditions: read it in full.')
  return h('div.k-limits', ...sections.map(s => h('div', h('strong.small', s.heading), h('p.k-text.small', s.text))))
}

export interface PickerOptions {
  node: string; nodeName: string; project?: string; category: string | undefined; list: KnowledgeAttachment[]; readonly: boolean
  changed?: (list: KnowledgeAttachment[]) => void
  inspect: (ref: KnowledgeRef) => void
}
let listing: Promise<KnowledgeListing> | null = null // one read per opening of the picker
export function openKnowledgePicker(o: PickerOptions) {
  let list = o.list
  let target = o.category ?? ''
  let everywhere = !target
  let words = ''
  let data: KnowledgeListing | null = null
  let problem = ''
  const results = h('div.k-results', { 'aria-live': 'polite' }, h('p.muted.small', 'Reading what projects know…'))
  const lead = h('div.k-lead')
  const commit = (next: KnowledgeAttachment[]) => { list = next; o.changed?.(next); render() }
  const categories = () => [...new Set([...KNOWLEDGE_CATEGORIES, ...list.map(a => a.category).filter((c): c is string => !!c), ...(data?.findings.flatMap(f => f.categories) ?? []), ...(target ? [target] : [])])]
  const select = h('select', { 'aria-label': 'Category', onchange: (e: Event) => { target = (e.target as HTMLSelectElement).value; everywhere = !target; render() } })
  const all = h('input', { type: 'checkbox', onchange: (e: Event) => { everywhere = (e.target as HTMLInputElement).checked; render() } }) as HTMLInputElement
  const search = h('input.k-search', { type: 'search', placeholder: 'Search titles, summaries, tags and text', 'aria-label': 'Search findings', oninput: (e: Event) => { words = (e.target as HTMLInputElement).value.trim().toLowerCase(); renderResults() } }) as HTMLInputElement

  function renderResults() {
    if (problem) { results.replaceChildren(h('div.banner.error.small', `Knowledge could not be read: ${problem}`)); return }
    if (!data) return
    const chosen = selectedFindings(list)
    const hits = data.findings.filter(f => (everywhere || !target || f.categories.includes(target))
      && (!words || `${f.title}\n${f.summary}\n${f.tags.join(' ')}\n${f.qid}\n${f.body ?? ''}`.toLowerCase().includes(words)))
    const gone = data.collections.filter(c => c.state !== 'read')
    results.replaceChildren(
      ...(gone.length ? [h('details.banner.warn.small', h('summary', `${gone.length} collection${gone.length === 1 ? '' : 's'} could not be read, so their findings are not offered`), ...gone.map(c => h('div', `${c.id}: ${c.state}${c.problem ? `: ${c.problem}` : ''}`)))] : []),
      ...(hits.length ? hits.map(f => candidate(f, chosen.find(x => x.id === f.qid))) : [h('div.k-empty', h('p.small.muted', words ? `No finding matches "${words}"${everywhere ? '' : ` in ${categoryLabel(target)}`}.` : `No finding is categorized ${categoryLabel(target)}.`),
        !everywhere ? h('button', { type: 'button', onclick: () => { everywhere = true; render() } }, 'Search all categories') : null)]))
  }
  function candidate(f: KnowledgeCandidate, chosen: KnowledgeRef | undefined): HTMLElement {
    const ref = refOf(f)
    const moved = chosen && chosen.sha256 !== f.sha256
    const judged = whose(f.references ?? [])
    return h(`div.k-candidate${chosen ? '.is-chosen' : ''}`, { dataset: { finding: f.qid } },
      h('label.k-pick', h('input', { type: 'checkbox', checked: !!chosen, disabled: o.readonly, 'aria-label': `Select ${f.title}`, onchange: (e: Event) => commit((e.target as HTMLInputElement).checked ? withFinding(list, target || undefined, ref) : withoutFinding(list, f.qid)) }),
        findingIcon(f.qid), h('strong', f.title)),
      h('p.small', f.summary),
      h('div.k-facts.small.muted', h('span', f.categories.map(categoryLabel).join(', ')), h('span', f.collection), h('span', { title: f.commit }, revisionWords(f)), f.status ? h('span.k-status', f.status) : null),
      judged.length ? h('p.small.k-whose', 'Accepted by: ', judged.join('; ')) : h('p.small.muted.k-whose', 'No acceptance is recorded.'),
      moved ? h('div.banner.warn.small', `Selected at ${chosen.commit.slice(0, 10)}; the document has changed since. The selection stays there until you take this revision. `, o.readonly ? null : h('button', { type: 'button', onclick: () => commit(replacingFinding(list, ref)) }, 'Take this revision')) : null,
      h('details.k-limits-box', h('summary.small', 'Conditions and limits, from the document'), limitsBlock(f.body)),
      h('button.link-btn.small', { type: 'button', onclick: () => o.inspect(chosen ?? ref) }, 'Read the whole finding'))
  }
  function render() {
    select.replaceChildren(h('option', { value: '', selected: !target }, 'No category'), ...categories().map(c => h('option', { value: c, selected: c === target }, categoryLabel(c))))
    all.checked = everywhere
    all.disabled = !target
    const has = list.some(a => (a.category ?? '') === target)
    const row = list.find(a => (a.category ?? '') === target)
    lead.replaceChildren(...[
      o.readonly ? h('p.small.muted', 'Read-only here: an edit of the definition or a run adjustment changes a selection.') : null,
      target && !has && !o.readonly ? h('button', { type: 'button', onclick: () => commit(withCategory(list, target)) }, `Attach ${categoryLabel(target)} with nothing selected`) : null,
      has && !o.readonly ? h('button', { type: 'button', title: `Removes ${categoryLabel(target)}${row?.findings?.length ? ` and its ${row.findings.length} selected finding${row.findings.length === 1 ? '' : 's'}` : ''} from this node`, onclick: () => commit(withoutCategory(list, target || undefined)) }, `Remove ${categoryLabel(target)} from this node`) : null,
    ].filter(x => x !== null))
    renderResults()
  }
  dialog('k-picker', `Knowledge for ${o.nodeName}`,
    h('p.small.muted', 'This points the node at knowledge. It requires nothing and proves nothing: the agent may use, adapt or reject it. Categories help you look; a finding from any category can be selected.'),
    h('div.k-controls', h('label.field', h('span', 'Category'), select), h('label.check', all, h('span', 'Search all categories')), search),
    lead, results)
  render()
  search.focus()
  listing ??= api.knowledgeCandidates(o.project)
  void listing.then(d => { data = d; render() }, (e: Error) => { problem = e.message; render() }).finally(() => { listing = null })
}

const mediaKind = (v: { role: string; ref: string; view?: string }) => /\.(mp4|webm|mov)$/i.test(v.ref) ? 'video' : /\.(png|jpe?g|webp|gif|svg)$/i.test(v.ref) ? 'image' : 'link'
export interface DetailOptions { ref: KnowledgeRef; readonly: boolean; project?: string; list?: KnowledgeAttachment[]; changed?: (list: KnowledgeAttachment[]) => void; replace?: () => void }
export function openFindingDetail(o: DetailOptions) {
  const body = h('div', h('p.muted.small', 'Reading the document at its selected revision…'))
  const { el } = dialog('k-detail', o.ref.title ?? o.ref.id, h('div.k-detail-id', findingIcon(o.ref.id), h('code.small', o.ref.id)), body)
  void Promise.all([
    api.knowledgeFinding(o.ref.id, { rev: o.ref.commit, current: o.project }).catch((e: Error) => e),
    api.knowledgeFinding(o.ref.id, { current: o.project }).catch((e: Error) => e),
  ]).then(([at, now]) => { if (el.isConnected) body.replaceChildren(...detailBody(o, at, now, el)) })
}
function detailBody(o: DetailOptions, at: KnowledgeDetail | Error, now: KnowledgeDetail | Error, el: HTMLDialogElement): (Node)[] {
  const { ref } = o
  const out: Node[] = []
  const facts = h('dl.kv.small', h('dt', 'Selected at'), h('dd', `${ref.repository}@${ref.commit.slice(0, 10)}`), h('dt', 'Document'), h('dd', ref.path), h('dt', 'sha256'), h('dd', h('code', ref.sha256.slice(0, 16))), ...(ref.status ? [h('dt', 'Status'), h('dd', ref.status)] : []))
  if (at instanceof Error) {
    out.push(h('div.banner.warn.small', `The source is unavailable, so this is what was recorded when it was selected. ${at.message}`), facts, h('p', ref.summary ?? ''))
  } else {
    const f = at.finding
    if (f.sha256 !== ref.sha256) out.push(h('div.banner.warn.small', `The document at this revision has sha256 ${f.sha256.slice(0, 16)}, not the selected ${ref.sha256.slice(0, 16)}.`))
    if (now instanceof Error) out.push(h('div.banner.warn.small', `Its current revision could not be read: ${now.message}`))
    else if (now.finding.sha256 !== ref.sha256) out.push(h('div.banner.warn.small', `This has changed since it was selected: currently ${revisionWords(now.finding)}. The selection stays at the revision shown here. `,
      !o.readonly && o.changed && o.list ? h('button', { type: 'button', onclick: () => { const n = now.finding; o.changed!(replacingFinding(o.list!, { id: n.qid, repository: n.repository, commit: n.commit, path: n.path, sha256: n.sha256, title: n.title, summary: n.summary, ...(n.status ? { status: n.status } : {}) })); el.close() } }, 'Take the current revision') : null))
    out.push(facts, h('p', f.summary))
    const acceptances = f.references.filter(r => r.role === 'acceptance')
    out.push(h('h4', 'Whose judgement'), acceptances.length
      ? h('ul.small', ...acceptances.map(r => h('li', h('strong', r.by ?? 'not stated'), r.note ? `: ${r.note}` : '')))
      : h('p.small.muted', 'No acceptance is recorded.'),
    h('p.small.muted', 'As the document records it: free text, not a verified identity. An example is not an acceptance, and neither is a person\'s review unless it says so.'))
    out.push(h('h4', 'Conditions and limits'), limitsBlock(f.body))
    const shown = f.references.filter(r => r.role === 'illustration')
    if (shown.length) out.push(h('h4', 'To look at'), h('p.small.muted', 'Illustrations, which do not show that the method works.'), ...shown.map(r => {
      const url = r.view
      const kind = mediaKind(r)
      return h('div.k-illustration.small', r.note ? h('p', r.note) : null, !url ? h('span.muted', `${r.ref} (${r.state}${r.reason ? `: ${r.reason}` : ''})`) : h('a', { href: url, target: '_blank', rel: 'noopener' }, r.ref),
        url && kind === 'video' ? h('video', { src: url, controls: true, preload: 'none', 'aria-label': r.note ?? r.ref }) : null, url && kind === 'image' ? h('img', { src: url, loading: 'lazy', alt: r.note ?? r.ref }) : null)
    }))
    const evidence = f.references.filter(r => r.role !== 'illustration' && r.role !== 'acceptance')
    if (evidence.length) out.push(h('h4', 'References'), h('p.small.muted', 'resolved means it exists at this revision, not that the claim is true.'), h('ul.small', ...evidence.map(r => h('li', `[${r.state}] ${r.role}: `, r.view ? h('a', { href: r.view, target: '_blank', rel: 'noopener' }, r.ref) : r.ref, r.note ? ` — ${r.note}` : ''))))
    out.push(h('details.k-body-box', h('summary', 'The whole document'), h('div.k-text.small', f.body)))
  }
  if (!o.readonly && o.changed && o.list) out.push(h('div.k-actions',
    o.replace ? h('button', { type: 'button', onclick: () => { el.close(); o.replace!() } }, 'Replace…') : null,
    h('button.danger', { type: 'button', onclick: () => { o.changed!(withoutFinding(o.list!, ref.id)); el.close() } }, 'Remove from this node')))
  return out
}

// ---- a run: what is selected, how it developed, what the agent stated ----
// Built into patched content (src/patch.ts), which carries no listeners: a
// finding opens through the run view's delegated data-action.
const findingButton = (f: KnowledgeRef, name: string) => h('button.k-finding', { type: 'button', title: f.title ?? f.id, dataset: { action: 'knowledge-finding', finding: f.id, ref: JSON.stringify(f) } }, findingIcon(f.id), h('span.k-name', name))

const selectionList = (l: KnowledgeAttachment[]) => l.length
  ? h('ul.k-selection', ...l.map(a => h('li', categoryIcon(a.category), h('span.k-name', categoryLabel(a.category)), a.note ? h('span.small.muted', ` ${a.note}`) : null, a.findings?.length
    ? h('ul', ...a.findings.map(f => h('li', findingButton(f, f.title ?? f.id), h('span.small.muted', ` @${f.commit.slice(0, 10)}`))))
    : h('span.small.muted', ' — nothing selected'))))
  : h('p.small.muted', 'Nothing selected.')

export function knowledgeSelectionBlock(history: { current: KnowledgeAttachment[]; origin: { revision: string; knowledge: KnowledgeAttachment[]; from?: { examples: string[]; revision: string } } | null; changes: { revision: string; reason: string; before: KnowledgeAttachment[]; after: KnowledgeAttachment[] }[] }): HTMLElement {
  const { current, origin, changes } = history
  return h('div.k-run-selection', { dataset: { kSelection: '1' } },
    h('h4', 'Knowledge selected'),
    selectionList(current),
    h('p.small.muted', 'A selection is what this node points at. It is not proof of reading, use or success.'),
    origin?.from ? h('div.small', h('strong', `From example ${origin.from.examples.join(', ')} of ${origin.from.revision}: `), selectionList(origin.knowledge)) : null,
    changes.length ? h('details.k-history', { open: true }, h('summary.small', `Changed ${changes.length} time${changes.length === 1 ? '' : 's'}; originally`), origin && !origin.from ? selectionList(origin.knowledge) : null,
      ...changes.map(c => h('div.small.k-change', h('strong', `${c.revision}: `), c.reason || 'no reason recorded', h('div.muted', 'Before: ', selectionWords(c.before)), h('div.muted', 'After: ', selectionWords(c.after))))) : null)
}
const selectionWords = (l: KnowledgeAttachment[]) => l.map(a => `${categoryLabel(a.category)}${a.findings?.length ? `: ${a.findings.map(refName).join(', ')}` : ''}`).join('; ') || 'nothing'

const RESOLVED: Record<KnowledgeDecision['state'], string> = {
  resolved: 'the recorded revision holds this document, which does not show that it was read',
  different: 'the record differs from what that revision holds',
  missing: 'the recorded revision does not hold this finding',
  unpublished: 'read from unpublished bytes',
  unchecked: 'could not be checked',
  none: 'no finding named',
  invalid: 'the entry is malformed',
}
export function decisionRow(d: KnowledgeDecision): HTMLElement {
  const r = d.recorded
  const ref: KnowledgeRef | null = d.finding && d.finding !== 'none' && r?.commit ? { id: d.finding, repository: r.repository ?? '', commit: r.commit, path: r.path ?? '', sha256: r.sha256 ?? '', title: d.atRevision?.title ?? r.title } : null
  const items = (name: string, v: KnowledgeDecision['work']) => h('div.small', `${name}: `, v.length ? v.map(i => `${i.ref} [${i.state}]`).join(', ') : h('span.muted', 'none recorded'))
  return h(`div.k-decision.k-decision-${d.state}`, { dataset: { finding: d.finding, decision: d.decision } },
    h('div', h('span.k-stated', `Stated: ${d.decision || 'no label'}`), ' ', ref ? findingButton(ref, ref.title ?? ref.id) : h('span', d.finding || 'no finding')),
    d.reason ? h('p.small.k-text', d.reason) : h('p.small.muted', 'No reason recorded.'),
    r?.commit ? h('div.small.muted', `Read at ${r.repository ? `${r.repository}@` : ''}${r.commit.slice(0, 10)}, as stated: ${RESOLVED[d.state]}.`) : h('div.small.muted', RESOLVED[d.state]),
    d.detail ? h('div.banner.warn.small', d.detail) : null,
    d.current && 'changed' in d.current && d.current.changed ? h('div.small.muted', `The document has changed since: currently ${d.current.commit.slice(0, 10)}.`) : null,
    d.current && 'problem' in d.current ? h('div.small.muted', `Its current revision could not be read: ${d.current.problem}`) : null,
    d.nodeState === 'unknown' ? h('div.banner.warn.small', `It names node "${d.node}", which no revision of this run has.`) : null,
    items('Work', d.work), items('Verification', d.verification))
}
export function nodeDecisions(all: KnowledgeDecisions | Error | null, node: string): HTMLElement {
  const box = h('div.k-run-decisions', { dataset: { kDecisions: node } }, h('h4', 'What the agent stated'))
  if (!all) box.append(h('p.small.muted', 'Reading the run\'s records…'))
  else if (all instanceof Error) box.append(h('div.banner.warn.small', `Its decisions could not be read: ${all.message}`))
  else {
    const mine = all.decisions.filter(d => d.node === node && d.nodeState === 'known')
    box.append(...mine.map(d => decisionRow(d)))
    box.append(mine.length ? h('p.small.muted', 'The agent\'s statements, to compare with the work.') : h('p.small.muted', 'No decision is recorded for this node. That does not mean no finding applied, or that none was read.'))
  }
  return box
}
export function runDecisionsBlock(all: KnowledgeDecisions | Error | null, nodes: Set<string>): HTMLElement {
  if (!all) return h('p.small.muted', 'Reading the run\'s records…')
  if (all instanceof Error) return h('div.banner.warn.small', `Its decisions could not be read: ${all.message}`)
  const rest = all.decisions.filter(d => !d.node || d.nodeState !== 'known' || !nodes.has(d.node))
  return h('div', { dataset: { kRunLevel: '1' } },
    ...all.problems.map(p => h('div.banner.warn.small', p)),
    all.decisions.length ? h('p.small.muted', `${all.decisions.length} statement${all.decisions.length === 1 ? '' : 's'} in ${all.files.join(', ')}, from the agent. ${rest.length} of them concern${rest.length === 1 ? 's' : ''} the run as a whole, or no node of the graph in force.`) : h('p.small.muted', 'No decision is recorded. None is required, and silence does not mean no finding applied.'),
    ...rest.map(d => decisionRow(d)),
    all.decisions.length !== rest.length ? h('p.small.muted', 'Those about a node are on that node.') : null)
}
export const openFindingReadonly = (ref: KnowledgeRef, project?: string) => openFindingDetail({ ref, readonly: true, project })
