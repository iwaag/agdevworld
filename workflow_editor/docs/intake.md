# Zulip intake contract (p6)

A workflow can be requested and conducted from Zulip. Zulip is the
conversation interface; the run record in devdocs remains the authority.
A request becomes a run whose `braindump.md` holds the person's own words;
later posts become recorded answers or additional instructions; execution
goes through the existing run operations (docs/runs.md).

The rules are pure functions in `shared/intake.ts`, tested by
`test/intake.test.ts`. The inbox and its application to runs are
`server/intake.ts`. The transport that fetches posts is autolab's
`agautolab.wfintake`.

## Places

| Zulip | Meaning | Input? |
| --- | --- | --- |
| channel `wf-<project>.<workflow>` | one workflow, identified by its **recorded stream id** (the notifier's channel target) | — |
| topic `request-…` | one request, one run | yes |
| topic `run-…` | the run's progress (written by the notifier) | never |
| any other topic | not part of the workflow interface | never |

A channel is a workflow channel only when all three hold:

1. the notifier recorded its stream id as `channel:<project>/<workflow>`;
2. the workflow declares `intake: {zulip: requests}`;
3. the host enables intake (`<area>/zulip.json`, `intake.enabled`) and names
   the requester identities (`intake.requesters`, Zulip user ids). All registered
   projects are eligible automatically. `intake.projects` is an optional map
   of workspace selections when a project has several workspaces; it is not
   a project allowlist. With one workspace, no per-project configuration is needed.

New workflows, whether empty or created from a template or placed as a basic
workflow, declare `intake: {zulip: requests}` by default. A workflow may explicitly
opt out with `intake: {zulip: ""}`. Older definitions without intake retain their
original meaning until updated; existing run snapshots are never rewritten.

Routing uses the realm (the configured Zulip URL's host and port) and the
stream id. Channel and topic **names never select a project, workflow or
run**.

## Topic identity, renames and moves

A request topic's identity is its **first message** (`topicFirst`, the
oldest message the topic held when the transport received the post). It is
recorded with the request when the request is accepted. Zulip keeps a
topic's messages together when it is renamed or resolved (`✔ `), so the
identity survives that; a new topic that reuses an old name begins with a
different message.

| A post whose topic… | Result |
| --- | --- |
| has a recorded request's `topicFirst`, same channel, same name | that request |
| has a recorded request's `topicFirst`, same channel, another name | that request; the new name is recorded (a relocation) |
| has a recorded request's `topicFirst`, another channel | routing problem (`moved-across-channels`): a request does not change workflow |
| has a recorded request's name but another `topicFirst` | routing problem (`topic-name-reused`): no guess from the name |
| is unknown and `request-…` in a workflow channel | a new request |
| is `run-…` or anything else | ignored |

A routing problem is recorded on the post, shown by `wfe intake status`, and
the request topic is told (when one is recorded). Nothing is applied.

## Classification

Each post is classified once; the classification and its binding are stored
with it and never derived again. So a post is not later reinterpreted as the
answer to a question asked after it.

| Order | Condition | Classification |
| --- | --- | --- |
| 1 | the sender is a bot (including this system's own posts) | `ignored: bot` |
| 2 | the sender is not a configured requester | `ignored: unauthorized` |
| 3 | the topic is a new request topic | `request` — the post becomes the **original braindump** |
| 4 | an earlier post of the same request is not settled, or its run is being created | `wait` (classified later, in id order) |
| 5 | the request could not become a run | `closed: refused` |
| 6 | the run is cancelled / its execution completed | `closed` — a new request needs a new request topic |
| 7 | the post names questions (quote-and-reply or link to the post that carried a question; or `q<n>:` at the start of its own words) | one named question, open, posted before this post → `answer (reference/explicit)`; closed → `late`; not yet posted when written → `clarify: not-yet-asked`; unknown → `clarify: unknown-question`; several → `clarify: ambiguous` |
| 8 | exactly one question is open and was posted before this post | `answer (pending)` |
| 9 | several such questions | `clarify: ambiguous` |
| 10 | otherwise | `instruction` — additional instruction to the run |

- **Original braindump.** The first eligible post's exact text, its sender's
  name and Zulip id, message id, time and place are recorded (run.json
  `input.source`). No agent summary replaces it. Corrections arrive as new
  posts. Edits of a post after it was received are not read in p6.
- **"Open"** means asked and not taken up or withdrawn (`open` or
  `answered`): a further reply before the agent takes it up is a further
  answer to the same question.
- **"Posted before"** compares Zulip message ids: the request-topic message
  that carried the question must be older than the reply. A question not yet
  delivered cannot be answered from Zulip.
- `late` and `clarify` replies are recorded and explained in the request
  topic; they are applied nowhere. A late reply never moves to a newer
  question.
- Ambiguous approval of a plan or a result is the agent's to resolve with a
  follow-up question (docs/runs.md *Plan agreement*, *Result confirmation*);
  the intake never decides what a text means beyond these rules.
- After completion a post is kept and answered with "this request is
  complete; open a new `request-…` topic". It neither creates a run nor
  reopens the old one.

## Receipt, application, take-up

Three separate facts, each with its own evidence:

| Fact | Evidence | Who |
| --- | --- | --- |
| **Receipt** — the post is held by this host | an inbox row keyed by (realm, message id), written in the same transaction that moves the channel cursor past it | intake |
| **Application** — the run has the input | a run history entry carrying the post's receipt `zulip:<realm>:<message id>` (`run.create`, `question.answer`, `instruction.receive`) | intake, through run operations |
| **Take-up** — the agent read it | `question.take-up` (an answer) or `instruction.ack` (an instruction, with the intended response) by the executing attempt | the agent |

A receipt is not the agent having read anything; an application is not
either. Views and messages say which of the three has happened.

### Inbox stages

```text
received ──▶ classified ──▶ applied ──▶ done
    │             │  └──────────────────▲   (nothing to apply: ignored, late, closed, clarify)
    └──▶ failed ◀─┴──────────┘
          │ (retry resumes at the stage that failed)
```

| Stage | Durable evidence |
| --- | --- |
| `received` | the raw post (text, sender, ids, times, `topicFirst`) |
| `classified` | the classification, the request binding and, for an answer, the question id |
| `applied` | the run reference and the history sequence of the entry with the post's receipt |
| `done` | the resumption queued (by receipt) and the reply to the person queued |
| `failed` | the stage, the error, the attempt count; `wfe intake retry` or the next pass resumes it |

**Crashes.** Every step after receipt is repeatable:

- The run operation is idempotent by the post's receipt. If the process dies
  after the run changed and before the inbox says `applied`, the retry finds
  the receipt in the run's history and records `applied` without a second
  entry. For a request, the run is found by its `run.create` receipt among
  the workflow's runs before anything is created.
- Queueing is idempotent by receipt (the existing execution queue).
- The cursor moves only with the receipt; a post fetched and not stored is
  fetched again.

Posts of one request are settled in message-id order: a later post waits
while an earlier one is not `done`, so an answer cannot overtake the request
that created its run.

## Additional instructions (run history)

`instruction.receive` (by the intake, `via: zulip`, with the source) adds an
instruction `i<n>` to the run. It never changes a node's state and never
interrupts a running process. `instruction.ack` (by the executing attempt)
records that the agent took it up and what it will do: `incorporate` (into
upcoming work), `clarify` (it asks the person), or `new-run` (it explains why
the request needs a new run). The node-boundary rules are in docs/runs.md
*Additional instructions*.

## Replies in the request topic

| Kind | When |
| --- | --- |
| acknowledgment | the request became a run (with the run topic), an answer or instruction was recorded (received, not yet read) |
| question | a question to the person: its id and the expected action ("reply in this topic") |
| clarify | which question a reply is for is ambiguous or unknown |
| late | the question was already closed; the reply is kept, not applied |
| closed / refused | the request is over (or never became a run): open a new request topic |
| problem | a routing problem the person can repair (topic moved or name reused) |
| result | the presented result, the confirmation asked for, and the decision |

Posts in `run-…` topics are never answered.
