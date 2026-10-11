// Definition models shared by the service and the browser. The YAML files are
// the authority; these are the editable projections of their supported fields.
// See docs/contract.md for the file contract.

export const WORKFLOW_SCHEMA = 'ag.workflow.v1'
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
    repositories: {}, nodes: {}, edges: [], approvals: {}, layout: { nodes: {} },
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
    w.nodes[key] = node
  }
  list(raw, 'edges', '$', issues).forEach((value, i) => {
    const path = `$.edges[${i}]`
    if (!isRecord(value)) { issues.push({ path, message: 'expected a mapping with from and to' }); return }
    w.edges.push({ from: text(value, 'from', path, issues), to: text(value, 'to', path, issues) })
  })
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
