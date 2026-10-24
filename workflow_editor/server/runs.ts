// Workflow runs on disk (docs/runs.md): creation with the definition
// snapshot, reading and checking records, and operations that append one
// history entry in one atomic replacement of run.json. The rules are in
// shared/run.ts; this module only reads and writes files. The CLI and the
// service both call it.
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { FileProblem, RelatedRun, RunFile, RunResponse, RunSummary, SourceComparison } from '../shared/api.ts'
import { approvalStates, canonicalJson, semanticDigest } from '../shared/canonical.ts'
import { authoredNode, COMPILER_VERSION, compile, isGenerated, type EffectiveGraph, type StepSpec } from '../shared/compile.ts'
import { DEFAULT_LANE, docSteps, ID_PATTERN, normalizeRepoPath, type Workflow } from '../shared/model.ts'
import { validateWorkflow } from '../shared/validate.ts'
import {
  activeRevision, checkRecord, documentPath, graphOfState, hostOf, operate, presentationFolder, runDisplayTitle, type AdjustSource, type AdjustDiff, graphDiff, RUN_ID, RunError, runFolder, RUNS_ROOT, runKey, validRunRef, type Presentation,
  type BundleEntry, type DefinitionRef, type DocumentEvidence, type EntrustRef, type Executor, type OpInput, type RepoContext, type RunGraph,
  type EntryMeta, type RetroEvidence, type RunInput, type RunRecord, type RunRef, type RunState, type RunStorage,
} from '../shared/run.ts'
import { runStatus } from '../shared/status.ts'
import type { SourceRef } from '../shared/intake.ts'
import { atomicWrite, inside, readTextOrNull } from './files.ts'
import { MANIFEST_KIND } from '../shared/review.ts'
import { refsIn } from '../shared/shares.ts'
import { parseSnapshot, type CatalogContext, type CatalogSnapshot, type RunCatalog } from '../shared/catalog.ts'
import { withLock } from './lock.ts'
import { blobSizeAt, listAt, resolveRev, RevError, showAt, type DevdocsInfo, type DevdocsRev } from './devdocs.ts'
import { RequestError, WORKFLOWS_DIR, type Workspace } from './workspace.ts'
import { allocating, listCopies, prepareCopy, runSpace, storageOf, usedRuns } from './runspace.ts'
import { parseWorkflow, renderWorkflow } from './yamlDoc.ts'
import { git } from './git.ts'
import { CatalogError, instantiate } from '../shared/catalog.ts'
import { adviseOrRefuse, type Advice } from './reminders.ts'
import type { Boundary } from '../shared/reminders.ts'

export const RUN_FILE = 'run.json'
export const DEFINITION_DIR = 'definition'
// The person's node catalog as a run was given it (p7/ex1, docs/catalog.md).
export const CATALOG_SNAPSHOT = 'context/node-catalog.json'
const MAX_RUNS = 500
const MAX_FILES = 200
const MAX_READ = 1024 * 1024

// devdocs/runs/<workflow-id>/<run-id>/ (p4). The p3 layout
// (devdocs/<workflow-id>/runs/<run-id>/) is neither read nor converted.
export const RUNS_DIR = RUNS_ROOT
export const runDir = runFolder
const devdocsRel = (projectRel: string) => projectRel.slice('devdocs/'.length)
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const sigOf = async (path: string) => { const s = await stat(path).catch(() => null); return s ? `${s.size}:${s.mtimeMs}:${s.ino}` : null }

export function graphOf(w: Workflow): RunGraph {
  return {
    nodes: Object.fromEntries(Object.entries(w.nodes).map(([id, n]) => [id, authoredNode(n)])),
    edges: w.edges.map(e => ({ from: e.from, to: e.to })),
  }
}

// A record that cannot be used: shown, never rewritten.
export class RunProblem extends Error {
  problem: FileProblem & { code?: string }
  constructor(problem: FileProblem & { code?: string }) { super(problem.message); this.problem = problem }
}

// ---- reading ---------------------------------------------------------------------

// Reads files of one run from the working tree, or from a devdocs commit.
export interface Source {
  text(rel: string): Promise<string | null> // run-relative
  list(): Promise<RunFile[]>
}

function fsSource(dir: string): Source {
  return {
    text: rel => readTextOrNull(join(dir, rel)),
    async list() {
      const names = (await readdir(dir).catch(() => [] as string[])).filter(n => !n.startsWith('.')).sort().slice(0, MAX_FILES)
      const out: RunFile[] = []
      for (const name of names) {
        const s = await stat(join(dir, name)).catch(() => null)
        if (s?.isFile()) out.push({ name, size: s.size, modified: new Date(s.mtimeMs).toISOString() })
      }
      return out
    },
  }
}

// Files of one run as committed in the repository that owns devdocs.
function gitSource(info: DevdocsInfo, rev: DevdocsRev, runRel: string): Source {
  return {
    text: f => showAt(info, rev, `${runRel}/${f}`),
    async list() { return (await listAt(info, rev, runRel)).map(f => ({ ...f, modified: '' })) },
  }
}

export interface Bundle { entries: Record<string, { file: string; text?: string; workflow?: Workflow; problem?: string }>; graph?: RunGraph; problem?: string; revisions?: { revision: string; file: string; text: string; workflow: Workflow }[]; catalog?: CatalogSnapshot }

async function loadBundle(src: Source, def: unknown): Promise<Bundle> {
  const out: Bundle = { entries: {} }
  const d = def as DefinitionRef | undefined
  if (!d || typeof d !== 'object' || typeof d.root !== 'string' || typeof d.workflows !== 'object' || d.workflows === null) {
    out.problem = 'run.json has no definition reference'
    return out
  }
  for (const [id, entry] of Object.entries(d.workflows)) {
    const file = typeof entry?.file === 'string' ? entry.file : `${DEFINITION_DIR}/${id}.yaml`
    if (!file.startsWith(`${DEFINITION_DIR}/`) || file.includes('..')) { out.entries[id] = { file, problem: `bundle file "${file}" is outside ${DEFINITION_DIR}/` }; continue }
    const text = await src.text(file)
    if (text === null) { out.entries[id] = { file, problem: `${file} is missing` }; continue }
    if (sha256(text) !== entry.sha256) { out.entries[id] = { file, text, problem: `${file} differs from its recorded sha256 (the bundle was changed)` }; continue }
    const parsed = parseWorkflow(text)
    if (!parsed.ok) { out.entries[id] = { file, text, problem: `${file}: ${parsed.problem.message}` }; continue }
    if (parsed.model.id !== id) { out.entries[id] = { file, text, problem: `${file} holds workflow "${parsed.model.id}", not "${id}"` }; continue }
    out.entries[id] = { file, text, workflow: parsed.model }
  }
  const root = out.entries[d.root]
  if (!root) out.problem = `the root workflow "${d.root}" is not in the bundle`
  else if (root.problem) out.problem = root.problem
  else {
    out.graph = graphOf(root.workflow!)
    const broken = Object.entries(out.entries).find(([, e]) => e.problem)
    if (broken) out.problem = broken[1].problem
  }
  return out
}

export interface Reading { text: string | null; record?: RunRecord; problem?: FileProblem & { code?: string }; bundle: Bundle; files?: RunFile[] }

// Parses and checks one run. Cached on the stat of run.json and the bundle.
const cache = new Map<string, { key: string; reading: Reading }>()

export async function readFrom(src: Source, expect: RunRef & { project?: string }, cacheKey?: string): Promise<Reading> {
  if (cacheKey) {
    const hit = cache.get(cacheKey.split('\0')[0])
    if (hit && hit.key === cacheKey) return { ...hit.reading, record: hit.reading.record && structuredClone(hit.reading.record) }
  }
  const text = await src.text(RUN_FILE)
  const reading = await (async (): Promise<Reading> => {
    if (text === null) return { text, problem: { kind: 'missing', message: `${RUN_FILE} does not exist`, code: 'missing' }, bundle: { entries: {} } }
    let raw: unknown
    try { raw = JSON.parse(text) } catch (e) { return { text, problem: { kind: 'malformed', message: `${RUN_FILE} is not valid JSON: ${(e as Error).message}`, code: 'malformed' }, bundle: { entries: {} } } }
    const r = raw as Record<string, unknown>
    const bundle = await loadBundle(src, r?.definition)
    if (bundle.problem || !bundle.graph) return { text, problem: { kind: 'shape', message: bundle.problem ?? 'no graph', code: 'bundle' }, bundle }
    const frozen = followedGraph(r?.definition as DefinitionRef, bundle)
    if (typeof frozen === 'string') return { text, problem: { kind: 'shape', message: frozen, code: 'bundle' }, bundle }
    bundle.graph = frozen
    const checked = checkRecord(raw, bundle.graph)
    if (!checked.ok) return { text, problem: { kind: 'shape', message: checked.message, code: checked.code }, bundle }
    // Adjusted revisions (p7): each file as recorded, its graph what its
    // authored nodes say; operations follow the revision in force.
    const revProblem = await loadRevisions(src, checked.record, bundle)
    if (revProblem) return { text, problem: { kind: 'shape', message: revProblem, code: 'bundle' }, bundle }
    bundle.graph = graphOfState(checked.record) ?? bundle.graph
    // The person's node catalog as the run was given it (p7/ex1): checked
    // by hash like the bundle, never re-read from the live catalog.
    const catProblem = await loadCatalogSnapshot(src, checked.record, bundle)
    if (catProblem) return { text, problem: { kind: 'shape', message: catProblem, code: 'bundle' }, bundle }
    if (expect.project !== undefined && checked.record.project !== expect.project) {
      return { text, problem: { kind: 'shape', message: `${RUN_FILE} belongs to project "${checked.record.project}", not "${expect.project}"`, code: 'location' }, bundle }
    }
    if (checked.record.workflow !== expect.workflow || checked.record.run !== expect.run) {
      return { text, problem: { kind: 'shape', message: `${RUN_FILE} names ${checked.record.workflow}/${checked.record.run}, but it is stored as ${runKey(expect)}`, code: 'location' }, bundle }
    }
    return { text, record: checked.record, bundle }
  })()
  if (cacheKey) {
    if (cache.size > 2000) cache.clear()
    cache.set(cacheKey.split('\0')[0], { key: cacheKey, reading: { ...reading, record: reading.record && structuredClone(reading.record) } })
  }
  return reading
}

