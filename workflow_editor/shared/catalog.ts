// The person's node catalog (p7/ex1, docs/catalog.md): reusable node
// templates over the existing node types, each with a description for the
// agent performing the activity and an expectation for whoever designs the
// workflow. Shared by the service, the CLI and the browser: the shapes, the
// validation, the seeds and the example, and instantiation — a template
// copied into an ordinary workflow node with its provenance.
import { canonicalJson } from './canonical.ts'
import { APPEARANCE_COLORS, APPEARANCE_ICONS, ID_PATTERN, type Appearance, type Workflow, type WorkflowNode } from './model.ts'

export const CATALOG_SCHEMA = 'ag.node-catalog.v1'
export const SNAPSHOT_SCHEMA = 'ag.node-catalog-snapshot.v1'
export const CATALOG_FILE = 'node-catalog.json'
// The types a template may have: the execution types a run performs.
// Delegate nodes are not executed, so no template suggests otherwise.
export const TEMPLATE_TYPES = ['study', 'do', 'talk'] as const
export type TemplateType = typeof TEMPLATE_TYPES[number]

// What a template says. Everything here is its content: a change of any of
// it is a new revision.
export interface TemplateContent {
  name: string
  type: string
  description: string // for the agent performing the activity
  expectation: string // for the designer of the workflow: how the person expects it to appear
  appearance?: Appearance
}
export interface NodeTemplate extends TemplateContent {
  id: string
  revision: number
  updated: string
  by: string
}
export interface Catalog {
  schema: string
  generation: number
  initialized: { by: string; at: string; seeded: string[] } | null
  templates: NodeTemplate[]
  deleted: { id: string; revision: number; at: string; by: string }[]
}
// What a run is given (docs/catalog.md, "A run's catalog snapshot").
export interface CatalogSnapshot {
  schema: string
  generation: number
  taken: string
  templates: (TemplateContent & { id: string; revision: number })[]
}
// What run.json says about it: the snapshot by file and hash, or why there is none.
export type CatalogContext =
  | { state: 'supplied'; file: string; sha256: string; generation: number; templates: number }
  | { state: 'unavailable'; problem: string }

// What a run was given, as views and the brief read it: the frozen
// snapshot, why there is none, or that the run predates catalogs.
export type RunCatalog = { state: 'supplied'; file: string; sha256: string; snapshot: CatalogSnapshot } | { state: 'unavailable'; problem: string } | { state: 'none' }
// What an attempt records it was given (attempt.begin settings).
export type AttemptCatalog = { state: 'supplied'; sha256: string; templates: number } | { state: 'unavailable' }

// The run's catalog in an attempt's brief (docs/catalog.md, "Delivered").
// The meaning is stated once; each template's id, name, type and
// expectation follow; tool usage stays in the tools' help.
export const CATALOG_MEANING = 'The person recognizes these activities as distinct steps. When relevant to this request, they generally expect them to be visible as workflow nodes. Choose whether and where to represent them using the request and the current workflow.'
export function catalogBrief(c: RunCatalog, run: string): string[] {
  if (c.state === 'none') return []
  if (c.state === 'unavailable') return ['', `The person's node catalog could not be read when this run was created (${c.problem}), so which activities they expect as distinct workflow nodes is not known for this run.`]
  const t = c.snapshot.templates
  if (!t.length) return ['', 'The person\'s node catalog was empty when this run was created: they have named no activity they expect as a workflow node of its own.']
  return ['', `The person's node catalog, as it was when this run was created (wfe run nodes ${run} shows each template in full):`, CATALOG_MEANING,
    ...t.map(x => `- ${x.id} "${x.name}" (${x.type}, revision ${x.revision}): ${x.expectation.trim().split('\n').join(' ')}`),
    `A node from one of them goes into a draft of this run's definition with wfe nodes instantiate <template> --run ${run} --file <draft> (wfe nodes help); the draft becomes future work with wfe run adjust, with --source request when the request already asks for that work (wfe run help adjust).`]
}

