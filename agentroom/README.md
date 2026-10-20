# agentroom

A small relay on the coordinator host. Since retire_old_ui p1 it serves:

- the Front Desk's panels: the settings repository, the shared contexts and
  the progress board;
- the Arguing Room: argue history, and closing an argue;
- what the workflow editor's Usage view reads from this host: the harness
  logins' windows (`/budget`) and, as history, the pre-WFE agents' records
  (`/cost`).

The agent room, the operation room, the routine dashboard, the cost gauge
page and their routes (`/agents`, `/work`, `/ops`, `/routines`, `/inflight`,
`/chat`, `/complete`, `/frontdesk`, the argue writes) are retired. Their
history is in the episodes (`agent_room`, `operation_room`,
`refine_routine`, `front_desk`, `gauge_panel`, `retire_old_ui`).

**Every read of the realm is a query of the mirror** (`better_zulip_call`
p1). `agag.mirror` keeps a persisted, event-updated copy of every public
conversation on the relay's own credential: one event queue for all public
channels, one paged read of the realm, and events from then on. A reload
costs no Zulip call, and a write comes back as an event that the next read
sees.

Payloads that read the realm carry a `health` block: `live`, or `stale`
(or `unknown`) with the reason and `stale_since`. A stale mirror keeps
answering with the last good copy.

## Run

```sh
OPSROOM_ZULIP_ENV=/path/to/opsroom.env service/serve.sh
```

`OPSROOM_ZULIP_ENV` points at a `KEY=value` file with `ZULIP_URL`,
`ZULIP_EMAIL`, `ZULIP_API_KEY` (and optionally `ZULIP_CA_BUNDLE`) — the format
`agag.zulip.ZulipClient.from_env` reads — for the **mirror's** bot. It is
its own identity with its own quota (`Opsroom Observer` on agstudio), so
reading the realm never competes with the agents' listeners or with what
the Developer does. **Never commit one.** `AGENTROOM_ZULIP_ENV`, the former
per-request read credential, is no longer read; a plist that still sets it
is told so at startup.

Other environment values: `AGENTROOM_HOST` (default `0.0.0.0`, every interface),
`AGENTROOM_PORT` (default `8094`), `AGENTROOM_MIRROR_DIR` (where the
mirror's SQLite store lives; default `.local/mirror/` in this directory —
ignored and disposable: delete it and the next start rebuilds it),
`AGENTROOM_AGENT_ROOTS` (`instance=<root>,…`) for `/cost`, and the budget
readers' binaries (`AGENTROOM_CODEX_BIN`, `AGENTROOM_AGY_BIN`).

Closing an argue needs the **Developer's** credential,
`AGENTROOM_CHAT_ZULIP_ENV`; without it the relay is read-only and says so.

`service/serve.sh check` fills the mirror and prints its call ledger by
purpose, the chat credential's state, the `/cost` records, the settings
revision, every budget card, and how many Zulip calls the whole check made — the fastest way to tell a credentials problem from a UI one, and the
honest measurement of what a first fill costs.

## Always on

On agstudio the relay is a launchd agent, `com.agdev.agentroom`
(`pj-agdev/devenv/launchd/com.agdev.agentroom.plist.in`). It is always on
because the mirror's queue delivers events only while somebody polls it,
and the Front Desk's panels and the Usage view read it at any time.

- Reload after a code change: `launchctl kickstart -k gui/$(id -u)/com.agdev.agentroom`.
  A restart within Zulip's queue lifetime (ten minutes) resumes the queue
  and reads nothing; a longer outage costs one paged read of the realm.
- The log is `.local/out/agentroom.log`.
- `KeepAlive` is on, with `ThrottleInterval` at 30 s.
- The plist must set `PATH`: `serve.sh` execs `uv`, and launchd's own PATH does
  not have it. It passes `OPSROOM_ZULIP_ENV`, `AGENTROOM_CHAT_ZULIP_ENV` and
  the rest — the credential **paths**, never their values.

`serve.sh check` is worth running *from the job's own domain* before trusting
the daemon, because macOS grants Local Network permission per binary and a
launchd agent is its own responsible process: a read that works from a
terminal proves nothing about the same code under launchd.

