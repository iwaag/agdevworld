// Durable drafts of workflow definitions, and applying them (workflow_editor
// p20, docs/drafts.md). A draft lives in service-managed storage, not in any
// checkout: its own file under <area>/.local/wfe-drafts/, with the published
// bytes it began from, its saved bytes and every saved revision. Saving changes
// nothing ordinary runs read.
//
// Applying publishes one saved revision to the project's default branch without
// a working tree: objects are written in the access cache of the repository that
// holds the definitions, a temporary index builds the tree (so only this file,
// and the pin in submodule mode, ever change) and the commit is pushed without
// force on top of the head it was built on: a head that moved refuses it. The
// journal names each commit before it can reach the remote, so a retry after a
// timeout, a lost response or a restart finds what was pushed instead of
// publishing again. Applied is said only after the resolver ordinary requests
// use reads the intended definition back.
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DefinitionDescriptor, WorkflowResponse } from '../shared/api.ts'
import type { ApplyJournal, ApplyOutcome, ApplyResult, Comparison, DraftConflict, DraftMeta, DraftRecord, DraftResponse, MergeSegment, Provenance } from '../shared/drafts.ts'
import { approvalStates } from '../shared/canonical.ts'
import type { ApprovalKind, Documentation, Issue, Workflow } from '../shared/model.ts'
import { hasErrors, validateWorkflow } from '../shared/validate.ts'
import { host, invalidate, locate, type AccessContext } from './access.ts'
import { git, gitOk } from './git.ts'
import { withLock } from './lock.ts'
import { DESCRIPTOR_SCHEMA, digestOf, publishedDescriptor, publishedWorkspace, type PublishedWorkspace } from './published.ts'
import type { Registration } from './registry.ts'
import { RequestError, WORKFLOW_FILE, WORKFLOWS_DIR } from './workspace.ts'
import { parseWorkflow, renderWorkflow } from './yamlDoc.ts'

export const DRAFT_SCHEMA = 'ag.wfe-draft.v1' as const
export type { ApplyResult, DraftRecord } from '../shared/drafts.ts'
const KEPT_REVISIONS = 200
const PUBLISH_TRIES = 4
// An apply this long without a journal entry and not finished lost its process.
const APPLY_SILENT_MS = 5 * 60_000

const nowIso = () => new Date().toISOString()
const ID = /^d-[0-9a-f]{12}$/

