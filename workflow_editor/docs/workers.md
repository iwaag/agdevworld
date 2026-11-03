# Execution nodes (workers, project_migration p7)

One **coordinator** — the WFE service of an area and its execution store —
keeps every run's record. Runs are performed by **workers** (execution
nodes): each has its own processes and its own disk, and holds as many
attempts at once as warden's coordination admitted (improve_wfrun p4,
[coordination.md](coordination.md)); an area without coordination keeps one
attempt per lane.
Code: `server/workers.ts` (configuration, node choice, record-copy
alignment), `server/exec.ts` (the store), `server/workerApi.ts` (HTTP),
`cli/remote.ts` (`wfe` on a remote worker). Fixtures: `test/workers.test.ts`, `test/lanes.test.ts`.
Deploying a worker on a PC: the `wfe_worker` profile of pj-clusterintent's
ansible_agdev, and the recipe `nctl/docs/add-a-wfe-worker.md` there.

## Configuration

`<area>/workers.json` on the coordinator:

```json
{ "default": "studio",
  "coordination": { "worker": "studio", "lane": "coordination", "workspace": "warden", "workflow": "coordinate" },
  "workers": {
    "studio": { "local": true, "label": "the coordinator's host", "lanes": ["conversation", "coordination"] },
    "gpupc":  { "label": "the GPU PC", "tokenFile": "workers/gpupc.token" } } }
```

- Ids match `^[a-z][a-z0-9-]{0,31}$`; they are logical names recorded in
  runs, not host names.
- Exactly one worker is `local`: it shares the coordinator's files, its
  agents work in the run's record copy itself, and its executor reaches the
  store through the CLI (`wfe exec … [--worker <id>]`, the local one by
  default).
- Every other worker reaches the coordinator over HTTP with its token.
- No file: one local worker, `local`.
- `lanes` (optional, p8): the extra lane names the worker's executor serves
  beside `default` (see "Lanes" below). A legacy object (`{"conversation":
  1}`) is read as its names.
- `coordination` (optional, improve_wfrun p4): the worker and lane that carry
  coordination runs, and the workspace and workflow they are created from
  ([coordination.md](coordination.md)). Without it every job is admitted as
  it is queued and each lane holds one attempt.

On a remote worker, `<worker area>/worker.json`:

```json
{ "coordinator": "http://<coordinator>:8098/", "worker": "gpupc", "label": "…",
  "tokenFile": "worker.token", "facts": { "os": "…", "godot": "…", "display": "…" } }
```

beside `worker.token`, `gitea.json` (+ its token file) for Git, `shares.json`
for the host's shared areas, `copies/` (run copies), `overlays/<project>/`
(host notes copied into a copy's `.local/`) and `.local/` (logs, state). Its
launcher sets `WFE_WORKER_AREA`; with it and no `WFE_REGISTRY`, `wfe` is the
coordinator's client.

## Which node performs a run

Chosen once, when the run is created, and recorded as `executor.node` in
`run.create`. The first given wins:

1. the request's `--node` (`wfe request`, the browser's request route);
2. the workflow's `execution.node`;
3. the project's `execution.node` (`project.yaml`);
4. the area's `default`.

An unknown node is refused before anything is created. Every attempt of the
run is performed by that node. `wfe run assign <run> --node <id> --reason …
--by …` (`run.assign`) changes it between attempts, recorded with who and
why; nothing changes it by itself, and a lost worker's run is never sent
elsewhere. A record without a node (made before p7) is read as the default's;
`wfe runs assign-nodes --by …` records the node of every unfinished run.

## The queue and the attempts

- A worker claims only jobs of runs assigned to it, oldest first among those
  warden admitted (improve_wfrun p4: `jobs.decision = start`; a job awaiting a
  decision or deferred waits with that in its note). Jobs of other workers
  are left as they are: neither taken nor dropped. Without coordination
  configured, it claims when its lane's one attempt is free.
