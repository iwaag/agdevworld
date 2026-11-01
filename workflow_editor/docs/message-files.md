# Message files (workflow_editor p19)

A person's message can carry ordinary files: a pasted screenshot, a photo,
a PDF, a zip. Each file is an **occurrence** tied to exactly one accepted
message. Every participating project, and an agent executing on another
host, can list and fetch it, and checks it against the hash recorded when
the message was accepted. Episode: `devdocs/episodes/workflow_editor/p19/`.

Code: `server/messageFiles.ts` (configuration, limits, validation, bundle
publication, upload operations, retrieval, integrity, export, backup);
`server/conversationService.ts` `post` (acceptance); CLI `wfe conversation
attachments|fetch|uploads|export|restore|backup` (`cli/messageFiles.ts`);
HTTP below. Fixture for clients: [fixtures/message-files.json](fixtures/message-files.json).

Files are not challenges. A challenge is a durable problem record pinned
from its repository ([challenges.md](challenges.md)); a message file is a
byte payload the message carried. A message may carry both; `attachments`
is a list of both kinds (`kind: challenge | file`).

## Where the bytes are

`<area>/attachments.json` (ignored operating configuration) names the
destination as a logical share and a relative prefix:

```json
{ "share": "agshare", "prefix": "conversations" }
```

Each host resolves the share through its own `shares.json`
([shares.md](shares.md)); no tracked record contains a mount path. A
message's files are one **bundle**:

```text
shared://<share>/<prefix>/<conversation>/attachments/<bundle-id>/
  manifest.json          ag.message-files.v1: the ordered files, hashes, and the bundle digest
  <attachment-id>        the original bytes (the original name is metadata)
```

- WFE allocates `bundle-id` (`b-…`) and `attachment-id` (`f-…`, globally
  unique). A client's file name never becomes a path.
- A bundle is written in a staging folder on the share, every landed file
  is hashed again, the manifest is written, and the folder is renamed into
  place: a reader never sees a partial bundle.
- WFE never overwrites a published bundle and never deletes a committed
  file. Closing or archiving a conversation, or retiring a project, deletes
  nothing.
- Identical bytes or names in two messages, or twice in one message, are
  separate occurrences with separate ids.

The manifest:

```json
{
  "kind": "ag.message-files.v1",
  "conversation": "<id>", "bundle": "b-…", "share": "agshare", "path": "conversations/<id>/attachments/b-…/",
  "files": [{ "id": "f-…", "ordinal": 1, "name": "screenshot.png", "mime": "image/png", "bytes": 12345, "sha256": "…" }],
  "digest": "sha256:<canonical JSON of the body without digest>"
}
```

The manifest has no message number: the bundle is published before the
message exists. The authoritative association (conversation, message,
ordinal, attachment id) is written with the message in one SQLite
transaction (store v14, table `message_files`), and the archive keeps it.

## Limits

| | |
| --- | --- |
| files per message | 20 |
| one file | 32 MiB (33554432 bytes) decoded |
| all files of a message | 64 MiB (67108864 bytes) decoded |
| file name | 1–255 characters, no `/`, `\`, NUL or control characters |
| request body | 90527062 bytes (the base64 of 64 MiB and 1 MiB for the rest); nginx allows 100m on `/wfe/` |

Clients read the limits and whether files can be accepted now from
`attachmentFiles` in `GET api/conversations` and in a conversation's view:

```json
{ "available": true, "problem": null, "files": 20, "fileBytes": 33554432, "totalBytes": 67108864, "requestBytes": 90527062, "nameLength": 255 }
```

`available: false` (with `problem`) means the destination is not configured
or not reachable here: text-only messages still work.

## Sending

`POST api/conversations/<id>/messages` (and the first message of `POST
api/conversations`) takes, besides `text, token, with?, title?, to?, runs?,
re?, via?, challenges?`:

```json
{ "files": [{ "name": "screenshot.png", "base64": "<standard base64, no data: prefix>", "mime": "image/png" }] }
```

- `text` may be empty (or absent) when `files` has at least one file. The
  text is kept as written; nothing is invented in its place.
- An untitled new room (`with`, no `title`) takes its original title from
  the text's first line, else from the first file's original name.
- `mime` is the client's hint, recorded as such. It never makes the service
  render content (see *Reading*).
- Routing is the ordinary routing (*Routing a person's message* in
  [conversations.md](conversations.md)); the files reach every request the
  message makes.

**The submit token is the operation.** WFE records an upload operation per
conversation and token with the author and a digest of the submission: the
text, each file's name, hint, size and SHA-256 in order, the challenges named
and the routing fields (`to`, `runs`, `re`, `with`, `title`, `via`).

- Retrying with the **same token and the same payload** is the same
  operation: after acceptance it returns the accepted message and requests
  (`duplicate: true`) without routing, publishing or dispatching again.
- The same token with **different content or author** is refused: 409
  `token-conflict`. A client that edits a failed submission mints a new
  token; a retry keeps the token and the payload.
- Challenge revisions are pinned once, at the first reservation, and reused
  by every retry of that operation.

Acceptance order: validate → reserve the operation → publish the bundle
(outside any database transaction, one owner at a time) → route again and
write the message, its `message_files` rows, its requests and the
operation's `accepted` state in one transaction → dispatch the requests
through the ordinary receipts. A route that became invalid meanwhile fails
the post; nothing is partially accepted, and the published bundle stays for
the retry. A failed upload never becomes a text-only message.

Operation states: `reserved` (identities allocated), `published` (the
bundle is complete on the share, manifest digest recorded), `accepted` (the
message exists), `failed` (with the error; the next retry of the same
payload starts again from `reserved`, reusing its identities). After a
restart a matching complete bundle is verified and adopted; a staging
folder left by a dead process is removed by the next attempt; the bytes of
an incomplete upload are not recoverable — the client resends the same
payload with the same token. A published bundle that no message accepted
is kept for the retry and for diagnosis (`wfe conversation uploads <id>`);
it is not a sent message.

The response is the ordinary one: `{sent, duplicate, reopened, created,
message, requests}`; `message.attachments` lists the files.

### Errors

Every error is `{error, detail: {code, …}}`; routing errors are unchanged
(`choose-recipient`, `left`, `unknown-run`, …).

| Status, `code` | |
| --- | --- |
| 400 `invalid-attachment` | a file is not `{name, base64, mime?}`, its name or hint is not acceptable, or its base64 is malformed (`detail.file`: its position) |
| 413 `attachment-limit` | too many files, a file or the total too large, or the body too large (`detail.limit`, `detail.actual`) |
| 409 `token-conflict` | the token was used for another submission (`detail.operation`) |
| 503 `storage-unavailable` | no destination configured, or its share is not reachable here (`detail.state`); text-only messages still work |
| 404 `attachment-not-found` | (reads) no such attachment of that message of that conversation |
| 410 `attachment-missing` | (reads) the record exists, its bytes are not on the share |
| 409 `attachment-integrity` | (reads) the bytes on the share are not the recorded ones (size or SHA-256) |

## Reading

A message's `attachments` (in the view, history, the post's response and the
archive) carries, for each file:

```json
{ "kind": "file", "id": "f-…", "bundle": "b-…", "conversation": "<id>", "message": 42, "ordinal": 1,
  "name": "screenshot.png", "mime": "image/png", "bytes": 12345, "sha256": "…",
  "ref": "shared://agshare/conversations/<id>/attachments/b-…/f-…",
  "preview": "image", "api": "api/conversations/<id>/messages/42/attachments/f-…", "url": "<absolute, when the service knows its base>" }
