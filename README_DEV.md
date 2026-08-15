# agdevworld Development Guide

## Commands

- `npm run dev` — vite with HMR on :5173; `/api` is proxied to the assistant on :8091.
- `npm run build` — `tsc && vite build`. The frontend's only check: the assistant is Python now, and the deleted `npm test` never ran anything else. The Docker build runs it too, so a successful image build is a compile check.
- `uv run pytest` from `assistant/` — the whole assistant test suite (tool service, chat, passthroughs, workflows, project starts). This is the test entrance.
- `docker compose up --build -d web` — production-style bundle behind nginx on :8090. Keep it current when a user may want to look.
- `docker compose ps web` / `curl -I http://localhost:8090/` — confirm it came up.
- `docker compose up --build -d web assistant` — the UI and profile-selected chat service on :8090/:8091. The assistant image contains the pinned Claude Code runtime; agcode ships inside pyagag and runs in-process. Code, config, and `GUIDE.md` changes need a rebuild.
- `CAGENT_URL=https://localhost:8789 npm run cluster:fetch` — refresh the three cluster snapshots through cagent.
- `docker compose logs assistant` — run records (`assistant.run.v1`) and notes (`assistant.note.v1`) as they happen; stdout carries records only, stderr carries access logs and warnings. The durable copy is the `assistant_records` volume (`ASSISTANT_RECORDS_DIR=/records`); the log alone does not survive `up --build`.
- `docker compose exec assistant ls /records` — what the assistant has left behind, including notes about facts that turned out wrong.

## Files

- `src/main.ts` — wiring: scenes, the chat panel, the click-to-detail path.
- `src/scenes/PanelGridScene.ts` — one config-driven grid scene, shared by all four views.
- `src/views.ts` — the four view configs (`nodes`, `workspaces`, `autolab`, `tasks`).
- `src/viewSwitcher.ts` — the single seam for changing the visible view.
- `src/chatPanel.ts` — the chat overlay; it owns history and applies returned UI actions.
- `src/detailPopup.ts` — the detail overlay, incl. the per-iteration `summary` button.
- `src/clusterState.ts` / `src/autolabState.ts` / `src/planeState.ts` — snapshot, gateway, and Plane reads/actions for the panels.
- `agents.toml` / `.local/agents.local.toml` — common role/profile contract and machine-local harness/provider facts. The overlay is generated at every container start from deployment environment values.
- `assistant/pyproject.toml` — the Python package (`agdevworld-assistant`) and its `pyagag` git source; `uv` owns `assistant/.venv`.
- `assistant/agdevworld_assistant/server.py` — the stdlib HTTP service: routing, chat, notes, guide, and the record writer's callers.
- `assistant/agdevworld_assistant/chat.py` — one chat request: role resolution and the harness launch through `agag`, prompt shaping, UI-action collection.
- `assistant/agdevworld_assistant/passthrough.py` — the forge, autolab-node, and Plane passthroughs around one `proxy_fetch()`, plus the reach guards.
- `assistant/agdevworld_assistant/workflows.py` / `projects.py` — the Zulip-backed freeforge and mission routes, and project starts (Gitea → Plane → Zulip).
- `assistant/agdevworld_assistant/overlay.py` / `records.py` / `settings.py` — the generated local overlay, the record envelopes, and shared paths/limits.
- `assistant/agdevworld_assistant/tool_service.py` — bounded stdio MCP tools; server actions execute here and UI actions are collected.
- `assistant/tests_py/` — the pytest suite that covers all of the above.
- `assistant/GUIDE.md` — the capability card, re-read per chat request.
- `scripts/fetch-cluster-state.mjs` — snapshot refresh through cagent. The one piece of JavaScript outside `src/`; it is a developer command, not part of the service.
- `public/cluster/*.json` — live snapshots, git-ignored; `public/*.sample.json` is the fallback. The Docker build copies whatever is in `public/` at build time, so move a live snapshot out first if a sample-only image is wanted.

## Assistant

The assistant is Python (`assistant/agdevworld_assistant/`, a `ThreadingHTTPServer`
plus `pyagag` for agent identity and process launch). Its image is
`node:26-alpine` with `python3`, `uv`, and `git` added: the service is Python,
but the two harnesses arrive by `npm install -g`, so a runtime node is not
optional.

`POST /api/chat` takes the whole browser-owned conversation and screen context,
starts one fresh `front` run, and answers once with prose plus UI actions. The
selected harness owns its multi-step MCP loop; the browser never reposts tool
results. Every request receives a new process and run ID, so no harness
session state leaks between requests. The other routes — `/api/note`,
`/api/guide`, the forge / autolab / Plane passthroughs, the freeforge and
mission workflows, and project starts — are served by the same process.

The committed default is profile `local` = agcode +
`ollama/qwen3.6:35b-a3b-coding-nvfp4`. The provider endpoint comes only from
the ignored local overlay; agcode needs no harness command, because it ships
inside pyagag and `chat.run_agcode()` calls it in this process. The
alternative `sonnet` = Claude Code + `anthropic/claude-sonnet-5` reaches the
same four tools and the same UI-action channel through MCP. Select it only through `[roles.front] profile = "sonnet"` in the
ignored local overlay; there is no per-request backend selector or fallback.
A third profile, `stub` (`harness = "fake"`), runs a chat end to end without a
model and is how the route is proven without spending anything.

