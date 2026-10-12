# Workflow editor file contract (p1, p2/pre1, p4, p5)

The definition files are the authority. The editor reads and writes them; it
keeps no database. A person or an agent can edit the same files with any text
editor, and the editor reflects those edits.

**Writers take turns.** The p1 editor assumes that UI edits and external file
edits do not overlap. It has no revision checks, merging or conflict
resolution. Its external-change guard (below) only keeps an unsaved UI draft
from being silently replaced.

## Where things live

| Information | Authority |
| --- | --- |
| Project schema, stable ID, name, devdocs storage mode, intent, goals | `project.yaml` at the project root |
| Submodule paths and source locations | `.gitmodules` at the project root |
| Recorded submodule revisions | Gitlinks in the root repository |
| Checkout, initialization, uncommitted changes | The workspace's Git state |
| Workflow definition, approvals, layout | `devdocs/workflows/*.yaml` |
| Registered workspaces and host settings | An ignored local registry (`registry.json`) |

A project is a Git repository, conventionally `pj-<name>`. `devdocs/` is
required: a directory of the root repository or a submodule, as
`project.yaml` declares (below). Other submodules may live under `study/`,
`wedo/` or any other path; those names categorize repositories and imply nothing about node
types or access. Every workspace has an ignored `.local/` directory.

`project.yaml` stays small. It does not copy repository URLs, branches,
commits or workspace lists. Workflows are discovered from
`devdocs/workflows/*.yaml` (and `*.yml`); a workflow is identified by its `id`,
not its file name.

## `ag.project.v2`

```yaml
schema: ag.project.v2
id: demo                 # stable; see "Identifiers"
name: Demo Delivery Project
devdocs: directory       # directory | submodule; fixed at creation
intent: |
  Why the project exists.
goals:
  - One goal per item.
```

## `ag.workflow.v2`

```yaml
schema: ag.workflow.v2
id: onboarding           # stable; delegates refer to it
name: Service Onboarding # display only
intent: |
  The author's intent. Everything else is reviewed against it.
documentation:
  policy: default        # default | manual (p5); see "Documentation policy"
repositories:            # binding key -> project-relative path and access
  tools: {path: study/tools, access: readonly}
  runtime: {path: wedo/runtime, access: editable}
  docs: {path: devdocs, access: editable}
  root: {path: ., access: readonly}
nodes:                   # node id -> node
  survey:
    type: study          # study | do | delegate | talk
    name: Survey         # short card label, optional
    description: What this step does.
    repositories: [tools]
  setup:
    type: delegate
    description: Run repository setup and wait for it.
    workflow: repo-setup # target workflow id (delegate only)
edges:
  - {from: survey, to: setup}
approvals:               # written by the editor's approval actions
  intent: {digest: "sha256:…", approver: someone, at: "2026-10-10T12:00:00.000Z"}
  definition: {digest: "sha256:…", approver: someone, at: "2026-10-10T12:00:00.000Z"}
layout:                  # optional; absent positions are laid out automatically
  nodes:
    survey: {x: 40, y: 60}
```

`ag.project.v1` (no storage mode) is not read: it is reported as an
unsupported schema, and such a project is registered again under v2.

`ag.workflow.v1` (no documentation policy) is not read as a valid
definition since p5: it is reported as a `schema` error that says what to
change (set `schema: ag.workflow.v2` and declare `documentation.policy`).
It still loads in the editor, so the change can be made there. Runs created
before p5 keep their v1 snapshot and their meaning ([runs.md](runs.md)).

### Documentation policy (p5)

`documentation.policy` says who decides when plans and reports are written.
It is required: a missing or unknown value is the error
`documentation-policy`, never a silent default. New workflows are created
with `default`.

| Policy | The run's effective graph |
| --- | --- |
| `default` | The authored graph plus generated documentation steps (below) |
| `manual` | Exactly the authored graph. No plan or report is generated, required or prompted for; an explicit node description or the person can still ask for documents |

The file keeps only what the author wrote: generated steps are never
inserted into the YAML. One compiler (`shared/compile.ts`, version
`ag.wfe-compile.v1`) produces the effective graph for both the editor's
preview and run creation. For `study → implement → check`:

```text
_plan → study → _report.study → implement → _report.implement
      → check → _report.check → _final-report
```

1. One plan talk (`_plan`) before every authored entry node.
2. One report step (`_report.<node>`) after every authored node.
3. Every authored dependency `A → B` becomes `A → _report.A → B`: a branch's
   report gates its own successors, and a join waits for every predecessor's
   report.
4. One final report (`_final-report`) after the reports of all authored
   terminal nodes.
5. Generated steps get no reports of their own.

