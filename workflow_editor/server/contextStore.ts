// The local context store (workflow_editor p13, p14; docs/context.md): the
// independently managed context blocks of each scope and the exact context
// snapshots attempts were prepared with. It lives in the WFE area's ignored
// .local/ — never in a project repository, a run copy or a publication — and
// is the one authority for local context: the browser, the CLI (locally or
// through the service) and the executor's claim go through these functions.
//
//   <area>/.local/contexts/system/<block>.json                       a block of all projects
//   <area>/.local/contexts/projects/<p>/project/<block>.json          a block of a project
//   <area>/.local/contexts/projects/<p>/workflows/<w>/<block>.json    a block of a workflow
//   … each with <block>.revisions.jsonl beside it (every revision: the
//     operation, who, when, from which run, and the block as it was after
//     it) and <block>.details/<sha256> (detail documents, content-addressed)
//   <area>/.local/contexts/snapshots/<id>.json   one per prepared bundle (content-addressed)
//
// A block is written on its own: one file per block, replaced atomically,
// so an update to one block never rewrites its siblings. A write that
// changes content names the revision it read (`base`); a different current
// content revision refuses it (409 context-conflict) with what is there now,
// so an unseen edit is never overwritten. A check (unchanged content
// verified again) and a failed refresh are revisions that do not change
// what writers base on. A file edited by hand is recorded as an external
// revision before the next write.
//
// p13 kept one override file per scope (system.md, project.md,
// workflows/<w>.md). They are converted once, with their revisions, into a
// Developer-managed block `developer` of the same scope and moved to
// contexts/archive/p13/; nothing reads or writes them after that.
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { ID_PATTERN } from '../shared/model.ts'
import {
  BLOCK_KINDS, EVIDENCE_BASES, EVIDENCE_STATUSES, READABLE_CONTEXT_SCHEMAS, blockDigest, blockFile, parseDetailRef, renderBlock, textSize,
  type BlockKind, type BlockOp, type BlockRevision, type BlockState, type ContextBlock, type ContextBundle, type EvidenceRef, type ScopeTarget,
} from '../shared/context.ts'
import { atomicWrite, readTextOrNull } from './files.ts'
import { withLock } from './lock.ts'
import { RequestError } from './workspace.ts'

export const MAX_BODY_BYTES = 64 * 1024
export const MAX_DETAIL_BYTES = 1024 * 1024
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex')
const SNAPSHOT_ID = /^ctx-[0-9a-f]{24}$/
const DETAIL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const CONSULT = /^[a-z0-9][a-z0-9_.-]{0,63}\/[a-z0-9][a-z0-9_.-]{0,63}$/
const BLOCK_SCHEMA = 'ag.wfe-context-block.v1'
// The block a converted p13 override becomes.
export const DEVELOPER_BLOCK = 'developer'

interface StoredBlock { schema: typeof BLOCK_SCHEMA; revision: number; base: number; sha256: string; block: ContextBlock }

export function scopeTarget(scope: string, project?: string | null, workflow?: string | null): ScopeTarget {
  if (scope !== 'system' && scope !== 'project' && scope !== 'workflow') throw new RequestError(400, 'scope is system, project or workflow')
  const id = (v: string | null | undefined, what: string) => {
    if (!v || !ID_PATTERN.test(v)) throw new RequestError(400, `${what} must match ${ID_PATTERN.source}`)
    return v
  }
  if (scope === 'system') { if (project || workflow) throw new RequestError(400, 'the system scope takes no project or workflow'); return { scope } }
  if (scope === 'project') { if (workflow) throw new RequestError(400, 'the project scope takes no workflow'); return { scope, project: id(project, 'project') } }
  return { scope, project: id(project, 'project'), workflow: id(workflow, 'workflow') }
}
const blockId = (v: string | null | undefined) => {
  if (!v || !ID_PATTERN.test(v)) throw new RequestError(400, `the block id must match ${ID_PATTERN.source}`)
  return v
}

// What a writer may give a block. Absent fields keep the current value.
export interface BlockInput {
  title?: string
  manager?: string
  kind?: BlockKind
  body?: string
  evidence?: EvidenceRef[]
  consult?: string | null
  details?: { name: string; text: string }[] // added or replaced by name
  dropDetails?: string[]
}
export interface WriteMeta { by: string; run?: string; via?: string; note?: string }

