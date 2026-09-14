"""The operation room's state engine: who owes a reply, and for how long.

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

import json
import threading
import time
from dataclasses import dataclass, field

from agag.agent import is_ack
from agag.intro import (
    AGENTS_CHANNEL,
    INTRO_TOPIC_PREFIX,
    Roster,
    parse_roster,
)
from agag.selfnote import Conversation, is_selfnote, parse_rootchat, parse_served, note as selfnote
from agag.mirror import Mirror
from agag.zulip import RESOLVED_TOPIC_PREFIX

from .autolab import notes_in
from .forge import notes_in as forge_notes_in
from .frontdesk import FRONT_CHANNEL
from .inflight import Inflight
from .room import SYSTEM_REALM, bare_topic
from .routines import ROUTINE_HISTORY, routine_rows, session_list, sessions_of

#: The payload's own version. The view is built against this shape.
SCHEMA = "ag.ops.v1"
#: The routine board's own version (`operation_room` p3).
ROUTINES_SCHEMA = "ag.routines.v2"
#: The host-side in-flight signal's version. A separate payload because it is
#: the only one that may be polled fast, and it must be obvious that nothing
#: in it came from Zulip.
INFLIGHT_SCHEMA = "ag.inflight.v1"
#: How long an owed reply may go unanswered before the board calls it stalled.
#: p1 proposed 15 minutes; the p9 incident it exists to catch was 26. A number
#: to tune, never a finding — which is why it is configuration.
DEFAULT_STALLED_SECONDS = 900.0
#: How long a `done` row stays a receipt. A resolve the mirror watched
#: happen within this window is on the board until somebody confirms it;
#: older resolves are history. The old engine kept receipts for as long as
#: the process lived and lost them at every restart; the mirror persists,
#: so the window is what bounds the board now.
DEFAULT_DONE_SECONDS = 24 * 3600.0
#: The mirror's meta key the confirmations persist under, so a relay restart
#: does not resurrect every receipt a human already dismissed.
CONFIRMED_KEY = "ops.confirmed"

__all__ = [
    "DEFAULT_DONE_SECONDS",
    "DEFAULT_STALLED_SECONDS",
    "INFLIGHT_SCHEMA",
    "Ops",
    "ROUTINES_SCHEMA",
    "SCHEMA",
    "Topic",
    "acked",
    "by_prefix",
    "describe",
    "summarize",
    "named_in",
    "owns",
    "row_state",
    "shown_state",
    "state_of",
]


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
    #: autolab's own notes written in this topic — what mission or task this
    #: conversation *is*, and how far it has got (`autolab.notes_in`). The
    #: third link note, retained for the same reason as the other two: since
    #: `refactor` p1 there is no Plane issue for a `[work]` note to name, so
    #: this is where an autolab conversation says what it is. Not in
    #: `history` — a selfnote is never a real post.
    autolab: list[tuple[str, str, int, int, str]] = field(default_factory=list)
    #: forge's own notes, the same shape and the same reason one phase later
    #: (`refactor` p2, `forge.notes_in`): what request or run this
    #: conversation *is*. The `[work]` note both agents used to write named a
    #: Plane issue and is gone; nothing retains it, because nothing writes it.
    forge: list[tuple[str, str, int, int, str]] = field(default_factory=list)
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
        for note in notes_in([message]):
            entry = note.as_tuple()
            if entry not in self.autolab:
                self.autolab.append(entry)
                self.autolab.sort(key=lambda kept: kept[2])
        for note in forge_notes_in([message]):
            entry = note.as_tuple()
            if entry not in self.forge:
                self.forge.append(entry)
                self.forge.sort(key=lambda kept: kept[2])
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
    topic and never which instance: `agechoplan-` is both agecho instances',
    `workplan-` is every autolab's. p1 read that ambiguity as observer error
    and charged one bot 59 phantom stalled rows for it. It is not an error —
    both listeners really would sweep such a topic — so the board states it
    rather than picking a winner.
    """
    return bool(roster.prefixes) and topic.startswith(tuple(roster.prefixes))