- A job its worker cannot serve now waits with the reason in its note
  (`waiting for worker …`): a profile it does not offer, a session policy
  its harness cannot keep, a dispatch that could not be published. It is
  not dropped and not given to another worker. A run that is cancelled,
  held or already open still has its job dropped, as before.
- One open attempt per run (the record). A worker holds several attempts at
  once (the store, p4): each with its own process, log, stop, end, checkpoint
  and adoption; a worker's `slots` lists them.
- A claim may carry the worker's receipt: the same receipt again gets the
  same answer (a lost answer is not a second attempt).

## Lanes (project_migration p8, improve_wfrun p4)

A lane names which claim loop of a worker's executor serves a run. Before p4
each lane had a capacity (the conversation lane let a Front answer while a
long attempt held the one default slot); since p4 a lane has none: ordinary
work in every lane is admitted by warden's decisions, and the one lane with
a rule of its own is the **coordination lane**, which takes coordination
runs one at a time without a decision ([coordination.md](coordination.md)).
A worker declares its extra lanes in `workers.json` (`"lanes":
["conversation", "coordination"]`).

- A workflow names its lane with `execution.lane: <name>` (the project's
  `execution.lane` is the fallback; same pattern as node ids). It is part of
  the approved definition and frozen into the run at creation as
  `executor.lane`; absent means `default` and is not recorded.
- A claim is made in one lane: `wfe exec claim --lane <name>` (HTTP: `lane`
  in the claim body); without it, `default`. In the coordination lane it
  takes the oldest queued coordination run while none is open there; in any
  other lane it takes the oldest admitted ordinary job of the worker,
  whatever lane its run names (the run's lane, `executor.lane` when the
  worker declares it, else `default`, is recorded on the attempt). A claim
  in a lane the worker does not declare is refused (`lane-unknown`). Without
  coordination configured a claim takes only its own lane's jobs and is idle
  while that lane's one attempt is open (as before p4).
- The attempt row records its lane (`lane`, NULL = default; store
  version 4). `wfe exec adopt` answers each attempt with its lane, so a
  restarted executor hands it back to that lane's loop.
- Views: a worker's `busy` (observation: `slot`) is its first open
  default-lane attempt (what "the slot" was); `slots` lists every open
  attempt with its lane and the decision that admitted it, `lanes` the
  extra lane names, `load` what its executor measured of its host.
