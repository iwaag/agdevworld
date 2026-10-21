// Shared areas on this host (project_migration p6, docs/shares.md): where a
// logical share is mounted here, resolving `shared://` references against
// it, and the file layer of input sets and external outputs — reading,
// hashing, staging, publishing and verifying bytes that never enter Git.
// The record rules are in shared/run.ts; tracked records hold references and
// manifests only, never this host's paths.
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, readFileSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { canonicalJson } from '../shared/canonical.ts'
import { ID_PATTERN } from '../shared/model.ts'
import { runFolder, runKey, type RunRecord, type RunRef } from '../shared/run.ts'
import {
  formatRef, inputBody, OUTPUT_MANIFEST, SHARE_SCHEME, outputBody, outputFolderPath, parseRef, totalBytes,
  type SetFile, type SetObservation, type ShareRef, type Staging,
} from '../shared/shares.ts'
import { atomicWrite, inside } from './files.ts'
import { withLock } from './lock.ts'
import { loadPresentConfig } from './present.ts'
import { projectId, runOpLocked, usableRun, type OpContext } from './runs.ts'
import { runSpace } from './runspace.ts'
import { RequestError, type Workspace } from './workspace.ts'

// User dotfiles are content; these names belong to the transport or OS.
const transportMetadata = (name: string) => name === '.wfe-share.json' || name === OUTPUT_MANIFEST || name === '.DS_Store' || name === '.git' || name.startsWith('.partial-') || name.startsWith('.staging-')

// ---- configuration: <area>/shares.json ----------------------------------------------------

// The operating area whose shares.json applies (the CLI's and the service's
// --area). Set once per process by the entrance; WFE_AREA otherwise.
let configuredArea: string | undefined
export const setShareArea = (area: string | undefined) => { configuredArea = area }
const areaOf = () => configuredArea ?? process.env.WFE_AREA

// The file at a share's root that says the share is mounted here, naming it.
export const DEFAULT_MARKER = '.wfe-share.json'
export const SHARES_FILE = 'shares.json'
export interface ShareSetting { root: string; marker: string | null; publicBase: string | null }
export interface ShareConfig { file: string | null; shares: Record<string, ShareSetting> }

