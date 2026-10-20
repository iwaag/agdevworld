# Project access (`ag.wfe-access.v1`, project_migration p4)

Any system agent or operator can read any managed project: its definition,
structure, files, workflows and runs. Reading needs only the operating
registry. It needs no project of the caller's, no knowledge index and no
configuration of any agent. Interpreting what is read is the caller's work.

Code: `server/access.ts`. The CLI is `wfe projects …` (`cli/projects.ts`,
`wfe help projects`). HTTP has read-only `GET` routes under `/api/projects`.

## What can be read

| Need | CLI | HTTP |
| --- | --- | --- |
| Discovery | `wfe projects list` | `GET api/projects` |
| Structure | `wfe projects show <project> [--rev R]` | `GET api/projects/<project>` |
| Listing | `wfe projects tree <project> [<path>] [--depth N] [--max N]` | `GET api/projects/<project>/tree?path=&depth=&max=` |
| A file | `wfe projects read <project> <path> [--max-bytes N] [--out F]` | `GET api/projects/<project>/file?path=&maxBytes=` |
| Search | `wfe projects search <project> <pattern> [<path>] [--regex] [--ignore-case]` | `GET api/projects/<project>/search?q=&path=&regex=1&i=1` |
| Runs | `wfe projects runs <project> [<workflow>] [--published]` | `GET api/projects/<project>/runs?workflow=&published=1` |
| One run | `wfe projects run <project> <wf>/<run> [--published]` | `GET api/projects/<project>/runs/<wf>/<run>` |
| A run's file | `wfe projects run <project> <wf>/<run> --file <path> [--published]` | `GET api/projects/<project>/runs/<wf>/<run>/file?path=` |
| The bytes, for a browser (p8: a link a reader opens — images and audio play, text shows) | — | `GET api/projects/<project>/raw?path=`, `GET api/projects/<project>/runs/<wf>/<run>/raw?path=[&published=1]` |

A run's `path` is relative to the run folder (`deliverables/a.wav`); the
same path from the project root (`devdocs/runs/<wf>/<run>/deliverables/a.wav`)
names the same file (workflow_editor p15).

**Targets.** `<project>` is a registered project id. A registered repository
that no project needs to use is addressed as `repo:<owner>/<name>` or
`gitea:<id>`. A repository that is not registered is reached only through a
project that has it as a submodule.

### What each read returns

**`list`** gives every project:

- id, name and intent;
- the devdocs mode;
- the root repository, with its current owner/name and the commit of its default branch;
- the submodules it uses, by Gitea name (`null` outside this Gitea);
- its workspaces on this host: available or not, head, and whether the head is the committed tip.

It also gives every registered shared repository, with the projects whose
`.gitmodules` use it.

**`show`** gives one project:

- `project.yaml`;
- the devdocs mode as declared and as Git shows it at that revision;
- the declared local areas, and whether each one exists at that revision;
- every submodule: its registered repository, the commit the project
  **pins**, and the repository's **upstream** default-branch tip, related as
  `same`, `behind`, `ahead` or `diverged` with counts;
- every workflow, wherever devdocs is stored: id, name, intent,
  documentation policy, bindings (with `integrate`), nodes and delegate
  targets, execution, and intake;
- the workspaces here.

Whether a directory is a knowledge area is the project's declaration (`areas`
in `project.yaml`, or a `study/`/`wedo/` submodule). An undeclared folder is
still readable as an ordinary path. Nothing is inferred from folder names.

## Source and revision

| Selection | Reads |
| --- | --- |
| (default) | the project root's default branch on Gitea: committed and authoritative, even when a workspace here is behind |
| `--rev <branch\|commit>` | that revision of the root (of the repository, for `repo:`) |
| a path inside a submodule | the commit the root revision **pins** (gitlink), and nested submodules at theirs |
| `--upstream` | the first submodule on the path at its default-branch tip, for refreshing knowledge (deeper submodules follow its pins) |
| `--require <commit>` | the same, failing unless the source read contains that commit |
| `--source worktree` | a workspace's working tree, explicitly (`--workspace <id>` when there are several): uncommitted changes included, ignored files never |

`.local/` and `.git` are never content, whatever the source.

**Caches.** Committed content is read from one bare repository per Gitea
repository under `<area>/.local/access-cache/`. All branches are fetched there
under a lock with the registry's Gitea credentials (`gitEnv()`, never in a
URL). A repository fetched in the last 10 seconds is not fetched again
(`--refresh` / `refresh=1` fetches anyway). Nothing is fetched into, checked
out in, or written in any workspace. The caches are disposable, and
their location never appears in a result.

## Provenance

Every result carries a provenance block:

```json
{
  "schema": "ag.wfe-access.v1",
  "project": "rts-vs-bot",
  "source": "committed",
  "repository": {"key": "gitea:130", "fullName": "developer/study-rts", "path": "study/study-rts", "category": "study", "registered": true, "defaultBranch": "main"},
  "revision": {"selector": "pinned", "commit": "<sha>", "pinnedBy": {"repository": "developer/pj-rts-vs-bot", "commit": "<sha>"}},
  "path": "study/study-rts/notes/01-rts-core.md",
  "observed": "2026-10-15T14:22:20.742Z",
  "fetch": {"state": "fresh", "at": "2026-10-15T14:22:20.742Z"}
}
```

