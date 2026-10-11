// Round-trip YAML: parse into a Document, check the supported subset, and
// apply an edited model back onto the same Document so that comments, key
// order, styles and unrelated fields survive. There is no text patching.
import {
  Document, isMap, isPair, isScalar, isSeq, parseAllDocuments, visit,
  type Node as YamlNode, type ToStringOptions,
} from 'yaml'
import {
  projectFromData, workflowFromData, type Project, type ShapeIssue, type Workflow,
} from '../shared/model.ts'

export const STRINGIFY: ToStringOptions = { lineWidth: 0, minContentWidth: 0, flowCollectionPadding: false }

export type ReadProblem =
  | { kind: 'malformed'; message: string; line?: number; col?: number }
  | { kind: 'unsupported'; message: string; line?: number; col?: number }
  | { kind: 'shape'; message: string; issues: ShapeIssue[] }

export type Parsed<T> = { ok: true; doc: Document; model: T } | { ok: false; problem: ReadProblem; doc?: Document }

function position(text: string, offset: number | undefined): { line?: number; col?: number } {
  if (offset === undefined) return {}
  const before = text.slice(0, offset).split('\n')
  return { line: before.length, col: before[before.length - 1].length + 1 }
}

// The supported subset: one YAML 1.2 document whose mappings have plain text
// keys; scalars, block or flow mappings and sequences, and comments. Anchors,
// aliases, explicit tags, merge keys and multiple documents are rejected.
export function parseSubset(text: string): { ok: true; doc: Document } | { ok: false; problem: ReadProblem } {
  const docs = parseAllDocuments(text, { prettyErrors: false, uniqueKeys: true })
  if (!Array.isArray(docs)) return { ok: false, problem: { kind: 'malformed', message: 'not a YAML document stream' } }
  if (docs.length === 0) return { ok: false, problem: { kind: 'malformed', message: 'the file is empty' } }
  const first = docs[0]
  for (const d of docs) {
    if (d.errors.length) {
      const e = d.errors[0]
      return { ok: false, problem: { kind: 'malformed', message: e.message.split('\n')[0], ...position(text, e.pos?.[0]) } }
    }
  }
  if (docs.length > 1) return { ok: false, problem: { kind: 'unsupported', message: 'multiple YAML documents in one file', ...position(text, docs[1].range?.[0]) } }
  let problem: ReadProblem | null = null
  const reject = (message: string, node?: { range?: [number, number, number] | null }) => {
    problem ??= { kind: 'unsupported', message, ...position(text, node?.range?.[0]) }
    return visit.BREAK
  }
  visit(first, {
    Alias(_, node) { return reject('aliases (*name) are not supported', node) },
    Node(_, node) {
      const n = node as YamlNode & { anchor?: string; tag?: string }
      if (n.anchor) return reject(`anchors (&${n.anchor}) are not supported`, n)
      if (n.tag) return reject(`explicit tags (${n.tag}) are not supported`, n)
      return undefined
    },
    Pair(_, pair) {
      const key = pair.key
      if (!isScalar(key) || typeof key.value !== 'string') return reject('mapping keys must be plain text', isScalar(key) ? key : undefined)
      if (key.value === '<<') return reject('merge keys (<<) are not supported', key)
      return undefined
    },
  })
  if (problem) return { ok: false, problem }
  return { ok: true, doc: first }
}

export function parseWorkflow(text: string): Parsed<Workflow> {
  const r = parseSubset(text)
  if (!r.ok) return r
  const { workflow, issues } = workflowFromData(r.doc.toJS())
  if (issues.length) return { ok: false, doc: r.doc, problem: { kind: 'shape', message: issues.map(i => `${i.path}: ${i.message}`).join('; '), issues } }
  return { ok: true, doc: r.doc, model: workflow }
}

export function parseProject(text: string): Parsed<Project> {
  const r = parseSubset(text)
  if (!r.ok) return r
  const { project, issues } = projectFromData(r.doc.toJS())
  if (issues.length) return { ok: false, doc: r.doc, problem: { kind: 'shape', message: issues.map(i => `${i.path}: ${i.message}`).join('; '), issues } }
  return { ok: true, doc: r.doc, model: project }
}

// ---- applying a model onto a document ------------------------------------

// A shape tells the sync which keys the model owns. "record" owns only the
// listed fields (others are preserved); "dict" owns every key (entries);
// "list" is a sequence compared item by item; "scalar" is a leaf.
type Shape =
  | { kind: 'scalar' }
  | { kind: 'list'; item: Shape; block?: boolean }
  | { kind: 'record'; fields: Record<string, Shape>; flow?: boolean }
  | { kind: 'dict'; value: Shape }