export function loadShareConfig(area = areaOf()): ShareConfig {
  if (!area) return { file: null, shares: {} }
  const file = join(area, SHARES_FILE)
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { file: null, shares: {} }
    throw new RequestError(409, `${file} cannot be read: ${(e as Error).message}`)
  }
  const shares = (raw as { shares?: unknown })?.shares
  if (!shares || typeof shares !== 'object' || Array.isArray(shares)) throw new RequestError(409, `${file}: "shares" must be an object of share id → {root, marker?, publicBase?}`)
  const out: Record<string, ShareSetting> = {}
  for (const [id, v] of Object.entries(shares as Record<string, unknown>)) {
    const s = v as Record<string, unknown>
    if (!ID_PATTERN.test(id)) throw new RequestError(409, `${file}: share id "${id}" must match ${ID_PATTERN.source}`)
    if (!s || typeof s.root !== 'string' || !isAbsolute(s.root) || s.root === '/' ) throw new RequestError(409, `${file}: shares.${id}.root must be an absolute folder (not /)`)
    const marker = s.marker === undefined ? DEFAULT_MARKER : s.marker
    if (marker !== null && (typeof marker !== 'string' || marker.includes('/') || !marker)) throw new RequestError(409, `${file}: shares.${id}.marker is a file name at the root, or null`)
    const publicBase = s.publicBase ?? null
    if (publicBase !== null && (typeof publicBase !== 'string' || !/^https?:\/\//.test(publicBase))) throw new RequestError(409, `${file}: shares.${id}.publicBase must be an http(s) URL or null`)
    out[id] = { root: s.root.replace(/\/+$/, ''), marker: marker as string | null, publicBase: publicBase as string | null }
  }
  return { file, shares: out }
}
// Where a share's files are downloaded from on the LAN: its publicBase, or
// this service's own route under present.json's answerBase.
export function downloadBase(share: string, cfg = loadShareConfig()): string | null {
  const s = cfg.shares[share]
  if (!s) return null
  if (s.publicBase) return s.publicBase.endsWith('/') ? s.publicBase : `${s.publicBase}/`
  const area = areaOf()
  const answer = area ? loadPresentConfig(area).answerBase : null
  return answer ? `${answer.replace(/\/?$/, '/')}api/shares/${encodeURIComponent(share)}/` : null
}
export const downloadUrl = (r: ShareRef, cfg = loadShareConfig()) => {
  const base = downloadBase(r.share, cfg)
  return base ? `${base}${r.path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}${r.folder && r.path ? '/' : ''}` : null
}

// ---- resolution -------------------------------------------------------------------------------

export type ResolveState = 'ok' | 'unknown-share' | 'unmounted' | 'absent' | 'outside' | 'not-a-folder' | 'not-a-file'
export interface Resolved { state: ResolveState; ref: string; share: string; path: string; abs?: string; detail: string }

// A share's root here, if it is mounted: the marker file names the share. An
// empty mount point (an automount that did not happen, a server that is
// down) has no marker and is reported unmounted, not "an empty folder".
export async function shareRoot(share: string, cfg = loadShareConfig()): Promise<{ root?: string; state: ResolveState; detail: string }> {
  const s = cfg.shares[share]
  if (!s) return { state: 'unknown-share', detail: `share "${share}" is not configured on this host${cfg.file ? ` (${cfg.file})` : ' (no shares.json in the operating area)'}` }
  const root = await realpath(s.root).catch(() => null)
  if (!root) return { state: 'unmounted', detail: `share "${share}" is not reachable on this host: its root does not exist` }
  if (s.marker) {
    const text = await readFile(join(root, s.marker), 'utf8').catch(() => null)
    if (text === null) return { state: 'unmounted', detail: `share "${share}" is not mounted on this host: ${s.marker} is missing at its root` }
    let named: unknown
    try { named = (JSON.parse(text) as { share?: unknown }).share } catch { named = undefined }
    if (named !== share) return { state: 'unmounted', detail: `the folder configured for "${share}" holds another share's marker (${String(named)})` }
  }
  const area = areaOf()
  if (area) {
    const a = await realpath(area).catch(() => area)
    if (a === root || a.startsWith(root + sep) || root.startsWith(a + sep)) return { state: 'outside', detail: `share "${share}" overlaps the operating area; a share is not control data` }
  }
  return { root, state: 'ok', detail: '' }
}

export async function resolveRef(text: string, cfg = loadShareConfig()): Promise<Resolved> {
  const r = parseRef(text)
  if (!r) throw new RequestError(400, `"${text}" is not a shared://<share>/<path> reference`)
  const base = { ref: r.ref, share: r.share, path: r.path }
  const root = await shareRoot(r.share, cfg)
  if (root.state !== 'ok') return { ...base, state: root.state, detail: root.detail }
  const target = r.path ? join(root.root!, ...r.path.split('/')) : root.root!
  const real = await realpath(target).catch(() => null)
  if (!real) return { ...base, state: 'absent', detail: `${r.ref} does not exist` }
  if (real !== root.root && !real.startsWith(root.root! + sep)) return { ...base, state: 'outside', detail: `${r.ref} resolves outside its share` }
  const st = await stat(real)
  if (r.folder && !st.isDirectory()) return { ...base, state: 'not-a-folder', detail: `${r.ref} is not a folder` }
  if (!r.folder && !st.isFile() && !st.isDirectory()) return { ...base, state: 'not-a-file', detail: `${r.ref} is neither a file nor a folder` }
  return { ...base, state: 'ok', abs: real, detail: '' }
}

// ---- locating what a person described (workflow_editor fix1) -------------------------------

// People name shared materials as they think of them — `/agshare/x`,
// `agshare/x`, `x`, this host's mount path — not as references. `locate`
// reads such a text against this host's configured shares, never outside
// their roots, and says which reference it names: one (ok), several
// (ambiguous), none in reachable shares (absent), or none while a share
// it might be in is not reachable (unavailable: absence is not confirmed).
// An exact path is a stat per reading, never a walk; `findInShares` is the
// bounded search for a bare name.
export type LocateState = 'ok' | 'ambiguous' | 'absent' | 'unavailable' | 'unknown-share' | 'outside'
export interface Located { ref: string; share: string; path: string; folder: boolean; abs: string; as: string }
export interface Reading { share: string; path: string; as: string; state: ResolveState; detail: string }
export interface Location { text: string; state: LocateState; matches: Located[]; tried: Reading[]; nearest: string | null; detail: string }

const located = async (share: string, path: string, abs: string, as: string): Promise<Located> => {
  const folder = (await stat(abs)).isDirectory()
  return { ref: formatRef(share, path, folder), share, path, folder, abs, as }
}

export async function locate(text: string, cfg = loadShareConfig()): Promise<Location> {
  const t = text.trim().replace(/[.,;:!?。、]+$/, '').replace(/^["'`<「『]+|["'`>」』]+$/g, '').replace(/[.,;:!?。、]+$/, '')
  const ids = Object.keys(cfg.shares)
  const readings: { share: string; path: string; as: string }[] = []
  const add = (share: string, segs: string[], as: string) => {
    if (!readings.some(r => r.share === share && r.path === segs.join('/'))) readings.push({ share, path: segs.join('/'), as })
  }
  const base = { text, matches: [] as Located[], tried: [] as Reading[], nearest: null }
  if (t.startsWith(SHARE_SCHEME)) {
    const r = parseRef(t)
    if (!r) return { ...base, state: 'outside', detail: `"${t}" is not a valid shared://<share>/<path> reference` }
    if (!cfg.shares[r.share]) return { ...base, state: 'unknown-share', detail: `share "${r.share}" is not configured on this host; configured: ${ids.join(', ') || 'none'}` }
    add(r.share, r.path ? r.path.split('/') : [], 'reference')
  } else {
    if (!ids.length) return { ...base, state: 'unavailable', detail: `no shares are configured on this host${cfg.file ? ` (${cfg.file})` : ''}` }
    const colon = /^([a-z0-9][a-z0-9_-]*):\/?(.*)$/.exec(t)
    const plain = colon && cfg.shares[colon[1]] ? null : t
    if (colon && cfg.shares[colon[1]]) add(colon[1], colon[2].split('/').filter(Boolean), `${colon[1]}: prefix`)
    if (plain !== null) {
      const segs = plain.split('/').filter(s => s !== '' && s !== '.')
      if (segs.includes('..') || plain.includes('\\')) return { ...base, state: 'outside', detail: `"${t}" leaves the folder it names; only paths inside a share are read` }
      // This host's own folder for a share, as configured or as it resolves.
      for (const id of ids) {
        for (const root of new Set([cfg.shares[id].root, await realpath(cfg.shares[id].root).catch(() => cfg.shares[id].root)])) {
          if (plain === root || plain.startsWith(root + '/')) add(id, plain.slice(root.length).split('/').filter(Boolean), `this host's folder for ${id}`)
        }
      }
      // A share named in the path: `/agshare/x`, `agshare/x`, `/mnt/agshare/x`.
      const at = segs.findIndex(s => cfg.shares[s])
      if (at >= 0) add(segs[at], segs.slice(at + 1), at === 0 ? `share named first` : `share named in the path`)
      // The whole path inside each share.
      if (segs.length) for (const id of ids) add(id, segs, `inside ${id}`)
    }
  }
  const matches: Located[] = []
  const tried: Reading[] = []
  for (const r of readings) {
    const res = await resolveRef(formatRef(r.share, r.path, !r.path), cfg)
    tried.push({ share: r.share, path: r.path, as: r.as, state: res.state, detail: res.detail })
    if (res.state === 'ok' && !matches.some(m => m.abs === res.abs)) matches.push(await located(r.share, r.path, res.abs!, r.as))
  }
  if (matches.length === 1) return { text, state: 'ok', matches, tried, nearest: null, detail: '' }
  if (matches.length > 1) return { text, state: 'ambiguous', matches, tried, nearest: null, detail: `${matches.length} items match: ${matches.map(m => m.ref).join(', ')}` }
  // Nothing: the deepest existing folder of the first reading helps the next look.
  let nearest: string | null = null
  const first = readings[0]
  if (first && tried[0]?.state === 'absent') {
    const segs = first.path.split('/')
    for (let n = segs.length - 1; n >= 0 && !nearest; n--) {
      const up = await resolveRef(formatRef(first.share, segs.slice(0, n).join('/'), true), cfg)
      if (up.state === 'ok') nearest = formatRef(first.share, segs.slice(0, n).join('/'), true)
    }
  }
  const down = tried.filter(r => r.state === 'unmounted' || r.state === 'unknown-share')
  if (down.length) return { text, state: 'unavailable', matches, tried, nearest, detail: `not found in the reachable shares, and ${[...new Set(down.map(r => r.share))].join(', ')} cannot be read on this host (${down[0].detail}): absence is not confirmed` }
  if (tried.some(r => r.state === 'outside')) return { text, state: 'outside', matches, tried, nearest, detail: tried.find(r => r.state === 'outside')!.detail }
  return { text, state: 'absent', matches, tried, nearest, detail: `nothing at ${readings.map(r => formatRef(r.share, r.path)).join(' or ')}` }
}

// Searching shares for a name (a file or folder name, or the last segments
// of a path), breadth first so the shallowest come first. Bounded by the
// entries read, the depth and the results; a search that met a bound, an
// unreadable folder or an unreachable share is incomplete, and finding
// nothing then is not absence. Symbolic links are not followed; transport
// metadata is not content. `*` in a segment matches any characters; names
// compare without case.
export interface FindOptions { shares?: string[]; under?: string; maxEntries?: number; maxDepth?: number; limit?: number }
export interface Searched { share: string; under: string; state: ResolveState; entries: number; stopped: 'entries' | 'depth' | 'limit' | null; unreadable: number; detail: string }
export interface Found { name: string; matches: Located[]; complete: boolean; searched: Searched[] }
export const FIND_DEFAULTS = { maxEntries: 50000, maxDepth: 12, limit: 50 }

export async function findInShares(name: string, opts: FindOptions = {}, cfg = loadShareConfig()): Promise<Found> {
  const want = name.trim().split('/').filter(Boolean).map(s => new RegExp(`^${s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i'))
  if (!want.length) throw new RequestError(400, 'find needs a name')
  const maxEntries = opts.maxEntries ?? FIND_DEFAULTS.maxEntries, maxDepth = opts.maxDepth ?? FIND_DEFAULTS.maxDepth, limit = opts.limit ?? FIND_DEFAULTS.limit
  const ids = opts.shares?.length ? opts.shares : Object.keys(cfg.shares)
  const matches: Located[] = []
  const searched: Searched[] = []
  const ends = (segs: string[]) => segs.length >= want.length && want.every((re, i) => re.test(segs[segs.length - want.length + i]))
  for (const id of ids) {
    const under = opts.under ?? ''
    const start = await resolveRef(formatRef(id, under, true), cfg)
    const s: Searched = { share: id, under: formatRef(id, under, true), state: start.state, entries: 0, stopped: null, unreadable: 0, detail: start.detail }
    searched.push(s)
    if (start.state !== 'ok') continue
    const root = (await shareRoot(id, cfg)).root!
    let level: string[] = [under]
    for (let depth = 1; level.length && !s.stopped; depth++) {
      if (depth > maxDepth) { s.stopped = 'depth'; break }
      const next: string[] = []
      for (const rel of level) {
        let entries
        try { entries = await readdir(join(root, ...rel.split('/').filter(Boolean)), { withFileTypes: true }) } catch { s.unreadable++; continue }
        for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
          if (transportMetadata(e.name) || e.isSymbolicLink()) continue
          if (s.entries >= maxEntries) { s.stopped = 'entries'; break }
          s.entries++
          const path = rel ? `${rel}/${e.name}` : e.name
          if (ends(path.split('/'))) {
            if (matches.length >= limit) { s.stopped = 'limit'; break }
            matches.push({ ref: formatRef(id, path, e.isDirectory()), share: id, path, folder: e.isDirectory(), abs: join(root, ...path.split('/')), as: 'found by name' })
          }
          if (e.isDirectory()) next.push(path)
        }
        if (s.stopped) break
      }
      level = next
    }
    if (s.stopped) s.detail = s.stopped === 'entries' ? `stopped after ${maxEntries} entries (--max-entries)` : s.stopped === 'depth' ? `folders below depth ${maxDepth} were not read (--depth)` : `stopped at ${limit} matches (--limit)`
    else if (s.unreadable) s.detail = `${s.unreadable} folder${s.unreadable === 1 ? '' : 's'} could not be read`
    if (s.stopped === 'limit') break
  }
  return { name, matches, complete: searched.every(s => s.state === 'ok' && !s.stopped && !s.unreadable), searched }
}

// ---- files -----------------------------------------------------------------------------------

const MAX_FILES = 20000
// The files a folder holds, relative to it: regular files, including user
// dotfiles. Named transport metadata and OS metadata are not content;
// a symbolic link is refused rather than followed out of the share.
export async function listFiles(abs: string, opts: { max?: number } = {}): Promise<{ path: string; bytes: number }[]> {
  const out: { path: string; bytes: number }[] = []
  const max = opts.max ?? MAX_FILES
  const st = await stat(abs)
  if (st.isFile()) return [{ path: basename(abs), bytes: st.size }]
  const walk = async (rel: string) => {
    for (const e of (await readdir(join(abs, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (transportMetadata(e.name)) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) throw new RequestError(422, `${r} is a symbolic link; a set holds regular files only`, { code: 'set-source' })
      if (e.isDirectory()) { await walk(r); continue }
      if (!e.isFile()) continue
      out.push({ path: r, bytes: (await stat(join(abs, r))).size })
      if (out.length > max) throw new RequestError(422, `more than ${max} files; name a smaller folder`, { code: 'set-source' })
    }
  }
  await walk('')
  return out
}
const fileAt = async (abs: string, rel: string) => ((await stat(abs)).isFile() ? abs : join(abs, ...rel.split('/')))

// sha256 of a file, streamed (inputs and outputs are large).
export async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer)
  return h.digest('hex')
}

// Copies a file and returns the hash of the bytes read; the copy is hashed
// again from disk afterwards and must match (what landed is what was read).
async function copyVerified(src: string, dst: string): Promise<string> {
  await mkdir(dirname(dst), { recursive: true })
  const h = createHash('sha256')
  await pipeline(createReadStream(src), new Transform({ transform(chunk, _enc, cb) { h.update(chunk as Buffer); cb(null, chunk) } }), createWriteStream(dst, { flags: 'wx' }))
  const read = h.digest('hex')
  const landed = await hashFile(dst)
  if (landed !== read) throw new RequestError(422, `${dst}: the copy does not match what was read (${landed.slice(0, 12)} ≠ ${read.slice(0, 12)})`, { code: 'copy-mismatch' })
  return read
}

async function hashAll(abs: string, files: { path: string; bytes: number }[]): Promise<SetFile[]> {
  const out: SetFile[] = []
  for (const f of files) out.push({ path: f.path, bytes: f.bytes, sha256: await hashFile(await fileAt(abs, f.path)) })
  return out
}
const digestOf = (body: unknown) => `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`

// What a set's files are on disk now, compared with a manifest: verified,
// changed (a file differs or is extra) or missing (a file or the folder is
// gone). `quick` compares sizes only (bounded), never reading content.
export async function compareSet(abs: string | null, manifest: SetFile[], opts: { quick?: boolean; extras?: boolean } = {}): Promise<{ status: SetObservation; detail: string }> {
  if (!abs) return { status: 'missing', detail: 'the folder is not reachable' }
  let now: { path: string; bytes: number }[]
  try { now = await listFiles(abs) } catch (e) { return { status: 'missing', detail: (e as Error).message } }
  const have = new Map(now.map(f => [f.path, f.bytes]))
  const missing = manifest.filter(f => !have.has(f.path)).map(f => f.path)
  if (missing.length) return { status: 'missing', detail: `${missing.length} file${missing.length === 1 ? '' : 's'} missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}` }
  const sized = manifest.filter(f => have.get(f.path) !== f.bytes).map(f => f.path)
  const extra = opts.extras === false ? [] : now.filter(f => !manifest.some(m => m.path === f.path)).map(f => f.path)
  if (sized.length || extra.length) return { status: 'changed', detail: [sized.length && `size changed: ${sized.slice(0, 5).join(', ')}`, extra.length && `not in the manifest: ${extra.slice(0, 5).join(', ')}`].filter(Boolean).join('; ') }
  if (opts.quick) return { status: 'verified', detail: `${manifest.length} files, sizes match (content not re-read)` }
  for (const f of manifest) {
    if (await hashFile(await fileAt(abs, f.path)) !== f.sha256) return { status: 'changed', detail: `content changed: ${f.path}` }
  }
  return { status: 'verified', detail: `${manifest.length} files, ${totalBytes(manifest)} bytes, every hash matches` }
}

// Unfinished copies (a publication's .partial-*, an input's .staging-*) are
// named after the host and process that write them. One left by a process
// that died (killed mid-copy: nothing ran its cleanup) is removed by the next
// copy on that host; another host's, or a live process's, is never touched.
const unfinished = (kind: 'partial' | 'staging') => `.${kind}-${hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`
const UNFINISHED = /^\.(partial|staging)-(.+)-(\d+)-[0-9a-f]{8}$/
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
export async function sweepUnfinished(dir: string): Promise<string[]> {
  const removed: string[] = []
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const m = UNFINISHED.exec(name)
    if (!m || m[2] !== hostname() || alive(Number(m[3]))) continue
    await rm(join(dir, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

// ---- input sets ------------------------------------------------------------------------------

export interface InputManifestFile { kind: string; id: string; ref: string; staging: Staging; staged: string | null; digest: string; files: SetFile[] }
export interface OutputManifestFile { kind: string; id: string; ref: string; candidate: string; inputs: string[]; digest: string; files: SetFile[]; run: string; project: string }

const stagedPath = (id: string) => `.local/inputs/${id}`
const lockFile = async (ws: Workspace, ref: RunRef) => join(await inside(ws.root, runFolder(ref)), 'run.json')

// Selects an input set for a running node: reads the reference's files,
// hashes them and stages a verified copy under the run copy's .local/ (or
// keeps them in place) — outside the run's lock, since inputs are large —
// then, under the lock, takes the next id, moves the staged copy into place,
// writes inputs/<id>.json and records input.select. A retransmission (same
// receipt) changes nothing.
export async function selectInput(ws: Workspace, ref: RunRef, o: { node: string; ref: string; staging?: Staging }, ctx: OpContext & { attempt?: string; receipt?: string }): Promise<{ record: RunRecord; input: string; duplicate?: boolean }> {
  ws = await runSpace(ws, ref)
  const dupOf = (record: RunRecord) => {
    const dup = ctx.receipt ? record.history.find(h => h.receipt === ctx.receipt) : undefined
    return dup && dup.op === 'input.select' ? (dup as unknown as { input: string }).input : null
  }
  const before = (await usableRun(ws, ref)).record
  const known = dupOf(before)
  if (known) return { record: before, input: known, duplicate: true }
  if (before.nodes[o.node]?.state !== 'running') throw new RequestError(409, `node "${o.node}" is ${before.nodes[o.node]?.state ?? 'not in the run'}; input is selected from a running node`, { code: 'state' })
  const staging: Staging = o.staging ?? 'copy'
  const resolved = await resolveRef(o.ref)
  if (resolved.state !== 'ok') throw new RequestError(422, `${resolved.ref}: ${resolved.detail}`, { code: `share-${resolved.state}` })
  const listed = await listFiles(resolved.abs!)
  if (!listed.length) throw new RequestError(422, `${resolved.ref} holds no files`, { code: 'set-source' })
  if (staging === 'copy') await sweepUnfinished(await inside(ws.root, '.local/inputs'))
  const tmp = staging === 'copy' ? await inside(ws.root, `.local/inputs/${unfinished('staging')}`) : null
  try {
    let files: SetFile[]
    if (tmp) {
      // One read of the share: each file is hashed as it is copied, and the
      // copy is hashed again from disk.
      files = []
      for (const f of listed) files.push({ path: f.path, bytes: f.bytes, sha256: await copyVerified(await fileAt(resolved.abs!, f.path), join(tmp, ...f.path.split('/'))) })
    } else files = await hashAll(resolved.abs!, listed)
    // The folder must not have changed while it was read.
    const after = await compareSet(resolved.abs!, files, { quick: true, extras: parseRef(resolved.ref)!.folder })
    if (after.status !== 'verified') throw new RequestError(409, `${resolved.ref} changed while it was being read (${after.detail}); select again once the folder is complete`, { code: 'input-changed' })
    const body = inputBody(resolved.ref, files)
    const digest = digestOf(body)
    return await withLock(await lockFile(ws, ref), async () => {
      const { record } = await usableRun(ws, ref)
      const again = dupOf(record)
      if (again) return { record, input: again, duplicate: true }
      const id = `i${Object.keys(record.inputs ?? {}).length + 1}`
      const staged = tmp ? await inside(ws.root, stagedPath(id)) : null
      const rel = `${runFolder(ref)}/inputs/${id}.json`
      try {
        if (staged) { await rm(staged, { recursive: true, force: true }); await rename(tmp!, staged) }
        const manifest: InputManifestFile = { kind: body.kind, id, ref: resolved.ref, staging, staged: staged ? stagedPath(id) : null, digest, files: body.files }
        await mkdir(dirname(await inside(ws.root, rel)), { recursive: true })
        await atomicWrite(await inside(ws.root, rel), `${JSON.stringify(manifest, null, 2)}\n`)
        const input = { op: 'input.select' as const, input: id, node: o.node, ref: resolved.ref, staging, manifest: { file: rel, digest, count: files.length, bytes: totalBytes(files) }, ...(ctx.attempt ? { attempt: ctx.attempt } : {}), ...(ctx.receipt ? { receipt: ctx.receipt } : {}) }
        const r = await runOpLocked(ws, ref, input, ctx)
        return { record: r.record, input: id }
      } catch (e) {
        await rm(await inside(ws.root, rel), { force: true })
        if (staged) await rm(staged, { recursive: true, force: true })
        throw e
      }
    }, { what: `run ${runKey(ref)}` })
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true })
  }
}

async function readManifest<T>(ws: Workspace, rel: string): Promise<T> {
  const text = await readFile(await inside(ws.root, rel), 'utf8').catch(() => null)
  if (text === null) throw new RequestError(409, `${rel} is missing from the run folder`, { code: 'manifest-missing' })
  return JSON.parse(text) as T
}

// Checks an input set's bytes now (the staged copy, or the share for an
// in-place set) and records what was found (input.observe). A changed or
// missing set is recorded as such, never silently re-selected.
export async function verifyInput(ws: Workspace, ref: RunRef, id: string, ctx: OpContext & { quick?: boolean }): Promise<{ record: RunRecord; status: SetObservation; detail: string }> {
  ws = await runSpace(ws, ref)
  const { record } = await usableRun(ws, ref)
  const set = record.inputs?.[id]
  if (!set) throw new RequestError(404, `input set "${id}" does not exist in ${runKey(ref)}`)
  const m = await readManifest<InputManifestFile>(ws, set.file)
  let abs: string | null
  if (m.staging === 'copy') abs = await inside(ws.root, m.staged ?? stagedPath(id)).then(p => stat(p).then(() => p, () => null))
  else { const r = await resolveRef(m.ref); abs = r.state === 'ok' ? r.abs! : null }
  const found = await compareSet(abs, m.files, { quick: ctx.quick, extras: m.staging === 'copy' || parseRef(m.ref)!.folder })
  const detail = abs ? found.detail : `${m.staging === 'copy' ? 'the staged copy' : m.ref} is not reachable on this host`
  const r = await withLock(await lockFile(ws, ref), () => runOpLocked(ws, ref, { op: 'input.observe', input: id, status: found.status, detail }, ctx), { what: `run ${runKey(ref)}` })
  return { record: r.record, status: found.status, detail }
}

// Where an input set's bytes are for the agent on this host.
export async function inputLocation(ws: Workspace, ref: RunRef, id: string): Promise<string | null> {
  ws = await runSpace(ws, ref)
  const { record } = await usableRun(ws, ref)
  const set = record.inputs?.[id]
  if (!set) return null
  if (set.staging === 'copy') return inside(ws.root, stagedPath(id))
  const r = await resolveRef(set.ref)
  return r.state === 'ok' ? r.abs! : null
}

// ---- external outputs ------------------------------------------------------------------------

// Publishes a folder of the run copy as an output of the run, o<n>, at
// shared://<share>/runs/<project>/<wf>/<run>/<o>/. The files are copied into
// an unfinished `.partial-<host>-<pid>-*` folder beside it, each hashed as read and again
// as landed — outside the run's lock, so concurrent candidates copy at once.
// Under the lock the id is taken, the manifest written inside and the folder
// renamed into place, so a reader never sees a partial publication. The run
// folder gets outputs/<o>.json and output.publish is recorded. A folder left
// by a crash between the rename and the record is adopted when it is this
// same publication; one with other content is left alone and the next id is
// used (a clearly distinct publication), never overwritten.
export async function publishOutput(ws: Workspace, ref: RunRef, o: { node: string; source: string; title: string; candidate: string; share: string; inputs?: string[] }, ctx: OpContext & { attempt?: string; receipt?: string }): Promise<{ record: RunRecord; output: string; duplicate?: boolean }> {
  ws = await runSpace(ws, ref)
  const dupOf = (record: RunRecord) => {
    const dup = ctx.receipt ? record.history.find(h => h.receipt === ctx.receipt) : undefined
    return dup && dup.op === 'output.publish' ? (dup as unknown as { output: string }).output : null
  }
  const before = (await usableRun(ws, ref)).record
  const known = dupOf(before)
  if (known) return { record: before, output: known, duplicate: true }
  if (before.nodes[o.node]?.state !== 'running') throw new RequestError(409, `node "${o.node}" is ${before.nodes[o.node]?.state ?? 'not in the run'}; an output is published from a running node`, { code: 'state' })
  const project = await projectId(ws)
  if (!project) throw new RequestError(409, 'project.yaml cannot be read; the publication cannot be named')
  const srcAbs = await inside(ws.root, o.source)
  const sl = await lstat(srcAbs).catch(() => null)
  if (!sl?.isDirectory()) throw new RequestError(422, `${o.source} is not a folder of the run copy`, { code: 'set-source' })
  const listed = await listFiles(srcAbs)
  if (!listed.length) throw new RequestError(422, `${o.source} holds no files`, { code: 'set-source' })
  const inputIds = o.inputs ?? Object.keys(before.inputs ?? {})
  const inputs = inputIds.map(i => { const x = before.inputs?.[i]; if (!x) throw new RequestError(404, `input set "${i}" does not exist in ${runKey(ref)}`); return x.digest }).sort()
  const root = await shareRoot(o.share)
  if (root.state !== 'ok') throw new RequestError(422, root.detail, { code: `share-${root.state}` })
  const parent = join(root.root!, ...outputFolderPath(project, ref.workflow, ref.run, 'x').split('/').slice(0, -1))
  await mkdir(parent, { recursive: true })
  await sweepUnfinished(parent)
  const partial = join(parent, unfinished('partial'))
  try {
    const files: SetFile[] = []
    for (const f of listed) files.push({ path: f.path, bytes: f.bytes, sha256: await copyVerified(join(srcAbs, ...f.path.split('/')), join(partial, ...f.path.split('/'))) })
    const after = await compareSet(srcAbs, files, { quick: true, extras: true })
    if (after.status !== 'verified') throw new RequestError(409, `${o.source} changed while it was being published (${after.detail}); publish again once it is final`, { code: 'output-changed' })
    return await withLock(await lockFile(ws, ref), async () => {
      const { record } = await usableRun(ws, ref)
      const again = dupOf(record)
      if (again) return { record, output: again, duplicate: true }
      for (let n = Object.keys(record.outputs ?? {}).length + 1; ; n++) {
        const id = `o${n}`
        if (record.outputs?.[id]) continue
        const folderRel = outputFolderPath(project, ref.workflow, ref.run, id)
        const outRef = formatRef(o.share, folderRel, true)
        const body = outputBody(outRef, o.candidate, inputs, files)
        const digest = digestOf(body)
        const dest = join(root.root!, ...folderRel.split('/'))
        const existing = await readFile(join(dest, OUTPUT_MANIFEST), 'utf8').then(t => JSON.parse(t) as OutputManifestFile, () => null)
        // A folder there that is not this publication is not ours to touch.
        if (existing?.digest !== digest && await stat(dest).then(() => true, () => false)) continue
        const manifest: OutputManifestFile = { kind: body.kind, id, ref: outRef, candidate: o.candidate, inputs, digest, files: body.files, run: runKey(ref), project }
        if (existing) {
          const check = await compareSet(dest, files, { extras: true })
          if (check.status !== 'verified') throw new RequestError(409, `${outRef} holds this publication's manifest but its files are ${check.status}: ${check.detail}`, { code: 'output-altered' })
        } else {
          await atomicWrite(join(partial, OUTPUT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
          await rename(partial, dest)
        }
        const rel = `${runFolder(ref)}/outputs/${id}.json`
        await mkdir(dirname(await inside(ws.root, rel)), { recursive: true })
        await atomicWrite(await inside(ws.root, rel), `${JSON.stringify(manifest, null, 2)}\n`)
        const input = { op: 'output.publish' as const, output: id, node: o.node, title: o.title, candidate: o.candidate, ref: outRef, manifest: { file: rel, digest, count: files.length, bytes: totalBytes(files), inputs }, ...(ctx.attempt ? { attempt: ctx.attempt } : {}), ...(ctx.receipt ? { receipt: ctx.receipt } : {}) }
        try {
          const r = await runOpLocked(ws, ref, input, ctx)
          return { record: r.record, output: id }
        } catch (e) {
          // Not recorded, so the run folder keeps no manifest for it; the
          // finished folder stays on the share and a retry adopts it.
          await rm(await inside(ws.root, rel), { force: true })
          throw e
        }
      }
    }, { what: `run ${runKey(ref)}` })
  } finally {
    await rm(partial, { recursive: true, force: true }).catch(() => {})
  }
}

// An output's bytes on the share now, against its manifest. `quick`: sizes
// only (what a decision checks; the manifest itself is a hashed subject).
export async function checkOutput(ws: Workspace, record: RunRecord, id: string, opts: { quick?: boolean } = {}): Promise<{ status: SetObservation; detail: string }> {
  const out = record.outputs?.[id]
  if (!out) throw new RequestError(404, `output "${id}" does not exist in this run`)
  const m = await readManifest<OutputManifestFile>(ws, out.file)
  if (m.digest !== out.digest) return { status: 'changed', detail: `${out.file} is not the manifest recorded (${m.digest.slice(0, 19)}… ≠ ${out.digest.slice(0, 19)}…)` }
  const r = await resolveRef(m.ref)
  if (r.state !== 'ok') return { status: 'missing', detail: `${m.ref}: ${r.detail}` }
  return compareSet(r.abs!, m.files, { quick: opts.quick, extras: true })
}

export async function verifyOutput(ws: Workspace, ref: RunRef, id: string, ctx: OpContext & { quick?: boolean }): Promise<{ record: RunRecord; status: SetObservation; detail: string }> {
  ws = await runSpace(ws, ref)
  const { record } = await usableRun(ws, ref)
  const found = await checkOutput(ws, record, id, { quick: ctx.quick })
  const r = await withLock(await lockFile(ws, ref), () => runOpLocked(ws, ref, { op: 'output.observe', output: id, status: found.status, detail: found.detail }, ctx), { what: `run ${runKey(ref)}` })
  return { record: r.record, ...found }
}

// A manifest file (an output's or an input set's, from any run record or
// copied elsewhere) checked against this host's share, without a run: what
// another PC uses to verify a delivery it received only by reference.
export async function verifyManifest(text: string, opts: { quick?: boolean } = {}): Promise<{ ref: string; digest: string; recomputed: string; status: SetObservation; detail: string }> {
  const m = JSON.parse(text) as Partial<OutputManifestFile & InputManifestFile>
  if (typeof m.ref !== 'string' || !Array.isArray(m.files) || typeof m.digest !== 'string') throw new RequestError(400, 'not an input-set or output manifest (ref, files, digest)')
  const recomputed = digestOf(m.kind === inputBody('', []).kind ? inputBody(m.ref, m.files) : outputBody(m.ref, String(m.candidate), m.inputs ?? [], m.files))
  if (recomputed !== m.digest) return { ref: m.ref, digest: m.digest, recomputed, status: 'changed', detail: 'the manifest does not match its own digest' }
  const r = await resolveRef(m.ref)
  if (r.state !== 'ok') return { ref: m.ref, digest: m.digest, recomputed, status: 'missing', detail: `${m.ref}: ${r.detail}` }
  const found = await compareSet(r.abs!, m.files, { quick: opts.quick, extras: m.kind !== inputBody('', []).kind })
  return { ref: m.ref, digest: m.digest, recomputed, ...found }
}

// ---- reading for views ----------------------------------------------------------------------

// Bounded availability for the run view, the CLI and the brief: a stat of
// each reference, no hashing, no listing of large folders.
export interface Availability { ref: string; state: ResolveState; url: string | null }
export async function availability(record: RunRecord): Promise<{ references: Availability[]; inputs: Record<string, Availability>; outputs: Record<string, Availability> }> {
  const cfg = loadShareConfig()
  const one = async (text: string): Promise<Availability> => {
    const r = await resolveRef(text, cfg).catch(() => null)
    const parsed = parseRef(text)
    return { ref: text, state: r?.state ?? 'unknown-share', url: parsed && r?.state === 'ok' ? downloadUrl(parsed, cfg) : null }
  }
  const references = await Promise.all((record.input.references ?? []).map(x => one(x.ref)))
  const inputs = Object.fromEntries(await Promise.all(Object.values(record.inputs ?? {}).map(async i => [i.id, await one(i.ref)] as const)))
  const outputs = Object.fromEntries(await Promise.all(Object.values(record.outputs ?? {}).map(async o => [o.id, await one(o.ref)] as const)))
  return { references, inputs, outputs }
}

// ---- downloads: GET api/shares/<share>/<path> ------------------------------------------------

// Serves one file of a share, streamed with byte ranges, or a folder's
// listing as JSON (bounded). Named transport metadata is hidden; user
// dotfiles are served. Nothing is loaded into memory whole.
export async function serveShare(req: IncomingMessage, res: ServerResponse, share: string, path: string, folder: boolean, inline = false): Promise<void> {
  const ref = formatRef(share, path, folder)
  if (path.split('/').some(transportMetadata)) throw new RequestError(404, 'not found')
  const r = await resolveRef(ref)
  if (r.state !== 'ok') throw new RequestError(r.state === 'unknown-share' ? 404 : r.state === 'absent' ? 404 : 503, r.detail)
  const st = await stat(r.abs!)
  if (st.isDirectory()) {
    const entries = (await readdir(r.abs!, { withFileTypes: true })).filter(e => !transportMetadata(e.name)).sort((a, b) => (a.name < b.name ? -1 : 1)).slice(0, 2000)
    const list = await Promise.all(entries.map(async e => ({ name: e.name, folder: e.isDirectory(), bytes: e.isFile() ? (await stat(join(r.abs!, e.name))).size : null })))
    if (inline) {
      // A page a person can browse (p12): files open in place, with a download beside each.
      const esc = (t: string) => t.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
      const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1073741824).toFixed(2)} GiB`)
      const rows = list.map(e => { const u = encodeURIComponent(e.name); return e.folder
        ? `<tr><td><a href="${u}/?inline=1">${esc(e.name)}/</a></td><td></td><td></td></tr>`
        : `<tr><td><a href="${u}?inline=1">${esc(e.name)}</a></td><td>${size(e.bytes ?? 0)}</td><td><a href="${u}">download</a></td></tr>` }).join('')
      const { shareInlineHeaders } = await import('./boast.ts')
      res.writeHead(200, { ...shareInlineHeaders('index.html'), 'cache-control': 'no-store' })
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(r.ref)}</title><style>body{font:14px system-ui,sans-serif;margin:20px;color:#1f2329}td{padding:4px 14px 4px 0}a{color:#2456c8}code{background:#eef0f3;padding:2px 5px;border-radius:4px}</style><h1 style="font-size:17px"><code>${esc(r.ref)}</code></h1>${path ? '<p><a href="../?inline=1">↑ up</a></p>' : ''}<table>${rows || '<tr><td>(empty)</td></tr>'}</table>`)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ref: r.ref, entries: list }))
    return
  }
  // Display (p12, `?inline=1`): the file's own media type, sandboxed like a
  // Boast page, revalidated on each use. Otherwise a download.
  const { sendStatic } = await import('./staticServe.ts')
  const headers = inline
    ? (await import('./boast.ts')).shareInlineHeaders(r.abs!)
    : { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${basename(r.abs!).replace(/"/g, '')}"`, 'cache-control': 'no-store' }
  await sendStatic(req, res, { file: r.abs!, size: st.size }, headers, `W/"${st.size}-${Math.floor(st.mtimeMs)}"`)
}

export const sharePaths = { staged: stagedPath }
