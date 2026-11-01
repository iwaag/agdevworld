// Message files (workflow_editor p19, docs/message-files.md): the original
// bytes a person's message carried, as one bundle per message on a configured
// share, and everything that keeps each file an occurrence of exactly that
// message — validation and limits, the upload operation that a submit token
// names, publication of the bundle (staged, verified, renamed into place),
// retrieval by the whole identity, integrity, export, restore and backup.
// The association rows are written with the message in the conversation
// store's transaction (server/conversationService.ts `post`); nothing here
// routes or dispatches.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { canonicalJson } from '../shared/canonical.ts'
import type { FileAttachmentRef } from '../shared/intake.ts'
import { formatRef, parseRef } from '../shared/shares.ts'
import { atomicWrite } from './files.ts'
import { withLock } from './lock.ts'
import { hashFile, resolveRef, shareRoot, sweepUnfinished } from './shares.ts'
import { RequestError } from './workspace.ts'

// ---- limits ---------------------------------------------------------------------------------

export const FILE_LIMITS = { files: 20, fileBytes: 32 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, nameLength: 255 } as const
// The JSON body of a post carrying the most a message may: the base64 of the
// total and room for the rest. A proxy in front must allow as much (nginx
// client_max_body_size 100m on /wfe/).
export const REQUEST_BYTES = Math.ceil(FILE_LIMITS.totalBytes * 4 / 3) + 1024 * 1024
export const MANIFEST_KIND = 'ag.message-files.v1'
export const PACKAGE_KIND = 'ag.conversation-package.v1'
export const ATTACHMENT_ID = /^f-[0-9a-f]{24}$/
export const BUNDLE_ID = /^b-[0-9]{8}t[0-9]{6}z-[0-9a-f]{8}$/

// ---- configuration: <area>/attachments.json ---------------------------------------------------

