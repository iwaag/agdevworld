// Reusable findings (improve_workflow p2, docs/knowledge.md): derived reads of
// the documents projects keep in their own study/wedo areas. No registry and
// no stored index: what exists is read from project.yaml, .gitmodules,
// knowledge.yaml and the documents at one commit, through server/access.ts.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join as pathJoin } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { AccessError, host, list, read, run as readRun, runFile, tree, type AccessContext, type FailureState, type FetchInfo, type Provenance, type ReadOptions } from './access.ts'
import { RequestError } from './workspace.ts'
import { git } from './git.ts'
import { loadRegistry } from './registry.ts'
import { parseProject } from './yamlDoc.ts'

export const KNOWLEDGE_SCHEMA = 'ag.wfe-knowledge.v1'
export const REFERENCE_ROLES = ['evidence', 'acceptance', 'illustration', 'context', 'unchecked']
export const CATEGORIES = ['motion', 'extraction', 'generation', 'composition', 'verification', 'process', 'domain']
export const DECISIONS = ['adopted', 'adapted', 'rejected', 'none']
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SHA = /^[0-9a-f]{7,64}$/

export interface CollectionRef {
  id: string // <project>:<area>, or repo:<owner>/<name>: never a checkout path
  kind: 'study' | 'wedo'
  form: 'root-local' | 'shared'
  project?: string
  area?: string
  description?: string
  repository?: string // shared: owner/name
  registered?: boolean
  usedBy: { project: string; path: string }[]
}
export interface FindingReference { role: string; ref: string; by?: string; note?: string }
export interface Finding {
  qid: string
  id: string
  title: string
  summary: string
  categories: string[]
  tags: string[]
  status?: string
  references: FindingReference[]
  metadata: Record<string, unknown>
  collection: string
  kind: CollectionRef['kind']
  repository: string
  commit: string
  path: string // in the repository at that commit
  sha256: string
  body: string
  unpublished: boolean // read from a working tree with uncommitted changes
}
export interface DocumentProblem { path: string; code: 'invalid-header' | 'duplicate-id' | 'too-large'; message: string }
export interface CollectionRead extends CollectionRef {
  state: 'read' | FailureState
  problem?: string
  declaration?: { kind?: string; maintenance?: string; maintainer?: string; supplementer?: string }
  revision?: { repository: string; commit: string; selector: string; resolvedBy: string; pinnedBy?: { repository: string; commit: string }; fetch?: FetchInfo; unpublished?: boolean }
  findings: Finding[]
  unstructured: string[] // documents under findings/ without a metadata header
  problems: DocumentProblem[]
}
export interface KnowledgeOptions { rev?: string; as?: string; current?: string; upstream?: boolean; source?: ReadOptions['source']; workspace?: string }

const areaKind = (path: string): CollectionRef['kind'] | null => path === 'wedo' || path.startsWith('wedo/') ? 'wedo' : path === 'study' || path.startsWith('study/') ? 'study' : null
const join = (a: string, b: string) => (!a || a === '.' ? b : `${a}/${b}`)

export async function collections(ctx: AccessContext): Promise<CollectionRef[]> {
  const l = await list(ctx)
  const out = new Map<string, CollectionRef>()
  for (const r of l.repositories) {
    if (r.category !== 'study' && r.category !== 'wedo') continue
    const id = `repo:${r.fullName}`
    out.set(id, { id, kind: r.category, form: 'shared', repository: r.fullName, registered: true, description: r.description, usedBy: r.usedBy })
  }
  await Promise.all(l.projects.map(async p => {
    for (const u of p.uses) {
      const kind = areaKind(u.path)
      if (!kind || !u.repository) continue
      const id = `repo:${u.repository}`
      const had = out.get(id)
      if (!had) out.set(id, { id, kind, form: 'shared', repository: u.repository, registered: false, usedBy: [{ project: p.id, path: u.path }] })
    }
    const y = await read(ctx, p.id, 'project.yaml').catch(() => null)
    const parsed = y?.text ? parseProject(y.text) : null
    for (const a of parsed?.ok ? parsed.model.areas ?? [] : []) {
      const kind = areaKind(a.path)
      if (kind) out.set(`${p.id}:${a.path}`, { id: `${p.id}:${a.path}`, kind, form: 'root-local', project: p.id, area: a.path, description: a.description, usedBy: [{ project: p.id, path: a.path }] })
    }
  }))
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id))
}

