# Integration of accepted results (p9)

A run's work is **saved** on its own branches at every checkpoint
([storage.md](storage.md), [runs.md](runs.md) *Publication*). **Integration**
is a separate, later operation: it brings an **accepted** result into the
project's shared branches, the targets the run's storage names. Code:
`server/integrate.ts` (Git), `server/exec.ts` (journal, queue, preconditions).

These facts are separate, and each is shown on its own:

| Fact | Record |
| --- | --- |
| Execution completed | `execution.state` |
| Result accepted | `decisions[]` (with the revision it binds to) |
| Work saved | checkpoints on the run branch (this host's `exec.sqlite`) |
| Integrated | `run.integrate` in `run.json` (`integrations[]`), after every repository is done; partial progress is this host's journal |

Plan agreement never becomes acceptance, and accepted-but-unintegrated work
is never called integrated.

## The acceptance binds to a revision

When `accepted` is recorded (the person's own decision or the one their
confirmation answer is), the file layer records `revision`: per repository
the run owns, the tree its copy held at that moment, uncommitted files
included and ignored ones not. Each tree is kept reachable
(`refs/wfe/accepted/<tree>` in the copy).

Integration uses the commits saved **after every attempt ended**. The final
checkpoint is made first when the copy holds unsaved records, and the run
branch must be published as it is locally. The integration compares those
commits with the revision. Two kinds of change are allowed:

- the run's own `run.json` (administrative state);
- the gitlinks of submodules the run owns, which are checked in those
  submodules.

Any other difference means the result changed after it was accepted. The
integration stops (`needs-agreement`), and the result is presented again.
An edit made during the final attempt after the acceptance is therefore not
approved by accident.

The rest of the run folder is reviewed content, including plans, reports and
presentation files. Changes there require agreement again, whether devdocs
is a directory in the root repository or a separate submodule.

## One acceptance per result (project_migration p3/ex1)

An acceptance of a result the latest acceptance already binds is refused
(`already-accepted`, HTTP 409), whether it comes from the person (browser,
`wfe run decide --evidence`) or from a confirmation answer (`decide
--question`). "The same result" is the comparison integration makes: the
revisions differ in nothing but the run's own `run.json` and the gitlinks of
submodules it owns. Nothing is recorded and no integration is queued. A
retransmission of the recorded operation (same receipt) is still a
duplicate, not a refusal. A result changed since the latest acceptance —
the `needs-agreement` case — is accepted again; so is any result after a
rejection, or after an acceptance recorded before p9 (no revision).
Historical decisions are never rewritten.

The executor's queue reads each row again before acting on it. A queued row
whose decision is no longer the latest becomes `superseded`; so does the
row of an acceptance whose result an earlier, integrated acceptance already
brought in (records from before the refusal above). Neither is integrated.

## Preconditions and queueing

| Precondition | Why |
| --- | --- |
| The latest decision is an acceptance with a revision | An acceptance recorded before p9 names none; accept again to integrate. |
| The run has its own copy and storage | A run without one published to the shared branches already. |
| The execution is completed and no attempt is open | Integration uses work saved after every attempt ended. |
| Not integrated already | One integration per acceptance. |

- An acceptance **queues** its integration. The decision route does it in
  `afterDecision`, and the end of an attempt does it for an acceptance
  recorded during that attempt.
- The execution host carries out queued integrations whose run is ready, in
  its periodic `wfe exec reconcile`.
- A refusal or failure stays on its journal row for a person or an agent.
  Nothing is retried by itself.
- A run completed without acceptance stays saved on its branch,
  unintegrated.

## Per repository, in order

Submodules are integrated first, each before the repository that records
its gitlink: the most deeply nested first, then the root's own submodules
(devdocs first), then the root. A nested submodule's integrated commit is
recorded in its parent the way the root records its own submodules'
(project_migration p6 ex1). For each
repository the journal (`integrations.steps`) records:

- the target branch;
- the target commit observed before integrating;
- the candidate, which is the run branch's commit;
- the method: `already`, `fast-forward` or `merge`;
- the resulting commit, and whether it was pushed.

The repository's step is written before the push, so the journal names a
commit before it can reach the remote. The rules:

- **Unchanged by the run.** A repository where the run made no commit is left
  as its target has it (`already`). The root's gitlink for it is not
  touched.
- **Target not moved.** The run branch is fast-forwarded onto the target.
- **Target moved.** A combined result is made in an integration working tree
  (a `git worktree` of the copy's repository, under the run's copy folder,
  removed afterwards). It is merged, and in the root the gitlinks of the
  submodules the run owns are set to their integrated commits. Then it is
  checked:
  - A **conflict** stops with the files.
  - A combination that changes files the run changed stops as
    **needs-agreement**: the combined result differs from what was accepted.
    This includes a clean merge of different lines in the same file.

  Both are agent work: a linked repair run, not a reopened run. Nothing has
  been pushed when they stop.
- **Pushes.** Every push is a plain push of the combined commit to the target
  branch, never forced. A rejection (the target moved meanwhile, or the
  remote refused) stops with `attention`, and a retry combines again.
- **Gitlinks.** The root, and a submodule that has submodules of the run's,
  records the integrated commits of its submodules, never a run-branch
  commit that the submodule's target does not have.
- **Serialization.** Updates of one remote branch take turns on this host:
  a lock per remote URL and target, shared across runs and projects.

## Guarded bindings (project_migration p4)

A merge that Git can make is not always a result anyone accepted. Knowledge
supplemented from another project's records is the clear case: the owning
project may record the same knowledge meanwhile in another file, or take
over maintenance, and both merge cleanly. A binding declared
`integrate: if-unchanged` ([contract.md](contract.md)) makes its target a
precondition:

- For the repository that holds the binding (the submodule itself, or the
  root for a root-local path), the step compares the merge base of the
  candidate and the observed target with the observed target, **under the
  binding's path** (the whole repository for a submodule binding).
- Any change there stops the step as `target-changed` with the files,
  before anything is combined or pushed. A dry run says the same.
- A change elsewhere in the repository is integrated as usual (merge).
- A run that brought the current target into its branch (fetched and
  merged it in its copy, having seen the change) passes: the base is then
  the target.
- Reassessment is new work: a successor run (`--predecessor`) starts from
  the current target, checks again (ownership, what is already recorded)
  and presents a revised result, or none. Accepting the stopped run again
  does not change its base and stops again.

The standing reads "Not integrated: the target changed since this run
prepared its result — reassess it in a successor run" (header: *Accepted ·
target changed — reassess*). `test/guard.test.ts` covers a shared
repository, a root-local area (a change outside it merges, one inside it
stops), and a run that took the target in first.

