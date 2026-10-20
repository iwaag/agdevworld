"""The legacy Front Desk's topic shape: `#front` › `front-desk-<id>`.

Until project_migration p8 the Front Desk talked to the legacy Front here,
through the relay. The desk now reads and posts WFE conversations, and since
retire_old_ui p1 its relay routes are gone. What remains is the naming the
completion door (`close.py`, `closing.py`) and the conversation index
(`ops.py`) still use to recognise those historical topics.
"""

from __future__ import annotations

import re

from .room import DESK_PREFIX, bare_topic

#: Front's entrance channel. Every legacy Front conversation — the desk's, an
#: ordinary `front-*` one — lives here.
FRONT_CHANNEL = "front"
#: One conversation id shape, so a topic name never carries anything but it.
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")

__all__ = ["DESK_PREFIX", "FRONT_CHANNEL", "ID_PATTERN", "desk_id", "desk_topic"]


def desk_id(topic: str) -> str:
    return bare_topic(topic)[len(DESK_PREFIX):]


def desk_topic(ident: str) -> str:
    return f"{DESK_PREFIX}{ident}"