// A collection may be named by its identity or by a project's mount of it.
export async function findCollection(ctx: AccessContext, name: string): Promise<CollectionRef> {
  const all = await collections(ctx)
  const m = /^([^:]+):(.+)$/.exec(name)
  const hit = all.find(c => c.id === name) ?? (m ? all.find(c => c.usedBy.some(u => u.project === m[1] && u.path === m[2])) : undefined)
  if (!hit) throw new AccessError('absent', `no knowledge collection "${name}" (see: wfe knowledge collections). A collection is a declared study/wedo area (<project>:<path>) or a study/wedo repository (repo:<owner>/<name>).`)
  return hit
}

interface Source { target: string; base: string; ro: ReadOptions; resolvedBy: string }
async function sourceOf(ctx: AccessContext, c: CollectionRef, o: KnowledgeOptions): Promise<Source> {
  const worktree = o.source === 'worktree' ? { source: 'worktree' as const, workspace: o.workspace } : {}
  if (c.form === 'root-local') return { target: c.project!, base: c.area!, ro: { rev: o.rev, ...worktree }, resolvedBy: o.rev ? 'the requested revision' : worktree.source ? 'the working tree, on request' : `${c.project}'s default branch` }
  const self = `repo:${c.repository}`
  const reachable = c.registered ? self : null
  const needRepo = (why: string) => { if (!reachable) throw new AccessError('inaccessible', `${c.repository} is not registered, so ${why} cannot be read; it is reached only at a project's pin`); return reachable }
  const mount = (p: string) => c.usedBy.find(u => u.project === p)
  if (o.rev) return { target: needRepo('that revision'), base: '', ro: { rev: o.rev }, resolvedBy: 'the requested revision' }
  if (o.as && !mount(o.as)) throw new AccessError('absent', `${o.as} does not use ${c.id}, so it has no adopted revision of it (used by: ${c.usedBy.map(u => u.project).join(', ') || 'none'})`)
  const pinOf = (p: string, why: string): Source => ({ target: p, base: mount(p)!.path, ro: worktree, resolvedBy: why })
  if (worktree.source) { const p = o.as ?? o.current; if (!p || !mount(p)) throw new RequestError(400, `reading ${c.id} from a working tree needs --as <project> naming a project that mounts it`); return pinOf(p, `${p}'s working tree, on request`) }
  if (o.upstream) return { target: needRepo('its upstream tip'), base: '', ro: {}, resolvedBy: 'the upstream tip, on request' }
  if (o.as) return pinOf(o.as, `the revision ${o.as} pins`)
  if (o.current && mount(o.current)) return pinOf(o.current, `the revision ${o.current} (this project) pins`)
  const declared = reachable ? await read(ctx, reachable, 'knowledge.yaml').then(r => yamlObject(r.text ?? '').maintainer).catch(() => undefined) : undefined
  if (typeof declared === 'string' && mount(declared)) return pinOf(declared, `the revision its maintainer ${declared} pins`)
  if (c.usedBy.length === 1) return pinOf(c.usedBy[0].project, `the revision its only user ${c.usedBy[0].project} pins`)
  if (c.usedBy.length && !reachable) return pinOf(c.usedBy[0].project, `the revision ${c.usedBy[0].project} pins`)
  return { target: needRepo('its upstream tip'), base: '', ro: {}, resolvedBy: c.usedBy.length ? 'the upstream tip: several projects use it and none is its declared maintainer; name one with --as' : 'the upstream tip: no project uses it' }
}

function yamlObject(text: string): Record<string, unknown> {
  try { const v = parseYaml(text); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {} } catch { return {} }
}
const repoPath = (p: Provenance) => p.repository.path === '.' ? p.path : p.path === p.repository.path ? '' : p.path.slice(p.repository.path.length + 1)

