# Reusable findings (`ag.wfe-knowledge.v1`, improve_workflow p2)

What a project learned from practice, kept where the project keeps its
knowledge, so another task can find it, inspect what it rests on and say what it
did with it. Code: `server/knowledge.ts`, over project access
([access.md](access.md)). The CLI is `wfe knowledge …` (`wfe help knowledge`).
HTTP has read-only `GET` routes under `/api/knowledge`.

There is no registry and no stored index. Everything below is derived from
`project.yaml`, `.gitmodules`, `knowledge.yaml` and the documents at one commit.

## Three separate things

- A **finding** describes a technique or lesson, the conditions it was observed
  under, its evidence and its limits.
- A node's **expectation** ([contract.md](contract.md)) describes the result
  wanted, and is where preferred or required outcomes belong.
- A run's **decision** says which findings it adopted, adapted or rejected, why,
  and what actually resulted.

Referencing a finding does not mandate its procedure and does not show that the
current task succeeded. Finding nothing applicable and choosing another method
are ordinary. Nothing here gates, dispatches or requires anything: categories
help to find candidates and define no implementation type.

A finding is not a run report. One run can yield several findings and several
runs can refine one. Run records stay where they are and are linked as evidence.
A subject finding belongs to the project responsible for the subject, not to the
conversation in which it came up.

## Collections

A **collection** is a study or wedo knowledge area, as a project declares it:

| Form | Identity | Example |
| --- | --- | --- |
| A local area (`areas` in `project.yaml`, a folder of the project root) | `<project>:<path>` | `gimmickimg:wedo` |
| A shared repository (registered `study`/`wedo`, or a `study/`, `wedo/` submodule) | `repo:<owner>/<name>` | `repo:developer/wedo-argue` |

`<project>:<mount>` (`ponderer:wedo/wedo-argue`) names the same shared collection.
A machine's checkout path is never an identity.

`knowledge.yaml` at the collection's root says who maintains it (archsage
`index/README.md`, *Maintenance*). A collection without it can still hold
findings, and `check` warns. The file's `kind` (`study` or `wedo`) is what a
reader reports: a study finding is shown as imported and not locally verified.

Being declared is not the same as holding findings. Topic files with no header
are still knowledge, read by `wfe projects`: lowerpoly's `wedo/` and wedo-argue
have plenty. `collections` keeps three outcomes apart: *N findings*, *no findings*
(read, with documents without a header counted) and *unavailable* (with the
reason). Never conclude from a missing `wedo/` or from "no findings" that a
project knows nothing.

## A finding

One Markdown document in `findings/` under the collection's root (subfolders
are fine), with a YAML header:

```markdown
---
id: gimmickimg-f-0001
title: Moving a cut-out part widely across a still
summary: What the finding offers, in a sentence or two; this is what a chooser reads.
categories: [motion]
tags: [cut-out, path-motion, clean-plate, godot]
status: observed-once
references:
  - {role: evidence, ref: devdocs/runs/partial-animation/run-002/report.md, note: "what was done, written by the producing agent"}
  - {role: acceptance, by: "ponderer-agent (an agent, not the person)", ref: devdocs/runs/partial-animation/run-002/run.json, note: "the review node"}
  - {role: illustration, ref: devdocs/runs/partial-animation/run-002/presentations/p1/content/bee_flight_14s_loop.mp4, note: "the clip to watch, and what is wrong with it"}
---
Free-form body.
```

**Required**: `id`, `title`, `summary`, at least one category and at least one
reference. **Optional**: `tags`, `status`, and any further field, which is kept
and shown but means nothing to the reader.

**`id`.** Letters, digits, `.`, `_`, `-`; unique in its collection; stable, and
never reused. A finding is named `<collection>#<id>`. Title and file name can
change without changing what a reference means.

**`categories`.** What the finding is useful for, the small vocabulary a later
node can ask for: `motion`, `extraction`, `generation`, `composition`,
`verification`, `process`, `domain`. Several are normal, and a task can combine
findings. An unknown category is a warning and is kept; the list came from a
media project's and a discussion project's first entries (ponderer found it
media-shaped and put its subject in tags), and grows when real entries need it. Technique, subject,
tool and environment are **tags**, which are free and multiple. The first entries
used `technique`/`lesson`/`comparison`, which overlapped on every entry while
the tags did the finding (freework/run-021's report); that kind of statement
belongs in the body or `status`.

**`status`.** Free words. The first entries needed `observed-once`,
`observed-repeatedly` and `conflicting-observations`.

**`references`.** Each has a `role` and a `ref`, and may have `by` and `note`.

| Role | Means |
| --- | --- |
| `evidence` | a record showing the method was tried and what came out |
| `acceptance` | someone's judgement of a result; `by` says whose: a person's review and an agent's acceptance are different facts |
| `illustration` | something to look at. It does not show that the method works |
| `context` | a tool, documentation or background |
| `unchecked` | cited, and the writer did not verify it |

External evidence is `evidence` with its external `ref`: the role says what it is
for and the reader says it is unchecked.

| A `ref` is | Resolved against |
| --- | --- |
| `path/in/the/repository` | the repository holding the document, at the same revision |
| `<project>[@commit]:<path>`, `repo:<o>/<n>[@commit]:<path>`, `<repository name>[@commit]:<path>` | that project or repository |
| `<project>/<workflow>/run-NNN` | that run, live or published |
| a URL, `shared://…`, free text | nothing: **unchecked**, with why |

Quote `by` and `note` in a flow mapping: a comma ends an unquoted value
(freework/run-021 lost half of a `by` that way, and `check` warns about the stray
key).

**The body** is free-form and has no required sections. Someone unfamiliar with
the original run should be able to tell when it applies and what remains
uncertain: applicability, conditions, limits, contrary observations, rejected
alternatives, whose judgement a result rests on. A motion finding links something
a person can watch when one exists, and says what is wrong with it. One trial is
an observation; say so.

Revising a finding is an ordinary commit of the same `id`. Keeping an earlier
statement's rationale (wedo-argue's *Revisions*) is the project's choice. A
finding that no longer holds is marked in its own document rather than deleted,
so references to it keep reading.

