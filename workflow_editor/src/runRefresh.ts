// One refresh lifecycle for a mounted run view (p7/ex2). Every reason to
// re-read — the first load, SSE changes, reconnection, the host-facts cadence,
// the person's own operations — is a request to one coordinator:
//
//  - a full request (the run and this host's facts) subsumes a host-only one;
//  - one batch runs at a time; requests made meanwhile are merged into the
//    next batch, never lost and never run beside it;
//  - a batch's resources are read concurrently and published together, each
//    with its own success or error, so one failed read never hides the rest;
//  - request() resolves once a batch that began after it has been applied,
//    so a mutation that awaits it sees the state it caused;
//  - after dispose() nothing is applied: requests in flight are aborted where
//    fetch supports it, and every completion is ignored regardless.
export type RefreshKind = 'full' | 'host'
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string }

export const outcome = <T>(p: Promise<T>): Promise<Outcome<T>> =>
  p.then(value => ({ ok: true as const, value }), (e: unknown) => ({ ok: false as const, error: (e as Error).message }))

export class RefreshCoordinator<B> {
  private pending: RefreshKind | null = null
  private waiters: (() => void)[] = []
  private running = false
  private disposed = false
  private abort: AbortController | null = null
  private readonly read: (kind: RefreshKind, signal: AbortSignal) => Promise<B>
  private readonly apply: (batch: B, kind: RefreshKind) => void

  constructor(read: (kind: RefreshKind, signal: AbortSignal) => Promise<B>, apply: (batch: B, kind: RefreshKind) => void) {
    this.read = read
    this.apply = apply
  }

  // Whether a batch runs or waits (the host cadence skips its tick then).
  get busy() { return this.running || this.pending !== null }

  request(kind: RefreshKind): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.pending = this.pending === 'full' || kind === 'full' ? 'full' : 'host'
    const done = new Promise<void>(resolve => this.waiters.push(resolve))
    if (!this.running) void this.drain()
    return done
  }

  dispose() {
    this.disposed = true
    this.pending = null
    this.abort?.abort()
    this.release(this.waiters.splice(0))
  }

  private release(waiters: (() => void)[]) { for (const w of waiters) w() }

  private async drain() {
    this.running = true
    try {
      while (this.pending && !this.disposed) {
        const kind = this.pending
        const waiters = this.waiters.splice(0)
        this.pending = null
        const abort = this.abort = new AbortController()
        try {
          const batch = await this.read(kind, abort.signal)
          if (!this.disposed) this.apply(batch, kind)
        } catch (e) {
          if (!this.disposed) console.error('run view refresh failed', e)
        } finally {
          this.abort = null
          this.release(waiters)
        }
      }
    } finally {
      this.running = false
    }
  }
}
