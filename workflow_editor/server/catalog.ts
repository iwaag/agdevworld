// The person's node catalog on disk (p7/ex1, docs/catalog.md): one file per
// operating area, <area>/node-catalog.json. Every reader and writer — the
// service, the CLI, run creation — goes through these operations, so the
// validation, the stale-edit check and the one-time initialization live
// once. An unreadable catalog is reported, never treated as empty and never
// replaced by defaults.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  CATALOG_FILE, CatalogError, contentOf, contentProblems, EXAMPLES, newCatalog, parseCatalog, sameContent, snapshotOf,
  type Catalog, type CatalogSnapshot, type NodeTemplate, type TemplateContent,
} from '../shared/catalog.ts'
import { ID_PATTERN } from '../shared/model.ts'
import { atomicWrite, createExclusive, readTextOrNull } from './files.ts'
import { withLock } from './lock.ts'
import { parseWorkflow, renderWorkflow } from './yamlDoc.ts'
import { RequestError, WORKFLOWS_DIR, type Workspace } from './workspace.ts'
import { instantiate, type InstantiateOptions } from '../shared/catalog.ts'

export type CatalogReading =
  | { state: 'ok'; file: string; catalog: Catalog; initializedNow?: boolean }
  | { state: 'unavailable'; file: string; problem: string }

export const catalogFile = (area: string) => join(area, CATALOG_FILE)
const now = () => new Date().toISOString()
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex')
const textOf = (c: Catalog) => `${JSON.stringify(c, null, 2)}\n`

async function readOnce(file: string): Promise<CatalogReading | null> {
  let text: string | null
  try { text = await readTextOrNull(file) } catch (e) { return { state: 'unavailable', file, problem: `${CATALOG_FILE} cannot be read: ${(e as Error).message}` } }
  if (text === null) return null
  let raw: unknown
  try { raw = JSON.parse(text) } catch (e) { return { state: 'unavailable', file, problem: `${CATALOG_FILE} is not valid JSON: ${(e as Error).message}` } }
  try { return { state: 'ok', file, catalog: parseCatalog(raw) } } catch (e) { return { state: 'unavailable', file, problem: `${CATALOG_FILE}: ${(e as Error).message}` } }
}

// Reads the area's catalog. The first read that finds no file initializes
// it (exclusively: a file that appeared meanwhile is read, not replaced),
// with the p7 presets as the person's templates. The file's existence is
// the record that this happened, so a later release never seeds again.
export async function readCatalog(area: string): Promise<CatalogReading> {
  const file = catalogFile(area)
  const first = await readOnce(file)
  if (first) return first
  try {
    await createExclusive(file, textOf(newCatalog(now())))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { state: 'unavailable', file, problem: `${CATALOG_FILE} could not be created: ${(e as Error).message}` }
  }
  const r = await readOnce(file)
  if (!r) return { state: 'unavailable', file, problem: `${CATALOG_FILE} disappeared while it was being created` }
  return r.state === 'ok' ? { ...r, initializedNow: true } : r
}

const usable = (r: CatalogReading): Catalog => {
  if (r.state !== 'ok') throw new RequestError(409, `the node catalog is unavailable, so it is not changed: ${r.problem}. Fix or move the file by hand; it is never replaced with defaults.`, { code: 'catalog-unavailable' })
  return r.catalog
}

// One change, under the catalog's lock: read, check, apply, validate,
// replace atomically. The generation counts writes.
async function change<T>(area: string, f: (c: Catalog) => T): Promise<{ catalog: Catalog; result: T }> {
  const file = catalogFile(area)
  await readCatalog(area) // initialize first if there is no file
  return withLock(file, async () => {
    const c = structuredClone(usable(await readCatalog(area)))
    const result = f(c)
    c.generation += 1
    parseCatalog(JSON.parse(JSON.stringify(c))) // what is written must read back
    await atomicWrite(file, textOf(c))
    return { catalog: c, result }
  }, { what: 'the node catalog' })
}

const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
  try { return await f() } catch (e) {
    if (e instanceof CatalogError) throw new RequestError(e.code === 'template-stale' || e.code === 'template-exists' || e.code === 'template-retired' ? 409 : e.code === 'template-unknown' ? 404 : 422, e.message, { code: e.code })
    throw e
  }
}
const cfail = (code: string, message: string): never => { throw new CatalogError(code, message) }
const declared = (by: string | undefined) => { const b = by?.trim(); if (!b) return cfail('template-by', 'who makes the change is required (by)'); return b! }

export function templateIn(c: Catalog, id: string): NodeTemplate {
  return c.templates.find(t => t.id === id) ?? cfail('template-unknown', `the node catalog has no template "${id}"${c.deleted.some(d => d.id === id) ? ' (it was deleted)' : ''}`)
}

