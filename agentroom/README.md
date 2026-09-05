# agentroom

A small relay that lets agdevworld show what Zulip already knows:
which agents exist, which of their work is still open, and — since
`operation_room` p2 — **who owes a reply and for how long**. It only ever
reads the realm; the one thing it can be told is which of its own rows a human
has already seen.

Two halves with different disciplines, deliberately:

- `/agents` and `/work` read Zulip **live on every request**, with a 30-second
  in-memory cache. No snapshot file, by design.
- `/ops` is a **running reconstruction**: one full sweep at startup, then a
  Zulip event queue. A full sweep is ~240 calls and p1 measured HTTP 429 on an
  immediate repeat, out of the quota the agents' own listeners spend — this
  half cannot be polled, so it is not.

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

`/ops` needs a **second, separate credential**:

```sh
OPSROOM_ZULIP_ENV=/path/to/opsroom.env \
AGENTROOM_ZULIP_ENV=/path/to/zulip.env service/serve.sh
```

There is no fallback to `AGENTROOM_ZULIP_ENV` — with `OPSROOM_ZULIP_ENV`
unset, `/ops` answers `503` and says so. That is the plan's constraint: the
sweep must not come out of the agents' own quota, so the observer has an
identity of its own (`Opsroom Observer`) or none. `AGENTROOM_STALLED_SECONDS`
(default `900`) is when an owed reply becomes `stalled`.

`service/serve.sh check` does one read and prints the counts instead of
listening — the fastest way to tell a credentials problem from a UI one.

## Routes

Unauthenticated, CORS open, loopback. This is cagent's *window* shape
(`cagent_api/server.py`). Everything is a `GET` except one POST, and that one
writes only to this process's memory (see `POST /ops/confirm`).

- `GET /healthz` → `{"ok": true}`
- `GET /agents` → the `intro-<instance>` topics of `#agents`, each with its
  latest introduction post and the topic's history. `[selfnote]` posts and
  lines, and Zulip's own notices, are removed here — the view never sees them.
- `GET /work` → every **unresolved** topic of every `pj-<slug>` channel and of
  the `work-<label>` channels filed in the same channel folder, flat, with the
  project each belongs to. "Unresolved" is the absence of Zulip's `✔ `
  prefix (`agag.zulip.RESOLVED_TOPIC_PREFIX`) and nothing else: topic naming
  differs per agent, resolution does not.

- `GET /ops` → the conversation-layer state board: one row per
  `(instance, channel, topic)` that is `awaiting`, `stalled`, `acked`, `done`
  or `unknown`, sorted with stalled first, each carrying the evidence its
  state was read off. See below.

- `POST /ops/confirm` → dismiss the `done` rows a human has looked at. An
  empty body (or `{"all": true}`) confirms every `done` row on the board;
  `{"channel": …, "topic": …}` confirms one conversation. Answers
  `{"confirmed": n, "topics": [...], "refused": [...]}`, `409` when the target
  is not `done`, `404` when it is not on the board at all.

A Zulip failure answers `502` with the error text, so the view can say the
room is unreadable instead of showing an empty one.

## `/ops` — the state engine

Its module docstring (`src/agentroom/ops.py`) is the reference; this is the
operator's half.

**The roster is not in this repository.** Every instance states its own
routing — the Zulip name it is mentioned by, the channel it answers every
topic in, the prefixes it sweeps — in a fenced block in its `#agents`
introduction (`pyagag/docs/agent-roster-v1.md`). An introduction with no such
block is served as `unknown`, never as an agent with nothing to do: p1 guessed
two rosters and produced 66 phantom stalled rows.

**It subscribes.** A bot can *read* any public channel unsubscribed, but an
event queue only delivers the channels it is in — measured — and `work-`
channels appear whenever autolab opens a task. Subscribing is the only write
this service makes; it never posts.

**Served notes are read per channel, not globally.** A narrow with no channel
operator returns *nothing at all* for a young credential: Zulip answers a
global search from the reader's own per-user index, which has no rows for
messages posted before the account subscribed. Scoped per channel it reads the
channel's own messages and is right for an identity of any age. Getting this
wrong reported 53 phantom stalls for Front on the first live run.

**When the queue dies, every row is `unknown`.** The last known state is kept
in `stale_state` as evidence and never as the answer. p9's 26 silent minutes
looked exactly like a quiet board, and a screen that renders unknown as idle
cannot show the one failure it exists to catch.

**`done` leaves the board by hand, not by clock.** A `done` row is the receipt
for a debt that was paid, and this board's principle is that evidence stays
until somebody has seen it — so there is no eviction timer, there is
`POST /ops/confirm`. Three things about it:

- **Only `done` may be dismissed**, and the *relay* is what enforces that. A
  button that clears `stalled` off a screen is p9's twenty-six unnoticed
  minutes with a shortcut to it, and a view that merely hides such a button is
  a habit rather than a rule.
- **It records a mark, not a deletion**: `(channel, bare topic)` plus the id of
  the last post at that moment. Any later post floats the row back up — an
  unresolve included, which a `del` from the topic table could not manage,
  because the later rename would arrive naming an `orig_subject` the engine no
  longer knew.
- **It is in memory only.** The marks die with the relay, and so do the rows
  they hide, so the two can never disagree — and a restart never opens on a
  board of debts somebody already cleared. Nothing about a confirm reaches
  Zulip.
