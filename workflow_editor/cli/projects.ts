// `wfe projects` (project_migration p4, docs/access.md): read any managed
// project — list, show, tree, read, search, runs, run — through the same
// module the service's GET /api/projects routes use (server/access.ts).
import { writeFile } from 'node:fs/promises'
import type { AccessContext, Provenance, ReadOptions, ReadResult } from '../server/access.ts'

export const PROJECTS_HELP = `wfe projects list
wfe projects show <project> [--rev <commit|branch>]
wfe projects tree <project> [<path>] [--depth <n>] [--max <n>]
wfe projects read <project> <path> [--max-bytes <n>] [--out <file>]
wfe projects search <project> <pattern> [<path>] [--regex] [--ignore-case] [--max <n>]
wfe projects runs <project> [<workflow>] [--published]
wfe projects run <project> <workflow>/<run> [--published] [--file <path>]

Reads every registered project, whether or not it has a workspace on this
host; needs no project of its own and changes nothing in any workspace.
<project> is a project id, or repo:<owner>/<name> (gitea:<id>) for a
registered repository that no project needs to use.

list    every project (name, intent, devdocs mode, root repository and its
        current commit, submodules it uses, workspaces here) and every shared
        repository with the projects that use it
show    project.yaml, local areas, submodules (the commit the project pins
        and its repository's current tip: same/behind/ahead/diverged),
        workflows (bindings, execution, intake, nodes) and workspaces
tree    the entries under a path (files, folders, submodules)
read    one file: text with its size and sha256; binary content gives its
        metadata only (save it with --out)
search  fixed-string matches (or --regex) as path:line: text, within the one
        repository holding <path>; submodules below it are listed as not
        searched
runs    the project's runs: the live record (this host's run copy or project
        workspace) beside the snapshot published in its committed devdocs
run     one run: both records, its files; --file reads one file of its
        folder (live by default, the published one with --published)

Source (tree, read, search; show and runs take --rev):
  default            the project root's default branch on Gitea, committed
  --rev <ref>        a branch or commit of the root (of the repository, for repo:)
  inside a submodule path, the commit the root pins at that revision;
  --upstream         the first submodule on the path at its default-branch tip
  --require <commit> fail unless the source read contains this commit
  --source worktree  a workspace's working tree, explicitly (--workspace <id>
                     when there are several); never ignored files, never .local/
  --refresh          fetch now even when fetched in the last seconds

Every result names its project, repository (Gitea name, registry key, mount
path), revision (selector, commit, the commit that pins it) and observation
time, and whether the cache was fetched now (fresh, recent) or could not be
refreshed (stale, with its time and the error). Failures are one of
absent, inaccessible, uninitialized, fetch-failed (exit 1; with --json the
state is in detail.state). Bounds: reads 256 KiB (--max-bytes up to 4 MiB),
trees 2000 entries, searches 200 matches; a truncation is always said.
HTTP: GET api/projects, api/projects/<project>[/tree|/file|/search|/runs[/<wf>/<run>[/file]]]
with the same options as query parameters (path, rev, upstream=1, …).`

export interface ProjectsCli {
  positional: string[]
  opt: (k: string) => string | undefined
  flag: (k: string) => boolean
  ctx: () => Promise<AccessContext>
  out: (human: string, data: unknown) => void
  json: () => boolean
  usage: (m: string) => Error
}

const short = (h?: string) => (h ? h.slice(0, 10) : '—')
export function provenanceLine(p: Provenance): string {
  const rev = p.source === 'worktree' ? `working tree of workspace ${p.workspace?.id}${p.workspace?.dirty ? ' (uncommitted changes)' : ''} at ${short(p.revision.commit)}`
    : p.source === 'live' ? `live record in ${p.repository.fullName} of workspace ${p.workspace?.id}`
      : `${p.repository.fullName}@${short(p.revision.commit)} (${p.revision.selector}${p.revision.ref ? ` ${p.revision.ref}` : ''}${p.revision.pinnedBy ? `, pinned by ${p.revision.pinnedBy.repository}@${short(p.revision.pinnedBy.commit)}` : ''})`
  const fetch = p.fetch ? (p.fetch.state === 'stale' ? `; STALE: cache from ${p.fetch.at}, refresh failed: ${p.fetch.error}` : `; fetched ${p.fetch.at}`) : ''
  return `${p.project}: ${p.path} — ${rev}${p.repository.key ? ` [${p.repository.key}]` : ''}${fetch}`
}

