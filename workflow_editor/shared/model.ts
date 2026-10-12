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
export const DOC_POLICIES = ['default', 'manual'] as const
export type DocPolicy = typeof DOC_POLICIES[number]
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
export const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/
// How a node looks (p7), independent of what it does: an icon and a color
// token of the editor's palette. Display only — never part of a digest, the
// compiled graph or an execution rule (docs/contract.md, "Appearance").
export const APPEARANCE_ICONS = ['study', 'do', 'delegate', 'talk', 'present', 'cleanup', 'test', 'doc', 'build', 'review', 'flag'] as const
export const APPEARANCE_COLORS = ['blue', 'amber', 'violet', 'teal', 'green', 'rose', 'slate', 'orange'] as const
export interface Appearance { icon: string; color: string } // '' = the type's default
// Palette presets: ordinary nodes with an appearance and a starting name and
// description, all editable. The preset is not stored; the node is.
export const NODE_PRESETS = {
  present: { type: 'do', name: 'Present', appearance: { icon: 'present', color: 'teal' },
    description: 'Prepare the result for the person: freeze it as a presentation with an explanation of what changed, how to use it and what to check; start its server and confirm the review link opens.' },
  cleanup: { type: 'do', name: 'Clean up', appearance: { icon: 'cleanup', color: 'slate' },
    description: 'Stop what this run started for the review (presentation servers) and verify that it stopped; record the outcome.' },
} as const satisfies Record<string, { type: NodeType; name: string; description: string; appearance: Appearance }>
export type ApprovalKind = typeof APPROVAL_KINDS[number]

// Stable identifiers: workflow IDs, node IDs and repository binding keys.
export const ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/

// `type` and `access` stay plain strings so that a hand-edited file with an
// unknown value is still representable; validation reports it.
export interface RepositoryBinding { path: string; access: string }
export interface WorkflowNode {
  type: string
  name: string
  description: string
  repositories: string[]
  workflow?: string
  confirms?: string // 'result' on the result-confirmation talk (p6)
  appearance?: Appearance // display only (p7)
}
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
  // Plain text so that an unsupported or missing value is representable and
  // reported by validation ('' = the file declares none).
  documentation: { policy: string }
  execution: { agent: string; profile: string; guides: string[] }
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
}

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
    execution: { agent: '', profile: '', guides: [] }, intake: { zulip: '' }, approvals: {}, layout: { nodes: {} },
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
    w.repositories[key] = { path: text(value, 'path', path, issues), access: text(value, 'access', path, issues) }
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
    if (value.confirms !== undefined && value.confirms !== null) node.confirms = text(value, 'confirms', path, issues)
    if (value.appearance !== undefined && value.appearance !== null) {
      const a = map(value, 'appearance', path, issues)
      node.appearance = { icon: text(a, 'icon', `${path}.appearance`, issues), color: text(a, 'color', `${path}.appearance`, issues) }
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
  const execution = map(raw, 'execution', '$', issues)
  w.execution = { agent: text(execution, 'agent', '$.execution', issues), profile: text(execution, 'profile', '$.execution', issues), guides: stringList(execution, 'guides', '$.execution', issues) }
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
  return { project: p, issues }
}

// Repository paths are project-relative POSIX paths. "." is the project root.
export function normalizeRepoPath(path: string): string | null {
  const trimmed = path.trim()
  if (trimmed === '' ) return null
  if (trimmed === '.' || trimmed === './') return '.'
  if (trimmed.startsWith('/') || trimmed.includes('\\') || /^[A-Za-z]:/.test(trimmed)) return null
  const parts = trimmed.split('/').filter(p => p !== '' && p !== '.')
  if (parts.some(p => p === '..')) return null
  return parts.length ? parts.join('/') : '.'
}
