# Scoped context (workflow_editor p13, p14)

What WFE gives an agent besides a run's own records, from which scope, and
from whose storage. One resolver (`server/context.ts`) serves every consumer:
a run's claim, the "next attempt" preview, the browser's editors and Context overview,
`wfe context` and an authoring session. Tool usage is in `wfe context --help`.

## The matrix

| Scope | Default (in the project's repositories) | Local (this WFE area, not in Git) |
| --- | --- | --- |
| System | the common execution contract (the execution host's, by hash at claim); for authoring, the authoring area's `AGENTS.md` and `docs/contract.md` (a reference) | blocks in `<area>/.local/contexts/system/`: e.g. the Developer's instructions and cagent's cluster summary |
| Project | `project.yaml` intent and goals; `project.yaml` `guides` | blocks in `<area>/.local/contexts/projects/<project>/project/` |
| Workflow | the workflow's intent; its `execution.guides` | blocks in `<area>/.local/contexts/projects/<project>/workflows/<workflow>/` |
| Run | none: a run is created, not pre-authored | the run's input — its request, answers and instructions (run.json, `wfe run`) |

Run input keeps its own contract: `braindump.md` is the person's original
request and may be committed with the run; it is not a preference store, and
there is no run-level block editor.

**Default and local describe ownership and storage, not precedence.**
Each source is shown with its scope and provenance, and the agent reads it as
an instruction of that breadth: an explicit request or a more specific
instruction refines a general one ("English unless otherwise requested" does
not erase a project whose deliverable is Japanese). Nothing parses prose into
settings, and WFE does not claim to resolve semantic conflicts. Environment
information is delivered as facts and advice, labelled apart from
instructions. Removing a block removes its contribution; inherited defaults
stay.

## Sources

A bundle (`shared/context.ts`, `ag.wfe-context.v1`) lists sources, each with:

| Field | Meaning |
| --- | --- |
| `key` | `system/contract`, `system/authoring`, `system/block/<id>`, `project/intent`, `guide/<path or project:path>`, `project/block/<id>`, `workflow/intent`, `workflow/block/<id>`, `run/input`, `run/record` (p13 snapshots: `<scope>/override`) |
| `scope`, `category` | system/project/workflow/run; default/override (a local block)/input |
| `applies` | `execution`, `authoring`: the execution contract is for run executors only, the authoring entry for IDE sessions only; everything else applies to both |
| `origin`, `provenance` | file, project and commit (a cross-project guide), the store's logical file (a block); every declaration naming it |
| `delivery` | `body` (in the text), `reference` (named, not included — "reference supplied" does not mean "agent read it"), `absent` (nothing configured), `error` (configured but unreadable) |
| `sha256` | of the delivered body (a block: its rendered section) or the referenced file |
| `block` | a block's id, kind, manager, last editor, revision, evidence, check, failed refresh, details and consultation workflow |

- **Guides.** `project.yaml` `guides` (since p13) are inherited by every
  workflow of the project; a workflow's `execution.guides` add its own. Both
  use the same notation (a project-relative path, or `<project>:<path>` read
  from that project's committed main, its commit recorded). A guide named by
  both is one source with both declarations, delivered once. A guide that
  several workflows reference is not promoted to project scope by WFE; the
  project declares it.
- **Where a run's defaults come from.** Its own copy of the project
  (`project.yaml`, own guides) and its definition in force (frozen, or the
  active adjusted revision). Overrides come from the owning area's current
  settings. Authoring reads the selected project workspace and workflow file;
  a workflow without an identity yet gets system and project context only.
- **Order.** System, project, workflow; within a scope the defaults first,
  then its blocks: instructions before information, each by id.
- **Absence and errors.** A scope without blocks contributes nothing; a
  removed block contributes nothing (its history stays). A block or a
  configured source that cannot be read is an `error` source; an attempt is
  not prepared while one is (the job is dropped with the reason, as a missing
  guide always was).

## Local context blocks (p14)

Each scope holds any number of **independently managed blocks**. The system
scope is this one WFE area. Examples: a Developer instruction block and a
cagent cluster summary in the system scope; the forge project's human
guidance and a separate cagent resource-advice block in its project scope.
Any agent can use the same model.

| Field | Meaning |
| --- | --- |
| `id` | stable within its scope (`ID_PATTERN`) |
| `title` | one line |
| `kind` | `instruction` (guidance to follow) or `information` (facts and advice about the environment) |
| `manager` | who maintains the block (default: its first writer) |
| `editor` | who last changed what it delivers, when, from which run (`run`) and by which entrance (`via`) |
| `body` | Markdown, at most 64 KiB |
| `evidence` | `{ref, basis, status, observed?, coverage?, title?}[]` — see *Evidence and age* |
| `consult` | `<project>/<workflow>` where to ask the manager (e.g. `cagent/consult`) |
| `details` | named documents read on demand (`context:<scope>/<block>/<name>`), content-addressed |
| `checked` | the latest verification that the content still holds (bookkeeping) |
| `refresh` | the latest refresh that failed or was partial |

Manager and last editor are records, **not authentication claims or write
permissions**: anyone may edit any block (a human may correct cagent's), and
both are shown everywhere. Editing never changes the manager unless asked.

### The store

`server/contextStore.ts`, in the WFE area's ignored `.local/contexts/`, the
one authority (browser, CLI, the service's HTTP API alike):

    system/<block>.json                       projects/<p>/project/<block>.json
    projects/<p>/workflows/<w>/<block>.json   … each with <block>.revisions.jsonl
    <block>.details/<sha256>                  snapshots/ctx-<hash>.json

- **One file per block**, replaced atomically under a per-block lock: an
  update to one block never rewrites its siblings.
- **Revisions.** `<block>.revisions.jsonl` records every operation — `set`,
  `check`, `refresh`, `remove`, `external` (found edited by hand),
  `converted` — with who, when, run, entrance, note and the block as it was
  after it. History is per block; human edits inside an agent-managed block
  are revisions like any other.
- **Optimistic concurrency.** A write that changes content names the
  content revision it read (`base`; `0` for a new block; `wfe context get`
  prints it). A different current content revision refuses the write
  (`409 context-conflict`, with the current state): an unseen edit is never
  overwritten. A writer that read the current revision may revise it
  deliberately; there is no approval step. Checks and failed refreshes do
  not change the content revision writers base on.
- **Idempotent publication.** Writing exactly what is there (title,
  manager, kind, body, evidence, details, consultation, refresh state) is no
  revision and no conflict.
- **Hand edits** of a block file are recorded as an `external` revision
  before the next write; a writer who read the hand-edited state names its
  revision (`base` = revision + 1).
- **Conversion from p13.** The p13 single overrides (`system.md`,
  `projects/<p>/project.md`, `projects/<p>/workflows/<w>.md` with their
  revisions) are converted once, on first use, into a Developer-managed
  instruction block `developer` of the same scope, keeping every revision,
  and moved to `contexts/archive/p13/`. Nothing reads or writes the old
  files afterwards; there is one writable store.
- Project, workflow, block and detail ids are validated and resolve inside
  the store; a detail is at most 1 MiB.

The system scope is this one WFE area, not an OS account. Operational
configuration is not duplicated in prose: shared storage is `shares.json`
and `shared://` references (docs/shares.md), cluster state is Nautobot/nctl;
a block explains purpose, usage and relevance of that state.

### Writing blocks

| CLI (`wfe context …`) | HTTP |
| --- | --- |
| `list [<scope>] [--all]` | `GET api/context/blocks?scope=&project=&workflow=` · `?all=1` |
| `get <scope> <block>` · `history <scope> <block>` | `GET api/context/block?scope=&project=&workflow=&block=` (state and revisions) |
| `set` · `check` · `refresh-failed` · `remove` | `PUT api/context/block` `{op: set\|check\|refresh\|remove, scope, project?, workflow?, block, base, by, run?, attempt?, note?, …fields}` |
| `detail <context:…>` | `GET api/context/detail?ref=` (`&raw=1`: the text itself) |

- **Explicit targets.** A write names its scope, `--project` (required for
  project and workflow writes: a run copy's own project is never assumed),
  `--workflow`, the block and `--base`. Every result names where it was
  written.
- **Remote writers.** `--service <url>` or `WFE_SERVICE` sends every block
  command to that WFE service (the area's published editor address), so a
  writer on another host reaches the authoritative store instead of a local
  copy. Without it the CLI uses the launcher's area (`WFE_AREA`). Writes
  without an `Origin` header (CLI, scripts) are accepted like the page's own.
- **Provenance.** An executing attempt's writes carry `WFE_ATTEMPT`; the
  service records the attempt's run (`<workspace>/<workflow>/<run>`) as the
  editor's `run`. `--run` names it explicitly. Only identities are recorded;
  no block text enters any run record.

### Evidence and age

Three times are kept apart: **publication** (`editor.at`, when the content
was written), **observation** (`evidence[].observed`, when the source itself
was observed — given by the writer, never filled with the publication time)
and **verification** (`checked.at`, a later check that the content still
holds).

- `basis`: `observed` (collected from the cluster), `reported` (someone said
  so), `desired` (declared intent: a placement, a converged drift — not an
  application-level test), `recommendation` (advice).
- `status`: `ok`, `partial` (coverage incomplete — say what in `coverage`),
  `failed` (the observation failed), `unknown`.
- An information block without evidence is delivered as unverified.
- **A failed refresh** (`refresh-failed`, `--partial` for a partial one)
  keeps the last successful content and evidence and delivers the failure
  with its day and detail. It is never an empty replacement; a block with no
  content refuses it. A later `set` with evidence clears it.
- An unreadable store is not a failed refresh: it is an `error` source
  under the explicit error contract above.

### What is delivered, and what is bookkeeping

A block delivers exactly its rendered section (`renderBlock`): the scope
and kind (`System instruction`, `Project environment information`, …), the
title, *facts and advice, not instructions* for information, the manager,
the last editor with the day and run, every evidence reference with its
basis, observation time (to the minute), status and coverage, a failed or
partial refresh with its day and detail, the detail references, the
consultation workflow, then the body. The source's `sha256` is the hash of
that section, so:

- **changes that affect decisions change delivery and the fingerprint**:
  facts (body), meaning (kind, title, manager), freshness (evidence times
  and statuses, a refresh failure or its clearing), the routes (details,
  consultation), and who last edited it on which day;
- **bookkeeping does not**: a check, revision numbers, the time of day of an
  edit, detail contents (read on demand), the history. A recheck of
  unchanged facts is a `check` and keeps every session.

No age is computed into the prompt (times are absolute); the browser shows
ages from the recorded times. Each attempt's snapshot keeps the exact
section, so it explains the evidence available when the attempt was
prepared.

### Detail and consultation routes

- **Details** are read on demand, never expanded into prompts:
  `wfe context detail context:<scope>/<block>/<name>` or `GET
  api/context/detail?ref=` on the area's service (from the executor and the
  browser alike, without any host path). A full inventory belongs here, not
  in the body.
- **Consultation**: `consult: <project>/<workflow>` names a workflow that
  answers questions (cagent's is `cagent/consult`): a delegate node to it,
  or a request in its channel `wf-<project>.<workflow>`.
- Existing read routes stay authoritative for their content: `wfe projects
  read|run` (managed project files and run files), `shared://` (shares).

## Execution

1. **Claim** resolves the bundle once, renders its text
   (`renderContext`), and saves both as one content-addressed snapshot,
   `<area>/.local/contexts/snapshots/ctx-<hash>.json`. `attempt.begin`
   records `settings.context = {snapshot, fingerprint, sources: [{key, scope,
   category, delivery, sha256}]}` — no block text, no host path. The claim
   hands the executor `execution.context.text`, the snapshot's exact bytes,
   so preview, record and launch payload cannot disagree.
2. **The prompt** of a new session is the host's common contract, then that
   context text, then the brief (autolab `wfexec`). The project's guides are
   no longer appended separately.
3. **Delivery.** After writing the prompt to the harness the executor records
   `attempt.context delivered` (`wfe exec context <attempt> --delivered`);
   a launch that failed first records `undelivered` with the reason. That is
   delivery, not proof of comprehension or use.
4. **Sessions** (docs/sessions.md). The session configuration includes the
   context fingerprint and its effective sources (everything but run input
   and the common contract, which has its own hash). An unchanged bundle
   resumes; a changed one starts a new session on the next attempt, and the
   replacement reason names each source added, changed or removed. An edit
   that leaves content unchanged (metadata only) keeps the session. A
   reconstruction after compaction gives the whole bootstrap, the same
   context included. Sessions recorded before p13 (guides only) are replaced
   once.
5. **Saving a block** affects the next attempt of each affected run. It
   never interrupts or changes an open attempt, and it starts or resumes
   nothing. Steering current work is an additional instruction (the run
   view's *Add an instruction for this run*, a post in the request
   conversation, or `wfe run instruct`).
6. **Delegation.** A child run resolves its own project and workflow: the
   parent's blocks do not reach it; its request carries the delegated work
   explicitly.

Snapshots and blocks stay in the area's `.local/`, outside every run copy,
checkpoint, publication and integration. Another host reading a run sees the
snapshot id and reports the snapshot as unavailable; it is never rebuilt from
today's settings. A p13 snapshot (`ag.wfe-context.v1`) stays readable. (An
agent can still quote a block in a file it writes; that is its output, not
the store.)

## What WFE does not control

The WFE bundle is not the whole model prompt. Also present:

- the executor's common contract (autolab `agent/guides/wfrun/guide.md`),
  composed by the host and recorded by hash;
- the brief and continuation (run state, pending answers and instructions in
  full, catalog, documentation steps);
- whatever the harness loads itself: Claude Code reads `CLAUDE.md` files of
  the working directory's ancestors, user settings and their hooks; codex reads
  `AGENTS.md` up the tree. A run copy lives under
  `<area>/<workspace>/.local/wfe/runs/…`, so the area and the workspace must
  not hold such files (the installed authoring entry is therefore in
  `<area>/authoring/`, not an ancestor of any run copy);
- an IDE session's own configuration. WFE does not launch IDE sessions: the
  authoring context is available (`wfe context show`, the Context overview's
  copy action), never verified as injected.

## Where it is edited in the browser (p13 ex1, p14)

Context is part of each editor, in Simple and in Detail alike; a display
switch changes how much provenance is shown, not what can be done.

**Block cards (p14).** Every local block is a card of its own: its title,
its kind (*Instruction* or *Environment information*), the scope it really
lives in, *Managed by* and *Last edited by* (with the age and the producing
run), for information its freshness (the oldest observation's age, partial
or failed coverage, the latest check), a failed refresh, and its size (the
body's lines — five or fewer for all projects — and the delivered bytes),
then its content with links to its details and whom to ask. Detail adds the
store file, revisions and section hash, the evidence references (a
`context:` detail opens as text), the check and refresh records, and the
whole history. Each card has its own Edit, Save, Remove and result; a
draft survives refreshes, display switches and navigation prompts; a
conflicting save shows what is saved now and offers *Use the saved text* or
*Save mine over it*. Editing someone else's block says whose it is and
that the edit stays in its history — ownership is visible, not enforced.

| Editor | Context section |
| --- | --- |
| Home (`#/home/context`) | *For all projects*: the system blocks (the Developer's instructions, cagent's cluster summary, …), *+ Add an instruction*, *+ Add environment information* |
| Project (`#/ws/<ws>/context`) | *Shared with this project*: purpose, goals and `guides` of `project.yaml` (the editor's one draft and *Save project.yaml*), with each guide's content; *For this project, only in this environment* (the project's blocks); *Inherited*: the system blocks, editable in place |
| Workflow (`#/ws/<ws>/wf/<file>/context`) | *Shared with this project*: the intent and `execution.guides` (the editor's draft and Save); the workflow's blocks; inherited project purpose, goals and guides, the project's blocks and the system blocks; *What a new run is given (saved settings)* |
| Run (the *Context* card) | the original request (read only); *Instructions for this run* with *Add an instruction* (`instruction.receive`); *Used for this attempt* (each block by kind, title and manager); *Changes for the next attempt* (the blocks added, changed or removed, by title); *Settings for future attempts* (*Workflow context*, *Project context*, *Context for all projects*: the block lists in place); Detail: every attempt |

- One value has one control: the intent and goals live only in Context;
  *Intent & approvals* shows the saved intent it approves.
- Definition values save with their file; each block has its own Save.
  No single save writes both; each reports its own result. A view's
  navigation guard counts both kinds of draft, and a live refresh never
  replaces a draft (a newer saved block is announced, and saving then
  asks which to keep).
- Editing a wider scope from a narrower editor names the wider scope and
  never creates a narrower block. An inherited card names its scope.
- `#/context[/<ws>[/<workflow>]]` is the overview: the scope matrix (each
  local cell lists its blocks with kind, manager and last editor), links to
  the owning editor's section, a quick edit with the same cards, and the
  resolved text.

## Read surfaces

| Surface | What |
| --- | --- |
| `GET api/context?workspace=<id>[&workflow=<id>]` | the matrix: the three scopes' blocks, the authoring bundle and the execution preview with their rendered text |
| `GET api/context/blocks…`, `GET`/`PUT api/context/block`, `GET api/context/detail?ref=` | blocks, one block and its revisions, a write, a detail (*Writing blocks*) |
| `GET api/workspaces/<ws>/runs/<wf>/<run>/context` | each attempt's recorded context, snapshot (or why unavailable) and delivery; the next attempt's bundle; the differences; what the session would do |
| `wfe context show\|list\|get\|set\|check\|refresh-failed\|remove\|history\|detail\|run` | the same from the CLI (`--service` for another host) |

Tests: `test/context.test.ts`; browser: `checks/contextBlocks.ts` (p14), `checks/contextEditors.ts`, `checks/context.ts`.