export class DraftStore {
  readonly dir: string
  constructor(area: string) { this.dir = join(area, '.local', 'wfe-drafts') }
  private path(id: string) {
    if (!ID.test(id)) throw new RequestError(400, `"${id}" is not a draft id`)
    return join(this.dir, `${id}.json`)
  }
  async read(id: string): Promise<DraftRecord> {
    const text = await readFile(this.path(id), 'utf8').catch(() => null)
    if (text === null) throw new RequestError(404, `no draft ${id}`, { code: 'draft-missing' })
    return JSON.parse(text) as DraftRecord
  }
  // Durable before it returns: written, synced, renamed over the old file.
  private async write(d: DraftRecord) {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.path(d.id)}.${randomBytes(4).toString('hex')}.tmp`
    const h = await open(tmp, 'w')
    try { await h.writeFile(`${JSON.stringify(d, null, 2)}\n`); await h.sync() } finally { await h.close() }
    await rename(tmp, this.path(d.id))
  }
  async create(d: DraftRecord) { await this.write(d); return d }
  async update(id: string, f: (d: DraftRecord) => void | Promise<void>): Promise<DraftRecord> {
    return withLock(this.path(id), async () => {
      const d = await this.read(id)
      await f(d)
      await this.write(d)
      return d
    }, { what: `draft ${id}` })
  }
  async list(o: { project?: string; file?: string; states?: DraftRecord['state'][] } = {}): Promise<DraftRecord[]> {
    const names = await readdir(this.dir).catch(() => [] as string[])
    const out: DraftRecord[] = []
    for (const n of names.filter(x => x.endsWith('.json'))) {
      const d = await this.read(n.slice(0, -5)).catch(() => null)
      if (d && (!o.project || d.project === o.project) && (!o.file || d.file === o.file) && (o.states ?? ['open']).includes(d.state)) out.push(d)
    }
    return out.sort((a, b) => (a.updated < b.updated ? 1 : -1))
  }
  applyLock(project: string) { return join(this.dir, `apply-${project}`) }
}

// The in-progress journal of a process that is gone reads as what it is.
function liveJournal(j: ApplyJournal | null): ApplyJournal | null {
  if (j?.outcome === 'in-progress' && Date.now() - Date.parse(j.updated) > APPLY_SILENT_MS) return { ...j, outcome: 'uncertain', error: j.error ?? 'the apply stopped without finishing; applying again finds what reached the project' }
  return j
}
export function draftMeta(d: DraftRecord): DraftMeta {
  const { text: _t, revisions: _r, base, apply, ...rest } = d
  return { ...rest, base: { sha256: base.sha256, source: base.source }, apply: liveJournal(apply) }
}

function descriptorOf(d: DraftRecord, s: PublishedWorkspace['source'] | null): DefinitionDescriptor {
  return {
    schema: DESCRIPTOR_SCHEMA, kind: 'draft', project: d.project, workflow: d.workflow, file: d.file,
    definition: null, root: s ? { repository: s.repository, branch: s.branch, commit: s.commit } : null,
    digest: d.sha256, ...(s ? { fetch: s.fetch } : {}), draft: { id: d.id, revision: d.revision },
  }
}

function newRecord(reg: Registration, o: { file: string; workflow: string | null; by: string; text: string; base: DraftRecord['base']; provenance: Provenance }): DraftRecord {
  if (!o.by.trim()) throw new RequestError(400, 'by is required: the name of who edits')
  const at = nowIso(), sha256 = digestOf(o.text)
  return {
    schema: DRAFT_SCHEMA, id: `d-${randomBytes(6).toString('hex')}`, project: reg.project!, workspace: reg.id, workflow: o.workflow, file: o.file,
    author: o.by.trim(), created: at, updated: at, updatedBy: o.by.trim(), state: 'open', revision: 1, text: o.text, sha256,
    base: o.base, provenance: o.provenance, revisions: [{ revision: 1, sha256, text: o.text, at, by: o.by.trim() }], apply: null,
  }
}

// ---- starting ------------------------------------------------------------------------

// A new draft of a published definition: freshly resolved, never a checkout.
// Existing drafts are offered, not silently competed with.
export async function startDraft(ctx: AccessContext, store: DraftStore, reg: Registration, o: { file: string; by: string; another?: boolean }): Promise<DraftRecord> {
  if (!WORKFLOW_FILE.test(o.file)) throw new RequestError(400, `invalid workflow file name "${o.file}"`)
  const open = await store.list({ project: reg.project!, file: o.file })
  if (open.length && !o.another) throw new RequestError(409, `${o.file} already has ${open.length === 1 ? 'a draft' : `${open.length} drafts`}: resume one, or start another explicitly`, { code: 'draft-exists', drafts: open.map(draftMeta) })
  const pub = await publishedWorkspace(ctx, reg, { fresh: true })
  const read = await pub.readWorkflowFile(o.file)
  if (read.text === null) throw new RequestError(404, `${o.file} is not published at ${pub.source.commit.slice(0, 10)}`, { code: 'not-published' })
  return store.create(newRecord(reg, {
    file: o.file, workflow: read.workflow?.id ?? null, by: o.by, text: read.text,
    base: { text: read.text, sha256: digestOf(read.text), source: publishedDescriptor(pub.source, o.file, read.workflow?.id ?? null, read.text) },
    provenance: { kind: 'published' },
  }))
}

// A workflow that does not exist yet: its draft has no base.
export async function newWorkflowDraft(ctx: AccessContext, store: DraftStore, reg: Registration, o: { id: string; name: string; documentation?: string | Documentation; template?: string; by: string }): Promise<DraftRecord> {
  const pub = await publishedWorkspace(ctx, reg, { fresh: true })
  const made = await pub.newWorkflow(o.id, o.name, o.documentation, o.template ?? 'empty')
  const taken = (await store.list({ project: reg.project!, file: made.file }))[0]
  if (taken) throw new RequestError(409, `a draft of ${made.file} already exists, by ${taken.author}: resume it`, { field: 'id', code: 'draft-exists', drafts: [draftMeta(taken)] })
  return store.create(newRecord(reg, { file: made.file, workflow: o.id, by: o.by, text: made.text, base: { text: null, sha256: null, source: null }, provenance: { kind: 'new', template: o.template ?? 'empty' } }))
}

// ---- reading and saving --------------------------------------------------------------

export async function readDraft(ctx: AccessContext, store: DraftStore, reg: Registration, id: string): Promise<DraftResponse> {
  const d = await store.read(id)
  if (d.project !== reg.project) throw new RequestError(404, `draft ${id} is of project ${d.project}`)
  const parsed = parseWorkflow(d.text)
  const bare = { workspace: reg.id, project: d.project, file: d.file, rev: d.sha256, text: d.text, workflow: parsed.ok ? parsed.model : undefined, problem: parsed.ok ? undefined : parsed.problem }
  try {
    const pub = await publishedWorkspace(ctx, reg, { discovery: true })
    const resp = await pub.overlaid(d.file, d.text).workflowResponse(d.file)
    const here = await pub.readWorkflowFile(d.file)
    const latestSha = here.text === null ? null : digestOf(here.text)
    const renamedTo = here.text === null && d.workflow ? (await pub.workflowSummaries()).list.find(s => s.id === d.workflow)?.file : undefined
    return { ...resp, draft: draftMeta(d), descriptor: descriptorOf(d, pub.source), source: pub.source, latest: { sha256: latestSha, changed: latestSha !== d.base.sha256, deleted: here.text === null && d.base.text !== null, ...(renamedTo ? { renamedTo } : {}) }, baseText: d.base.text }
  } catch (e) {
    const none: Pick<WorkflowResponse, 'issues' | 'repositories' | 'workflows'> = { issues: [], repositories: [], workflows: [] }
    return { ...bare, ...none, draft: draftMeta(d), descriptor: descriptorOf(d, null), source: null, sourceProblem: (e as Error).message, latest: null, baseText: d.base.text }
  }
}

function revisionOf(d: DraftRecord, revision: unknown) {
  if (d.state !== 'open') throw new RequestError(409, `draft ${d.id} is ${d.state}`, { code: `draft-${d.state}`, draft: draftMeta(d) })
  if (revision !== d.revision) throw new RequestError(409, `draft ${d.id} was saved as revision ${d.revision} by ${d.updatedBy} since you read revision ${String(revision)}; nothing was overwritten`, { code: 'draft-revision-conflict', revision: d.revision, by: d.updatedBy })
}

function record(d: DraftRecord, text: string, by: string) {
  const at = nowIso()
  d.revision += 1; d.text = text; d.sha256 = digestOf(text); d.updated = at; d.updatedBy = by
  d.revisions.push({ revision: d.revision, sha256: d.sha256, text, at, by })
  if (d.revisions.length > KEPT_REVISIONS) d.revisions.splice(0, d.revisions.length - KEPT_REVISIONS)
  const p = parseWorkflow(text)
  if (p.ok && p.model.id) d.workflow = p.model.id
}

// A save names the revision it was made from. `workflow` keeps the draft's own
// YAML formatting; `text` is the bytes as given, readable or not: the person can
// repair a malformed definition here.
export async function saveDraft(store: DraftStore, id: string, o: { revision: number; by: string; workflow?: Workflow; text?: string }): Promise<DraftRecord> {
  if (!o.by?.trim()) throw new RequestError(400, 'by is required: the name of who saves')
  return store.update(id, d => {
    revisionOf(d, o.revision)
    let text = o.text
    if (o.workflow) {
      const parsed = parseWorkflow(d.text)
      if (!parsed.ok) throw new RequestError(409, `the draft's text cannot be read (${parsed.problem.message}); repair the text first`, parsed.problem)
      text = renderWorkflow(parsed.doc, o.workflow)
    }
    if (typeof text !== 'string') throw new RequestError(400, 'a save carries workflow or text')
    if (!text.trim()) throw new RequestError(400, 'an empty definition is not saved; discard the draft to drop it')
    if (text !== d.text) record(d, text, o.by.trim())
  })
}

