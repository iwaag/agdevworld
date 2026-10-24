# Conversations (project_migration p8, workflow_editor p15–p16, argue p3–p5, challenge p1–p2)

A conversation is a person talking with project agents, each agent speaking
through runs of its own project's workflows, with its own guide, mission and
context. It may be one project (a one-to-one room), several, or a room the
**conductor** (ponderer) leads. All of these are one kind of record served
by one engine since challenge p2 (episode `devdocs/episodes/challenge/p2/`);
before it, one-to-one conversations and facilitated discussions were two
engines over the same table.

Code: `server/conversations.ts` (the store: conversations, messages, links,
attachments; configuration), `server/conversationService.ts` (everything
that routes, delivers and reads), `server/conversationArchive.ts`,
`server/conversationWorkflows.ts`; CLI: `wfe conversation` (`wfe
discussion` is the same command); HTTP: `api/conversations`; store:
`<area>/.local/conversations/conversations.sqlite` (version 12).

WFE owns identity, membership, messages, delivery, execution, recovery and
the archive. A client (aghangout, the Slack integration, the CLI) owns
presentation: which character stands for a participant, how a room looks.

## Configuration

`<area>/conversations.json`:

```json
{
  "person": "iwaag",
  "projects": [
    { "workspace": "front", "converse": "converse", "discuss": "discuss" },
    { "workspace": "forge", "converse": "converse", "discuss": "discuss" },
    { "workspace": "ponderer", "converse": "converse" }
  ],
  "facilitator": { "workspace": "ponderer", "workflow": "conduct" },
  "archive": { "workspace": "ponderer" },
  "dialogue": { … }
}
```

- `person` is who a page's words are recorded as.
- `projects` are the projects that can take part, each with the workflow it
  uses in a one-to-one room (`converse`) and among several (`discuss`); one
  of them is enough. A project with `converse` is offered for one-to-one
  rooms.
- `facilitator` is the workflow that conducts a facilitated room. Its
  workspace may also be a project (ponderer consulted directly).
- `archive` is the project whose repository keeps every conversation's
  archive.
- The shape before challenge p2 (`targets` and `discussions`) is read as this
  one.

Without the file (or with an invalid one) conversations are disabled (503
with the reason); existing records stay readable through the CLI.

## Records

| Record | |
| --- | --- |
| conversation | id (client-minted, `[a-z0-9][a-z0-9-]{0,47}`), title, `open`/`closed`, category (`conversation` or `check`), display title, default addressee, conductor run and requester, `kind` — how it began (`conversation` one-to-one or `discussion` facilitated, before p2), which names only its archive namespace |
| member | the person(s) and projects: an append-only history of `join` and `leave` (who, when, why), folded into the members. Rows written before p2 may say `facilitator` for ponderer; it reads as a project |
| message | the person's words verbatim (author, time, submit token, `via`, `re`, whom it reached) or an agent's speech (participant, agent, run, attempt, request, node, kind `reply`/`question`/`progress`/`result`/`synthesis`/`announce`, key). The same token (the person) or key (a run) is one message |
| link | what a message is to a run: `turn` (written by WFE: the run a request started), `new`, `follow-up`, `correction`, `steer`, `answer`, `question`, `informational`, `cites`, `handoff`. A later reading supersedes an earlier one; messages are never rewritten |
| attachment | a challenge a person's message carried, pinned to a revision (challenge p1, [challenges.md](challenges.md)) |
| response request | table `invitations` — below |
| facilitation | who started a conductor's leading, when, with which brief and from which horizon; when and why it ended |
| activity, annotation, metadata, overview, workflow reference | below |

**Mode** is a reading for clients: `direct` (one project, nobody leads),
`group` (several projects, nobody leads), `facilitated`.

## Routing a person's message

A person's message reaches the first of these that applies:

1. the participants it names (`to`): each is asked; naming the facilitator
   while the room is facilitated means the conductor;
2. the runs it names (`runs`): an instruction to work under way — the run
   gets the words verbatim with the message as their source and its
   attachments; a run that has ended fails visibly and nothing else starts;
   a run that is not work of this conversation is refused;
3. the open questions it replies to (`re` naming a question message whose
   run is open): that run gets the words as the answer to its question;
