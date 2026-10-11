// Live updates for a view. Change events are merged into one set of needs
// and flushed together, so a later event never replaces an earlier, larger
// refresh (a content reload is never downgraded to a context reload). Every
// hello — the first connection and every reconnection — asks for a full
// re-read, so nothing depends on an event sent while disconnected. Loss of
// the stream is reported to the view, which keeps it visible.
import type { ChangeEvent } from '../shared/api.ts'

export type Need = 'content' | 'context' | 'git' | 'registry' | 'runs'

export interface LiveOptions {
  // Maps an event to what must be re-read; null ignores it.
  classify: (ev: ChangeEvent) => Need[] | null
  // Re-reads. `all` is true after a (re)connection.
  flush: (needs: Set<Need>, all: boolean) => Promise<void> | void
  // Connected or not; called on every change of state.
  state: (connected: boolean) => void
}

export function live(url: string, o: LiveOptions): { close: () => void } {
  let es: EventSource | undefined
  let pending = new Set<Need>()
  let all = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let connected = false

  const setState = (c: boolean) => { if (c !== connected) { connected = c; o.state(c) } }
  const schedule = (ms: number) => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      const needs = pending, full = all
      pending = new Set(); all = false
      void o.flush(needs, full)
    }, ms)
  }

  function open() {
    if (closed) return
    es = new EventSource(url)
    es.addEventListener('hello', () => {
      setState(true)
      all = true
      schedule(0)
    })
    es.addEventListener('change', (e: MessageEvent) => {
      const needs = o.classify(JSON.parse(e.data) as ChangeEvent)
      if (!needs?.length) return
      for (const n of needs) pending.add(n)
      schedule(100)
    })
    es.onerror = () => {
      setState(false)
      // A refused stream (e.g. the workspace is gone) is not retried by the
      // browser; retry it here. A dropped one reconnects by itself.
      if (es?.readyState === EventSource.CLOSED) { clearTimeout(retry); retry = setTimeout(open, 2000) }
    }
  }
  open()
  return { close: () => { closed = true; es?.close(); clearTimeout(timer); clearTimeout(retry) } }
}

// Runs loads one at a time; requests made meanwhile are merged into the next
// run. So responses are applied in request order, never an older over a newer.
export function serial<T>(run: (merged: T) => Promise<void>, merge: (a: T, b: T) => T) {
  let running = false
  let next: T | undefined
  return async function request(arg: T) {
    next = next === undefined ? arg : merge(next, arg)
    if (running) return
    running = true
    try {
      while (next !== undefined) {
        const a = next
        next = undefined
        await run(a)
      }
    } finally {
      running = false
    }
  }
}
