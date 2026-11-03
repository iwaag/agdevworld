# Execution coordination (`ag.wfe-coordination.v1`, improve_wfrun p4)

Ordinary work starts when an agent decided it should: **warden** judges how
queued work proceeds — start on the run's node, place it on another worker,
wait, look closer, or arrange a practical change — and WFE records the
decision and carries it out. There is no slot count, no resource lock, no
compatibility matrix and no load threshold in code: what a worker holds is
what warden admitted. Mistaken judgments are tolerated and revised from what
is observed; nothing here is a hidden fallback policy.

Code: `server/exec.ts` (admission, events, turns, decisions, the view),
`server/workers.ts` (configuration), `cli/coordinate.ts` (`wfe coordinate`),
`shared/status.ts` (how a queued job reads). Fixtures: `test/coordination.test.ts`,
`test/lanes.test.ts`; the executor's side in agautolab `tests/test_wfexec.py`.
The agent's side (the warden project's guides) is not WFE's.

## Configuration

`<area>/workers.json` names where coordination runs:

```json
{ "default": "studio",
  "coordination": { "worker": "studio", "lane": "coordination", "workspace": "warden", "workflow": "coordinate" },
  "workers": { "studio": { "local": true, "lanes": ["conversation", "coordination"] }, "gpupc": { "tokenFile": "workers/gpupc.token" } } }
```

- `workspace`/`workflow`: the registered workspace of the coordinating
  project and its coordination workflow, published on the project's default
  branch ([access.md](access.md)). WFE creates coordination runs of it.
- `worker`/`lane`: the worker and lane that carry them. The lane is declared
  on that worker; its executor serves it as a loop of its own.
- Without `coordination`, an area keeps **one attempt per lane** as before
  p4 (a fixture, an isolated area): every job is admitted as it is queued.

Lanes have no capacity any more ([workers.md](workers.md), "Lanes"): a lane
is the loop that claims, not a slot count. The conversation lane keeps its
runs' label; its runs are admitted like any other.

## Admission

Every queued job of ordinary work carries its admission (`jobs.decision`,
store version 5):

