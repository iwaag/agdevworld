# agdevworld Development Guide

agdevworld is a pure frontend. It hosts no agent: the conversational entrance
moved to the Front agent in `pj-agdev/agfront`, which talks to the Developer
in Zulip `#front` and dispatches work to the other agents from there.

## Commands

- `npm run dev` — vite with HMR on :5173.
- `npm run build` — `tsc && vite build`. The frontend's only check; the Docker build runs it too, so a successful image build is a compile check.
- `docker compose up --build -d web` — production-style bundle behind nginx on :8090. Keep it current when a user may want to look.
- `docker compose ps web` / `curl -I http://localhost:8090/` — confirm it came up.
- `CAGENT_URL=https://localhost:8789 npm run cluster:fetch` — refresh the three cluster snapshots through cagent.

## Files

- `src/main.ts` — wiring: scenes, the chat panel, the click-to-detail path.
- `src/scenes/PanelGridScene.ts` — one config-driven grid scene, shared by all four views.
- `src/views.ts` — the four view configs (`nodes`, `workspaces`, `autolab`, `tasks`).
- `src/viewSwitcher.ts` — the single seam for changing the visible view.
- `src/chatPanel.ts` — the chat overlay; it owns history and applies returned UI actions.
- `src/detailPopup.ts` — the detail overlay, incl. the per-iteration `summary` button.
- `src/clusterState.ts` / `src/autolabState.ts` / `src/planeState.ts` — snapshot, gateway, and Plane reads/actions for the panels.
- `scripts/fetch-cluster-state.mjs` — snapshot refresh through cagent. The one piece of JavaScript outside `src/`; it is a developer command, not part of the service.
- `public/cluster/*.json` — live snapshots, git-ignored; `public/*.sample.json` is the fallback. The Docker build copies whatever is in `public/` at build time, so move a live snapshot out first if a sample-only image is wanted.

## No backend this phase

The embedded assistant service and everything that pointed at it — the
`assistant` compose service, the nginx `/api` proxy, the vite dev proxy,
`agents.toml`, and the runtime `.env` values — were removed in
`modernize_agdevworld` p1. Nothing serves `/api/*` now.

The consequences are deliberate and temporary:

- The **chat panel still renders**. Its send path posts to `/api/chat` and
  fails; it becomes a thin wrapper over Zulip `#front` in a later phase, so
  it was left alone rather than rewritten twice.
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
