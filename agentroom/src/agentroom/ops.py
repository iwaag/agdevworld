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

Nothing is written to disk: a restart is a re-sweep, which is the same
decision the agent room made and for the same reason.

The one thing this engine writes to the realm is a **subscription**. A bot can
*read* any public channel unsubscribed, but an event queue only delivers the
channels it is in (measured in step 2), so watching the realm incrementally
means joining it. It never posts.
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from agag.agent import is_ack
from agag.intro import (
    AGENTS_CHANNEL,
    INTRO_TOPIC_PREFIX,
    Roster,
    parse_roster,
)
from agag.selfnote import is_selfnote, parse_served
from agag.zulip import RESOLVED_TOPIC_PREFIX, QueueExpired, RateLimited, ZulipClient

from .room import SYSTEM_REALM, bare_topic

#: The payload's own version. The view is built against this shape.
SCHEMA = "ag.ops.v1"
#: How long an owed reply may go unanswered before the board calls it stalled.
#: p1 proposed 15 minutes; the p9 incident it exists to catch was 26. A number
#: to tune, never a finding — which is why it is configuration.
DEFAULT_STALLED_SECONDS = 900.0
#: Messages read per topic on a sweep. `agag.zulip.LAST_SPEAKER_LOOKBACK` is
#: the listener's own depth for the same question.
TOPIC_LOOKBACK = 50
#: Served notes read per channel. p1 found 326 for Front alone, and #front
#: answers 354 to this narrow today.
SERVED_LOOKBACK = 400
#: Calls left in the realm quota below which the sweep waits. `agag.zulip`
#: reserves the same for the listeners (`SWEEP_BUDGET_RESERVE`), and the point
#: is the same: the observer must never be the reason an agent is throttled.
BUDGET_RESERVE = 40.0
#: A dead queue must not become a hot retry loop against the realm.
RESYNC_BACKOFF = 30.0

