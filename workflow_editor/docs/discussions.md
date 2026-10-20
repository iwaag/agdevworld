# Discussions (workflow_editor p16)

A discussion is a shared conversation of **a person, a facilitator and
project agents**, each agent speaking through runs of its own project's
workflow, with its own guide, mission and context. It is the conversation
store's second kind (`kind: discussion`): it shares the id space, the
messages (verbatim text, author, time, submit token, `via`, `re`) and the
links of direct conversations ([conversations.md](conversations.md)), and
adds members, invitations and an archive. Code: `server/discussions.ts`,
`server/discussionArchive.ts`; CLI: `wfe discussion`; store: the
conversation store (`<area>/.local/conversations/conversations.sqlite`,
version 6).

The conversation routes refuse a discussion (409 `is-discussion`) and the
discussion routes refuse a conversation (409 `is-conversation`): a client
cannot give either the other's meaning by accident.

## Configuration

`<area>/conversations.json`, beside the conversation targets:

```json
"discussions": {
  "facilitator": { "workspace": "argue", "workflow": "facilitate" },
  "participants": [{ "workspace": "forge", "workflow": "discuss" }, { "workspace": "archsage", "workflow": "discuss" }],
  "archive": { "workspace": "argue" }
}
```

Without it, discussions are disabled (503 with the reason); existing records
stay readable through the CLI.

## Members

A participant is identified by:

| Kind | Id | Speaks through |
| --- | --- | --- |
| `person` | the configured person, or an author a client names (an automated trial) | the page, the CLI |
| `facilitator` | the facilitator's workspace (`argue`) | runs of `argue/facilitate` |
| `project` | the project's workspace (`forge`) | runs of its discussion workflow (`forge/discuss`) |

The agent is the run's agent (`forge-agent`); the model is the run's own
evidence (Agent ≠ Model). Membership is an append-only history of `join` and
`leave` (who, when, why); the members are its fold. Creating a discussion
joins the creator, the facilitator and the projects named. Inviting a
participant who was never a member joins it, by the inviter. A member who
left is not invited until it joins again; what it said stays.

## Invitations

An invitation is **the only thing that starts a run** in a discussion. It
records the participant and its workflow, the question (verbatim), the
messages it is about, who issued it (the person, or the facilitator's run),
whether a run awaits it, the **horizon** (the newest message when it was
dispatched), its run and its outcome. Its run is requested with receipt
`discussion:<id>:invitation:<n>`, braindump = the question, author = the
issuer, and `input.source = {kind: conversation, conversation: <id>,
message, author, at, invitation: <n>}`. A retried request or a restart finds
the same run.

| State | Meaning |
| --- | --- |
| `pending` | recorded, run not requested yet |
| `started` | its run was requested |
| `answered` | the run contributed a reply, result or synthesis (its own invitation, and any delivered to it since; `late` when it was already `unanswered`/`withdrawn`/`failed`) |
| `unanswered` | the run completed or was cancelled without such a contribution |
| `failed` | the run could not be requested (the reason is kept); reconcile retries it up to 3 tries in all, then only `wfe discussion dispatch`; never sent to another participant |
| `withdrawn` | not started, and withdrawn by hand or by closing |

An **awaited result** (argue p3) is an invitation row that starts nothing:
see *Awaiting a result* below.

Every transition is an invitation event (archived).

**Routing a person's message.** `to` names the addressees:

- participants named → each is invited with these words; the facilitator is
  not started;
- nobody named, or the facilitator named → the facilitator is invited (plus
  any others named).

- the message names (`re`) a **question a participant's run asked** the
  person, and is addressed to that participant → it is delivered to **the run
  that asked**, while that run has not ended: as the answer to its WFE
  question (`question.answer`, resuming the node that waits on it) or else
  as an instruction (continuing a waiting run), with the message as its
  source and the invitation's receipt. The invitation records `deliveredTo`.
  After that run ended, the participant is invited with a new run.

A contribution never starts anything by itself. A participant's run cannot
invite (403 `not-facilitator`); it says in its contribution whom it would
ask. The person and the facilitator invite.

## Facilitator continuation

An invitation issued from the facilitator's run is **awaited** by that run.
The facilitator makes its node wait (`wfe run wait <run> <node> --external
discussion:<id> …`) and ends its attempt, freeing the slot. When everything
it awaits is resolved (answered, unanswered, failed, withdrawn), it is given
**one instruction** listing each outcome (receipt
`discussion:<id>:continue:<run>:<outcomes>`), which continues the waiting
run ([runs.md](runs.md), *An instruction continues a run nobody executes*).
Each outcome is told once; a late answer is a new outcome. While the
facilitator's attempt is open it is told nothing (it reads the invite
results); reconcile tells it once its attempt ended. **A facilitator run that
has completed meanwhile** (argue p3) is not given the instruction: a new
facilitator turn is invited instead (by `discussion`, receipt
`discussion:<id>:continue:<run>:<outcomes>`, once), its question listing the
outcomes, so what a finished turn awaited is still taken up. A cancelled
facilitator run is told nothing. A closed discussion continues nobody.

## Awaiting a result (argue p3)

Work commissioned in a discussion outlives the turn that commissioned it: a
participant's run entrusts work to its project's workflow (a delegate node),
answers, and goes on waiting for that child; a synthesize run reports later.
`wfe discussion await --run <workspace>/<workflow>/<run> --note <what>
[--re <msg>…]`, from the facilitator's run, makes that run await the
other run's result. It records an invitation with `awaits: result`, state
`started`, the awaited run as its run and the facilitator's run as
`awaitedBy` (token `await:<facilitator run>:<run>`: the same await again is
the same row, event `awaited`). Nothing is started or delivered.

