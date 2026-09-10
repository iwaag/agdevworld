"""`agentroom` — run the relay.

Configuration is environment only, because the one value that matters is a
path to an ignored credentials file and it must never end up in a tracked
file (devpolicy/styles.md).
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from agag.zulip import ZulipClient

from .budget import budget_from_env
from .chat import CHAT_ENV_VARIABLE, DEFAULT_MAX_CHARS, Chat
from .close import Closer
from .cost import PRICES_VARIABLE, Cost, prices_path_from_env
from .frontdesk import FrontDesk
from .inflight import ROOTS_VARIABLE, parse_roots
from .ops import DEFAULT_STALLED_SECONDS, Ops
from .room import Room
from .server import build_server
from .settings import settings_from_env

#: Path to a `KEY=value` Zulip credentials file (`agag.zulip.ZulipClient.from_env`).
ENV_VARIABLE = "AGENTROOM_ZULIP_ENV"
#: The operation room's **own** credential. Deliberately a second variable and
#: deliberately without a fallback: `operation_room` p1 measured a full sweep at
#: 183 calls against the same realm quota the agents' listeners spend, so the
#: observer holds an identity of its own or does not run (plan constraint 2).
OPS_ENV_VARIABLE = "OPSROOM_ZULIP_ENV"
#: The chat's own credential (the Developer's). Deliberately a third variable
#: with no fallback in either direction: the observer that reads the realm
#: never posts, and a relay without this one is read-only for chat and says so.
CHAT_VARIABLE = CHAT_ENV_VARIABLE
# `AGENTROOM_PLANE_ENV` is gone (`refactor` p2 step 4). It existed for the one
# record this relay read outside Zulip — forge's Plane Work — and forge's
# record is a conversation now. The relay holds three credentials, all Zulip:
# the read, the observer's, and the Developer's for what it writes.
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8094
DEFAULT_CACHE_SECONDS = 30.0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    env_path = os.environ.get(ENV_VARIABLE, "")
    if not env_path:
        print(f"{ENV_VARIABLE} is unset: point it at a Zulip credentials file", file=sys.stderr)
        return 2
    path = Path(env_path).expanduser()
    if not path.is_file():
        print(f"{ENV_VARIABLE}={path} is not a file", file=sys.stderr)
        return 2

    host = os.environ.get("AGENTROOM_HOST", DEFAULT_HOST)
    port = int(os.environ.get("AGENTROOM_PORT", DEFAULT_PORT))
    ttl = float(os.environ.get("AGENTROOM_CACHE_SECONDS", DEFAULT_CACHE_SECONDS))
    room = Room(env_path=path, ttl_seconds=ttl)
    # The cost gauge reads the same roots `/inflight` does and needs no
    # credential at all; without roots there is nothing to read and /cost
    # says so.
    roots = parse_roots(os.environ.get(ROOTS_VARIABLE, ""))
    cost = Cost(roots, prices_path_from_env()) if roots else None
    # The budget read needs no configuration at all: its defaults are the
    # CLIs' own stores and binaries, and a missing one is *unknown* per card.
    budget = budget_from_env()

    stalled = float(os.environ.get("AGENTROOM_STALLED_SECONDS", DEFAULT_STALLED_SECONDS))
    ops_env = os.environ.get(OPS_ENV_VARIABLE, "")
    ops: Ops | None = None
    if ops_env:
        ops_path = Path(ops_env).expanduser()
        if not ops_path.is_file():
            print(f"{OPS_ENV_VARIABLE}={ops_path} is not a file", file=sys.stderr)
            return 2
        ops = Ops(env_path=ops_path, stalled_seconds=stalled, agent_roots=roots)

    chat_env = os.environ.get(CHAT_VARIABLE, "")
    chat_path = Path(chat_env).expanduser() if chat_env else None
    if chat_path is not None and not chat_path.is_file():
        print(f"{CHAT_VARIABLE}={chat_path} is not a file", file=sys.stderr)
        return 2
    chat = Chat(
        env_path=chat_path,
        max_chars=int(os.environ.get("AGENTROOM_CHAT_MAX_CHARS", DEFAULT_MAX_CHARS)),
    )

    if argv and argv[0] == "check":
        # A one-shot read, so a credentials or connectivity problem is found
        # without a browser in the loop.
        agents = room.agents()
        work = room.work()
        print(f"agents: {len(agents['agents'])}")
        print(f"unresolved topics: {len(work['topics'])} in {len(work['channels'])} channels")
        if ops is None:
            print(f"ops: not configured ({OPS_ENV_VARIABLE} unset)")
            return 0
        # The engine's own check is a sweep with no listener behind it, which
        # is also the honest measurement of what a sweep costs.
        ops.start()
        while ops.snapshot()["health"]["sweeps"] == 0 and ops.snapshot()["health"]["error"] is None:
            time.sleep(0.5)
        found = ops.snapshot()
        ops.stop()
        print(f"ops: {found['health']['state']} — {found['health']['reason']}")
        print(f"ops sweep: {found['health']['sweep_calls']} calls, "
              f"{found['health']['topics']} topics in {found['health']['channels']} channels")
        for summary in found["instances"]:
            print(f"  {summary['instance']:<24} roster={summary['roster']:<7} {summary['counts']}")
        routines = ops.routines()
        print(f"routines: {len(routines['routines'])}")
        for row in routines["routines"]:
            latest = row["latest"]
            print(f"  {row['name']:<16} {row['state']:<10} runs {row['runs']} "
                  f"({row['open_runs']} open)"
                  + (f" · latest {latest['topic']} {latest['run']['state']}" if latest else ""))
        print("chat: " + ("configured" if chat.configured else chat.status()["reason"]))
        if cost is None:
            print(f"cost: not configured ({ROOTS_VARIABLE} unset)")
        else:
            scanned = cost.scan()
            table = scanned["prices"]
            print(f"cost: {len(scanned['rows'])} records in {len(scanned['roots'])} roots; "
                  f"prices {'ok' if table.error is None else table.error} "
                  f"({table.path or PRICES_VARIABLE + ' unset'})")
        found = settings_from_env().snapshot()
        active = found["active"]
        print("settings: " + (f"revision {active['short']} of {active['url']} ({active['ref']}); "
                              f"characters {', '.join(active['characters'])}" if active
                              else f"none — {found['error']}"))
        for harness, card in budget.snapshot()["harnesses"].items():
            if card["ok"]:
                meters = ", ".join(f"{w['label']} {w['percent']:g}%" for w in card["windows"])
                print(f"budget {harness:<12} {card.get('plan')}: {meters}")
            else:
                print(f"budget {harness:<12} unknown — {card['error']}")
        return 0

    # The Front Desk reads the engine's memory and, for a conversation it
    # does not hold, the realm with the relay's own read credential; it
    # writes with the chat's. No fourth credential.
    desk = FrontDesk(ops=ops, chat=chat, reader_factory=lambda: ZulipClient.from_env(path))

    # The completion door (`front_desk` p3). It reads with the relay's own
    # credential and writes with the Developer's — the one that already posts
    # here. Since `refactor` p2 both halves of what it closes are Zulip, so
    # there is no third system to be configured for.
    def held_topics() -> dict:
        """The engine's memory, copied under its lock: a preview must not
        read a dict a sweep is writing."""
        if ops is None:
            return {}
        with ops._lock:
            return dict(ops._topics)

    closer = Closer(
        topics=held_topics,
        reader_factory=lambda: ZulipClient.from_env(path),
        writer_factory=(lambda: chat.client()) if chat.configured else None,
    )

    # The settings repository (`front_desk` p2): read per request from the
    # active revision the sync command switched, so a content update needs
    # neither a restart nor a rebuild. Unconfigured is a payload, not a
    # refusal to start.
    settings = settings_from_env()

    if ops is not None:
        ops.start()
    server = build_server(host, port, room, ops, chat, cost, budget, desk, settings, closer)
    print(
        f"agentroom listening on http://{host}:{port} (cache {ttl:g}s, "
        + (f"ops on, stalled at {stalled:g}s, " if ops else "ops off, ")
        + ("chat on, " if chat.configured else "chat read-only, ")
        + (f"cost over {len(roots)} roots, " if cost else "cost off, ")
        + f"budget of {len(budget.providers)} harnesses, "
        + f"settings from {settings.config_path.name}, "
        + ("completion on" if chat.configured else "completion read-only") + ")",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
