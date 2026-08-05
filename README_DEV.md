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

`public/cluster/state.json` (drift) and `public/cluster/workspaces.json`
(workspaces) are the local, ignored live cluster snapshots. The frontend uses
them when present and falls back to `public/state.sample.json` /
`public/workspaces.sample.json` otherwise. Refresh both through the read-only
cluster-agent workflow:

```sh
CAGENT_URL=https://localhost:8789 npm run cluster:fetch
```

Do not commit the downloaded state or any cagent credential. The Docker build
copies files in `public/` into its local image; therefore a live snapshot is
included in that local image when present at build time. Temporarily move the
snapshot out of `public/cluster/` before rebuilding if a sample-only image is
needed, then restore it afterward.
