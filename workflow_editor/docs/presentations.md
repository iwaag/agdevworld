# Presentations: results a person reviews (p7)

A **presentation** is one frozen revision of a run's result, served so that a
person can open it with one click, beside an explanation of what changed and
what to check, and answer in the run's existing conversation. It is a record
of the run ([runs.md](runs.md)) plus a local serving instance that this host
manages. A presentation is not a node type: the step that prepares one is an
ordinary `do` node whose appearance marks it as presentation
([contract.md](contract.md), *Appearance*), and the step that shuts it down is
another `do` node (cleanup).

Cloud storage, resource discovery, credential distribution and general
service orchestration are not part of p7: the only serving kind is a local
HTTP server for a bundle of files.

## Where things live

| Fact | Authority |
| --- | --- |
| The presented files, frozen | `devdocs/runs/<wf>/<run>/presentations/<p>/` (`content/…`, `review.md`, `manifest.json`) — written once by the file layer, published with the run |
| The presentation's identity, revision, review document, originating node, lifecycle facts | `run.json` → `presentations.<p>` and the history entries that changed it |
| The question that asked about it and the decision bound to it | `run.json` → `questions.<q>.presentation`, `decisions[].confirmation.presentation` |
| Serving instances: process, port, bind address, owner token, start signature, log | `<area>/.local/present/present.sqlite` (this host; ignored) |
| Where a presentation is served and where people answer | `<area>/present.json` (this host; ignored), resolved at read time |

Tracked files never contain a host name, port, process id, token or absolute
path. A run records a **logical serving reference** — the instance id — and
every view or message resolves the URL from this host's state when it renders.

## Identity and revision

- Presentation ids are `p1`, `p2`, … per run, in registration order
  (`^p[0-9]{1,6}$`).
- The **revision** of a presentation is the digest of its manifest:
  `sha256:` + hex SHA-256 of the canonical JSON of `{entry, review, files:
  [{path, sha256, bytes}] sorted by path, kind: "ag.wfe-presentation.v1"}`.
  Paths are relative to the presentation folder.
- A presentation never changes. Showing a changed result is a new
  registration: a new id, a new revision, a new confirmation subject. Later
  edits of the workspace (`game/`, …) do not reach a registered bundle,
  because the bundle is a copy.
- `register` is made by the executing attempt (fenced by `WFE_ATTEMPT`, like
  `complete`) from a **running** node. The file layer, not the caller,
  copies the source directory and computes the manifest: regular files only
  (no symbolic links, no `.git`, no dot-files), bounded in count (2000) and
  total size (200 MiB), every path normalized and inside the source. The
  review document is required, Markdown, at most 64 KiB.

### Review content

`review.md` is what the person reads beside the result. Its contract is
prose, not parsed: it says what changed in this run, how to use the result
(for a game: how to start and the controls), and what the person should
check. The review screen renders it with a safe Markdown subset: headings,
paragraphs, lists, emphasis, inline code, code blocks and links whose scheme
is `http`, `https` or a relative path inside the presentation. Raw HTML is
shown as text.

## The review screen

