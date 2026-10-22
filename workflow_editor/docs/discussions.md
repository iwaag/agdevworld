# Discussions (workflow_editor p16, argue p4, argue p4 ex1, argue p4 ex2, argue p4 ex3)

A discussion is a shared conversation of **a person, a facilitator and
project agents**, each agent speaking through runs of its own project's
workflow, with its own guide, mission and context. It is the conversation
store's second kind (`kind: discussion`): it shares the id space, the
messages (verbatim text, author, time, submit token, `via`, `re`) and the
links of direct conversations ([conversations.md](conversations.md)), and
adds members, invitations and an archive. Code: `server/discussions.ts`,
`server/discussionArchive.ts`; CLI: `wfe discussion`; store: the
conversation store (`<area>/.local/conversations/conversations.sqlite`,
version 10).

The conversation routes refuse a discussion (409 `is-discussion`) and the
discussion routes refuse a conversation (409 `is-conversation`): a client
cannot give either the other's meaning by accident.

Since argue p4 the facilitator is `ponderer/conduct`: one **conductor run**
owns a discussion's progression across many attempts, and its graph shows
how the discussion proceeds as discussion **activities** (*Conductor*,
*Activities* below). Episode: `devdocs/episodes/argue/p4/`. Since argue p4
ex1 ponderer also keeps the archive, the summaries and the evaluations
(`pj-ponderer`); the `argue` project is retired.

## Configuration

`<area>/conversations.json`, beside the conversation targets:

```json
"discussions": {
  "facilitator": { "workspace": "ponderer", "workflow": "conduct" },
  "participants": [{ "workspace": "forge", "workflow": "discuss" }, { "workspace": "archsage", "workflow": "discuss" }],
  "archive": { "workspace": "ponderer" }
}
```

Without it, discussions are disabled (503 with the reason); existing records
stay readable through the CLI.