// The graph a run follows (p5): its frozen effective graph, checked against
// the bundled authored definition; a run without one (created before p5)
// follows the authored graph. Returns a problem text when they disagree.
function followedGraph(def: DefinitionRef, bundle: Bundle): RunGraph | string {
  const eff = def?.effective as EffectiveGraph | undefined
  if (eff === undefined) return bundle.graph!
  if (!eff || typeof eff !== 'object' || typeof eff.compiler !== 'string' || typeof eff.nodes !== 'object' || eff.nodes === null || !Array.isArray(eff.edges)) return 'run.json definition.effective is malformed'
  const root = bundle.entries[def.root].workflow!
  if (eff.policy !== root.documentation.policy) return `the frozen graph says policy "${String(eff.policy)}", the bundled definition "${root.documentation.policy}"`
  // The steps a v3 graph records (p8/ex2) are the bundled declaration's.
  if (eff.documentation !== undefined && canonicalJson(eff.documentation) !== canonicalJson(docSteps(root.documentation))) return `the frozen graph's documentation steps differ from the bundled definition's`
  const authored = (g: RunGraph) => canonicalJson(Object.fromEntries(Object.entries(g.nodes).filter(([id]) => !isGenerated(id))))
  if (authored(eff) !== authored(bundle.graph!)) return 'the frozen graph\'s authored nodes differ from the bundled definition'
  for (const e of eff.edges) if (!(e?.from in eff.nodes) || !(e?.to in eff.nodes)) return `the frozen graph has an edge to an unknown node (${String(e?.from)} → ${String(e?.to)})`
  for (const [id, n] of Object.entries(eff.nodes)) if (isGenerated(id) !== !!n?.step) return `the frozen graph's node "${id}" ${isGenerated(id) ? 'has no step' : 'is authored but carries a step'}`
  // Same compiler: it must still produce exactly this graph. Another
  // version's graph is followed as frozen.
  if (eff.compiler === COMPILER_VERSION) {
    const again = compile(root)
    if (!again.ok || canonicalJson(again.graph) !== canonicalJson(eff)) return `the frozen graph differs from what ${COMPILER_VERSION} produces for the bundled definition`
  }
  return { nodes: eff.nodes, edges: eff.edges }
}

async function bundleSigs(dir: string): Promise<string> {
  const defDir = join(dir, DEFINITION_DIR)
  const names = (await readdir(defDir).catch(() => [] as string[])).sort()
  const sigs = await Promise.all(names.map(async n => {
    // Revision folders (p7): their files count too.
    const inner = /^r[0-9]+$/.test(n) ? (await readdir(join(defDir, n)).catch(() => [] as string[])).sort() : []
    return `${n}:${await sigOf(join(defDir, n))}${(await Promise.all(inner.map(async f => `/${f}:${await sigOf(join(defDir, n, f))}`))).join('')}`
  }))
  return sigs.join(',')
}

// Reads every adjusted revision of a run: the file must have its recorded
// bytes, hold the run's workflow, and its graph's authored nodes must be
// what the file says (and, by the current compiler, exactly what it
// compiles to). A problem makes the record unusable; nothing is recompiled.
async function loadRevisions(src: Source, rec: RunRecord, bundle: Bundle): Promise<string | null> {
  const out: NonNullable<Bundle['revisions']> = []
  for (const rev of rec.definition.revisions ?? []) {
    const text = await src.text(rev.file)
    if (text === null) return `${rev.file} (revision ${rev.revision}) is missing`
    if (sha256(text) !== rev.sha256) return `${rev.file} differs from its recorded sha256 (revision ${rev.revision} was changed)`
    const parsed = parseWorkflow(text)
    if (!parsed.ok) return `${rev.file}: ${parsed.problem.message}`
    if (parsed.model.id !== rec.definition.root) return `${rev.file} holds workflow "${parsed.model.id}", not "${rec.definition.root}"`
    const authored = (g: RunGraph) => canonicalJson(Object.fromEntries(Object.entries(g.nodes).filter(([id]) => !isGenerated(id))))
    if (authored(rev.effective) !== authored(graphOf(parsed.model))) return `revision ${rev.revision}'s frozen graph differs from ${rev.file}`
    if (rev.effective.compiler === COMPILER_VERSION) {
      const again = compile(parsed.model)
      if (!again.ok || canonicalJson(again.graph) !== canonicalJson(rev.effective)) return `revision ${rev.revision}'s frozen graph differs from what ${COMPILER_VERSION} produces for ${rev.file}`
    }
    out.push({ revision: rev.revision, file: rev.file, text, workflow: parsed.model })
  }
  if (out.length) bundle.revisions = out
  return null
}

async function loadCatalogSnapshot(src: Source, rec: RunRecord, bundle: Bundle): Promise<string | null> {
  const c = rec.context?.catalog
  if (!c || c.state !== 'supplied') return null
  if (c.file !== CATALOG_SNAPSHOT) return `run.json names the catalog snapshot ${String(c.file)}, not ${CATALOG_SNAPSHOT}`
  const text = await src.text(c.file)
  if (text === null) return `${c.file} (the node catalog this run was given) is missing`
  if (sha256(text) !== c.sha256) return `${c.file} differs from its recorded sha256 (the run's catalog snapshot was changed)`
  try { bundle.catalog = parseSnapshot(JSON.parse(text)) } catch (e) { return `${c.file}: ${(e as Error).message}` }
  return null
}

// What a run was given of the person's node catalog (p7/ex1).
export function catalogOf(record: RunRecord, bundle: { catalog?: CatalogSnapshot }): RunCatalog {
  const c = record.context?.catalog
  if (!c) return { state: 'none' }
  if (c.state === 'unavailable') return { state: 'unavailable', problem: c.problem }
  return { state: 'supplied', file: `${runDir(record)}/${c.file}`, sha256: c.sha256, snapshot: bundle.catalog! }
}
export async function runCatalog(ws: Workspace, ref: RunRef): Promise<RunCatalog> {
  const { record, bundle } = await usableRun(ws, ref)
  return catalogOf(record, bundle)
}

// Every entrance resolves the run's place first (p9, server/runspace.ts):
// its own working copy, or the project workspace for a run without one.
export async function readRun(ws: Workspace, ref: RunRef): Promise<Reading & { dir: string }> {
  ws = await runSpace(ws, ref)
  const rel = runDir(ref)
  const dir = await inside(ws.root, rel)
  const project = await projectId(ws)
  const key = `${dir}\0${project}\0${await sigOf(join(dir, RUN_FILE))}\0${await bundleSigs(dir)}\0${await sigOf(join(dir, CATALOG_SNAPSHOT))}`
  return { ...(await readFrom(fsSource(dir), { ...ref, project }, key)), dir }
}

// The project a run must belong to: project.yaml's id (undefined when unreadable).
export async function projectId(ws: Workspace): Promise<string | undefined> {
  return (await ws.readProject().catch(() => ({ project: undefined }))).project?.id || undefined
}

// Throws RequestError when the run cannot be operated on.
export async function usableRun(ws: Workspace, ref: RunRef): Promise<{ record: RunRecord; graph: RunGraph; dir: string; bundle: Bundle }> {
  const r = await readRun(ws, ref)
  if (r.problem?.code === 'missing') {
    const exists = await stat(r.dir).then(() => true, () => false)
    throw new RequestError(404, exists ? `run ${runKey(ref)} has no ${RUN_FILE}` : `run ${runKey(ref)} does not exist`)
  }
  if (!r.record || !r.bundle.graph) throw new RequestError(409, `run ${runKey(ref)} cannot be used: ${r.problem?.message}. Nothing was changed; fix or restore the files (wfe run check).`, r.problem)
  return { record: r.record, graph: r.bundle.graph, dir: r.dir, bundle: r.bundle }
}

// ---- listing ---------------------------------------------------------------------

