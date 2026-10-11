// The operating boundary (workflow_editor p4/ex1): what the supported
// management and execution operations never register, execute or import.
//
// The editor is agdevworld system code, not a project of the catalog it
// manages. So no workspace may be registered on, created in, or executed
// in a protected path, and no retired repository may come back as a
// project, a shared repository, a submodule or a workspace. The checks live
// here, in the shared operations the CLI and the service both call, not in
// display filters; a registry edit alone does not make a protected path
// executable, because request, claim and every workspace resolution check
// again.
//
// Protected paths:
// - implicit: the code this process runs (its package directory), and the
//   area's control data: registry.json, gitea.json, system.json, service/,
//   bin/ and .local/ (execution store, Gitea cache) beside the registry and
//   in the area;
// - configured: system.json beside the registry,
//     {"protectedPaths": [{"path": "<abs or relative to system.json>", "why": "…"}],
//      "retiredRepositories": [{"gitea": <id>, "owner": "…", "name": "…", "why": "…"}]}
//   System configuration, outside every managed project; no workflow or
//   project file can change it. A malformed file refuses every checked
//   operation rather than being read as empty.
//
// Paths are compared after resolving symbolic links (for a path that does
// not exist yet, of its nearest existing ancestor), and overlap either way
// is refused: a path inside a protected one, and a path that contains one
// (an ancestor directory).
//
// A retired repository is identified by its Gitea id where an operation
// knows it, and otherwise (a URL, a clone's origin) by its configured
// owner/name on Gitea.
//
// These checks protect the supported operations. They are not an OS
// sandbox: an agent with shell access under the same account can still
// reach these files.
import { readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { git } from './git.ts'
import { PACKAGE_DIR } from './version.ts'
import { RequestError } from './workspace.ts'

export interface ProtectedPath { path: string; why: string }
export interface RetiredRepository { gitea: number; owner: string; name: string; why: string }
export interface Boundary { file: string; configured: boolean; protectedPaths: ProtectedPath[]; retired: RetiredRepository[] }

export const SYSTEM_FILE = 'system.json'

export class BoundaryError extends RequestError {
  constructor(message: string, detail?: unknown) { super(403, message, detail) }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// The real path of `p`; for a path that does not exist, the real path of its
// nearest existing ancestor joined with the rest.
export async function realish(p: string): Promise<string> {
  const abs = resolve(p)
  try { return await realpath(abs) } catch {
    const parent = dirname(abs)
    if (parent === abs) return abs
    return join(await realish(parent), basename(abs))
  }
}

const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep)

export async function loadBoundary(registryFile: string, area?: string): Promise<Boundary> {
  const reg = resolve(registryFile)
  const dir = dirname(reg)
  const file = join(dir, SYSTEM_FILE)
  const control = (base: string) => ['service', 'bin', '.local'].map(d => ({ path: join(base, d), why: 'control data of the operating area' }))
  const protectedPaths: ProtectedPath[] = [
    { path: PACKAGE_DIR, why: 'the workflow editor code this process runs' },
    { path: reg, why: 'the registry' },
    { path: join(dir, 'gitea.json'), why: 'the Gitea setting' },
    { path: file, why: 'the operating boundary' },
    ...control(dir),
    ...(area && resolve(area) !== dir ? control(resolve(area)) : []),
  ]
  const retired: RetiredRepository[] = []
  let text: string | null = null
  try { text = await readFile(file, 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new BoundaryError(`${file} cannot be read (${(e as Error).message}); protected operations are refused until it is fixed`)
  }
  if (text !== null) {
    let raw: unknown
    try { raw = JSON.parse(text) } catch (e) { throw new BoundaryError(`${file} is not valid JSON (${(e as Error).message}); protected operations are refused until it is fixed`) }
    const bad = (what: string) => new BoundaryError(`${file}: ${what}; protected operations are refused until it is fixed`)
    if (!isObj(raw)) throw bad('must be an object')
    const paths = raw.protectedPaths ?? []
    const repos = raw.retiredRepositories ?? []
    if (!Array.isArray(paths) || !Array.isArray(repos)) throw bad('protectedPaths and retiredRepositories must be lists')
    for (const [i, p] of paths.entries()) {
      if (!isObj(p) || typeof p.path !== 'string' || !p.path) throw bad(`protectedPaths[${i}] needs a "path"`)
      protectedPaths.push({ path: isAbsolute(p.path) ? p.path : resolve(dir, p.path), why: typeof p.why === 'string' ? p.why : 'configured system path' })
    }
    for (const [i, r] of repos.entries()) {
      if (!isObj(r) || typeof r.gitea !== 'number' || typeof r.owner !== 'string' || typeof r.name !== 'string') throw bad(`retiredRepositories[${i}] needs gitea (id), owner and name`)
      retired.push({ gitea: r.gitea, owner: r.owner, name: r.name, why: typeof r.why === 'string' ? r.why : 'retired from this catalog' })
    }
  }
  for (const p of protectedPaths) p.path = await realish(p.path)
  return { file, configured: text !== null, protectedPaths, retired }
}

// The protected path that `path` overlaps (inside it, or containing it), if any.
export async function protectedOverlap(b: Boundary, path: string): Promise<ProtectedPath | null> {
  const real = await realish(path)
  for (const p of b.protectedPaths) if (within(real, p.path) || within(p.path, real)) return p
  return null
}

export async function assertNotProtected(b: Boundary, path: string, what: string): Promise<void> {
  const hit = await protectedOverlap(b, path)
  if (!hit) return
  const real = await realish(path)
  const how = real === hit.path ? 'is' : within(real, hit.path) ? 'is inside' : 'contains'
  throw new BoundaryError(`${what} refused: ${real} ${how} ${hit.path} (${hit.why}). System code, releases and control data are never a project, workspace or run target.`, { path: real, protected: hit.path, why: hit.why })
}

export function retiredById(b: Boundary, giteaId: number): RetiredRepository | undefined {
  return b.retired.find(r => r.gitea === giteaId)
}
export function retiredByName(b: Boundary, owner: string | null, name: string): RetiredRepository | undefined {
  const n = name.replace(/\.git$/, '').toLowerCase()
  return b.retired.find(r => r.name.toLowerCase() === n && (owner === null || r.owner.toLowerCase() === owner.toLowerCase()))
}
// A clone or submodule location: <…>/<owner>/<name>(.git), or a relative
// ../<name>.git (owner unknown here, so any owner's same-named retired
// repository counts).
export function retiredByUrl(b: Boundary, url: string): RetiredRepository | undefined {
  const parts = url.trim().replace(/\/+$/, '').replace(/^[a-z+]+:\/\/[^/]+\//i, '').replace(/^[^@/]+@[^:]+:/, '').split('/').filter(s => s && s !== '.')
  const name = parts.at(-1)
  if (!name) return undefined
  const owner = parts.length >= 2 && parts.at(-2) !== '..' ? parts.at(-2)! : null
  return retiredByName(b, owner, name)
}

export function assertNotRetired(r: RetiredRepository | undefined, what: string): void {
  if (!r) return
  throw new BoundaryError(`${what} refused: ${r.owner}/${r.name} (Gitea id ${r.gitea}) is retired from this catalog (${r.why}). It is not restored as a project, shared repository, submodule or workspace.`, { retired: r })
}

// A registered workspace may be used (resolved, requested, claimed) only
// when it overlaps no protected path and its origin is not a retired
// repository. Checked at every resolution, so an edited registry gains nothing.
export async function assertWorkspaceAllowed(b: Boundary, ws: { id: string; path: string }, what: string): Promise<void> {
  await assertNotProtected(b, ws.path, `${what} (workspace "${ws.id}")`)
  const origin = await git(ws.path, ['remote', 'get-url', 'origin'])
  if (origin.code === 0) assertNotRetired(retiredByUrl(b, origin.stdout.trim()), `${what} (workspace "${ws.id}")`)
}
