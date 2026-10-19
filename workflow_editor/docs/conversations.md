# Conversations (project_migration p8)

A conversation is the person's continuing talk with the system's entrance
(Front, an ordinary managed project). It is kept apart from any one run. A
conversation refers to many bounded runs; it never holds their state. Code:
`server/conversations.ts`; CLI: `wfe conversation`; store:
`<area>/.local/conversations/conversations.sqlite`.

## Configuration

`<area>/conversations.json`:

```json
{ "entrance": { "workspace": "front", "workflow": "converse" }, "person": "iwaag" }
```

Without the file, messages are kept but no turn starts (`dispatch_state:
failed`, with the reason), and they start once it exists (`wfe conversation
dispatch`, or the executor's reconcile).

## Records

- **Conversation**: an id (the Front Desk mints `YYYYMMDD-HHMMSS`; the first
  message creates it), a title (the first line), `open` or `closed`. Closing
  ends the conversation, not its runs. A message reopens it.
- **Message of the person**:
  - their words verbatim, the author (the configured person: the page is
    theirs, as every editor write is) and the time;
  - the submit token: the same token twice is one message;
  - `via`: the way the words came when not the Front Desk (`slack`,
    `slack-trial`; slack_connect p1). The Front Desk shows it beside the
    author;
  - `re`: the messages it answers, when the person names them.
- **Reply of the entrance**:
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
  - The entrance's agent records its reading:
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

Every message of the person starts **one run of the entrance workflow**:
- the words are the run's braindump;
- the author is the person;
- `input.source = {kind: conversation, conversation, message, author, at}`;
- the request receipt is `conversation:<conversation>:<message>`.

The message is stored before the request. A failed request, or a crash
between the request and its record, is repaired by requesting again: the
receipt finds the same run. Nothing is started twice.

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

Acting on another run from its attempt records the entrance's agent as `by`
and its attempt as `operator` (runs.md, *Who records*).

## Attribution

A reply names its run and the messages it answers. Concurrent work is told
apart by run and `re`, never by which message is newest. A question is
pending until a later message of the person names it, or follows it while it
is the only one pending.

## HTTP

| Route | |
| --- | --- |
| `GET api/conversations` | the conversations, newest first, with the last message |
| `GET api/conversations/<id>[?since=<id>]` | messages, links, the linked runs as their records say now (situation, execution, waits, run view URL), pending questions; 404 for an id not created yet |
| `POST api/conversations/<id>/messages {text, token, re?, via?, author?}` | the person's message, then its turn. Answers `{sent, duplicate, reopened, message, run}`. The author is the configured person unless `author` names another (an automated trial actor); a client other than the page names `via` |
| `POST api/conversations/<id>/close` | closes the conversation (runs continue) |

Run view URLs are absolute (zulip.json `viewBase`, else present.json
`answerBase`).

A non-browser client (the Slack integration, `integrations/slack`) sends no
`Origin`; the write-origin check is for pages. It validates its own users:
only the configured Slack member's words are posted as the person.

## Not here

- Zulip is not on the person's path. The entrance's runs still have their
  ordinary run and IO topics as evidence.
- `wfe conversation` works where the store is (the coordinator). The
  entrance workflow runs on the coordinator's own worker.
