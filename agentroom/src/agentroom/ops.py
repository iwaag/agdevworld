"""The conversation index the relay's remaining readers share.

Since retire_old_ui p1 the operation room, the routine board and the
in-flight signal are gone, and with them the board this engine computed.
What is left is the index of held conversations, rosters and served marks
that the completion preview (`close.py`, for an argue) walks, derived from
the mirror on demand. The history of the engine follows.


This is `operation_room` p1's throwaway probe promoted to a running service.
p1's finding was that the conversation layer is the only layer of this system
that is *complete* — every task state is reconstructable from Zulip by an
observer that is not the agent — and that `stalled` falls out of it for free,
as the age of an owed reply. An agent that is not running cannot report that
it is not running; this is the one signal that does not ask it to.

Three things about the shape, each of them a p1 measurement rather than a
preference:

- **It is event-driven.** A full sweep is 183 Zulip calls and an immediate
  repeat returns HTTP 429, out of the quota the agents' own listeners spend.
  So the sweep happens at startup and after a queue expiry, and everything in
  between arrives on an event queue. A greedy operation room throttles the
  agents it is watching.
- **The roster comes from `#agents`.** Sweep prefixes are compiled into each
  agent's `AgentSpec` and the instance name lives in that node's ignored
  `.local/instance.toml`; an observer can read neither. Guessing them cost p1
  66 phantom stalled rows, so every instance now states its routing in its own
  introduction (`agag.intro.parse_roster`, `docs/agent-roster-v1.md`), and an
  introduction without one is `unknown` here rather than a default.
- **Every key is the bare topic name.** 36% of Front's served notes and 90%
  of autolab's name a topic that today exists only under its `✔ ` name.
  Matching verbatim turns each of those into a call that was never answered —
  135 false pending rows for Front, and the p9 incident reproduced as a
  metric.

**Since `better_zulip_call` p1 this engine reads nothing itself.** The
sweep, the queue and the subscription writes are gone: every conversation
comes from the process's `agag.mirror` (one persisted, event-updated copy of
the realm on the relay's own credential), and the rows are derived from it
on demand, once per mirror revision. What is left here is the *judgement* —
who owes whom, and for how long — which is the part p1 was actually about.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

from agag.agent import is_ack
from agag.memo import is_memo_channel
from agag.intro import Roster
from agag.selfnote import Conversation, is_selfnote, parse_rootchat, parse_served, note as selfnote
from agag.mirror import Mirror
from agag.zulip import RESOLVED_TOPIC_PREFIX

from .frontdesk import FRONT_CHANNEL
from .room import SYSTEM_REALM, bare_topic
from .routines import ROUTINE_HISTORY

__all__ = ["Ops", "Topic", "acked", "by_prefix", "owns"]


# --- what is remembered about one conversation -----------------------------


@dataclass
class Message:
    """The little of a post this engine needs, kept instead of the post."""

    id: int
    sender_id: int
    sender: str
    timestamp: int
    content: str

    @classmethod
    def of(cls, message: dict) -> "Message":
        return cls(
            id=int(message["id"]),
            sender_id=int(message.get("sender_id") or 0),
            sender=str(message.get("sender_full_name") or ""),
            timestamp=int(message.get("timestamp") or 0),
            content=str(message.get("content") or ""),
        )


def is_real(message: dict) -> bool:
    """A post somebody actually made.

    A `[selfnote]` is machine-to-machine and never counts as somebody
    speaking — get this wrong and the note one agent writes in another's topic
    is a post by somebody else, which is the ack loop with no ack in it. Zulip's
    own notices ("marked this topic as resolved") are not speech either, and
    the resolve one arrives on the very event this engine watches for.
    """
    return not is_selfnote(message.get("content")) and message.get("sender_realm_str") != SYSTEM_REALM


@dataclass
class Topic:
    """One conversation, keyed by its **bare** name, across the ✔ rename."""

    channel: str
    topic: str
    live_topic: str
    resolved: bool = False
    #: The newest real post, which is what both routes ask about.
    last: Message | None = None
    #: Every real post naming somebody, newest last. The mention route needs
    #: the *oldest unserved* one, because that is when the reply started being
    #: owed — the newest would reset the clock on every nudge.
    mentions: list[Message] = field(default_factory=list)
    #: Kept only for the conversations a *routine* is made of. The board needs
    #: the last post of every topic on the realm and the whole history of
    #: about sixteen of them; keeping all of both would be a copy of the realm
    #: in memory for the sake of the sixteen.
    keep_history: bool = False
    history: list[Message] = field(default_factory=list)
    #: `[selfnote][rootchat]` — the conversations this topic was opened *for*,
    #: with who said so. This is the edge a session tree is built from, and it
    #: is the one thing selfnotes are read for: linking, never display
    #: (`operation_room` p3 constraint 4).
    roots: list[tuple[Conversation, int, str, int]] = field(default_factory=list)
    #: `[selfnote][served]` written *in* this topic: the remote conversations
    #: this one's owner has answered a callback from. The other direction of
    #: the same edge, and the only one that survives a child topic being
    #: resolved — a resolved topic is never swept. Each entry keeps the newest
    #: remote id it covers and the **first** note that named it, because the
    #: first note is when this conversation started working there, which is
    #: what attributes a child to one fire rather than another.
    served: dict[tuple[str, str], dict] = field(default_factory=dict)
    #: Whether `history` is known to be a *window* rather than the whole topic:
    #: the sweep's read came back full, or a later post pushed an older one out.
    #: A session list built on a window must say so instead of implying that
    #: every run of the routine was searched.
    history_bounded: bool = False
    #: When this engine watched the topic being resolved, or None when the
    #: resolve predates what the mirror's change feed remembers. A `done` row
    #: is a receipt for a transition somebody may still want to see; a topic
    #: resolved long ago is history, not a receipt.
    resolved_at: float | None = None

    def add(self, message: dict) -> None:
        if not is_memo_channel(self.channel):
            # A memo is held for display only (`agag.memo`): a note copied
            # into one links nothing, closes nothing and marks nothing served.
            self.link(message)
        if not is_real(message):
            return
        found = Message.of(message)
        if self.last is None or found.id >= self.last.id:
            self.last = found
        if "@**" in found.content:
            self.mentions.append(found)
            self.mentions.sort(key=lambda m: m.id)
        if self.keep_history and all(kept.id != found.id for kept in self.history):
            self.history.append(found)
            self.history.sort(key=lambda kept: kept.id)
            if len(self.history) > ROUTINE_HISTORY:
                self.history_bounded = True
                del self.history[:-ROUTINE_HISTORY]

    def link(self, message: dict) -> None:
        """Read the two link notes out of a post, whatever else it is.

        Selfnotes are filtered out of everything above and stay filtered out of
        everything below; this is the one place that reads them, because they
        are the only record of which conversation a run was opened on behalf
        of. Nothing read here is ever rendered.
        """
        content = str(message.get("content") or "")
        sender_id = int(message.get("sender_id") or 0)
        sender = str(message.get("sender_full_name") or "")
        home = parse_rootchat(content)
        if home is not None:
            # Keyed bare, like everything else here: a note written after the
            # home was resolved names the ✔ name, and the two are one
            # conversation.
            home = Conversation(home.channel, bare_topic(home.topic))
        if home is not None and not any(
            root == home and by == sender_id for root, by, _, _ in self.roots
        ):
            # The earliest note by each agent wins: a topic is anchored once,
            # by the run that opened it, and two agents may each anchor it to
            # a home of their own.
            self.roots.append((home, sender_id, sender, int(message.get("id") or 0)))
            self.roots.sort(key=lambda root: root[3])
        parsed = parse_served(content)
        if parsed is not None:
            remote, ident = parsed
            key = (remote.channel, bare_topic(remote.topic))
            note_id = int(message.get("id") or 0)
            found = self.served.get(key)
            if found is None:
                self.served[key] = {"remote_id": ident, "first_note": note_id,
                                    "last_note": note_id}
            else:
                found["remote_id"] = max(found["remote_id"], ident)
                found["first_note"] = min(found["first_note"] or note_id, note_id)
                found["last_note"] = max(found["last_note"], note_id)


# --- the two routes --------------------------------------------------------


def owns(roster: Roster, channel: str, topic: str) -> bool:
    """`agag.agent.topic_filter`, reproduced from the posted roster.

    The listener matches its own channel by *name* and its prefixes anywhere.
    Both halves are in the roster because neither can be read from outside.
    """
    return channel == roster.channel or by_prefix(roster, topic)


def by_prefix(roster: Roster, topic: str) -> bool:
    """Whether this topic is owned only because its *name* starts a prefix.

    Worth its own name because a prefix says which **kind** of agent owns a
    topic and never which instance: `agechoplan-` is both agecho instances'.
    p1 read that ambiguity as observer error and charged one bot 59 phantom stalled rows for it. It is not an error —
    both listeners really would sweep such a topic — so the board states it
    rather than picking a winner.
    """
    return bool(roster.prefixes) and topic.startswith(tuple(roster.prefixes))


def acked(topic: Topic, roster: Roster) -> bool:
    """Whether this agent's own ack is the newest real post here.

    "Running", as chat can see it: `serve_topic` posts `SWEEP_ACK` before the
    run and the answer after it. It is late — everything before the ack is
    invisible — but it is the only in-flight signal that needs no access to
    the node, and it is why an `acked` row is not a `stalled` one.
    """
    last = topic.last
    return (
        last is not None
        and roster.bot_id is not None
        and last.sender_id == roster.bot_id
        and is_ack(last.content)
    )


@dataclass
class Ops:
    """The rows, derived from the mirror whenever it has moved.

    Every attribute a reader looks at (`_topics`, `_rosters`, `_marks`, …)
    is rebuilt by `refresh()` when the mirror's revision has changed since
    the last derivation, and left alone otherwise — so a board read costs a
    revision check and nothing else while the realm is quiet. `pin()` is the
    tests' seam: it sets those attributes directly and stops `refresh()`
    from overwriting them.
    """

    mirror: Mirror | None = None
    _lock: threading.RLock = field(default_factory=threading.RLock, repr=False)

    # -- state, all of it under _lock, derived from the mirror
    _topics: dict[tuple[str, str], Topic] = field(default_factory=dict, repr=False)
    _rosters: dict[str, Roster | None] = field(default_factory=dict, repr=False)
    _retired: set[str] = field(default_factory=set, repr=False)
    _marks: dict[str, dict[tuple[str, str], int]] = field(default_factory=dict, repr=False)
    _channels: set[str] = field(default_factory=set, repr=False)
    _stream_names: dict[int, str] = field(default_factory=dict, repr=False)
    _front_names: dict[str, str] = field(default_factory=dict, repr=False)
    _live: bool = False
    _reason: str = "starting"
    _error: str | None = None
    _revision: int = -1
    _pinned: bool = False

    # -- the tests' seam ------------------------------------------------------

    def pin(self, *, rosters=None, topics=(), channels=(), live=True, retired=(), reason=None,
            front_names=None, stream_names=None) -> "Ops":
        """Set the derived state by hand and keep it. For tests."""
        with self._lock:
            self._rosters = dict(rosters or {})
            self._retired = set(retired)
            self._topics = {(t.channel, t.topic): t for t in topics}
            self._channels = set(channels)
            self._front_names = dict(front_names or {})
            self._stream_names = dict(stream_names or {})
            self._live = live
            self._reason = reason or ("live" if live else "event queue expired; resyncing")
            self._error = None if live else self._reason
            self._pinned = True
        return self

    # -- derivation ---------------------------------------------------------------

    def refresh(self) -> None:
        """Rebuild the derived state when the mirror has moved."""
        mirror = self.mirror
        if self._pinned or mirror is None:
            return
        health = mirror.health()
        revision = int(health["revision"])
        with self._lock:
            if revision == self._revision:
                self._live = health["state"] == "live"
                self._reason = health["reason"]
                self._error = None if self._live else health["reason"]
                return
        derived = self._derive(mirror)
        with self._lock:
            (self._topics, self._rosters, self._retired, self._marks, self._channels,
             self._stream_names, self._front_names) = derived
            self._revision = revision
            self._live = health["state"] == "live"
            self._reason = health["reason"]
            self._error = None if self._live else health["reason"]

    def _derive(self, mirror: Mirror):
        channels = mirror.channels()
        names = {c.stream_id: c.name for c in mirror.channels(include_archived=True)}
        intros = mirror.intros()
        rosters: dict[str, Roster | None] = {}
        retired: set[str] = set()
        for instance, intro in intros.items():
            rosters[instance] = intro.roster if not intro.retired else None
            if intro.retired:
                retired.add(instance)
        by_id = {r.bot_id: i for i, r in rosters.items() if r is not None and r.bot_id is not None}
        resolved_at = mirror.resolved_times()
        topics: dict[tuple[str, str], Topic] = {}
        front_names: dict[str, str] = {}
        for index in mirror.topics():
            key = (index.channel, index.name)
            held = topics.get(key)
            if held is None:
                held = Topic(channel=index.channel, topic=index.name, live_topic=index.live_name,
                             keep_history=True, resolved=index.resolved)
                topics[key] = held
            elif not index.resolved:
                # An open twin beside a ✔ topic: the conversation is open.
                held.live_topic, held.resolved = index.live_name, False
            for message in mirror.messages(index.channel, index.live_name, across_resolve=False):
                held.add(message.as_zulip())
            if index.resolved:
                held.resolved_at = resolved_at.get((index.channel, index.live_name))
            if index.channel == FRONT_CHANNEL:
                front_names[index.name] = held.live_topic
        marks: dict[str, dict[tuple[str, str], int]] = {i: {} for i, r in rosters.items() if r is not None}
        for note in mirror.notes(tag="served"):
            parsed = parse_served(selfnote("served", note.value))
            instance = by_id.get(note.sender_id)
            if parsed is None or instance is None:
                continue
            remote, message_id = parsed
            remote_key = (remote.channel, bare_topic(remote.topic))
            agent = marks.setdefault(instance, {})
            if message_id > agent.get(remote_key, 0):
                agent[remote_key] = message_id
        return (topics, rosters, retired, marks, {c.name for c in channels}, names, front_names)

    def held_topics(self) -> dict[tuple[str, str], Topic]:
        """The engine's memory, copied: what a completion preview walks."""
        self.refresh()
        with self._lock:
            return dict(self._topics)

    def hydrate_topic(self, channel: str, topic: str) -> Topic | None:
        """One conversation read whole through the mirror, under both its
        names, as a `Topic`; None without a mirror or when nothing is
        there. The Front Desk's read for a conversation the index does not
        hold complete."""
        mirror = self.mirror
        if mirror is None:
            return None
        messages = mirror.messages(channel, topic, hydrate=True)
        if not messages:
            return None
        found = Topic(channel=channel, topic=bare_topic(topic), live_topic=bare_topic(topic), keep_history=True)
        for message in messages:
            found.add(message.as_zulip())
        live = mirror.live_name(channel, topic) or found.live_topic
        found.live_topic = live
        found.resolved = live.startswith(RESOLVED_TOPIC_PREFIX)
        found.history_bounded = len(messages) > ROUTINE_HISTORY
        return found

    def _channel_of(self, stream_id) -> str | None:
        if stream_id is None:
            return None
        with self._lock:
            return self._stream_names.get(int(stream_id))