## Not atomic, resumable

A multi-repository integration may stop between repositories. Its state is
then `partial`: the run view says which repositories are done, and the rest
are not integrated.

A retry continues from the journal:

- A step already done is checked against the target again. If the target no
  longer contains the commit, the step needs attention.
- A step whose push happened before a crash is found on the target and is
  not pushed again.
- A step whose candidate changed is computed anew.

When every repository is done, `run.integrate` is recorded with each
repository's facts (receipt `integration:<id>`, so recording twice is
harmless). A checkpoint then saves that record on the run branch.

The run's folder reaches the target as a snapshot. The live record stays in
the run's copy (`run.json` keeps going there), and the snapshot on the
shared branch is never read as the run's state.

## Operations

| | CLI | HTTP | Browser |
| --- | --- | --- | --- |
| Journal | `wfe run integrate <run> --status`, `wfe exec status <run>` | `GET runs/<wf>/<run>/integration`, `GET …/exec` (`integrations`) | Detail → Execution and publication → Integration |
| Dry run (combines locally, pushes and records nothing) | `wfe run integrate <run> --dry-run` | `POST …/integration {dryRun: true, by}` | Check integration |
| Integrate now, or retry | `wfe run integrate <run> --by <name>` | `POST …/integration {by}` | Integrate now / Retry integration |

