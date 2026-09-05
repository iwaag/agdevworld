"""`agentroom` — run the relay.

Configuration is environment only, because the one value that matters is a
path to an ignored credentials file and it must never end up in a tracked
file (devpolicy/styles.md).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from .room import Room
from .server import build_server

#: Path to a `KEY=value` Zulip credentials file (`agag.zulip.ZulipClient.from_env`).
ENV_VARIABLE = "AGENTROOM_ZULIP_ENV"
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

    if argv and argv[0] == "check":
        # A one-shot read, so a credentials or connectivity problem is found
        # without a browser in the loop.
        agents = room.agents()
        work = room.work()
        print(f"agents: {len(agents['agents'])}")
        print(f"unresolved topics: {len(work['topics'])} in {len(work['channels'])} channels")
        return 0

    server = build_server(host, port, room)
    print(f"agentroom listening on http://{host}:{port} (cache {ttl:g}s)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
