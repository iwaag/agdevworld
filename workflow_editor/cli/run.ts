// `wfe run …`: workflow runs from the command line (docs/runs.md). Thin over
// server/runs.ts, the same operations the service uses; no command needs the
// service running.
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { RunResponse } from '../shared/api.ts'
import { accessAt } from '../shared/access.ts'
import { normalizeRepoPath } from '../shared/model.ts'
import { docStepsOf, hasDocSteps, splitCounts } from '../shared/compile.ts'
import { describeSteps, effectiveOf, EXECUTOR_OPS, holderOf, hostOf, notableEvents, questionState, runKey, type EntrustRef, type HistoryEntry, type Instruction, type OpInput, type RunRecord, type RunRef } from '../shared/run.ts'
import {
  adjustRun, checkRun, createRun, listRuns, resolveRef, runDir, runOp, runResponse, type AdjustResult, type CreateRunOptions,
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
  area: () => string // the operating area (its node catalog is frozen into new runs, p7/ex1)
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
  complete: `wfe run complete <run> <node> --outcome <text> [--artifact <path>]... [--agreement <question>]

Records the completion of a running node with its outcome and optional
artifacts (project-relative, relative to the current directory, or a file name
in the run folder). Writes run.json.
Documentation steps (_plan, _report.<node>, _final-report, as the run's policy
generates them: default all three, custom those it chose)
complete only when their document (plan.md, report-<node>.md, report.md) is
a nonempty file of the run folder; its hash and size are recorded as
evidence, and the document is listed with the outcome. _plan completes only
on agreement: a question asked from _plan about this same plan.md whose
answer was taken up (--agreement names it; default the latest taken up).
When this completion would complete the run but the conversation added
work, complete it with the adjustment instead: wfe run adjust <run>
--completing <node> --outcome … (wfe run help adjust).
Keep the outcome short (result, main verification fact, next action): it is
what coordination messages quote.`,
  fail: `wfe run fail <run> <node> --reason <text>

Records that a problem prevents the running or waiting node from continuing.
Dependent nodes stay blocked. Writes run.json.`,
  cancel: `wfe run cancel <run> [<node>] --reason <text>

Discontinues one node, or (without <node>) the whole run: every pending,
running or waiting node is cancelled in the same entry. Final. Writes run.json.`,
  ask: `wfe run ask <run> [<node>] --question <text> --to <who> [--id q<n>] [--about-plan] [--about-adjustment <name>] [--subject <path>]... [--presentation <p>]

Records a question (ids q1, q2, … unless --id). With <node>, the running node
then waits on it and <who> holds the next move. A question from _plan needs
plan.md written first and records which plan.md it asks about. --about-plan asks
about a revised plan.md later in the run (the same evidence: its hash), when
the person's input changed the agreed work. --about-adjustment <name> asks
about a proposed adjustment (wfe run adjust … --propose <name>), recorded by
hash. From the result-confirmation node
(confirms: result) the question presents the deliverables with --subject
(project-relative files, written first; recorded by hash), or a served
presentation with --presentation <p> (wfe present): its files by hash and its
revision; the answer then binds that revision only. Writes run.json.`,
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
  instructions: `wfe run instructions <run>

The person's additional instructions to this run (p6): each one's text, who
gave it and where, the nodes running when it arrived, and whether it was
acknowledged and how. Received is not read: the executor acknowledges each
(wfe run ack) at a node boundary. Reads only.`,
  instruct: `wfe run instruct <run> --instruction <text> [--from <person>]

Records a person's additional instruction to the run (the same record a post
in its Zulip request topic becomes): it changes no node and interrupts
nothing; the executor reads it at the next node boundary. --from names whose
words they are (default --by). Writes run.json.`,
  ack: `wfe run ack <run> <instruction>... --response incorporate|clarify|new-run --note <text>

Records that the executor took up these instructions and what it will do:
incorporate them into upcoming work, clarify them with a question to the
person, or explain why they need a new run. Starting a node, and the run's
last completion, are refused while a received instruction is
unacknowledged. Writes run.json.`,
  events: `wfe run events <run> [--since <seq>]

The coordination events selected from committed history entries — started,
question, answered, reported (a node's report), node-completed (manual
policy), failed, held (stopped, interrupted, unknown), resumed, completed,
decided, cancelled — each with a stable id
(<project>/<workflow>/<run>#<seq>:<type>) and a pointer to the record. The
same selection feeds Zulip delivery (wfe notify). Reads only.`,
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
  adjust: `wfe run adjust <run> --definition <file|-> --reason <text> --source <source> [--dry-run] [--propose <name>] [--expect-revision r<n>]
               [--completing <node> --outcome <text> [--artifact <path>]...]

Changes the run's future work (docs/adjustments.md): <file> is the whole
definition in force (wfe run revisions <run> --show r<n> > <draft>), edited by
hand or with wfe nodes instantiate <template> --run <run> --file <draft>. Only pending
work may change: nodes added, removed or rewired, a pending cleanup moved
after a new confirmation. Started, waiting and finished work keeps its
identity, meaning and dependencies; bindings, execution settings, intake
and documentation policy never change. Applied at a node boundary (nothing
running, no unacknowledged instruction), as a new immutable revision
(definition/r<n>/<workflow>.yaml) recorded in run.json; the original stays.
  --source request            the run's original request (braindump.md or
                              request.md, as recorded at creation) already
                              asks for this work, e.g. research before
                              implementing: no separate permission question.
                              It says why, not that the person approved this
                              graph; plan.md says which nodes the run adds and
                              the plan is agreed as usual. Not for scope the
                              request does not contain (use agreement)
           answer:<q>[:<n>]   the person's answer asked for it (taken up)
           instruction:<i>    an acknowledged instruction asked for it
           agreement:<q>      the person agreed to this exact proposal
           person             a person applies it (no attempt open)
  --dry-run       print the difference and every refusal; write nothing
  --propose <n>   write definition/proposals/<n>.yaml to ask about first:
                  wfe run ask <run> <node> --about-adjustment <n> …, then
                  apply the same file with --source agreement:<q>
  --completing <node> --outcome <text> [--artifact <path>]...
                  adjust at the completion of <node>, which is running (it
                  is the one node that may run): the adjustment and the
                  node's completion are recorded together. Use it when the
                  completion would otherwise complete the run (no final
                  report and nothing pending after it), so the work the
                  conversation agreed is added before the run ends. Both
                  or neither are recorded.
A node is an entry under nodes (type, name, description, repositories);
what it waits for is the top-level edges list, as in the workflow files:
  nodes:
    build: {type: do, name: Build, description: …, repositories: [project]}
  edges:
    - {from: talk, to: build}
The result notes an added node nothing leads to, and node fields the
contract does not know (they are kept and mean nothing).
Writes the revision file and run.json (one history entry; two with
--completing: the adjustment, then the completion).`,
  nodes: `wfe run nodes <run> [--show <template>]

The person's node catalog as this run was given it at creation (docs/catalog.md):
the activities they recognize as distinct workflow steps, each with how they
expect it to appear (expectation) and what the agent performing it does
(description). A catalog edit after the run was created does not change it.
The person recognizes these activities as distinct steps. When relevant to
the run's request, they generally expect them to be visible as workflow
nodes; whether and where is the designer's choice, made from the request and
the current workflow. A node from one of them: wfe nodes instantiate
<template> --run <run> --file <draft> (wfe nodes help), then wfe run adjust.
Also says when the catalog was unavailable at creation, or when the run
predates catalogs. Reads only.`,
  revisions: `wfe run revisions <run> [--show r<n>] [--diff r<a> r<b>]

The run's definition revisions: the original (r1) and each adjustment —
parent, reason, source, who, when and what it changed. --show prints a
revision's definition; --diff compares two (authored nodes and edges).
Reads only.`,
  decide: `wfe run decide <run> --decision accepted|rejected --evidence <ref> --by <person> [--note <text>]
wfe run decide <run> --decision accepted|rejected --question <q> [--note <text>]

Records a decision on the run's result.

The person's own decision (--by, --evidence): accepted needs a completed
execution.

From a confirmation (--question): the executor records the decision the
person's answer to the result-confirmation question is — the latest question
from the confirms: result node, its answer taken up, its deliverables
unchanged since it presented them. It may precede the execution's completion
(they stay separate facts). The record names the question, the answer, whose
words they were and the deliverables by hash. A plan agreement, an answer to
any other question, or a completion record never becomes a decision.
Writes run.json.`,
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
  instructions / instruct / ack       additional instructions: list, give, acknowledge
  access <run> [<path>]... what the run's definition declares for a path
  attach <run> <path>      record an artifact
  decide <run>             record acceptance or rejection of the result
  adjust <run>             change the run's future work (a recorded revision)
  revisions <run>          the original definition and each adjustment
  nodes <run>              the person's node catalog as this run was given it

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
  const subject = [d.node && `node ${d.node}`, d.question && `question ${d.question}`, d.path && `${d.path}`,
    e.op === 'instruction.receive' && `instruction ${e.change.instruction?.[1] ?? ''}`, Array.isArray(d.instructions) && `instructions ${(d.instructions as string[]).join(', ')} (${String(d.response)})`].filter(Boolean).join(', ')
  const moves = Object.entries(e.change.nodes ?? {}).map(([n, [a, b]]) => `${n} ${a}→${b}`)
  if (e.change.execution) moves.push(`run ${e.change.execution[0] ?? '—'}→${e.change.execution[1]}`)
  const detail = (d.reason ?? d.outcome ?? d.text ?? d.evidence ?? d.external ?? d.note ?? '') as string
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
  if (rec.definition.revisions?.length) lines.push(`Adjusted: revision ${rec.definition.active} in force (${rec.definition.revisions.map(v => `${v.revision} from ${v.parent} by ${v.by}: ${first(v.reason, 80)}`).join('; ')}); the original stays in definition/ (wfe run revisions)`)
  // The person's node catalog this run was given (p7/ex1).
  const cat = r.catalog
  if (cat) lines.push(cat.state === 'supplied' ? `Node catalog: ${cat.snapshot.templates.length ? `${cat.snapshot.templates.length} template${cat.snapshot.templates.length === 1 ? '' : 's'} (${cat.snapshot.templates.map(t => `${t.id} r${t.revision}`).join(', ')})` : 'empty'}, frozen at creation in ${cat.file} (sha256 ${cat.sha256.slice(0, 12)}…; wfe run nodes)` : cat.state === 'unavailable' ? `Node catalog: unavailable when the run was created — ${cat.problem}` : 'Node catalog: none supplied (created before p7/ex1)')
  if (rec.predecessor) lines.push(`Predecessor: ${runKey(rec.predecessor)}${r.predecessor?.problem ? ` — ${r.predecessor.problem}` : r.predecessor?.execution ? ` (${r.predecessor.execution})` : ''}`)
  lines.push(`Created ${rec.created}; started ${rec.started ?? '—'}; ended ${rec.ended ?? '—'}; last update ${ago(rec.updated)}; seq ${rec.seq}`)
  if (rec.cancelled) lines.push(`Cancelled by ${rec.cancelled.by}: ${rec.cancelled.reason}`)
  const eff = effectiveOf(rec) // the revision in force (p7)
  const count = (c: Record<string, number>) => Object.entries(c).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'
  if (eff) {
    const split = splitCounts(eff, rec.nodes)
    lines.push(`Documentation policy: ${eff.policy}, ${describeSteps(docStepsOf(eff))} (frozen at creation, ${eff.compiler})${hasDocSteps(eff) ? ` — work: ${count(split.work)}; documentation steps: ${count(split.docs)}` : ''}`)
  } else lines.push('Documentation policy: none (created before p5; the authored graph)')
  lines.push(`Nodes (${count(ex.counts)}):`)
  for (const [id, n] of Object.entries(rec.nodes)) {
    let what = ''
    if (n.state === 'pending') what = ex.ready.includes(id) ? 'READY to start' : ex.blocked.includes(id) ? 'blocked: a predecessor failed or was cancelled' : 'waits for predecessors'
    else if (n.state === 'running') what = `reported started ${n.started}; last update ${ago(n.updated)}`
    else if (n.state === 'waiting' && n.wait) what = `waits: ${n.wait.reason}; next move: ${holderOf(rec, id)}${'external' in n.wait.on ? `; awaiting ${n.wait.on.external}` : ''}`
    else if (n.state === 'completed') what = `outcome: ${first(n.outcome?.text ?? '', 120)}`
    else if (n.state === 'failed') what = `failure: ${n.failure?.reason}`
    else if (n.state === 'cancelled') what = `cancelled: ${n.cancellation?.reason}`
    const last = n.notes.at(-1)
    const step = eff?.nodes[id]?.step
    const doc = step ? `\n${' '.repeat(33)}${step.purpose}: ${r.dir}/${step.output}${n.document ? ` (checked: ${n.document.bytes} bytes, sha256 ${n.document.sha256.slice(0, 12)}…)` : r.files.some(f => f.name === step.output) ? ' (written, not yet recorded)' : ' (not written yet)'}${n.agreement ? `; agreed in ${n.agreement.question}` : ''}` : ''
    lines.push(`  ${id.padEnd(20)} ${n.state.padEnd(9)} ${what}${doc}${last && n.state !== 'completed' ? `\n${' '.repeat(33)}note: ${first(last.text, 120)}` : ''}`)
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
  const ins = Object.values(rec.instructions ?? {})
  if (ins.length) {
    const pending = ins.filter(i => !i.ack)
    lines.push(`Instructions (${pending.length ? `${pending.length} NOT ACKNOWLEDGED — the next node start and the last completion wait for wfe run ack` : 'all acknowledged'}):`)
    for (const i of ins) lines.push(...instructionLines(i))
  }
  if (r.artifacts.length) lines.push('Artifacts:', ...r.artifacts.map(a => `  ${a.path}${a.exists ? '' : ' (missing)'}`))
  if (rec.decisions.length) lines.push('Decisions:', ...rec.decisions.map(d => `  ${d.decision} by ${d.by} at ${d.at}; evidence: ${d.evidence}${d.note ? `; ${d.note}` : ''}`))
  if (r.files.length) lines.push(`Files in ${r.dir}/: ${r.files.map(f => f.name).join(', ')}; the fixed definition in definition/`)
  const hist = opts.history ? rec.history : rec.history.slice(-5)
  lines.push(opts.history ? 'History:' : `History (last ${hist.length} of ${rec.history.length}; --history for all):`, ...hist.map(entryLine))
  return lines.join('\n')
}

function adjustText(r: AdjustResult, ref: string): string {
  const a = r.authored
  const done = r.record && r.revision ? Object.entries(r.record.nodes).filter(([, n]) => n.state === 'completed').length : 0
  const lines = [r.problems.length ? `Not ${r.dryRun ? 'applicable' : 'applied'} (from ${r.parent}):` : r.duplicate ? `Already recorded: ${ref} follows ${r.revision ?? r.parent} (same receipt; nothing written again).` : r.revision ? `Applied: ${ref} now follows ${r.revision} (from ${r.parent}).${r.record?.history.at(-1)?.op === 'node.complete' ? ` ${(r.record.history.at(-1) as { node: string }).node} completed with it; ${done} node${done === 1 ? '' : 's'} completed, ready: ${r.record.execution.ready.join(', ') || 'none'}.` : ''}` : r.proposal ? `Proposal written: ${r.proposal} (nothing applied). Ask about it: wfe run ask ${ref} <node> --about-adjustment <name> …` : `Applicable to ${r.parent} (dry run; nothing written).`]
  for (const p of r.problems) lines.push(`  ${p.code}: ${p.message}`)
  for (const n of r.notes ?? []) lines.push(`  note: ${n}`)
  lines.push(`  work added: ${a.added.join(', ') || '—'}; removed: ${a.removed.join(', ') || '—'}; changed: ${a.changed.map(c => `${c.id} (${c.fields.join(', ')})`).join(', ') || '—'}${a.restyled.length ? `; restyled: ${a.restyled.join(', ')}` : ''}`)
  lines.push(`  graph: +${r.graph.added.length} −${r.graph.removed.length} nodes, +${r.graph.edgesAdded.length} −${r.graph.edgesRemoved.length} edges${r.graph.edgesAdded.length ? ` (new: ${r.graph.edgesAdded.map(([f, t]) => `${f} → ${t}`).join('; ')})` : ''}`)
  return lines.join('\n')
}

function instructionLines(i: Instruction): string[] {
  return [
    `  ${i.id} ${i.ack ? `acknowledged (${i.ack.response})` : 'received'} from ${i.from}${i.by !== i.from ? `, recorded by ${i.by}` : ''} via ${i.via} at ${i.at}${i.source ? ` (Zulip message ${i.source.message} in "${i.source.topic}")` : ''}${i.during.length ? `; arrived while ${i.during.join(', ')} ran` : ''}: ${first(i.text, 400)}`,
    ...(i.ack ? [`     ${i.ack.by}${i.ack.attempt ? ` (attempt ${i.ack.attempt})` : ''} at ${i.ack.at}: ${first(i.ack.note, 300)}`] : []),
  ]
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
        predecessor, by: by ?? executor.name, via: 'cli', area: c.area(),
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
      const agreement = c.opt('agreement')
      return op({ op: 'node.complete', node: node(), outcome: need(c, 'outcome', 'what the node produced or concluded'), artifacts, ...(agreement ? { agreement } : {}) }, rec => {
        const d = rec.nodes[args[1]]?.document
        return `Recorded: ${args[1]} completed.${d ? ` Document ${d.path} checked (${d.bytes} bytes, sha256 ${d.sha256.slice(0, 12)}…).` : ''}${rec.nodes[args[1]]?.agreement ? ` Plan agreed in ${rec.nodes[args[1]].agreement!.question}.` : ''}`
      }, r)
    }
    case 'fail': return op({ op: 'node.fail', node: node(), reason: need(c, 'reason', 'what prevents continuation') }, () => `Recorded: ${args[1]} failed.`)
    case 'cancel':
      return args[1]
        ? op({ op: 'node.cancel', node: args[1], reason: need(c, 'reason', 'why it is discontinued') }, () => `Recorded: ${args[1]} cancelled.`)
        : (async () => {
          const r = await ref()
          const { record: rec, cleanup } = await wrap(() => c.exec().cancel(ws, r, by ?? 'person', need(c, 'reason', 'why the run is discontinued'), 'cli'))
          const bad = cleanup.filter(x => !x.ok)
          return report(r, rec, `Recorded: the run is cancelled. An executing attempt is terminated by the executor; nothing it reports afterwards is recorded.${cleanup.length ? `\nPresentations: ${cleanup.map(x => `${x.presentation} ${x.ok ? 'stopped' : `NOT STOPPED (${x.detail}); retry: wfe present stop ${runKey(r)} --all`}`).join('; ')}` : ''}${bad.length ? '' : ''}`)
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
    case 'ask': return op({ op: 'question.ask', question: c.opt('id') ?? '', node: args[1], text: need(c, 'question', 'the question'), to: need(c, 'to', 'to whom it is addressed'), ...(c.flag('about-plan') ? { plan: true } : {}), ...(c.opts('subject').length ? { subjects: c.opts('subject').map(p => projectPath(ws, p)) } : {}), ...(c.opt('presentation') ? { presentation: c.opt('presentation') } : {}), ...(c.opt('about-adjustment') ? { adjustment: c.opt('about-adjustment') } : {}) },
      rec => { const q = Object.values(rec.questions).at(-1)!; return `Recorded question ${q.id} to ${q.to}${q.node ? `; ${q.node} waits on it` : ''}.` })
    case 'answer': {
      if (!args[1]) throw c.usage('<question> is required')
      return op({ op: 'question.answer', question: args[1], text: need(c, 'answer', 'the answer text'), from: c.opt('from') }, () => `Recorded an answer to ${args[1]}. A node waiting on it keeps waiting until the answer is taken up.`, undefined,
        async (t, rec) => { if (hostOf(rec.executor) !== c.exec().executor) return null; const j = await c.exec().afterAnswer(ws, t, args[1]); return j ? `The executor resumes the run (job ${j.id}, ${j.state}).` : 'The run is not resumed automatically now (held, executing, or not waiting on this question).' })
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
    case 'instructions': {
      const r = await ref()
      const resp = await wrap(() => runResponse(ws, r))
      if (!resp.record) throw c.refused(`run ${runKey(r)} cannot be used: ${resp.problem?.message}`)
      const ins = Object.values(resp.record.instructions ?? {})
      c.out(ins.length ? ins.flatMap(instructionLines).join('\n') : 'No instructions were received.', { ref: runKey(r), instructions: ins, pending: ins.filter(i => !i.ack).map(i => i.id) })
      return 0
    }
    case 'instruct': {
      const from = c.opt('from') ?? by
      if (!from?.trim()) throw c.usage('--from <person> (or --by) is required: whose instruction it is')
      return op({ op: 'instruction.receive', text: need(c, 'instruction', 'the instruction'), from }, rec => `Recorded instruction ${Object.keys(rec.instructions ?? {}).at(-1)}; ${rec.executor.name} reads it at the next node boundary.`)
    }
    case 'ack': {
      const ids = args.slice(1)
      if (!ids.length) throw c.usage('<instruction>... is required (i1 i2 …)')
      return op({ op: 'instruction.ack', instructions: ids, response: need(c, 'response', 'incorporate, clarify or new-run'), note: need(c, 'note', 'what you will do about it') }, () => `Recorded: ${ids.join(', ')} acknowledged.`)
    }
    case 'events': {
      const r = await ref()
      const resp = await wrap(() => runResponse(ws, r))
      if (!resp.record) throw c.refused(`run ${runKey(r)} cannot be used: ${resp.problem?.message}`)
      const since = Number(c.opt('since') ?? 0)
      const events = notableEvents(resp.record, since)
      c.out(events.length ? events.map(e => `${e.id}  ${e.type.padEnd(12)} ${e.at}  ${e.text.split('\n')[0].slice(0, 120)}`).join('\n') : `No notable events after seq ${since}.`, { ref: runKey(r), events })
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
    case 'adjust': {
      const r = await ref()
      const text = readInput(c, need(c, 'definition', 'the adjusted definition file (- for standard input)'))
      const src = need(c, 'source', 'request | answer:<q>[:<n>] | instruction:<i> | agreement:<q> | person')
      const m = /^(answer|instruction|agreement):([a-z0-9]+)(?::(\d+))?$/.exec(src)
      const source = src === 'request' ? { kind: 'request' as const } : src === 'person' ? { kind: 'person' as const, ...(by ? { by } : {}) } : m?.[1] === 'answer' ? { kind: 'answer' as const, question: m[2], ...(m[3] ? { answer: Number(m[3]) } : {}) } : m?.[1] === 'instruction' ? { kind: 'instruction' as const, instruction: m[2] } : m?.[1] === 'agreement' ? { kind: 'agreement' as const, question: m[2] } : null
      if (!source) throw c.usage(`--source "${src}" must be request, answer:<q>[:<n>], instruction:<i>, agreement:<q> or person`)
      const completingNode = c.opt('completing')
      const completing = completingNode ? { node: completingNode, outcome: need(c, 'outcome', `what ${completingNode} produced or concluded`), artifacts: c.opts('artifact').map(p => artifactPath(ws, r, p)) } : undefined
      if (!completing && c.opt('outcome')) throw c.usage('--outcome goes with --completing <node>')
      const res = await wrap(() => adjustRun(ws, r, { text, reason: need(c, 'reason', 'why the run changes'), source, dryRun: c.flag('dry-run'), propose: c.opt('propose'), expectRevision: c.opt('expect-revision'), completing }, { by, via: 'cli', expectSeq, attempt, receipt }))
      c.out(adjustText(res, runKey(r)), res)
      return res.ok ? 0 : 1
    }
    case 'nodes': {
      const r = await ref()
      const resp = await wrap(() => runResponse(ws, r))
      if (!resp.record) throw c.refused(`run ${runKey(r)} cannot be used: ${resp.problem?.message}`)
      const cat = resp.catalog!
      const { full } = await import('./nodes.ts')
      if (cat.state !== 'supplied') { c.out(cat.state === 'unavailable' ? `The person's node catalog could not be read when ${runKey(r)} was created: ${cat.problem}` : `${runKey(r)} was created before node catalogs (p7/ex1); none was supplied.`, cat); return 0 }
      const show = c.opt('show')
      if (show) {
        const t = cat.snapshot.templates.find(x => x.id === show)
        if (!t) throw c.refused(`the run's catalog has no template "${show}" (${cat.snapshot.templates.map(x => x.id).join(', ') || 'none'})`)
        c.out(full(t), t)
        return 0
      }
      const { CATALOG_MEANING } = await import('../shared/catalog.ts')
      c.out(cat.snapshot.templates.length
        ? [`Node catalog of ${runKey(r)}, frozen at creation (${cat.snapshot.taken}; ${cat.file}):`, CATALOG_MEANING, '', ...cat.snapshot.templates.map(t => full(t)).join('\n\n').split('\n')].join('\n')
        : `The person's node catalog was empty when ${runKey(r)} was created: no activity is named as one they expect as its own node.`, cat)
      return 0
    }
    case 'revisions': {
      const r = await ref()
      const resp = await wrap(() => runResponse(ws, r))
      const rec = resp.record
      if (!rec) throw c.refused(`run ${runKey(r)} cannot be used: ${resp.problem?.message}`)
      const texts: Record<string, string> = { r1: '' }
      const root = resp.bundle[rec.definition.root]
      // The original is the frozen copy in the run folder (p8/ex2: it was
      // read through readRunFile, which only serves top-level run files, so
      // --show r1 printed its name instead of its text).
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const original = await readFile(join(ws.root, runDir(r), 'definition', `${rec.definition.root}.yaml`), 'utf8').catch(() => null)
      texts.r1 = original ?? `(${root?.file})`
      for (const v of resp.revisions ?? []) texts[v.revision] = v.text ?? ''
      const show = c.opt('show')
      if (show) { if (!(show in texts)) throw c.refused(`no revision ${show} (${Object.keys(texts).join(', ')})`); c.out(texts[show], { revision: show, text: texts[show] }); return 0 }
      const diff = c.opts('diff')
      if (diff.length || c.flag('diff')) {
        const [a, b] = diff.length === 2 ? diff : [c.opt('diff') ?? 'r1', args[1] ?? rec.definition.active ?? 'r1']
        const wf = (id: string) => id === 'r1' ? root?.workflow : resp.revisions?.find(v => v.revision === id)?.workflow
        const wa = wf(a), wb = wf(b)
        if (!wa || !wb) throw c.refused(`no revision ${!wa ? a : b}`)
        const add = Object.keys(wb.nodes).filter(n => !(n in wa.nodes)), rem = Object.keys(wa.nodes).filter(n => !(n in wb.nodes))
        const ek = (e: { from: string; to: string }) => `${e.from} → ${e.to}`
        const ea = new Set(wa.edges.map(ek)), eb = new Set(wb.edges.map(ek))
        c.out([`${a} → ${b}`, `  nodes added: ${add.join(', ') || '—'}`, `  nodes removed: ${rem.join(', ') || '—'}`, `  edges added: ${[...eb].filter(x => !ea.has(x)).join('; ') || '—'}`, `  edges removed: ${[...ea].filter(x => !eb.has(x)).join('; ') || '—'}`].join('\n'), { from: a, to: b, added: add, removed: rem })
        return 0
      }
      const lines = [`Run ${runKey(r)}: revision ${rec.definition.active ?? 'r1'} in force.`, `  r1  the original snapshot (definition/${rec.definition.root}.yaml, created ${rec.created})`]
      for (const v of rec.definition.revisions ?? []) lines.push(`  ${v.revision}  from ${v.parent} by ${v.by} at ${v.at} (${v.source.kind}${'question' in v.source ? ` ${v.source.question}` : 'instruction' in v.source ? ` ${v.source.instruction}` : 'input' in v.source ? ` ${v.source.input} ${v.source.sha256.slice(0, 12)}…` : ''}): ${first(v.reason, 120)}`, `      added ${v.diff.added.join(', ') || '—'}; removed ${v.diff.removed.join(', ') || '—'}; ${v.file}`)
      c.out(lines.join('\n'), { active: rec.definition.active ?? 'r1', revisions: rec.definition.revisions ?? [] })
      return 0
    }
    case 'decide': {
      const decision = need(c, 'decision', 'accepted or rejected')
      if (decision !== 'accepted' && decision !== 'rejected') throw c.usage('--decision is accepted or rejected')
      const question = c.opt('question')
      if (question) {
        // Recorded by the executing attempt; its end publishes it.
        const index = c.opt('index') !== undefined ? Number(c.opt('index')) : undefined
        const target = await ref()
        const meta = { ...(attempt ? { attempt } : {}), ...(receipt ? { receipt } : {}) }
        const res = await wrap(() => runOp(ws, target, { op: 'run.decide', decision, question, answer: index, note: c.opt('note'), ...meta }, { by, via: 'cli', expectSeq }))
        const d = res.record.decisions.at(-1)!
        return report(target, res.record, res.duplicate ? 'Already recorded (same receipt); nothing changed.' : `Recorded: result ${decision}, from ${d.confirmation?.from}'s answer to ${question} (${d.evidence}). Execution is ${res.record.execution.state}; the two are separate records.`)
      }
      if (!by?.trim()) throw c.usage('--by is required: the person who decides')
      return op({ op: 'run.decide', decision, evidence: need(c, 'evidence', 'what the decision rests on'), note: c.opt('note') }, () => `Recorded: ${decision} by ${by}.`, undefined,
        async (t, rec) => { if (hostOf(rec.executor) !== c.exec().executor) return null; const cp = await c.exec().afterDecision(ws, t, decision); return `Publication checkpoint ${cp.id}: ${cp.state}${cp.error ? ` — ${cp.error}` : ''}` })
    }
  }
  return 2
}
