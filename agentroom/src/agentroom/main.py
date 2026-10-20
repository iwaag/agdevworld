"""`agentroom` — run the relay.

Configuration is environment only, because the values that matter are paths
to ignored credentials files and they must never end up in a tracked file
(devpolicy/styles.md).

Since `better_zulip_call` p1 the relay holds **two** credentials, both
Zulip: the mirror's, which is the only one that reads, and the Developer's,
which is the only one that writes. The `AGENTROOM_ZULIP_ENV` read credential
is gone — every board, every detail view and every completion preview is
answered from the mirror's copy of the realm, and the Developer's quota is
spent on nothing but what the Developer asks to be written.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from agag.mirror import Mirror

from .budget import budget_from_env
from .chat import CHAT_ENV_VARIABLE, DEFAULT_MAX_CHARS, Chat
from .close import Closer
from .contexts import contexts_from_env
from .cost import PRICES_VARIABLE, ROOTS_VARIABLE, Cost, parse_roots, prices_path_from_env
from .argueroom import ArguingRoom
from .ops import Ops
from .realm import MirrorRealm
from .server import build_server
from .progress import progress_from_env
from .settings import settings_from_env

#: The mirror's credential: a `KEY=value` Zulip credentials file
#: (`agag.zulip.ZulipClient.from_env`). Its own bot, with its own quota, so
#: reading the realm never competes with the agents' listeners or with what
#: the Developer does — the constraint `operation_room` p1 set and
#: `better_zulip_call` p1 extended to every read this relay makes.
MIRROR_ENV_VARIABLE = "OPSROOM_ZULIP_ENV"
#: Where the mirror's store lives. Ignored, disposable: delete it and the
#: next start rebuilds it from the realm.
MIRROR_DIR_VARIABLE = "AGENTROOM_MIRROR_DIR"
#: The former read credential. No longer read; named so a plist that still
#: sets it is told rather than silently ignored.
RETIRED_READ_VARIABLE = "AGENTROOM_ZULIP_ENV"
#: The chat's own credential (the Developer's). Deliberately a separate
#: variable with no fallback in either direction: the mirror never posts, and
#: a relay without this one is read-only for chat and says so.
CHAT_VARIABLE = CHAT_ENV_VARIABLE
#: Every interface, so browsers elsewhere on the LAN reach it.
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8094
#: How long `check` waits for the mirror's first fill before giving up.
CHECK_TIMEOUT_SECONDS = 180.0

PACKAGE_ROOT = Path(__file__).resolve().parents[2]


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    mirror_env = os.environ.get(MIRROR_ENV_VARIABLE, "")
    if not mirror_env:
        print(f"{MIRROR_ENV_VARIABLE} is unset: point it at the mirror's Zulip credentials file",
              file=sys.stderr)
        return 2
    mirror_path = Path(mirror_env).expanduser()
    if not mirror_path.is_file():
        print(f"{MIRROR_ENV_VARIABLE}={mirror_path} is not a file", file=sys.stderr)
        return 2
    if os.environ.get(RETIRED_READ_VARIABLE):
        print(f"{RETIRED_READ_VARIABLE} is set but no longer read: every read comes from the mirror "
              f"on {MIRROR_ENV_VARIABLE}", file=sys.stderr)
    store_dir = Path(os.environ.get(MIRROR_DIR_VARIABLE, "") or (PACKAGE_ROOT / ".local" / "mirror")).expanduser()

    host = os.environ.get("AGENTROOM_HOST", DEFAULT_HOST)
    port = int(os.environ.get("AGENTROOM_PORT", DEFAULT_PORT))
    mirror = Mirror.open(mirror_path, store_dir)
    if not (argv and argv[0] == "check"):
        # Moves (a rename, a ✔) reach only subscribers: keep the reader in
        # every public channel, as channels appear (`subscriptions.py`).
        from agag.zulip import ZulipClient

        from .subscriptions import keep_subscribed

        keep_subscribed(lambda: ZulipClient.from_env(mirror_path), mirror,
                        log=lambda line: print(line, flush=True))
    # The pre-WFE agents' records (`/cost`, history) need no credential at
    # all; without roots there is nothing to read and /cost says so.
    roots = parse_roots(os.environ.get(ROOTS_VARIABLE, ""))
    cost = Cost(roots, prices_path_from_env()) if roots else None
    # The budget read needs no configuration at all: its defaults are the
    # CLIs' own stores and binaries, and a missing one is *unknown* per card.
    budget = budget_from_env()

    # The conversation index the completion door and the progress board walk.
    ops = Ops(mirror=mirror)

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
        # without a browser in the loop — and the honest measurement of what
        # the mirror's first fill costs.
        started = time.time()
        while not mirror.live and time.time() - started < CHECK_TIMEOUT_SECONDS:
            time.sleep(0.5)
        health = mirror.health()
        print(f"mirror: {health['state']} — {health['reason']} after {time.time() - started:.1f}s; "
              f"{health['counts']['messages']} messages, {health['counts']['topics']} topics, "
              f"{health['counts']['channels']} channels; resync {health['resync_calls']} calls; "
              f"store {store_dir}")
        for key, count in health["ledger"].items():
            print(f"  {key}: {count}")
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
        after = mirror.health()
        print(f"zulip calls made by this check: {after['calls']} (every board above came from the store)")
        mirror.stop()
        return 0

    # The Arguing Room (`argue` p2): the mirror, the write credential for
    # closing an argue, and the settings only to know which revision is active.
    settings = settings_from_env()
    argues = ArguingRoom(mirror=mirror, chat=chat, settings=settings)

    # The completion door (`front_desk` p3). It discovers from the mirror and
    # writes with the Developer's credential — the one that already posts
    # here — then waits for the mirror to carry its writes back.
    closer = Closer(
        topics=ops.held_topics,
        reader_factory=lambda: MirrorRealm(mirror),
        writer_factory=(lambda: chat.client()) if chat.configured else None,
        mirror=mirror,
    )

    # The settings repository (`front_desk` p2) is read per request from the
    # active revision the sync command switched, so a content update needs
    # neither a restart nor a rebuild. Unconfigured is a payload, not a
    # refusal to start. (Made above: the Arguing Room asks it too.)

    # Context repositories (`give_context_easier` p1): the host's shared
    # catalog through pyagag's agrefs, and the Developer's Gitea token for
    # the panel's writes. Unconfigured is a payload, not a refusal to start.
    contexts = contexts_from_env(log=lambda line: print(line, flush=True))

    # The progress panel (`progress_panel` p1): the same mirror, Observer's
    # records beside its monitor-health file, and its probe configuration.
    progress = progress_from_env(ops, chat.viewer_id)

    server = build_server(host, port, mirror, chat, cost, budget, settings, closer, argues,
                          contexts=contexts, progress=progress)
    print(
        f"agentroom listening on http://{host}:{port} (mirror on {mirror_path.name}, "
        f"store {store_dir}, "
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
        mirror.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
