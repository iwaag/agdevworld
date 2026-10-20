# agdevworld Development Guide

agdevworld is the agdev site. Since workflow_editor p15 (2026-10-20):

- **Home is the agdev dashboard**, the workflow editor's UI
  (`workflow_editor/`), served by its service under `/wfe/`. It holds the
  projects, runs, execution nodes, Context, Usage and User nodes, and it owns
  conversations and their execution (`workflow_editor/docs/conversations.md`).
- **aghangout** (`/hangout/`) is where a person talks with the project
  agents. It is a managed project (`aghangout`, Gitea
  `developer/pj-aghangout`), not part of this repository. Its own deploy
  installs releases in a host directory, and this site's web server serves
  that directory on the agdev origin. It replaced the embedded Front Desk and
  the Arguing Room, which are deleted with their bundle (`src/`, Phaser).
- **The relay** (`agentroom/`) serves the Usage view's reads from this host:
  `/budget` and `/cost`.

The world views, the operation room, the routine dashboard, the cost gauge
page (retire_old_ui p1) and the Front Desk and Arguing Room (workflow_editor
p15) are retired. Their documentation is in this file's history and in the
episodes.

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

- `npm run editor:install` then `npm run check` — the workflow editor
  package's check (`workflow_editor/`: tsc, `node --test`, vite build). The
  package keeps its own lockfile.
- `scripts/wfe-release.sh deploy <area>` — build, check and install the
  workflow editor service and its `wfe` launcher from an agdevworld commit
  (see "The workflow editor").
- `scripts/slack-release.sh deploy <area>` — the Slack integration
  (`integrations/slack/README.md`).
- `docker compose up --build -d web` — nginx on :8090 and :8093 (routing
  only). Rebuild after an `nginx.conf` or `compose.yaml` change; never for
  aghangout.
- `curl -I http://localhost:8093/` — `302` to `/wfe/` (Home);
  `/hangout/` answers `200` once aghangout is deployed.
- `agentroom/service/serve.sh [check]`, `cd agentroom && uv run pytest -q` —
  the relay and its tests.

## Files

- `nginx.conf` — the two listeners and their routes (below).
- `compose.yaml`, `Dockerfile` — the web container: nginx with
  `nginx.conf`, and aghangout's release directory mounted read-only
  (`AGHANGOUT_DIR`, default `../.local/agdev/hangout`).
- `workflow_editor/` — the workflow editor (agdev dashboard, Project Editor,
  runs, Usage, conversations, `wfe`): a system component with its own
  package (see "The workflow editor").
- `integrations/slack/` — the Slack integration, a second client of the
  conversation contract.
- `agentroom/` — the relay.
- `scripts/wfe-release.sh`, `scripts/slack-release.sh` — releases.

## Routes (workflow_editor p15)

- `:8093` is the agdev origin:
  - `/wfe/` is proxied to the workflow editor service with the request's
    own `Host`, so its pages write to its API same-origin.
  - `/hangout/` serves aghangout's `current` release from the mount. It is
    the same origin, so aghangout's posts to `/wfe/api/conversations` pass
    the service's write-origin check without configuration.
  - Every other address is redirected to `/wfe/`. Exception: an old Front
    Desk link `/?view=frontdesk&conv=<id>` is redirected to
    `/hangout/?conv=<id>`.
- `:8090` has no routes of its own. It redirects to the same host's
  `:8093`, with the same Front Desk rule.
- The dashboard header links Usage and "aghangout ↗"
  (`workflow_editor/src/site.ts`).

## The relay

`agentroom/` is a stdlib HTTP relay on `:8094`, every interface, supervised
by launchd (`com.agdev.agentroom`). Its README is the reference. It serves
`/budget`, the harness logins' windows read through their CLIs, and `/cost`,
the pre-WFE agents' records as history. It holds no credential and reads no
Zulip.

## Usage (retire_old_ui p1)

The dashboard's Usage card and `#/usage` view replace the cost gauge page
(`workflow_editor/docs/usage.md`).

- The executions' usage is read by the workflow editor service from the exec
  store and each attempt's log on the coordinator.
- The subscription windows come from the relay's `/budget`.
- The pre-WFE agents' records come from the relay's `/cost`, shown as
  history.
- The browser reads all three on the dashboard's origin
  (`/wfe/api/usage…`).

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
