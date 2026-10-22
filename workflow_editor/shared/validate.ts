// Structural and reference validation. It checks that a definition is
// well-formed and that its references resolve; it never judges whether the
// graph fulfils the intent. Errors block approval; drafts may still be saved.
import {
  ACCESS_LEVELS, ACTIVITIES, activityType, APPEARANCE_COLORS, APPEARANCE_ICONS, CONFIRMS, DELEGATE_ACCEPTS, DEVDOCS_MODES, DOC_POLICIES, DOC_STEPS, ID_PATTERN, INTAKE_MODES, NODE_TYPES, NODE_PATTERN, LANE_PATTERN, PROFILE_PATTERN, SESSION_POLICIES, PROJECT_SCHEMA, WORKFLOW_SCHEMA, INTEGRATE_MODES, guideKey, guideRef, normalizeRepoPath,
  type Issue, type Project, type Workflow,
} from './model.ts'

// What the project offers to resolve references against. Supplied by the
// service from .gitmodules, Git state and the workflow directory.
export interface RepositoryInfo {
  path: string
  kind: 'root' | 'submodule' | 'directory' // directory: a folder of the root repository (devdocs in directory mode, or a local area)
  initialized: boolean
}
export interface WorkflowRef {
  id: string
  file: string
  // Delegate targets in that file's saved content (delegateTargets): a
  // workflow id of the same project, or `<project>/<workflow>` of another.
  delegates: string[]
  intake?: boolean // accepts requests: the default, false for intake: {zulip: ""} (p10: a delegation is delivered through it; fix2)
}
export interface ValidationContext {
  repositories?: RepositoryInfo[]
  workflows?: WorkflowRef[]
  file?: string // the file this workflow is stored in, excluded from duplicate checks
  // p10: this workflow's project, and the other registered projects'
  // workflows (from the registry), for cross-project delegate targets.
  project?: string
  projects?: Record<string, WorkflowRef[]>
}

const err = (code: string, message: string, extra: Partial<Issue> = {}): Issue => ({ severity: 'error', code, message, ...extra })
const warn = (code: string, message: string, extra: Partial<Issue> = {}): Issue => ({ severity: 'warning', code, message, ...extra })

// A delegate target as a key: the workflow id within the same project, or
// `<project>/<workflow>` across projects (p10). `project` is the defining
// workflow's own project, when known.
export const targetKey = (n: { project?: string; workflow?: string }, project?: string) =>
  n.project && n.project !== project ? `${n.project}/${n.workflow}` : n.workflow!