export async function discardDraft(store: DraftStore, id: string, o: { revision: number; by: string }): Promise<DraftRecord> {
  if (!o.by?.trim()) throw new RequestError(400, 'by is required: the name of who discards')
  return store.update(id, d => {
    revisionOf(d, o.revision)
    d.state = 'discarded'; d.discarded = { by: o.by.trim(), at: nowIso() }; d.updated = d.discarded.at; d.updatedBy = o.by.trim()
  })
}

// An approval is a record inside the definition (contract.md): here, a saved revision of the draft.
export async function approveDraft(ctx: AccessContext, store: DraftStore, reg: Registration, id: string, o: { revision: number; kind: ApprovalKind; approver: string }): Promise<DraftRecord> {
  if (!o.approver?.trim()) throw new RequestError(400, 'an approver name is required')
  const pub = await publishedWorkspace(ctx, reg, { discovery: true })
  return store.update(id, async d => {
    revisionOf(d, o.revision)
    const parsed = parseWorkflow(d.text)
    if (!parsed.ok) throw new RequestError(409, `the draft cannot be approved: ${parsed.problem.message}`)
    const view = pub.overlaid(d.file, d.text)
    const issues = validateWorkflow(parsed.model, await view.validationContext(d.file, await view.repositories()))
    if (o.kind === 'intent' && issues.some(i => i.code === 'intent-missing')) throw new RequestError(409, 'the intent is empty')
    if (o.kind === 'definition' && hasErrors(issues)) throw new RequestError(409, 'the saved definition has validation errors', issues.filter(i => i.severity === 'error'))
    const states = await approvalStates(parsed.model)
    const next = structuredClone(parsed.model)
    next.approvals[o.kind] = { digest: states[o.kind].digest, approver: o.approver.trim(), at: nowIso() }
    record(d, renderWorkflow(parsed.doc, next), o.approver.trim())
  })
}