export interface BackupSetting { host: string; path: string; ssh: string[] }
export interface FilesConfig { file: string; share: string; prefix: string; backup: BackupSetting | null }
const NAME = /^[a-z0-9][a-z0-9_.-]*$/
export function loadFilesConfig(area: string): FilesConfig | { disabled: string } {
  const file = join(area, 'attachments.json')
  let o: Record<string, unknown>
  try { o = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> } catch (e) {
    return { disabled: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no destination for message files is configured here (attachments.json)' : `${file} cannot be read: ${(e as Error).message}` }
  }
  const prefix = typeof o.prefix === 'string' ? o.prefix.replace(/^\/+|\/+$/g, '') : 'conversations'
  if (typeof o.share !== 'string' || !NAME.test(o.share) || !prefix || !parseRef(`shared://${o.share}/${prefix}/`)) return { disabled: `${file} needs {"share": "<share id>", "prefix": "<relative folder>", "backup"?: {"host", "path", "ssh"?}}` }
  const b = o.backup as Record<string, unknown> | undefined
  let backup: BackupSetting | null = null
  if (b !== undefined && b !== null) {
    if (typeof b.host !== 'string' || !b.host || typeof b.path !== 'string' || !b.path.startsWith('/') || (b.ssh !== undefined && !(Array.isArray(b.ssh) && b.ssh.every(x => typeof x === 'string')))) return { disabled: `${file}: backup is {"host", "path" (absolute on that host), "ssh"?: [the ssh command and its options]}` }
    backup = { host: b.host, path: b.path.replace(/\/+$/, ''), ssh: (b.ssh as string[] | undefined) ?? ['ssh'] }
  }
  return { file, share: o.share, prefix, backup }
}

export interface FilesAvailability { available: boolean; problem: string | null; files: number; fileBytes: number; totalBytes: number; requestBytes: number; nameLength: number }
// What a client may offer now: the limits, and whether files can be stored
// here (configured, and the share reachable on this host).
export async function filesAvailability(area: string): Promise<FilesAvailability> {
  const base = { ...FILE_LIMITS, requestBytes: REQUEST_BYTES }
  const cfg = loadFilesConfig(area)
  if ('disabled' in cfg) return { available: false, problem: cfg.disabled, ...base }
  const root = await shareRoot(cfg.share)
  return { available: root.state === 'ok', problem: root.state === 'ok' ? null : root.detail, ...base }
}

// ---- what a client sends --------------------------------------------------------------------------

export interface IncomingFile { ordinal: number; name: string; mime: string; bytes: Buffer; sha256: string; preview: 'image' | 'text' | null; served: string }
const MIME = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const BY_NAME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', heic: 'image/heic',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain', json: 'application/json', pdf: 'application/pdf', zip: 'application/zip',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', wav: 'audio/wav', mp3: 'audio/mpeg', html: 'text/html', htm: 'text/html', js: 'text/javascript',
}
const TEXT_NAMES = new Set(['txt', 'md', 'csv', 'log', 'json'])
const extOf = (name: string) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : '' }
// The image formats a browser may show inline, recognized by their bytes:
// a client's hint or a file name never makes something render.
export function imageType(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}
// How a file is served: a recognized image as itself, a plain text name as
// text, everything else as bytes to download.
export function servedAs(name: string, bytes: Buffer): { preview: 'image' | 'text' | null; served: string } {
  const img = imageType(bytes)
  if (img) return { preview: 'image', served: img }
  if (TEXT_NAMES.has(extOf(name))) return { preview: 'text', served: 'text/plain; charset=utf-8' }
  return { preview: null, served: 'application/octet-stream' }
}
const bad = (file: number, name: string | null, why: string) => new RequestError(400, `file ${file}${name ? ` (${name})` : ''}: ${why}`, { code: 'invalid-attachment', file })
const limit = (msg: string, limit: string, actual: number, file?: number) => new RequestError(413, msg, { code: 'attachment-limit', limit, actual, ...(file ? { file } : {}) })
// A file name as a person gave it: kept as metadata, never a path.
export function validName(name: unknown, file: number): string {
  if (typeof name !== 'string') throw bad(file, null, 'name is required')
  const n = name.normalize('NFC').trim()
  if (!n || [...n].length > FILE_LIMITS.nameLength) throw bad(file, null, `a name is 1–${FILE_LIMITS.nameLength} characters`)
  // eslint-disable-next-line no-control-regex
  if (/[/\\\u0000-\u001f\u007f]/.test(n) || n === '.' || n === '..') throw bad(file, n, 'a name has no /, \\ or control characters')
  return n
}
// `files: [{name, base64, mime?}]` as a client sends it: every size checked
// before anything is decoded, the encoding checked strictly.
export function decodeFiles(v: unknown): IncomingFile[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new RequestError(400, 'files is a list of {name, base64, mime?}', { code: 'invalid-attachment' })
  if (v.length > FILE_LIMITS.files) throw limit(`a message carries at most ${FILE_LIMITS.files} files (${v.length} given)`, 'files', v.length)
  const sized = v.map((f: unknown, i) => {
    const n = i + 1
    if (typeof f !== 'object' || f === null || Array.isArray(f)) throw bad(n, null, 'a file is {name, base64, mime?}')
    const o = f as { name?: unknown; base64?: unknown; mime?: unknown }
    const name = validName(o.name, n)
    if (typeof o.base64 !== 'string') throw bad(n, name, 'base64 is required')
    if (o.mime !== undefined && o.mime !== null && o.mime !== '' && (typeof o.mime !== 'string' || !MIME.test(o.mime.split(';')[0].trim().toLowerCase()))) throw bad(n, name, 'mime is a media type (type/subtype)')
    const b64 = o.base64
    if (b64.length % 4 !== 0 || !BASE64.test(b64)) throw bad(n, name, 'base64 is malformed (standard alphabet with padding, no data: prefix or line breaks)')
    const size = b64.length / 4 * 3 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)
    if (size > FILE_LIMITS.fileBytes) throw limit(`file ${n} (${name}) is ${size} bytes; one file is at most ${FILE_LIMITS.fileBytes}`, 'fileBytes', size, n)
    const hint = typeof o.mime === 'string' && o.mime ? o.mime.split(';')[0].trim().toLowerCase() : null
    return { n, name, b64, size, hint }
  })
  const total = sized.reduce((s, f) => s + f.size, 0)
  if (total > FILE_LIMITS.totalBytes) throw limit(`the files of a message are at most ${FILE_LIMITS.totalBytes} bytes together (${total} given)`, 'totalBytes', total)
  return sized.map(f => {
    const bytes = Buffer.from(f.b64, 'base64')
    if (bytes.length !== f.size) throw bad(f.n, f.name, 'base64 is malformed')
    return { ordinal: f.n, name: f.name, mime: f.hint ?? BY_NAME[extOf(f.name)] ?? 'application/octet-stream', bytes, sha256: createHash('sha256').update(bytes).digest('hex'), ...servedAs(f.name, bytes) }
  })
}

