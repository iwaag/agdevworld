# agdevworld Development Guide

## Commands

- `npm run dev` — vite with HMR on :5173; `/api` is proxied to the assistant on :8091.
- `npm run build` — `tsc && vite build`; the Docker build runs it too, so a successful image build is a compile check.
- `docker compose up --build -d web` — production-style bundle behind nginx on :8090. Keep it current when a user may want to look.
- `docker compose ps web` / `curl -I http://localhost:8090/` — confirm it came up.
- `docker compose up --build -d assistant` — the chat service on :8091. `server.mjs` and `GUIDE.md` are COPYed in, so both need a rebuild unless bind-mounted.
- `CAGENT_URL=https://localhost:8789 npm run cluster:fetch` — refresh the three cluster snapshots through cagent.
- `docker compose logs assistant` — run records (`assistant.run.v1`) and notes (`assistant.note.v1`) as they happen. The durable copy is the `assistant_records` volume (`ASSISTANT_RECORDS_DIR=/records`); the log alone does not survive `up --build`.
- `docker compose exec assistant ls /records` — what the assistant has left behind, including notes about facts that turned out wrong.

## Files

- `src/main.ts` — wiring: scenes, the chat panel, the click-to-detail path.
- `src/scenes/PanelGridScene.ts` — one config-driven grid scene, shared by all three views.
- `src/views.ts` — the three view configs (`nodes`, `workspaces`, `autolab`).
- `src/viewSwitcher.ts` — the single seam for changing the visible view.
- `src/chatPanel.ts` — the chat overlay, and where the assistant's tools run.
- `src/detailPopup.ts` — the detail overlay, incl. the per-iteration `summary` button.
- `src/clusterState.ts` / `src/autolabState.ts` — snapshot and gateway reads for the panels.
- `assistant/server.mjs` — the chat service, the agforge / autolab passthroughs, and `POST /api/note`.
- `assistant/GUIDE.md` — the capability card, re-read per chat request.
- `scripts/fetch-cluster-state.mjs` — snapshot refresh through cagent.
- `public/cluster/*.json` — live snapshots, git-ignored; `public/*.sample.json` is the fallback. The Docker build copies whatever is in `public/` at build time, so move a live snapshot out first if a sample-only image is wanted.

## Assistant

`POST /api/chat` takes the whole conversation and answers with prose, tool
calls, or both; the browser runs the tools and posts the results back. The
service is stateless and engine-agnostic — `handleChat` builds the system
prompt and hands `(system, messages, tools)` to a backend.

| variable | default | meaning |
|---|---|---|
| `ASSISTANT_BACKEND` | `ollama` | `ollama` \| `claude`; an unknown value is an error, never a silent fallback |
| `OLLAMA_URL` / `OLLAMA_MODEL` | `host.docker.internal:11434` / `glm-4.7-flash:latest` | the local default |
| `CLAUDE_MODEL` | `claude-opus-5` | model for the claude backend |
| `CLAUDE_EFFORT` / `CLAUDE_MAX_TOKENS` | `low` / `4096` | |
| `ANTHROPIC_API_KEY` | — | required by the claude backend only; `.env` or the environment |
| `AUTOLAB_NODES` | `agstudio=http://host.docker.internal:8791` | `"<name>=<url>,…"`; real hostnames belong in `.env` |
| `AGFORGE_URL` | `http://host.docker.internal:8092` | agforge request service |
| `ASSISTANT_RECORDS_DIR` | — | also write one run record file per run |

Compose passes an empty string for anything the operator has not set, so the
code reads env with `||`, never `??`.

## Safety devices

Two guards in `assistant/server.mjs` and two in the browser. They differ in
kind from instructions: they bound reach and resources, not correctness, and
each answers with its own reason where the assistant can read it.

- The autolab node list is finite — otherwise this is an open relay into the LAN.
- `/evidence/` answers `403` — raw evidence stays on the node that produced it.
- Node routes are otherwise passed through as-is (zero_auth episode): the
  nodes carry no auth, and this passthrough adds no gate of its own.
- 16 tool rounds per reply, a 60 s ceiling on one `wait`, and a 10 s fetch timeout in `chatPanel.ts`; 10 s upstream timeouts in the passthrough.
