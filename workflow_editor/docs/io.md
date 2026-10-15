# Detailed IO (`workflow_editor` p10)

Every run gets one Zulip channel that shows what its attempts did, in
detail: the agent's public messages, its tool calls and their results, and
where each attempt began and ended. The request receipt links to it, and so
does the run view. It complements the run's two conversations
([runs.md](runs.md), *Two conversations*): the request topic is where the
person talks with the agent; the progress topic says what happened; the IO
channel shows how.

## Identity and place

| Zulip | Entity | Name (a label) | Identity |
| --- | --- | --- | --- |
| channel | one run | `wf-<project>.<workflow>.<run>.io` (cut to 60 characters with a hash) | the recorded channel id, bound to the run's creation-qualified uid (`<project>/<workflow>/<run>#<creation>`, [observation.md](observation.md)) |
| topic | the run's IO | `io` | — |

The channel lives in the project's folder. Its description names the run
uid; the transport adopts an existing channel of that name only when the
description is this one (the notifier's usual rule), and a recreated run with
a reused id is a visible naming problem, never a merge. The channel stays the
same across the run's attempts and sessions.

**Output only.** The intake reads only workflow channels; the IO channel is
not one, so nothing posted there becomes input or wakes an agent. Messages
mention nobody (mention syntax in agent text is broken with a zero-width
space; tool output sits in code fences).

## Source and what is shown

The source is each attempt's own log on the execution host (the agent's
stdout, `<area>/.local/exec/logs/<attempt>.jsonl`), the file the run view's
activity line already reads ([runs.md](runs.md), *Activity*). Claude Code's
stream-json events become entries:

| Event | Shown as |
| --- | --- |
| `system/init` | "session <id> started — <model>, Claude Code <version>" — nothing else of the harness configuration (tools, servers, paths, sockets) |
| `assistant` text | the agent's message |
| `assistant` `tool_use` | "→ <tool>" with its command, path or query |
| `user` `tool_result` | "← <tool>" (error marked) with its output |
| `result` | "session ended: <subtype>, turns, duration, cost" |
| background task stopped/killed | a note |
| `thinking`, `redacted_thinking` | never: model reasoning is not public output |
| rate-limit, token accounting | never: bookkeeping |

A log in another format is shown as raw text. Attempt boundaries are
messages of their own: "Attempt a… began" (with why: start, resume, and the
backend) and "Attempt a… ended — <what the record says>". The record's
outcome is used, not the exit code alone (an exit that left work running is
an interruption).

**Redaction** before anything is rendered: common credential formats (API
keys, tokens, bearer and basic authorization, passwords in `key=value`,
credentials in URLs) and the exact values of the host's credential files
named in `io.secretFiles` (KEY=VALUE or JSON) become `***`.

## Messages and long output

Entries are grouped into messages of at most 3500 characters, each headed by
its attempt and log line range, with the marker `ref io <workflow>/<run>
#io:<attempt>:<part>` as its last line. A body longer than 900 characters is
cut; the cut says how long it was and where the whole entry is:

- with a reachable view address (`zulip.json` `viewBase`), a link to the run
  view's IO page `#/ws/<ws>/run/<workflow>/<run>/io/<attempt>/<line>`
  (`GET /api/workspaces/<ws>/runs/<wf>/<run>/io?attempt=&line=`);
- otherwise, the command on the execution host: `wfe run io <run> --attempt
  <a> --line <n>`.

Both show the entry redacted the same way, never the raw log. While an
attempt writes, small increments wait for about 15 s of quiet (or 1500
characters) so one burst of work is one message.

## Durability

- Positions persist in the notifier's store (`io_attempts`: per attempt the
  byte offset, line, file identity and the reader's open tool calls).
  Nothing is relayed twice; a restart of the transport, the service or the
  executor goes on where it stopped.
- **Gaps are said, never hidden.** A log that shrank or was replaced
  (another inode) after part of it was relayed, and a log of an ended
  attempt that is not on the host, each get a message that says what is
  missing.
- Messages are notifier deliveries (`runs.kind = io`, key `<ioKey>/io`):
  frozen when first claimed, journaled, retried with backoff, looked for by
  marker before a resend. A Zulip outage keeps them owed and is shown as a
  delivery problem; it never touches the execution slot or the run.
- Reading the logs happens in the notifier's pass on the transport's thread,
  outside the agent's execution.

## Links

- **Request receipt** (the request topic's "Request received") and the run
  topic's "Started" carry `Progress`, `Detailed IO` and `Run` lines. While
  the IO channel is not provisioned yet, the receipt says "Detailed IO: being
  set up; a follow-up message here gives its link" — no link that does not
  open — and the follow-up "Detailed IO of run … is ready: <link>" comes once
  it exists.
- **Run view**: the title band names Conversation, Progress and Detailed IO
  (Simple and Detail); `GET …/notify` carries `io {state, url, attempts}`.
- **Delegation**: the parent's messages about a child (result, failure,
  cancellation) and its delegations view link to the child's conversation,
  progress, IO and run view. The child's IO is never copied into the
  parent's channel.

## Configuration

`<area>/zulip.json`:

```json
{ "io": { "enabled": true, "since": "2026-10-15T00:00:00.000Z", "secretFiles": ["…/gitea.json", "…/forge.env"] } }
```

Runs created before `since` get no IO channel: logs that were never relayed
are not manufactured into one. `wfe run io <run>` shows the channel, each
attempt's relayed position and any gap.
