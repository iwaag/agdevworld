// autolab feed (agautolab/agent/gateway.py, envelope kind `autolab.monitor.v1`)
// reached through the assistant passthrough at /api/autolab/.
//
// Same discipline as clusterState.ts: read what the panels need to draw, and
// throw only when there is nothing to draw.
//
// The passthrough refuses `/evidence/` paths: raw evidence stays on the node
// that produced it, and the iteration summary crosses instead.

export interface AutolabNode {
  name: string
  reachable: boolean
  status?: number
  detail?: string
}

export interface AutolabGateSummary {
  total?: number
  passed?: boolean
  failing?: string[]
}

export interface AutolabJobRow {
  name: string
  status?: string | null
  terminal?: boolean
  phase?: string | null
  awaiting_approval?: boolean
  iteration?: number | null
  max_iterations?: number
  adapter?: string
  consecutive_no_progress?: number | null
  last_gate_summary?: AutolabGateSummary | null
  iterations_on_disk?: number
  last_evidence?: string | null
  cost_usd?: number | null
  has_notes?: boolean
  not_started?: boolean
  error?: string
  state_error?: string | null
}

export type SummaryState = 'absent' | 'pending' | 'done' | 'error'

export interface AutolabGate {
  command?: string
  exit_code?: number | null
  timed_out?: boolean
}

export interface AutolabIteration {
  iter: string
  files?: string[]
  cost_usd?: number | null
  mtime?: number
  exit_code?: number | null
  timed_out?: boolean
  num_turns?: number | null
  duration_ms?: number | null
  is_error?: boolean
  gates?: AutolabGate[]
  summary?: SummaryState
}

export interface AutolabJobDetail extends AutolabJobRow {
  evidence: AutolabIteration[]
}

export interface AutolabStatus {
  cost?: { sessions_usd?: number; current_run_sessions_usd?: number | null }
  mission_headline?: string | null
  driver?: { running?: boolean; exit_code?: number | null; current?: Record<string, unknown> | null }
  notes_status?: string
  devstyle?: Record<string, string> | null
}

export interface AutolabSummary {
  job: string
  iter: string
  status: SummaryState
  summary?: string
  error?: string
  summarizer?: { cost_usd?: number | null; num_turns?: number | null; duration_ms?: number | null }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

// A node that is down, unconfigured, or running an older gateway build is a
// normal outcome here, not a bug. Carry the node's own words into the error
// so the view can show what actually happened instead of a generic failure.
async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store', ...init })
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (!response.ok) {
    const detail = isObject(parsed)
      ? String(parsed.detail ?? parsed.error ?? '')
      : text.slice(0, 120)
    throw new Error(`HTTP ${response.status}${detail ? ` — ${detail}` : ''}`)
  }
  if (parsed === null) throw new Error('response was not JSON')
  return parsed
}

// Reads the envelope; it does not police it. The `kind` and `type` fields are
// how the gateway labels its answers, not a permission slip.
export function readAutolabEnvelope(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error('the node answered with something that is not an object')
  return value
}

export async function loadAutolabNodes(): Promise<AutolabNode[]> {
  const value = await getJson('/api/autolab/nodes')
  if (!isObject(value) || !Array.isArray(value.nodes)) throw new Error('node list is malformed')
  return value.nodes.filter(isObject).map((node) => ({
    name: String(node.name),
    reachable: node.reachable === true,
    status: typeof node.status === 'number' ? node.status : undefined,
    detail: typeof node.detail === 'string' ? node.detail : undefined,
  })) as AutolabNode[]
}

export async function loadAutolabJobs(node: string): Promise<AutolabJobRow[]> {
  const envelope = readAutolabEnvelope(await getJson(`/api/autolab/${node}/jobs`))
  if (!Array.isArray(envelope.jobs)) throw new Error('the node listed no jobs field')
  return envelope.jobs.filter(isObject).map((job) => ({ ...job, name: String(job.name) })) as AutolabJobRow[]
}

export async function loadAutolabJob(node: string, job: string): Promise<AutolabJobDetail> {
  const envelope = readAutolabEnvelope(await getJson(`/api/autolab/${node}/jobs/${job}`))
  const detail = envelope.job
  if (!isObject(detail)) throw new Error('the node returned no job field')
  const evidence = Array.isArray(detail.evidence) ? detail.evidence.filter(isObject) : []
  return { ...detail, name: String(detail.name), evidence } as unknown as AutolabJobDetail
}

export async function loadAutolabStatus(node: string): Promise<AutolabStatus> {
  return readAutolabEnvelope(await getJson(`/api/autolab/${node}/status`)) as AutolabStatus
}

function toSummary(value: unknown): AutolabSummary {
  const envelope = readAutolabEnvelope(value)
  return {
    job: String(envelope.job),
    iter: String(envelope.iter),
    status: String(envelope.status) as SummaryState,
    summary: typeof envelope.summary === 'string' ? envelope.summary : undefined,
    error: typeof envelope.error === 'string' ? envelope.error : undefined,
    summarizer: isObject(envelope.summarizer)
      ? (envelope.summarizer as AutolabSummary['summarizer'])
      : undefined,
  }
}

export async function requestIterationSummary(
  node: string,
  job: string,
  iter: string,
): Promise<AutolabSummary> {
  return toSummary(await getJson(`/api/autolab/${node}/jobs/${job}/summarize/${iter}`, { method: 'POST' }))
}

export async function loadIterationSummary(
  node: string,
  job: string,
  iter: string,
): Promise<AutolabSummary> {
  return toSummary(await getJson(`/api/autolab/${node}/jobs/${job}/summarize/${iter}`))
}

// --- display and digest helpers ---

export function gateText(gates?: AutolabGateSummary | null): string | undefined {
  if (!gates || typeof gates.total !== 'number') return undefined
  const failing = gates.failing?.length ?? 0
  return `gates ${gates.total - failing}/${gates.total}`
}

export function moneyText(value?: number | null): string | undefined {
  return typeof value === 'number' ? `$${value.toFixed(2)}` : undefined
}

export function iterationText(job: AutolabJobRow): string | undefined {
  if (typeof job.iteration !== 'number') return undefined
  return typeof job.max_iterations === 'number'
    ? `iter ${job.iteration}/${job.max_iterations}`
    : `iter ${job.iteration}`
}

// One line for the panel: what a human wants at a glance, in the order they
// ask for it — how far along, did the gates pass, what has it cost.
export function jobDetailLine(job: AutolabJobRow): string | undefined {
  const parts = [iterationText(job), gateText(job.last_gate_summary), moneyText(job.cost_usd)]
  return parts.filter(Boolean).join(' · ') || undefined
}

export function statusHeadline(node: string, status?: AutolabStatus, error?: string): string {
  if (error) return `${node}: ${error}`
  if (!status) return `${node}: mediator state unknown`
  const driver = status.driver?.running ? 'driver running' : 'driver idle'
  const cost = moneyText(status.cost?.sessions_usd)
  const mission = status.mission_headline?.trim()
  const head = mission ? `“${mission.slice(0, 90)}${mission.length > 90 ? '…' : ''}”` : 'no mission recorded'
  return [`${node}: ${head}`, driver, cost ? `mediator ${cost}` : undefined]
    .filter(Boolean)
    .join(' · ')
}
