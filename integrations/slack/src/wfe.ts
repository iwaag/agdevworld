// WFE's conversation API (agdevworld workflow_editor/docs/conversations.md),
// as a non-browser client: no Origin header, the words' way named by `via`.

export type Kind = 'message' | 'reply' | 'question' | 'progress' | 'result'
export interface WfeMessage {
  id: number; role: 'person' | 'agent'; author: string; text: string; at: string; via?: string | null
  re: number[]; kind: Kind; run: string | null; runUrl: string | null; question: string | null
  dispatch: { state: 'pending' | 'started' | 'failed'; run: string | null; error: string | null } | null
}
export interface WfeView {
  person: string | null
  conversation: { id: string; title: string; state: 'open' | 'closed'; updated: string }
  messages: WfeMessage[]
  runs: { key: string; situation: string; execution: string; waiting: string[] }[]
  asking: number[]
}
export interface WfePosted { sent: boolean; duplicate: boolean; reopened: boolean; message: WfeMessage; run: string | null }

// `permanent`: WFE refused the request itself (4xx); anything else may succeed later.
export class WfeError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null) { super(message); this.status = status }
  get permanent() { return this.status !== null && this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429 }
}

export interface WfeApi {
  view(conv: string, since: number): Promise<WfeView | null>
  post(conv: string, body: { text: string; token: string; via: string; author?: string }): Promise<WfePosted>
}

export class Wfe implements WfeApi {
  readonly base: string
  constructor(base: string) { this.base = base }
  private async call<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<{ status: number; body: T }> {
    let res: Response
    try {
      res = await fetch(new URL(path, this.base), { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) { throw new WfeError(`WFE unreachable: ${(e as Error).message}`, null) }
    const text = await res.text()
    let body: unknown = null
    try { body = JSON.parse(text) } catch { /* not JSON */ }
    if (!res.ok && res.status !== 404) throw new WfeError(`WFE ${res.status}: ${(body as { error?: string } | null)?.error ?? text.slice(0, 200)}`, res.status)
    return { status: res.status, body: body as T }
  }
  async view(conv: string, since: number) {
    const r = await this.call<WfeView>(`api/conversations/${encodeURIComponent(conv)}?since=${since}`)
    return r.status === 404 ? null : r.body
  }
  async post(conv: string, body: { text: string; token: string; via: string; author?: string }) {
    const r = await this.call<WfePosted>(`api/conversations/${encodeURIComponent(conv)}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, 120_000)
    if (r.status === 404) throw new WfeError('WFE 404: the conversation route is missing', 404)
    return r.body
  }
}
