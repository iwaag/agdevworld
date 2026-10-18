# Execution nodes (workers, project_migration p7)

One **coordinator** — the WFE service of an area and its execution store —
keeps every run's record. Runs are performed by **workers** (execution
nodes): each has one execution slot, its own processes and its own disk.
Code: `server/workers.ts` (configuration, node choice, record-copy
alignment), `server/exec.ts` (the store), `server/workerApi.ts` (HTTP),
`cli/remote.ts` (`wfe` on a remote worker). Fixtures: `test/workers.test.ts`.
Deploying a worker on a PC: the `wfe_worker` profile of pj-clusterintent's
ansible_agdev, and the recipe `nctl/docs/add-a-wfe-worker.md` there.

## Configuration

`<area>/workers.json` on the coordinator:

```json
{ "default": "studio",
  "workers": {
    "studio": { "local": true, "label": "the coordinator's host" },
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

## The queue and the slots

- A worker claims only jobs of runs assigned to it, oldest first, when *its*
  slot is free. Jobs of other workers are left as they are: neither taken
  nor dropped.
- A job its worker cannot serve now waits with the reason in its note
  (`waiting for worker …`): a profile it does not offer, a session policy
  its harness cannot keep, a dispatch that could not be published. It is
  not dropped and not given to another worker. A run that is cancelled,
  held or already open still has its job dropped, as before.
- One open attempt per run (the record) and per worker (the store).
- A claim may carry the worker's receipt: the same receipt again gets the
  same answer (a lost answer is not a second attempt).

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
| `run.json` | the authority: every operation writes it, under the run's lock | a snapshot brought back after each command; never written there, never uploaded |
| Run folder documents | uploaded before each forwarded command and at the end | written by the agent |
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

## Contact lost, restarts

- A worker whose last heartbeat is older than 45 s is `unavailable` in the
  views: contact is lost. Its open attempt stays open and assigned; nothing
  is ended, rerun or moved because of the silence.
- A worker that cannot reach the coordinator claims nothing. Its running
  attempt goes on; its reports are retried. Its agent's forwarded commands
  fail with the reason.
- The worker keeps its bookkeeping in `<worker area>/.local/worker/state.json`
  (attempt, copy, log offset, process id). The executor's launch gate writes
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
