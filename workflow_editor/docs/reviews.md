# Human review (workflow_editor p17)

A **human review** is a person's assessment of completed work, recorded
apart from any agent's acceptance of it. The run's agent prepares it on a
`review` node after its own review, and its work is done: the attempt ends,
the execution slot is free and no process waits. WFE then manages the
review for the person:

1. **Start review** — one action starts every presentation the review
   names, through each presentation's owning run, and shows them when they
   answer;
2. **Approve** — records the person's decision about exactly those
   revisions, then WFE stops what the review used, through each page's
   owner, and the work after the review continues by itself; or
3. **Request changes** — records the feedback, closes this round and hands
   the work back to the responsible agent, which appends work and a new
   review node.

Why: in workflow_editor fix6 trial A, ponderer accepted
misc/freework/run-007 itself (`accepts: parent`), told the child to stop
its page 23 s after the child presented it, and the person never had a
usable review. Agent review and early cleanup are allowed; what was missing
was a durable, person-controlled way to review the result later.

## Facts kept apart

| Fact | Record | Who |
| --- | --- | --- |
| An agent accepted a delegated result | the parent's `delegation.dispose satisfied` | the parent's agent |
| The work was handed to a person's review | `review.prepare` (round, summary, frozen subjects) | the run's agent (its attempt) |
| The person asked to see it | `review.start` | the person (browser, conversation, CLI) |
| What served it | `review.serve`, and the owning run's `presentation.observe` | WFE's host |
| The person's assessment | `review.decide` (approved, or changes with feedback) | the person, or an identified synthetic actor |
| Cleanup | `review.cleanup`, and the owning run's `presentation.observe stopped` | WFE's host |
| The agent read requested changes | `review.take-up` | the responsible agent |

