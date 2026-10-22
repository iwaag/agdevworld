# Conversations (project_migration p8, workflow_editor p15)

A conversation is a person's continuing talk with **one project's
conversational workflow**, its destination (`<workspace>/<workflow>`, e.g.
`front/converse`, `forge/converse`). The destination is recorded when the
conversation is created and never changes. A conversation is kept apart from
any one run: it refers to many bounded runs and never holds their state.
Code: `server/conversations.ts`; CLI: `wfe conversation`; store:
`<area>/.local/conversations/conversations.sqlite`.

Any client can hold conversations through the HTTP contract below. Clients
include aghangout (the managed project `aghangout`), the Slack integration and
the CLI. The service owns identity, destination, messages, dispatch and
recovery. A client owns presentation, such as which character or picture
stands for a destination.

## Configuration

`<area>/conversations.json`:

```json
{
  "person": "iwaag",
  "targets": [
    { "workspace": "front", "workflow": "converse" },
    { "workspace": "forge", "workflow": "converse" }
  ]
}
```

- `targets` are the destinations a **new** conversation may name.
- An existing conversation keeps dispatching to its recorded destination
  after the list changes.
- `person` is who a page's words are recorded as.

Without the file, no conversation can be created over HTTP (503 with the
reason). Existing messages are kept.

## Records

- **Conversation**:
  - an id, minted by the client (`[a-z0-9][a-z0-9-]{0,47}`; aghangout uses
    `YYYYMMDD-HHMMSS-<random>`; the first message creates it);
  - a title (the first line);
  - `open` or `closed`. Closing ends the conversation, not its runs. A
    message reopens it.
  - its **destination** `<workspace>/<workflow>`, named by the first
    message's `target`. That target must be one of the configured targets.
    A message naming another target is refused (409, `other-destination`):
    choosing another partner is another conversation.
  - Nothing defaults to any project. A first message without a target is
    refused (400, `no-destination`).
  - Conversations from before p15 were mapped once, by the store's version-3
    migration, to the single `entrance` the file named then.
- **Message of the person**:
  - their words verbatim, the author (the configured person: the page is
    theirs, as every editor write is) and the time;
  - the submit token: the same token twice is one message;
  - `via`: the way the words came when not a page (`slack`, `slack-trial`;
    slack_connect p1). Clients show it beside the author;
  - `re`: the messages it answers, when the person names them.
  - `attachments` (challenge p1, store v11): challenges it carries, each
    pinned to the revision it was sent with (`challenges` on the post:
    `["ch-0001", "ch-0002@<commit>"]`). See [challenges.md](challenges.md),
    *Carrying a challenge into work*.
