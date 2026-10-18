// Scoped context (workflow_editor p13, docs/context.md): what WFE gives an
// agent besides the run's own records, from which scope and from whose
// storage. Shared by the service, the CLI and the browser.
//
// A bundle is a list of sources. Each says its scope (system, project,
// workflow, run), its category (a repository-owned default, a local
// override, or run input), where it applies (execution, authoring), where
// it comes from, and how it is delivered: its body in the text, a reference
// the agent may read, absent (nothing configured), or an error (configured
// but unreadable). Nothing here ranks or merges prose: scope and provenance
// are shown, and the agent reads them as instructions of that breadth.
import { canonicalJson, sha256Plain } from './canonical.ts'

export const CONTEXT_SCHEMA = 'ag.wfe-context.v1'
export const CONTEXT_SCOPES = ['system', 'project', 'workflow', 'run'] as const
export type ContextScope = typeof CONTEXT_SCOPES[number]
export type ContextCategory = 'default' | 'override' | 'input'
export type ContextPurpose = 'execution' | 'authoring'
export type ContextDelivery = 'body' | 'reference' | 'absent' | 'error'
export type ContextKind = 'contract' | 'override' | 'intent' | 'guide' | 'input'

export interface ContextOrigin {
  file?: string // a portable path: project-relative, or the override store's logical path
  project?: string // the project a guide was read from (a cross-project guide)
  commit?: string // the commit a cross-project guide was read at
  revision?: number // an override's revision
  updated?: { at: string; by: string }
  host?: string // supplied by the execution host (the common contract)
}

export interface ContextSource {
  key: string // stable within a bundle: system/contract, system/override, project/intent, guide/<key>, project/override, workflow/intent, workflow/override, run/input
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
  sha256?: string // of the delivered body or the referenced file
  text?: string // the body, when delivered as body
  reference?: string // what to read, when delivered as a reference
  note?: string // why absent, or the read error
}

export interface ContextBundle {
  schema: typeof CONTEXT_SCHEMA
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
// override text and no host path.
export interface AttemptContext { snapshot: string; fingerprint: string; sources: { key: string; scope: ContextScope; category: ContextCategory; delivery: ContextDelivery; sha256?: string }[] }

// Sources that decide the conversation's configuration: everything but run
// input (a continuation carries new input) and the host's common contract
// (compared by its own hash). Metadata (revision, author, time) is left out,
// so an edit that leaves the content as it was keeps the fingerprint.
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
const CATEGORY_WORD: Record<ContextCategory, string> = { default: 'default', override: 'override', input: 'input' }
export const sourceLabel = (s: Pick<ContextSource, 'scope' | 'category' | 'title'>) => `${SCOPE_WORD[s.scope]} ${CATEGORY_WORD[s.category]} — ${s.title}`

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
// order, each headed by its scope, category and origin. A reference is named
// and not included; an absent source is left out of the text (the bundle
// still lists it). The executor puts this after its common contract.
export function renderContext(b: ContextBundle, opts: { snapshot?: string } = {}): string {
  const lines = [
    `# Context (${b.purpose === 'execution' ? `run ${b.project}/${b.workflow}/${b.run}` : `authoring ${b.project}${b.workflow ? `/${b.workflow}` : ''}`}; WFE context ${b.fingerprint.slice(7, 19)}${opts.snapshot ? `, snapshot ${opts.snapshot}` : ''})`,
    '',
    'WFE resolved these sources for you by scope: system (every project), project (every workflow of this project), workflow (every run of this workflow). A default is kept in the project\'s repositories; an override is the Developer\'s local setting, not in Git. Scope says how widely a source applies, not which one wins: an explicit request or a more specific instruction refines a general one. A reference is named, not included; read it when it matters.',
  ]
  for (const s of b.sources) {
    if (s.delivery === 'absent' || s.kind === 'contract' || s.scope === 'run') continue
    const head = `## ${sourceLabel(s)}${originWords(s) ? ` (${originWords(s)})` : ''}`
    if (s.delivery === 'body') lines.push('', head, '', (s.text ?? '').trimEnd())
    else if (s.delivery === 'reference') lines.push('', head, '', `Reference, not included: ${s.reference}`)
    else lines.push('', head, '', `Configured but unreadable: ${s.note}`)
  }
  return lines.join('\n')
}

// A line per source, for the CLI and logs.
export function sourceLines(b: Pick<ContextBundle, 'sources'>): string[] {
  return b.sources.map(s => `${s.scope.padEnd(8)} ${s.category.padEnd(8)} ${s.delivery.padEnd(9)} ${s.key}${s.sha256 ? ` ${s.sha256.slice(0, 12)}` : ''} — ${s.title}${originWords(s) ? ` (${originWords(s)})` : ''}${s.note ? ` — ${s.note}` : ''}${s.reference && s.delivery === 'reference' ? ` → ${s.reference}` : ''} [${s.applies.join(', ')}]`)
}

// The override store's logical location of a scope (portable; the store is
// <area>/.local/contexts/ on the host that owns the WFE area).
export interface OverrideTarget { scope: 'system' | 'project' | 'workflow'; project?: string; workflow?: string }
export const overrideFile = (t: OverrideTarget) => t.scope === 'system' ? 'contexts/system.md' : t.scope === 'project' ? `contexts/projects/${t.project}/project.md` : `contexts/projects/${t.project}/workflows/${t.workflow}.md`
export const overrideKey = (t: OverrideTarget) => t.scope === 'system' ? 'system' : t.scope === 'project' ? `project:${t.project}` : `workflow:${t.project}/${t.workflow}`
export interface OverrideRevision { target: string; rev: number; at: string; by: string; sha256: string | null; note?: string; external?: boolean }
export interface OverrideState {
  target: OverrideTarget
  file: string // logical
  text: string | null
  sha256: string | null
  revision: number | null // the revision the current content is; null: no revision has it (none yet, or edited outside WFE)
  updated: { at: string; by: string } | null
  external: boolean // the file differs from the last recorded revision
  revisions: number
  problem?: string
}