// The digest an upload operation is bound to: what was said, the files in
// order and where the words go. Derived URLs, host paths and arrival times
// are not part of it.
export function submissionDigest(o: { author: string; text: string; files: { name: string; mime: string; bytes: number; sha256: string }[]; challenges: unknown[]; to: string[]; runs: string[]; re: number[]; with: string | null; title: string | null; via: string | null }): string {
  return `sha256:${createHash('sha256').update(canonicalJson({ ...o, files: o.files.map(f => ({ name: f.name, mime: f.mime, bytes: f.bytes, sha256: f.sha256 })) })).digest('hex')}`
}

// ---- identities and the bundle ---------------------------------------------------------------------

export const newAttachmentId = () => `f-${randomBytes(12).toString('hex')}`
export const newBundleId = (at = new Date()) => `b-${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').replace('T', 't')}-${randomBytes(4).toString('hex')}`
export const bundleFolder = (prefix: string, conv: string, bundle: string) => `${prefix}/${conv}/attachments/${bundle}`
export const fileRef = (share: string, prefix: string, conv: string, bundle: string, id: string) => formatRef(share, `${bundleFolder(prefix, conv, bundle)}/${id}`)

export interface AllocatedFile { id: string; ordinal: number; name: string; mime: string; bytes: number; sha256: string; preview: 'image' | 'text' | null; served: string }
export interface Manifest { kind: typeof MANIFEST_KIND; conversation: string; bundle: string; share: string; path: string; files: { id: string; ordinal: number; name: string; mime: string; bytes: number; sha256: string }[]; digest: string }
export function manifestOf(o: { conversation: string; bundle: string; share: string; prefix: string; files: AllocatedFile[] }): Manifest {
  const body = { kind: MANIFEST_KIND as typeof MANIFEST_KIND, conversation: o.conversation, bundle: o.bundle, share: o.share, path: `${bundleFolder(o.prefix, o.conversation, o.bundle)}/`, files: o.files.map(f => ({ id: f.id, ordinal: f.ordinal, name: f.name, mime: f.mime, bytes: f.bytes, sha256: f.sha256 })) }
  return { ...body, kind: MANIFEST_KIND, digest: manifestDigest(body) }
}
export const manifestDigest = (body: Omit<Manifest, 'digest'> | Manifest) => { const { digest: _d, ...rest } = body as Manifest; return `sha256:${createHash('sha256').update(canonicalJson(rest)).digest('hex')}` }

export class StorageUnavailable extends RequestError {
  constructor(detail: string, state: string) { super(503, `message files cannot be stored now: ${detail}`, { code: 'storage-unavailable', state }) }
}
const unfinished = () => `.staging-${hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`
const exists = (p: string) => stat(p).then(() => true, () => false)