const oneLine = (v: unknown, what: string, max: number) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\r\n]/.test(v)) throw new RequestError(400, `${what} is one line of at most ${max} characters`)
  return v.trim()
}
export function validEvidence(v: unknown, now = Date.now()): EvidenceRef[] {
  if (!Array.isArray(v) || v.length > 50) throw new RequestError(400, 'evidence is a list of at most 50 references')
  return v.map((e, i) => {
    const o = e as Record<string, unknown>
    if (!o || typeof o !== 'object') throw new RequestError(400, `evidence[${i}] is {ref, basis, status, observed?, coverage?, title?}`)
    const basis = o.basis as EvidenceRef['basis'], status = o.status as EvidenceRef['status']
    if (!EVIDENCE_BASES.includes(basis)) throw new RequestError(400, `evidence[${i}].basis is ${EVIDENCE_BASES.join(', ')}`)
    if (!EVIDENCE_STATUSES.includes(status)) throw new RequestError(400, `evidence[${i}].status is ${EVIDENCE_STATUSES.join(', ')}`)
    let observed: string | undefined
    if (o.observed !== undefined && o.observed !== null) {
      const t = typeof o.observed === 'string' ? Date.parse(o.observed) : NaN
      if (!Number.isFinite(t)) throw new RequestError(400, `evidence[${i}].observed is an ISO time: when the source was observed`)
      if (t > now + 5 * 60_000) throw new RequestError(400, `evidence[${i}].observed is in the future`)
      observed = new Date(t).toISOString()
    }
    return {
      ref: oneLine(o.ref, `evidence[${i}].ref`, 1000), basis, status,
      ...(o.title !== undefined ? { title: oneLine(o.title, `evidence[${i}].title`, 200) } : {}),
      ...(observed ? { observed } : {}),
      ...(o.coverage !== undefined ? { coverage: oneLine(o.coverage, `evidence[${i}].coverage`, 300) } : {}),
    }
  })
}

export class ContextStore {
  readonly root: string
  private converted?: Promise<void>
  constructor(area: string) { this.root = join(area, '.local') }

  private file(t: ScopeTarget, id: string) { return join(this.root, blockFile(scopeTarget(t.scope, t.project, t.workflow), blockId(id))) }
  private revFile(t: ScopeTarget, id: string) { return this.file(t, id).replace(/\.json$/, '.revisions.jsonl') }
  private detailFile(t: ScopeTarget, id: string, sha: string) { return join(this.file(t, id).replace(/\.json$/, '.details'), sha) }
  private scopeDir(t: ScopeTarget) { return dirname(this.file(t, 'x')) }

  private async revisions(t: ScopeTarget, id: string): Promise<BlockRevision[]> {
    const text = await readTextOrNull(this.revFile(t, id))
    if (!text) return []
    return text.split('\n').filter(Boolean).map((l, i) => {
      try { return JSON.parse(l) as BlockRevision } catch { throw new RequestError(500, `${blockFile(t, id).replace(/\.json$/, '.revisions.jsonl')} line ${i + 1} is not JSON; fix it by hand`) }
    })
  }

  private async stored(t: ScopeTarget, id: string): Promise<StoredBlock | null> {
    const text = await readTextOrNull(this.file(t, id))
    if (text === null) return null
    let s: StoredBlock
    try { s = JSON.parse(text) as StoredBlock } catch { throw new RequestError(500, `${blockFile(t, id)} is not JSON; fix it by hand`) }
    if (s.schema !== BLOCK_SCHEMA || !s.block || typeof s.block.body !== 'string') throw new RequestError(500, `${blockFile(t, id)} is not a context block (${BLOCK_SCHEMA})`)
    return s
  }

