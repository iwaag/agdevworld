// Static-file primitives shared by the presentation instances
// (presentServer.ts), the Boast routes (boast.ts) and the shared-area display
// route (shares.ts): media types, byte ranges and conditional responses.
import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml', '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime', '.vtt': 'text/vtt; charset=utf-8',
  '.pdf': 'application/pdf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.zip': 'application/zip', '.pck': 'application/octet-stream',
}
export const typeOf = (path: string) => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
export const isHtml = (path: string) => /^text\/html/.test(typeOf(path))

// One byte range of a `Range: bytes=…` header (RFC 9110), or null when the
// whole file is sent. Safari plays <video> only from 206 responses: it asks
// for bytes=0-1 first and gives up on a 200 (project_migration p1).
// Several ranges are answered with the whole file, which RFC 9110 allows.
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number, end: number
  if (m[1] === '') { const n = Number(m[2]); if (n === 0) return 'unsatisfiable'; start = Math.max(0, size - n); end = size - 1 }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

// Drops the bytes of a stream outside [start, end].
function slice(start: number, end: number): Transform {
  let at = 0
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      const from = Math.max(0, start - at), to = Math.min(chunk.length, end + 1 - at)
      at += chunk.length
      done(null, from < to ? chunk.subarray(from, to) : undefined)
    },
  })
}

// What a static response is made of: whole bytes in memory, a file on disk,
// or a stream factory (a Git blob) of known size.
export type Body = { bytes: Buffer } | { file: string; size: number } | { open: () => Readable; size: number }
const sizeOf = (b: Body) => ('bytes' in b ? b.bytes.length : b.size)

// Answers a GET/HEAD for one static body: 304 on a matching validator, 416,
// 206 for one byte range, else 200.
export async function sendStatic(req: IncomingMessage, res: ServerResponse, body: Body, headers: Record<string, string>, etag?: string): Promise<void> {
  const size = sizeOf(body)
  const base: Record<string, string> = { 'accept-ranges': 'bytes', ...headers, ...(etag ? { etag } : {}) }
  const inm = req.headers['if-none-match']
  if (etag && typeof inm === 'string' && inm.split(',').map(s => s.trim()).some(t => t === etag || t === '*')) { res.writeHead(304, base); res.end(); return }
  // A range with If-Range that no longer matches is answered whole.
  const ifRange = req.headers['if-range']
  const range = typeof ifRange === 'string' && ifRange !== etag ? null : byteRange(req.headers.range, size)
  if (range === 'unsatisfiable') { res.writeHead(416, { ...base, 'content-range': `bytes */${size}` }); res.end(); return }
  const start = range?.start ?? 0, end = range?.end ?? size - 1
  res.writeHead(range ? 206 : 200, { ...base, 'content-length': String(Math.max(0, end - start + 1)), ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) })
  if (req.method === 'HEAD' || size === 0) { res.end(); return }
  if ('bytes' in body) { res.end(body.bytes.subarray(start, end + 1)); return }
  if ('file' in body) { await pipeline(createReadStream(body.file, { start, end }), res); return }
  const src = body.open()
  await (range ? pipeline(src, slice(start, end), res) : pipeline(src, res))
}
