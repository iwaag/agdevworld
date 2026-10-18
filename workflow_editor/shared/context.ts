// Scoped context (workflow_editor p13, p14; docs/context.md): what WFE gives
// an agent besides the run's own records, from which scope and from whose
// storage. Shared by the service, the CLI and the browser.
//
// A bundle is a list of sources. Each says its scope (system, project,
// workflow, run), its category (a repository-owned default, a local block,
// or run input), where it applies (execution, authoring), where it comes
// from, and how it is delivered: its body in the text, a reference the agent
// may read, absent (nothing configured), or an error (configured but
// unreadable). Nothing here ranks or merges prose: scope and provenance are
// shown, and the agent reads them as instructions or information of that
// breadth.
//
// Local context (p14) is a set of independently managed blocks per scope:
// each has its own identity, title, manager, kind (instruction or
// environment information), body, evidence and revisions. A block is one
// source; what it delivers is its rendered section (renderBlock), and that
// section's hash is the source's sha256, so bookkeeping that is not in the
// section (a verification check, a revision number) never changes the
// fingerprint, and anything that is in it always does.
import { canonicalJson, sha256Plain } from './canonical.ts'

export const CONTEXT_SCHEMA = 'ag.wfe-context.v2'
// Snapshots prepared before p14 (single overrides) stay readable.
export const READABLE_CONTEXT_SCHEMAS: readonly string[] = ['ag.wfe-context.v1', CONTEXT_SCHEMA]
export const CONTEXT_SCOPES = ['system', 'project', 'workflow', 'run'] as const
export type ContextScope = typeof CONTEXT_SCOPES[number]
export type ContextCategory = 'default' | 'override' | 'input'
export type ContextPurpose = 'execution' | 'authoring'
export type ContextDelivery = 'body' | 'reference' | 'absent' | 'error'
// 'override' is a p13 snapshot's single local override; p14 bundles have blocks.
export type ContextKind = 'contract' | 'block' | 'override' | 'intent' | 'guide' | 'input'

export interface ContextOrigin {
  file?: string // a portable path: project-relative, or the context store's logical path
  project?: string // the project a guide was read from (a cross-project guide)
  commit?: string // the commit a cross-project guide was read at
  revision?: number // a block's revision
  updated?: { at: string; by: string }
  host?: string // supplied by the execution host (the common contract)
}

export interface ContextSource {
  key: string // stable within a bundle: system/contract, system/block/<id>, project/intent, guide/<key>, project/block/<id>, workflow/intent, workflow/block/<id>, run/input
  scope: ContextScope
  category: ContextCategory
  kind: ContextKind
  applies: ContextPurpose[]
  title: string
  origin: ContextOrigin
  // Every declaration that names this source (a guide listed by the project
  // and by the workflow is one source, delivered once).
  provenance: string[]
  delivery: ContextDelivery
  sha256?: string // of the delivered body (a block: its rendered section) or the referenced file
  text?: string // the body, when delivered as body (a block: its rendered section)
  reference?: string // what to read, when delivered as a reference
  note?: string // why absent, or the read error
  block?: BlockSummary // a local block's identity and ownership
}

export interface ContextBundle {
  schema: typeof CONTEXT_SCHEMA | 'ag.wfe-context.v1'
  purpose: ContextPurpose
  project: string
  workflow: string | null
  run: string | null
  resolved: string
  sources: ContextSource[]
  fingerprint: string
}

// What a run record keeps of the bundle an attempt was prepared with
// (run.json attempt.begin settings.context): portable identities only, no
// local text and no host path.
export interface AttemptContext { snapshot: string; fingerprint: string; sources: { key: string; scope: ContextScope; category: ContextCategory; delivery: ContextDelivery; sha256?: string }[] }

