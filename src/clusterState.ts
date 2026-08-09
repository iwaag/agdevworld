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

// These readers exist so the panels can draw; they are not gatekeepers. An
// envelope with an unfamiliar schema, a missing field or a target the code has
// never seen yields whatever can be drawn, not an exception. The assistant
// reads the same files itself and needs no permission from here.
function targetsOf(value: unknown): DriftTarget[] {
  const data = isObject(value) ? value.data : undefined
  const targets = isObject(data) && Array.isArray(data.targets) ? data.targets : []
  return targets.filter(isObject).map((entry) => ({
    target: isObject(entry.target) ? (entry.target as unknown as DriftTargetRef) : { kind: 'unknown' },
    status: (['converged', 'converging', 'drifting'].includes(String(entry.status))
      ? entry.status
      : 'unknown') as ClusterStatus,
    diffs: Array.isArray(entry.diffs) ? entry.diffs.filter(isObject).map((diff) => diff as unknown as DriftDiff) : [],
  }))
}

export function filterExistingTargets(targets: DriftTarget[], kind: string): TargetPanelModel[] {
  return targets
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

export async function loadExistingNodes(): Promise<TargetPanelModel[]> {
  return filterExistingTargets(
    targetsOf(await loadSnapshotJson('/cluster/state.json', '/state.sample.json')),
    'node',
  )
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

export async function loadWorkspaceRows(): Promise<WorkspaceRow[]> {
  const value = await loadSnapshotJson('/cluster/workspaces.json', '/workspaces.sample.json')
  const data = isObject(value) ? value.data : undefined
  const rows = isObject(data) && Array.isArray(data.rows) ? data.rows : []
  return rows.filter(isObject).map((row) => ({
    ...row,
    name: String(row.name ?? row.slug ?? 'unnamed'),
    gap_codes: Array.isArray(row.gap_codes) ? row.gap_codes.map(String) : [],
  })) as unknown as WorkspaceRow[]
}

// --- Actual devices (nctl.actual.v2, --detail adds facts_raw) ---

export interface ActualDeviceModel {
  id: string
  name: string
  serial?: string | null
  platform?: string | null
  facts: Record<string, unknown>
  // Full nodeutils facts dict; present only in --detail snapshots. The popup
  // shows a few lines of it; the whole file is at /cluster/actual.json.
  facts_raw?: Record<string, unknown> | null
}

export async function loadActualDevices(): Promise<ActualDeviceModel[]> {
  const value = await loadSnapshotJson('/cluster/actual.json', '/actual.sample.json')
  const data = isObject(value) ? value.data : undefined
  const devices = isObject(data) && Array.isArray(data.devices) ? data.devices : []
  return devices
    .filter(isObject)
    .map((device) => ({ ...device, name: String(device.name ?? '') })) as unknown as ActualDeviceModel[]
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
