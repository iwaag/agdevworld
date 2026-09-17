"""The Arguing Room: a human starts, reads and continues an argue.

`argue` p2 step 3. An argue is `#argue › argue-<stem>` (`agag.argue`): a
conversation in which a human develops a desire with every agent, facilitated
by Front. Until now only an agent could open one, and the human's turns in
the one live argue were typed by the Omni Agent. This door gives a person
the whole loop from a screen — list, create, read, post, resume — plus the
relation between what was said and how Front re-voiced it
(`agentroom.presentation`).

**An argue is its anchor.** Every route but the list and the create names an
argue by the message id of its `[selfnote][argue]` note, and `locate` answers
where that message is now. A renamed topic is followed; a topic that took a
freed display name is another argue with another anchor, never this one.

**Reads come from the mirror** — the source, the memo results and the
rendering status alike — so a poll or a reload costs no Zulip call.
`health` says when the copy is stale; the history is returned all the same,
marked, rather than withheld.

**Writes are the Developer's credential** (`chat.py`, with its guards: the
length, no selfnote typed by hand) and carry a **submit token**: a double
click, a second Enter or a retry after a timeout repeats the token and gets
the first result back instead of a second post and a second paid run.
Nothing is retried here.

- *Create* writes the anchor note and then the human's text, verbatim, as the
  human. `agag.argue.open_argue` is the one place that knows how; a stem in
  use is refused, because a second conversation under one name would merge
  two argues.
- *Post* goes into the **source** argue, whichever view the screen is
  showing. A ✔'d argue is resumed in place: un-resolve, then post. That
  resumes the *discussion* and nothing else — the project or study it ended
  in is not reopened, and nothing downstream is executed.
- *Render* asks Front for another interpretation: one
  `[selfnote][render] <settings revision>` in the source. A selfnote buys
  nobody a run; Front's renderer reads it off its own mirror.

Finishing an argue is the shared completion door (`/complete` with the
argue's channel and topic) — no second completion engine.
"""

from __future__ import annotations

import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from urllib.parse import quote

from agag.argue import ARGUE_CHANNEL, ARGUE_TAG, ARGUE_TOPIC_PREFIX, open_argue, parse_argue, parse_desire
from agag.memo import render_request_note
from agag.mirror import bare_topic
from agag.selfnote import parse_note

from .chat import Chat
from .presentation import Located, agents_of, locate, presentation, source_posts

SCHEMA = "ag.argueroom.v1"
OUTCOME_TAG = "outcome"
STEM_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
REVISION_PATTERN = re.compile(r"^[0-9a-f]{7,64}$")
TOKEN_MEMORY = 200

__all__ = ["ArguingRoom", "SCHEMA", "STEM_PATTERN", "SubmitTokens", "status_of"]


class SubmitTokens:
    """What each submit token already produced, newest last."""

    def __init__(self, memory: int = TOKEN_MEMORY):
        self._lock = threading.Lock()
        self._held: "OrderedDict[str, dict]" = OrderedDict()
        self._memory = memory

    @staticmethod
    def check(token) -> str | None:
        if not token or not isinstance(token, str) or len(token) > 100:
            return "a submit token is required, so a repeated submit is not a second post"
        return None

    def earlier(self, token: str) -> dict | None:
        with self._lock:
            found = self._held.get(token)
        if found is None:
            return None
        return {**found, "duplicate": True,
                "note": "this submit was already handled; the earlier result is repeated, nothing was posted again"}

    def keep(self, token: str, result: dict) -> dict:
        with self._lock:
            self._held[token] = result
            while len(self._held) > self._memory:
                self._held.popitem(last=False)
        return result


def status_of(posts: list[dict], resolved: bool) -> dict:
    """Where the discussion stands, from the realm's own facts."""
    last = posts[-1] if posts else None
    if resolved:
        return {"state": "done", "since": last["at"] if last else None, "evidence": "the topic carries ✔"}
    if last is None:
        return {"state": "quiet", "since": None, "evidence": "no real post in this argue"}
    if last["kind"] == "ack":
        return {"state": "received", "since": last["at"],
                "evidence": f"{last['by']}'s ack #{last['message_id']} is the newest post: a reply is being written"}
    if last["kind"] == "agent":
        return {"state": "answered", "since": last["at"],
                "evidence": f"{last['speaker']}'s post #{last['message_id']} is the newest"}
    return {"state": "waiting", "since": last["at"],
            "evidence": f"{last['by']}'s post #{last['message_id']} is the newest and nobody has picked it up"}


