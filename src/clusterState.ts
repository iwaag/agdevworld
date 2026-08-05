export type ClusterStatus = 'converged' | 'converging' | 'drifting' | 'unknown'

interface DriftTargetRef {
  kind: string
  slug?: string | null
  name?: string | null
  id?: string | null
}

interface DriftDiff {
  code: string
  severity?: string
  message?: string
}

interface DriftTarget {
  target: DriftTargetRef
  status: ClusterStatus
  diffs: DriftDiff[]
}

export interface DriftEnvelope {
  schema: 'nctl.drift.v1'
  ok: boolean
  data: {
    targets: DriftTarget[]
    summary: Record<string, number>
  }
}

export interface NodePanelModel {
  id: string
  name: string
  status: ClusterStatus
}

const NOT_CONFIRMED_CODES = new Set([
  'missing_actual_node',
  'realized_device_missing',
  'no_realized_object',
  'waiting_for_manual_initial_access',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isClusterStatus(value: unknown): value is ClusterStatus {
  return ['converged', 'converging', 'drifting', 'unknown'].includes(String(value))
}

export function parseDriftEnvelope(value: unknown): DriftEnvelope {
  if (!isObject(value) || value.schema !== 'nctl.drift.v1' || typeof value.ok !== 'boolean') {
    throw new Error('Cluster snapshot is not an nctl.drift.v1 envelope')
  }
  if (!isObject(value.data) || !Array.isArray(value.data.targets) || !isObject(value.data.summary)) {
    throw new Error('Cluster snapshot data is malformed')
  }

  for (const entry of value.data.targets) {
    if (
      !isObject(entry) ||
      !isObject(entry.target) ||
      typeof entry.target.kind !== 'string' ||
      !isClusterStatus(entry.status) ||
      !Array.isArray(entry.diffs) ||
      !entry.diffs.every((diff) => isObject(diff) && typeof diff.code === 'string')
    ) {
      throw new Error('Cluster snapshot contains a malformed target')
    }
  }

  return value as unknown as DriftEnvelope
}

export function filterExistingNodes(envelope: DriftEnvelope): NodePanelModel[] {
  return envelope.data.targets
    .filter(
      (entry) =>
        entry.target.kind === 'node' &&
        !entry.diffs.some((diff) => NOT_CONFIRMED_CODES.has(diff.code)),
    )
    .map((entry, index) => ({
      id: entry.target.id ?? entry.target.slug ?? `node-${index}`,
      name: entry.target.slug ?? entry.target.name ?? entry.target.id ?? `node-${index + 1}`,
      status: entry.status,
    }))
}

async function fetchSnapshot(url: string): Promise<Response> {
  return fetch(url, { cache: 'no-store' })
}

export async function loadDriftEnvelope(): Promise<DriftEnvelope> {
  let response = await fetchSnapshot('/cluster/state.json')
  // Vite's development history fallback returns index.html with HTTP 200 for
  // a missing public file. Treat that HTML response like a normal 404 while
  // keeping malformed JSON snapshots visible as errors.
  const contentType = response.headers.get('content-type') ?? ''
  if (response.status === 404 || (response.ok && !contentType.includes('application/json'))) {
    response = await fetchSnapshot('/state.sample.json')
  }
  if (!response.ok) throw new Error(`Unable to load cluster snapshot (HTTP ${response.status})`)

  return parseDriftEnvelope(await response.json())
}

export async function loadExistingNodes(): Promise<NodePanelModel[]> {
  return filterExistingNodes(await loadDriftEnvelope())
}

// Compact plain-text summary for the assistant. Deliberately not the raw
// JSON: the snapshot will grow and small local models degrade on large JSON
// blobs. Unlike the panel, this includes ALL targets (even not-yet-confirmed
// nodes) so the assistant can answer "why is X missing?".
export function summarizeClusterContext(envelope: DriftEnvelope): string {
  const counts = Object.entries(envelope.data.summary)
    .map(([status, count]) => `${status}=${count}`)
    .join(', ')

  const lines = envelope.data.targets.map((entry) => {
    const name = entry.target.slug ?? entry.target.name ?? entry.target.id ?? 'unnamed'
    const diffs = entry.diffs
      .map((diff) => {
        const severity = diff.severity ? ` (${diff.severity})` : ''
        const message = diff.message ? `: ${diff.message}` : ''
        return `${diff.code}${severity}${message}`
      })
      .join('; ')
    return `- ${entry.target.kind} ${name}: ${entry.status}${diffs ? ` — ${diffs}` : ''}`
  })

  return [`Status counts: ${counts}`, ...lines].join('\n')
}
