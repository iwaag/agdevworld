// The inspector's knowledge group (improve_workflow p3): every selection of a node
// in full, whatever its strip collapses, with the means to change it.
import { categoryLabel, withoutCategory, type KnowledgeAttachment, type KnowledgeRef } from '../shared/knowledge.ts'
import { h } from './dom.ts'
import { categoryIcon, findingIcon } from './knowledgeIcons.ts'
import { openFindingDetail, openKnowledgePicker } from './knowledgeUi.ts'

export interface KnowledgeHost {
  node: string; nodeName: string; project?: string; readonly: boolean
  list: () => KnowledgeAttachment[]
  set: (list: KnowledgeAttachment[]) => void
}
export function pickFor(host: KnowledgeHost, category: string | undefined) {
  openKnowledgePicker({ node: host.node, nodeName: host.nodeName, project: host.project, category, list: host.list(), readonly: host.readonly, changed: host.set, inspect: ref => detailFor(host, ref, category) })
}
export function detailFor(host: KnowledgeHost, ref: KnowledgeRef, category?: string) {
  const row = category ?? host.list().find(a => a.findings?.some(f => f.id === ref.id))?.category
  openFindingDetail({ ref, readonly: host.readonly, project: host.project, list: host.list(), changed: host.set, replace: () => pickFor(host, row) })
}
export function knowledgePanel(host: KnowledgeHost): HTMLElement {
  const list = host.list()
  return h('div.k-panel',
    ...list.map(a => h('div.k-panel-row', { dataset: { category: a.category ?? '' } },
      h('div.k-panel-head', categoryIcon(a.category), h('strong', categoryLabel(a.category)), host.readonly ? null : h('button.link-btn.small', { type: 'button', onclick: () => pickFor(host, a.category) }, 'Choose…'),
        host.readonly ? null : h('button.link-btn.small', { type: 'button', 'aria-label': `Remove ${categoryLabel(a.category)} from this node`, onclick: () => host.set(withoutCategory(host.list(), a.category)) }, 'Remove')),
      h('input', { value: a.note ?? '', disabled: host.readonly, placeholder: 'Why this node points here (optional)', 'aria-label': `Note on ${categoryLabel(a.category)}`, onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; host.set(host.list().map(x => { if (x !== a) return x; const { note: _n, ...rest } = x; return v ? { ...rest, note: v } : rest })) } }),
      a.findings?.length ? h('ul.k-panel-list', ...a.findings.map(f => h('li', h('button.k-finding', { type: 'button', title: f.title ?? f.id, onclick: () => detailFor(host, f, a.category) }, findingIcon(f.id), h('span.k-name.k-wrap', f.title ?? f.id)), h('div.small.muted', `${f.id} @ ${f.commit.slice(0, 10)}`)))) : h('p.small.muted', 'Nothing selected: this states the intent, and a run or a later edit can choose.'))),
    list.length ? null : h('p.small.muted', 'No knowledge is attached.'),
    host.readonly ? null : h('button', { type: 'button', onclick: () => pickFor(host, undefined) }, 'Attach knowledge…'),
    h('p.small.muted', 'Points the node at knowledge, which requires nothing and proves nothing. Preferred or required outcomes are expectations.'))
}
