# Workflow observation and recovery (`ag.wfe-observation.v1`, observer p3)

A read-only snapshot of every run this host knows, for monitors (Observer)
that must decide whether work is moving, legitimately waiting or stopped,
and the one operation through which a recovering agent continues an
interrupted run. The run contract is in [runs.md](runs.md); where a run
lives is in [storage.md](storage.md).

## Authority

| Subject | Authority | Owner |
| --- | --- | --- |
| Request, plan, questions, answers, instructions, holds, completion | `run.json` (the run's own copy) and the documents it references | WFE operations |
| Work products, checkpoints, integrated changes | the run copy, its run branches, the publication and integration journals | WFE / executor |
| Attempts, process identity, queue, slot, heartbeat, activity | `<area>/.local/exec/exec.sqlite` and the attempt's log | executor (autolab) through `wfe exec` |
| Incidents, recovery assignments, verified outcomes | Observer's own store, linked to the run identity below | Observer |
| Agent-to-agent requests and replies | Zulip, carrying references to the records above | transport |

The observation is a **view**. It reads these authorities, reconciles
nothing, enqueues nothing, creates no copy, writes no record and posts
nothing. Absence in it is never evidence that work finished.

## Run identity

A display reference (`<workflow>/<run>`), a directory, a branch label or a
Zulip topic is not an identity. A run is identified by:

| Field | Meaning |
| --- | --- |
| `project` | `run.json` `project` |
| `workflow`, `run` | the run reference |
| `creation` | the first 16 hex digits of the SHA-256 of the canonical `run.create` history entry: different creations that reuse the same display identifiers differ here |
| `uid` | `<project>/<workflow>/<run>#<creation>` — the key a monitor stores |
| `workspace` | the registry workspace whose copy (or tree) holds the live record |
| `created`, `receipt` | when and from what request (`run.create` receipt) it was created |
| `branch` | the run branch (`storage.branch`), null for a run kept in the project tree |

When two registrations yield the same `<project>/<workflow>/<run>`, both
are listed and each carries the problem `ambiguous` naming the other
workspace: a monitor never merges them and never guesses which is live.

## Delegations (p10)

A run with delegations ([delegation.md](delegation.md)) carries
`delegations: [{id, uid, node, state, target, dispatchedAt, closed, child,
pending, unrelayed, delivery, problem}]`:

| Field | Content |
| --- | --- |
| `child` | `{uid, workspace, ref, situation, execution, waitingFor, hold, failed}` read from the child's own record, or null before it exists |
| `pending` | facts relayed to this run that wake it and are not taken up (`{n, type, at}`) |
| `unrelayed` | facts of the child's history not yet recorded on this run (`{type, childSeq, at, wakes}`): a growing list means the relay is not running |
| `delivery` | before a child exists: the request delivery's state in the notifier's journal (`ready`, `sending`, `failed`, `unresolved`, "may have been posted", `sent`, `queued`, `not-queued`) |

A delegate node's wait names its responsible party: `delegation:<child
uid>` (the child's move — the child is observed as a run of its own),
`delegation-unbound:<delegation uid>` (no child yet), or `executor` when a
relayed fact waits for this run's agent and no job is queued (an unowned
continuation, recoverable like any other).

## `wfe observe [--json] [--workspace <id>] [--run <wf>/<run>] [--terminal]`

Without `--terminal`, completed or cancelled runs are listed only when they
have outstanding publication or integration work, a problem, or a recovery
not yet followed by an attempt. A monitor that tracks a run asks for it by
name (`--run <workspace>:<workflow>/<run>`, repeatable), which lists it
whatever its state. The same document is served at `GET /api/observe`
(`?workspace=`, `?run=` repeatable, `?terminal=1`). The document:

```json
{
  "schema": "ag.wfe-observation.v1",
  "observedAt": "2026-10-14T05:00:00.000Z",
  "host": "agstudio",
  "release": "c100f56…",
  "executor": {
    "state": "available | unavailable | unknown",
    "heartbeatAt": "…", "ageSeconds": 3.1, "name": "autolab", "pid": 68404, "detail": "autolab; idle",
    "slot": { "attempt": "a…", "workspace": "jevlab", "run": "study/run-001", "uid": "…" },
    "queued": 0
  },
  "workspaces": [ { "id": "jevlab", "available": true, "problem": null } ],
  "runs": [ { …one run, below… } ],
  "problems": [ { "code": "…", "message": "…" } ]
}
```

One run:

| Field | Content |
| --- | --- |
| `identity` | the table above |
| `source` | `{state: ok \| unreadable \| copy-missing \| copy-damaged \| copy-creating, problem, location: copy \| workspace, readAt, reads, consistent}` — `reads` is how many times the record was read to get a consistent snapshot; `consistent: false` means it kept changing and the facts may straddle a transition |
| `seq`, `updated` | the record's last sequence and its time |
| `situation` | `shared/run.ts` `situation()` (`executing`, `stopping`, `awaiting-person`, `stopped`, `interrupted`, `unknown`, `completed`, `cancelled`, `not-started`, `idle`) |
| `execution` | `state`, `ready`, `active`, `failed`, `blocked`, `waiting: [{node, on, holder, since, deadline}]` (`deadline`: an external wait's declared latest time, `wfe run wait --deadline`) |
| `hold` | `{kind, since, by, reason, because, human}` — `human` is true for `stopped` (a person's or a person's words) and false for the executor-derived `interrupted`/`unknown` |
| `stop`, `cancelled` | as recorded |
| `attempts` | `{count, beganSeq, open: {id, began, reason, backend, agent} \| null, last: {id, outcome, ended, detail} \| null}` — `beganSeq` is the sequence of the latest `attempt.begin` |
| `session` | agent_session p1, from the record ([sessions.md](sessions.md)): `{policy: fresh \| run, current: {id, began, attempts, attached, mismatch} \| null, count, ended: [{id, state, at, by, reason}]}` (the last three replaced or retired). A session is a conversation, not a process: it proves no liveness and its age is no stall timer |
| `process` | the open (or last) attempt's host facts: `{attempt, state: launching \| running \| ended, host, local, pid, alive, began, ended, exit, signal, outcome, stopRequested, session: {id, resumed} \| null (from the record), group: {members, cpuSeconds} \| null, log: {last, bytes, turns, session, problem, openTool: {name, since, timeoutSeconds, summary} \| null, ended: {subtype, stopReason} \| null, backgroundStopped, partial}}`; `alive`/`group`/`log` are `null` with a reason in `unavailable` when not observable here. `log.ended` is the harness's own end of the session; `backgroundStopped` counts background tasks the harness reported stopped (they die with the session); `partial` says the tail did not reach the log's start |
| `queue` | `{job: {id, kind, state, created, reason, receipt} \| null, position, ahead: [{uid, kind, state}]}` |
| `inputs` | `{questions: [{id, node, to, asked, state}], answeredNotTakenUp: [q…], instructionsPending: n}` |
| `waiting` | `{reason, responsible, since}` — what the run waits for and whose move it is: `person:<name>`, `executor` (an answer recorded, ready work, a queued job), `external:<ref>`, `recovery` (an interrupted/unknown hold) or `none` |
| `progress` | `{seq, at, op, by, attempt}` of the last report the run's agent made itself (an executor operation in its name); null when it never reported |
| `recoveries` | `run.recover` entries: `{seq, at, by, incident, attempt, agent: {run, attempt}}` |
| `publication` | `{failed: [{id, kind, error}], attention: […], pending: […]}` checkpoints that are not published |
| `integration` | `{queued, running, failed, refused, attention}` rows of the integration journal |
| `input` | `{kind, requester, source}` — how the run was requested (`source` is run.json's `input.source`: a Zulip post's realm, message, channel, topic; a recovery run carries its incident through its request post) |
| `executor` | `{name, host}` — the agent the run is performed as and its execution host |
| `problems` | `[{code, message}]` — `ambiguous` (the same display identity in another registration), `changing` (not consistent after three reads) |
| `unavailable` | `{<field>: <why>}` for every fact that could not be read |

### Consistency

A run is read as: `run.json` (its `seq` and `control.attempt`), the
executor's rows for it, then `run.json` again. When the sequence or the
open attempt changed in between, the whole run is read again (up to three
times); still changing, it is reported with `consistent: false`. The
executor's rows are read in one SQLite read transaction. A decision made on
an observation must still be revalidated at the operation it leads to
(`--expect-seq`, the attempt guard of `run.recover`).

### Bounded reads

The record is re-read only when its size, modification time or inode
changed (the service's cache); an attempt's log is read incrementally from
its last offset (`server/activity.ts`); process facts come from one `ps`
call for the whole observation.

## Process evidence

Executor heartbeat, attempt process liveness, harness activity, tool
activity and workflow progress are separate facts:

| Fact | Source | What it does not prove |
| --- | --- | --- |
| executor heartbeat | `heartbeat` row | that any attempt is healthy |
| process alive | `kill(pid, 0)` on the attempt's host | that it is doing anything |
| process group CPU | `ps` over the attempt's process group | that the work is useful |
| harness activity | the attempt log's last write, turns, session id (supporting evidence; the record's `process.session` is authoritative) | that the run moves |
| retained session | the record's `session` | that any process exists |
| open tool call | the last `tool_use` without its `tool_result` in the stream-json log, with its declared timeout | that the command will finish |
| workflow progress | the run's agent's last report (`progress`) | that the process still lives |

## `wfe run recover` (`run.recover`)

The operation a recovering agent uses to continue an interrupted run
instead of impersonating a person's `run resume`.

```text
wfe run recover <run> --incident <id> --attempt <the ended attempt> --reason <text>
                      [--expect-seq <n>] [--by <name>] [--recovery-attempt <own attempt>]
```

- **Holds it may lift:** `interrupted` and `unknown` only — holds the
  executor derived from how a process ended. Without a hold it may queue a
  continuation nothing owns: ready work, a node recorded as running, an
  answer recorded and not taken up, or a run never started, with no job
  queued or claimed (`recover-owned` otherwise); `--attempt` is then the
  run's last attempt, or `none`. A `stopped` hold (a person, or
  an agent acting on a person's words), a pending stop and a cancellation
  stay binding (`recover-human-hold`, `held`, `run-cancelled`).
- **Guards:** the hold's attempt must be the one named (`--attempt`, the
  record's `control.last.id`; `recover-stale` otherwise), `--expect-seq`
  refuses a decision made on an older view, and no attempt of the run may be
  open in the record or alive on this host (`recover-process-alive`): one
  writer per run copy.
- **Budget:** at most 2 recoveries since the run's last person-originated
  control (`run.resume`, an answer, an instruction) or its creation
  (`recover-budget`); then a person decides. The same `--incident` and
  attempt are recorded once (receipt `recover:<incident>:<attempt>`), so a
  retransmission or a second recovery task for the same episode is a no-op.
- **Who:** inside a recovery attempt (`WFE_ATTEMPT` of another run), the
  actor is that run's agent, verified against the executor's open attempt
  and recorded as `agent: {run, attempt}`; outside an attempt `--by` names
  the recorder. The recovering agent never records as the target run's agent.
- **Effect:** the hold is lifted, the entry records `incident`, the ended
  `attempt`, the reason and the actor, and the run's resumption is queued
  (receipt `recover:<workspace>/<run>/<incident>/<attempt>`). The next
  attempt's brief says that the run was continued by recovery, for which
  incident and why, and that side effects after the last record are the
  recovering agent's findings, not facts.
- **Not granted:** replaying side effects, accepting a result, changing the
  plan, answering a question. An interrupted attempt is not permission for
  any of these.
