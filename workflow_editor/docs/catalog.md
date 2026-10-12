# User node catalog (p7/ex1)

Whether an activity is its own workflow node or a part of another one is a
design choice, and people differ in what they expect to see. The **node
catalog** is where a person states that choice once: the activities they
recognize as distinct workflow steps, each as a reusable node **template**
over an existing node type. The catalog is a statement of the person's
expectations, plus the tools to act on them. It does not force an expansion of
the graph. A designer (a person in the editor or an agent planning a run) still
decides whether and where an activity becomes a node.

Origin: the RTS `improve-game/run-004` trial (2026-10-12). The person asked
for Web research before the implementation. The agent did one search,
summarized it in `plan.md` without a study node and kept no sources, and the
implementation report it pointed to did not contain the research. Asking for
research once in a braindump did not tell the agent that this person expects
research to be a visible step.

## Where it lives

| Information | Authority |
| --- | --- |
| The person's templates | `<area>/node-catalog.json`, beside `registry.json` in the operating area |
| A workflow node made from a template | the workflow file, as an ordinary node with `template` provenance |
| What a run was given | `<run>/context/node-catalog.json`, frozen at creation, by hash in `run.json` |

`<area>` is the operating area chosen by the explicit registry (`--registry` /
`WFE_REGISTRY`; the area's `bin/wfe` sets it). There is no default catalog
and no second catalog. The file is user data. It is outside every managed
project workspace and outside the installed release, so a new release does
not replace it. Its contents are portable preferences: names, descriptions
and display tokens. It never holds host facts, paths, ports, credentials or
repository names. Machine-specific settings stay in their own files
(`present.json`, `zulip.json`, `gitea.json`).

There is one catalog per operating area, for its current user. Accounts,
per-project inheritance, dependencies between templates and a general
resource system are not part of p7/ex1.

## `ag.node-catalog.v1`

```json
{
  "schema": "ag.node-catalog.v1",
  "generation": 7,
  "initialized": { "by": "workflow_editor p7/ex1", "at": "2026-10-12T10:00:00.000Z", "seeded": ["present", "cleanup"] },
  "templates": [
    {
      "id": "preliminary-research",
      "revision": 2,
      "name": "Preliminary research",
      "type": "study",
      "description": "Research how this kind of change is usually done before implementing it …",
      "expectation": "When I ask for research before work, I expect a study node before the work it informs.",
      "appearance": { "icon": "study", "color": "violet" },
      "updated": "2026-10-12T10:05:00.000Z",
      "by": "iwaag"
    }
  ],
  "deleted": [ { "id": "old-review", "revision": 3, "at": "2026-10-12T10:06:00.000Z", "by": "iwaag" } ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Stable identity (`^[a-z0-9][a-z0-9_.-]{0,63}$`). It never changes. An id that was deleted is not reused (`deleted`), so provenance in old workflows never points at a different template |
| `revision` | 1 at creation, +1 whenever the template's content (name, type, description, expectation, appearance) changes. A save that changes nothing keeps the revision |
| `name` | The card label of nodes made from it. Required |
| `type` | `study`, `do` or `talk`, the existing execution types. `delegate` is refused (`template-type`): a delegate needs a target workflow of one project, and a template must not suggest that delegate execution exists |
| `description` | For the agent **performing** the activity: what to do and what to record. Copied into the node's `description`. Required |
| `expectation` | For the agent or person **designing** the workflow: how the person expects this activity to appear. Required. It is not copied into the executed description |
| `appearance` | Optional p7 tokens (`icon`, `color`; contract.md, *Appearance*). In the catalog an unknown token is an error, not a warning, because the catalog is written only through validated operations |
| `updated`, `by` | When the content last changed and who declared the change |

Catalog fields: `generation` is +1 on every successful write. `initialized`
records the one-time initialization (below). `deleted` lists retired ids.

### Type-specific fields

A template has no type-specific fields. When a node is made from a template,
its type-specific fields come from the target workflow:

- `repositories`: chosen at instantiation from the target workflow's
  declared binding keys. An unknown key is refused (`template-binding`).
  Instantiation never declares a binding, so it never grants access.
- `workflow` (delegate target): never set. Templates are not delegates.
- `confirms: result`: never set. A workflow has one result confirmation,
  and the designer marks it on the node.

## Reading and writing

The browser (HTTP), the CLI (`wfe nodes`) and run creation all call the same
operations (`server/catalog.ts`), with the same validation.

| State of the file | Read result | Writes |
| --- | --- | --- |
| absent | initialized first (below), then `ok` | — |
| valid `ag.node-catalog.v1` | `ok` with the templates (an empty list is `ok` with none) | allowed |
| unreadable, malformed JSON, another schema, invalid content | `unavailable` with the problem | refused; the file is never replaced by defaults |

- **Writes** read the file, check it, apply one change, validate the result
  and replace the file atomically (temporary file, rename), all under a
  cross-process lock (`server/lock.ts`).
- **Stale edits.** An update or a deletion names the revision it was based on
  (`expectRevision`) and is refused (`template-stale`) when the template has
  moved on. A creation is refused when the id exists or was deleted
  (`template-exists`, `template-retired`).
- **Initialization.** The first operation that finds no file creates it
  exclusively (it never overwrites a file that appeared meanwhile). It holds
  the two p7 palette presets as templates, `present` (*Present*: `do`,
  `present`/`teal`) and `cleanup` (*Clean up*: `do`, `cleanup`/`slate`), with
  their existing descriptions and an expectation each. It records
  `initialized`. Since the file then exists, a later release never seeds
  again, so deleting or editing these templates sticks. The palette has no
  built-in presets any more: they are catalog entries.
- **Examples.** A *Preliminary research* example is offered (UI: "Add
  example", CLI: `wfe nodes example`), never added by itself. Choosing it
  creates an ordinary template that the person edits. No preference is
  declared on the person's behalf.

## Instantiation

`instantiate(workflow, template, options)` (`shared/catalog.ts`) is a pure
function. The browser applies it to its draft, and the CLI and HTTP route
apply it to a saved file or to a draft of a run revision. It produces an
ordinary node:

```yaml
nodes:
  research:
    type: study
    name: Preliminary research
    description: |
      Research how this kind of change is usually done …
    repositories: [rts]
    appearance: {icon: study, color: violet}
    template:
      id: preliminary-research
      revision: 2
      expectation: |
        When I ask for research before work, I expect a study node …
```

- **Node id.** By default it is the template id, made unique in the workflow
  (`research`, `research-2`, …). An explicit id that is taken is refused.
- **Copied content.** Type, name, description and appearance are copied.
  The node is then edited like any other. Editing it never touches the
  catalog, and editing the catalog never touches the node.
- **Provenance** (`template`: `id`, `revision`, and the `expectation` at
  that revision) records where the node came from. The expectation is kept
  so that the node can still be explained after the template changes or is
  deleted. Provenance is not executable meaning.
- **Placement** (optional): `after` and `before` node ids add edges, so a
  node can be inserted between two others (`--after _ --before implement`).
  Without them the node is unconnected, as the palette's other additions are.
- YAML round trip, node copy and run snapshots keep `template` as written.
  A hand-written `template` with the wrong shape is a shape problem. An
  unknown `template.id` is not an error: the catalog is a source of copies,
  not a dependency.

### Digests, approvals, adjustments

| Part of a node | Definition digest, plan, adjustment |
| --- | --- |
| `type`, `name`, `description`, `repositories` (copied or edited) | semantic, as before: a change makes definition approval stale and is an executable change in an adjustment |
| `appearance` | display only (p7) |
| `template` (provenance) | outside both digests and the compiled graph. A change of provenance alone leaves approval as it was and is not an adjustment (`adjust-nothing`). The provenance of started work cannot be rewritten in an adjustment (`adjust-started`) |

The compiler is unchanged (`ag.wfe-compile.v2`): a node made from a template
compiles exactly as a node written by hand with the same type and edges.

## A run's catalog snapshot

**At creation** every entrance (`wfe request`, the dashboard and Project
Editor request, Zulip intake, `wfe run create`) reads the operating area's
catalog through the shared read and freezes it:

| Catalog | `run.json` `context.catalog` | File |
| --- | --- | --- |
| `ok`, templates | `{state: "supplied", file: "context/node-catalog.json", sha256, generation, templates: <n>}` | the snapshot |
| `ok`, empty | the same with `templates: 0` | an explicit empty snapshot |
| `unavailable` | `{state: "unavailable", problem}` | none |

The snapshot file (`ag.node-catalog-snapshot.v1`) holds `generation`, the
time it was taken and the templates (id, revision, name, type, description,
expectation, appearance). `initialized` and `deleted` are not part of it.
Reading a run checks the file against its `sha256`, like the definition
bundle. A missing or changed snapshot makes the record unusable (`bundle`)
and is never re-read from the live catalog.

An unavailable catalog does not refuse the run: the work the person asked for
goes on. The record, the run view, `wfe run show` and the agent's brief all
say that the person's expectations could not be read and why.

**Attempts.** Every attempt, first or resumed, is given the run's snapshot
and never the live catalog. `attempt.begin`'s `settings` records it
(`catalog: {sha256, templates}` or `{state: "unavailable"}`), beside the
contract and guides it already records by hash. A catalog edit after creation
affects new runs only.

**Delivered.** The brief (`server/exec.ts`) states the meaning once:

> The person recognizes these activities as distinct steps. When relevant to
> this request, they generally expect them to be visible as workflow nodes.
> Choose whether and where to represent them using the request and the
> current workflow.

It then lists each template's id, name, type and expectation, and names the
tools. Their usage lives in their help:

- `wfe run nodes <run> [--show <id>]`: the run's snapshot, with each
  template's full description.
- `wfe nodes instantiate <template> --run <run> --file <draft>`: a node from
  the snapshot into a draft of the run's definition, which `wfe run adjust`
  then applies (adjustments.md).
- `wfe run help adjust`: the adjustment overview.

**Runs created before p7/ex1** have no `context.catalog`. They are shown as
"no catalog was supplied" and are not converted. No completed run is changed
to claim that it received a catalog.

## Original-request adjustments

A run's initial request can authorize future-work changes it already asks
for, such as "research before implementing". The adjustment source is
`{kind: "request"}`, bound to the run's input (adjustments.md, *Who
authorizes it*). This states why the change was made. It is not the person's
approval of a particular graph. Plan agreement stays a separate record, and a
material change of scope still needs `agreement`.

## Interfaces

| Operation | CLI | HTTP | Browser |
| --- | --- | --- | --- |
| List, show | `wfe nodes list`, `wfe nodes show <id>` | `GET /api/nodes` | dashboard → User nodes |
| Create | `wfe nodes create <id> --name … --type … --description … --expectation … [--icon --color]` | `POST /api/nodes` | User nodes → New |
| Update | `wfe nodes update <id> --expect-revision <n> [fields]` | `PUT /api/nodes/<id>` | User nodes → Edit |
| Delete | `wfe nodes delete <id> --expect-revision <n>` | `DELETE /api/nodes/<id>?revision=<n>` | User nodes → Delete |
| Add the example | `wfe nodes example preliminary-research` | `POST /api/nodes/examples/<id>` | User nodes → Add example |
| Instantiate into a workflow | `wfe nodes instantiate <template> --workflow <id> [--id] [--bind <key>]… [--after <n>]… [--before <n>]…` | `POST /api/workspaces/<ws>/workflows/<file>/instantiate` | workflow editor → Add node |
| Instantiate into a draft file | `wfe nodes instantiate <template> --file <path> [--run <run>] …` | — | — |
| A run's snapshot | `wfe run nodes <run> [--show <id>]` | `GET runs/<wf>/<run>` (`catalog`) | run view → Node catalog |
