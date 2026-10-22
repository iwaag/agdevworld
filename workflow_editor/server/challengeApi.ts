// The challenge routes (challenge p1, docs/challenges.md *HTTP*): reads of
// the published records, writes through the store's journal. A page's words
// are the configured person's (conversations.json `person`) unless a client
// names an automated trial `author`; agents write with `wfe challenge`, which
// names its actor. Nothing here starts a run.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname } from 'node:path'
import { CHALLENGE_STATES, MAX_EVIDENCE, type AddEvidence, type ChallengeState, type ChallengeStore, type Source } from './challenges.ts'
import { loadConversationConfig } from './conversations.ts'
import { RequestError } from './workspace.ts'

// Evidence travels as base64 in the JSON body.
const MAX_BODY = Math.ceil(MAX_EVIDENCE * 1.4) + 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.html': 'text/plain; charset=utf-8',
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new RequestError(415, 'writes require content-type: application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new RequestError(413, 'request body too large')
    chunks.push(chunk as Buffer)
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object')
    return v as Record<string, unknown>
  } catch { throw new RequestError(400, 'invalid JSON body') }
}

// The write fields of a JSON body, checked for type (the store checks meaning).
export function writeFields(input: Record<string, unknown>) {
  const text = (k: string) => { const v = input[k]; if (v === undefined) return undefined; if (typeof v !== 'string') throw new RequestError(400, `${k} is text`); return v }
  const names = (k: string) => { const v = input[k]; if (v === undefined) return undefined; if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) throw new RequestError(400, `${k} is a list of names`); return v as string[] }
  const state = text('state')
  if (state !== undefined && !(CHALLENGE_STATES as readonly string[]).includes(state)) throw new RequestError(400, `state is one of ${CHALLENGE_STATES.join(', ')}`)
  const ev = input.evidence
  let evidence: AddEvidence[] | undefined
  if (ev !== undefined) {
    if (!Array.isArray(ev)) throw new RequestError(400, 'evidence is a list of {name, base64}')
    evidence = ev.map((e: { name?: unknown; base64?: unknown }) => {
      if (typeof e?.name !== 'string' || typeof e.base64 !== 'string') throw new RequestError(400, 'evidence is a list of {name, base64}')
      return { name: e.name, bytes: Buffer.from(e.base64, 'base64') }
    })
  }
  const s = input.source as { conversation?: unknown; message?: unknown } | undefined
  let source: Source | null = null
  if (s !== undefined && s !== null) {
    if (typeof s.conversation !== 'string' || !Number.isInteger(s.message)) throw new RequestError(400, 'source is {conversation, message}')
    source = { kind: 'conversation', conversation: s.conversation, message: s.message as number }
  }
  return { request: text('request'), title: text('title'), body: text('body'), base: text('base'), note: text('note'), projects: names('projects'), drop: names('drop'), state: state as ChallengeState | undefined, evidence, source }
}

export async function challengeRoute(store: ChallengeStore, area: string, req: IncomingMessage, res: ServerResponse, parts: string[], url: URL): Promise<void> {
  const method = req.method ?? 'GET'
  const [, , id, sub, name, action] = parts
  const person = () => { const c = loadConversationConfig(area); return 'disabled' in c ? null : c.person }
  const actor = (input: Record<string, unknown>) => {
    const author = input.author === undefined ? person() : typeof input.author === 'string' && input.author.trim() ? input.author : null
    if (!author) throw new RequestError(input.author === undefined ? 503 : 400, input.author === undefined ? 'no person is configured here (conversations.json "person"): a page cannot write' : 'author is a name')
    return { by: author, via: typeof input.via === 'string' && input.via ? input.via : 'page' }
  }
  const need = (v: string | undefined, k: string) => { if (v === undefined) throw new RequestError(400, `${k} is required`); return v }

  if (!id && method === 'GET') {
    await store.sync()
    const state = url.searchParams.get('state') ?? 'all'
    if (state !== 'all' && !(CHALLENGE_STATES as readonly string[]).includes(state)) throw new RequestError(400, `state is all or one of ${CHALLENGE_STATES.join(', ')}`)
    const num = (k: string) => { const v = url.searchParams.get(k); return v === null ? undefined : Number(v) }
    const list = store.list({ text: url.searchParams.get('text') ?? undefined, project: url.searchParams.get('project') ?? undefined, state: state as ChallengeState | 'all', limit: num('limit'), offset: num('offset') })
    const status = await store.status()
    return send(res, 200, { person: person(), disabled: status.disabled, status, ...list, operations: store.operations({ open: true }) })
  }
  if (!id && method === 'POST') {
    const input = await readBody(req)
    const f = writeFields(input)
    const r = await store.create({ ...actor(input), request: need(f.request, 'request'), title: need(f.title, 'title'), body: f.body ?? '', projects: f.projects, state: f.state, evidence: f.evidence, source: f.source, note: f.note })
    return send(res, 200, r)
  }
  if (id === 'operations') {
    const n = Number(sub)
    if (!Number.isInteger(n)) throw new RequestError(404, 'not found')
    if (!name && method === 'GET') { const op = store.operation(n); if (!op) throw new RequestError(404, `no operation ${n}`); return send(res, 200, { operation: op }) }
    if (name === 'retry' && method === 'POST') return send(res, 200, { operation: await store.retry(n) })
    if (name === 'discard' && method === 'POST') { const input = await readBody(req); return send(res, 200, { operation: store.discard(n, { by: actor(input).by, reason: typeof input.reason === 'string' && input.reason.trim() ? input.reason : 'discarded' }) }) }
    throw new RequestError(404, 'not found')
  }
  if (id && !sub && method === 'GET') {
    const at = url.searchParams.get('at')
    await store.sync()
    const latest = store.current(id)
    const challenge = at ? await store.at(id, at) : latest
    if (!challenge) {
      const ops = store.operations({ challenge: id })
      if (!ops.length) throw new RequestError(404, `no challenge ${id}`)
      return send(res, 200, { challenge: null, latest: null, pinned: false, operations: ops })
    }
    return send(res, 200, { challenge, latest: latest ? { commit: latest.commit, title: latest.title, state: latest.state, updated: latest.updated } : null, pinned: !!at, operations: store.operations({ challenge: id }) })
  }
  if (id && !sub && method === 'POST') {
    const input = await readBody(req)
    const f = writeFields(input)
    const r = await store.edit(id, { ...actor(input), request: need(f.request, 'request'), base: need(f.base, 'base'), title: f.title, body: f.body, projects: f.projects, state: f.state, evidence: f.evidence, drop: f.drop, source: f.source, note: f.note })
    return send(res, 200, r)
  }
  if (id && sub === 'history' && method === 'GET') return send(res, 200, { id, history: await store.log(id) })
  if (id && sub === 'evidence' && name && !action && (method === 'GET' || method === 'HEAD')) {
    const e = await store.evidence(id, name, url.searchParams.get('at') ?? undefined)
    res.writeHead(200, { 'content-type': MIME[extname(name).toLowerCase()] ?? 'application/octet-stream', 'content-length': e.bytes.length, 'content-disposition': `inline; filename="${basename(name).replace(/"/g, '')}"`, 'x-challenge-commit': e.commit, 'cache-control': 'no-store' })
    res.end(method === 'HEAD' ? undefined : e.bytes)
    return
  }
  throw new RequestError(404, 'not found')
}
