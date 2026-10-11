// `wfe run …`: workflow runs from the command line (docs/runs.md). Thin over
// server/runs.ts, the same operations the service uses; no command needs the
// service running.
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { RunResponse } from '../shared/api.ts'
import { accessAt } from '../shared/access.ts'
import { normalizeRepoPath } from '../shared/model.ts'
import { EXECUTOR_OPS, holderOf, notableEvents, questionState, runKey, type EntrustRef, type HistoryEntry, type OpInput, type RunRecord, type RunRef } from '../shared/run.ts'
import {
  checkRun, createRun, listRuns, resolveRef, runDir, runOp, runResponse, type CreateRunOptions,
} from '../server/runs.ts'
import { RequestError, type Workspace } from '../server/workspace.ts'
import type { ExecStore } from '../server/exec.ts'

export interface RunCli {
  positional: string[]
  opt: (k: string) => string | undefined
  opts: (k: string) => string[]
  flag: (k: string) => boolean
  workspace: () => Promise<Workspace>
  out: (human: string, data: unknown) => void
  usage: (m: string) => Error
  refused: (m: string, detail?: unknown) => Error
  serviceUrl: () => Promise<string | null> // the editor's base URL when it serves this registry
  exec: () => ExecStore // this host's execution management (queue, attempts, publication)
}

const COMMON = `Common options: --by <name> (who records; default the run's executor),
  --expect-seq <n> (refuse if the run moved past sequence n), --json,
  --receipt <id> (a retransmission with the same receipt is not recorded twice),
  --attempt <id> (default WFE_ATTEMPT: the executor's launch; while an attempt
  is open, execution reports must carry its id),
  --workspace <id> (default: the workspace containing the current directory).
<run> is <workflow>/<run-id>, or a run id that is unique in the project.`

