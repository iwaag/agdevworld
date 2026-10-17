# Shared areas: large inputs and outputs outside Git (project_migration p6)

A **shared area** (a *share*) is a folder that several hosts reach — an NFS
export, or the server's own backing folder — known to every project by a
logical name. A person supplies large inputs by putting a folder there and
naming it in the request; a run records exactly which bytes it used and
publishes large outputs back to the share. Tracked records hold references
and manifests; the payload never enters Git, the editor state or a
presentation bundle.

Distributed execution, Google Drive, a storage-provider framework, automatic
retention and garbage collection are not part of this contract.

## References

`shared://<share>/<path>` names a file, `shared://<share>/<path>/` (trailing
slash) a folder, `shared://<share>/` the share's root. `<share>` matches the
project id pattern; `<path>` is a normalized relative path (no `..`, no
leading slash). A reference never contains a host path.

References are found in the **words** of the input: a braindump, a request,
a Zulip post that became one, a delegation's request. `run.create` records
each one once, in order, in `input.references`. No upload form exists: the
person describes the folder in prose and the reference travels with it.

## Where a share is on this host

`<area>/shares.json` (ignored, per host; part of the operating area's control
data, backed up by `wfe migrate`):

```json
{ "shares": { "agshare": { "root": "/mnt/agshare", "marker": ".wfe-share.json", "publicBase": null } } }
```

| Field | Meaning |
| --- | --- |
| `root` | Absolute folder where this host reaches the share. Two hosts may use different paths for the same share |
| `marker` | File at the root that names the share: `{"share": "agshare"}`. Default `.wfe-share.json`; `null` disables the check. An automount that did not happen or a server that is down leaves an empty mount point without the marker, which is reported **unmounted**, never "an empty folder" |
| `publicBase` | Optional http(s) base from which the LAN downloads the share. Without it, downloads go through this service: `<present.json answerBase>api/shares/<share>/<path>` |

A share must not overlap the operating area.

Resolution states: `ok`, `unknown-share` (not configured here),
`unmounted`, `absent`, `outside` (a path or symbolic link escaping the share,
or an overlap with the area), `not-a-folder`, `not-a-file`.

## Input sets

`wfe run input <run> <node> --ref <reference> [--stage copy|in-place]` —
from a running node — reads the files the reference holds now and records an
**input set** `i<n>`:

- Files are regular files under the reference, relative to it; dot entries
  (`.DS_Store`, markers, unfinished publications) are not content; symbolic
  links are refused; at most 20,000 files.
- `inputs/i<n>.json` in the run folder is the manifest: `{kind:
  "ag.wfe-input-set.v1", id, ref, staging, staged, digest, files: [{path,
  bytes, sha256}]}`. The **digest** is `sha256:` + hex SHA-256 of the
  canonical JSON of `{kind, ref, files sorted by path}`. Same bytes under the
  same reference give the same digest.
- `copy` (default): each file is hashed as it is copied into the run copy's
  `.local/inputs/i<n>/`, and the copy is hashed again from disk. Work reads
  that copy, so later changes on the share never reach the run. `in-place`:
  the files are only hashed where they are.
- The folder must not change while it is read (sizes and file list are
  compared afterwards); otherwise nothing is recorded (`input-changed`).
- Reading, hashing and copying happen outside the run's lock; the id, the
  move of the staged copy into place, the manifest and the record are one
  locked step. A retransmission with the same receipt records once.
- Selecting again is a new set. Nothing replaces one.

`input.observe` records what a later check found on a host: `verified`,
`changed` (a file differs, grew, shrank or is extra) or `missing`. A
continued attempt re-checks every input set (sizes, bounded) before its brief
and records the result, so a changed or missing set is a recorded fact and is
never silently consumed as if it were the selected one. `wfe run inputs
--verify <i>` re-reads every byte.

## External outputs

`wfe run publish <run> <node> --source <folder> --title <t> --candidate <name>
[--share <s>] [--input <i>]...` — from a running node — publishes a folder of
the run copy (usually under `.local/`) as **output** `o<n>`:

