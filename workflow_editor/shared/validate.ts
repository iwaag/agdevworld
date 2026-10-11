// Structural and reference validation. It checks that a definition is
// well-formed and that its references resolve; it never judges whether the
// graph fulfils the intent. Errors block approval; drafts may still be saved.
import {
  ACCESS_LEVELS, DEVDOCS_MODES, ID_PATTERN, NODE_TYPES, PROJECT_SCHEMA, WORKFLOW_SCHEMA, normalizeRepoPath,
  type Issue, type Project, type Workflow,
} from './model.ts'

// What the project offers to resolve references against. Supplied by the
// service from .gitmodules, Git state and the workflow directory.
export interface RepositoryInfo {
  path: string
  kind: 'root' | 'submodule' | 'directory' // directory: devdocs kept in the root repository
  initialized: boolean
}
export interface WorkflowRef {
  id: string
  file: string
  delegates: string[] // delegate targets in that file's saved content
}
export interface ValidationContext {
  repositories?: RepositoryInfo[]
  workflows?: WorkflowRef[]
  file?: string // the file this workflow is stored in, excluded from duplicate checks
}

const err = (code: string, message: string, extra: Partial<Issue> = {}): Issue => ({ severity: 'error', code, message, ...extra })
const warn = (code: string, message: string, extra: Partial<Issue> = {}): Issue => ({ severity: 'warning', code, message, ...extra })

export function delegateTargets(w: Workflow): string[] {
  return [...new Set(Object.values(w.nodes).filter(n => n.type === 'delegate' && n.workflow).map(n => n.workflow!))]
}

// Returns one cycle (as a node list) in a directed graph, or null.
export function findCycle(nodes: string[], next: (id: string) => string[]): string[] | null {
  const state = new Map<string, 1 | 2>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    state.set(id, 1); stack.push(id)
    for (const to of next(id)) {
      const s = state.get(to)
      if (s === 1) return [...stack.slice(stack.indexOf(to)), to]
      if (s === undefined) { const c = visit(to); if (c) return c }
    }
    stack.pop(); state.set(id, 2)
    return null
  }
  for (const id of nodes) if (!state.has(id)) { const c = visit(id); if (c) return c }
  return null
}