def named_in(topic: Topic, roster: Roster, mark: int) -> Message | None:
    """The oldest post naming this agent that no served note covers.

    The mention route, and it applies **only to a topic the agent does not
    own**. p1's first pass ran the served-note differencing over owned topics
    too and reported a five-day-old unanswered call that had been answered in
    place two minutes later: an owner answers *in the topic* and writes no
    served note, so differencing there reports every answered call as pending
    forever. Split by ownership first, then choose the route.
    """
    needle = f"@**{roster.bot}**"
    for message in topic.mentions:
        if message.id <= mark:
            continue
        if roster.bot_id is not None and message.sender_id == roster.bot_id:
            continue
        if needle in message.content:
            return message
    return None


def state_of(age_seconds: float, stalled_seconds: float) -> str:
    return "stalled" if age_seconds >= stalled_seconds else "awaiting"


def row_state(
    topic: Topic,
    roster: Roster,
    mark: int,
    now: float,
    stalled_seconds: float,
) -> dict | None:
    """This agent's state in this conversation, with the evidence for it.

    Returns `None` when the agent has nothing outstanding here — which is most
    of the realm most of the time, and is why the board is a list of what is
    owed rather than a list of everything.
    """
    owner = owns(roster, topic.channel, topic.topic)
    if topic.resolved:
        # `done` is the ✔ rename and nothing else — the system's own definition
        # everywhere. Only a topic this agent was party to is its `done`.
        if not owner and named_in(topic, roster, 0) is None:
            return None
        return {
            "state": "done",
            "route": "resolved",
            "age_seconds": round(now - topic.last.timestamp, 1) if topic.last else None,
            "message_id": topic.last.id if topic.last else None,
            "message_at": topic.last.timestamp if topic.last else None,
            "by": topic.last.sender if topic.last else None,
            "served_mark": mark or None,
        }
    if owner:
        last = topic.last
        if last is None:
            return None  # a topic holding only selfnotes: nobody has spoken
        if roster.bot_id is not None and last.sender_id == roster.bot_id:
            return None  # it answered; the topic is quiet until somebody speaks
        # An ack by *somebody else* is still somebody else speaking. An ack by
        # this agent is not the last real post by definition of the branch
        # above, so the only ack that matters is one it wrote and was then
        # spoken over — which is a normal awaiting.
        age = now - last.timestamp
        return {
            "state": state_of(age, stalled_seconds),
            "route": "owner",
            "age_seconds": round(age, 1),
            "message_id": last.id,
            "message_at": last.timestamp,
            "by": last.sender,
            "served_mark": None,
        }
    named = named_in(topic, roster, mark)
    if named is None:
        return None
    age = now - named.timestamp
    return {
        "state": state_of(age, stalled_seconds),
        "route": "mention",
        "age_seconds": round(age, 1),
        "message_id": named.id,
        "message_at": named.timestamp,
        "by": named.sender,
        "served_mark": mark or None,
    }


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


def summarize(row: dict, instance: str) -> str:
    """The provenance a *card* has room for.

    Measured, not guessed: the panel's status line wraps at about 28
    characters, so the full sentence below runs to six lines and spills
    through the card's border — the same defect `agent_room` step 5 found by
    looking, and could not have found any other way. Both strings are served
    because a row needs its evidence on the board (plan rule 2) *and* the whole
    of it one click away.
    """
    age = row.get("age_seconds")
    minutes = f"{age / 60:.0f} min" if age is not None else "unknown age"
    ident = f"#{row['message_id']}" if row.get("message_id") else "no post"
    who = row.get("by") or "somebody"
    served = f"served ≤#{row['served_mark']}" if row.get("served_mark") else "no served note"
    state = row["state"]
    if state == "done":
        return f"✔ resolved · last post {ident} by {who}"
    if state == "acked":
        return f"ack posted {minutes} ago, no answer yet"
    return f"{minutes} unanswered · {ident} by {who} · {served}"


def shown_state(row: dict) -> str:
    """The state a rendered row is actually *wearing*.

    While the queue is dead every row reads `unknown` and keeps its last
    verdict in `stale_state`; confirm has to act on what the human is looking
    at, not on the field underneath it. Everywhere else the two are the same.
    """
    return str(row.get("stale_state") or row["state"])


