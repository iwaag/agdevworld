# Challenges (challenge p1)

A challenge is a problem found during project work that is worth keeping
after that work is done: something to solve later, possibly in another
project, possibly together. It is a durable, shared record that anyone — a
person or an agent of any project — can record, find and carry into a later
conversation, discussion or request.

A challenge is independent of any conversation, project lifecycle or run.
Several projects and runs may investigate it; completing a run never
resolves it; resolved and withdrawn records stay readable and searchable and
can be reopened.

Code: `server/challenges.ts`; CLI: `wfe challenge` (`wfe challenge help`);
HTTP: `api/challenges` (below).

## The record

One file per challenge, `challenges/<id>.md`, in **one shared Git
repository** (the area's `challenges.json` names it). Frontmatter holds only
the management fields:

```markdown
---
id: ch-0001
title: Object extraction leaves surrounding image at the edges
state: open
projects:
  - gimmickimg
---

Free-form Markdown: the problem, what is wanted, history, sources,
possible solutions, experiments, resolution evidence — whatever helps.
```

- `id`: allocated by WFE (`ch-0001`, `ch-0002`, …) when the record is
  accepted, and never changed. Renaming the title keeps the identity.
- `title`: one line.
- `state`: `open`, `resolved` or `withdrawn`. Changing it is an ordinary
  edit; say why in the body (or in the edit's note, which becomes the
  commit message).
- `projects`: the related projects, for discovery and filtering. No roles:
  explain a project's involvement in the body. A retired or unregistered
  project may be named; its records stay readable.
- Other frontmatter written by hand is kept as written.

The body has no template, no mandatory headings and no taxonomy. Write enough
that the record stays useful if the conversation or run it came from is
removed: quote what matters, and link sources as well.

**Evidence** files essential to understanding it are `evidence/<id>/<name>`
in the same repository, referenced from the body with relative paths
(`../evidence/ch-0001/edge.png`). A file is at most 32 MiB; the Git service
has no large-file storage enabled, so larger material belongs in a durable
store with its own retention and backup, linked from the body. A temporary
presentation URL is not evidence.

## Revisions and attribution

- **Git is authoritative.** A record's **revision** is the newest commit that
  changed its file or its evidence; every read returns it (`commit`).
- Who and when are recorded automatically, never typed into the record:
  each accepted write is one commit whose **author is the actor** (the agent
  that wrote it, even on the Developer's behalf; the person for a page), with
  trailers:

  | trailer | |
  | --- | --- |
  | `Challenge-Id` | the record |
  | `Challenge-Request` | the request identity (deduplication) |
  | `Challenge-Actor` | who wrote it |
  | `Challenge-On-Behalf-Of` | whom an agent wrote it for, when said |
  | `Challenge-Base` | the revision an edit was based on |
  | `Challenge-Run`, `Challenge-Attempt` | the run and attempt it came from |
  | `Challenge-Source` | `conversation <id>#<message>` it was recorded from |
  | `Challenge-Via` | `page`, `cli`, … |

- **History** is the repository's log of the record (`wfe challenge history`,
  `GET api/challenges/<id>/history`).
- **A current read** is the newest published revision (the index, refreshed
  from the remote at most every 10 s, and before every edit). **A pinned
  read** names a commit of the record's history (`--at <commit>`,
  `?at=<commit>`) and returns the record exactly as it was then. Message
  attachments and run inputs are pinned (below); a later edit never changes
  what an earlier turn received.

## Writing: the journal and publication

Every create or edit is first accepted into the area's journal
(`<area>/.local/challenges/challenges.sqlite`), then published: WFE's own
writer checkout (`<area>/.local/challenges/repo`), serialized under one
cross-process lock, commits it and pushes.

