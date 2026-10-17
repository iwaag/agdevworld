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