## Routes

Unauthenticated, CORS open, on the LAN. This is cagent's *window* shape
(`cagent_api/server.py`).

- `GET /healthz` → `{"ok": true, "mirror": <health>}`; `GET /` lists the
  routes.
- `GET /settings`, `/settings/<revision>`, `/settings/<revision>/<path>` →
  the settings repository (below).
- `GET /contexts…`, `POST /contexts…` → the shared context repositories
  (`give_context_easier` p1, `contexts.py`).
- `GET /progress?current=<desk id>` → the Front Desk's progress board
  (`progress_panel` p1, `progress.py`).
- `GET /argues`, `GET /argues/<anchor>`, `GET /argues/<anchor>/close-plan`,
  `POST /argues/<anchor>/close` → the Arguing Room (below).
- `GET /budget` → the subscription windows (below).
- `GET /cost` → the pre-WFE agents' records, as history (below).

A relay failure answers `502` with the error text, so a view can say the
source is unreadable instead of showing nothing.

## `/argues` — the Arguing Room (`argue` p2)

A human reads an argue (`#argue › argue-<stem>`, `agag.argue`) and can
close it from a screen. In `argueroom.py`; every read is the mirror's.

- `GET /argues` → `ag.argueroom.v1`: every argue, newest first — `anchor`
  (the `[selfnote][argue]` note's message id, which **is** the argue),
  `topic`, `live_topic`, `resolved`, `speakers`, `desire`, `outcome`,
  `status` (`waiting` / `received` / `answered` / `done` / `quiet`, read off
  the newest real post; `unknown` with `stale_state` while the mirror is not
  live).
- `GET /argues/<anchor>` → one argue, located by where that message is
  **now**: a renamed or resolved topic is followed, and a topic that took a
  freed display name is another argue. `posts` are every participant's real
  posts — `kind` (`human` / `agent` / `ack`), `agent` (roster name),
  `speaker` (a logical one such as `sage:arxiv` for a post under that
  header) — plus `presentation`.
- `GET /argues/<anchor>/close-plan`, `POST /argues/<anchor>/close` →
  finishing it from the room (the completion door, below).

Argues are history since project_migration p8: opening one, posting in it
and asking for another interpretation were refused from then on, and their
routes are gone since retire_old_ui p1.

### `presentation` — speech and its character dialogue

The block in `/argues/<anchor>` (`presentation.py`):

- `memo` — the memo topic whose `[selfnote][memosource]` names the anchor;
- `interpretations` — one per `(settings_revision, renderer)` saved so far,
  with `results`, `posts`, `stale` counts. Older ones stay, and their
  portraits are served by `/settings/<revision>/…`;
- `renderings` — `{source message id: [{settings_revision, renderer, job,
  stale, turns, memo_message_ids}]}`; each turn keeps its `sources`, so a
  rendered line leads back to the posts it re-voices. A `plain` turn
  (`character: null`) is a speaker without a character: show the post;
- `pending` — agent posts with no fresh result at `active_revision`
  (`overdue` after 15 min), `failed` and `refused` — the renderer's own
  records, `requests` — interpretation requests seen in the source;
- `renderer` — `idle` / `rendering` / `unavailable` / `unknown`, with the
  reason. A result whose fingerprint no longer matches the source, or whose
  source post is gone, is `stale`.

## Closing an argue — the completion door (`front_desk` p3, p4; `argue` p2 ex1)

A request is rarely one topic: Front serves it in the conversations of the
agents it asks, and those open conversations of their own. When the thing is
done, all of that is still open. `closing.py` decides what the targets *are*
and `close.py` what would change, and does it. Since retire_old_ui p1 the
door is reached only by the Arguing Room, the argue named by its anchor. The human's click is the decision; nothing here judges whether the
work was good, and closing writes nothing but the ✔ renames.

- `GET /argues/<anchor>/close-plan` → `ag.completion.v1`: `root`, a
  `scope` block, the ordered `actions`, each with a `kind` (`topic`,
  `conversation`), a stable `key`, a `state` (`ready`, `done`,
  `blocked`, `kept`), the `reason` it is in that state and the `detail` it
  was decided from; plus `counts`, `excluded`, `gaps`, `status` (which
  credentials this relay has), `history` (this relay's earlier operations on
  the same request) and a `fingerprint`. It writes nothing.
- `POST /argues/<anchor>/close` `{fingerprint}` → applies it and answers
  the same payload with `results` (one row per target: `applied`, `already`,
  `failed`, `skipped`) and `partial`. `409` when the plan has changed since
  the preview — the refusal carries the fresh plan and **nothing is
  written**. The server closes what it derived, never what a browser named.

The rules below were written for every kind of request the door used to
take; an argue is the one that still reaches it.

**What a root is, and what it owns** (`closing.classify`, `Scope`,
`_ownership`, p4). A conversation's *kind* is its name — `desk`, `front`,
`routine-run`, `routine-guide`, `argue`, `intro`, or `topic` — and only the
request kinds (desk, front, a run, an argue) may be completed. Any other
topic carrying a root note is an execution topic: it answers with its
`scope.parents` and one blocked action. A routine guide or an introduction
is refused, because a ✔ there retires the routine or the agent. Whose a
reached topic is comes from its root notes: all naming this request (or
something it owns, or what the root itself was opened for) → owned; naming
anything else → *anchored to another request*, excluded with the note's
message id. A topic with no root note is owned when something owned reached
it — unless it is itself a request, which no served note can claim. A
routine run's `scope` also names its guide as `context`: untouched, and said
so — and the conversation the run was requested from is its `parent`, which
stays open. An argue's closure is the argue topic alone; what it led to is
listed as excluded.

The walk (`related_topics`) follows both link notes to a fixed point and
reads every reached topic's unread home once. Every read is under both
names; what could not be read is a gap.

How each target is decided:

- **A topic** by whether it was actually read. `note-only` is a gap, not a
  finished conversation, and blocks. A topic whose channel the realm no
  longer lists is `kept`: its posts read fine and cannot be moved (a resolve
  is a PATCH the realm answers 400), and nothing there is open to anybody —
  met live in p4 on a retired agent's archived channel. A ✔ topic with
  posts under its bare name (an open twin) is resolved again to fold them in.
- **The selected conversation last**, and only if nothing above is blocked
  or failed — a ✔ there is the claim that the whole thing is finished.

Nothing rolls back and nothing is retried automatically: every action is
idempotent in the realm's own terms (a resolved topic → `already`), so clicking again after a partial failure
finishes what is left and repeats nothing.

Credentials: the discovery reads the mirror (`OPSROOM_ZULIP_ENV`'s copy;
a topic whose coverage is not complete — one in an archived channel, say —
is hydrated once and kept) and the writes use `AGENTROOM_CHAT_ZULIP_ENV`
(the Developer — the credential that already posts here). A missing
write credential is reported in the preview's `status` rather than
discovered on submit. After the writes the answer waits — at most
`CONFIRM_SECONDS` (5) — for the mirror to carry them back as events, and
every applied result says `confirmed: true` or `false`; the preview's
`gaps.zulip_calls` is what the discovery actually spent on Zulip
(hydrations), beside `gaps.reads` for what it read from the copy. This
operation closes work; it does not stop a running agent.

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

## `/cost` — the pre-WFE agents' records, as history

`GET /cost` reads this host's `ag.agent-run.v1` records under
`AGENTROOM_AGENT_ROOTS` (`<root>/.local/agent/<role>/run-*.json`) and never
Zulip. Those agents (the legacy Front, arxivsage, agecho) ran before
workflow runs. Current execution usage is the workflow editor's
(`workflow_editor/docs/usage.md`), which shows this board as history. It
answers `ag.cost.v1`:

- `totals.{today,days7,days30,all}` and `days[]` (the last 14 local days),
  each with `runs`, `failed`, `usd_reported`, `usd_estimated`, the token
  totals and a `kinds` histogram, plus `by_harness` on the totals.
- `table[]` — one row per instance × role × harness × model.
- `unattributed`, `recent[]` (last 40 rows), `roots[]` (what was readable),
  `prices` (the table in use).

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
own lock, so a caller's poll costs one vendor call a minute per harness,
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
