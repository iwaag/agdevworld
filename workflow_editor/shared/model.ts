// Definition models shared by the service and the browser. The YAML files are
// the authority; these are the editable projections of their supported fields.
// See docs/contract.md for the file contract.

export const WORKFLOW_SCHEMA = 'ag.workflow.v2'
export const PROJECT_SCHEMA = 'ag.project.v2'
export const NODE_TYPES = ['study', 'do', 'delegate', 'talk'] as const
export type NodeType = typeof NODE_TYPES[number]
export const ACCESS_LEVELS = ['readonly', 'editable'] as const
export type Access = typeof ACCESS_LEVELS[number]
export const APPROVAL_KINDS = ['intent', 'definition'] as const
// Where devdocs lives (p4): a directory of the project root repository
// (the default for new projects) or a repository of its own, as a submodule.
export const DEVDOCS_MODES = ['directory', 'submodule'] as const
export type DevdocsMode = typeof DEVDOCS_MODES[number]
// Who decides when plans and reports are written (p5): `default` makes the
// run itself plan, report each node and report the whole (shared/compile.ts);
// `manual` leaves documents to explicit instructions.
export const DOC_POLICIES = ['default', 'manual', 'custom'] as const
export type DocPolicy = typeof DOC_POLICIES[number]
// The three generated documentation steps a policy decides (p8/ex2): the
// plan talk, a report after every authored node, the final report. `default`
// is all three, `manual` none, `custom` declares each (contract.md).
export const DOC_STEPS = ['plan', 'reports', 'final'] as const
export type DocStep = typeof DOC_STEPS[number]
export type DocSteps = Record<DocStep, boolean>
export interface Documentation { policy: string; plan?: boolean; reports?: boolean; final?: boolean }
// The normalized setting of a declaration, or null when it is not a valid
// one (an unknown policy, `custom` without all three, or `default`/`manual`
// with any of them). Validation says which; nothing is reconciled.
export function docSteps(d: Documentation): DocSteps | null {
  const declared = DOC_STEPS.filter(k => d[k] !== undefined)
  if (d.policy === 'default') return declared.length ? null : { plan: true, reports: true, final: true }
  if (d.policy === 'manual') return declared.length ? null : { plan: false, reports: false, final: false }
  if (d.policy === 'custom') return declared.length === DOC_STEPS.length ? { plan: d.plan!, reports: d.reports!, final: d.final! } : null
  return null
}
// How runs of a workflow are executed and requested (p6). `execution` names
// the agent identity, the host's execution profile and project-relative
// guides added to the common workflow contract; credentials stay in host
// configuration. `intake.zulip: requests` lets the workflow's Zulip channel
// accept request topics (docs/intake.md). Empty values: the host's defaults,
// no intake.
export const INTAKE_MODES = ['requests'] as const
// A talk node may be the run's designated result confirmation (p6): the
// person's confirmation there maps to the result decision (docs/runs.md).
export const CONFIRMS = ['result'] as const
// Who may accept the result of a delegated child run (p10): the parent's
// person (default), or the parent run's agent when the author grants it.
export const DELEGATE_ACCEPTS = ['person', 'parent'] as const
export const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/
// An execution node (worker) id (project_migration p7): a logical name, not a host name.
export const NODE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
// How a run's attempts use harness conversations (agent_session p1):
// `fresh` starts a new session for every attempt from the run's records and
// files; `run` resumes the run's own retained session in each later attempt.
// '' (not declared) is `fresh`. Records stay authoritative either way.
export const SESSION_POLICIES = ['fresh', 'run'] as const
export type SessionPolicy = typeof SESSION_POLICIES[number]
export const sessionPolicyOf = (ex: { session?: string } | undefined): SessionPolicy => (ex?.session === 'run' ? 'run' : 'fresh')
// How a node looks (p7), independent of what it does: an icon and a color
// token of the editor's palette. Display only — never part of a digest, the
// compiled graph or an execution rule (docs/contract.md, "Appearance").
export const APPEARANCE_ICONS = ['study', 'do', 'delegate', 'talk', 'present', 'cleanup', 'test', 'doc', 'build', 'review', 'flag'] as const
export const APPEARANCE_COLORS = ['blue', 'amber', 'violet', 'teal', 'green', 'rose', 'slate', 'orange'] as const
export interface Appearance { icon: string; color: string } // '' = the type's default
// Node presets moved into the person's node catalog in p7/ex1
// (shared/catalog.ts SEEDS, docs/catalog.md).
export type ApprovalKind = typeof APPROVAL_KINDS[number]

