// The cost gauge's read of the relay's `/cost` (`gauge_panel`): host files
// only on the relay side, so this may be polled without spending realm quota.

const BASE = (import.meta.env.VITE_AGENTROOM_URL as string | undefined) ?? 'http://localhost:8094'

export type CostKind = 'reported' | 'estimated' | 'subscription' | 'local' | 'unknown'

export interface Tokens { input: number; cached_input: number; cache_write: number; output: number; reasoning: number }

export interface Bucket {
  runs: number
  failed: number
  usd_reported: number
  usd_estimated: number
  tokens_in: number
  tokens_out: number
  kinds: Record<CostKind, number>
}

export interface Total extends Bucket { by_harness: Record<string, Bucket> }

export interface Day extends Total { day: string; start: number }

export interface TableRow extends Bucket {
  instance: string; role: string; harness: string; model: string; cost_kind: CostKind | 'mixed'; last_at: number
}

export interface SessionAgent extends Bucket { instance: string; role: string; harness: string }

export interface SessionCost extends Bucket {
  channel: string | null
  topic: string | null
  opened_at: number | null
  resolution: string | null
  conversations: { channel: string; topic: string; runs: number }[]
  attribution: { fields: number; window: number }
  agents: SessionAgent[]
}

export interface RoutineCost { name: string; sessions: SessionCost[] }

export interface RecentRow {
  instance: string; role: string; request_id: string | null; harness: string | null; model: string | null
  outcome: string; started_at: number | null; ended_at: number; duration_ms: number | null; num_turns: number | null
  tokens: Tokens | null; cost_usd: number | null; cost_kind: CostKind
  channel: string | null; topic: string | null; generation: number | null; attribution: 'fields' | 'window' | 'none'
}

export interface CostBoard {
  schema: 'ag.cost.v1'
  generated_at: number
  roots: { instance: string; ok: boolean; records: number }[]
  missing: string[]
  prices: { path: string | null; ok: boolean; error: string | null; harnesses: Record<string, string>; models: string[] }
  totals: { today: Total; days7: Total; days30: Total; all: Total }
  days: Day[]
  table: TableRow[]
  routines: RoutineCost[]
  unattributed: Bucket
  recent: RecentRow[]
  settings: { days: number; window_slack_seconds: number }
  note: string | null
}

export async function loadCost(): Promise<CostBoard | { error: string }> {
  let response: Response
  try {
    response = await fetch(`${BASE}/cost`, { signal: AbortSignal.timeout(8000) })
  } catch {
    return { error: `the agentroom relay is not answering on ${BASE}` }
  }
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) {
    const detail = (payload as { error?: string } | undefined)?.error
    return { error: detail ?? `agentroom answered ${response.status}` }
  }
  if (!payload || typeof payload !== 'object') return { error: 'agentroom returned an unreadable response' }
  return payload as CostBoard
}

// Categorical slots in fixed order (dataviz palette, dark steps, validated
// against this app's #101c2b surface). A harness keeps its hue whatever the
// filter shows; anything past the six folds to gray.
export const HARNESS_ORDER = ['claude_code', 'codex', 'agy', 'gemini_cli', 'agcode', 'opencode']
const HUES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300']
export function harnessHue(harness: string): string {
  const index = HARNESS_ORDER.indexOf(harness)
  return index < 0 ? '#7d8fa3' : HUES[index]
}

export function usd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '—'
  return `$${value.toFixed(digits)}`
}

export function compact(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(value)
}

export function at(timestamp: number | null | undefined): string {
  if (!timestamp) return '—'
  return new Date(timestamp * 1000).toLocaleString()
}

export function clock(timestamp: number | null | undefined): string {
  if (!timestamp) return '—'
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// What one bucket is worth in USD that is a fact (reported) plus what is a
// guess (estimated): shown as two numbers, and the guess only when non-zero.
export function money(bucket: Bucket): string {
  // No priced run at all: a dash, unless every run is local (then 0 is the fact).
  const priced = bucket.kinds.reported + bucket.kinds.estimated
  if (priced === 0 && bucket.usd_reported === 0 && bucket.usd_estimated === 0) {
    return bucket.runs > 0 && bucket.kinds.local === bucket.runs ? '$0.00' : '—'
  }
  const parts = [usd(bucket.usd_reported)]
  if (bucket.usd_estimated > 0) parts.push(`+ ~${usd(bucket.usd_estimated)} est.`)
  return parts.join(' ')
}

// The runs a USD figure does not cover, so a small number never reads as cheap.
export function uncovered(bucket: Bucket): string {
  const notes: string[] = []
  if (bucket.kinds.subscription) notes.push(`${bucket.kinds.subscription} on subscription`)
  if (bucket.kinds.unknown) notes.push(`${bucket.kinds.unknown} unknown`)
  if (bucket.kinds.local) notes.push(`${bucket.kinds.local} local`)
  return notes.join(' · ')
}

export function healthLine(board: CostBoard): string {
  const roots = board.roots.filter(root => root.ok)
  const records = roots.reduce((sum, root) => sum + root.records, 0)
  const bits = [`${records} records over ${roots.length} instances`, `observed ${at(board.generated_at)}`]
  if (board.missing.length) bits.push(`not on this host: ${board.missing.join(', ')}`)
  if (!board.prices.ok) bits.push(`price table: ${board.prices.error}`)
  if (board.note) bits.push(board.note)
  return bits.join(' · ')
}
