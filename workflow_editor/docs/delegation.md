# Delegation contract (`workflow_editor` p10)

A **delegation** is one run (the *parent*) entrusting work to a run of
another managed workflow (the *child*), usually in another project: the
parent's agent writes the request, the child is created through the child
workflow's ordinary Zulip intake, the parent's agent answers the child's
questions and receives its result, and the parent continues with it.

Nothing about the child is special. It is an ordinary run of its workflow:
the same creation, input files, attempts, sessions, questions, isolated
copy, publication, acceptance and integration as a run a person requested
([runs.md](runs.md), [intake.md](intake.md), [storage.md](storage.md),
[integration.md](integration.md)). Delegation adds a durable relationship
between two runs and the delivery of a few kinds of fact between them.

| Who | Owns |
| --- | --- |
| The parent's agent | what to request, whether to answer a question itself or ask its person first, how to answer, whether the result serves the request (its disposition), whether to replace a failed child |
| The child's agent | how to do the work, what to ask, how to read an answer, when to present and how to record the decision a confirmation is |
| The system (WFE, its intake, its notifier) | identities, dispatch intent, delivery and its journal, binding the child to the intent, relaying the child's events to the parent, queueing the parent's continuation, refusing what a record does not allow |
| The person (the parent's requester) | the parent's own result, and whatever the parent's agent chooses to ask them |

## Definition

```yaml
nodes:
  asset:
    type: delegate
    name: Get the asset
    description: What the child is asked for, and what this run needs back.
    project: forge        # target project id; absent = this run's project
    workflow: provide     # target workflow id (required)
    accepts: person       # who may accept the child's result: person (default) | parent
```

- `project` and `workflow` are a **portable target**: identities, never a
  workspace, a path, a channel or a topic.
- `accepts` records whom the workflow's author entrusted with the child's
  *result decision*: `person` (the parent's person) or `parent` (the
  parent's agent). Since p11 it is a record, not a gate: the parent's agent
  answers every question of the child, the result confirmation included,
  and the child records the decision its answer represents. Where a
  workflow means the parent to judge, `accepts: parent` says so.
- A delegate node binds no repository of its own work (it may name bindings
  for the files it reads back); its outcome is the delegation's result.

Validation ([contract.md](contract.md)):

| Code | Severity | Meaning |
| --- | --- | --- |
| `delegate-target-missing` | error | no `workflow` |
| `delegate-self` | error | the target is this workflow of this project |
| `delegate-target-unknown` | error | the target workflow is not known: in this project, or (with a registry) in the registered workspace of `project` |
| `delegate-project-unknown` | error | `project` is not a valid id, or (with a registry) no workspace of it is registered |
| `delegate-recursive` | error | following delegate targets across the registry's projects reaches this workflow again |
| `delegate-accepts` | error | `accepts` is not `person` or `parent` |
| `delegate-no-intake` | warning | the target workflow opts out of requests (`intake: {zulip: ""}`); a dispatch to it is refused |
| `workflow-on-non-delegate` | warning | `workflow`, `project` or `accepts` on a node that is not a delegate |

Delegate nodes compile into the effective graph like any node; `project`
and `accepts` are part of the definition digest and the compiled node.

## Identity

| Identity | Form | Notes |
| --- | --- | --- |
| Parent run | `<project>/<workflow>/<run>#<creation>` | the observation contract's creation-qualified uid ([observation.md](observation.md)) |
| Delegation | `d1`, `d2`, … per parent run; uid `<parent uid>/<d>` | stable for the delegation's life; every retry of its delivery keeps it |
| Child run | its own creation-qualified uid | recorded on the parent when bound |
| Transport | the Zulip post that carried the request (realm, message id, channel id, topic) and the post of each answer or instruction | references, never identities: names follow renames |

**One child per delegation, one open delegation per node.** A delegate node
instance dispatches once. A replacement after a failure is explicit new
work: the old delegation is closed (`abandoned` or `rejected`) by the
parent's agent first, and the new one has a new id and names its
`predecessor`. Nothing creates a substitute child by itself.

## Records

**Parent `run.json`** (`delegations.<d>`, present once the first dispatch
is recorded):

| Field | Content |
| --- | --- |
| `id`, `uid`, `node` | the delegation's identity and the delegate node it serves |
| `target` | `{project, workflow, workspace}` — the workspace resolved at dispatch |
| `request` | `{path, sha256, bytes}` of `delegations/<d>/request.md` in the run folder: the parent agent's constructed request, exactly as delivered |
| `original` | `{path, sha256, bytes}` of `delegations/<d>/original-input.md`: the human input the request was derived from (the parent's `braindump.md`, or the parent's own original), kept separately |
| `requester`, `onBehalfOf` | the parent's agent, and the person the parent run serves |
| `accepts` | the node's `accepts`, frozen at dispatch |
| `dispatched` | `{at, by, attempt, seq}` |
| `predecessor` | the delegation it replaces, or absent |
| `child` | `{uid, workspace, project, workflow, run, created}` once bound, else null |
| `transport` | `{realm, message, stream, topic}` of the request post once bound |
| `events` | facts relayed from the child, numbered `1, 2, …` (below), each with `wakes`, and `takenUp` once the parent's agent read it |
| `answers`, `instructions` | what the parent's agent sent, in order, with `from` (whose words), `because` (the parent record they rest on) and the question they answer |
| `revisions` | (fix6, present once used) results returned to the same child for correction: `{n, event, manifest, childSeq, instruction, reason, from, by, at, attempt, seq, because?}` |
| `disposition` | `{kind: satisfied \| rejected \| abandoned, note, event, manifest, at, by}` or null |
| `closed` | `{reason, at, by}` when the parent run was cancelled with the delegation open, or the disposition closed it |

**Child `run.json`** is an ordinary request run:

- `input.kind: request`, `request.md` = the parent's `request.md` byte for
  byte (checked against the dispatched hash), `original-input.md` = the
  original, `requester` = the parent's agent, `onBehalfOf` = the parent's
  person.
- `input.entrustedBy: {kind: delegation, delegation: <delegation uid>,
  parent: {project, workflow, run, creation, node}, accepts}`.
- `input.source` = the request post. An answer the parent's agent sent
  records `from` (the parent's agent, or the person whose words it relays),
  `by` = the parent's agent, `source` = the answer post and `delegation` =
  `{uid, answer: <n>}`.

The parent's record is authoritative for the relationship, the child's for
the work. Host stores only journal their transport: the notifier's
deliveries (`notify.sqlite`), the intake's posts (`intake.sqlite`) and a
rebuildable index of open delegations (`<area>/.local/delegate/delegate.sqlite`).

## Dispatch resolution

At `wfe delegate request`, before anything is written:

1. **Target workspace.** The registry's one workspace of `project`, or the
   one `zulip.json` `intake.projects.<project>.workspace` names; several
   without a selection, none, or one outside the operating boundary refuse
   the dispatch (`delegate-target`), naming the candidates. Never a guess.
2. **Target workflow.** It exists in that workspace now, validates without
   errors, and accepts requests (the default; `intake: {zulip: ""}` opts
   out, [intake.md](intake.md)), and its workflow channel is provisioned. The child's own definition is frozen later by its
   ordinary run creation; the dispatch records the digest it saw.
3. **Cycles.** Refused (`delegate-cycle`) when the target, as currently
   defined, reaches the parent's workflow through delegate nodes across the
   registry, or when the target is the workflow of the parent or of any
   ancestor of the parent (the chain of `entrustedBy: delegation` records,
   read from the ancestors' own records, so a definition changed since an
   ancestor was created is still caught).
4. **Node.** The delegate node is running (started by the attempt), has no
   open delegation, and the attempt is the open one.

## Facts kept apart

| Fact | Evidence | Recorded by |
| --- | --- | --- |
| Dispatch intent | `delegation.dispatch` in the parent, with the request file by hash | the parent's agent (its attempt) |
| Delivery | a notifier delivery of the request post, journaled `ready → sending → sent` with its message id | notifier and transport |
| Child creation and binding | the child's `run.create` carrying the request post's receipt, and `delegation.bind` in the parent naming the child uid | intake |
| Child execution | the child's own record | the child's agent and its host |
| Result availability | a `completed` event relayed to the parent, with a result manifest | relay |
| Parent receipt | `delegation.take-up` of that event | the parent's agent |
| Parent disposition | `delegation.dispose` (`satisfied`, `rejected`, `abandoned`), bound to the event and manifest digest it judged | the parent's agent |
| Child acceptance | the child's `run.decide` (usually from its result confirmation) | the child's agent, from the answer it took up |
| Child integration | the child's `run.integrate` | the child's host, by its own rules |
| Parent completion | `node.complete` of the delegate node; later the parent's own decision | the parent's agent; the parent's person |

None implies another. A delivered request is not a created child; a child's
completion is not the parent's receipt; the parent's receipt is not a
disposition; a `satisfied` disposition is not an acceptance in the child and
never queues the child's integration; accepting the child's result is not
accepting the parent's result.

## Decision ownership

| Decision | Who decides | Evidence the record requires |
| --- | --- | --- |
| What to request | the parent's agent | the request file by hash; the original input beside it |
| Answer a child's question (the plan agreement of a `_plan` step included) | the parent's agent | the answer text; `from` = the agent |
| Answer within scope after asking its own person first | the parent's agent | `because: answer <q>` of the parent's own taken-up answer; `from` = that person |
| Answer the child's **result confirmation** | the parent's agent (with `accepts: person`, usually after asking its person; `because: answer <q>` relays their words) | the confirmation question it answers (subject hashes are the child's to check) |
| Whether the child's answer is agreement or acceptance | the child's agent (its reading, as for any request) | the child's existing rules: plan agreement binds plan.md's hash, a decision binds the presented subject |
| Whether the result serves the request | the parent's agent | `delegation.dispose` naming the result event and its manifest digest |
| Replace a failed child | the parent's agent | the old delegation closed first; the new one names its predecessor |
| Cancel the child | whoever cancels it, explicitly | the child's own `run.cancel`; never implied by the parent's stop or cancellation |
| Accept the parent's result | the parent's person | the parent's own decision |

Before p11 the child refused a decision from its requester agent when
`entrustedBy.accepts` was `person` (`delegate-scope`); that gate is gone
and the field remains in the record.

## Transitions

States of a delegation on the parent, derived from its record:

| State | When |
| --- | --- |
| `dispatching` | dispatch recorded, no child bound |
| `working` | bound; no event waits for the parent |
| `attention` | an event that wakes the parent is not taken up |
| `result` | the child completed and the result event is taken up, no disposition yet |
| `correcting` | (fix6) the latest result was returned for correction and no newer result came back (a correction the child refused does not count) |
| `stopped` | the child's execution stopped (a failure or cancellation) and the parent has not closed the delegation |
| `satisfied`, `rejected`, `abandoned` | the disposition (closed) |
| `orphaned` | the parent run was cancelled while it was open (closed; the child keeps running unless cancelled explicitly) |

The delegate node waits (`wait.on: {delegation: <d>}`, holder = the target)
from the dispatch, resumes `running` when its agent takes up an event, and
waits again after an answer or instruction is sent.

| # | Situation | Child | Parent record | Parent node | Who acts next |
| --- | --- | --- | --- | --- | --- |
| 1 | Dispatch | — | `delegation.dispatch`; state `dispatching` | waiting on the delegation | system (delivery) |
| 2 | Request posted, intake creates the child | `run.create` (request, `entrustedBy: delegation`), start queued | `delegation.bind` with child uid and post; state `working` | waiting | the child's agent |
| 3 | Child asks (the forge `_plan` agreement, or any question) | `question.ask`; the notifier posts it in the request topic | `delegation.event question` (wakes): id, text, `to`, plan document or presented subject by hash; continuation queued | waiting → `running` on take-up | the parent's agent |
| 4 | Parent answers | after the answer post is bound: `question.answer` (from, by, source, delegation); resumption queued | `delegation.answer`; delivered by the notifier | `waiting` | the child's agent |
| 5 | Answer arrives after the child closed the question | nothing applied; the request topic is told (late) | `delegation.event answer-refused` (wakes) | `running` on take-up | the parent's agent |
| 6 | Child presents its result for confirmation (forge `confirm`, `confirms: result`) | `question.ask` with subject and presentation | as 3, with `confirms` and the subject hashes | as 3 | the parent's agent, or its person when `accepts: person` |
| 7 | Parent accepts (answer to 6) | the child's agent takes it up and records `run.decide accepted` from the confirmation; its integration is queued by the child's own rules | as 4; `delegation.event decided` (no wake) | `waiting` | the child's agent |
| 8 | Parent rejects or asks for changes (answer to 6) | the child's agent records `rejected` or adds a round, then asks again | as 4 | `waiting` | the child's agent |
| 9 | Child completes | execution `completed` | `delegation.event completed` (wakes) with the result manifest; state `attention` → `result` on take-up | `running` on take-up | the parent's agent |
| 10 | Parent reviews | — | `delegation.dispose satisfied` (event + manifest digest); closed | `node.complete` allowed | the parent's agent |
| 11 | Result does not serve the request | — | `delegation.dispose rejected`; a replacement may be dispatched (new id, predecessor) | `running`; replace, fail or cancel the node | the parent's agent |
| 11a | Result left something out (fix6) | after the post is bound: `correction.receive`; execution `in-progress`; continuation queued | `delegation.revise` (event + manifest digest); state `correcting`; `delegation.event correcting` (no wake) once the child recorded it | `waiting` | the child's agent: adds the work, completes again → row 9 with a new result |
| 12 | Child fails (a node failed, execution stopped) | as recorded | `delegation.event failed` (wakes); state `stopped` | `running` on take-up | the parent's agent: wait for the child's person or Observer, `abandon` and replace, or fail the node |
| 13 | Child held (stopped by a person, interrupted, unknown) | as recorded; Observer handles interruptions | `delegation.event held` (no wake), `resumed` later | `waiting` | the child's holder |
| 14 | Child cancelled | `run.cancel` | `delegation.event cancelled` (wakes); state `stopped` | `running` on take-up | the parent's agent |
| 15 | Parent held (stop, interruption) | unaffected | events still recorded; no continuation queued | as it was | whoever resumes the parent |
| 16 | Parent cancelled | unaffected; cancelling it is a separate explicit act | the open delegation closed `orphaned`; later events are not recorded (the child stays inspectable) | `cancelled` | nobody; or a person cancels the child |
| 17 | Delivery fails or stays uncertain | — (no post, no child) | `dispatching`; the notifier's delivery shows the failure or uncertainty | waiting | the transport retries; a person resolves an uncertain delivery |

Events that wake the parent: `question`, `answer-refused`, `completed`,
`failed`, `cancelled`. Recorded without waking it: `held`, `resumed`,
`decided`, `integrated`, `withdrawn` (the child withdrew a question),
`correcting` (the child recorded a correction, fix6). A correction the child
refused comes back as `answer-refused` with `revision: <n>`. A
parent attempt that ends with a waking event recorded before it began and
not taken up is `interrupted`, like an exit with work left ready.

## Delivery and recovery

- **Dispatch before sending.** The dispatch is recorded in the parent first;
  the request post is an outbox event derived from that record, delivered
  by the notifier's frozen deliveries in the delegation's own conversation
  (one delivery in progress, in record order, each post alone).
- **Binding by message id.** A post becomes the child's input only when it
  is the message a sent delivery of a delegation event recorded — never
  because of its text, a marker or a parent id in it. A post by the sender
  whose delivery is still `sending` or uncertain waits; any other bot post
  is ignored as before.
- **Crash points.** After the post and before its acknowledgment: the
  delivery is uncertain and is found by its marker before anything is
  posted again. After the child's creation and before the bind: the intake's
  application repeats (the child is found by its receipt) and the bind is
  recorded under the receipt `delegation-bind:<uid>`. After the parent
  recorded an event and before the continuation was queued: reconcile
  queues it from the record. Every relay entry carries the receipt
  `delegation:<uid>:<child seq>:<type>`, so it is recorded once.
- **No polling inside attempts.** Waiting ends the attempt and frees the
  slot; the child runs in that slot; its events queue the parent. The wait
  lasts as long as the child does — minutes or days — because it is the
  parent's record, not a process; a retained harness session is optional
  continuity for the next attempt ([sessions.md](sessions.md)), never what
  keeps the wait.
- **The parent's graph around the wait.** The attempt that dispatches ends
  with every other node it started completed, failed or waiting; a node left
  running is an interruption however normal the wait (front/converse/run-027:
  the talk node beside its delegate node, held twice). What is done with the
  result is a node after the delegate node; an adjustment that adds both can
  complete the running node at the same time (`wfe run adjust
  --completing`). `wfe delegate request` names nodes still running.
- **A completed child is told once** (project_migration p8 ex1): when the
  attempt that completed its execution ended (documentation steps reopen and
  recomplete it within one attempt), under the completing entry's receipt.
  A child reopened and completed again later is a new result.

## Operations

| Operation (`shared/run.ts`) | Who | `wfe delegate …` | Effect |
| --- | --- | --- | --- |
| `delegation.dispatch` | the parent's agent (its attempt) | `request <run> <node> --request <file> [--original <file>] [--replaces <d>]` | resolves and checks the target, writes `delegations/<d>/request.md` and `original-input.md`, records the delegation; the node waits on it |
| `delegation.bind` | intake | — | the child the request post became, and the post |
| `delegation.event` | relay (intake pass, executor reconcile) | `sync` | one fact of the child, by receipt `delegation:<uid>:<child seq>:<type>`; a waking fact queues the parent's continuation |
| `delegation.take-up` | the parent's agent | `take-up <run> <d> <n>…` | the facts are read; the node resumes |
| `delegation.answer` | the parent's agent | `answer <run> <d> <q> --answer <text> [--because answer:<q>]` | posted in the child's request topic and recorded there as the answer; the node waits |
| `delegation.instruct` | the parent's agent | `instruct <run> <d> --instruction <text>` | recorded as the child's additional instruction |
| `delegation.dispose` | the parent's agent | `dispose <run> <d> --disposition satisfied\|rejected\|abandoned --note <text> [--event <n>] [--manifest <digest>] [--yes]` | closes the delegation; `satisfied` lets the node complete; `satisfied` is assessed first (fix6) |
| `delegation.revise` | the parent's agent | `revise <run> <d> --instruction <text> --reason <text> [--event <n>] [--manifest <digest>] [--because …]` | (fix6) returns the latest result to the same child; posted in its request topic; the node waits |

Reading: `wfe delegate list|show <run> [<d>]`, `wfe delegate file <run> <d>
<path> [--out <file>]` (a file of the child's copy, compared with the hash a
fact recorded), `GET /api/workspaces/<ws>/runs/<wf>/<run>/delegations` (each
delegation with its state and its child's situation now; for a child, the
delegation it came from). The attempt's brief lists every delegation and the
facts not yet taken up in full.

Host stores: the notifier's `runs.kind = delegation` conversation per
delegation (`<target project>/<target workflow>/from-<parent>.<d>`, its
`request` the delegation uid, `bound` the child), with one outbox event per
request/answer/instruction (`…#<seq>:delegation-<kind>@<d>`, critical, sent
alone); `delegate.sqlite` (index rows: parent, target, child, how far the
child's history was relayed).

Error codes: `delegate-target`, `delegate-cycle`,
`delegate-relation`, `delegation-open`, `delegation-predecessor`,
`delegation-unknown`, `delegation-unbound`, `delegation-event`,
`delegation-result`, `result-superseded`, `delegation-closed`,
`delegation-unsatisfied`; fix6: `result-returned`, `delegation-correcting`,
`child-stopped`, `child-active`, `correction-state`.

HTTP (fix6): `POST runs/<wf>/<run>/delegations/<d>/dispose` and `…/revise`
take the same fields (`by`, `event`, `manifest`, `yes`, `receipt`,
`attempt`; `because` for revise) and refuse with 409 `{detail: {code:
"reminder", reminders, assessment}}`; `GET …/delegations/<d>/assessment`
reads one; `GET …/delegations` carries each latest result's assessment. A
remote worker forwards `wfe delegate …` with its flags like every command.

## Assessing a result (workflow_editor fix6)

Where the parent receives a result, WFE assesses it from the child's
records (`shared/assessment.ts`, file layer in `server/delegate.ts`). It
separates what the records show from what the child's frozen node catalog
expects: an expectation is the person's prose, shown beside the evidence,
never compiled into a rule.

| Check | Evidence | Status |
| --- | --- | --- |
| Presentation missing | the child's completed work as of the result — `work` template nodes, and untemplated nodes it added with files beyond notes ([runs.md](runs.md) *Reminders*) — and viewable candidates by extension (manifest artifacts, node artifacts, files its copy changed, in every repository it owns: a signal, not proof); its presentations and when each was registered or linked | `missing` when work completed after the latest presentation (an earlier page does not cover later work), or viewable files with no presentation at all; else `ok` |
| The person's review not recorded | only with `accepts: person` and a deliverable (work, viewable files or a presentation); the child's answers and decisions as of the result, and this delegation's answers and correction requests that relay words with `because` | `ok` when an answer from the person (`onBehalfOf`) about it is traceable; else `unknown` — a confirmation node, a decision or an agent's own answer alone does not show they reviewed it, and unknown is not a proven violation |
| Presentation still serving | the child's presentations now: review questions and their state, a planned cleanup, a recorded request to keep it (`presentation.retain`) | `serving` only for an answered (or never asked) review with no cleanup planned and no request to keep it; an unfinished review or a kept page is a fact, not an omission. Nothing stops a page because this ran |

**Bound to the result.** Each assessment names the delegation, the result
event, its manifest digest, the child's completing seq, the history position
its frozen facts come from (the entry after which the attempt that completed
it ended; the child's own history replayed to it), the child's revision in
force then and its catalog snapshot. What changed in the child since
(entries after that position, corrections) and its integrations (historical
facts bound to their own revisions) are listed apart. What could not be read
(the child's record, its copy, its catalog) is said explicitly. The child is
read without its lock; the parent's lock holds the result's identity.

**Where.** `wfe delegate show`; the take-up of a result (printed once); the
brief and continuation of the parent's next attempt while the result is not
taken up; `GET …/delegations`. As reminders (codes `delegated-<check>`,
merged with the parent's own into one response, refused before anything is
recorded, `--yes` / `yes` for that command only):

- `wfe delegate dispose --disposition satisfied` (HTTP `…/dispose`), under
  the parent's lock, before the delegation closes;
- the parent's outward report — `wfe conversation reply|contribute --kind
  result|synthesis`, with or without `--completing` — and the completion
  that completes the parent run (`wfe run complete`, `adjust --completing`,
  HTTP `ops`/`adjust`), whether or not the parent has work nodes of its own.

At report time every delegation's latest result is assessed — open or judged
`satisfied` (an earlier `--yes` exempts nothing later); `rejected`,
`abandoned` and orphaned ones are not. A corrected result is assessed anew,
so a repaired omission disappears. The repairs offered are the parent's:
inspect the child's evidence, relay an actual answer of the person, return
the result to the child, or continue as it is. They never ask the parent to
act as the child or to record a review nobody gave. A stale result
(`result-superseded`), a result returned for correction (`result-returned`)
and attempt ownership stay errors that `--yes` does not pass.

**At dispatch.** `wfe delegate request` prints, as information, who accepts
the child's result, that the parent relays its questions and presentations
to the person, and the target's node catalog expectations as they are now (a
preview: the child freezes its own snapshot at creation, and that snapshot
is what its result is assessed against). The child's brief names the person
the parent acts for and the parent's relay role; the request itself is
delivered unchanged.

## Correction (workflow_editor fix6)

`wfe delegate revise` returns the child's current completed result to the
same child instead of closing the delegation (`dispose rejected` stays
closure and replacement):

1. **Parent.** `delegation.revise` under the parent's lock: the delegation
   is open and bound; the result is the latest completed event, taken up,
   with the manifest digest given (if any); no correction stands for it; the
   child did not fail or get cancelled after it. The file layer also
   refuses a child that is cancelled, executing, or not completed now. The
   delegate node waits (`correcting`).
2. **Delivery.** The notifier's delegation conversation posts it in the
   child's request topic (`…:delegation-revision@<d>`, critical, alone), as
   answers and instructions are; a lost acknowledgment is found by its
   marker; a missing outbox row is queued again from the record.
3. **Child.** The intake binds the post by message id and records
   `correction.receive` under the post's receipt (a repeated application is
   one record). A completed child is reopened: its execution is
   `in-progress` while the correction is unaddressed, so the scheduler
   continues it (one job per correction, reconcile queues a lost one) and
   the relay does not announce the old result again. A refusal (the child
   completed again since — `result-superseded` —, is no longer completed,
   or is cancelled) is told to the parent as `answer-refused` with
   `revision`, which ends `correcting`.
4. **Work.** The child's agent reads it ("This attempt", `wfe run
   correction`), adds the missing work as nodes with its ordinary adjustment
   and performs it — present, feedback, cleanup as its catalog expects;
   completed work is kept — or records `--no-change` with why.
5. **New result.** Its next completion is a new `completed` event with a new
   manifest; the parent takes it up and assesses that version before it
   judges or reports it.

A held parent records the child's facts and launches nothing until resumed;
cancelling the parent never cancels the child. Competing requests are
ordered by the parent's lock: after `revise`, `dispose satisfied|rejected`
of the returned result is refused (`result-returned`), `abandoned` closes
the delegation, a second `revise` is refused (`delegation-correcting`);
after a disposition, `revise` is refused (`delegation-closed`). Replay keeps
both the returned and the corrected result (events, `revisions`, the child's
`corrections`).

Earlier acceptances and integrations of the child stay historical facts
bound to their revisions: an acceptance binds its tree, so the corrected
files need a new acceptance, and integration follows the child's own rules
([integration.md](integration.md)). When integration is permitted is not
changed.

## Views and observation

- **Editor**: the delegate inspector selects the target project (this one or
  another registered one), its workflow and who accepts the child's result;
  validation knows the registry's projects (`delegate-project-unknown`,
  `delegate-target-unknown`, `delegate-no-intake`, `delegate-recursive`).
  A delegation task can also be a node-catalog template of type `delegate`
  with an optional `target` ([catalog.md](catalog.md)).
- **Run view**: the delegate node's card says where its child stands; the
  selected node and Detail's *Delegations* show each child, its links
  (run view, conversation, progress, detailed IO), the next move, what it
  asked and how it was answered, the result manifest and the disposition;
  the focus card says what the run waits for; a child's *Related runs* links
  back to the run that delegated it.
- **Observation** ([observation.md](observation.md), *Delegations*): the
  wait names the child as responsible; Observer treats a healthy wait as
  quiet, a relayed fact without a continuation as an unowned continuation,
  a fact not relayed for 5 minutes and a dispatch without a child for 15
  minutes as suspicions told to the owners, and the child's own failures as
  the child's incidents only.

## Limitations

- Parent and child runs are on the same execution host (the relay reads the
  child's record locally).
- A request is delivered as text with its original beside it; files the
  parent wants the child to use are named in it (or placed where the child
  reads), not attached.
- Exactly-once Zulip delivery is not claimed ([runs.md](runs.md),
  *Deliveries*); identity and application are.
