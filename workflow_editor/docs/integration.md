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

- the run's own record folder (administrative records: `run.json`, reports);
- the gitlinks of submodules the run owns, which are checked in those
  submodules.

Any other difference means the result changed after it was accepted. The
integration stops (`needs-agreement`), and the result is presented again.
An edit made during the final attempt after the acceptance is therefore not
approved by accident.

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

Submodules are integrated first (devdocs first), then the root. For each
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
- **Root gitlinks.** The root records the integrated commits of its
  submodules, never a run-branch commit that the submodule's target does not
  have.
- **Serialization.** Updates of one remote branch take turns on this host:
  a lock per remote URL and target, shared across runs and projects.

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

In Simple, the focus card of a completed or accepted run states where the
result stands:

- "Saved on its branch — not integrated (no accepted result)";
- "Accepted — integration queued";
- "Partially integrated (… done)";
- "Accepted — not integrated: conflict / needs agreement / …";
- "Integrated into main".

Coordination announces `integrated` (Zulip), with each repository's target,
method and resulting commit.

## Reversal

Integration never rewrites history. To undo an integrated result, prepare a
reversal as new work (a new run) from the commits `integrations[]` names
(see *Abandonment and reversal*).

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