A participant is a workspace with one discussion workflow; the facilitator's
workspace cannot also be a participant. Other workflows of a participating
project (ponderer's `synthesize`, a forge `provide`) are reached by ordinary
delegation or requests from that project's runs, and any run of the
facilitator's or the archive project's workspace may speak there (a
synthesis included).

## Members

A participant is identified by:

| Kind | Id | Speaks through |
| --- | --- | --- |
| `person` | the configured person, or an author a client names (an automated trial) | the page, the CLI |
| `facilitator` | the facilitator's workspace (`ponderer`) | runs of `ponderer/conduct` (and, for a synthesis, other ponderer runs) |
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
- nobody named, or the facilitator named → **the open conductor run** is
  given the words (argue p4): as the answer to the question of its that the
  message names (`re`), else to its only open question asked in the
  discussion, else as an instruction. No second run is started. Without an
  open conductor the facilitator is invited, and that run conducts (plus
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

## Conductor (argue p4)

`conversations.conductor` names the facilitator's run that owns the
discussion's progression. It is set when an invitation starts a facilitator
run while no other conductor is open, or when the facilitator's attempt
creates the discussion (`wfe discussion create` from that attempt). A
conductor that completes leaves the discussion open: the next untargeted
message, or a late outcome it awaited, starts a new conductor run. The
discussion id stays independent of runs.

`conversations.requester` is whom the conductor's `talk` consults:
`{kind: person, id}` (the person who opened it, or on whose behalf the
conductor run was requested) or `{kind: run, run, agent}` (the run that
delegated or requested the conductor run, e.g. Front's converse run). Each
change of either is an activity event.

## Activities (argue p4)

A node of the conductor's run carries `activity: announce | ask | ponder |
talk` (contract.md *Discussion activities*; `talk` on a talk node, the
others on do nodes). Each is performed from the conductor's attempt (talk
with `wfe run ask`, the others with their command) and recorded as an **activity** (`activities`, with an
append-only `activity_events` history: each event keeps the activity as it
then was).

| Activity | Command | Completion evidence | Completed by |
| --- | --- | --- | --- |
| `announce` | `wfe discussion announce --node <n> --text … --re …` | the message (kind `announce`, key `activity:<run>:<node>`); it waits for nobody and answers the conductor's own invitation | the command: the message first, then the node; reconcile completes a node whose message was delivered when the attempt ended first |
| `ask` | `wfe discussion ask <participant>… --node <n> --question … --re …`, or `--run <run>` to await a commissioned result | each invitation of the activity answered (#m), unanswered, failed or withdrawn | **WFE**, once no attempt is open: the node resumes and completes with the outcomes, then the run gets one instruction listing them (or, completed, a new conductor run) |
| `ponder` | `wfe discussion ponder --node <n> --decision … --source <msg>… [--next <activity>:<node>]… \| --definition <file>` | the decision, its sources, the next activities and the run revision | the command, with the revision in the same write (`run adjust --completing`) |
| `talk` | `wfe run ask <run> <n> --to <requester> --question …` (no discussion command since fix3); WFE posts it (*Questions*) and records the activity | the WFE question (to the requester) answered and taken up, or withdrawn | the agent, as any talk; reconcile records the activity's end |

- **Waits.** An ask waits `external: discussion:<id>:activity:<a>` (holder:
  the invited participants or the awaited run); a talk waits on its
  question; both free the slot.
- **Groups.** Invitations of one ask are one group: its node completes when
  all are resolved. Invitations a facilitator issued without an activity
  keep the per-run continuation above.
- **Settling.** `wfe discussion settle --node <n> --reason` completes an ask
  early, naming what is still open; their later outcomes are told as late
  outcomes of that ask. Unavailable participants fail at once.
- **Graph.** `--next` appends a chain of new nodes after the ponder node
  (`announce:agenda`, `ask:facts`, `ponder:after-facts`). Another round is
  new nodes; completed ones and their records stay; no cycle.
- **A turn that spoke and left its node running** (p3:
  rts-vs-bot/discuss/run-001, run-004): `wfe discussion contribute
  --completing <node>` speaks and completes in one command. Reconcile
  completes a node whose message was delivered (a message with `node`, or a
  participant's reply answering its invitation in a one-node discussion
  workflow) after the attempt ended without completing it, and lifts a hold
  whose only cause was that node left running (`run.resume` by
  `discussion`).
- **Conclusion.** `wfe discussion announce --conclude [--close]` records the
  **obligations** the discussion still has (open invitations and awaited
  results, questions waiting for the person, runs of the discussion still
  working and their open delegations), each with its owner and who
  receives it later: the run awaiting it, a new conductor run, the
  delegating run, or "recorded only: the discussion is closed". Closing
  still cancels nothing.
- `wfe discussion state` is the compact read the conductor works from: the
  conductor and requester, its graph with each node's activity, open
  invitations, questions, obligations, annotations.

## Annotations (argue p4)

`wfe discussion annotate <id> --kind intervention|recovery|evaluation|
correction|note --text … --author <who> [--re <msg>…] [--run <run>]`
records something said about the discussion from outside its speech: an
Omni hint, a repair, an external evaluation, a correction of an earlier
claim (which stays as it was said). It starts nothing, is not a message,
and is archived and shown apart.

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
`result` and `synthesis` answer the invitation; `progress` does not. A
question is not a contribution (*Questions*). `synthesis` is the
facilitator's and is shown apart from original speech. The same key (default: the text's hash) from the same run is one
message.

The run reads the discussion with `wfe discussion show` (its own discussion
by default): members and history, every message, the invitations and their
runs, questions waiting for the person, and the archive. Messages newer than
its invitation's horizon are marked "after your invitation".

## Questions (workflow_editor fix3)

A question is one thing everywhere: the run's WFE question (`wfe run ask`),
whoever asks it — a participant, the conductor on its talk node, or the
conductor relaying a delegated child's question from its delegate node.
**WFE posts every open question of a run that speaks for an open
discussion** (its invitations' runs and its conductors) as a message of
kind `question`: the question's text, attributed to the asking agent and
the run's participant, with its question id and node, naming the message
the run was invited for (`re`), key `question:<run>:<q>`, so one message
per question. `wfe run ask` posts it at once; the executor's reconcile posts
what that could not (a failure after the record). A question on the
conductor's talk node is also the `talk` activity. A person's reply naming
the message is delivered to the run that asked as its answer (*Routing*).
`wfe discussion contribute --kind question` and `wfe discussion talk` are
refused: two ways to ask, one of which posted nothing, made
ponderer/conduct/run-020 relay gimmickimg's question with `wfe run ask`
alone, and the discussion said it awaited nobody while the run awaited the
person.

## Closing and reopening

Closing ends automatic dispatch: invitations not started are withdrawn;
started runs finish and their contributions are recorded; no facilitator is
continued; nothing downstream is cancelled. Reopening (or a person's post)
continues the discussion; nothing withdrawn or completed is replayed —
re-invite explicitly.

## Archive

WFE's store is authoritative for live speech. The archive is a reproducible
copy in the archive project's repository (`archive.workspace`'s origin;
`pj-ponderer` since argue p4 ex1, `pj-argue` before):

```text
discussions/<id>/manifest.json     format ag.argue.discussion.v1, identity, members and history,
                                   conductor, requester, activities (argue p4), category, displayTitle,
                                   overview (argue p4 ex2), invitations,
                                   horizon {message, link, membership, event, activity, annotation, meta, overview},
                                   provenance (runs: workspace, workflow, agent), exports[]
discussions/<id>/transcript.jsonl  append-only records: message | membership | invitation | link
                                   | activity (argue p4: activity, conductor, requester events)
                                   | annotation | meta | overview (argue p4 ex2)
                                   | workflow | workflow-link (argue p4 ex3)
discussions/<id>/workflows/<sha256>.yaml   each workflow version a record names (argue p4 ex3), once
discussions/<id>/summary.md        synthesis (the archive project's runs; not this writer)
```

The format keeps its first name, `ag.argue.discussion.v1`, which every
manifest carries.

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

**Destination.** Each publication record keeps the repository its commit and
horizon were verified in (`destination`: the origin URL without credentials;
store v8). When `archive.workspace` names another project, nothing is
assumed about the new repository:

- a record of another destination (or one written before v8, which has
  none) is `unverified`, never `current`, and its link still names the
  repository it was verified in;
- it is due: the next export reads the new destination's own manifest,
  appends only what lies beyond that horizon (nothing, when the history was
  imported there first) and records the commit it finds there;
- the writer's clone of another origin is deleted and cloned again from the
  destination, never re-pointed.

A switch therefore moves the history first (an import that keeps the
commits, as argue p4 ex1 did with `git merge --allow-unrelated-histories`),
then the configuration; the reconcile verifies each discussion in the new
repository within a minute.

Status (`GET api/discussions/<id>/archive`, the view's `archive`, `wfe
discussion archive --status`): `current`, `behind`, `unverified`, `failed`,
`never` or `disabled`; the published commit, horizon, time, destination and
Gitea tree URL; the live horizon; the configured repository.

## HTTP

| Route | |
| --- | --- |
| `GET api/discussions[?category=discussion\|check&state=open\|closed\|all&limit=&offset=]` | `{person, disabled, participants, counts, total, offset, discussions}`; participants are the facilitator and the invitable projects as their projects say now (`state`, `problem`); `counts` per category and state; each row with `category`, `displayTitle`, `newest` (its newest message id), `participants` (project members), `overview` or `brief`, `status`, `activity`, `archive` — computed for the page's rows only |
| `POST api/discussions {id, title, members?, category?, text?, token?, to?, re?, author?}` | creates (201; the same id by the same author again is 200), and posts the brief when `text` is given |
| `POST api/discussions/<id>/meta {category?, displayTitle?, note?, author?}` | corrects the category or display title (`displayTitle: null` removes it); records only |
| `GET api/discussions/<id>/overview` | `{overview, revisions, brief}` |
| `POST api/discussions/<id>/overview {purpose, outcome?, unresolved?, through?, displayTitle?, note?, author?, token?}` | a new overview revision; records only |
| `GET api/discussions/<id>[?since=<msg>]` | `discussion` (with `conductor`, `requester`, `category`, `displayTitle`), `overview`, `overviews`, `brief`, `status`, `meta`, `activities`, `annotations`, `obligations`, `members`, `membership`, `messages` (with `participant`, `run`, `runUrl`, `invitation`, `addressed`, `node`), `invitations` (with `runUrl`, `awaits`, `activity`), `links`, `runs` (shared status, run view, file route, presentations), `asking`, `horizon`, `archive` |
| `POST api/discussions/<id>/messages {text, token, to?, re?, author?, via?}` | the person's words; `{message, invitations, duplicate, reopened}` |
| `POST api/discussions/<id>/invitations {participant, question, re?, token?, author?}` | the person's invitation |
| `POST api/discussions/<id>/invitations/<n>/withdraw {reason}` | withdraws one not started |
| `POST api/discussions/<id>/members {participant, action: join\|leave, note?}` | membership |
| `POST api/discussions/<id>/close`, `…/reopen` | |
| `GET`/`POST api/discussions/<id>/archive` | status / publish now (502 with the reason on failure) |

Writes follow the conversation contract's browser rules (same origin or an
allowed one; the page's words are the configured person's).

## Reading a discussion (argue p4 ex2)

What a reader needs to choose a discussion and understand it: what it is
for, what came of it and what it needs now. Episode:
`devdocs/episodes/argue/p4/ex2/`.

**Category.** Each discussion is a `discussion` (the default) or a `check`
(an operational check, a fixture or a trial of the system). Clients list
checks apart.

- It is set at creation with `--category check` or the create route's
  `category`. Automated fixtures and operational trials declare it.
- It is corrected later with `wfe discussion meta <id> --category …
  --note <why>`, or `POST api/discussions/<id>/meta`.
- A prefix such as "[Check]" in a title is not a classifier. A substantive
  discussion held as an experiment is a `discussion`.

**Display title.** This is a one-line title for readers, recorded
explicitly (`meta --title`, or `overview --title`). The original title and
the id stay and are shown in the room's details. No client derives a
display title from the original by string rules.

Every change of either is an append-only `discussion_meta` record: field,
value, who, run, when and why. A metadata write never touches messages,
invitations, runs, the open/closed state or `updated` (the list order).

**Overview.** An overview is a short interpretation for readers. It is
shared by the list and the top of the room, and it has three parts:

- the purpose: what the discussion is trying to establish;
- the outcome, which is optional: what it has concluded so far;
- the unresolved points.

Every part cites the messages it rests on as `[#n]`. WFE refuses a part
without a citation, and a citation that is not a message of the discussion
or is newer than the overview's coverage.

| Field | |
| --- | --- |
| `author`, `run` | who wrote it: from a run, the facilitator's or the archive project's (its agent and run); outside a run, whoever is named (the person, an outside agent) |
| `through` | the newest message it covers (default: the newest when written) |
| `sources` | every message it cites |
| `note`, `at` | why this revision, when |
| `after` (views only) | messages newer than `through`: readers see "covers through #n, N later" |

- An overview is not speech, not proof of agreement, and not the
  discussion's state. It starts nothing.
- A new overview is a new revision. The newest is current, and the earlier
  ones stay in the store and in the archive.
- Disagreement, uncertainty and open work belong in it.
- An overview may be written in the readers' language. It condenses what
  the cited messages say, and those messages stay one action away.
- Writing one is available work, never a step every discussion must pass.
  Reading a list or a room never runs a model.
- Without an overview, readers get the **brief** (the earliest of the
  person's messages and the conductor's announcements, first 400
  characters), labelled as the request, never as a conclusion.

**Status** (`status` in the list and the view) comes from WFE's records:

- `room` is `open` or `closed`. A closed room may still owe work.
- `working` counts open invitations, awaited results, runs of the
  discussion still working and their open delegations.
- `owed` counts every obligation, questions included (*Activities*,
  *Conclusion*).
- `awaiting` lists open questions, each with its receiver:
  - a `talk` question goes to the requester, either a person id or a run
    with its agent;
  - any other open question goes to whom the run asked it: a person
    (`to` is the configured person or a person member), else that agent,
    with the requesting run when it is the requester's (fix3).
  - `you` is true only when the receiver is the configured person.
- `failed` lists failed invitations with WFE's reason.
- `held` lists runs of the discussion that are stopped, interrupted or
  unknown.

**Archive.** Transcript records `meta` (field, value, by, run, note) and
`overview` (all fields above but `after`). The horizon gains `meta` and
`overview`; manifests written before have neither, which counts as 0. The
manifest carries `category`, `displayTitle` and the current `overview`. A
metadata change or a new overview makes the discussion due.

## Character dialogue (argue p5)

A client may also show each agent message as one short line in its
speaker's character voice: `docs/dialogue.md`. Those lines are a
presentation kept beside the archive project's workspace, never in this
store. Nothing in this document reads or writes them, and a reply, a
citation or an overview always names the original message.

## Workflows in a discussion (argue p4 ex3)

Which workflow a turn referenced, created, edited or executed, at which
exact version, recorded as evidence beside the speech: a reader sees what
an agent consulted, made and changed without leaving the discussion.
Episode: `devdocs/episodes/argue/p4/ex3/`. Code:
`server/discussionWorkflows.ts`; CLI: `wfe discussion workflow`.

**A record** (`workflow_refs`) names:

| Field | |
| --- | --- |
| `relation` | `referenced` (declared material), `created`, `edited`, `executed` (a run started from the turn) |
| `role` | `progression`: the facilitator's own conductor graph (and the facilitator's project's work its run requests); otherwise `subject` (a reference may declare it) |
| `project`, `workflow`, `target` | `{kind: definition, file}` (a reusable definition) or `{kind: run, run}` (one execution of it) |
| `after`, `before` | the version: `kind` `draft` (working-tree bytes not equal to the committed file), `committed` (equal to the file at `commit`) or `revision` (a run's frozen `rN`, with its history `seq`); `sha256` of the bytes, `definitionDigest` (the semantic digest: layout and appearance excluded); `at`, when that version came to be (the adjustment; r1: the run's creation; a definition: when WFE read it) — the record's own `at` is when it was recorded, later for a derived or backfilled record. `before` for an edit |
| `nodes` | the nodes it singles out (a reference's `--node`; an edit's added and changed nodes) |
| `messages` | the explicit source messages; later associations are `workflow_ref_events` |
| `run`, `attempt`, `invitation`, `activity`, `actor`, `origin` | the turn: the actor run and attempt, its invitation, the conductor's ponder activity; `origin` the discussion run a delegated or requested child works for |
| `evidence`, `operation` | `operation` (written by the operation, or derived from the run's own history), `claim` (an authored reference), `backfill` (derived for history, said in the note); the source operation (`workflow.save`, `workflow.new`, `run.adjust:rN@seq`, `run.request:<receipt>`, `delegate.request:<d>@seq`, `attach`) |
| `state` | `recorded`; `unconfirmed` (an interrupted operation whose effect could not be verified, shown only as such); `pending` (a journal entry, never shown) |

**Every version a record names is captured** (`workflow_snapshots`, by
sha256): a saved definition is a draft the next save replaces, so its
bytes are the only proof of what was seen. Snapshots are kept with the
store and exported to the archive.

**What records what.** From an executing attempt whose run works for a
discussion — invited to it (`input.source`), conducting it, or entrusted by
such a run (a delegation or request, followed up to four levels):

| Operation | Record |
| --- | --- |
| `wfe workflow save` | `edited` definition, the replaced bytes `before`, the saved bytes `after` (an unchanged save records nothing) |
| `wfe workflow new` | `created` definition, a draft |
| `wfe run adjust`, `wfe discussion ponder --next/--definition` | `edited` run, `rN-1` → `rN`, from the run's history (token `adjust:<run>:<rN>`), with the ponder activity |
| `wfe request --request` | `executed`, the child's `r1` (token `request:<receipt>`) |
| `wfe delegate request` | `executed`, once the child exists, from the delegation record (token `delegation:<uid>`) |
| `wfe discussion workflow attach` | `referenced` (or the relation declared), evidence `claim` |

A record is written **after** the operation succeeded. A save, a creation
and a request are journaled first (`pending`, with the bytes a save will
write); the executor's reconcile resolves a journal entry older than a
minute from the operation's own evidence (the file holds the saved bytes;
a job carries the request's receipt) or marks it `unconfirmed`. Revisions
and delegated children are derived from the runs of open discussions on
every reconcile under the same tokens, so a hook and a repair record each
once. Editing a definition in the editor (no attempt) is not recorded.

**What a reference proves.** WFE reads and captures the version it names,
so the record proves what was retrieved at that turn — not that it was
understood. A shell read of a file, a workflow named in prose or the time
of a message is never taken as a reference.

**Message association.** A record carries the messages named when it was
made (`attach --re`) and those added later (`workflow link`, `contribute
--workflow <record>`: a run links its own records; the person any, with a
note). Without one, the record keeps its turn; clients show it as a
recorded operation of that turn, never under the nearest message.

**Reading** (no model, no run, no write):

| Route | |
| --- | --- |
| `GET api/discussions/<id>/workflows` | `{workflows, horizon}`: each record with `name`, `available`/`unavailable`, `changes` (an edit), `preview` (node boxes, edges and marks for a card), `runUrl`, `editorUrl` (the editor's current view) |
| `GET api/discussions/<id>/workflows/<n>` | the pinned graph: `after` and `before` (`version`, `workflow`, `effective`, or `unavailable` with the reason), `changes`, `state` (a run's node states replayed to the recorded `seq`, or `unavailable`: a definition has none), `time` |
| `GET api/discussions/<id>/workflows/<n>/current` | the target as it is now, labelled current: the working-tree definition, or the run's revision in force with its current states; `same` says whether it is still the recorded bytes |

A version is read from its snapshot, else from the run's frozen files; its
sha256 is checked (`unavailable: digest mismatch`), it is parsed and
compiled, never executed. A version that was never captured, or whose
source is gone, is `unavailable` — never replaced by the current file,
main, a newer draft or the latest revision.

**Comparison** is by node id and edge endpoints: nodes `added`, `removed`,
`changed` (with each property's before and after: type, name,
description, repositories, workflow, project, accepts, confirms,
activity), `restyled` (appearance or position only), edges added and
removed, workflow-level fields, and the compiled graph's generated steps
(`_…`) apart. `behavioural` is false when the semantic digests are equal.
A new id is an addition and a removal; a rename is never inferred.

**Archive.** Transcript records `workflow` (the record as recorded) and
`workflow-link` (an association); horizon `workflow`, `workflowEvent`
(absent before: 0); the manifest's `workflows` lists every record with its
snapshot paths; every version's bytes are written once to
`discussions/<id>/workflows/<sha256>.yaml`, which is what a fresh reader
resolves a version from after its source branch moved or its project
retired.

## Hand-off and reuse

An outcome is handed to an implementing project as an ordinary request
naming the pinned source (`ponderer@<commit>:discussions/<id>/summary.md`,
the messages); the run that handed it over records the resulting run with
`wfe discussion link <id> <msg> --run <ws>/<wf>/<run> --as handoff --note …`,
which the archive exports. Earlier discussions are read in the archive
project (`wfe projects read ponderer discussions/…`); reusable discussion
knowledge is ponderer's `wedo-argue`; what a discussion found about its
subject is the owning project's. Citations `argue@<commit>:…` written
before argue p4 ex1 name commits that are in pj-ponderer's history
(`HISTORY.md` there).
