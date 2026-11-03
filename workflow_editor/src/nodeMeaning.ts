// What a node states beyond what it does (improve_wfnode p1, docs/contract.md):
// expectations and example status, as cards show them and as a person edits
// them, in a workflow's node and in a catalog template. One place for the words.
import { EXPECTATION_KEYS, EXPECTATION_STRENGTHS, expectationLabel, STRENGTH_MEANING, strengthOf } from '../shared/expectations.ts'
import type { NodeExpectation } from '../shared/model.ts'
import { h } from './dom.ts'

const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

// `Browser · Required`, and in a run what the records say of it.
export function expectationText(x: NodeExpectation, assessed?: string): string {
  return [expectationLabel(x.key), cap(strengthOf(x)), assessed].filter(Boolean).join(' · ')
}
export function expectationTitle(x: NodeExpectation, meaning?: string): string {
  const said = meaning ?? EXPECTATION_KEYS[x.key]?.meaning ?? 'A key of this workflow\'s own: nothing executes it; its note says what is meant.'
  return [`${x.key}: ${said}`, x.note, STRENGTH_MEANING[strengthOf(x) as keyof typeof STRENGTH_MEANING]].filter(Boolean).join('\n')
}
const tone = (x: NodeExpectation, assessed?: string) => (assessed === 'Met' ? 'met' : assessed === 'Unmet' ? 'unmet' : assessed === 'Alternative' ? 'alternative' : assessed === 'Unverified' ? 'unverified' : strengthOf(x) === 'required' ? 'required' : 'preferred')
export function expectationBadge(x: NodeExpectation, assessed?: string, meaning?: string): HTMLElement {
  return h(`span.expect-badge.expect-${tone(x, assessed)}`, { title: expectationTitle(x, meaning) }, expectationText(x, assessed))
}

// The editor of a list of expectations: an entry per key with its strength and
// an optional note. An unknown key is kept and shown; no other attribute exists.
export function expectationEditor(list: NodeExpectation[], readonly: boolean, changed: (list: NodeExpectation[], rebuild: boolean) => void): HTMLElement {
  const known = Object.keys(EXPECTATION_KEYS)
  const rows = list.map((x, i) => h('div.expect-row',
    h('strong.expect-key', { title: EXPECTATION_KEYS[x.key]?.meaning ?? 'Not a documented key: kept and shown, and nothing executes it' }, expectationLabel(x.key), EXPECTATION_KEYS[x.key] ? null : h('span.muted', ' (unknown)')),
    h('select', {
      disabled: readonly, 'aria-label': `Strength of ${x.key}`,
      onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; changed(list.map((o, k) => (k === i ? { ...o, strength: v } : o)), true) },
    }, ...[...new Set([...EXPECTATION_STRENGTHS, strengthOf(x)])].map(s => h('option', { value: s, selected: s === strengthOf(x), title: STRENGTH_MEANING[s as keyof typeof STRENGTH_MEANING] ?? '' }, cap(s)))),
    h('input', {
      value: x.note ?? '', disabled: readonly, placeholder: 'Note (optional)', 'aria-label': `Note on ${x.key}`,
      oninput: (e: Event) => { const v = (e.target as HTMLInputElement).value; const o = list[i]; if (v) o.note = v; else delete o.note; changed(list, false) },
    }),
    h('button.icon-btn', { type: 'button', disabled: readonly, title: `Remove ${x.key}`, 'aria-label': `Remove expectation ${x.key}`, onclick: () => changed(list.filter((_, k) => k !== i), true) }, '×')))
  const free = known.filter(k => !list.some(x => x.key === k))
  const add = h('select', {
    disabled: readonly || !free.length, 'aria-label': 'Add an expectation',
    onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) changed([...list, { key: v, strength: 'preferred' }], true) },
  }, h('option', { value: '' }, free.length ? 'Add an expectation…' : 'All keys are listed'), ...free.map(k => h('option', { value: k, title: EXPECTATION_KEYS[k].meaning }, `${EXPECTATION_KEYS[k].label} — ${EXPECTATION_KEYS[k].about}`)))
  return h('div.expect-editor', ...rows, add)
}
