// `wfe run …`: workflow runs from the command line (docs/runs.md). Thin over
// server/runs.ts, the same operations the service uses; no command needs the
// service running.
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { RunResponse } from '../shared/api.ts'
import { accessAt } from '../shared/access.ts'
import { normalizeRepoPath, sessionPolicyOf } from '../shared/model.ts'
import { docStepsOf, hasDocSteps, splitCounts } from '../shared/compile.ts'
import { describeSteps, effectiveOf, EXECUTOR_OPS, holderOf, hostOf, notableEvents, questionState, runKey, type BecauseRef, type Correction, type EntrustRef, type HistoryEntry, type Instruction, type OpInput, type RunRecord, type RunRef } from '../shared/run.ts'
import {
  adjustRun, checkRun, createRun, listRuns, readRun, recordDone, resolveRef, runDir, runOp, runResponse, usableRun, type AdjustResult, type CreateRunOptions,
} from '../server/runs.ts'
import { RequestError, type Workspace } from '../server/workspace.ts'
import { humanBytes } from '../shared/shares.ts'
import { runStatus } from '../shared/status.ts'
import { sourceLabel } from '../shared/intake.ts'
import { runSpace } from '../server/runspace.ts'
import { integrationStatus } from '../shared/approval.ts'
import type { ExecStore } from '../server/exec.ts'
import { discussionTurn, quietly } from './evidence.ts'
import type { Advice } from '../server/reminders.ts'
import { answerReminder, type Reminder } from '../shared/reminders.ts'

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

// Said once in each help of an operation WFE may answer with reminders
// (workflow_editor fix5, docs/runs.md "Reminders at operation boundaries").
const REMINDERS = `Before recording it, WFE may answer with reminders instead: work not
presented, a page still serving with no cleanup planned, work that may have
been done outside nodes; when it completes a run that delegated, what its
children's results left out (wfe delegate show). They record nothing; the
refusal names the facts and the repair, ends with both in short, and says
how to continue as it is.`

const COMMON = `Common options: --by <name> (who records: your own name. An executing
  attempt (WFE_ATTEMPT) records as the run's agent and refuses another name;
  outside one, a run the execution host performs needs --by; otherwise the
  default is the run's executor),
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
          without errors. A delegate node's work is entrusted to another
          workflow during the run (wfe delegate help).
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
  io: `wfe run io <run> [--attempt <id> --line <n>]

The run's detailed IO (p10): its Zulip channel (one per run) and, per
attempt, how far its log was relayed and any gap. With --attempt and
--line, one entry of that attempt's log in full — what a cut IO message
links to — redacted like the messages. Reads only; never the raw log.`,
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
  state: `wfe run state <run> [--since <seq>]

The run's current state in a few lines, for an agent continuing it
(agent_session p1 ex2): the record's seq, a hold or cancellation, which
nodes are ready, running, waiting (for whom) or failed, open presentations,
the definition revision in force and decisions; then, in full, every answer
recorded and not yet taken up, every instruction not acknowledged and every
delegation fact not taken up. --since <seq>: also one line per entry
recorded after that seq. Not the whole record: wfe run show for that.
Reads only.`,
  check: `wfe run check [<run>]

Checks one run, or every run: run.json parses, its history replays to exactly
the stored state, the definition copy matches its recorded digest, and the
record belongs to this project and location. Reads only; it never repairs. Exit 0 when all records are usable
(warnings allowed); 1 otherwise.`,
  start: `wfe run start <run> <node> [--reason <text>]

Records starting or reopening a node. Dependency edges suggest an order;
any known node can start, including completed, waiting and failed work.
An open attempt supplies its attempt id; stale writers receive its actual state. Writes run.json. Writes run.json.`,
  progress: `wfe run progress <run> <node> --note <text>

Adds a progress note to a running or waiting node; its state stays. Writes run.json.`,
  wait: `wfe run wait <run> <node> --reason <text> --holder <who> --external <ref> [--deadline <time|90s|20m|2h>]

Records that a running node waits for an external result: why, who or what
holds the next move, and a reference to what is awaited. For a question use
ask. --deadline says when the result is expected at the latest (an ISO time
or a duration from now); a monitor treats the wait as uncertain after it and
looks into it, while a wait inside it is left alone. Nothing changes state
because of a deadline. Writes run.json.`,
  complete: `wfe run complete <run> <node> --outcome <text> [--artifact <path>]... [--agreement <question>]

Records the outcome of a running node. Available documentation is recorded
by hash. Documents, plan agreement, review decisions, acknowledged input and
presentation shutdown are optional records and do not gate completion.
A combined adjustment is available with --definition and --completing. Writes run.json.
${REMINDERS}`,
  fail: `wfe run fail <run> <node> --reason <text>

Records that a problem prevents the running or waiting node from continuing.
Dependent nodes stay blocked. Writes run.json.`,
  cancel: `wfe run cancel <run> [<node>] --reason <text> [--because answer:<q>[:<n>]|instruction:<i>]

Discontinues one node, or (without <node>) the whole run: every pending,
running or waiting node is cancelled in the same entry. Final. The run's
working copy, records and saved branch stay as they are (nothing is
reverted). --because names the person's answer or instruction you acted on
(the record shows whose words they were). Writes run.json.`,
  ask: `wfe run ask <run> [<node>] --question <text> --to <who> [--id q<n>] [--about-plan] [--about-adjustment <name>] [--subject <path>]... [--presentation <p>] [--output <o>]

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
revision; the answer then binds that revision only. --output <o> presents an
external output (wfe run publish): its bytes on the share are verified against
its manifest in full, and the manifest is recorded as a subject, alone or
with a presentation (a preview of it). Writes run.json.
${REMINDERS}`,
  answer: `wfe run answer <run> <question> --answer <text> [--from <person>] [--source-message <conversation>:<id>]

Records an answer to that question. The waiting node stays waiting until the
answer is taken up (take-up). --from names who gave the answer when someone
else records it (default --by). Writes run.json.`,
  'take-up': `wfe run take-up <run> <question> [--index <n>]

Records that the executor took up the latest answer (or answer --index, from
0); a node waiting on that question resumes running. An answer about a
presentation comes with a reminder: it may ask for more work, or the review
is finished and cleanup is due; nothing is stopped by it. Writes run.json.`,
  withdraw: `wfe run withdraw <run> <question> --reason <text>

Closes a question without an answer; a node waiting on it resumes running.
Writes run.json.`,
  instructions: `wfe run instructions <run>

The person's additional instructions to this run (p6): each one's text, who
gave it and where, the nodes running when it arrived, and whether it was
acknowledged and how. Received is not read: the executor can acknowledge
each (wfe run ack) whenever it reads them. Reads only.`,
  instruct: `wfe run instruct <run> --instruction <text> [--from <person>] [--source-message <conversation>:<id>]

Records a person's additional instruction to the run (the same record a post
in its Zulip request topic becomes): it changes no node and interrupts
nothing; the executor sees it in its next state read or attempt brief. --from names whose
words they are (default --by). Writes run.json.`,
  ack: `wfe run ack <run> <instruction>... --response incorporate|clarify|new-run --note <text>

Records that the executor took up these instructions and what it will do:
incorporate them into upcoming work, clarify them with a question to the
person, or explain why they need a new run. It tells the person their words
reached the executor; no transition waits for it. Writes run.json.`,
  correction: `wfe run correction <run> [<c>] [--note <text>] [--no-change --note <why>]

A correction is the run that delegated this one returning its completed
result (workflow_editor fix6): what to add, why, and whose words. While it is
not addressed this run is not completed, and its agent owes the next move.
Without <c>: lists the corrections. With <c>: records that you read it
(--note says what you will do). Then add the missing work as new nodes —
wfe run adjust (catalog templates with wfe nodes instantiate, e.g. a
present node and its cleanup) — and perform it; that addresses it. Completed
work is kept and not repeated. The next completion is a new result for the
delegating run.
--no-change --note <why>: nothing needs to change; the run completes again
as it is and the delegating run is told why. Ending an attempt with a
correction that arrived before it still unaddressed holds the run as
interrupted, like work left ready. Writes run.json.`,
  integrate: `wfe run integrate <run> [--dry-run|--status] [--by <actor>]