| `decision` | Meaning | A claim |
| --- | --- | --- |
| NULL | awaiting warden's decision | leaves it, with the note `awaiting warden's coordination decision` |
| `start` | warden decided it starts (`decision_id`) | takes it, when its worker claims; the attempt row records the decision |
| `defer` | warden deferred it; `defer_until` when its time comes | leaves it, with the deferral's reason and reconsideration |

A decision of scope **run** (the default of `start` and `defer`) stands for
the run's later jobs on that worker: a continuation queued afterwards (an
answer, a child's fact, a resume, a recovery) is admitted or deferred at
once by the run's latest standing decision, without asking warden again. A
decision of scope **job** applies to the queued job only. A later decision
on the run supersedes the earlier one for what comes after it.

Coordination runs themselves are admitted by their lane: the coordination
lane claims the oldest queued coordination run while none is open there,
without any decision. A decision about a coordination run is refused
(`decision-self`).

A worker claims **every** admitted job of its own, however many attempts it
already holds (`wfe exec claim` takes one per call; the executor claims once
per tick). One open attempt per run stays the record's rule; a worker's
stops, ends, logs, publication and adoption are per attempt
([workers.md](workers.md)).

## Events and turns

What prompts warden to look is an **event** (`coordination_events`):

| Kind | When |
| --- | --- |
| `queued` | an ordinary job was queued (with what its standing decision did, if any) |
| `attempt-ended` | an ordinary attempt ended (outcome and situation) |
| `worker-available` / `worker-unavailable` | a worker reported after silence, or fell silent (45 s) |
| `reconsider` | someone asked for another look (`wfe coordinate reconsider`): a working agent, recovery, a person |
| `wake` | a deferral's time came (`--until`) |

Events are durable and are **taken** by the coordination attempt that had
them (`wfe coordinate events --take`; every event older than an attempt is
taken by it when it ends). Events alone wake nothing: a **turn** (one
coordination run, `coordination_batches`) is opened when something awaits a
decision — a job with no decision, a deferral whose time came or whose
named event happened, a reconsideration request — and no turn is open. The
claim, the end of an attempt and the executor's reconcile all call it; a
burst makes one turn, and events that arrive while it runs are read by it
(`wfe coordinate events`) or by the next turn. A turn closes when its
attempt ends, with the number of decisions it applied.

The turn's run is an ordinary run of the configured workflow (requester
`WFE`, receipt `coordinate:turn-<n>`), with its own record, log and folder.
Its request names why it was opened.

**Judgment unavailable.** A coordination attempt that ends without a
decision (a model failure, an interruption) closes its turn; whatever still
awaits a decision opens the next one. After three turns in a row without a
decision, automatic turns pause for ten minutes: the pause is visible
(`wfe coordinate view` STALLED, the observation's `coordination.stalled`,
Observer tells the owners), `wfe coordinate wake` opens a turn at once, and
the pause ends by itself. Nothing is admitted by a hidden rule meanwhile,
and nothing queued is dropped. A turn whose run disappeared (its job dropped
or cancelled, no attempt open) is closed as `lost` by the next look. A
coordination run is never sent to recovery (Observer's `[recovery] exempt`);
its failure is told to the owners and retried by this path.

## Decisions

`wfe coordinate start|defer|assign|note` records one decision (`decisions`):
who (the coordination run's agent inside its attempt, else `--by`), the
action, the run, the job, the worker, the scope, the reason, observations and
assumptions as given, the reconsideration of a deferral (`until`, `on`), the
basis it was made on, its state and what came of it (`attempt`: the attempt
it admitted; `batch`: the turn).

- **start** `[--worker <id>]`: the job is admitted on the run's node; with
  `--worker` the run is moved first (below).
- **defer** `--until <time>` / `--on <events>`: the job waits; the wake time
  is an event, a named event kind happening is a reason to look again, and
  without either the next turn looks at it anyway.
- **assign** `--worker <id>`: moves the run between attempts without
  admitting it (`run.assign` by warden, `via: coordination`).
- **note** `--text`: a note the run's agent reads in its next brief
  (`Execution coordination:` — the decision it started by, who shares its
  node, the notes), and anyone reads with `wfe coordinate notes`.

**Basis.** The view gives each queued job a basis token: the record's
sequence, the job and its state, the run's node, the ordinary attempts open
on the worker. A decision made with `--basis` whose token no longer holds
is recorded as `stale`, applies nothing, and answers the facts as they are
now (`decision-stale`). A changed load sample is not part of the basis.
Without `--basis` the decision applies to what is there now.

**Placement.** `executor.placed` records where a run's node came from at
creation (`request`, `workflow`, `project`, `default`), and `run.assign`
keeps who moved it and why. A node the request named, or a node a person
(anyone outside coordination) assigned last, is a **placement constraint**:
warden's move is refused (`placement-constraint`, recorded as such) and the
view says so. A node a workflow, a project or the area's default chose is a
preference warden may change; its own moves are not constraints. A move
happens between attempts only; a run with a retained session gets a new one
on the other node (the record replaces it at the next attempt), worker-held
files follow the worker's publication, and a dependency the other node lacks
is a fact in the view (the worker's profiles and host facts), not something
this operation checks.

**Racing.** Decisions and claims are serialized in the store: two decisions
on one job leave the later one in force and the earlier `superseded`; a
decision on a run whose attempt is open is refused (`attempt-open`); two
claims of one job make one attempt; a job keeps its decision through a
restart. `wfe coordinate apply --file` applies several decisions one by one
and reports each, so a failed batch is retried for its failed members only.

## The view

`wfe coordinate view [--json]` (`ExecStore.coordinationView`) is what
warden decides from — small, with deeper reads on demand:

- every worker: contact, measured load (`load`: cpus, load averages, memory,
  GPUs; from the executor's heartbeat, with its time), profiles, host facts,
  and its open attempts with the run's request (first lines), active nodes,
  last recorded progress and log time;
- every queued ordinary job: admission, its decision, why it was queued, its
  request, what is ready, whether its worker can serve it now, the placement
  constraint, the basis token;
- recent decisions, pending events, the open turn, a stall, recent turns.

Deeper: `wfe run show <run> --history`, `wfe exec status <run>`, `wfe run
state`, the attempt's log, `wfe observe`. Missing facts are shown as missing
(a request that cannot be read, a worker never heard from), never guessed.

## Where it shows

- `wfe observe`: `coordination` (configured, turn, stalled, awaiting,
  deferred, needs, pending events, overdue deferrals, last turn);
  per run `queue.job.admission` and `decision`; a queued job awaiting or
  deferred has `waiting.responsible = coordination`; `workers[].slots` every
  open attempt with its decision, `workers[].load`.
- Status in short ([runs.md](runs.md)): `Queued · Awaiting warden's
  decision`, `Deferred · By warden, until …: <reason>`, `Queued · Starts when
  its execution node next claims`, `Starting · Its execution node took the
  job`.
- The run view: Execution node with its provenance and moves; Coordination
  (the last decisions); in Detail, who shares the node and the decision the
  attempt started by. Home: every open attempt per node, queued jobs by
  admission, the measured load.
- Observer (agobserver `docs/workflow.md`): a job awaiting or deferred is a
  legitimate queue wait; a deferral past its time without a later decision,
  and turns ending without a decision, are told to the owners (family
  `coordination`); a coordination run's own failure is told, not recovered.

## Limits

- Nothing predicts a collision. Shared host state (`/tmp`, ports, displays,
  GPU memory, process names) is shared between attempts on a node; the brief
  says so and warden's notes can name paths. A collision is observed after
  the fact, reconsidered and revised.
- A decision admits a job; whether the worker can serve it (profile, copy,
  dispatch) is still the worker's, and the job's note says so.
- Live migration of a running attempt does not exist: a move takes effect
  at the next attempt. Stopping an attempt is `wfe run stop`, with its
  actual outcome.
- Recovery of an unavailable executor is unchanged: no execution service,
  no turns; the owners are told.