export const RUN_HELP: Record<string, string> = {
  create: `wfe run create <workflow> --braindump <file|-> --author <person> --executor <name> [options]
wfe run create <workflow> --request <file|-> --requester <agent> --entrusted-by <ref> --executor <name> [options]

Creates devdocs/runs/<workflow>/<run>/ with the input, the fixed definition
and run.json (docs/runs.md).
  Reads   devdocs/workflows/: the workflow (id or file name); it must validate
          without errors. A workflow with a delegate node is refused before
          anything is written: delegate execution is not supported.
  Writes  braindump.md (the person's words, author --author) or request.md
          (an agent's request, --requester, --entrusted-by), definition/<id>.yaml
          (a byte copy), plan.md (--plan <file>), and run.json last.
  --name <run-id>      run-<something>; default the next run-NNN. An existing
                       run is refused and left as it is.
  --executor <name>    who performs the run (identity); --backend <text> what
                       serves it (model/harness), if known.
  --entrusted-by <ref> <workflow>/<run>[:<node>], file:<project path>, or
                       note:<text> (for example a conversation reference).
  --on-behalf-of <person>, --original <file> (keeps the input a request was
                       derived from as original-input.md), --predecessor <run>.
  --recorded-by <name> who saved a braindump (default --by).
Nothing is committed. Result: the run reference, folder and files written.
Exit 0 created; 1 refused (an invalid definition, an existing run …).`,
  list: `wfe run list [<workflow>]

Lists the runs of the project (or of one workflow): execution state, node
counts, ready nodes, what waits for whom, last update. Runs whose record cannot
be read are listed with the reason. Reads only.`,
  show: `wfe run show <run> [--history] [--rev <commit> | --rev root:<commit>]

Shows one run: input and executor, the fixed definition and how its current
source compares (same, changed, renamed, deleted), every node's state with
ready/blocked nodes and waits (with who holds the next move), questions and
answers, artifacts, decisions, the run folder's files and the latest history
(--history: all of it).
  --rev <commit>  reads run.json and the definition as committed at that
                  commit of the repository that owns devdocs (the project root
                  in directory mode, the devdocs repository in submodule mode).
  --rev root:<commit>  a project root commit; in submodule mode its recorded
                  devdocs gitlink is followed, and the output names both.
"running" is what the executor reported, not a check that anything runs.
Reads only.`,
  check: `wfe run check [<run>]

Checks one run, or every run: run.json parses, its history replays to exactly
the stored state, the definition copy matches its recorded digest, and the
record belongs to this project and location. Reads only; it never repairs. Exit 0 when all records are usable
(warnings allowed); 1 otherwise.`,
  start: `wfe run start <run> <node> [--reason <text>]

Records that work on <node> started. A pending node must be ready (every
predecessor completed). On a waiting node it records resuming; on a failed
node it needs --reason.
Writes run.json (one history entry).`,
  progress: `wfe run progress <run> <node> --note <text>

Adds a progress note to a running or waiting node; its state stays. Writes run.json.`,
  wait: `wfe run wait <run> <node> --reason <text> --holder <who> --external <ref>

Records that a running node waits for an external result: why, who or what
holds the next move, and a reference to what is awaited. For a question use
ask. Writes run.json.`,
  complete: `wfe run complete <run> <node> --outcome <text> [--artifact <path>]...

Records the completion of a running node with its outcome and optional
artifacts (project-relative, relative to the current directory, or a file name
in the run folder). Writes run.json.`,
  fail: `wfe run fail <run> <node> --reason <text>

Records that a problem prevents the running or waiting node from continuing.
Dependent nodes stay blocked. Writes run.json.`,
  cancel: `wfe run cancel <run> [<node>] --reason <text>

Discontinues one node, or (without <node>) the whole run: every pending,
running or waiting node is cancelled in the same entry. Final. Writes run.json.`,
  ask: `wfe run ask <run> [<node>] --question <text> --to <who> [--id q<n>]

Records a question (ids q1, q2, … unless --id). With <node>, the running node
then waits on it and <who> holds the next move. Writes run.json.`,
  answer: `wfe run answer <run> <question> --answer <text> [--from <person>]

Records an answer to that question. The waiting node stays waiting until the
answer is taken up (take-up). --from names who gave the answer when someone
else records it (default --by). Writes run.json.`,
  'take-up': `wfe run take-up <run> <question> [--index <n>]

Records that the executor took up the latest answer (or answer --index, from
0); a node waiting on that question resumes running. Writes run.json.`,
  withdraw: `wfe run withdraw <run> <question> --reason <text>

Closes a question without an answer; a node waiting on it resumes running.
Writes run.json.`,
  events: `wfe run events <run> [--since <seq>]

The notification boundary (p4: selection only, nothing is sent): the events
a coordinator would announce, selected from committed history entries —
acknowledged, question, answered, blocked, stopped, completed, decided,
cancelled — each with a stable id (<project>/<workflow>/<run>#<seq>) and a
pointer to the record. Reads only.`,
  stop: `wfe run stop <run> --reason <text> --by <person>

Stops execution; resumable. While an attempt executes, the stop is a request
until the executor confirms the process is gone (the record shows "stopping");
then the run is held as stopped. Without an attempt, it is held at once (for
example while it waits for a person: an answer then does not resume it).
Nothing resumes a stopped run but wfe run resume. Writes run.json.`,
  resume: `wfe run resume <run> --reason <instruction> --by <person>

Resumes a run held as stopped, interrupted or unknown: the person's explicit
instruction after looking at the working tree and records. It queues the
executor; the instruction reaches the next attempt. Refused after
cancellation. Writes run.json.`,
  access: `wfe run access <run> [<path>]...

Says what this run's fixed definition declares for each path (relative to
the current directory or project-relative): editable, readonly, report (the
run's own folder devdocs/runs/<workflow>/<run>/, which every run may write
for its records, even under a readonly root), or undeclared. The most
specific repository binding that contains a path governs it. Without paths
it lists the bindings as scopes. These are declarations you check yourself
before changing something; nothing enforces them at the OS level. Reads only.`,
  attach: `wfe run attach <run> <path> [--node <node>] [--title <text>]

Records an artifact reference (a report, a result file). <path> is
project-relative, relative to the current directory, or a file name in the
run folder. A missing file is recorded and shown as missing. Writes run.json.`,
  decide: `wfe run decide <run> --decision accepted|rejected --evidence <ref> --by <person> [--note <text>]

Records a decision on the run's result, with who decided and on what evidence.
accepted needs a completed execution. Completion records and answers never
create a decision. Writes run.json.`,
}