4. the conductor while the room is facilitated: its open run gets the words
   (as the answer to its question that `re` names or its only open one, else
   as an instruction); without an open conductor run a new one starts;
5. the default addressee;
6. otherwise nothing is recorded and the post is refused (409
   `choose-recipient`, with the project members) so the client can ask whom
   it is for.

For every project it reaches, a reply naming a question of that
participant's open run is that run's answer, not a new run. An unqualified
follow-up is a new request; the receiving agent decides what it means to
other work (it may `wfe run instruct|answer` it). Nothing here guesses a
related run.

A post reopens a closed conversation. A new id is created by its first
message, with the project `with` names: a one-to-one room whose default
addressee is that project. Naming `with` on an existing conversation that
does not have that member is refused (409 `other-destination`).

## Response requests

A response request (table `invitations`; called an invitation before p2) is
the only thing that starts or continues a run here. One is recorded per
recipient: for each person's message, each invitation the person or the
conductor issues (`wfe conversation invite`, `ask`), each awaited result.

| Field | |
| --- | --- |
| participant, workspace, workflow, role | whom, and the workflow selected for it, recorded once for the request's lifetime: `converse` (a project that is the only project and nobody leads), `discuss` (otherwise), `conduct` (the facilitator), `deliver` (to a run already working: an answer or an instruction), `await` (an awaited result). A project lacking the selected workflow uses its other one |
| question, source | the words (verbatim) and the messages it is about |
| by, by_run, awaited_by | who issued it (the person, the conductor's run — which then awaits it — or WFE for a continuation turn) |
| horizon | the newest message when it was dispatched; later messages are marked "after your request" |
| receipt | the run request's receipt: `conversation:<id>:request:<n>`; requests migrated from one-to-one turns keep `conversation:<id>:<message>`, earlier invitations `discussion:<id>:invitation:<n>`. A retried request or a restart finds the same run |
| delivery | `{question, message}` (answer the run that asked) or `{instruct: true, message}` |
| held | why its continuation waits for an explicit resume |

| State | Meaning |
| --- | --- |
| `pending` | recorded, run not requested yet |
| `started` | its run was requested (or it was delivered to its run) |
| `answered` | the run contributed a reply, result, synthesis or announcement (`late` when it was already `unanswered`/`withdrawn`/`failed`) |
| `unanswered` | the run completed or was cancelled without such a contribution |
| `failed` | it could not be requested or delivered (the reason is kept); reconcile retries it up to 3 tries in all, then only `retry` (CLI, `POST …/requests/<n>/retry`) at the same recipient; never sent elsewhere |
| `withdrawn` | not started, and withdrawn by hand or by closing |

Its run gets `input.source = {kind: conversation, conversation, message,
author, at, invitation: <request>}` and the words as its braindump, with the
attached challenges' revisions (`input.attachments`). Every transition is a
request event (archived).

| Situation | Behaviour |
| --- | --- |
| New message to a project | one request per recipient, one bounded run by receipt |
| Reply to an open run question | delivered to the asking run as its answer; no other run for that recipient |
| Message to an active conductor | its open run continues with the answer or instruction |
| Explicit instruction | delivered to the run named, with words, source message and attachments; an ended run fails |
| Agent contribution | speech with provenance; nobody is awakened |
| Late result | settles the awaited request; the continuation follows `awaited_by` (*Conductor continuation*) |
| Unavailable recipient | `failed`, shown, retried at that recipient |
| Repeated submission, restart | the same token is the same message and requests; the same receipt the same run |

## Facilitation

Starting facilitation is an explicit act: `wfe conversation start <id>
--text <brief>`, `POST …/facilitation {action: start, text, token}`, or a
conversation created as facilitated (`create … facilitate`, the conductor
creating one from its attempt). It records the facilitator, who started it,
the brief (the person's words to the conductor, a message of the
conversation) and the horizon (the newest message before the brief), and
the brief's request starts the conductor's run. The conversation keeps its
id, messages, members, open questions, runs, links and attachments; joining
a member, setting a default addressee or changing presentation starts
nothing.

Ending it (`wfe conversation end`, `POST …/facilitation {action: end}`)
changes future routing only: messages naming nobody go to the default
addressee, or must name someone. Nothing is stopped (stopping a run is the
run's own control); what the conductor asked of others stays its own, and
its outcomes still reach it while it is open. A continuation that would need
a new conductor turn is held.

## Conductor continuation

A request issued from the conductor's run is **awaited** by that run. The
conductor makes its node wait and ends its attempt, freeing the slot. When
everything it awaits is resolved (answered, unanswered, failed, withdrawn),
it is given **one instruction** listing each outcome (receipt
`discussion:<id>:continue:<run>:<outcomes>`), which continues the waiting
run ([runs.md](runs.md), *An instruction continues a run nobody executes*).
Each outcome is told once; a late answer is a new outcome. While the
conductor's attempt is open it is told nothing (it reads the results);
reconcile tells it once its attempt ended. A conductor run that has
**completed** meanwhile is replaced by a new conductor turn (by
`discussion`, receipt-bound, once) whose question lists the outcomes — while
the room is open and facilitated. A cancelled conductor run is told nothing.

**Held continuations.** When the outcomes come due while the conversation is
closed, or when a new conductor turn would be needed while nobody
facilitates, they are **held**: each request's `held` says why, the room's
status and obligations show them, and nothing is started. Reopening replays
nothing. `wfe conversation resume <id> [<request>]` (`POST …/resume`) runs
them once, in an open conversation.

## Closing and reopening

Closing withdraws requests not yet started (`pending`, `failed`); started
runs finish and their contributions are recorded; nothing is cancelled; no
conductor is continued (its continuation is held). Late results stay
readable. Reopening (or a person's post) continues the conversation; nothing
withdrawn, completed or held is replayed — ask again, or resume.

## Archive

WFE's store is authoritative for live speech. The archive is a reproducible
copy of **every** conversation, one-to-one included, in the archive
project's repository (`archive.workspace`'s origin, pj-ponderer):

```text
<path>/manifest.json     format ag.conversation.v1 (a superset of ag.argue.discussion.v1): identity, path,
                         origin, members and history, facilitations, default addressee, conductor,
                         requester, activities, category, displayTitle, overview, requests (`invitations`,
                         with role and receipt), horizon {message, link, membership, event, activity,
                         annotation, meta, overview, workflow, workflowEvent}, provenance (runs),
                         migration (what store v12 derived), workflows, exports[]
<path>/transcript.jsonl  append-only records: message | membership | invitation (a request's events; its
                         first carries what it is) | link | activity (activities, conductor, requester
                         and facilitation events) | annotation | meta | overview | workflow | workflow-link
<path>/workflows/<sha256>.yaml   each workflow version a record names, once
<path>/summary.md        interpretation by the archive project's runs (not this writer)
```

**The path** is recorded per conversation (`archives.path`) the first time
it is published and never moves: conversations that began as discussions
keep `discussions/<id>/` (their commits and `ponderer@<commit>:discussions/…`
citations stay valid), every other conversation is `conversations/<id>/`.
Gaining members or a conductor does not move it.

**One writer**: `ConversationArchive`, run by the coordinator's reconcile
every minute and by `wfe conversation archive`, in its own clone
(`<area>/.local/discussions/archive`) under a file lock. An export fetches
the published branch, reads the published manifest's horizon (**the
repository is the truth**), appends only records beyond it, rewrites the
manifest, commits (trailer `Conversation-Horizon: <id> m<n> l<n> …`) and
pushes; a rejected push is rebuilt on the new remote state. Interrupted
after the push and before its bookkeeping, the next export finds nothing new
and records the commit it observes. A failed push leaves the live
conversation untouched and the archive `failed` with the reason, retried
after 2^tries minutes (at most an hour); conversations go on meanwhile. A
conversation is due when its live horizon goes beyond the published one or
its open/closed state changed. Exporting never starts a run.

**Destination** (argue p4 ex1). Each publication record keeps the repository
its commit and horizon were verified in. A record of another destination
is `unverified`, never `current`, and due: the next export reads the new
destination's own manifest and appends only what lies beyond it. The
writer's clone of another origin is deleted and cloned again.

Status (`GET api/conversations/<id>/archive`, the view's `archive`, `wfe
conversation archive --status`): `current`, `behind`, `unverified`,
`failed`, `never` or `disabled`; the published commit, horizon, time,
destination and Gitea tree URL; the path; the live horizon.

**Restoring.** A fresh clone of the archive repository holds, for every
conversation, its transcript (verbatim messages with authors, ids,
`re`, runs and attachments' pinned revisions), membership and facilitation
history, request outcomes, links, overviews, metadata and workflow
versions. Challenge contents referenced by attachments live in their own
repository (`pj-challenges`, [challenges.md](challenges.md)), which a
restore needs beside it. Restoring the archive restores records only: it
never replays delivery or executes historical work (the live store, not the
archive, starts runs). pj-ponderer `tools/discussions` reads both formats.

## HTTP

| Route | |
| --- | --- |
| `GET api/conversations[?category=&state=&with=&mode=&limit=&offset=]` | `{person, disabled, participants, counts, total, offset, conversations}`; participants are each project (with `converse` and `discuss`) and the facilitator as their projects say now; each row with `mode`, `members`, `participants`, `defaultTo`, `facilitation`, `category`, `displayTitle`, `newest`, `last`, `overview` or `brief`, `status`, `activity`, `archive` |
| `POST api/conversations {id, title, members?, defaultTo?, facilitate?, category?, text?, token?, to?, re?, author?}` | creates (201; the same id by the same author is 200), and posts the first message when `text` is given |
| `GET api/conversations/<id>[?since=<msg>]` | `conversation` (`mode`, `defaultTo`, `facilitation`, `conductor`, `requester`, `category`, `displayTitle`, `origin`), `facilitations`, `overview`, `overviews`, `brief`, `status` (with `continuations` held), `meta`, `activities`, `annotations`, `obligations`, `members`, `membership`, `messages` (with `participant`, `run`, `runUrl`, `invitation`, `addressed`, `node`, `requests`, `attachments`), `requests` (role, workflow, state, run, receipt, held, …), `links`, `runs` (shared status, run view, file route, presentations), `asking`, `horizon`, `archive` |
| `POST api/conversations/<id>/messages {text, token, with?, title?, to?, runs?, re?, author?, via?, challenges?}` | the person's words; `{sent, duplicate, reopened, created, message, requests}`; 409 `choose-recipient` when it reaches nobody |
| `POST …/facilitation {action: start, text, token, re?, challenges?} \| {action: end, note?}` | start (with the brief) or end facilitation |
| `POST …/default {participant \| null, note?}` | the default addressee |
| `POST …/members {participant, action: join\|leave, note?}` | membership; starts nothing |
| `POST …/requests {participant, question, re?, token?}`, `…/requests/<n>/withdraw {reason}`, `…/requests/<n>/retry` | the person's request; withdraw one not started; try a failed one again |
| `POST …/resume {request?}` | run held continuations once |
| `POST …/close`, `…/reopen` | |
| `POST …/meta {category?, displayTitle?, ifUntitled?, note?}`, `GET`/`POST …/overview` (`displayTitle?`, `ifUntitled?`) | records about the conversation; `skipped` says why an `ifUntitled` title was not written |
| `GET …/workflows[/<n>[/current]]` | workflows beside the speech (reads only) |
| `GET …/dialogue?lang=`, `POST …/dialogue/retry` | character dialogue ([dialogue.md](dialogue.md)) |
| `GET`/`POST …/archive` | status / publish now (502 with the reason on failure) |

`api/discussions` is gone (challenge p2); a conversation that began as a
discussion keeps its id, so every citation `<id> #<n>` still identifies its
records here.

**Browser clients.** Writes are accepted from the service's own origin (on
the agdev origin `:8093`, anything under the same host and port, `/hangout/`
included) and from `allowedOrigins`. Another site cannot write. The page
holds no credential: its words are the configured person's, unless a client
names an automated trial `author`. Reads need no credential on the LAN. A
non-browser client (the Slack integration) sends no `Origin`, names `via`,
and validates its own users.

## Members and who speaks

Creating a conversation joins its creator and the projects named.
A participant asked for the first time joins, by whoever asked. A member who
left is not asked until it joins again; what it said stays. Only the person
and the conductor ask; a participant's run says in its contribution whom it
would ask (403 `not-facilitator` otherwise). An overview, a synthesis and an
announcement are the facilitator's project's (or the archive project's).

## Contributions and replies

`wfe conversation reply` (= `contribute`, from an executing attempt) writes a
message attributed to the participant the run speaks for, its run, its
attempt and its request, naming what it answers (`--re`, required). Kinds:
`reply`, `result` and `synthesis` answer the request; `progress` does not.
The same key (default: the text's hash) from the same run is one message.
The run reads the conversation with `wfe conversation show` (its own by
default): members and history, facilitation, every message, the requests,
questions waiting, held continuations and the archive. A reply is never
attributed by recency: concurrent work is told apart by run and `re`.

What a message is to a run is the receiving agent's reading: `wfe
conversation link <msg> --run … --as <relation> --note …`.

Acting on another run from an attempt (`wfe run instruct|answer … --from
<person> --source-message <conv>:<msg>`) records the agent as `by` and the
person's words with their origin.

## Conductor (argue p4)

`conversations.conductor` names the facilitator's run that owns the
conversation's progression. It is set when a conductor request starts a facilitator
run while no other conductor is open, or when the facilitator's attempt
creates the conversation (`wfe conversation create` from that attempt). A
conductor that completes leaves the conversation open: while it is
facilitated, the next message for the conductor, or a late outcome it
awaited, starts a new conductor run. The
conversation id stays independent of runs.

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
| `announce` | `wfe conversation announce --node <n> --text … --re …` | the message (kind `announce`, key `activity:<run>:<node>`); it waits for nobody and answers the conductor's own request | the command: the message first, then the node; reconcile completes a node whose message was delivered when the attempt ended first |
| `ask` | `wfe conversation ask <participant>… --node <n> --question … --re …`, or `--run <run>` to await a commissioned result | each request of the activity answered (#m), unanswered, failed or withdrawn | **WFE**, once no attempt is open: the node resumes and completes with the outcomes, then the run gets one instruction listing them (or, completed, a new conductor run) |
| `ponder` | `wfe conversation ponder --node <n> --decision … --source <msg>… [--next <activity>:<node>]… \| --definition <file>` | the decision, its sources, the next activities and the run revision | the command, with the revision in the same write (`run adjust --completing`) |
| `talk` | `wfe run ask <run> <n> --to <requester> --question …` (no conversation command since fix3); WFE posts it (*Questions*) and records the activity | the WFE question (to the requester) answered and taken up, or withdrawn | the agent, as any talk; reconcile records the activity's end |

- **Completed elsewhere** (fix3). `wfe run complete` (or `run adjust
  --completing`) on an announce, ask or ponder node, and a completion that
  would end a conductor run whose open conversation it never concluded, give a
  warning instead of a record: the risk and the activity's command. The
  same command with `--yes` records it. A warning, not a refusal:
  conduct/run-020 completed its last ponder node so and left its conversation
  open with nothing said. Since fix5 these are reminders of the shared
  evaluator (`discussion-activity`, `discussion-open`; runs.md *Reminders at
  operation boundaries*). `reply --kind result|synthesis` and `--completing`
  are evaluated the same way before the post.
- **Waits.** An ask waits `external: discussion:<id>:activity:<a>` (holder:
  the invited participants or the awaited run); a talk waits on its
  question; both free the slot.
- **Groups.** Requests of one ask are one group: its node completes when
  all are resolved. Requests a facilitator issued without an activity
  keep the per-run continuation above.
- **Settling.** `wfe conversation settle --node <n> --reason` completes an ask
  early, naming what is still open; their later outcomes are told as late
  outcomes of that ask. Unavailable participants fail at once.
- **Graph.** `--next` appends a chain of new nodes after the ponder node
  (`announce:agenda`, `ask:facts`, `ponder:after-facts`). Another round is
  new nodes; completed ones and their records stay; no cycle.
- **A turn that spoke and left its node running** (p3:
  rts-vs-bot/discuss/run-001, run-004): `wfe conversation contribute
  --completing <node>` speaks and completes in one command. Reconcile
  completes a node whose message was delivered (a message with `node`, or a
  participant's reply answering its request in a one-node discuss
  workflow) after the attempt ended without completing it, and lifts a hold
  whose only cause was that node left running (`run.resume` by
  `discussion`).
- **Conclusion.** `wfe conversation announce --conclude [--close]` records the
  **obligations** the conversation still has (open requests and awaited
  results, questions waiting for the person, runs of the conversation still
  working and their open delegations), each with its owner and who
  receives it later: the run awaiting it, a new conductor run, the
  delegating run, or "recorded only: the conversation is closed". Closing
  still cancels nothing.
- `wfe conversation state` is the compact read the conductor works from: the
  conductor and requester, its graph with each node's activity, open
  invitations, questions, obligations, annotations.

## Annotations (argue p4)

`wfe conversation annotate <id> --kind intervention|recovery|evaluation|
correction|note --text … --author <who> [--re <msg>…] [--run <run>]`
records something said about the conversation from outside its speech: an
Omni hint, a repair, an external evaluation, a correction of an earlier
claim (which stays as it was said). It starts nothing, is not a message,
and is archived and shown apart.


## Awaiting a result (argue p3)

Work commissioned in a conversation outlives the turn that commissioned it: a
participant's run entrusts work to its project's workflow (a delegate node),
answers, and goes on waiting for that child; a synthesize run reports later.
`wfe conversation await --run <workspace>/<workflow>/<run> --note <what>
[--re <msg>…]`, from the facilitator's run, makes that run await the
other run's result. It records a request with `awaits: result`, state
`started`, the awaited run as its run and the facilitator's run as
`awaitedBy` (token `await:<facilitator run>:<run>`: the same await again is
the same row, event `awaited`). Nothing is started or delivered.

| Event | Outcome |
| --- | --- |
| the awaited run contributes a `result` or `synthesis` here | `answered` by that message |
| a `reply`, `progress` or `question` of that run | nothing: an interim word does not answer it |
| the run ends (completed or cancelled, seen by reconcile) | `answered` by its last message here since the await, else `unanswered` |
| awaiting a run that has already ended | settled at once, by the same rule |
| the conversation is closed | refused; rows already awaited stay and continue nobody while closed |

Its outcome joins the facilitator's other awaited invitations: the
facilitator is told once all are resolved (*Facilitator continuation*).
A participant can keep its own request open instead by answering only
with the result (a `progress` note does not answer it); either way the
facilitator is continued when the result is there, or when the run that
owed it has ended without it.

## Questions (workflow_editor fix3)

A question is one thing everywhere: the run's WFE question (`wfe run ask`),
whoever asks it — a participant, the conductor on its talk node, or the
conductor relaying a delegated child's question from its delegate node.
**WFE posts every open question of a run that speaks for an open
conversation** (its requests' runs and its conductors) as a message of
kind `question`: the question's text, attributed to the asking agent and
the run's participant, with its question id and node, naming the message
the run was invited for (`re`), key `question:<run>:<q>`, so one message
per question. `wfe run ask` posts it at once; the executor's reconcile posts
what that could not (a failure after the record). A question on the
conductor's talk node is also the `talk` activity. A person's reply naming
the message is delivered to the run that asked as its answer (*Routing*).
`wfe conversation contribute --kind question` and `wfe conversation talk` are
refused: two ways to ask, one of which posted nothing, made
ponderer/conduct/run-020 relay gimmickimg's question with `wfe run ask`
alone, and the conversation said it awaited nobody while the run awaited the
person.

## Reading a conversation (argue p4 ex2)

What a reader needs to choose a conversation and understand it: what it is
for, what came of it and what it needs now. Episode:
`devdocs/episodes/argue/p4/ex2/`.

**Category.** Each conversation is a `conversation` (the default; `discussion` before challenge p2) or a `check`
(an operational check, a fixture or a trial of the system). Clients list
checks apart.

- It is set at creation with `--category check` or the create route's
  `category`. Automated fixtures and operational trials declare it.
- It is corrected later with `wfe conversation meta <id> --category …
  --note <why>`, or `POST api/<path>/meta`.
- A prefix such as "[Check]" in a title is not a classifier. A substantive
  conversation held as an experiment is a `conversation`.

**Display title.** This is a one-line title for readers, recorded
explicitly (`meta --title`, or `overview --title`). The original title and
the id stay and are shown in the room's details. No client derives a
display title from the original by string rules.

**Naming a room nobody has titled (challenge p4).** People do not name a
conversation before saying what they want. The client derives the original
title from the first nonempty line of the first message, and that title is
readable at once. The facilitator then gives a display title with its first
overview, using `--if-untitled` (API `ifUntitled: true` on `…/meta` and
`…/overview`; usage in `wfe conversation help`).

- The display title is written only if the conversation has no display
  title and no display-title record at all. A person's edit wins, and so does
  their reset to the original, which is a record whose value is none.
- The check and the write happen in one write transaction. An edit that
  lands first is kept. One that lands after is an ordinary later change.
- When the title is skipped, the answer names the record that won
  (`skipped`). The overview is still published.
- A repeated or later overview with `--if-untitled` renames nothing.
- Without the flag, a title replaces whatever was there, as before.
- No new store or schema is involved. The rule reads the existing
  `discussion_meta` history.

Every change of either is an append-only `discussion_meta` record: field,
value, who, run, when and why. A metadata write never touches messages,
invitations, runs, the open/closed state or `updated` (the list order).

**Overview.** An overview is a short interpretation for readers. It is
shared by the list and the top of the room, and it has three parts:

- the purpose: what the conversation is trying to establish;
- the outcome, which is optional: what it has concluded so far;
- the unresolved points.

Every part cites the messages it rests on as `[#n]`. WFE refuses a part
without a citation, and a citation that is not a message of the conversation
or is newer than the overview's coverage.

| Field | |
| --- | --- |
| `author`, `run` | who wrote it: from a run, the facilitator's or the archive project's (its agent and run); outside a run, whoever is named (the person, an outside agent) |
| `through` | the newest message it covers (default: the newest when written) |
| `sources` | every message it cites |
| `note`, `at` | why this revision, when |
| `after` (views only) | messages newer than `through`: readers see "covers through #n, N later" |

- An overview is not speech, not proof of agreement, and not the
  conversation's state. It starts nothing.
- A new overview is a new revision. The newest is current, and the earlier
  ones stay in the store and in the archive.
- Disagreement, uncertainty and open work belong in it.
- An overview may be written in the readers' language. It condenses what
  the cited messages say, and those messages stay one action away.
- Writing one is available work, never a step every conversation must pass.
  Reading a list or a room never runs a model.
- Without an overview, readers get the **brief** (the earliest of the
  person's messages and the conductor's announcements, first 400
  characters), labelled as the request, never as a conclusion.

**Status** (`status` in the list and the view) comes from WFE's records:

- `room` is `open` or `closed`. A closed room may still owe work.
- `working` counts open invitations, awaited results, runs of the
  conversation still working and their open delegations.
- `owed` counts every obligation, questions included (*Activities*,
  *Conclusion*).
- `awaiting` lists open questions, each with its receiver:
  - a `talk` question goes to the requester, either a person id or a run
    with its agent;
  - any other open question goes to whom the run asked it: a person
    (`to` is the configured person or a person member), else that agent,
    with the requesting run when it is the requester's (fix3).
  - `you` is true only when the receiver is the configured person.
- `failed` lists failed requests with WFE's reason.
- `held` lists runs of the conversation that are stopped, interrupted or
  unknown.

**Archive.** Transcript records `meta` (field, value, by, run, note) and
`overview` (all fields above but `after`). The horizon gains `meta` and
`overview`; manifests written before have neither, which counts as 0. The
manifest carries `category`, `displayTitle` and the current `overview`. A
metadata change or a new overview makes the conversation due.

## Character dialogue (argue p5)

A client may also show each agent message as one short line in its
speaker's character voice: `docs/dialogue.md`. Those lines are a
presentation kept beside the archive project's workspace, never in this
store. Nothing in this document reads or writes them, and a reply, a
citation or an overview always names the original message.

## Workflows in a conversation (argue p4 ex3)

Which workflow a turn referenced, created, edited or executed, at which
exact version, recorded as evidence beside the speech: a reader sees what
an agent consulted, made and changed without leaving the conversation.
Episode: `devdocs/episodes/argue/p4/ex3/`. Code:
`server/conversationWorkflows.ts`; CLI: `wfe conversation workflow`.

**A record** (`workflow_refs`) names:

| Field | |
| --- | --- |
| `relation` | `referenced` (declared material), `created`, `edited`, `executed` (a run started from the turn) |
| `role` | `progression`: the facilitator's own conductor graph (and the facilitator's project's work its run requests); otherwise `subject` (a reference may declare it) |
| `project`, `workflow`, `target` | `{kind: definition, file}` (a reusable definition) or `{kind: run, run}` (one execution of it) |
| `after`, `before` | the version: `kind` `draft` (working-tree bytes not equal to the committed file), `committed` (equal to the file at `commit`) or `revision` (a run's frozen `rN`, with its history `seq`); `sha256` of the bytes, `definitionDigest` (the semantic digest: layout and appearance excluded); `at`, when that version came to be (the adjustment; r1: the run's creation; a definition: when WFE read it) — the record's own `at` is when it was recorded, later for a derived or backfilled record. `before` for an edit |
| `nodes` | the nodes it singles out (a reference's `--node`; an edit's added and changed nodes) |
| `messages` | the explicit source messages; later associations are `workflow_ref_events` |
| `run`, `attempt`, `invitation`, `activity`, `actor`, `origin` | the turn: the actor run and attempt, its invitation, the conductor's ponder activity; `origin` the conversation run a delegated or requested child works for |
| `evidence`, `operation` | `operation` (written by the operation, or derived from the run's own history), `claim` (an authored reference), `backfill` (derived for history, said in the note); the source operation (`workflow.save`, `workflow.new`, `run.adjust:rN@seq`, `run.request:<receipt>`, `delegate.request:<d>@seq`, `attach`) |
| `state` | `recorded`; `unconfirmed` (an interrupted operation whose effect could not be verified, shown only as such); `pending` (a journal entry, never shown) |

**Every version a record names is captured** (`workflow_snapshots`, by
sha256): a saved definition is a draft the next save replaces, so its
bytes are the only proof of what was seen. Snapshots are kept with the
store and exported to the archive.

**What records what.** From an executing attempt whose run works for a
conversation — asked in it (`input.source`), conducting it, or entrusted by
such a run (a delegation or request, followed up to four levels):

| Operation | Record |
| --- | --- |
| `wfe workflow save` | `edited` definition, the replaced bytes `before`, the saved bytes `after` (an unchanged save records nothing) |
| `wfe workflow new` | `created` definition, a draft |
| `wfe run adjust`, `wfe conversation ponder --next/--definition` | `edited` run, `rN-1` → `rN`, from the run's history (token `adjust:<run>:<rN>`), with the ponder activity |
| `wfe request --request` | `executed`, the child's `r1` (token `request:<receipt>`) |
| `wfe delegate request` | `executed`, once the child exists, from the delegation record (token `delegation:<uid>`) |
| `wfe conversation workflow attach` | `referenced` (or the relation declared), evidence `claim` |

A record is written **after** the operation succeeded. A save, a creation
and a request are journaled first (`pending`, with the bytes a save will
write); the executor's reconcile resolves a journal entry older than a
minute from the operation's own evidence (the file holds the saved bytes;
a job carries the request's receipt) or marks it `unconfirmed`. Revisions
and delegated children are derived from the runs of open conversations on
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
| `GET api/<path>/workflows` | `{workflows, horizon}`: each record with `name`, `available`/`unavailable`, `changes` (an edit), `preview` (node boxes, edges and marks for a card), `runUrl`, `editorUrl` (the editor's current view) |
| `GET api/<path>/workflows/<n>` | the pinned graph: `after` and `before` (`version`, `workflow`, `effective`, or `unavailable` with the reason), `changes`, `state` (a run's node states replayed to the recorded `seq`, or `unavailable`: a definition has none), `time` |
| `GET api/<path>/workflows/<n>/current` | the target as it is now, labelled current: the working-tree definition, or the run's revision in force with its current states; `same` says whether it is still the recorded bytes |

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
`<path>/workflows/<sha256>.yaml`, which is what a fresh reader
resolves a version from after its source branch moved or its project
retired.

## Hand-off and reuse

An outcome is handed to an implementing project as an ordinary request
naming the pinned source (`ponderer@<commit>:<path>/summary.md`,
the messages); the run that handed it over records the resulting run with
`wfe conversation link <id> <msg> --run <ws>/<wf>/<run> --as handoff --note …`,
which the archive exports. Earlier conversations are read in the archive
project (`wfe projects read ponderer discussions/…`); reusable discussion
knowledge is ponderer's `wedo-argue`; what a conversation found about its
subject is the owning project's. Citations `argue@<commit>:…` written
before argue p4 ex1 name commits that are in pj-ponderer's history
(`HISTORY.md` there).