// ---- comparing with what is published ------------------------------------------------

const MARK = 16

async function mergeTexts(mine: string, base: string, latest: string): Promise<{ clean: boolean; text: string; segments: MergeSegment[] }> {
  const tmp = await mkdtemp(join(tmpdir(), 'wfe-merge-'))
  try {
    const [a, b, c] = ['mine', 'base', 'latest'].map(n => join(tmp, n))
    await writeFile(a!, mine); await writeFile(b!, base); await writeFile(c!, latest)
    const r = await git(tmp, ['merge-file', '-p', '--diff3', `--marker-size=${MARK}`, '-L', 'mine', '-L', 'base', '-L', 'latest', a!, b!, c!])
    if (r.code < 0 || r.code > 127) throw new Error(`merging failed: ${r.stderr.trim()}`)
    return r.code === 0 ? { clean: true, text: r.stdout, segments: [r.stdout] } : { clean: false, text: r.stdout, segments: segmentsOf(r.stdout) }
  } finally { await rm(tmp, { recursive: true, force: true }) }
}

function segmentsOf(out: string): MergeSegment[] {
  const m = (c: string) => c.repeat(MARK)
  const segments: MergeSegment[] = []
  let plain = '', cur: { mine: string; base: string; latest: string } | null = null, part: 'mine' | 'base' | 'latest' = 'mine', n = 0
  for (const line of out.split(/(?<=\n)/)) {
    if (line.startsWith(`${m('<')} `)) { if (plain) segments.push(plain); plain = ''; cur = { mine: '', base: '', latest: '' }; part = 'mine' }
    else if (cur && line.startsWith(`${m('|')} `)) part = 'base'
    else if (cur && line.trimEnd() === m('=')) part = 'latest'
    else if (cur && line.startsWith(`${m('>')} `)) { segments.push({ n: ++n, ...cur }); cur = null }
    else if (cur) cur[part] += line
    else plain += line
  }
  if (plain) segments.push(plain)
  return segments
}