// Sources that decide the conversation's configuration: everything but run
// input (a continuation carries new input) and the host's common contract
// (compared by its own hash). Only delivered content counts: a block's
// sha256 is its rendered section, so a check or a revision number that is
// not delivered keeps the fingerprint.
export function effectiveSources(b: Pick<ContextBundle, 'sources'>): { key: string; delivery: ContextDelivery; sha256: string | null }[] {
  return b.sources.filter(s => s.scope !== 'run' && s.kind !== 'contract')
    .map(s => ({ key: s.key, delivery: s.delivery, sha256: s.sha256 ?? null }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}
export function fingerprintOf(b: Pick<ContextBundle, 'sources'>): string {
  return `sha256:${sha256Plain(new TextEncoder().encode(canonicalJson(effectiveSources(b))))}`
}

export function attemptContext(b: ContextBundle, snapshot: string): AttemptContext {
  return { snapshot, fingerprint: b.fingerprint, sources: b.sources.map(s => ({ key: s.key, scope: s.scope, category: s.category, delivery: s.delivery, ...(s.sha256 ? { sha256: s.sha256 } : {}) })) }
}

// How two bundles (or recorded attempt contexts) differ, source by source.
export interface ContextChange { key: string; change: 'added' | 'removed' | 'changed' | 'delivery'; title?: string; from?: string; to?: string }
type Comparable = { key: string; delivery: ContextDelivery; sha256?: string | null; title?: string }
export function contextChanges(was: Comparable[], now: Comparable[], opts: { effectiveOnly?: boolean } = {}): ContextChange[] {
  const keep = (s: Comparable) => !opts.effectiveOnly || (!s.key.startsWith('run/') && s.key !== 'system/contract')
  const a = new Map(was.filter(keep).map(s => [s.key, s])), b = new Map(now.filter(keep).map(s => [s.key, s]))
  const out: ContextChange[] = []
  for (const [k, s] of b) {
    const p = a.get(k)
    const present = (x?: Comparable) => !!x && x.delivery !== 'absent'
    if (!present(p) && present(s)) out.push({ key: k, change: 'added', title: s.title })
    else if (present(p) && !present(s)) out.push({ key: k, change: 'removed', title: s.title ?? p!.title })
    else if (p && p.delivery !== s.delivery) out.push({ key: k, change: 'delivery', title: s.title, from: p.delivery, to: s.delivery })
    else if (p && (p.sha256 ?? null) !== (s.sha256 ?? null)) out.push({ key: k, change: 'changed', title: s.title, from: p.sha256 ?? undefined, to: s.sha256 ?? undefined })
  }
  for (const [k, p] of a) if (!b.has(k) && p.delivery !== 'absent') out.push({ key: k, change: 'removed', title: p.title })
  return out
}
export const changeWords = (c: ContextChange) => `${c.key} ${c.change === 'delivery' ? `delivery ${c.from} → ${c.to}` : c.change}`

const SCOPE_WORD: Record<ContextScope, string> = { system: 'System', project: 'Project', workflow: 'Workflow', run: 'Run' }
const CATEGORY_WORD: Record<ContextCategory, string> = { default: 'default', override: 'local', input: 'input' }
export const sourceLabel = (s: Pick<ContextSource, 'scope' | 'category' | 'title' | 'block'>) =>
  s.block ? `${SCOPE_WORD[s.scope]} ${s.block.kind === 'information' ? 'environment information' : 'instruction'} — ${s.title}` : `${SCOPE_WORD[s.scope]} ${CATEGORY_WORD[s.category]} — ${s.title}`

function originWords(s: ContextSource): string {
  const o = s.origin
  const bits: string[] = []
  if (o.host) bits.push(`supplied by the execution host ${o.host}`)
  if (o.file) bits.push(o.project ? `${o.project}:${o.file}` : o.file)
  if (o.commit) bits.push(`at ${o.commit.slice(0, 12)}`)
  if (o.revision !== undefined) bits.push(`revision ${o.revision}`)
  if (o.updated) bits.push(`updated ${o.updated.at} by ${o.updated.by}`)
  if (s.provenance.length > 1) bits.push(`declared by ${s.provenance.join(' and ')}`)
  return bits.join(', ')
}

// The text an agent is given: one section per delivered source, in scope
// order. A block's section is its own rendering (renderBlock); other
// sources are headed by scope, category and origin. A reference is named
// and not included; an absent source is left out of the text (the bundle
// still lists it). The executor puts this after its common contract.
export function renderContext(b: ContextBundle, opts: { snapshot?: string } = {}): string {
  const lines = [
    `# Context (${b.purpose === 'execution' ? (b.run ? `run ${b.project}/${b.workflow}/${b.run}` : `a new run of ${b.project}/${b.workflow}`) : `authoring ${b.project}${b.workflow ? `/${b.workflow}` : ''}`}; WFE context ${b.fingerprint.slice(7, 19)}${opts.snapshot ? `, snapshot ${opts.snapshot}` : ''})`,
    '',
    'WFE resolved these sources for you by scope: system (every project), project (every workflow of this project), workflow (every run of this workflow). A default is kept in the project\'s repositories; local context is kept on this WFE area, not in Git, in blocks that each name who manages them and who last edited them. An instruction is guidance to follow; environment information is facts and advice about resources, with its evidence and age: check what a decision depends on. Scope says how widely a source applies, not which one wins: an explicit request or a more specific instruction refines a general one. A reference is named, not included; read it when it matters (`wfe context detail <context:…>` reads a block\'s detail).',
  ]
  for (const s of b.sources) {
    if (s.delivery === 'absent' || s.kind === 'contract' || s.scope === 'run') continue
    if (s.block && s.delivery === 'body') { lines.push('', (s.text ?? '').trimEnd()); continue }
    const head = `## ${sourceLabel(s)}${originWords(s) ? ` (${originWords(s)})` : ''}`
    if (s.delivery === 'body') lines.push('', head, '', (s.text ?? '').trimEnd())
    else if (s.delivery === 'reference') lines.push('', head, '', `Reference, not included: ${s.reference}`)
    else lines.push('', head, '', `Configured but unreadable: ${s.note}`)
  }
  return lines.join('\n')
}

// A line per source, for the CLI and logs.
export function sourceLines(b: Pick<ContextBundle, 'sources'>): string[] {
  return b.sources.map(s => `${s.scope.padEnd(8)} ${s.category.padEnd(8)} ${s.delivery.padEnd(9)} ${s.key}${s.sha256 ? ` ${s.sha256.slice(0, 12)}` : ''} — ${s.title}${s.block ? ` (managed by ${s.block.manager}; last edited by ${s.block.editor.by})` : originWords(s) ? ` (${originWords(s)})` : ''}${s.note ? ` — ${s.note}` : ''}${s.reference && s.delivery === 'reference' ? ` → ${s.reference}` : ''} [${s.applies.join(', ')}]`)
}

// ---- local blocks (p14) ------------------------------------------------------

// A scope of the local store: this WFE area (system), a project, or one of
// its workflows.
export interface ScopeTarget { scope: 'system' | 'project' | 'workflow'; project?: string; workflow?: string }
export const scopeKey = (t: ScopeTarget) => t.scope === 'system' ? 'system' : t.scope === 'project' ? `project/${t.project}` : `workflow/${t.project}/${t.workflow}`
export const scopeWords = (t: ScopeTarget) => t.scope === 'system' ? 'all projects (system)' : t.scope === 'project' ? `project ${t.project}` : `workflow ${t.project}/${t.workflow}`
// A block's logical file in the store (portable: the store is
// <area>/.local/contexts/ on the host that owns the WFE area).
export const blockFile = (t: ScopeTarget, id: string) => t.scope === 'system' ? `contexts/system/${id}.json` : t.scope === 'project' ? `contexts/projects/${t.project}/project/${id}.json` : `contexts/projects/${t.project}/workflows/${t.workflow}/${id}.json`
// A detail's logical reference, readable from any host through the owning
// service (wfe context detail, GET api/context/detail?ref=).
export const detailRef = (t: ScopeTarget, id: string, name: string) => `context:${scopeKey(t)}/${id}/${name}`
export function parseDetailRef(ref: string): { target: ScopeTarget; block: string; name: string } | null {
  const m = /^context:(?:(system)|project\/([^/]+)|workflow\/([^/]+)\/([^/]+))\/([^/]+)\/([^/]+)$/.exec(ref)
  if (!m) return null
  const target: ScopeTarget = m[1] ? { scope: 'system' } : m[2] ? { scope: 'project', project: m[2] } : { scope: 'workflow', project: m[3], workflow: m[4] }
  return { target, block: m[5], name: m[6] }
}

export const BLOCK_KINDS = ['instruction', 'information'] as const
export type BlockKind = typeof BLOCK_KINDS[number]
// What a piece of evidence is: something observed on the cluster, something
// someone reported, something declared as desired, or a recommendation.
export const EVIDENCE_BASES = ['observed', 'reported', 'desired', 'recommendation'] as const
export type EvidenceBasis = typeof EVIDENCE_BASES[number]
// How that evidence came out: complete, partial coverage, a failed
// observation, or not known.
export const EVIDENCE_STATUSES = ['ok', 'partial', 'failed', 'unknown'] as const
export type EvidenceStatus = typeof EVIDENCE_STATUSES[number]
export interface EvidenceRef {
  ref: string // where it is: a context: detail, a project file or run (wfe projects …), a shared:// path, a command
  title?: string
  basis: EvidenceBasis
  status: EvidenceStatus
  observed?: string // when the source itself was observed (ISO); never the publication time
  coverage?: string // what it covers, e.g. "6 of 7 hosts; agbach not reachable"
}
export interface BlockDetail { name: string; sha256: string; bytes: number; at: string; by: string }
export interface BlockEditor { by: string; at: string; run?: string; via?: string }
// A later verification of unchanged content: bookkeeping, not delivered.
export interface BlockCheck { at: string; by: string; run?: string; note?: string }
// The latest refresh that did not succeed; the content stays as it was and
// this is delivered with it. A later publication with evidence clears it.
export interface BlockRefresh { at: string; by: string; outcome: 'failed' | 'partial'; detail: string; run?: string }

export interface ContextBlock {
  id: string
  title: string
  manager: string // who maintains the block (not an authentication claim)
  kind: BlockKind
  body: string
  evidence: EvidenceRef[]
  consult?: string // where to ask the manager: <project>/<workflow> of a consultation workflow
  details: BlockDetail[]
  editor: BlockEditor // who last changed the delivered content, and when
  checked?: BlockCheck
  refresh?: BlockRefresh
}
export interface BlockSummary { id: string; kind: BlockKind; manager: string; editor: BlockEditor; revision: number; checked?: BlockCheck; refresh?: BlockRefresh; evidence: EvidenceRef[]; consult?: string; details: string[] }

export const blockSummary = (b: ContextBlock, revision: number): BlockSummary => ({
  id: b.id, kind: b.kind, manager: b.manager, editor: b.editor, revision, evidence: b.evidence, details: b.details.map(d => d.name),
  ...(b.checked ? { checked: b.checked } : {}), ...(b.refresh ? { refresh: b.refresh } : {}), ...(b.consult ? { consult: b.consult } : {}),
})

const SCOPE_HEAD: Record<ScopeTarget['scope'], string> = { system: 'System', project: 'Project', workflow: 'Workflow' }
const day = (iso: string) => iso.slice(0, 10)
const minute = (iso: string) => `${iso.slice(0, 16)}Z`

// The section a block delivers: what an agent reads, and what the
// fingerprint covers. It holds the facts that affect decisions — title,
// kind, manager, last editor and day, evidence with its observation times,
// status and coverage, a refresh that failed, where to read details and
// whom to ask — and nothing that only records bookkeeping (a later check,
// the revision number, the time of day of an edit). No age is computed:
// times are absolute, the GUI shows ages.
export function renderBlock(t: ScopeTarget, b: ContextBlock): string {
  const info = b.kind === 'information'
  const lines = [`## ${SCOPE_HEAD[t.scope]} ${info ? 'environment information' : 'instruction'} — ${b.title}`, '']
  const edited = `last edited by ${b.editor.by} on ${day(b.editor.at)}${b.editor.run ? ` (${b.editor.run})` : ''}`
  lines.push(info ? `Facts and advice, not instructions. Managed by ${b.manager}; ${edited}.` : `Managed by ${b.manager}; ${edited}.`)
  if (b.evidence.length) {
    lines.push('Evidence:')
    for (const e of b.evidence) lines.push(`- ${e.basis}${e.observed ? ` ${minute(e.observed)}` : ', observation time not known'}; ${e.status}${e.coverage ? ` (${e.coverage})` : ''}: ${e.title ? `${e.title} — ` : ''}${e.ref}`)
  } else if (info) lines.push('Evidence: none recorded; treat these statements as unverified.')
  if (b.refresh) lines.push(`The latest refresh, on ${day(b.refresh.at)}, ${b.refresh.outcome === 'failed' ? 'failed' : 'was partial'}: ${b.refresh.detail}. The content is still from the evidence above.`)
  if (b.details.length) lines.push(`Details (read on demand): ${b.details.map(d => detailRef(t, b.id, d.name)).join(', ')}`)
  if (b.consult) lines.push(`Ask ${b.manager}: the ${b.consult} workflow (a delegate node, or a request in its channel wf-${b.consult.replace('/', '.')}).`)
  lines.push('', b.body.trimEnd())
  return `${lines.join('\n')}\n`
}
export const blockDigest = (t: ScopeTarget, b: ContextBlock) => sha256Plain(new TextEncoder().encode(renderBlock(t, b)))
export const textSize = (text: string) => ({ bytes: new TextEncoder().encode(text).length, lines: text.trimEnd() ? text.trimEnd().split('\n').length : 0 })

// One revision of a block: the operation and the block as it was after it
// (null: removed).
export type BlockOp = 'set' | 'check' | 'refresh' | 'remove' | 'external' | 'converted'
export interface BlockRevision { rev: number; at: string; by: string; op: BlockOp; run?: string; via?: string; note?: string; content: boolean; sha256: string | null; block: ContextBlock | null }

export interface BlockState {
  target: ScopeTarget
  id: string
  file: string // logical
  block: ContextBlock | null // null: removed, or never set
  revision: number // the latest revision (0: none)
  base: number // the revision of the latest content change: what a writer names as --base (0: none)
  revisions: number
  sha256: string | null // of the delivered section
  size: { bytes: number; lines: number } | null // of the delivered section
  external: boolean // the stored file differs from its last recorded revision
  problem?: string
}
