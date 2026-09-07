// The gauge's read of the relay's `/budget` (`gauge_panel` ex1): how much of
// each harness's plan window is used. The relay reads it through the CLIs'
// own routes and caches per provider, so the page polls it on the same 20 s
// tick as `/cost` — the relay's cache is what limits vendor calls.

const BASE = (import.meta.env.VITE_AGENTROOM_URL as string | undefined) ?? 'http://localhost:8094'

export interface BudgetWindow {
  kind: string
  label: string
  percent: number | null // used, as the vendor said it; null = the vendor gave none
  resets_at: number | null // epoch seconds
  severity?: string | null
  scope?: string | null
  window_minutes?: number | null
}

export interface BudgetCard {
  harness: string
  ok: boolean
  source: string
  read_at: number
  plan?: string | null
  tier?: string | null
  windows: BudgetWindow[]
  note?: string | null
  error?: string | null
  credential_renewed_at?: number | null
  token_expires_at?: number | null
  extra_usage?: { enabled: boolean } | null
  reset_credits?: { available: number | null; expiring_at: number | null; titles: string[] } | null
  credits?: { has: boolean; unlimited: boolean; balance: string | null } | null
  remaining_credits?: number | null
  upgrade_uri?: string | null
  credits_error?: string | null
  stale?: (Omit<BudgetCard, 'ok' | 'error' | 'stale'>) | null
}

export interface BudgetBoard {
  schema: 'ag.budget.v1'
  generated_at: number
  harnesses: Record<string, BudgetCard>
  settings: { cache_seconds: number | null; read_timeout_seconds: number }
}

export async function loadBudget(): Promise<BudgetBoard | { error: string }> {
  let response: Response
  try {
    response = await fetch(`${BASE}/budget`, { signal: AbortSignal.timeout(20000) })
  } catch {
    return { error: `the agentroom relay is not answering on ${BASE}` }
  }
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) {
    const detail = (payload as { error?: string } | undefined)?.error
    return { error: detail ?? `agentroom answered ${response.status}` }
  }
  if (!payload || typeof payload !== 'object') return { error: 'agentroom returned an unreadable response' }
  return payload as BudgetBoard
}

// "3 h 40 m" from a reset stamp; "now" once it has passed; "—" when unknown.
export function resetsIn(resetsAt: number | null | undefined, now = Date.now() / 1000): string {
  if (!resetsAt) return '—'
  const seconds = resetsAt - now
  if (seconds <= 0) return 'now'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days} d ${hours} h`
  if (hours > 0) return `${hours} h ${minutes} m`
  return `${Math.max(minutes, 1)} m`
}

export function percentText(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '?'
  return `${Math.round(value)}%`
}
