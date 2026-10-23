# Challenges (challenge p1, p3)

A challenge is a problem found during project work that is worth keeping
after that work is done: something to solve later, possibly in another
project, possibly together. It is a durable, shared record that anyone — a
person or an agent of any project — can record, find, carry into a later
conversation, discussion or request, and work on.

A challenge is independent of any conversation, project lifecycle or run.
Several projects and runs may work on it; completing a run never resolves
it; resolved and withdrawn challenges stay readable, searchable and open to
more work, and can be reopened.

Code: `server/challenges.ts`; CLI: `wfe challenge` (`wfe challenge help`);
HTTP: `api/challenges` (below).

## One directory per challenge

Everything the repository holds for a challenge is under its directory in
**one shared Git repository** (the area's `challenges.json` names it):

```text
challenges/
  ch-0001/
    summary.md              the standard statement (optional)
    voice.wav               source material (any names, any folders)
    wedo/
      speech-stretch/       a trial
        summary.md          optional
        evidence/output.wav
      another-approach/     another trial
        notes.md
        experiments/comparison.wav
```

- **The directory is the challenge.** Its name is the id: WFE allocates
  `ch-0001`, `ch-0002`, … for the challenges it creates; a directory made
  any other way (an ordinary Git commit) with a plain name (letters, digits,
  `.`, `_`, `-`) is a challenge too, with or without a summary. The id never
  changes; renaming the title keeps it.
- **Source material** that explains the challenge — an example input, a
  screenshot, a report — is anywhere in the directory outside `wedo/`.
- **Trials.** Each direct child directory of `wedo/` is one trial: an idea,
  an unsuccessful experiment, a partial solution, a better solution —
  whatever someone did or thought. Its name and contents are its author's;
  nothing is required inside. Its results and evidence belong inside it
  (`evidence/` above is an example, not a rule); shared input stays at the
  challenge's level and is linked, not copied. A trial may come from several
  runs and a run may add to several trials: a trial has no run identity of
  its own (the commits that wrote it name their runs).
- Git keeps no empty directory: a trial exists once it has a file. No
  placeholder is needed.

### The standard summary (optional)

`summary.md` at the challenge's level is the standard statement: frontmatter
with the management fields, then a free-form Markdown body.

```markdown
---
id: ch-0001
title: Object extraction leaves surrounding image at the edges
state: open
projects:
  - gimmickimg
---

Free-form Markdown: the problem, what is wanted, history, sources,
possible approaches — whatever helps. Link material with relative paths
(`voice.wav`, `wedo/speech-stretch/summary.md`).
```

- `title`: one line. Without one (or without a summary) the id is shown.
- `state`: `open`, `resolved` and `withdrawn` are the **standard
  vocabulary**, with the standard actions (resolve, withdraw, reopen). What
  they mean, and when to change them, is the local work's decision. Any other
  value is kept and shown as written (a *custom* state); none means
  *unspecified* — never read as `open`. Changing the state is an ordinary
  edit; say why in the body or in the edit's note (its commit message).
- `projects`: the related projects, for discovery and filtering. A retired or
  unregistered project may be named.
- Other frontmatter written by hand is kept. An edit changes only the fields
  it names: the rest of the frontmatter (its comments and order included)
  and, unless the body is given, the body stay byte for byte.
- A summary whose frontmatter cannot be read is still shown as written, with
  a note (`problem`); its fields can then only be changed by replacing the
  file.

A trial's `summary.md` is optional and has no required content: the UI shows
it when present and otherwise offers the trial's files. What was tried, what
was learned, which files show it and what is still open often help the next
reader; none of it is a checklist, and nothing reads a summary as an outcome.

### The layout before challenge p3

Until challenge p3 a challenge was `challenges/<id>.md` with its files in
`evidence/<id>/`. The repository was moved to directories by one ordinary
commit (`evidence/<id>/<f>` → `challenges/<id>/evidence/<f>`, links
rewritten); a commit from before it still reads exactly as it was (a
*pinned read* below shows `layout: legacy`). A file's **name** — its path
inside the challenge — is the same in both (`evidence/<f>`); its repository
`path` differs. The old layout is never written.

## Revisions and attribution

- **Git is authoritative.** A challenge's **revision** is the newest commit
  that changed anything in its directory (or, before p3, its file or
  evidence): the summary, a source file, a trial — whether written through
  WFE or by an ordinary Git commit. Every read returns it (`commit`), and
  each trial its own (`trials[].commit`).
- Who and when are recorded automatically, never typed into a file: each
  write through WFE is one commit whose **author is the actor** (the agent
  that wrote it, even on the Developer's behalf; the person for a page),
  with trailers:

  | trailer | |
  | --- | --- |
  | `Challenge-Id` | the challenge |
  | `Challenge-Request` | the request identity (deduplication) |
  | `Challenge-Actor` | who wrote it |
  | `Challenge-On-Behalf-Of` | whom an agent wrote it for, when said |
  | `Challenge-Base` | the revision a write was based on |
  | `Challenge-Trial` | the trial, when every file it changes is in one |
  | `Challenge-Run`, `Challenge-Attempt` | the run and attempt it came from |
  | `Challenge-Source` | `conversation <id>#<message>` it was recorded from |
  | `Challenge-Via` | `page`, `cli`, … |

  A commit made by hand has its Git author and no trailers.
- **History** is the repository's log of the challenge, across the layout
  change (`wfe challenge history <id> [--trial <name>]`, `GET
  api/challenges/<id>/history[?trial=]`).
- **A current read** is the newest published state (the index, refreshed
  from the remote at most every 10 s, and before every write). **A pinned
  read** names a commit (`--at <commit>`, `?at=<commit>`) and returns the
  challenge exactly as that commit has it: summary, files, trials and their
  summaries, created/last changed — nothing newer is mixed in. Message
  attachments and run inputs are pinned (below); a later edit or trial never
  changes what an earlier turn received.

## Writing: the journal and publication

Every write is first accepted into the area's journal
(`<area>/.local/challenges/challenges.sqlite`), then published: WFE's own
writer checkout (`<area>/.local/challenges/repo`), serialized under one
cross-process lock, commits it and pushes.

A write is one of:

- **create**: a new directory with its summary (title, body, projects,
  state — `open` unless named) and any source files;
- **edit**: summary fields (only those named change), and files added,
  replaced or dropped anywhere in the directory — or, naming a `trial`,
  inside `wedo/<trial>/`. **Publishing a trial** is such a write: a set of
  files (a local directory's tree, from the CLI) in one commit.

Files are named by their path inside the challenge (or the trial):
relative, `/`-separated, any depth and any names, except empty, `.`, `..` or
`.git` segments, control characters, quotes and backslashes. Nothing is
written through a symbolic link in the repository; the CLI publishes a local
directory without following a link out of it.

- **Request identity.** Each write carries one (`request`; the CLI derives it
  from the command, its files' bytes and the attempt unless `--request` names
  it). The same request again returns the same operation and writes nothing
  new.
- **Conflicts are about the files a write changes.** A write names the
  revision it was based on (`base`). It is refused at once (409 `conflict`,
  with the current challenge and the `changed` paths; nothing is journaled)
  when one of the paths it changes — the summary, a file it replaces or
  drops — changed since. Another trial, or another file, written meanwhile is
  no conflict. A write that only adds new files needs no base; a file that
  already exists is then refused. If a path changes on the remote after the
  write was accepted but before it is pushed, the operation becomes
  **`conflict`** and its draft stays in the journal (`wfe challenge ops`;
  its files: `GET api/challenges/operations/<n>/files/<name>`), never
  overwriting the other write; write it again on the current revision, or
  discard it.
- While a write is not published, another write of the same paths waits
  (409 `pending-edit`); writes of other paths do not.
- **Publication states** of an operation:

  | state | meaning |
  | --- | --- |
  | `pending` | accepted, not yet tried |
  | `published` | the remote history contains it (its `commit`) |
  | `unsynced` | the push failed, or its outcome was not seen; the content is kept and retried (every executor reconcile, `wfe challenge retry`) — it is **not** durable yet |
  | `conflict` | a path it changes changed on the remote after the base; the draft is kept |
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
- **The index** (`records` and `trials` in the same SQLite file) is derived:
  it is rebuilt from the repository whenever the remote head moves, and `wfe
  challenge reindex` rebuilds it from a fresh clone. Nothing is edited there.
  The journal (`operations`, `blobs`) is not derived: it holds what is not
  published yet.

### Limits

- A file is at most 32 MiB; one write adds at most 64 MiB in at most 500
  files — publish a larger set in several writes. The service refuses a
  request body over ~86 MiB (the files travel base64 in JSON); the agdev
  origin's proxy allows 100 MiB on `/wfe/`.
- The Git service has no large-file storage. A larger artifact belongs in a
  durable store with its own retention and backup, linked from a summary;
  such a link is as durable as that store, not part of the repository or
  its mirrors. A temporary presentation URL is not evidence.

## Reading and finding

- `wfe challenge list [--text <words>] [--project <id>] [--state <s>]` — every
  project's challenges. Text matches ids, titles, summaries and projects, and
  trial names and trial summaries (the trials that matched are named,
  `matches`); files are not searched, and nothing is inferred from them.
  `--state` is `all` (default), a kind — `open`, `resolved`, `withdrawn`,
  `custom`, `unspecified` — or one state exactly as written. Counts keep the
  kinds apart, with each custom state's count.
- `wfe challenge show <id> [--at <commit>]` — the summary, files and trials,
  the revision, creator and last change.
- `wfe challenge files <id> [--trial <name>] [--at <commit>]`, `wfe challenge
  file <id> <name> [--trial <name>] [--at <commit>] [--out <file>]`.
- `wfe challenge history <id> [--trial <name>]`.
- `wfe challenge status` — the repository, the indexed head, the last fetch
  and its problem, operations by state, mirrors and limits.

Creating, editing, listing or reading a challenge starts no run, assigns no
work, changes no state by itself and calls no model. Nothing interprets
conversation text, a summary or a file as an outcome: a challenge is
recorded and its state changed when someone does so, and a new trial —
successful or not, on an open, resolved or withdrawn challenge — changes no
state.

## Carrying a challenge into work

A challenge is **attached** to a message as `{id, commit}` (the commit
defaults to the current revision when the message is sent). The conversation
store keeps, per message, the challenge, the commit, its title and the hash
of its text at that commit (store v11 `attachments`).

- **Conversations** (one-to-one and facilitated alike): `challenges` on a
  person's message (`POST …/messages`; `wfe conversation post --challenge
  <id>[@<commit>]`). The view lists them on each message, with the latest
  revision beside the attached one when it moved.
- **The receiving run** — a conversation request's new run, or an ordinary
  request (`wfe request … --challenge <id>[@<commit>]`, the request route's
  `challenges`) — gets each attached challenge in its input: its text at the
  attached commit — the summary as written, or for a challenge without one a
  note listing its files — written into the run folder as
  `attachments/<id>@<commit12>.md`, and `input.attachments[]` (`{kind:
  challenge, id, commit, title, sha256, file}`) in `run.json`. Its brief
  names them and how to read its files and trials at that commit (`wfe
  challenge show <id> --at <commit>`). Files are not copied: they are read on
  demand. An attachment made before p3 still verifies: its text is read in
  the layout of its commit.
- **An answer or instruction delivered to a run already working** carries the
  references in its `source.attachments`; the brief names them.
- **Archives**: conversation transcript `message` records carry
  `attachments`.
- **Project context** may carry a short pointer to a relevant challenge; it
  is not a second editable copy of it, and nothing dumps every open
  challenge into a prompt.

## HTTP

| Route | |
| --- | --- |
| `GET api/challenges?text=&project=&state=&limit=&offset=` | `{disabled, status, counts, custom, total, offset, projects, challenges, operations}` (counts by kind; `custom`: each custom state's count; a challenge found by a trial carries `matches`; operations: the journal's open ones) |
| `POST api/challenges {request, title, body, projects?, state?, files?, source?, note?, author?, onBehalfOf?, run?, attempt?}` | create; `files: [{name, base64}]` (source material); `source: {conversation, message}`. Answers `{operation, duplicate, record, publication}` |
| `GET api/challenges/<id>[?at=<commit>]` | `{challenge, latest, pinned, operations}`; `challenge`: `{id, layout, dir, path, summary, title, state, stateKind, projects, body, extra, problem?, commit, created, updated, files, trials: [{name, dir, files, summary: {title, body, …} \| null, commit, created, updated}]}`; `latest`: the current revision and its trials beside a pinned one |
| `POST api/challenges/<id> {request, base?, title?, body?, projects?, state?, trial?, files?, drop?, note?, author?, …}` | edit, publish files or a trial (`trial` names `wedo/<trial>/`; `files`/`drop` are names inside it), resolve, withdraw, reopen; 409 `conflict` with `current` and `changed`, 409 `pending-edit`, 409 `legacy-layout`, 413 over the limits |
| `GET api/challenges/<id>/history[?trial=<name>]` | revisions, newest first, with the paths each changed |
| `GET api/challenges/<id>/files[?at=]` | the file listing |
| `GET api/challenges/<id>/files/<name>[?at=<commit>][&download=1]` | one file's bytes by its name in the challenge (`wedo/<trial>/…` for a trial's). Served as untrusted content: type by extension (HTML and scripts as text), `nosniff`, `content-security-policy: sandbox`; inline, or as an attachment with `download=1` |
| `GET api/challenges/operations/<n>` · `GET …/<n>/files/<name>` · `POST …/<n>/retry` · `POST …/<n>/discard {reason}` | the journal, a draft's files |

A page's writes are the configured person's (`conversations.json` `person`);
an automated trial names its own `author` (and `run`, `attempt`,
`onBehalfOf`). The write-origin rule is the service's (conversations.md,
*Browser clients*).

On an **execution node**, `wfe challenge` talks to the coordinator's routes
directly (`WFE_SERVICE` defaults to the node's coordinator): the files a write
names are read on the node and `--out` writes on the node.

## Configuration

`<area>/challenges.json` (ignored with the area):

```json
{ "repository": "<clone URL of the shared repository>", "branch": "main" }
```

Optional: `"mirrors": ["<URL>", …]` — backup copies on other hosts, pushed
after each publication and by every executor reconcile while behind (state
in `wfe challenge status`); `"sshCommand"` — how an `ssh://` mirror is
reached (`GIT_SSH_COMMAND` for mirror pushes only). A mirror is never read:
recovery is a clone of it pushed to a new repository, then `wfe challenge
reindex`.

Without it every route answers 503 with the reason, and attaching is refused.
Git credentials are the service's Gitea ones (`gitea.json`), passed per
command, never written into the clone.

The journal's schema is version 2 since challenge p3 (operations gained the
paths they change; the index was rebuilt). A release before p3 refuses it;
returning to one needs the journal file from before (no open operation is
lost if none was open).
