"""The reader credential stays subscribed to every public channel.

The relay's mirror registers its event queue for all public channels, and
Zulip delivers *new messages* of a channel the bot never joined — but not the
**moves**: a rename, and therefore a resolve, reaches only subscribers. So a
channel created after the bot's last subscription keeps arriving in the
mirror while every `✔` in it is missed, and a finished conversation reads as
open for ever. Met live in `argue` p2 step 5: `#argue` (created 2026-09-16)
showed both resolved argues as open, while Front's own mirror, subscribed,
had them right.

Subscribing to public channels is the one write `Opsroom Observer` has always
been allowed (`operation_room` p2); this keeps that promise as channels
appear: at startup and every `CHECK_SECONDS`, one `subscriptions` read, a
subscribe for whatever is missing, and — because the moves missed meanwhile
are gone from the queue — one resync of the mirror when anything was added.
"""

from __future__ import annotations

import threading

CHECK_SECONDS = 600.0

__all__ = ["CHECK_SECONDS", "ensure_subscribed", "keep_subscribed"]


def ensure_subscribed(client, mirror, log=print) -> list[str]:
    """Subscribe the reader to every public channel the mirror knows and it
    has not joined; resync when any was added. Returns the names added."""
    joined = {str(row.get("name")) for row in client.subscriptions()}
    missing = sorted(channel.name for channel in mirror.channels() if channel.name not in joined)
    if not missing:
        return []
    client.subscribe_channels(missing)
    log(f"the mirror's reader joined {', '.join('#' + name for name in missing)}; "
        "re-reading the realm for the moves it missed there")
    mirror.resync()
    return missing


def keep_subscribed(client_factory, mirror, *, log=print, every: float = CHECK_SECONDS) -> threading.Thread:
    def loop() -> None:
        stop = threading.Event()
        while True:
            try:
                if mirror.live:
                    ensure_subscribed(client_factory(), mirror, log)
            except Exception as error:  # noqa: BLE001 - a failed check is tried again; the relay serves on
                log(f"could not check the reader's subscriptions: {error!r}")
            stop.wait(every if mirror.live else 5.0)

    thread = threading.Thread(target=loop, name="reader-subscriptions", daemon=True)
    thread.start()
    return thread