export function validateWorkflow(w: Workflow, ctx: ValidationContext = {}): Issue[] {
  const issues: Issue[] = []
  if (w.schema !== WORKFLOW_SCHEMA) issues.push(err('schema', w.schema ? `Unsupported schema "${w.schema}"; expected ${WORKFLOW_SCHEMA}.` : `Missing schema; expected ${WORKFLOW_SCHEMA}.`, { field: 'schema' }))
  if (!w.id) issues.push(err('id-missing', 'Workflow id is missing.', { field: 'id' }))
  else if (!ID_PATTERN.test(w.id)) issues.push(err('id-invalid', `Workflow id "${w.id}" must match ${ID_PATTERN.source}.`, { field: 'id' }))
  if (!w.name.trim()) issues.push(warn('name-missing', 'Workflow name is empty.', { field: 'name' }))
  if (!w.intent.trim()) issues.push(err('intent-missing', 'Intent is empty; it is the truth the rest is reviewed against.', { field: 'intent' }))

  if (ctx.workflows && w.id) {
    const others = ctx.workflows.filter(r => r.id === w.id && r.file !== ctx.file)
    if (others.length) issues.push(err('id-duplicate', `Workflow id "${w.id}" is also used by ${others.map(o => o.file).join(', ')}.`, { field: 'id' }))
  }

  // Repository bindings
  const byPath = new Map((ctx.repositories ?? []).map(r => [r.path, r]))
  for (const [key, b] of Object.entries(w.repositories)) {
    if (!ID_PATTERN.test(key)) issues.push(err('binding-id-invalid', `Repository binding "${key}" must match ${ID_PATTERN.source}.`, { binding: key }))
    if (!(ACCESS_LEVELS as readonly string[]).includes(b.access)) issues.push(err('binding-access', `Binding "${key}" has access "${b.access}"; expected readonly or editable.`, { binding: key }))
    const path = normalizeRepoPath(b.path)
    if (path === null) { issues.push(err('binding-path-invalid', `Binding "${key}" path "${b.path}" must be project-relative without "..".`, { binding: key })); continue }
    if (!ctx.repositories || path === '.') continue
    const repo = byPath.get(path)
    if (!repo) issues.push(err('repository-missing', `Binding "${key}" refers to "${path}", which is neither devdocs nor a submodule in .gitmodules.`, { binding: key }))
    else if (!repo.initialized) issues.push(warn('repository-uninitialized', `Binding "${key}": submodule "${path}" is not initialized in this workspace.`, { binding: key }))
  }

  // Nodes
  const nodeIds = Object.keys(w.nodes)
  if (!nodeIds.length) issues.push(warn('nodes-empty', 'The workflow has no nodes.'))
  for (const [id, n] of Object.entries(w.nodes)) {
    if (!ID_PATTERN.test(id)) issues.push(err('node-id-invalid', `Node id "${id}" must match ${ID_PATTERN.source}.`, { node: id }))
    if (!(NODE_TYPES as readonly string[]).includes(n.type)) issues.push(err('node-type', n.type ? `Node "${id}" has unknown type "${n.type}".` : `Node "${id}" has no type.`, { node: id }))
    if (!n.description.trim()) issues.push(warn('node-description-missing', `Node "${id}" has no description.`, { node: id }))
    for (const ref of n.repositories) {
      if (!(ref in w.repositories)) issues.push(err('node-binding-missing', `Node "${id}" refers to repository binding "${ref}", which is not declared.`, { node: id, binding: ref }))
    }
    if (new Set(n.repositories).size !== n.repositories.length) issues.push(warn('node-binding-duplicate', `Node "${id}" lists a repository binding twice.`, { node: id }))
    if (n.type === 'delegate') {
      issues.push(warn('delegate-not-executable', `Delegate node "${id}" is definition and display only: runs of a workflow with a delegate node are refused.`, { node: id }))
      if (!n.workflow) issues.push(err('delegate-target-missing', `Delegate node "${id}" has no target workflow.`, { node: id }))
      else if (n.workflow === w.id) issues.push(err('delegate-self', `Delegate node "${id}" targets its own workflow.`, { node: id }))
      else if (ctx.workflows && !ctx.workflows.some(r => r.id === n.workflow)) issues.push(err('delegate-target-unknown', `Delegate node "${id}" targets workflow "${n.workflow}", which does not exist in this project.`, { node: id }))
    } else if (n.workflow) {
      issues.push(warn('workflow-on-non-delegate', `Node "${id}" is "${n.type}" but names a target workflow; only delegate nodes use it.`, { node: id }))
    }
  }

  // Edges
  const seen = new Set<string>()
  w.edges.forEach((e, i) => {
    if (!(e.from in w.nodes)) issues.push(err('edge-from-missing', `Edge ${i + 1} starts at unknown node "${e.from}".`, { edge: i }))
    if (!(e.to in w.nodes)) issues.push(err('edge-to-missing', `Edge ${i + 1} ends at unknown node "${e.to}".`, { edge: i }))
    if (e.from === e.to && e.from) issues.push(err('edge-self', `Edge ${i + 1} connects "${e.from}" to itself.`, { edge: i }))
    const k = `${e.from}\u0000${e.to}`
    if (seen.has(k)) issues.push(warn('edge-duplicate', `Edge ${i + 1} duplicates ${e.from} → ${e.to}.`, { edge: i }))
    seen.add(k)
  })
  const out = new Map<string, string[]>()
  for (const e of w.edges) if (e.from in w.nodes && e.to in w.nodes && e.from !== e.to) out.set(e.from, [...(out.get(e.from) ?? []), e.to])
  const cycle = findCycle(nodeIds, id => out.get(id) ?? [])
  if (cycle) issues.push(err('graph-cycle', `The graph has a cycle: ${cycle.join(' → ')}. p1 workflows are acyclic.`))

  // Recursive delegation across workflows, with this draft replacing its saved entry.
  if (ctx.workflows && w.id) {
    const graph = new Map<string, string[]>()
    for (const r of ctx.workflows) if (r.file !== ctx.file) graph.set(r.id, [...(graph.get(r.id) ?? []), ...r.delegates])
    graph.set(w.id, delegateTargets(w))
    const reach = findCycle([w.id], id => graph.get(id) ?? [])
    if (reach && reach.length > 2) issues.push(err('delegate-recursive', `Delegation is recursive: ${reach.join(' → ')}.`))
  }

  for (const id of Object.keys(w.layout.nodes)) {
    if (!(id in w.nodes)) issues.push(warn('layout-orphan', `Layout has a position for unknown node "${id}".`, { node: id }))
  }
  return issues
}

export function validateProject(p: Project): Issue[] {
  const issues: Issue[] = []
  if (p.schema !== PROJECT_SCHEMA) issues.push(err('schema', p.schema ? `Unsupported schema "${p.schema}"; expected ${PROJECT_SCHEMA}. Older formats are not read; register the project again under the current contract.` : `Missing schema; expected ${PROJECT_SCHEMA}.`, { field: 'schema' }))
  if (!(DEVDOCS_MODES as readonly string[]).includes(p.devdocs)) issues.push(err('devdocs-mode', p.devdocs ? `devdocs "${p.devdocs}" is not a storage mode; expected directory or submodule.` : 'devdocs (the storage mode: directory or submodule) is not declared.', { field: 'devdocs' }))
  if (!p.id) issues.push(err('id-missing', 'Project id is missing.', { field: 'id' }))
  else if (!ID_PATTERN.test(p.id)) issues.push(err('id-invalid', `Project id must match ${ID_PATTERN.source}.`, { field: 'id' }))
  if (!p.name.trim()) issues.push(warn('name-missing', 'Project name is empty.', { field: 'name' }))
  if (!p.intent.trim()) issues.push(warn('intent-missing', 'Project intent is empty.', { field: 'intent' }))
  return issues
}

export const hasErrors = (issues: Issue[]) => issues.some(i => i.severity === 'error')
