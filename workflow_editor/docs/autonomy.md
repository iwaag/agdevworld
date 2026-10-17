# Agent-directed work (p11)

WFE supplies project workspaces, workflow graphs, tools, run records and
publication/integration. Agents choose their approach, graph, bindings,
execution settings, tools, storage, delegation, reporting and review.

Definition approvals, plan agreement, questions, answers, result decisions
and document hashes remain truthful records. None grants permission to work
or integrate. Generated documentation steps are optional: pending steps do
not prevent authored work completing. They can be used, revised or omitted.
Dependencies are planning information; starting a known node does not require
its predecessors to be complete. Completed work can reopen with `run start`.
Instruction acknowledgment is available without being a transition gate.

Readonly bindings, if-unchanged bindings, protected paths and retired repository
lists no longer veto supported operations. Explicit paths and repository
identities identify targets. Missing repositories and malformed targets still
produce concrete errors. Intended files have no size-based publication veto.
Share transfer carries user dotfiles and excludes named transport metadata.

Process ownership, atomic writes, stale-attempt fencing and actual Git conflicts
remain execution facts. Agents can inspect, stop/resume, recover and retry.
Recovery has no person-reset budget. Explicit user stops/cancellations retain
their meaning; migration does not restart them.

Existing records can be explicitly reprojected with
`node scripts/migrate-process-state.ts <ignored-backup-directory> <run.json>...`.
It retains original bytes, events, actors, definitions and decisions and
recomputes the derived projections. A malformed history is an error. Frozen
instructions and deployed executors need their own explicit migration; a
source change alone does not update them.