  async read(t: ScopeTarget, id: string): Promise<BlockState> {
    await this.ready()
    t = scopeTarget(t.scope, t.project, t.workflow)
    id = blockId(id)
    const base: BlockState = { target: t, id, file: blockFile(t, id), block: null, revision: 0, base: 0, revisions: 0, sha256: null, size: null, external: false }
    let revs: BlockRevision[], s: StoredBlock | null
    try { revs = await this.revisions(t, id); s = await this.stored(t, id) } catch (e) { return { ...base, problem: (e as Error).message } }
    const last = revs.at(-1)
    const lastContent = [...revs].reverse().find(r => r.content)
    const revision = last?.rev ?? 0
    const b = s?.block ?? null
    const h = b ? blockDigest(t, b) : null
    // Hand-edited: the file differs from its last recorded revision (or
    // carries a different recorded digest). It becomes revision+1 on the
    // next write, which is what a writer who read it names as base.
    const external = (last?.sha256 ?? null) !== h || (!!s && s.sha256 !== h)
    return { ...base, block: b, revision, base: external ? revision + 1 : lastContent?.rev ?? 0, revisions: revs.length, sha256: h, size: b ? textSize(renderBlock(t, b)) : null, external }
  }

  async history(t: ScopeTarget, id: string): Promise<BlockRevision[]> {
    await this.ready()
    return this.revisions(scopeTarget(t.scope, t.project, t.workflow), blockId(id))
  }

