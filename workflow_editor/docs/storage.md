# Run storage (`ag.wfe-run-copy.v1`, p9)

A run the execution host performs keeps its work in **its own working copy**
of the project: the root and every submodule the project workspace has
checked out, each on the run's own branch. The copy exists for the run's
whole life, across all its attempts. A held run therefore keeps its plan,
records and unfinished work without holding the project. Other runs of the
same project work in their own copies, and nothing a run saves reaches a
shared branch until it is integrated. The run contract is in
[runs.md](runs.md). A run performed by a remote execution node (project_migration p7)
keeps this copy on the coordinator as its **record copy** and is worked in a
copy of the worker's own; [workers.md](workers.md) says how the two relate.

Code: `server/runspace.ts` (resolver, allocation, creation, index). The
person's project workspace, the one in the registry, stays theirs. Editing
workflows, the project and its own Git state happens there.

## Where a run lives

```text
<project workspace>/.local/wfe/runs/<workflow>/<run>/
  copy.json      the manifest (host-local; ignored by Git like all of .local/)
  tree/          the run's working copy: a clone of the project
    devdocs/runs/<workflow>/<run>/run.json   the run's one live record
```

The folders under `.local/wfe/runs/` are the host's **index**: one manifest
per run. No second database can drift from them. `wfe runs index` lists
them.

**One resolver.** `runSpace(workspace, run)` returns where a run's files are
read and written:

| The run has | Its files are in |
| --- | --- |
| a ready copy | the copy (a `Workspace` with the same logical id, rooted at `tree/`) |
| no copy | the project workspace: runs recorded before p9 and not migrated (completed, cancelled), and runs an IDE agent created there with `wfe run create` |
| a copy being created, damaged or missing | nothing: the operation is refused with the problem, naming the run |

A copy that cannot be used is never replaced by the project tree's snapshot
of the same run, and reading never creates, repairs or restarts anything.
The logical workspace (registry id) of a copy is its project workspace's.
Its physical root is the copy. `wfe` run in a copy finds its workspace by the
usual rule (the copy is inside the registered workspace's folder).

## Identity and branches

| Fact | Form |
| --- | --- |
| Run identity | project id + workflow id + run id (as in runs.md) |
| Run branch | `wfe/<project>/<workflow>/<run>` in every repository the run owns |
| Integration target | each repository's default branch on Gitea for a published copy (improve_wfrun p1); for a copy made from the workspace, the branch the workspace had checked out (a detached submodule: its remote's default branch) |

The project id in the branch keeps runs of different projects apart in a
repository they share (a study, a wedo).

**Allocation.** A run number is reserved under the workspace's allocation
lock (`server/lock.ts`) by creating the run's folder and manifest. The next
number is one past the highest `run-NNN` that is recorded in the project tree
(`devdocs/runs/<workflow>/`), held by a copy, or named by a run branch that
Git knows (local, or `origin/…` as last fetched). Two requests never get the
same number. A request's receipt is kept in the manifest: the same request
finds its run again, finished or not.

## What a copy is made from

