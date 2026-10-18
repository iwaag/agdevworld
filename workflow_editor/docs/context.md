# Scoped context (workflow_editor p13)

What WFE gives an agent besides a run's own records, from which scope, and
from whose storage. One resolver (`server/context.ts`) serves every consumer:
a run's claim, the "next attempt" preview, the browser's editors and Context overview,
`wfe context` and an authoring session. Tool usage is in `wfe context --help`.

## The matrix

| Scope | Default (in the project's repositories) | Override (local, not in Git) |
| --- | --- | --- |
| System | the common execution contract (the execution host's, by hash at claim); for authoring, the authoring area's `AGENTS.md` and `docs/contract.md` (a reference) | `<area>/.local/contexts/system.md`: Developer-wide preferences, local environment guidance |
| Project | `project.yaml` intent and goals; `project.yaml` `guides` | `<area>/.local/contexts/projects/<project>/project.md` |
| Workflow | the workflow's intent; its `execution.guides` | `<area>/.local/contexts/projects/<project>/workflows/<workflow>.md` |
| Run | none: a run is created, not pre-authored | the run's input — its request, answers and instructions (run.json, `wfe run`) |

Run input keeps its own contract: `braindump.md` is the person's original
request and may be committed with the run; it is not a preference store, and
there is no run-level override editor.

**Default and override describe ownership and storage, not precedence.**
Each source is shown with its scope and provenance, and the agent reads it as
an instruction of that breadth: an explicit request or a more specific
instruction refines a general one ("English unless otherwise requested" does
not erase a project whose deliverable is Japanese). Nothing parses prose into
settings, and WFE does not claim to resolve semantic conflicts. Clearing an
override removes its contribution; inherited defaults stay.

## Sources

A bundle (`shared/context.ts`, `ag.wfe-context.v1`) lists sources, each with:

| Field | Meaning |
| --- | --- |
| `key` | `system/contract`, `system/authoring`, `system/override`, `project/intent`, `guide/<path or project:path>`, `project/override`, `workflow/intent`, `workflow/override`, `run/input`, `run/record` |
| `scope`, `category` | system/project/workflow/run; default/override/input |
| `applies` | `execution`, `authoring`: the execution contract is for run executors only, the authoring entry for IDE sessions only; everything else applies to both |
| `origin`, `provenance` | file, project and commit (a cross-project guide), revision and author (an override); every declaration naming it |
| `delivery` | `body` (in the text), `reference` (named, not included — "reference supplied" does not mean "agent read it"), `absent` (nothing configured), `error` (configured but unreadable) |
| `sha256` | of the delivered body or the referenced file |

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
- **Absence and errors.** A missing override contributes nothing. A
  configured source that cannot be read is an `error` source; an attempt is
  not prepared while one is (the job is dropped with the reason, as a missing
  guide always was).

## The override store

`server/contextStore.ts`, in the WFE area's ignored `.local/contexts/`, the
one authority for overrides (browser, CLI, a later Zulip entrance alike):

- each override's `<file>.revisions.jsonl` beside it records every revision:
  number, author, time, sha256 and exact content (`null` for a removal);
- a write names the content it replaces (`base`: its sha256, or none); a
  different current content refuses it (`409 context-conflict`, with the
  current state), so an unseen revision is never overwritten;
- a file edited by hand is kept as an external revision before the next write;
- project and workflow ids are validated (`ID_PATTERN`) and resolve inside
  the store; an override is at most 64 KiB (larger material belongs in a file
  the override names).

The system scope is this one WFE area, not an OS account. Operational
configuration is not duplicated in prose: shared storage is `shares.json`
and `shared://` references (docs/shares.md), cluster state is Nautobot/nctl;
an override explains purpose and usage.

## Execution

1. **Claim** resolves the bundle once, renders its text
   (`renderContext`), and saves both as one content-addressed snapshot,
   `<area>/.local/contexts/snapshots/ctx-<hash>.json`. `attempt.begin`
   records `settings.context = {snapshot, fingerprint, sources: [{key, scope,
   category, delivery, sha256}]}` — no override text, no host path. The claim
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
5. **Saving an override** affects the next attempt of each affected run. It
   never interrupts or changes an open attempt, and it starts or resumes
   nothing. Steering current work is an additional instruction (the run
   view's *Add an instruction for this run*, a post in the request
   conversation, or `wfe run instruct`).
6. **Delegation.** A child run resolves its own project and workflow: the
   parent's overrides do not reach it; its request carries the delegated
   work explicitly.

Snapshots and overrides stay in the area's `.local/`, outside every run copy,
checkpoint, publication and integration. Another host reading a run sees the
snapshot id and reports the snapshot as unavailable; it is never rebuilt from
today's settings. (An agent can still quote an instruction in a file it
writes; that is its output, not the store.)

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

## Where it is edited in the browser (p13 ex1)

Context is part of each editor, in Simple and in Detail alike; a display
switch changes how much provenance is shown, not what can be done.

| Editor | Context section |
| --- | --- |
| Home (`#/home/context`) | *Instructions for all projects* (the system override); no project is chosen |
| Project (`#/ws/<ws>/context`) | *Shared with this project*: purpose, goals and `guides` of `project.yaml` (the editor's one draft and *Save project.yaml*), with each guide's content; *Your instructions for this project* (override); *Inherited instructions* (all projects), editable in place |
| Workflow (`#/ws/<ws>/wf/<file>/context`) | *Shared with this project*: the intent and `execution.guides` (the editor's draft and Save); *Your instructions for this workflow*; inherited project purpose, goals, guides and instructions, and the instructions for all projects; *What a new run is given (saved settings)* |
| Run (the *Context* card) | the original request (read only); *Instructions for this run* with *Add an instruction* (`instruction.receive`); *Used for this attempt*; *Changes for the next attempt*; *Settings for future attempts* (the workflow, project and system overrides, in place); Detail: every attempt |

- One value has one control: the intent and goals live only in Context;
  *Intent & approvals* shows the saved intent it approves.
- Definition values save with their file; each override has its own Save.
  No single save writes both; each reports its own result. A view's
  navigation guard counts both kinds of draft, and a live refresh never
  replaces a draft (a newer saved override is announced, and saving then
  asks which to keep).
- Editing a wider scope from a narrower editor names the wider scope and
  never creates a narrower override.
- `#/context[/<ws>[/<workflow>]]` is the overview: the scope matrix, links
  to the owning editor's section, a quick edit with the same editor, and
  the resolved text.

## Read surfaces

| Surface | What |
| --- | --- |
| `GET api/context?workspace=<id>[&workflow=<id>]` | the matrix: the three overrides' state, the authoring bundle and the execution preview with their rendered text |
| `GET api/context/override?scope=&project=&workflow=` / `PUT` `{scope, project?, workflow?, text\|null, base, by, note?}` | an override and its revisions; a write |
| `GET api/context/overrides` | every override set in the area |
| `GET api/workspaces/<ws>/runs/<wf>/<run>/context` | each attempt's recorded context, snapshot (or why unavailable) and delivery; the next attempt's bundle; the differences; what the session would do |
| `wfe context show\|get\|set\|clear\|history\|run\|list` | the same from the CLI |

Tests: `test/context.test.ts`.
