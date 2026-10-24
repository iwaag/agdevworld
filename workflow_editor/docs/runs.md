# Workflow run contract (`ag.workflow-run.v2`, p3/pre1, p4, p5)

A **run** is one execution of a workflow: the input it was given, the fixed
definition it follows, and a record of what the executor reported. It lives in
devdocs beside the definitions and is version-controlled like them. The
definition contract (`ag.workflow.v1`, approvals, validation) is in
[contract.md](contract.md).

A run record is an operational record. It says what the executor and the
people involved recorded, in order. It is not authenticated or tamper-proof
evidence, and `running` means "the executor reported that work started", not
"a process is alive".

**Every operation holds the run's lock** (p4, `server/lock.ts`): the read,
the `--expect-seq` check, the transition and the atomic replacement of
`run.json` happen under a cross-process lock, so the CLI, the service and the
executor never lose each other's records. `--expect-seq` still refuses an
operation based on an outdated view; the lock does not replace it. A
retransmitted operation with the same `receipt` is not recorded twice.
`run.json` is changed only through these operations; external edits of it are
not a safe concurrent route (definitions and Markdown stay editable by hand,
writers taking turns per file).

## Where things live

**A run the execution host performs lives in its own working copy (p9,
[storage.md](storage.md)).** The tree below is inside that copy
(`<project workspace>/.local/wfe/runs/<workflow>/<run>/tree/`), on the run's
branch `wfe/<project>/<workflow>/<run>`. The project workspace holds runs
recorded before p9 that were not migrated, and runs an IDE agent creates
there with `wfe run create`. Every operation resolves the place first
(`runSpace`). A run's folder that reaches the project's shared branch (an
integration) is a snapshot; the copy's `run.json` stays the live record.

```text
devdocs/runs/<workflow-id>/<run-id>/
  braindump.md          the person's own input (or request.md, see Input)
  plan.md               the agreed plan (default policy: the _plan step's document)
  report-<node>.md      a report per authored node (default policy)
  report.md             the final report (default policy)
  run.json              the record: current state and its history
  context/
    node-catalog.json   the person's node catalog as the run was given it (p7/ex1, catalog.md)
  definition/
    <workflow-id>.yaml  the run's workflow, copied byte for byte
  …                     anything else the executor writes (manual policy: names are its choice)
```

The p3 layout (`devdocs/<workflow-id>/runs/<run-id>/`) and
`ag.workflow-run.v1` records are not read or converted. A project that still
has p3 run folders gets a `runs-old-layout` diagnostic; a v1 `run.json` in the
new layout is shown as an unsupported schema, never as an empty listing.

