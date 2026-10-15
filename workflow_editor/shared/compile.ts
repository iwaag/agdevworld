// The effective execution graph (p5). A workflow's file keeps what its
// author wrote; the documentation policy decides which generated steps a run
// adds around it. One compiler serves the editor's preview and run creation,
// and a run freezes its result (run.json `definition.effective`), so a later
// edit or a newer compiler never regenerates an existing run differently.
// See docs/contract.md, "Documentation policy".
//
// Default policy, for study → implement → check:
//
//   _plan → study → _report.study → implement → _report.implement
//         → check → _report.check → _final-report
//
// - one plan talk before every authored entry node;
// - one report step after every authored node; A → B becomes
//   A → _report.A → B, so successors wait for the report;
// - one final report after the reports of every authored terminal node;
// - nothing reports on a generated step.
//
// Manual policy: the effective graph is the authored graph.
//
// Custom policy (p8/ex2): each of the three is chosen (plan, reports,
// final); default is all three, manual none. Without reports an authored
// dependency stays A → B and the final report follows the authored terminal
// nodes themselves.
import { DOC_POLICIES, docSteps, ID_PATTERN, type DocPolicy, type DocSteps, type Edge, type Workflow } from './model.ts'
import { findCycle } from './validate.ts'

// Changes whenever the expansion, the identities or the step instructions
// change. A run records the version it was compiled with.
// v2 (p6): authored nodes keep `confirms` (the result-confirmation talk).
// v3 (p8/ex2): the custom policy; graphs carry their normalized
// `documentation`. Default and manual graphs are node for node and edge for
// edge what v2 made, step instructions included.
export const COMPILER_VERSION = 'ag.wfe-compile.v3'

// Generated identities start with "_", which an authored id never does
// (ID_PATTERN), so the two can never collide.
export const PLAN_STEP = '_plan'
export const FINAL_STEP = '_final-report'
const REPORT_PREFIX = '_report.'
export const reportStep = (node: string) => `${REPORT_PREFIX}${node}`
export const isGenerated = (id: string) => id.startsWith('_')
export const reportedNode = (id: string): string | null => (id.startsWith(REPORT_PREFIX) ? id.slice(REPORT_PREFIX.length) : null)

export type StepKind = 'plan' | 'report' | 'final-report'
export const DOCUMENT_OF: Record<StepKind, (node: string | null) => string> = {
  plan: () => 'plan.md',
  report: node => `report-${node}.md`,
  'final-report': () => 'report.md',
}

// What a generated step is for, frozen into the run with the graph.
export interface StepSpec {
  kind: StepKind
  for: string | null // the authored node a report belongs to
  output: string // run-relative document the step writes
  purpose: string // one line, for views and notifications
  instructions: string // what the executing agent is asked to write
}
export interface EffectiveNode { type: string; workflow?: string; project?: string; accepts?: string; confirms?: string; step?: StepSpec }
// `documentation` (v3): the steps the policy generates; a v2 graph has none
// and is read by its policy (docStepsOf).
export interface EffectiveGraph { compiler: string; policy: DocPolicy; documentation?: DocSteps; nodes: Record<string, EffectiveNode>; edges: Edge[] }

// The documentation steps a frozen graph was compiled with.
export function docStepsOf(g: Pick<EffectiveGraph, 'policy' | 'documentation'>): DocSteps {
  if (g.documentation) return g.documentation
  return g.policy === 'manual' ? { plan: false, reports: false, final: false } : { plan: true, reports: true, final: true }
}
// Whether a graph has generated steps at all (views draw and count them apart).
export const hasDocSteps = (g: Pick<EffectiveGraph, 'nodes'> | null | undefined): boolean => !!g && Object.values(g.nodes).some(n => n.step)

export type CompileResult = { ok: true; graph: EffectiveGraph } | { ok: false; code: string; message: string }

const PLAN_INSTRUCTIONS = [
  'Before any authored work, write plan.md in the run folder and agree it with the person.',
  'plan.md states the intended result, the sequence of work, how the result will be verified, the restrictions that apply (bindings, the person\'s instructions) and the open questions.',
  'Then ask the person to agree to it (a question from this step), with enough context to answer and a reference to plan.md. The question records which plan.md it asked about.',
  'If the answer asks for changes, revise plan.md and ask again. Complete this step only after taking up an answer that agrees to the current plan.md; a withdrawn question is not agreement.',
  'This agreement is about the proposed work. It is not a definition approval and not acceptance of the result.',
].join('\n')

const REPORT_INSTRUCTIONS = (node: string) => [
  `Node "${node}" is complete; write report-${node}.md in the run folder before its successors start.`,
  'State what was done or decided, the evidence or checks that support it, the remaining uncertainty, limitations or blockers, and the relevant artifacts and next action.',
  'A talk report can be brief: the question, the answer and the resulting decision. Do not invent checks, and do not imply that an unchanged artifact was modified.',
  'Complete this step with a short outcome (one to three lines: the result, the main verification fact, the next action); it is what coordination messages quote.',
].join('\n')

const FINAL_INSTRUCTIONS = [
  'All authored work and its reports are complete; write report.md in the run folder.',
  'Summarize the request, the delivered result, its verification, the remaining work, and any human decisions already recorded. Link to the per-node reports rather than copying them.',
  'Completing this step completes the execution. It is not acceptance of the result: that stays the person\'s explicit decision.',
  'Complete it with a short outcome (the overall result, limitations, what remains for the person to review).',
].join('\n')
// Without node reports (p8/ex2) there are none to link to: the record's
// outcomes, artifacts, questions and answers are the run's evidence.
const FINAL_INSTRUCTIONS_UNREPORTED = [
  'All authored work is complete; write report.md in the run folder.',
  'Summarize the request, the delivered result, its verification, the remaining work, and any human decisions already recorded. This run has no per-node reports: cite the nodes\' recorded outcomes and artifacts, and the questions and answers, rather than restating the work.',
  'Completing this step completes the execution. It is not acceptance of the result: that stays the person\'s explicit decision.',
  'Complete it with a short outcome (the overall result, limitations, what remains for the person to review).',
].join('\n')

