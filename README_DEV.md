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
- `cd agentroom && uv run agentroom-settings sync` — fetch the settings repository (`.local/settings.toml`, from `settings.example.toml`) and make its ref the active revision; `status` reads it back. No restart or rebuild follows a content update.

## Files

- `src/main.ts` — URL entry; dashboard by default, lazily loaded world views.
- `src/worldViews.ts` — Phaser scene wiring, the legacy chat overlay and detail path.
- `src/operationDashboard.ts` — dashboard selection and refresh controller.
- `src/sessionGraph.ts` — bounded conversation graph and node evidence.
- `src/scenes/PanelGridScene.ts` — one config-driven grid scene, shared by all six world views.
- `src/views.ts` — the six view configs (`nodes`, `workspaces`, `autolab`, `agentroom`, `ops`, `routines`).
- `src/agentRoomState.ts` — the agent room's two reads, through the `agentroom` relay.
- `src/opsState.ts` — the operation room's one read, `/ops` on the same relay.
- `src/viewSwitcher.ts` — the single seam for changing the visible view.
- `src/frontDesk.ts` / `src/scenes/FrontDeskScene.ts` — the Front Desk (`/?view=frontdesk`), a graphic-novel scene for one `#front` › `front-desk-<id>` conversation with Front; `src/frontDeskInput.ts` is its hidden IME textarea, `src/textLayout.ts` the grapheme-safe wrap and pagination, `src/frontDeskState.ts` its relay reads/writes and a `&demo=1` source that never touches the realm (`&demorev=<sha>` makes the demo's scenes claim a settings revision), `src/frontDeskPlayback.ts` the replies-as-turns model and cursor, `src/frontDeskSettings.ts` which settings revision draws what.
- `src/settingsState.ts` — the settings repository as the relay serves it (`/settings`, `/settings/<revision>`): characters, lore, revision-addressed portraits and backgrounds.
- `src/chatPanel.ts` — one routine fire topic and the existing `POST /chat` door; dashboard mode receives shared detail payloads, while world mode owns its selected-topic refresh.
- `src/detailPopup.ts` — the detail overlay, incl. the per-iteration `summary` button.
- `src/clusterState.ts` / `src/autolabState.ts` — snapshot and gateway reads for the panels.
- `scripts/fetch-cluster-state.mjs` — snapshot refresh through cagent. The one piece of JavaScript outside `src/`; it is a developer command, not part of the service.
- `public/cluster/*.json` — live snapshots, git-ignored; `public/*.sample.json` is the fallback. The Docker build copies whatever is in `public/` at build time, so move a live snapshot out first if a sample-only image is wanted.

## The agent room

`agentroom/` is a stdlib HTTP relay (cagent's *window* shape: unauthenticated,
`GET` only, loopback) that reads Zulip live and answers three routes —
`/healthz`, `/agents`, `/work`. Its own `README.md` is the reference.

The view is the fourth entry in the `nodes → workspaces → autolab →
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

Project starts (Gitea → Zulip) were also served here; they are agautolab-side
only from now on (`agautolab/init_project.py`).

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

## The retired `tasks / plane` view (`refactor` p3)

There were seven views; there are six. The `tasks` view listed Backlog and
Ready Plane issues and dispatched a Ready one to an autolab node's `/window`
as a mission carrying the issue id.

It is deleted, along with `src/planeState.ts`. Two independent reasons, and
the second is the one worth remembering: Plane is being retired, **and the
screen had had no backend since `modernize_agdevworld` p1** — every route it
called (`/api/plane/*`, `/api/autolab/<node>/window`) went through the
assistant gateway that phase deleted, and nginx serves static files only. A
view whose every action could only fail is not a feature waiting for a
backend; it is a promise the application cannot keep. Existing agent and
operation room views are how work is inspected, and no replacement dashboard
was built.

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

`/?view=ops` opens the retained stalled-first Ops board. The existing six-view
cycle remains available at `/?view=nodes`, and any existing view key may be
selected directly. The older Phaser `routines` view is retained as a compact
board with its existing detail popup; the dashboard is the primary routine
workflow. Each world view links back to the dashboard. No eighth scene is added.
`/?parts=graph` remains the standalone snapshot/explicit-refresh graph workbench.

## Front Desk (`front_desk` p1)

`/?view=frontdesk` is its own Phaser game rather than an eighth
`PanelGridScene` view: the background fills the frame, Front's portrait
stands in the lower left, the latest reply is the dialogue beside it, a prompt
bar runs along the bottom and the history is a panel that can be shown or
hidden. Everything visible is Phaser; the one DOM element is a hidden
textarea under the bar, because a canvas cannot host an IME. The conversation
is `#front` › `front-desk-<id>` (`?conv=<id>`; a new id is minted when none
is given), which Front's existing `front-` sweep serves.

Three things learned by looking rather than by design:

- **Phaser's word wrap splits UTF-16 units.** A Japanese sentence is one
  "word" to it and an emoji is two units, so `textLayout.ts` wraps with
  `Intl.Segmenter` (words, then graphemes) and hands Phaser explicit lines.
- **The Enter that confirms a composition is decided by the event**, not by a
  flag of our own: `isComposing` / keyCode 229. A CDP probe that never sent
  `compositionend` showed the flag version would have blocked sending forever.
- **`?demo=1`** answers from a script in the Front Desk voice so the frame can
  be checked without buying a run or needing the relay.

`.local/deskshot.mjs` (ignored) is the CDP driver that types, presses keys,
sets an IME composition, wheels and screenshots it.

### Scenes and portraits (`front_desk` p2)

A reply from Front is turns: one turn when it is a plain reply, the turns
of its `dialogue` when agfront wrote one (see `agentroom/README.md` ›
`/frontdesk`). Front speaks from the lower left; any other character from a
portrait and box in the upper left, the one not speaking dimmed with its
last line. ▶/◀, a click on a box or the wheel step through pages, then
turns, then replies; a reply that arrives while an earlier one is being read
queues behind it with a `▶ n new replies waiting` chip, and a reader who had
finished the newest reply is taken to the next one as it lands. History rows
are portrait, name (nickname) and text per turn, a user icon for the
Developer, a common icon for a speaker the settings do not know, acks as
receipt lines, source citations and link chips kept.

Faces, names and the background come from the settings revision: the active
one for new content (`settings ⟳` re-reads it), and for a scene the revision
it was written for, fetched by id and never swapped under the reader. A
revision the relay no longer retains, or an image that fails to load, is
said in the settings line and drawn with the current settings or the
bundled fallback. Below 720px the frame stacks (collaborator, portrait,
Front's box) and the history takes the whole width.

### Settings repository (`front_desk` p2)

Characters and rooms are content, not code: a Git repository
(`settings.example.toml` names `iwaag/agdevworld-settings`) with a
`manifest.toml` — display names, lore, portrait and background paths, and
which agents speak as which character. `agentroom-settings sync` fetches it,
checks the manifest and every file it names, and switches the active
revision; every synced revision is kept under `.local/settings/revisions/`
so a saved dialogue can still be drawn with the faces it was written for,
and `.local/settings/current/` is the active one for agents that read lore
as files. The relay serves it under `/settings` with the revision in every
asset URL, so a replaced image never survives in a browser cache. Adding a
character is a manifest entry and its files in that repository; the frontend
is not rebuilt and the relay is not restarted. `agentroom/README.md` has the
routes and the failure behaviour.

### Two windows (`operation_room` p8)

The dashboard holds no state of its own — every pane is the relay's memory
re-read every 5 s (`/inflight` every 15 s) — so a second window follows the
first without any wiring: instructions in one window on `/`, a monitoring
window on `/?routine=<name>` beside it or on another display, the cost gauge
in a third. Measured on the real system: the relay reflects a Zulip change
before the HTTP reply reaches the browser that made it, and another window
shows it on its next tick (1.6–3.7 s observed, 5 s worst case). A second
window is 40 loopback requests a minute and zero Zulip calls.

What is *not* shared, on purpose: the routine and session selection, the
pending-fire card, and the display preferences until a reload (they live in
`localStorage`, one copy per browser profile). Two things to know before
leaving a monitoring window open:

- Tick **Show resolved** in it. Under the default a ✔ removes the run being
  watched from the list and says so; with it on, the chip turns `✔ resolved`.
- The Phaser views (`?view=ops`, `?view=routines`) make no requests after
  load — they refresh on ⟳ only. A monitoring window is the dashboard.

And one thing about experiments on run topics: **✔ is free, un-✔ is not.**
Un-resolving a `#front` run topic more than 60 s after its ✔ makes Zulip post
a notification line into an unresolved topic, which Front serves as a paid
run. Resolve-only measurements, or undo inside Zulip's 60 s grace period.

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
