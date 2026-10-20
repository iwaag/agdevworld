# agdevworld Development Guide

agdevworld is the agdev site. Since retire_old_ui p1 (2026-10-20):

- **Home is the agdev dashboard**, the workflow editor's UI
  (`workflow_editor/`), served by its service under `/wfe/`. It holds the
  projects, runs, execution nodes, Context, Usage and User nodes.
- **The Front Desk** (`/?view=frontdesk[&conv=<id>]`) is the one screen this
  site's own bundle (`src/`) still serves, beside the **Arguing Room**
  (`/?view=argue`, argue history). The desk reads and posts WFE
  conversations. Its settings, contexts and progress panels read the
  `agentroom/` relay.
- **The relay** (`agentroom/`) serves those panels, the Arguing Room, and
  what the Usage view reads from this host's harness logins and the pre-WFE
  records.

The world views (nodes, workspaces, agent room, operation room, routines),
the operation room dashboard, its graph page and the cost gauge page are
retired, together with their relay routes and the cluster snapshot
publication. Their earlier documentation is in this file's history and in
the episodes (`agent_room`, `operation_room`, `refine_routine`,
`gauge_panel`, `retire_old_ui`).

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

- `npm run dev` — vite with HMR on :5173 (the Front Desk bundle).
- `npm run build` — `tsc && vite build`. The bundle's check; the Docker build runs it too.
- `npm run editor:install` then `npm run check` — the bundle build plus the workflow editor package's own check (`workflow_editor/`: tsc, `node --test`, vite build). The package keeps its own lockfile; the Docker image does not include it.
- `scripts/wfe-release.sh deploy <area>` — build, check and install the workflow editor service and its `wfe` launcher from an agdevworld commit (see "The workflow editor").
- `docker compose up --build -d web` — nginx on :8090 (static site) and :8093 (static site + `/wfe/`). Rebuild after a bundle or `nginx.conf` change.
- `curl -I http://localhost:8093/` — `302` to `/wfe/` (Home); `/?view=frontdesk` answers `200`.
- `OPSROOM_ZULIP_ENV=<the mirror bot's .env> AGENTROOM_CHAT_ZULIP_ENV=<the Developer's .env> agentroom/service/serve.sh` — the relay on :8094.
- `agentroom/service/serve.sh check` — one read, counts printed, no listener. Tells a credentials problem from a UI one.
- `cd agentroom && uv run pytest -q` — the relay's tests.
- `cd agentroom && uv run agentroom-settings sync` — fetch the settings repository (`.local/settings.toml`, from `settings.example.toml`) and make its ref the active revision; `status` reads it back. No restart or rebuild follows a content update.

## Files

- `src/main.ts` — URL entry: the Front Desk or the Arguing Room; any other address goes Home.
- `src/frontDesk.ts` / `src/scenes/FrontDeskScene.ts` — the two rooms on one Phaser scene: the Front Desk (`/?view=frontdesk`, one WFE conversation with Front) and the Arguing Room (`/?view=argue`, one `#argue` › `argue-<stem>` discussion, history only). `src/roomState.ts` is what differs between them — the adapter (list, open, post, close) — and the relay's shared `presentation` types; `src/roomDemo.ts` a `&demo=1` adapter for either room that never touches a backend; `src/frontDeskPlayback.ts` the agent-posts-as-turns model and cursor; `src/frontDeskSettings.ts` which settings revision draws what; `src/frontDeskInput.ts` the hidden IME textarea, `src/textLayout.ts` the grapheme-safe wrap and pagination.
- `src/frontDeskClosePanel.ts`, `src/completionState.ts` — closing a conversation (WFE) or an argue (the relay's door), drawn from one plan model.
- `src/contextPanel.ts`, `src/contextState.ts` — the shared contexts beside the composer (relay `/contexts`).
- `src/progressPanel.ts`, `src/progressState.ts` — the progress panel (relay `/progress`).
- `src/settingsState.ts` — the settings repository as the relay serves it (`/settings`, `/settings/<revision>`): characters, lore, revision-addressed portraits and backgrounds.
- `src/postMeaning.ts` — what a post is for, as the relay says it.
- `src/endpoints.ts` — the relay's and the agdev origin's URLs, from the host the page was opened under.
- `nginx.conf` — the two listeners and the entrance rule (below).
- `workflow_editor/` — the workflow editor (agdev dashboard, Project Editor, runs, Usage, `wfe`): a system component with its own package (see "The workflow editor").
- `scripts/wfe-release.sh` — builds and installs the workflow editor's service and launcher.

## The entrance (retire_old_ui p1)

- nginx answers a bare `/` with a redirect Home: on `:8093` to `/wfe/`
  (relative), and on `:8090`, which has no `/wfe/` route, to the same host's
  `:8093/wfe/`.
- `/` with a query is the static site as before, so Front Desk conversation
  links (Slack posts `<origin>/?view=frontdesk&conv=<id>`) open the desk.
- The bundle sends any address that is not a room Home
  (`location.replace`), so an old world-view address lands on the dashboard
  rather than on a retired screen.
- The Front Desk links "Home ↗". The dashboard links Usage and
  "Front Desk ↗": under `/wfe/` that is `/?view=frontdesk`, and from the
  service's own port it is the same host's `:8093`.

## The relay

`agentroom/` is a stdlib HTTP relay on `:8094`, every interface. Its own
`README.md` is the reference. It reads the realm through one mirror on its
own credential and writes only to close an argue, with the Developer's
credential. It is a separate process, supervised by the local launchd
deployment (`com.agdev.agentroom`). Its address defaults to port 8094 on the
host the page was opened from (`src/endpoints.ts`); set
`VITE_AGENTROOM_URL` at build time to point elsewhere. When it is
unavailable, the Front Desk's panels say so and the conversation itself (WFE)
is unaffected.

## Usage (retire_old_ui p1)

The dashboard's Usage card and `#/usage` view replace the cost gauge page
(`workflow_editor/docs/usage.md`).

- The executions' usage is read by the workflow editor service from the exec
  store and each attempt's log on the coordinator.
- The subscription windows come from the relay's `/budget`, which reads this
  host's harness logins through their CLIs.
- The pre-WFE agents' `ag.agent-run.v1` records come from the relay's
  `/cost`, shown as history.
- The browser reads all three on the dashboard's origin
  (`/wfe/api/usage…`).

## The Front Desk

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
  `/wfe/` to it with the request's own `Host` (`nginx.conf`); a bare `/` is
  redirected there (Home). `:8090` has no `/wfe/` route.
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
