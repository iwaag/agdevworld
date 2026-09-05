# agentroom

A small read-only relay that lets agdevworld show what Zulip already knows:
which agents exist, and which of their work is still open. It reads Zulip
**live on every request** — there is no snapshot file, by design.

## Run

```sh
AGENTROOM_ZULIP_ENV=/path/to/zulip.env service/serve.sh
```

`AGENTROOM_ZULIP_ENV` points at a `KEY=value` file with `ZULIP_URL`,
`ZULIP_EMAIL`, `ZULIP_API_KEY` (and optionally `ZULIP_CA_BUNDLE`) — the format
`agag.zulip.ZulipClient.from_env` reads. Any existing bot credential works;
Zulip has no read-only API key, so nothing here can be narrowed by permission.
**Never commit one.**

Other environment values: `AGENTROOM_HOST` (default `127.0.0.1`),
`AGENTROOM_PORT` (default `8094`), `AGENTROOM_CACHE_SECONDS` (default `30`;
`0` disables the in-memory cache).

`service/serve.sh check` does one read and prints the counts instead of
listening — the fastest way to tell a credentials problem from a UI one.

## Routes

Unauthenticated, `GET` only, CORS open. This is cagent's *window* shape
(`cagent_api/server.py`), minus the write side it does not have.

- `GET /healthz` → `{"ok": true}`
- `GET /agents` → the `intro-<instance>` topics of `#agents`, each with its
  latest introduction post and the topic's history. `[selfnote]` posts and
  lines, and Zulip's own notices, are removed here — the view never sees them.
- `GET /work` → every **unresolved** topic of every `pj-<slug>` channel and of
  the `work-<label>` channels filed in the same channel folder, flat, with the
  project each belongs to. "Unresolved" is the absence of Zulip's `✔ `
  prefix (`agag.zulip.RESOLVED_TOPIC_PREFIX`) and nothing else: topic naming
  differs per agent, resolution does not.

A Zulip failure answers `502` with the error text, so the view can say the
room is unreadable instead of showing an empty one.