## Validation

`wfe knowledge check <collection>` checks readable headers, unique ids and
resolvable references at one revision; it exits 1 on an invalid header, a
duplicate id or a missing reference. It cannot establish that a claim is true. A
reference's `resolved` means the thing exists at that revision. External or
unavailable evidence stays `unchecked`, and is not counted as either.

`wfe knowledge check --dir <folder>` reads a folder as it stands, for an area in a
run's own copy, which project access cannot see: both first authors (gimmickimg
freework/run-022, ponderer freework/run-003) could only say "check again after
integration".

## Revisions

Every result names the repository, the commit and why that commit was read.

| Read | Revision |
| --- | --- |
| a local area | the project's default branch; `--rev` a commit of the project root |
| a shared repository, `--as <project>` | the commit that project pins |
| a shared repository, no choice made | the pin of the project of the workspace you are in; else of its declared maintainer; else of its only user; else the upstream tip, and the result says why |
| `--upstream` | the repository's default-branch tip |
| `--rev <commit>` | that commit of the repository |
| `--source worktree [--workspace <id>]` | a working tree, explicitly; with uncommitted changes the result is marked unpublished |

A reader never switches a checkout: reads go through project access's caches.
A shared collection's latest commit is not what a consumer adopted, and a
consumer that needs a newer one moves its pin as it always does.

**History.** `--rev <commit>` finds the id among that commit's documents. So a
later edit cannot change what a recorded reference reads, a renamed document is
found under its new or old path at the matching revision, and an id absent at
that revision is reported absent with what is there, never substituted. A
commit that no longer exists is reported absent too. A duplicate id refuses the
read (409, `duplicate-id`) and names both documents.

Discovery shows the available revision and is rebuilt on every read; the only
cache is project access's Git caches.

## Recording a decision

A run that used, adapted or rejected a finding says so in its ordinary report or
`outcome.md`, in a fenced block:

````markdown
```knowledge-decisions
- finding: gimmickimg:wedo#gimmickimg-f-0001
  repository: developer/pj-gimmickimg
  commit: 53bbc2b210012b43880df6a4ec46748e6d86c33d
  path: wedo/findings/moving-cutout-part-across-still.md
  sha256: 99971961…
  decision: adapted
  reason: why, under this task's conditions
  work: [<commit or path of what was actually made>]
  verification: [<path of how the outcome was checked>]
- decision: none
  considered: what was looked at
  reason: why nothing applied, and the approach chosen
```
````

- `wfe knowledge cite <qid>` prints the block for what you read. In misc freework/run-013 the agent ran it, then wrote the same facts as a paragraph in another file, which reads as no decision at all; the command now says where the block goes.
- Record relevant candidates, not every search result. No block means nothing
  was recorded, which is allowed.
- **Unpublished bytes.** `unpublished: true` with `preserved: <a copy in the run
  folder>` and the sha256 of the bytes, instead of claiming a committed source.
- `wfe knowledge decisions <project> <wf>/<run>` reads each entry back at its
  recorded revision and shows: the finding as it was then, whether the recorded
  sha256 and path match, whether the document has changed since, and whether the
  named work and verification exist.

The block is the agent's statement. A past example does not verify a new result,
and saying a finding was used is a claim to compare with the artifacts:
*verification* of the outcome stays in the run's own evidence and expectations.

## For a person

The project page in the editor lists its collections and findings: title,
summary, categories and tags, id, revision, and a link to the document on Gitea
at that commit. `GET api/knowledge/finding?id=<qid>` gives the same detail,
with `view` links for illustrations (`api/projects/<target>/raw?path=&rev=`).

## Tests

`test/knowledge.test.ts`: equal local ids in different collections; duplicates;
filters and detail reads; title and path changes; a later edit against a recorded
revision; a pin against the upstream tip; missing collections, unresolved evidence,
unpublished content; a reader with no workspace; recorded decisions read back.