export function runIndex(): string {
  return `wfe run — workflow runs (docs/runs.md)

  create <workflow> …      create a run: input, fixed definition bundle, run.json
  list [<workflow>]        runs, their state and what waits for whom
  show <run>               one run in full (--history, --rev [root:]<commit>)
  check [<run>]            check records and their definition copies
  start <run> <node>       record a start (ready nodes), resume, or restart a failed node
  progress <run> <node>    add a progress note
  wait <run> <node>        wait for an external result
  complete <run> <node>    record completion with an outcome
  fail <run> <node>        record a failure
  cancel <run> [<node>]    discontinue a node or the run (final)
  stop / resume <run>      stop execution (resumable), resume a held run
  events <run>             notification-worthy events (selection only)
  ask / answer / take-up / withdraw    questions
  access <run> [<path>]... what the run's definition declares for a path
  attach <run> <path>      record an artifact
  decide <run>             record acceptance or rejection of the result

wfe run help <subcommand> for inputs, reads/writes and results.
${COMMON}`
}

// ---- helpers ---------------------------------------------------------------------

function readInput(c: RunCli, file: string): string {
  try { return readFileSync(file === '-' ? 0 : resolve(file), 'utf8') } catch (e) { throw c.refused(`cannot read ${file === '-' ? 'standard input' : file}: ${(e as Error).message}`) }
}

function need(c: RunCli, k: string, what: string): string {
  const v = c.opt(k)
  if (!v?.trim()) throw c.usage(`--${k} is required: ${what}`)
  return v
}

function entrust(c: RunCli, text: string): EntrustRef {
  if (text.startsWith('file:')) return { kind: 'file', path: text.slice(5) }
  if (text.startsWith('note:')) return { kind: 'note', text: text.slice(5) }
  const m = /^([a-z0-9][a-z0-9_.-]*)\/(run-[a-z0-9][a-z0-9_.-]*)(?::([a-z0-9][a-z0-9_.-]*))?$/.exec(text)
  if (m) return m[3] ? { kind: 'run', workflow: m[1], run: m[2], node: m[3] } : { kind: 'run', workflow: m[1], run: m[2] }
  throw c.usage(`--entrusted-by "${text}" must be <workflow>/<run>[:<node>], file:<path> or note:<text>`)
}

// An artifact path: relative to the current directory when it exists there,
// a file of the run folder, or project-relative as given.
function artifactPath(ws: Workspace, ref: RunRef, p: string): string {
  const abs = resolve(p)
  const exists = (f: string) => { try { readFileSync(f); return true } catch { return false } }
  if (isAbsolute(p) || exists(abs)) {
    const rel = relative(ws.root, abs)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new RequestError(400, `${p} is outside the project`)
    return rel.split(sep).join('/')
  }
  if (!p.includes('/') && exists(resolve(ws.root, runDir(ref), p))) return `${runDir(ref)}/${p}`
  return p
}

// A path given on the command line as project-relative: relative to the
// current directory when that is inside the project, otherwise as written.
function projectPath(ws: Workspace, p: string): string {
  const rel = relative(ws.root, resolve(p))
  return !rel.startsWith('..') && !isAbsolute(rel) && (isAbsolute(p) || relative(ws.root, process.cwd()) !== '') ? (rel.split(sep).join('/') || '.') : p
}

// One line of a longer text, marked when something was left out.
const first = (t: string, n: number) => { const l = t.split('\n')[0]; return l.length > n || t.includes('\n') ? `${l.slice(0, n)}…` : l }