// The header, or why it cannot be used. `null`: no header at all.
export function parseFindingDocument(text: string): { meta: Record<string, unknown>; body: string; errors: string[] } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return null
  let meta: unknown
  // Every scalar a string: an id 0001 or an all-digit sha is not a number.
  try { meta = parseYaml(m[1], { schema: 'failsafe' }) } catch (e) { return { meta: {}, body: text.slice(m[0].length), errors: [`the header is not YAML: ${(e as Error).message.split('\n')[0]}`] } }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { meta: {}, body: text.slice(m[0].length), errors: ['the header is not a mapping'] }
  const h = meta as Record<string, unknown>
  const errors: string[] = []
  if (typeof h.id !== 'string') errors.push('id is required')
  else if (!ID.test(String(h.id))) errors.push(`id "${h.id}" is not letters, digits, ".", "_" or "-"`)
  for (const k of ['title', 'summary']) if (typeof h[k] !== 'string' || !(h[k] as string).trim()) errors.push(`${k} is required`)
  const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string')
  if (!strings(h.categories) || !(h.categories as string[]).length) errors.push('categories is a non-empty list')
  if (h.tags !== undefined && !strings(h.tags)) errors.push('tags is a list')
  if (!Array.isArray(h.references) || !h.references.length) errors.push('references is a non-empty list')
  else (h.references as unknown[]).forEach((r, i) => {
    const o = r as Record<string, unknown> | null
    if (!o || typeof o !== 'object' || typeof o.ref !== 'string' || typeof o.role !== 'string') errors.push(`references[${i}] needs role and ref`)
  })
  return { meta: h, body: text.slice(m[0].length), errors }
}

export async function readCollection(ctx: AccessContext, c: CollectionRef, o: KnowledgeOptions = {}): Promise<CollectionRead> {
  const out: CollectionRead = { ...c, state: 'read', findings: [], unstructured: [], problems: [] }
  try {
    const src = await sourceOf(ctx, c, o)
    const top = await tree(ctx, src.target, src.base || '.', { ...src.ro, depth: 1, max: 1 })
    const prov = top.provenance
    const dirty = prov.source === 'worktree' && !!prov.workspace?.dirty
    out.revision = { repository: prov.repository.fullName, commit: prov.revision.commit, selector: prov.revision.selector, resolvedBy: src.resolvedBy, ...(prov.revision.pinnedBy ? { pinnedBy: prov.revision.pinnedBy } : {}), ...(prov.fetch ? { fetch: prov.fetch } : {}), ...(dirty ? { unpublished: true } : {}) }
    // Every further read is of that one commit, whatever is pushed meanwhile.
    const ro: ReadOptions = src.ro.source === 'worktree' ? src.ro : { rev: prov.revision.pinnedBy?.commit ?? prov.revision.commit }
    const decl = await read(ctx, src.target, join(src.base, 'knowledge.yaml'), ro).catch(() => null)
    if (decl?.text) {
      const d = yamlObject(decl.text)
      const s = (k: string) => (typeof d[k] === 'string' ? { [k]: d[k] as string } : {})
      out.declaration = { ...s('kind'), ...s('maintenance'), ...s('maintainer'), ...s('supplementer') }
      if (d.kind === 'study' || d.kind === 'wedo') out.kind = d.kind
    }
    const docs = await tree(ctx, src.target, join(src.base, 'findings'), { ...ro, depth: 8, max: 5000 }).catch(e => { if (e instanceof AccessError && e.state === 'absent') return null; throw e })
    const byId = new Map<string, string[]>()
    for (const e of docs?.entries ?? []) {
      if (e.type !== 'file' || !e.path.endsWith('.md')) continue
      const r = await read(ctx, src.target, e.path, { ...ro, maxBytes: 4 * 1024 * 1024 })
      const at = repoPath(r.provenance)
      if (r.truncated || r.text === undefined) { out.problems.push({ path: at, code: 'too-large', message: 'the document is binary or over 4 MiB' }); continue }
      const doc = parseFindingDocument(r.text)
      if (!doc) { out.unstructured.push(at); continue }
      if (doc.errors.length) { out.problems.push({ path: at, code: 'invalid-header', message: doc.errors.join('; ') }); continue }
      const id = String(doc.meta.id)
      byId.set(id, [...(byId.get(id) ?? []), at])
      const refs = doc.meta.references as FindingReference[]
      out.findings.push({
        qid: `${c.id}#${id}`, id, title: doc.meta.title as string, summary: doc.meta.summary as string, categories: doc.meta.categories as string[], tags: (doc.meta.tags as string[] | undefined) ?? [],
        ...(typeof doc.meta.status === 'string' ? { status: doc.meta.status } : {}), references: refs, metadata: doc.meta,
        collection: c.id, kind: out.kind, repository: prov.repository.fullName, commit: prov.revision.commit, path: at, sha256: r.sha256, body: doc.body, unpublished: dirty,
      })
    }
    for (const [id, paths] of byId) if (paths.length > 1) out.problems.push({ path: paths.join(', '), code: 'duplicate-id', message: `the id "${id}" is used by ${paths.length} documents of ${c.id}; give each its own id and keep the id of the one earlier references mean` })
    out.findings.sort((a, b) => a.id.localeCompare(b.id))
  } catch (e) {
    if (!(e instanceof AccessError)) throw e
    out.state = e.state
    out.problem = e.message
  }
  return out
}

