// The local context store (workflow_editor p13, docs/context.md): the
// Developer's overrides per scope and the exact context snapshots attempts
// were prepared with. It lives in the WFE area's ignored .local/ — never in a
// project repository, a run copy or a publication — and is the one authority
// for overrides: the browser, the CLI and any later entrance go through
// these functions.
//
//   <area>/.local/contexts/system.md
//   <area>/.local/contexts/projects/<project>/project.md
//   <area>/.local/contexts/projects/<project>/workflows/<workflow>.md
//   … each with <file>.revisions.jsonl beside it: every revision, its author,
//     time and exact content (null for a removal)
//   <area>/.local/contexts/snapshots/<id>.json   one per prepared bundle (content-addressed)
//
// A write names the content it replaces (`base`: its sha256, or null for
// none); a different current content refuses it (409 context-conflict) with
// what is there now, so an unseen revision is never overwritten. A file
// edited by hand is recorded as an external revision before the next write.
import { createHash } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ID_PATTERN } from '../shared/model.ts'
import { CONTEXT_SCHEMA, overrideFile, overrideKey, type ContextBundle, type OverrideRevision, type OverrideState, type OverrideTarget } from '../shared/context.ts'
import { atomicWrite, readTextOrNull } from './files.ts'
import { withLock } from './lock.ts'
import { RequestError } from './workspace.ts'

export const MAX_OVERRIDE_BYTES = 64 * 1024
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex')
const SNAPSHOT_ID = /^ctx-[0-9a-f]{24}$/

interface StoredRevision extends OverrideRevision { text: string | null }

export function overrideTarget(scope: string, project?: string | null, workflow?: string | null): OverrideTarget {
  if (scope !== 'system' && scope !== 'project' && scope !== 'workflow') throw new RequestError(400, 'scope is system, project or workflow')
  const id = (v: string | null | undefined, what: string) => {
    if (!v || !ID_PATTERN.test(v)) throw new RequestError(400, `${what} must match ${ID_PATTERN.source}`)
    return v
  }
  if (scope === 'system') { if (project || workflow) throw new RequestError(400, 'the system scope takes no project or workflow'); return { scope } }
  if (scope === 'project') { if (workflow) throw new RequestError(400, 'the project scope takes no workflow'); return { scope, project: id(project, 'project') } }
  return { scope, project: id(project, 'project'), workflow: id(workflow, 'workflow') }
}

export class ContextStore {
  readonly root: string
  constructor(area: string) { this.root = join(area, '.local') }
  // The physical file of a target: ids are validated, so the path stays in the store.
  private file(t: OverrideTarget) { return join(this.root, overrideFile(overrideTarget(t.scope, t.project, t.workflow))) }
  private revFile(t: OverrideTarget) { return `${this.file(t)}.revisions.jsonl` }

  private async revisions(t: OverrideTarget): Promise<StoredRevision[]> {
    const text = await readTextOrNull(this.revFile(t))
    if (!text) return []
    return text.split('\n').filter(Boolean).map((l, i) => {
      try { return JSON.parse(l) as StoredRevision } catch { throw new RequestError(500, `${overrideFile(t)}.revisions.jsonl line ${i + 1} is not JSON; fix it by hand`) }
    })
  }

  async read(t: OverrideTarget): Promise<OverrideState> {
    t = overrideTarget(t.scope, t.project, t.workflow)
    const base: OverrideState = { target: t, file: overrideFile(t), text: null, sha256: null, revision: null, updated: null, external: false, revisions: 0 }
    let text: string | null
    try { text = await readTextOrNull(this.file(t)) } catch (e) { return { ...base, problem: `cannot be read: ${(e as Error).message}` } }
    let revs: StoredRevision[]
    try { revs = await this.revisions(t) } catch (e) { return { ...base, text, sha256: text === null ? null : sha256(text), problem: (e as Error).message } }
    const last = revs.at(-1)
    const h = text === null ? null : sha256(text)
    const external = (last?.sha256 ?? null) !== h
    return { ...base, text, sha256: h, revision: !external && last ? last.rev : null, updated: !external && last ? { at: last.at, by: last.by } : null, external, revisions: revs.length }
  }