// A node's provenance (docs/contract.md, "Template provenance"): outside
// every digest and the compiled graph.
export interface TemplateRef { id: string; revision: number; expectation: string }

export class CatalogError extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}
const fail = (code: string, message: string): never => { throw new CatalogError(code, message) }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Problems with one template's content, as messages; empty when it is valid.
export function contentProblems(t: Partial<TemplateContent>): string[] {
  const out: string[] = []
  const txt = (v: unknown) => typeof v === 'string' && v.trim() !== ''
  if (!txt(t.name)) out.push('name is required')
  if (!(TEMPLATE_TYPES as readonly string[]).includes(t.type as string)) out.push(t.type === 'delegate' ? 'type delegate is not offered: delegate nodes are not executed, and a template names no target workflow' : `type must be one of ${TEMPLATE_TYPES.join(', ')}`)
  if (!txt(t.description)) out.push('description is required: what the agent performing this activity does and records')
  if (!txt(t.expectation)) out.push('expectation is required: how you expect this activity to appear in a workflow')
  if (t.appearance !== undefined) {
    if (!isObj(t.appearance) || typeof t.appearance.icon !== 'string' || typeof t.appearance.color !== 'string') out.push('appearance must be {icon, color}')
    else {
      if (t.appearance.icon && !(APPEARANCE_ICONS as readonly string[]).includes(t.appearance.icon)) out.push(`icon "${t.appearance.icon}" is not one of ${APPEARANCE_ICONS.join(', ')}`)
      if (t.appearance.color && !(APPEARANCE_COLORS as readonly string[]).includes(t.appearance.color)) out.push(`color "${t.appearance.color}" is not one of ${APPEARANCE_COLORS.join(', ')}`)
    }
  }
  return out
}

// The content of a template as stored: trimmed name, no empty appearance.
export function normalizeContent(t: TemplateContent): TemplateContent {
  const a = t.appearance && (t.appearance.icon || t.appearance.color) ? { appearance: { icon: t.appearance.icon ?? '', color: t.appearance.color ?? '' } } : {}
  return { name: t.name.trim(), type: t.type, description: t.description, expectation: t.expectation, ...a }
}
export const contentOf = (t: TemplateContent): TemplateContent => normalizeContent({ name: t.name, type: t.type, description: t.description, expectation: t.expectation, ...(t.appearance ? { appearance: t.appearance } : {}) })
export const sameContent = (a: TemplateContent, b: TemplateContent) => canonicalJson(contentOf(a)) === canonicalJson(contentOf(b))

