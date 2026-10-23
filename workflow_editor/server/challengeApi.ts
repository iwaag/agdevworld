// The challenge routes (challenge p1, p3; docs/challenges.md *HTTP*): reads
// of the published challenges — summaries, files and trials, current or at a
// commit — and writes through the store's journal. A page's words are the
// configured person's (conversations.json `person`) unless a client names an
// automated trial `author`; agents write with `wfe challenge`, which names
// its actor. Nothing here starts a run.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname } from 'node:path'
import { MAX_WRITE, type AddFile, type ChallengeStore, type Source } from './challenges.ts'
import { configuredPerson } from './conversations.ts'
import { RequestError } from './workspace.ts'

// Files travel as base64 in the JSON body: one write's bytes, encoded, and
// room for the rest. A proxy in front must allow as much (nginx
// client_max_body_size, docs/challenges.md *Limits*).
export const MAX_REQUEST = Math.ceil(MAX_WRITE * 4 / 3) + 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac', '.opus': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.pdf': 'application/pdf', '.zip': 'application/zip',
  // Never rendered as a page of this origin.
  '.html': 'text/plain; charset=utf-8', '.htm': 'text/plain; charset=utf-8', '.xhtml': 'text/plain; charset=utf-8', '.js': 'text/plain; charset=utf-8', '.mjs': 'text/plain; charset=utf-8',
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