const scalar: Shape = { kind: 'scalar' }
const record = (fields: Record<string, Shape>, flow = false): Shape => ({ kind: 'record', fields, flow })
const dict = (value: Shape): Shape => ({ kind: 'dict', value })
const list = (item: Shape, block = false): Shape => ({ kind: 'list', item, block })

const approval = record({ digest: scalar, approver: scalar, at: scalar })
export const WORKFLOW_SHAPE = record({
  schema: scalar, id: scalar, name: scalar, intent: scalar,
  repositories: dict(record({ path: scalar, access: scalar }, true)),
  nodes: dict(record({ type: scalar, name: scalar, description: scalar, repositories: list(scalar), workflow: scalar })),
  edges: list(record({ from: scalar, to: scalar }, true)),
  approvals: record({ intent: approval, definition: approval }),
  layout: record({ nodes: dict(record({ x: scalar, y: scalar }, true)) }),
})
// Goals are sentences: a new goals list is written one item per line.
export const PROJECT_SHAPE = record({ schema: scalar, id: scalar, name: scalar, devdocs: scalar, intent: scalar, goals: list(scalar, true) })

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function nodeJs(node: unknown): unknown {
  if (node && typeof node === 'object' && 'toJSON' in node && typeof (node as { toJSON: unknown }).toJSON === 'function') {
    return (node as { toJSON: () => unknown }).toJSON()
  }
  return isScalar(node) ? node.value : node
}

function isAbsent(value: unknown) {
  return value === undefined
}

// The model reads an absent key as empty. So an empty value for a key the
// file does not have is not written: untouched entries keep their text.
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  if (value && typeof value === 'object') return Object.values(value).every(isEmpty)
  return false
}

// Creates a node for a new value, styled the way the shape says: multiline
// text as a literal block, small records (bindings, edges, points) in flow.
function makeNode(doc: Document, value: unknown, shape: Shape, flow = false): YamlNode {
  const node = doc.createNode(value) as YamlNode
  styleNode(node, shape, flow)
  return node
}

function styleNode(node: unknown, shape: Shape, flow: boolean) {
  if (isScalar(node)) {
    if (typeof node.value === 'string' && node.value.includes('\n')) node.type = 'BLOCK_LITERAL'
    return
  }
  if (isSeq(node)) {
    if (flow || (shape.kind === 'list' && shape.item.kind === 'scalar' && !shape.block)) node.flow = true
    if (shape.kind === 'list') for (const item of node.items) styleNode(item, shape.item, false)
    return
  }
  if (isMap(node)) {
    if (flow || (shape.kind === 'record' && shape.flow)) node.flow = true
    for (const pair of node.items) {
      const k = isScalar(pair.key) ? String(pair.key.value) : ''
      const sub = shape.kind === 'dict' ? shape.value : shape.kind === 'record' ? shape.fields[k] : undefined
      if (sub) styleNode(pair.value, sub, false)
    }
  }
}

function setScalar(doc: Document, parent: YamlNode, key: string | number, value: unknown) {
  const existing = isMap(parent) ? parent.get(key, true) : isSeq(parent) ? parent.get(key as number, true) : undefined
  if (isScalar(existing) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
    if (existing.value === value) return
    existing.value = value
    if (typeof value === 'string' && value.includes('\n') && existing.type !== 'BLOCK_LITERAL' && existing.type !== 'BLOCK_FOLDED') existing.type = 'BLOCK_LITERAL'
    if (typeof value === 'string' && !value.includes('\n') && (existing.type === 'BLOCK_LITERAL' || existing.type === 'BLOCK_FOLDED')) existing.type = undefined
    if (typeof value !== 'string' || (existing.type === 'PLAIN' && value === '')) existing.type = undefined
    return
  }
  const node = makeNode(doc, value, scalar)
  if (isMap(parent)) parent.set(key, node)
  else if (isSeq(parent)) parent.set(key as number, node)
}

function syncChild(doc: Document, parent: YamlNode, key: string | number, value: unknown, shape: Shape) {
  const get = () => (isMap(parent) ? parent.get(key, true) : isSeq(parent) ? parent.get(key as number, true) : undefined) as YamlNode | undefined
  if (isAbsent(value)) {
    if (isMap(parent) && parent.has(key)) parent.delete(key)
    return
  }
  const current = get()
  if (current === undefined && isEmpty(value) && !(isMap(parent) && parent.has(key))) return
  if (shape.kind === 'scalar') { setScalar(doc, parent, key, value); return }
  if (shape.kind === 'list') {
    const items = value as unknown[]
    if (isSeq(current)) { syncList(doc, current, items, shape.item); return }
    const node = makeNode(doc, prune(items, shape), shape)
    if (isMap(parent)) parent.set(key, node); else if (isSeq(parent)) parent.set(key as number, node)
    return
  }
  if (isMap(current)) { syncMap(doc, current, value as Record<string, unknown>, shape); return }
  const node = makeNode(doc, prune(value, shape), shape)
  if (isMap(parent)) parent.set(key, node); else if (isSeq(parent)) parent.set(key as number, node)
}