export function delegateTargets(w: Workflow, project?: string): string[] {
  return [...new Set(Object.values(w.nodes).filter(n => n.type === 'delegate' && n.workflow).map(n => targetKey(n, project)))]
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
  if (w.schema === 'ag.workflow.v1') issues.push(err('schema', `Schema ag.workflow.v1 is not read since p5: set schema to ${WORKFLOW_SCHEMA} and declare documentation: {policy: default | manual | custom}.`, { field: 'schema' }))
  else if (w.schema !== WORKFLOW_SCHEMA) issues.push(err('schema', w.schema ? `Unsupported schema "${w.schema}"; expected ${WORKFLOW_SCHEMA}.` : `Missing schema; expected ${WORKFLOW_SCHEMA}.`, { field: 'schema' }))
  if (!w.documentation.policy) issues.push(err('documentation-policy', `documentation.policy is not declared; expected ${DOC_POLICIES.join(', ')}.`, { field: 'documentation' }))
  else if (!(DOC_POLICIES as readonly string[]).includes(w.documentation.policy)) issues.push(err('documentation-policy', `documentation.policy "${w.documentation.policy}" is not supported; expected ${DOC_POLICIES.join(', ')}.`, { field: 'documentation' }))
  else {
    // The three steps (p8/ex2): custom declares each; default and manual
    // declare none. A contradiction is reported, never reconciled.
    const declared = DOC_STEPS.filter(k => w.documentation[k] !== undefined)
    if (w.documentation.policy === 'custom' && declared.length !== DOC_STEPS.length) {
      const missing = DOC_STEPS.filter(k => w.documentation[k] === undefined)
      issues.push(err('documentation-steps', `documentation.policy custom declares each of plan, reports and final (true or false); ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`, { field: 'documentation' }))
    } else if (w.documentation.policy !== 'custom' && declared.length) {
      issues.push(err('documentation-steps', `documentation.policy ${w.documentation.policy} decides plan, reports and final itself; remove ${declared.join(', ')}, or use policy custom to choose each.`, { field: 'documentation' }))
    }
  }
  if (!w.id) issues.push(err('id-missing', 'Workflow id is missing.', { field: 'id' }))
  else if (!ID_PATTERN.test(w.id)) issues.push(err('id-invalid', `Workflow id "${w.id}" must match ${ID_PATTERN.source}.`, { field: 'id' }))
  if (!w.name.trim()) issues.push(warn('name-missing', 'Workflow name is empty.', { field: 'name' }))
  if (!w.intent.trim()) issues.push(err('intent-missing', 'Intent is empty; it is the truth the rest is reviewed against.', { field: 'intent' }))

  if (ctx.workflows && w.id) {
    const others = ctx.workflows.filter(r => r.id === w.id && r.file !== ctx.file)
    if (others.length) issues.push(err('id-duplicate', `Workflow id "${w.id}" is also used by ${others.map(o => o.file).join(', ')}.`, { field: 'id' }))
  }

  // Execution and intake (p6)
  if (w.execution.agent && !ID_PATTERN.test(w.execution.agent)) issues.push(err('execution-agent', `execution.agent "${w.execution.agent}" must match ${ID_PATTERN.source}.`, { field: 'execution' }))
  if (w.execution.profile && !PROFILE_PATTERN.test(w.execution.profile)) issues.push(err('execution-profile', `execution.profile "${w.execution.profile}" must be a profile name (${PROFILE_PATTERN.source}).`, { field: 'execution' }))
  if (w.execution.node && !NODE_PATTERN.test(w.execution.node)) issues.push(err('execution-node', `execution.node "${w.execution.node}" must be an execution node id (${NODE_PATTERN.source}).`, { field: 'execution' }))
  if (w.execution.lane && !LANE_PATTERN.test(w.execution.lane)) issues.push(err('execution-lane', `execution.lane "${w.execution.lane}" must be a worker lane name (${LANE_PATTERN.source}).`, { field: 'execution' }))
  if (w.execution.session && !(SESSION_POLICIES as readonly string[]).includes(w.execution.session)) issues.push(err('execution-session', `execution.session "${w.execution.session}" is not a session policy; expected ${SESSION_POLICIES.join(' or ')} (or leave it out for fresh).`, { field: 'execution' }))
  w.execution.guides.forEach((g, i) => {
    const { path: p } = guideRef(g)
    if (p === null || p === '.') issues.push(err('execution-guide-path', `execution.guides[${i}] "${g}" must be a project-relative file path without "..", or <project>:<path> for a file of another managed project.`, { field: 'execution' }))
  })
  if (new Set(w.execution.guides.map(guideKey)).size !== w.execution.guides.length) issues.push(warn('execution-guide-duplicate', 'execution.guides lists a guide twice.', { field: 'execution' }))
  if (w.intake.zulip && !(INTAKE_MODES as readonly string[]).includes(w.intake.zulip)) issues.push(err('intake-mode', `intake.zulip "${w.intake.zulip}" is not supported; expected ${INTAKE_MODES.join(' or ')}, or "" to accept none.`, { field: 'intake' }))

  // Repository bindings
  const byPath = new Map((ctx.repositories ?? []).map(r => [r.path, r]))
  for (const [key, b] of Object.entries(w.repositories)) {
    if (!ID_PATTERN.test(key)) issues.push(err('binding-id-invalid', `Repository binding "${key}" must match ${ID_PATTERN.source}.`, { binding: key }))
    if (!(ACCESS_LEVELS as readonly string[]).includes(b.access)) issues.push(err('binding-access', `Binding "${key}" has access "${b.access}"; expected readonly or editable.`, { binding: key }))
    if (b.integrate !== undefined && !(INTEGRATE_MODES as readonly string[]).includes(b.integrate)) issues.push(err('binding-integrate', `Binding "${key}" has integrate "${b.integrate}"; expected ${INTEGRATE_MODES.join(' or ')} (or leave it out).`, { binding: key }))

    const path = normalizeRepoPath(b.path)
    if (path === null) { issues.push(err('binding-path-invalid', `Binding "${key}" path "${b.path}" must be project-relative without "..".`, { binding: key })); continue }
    if (!ctx.repositories || path === '.') continue
    const repo = byPath.get(path)
    if (!repo) issues.push(warn('repository-missing', `Binding "${key}" refers to "${path}", which is neither devdocs, a submodule in .gitmodules, nor a local area declared in project.yaml.`, { binding: key }))
    else if (repo.kind === 'directory' && !repo.initialized) issues.push(warn('area-missing', `Binding "${key}": local area "${path}" is declared in project.yaml but is not a folder of the project root here.`, { binding: key }))
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
      const own = !n.project || n.project === ctx.project
      const peers = own ? ctx.workflows : ctx.projects?.[n.project!]
      if (n.project && !ID_PATTERN.test(n.project)) issues.push(err('delegate-project-unknown', `Delegate node "${id}" names project "${n.project}", which is not a valid project id.`, { node: id }))
      else if (!own && ctx.projects && !ctx.projects[n.project!]) issues.push(err('delegate-project-unknown', `Delegate node "${id}" targets project "${n.project}", which has no workspace registered here.`, { node: id }))
      if (!n.workflow) issues.push(err('delegate-target-missing', `Delegate node "${id}" has no target workflow.`, { node: id }))
      else if (own && n.workflow === w.id) issues.push(err('delegate-self', `Delegate node "${id}" targets its own workflow.`, { node: id }))
      else if (peers && !peers.some(r => r.id === n.workflow)) issues.push(err('delegate-target-unknown', `Delegate node "${id}" targets workflow "${n.workflow}", which does not exist in ${own ? 'this project' : `project ${n.project}`}.`, { node: id }))
      else if (peers && peers.find(r => r.id === n.workflow)?.intake === false) issues.push(warn('delegate-no-intake', `Delegate node "${id}" targets ${n.project ? `${n.project}/` : ''}${n.workflow}, which opts out of requests (intake: {zulip: ""}); a dispatch to it is refused.`, { node: id }))
      if (n.accepts && !(DELEGATE_ACCEPTS as readonly string[]).includes(n.accepts)) issues.push(err('delegate-accepts', `Delegate node "${id}" has accepts "${n.accepts}"; expected ${DELEGATE_ACCEPTS.join(' or ')}.`, { node: id }))
    } else if (n.workflow || n.project || n.accepts) {
      issues.push(warn('workflow-on-non-delegate', `Node "${id}" is "${n.type}" but names a delegate target (${['workflow', 'project', 'accepts'].filter(k => n[k as 'workflow']).join(', ')}); only delegate nodes use it.`, { node: id }))
    }
    // Appearance (p7) is display only: an unknown value is drawn with the
    // type's default and kept in the file.
    if (n.appearance?.icon && !(APPEARANCE_ICONS as readonly string[]).includes(n.appearance.icon)) issues.push(warn('appearance-icon', `Node "${id}" has icon "${n.appearance.icon}", which the editor does not draw (${APPEARANCE_ICONS.join(', ')}); the type's icon is shown.`, { node: id }))
    if (n.appearance?.color && !(APPEARANCE_COLORS as readonly string[]).includes(n.appearance.color)) issues.push(warn('appearance-color', `Node "${id}" has color "${n.appearance.color}", which is not a palette color (${APPEARANCE_COLORS.join(', ')}); the type's color is shown.`, { node: id }))
    // Template provenance (p7/ex1) is a record of origin, not a reference
    // the workflow depends on: only its own shape is checked.
    if (n.template && !ID_PATTERN.test(n.template.id)) issues.push(warn('template-id', `Node "${id}" names template "${n.template.id}", which is not a valid template id; the provenance is kept as written.`, { node: id }))
    if (n.activity !== undefined) {
      if (!(ACTIVITIES as readonly string[]).includes(n.activity)) issues.push(err('activity-kind', `Node "${id}" has activity "${n.activity}"; expected ${ACTIVITIES.join(', ')}.`, { node: id }))
      else if (n.type !== activityType(n.activity)) issues.push(err('activity-type', `Node "${id}" is the discussion activity "${n.activity}", which is a ${activityType(n.activity)} node, not "${n.type}".`, { node: id }))
    }
    if (n.confirms) {
      if (!(CONFIRMS as readonly string[]).includes(n.confirms)) issues.push(err('confirms-kind', `Node "${id}" confirms "${n.confirms}"; expected ${CONFIRMS.join(' or ')}.`, { node: id }))
      else if (n.type !== 'talk') issues.push(err('confirms-type', `Node "${id}" confirms the result but is "${n.type}"; only a talk node asks the person.`, { node: id }))
    }
  }
  const confirming = Object.entries(w.nodes).filter(([, n]) => n.confirms === 'result').map(([id]) => id)
  if (confirming.length > 1) issues.push(err('confirms-duplicate', `Nodes ${confirming.join(', ')} all confirm the result; a run has one result confirmation.`))

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

  // Recursive delegation across workflows (and, with a registry, across
  // projects: p10), with this draft replacing its saved entry.
  if (ctx.workflows && w.id) {
    const here = ctx.project ?? ''
    const q = (project: string, key: string) => (key.includes('/') ? key : `${project}/${key}`)
    const graph = new Map<string, string[]>()
    const add = (project: string, refs: WorkflowRef[], skipFile?: string) => {
      for (const r of refs) if (r.file !== skipFile) graph.set(q(project, r.id), [...(graph.get(q(project, r.id)) ?? []), ...r.delegates.map(d => q(project, d))])
    }
    for (const [p, refs] of Object.entries(ctx.projects ?? {})) if (p !== here) add(p, refs)
    add(here, ctx.workflows, ctx.file)
    graph.set(q(here, w.id), delegateTargets(w, ctx.project).map(d => q(here, d)))
    const reach = findCycle([q(here, w.id)], id => graph.get(id) ?? [])
    if (reach && reach.length > 2) issues.push(err('delegate-recursive', `Delegation is recursive: ${reach.map(k => (k.startsWith(`${here}/`) ? k.slice(here.length + 1) : k)).join(' → ')}.`))
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
  const seen = new Set<string>()
  for (const a of p.areas ?? []) {
    const path = normalizeRepoPath(a.path)
    if (path === null || path === '.' || path === 'devdocs' || path.startsWith('devdocs/') || path.startsWith('.local')) {
      issues.push(err('area-path-invalid', `Local area "${a.path}" must be a project-relative folder without "..", other than the root, devdocs and .local.`, { field: 'areas' }))
      continue
    }
    if (seen.has(path)) issues.push(err('area-duplicate', `Local area "${path}" is declared twice.`, { field: 'areas' }))
    else if ([...seen].some(o => path.startsWith(`${o}/`) || o.startsWith(`${path}/`))) issues.push(err('area-nested', `Local area "${path}" is inside, or contains, another local area.`, { field: 'areas' }))
    seen.add(path)
  }
  ;(p.guides ?? []).forEach((g, i) => {
    const { path } = guideRef(g)
    if (path === null || path === '.') issues.push(err('guide-path', `guides[${i}] "${g}" must be a project-relative file path without "..", or <project>:<path> for a file of another managed project.`, { field: 'guides' }))
  })
  if (new Set((p.guides ?? []).map(guideKey)).size !== (p.guides ?? []).length) issues.push(warn('guide-duplicate', 'guides lists a guide twice.', { field: 'guides' }))
  return issues
}

export const hasErrors = (issues: Issue[]) => issues.some(i => i.severity === 'error')
