// Knowledge attached to a node (improve_workflow p3, docs/knowledge.md
// *On a node*): a category as intent, and the findings selected under it, each
// at one revision. Shared by the service, the CLI and the browser; it touches no
// files. An attachment points at knowledge: it requires no reading, proves no
// use and gates nothing. Artwork is never part of it (src/knowledgeIcons.ts).
export const KNOWLEDGE_CATEGORIES = ['motion', 'extraction', 'generation', 'composition', 'verification', 'process', 'domain']
export const CATEGORY_LABEL: Record<string, string> = { motion: 'Motion', extraction: 'Extraction', generation: 'Generation', composition: 'Composition', verification: 'Verification', process: 'Process', domain: 'Domain' }
export const categoryLabel = (c?: string) => (c ? CATEGORY_LABEL[c] ?? c : 'No category')

// One finding at one revision, with P2's reference semantics. `title`, `summary`
// and `status` are a snapshot for reading it when the source is unavailable; the
// sha256 already fixes the content, so they are not part of the digest.
export interface KnowledgeRef { id: string; repository: string; commit: string; path: string; sha256: string; title?: string; summary?: string; status?: string }
export interface KnowledgeAttachment { category?: string; note?: string; findings?: KnowledgeRef[] }

export const QUALIFIED_ID = /^(repo:[^#\s/]+\/[^#\s/]+|[a-z0-9][a-z0-9_.-]*:[^#\s]+)#[A-Za-z0-9][A-Za-z0-9._-]*$/
const COMMIT = /^[0-9a-f]{7,64}$/
const SHA256 = /^[0-9a-f]{64}$/

export interface KnowledgeProblem { severity: 'error' | 'warning'; code: string; message: string }
export function knowledgeProblems(list: KnowledgeAttachment[]): KnowledgeProblem[] {
  const out: KnowledgeProblem[] = []
  const err = (code: string, message: string) => out.push({ severity: 'error', code, message })
  const categories = new Set<string>(), ids = new Set<string>()
  list.forEach((a, i) => {
    if (!a.category && !a.findings?.length) err('knowledge-empty', `knowledge entry ${i + 1} names neither a category nor a finding.`)
    if (a.category) {
      if (categories.has(a.category)) err('knowledge-category-duplicate', `knowledge lists category "${a.category}" twice; keep one entry and its findings.`)
      else if (!KNOWLEDGE_CATEGORIES.includes(a.category)) out.push({ severity: 'warning', code: 'knowledge-category-unknown', message: `knowledge category "${a.category}" is not one of ${KNOWLEDGE_CATEGORIES.join(', ')}; it is kept and shown.` })
      categories.add(a.category)
    }
    for (const f of a.findings ?? []) {
      if (!f.id || !QUALIFIED_ID.test(f.id)) { err('knowledge-finding-id', `knowledge finding "${f.id ?? ''}" is not <collection>#<id> (wfe knowledge ref prints a whole reference).`); continue }
      if (ids.has(f.id)) err('knowledge-finding-duplicate', `knowledge selects ${f.id} twice; a finding is selected once, under one category.`)
      ids.add(f.id)
      if (!f.repository || !f.path) err('knowledge-finding-source', `knowledge finding ${f.id} needs its repository and path (wfe knowledge ref ${f.id}).`)
      if (!f.commit || !COMMIT.test(f.commit)) err('knowledge-finding-commit', `knowledge finding ${f.id} has commit "${f.commit ?? ''}"; a selection names the revision it was read at.`)
      if (!f.sha256 || !SHA256.test(f.sha256)) err('knowledge-finding-sha256', `knowledge finding ${f.id} has sha256 "${f.sha256 ?? ''}"; expected the document's 64 hex digits.`)
    }
  })
  return out
}

// What a selection means, for digests and for telling a change from a restyle:
// order and the display snapshot mean nothing. `normalize` is the digest's text form.
export function knowledgeSemantic(list: KnowledgeAttachment[] | undefined, normalize: (s: string) => string = s => s) {
  const by = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return (list ?? []).map(a => ({
    category: a.category ?? '', note: normalize(a.note ?? ''),
    findings: (a.findings ?? []).map(f => ({ id: f.id, repository: f.repository, commit: f.commit, path: f.path, sha256: f.sha256 })).sort((x, y) => by(x.id, y.id)),
  })).sort((a, b) => by(a.category, b.category) || by(a.findings[0]?.id ?? '', b.findings[0]?.id ?? ''))
}
export const selectedFindings = (list: KnowledgeAttachment[] | undefined): KnowledgeRef[] => (list ?? []).flatMap(a => a.findings ?? [])

// A short name for a strip: the part of a title before its first qualifier.
export function shortTitle(title: string, max = 22): string {
  const t = (title.split(/\s+(?:-|–|—)\s+|\s*\(|:\s/)[0] || title).trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

// The sections of a free-form body that say where a finding stops. Bodies have
// no required sections, so this finds what is there and promises nothing.
export function limitSections(body: string): { heading: string; text: string }[] {
  const out: { heading: string; text: string }[] = []
  let cur: { heading: string; text: string } | null = null
  for (const line of body.split('\n')) {
    const m = /^#{2,4}\s+(.*)$/.exec(line)
    if (m) { cur = /limit|not established|condition|contrary|uncertain|whose judgement|why the comparison|rejected|worse/i.test(m[1]) ? { heading: m[1].trim(), text: '' } : null; if (cur) out.push(cur) } else if (cur) cur.text += `${line}\n`
  }
  return out.map(s => ({ heading: s.heading, text: s.text.trim() })).filter(s => s.text)
}

// Edits of a node's list, for the picker and the panels. Removing a finding keeps
// its category: the intent stands without a selection, and only an explicit
// removal of the category drops it.
const clean = (list: KnowledgeAttachment[]) => list.filter(a => a.category || a.findings?.length || a.note).map(a => { const { findings, ...rest } = a; return findings?.length ? a : rest })
export function withCategory(list: KnowledgeAttachment[], category: string): KnowledgeAttachment[] {
  return list.some(a => a.category === category) ? list : [...list, { category }]
}
export function withoutCategory(list: KnowledgeAttachment[], category: string | undefined): KnowledgeAttachment[] {
  return list.filter(a => (a.category ?? '') !== (category ?? ''))
}
export function withoutFinding(list: KnowledgeAttachment[], id: string): KnowledgeAttachment[] {
  return clean(list.map(a => ({ ...a, ...(a.findings ? { findings: a.findings.filter(f => f.id !== id) } : {}) })))
}
// Selecting a finding that is already selected moves it: it is stored once.
export function withFinding(list: KnowledgeAttachment[], category: string | undefined, ref: KnowledgeRef): KnowledgeAttachment[] {
  const rest = withoutFinding(list, ref.id)
  const at = rest.findIndex(a => (a.category ?? '') === (category ?? ''))
  if (at < 0) return [...rest, { ...(category ? { category } : {}), findings: [ref] }]
  return rest.map((a, i) => (i === at ? { ...a, findings: [...(a.findings ?? []), ref] } : a))
}
// Taking a newer revision, in place. An explicit edit: nothing does this by itself.
export function replacingFinding(list: KnowledgeAttachment[], ref: KnowledgeRef): KnowledgeAttachment[] {
  return list.map(a => ({ ...a, ...(a.findings ? { findings: a.findings.map(f => (f.id === ref.id ? ref : f)) } : {}) }))
}
