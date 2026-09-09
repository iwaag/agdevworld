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

- `POST /chat` → **the one route that writes to the realm**: a post into a
  routine topic of `#front`, as the Developer. `{topic, text}`; answers
  `{sent, channel, topic, message_id}`, `403` with the reason for anything the
  rules decline, `503` when no chat credential is configured. See below.

- `GET /complete/plan?channel=…&topic=…`, `POST /complete` → what
  finishing one request would change, and doing it (`front_desk` p3, p4).
  The **second** route that writes to the realm, and the only one that
  writes to Plane. `GET /complete/history` is what this relay carried out.
  `GET /frontdesk/<id>/close-plan` and `POST /frontdesk/<id>/close` are the
  same operation with the Front Desk id naming the topic. See below.

- `GET /frontdesk`, `GET /frontdesk/<id>`, `POST /frontdesk/<id>/post` → the
  Front Desk's conversations, one conversation's history, and a post into it
  as the Developer (`front_desk` p1). See below.

- `POST /routines/<name>/start` → the other write (`operation_room` p6, p7):
  start a new run of one routine by posting the trigger-shaped fire line,
  marked "started by hand from the operation room", into a **new run topic**
  `front-routine-<name>-<stamp>` as the Developer, naming the routine's
  newest run as `Previous run:` the way the dispatcher does. Body
  `{"instruction": "…"}` is optional and is appended as "Instruction for this
  run". Answers `{sent: true, message_id, topic, previous, text}`; `409` with
  the reason when the routine is retired, has no standing request, is unknown,
  or already started a run this minute (same topic); `502` with `uncertain:
  true` when the post left and Zulip did not confirm it — nothing is retried,
  because a second post is a second paid run.

**A session is a run topic** (`operation_room` p7). `GET /routines/<name>`
lists the routine's run topics newest first by stamp, each carrying `id`
(the fire's message id), `topic`, `stamp`, `fire`, `origin` (`manual` /
`scheduled` / `unknown`, read from the fire's own wording), `previous` (the
run topic the fire names), `answer`, `resolution` (`resolved` or `open` —
the topic's own ✔, nothing else), `history` (the run's post window), `chat`
(the run topic whole) and the linked-conversation tree. `?resolved=hide`
drops ✔'d runs before the three-session limit is applied. The payload's
`history` block says how many run topics are held and the sweep's rule: the
newest `DEEP_RUNS` (3) run topics of a routine are read whole and read even
under ✔; older runs are read shallow while open and not at all once
resolved, so a resolved run older than that is in Zulip, not here.

A Zulip failure answers `502` with the error text, so the view can say the
room is unreadable instead of showing an empty one.

## `/routines` — the routine board

A routine lives in three places and this is the first thing that reads all
three: the standing request in `#front` › `routine-<name>`, the run topics
`#front` › `front-routine-<name>-<stamp>` (one per run), and the dispatcher's
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
cycle should be discovered. Each session also carries `truncation` with
`truncated`, `reasons` (`nodes` and/or `depth`), `max_nodes`, and `max_depth`.
It reports actual omitted eligible links, not merely a tree exactly at a cap.
This inspects already-held links only. A false truncation flag does not make
unread topic evidence known or turn current verdicts into historical outcomes.

A routine's two topics are the only ones this service reads **through a ✔**:
resolution is how a routine is retired, and there are sixteen such topics
rather than a realm's worth. Their history is also the only history kept in
full (200 messages), because the chat view *is* that history.

## `POST /chat` — the only write

`AGENTROOM_CHAT_ZULIP_ENV` is a **third** credential variable, the Developer's,
and nothing falls back to it or from it. Unset means the relay is read-only for
chat and every read payload says so in `chat.configured`, so a view knows
before it draws a box. The `/ops` observer never gains the ability to post.

Three rules, all enforced in the relay rather than in the view, because a view
that hides a box is a habit and not a rule:

- **`#front`, and only a routine topic of a routine this relay already sees**
  (`routine-<name>` or `front-routine-<name>-<stamp>`). The GUI cannot write into
  another agent's channel: routing work is Front's job, which is what Single
  Entrance means.