function step(kind: StepKind, node: string | null, reports = true): StepSpec {
  const output = DOCUMENT_OF[kind](node)
  if (kind === 'plan') return { kind, for: null, output, purpose: 'Plan the work and agree it with the person', instructions: PLAN_INSTRUCTIONS }
  if (kind === 'report') return { kind, for: node, output, purpose: `Report on ${node}`, instructions: REPORT_INSTRUCTIONS(node!) }
  return { kind, for: null, output, purpose: 'Final report of the run', instructions: reports ? FINAL_INSTRUCTIONS : FINAL_INSTRUCTIONS_UNREPORTED }
}

const byEdge = (a: Edge, b: Edge) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0)

// An authored node as runs follow it: its type, a delegate's target, and
// whether it is the result confirmation.
export function authoredNode(n: Pick<Workflow['nodes'][string], 'type' | 'workflow' | 'project' | 'accepts' | 'confirms'>): EffectiveNode {
  return { type: n.type, ...(n.workflow ? { workflow: n.workflow } : {}), ...(n.project ? { project: n.project } : {}), ...(n.accepts ? { accepts: n.accepts } : {}), ...(n.confirms ? { confirms: n.confirms } : {}) }
}

// Compiles an authored definition. Refuses what is not an executable graph
// (no nodes, broken or cyclic edges, malformed ids, an unknown policy)
// instead of letting generated steps make it look executable.
export function compile(w: Pick<Workflow, 'nodes' | 'edges' | 'documentation'>): CompileResult {
  const policy = w.documentation.policy as DocPolicy
  if (!(DOC_POLICIES as readonly string[]).includes(policy)) return { ok: false, code: 'documentation-policy', message: policy ? `documentation policy "${policy}" is not supported` : 'no documentation policy is declared' }
  const docs = docSteps(w.documentation)
  if (!docs) return { ok: false, code: 'documentation-steps', message: policy === 'custom' ? 'the custom documentation policy declares each of plan, reports and final' : `the ${policy} documentation policy declares none of plan, reports and final` }
  const ids = Object.keys(w.nodes).sort()
  if (!ids.length) return { ok: false, code: 'nodes-empty', message: 'the workflow has no nodes; generated plan and report steps are not work of their own' }
  const bad = ids.find(id => !ID_PATTERN.test(id))
  if (bad) return { ok: false, code: 'node-id-invalid', message: `node id "${bad}" must match ${ID_PATTERN.source}` }
  const seen = new Set<string>()
  const edges: Edge[] = []
  for (const e of w.edges) {
    if (!(e.from in w.nodes) || !(e.to in w.nodes)) return { ok: false, code: 'edge-broken', message: `edge ${e.from} → ${e.to} names an unknown node` }
    if (e.from === e.to) return { ok: false, code: 'edge-self', message: `edge ${e.from} → ${e.to} connects a node to itself` }
    const k = `${e.from}\0${e.to}`
    if (!seen.has(k)) { seen.add(k); edges.push({ from: e.from, to: e.to }) }
  }
  const out = new Map<string, string[]>()
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to])
  const cycle = findCycle(ids, id => out.get(id) ?? [])
  if (cycle) return { ok: false, code: 'graph-cycle', message: `the graph has a cycle: ${cycle.join(' → ')}` }

  const nodes: Record<string, EffectiveNode> = {}
  if (docs.plan) nodes[PLAN_STEP] = { type: 'talk', step: step('plan', null) }
  for (const id of ids) nodes[id] = authoredNode(w.nodes[id])
  const expanded: Edge[] = []
  const hasIncoming = new Set(edges.map(e => e.to))
  // What a successor (or the final report) waits for: the node's report, or the node itself.
  const after = (id: string) => (docs.reports ? reportStep(id) : id)
  for (const id of ids) {
    if (docs.reports) {
      nodes[reportStep(id)] = { type: 'report', step: step('report', id) }
      expanded.push({ from: id, to: reportStep(id) })
    }
    if (docs.plan && !hasIncoming.has(id)) expanded.push({ from: PLAN_STEP, to: id })
    if (docs.final && !out.has(id)) expanded.push({ from: after(id), to: FINAL_STEP })
  }
  for (const e of edges) expanded.push({ from: after(e.from), to: e.to })
  if (docs.final) nodes[FINAL_STEP] = { type: 'report', step: step('final-report', null, docs.reports) }
  return { ok: true, graph: { compiler: COMPILER_VERSION, policy, documentation: docs, nodes, edges: expanded.sort(byEdge) } }
}

// The authored node a step belongs to, for views: a report belongs to its
// node; the plan and the final report to none.
export function ownerOf(graph: Pick<EffectiveGraph, 'nodes'>, id: string): string | null {
  return graph.nodes[id]?.step?.for ?? null
}

// Counts split into authored work and documentation steps, for views where a
// combined count would mislead ("5 of 7 done" while the work is finished).
export function splitCounts<S extends string>(graph: Pick<EffectiveGraph, 'nodes'>, states: Record<string, { state: S }>): { work: Record<string, number>; docs: Record<string, number> } {
  const work: Record<string, number> = {}, docs: Record<string, number> = {}
  for (const [id, n] of Object.entries(states)) {
    const into = graph.nodes[id]?.step ? docs : work
    into[n.state] = (into[n.state] ?? 0) + 1
  }
  return { work, docs }
}
