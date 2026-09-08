"""The Front Desk: one `#front` › `front-desk-<id>` conversation, read and written.

agdevworld's Front Desk scene (`front_desk` p1) talks to Front in a topic of
its own shape, `front-desk-<id>`, which Front's `front-` sweep already
serves. This module is its door on the relay — three routes — and the rules
behind them, in the relay rather than in the view, for the same reason
`chat.py` gives: a view that hides a box is a habit, not a rule.

**Zulip is the history.** The `/ops` engine keeps every post of the newest
Front Desk conversations in memory (the sweep reads them deep and under ✔,
the event queue keeps them current), so a browser may ask every few seconds
at no Zulip cost. A conversation the engine does not hold — an old resolved
one after a restart — is read from Zulip once, on request, with the relay's
own read credential, so history comes back after a page reload *or* a relay
restart, resolved topics included. Neither path invents a post: `known` says
which one answered (`held`, `read`) or that neither could (`unknown`), and
the view keeps its last known history on `unknown`.

**The write** is the Developer's credential from `chat.py`, with the same
guards (configured, length, no selfnote by hand) plus two of this door's own:
the conversation id has one shape, and every submit carries a **token** the
relay remembers — a double click, a second Enter or a retry after a timeout
repeats the token and gets the first result back instead of a second paid
run. There is no retry here either.

**Resuming.** A ✔'d conversation is resumed by posting into it: the relay
un-resolves the topic first (Zulip's rename back to the bare name) so the
post lands in the same topic rather than beside it; Front's sweep skips a
resolved topic and would never see the post otherwise. What Zulip's own
"unresolved" notice does to Front is pyagag's business
(`0a33830`: a system notice is not speech).

Nothing here decides what a post *is* beyond the two facts the realm gives:
`agag.agent.is_ack` for Front's transport ack, and the Front roster's bot id
for "Front said it". Selfnotes never enter the history (`ops.is_real`).
"""

from __future__ import annotations

import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Callable, Iterable
from urllib.parse import quote

from agag.agent import is_ack
from agag.zulip import RESOLVED_TOPIC_PREFIX, ZulipClient

from .chat import Chat
from .room import bare_topic
from .routines import ROUTINE_CHANNEL

if TYPE_CHECKING:  # pragma: no cover - typing only; ops imports this module
    from .ops import Ops, Topic

SCHEMA = "ag.frontdesk.v1"
#: `#front` › `front-desk-<id>`: inside Front's `front-` sweep by design.
DESK_PREFIX = "front-desk-"
#: How many Front Desk conversations the sweep reads whole and under ✔. The
#: rest are read from Zulip on request; the event queue still carries every
#: new post of every open one.
DESK_DEEP = 8
#: One conversation id shape, so a topic name never carries anything but it.
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
#: Submit tokens remembered, newest last.
TOKEN_MEMORY = 200
#: How long a direct Zulip read of an unheld conversation is reused.
READ_TTL_SECONDS = 30.0
#: How much of an unheld conversation a direct read fetches.
READ_DEPTH = 200
#: The turn-taking mention `serve_topic` puts in front of every reply
#: (`@**Developer**`). Transport, like the ack: shown to nobody.
HANDOFF = re.compile(r"^\s*@\*\*[^*\n]+\*\*\s*\n+")

__all__ = [
    "DESK_DEEP", "DESK_PREFIX", "FrontDesk", "ID_PATTERN", "SCHEMA",
    "is_desk_topic", "newest_desk_topics", "post_kind", "shown_content", "status_of",
]


def shown_content(content: str) -> str:
    """The post as the developer should read it: without the leading
    handoff mention the skeleton prefixes to a reply."""
    return HANDOFF.sub("", content, count=1)


def is_desk_topic(channel: str, topic: str) -> bool:
    return channel == ROUTINE_CHANNEL and bare_topic(topic).startswith(DESK_PREFIX)


def desk_id(topic: str) -> str:
    return bare_topic(topic)[len(DESK_PREFIX):]


def desk_topic(ident: str) -> str:
    return f"{DESK_PREFIX}{ident}"


def newest_desk_topics(names: Iterable[str], count: int = DESK_DEEP) -> set[str]:
    """Of these bare `#front` topic names, the newest `count` Front Desk
    conversations — the ones the sweep reads deep and reads even under ✔.

    Newest by id, which the view mints as a timestamp; two conversations
    named otherwise still sort deterministically.
    """
    found = sorted((name for name in names if name.startswith(DESK_PREFIX)), reverse=True)
    return set(found[:count])


