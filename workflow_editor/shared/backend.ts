// The run header's backend fact (p5/ex1): what actually served the run, as
// this host's execution attempts recorded it — the attempt in progress, or
// else the latest one — never borrowed from another attempt, and kept apart
// from what run.json says was configured. Agent ≠ model: the executor's
// name says nothing about its backend.
export interface AttemptBackend { state: string; began: string; backend: string | null }

export function backendFact(configured: string | null, attempts: AttemptBackend[] | null): string {
  const requested = configured ? ` · configured: ${configured}` : ''
  if (attempts === null) return `backend not observed here${configured ? ` (configured: ${configured})` : ''}`
  if (!attempts.length) return `no attempt yet${requested}`
  const byStart = [...attempts].sort((a, b) => a.began.localeCompare(b.began))
  const active = byStart.filter(a => a.state !== 'ended').at(-1)
  const a = active ?? byStart.at(-1)!
  const which = active ? 'attempt in progress' : 'latest attempt'
  const seen = new Set(byStart.map(x => x.backend ?? 'unknown'))
  const mixed = seen.size > 1 ? ` · ${seen.size} backends across ${byStart.length} attempts` : ''
  return `${a.backend ? `backend ${a.backend}` : 'backend unknown'} (${which}${a.backend ? '' : ' recorded none'})${mixed}${requested}`
}
