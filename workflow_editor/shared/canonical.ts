// Semantic digests for approvals. A digest covers only the content an approval
// is about; approvals, layout, comments, key order and YAML formatting are
// excluded. Changing this file changes every digest: bump the projection kind.
import { guideKey, normalizeRepoPath, type ApprovalKind, type Workflow } from './model.ts'

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
// descriptions, node repository bindings, delegate targets, edges and the
// documentation policy (p5: it changes the executed graph), and, when
// declared, the execution settings, intake and result confirmation (p6).
// Workflow id/name, approvals and layout are outside it.
export function definitionProjection(w: Workflow) {
  const repositories: Record<string, unknown> = {}
  for (const [key, b] of Object.entries(w.repositories)) {
    // The integration guard (project_migration p4) is projected when declared.
    repositories[key] = { path: normalizeRepoPath(b.path) ?? b.path, access: b.access, ...(b.integrate ? { integrate: b.integrate } : {}) }
  }
  const nodes: Record<string, unknown> = {}
  for (const [id, n] of Object.entries(w.nodes)) {
    nodes[id] = {
      type: n.type,
      name: normalizeText(n.name),
      description: normalizeText(n.description),
      repositories: [...new Set(n.repositories)].sort(),
      workflow: n.workflow ? n.workflow : null,
      // p10: a delegate's target project and acceptance scope, when declared
      // (a workflow without them keeps the digest it had).
      ...(n.project ? { project: n.project } : {}),
      ...(n.accepts ? { accepts: n.accepts } : {}),
      ...(n.confirms ? { confirms: n.confirms } : {}),
    }
  }
  const seen = new Set<string>()
  const edges = w.edges
    .map(e => [e.from, e.to] as const)
    .filter(([from, to]) => { const k = canonicalJson([from, to]); if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  // Execution and intake (p6) are part of what is approved when declared;
  // a workflow without them keeps the digest it had.
  // The session policy (agent_session p1) is projected when declared.
  const execution = w.execution && (w.execution.agent || w.execution.profile || w.execution.guides.length || w.execution.session)
    ? { execution: { agent: w.execution.agent, profile: w.execution.profile, guides: w.execution.guides.map(guideKey), ...(w.execution.session ? { session: w.execution.session } : {}) } } : {}
  const intake = w.intake?.zulip ? { intake: { zulip: w.intake.zulip } } : {}
  // The three steps (p8/ex2) are projected when declared, so a default or
  // manual workflow keeps the digest it had.
  const documentation: Record<string, unknown> = { policy: w.documentation.policy }
  for (const k of ['plan', 'reports', 'final'] as const) if (w.documentation[k] !== undefined) documentation[k] = w.documentation[k]
  return { kind: 'ag.workflow.v2/definition', intent: normalizeText(w.intent), documentation, ...execution, ...intake, repositories, nodes, edges }
}

export function projection(kind: ApprovalKind, w: Workflow) {
  return kind === 'intent' ? intentProjection(w) : definitionProjection(w)
}

// SHA-256 through Web Crypto, available in Node and in a browser's secure
// context (https, localhost). A page opened over plain HTTP from another PC
// on the LAN has no crypto.subtle (p10: the receipt's links lead there), so
// the same digest is computed in plain JS then.
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return sha256Plain(bytes)
  const hash = await subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// FIPS 180-4 SHA-256 over bytes, hex digest.
const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
export function sha256Plain(data: Uint8Array): string {
  const bitLen = data.length * 8
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000))
  view.setUint32(padded.length - 4, bitLen >>> 0)
  const H = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const W = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3)
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10)
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }
  return [...H].map(x => x.toString(16).padStart(8, '0')).join('')
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
