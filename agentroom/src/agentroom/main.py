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

from .chat import CHAT_ENV_VARIABLE, DEFAULT_MAX_CHARS, Chat
from .inflight import ROOTS_VARIABLE, parse_roots
from .ops import DEFAULT_STALLED_SECONDS, Ops
from .room import Room
from .server import build_server

#: Path to a `KEY=value` Zulip credentials file (`agag.zulip.ZulipClient.from_env`).
ENV_VARIABLE = "AGENTROOM_ZULIP_ENV"
#: The operation room's **own** credential. Deliberately a second variable and
#: deliberately without a fallback: `operation_room` p1 measured a full sweep at
#: 183 calls against the same realm quota the agents' listeners spend, so the
#: observer holds an identity of its own or does not run (plan constraint 2).
OPS_ENV_VARIABLE = "OPSROOM_ZULIP_ENV"
#: The routine dispatcher's `schedule.json`, read as a **local file**. The
#: routine GUI on `:8093` serves the same clone over HTTP but answers no CORS
#: header, so a browser cannot read it and this relay is the only path there
#: is. A path, in the environment, for the same reason the credentials are
#: (`devpolicy/styles.md`): it is an absolute local path.
SCHEDULE_VARIABLE = "AGENTROOM_SCHEDULE_JSON"
#: The chat's own credential (the Developer's). Deliberately a third variable
#: with no fallback in either direction: the observer that reads the realm
#: never posts, and a relay without this one is read-only for chat and says so.
CHAT_VARIABLE = CHAT_ENV_VARIABLE
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

    stalled = float(os.environ.get("AGENTROOM_STALLED_SECONDS", DEFAULT_STALLED_SECONDS))
    ops_env = os.environ.get(OPS_ENV_VARIABLE, "")
    ops: Ops | None = None
    if ops_env:
        ops_path = Path(ops_env).expanduser()
        if not ops_path.is_file():
            print(f"{OPS_ENV_VARIABLE}={ops_path} is not a file", file=sys.stderr)
            return 2
        schedule_env = os.environ.get(SCHEDULE_VARIABLE, "")
        schedule_path = Path(schedule_env).expanduser() if schedule_env else None
        # Not fatal when it is missing: a routine board without the schedule
        # still has the realm's half, and the payload says which half is gone.
        # A relay that refuses to start over a file the dispatcher rewrites
        # several times a fire would be the more fragile arrangement.
        ops = Ops(
            env_path=ops_path, stalled_seconds=stalled, schedule_path=schedule_path,
            agent_roots=parse_roots(os.environ.get(ROOTS_VARIABLE, "")),
        )

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
        schedule = routines["schedule"]
        print(f"routines: {len(routines['routines'])} — schedule "
              + ("ok" if schedule["ok"] else f"unreadable ({schedule['error']})"))
        for row in routines["routines"]:
            print(f"  {row['name']:<12} {row['state']:<9} {row['answer']['state']:<11} "
                  f"{row['posts']} posts")
        print("chat: " + ("configured" if chat.configured else chat.status()["reason"]))
        return 0

    if ops is not None:
        ops.start()
    server = build_server(host, port, room, ops, chat)
    print(
        f"agentroom listening on http://{host}:{port} (cache {ttl:g}s, "
        + (f"ops on, stalled at {stalled:g}s, " if ops else "ops off, ")
        + ("chat on)" if chat.configured else "chat read-only)"),
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
