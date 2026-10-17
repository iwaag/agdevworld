# Integration

Saving checkpoints the run copy on its branches. Integration combines those
actual saved commits with the current target branches. Definition approval,
plan agreement, result acceptance and completed documentation are independent
records and are not prerequisites. Later edits and final reports need no
renewed acceptance. A decision never stands in for an integration record.

`wfe run integrate <run>` saves working changes and integrates. `--dry-run`
combines locally without pushing; `--status` reads the journal. The browser
provides Check integration, Integrate now and Retry integration. An executing
attempt finishes before integration so its checkpoint has a defined input.
An explicit user stop or cancellation remains in force.

Repositories integrate deepest first and the parent records their resulting
gitlinks. Each step records the target, observed commit, candidate commit,
merge method, resulting commit, push and actual error. A partial push stays
partial and can be retried. Recovery checks the target for an already-pushed
result. No force push is used implicitly.

A clean merge can combine changes to the same file. A real Git conflict names
the files. The agent can fetch the target in the run copy, merge it, resolve
and commit the conflict, then retry integration. No successor run or person
handoff is required. An unavailable remote or rejected push reports the actual
failure; a successful earlier repository remains recorded.

The existing SQLite journal column named `decision` identifies the source
history sequence for new integration requests. Historical rows retain their
original values; it is no longer consulted as an acceptance index. Multiple
requests share an unfinished integration, preserving its durable progress.
Actual integrated commits, rather than decisions, establish what was delivered.