// Stable identifiers: workflow IDs, node IDs and repository binding keys.
export const ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/

// `type` and `access` stay plain strings so that a hand-edited file with an
// unknown value is still representable; validation reports it.
// `integrate` (project_migration p4, docs/integration.md *Guarded bindings*):
// 'if-unchanged' stops integration when the binding's target changed since
// the run built on it; absent or 'merge' is the ordinary integration.
export interface RepositoryBinding { path: string; access: string; integrate?: string }
export const INTEGRATE_MODES = ['merge', 'if-unchanged'] as const
export interface WorkflowNode {
  type: string
  name: string
  description: string
  repositories: string[]
  workflow?: string
  // Delegate targets (p10, docs/delegation.md): `project` is the target
  // project id (absent = this project), `accepts` who may accept the
  // child's result: 'person' (default) or 'parent' (the parent run's agent).
  project?: string
  accepts?: string
  confirms?: string // 'result' on the result-confirmation talk (p6)
  appearance?: Appearance // display only (p7)
  template?: TemplateRef // provenance (p7/ex1): the catalog template it was made from; outside digests and the compiled graph
}
// Where a node came from (p7/ex1, docs/catalog.md): the template's id and
// revision, and its expectation at that revision.
export interface TemplateRef { id: string; revision: number; expectation: string }
export interface Edge { from: string; to: string }
export interface ApprovalRecord { digest: string; approver: string; at: string }
export interface Point { x: number; y: number }

export interface Workflow {
  schema: string
  id: string
  name: string
  intent: string
  repositories: Record<string, RepositoryBinding>
  nodes: Record<string, WorkflowNode>
  edges: Edge[]
  // The policy is plain text so that an unsupported or missing value is
  // representable and reported by validation ('' = the file declares none);
  // the three steps (p8/ex2) are booleans when the file has them.
  documentation: Documentation
  execution: { agent: string; profile: string; guides: string[]; session?: string; node?: string } // session: '' or absent = fresh (SESSION_POLICIES); node (project_migration p7): the execution node its runs are performed on, '' or absent = the project's or the area's default
  intake: { zulip: string }
  approvals: Partial<Record<ApprovalKind, ApprovalRecord>>
  layout: { nodes: Record<string, Point> }
}

export interface Project {
  schema: string
  id: string
  name: string
  // devdocs storage mode as declared; plain text so that a wrong value is
  // representable and reported by validation.
  devdocs: string
  intent: string
  goals: string[]
  // Local areas (project_migration p1): folders of the root repository that
  // the project keeps as knowledge areas of its own (a study or wedo kept
  // locally instead of as a shared repository). A workflow may bind them like
  // a submodule. Read from the file only; the editor never rewrites them.
  areas?: LocalArea[]
  // Project guides (workflow_editor p13, docs/context.md): guide files every
  // workflow of the project inherits once, in the execution.guides notation
  // (a project-relative path, or <project>:<path>). A workflow's own
  // execution.guides add to them.
  guides?: string[]
  // project_migration p7: the execution node this project's runs are
  // performed on unless the workflow or the request names one.
  execution?: { node?: string }
}
export interface LocalArea { path: string; description: string }

export interface Issue {
  severity: 'error' | 'warning'
  code: string
  message: string
  node?: string
  edge?: number
  binding?: string
  field?: string
}

// A structural problem found while reading raw data into a model. Any shape
// issue makes the file read-only in the editor: saving the model back would
// rewrite a construct the model cannot represent.
export interface ShapeIssue { path: string; message: string }

export function emptyWorkflow(id: string, name: string): Workflow {
  return {
    schema: WORKFLOW_SCHEMA, id, name, intent: '',
    repositories: {}, nodes: {}, edges: [], documentation: { policy: 'default' },
    execution: { agent: '', profile: '', guides: [] }, intake: { zulip: 'requests' }, approvals: {}, layout: { nodes: {} },
  }
}

export function cloneWorkflow(w: Workflow): Workflow {
  return structuredClone(w)
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function text(raw: Record<string, unknown>, key: string, path: string, issues: ShapeIssue[]): string {
  const v = raw[key]
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') {
    issues.push({ path: `${path}.${key}`, message: `expected text, found ${typeof v}` })
    return String(v)
  }
  issues.push({ path: `${path}.${key}`, message: 'expected text' })
  return ''
}