- **A length guard.** This realm's `max_message_length` is 10000 and Zulip
  **truncates silently** past it (measured in `comfynotify`). The door sends up
  to `AGENTROOM_CHAT_MAX_CHARS` (default 4000) and refuses louder messages
  rather than letting a boundary fail invisibly.
- **No selfnote may be typed by hand**, and there is **no retry**: a post here
  starts a paid Front run, and a retry would buy a second one for a request the
  human made once — in exactly the case where the first post may have landed.

## `/frontdesk` — the Front Desk (`front_desk` p1)

agdevworld's Front Desk scene talks to Front in `#front` › `front-desk-<id>`,
inside Front's own `front-` sweep. Three routes, in `frontdesk.py`:

- `GET /frontdesk` → `ag.frontdesk.v1`: every Front Desk conversation the
  relay knows, newest first, each with its `status` (`waiting` — the
  Developer spoke last; `received` — Front's ack is the newest post;
  `answered`; `done` — ✔; `quiet`; `unknown` while the queue is dead, with
  `stale_state`) and the evidence it was read from. Conversations the sweep
  saw by name but does not hold are listed too, as name-only rows.
- `GET /frontdesk/<id>` → the conversation: `posts` (real posts only, each
  with `kind` — `developer`, `agent`, `ack`, `other`), `latest_reply`,
  `status`, `history` (post count, whether it is a window), a `zulip_url`
  into the topic, and **`known`**: `held` (the engine's event-queue memory —
  the newest `DESK_DEEP` (8) conversations are read whole and under ✔ on the
  sweep, and every open one is kept current by the queue), `read` (a direct
  read of Zulip with the relay's read credential, under both the bare and
  the ✔ name, cached 30 s — how an old resolved conversation comes back after
  a relay restart), or `unknown` (neither could be done; nothing is invented
  and the view keeps what it last knew).
- `POST /frontdesk/<id>/post` `{text, token}` → a post as the Developer into
  `front-desk-<id>`, on the chat credential and with `chat.py`'s guards
  (configured, length, no selfnote), plus two of its own: the id has one
  shape (`^[a-z0-9][a-z0-9-]{0,47}$`, so nothing else ever becomes part of a
  topic name) and the **token** is remembered — a repeated submit (double
  click, second Enter, retry after a timeout) answers the first result with
  `duplicate: true` and posts nothing. A ✔'d conversation is **resumed in
  place**: the topic is un-resolved (renamed back) before the post, because
  Front's sweep never reads a resolved topic. `403` for a refusal, `502`
  with `uncertain: true` when the post left and Zulip did not confirm it;
  never a retry, because a post here starts a paid run.

Since `front_desk` p2 step 3 each post of Front's also carries **`dialogue`**
and **`dialogue_error`**. agfront ends a reply that reports on another agent
with a fenced `ag-dialogue` JSON block (`ag.frontdesk-dialogue.v1`: the
settings revision it was written for and ordered `turns`, each a character
id, a text and the source posts it was drawn from), validated and
re-serialized there. The relay splits it off: `content` is the reply
without the block, `dialogue` the parsed scene (`null` for a Front-only
reply), and `dialogue_error` the reason recorded in an `ag-dialogue-error`
fence when the run's block was unusable — the reply is shown on its own
then. A machine block never reaches the rendered conversation. The
Developer's posts are shown as typed, fences included.

## `/complete` — finishing a request (`front_desk` p3, p4)

A request is rarely one topic: Front opens a workplan topic, autolab plans
a Plane Work with a Sub-Work per task and a `work-<label>` channel per
mission, forge runs an `assetrun-` beside its `assetplan-`. When the thing
is done, all of that is still open — including the mission Work, which
nothing ever closed. Two routes close it, in `closing.py` (what the targets
*are*) and `close.py` (what would change, and doing it). The request is any
conversation named by `channel` and `topic` (a ✔ name is read bare):

- `GET /complete/plan?channel=…&topic=…` → `ag.completion.v1`: `root`, a
  `scope` block, the ordered `actions`, each with a `kind` (`work`, `topic`,
  `channel`, `conversation`), a stable `key`, a `state` (`ready`, `done`,
  `blocked`, `kept`), the `reason` it is in that state and the `detail` it
  was decided from; plus `counts`, `excluded`, `gaps`, `status` (which
  credentials this relay has), `history` (this relay's earlier operations on
  the same request) and a `fingerprint`. It writes nothing.