Generated ids start with `_`, which no authored id can (see Identifiers), so
they never collide. Each generated step records its purpose, the authored
node it reports on (`for`), its document (`plan.md`, `report-<node>.md`,
`report.md`, run-relative) and the instructions the executing agent is
given. These step kinds are internal: they are not in the node palette and
cannot be authored.

The compiler refuses what is not an executable graph instead of letting
generated steps make it look executable: no nodes (`nodes-empty`), an edge
to an unknown node or to itself, a cycle, a malformed node id, or a missing
or unsupported policy. A delegate node compiles for the preview; runs of it
are still refused at creation.

### Execution, intake and result confirmation (p6)

Optional fields of a workflow, read by the execution host and the Zulip
intake. Credentials never appear here: they are host configuration.

```yaml
execution:
  agent: ppt-agent            # the identity runs are performed as (default: the execution host's name)
  profile: sonnet             # one of the execution host's profiles (default: the host's)
  guides: [agent/guide.md, agent/create.md]   # project-relative; added after the common contract
intake:
  zulip: requests             # the workflow's Zulip channel accepts request topics (docs/intake.md)
nodes:
  present:
    type: talk
    confirms: result          # the run's result-confirmation talk (docs/runs.md)
```

- A run records `executor: {name: <agent>, host: <execution host>}` at
  creation; the host owns its queue, attempts and publication.
- Each attempt reads `execution` from the run's **frozen** definition. The
  guides are read from the workspace at claim and recorded by hash with
  `attempt.begin` (`settings`), with the profile, the backend it resolved to
  and the host's common contract. A profile the host does not offer, or a
  guide that cannot be read, drops the job with the reason; nothing else is
  launched instead.
- `confirms: result` is valid on one talk node per workflow. The compiler
  (`ag.wfe-compile.v2`) keeps it in the frozen graph.

### Appearance (p7)

A node may say how it looks, independently of what it does:

```yaml
nodes:
  present:
    type: do
    name: Present
    appearance: {icon: present, color: teal}
```

| Field | Values | Default |
| --- | --- | --- |
| `icon` | `study`, `do`, `delegate`, `talk`, `present`, `cleanup`, `test`, `doc`, `build`, `review`, `flag` | the type's icon |
| `color` | `blue`, `amber`, `violet`, `teal`, `green`, `rose`, `slate`, `orange` | the type's color |

- Appearance is display only. It is not part of either approval digest,
  not part of the compiled graph and not read by any execution rule: the
  type, permissions, prompts and states of a node are what they were. A
  change of appearance alone leaves definition approval and plan agreement
  as they were and is never a run adjustment.
- Colors are named tokens of the editor's palette, not free CSS, so state
  stays readable: a custom color tints the card's head band and edge; the
  state line, its glyph and its text keep their own colors. Every state is
  still said in text and glyph.
- An unknown icon or color is a warning (`appearance-icon`,
  `appearance-color`) and is drawn with the type's default; the file keeps
  what was written.
- **Presets** in the editor's palette create ordinary nodes with an
  appearance and an editable starting name and description: *Present*
  (`do`, icon `present`, color `teal`) and *Clean up* (`do`, icon `cleanup`,
  color `slate`). What a presentation is lives in
  [presentations.md](presentations.md); the preset only makes the node
  recognizable.
- Run snapshots keep the YAML byte for byte, so a run view and a history
  view show the appearance the run was created (or adjusted) with.

### Template provenance (p7/ex1)

A node made from a template of the person's node catalog
([catalog.md](catalog.md)) records where it came from:

```yaml
nodes:
  research:
    type: study
    name: Preliminary research
    description: Research how this is usually done …
    template: {id: preliminary-research, revision: 2, expectation: "I expect a study node before …"}
```

`template` (`id`, `revision`, `expectation`) is provenance. Like appearance,
it is outside both approval digests and the compiled graph, and a change to
it alone is never a run adjustment. The node's type, name, description and
repositories are ordinary semantic fields. Editing the catalog never changes
a workflow, and a workflow never reads the catalog.

### devdocs storage modes (p4)

| Mode | What devdocs is | Owning repository and path |
| --- | --- | --- |
| `directory` (default for new projects) | a folder of the project root | the root repository, `devdocs/...` |
| `submodule` | a repository of its own, at `devdocs` | the devdocs repository, paths from its root |

Both use `devdocs/...` paths in the working tree. History reads and
publication go through one resolver (`server/devdocs.ts`) that names the
owning repository and the path inside it. A declaration that disagrees with
Git (`.gitmodules` lists devdocs, or not) is reported as
`devdocs-mode-mismatch` (`devdocs-mode-undeclared` when absent) and blocks
run creation; it is never converted, and the mode is not changed after
creation.

A historical reference names a repository and a commit: `<commit>` is a
commit of the owning repository; `root:<commit>` is a commit of the project
root, and in submodule mode its recorded devdocs gitlink is followed and
shown as such. Historical content never falls back to current files. To a
workflow, devdocs is a documentation area: a binding to `devdocs` is valid in
both modes; in directory mode it is a project resource, not a separate
repository.