// The runs of a project: those recorded in the project tree and those with
// their own working copy (p9), each once. A run with a copy is read there;
// the project tree's folder of the same run, if any, is a snapshot.
export async function runRefs(ws: Workspace, workflow?: string): Promise<RunRef[]> {
  ws = ws.shared
  const runs = await inside(ws.root, RUNS_DIR)
  const workflows = workflow ? [workflow] : (await readdir(runs, { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory() && ID_PATTERN.test(d.name)).map(d => d.name)
  const keys = new Set<string>()
  for (const wf of workflows) {
    for (const d of await readdir(join(runs, wf), { withFileTypes: true }).catch(() => [])) if (d.isDirectory() && RUN_ID.test(d.name)) keys.add(`${wf}/${d.name}`)
  }
  for (const c of await listCopies(ws, workflow)) keys.add(runKey(c.ref))
  const out = [...keys].sort().map(k => { const [wf, run] = k.split('/'); return { workflow: wf, run } })
  return out.slice(0, MAX_RUNS)
}

// Node labels of the run's definition in force, for status words.
export function nodeNames(bundle: Reading['bundle'], r: RunRecord): Record<string, string> {
  const wf = bundle.revisions?.at(-1)?.workflow ?? bundle.entries[r.definition.root]?.workflow
  return Object.fromEntries(Object.entries(wf?.nodes ?? {}).filter(([, n]) => n.name).map(([id, n]) => [id, n.name!]))
}

// `jobs` (project_migration p8 ex1): the run's jobs on the execution host,
// when the caller has them; the status then tells queued from owed.
export function summaryOf(ref: RunRef, reading: Pick<Reading, 'record' | 'problem' | 'bundle'>, jobs?: { state: string; reason: string }[]): RunSummary {
  const base: RunSummary = { ref: runKey(ref), workflow: ref.workflow, run: ref.run, dir: runDir(ref) }
  const r = reading.record
  if (!r) return { ...base, problem: reading.problem }
  const job = jobs ? jobs.find(j => j.state === 'queued' || j.state === 'claimed') ?? null : undefined
  const workflowName = reading.bundle.revisions?.at(-1)?.workflow.name ?? reading.bundle.entries[r.definition.root]?.workflow?.name
  return {
    title: runDisplayTitle(r, workflowName), workflowName,
    ...base, created: r.created, updated: r.updated, seq: r.seq, execution: r.execution.state, counts: r.execution.counts,
    waiting: r.execution.waiting.map(w => ({ node: w.node, holder: holderText(r, w.node) })), ready: r.execution.ready, failed: r.execution.failed,
    input: r.input.kind, executor: r.executor.name, executorHost: hostOf(r.executor), pendingInstructions: Object.values(r.instructions ?? {}).filter(i => !i.ack).length,
    decision: r.decisions.at(-1)?.decision,
    hold: r.control.hold ? { kind: r.control.hold.kind, by: r.control.hold.by } : undefined,
    status: runStatus(r, { names: nodeNames(reading.bundle, r), ...(job !== undefined ? { job: job && { state: job.state as 'queued' | 'claimed', reason: job.reason } } : {}) }),
  }
}

function holderText(r: RunRecord, node: string): string {
  const w = r.nodes[node]?.wait
  if (!w) return ''
  if ('question' in w.on) {
    const q = r.questions[w.on.question]
    if (q && q.answers.length && !q.takenUp && !q.withdrawn) return `${r.executor.name} (answer recorded, not yet taken up)`
  }
  return w.holder
}

export async function listRuns(ws: Workspace, workflow?: string, jobsOf?: (ref: RunRef) => { state: string; reason: string }[]): Promise<RunSummary[]> {
  const refs = await runRefs(ws, workflow)
  return Promise.all(refs.map(async ref => {
    try { return summaryOf(ref, await readRun(ws, ref), jobsOf?.(ref)) } catch (e) {
      // A run whose working copy cannot be used is listed with its problem.
      if (e instanceof RequestError) return summaryOf(ref, { problem: { kind: 'unreadable', message: e.message, code: 'run-copy' }, bundle: { entries: {} } })
      throw e
    }
  }))
}

// "<workflow>/<run>", or a run id that is unique in the project.
export async function resolveRef(ws: Workspace, text: string): Promise<RunRef> {
  const parts = text.replace(/^(devdocs\/)?runs\//, '').replace(/\/$/, '').split('/')
  if (parts.length === 2) return validRef({ workflow: parts[0], run: parts[1] })
  if (parts.length === 1) {
    const hits = (await runRefs(ws)).filter(r => r.run === parts[0])
    if (hits.length === 1) return hits[0]
    if (!hits.length) throw new RequestError(404, `no run "${text}" in this project (see: wfe run list)`)
    throw new RequestError(409, `run "${text}" exists for several workflows (${hits.map(runKey).join(', ')}); use <workflow>/<run>`)
  }
  throw new RequestError(400, `"${text}" is not a run reference; use <workflow>/<run>`)
}

function validRef(r: RunRef): RunRef {
  if (!ID_PATTERN.test(r.workflow)) throw new RequestError(400, `workflow id "${r.workflow}" is invalid`)
  if (!RUN_ID.test(r.run)) throw new RequestError(400, `run id "${r.run}" must match ${RUN_ID.source}`)
  return r
}

// ---- the full view of one run ----------------------------------------------------

async function related(ws: Workspace, ref: RunRef): Promise<RelatedRun> {
  try {
    const r = await readRun(ws, ref)
    if (r.record) return { ref: runKey(ref), execution: r.record.execution.state, seq: r.record.seq }
    return { ref: runKey(ref), problem: r.problem?.code === 'missing' ? 'missing' : `${r.problem?.code ?? 'unreadable'}: ${r.problem?.message}` }
  } catch (e) {
    return { ref: runKey(ref), problem: (e as Error).message }
  }
}

// The current source of each bundled workflow, found by id: same bytes,
// changed, or gone; and whether it now lives in another file.
async function compareSources(ws: Workspace, bundle: Bundle, def: DefinitionRef | undefined): Promise<SourceComparison[]> {
  const { list } = await ws.workflowSummaries()
  const out: SourceComparison[] = []
  for (const [id, e] of Object.entries(bundle.entries)) {
    const source = def?.workflows[id]?.source
    if (!e.text) { out.push({ workflow: id, status: 'unreadable', source, detail: e.problem }); continue }
    const hit = list.find(s => s.id === id)
    if (!hit) { out.push({ workflow: id, status: 'deleted', source, detail: `no workflow "${id}" in ${WORKFLOWS_DIR} now` }); continue }
    const current = await ws.readWorkflowFile(hit.file)
    const file = `${WORKFLOWS_DIR}/${hit.file}`
    out.push({ workflow: id, status: current.text === e.text ? 'same' : 'changed', source, file, renamed: !!source && source.startsWith(`${WORKFLOWS_DIR}/`) && source !== file })
  }
  return out
}

export async function runResponse(ws: Workspace, ref: RunRef, opts: { rev?: string } = {}): Promise<RunResponse> {
  const shared = ws.shared
  ws = await runSpace(ws, ref)
  const rel = runDir(ref)
  let reading: Reading
  let revInfo: RunResponse['revInfo']
  if (opts.rev) {
    const { info, rev } = await historyRev(ws, opts.rev)
    revInfo = rev
    const src = gitSource(info, rev, devdocsRel(rel))
    reading = { ...(await readFrom(src, { ...ref, project: await projectId(ws) })), files: await src.list() }
  } else {
    const r = await readRun(ws, ref)
    reading = { ...r, files: await fsSource(r.dir).list() }
  }
  const record = reading.record
  const artifacts: RunResponse['artifacts'] = []
  let predecessor: RelatedRun | undefined
  if (record && !opts.rev) {
    if (record.predecessor) predecessor = await related(ws, record.predecessor)
    const seen = new Set<string>()
    for (const a of record.artifacts) {
      if (seen.has(a.path)) continue
      seen.add(a.path)
      const abs = await inside(ws.root, a.path).catch(() => null)
      artifacts.push({ path: a.path, exists: !!abs && await stat(abs).then(() => true, () => false) })
    }
  }
  return {
    workspace: ws.reg.id, ref: runKey(ref), dir: rel, rev: revInfo?.commit, revInfo,
    record, problem: reading.problem,
    bundle: Object.fromEntries(Object.entries(reading.bundle.entries).map(([id, e]) => [id, { file: e.file, workflow: e.workflow, problem: e.problem, text: e.text }])),
    ...(reading.bundle.revisions ? { revisions: reading.bundle.revisions.map(r => ({ revision: r.revision, file: r.file, workflow: r.workflow, text: r.text })) } : {}),
    // The current definitions are the project workspace's (p9).
    sources: opts.rev ? [] : await compareSources(shared, reading.bundle, record?.definition),
    place: ws.copyOf ? { kind: 'run-copy', branch: record?.storage?.branch ?? null } : { kind: 'project' },
    files: reading.files ?? [], predecessor, artifacts,
    ...(record ? { catalog: catalogOf(record, reading.bundle) } : {}),
    ...(record && !opts.rev && (record.input.references?.length || record.inputs || record.outputs) ? { shares: await (await import('./shares.ts')).availability(record).catch(() => undefined) } : {}),
  }
}

// A history reference (server/devdocs.ts resolveRev) in this workspace.
export async function historyRev(ws: Workspace, ref: string): Promise<{ info: DevdocsInfo; rev: DevdocsRev }> {
  const info = await ws.devdocs()
  try {
    return { info, rev: await resolveRev(ws.root, info, ref) }
  } catch (e) {
    if (e instanceof RevError) throw new RequestError(404, e.message)
    throw e
  }
}

// A top-level file of the run folder, or an artifact the run records. Text only.
export async function readRunFile(ws: Workspace, ref: RunRef, path: string, opts: { rev?: string } = {}): Promise<{ path: string; text: string }> {
  ws = await runSpace(ws, ref)
  const rel = runDir(ref)
  const r = opts.rev ? await runResponse(ws, ref, opts) : await readRun(ws, ref)
  const own = !path.includes('/') && path !== RUN_FILE && path !== '.' && path !== '..' ? `${rel}/${path}` : null
  const normalized = normalizeRepoPath(path)
  const recorded = r.record?.artifacts.some(a => a.path === normalized) ? normalized : null
  const target = own ?? recorded
  if (!target) throw new RequestError(404, `"${path}" is neither a file of ${runKey(ref)} nor an artifact it records`)
  if (opts.rev) {
    // Only devdocs content belongs to this commit. Never fall back to a
    // working-tree artifact, including files in another repository.
    if (!target.startsWith('devdocs/')) throw new RequestError(404, `${target} is outside devdocs; a history view reads devdocs only. Open the current run to read it`)
    const { info, rev } = await historyRev(ws, opts.rev)
    const size = await blobSizeAt(info, rev, devdocsRel(target))
    if (size === null) throw new RequestError(404, `${target} does not exist as a file in this commit`)
    if (size > MAX_READ) throw new RequestError(413, `${target} is larger than ${MAX_READ} bytes; open it in Git`)
    const content = await showAt(info, rev, devdocsRel(target))
    if (content === null) throw new RequestError(404, `${target} could not be read from this commit`)
    return { path: target, text: content }
  }
  const abs = await inside(ws.root, target)
  const s = await stat(abs).catch(() => null)
  if (!s?.isFile()) throw new RequestError(404, `${target} does not exist`)
  if (s.size > MAX_READ) throw new RequestError(413, `${target} is larger than ${MAX_READ} bytes; open it in the editor`)
  return { path: target, text: await readFile(abs, 'utf8') }
}

// ---- creation --------------------------------------------------------------------

export interface CreateRunOptions {
  workflow: string // id or file name in devdocs/workflows
  name?: string // run id; default the next run-NNN
  input:
    | { kind: 'braindump'; text: string; author: string; recordedBy?: string; source?: SourceRef; attachments?: PinnedAttachment[] }
    | { kind: 'request'; text: string; requester: string; entrustedBy: EntrustRef; onBehalfOf?: string; original?: string; source?: SourceRef; attachments?: PinnedAttachment[] }
  // The agent identity. With `host`, the run is performed as the
  // definition's execution.agent (or as the host itself when none is
  // declared) and the host is recorded beside it (p6).
  executor: Executor | { host: string; node?: string }
  plan?: string
  predecessor?: RunRef
  // The idempotency key of the input (p6: the Zulip post), carried by
  // run.create; findRunByReceipt finds the run again after a crash.
  receipt?: string
  // The operating area whose node catalog the run is given (p7/ex1): every
  // entrance passes it; the snapshot is frozen into the run folder.
  area?: string
  // p9: the run's own working copy (server/runspace.ts) the run folder is
  // written into, and the storage it records. The definition is still read
  // from the project workspace `ws`, as the person sees and edits it.
  into?: Workspace
  storage?: RunStorage
  by: string
  via: string
  now?: Date
}

export interface CreatedRun { ref: RunRef; dir: string; record: RunRecord; files: string[] }
// A challenge attached to the input, with the text of its file at the
// attached commit (challenge p1): written into the run folder as given.
export type PinnedAttachment = import('../shared/intake.ts').AttachmentRef & { text: string }

// The next run-NNN: past every run recorded, held by a copy or named by a
// run branch (p9). Called under the workspace's allocation lock.
async function nextRunId(ws: Workspace, workflow: string): Promise<string> {
  const project = await projectId(ws.shared)
  const runs = project ? await usedRuns(ws.shared, project, workflow) : new Set((await runRefs(ws, workflow)).map(r => r.run))
  const used = [...runs].map(r => /^run-(\d+)$/.exec(r)?.[1]).filter((n): n is string => !!n).map(Number)
  return `run-${String((used.length ? Math.max(...used) : 0) + 1).padStart(3, '0')}`
}

function validEntrust(e: EntrustRef): EntrustRef {
  if (e.kind === 'run') { const r = validRunRef(e, 'entrustedBy'); return { kind: 'run', ...r, ...(e.node ? { node: e.node } : {}), ...(typeof e.project === 'string' && e.project ? { project: e.project } : {}) } }
  if (e.kind === 'file') {
    const p = normalizeRepoPath(e.path)
    if (!p || p === '.') throw new RequestError(400, `entrustedBy file "${e.path}" must be a project-relative path`)
    return { kind: 'file', path: p }
  }
  if (e.kind === 'note' && e.text.trim()) return { kind: 'note', text: e.text.trim() }
  // p10: a child created from a delegation's request (the intake builds it).
  if (e.kind === 'delegation' && e.delegation && e.parent && ['project', 'workflow', 'run', 'creation', 'node'].every(k => typeof (e.parent as Record<string, unknown>)[k] === 'string' && (e.parent as Record<string, string>)[k])) {
    return { kind: 'delegation', delegation: e.delegation, parent: { project: e.parent.project, workflow: e.parent.workflow, run: e.parent.run, creation: e.parent.creation, node: e.parent.node }, accepts: e.accepts === 'parent' ? 'parent' : 'person' }
  }
  throw new RequestError(400, 'entrustedBy must be a run, a project file, a note or a delegation')
}

// Validates the source workflow and returns its saved bytes.
async function sourceBundle(ws: Workspace, workflow: string): Promise<{ root: string; files: Record<string, { source: string; text: string; workflow: Workflow }>; warnings: string[] }> {
  const { list } = await ws.workflowSummaries()
  const find = (name: string) => list.find(s => s.id === name) ?? list.find(s => s.file === name || s.file === `${name}.yaml` || s.file === `${name}.yml`)
  const s = find(workflow)
  if (!s?.id) throw new RequestError(404, `no workflow "${workflow}" in ${WORKFLOWS_DIR} (by id or file name)${s?.problem ? `: ${s.problem.message}` : ''}`)
  const r = await ws.workflowResponse(s.file)
  if (!r.workflow || r.text === null) throw new RequestError(409, `${s.file} cannot be read: ${r.problem?.message}`)
  const errors = r.issues.filter(i => i.severity === 'error')
  if (errors.length) throw new RequestError(409, `${s.file} has validation errors; a run needs a valid definition (wfe validate ${s.id})`, errors)
  const warnings = r.issues.map(i => `${s.id}: ${i.code}: ${i.message}`)
  return { root: s.id, files: { [s.id]: { source: `${WORKFLOWS_DIR}/${s.file}`, text: r.text, workflow: r.workflow } }, warnings }
}

async function definitionRef(root: string, files: Record<string, { source: string; text: string; workflow: Workflow }>, warnings: string[]): Promise<DefinitionRef> {
  const workflows: Record<string, BundleEntry> = {}
  for (const [id, f] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const states = await approvalStates(f.workflow)
    workflows[id] = {
      file: `${DEFINITION_DIR}/${id}.yaml`, source: f.source, sha256: sha256(f.text),
      definitionDigest: await semanticDigest('definition', f.workflow),
      approvals: { intent: states.intent.status, definition: states.definition.status },
    }
  }
  return { root, workflows, warnings }
}

async function repoContext(ws: Workspace, files: Record<string, { workflow: Workflow }>): Promise<{ repositories: RepoContext[] }> {
  const bound = new Set(['.'])
  for (const f of Object.values(files)) for (const b of Object.values(f.workflow.repositories)) { const p = normalizeRepoPath(b.path); if (p) bound.add(p) }
  const repos = await ws.repositories()
  return {
    repositories: repos.filter(r => bound.has(r.path)).map(r => ({ path: r.path, head: r.head ?? null, branch: r.branch ?? null, dirty: r.initialized ? r.dirty : null })),
  }
}

// Writes a new run folder. The folder is created exclusively: an existing run
// is refused and left as it is. run.json is written last.
async function writeRun(ws: Workspace, ref: RunRef, files: Record<string, string>, record: RunRecord): Promise<CreatedRun> {
  const rel = runDir(ref)
  const runs = await inside(ws.root, `${RUNS_DIR}/${ref.workflow}`)
  await mkdir(runs, { recursive: true })
  const dir = await inside(ws.root, rel)
  try {
    await mkdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new RequestError(409, `run ${runKey(ref)} already exists (${rel}); nothing was changed. Choose another --name or omit it for the next number.`)
    throw e
  }
  await mkdir(join(dir, DEFINITION_DIR))
  const written: string[] = []
  for (const [name, text] of Object.entries(files)) {
    if (name.includes('/')) await mkdir(join(dir, name.slice(0, name.lastIndexOf('/'))), { recursive: true })
    await writeFile(join(dir, name), text, { flag: 'wx' })
    written.push(`${rel}/${name}`)
  }
  await atomicWrite(join(dir, RUN_FILE), `${JSON.stringify(record, null, 2)}\n`)
  written.push(`${rel}/${RUN_FILE}`)
  return { ref, dir: rel, record, files: written }
}

function inputOf(o: CreateRunOptions['input']): { input: RunInput; files: Record<string, string> } {
  if (!o.text.trim()) throw new RequestError(400, `the ${o.kind} text is empty`)
  if (o.kind === 'braindump') {
    if (!o.author?.trim()) throw new RequestError(400, 'a braindump needs its author: the person whose words it holds (--author)')
    const input: RunInput = { kind: 'braindump', file: 'braindump.md', author: o.author.trim() }
    if (o.recordedBy?.trim() && o.recordedBy.trim() !== input.author) input.recordedBy = o.recordedBy.trim()
    if (o.source) input.source = o.source
    input.sha256 = sha256(o.text) // what a request-sourced adjustment binds to (p7/ex1)
    withReferences(input, o.text)
    const files: Record<string, string> = { 'braindump.md': o.text }
    withAttachments(input, files, o.attachments)
    return { input, files }
  }
  if (!o.requester?.trim()) throw new RequestError(400, 'a request needs its requester: the agent that wrote it (--requester)')
  const input: RunInput = { kind: 'request', file: 'request.md', requester: o.requester.trim(), entrustedBy: validEntrust(o.entrustedBy), sha256: sha256(o.text) }
  if (o.onBehalfOf?.trim()) input.onBehalfOf = o.onBehalfOf.trim()
  if (o.source) input.source = o.source // observer p3: an agent's request posted in a Zulip request topic
  const files: Record<string, string> = { 'request.md': o.text }
  if (o.original !== undefined) { input.original = 'original-input.md'; files['original-input.md'] = o.original }
  withReferences(input, o.text)
  withAttachments(input, files, o.attachments)
  return { input, files }
}

// What the words carried (challenge p1, docs/challenges.md): each attached
// challenge's file as it was at its commit, in the run folder, and the
// pinned reference in the input. A later edit of the challenge never changes
// what this run was given; the current revision is a separate read.
function withAttachments(input: RunInput, files: Record<string, string>, attachments: PinnedAttachment[] | undefined) {
  if (!attachments?.length) return
  const seen = new Set<string>()
  input.attachments = []
  for (const a of attachments) {
    if (a.kind !== 'challenge' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(a.id) || !/^[0-9a-f]{40,64}$/.test(a.commit)) throw new RequestError(400, `attachment ${a.id}@${a.commit} is not a pinned challenge`)
    if (sha256(a.text) !== a.sha256) throw new RequestError(409, `attachment ${a.id}@${a.commit.slice(0, 12)}: its text is not the revision named (hash differs)`)
    const file = `attachments/${a.id}@${a.commit.slice(0, 12)}.md`
    if (seen.has(file)) continue
    seen.add(file)
    files[file] = a.text
    input.attachments.push({ kind: 'challenge', id: a.id, commit: a.commit, title: a.title, sha256: a.sha256, file })
  }
}

// The shared-area references the person wrote (project_migration p6): taken
// from the words themselves, so every entrance — a request, the editor, a
// Zulip post, a delegation — records them without a form.
function withReferences(input: RunInput, text: string) {
  const refs = refsIn(text)
  if (refs.length) input.references = refs
}

// A run created in the project workspace without a name (an IDE agent's
// `wfe run create`) takes its number under the same allocation lock as
// requests, so the two never take one number twice.
export async function createRun(ws: Workspace, o: CreateRunOptions): Promise<CreatedRun> {
  if (!o.into && !o.name) return allocating(ws, () => createRunUnlocked(ws, o))
  return createRunUnlocked(ws, o)
}

// A run the execution host performs (p9, docs/storage.md): everything that
// can refuse the request is checked first, then the run's own working copy
// is reserved and made, and the run folder is written into it. The same
// receipt finds the same run (and finishes a creation that was interrupted).
export async function createRunInCopy(ws: Workspace, o: CreateRunOptions & { receipt: string }, env: Record<string, string> = {}): Promise<CreatedRun & { existing?: boolean }> {
  ws = ws.shared
  const project = await projectId(ws)
  if (!project) throw new RequestError(409, 'project.yaml cannot be read, so the run cannot name its project; fix project.yaml first (wfe status)')
  inputOf(o.input)
  const info = await ws.devdocs()
  if (info.problem) throw new RequestError(409, `${info.problem.message}; nothing was created. ${info.problem.fix ?? ''}`.trim())
  const src = await sourceBundle(ws, o.workflow)
  const compiled = compile(src.files[src.root].workflow)
  if (!compiled.ok) throw new RequestError(422, `${src.root} cannot be executed: ${compiled.message}. Nothing was written.`, { code: compiled.code })
  // An unknown execution node is refused before the copy is made (p7).
  if ('host' in o.executor && o.area) {
    const { chooseNode, loadWorkers } = await import('./workers.ts')
    chooseNode(loadWorkers(o.area), { request: o.executor.node, workflow: src.files[src.root].workflow, project: (await ws.readProject().catch(() => ({ project: undefined }))).project })
  }
  const { copy, workspace: into } = await prepareCopy(ws, { project, workflow: src.root, name: o.name, receipt: o.receipt }, env)
  const have = await readRun(into, copy.ref)
  if (have.record) return { ref: copy.ref, dir: runDir(copy.ref), record: have.record, files: [], existing: true }
  return createRunUnlocked(ws, { ...o, workflow: src.root, name: copy.ref.run, into, storage: storageOf(copy.manifest!) })
}

async function createRunUnlocked(ws: Workspace, o: CreateRunOptions): Promise<CreatedRun> {
  const host = 'host' in o.executor ? o.executor.host : undefined
  const node = o.executor.node
  if (!host && !(o.executor as Executor).name?.trim()) throw new RequestError(400, 'the executor is required (--executor <name>): who performs the run')
  const { input, files } = inputOf(o.input)
  const dest = o.into ?? ws
  // A named run that exists is refused first, whatever the definition's state.
  if (o.name && ID_PATTERN.test(o.workflow) && await stat(await inside(dest.root, runDir({ workflow: o.workflow, run: o.name }))).then(() => true, () => false)) {
    throw new RequestError(409, `run ${o.workflow}/${o.name} already exists (${runDir({ workflow: o.workflow, run: o.name })}); nothing was changed. Choose another --name or omit it for the next number.`)
  }
  const project = await projectId(ws)
  if (!project) throw new RequestError(409, 'project.yaml cannot be read, so the run cannot name its project; fix project.yaml first (wfe status)')
  const info = await ws.devdocs()
  if (info.problem) throw new RequestError(409, `${info.problem.message}; nothing was created. ${info.problem.fix ?? ''}`.trim())
  const src = await sourceBundle(ws, o.workflow)
  const ref = validRef({ workflow: src.root, run: o.name ?? await nextRunId(ws, src.root) })
  if (o.predecessor) validRunRef(o.predecessor, 'predecessor')
  const definition = await definitionRef(src.root, src.files, src.warnings)
  const context: { repositories: RepoContext[]; catalog?: CatalogContext } = await repoContext(dest, src.files)
  if (o.area) {
    const { snapshotForRun } = await import('./catalog.ts')
    const snap = await snapshotForRun(o.area)
    if (snap.state === 'supplied') {
      files[CATALOG_SNAPSHOT] = snap.text
      context.catalog = { state: 'supplied', file: CATALOG_SNAPSHOT, sha256: snap.sha256, generation: snap.snapshot.generation, templates: snap.snapshot.templates.length }
    } else context.catalog = { state: 'unavailable', problem: snap.problem }
  }
  const compiled = compile(src.files[src.root].workflow)
  if (!compiled.ok) throw new RequestError(422, `${src.root} cannot be executed: ${compiled.message}. Nothing was written.`, { code: compiled.code })
  definition.effective = compiled.graph
  const graph: RunGraph = { nodes: compiled.graph.nodes, edges: compiled.graph.edges }
  const agent = src.files[src.root].workflow.execution.agent
  // The execution node (project_migration p7): chosen once, at creation, for
  // a run an execution host performs in an area with workers.
  // The worker lane (p8) is frozen beside it; the default lane is not recorded.
  let chosen = node
  let lane: string | undefined
  if (host && o.area) {
    const { chooseLane, chooseNode, loadWorkers } = await import('./workers.ts')
    const project = (await ws.readProject().catch(() => ({ project: undefined }))).project
    chosen = chooseNode(loadWorkers(o.area), { request: node, workflow: src.files[src.root].workflow, project }).node
    const l = chooseLane({ workflow: src.files[src.root].workflow, project })
    if (l !== DEFAULT_LANE) lane = l
  }
  const executor: Executor = host ? { name: agent || host, backend: null, host, ...(chosen ? { node: chosen } : {}), ...(lane ? { lane } : {}) } : o.executor as Executor
  const record = createRecord(project, ref, input, { ...o, executor }, definition, context, graph, o.receipt, o.storage)
  for (const [id, f] of Object.entries(src.files)) files[`${DEFINITION_DIR}/${id}.yaml`] = f.text
  if (o.plan !== undefined) files['plan.md'] = o.plan
  return writeRun(dest, ref, files, record)
}

function createRecord(project: string, ref: RunRef, input: RunInput, o: Pick<CreateRunOptions, 'predecessor' | 'by' | 'via' | 'now'> & { executor: Executor }, definition: DefinitionRef, context: RunState['context'], graph: RunGraph, receipt?: string, storage?: RunStorage): RunRecord {
  const executor: Executor = { name: o.executor.name.trim(), backend: o.executor.backend?.trim() || null, ...(o.executor.host ? { host: o.executor.host } : {}), ...(o.executor.node ? { node: o.executor.node } : {}), ...(o.executor.lane ? { lane: o.executor.lane } : {}) }
  try {
    return operate(null, {
      op: 'run.create', project, workflow: ref.workflow, run: ref.run, input, executor, predecessor: o.predecessor ?? null,
      definition, context, nodes: Object.keys(graph.nodes).sort(), ...(receipt ? { receipt } : {}), ...(storage ? { storage } : {}),
    }, { at: (o.now ?? new Date()).toISOString(), by: o.by, via: o.via, graph })
  } catch (e) {
    if (e instanceof RunError) throw new RequestError(e.code === 'delegate-unsupported' ? 422 : 400, e.message, { code: e.code })
    throw e
  }
}

// The run a creation with this receipt made, if any (p6). A request applied
// twice — after a crash between creating the run and recording that it was
// created — finds its run instead of making a second one.
export async function findRunByReceipt(ws: Workspace, workflow: string, receipt: string): Promise<RunRef | null> {
  for (const ref of await runRefs(ws, workflow)) {
    const space = await runSpace(ws, ref).catch(() => null)
    if (!space) continue
    const text = await readTextOrNull(join(await inside(space.root, runDir(ref)), RUN_FILE))
    if (!text?.includes(receipt)) continue
    try {
      const first = (JSON.parse(text) as { history?: { op?: string; receipt?: string }[] }).history?.[0]
      if (first?.op === 'run.create' && first.receipt === receipt) return ref
    } catch { /* an unreadable record is not this one */ }
  }
  return null
}

// ---- operations ------------------------------------------------------------------

// advice (fix5): an agent's or a person's operation, evaluated for
// reminders before it is written (server/reminders.ts); absent for WFE's own.
export interface OpContext { by?: string; via: string; expectSeq?: number; now?: Date; advice?: Advice }

async function writeRecord(dir: string, record: RunRecord) {
  await atomicWrite(join(dir, RUN_FILE), `${JSON.stringify(record, null, 2)}\n`)
}

function nextQuestionId(record: RunRecord): string {
  let n = Object.keys(record.questions).length + 1
  while (`q${n}` in record.questions) n++
  return `q${n}`
}

// Applies one operation to a run and writes it: read, version check,
// transition and atomic replacement under the run's cross-process lock
// (server/lock.ts), so the CLI, the service and the executor never lose
// each other's records. A retransmission (same receipt) changes nothing.
export async function runOp(ws: Workspace, ref: RunRef, input: OpInput & EntryMeta, ctx: OpContext): Promise<{ record: RunRecord; ref: RunRef; duplicate?: boolean }> {
  if (input.op === 'run.create') throw new RequestError(400, 'runs are created with create, not as an operation')
  ws = await runSpace(ws, ref)
  const file = join(await inside(ws.root, runDir(ref)), RUN_FILE)
  try {
    return await withLock(file, () => runOpLocked(ws, ref, input, ctx), { what: `run ${runKey(ref)}` })
  } catch (e) {
    if ((e as Error).name === 'LockTimeout' || (e as Error).constructor?.name === 'LockTimeout') throw new RequestError(409, (e as Error).message)
    throw e
  }
}

export async function runOpLocked(ws: Workspace, ref: RunRef, input: OpInput & EntryMeta, ctx: OpContext): Promise<{ record: RunRecord; ref: RunRef; duplicate?: boolean }> {
  const { record, graph, dir, bundle } = await usableRun(ws, ref)
  const prepared = await prepareOp(ws, ref, record, graph, input)
  const next = applyOp(record, prepared, graph, ctx)
  if (next === record) return { record, ref, duplicate: true }
  // Reminders (fix5): a completion, a question; evaluated on what this
  // write would record, before it is written.
  const op = prepared.op
  const boundary: Boundary | null = op.op === 'node.complete' ? { kind: 'complete', node: op.node }
    : op.op === 'question.ask' ? { kind: 'ask', node: op.node ?? null, to: op.to, presents: op.presentation !== undefined || op.output !== undefined || !!op.subject?.length }
      : null
  if (boundary && ctx.advice) await adviseOrRefuse(ws, ctx.advice, boundary, { record, after: next, graph, authored: activeDefinition(record, bundle).workflow, catalog: catalogOf(record, bundle) })
  await writeRecord(dir, next)
  return { record: next, ref }
}

// The file layer of one operation: what the reducer is given is checked on
// disk here (documents, presentations, deliverables) and recorded as
// evidence; the reducer checks the evidence, never the files.
interface PreparedOp { op: OpInput & EntryMeta; docProblem?: string }
async function prepareOp(ws: Workspace, ref: RunRef, record: RunRecord, graph: RunGraph, input: OpInput & EntryMeta): Promise<PreparedOp> {
  const op = structuredClone(input) as OpInput & EntryMeta
  if (op.op === 'question.ask' && !op.question) op.question = nextQuestionId(record)
  if (op.op === 'artifact.attach' || (op.op === 'node.complete' && op.artifacts)) {
    for (const p of op.op === 'artifact.attach' ? [op.path] : op.artifacts ?? []) {
      const n = normalizeRepoPath(p)
      if (n && n !== '.') await inside(ws.root, n) // bounds, before anything is written
    }
  }
  // A documentation step's document is checked here, on disk, and recorded
  // as evidence; the reducer checks the evidence, never the file.
  let docProblem: string | undefined
  const planAsked = op.op === 'question.ask' && op.plan ? Object.values(graph.nodes).find(n => n.step?.kind === 'plan')?.step : undefined
  const step = planAsked ?? ((op.op === 'node.complete' || op.op === 'question.ask') && op.node ? graph.nodes[op.node]?.step : undefined)
  if (op.op === 'node.complete' || op.op === 'question.ask') delete op.document // never taken from the caller
  if (op.op === 'question.ask' && op.adjustment) {
    // A proposed adjustment (p7): the proposal file, by hash.
    const checked = await checkRunFile(ws, ref, `${DEFINITION_DIR}/proposals/${op.adjustment}.yaml`)
    if ('problem' in checked) throw new RequestError(422, `asking about adjustment ${op.adjustment}: ${checked.problem}`, { code: 'document-missing' })
    ;(op as { document?: DocumentEvidence }).document = checked
  } else if (step && (op.op === 'node.complete' || step.kind === 'plan')) {
    const checked = await checkDocument(ws, ref, step)
    if ('problem' in checked) docProblem = checked.problem
    else (op as { document?: DocumentEvidence }).document = checked
  }
  // Deliverables a result-confirmation question presents, and their state
  // when a decision is recorded from it: checked here, on disk (p6).
  if (op.op === 'question.ask') {
    delete op.subject
    if ((op.presentation !== undefined || op.output !== undefined) && op.subjects?.length) throw new RequestError(400, 'a question presents a presentation and/or an output, or loose files (--subject), not both')
    if (op.presentation !== undefined) {
      // A presentation's files, as they are on disk now (p7); the reducer
      // compares them with the registered manifest.
      const p = record.presentations?.[op.presentation]
      if (p) op.subject = await Promise.all(p.files.map(f => checkSubject(ws, f.path)))
    } else if (op.subjects?.length) op.subject = await Promise.all(op.subjects.map(p => checkSubject(ws, p)))
    // An external output (project_migration p6): its bytes on the share are
    // verified against its manifest now, in full; the manifest file is the
    // subject that binds the answer to exactly those bytes.
    if (op.output !== undefined) {
      const o = record.outputs?.[op.output]
      if (o) {
        const { checkOutput } = await import('./shares.ts')
        const found = await checkOutput(ws, record, op.output)
        if (found.status !== 'verified') throw new RequestError(422, `output ${op.output} is ${found.status} on this host: ${found.detail}; it is presented only when its bytes match its manifest (publish again for a new revision)`, { code: found.status === 'missing' ? 'output-missing' : 'output-altered' })
        op.subject = [...(op.subject ?? []), await checkSubject(ws, o.file)]
      }
    }
    delete op.subjects
  }
  if (op.op === 'run.decide') {
    delete op.subject
    const q = op.question ? record.questions[op.question] : undefined
    if (q?.subject) op.subject = (await Promise.all(q.subject.map(d => checkSubject(ws, d.path).catch(() => null)))).filter((d): d is DocumentEvidence => !!d)
    // The output a confirmation asked about is still there as published
    // (sizes; its manifest is a hashed subject above). An accepted result is
    // never one whose bytes went missing or changed size.
    if (q?.output && op.decision === 'accepted') {
      const { checkOutput } = await import('./shares.ts')
      const found = await checkOutput(ws, record, q.output.id, { quick: true })
      if (found.status !== 'verified') throw new RequestError(422, `output ${q.output.id} that ${q.id} asked about is ${found.status} on this host: ${found.detail}; it cannot be accepted as the verified result`, { code: found.status === 'missing' ? 'output-missing' : 'output-altered' })
    }
    // What an acceptance binds to (p9): the run's copy as it is now, by tree.
    delete op.revision
    if (op.decision === 'accepted' && ws.copyOf && record.storage) {
      const { acceptedRevision, resultChanges } = await import('./integrate.ts')
      op.revision = await acceptedRevision(ws, record.storage)
      // One acceptance per result (project_migration p3/ex1): accepting what
      // the latest acceptance already binds — directly or from a confirmation
      // answer — records nothing and queues no integration. A changed result
      // (anything but the run's own records) is accepted again. A
      // retransmission of the recorded operation stays a duplicate.
      const di = record.decisions.length - 1
      const last = record.decisions[di]
      const retransmitted = !!op.receipt && record.history.some(h => h.receipt === op.receipt)
      const sameQuestion = !!op.question && record.decisions.some(d => d.confirmation?.question === op.question) // the reducer's decision-exists says it
      if (!retransmitted && !sameQuestion && last?.decision === 'accepted' && last.revision) {
        const changed = await resultChanges(ws, ref, record.storage, last.revision, op.revision)
        if (changed && !changed.length) throw new RequestError(409, `the result is already accepted (decision ${di}, by ${last.by} at ${last.at}${last.confirmation ? ` from ${last.confirmation.question}` : ''}) and has not changed since; nothing was recorded. Only a changed result is accepted again.`, { code: 'already-accepted' })
      }
    }
  }
  return { op, docProblem }
}

// The reducer's verdict on a prepared operation, as a request error.
function applyOp(record: RunRecord, { op, docProblem }: PreparedOp, graph: RunGraph, ctx: OpContext): RunRecord {
  try {
    return operate(record, op, { at: (ctx.now ?? new Date()).toISOString(), by: ctx.by?.trim() || record.executor.name, via: ctx.via, graph, expectSeq: ctx.expectSeq })
  } catch (e) {
    if (e instanceof RunError) {
      const message = e.code === 'document-missing' && docProblem ? `${op.op === 'question.ask' ? 'asking from' : 'completing'} ${(op as { node: string }).node}: ${docProblem}` : e.message
      throw new RequestError(e.code === 'outdated' ? 409 : 422, message, { code: e.code })
    }
    throw e
  }
}

// Reminders for an operation recorded elsewhere (fix5): a conversation post
// that reports a result or completes its node. Read under the run's lock;
// the post itself is the conversation's, made after this returns.
export async function adviseRun(ws: Workspace, ref: RunRef, bs: Boundary[], advice: Advice | undefined): Promise<void> {
  if (!advice || advice.yes) return
  ws = await runSpace(ws, ref)
  const file = join(await inside(ws.root, runDir(ref)), RUN_FILE)
  await withLock(file, async () => {
    const { record, graph, bundle } = await usableRun(ws, ref)
    let after = record
    const done = bs.find(b => b.kind === 'complete')
    if (done?.kind === 'complete' && record.nodes[done.node]?.state === 'running') {
      try { after = applyOp(record, { op: { op: 'node.complete', node: done.node, outcome: '(the post)' } }, graph, { by: record.executor.name, via: 'conversation' }) } catch { after = record }
    }
    if (!bs.length) return
    await adviseOrRefuse(ws, advice, bs, { record, after, graph, authored: activeDefinition(record, bundle).workflow, catalog: catalogOf(record, bundle) })
  }, { what: `run ${runKey(ref)}` })
}

// ---- adjustments (p7, docs/adjustments.md) -----------------------------------------

export interface AdjustOptions {
  text: string // the whole adjusted definition (the active revision, edited)
  reason: string
  // A request source may leave out input and hash: the file layer names the
  // run's input file and hashes it as it is on disk (p7/ex1).
  source: AdjustSource | { kind: 'request'; input?: string; sha256?: string }
  dryRun?: boolean // inspect only: the difference and every refusal, nothing written
  propose?: string // write it as definition/proposals/<name>.yaml to ask about (agreement)
  expectRevision?: string // refuse unless this revision is in force
  // At the completion of a running node (p8/ex2): the adjustment and the
  // node's completion are recorded together, in one locked write. Needed
  // when that completion would otherwise complete the run.
  completing?: { node: string; outcome: string; artifacts?: string[]; agreement?: string }
}
export interface AuthoredDiff { added: string[]; removed: string[]; changed: { id: string; fields: string[] }[]; restyled: string[] }
export interface AdjustResult {
  ok: boolean
  dryRun: boolean
  parent: string // the revision it was made from
  revision?: string // the revision it became (applied)
  proposal?: string // run-relative proposal file (propose)
  authored: AuthoredDiff // what the author changed
  graph: AdjustDiff // the effective graph's difference, generated steps included
  problems: { code: string; message: string }[]
  record?: RunRecord
  duplicate?: boolean // a retransmission (same receipt): already recorded, nothing written
  // What the change means that is easy to miss, refused or not (p8/ex2): an
  // added node nothing leads to, a node field the contract does not know.
  notes?: string[]
}

// Node fields of the contract (docs/contract.md); anything else is kept in
// the file and means nothing to a run.
const KNOWN_NODE_FIELDS = new Set(['type', 'name', 'description', 'repositories', 'workflow', 'project', 'accepts', 'confirms', 'activity', 'appearance', 'template'])
function adjustNotes(raw: unknown, active: Workflow, next: Workflow): string[] {
  const notes: string[] = []
  const nodes = (raw && typeof raw === 'object' ? (raw as { nodes?: Record<string, unknown> }).nodes : undefined) ?? {}
  for (const [id, n] of Object.entries(nodes)) {
    if (!n || typeof n !== 'object') continue
    const unknown = Object.keys(n).filter(k => !KNOWN_NODE_FIELDS.has(k))
    if (unknown.length) notes.push(`node ${id}: ${unknown.join(', ')} ${unknown.length === 1 ? 'is not a node field' : 'are not node fields'}; it is kept in the file but means nothing to the run (dependencies are top-level edges: - {from: <node>, to: ${id}})`)
  }
  for (const id of Object.keys(next.nodes).filter(x => !(x in active.nodes))) {
    if (!next.edges.some(e => e.to === id)) notes.push(`${id} is added with no edge to it: it waits for nothing and is ready at once${Object.keys(active.nodes).length ? ` (to follow a node, add - {from: <node>, to: ${id}} under edges)` : ''}`)
  }
  return notes
}

const NODE_FIELDS = ['type', 'name', 'description', 'repositories', 'workflow', 'confirms', 'activity'] as const
function authoredDiff(a: Workflow, b: Workflow): AuthoredDiff {
  const fields = (x: Workflow['nodes'][string], y: Workflow['nodes'][string]) => NODE_FIELDS.filter(f => canonicalJson(x[f] ?? null) !== canonicalJson(y[f] ?? null))
  return {
    added: Object.keys(b.nodes).filter(n => !(n in a.nodes)).sort(),
    removed: Object.keys(a.nodes).filter(n => !(n in b.nodes)).sort(),
    changed: Object.keys(b.nodes).filter(n => n in a.nodes && fields(a.nodes[n], b.nodes[n]).length).sort().map(id => ({ id, fields: fields(a.nodes[id], b.nodes[id]) })),
    restyled: Object.keys(b.nodes).filter(n => n in a.nodes && canonicalJson(a.nodes[n].appearance ?? null) !== canonicalJson(b.nodes[n].appearance ?? null)).sort(),
  }
}

// The active revision's authored definition and its text.
export function activeDefinition(record: RunRecord, bundle: Bundle): { text: string; workflow: Workflow } {
  const last = bundle.revisions?.at(-1)
  if (last) return { text: last.text, workflow: last.workflow }
  const root = bundle.entries[record.definition.root]
  return { text: root.text!, workflow: root.workflow! }
}

// Inspects, proposes or applies an adjustment of a run's future work, under
// the run's lock: the file-level rules here (access, authored fields of
// started work, validation), the record rules in the reducer (boundary,
// state, authorization). The revision file is written before run.json; a
// refusal removes it again.
export async function adjustRun(ws: Workspace, ref: RunRef, o: AdjustOptions, ctx: OpContext & { attempt?: string; receipt?: string }): Promise<AdjustResult> {
  ws = await runSpace(ws, ref)
  const file = join(await inside(ws.root, runDir(ref)), RUN_FILE)
  return withLock(file, async () => {
    const { record, graph, dir, bundle } = await usableRun(ws, ref)
    const parent = activeRevision(record.definition)
    const active = activeDefinition(record, bundle)
    const problems: AdjustResult['problems'] = []
    const problem = (code: string, message: string) => problems.push({ code, message })
    const empty: AuthoredDiff = { added: [], removed: [], changed: [], restyled: [] }
    // A retransmission is answered before anything is written (no stray
    // revision file); a receipt used for another operation is refused.
    const seen = ctx.receipt ? record.history.find(h => h.receipt === ctx.receipt) : undefined
    if (seen && !o.dryRun && !o.propose) {
      if (seen.op !== 'run.adjust') throw new RequestError(409, `receipt ${ctx.receipt} already recorded ${seen.op} at seq ${seen.seq}`, { code: 'receipt-reused' })
      const rev = record.definition.revisions?.find(x => x.revision === (seen as { revision?: string }).revision)
      return { ok: true, dryRun: false, parent: rev?.parent ?? parent, revision: rev?.revision, authored: empty, graph: rev?.diff ?? graphDiff(graph, graph), problems: [], record, duplicate: true }
    }
    // The original request (p7/ex1): the run's input file, by its hash on
    // disk now; the reducer compares it with the hash recorded at creation.
    let source = o.source as AdjustSource
    if (o.source.kind === 'request') {
      const input = o.source.input ?? record.input.file
      const onDisk = await checkRunFile(ws, ref, input)
      if ('problem' in onDisk) problem('adjust-unauthorized', `the run's input ${input} cannot be read: ${onDisk.problem}`)
      else if (o.source.sha256 && o.source.sha256 !== onDisk.sha256) problem('adjust-unauthorized', `${input} on disk is not the content named (hash ${o.source.sha256.slice(0, 12)}…)`)
      source = { kind: 'request', input, sha256: 'problem' in onDisk ? '0'.repeat(64) : onDisk.sha256 }
    }
    const parsed = parseWorkflow(o.text)
    if (!parsed.ok) return { ok: false, dryRun: !!o.dryRun, parent, authored: empty, graph: graphDiff(graph, graph), problems: [{ code: 'adjust-graph', message: `the adjusted definition cannot be read: ${parsed.problem.message}` }] }
    const next = parsed.model
    if (next.id !== record.definition.root) problem('adjust-graph', `the adjusted definition is workflow "${next.id}", not "${record.definition.root}"`)
    if (o.expectRevision && o.expectRevision !== parent) problem('revision-outdated', `${parent} is in force, not ${o.expectRevision}; read the run again`)
    // One result confirmation among unfinished nodes: a correction adds a
    // new confirming talk after the completed one.
    const confirming = Object.entries(next.nodes).filter(([, n]) => n.confirms === 'result').map(([id]) => id)
    const unfinished = confirming.filter(id => record.nodes[id]?.state !== 'completed')
    for (const i of validateWorkflow(next)) {
      if (i.severity !== 'error') continue
      if (i.code === 'confirms-duplicate' && unfinished.length <= 1) continue
      problem('adjust-graph', i.message)
    }
    const compiled = compile(next)
    if (!compiled.ok) problem('adjust-graph', compiled.message)
    const authored = authoredDiff(active.workflow, next)
    const notes = adjustNotes(parsed.doc.toJS(), active.workflow, next)
    const newGraph = compiled.ok ? { nodes: compiled.graph.nodes, edges: compiled.graph.edges } : graph
    const gdiff = graphDiff(graph, newGraph)
    const base = { dryRun: !!o.dryRun, parent, authored, graph: gdiff, ...(notes.length ? { notes } : {}) }
    const revision = `r${(record.definition.revisions?.length ?? 0) + 2}`
    const revFile = `${DEFINITION_DIR}/${revision}/${record.definition.root}.yaml`
    const input = compiled.ok ? {
      op: 'run.adjust' as const, revision, parent, file: revFile, sha256: sha256(o.text), definitionDigest: await semanticDigest('definition', next), effective: compiled.graph,
      reason: o.reason, source, ...(o.completing ? { completing: o.completing.node } : {}), ...(ctx.attempt ? { attempt: ctx.attempt } : {}), ...(ctx.receipt ? { receipt: ctx.receipt } : {}),
    } : null
    // The completion that goes with it (p8/ex2), its own receipt derived.
    const completion = o.completing ? {
      op: 'node.complete' as const, node: o.completing.node, outcome: o.completing.outcome, artifacts: o.completing.artifacts ?? [], ...(o.completing.agreement ? { agreement: o.completing.agreement } : {}),
      ...(ctx.attempt ? { attempt: ctx.attempt } : {}), ...(ctx.receipt ? { receipt: `${ctx.receipt}/complete` } : {}),
    } : null
    // The record's own rules, tried on a copy, so an inspection lists them too.
    const both = async (): Promise<RunRecord> => {
      const adjusted = applyOp(record, { op: structuredClone(input!) }, graph, ctx)
      if (!completion) return adjusted
      const g2 = graphOfState(adjusted) ?? graph
      return applyOp(adjusted, await prepareOp(ws, ref, adjusted, g2, completion), g2, { ...ctx, expectSeq: undefined })
    }
    let tried: RunRecord | null = null
    if (input && !o.propose) {
      try { tried = await both() } catch (e) {
        if (!(e instanceof RequestError)) throw e
        const code = (e.detail as { code?: string } | undefined)?.code ?? 'refused'
        if (!problems.some(p => p.code === code)) problem(code, e.message)
      }
    }
    if (problems.length || o.dryRun) return { ok: !problems.length, ...base, problems }
    // Reminders at the completion that goes with it (fix5), on the revised
    // record, before the revision file or the record is written.
    if (o.completing && tried && ctx.advice) await adviseOrRefuse(ws, ctx.advice, { kind: 'complete', node: o.completing.node }, { record, after: tried, graph: graphOfState(tried) ?? newGraph, authored: next, catalog: catalogOf(record, bundle) })
    if (o.propose) {
      if (!ID_PATTERN.test(o.propose)) throw new RequestError(400, `proposal name "${o.propose}" must match ${ID_PATTERN.source}`)
      const rel = `${DEFINITION_DIR}/proposals/${o.propose}.yaml`
      const asked = Object.values(record.questions).find(q => q.document?.path === `${runDir(ref)}/${rel}`)
      if (asked && asked.document!.sha256 !== sha256(o.text)) throw new RequestError(409, `${rel} was asked about in ${asked.id}; a changed proposal gets a new name`, { code: 'proposal-asked' })
      await mkdir(join(dir, DEFINITION_DIR, 'proposals'), { recursive: true })
      await atomicWrite(join(dir, rel), o.text)
      return { ok: true, ...base, proposal: rel, problems }
    }
    const abs = join(dir, revFile)
    // An unreferenced file of this revision number is a leftover of an
    // interrupted adjustment: replaced.
    await mkdir(join(dir, DEFINITION_DIR, revision), { recursive: true })
    await atomicWrite(abs, o.text)
    try {
      // One write: the adjustment and, at a completion, the completion.
      const r = await both()
      await writeRecord(dir, r)
      return { ok: true, ...base, revision, problems, record: r }
    } catch (e) {
      await rm(join(dir, DEFINITION_DIR, revision), { recursive: true, force: true })
      throw e
    }
  }, { what: `run ${runKey(ref)}` })
}

// ---- work recorded as done afterwards (fix5, docs/adjustments.md) ------------------------

export interface RecordDoneOptions {
  node?: string // the new node's id (default: the template's id, made unique)
  template?: string // a template of the run's catalog snapshot
  type?: string; name?: string; description?: string // a node without a template
  after?: string[]; before?: string[] // where it goes; it follows completed nodes only
  outcome: string
  reason: string // why it is recorded afterwards
  artifacts?: string[] // project-relative files it produced; each must exist
  commits?: { commit: string; repository?: string }[] // commits it made; each must exist
  entries?: number[] // earlier entries of this run that show it (e.g. the talk's completion)
  questions?: string[]; outputs?: string[]
  presentation?: string // an existing presentation that shows it: linked, its registration unchanged
  reported?: { started?: string; ended?: string } // the work's own times, as the recorder states them
  expectRevision?: string
}

// Adds a node and records it as already done, in one entry under the run's
// lock: the revision file first, then run.json; a refusal removes the file.
// Nothing is started, launched, dispatched or answered.
export async function recordDone(ws: Workspace, ref: RunRef, o: RecordDoneOptions, ctx: OpContext & { attempt?: string; receipt?: string }): Promise<{ record: RunRecord; revision: string; node: string; duplicate?: boolean }> {
  ws = await runSpace(ws, ref)
  const file = join(await inside(ws.root, runDir(ref)), RUN_FILE)
  return withLock(file, async () => {
    const { record, graph, dir, bundle } = await usableRun(ws, ref)
    const seen = ctx.receipt ? record.history.find(h => h.receipt === ctx.receipt) : undefined
    if (seen) {
      if (seen.op !== 'run.record-done') throw new RequestError(409, `receipt ${ctx.receipt} already recorded ${seen.op} at seq ${seen.seq}`, { code: 'receipt-reused' })
      const d = seen as unknown as { revision: string; node: string }
      return { record, revision: d.revision, node: d.node, duplicate: true }
    }
    const parent = activeRevision(record.definition)
    if (o.expectRevision && o.expectRevision !== parent) throw new RequestError(409, `${parent} is in force, not ${o.expectRevision}; read the run again`, { code: 'revision-outdated' })
    const active = activeDefinition(record, bundle)
    const parsed = parseWorkflow(active.text)
    if (!parsed.ok) throw new RequestError(409, `the definition in force cannot be read: ${parsed.problem.message}`)
    const after = [...new Set(o.after ?? [])], before = [...new Set(o.before ?? [])]
    let next: Workflow, node: string
    if (o.template) {
      const cat = catalogOf(record, bundle)
      const t = cat.state === 'supplied' ? cat.snapshot.templates.find(x => x.id === o.template) : undefined
      if (!t) throw new RequestError(422, `the run's catalog has no template "${o.template}" (${cat.state === 'supplied' ? cat.snapshot.templates.map(x => x.id).join(', ') || 'none' : `catalog ${cat.state}`})`, { code: 'template-unknown' })
      try { ({ workflow: next, node } = instantiate(parsed.model, t, { id: o.node, after, before })) } catch (e) {
        if (e instanceof CatalogError) throw new RequestError(422, e.message, { code: e.code })
        throw e
      }
    } else {
      if (!o.type || !o.name?.trim()) throw new RequestError(400, 'without a template, give the node\'s type and name')
      node = o.node ?? ''
      if (!ID_PATTERN.test(node)) throw new RequestError(400, `node id "${node}" must match ${ID_PATTERN.source}`)
      if (node in parsed.model.nodes) throw new RequestError(422, `the run already has a node "${node}"`, { code: 'node-exists' })
      for (const n of [...after, ...before]) if (!(n in parsed.model.nodes)) throw new RequestError(422, `node "${n}" is not in the run's definition`, { code: 'node-unknown' })
      next = structuredClone(parsed.model)
      next.nodes[node] = { type: o.type, name: o.name.trim(), description: o.description?.trim() || o.name.trim(), repositories: [] }
      for (const a of after) next.edges.push({ from: a, to: node })
      for (const b of before) next.edges.push({ from: node, to: b })
    }
    const text = renderWorkflow(parsed.doc, next)
    const errors = validateWorkflow(next).filter(i => i.severity === 'error')
    if (errors.length) throw new RequestError(422, `the definition with ${node} does not validate: ${errors.map(i => i.message).join('; ')}`, { code: 'adjust-graph' })
    const compiled = compile(next)
    if (!compiled.ok) throw new RequestError(422, compiled.message, { code: 'adjust-graph' })
    // The evidence, checked to exist now.
    const evidence: RetroEvidence[] = []
    const artifacts: string[] = []
    for (const p of o.artifacts ?? []) {
      const n = normalizeRepoPath(p)
      if (!n || n === '.') throw new RequestError(400, `artifact "${p}" must be a project-relative file`)
      const abs = await inside(ws.root, n)
      const l = await lstat(abs).catch(() => null)
      if (!l?.isFile()) throw new RequestError(422, `${n} does not exist as a file in the run's copy; evidence names what exists`, { code: 'evidence-unknown' })
      const bytes = await readFile(abs)
      artifacts.push(n)
      evidence.push({ kind: 'artifact', path: n, sha256: sha256(bytes), bytes: bytes.length })
    }
    for (const c of o.commits ?? []) {
      const repo = normalizeRepoPath(c.repository ?? '.') ?? '.'
      const r = await git(await inside(ws.root, repo), ['rev-parse', '--verify', '--quiet', `${c.commit}^{commit}`])
      if (r.code !== 0) throw new RequestError(422, `commit ${c.commit} does not exist in ${repo === '.' ? 'the run\'s copy' : repo}`, { code: 'evidence-unknown' })
      evidence.push({ kind: 'commit', repository: repo, commit: r.stdout.trim() })
    }
    for (const seq of o.entries ?? []) {
      const e = record.history[seq - 1]
      if (!e) throw new RequestError(422, `entry ${seq} is not in this run's history`, { code: 'evidence-unknown' })
      evidence.push({ kind: 'entry', seq, op: e.op })
    }
    for (const id of o.questions ?? []) evidence.push({ kind: 'question', id } as RetroEvidence)
    for (const id of o.outputs ?? []) evidence.push({ kind: 'output', id, digest: '' } as RetroEvidence)
    if (o.presentation) evidence.push({ kind: 'presentation', id: o.presentation, revision: '' } as RetroEvidence)
    const revision = `r${(record.definition.revisions?.length ?? 0) + 2}`
    const revFile = `${DEFINITION_DIR}/${revision}/${record.definition.root}.yaml`
    const input = {
      op: 'run.record-done' as const, revision, parent, file: revFile, sha256: sha256(text), definitionDigest: await semanticDigest('definition', next), effective: compiled.graph,
      node, outcome: o.outcome, reason: o.reason, artifacts, evidence,
      ...(o.reported && (o.reported.started || o.reported.ended) ? { reported: { started: o.reported.started ?? null, ended: o.reported.ended ?? null } } : {}),
      ...(o.presentation ? { presentation: o.presentation } : {}),
      ...(ctx.attempt ? { attempt: ctx.attempt } : {}), ...(ctx.receipt ? { receipt: ctx.receipt } : {}),
    }
    const r = applyOp(record, { op: structuredClone(input) }, graph, ctx) // every record rule, before anything is written
    await mkdir(join(dir, DEFINITION_DIR, revision), { recursive: true })
    await atomicWrite(join(dir, revFile), text)
    try {
      await writeRecord(dir, r)
      return { record: r, revision, node }
    } catch (e) {
      await rm(join(dir, DEFINITION_DIR, revision), { recursive: true, force: true })
      throw e
    }
  }, { what: `run ${runKey(ref)}` })
}

// A file of the run folder (not a link out of it), by hash.
async function checkRunFile(ws: Workspace, ref: RunRef, rel: string): Promise<DocumentEvidence | { problem: string }> {
  let folder: string
  try { folder = await realpath(await inside(ws.root, runDir(ref))) } catch (e) { return { problem: (e as Error).message } }
  const abs = join(folder, rel)
  const l = await lstat(abs).catch(() => null)
  if (!l?.isFile() || l.isSymbolicLink()) return { problem: `${runDir(ref)}/${rel} is not a file; write it first (wfe run adjust … --propose)` }
  if (!(await realpath(abs)).startsWith(folder + sep)) return { problem: `${rel} resolves outside the run folder` }
  const bytes = await readFile(abs)
  if (!bytes.length) return { problem: `${rel} is empty` }
  return { path: `${runDir(ref)}/${rel}`, sha256: sha256(bytes), bytes: bytes.length }
}

// ---- presentations (p7, docs/presentations.md) -------------------------------------

export interface RegisterOptions {
  node: string
  source: string // project-relative directory whose files are presented
  entry: string // the file to open, relative to source
  review: string // project-relative Markdown: what changed, how to use it, what to check
  title: string
}
const MAX_PRESENT_FILES = 2000
const MAX_PRESENT_BYTES = 200 * 1024 * 1024
const MAX_REVIEW = 64 * 1024

// The files of a directory to present: regular files only, no symbolic
// links, no dot-entries (.git, .DS_Store …), bounded in count and size.
async function presentedFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  let total = 0
  const walk = async (rel: string) => {
    for (const e of (await readdir(join(dir, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) throw new RequestError(422, `${r} is a symbolic link; a presentation holds copies of regular files only`, { code: 'presentation-source' })
      if (e.isDirectory()) { await walk(r); continue }
      if (!e.isFile()) continue
      total += (await stat(join(dir, r))).size
      out.push(r)
      if (out.length > MAX_PRESENT_FILES || total > MAX_PRESENT_BYTES) throw new RequestError(422, `the source has more than ${MAX_PRESENT_FILES} files or ${MAX_PRESENT_BYTES} bytes; present a smaller bundle`, { code: 'presentation-source' })
    }
  }
  await walk('')
  return out
}

// Freezes a result as presentation p<n> of the run and records it, under
// the run's lock: the files are copied into the run folder, the manifest
// written, and the registration recorded — or, if the record refuses it,
// the copy removed again. A retransmission (same receipt) changes nothing.
export async function registerPresentation(ws: Workspace, ref: RunRef, o: RegisterOptions, ctx: OpContext & { attempt?: string; receipt?: string }): Promise<{ record: RunRecord; presentation: Presentation; duplicate?: boolean }> {
  ws = await runSpace(ws, ref)
  const file = join(await inside(ws.root, runDir(ref)), RUN_FILE)
  return withLock(file, async () => {
    const { record, graph, bundle } = await usableRun(ws, ref)
    const dup = ctx.receipt ? record.history.find(h => h.receipt === ctx.receipt) : undefined
    if (dup && dup.op === 'presentation.register') return { record, presentation: record.presentations![(dup as unknown as { presentation: string }).presentation], duplicate: true }
    // Reminders (fix5) before anything is copied: where it is registered
    // from, and whether anything is planned to stop it.
    if (ctx.advice && record.nodes[o.node]?.state === 'running') await adviseOrRefuse(ws, ctx.advice, { kind: 'present', node: o.node }, { record, after: record, graph, authored: activeDefinition(record, bundle).workflow, catalog: catalogOf(record, bundle) })
    const id = `p${Object.keys(record.presentations ?? {}).length + 1}`
    const source = normalizeRepoPath(o.source)
    if (!source) throw new RequestError(400, `source "${o.source}" must be a project-relative directory`)
    const srcAbs = await inside(ws.root, source)
    const sl = await lstat(srcAbs).catch(() => null)
    if (!sl?.isDirectory()) throw new RequestError(422, `${source} is not a directory of the workspace`, { code: 'presentation-source' })
    if ((await realpath(srcAbs)).startsWith((await realpath(await inside(ws.root, runDir(ref)))) + sep)) throw new RequestError(422, 'the source is inside the run folder; present the result where it was made', { code: 'presentation-source' })
    const names = await presentedFiles(srcAbs)
    const entry = normalizeRepoPath(o.entry)
    if (!entry || !names.includes(entry)) throw new RequestError(422, `the entry "${o.entry}" is not a file of ${source}`, { code: 'presentation-source' })
    const reviewRel = normalizeRepoPath(o.review)
    if (!reviewRel || reviewRel === '.') throw new RequestError(400, `review "${o.review}" must be a project-relative file`)
    const reviewAbs = await inside(ws.root, reviewRel)
    const rl = await lstat(reviewAbs).catch(() => null)
    if (!rl?.isFile() || rl.isSymbolicLink()) throw new RequestError(422, `${reviewRel} is not a regular file; write the review first`, { code: 'presentation-review' })
    if (rl.size === 0 || rl.size > MAX_REVIEW) throw new RequestError(422, `${reviewRel} is ${rl.size === 0 ? 'empty' : `larger than ${MAX_REVIEW} bytes`}`, { code: 'presentation-review' })
    const folderRel = presentationFolder(ref, id)
    const folder = await inside(ws.root, folderRel)
    // A folder left by a registration that crashed before its record: not
    // part of the run, replaced.
    await rm(folder, { recursive: true, force: true })
    await mkdir(join(folder, 'content'), { recursive: true })
    const files: { path: string; sha256: string; bytes: number }[] = []
    try {
      for (const n of names) {
        await mkdir(join(folder, 'content', n, '..'), { recursive: true })
        await copyFile(join(srcAbs, n), join(folder, 'content', n))
        const bytes = await readFile(join(folder, 'content', n))
        files.push({ path: `content/${n}`, sha256: sha256(bytes), bytes: bytes.length })
      }
      const review = await readFile(reviewAbs)
      await writeFile(join(folder, 'review.md'), review)
      files.push({ path: 'review.md', sha256: sha256(review), bytes: review.length })
      files.sort((a, b) => (a.path < b.path ? -1 : 1))
      const body = { kind: MANIFEST_KIND, entry: `content/${entry}`, review: 'review.md', files }
      const revision = `sha256:${sha256(canonicalJson(body))}`
      await writeFile(join(folder, 'manifest.json'), `${JSON.stringify({ ...body, presentation: id, revision, source }, null, 2)}\n`)
      const input = { op: 'presentation.register' as const, presentation: id, node: o.node, title: o.title, manifest: { revision, entry: body.entry, review: 'review.md', files: files.map(f => ({ ...f, path: `${folderRel}/${f.path}` })) }, ...(ctx.attempt ? { attempt: ctx.attempt } : {}), ...(ctx.receipt ? { receipt: ctx.receipt } : {}) }
      const r = await runOpLocked(ws, ref, input, ctx)
      return { record: r.record, presentation: r.record.presentations![id] }
    } catch (e) {
      await rm(folder, { recursive: true, force: true })
      throw e
    }
  }, { what: `run ${runKey(ref)}` })
}

// The document a step writes: a regular, nonempty file inside the run
// folder (no symbolic link out of it). Its hash and size are the evidence.
export async function checkDocument(ws: Workspace, ref: RunRef, step: StepSpec): Promise<DocumentEvidence | { problem: string }> {
  const path = documentPath(ref, step)
  if (step.output.includes('/') || step.output.startsWith('.')) return { problem: `${step.output} is not a file name of the run folder` }
  let folder: string
  try { folder = await realpath(await inside(ws.root, runDir(ref))) } catch (e) { return { problem: `the run folder cannot be resolved inside the workspace: ${(e as Error).message}` } }
  const abs = join(folder, step.output)
  const l = await lstat(abs).catch(() => null)
  if (!l) return { problem: `${path} does not exist; write it before recording the step` }
  if (l.isSymbolicLink()) return { problem: `${path} is a symbolic link; the document must be a file of the run folder` }
  if (!l.isFile()) return { problem: `${path} is not a file` }
  if (!(await realpath(abs)).startsWith(folder + sep)) return { problem: `${path} resolves outside the run folder` }
  if (l.size > MAX_READ) return { problem: `${path} is larger than ${MAX_READ} bytes` }
  const bytes = await readFile(abs)
  if (!bytes.toString('utf8').trim()) return { problem: `${path} is empty` }
  return { path, sha256: sha256(bytes), bytes: bytes.length }
}

// A deliverable: a regular, nonempty file inside the project (not a link
// out of it), by hash and size. Large files are fine (a PPTX); its content
// is not read as text.
const MAX_SUBJECT = 200 * 1024 * 1024
export async function checkSubject(ws: Workspace, path: string): Promise<DocumentEvidence> {
  const rel = normalizeRepoPath(path)
  if (!rel || rel === '.') throw new RequestError(400, `subject "${path}" must be a project-relative file path`)
  const abs = await inside(ws.root, rel)
  const l = await lstat(abs).catch(() => null)
  if (!l) throw new RequestError(422, `${rel} does not exist; write the deliverable before presenting it`, { code: 'subject-missing' })
  if (l.isSymbolicLink() || !l.isFile()) throw new RequestError(422, `${rel} is not a regular file`, { code: 'subject-missing' })
  if (!(await realpath(abs)).startsWith((await realpath(ws.root)) + sep)) throw new RequestError(422, `${rel} resolves outside the project`, { code: 'subject-missing' })
  if (l.size === 0) throw new RequestError(422, `${rel} is empty`, { code: 'document-empty' })
  if (l.size > MAX_SUBJECT) throw new RequestError(422, `${rel} is larger than ${MAX_SUBJECT} bytes`, { code: 'subject-missing' })
  const bytes = await readFile(abs)
  return { path: rel, sha256: sha256(bytes), bytes: bytes.length }
}

// ---- checking --------------------------------------------------------------------

export interface RunCheck { ref: string; ok: boolean; problem?: string; code?: string; warnings: string[] }

// The record, its bundle and its relations. Reads only.
export async function checkRun(ws: Workspace, ref: RunRef): Promise<RunCheck> {
  const r = await runResponse(ws, ref)
  const warnings: string[] = []
  if (r.record) {
    for (const a of r.artifacts) if (!a.exists) warnings.push(`artifact ${a.path} does not exist`)
    const input = r.files.some(f => f.name === r.record!.input.file)
    if (!input) warnings.push(`the input file ${r.record.input.file} is missing`)
  }
  return { ref: r.ref, ok: !!r.record, problem: r.problem?.message, code: r.problem?.code, warnings }
}
