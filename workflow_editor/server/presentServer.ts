// One presentation's serving instance (p7, docs/presentations.md). Started by
// server/present.ts in a session of its own, so the process group of the
// attempt that asked for it can end without ending it. It serves the review
// screen, the manifest's files and its identity, nothing else; it stops on
// its owner's shutdown request (the token) or a signal.
//
//   node server/presentServer.ts --instance pi-… --config <file.json>
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { join, resolve, sep } from 'node:path'
import { escapeHtml, MANIFEST_KIND, renderReview } from '../shared/review.ts'
import { byteRange, typeOf } from './staticServe.ts'

export interface ServeConfig {
  instance: string
  folder: string // absolute path of the presentation folder (manifest.json, review.md, content/)
  bind: string
  port: number
  tokenFile: string
  title: string
  run: string // <project> / <workflow>/<run>
  presentation: string
  revision: string
  answer: { url: string | null; text: string; lead?: string } // where the person answers; `lead` replaces the default sentence (p17: a review round's page)
}
export interface ManifestFile { kind: string; presentation: string; entry: string; review: string; files: { path: string; sha256: string; bytes: number }[] }

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0 || !process.argv[i + 1]) { console.error(`--${name} is required`); process.exit(2) }
  return process.argv[i + 1]
}

// Reads the bundle and checks every file against the manifest; any
// difference refuses the start (exit 3), so nothing else is ever served
// under this revision.
export function loadBundle(folder: string): { manifest: ManifestFile; files: Map<string, Buffer> } {
  const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as ManifestFile
  if (manifest.kind !== MANIFEST_KIND) throw new Error(`manifest kind is ${manifest.kind}, not ${MANIFEST_KIND}`)
  const root = resolve(folder)
  const files = new Map<string, Buffer>()
  for (const f of manifest.files) {
    const abs = resolve(root, f.path)
    if (!abs.startsWith(root + sep) || f.path.split('/').includes('..')) throw new Error(`manifest path ${f.path} leaves the presentation`)
    const bytes = readFileSync(abs)
    if (bytes.length !== f.bytes || sha256(bytes) !== f.sha256) throw new Error(`${f.path} differs from the manifest (the presented revision was changed)`)
    files.set(f.path, bytes)
  }
  return { manifest, files }
}

export { byteRange }

export function reviewPage(c: ServeConfig, manifest: ManifestFile, review: string): string {
  const answer = c.answer.url ? `<a class="answer" href="${escapeHtml(c.answer.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.answer.text)}</a>` : `<span class="answer">${escapeHtml(c.answer.text)}</span>`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(c.title)} — review</title>