export async function projectsCommand(c: ProjectsCli): Promise<number> {
  const x = await import('../server/access.ts')
  const [sub, target, a1, a2] = c.positional
  const num = (k: string) => { const v = c.opt(k); if (v === undefined) return undefined; const n = Number(v); if (!Number.isInteger(n) || n < 1) throw c.usage(`--${k} must be a positive integer`); return n }
  const source = c.opt('source')
  if (source !== undefined && source !== 'committed' && source !== 'worktree') throw c.usage('--source is committed or worktree')
  const ro: ReadOptions = { rev: c.opt('rev'), upstream: c.flag('upstream'), require: c.opt('require'), source: source as ReadOptions['source'], workspace: c.opt('workspace') }
  const ctx = await c.ctx()
  const need = (v: string | undefined, what: string) => { if (!v) throw c.usage(`${sub} needs ${what}`); return v }
  const saved = async (r: ReadResult) => {
    const file = c.opt('out')
    if (file && r.bytes) await writeFile(file, r.bytes)
    const body = r.binary ? `(binary, ${r.size} bytes${file ? `; saved to ${file}` : '; save it with --out <file>'})` : `${r.text}${r.truncated ? `\n… (truncated at ${Buffer.byteLength(r.text ?? '')} of ${r.size} bytes; --max-bytes, or --out <file> for all of it)` : ''}`
    c.out(`${provenanceLine(r.provenance)}\n${r.size} bytes, sha256 ${r.sha256}\n\n${body}`, { ...x.serializable(r), ...(file ? { savedTo: file } : {}) })
    return 0
  }
  switch (sub) {
    case 'list': {
      const l = await x.list(ctx)
      const lines = [`Observed ${l.observed}${l.gitea.available ? '' : ` — Gitea not available: ${l.gitea.problem}`}`, '', 'Projects:']
      for (const p of l.projects) {
        lines.push(`  ${p.id.padEnd(16)} ${p.name ?? '?'}  ${p.root.fullName}@${short(p.commit)}${p.branch ? ` (${p.branch})` : ''}  devdocs ${p.devdocs ?? '?'}${p.fetch?.state === 'stale' ? '  [STALE]' : ''}${p.state ? `  [${p.state}: ${p.problem}]` : p.problem ? `  [${p.problem}]` : ''}`)
        if (p.intent) lines.push(`  ${' '.repeat(16)} ${p.intent.trim().split('\n')[0].slice(0, 110)}`)
        if (p.uses.length) lines.push(`  ${' '.repeat(16)} submodules: ${p.uses.map(u => `${u.path}${u.repository ? ` = ${u.repository}` : ' (outside Gitea)'}`).join(', ')}`)
        lines.push(`  ${' '.repeat(16)} ${p.workspaces.length ? p.workspaces.map(w => `workspace ${w.id}: ${w.available ? `${w.branch ?? 'detached'} @ ${short(w.head)}${w.atCommitted === false ? ' (not at the committed tip)' : ''}` : `unavailable (${w.reason})`}`).join('; ') : 'no workspace on this host'}`)
      }
      lines.push('', 'Shared repositories:')
      for (const r of l.repositories) lines.push(`  ${r.fullName.padEnd(36)} ${r.category.padEnd(8)} ${r.key}  used by: ${r.usedBy.length ? r.usedBy.map(u => `${u.project} (${u.path})`).join(', ') : 'none'}`)
      c.out(lines.join('\n'), l)
      return 0
    }
    case 'show': {
      const v = await x.show(ctx, need(target, 'a project'), ro)
      const lines = [provenanceLine(v.provenance)]
      if (v.project) lines.push(`${v.project.name} (${v.project.id}), devdocs ${v.project.devdocs} (observed ${v.devdocs.observed})`, ...v.project.intent.trim().split('\n').map(l => `  ${l}`))
      if (v.problem) lines.push(`project.yaml: ${v.problem}`)
      lines.push('', 'Local areas:', ...(v.areas.length ? v.areas.map(a => `  ${a.path.padEnd(24)} ${a.category.padEnd(6)} ${a.present ? '' : '(absent at this revision) '}${a.description}`) : ['  (none)']))
      lines.push('', 'Submodules:', ...(v.submodules.length ? v.submodules.map(s => `  ${s.path.padEnd(24)} ${s.category.padEnd(6)} ${s.repository?.fullName ?? s.url}${s.repository?.key ? ` [${s.repository.key}]` : ''}  pinned ${short(s.pinned)}${s.upstream ? `, ${s.upstream.branch} ${short(s.upstream.commit)} (${s.upstream.relation}${s.upstream.behind ? `, ${s.upstream.behind} behind` : ''}${s.upstream.ahead ? `, ${s.upstream.ahead} ahead` : ''})` : ''}${s.state ? `  [${s.state}: ${s.problem}]` : ''}`) : ['  (none)']))
      lines.push('', 'Workflows:', ...(v.workflows.length ? v.workflows.map(w => w.problem ? `  ${w.file}: ${w.problem}` : `  ${(w.id ?? '').padEnd(20)} ${w.name ?? ''}  [${Object.entries(w.repositories ?? {}).map(([k, b]) => `${k}=${b.path}:${b.access}${b.integrate ? `:${b.integrate}` : ''}`).join(' ')}]${w.intake ? ' intake' : ''}${w.execution?.agent ? ` agent ${w.execution.agent}` : ''}`) : [`  ${v.workflowsProblem ?? '(none)'}`]))
      lines.push('', 'Workspaces:', ...(v.workspaces.length ? v.workspaces.map(w => `  ${w.id}: ${w.available ? `${w.branch ?? 'detached'} @ ${short(w.head)}${w.atCommitted === false ? ' (not at the committed tip)' : ''}` : `unavailable (${w.reason})`}`) : ['  (none on this host)']))
      c.out(lines.join('\n'), v)
      return 0
    }
    case 'tree': {
      const t = await x.tree(ctx, need(target, 'a project'), a1 ?? '.', { ...ro, depth: num('depth'), max: num('max') })
      c.out([provenanceLine(t.provenance), ...t.entries.map(e => `  ${e.type.padEnd(9)} ${e.size !== undefined ? String(e.size).padStart(9) : ' '.repeat(9)}  ${e.path}${e.type === 'submodule' && e.object ? ` @ ${short(e.object)}` : ''}`), ...(t.truncated ? [`  … ${t.total - t.entries.length} more (--max)`] : [])].join('\n'), t)
      return 0
    }
    case 'read': return saved(await x.read(ctx, need(target, 'a project'), need(a1, 'a path'), { ...ro, maxBytes: num('max-bytes') }))
    case 'search': {
      const s = await x.search(ctx, need(target, 'a project'), need(a1, 'a pattern'), a2 ?? '.', { ...ro, max: num('max'), regex: c.flag('regex'), ignoreCase: c.flag('ignore-case') })
      c.out([provenanceLine(s.provenance), ...s.matches.map(m => `  ${m.path}:${m.line}: ${m.text}`), `${s.total} match${s.total === 1 ? '' : 'es'}${s.truncated ? ` (first ${s.matches.length} shown; --max)` : ''}`, ...(s.notSearched.length ? [`not searched (submodules; search them by their path): ${s.notSearched.join(', ')}`] : [])].join('\n'), s)
      return 0
    }
    case 'runs': {
      const r = await x.runs(ctx, need(target, 'a project'), { ...ro, workflow: a1, published: c.flag('published') })
      const lines = [provenanceLine(r.provenance), `Live records: ${'workspace' in r.live ? `workspace ${r.live.workspace}` : `not read (${r.live.unavailable})`}`]
      for (const run of r.runs) {
        const l = run.live, p = run.published
        lines.push(`  ${run.ref.padEnd(30)} live: ${l ? `${l.execution ?? l.problem?.code ?? '?'}${l.decision ? `, ${l.decision}` : ''} (${l.place})` : '—'}  published: ${p ? `${p.execution ?? p.problem?.code ?? '?'}${p.decision ? `, ${p.decision}` : ''}` : '—'}`)
      }
      c.out(lines.join('\n'), r)
      return 0
    }
    case 'run': {
      const ref = need(a1, '<workflow>/<run>')
      const file = c.opt('file')
      if (file) return saved(await x.runFile(ctx, need(target, 'a project'), ref, file, { ...ro, published: c.flag('published'), maxBytes: num('max-bytes') }))
      const v = await x.run(ctx, need(target, 'a project'), ref, { ...ro, published: c.flag('published') })
      const rec = (r: unknown) => r as { execution?: { state?: string }; decisions?: { decision: string; by: string; at: string }[]; integrations?: { at: string; repositories: { path: string; result: string }[] }[]; storage?: { branch?: string } } | undefined
      const lines = [`Run ${v.ref} of ${target}`]
      if (v.live) {
        const r = rec(v.live.record)
        lines.push(`Live (${v.live.place}${v.live.branch ? `, branch ${v.live.branch}` : ''}, workspace ${v.live.workspace}, read ${v.live.observed}): ${r?.execution?.state ?? 'unreadable'}${r?.decisions?.length ? `; decision ${r.decisions.at(-1)!.decision} by ${r.decisions.at(-1)!.by}` : ''}${r?.integrations?.length ? `; integrated ${r.integrations.at(-1)!.at} (${r.integrations.at(-1)!.repositories.map(i => `${i.path} ${short(i.result)}`).join(', ')})` : ''}`)
        lines.push(`  files: ${v.live.files.join(', ')}`)
      } else lines.push(`Live: ${v.liveUnavailable}`)
      if (v.published) {
        const r = rec(v.published.record)
        lines.push(`Published: ${provenanceLine(v.published.provenance)}`, `  ${r?.execution?.state ?? 'unreadable'}${r?.decisions?.length ? `; decision ${r.decisions.at(-1)!.decision}` : ''} (a snapshot; the live record, when there is one, is the run's state)`, `  files: ${v.published.files.join(', ')}`)
      } else lines.push(`Published: ${v.publishedUnavailable}`)
      c.out(lines.join('\n'), v)
      return 0
    }
    default: throw c.usage('wfe projects list | show | tree | read | search | runs | run (see: wfe help projects)')
  }
}
