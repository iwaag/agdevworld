// `wfe context` (workflow_editor p13, p14; docs/context.md): the scoped
// context of a project, a workflow or a run, and the local context blocks of
// each scope. The same resolver and store as the browser and the executor's
// claim; with --service (or WFE_SERVICE) every block command goes through
// that WFE service, so a writer on another host reaches the area's store.
import { readFile, writeFile } from 'node:fs/promises'
import { blockFile, scopeWords, sourceLines, type BlockRevision, type BlockState, type ScopeTarget } from '../shared/context.ts'
import type { AccessContext } from '../server/access.ts'
import { ContextStore, applyBlockOp, scopeTarget, type BlockOpInput } from '../server/contextStore.ts'
import type { ExecStore } from '../server/exec.ts'
import type { Workspace } from '../server/workspace.ts'

export const CONTEXT_HELP = `wfe context show [--workflow <id>] [--for authoring|execution] [--rendered]
wfe context list [<scope>] [--project <id>] [--workflow <id>] [--all]
wfe context get <scope> <block> [--project <id>] [--workflow <id>]
wfe context set <scope> <block> --base <revision>|new --by <name> [--project <id>] [--workflow <id>]
    [--file <path>|- | --text <text>] [--title <text>] [--kind instruction|information] [--manager <name>]
    [--evidence <file.json>|-|<json>] [--consult <project>/<workflow>|none] [--detail <name>=<file>]... [--drop-detail <name>]...
    [--run <project>/<workflow>/<run>] [--note <text>]
wfe context check <scope> <block> --base <revision> --by <name> [--note <text>]
wfe context refresh-failed <scope> <block> --detail <text> [--partial] --by <name>
wfe context remove <scope> <block> --base <revision> --by <name> [--note <text>]
wfe context history <scope> <block>
wfe context detail <context:…> [--out <file>]
wfe context run <run> [--rendered]

The context WFE gives an agent besides a run's records, by scope:

  scope     default (in the project's repositories)          local (this WFE area, not in Git)
  system    the common execution contract (the execution     blocks for all projects
            host's, at claim); for authoring the authoring
            area's AGENTS.md and docs/contract.md
  project   project.yaml intent and goals; project.yaml      blocks of the project
            guides
  workflow  the workflow's intent; its execution.guides      blocks of the workflow
  run       (none: a run's input is its request and record, answers and instructions — wfe run)

<scope> is system, project or workflow. --project names the project (reads
default to the current workspace's; writes need it explicitly), --workflow the
workflow by id.

Local context is a set of blocks per scope, each managed on its own:

  id        stable within its scope (lower-case letters, digits, . _ -)
  title     one line
  kind      instruction (guidance to follow) or information (facts and advice
            about the environment: delivered as such, not as instructions)
  manager   who maintains it (default: its first writer); the last editor is
            whoever changed it last. Neither is a permission: anyone may edit
            any block, and both are shown.
  body      the text (at most 64 KiB; keep system blocks to a few lines —
            they reach every run of every project)
  evidence  a JSON list of {ref, basis, status, observed?, coverage?, title?}:
            basis observed|reported|desired|recommendation, status
            ok|partial|failed|unknown, observed = when the SOURCE was observed
            (ISO; never the time you publish), coverage = what it covers
  consult   <project>/<workflow> where to ask the manager (e.g. cagent/consult)
  details   named documents read on demand, never put in a prompt: each is
            context:<scope>/<block>/<name> (wfe context detail)

Files you hand to set (--file, --evidence, --detail) are read once; keep them
outside a run copy (e.g. under $TMPDIR) when they hold local facts: a run
copy is committed and published, the store is not. --evidence also takes the
JSON list itself, or - for standard input.

get       a block, its revision (pass "base" as --base), manager, last editor,
          evidence, size and delivered section
set       create (--base new, with --title, --kind and a body) or change a
          block. Fields you omit keep their value. --base is the content
          revision you read: if someone changed the block since, the write is
          refused (context-conflict) with what is there now; read it again and
          reapply. Publishing exactly what is there is no revision.
          Evidence given with set replaces the evidence and clears a recorded
          failed refresh.
check     you verified the current content again and it still holds: recorded
          (who, when, from which run), not delivered — it changes no prompt
          and no session
refresh-failed
          a refresh did not succeed (--partial: covered only part). The
          content stays as it was, never emptied; the failure is delivered
          with it until a publication with evidence
remove    remove a block's contribution (its history stays)
history   every revision: operation, who, when, from which run, the block
detail    print a detail (or --out <file>)
show      the resolved sources for an authoring session (--for execution: a
          new run of the workflow); --rendered prints the exact text
run       what each attempt of a run was prepared with (its snapshot), was it
          delivered, the next attempt with the current settings, what differs

Where writes go: this area's store (the launcher's WFE_AREA), or with
--service <url> / WFE_SERVICE the WFE service at <url> (e.g. the area's
published editor address). Every result names where it was written. An
executing attempt (WFE_ATTEMPT) records its run as the writer's provenance.

What is delivered: each block's section names its kind, manager, last editor
and day, evidence with observation times, a failed refresh, details and the
consultation workflow, then the body. A check, a revision number and the time
of day are not delivered. A saved block reaches the next attempt of every
affected run, never one in progress (steer current work with wfe run
instruct); saving starts or resumes nothing. A changed section starts a new
session on the next attempt of a run whose policy is run. Blocks and snapshots
stay in the area's .local/: run records name only a snapshot id, a fingerprint
and hashes.`

