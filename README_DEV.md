# agdevworld Development Guide

agdevworld hosts no agent: the conversational entrance moved to the Front agent
in `pj-agdev/agfront`, which talks to the Developer in Zulip `#front` and
dispatches work to the other agents from there.

Since the `agent_room` episode it is no longer a *pure* frontend either. One
small service sits beside it, `agentroom/`, serving agent discovery, operation
state, routine history and the Developer chat door. The cluster views still
read static snapshots or their existing sample fallbacks.

## Commands

- `npm run dev` — vite with HMR on :5173.
- `npm run build` — `tsc && vite build`. The frontend's only check; the Docker build runs it too, so a successful image build is a compile check.
- `docker compose up --build -d web` — production-style bundle behind nginx on :8090. Keep it current when a user may want to look.
- `docker compose ps web` / `curl -I http://localhost:8090/` — confirm it came up.
- `CAGENT_URL=https://localhost:8789 npm run cluster:fetch` — refresh the three cluster snapshots through cagent.
- `AGENTROOM_ZULIP_ENV=<a zulip .env> OPSROOM_ZULIP_ENV=<the opsroom bot's .env> agentroom/service/serve.sh` — the relay on :8094, serving both the agent room and the operation room. Without `OPSROOM_ZULIP_ENV` the relay still runs and `/ops` answers 503; the operation room then says so rather than showing an empty board.
- `node .local/opsshot.mjs http://localhost:5173/ .local/shots` — the ~70-line CDP screenshot driver (`OPSSHOT_STEPS` scripts the clicks). `--headless --screenshot` hangs on this app: `--virtual-time-budget` waits for the page to go idle and `PanelGridScene` tweens forever.
- `agentroom/service/serve.sh check` — one read, counts printed, no listener. Tells a credentials problem from a UI one.
- `cd agentroom && uv run pytest -q` — the relay's tests.

## Files

- `src/main.ts` — URL entry; dashboard by default, lazily loaded world views.
- `src/worldViews.ts` — Phaser scene wiring, the legacy chat overlay and detail path.
- `src/operationDashboard.ts` — dashboard selection and refresh controller.
- `src/sessionGraph.ts` — bounded conversation graph and node evidence.
- `src/scenes/PanelGridScene.ts` — one config-driven grid scene, shared by all seven world views.
- `src/views.ts` — the seven view configs (`nodes`, `workspaces`, `autolab`, `tasks`, `agentroom`, `ops`, `routines`).
- `src/agentRoomState.ts` — the agent room's two reads, through the `agentroom` relay.
- `src/opsState.ts` — the operation room's one read, `/ops` on the same relay.
- `src/viewSwitcher.ts` — the single seam for changing the visible view.
- `src/chatPanel.ts` — one routine fire topic and the existing `POST /chat` door; dashboard mode receives shared detail payloads, while world mode owns its selected-topic refresh.
- `src/detailPopup.ts` — the detail overlay, incl. the per-iteration `summary` button.
- `src/clusterState.ts` / `src/autolabState.ts` / `src/planeState.ts` — snapshot, gateway, and Plane reads/actions for the panels.
- `scripts/fetch-cluster-state.mjs` — snapshot refresh through cagent. The one piece of JavaScript outside `src/`; it is a developer command, not part of the service.
- `public/cluster/*.json` — live snapshots, git-ignored; `public/*.sample.json` is the fallback. The Docker build copies whatever is in `public/` at build time, so move a live snapshot out first if a sample-only image is wanted.

## The agent room

`agentroom/` is a stdlib HTTP relay (cagent's *window* shape: unauthenticated,
`GET` only, loopback) that reads Zulip live and answers three routes —
`/healthz`, `/agents`, `/work`. Its own `README.md` is the reference.

The view is the fifth entry in the `nodes → workspaces → autolab → tasks →
agentroom` cycle, and it has two modes:

- **agents** — one card per `intro-<instance>` topic of `#agents`: the
  instance, its own channel, the first line of its introduction, and a badge
  counting the open topics in that channel. Clicking one shows the whole
  introduction as posted, its open topics, and the earlier introductions.
