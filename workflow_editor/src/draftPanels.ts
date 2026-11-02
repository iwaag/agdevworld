// What editing a draft needs beside the graph (workflow_editor p20): resuming or
// starting a draft, a trial's words, and resolving a conflict with the published
// definition. Each is a small panel with its own state; the workflow view owns
// the draft.
import type { DraftConflict, DraftMeta, MergeSegment } from '../shared/drafts.ts'
import { h, when } from './dom.ts'

export const draftHash = (wsId: string, file: string, id: string) => `#/ws/${encodeURIComponent(wsId)}/wf/${encodeURIComponent(file)}/draft/${encodeURIComponent(id)}`

export function draftsChooser(wsId: string, drafts: DraftMeta[], latestSha: string | null | undefined, onAnother: () => void): HTMLElement {
  return h('div.banner.warn.draft-chooser', { role: 'group', 'aria-label': 'Existing drafts' },
    h('strong', drafts.length === 1 ? 'A draft of this workflow exists.' : `${drafts.length} drafts of this workflow exist.`),
    ...drafts.map(d => h('span.draft-choice',
      h('a.button', { href: draftHash(wsId, d.file, d.id) }, `Resume draft by ${d.author}`),
      h('span.small', ` saved ${when(d.updated)}${d.updatedBy !== d.author ? ` by ${d.updatedBy}` : ''}${latestSha !== undefined && d.base.sha256 !== latestSha ? ' · Latest version changed since it began' : ''}`))),
    h('button', { type: 'button', onclick: onAnother }, 'Start another draft'))
}

// The hunks of a conflict, each kept as mine, the latest, or typed by hand. The
// whole result can also be edited as text before it becomes a saved revision.
export function conflictPanel(c: DraftConflict, a: { resolve: (r: { text?: string; recreate?: boolean; retarget?: string }) => void; discard: () => void; busy: boolean }): HTMLElement {
  const panel = h('section.conflict-panel', { 'aria-label': 'Changes to resolve' }, h('h3', 'Latest version changed'), h('p', c.message))
  const source = c.latest.source
  panel.append(h('p.small.muted.d-only', `Latest: ${source.definition ? `${source.definition.repository}@${source.definition.revision.slice(0, 10)}` : source.root?.repository ?? ''}`))
  if (c.kind === 'deleted' || c.kind === 'renamed') {
    panel.append(h('div.save-row',
      c.kind === 'renamed' && c.renamedTo ? h('button.primary', { type: 'button', disabled: a.busy, onclick: () => a.resolve({ retarget: c.renamedTo }) }, `Move this draft to ${c.renamedTo}`) : null,
      h('button', { type: 'button', disabled: a.busy, onclick: () => a.resolve({ recreate: true }) }, c.kind === 'renamed' ? 'Keep it as a new file under its own name' : 'Recreate the file from this draft'),
      h('button', { type: 'button', disabled: a.busy, onclick: a.discard }, 'Discard this draft')))
    return panel
  }
  const segments: MergeSegment[] = c.segments ?? []
  const choices = new Map<number, 'mine' | 'latest'>()
  const result = h('textarea.yaml.conflict-result', { rows: 12, spellcheck: false, 'aria-label': 'The resolved definition' }) as HTMLTextAreaElement
  const compose = () => segments.map(s => (typeof s === 'string' ? s : s[choices.get(s.n) ?? 'mine'])).join('')
  const sync = () => { result.value = compose() }
  for (const s of segments) {
    if (typeof s === 'string') continue
    choices.set(s.n, 'mine')
    const side = (key: 'mine' | 'latest', label: string) => h(`label.conflict-side.${key}`,
      h('span', h('input', { type: 'radio', name: `conflict-${s.n}`, value: key, checked: key === 'mine', onchange: () => { choices.set(s.n, key); sync() } }), ` ${label}`),
      h('pre.small', s[key] || '(nothing here)'))
    panel.append(h('fieldset.conflict-hunk', h('legend', `Change ${s.n}`),
      h('details.d-only', h('summary.small', 'Before either change'), h('pre.small', s.base || '(nothing here)')),
      h('div.conflict-sides', side('mine', 'Keep this draft\'s'), side('latest', 'Keep the latest'))))
  }
  sync()
  panel.append(
    h('details', h('summary', 'Edit the result as text'), result),
    h('div.save-row',
      h('button.primary', { type: 'button', disabled: a.busy, onclick: () => a.resolve({ text: result.value }) }, 'Use this result'),
      h('span.small.muted', 'Saves it in this draft and changes nothing the project runs until you apply.')))
  return panel
}