export interface ListFilter extends KnowledgeOptions { collection?: string; project?: string; category?: string[]; tag?: string[]; text?: string }
export interface KnowledgeList {
  schema: typeof KNOWLEDGE_SCHEMA
  findings: Omit<Finding, 'body' | 'metadata'>[]
  collections: Omit<CollectionRead, 'findings'>[]
  counts: Record<string, number>
  gitea?: string // base URL, for links to a document at its commit
}
export async function listFindings(ctx: AccessContext, f: ListFilter = {}): Promise<KnowledgeList> {
  const all = f.collection ? [await findCollection(ctx, f.collection)] : await collections(ctx)
  const chosen = f.project ? all.filter(c => c.usedBy.some(u => u.project === f.project)) : all
  const reads = await Promise.all(chosen.map(c => readCollection(ctx, c, { ...f, as: f.project ?? f.as })))
  const words = f.text?.toLowerCase()
  const pass = (x: Finding) => (f.category ?? []).every(k => x.categories.includes(k)) && (f.tag ?? []).every(k => x.tags.includes(k))
    && (!words || `${x.title}\n${x.summary}`.toLowerCase().includes(words))
  const findings = reads.flatMap(r => r.findings).filter(pass).map(({ body: _b, metadata: _m, ...rest }) => rest)
  const counts: Record<string, number> = Object.fromEntries(reads.map(r => [r.id, r.findings.length]))
  return { schema: KNOWLEDGE_SCHEMA, findings, collections: reads.map(({ findings: _f, ...rest }) => rest), counts, ...(ctx.gitea ? { gitea: host(ctx).url } : {}) }
}

export function splitQualified(q: string): { collection: string; id: string } {
  const i = q.lastIndexOf('#')
  if (i < 1 || i === q.length - 1) throw new RequestError(400, `"${q}" is not a qualified finding id: <collection>#<id>, e.g. gimmickimg:wedo#gimmickimg-f-0001`)
  return { collection: q.slice(0, i), id: q.slice(i + 1) }
}

export type ReferenceState = 'resolved' | 'missing' | 'unchecked'
export interface ResolvedReference extends FindingReference { state: ReferenceState; reason?: string; target?: string; path?: string; rev?: string; view?: string }

const rawUrl = (target: string, path: string, rev?: string) => `api/projects/${encodeURIComponent(target)}/raw?path=${encodeURIComponent(path)}${rev ? `&rev=${rev}` : ''}`

