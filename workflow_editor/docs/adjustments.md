# Run revisions

`wfe run adjust <run> --definition <file> --reason <text>` applies an
agent-selected revision. `--dry-run` shows the authored and effective graph
difference. `--expect-revision <r>` detects a stale read. The CLI defaults to
`--source agent`; the API accepts `{kind: "agent"}`. Optional answer,
instruction, request and person citations record provenance, not permission.
A request citation still identifies the original input bytes truthfully.

Revisions can change running/completed nodes, edges, repository bindings,
execution settings and documentation choices. Historical entries keep their
original actors and content. Removed node records leave the current graph;
their events remain in history. Existing nodes keep their state until an agent
starts, completes, fails or cancels them. Starting completed work reopens it.
Dependency edges suggest an order and do not prohibit starting other work.

Revisions are immutable files under `definition/rN/`, with parent revision,
hash, actor, reason and difference in the run history. A stale parent or
attempt reports the current revision/attempt for recovery. Concurrent writes
are serialized. Invalid YAML, unknown endpoints and cyclic graphs report
argument errors; no approval or prescribed workflow is used to repair them.

`--completing <node> --outcome <text>` records a revision and the running
node's completion atomically. Other nodes may be running. Questions,
proposals (`--propose <name>`), plans and reports remain available when useful;
none is required to authorize an adjustment.

## Recording work already done (workflow_editor fix5)

`wfe run record-done <run> --template <t> --id <node> --after <node>
--outcome <text> --reason <text> [evidence…]` records work that already
happened without its own node, for example inside a talk, as a completed
node. `wfe run help record-done` has the full usage. The HTTP route is
`POST runs/<wf>/<run>/record-done`.

It writes one history entry, `run.record-done`. The entry is a revision
(`definition/rN/`, source `{kind: "record-done", node}`) that adds exactly
that node and its generated steps. In the same step the node is
`completed`. It has no start, no completion event, and nothing is
scheduled in between. It performs no work: it starts no process,
dispatches no delegation, and invents no answer or approval. On a
completed run it neither queues an attempt nor repeats the run's
completion.

The node records:

- its outcome;
- `retrospective: {seq, at, by, reason, reported: {started, ended}, evidence}`.
  `at` and `by` are the recording. `reported` holds the work's own times
  as the recorder states them, and an unknown time stays `null`. The node's
  `started` and `ended` stay `null`.

Evidence is checked when it is recorded:

- files of the run's copy, by hash;
- commits, resolved to full ids;
- earlier entries of this run;
- questions, outputs and presentations of this run.

`--presentation <p>` links an existing presentation to the node with an
additional `links` record. The original registration stays as it was.
The node may follow completed nodes only.

History keeps its words: the talk's outcome and earlier entries are not
rewritten. The node appears from its revision on, marked "recorded
afterwards" in the graph (dashed), in its details (who, when, why,
reported time, evidence), in the history and in `wfe run show`. Older
revisions do not show it.

Work that has not happened is added as pending work with `wfe run adjust`
and done there. A presentation that was never made is not repaired by
declaring it done: the reminder `presentation-missing` (runs.md,
*Reminders at operation boundaries*) still applies to recorded work until a
presentation registered later, or one linked to it, covers it. Starting new
work after a retrospective record is an ordinary revision with ordinary
execution.