const ago = (at: string | null | undefined) => {
  if (!at) return '—'
  const s = Math.round((Date.now() - Date.parse(at)) / 1000)
  const span = s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`
  return `${at} (${span} ago)`
}

function entryLine(e: HistoryEntry): string {
  const d = e as unknown as Record<string, unknown>
  const subject = [d.node && `node ${d.node}`, d.question && `question ${d.question}`, d.path && `${d.path}`].filter(Boolean).join(', ')
  const moves = Object.entries(e.change.nodes ?? {}).map(([n, [a, b]]) => `${n} ${a}→${b}`)
  if (e.change.execution) moves.push(`run ${e.change.execution[0] ?? '—'}→${e.change.execution[1]}`)
  const detail = (d.reason ?? d.outcome ?? d.text ?? d.evidence ?? d.external ?? '') as string
  return `  ${String(e.seq).padStart(3)} ${e.at}  ${e.op.padEnd(17)} ${e.by} (${e.via})${subject ? `  ${subject}` : ''}${moves.length ? `  [${moves.join(', ')}]` : ''}${detail ? `\n${' '.repeat(30)}${first(detail, 140)}` : ''}`
}

export function describeRun(r: RunResponse, opts: { history?: boolean; url?: string | null } = {}): string {
  const rec = r.record
  const lines: string[] = []
  if (r.revInfo) lines.push(`As committed in the ${r.revInfo.owner === 'root' ? 'project root' : 'devdocs repository'} at ${r.revInfo.commit.slice(0, 10)} (${r.revInfo.date}): ${r.revInfo.subject}${r.revInfo.root ? ` — the devdocs gitlink of root commit ${r.revInfo.root.slice(0, 10)}` : ''}`)
  if (!rec) {
    lines.push(`Run ${r.ref} (${r.dir}) cannot be used: ${r.problem?.code ?? r.problem?.kind}: ${r.problem?.message}`,
      'Nothing was changed. Restore or fix the files by hand; wfe run check shows the difference.')
    return lines.join('\n')
  }
  const ex = rec.execution
  lines.push(`Run ${r.ref} — ${ex.state}   (${r.dir})`)
  if (opts.url) lines.push(`Browser: ${opts.url}`)
  const i = rec.input
  lines.push(i.kind === 'braindump'
    ? `Input: ${i.file}, the words of ${i.author}${i.recordedBy ? ` (recorded by ${i.recordedBy})` : ''}`
    : `Input: ${i.file}, a request by ${i.requester}${i.onBehalfOf ? ` on behalf of ${i.onBehalfOf}` : ''}; entrusted by ${i.entrustedBy?.kind === 'run' ? `run ${runKey(i.entrustedBy)}${i.entrustedBy.node ? ` node ${i.entrustedBy.node}` : ''}` : i.entrustedBy?.kind === 'file' ? `file ${i.entrustedBy.path}` : `note "${i.entrustedBy?.kind === 'note' ? i.entrustedBy.text : ''}"`}${i.original ? `; original input kept in ${i.original}` : ''}`)
  lines.push(`Executor: ${rec.executor.name} (backend: ${rec.executor.backend ?? 'unknown'})`)
  const defs = Object.entries(rec.definition.workflows)
  lines.push(`Project: ${rec.project}`)
  lines.push(`Definition (fixed): ${rec.definition.root} in ${r.dir}/definition/`)
  for (const [id, d] of defs) {
    const s = r.sources.find(x => x.workflow === id)
    const now = !s ? '' : s.status === 'same' ? `current ${s.file}: same${s.renamed ? ' (renamed)' : ''}` : s.status === 'changed' ? `current ${s.file}: changed since the snapshot${s.renamed ? ' (renamed)' : ''}` : s.status === 'deleted' ? 'current source: deleted' : `bundle: ${s.detail}`
    lines.push(`  ${id.padEnd(20)} approvals at creation: intent ${d.approvals.intent}, definition ${d.approvals.definition}${now ? `; ${now}` : ''}`)
  }
  if (rec.predecessor) lines.push(`Predecessor: ${runKey(rec.predecessor)}${r.predecessor?.problem ? ` — ${r.predecessor.problem}` : r.predecessor?.execution ? ` (${r.predecessor.execution})` : ''}`)
  lines.push(`Created ${rec.created}; started ${rec.started ?? '—'}; ended ${rec.ended ?? '—'}; last update ${ago(rec.updated)}; seq ${rec.seq}`)
  if (rec.cancelled) lines.push(`Cancelled by ${rec.cancelled.by}: ${rec.cancelled.reason}`)
  lines.push(`Nodes (${Object.entries(ex.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')}):`)
  for (const [id, n] of Object.entries(rec.nodes)) {
    let what = ''
    if (n.state === 'pending') what = ex.ready.includes(id) ? 'READY to start' : ex.blocked.includes(id) ? 'blocked: a predecessor failed or was cancelled' : 'waits for predecessors'
    else if (n.state === 'running') what = `reported started ${n.started}; last update ${ago(n.updated)}`
    else if (n.state === 'waiting' && n.wait) what = `waits: ${n.wait.reason}; next move: ${holderOf(rec, id)}${'external' in n.wait.on ? `; awaiting ${n.wait.on.external}` : ''}`
    else if (n.state === 'completed') what = `outcome: ${first(n.outcome?.text ?? '', 120)}`
    else if (n.state === 'failed') what = `failure: ${n.failure?.reason}`
    else if (n.state === 'cancelled') what = `cancelled: ${n.cancellation?.reason}`
    const last = n.notes.at(-1)
    lines.push(`  ${id.padEnd(20)} ${n.state.padEnd(9)} ${what}${last && n.state !== 'completed' ? `\n${' '.repeat(33)}note: ${first(last.text, 120)}` : ''}`)
  }
  if (ex.ready.length) lines.push(`Ready: ${ex.ready.join(', ')}`)
  const qs = Object.values(rec.questions)
  if (qs.length) {
    lines.push('Questions:')
    for (const q of qs) {
      lines.push(`  ${q.id} ${questionState(q).padEnd(9)} to ${q.to}${q.node ? ` (node ${q.node})` : ''}, asked by ${q.askedBy}: ${first(q.text, 400)}`)
      q.answers.forEach((a, k) => lines.push(`     answer ${k}${q.takenUp?.answer === k ? ' (taken up)' : ''} from ${a.from}${a.by !== a.from ? `, recorded by ${a.by}` : ''} via ${a.via}: ${first(a.text, 400)}`))
      if (q.withdrawn) lines.push(`     withdrawn by ${q.withdrawn.by}: ${q.withdrawn.reason}`)
    }
  }
  if (r.artifacts.length) lines.push('Artifacts:', ...r.artifacts.map(a => `  ${a.path}${a.exists ? '' : ' (missing)'}`))
  if (rec.decisions.length) lines.push('Decisions:', ...rec.decisions.map(d => `  ${d.decision} by ${d.by} at ${d.at}; evidence: ${d.evidence}${d.note ? `; ${d.note}` : ''}`))
  if (r.files.length) lines.push(`Files in ${r.dir}/: ${r.files.map(f => f.name).join(', ')}; the fixed definition in definition/`)
  const hist = opts.history ? rec.history : rec.history.slice(-5)
  lines.push(opts.history ? 'History:' : `History (last ${hist.length} of ${rec.history.length}; --history for all):`, ...hist.map(entryLine))
  return lines.join('\n')
}

// ---- the command -----------------------------------------------------------------

export async function runCommand(c: RunCli): Promise<number> {
  const [sub, ...args] = c.positional
  if (!sub || sub === 'help') {
    const topic = args[0]
    console.log(topic && RUN_HELP[topic] ? `${RUN_HELP[topic]}\n\n${COMMON}` : runIndex())
    return topic && !RUN_HELP[topic] ? 2 : 0
  }
  if (!RUN_HELP[sub]) throw c.usage(`no run subcommand "${sub}" (see: wfe run help)`)
  if (c.flag('help')) { console.log(`${RUN_HELP[sub]}\n\n${COMMON}`); return 0 }
  const ws = await c.workspace()
  const by = c.opt('by')
  const expectSeq = c.opt('expect-seq') !== undefined ? Number(c.opt('expect-seq')) : undefined
  if (expectSeq !== undefined && !Number.isInteger(expectSeq)) throw c.usage('--expect-seq must be an integer')
  const link = async (ref: string) => { const u = await c.serviceUrl(); return u ? `${u}/#/ws/${encodeURIComponent(ws.reg.id)}/run/${ref.split('/').map(encodeURIComponent).join('/')}` : null }
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
    try { return await f() } catch (e) {
      if (e instanceof RequestError) throw c.refused(e.message, e.detail)
      throw e
    }
  }
  const ref = async (i = 0): Promise<RunRef> => {
    if (!args[i]) throw c.usage('<run> is required')
    return wrap(() => resolveRef(ws, args[i]))
  }
  const report = async (r: RunRef, record: RunRecord, what: string) => {
    const url = await link(runKey(r))
    const ex = record.execution
    c.out([`${what}`, `Run ${runKey(r)} is ${ex.state} (seq ${record.seq})${ex.ready.length ? `; ready: ${ex.ready.join(', ')}` : ''}${ex.waiting.length ? `; waiting: ${ex.waiting.map(w => `${w.node} (next move: ${holderOf(record, w.node)})`).join(', ')}` : ''}`, ...(url ? [`Browser: ${url}`] : [])].join('\n'),
      { ok: true, ref: runKey(r), seq: record.seq, execution: ex, url })
    return 0
  }
  const attempt = c.opt('attempt') ?? process.env.WFE_ATTEMPT ?? undefined
  const receipt = c.opt('receipt')
  const op = async (input: OpInput, what: (rec: RunRecord) => string, r?: RunRef, after?: (target: RunRef, rec: RunRecord) => Promise<string | null>) => {
    const target = r ?? await ref()
    const meta = { ...(attempt && EXECUTOR_OPS.includes(input.op) ? { attempt } : {}), ...(receipt ? { receipt } : {}) }
    const res = await wrap(() => runOp(ws, target, { ...input, ...meta }, { by, via: 'cli', expectSeq }))
    const extra = after ? await wrap(() => after(target, res.record)) : null
    return report(target, res.record, `${res.duplicate ? 'Already recorded (same receipt); nothing changed.' : what(res.record)}${extra ? `\n${extra}` : ''}`)
  }
  const node = () => { if (!args[1]) throw c.usage('<node> is required'); return args[1] }

  switch (sub) {
    case 'create': {
      const [workflow] = args
      if (!workflow) throw c.usage('<workflow> is required')
      const braindump = c.opt('braindump'), request = c.opt('request')
      if (!!braindump === !!request) throw c.usage('give exactly one of --braindump <file|-> or --request <file|->')
      const executor = { name: need(c, 'executor', 'who performs the run'), backend: c.opt('backend') ?? null }
      const input: CreateRunOptions['input'] = braindump
        ? { kind: 'braindump', text: readInput(c, braindump), author: need(c, 'author', 'the person whose words the braindump holds'), recordedBy: c.opt('recorded-by') ?? by ?? executor.name }
        : { kind: 'request', text: readInput(c, request!), requester: need(c, 'requester', 'the agent that wrote the request'), entrustedBy: entrust(c, need(c, 'entrusted-by', 'what entrusted the request')), onBehalfOf: c.opt('on-behalf-of'), original: c.opt('original') !== undefined ? readInput(c, c.opt('original')!) : undefined }
      const predecessor = c.opt('predecessor') ? await wrap(() => resolveRef(ws, c.opt('predecessor')!)) : undefined
      const r = await wrap(() => createRun(ws, {
        workflow, name: c.opt('name'), input, executor, plan: c.opt('plan') !== undefined ? readInput(c, c.opt('plan')!) : undefined,
        predecessor, by: by ?? executor.name, via: 'cli',
      }))
      const url = await link(runKey(r.ref))
      c.out([`Created run ${runKey(r.ref)} in ${r.dir}/`, ...r.files.map(f => `  ${f}`),
        ...(r.record.definition.warnings.length ? ['Definition warnings (kept as facts):', ...r.record.definition.warnings.map(w => `  ${w}`)] : []),
        `Ready: ${r.record.execution.ready.join(', ') || '(none)'}`, ...(url ? [`Browser: ${url}`] : []),
        'Nothing was committed.'].join('\n'), { ok: true, ref: runKey(r.ref), dir: r.dir, files: r.files, record: r.record, url })
      return 0
    }
    case 'list': {
      const runs = await wrap(() => listRuns(ws, args[0]))
      const human = runs.length === 0 ? `No runs${args[0] ? ` of ${args[0]}` : ''} in this project.` : runs.map(s => s.problem
        ? `${s.ref.padEnd(32)} CANNOT BE USED  ${s.problem.code ?? s.problem.kind}: ${s.problem.message}`
        : `${s.ref.padEnd(32)} ${String(s.execution).padEnd(12)} ${Object.entries(s.counts ?? {}).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')}  updated ${s.updated}${s.ready?.length ? `\n${' '.repeat(33)}ready: ${s.ready.join(', ')}` : ''}${s.waiting?.length ? `\n${' '.repeat(33)}waiting: ${s.waiting.map(w => `${w.node} (next move: ${w.holder})`).join(', ')}` : ''}${s.failed?.length ? `\n${' '.repeat(33)}failed: ${s.failed.join(', ')}` : ''}${s.decision ? `\n${' '.repeat(33)}decision: ${s.decision}` : ''}`).join('\n')
      c.out(human, { workspace: ws.reg.id, runs })
      return 0
    }
    case 'show': {
      const r = await ref()
      const resp = await wrap(() => runResponse(ws, r, { rev: c.opt('rev') }))
      c.out(describeRun(resp, { history: c.flag('history'), url: c.opt('rev') ? null : await link(runKey(r)) }), resp)
      return resp.record ? 0 : 1
    }
    case 'check': {
      const refs = args[0] ? [await ref()] : (await listRuns(ws)).map(s => ({ workflow: s.workflow, run: s.run }))
      const results = await wrap(() => Promise.all(refs.map(r => checkRun(ws, r))))
      const human = results.length === 0 ? 'No runs in this project.' : results.map(x => `${x.ref}: ${x.ok ? 'usable' : `CANNOT BE USED — ${x.code}: ${x.problem}`}${x.warnings.map(w => `\n  warning: ${w}`).join('')}`).join('\n')
      c.out(human, { ok: results.every(x => x.ok), runs: results })
      return results.every(x => x.ok) ? 0 : 1
    }
    case 'start': return op({ op: 'node.start', node: node(), reason: c.opt('reason') }, rec => {
      const from = rec.history.at(-1)!.change.nodes?.[args[1]]?.[0]
      return from === 'pending' ? `Recorded: ${args[1]} started.` : from === 'waiting' ? `Recorded: ${args[1]} resumed (it was waiting).` : `Recorded: ${args[1]} restarted after its failure.`
    })
    case 'progress': return op({ op: 'node.progress', node: node(), text: need(c, 'note', 'the progress note') }, () => `Recorded a note on ${args[1]}.`)
    case 'wait': return op({ op: 'node.wait', node: node(), reason: need(c, 'reason', 'why the node waits'), holder: need(c, 'holder', 'who or what holds the next move'), external: need(c, 'external', 'a reference to the awaited result') }, () => `Recorded: ${args[1]} waits.`)
    case 'complete': {
      const r = await ref()
      const ws2 = ws
      const artifacts = c.opts('artifact').map(p => artifactPath(ws2, r, p))
      return op({ op: 'node.complete', node: node(), outcome: need(c, 'outcome', 'what the node produced or concluded'), artifacts }, () => `Recorded: ${args[1]} completed.`, r)
    }
    case 'fail': return op({ op: 'node.fail', node: node(), reason: need(c, 'reason', 'what prevents continuation') }, () => `Recorded: ${args[1]} failed.`)
    case 'cancel':
      return args[1]
        ? op({ op: 'node.cancel', node: args[1], reason: need(c, 'reason', 'why it is discontinued') }, () => `Recorded: ${args[1]} cancelled.`)
        : (async () => {
          const r = await ref()
          const rec = await wrap(() => c.exec().cancel(ws, r, by ?? 'person', need(c, 'reason', 'why the run is discontinued'), 'cli'))
          return report(r, rec, 'Recorded: the run is cancelled. An executing attempt is terminated by the executor; nothing it reports afterwards is recorded.')
        })()
    case 'stop': {
      const r = await ref()
      const rec = await wrap(() => c.exec().stop(ws, r, by ?? 'person', need(c, 'reason', 'why it stops'), 'cli'))
      return report(r, rec, rec.control.stop ? `Stop requested; attempt ${rec.control.attempt?.id} ends when the executor confirms its process is gone. The run then waits for a resume.` : 'Recorded: the run is stopped. Nothing resumes it until a person does (wfe run resume).')
    }
    case 'resume': {
      const r = await ref()
      const res = await wrap(() => c.exec().resume(ws, r, by ?? 'person', need(c, 'reason', 'the resume instruction: what the executor should do now'), 'cli', receipt))
      return report(r, res.record, `Recorded: resumed.${res.job ? ` Queued job ${res.job.id} (${res.job.state}).` : ''}`)
    }
    case 'ask': return op({ op: 'question.ask', question: c.opt('id') ?? '', node: args[1], text: need(c, 'question', 'the question'), to: need(c, 'to', 'to whom it is addressed') },
      rec => { const q = Object.values(rec.questions).at(-1)!; return `Recorded question ${q.id} to ${q.to}${q.node ? `; ${q.node} waits on it` : ''}.` })
    case 'answer': {
      if (!args[1]) throw c.usage('<question> is required')
      return op({ op: 'question.answer', question: args[1], text: need(c, 'answer', 'the answer text'), from: c.opt('from') }, () => `Recorded an answer to ${args[1]}. A node waiting on it keeps waiting until the answer is taken up.`, undefined,
        async (t, rec) => { if (rec.executor.name !== c.exec().executor) return null; const j = await c.exec().afterAnswer(ws, t, args[1]); return j ? `The executor resumes the run (job ${j.id}, ${j.state}).` : 'The run is not resumed automatically now (held, executing, or not waiting on this question).' })
    }
    case 'take-up': {
      if (!args[1]) throw c.usage('<question> is required')
      const index = c.opt('index') !== undefined ? Number(c.opt('index')) : undefined
      return op({ op: 'question.take-up', question: args[1], answer: index }, () => `Recorded: the answer to ${args[1]} is taken up.`)
    }
    case 'withdraw': {
      if (!args[1]) throw c.usage('<question> is required')
      return op({ op: 'question.withdraw', question: args[1], reason: need(c, 'reason', 'why the question is withdrawn') }, () => `Recorded: ${args[1]} withdrawn.`)
    }
    case 'events': {
      const r = await ref()
      const resp = await wrap(() => runResponse(ws, r))
      if (!resp.record) throw c.refused(`run ${runKey(r)} cannot be used: ${resp.problem?.message}`)
      const since = Number(c.opt('since') ?? 0)
      const events = notableEvents(resp.record, since)
      c.out(events.length ? events.map(e => `${e.id}  ${e.type.padEnd(12)} ${e.at}  ${e.detail.split('\n')[0].slice(0, 120)}`).join('\n') : `No notable events after seq ${since}.`, { ref: runKey(r), events })
      return 0
    }
    case 'access': {
      const r = await ref()
      const resp = await wrap(() => runResponse(ws, r))
      const def = resp.record ? resp.bundle[resp.record.definition.root]?.workflow : undefined
      if (!resp.record || !def) throw c.refused(`run ${runKey(r)} cannot be used: ${resp.problem?.message ?? 'its definition cannot be read'}`)
      const dir = runDir(r)
      const answers = args.slice(1).map(p => accessAt(def.repositories, projectPath(ws, p), dir))
      const scopes = Object.entries(def.repositories).map(([k, b]) => `  ${k.padEnd(16)} ${(normalizeRepoPath(b.path) ?? b.path).padEnd(28)} ${b.access}`)
      c.out(answers.length
        ? answers.map(a => `${a.path}: ${a.access} — ${a.reason}`).join('\n')
        : [`Scopes of ${runKey(r)} (most specific wins):`, ...scopes, `  ${'(records)'.padEnd(16)} ${dir.padEnd(28)} report — this run's own folder`].join('\n'),
      { ref: runKey(r), bindings: def.repositories, records: dir, answers })
      return 0
    }
    case 'attach': {
      const r = await ref()
      if (!args[1]) throw c.usage('<path> is required')
      const path = artifactPath(ws, r, args[1])
      return op({ op: 'artifact.attach', path, node: c.opt('node'), title: c.opt('title') }, () => `Recorded artifact ${path}.`, r)
    }
    case 'decide': {
      const decision = need(c, 'decision', 'accepted or rejected')
      if (decision !== 'accepted' && decision !== 'rejected') throw c.usage('--decision is accepted or rejected')
      if (!by?.trim()) throw c.usage('--by is required: the person who decides')
      return op({ op: 'run.decide', decision, evidence: need(c, 'evidence', 'what the decision rests on'), note: c.opt('note') }, () => `Recorded: ${decision} by ${by}.`, undefined,
        async (t, rec) => { if (rec.executor.name !== c.exec().executor) return null; const cp = await c.exec().afterDecision(ws, t, decision); return `Publication checkpoint ${cp.id}: ${cp.state}${cp.error ? ` — ${cp.error}` : ''}` })
    }
  }
  return 2
}
