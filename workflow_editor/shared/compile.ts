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
import { DOC_POLICIES, docSteps, ID_PATTERN, type DocPolicy, type DocSteps, type Edge, type NodeExpectation, type Specializes, type Workflow } from './model.ts'
import { EXPECTATION_KEYS, strengthOf } from './expectations.ts'
import type { KnowledgeAttachment } from './knowledge.ts'
import { findCycle } from './validate.ts'

// Changes whenever the expansion, the identities or the step instructions
// change. A run records the version it was compiled with.
// v2 (p6): authored nodes keep `confirms` (the result-confirmation talk).
// v3 (p8/ex2): the custom policy; graphs carry their normalized
// `documentation`. Default and manual graphs are node for node and edge for
// edge what v2 made, step instructions included.
// v5 (workflow_editor p17): a `review` node (a person's review, managed by
// WFE) gets no report step and does not hold the final report, which
// follows the work before it instead: the agent finishes its work and the
// review waits for the person alone. Graphs without review nodes are node
// for node and edge for edge what v4 made.
// v7 (improve_workflow p3): authored nodes keep `knowledge`, each reference
// at its revision with its display snapshot, frozen with the run.
// v6 (improve_wfnode p1): authored nodes keep `example`, `expectations` and
// `specializes`; the graph carries its `groups` and the `meanings` of the
// expectation keys it uses, frozen with the run. An example gets no report
// step. Graphs without any of them are node for node and edge for edge what
// v5 made. A changed meaning (shared/expectations.ts) changes this version.
export const COMPILER_VERSION = 'ag.wfe-compile.v7'

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
export interface EffectiveNode { type: string; workflow?: string; project?: string; accepts?: string; confirms?: string; activity?: string; example?: boolean; expectations?: NodeExpectation[]; specializes?: Specializes; knowledge?: KnowledgeAttachment[]; step?: StepSpec }
// A group as a run follows it: what it means, without its display color.
export interface EffectiveGroup { name: string; kind: string; cardinality: string; description: string; members: string[] }
// `documentation` (v3): the steps the policy generates; a v2 graph has none
// and is read by its policy (docStepsOf).
// `groups` and `meanings` (v6): present when the definition has any; `meanings`
// is each documented key's words as this run was given them.
export interface EffectiveGraph { compiler: string; policy: DocPolicy; documentation?: DocSteps; nodes: Record<string, EffectiveNode>; edges: Edge[]; groups?: Record<string, EffectiveGroup>; meanings?: Record<string, { label: string; about: string; meaning: string }> }

// The documentation steps a frozen graph was compiled with.
export function docStepsOf(g: Pick<EffectiveGraph, 'policy' | 'documentation'>): DocSteps {
  if (g.documentation) return g.documentation
  return g.policy === 'manual' ? { plan: false, reports: false, final: false } : { plan: true, reports: true, final: true }
}
// Whether a graph has generated steps at all (views draw and count them apart).
export const hasDocSteps = (g: Pick<EffectiveGraph, 'nodes'> | null | undefined): boolean => !!g && Object.values(g.nodes).some(n => n.step)

export type CompileResult = { ok: true; graph: EffectiveGraph } | { ok: false; code: string; message: string }

const PLAN_INSTRUCTIONS = 'A plan can record the intended result, approach, checks and open questions. Questions and plan agreement are optional records.'
const REPORT_INSTRUCTIONS = (node: string) => `A report for ${node} (report-${node}.md) can record work, evidence, uncertainty and next actions.`
const FINAL_INSTRUCTIONS = 'A final report can summarize the delivered work, actual checks and remaining work. Completion and integration require no acceptance.'
const FINAL_INSTRUCTIONS_UNREPORTED = FINAL_INSTRUCTIONS

function step(kind: StepKind, node: string | null, reports = true): StepSpec {
  const output = DOCUMENT_OF[kind](node)
  if (kind === 'plan') return { kind, for: null, output, purpose: 'Plan the work', instructions: PLAN_INSTRUCTIONS }
  if (kind === 'report') return { kind, for: node, output, purpose: `Report on ${node}`, instructions: REPORT_INSTRUCTIONS(node!) }
  return { kind, for: null, output, purpose: 'Final report of the run', instructions: reports ? FINAL_INSTRUCTIONS : FINAL_INSTRUCTIONS_UNREPORTED }
}

const byEdge = (a: Edge, b: Edge) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0)