// The definition as a push would have it: at the head of the repository that
// holds the definitions, one in submodule mode possibly past the root's pin.
interface Target {
  dir: string; repository: string; owner: string; name: string; branch: string; commit: string; inner: string
  mount: string | null; pinned: string | null // the submodule's path, and the commit the root pins
}
async function targetOf(ctx: AccessContext, project: string): Promise<Target> {
  const c: AccessContext = { ...ctx, refresh: true }
  const l = await locate(c, project, WORKFLOWS_DIR, { upstream: true })
  if (l.fetch.state === 'stale') throw new RequestError(502, `${l.repository.fullName} could not be refreshed from Gitea (${l.fetch.error}); nothing was published. Retry when it is reachable.`, { code: 'fetch-failed', fetch: l.fetch })
  if (l.chain.length > 1) throw new RequestError(409, `${WORKFLOWS_DIR} is ${l.chain.length} submodules deep in ${project}; publishing through nested submodules is not supported`, { code: 'unsupported-layout' })
  const [owner, name] = l.repository.fullName.split('/') as [string, string]
  return { dir: l.dir, repository: l.repository.fullName, owner, name, branch: l.repository.defaultBranch, commit: l.commit, inner: l.inner, mount: l.chain[0]?.path ?? null, pinned: l.chain[0]?.pinned ?? null }
}
const fileAt = async (t: Target, commit: string, file: string): Promise<string | null> => {
  const r = await git(t.dir, ['show', `${commit}:${t.inner ? `${t.inner}/` : ''}${file}`])
  return r.code === 0 ? r.stdout : null
}

async function compareWith(d: DraftRecord, latest: string | null, source: DefinitionDescriptor, others: () => Promise<string | undefined>): Promise<Comparison> {
  const base = d.base.text
  const conflict = (c: Omit<DraftConflict, 'latest'>): Comparison => ({ state: 'conflict', conflict: { ...c, latest: { text: latest, sha256: latest === null ? null : digestOf(latest), source } } })
  if (latest === d.text) return { state: 'same', text: d.text }
  if (latest === null) {
    if (base === null) return { state: 'direct', text: d.text } // a new workflow
    const renamedTo = await others()
    return renamedTo
      ? conflict({ kind: 'renamed', renamedTo, message: `${d.file} was renamed to ${renamedTo} since this draft began. Move the draft there, or keep it under its own name as a new file.` })
      : conflict({ kind: 'deleted', message: `${d.file} was deleted from the project since this draft began. Recreate it from this draft, or discard the draft.` })
  }
  if (base === null) {
    const merged = await mergeTexts(d.text, '', latest)
    return conflict({ kind: 'exists', segments: merged.segments, message: `${d.file} now exists in the project, added since this draft began. Choose what to keep.` })
  }
  if (latest === base) return d.text === base ? { state: 'unchanged', text: latest } : { state: 'direct', text: d.text }
  if (d.text === base) return { state: 'unchanged', text: latest }
  const merged = await mergeTexts(d.text, base, latest)
  if (merged.clean) return { state: 'merged', text: merged.text }
  return conflict({ kind: 'text', segments: merged.segments, message: `${d.file} changed in the project since this draft began, in the same places. Choose what to keep.` })
}

// Validation of the bytes a publication would hold, at the published revision.
async function invalidIssues(pub: PublishedWorkspace, file: string, text: string): Promise<{ problem?: string; issues: Issue[] }> {
  const r = await pub.overlaid(file, text).workflowResponse(file)
  if (r.problem) return { problem: r.problem.message, issues: [] }
  return { issues: r.issues.filter(i => i.severity === 'error') }
}

export async function compareDraft(ctx: AccessContext, store: DraftStore, reg: Registration, id: string) {
  const d = await store.read(id)
  const t = await targetOf(ctx, d.project)
  const pub = await publishedWorkspace(ctx, reg, { discovery: true })
  const latest = await fileAt(t, t.commit, d.file)
  const c = await compareWith(d, latest, publishedDescriptor(pub.source, d.file, d.workflow, latest), () => renamedTo(pub, d))
  const check = c.state === 'conflict' ? null : await invalidIssues(pub, d.file, c.text)
  return { draft: draftMeta(d), comparison: c, ...(check ? { check } : {}) }
}
const renamedTo = async (pub: PublishedWorkspace, d: DraftRecord) => d.workflow ? (await pub.workflowSummaries()).list.find(s => s.id === d.workflow && s.file !== d.file)?.file : undefined

