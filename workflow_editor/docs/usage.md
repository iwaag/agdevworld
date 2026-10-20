# Usage (retire_old_ui p1)

What this area's executions used, and how much of each subscription window is
left. The dashboard shows a summary on Home; `#/usage` is the full view.
Both read the service:

- `GET api/usage?period=today|7d|30d|all` — the executions (`ag.usage.v1`,
  `shared/usage.ts`): per-period totals, coverage, the last 14 days,
  breakdowns by project, workflow, harness/model and execution node for the
  chosen period, its newest 200 executions, and the pre-WFE history.
- `GET api/usage/budget` — the subscription windows, apart because a cold
  read asks the vendors and may take seconds.

Nothing new is recorded. `server/usage.ts` reads evidence that exists anyway.

## Where the figures come from

- **One execution = one attempt** in the coordinator's exec store
  (`<area>/.local/exec/exec.sqlite`, `attempts`). Its id is the identity:
  a retry or a resumed run is a new attempt, so nothing is counted twice.
- **Its log** is `<area>/.local/exec/logs/<attempt>.jsonl`, the harness's
  own stream. A remote worker ships its log to the coordinator as it runs
  (docs/workers.md). Only the coordinator copy is read, so the worker copy
  is never added a second time.
  - Each log is read once per size and modification time: the last 256 KiB
    for claude_code, the whole file up to 16 MiB for codex.
- **claude_code**: the final `result` event.
  - Tokens come from `usage`, which counts this process only.
  - USD is `total_cost_usd`. `modelUsage.*.costBasis: list` marks it
    *API-equivalent*: the list price of the tokens, not a charge under the
    subscription login. USD with no basis named is shown as *reported*.
  - A resumed session's `total_cost_usd` covers the whole session (seen
    in the store: two attempts of one session reported 0.136 and then
    0.242 USD, while each `usage` was its own process's). A resumed
    attempt's USD is therefore its total minus the same session's previous
    attempt's (`adjusted: resumed`).
- **codex**: the tokens of every `turn.completed`, summed. They carry no USD,
  because the ChatGPT login meters the plan, so none is shown. An attempt
  that continues a thread already seen is marked `continued`.
- **Anything else** is `unknown` with its reason:
  - no `result` event (an interrupted attempt);
  - a log missing on the coordinator;
  - a harness whose usage is not read here.

  An attempt that has not ended is `running`. Neither is ever counted as
  zero. Totals say how many executions they do not cover, and coverage lists
  the reasons.

## Subscription windows and history

Both come from the agentroom relay on the same host
(`--relay <url>` / `WFE_RELAY`, default `http://127.0.0.1:8094`):

- `/budget` reads each harness login of **this host** through its own CLI:
  the Claude Code OAuth usage route, `codex app-server`, `agy`. A provider
  that fails is its own card, with the reason and its last good reading
  greyed. A relay that fails marks the whole section and keeps the last
  answer under its time. A card read more than 10 minutes ago is stale. The
  remote worker's own harness login is not read, so its windows are not
  shown.
- `/cost` reads the pre-WFE agents' `ag.agent-run.v1` records under the
  relay's agent roots (the retired Front, arxivsage, agecho). It is shown in
  Detail as history and never as current activity.

The service caches the windows for 30 s and the history for 60 s. The relay
asks a vendor at most once a minute. The pages poll: Home every 20 s, Usage
every 60 s. Both stop when the view is left.