// An authored node as runs follow it: its type, a delegate's target, and
// whether it is the result confirmation.
export function authoredNode(n: Pick<Workflow['nodes'][string], 'type' | 'workflow' | 'project' | 'accepts' | 'confirms' | 'activity' | 'example' | 'expectations' | 'specializes' | 'knowledge'>): EffectiveNode {
  return {
    type: n.type, ...(n.workflow ? { workflow: n.workflow } : {}), ...(n.project ? { project: n.project } : {}), ...(n.accepts ? { accepts: n.accepts } : {}), ...(n.confirms ? { confirms: n.confirms } : {}), ...(n.activity ? { activity: n.activity } : {}),
    ...(n.example ? { example: true } : {}),
    ...(n.expectations?.length ? { expectations: n.expectations.map(x => ({ key: x.key, strength: strengthOf(x), ...(x.note ? { note: x.note } : {}) })) } : {}),
    ...(n.specializes ? { specializes: { examples: [...n.specializes.examples], revision: n.specializes.revision } } : {}),
    ...(n.knowledge?.length ? { knowledge: n.knowledge.map(a => ({ ...a, ...(a.findings ? { findings: a.findings.map(f => ({ ...f })) } : {}) })) } : {}),
  }
}

// Compiles an authored definition. Refuses what is not an executable graph
// (no nodes, broken or cyclic edges, malformed ids, an unknown policy)
// instead of letting generated steps make it look executable.
export function compile(w: Pick<Workflow, 'nodes' | 'edges' | 'documentation' | 'groups'>): CompileResult {
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

  for (const [g, x] of Object.entries(w.groups ?? {})) {
    const missing = x.members.find(m => !(m in w.nodes))
    if (missing) return { ok: false, code: 'group-member-unknown', message: `group "${g}" lists "${missing}", which is not a node of this workflow` }
  }
  const nodes: Record<string, EffectiveNode> = {}
  if (docs.plan) nodes[PLAN_STEP] = { type: 'talk', step: step('plan', null) }
  for (const id of ids) nodes[id] = authoredNode(w.nodes[id])
  const expanded: Edge[] = []
  const hasIncoming = new Set(edges.map(e => e.to))
  // What a successor (or the final report) waits for: the node's report, or the node itself.
  const review = (id: string) => w.nodes[id].type === 'review'
  // An example (improve_wfnode p1) is a model, not work: nothing to report on.
  // What follows it waits for it, so the final report waits for its replacement.
  const reported = (id: string) => docs.reports && !review(id) && !w.nodes[id].example
  const after = (id: string) => (reported(id) ? reportStep(id) : id)
  // The final report follows the work: nodes whose successors are all
  // human reviews (or none); review nodes themselves only when the graph
  // has nothing else.
  const workEnd = (id: string) => !review(id) && (out.get(id) ?? []).every(review)
  const ends = ids.some(workEnd) ? ids.filter(workEnd) : ids.filter(id => !out.has(id))
  for (const id of ids) {
    if (reported(id)) {
      nodes[reportStep(id)] = { type: 'report', step: step('report', id) }
      expanded.push({ from: id, to: reportStep(id) })
    }
    if (docs.plan && !hasIncoming.has(id)) expanded.push({ from: PLAN_STEP, to: id })
    if (docs.final && ends.includes(id)) expanded.push({ from: after(id), to: FINAL_STEP })
  }
  for (const e of edges) expanded.push({ from: after(e.from), to: e.to })
  if (docs.final) nodes[FINAL_STEP] = { type: 'report', step: step('final-report', null, docs.reports) }
  const groups = Object.entries(w.groups ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([g, x]) => [g, { name: x.name, kind: x.kind, cardinality: x.cardinality, description: x.description, members: [...x.members] } as EffectiveGroup] as const)
  const keys = [...new Set(ids.flatMap(id => (w.nodes[id].expectations ?? []).map(x => x.key)))].filter(k => k in EXPECTATION_KEYS).sort()
  return {
    ok: true,
    graph: {
      compiler: COMPILER_VERSION, policy, documentation: docs, nodes, edges: expanded.sort(byEdge),
      ...(groups.length ? { groups: Object.fromEntries(groups) } : {}),
      ...(keys.length ? { meanings: Object.fromEntries(keys.map(k => [k, { ...EXPECTATION_KEYS[k] }])) } : {}),
    },
  }
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
    if (graph.nodes[id]?.example) continue // a model for work: never counted as done or pending
    const into = graph.nodes[id]?.step ? docs : work
    into[n.state] = (into[n.state] ?? 0) + 1
  }
  return { work, docs }
}