__all__ = [
    "DEFAULT_STALLED_SECONDS",
    "Ops",
    "SCHEMA",
    "Topic",
    "acked",
    "describe",
    "named_in",
    "owns",
    "row_state",
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

    def add(self, message: dict) -> None:
        if not is_real(message):
            return
        found = Message.of(message)
        if self.last is None or found.id >= self.last.id:
            self.last = found
        if "@**" in found.content:
            self.mentions.append(found)
            self.mentions.sort(key=lambda m: m.id)


# --- the two routes --------------------------------------------------------


def owns(roster: Roster, channel: str, topic: str) -> bool:
    """`agag.agent.topic_filter`, reproduced from the posted roster.

    The listener matches its own channel by *name* and its prefixes anywhere.
    Both halves are in the roster because neither can be read from outside.
    """
    return channel == roster.channel or (
        bool(roster.prefixes) and topic.startswith(tuple(roster.prefixes))
    )


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
    """The live reconstruction, refreshed by a Zulip event queue.

    `start()` puts one daemon thread on it. Everything the HTTP side touches
    is read under `_lock`; the thread is the only writer.
    """

    env_path: Path
    stalled_seconds: float = DEFAULT_STALLED_SECONDS
    client_factory: Callable[[Path], ZulipClient] | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _stop: threading.Event = field(default_factory=threading.Event, repr=False)
    _thread: threading.Thread | None = field(default=None, repr=False)

    # -- state, all of it under _lock
    _topics: dict[tuple[str, str], Topic] = field(default_factory=dict, repr=False)
    _rosters: dict[str, Roster | None] = field(default_factory=dict, repr=False)
    _marks: dict[str, dict[tuple[str, str], int]] = field(default_factory=dict, repr=False)
    _channels: set[str] = field(default_factory=set, repr=False)
    #: An `update_message` event names its channel by id and nothing else, so
    #: the sweep's own name/id mapping is what turns a resolve into a row.
    _stream_names: dict[int, str] = field(default_factory=dict, repr=False)
    _live: bool = False
    _reason: str = "starting"
    _error: str | None = None
    _queue_id: str | None = None
    _last_event_at: float | None = None
    _last_sweep_at: float | None = None
    _sweeps: int = 0
    _sweep_calls: int = 0
    _errors: list[dict] = field(default_factory=list, repr=False)

    def client(self) -> ZulipClient:
        factory = self.client_factory or ZulipClient.from_env
        return factory(self.env_path)

    def _patient(self, client: ZulipClient, call, *args, **kwargs):
        """One Zulip call that waits rather than failing the sweep.

        A sweep is ~250 calls and p1 measured HTTP 429 on an immediate repeat
        of one. Two guards, both of them `agag.zulip`'s own discipline: stay
        off the last of the quota so the agents' listeners keep theirs, and
        when 429 comes anyway, wait exactly as long as Zulip asked.
        """
        for attempt in range(4):
            remaining = client.rate_limit_remaining
            if remaining is not None and remaining < BUDGET_RESERVE:
                self._stop.wait(RESYNC_BACKOFF)
            try:
                return call(*args, **kwargs)
            except RateLimited as limited:
                if attempt == 3:
                    raise
                self._stop.wait(max(1.0, limited.retry_after))
        raise RuntimeError("unreachable")

    # -- lifecycle -------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="ops", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                client = self.client()
                # The queue is registered *before* the sweep, so a message
                # that lands mid-sweep is replayed rather than lost. The
                # alternative loses exactly the messages that arrive while
                # the 183 calls are in flight.
                queue_id, last_event_id = self._register(client)
                self._resync(client, queue_id)
                self._poll_forever(client, queue_id, last_event_id)
            except Exception as error:  # a dead relay must say so, not exit
                self._fail(f"{type(error).__name__}: {error}")
                self._stop.wait(RESYNC_BACKOFF)

    def _register(self, client: ZulipClient) -> tuple[str, int]:
        # `update_message` is not in `ZulipClient.register`'s event set and is
        # the whole of the `done` path: a resolve arrives as one event
        # carrying both `orig_subject` and `subject`.
        result = client.call(
            "POST", "register", {"event_types": ["message", "update_message", "subscription"]}
        )
        return result["queue_id"], int(result["last_event_id"])

    def _fail(self, reason: str) -> None:
        with self._lock:
            self._live = False
            self._reason = reason
            self._error = reason
            self._queue_id = None

    # -- the full sweep --------------------------------------------------

    def _resync(self, client: ZulipClient, queue_id: str) -> None:
        before = client.calls
        errors: list[dict] = []

        channels = self._patient(client, client.channels)
        names = sorted(str(channel["name"]) for channel in channels)
        stream_ids = {str(c["name"]): int(c["stream_id"]) for c in channels}

        # Subscribe to everything public. A read needs no subscription; the
        # event queue does (step 2), and `work-` channels appear whenever
        # autolab opens a task. This is the only write this service makes.
        subscribed = {str(s.get("name", "")) for s in self._patient(client, client.subscriptions)}
        missing = [name for name in names if name not in subscribed]
        if missing:
            try:
                self._patient(client, client.subscribe_channels, missing)
            except Exception as error:
                errors.append({"channel": ", ".join(missing), "error": f"subscribe: {error}"})

        rosters = self._read_rosters(client, errors)

        topics: dict[tuple[str, str], Topic] = {}
        marks: dict[str, dict[tuple[str, str], int]] = {
            instance: {} for instance, roster in rosters.items() if roster is not None
        }
        by_id = {r.bot_id: i for i, r in rosters.items() if r is not None and r.bot_id is not None}
        by_name = {r.bot: i for i, r in rosters.items() if r is not None}

        for name in names:
            try:
                found = self._patient(client, client.channel_topics, stream_ids[name])
            except Exception as error:
                errors.append({"channel": name, "error": str(error)})
                continue
            for live in found:
                # Resolved topics are not read on a sweep. `done` is a
                # transition this engine watches happen, not a history it
                # reconstructs — and reading every ✔ topic on the realm would
                # multiply the one cost the plan caps.
                if live.startswith(RESOLVED_TOPIC_PREFIX):
                    continue
                key = (name, bare_topic(live))
                topic = Topic(channel=name, topic=key[1], live_topic=live)
                try:
                    history = self._patient(
                        client, client.topic_history, name, live, num_before=TOPIC_LOOKBACK
                    )
                except Exception as error:
                    errors.append({"channel": f"{name}/{live}", "error": str(error)})
                    continue
                for message in history:
                    topic.add(message)
                topics[key] = topic
            self._served_marks(client, name, marks, by_id, by_name, errors)

        with self._lock:
            self._channels = set(names)
            self._stream_names = {int(v): k for k, v in stream_ids.items()}
            self._rosters = rosters
            self._topics = topics
            self._marks = marks
            self._errors = errors
            self._queue_id = queue_id
            self._live = True
            self._reason = "live"
            self._error = None
            self._last_sweep_at = time.time()
            self._sweeps += 1
            self._sweep_calls = client.calls - before

    def _read_rosters(self, client: ZulipClient, errors: list[dict]) -> dict[str, Roster | None]:
        """Every instance on the board, and the routing it declares.

        `None` is kept as an answer: an introduction with no roster block is an
        instance whose routing is *unknown*, and a default here would be the
        guessed roster p1 charged 66 phantom stalls for.
        """
        found: dict[str, Roster | None] = {}
        try:
            stream_id = client.stream_id(AGENTS_CHANNEL)
            board = client.channel_topics(stream_id)
        except Exception as error:
            errors.append({"channel": AGENTS_CHANNEL, "error": str(error)})
            return found
        for live in board:
            name = bare_topic(live)
            if not name.startswith(INTRO_TOPIC_PREFIX):
                continue
            instance = name[len(INTRO_TOPIC_PREFIX):]
            try:
                history = client.topic_history(AGENTS_CHANNEL, live, num_before=1)
            except Exception as error:
                errors.append({"channel": f"{AGENTS_CHANNEL}/{live}", "error": str(error)})
                found[instance] = None
                continue
            found[instance] = parse_roster(history[-1].get("content", "")) if history else None
        return found

    def _served_marks(
        self,
        client: ZulipClient,
        channel: str,
        marks: dict[str, dict[tuple[str, str], int]],
        by_id: dict[int, str],
        by_name: dict[str, str],
        errors: list[dict],
    ) -> None:
        """Every agent's `[selfnote][served]` notes written in one channel.

        One call per channel rather than one per agent, and **channel-scoped
        rather than global**, which is not a choice: a narrow with no channel
        operator returns nothing at all for this bot. Zulip answers a global
        search from the reader's own per-user index, and a credential created
        yesterday has no rows in it for anything posted before — an observer
        that searched the realm the way p1's probe did (as the Developer, an
        owner subscribed since the realm was built) would read every answered
        callback as never answered. Scoping by channel reads the channel's own
        messages and is correct for an identity of any age.

        A served note is written **into home**, and home is always a
        conversation the agent owns, so the channels worth asking are the
        channels — which is every one this sweep already walks.
        """
        narrow = [
            {"operator": "channel", "operand": channel},
            {"operator": "search", "operand": "served"},
        ]
        try:
            messages = self._patient(
                client, client.call, "GET", "messages",
                {
                    "anchor": "newest",
                    "num_before": str(SERVED_LOOKBACK),
                    "num_after": "0",
                    "apply_markdown": "false",
                    "narrow": json.dumps(narrow),
                },
            ).get("messages", [])
        except Exception as error:
            errors.append({"channel": f"served:{channel}", "error": str(error)})
            return
        for message in messages:
            parsed = parse_served(message.get("content"))
            if parsed is None:
                continue
            instance = by_id.get(int(message.get("sender_id") or 0)) or by_name.get(
                str(message.get("sender_full_name") or "")
            )
            if instance is None:
                continue  # a note by somebody with no roster explains nothing
            remote, message_id = parsed
            key = (remote.channel, bare_topic(remote.topic))
            agent = marks.setdefault(instance, {})
            if message_id > agent.get(key, 0):
                agent[key] = message_id

    # -- the incremental half --------------------------------------------

    def _poll_forever(self, client: ZulipClient, queue_id: str, last_event_id: int) -> None:
        while not self._stop.is_set():
            try:
                events = client.poll(queue_id, last_event_id)
            except RateLimited as limited:
                # Not a dead queue: the sweep that just ran spent the budget.
                # Waiting keeps the data live; resyncing would spend it again.
                self._stop.wait(max(1.0, limited.retry_after))
                continue
            except QueueExpired:
                # The documented way back is a re-sweep, and the only one.
                self._fail("event queue expired; resyncing")
                return
            for event in events:
                last_event_id = max(last_event_id, int(event.get("id", last_event_id)))
                self._apply(event)
            with self._lock:
                if events:
                    self._last_event_at = time.time()
                self._live = True
                self._reason = "live"

    def _apply(self, event: dict) -> None:
        kind = event.get("type")
        if kind == "message":
            self._apply_message(event.get("message") or {})
        elif kind == "update_message":
            self._apply_update(event)
        elif kind == "subscription":
            # A channel this service just joined; its topics arrive as events
            # from here on, and its history at the next resync.
            pass

    def _apply_message(self, message: dict) -> None:
        if message.get("type") != "stream":
            return
        channel = str(message.get("display_recipient") or "")
        live = str(message.get("subject") or "")
        if not channel or not live:
            return
        key = (channel, bare_topic(live))

        with self._lock:
            # An introduction re-posted while this runs updates the roster in
            # place: the contract says re-post after a behavior change, and an
            # observer that needs a restart to notice has not honoured it.
            if channel == AGENTS_CHANNEL and key[1].startswith(INTRO_TOPIC_PREFIX):
                instance = key[1][len(INTRO_TOPIC_PREFIX):]
                self._rosters[instance] = parse_roster(str(message.get("content") or ""))

            # A served note is the mention route's memory, and it is a post
            # like any other — so the marks stay current without a re-sweep.
            parsed = parse_served(message.get("content"))
            if parsed is not None:
                remote, message_id = parsed
                sender = str(message.get("sender_full_name") or "")
                sender_id = int(message.get("sender_id") or 0)
                for instance, roster in self._rosters.items():
                    if roster is None:
                        continue
                    if roster.bot_id == sender_id or roster.bot == sender:
                        marks = self._marks.setdefault(instance, {})
                        remote_key = (remote.channel, bare_topic(remote.topic))
                        if message_id > marks.get(remote_key, 0):
                            marks[remote_key] = message_id

            topic = self._topics.get(key)
            if topic is None:
                topic = Topic(channel=channel, topic=key[1], live_topic=live)
                self._topics[key] = topic
            topic.live_topic = live
            topic.resolved = live.startswith(RESOLVED_TOPIC_PREFIX)
            topic.add(message)

    def _apply_update(self, event: dict) -> None:
        """A topic rename, which is how `done` arrives.

        Keys are bare names, so a ✔ is a flag on the row rather than a new
        row beside it — the whole point of bare-topic keying. A rename to a
        genuinely different name moves the entry instead.
        """
        original = event.get("orig_subject")
        renamed = event.get("subject")
        if original is None or renamed is None:
            return
        channel = self._channel_of(event.get("stream_id"))
        if channel is None:
            return
        old_key = (channel, bare_topic(str(original)))
        new_key = (channel, bare_topic(str(renamed)))
        with self._lock:
            topic = self._topics.get(old_key)
            if topic is None:
                return
            if old_key != new_key:
                del self._topics[old_key]
                topic.channel, topic.topic = new_key
                self._topics[new_key] = topic
            topic.live_topic = str(renamed)
            topic.resolved = str(renamed).startswith(RESOLVED_TOPIC_PREFIX)

    def _channel_of(self, stream_id) -> str | None:
        """An update event names a stream by id; the sweep knows the names."""
        if stream_id is None:
            return None
        with self._lock:
            return self._stream_names.get(int(stream_id))

    # -- what the view reads ---------------------------------------------

    def snapshot(self, now: float | None = None) -> dict:
        """The whole payload, computed on demand.

        `now` is a seam for the tests: every state on this board is an *age*,
        so a test that cannot fix the clock can only assert the shape.
        """
        now = time.time() if now is None else now
        with self._lock:
            live = self._live
            reason = self._reason
            error = self._error
            rosters = dict(self._rosters)
            marks = {k: dict(v) for k, v in self._marks.items()}
            topics = list(self._topics.values())
            channels = set(self._channels)
            queue_id = self._queue_id
            last_event_at = self._last_event_at
            last_sweep_at = self._last_sweep_at
            sweeps = self._sweeps
            sweep_calls = self._sweep_calls
            errors = list(self._errors)

        stalled_minutes = self.stalled_seconds / 60
        rows: list[dict] = []
        instances: list[dict] = []

        for instance in sorted(rosters):
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
            # The plan's rule 3, applied to the whole payload: while the queue
            # is dead this data is of unknown age, and p9's 26 silent minutes
            # looked exactly like a quiet board. The last known state is kept
            # as evidence, never as the answer.
            for row in rows:
                row["stale_state"] = row["state"]
                row["state"] = "unknown"
                row["provenance"]["text"] = (
                    f"unknown — the relay is not reading Zulip ({reason}); "
                    f"last known: {row['provenance']['text']}"
                )
            for summary in instances:
                summary["state"] = "unknown"

        order = {"stalled": 0, "unknown": 1, "awaiting": 2, "acked": 3, "done": 4}
        rows.sort(key=lambda r: (order.get(r["state"], 9), -(r.get("age_seconds") or 0)))

        return {
            "schema": SCHEMA,
            "generated_at": now,
            "settings": {"stalled_seconds": self.stalled_seconds},
            "health": {
                "state": "live" if live else "unknown",
                "reason": reason,
                "error": error,
                "queue": queue_id is not None,
                "last_event_at": last_event_at,
                "last_sweep_at": last_sweep_at,
                "sweeps": sweeps,
                "sweep_calls": sweep_calls,
                "channels": len(channels),
                "topics": len(topics),
            },
            "instances": instances,
            "rows": rows,
            "errors": errors,
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
                "message_id": found["message_id"],
                "message_at": found["message_at"],
                "by": found["by"],
                "served_mark": found["served_mark"],
                "route": found["route"],
                "resolved": topic.resolved,
            },
        }