### Identifiers

Workflow IDs, node IDs and binding keys match `^[a-z0-9][a-z0-9_.-]{0,63}$`.
IDs are stable: names and descriptions change without changing IDs. A delegate
resolves its target by workflow ID within the same project, independent of the
target's name or file name.

### Repository bindings

`path` is project-relative POSIX: `.` is the project root, `devdocs` the devdocs
area (either mode), anything else must be a submodule path in `.gitmodules`. Absolute
paths and `..` are invalid. A binding to a path that is not in `.gitmodules`
is reported as missing; a submodule that is not initialized in the current
workspace is reported as such (a warning — it depends on the workspace, not
the definition).

`access` is `readonly` or `editable`. It is a declaration and a restriction
on the editor's own operations, not filesystem isolation: external editors and
agents can still change a readonly repository. Access belongs to the workflow:
the same repository can be readonly in one workflow and editable in another.

Since p4, bindings are **path scopes**: the most specific binding whose path
contains a path governs it (`.` contains everything), so `root: readonly`
with `game: editable` leaves only `game/` editable. A run may always write its
own records (`devdocs/runs/<workflow>/<run>/`) — reporting, not permission to
edit source code, other runs or workflow definitions (`shared/access.ts`,
`wfe run access`). Restrictions are the executor's self-checks, never
described as OS-enforced.

### Node types and repository conventions

| Type | What the step is |
| --- | --- |
| `study` | Research: reading the web or files a person points to, and recording what was learned |
| `do` | General work: coding, running and testing, file operations |
| `talk` | Consulting a person, or an agent they entrusted, to agree on something or get permission |
| `delegate` | Running another workflow of the project (`workflow: <id>`). Definition and display only since p4: runs of a workflow with a delegate node are refused |

Submodules under `study/` conventionally accumulate the results of study
steps (repository names prefixed `study-`). Submodules under `wedo/`
accumulate what was learned while doing the work (prefixed `wedo-`).
Other paths are free. These are conventions for sharing knowledge between
workflows. They imply nothing about access, which each workflow declares in
its bindings. A node may bind no repository, and a binding that no node uses
is allowed.

### Graph semantics

An edge means that its target waits for its source to complete. Several
outgoing edges are parallel branches; a node with several incoming edges waits
for all of them. A delegate waits for its target workflow to complete; work
beside a delegate is another branch. Graphs must be acyclic. Runs (p3/pre1)
record execution against a fixed copy of a definition and check these rules
when nodes start and complete. See [runs.md](runs.md).

## Validation

Validation checks structure and references. It never claims that a graph
fulfils its intent.

| Code | Severity | Meaning |
| --- | --- | --- |
| `schema` | error | `schema` is not `ag.workflow.v2` (a v1 file is told what to add) |
| `documentation-policy` | error | `documentation.policy` missing or not `default` / `manual` |
| `id-missing`, `id-invalid`, `id-duplicate` | error | workflow ID absent, malformed, or used by another file |
| `intent-missing` | error | empty intent |
| `name-missing` | warning | empty display name |
| `binding-id-invalid`, `binding-access`, `binding-path-invalid` | error | malformed binding |
| `repository-missing` | error | binding path is not the root or a `.gitmodules` path |
| `repository-uninitialized` | warning | submodule exists but is not checked out here |
| `node-id-invalid`, `node-type` | error | malformed node |
| `node-binding-missing` | error | node refers to an undeclared binding key |
| `node-description-missing`, `node-binding-duplicate`, `nodes-empty` | warning | incomplete draft |
| `delegate-target-missing`, `delegate-target-unknown`, `delegate-self`, `delegate-recursive` | error | delegate target absent, not in the project, itself, or reaching back to itself |
| `delegate-not-executable` | warning | a delegate node: the workflow can be edited and shown, but no run of it is created |
| `workflow-on-non-delegate` | warning | `workflow` on a non-delegate node |
| `edge-from-missing`, `edge-to-missing`, `edge-self`, `graph-cycle` | error | broken or cyclic edges |
| `edge-duplicate`, `layout-orphan` | warning | redundant entries |
| `execution-agent`, `execution-profile`, `execution-guide-path` | error | malformed agent id, profile name or guide path (p6) |
| `execution-guide-duplicate` | warning | a guide listed twice |
| `intake-mode` | error | `intake.zulip` is not `requests` |
| `confirms-kind`, `confirms-type`, `confirms-duplicate` | error | `confirms` other than `result`, on a non-talk node, or on more than one node |

Drafts with errors can be saved. They cannot be approved.

## Supported YAML subset

