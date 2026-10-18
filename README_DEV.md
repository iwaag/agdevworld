# agdevworld Development Guide

agdevworld hosts no agent: the conversational entrance moved to the Front agent
in `pj-agdev/agfront`, which talks to the Developer in Zulip `#front` and
dispatches work to the other agents from there.

Since the `agent_room` episode it is no longer a *pure* frontend either. One
small service sits beside it, `agentroom/`, serving agent discovery, operation
state, routine history and the Developer chat door. The cluster views still
read static snapshots or their existing sample fallbacks.

## UI design policy: Simple and Detail

**Recommended across agdevworld:** provide Simple and Detail as two
complementary presentation modes. This is a design recommendation, not a
requirement to retrofit every screen or force the same layout everywhere.

- **Simple** presents only important information and frequently used
  operations. Make the purpose, current situation, and next action easy to
  recognize with prominent text, meaningful icons, and readable graphical
  objects. Keep routine technical metadata and infrequently used controls
  out of the default presentation. Important errors, unavailable information,
  and requests for human attention still belong here.
- **Detail** provides as much useful information and as many supported
  operations as practical, including technical metadata, evidence, history,
  settings, and precise inspection or adjustment controls. Organize this
  richer content so people can find what they need.

Prefer Simple as the initial view and an obvious one-click switch to Detail.
Both modes use the same underlying facts and operations; switching should
preserve drafts, selection, and reading context. Simple should visibly reduce
the information competing for attention, rather than merely show a long list
of collapsed detail sections.

The workflow editor's Simple/Detail implementation is an example of this
policy (see [its README](workflow_editor/README.md)); adapt the principle to
each agdevworld screen's purpose and usage.

## Commands

- `npm run dev` — vite with HMR on :5173.
- `npm run build` — `tsc && vite build`. The frontend's only check; the Docker build runs it too, so a successful image build is a compile check.
- `npm run editor:install` then `npm run check` — the frontend build plus the workflow editor package's own check (`workflow_editor/`: tsc, `node --test`, vite build). The package keeps its own lockfile; the Docker image does not include it.
- `scripts/wfe-release.sh deploy <area>` — build, check and install the workflow editor service and its `wfe` launcher from an agdevworld commit (see "The workflow editor").
- `docker compose up --build -d web` — production-style bundle behind nginx on :8090. Keep it current when a user may want to look.
- `docker compose ps web` / `curl -I http://localhost:8090/` — confirm it came up.
- `WFE_URL=<workflow-editor URL> npm run cluster:fetch` — read the latest completed cagent scan artifact into the three cluster snapshots and their provenance metadata. Include `/wfe/` in the URL when using the web proxy. This opens no agent request.
- `AGENTROOM_ZULIP_ENV=<a zulip .env> OPSROOM_ZULIP_ENV=<the opsroom bot's .env> agentroom/service/serve.sh` — the relay on :8094, serving both the agent room and the operation room. Without `OPSROOM_ZULIP_ENV` the relay still runs and `/ops` answers 503; the operation room then says so rather than showing an empty board.
- `node .local/opsshot.mjs http://localhost:5173/ .local/shots` — the ~70-line CDP screenshot driver (`OPSSHOT_STEPS` scripts the clicks). `--headless --screenshot` hangs on this app: `--virtual-time-budget` waits for the page to go idle and `PanelGridScene` tweens forever.
- `agentroom/service/serve.sh check` — one read, counts printed, no listener. Tells a credentials problem from a UI one.
- `cd agentroom && uv run pytest -q` — the relay's tests.
- `cd agentroom && uv run agentroom-settings sync` — fetch the settings repository (`.local/settings.toml`, from `settings.example.toml`) and make its ref the active revision; `status` reads it back. No restart or rebuild follows a content update.

## Files

