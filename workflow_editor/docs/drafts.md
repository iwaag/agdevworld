# Published definitions and drafts

workflow_editor p20. What a person sees as a project's workflow is what the next
ordinary run uses; changing it happens in a draft and takes effect when applied.
No Git operation or checkout maintenance is part of this. The history of how this
worked before is in `devdocs/episodes/workflow_editor/p20/explanation.md`.

| Context | Definition shown | Meaning |
| --- | --- | --- |
| Project workflow (`#/ws/<ws>/wf/<file>`) | Latest fetched published definition | What a new ordinary run uses |
| Editing (`#/ws/<ws>/wf/<file>/draft/<id>`) | A saved draft | Changes not yet applied |
| Run definition (`#/ws/<ws>/run/<wf>/<run>/definition[/<revision>]`) | The run's retained definition | What that run started with, and its later revisions |
| Checkout, developer detail (`#/ws/<ws>/wf/<file>/checkout`) | The registered checkout's file, read-only | What one host's checkout holds; nothing uses it |

Published, run and checkout views are read-only. All use one graph renderer
(`src/workflowView.ts`), with the source and editability stated in the view.

## Source descriptor

`DefinitionDescriptor` (`shared/api.ts`, schema `ag.wfe-definition-source.v1`) is
returned with every published and draft read:

- `kind`: `published`, `draft` or `run`; `project`, `workflow` (id or null), `file`.
- `definition`: the repository, path and revision the bytes are at. In submodule
  mode this repository is the submodule, at the commit the root pins.
- `root`: the project root's repository, branch and commit, a separate fact.
- `digest`: sha256 of the bytes. `fetch`: state and time of the last read from Gitea.
- `draft`: `{id, revision}`. `run`: `{ref, revision}`.