- `POST /complete` `{channel, topic, fingerprint}` → applies it and answers
  the same payload with `results` (one row per target: `applied`, `already`,
  `failed`, `skipped`) and `partial`. `409` when the plan has changed since
  the preview — the refusal carries the fresh plan and **nothing is
  written**. The body carries the request and the approved fingerprint and
  nothing else: the server closes what it derived, never what a browser
  named.
- `GET /complete/history[?channel=…&topic=…]` → the operations this relay
  carried out, newest last; memory only, forgotten on restart.
- `GET /frontdesk/<id>/close-plan`, `POST /frontdesk/<id>/close
  {fingerprint}` → the same two, with the Front Desk id naming
  `#front` › `front-desk-<id>`.

**What a root is, and what it owns** (`closing.classify`, `Scope`,
`_ownership`, p4). A conversation's *kind* is its name — `desk`, `front`,
`routine-run`, `routine-standing`, `workplan`, `workrun`, `assetplan`,
`assetrun`, `intro`, or `topic` — and only the request kinds (the first two,
a run, a plan) may be completed. A task or run topic answers with its
`scope.parents` and one blocked action; a standing request or an
introduction is refused, because a ✔ there retires the routine or the agent.
Whose a reached topic is comes from its root notes: all naming this request
(or something it owns, or what the root itself was opened for) → owned;
naming anything else → *anchored to another request*, excluded with the
note's message id. An execution topic is decided by its **structural** home
only (autolab's `workplan-` for a `workrun-`, forge's `assetplan-` for an
`assetrun-`); other root notes there are Front's visits on behalf of another
request and are carried as `visitors`, shown, never obeyed. A topic with no
root note is owned when something owned reached it — unless it is itself a
request, which no served note can claim. A routine run's `scope` also names
its standing request and the previous run its fire line mentions as
`context`: untouched, and said so.

The walk (`related_topics`) follows both link notes to a fixed point, reads
every reached topic's unread home once (a plan Front never served is found
through the task that names it), and reads the whole `work-<label>` channel
of every owned autolab mission, because a plan carries no note naming its
tasks. Every read is under both names; what could not be read is a gap.

How each target is decided:

- **A Work** by `agag.plane.reason_not_completed` — the same rule
  `agautolab.mission_done` applies, moved into pyagag in p3 so the button
  could ask it about one named Work instead of running a whole-board CLI.
  Every live Sub-Work completed → `ready`; already Done → `done`, a
  successful no-op; cancelled → `kept`, untouched; unfinished children, or a
  standalone Work with none, → `blocked`. A Sub-Work the walk never reached
  is listed as `unreached_children` and still counted.
- **A topic** by whether it was actually read. `note-only` is a gap, not a
  finished conversation, and blocks.
- **A channel** only when it is `work-<label>` for a mission of *this*
  conversation and every topic it actually holds is one of these targets.
  `#front`, project and agent channels are never candidates. An **archived**
  channel is `done`, not a gap: archiving is what makes a channel unlistable,
  so a second preview asks the realm's channel list which of the two it is
  looking at.
- **The Front conversation last**, and only if nothing above is blocked or
  failed — a ✔ there is the claim that the whole thing is finished.

Nothing rolls back and nothing is retried automatically: every action is
idempotent in the realm's own terms (a resolved topic → `already`, a Done
Work → `already`), so clicking again after a partial failure finishes what
is left and repeats nothing.

Credentials: reads use `AGENTROOM_ZULIP_ENV`, Zulip writes use
`AGENTROOM_CHAT_ZULIP_ENV` (the Developer — the credential that already
posts here), and Plane uses **`AGENTROOM_PLANE_ENV`**, a path to an ignored
`KEY=value` file. Unset, or refused a project, is reported in the preview's
`status`/`gaps` rather than discovered on submit. This operation closes
work; it does not stop a running agent.

## `/settings` — the settings repository (`front_desk` p2)