- `src/main.ts` — URL entry; dashboard by default, lazily loaded world views.
- `src/worldViews.ts` — Phaser scene wiring, the legacy chat overlay and detail path.
- `src/operationDashboard.ts` — dashboard selection and refresh controller.
- `src/sessionGraph.ts` — bounded conversation graph and node evidence.
- `src/scenes/PanelGridScene.ts` — one config-driven grid scene, shared by all five world views.
- `src/views.ts` — the five view configs (`nodes`, `workspaces`, `agentroom`, `ops`, `routines`).
- `src/agentRoomState.ts` — the agent room's two reads, through the `agentroom` relay.
- `src/opsState.ts` — the operation room's one read, `/ops` on the same relay.
- `src/viewSwitcher.ts` — the single seam for changing the visible view.
- `src/frontDesk.ts` / `src/scenes/FrontDeskScene.ts` — the two rooms on one scene: the Front Desk (`/?view=frontdesk`, one `#front` › `front-desk-<id>` conversation with Front) and the Arguing Room (`/?view=argue`, one `#argue` › `argue-<stem>` discussion a human leads). `src/roomState.ts` is what differs between them — the adapter (list, open, post, ask for an interpretation, background) and the relay's shared `presentation` types; `src/roomDemo.ts` a `&demo=1` adapter for either room that never touches the realm (`&demorev=<sha>` makes its interpretations claim a settings revision); `src/frontDeskPlayback.ts` the agent-posts-as-turns model (dialogue or original view, which interpretation, the pending/failed fallback) and cursor; `src/frontDeskSettings.ts` which settings revision draws what and which room's background; `src/frontDeskInput.ts` the hidden IME textarea, `src/textLayout.ts` the grapheme-safe wrap and pagination.
- `src/settingsState.ts` — the settings repository as the relay serves it (`/settings`, `/settings/<revision>`): characters, lore, revision-addressed portraits and backgrounds.
- `src/chatPanel.ts` — one routine fire topic and the existing `POST /chat` door; dashboard mode receives shared detail payloads, while world mode owns its selected-topic refresh.
- `src/detailPopup.ts` — the detail overlay for a clicked card.
- `src/clusterState.ts` — snapshot reads for the cluster panels.
- `workflow_editor/` — the workflow editor (agdev dashboard, Project Editor, runs, `wfe`): a system component with its own package (see "The workflow editor").
- `scripts/wfe-release.sh` — builds and installs the workflow editor's service and launcher.
- `scripts/fetch-cluster-state.mjs` — snapshot refresh from a managed cagent scan artifact. The one piece of JavaScript outside `src/`; it is a developer command, not part of the service.
- `public/cluster/*.json` — live snapshots, git-ignored; `public/*.sample.json` is the fallback. The Docker build copies whatever is in `public/` at build time, so move a live snapshot out first if a sample-only image is wanted.

## The agent room

`agentroom/` is a stdlib HTTP relay (cagent's *window* shape: unauthenticated,
`GET` only, loopback) that reads Zulip live and answers three routes —
`/healthz`, `/agents`, `/work`. Its own `README.md` is the reference.

The view is the third entry in the `nodes → workspaces → agentroom` cycle,
and it has two modes:

- **agents** — one card per `intro-<instance>` topic of `#agents`: the
  instance, its own channel, the first line of its introduction, and a badge
  counting the open topics in that channel. Clicking one shows the whole
  introduction as posted, its open topics, and the earlier introductions.
- **open work** — one card per board: every live agent's own channel (and
  the `#front` topics its roster prefix claims), each with its open count. Clicking one opens
  the flat list of its unresolved topics, grouped by channel. The list is flat
  in the popup rather than on the grid because 94 cards in a four-column grid
  that scales to fit is unreadable — measured, in `agent_room` step 5.

Three things it deliberately does not do, all of them from the episode plan:

- **No snapshot file.** Unlike the cluster views there is no
  `public/*.json` behind it; the relay reads Zulip per request and caches for
  30 s in memory only.
- **No topic-name interpretation.** Open means the absence of Zulip's `✔ `
  prefix and nothing else. Topic prefixes are each agent's own vocabulary, and reading them here would make this view wrong
  the first time an agent changed one.
- **No harness, model or backend.** The introductions do not carry it and the
  view does not add it ("Agent ≠ Model").

`[selfnote]` posts and lines never reach the browser: the relay strips them,
so the view hides exactly what `agentchat read` hides.

The relay's address defaults to port 8094 on the host the page was opened
from (`src/endpoints.ts`), so a browser elsewhere on the LAN reaches it; set
`VITE_AGENTROOM_URL` at build time to point elsewhere. It is a separate
process, supervised by the local launchd deployment. When unavailable, the
relay-backed views say unknown; cluster snapshot views remain available.

## The operation room

