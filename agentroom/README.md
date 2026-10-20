# agentroom

A small relay on the coordinator host, `:8094` on every interface. Since
workflow_editor p15 it serves only what the workflow editor's Usage view
reads from this host (and Front reads with `curl`):

| Route | |
| --- | --- |
| `GET /budget` | the harness logins' subscription windows (claude_code, codex, agy), read through the CLIs' own stores; an unreadable one is *unknown* with the reason, never 0 (`src/agentroom/budget.py`) |
| `GET /cost` | the pre-WFE agents' `ag.agent-run.v1` records, as history (`src/agentroom/cost.py`); 503 without roots |
| `GET /healthz`, `GET /` | liveness; the routes |

It holds no credential of its own and reads no Zulip. The Front Desk's
panels (settings repository, shared contexts, progress board), the Arguing
Room, the completion door and the Zulip mirror behind them were retired with
the embedded Front Desk in workflow_editor p15; aghangout (a managed project)
replaced the desk. Earlier routes and their reasons are in the episodes
(`agent_room`, `operation_room`, `front_desk`, `argue`, `progress_panel`,
`better_zulip_call`, `retire_old_ui`, `workflow_editor` p15) and this file's
history.

## Run

```sh
service/serve.sh            # the listener
service/serve.sh check      # one read of each, no listener
uv run pytest -q            # tests
```

Environment: `AGENTROOM_HOST` (default `0.0.0.0`), `AGENTROOM_PORT`
(`8094`), `AGENTROOM_AGENT_ROOTS` (`instance=<root>,…`, for `/cost`),
`AGENTROOM_PRICES` (the price table `/cost` estimates with; default
`prices.json` here), `AGENTROOM_BUDGET_SECONDS` (how often a vendor is asked,
default 60), and the budget readers' binaries `AGENTROOM_CODEX_BIN`,
`AGENTROOM_AGY_BIN`. Variables of the retired parts (`OPSROOM_ZULIP_ENV`,
`AGENTROOM_CHAT_ZULIP_ENV`, …) are reported at startup as no longer read.

## Always on

launchd `com.agdev.agentroom` (`pj-agdev/devenv/launchd/com.agdev.agentroom.plist.in`)
runs `service/serve.sh` from this checkout. A code change needs a
`kickstart -k`; a changed `EnvironmentVariables` block needs `bootout` and
`bootstrap`.