- **`source`.** `committed` is a commit read from a cache. `worktree` is a
  working tree; its `workspace` says whether that tree has uncommitted
  changes. `live` is a run's current record on this host.
- **`revision.selector`.** One of `branch`, `commit`, `pinned`, `upstream` or
  `worktree`.
- **`fetch.state`.**
  - `fresh`: fetched now.
  - `recent`: fetched by any process in the last seconds.
  - `stale`: Gitea could not be read. The cached commit is used, and the
    block carries the cache's time and the error. Nothing falls back
    silently.

## Failures

A read that cannot answer is refused (exit 1; HTTP status as below). It never
returns an empty result. `detail.state` is one of:

| State | HTTP | When |
| --- | --- | --- |
| `absent` | 404 | the project, path, branch or commit does not exist; a pinned commit is on no branch of its repository; a required commit is not contained; a repository is gone from Gitea |
| `inaccessible` | 403 | a submodule outside this Gitea; a retired repository; `.local/` or an ignored file; Gitea not configured |
| `uninitialized` | 409 | the working tree's submodule is not checked out |
| `fetch-failed` | 502 | Gitea could not be read and nothing is cached |

A `show` or `list` does not fail as a whole when a part fails. Each part says
its own state: a submodule's `state`/`problem`, or a project's
`state`/`problem`.

**Bounds.**

| Read | Default | Ceiling | Option |
| --- | --- | --- | --- |
| A file | 256 KiB | 4 MiB | `--max-bytes` |
| A tree | 2000 entries | 20000 | `--max` |
| A search | 200 matches | 2000 | `--max` |
| Runs | 500 | | |

- A truncation is always said (`truncated`, `total`).
- Binary content is reported by size and sha256. The CLI saves it with `--out`.
- Search covers the one repository that holds the path. The submodules below
  it are listed as `notSearched`, so search them by their own path.
- A search path must exist in the selected source. A missing path returns
  `absent`; an existing path without matches returns a successful empty list.

## Runs: live and published

| Record | Where | Needs |
| --- | --- | --- |
| **live** | this host's resolver (`runSpace`, [storage.md](storage.md)): the run's own copy, or the project workspace for a run without one | a workspace of the project here |
| **published** | the run folder in the committed source (`devdocs/runs/<wf>/<run>/`), checked by the same reader as any record | nothing else |

`runs` lists both, side by side. `run` gives both records and their files.

- The published folder is a **snapshot**: integration brings it to `main`
  before `run.integrate` is recorded, and the live record continues after
  it. When both exist, the live record is the run's state.
- A run that was never integrated exists only on this host.
- A read never substitutes one record for the other.
- If the published source cannot be read, `runs` still returns available
  live records, including an empty live list. `publishedUnavailable` gives
  the failure's `state` and `message`; `provenance` is absent when no
  committed source was read. The CLI displays the failure beside the live
  records. If neither source is available, the operation fails.

`--published` skips the live record. A run file is read from the live folder
by default, or from the published one with `--published`.
With `--published`, a published-source failure remains an error.

## Where integrated work is (argue p4)

`wfe projects run <project> <workflow>/<run> --integration` answers "is this
run's work on main?" from three observations kept apart, each named with
its time (p3 ex1: the specialists said "not on main" from a stale local
`main` of work the executor had integrated):

- the run's `run.integrate` records (decision, time, each repository's
  target, method and resulting commit);
- each repository's **published** default branch on Gitea, fetched (or the
  cache, said to be stale), and whether it contains the integrated commit;
- this host's **project workspace**: its branch and head, whether it contains
  the commit, and whether it is the same as, behind, ahead of or diverged
  from the published branch.

A disposition such as "not integrated" names which of these it rests on.

## Through agdevworld

These are `GET` routes over managed project content only. No route takes a
host path or a repository location. So they are offered through
agdevworld's `/wfe/` like the other reads, from the home LAN.

## Execution guides of another project

`execution.guides` may name `<project>:<path>` (contract.md, *Execution*).
At claim, the execution host reads that file with this module from the
project's committed default branch, fetched now. It records the file in
`attempt.begin` as `<project>:<path>` with its sha256. A guide that cannot be
read (absent, inaccessible, or a fetch that failed) refuses the job with the
reason, exactly as a missing local guide does.

## Tests

`test/access.test.ts` uses a Gitea stand-in made of bare repositories by owner/name. It covers:

- discovery of a project with a workspace and of one without;
- devdocs as a directory and as a submodule;
- pinned against upstream reads, and a required commit;
- an earlier revision;
- a registered repository on its own;
- the failure states, including a stale cache;
- explicit working-tree reads;
- live and published runs, with and without a workspace;
- the CLI's JSON failure;
- cross-project guides at claim.

Every case checks that the workspace's refs and status are unchanged.