// The bundle's folder on the share, published once: an existing complete
// bundle with the same manifest is verified and adopted (a retry after a
// crash); otherwise the files are written in a staging folder, each read back
// and hashed, the manifest written, and the folder renamed into place. One
// owner at a time per bundle (a lock the OS releases when its holder dies);
// a staging folder left by a dead process is removed first. A folder there
// with another manifest is never touched.
export async function publishBundle(o: { share: string; prefix: string; conversation: string; bundle: string; files: AllocatedFile[]; bytes: (f: AllocatedFile) => Buffer }, hooks: { afterStaging?: () => Promise<void> } = {}): Promise<{ digest: string; adopted: boolean }> {
  const root = await shareRoot(o.share)
  if (root.state !== 'ok') throw new StorageUnavailable(root.detail, root.state)
  const manifest = manifestOf(o)
  const dest = join(root.root!, ...bundleFolder(o.prefix, o.conversation, o.bundle).split('/'))
  const parent = join(dest, '..')
  return withLock(join(root.root!, `.wfe-bundle-${o.bundle}`), async () => {
    const existing = await readFile(join(dest, 'manifest.json'), 'utf8').then(t => JSON.parse(t) as Manifest, () => null)
    if (existing) {
      if (existing.digest !== manifest.digest) throw new RequestError(409, `${o.bundle} on the share holds another manifest; it is not overwritten`, { code: 'attachment-integrity' })
      for (const f of o.files) {
        const p = join(dest, f.id)
        const st = await stat(p).catch(() => null)
        if (!st || st.size !== f.bytes || await hashFile(p) !== f.sha256) throw new RequestError(409, `${o.bundle}/${f.id} on the share is not the file recorded for it`, { code: 'attachment-integrity' })
      }
      return { digest: manifest.digest, adopted: true }
    }
    if (await exists(dest)) throw new RequestError(409, `${o.bundle} exists on the share without a manifest; it is kept for diagnosis and not overwritten`, { code: 'attachment-integrity' })
    await mkdir(parent, { recursive: true })
    await sweepUnfinished(parent)
    const staging = join(parent, unfinished())
    try {
      await mkdir(staging)
      for (const f of o.files) {
        const p = join(staging, f.id)
        await writeFile(p, o.bytes(f), { flag: 'wx' })
        const landed = await hashFile(p)
        if (landed !== f.sha256) throw new RequestError(422, `${f.name}: the bytes written to the share are not the ones received (${landed.slice(0, 12)} ≠ ${f.sha256.slice(0, 12)})`, { code: 'attachment-integrity' })
      }
      await atomicWrite(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
      await hooks.afterStaging?.()
      await rename(staging, dest)
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
    }
    return { digest: manifest.digest, adopted: false }
  }, { timeoutMs: 120_000, what: `the files of bundle ${o.bundle}` })
}

// ---- reading -----------------------------------------------------------------------------------------

export interface FileRow { id: number; conv: string; message: number; ordinal: number; attachment: string; bundle: string; upload: number; name: string; mime: string; bytes: number; sha256: string; preview: string | null; served: string; ref: string; at: string }
export const refOf = (r: FileRow): FileAttachmentRef => ({ kind: 'file', id: r.attachment, bundle: r.bundle, conversation: r.conv, message: r.message, ordinal: r.ordinal, name: r.name, mime: r.mime, bytes: r.bytes, sha256: r.sha256, ref: r.ref })
export const attachmentApi = (conv: string, message: number, id: string) => `api/conversations/${encodeURIComponent(conv)}/messages/${message}/attachments/${encodeURIComponent(id)}`
export interface FileView extends FileAttachmentRef { preview: 'image' | 'text' | null; api: string; url: string | null }
export const fileView = (r: FileRow, viewBase?: string | null): FileView => ({ ...refOf(r), preview: (r.preview as FileView['preview']) ?? null, api: attachmentApi(r.conv, r.message, r.attachment), url: viewBase ? `${viewBase.replace(/\/?$/, '/')}${attachmentApi(r.conv, r.message, r.attachment)}` : null })

export type Integrity = 'verified' | 'missing' | 'altered' | 'unavailable'
// Where a file's bytes are on this host, or why they cannot be read here.
export async function locateFile(ref: string): Promise<{ abs?: string; state: 'ok' | 'missing' | 'unavailable'; detail: string }> {
  const r = await resolveRef(ref)
  if (r.state === 'ok') return { abs: r.abs, state: 'ok', detail: '' }
  if (r.state === 'absent') return { state: 'missing', detail: r.detail }
  return { state: 'unavailable', detail: r.detail }
}
// One file against its record: `quick` compares the size only.
export async function checkFile(f: Pick<FileAttachmentRef, 'ref' | 'bytes' | 'sha256'>, opts: { quick?: boolean } = {}): Promise<{ state: Integrity; detail: string; abs?: string }> {
  const at = await locateFile(f.ref)
  if (at.state !== 'ok') return { state: at.state, detail: at.detail }
  const st = await stat(at.abs!).catch(() => null)
  if (!st?.isFile()) return { state: 'missing', detail: `${f.ref} is not a file` }
  if (st.size !== f.bytes) return { state: 'altered', detail: `${f.ref} is ${st.size} bytes, recorded ${f.bytes}`, abs: at.abs }
  if (opts.quick) return { state: 'verified', detail: 'size matches (content not re-read)', abs: at.abs }
  const h = await hashFile(at.abs!)
  return h === f.sha256 ? { state: 'verified', detail: 'sha256 matches', abs: at.abs } : { state: 'altered', detail: `${f.ref}: sha256 ${h.slice(0, 12)}… recorded ${f.sha256.slice(0, 12)}…`, abs: at.abs }
}

// The original bytes of one file, as the browser should treat untrusted
// content: the type WFE decided at acceptance, never sniffed, sandboxed,
// inline only for a preview. GET checks the content against the recorded
// hash before sending; HEAD the size.
export async function serveFile(req: IncomingMessage, res: ServerResponse, r: FileRow, download: boolean): Promise<void> {
  const method = req.method ?? 'GET'
  const c = await checkFile(refOf(r), { quick: true })
  if (c.state === 'unavailable') throw new StorageUnavailable(c.detail, 'unavailable')
  if (c.state === 'missing') throw new RequestError(410, `the bytes of ${r.attachment} are not on the share`, { code: 'attachment-missing' })
  if (c.state === 'altered') throw new RequestError(409, `the bytes of ${r.attachment} on the share are not the recorded ones (${c.detail})`, { code: 'attachment-integrity' })
  let bytes: Buffer | undefined
  if (method !== 'HEAD') {
    bytes = await readFile(c.abs!)
    if (bytes.length !== r.bytes || createHash('sha256').update(bytes).digest('hex') !== r.sha256) throw new RequestError(409, `the bytes of ${r.attachment} on the share are not the recorded ones (sha256 differs)`, { code: 'attachment-integrity' })
  }
  const inline = !download && !!r.preview
  const ascii = r.name.replace(/[^\x20-\x7e]|["\\;]/g, '_')
  res.writeHead(200, {
    'content-type': inline ? r.served : 'application/octet-stream', 'content-length': r.bytes,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(r.name)}`,
    'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', 'cache-control': 'private, max-age=31536000, immutable',
    'x-attachment-id': r.attachment, 'x-attachment-sha256': r.sha256,
  })
  res.end(bytes)
}

// ---- export and restore (docs/message-files.md *Archive, export and backup*) -------------------------------

export interface PackageFile { path: string; bytes: number; sha256: string }
export interface Package { kind: typeof PACKAGE_KIND; conversation: string; created: string; by: string; horizon: number; transcript: PackageFile; manifests: PackageFile[]; files: (PackageFile & { attachment: string; bundle: string; message: number; ordinal: number; name: string })[]; challenges: { id: string; commit: string; message: number }[]; note: string }
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

// A self-contained recovery package of one conversation: its transcript
// lines, every bundle manifest and every original file, each hashed while it
// is packaged (a file that does not match its record stops the export).
export async function writePackage(out: string, o: { conversation: string; by: string; horizon: number; transcript: string; bundles: Manifest[]; files: FileRow[]; challenges: { id: string; commit: string; message: number }[] }): Promise<Package> {
  if (await exists(out) && (await readdir(out)).length) throw new RequestError(409, `${out} is not empty; export into a new folder`)
  await mkdir(join(out, 'attachments'), { recursive: true })
  await writeFile(join(out, 'transcript.jsonl'), o.transcript)
  const manifests: PackageFile[] = []
  for (const m of o.bundles) {
    const text = `${JSON.stringify(m, null, 2)}\n`
    if (manifestDigest(m) !== m.digest) throw new RequestError(409, `the manifest of ${m.bundle} does not match its digest`, { code: 'attachment-integrity' })
    await mkdir(join(out, 'attachments', m.bundle), { recursive: true })
    await writeFile(join(out, 'attachments', m.bundle, 'manifest.json'), text)
    manifests.push({ path: `attachments/${m.bundle}/manifest.json`, bytes: Buffer.byteLength(text), sha256: sha(text) })
  }
  const files: Package['files'] = []
  for (const f of o.files) {
    const c = await checkFile(refOf(f), { quick: true })
    if (c.state !== 'verified') throw new RequestError(c.state === 'unavailable' ? 503 : 409, `${f.attachment} (${f.name}, #${f.message}): ${c.state} — ${c.detail}`, { code: c.state === 'unavailable' ? 'storage-unavailable' : c.state === 'missing' ? 'attachment-missing' : 'attachment-integrity' })
    const bytes = await readFile(c.abs!)
    if (sha(bytes) !== f.sha256) throw new RequestError(409, `${f.attachment} (${f.name}): sha256 differs from its record`, { code: 'attachment-integrity' })
    const path = `attachments/${f.bundle}/${f.attachment}`
    await writeFile(join(out, path), bytes, { flag: 'wx' })
    if (await hashFile(join(out, path)) !== f.sha256) throw new RequestError(422, `${path}: the packaged copy does not match`, { code: 'attachment-integrity' })
    files.push({ path, bytes: f.bytes, sha256: f.sha256, attachment: f.attachment, bundle: f.bundle, message: f.message, ordinal: f.ordinal, name: f.name })
  }
  const pkg: Package = {
    kind: PACKAGE_KIND, conversation: o.conversation, created: new Date().toISOString(), by: o.by, horizon: o.horizon,
    transcript: { path: 'transcript.jsonl', bytes: Buffer.byteLength(o.transcript), sha256: sha(o.transcript) }, manifests, files, challenges: o.challenges,
    note: 'Original files and their manifests are included. Pinned challenges are referenced, not embedded: their content needs the challenge repository (pj-challenges) beside it. Restoring this package starts nothing and replays no delivery.',
  }
  await writeFile(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  return pkg
}

export interface Restored { conversation: string; into: string; verified: number; messages: { message: number; files: { ordinal: number; attachment: string; name: string; path: string }[] }[]; problems: string[] }
// Unpacks a package into an isolated folder, checking every hash, and says
// which message each file belongs to. Writes nothing else.
export async function restorePackage(from: string, into: string): Promise<Restored> {
  const pkg = JSON.parse(await readFile(join(from, 'package.json'), 'utf8')) as Package
  if (pkg.kind !== PACKAGE_KIND) throw new RequestError(400, `${from}/package.json is not ${PACKAGE_KIND}`)
  if (await exists(into) && (await readdir(into)).length) throw new RequestError(409, `${into} is not empty; restore into a new folder`)
  const problems: string[] = []
  let verified = 0
  for (const f of [pkg.transcript, ...pkg.manifests, ...pkg.files]) {
    const src = join(from, ...f.path.split('/'))
    const bytes = await readFile(src).catch(() => null)
    if (!bytes) { problems.push(`${f.path}: missing from the package`); continue }
    if (bytes.length !== f.bytes || sha(bytes) !== f.sha256) { problems.push(`${f.path}: does not match the package's hash`); continue }
    const dst = join(into, ...f.path.split('/'))
    await mkdir(join(dst, '..'), { recursive: true })
    await writeFile(dst, bytes, { flag: 'wx' })
    if (await hashFile(dst) !== f.sha256) { problems.push(`${f.path}: the restored copy does not match`); continue }
    verified++
  }
  for (const m of pkg.manifests) {
    const text = await readFile(join(into, ...m.path.split('/')), 'utf8').catch(() => null)
    if (!text) continue
    const man = JSON.parse(text) as Manifest
    if (manifestDigest(man) !== man.digest) problems.push(`${m.path}: its digest does not match its body`)
    for (const f of man.files) if (!pkg.files.some(p => p.attachment === f.id && p.sha256 === f.sha256)) problems.push(`${m.path}: ${f.id} is not in the package`)
  }
  // The associations as the transcript states them.
  const byMessage = new Map<number, Restored['messages'][number]['files']>()
  for (const line of (await readFile(join(from, 'transcript.jsonl'), 'utf8')).split('\n').filter(Boolean)) {
    const rec = JSON.parse(line) as { type?: string; id?: number; attachments?: { kind: string; id: string; ordinal?: number; name?: string; bundle?: string }[] }
    if (rec.type !== 'message' || !rec.attachments) continue
    for (const a of rec.attachments.filter(x => x.kind === 'file')) {
      const p = pkg.files.find(x => x.attachment === a.id)
      if (!p) { problems.push(`#${rec.id} carries ${a.id}, which the package lacks`); continue }
      if (p.message !== rec.id) problems.push(`${a.id}: the package says #${p.message}, the transcript #${rec.id}`)
      byMessage.set(rec.id!, [...byMessage.get(rec.id!) ?? [], { ordinal: a.ordinal ?? p.ordinal, attachment: a.id, name: a.name ?? p.name, path: p.path }])
    }
  }
  return { conversation: pkg.conversation, into, verified, messages: [...byMessage].map(([message, files]) => ({ message, files })), problems }
}

// ---- backup (outside the live share) -------------------------------------------------------------------

function run(cmd: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const p = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    p.stdout.on('data', d => { stdout += d })
    p.stderr.on('data', d => { stderr += d })
    p.on('error', e => resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` }))
    p.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
    p.stdin.end(input ?? '')
  })
}
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const sshCmd = (b: BackupSetting) => b.ssh.join(' ')
// Copies one published bundle to the backup destination and reads every
// copied file's sha256 back from there. Existing copies are never replaced:
// a bundle already there must hash the same.
export async function backupBundle(cfg: FilesConfig, m: Manifest): Promise<{ destination: string; detail: string }> {
  const b = cfg.backup
  if (!b) throw new Error('no backup destination is configured (attachments.json "backup")')
  const root = await shareRoot(cfg.share)
  if (root.state !== 'ok') throw new StorageUnavailable(root.detail, root.state)
  const rel = bundleFolder(cfg.prefix, m.conversation, m.bundle)
  const src = join(root.root!, ...rel.split('/'))
  const dst = `${b.path}/${rel}`
  const mk = await run([...b.ssh, b.host, `mkdir -p ${q(dst)}`])
  if (mk.code !== 0) throw new Error(`backup: cannot create ${b.host}:${dst}: ${mk.stderr.trim()}`)
  const sync = await run(['rsync', '-a', '--ignore-existing', '-e', sshCmd(b), `${src}/`, `${b.host}:${dst}/`])
  if (sync.code !== 0) throw new Error(`backup: rsync to ${b.host}:${dst} failed: ${sync.stderr.trim()}`)
  const names = ['manifest.json', ...m.files.map(f => f.id)]
  const sums = await run([...b.ssh, b.host, `cd ${q(dst)} && (sha256sum ${names.map(q).join(' ')} 2>/dev/null || shasum -a 256 ${names.map(q).join(' ')})`])
  if (sums.code !== 0) throw new Error(`backup: cannot read the hashes back from ${b.host}:${dst}: ${sums.stderr.trim()}`)
  const got = new Map(sums.stdout.trim().split('\n').map(l => { const [h, n] = l.trim().split(/\s+\*?/); return [n, h] as const }))
  const manifestText = await readFile(join(src, 'manifest.json'))
  if (got.get('manifest.json') !== sha(manifestText)) throw new Error(`backup: ${b.host}:${dst}/manifest.json differs from the share's`)
  for (const f of m.files) if (got.get(f.id) !== f.sha256) throw new Error(`backup: ${b.host}:${dst}/${f.id} differs from its record`)
  return { destination: `${b.host}:${dst}`, detail: `${m.files.length} file(s) and the manifest hash-verified at the destination` }
}
// Brings one bundle back from the backup into a folder and verifies it.
export async function restoreFromBackup(cfg: FilesConfig, conversation: string, bundle: string, into: string): Promise<{ manifest: Manifest; files: number }> {
  const b = cfg.backup
  if (!b) throw new Error('no backup destination is configured (attachments.json "backup")')
  if (!BUNDLE_ID.test(bundle)) throw new RequestError(400, `${bundle} is not a bundle id`)
  if (await exists(into) && (await readdir(into)).length) throw new RequestError(409, `${into} is not empty; restore into a new folder`)
  await mkdir(into, { recursive: true })
  const rel = bundleFolder(cfg.prefix, conversation, bundle)
  const r = await run(['rsync', '-a', '-e', sshCmd(b), `${b.host}:${b.path}/${rel}/`, `${into}/`])
  if (r.code !== 0) throw new Error(`restore: rsync from ${b.host}:${b.path}/${rel} failed: ${r.stderr.trim()}`)
  const manifest = JSON.parse(await readFile(join(into, 'manifest.json'), 'utf8')) as Manifest
  if (manifestDigest(manifest) !== manifest.digest) throw new Error(`restore: the manifest of ${bundle} does not match its digest`)
  for (const f of manifest.files) if (await hashFile(join(into, f.id)).catch(() => null) !== f.sha256) throw new Error(`restore: ${f.id} (${f.name}) does not match its manifest`)
  return { manifest, files: manifest.files.length }
}