// A person's resolution of a conflict: a saved revision whose base is the
// published definition just compared against, so applying it changes only what
// was chosen. A published definition that moved again is another conflict.
export async function resolveDraft(ctx: AccessContext, store: DraftStore, reg: Registration, id: string, o: { revision: number; by: string; latest: string | null; text?: string; recreate?: boolean; retarget?: string }): Promise<DraftRecord> {
  if (!o.by?.trim()) throw new RequestError(400, 'by is required: the name of who resolves')
  const before = await store.read(id)
  const file = o.retarget ?? before.file
  if (!WORKFLOW_FILE.test(file)) throw new RequestError(400, `invalid workflow file name "${file}"`)
  const t = await targetOf(ctx, before.project)
  const pub = await publishedWorkspace(ctx, reg, { fresh: true })
  const latest = await fileAt(t, t.commit, file)
  const latestSha = latest === null ? null : digestOf(latest)
  if (o.retarget === undefined && latestSha !== o.latest) throw new RequestError(409, `${file} changed again in the project while you were resolving; look at it again`, { code: 'definition-conflict', latest: latestSha })
  return store.update(id, d => {
    revisionOf(d, o.revision)
    if (o.retarget) d.file = o.retarget
    d.base = o.recreate ? { text: null, sha256: null, source: null } : { text: latest, sha256: latestSha, source: publishedDescriptor(pub.source, file, d.workflow, latest) }
    const text = typeof o.text === 'string' ? o.text : d.text
    record(d, text, o.by.trim())
  })
}

// ---- applying ------------------------------------------------------------------------

const BOT = { 'user.name': 'WFE drafts', 'user.email': 'wfe-drafts@agdev.invalid' }
const isAncestor = async (dir: string, a: string, b: string) => (await git(dir, ['merge-base', '--is-ancestor', a, b])).code === 0
const known = async (dir: string, c: string) => (await git(dir, ['cat-file', '-e', `${c}^{commit}`])).code === 0

// A commit on `parent` changing only the given paths, built in a temporary
// index of the access cache: no working tree, nothing else carried along.
async function commitOn(dir: string, parent: string, changes: { path: string; mode: string; object: string }[], message: string, by: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'wfe-apply-'))
  try {
    const env = { GIT_INDEX_FILE: join(tmp, 'index') }
    await gitOk(dir, ['read-tree', parent], { env })
    for (const c of changes) await gitOk(dir, ['update-index', '--add', '--cacheinfo', `${c.mode},${c.object},${c.path}`], { env })
    const tree = (await gitOk(dir, ['write-tree'], { env })).trim()
    if (tree === (await gitOk(dir, ['rev-parse', `${parent}^{tree}`])).trim()) return parent
    const email = `${by.replace(/[^A-Za-z0-9._-]+/g, '-') || 'person'}@agdev.invalid`
    return (await gitOk(dir, ['commit-tree', tree, '-p', parent, '-m', message], { env: { GIT_AUTHOR_NAME: by, GIT_AUTHOR_EMAIL: email }, config: BOT })).trim()
  } finally { await rm(tmp, { recursive: true, force: true }) }
}
async function blobOf(dir: string, text: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'wfe-apply-'))
  try {
    const f = join(tmp, 'blob')
    await writeFile(f, text)
    return (await gitOk(dir, ['hash-object', '-w', '--no-filters', f])).trim()
  } finally { await rm(tmp, { recursive: true, force: true }) }
}

type Pushed = 'pushed' | 'moved' | 'unknown'
// Without force: a head that moved since `commit`'s parent refuses it.
async function push(ctx: AccessContext, dir: string, owner: string, name: string, commit: string, branch: string): Promise<{ state: Pushed; detail?: string }> {
  const g = host(ctx)
  const p = await git(dir, ['push', '--porcelain', g.cloneUrl(owner, name), `${commit}:refs/heads/${branch}`], { env: await g.gitEnv(), timeoutMs: 120_000 })
  if (p.code === 0) return { state: 'pushed' }
  const text = `${p.stderr}\n${p.stdout}`
  return /rejected|non-fast-forward|fetch first|stale info/i.test(text) ? { state: 'moved', detail: text.trim().split('\n').pop() } : { state: 'unknown', detail: p.stderr.trim() || p.stdout.trim() }
}

export async function applyDraft(ctx: AccessContext, store: DraftStore, reg: Registration, id: string, o: { revision: number; by: string; key?: string }): Promise<ApplyResult> {
  if (!o.by?.trim()) throw new RequestError(400, 'by is required: the name of who applies')
  await mkdir(store.dir, { recursive: true })
  return withLock(store.applyLock(reg.project!), () => applyLocked(ctx, store, reg, id, o), { what: `applying a draft of ${reg.project}`, timeoutMs: 300_000 })
}

