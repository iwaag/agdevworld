"""`agentroom` — run the relay.

Configuration is environment only (devpolicy/styles.md: paths and settings
of this host stay out of tracked files). Since workflow_editor p15 the relay
holds no credential of its own: `/budget` reads the harness CLIs' own
stores, `/cost` reads files on this host.
"""

from __future__ import annotations

import os
import sys

from .budget import budget_from_env
from .cost import PRICES_VARIABLE, ROOTS_VARIABLE, Cost, parse_roots, prices_path_from_env
from .server import build_server

#: Every interface, so browsers elsewhere on the LAN reach it.
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8094
#: Variables of the retired parts (the Zulip mirror, the Developer's chat
#: credential, the settings and context repositories, the progress board).
#: Named so a plist that still sets them is told rather than silently ignored.
RETIRED_VARIABLES = ("OPSROOM_ZULIP_ENV", "AGENTROOM_ZULIP_ENV", "AGENTROOM_CHAT_ZULIP_ENV", "AGENTROOM_MIRROR_DIR",
                     "AGENTROOM_SETTINGS", "AGENTROOM_CONTEXTS", "AGENTROOM_STALLED_SECONDS")


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    for name in RETIRED_VARIABLES:
        if os.environ.get(name):
            print(f"{name} is set but no longer read (workflow_editor p15: the relay serves /budget and /cost only)",
                  file=sys.stderr)
    host = os.environ.get("AGENTROOM_HOST", DEFAULT_HOST)
    port = int(os.environ.get("AGENTROOM_PORT", DEFAULT_PORT))
    # The pre-WFE agents' records (`/cost`, history); without roots there is
    # nothing to read and /cost says so.
    roots = parse_roots(os.environ.get(ROOTS_VARIABLE, ""))
    cost = Cost(roots, prices_path_from_env()) if roots else None
    # The budget read needs no configuration: its defaults are the CLIs' own
    # stores and binaries, and a missing one is *unknown* per card.
    budget = budget_from_env()

    if argv and argv[0] == "check":
        # One read of each, without a listener: tells a host problem from a UI one.
        if cost is None:
            print(f"cost: not configured ({ROOTS_VARIABLE} unset)")
        else:
            scanned = cost.scan()
            table = scanned["prices"]
            print(f"cost: {len(scanned['rows'])} records in {len(scanned['roots'])} roots; "
                  f"prices {'ok' if table.error is None else table.error} "
                  f"({table.path or PRICES_VARIABLE + ' unset'})")
        for harness, card in budget.snapshot()["harnesses"].items():
            if card["ok"]:
                meters = ", ".join(f"{w['label']} {w['percent']:g}%" for w in card["windows"])
                print(f"budget {harness:<12} {card.get('plan')}: {meters}")
            else:
                print(f"budget {harness:<12} unknown — {card['error']}")
        return 0

    server = build_server(host, port, cost, budget)
    print(f"agentroom listening on http://{host}:{port} "
          f"({f'cost over {len(roots)} roots' if cost else 'cost off'}, budget of {len(budget.providers)} harnesses)",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