- **open work** — one card per board: every `pj-<slug>` project (its own
  channel plus the `work-<label>` channels filed in the same channel folder)
  and every agent's own channel, each with its open count. Clicking one opens
  the flat list of its unresolved topics, grouped by channel. The list is flat
  in the popup rather than on the grid because 94 cards in a four-column grid
  that scales to fit is unreadable — measured, in `agent_room` step 5.

Three things it deliberately does not do, all of them from the episode plan:

- **No snapshot file.** Unlike the cluster views there is no
  `public/*.json` behind it; the relay reads Zulip per request and caches for
  30 s in memory only.
- **No topic-name interpretation.** Open means the absence of Zulip's `✔ `
  prefix and nothing else. `workplan-`/`assetplan-`/`workrun-` are each
  agent's own vocabulary, and reading them here would make this view wrong
  the first time an agent changed one.
- **No harness, model or backend.** The introductions do not carry it and the
  view does not add it ("Agent ≠ Model").

`[selfnote]` posts and lines never reach the browser: the relay strips them,
so the view hides exactly what `agentchat read` hides.

The relay's address defaults to `http://localhost:8094`; set
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
- The `workspaces`, `autolab` and `tasks` views fall back to their sample
  JSON where they read `/api/*`. The `nodes` view is unaffected — it reads
  the cagent snapshot from `public/`, which never went through the assistant.
- The **detail popup's profile note** ("Profile changes go through the
  assistant conversation") names a conversation that no longer exists here.
  It moves with the chat panel in the same later phase.

Project starts (Gitea → Plane → Zulip) were also served here; they are
agautolab-side only from now on (`agautolab/init_project.py`).

## Autolab project profiles

The autolab view fetches `/api/autolab/<node>/projects` alongside jobs and
status. Its `projects` and `jobs` tabs keep the two record types in separate
grids while sharing the selected node. Read-only project cards show the
effective `coding` and `director` profiles; clicking one opens its profile
detail and the common ask-agent action.

Changing a profile stays conversational — ask an agent in ordinary words.
There is deliberately no selector or direct settings-write route in
agdevworld. Which agent answers is being re-decided this episode; until the
route is restored, this view reads sample data.

## Plane task dispatch

The `tasks` view lists only Backlog and Ready issues from the configured Plane
project. Node chips come from the node list; their marker distinguishes
unreachable, reachable/idle, and busy nodes when `/status` is available.
Backlog is display-only. A Ready card has Execute and Cancel controls.

Execute first moves the issue to In Progress, then asks the selected node's
`/window` to start a mission containing the Plane issue ID, title, and full
description. A definite refusal returns the issue to Ready. A transport timeout
is deliberately left In Progress because the remote window can finish and
launch after the browser's connection has gone away; the UI reports that
ambiguous outcome instead of creating a Ready + running split. Cancel only
moves a not-yet-dispatched Ready issue to Cancelled.

This is the behaviour the view implements; it has no backend this phase.

## cagent convention (agcluster)

agdevworld sends only read-shaped requests to cagent — today that is the
snapshot fetch in `scripts/fetch-cluster-state.mjs`. Write-shaped prompts
(`desired apply`, `reconcile --yes`) are out of bounds. This is a
convention, not enforced: the human token cannot distinguish reads from
writes. Enforcement is deferred to the future system-wide auth (JWT)
episode — see `devdocs/episodes/zero_auth/` (the single pointer to that
vision).

## Operation room dashboard (p5)

`/` is the four-pane dashboard: routine list, latest three sessions above the
conversation graph, and the selected routine's fire conversation on the right.
`/?parts=shell` remains an alias. DOM scrolling, keyboard focus and selectable
source evidence make it the default entrance. Phaser is loaded only for a world
view, rather than being downloaded with the dashboard.

`/?view=ops` opens the retained stalled-first Ops board. The existing seven-view
cycle remains available at `/?view=nodes`, and any existing view key may be
selected directly. The older Phaser `routines` view is retained as a compact
board with its existing detail popup; the dashboard is the primary routine
workflow. Each world view links back to the dashboard. No eighth scene is added.
`/?parts=graph` remains the standalone snapshot/explicit-refresh graph workbench.

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