export async function createTemplate(area: string, id: string, content: TemplateContent, by: string): Promise<{ catalog: Catalog; template: NodeTemplate }> {
  return wrap(async () => {
    const who = declared(by)
    if (!ID_PATTERN.test(id)) cfail('template-id', `template id "${id}" must match ${ID_PATTERN.source}`)
    const problems = contentProblems(content)
    if (problems.length) cfail('template-invalid', problems.join('; '))
    const r = await change(area, c => {
      if (c.templates.some(t => t.id === id)) cfail('template-exists', `template "${id}" exists; edit it instead`)
      if (c.deleted.some(d => d.id === id)) cfail('template-retired', `template id "${id}" was used by a deleted template; ids are not reused, so nodes made from it keep meaning one thing`)
      const t: NodeTemplate = { id, revision: 1, ...contentOf(content), updated: now(), by: who }
      c.templates.push(t)
      return t
    })
    return { catalog: r.catalog, template: r.result }
  })
}

// An edit based on revision `expectRevision`. Content that is the same as
// stored changes nothing (not even the revision).
export async function updateTemplate(area: string, id: string, content: TemplateContent, expectRevision: number, by: string): Promise<{ catalog: Catalog; template: NodeTemplate; changed: boolean }> {
  return wrap(async () => {
    const who = declared(by)
    const problems = contentProblems(content)
    if (problems.length) cfail('template-invalid', problems.join('; '))
    const cur = templateIn(usable(await readCatalog(area)), id)
    if (cur.revision === expectRevision && sameContent(cur, content)) return { catalog: usable(await readCatalog(area)), template: cur, changed: false }
    const r = await change(area, c => {
      const t = templateIn(c, id)
      if (t.revision !== expectRevision) cfail('template-stale', `template "${id}" is at revision ${t.revision}, not ${expectRevision}: it changed since it was read. Read it again and redo the edit.`)
      Object.assign(t, contentOf(content), { revision: t.revision + 1, updated: now(), by: who })
      if (!content.appearance || !(content.appearance.icon || content.appearance.color)) delete t.appearance
      return t
    })
    return { catalog: r.catalog, template: r.result, changed: true }
  })
}

export async function deleteTemplate(area: string, id: string, expectRevision: number, by: string): Promise<{ catalog: Catalog }> {
  return wrap(async () => {
    const who = declared(by)
    const r = await change(area, c => {
      const t = templateIn(c, id)
      if (t.revision !== expectRevision) cfail('template-stale', `template "${id}" is at revision ${t.revision}, not ${expectRevision}; read it again before deleting it`)
      c.templates = c.templates.filter(x => x.id !== id)
      c.deleted.push({ id, revision: t.revision, at: now(), by: who })
    })
    return { catalog: r.catalog }
  })
}

export async function addExample(area: string, example: string, by: string, id?: string): Promise<{ catalog: Catalog; template: NodeTemplate }> {
  const content = EXAMPLES[example]
  if (!content) throw new RequestError(404, `no example "${example}" (examples: ${Object.keys(EXAMPLES).join(', ')})`)
  return createTemplate(area, id ?? example, content, by)
}

// ---- run snapshots ---------------------------------------------------------------

// What a new run is given: the catalog as it is now, as the file to write
// into the run folder and the facts run.json records (docs/catalog.md).
export async function snapshotForRun(area: string): Promise<{ state: 'supplied'; text: string; sha256: string; snapshot: CatalogSnapshot } | { state: 'unavailable'; problem: string }> {
  const r = await readCatalog(area)
  if (r.state !== 'ok') return { state: 'unavailable', problem: r.problem }
  const snapshot = snapshotOf(r.catalog, now())
  const text = `${JSON.stringify(snapshot, null, 2)}\n`
  return { state: 'supplied', text, sha256: sha256(text), snapshot }
}


// ---- instantiation into files ----------------------------------------------------------

type Source = Pick<NodeTemplate, 'id' | 'revision'> & TemplateContent

// A template into a workflow text (a saved workflow or a draft of a run
// revision): the same model operation as the browser's, written back with
// the editor's YAML round trip so the rest of the file stays as it was.
export function instantiateText(text: string, t: Source, o: InstantiateOptions): { text: string; node: string } {
  const parsed = parseWorkflow(text)
  if (!parsed.ok) throw new RequestError(409, `the definition cannot be read: ${parsed.problem.message}`)
  try {
    const r = instantiate(parsed.model, t, o)
    return { text: renderWorkflow(parsed.doc, r.workflow), node: r.node }
  } catch (e) {
    if (e instanceof CatalogError) throw new RequestError(422, e.message, { code: e.code })
    throw e
  }
}

// A template of the area's catalog into a workflow of a workspace
// (devdocs/workflows/<file>).
export async function instantiateIntoWorkflow(area: string, ws: Workspace, file: string, templateId: string, o: InstantiateOptions): Promise<{ file: string; node: string; template: NodeTemplate; rev: string }> {
  const t = await wrap(async () => templateIn(usable(await readCatalog(area)), templateId))
  const read = await ws.workflowResponse(file)
  if (read.text === null || !read.workflow) throw new RequestError(409, `${WORKFLOWS_DIR}/${file} cannot be read: ${read.problem?.message ?? 'missing'}`)
  const r = instantiateText(read.text, t, o)
  const parsed = parseWorkflow(r.text)
  const saved = await ws.saveWorkflow(file, (parsed as { model: Parameters<Workspace['saveWorkflow']>[1] }).model)
  return { file, node: r.node, template: t, rev: saved.rev }
}
