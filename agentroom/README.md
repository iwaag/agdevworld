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

Other environment values: `AGENTROOM_SCHEDULE_JSON` (the routine
dispatcher's `schedule.json`; `/routines` says so when it is unset),
`AGENTROOM_HOST` (default `127.0.0.1`),
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

## Always on

On agstudio the relay is a launchd agent, `com.agdev.agentroom`
(`pj-agdev/devenv/launchd/com.agdev.agentroom.plist.in`), because `/ops` is a
*running* reconstruction: a restart costs a 241-call sweep and about half a
minute during which every row honestly reads `unknown`. A relay somebody has
to remember to start is a board that is not there when it matters.

- Reload after a code change: `launchctl kickstart -k gui/$(id -u)/com.agdev.agentroom`.
- The log is `.local/out/agentroom.log`.
- `KeepAlive` is on, with `ThrottleInterval` at 30 s — deliberately slower than
  launchd's default 10 s, because each respawn re-sweeps the realm and a crash
  loop would spend the agents' quota as fast as it could.
- The plist must set `PATH`: `serve.sh` execs `uv`, and launchd's own PATH does
  not have it. It passes `AGENTROOM_ZULIP_ENV`, `OPSROOM_ZULIP_ENV` and
  `AGENTROOM_STALLED_SECONDS` — the credential **paths**, never their values.

`serve.sh check` is worth running *from the job's own domain* before trusting
the daemon, because macOS grants Local Network permission per binary and a
launchd agent is its own responsible process: a read that works from a
terminal proves nothing about the same code under launchd.

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

- `GET /routines` → the routine board (`operation_room` p3): one row per
  routine, carrying its standing request, its schedule, its last fire and
  **whether that fire was answered**. See below.

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

## `/routines` — the routine board

A routine lives in three places and this is the first thing that reads all
three: the standing request in `#front` › `routine-<name>`, the fire
conversation in `#front` › `front-routine-<name>`, and the dispatcher's
`schedule.json`. The realm half costs **no extra Zulip call** — those topics
are already in the `/ops` engine's memory, read by the same sweep and kept
current by the same queue.

`AGENTROOM_SCHEDULE_JSON` points at the dispatcher's `schedule.json`
(`pj-agdev/.local/rtschedule/schedule.json` on agstudio). It is read as a
**local file** on every request, because the routine GUI on `:8093` is a
`http.server`: it answers no CORS header, so the browser cannot read the same
file itself. Unset is not "no fires" — the payload says `configured: false`
and the view says so.

Three rules here were measured on the live realm rather than assumed:

- **An ack is not an answer.** Front acks every request it is served, so a
  fire that has only an ack is `acked`, and the age is always the age of the
  *fire*.
- **The standing request is the newest post by the topic's author**, not the
  newest post. `trigger.sh` tells Front the request is "the latest post", and
  on 2026-09-04 Front filed a run report into `#front` › `routine-ghtrends`
  instead of the fire topic — the latest post there is now a report about the
  routine. Posts by anybody but the author are served as `request_strays`
  rather than dropped: they are the evidence that an agent answered in the
  wrong topic.
- **A fire is the trigger's own wording** (`Routine \`<name>\`, run of …`).
  Reading "the newest post by the Developer" as the fire would turn every
  comment on a run into a new unanswered one.

### `GET /routines/<name>` — one routine, its last runs, its chat

The same row, plus the **session tree** of the last three fires and the fire
topic's history as a chat log. A session is one fire and everything opened on
its behalf, walked from two selfnote edges — the only thing selfnotes are ever
read for here, and never rendered (constraint 4):

- a **`[served]` note in the fire topic** names a remote conversation whose
  callback Front answered. It is the only edge that survives the remote being
  resolved, and a resolved topic is never swept — so most of a *finished*
  session is invisible without it.
- a **`[rootchat]` note in the remote** names the fire topic as the home the
  remote was opened for. It exists from the remote's first post, which is the
  whole of an *in-flight* session: nothing has been answered yet, so no served
  note exists anywhere.

Runs are separated by **message id**, not by time: the notes carry ids, Zulip's
ids are realm-wide and monotonic, and a fire's own id is the boundary between
one run and the next. A late note about an old callback therefore lands in the
run it was written in — which is honest (that is when the conversation started
working there again) and does inflate a session occasionally; `rtnotes` has one.

Every node wears the **ops board's** verdict, lifted unchanged. What is added
is only what `/ops` has no row for: `quiet` (swept, nothing owed) and `unknown`
(never read — the `note-only` nodes). The walk is capped at depth 4 and 40
nodes, because two agents can anchor each other and a board is not where a
cycle should be discovered.

A routine's two topics are the only ones this service reads **through a ✔**:
resolution is how a routine is retired, and there are sixteen such topics
rather than a realm's worth. Their history is also the only history kept in
full (200 messages), because the chat view *is* that history.

## `/ops` — the state engine

Its module docstring (`src/agentroom/ops.py`) is the reference; this is the
operator's half.

**A ✔ on an `intro-` topic retires the agent.** An introduction is the
contract that says an agent exists and how to reach it, so resolving that
topic is the realm's way of saying it is gone — and the only way, because a
project can be deleted from every machine without Zulip noticing. A retired
instance leaves `/ops` and `/agents`, its channel stops being walked for open
work, and both payloads carry it in `retired` so a reader can tell "gone on
purpose" from "never seen". It is a flag, not a deletion: un-✔ the topic and
the agent comes back, live, without a re-sweep.

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