- **Reply of the destination's agent**:
  - the text and the author (the run's agent);
  - the run and attempt that wrote it, `re` (what it answers) and its kind:
    - `reply`;
    - `question`, optionally naming the run's WFE question;
    - `progress`;
    - `result`.
  - A key (default: the text's hash) makes a retried command one message per
    run.
- **Link**: what a message is to a run.
  - `turn` is written by the store: the run started for the message.
  - The destination's agent records its reading:
    - `new` (the message began that work);
    - `follow-up`;
    - `correction`;
    - `steer` (it changes active work);
    - `answer` (it answers that run's question);
    - `question`;
    - `informational` (answered from evidence);
    - `cites`.
  - Each link has a note. A later link for the same message and run
    supersedes the earlier one; both stay. Messages are never rewritten.

## A turn

Every message of the person starts **one run of the conversation's
destination workflow**:
- the words are the run's braindump;
- the author is the person;
- `input.source = {kind: conversation, conversation, message, author, at}`;
- the request receipt is `conversation:<conversation>:<message>`;
- each attached challenge's file at its attached commit is in the run
  folder (`attachments/<id>@<commit12>.md`, `input.attachments`).

The message is stored before the request. A failed request, or a crash
between the request and its record, is repaired by requesting again: the
receipt finds the same run. Nothing is started twice. A destination that
cannot take the request (an unregistered workspace, a missing workflow) leaves
the message `dispatch: failed` with the reason. It is shown, and retried at
the same destination by `wfe conversation dispatch` or the executor's
reconcile. It is never sent anywhere else.

The store routes and persists. It does not interpret. The run reads the
conversation (`wfe conversation show`, which defaults to its own conversation)
and its linked runs (`wfe projects run`, `wfe run state`), then decides. It
may:
- answer and complete;
- do the work, growing its own graph (`wfe run adjust`, delegate nodes),
  and reply when it has examined the result;
- steer active work (`wfe run instruct <run> --from <person>
  --source-message <conv>:<id>`). An instruction continues a run nobody
  executes (runs.md);
- answer another run's question with the person's words (`wfe run answer
  … --from <person> --source-message …`);
- ask (`reply --kind question`), leaving the message bound to no work until
  the answer.

Acting on another run from its attempt records the destination's agent as
`by` and its attempt as `operator` (runs.md, *Who records*). A reply's
author is the run's agent (`front-agent`, `forge-agent`, …). A client may
show a character for the destination, but the author stays the agent that
wrote it.

## Attribution

A reply names its run and the messages it answers. Concurrent work is told
apart by run and `re`, never by which message is newest. A question is
pending until a later message of the person names it, or follows it while it
is the only one pending.

## HTTP

| Route | |
| --- | --- |
| `GET api/conversations[?target=<ws>/<wf>]` | `{person, disabled, targets, conversations}`. Conversations are newest first, each with its `destination` and last message. `targets` are the configured ones as their projects say now: `target`, `workspace`, `workflow`, `project`, `projectName`, `workflowName`, `intent`, `agent`, `state` (`available` / `unavailable`) and `problem`. |
| `GET api/conversations/<id>[?since=<id>]` | See *The view* below. 404 for an id not created yet. |
| `POST api/conversations/<id>/messages {text, token, target?, re?, via?, author?, challenges?}` | The person's message, then its turn. `challenges` are attached at their current revision unless one names `@<commit>`; an unknown or unpublished one refuses the message. `target` (`<ws>/<wf>`) is required for a new id. On an existing id it must match the destination (409 otherwise). Answers `{sent, duplicate, reopened, message, run, destination}`. The author is the configured person, unless `author` names another (an automated trial actor). A client other than a page names `via`. |
| `POST api/conversations/<id>/close` | Closes the conversation. Runs continue. |

**The view** is:

- `conversation`, with its `destination`;
- `messages`;
- `links`;
- `asking` (the pending questions);
- `runs`: each linked run and each message's own turn run (relation
  `turn`), as their records say now. Each run carries:
  - `situation`, `execution`, `waiting`;
  - `status`, the shared short reading ([runs.md](runs.md), *Status in
    short*);
  - `title`;
  - `url`, the run view;
  - `files`, the run's file route: append a run-folder path to open a
    delivered file;
  - `presentations`, the review pages that serve now on a LAN address.

Run view and file URLs are absolute (zulip.json `viewBase`, else
present.json `answerBase`).

**Browser clients.**

- Writes are accepted from the service's own origin. On the agdev origin
  (`:8093`), anything under the same host and port qualifies: `/wfe/` and
  pages such as `/hangout/`.
- Writes are also accepted from origins listed in the service's
  `allowedOrigins` (`--allow-origin`), for a client hosted elsewhere.
- Another site cannot write. The page holds no credential: its words are
  the configured person's.
- Reads (conversations, run views, run files) need no credential on the
  LAN.

A non-browser client (the Slack integration, `integrations/slack`) sends no
`Origin`. The write-origin check is for pages. The integration validates its
own users: only the configured Slack member's words are posted as the person.
It names its destination (`target`) for each new conversation.

## Discussions

A discussion (several participants, a facilitator, invitations) is the
store's second kind, with its own routes: [discussions.md](discussions.md).
The conversation routes refuse a discussion id (409 `is-discussion`).
Relation `handoff` (p16) records work an outcome was handed to.

## Not here

- Zulip is not on the person's path. Conversational runs still have their
  ordinary run and IO topics as evidence.
- `wfe conversation` works where the store is (the coordinator).
  Conversational workflows run on the coordinator's own worker
  (`execution.node`), usually in its `conversation` lane (`execution.lane`;
  workers.md).