- The executor (autolab `wfexec`, setting `lanes = ["coordination"]`) runs
  one claim loop per extra lane and tends every attempt it holds on its
  own; heartbeat (with the host's load, `--facts-json`), reconcile
  (`--holding` with every lane's attempts), notifications and intake stay
  with the default lane's, on a keeper thread.
- The coordination lane is the coordinator's host's: a remote worker's
  `wfe exec claim --lane` is refused. A remote worker holds several
  attempts too; its bookkeeping (`state.json`) is changed under a lock, so
  its executor's keeper, claims and ends may run at once.

## Reports and their owner

Every report names its attempt, and only the attempt's worker may make it:
`started`, `session`, `context`, `finished`, the worker's checkpoint. A
report from another worker is refused (`attempt-foreign`). `started` and
`finished` repeated are accepted and answer what was recorded. A late report
of an ended attempt changes nothing. Stops are per worker (`wfe exec stops`):
a requested stop stays pending in the views until the owning worker reports
the end; the coordinator never looks at a remote worker's process ids.

## Where a remote worker's run lives

| | Coordinator | Remote worker |
| --- | --- | --- |
| Copy | the **record copy** (`<workspace>/.local/wfe/runs/…/tree`, as in [storage.md](storage.md)) | its working copy, `copies/<workspace>/<workflow>/<run>/tree` |
| `run.json` | the authority, in the durable record beside the tree (improve_wfrun p2): every operation writes it, under the run's lock | a snapshot brought back after each command; never written there, never uploaded |
| Run folder documents | uploaded into the durable record before each forwarded command and at the end | written by the agent, in a real folder |
| Code | follows the worker's commits at each worker checkpoint | edited, built and run by the agent |
| Attempt log | `<area>/.local/exec/logs/<attempt>.jsonl`, shipped by offset with every heartbeat and at the end | written by the harness |

**Dispatch.** A remote worker's claim first publishes the run's branches
(a checkpoint `dispatch to <worker>`) and answers with every repository of
the copy, its run branch and the published commit. The worker clones or
fetches them (submodules, nested ones included, initialized as the copy
has them), moves each branch only forward to that commit, brings the run
folder and stages copied input sets from its own share, checking each file
against the recorded hashes. A commit it cannot reach, a branch that went
another way, a share it does not have: the attempt ends interrupted with
`preparation on <worker> failed: …` and the run is held with that reason.

**Forwarded commands.** On the worker, every `wfe` command but `exec` and
`share` goes to the coordinator: the run folder and the files the command
names (relative paths, absolute paths inside the copy, and files outside it,
carried into `.local/wfe-forward/`) are uploaded first; the coordinator's
own `wfe` runs it in the record copy with the attempt's id; its output comes
back with the record copy's paths rewritten to the worker's; the run folder
comes back after. `wfe share …` reads the worker's own shared areas.

**The end.** `finished` uploads the run folder, ships the log and reports the
end. The coordinator records `attempt.end` and opens a checkpoint of mode
`worker`; the worker brings the record back into its copy, commits and pushes
its run branches (submodules first, as [runs.md](runs.md) *Publication*), and
reports the steps. The coordinator then aligns the record copy: each
repository fetched and moved forward to the pushed commit (never backwards,
never forced), `run.json` kept as it is. Until that checkpoint is published,
the coordinator publishes nothing of the run and integration waits; then
integration runs on the coordinator as before, on the worker's commits.

**Retirement** ([storage.md](storage.md) *Retirement*). A run's retirement asks every worker that ran it to archive
what only it holds, and removes the worker's copy once the run is retired. Lost contact holds it at `retiring`; a stale report
or upload changes nothing; files of a run that is not ready are refused.

## Contact lost, restarts

- A worker whose last heartbeat is older than 45 s is `unavailable` in the
  views: contact is lost. Its open attempt stays open and assigned; nothing
  is ended, rerun or moved because of the silence.
- A worker that cannot reach the coordinator claims nothing. Its running
  attempt goes on; its reports are retried. Its agent's forwarded commands
  fail with the reason.
- The worker keeps its bookkeeping in `<worker area>/.local/worker/state.json`
  (every held attempt: copy, log offset, process id; changed under a lock
  since p4). The executor's launch gate writes
  `<log>.exit` when the agent's process ends. After a restart the executor
  re-adopts a live process (`wfe exec adopt`); `wfe exec reconcile` ends an
  attempt whose process is gone with what its exit file says, or as lost
  (`unknown`, held); a launch that never registered is lost after two minutes.
  A checkpoint still owed is published again; without a copy on the worker it
  is recorded as `nothing`.
- A session (`execution.session: run`) is resumed only on the worker that
  holds it: a session missing from a worker's store is replaced through the
  existing record (`attempt.session replaced`), and an assignment to another
  worker starts a new session.

## HTTP (`/api/workers`)

`GET /api/workers` — every worker's state (no token). With `Authorization:
Bearer <token>`, for `/api/workers/<id>/…`: `POST heartbeat`, `POST claim`,
`POST started`, `POST finished`, `POST session`, `POST context`, `GET stops`,
`GET due` (open attempts, owed checkpoints), `POST checkpoint`,
`GET|POST log?attempt=&offset=`, `POST manifest`, `PUT|GET files`
(tar streams of a run's record copy, confined to its tree), `POST cli`.
Every route acts for that worker and refuses runs assigned to another.