# --- what a post is, and where a conversation stands ------------------------


def post_kind(message, front_id: int | None, developer_id: int | None) -> str:
    """`ack`, `agent`, `developer` or `other` — from who said it and the one
    string the transport owns."""
    if is_ack(message.content):
        return "ack"
    if front_id is not None and message.sender_id == front_id:
        return "agent"
    if developer_id is not None and message.sender_id == developer_id:
        return "developer"
    if front_id is None and message.sender == "Front":
        return "agent"
    return "developer" if message.sender == "Developer" else "other"


def status_of(topic, front_id: int | None, developer_id: int | None) -> dict:
    """Where the conversation stands, with the evidence.

    `waiting` — the Developer spoke last and nothing has picked it up;
    `received` — Front's ack is the newest post: it is running (or ran and
    failed to answer, which reads the same from here); `answered` — Front's
    reply is the newest post; `done` — Zulip's ✔; `quiet` — nothing has been
    said. No timer and no harness is consulted: this is what the realm shows.
    """
    if topic.resolved:
        return {"state": "done", "since": topic.last.timestamp if topic.last else None,
                "evidence": "the topic carries ✔"}
    last = topic.last
    if last is None:
        return {"state": "quiet", "since": None, "evidence": "no real post in this topic"}
    kind = post_kind(last, front_id, developer_id)
    if kind == "ack":
        return {"state": "received", "since": last.timestamp,
                "evidence": f"Front's ack #{last.id} is the newest post"}
    if kind == "agent":
        return {"state": "answered", "since": last.timestamp,
                "evidence": f"Front's reply #{last.id} is the newest post"}
    return {"state": "waiting", "since": last.timestamp,
            "evidence": f"{last.sender or 'somebody'}'s post #{last.id} is the newest and Front has not acked it"}


# --- the door ----------------------------------------------------------------


