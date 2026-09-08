"""The one thing agdevworld can *say*: a post into a routine conversation.

Every other route in this service reads. This one writes to the realm, so the
separations are in code rather than in the view:

- **A credential of its own.** `AGENTROOM_CHAT_ZULIP_ENV`, the Developer's,
  and nothing falls back to it or from it. The observer that reads `/ops`
  never posts (`operation_room` p2 constraint 5) and must not gain the ability
  here; unset means the relay is **read-only for chat** and says so, the way
  `/ops` says which credential is missing rather than showing a quiet board.
- **One destination shape.** `#front`, and only a topic that belongs to a
  routine this relay can already see. The GUI cannot write into another
  agent's channel: routing work is Front's job, and that is what Single
  Entrance means. The rule is here, in the relay, because a view that merely
  hides the box is a habit rather than a rule.
- **A length guard.** This realm's `max_message_length` is 10000 and Zulip
  **truncates silently** past it — measured in `comfynotify`, where an
  over-long post lost its tail with no error anywhere. A refusal the sender
  can read is the only acceptable behaviour at a boundary that otherwise
  fails invisibly.

A post here is a message from the Developer in a topic Front sweeps, so it
**starts a paid Front run**. That is not a side effect to be minimised — it is
what a chat with an agent is — but it is why nothing in this file retries, and
why the tests below never touch Zulip.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from agag.selfnote import SELFNOTE_MARKER
from agag.zulip import ZulipClient

from .routines import (
    FIRE_PREFIX, ROUTINE_CHANNEL, STANDING_PREFIX, fire_line, parse_run_topic, run_topic,
)

#: The credential the chat writes with. Deliberately its own variable.
CHAT_ENV_VARIABLE = "AGENTROOM_CHAT_ZULIP_ENV"
#: What this door will send. Far below the realm's own 10000, because a chat
#: message longer than this is a document and belongs in the standing request
#: — and because the realm's limit is where the *silent* truncation begins.
DEFAULT_MAX_CHARS = 4000
#: The realm's own ceiling, past which Zulip drops the tail without an error.
REALM_MAX_CHARS = 10000

__all__ = ["CHAT_ENV_VARIABLE", "Chat", "DEFAULT_MAX_CHARS", "REALM_MAX_CHARS", "allowed_topic"]


def allowed_topic(topic: str, names: set[str]) -> bool:
    """Whether this `#front` topic is one the GUI may post into.

    A routine's **run** topics (`front-routine-<name>-<stamp>`) and its
    **standing request** topic, for a routine the relay has actually seen.
    Nothing derived from the request string: the routine name in the topic is
    compared against the routines the engine found. A run topic that does not
    exist yet *can* be named here — that is how `start` opens one — but only
    for a known routine and only in the run-topic shape.
    """
    if topic.startswith(STANDING_PREFIX) and topic[len(STANDING_PREFIX):] in names:
        return True
    parsed = parse_run_topic(topic)
    return parsed is not None and parsed[0] in names


@dataclass
class Chat:
    """The write half, with its own credential or none at all."""

    env_path: Path | None = None
    max_chars: int = DEFAULT_MAX_CHARS
    client_factory: Callable[[Path], ZulipClient] | None = None
    _client: ZulipClient | None = field(default=None, repr=False)

    @property
    def configured(self) -> bool:
        return self.env_path is not None

    def status(self) -> dict:
        return {
            "configured": self.configured,
            "max_chars": self.max_chars,
            "realm_max_chars": REALM_MAX_CHARS,
            "channel": ROUTINE_CHANNEL,
            "reason": None if self.configured else (
                f"{CHAT_ENV_VARIABLE} is unset, so this relay can read routines "
                f"but not answer in them"
            ),
        }

    def client(self) -> ZulipClient:
        if self._client is None:
            factory = self.client_factory or ZulipClient.from_env
            self._client = factory(self.env_path)
        return self._client

    def check(self, topic: str, text: str, names: set[str]) -> str | None:
        """The refusal this request earns, or None when it may be sent."""
        if not self.configured:
            return self.status()["reason"]
        if not allowed_topic(topic, names):
            return (
                f"this relay only posts into #{ROUTINE_CHANNEL} routine topics "
                f"({STANDING_PREFIX}<name> or {FIRE_PREFIX}<name>-<stamp>); "
                f"{topic!r} is not one of them"
            )
        return self.text_check(text)

    def text_check(self, text: str) -> str | None:
        """The guards on the *text* alone, shared with the Front Desk door."""
        body = text.strip()
        if not body:
            return "nothing to send"
        if body.lstrip().startswith(SELFNOTE_MARKER):
            # A selfnote is one agent's memory of its own run. A human typing
            # one in a box would be writing a record by hand, which is the one
            # thing `agag.selfnote` exists to prevent (constraint 4).
            return "a selfnote is machine-to-machine and cannot be typed by hand"
        if len(body) > self.max_chars:
            return (
                f"{len(body)} characters is over the {self.max_chars} this door sends; "
                f"Zulip itself truncates silently past {REALM_MAX_CHARS}, so a long "
                f"instruction belongs in the standing request instead"
            )
        return None

    def start_check(self, row: dict | None, name: str) -> str | None:
        """Why a new session of this routine may not be started, or None.

        The refusals are the relay's, not the view's: a retired routine has
        its standing request under ✔ and Front would be sent to read a
        document the realm has closed; a routine with no standing request has
        nothing for Front to do. A routine with no run yet is *not* a
        refusal — every start creates its topic.
        """
        if not self.configured:
            return self.status()["reason"]
        if row is None:
            return f"no routine named {name!r} is known to this relay"
        if row.get("retired"):
            return (
                f"routine {name!r} is retired: its standing request carries ✔; "
                f"un-resolve #{ROUTINE_CHANNEL} › {STANDING_PREFIX}{name} to start it again"
            )
        if not row.get("request"):
            return (
                f"routine {name!r} has no standing request to run; write one in "
                f"#{ROUTINE_CHANNEL} › {STANDING_PREFIX}{name} first"
            )
        return None

    def start(self, row: dict | None, name: str, instruction: str | None, *,
              stamp: str, names: set[str]) -> dict:
        """Post the fire that starts a new session, as the Developer.

        The post opens the run's own topic, `run_topic(name, stamp)`, and
        names the routine's newest run as `Previous run:` the way the
        dispatcher does. The text is `routines.fire_line`, so the fire is
        recognised by the same reader as the dispatcher's and told apart from
        it only by its mark. One attempt and never a retry, for the same
        reason as `send`; a failure after the request left is reported as
        *uncertain* — the post may have landed and a second one would start a
        second run.
        """
        refused = self.start_check(row, name)
        if refused is not None:
            return {"sent": False, "uncertain": False, "error": refused}
        topic = run_topic(name, stamp)
        previous = row.get("latest_topic")
        if previous == topic:
            return {"sent": False, "uncertain": False,
                    "error": f"a run of {name!r} already started this minute ({topic}); wait a minute"}
        text = fire_line(name, stamp, instruction, previous)
        refused = self.check(topic, text, names)
        if refused is not None:
            return {"sent": False, "uncertain": False, "error": refused}
        try:
            message_id = self.client().send_to_channel(ROUTINE_CHANNEL, topic, text)
        except Exception as error:
            return {
                "sent": False, "uncertain": True,
                "error": f"{type(error).__name__}: {error}",
                "note": f"the post may have landed; check #{ROUTINE_CHANNEL} › {topic} before starting again",
            }
        return {
            "sent": True, "uncertain": False,
            "channel": ROUTINE_CHANNEL, "topic": topic,
            "message_id": message_id, "text": text,
            "previous": previous,
            "note": "the fire is live in the realm; the event queue will carry it back",
        }

    def send(self, topic: str, text: str, names: set[str]) -> dict:
        """Post it, or say why not. One attempt, never a retry.

        A retry here would buy a second paid Front run for a request the human
        made once, and the failure this guards against — a Zulip that answered
        an error — is exactly the case where the first post may well have
        landed.
        """
        refused = self.check(topic, text, names)
        if refused is not None:
            return {"sent": False, "error": refused}
        body = text.strip()
        message_id = self.client().send_to_channel(ROUTINE_CHANNEL, topic, body)
        return {
            "sent": True,
            "channel": ROUTINE_CHANNEL,
            "topic": topic,
            "message_id": message_id,
            # The view shows what the realm will echo back through the event
            # queue a moment later; the id is how it drops the duplicate.
            "note": "the post is live in the realm; the event queue will carry it back",
        }
