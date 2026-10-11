// Semantic digests for approvals. A digest covers only the content an approval
// is about; approvals, layout, comments, key order and YAML formatting are
// excluded. Changing this file changes every digest: bump the projection kind.
import { normalizeRepoPath, type ApprovalKind, type Workflow } from './model.ts'

// Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace,
// arrays in the order the projection produces. Only JSON values are allowed.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  throw new Error(`canonicalJson: unsupported ${typeof value}`)
}

// Text normalization: CRLF/CR become LF, trailing whitespace on each line is
// dropped, and leading/trailing blank lines are removed. So `|` versus `|-`,
// or an editor trimming spaces, does not change a digest; words do.
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n')
    .replace(/^\n+/, '').replace(/\n+$/, '')
}

export function intentProjection(w: Workflow) {
  return { kind: 'ag.workflow.v1/intent', intent: normalizeText(w.intent) }
}

// Definition approval covers intent, repository bindings, node types, names,
// descriptions, node repository bindings, delegate targets and edges.
// Workflow id/name, approvals and layout are outside it.
export function definitionProjection(w: Workflow) {
  const repositories: Record<string, unknown> = {}
  for (const [key, b] of Object.entries(w.repositories)) {
    repositories[key] = { path: normalizeRepoPath(b.path) ?? b.path, access: b.access }
  }
  const nodes: Record<string, unknown> = {}
  for (const [id, n] of Object.entries(w.nodes)) {
    nodes[id] = {
      type: n.type,
      name: normalizeText(n.name),
      description: normalizeText(n.description),
      repositories: [...new Set(n.repositories)].sort(),
      workflow: n.workflow ? n.workflow : null,
    }
  }
  const seen = new Set<string>()
  const edges = w.edges
    .map(e => [e.from, e.to] as const)
    .filter(([from, to]) => { const k = canonicalJson([from, to]); if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return { kind: 'ag.workflow.v1/definition', intent: normalizeText(w.intent), repositories, nodes, edges }
}

export function projection(kind: ApprovalKind, w: Workflow) {
  return kind === 'intent' ? intentProjection(w) : definitionProjection(w)
}

// SHA-256 through Web Crypto, available in both Node and the browser
// (localhost counts as a secure context).
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function semanticDigest(kind: ApprovalKind, w: Workflow): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(projection(kind, w)))}`
}

export type ApprovalStatus = 'unapproved' | 'approved' | 'stale'

export interface ApprovalState {
  status: ApprovalStatus
  digest: string // the current content's digest
  record?: { digest: string; approver: string; at: string }
}

export async function approvalStates(w: Workflow): Promise<Record<ApprovalKind, ApprovalState>> {
  const out = {} as Record<ApprovalKind, ApprovalState>
  for (const kind of ['intent', 'definition'] as const) {
    const digest = await semanticDigest(kind, w)
    const record = w.approvals[kind]
    out[kind] = {
      digest,
      record,
      status: !record || !record.digest ? 'unapproved' : record.digest === digest ? 'approved' : 'stale',
    }
  }
  return out
}
