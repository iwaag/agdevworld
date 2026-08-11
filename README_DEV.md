# agdevworld Development Guide

## Commands

- `npm run dev` — vite with HMR on :5173; `/api` is proxied to the assistant on :8091.
- `npm run build` — `tsc && vite build`; the Docker build runs it too, so a successful image build is a compile check.
- `docker compose up --build -d web` — production-style bundle behind nginx on :8090. Keep it current when a user may want to look.
- `docker compose ps web` / `curl -I http://localhost:8090/` — confirm it came up.
- `docker compose up --build -d web assistant` — the UI and profile-selected chat service on :8090/:8091. The assistant image contains the pinned OpenCode and Claude Code runtimes; code, config, and `GUIDE.md` changes need a rebuild.
- `CAGENT_URL=https://localhost:8789 npm run cluster:fetch` — refresh the three cluster snapshots through cagent.
- `docker compose logs assistant` — run records (`assistant.run.v1`) and notes (`assistant.note.v1`) as they happen. The durable copy is the `assistant_records` volume (`ASSISTANT_RECORDS_DIR=/records`); the log alone does not survive `up --build`.
- `docker compose exec assistant ls /records` — what the assistant has left behind, including notes about facts that turned out wrong.

## Files

- `src/main.ts` — wiring: scenes, the chat panel, the click-to-detail path.
- `src/scenes/PanelGridScene.ts` — one config-driven grid scene, shared by all three views.
- `src/views.ts` — the three view configs (`nodes`, `workspaces`, `autolab`).
- `src/viewSwitcher.ts` — the single seam for changing the visible view.
- `src/chatPanel.ts` — the chat overlay; it owns history and applies returned UI actions.
- `src/detailPopup.ts` — the detail overlay, incl. the per-iteration `summary` button.
- `src/clusterState.ts` / `src/autolabState.ts` — snapshot and gateway reads for the panels.
- `agents.toml` / `.local/agents.local.toml` — common role/profile contract and machine-local harness/provider facts.
- `opencode.json` — front-role OpenCode provider, MCP, and permission configuration.
- `assistant/server.mjs` — one profile-selected process per chat request, passthrough routes, notes, and run records.
- `assistant/agent-config.mjs` / `harness.mjs` — JavaScript contract loader and process seam.
- `assistant/tool-service.mjs` — bounded stdio MCP tools; server actions execute here and UI actions are collected.
- `assistant/GUIDE.md` — the capability card, re-read per chat request.
- `scripts/fetch-cluster-state.mjs` — snapshot refresh through cagent.
- `public/cluster/*.json` — live snapshots, git-ignored; `public/*.sample.json` is the fallback. The Docker build copies whatever is in `public/` at build time, so move a live snapshot out first if a sample-only image is wanted.

## Assistant

`POST /api/chat` takes the whole browser-owned conversation and screen context,
starts one fresh `front` run, and answers once with prose plus UI actions. The
selected harness owns its multi-step MCP loop; the browser never reposts tool
results. Every request receives a new process and run ID, so no harness
session state leaks between requests.

The committed default is profile `local` = OpenCode +
`ollama/qwen3.6:35b-a3b-coding-nvfp4`. Harness command and provider endpoint
come only from the ignored local overlay. The alternative `sonnet` =
Claude Code + `anthropic/claude-sonnet-5` uses the same MCP tools and UI-action
channel. Select it only through `[roles.front] profile = "sonnet"` in the
ignored local overlay; there is no per-request backend selector or fallback.

| harness | local requirement | container status |
|---|---|---|
| `opencode` | executable plus `local.provider.ollama.base_url` | OpenCode 1.18.10 is installed; the compose overlay supplies the endpoint |
| `claude_code` | executable plus API-key authentication | Claude Code 2.1.226 is installed; compose passes optional `ANTHROPIC_API_KEY`, and missing authentication fails explicitly without fallback |

For this Mac, `.local/agents.local.toml` resolves Claude Code through the
VS Code extension's versioned native-binary glob. Do not copy
`~/.claude/.credentials.json` into the repository or image. Compose supplies
the optional `ANTHROPIC_API_KEY` environment value and the generated overlay
contains only `anthropic_api_key_env = "ANTHROPIC_API_KEY"`; the key itself
never enters either agents file or the image.
Binary absence fails during profile resolution, while invalid or absent login
fails as a recorded Claude run whose stderr/result tail is returned in the 502
detail. Neither case attempts OpenCode.

Runtime-only variables are `AUTOLAB_NODES`, `AGFORGE_URL`,
`ASSISTANT_RECORDS_DIR`, `AGDEVWORLD_TOOL_BASE_URL`,
`AGENT_PROVIDER_OLLAMA_BASE_URL`, optional `AGENT_FRONT_PROFILE`, and the optional
`AGDEVWORLD_AGENT_TIMEOUT_MS`. Its default is 300 seconds; nginx waits 310
seconds so a process timeout reaches the browser as an explicit assistant
error. The assistant entrypoint generates `/app/.local/agents.local.toml`
from deployment environment values on every start, so no ignored hand-written
compose overlay is required. Native runs use `.local/agents.local.toml`.

## Autolab project profiles

The autolab view fetches `/api/autolab/<node>/projects` alongside jobs and
status. Read-only project cards show the effective `coding` and `director`
profiles before the job cards. Clicking one opens its read-only profile detail
and the common ask-agent action; job rows and details also show their optional
project association. Use the refresh chip after an out-of-band change.

Changing a profile stays inside the conversational single entrance. Ask the
agdevworld assistant in ordinary words; it reads the project's current value,
passes the request to that node's `/window`, and confirms with another
`/projects` read. There is deliberately no selector or direct settings-write
route in agdevworld. This is separate from the assistant's own front profile,
which still has no per-request selector.

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
