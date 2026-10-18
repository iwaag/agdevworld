// `wfe context` (workflow_editor p13, docs/context.md): the scoped context of
// a project, a workflow or a run, and the Developer's overrides. The same
// resolver and store as the browser and the executor's claim.
import { readFile } from 'node:fs/promises'
import { overrideFile, sourceLines, type OverrideState, type OverrideTarget } from '../shared/context.ts'
import type { AccessContext } from '../server/access.ts'
import { ContextStore, overrideTarget } from '../server/contextStore.ts'
import type { ExecStore } from '../server/exec.ts'
import type { Workspace } from '../server/workspace.ts'

export const CONTEXT_HELP = `wfe context show [--workflow <id>] [--for authoring|execution] [--rendered]
wfe context get <scope> [--workflow <id>]
wfe context set <scope> [--workflow <id>] (--file <path>|- | --text <text>) --base <sha256>|none --by <name> [--note <text>]
wfe context clear <scope> [--workflow <id>] --base <sha256> --by <name>
wfe context history <scope> [--workflow <id>]
wfe context run <run> [--rendered]
wfe context list

The context WFE gives an agent besides a run's records, by scope:

  scope     default (in the project's repositories)          override (local, not in Git)
  system    the common execution contract (the execution     .local/contexts/system.md of this
            host's, at claim); for authoring the authoring   WFE area: Developer-wide preferences
            area's AGENTS.md and docs/contract.md            and local environment guidance
  project   project.yaml intent and goals; project.yaml      …/projects/<project>/project.md
            guides
  workflow  the workflow's intent; its execution.guides      …/projects/<project>/workflows/<workflow>.md
  run       (none: a run's input is its request and record, answers and instructions — wfe run)

<scope> is system, project or workflow. The project is the workspace's
(the current directory, or --workspace <id>); --workflow names the
workflow by id.

show      the resolved sources for an authoring session of the project (and
          workflow), or with --for execution what a new run of the workflow
          would be prepared with now. --rendered prints the exact text an agent
          is given. An IDE agent editing a workflow reads this: it is the
          project's and workflow's guidance and where each part comes from.
get       an override, its sha256 (pass it as --base), revision and author
set       replace an override; --base is the sha256 (or a 12+ digit prefix)
          of the content you read, or none when there is none; a different
          current content refuses the write (context-conflict)
clear     remove an override's contribution (inherited defaults stay)
history   every revision: author, time, sha256, and exact content
run       what each attempt of a run was prepared with (its local snapshot)
          and was the prompt delivered, the next attempt with the current
          settings, and what differs
list      every override set in this area

Delivery: body (included in the text), reference (named, not included;
"reference supplied" does not mean the agent read it), absent (nothing
configured), error (configured but unreadable: an attempt is not prepared
while a source is in error). Applicability: the execution contract is for
run executors only; everything else applies to execution and authoring.
Scope is breadth, not precedence: an explicit request or a more specific
instruction refines a general one, and nothing is parsed into settings.

A saved override reaches the next attempt of every affected run, never one
in progress; to steer current work use wfe run instruct. Saving starts or
resumes nothing. A changed effective context starts a new session on the
next attempt of a run whose policy is run. Overrides and snapshots stay in
this area's .local/: run records name only a snapshot id, a fingerprint and
hashes.`

interface Io {
  positional: string[]
  opt: (k: string) => string | undefined
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

const stateLine = (s: OverrideState) => `${s.file}: ${s.text === null ? 'not set' : `${s.sha256!.slice(0, 12)} (${s.revision !== null ? `revision ${s.revision}, ${s.updated!.at} by ${s.updated!.by}` : 'edited outside WFE'}, ${Buffer.byteLength(s.text)} bytes)`}${s.problem ? ` — ${s.problem}` : ''}`

export async function contextCommand(io: Io): Promise<number> {
  const [sub, arg] = io.positional
  const store = new ContextStore(io.area())
  const target = async (): Promise<OverrideTarget> => {
    if (!arg) throw io.usage(`${sub} <system|project|workflow> …`)
    if (arg === 'system') return overrideTarget('system')
    const ws = await io.workspace()
    const project = (await ws.readProject().catch(() => ({ project: undefined }))).project?.id || ws.reg.project || ws.reg.id
    return overrideTarget(arg, project, arg === 'workflow' ? io.opt('workflow') : undefined)
  }
  switch (sub) {
    case 'show': {
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
        '', purpose === 'authoring' ? 'This is guidance for the session, available on request (wfe context show --rendered); WFE does not inject it into an IDE session. Override bodies stay local: do not copy them into tracked files.' : 'The execution contract is the host\'s at claim. wfe context show --for execution --rendered prints the section a run is given.'].join('\n'), { ...b, rendered: text })
      return 0
    }
    case 'get': {
      const s = await store.read(await target())
      io.out(`${stateLine(s)}${s.text !== null ? `\n\n${s.text}` : ''}`, s)
      return 0
    }
    case 'set':
    case 'clear': {
      const t = await target()
      const by = io.opt('by')
      if (!by?.trim()) throw io.usage('--by <name> is required: who writes the override')
      let text: string | null = null
      if (sub === 'set') {
        const file = io.opt('file'), t2 = io.opt('text')
        if ((file === undefined) === (t2 === undefined)) throw io.usage('set takes --file <path> (- for standard input) or --text <text>')
        text = t2 ?? (file === '-' ? await new Promise<string>((res, rej) => { let d = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => { d += c }); process.stdin.on('end', () => res(d)); process.stdin.on('error', rej) }) : await readFile(file!, 'utf8'))
      }
      const baseArg = io.opt('base')
      if (baseArg === undefined) throw io.usage('--base <sha256 of the content you read (wfe context get)> or --base none is required')
      const cur = await store.read(t)
      const base = baseArg === 'none' ? null : /^[0-9a-f]{12,64}$/.test(baseArg) && cur.sha256?.startsWith(baseArg) ? cur.sha256 : baseArg
      try {
        const r = await store.write(t, text, { by, base, note: io.opt('note') })
        io.out(r.changed ? `${sub === 'set' ? 'Saved' : 'Cleared'} ${stateLine(r.state)}.\nIt applies to the next attempt of affected runs and to authoring sessions that read it; nothing was started or resumed.` : `Unchanged: ${stateLine(r.state)}.`, { ok: true, ...r })
        return 0
      } catch (e) {
        const d = (e as { detail?: unknown }).detail
        throw io.refused((e as Error).message, d)
      }
    }
    case 'history': {
      const t = await target()
      const h = await store.history(t)
      io.out(h.length ? h.map(r => `revision ${r.rev}  ${r.at}  ${r.by}  ${r.sha256 ? r.sha256.slice(0, 12) : 'removed'}${r.external ? ' (found edited outside WFE)' : ''}${r.note ? ` — ${r.note}` : ''}${r.text !== null ? `\n${r.text.replace(/^/gm, '    ').trimEnd()}` : ''}`).join('\n') : `${overrideFile(t)}: no revisions`, { ok: true, revisions: h })
      return 0
    }
    case 'list': {
      const all = await store.list()
      io.out(all.length ? all.map(stateLine).join('\n') : 'No override is set in this area.', { ok: true, overrides: all })
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
      lines.push('', v.changes.length ? `Differs from the last prepared attempt: ${v.changes.map(c => `${c.key} ${c.change}`).join(', ')}` : 'Same sources as the last prepared attempt.', `Session: ${v.session.next}`)
      io.out(lines.join('\n'), v)
      return 0
    }
  }
  throw io.usage('wfe context show|get|set|clear|history|run|list (wfe context --help)')
}