One YAML 1.2 document per file, using block or flow mappings and sequences,
plain/quoted/block scalars, and comments. Mapping keys are plain text.

Rejected without rewriting the file: anchors (`&a`), aliases (`*a`), explicit
tags (`!!str`), merge keys (`<<`), several documents in one file, non-text
keys, and duplicate keys. Fields with the wrong shape (for example `nodes` as a
sequence) are also rejected. A rejected file is shown with its error and
cannot be saved from the editor until it is fixed by hand.

### What an edit preserves

The editor applies a model onto the parsed document instead of regenerating
the file:

- Fields the model does not know (top-level, per node, per binding) are kept.
- Comments, key order, flow/block style and block scalars of untouched
  entries are kept. An unchanged document is written back byte for byte.
- New entries take the style of the file's conventions: multiline text as
  `|` blocks; bindings, edges and layout points in flow style.
- Known normalizations by the YAML library: the spacing before a trailing
  comment becomes one space; flow collections are written without inner
  padding (`[a, b]`).
- A key absent from the file and empty in the model stays absent.

## Approvals and canonicalization

Two independent approval records, each storing the approved digest, the
declared approver and the time:

1. **Intent approval** covers `intent`.
2. **Definition approval** covers intent, the documentation policy,
   repository bindings (key, path, access), node IDs, types, names,
   descriptions, node repository bindings, delegate targets, and edges;
   and, when declared (p6), `execution`, `intake` and a node's `confirms`.

Excluded from both digests: workflow `id` and `name`, approvals, layout,
node appearance (p7), template provenance (p7/ex1), fields outside the contract, comments, key order and
YAML formatting.

Digest = `sha256:` + hex SHA-256 of the UTF-8 canonical JSON of a projection:

- Intent: `{"intent": T(intent), "kind": "ag.workflow.v1/intent"}`.
- Definition: `{"documentation": {"policy": …}, "edges": [[from, to], …],
  "intent": T(intent), "kind": "ag.workflow.v2/definition", "nodes": {id: {"description": T, "name": T,
  "repositories": [sorted, unique], "type": …, "workflow": id or null}},
  "repositories": {key: {"access": …, "path": normalized path}}}`; edges are
  de-duplicated and sorted by `from`, then `to`. When declared (p6), the
  projection also has `"execution": {"agent", "profile", "guides": [normalized
  paths]}`, `"intake": {"zulip"}` and a node's `"confirms"`; a workflow
  without them keeps the digest it had.
- Canonical JSON: keys sorted by UTF-16 code unit, no insignificant
  whitespace, standard JSON string escaping.
- `T(text)`: CRLF/CR become LF, trailing spaces/tabs on each line are removed,
  leading and trailing blank lines are removed. So `|` versus `|-` or an
  editor stripping trailing spaces does not change a digest.
- Paths are normalized (`./devdocs/` → `devdocs`).

A record is **approved** when its digest equals the current content's digest,
**stale** when it differs (the record is kept, not erased), and the kind is
**unapproved** when there is no record. Changing intent makes both stale; a
node description, edge or documentation policy change makes definition
stale; a layout change makes neither stale. The definition projection's kind
changed from `ag.workflow.v1/definition` to `ag.workflow.v2/definition` in
p5, so every definition approval recorded before p5 reads as stale; the
intent projection is unchanged.

Approvals are about the definition. They are not permission to execute,
acceptance of results, or an attestation of repository contents, and they do
not authenticate anyone: the approver is declared and the YAML can be edited
directly. Approval actions work on saved content without errors.

## Saving and external changes

- The filesystem is authoritative. The UI holds a draft until an explicit Save.
- Save writes the definition file only. It never commits or pushes.
- Saves write a temporary file in the same directory and rename it over the
  target, so a reader never sees a half-written file. This protects file
  integrity, not against a simultaneous external writer.
- While a browser view is open, the service watches the workspace and tells
  the UI what changed. It polls the definition files every second; a file is
  re-read only when its size, modification time or inode changed. It checks
  Git state every three seconds: HEAD, the index, uncommitted files in the
  root and in submodules, and submodule checkouts. Nothing is watched while no
  view is open. Each view also has a Refresh action that re-reads at once.
- Without unsaved UI changes the UI reloads automatically. With unsaved
  changes it keeps the draft, shows that the file changed, and offers an
  explicit reload that discards the draft.
- After the connection to the service drops, the view says that it is not
  live. When it reconnects, it re-reads everything, so edits made in between
  are shown.
- A deleted or renamed open workflow is shown read-only with that fact, and
  with a link when another file has the same workflow id. Nothing is
  recreated, and saving is refused.
- If the file on disk is malformed or unsupported, the UI keeps the last valid
  rendering read-only with the parse error, and the service refuses to save
  over the invalid file. Correcting the file restores editing.
- A failed save stays visible and the draft is kept for retry.