def describe(row: dict, instance: str, stalled_minutes: float) -> str:
    """One line of provenance. Every colour on this board is an inference from
    somebody else's leftovers, so the screen says what it inferred it from."""
    age = row.get("age_seconds")
    minutes = f"{age / 60:.0f} min" if age is not None else "an unknown time"
    who = row.get("by") or "somebody"
    ident = f"#{row['message_id']}" if row.get("message_id") else "an unread post"
    served = (
        f"served note up to #{row['served_mark']}"
        if row.get("served_mark")
        else "no served note"
    )
    state = row["state"]
    if state == "done":
        return f"done — topic carries ✔ ; last real post {ident} by {who}, {minutes} ago"
    if state == "acked":
        return f"acked — {instance} posted its ack {ident} {minutes} ago and has not answered"
    if state == "stalled":
        return (
            f"stalled — {minutes} since {who}'s post {ident} "
            f"(threshold {stalled_minutes:.0f} min), {served}, {row['route']} route"
        )
    return f"awaiting — {minutes} since {who}'s post {ident}, {served}, {row['route']} route"


# --- the engine ------------------------------------------------------------


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
    stalled_seconds: float = DEFAULT_STALLED_SECONDS
    #: `instance -> project root` for the in-flight signal. Empty is an
    #: answer: every instance then reports `known: false`.
    agent_roots: dict = field(default_factory=dict)
    done_seconds: float = DEFAULT_DONE_SECONDS
    _lock: threading.RLock = field(default_factory=threading.RLock, repr=False)

    # -- state, all of it under _lock, derived from the mirror
    _topics: dict[tuple[str, str], Topic] = field(default_factory=dict, repr=False)
    _rosters: dict[str, Roster | None] = field(default_factory=dict, repr=False)
    _retired: set[str] = field(default_factory=set, repr=False)
    _marks: dict[str, dict[tuple[str, str], int]] = field(default_factory=dict, repr=False)
    _channels: set[str] = field(default_factory=set, repr=False)
    _stream_names: dict[int, str] = field(default_factory=dict, repr=False)
    #: `(channel, bare topic)` a human has said they have seen, and the id of
    #: the last post at the moment they said it. Persisted in the mirror's
    #: store, so a restart does not show a board of debts already seen.
    _confirmed: dict[tuple[str, str], int] = field(default_factory=dict, repr=False)
    _front_names: dict[str, str] = field(default_factory=dict, repr=False)
    _live: bool = False
    _reason: str = "starting"
    _error: str | None = None
    _revision: int = -1
    _pinned: bool = False
    _loaded: bool = False

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
            if not self._loaded:
                self._confirmed = self._load_confirmed()
                self._loaded = True
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

    # -- confirmations, persisted ------------------------------------------------

    def _load_confirmed(self) -> dict[tuple[str, str], int]:
        if self.mirror is None:
            return {}
        raw = self.mirror.store.get_meta(CONFIRMED_KEY)
        if not raw:
            return {}
        try:
            rows = json.loads(raw)
        except ValueError:
            return {}
        found: dict[tuple[str, str], int] = {}
        for row in rows if isinstance(rows, list) else []:
            try:
                found[(str(row["channel"]), str(row["topic"]))] = int(row["message_id"])
            except (KeyError, TypeError, ValueError):
                continue
        return found

    def _save_confirmed(self) -> None:
        if self.mirror is None:
            return
        rows = [{"channel": c, "topic": t, "message_id": i} for (c, t), i in sorted(self._confirmed.items())]
        self.mirror.store.set_meta(CONFIRMED_KEY, json.dumps(rows))

    def _channel_of(self, stream_id) -> str | None:
        if stream_id is None:
            return None
        with self._lock:
            return self._stream_names.get(int(stream_id))

    # -- what a human clears -----------------------------------------------

    def confirm(
        self, target: tuple[str, str] | None = None, now: float | None = None
    ) -> dict:
        """Mark the `done` rows as seen, so the board can stop showing them.

        This board's principle is that evidence stays until a human has looked
        at it, so `done` is not evicted on a timer — it is dismissed, by hand,
        and `done` is the *only* state that may be. `stalled`, `awaiting` and
        `acked` are live debt, and a button that clears live debt from the
        screen is p9's twenty-six unnoticed minutes with a shortcut to it. The
        check is here and not only in the view: a screen that hides a button is
        not a rule, it is a habit.

        What is recorded is the row *as it stood* — `(channel, topic)` and the
        id of its last post. So the hiding expires by itself: any later post,
        an unresolve included, carries a higher id and floats the row back up.
        """
        board = self.snapshot(now)
        if target is None:
            # "All of them" means all the *done* ones. The live debt beside
            # them is not refused here, it is simply not what was asked for.
            here = [row for row in board["rows"] if shown_state(row) == "done"]
            refused: list[str] = []
        else:
            here = [
                row
                for row in board["rows"]
                if (row["channel"], row["topic"]) == target
            ]
            if not here:
                return {
                    "confirmed": 0,
                    "topics": [],
                    "refused": [],
                    "error": f"no row for {target[0]} / {target[1]} is on the board",
                }
            refused = sorted({
                shown_state(row) for row in here if shown_state(row) != "done"
            })
        if refused:
            return {
                "confirmed": 0,
                "topics": [],
                "refused": refused,
                "error": (
                    "only done rows can be confirmed; "
                    + ", ".join(refused)
                    + " is still owed"
                ),
            }

        marks: dict[tuple[str, str], int] = {}
        for row in here:
            if row["channel"] is None or row["topic"] is None:
                continue  # an instance-level unknown row belongs to no topic
            key = (row["channel"], row["topic"])
            ident = int(row["provenance"].get("message_id") or 0)
            marks[key] = max(marks.get(key, 0), ident)
        with self._lock:
            for key, ident in marks.items():
                if ident >= self._confirmed.get(key, 0):
                    self._confirmed[key] = ident
            self._save_confirmed()
        return {
            "confirmed": len(here),
            "topics": [
                {"channel": channel, "topic": topic, "message_id": ident}
                for (channel, topic), ident in sorted(marks.items())
            ],
            "refused": [],
        }

    # -- routines ----------------------------------------------------------

    def routines(self, now: float | None = None) -> dict:
        """The routine board: every routine channel, its guide, its latest run.

        It reuses `snapshot()` for health and for the conversation states
        rather than deciding either again — one engine, one verdict. It costs
        no Zulip call at all: these topics are in the mirror.
        """
        now = time.time() if now is None else now
        board = self.snapshot(now)
        with self._lock:
            topics = dict(self._topics)
            channels = set(self._channels)
        rows = routine_rows(topics, now, stalled_seconds=self.stalled_seconds, channels=channels)
        if board["health"]["state"] != "live":
            # The same rule the ops board obeys: while the mirror is stale
            # this is the last thing known and not the state now.
            for row in rows:
                row["stale_state"] = row["state"]
                row["state"] = "unknown"
        return {
            "schema": ROUTINES_SCHEMA,
            "generated_at": now,
            "settings": {"stalled_seconds": self.stalled_seconds},
            "health": board["health"],
            "routines": rows,
        }

    def routine(
        self, name: str, now: float | None = None, *, include_resolved: bool = True
    ) -> dict:
        """One routine: its row, the last runs as trees, and the chat.

        The tree is built from the link notes and every node's *state* is
        lifted from the ops board unchanged — one engine, one verdict, which
        is the plan's "do not implement the state calculation twice".
        """
        now = time.time() if now is None else now
        board = self.snapshot(now)
        with self._lock:
            topics = dict(self._topics)
            channels = set(self._channels)
        rows = routine_rows(topics, now, stalled_seconds=self.stalled_seconds, channels=channels)
        row = next((one for one in rows if one["name"] == name), None)
        if row is None:
            return {"error": f"no routine named {name}", "routines": [one["name"] for one in rows]}
        by_topic: dict[tuple[str, str], list[dict]] = {}
        for one in board["rows"]:
            if one["channel"] is None or one["topic"] is None:
                continue
            by_topic.setdefault((one["channel"], one["topic"]), []).append(one)
        listed = session_list(
            topics, name, by_topic, include_resolved=include_resolved, now=now,
            stalled_seconds=self.stalled_seconds,
        )
        if board["health"]["state"] != "live":
            row["stale_state"] = row["state"]
            row["state"] = "unknown"
        return {
            "schema": ROUTINES_SCHEMA,
            "generated_at": now,
            "settings": {"stalled_seconds": self.stalled_seconds},
            "health": board["health"],
            "routine": row,
            # Each session carries its own `chat` (the run topic, whole): the
            # server adds a top-level `chat` block saying whether this relay
            # may post at all, and the two must not share a key.
            "sessions": listed["sessions"],
            # The routine's actual newest run, whatever the filter left
            # visible: host observation and "is this the latest" both hang
            # off it.
            "latest_topic": listed["latest_topic"],
            "history": listed["history"],
            "filter": {"include_resolved": include_resolved},
        }

    def inflight(self, name: str, now: float | None = None) -> dict:
        """The **non-Zulip** half, for the selected routine's newest session.

        This is the only thing in this service that may be polled at a few
        seconds, and it is allowed because it touches no realm: every answer
        below is a `stat` of this host's own directories.

        Who is looked at is decided by the **roster**, not by who happens to
        owe a reply: an agent with no open row is exactly the one a human wants
        to know is still running.
        """
        now = time.time() if now is None else now
        self.refresh()
        with self._lock:
            topics = dict(self._topics)
            rosters = {i: r for i, r in self._rosters.items() if r is not None}
            retired = set(self._retired)
        sessions = sessions_of(topics, name, {}, now=now)
        session = sessions[0] if sessions else None
        watched: list[tuple[str, str]] = []
        if session is not None:
            watched.append((session["channel"], session["topic"]))
        for node in (session or {}).get("nodes", []):
            watched.append((node["channel"], node["topic"]))
        look = Inflight(roots=self.agent_roots)
        seen: set[tuple[str, str, str]] = set()
        rows: list[dict] = []
        agents: dict[str, dict] = {}
        for channel, topic in watched:
            for instance, roster in rosters.items():
                if instance in retired or not owns(roster, channel, topic):
                    continue
                key = (instance, channel, topic)
                if key in seen:
                    continue
                seen.add(key)
                rows.append(look.look(instance, channel, topic))
                if instance not in agents:
                    agents[instance] = look.busy(instance)
        return {
            "schema": INFLIGHT_SCHEMA,
            "generated_at": now,
            "routine": name,
            "configured": bool(self.agent_roots),
            "session": None if session is None else {
                "channel": session["channel"], "topic": session["topic"],
                "opened": session["opened"], "nodes": len(session["nodes"]),
            },
            "topics": rows,
            "agents": sorted(agents.values(), key=lambda row: row["instance"]),
        }

    # -- what the view reads ---------------------------------------------

    def _health(self) -> dict:
        """The board's health block: the mirror's, in the words the views
        already read (`state`, `reason`, `error`, `queue`, …)."""
        base = self.mirror.health() if self.mirror is not None and not self._pinned else None
        with self._lock:
            live, reason, error = self._live, self._reason, self._error
            channels, topics = len(self._channels), len(self._topics)
        return {
            "state": "live" if live else "unknown",
            "reason": reason,
            "error": error,
            "queue": bool(base and base.get("queue")),
            "last_event_at": base.get("last_event_at") if base else None,
            "last_resync_at": base.get("last_resync_at") if base else None,
            "resyncs": int(base.get("resyncs") or 0) if base else 0,
            "resync_calls": int(base.get("resync_calls") or 0) if base else 0,
            "revision": int(base.get("revision") or 0) if base else 0,
            "stale_since": base.get("stale_since") if base else None,
            "channels": channels,
            "topics": topics,
        }

    def _recent_done(self, topic: Topic, now: float) -> bool:
        """Whether a resolved topic is still a receipt rather than history."""
        if self._pinned and topic.resolved_at is None:
            return True  # a pinned fixture says nothing about time
        return topic.resolved_at is not None and now - topic.resolved_at <= self.done_seconds

    def snapshot(self, now: float | None = None) -> dict:
        """The whole payload, computed on demand.

        `now` is a seam for the tests: every state on this board is an *age*,
        so a test that cannot fix the clock can only assert the shape.
        """
        now = time.time() if now is None else now
        self.refresh()
        with self._lock:
            live = self._live
            reason = self._reason
            rosters = dict(self._rosters)
            retired = set(self._retired)
            marks = {k: dict(v) for k, v in self._marks.items()}
            topics = list(self._topics.values())
            channels = set(self._channels)
            confirmed = dict(self._confirmed)
        health = self._health()

        stalled_minutes = self.stalled_seconds / 60
        rows: list[dict] = []
        instances: list[dict] = []

        for instance in sorted(rosters):
            if instance in retired:
                # A ✔ on the introduction is the realm saying this agent is
                # gone. It leaves the board rather than sitting in amber
                # forever, and `retired` below is why it is not there — a
                # disappearance nobody can account for is the failure this
                # board exists to prevent, so the payload accounts for it.
                continue
            roster = rosters[instance]
            summary = {
                "instance": instance,
                "roster": "intro" if roster is not None else "missing",
                "bot": roster.bot if roster else None,
                "bot_id": roster.bot_id if roster else None,
                "channel": roster.channel if roster else None,
                # Declared, not assumed. Front declares `front-agstudio1` and
                # no such channel is on the realm; it is served by its prefix.
                "channel_exists": (roster.channel in channels) if roster else None,
                "prefixes": list(roster.prefixes) if roster else [],
                "served_marks": len(marks.get(instance, {})),
                "counts": {"awaiting": 0, "stalled": 0, "acked": 0, "done": 0, "unknown": 0},
                #: done rows of this instance a human has already dismissed.
                "confirmed": 0,
            }
            if roster is None:
                # Rule 3 of the plan, at the level of a whole agent: an
                # introduction with no roster block is an agent whose work
                # cannot be read, and that is not the same as an agent with
                # nothing to do.
                summary["state"] = "unknown"
                summary["counts"]["unknown"] = 1
                rows.append({
                    "instance": instance,
                    "bot": None,
                    "channel": None,
                    "topic": None,
                    "live_topic": None,
                    "state": "unknown",
                    "route": None,
                    "age_seconds": None,
                    "provenance": {
                        "text": (
                            f"unknown — {instance} has an introduction on #agents but no "
                            f"roster block, so nothing can be said about what it owes"
                        ),
                        "short": "introduction carries no roster block",
                    },
                })
                instances.append(summary)
                continue

            summary["state"] = "ok"
            agent_marks = marks.get(instance, {})
            for topic in topics:
                mark = agent_marks.get((topic.channel, topic.topic), 0)
                found = row_state(topic, roster, mark, now, self.stalled_seconds)
                if found is None:
                    continue
                if found["state"] == "done" and not self._recent_done(topic, now):
                    continue  # resolved long ago: history, not a receipt
                summary["counts"][found["state"]] += 1
                rows.append(self._row(instance, roster, topic, found, stalled_minutes))
            # `acked` is not "owed a reply", so it is not one of the routes; it
            # is the same topic seen one post later, and it is the only
            # "running" this layer can honestly claim.
            for topic in topics:
                if topic.resolved or not acked(topic, roster):
                    continue
                if not owns(roster, topic.channel, topic.topic):
                    continue
                found = {
                    "state": "acked",
                    "route": "owner",
                    "age_seconds": round(now - topic.last.timestamp, 1),
                    "message_id": topic.last.id,
                    "message_at": topic.last.timestamp,
                    "by": topic.last.sender,
                    "served_mark": None,
                }
                summary["counts"]["acked"] += 1
                rows.append(self._row(instance, roster, topic, found, stalled_minutes))
            instances.append(summary)

        if not live:
            # The plan's rule 3, applied to the whole payload: while the
            # mirror is stale this data is of unknown age, and p9's 26 silent
            # minutes looked exactly like a quiet board. The last known state
            # is kept as evidence, never as the answer.
            for row in rows:
                row["stale_state"] = row["state"]
                row["state"] = "unknown"
                row["provenance"]["text"] = (
                    f"unknown — the relay is not reading Zulip ({reason}); "
                    f"last known: {row['provenance']['text']}"
                )
                row["provenance"]["short"] = (
                    f"relay not reading Zulip · last known {row['stale_state']}"
                )
            for summary in instances:
                summary["state"] = "unknown"

        # A topic owned by prefix alone is owed by every instance of that
        # agent, and each row says so rather than the board quietly showing
        # what looks like a duplicate.
        shared: dict[tuple[str, str], list[str]] = {}
        for row in rows:
            if row.get("route") not in ("owner", "resolved") or row["topic"] is None:
                continue
            roster = rosters.get(row["instance"])
            if roster is None or not by_prefix(roster, row["topic"]):
                continue
            if row["channel"] == roster.channel:
                continue
            shared.setdefault((row["channel"], row["topic"]), []).append(row["instance"])
        for row in rows:
            others = [
                name
                for name in shared.get((row["channel"], row["topic"]), [])
                if name != row["instance"]
            ]
            if not others:
                continue
            row["provenance"]["shared_with"] = others
            row["provenance"]["text"] += (
                f" · the topic prefix is shared with {', '.join(others)}, "
                f"which would sweep it too"
            )

        # A `done` row is the receipt for a debt that was paid, and it stays on
        # the board until somebody says they have seen it (`confirm`). Hiding
        # is by *mark*, not by deletion: the row is dropped only while it is
        # still done and no post newer than the confirmed one has landed, so an
        # unresolve — or any reply into a closed topic — brings it straight
        # back.
        hidden = 0
        if confirmed:
            summaries = {summary["instance"]: summary for summary in instances}
            kept = []
            for row in rows:
                mark = confirmed.get((row["channel"], row["topic"]))
                ident = row["provenance"].get("message_id") or 0
                if mark is not None and shown_state(row) == "done" and ident <= mark:
                    hidden += 1
                    summary = summaries.get(row["instance"])
                    if summary is not None:
                        summary["counts"]["done"] = max(0, summary["counts"]["done"] - 1)
                        summary["confirmed"] += 1
                    continue
                kept.append(row)
            rows = kept

        order = {"stalled": 0, "unknown": 1, "awaiting": 2, "acked": 3, "done": 4}
        rows.sort(key=lambda r: (order.get(r["state"], 9), -(r.get("age_seconds") or 0)))

        return {
            "schema": SCHEMA,
            "generated_at": now,
            "settings": {"stalled_seconds": self.stalled_seconds, "done_seconds": self.done_seconds},
            "health": health,
            "confirmed": {"rows": hidden, "topics": len(confirmed)},
            #: Instances the realm has retired (a ✔ on their `intro-` topic).
            #: Named rather than merely absent: a reader must be able to tell
            #: "gone on purpose" from "never seen".
            "retired": sorted(retired),
            "instances": instances,
            "rows": rows,
            "errors": [],
        }

    def _row(
        self, instance: str, roster: Roster, topic: Topic, found: dict, stalled_minutes: float
    ) -> dict:
        return {
            "instance": instance,
            "bot": roster.bot,
            "channel": topic.channel,
            "topic": topic.topic,
            "live_topic": topic.live_topic,
            "state": found["state"],
            "route": found["route"],
            "age_seconds": found["age_seconds"],
            # The plan asks the JSON to carry the evidence so the view only
            # renders it. Every state here is an inference from a trace left
            # for another purpose, and this is what it was inferred from.
            "provenance": {
                "text": describe(found, instance, stalled_minutes),
                "short": summarize(found, instance),
                "message_id": found["message_id"],
                "message_at": found["message_at"],
                "by": found["by"],
                "served_mark": found["served_mark"],
                "route": found["route"],
                "resolved": topic.resolved,
            },
        }