The sixth view, and the only one that answers *"is anything stuck right
now?"*. It reads `GET /ops` on the same relay, which holds a running
reconstruction of the conversation layer from a Zulip event queue —
`agentroom/README.md` and `agentroom/src/agentroom/ops.py` are the reference.

Two modes: **owed replies**, one card per `(instance, channel, topic)` that is
`stalled` / `awaiting` / `acked` / `done` / `unknown` with stalled first; and
**agents**, one card per instance with the routing it declares in `#agents`.

Three rules, all of them findings from `operation_room` p1 rather than taste:

- **`unknown` is drawn as its own state, in amber, never in the grey this app
  uses for idle everywhere else.** A relay that cannot be read renders a card
  saying so, not an empty grid: p9's 26 silent minutes were indistinguishable
  from a quiet board, and that distinction is the whole reason this view
  exists.
- **Every row carries its provenance** — the relay writes both a sentence and
  a card-sized short form, and this view renders them without reading anything
  out of either. Every state on the board is inferred from a trace somebody
  left for another purpose; the evidence is the only defence against a
  confident wrong answer.
- **No state is decided here.** A second copy of the rules in the browser would
  drift from the relay's, which is precisely how p1 produced 66 stalled rows
  for conversations that had been answered.

The board is a list of what is *owed*, not of everything: a conversation
nobody is waiting on has no row. `done` is a transition the relay watches
happen, so it appears when a topic is resolved while the relay is up and is
gone after a restart.

## No backend for the rest

The embedded assistant service and everything that pointed at it — the
`assistant` compose service, the nginx `/api` proxy, the vite dev proxy,
`agents.toml`, and the runtime `.env` values — were removed in
`modernize_agdevworld` p1. Nothing serves `/api/*` now.

The consequences are deliberate and temporary:

- The **chat panel now uses `POST /chat` on the relay**, as the Developer
  in the selected routine fire topic. It does not use the removed assistant.
- The `workspaces` view falls back to its sample JSON where it read `/api/*`.
  The `nodes` view is unaffected — it reads the cagent snapshot from
  `public/`, which never went through the assistant. Every other screen that
  read `/api/*` has since been deleted rather than repaired.

Project starts (Gitea → Zulip) were also served here; managed projects are
registered through the workflow editor now (see "The workflow editor").

## The retired `tasks / plane` and `autolab / now` views

There were seven views; there are five. Both removals have the same shape and
the same lesson, one phase apart.

`tasks / plane` (`refactor` p3) listed Backlog and Ready Plane issues and
dispatched a Ready one to an autolab node's `/window` as a mission carrying
the issue id. It is deleted with `src/planeState.ts`.

`autolab / now` (`refactor` p3 ex1) had a `projects` tab and a `jobs` tab over
`/api/autolab/<node>/…`: a node picker, a mediator headline, per-job iteration
evidence, and a paid per-iteration `summary` button. It is deleted with
`src/autolabState.ts` and the popup's job and project renderers.

**Neither was a working feature being retired.** Every route both screens
called went through the assistant gateway `modernize_agdevworld` p1 deleted a
month earlier, and nginx serves static files only — so every action on them
had been failing silently, and the `autolab` view's own documentation admitted
it was reading sample data "until the route is restored". A view whose every
action can only fail is not a feature waiting for a backend; it is a promise
the application cannot keep.

Workflow runs are followed in the workflow editor (the agdev dashboard) and
in their Zulip notifications instead. No replacement dashboard was built.
The node-side gateway those screens called is retired as well.

### Progress panel (`progress_panel` p1)