The status is always the **latest decision's** (`shared/approval.ts`,
read alike by the run view and the CLI). A row of an earlier decision never
speaks for it, and `run.json`'s `run.integrate` outranks a journal row that
says otherwise. `wfe run integrate --status` prints that standing first
(`Now: …`, with the decision and, for a changed result, the files), then the
journal newest first, marking rows of earlier decisions and rows that
`run.json` contradicts.

The focus card of a completed or accepted run states where the result
stands:

- "Saved on its branch — not integrated (no accepted result)";
- "Accepted — integration queued";
- "Partially integrated (… done)";
- "The result changed after it was accepted — accept it again to integrate"
  (the header: "Changed since acceptance — accept again"; the focus card
  lists the changed files and offers *Accept the changed result* beside
  them; the evidence is optional there and the record names what changed);
- "Accepted — not integrated: conflict / failed / …";
- "Integrated into main".

The header's decision chip reads the same standing: "Review needed", "Answer
recorded · waiting for <agent>", "Decision needed", "Accepted · integrating",
"Accepted · integrated", "Accepted · not integrated", "Rejected". Accept is
offered only while it would record something new.

Coordination announces `integrated` (Zulip), with each repository's target,
method and resulting commit.

## Abandonment and reversal

Stopping, cancelling and discarding are separate, and none of them rewrites
history. `wfe run reversal <run>` (`GET …/reversal`) gives the facts. It
reads only and is never an operation.

- **Cancelling keeps the work.** A cancelled run's records, copy and saved
  branch stay as they are. Nothing is deleted or reverted.
- **Unintegrated work** never reached a shared branch, so discarding it needs
  no rollback. The facts name its saved branch, its heads and its copy. A new
  request can name the run as its predecessor (`wfe request …
  --predecessor <run>`, `predecessor` in `POST runs`) to reuse its plan and
  files. The new run's brief says where they are.
- **An integrated result** is undone as **new work**: a linked run with new
  commits that revert what each integration brought. Later changes on the
  targets stay, and the run's records stay as evidence. For each repository
  the facts give:
  - the target;
  - the commits before and after;
  - the commits and files in between;
  - the target's later commits, as last fetched on this host;
  - the commands, e.g. `git revert --no-commit <before>..<after>` or `-m 1`
    for a merge, followed by restoring the run's record folder and
    committing.
- **Submodules are repositories of their own**, possibly shared with other
  projects. A submodule's revert is a commit on its own target, and the root
  then records that commit. Moving the root's gitlink back alone does not
  undo the submodule's branch.
- **Effects outside Git** are named, never claimed undone: a deployed
  service, data written elsewhere, a presentation still served.
- **Not in p9:** automatic branch deletion, collecting copies, a
  classification of rollbacks and a restart-from-plan screen.

## Fixtures

`test/integration.test.ts` covers these cases:

- an unchanged target, fast-forwarded by the host's reconcile, with the
  statuses at each stage;
- a run never accepted, which stays unintegrated;
- an advanced root target and a shared study with another project's file:
  both are merged, and the root records the study's integrated commit;
- a conflict;
- a clean combination of the same file, which needs agreement;
- a deliverable edited after the confirmation's acceptance, which needs
  agreement and is not published;
- a remote that rejects the root's push: partial, then retried without
  integrating the study twice;
- a crash after the push, found on the target and not pushed again.

`test/reversal.test.ts` covers abandonment and reversal:

- a cancelled run keeps its copy and branch, with nothing on `main`;
- an integrated result is reverted by a linked run that follows the facts:
  `app.txt` and the study are restored, later work on `main` stays, the
  reverted run's snapshot stays, the root records the study's new commit, and
  the history holds both the original and the reversal.
