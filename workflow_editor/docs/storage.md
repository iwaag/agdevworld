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
  record/        the run's durable record (improve_wfrun p2)
    devdocs/runs/<workflow>/<run>/run.json   the run's one live record
    .git         an invalid gitfile: Git run here fails, instead of finding the workspace above
  tree/          the run's working copy: a clone of the project; disposable
    devdocs/runs/<workflow>/<run>            a relative link to the folder in record/
  archive/       what a retirement saved besides commits (see *Retirement*)
```

**The record and the tree have separate lifetimes.** An agent reads and writes the
documented run path as ever and reaches the one set of bytes through the link; a
worker's own copy keeps a real folder, which is a synchronized snapshot as before
([workers.md](workers.md)). `server/runrecord.ts` holds the mechanics.

- Git does not see the link (`.git/info/exclude`) and leaves the folder's index
  entries alone (skip-worktree). `git add -A` never captures it; `git add <file in the
  folder>` fails with "beyond a symbolic link"; a `reset --hard` or `checkout` across a
  different snapshot of the folder refuses rather than overwrites. An agent saves the file
  and leaves the folder out of its own Git commands.
- **A publication stages the folder as a snapshot** (`stageRecord`) into the repository
  that owns it (the root, or the devdocs submodule), honouring that repository's ignore
  rules. What a branch holds is that snapshot, never the link.
- **One lock.** `server/lock.ts` keys a lock by real path, so a writer holding the lock through
  the link and one holding it on the durable path exclude each other, and the key does not depend
  on the tree existing.
- If something replaced the link with a real folder (a Git operation, an agent), the next
  write folds it in (a file the record lacks or holds older moves in; `run.json` never does)
  and links again. A plain read repairs nothing.

The folders under `.local/wfe/runs/` are the host's **index**: one manifest
per run. No second database can drift from them. `wfe runs index` lists
them.

**Two resolvers.** `runSpace(workspace, run)` returns where a run's files are
read and written, and never materializes anything. `treeSpace(workspace, run)` returns a
working tree for what needs the project's code (publication, integration, execution), or refuses
with the state and the action.

| The run has | `runSpace` | `treeSpace` |
| --- | --- | --- |
| a ready copy | the copy (a `Workspace` with the same logical id, rooted at `tree/`) | the same |
| a retiring, retired or restoring copy | its record root (a `Workspace` rooted at `record/`, `copyOf.treeless`) | refused, `run-retired` |
| a durable record but a missing tree | its record root; the tree stays reported as missing, not retired | refused, `run-copy` |
| no copy | the project workspace: runs recorded before p9 and not migrated (completed, cancelled), and runs an IDE agent created there with `wfe run create` | the same |
| a copy being created or damaged | nothing: the operation is refused with the problem, naming the run | refused |

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

The durable `run.json` is the run's only writable record, and the run's lock
is taken on it. A copy of it that reaches a branch (a publication, an integration, or
a run recorded there before p9) is a **snapshot**: it is never written and
never read as the run's state while the run has a copy, retired or not.

## Reconstruction

`wfe runs index --rebuild` reconstructs a missing manifest from the copy
itself. The run branch it has checked out must name this folder's workflow
and run, and its `run.json` must name the same project. Base commits and
targets come from the run's recorded `storage`. Nothing is cloned, checked
out, restarted or deleted. A copy whose repository is gone stays reported,
together with the branch that holds its saved work. Without `--rebuild` the
index is only read.

## Lifetime

Copies are kept when a run is held, completed or cancelled, until someone retires one
explicitly (*Retirement*). No age or schedule retires anything. Run branches are kept. A person
who removes a tree by hand leaves the run reported as missing, with its branch, and
its durable record readable.

## Retirement (improve_wfrun p2, `server/retention.ts`)

**Retired is a storage state, not a run state.** `copy.json` `state` goes `ready → retiring →
retired → restoring → ready`, with `lifecycle` (who asked, phase, failure, per-host progress,
sizes, history) and `generation`. No run event records it; the run's status, sequence, receipts,
number and links do not change. `wfe run storage <run>`, the run view and `wfe runs storage`
show it.

**A candidate** is completed or cancelled, with no open attempt, queued job, unpublished checkpoint,
unfinished integration or owed worker synchronization. Held, waiting and idle standing conductor
runs are not finished. An available presentation, a review in progress and a process working in the
tree keep the copy, with the reason. Historical delegation links do not. Eligibility is reported as
facts, not as a request for permission. A legacy or IDE run has no managed copy and is told apart.

**What is kept where.** Each repository of the copy, nested ones and those an agent initialized later:

| Item | Place | Check |
| --- | --- | --- |
| The run folder | `record/`, already | — |
| Every commit reachable from local branches, tags, `refs/wfe`, `refs/stash`, `HEAD`, the base, and the index's tree (staged bytes) | the project's retention repository `<workspace>/.local/wfe/retention/<repo>.git`, under refs of this run | every object reachable, `rev-list --objects` |
| Modified, untracked and ignored files, modes and symbolic links as links | `archive/files.tgz` and the list `archive/contents.json` | extracted in staging and compared file by file; sha256 of both recorded |
| Index and `info/exclude` of each repository | `archive/<repo>.index`, `.exclude` | copied as they are |
| A file with the same bytes as a verified published output of the run | the shared area, under its existing identity and retention; restoration copies it back by hash and names any it cannot have | the output is re-verified; if unavailable at retirement, the file is archived |
| What the responsible agent says is expendable (`--discard <path>=<reason>`) | nowhere; the path and reason are recorded and reported at restoration | — |
| Anything else (unreadable, a socket or pipe with no discard) | **the copy stays** | listed as unclassified |

Why a retention repository rather than a bundle per run: every copy of a project repeats its history (1.3 GB per
gimmickimg copy), so per-run bundles would cancel most of the saving. A disposable access cache or a remote branch tip is not a
recovery guarantee, and the retention store is neither. Commits on the shared store mean a damaged retention repository affects
every retired run of that repository; restoration reports it as unavailable, never as empty. It collects no garbage by itself.

**Order.** Mark `retiring` under the run's lock (from here `attempt.begin` and `treeSpace` refuse) → ask
workers → retain and verify commits → write and verify the archive in staging, then rename → recheck
everything with the publication, integration and record locks held → commit `retired` → release the tree
(`tree.removing`, then removal). Work that arrives in time wins: the run returns to `ready` and nothing
was released. Every step can be run again; `wfe run retire` continues, and `wfe run restore` on a `retiring`
run abandons it. Lock order: lifecycle, publication, integration, record, manifest. The archive's disk
is checked for twice the bytes first.

**Reading a retired run** needs no checkout: the record root serves the folder; artifacts and a delegated child's
files outside it come from the retained commit or the archive, unchanged (`retainedFile`). Nothing is restored
by a read. Git operations on the record root fail by design.

**Restoration** (`wfe run restore`, the run view, or a job that needs a tree) rebuilds in `tree.restoring` from the
saved revisions, never from main: verifies the archive's checksums and the retained commits first (a missing or corrupt one
leaves the run `retired` with an actionable error), recreates each repository in Git's standard relative layout with the project's own
remotes, restores files, deletions, indexes and excludes, compares them, then renames into place and links the latest
record. It queues nothing, integrates nothing and replays nothing. A correction or resume that needs a tree finds the job waiting
while the claim starts the restoration in its own process; it then runs with its normal semantics and its frozen definition. Session
reuse follows the harness contract, and a session that cannot be reused is recorded as replaced. An acceptance of a retired run is refused until
it is restored, because it binds to the files.

**Workers.** A worker that ever ran the run holds a copy. Its task (`<area>/.local/exec/storage-tasks/<worker>/`,
announced by the heartbeat's answer) archives its non-committed files, and commits no remote has as bundle files, to
`worker-archive/<worker>/` on the coordinator, verified by checksum. Until every such worker reports, the run stays
`retiring` with the coordinator's tree in place: **an unreachable worker is unknown, not done.** After the commit, the
worker removes its copy (`remove-pending`, then `removed`), so a run can be retired while a worker still holds an old copy; the
view says so. A report of an older generation changes nothing, and files of a run that is not ready are refused, so a
delayed message cannot overwrite a newer record or resurrect a tree. A new dispatch to a worker that has no copy brings
those files back into the new copy; its bundles arrive as files under `.local/wfe-worker-bundles/`, not as refs.

**Moving bytes is not freeing them.** The archive and retention repository live on the same disk as the copies here. Local
clones hard-link Git objects, so a copy's own `du` overstates what removing it frees: measure the
aggregate allocation before and after, per storage location. `lifecycle.sizes` is the per-copy view.

**Recovery.** A pre-p2 release cannot read relocated records: it finds an empty run folder link it does not
understand. Going back means moving folders back (the reverse of relocation, by hand, from `record/` into the tree) after
saving any newer events; retired runs must be restored first. That procedure is unverified. Data recovery on the current release is *Backup and recovery*.

## Backup and recovery (improve_wfrun p3, `server/runBackup.ts`, `wfe backup`)

**What it is.** A generation on another machine, named by `<area>/run-backup.json` (`{"host", "path", "ssh", "keep", "checkouts"}`), holding what a retired run needs to be read and restored. **It is not disaster recovery for the service.** Gitea, project workspaces, credentials and the trees of runs that are not retired are outside it; the manifest names those runs as `identityOnly`, with their numbers, receipts, manifests and records so a recovered area does not reuse them.

| Held for a retired run | Checked against |
| --- | --- |
| `copy.json`, `record/`, `branch-cleanup.json` | hashes at capture |
| `archive/` | the checksums the manifest recorded at retirement |
| `worker-archive/<worker>/` | the checksum the worker reported |
| The project's retention repository, whole | hashes under its lock, then every recorded ref with `rev-list --objects` at the destination |
| Its published outputs on the share, because archives omit those bytes | each file's hash in the output manifest |

Also held: the area's settings (no secrets), `VACUUM INTO` copies of the stores, and the release and checkout revisions. Token files and SSH keys are named, never copied. A generation has no project workspace in it.

**Consistency boundary: one retired run.** Its manifest and record are copied holding its lifecycle and record locks; a retention repository is hashed and copied holding the lock retirement fetches under; archives are immutable until a run's `generation` changes. After every transfer each run's state, generation, archive checksums and retained refs are read again. A change fails the whole generation by name. Stores are consistent one by one, with their own times; they are context, and a retired run's authority is its own record. A later event on a retired run's record is simply newer than the backup.

**Publication.** `staging/<id>.partial` → every listed file's hash read back at the destination → every retained ref checked with Git there → `generations/<id>` → `LATEST`, by rename. A failed or interrupted capture leaves the previous generation in place. A generation that loses a run the previous one covered is kept but does not move `LATEST` (`degraded`). A run that could never be covered is listed as `covered: false` with its reason, and reported by `wfe backup status`. Generations hard-link unchanged files to the previous one: they protect against bad captures and later logical damage, and they share one copy of each byte, so they are **not** independent copies against the backup disk failing.

**Cadence.** Daily, by launchd (`com.agdev.wfe-backup`), and by hand before and after a retirement or cleanup batch. Nothing depends on it running: `wfe backup status` reports the last verified generation, its age, what it does not cover and the last failure. A generation older than a retirement does not cover that run, and cleanup refuses it. Expiry keeps the newest `keep` generations (default 7) and always `LATEST`, and runs only after a new generation verified.

**Recovery of data, on the current release.**

1. Find a usable generation: `wfe backup verify` (`--generation <id>`); a failure names the affected runs.
2. Isolated: `wfe backup restore --into <empty folder>`, or with `--from <path>` on the backup host and no registry. It verifies every hash and ref, then builds `area/` with paths remapped and logical identities unchanged. No Gitea, Zulip, Slack, worker or presentation setting is carried, and `recovery.json` makes `wfe exec|notify|intake|request` refuse it. Use `WFE_REGISTRY=<folder>/area/registry.json WFE_AREA=<folder>/area wfe run show|restore …` to read and restore there. `wfe backup rehearse --into <folder> --by <name>` runs every check.
3. Live, after losing pieces: `wfe backup reinstate --by <name> --dry-run`, then without `--dry-run`, with the executor stopped. What is missing comes back; a damaged retention repository or archive is moved aside and replaced. **What exists and is intact is never overwritten**, so an older backup cannot erase newer events; a record kept newer and refs only in the damaged copy are reported. A run whose `generation` moved past the backup's keeps what it has.

Losing the coordinator whole also loses Gitea and the workspaces. This backup then recovers retired runs' records and work, not the service; re-creating a remote from a retained commit is a separate act.

**Rollback to pre-p2 code is not part of this.** It would need the reverse of relocation and is **unverified**; do not present it as a fallback.

## Relocation (`wfe runs relocate`, `server/relocate.ts`)

Copies made before improve_wfrun p2 keep their folder in the tree until moved, and the resolver reads them as before.
Relocation is explicit, once, and separate from any deletion.

- `--dry-run` lists what would move, what is blocked (an open attempt, a damaged copy) and changes nothing.
- It is refused while the executor reports. Stop the executor and the service (a lock's key changes with the real path, so
  writers must be quiet at cutover), then each run is moved under its lock; a worker's forwarded commands go
  through the stopped service and retry.
- Recovery copies come first (`<area>/.local/backups/p2-records-…`: consistent store copies, settings, refs, each manifest as it
  was); the journal is `<area>/.local/migrations/p2-records.json`.
- Per run: copy the folder to `record.staging`, compare every file, rename to `record/`, swap the tree's folder for the link, mark the
  index, stamp the manifest, remove the old folder. Unpublished documents move with it. Running again continues
  each run from where it stopped, and changes nothing that is done.

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

`test/runrecord.test.ts` (improve_wfrun p2): one set of bytes through the link, one lock, the
snapshot in both devdocs modes, the agent's `git add -A`, Git refusing between snapshots, a replaced
link folded in, a missing tree, relocation with a crash and a live executor. `test/retention.test.ts`:
every kind of local data, nested submodules, eligibility, unclassified data and discards, interruption at each step,
corrupt and unavailable archives, races with claims and jobs, a frozen definition after restoration, HTTP reads of a
retired run. `test/workers.test.ts`: worker-only files, lost contact, stale messages, re-dispatch.

`test/runspace.test.ts`: separate roots, manifests and branches; uncommitted
edits left out; local notes copied and ignored; allocation under
concurrency, with records, copies and run branches all counting; the same
receipt; interrupted creation (a half clone, a manifest left at `creating`)
and a restart; devdocs and study submodules on the run branch at their
gitlinks (a workspace-only commit included); a nested submodule on the run
branch (`test/nested.test.ts`: checkpoint and integration order, pins);
a damaged, missing or reconstructed manifest; a missing copy.
