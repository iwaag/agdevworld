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
  configuration — agent, profile, backend, common contract and project guides
  by hash. Otherwise a new session (new UUID) replaces it, and the reason
  says what changed (`configuration changed: guide agent/g.md changed`), or
  that the previous one was retired or ended.

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
profile, backend, contract, guides}, state: open|replaced|retired, attached?,
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

## Continuation

A new session gets the whole bootstrap (common contract, project guides,
brief). A resumed one gets a continuation: the new attempt id, that earlier
attempt ids in the conversation are ended (their reports are refused) and
earlier processes are gone, that memory is context and the record decides,
the brief, and the command to read the run. Contract and guides are not
appended again: they are unchanged, or the session would have been replaced.

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