  // Every block of one scope (removed ones too: their history stays), in
  // delivery order: instructions, then information, by id.
  async blocks(t: ScopeTarget): Promise<BlockState[]> {
    await this.ready()
    t = scopeTarget(t.scope, t.project, t.workflow)
    const names = await readdir(this.scopeDir(t), { withFileTypes: true }).catch(() => [])
    const ids = new Set(names.filter(e => e.isFile()).map(e => /^(.+?)\.(json|revisions\.jsonl)$/.exec(e.name)?.[1]).filter((n): n is string => !!n && ID_PATTERN.test(n)))
    const out = await Promise.all([...ids].map(id => this.read(t, id)))
    const rank = (s: BlockState) => (s.block ? (s.block.kind === 'instruction' ? 0 : 1) : 2)
    return out.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  // Every scope that has blocks, for the overview.
  async all(): Promise<BlockState[]> {
    await this.ready()
    const out = [...await this.blocks({ scope: 'system' })]
    const dir = join(this.root, 'contexts', 'projects')
    const dirs = async (d: string) => (await readdir(d, { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory() && ID_PATTERN.test(e.name)).map(e => e.name).sort()
    for (const p of await dirs(dir)) {
      out.push(...await this.blocks({ scope: 'project', project: p }))
      for (const w of await dirs(join(dir, p, 'workflows'))) out.push(...await this.blocks({ scope: 'workflow', project: p, workflow: w }))
    }
    return out
  }

  // ---- writes ---------------------------------------------------------------

  private async commit(t: ScopeTarget, id: string, cur: BlockState, op: BlockOp, next: ContextBlock | null, meta: WriteMeta, content: boolean): Promise<BlockState> {
    const at = new Date().toISOString()
    const add = (r: BlockRevision) => appendFile(this.revFile(t, id), `${JSON.stringify(r)}\n`)
    let rev = cur.revision
    const by = meta.by.trim()
    const extra = { ...(meta.run ? { run: meta.run } : {}), ...(meta.via ? { via: meta.via } : {}), ...(meta.note ? { note: meta.note } : {}) }
    if (cur.external) await add({ rev: ++rev, at, by: 'edited outside WFE', op: 'external', content: true, sha256: cur.sha256, block: cur.block })
    const h = next ? blockDigest(t, next) : null
    await add({ rev: ++rev, at, by, op, content, sha256: h, block: next, ...extra })
    const base = content ? rev : cur.base
    if (next) await atomicWrite(this.file(t, id), `${JSON.stringify({ schema: BLOCK_SCHEMA, revision: rev, base, sha256: h!, block: next } satisfies StoredBlock, null, 1)}\n`)
    else await rm(this.file(t, id), { force: true })
    return this.read(t, id)
  }

  private conflict(cur: BlockState, base: number | null | undefined) {
    if ((base ?? -1) !== cur.base) throw new RequestError(409, `${cur.file} changed since it was read (content revision now ${cur.base}${cur.block ? `, last edited by ${cur.block.editor.by} at ${cur.block.editor.at}` : cur.base ? ', removed' : ', none'}); read it again and reapply your change`, { code: 'context-conflict', current: cur })
  }

  private async locked<T>(t: ScopeTarget, id: string, fn: (cur: BlockState) => Promise<T>): Promise<T> {
    await this.ready()
    t = scopeTarget(t.scope, t.project, t.workflow)
    id = blockId(id)
    const file = this.file(t, id)
    await mkdir(dirname(file), { recursive: true })
    return withLock(file, async () => {
      const cur = await this.read(t, id)
      if (cur.problem) throw new RequestError(409, `${cur.file}: ${cur.problem}`)
      return fn(cur)
    }, { what: blockFile(t, id) })
  }

  // Creates or changes a block. `base` is the content revision the writer
  // read (0: none). Publishing what is already there is not a revision.
  // Evidence given with a publication clears an earlier failed refresh;
  // an observation time is the evidence's, never this write's.
  async set(t: ScopeTarget, id: string, input: BlockInput, o: WriteMeta & { base: number | null }): Promise<{ state: BlockState; changed: boolean }> {
    if (!o.by?.trim()) throw new RequestError(400, 'by is required: who writes the block')
    return this.locked(t, id, async cur => {
      t = cur.target
      const was = cur.block
      if (!was && (input.title === undefined || input.kind === undefined || input.body === undefined)) throw new RequestError(400, `${cur.file} does not exist${cur.base ? ' (removed)' : ''}: a new block needs a title, a kind and a body`)
      const kind = input.kind ?? was!.kind
      if (!BLOCK_KINDS.includes(kind)) throw new RequestError(400, `kind is ${BLOCK_KINDS.join(' or ')}`)
      const body = input.body ?? was!.body
      if (!body.trim()) throw new RequestError(400, 'the body is empty: remove the block instead')
      const text = body.endsWith('\n') ? body : `${body}\n`
      if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new RequestError(413, `a block's body is at most ${MAX_BODY_BYTES} bytes; put larger material in a detail (read on demand)`)
      const evidence = input.evidence !== undefined ? validEvidence(input.evidence) : was?.evidence ?? []
      const consult = input.consult === null ? undefined : input.consult !== undefined ? (CONSULT.test(input.consult) ? input.consult : (() => { throw new RequestError(400, 'consult is <project>/<workflow>') })()) : was?.consult
      // Details: content-addressed blobs, listed by name.
      const details = new Map((was?.details ?? []).map(d => [d.name, d]))
      for (const n of input.dropDetails ?? []) details.delete(n)
      const at = new Date().toISOString()
      const blobs: { sha: string; text: string }[] = []
      for (const d of input.details ?? []) {
        if (!DETAIL_NAME.test(d.name)) throw new RequestError(400, `detail name "${d.name}" must match ${DETAIL_NAME.source}`)
        if (Buffer.byteLength(d.text) > MAX_DETAIL_BYTES) throw new RequestError(413, `a detail is at most ${MAX_DETAIL_BYTES} bytes`)
        const sha = sha256(d.text)
        if (details.get(d.name)?.sha256 !== sha) details.set(d.name, { name: d.name, sha256: sha, bytes: Buffer.byteLength(d.text), at, by: o.by.trim() })
        blobs.push({ sha, text: d.text })
      }
      const content = {
        title: input.title !== undefined ? oneLine(input.title, 'title', 200) : was!.title,
        manager: input.manager !== undefined ? oneLine(input.manager, 'manager', 100) : was?.manager ?? o.by.trim(),
        kind, body: text, evidence, details: [...details.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
        ...(consult ? { consult } : {}),
      }
      const refresh = input.evidence !== undefined ? undefined : was?.refresh
      const same = was && JSON.stringify({ ...content, refresh }) === JSON.stringify({ title: was.title, manager: was.manager, kind: was.kind, body: was.body, evidence: was.evidence, details: was.details, ...(was.consult ? { consult: was.consult } : {}), refresh: was.refresh })
      if (same && !cur.external) return { state: cur, changed: false }
      this.conflict(cur, o.base)
      for (const b of blobs) {
        const f = this.detailFile(t, id, b.sha)
        if (await readTextOrNull(f) !== b.text) { await mkdir(dirname(f), { recursive: true }); await atomicWrite(f, b.text) }
      }
      const next: ContextBlock = {
        id, ...content,
        editor: { by: o.by.trim(), at, ...(o.run ? { run: o.run } : {}), ...(o.via ? { via: o.via } : {}) },
        ...(was?.checked ? { checked: was.checked } : {}), ...(refresh ? { refresh } : {}),
      }
      return { state: await this.commit(t, id, cur, 'set', next, o, true), changed: true }
    })
  }

  // Records that the current content was verified again and still holds.
  // Bookkeeping: the delivered section and the fingerprint do not change.
  async check(t: ScopeTarget, id: string, o: WriteMeta & { base: number | null }): Promise<{ state: BlockState; changed: boolean }> {
    if (!o.by?.trim()) throw new RequestError(400, 'by is required: who checked the block')
    return this.locked(t, id, async cur => {
      if (!cur.block) throw new RequestError(409, `${cur.file} has no content to check`)
      this.conflict(cur, o.base)
      const next: ContextBlock = { ...cur.block, checked: { at: new Date().toISOString(), by: o.by.trim(), ...(o.run ? { run: o.run } : {}), ...(o.note ? { note: o.note } : {}) } }
      return { state: await this.commit(cur.target, id, cur, 'check', next, o, false), changed: true }
    })
  }

  // Records a refresh that failed or covered only part of what it should.
  // The content stays as it was (never replaced by an empty one); the
  // failure is delivered with it until a publication with evidence.
  async refreshFailed(t: ScopeTarget, id: string, o: WriteMeta & { outcome: 'failed' | 'partial'; detail: string }): Promise<{ state: BlockState; changed: boolean }> {
    if (!o.by?.trim()) throw new RequestError(400, 'by is required: who refreshed the block')
    if (o.outcome !== 'failed' && o.outcome !== 'partial') throw new RequestError(400, 'outcome is failed or partial')
    const detail = oneLine(o.detail, 'detail', 500)
    return this.locked(t, id, async cur => {
      if (!cur.block) throw new RequestError(409, `${cur.file} has no content yet: there is nothing a failed refresh keeps (publish what you have, with its evidence, instead)`)
      const next: ContextBlock = { ...cur.block, refresh: { at: new Date().toISOString(), by: o.by.trim(), outcome: o.outcome, detail, ...(o.run ? { run: o.run } : {}) } }
      return { state: await this.commit(cur.target, id, cur, 'refresh', next, o, false), changed: true }
    })
  }

  async remove(t: ScopeTarget, id: string, o: WriteMeta & { base: number | null }): Promise<{ state: BlockState; changed: boolean }> {
    if (!o.by?.trim()) throw new RequestError(400, 'by is required: who removes the block')
    return this.locked(t, id, async cur => {
      if (!cur.block && !cur.external) return { state: cur, changed: false }
      this.conflict(cur, o.base)
      return { state: await this.commit(cur.target, id, cur, 'remove', null, o, true), changed: true }
    })
  }

  // A detail of a block by its logical reference (context:<scope>/<block>/<name>).
  async detail(ref: string): Promise<{ ref: string; target: ScopeTarget; block: string; name: string; sha256: string; bytes: number; at: string; by: string; text: string }> {
    const p = parseDetailRef(ref)
    if (!p) throw new RequestError(400, `"${ref}" is not a detail reference (context:system/<block>/<name>, context:project/<p>/<block>/<name>, context:workflow/<p>/<w>/<block>/<name>)`)
    const t = scopeTarget(p.target.scope, p.target.project, p.target.workflow)
    const s = await this.read(t, p.block)
    const d = s.block?.details.find(x => x.name === p.name)
    if (!d) throw new RequestError(404, `${ref}: no such detail${s.block ? ` (the block has ${s.block.details.map(x => x.name).join(', ') || 'none'})` : ' (no such block)'}`)
    const text = await readTextOrNull(this.detailFile(t, p.block, d.sha256))
    if (text === null || sha256(text) !== d.sha256) throw new RequestError(500, `${ref}: the stored detail is missing or differs from its recorded hash`)
    return { ref, target: t, block: p.block, ...d, text }
  }

  // ---- conversion of p13 overrides (once) -------------------------------------

  private ready(): Promise<void> {
    this.converted ??= this.convert()
    return this.converted
  }

  private async convert(): Promise<void> {
    const ctx = join(this.root, 'contexts')
    const legacy: { file: string; t: ScopeTarget }[] = []
    const isFile = async (f: string) => (await stat(f).catch(() => null))?.isFile() ?? false
    const has = async (f: string) => (await isFile(f)) || (await isFile(`${f}.revisions.jsonl`))
    if (await has(join(ctx, 'system.md'))) legacy.push({ file: 'system.md', t: { scope: 'system' } })
    for (const p of (await readdir(join(ctx, 'projects'), { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory() && ID_PATTERN.test(e.name))) {
      if (await has(join(ctx, 'projects', p.name, 'project.md'))) legacy.push({ file: `projects/${p.name}/project.md`, t: { scope: 'project', project: p.name } })
      const ws = new Set((await readdir(join(ctx, 'projects', p.name, 'workflows'), { withFileTypes: true }).catch(() => [])).filter(e => e.isFile()).map(e => /^(.+)\.md(\.revisions\.jsonl)?$/.exec(e.name)?.[1]).filter((n): n is string => !!n && ID_PATTERN.test(n)))
      for (const w of [...ws].sort()) legacy.push({ file: `projects/${p.name}/workflows/${w}.md`, t: { scope: 'workflow', project: p.name, workflow: w } })
    }
    if (!legacy.length) return
    await mkdir(ctx, { recursive: true })
    await withLock(join(ctx, '.conversion'), async () => {
      for (const l of legacy) {
        const src = join(ctx, l.file)
        if (!(await has(src))) continue // converted by another process meanwhile
        const target = this.file(l.t, DEVELOPER_BLOCK)
        if (!(await isFile(target)) && !(await isFile(this.revFile(l.t, DEVELOPER_BLOCK)))) {
          const oldRevs = ((await readTextOrNull(`${src}.revisions.jsonl`)) ?? '').split('\n').filter(Boolean).map(x => JSON.parse(x) as { rev: number; at: string; by: string; sha256: string | null; text: string | null; note?: string; external?: boolean })
          const blockOf = (text: string | null, by: string, at: string): ContextBlock | null => text === null ? null : { id: DEVELOPER_BLOCK, title: 'Developer instructions', manager: 'Developer', kind: 'instruction', body: text.endsWith('\n') ? text : `${text}\n`, evidence: [], details: [], editor: { by, at, via: 'p13 override' } }
          const revs: BlockRevision[] = oldRevs.map(r => {
            const b = blockOf(r.text, r.by, r.at)
            return { rev: r.rev, at: r.at, by: r.by, op: r.text === null ? 'remove' : r.external ? 'external' : 'set', content: true, sha256: b ? blockDigest(l.t, b) : null, block: b, via: 'p13 override', ...(r.note ? { note: r.note } : {}) }
          })
          const fileText = await readTextOrNull(src)
          const at = new Date().toISOString()
          let rev = revs.at(-1)?.rev ?? 0
          const lastText = oldRevs.at(-1)?.text ?? null
          if ((fileText ?? null) !== lastText) {
            const b = blockOf(fileText, 'edited outside WFE', at)
            revs.push({ rev: ++rev, at, by: 'edited outside WFE', op: 'external', content: true, sha256: b ? blockDigest(l.t, b) : null, block: b })
          }
          const final = revs.at(-1)?.block ?? null
          const contentRev = rev
          revs.push({ rev: ++rev, at, by: 'WFE', op: 'converted', content: false, sha256: final ? blockDigest(l.t, final) : null, block: final, note: `converted from the p13 override contexts/${l.file} (archived in contexts/archive/p13/)` })
          await mkdir(dirname(target), { recursive: true })
          await atomicWrite(this.revFile(l.t, DEVELOPER_BLOCK), revs.map(r => `${JSON.stringify(r)}\n`).join(''))
          if (final) await atomicWrite(target, `${JSON.stringify({ schema: BLOCK_SCHEMA, revision: rev, base: contentRev, sha256: blockDigest(l.t, final), block: final } satisfies StoredBlock, null, 1)}\n`)
        }
        const arch = join(ctx, 'archive', 'p13', l.file)
        await mkdir(dirname(arch), { recursive: true })
        for (const suffix of ['', '.revisions.jsonl']) if (await isFile(`${src}${suffix}`)) await rename(`${src}${suffix}`, `${arch}${suffix}`)
      }
    }, { what: 'the p13 override conversion' })
  }

  // ---- snapshots ----------------------------------------------------------

  // Persists the exact bundle an attempt is prepared with; its id is its
  // content's hash, so the same bundle is one file.
  async saveSnapshot(bundle: ContextBundle, rendered: string): Promise<{ id: string; bytes: string }> {
    const bytes = `${JSON.stringify({ ...bundle, rendered })}\n`
    const id = `ctx-${sha256(bytes).slice(0, 24)}`
    const file = join(this.root, 'contexts', 'snapshots', `${id}.json`)
    await mkdir(dirname(file), { recursive: true })
    if (await readTextOrNull(file) !== bytes) await atomicWrite(file, bytes)
    return { id, bytes }
  }

  async readSnapshot(id: string): Promise<(ContextBundle & { rendered: string }) | { unavailable: string }> {
    if (!SNAPSHOT_ID.test(id)) return { unavailable: `"${id}" is not a context snapshot id` }
    const text = await readTextOrNull(join(this.root, 'contexts', 'snapshots', `${id}.json`)).catch(e => { throw new RequestError(500, `snapshot ${id} cannot be read: ${(e as Error).message}`) })
    if (text === null) return { unavailable: `snapshot ${id} is not on this host (it is kept only by the host that prepared the attempt)` }
    if (`ctx-${sha256(text).slice(0, 24)}` !== id) return { unavailable: `snapshot ${id} differs from the content it was saved with` }
    const b = JSON.parse(text) as ContextBundle & { rendered: string }
    if (!READABLE_CONTEXT_SCHEMAS.includes(b.schema)) return { unavailable: `snapshot ${id} has schema ${String(b.schema)}` }
    return b
  }
}

// One block operation as the HTTP API and the CLI take it (docs/context.md
// "Writing blocks"): the same input whether it arrives locally or through
// the area's service, so a remote writer reaches this store and not a copy.
export interface BlockOpInput extends BlockInput {
  op: 'set' | 'check' | 'refresh' | 'remove'
  scope: string
  project?: string
  workflow?: string
  block: string
  base?: number | null
  by: string
  run?: string
  attempt?: string // an executing attempt (WFE_ATTEMPT): its run is recorded as provenance
  via?: string
  note?: string
  outcome?: 'failed' | 'partial'
  detail?: string
}
export async function applyBlockOp(store: ContextStore, i: BlockOpInput, runOfAttempt?: (attempt: string) => string | null): Promise<{ state: BlockState; changed: boolean; written: string }> {
  const t = scopeTarget(i.scope, i.project, i.workflow)
  if (typeof i.by !== 'string' || !i.by.trim()) throw new RequestError(400, 'by is required: who writes')
  const run = i.run ?? (i.attempt ? runOfAttempt?.(i.attempt) ?? undefined : undefined)
  const meta = { by: i.by, ...(run ? { run } : {}), ...(i.via ? { via: i.via } : {}), ...(i.note ? { note: i.note } : {}) }
  const base = i.base === undefined || i.base === null ? null : Number(i.base)
  if (base !== null && (!Number.isInteger(base) || base < 0)) throw new RequestError(400, 'base is the content revision you read (0: none)')
  if (i.op !== 'refresh' && base === null) throw new RequestError(400, 'base is required: the content revision you read (wfe context get), 0 for a new block')
  const r = i.op === 'set' ? await store.set(t, i.block, i, { ...meta, base })
    : i.op === 'check' ? await store.check(t, i.block, { ...meta, base })
    : i.op === 'refresh' ? await store.refreshFailed(t, i.block, { ...meta, outcome: i.outcome ?? 'failed', detail: i.detail ?? '' })
    : i.op === 'remove' ? await store.remove(t, i.block, { ...meta, base })
    : (() => { throw new RequestError(400, 'op is set, check, refresh or remove') })()
  return { ...r, written: `the context store of the WFE area on ${hostname()}` }
}