| harness | local requirement | container status |
|---|---|---|
| `agcode` | `local.provider.ollama.base_url` only | nothing to install; the compose overlay supplies the endpoint, without the OpenAI-compatible `/v1` suffix |
| `claude_code` | executable plus API-key authentication | Claude Code 2.1.226 is installed; compose passes optional `ANTHROPIC_API_KEY`, and missing authentication fails explicitly without fallback |

For this Mac, `.local/agents.local.toml` resolves Claude Code through the
VS Code extension's versioned native-binary glob. Do not copy
`~/.claude/.credentials.json` into the repository or image. Compose supplies
the optional `ANTHROPIC_API_KEY` environment value and the generated overlay
contains only `anthropic_api_key_env = "ANTHROPIC_API_KEY"`; the key itself
never enters either agents file or the image.
Binary absence fails during profile resolution, while invalid or absent login
fails as a recorded Claude run whose stderr/result tail is returned in the 502
detail. Neither case falls back to the `local` profile.

Runtime-only variables are `AUTOLAB_NODES`, `AGFORGE_URL`, `PLANE_URL`,
`PLANE_API_KEY`, `PLANE_WORKSPACE_SLUG`, `PLANE_PROJECT_ID`, `GITEA_URL`,
`GITEA_ORG`, `GITEA_TOKEN_PATH`, `ZULIP_ENV_PATH`, `ASSISTANT_RECORDS_DIR`,
`AGDEVWORLD_TOOL_BASE_URL`, `AGENT_PROVIDER_OLLAMA_BASE_URL`, optional
`AGENT_FRONT_PROFILE`, and the optional `AGDEVWORLD_AGENT_TIMEOUT_MS`. Its
default is 300 seconds; nginx waits 310 seconds so a process timeout reaches
the browser as an explicit assistant error. The Gitea token and the Zulip
credentials are read from files at request time (`/run/secrets/gitea.token`,
`/run/secrets/zulip.env`), never held in the environment. The server generates
`/app/.local/agents.local.toml` at boot from deployment environment values, so
no ignored hand-written compose overlay is required. Native runs use
`.local/agents.local.toml`.

Zulip is reached by its own LAN hostname, because the realm resolves on the
`Host` header. Set `ZULIP_LAN_HOST` in the ignored `.env` to that name: compose
maps it to the host gateway, and without it Docker's DNS answers with every
host interface address, which Python's `urllib` walks one connect at a time.

## Autolab project profiles

The autolab view fetches `/api/autolab/<node>/projects` alongside jobs and
status. Its `projects` and `jobs` tabs keep the two record types in separate
grids while sharing the selected node. Read-only project cards show the
effective `coding` and `director` profiles; clicking one opens its profile
detail and the common ask-agent action. Job rows and details also show their
optional project association. Use the refresh chip after an out-of-band
change.

Changing a profile stays inside the conversational single entrance. Ask the
agdevworld assistant in ordinary words; it reads the project's current value,
passes the request to that node's `/window`, and confirms with another
`/projects` read. There is deliberately no selector or direct settings-write
route in agdevworld. This is separate from the assistant's own front profile,
which still has no per-request selector.

## Plane task dispatch

The `tasks` view lists only Backlog and Ready issues from the configured Plane
project. Node chips come from `AUTOLAB_NODES`; their marker distinguishes
unreachable, reachable/idle, and busy nodes when `/status` is available.
Backlog is display-only. A Ready card has Execute and Cancel controls.

Execute first moves the issue to In Progress, then asks the selected node's
`/window` to start a mission containing the Plane issue ID, title, and full
description. A definite refusal returns the issue to Ready. A transport timeout
is deliberately left In Progress because the remote window can finish and
launch after the browser's connection has gone away; the UI reports that
ambiguous outcome instead of creating a Ready + running split. Cancel only
moves a not-yet-dispatched Ready issue to Cancelled.

## Safety devices

The reach and resource guards live at the HTTP/MCP tool boundary rather than
in prompt prohibitions. Each refusal reaches the agent with its reason.

- The autolab node list is finite — otherwise this is an open relay into the LAN.
- `/evidence/` answers `403` — raw evidence stays on the node that produced it.
- Node routes are otherwise passed through as-is (zero_auth episode): the
  nodes carry no auth, and this passthrough adds no gate of its own.
- MCP `fetch` stays on the configured agdevworld origin, clips responses at 1 MB, and times out at 60 s.
- MCP `wait` caps one call at 60 s; the whole fresh agent process has a 300 s default wall-clock bound.

## cagent convention (agcluster)

agdevworld sends only read-shaped requests to cagent — today that is the
snapshot fetch in `scripts/fetch-cluster-state.mjs`. Write-shaped prompts
(`desired apply`, `reconcile --yes`) are out of bounds. This is a
convention, not enforced: the human token cannot distinguish reads from
writes. Enforcement is deferred to the future system-wide auth (JWT)
episode — see `devdocs/episodes/zero_auth/` (the single pointer to that
vision).