// Drops undefined fields so that createNode does not emit nulls for them.
function prune(value: unknown, shape: Shape): unknown {
  if (shape.kind === 'scalar' || value === null || typeof value !== 'object') return value
  if (shape.kind === 'list') return (value as unknown[]).map(v => prune(v, shape.item))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue
    const sub = shape.kind === 'dict' ? shape.value : shape.fields[k]
    out[k] = sub ? prune(v, sub) : v
  }
  return out
}

function syncList(doc: Document, seq: YamlNode, items: unknown[], item: Shape) {
  if (!isSeq(seq)) return
  if (same(nodeJs(seq), items)) return
  const flowItems = seq.items.length > 0 && seq.items.every(i => (isMap(i) || isSeq(i)) && i.flow)
  items.forEach((value, i) => {
    const existing = seq.items[i]
    if (existing !== undefined && same(nodeJs(existing), value)) return
    if (existing !== undefined && item.kind === 'record' && isMap(existing)) { syncMap(doc, existing, value as Record<string, unknown>, item); return }
    if (existing !== undefined && item.kind === 'scalar') { setScalar(doc, seq, i, value); return }
    const node = makeNode(doc, prune(value, item), item, flowItems)
    if (i < seq.items.length) seq.items[i] = node; else seq.items.push(node)
  })
  seq.items.splice(items.length)
}

function syncMap(doc: Document, map: YamlNode, value: Record<string, unknown>, shape: Shape) {
  if (!isMap(map)) return
  if (shape.kind === 'dict') {
    for (const pair of [...map.items]) {
      const k = isPair(pair) && isScalar(pair.key) ? pair.key.value : undefined
      if (typeof k === 'string' && !(k in value)) map.delete(k)
    }
    for (const [k, v] of Object.entries(value)) syncChild(doc, map, k, v, shape.value)
    return
  }
  if (shape.kind !== 'record') return
  for (const [k, sub] of Object.entries(shape.fields)) syncChild(doc, map, k, value[k], sub)
}

// Brings `doc` in line with `model` for the fields the model owns. Fields
// outside the shape, and comments attached to untouched nodes, are kept.
export function applyModel(doc: Document, model: object, shape: Shape) {
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as never
  syncMap(doc, doc.contents as YamlNode, model as Record<string, unknown>, shape)
}

// Model -> plain object in file order. Optional node fields that are empty
// are omitted; an absent approval kind is removed from the file.
export function workflowForWrite(w: Workflow): Record<string, unknown> {
  const nodes: Record<string, unknown> = {}
  for (const [id, n] of Object.entries(w.nodes)) {
    nodes[id] = {
      type: n.type, name: n.name || undefined, description: n.description,
      repositories: n.repositories, workflow: n.workflow || undefined,
    }
  }
  const approvals: Record<string, unknown> = {}
  for (const [k, a] of Object.entries(w.approvals)) if (a) approvals[k] = a
  return {
    schema: w.schema, id: w.id, name: w.name, intent: w.intent,
    repositories: w.repositories, nodes, edges: w.edges,
    approvals, layout: w.layout,
  }
}

export function projectForWrite(p: Project): Record<string, unknown> {
  return { schema: p.schema, id: p.id, name: p.name, devdocs: p.devdocs, intent: p.intent, goals: p.goals }
}

export function renderWorkflow(doc: Document, w: Workflow): string {
  applyModel(doc, workflowForWrite(w), WORKFLOW_SHAPE)
  return doc.toString(STRINGIFY)
}

export function renderProject(doc: Document, p: Project): string {
  applyModel(doc, projectForWrite(p), PROJECT_SHAPE)
  return doc.toString(STRINGIFY)
}

export function newWorkflowText(w: Workflow): string {
  const doc = new Document({})
  doc.commentBefore = ' Workflow definition (ag.workflow.v1). Edit here or in the workflow editor.'
  return renderWorkflow(doc, w)
}

export function newProjectText(p: Project): string {
  const doc = new Document({})
  doc.commentBefore = ' Project definition (ag.project.v2). Repositories come from .gitmodules.'
  return renderProject(doc, p)
}