// A file's bytes, as the browser should treat untrusted content: its type by
// name, never sniffed, sandboxed (an SVG's or PDF's scripts do not run with
// this origin), inline unless a download is asked for.
function sendFile(res: ServerResponse, method: string, name: string, bytes: Buffer, headers: Record<string, string>, download: boolean) {
  const base = name.split('/').pop() ?? 'file'
  const ascii = base.replace(/[^\x20-\x7e]|["\\]/g, '_')
  res.writeHead(200, {
    'content-type': MIME[extname(base).toLowerCase()] ?? 'application/octet-stream', 'content-length': bytes.length,
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`,
    'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', 'cache-control': 'no-store', ...headers,
  })
  res.end(method === 'HEAD' ? undefined : bytes)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new RequestError(415, 'writes require content-type: application/json')
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > MAX_REQUEST) throw new RequestError(413, `request body too large (${declared} bytes; at most ${MAX_REQUEST}: one write adds at most ${MAX_WRITE} bytes of files — publish in several writes)`)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_REQUEST) throw new RequestError(413, `request body too large (at most ${MAX_REQUEST} bytes: one write adds at most ${MAX_WRITE} bytes of files — publish in several writes)`)
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
  const text = (k: string) => { const v = input[k]; if (v === undefined || v === null) return undefined; if (typeof v !== 'string') throw new RequestError(400, `${k} is text`); return v }
  const names = (k: string) => { const v = input[k]; if (v === undefined) return undefined; if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) throw new RequestError(400, `${k} is a list of names`); return v as string[] }
  const ev = input.files
  let files: AddFile[] | undefined
  if (ev !== undefined) {
    if (!Array.isArray(ev)) throw new RequestError(400, 'files is a list of {name, base64}')
    files = ev.map((e: { name?: unknown; base64?: unknown }) => {
      if (typeof e?.name !== 'string' || typeof e.base64 !== 'string') throw new RequestError(400, 'files is a list of {name, base64}')
      return { name: e.name, bytes: Buffer.from(e.base64, 'base64') }
    })
  }
  const s = input.source as { conversation?: unknown; message?: unknown } | undefined
  let source: Source | null = null
  if (s !== undefined && s !== null) {
    if (typeof s.conversation !== 'string' || !Number.isInteger(s.message)) throw new RequestError(400, 'source is {conversation, message}')
    source = { kind: 'conversation', conversation: s.conversation, message: s.message as number }
  }
  return { request: text('request'), title: text('title'), body: text('body'), base: text('base'), note: text('note'), trial: text('trial'), state: text('state'), projects: names('projects'), drop: names('drop'), files, source }
}

export async function challengeRoute(store: ChallengeStore, area: string, req: IncomingMessage, res: ServerResponse, parts: string[], url: URL): Promise<void> {
  const method = req.method ?? 'GET'
  const [, , id, sub, name] = parts
  const at = url.searchParams.get('at') || undefined
  const person = () => configuredPerson(area)
  const actor = (input: Record<string, unknown>) => {
    const author = input.author === undefined ? person() : typeof input.author === 'string' && input.author.trim() ? input.author : null
    if (!author) throw new RequestError(input.author === undefined ? 503 : 400, input.author === undefined ? 'no person is configured here (conversations.json "person"): a page cannot write' : 'author is a name')
    const opt = (k: string) => typeof input[k] === 'string' && (input[k] as string).trim() ? input[k] as string : null
    return { by: author, onBehalfOf: opt('onBehalfOf'), run: opt('run'), attempt: opt('attempt'), via: opt('via') ?? 'page' }
  }
  const need = (v: string | undefined, k: string) => { if (v === undefined) throw new RequestError(400, `${k} is required`); return v }

  if (!id && method === 'GET') {
    await store.sync()
    const state = url.searchParams.get('state') ?? 'all'
    if (state.length > 60) throw new RequestError(400, 'state is all, a state kind (open, resolved, withdrawn, custom, unspecified) or one state as written')
    const num = (k: string) => { const v = url.searchParams.get(k); return v === null ? undefined : Number(v) }
    const list = store.list({ text: url.searchParams.get('text') ?? undefined, project: url.searchParams.get('project') ?? undefined, state, limit: num('limit'), offset: num('offset') })
    const status = await store.status()
    return send(res, 200, { person: person(), disabled: status.disabled, status, ...list, operations: store.operations({ open: true }) })
  }
  if (!id && method === 'POST') {
    const input = await readBody(req)
    const f = writeFields(input)
    const r = await store.create({ ...actor(input), request: need(f.request, 'request'), title: need(f.title, 'title'), body: f.body ?? '', projects: f.projects, state: f.state, files: f.files, source: f.source, note: f.note })
    return send(res, 200, r)
  }
  if (id === 'operations') {
    const n = Number(sub)
    if (!Number.isInteger(n)) throw new RequestError(404, 'not found')
    if (!name && method === 'GET') { const op = store.operation(n); if (!op) throw new RequestError(404, `no operation ${n}`); return send(res, 200, { operation: op }) }
    // A draft's file, while the journal keeps it (not published).
    if (name === 'files' && (method === 'GET' || method === 'HEAD')) {
      const file = parts.slice(5).join('/')
      return sendFile(res, method, file, store.draftFile(n, file), {}, url.searchParams.get('download') === '1')
    }
    if (name === 'retry' && method === 'POST') return send(res, 200, { operation: await store.retry(n) })
    if (name === 'discard' && method === 'POST') { const input = await readBody(req); return send(res, 200, { operation: store.discard(n, { by: actor(input).by, reason: typeof input.reason === 'string' && input.reason.trim() ? input.reason : 'discarded' }) }) }
    throw new RequestError(404, 'not found')
  }
  if (id && !sub && method === 'GET') {
    await store.sync()
    const latest = store.current(id)
    const challenge = at ? await store.at(id, at) : latest
    if (!challenge) {
      const ops = store.operations({ challenge: id })
      if (!ops.length) throw new RequestError(404, `no challenge ${id}`)
      return send(res, 200, { challenge: null, latest: null, pinned: false, operations: ops })
    }
    return send(res, 200, { challenge, latest: latest ? { commit: latest.commit, title: latest.title, state: latest.state, updated: latest.updated, trials: latest.trials.map(t => ({ name: t.name, commit: t.commit })) } : null, pinned: !!at, operations: store.operations({ challenge: id }) })
  }
  if (id && !sub && method === 'POST') {
    const input = await readBody(req)
    const f = writeFields(input)
    const r = await store.edit(id, { ...actor(input), request: need(f.request, 'request'), base: f.base ?? null, title: f.title, body: f.body, projects: f.projects, state: f.state, trial: f.trial, files: f.files, drop: f.drop, source: f.source, note: f.note })
    return send(res, 200, r)
  }
  if (id && sub === 'history' && method === 'GET') return send(res, 200, { id, trial: url.searchParams.get('trial'), history: await store.log(id, { trial: url.searchParams.get('trial') ?? undefined }) })
  if (id && sub === 'files' && (method === 'GET' || method === 'HEAD')) {
    const file = parts.slice(4).join('/')
    if (!file) {
      const c = at ? await store.at(id, at) : (await store.sync(), store.current(id))
      if (!c) throw new RequestError(404, `no challenge ${id}`)
      return send(res, 200, { id, commit: c.commit, layout: c.layout, summary: c.summary ? c.path : null, files: c.files, trials: c.trials.map(t => ({ name: t.name, files: t.files })) })
    }
    if (!at) await store.sync()
    const e = await store.file(id, { name: file }, at)
    return sendFile(res, method, e.name, e.bytes, { 'x-challenge-commit': e.commit, 'x-challenge-path': encodeURI(e.path) }, url.searchParams.get('download') === '1')
  }
  throw new RequestError(404, 'not found')
}