@dataclass
class FrontDesk:
    ops: "Ops | None"
    chat: Chat
    #: The relay's read credential (`AGENTROOM_ZULIP_ENV`), for a conversation
    #: the engine does not hold. None leaves such a conversation `unknown`.
    reader_factory: Callable[[], ZulipClient] | None = None
    _reader: ZulipClient | None = field(default=None, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _tokens: "OrderedDict[str, dict]" = field(default_factory=OrderedDict, repr=False)
    _reads: dict[str, tuple[float, dict]] = field(default_factory=dict, repr=False)
    _developer_id: int | None = field(default=None, repr=False)
    _front_stream: int | None = field(default=None, repr=False)

    # -- credentials and ids --------------------------------------------

    def reader(self) -> ZulipClient | None:
        if self._reader is None and self.reader_factory is not None:
            self._reader = self.reader_factory()
        return self._reader

    def developer_id(self) -> int | None:
        """The Developer is whoever the chat credential is; asked once."""
        if self._developer_id is None and self.chat.configured:
            try:
                self._developer_id = int(self.chat.client().whoami()["user_id"])
            except Exception:  # noqa: BLE001 - an unknown id degrades to name matching
                return None
        return self._developer_id

    def front_id(self) -> int | None:
        if self.ops is None:
            return None
        with self.ops._lock:
            rosters = dict(self.ops._rosters)
        for roster in rosters.values():
            if roster is not None and roster.agent == "front":
                return roster.bot_id
        return None

    def zulip_url(self, live_topic: str) -> str | None:
        """A narrow link into the topic, from the read credential's realm."""
        client = self.reader()
        if client is None:
            return None
        if self._front_stream is None:
            try:
                self._front_stream = client.stream_id(ROUTINE_CHANNEL)
            except Exception:  # noqa: BLE001
                return None
        return (f"{client.base_url}/#narrow/channel/{self._front_stream}-{ROUTINE_CHANNEL}"
                f"/topic/{quote(live_topic, safe='')}")

    # -- reads --------------------------------------------------------------

    def _health(self, now: float) -> dict:
        if self.ops is None:
            return {"state": "unknown", "reason": "the ops engine is not configured",
                    "sweeps": 0, "sweep_calls": 0, "channels": 0, "topics": 0, "last_event_at": None}
        return self.ops.snapshot(now)["health"]

    def _held(self) -> tuple[dict, dict[str, str]]:
        """Every Front Desk topic the engine holds, and every name it saw."""
        if self.ops is None:
            return {}, {}
        with self.ops._lock:
            topics = {key: held for key, held in self.ops._topics.items()
                      if is_desk_topic(key[0], key[1])}
            names = dict(self.ops._front_names)
        return topics, {bare: live for bare, live in names.items() if bare.startswith(DESK_PREFIX)}

    def _row(self, ident: str, held, live: str | None, front_id, developer_id) -> dict:
        topic = desk_topic(ident)
        if held is None:
            resolved = bool(live and live.startswith(RESOLVED_TOPIC_PREFIX))
            return {
                "id": ident, "topic": topic, "live_topic": live or topic, "resolved": resolved,
                "posts": 0, "last_post": None,
                "status": {"state": "done" if resolved else "quiet", "since": None,
                           "evidence": "the topic is known by name only; its posts are not held"},
                "held": False,
            }
        return {
            "id": ident, "topic": topic, "live_topic": held.live_topic, "resolved": held.resolved,
            "posts": len(held.history),
            "last_post": ({"at": held.last.timestamp, "by": held.last.sender} if held.last else None),
            "status": status_of(held, front_id, developer_id),
            "held": True,
        }

    def board(self, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        health = self._health(now)
        topics, names = self._held()
        front_id, developer_id = self.front_id(), self.developer_id()
        rows = []
        seen = set()
        for (_, bare), held in topics.items():
            rows.append(self._row(desk_id(bare), held, held.live_topic, front_id, developer_id))
            seen.add(bare)
        for bare, live in names.items():
            if bare not in seen:
                rows.append(self._row(desk_id(bare), None, live, front_id, developer_id))
        rows.sort(key=lambda row: (row["last_post"] or {}).get("at") or 0, reverse=True)
        if health["state"] != "live":
            for row in rows:
                row["stale_state"] = row["status"]["state"]
                row["status"] = {**row["status"], "state": "unknown",
                                 "evidence": f"{health['reason']}; last known: {row['status']['evidence']}"}
        return {
            "schema": SCHEMA, "generated_at": now, "health": health,
            "chat": self.chat.status(), "channel": ROUTINE_CHANNEL, "prefix": DESK_PREFIX,
            "conversations": rows,
        }

    def _read(self, ident: str, now: float) -> dict | None:
        """One direct read of a conversation the engine does not hold, under
        both its names, cached briefly. None when there is no reader or the
        read failed."""
        with self._lock:
            hit = self._reads.get(ident)
            if hit and now - hit[0] < READ_TTL_SECONDS:
                return hit[1]
        client = self.reader()
        if client is None:
            return None
        from .ops import Topic  # local: ops imports this module
        topic = desk_topic(ident)
        found = Topic(channel=ROUTINE_CHANNEL, topic=topic, live_topic=topic, keep_history=True)
        try:
            history = client.topic_history(ROUTINE_CHANNEL, topic, num_before=READ_DEPTH)
            resolved = client.topic_history(
                ROUTINE_CHANNEL, f"{RESOLVED_TOPIC_PREFIX}{topic}", num_before=READ_DEPTH,
            )
        except Exception:  # noqa: BLE001 - unknown is the answer, never an empty history
            return None
        for message in resolved:
            found.add(message)
        for message in history:
            found.add(message)
        # The resolved name is what exists when the bare one is empty.
        if resolved and not history:
            found.live_topic = f"{RESOLVED_TOPIC_PREFIX}{topic}"
            found.resolved = True
        if len(history) + len(resolved) >= READ_DEPTH:
            found.history_bounded = True
        payload = {"topic": found, "bounded": found.history_bounded}
        with self._lock:
            self._reads[ident] = (now, payload)
        return payload

    def conversation(self, ident: str, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        if not ID_PATTERN.match(ident):
            return {"error": f"{ident!r} is not a Front Desk conversation id"}
        health = self._health(now)
        topics, names = self._held()
        front_id, developer_id = self.front_id(), self.developer_id()
        held = topics.get((ROUTINE_CHANNEL, desk_topic(ident)))
        known = "held"
        bounded = False
        if held is not None and held.keep_history:
            bounded = held.history_bounded
        else:
            read = self._read(ident, now)
            if read is None:
                known = "unknown"
                held = None
            else:
                known, held, bounded = "read", read["topic"], read["bounded"]
        if held is None:
            live = names.get(desk_topic(ident))
            row = self._row(ident, None, live, front_id, developer_id)
            posts: list[dict] = []
            note = ("no reader is configured, so an unheld conversation cannot be read"
                    if self.reader() is None else "Zulip could not be read; nothing is known of this conversation")
        else:
            row = self._row(ident, held, held.live_topic, front_id, developer_id)
            posts = [{
                "message_id": m.id, "at": m.timestamp, "by": m.sender, "sender_id": m.sender_id,
                "content": shown_content(m.content), "kind": post_kind(m, front_id, developer_id),
            } for m in sorted(held.history, key=lambda m: m.id)]
            note = ("the newest posts were read; older ones are in Zulip" if bounded
                    else "every real post of this conversation is here")
        latest = next((p for p in reversed(posts) if p["kind"] == "agent"), None)
        if health["state"] != "live" and known == "held":
            row["stale_state"] = row["status"]["state"]
            row["status"] = {**row["status"], "state": "unknown",
                             "evidence": f"{health['reason']}; last known: {row['status']['evidence']}"}
        row.pop("held", None)
        row.pop("posts", None)
        conversation = {
            **row, "known": known,
            "history": {"posts": len(posts), "bounded": bounded, "note": note},
            "posts": posts, "latest_reply": latest,
            "zulip_url": self.zulip_url(row["live_topic"]),
        }
        return {"schema": SCHEMA, "generated_at": now, "health": health,
                "chat": self.chat.status(), "conversation": conversation}

    # -- the write ----------------------------------------------------------

    def check(self, ident: str, text: str, token: str) -> str | None:
        if not self.chat.configured:
            return self.chat.status()["reason"]
        if not ID_PATTERN.match(ident or ""):
            return f"{ident!r} is not a Front Desk conversation id ({ID_PATTERN.pattern})"
        if not token or not isinstance(token, str) or len(token) > 100:
            return "a submit token is required, so a repeated submit is not a second run"
        return self.chat.text_check(text)

    def post(self, ident: str, text: str, token: str) -> dict:
        """Post as the Developer into `front-desk-<ident>`, once per token."""
        refused = self.check(ident, text, token)
        if refused is not None:
            return {"sent": False, "uncertain": False, "error": refused}
        with self._lock:
            earlier = self._tokens.get(token)
        if earlier is not None:
            return {**earlier, "duplicate": True,
                    "note": "this submit was already handled; the earlier result is repeated, nothing was posted again"}
        topic = desk_topic(ident)
        body = text.strip()
        client = self.chat.client()
        resumed = False
        # A ✔'d conversation is resumed in place: un-resolve, then post. The
        # engine holds the topic's last id; without one the bare name is used
        # and the realm holds two topics of the same bare name, which the
        # engine still reads as one conversation.
        live = self._live_name(ident)
        if live is not None and live.startswith(RESOLVED_TOPIC_PREFIX):
            resumed = self._unresolve(client, ident, live)
        try:
            message_id = client.send_to_channel(ROUTINE_CHANNEL, topic, body)
        except Exception as error:  # noqa: BLE001 - reported, never retried
            result = {
                "sent": False, "uncertain": True,
                "error": f"{type(error).__name__}: {error}",
                "note": f"the post may have landed; check #{ROUTINE_CHANNEL} › {topic} before sending again",
            }
        else:
            result = {
                "sent": True, "uncertain": False, "channel": ROUTINE_CHANNEL, "topic": topic,
                "message_id": message_id, "resumed": resumed,
                "note": "the post is live in the realm; the event queue will carry it back",
            }
        with self._lock:
            self._tokens[token] = result
            while len(self._tokens) > TOKEN_MEMORY:
                self._tokens.popitem(last=False)
            self._reads.pop(ident, None)
        return result

    def _live_name(self, ident: str) -> str | None:
        topics, names = self._held()
        held = topics.get((ROUTINE_CHANNEL, desk_topic(ident)))
        if held is not None:
            return held.live_topic
        return names.get(desk_topic(ident))

    def _last_id(self, ident: str) -> int | None:
        topics, _ = self._held()
        held = topics.get((ROUTINE_CHANNEL, desk_topic(ident)))
        if held is not None and held.last is not None:
            return held.last.id
        client = self.reader()
        if client is None:
            return None
        try:
            found = client.topic_history(
                ROUTINE_CHANNEL, f"{RESOLVED_TOPIC_PREFIX}{desk_topic(ident)}", num_before=1,
            )
        except Exception:  # noqa: BLE001
            return None
        return int(found[-1]["id"]) if found else None

    def _unresolve(self, client: ZulipClient, ident: str, live: str) -> bool:
        message_id = self._last_id(ident)
        if message_id is None:
            return False
        try:
            client.call(
                "PATCH", f"messages/{message_id}",
                {"topic": desk_topic(ident), "propagate_mode": "change_all",
                 "send_notification_to_new_thread": False},
            )
        except Exception:  # noqa: BLE001 - the post still goes out; Zulip keeps two names
            return False
        return True
