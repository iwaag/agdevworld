export type ClusterStatus = 'converged' | 'converging' | 'drifting' | 'unknown'

export interface DriftTargetRef {
  kind: string
  slug?: string | null
  name?: string | null
  id?: string | null
}

export interface DriftDiff {
  code: string
  severity?: string
  message?: string
  desired?: unknown
  actual?: unknown
  sources?: string[]
}

export interface DriftTarget {
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

export interface TargetPanelModel {
  id: string
  name: string
  status: ClusterStatus
  // Full drift entry (incl. diffs with desired/actual) so detail views never
  // need to re-fetch or re-match against the envelope.
  entry: DriftTarget
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

export function filterExistingTargets(envelope: DriftEnvelope, kind: string): TargetPanelModel[] {
  return envelope.data.targets
    .filter(
      (entry) =>
        entry.target.kind === kind &&
        !entry.diffs.some((diff) => NOT_CONFIRMED_CODES.has(diff.code)),
    )
    .map((entry, index) => ({
      id: entry.target.id ?? entry.target.slug ?? `${kind}-${index}`,
      name: entry.target.slug ?? entry.target.name ?? entry.target.id ?? `${kind}-${index + 1}`,
      status: entry.status,
      entry,
    }))
}

async function fetchSnapshot(url: string): Promise<Response> {
  return fetch(url, { cache: 'no-store' })
}

async function loadSnapshotJson(primaryUrl: string, sampleUrl: string): Promise<unknown> {
  let response = await fetchSnapshot(primaryUrl)
  // Vite's development history fallback returns index.html with HTTP 200 for
  // a missing public file. Treat that HTML response like a normal 404 while
  // keeping malformed JSON snapshots visible as errors.
  const contentType = response.headers.get('content-type') ?? ''
  if (response.status === 404 || (response.ok && !contentType.includes('application/json'))) {
    response = await fetchSnapshot(sampleUrl)
  }
  if (!response.ok) throw new Error(`Unable to load cluster snapshot (HTTP ${response.status})`)

  return response.json()
}

export async function loadDriftEnvelope(): Promise<DriftEnvelope> {
  return parseDriftEnvelope(await loadSnapshotJson('/cluster/state.json', '/state.sample.json'))
}

export async function loadExistingNodes(): Promise<TargetPanelModel[]> {
  return filterExistingTargets(await loadDriftEnvelope(), 'node')
}

// --- Workspaces (nctl.workspaces.v1) ---

export interface WorkspaceRow {
  slug: string
  name: string
  node: string
  desired_presence: string
  presence: string
  identity: string
  identity_reason?: string | null
  activity_class?: string | null
  activity_reasons?: Record<string, unknown>
  freshness: string
  checked_at?: string | null
  gap_codes: string[]
}

export interface WorkspacesEnvelope {
  schema: 'nctl.workspaces.v1'
  ok: boolean
  data: {
    generated_at?: string
    rows: WorkspaceRow[]
    summary: Record<string, number>
  }
}

export function parseWorkspacesEnvelope(value: unknown): WorkspacesEnvelope {
  if (!isObject(value) || value.schema !== 'nctl.workspaces.v1' || typeof value.ok !== 'boolean') {
    throw new Error('Workspace snapshot is not an nctl.workspaces.v1 envelope')
  }
  if (!isObject(value.data) || !Array.isArray(value.data.rows) || !isObject(value.data.summary)) {
    throw new Error('Workspace snapshot data is malformed')
  }

  for (const row of value.data.rows) {
    if (
      !isObject(row) ||
      typeof row.slug !== 'string' ||
      typeof row.name !== 'string' ||
      typeof row.node !== 'string' ||
      typeof row.presence !== 'string' ||
      !Array.isArray(row.gap_codes)
    ) {
      throw new Error('Workspace snapshot contains a malformed row')
    }
  }

  return value as unknown as WorkspacesEnvelope
}

export async function loadWorkspacesEnvelope(): Promise<WorkspacesEnvelope> {
  return parseWorkspacesEnvelope(
    await loadSnapshotJson('/cluster/workspaces.json', '/workspaces.sample.json'),
  )
}

export async function loadWorkspaceRows(): Promise<WorkspaceRow[]> {
  return (await loadWorkspacesEnvelope()).data.rows
}

// --- Actual devices (nctl.actual.v2, --detail adds facts_raw) ---

export interface ActualDeviceModel {
  id: string
  name: string
  serial?: string | null
  platform?: string | null
  facts: Record<string, unknown>
  // Full nodeutils facts dict; present only in --detail snapshots. Display
  // selectively — never feed this whole dict to the assistant.
  facts_raw?: Record<string, unknown> | null
}

export interface ActualEnvelope {
  schema: 'nctl.actual.v2'
  ok: boolean
  data: {
    detail_level: string
    devices: ActualDeviceModel[]
    clusters?: unknown[]
    read_errors?: unknown[]
  }
}

export function parseActualEnvelope(value: unknown): ActualEnvelope {
  if (!isObject(value) || value.schema !== 'nctl.actual.v2' || typeof value.ok !== 'boolean') {
    throw new Error('Actual snapshot is not an nctl.actual.v2 envelope')
  }
  if (!isObject(value.data) || !Array.isArray(value.data.devices)) {
    throw new Error('Actual snapshot data is malformed')
  }
  for (const device of value.data.devices) {
    if (!isObject(device) || typeof device.id !== 'string' || typeof device.name !== 'string') {
      throw new Error('Actual snapshot contains a malformed device')
    }
  }
  return value as unknown as ActualEnvelope
}

export async function loadActualDevices(): Promise<ActualDeviceModel[]> {
  return parseActualEnvelope(await loadSnapshotJson('/cluster/actual.json', '/actual.sample.json'))
    .data.devices
}

// Devices carry Nautobot names, which may be fully qualified
// ("agbach.local", "agstudio.home.arpa"); drift targets carry bare slugs.
// Match on the exact name first, then on its first DNS label.
export function matchDeviceForTarget(
  devices: ActualDeviceModel[],
  ref: DriftTargetRef,
): ActualDeviceModel | undefined {
  const candidates = [ref.slug, ref.name].filter((value): value is string => Boolean(value))
  return (
    devices.find((device) => candidates.includes(device.name)) ??
    devices.find((device) => candidates.includes(device.name.split('.')[0]))
  )
}

// The handful of facts_raw fields worth showing: hardware identity, GPU,
// memory, and Docker containers. Everything else stays behind the raw view.
export function deviceHardwareFacts(device: ActualDeviceModel): Array<[string, string]> {
  const raw = device.facts_raw
  const rows: Array<[string, string]> = []
  if (device.platform) rows.push(['platform', device.platform])
  if (device.serial) rows.push(['serial', device.serial])
  if (!isObject(raw)) return rows

  const hardware = isObject(raw.hardware) ? raw.hardware : undefined
  if (hardware?.model) {
    const maker = hardware.manufacturer ? `${String(hardware.manufacturer)} ` : ''
    rows.push(['machine', `${maker}${String(hardware.model)}`])
  }
  // Linux nodes report cpu.model; macs report hardware.chip instead.
  const cpu = isObject(raw.cpu) ? raw.cpu : undefined
  if (cpu?.model) rows.push(['cpu', String(cpu.model)])
  else if (hardware?.chip) rows.push(['cpu', String(hardware.chip)])
  const memory = isObject(raw.memory) ? raw.memory : undefined
  if (typeof memory?.total_gb === 'number') rows.push(['memory', `${memory.total_gb} GB`])
  const gpu = isObject(raw.gpu) ? raw.gpu : undefined
  if (Array.isArray(gpu?.gpus)) {
    for (const entry of gpu.gpus) {
      if (!isObject(entry)) continue
      const size = typeof entry.memory_gb === 'number' ? ` (${entry.memory_gb} GB)` : ''
      rows.push(['gpu', `${String(entry.name)}${size}`])
    }
  }
  const services = isObject(raw.services) ? raw.services : undefined
  const docker = isObject(services?.docker) ? services.docker : undefined
  if (Array.isArray(docker?.containers)) {
    const containers = docker.containers.filter(isObject)
    const running = containers.filter((c) => c.state === 'running').length
    rows.push(['docker', `${containers.length} containers (${running} running)`])
    for (const container of containers.slice(0, 8)) {
      rows.push(['container', `${String(container.name)} — ${String(container.state)}`])
    }
    if (containers.length > 8) rows.push(['container', `… and ${containers.length - 8} more`])
  }
  return rows
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

// Compact digest of one node for the assistant. Same rule as above: never the
// raw JSON — selected fields flattened to short plain-text lines.
export function summarizeNode(target: DriftTarget, device?: ActualDeviceModel): string {
  const name = target.target.slug ?? target.target.name ?? target.target.id ?? 'unnamed'
  const lines = [`Node ${name}: status ${target.status}.`]

  // A few hardware lines from the detail snapshot — selected fields only,
  // never the whole facts_raw dict.
  if (device) {
    const facts = new Map<string, string[]>()
    for (const [key, value] of deviceHardwareFacts(device)) {
      facts.set(key, [...(facts.get(key) ?? []), value])
    }
    const hardware: string[] = []
    if (facts.has('cpu')) hardware.push(`CPU ${facts.get('cpu')![0]}`)
    if (facts.has('memory')) hardware.push(`memory ${facts.get('memory')![0]}`)
    if (facts.has('gpu')) hardware.push(`GPU ${facts.get('gpu')!.join(' + ')}`)
    if (hardware.length > 0) lines.push(`Hardware: ${hardware.join(', ')}.`)
    if (facts.has('docker')) lines.push(`Docker: ${facts.get('docker')![0]}.`)
  }

  const summary = target.diffs.find((diff) => diff.code === 'intent_effect_summary')
  const desired = isObject(summary?.desired) ? summary.desired : undefined
  const node = isObject(desired?.node) ? desired.node : undefined
  if (node) {
    const role = node.role ? `, role ${String(node.role)}` : ''
    lines.push(`Intent: lifecycle ${String(node.lifecycle)}, type ${String(node.node_type)}${role}.`)
  }
  if (Array.isArray(desired?.endpoints)) {
    for (const endpoint of desired.endpoints) {
      if (!isObject(endpoint)) continue
      lines.push(
        `Endpoint ${String(endpoint.name)}: ip ${String(endpoint.ip_address)}, dns ${String(endpoint.dns_name)}.`,
      )
    }
  }
  if (Array.isArray(desired?.placements)) {
    for (const placement of desired.placements) {
      if (!isObject(placement)) continue
      lines.push(
        `Service placement ${String(placement.service_slug ?? placement.instance_name)}: desired state ${String(placement.desired_state)}.`,
      )
    }
  }
  const actual = isObject(summary?.actual) ? summary.actual : undefined
  const production = isObject(actual?.production) ? actual.production : undefined
  if (production) {
    const reasons = Array.isArray(production.reasons) && production.reasons.length > 0
      ? ` (reasons: ${production.reasons.map(String).join(', ')})`
      : ''
    lines.push(`Production application: ${String(production.state)}${reasons}.`)
  }

  for (const diff of target.diffs) {
    if (diff.code === 'intent_effect_summary') continue
    const severity = diff.severity ? ` (${diff.severity})` : ''
    const message = diff.message ? `: ${diff.message}` : ''
    lines.push(`Diff ${diff.code}${severity}${message}.`)
  }
  return lines.join('\n')
}

// Same idea for a workspace row.
export function summarizeWorkspace(row: WorkspaceRow): string {
  const lines = [
    `Workspace ${row.name} on node ${row.node}: presence ${row.presence} (desired ${row.desired_presence}), identity ${row.identity}.`,
  ]
  if (row.identity_reason) lines.push(`Identity reason: ${row.identity_reason}.`)
  if (row.activity_class) {
    const reasons = isObject(row.activity_reasons)
      ? ` (${Object.entries(row.activity_reasons)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(', ')})`
      : ''
    lines.push(`Activity: ${row.activity_class}${reasons}.`)
  }
  lines.push(`Observation freshness: ${row.freshness}${row.checked_at ? `, checked at ${row.checked_at}` : ''}.`)
  if (row.gap_codes.length > 0) lines.push(`Gap codes: ${row.gap_codes.join(', ')}.`)
  return lines.join('\n')
}