function map(raw: Record<string, unknown>, key: string, path: string, issues: ShapeIssue[]): Record<string, unknown> {
  const v = raw[key]
  if (v === undefined || v === null) return {}
  if (isRecord(v)) return v
  issues.push({ path: `${path}.${key}`, message: 'expected a mapping' })
  return {}
}

function list(raw: Record<string, unknown>, key: string, path: string, issues: ShapeIssue[]): unknown[] {
  const v = raw[key]
  if (v === undefined || v === null) return []
  if (Array.isArray(v)) return v
  issues.push({ path: `${path}.${key}`, message: 'expected a sequence' })
  return []
}

function stringList(raw: Record<string, unknown>, key: string, path: string, issues: ShapeIssue[]): string[] {
  return list(raw, key, path, issues).flatMap((v, i) => {
    if (typeof v === 'string') return [v]
    issues.push({ path: `${path}.${key}[${i}]`, message: 'expected text' })
    return []
  })
}

// Reads plain data (parsed YAML) into a workflow. Missing fields default to
// empty so incomplete drafts load; wrongly shaped fields are shape issues.
export function workflowFromData(raw: unknown): { workflow: Workflow; issues: ShapeIssue[] } {
  const issues: ShapeIssue[] = []
  const w = emptyWorkflow('', '')
  w.documentation.policy = '' // absent from the file: validation says so
  if (!isRecord(raw)) {
    issues.push({ path: '$', message: raw === null || raw === undefined ? 'empty document' : 'top level must be a mapping' })
    return { workflow: w, issues }
  }
  w.schema = text(raw, 'schema', '$', issues)
  w.id = text(raw, 'id', '$', issues)
  w.name = text(raw, 'name', '$', issues)
  w.intent = text(raw, 'intent', '$', issues)
  for (const [key, value] of Object.entries(map(raw, 'repositories', '$', issues))) {
    const path = `$.repositories.${key}`
    if (!isRecord(value)) { issues.push({ path, message: 'expected a mapping' }); continue }
    const integrate = text(value, 'integrate', path, issues)
    w.repositories[key] = { path: text(value, 'path', path, issues), access: text(value, 'access', path, issues), ...(integrate ? { integrate } : {}) }
  }
  for (const [key, value] of Object.entries(map(raw, 'nodes', '$', issues))) {
    const path = `$.nodes.${key}`
    if (!isRecord(value)) { issues.push({ path, message: 'expected a mapping' }); continue }
    const node: WorkflowNode = {
      type: text(value, 'type', path, issues),
      name: text(value, 'name', path, issues),
      description: text(value, 'description', path, issues),
      repositories: stringList(value, 'repositories', path, issues),
    }
    if (value.workflow !== undefined && value.workflow !== null) node.workflow = text(value, 'workflow', path, issues)
    if (value.project !== undefined && value.project !== null) node.project = text(value, 'project', path, issues)
    if (value.accepts !== undefined && value.accepts !== null) node.accepts = text(value, 'accepts', path, issues)
    if (value.confirms !== undefined && value.confirms !== null) node.confirms = text(value, 'confirms', path, issues)
    if (value.appearance !== undefined && value.appearance !== null) {
      const a = map(value, 'appearance', path, issues)
      node.appearance = { icon: text(a, 'icon', `${path}.appearance`, issues), color: text(a, 'color', `${path}.appearance`, issues) }
    }
    if (value.template !== undefined && value.template !== null) {
      const t = map(value, 'template', path, issues)
      const rev = t.revision
      if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1) issues.push({ path: `${path}.template.revision`, message: 'expected a positive integer' })
      node.template = { id: text(t, 'id', `${path}.template`, issues), revision: typeof rev === 'number' ? rev : 0, expectation: text(t, 'expectation', `${path}.template`, issues) }
    }
    w.nodes[key] = node
  }
  list(raw, 'edges', '$', issues).forEach((value, i) => {
    const path = `$.edges[${i}]`
    if (!isRecord(value)) { issues.push({ path, message: 'expected a mapping with from and to' }); return }
    w.edges.push({ from: text(value, 'from', path, issues), to: text(value, 'to', path, issues) })
  })
  const documentation = map(raw, 'documentation', '$', issues)
  w.documentation.policy = text(documentation, 'policy', '$.documentation', issues)
  for (const k of DOC_STEPS) {
    const v = documentation[k]
    if (v === undefined || v === null) continue
    if (typeof v === 'boolean') w.documentation[k] = v
    else issues.push({ path: `$.documentation.${k}`, message: 'expected true or false' })
  }
  const execution = map(raw, 'execution', '$', issues)
  w.execution = { agent: text(execution, 'agent', '$.execution', issues), profile: text(execution, 'profile', '$.execution', issues), guides: stringList(execution, 'guides', '$.execution', issues) }
  if (execution.session !== undefined && execution.session !== null) w.execution.session = text(execution, 'session', '$.execution', issues)
  if (execution.node !== undefined && execution.node !== null) w.execution.node = text(execution, 'node', '$.execution', issues)
  w.intake = { zulip: text(map(raw, 'intake', '$', issues), 'zulip', '$.intake', issues) }
  const approvals = map(raw, 'approvals', '$', issues)
  for (const [key, value] of Object.entries(approvals)) {
    const path = `$.approvals.${key}`
    if (!(APPROVAL_KINDS as readonly string[]).includes(key)) continue // unknown kinds are preserved, not modelled
    if (!isRecord(value)) { issues.push({ path, message: 'expected a mapping' }); continue }
    w.approvals[key as ApprovalKind] = {
      digest: text(value, 'digest', path, issues),
      approver: text(value, 'approver', path, issues),
      at: text(value, 'at', path, issues),
    }
  }
  const layout = map(raw, 'layout', '$', issues)
  for (const [key, value] of Object.entries(map(layout, 'nodes', '$.layout', issues))) {
    const path = `$.layout.nodes.${key}`
    if (!isRecord(value) || typeof value.x !== 'number' || typeof value.y !== 'number' ||
      !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
      issues.push({ path, message: 'expected {x: number, y: number}' })
      continue
    }
    w.layout.nodes[key] = { x: value.x, y: value.y }
  }
  return { workflow: w, issues }
}

