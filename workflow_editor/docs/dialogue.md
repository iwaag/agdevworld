# Character dialogue (argue p5)

The short reading view of a conversation (every conversation since challenge p2). Each agent message may also be read
as one short line in its speaker's character voice. The line is rendered
from the original speech by the client's renderer (aghangout's
`renderer/render.ts`). It is presentation only: the original message is
what the conversation, its progression, its archive, its overview and every
run work from. Code: `server/dialogue.ts`, `cli/dialogue.ts`; checks:
`test/dialogue.test.ts`; `wfe dialogue help`.

## Configuration

`<area>/conversations.json`, beside `projects`:

```json
"dialogue": {
  "renderer": "hangout/renderer-current/renderer/render.ts",
  "languages": ["ja", "en"],
  "follow": ["ja"],
  "concurrency": 2,
  "window": 40,
  "tries": 3,
  "env": { "AGHANGOUT_CLAUDE": "<the Claude Code binary>" }
}
```

| Key | Meaning |
| --- | --- |
| `renderer` | Path relative to the area, or absolute. Run as `node <renderer> describe\|render` with `env` added |
| `languages` | Languages a reader may ask for |
| `follow` | Languages in which new agent speech is rendered without a reader asking |
| `window` | How many missing lines one read may queue |
| `concurrency` | Renders at once |
| `tries` | Tries before a line is `failed` |

Without `dialogue`, reads answer `available: false` with the reason, and
every message stays as written.

## Where the lines are

The configured archive project's workspace keeps them in
`.local/character-dialogue/dialogue.sqlite` (today
`pj-ponderer/.local/character-dialogue/`). The path is resolved from
`archive` through the registry, and refused unless Git ignores
it there.

- **One writer.** This module writes it: the service's worker renders, and
  reads only queue.
- **Never published.** The archive writer works in its own clone and never
  sees it.
- **Never in a run.** A run copy takes only the regular files directly in
  the workspace's `.local/`, never folders (`runspace.ts`).
- **Through archive updates.** It survives pulls, run integrations and WFE
  or aghangout deployments, because none of them touch an ignored folder.
- **Loss.** If the folder is lost, readers see their lines pending and they
  are rendered again on demand: every line can be made again from the
  original speech. Only new speech after the worker's first start (the
  `follow` checkpoint) is rendered without being asked.

## Identity of a line

A line is keyed by the SHA-256 of these inputs:

- the renderer version and its model;
- the speaker's voice: the hash of its character's name, nickname, lore
  and style, or the neutral voice;
- the request (`ag.dialogue-request.v1`):
  - the language and the conversation's title;
  - the target message (id, speaker, kind, replies, addressees, text);
  - the context;
  - the participants' kinds and project names.

The context is the earlier messages the target replies to, plus the four
messages before it. These are originals only, never a rendering and never
anything later. Each is cut at 1,500 characters, marked `truncated`; the
target is cut only past 16,000.

A result records the following:

- conversation, message, language, speaker and character;
- renderer, model and the character export's commit;
- the target's hash, the context ids with their hashes, and the horizon
  (the newest message it saw);
- the text, the usage the renderer reported, and when it was made.

Changed source, context, character, renderer or model means a new key. The
older result stays in the store as local data but is never shown as the
current line; a read marks the message `stale` until the new line is in.

## Jobs

- **States.** A job is `queued`, `running` (leased for 5 minutes), `done`,
  `failed` (after `tries`, with the renderer's last error) or `dropped`.
  `dropped` means the renderer or the character changed before the job
  ran; the next read queues the new inputs.
- **No duplicates.** A job is unique by key, so a read, the follower and a
  retry never queue the same line twice.
- **Claims.** A claim moves one job from queued to running in one
  transaction, and counts the try.
- **Completion.** A result is accepted only if the renderer answers for the
  job's own renderer, voice and language. The result and the job's `done`
  are one transaction, so a restart neither loses nor duplicates a line. A
  second completion of the same job writes nothing.
- **Recovery.** A job's holder (`host:pid:nonce`) is recorded, and only
  the holder may complete it. A job held by a process on this host that is
  gone returns to the queue at the next tick; otherwise it returns when its
  5-minute lease runs out. A failure is retried after 20 s, 40 s and so
  on.
- **Priority.** Retries come first, then new speech, then reader windows.

**The worker** runs in the WFE service process (`DialogueWorker`, started
unless `WFE_NO_DIALOGUE` is set). Every 2 s it reclaims expired leases,
follows new agent messages of every conversation from its checkpoint (taken
at its first start, so history is never rendered wholesale), and renders
up to `concurrency` jobs. It holds no executor slot, starts no run and
never delays original speech: a message is delivered and readable before
any rendering of it exists. `wfe dialogue work` drains the queue in a CLI
process when the service is not running.

## Reads (the presentation path)

`GET api/conversations/<id>/dialogue?lang=ja[&since=<msg>][&queue=0]`:

```json
{ "discussion": "…", "language": "ja", "available": true, "problem": null,
  "renderer": { "version": "dialogue-4", "model": "sonnet", "characters": "<commit>" },
  "queued": 3,
  "items": [ { "message": 124, "participant": "Pat", "state": "original" },
             { "message": 126, "participant": "forge", "state": "ready", "text": "…", "character": "forge", "created": "…" },
             { "message": 127, "participant": "archsage", "state": "pending", "stale": true },
             { "message": 128, "participant": "argue", "state": "failed", "error": "…", "tries": 3 } ] }
```

- **States.**
  - `original`: the person's words, always shown as written;
  - `ready`: the line is in;
  - `pending` / `running`: the line is queued or being made;
  - `failed`: the renderer could not make it;
  - `unrequested`: beyond the read's window, or `queue=0`.
- **Queueing.** A read queues at most `window` missing lines and calls no
  model. Reading again queues nothing that is already queued, done or
  failed.
- **Retry.** `POST api/conversations/<id>/dialogue/retry {"message": n,
  "language": "ja"}` queues a failed line again. On a ready line it renders
  the line again, and the current line stays until the new one is in.
- **State.** `GET api/dialogue` gives the configuration, storage, renderer,
  jobs and failures.

Replies, citations, invitations, overviews and workflow records always name
original message ids; a line has no id of its own.

## What never reads it

None of the following reads the dialogue store, and none of their payloads
contains a line:

- `wfe conversation show|state`;
- `GET api/conversations[/<id>]`;
- the archive writer and its `manifest.json`/`transcript.jsonl`;
- overviews;
- invitations, context assembly for a run, and run copies.

`test/dialogue.test.ts` checks the view, the archive publication and a run
copy of the archive project.