async function resolveReference(ctx: AccessContext, r: FindingReference, base: { target: string; ro: ReadOptions; project?: string }): Promise<ResolvedReference> {
  const unchecked = (reason: string) => ({ ...r, state: 'unchecked' as const, reason })
  const ref = r.ref.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return unchecked(ref.startsWith('shared://') ? 'on a shared area; WFE did not read it' : 'external; WFE did not fetch it')
  const reg = await loadRegistry(ctx.registryFile)
  let target = base.target
  let ro = base.ro
  let path = ref
  const named = /^([A-Za-z0-9_-]+|repo:[^/\s]+\/[^/\s@:]+)(?:@([0-9a-f]{6,64}))?:([^\s]+)$/.exec(ref)
  const runRef = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/(run-\d+)$/.exec(ref)
  if (runRef && reg.projects.some(p => p.id === runRef[1])) {
    return readRun(ctx, runRef[1], `${runRef[2]}/${runRef[3]}`).then(() => ({ ...r, state: 'resolved' as const, target: runRef[1], path: `${runRef[2]}/${runRef[3]}` })).catch((e: unknown) => {
      if (e instanceof AccessError && e.state !== 'absent') return unchecked(`${e.state}: ${e.message}`)
      if (e instanceof AccessError) return { ...r, state: 'missing' as const, reason: e.message }
      throw e
    })
  }
  if (named) {
    const repo = reg.repositories.find(x => x.gitea.name === named[1])
    target = reg.projects.some(p => p.id === named[1]) || named[1].startsWith('repo:') ? named[1] : repo ? `repo:${repo.gitea.owner}/${repo.gitea.name}` : ''
    if (!target) return unchecked(`"${named[1]}" names no registered project or repository`)
    ro = named[2] ? { rev: named[2] } : {}
    path = named[3]
  } else if (/\s/.test(ref) || ref.startsWith('/')) return unchecked('not a path or a run: WFE cannot check it')
  path = path.replace(/\/+$/, '')
  try {
    const t = await tree(ctx, target, path, { ...ro, depth: 1, max: 1 })
    const isFile = t.entries.length === 1 && t.entries[0].path === t.provenance.path && t.entries[0].type === 'file'
    const rev = ro.rev && ro.source !== 'worktree' ? ro.rev : undefined
    const seen = { ...r, target, path, ...(rev ? { rev } : {}), ...(isFile && ro.source !== 'worktree' ? { view: rawUrl(target, path, rev) } : {}) }
    // The author's own "unchecked" stands even when the thing exists: existence is not what they could not check.
    return r.role === 'unchecked' ? { ...seen, state: 'unchecked', reason: 'marked unchecked by the author; the path exists' } : { ...seen, state: 'resolved' }
  } catch (e) {
    if (!(e instanceof AccessError)) { if (e instanceof RequestError) return unchecked(e.message); throw e }
    if (e.state === 'absent') return r.role === 'unchecked' ? unchecked(`marked unchecked by the author; ${e.message}`) : { ...r, state: 'missing', reason: e.message, target, path }
    return unchecked(`${e.state}: ${e.message}`)
  }
}

const rootOf = (c: CollectionRead, f: Finding, o: KnowledgeOptions): { target: string; ro: ReadOptions } => {
  if (o.source === 'worktree') {
    const p = c.form === 'root-local' ? c.project! : o.as ?? o.current
    return { target: p!, ro: { source: 'worktree', workspace: o.workspace } }
  }
  return c.form === 'root-local' ? { target: c.project!, ro: { rev: f.commit } } : { target: `repo:${c.repository}`, ro: { rev: f.commit } }
}

export interface FindingDetail { schema: typeof KNOWLEDGE_SCHEMA; finding: Omit<Finding, 'references'> & { references: ResolvedReference[] }; revision: NonNullable<CollectionRead['revision']>; declaration?: CollectionRead['declaration']; document?: string }

async function locateFinding(ctx: AccessContext, q: string, o: KnowledgeOptions): Promise<{ c: CollectionRead; f: Finding }> {
  const { collection, id } = splitQualified(q)
  const ref = await findCollection(ctx, collection)
  const c = await readCollection(ctx, ref, o)
  if (c.state !== 'read') throw new AccessError(c.state, `${ref.id} cannot be read: ${c.problem}`)
  const at = `${c.revision!.repository}@${c.revision!.commit.slice(0, 10)}`
  const dup = c.problems.find(p => p.code === 'duplicate-id' && p.message.includes(`"${id}"`))
  if (dup) throw new RequestError(409, `${ref.id}#${id} is ambiguous at ${at}: ${dup.path}. ${dup.message}`, { state: 'duplicate-id', paths: dup.path.split(', ') })
  const f = c.findings.find(x => x.id === id)
  if (!f) throw new AccessError('absent', `${ref.id} has no finding "${id}" at ${at} (${c.findings.length} there${c.findings.length ? `: ${c.findings.map(x => x.id).join(', ')}` : ''}${c.problems.length ? `; ${c.problems.length} document(s) could not be read: ${c.problems.map(p => p.path).join(', ')}` : ''})`)
  return { c, f }
}

export async function showFinding(ctx: AccessContext, q: string, o: KnowledgeOptions = {}): Promise<FindingDetail> {
  const { c, f } = await locateFinding(ctx, q, o)
  const root = rootOf(c, f, o)
  const refs: ResolvedReference[] = []
  for (const r of f.references) refs.push(await resolveReference(ctx, r, root))
  return { schema: KNOWLEDGE_SCHEMA, finding: { ...f, references: refs }, revision: c.revision!, ...(c.declaration ? { declaration: c.declaration } : {}) }
}

export interface CheckItem { path?: string; severity: 'error' | 'warning'; code: string; message: string }
export interface CollectionCheck { collection: string; state: CollectionRead['state']; revision?: CollectionRead['revision']; findings: number; unstructured: number; items: CheckItem[]; references: { resolved: number; missing: number; unchecked: number } }