// Reads parsed JSON as a catalog; throws CatalogError('catalog-invalid')
// naming the first problem. A catalog that does not read is never treated
// as empty.
export function parseCatalog(raw: unknown): Catalog {
  if (!isObj(raw)) return fail('catalog-invalid', 'the catalog is not a JSON object')
  if (raw.schema !== CATALOG_SCHEMA) return fail('catalog-invalid', `schema is "${String(raw.schema)}"; this release reads ${CATALOG_SCHEMA}`)
  if (typeof raw.generation !== 'number' || !Number.isInteger(raw.generation) || raw.generation < 0) fail('catalog-invalid', 'generation must be a non-negative integer')
  if (!Array.isArray(raw.templates)) fail('catalog-invalid', 'templates must be a list')
  const deleted = raw.deleted === undefined ? [] : raw.deleted
  if (!Array.isArray(deleted)) fail('catalog-invalid', 'deleted must be a list')
  const seen = new Set<string>()
  const templates = (raw.templates as unknown[]).map((t, i) => {
    if (!isObj(t)) return fail('catalog-invalid', `template ${i + 1} is not an object`)
    const id = String(t.id ?? '')
    if (!ID_PATTERN.test(id)) fail('catalog-invalid', `template ${i + 1}: id "${id}" must match ${ID_PATTERN.source}`)
    if (seen.has(id)) fail('catalog-invalid', `template id "${id}" appears twice`)
    seen.add(id)
    if (typeof t.revision !== 'number' || !Number.isInteger(t.revision) || t.revision < 1) fail('catalog-invalid', `template ${id}: revision must be a positive integer`)
    for (const k of ['name', 'type', 'description', 'expectation', 'updated', 'by']) if (typeof t[k] !== 'string') fail('catalog-invalid', `template ${id}: ${k} must be text`)
    const content = { name: t.name, type: t.type, description: t.description, expectation: t.expectation, ...(t.appearance !== undefined ? { appearance: t.appearance } : {}) } as TemplateContent
    const problems = contentProblems(content)
    if (problems.length) fail('catalog-invalid', `template ${id}: ${problems.join('; ')}`)
    return { id, revision: t.revision as number, ...contentOf(content), updated: t.updated as string, by: t.by as string }
  })
  const gone = (deleted as unknown[]).map((d, i) => {
    if (!isObj(d) || typeof d.id !== 'string' || typeof d.revision !== 'number' || typeof d.at !== 'string' || typeof d.by !== 'string') return fail('catalog-invalid', `deleted entry ${i + 1} must be {id, revision, at, by}`)
    if (seen.has(d.id)) fail('catalog-invalid', `template id "${d.id}" is both present and deleted`)
    return { id: d.id, revision: d.revision, at: d.at, by: d.by }
  })
  let initialized: Catalog['initialized'] = null
  if (raw.initialized !== undefined && raw.initialized !== null) {
    const x = raw.initialized
    if (!isObj(x) || typeof x.by !== 'string' || typeof x.at !== 'string' || !Array.isArray(x.seeded) || !x.seeded.every(s => typeof s === 'string')) fail('catalog-invalid', 'initialized must be {by, at, seeded: [ids]}')
    initialized = { by: (x as Record<string, string>).by, at: (x as Record<string, string>).at, seeded: [...(x as { seeded: string[] }).seeded] }
  }
  return { schema: CATALOG_SCHEMA, generation: raw.generation as number, initialized, templates, deleted: gone }
}

export function parseSnapshot(raw: unknown): CatalogSnapshot {
  if (!isObj(raw) || raw.schema !== SNAPSHOT_SCHEMA) return fail('snapshot-invalid', `the run's catalog snapshot is not ${SNAPSHOT_SCHEMA}`)
  if (!Array.isArray(raw.templates)) return fail('snapshot-invalid', 'the snapshot lists no templates')
  return raw as unknown as CatalogSnapshot
}

export function snapshotOf(c: Catalog, taken: string): CatalogSnapshot {
  return { schema: SNAPSHOT_SCHEMA, generation: c.generation, taken, templates: c.templates.map(t => ({ id: t.id, revision: t.revision, ...contentOf(t) })) }
}

// ---- seeds and examples --------------------------------------------------------

// The p7 palette presets become the person's own templates at the catalog's
// one-time initialization (docs/catalog.md, "Reading and writing"). Their
// descriptions are p7's; the expectations say what the presets meant.
export const SEED_BY = 'workflow_editor p7/ex1'
export const SEEDS: Record<string, TemplateContent> = {
  present: {
    type: 'do', name: 'Present', appearance: { icon: 'present', color: 'teal' },
    description: 'Prepare the result for the person: freeze it as a presentation with an explanation of what changed, how to use it and what to check; start its server and confirm the review link opens.',
    expectation: 'When a run delivers something I can look at or try, I expect a node that presents it to me for review, before the step where I confirm the result.',
  },
  cleanup: {
    type: 'do', name: 'Clean up', appearance: { icon: 'cleanup', color: 'slate' },
    description: 'Stop what this run started for the review (presentation servers) and verify that it stopped; record the outcome.',
    expectation: 'When a run starts something for my review (a presentation server), I expect a node at the end that stops it and verifies that it stopped.',
  },
}
// Offered, never added by itself: the person chooses and edits it.
export const EXAMPLES: Record<string, TemplateContent> = {
  'preliminary-research': {
    type: 'study', name: 'Preliminary research', appearance: { icon: 'study', color: 'violet' },
    description: [
      'Research how this kind of change is usually done before the work it informs starts.',
      'Record in this node\'s report: the sources consulted (links or references), what each says that matters here, the approach chosen and why, the alternatives set aside, and what remains uncertain.',
    ].join('\n'),
    expectation: 'When I ask for research or investigation before implementing, I expect a study node before the work it informs, with its sources and findings in its own report.',
  },
}

