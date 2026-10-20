// What GET api/usage and api/usage/budget answer (retire_old_ui p1,
// server/usage.ts, docs/usage.md).
export const USAGE_SCHEMA = 'ag.usage.v1'
export const PERIODS = ['today', '7d', '30d', 'all'] as const
export type Period = (typeof PERIODS)[number]

export interface Tokens { input: number; cached_input: number; cache_write: number; output: number; reasoning: number }
export type UsageState = 'measured' | 'running' | 'unknown'
// `api-equivalent`: the harness's USD at list price under a subscription;
// `reported`: the harness's USD with no basis named.
export type UsdBasis = 'api-equivalent' | 'reported'

export interface AttemptUsage {
  attempt: string; workspace: string; workflow: string; run: string
  worker: string | null; host: string; lane: string | null
  backend: string | null; harness: string | null; model: string | null
  began: string; ended: string | null
  state: UsageState; reason: string | null
  tokens: Tokens | null
  usd: number | null; usdBasis: UsdBasis | null
  session: string | null
  // How a cumulative figure became this attempt's: `resumed` (the session's
  // previous total subtracted), `continued` (a codex thread seen before; its
  // turns are this process's).
  adjusted: 'resumed' | 'continued' | null
}

export interface UsageTotals {
  attempts: number; measured: number; running: number; unknown: number
  tokens: Tokens
  // USD sums by basis, over the attempts that carry one; `withoutUsd` counts
  // measured attempts that carry tokens only (subscription harnesses).
  usd: Record<UsdBasis, number>; withUsd: number; withoutUsd: number
}
export interface UsageGroup extends UsageTotals { key: string; label: string; href?: string }
export interface UsageDay extends UsageTotals { day: string }

export type SourceState<T> = { state: 'ok'; at: string; data: T } | { state: 'unavailable'; at: string; error: string; last?: { at: string; data: T } }

export interface UsageResponse {
  schema: typeof USAGE_SCHEMA
  at: string
  period: Period
  coverage: { attempts: number; measured: number; running: number; unknown: number; reasons: Record<string, number>; since: string | null; logsOnCoordinator: boolean; note: string }
  periods: Record<Period, UsageTotals>
  days: UsageDay[]
  groups: { project: UsageGroup[]; workflow: UsageGroup[]; model: UsageGroup[]; worker: UsageGroup[] }
  attempts: AttemptUsage[]
  attemptsShown: number
  history: SourceState<unknown>
}

// The relay's `/budget` (agentroom budget.py, `ag.budget.v1`), as passed on:
// one card per harness login on this host. A card that could not read says
// why and may carry its last good reading as `stale`.
export interface BudgetWindow {
  kind: string; label: string
  percent: number | null // used, as the vendor said it; null = the vendor gave none
  resets_at: number | null // epoch seconds
  severity?: string | null; scope?: string | null; window_minutes?: number | null
}
export interface BudgetCard {
  harness: string; ok: boolean; source: string; read_at: number
  plan?: string | null; tier?: string | null; windows: BudgetWindow[]
  note?: string | null; error?: string | null
  extra_usage?: { enabled: boolean } | null
  reset_credits?: { available: number | null; expiring_at: number | null; titles: string[] } | null
  credits?: { has: boolean; unlimited: boolean; balance: string | null } | null
  remaining_credits?: number | null; credits_error?: string | null
  stale?: Omit<BudgetCard, 'ok' | 'error' | 'stale'> | null
}
export interface BudgetBoard { schema: 'ag.budget.v1'; generated_at: number; harnesses: Record<string, BudgetCard>; settings?: { cache_seconds: number | null } }

// The relay's `/cost` over the pre-WFE agents' `ag.agent-run.v1` records,
// reduced (server/usage.ts history): historical, never current activity.
export interface HistoryBucket { runs: number; failed: number; usd_reported: number; usd_estimated: number; tokens_in: number; tokens_out: number; kinds: Record<string, number> }
export interface HistoryRow extends HistoryBucket { instance: string; role: string; harness: string; model: string; cost_kind: string; last_at: number }
export interface HistoryBoard { generated_at: number | null; totals: Record<'today' | 'days7' | 'days30' | 'all', HistoryBucket> | null; table: HistoryRow[]; roots: { instance: string; ok: boolean; records: number }[] }