// Readable metadata, unique identity and resolvable references. Never the truth of a claim.
export async function checkCollection(ctx: AccessContext, name: string, o: KnowledgeOptions = {}): Promise<CollectionCheck> {
  const c = await readCollection(ctx, await findCollection(ctx, name), o)
  const items: CheckItem[] = c.problems.map(p => ({ path: p.path, severity: 'error', code: p.code, message: p.message }))
  const references = { resolved: 0, missing: 0, unchecked: 0 }
  if (c.state !== 'read') items.push({ severity: 'error', code: c.state, message: c.problem ?? c.state })
  if (c.state === 'read' && !c.declaration) items.push({ severity: 'warning', code: 'no-declaration', message: 'no knowledge.yaml at the collection root: who maintains it is unknown' })
  for (const f of c.findings) {
    const root = rootOf(c, f, o)
    for (const k of f.categories) if (!CATEGORIES.includes(k)) items.push({ path: f.path, severity: 'warning', code: 'unknown-category', message: `category "${k}" is not one of ${CATEGORIES.join(', ')}` })
    if (!f.references.some(r => r.role === 'evidence')) items.push({ path: f.path, severity: 'warning', code: 'no-evidence', message: 'no reference has the role evidence' })
    for (const r of f.references) {
      if (!REFERENCE_ROLES.includes(r.role)) items.push({ path: f.path, severity: 'warning', code: 'unknown-role', message: `reference role "${r.role}" is not one of ${REFERENCE_ROLES.join(', ')}` })
      const stray = Object.keys(r).filter(k => !['role', 'ref', 'by', 'note'].includes(k))
      if (stray.length) items.push({ path: f.path, severity: 'warning', code: 'unknown-reference-field', message: `${r.ref}: unexpected ${stray.map(k => `"${k}"`).join(', ')}; a comma in an unquoted flow value ends the value, so quote it` })
      const s = await resolveReference(ctx, r, root)
      references[s.state]++
      if (s.state === 'missing') items.push({ path: f.path, severity: 'error', code: 'missing-reference', message: `${r.ref}: ${s.reason}` })
    }
  }
  return { collection: c.id, state: c.state, ...(c.revision ? { revision: c.revision } : {}), findings: c.findings.length, unstructured: c.unstructured.length, items, references }
}

// The documents of a folder as they stand, before anything is committed or
// pushed: a run's own copy, which no read through project access can see (both
// first authors could only say "check again after integration").
export async function checkFolder(dir: string): Promise<{ dir: string; findings: number; unstructured: number; items: CheckItem[]; references: { resolved: number; missing: number; unchecked: number } }> {
  if (!(await stat(dir).then(x => x.isDirectory(), () => false))) throw new AccessError('absent', `${dir} is not a folder on this host`)
  const root = (await git(dir, ['rev-parse', '--show-toplevel'])).stdout.trim() || dir
  const out = { dir, findings: 0, unstructured: 0, items: [] as CheckItem[], references: { resolved: 0, missing: 0, unchecked: 0 } }
  const docs = (await readdir(pathJoin(dir, 'findings'), { recursive: true }).catch(() => [] as string[])).filter(n => n.endsWith('.md')).sort()
  const ids = new Map<string, string[]>()
  for (const name of docs) {
    const doc = parseFindingDocument(await readFile(pathJoin(dir, 'findings', name), 'utf8'))
    const at = `findings/${name}`
    if (!doc) { out.unstructured++; continue }
    if (doc.errors.length) { out.items.push({ path: at, severity: 'error', code: 'invalid-header', message: doc.errors.join('; ') }); continue }
    out.findings++
    ids.set(String(doc.meta.id), [...(ids.get(String(doc.meta.id)) ?? []), at])
    for (const k of doc.meta.categories as string[]) if (!CATEGORIES.includes(k)) out.items.push({ path: at, severity: 'warning', code: 'unknown-category', message: `category "${k}" is not one of ${CATEGORIES.join(', ')}` })
    for (const r of doc.meta.references as FindingReference[]) {
      if (!REFERENCE_ROLES.includes(r.role)) out.items.push({ path: at, severity: 'warning', code: 'unknown-role', message: `reference role "${r.role}" is not one of ${REFERENCE_ROLES.join(', ')}` })
      const stray = Object.keys(r).filter(k => !['role', 'ref', 'by', 'note'].includes(k))
      if (stray.length) out.items.push({ path: at, severity: 'warning', code: 'unknown-reference-field', message: `${r.ref}: unexpected ${stray.map(k => `"${k}"`).join(', ')}; a comma in an unquoted flow value ends the value, so quote it` })
      if (/\s|^[^/]*:/.test(r.ref.trim()) || r.ref.startsWith('/') || r.role === 'unchecked') { out.references.unchecked++; continue }
      if (await stat(pathJoin(root, r.ref)).then(() => true, () => false)) out.references.resolved++
      else { out.references.missing++; out.items.push({ path: at, severity: 'error', code: 'missing-reference', message: `${r.ref}: not in this repository's working tree` }) }
    }
  }
  for (const [id, paths] of ids) if (paths.length > 1) out.items.push({ path: paths.join(', '), severity: 'error', code: 'duplicate-id', message: `the id "${id}" is used by ${paths.length} documents; give each its own id` })
  return out
}