async function applyLocked(ctx: AccessContext, store: DraftStore, reg: Registration, id: string, o: { revision: number; by: string; key?: string }): Promise<ApplyResult> {
  const first = await store.read(id)
  if (first.project !== reg.project) throw new RequestError(404, `draft ${id} is of project ${first.project}`)
  // A repeated apply, a second tab or a lost response: what happened, not again.
  if (first.apply?.outcome === 'applied' && first.apply.revision === o.revision) return { ok: true, duplicate: true, draft: draftMeta(first), apply: first.apply }
  revisionOf(first, o.revision)
  const prior = first.apply && first.apply.revision === o.revision ? first.apply : null
  const journal: ApplyJournal = { key: o.key ?? randomBytes(8).toString('hex'), revision: o.revision, by: o.by.trim(), outcome: 'in-progress', phase: 'started', started: nowIso(), updated: nowIso(), ...(prior?.definition ? { definition: prior.definition } : {}), ...(prior?.root ? { root: prior.root } : {}), ...(prior?.merged ? { merged: prior.merged } : {}) }
  const save = async () => { journal.updated = nowIso(); await store.update(id, d => { d.apply = { ...journal } }) }
  const finish = async (ok: boolean, outcome: ApplyOutcome, extra: Partial<ApplyResult> = {}, error?: string): Promise<ApplyResult> => {
    journal.outcome = outcome; if (error) journal.error = error; else delete journal.error
    await save()
    const d = await store.read(id)
    return { ok, draft: draftMeta(d), apply: { ...journal }, ...extra }
  }
  await save()
  try {
    const message = (file: string) => `Apply workflow draft: ${file}\n\nWFE-Draft: ${id} r${o.revision}\nWFE-Apply: ${journal.key}\nApplied-by: ${o.by.trim()}`
    let published: string | null = null // the bytes that went out
    for (let attempt = 1; ; attempt++) {
      if (attempt > PUBLISH_TRIES) return await finish(false, 'failed', {}, `another writer kept moving the branch; nothing more was pushed after ${PUBLISH_TRIES} tries. The draft is kept: apply again.`)
      const d = await store.read(id)
      const t = await targetOf(ctx, d.project)
      const pub = await publishedWorkspace(ctx, reg, { fresh: true })
      journal.phase = 'read-target'
      // An earlier try's commit found on the target: not published twice.
      if (journal.definition && await known(t.dir, journal.definition.commit) && await isAncestor(t.dir, journal.definition.commit, t.commit)) journal.definition.pushed = true
      else if (journal.definition) journal.definition.pushed = false
      if (!journal.definition?.pushed) {
        const latest = await fileAt(t, t.commit, d.file)
        const c = await compareWith(d, latest, publishedDescriptor(pub.source, d.file, d.workflow, latest), () => renamedTo(pub, d))
        if (c.state === 'conflict') { journal.phase = 'compared'; return await finish(false, 'conflict', { conflict: c.conflict }, c.conflict.message) }
        const check = await invalidIssues(pub, d.file, c.text)
        if (check.problem || check.issues.length) { journal.phase = 'validated'; return await finish(false, 'invalid', { issues: check.issues, ...(check.problem ? { problem: check.problem } : {}) }, check.problem ?? `the definition has ${check.issues.length} validation error${check.issues.length === 1 ? '' : 's'}`) }
        published = c.text
        journal.merged = digestOf(c.text)
        journal.noChange = c.state === 'same' || c.state === 'unchanged'
        const path = `${t.inner ? `${t.inner}/` : ''}${d.file}`
        const commit = journal.noChange ? t.commit : await commitOn(t.dir, t.commit, [{ path, mode: '100644', object: await blobOf(t.dir, c.text) }], message(d.file), o.by.trim())
        journal.definition = { repository: t.repository, branch: t.branch, path, parent: t.commit, commit, pushed: commit === t.commit }
        journal.phase = 'definition-built'
        await save() // named before it can reach the remote
        if (commit !== t.commit) {
          const p = await push(ctx, t.dir, t.owner, t.name, commit, t.branch)
          if (p.state === 'moved') continue
          if (p.state === 'unknown') {
            journal.phase = 'definition-push-unknown'
            return await finish(false, 'uncertain', {}, `pushing ${t.repository} did not finish (${p.detail}); whether it reached the project is unknown. Applying again finds out.`)
          }
          journal.definition.pushed = true
          journal.phase = 'definition-pushed'
          await save()
        }
      }
      // Submodule mode: the project uses what its root pins, so the pin moves too.
      if (t.mount) {
        const def = journal.definition!
        const r = await locate({ ...ctx, refresh: true }, d.project, '.')
        if (r.fetch.state === 'stale') return await finish(false, 'uncertain', {}, `the definition reached ${t.repository} but ${r.repository.fullName} could not be refreshed (${r.fetch.error}); applying again finishes the pin.`)
        const [rootOwner, rootName] = r.repository.fullName.split('/') as [string, string]
        const pin = /^160000 commit ([0-9a-f]+)\t/.exec((await git(r.dir, ['ls-tree', r.commit, '--', t.mount])).stdout)?.[1] ?? null
        const covered = pin !== null && await known(t.dir, pin) && await isAncestor(t.dir, def.commit, pin)
        if (!covered) {
          // The pin takes the branch's head, which holds the definition (t.commit
          // when another try already found it there; def.commit otherwise).
          const to = await isAncestor(t.dir, def.commit, t.commit) ? t.commit : def.commit
          const rootCommit = await commitOn(r.dir, r.commit, [{ path: t.mount, mode: '160000', object: to }], `${message(d.file).split('\n')[0]} (advance ${t.mount})\n\nWFE-Draft: ${id} r${o.revision}\nWFE-Apply: ${journal.key}\nApplied-by: ${o.by.trim()}`, o.by.trim())
          journal.root = { repository: r.repository.fullName, branch: r.repository.defaultBranch, parent: r.commit, commit: rootCommit, pushed: false, pinFrom: pin, pinTo: to }
          journal.phase = 'root-built'
          await save()
          const p = await push(ctx, r.dir, rootOwner, rootName, rootCommit, r.repository.defaultBranch)
          if (p.state === 'moved') continue
          if (p.state === 'unknown') {
            journal.phase = 'root-push-unknown'
            return await finish(false, 'uncertain', {}, `the definition reached ${t.repository}, but pushing the pin to ${r.repository.fullName} did not finish (${p.detail}). Applying again finishes it.`)
          }
          journal.root.pushed = true
          journal.phase = 'root-pushed'
          await save()
        } else if (journal.root) journal.root.pushed = true
      }
      break
    }
    // Read back through the resolver ordinary requests use.
    await invalidate(ctx, reg.project!).catch(() => [])
    journal.phase = 'reading-back'
    const after = await publishedWorkspace(ctx, reg, { fresh: true })
    const d = await store.read(id)
    const read = await after.readWorkflowFile(d.file)
    const sha = read.text === null ? null : digestOf(read.text)
    let superseded = false
    if (sha !== journal.merged) {
      const anchor = journal.root?.commit ?? journal.definition!.commit
      const dir = after.located.rootDir
      superseded = await known(dir, anchor) && await isAncestor(dir, anchor, after.source.commit)
      if (!superseded) return await finish(false, 'uncertain', {}, `${after.source.repository}@${after.source.commit.slice(0, 10)} does not hold the applied definition (reads ${sha?.slice(0, 12) ?? 'nothing'}). Applying again finds out.`)
    }
    journal.superseded = superseded
    journal.result = publishedDescriptor(after.source, d.file, read.workflow?.id ?? d.workflow, read.text)
    journal.phase = 'verified'
    journal.outcome = 'applied'
    delete journal.error
    // Newer edits saved meanwhile stay as an open draft, based on what was applied.
    const final = await store.update(id, x => {
      x.apply = { ...journal, updated: nowIso() }
      if (x.revision === o.revision) { x.state = 'applied'; return }
      x.base = { text: read.text ?? published, sha256: journal.merged ?? sha, source: journal.result! }
    })
    return { ok: true, draft: draftMeta(final), apply: final.apply! }
  } catch (e) {
    const code = (e as RequestError).detail as { code?: string } | undefined
    const pushedSomething = journal.definition?.pushed || journal.root?.pushed || /-built$/.test(journal.phase)
    return await finish(false, pushedSomething ? 'uncertain' : 'failed', {}, `${(e as Error).message}${code?.code ? ` (${code.code})` : ''}. The draft is kept.`)
  }
}