- Destination: `shared://<share>/runs/<project>/<workflow>/<run>/o<n>/`.
- Files are copied into `.partial-<random>/` beside it, each hashed as read
  and as landed — outside the run's lock, so concurrent candidates publish at
  once. Under the lock the id is taken, `.wfe-output.json` (the manifest) is
  written inside and the folder is renamed into place. A reader never sees a
  partial publication as published; `.partial-*` folders are not content and
  are never served. Unfinished folders (`.partial-<host>-<pid>-*` on the
  share, `.staging-<host>-<pid>-*` in the run copy) left by a process killed
  mid-copy are removed by the next copy on the same host; another host's, or
  a live process's, is never touched.
- The manifest: `{kind: "ag.wfe-external-artifact.v1", id, ref, candidate,
  inputs: [input-set digests], digest, files, run, project}`; the digest
  covers `{kind, ref, candidate, inputs sorted, files sorted}`. A copy is
  kept in Git as `outputs/o<n>.json`; the payload stays on the share.
- **Candidate** names the approach or variant. Outputs of other candidates
  coexist; a later output of the same candidate supersedes an earlier one in
  a confirmation.
- Retries: a folder left finished on the share by a crash before the record
  is adopted when it is this same publication (same digest, files verified).
  A folder with other content is never touched: the next id is used, making a
  clearly distinct publication. Altered files under a matching manifest are
  refused (`output-altered`).

`output.observe` records a check (`wfe run outputs --verify <o>`, or the run
view's Verify).

## Confirmation

`wfe run ask <run> <confirming node> … --output <o>` (optionally with
`--presentation <p>` as a small preview): the file layer re-reads every byte
of the output against its manifest; only a `verified` output is presented.
The manifest file is recorded as a confirmation subject by hash, and the
question keeps `output: {id, digest}`.

`run.decide accepted` on that question re-checks the output (sizes) and is
refused when it went missing or changed (`output-missing`,
`output-altered`), or when a later output of the same candidate was published
after the question (`output-superseded`). The decision keeps
`confirmation.output`. A replaced output is always a new revision: publish
again and ask again.

## Reading and downloading

- `wfe run inputs|outputs <run>` and the run view's **Shared data** section
  show references, sets and outputs with this host's state. Views stat; they
  never hash or list large folders. A full check runs only on request.
- `GET|HEAD /api/shares/<share>/<path>` streams one file with byte ranges, or
  lists a folder (at most 2000 entries) as JSON. Dot entries are not served.
  Read-only. The project file API is unchanged and never reaches a share.
- `wfe share list|resolve|ls|verify` works on this host without a run.
  `wfe share verify <manifest.json>` checks an input-set or output manifest
  — taken from any run record or received by itself — against this host's
  share: how another PC verifies a delivery it got only by reference.

## Large files and run branches

A run branch never carries large files. A checkpoint leaves a file over
50 MiB (`WFE_CHECKPOINT_MAX_BYTES`) uncommitted in the copy and records a
publication problem naming it; a run branch whose unpublished commits carry
such a blob (the agent's own commit) is not pushed. Large outputs go to a
shared area (`wfe run publish`). Found in project_migration p6 Step 7, where
materials re-saved with embedded textures (≈2 GB) reached a run branch and
would have entered the project's history at integration.

## Where things live

| Fact | Authority |
| --- | --- |
| What the person pointed at | `run.json` → `input.references` (from the input's words) |
| Input sets and outputs: identity, digest, counts, last check | `run.json` → `inputs.<i>`, `outputs.<o>` and the history entries |
| Manifests | `devdocs/runs/<wf>/<run>/inputs/i<n>.json`, `outputs/o<n>.json` (Git) and `.wfe-output.json` in the publication folder (share) |
| Staged input bytes | run copy `.local/inputs/i<n>/` (ignored, per host) |
| Published bytes | the share, `runs/<project>/<wf>/<run>/o<n>/` |
| Where the share is mounted, download base | `<area>/shares.json` (ignored, per host) |

Retention of inputs and accepted outputs on the share belongs to the person
or the project, never to incidental cleanup.