// The block a run puts in its report (docs/knowledge.md, Recording a decision).
export async function citation(ctx: AccessContext, qs: string | string[], o: KnowledgeOptions = {}, decision?: string): Promise<{ block: string; entries: Record<string, unknown>[] }> {
  if (decision !== undefined && !DECISIONS.includes(decision)) throw new RequestError(400, `--decision is ${DECISIONS.join(', ')}`)
  const entries: Record<string, unknown>[] = []
  for (const q of Array.isArray(qs) ? qs : [qs]) {
    const { f } = await locateFinding(ctx, q, o)
    entries.push({
      finding: f.qid, title: f.title, repository: f.repository, commit: f.commit, path: f.path, sha256: f.sha256,
      ...(f.unpublished ? { unpublished: true, preserved: '<a copy of the document in this run folder>' } : {}),
      decision: decision ?? '<adopted|adapted|rejected>', reason: '<why, under this task\'s conditions>', work: ['<what was actually made: commit or path>'], verification: ['<how the outcome was checked: path>'],
    })
  }
  return { entries, block: `\`\`\`knowledge-decisions\n${stringifyYaml(entries).trimEnd()}\n\`\`\`` }
}

export interface DecisionView {
  finding: string
  decision: string
  reason?: string
  state: 'resolved' | 'different' | 'missing' | 'unpublished' | 'unchecked' | 'none' | 'invalid'
  detail?: string
  recorded?: { repository?: string; commit?: string; path?: string; sha256?: string; title?: string }
  atRevision?: { title: string; path: string; sha256: string; summary: string }
  current?: { commit: string; path: string; sha256: string; title: string; changed: boolean } | { problem: string }
  work: { ref: string; state: 'found' | 'missing' | 'unchecked' }[]
  verification: { ref: string; state: 'found' | 'missing' | 'unchecked' }[]
  entry: Record<string, unknown>
}
export interface DecisionsResult { schema: typeof KNOWLEDGE_SCHEMA; run: string; files: string[]; decisions: DecisionView[]; problems: string[] }

// What a run says it did with a finding, set beside what that recorded revision
// actually holds. It is the agent's claim; nothing here verifies the outcome.
export async function runDecisions(ctx: AccessContext, project: string, text: string): Promise<DecisionsResult> {
  const out: DecisionsResult = { schema: KNOWLEDGE_SCHEMA, run: `${project}/${text}`, files: [], decisions: [], problems: [] }
  const fileOf = async (path: string) => runFile(ctx, project, text, path).catch(() => runFile(ctx, project, text, path, { published: true }))
  for (const name of ['report.md', 'outcome.md']) {
    const r = await fileOf(name).catch(() => null)
    if (!r?.text) continue
    let any = false
    for (const m of r.text.matchAll(/```knowledge-decisions[ \t]*\r?\n([\s\S]*?)```/g)) {
      any = true
      let parsed: unknown
      try { parsed = parseYaml(m[1], { schema: 'failsafe' }) } catch (e) { out.problems.push(`${name}: a knowledge-decisions block is not YAML: ${(e as Error).message.split('\n')[0]}`); continue }
      if (!Array.isArray(parsed)) { out.problems.push(`${name}: a knowledge-decisions block is not a list`); continue }
      for (const e of parsed) out.decisions.push(await decisionView(ctx, project, e as Record<string, unknown>, fileOf))
    }
    if (any) out.files.push(name)
  }
  return out
}