| Event | Outcome |
| --- | --- |
| the awaited run contributes a `result` or `synthesis` here | `answered` by that message |
| a `reply`, `progress` or `question` of that run | nothing: an interim word does not answer it |
| the run ends (completed or cancelled, seen by reconcile) | `answered` by its last message here since the await, else `unanswered` |
| awaiting a run that has already ended | settled at once, by the same rule |
| the discussion is closed | refused; rows already awaited stay and continue nobody while closed |

Its outcome joins the facilitator's other awaited invitations: the
facilitator is told once all are resolved (*Facilitator continuation*).
A participant can keep its own invitation open instead by answering only
with the result (a `progress` note does not answer it); either way the
facilitator is continued when the result is there, or when the run that
owed it has ended without it.

## Contributions

`wfe discussion contribute` (from an executing attempt) writes a message
attributed to the participant the run speaks for, its run, its attempt and
its invitation, naming what it answers (`--re`, required). Kinds: `reply`,
`result` and `synthesis` answer the invitation; `progress` and `question`
do not. `synthesis` is the facilitator's and is shown apart from original
speech. The same key (default: the text's hash) from the same run is one
message.

The run reads the discussion with `wfe discussion show` (its own discussion
by default): members and history, every message, the invitations and their
runs, questions waiting for the person, and the archive. Messages newer than
its invitation's horizon are marked "after your invitation".

## Closing and reopening

Closing ends automatic dispatch: invitations not started are withdrawn;
started runs finish and their contributions are recorded; no facilitator is
continued; nothing downstream is cancelled. Reopening (or a person's post)
continues the discussion; nothing withdrawn or completed is replayed —
re-invite explicitly.

## Archive

WFE's store is authoritative for live speech. The archive is a reproducible
copy in the archive project's repository (`pj-argue`):

```text
discussions/<id>/manifest.json     format ag.argue.discussion.v1, identity, members and history,
                                   invitations, horizon {message, link, membership, event},
                                   provenance (runs: workspace, workflow, agent), exports[]
discussions/<id>/transcript.jsonl  append-only records: message | membership | invitation | link
discussions/<id>/summary.md        synthesis (argue's runs; not this writer)
knowledge/                         cross-discussion knowledge (argue's runs)
```

**One writer**: `DiscussionArchive`, run by the coordinator's reconcile every
minute and by `wfe discussion archive`, in its own clone
(`<area>/.local/discussions/archive`) under a file lock. An export fetches
the published branch, reads the published manifest's horizon (**the
repository is the truth**), appends only records beyond it, rewrites the
manifest, commits (trailer `Discussion-Horizon: <id> m<n> l<n> j<n> e<n>`)
and pushes; a rejected push is rebuilt on the new remote state. Interrupted
after the push and before its bookkeeping, the next export finds nothing new
and records the commit it observes. A failed push leaves the live discussion
untouched and the archive `failed` with the reason, retried after 2^tries
minutes (at most an hour). A discussion is due when its live horizon goes
beyond the published one or its open/closed state changed (the final
catch-up on close).

Status (`GET api/discussions/<id>/archive`, the view's `archive`, `wfe
discussion archive --status`): `current`, `behind`, `failed`, `never` or
`disabled`; the published commit, horizon, time and Gitea tree URL; the live
horizon.

## HTTP

| Route | |
| --- | --- |
| `GET api/discussions` | `{person, disabled, participants, discussions}`; participants are the facilitator and the invitable projects as their projects say now (`state`, `problem`) |
| `POST api/discussions {id, title, members?, text?, token?, to?, re?, author?}` | creates (201; the same id by the same author again is 200), and posts the brief when `text` is given |
| `GET api/discussions/<id>[?since=<msg>]` | `discussion`, `members`, `membership`, `messages` (with `participant`, `run`, `runUrl`, `invitation`, `addressed`), `invitations` (with `runUrl`, `awaits`), `links`, `runs` (shared status, run view, file route, presentations), `asking`, `horizon`, `archive` |
| `POST api/discussions/<id>/messages {text, token, to?, re?, author?, via?}` | the person's words; `{message, invitations, duplicate, reopened}` |
| `POST api/discussions/<id>/invitations {participant, question, re?, token?, author?}` | the person's invitation |
| `POST api/discussions/<id>/invitations/<n>/withdraw {reason}` | withdraws one not started |
| `POST api/discussions/<id>/members {participant, action: join\|leave, note?}` | membership |
| `POST api/discussions/<id>/close`, `…/reopen` | |
| `GET`/`POST api/discussions/<id>/archive` | status / publish now (502 with the reason on failure) |

Writes follow the conversation contract's browser rules (same origin or an
allowed one; the page's words are the configured person's).

## Hand-off and reuse

An outcome is handed to an implementing project as an ordinary request
naming the pinned source (`argue@<commit>:discussions/<id>/summary.md`, the
messages); the argue run records the resulting run with `wfe discussion link
<id> <msg> --run <ws>/<wf>/<run> --as handoff --note …`, which the archive
exports. Later runs find knowledge in `pj-argue` `knowledge/` (`wfe projects
files argue knowledge/…` from other projects).