**Published (improve_wfrun p1)** — every run a host with Gitea creates for an
execution host (a person's or conversation's request, a Zulip post, a
delegation's child):

- The root starts at the **resolved root commit of the project's published
  source** ([runs.md](runs.md), *Definition snapshot*), the same commit the
  definition is read at. `copy.json` has `baseFrom: "published"` and `source`
  (`project`, `repository`, `branch`, `commit`, `selector`).
- It is cloned from the access cache (`<area>/.local/access-cache/`,
  [access.md](access.md)), and **every** submodule the revision pins is
  initialized at its gitlink, nested ones too, whether or not the workspace has
  it checked out. A submodule that cannot be read (outside this Gitea, its pin
  on no branch) stays uninitialized with its `problem`; a definition binding it
  is refused.
- **Integration targets** are each repository's default branch on Gitea, never
  the workspace's checked-out branch. Per-binding policies (`integrate:
  if-unchanged`) are unchanged.
- The same request (receipt) keeps the revision its copy was reserved with: a
  creation interrupted after the reservation and retried after the default
  branch moved on still uses the reserved commit for definition and code.
- Run numbers also count the run folders of that revision and the run branches
  in the root's access cache.
- Nothing in the workspace is read for content, fetched into or changed.

**From the workspace** — only where no published source exists (a host without
Gitea), and for reconstruction:

- **The committed project, never the person's uncommitted edits.**
  - The root starts at the project workspace's `HEAD`.
  - Results integrated from other runs' copies reach the remote, not the
    workspace. So the workspace's branch upstream is fetched first (best
    effort). When the workspace is only behind it, the copy starts at the
    upstream commit instead. The manifest's `baseFrom` says which.
  - A workspace with commits of its own that are not pushed keeps its
    `HEAD`.
  - Each initialized submodule starts at the gitlink that commit records. A
    commit the workspace has and its remote does not is taken from the
    workspace. A gitlink the workspace lacks is fetched from the submodule's
    remote.
  - Nothing in the person's workspace is changed.
- The **definition** the run follows is read from the project workspace and
  frozen into the run folder; `definition.source` says `workspace` (runs.md,
  *Definition snapshot*).
- **Remotes.** Every repository of the copy has the project's own `origin`
  (the root's remote, each submodule's remote), not the workspace it was
  cloned from. A copy pushes nowhere but its run branches (see runs.md,
  *Publication*).
- **Submodules** use the standard layout (`.git/modules/…` under the copy's
  root). Each one the workspace has checked out gets the run branch at its
  base gitlink. A submodule the workspace has not checked out stays
  uninitialized. A **nested** submodule (a submodule's own) is treated the
  same way (project_migration p6 ex1): when the workspace has it checked
  out, it gets the run branch at the gitlink its parent's base records, and
  it is published and integrated like any other repository of the run. A
  backend superproject whose submodules carry the work is therefore one
  binding, and its gitlinks are the pins integration records.
- **Git configuration** is the copy's own (`.git/config`: remotes, submodule
  URLs). Identity and credentials come from the host's environment as for
  every other Git operation here.
- **Local resources.** Git ignores `.local/` in the copy
  (`.git/info/exclude`). The regular files directly in the project
  workspace's `.local/` (notes, settings; up to 1 MiB each) are copied into
  the copy's `.local/` and listed in the manifest (`local`). Folders such as
  outputs, environments, other runs' copies and caches are not shared. A run
  that needs a larger local resource names it from the project workspace,
  and its absence is that run's problem. Ignored files, environments and
  generated data are never preserved by commits; they stay in the copy, which
  is kept (see *Lifetime*).

**Creation is idempotent.** `prepareCopy` reserves, then `materialize` makes
or finishes the copy: a clone that did not finish is removed and made again,
an existing branch is kept as it is (its commits are the run's saved work),
and a finished copy is returned unchanged. Its manifest says `creating`
until the last step and `ready` after it. An interrupted creation is finished
by the same request, under the same run number.

## The manifest (`copy.json`)

```json
{
  "schema": "ag.wfe-run-copy.v1",
  "project": "jevlab", "workspace": "jevlab", "workflow": "experiment", "run": "run-002",
  "branch": "wfe/jevlab/experiment/run-002",
  "state": "ready", "created": "…", "ready": "…", "receipt": "request:…",
  "repositories": [
    { "path": ".", "kind": "root", "initialized": true, "base": "<commit>", "branch": "wfe/jevlab/experiment/run-002", "target": "main", "url": "<remote>" },
    { "path": "study/study-x", "kind": "submodule", "initialized": true, "base": "<gitlink>", "branch": "wfe/…", "target": "main", "url": "<remote>" }
  ],
  "local": ["localenv.md"]
}
```

It never leaves the host, but it still holds no credentials. What the run
records about its storage is portable: `run.json` `storage` (from
`run.create`) has the branch and, per repository, `path`, `base`, `branch`
and `target`, with no paths on this host and no URLs.

## The workspace and the published source (improve_wfrun p1)

The registered workspace is the editing area. Its age, its local commits and
its uncommitted changes do not decide which workflows exist or what a run
follows. How it relates to the published revision is read, never assumed
(`server/workspaceSync.ts`; `wfe workspace status`, the editor's Workflows card):

- per repository (the root and every submodule the published revision pins):
  `same`, `behind`, `ahead`, `diverged` or `unknown`, with counts, decided from
  commits a side is known to have (the access cache holds every Gitea branch);
  uncommitted changes are counted apart; `atCommitted` alone is never the
  relation;
- the situation in a sentence and the next action (`none`, `sync`,
  `resolve-by-hand`).

**Synchronization is optional** (`wfe workspace sync [--dry-run]`, the editor's
Update workspace). It only fast-forwards: the root on the published branch,
clean and only behind; each submodule whose pin moved, clean and at its old pin
(a branch is fast-forwarded, a detached checkout moved to the pin). Anything
else is refused with the concrete reasons and nothing changes. State is read
again before each change; nothing is stashed, reset, merged or rebased. Each
repository's step is reported (`moved`, `refused`, `failed`, `unchanged`); after
a partial update the named repository is fixed by hand and sync runs again,
continuing from what already moved.

## One live record

The copy's `run.json` is the run's only writable record, and the run's lock
is taken on it. A copy of it that reaches a shared branch (an integration, or
a run recorded there before p9) is a **snapshot**: it is never written and
never read as the run's state while the run has a copy.

## Reconstruction

`wfe runs index --rebuild` reconstructs a missing manifest from the copy
itself. The run branch it has checked out must name this folder's workflow
and run, and its `run.json` must name the same project. Base commits and
targets come from the run's recorded `storage`. Nothing is cloned, checked
out, restarted or deleted. A copy whose repository is gone stays reported,
together with the branch that holds its saved work. Without `--rebuild` the
index is only read.

## Lifetime

Copies are kept when a run is held, completed or cancelled. Deleting a copy,
deleting its branches and collecting garbage are not part of p9. A person
who removes a copy by hand leaves the run reported as missing, with its
branch.

## Migration (`wfe runs migrate`)

Runs recorded in a project workspace before p9 move into copies of their
own, explicitly and only once (code: `server/migrate.ts`).

- **`--dry-run`** prints an inventory and writes nothing. For every run it
  lists the execution state, the hold, an open attempt, queued jobs,
  unpublished checkpoints, open presentations and the action:

  | Action | Meaning |
  | --- | --- |
  | `migrate` | It moves (or continues an interrupted move). |
  | `migrated` | It already moved. |
  | `keep-terminal` | It is completed or cancelled and stays in the project tree, read through the resolver as before. |
  | `keep-ide` | An IDE agent performs it, so it stays in the project workspace. |
  | `blocked` | An attempt is open, or the record cannot be read. |

  It also lists each repository's head and branch, and the uncommitted files
  of the project workspace outside run folders.
- **Preconditions.** It is refused while the executor reports (heartbeat
  younger than 45 s); intake and claims stay paused until the migration is
  done. Before writing, it takes host-local recovery copies in
  `<area>/.local/backups/p9-migrate-<time>/`:
  - consistent copies of `exec`, `notify`, `intake` and `present` (`VACUUM
    INTO`);
  - the area's settings;
  - each workspace's refs, heads and uncommitted files;
  - the inventory.
- **What it does, per run.** The run gets its copy under its own id
  (`reserve` with `adopt`, receipt `migrate:<workspace>/<run>`). The copy is
  made from the committed project. The run's folder **as it is in the project
  workspace** is placed there, including records that were never published.
  `run.relocate` then records its storage.
- **What does not change:**
  - nodes, questions, answers, holds, decisions, receipts and jobs;
  - nothing is queued, resumed or announced (`run.relocate` is not a
    coordination event);
  - what the run published before stays on the shared branches, and those
    commits stay intact;
  - checkpoints keep the mode they were made with: an old one still
    publishes the project workspace's branches when retried, never the run
    branch.
- **Not attributed by guess.** Uncommitted files of the project workspace
  outside run folders are reported with their paths and left alone.
- **Restartable.** The journal is `<area>/.local/migrations/p9.json`.
  Running the migration again continues each unfinished run from its last
  step, and a copy reserved before a crash is finished rather than made
  twice. A finished run is not touched again.

`test/migrate.test.ts` covers:

- the dry run;
- the migration of a held plan-only run (the incident) and a waiting one,
  while a cancelled run and an IDE run stay put;
- unchanged meaning, no queued job and no new outbox rows;
- an old failed checkpoint that still publishes to `main`;
- running the migration twice;
- the held run afterwards: readable, a history link to an old commit, a new
  request in the same project executed, then a resume in its copy;
- a migration interrupted after reservation;
- the refusal while the executor reports.

## Fixtures

`test/publishedSource.test.ts` (improve_wfrun p1): a stale, dirty, ahead and
diverged workspace with published runs (the workspace unchanged); one revision
for definition and code; a retried receipt after the default branch moved; an
explicit revision; every pinned submodule including one absent from the
workspace and its nested module; devdocs as a submodule read at the pin;
discovery after `invalidate`; Gitea unreachable; existing runs unchanged.
`test/workspaceSync.test.ts`: relations, sync refusals, a partial update and its
continuation, and trials.

`test/runspace.test.ts`: separate roots, manifests and branches; uncommitted
edits left out; local notes copied and ignored; allocation under
concurrency, with records, copies and run branches all counting; the same
receipt; interrupted creation (a half clone, a manifest left at `creating`)
and a restart; devdocs and study submodules on the run branch at their
gitlinks (a workspace-only commit included); a nested submodule on the run
branch (`test/nested.test.ts`: checkpoint and integration order, pins);
a damaged, missing or reconstructed manifest; a missing copy.
