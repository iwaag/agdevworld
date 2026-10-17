// Boast (workflow_editor p12, docs/boast.md): a project's own showcase page,
// `boast/index.html` in its root, shown in the Project Editor. WFE supplies
// the space and the serving; the content is the project's.
//
// Published content is the project's committed `main`, read through the
// project access caches (access.ts). The state route resolves the commit once;
// the page and every relative asset are then served from that same commit
// (`api/boast/<project>/c/<commit>/…`), so a page never mixes revisions. A
// workspace's working tree is served only when asked for, under a different
// path (`api/boast/<project>/w/<workspace>/…`), so preview and published
// content are never confused.
//
// Every response is confined to `boast/`: traversal is refused, a Git symlink
// is followed only while it stays inside, and a working-tree path is checked
// through realpath. Every response carries a CSP `sandbox` without
// `allow-same-origin`, so the page runs in an opaque origin whether it is
// embedded or opened alone: it cannot reach the editor's DOM, and its requests
// to the editor's write API carry `Origin: null`, which the service refuses.
import { spawn } from 'node:child_process'
import { lstat, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { hostname } from 'node:os'
import { join, posix, sep } from 'node:path'
import { normalizeRepoPath } from '../shared/model.ts'
import { AccessError, ignored, locate, locateWorktree, type AccessContext, type Provenance } from './access.ts'
import { git } from './git.ts'
import { RequestError } from './workspace.ts'
import { sendStatic, typeOf } from './staticServe.ts'

export const BOAST_SCHEMA = 'ag.wfe-boast.v1'
export const BOAST_DIR = 'boast'
export const BOAST_ENTRY = 'index.html'

// What a Boast page may do, for the iframe's `sandbox` attribute and the
// response header alike (the browser applies both). Never allow-same-origin.
export const SANDBOX = ['allow-scripts', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-downloads', 'allow-forms', 'allow-modals', 'allow-pointer-lock']
export const CONTENT_HEADERS: Record<string, string> = {
  'content-security-policy': `sandbox ${SANDBOX.join(' ')}`,
  'x-content-type-options': 'nosniff',
  // Module scripts and fetch() from the opaque origin are CORS requests.
  'access-control-allow-origin': '*',
}

export interface BoastState {
  schema: typeof BOAST_SCHEMA
  project: string
  source: 'committed' | 'worktree'
  state: 'present' | 'absent'
  commit: string // the project root commit (committed) or the workspace HEAD (worktree)
  entry: string | null // service-relative URL of the page, when present
  provenance: Provenance
  workspace?: { id: string; head: string | null; branch: string | null; dirty: boolean }
  detail?: string
}

const isCommit = (s: string) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s)
const enc = (s: string) => encodeURIComponent(s)

// A request path below boast/, normalized; null for the folder itself.
function inner(rel: string): string | null {
  if (rel === '' || rel === '.') return null
  const n = normalizeRepoPath(rel)
  if (!n || n === '.' || rel.split('/').includes('..')) throw new RequestError(400, `"${rel}" is not a path inside ${BOAST_DIR}/`)
  if (n.split('/').some(p => p === '.git')) throw new AccessError('inaccessible', `${n} is never content`)
  return n
}

// ---- state ------------------------------------------------------------------

export async function boastState(ctx: AccessContext, project: string, opts: { source?: 'committed' | 'worktree'; workspace?: string } = {}): Promise<BoastState> {
  const entryPath = `${BOAST_DIR}/${BOAST_ENTRY}`
  if (opts.source === 'worktree') {
    const w = await locateWorktree(ctx, project, entryPath, opts.workspace)
    const prov: Provenance = { schema: 'ag.wfe-access.v1', project, source: 'worktree', repository: { key: null, fullName: 'project root', path: '.', category: 'root', registered: false, defaultBranch: w.branch ?? '' }, revision: { selector: 'worktree', commit: w.head ?? '' }, path: entryPath, observed: new Date().toISOString(), workspace: { id: w.ws.reg.id, dirty: w.dirty } }
    if (w.uninitialized) throw new AccessError('uninitialized', `${w.uninitialized} is not checked out in workspace ${w.ws.reg.id}`, { provenance: prov })
    const st = await lstat(join(w.repoRoot, w.inner)).catch(() => null)
    const dirty = (await git(w.repoRoot, ['status', '--porcelain=v1', '--', BOAST_DIR])).stdout.trim() !== ''
    const present = !!st && (st.isFile() || st.isSymbolicLink()) && !(await ignored(w.repoRoot, w.inner))
    return {
      schema: BOAST_SCHEMA, project, source: 'worktree', state: present ? 'present' : 'absent', commit: w.head ?? '',
      entry: present ? `api/boast/${enc(project)}/w/${enc(w.ws.reg.id)}/` : null, provenance: { ...prov, workspace: { id: w.ws.reg.id, dirty } },
      workspace: { id: w.ws.reg.id, head: w.head ?? null, branch: w.branch ?? null, dirty },
      ...(present ? {} : { detail: `${entryPath} is not in workspace ${w.ws.reg.id}'s working tree` }),
    }
  }
  const root = await locate(ctx, project, '.')
  const commit = root.revision.commit
  rootDirs.set(`${project}@${commit}`, root.dir)
  const prov: Provenance = { schema: 'ag.wfe-access.v1', project, source: 'committed', repository: root.repository, revision: root.revision, path: entryPath, observed: new Date().toISOString(), fetch: root.fetch }
  const hit = await findCommitted(ctx, project, commit, BOAST_ENTRY).catch(e => { if (e instanceof AccessError && e.state === 'absent') return null; throw e })
  const present = !!hit && hit.kind === 'blob'
  return {
    schema: BOAST_SCHEMA, project, source: 'committed', state: present ? 'present' : 'absent', commit,
    entry: present ? `api/boast/${enc(project)}/c/${commit}/` : null, provenance: prov,
    ...(present ? {} : { detail: `${entryPath} is not in ${root.repository.fullName}@${commit.slice(0, 10)}` }),
  }
}

// ---- committed content ----------------------------------------------------------

// Root caches by project and commit: a commit-addressed asset needs no fetch
// once its commit is known to be in the cache.
const rootDirs = new Map<string, string>()
async function rootDir(ctx: AccessContext, project: string, commit: string): Promise<string> {
  const key = `${project}@${commit}`
  const known = rootDirs.get(key)
  if (known) return known
  // A commit not yet in the cache is fetched for, whatever the cache's age.
  const l = await locate(ctx, project, '.', { rev: commit }).catch(e => {
    if (e instanceof AccessError && e.state === 'absent' && !ctx.refresh) return locate({ ...ctx, refresh: true }, project, '.', { rev: commit })
    throw e
  })
  if (rootDirs.size > 500) rootDirs.clear()
  rootDirs.set(key, l.dir)
  return l.dir
}

type Found = { kind: 'blob'; dir: string; oid: string; size: number; path: string } | { kind: 'tree'; path: string }

// The object at boast/<rel> of the commit: symbolic links are followed while
// they stay inside boast/; a submodule inside boast/ is read at its pin.
async function findCommitted(ctx: AccessContext, project: string, commit: string, rel: string | null): Promise<Found> {
  let path = rel === null ? BOAST_DIR : `${BOAST_DIR}/${rel}`
  const dir = await rootDir(ctx, project, commit)
  for (let hop = 0; hop < 8; hop++) {
    const r = await git(dir, ['ls-tree', '-l', '-z', commit, '--', path])
    const line = r.stdout.split('\0').find(Boolean)
    if (!line) {
      // Possibly inside a submodule below boast/.
      const l = await locate(ctx, project, path, { rev: commit }).catch(() => null)
      if (l && l.chain.length && l.inner) {
        const t = await git(l.dir, ['ls-tree', '-l', '-z', l.commit, '--', l.inner])
        const one = t.stdout.split('\0').find(Boolean)
        if (one) {
          const [mode, type, oid, size] = one.slice(0, one.indexOf('\t')).split(/\s+/)
          if (type === 'tree') return { kind: 'tree', path }
          if (type === 'blob' && mode !== '120000') return { kind: 'blob', dir: l.dir, oid, size: Number(size), path }
        }
      }
      throw new AccessError('absent', `${path} does not exist at ${commit.slice(0, 10)}`)
    }
    const [mode, type, oid, size] = line.slice(0, line.indexOf('\t')).split(/\s+/)
    if (type === 'tree') return { kind: 'tree', path }
    if (type === 'commit') return { kind: 'tree', path } // a submodule folder
    if (mode !== '120000') return { kind: 'blob', dir, oid, size: Number(size), path }
    const target = (await git(dir, ['cat-file', 'blob', oid])).stdout
    const next = posix.normalize(posix.join(posix.dirname(path), target))
    if (posix.isAbsolute(target) || !(next === BOAST_DIR || next.startsWith(`${BOAST_DIR}/`))) throw new AccessError('inaccessible', `${path} is a symbolic link leaving ${BOAST_DIR}/`)
    path = next
  }
  throw new AccessError('inaccessible', `${rel} has too many symbolic links`)
}

function gitStream(dir: string, oid: string, res: ServerResponse) {
  const p = spawn('git', ['cat-file', 'blob', oid], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
  res.once('close', () => { if (p.exitCode === null) p.kill() })
  return p.stdout
}

// GET api/boast/<project>/c/<commit>/<path>: immutable, revalidation by blob id.
export async function serveCommitted(req: IncomingMessage, res: ServerResponse, ctx: AccessContext, project: string, commit: string, rel: string, slash: boolean): Promise<void> {
  if (!isCommit(commit)) throw new RequestError(400, 'a Boast revision is a full commit id (resolve it with GET api/boast/<project>)')
  const want = inner(rel)
  let found = await findCommitted(ctx, project, commit, want)
  if (found.kind === 'tree') {
    if (!slash) return redirectToFolder(res, want === null ? commit : want.split('/').at(-1)!)
    found = await findCommitted(ctx, project, commit, want === null ? BOAST_ENTRY : `${want}/${BOAST_ENTRY}`)
    if (found.kind !== 'blob') throw new AccessError('absent', `${found.path} is not a file`)
  }
  const blob = found
  await sendStatic(req, res, { open: () => gitStream(blob.dir, blob.oid, res), size: blob.size },
    { ...CONTENT_HEADERS, 'content-type': typeOf(blob.path), 'cache-control': 'public, max-age=31536000, immutable' }, `"${blob.oid}"`)
}

function redirectToFolder(res: ServerResponse, last: string) {
  res.writeHead(301, { location: `${enc(last)}/`, 'cache-control': 'no-store' })
  res.end()
}

// ---- working tree preview -------------------------------------------------------

// GET api/boast/<project>/w/<workspace>/<path>: the working tree as it is now,
// revalidated on every use. Ignored files are not shown (they are never published).
export async function serveWorktree(req: IncomingMessage, res: ServerResponse, ctx: AccessContext, project: string, workspace: string, rel: string, slash: boolean): Promise<void> {
  const want = inner(rel)
  const w = await locateWorktree(ctx, project, want === null ? BOAST_DIR : `${BOAST_DIR}/${want}`, workspace)
  if (w.uninitialized) throw new AccessError('uninitialized', `${w.uninitialized} is not checked out in workspace ${w.ws.reg.id}`)
  const realRoot = await realpath(join(w.root, BOAST_DIR)).catch(() => null)
  if (!realRoot) throw new AccessError('absent', `${BOAST_DIR}/ is not in workspace ${w.ws.reg.id}`)
  let abs = await realpath(join(w.repoRoot, w.inner)).catch(() => null)
  if (!abs) throw new AccessError('absent', `${BOAST_DIR}/${want ?? ''} is not in workspace ${w.ws.reg.id}`)
  const within = (p: string) => p === realRoot || p.startsWith(realRoot + sep)
  if (!within(abs)) throw new AccessError('inaccessible', `${BOAST_DIR}/${want} resolves outside ${BOAST_DIR}/`)
  let st = await stat(abs)
  if (st.isDirectory()) {
    if (!slash) return redirectToFolder(res, want === null ? workspace : want.split('/').at(-1)!)
    abs = await realpath(join(abs, BOAST_ENTRY)).catch(() => '')
    if (!abs || !within(abs)) throw new AccessError('absent', `${BOAST_DIR}/${want ? `${want}/` : ''}${BOAST_ENTRY} is not in workspace ${w.ws.reg.id}`)
    st = await stat(abs)
  }
  if (!st.isFile()) throw new AccessError('absent', `${BOAST_DIR}/${want} is not a file`)
  const relToRepo = abs.slice((await realpath(w.repoRoot)).length + 1)
  if (await ignored(w.repoRoot, relToRepo)) throw new AccessError('absent', `${relToRepo} is ignored by Git in workspace ${w.ws.reg.id}; ignored files are never published, so the preview does not show them`)
  await sendStatic(req, res, { file: abs, size: st.size },
    { ...CONTENT_HEADERS, 'content-type': typeOf(abs), 'cache-control': 'no-cache' }, `W/"${st.size}-${Math.floor(st.mtimeMs)}"`)
}

// ---- shared-area references ------------------------------------------------------

export interface SharedResolution {
  ref: string
  state: string
  detail: string
  url: string | null // service-relative display URL (inline, ranges)
  download: string | null // service-relative download URL
  host: string // the host whose share configuration resolved it
  path: string | null // where that host has it
  folder: boolean
}

// What a `shared://` reference is on this host, for a Boast page's display
// and copy helpers (GET api/share-ref?ref=…).
export async function resolveShared(ref: string): Promise<SharedResolution> {
  const { resolveRef } = await import('./shares.ts')
  if (!ref.startsWith('shared://')) throw new RequestError(400, 'a shared reference starts with shared://')
  const r = await resolveRef(ref)
  const folder = ref.endsWith('/')
  const rel = `${enc(r.share ?? '')}/${(r.path ?? '').split('/').filter(Boolean).map(enc).join('/')}${folder && r.path ? '/' : ''}`
  const ok = r.state === 'ok'
  return {
    ref: r.ref ?? ref, state: r.state, detail: r.detail, folder,
    url: ok && !folder ? `api/shares/${rel}?inline=1` : null,
    download: ok ? `api/shares/${rel}` : null,
    host: hostname(), path: ok ? r.abs ?? null : null,
  }
}

// Inline display of a share's file: an HTML document there runs sandboxed
// like a Boast page.
export const shareInlineHeaders = (path: string): Record<string, string> => ({
  ...CONTENT_HEADERS, 'content-type': typeOf(path), 'content-disposition': 'inline', 'cache-control': 'no-cache',
})
