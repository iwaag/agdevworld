# Run sessions (agent_session p1)

A run is the work; an **attempt** is one active execution interval (its own
process, `WFE_ATTEMPT`, log, time budget and reports); a **session** is a
harness conversation the attempts of one run may share. Records and Git stay
authoritative: a retained conversation is useful context, never a second work
record, and the records must always be enough for a new session to continue.

## The policy

`execution.session` in the workflow ([contract.md](contract.md)):

| Value | Attempts |
| --- | --- |
| `fresh` (or not declared) | every attempt starts a new session from the run's records and files |
| `run` | later attempts resume the run's current session by its id |

The policy is part of the definition (its digest when declared) and is
frozen with the run's bundle at creation: editing the workflow changes future
runs only. The editor offers it in Detail → Workflow settings → Execution.

## Which session an attempt uses (claim)

`wfe exec claim` resolves it from the frozen policy, the run's recorded
sessions and what the execution host offers (`--sessions-json`: per profile,
`explicit` when its harness creates a conversation under a caller-chosen id
and resumes exactly that id; `''` is the host's default profile):

- `run` on a profile the host does not offer sessions for: the job is
  dropped with the reason. It never runs fresh in place of `run`.
- `fresh`: a new session; on an explicit-id profile under a new UUID,
  otherwise without an id.
- `run`: resume the current session when it was created under the same
  configuration — agent, profile, backend, common contract by hash and the
  context fingerprint with its effective sources ([context.md](context.md)). Otherwise a new session (new UUID) replaces it, and the reason
  says what changed (`configuration changed: context guide/agent/g.md changed`), or
  that the previous one was retired or ended. A profile chosen at a resume
  ([runs.md](runs.md), *Holds*) is such a change: the next session is new.

The decision is recorded in `attempt.begin` (`settings.session = {policy,
mode: new|resume, id, replaces?: {id, reason}}`) **before** anything is
launched, so an executor restart or an early crash never leaves an unnamed
conversation. A resume always names the run's current session; a new session
never reuses an id of the run (`session-mismatch`). Nothing selects "the
latest conversation" of a directory or account.

## `run.json` `sessions[]`

One entry per session, portable identities only (transcripts stay in the
execution host's harness store):

`{id, policy, began, attempt (that created it), attempts[], config {agent,
profile, backend, contract, context {fingerprint, sources}} (guides before p13), state: open|replaced|retired, attached?,
attachedIn?, mismatch?, ended? {at, by, reason}}`. The last `open` entry is
the run's current session.

| Operation | By | What it records |
| --- | --- | --- |
| `attempt.begin` with `settings.session` | the execution host | a new session (the previous open one becomes `replaced` with the reason) or another attempt of the current one |
| `attempt.session` `attached` | the execution host, fenced by the open attempt | the id the harness reported (its init event); a different id than intended sets `mismatch` |
| `attempt.session` `replaced` | the execution host, fenced, only before the session was attached in this attempt | the session to resume is missing on the host: nothing ran in it, so a new one (new id) serves this attempt; old and new identity and the host are named |
| `session.retire` | a person or a recovering agent, between attempts, no live process of the run | the current session ends; the next attempt starts a new one from the records |

`wfe exec session <attempt> --attached <id> | --missing [--detail …]` and
`wfe run session <run> [--retire --reason … [--because …]]` are the CLI
forms. A repeated `--missing` report returns the same replacement.

## A reported id that differs (agent_session p1 ex1)

If the harness reports another session id than the one the attempt was
launched with, the conversation is unverified. Nobody chose it, and it may
not hold the run's context. The execution host:

1. records both ids (`attached`, `mismatch: true`);
2. stops the attempt and confirms that its process group is gone;
3. ends the attempt with `wfe exec finished … --interrupted "session
   mismatch: …"`, which holds the run as `interrupted` whatever the exit code.

Under `run`, that session is never continued automatically. `run.resume` and
`run.recover` are refused with `session-mismatch`, and so is claim's choice.
The refusal names the next step: look at the run and at what the attempt
did, then `wfe run session <run> --retire --reason "<what you found>"`.
After that, a resume or a recovery is permitted, and the next attempt starts
a new session whose `replaces` names the retirement. Retiring lifts no hold,
needs no live process, and resets no recovery budget. The retired entry keeps
`mismatch`. Under `fresh`, nothing reuses the session, so only the hold
applies.

A failed `attempt.session` record stays pending in the executor and is
retried on every tick. The end report carries `--attached <id>`, which
records it before `attempt.end`; if that fails as well, the id is named in
the end's detail.

## Continuation

A new session gets the whole bootstrap: the common contract, the scoped
context and the brief. Since agent_session p1 ex2 the brief always names the
original input and the current `plan.md`, and it gives every pending answer
in full. A replacement session therefore reconstructs the original
requirement and the agreed plan, and not only the run's first attempt does.

An ordinary resume gets the **continuation** that `wfe exec claim` returns
(`continuation`; `server/continuation.ts`). The executor puts the attempt
identity before it: the new attempt id, earlier ids ended (their reports
are refused), earlier processes gone, memory is context and the record
decides. The continuation then holds:

- why the attempt runs, and how the previous attempt ended. An attempt that
  did not end normally adds that its effects are uncertain: files and record
  are checked before a command is repeated. A recovery's finding, a
  person's resume and the project's commits since the copy's base follow.
- **The delta**: one line per record entry after the session's previous
  attempt's `attempt.begin` that the previous attempt did not write itself.
  The executor's own bookkeeping is left out. The list has at most 30
  lines, with a `wfe run state <run> --since <seq>` refresh for the rest.
  The boundary is a record seq. Nothing is inferred from timestamps or from
  a normal process exit.
- **The compact state** at the snapshot's seq: hold or cancellation, nodes
  ready, running, waiting (for whom) and failed, presentations not stopped,
  the definition revision in force, decisions.
- **The pending input, in full**: every answer recorded and not taken up
  (exact text, question, answer index, author, the question it answers),
  every instruction not acknowledged, every delegation fact not taken up.
  It is selected by state, not by a delivery cursor. An input sent in a
  prompt whose attempt failed is still pending, so the next continuation
  carries it again. Repetition is bounded by take-up.
- the instructions of documentation steps that are running, ready or
  waiting now and that this conversation was not briefed with. That means
  steps not active at the beginning of any of its attempts since it last
  got the whole bootstrap.
- the snapshot's seq, the refresh command, and `wfe run show` for the full
  record.

Nothing else is repeated: identity paths, the node catalog, the
documentation policy, contract and context. They are unchanged, or the
session would have been replaced. Nothing tells the agent to read the whole
run. `wfe run state <run> [--since <seq>]` is the compact read: the same
state and pending input, plus the entries after a seq. `wfe run show`
(`--history`) stays the full record and a diagnostic. Input recorded after
the snapshot is found in the next state read; the write-time fence
(`attempt-stale`) stays in force. (`instructions-pending` was removed in p11.)

**Compaction.** At claim, a resume of the current session checks the logs
of its attempts since it last got the whole bootstrap. The bootstrap is
given in the session's first attempt and in every reconstruction. A
`compact_boundary` event in any of those logs means that a summary may have
replaced the bootstrap. So does a log that cannot be read: a compaction
cannot be ruled out. In either case the attempt resumes the same
conversation with the whole bootstrap again. The reason is recorded before
launch (`settings.session.reconstruct`), and the executor tells the agent
why. The next ordinary resume after that is a continuation again. Cache
expiry alone is not a reason: the conversation is intact and only the
provider's cache is cold.

## Lifecycle

- A question or a hold ends the attempt and releases the slot; the session
  waits in the store and holds nothing. An answer queues the next interval as
  before. The attempt time budget is per interval, never a session lifetime.
- An attempt that was interrupted is held as before; a recovery (or a
  person's resume) continues it, under `run` in the retained session with
  the recovery's finding in its brief. Replacing or retiring a session resets
  no recovery budget.
- A resume that was launched and then failed is an interrupted attempt, not
  permission for an immediate fresh retry; the next attempt's store check
  replaces a conversation that is really gone.
- One writer per conversation: the harness does not refuse a second process
  resuming the same session, so the one execution slot, attempt fencing and
  "no launch while a process of the run lives" are what keep it single.

## Observation

`wfe observe` carries `session` per run and `process.session` per attempt
from the record ([observation.md](observation.md)). A retained session is no
process and its age is no stall timer; incidents stay per attempt.

## Harness support

Only `claude_code` keeps explicit sessions (`agag.harness.SESSION_HARNESSES`,
verified on 2.1.283: `--session-id`, `--resume`, missing-session and in-use
errors). `codex` runs ephemeral; `agy`, `gemini_cli` and `agcode` are not
verified. Their profiles accept `fresh` and refuse `run`.

Measured cost and the chosen default: devdocs `episodes/agent_session/p1/`.