The serving instance answers on one origin of its own (never the editor's
origin, so a presented program cannot call the editor's API with the
person's same-origin rights):

| Path | Content |
| --- | --- |
| `/` | the review screen: the result (`/content/<entry>`, in a frame) and the explanation panel (rendered `review.md`), the presentation's title, id and revision, and where to answer |
| `/content/<path>` | a manifest file, byte for byte; anything else is 404 |
| `/.wfe-present/identity` | `{instance, presentation, revision, run}` — no secret |
| `/.wfe-present/shutdown` | `POST`, with the owner token in `x-wfe-present-token`; anything else is refused |

Nothing outside the presentation folder is served: not the workspace, the
run's other files (not even `manifest.json` or the raw `review.md`), the
area's configuration or the store. The review screen is served with a
script-free policy (`default-src 'none'`, frames from itself only, not
framable); `content/` keeps the result's own scripts and may only be framed
by the review screen. At start the server checks every manifest hash and
refuses to start on a mismatch.

Files under `content/` are served with byte ranges (`Accept-Ranges: bytes`;
one range is answered `206` with `Content-Range`, an unsatisfiable one `416`,
several ranges with the whole file). Safari plays audio and video only from
ranges; without them a review video showed a struck-out play button there
while Chromium played it (project_migration p1).

The explanation panel names where the answer belongs: the run's request
topic when the run came from Zulip, otherwise the run view in agdevworld
(`present.json` → `answerBase`). There is no other decision endpoint;
feedback and acceptance stay in the conversation the run already has.

## Lifecycle

`presentations.<p>.state`, changed only by history entries:

| State | Meaning | Entered by |
| --- | --- | --- |
| `registered` | the bundle is frozen; nothing serves it | `presentation.register` (executor) |
| `available` | an owned instance answered its identity and served `/` and the entry, observed at `observed` | `presentation.observe available` (this host, after the check) |
| `stopped` | verified not served: the owned instance is gone (stopped by request, or found gone) and its port no longer answers with its identity | `presentation.observe stopped` |
| `failed` | the last start did not become available (start-up refused, port, hash mismatch); retryable | `presentation.observe failed` |
| `stop-failed` | a stop was asked for and could not be verified; retryable; the instance may still serve | `presentation.observe stop-failed` |

A presentation is **open** while its state is `available` or `stop-failed`:
something may still be serving it. Observations are host facts with their
own operation (`presentation.observe`, `via: present`); they are not
execution reports and are not fenced by an attempt. After a run's
cancellation only `stopped` and `stop-failed` are recorded.

What a record says (`available`) and what this host observes now (the
process lives, with the recorded start signature, and answers with its
identity) are shown side by side. A record that says `available` while the
observation says gone is shown as **not live** with the recovery actions,
never as a working link.

## Serving instances on this host

`wfe present start|status|stop|reconcile` (and the same operations over HTTP)
manage instances in `present.sqlite`:

- **Ownership.** An instance belongs to one run and one presentation of one
  workspace. Its identity is the instance id (`pi-…`), a random owner token
  (in a 0600 file under `.local/present/`), the process id **and** its start
  signature (`ps -o lstart= -p`, recorded when it answered first). A bare
  PID or port is never enough to stop anything.
- **Lifetime.** The instance is started in a session of its own
  (`setsid`), outside the process group of whatever asked for it. The
  executor ends an attempt by signalling the attempt's process group; that
  does not reach the instance. A human wait, the agent's normal exit, a
  stopped (held) run and a restart of the editor service or the executor
  leave it serving.
- **Start.** One start per presentation at a time: a second `start` returns
  the existing instance when it is observed serving, reports `starting` while
  another start is in progress (recoverable: ask again), and replaces only an
  instance that is observed gone. A port is chosen from `present.json` →
  `ports` (default 8300–8399) and bound on `bind` (default `0.0.0.0`).
  The presentation becomes `available` only after `/.wfe-present/identity`
  returned this instance and `/` and the entry returned 200.
- **Stop.** Targets the owned instance only: the shutdown request with its
  token; then, if the process is still there and both its start signature
  and its command line (which names the instance) match, `SIGTERM`, then
  `SIGKILL`. Stop is verified when the process is gone and the port no
  longer answers with the instance's identity; only then is `stopped`
  recorded. A stop of an instance already gone records `stopped` (found
  gone). Stopping twice is harmless. An unverifiable stop records
  `stop-failed` and stays retryable.
- **Restart of the host or the service.** Nothing is restarted by itself.
  `status` observes every instance; `reconcile` marks instances whose
  process is gone as such in the host store and lists open presentations
  that are not served. The person (or the executing agent) chooses: `start`
  again (a new instance of the same revision), or `stop` (which then records
  `stopped`, found gone).

## Pausing, cancelling, completing

| Situation | Presentation |
| --- | --- |
| A question waits for the person (no process runs) | stays served |
| `run.stop` — the run is held, resumable | stays served: a paused review keeps its presentation |
| `run.cancel` — final | the cancellation is recorded first; then every open presentation of the run is stopped through the cancellation's own cleanup path (`ExecStore.cancel` → `Presenter.stop(…, 'all')`), whatever successors the graph has. Failures are recorded as `stop-failed`, shown beside the cancellation, and retried with `wfe present stop <run> --all`; the run stays `cancelled` |
| Result accepted, cleanup not done | the run view and messages say **accepted; cleanup pending** |
| Execution completion | refused while a presentation is open (`presentation-open`): the last completion — the final report under the default policy — waits until shutdown is verified |

The cleanup node of a workflow stops the run's presentations and completes
with the verified outcome. A failed stop leaves the node running or failed
(the agent's choice) and the run incomplete; retrying the stop never asks
the person to accept the result again, because the decision is already
recorded and bound to the presented revision.

## Confirmation bound to a presentation

The result-confirmation question (`confirms: result`, [runs.md](runs.md))
may present a presentation instead of loose files: `wfe run ask <run>
<node> --presentation <p> …`. The file layer checks the presentation's
files on disk against its manifest and records them as the question's
`subject` (their run-folder paths, hashes and sizes) together with
`presentation: {id, revision}`. Asking about a presentation requires its
state `available`.

The decision from that question (`wfe run decide … --question <q>`) is
refused when:

- a later question was asked from the confirming node (existing rule);
- a later presentation was registered after the question
  (`presentation-superseded`): an answer about `p1` never accepts `p2`;
- a presented file changed since (`subject-changed`).

The decision records the presentation and revision it accepted. A stopped
presentation keeps its record, files and decisions; the link is gone, the
evidence is not.

## Notifications

| Event | When | Destinations |
| --- | --- | --- |
| `presented` (critical) | `presentation.observe available` | run topic and request topic: title, the review link with where it opens ("on this host" for a loopback address), what to check |
| `cleanup-failed` (critical) | `presentation.observe stop-failed` | run topic and request topic |
| `decided` | as before; adds "cleanup pending" while a presentation is open | as before |

The link is resolved from this host's state when the message is rendered and
frozen with the delivery, like every message.

## Configuration: `<area>/present.json`

```json
{ "bind": "0.0.0.0", "publicBase": "http://<host name>", "ports": [8300, 8399], "answerBase": "http://<host name>:8093/wfe/" }
```

- `bind`: the address instances listen on (default `0.0.0.0`, every
  interface, so the LAN reaches them). A loopback address keeps them on this
  host; then links are described as opening on this host, never as remote.
- `publicBase`: when instances are bound to a reachable address, the base
  URL people use (the port is appended). `null` uses
  `http://127.0.0.1:<port>/`.
- `answerBase`: the agdevworld editor route, for the run view link in the
  explanation panel of runs without a request topic.

A missing file means `bind` `0.0.0.0`, `publicBase` and `answerBase` null.
