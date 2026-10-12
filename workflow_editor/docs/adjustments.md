# Run adjustments: changing a run's future work (p7)

A run follows a fixed definition ([runs.md](runs.md), *Definition
snapshot*). An **adjustment** changes the work a run has not started yet —
adding repair and re-presentation after a review, removing a cleanup node a
run does not need — without touching the reusable workflow definition, the
run's original snapshot or anything already done. Each adjustment is a
complete, immutable **revision** of the run's definition.

Arbitrary mid-node graph changes, rollback of completed work and automatic
updates of `devdocs/workflows/` are not adjustments.

## Revisions

| Revision | Where | Content |
| --- | --- | --- |
| `r1` (original) | `definition/<workflow>.yaml` and `definition` in `run.create` | the byte copy taken at creation; never rewritten |
| `r2`, `r3`, … | `definition/<revision>/<workflow>.yaml` and the `run.adjust` entry that applied it | the complete authored definition of that revision and its complete compiled graph |

Each `run.adjust` entry records: `revision` (`r<n>`, the next number),
`parent` (the revision it was made from, which must be the active one),
`file`, `sha256` of the bytes, `definitionDigest` (the definition-approval
projection), `effective` (the whole compiled graph, with its compiler
version), `reason`, `source` (below) and the `diff` it applies. The state's
`definition.active` names the revision in force (absent: `r1`), and
`definition.revisions` lists every applied revision in order.

**Replay** follows the history with the graph in force at each entry: the
original graph until the first `run.adjust`, then the graph that entry
carries. Reading checks each revision's file against its recorded `sha256`
and its graph against its authored nodes, as for the original; a missing or
changed revision file makes the record unusable, never silently recompiled.
A later compiler never regenerates a revision.

Because the graph is part of the history entry and the file is written
before `run.json` (under the run's lock), a crash between the two leaves an
unreferenced revision file and an unchanged run. The next attempt
overwrites that file. A run never points at a revision that is not on
disk.

## What an adjustment may change

An adjustment is a whole authored definition (the active one, edited). It is
compared with the active revision and refused, atomically and with every
reason, when it:

| Code | Refused change |
| --- | --- |
| `adjust-started` | removes, retypes or edits (type, name, description, repositories, delegate target, `confirms`) a node that is not `pending` — started, waiting, completed, failed or cancelled work keeps its identity, meaning and state |
| `adjust-dependencies` | changes the incoming edges of a node that is not `pending` (its recorded dependencies) |
| `adjust-question` | removes or rewrites a node with an open or answered question — covered by the rule above, named separately |
| `adjust-access` | changes `repositories` (bindings, paths or access), `execution` (agent, profile, guides), `intake` or `documentation` — adjustments never broaden access or change who performs the run |
| `adjust-graph` | makes the graph invalid: a cycle, an edge to an unknown node, a delegate node, a second `confirms: result`, a node id that is not valid, or anything the definition validation calls an error |
| `adjust-generated` | would change the frozen documentation step (plan, report, final report) of a node that is not `pending`, or its incoming edges |
| `adjust-nothing` | changes nothing executable (appearance and layout alone are not adjustments) |

Appearance and layout of new or pending nodes may change with an
adjustment; on their own they are not one.

Under the `default` policy the new revision is compiled with the current
compiler. New authored nodes get their report steps; the final report
follows the new terminal nodes. Generated steps of nodes that are not
pending must come out identical, which they do when only future work
changes.

**Preserved state.** Nodes of the parent revision keep their records.
New nodes (authored or generated) start `pending`. Nodes the adjustment
removes (necessarily `pending`) leave the state; their history before the
adjustment stays as it was. Questions, answers, instructions, artifacts,
presentations and decisions are untouched: completed reports and decisions
never change.

## When an adjustment may be applied

At a **node boundary**:

- no node is `running` (`mid-node` otherwise) — a waiting node may stay
  waiting, it just cannot be changed;
- no received instruction is unacknowledged (`instructions-pending`), as for
  a node start: an adjustment never bypasses the person's input;
- the execution is neither completed (`run-completed`) nor cancelled;
- `--expect-seq` / `expectSeq` and `parent` (`--expect-revision`) match the
  record (`outdated`, `revision-outdated`), checked under the run's lock, so
  a stale view or two concurrent proposals cannot both apply;
- while an attempt is open, only that attempt applies adjustments (fenced
  like its reports); a person's adjustment waits until no attempt is open.

## Who authorizes it

An adjustment names its **source**, and the reducer checks it:

| `source` | Means | Checked |
| --- | --- | --- |
| `{kind: "answer", question, answer}` | the person asked for this change in an answer (a correction after review) | the question exists, that answer was taken up |
| `{kind: "instruction", instruction}` | the person's additional instruction asked for it | the instruction exists and was acknowledged |
| `{kind: "agreement", question}` | the executor proposed a change of the agreed scope and the person agreed to it | the question was asked about this exact proposal (its `document` is the proposed revision file, by hash), and its answer was taken up |
| `{kind: "person", by}` | a person applies it themselves (CLI, browser) | recorded as declared, like an approval; not allowed while an attempt is open |

Routine implementation choices already authorized by the person's request
are not adjustments and need no prompt. A material change of agreed scope
that the person did not ask for needs `agreement`: write the proposal
(`wfe run adjust … --propose`, which writes
`definition/proposals/<name>.yaml` and prints the difference), ask about it
(`wfe run ask <run> <node> --about-adjustment <name>`), and apply it with
the taken-up answer. Acknowledging an instruction and applying a revision
are two records: the acknowledgment says what the executor will do; the
adjustment is the graph change it made.

## A correction after review

When the person asks for changes in their answer to the result
confirmation:

1. take the answer up; the confirming node is running again;
2. complete the confirming node with an outcome that says a correction was
   requested (no decision is recorded; asking for changes is not a
   rejection);
3. at the boundary, apply an adjustment with source `{answer}` that adds
   repair, verification, a new presentation and a new result-confirmation
   talk after it, and reconnects the pending cleanup (and anything else
   pending) to follow the new confirmation; the old confirming node keeps
   `confirms: result` only if the new one does not — a run has one result
   confirmation node, so the new talk carries `confirms: result` and the old
   node, already completed, keeps its frozen meaning in the revision history
   (see below);
4. the new presentation and question bind a new revision; the earlier
   question, answer and presentation stay as they were.

`confirms: result` belongs to a node's meaning. A completed confirming node
cannot be edited, so a correction adds the new confirmation with a
different id and the validation rule "one result confirmation per workflow"
counts only nodes that are not completed in the run (`adjust-graph`
otherwise). The decision rule takes the **latest** question asked from any
node that is a result confirmation in the active revision.

## Views and operations

`wfe run adjust <run> --definition <file> --reason <text> --source …
[--dry-run] [--expect-revision r<n>]`, the HTTP route `POST
runs/<wf>/<run>/adjust` and the run view use one operation
(`server/runs.ts` `adjustRun`): `--dry-run` returns the difference
(authored nodes added, removed, changed; edges added and removed; generated
steps added and removed) and every refusal without writing. `wfe run
revisions <run>` and the run view show the original definition, the active
revision and the difference between any two. The run view draws the active
revision; a history view (`/at/<commit>`) draws the revision active at that
commit.
