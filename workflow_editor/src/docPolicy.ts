// The documentation setting as a person edits it (p8/ex2): the policy, and
// under "custom" the three generated documents chosen one by one. Used by
// the workflow settings and the creation form. Choosing custom starts from
// what the previous policy generated; choosing default or manual removes the
// three keys (they would contradict it).
import { DOC_POLICIES, docSteps, type Documentation, type DocStep } from '../shared/model.ts'
import { h } from './dom.ts'

export const STEP_TEXT: Record<DocStep, { label: string; hint: string }> = {
  plan: { label: 'Plan talk first', hint: 'Write plan.md and agree it with the person before any work' },
  reports: { label: 'A report after every step', hint: 'report-<node>.md; the next step waits for it' },
  final: { label: 'Final report', hint: 'report.md at the end; it also marks the run\'s completion' },
}

// One line for chips and summaries.
export function policySummary(d: Documentation): string {
  const s = docSteps(d)
  if (!s) return d.policy && !(DOC_POLICIES as readonly string[]).includes(d.policy) ? `"${d.policy}" is not supported` : d.policy ? 'documents incompletely declared' : 'not declared'
  const parts = [s.plan && 'plan talk', s.reports && 'a report per step', s.final && 'final report'].filter(Boolean) as string[]
  return parts.length ? parts.join(', ').replace(/^./, c => c.toUpperCase()) : 'No generated documents'
}

export function docPolicyEditor(doc: Documentation, opts: { readonly?: boolean; label: string; onChange: (structural: boolean) => void }): HTMLElement {
  const known = (DOC_POLICIES as readonly string[]).includes(doc.policy)
  const boxes = h('fieldset.doc-steps', { hidden: doc.policy !== 'custom' }, h('legend.small', 'Generated documents'))
  const box = (k: DocStep) => {
    const input = h('input', { type: 'checkbox', checked: doc[k] === true, disabled: opts.readonly, 'aria-describedby': `doc-hint-${k}`,
      onchange: (e: Event) => { doc[k] = (e.target as HTMLInputElement).checked; opts.onChange(false) } })
    return h('label.doc-step', input, h('span', h('strong', STEP_TEXT[k].label), h('span.muted.small', { id: `doc-hint-${k}` }, STEP_TEXT[k].hint)))
  }
  boxes.append(box('plan'), box('reports'), box('final'))
  const select = h('select', {
    disabled: opts.readonly, 'aria-label': opts.label,
    onchange: (e: Event) => {
      const next = (e.target as HTMLSelectElement).value
      const before = docSteps(doc) ?? { plan: true, reports: true, final: true }
      doc.policy = next
      if (next === 'custom') { doc.plan = before.plan; doc.reports = before.reports; doc.final = before.final }
      else { delete doc.plan; delete doc.reports; delete doc.final }
      for (const [i, k] of (['plan', 'reports', 'final'] as const).entries()) (boxes.querySelectorAll('input')[i] as HTMLInputElement).checked = doc[k] === true
      boxes.hidden = next !== 'custom'
      opts.onChange(true)
    },
  }, known ? null : h('option', { value: doc.policy, selected: true }, doc.policy ? `${doc.policy} — unsupported` : '— not declared —'),
  h('option', { value: 'default', selected: doc.policy === 'default' }, 'Default — plan talk, a report per step, final report'),
  h('option', { value: 'manual', selected: doc.policy === 'manual' }, 'Manual — no generated documents'),
  h('option', { value: 'custom', selected: doc.policy === 'custom' }, 'Custom — choose each'))
  return h('div.doc-policy', select, boxes)
}