export function newCatalog(at: string, seeded: Record<string, TemplateContent> = SEEDS): Catalog {
  return {
    schema: CATALOG_SCHEMA, generation: 1, initialized: { by: SEED_BY, at, seeded: Object.keys(seeded) },
    templates: Object.entries(seeded).map(([id, c]) => ({ id, revision: 1, ...contentOf(c), updated: at, by: SEED_BY })),
    deleted: [],
  }
}

// ---- instantiation ------------------------------------------------------------

export interface InstantiateOptions {
  id?: string // the new node's id; default the template id, made unique
  repositories?: string[] // binding keys of the target workflow
  after?: string[] // nodes the new node waits for
  before?: string[] // nodes that wait for the new node
}

export function uniqueNodeId(w: Pick<Workflow, 'nodes'>, base: string): string {
  if (!(base in w.nodes)) return base
  for (let n = 2; ; n++) { const id = `${base}-${n}`.slice(0, 64); if (!(id in w.nodes)) return id }
}

// A template copied into an ordinary node of `w` (a new workflow model; `w`
// is not changed). Never declares a binding, a delegate target or a result
// confirmation: the target workflow decides those.
export function instantiate(w: Workflow, t: Pick<NodeTemplate, 'id' | 'revision'> & TemplateContent, o: InstantiateOptions = {}): { workflow: Workflow; node: string } {
  const problems = contentProblems(t)
  if (problems.length) fail('template-invalid', `template ${t.id}: ${problems.join('; ')}`)
  const id = o.id ?? uniqueNodeId(w, t.id)
  if (!ID_PATTERN.test(id)) fail('node-id-invalid', `node id "${id}" must match ${ID_PATTERN.source}`)
  if (id in w.nodes) fail('node-id-taken', `the workflow already has a node "${id}"`)
  const repositories = [...new Set(o.repositories ?? [])]
  const unknown = repositories.filter(k => !(k in w.repositories))
  if (unknown.length) fail('template-binding', `binding${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not declared by workflow ${w.id || '(this workflow)'} (declared: ${Object.keys(w.repositories).join(', ') || 'none'}); instantiation never adds access`)
  for (const n of [...(o.after ?? []), ...(o.before ?? [])]) if (!(n in w.nodes)) fail('node-unknown', `node "${n}" is not in the workflow`)
  const node: WorkflowNode = {
    type: t.type, name: t.name, description: t.description, repositories,
    ...(t.appearance && (t.appearance.icon || t.appearance.color) ? { appearance: { ...t.appearance } } : {}),
    template: { id: t.id, revision: t.revision, expectation: t.expectation },
  }
  const next = structuredClone(w)
  next.nodes[id] = node
  for (const a of o.after ?? []) next.edges.push({ from: a, to: id })
  for (const b of o.before ?? []) next.edges.push({ from: id, to: b })
  // Inserted between two nodes that were directly connected: the direct
  // edge would bypass the new node, so it goes.
  for (const a of o.after ?? []) for (const b of o.before ?? []) next.edges = next.edges.filter(e => !(e.from === a && e.to === b))
  return { workflow: next, node: id }
}