<style>
  :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 15px; color: #1f2329; }
  body { margin: 0; height: 100vh; display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 30%); background: #2a2e35; }
  main { display: flex; flex-direction: column; min-width: 0; }
  main .bar { color: #eef1f5; padding: 8px 14px; font-size: 13px; display: flex; gap: 12px; align-items: center; }
  main .bar a { color: #a8c4ff; }
  iframe { flex: 1; border: 0; background: #fff; width: 100%; }
  aside { background: #f7f7f5; overflow: auto; padding: 18px 20px 28px; border-left: 1px solid #d9dde3; }
  aside h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #69717d; font-size: 12px; margin-bottom: 14px; }
  .review h2 { font-size: 17px; margin: 18px 0 6px; } .review h3, .review h4 { font-size: 15px; margin: 14px 0 4px; }
  .review code { background: #eceef1; padding: 1px 4px; border-radius: 4px; } .review pre { background: #eceef1; padding: 8px; overflow: auto; border-radius: 6px; }
  .review li { margin: 3px 0; }
  .respond { margin-top: 22px; padding: 12px 14px; border-radius: 10px; background: #e5f3ea; border: 1px solid #8dc9a7; }
  .respond strong { display: block; margin-bottom: 4px; }
  .answer { font-weight: 600; }
  @media (max-width: 900px) { body { grid-template-columns: 1fr; grid-template-rows: 60vh auto; height: auto; } iframe { min-height: 60vh; } }
</style></head>
<body data-instance="${escapeHtml(c.instance)}" data-revision="${escapeHtml(c.revision)}">
<main><div class="bar"><span>Result — ${escapeHtml(manifest.entry)}</span><a href="/content/${escapeHtml(manifest.entry.replace(/^content\//, ''))}" target="_blank" rel="noopener">open alone ↗</a></div>
<iframe src="/content/${escapeHtml(manifest.entry.replace(/^content\//, ''))}" title="The presented result"></iframe></main>
<aside><h1>${escapeHtml(c.title)}</h1>
<div class="meta">${escapeHtml(c.run)} · presentation ${escapeHtml(c.presentation)} · revision ${escapeHtml(c.revision.replace(/^sha256:/, '').slice(0, 12))}</div>
<div class="review">${review}</div>
<div class="respond"><strong>Your feedback or acceptance</strong>${escapeHtml(c.answer.lead ?? 'Answer the review question of this run')}: ${answer}. This page records nothing.</div>
</aside></body></html>
`
}

function main() {
  const instance = arg('instance')
  const c = JSON.parse(readFileSync(arg('config'), 'utf8')) as ServeConfig
  if (c.instance !== instance) { console.error(`config is for ${c.instance}, not ${instance}`); process.exit(2) }
  const token = Buffer.from(readFileSync(c.tokenFile, 'utf8').trim())
  let bundle: ReturnType<typeof loadBundle>
  try { bundle = loadBundle(c.folder) } catch (e) { console.error(`refused: ${(e as Error).message}`); process.exit(3) }
  const page = Buffer.from(reviewPage(c, bundle.manifest, renderReview(bundle.files.get(bundle.manifest.review)?.toString('utf8') ?? '')))
  const identity = Buffer.from(JSON.stringify({ instance: c.instance, presentation: c.presentation, revision: c.revision, run: c.run }))
  const send = (res: ServerResponse, status: number, type: string, body: Buffer | string, csp: string) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': csp, 'referrer-policy': 'no-referrer' })
    res.end(body)
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://presentation.invalid')
    const path = decodeURIComponent(url.pathname)
    if (req.method === 'POST' && path === '/.wfe-present/shutdown') {
      const given = Buffer.from(String(req.headers['x-wfe-present-token'] ?? ''))
      if (given.length !== token.length || !timingSafeEqual(given, token)) return send(res, 403, 'text/plain', 'not the owner', "default-src 'none'")
      send(res, 202, 'application/json', '{"stopping":true}', "default-src 'none'")
      console.log(`${new Date().toISOString()} shutdown requested by the owner`)
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 2000).unref()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'read only', "default-src 'none'")
    if (path === '/.wfe-present/identity') return send(res, 200, 'application/json', identity, "default-src 'none'")
    if (path === '/' || path === '/index.html') return send(res, 200, 'text/html; charset=utf-8', page, "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    if (path.startsWith('/content/')) {
      const rel = `content/${path.slice('/content/'.length) || ''}`
      const bytes = bundle.files.get(rel) ?? (rel.endsWith('/') ? bundle.files.get(`${rel}index.html`) : undefined)
      if (bytes) {
        const type = typeOf(rel)
        const base = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "frame-ancestors 'self'", 'referrer-policy': 'no-referrer', 'accept-ranges': 'bytes' }
        const range = byteRange(req.headers.range, bytes.length)
        if (range === 'unsatisfiable') { res.writeHead(416, { ...base, 'content-range': `bytes */${bytes.length}` }); return res.end() }
        if (range) {
          res.writeHead(206, { ...base, 'content-range': `bytes ${range.start}-${range.end}/${bytes.length}`, 'content-length': range.end - range.start + 1 })
          return res.end(req.method === 'HEAD' ? undefined : bytes.subarray(range.start, range.end + 1))
        }
        res.writeHead(200, { ...base, 'content-length': bytes.length })
        return res.end(req.method === 'HEAD' ? undefined : bytes)
      }
    }
    send(res, 404, 'text/plain', 'not part of this presentation', "default-src 'none'")
  })
  server.on('error', e => { console.error(`refused: ${(e as Error).message}`); process.exit((e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 4 : 1) })
  server.listen(c.port, c.bind, () => console.log(`${new Date().toISOString()} ${c.instance} serving ${c.presentation} (${c.revision}) on ${c.bind}:${c.port}`))
  process.on('SIGHUP', () => {}) // no terminal: a hang-up is not a stop
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { console.log(`${new Date().toISOString()} ${sig}`); server.close(); process.exit(0) })
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main()