@dataclass
class ArguingRoom:
    mirror: object | None
    chat: Chat
    settings: object | None = None
    tokens: SubmitTokens = field(default_factory=SubmitTokens, repr=False)

    # -- reads --------------------------------------------------------------------

    def _health(self) -> dict:
        if self.mirror is None:
            return {"state": "unknown", "reason": "this relay has no mirror"}
        health = self.mirror.health()
        return {"state": health.get("state"), "reason": health.get("reason"),
                "last_event_at": health.get("last_event_at")}

    def _active_revision(self) -> str | None:
        if self.settings is None:
            return None
        try:
            active = self.settings.active()
        except Exception:  # noqa: BLE001 - no settings is an answer, not an error
            return None
        return str(active.get("revision")) if active else None

    def _anchors(self) -> dict[int, tuple[str, str]]:
        """`{anchor id: (origin text)}` for every argue the mirror holds,
        the earliest note of each topic."""
        found: dict[tuple[str, str], tuple[int, str]] = {}
        for note in self.mirror.notes(tag=ARGUE_TAG, channel=ARGUE_CHANNEL):
            key = bare_topic(note.topic)
            if not key.startswith(ARGUE_TOPIC_PREFIX):
                continue
            if key not in found or note.message_id < found[key][0]:
                found[key] = (note.message_id, note.value)
        return {anchor: (topic, value) for topic, (anchor, value) in found.items()}

    def _row(self, where: Located, posts: list[dict], messages: list) -> dict:
        desire = next((d for d in (parse_desire(m.content) for m in messages) if d is not None), None)
        outcome = next((v for v in (parse_note(m.content, OUTCOME_TAG) for m in messages) if v), None)
        origin = None
        for message in messages:
            ok, found = parse_argue(message.content)
            if ok:
                origin = str(found) if found is not None else None
                break
        shown = [p for p in posts if p["kind"] != "ack"]
        return {
            "anchor": where.anchor, "channel": where.channel, "topic": where.topic, "live_topic": where.live_topic,
            "stem": where.topic[len(ARGUE_TOPIC_PREFIX):], "resolved": where.resolved, "origin": origin,
            "posts": len(shown), "speakers": sorted({p["speaker"] for p in shown}),
            "last_post": ({"at": shown[-1]["at"], "by": shown[-1]["speaker"]} if shown else None),
            "desire": ({"message_id": desire.message_id, "user_id": desire.user_id} if desire else None),
            "outcome": outcome, "status": status_of(posts, where.resolved),
        }

    def board(self, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        if self.mirror is None:
            return {"schema": SCHEMA, "generated_at": now, "health": self._health(), "chat": self.chat.status(),
                    "channel": ARGUE_CHANNEL, "argues": []}
        agents = agents_of(self.mirror)
        rows = []
        for anchor in self._anchors():
            where = locate(self.mirror, anchor)
            if where is None:
                continue
            posts, messages = source_posts(self.mirror, where, agents)
            rows.append(self._row(where, posts, messages))
        rows.sort(key=lambda row: (row["last_post"] or {}).get("at") or 0, reverse=True)
        health = self._health()
        if health["state"] != "live":
            for row in rows:
                row["stale_state"] = row["status"]["state"]
                row["status"] = {**row["status"], "state": "unknown",
                                 "evidence": f"{health['reason']}; last known: {row['status']['evidence']}"}
        return {"schema": SCHEMA, "generated_at": now, "health": health, "chat": self.chat.status(),
                "channel": ARGUE_CHANNEL, "prefix": ARGUE_TOPIC_PREFIX, "argues": rows}

    def _where(self, anchor) -> Located | dict:
        try:
            ident = int(anchor)
        except (TypeError, ValueError):
            return {"error": f"{anchor!r} is not an argue anchor (a message id)"}
        if self.mirror is None:
            return {"error": "this relay has no mirror"}
        where = locate(self.mirror, ident)
        if where is None:
            return {"error": f"message {ident} is not in the realm any more"}
        message = self.mirror.message(ident)
        if where.channel != ARGUE_CHANNEL or not parse_argue(message.content)[0]:
            return {"error": f"message {ident} is not the anchor note of an argue"}
        return where

    def argue(self, anchor, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        where = self._where(anchor)
        if isinstance(where, dict):
            return where
        agents = agents_of(self.mirror)
        posts, messages = source_posts(self.mirror, where, agents)
        row = self._row(where, posts, messages)
        health = self._health()
        if health["state"] != "live":
            row["stale_state"] = row["status"]["state"]
            row["status"] = {**row["status"], "state": "unknown",
                             "evidence": f"{health['reason']}; last known: {row['status']['evidence']}"}
        base = getattr(self.mirror, "base_url", "") or ""
        found = self.mirror.channel(where.channel)
        url = (f"{base}/#narrow/channel/{found.stream_id}-{where.channel}/topic/{quote(where.live_topic, safe='')}"
               if base and found is not None else None)
        return {
            "schema": SCHEMA, "generated_at": now, "health": health, "chat": self.chat.status(),
            "argue": {**row, "posts": posts, "zulip_url": url,
                      "presentation": presentation(self.mirror, where, messages, agents,
                                                   active_revision=self._active_revision(), now=now)},
        }

    # -- writes -----------------------------------------------------------------------

    def _refusal(self, text: str | None, token) -> str | None:
        if not self.chat.configured:
            return self.chat.status()["reason"]
        bad = SubmitTokens.check(token)
        if bad is not None:
            return bad
        return self.chat.text_check(text) if text is not None else None

    def create(self, stem: str | None, text: str, token: str, now: float | None = None) -> dict:
        """Open a new argue as the human: the anchor note, then their words."""
        refused = self._refusal(text, token)
        stem = (stem or "").strip().lower() or time.strftime("%Y%m%d-%H%M%S", time.gmtime(now))
        if stem.startswith(ARGUE_TOPIC_PREFIX):
            stem = stem[len(ARGUE_TOPIC_PREFIX):]
        if refused is None and not STEM_PATTERN.match(stem):
            refused = f"{stem!r} is not a usable name ({STEM_PATTERN.pattern})"
        if refused is None and self.mirror is not None and self.mirror.topic(ARGUE_CHANNEL, f"{ARGUE_TOPIC_PREFIX}{stem}"):
            refused = f"#{ARGUE_CHANNEL} › {ARGUE_TOPIC_PREFIX}{stem} already exists; choose another name"
        if refused is not None:
            return {"sent": False, "uncertain": False, "error": refused}
        earlier = self.tokens.earlier(token)
        if earlier is not None:
            return earlier
        try:
            topic, anchor, post = open_argue(self.chat.client(), stem, text, origin=None)
        except ValueError as error:
            return self.tokens.keep(token, {"sent": False, "uncertain": False, "error": str(error)})
        except Exception as error:  # noqa: BLE001 - reported, never retried
            return self.tokens.keep(token, {
                "sent": False, "uncertain": True, "error": f"{type(error).__name__}: {error}",
                "note": f"the argue may have been opened; look at #{ARGUE_CHANNEL} before trying again"})
        return self.tokens.keep(token, {
            "sent": True, "uncertain": False, "anchor": anchor, "channel": ARGUE_CHANNEL, "topic": topic,
            "message_id": post, "note": "the argue is open; the event queue will carry it back"})

    def _unresolve(self, client, where: Located, messages: list) -> bool:
        if not messages:
            return False
        try:
            client.call("PATCH", f"messages/{messages[-1].id}",
                        {"topic": where.topic, "propagate_mode": "change_all",
                         "send_notification_to_new_thread": False})
        except Exception:  # noqa: BLE001 - the post still goes out; Zulip keeps two names
            return False
        return True

    def post(self, anchor, text: str, token: str) -> dict:
        """The human's next turn, into the source argue, once per token."""
        refused = self._refusal(text, token)
        if refused is not None:
            return {"sent": False, "uncertain": False, "error": refused}
        where = self._where(anchor)
        if isinstance(where, dict):
            return {"sent": False, "uncertain": False, **where}
        earlier = self.tokens.earlier(token)
        if earlier is not None:
            return earlier
        client = self.chat.client()
        resumed = False
        if where.resolved:
            resumed = self._unresolve(client, where, self.mirror.messages(where.channel, where.live_topic,
                                                                         across_resolve=False))
        try:
            message_id = client.send_to_channel(where.channel, where.topic, text.strip())
        except Exception as error:  # noqa: BLE001 - reported, never retried
            return self.tokens.keep(token, {
                "sent": False, "uncertain": True, "error": f"{type(error).__name__}: {error}",
                "note": f"the post may have landed; check #{where.channel} › {where.topic} before sending again"})
        return self.tokens.keep(token, {
            "sent": True, "uncertain": False, "anchor": where.anchor, "channel": where.channel, "topic": where.topic,
            "message_id": message_id, "resumed": resumed,
            "note": ("the discussion is resumed; what it ended in stays as it is" if resumed
                     else "the post is live in the realm; the event queue will carry it back")})

    def render(self, anchor, revision: str | None, token: str) -> dict:
        where = self._where(anchor)
        if isinstance(where, dict):
            return {"sent": False, "uncertain": False, **where}
        return request_rendering(self.chat, self.tokens, where, revision or self._active_revision(), token)


def request_rendering(chat: Chat, tokens: SubmitTokens, where: Located, revision: str | None, token) -> dict:
    """Ask for an interpretation of one source at one settings revision —
    shared by both rooms. The note goes into the source's live topic, so a
    finished conversation can be re-interpreted without being reopened."""
    if not chat.configured:
        return {"sent": False, "uncertain": False, "error": chat.status()["reason"]}
    bad = SubmitTokens.check(token)
    if bad is None and not (revision and REVISION_PATTERN.match(revision)):
        bad = "no settings revision is active, and none was named"
    if bad is not None:
        return {"sent": False, "uncertain": False, "error": bad}
    earlier = tokens.earlier(token)
    if earlier is not None:
        return earlier
    try:
        message_id = chat.client().send_to_channel(where.channel, where.live_topic, render_request_note(revision))
    except Exception as error:  # noqa: BLE001
        return tokens.keep(token, {"sent": False, "uncertain": True, "error": f"{type(error).__name__}: {error}"})
    return tokens.keep(token, {
        "sent": True, "uncertain": False, "anchor": where.anchor, "settings_revision": revision,
        "message_id": message_id,
        "note": "asked; the renderer picks the request up from its mirror, and earlier interpretations stay"})