Validation of a published or draft read resolves against the same revision
(repositories, sibling workflows, published peers). Context reads for a workflow,
including its guides, read the published source too. A check of the host itself
(a checkout's files, an initialized submodule) is reported by the project page's
Developer details, not as definition validity.

## Reading

| Route | Answer |
| --- | --- |
| `GET api/workspaces/<ws>/published-head[?refresh=1]` | `{source}`: the published head, at most 4 s old, one reading per project at a time |
| `GET api/workspaces/<ws>/published[?refresh=1]` | `{source, workflows, problem?, relation}`: the list; `relation` is the checkout's, or `{problem}` |
| `GET api/workspaces/<ws>/published/<file>` | `WorkflowResponse` with `{source, descriptor}` |

These need the registration, not its checkout. An open view polls `published-head`
every 3 s and re-reads when the commit changes, so a push shows within 10 s while
connected; it re-reads on reconnect and when the page becomes visible again.

| State | How it reads | What the view does |
| --- | --- | --- |
| `fetch.state: stale` | The last fetched revision, with the error and the time it was fetched | Keeps the graph with a stale notice and the last successful check |
| `problem.kind: missing` | The file is not at that revision | Says it is deleted, or links to its new file when the same id exists under another name; no Save |
| `problem` otherwise | The file is there and cannot be parsed | Says it is invalid, shows its text, and Edit opens a text repair |
| `issues` with errors | The graph, with its validation errors | Says a run would be refused |
| 404 `absent`, a project with nothing published | No default branch or commit | Says not yet applied; never shows a checkout instead |
| 502 `fetch-failed` with nothing cached | Unavailable | Says so; never shows a checkout instead |

## Drafts

A draft is one file in `<area>/.local/wfe-drafts/<id>.json`, written and synced
before a rename; schema `ag.wfe-draft.v1`. It holds `id`, `author`, `project`,
`workspace`, `workflow`, `file`, `state` (`open`, `applied`, `discarded`), `revision`,
`text`, `sha256`, `base` (the bytes, digest and descriptor it began from; empty for
a new workflow), `provenance` (`published`, `new`, `import`), every saved
revision, and the `apply` journal. Saving never changes anything a run reads.

| Route under `api/workspaces/<ws>/drafts` | Effect | Refusals |
| --- | --- | --- |
| `GET [?file=]` | Open drafts | |
| `POST {file, by[, another]}` | Starts from the published definition, fetched now | 409 `draft-exists` naming the drafts; 404 `not-published`; 502 when Gitea cannot be read |
| `POST {new: {id, name, template, documentation}, by}` | A workflow that does not exist yet | 400/409 with `field`; 409 `draft-exists` |
| `POST {import: {file, sha256}, by}` | An edit of the checkout, with its real base | 404 `no-edit`; 409 `definition-conflict` |
| `GET /local-edits` | The checkout's inventory (below) | |
| `GET /<id>` | `WorkflowResponse` with `{draft, descriptor, source, latest, baseText}` | 404 `draft-missing` |
| `PUT /<id> {revision, by, workflow \| text}` | Saves; `workflow` keeps the YAML's formatting, `text` may be unreadable (a repair) | 409 `draft-revision-conflict`, `draft-applied`, `draft-discarded` |
| `DELETE /<id> {revision, by}` | Discards | as PUT |
| `POST /<id>/compare` | What applying would do now, without publishing | |
| `POST /<id>/approve {revision, kind, approver}` | An approval record in a new revision | |
| `POST /<id>/try {revision, text, author, receipt[, node]}` | A trial run | 409 `draft-revision-conflict`; a refusal as for any run |
| `POST /<id>/resolve {revision, by, latest, text \| recreate \| retarget}` | A conflict's resolution as a new revision | 409 `definition-conflict` when the project moved again |
| `POST /<id>/apply {revision, by[, key]}` | Publishes | below |

Every draft save names the revision it was made from, so two tabs or two people
never overwrite each other silently. The browser's unsaved edits are separate: an
external save or a published change is announced and replaces neither.

## Trials

A trial runs a saved revision's exact bytes and the published code at the commit
the run resolves. `run.json` `definition.source` is `{kind: 'trial', file, sha256,
baseline, draft: {id, revision, author}}`. Uncommitted or unpublished project code
is not part of it: a trial tries the definition, not arbitrary code. Ordinary
requests and delegation never read a draft.

## Applying

Applying publishes without a working tree and without the checkout. Objects are
written in the access cache of the repository that holds the definitions; a
temporary index changes only the definition's path; and the commit is pushed
without force on top of the head it was built on. Applies of one project take turns.

1. Refresh the target: the default-branch head of the definitions' repository.
2. Compare base, latest and draft. Unchanged upstream publishes the draft;
   changes elsewhere in the file are merged (`git merge-file`); the same lines are
   a conflict. Other files of the repository are never touched.
3. Validate the result at the published revision. Errors are `invalid` (422).
4. Record the commit in the journal, then push. If another writer won, go to 1.
5. In submodule mode, commit the root with its gitlink at the new head of the
   definitions' repository and push it the same way. A root is built on what
   Gitea has now, and a pin already holding the definition is left alone. As
   with an integration, the new pin also carries whatever else was on that branch
   past the old pin; the journal's `root.pinFrom`/`pinTo` name it.
6. Read back through the resolver ordinary requests use. Only then is it `applied`.
   A file a later publication already changed again counts when the published
   revision contains the applied commit (`superseded`).

| `apply.outcome` | HTTP | Meaning |
| --- | --- | --- |
| `applied` | 200 | Read back; `result` is the descriptor; `duplicate: true` when an earlier request did it |
| `conflict` | 409 | `conflict.kind` `text`, `deleted`, `renamed`, `exists`; `segments` give the file with its hunks; nothing was published |
| `invalid` | 422 | `issues` or `problem`; nothing was published |
| `failed` | 502 | Nothing is known to have been published (Gitea unreachable before a push, writers kept winning) |
| `uncertain` | 502 | A push may or may not have arrived, or the pin has not; applying again finds out |
| `in-progress` | | Reads as `uncertain` after 5 minutes without progress |

The draft is kept through every outcome except `applied`. Applying again uses the
journal: a commit found on its target is not published twice, a pin that did not
arrive is finished. When a newer revision was saved during the apply, the draft
stays open with its base moved to what was applied. Commits carry `WFE-Draft` and
`WFE-Apply` trailers, the person as author and `WFE drafts` as committer.

A conflict is resolved in the GUI: for each hunk keep mine, keep latest or edit the
text. `resolve` saves the result as a revision whose base is the latest definition
compared against, so the next apply changes only what was chosen. `deleted` offers
recreating the file; `renamed` offers moving the draft to the new file.

Limit: publication through nested submodules (devdocs inside a submodule of a
submodule) is refused as `unsupported-layout`; no project is arranged this way.

## Edits in a checkout

`GET drafts/local-edits` compares each workflow file of the registered checkout
with the published definition and with the checkout's own history. A file equal to
a revision the project already had is only behind, and is no edit. Otherwise it
is `uncommitted`, `local-commits` (commits Gitea does not have) or `untracked`, with
its own base: the newest commit of that history the project also has. Importing makes
a draft with that base and `provenance.kind: import`. The checkout is not changed,
reset or published, and unrelated dirty files make no difference to anything here.

## The CLI

`wfe draft list|show|start|save|compare|try|apply|discard|edits|import` uses the
same code (`wfe draft --help`). `wfe workflow show|save|new|validate|approve` and
`wfe request --editing` operate on the checkout and say so: they are for people
and agents deliberately working there, and their effect reaches runs only when
it reaches the default branch.

## Tests

`test/drafts.test.ts`: durability and revision checks, publishing from a dirty and
behind checkout, compatible and conflicting upstream changes, invalid results,
edits during an apply, a writer winning the push, simultaneous applies, lost
responses, deleted and renamed files, new workflows, trials, submodule publication
and partial publication, an unreachable source, and the checkout inventory.
