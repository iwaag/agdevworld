// `wfe knowledge` (improve_workflow p2, docs/knowledge.md): discover and read
// reusable findings by qualified id, at a stated revision. The same module the
// service's GET /api/knowledge routes use (server/knowledge.ts).
import type { AccessContext } from '../server/access.ts'
import type { CollectionRead, KnowledgeOptions } from '../server/knowledge.ts'

export const KNOWLEDGE_HELP = `wfe knowledge collections [--project <p>]
wfe knowledge list [<collection>] [--project <p>] [--category <c>]… [--tag <t>]… [--text <words>]
wfe knowledge show <collection>#<id> [--as <project> | --rev <commit> | --upstream] [--source worktree [--workspace <id>]]
wfe knowledge check <collection> [--as <project> | --rev <commit> | --upstream]
wfe knowledge cite <collection>#<id> [--decision adopted|adapted|rejected] [--as … | --rev …]
wfe knowledge decisions <project> <workflow>/<run>

Findings are what a project learned, kept in its own study/wedo area as one
Markdown document each with a small header (docs/knowledge.md). A finding
describes a technique or lesson, the conditions it was seen under, its evidence
and its limits. Reading one does not bind you to it: use it, adapt it, reject
it, or find nothing that applies. Consulting them is never required.

A finding is named <collection>#<id>. A collection is <project>:<path> for a
project's local area (gimmickimg:wedo) or repo:<owner>/<name> for a shared
repository (repo:developer/wedo-argue; ponderer:wedo/wedo-argue says the same).
The id stays when its title or file changes.

collections  every declared study/wedo area and repository: what its
             knowledge.yaml says, how many findings it holds, at which
             revision. "no findings" (read, nothing structured there) and
             "unavailable" (could not be read, with why) are different. Topic
             files with no header are not findings, and are still knowledge:
             wfe projects tree|read|search read them.
list         the findings: title, summary, categories, tags, qualified id,
             revision. Filters combine (all must hold).
show         one finding: the document, its references each resolved, examples
             to look at. resolved means the thing exists at that revision, not
             that the claim is true; unchecked (external, shared area, free
             text) and missing are said as such.
check        readable headers, unique ids, resolvable references, against one
             revision. Exit 1 on errors; a duplicate id is one. It cannot tell
             whether a finding is right.
cite         the block to put in your report: the commit, path and sha256 you
             actually read, for your decision, reason, work and verification.
decisions    what a run recorded, each entry read back at its recorded
             revision, with whether the document has changed since. These are
             the agent's statements; compare them with the work.

Which revision: a local area is read at its project's default branch. A shared
repository is read at a project's pin, because that is what the project adopted:
--as <project>, else the project of the workspace you are in, else its
maintainer's, else its only user's; with several users and no maintainer it is
the upstream tip, and the result says so. --upstream asks for the tip, --rev for
one commit of that repository (of the project root for a local area), for
reading a recorded reference back. No workspace is touched or switched.
--source worktree reads a working tree: unpublished bytes, marked so.
--refresh fetches now. --json for the full result. Every result names the
repository, commit and why that commit was chosen.

HTTP: GET api/knowledge[?collection=&project=&category=&tag=&text=&as=&rev=],
api/knowledge/collections, api/knowledge/finding?id=&as=&rev=&upstream=1,
api/knowledge/check?collection=, api/knowledge/decisions?project=&run=.`

export interface KnowledgeCli {
  positional: string[]
  opt: (k: string) => string | undefined
  opts: (k: string) => string[]
  flag: (k: string) => boolean
  ctx: () => Promise<AccessContext>
  currentProject: () => Promise<string | undefined>
  out: (human: string, data: unknown) => void
  usage: (m: string) => Error
}

const short = (h?: string) => (h ? h.slice(0, 10) : '—')
const stale = (c: Pick<CollectionRead, 'revision'>) => c.revision?.fetch?.state === 'stale' ? ` STALE: cache from ${c.revision.fetch.at}: ${c.revision.fetch.error}` : ''
const revisionLine = (r: NonNullable<CollectionRead['revision']>) => `${r.repository}@${short(r.commit)} (${r.resolvedBy})${r.unpublished ? ' UNPUBLISHED: uncommitted changes in the working tree' : ''}`