The Front Desk's `▦ progress` toggle (`src/progressPanel.ts`, data and words
in `src/progressState.ts`) shows every request in flight in any Front
conversation: the open conversation pinned, then active requests, then
results of the last 24 h. It reads `GET /progress?current=<desk id>` every
8 s while open (60 s closed, for the toggle's `✋`/`■` badges); the board is
pyagag's `agag.progress` read of the relay's mirror, Observer's records and
the health checks of the owners that expose one (`agentroom/src/agentroom/progress.py`). Its open
state and expanded cards live in `localStorage`. It shares the right column
with the history panel (one closes the other); on a narrow screen its toggle
takes the button row's left end.

Drawing rules: every state has an icon and words beside its colour; a band
or segment moves only on a fresh health check (never on a conversation's
claim, never while the board is stale or the relay unreadable, never under
`prefers-reduced-motion`); a plan meter is one segment per task and shows no
number while planning; stages stay as chips until their records exist. When
the relay stops answering, the last board stays, marked with the time it was
read.

`?view=frontdesk&demo=1` scripts two requests over a minute
(`window.__progressDemo.at(seconds)`, `.fail(true)`); `window.__progress
.snapshot()` returns what the panel shows, for drivers.

## Cost gauge (`gauge_panel`)

`/?parts=gauge` is a separate page meant for its own window beside the
dashboard (the dashboard header links it with `target=_blank`). It draws the
relay's `/cost` — this host's `ag.agent-run.v1` records, never Zulip — and
polls it every 20 s. `src/costState.ts` is the read and the formatting rules,
`src/gaugePanel.ts` the page, `src/gaugePanel.css` its layout on top of
`operationParts.css`. Reported USD (claude_code) and estimated USD (a metered
key priced by `agentroom/prices.json`) are always two numbers; runs on a
subscription (codex on ChatGPT, Antigravity) or with no usage show a dash,
never `$0.00`, and each tile says how many runs its figure does not cover.
Harness hues are fixed slots from the dataviz palette validated against the
`#101c2b` surface; the same hue follows a harness everywhere on the page.

The dashboard owns one routine name and one fire message ID. Routine selection
updates every pane. Session selection updates the graph and highlights that
fire's message-ID span in chat; sending still targets the routine fire topic,
never a historical run or a child conversation. Draft text and selection survive
refresh. Manual activity has no identified scheduled session span.

Every five seconds the browser reads `/routines`, `/ops` health and the selected
`/routines/<name>` from the existing event-queue reconstruction. These reads
make no additional Zulip calls. Eight-second read timeouts and generation guards
bound failures and reject late selections. `/inflight/<name>` scans host
directories every fifteen seconds for the selected routine's latest session;
historical session display suspends it. Counts and expandable per-topic reasons
identify the host evidence separately. Leaving the page stops the refresh loop.

Health remains on screen. Unavailable/stale relay evidence masks current states
as unknown and disables the composer; cached history is labelled last known.
The standing request, schedule next/overdue evidence, time since fire and
Ack overdue annotation are visible without adding a state or execution timer.
Node states are current topic observations, not historical session outcomes.

The relay reports session `truncation` metadata: `truncated`, `reasons`,
`max_nodes` (40), and `max_depth` (4). Actual omitted eligible links trigger the
marker; reaching a cap exactly, cycles, and out-of-window links do not. Missing
metadata from an older relay means unknown completeness. An untruncated tree
may still contain unread topics, whose states remain unknown. Branches occupy
separate vertical bands with wrapped, inspectable names; scrolling keeps every
returned card readable. Below desktop width panes reorganize, then stack on
phones. There are no progress percentages, pipeline stages or predicted steps.

Validation: `npm run build`, `cd agentroom && uv run pytest -q`, and CDP visual
checks using the ignored `.local/opsshot.mjs` driver. Synthetic truncation,
health and send tests intercept browser fetch; unit tests mock Zulip. Real chat
verification is deliberate and at most one round trip, never automated posting.
Rebuild the web image after frontend changes and kickstart the local relay job
after relay code changes; verify event-queue health returns to live.

## The workflow editor (`workflow_editor` p4/ex1)

`workflow_editor/` is the agdev dashboard, the Project Editor, the run views
and the `wfe` command line. It is agdevworld system code: developed here, built
and installed by `scripts/wfe-release.sh`, never a project of the catalog it
manages. Its own README (`workflow_editor/README.md`) covers the package; its
history before p4/ex1 is the frozen `pj-agdev/experiments/workflow_editor` and
the retired Gitea repository `developer/pj-workflow-editor` (`9c29117`, the
imported commit).

- **Separate process, shared ownership.** The editor service is a Node process
  on the host (`:8098`, every interface), because it works on host
  workspaces. nginx's `:8093` (every interface) serves this site and routes
  `/wfe/` to it with the request's own `Host` (`nginx.conf`);
  the operation room links "agdev dashboard ↗" there and the dashboard links
  "← agdevworld" back. The write API is never put on the LAN-facing `:8090`.
- **Operating area** (`pj-agdev/.local/agdev/`, ignored): `registry.json` (the
  catalog: projects, repositories, workspaces), `gitea.json`, `system.json`
  (the boundary below), the workspaces `pj-<id>/`, `.local/exec/` (autolab's
  queue and attempts), and the installed system code: `service/releases/<agdevworld
  commit>/`, `service/current`, `bin/wfe`.
- **Releases.** `scripts/wfe-release.sh build <area> [<commit>]` archives
  `workflow_editor/` at that agdevworld commit into `service/releases/<commit>/`,
  runs `npm ci && npm run check` there and writes `RELEASE.json`. `activate`
  refuses while an execution attempt is open, switches `service/current`
  (which both the launchd service and `bin/wfe` run, so they move together),
  rewrites `bin/wfe`, restarts `com.agdev.wfe-service` and requires the service
  (`GET /wfe/api/version`) and the launcher (`wfe version`) to report the
  commit. A healthy activation then refreshes the area's authoring entry,
  `authoring/AGENTS.md` and `CLAUDE.md` (`wfe setup <area> --installed-url`,
  workflow_editor p13), beside the workspaces and never above them, so no
  executing agent's harness loads it. A failed health check reports the
  selected release and exits with an error; it does not restore an older version. `deploy` = build + activate;
  `status` reports the current release, service, launcher and open attempts.
- **Operating boundary.** The editor never registers, creates, requests,
  claims or opens a workspace on system code, releases or control data, and
  never takes up a retired repository (`workflow_editor/server/boundary.ts`,
  its README). Implicit: the running package and the area's control data.
  Configured in the area's `system.json`: agdevworld, agautolab, the frozen
  experiment and the Gitea credentials folder are protected, and
  `developer/pj-workflow-editor` (Gitea id 132) is retired. Edit that file,
  not a project, to change the boundary. `wfe project unregister <id>` is the
  supported way to take a project out of the catalog.
- **launchd.** `pj-agdev/devenv/launchd/com.agdev.wfe-service.plist.in` runs
  `service/current/server/main.ts` with the area's registry; the executor
  (`com.agdev.agautolab-wfexec`) uses `bin/wfe` through
  `agautolab/.local/wfexec.toml`. A new release needs only `activate`; neither
  plist changes.
- **Tests outside the package.** `agautolab/tests/test_wfexec.py` runs the
  executor against `WFE_PACKAGE` (default: this `workflow_editor/`; an
  installed release works too).

### Plans, reports and Zulip coordination (`workflow_editor` p5)

- Workflows are `ag.workflow.v2` and declare `documentation.policy`
  (`default` | `manual`). Under `default` a run gets a plan talk
  (`plan.md`, agreed with the person before any work), a report step per
  node (`report-<node>.md`) and a final report (`report.md`), compiled by
  `workflow_editor/shared/compile.ts` and frozen into the run; steps
  complete only on a checked, nonempty document. `manual` adds nothing.
- Zulip coordination: folder `wf-<project>`, channel
  `wf-<project>.<workflow>`, topic per run. The editor decides what is owed
  (`server/notify.ts`, `wfe notify`); autolab's `agautolab.wfnotify` posts,
  on a thread of the executor. Configuration is `<area>/zulip.json`
  (no credentials). Answers are recorded in agdevworld, never from Zulip.
  Contract: `workflow_editor/docs/runs.md`.

## Cluster snapshot publication

`cluster:fetch` reads WFE's live run/file API (`CAGENT_WORKSPACE`, default
`cagent`). It selects the newest scan by creation time and refuses an
unfinished/failed run or missing/invalid artifact instead of falling back to
an older successful run. Existing files remain on fetch/validation failure;
the command exits nonzero. A scan with partial host observation may publish
valid source envelopes; `snapshot.json` retains `complete: false`, per-host
outcomes and source times, and the cluster views display the scan's age and
partial state. It does not imply every host was just observed.

The outputs remain ignored under `public/cluster/`. `CLUSTER_STATE_OUTPUT`,
`CLUSTER_WORKSPACES_OUTPUT`, `CLUSTER_ACTUAL_OUTPUT` and
`CLUSTER_METADATA_OUTPUT` override individual paths. Refresh before building
the static web image. Metadata older than 24 hours is labelled stale in the
view. No cagent HTTP credentials, prose URL extraction or upload is used.

Check the importer with `node --test scripts/fetch-cluster-state.test.mjs`.