export function projectFromData(raw: unknown): { project: Project; issues: ShapeIssue[] } {
  const issues: ShapeIssue[] = []
  const p: Project = { schema: '', id: '', name: '', devdocs: '', intent: '', goals: [] }
  if (!isRecord(raw)) {
    issues.push({ path: '$', message: raw === null || raw === undefined ? 'empty document' : 'top level must be a mapping' })
    return { project: p, issues }
  }
  p.schema = text(raw, 'schema', '$', issues)
  p.id = text(raw, 'id', '$', issues)
  p.name = text(raw, 'name', '$', issues)
  p.devdocs = text(raw, 'devdocs', '$', issues)
  p.intent = text(raw, 'intent', '$', issues)
  p.goals = stringList(raw, 'goals', '$', issues)
  if (raw.guides !== undefined && raw.guides !== null) p.guides = stringList(raw, 'guides', '$', issues)
  if (raw.execution !== undefined && raw.execution !== null) {
    const ex = map(raw, 'execution', '$', issues)
    p.execution = ex.node !== undefined && ex.node !== null ? { node: text(ex, 'node', '$.execution', issues) } : {}
  }
  p.areas = Object.entries(map(raw, 'areas', '$', issues)).flatMap(([path, v]) => {
    if (v === null || v === undefined) return [{ path, description: '' }]
    if (typeof v === 'string') return [{ path, description: v }]
    if (isRecord(v)) return [{ path, description: text(v, 'description', `$.areas.${path}`, issues) }]
    issues.push({ path: `$.areas.${path}`, message: 'expected a mapping with description, or text' })
    return []
  })
  return { project: p, issues }
}

// Repository paths are project-relative POSIX paths. "." is the project root.
// An execution guide (p6) is a file of the run's own project, or, written
// `<project>:<path>` (project_migration p4), a file of another managed
// project, read from that project's committed default branch.
export function guideRef(g: string): { project?: string; path: string | null } {
  const m = /^([a-z0-9][a-z0-9_.-]{0,63}):(.+)$/.exec(g.trim())
  if (m) return { project: m[1], path: normalizeRepoPath(m[2]) }
  return { path: normalizeRepoPath(g) }
}
export const guideKey = (g: string) => { const r = guideRef(g); return r.path === null ? g : r.project ? `${r.project}:${r.path}` : r.path }

export function normalizeRepoPath(path: string): string | null {
  const trimmed = path.trim()
  if (trimmed === '' ) return null
  if (trimmed === '.' || trimmed === './') return '.'
  if (trimmed.startsWith('/') || trimmed.includes('\\') || /^[A-Za-z]:/.test(trimmed)) return null
  const parts = trimmed.split('/').filter(p => p !== '' && p !== '.')
  if (parts.some(p => p === '..')) return null
  return parts.length ? parts.join('/') : '.'
}