  async history(t: OverrideTarget): Promise<(OverrideRevision & { text: string | null })[]> {
    return (await this.revisions(overrideTarget(t.scope, t.project, t.workflow))).map(r => ({ ...r, target: overrideKey(t) }))
  }

  // Saves (text) or clears (null or blank) an override. `base` is the
  // sha256 of the content the writer saw (null: none). Returns the new state
  // and whether anything changed.
  async write(t: OverrideTarget, text: string | null, o: { by: string; base: string | null; note?: string }): Promise<{ state: OverrideState; changed: boolean }> {
    t = overrideTarget(t.scope, t.project, t.workflow)
    if (!o.by?.trim()) throw new RequestError(400, 'by is required: who writes the override')
    const next = text === null || !text.trim() ? null : text.endsWith('\n') ? text : `${text}\n`
    if (next !== null && Buffer.byteLength(next) > MAX_OVERRIDE_BYTES) throw new RequestError(413, `an override is at most ${MAX_OVERRIDE_BYTES} bytes; put larger material in a file and name it`)
    const file = this.file(t)
    await mkdir(dirname(file), { recursive: true })
    return withLock(file, async () => {
      const cur = await this.read(t)
      if (cur.problem) throw new RequestError(409, `${cur.file} ${cur.problem}`)
      if ((o.base ?? null) !== cur.sha256) throw new RequestError(409, `${cur.file} changed since it was read (now ${cur.sha256 ? `${cur.sha256.slice(0, 12)}, revision ${cur.revision ?? 'outside WFE'}` : 'empty'}); read it again and reapply your change`, { code: 'context-conflict', current: cur })
      const nextHash = next === null ? null : sha256(next)
      if (nextHash === cur.sha256) return { state: cur, changed: false }
      const revs = await this.revisions(t)
      const at = new Date().toISOString()
      const add = async (r: Omit<StoredRevision, 'target'>) => appendFile(this.revFile(t), `${JSON.stringify(r)}\n`)
      let rev = revs.at(-1)?.rev ?? 0
      // Content written by hand is kept as a revision of its own first.
      if (cur.external) await add({ rev: ++rev, at, by: 'edited outside WFE', sha256: cur.sha256, text: cur.text, external: true })
      if (next === null) await rm(file, { force: true })
      else await atomicWrite(file, next)
      await add({ rev: ++rev, at, by: o.by.trim(), sha256: nextHash, text: next, ...(o.note ? { note: o.note } : {}) })
      return { state: await this.read(t), changed: true }
    }, { what: overrideFile(t) })
  }

  // Every override present in the store, for the matrix.
  async list(): Promise<OverrideState[]> {
    const out: OverrideState[] = [await this.read({ scope: 'system' })]
    const dir = join(this.root, 'contexts', 'projects')
    const names = async (d: string) => (await readdir(d, { withFileTypes: true }).catch(() => [])).filter(e => ID_PATTERN.test(e.name.replace(/\.md$/, '')))
    for (const p of await names(dir)) {
      if (!p.isDirectory()) continue
      out.push(await this.read({ scope: 'project', project: p.name }))
      for (const w of await names(join(dir, p.name, 'workflows'))) if (w.isFile() && w.name.endsWith('.md')) out.push(await this.read({ scope: 'workflow', project: p.name, workflow: w.name.slice(0, -3) }))
    }
    return out.filter(s => s.text !== null || s.revisions > 0 || s.problem)
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
    if (b.schema !== CONTEXT_SCHEMA) return { unavailable: `snapshot ${id} has schema ${String(b.schema)}` }
    return b
  }
}
