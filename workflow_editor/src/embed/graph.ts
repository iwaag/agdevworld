// The embeddable read-only graph (argue p4 ex3): the editor's own Canvas,
// served as /wfe/embed/graph.js for another page of the agdev origin
// (aghangout's discussion rooms). It mounts in a shadow root with the
// editor's stylesheet, so nothing is copied into the host page and no
// editor rule leaks out of it. It draws what it is given — a parsed
// workflow, its compiled graph, node states and change marks — and reports
// a selection; it reads nothing, writes nothing and has no navigation.
import { Canvas, type CanvasContext, type Selection } from '../canvas.ts'
import type { RepositoryStatus } from '../../shared/api.ts'
import type { EffectiveGraph } from '../../shared/compile.ts'
import type { Workflow } from '../../shared/model.ts'
import css from '../styles.css?inline'

export const EMBED_VERSION = 1

export interface GraphOptions {
  workflow: Workflow
  effective?: Pick<EffectiveGraph, 'nodes' | 'edges'> | null
  // Each node's state and the words for it (the host's language).
  states?: Record<string, { state: string; label: string; title?: string }>
  marks?: CanvasContext['marks']
  edgeMarks?: CanvasContext['edgeMarks']
  focus?: string[] // what a first view that cannot show everything centres on
  selected?: string | null
  simple?: boolean
  onSelect?: (node: string | null) => void
}
export interface Graph { update(o: GraphOptions): void; select(node: string | null): void; reveal(node: string): void; fit(): void; dispose(): void }

// Inside the shadow root the page's :root is the host; the canvas fills it.
const SHADOW_CSS = `${css.replace(/:root\b/g, ':host')}
:host { display: block; position: relative; contain: content; }
.wfe-embed { position: absolute; inset: 0; display: flex; }
.wfe-embed .canvas { flex: 1; min-height: 0; height: 100%; border-radius: 0; }
.wfe-embed .frame-note { display: none; } /* the editor's hint; the host page says what is shown, and Fit stays */
`

export function mountGraph(host: HTMLElement, first: GraphOptions): Graph {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  shadow.replaceChildren()
  const style = document.createElement('style')
  style.textContent = SHADOW_CSS
  const box = document.createElement('div')
  box.className = 'wfe-embed'
  shadow.append(style, box)
  let o = first
  let selection: Selection = o.selected ? { kind: 'node', id: o.selected } : null
  const canvas = new Canvas({
    select: sel => {
      // A step or an edge is not a node of the definition: nothing to select.
      selection = sel?.kind === 'node' ? sel : null
      draw()
      o.onSelect?.(selection?.kind === 'node' ? selection.id : null)
    },
    move() { /* read-only */ },
    connect() { /* read-only */ },
  })
  box.append(canvas.el)
  canvas.setMode('compact')
  const draw = () => {
    canvas.setSimple(!!o.simple)
    // The bindings are the definition's own: shown as declared, not looked
    // up in a checkout this page does not have.
    const repositories = Object.values(o.workflow.repositories).map(b => ({ path: b.path === '.' ? '.' : b.path.replace(/^\.\//, ''), initialized: true, name: b.path, category: 'other', dirty: 0 }) as unknown as RepositoryStatus)
    canvas.render(o.workflow, { repositories, workflows: [], errorNodes: new Set(), readonly: true, run: o.states, effective: o.effective ?? null, focus: o.focus, marks: o.marks, edgeMarks: o.edgeMarks }, selection)
  }
  draw()
  return {
    update(next) { o = next; selection = next.selected ? { kind: 'node', id: next.selected } : selection?.kind === 'node' && selection.id in next.workflow.nodes ? selection : null; draw() },
    select(node) { selection = node ? { kind: 'node', id: node } : null; draw(); if (node) canvas.reveal(node) },
    reveal(node) { canvas.reveal(node) },
    fit() { canvas.fit() },
    dispose() { canvas.dispose(); shadow.replaceChildren() },
  }
}
