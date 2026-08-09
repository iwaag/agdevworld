# agdevworld Development Guide

## Fast user-checkable web container

Keep the production-style web container current whenever a user may want to
inspect the application. In particular, rebuild it after a meaningful visual
or behavior check and again when an implementation plan is complete. This
keeps the latest app available at `http://localhost:8090` without asking the
user to run a development command.

From this directory, run:

```sh
docker compose up --build -d web
```

Confirm the container and its HTTP entrypoint afterward:

```sh
docker compose ps web
curl -I http://localhost:8090/
```

The matching development server, with Vite hot-module replacement, is:

```sh
npm run dev
```

Use `npm run build` before the container refresh when practical. The Docker
build runs that production build itself, so a successful `docker compose up
--build -d web` is also a deployment-oriented compilation check.

## Cluster snapshot handling

`public/cluster/state.json` (drift), `public/cluster/workspaces.json`
(workspaces), and `public/cluster/actual.json` (per-node detail incl.
`facts_raw` hardware facts, from `nctl actual --json --detail`) are the
local, ignored live cluster snapshots. The frontend uses them when present
and falls back to `public/state.sample.json` / `public/workspaces.sample.json`
/ `public/actual.sample.json` otherwise. Refresh all three through the
read-only cluster-agent workflow:

```sh
CAGENT_URL=https://localhost:8789 npm run cluster:fetch
```

Do not commit any downloaded snapshot or any cagent credential. The Docker build
copies files in `public/` into its local image; therefore a live snapshot is
included in that local image when present at build time. Temporarily move the
snapshot out of `public/cluster/` before rebuilding if a sample-only image is
needed, then restore it afterward.

## autolab view

The third view (`nodes → workspaces → autolab`, cycled with the ⇄ label, the
V key, or "show me the autolab" in chat) shows one autolab node's jobs. A chip
row picks the node (`●` reachable / `○` not) and refreshes; the line above it
is the node's mediator headline (mission, driver state, cumulative cost).
Clicking a job opens the detail popup with its `evidence/iter-NNNN` timeline,
and each iteration has a `summary` button.

That button is the only way iteration content reaches this app. It asks the
node to summarize that iteration with its own one-shot Claude run
(~$0.15, cached per iteration, one at a time per node) and renders the
returned prose verbatim; "Ask agent about this iteration" hands the same text
to the chat assistant. Raw evidence files are never fetched — see below.

Data is fetched on view entry, on chip click, and while a summary is pending;
there is no polling loop.

## Entrance guide

`assistant/GUIDE.md` is the assistant's capability card (devpolicy/policy.md,
*Entrance Guide*): what it can do, what it cannot, and what a chat, an image
and an autolab summary cost. `assistant/server.mjs` reads it from disk on
every `POST /api/chat` and appends it to the role prompt, so "what can you
do?" and "what does that cost?" are answered from the card rather than from
the model's imagination. `GET /api/guide` serves it raw.

Reading per request (rather than at boot) is cagent's `llms.txt` pattern:
editing the card changes the next answer without a restart. The file is
COPYed into the assistant image, so a *container* still needs a rebuild
unless it is bind-mounted.

## Assistant backend (Agent ≠ Model)

`assistant/server.mjs` has one seam: `handleChat` builds the system prompt and
hands `(system, messages)` to a backend; only the `BACKENDS` entries know what
engine answers. Same shape as agforge's `AGFORGE_AGENT_BACKEND` — one default,
and an unknown value is an error rather than a silent fallback.

| variable | default | meaning |
|---|---|---|
| `ASSISTANT_BACKEND` | `ollama` | `ollama` \| `claude` |
| `OLLAMA_URL` / `OLLAMA_MODEL` | `host.docker.internal:11434` / `glm-4.7-flash:latest` | the local default |
| `CLAUDE_MODEL` | `claude-opus-5` | model for the claude backend |
| `CLAUDE_EFFORT` / `CLAUDE_MAX_TOKENS` | `low` / `4096` | the assistant answers from a snapshot and a card, not from hard reasoning |
| `ANTHROPIC_API_KEY` | — | **required by the claude backend only**; put it in `.env` (git-ignored) or the environment, never a committed default |

The claude backend uses the official `@anthropic-ai/sdk` (the assistant image
now runs `npm install`); the ollama default stays plain `fetch` and pulls in
nothing. Compose passes both through, and empty means "use the default".

Every reply is recorded per `devpolicy/agent_records.md` as one JSON line on
stdout (`kind: "assistant.run.v1"` — id, backend, backend_model, outcome,
duration, tokens, and on failure the backend's verbatim words). The container
has no writable volume, so `docker compose logs assistant` *is* the record
store; set `ASSISTANT_RECORDS_DIR` to also write one file per run.

## autolab passthrough

The browser fetches same-origin only, so autolab gateways are reached through
the assistant, the same way agforge is:

- `GET /api/autolab/nodes` — the configured nodes and whether each answers
  `/healthz` right now (a node being down is an answer, not an error).
- `GET|POST /api/autolab/<node>/<rest>` — that node's gateway. GET is proxied
  freely; POST only to `/jobs/<job>/summarize/<iter>`.
- `/evidence/` paths are refused with `403 evidence_not_proxied`. Iteration
  evidence is summarized on the node it lives on and only the summary text
  crosses into agdevworld — that rule is enforced here, in one place.

Nodes come from `AUTOLAB_NODES="<name>=<url>,<name>=<url>"`. The committed
default is the local node only (`agstudio=http://host.docker.internal:8791`);
real cluster hostnames go in `.env` (git-ignored) or the environment, like
every other endpoint here. Compose passes an empty value through when unset,
which means "use the default".
