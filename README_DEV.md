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