The Front Desk's characters (display names, lore, portraits, which agents
speak as which character) and rooms (backgrounds) come from a Git
repository — `iwaag/agdevworld-settings` to begin with — rather than from
the frontend bundle or an agent's guide. `settings.py` owns it:

- **Config**: `agdevworld/.local/settings.toml` (ignored; the tracked
  `settings.example.toml` beside `package.json` shows the shape), or the file
  `AGENTROOM_SETTINGS_CONFIG` names. `[repository]` gives `url`, `ref`
  (branch, tag or commit) and `destination` (`.local/settings` by default);
  `[overrides.characters.<id>]` adds this realm's `agents` / `senders` to a
  character's mapping without touching the shared repository.
- **Sync**: `uv run agentroom-settings sync` (from `agentroom/`). Clone or
  fetch, resolve the ref, snapshot that commit under
  `<destination>/revisions/<sha>/`, read its `manifest.toml`
  (`ag.settings-manifest.v1`) and check that every lore and image it names
  exists, and only then write `active.json` and repoint the `current` symlink.
  A sync that fails — a missing file, an unknown ref, an unreachable URL —
  prints why, records it in `last_sync.json` and leaves the previous
  revision active. Nothing fetches on a request or a conversation.
  `agentroom-settings status` / `show` read the state back.
- `GET /settings` → `ag.settings.v1`: `config`, `active` (the revision in
  use), `last_sync` (so a failed sync is visible beside the revision that is
  still serving), and `manifest` — every character with its lore inline and
  its `face` as `/settings/<revision>/characters/<id>/face.jpg`, every room
  with its `background` likewise. The revision in the URL is the cache
  buster: a replaced image is a new URL.
- `GET /settings/<revision>` → that retained revision's manifest, or `404`
  with `retained: false`. A dialogue saved against a revision asks for it
  here, so it is drawn with the faces it was written for.
- `GET /settings/<revision>/<path>` → one file the manifest at that revision
  names, with its content type and an immutable cache header. Nothing else
  under the snapshot is served: this is a manifest, not a file server.

Agents read the same revision as files: `<destination>/current/` is the
active one, `<destination>/revisions/<sha>/` any retained one (agfront's
`character_talk` reads lore from there since p2 step 2). Every request reads
the active revision afresh, so a content update needs no relay restart and
no frontend rebuild.

## `/cost` — what the backends cost (`gauge_panel`)

`GET /cost` reads this host's `ag.agent-run.v1` records — the same
`AGENTROOM_AGENT_ROOTS` that `/inflight` walks, `<root>/.local/agent/<role>/run-*.json`
— and never Zulip, so a view may poll it. It answers `ag.cost.v1`:

- `totals.{today,days7,days30,all}` and `days[]` (the last 14 local days),
  each with `runs`, `failed`, `usd_reported`, `usd_estimated`, the token
  totals and a `kinds` histogram, plus `by_harness` on the totals.
- `table[]` — one row per instance × role × harness × model.
- `routines[]` — per routine, the sessions the ops engine currently lists
  (the same three the operation room draws, from links it already holds),
  each with the runs matched to its conversations by `channel`/`topic`,
  broken down per agent, and an `attribution` count saying how many were
  matched from the record's own fields and how many from the mtime window.
- `unattributed`, `recent[]` (last 40 rows), `roots[]` (what was readable),
  `missing[]` (roster instances with no root on this host — *unknown*, not
  quiet), `prices` (the table in use).

**Five cost kinds**, decided per harness by `prices.json` (or the file
`AGENTROOM_PRICES` names): `reported` (the harness said USD — claude_code),
`estimated` (tokens × the table — a metered key, gemini_cli), `subscription`
(the plan is metered, not the run — codex on a ChatGPT login, Antigravity;
tokens shown, **no USD invented**), `local` (ollama, 0) and `unknown` (no
usage in the record, or a metered model the table does not price). Reported
and estimated USD are always two numbers, never one. The table is re-read
when its mtime changes.

Records written before `gauge_panel` step 1 carry neither a time nor a
conversation: their end is the file's mtime, their start is derived from
`duration_ms`, and their conversation is the generation directory whose
mtime span overlaps the run's (`attribution: "window"`, 30 s slack, each
directory spent once). New records say it themselves (`"fields"`).

