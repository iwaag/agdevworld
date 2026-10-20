# Slack integration (`slack-front`, slack_connect p1)

The Developer talks with Front from the Slack app — on the iPhone included —
through direct messages with a private Front bot. Conversations and their runs
stay WFE's (`workflow_editor/docs/conversations.md`); aghangout shows the
same conversations. This process only carries messages: it never opens WFE's
database, starts Front itself, or interprets what a message means.

- A new top-level DM starts a WFE conversation with the configured
  destination (`target`, `front/converse`); replies in its thread continue
  it. Concurrent threads are concurrent conversations.
- Every accepted message is posted to WFE with `via: slack`, which starts one
  Front turn. 📥 on the message means: WFE has it and its turn was requested.
  Front's replies (`reply`, `question`, `progress`, `result`) arrive in the
  thread, each naming its run.
- Messages the person wrote in aghangout in a Slack-linked conversation
  appear in the thread, labelled as coming from aghangout. Browser-only
  conversations stay unlinked.
- Edits and deletions are not instructions; the bot says so. Attachment-only
  and audio-clip messages are explained, not forwarded; a caption is forwarded
  with a note that the attachment was not passed on. Keyboard dictation is
  ordinary text.
- `!status` and `!help` in the DM are answered by the integration itself.

Text works without the home network or VPN (Slack is the transport). Run,
artifact and aghangout links point at the tailnet name of the host, so they
open when the phone's Tailscale is on.

## Process and files

`src/main.ts` (`slack-front`), run by its own launchd job from a release
(`scripts/slack-release.sh`), independent of WFE's release and workers.

| File (`<area>/slack/`) | |
| --- | --- |
| `config.json` | `appToken` (xapp-, `connections:write`), `botToken` (xoxb-), `developer` (member ID), `team` (optional), `wfe`, `linkBase`, `linkMap` (LAN origin → phone origin for URLs in replies), `target` (the WFE destination of new conversations, `<workspace>/<workflow>`; required), `conversationUrl` (optional; `{conv}` is replaced by the id; default `<linkBase origin>/hangout/?conv={conv}`), `trialAuthor`, `store` (optional). Ignored, mode 600 |
| `slack.sqlite` | the transport store |
| `service.log` | the service's log (no tokens) |

Slack app: `manifest.yaml` (Socket Mode; bot event `message.im`; scopes
`chat:write`, `im:history`, `im:write`, `reactions:write`; the Messages tab
writable). Create it from the manifest, generate an app-level token with
`connections:write`, and install it to the workspace.

## Store

- `threads`: `(workspace, DM channel, root ts)` → conversation id (minted from
  the root's time, `YYYYMMDD-HHMMSS-s<µs>`), the cursor (last WFE message id
  carried), polling schedule and error.
- `inbox`: one row per Slack message (`<team>:<channel>:<ts>`; edits and
  deletions have their own keys), whichever route brought it (event, backfill,
  trial), with the raw event. `events` remembers envelope ids.
- `posts`: Slack message ↔ WFE message, both directions.
- `outbox`: one row per Slack post or reaction with a stable key
  (`wfe:<conv>:<message>:<part>`, `notice:…`, `react:…`) and its state.

## Reliability

1. An envelope is written to the inbox, then acknowledged. A redelivered
   envelope (same event id) or the same message from backfill is the same row.
   Nothing on the acknowledgement path waits for WFE or Front.
2. The inbox is processed oldest Slack timestamp first. The WFE post uses the
   submit token `slack:<team>:<channel>:<ts>`, so a retry after a lost answer
   or a crash is the same message and the same turn. An unavailable WFE is
   retried with backoff (the Developer is told once); a refusal (4xx) is
   reported in the thread and the row is `failed` (`slack-front retry`).
3. Linked conversations are polled with `GET api/conversations/<id>?since=`
   (5 s while active, 30 s within a day, 5 min after). New messages are queued
   and the cursor advanced in one transaction. A closed conversation or a
   completed run does not stop polling: late replies still arrive. A newer
   message of a run makes its queued progress update stale (`coalesced`).
4. Posts go out in order per thread, at most one per second per channel; a
   rate limit waits `Retry-After`. The delivery key travels as message
   metadata (`agdev_delivery`).
5. A post without an answer (timeout, connection loss, 5xx, or a restart while
   sending) is `unknown`. After 15 s the thread is read: found (by metadata, or
   by bot + text) → `sent`; absent → sent again (at most 3 sends); unreadable
   → stays `unknown`. Later posts of that thread wait up to 10 min for it.
   Slack delivery is not exactly-once: an unknown row that cannot be settled is
   left for the operator.
6. Socket Mode reconnects by itself. On every connection the DM history since
   the last live moment (less 5 min) and the replies of recent and linked
   threads are read into the inbox; a 15-minute sweep does the same while
   connected. The first start imports nothing from before it. A downtime
   longer than the free plan's 90-day history is recorded as a gap.

Slack history is a recovery aid; WFE keeps the accepted conversation.

## Operations

```sh
cd <area>/slack && export SLACK_FRONT_CONFIG=$PWD/config.json
node current/src/main.ts help
node current/src/main.ts check          # tokens, DM, WFE
node current/src/main.ts status         # connection, counts, unresolved, last backfill
node current/src/main.ts deliveries     # unknown / failed / waiting posts
node current/src/main.ts resolve <id> --sent <ts> | --resend | --drop --note <why>
node current/src/main.ts inbox; node current/src/main.ts retry <id>
node current/src/main.ts backfill --from 2026-10-19T00:00:00Z
node current/src/main.ts trial --text '…' [--conv <conv>]   # automated trial, recorded as trialAuthor
node current/src/main.ts fault lose-next-response            # exercise unknown-send reconciliation
```

Recovery:

- **Slack down / tokens revoked**: `status` shows `disconnected`/`reconnecting`
  and the log the reason. WFE and aghangout are unaffected. After a fix,
  the next connection backfills.
- **WFE down**: inbox rows wait (`inbox`), the Developer is told once per
  message; they go through when WFE answers.
- **Unknown delivery**: `deliveries` → look in the thread → `resolve`.
- **Restart**: `launchctl kickstart -k gui/$(id -u)/com.agdev.slack-front`.
  Sends interrupted by a stop become `unknown` and are reconciled.

## Checks

`npm run check` (types and `test/bridge.test.ts`: deduplication, thread
mapping, mirroring, input boundaries, unknown-send reconciliation, backfill,
deterministic splitting) against a fake Slack and WFE. Live behaviour (scopes,
metadata, notifications) is verified on the installed app.
