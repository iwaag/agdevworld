"""The things agdevworld can *say*: a post into a routine's own conversations,
and a request to Front to run a routine.

Every other route in this service reads. These write to the realm, so the
separations are in code rather than in the view:

- **A credential of its own.** `AGENTROOM_CHAT_ZULIP_ENV`, the Developer's,
  and nothing falls back to it or from it. The observer that reads `/ops`
  never posts (`operation_room` p2 constraint 5) and must not gain the
  ability here; unset means the relay is **read-only for chat** and says so.
- **Two destination shapes, both the routine's own.** A post lands in a
  routine channel this relay can already see: its `guide` topic (a new
  version of the guide — the newest post *is* the guide) or one of its
  `routinerun-` topics (a word into a run Front owns, which serves Front
  there). A **run request** goes to Front's ordinary entrance instead — a
  Front Desk conversation in `#front` — because since `refine_routine` p1 a
  run is something Front opens after reading the guide, not a topic this
  relay opens for it. The GUI still cannot write into another agent's
  channel: routing work is Front's job, which is what Single Entrance means.
- **A length guard.** This realm's `max_message_length` is 10000 and Zulip
  **truncates silently** past it — measured in `comfynotify`. A refusal the
  sender can read is the only acceptable behaviour at a boundary that
  otherwise fails invisibly.

A post into a run topic or a Front Desk conversation is a message from the
Developer in a topic Front sweeps, so it **starts a paid Front run**. That is
not a side effect to be minimised — it is what a chat with an agent is — but
it is why nothing in this file retries, and why the tests never touch Zulip.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from agag.selfnote import SELFNOTE_MARKER
from agag.zulip import ZulipClient

from .room import DESK_PREFIX, FRONT_CHANNEL
from .routines import GUIDE_TOPIC, RUN_PREFIX, is_run_topic, routine_channel, routine_name

#: The credential the chat writes with. Deliberately its own variable.
CHAT_ENV_VARIABLE = "AGENTROOM_CHAT_ZULIP_ENV"
#: What this door will send. Far below the realm's own 10000, because a chat
#: message longer than this is a document and belongs in the guide — and
#: because the realm's limit is where the *silent* truncation begins.
DEFAULT_MAX_CHARS = 4000
#: The realm's own ceiling, past which Zulip drops the tail without an error.
REALM_MAX_CHARS = 10000

__all__ = ["CHAT_ENV_VARIABLE", "Chat", "DEFAULT_MAX_CHARS", "REALM_MAX_CHARS",
           "allowed_topic", "request_text"]


def allowed_topic(channel: str, topic: str, names: set[str]) -> bool:
    """Whether this conversation is one the GUI may post into.

    A routine's own channel, for a routine the relay has actually seen, and
    in it either the `guide` topic or a `routinerun-` topic. Nothing derived
    from the request string: the routine name is compared against the
    routines the engine found.
    """
    name = routine_name(channel)
    if name is None or name not in names:
        return False
    return topic == GUIDE_TOPIC or is_run_topic(topic)


def request_text(name: str, instruction: str | None) -> str:
    """What the Developer says to Front to have a routine run.

    Plain words at Front's ordinary entrance: which routine, what the
    conditions are, and that Front may go ahead. The guide is Front's to
    read — nothing here repeats it, so the request cannot drift from it.
    """
    extra = (instruction or "").strip()
    text = (f"Run the routine `{name}` now. Read its guide in #{routine_channel(name)} › `{GUIDE_TOPIC}` "
            f"and open the run; go ahead without asking me, see it through, and report here when it ends.")
    if extra:
        text += f"\n\nConditions for this run: {extra}"
    return text


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
            "entrance": FRONT_CHANNEL,
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

    def check(self, channel: str, topic: str, text: str, names: set[str]) -> str | None:
        """The refusal this request earns, or None when it may be sent."""
        if not self.configured:
            return self.status()["reason"]
        if not allowed_topic(channel, topic, names):
            return (
                f"this relay only posts into a routine's own channel "
                f"(#routine-<name> › {GUIDE_TOPIC} or {RUN_PREFIX}<id>); "
                f"#{channel} › {topic!r} is not one of them"
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
            # thing `agag.selfnote` exists to prevent.
            return "a selfnote is machine-to-machine and cannot be typed by hand"
        if len(body) > self.max_chars:
            return (
                f"{len(body)} characters is over the {self.max_chars} this door sends; "
                f"Zulip itself truncates silently past {REALM_MAX_CHARS}, so a long "
                f"instruction belongs in the guide instead"
            )
        return None

    def request_check(self, row: dict | None, name: str) -> str | None:
        """Why Front may not be asked to run this routine, or None.

        The refusals are the relay's, not the view's: a retired routine has
        its guide under ✔ and Front would be sent to read a document the
        realm has closed; a routine with no guide has nothing for Front to
        read.
        """
        if not self.configured:
            return self.status()["reason"]
        if row is None:
            return f"no routine named {name!r} is known to this relay"
        if row.get("retired"):
            return (
                f"routine {name!r} is retired: its guide carries ✔; "
                f"un-resolve #{routine_channel(name)} › {GUIDE_TOPIC} to run it again"
            )
        if not row.get("guide"):
            return (
                f"routine {name!r} has no guide to run; write one in "
                f"#{routine_channel(name)} › {GUIDE_TOPIC} first"
            )
        return None

    def request(self, row: dict | None, name: str, instruction: str | None, *,
                stamp: str) -> dict:
        """Ask Front to run a routine, as the Developer, at Front's entrance.

        The post opens a Front Desk conversation of its own,
        `#front › front-desk-<stamp>`, so the request, Front's reply and the
        run's final report are one conversation the desk screen can show.
        One attempt and never a retry; a failure after the request left is
        *uncertain* — the post may have landed and a second one would ask
        twice.
        """
        refused = self.request_check(row, name)
        if refused is not None:
            return {"sent": False, "uncertain": False, "error": refused}
        text = request_text(name, instruction)
        refused = self.text_check(text)
        if refused is not None:
            return {"sent": False, "uncertain": False, "error": refused}
        topic = f"{DESK_PREFIX}{stamp}"
        try:
            message_id = self.client().send_to_channel(FRONT_CHANNEL, topic, text)
        except Exception as error:
            return {
                "sent": False, "uncertain": True,
                "error": f"{type(error).__name__}: {error}",
                "note": f"the post may have landed; check #{FRONT_CHANNEL} › {topic} before asking again",
            }
        return {
            "sent": True, "uncertain": False,
            "channel": FRONT_CHANNEL, "topic": topic, "desk": stamp,
            "message_id": message_id, "text": text,
            "note": "the request is live at Front's entrance; Front opens the run in the routine's channel",
        }

    def send(self, channel: str, topic: str, text: str, names: set[str]) -> dict:
        """Post it, or say why not. One attempt, never a retry."""
        refused = self.check(channel, topic, text, names)
        if refused is not None:
            return {"sent": False, "error": refused}
        body = text.strip()
        message_id = self.client().send_to_channel(channel, topic, body)
        return {
            "sent": True,
            "channel": channel,
            "topic": topic,
            "message_id": message_id,
            "note": "the post is live in the realm; the event queue will carry it back",
        }