Integrates the actual saved run copy into its recorded target branches.
No approval, agreement, acceptance or completed graph is required. An open
attempt finishes before integration; explicit stop/cancel intent remains.
--dry-run combines locally without pushing or recording an integration.
--status reads the journal. Actual conflicts name files: fetch the target,
merge and resolve in the run copy, commit the resolution, then retry.
Later reports and changes integrate without renewed acceptance. Writes commits and the integration journal; --status reads only.`,
  reversal: `wfe run reversal <run>

What undoing the run involves (p9, docs/integration.md). Reads only; it
changes nothing. Cancelling keeps a run's work. Work that was never
integrated is on the run's own branch and in its copy: discarding it needs no
rollback on a shared branch. An integrated result is undone as new work — a
new run that names this one as its predecessor and reverts, with new
commits, exactly what each integration brought: per repository the target,
the commits before and after, the commits and files in between, and the
target's later commits (kept). A submodule is reverted in its own repository
(possibly shared with other projects), and the root then records that new
commit; moving the root's gitlink back alone does not undo the submodule.
Effects outside Git (deployments, data elsewhere, served presentations) are
named, never claimed undone.`,
  events: `wfe run events <run> [--since <seq>]

The coordination events selected from committed history entries — started,
question, answered, reported (a node's report), node-completed (manual
policy), failed, held (stopped, interrupted, unknown), resumed, completed,
decided, cancelled — each with a stable id
(<project>/<workflow>/<run>#<seq>:<type>) and a pointer to the record. The
same selection feeds Zulip delivery (wfe notify). Reads only.`,
  stop: `wfe run stop <run> --reason <text> [--because answer:<q>[:<n>]|instruction:<i>]

Holds the run: execution stops and nothing begins until wfe run resume. Its
plan, records and unfinished work stay in its own working copy (saved to its
run branch at the stop's checkpoint); other requests in the project go on
meanwhile. While an attempt executes, the stop is a request until the
executor confirms the process is gone (the record shows "stopping"); then
the run is held as stopped. Without an attempt, it is held at once (for
example while it waits for a person: an answer then does not resume it).
An executing agent records it as itself; --because names the person's answer
or instruction it acted on. Writes run.json.`,
  recover: `wfe run recover <run> --incident <id> --attempt <ended attempt> --reason <text> [--expect-seq <n>] [--by <name>]

A recovering agent continues a run held as interrupted or unknown, or whose
continuation nothing queued — ready work or a recorded answer, no hold, no
job (observer p3, docs/observation.md). --attempt is the run's last attempt
(none when it never had one). Not a person's resume: the record names the
incident, the attempt whose end held the run (--attempt, wfe run show says
it: the hold follows control.last) and who recovered it. Run from a recovery
run's attempt (WFE_ATTEMPT), it records as that run's agent and names its run
and attempt; outside an attempt --by names the recorder.
Refused (exit 1) when: the hold is a person's (stopped), the run is cancelled,
or it is not held and nothing in it waits for the executor or a job is queued
(recover-human-hold, run-cancelled, state, recover-owned); the hold follows
another attempt (recover-stale); --expect-seq is outdated (outdated); a
process of the run still lives on this host (recover-process-alive); the run
was already recovered 2 times since the last person's instruction (recover-budget).
The same incident and attempt are recorded once. On success the resumption is
queued; the next attempt's brief says it was continued by recovery and why.
It grants no replay of side effects, no acceptance, no plan change and no
answer. Writes run.json.`,
  session: `wfe run session <run> [--retire --reason <text> [--because answer:<q>[:<n>]|instruction:<i>]]

The run's harness sessions (agent_session p1, docs/sessions.md): its frozen
session policy (fresh: a new conversation every attempt; run: later
attempts resume the run's retained conversation), each session's id, the
attempts it served, the configuration it was created under, and why each
earlier one was replaced or retired. Transcripts stay on the execution host;
the record keeps identities only.
--retire ends the current session between attempts: the next attempt starts
a new one from the run's records. For a session that is unusable (corrupt,
or a conversation that keeps failing on resume) or when its context should
not be carried on. Refused while an attempt is open or a process of the run
lives. It changes no hold: a held run still needs a resume or a recovery.
Writes run.json.`,
  resume: `wfe run resume <run> --reason <instruction> [--because answer:<q>[:<n>]|instruction:<i>] [--profile <name>]

Resumes a run held as stopped, interrupted or unknown: the instruction, after
looking at the run's copy and records. It queues the executor; the next
attempt works in the same copy, from the run's own base (the project's newer
commits are not merged in; the brief names them). Refused after cancellation.
--because names the person's words it follows. --profile <name> moves the
run to another of the execution host's profiles (which model serves it) for
every later attempt; the agent, guides and access stay the definition's, and
a profile the host does not offer makes the next job wait. Writes run.json.`,
  assign: `wfe run assign <run> --node <worker> --reason <why> --by <name>

The run is performed by another execution node (worker) from its next attempt
on (docs/workers.md). Refused while an attempt is open. Recorded with who and
why; nothing moves a run by itself. Its queued job waits for that worker. A
session (execution.session: run) is not carried to another node: its next
attempt starts a new one from the records. Writes run.json.`,
  access: `wfe run access <run> [--path <project-relative path>]

Shows binding descriptions and the explicit target path. Readonly and
if-unchanged declarations are historical descriptions, not write or merge
permissions. Project content is editable without a binding declaration. Reads only.`,
  input: `wfe run input <run> <node> --ref shared://<share>/<path>[/] [--stage copy|in-place]

Selects an input set for a running node (docs/shares.md): the files the
reference holds on this host now, each by path, size and sha256, written to
inputs/i<n>.json in the run folder and recorded (input.select). --stage copy
(default) also copies them into the run copy's .local/inputs/i<n>/ and
verifies the copy: work reads that copy, so a later change on the share does
not reach the run. --stage in-place reads them where they are; use wfe run
inputs --verify before relying on them again. A reference that is not
mounted, missing or empty is refused (nothing recorded). Selecting the same
reference again makes a new set; nothing replaces one. Writes run.json.`,
  inputs: `wfe run inputs <run> [--verify <i>|--verify-all] [--quick]

The run's references (written in its input) and input sets: digest, files,
bytes, staging, the last check and where they are on this host. --verify
re-reads a set (the staged copy, or the share for in-place) against its
manifest and records what it found: verified, changed or missing — a changed
input is recorded, never silently consumed. --quick compares sizes only.`,
  publish: `wfe run publish <run> <node> --source <folder> --title <text> --candidate <name> [--share <share>] [--input <i>]...

Publishes a folder of the run copy (usually under .local/) as output o<n>
(docs/shares.md): copied to shared://<share>/runs/<project>/<workflow>/<run>/o<n>/
through an unfinished .o<n>.partial-* folder, every file verified, the manifest
written inside, then renamed into place — a partial copy is never published.
outputs/o<n>.json in the run folder keeps the manifest in Git; the payload
stays outside it. --candidate names the approach or variant (a later output
of the same candidate supersedes an earlier one in a confirmation; another
candidate coexists). --input names the input sets it was made from (default:
all of the run's). --share defaults to the share of the run's first input
set. Writes run.json.`,
  outputs: `wfe run outputs <run> [--verify <o>] [--quick]

The run's external outputs: candidate, digest, files, bytes, the last check
and the LAN download address. --verify re-reads an output on the share against
its manifest and records what it found. Ask about one with wfe run ask …
--output <o> (its bytes are verified in full then).`,
  attach: `wfe run attach <run> <path> [--node <node>] [--title <text>]

Records an artifact reference (a report, a result file). <path> is
project-relative, relative to the current directory, or a file name in the
run folder. A missing file is recorded and shown as missing. Writes run.json.`,
  adjust: `wfe run adjust <run> --definition <file|-> --reason <text> [--source agent|request|answer:<q>|instruction:<i>|agreement:<q>|person] [--dry-run] [--expect-revision <r>]

Records a revision of the work graph, bindings, documentation or execution
choices, including running and completed work. Default source is agent;
no question, answer take-up or human agreement is a prerequisite.
--dry-run shows changes without writing. --propose <name> saves an optional
proposal. --completing <node> --outcome <text> records a revision and that
running node's completion atomically; the completion is checked for
reminders as in wfe run complete, on the revised graph. Stale revisions and
writers receive concrete diagnostics so the agent can re-read and retry.
Work that already happened without a node is recorded with wfe run
record-done instead. Writes revision files and run.json.`,
  nodes: `wfe run nodes <run> [--show <template>]

The person's node catalog as this run was given it at creation (docs/catalog.md):
the activities they recognize as distinct workflow steps, each with how they
expect it to appear (expectation) and what the agent performing it does
(description). A catalog edit after the run was created does not change it.
The person recognizes these activities as distinct steps. When one is
relevant to the run's request, it is performed as a node of its own as far as
possible, not inside another node such as a talk; not an absolute rule, and
where the nodes go is the designer's choice, made from the request and the
current workflow (workflow_editor fix3). A node from one of them: wfe nodes instantiate
<template> --run <run> --file <draft> (wfe nodes help), then wfe run adjust.
Also says when the catalog was unavailable at creation, or when the run
predates catalogs. Reads only.`,
  'record-done': `wfe run record-done <run> (--template <t> | --type do|study|talk --name <text> --id <node>) [--id <node>] [--after <node>]... [--before <node>]...
    --outcome <text> --reason <text> [--artifact <path>]... [--commit-id <sha>[@<repository>]]... [--entry <seq>]...
    [--question <q>]... [--output <o>]... [--presentation <p>] [--started-at <time>] [--ended-at <time>] [--expect-revision r<n>]

Records work that already happened, without its own node, as a completed
node (workflow_editor fix5). One entry adds a revision with the node and
records it done: no start, no completion event, nothing scheduled in
between, and nothing is run, launched, dispatched or answered. The run's
history stays as it was (a talk's outcome keeps its words); the node appears
from the new revision on, marked "recorded afterwards" in the graph, its
details and the history.
  --template <t>   a template of the run's catalog (wfe run nodes): the node is
                   made from it, with its provenance. Without one, --type,
                   --name and --id describe the node.
  --id <node>      its id (default: the template's id, made unique).
  --after/--before where it goes: after nodes completed or under way (the talk
                   it was done inside may still be running), never future work.
  --outcome        what the work produced or concluded.
  --reason         why it is recorded afterwards (where it was done, e.g.
                   inside the talk).
  Evidence, each checked to exist: --artifact (a file of the run's copy, by
  hash), --commit-id (a commit of the run's copy or of a repository in it),
  --entry (an earlier entry of this run, e.g. the talk's completion),
  --question, --output, --presentation (an existing presentation that shows
  this work: linked to the node; its registration stays as it was).
  --started-at/--ended-at: the work's own times as you know them, recorded
  as reported; leave them out when unknown.
Work that has not happened yet is not recorded here: add it as pending work
with wfe run adjust and do it there. A presentation that was never made is
not repaired by declaring it done. Refused while another attempt executes
the run. Retransmission with the same --receipt records nothing new.
Writes the revision file and run.json.`,
  revisions: `wfe run revisions <run> [--show r<n>] [--diff r<a> r<b>]

The run's definition revisions: the original (r1) and each adjustment —
parent, reason, source, who, when and what it changed. --show prints a
revision's definition; --diff compares two (authored nodes and edges).
Reads only.`,
  decide: `wfe run decide <run> --decision accepted|rejected --evidence <ref> --by <actor> [--note <text>]
wfe run decide <run> --decision accepted|rejected --question <q> [--note <text>]

Records a decision with the actual actor and evidence. A question-based
decision identifies the answer and content it refers to; it never invents
an answer. Decisions are independent of execution and integration. Writes run.json.`,
}

export function runIndex(): string {
  return `wfe run — workflow runs (docs/runs.md)

  create <workflow> …      create a run: input, fixed definition bundle, run.json
  list [<workflow>]        runs, their state and what waits for whom
  show <run>               one run in full (--history, --rev [root:]<commit>)
  state <run>              current state and pending input only (--since <seq>: entries after it)
  check [<run>]            check records and their definition copies
  start <run> <node>       record a start (ready nodes), resume, or restart a failed node
  progress <run> <node>    add a progress note
  wait <run> <node>        wait for an external result
  complete <run> <node>    record completion with an outcome
  fail <run> <node>        record a failure
  cancel <run> [<node>]    discontinue a node or the run (final)
  stop / resume <run>      hold (work kept; others go on), resume a held run
  assign <run>             perform the run on another execution node from its next attempt
  recover <run>            a recovering agent continues an interrupted/unknown hold (incident, attempt)
  session <run>            the run's harness sessions; --retire ends the current one
  events <run>             notification-worthy events (selection only)
  io <run>                 the run's detailed IO channel; one IO entry in full (--attempt, --line)
  ask / answer / take-up / withdraw    questions
  instructions / instruct / ack       additional instructions: list, give, acknowledge
  correction <run> [<c>]   a delegating run returned this run's result: list, take up, --no-change
  access <run> [<path>]... what the run's definition declares for a path
  attach <run> <path>      record an artifact
  input / inputs <run>     select an input set from a shared:// reference; list and verify them
  publish / outputs <run>  publish an output to a shared area; list and verify them
  decide <run>             record acceptance or rejection of the result
  integrate <run>          bring saved work into the shared branches (or --dry-run, --status)
  reversal <run>           what undoing the run involves (facts only)
  adjust <run>             change the run's future work (a recorded revision)
  record-done <run>        record work already done without a node as a completed node
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
// p9: relative to the root the run's files are in (`root`): its own working
// copy, or the project workspace for a run without one.
function artifactPath(root: string, ref: RunRef, p: string): string {
  const abs = resolve(p)
  const exists = (f: string) => { try { readFileSync(f); return true } catch { return false } }
  if (isAbsolute(p) || exists(abs)) {
    const rel = relative(root, abs)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new RequestError(400, `${p} is outside the project${root.includes('/.local/wfe/runs/') ? ' (this run\'s files are in its own working copy)' : ''}`)
    return rel.split(sep).join('/')
  }
  if (!p.includes('/') && exists(resolve(root, runDir(ref), p))) return `${runDir(ref)}/${p}`
  return p
}

// A path given on the command line as project-relative: relative to the
// current directory when that is inside the project, otherwise as written.
function projectPath(root: string, p: string): string {
  const rel = relative(root, resolve(p))
  return !rel.startsWith('..') && !isAbsolute(rel) && (isAbsolute(p) || relative(root, process.cwd()) !== '') ? (rel.split(sep).join('/') || '.') : p
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
  const moves = Object.entries(e.change.nodes ?? {}).map(([n, [a, b]]) => a === null ? `${n} added as ${b} (recorded afterwards)` : `${n} ${a}→${b}`)
  if (e.change.execution) moves.push(`run ${e.change.execution[0] ?? '—'}→${e.change.execution[1]}`)
  const detail = (d.reason ?? d.outcome ?? d.text ?? d.evidence ?? d.external ?? d.note ?? '') as string
  return `  ${String(e.seq).padStart(3)} ${e.at}  ${e.op.padEnd(17)} ${e.by} (${e.via})${subject ? `  ${subject}` : ''}${moves.length ? `  [${moves.join(', ')}]` : ''}${detail ? `\n${' '.repeat(30)}${first(detail, 140)}` : ''}`
}

// A correction as the run's agent reads it (fix6).
export function correctionLines(k: Correction): string[] {
  return [`  ${k.id} ${k.addressed ? `addressed (${k.addressed.how}, seq ${k.addressed.seq})` : k.takenUp ? 'taken up, not addressed yet' : 'received, not addressed'} — from ${k.from}${k.by !== k.from ? ` (relayed by ${k.by})` : ''} at ${k.at}, returning the result completed at seq ${k.result.seq} (delegation ${k.delegation.uid}, request ${k.delegation.revision})`,
    `     why: ${first(k.reason, 400)}`, `     add: ${first(k.text, 600)}`, ...(k.takenUp?.note ? [`     note: ${first(k.takenUp.note, 300)}`] : [])]
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
  if (!r.revInfo) lines.push(`Status: ${runStatus(rec).text}`)
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
    else if (n.state === 'completed') what = `${n.retrospective ? `RECORDED AFTERWARDS by ${n.retrospective.by} at ${n.retrospective.at} (nothing ran it then: ${first(n.retrospective.reason, 80)}${n.retrospective.reported.started || n.retrospective.reported.ended ? `; reported work time ${n.retrospective.reported.started ?? '?'} – ${n.retrospective.reported.ended ?? '?'}` : ''}); ` : ''}outcome: ${first(n.outcome?.text ?? '', 120)}`
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
  // Shared areas (project_migration p6): what the input pointed at, the
  // input sets and the outputs, as this host reaches them now.
  const sh = r.shares
  if (rec.input.references?.length) lines.push('Shared references:', ...rec.input.references.map((x, k) => `  ${x.ref}  ${sh?.references[k]?.state ?? 'not checked'}`))
  if (rec.inputs) lines.push('Input sets:', ...Object.values(rec.inputs).map(x => `  ${x.id} ${x.ref}: ${x.count} files, ${humanBytes(x.bytes)}, ${x.digest.slice(0, 19)}…, ${x.staging}${x.last && x.last.status !== 'verified' ? ` — ${x.last.status}` : ''}`))
  if (rec.outputs) lines.push('Outputs:', ...Object.values(rec.outputs).map(x => `  ${x.id} ${x.candidate} "${x.title}": ${x.count} files, ${humanBytes(x.bytes)}, ${x.digest.slice(0, 19)}…${x.last && x.last.status !== 'verified' ? ` — ${x.last.status}` : ''}${sh?.outputs[x.id]?.url ? `  ${sh.outputs[x.id].url}` : ''}`))
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
    `  ${i.id} ${i.ack ? `acknowledged (${i.ack.response})` : 'received'} from ${i.from}${i.by !== i.from ? `, recorded by ${i.by}` : ''} via ${i.via} at ${i.at}${i.source ? ` (${sourceLabel(i.source)}${i.source.kind === 'zulip' ? ` in "${i.source.topic}"` : ''})` : ''}${i.during.length ? `; arrived while ${i.during.join(', ')} ran` : ''}: ${first(i.text, 400)}`,
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
  // Who records (p9). An executing attempt (WFE_ATTEMPT) records as the
  // run's agent, never in a person's name; the person's words it acted on
  // are named with --because (stop, resume, cancel) or --from (answer,
  // instruct). Outside an attempt, a run the execution host performs is
  // recorded only under a name given with --by: no default puts the agent's
  // name on someone else's act.
  // An executing attempt of *another* run (project_migration p8): an agent
  // operating this run from its own work — answering, instructing, stopping,
  // resuming, deciding — as a person does from the run view. It records as
  // its own run's agent, never as this run's, and its attempt is not this
  // run's fencing (the entry names it as `agent`).
  const foreignOf = async (r: RunRef): Promise<{ actor: string; run: string; attempt: string } | null> => {
    if (!attempt) return null
    let row: ReturnType<ExecStore['attemptRow']>
    try { row = c.exec().attemptRow(attempt) } catch { return null }
    if (!row || (row.workspace === ws.reg.id && row.workflow === r.workflow && row.run === r.run)) return null
    if (row.state === 'ended') throw c.refused(`attempt ${attempt} (of ${row.workspace} ${row.workflow}/${row.run}) has ended; an ended attempt records nothing`)
    const own = await wrap(async () => readRun(await c.exec().workspace(row.workspace), { workflow: row.workflow, run: row.run }))
    const actor = own.record?.executor.name
    if (!actor) throw c.refused(`the run of attempt ${attempt} (${row.workspace} ${row.workflow}/${row.run}) cannot be read`)
    return { actor, run: `${row.workspace}/${row.workflow}/${row.run}`, attempt }
  }
  // The attempt fencing and provenance a control act on `r` carries: this
  // run's own attempt, or the other run's attempt named as `agent`.
  const controlOf = async (r: RunRef) => {
    const f = await foreignOf(r)
    return f ? { operator: { run: f.run, attempt: f.attempt } } : { attempt }
  }
  const recorder = async (r: RunRef): Promise<string | undefined> => {
    const rec = (await wrap(() => readRun(ws, r))).record
    if (!rec) return by
    const foreign = await foreignOf(r)
    if (foreign) {
      if (by?.trim() && by.trim() !== foreign.actor) throw c.refused(`this process is attempt ${attempt} of ${foreign.actor} (${foreign.run}); it records as ${foreign.actor}, not as ${by.trim()}. Name whose words it acts on instead: --from <person> (answer, instruct), --because (stop, resume, cancel).`)
      return foreign.actor
    }
    if (attempt) {
      if (by?.trim() && by.trim() !== rec.executor.name) throw c.refused(`this process is attempt ${attempt} of ${rec.executor.name}; it records as ${rec.executor.name}, not as ${by.trim()}. Name the person's words instead: --because answer:<q>[:<n>] or instruction:<i> (stop, resume, cancel), --from <person> (answer, instruct).`)
      return rec.executor.name
    }
    if (!by?.trim() && rec.executor.host) throw c.refused(`who records this? Pass --by <your name>: run ${runKey(r)} is performed by ${rec.executor.name} on the execution host ${rec.executor.host}, and only its executing attempt records under that name.`)
    return by?.trim() || undefined
  }
  const because = (): BecauseRef | undefined => {
    const v = c.opt('because')
    if (!v) return undefined
    const m = /^(answer|instruction):([a-z0-9]+)(?::(\d+))?$/.exec(v)
    if (!m) throw c.usage('--because is answer:<question>[:<answer index>] or instruction:<instruction id>')
    return m[1] === 'answer' ? { kind: 'answer', question: m[2], ...(m[3] ? { answer: Number(m[3]) } : {}) } : { kind: 'instruction', instruction: m[2] }
  }
  // Where the person's words an answer or instruction carries were said
  // (project_migration p8): a conversation message, by reference.
  const sourceMessage = async (): Promise<{ source?: import('../shared/intake.ts').SourceRef }> => {
    const v = c.opt('source-message')
    if (!v) return {}
    const m = /^([a-z0-9][a-z0-9-]{0,47}):#?(\d+)$/.exec(v)
    if (!m) throw c.usage('--source-message is <conversation>:<message id>')
    const { ConversationStore } = await import('../server/conversations.ts')
    const store = new ConversationStore({ area: c.area() })
    try { return { source: await wrap(async () => store.source(m[1], Number(m[2]))) } } finally { store.close() }
  }
  const op = async (input: OpInput, what: (rec: RunRecord) => string, r?: RunRef, after?: (target: RunRef, rec: RunRecord) => Promise<string | null>, advised?: Advice) => {
    const target = r ?? await ref()
    const foreign = await foreignOf(target)
    const meta = { ...(attempt && !foreign && EXECUTOR_OPS.includes(input.op) ? { attempt } : {}), ...(receipt ? { receipt } : {}), ...(foreign ? { operator: { run: foreign.run, attempt: foreign.attempt } } : {}) }
    const who = await recorder(target)
    const res = await wrap(() => runOp(ws, target, { ...input, ...meta }, { by: who, via: 'cli', expectSeq, ...(advised ? { advice: advised } : {}) }))
    const extra = after ? await wrap(() => after(target, res.record)) : null
    return report(target, res.record, `${res.duplicate ? 'Already recorded (same receipt); nothing changed.' : what(res.record)}${extra ? `\n${extra}` : ''}`)
  }
  const node = () => { if (!args[1]) throw c.usage('<node> is required'); return args[1] }
  const rootOf = async (r: RunRef) => (await wrap(() => runSpace(ws, r))).root
  // This area's discussions, when they are configured (null otherwise).
  const discussions = async <T>(fn: (ds: import('../server/conversationService.ts').ConversationService) => Promise<T>): Promise<T | null> => {
    const { ConversationStore } = await import('../server/conversations.ts')
    const { ConversationService } = await import('../server/conversationService.ts')
    const cs = new ConversationStore({ area: c.area(), exec: c.exec() })
    try {
      const ds = new ConversationService(cs)
      return 'disabled' in ds.config() ? null : await fn(ds)
    } finally { cs.close() }
  }
  // Reminders at operation boundaries (workflow_editor fix5,
  // shared/reminders.ts): WFE evaluates them in the operation itself, under
  // the run's lock, and refuses with all of them at once; --yes continues
  // past them for this one command. What only this host can read is added
  // here: a conductor run completing while its discussion is open with no
  // conclusion (fix3: ponderer/conduct/run-020 completed its last ponder
  // node with wfe run complete; its discussion stayed open, concluded by
  // nobody).
  const advice = async (r: RunRef, what: string, o: { completing?: string } = {}): Promise<Advice> => {
    if (c.flag('yes')) return { yes: true }
    const extra: Reminder[] = []
    if (o.completing) {
      const { record } = await wrap(() => usableRun(ws, r))
      const others = Object.entries(record.nodes).filter(([id]) => id !== o.completing)
      // p18: a standing conductor's last node leaves it at rest, not ended: it
      // speaks again at the room's next words, so nothing is left unsaid.
      if (!record.standing && others.every(([, x]) => x.state === 'completed' || x.state === 'cancelled')) {
        const run = `${ws.reg.id}/${runKey(r)}`
        const open = await quietly(() => discussions(async ds => ds.conductedBy(run).filter(id => ds.conversation(id)?.state === 'open'
          && !ds.activityRows(id).some(a => a.run === run && a.kind === 'announce' && a.obligations !== null)))) ?? []
        if (open.length) extra.push({ code: 'discussion-open', refs: open, text: `This completes ${run}, which conducts ${open.join(', ')}: still open, and this run has announced no conclusion there. A completed run can no longer speak; the discussion would wait for the next message.`, repair: ['if it is finished, add a conclusion first: wfe discussion ponder --node <a ponder node> --next announce:<id>, then wfe discussion announce --node <id> --conclude [--close]', 'if it is not, say there what happens next'], summary: `${open.join(', ')} still open with no conclusion from this run → wfe discussion ponder … --next announce:<id>, then wfe discussion announce --conclude` })
      }
    }
    // fix6: the delegated results this run reports, when its completion completes the run.
    const assess = async (rec: RunRecord) => { const { delegatedReminders } = await import('../server/delegate.ts'); return delegatedReminders(c.exec().delegate, rec) }
    return { extra, what, assess }
  }

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
        : `${s.ref.padEnd(32)} ${String(s.execution).padEnd(12)} ${Object.entries(s.counts ?? {}).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')}  updated ${s.updated}${s.status && s.status.state !== 'done' ? `\n${' '.repeat(33)}${s.status.text}` : ''}${s.ready?.length ? `\n${' '.repeat(33)}ready: ${s.ready.join(', ')}` : ''}${s.waiting?.length ? `\n${' '.repeat(33)}waiting: ${s.waiting.map(w => `${w.node} (next move: ${w.holder})`).join(', ')}` : ''}${s.failed?.length ? `\n${' '.repeat(33)}failed: ${s.failed.join(', ')}` : ''}${s.decision ? `\n${' '.repeat(33)}decision: ${s.decision}` : ''}`).join('\n')
      c.out(human, { workspace: ws.reg.id, runs })
      return 0
    }
    case 'show': {
      const r = await ref()
      const resp = await wrap(() => runResponse(ws, r, { rev: c.opt('rev') }))
      c.out(describeRun(resp, { history: c.flag('history'), url: c.opt('rev') ? null : await link(runKey(r)) }), resp)
      return resp.record ? 0 : 1
    }
    case 'state': {
      const r = await ref()
      const resp = await wrap(() => runResponse(ws, r))
      if (!resp.record) throw c.refused(`run ${runKey(r)} cannot be used: ${resp.problem?.message}`)
      const raw = c.opt('since')
      const since = raw === undefined ? undefined : Number(raw)
      if (since !== undefined && (!Number.isInteger(since) || since < 0)) throw c.usage('--since is a record seq (0 or more)')
      const { describeState, pendingAnswers } = await import('../server/continuation.ts')
      const rec = resp.record
      c.out(describeState(rec, since), { ref: runKey(r), seq: rec.seq, execution: rec.execution, hold: rec.control.hold, pendingAnswers: pendingAnswers(rec).map(({ q, index }) => ({ question: q.id, answer: index, ...q.answers[index] })), pendingInstructions: Object.values(rec.instructions ?? {}).filter(i => !i.ack), since: since ?? null, entries: since === undefined ? [] : rec.history.filter(e => e.seq > since) })
      return 0
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
    case 'wait': {
      // --deadline (observer p3): an ISO time, or a duration from now (90s, 20m, 2h).
      const d = c.opt('deadline')
      const rel = d ? /^(\d+)(s|m|h)$/.exec(d) : null
      const deadline = d ? (rel ? new Date(Date.now() + Number(rel[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[rel[2] as 's' | 'm' | 'h']).toISOString() : d) : undefined
      return op({ op: 'node.wait', node: node(), reason: need(c, 'reason', 'why the node waits'), holder: need(c, 'holder', 'who or what holds the next move'), external: need(c, 'external', 'a reference to the awaited result'), ...(deadline ? { deadline } : {}) }, () => `Recorded: ${args[1]} waits${deadline ? ` (until ${deadline} at the latest)` : ''}.`)
    }
    case 'complete': {
      const r = await ref()
      const root = await rootOf(r)
      const artifacts = c.opts('artifact').map(p => artifactPath(root, r, p))
      const agreement = c.opt('agreement')
      return op({ op: 'node.complete', node: node(), outcome: need(c, 'outcome', 'what the node produced or concluded'), artifacts, ...(agreement ? { agreement } : {}) }, rec => {
        const d = rec.nodes[args[1]]?.document
        return `Recorded: ${args[1]} completed.${d ? ` Document ${d.path} checked (${d.bytes} bytes, sha256 ${d.sha256.slice(0, 12)}…).` : ''}${rec.nodes[args[1]]?.agreement ? ` Plan agreed in ${rec.nodes[args[1]].agreement!.question}.` : ''}`
      }, r, undefined, await advice(r, `completing ${node()}`, { completing: node() }))
    }
    case 'fail': return op({ op: 'node.fail', node: node(), reason: need(c, 'reason', 'what prevents continuation') }, () => `Recorded: ${args[1]} failed.`)
    case 'cancel':
      return args[1]
        ? op({ op: 'node.cancel', node: args[1], reason: need(c, 'reason', 'why it is discontinued') }, () => `Recorded: ${args[1]} cancelled.`)
        : (async () => {
          const r = await ref()
          const who = await recorder(r) ?? (await wrap(() => readRun(ws, r))).record?.executor.name ?? ''
          const ctl = await controlOf(r)
          const { record: rec, cleanup } = await wrap(() => c.exec().cancel(ws, r, who, need(c, 'reason', 'why the run is discontinued'), 'cli', { because: because(), ...ctl }))
          const bad = cleanup.filter(x => !x.ok)
          return report(r, rec, `Recorded: the run is cancelled. An executing attempt is terminated by the executor; nothing it reports afterwards is recorded.${cleanup.length ? `\nPresentations: ${cleanup.map(x => `${x.presentation} ${x.ok ? 'stopped' : `NOT STOPPED (${x.detail}); retry: wfe present stop ${runKey(r)} --all`}`).join('; ')}` : ''}${bad.length ? '' : ''}`)
        })()
    case 'stop': {
      const r = await ref()
      const who = await recorder(r) ?? (await wrap(() => readRun(ws, r))).record?.executor.name ?? ''
      const ctl = await controlOf(r)
      const rec = await wrap(() => c.exec().stop(ws, r, who, need(c, 'reason', 'why it stops'), 'cli', { because: because(), ...ctl }))
      return report(r, rec, rec.control.stop ? `Stop requested; attempt ${rec.control.attempt?.id} ends when the executor confirms its process is gone. The run then waits for a resume.` : 'Recorded: the run is stopped. Nothing resumes it until a person does (wfe run resume).')
    }
    case 'resume': {
      const r = await ref()
      const who = await recorder(r) ?? (await wrap(() => readRun(ws, r))).record?.executor.name ?? ''
      const profile = c.opt('profile')
      const { operator } = await controlOf(r) as { operator?: { run: string; attempt: string } }
      const res = await wrap(() => c.exec().resume(ws, r, who, need(c, 'reason', 'the resume instruction: what the executor should do now'), 'cli', receipt, { because: because(), ...(operator ? { operator } : {}), ...(profile ? { profile } : {}) }))
      return report(r, res.record, `Recorded: resumed${profile ? ` on profile ${profile}` : ''}.${res.job ? ` Queued job ${res.job.id} (${res.job.state}).` : ''}`)
    }
    case 'assign': {
      const r = await ref()
      const who = await recorder(r) ?? ''
      if (!who) throw c.refused('who assigns the run? Pass --by <your name>')
      const node = need(c, 'node', 'the execution node (worker) that performs the run from its next attempt')
      const rec = await wrap(() => c.exec().assign(ws, r, node, who, need(c, 'reason', 'why the run moves'), 'cli'))
      return report(r, rec, `Recorded: from its next attempt the run is performed by ${node}. Its queued job, if any, waits for ${node}.`)
    }
    case 'session': {
      const r = await ref()
      if (c.flag('retire')) {
        const who = await recorder(r) ?? ''
        if (!who) throw c.refused('who retires the session? Pass --by <your name>')
        const rec = await wrap(() => c.exec().retireSession(ws, r, who, need(c, 'reason', 'why the current session ends'), 'cli', { because: because() }))
        return report(r, rec, 'Recorded: the current session is retired; the next attempt starts a new one.')
      }
      const space = await wrap(() => runSpace(ws, r))
      const rec = (await wrap(() => readRun(space, r))).record
      if (!rec) throw c.refused(`run ${runKey(r)} cannot be read`)
      const reading = await wrap(() => readRun(space, r))
      const policy = sessionPolicyOf(reading.bundle.entries[rec.definition.root]?.workflow?.execution)
      const lines = [`Session policy: ${policy} (frozen with the run's definition)`]
      for (const x of rec.sessions ?? []) {
        lines.push(`- ${x.id ?? '(id not reported)'} [${x.state}] since ${x.began} (attempt ${x.attempt}); attempts ${x.attempts.join(', ') || '(none)'}; ${x.config.profile ?? 'host default profile'} / ${x.config.backend ?? 'unknown backend'}${x.attached ? `; harness reported ${x.attached}${x.mismatch ? ' (DIFFERS from the intended id)' : ''}` : ''}${x.ended ? `; ended ${x.ended.at} by ${x.ended.by}: ${x.ended.reason}` : ''}`)
      }
      if (!rec.sessions?.length) lines.push('No session recorded yet.')
      c.out(lines.join('\n'), { policy, sessions: rec.sessions ?? [] })
      return 0
    }
    case 'recover': {
      const r = await ref()
      const expect = c.opt('expect-seq')
      const res = await wrap(() => c.exec().recover(ws, r, {
        incident: need(c, 'incident', 'the incident this recovery answers'), attempt: need(c, 'attempt', 'the ended attempt whose hold is lifted'),
        reason: need(c, 'reason', 'why continuing is right (what was investigated)'), by: by ?? undefined, recoveryAttempt: c.opt('recovery-attempt') ?? process.env.WFE_ATTEMPT ?? undefined,
        expectSeq: expect !== undefined ? Number(expect) : undefined, via: 'cli',
      }))
      return report(r, res.record, res.duplicate ? 'Already recorded (same incident and attempt); nothing changed.' : `Recorded: continued by recovery (${res.record.recoveries?.at(-1)?.by}).${res.job ? ` Queued job ${res.job.id} (${res.job.state}).` : ''}`)
    }
    case 'ask': {
      const r = await ref()
      const root = await rootOf(r)
      return op({ op: 'question.ask', question: c.opt('id') ?? '', node: args[1], text: need(c, 'question', 'the question'), to: need(c, 'to', 'to whom it is addressed'), ...(c.flag('about-plan') ? { plan: true } : {}), ...(c.opts('subject').length ? { subjects: c.opts('subject').map(p => projectPath(root, p)) } : {}), ...(c.opt('presentation') ? { presentation: c.opt('presentation') } : {}), ...(c.opt('output') ? { output: c.opt('output') } : {}), ...(c.opt('about-adjustment') ? { adjustment: c.opt('about-adjustment') } : {}) },
        rec => { const q = Object.values(rec.questions).at(-1)!; return `Recorded question ${q.id} to ${q.to}${q.node ? `; ${q.node} waits on it` : ''}.` }, r,
        // A run that speaks for a discussion has its question posted there
        // (workflow_editor fix3); the reconcile posts what this could not.
        async target => {
          try {
            const notes = await discussions(ds => ds.postQuestions({ run: `${ws.reg.id}/${runKey(target)}` })) ?? []
            return notes.length ? notes.map(n => n.replace(/^discussion /, 'Posted in discussion ')).join('\n') : null
          } catch (e) { return `Not posted in its discussion yet (${(e as Error).message}); the executor's reconcile posts it.` }
        }, await advice(r, `asking ${c.opt('to') ?? ''}`.trim()))
    }
    case 'answer': {
      if (!args[1]) throw c.usage('<question> is required')
      return op({ op: 'question.answer', question: args[1], text: need(c, 'answer', 'the answer text'), from: c.opt('from'), ...await sourceMessage() }, () => `Recorded an answer to ${args[1]}. A node waiting on it keeps waiting until the answer is taken up.`, undefined,
        async (t, rec) => { if (hostOf(rec.executor) !== c.exec().executor) return null; const j = await c.exec().afterAnswer(ws, t, args[1]); return j ? `The executor resumes the run (job ${j.id}, ${j.state}).` : 'The run is not resumed automatically now (held, executing, or not waiting on this question).' })
    }
    case 'take-up': {
      if (!args[1]) throw c.usage('<question> is required')
      const index = c.opt('index') !== undefined ? Number(c.opt('index')) : undefined
      // An answer about a presentation (fix5): what it means for the page.
      return op({ op: 'question.take-up', question: args[1], answer: index }, rec => `Recorded: the answer to ${args[1]} is taken up.${(n => n ? `\nReminder: ${n}` : '')(answerReminder(rec, args[1]))}`)
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
      return op({ op: 'instruction.receive', text: need(c, 'instruction', 'the instruction'), from, ...await sourceMessage() }, rec => `Recorded instruction ${Object.keys(rec.instructions ?? {}).at(-1)}; ${rec.executor.name} reads it at the next node boundary.`, undefined,
        async (t, rec) => {
          const id = Object.keys(rec.instructions ?? {}).at(-1)
          const job = id ? await c.exec().afterInstruction(ws, t, id) : null
          if (job) return `Nobody was executing the run: queued job ${job.id} (${job.state}) so it reads the instruction now.`
          if (rec.execution.state === 'completed' && !rec.control.attempt) return 'The run is completed: nothing executes it for this instruction. New work for it is a new request naming it as --predecessor.'
          return rec.control.hold ? `The run is held (${rec.control.hold.kind}); it reads the instruction when resumed.` : null
        })
    }
    case 'ack': {
      const ids = args.slice(1)
      if (!ids.length) throw c.usage('<instruction>... is required (i1 i2 …)')
      return op({ op: 'instruction.ack', instructions: ids, response: need(c, 'response', 'incorporate, clarify or new-run'), note: need(c, 'note', 'what you will do about it') }, () => `Recorded: ${ids.join(', ')} acknowledged.`)
    }
    case 'correction': {
      const id = args[1]
      if (!id) {
        const r = await ref()
        const { record } = await wrap(() => usableRun(ws, r))
        const all = Object.values(record.corrections ?? {})
        c.out(all.length ? all.flatMap(correctionLines).join('\n') : 'No corrections were received.', { ref: runKey(r), corrections: all })
        return 0
      }
      const noChange = c.flag('no-change')
      return op({ op: 'correction.take-up', correction: id, note: noChange ? need(c, 'note', 'why nothing needs to change') : c.opt('note') ?? '', ...(noChange ? { noChange: true } : {}) }, (rec) => noChange
        ? `Recorded: correction ${id} needs no change (${rec.execution.state === 'completed' ? 'the run is completed again; the delegating run is told' : `the run is ${rec.execution.state}`}).`
        : `Taken up: correction ${id}. Add the missing work as new nodes (wfe run adjust; wfe nodes instantiate <template> --run ${runKey(rec)} …) and perform it; that addresses it.`)
    }
    case 'io': {
      const r = await ref()
      const { ioEntries } = await import('../server/ioview.ts')
      const line = c.opt('line') !== undefined ? Number(c.opt('line')) : undefined
      const v = await wrap(() => ioEntries(c.area(), c.exec(), ws, r, c.opt('attempt'), line))
      const io = v.io
      const head = !io || io.state === 'disabled' ? 'Detailed IO: not enabled for this run (zulip.json io, runs created since its since).' : `Detailed IO: ${io.state}${io.url ? ` — ${io.url}` : ''}${io.problem ? ` (${io.problem})` : ''}`
      const attempts = (io?.attempts ?? []).map(a => `  ${a.attempt}: relayed through log line ${a.line}${a.ended ? ', ended' : ''}${a.gap ? `, GAP (${a.gap})` : ''}`)
      const entries = v.entries.flatMap(e => [`--- line ${e.line} ${e.kind}${e.head ? `: ${e.head}` : ''}`, ...(e.body !== undefined ? [e.body] : [])])
      c.out([head, ...attempts, ...entries].join('\n'), v)
      return 0
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
      const root = await rootOf(r)
      const answers = args.slice(1).map(p => accessAt(def.repositories, projectPath(root, p), dir))
      const scopes = Object.entries(def.repositories).map(([k, b]) => `  ${k.padEnd(16)} ${(normalizeRepoPath(b.path) ?? b.path).padEnd(28)} ${b.access}`)
      c.out(answers.length
        ? answers.map(a => `${a.path}: ${a.access} — ${a.reason}`).join('\n')
        : [`Scopes of ${runKey(r)} (most specific wins):`, ...scopes, `  ${'(records)'.padEnd(16)} ${dir.padEnd(28)} report — this run's own folder`].join('\n'),
      { ref: runKey(r), bindings: def.repositories, records: dir, answers })
      return 0
    }
    case 'input': {
      const r = await ref()
      const nodeId = node()
      const stage = c.opt('stage') ?? 'copy'
      if (stage !== 'copy' && stage !== 'in-place') throw c.usage('--stage is copy or in-place')
      const { selectInput, setShareArea } = await import('../server/shares.ts')
      setShareArea(c.area())
      const res = await wrap(async () => selectInput(ws, r, { node: nodeId, ref: need(c, 'ref', 'the shared:// reference'), staging: stage }, { by: await recorder(r), via: 'cli', expectSeq, attempt, receipt }))
      const set = res.record.inputs![res.input]
      return report(r, res.record, res.duplicate ? `Already recorded (same receipt): input set ${res.input}.` : `Selected input set ${set.id} from ${set.ref}: ${set.count} files, ${humanBytes(set.bytes)}, ${set.digest.slice(0, 19)}…, ${set.staging === 'copy' ? `staged in .local/inputs/${set.id}/` : 'read in place'}. Manifest: ${set.file}`)
    }
    case 'inputs':
    case 'outputs': {
      const r = await ref()
      const m = await import('../server/shares.ts')
      m.setShareArea(c.area())
      const verifyId = c.opt('verify')
      const ids = c.flag('verify-all') ? Object.keys((await wrap(() => readRun(ws, r))).record?.inputs ?? {}) : verifyId ? [verifyId] : []
      const checks: { id: string; status: string; detail: string }[] = []
      for (const id of ids) {
        const res = await wrap(async () => sub === 'inputs' ? m.verifyInput(ws, r, id, { by: await recorder(r), via: 'cli', quick: c.flag('quick') }) : m.verifyOutput(ws, r, id, { by: await recorder(r), via: 'cli', quick: c.flag('quick') }))
        checks.push({ id, status: res.status, detail: res.detail })
      }
      const rec = (await wrap(() => readRun(ws, r))).record
      if (!rec) throw c.refused(`run ${runKey(r)} cannot be read`)
      const avail = await m.availability(rec)
      const lines: string[] = []
      if (sub === 'inputs') {
        lines.push(`References in ${rec.input.file}: ${avail.references.length ? '' : 'none'}`)
        for (const a of avail.references) lines.push(`  ${a.ref}  ${a.state}${a.url ? `  ${a.url}` : ''}`)
        lines.push(`Input sets: ${Object.keys(rec.inputs ?? {}).length ? '' : 'none'}`)
        for (const i of Object.values(rec.inputs ?? {})) {
          const where = await m.inputLocation(ws, r, i.id).catch(() => null)
          lines.push(`  ${i.id} ${i.ref} (${i.node}): ${i.count} files, ${humanBytes(i.bytes)}, ${i.digest.slice(0, 19)}…, ${i.staging}; last check ${i.last ? `${i.last.status} at ${i.last.at}: ${i.last.detail}` : 'none'}${where ? `\n     here: ${where}` : `\n     here: not reachable (${avail.inputs[i.id]?.state})`}`)
        }
      } else {
        lines.push(`Outputs: ${Object.keys(rec.outputs ?? {}).length ? '' : 'none'}`)
        for (const o of Object.values(rec.outputs ?? {})) {
          lines.push(`  ${o.id} "${o.title}" candidate ${o.candidate} (${o.node}): ${o.count} files, ${humanBytes(o.bytes)}, ${o.digest.slice(0, 19)}…; last check ${o.last ? `${o.last.status} at ${o.last.at}: ${o.last.detail}` : 'none'}`)
          lines.push(`     ${o.ref}  ${avail.outputs[o.id]?.state}${avail.outputs[o.id]?.url ? `  ${avail.outputs[o.id].url}` : ''}`)
        }
      }
      for (const x of checks) lines.push(`Checked ${x.id}: ${x.status} — ${x.detail}`)
      c.out(lines.join('\n'), { ref: runKey(r), references: rec.input.references ?? [], inputs: rec.inputs ?? {}, outputs: rec.outputs ?? {}, availability: avail, checks })
      return checks.some(x => x.status !== 'verified') ? 1 : 0
    }
    case 'publish': {
      const r = await ref()
      const nodeId = node()
      const m = await import('../server/shares.ts')
      m.setShareArea(c.area())
      const rec = (await wrap(() => readRun(ws, r))).record
      const share = c.opt('share') ?? (rec?.inputs ? Object.values(rec.inputs)[0]?.ref.slice('shared://'.length).split('/')[0] : undefined)
      if (!share) throw c.usage('--share is required: the run has no input set to take it from')
      const root = await rootOf(r)
      const source = projectPath(root, need(c, 'source', 'the folder to publish'))
      const res = await wrap(async () => m.publishOutput(ws, r, { node: nodeId, source, title: need(c, 'title', 'what the output is'), candidate: need(c, 'candidate', 'the approach or variant it belongs to'), share, ...(c.opts('input').length ? { inputs: c.opts('input') } : {}) }, { by: await recorder(r), via: 'cli', expectSeq, attempt, receipt }))
      const o = res.record.outputs![res.output]
      const url = (await m.availability(res.record)).outputs[o.id]?.url
      return report(r, res.record, res.duplicate ? `Already recorded (same receipt): output ${res.output}.` : `Published output ${o.id} (${o.candidate}): ${o.count} files, ${humanBytes(o.bytes)}, ${o.digest.slice(0, 19)}… at ${o.ref}${url ? `\nDownload: ${url}` : ''}\nManifest: ${o.file}. Ask about it: wfe run ask ${runKey(r)} <confirming node> --output ${o.id} …`)
    }
    case 'attach': {
      const r = await ref()
      if (!args[1]) throw c.usage('<path> is required')
      const path = artifactPath(await rootOf(r), r, args[1])
      return op({ op: 'artifact.attach', path, node: c.opt('node'), title: c.opt('title') }, () => `Recorded artifact ${path}.`, r)
    }
    case 'adjust': {
      const r = await ref()
      const text = readInput(c, need(c, 'definition', 'the adjusted definition file (- for standard input)'))
      const src = c.opt('source') ?? 'agent'
      const m = /^(answer|instruction|agreement):([a-z0-9]+)(?::(\d+))?$/.exec(src)
      const source = src === 'agent' ? { kind: 'agent' as const } : src === 'request' ? { kind: 'request' as const } : src === 'person' ? { kind: 'person' as const, ...(by ? { by } : {}) } : m?.[1] === 'answer' ? { kind: 'answer' as const, question: m[2], ...(m[3] ? { answer: Number(m[3]) } : {}) } : m?.[1] === 'instruction' ? { kind: 'instruction' as const, instruction: m[2] } : m?.[1] === 'agreement' ? { kind: 'agreement' as const, question: m[2] } : null
      if (!source) throw c.usage(`--source "${src}" must be agent, request, answer:<q>[:<n>], instruction:<i>, agreement:<q> or person`)
      const completingNode = c.opt('completing')
      const root = await rootOf(r)
      const completing = completingNode ? { node: completingNode, outcome: need(c, 'outcome', `what ${completingNode} produced or concluded`), artifacts: c.opts('artifact').map(p => artifactPath(root, r, p)) } : undefined
      if (!completing && c.opt('outcome')) throw c.usage('--outcome goes with --completing <node>')
      // The completion that goes with it is evaluated on the revised graph.
      const advised = completing && !c.flag('dry-run') ? await advice(r, `adjusting and completing ${completing.node}`) : undefined
      const res = await wrap(() => adjustRun(ws, r, { text, reason: need(c, 'reason', 'why the run changes'), source, dryRun: c.flag('dry-run'), propose: c.opt('propose'), expectRevision: c.opt('expect-revision'), completing }, { by, via: 'cli', expectSeq, attempt, receipt, ...(advised ? { advice: advised } : {}) }))
      // A revision made from a discussion turn is recorded there (argue p4
      // ex3), from the run's own history, under the revision's id.
      if (res.ok && res.revision && !res.dryRun && attempt) {
        const ev = await discussionTurn(c.exec(), c.area())
        if (ev) { await quietly(() => ev.wfs.deriveRun(ev.turn.conv, `${ws.reg.id}/${r.workflow}/${r.run}`)); ev.close() }
      }
      c.out(adjustText(res, runKey(r)), res)
      return res.ok ? 0 : 1
    }
    case 'record-done': {
      const r = await ref()
      const root = await rootOf(r)
      const commits = c.opts('commit-id').map(v => { const [commit, repository] = v.split('@'); return { commit, ...(repository ? { repository } : {}) } })
      const entries = c.opts('entry').map(v => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw c.usage('--entry takes a history seq'); return n })
      const started = c.opt('started-at'), ended = c.opt('ended-at')
      const res = await wrap(async () => recordDone(ws, r, {
        node: c.opt('id'), template: c.opt('template'), type: c.opt('type'), name: c.opt('name'), description: c.opt('description'),
        after: c.opts('after'), before: c.opts('before'), outcome: need(c, 'outcome', 'what the work produced or concluded'), reason: need(c, 'reason', 'why it is recorded afterwards'),
        artifacts: c.opts('artifact').map(p => artifactPath(root, r, p)), commits, entries, questions: c.opts('question'), outputs: c.opts('output'), presentation: c.opt('presentation'),
        ...(started || ended ? { reported: { started, ended } } : {}), expectRevision: c.opt('expect-revision'),
      }, { by: await recorder(r), via: 'cli', expectSeq, attempt, receipt }))
      const n = res.record.nodes[res.node]
      return report(r, res.record, res.duplicate ? `Already recorded (same receipt): ${res.node} in ${res.revision}; nothing written again.` : `Recorded afterwards: ${res.node} is completed in ${res.revision} (nothing was run). Evidence: ${n.retrospective?.evidence.map(e => e.kind === 'artifact' ? e.path : e.kind === 'commit' ? `commit ${e.commit.slice(0, 10)}` : e.kind === 'entry' ? `entry ${e.seq} (${e.op})` : `${e.kind} ${e.id}`).join(', ') || 'none named'}.`)
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
      const original = await readFile(join(await rootOf(r), runDir(r), 'definition', `${rec.definition.root}.yaml`), 'utf8').catch(() => null) // in the run's own copy (p9)
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
    case 'reversal': {
      const r = await ref()
      const { reversalFacts } = await import('../server/reversal.ts')
      const f = await wrap(() => reversalFacts(ws, r))
      const lines = [f.summary]
      if (f.saved) lines.push(`Saved: branch ${f.saved.branch} (${f.saved.repositories.map(x => `${x.path === '.' ? 'root' : x.path} ${x.head?.slice(0, 10) ?? '?'}`).join(', ')})${f.copy ? `; copy ${f.copy}` : ''}`)
      for (const i of f.integrations) {
        lines.push(`Integration of decision ${i.decision} (${i.at}, ${i.by}):`)
        for (const x of i.repositories) lines.push(`  ${(x.path === '.' ? 'root' : x.path).padEnd(16)} ${x.target}: ${x.before.slice(0, 10)} → ${x.after.slice(0, 10)} (${x.method}; ${x.commits.length} commit${x.commits.length === 1 ? '' : 's'}; ${x.files.length} file${x.files.length === 1 ? '' : 's'}${x.later === null ? '' : `; ${x.later} later`})`)
      }
      lines.push('Steps:', ...f.steps.map(x => `  - ${x}`), 'Outside Git:', ...f.external.map(x => `  - ${x}`))
      c.out(lines.join('\n'), f)
      return 0
    }
    case 'integrate': {
      const r = await ref()
      const x = c.exec()
      const lines = (steps: { repo: string; target: string; state: string; method?: string; observed?: string; candidate?: string; result?: string; pushed?: boolean; files?: string[]; error?: string }[]) => steps.map(s => `  ${(s.repo === '.' ? 'root' : s.repo).padEnd(16)} → ${s.target.padEnd(10)} ${s.state}${s.method ? ` (${s.method})` : ''}${s.candidate ? ` candidate ${s.candidate.slice(0, 10)}` : ''}${s.observed ? ` onto ${s.observed.slice(0, 10)}` : ''}${s.result ? ` = ${s.result.slice(0, 10)}${s.pushed ? ' pushed' : s.state === 'planned' ? '' : ' not pushed'}` : ''}${s.error ? `\n      ${s.error}` : ''}`)
      if (c.flag('status')) {
        // The current standing first, from the latest decision and run.json
        // (project_migration p3/ex1: the oldest row was read as the status);
        // then the journal, newest first, each row said for its own decision.
        const rows = x.integrations(ws.reg.id, r).map(i => ({ ...i, steps: JSON.parse(i.steps) as Parameters<typeof lines>[0] }))
        const space = await wrap(() => runSpace(ws, r))
        const rec = (await wrap(() => readRun(space, r))).record
        const st = rec ? integrationStatus(rec, { integrations: rows }, space.copyOf ? { kind: 'run-copy', branch: rec.storage?.branch ?? null } : { kind: 'project' }) : null
        const latest = (rec?.decisions.length ?? 0) - 1
        const head = !rec ? `Run ${runKey(r)} cannot be read; the journal follows.` : st ? `Now: ${st.text}${latest >= 0 ? ` (decision ${latest}, ${rec.decisions[latest].decision} by ${rec.decisions[latest].by})` : ''}${st.detail ? ` — ${st.detail}` : ''}${st.changed?.length ? `\n  ${st.state === 'target-changed' ? 'changed on the target since this run built on it' : 'changed since the acceptance'}: ${st.changed.join(', ')}` : ''}` : `Run ${runKey(r)} has no working copy of its own: what it published is already on the project's branches.`
        const journal = rows.slice().reverse().flatMap(i => [`Integration ${i.id} requested at history seq ${i.decision}: ${i.state} (${i.updated}, requested by ${i.requested_by})${i.error ? ` — ${i.error}` : ''}`, ...lines(i.steps)])
        c.out([head, ...(journal.length ? ['', 'Journal (newest first):', ...journal] : [`Run ${runKey(r)} has no integration.`])].join('\n'), { ref: runKey(r), status: st, latestDecision: latest, integrations: rows })
        return 0
      }
      if (!c.flag('dry-run') && !by?.trim()) throw c.usage('--by is required: who integrates the result')
      const res = await wrap(() => x.integrateRun(ws, r, { by: by?.trim() || 'dry run', via: 'cli', dryRun: c.flag('dry-run') }))
      c.out([`${c.flag('dry-run') ? 'Plan' : 'Integration'} of ${runKey(r)}: ${res.state}${res.error ? ` — ${res.error}` : ''}`, ...lines(res.steps)].join('\n'), { ok: res.state === 'integrated' || res.state === 'planned', ref: runKey(r), ...res })
      return res.state === 'integrated' || res.state === 'planned' ? 0 : 1
    }
    case 'decide': {
      const decision = need(c, 'decision', 'accepted or rejected')
      if (decision !== 'accepted' && decision !== 'rejected') throw c.usage('--decision is accepted or rejected')
      const question = c.opt('question')
      if (question) {
        // Recorded by the executing attempt; its end publishes it.
        const index = c.opt('index') !== undefined ? Number(c.opt('index')) : undefined
        const target = await ref()
        const meta = { ...await controlOf(target), ...(receipt ? { receipt } : {}) }
        const res = await wrap(async () => runOp(ws, target, { op: 'run.decide', decision, question, answer: index, note: c.opt('note'), ...meta }, { by: await recorder(target), via: 'cli', expectSeq }))
        const d = res.record.decisions.at(-1)!
        return report(target, res.record, res.duplicate ? 'Already recorded (same receipt); nothing changed.' : `Recorded: result ${decision}, from ${d.confirmation?.from}'s answer to ${question} (${d.evidence}). Execution is ${res.record.execution.state}; the two are separate records.`)
      }
      if (!by?.trim() && !(await foreignOf(await ref()))) throw c.usage('--by is required: who decides (an agent operating this run from its own attempt records as itself)')
      return op({ op: 'run.decide', decision, evidence: need(c, 'evidence', 'what the decision rests on'), note: c.opt('note') }, () => `Recorded: ${decision} by ${by}.`, undefined,
        async (t, rec) => { if (hostOf(rec.executor) !== c.exec().executor) return null; const cp = await c.exec().afterDecision(ws, t, decision); return `Publication checkpoint ${cp.id}: ${cp.state}${cp.error ? ` — ${cp.error}` : ''}` })
    }
  }
  return 2
}