export async function knowledgeCommand(c: KnowledgeCli): Promise<number> {
  const x = await import('../server/knowledge.ts')
  const [sub, a1, a2] = c.positional
  const ctx = await c.ctx()
  const source = c.opt('source')
  if (source !== undefined && source !== 'committed' && source !== 'worktree') throw c.usage('--source is committed or worktree')
  const o: KnowledgeOptions = { rev: c.opt('rev'), as: c.opt('as'), upstream: c.flag('upstream'), source: source as KnowledgeOptions['source'], workspace: c.opt('workspace'), current: await c.currentProject() }
  const state = (r: Omit<CollectionRead, 'findings'>, n: number) => r.state !== 'read' ? `UNAVAILABLE (${r.state}): ${r.problem}` : `${n ? `${n} finding${n === 1 ? '' : 's'}` : 'no findings'}${r.unstructured.length ? `, ${r.unstructured.length} document(s) without a header` : ''}${r.problems.length ? `, ${r.problems.length} PROBLEM(S): wfe knowledge check ${r.id}` : ''} — ${revisionLine(r.revision!)}${stale(r)}`
  switch (sub) {
    case 'collections': {
      const l = await x.listFindings(ctx, { ...o, project: c.opt('project') })
      c.out(l.collections.map(r => `${r.id}  ${r.kind}, ${r.form}${r.declaration?.maintainer ? `, maintained by ${r.declaration.maintainer}${r.declaration.supplementer ? ` + ${r.declaration.supplementer}` : ''}` : ', no declaration'}\n  ${state(r, l.counts[r.id])}`).join('\n') || 'No collections.', l)
      return 0
    }
    case 'list': {
      const l = await x.listFindings(ctx, { ...o, collection: a1, project: c.opt('project'), category: c.opts('category'), tag: c.opts('tag'), text: c.opt('text') })
      const lines = l.findings.map(f => `${f.qid}\n  ${f.title}\n  ${f.summary}\n  ${f.categories.join(', ')}${f.tags.length ? ` · ${f.tags.join(', ')}` : ''}${f.status ? ` · ${f.status}` : ''}${f.kind === 'study' ? ' · study (imported; not locally verified)' : ''}\n  ${f.repository}@${short(f.commit)} ${f.path}${f.unpublished ? ' UNPUBLISHED' : ''}`)
      const gone = l.collections.filter(r => r.state !== 'read').map(r => `Not read: ${r.id}: ${r.state}: ${r.problem}`)
      const trouble = l.collections.filter(r => r.problems.length).map(r => `Problems in ${r.id}: ${r.problems.map(p => `${p.path}: ${p.message}`).join('; ')}`)
      c.out([lines.join('\n\n') || 'No findings match.', ...(gone.length || trouble.length ? ['', ...gone, ...trouble] : [])].join('\n'), l)
      return 0
    }
    case 'show': {
      if (!a1) throw c.usage('show needs <collection>#<id>')
      const d = await x.showFinding(ctx, a1, o)
      const f = d.finding
      const refs = f.references.map(r => `  [${r.state}] ${r.role}${r.by ? ` (by ${r.by})` : ''}: ${r.ref}${r.note ? ` — ${r.note}` : ''}${r.reason ? `\n      ${r.reason}` : ''}`)
      const examples = f.references.filter(r => r.role === 'illustration')
      c.out([
        `${f.qid}${f.kind === 'study' ? ' (study: imported; not locally verified)' : ''}`,
        `${revisionLine(d.revision)}${stale(d)}`,
        `${f.path}  sha256 ${f.sha256}`,
        d.declaration?.maintainer ? `maintained by ${d.declaration.maintainer} (${d.declaration.maintenance ?? '?'})` : 'no maintenance declaration',
        '', `# ${f.title}`, f.summary, '', `categories: ${f.categories.join(', ')}`, `tags: ${f.tags.join(', ') || '—'}`, ...(f.status ? [`status: ${f.status}`] : []),
        '', 'References (resolved = it exists at this revision, not that the claim is true):', ...refs,
        ...(examples.length ? ['', 'To look at (illustrations, not evidence):', ...examples.map(r => `  ${r.ref}${r.view ? `\n      /wfe/${r.view}` : ` (${r.state})`}`)] : []),
        '', '---', f.body.trimEnd(),
      ].join('\n'), d)
      return 0
    }
    case 'check': {
      if (!a1) throw c.usage('check needs <collection>')
      const r = await x.checkCollection(ctx, a1, o)
      const errors = r.items.filter(i => i.severity === 'error').length
      c.out([`${r.collection}: ${r.state === 'read' ? `${r.findings} finding(s), ${r.unstructured} without a header; references ${r.references.resolved} resolved, ${r.references.missing} missing, ${r.references.unchecked} unchecked` : r.state}${r.revision ? ` — ${revisionLine(r.revision)}` : ''}`,
        ...r.items.map(i => `  ${i.severity}${i.path ? ` ${i.path}` : ''} [${i.code}]: ${i.message}`), errors ? `${errors} error(s).` : 'No errors. This says nothing about whether the findings are right.'].join('\n'), r)
      return errors ? 1 : 0
    }
    case 'cite': {
      if (!a1) throw c.usage('cite needs <collection>#<id>')
      const r = await x.citation(ctx, a1, o, c.opt('decision'))
      c.out(r.block, r)
      return 0
    }
    case 'decisions': {
      if (!a1 || !a2) throw c.usage('decisions needs <project> <workflow>/<run>')
      const r = await x.runDecisions(ctx, a1, a2)
      const lines = r.decisions.map(d => {
        const cur = d.current && 'changed' in d.current ? (d.current.changed ? `changed since: current ${short(d.current.commit)} ${d.current.path}` : `unchanged at ${short(d.current.commit)}`) : d.current ? `current: ${d.current.problem}` : ''
        const items = (name: string, v: DecisionItems) => v.length ? [`  ${name}: ${v.map(i => `${i.ref} [${i.state}]`).join(', ')}`] : [`  ${name}: none recorded`]
        return [`${d.decision.toUpperCase() || '?'} ${d.finding || '(no finding)'} [${d.state}]`, ...(d.recorded?.commit ? [`  read at ${d.recorded.repository ?? '?'}@${short(d.recorded.commit)} ${d.recorded.path ?? ''}`] : []), ...(d.atRevision ? [`  title then: ${d.atRevision.title}`] : []), ...(d.detail ? [`  ${d.detail}`] : []), ...(cur ? [`  ${cur}`] : []), ...(d.reason ? [`  reason: ${d.reason}`] : []), ...items('work', d.work), ...items('verification', d.verification)].join('\n')
      })
      c.out([`${r.run}: ${r.decisions.length ? `${r.decisions.length} decision(s) in ${r.files.join(', ')}. These are the agent's statements: compare them with the work.` : 'no knowledge decisions recorded (none is required).'}`, ...lines, ...r.problems.map(p => `PROBLEM: ${p}`)].join('\n'), r)
      return r.problems.length ? 1 : 0
    }
    default: throw c.usage('wfe knowledge collections | list | show | check | cite | decisions (see: wfe help knowledge)')
  }
}
type DecisionItems = { ref: string; state: string }[]