| Information | Authority |
| --- | --- |
| The person's words | `braindump.md` |
| A request an agent constructed | `request.md` (+ `original-input.md` when given) |
| How the work is approached | `plan.md` and reports — prose; the tools never parse it |
| The executed definitions | `definition/*.yaml`, fixed for the run's lifetime |
| Node states, questions, answers, relations, artifact references, acceptance, history | `run.json` |
| Current editable definitions | `devdocs/workflows/*.yaml` (not the run's) |

Every path in these files is project-relative POSIX or run-relative. Machine
paths, credentials and local process details stay out; local execution
settings belong under ignored `.local/` paths.

Saving a file never commits. The saved files are the current work record
before any publication. A browser view follows saved files before any commit.

A history view (`/at/<ref>`, `wfe run show --rev <ref>`, `?rev=` on the HTTP
run and file endpoints) reads the run from a commit of the repository that
owns devdocs, resolved by `server/devdocs.ts` ([contract.md](contract.md),
*devdocs storage modes*): `<commit>` of that repository, or `root:<commit>`,
a project root commit whose devdocs gitlink is followed in submodule mode.
The view names the owning repository, the commit and, when followed, the root
commit. Report and input files come from that same commit. Missing historical
files never fall back to the working tree. Artifacts outside devdocs cannot
be read from a devdocs commit; use the current run to read them.

### Identifiers

| Identifier | Pattern | Notes |
| --- | --- | --- |
| Workflow id, node id | `^[a-z0-9][a-z0-9_.-]{0,63}$` | from the definition contract |
| Run id (= directory name) | `^run-[a-z0-9][a-z0-9_.-]{0,59}$` | `run-001`, `run-002`, … by default (next number after the highest `run-NNN`), or `run-<name>` |
| Run reference | `<workflow-id>/<run-id>` | unique in a project; two invocations of one workflow have two run ids |
| Run identity | project id + workflow id + run id | `run.json` names its `project`; a record naming another project is a `location` problem. Machine paths are never identifiers |
| Question id | `^q[0-9]{1,6}$` | `q1`, `q2`, … in order of asking, per run |
| History sequence | integer, 1, 2, 3, … | strictly increasing, no gaps |

Timestamps are ISO 8601 UTC with milliseconds (`2026-10-10T12:34:56.789Z`,
JavaScript `toISOString()`). They come from the writer's clock and are
display facts only: nothing expires, fails or completes because of a time.

**Creating a run never overwrites.** The run directory is created exclusively;
an existing name is refused ("run-001 already exists") and nothing in it is
changed. A name that does not match the pattern is refused before anything
is written.

## Input

| Kind | File | Who wrote the words | Required facts |
| --- | --- | --- | --- |
| `braindump` | `braindump.md` | the person | `author` (the person's name) |
| `request` | `request.md` | an agent, on someone's behalf | `requester` (the agent), `entrustedBy` (reference), optional `onBehalfOf` |

`braindump.md` holds the person's own words. An agent that saves them is
recorded as `recordedBy`; that does not make them an agent's request. An agent
that writes its own request — rewording a person's input, or delegating — uses
`request.md` and records the reference to what entrusted it: a run and node
(`{kind: "run", workflow, run, node}`), a project file (`{kind: "file",
path}`), or a free reference such as a conversation (`{kind: "note", text}`).
An entrance for requests from external agents is not part of p4.
A braindump posted in a Zulip request topic (p6, [intake.md](intake.md))
records where it came from as `input.source` (realm, message, channel,
topic, sender, time), and `run.create` carries the post's receipt
`zulip:<realm>:<message id>`: the same post never creates a second run.
When a derived request was built from a person's input, `--original <file>`
keeps that input beside it as `original-input.md`. No tool writes a human
author it was not given.

## Definition snapshot

At creation the workflow is read from `devdocs/workflows/`, validated with the
editor's rules (errors refuse the run; warnings are kept as facts), and copied
byte for byte to `definition/<id>.yaml`. The copy keeps layout, approvals and
comments.

**Delegate nodes execute (p10).** A delegate node's work is entrusted to a
run of another managed workflow — its `project`/`workflow` target — through
`wfe delegate`: the parent records the dispatch, the child is an ordinary
request run of the target workflow, and the parent completes the node only
after judging the child's result. The relationship, its operations and who
decides what are [delegation.md](delegation.md). (Until p10 a workflow with a
delegate node was refused: `delegate-unsupported`.)

`run.json` records, per bundled workflow: the bundle file, the source file it
was copied from, `sha256` of the copied bytes, the semantic definition digest
(`definitionDigest`, the same projection as definition approval), and the
approval states at that moment. The byte digest is what reading checks: a
bundle file that is missing or differs from its recorded `sha256` makes the
record **inconsistent**.

The bundle never changes. Later edits, renames or deletion of the source
workflow do not change the run's graph. The run view shows the snapshot and
compares it with the current source (same definition, changed, renamed,
deleted). A run on a changed definition is a new run (`--predecessor
<run-ref>` records the link).

**The effective graph is frozen (p5).** At creation the root workflow is
compiled with its documentation policy (`shared/compile.ts`) and the result
is recorded as `definition.effective` — compiler version, policy, nodes
(generated steps with their purpose, document and instructions) and edges —
in `run.create` and the state. Readiness, replay and every operation follow
that graph. Reading checks it against the bundle: same policy, same authored
nodes, edges between known nodes, and — when the recorded compiler is the
current one — exactly what it compiles to; a disagreement makes the record
unusable (`bundle`), never silently recompiled. A graph frozen by another
compiler version is followed as recorded. A record without
`definition.effective` was created before p5 and follows its authored graph
(no generated steps); nothing converts it. A workflow the compiler refuses
(no nodes, broken edges, an unknown policy) is refused at creation (422)
before anything is written.

Definition approval stays a statement about a definition. Its state is
recorded and shown; it is not a gate, not permission to execute and not
acceptance of a result.

**The person's node catalog (p7/ex1).** Every entrance freezes the
operating area's node catalog into `context/node-catalog.json` and records
`context.catalog` (`supplied` with file, sha256, generation and count; or
`unavailable` with the problem). An empty catalog is an explicit empty
snapshot. Reading checks the file by hash, like the bundle. Each attempt is
given this snapshot in its brief and records it in `attempt.begin`'s
`settings.catalog`; a later catalog edit reaches new runs only. The input's
`sha256` is recorded with it (what a request-sourced adjustment binds to).
See [catalog.md](catalog.md).

Repository context: at creation the record keeps, for the project root and
each repository the bundled workflows bind, the checked-out commit, the branch
and the number of uncommitted entries. That is context. It does not snapshot
repository contents, and a commit hash does not include uncommitted files.

## `run.json`

```json
{
  "schema": "ag.workflow-run.v1",
  "project": "rts-vs-bot",
  "workflow": "build-game",
  "run": "run-001",
  "created": "2026-10-10T12:00:00.000Z",
  "input": { "kind": "braindump", "file": "braindump.md", "author": "A. Person", "recordedBy": "Omni Agent" },
  "executor": { "name": "Omni Agent", "backend": "claude-code / claude-opus-5-5" },
  "predecessor": null,
  "definition": {
    "root": "build-game",
    "workflows": {
      "build-game": {
        "file": "definition/build-game.yaml", "source": "devdocs/workflows/build-game.yaml",
        "sha256": "…", "definitionDigest": "sha256:…",
        "approvals": { "intent": "approved", "definition": "stale" }
      }
    },
    "warnings": []
  },
  "context": { "repositories": [ { "path": ".", "head": "1ad073e…", "branch": "main", "dirty": 0 } ] },
  "nodes": {
    "survey": { "state": "completed", "updated": "…", "started": "…", "ended": "…",
                "outcome": { "text": "…", "artifacts": ["devdocs/runs/build-game/run-001/report1.md"] },
                "notes": [], "wait": null }
  },
  "questions": {},
  "artifacts": [],
  "decisions": [],
  "cancelled": null,
  "execution": { "state": "in-progress", "counts": { … }, "ready": [ … ], "blocked": [ … ] },
  "started": "…", "ended": null, "updated": "…", "seq": 7,
  "history": [ { "seq": 1, "at": "…", "by": "Omni Agent", "via": "cli", "op": "run.create", … } ]
}
```

### One reducer, current state and history

Every state-changing operation is one **history entry** (`seq`, `at`, `by`,
`via`, `op`, its parameters, and the `change` it made). The current state is
exactly what `shared/run.ts` `replay()` computes from the history and the
bundled graph. An operation appends the entry and writes the replayed state
in the same atomic replacement of `run.json`.

Reading replays the history and compares it with the stored state. Missing,
malformed or inconsistent records are visible errors — never an empty or
successful run — and are never rewritten automatically: operations refuse a
record that does not read cleanly. `wfe run check` names the difference. The
CLI and the service use the same module, so they cannot disagree on rules.

`via` is `cli` or `browser`. `by` is the declared actor; the browser asks for
a name. Both are declarations, as approvers are. **Who records (p9):**

- An executing attempt (`WFE_ATTEMPT` in its environment) records as the
  run's agent, and refuses `--by` naming anyone else.
- When the agent stops, resumes or cancels because of a person's answer or
  instruction, it names those words with `because` (`--because
  answer:<q>[:<n>]` or `instruction:<i>`). The reducer checks they exist and
  records whose words they were, in the hold or cancellation too.
- A control operation that carries an attempt id must be the open attempt's.
- Outside an attempt, a run the execution host performs is recorded only
  under a name given with `--by`. No default puts the agent's name on someone
  else's act.
- Runs an IDE agent performs itself keep the default, which is the run's
  executor.
- **An agent operating another run** (project_migration p8): an executing
  attempt of run A that records on run B — instructs, answers, stops,
  resumes, cancels or decides, as a person does from the run view — records
  as A's agent (`by`), never as B's, and refuses `--by` naming anyone else.
  The entry names the attempt as `operator: {run: <project>/<workflow>/<run>,
  attempt}`; it is not B's fencing (`attempt`), so B's own execution reports
  stay B's. Whose words the act carries is `--from` (answers, instructions)
  or `--because`. An ended attempt records nothing.

### Node states

| State | Meaning | Entered by |
| --- | --- | --- |
| `pending` | Work has not started | creation |
| `running` | The executor recorded that work started (reported progress, not process health) | `start` when ready; `start` again (resume) from `waiting` or `failed`; `take-up` |
| `waiting` | Work awaits an identified answer or external result | `ask`, `wait` |
| `completed` | The executor recorded completion with an outcome | `complete` from `running` |
| `failed` | A recorded problem prevents continuation | `fail` from `running` or `waiting` |
| `cancelled` | Work was explicitly discontinued (final) | `cancel` from `pending`, `running`, `waiting` or `failed`; run cancellation |

- A node is **ready** when it is `pending` and every predecessor is
  `completed`. Only a ready node can start. A join therefore waits for all of
  its predecessors.
- `failed` and `cancelled` never satisfy a dependency. A pending node behind
  one is **blocked** (derived, shown, not stored as a state).
- Resuming a `failed` node (`start`) needs a reason and is recorded as such;
  nothing retries by itself.
- `complete` needs an outcome text and may name artifacts.
- `progress` adds a note to a `running` or `waiting` node without changing
  its state. It updates the node's `updated` time.

Independent branches may be performed one after another; nothing runs nodes
by itself, and no timer changes a state.

### Documentation steps (p5)

Under the `default` policy the run has generated steps beside the authored
nodes ([contract.md](contract.md), *Documentation policy*): `_plan`,
`_report.<node>` and `_final-report`. They are nodes of the run: the same
states, operations, attempt fencing, receipts, stops and resumption. An
authored node's `completed` and its report's `running` are separate facts,
and the run is `completed` only when `_final-report` is.

| Step | Document | Completes when |
| --- | --- | --- |
| `_plan` (type talk) | `plan.md` | its document is checked **and** the latest question asked from `_plan` was asked about that same content and its answer was taken up (`agreement`) |
| `_report.<node>` | `report-<node>.md` | its document is checked |
| `_final-report` | `report.md` | its document is checked |

- **Document evidence.** Before `complete` of a step (and `ask` from
  `_plan`), the file layer (`server/runs.ts` `checkDocument`) requires the
  document to be a regular, nonempty file of the run folder — not a
  symbolic link, not resolving elsewhere — and passes `{path, sha256,
  bytes}` to the reducer, which checks its shape and path and records it on
  the node (`document`) and among the outcome's artifacts. Evidence offered
  by a caller is discarded. File presence is not a claim that the prose is
  right.
- **Plan agreement.** A question from `_plan` records the plan.md it asked
  about (`question.document`); the plan is therefore written before it is
  consulted on. A revision is asked about again, and a later question
  supersedes earlier answers. Completing `_plan` records which question
  agreed (`agreement`, `--agreement` to name it). A withdrawal is not
  agreement, and plan agreement is neither definition approval nor
  acceptance of the result. Whether an answer *is* agreement is the
  executor's reading of the person's words: taking it up and completing the
  step is the executor's claim.
- **Failure.** A failed or cancelled authored node blocks its report, its
  successors and the final report, so the run cannot complete. A partial
  report may be attached to the failed node (`attach --node`); it does not
  complete a step. Nothing writes a report or a final report for the
  executor.
- **Interruption.** An attempt that ends while a report step is running is
  interrupted like any other; after `run.resume` the next attempt continues
  the report, and the completed work is not repeated.
- The execution brief (`server/exec.ts` `documentationBrief`) names the
  policy and, for each running, ready or waiting step, its purpose,
  document and frozen instructions. Under `manual` (and in runs created
  before p5) it says that no plan or report is asked unless a node or the
  person asks.
- Error codes: `document-missing`, `document-path`, `document-empty`,
  `plan-not-agreed`.

### Status in short (project_migration p8 ex1)

`shared/status.ts` `runStatus()` is the one reading every view and API
uses: a state, a label and a short reason (`text` = `label · reason`),
the waits behind it each with its target and what continues it, the hold
with its cause, and the full sentence as `detail`. It is recomputed from
the record — and, where the reader has them, the execution host's job for
the run, a child's current situation and node names — never stored.

| Situation | Text (examples) |
| --- | --- |
| a question to the run's person | `Waiting · Your answer` (to someone else: `Waiting · Answer from <them>`) |
| a delegation | `Waiting · jevlab study result`; a child known paused or interrupted is said in it (`… (child interrupted)`) |
| an external wait | `Waiting · <its reason>` (`(overdue)` past its deadline) |
| the executor's move, a job queued | `Queued · Waiting for an execution slot` (`Starting` once claimed) |
| the executor's move, no host facts | `Continuing · Answer to q1 arrived`, `… Result from jevlab study arrived` |
| the executor's move, nothing queued (host facts) | `Stalled · …; nothing queued to continue it` |
| a person's stop | `Paused · <their recorded reason>` |
| an interruption | `Interrupted · Talk node left running at exit` (from the hold's cause; older holds from their sentence) |
| a lost process | `Unknown · Process lost; outcome unconfirmed` |
| running | `Working · On <node>`; `Stopping · Stop requested by <who>` |
| failed, done, cancelled | `Failed · <node> failed`, `Done · Every step completed` / `Result accepted`, `Cancelled · <reason>` |

Several waits read as the first (a person's, then a delegation, then an
external result) with `(+n more)`; each stays in `waits`. A hold is the
status even while a question is also pending: an answer alone never
resumes a held run. `Watching` is not used: nothing in WFE watches on a
run's behalf.

### Waiting

A waiting node records `wait: {reason, holder, on}` where `on` is
`{question: "q1"}`, `{external: "<reference>"}` or (p10) `{delegation: "d1"}`, and `holder` names who or
what holds the next move: the person a question is addressed to or the named
external party. An external wait may declare a `deadline` (observer p3,
`wfe run wait … --deadline`): when the result is expected at the latest. It
is a statement for monitors ([observation.md](observation.md)), not a timer. The view derives the
current holder: once a question has an answer that is not yet taken up, the
holder is the executor.

### Questions

`ask` records a question with a stable id, its text, to whom it is addressed,
and optionally its node; a running node then waits on it. A node waits on one
thing at a time; asking from an already waiting node is refused.

| Record | Effect on the node |
| --- | --- |
| `answer` (text; `from` who gave it, `by` who recorded it) | none — the node keeps waiting. Several answers may be recorded; each names its question. An agent relaying the person's reply from the IDE records `from` = the person, `by` = itself |
| `take-up` (who took it up, which answer) | the node waiting on that question resumes `running` |
| `withdraw` (reason) | the question is closed without an answer; a node waiting on it resumes `running` |

An answer from Zulip (p6) records the person as `from`, the post as
`source` and the post's receipt; `via` is `zulip`.

### Additional instructions (p6)

`instruction.receive` records a person's further input that is not an
answer: `instructions.<id>` (`i1`, `i2`, … in order) with its text, `from`,
`source`, the nodes recorded as running when it arrived (`during`) and
`ack: null`. It changes no node and is refused only on a cancelled run.
Acknowledgment and the node-boundary rules are below (*Node boundaries*).

### Instruction acknowledgment (p6, p11)

The executor acknowledges instructions with `instruction.ack` (executor
operation, fenced by the open attempt): the ids, a `response` —
`incorporate` (into upcoming work), `clarify` (it asks the person) or
`new-run` (it explains why the request needs a new run) — and a note saying
what it will do. Each instruction is acknowledged once.

Acknowledgment is a record, not a gate (p11): no transition waits for an
unacknowledged instruction, and the `instructions-pending` refusal no longer
exists. Receipt (`instruction.receive`) holds the run's lock like every
operation, so the order is the history's. A Zulip post for a completed
execution is not applied (the intake explains that a new request topic is
needed); an instruction recorded on a completed run directly is kept for an
attempt that reopens work, and nothing continues the run for it. A post still
in transit is not claimed to have reached the run.

**An instruction continues a run nobody executes** (project_migration p8).
After it is recorded, a run with no open attempt and no hold that is not
completed or cancelled — waiting on a question, a delegation or an external
result, or left with ready work — gets a continuation job (receipt
`instruction:<workspace>/<workflow>/<run>/<id>`), so its agent reads the
instruction now rather than at whatever wakes it next. An open attempt reads it
at its next node boundary; a held run when it is resumed. Every entrance does
this: `wfe run instruct`, the run view, the Zulip intake.

Completed nodes can be started again and the graph revised (`wfe run
adjust`), so an instruction that changes completed work is incorporated like
any other. The execution brief and a resumed session's continuation list the
unacknowledged instructions in full; `wfe run state` shows them with the
answers not yet taken up, and `wfe run instructions` and the run view show
them all.

An answer to another question leaves a node waiting. Recording an answer is
not taking it up, taking it up is not completing the node, and none of these
is accepting a result.

### Execution summary (`execution`)

Derived after every operation; the counts keep mixed facts visible.

| `state` | When |
| --- | --- |
| `cancelled` | the run was cancelled (`cancel` without a node) |
| `completed` | every node is `completed` |
| `not-started` | every node is `pending` |
| `in-progress` | some node is `running` or `waiting`, or some node is ready |
| `stopped` | none of the above: nothing runs, waits or is ready, and some node is `failed` or `cancelled` |

`execution` also lists `counts` per state, `ready` and `blocked` node ids, the
`active` (running) and `waiting` nodes with holders, and `failed` nodes.
Execution succeeds only when every node is `completed`. Run `started` is the
first node start, `ended` the operation that made the state `completed`,
`stopped` or `cancelled` (cleared again if a later resume reopens it).

### Acceptance

`decide <run> --decision accepted|rejected --by <name> --evidence <ref>`
records a decision on the result, with actor and evidence. `accepted` is only
recorded on a `completed` execution; `rejected` at any time. A completion
record, an answer, or a definition approval never creates a decision.

**Integration (p9, [integration.md](integration.md)).** For a run with its
own copy, an acceptance records the exact revision it binds to (`revision`:
the tree of each repository the run owns) and queues its integration into
the project's shared branches. That is a separate operation (`wfe run
integrate`), journaled per repository and recorded as `run.integrate` when
complete. Saved, accepted, partially integrated and integrated are shown
apart. One acceptance per result (project_migration p3/ex1): accepting what
the latest acceptance already binds is refused (`already-accepted`); a
changed result is accepted again ([integration.md](integration.md)).

**Feedback (project_migration p3/ex1).** Each form in the run view says what
became of its submission beside its button: *Recording…* while in flight
(the button disabled, a second click sends nothing), then what was recorded,
or why nothing was, with the text kept. A recorded answer the executor has
not taken up is shown on its question as *Recorded … Waiting for <agent>*,
apart from any failure.

### Result confirmation (p6)

A workflow may designate one talk node `confirms: result`. Its question
presents the deliverables (`ask … --subject <path>`, required there): the
file layer records each by path, hash and size (`question.subject`). When the
person's answer, taken up by the executor, confirms them, the executor
records the decision that answer is: `decide <run> --decision accepted
--question <q>` (fenced by its attempt). The reducer requires the latest
question of the confirming node, its answer taken up, no earlier decision
from it, and the deliverables unchanged since they were presented
(`subject-changed` otherwise: present them again). The decision records
`confirmation: {question, answer, from, source, subject}` and an evidence
text naming them. It may precede the execution's completion; the two stay
separate facts and are shown separately. A question from `_plan` or any
other node is refused (`not-result-confirmation`): plan agreement never
becomes acceptance, and the person does not approve twice. An ambiguous
answer is the executor's to follow up with another question.

### Presentations and adjustments (p7)

A run may present its result for review — a frozen bundle served on this
host with an explanation, bound to the confirmation question and decision —
and may change its future work through recorded revisions of its
definition. Both are additive parts of this record (`presentations`,
`definition.revisions`, `definition.active`, absent until first used) with
their own operations (`presentation.register`, `presentation.observe`,
`run.adjust`): see [presentations.md](presentations.md) and
[adjustments.md](adjustments.md). Open presentations do not hold execution
completion (p11); `wfe present status` shows them.

### Reminders at operation boundaries (workflow_editor fix5)

Before an agent's operation is recorded, WFE checks the run's records for
omissions that are easy to miss and still easy to repair. The check runs
inside the operation, against the record the operation would replace and
under the run's lock. If a reminder applies, the operation is refused
before anything is recorded, posted or queued. The refusal lists every
applicable reminder in one response, with what the records show, what
stays unknown, concrete repair commands, and that the same command with
`--yes` continues. `--yes` passes these reminders only and only for that
command. Invalid arguments, stale revisions or seqs, attempt ownership and
invalid graphs stay errors. No human approval is involved.

A reminder is not proof of an omission. WFE cannot observe every shell
action, and cannot judge whether a result needs a presentation.

| Code | At | When |
| --- | --- | --- |
| `presentation-missing` | the completion that completes the run; completing the last work node; an outward result report; a result-confirmation question that presents nothing | work completed after the latest presentation was registered (and not linked to it), and no present node is planned |
| `presentation-serving` | the run-completing completion; a report; completing a cleanup node; completing a node that took an answer about a presentation | a presentation is still recorded as serving, and no cleanup node is planned |
| `presentation-inside-work` | `wfe present register` | registered from a talk, work, confirmation or discussion-activity node |
| `cleanup-unplanned` | `wfe present register` | no cleanup node is planned |
| `unrecorded-activity` | a question, a report, the run-completing completion | the run's catalog has templates and no work node is visible, but something suggests work was done: changed paths in the run's copy outside its records, artifacts outside the run folder or published outputs, or a talk that has run for more than 10 minutes |
| `discussion-activity`, `discussion-open` | completion | a discussion activity completed with a plain completion; a conductor run ending with its discussion open (fix3) |

Roles come from structured records, never node names:

- **present**: the catalog's `present` template, the `present` icon, or a
  node a presentation was registered from;
- **cleanup**: the `cleanup` template or icon;
- **work**: the `work` template. Untemplated nodes are the designer's or
  serve other ends (front/converse adds `tell` and `report` nodes), so they
  count as visible work for the self-check but are not presented;
- `confirms: result`, talk, activity and documentation steps come from the
  graph.

"Planned" means pending, running or waiting. The completion that completes
the run is the transition to execution `completed`. Documentation steps
such as `_final-report` do not hold it.

There are three responses to a reminder:

- do the omitted work: add a present or cleanup node with `wfe nodes
  instantiate … --run` and `wfe run adjust`, or stop the page with `wfe
  present stop`;
- record work already done (`wfe run record-done`, [adjustments.md](adjustments.md));
- continue consciously with `--yes`.

After a repair the ordinary command passes when its conditions no longer
hold. A self-check that the records cannot resolve needs `--yes` once the
agent has considered it.

A person's incoming answer is never refused or delayed. When an answer
concerns a presentation, it is shown with the pending answer in the brief,
the continuation and `wfe run state`, and once at `wfe run take-up`, with
a reminder: decide whether it asks for more work (present a new revision;
the page may stay up) or whether the review is finished and cleanup is
due. Nothing stops a page or adds work by itself. WFE's own records
(attempt ends, intake, a discussion completing a node for a run) are not
evaluated.

Paths: the CLI (`--yes`; exit 1 with the reminders on stderr, detail under
`--json`); HTTP `POST …/ops` and `POST …/adjust` (`"yes": true`; 409
`{detail: {code: "reminder", reminders}}`; adjust also takes `completing`);
a remote worker, which forwards `--yes` with the command; the run view,
which shows the reminder and records only after the person explicitly
continues. A retransmission with the same receipt records nothing and is
not evaluated again.

Why: gimmickimg/freework/run-010 recorded its experiment as nodes and
completed with no presentation. run-011 presented it only because a
separate request asked. run-001…008 did their work inside the talk and
left review pages serving (workflow_editor fix4 report).

### Artifacts

`attach` records a project-relative path (usually a report in the run
folder), optionally with its node and a title. `complete --artifact` does the
same for a node's outcome. A path that leaves the project is refused; a path
that does not exist when attached is recorded with a warning and shown as
missing.

## Execution by autolab (p4)

A person requests a run through agdevworld (Project Editor → Request a run,
or `wfe request`): the run is created with their words and the executor —
autolab, `agautolab.wfexec` — is queued. Two kinds of fact are kept apart:

| Where | What |
| --- | --- |
| `run.json` (durable work record) | `control`: the open attempt (id, reason, backend), how the last one ended, a hold, a requested stop; the history of `attempt.begin`, `attempt.end`, `run.stop`, `run.resume` |
| `<area>/.local/exec/exec.sqlite` (the coordinator) | the queue, one execution slot per worker, each attempt's worker, process id, times and log, publication checkpoints, every worker's heartbeat (`server/exec.ts`, [workers.md](workers.md)) |

**Activity (p8/ex2).** `GET runs/<wf>/<run>/exec` (and `wfe exec status
<run>`) gives each attempt an `activity` summary read from its own log on
the host that has it (`server/activity.ts`; `null` on any other host):
`unit` (`turn`, or `null` for a log whose format is not counted), `count`,
`last` (the log's last write), `bytes`, and `problem` when the log is there
but cannot be read (then nothing is counted and the view says so, never
"another host"). A turn is one distinct assistant
message id of a Claude Code stream-json log; the count belongs to that
attempt (one session) and starts again with the next. Only the agent process
writes its log, so heartbeats, reconnections and polling are never counted;
the service reads only what was appended (up to the last complete line), so
re-reading never counts twice. No log text leaves the service. The run view's
activity line (`src/runActivity.ts`) states the current work with this count
and age, or the state that replaces them: queued, starting, waiting for a
person, held, stopping, a session whose process is gone, another host, not
connected, finished, cancelled. A history view states none of them.

**Where an attempt works (p9).** `wfe exec claim` hands the executor the
logical workspace (`workspace`) and the directory the agent works in
(`cwd`): the run's own copy. The run's project defaults are read from the copy, and
the brief names the copy, its branch and the project workspace (the
person's; local resources are read from there by name).

**Settings (p6).** The run's workflow names the agent identity, the host
profile and project guides (contract.md, *Execution, intake and result
confirmation*). `wfe exec claim` takes what the host offers (`--profiles-json`,
`--contract <name>=<sha256>`), resolves the run's settings from its frozen
definition (the profile from a person's resume when one was chosen, *Holds*
above) and records them with `attempt.begin` (`settings`: agent, profile,
backend, contract and the context bundle by snapshot id and hashes); the host
composes the prompt from the common contract, the context text it was handed
(the snapshot's exact bytes, [context.md](context.md)) and the brief.

**Sessions (agent_session p1).** Which harness conversation an attempt
runs in is the run's frozen session policy (`fresh` or `run`), resolved at
claim and recorded in `attempt.begin` before launch; `run.json` keeps the
run's `sessions[]` (ids, attempts, configuration, replacement reasons) and
`wfe run session <run>` shows them. See [sessions.md](sessions.md).

**Attempts.** One run can take several launches of the agent. `attempt.begin`
(by the execution host when it claims a job) opens one; while it is open the
executor's own reports (`start`, `progress`, `wait`, `complete`, `fail`,
`ask`, `take-up`, `withdraw`, `attach`) must carry its id (`WFE_ATTEMPT`), and
nobody else records execution meanwhile. A stopped or superseded attempt's
late report is refused (`attempt-stale`). `attempt.end` says how the process
ended: `exited`, `stopped`, `interrupted` or `unknown`. An exit that leaves a
node recorded as running, or ready work with nothing waiting on a person, is
recorded as `interrupted`, never as success.

A wait is the record's, not a process's: the attempt that records it ends,
frees its slot, and the answer, the child's fact or the external result
starts a new attempt (project_migration p8 ex1). Every node the attempt
started is completed, failed or waiting when it ends; a node left running
beside a normal wait still holds the run as interrupted
(front/converse/run-027: its talk node beside a delegation). Work that needs
what is awaited is a node after the waiting one.

**Why a hold was derived** (project_migration p8 ex1). Ends recorded since
then carry `explain: cause`, and the hold they derive keeps a structured
`cause` beside its sentence `reason`:

| `cause.code` | Meaning |
| --- | --- |
| `left-running` (`nodes`) | the attempt ended with these nodes recorded as running |
| `left-ready` (`nodes`) | ready work and nothing waiting |
| `nothing-recorded` (`nodes`) | the attempt ended with none of the run's work ever recorded (no node started, nothing asked, nothing delegated) |
| `missed-event` (`events`: `{delegation, n, type}`) | a child's fact the attempt was launched for was not taken up |
| `process` (`detail`) | the execution host saw the process end abnormally |
| `lost` | the process was gone; its outcome is unknown |

Older holds have no `cause`; readers fall back to the sentence.

**Holds.** `stopped`, `interrupted` and `unknown` hold the run: nothing
begins until a person records `run.resume` with an instruction (after looking
at the run's files — side effects may have happened after the last record).
An `interrupted` or `unknown` hold may instead be lifted by a recovering agent
with `run.recover` (observer p3, [observation.md](observation.md)): Observer
asks a recovery run to investigate, and the record names the incident, the
ended attempt and the recovering run; a `stopped` hold is only a person's.

**Resuming on another profile (project_migration p6 ex2).** A person's
`run.resume` may carry `profile` (`wfe run resume --profile <name>`, or the
profile field of the run view's resume form): one of the execution host's
profiles, which later attempts resolve instead of the frozen definition's.
It is recorded in `control.profile` (`name`, `seq`, `at`, `by`, `previous`:
the earlier choice, null for the definition's) and shown in Run details. It
changes which model serves the run, not who performs it: the agent, the
guides, the bindings and the session policy stay the definition's, no
revision is made, and a profile the host does not offer drops the next job
with the reason. It exists because a run that has started work cannot be
adjusted while a node runs, and an adjustment never changes `execution`
([adjustments.md](adjustments.md)); a held run is exactly where a person
looks at it and decides how it continues.

- `run.stop` while an attempt is open is a request (`control.stop`, shown
  as "stopping"). The hold is recorded only when the attempt's end confirms
  that the process is gone. Its reports are fenced from then on.
- The checkpoint that follows saves the copy to the run branch. A save that
  fails stays visible on that run, and `wfe exec publish` retries it.
- **A hold keeps the run's plan, records and work in its own copy (p9) and
  reserves nothing else:** other requests in the project are created and
  executed meanwhile.
- Resuming continues in the same copy, from the run's own base. The project's
  newer commits are not merged in; the brief names how many there are and
  where, and the agent asks again when they change an agreed plan or a
  reviewed result.
- Cancellation (`run.cancel`) is final: after it, reports, resumption and
  further attempts are refused. The run's copy, records and saved branch
  stay as they are.

**Human waits.** A talk node asks and the agent ends its session; no process
runs during the wait, and the wait reserves nothing (p9). An answer is persisted first, then the resumption is
queued (once per answer, by receipt). A stopped run is not resumed by an
answer. Recording an answer, taking it up, completing the node and accepting
the result remain separate records.

**One slot (p9).** One attempt executes at a time on this host; other jobs
wait in the queue. Since p7 that is one slot per worker, and since
project_migration p8 a worker may declare extra **lanes** — slots of their
own for runs whose workflow names that lane, e.g. a conversation answered
while a long attempt holds the default slot ([workers.md](workers.md),
"Lanes"). Nothing else is shared:

- Every run works in its own copy, so no run reserves its project. A held, a
  waiting or a working run never refuses another request (until p9, a begun
  run held its workspace).
- A run has at most one queued or claimed job.
- Stopping a run drops only that run's queued job, and terminates only its
  own attempt.
- A run without a copy of its own (recorded before p9) is not executed; it
  is migrated first (`wfe runs migrate`).

**Recovery.** After a restart, an attempt whose process is gone is ended as
`unknown`; one whose process lives keeps the slot. Requests and answers whose
queue entry was lost are queued again under their receipts. Nothing is
completed, failed or rerun by itself.

**Launch ownership (agent_session p1 ex1).** An attempt's process may work
only after `wfe exec started` registered it: the executor spawns it behind a
launch gate that opens after that record, and an executor that dies before
then leaves a process that exits without doing work. So a `launching` row
(no process registered) is ended as `unknown` after two minutes. A launch
that fails after the spawn ends the attempt only once the process group is
confirmed gone; until then the executor keeps it and passes `reconcile
--holding <attempt>`, and the slot stays held.

**Publication** happens at checkpoints after the process has ended (a human
wait, a stop or interruption, completion) and after a result decision
(`server/publish.ts`). Work completion and publication are shown
separately. A failed push is retried without repeating the work (the
journaled commits are pushed).

- *A run with its own copy (p9)* saves to its run branches only
  (`publishRun`). Everything uncommitted in the copy is the run's work. Each
  repository the copy owns commits on its run branch and pushes exactly
  that branch, submodules before the root. The branch is recorded in the
  checkpoint's step before anything is written, so a retry publishes to the
  same place even if the agent checked out something else meanwhile. A
  repository with another branch checked out is not committed there and
  needs attention. The root is not pushed while a submodule's run branch is
  not. Commits happen under the run's record lock, so no record operation
  lands between staging and committing. Publications of one run take turns.
  A checkpoint waits only for that run's own attempt. Nothing reaches a
  shared branch: that is integration.
- *A run kept in the project workspace* (before p9) publishes as before: the
  paths the attempt changed are committed on the checked-out branch and
  pushed, submodules (devdocs first) before the root. Changes present before
  the attempt began are left out, and a pre-existing change the run changed
  again needs a person.

**Two conversations (p6).** A run requested in a Zulip request topic
([intake.md](intake.md)) talks with the person in that topic and reports
progress in its run topic:

| Destination | Events |
| --- | --- |
| request topic | the request accepted (with the run topic's link), questions (with their id and how to reply), receipts of answers and instructions (recorded, not yet read), instructions taken up, holds and failures, the completed execution with the result's state, the decision, cancellation, and replies about posts that changed nothing (late, unclear, after completion, refused, routing problems) |
| run topic | started (with the request topic's link), node reports, holds and failures, resumption, publication failures and recovery, the completed execution, the decision |

Beside them, since p10 every run has a **detailed IO channel** — the
agent's messages, tool calls and results, attempt by attempt, from the
attempt logs; output only ([io.md](io.md)). The request receipt and the run
topic's start link to it.

Each destination is a conversation of its own in the notifier (`runs.kind`
`request`, keyed `<project>/<workflow>/r<origin post>`, its place the
intake's recorded topic, bound to the run): the same event sent to both is
two outbox rows (`…#<seq>:<type>` and `…#<seq>:<type>@request`), two
frozen deliveries with their own markers, searched for only where each was
sent. Questions in the request topic say to reply there; their posted
message ids are how replies bind (`postedLookup`). Runs requested elsewhere
keep one topic and the previous wording.

**Coordination in Zulip (p5).** devdocs stays authoritative; Zulip carries
short coordination messages that say what happened, what is uncertain and
who acts next, and point at the records.

| Zulip | Entity | Name (a label; identity is the recorded id) |
| --- | --- | --- |
| channel folder | project | `wf-<project>` |
| channel | workflow | `wf-<project>.<workflow>` |
| topic | run | `<run id>` |

Names longer than 60 characters are cut with a hash of the whole. The `wf-`
names and `run-…` topics match no legacy surface (`pj-`, `work-`, agent
channels) and no listener's sweep prefix, and messages mention nobody, so
no legacy listener is served by them; a reply in Zulip answers nothing —
questions are answered in agdevworld, and the message says where.

- **Selection** (`notableEvents`, `wfe run events`): started; a question
  (who answers, the plan.md it asks about, where to answer); answered; a
  node's report (its short outcome, the document); under manual policy a
  node's completion; failed; held (stopped, interrupted, unknown — with the
  reducer's reason); resumed; the completed execution ("not accepted yet");
  a result decision; cancellation. Ids are `<project>/<workflow>/<run>#<seq>:<type>`.
  Starts of nodes and steps, progress notes, attempts and other internal
  transitions are not announced. Adjacent routine events go out as one
  message; questions, failures, holds, completion, decisions and
  cancellations alone. Messages have a budget (~900 characters) that
  shortens free text, never the actionable lines.
- **Publication** (from the checkpoints): a failed or attention checkpoint
  and its recovery are announced; links are commit-addressed Gitea links
  (`<origin>/src/commit/<sha>/<path in the owning repository>`, both devdocs
  modes; credentials stripped), only when a published commit holds the
  file. Otherwise the document is named as not yet published. A message
  about a document waits for its publication while the attempt is open
  (routine up to 20 min, questions and blockers 90 s); details that had to
  be called unpublished get one "details published" update when a later
  checkpoint publishes them.
- **Durability** (`server/notify.ts`, `<area>/.local/notify/notify.sqlite`,
  schema versioned by `user_version`, migrations transactional): targets
  (folder, channels) with their Zulip ids and problems; each run's topic
  binding, the identity it was bound with and where it was followed to
  (relocations); an outbox keyed by event id, rebuilt from history on every
  scan (a crash between the record and the queue loses nothing). A failure
  never changes the run's state. A second run with the same
  project/workflow/run identity (another workspace, another creation) is
  refused as ambiguous, not merged. Runs created before `since` are not
  announced (no backfill). Delayed messages say so; a question that is no
  longer open says no action is needed.
- **Deliveries** (p5/ex1). One message is one delivery: its ordered events,
  text, marker line (`ref <workflow>/<run> #<seq>:<type> …`, `cp<n>:<state>`
  for publication notices), the documents it called unpublished and its
  destination are frozen when it is first handed out and never change. An
  event belongs to one delivery; a run has at most one delivery in
  progress, and events recorded meanwhile wait for the next one (batching
  as before: adjacent routine events up to six, critical ones and
  publication notices alone, documents waiting briefly for publication).
  Content is rendered outside any database transaction and committed in a
  short one that checks the selection still holds.
  States: `ready` → `sending` (recorded *before* the POST) → `sent`, or
  `failed` (retried with backoff, 15 s doubling to 15 min, same payload).
  A delivery that may have been posted — answer lost, begun and never
  finished, or its acknowledgment could not be recorded — is looked for
  before anything is posted again: the sender's own messages in each place
  it was sent to, the run's current topic and its recorded relocations,
  page by page back to before its first send. Found: acknowledged. Absent
  across all of that: begun again with that evidence (`--checked-absent`),
  same payload. Search or access failure: it stays uncertain and is shown
  as a problem, never treated as absence; `wfe notify resolve` is the
  person's path. A published follow-up announces documents that became
  readable later; an attempted message is never rewritten. Exactly-once
  is not claimed: a message deleted by hand, or Zulip losing history,
  defeats the search.
- **One sender**: `wfe notify claim --sender <owner> --pid <pid>` records
  the sender; while that process lives on this host every other sender is
  refused; when it is gone, the next one takes over and every begun
  delivery is reconciled first. There is no lease expiry: an old claim
  proves nothing about a request still in flight. Results (`begin`, `sent`,
  `failed`, `legacy`) name the delivery, its claim and its events; stale or
  unrelated ones are refused; the same acknowledgment twice is harmless.
- **Before p5/ex1**: uncertain outbox rows become one legacy reconciliation
  per run at migration; the transport's old `inflight.json` is imported
  once (`import-inflight`) and retired. The posts found say exactly which
  events they carried; a complete search releases the rest to new
  deliveries; otherwise they stay uncertain.
- **Provisioning**: a folder per project, then a channel per workflow known
  from the registry's workspaces (external edits included), the realm owners
  and the bot subscribed. An existing folder or channel of the same name is
  adopted only when its description is this integration's (`[wfe] project
  …`); otherwise it is a visible problem, and `wfe notify reset <key>` is the
  repair path after a deletion or a rename.
- **Configuration**: `<area>/zulip.json` `{enabled, zulipUrl, viewBase,
  since, person, intake?}` — no credentials (autolab's transport holds them).
  `intake` (p6, [intake.md](intake.md)): `{enabled, since, projects: {<id>:
  {workspace?}}, requesters: [{id: <Zulip user id>, name: <recorded as>}]}`;
  the transport reads it through `wfe intake due` and runs on a thread of
  `agautolab.wfexec` when its `.local/wfexec.toml` has `[intake] enabled =
  true`. A
  `localhost` viewBase is refused; without one, messages say to answer on
  the execution host and the run view says the remote address is missing.
- **Transport** (protocol 2; `wfe notify protocol`): autolab's
  `agautolab.wfnotify` checks the protocol, asks `wfe notify due`
  (provisioning), `claim`s, and for each delivery searches if asked,
  `begin`s, posts with its bot and reports `sent` / `failed` / `moved` /
  `target`; it runs on a thread of the executor process, independent of
  the agent and of the slot. A transport of another protocol sends nothing
  (an old `sent --id` is refused). `wfe notify status|outbox|deliveries|
  sender|resolve|reset` are for people. The run view shows the topic link,
  what is pending, failing or possibly posted, and provisioning problems.

## Operations

All operations are in `server/runs.ts` (files) over `shared/run.ts`
(reducer, readiness, summary, validation). `wfe run …` and the service's
HTTP routes call them; neither needs the other running.

| Operation | `wfe run` | HTTP (`/api/workspaces/<ws>/…`) | Browser |
| --- | --- | --- | --- |
| Create a run (snapshot, input) | `create <workflow> --braindump <file>` / `--request <file> --entrusted-by …` | — | — (input comes through the IDE; see below) |
| List runs | `list [<workflow>]` | `GET runs` | project view → Runs |
| Inspect a run, its definition, ready nodes, history | `show <run> [--history] [--rev [root:]<commit>]`, `check` | `GET runs/<wf>/<run>[?rev=]` | run view |
| The current state and pending input only (agent_session p1 ex2) | `state <run> [--since <seq>]` | — | — |
| What the definition declares for a path | `access <run> [<path>]…` | — | — |
| Start / resume, progress note | `start`, `progress` | `POST runs/<wf>/<run>/ops` | — |
| Wait, complete, fail | `wait`, `complete`, `fail` | same | — |
| Cancel a node or the run | `cancel [<node>]` | same | run view → Result and decision → Cancel run (a failed run: its focus card) |
| Request a run (the person's words; queues autolab) | `wfe request <workflow> …` | `POST runs` | Project Editor → Request a run |
| Stop (resumable), resume a held run | `stop`, `resume` | same (`run.stop`, `run.resume`) | run view → focus card (Stop while work runs; the resume form while held) or Execution and publication → Stop |
| Attempts, queue, publication of one run | `wfe exec status <run>` | `GET runs/<wf>/<run>/exec` | run view → Execution and publication; the title band's executor chip |
| Retry a publication | `wfe exec publish <checkpoint>` | `POST runs/<wf>/<run>/checkpoints/<id>/publish` | run view → Execution and publication → Retry publication (named under Needs attention) |
| Coordination events (selection) | `events <run> [--since]` | — | — |
| Zulip coordination of a run | `wfe notify status <run>` | `GET runs/<wf>/<run>/notify` | run view → Coordination (Zulip) |
| Ask, take up, withdraw | `ask`, `take-up`, `withdraw` | same | — |
| Answer | `answer <run> <q>` | same | run view → focus card → the question's form |
| Attach an artifact | `attach <run> <path>` | same | — (reports listed and readable) |
| Decide on the result | `decide <run> --decision …` | same | run view → Result and decision → Accept / Reject (a completed run without a decision: its focus card) |
| Integrate the accepted result (p9) | `integrate <run> [--dry-run\|--status]` | `GET/POST runs/<wf>/<run>/integration` | run view → Execution and publication → Integration |
| Delegations (p10, [delegation.md](delegation.md)) | `wfe delegate request\|list\|show\|take-up\|answer\|instruct\|dispose\|file\|sync` | `GET runs/<wf>/<run>/delegations` | run view → Delegations |
| The node catalog the run was given (p7/ex1) | `nodes <run> [--show <template>]` | `GET runs/<wf>/<run>` (`catalog`) | run view → Node catalog |
| Record work already done as a completed node (fix5, [adjustments.md](adjustments.md)) | `record-done <run> …` | `POST runs/<wf>/<run>/record-done` | the node is marked "recorded afterwards" |

The browser offers the person's operations: answering, deciding on the
result, and stopping the run. Execution records (start, complete, wait, …)
are the executor's reports of its own work; the browser shows them and does
not make them, so a click cannot claim work. The person can still record
anything with `wfe run … --by <name>`. Creating a run starts from the person's
words given in the IDE, where the conversation with the executor happens.
Submitting an answer in the browser stores it; it does not launch or wake the
IDE agent. The person continues the conversation in VS Code. An answer is not
a decision on the result and does not resume a held run; those stay separate
operations with their own preconditions (p8 keeps them apart in the view).

In Simple (p8/ex1) the run view shows the focus card's forms — answers, the
resume instruction, the decision, Stop — and the graph; the operations listed
under a side section above (Execution and publication, Result and decision,
Presentations, Definition, Coordination) are Detail's, reached by its toggle
or by the focus card's links, which switch to Detail and open the section.

`test/runs.test.ts` ("operation parity") runs every operation once through the CLI module and once over HTTP, and requires the
same record apart from route and times.

`--expect-seq <n>` (browser: always sent) refuses an operation when the
record's last sequence is not `n`, so an answer typed against an outdated view
is not applied silently.

## Access

Repository bindings (`readonly` / `editable`) in the run's fixed definition
are path scopes ([contract.md](contract.md)) describing what each path is
for; `wfe run access <run> <path>` reports the declaration. Since p11 they
restrict nothing: the executor chooses what to change, and no operation
refuses a change under a `readonly` binding. The definition has no
allowed-command schema.

## Setup and entry point

`wfe setup <area>` writes the agent guide (`templates/AGENTS.md`) and the
person's `START.md` with the execution prompt, the run folder pattern, the
CLI (`wfe run help`) and the browser link. It keeps the registry, the
projects, the runs and any generated file whose stamp was removed.

## Observation

Monitors read [observation.md](observation.md) (`wfe observe`, `GET
/api/observe`): a read-only snapshot of every run with its process,
queue and wait facts. The rest of this section is about the browser views.

The service watches `devdocs/runs/*/*/run.json` (in each run's own copy for
runs that have one, p9) with the definition poll
(default 1 s, stat-based; a file is re-read only when its size, modification
time or inode changed) and lists each run folder's top-level files by stat,
without reading report bodies. It sends `run` change events with the run
reference; views re-read that run. Every (re)connection re-reads everything.
An open definition draft is not touched by run events.

No-update duration and an open browser connection say nothing about the
executor's health. Workflow progress and process health are separate.

## Future integration boundary

Project, run, node and question ids, holders and evidence references are
stable so that later adapters can link them to conversations,
messages (Zulip) and individual agent execution records (Observer,
`devpolicy/agent_records.md`). devdocs keeps durable input, plans,
definitions and results. Authority and synchronization are specified when
those adapters exist; there is no second state authority now.