None implies another. A Start review click is not a view and not an
approval; an approval is not permission to run agents, revise a workflow,
deploy or integrate anything (integration keeps its own rules,
[integration.md](integration.md)); a child's `run.decide`, a parent's
`dispose satisfied` and a review approval are three records. An agent's
own assessment is never recorded as the person's decision: `review.decide`
from an executing attempt (or another run's) is refused unless it relays
the person's own words (`because: answer:<q>` or `instruction:<i>`), and
then records the person as `by` and the agent as `relayed.by`.

## The node

```yaml
nodes:
  review:
    type: review
    name: Human review
    description: The person reviews the delivered figure.
edges:
  - {from: deliver, to: review}
```

- `review` is a node type of its own because no agent performs it: once
  prepared, its waiting, start, decision and cleanup are WFE's records.
  It is not a prompt convention on a talk or do node.
- Compiler `ag.wfe-compile.v5`: a review node gets no report step, and the
  final report follows the work before it (the nodes whose successors are
  all reviews), never the review itself. So the agent finishes its own work,
  final report included, and the run waits for the person alone. Graphs
  without review nodes compile exactly as under v4.
- A review node binds no repository (`review-repositories` warns) and is
  not a discussion activity.
- The node catalog's `human-review` template makes one; `wfe nodes
  instantiate human-review --run <run> --after <node>` adds it to a run.

## A round

`run.json` → `reviews.<rv>` (`rv1`, `rv2`, … per run; uid `<run uid>/<rv>`):

| Field | Content |
| --- | --- |
| `node`, `previous` | the review node; the round whose requested changes this one answers |
| `prepared` | `{at, by, attempt, seq}` — the agent that prepared it |
| `summary` | what was done and what to check (shown to the person first) |
| `responsible`, `reviewer` | the agent requested changes go back to; the person it waits for (the run's author or `onBehalfOf` unless named) |
| `subjects[]` | each `{n, workspace, project, workflow, run, creation, presentation, revision, title, delegation?, result?, repositories?}` |
| `state` | below |
| `starts[]` | every Start review request `{n, at, by, via, seq}` |
| `serving[]` | what the host found for the latest start, per subject: `available` with the instance and `started`/`reused`, or `failed` with why |
| `decision` | `{outcome, by, at, via, seq, feedback, subjects: [{n, revision}], synthetic?, relayed?}` |
| `cleanup` | `{state: pending/failed/done/handed, owner, results[], attempts}` |
| `continuation` | after requested changes: `{takenUp, addressed, during}` |
| `release` | after approval completed the round (p17 ex1): `{seq, at, during, unlocked, continued}` — below |

**Subjects are frozen when the round is prepared.** Each names its owning
run (workspace and creation-qualified identity), the presentation id and
its manifest revision, and what it represents: a delegated result (event,
manifest digest, child seq) and the trees of the owning run's repositories
then. A later child result or a later presentation never replaces them; it
is shown beside the round as newer material, and the person's decision is
about the frozen revisions only (`revisions` in the decision is checked
against them: `review-superseded`).

## States

| State | Meaning | Next |
| --- | --- | --- |
| `awaiting` | prepared; nothing serves it; no process waits | the person: Start review |
| `starting` | a start request is recorded; the host starts and verifies each subject | the host: `review.serve` |
| `reviewing` | every subject answered | the person: Approve or Request changes |
| `start-failed` | some subject did not start (named, with why); nothing is rebuilt or lost | the person: Start review again, or Request changes |
| `approved` | the decision is recorded once; cleanup is pending or failed | the host: stop and verify, retried |
| `complete` | cleanup verified; the node is completed | the run's agent, when the node's completion made work ready (below) |
| `changes-requested` | feedback recorded; the round and its node are closed | the responsible agent: take up, append work and a new review node |
| `cancelled` | the run was cancelled before a decision | the host: stop what the review started |

The review node waits on its round (`wait.on: {review: <rv>}`): on the
person while it is undecided, on WFE's cleanup once approved. The run's
situation is `awaiting-review`, its status **Work complete · Awaiting
human review** when everything else is done (then `Work complete ·
Approved · cleanup pending`). It is never the executor's move, never
stalled work, and an attempt that ends with only review waits ends
normally.

**Requested changes keep the run open.** The node completes with the
feedback as its outcome, but the run's execution stays `in-progress` while
the continuation is not addressed: its situation is `due` ("changes
requested in review rv1 by …"), a continuation job is queued (receipt
`review:<ws>/<wf>/<run>/<rv>`, again by reconcile and after an attempt that
ended while it arrived), and nothing announces a final success. It is
addressed by the first entry after which the run has work again — an
adjustment that adds nodes, a completed node started again, work recorded
as done, the same child asked again (`wfe delegate revise --follow-up`), a
new round — or by `review.take-up --no-change` with why. An attempt that
ends leaving it unaddressed is held `interrupted` (`missed-review`), like a
correction. The rejected round stays in the record with its evidence; the
next round names it as `previous` and is reviewed on its own, with new
frozen subjects: an old approval never covers it.

## After approval (p17 ex1)

Why: conversation `20261025-013759-jz8ebz`. gimmickimg/freework/run-013
had `present → review → cleanup`; its page served before the review and
was reused by it. Approval recorded cleanup `left` ("that run stops it"),
although that run was the review's own, so the page kept serving. The
round completed and `cleanup` became ready, but nothing queued it:
continuations existed only for requested changes. Recovery-agent resumed
the run 4.5 minutes later.

**Cleanup decides by ownership, not by how the review got the page.**
`reused` says the page was serving before; it is no exemption. For each
instance the round served:

| Found | Result | Serving afterwards |
| --- | --- | --- |
| another undecided (or handed) round uses it | `kept`, `owner` that round | yes, for it |
| the person asked to keep it (`wfe present keep`) | `kept`, `owner` who stops it | yes |
| reused, owned by a **different** run still under way | `left`, `owner` that run | yes: that run serves it and stops it |
| otherwise — including the review's own run's page, started or reused | stopped and verified; `presentation.observe stopped` on the owning run | no |
| the stop could not be verified | `stop-failed`: the round stays `approved`, cleanup `failed`, retried by reconcile | — (owed) |

A `left` or `kept` result resolves the round's cleanup, but never reads as
stopped: the round's text is "Approved · complete · a page still serving
(for <owner>)", the review page shows the subject "Still serving for its
run · <owner>" or "Kept serving", and `wfe review show` lists it under
`still serving`. A failed stop never completes the round and never asks the
person again.

**The work an approval made ready continues by itself.** When the cleanup
completes an approved round, the review node completes; the entry records
`release`:

- `unlocked`: the review node's successors that became ready;
- `during`: the attempt open at that moment, if any;
- `continued`: set by the first `attempt.begin` afterwards — that attempt
  owns the work from then on, with the ordinary rules (it is held
  `left-ready` if it ends leaving it).

The executor (`afterRelease`) queues one ordinary `resume` for it, receipt
`review-approved:<ws>/<round uid>@<seq>` (the uid carries the run's
creation, the seq the completing entry). One rule decides for all three
deliveries:

1. the cleanup's callback, at once (browser, CLI, reconcile's retry);
2. the end of the attempt that was open meanwhile (`during`): that end is
   not `left-ready` because of the unlocked nodes — only its own ready
   work counts — and the continuation is queued after it;
3. reconcile, after a lost callback or queue write, from the run read
   again after its review host work.

It queues only when the run is not executing (an open attempt is
reassessed when it ends), not held (a resume picks the work up and its
attempt consumes the release), not cancelled and not completed, and the
release is not consumed. The job goes to the run's assigned node through
the ordinary queue (a remote worker claims it there); the browser acting
on the coordinator does not matter. A final review with no successors
makes nothing ready: the run completes on the host with no agent turn.

An explicit cleanup node after the review is still ordinary work: the run's
agent does it. When the review already stopped the page, `wfe present stop`
reports it already stopped by the review's cleanup and succeeds. The brief
of the continuing attempt says the approval, what it made ready and what
the review stopped or left serving. The approval reopens nothing and asks
the person for nothing more.

Entries before p17 ex1 have no `release` flag and replay as they were
decided.

## Edges of the lifecycle

- **Stale actions.** A decided or cancelled round refuses another decision
  (`review-closed`); a decision naming other revisions than the round's is
  refused (`review-superseded`). A start while one is in progress is
  refused (`review-starting`); the host's result for an older start is
  refused (`review-stale`). The browser and the CLI always name the round.
- **Double clicks and retries** record one start (the second is refused or
  carries the same receipt) and never a decision.
- **Partial availability.** Approval requires `reviewing`: every subject
  available as last observed. A subject that cannot start is named in
  `start-failed` and never dropped from the round.
- **Service restart.** The round's state is durable. A round left
  `starting` is started again by reconcile (presentations already serving
  are reused, never duplicated); an approved round's cleanup is retried; a
  person returning to a `reviewing` round gets links resolved from the
  host's state now, and Start review again when an instance is gone.
- **Cancellation.** `run.cancel` closes undecided and approved rounds
  (`cancelled`); what their reviews started stays owned by WFE's
  cancellation cleanup (`cleanup.owner`) until verified stopped.
- **After requested changes**, the instances the review started are the
  responsible agent's (`cleanup: handed`): it may keep one for comparison
  or stop it (`wfe review cleanup <run> <rv>`); the next round's approval
  stops what earlier rounds handed over and nobody stopped. No round leaves
  an unowned serving process.

## Operations

| Operation (`shared/run.ts`) | Who | Effect |
| --- | --- | --- |
| `review.prepare` | the run's agent (attempt) | resolves and freezes the subjects (file layer), opens the round; the node waits |
| `review.start` | person | a durable start request |
| `review.serve` | WFE's host | what serves each subject for that start; `reviewing` or `start-failed` |
| `review.decide` | person (or relayed words) | approved (cleanup pending) or changes (round closed, continuation owed) |
| `review.cleanup` | WFE's host (or the responsible agent for handed instances) | what was stopped, kept or left (with `owner`); completes an approved round when verified, recording `release` (`release: true` entries) |
| `review.take-up` | the responsible agent (attempt) | the requested changes were read (`noChange`: nothing changes, with why) |

Error codes: `review-unknown`, `review-open`, `review-subjects`,
`review-state`, `review-starting`, `review-stale`, `review-closed`,
`review-unavailable`, `review-superseded`, `review-agent`.