## `/budget` — how much of each plan's window is used (`gauge_panel` ex1)

`GET /budget` answers `ag.budget.v1`: one card per harness under
`harnesses.{claude_code,codex,agy}`, each `{ok, plan, source, windows[],
read_at, error, …}` and, when a read failed, `stale` — the last good card,
apart from the failure. A window is `{kind, label, percent, resets_at}`
(percent *used*, as the vendor said it; `resets_at` in epoch seconds like
every other stamp here). **No provider ever answers 0 for "did not
answer"** — a failed card has `ok: false`, the reason, and an empty
`windows`.

It is its own route rather than a field of `/cost` because it calls the
vendors, through the CLIs' own reads, and `/cost` is stat-only. Each provider
caches on its own clock (`AGENTROOM_BUDGET_SECONDS`, default 60) behind its
own lock, so the page's 20 s poll costs one vendor call a minute per harness,
and a hung codex process never blanks the Claude card.

- **claude_code** — `GET api.anthropic.com/api/oauth/usage` with the bearer
  token from Claude Code's own store: on macOS the Keychain item
  `AGENTROOM_CLAUDE_KEYCHAIN` (default `Claude Code-credentials`, read with
  `security find-generic-password -w`, its `mdat` as the renewal time), and
  after that the file `AGENTROOM_CLAUDE_CREDENTIALS` (default
  `~/.claude/.credentials.json`). The card says which (`store`) and why the
  Keychain was not it (`keychain_error`); an empty `AGENTROOM_CLAUDE_KEYCHAIN`
  skips it. `limits[]` is
  rendered: the 5-hour session, the weekly all-models window and the weekly
  per-model scoped window, each with `severity` and `scope`. There is no
  absolute credit number on Max — the maximum is 100 % of a window — and the
  card's `note` says the `cost_usd` on claude_code records is the
  API-equivalent price, not money leaving an account. **An expired token is
  unknown**, before the call (the file says `expiresAt`) or on 401: the card
  says which file, expired since when, renewed when. Refreshing is the CLI's
  job — the relay never sends the refresh token and never writes the file;
  `credential_renewed_at` is the file's mtime. Measured 2026-09-07: the
  token is an 8-hour one, a Front run completed after the *file's* copy
  expired without rewriting it, and the Keychain item had been renewed 13
  minutes before that expiry — the Keychain is the live store on macOS,
  which is why it is read first.
- **codex** — `codex app-server` (`AGENTROOM_CODEX_BIN`, default `codex` on
  PATH) over stdio JSON-RPC: `initialize`, `initialized`,
  `account/rateLimits/read`, stdin held open until the reply, then killed.
  `primary`/`secondary` become the `5h` and `weekly` windows; `plan` is
  `planType`; `reset_credits` and `credits` ride along. A fresh process per
  read (~1 s) rather than the daemon, which could go stale. `codex exec
  "/status"` is **not** a headless read — it sends the text to the model and
  bills for it.
- **agy** — `agy -p /usage --mode plan --output-format json`
  (`AGENTROOM_AGY_BIN`, default `~/.local/bin/agy`), a slash command that
  expands in print mode and answers locally: `status: SUCCESS`, no model
  run, and `command.data.groups[]` — a weekly and a 5-hour bucket per model
  *group* ("Gemini Models", "Claude and GPT models"), four meters. Antigravity
  reports `remaining_fraction`; the card shows `1 − remaining` so the three
  harnesses read the same way. `/credits` (the purchasable pool, a different
  thing) is the footer line, only when non-zero; its failure leaves the
  meters standing. A non-`SUCCESS` status, a missing `command` block (logged
  out — the TUI's "[Auth Needed]") or a timeout is unknown in the CLI's own
  words. `--mode plan` so nothing needs the permission bypass; no token file
  is read. It is the slow one (~8 s), so it has its own 30 s timeout, and
  `/budget` answers after `JOIN_SECONDS` (15) with what it has — a provider
  still reading says so, keeps its thread, and fills its cache for the next
  tick.

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