async function decisionView(ctx: AccessContext, project: string, e: Record<string, unknown>, fileOf: (p: string) => Promise<{ sha256: string }>): Promise<DecisionView> {
  const list = (k: string) => (Array.isArray(e[k]) ? e[k] as unknown[] : e[k] === undefined ? [] : [e[k]]).map(String)
  const located = async (ref: string): Promise<{ ref: string; state: 'found' | 'missing' | 'unchecked' }> => {
    if (/\s/.test(ref) || /^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return { ref, state: 'unchecked' }
    if (await fileOf(ref).then(() => true, () => false)) return { ref, state: 'found' }
    if (/^[0-9a-f]{7,64}$/.test(ref)) return { ref, state: await tree(ctx, project, '.', { rev: ref, depth: 1, max: 1 }).then(() => 'found' as const, () => 'unchecked' as const) }
    return { ref, state: await tree(ctx, project, ref.replace(/\/+$/, ''), { depth: 1, max: 1 }).then(() => 'found' as const, (er: unknown) => er instanceof AccessError && er.state === 'absent' ? 'missing' as const : 'unchecked' as const) }
  }
  const finding = String(e.finding ?? '')
  const decision = String(e.decision ?? '')
  const base = { finding, decision, ...(e.reason !== undefined ? { reason: String(e.reason) } : {}), recorded: { ...(typeof e.repository === 'string' ? { repository: e.repository } : {}), ...(typeof e.commit === 'string' ? { commit: e.commit } : {}), ...(typeof e.path === 'string' ? { path: e.path } : {}), ...(typeof e.sha256 === 'string' ? { sha256: e.sha256 } : {}), ...(typeof e.title === 'string' ? { title: e.title } : {}) }, work: await Promise.all(list('work').map(located)), verification: await Promise.all(list('verification').map(located)), entry: e }
  if (!DECISIONS.includes(decision)) return { ...base, state: 'invalid', detail: `decision is ${DECISIONS.join(', ')}` }
  if (decision === 'none' || !finding || finding === 'none') return { ...base, state: 'none' }
  let q: { collection: string; id: string }
  try { q = splitQualified(finding) } catch (er) { return { ...base, state: 'invalid', detail: (er as Error).message } }
  if (e.unpublished === 'true') {
    const preserved = typeof e.preserved === 'string' ? await fileOf(e.preserved).catch(() => null) : null
    if (!preserved) return { ...base, state: 'unpublished', detail: 'read from unpublished bytes; no preserved copy found in the run folder' }
    return { ...base, state: 'unpublished', detail: preserved.sha256 === e.sha256 ? `read from unpublished bytes; the preserved copy matches the recorded sha256` : `read from unpublished bytes; the preserved copy has sha256 ${preserved.sha256}, not the recorded one` }
  }
  if (typeof e.commit !== 'string' || !SHA.test(e.commit)) return { ...base, state: 'invalid', detail: 'no commit recorded, so the basis cannot be read back' }
  const qid = `${q.collection}#${q.id}`
  try {
    const at = await locateFinding(ctx, qid, { rev: e.commit })
    const v: DecisionView = { ...base, state: 'resolved', atRevision: { title: at.f.title, path: at.f.path, sha256: at.f.sha256, summary: at.f.summary } }
    if (typeof e.sha256 === 'string' && e.sha256 !== at.f.sha256) { v.state = 'different'; v.detail = `the document at ${e.commit.slice(0, 10)} has sha256 ${at.f.sha256}, not the recorded ${e.sha256}` }
    else if (typeof e.path === 'string' && e.path !== at.f.path) { v.state = 'different'; v.detail = `the finding is at ${at.f.path} in that revision, not the recorded ${e.path}` }
    v.current = await locateFinding(ctx, qid, { current: project }).then(cur => ({ commit: cur.f.commit, path: cur.f.path, sha256: cur.f.sha256, title: cur.f.title, changed: cur.f.sha256 !== at.f.sha256 }), er => ({ problem: (er as Error).message }))
    return v
  } catch (er) {
    if (er instanceof AccessError && er.state === 'absent') return { ...base, state: 'missing', detail: er.message }
    if (er instanceof AccessError) return { ...base, state: 'unchecked', detail: `${er.state}: ${er.message}` }
    if (er instanceof RequestError) return { ...base, state: 'invalid', detail: er.message }
    throw er
  }
}