- **Request identity.** Each write carries one (`request`; the CLI derives it
  from the command's content and attempt unless `--request` names it). The
  same request again returns the same operation and writes nothing new.
- **Base revision.** An edit names the revision it was based on (`base`). If
  the record changed since, the edit is refused at once with the current
  revision (409 `conflict`) and nothing is journaled: the writer keeps the
  draft, reads the newer revision, and saves again on it. If the remote
  changes after the edit was accepted but before it is pushed, the operation
  becomes **`conflict`** and its draft stays in the journal
  (`wfe challenge ops`), never overwriting the other edit; save it again on
  the current revision, or discard it.
- One open (unpublished) edit per record at a time (409 `pending-edit`).
- **Publication states** of an operation:

  | state | meaning |
  | --- | --- |
  | `pending` | accepted, not yet tried |
  | `published` | the remote history contains it (its `commit`) |
  | `unsynced` | the push failed, or its outcome was not seen; the content is kept and retried (every executor reconcile, `wfe challenge retry`) — it is **not** durable yet |
  | `conflict` | the record changed on the remote after the base; the draft is kept |
  | `refused` | it can never be written as is (e.g. its id exists remotely, written outside WFE) |
  | `discarded` | dropped by someone (`wfe challenge discard`) |

  A write answers with the operation and its publication; only `published`
  means durable.
- **Recovery.** Before writing anything, every publication fetches and looks
  for each operation's request in the remote history: a crash after a
  successful push, or a push whose answer was lost, is recognised and
  recorded as published, never written twice. A rejected push starts again
  from the new remote state. Nothing is force-pushed. The writer checkout is
  disposable: it is reset to the remote at every publication, and rebuilt
  when it names another repository.
- **The index** (`records` in the same SQLite file) is derived: it is rebuilt
  from the repository whenever the remote head moves, and `wfe challenge
  reindex` rebuilds it from a fresh clone. Records are never edited there.

## Reading and finding

- `wfe challenge list [--text <words>] [--project <id>] [--state open|resolved|withdrawn|all]`
  — every project's records; text matches id, title, body and projects.
- `wfe challenge show <id> [--at <commit>]` — the record with its revision,
  creator, last change and evidence.
- `wfe challenge evidence <id> [<name>] [--at <commit>] [--out <file>]`.
- `wfe challenge history <id>`.
- `wfe challenge status` — the repository, the indexed head, the last fetch
  and its problem, and operations by state.

Creating, editing, listing or reading a challenge starts no run, assigns no
work and calls no model. Nothing interprets conversation text as a
challenge by itself: a challenge is recorded when someone records it.

## Carrying a challenge into work

A challenge is **attached** to a message as `{id, commit}` (the commit
defaults to the current revision when the message is sent). The conversation
store keeps, per message, the challenge, the commit, its title and the file's
sha256 at that commit (store v11 `attachments`).

- **Conversations and discussions**: `challenges` on a person's message
  (`POST …/messages`; `wfe conversation post|discussion post --challenge
  <id>[@<commit>]`). The view lists them on each message, with the latest
  revision beside the attached one when it moved.
- **The receiving run** — a conversation turn, a discussion invitation's new
  run, or an ordinary request (`wfe request … --challenge <id>[@<commit>]`,
  the request route's `challenges`) — gets each attached challenge in its
  input: the file as it was at the attached commit, written into the run
  folder as `attachments/<id>@<commit12>.md`, and `input.attachments[]`
  (`{kind: challenge, id, commit, title, sha256, file}`) in `run.json`. Its
  brief names them and how to read the evidence (`wfe challenge evidence <id>
  --at <commit>`). Evidence is not copied: it is read on demand.
- **An answer or instruction delivered to a run already working** (a
  discussion reply to the run that asked, the conductor's continuation)
  carries the references in its `source.attachments`; the brief names them
  and `wfe challenge show <id> --at <commit>` reads the pinned text.
- **Archives**: discussion transcript `message` records carry
  `attachments`.
- **Project context** may carry a short pointer to a relevant challenge; it
  is not a second editable copy of its body, and nothing dumps every open
  challenge into a prompt.

## HTTP

| Route | |
| --- | --- |
| `GET api/challenges?text=&project=&state=&limit=&offset=` | `{disabled, status, counts, total, offset, projects, challenges, operations}` (operations: the journal's open ones) |
| `POST api/challenges {request, title, body, projects?, state?, evidence?, source?, note?, author?}` | create; `evidence: [{name, base64}]`; `source: {conversation, message}`. Answers `{operation, duplicate, record, publication}` |
| `GET api/challenges/<id>[?at=<commit>]` | `{challenge, latest, pinned, operations}` |
| `POST api/challenges/<id> {request, base, title?, body?, projects?, state?, evidence?, drop?, note?, author?}` | edit (also resolve, withdraw, reopen); 409 `conflict` with `current`, 409 `pending-edit` |
| `GET api/challenges/<id>/history` | revisions, newest first |
| `GET api/challenges/<id>/evidence/<name>[?at=<commit>]` | the file's bytes |
| `GET api/challenges/operations/<n>` · `POST …/<n>/retry` · `POST …/<n>/discard {reason}` | the journal |

A page's writes are the configured person's (`conversations.json` `person`);
an automated trial names its own `author`. The write-origin rule is the
service's (conversations.md, *Browser clients*).

## Configuration

`<area>/challenges.json` (ignored with the area):

```json
{ "repository": "<clone URL of the shared repository>", "branch": "main" }
```

Without it every route answers 503 with the reason, and attaching is refused.
Git credentials are the service's Gitea ones (`gitea.json`), passed per
command, never written into the clone.