```

`preview` is `image` for PNG, JPEG, GIF and WebP whose bytes begin with that
format's signature (checked at acceptance), `text` for plain text names
(`.txt`, `.md`, `.csv`, `.log`, `.json`), otherwise `null`. Challenge
attachments keep their shape (`kind: challenge`, `id`, `commit`, `title`,
`sha256`, `latest`).

| Route | |
| --- | --- |
| `GET api/conversations/<id>/messages/<n>/attachments` | `{conversation, message, attachments}` |
| `GET`/`HEAD api/conversations/<id>/messages/<n>/attachments/<attachment>[?download=1]` | the original bytes. The whole tuple (conversation, message, attachment) must match a record. `GET` checks the SHA-256 before sending; `HEAD` checks the size |
| `GET api/conversations/<id>/attachments/verify[?message=<n>]` | explicit integrity verification: every file's state `verified`, `missing`, `altered` or `unavailable` |

Responses: `content-length`, `x-content-type-options: nosniff`,
`content-security-policy: sandbox`, `content-disposition` with the original
name (`inline` for a preview, `attachment` otherwise or with `download=1`),
`x-attachment-sha256`. Previews are served as their image or as
`text/plain`; everything else — SVG, HTML, scripts, executables — is
`application/octet-stream` as a download. A client's hint is never the
served type. Uploading never runs, converts or rewrites a file; a future
thumbnail would be a separately identified derivative.

Ordinary metadata and history reads hash nothing. Missing, altered and
unavailable states are reported as such, never as an empty message.

## Runs

Every path that carries a message to work carries its files, with their
source message: a new run of any role (`input.attachments`, named in the
initial brief), the answer to an open question and an explicit instruction
(`source.attachments`, named in the continuation brief), a standing
conductor woken by the room's words, and later requests whose `re` cites
the message. Occurrences are kept by attachment id: two files with one name,
or one file in two messages, stay two entries. Reading a conversation or
fetching a file starts nothing.

Bytes never enter a run's Git history. An agent fetches what it needs:

```text
wfe conversation attachments <id> --message <n> [--verify]
wfe conversation fetch <id> --message <n> --attachment <f-…> [--out <path>]
```

`fetch` writes on the host it runs on — on an execution node too. It reads
the share where this host mounts it, else downloads from the coordinator
(`api/conversations/…`), checks the SHA-256, and only then moves the file
into place (default `.local/attachments/<id>/m<n>/<ordinal>-<name>`, which
is ignored). A local copy is a convenience; the record is the share's
bytes and their hash.

## Archive, export and backup

- The archive transcript keeps each message's attachments (both kinds),
  and the archive repository keeps each bundle's `manifest.json` beside the
  transcript (`<path>/attachments/<bundle>/manifest.json`). The bytes stay
  on the share: a clone of the archive restores the records, not the files.
  Archive publication and payload verification are separate facts.
- `wfe conversation export <id> --out <dir>` writes a self-contained
  recovery package: the transcript, the manifests, every original file and
  `package.json` (`ag.conversation-package.v1`) with every hash. Hashes are
  checked while packaging. Pinned challenges are not embedded: restoring
  their content still needs `pj-challenges` beside it.
- `wfe conversation restore <package> --into <dir>` unpacks into an isolated
  folder, checking every hash, and reports the message ↔ file associations.
  It writes no store, starts no run and replays no delivery.
- `wfe conversation backup [--status]` copies accepted bundles to the
  backup destination named in `attachments.json` (`"backup": {"host",
  "path", "ssh"?}`) outside the live share and reads every copied file's hash
  back from there. Each bundle's backup state is recorded (store v14
  `file_backups`); the executor's reconcile runs it. `wfe conversation
  backup --restore <bundle> --into <dir>` brings a bundle back from the
  backup and verifies it.