interface Io {
  positional: string[]
  opt: (k: string) => string | undefined
  opts: (k: string) => string[]
  flag: (k: string) => boolean
  out: (human: string, data: unknown) => void
  usage: (m: string) => Error
  refused: (m: string, detail?: unknown) => Error
  area: () => string
  access: () => Promise<AccessContext>
  workspace: () => Promise<Workspace>
  exec: () => Promise<ExecStore>
  resolveRun: (ws: Workspace, text: string) => Promise<{ workflow: string; run: string }>
}

const age = (iso: string) => { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d` }
const stateLine = (s: BlockState) => `${scopeWords(s.target)} · ${s.id}: ${s.problem ? `problem — ${s.problem}` : !s.block ? `removed (revision ${s.revision})` : `${s.block.kind}, "${s.block.title}", managed by ${s.block.manager}, last edited by ${s.block.editor.by} ${s.block.editor.at}${s.block.editor.run ? ` (${s.block.editor.run})` : ''}; revision ${s.revision}, base ${s.base}; ${s.size!.lines} lines, ${s.size!.bytes} bytes${s.external ? '; edited outside WFE' : ''}${s.block.refresh ? `; refresh ${s.block.refresh.outcome} ${age(s.block.refresh.at)} ago` : ''}${s.block.checked ? `; checked ${age(s.block.checked.at)} ago by ${s.block.checked.by}` : ''}`}`

// The service a block command goes through, when one is named.
async function remote(url: string, method: 'GET' | 'PUT', path: string, body?: unknown): Promise<unknown> {
  const base = url.endsWith('/') ? url : `${url}/`
  const r = await fetch(new URL(path, base), { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) })
  const text = await r.text()
  let data: unknown
  try { data = JSON.parse(text) } catch { data = text }
  if (!r.ok) {
    const d = data as { error?: string; message?: string; detail?: unknown }
    const e = new Error(`${base}: ${r.status} ${d?.error ?? d?.message ?? text.slice(0, 300)}`) as Error & { status: number; detail?: unknown }
    e.status = r.status
    e.detail = d?.detail ?? data
    throw e
  }
  return data
}
const qs = (o: Record<string, string | undefined>) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&')

export async function contextCommand(io: Io): Promise<number> {
  const [sub, arg, blockArg] = io.positional
  const service = io.opt('service') ?? process.env.WFE_SERVICE ?? undefined
  const local = () => new ContextStore(io.area())
  const where = () => service ? `the WFE service at ${service}` : `this area's store (${io.area()})`
  const projectOf = async (write: boolean) => {
    const p = io.opt('project')
    if (p) return p
    if (write) throw io.usage('--project <id> is required for a write to a project or workflow scope: name the project whose context you change')
    if (service) throw io.usage('--project <id> is required with --service')
    const ws = await io.workspace()
    return (await ws.readProject().catch(() => ({ project: undefined }))).project?.id || ws.reg.project || ws.reg.id
  }
  const target = async (scope: string | undefined, write: boolean): Promise<ScopeTarget> => {
    if (!scope) throw io.usage(`${sub} <system|project|workflow> …`)
    if (scope === 'system') return scopeTarget('system')
    return scopeTarget(scope, await projectOf(write), scope === 'workflow' ? io.opt('workflow') : undefined)
  }
  const tq = (t: ScopeTarget) => ({ scope: t.scope, project: t.project, workflow: t.workflow })
  const needBlock = () => { if (!blockArg) throw io.usage(`${sub} <scope> <block>`); return blockArg }
  const getState = async (t: ScopeTarget, id: string): Promise<{ state: BlockState; revisions: BlockRevision[] }> => service
    ? await remote(service, 'GET', `api/context/block?${qs({ ...tq(t), block: id })}`) as { state: BlockState; revisions: BlockRevision[] }
    : { state: await local().read(t, id), revisions: await local().history(t, id) }
  const write = async (input: BlockOpInput) => {
    try {
      if (service) return await remote(service, 'PUT', 'api/context/block', { ...input, via: 'cli' }) as { state: BlockState; changed: boolean; written: string }
      let runOf: ((attempt: string) => string | null) | undefined
      if (input.attempt) { try { const x = await io.exec(); runOf = id => x.attemptRun(id) } catch { /* no execution store here: the run is not named */ } }
      return await applyBlockOp(local(), { ...input, via: 'cli' }, runOf)
    } catch (e) {
      throw io.refused((e as Error).message, (e as { detail?: unknown }).detail)
    }
  }
  const by = () => { const b = io.opt('by'); if (!b?.trim()) throw io.usage('--by <name> is required: who writes'); return b }
  const base = () => {
    const b = io.opt('base')
    if (b === undefined) throw io.usage('--base <revision> is required: the content revision you read (wfe context get shows "base"), or --base new for a new block')
    if (b === 'new' || b === 'none') return 0
    if (!/^\d+$/.test(b)) throw io.usage('--base is a revision number (or new)')
    return Number(b)
  }
  const common = () => ({ by: by(), ...(io.opt('run') ? { run: io.opt('run') } : {}), ...(process.env.WFE_ATTEMPT ? { attempt: process.env.WFE_ATTEMPT } : {}), ...(io.opt('note') ? { note: io.opt('note') } : {}) })
  const report = (verb: string, r: { state: BlockState; changed: boolean; written: string }) => io.out(r.changed
    ? `${verb} ${stateLine(r.state)}.\nWritten to ${r.written}${service ? ` (through ${service})` : ''}. It applies to the next attempt of affected runs and to authoring sessions that read it; nothing was started or resumed.`
    : `Unchanged (no revision): ${stateLine(r.state)}. Store: ${r.written}${service ? ` (through ${service})` : ''}.`, { ok: true, ...r })

  switch (sub) {
    case 'show': {
      if (service) throw io.usage('show reads this area; run it where the area is (the editor\'s Context sections show the same)')
      const { contextMatrix } = await import('../server/contextView.ts')
      const ws = await io.workspace()
      const m = await contextMatrix(await io.access(), ws, io.opt('workflow'))
      const purpose = io.opt('for') ?? 'authoring'
      if (purpose !== 'authoring' && purpose !== 'execution') throw io.usage('--for is authoring or execution')
      const b = purpose === 'execution' ? m.execution : m.authoring
      if (!b) throw io.usage('--for execution needs --workflow <id>')
      const text = purpose === 'execution' ? m.rendered.execution! : m.rendered.authoring
      if (io.flag('rendered')) { io.out(text, { ...b, rendered: text }); return 0 }
      io.out([`Context for ${purpose} of ${b.project}${b.workflow ? `/${b.workflow}` : ''} (fingerprint ${b.fingerprint.slice(7, 19)}):`, ...sourceLines(b).map(l => `  ${l}`),
        '', purpose === 'authoring' ? 'This is guidance for the session, available on request (wfe context show --rendered); WFE does not inject it into an IDE session. Local context stays on this area: do not copy it into tracked files.' : 'The execution contract is the host\'s at claim. wfe context show --for execution --rendered prints the section a run is given.'].join('\n'), { ...b, rendered: text })
      return 0
    }
    case 'list': {
      let all: BlockState[]
      if (io.flag('all') || !arg) all = service ? (await remote(service, 'GET', 'api/context/blocks?all=1') as { blocks: BlockState[] }).blocks : await local().all()
      else { const t = await target(arg, false); all = service ? (await remote(service, 'GET', `api/context/blocks?${qs(tq(t))}`) as { blocks: BlockState[] }).blocks : await local().blocks(t) }
      io.out(all.length ? all.map(stateLine).join('\n') : `No block in ${where()}.`, { ok: true, blocks: all })
      return 0
    }
    case 'get': {
      const t = await target(arg, false)
      const { state: s } = await getState(t, needBlock())
      const b = s.block
      io.out([stateLine(s), ...(b ? [
        ...(b.evidence.length ? ['Evidence:', ...b.evidence.map(e => `  ${e.basis} ${e.observed ? `${e.observed} (${age(e.observed)} ago)` : '(observation time not known)'} ${e.status}${e.coverage ? ` — ${e.coverage}` : ''}: ${e.title ? `${e.title} — ` : ''}${e.ref}`)] : []),
        ...(b.details.length ? [`Details: ${b.details.map(d => `${d.name} (${d.bytes} bytes)`).join(', ')}`] : []),
        ...(b.consult ? [`Consult: ${b.consult}`] : []),
        '', b.body.trimEnd()] : [])].join('\n'), s)
      return 0
    }
    case 'set': {
      const t = await target(arg, true)
      const id = needBlock()
      const file = io.opt('file'), text = io.opt('text')
      if (file !== undefined && text !== undefined) throw io.usage('set takes --file <path> (- for standard input) or --text <text>, not both')
      const stdin = () => new Promise<string>((res, rej) => { let d = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => { d += c }); process.stdin.on('end', () => res(d)); process.stdin.on('error', rej) })
      const ev = io.opt('evidence')
      if (file === '-' && ev === '-') throw io.usage('only one of --file and --evidence can read standard input')
      const body = text ?? (file === undefined ? undefined : file === '-' ? await stdin() : await readFile(file, 'utf8'))
      let evidence: unknown
      if (ev !== undefined) { try { evidence = JSON.parse(ev === '-' ? await stdin() : ev.trimStart().startsWith('[') ? ev : await readFile(ev, 'utf8')) } catch (e) { throw io.usage(`--evidence ${ev.slice(0, 40)}: ${(e as Error).message}`) } }
      const details: { name: string; text: string }[] = []
      for (const d of io.opts('detail')) {
        const m = /^([^=]+)=(.+)$/.exec(d)
        if (!m) throw io.usage('--detail is <name>=<file>')
        details.push({ name: m[1], text: await readFile(m[2], 'utf8') })
      }
      const consult = io.opt('consult')
      const kind = io.opt('kind')
      if (kind !== undefined && kind !== 'instruction' && kind !== 'information') throw io.usage('--kind is instruction or information')
      const r = await write({
        op: 'set', ...tq(t), block: id, base: base(), ...common(),
        ...(body !== undefined ? { body } : {}), ...(io.opt('title') !== undefined ? { title: io.opt('title') } : {}),
        ...(kind ? { kind } : {}), ...(io.opt('manager') !== undefined ? { manager: io.opt('manager') } : {}),
        ...(evidence !== undefined ? { evidence: evidence as never } : {}),
        ...(consult !== undefined ? { consult: consult === 'none' ? null : consult } : {}),
        ...(details.length ? { details } : {}), ...(io.opts('drop-detail').length ? { dropDetails: io.opts('drop-detail') } : {}),
      })
      report('Saved', r)
      return 0
    }
    case 'check': {
      const t = await target(arg, true)
      report('Checked', await write({ op: 'check', ...tq(t), block: needBlock(), base: base(), ...common() }))
      return 0
    }
    case 'refresh-failed': {
      const t = await target(arg, true)
      const detail = io.opt('detail')
      if (!detail?.trim()) throw io.usage('--detail <what failed> is required')
      report('Recorded the failed refresh of', await write({ op: 'refresh', ...tq(t), block: needBlock(), outcome: io.flag('partial') ? 'partial' : 'failed', detail, ...common() }))
      return 0
    }
    case 'remove': {
      const t = await target(arg, true)
      report('Removed', await write({ op: 'remove', ...tq(t), block: needBlock(), base: base(), ...common() }))
      return 0
    }
    case 'history': {
      const t = await target(arg, false)
      const id = needBlock()
      const { revisions: h } = await getState(t, id)
      io.out(h.length ? h.map(r => `revision ${r.rev}  ${r.at}  ${r.op.padEnd(9)} ${r.by}${r.run ? ` (${r.run})` : ''}${r.content ? '' : ' [bookkeeping]'}${r.note ? ` — ${r.note}` : ''}${r.block ? `\n    ${r.block.kind}, "${r.block.title}", managed by ${r.block.manager}${r.op === 'set' || r.op === 'external' ? `\n${r.block.body.replace(/^/gm, '    ').trimEnd()}` : ''}` : r.op === 'remove' ? '\n    (removed)' : ''}`).join('\n') : `${blockFile(t, id)}: no revisions`, { ok: true, revisions: h })
      return 0
    }
    case 'detail': {
      if (!arg) throw io.usage('detail <context:…>')
      const d = service ? await remote(service, 'GET', `api/context/detail?${qs({ ref: arg })}`) as { text: string; bytes: number; sha256: string; at: string; by: string } : await local().detail(arg)
      const out = io.opt('out')
      if (out) { await writeFile(out, d.text); io.out(`Wrote ${arg} (${d.bytes} bytes, ${d.sha256.slice(0, 12)}, by ${d.by} at ${d.at}) to ${out}.`, { ok: true, ...d, text: undefined }); return 0 }
      io.out(d.text.trimEnd(), d)
      return 0
    }
    case 'run': {
      if (!arg) throw io.usage('run <run>')
      const ws = await io.workspace()
      const ref = await io.resolveRun(ws, arg)
      const { runContextView } = await import('../server/contextView.ts')
      const x = await io.exec()
      const v = await runContextView(x, ws, ref)
      if (io.flag('rendered')) { io.out(v.nextRendered, v); return 0 }
      const lines = [`Run ${v.run}`]
      for (const a of v.attempts) {
        lines.push('', `Attempt ${a.attempt} (${a.began}, ${a.reason}): ${a.recorded ? `snapshot ${a.recorded.snapshot}, fingerprint ${a.recorded.fingerprint.slice(7, 19)}` : 'no context recorded'}; prompt ${a.delivery ? `${a.delivery.event} ${a.delivery.at}${a.delivery.detail ? ` — ${a.delivery.detail}` : ''}` : 'delivery not recorded'}`)
        if (a.snapshot) lines.push(...sourceLines(a.snapshot).map(l => `  ${l}`))
        else if (a.unavailable) lines.push(`  unavailable: ${a.unavailable}`, ...(a.legacy ?? []).map(g => `  guide ${g.path} ${g.sha256.slice(0, 12)}`), ...(a.recorded?.sources ?? []).map(s => `  ${s.scope.padEnd(8)} ${s.category.padEnd(8)} ${s.delivery.padEnd(9)} ${s.key}${s.sha256 ? ` ${s.sha256.slice(0, 12)}` : ''} (recorded identity only)`))
      }
      lines.push('', `Next attempt with the current settings (fingerprint ${v.next.fingerprint.slice(7, 19)}; not yet applied to any attempt):`, ...sourceLines(v.next).map(l => `  ${l}`))
      lines.push('', v.changes.length ? `Differs from the last prepared attempt: ${v.changes.map(c => `${c.key}${c.title ? ` "${c.title}"` : ''} ${c.change}`).join(', ')}` : 'Same sources as the last prepared attempt.', `Session: ${v.session.next}`)
      io.out(lines.join('\n'), v)
      return 0
    }
  }
  throw io.usage('wfe context show|list|get|set|check|refresh-failed|remove|history|detail|run (wfe context --help)')
}
