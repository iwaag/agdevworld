"""What finishing one request actually means, discovered.

A request is rarely one topic. The Developer asks Front for something; Front
opens a workplan topic in a project channel; autolab plans it — the plan is
a post in that topic — and opens a `work-m<id>` channel with one `workrun-`
topic per task; Front follows the callbacks back. When the thing is done,
five conversations, one channel and a forge Work are all still open, and the
human closes them by hand or not at all — the braindump this module answers.

**The selected request is any conversation, named by channel and topic**
(`front_desk` p4). The Front Desk's `front-desk-<id>` was the first caller;
an ordinary `front-*` conversation, one run of a routine
(`front-routine-<name>-<stamp>`), an Autolab `workplan-` and a Forge
`assetplan-` are the others, and `classify()` says which one a root is. What
differs between them is only the **boundary**: which reached conversations
are *this* request's and which are somebody else's — see `Scope` and
`_ownership`. An execution topic (`workrun-`, `assetrun-`, anything that
carries a root note of its own) is never a root: selecting it names its
parent request instead, so a click there cannot close the parent and its
siblings by accident.

**Nothing here decides that the work is good.** The human's click is the
acceptance; this module only answers *what would be closed*, and it answers
it from the realm's own records rather than from prose:

- the two link notes (`agag.selfnote`), read exactly as the routines board
  reads them (`routines.children_of`): a `[served]` note written in a topic
  names a remote conversation its owner answered a callback from, and a
  `[rootchat]` note written in a remote names the conversation it was opened
  for. Each edge is blind where the other sees, so both are walked, in both
  directions, to a fixed point.
- **autolab's own record, which is the conversation** (`autolab.py`, and
  `refactor` p1 for why): a `workplan-` topic carrying a `[mission]` note
  *is* a mission, a `workrun-` topic carrying a `[task]` note is one of its
  tasks, and the note's own message id is the identity. A task is attributed
  to its mission by that **id**, never by the name its root note carries —
  which is what keeps a reused display name (`refactor` p2) from handing one
  request another's work.
- **forge's own record, which is also the conversation** (`forge.py`, and
  `refactor` p2 for why): an `assetplan-` topic carrying an `[asset]` note
  *is* a request, an `assetrun-` topic carrying an `[assetrun]` note is one
  of its runs, and the note's own message id is the identity. Nothing in
  this traversal reads Plane any more.

**The display graph is not this graph.** `routines.session_tree` caps depth
and node count because a board is not where a cycle should be discovered,
and it inspects only topics the sweep already holds — and the sweep never
reads a resolved topic, which is most of a finished session. Here the walk
is unbounded in depth (a node cap remains, and reaching it is *reported*),
and every node the notes name is read from Zulip when the engine does not
hold it, under both its names. What still could not be read is returned as a
**gap**, never as an absence of work.

**Ambiguity is returned, never resolved.** A topic anchored to a different
request is that request's work — p2 met a reused plan topic whose first
root note still named an older Front conversation — and it leaves this
module as an *exclusion with its evidence*, for the preview to show and the
human to see, rather than as something quietly closed or quietly dropped.
The same rule keeps another Front conversation, another run of a routine, a
routine's standing request and another agent's request outside the closure,
whatever link reached them from here.

Nothing here writes. Execution is `close.py`'s (p3 step 2).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Protocol

from agag.selfnote import Conversation, parse_note, parse_rootchat, parse_served
from agag.zulip import RESOLVED_TOPIC_PREFIX

from .autolab import (
    MISSION_REPLACED,
    Mission,
    Note,
    Task,
    mission_label,
    notes_in,
    read_record,
    work_channel_name,
)
from .forge import (
    REQUEST_RETIRED,
    Note as ForgeNote,
    Request as ForgeRequest,
    Run as ForgeRun,
    notes_in as forge_notes_in,
    read_record as forge_read_record,
)
from .frontdesk import DESK_PREFIX, FRONT_CHANNEL, desk_id
from .room import AGENTS_CHANNEL, INTRO_PREFIX, bare_topic
from .routines import (
    GUIDE_TOPIC, children_of, is_guide_topic, is_routine_channel, is_run_topic, routine_name,
)

#: One conversation, keyed the way the ops engine keys them: bare topic name.
Key = tuple[str, str]

#: Which agent's record a `WorkTarget` came out of. Both are conversations
#: now, and the source is what says whose lifecycle judges it.
AUTOLAB_SOURCE = "agautolab"
FORGE_SOURCE = "agforge"
#: autolab's channel names, as its listener builds them: `pj-<slug>` for a
#: project, `work-<label>` for one mission's dedicated channel.
PROJECT_CHANNEL_PREFIX = "pj-"
WORK_CHANNEL_PREFIX = "work-"
#: The topic a mission is planned in, inside its project channel. Its
#: `<channel>/<topic>` is the mission Work's `external_id`.
WORKPLAN_PREFIX = "workplan-"
#: autolab's execution topics, one per task, inside the mission's `work-`
#: channel; forge's plan and run topics, inside its own channel. Only the
#: prefixes each agent's own code writes (`agautolab.anchor`,
#: `agforge.anchor`) — a name is what says *what a topic is*, never whose.
WORKRUN_PREFIX = "workrun-"
ASSETPLAN_PREFIX = "assetplan-"
ASSETRUN_PREFIX = "assetrun-"
#: Front's own sweep prefix: every `front-*` topic in `#front` is a request
#: to Front, the Front Desk's and the routines' included.
FRONT_PREFIX = "front-"

#: What a conversation is, by name. The **request** kinds may be selected as
#: the root of a completion; the **execution** kinds are somebody's task
#: topics and name their parent instead; the two **retiring** kinds carry a
#: ✔ that means something else entirely and are never a target.
DESK, FRONT, ROUTINE_RUN, WORKPLAN, ASSETPLAN = (
    "desk", "front", "routine-run", "workplan", "assetplan")
WORKRUN, ASSETRUN = "workrun", "assetrun"
ROUTINE_GUIDE, INTRO = "routine-guide", "intro"
TOPIC = "topic"
REQUEST_KINDS = frozenset({DESK, FRONT, ROUTINE_RUN, WORKPLAN, ASSETPLAN})
EXECUTION_KINDS = frozenset({WORKRUN, ASSETRUN})
RETIRING_KINDS = frozenset({ROUTINE_GUIDE, INTRO})
#: How much of an unheld topic one read fetches. A `workrun-` topic is a
#: conversation, not a log; 400 is far past any this realm has produced, and
#: hitting it is reported as a gap rather than assumed to be the whole.
READ_DEPTH = 400
#: A cycle in the notes is possible (two agents anchoring each other) and the
#: walk dedupes, so this cap is a bound on a *runaway*, not on a session.
#: Reaching it is truncation and is reported.
MAX_NODES = 120
#: `[AUTO]`-made channels say so in their description. Read as corroboration
#: only: the plan's rule is that a channel is identified by its contents and
#: its mission binding, never by a description or a similar name.
AUTO_MARKER = "[AUTO]"

__all__ = [
    "AUTOLAB_SOURCE", "Discovery", "EXECUTION_KINDS", "FORGE_SOURCE", "MAX_NODES",
    "READ_DEPTH", "REQUEST_KINDS", "RETIRING_KINDS", "Related", "Scope", "WORK_CHANNEL_PREFIX",
    "WorkTarget", "classify", "describe_kind", "discover", "related_topics",
]


# --- what a conversation is ----------------------------------------------------


def classify(channel: str, topic: str) -> str:
    """The kind of one conversation, from its channel and bare name.

    Names decide *what* a topic is because the writers' own code makes them
    (`routines.run_topic`, `frontdesk.desk_topic`, the anchors); they never
    decide *whose* it is — that is the link notes' job (`_ownership`).
    """
    topic = bare_topic(topic)
    if channel == FRONT_CHANNEL:
        if topic.startswith(DESK_PREFIX):
            return DESK
        if topic.startswith(FRONT_PREFIX):
            return FRONT
        return TOPIC
    if is_routine_channel(channel):
        if is_run_topic(topic):
            return ROUTINE_RUN
        if is_guide_topic(topic):
            return ROUTINE_GUIDE
        return TOPIC
    if channel == AGENTS_CHANNEL and topic.startswith(INTRO_PREFIX):
        return INTRO
    if topic.startswith(WORKPLAN_PREFIX):
        return WORKPLAN
    if topic.startswith(WORKRUN_PREFIX):
        return WORKRUN
    if topic.startswith(ASSETPLAN_PREFIX):
        return ASSETPLAN
    if topic.startswith(ASSETRUN_PREFIX):
        return ASSETRUN
    return TOPIC


def describe_kind(kind: str, topic: str = "", channel: str = "") -> str:
    """One noun phrase per kind, for a reason a human reads."""
    if kind == ROUTINE_RUN or kind == ROUTINE_GUIDE:
        name = routine_name(channel) if channel else None
        name = name or "?"
        return (f"a run of routine {name}" if kind == ROUTINE_RUN
                else f"the guide of routine {name}")
    return {
        DESK: "a Front Desk conversation", FRONT: "a Front conversation",
        WORKPLAN: "an Autolab request", ASSETPLAN: "a Forge request",
        WORKRUN: "an Autolab task topic", ASSETRUN: "a Forge run topic",
        INTRO: "an agent's introduction",
    }.get(kind, "a conversation")


@dataclass
class Scope:
    """The boundary around the selected request, said out loud.

    `closable` is whether this root may be completed at all; when it is not,
    `reason` says why and `parents` names where to go instead. `context` is
    what the records *mention* without owning — a routine run's guide and
    channel — listed so the preview can say they are untouched rather than
    leaving the reader to wonder.
    """

    root: Key
    kind: str
    closable: bool
    reason: str
    description: str
    #: Request conversations this root was opened for, by its own root notes:
    #: `{channel, topic, kind, by, by_id, message_id}`. Navigation, and — for
    #: an execution topic — the only answer.
    parents: list[dict] = field(default_factory=list)
    #: `{channel, topic, relation, reason}` — mentioned, not owned.
    context: list[dict] = field(default_factory=list)
    routine: dict | None = None

    def as_dict(self) -> dict:
        return {
            "root": {"channel": self.root[0], "topic": self.root[1]},
            "kind": self.kind, "closable": self.closable, "reason": self.reason,
            "description": self.description, "parents": self.parents,
            "context": self.context, "routine": self.routine,
        }


# --- the `[work]` note ------------------------------------------------------


# The `[selfnote][work]` note is gone. It named a Plane issue, and neither
# agent keeps one: autolab stopped writing it in `refactor` p1 and forge in
# p2. Nothing here reads it, and no reader is kept for the old format — an
# abstraction preserved only for records nothing writes is the cost this
# whole phase is removing.


# --- one related conversation ----------------------------------------------


@dataclass
class Related:
    """One conversation the walk reached, and how."""

    channel: str
    topic: str
    live_topic: str
    resolved: bool
    #: `held` (the ops engine has its history), `read` (this walk fetched it),
    #: `note-only` (a note names it and nothing could read it).
    known: str
    depth: int
    #: Every edge that reached it: `{via, from, message_id, by}`.
    links: list[dict] = field(default_factory=list)
    #: `[rootchat]` notes written *in* it: the conversations it was opened
    #: for, with who said so. This is what makes a topic somebody else's.
    homes: list[dict] = field(default_factory=list)
    #: autolab's own notes written in this topic, and what they make it: a
    #: `Mission`, a `Task`, or None for a conversation that is neither. Since
    #: `refactor` p1 this is autolab's whole record — there is no Plane issue
    #: for a `[work]` note to name — so it is what says which mission a
    #: `workrun-` topic belongs to and how far the work has got.
    notes: list[Note] = field(default_factory=list)
    record: Any | None = None
    #: forge's own notes, and what they make this topic: a `Request`, a
    #: `Run`, or None. The same shape and the same reason, one phase later
    #: (`refactor` p2). Two readers rather than one because the two agents
    #: share three tag names (`doc`, `state`, `replaces`) and each identifies
    #: its own records by its own identity note.
    forge_notes: list[ForgeNote] = field(default_factory=list)
    forge_record: Any | None = None
    #: The read came back full: there may be older posts, and older notes.
    history_bounded: bool = False
    last_post_id: int = 0
    #: The realm no longer lists this topic's channel: archived, so its posts
    #: can still be read but never moved (a resolve is a PATCH the realm
    #: refuses with 400). Met live in p4 on a retired fixture agent's channel.
    channel_archived: bool = False
    #: The topic carries a ✔ **and** posts under its bare name — a twin Zulip
    #: opened when somebody posted after the resolve. It is open, and a ✔
    #: here folds the twin's posts into the resolved topic.
    twin: bool = False
    twin_posts: int = 0
    #: Root notes written *in* an execution topic by a visitor — Front,
    #: serving some other request, posting here — that name a conversation
    #: outside this request. Not ownership (`_ownership`), but shown: the
    #: reader should know another request was served from this topic.
    visitors: list[dict] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "channel": self.channel, "topic": self.topic, "live_topic": self.live_topic,
            "resolved": self.resolved, "known": self.known, "depth": self.depth,
            "links": self.links, "homes": self.homes, "visitors": self.visitors,
            "channel_archived": self.channel_archived,
            "twin": self.twin, "twin_posts": self.twin_posts,
            "record": self.record.as_dict() if self.record is not None else None,
            "forge_record": (self.forge_record.as_dict()
                             if self.forge_record is not None else None),
            "history_bounded": self.history_bounded,
            # The id a resolve renames from: Zulip resolves a topic by moving
            # its messages, so closing one needs a post of it to move.
            "last_post_id": self.last_post_id,
        }

    @property
    def key(self) -> Key:
        return (self.channel, self.topic)


# --- reading a topic the engine does not hold -------------------------------


class Realm(Protocol):  # pragma: no cover - structural typing only
    def topic_history(self, channel: str, topic: str, num_before: int = ...) -> list[dict]: ...
    def stream_id(self, name: str) -> int: ...
    def channel_topics(self, stream_id: int) -> list[str]: ...
    def channels(self) -> list[dict]: ...


@dataclass
class Reader:
    """Targeted Zulip reads, each made at most once per discovery.

    A resolved topic is renamed, not moved, so both names are asked for and
    the answers are merged: a topic resolved *during* the walk would
    otherwise read as empty, which is `topic_history_across_resolve`'s
    lesson one level up.
    """

    realm: Realm | None
    errors: list[dict] = field(default_factory=list)
    _histories: dict[Key, list[dict]] = field(default_factory=dict, repr=False)
    _live: dict[Key, str] = field(default_factory=dict, repr=False)
    #: Message ids read under the **bare** name of a topic whose ✔ name also
    #: answered: a post made after the resolve opened a twin (the
    #: `resolve_leaves_a_stray_twin` shape), and the twin is what is open.
    _twins: dict[Key, list[int]] = field(default_factory=dict, repr=False)
    _topics: dict[str, list[str] | None] = field(default_factory=dict, repr=False)
    _streams: dict[str, int | None] = field(default_factory=dict, repr=False)
    _channels: set[str] | None = field(default=None, repr=False)
    calls: int = 0

    def history(self, key: Key) -> tuple[list[dict], str | None] | None:
        """`(messages, live name)` for one topic, or None when unreadable."""
        if key in self._histories:
            return self._histories[key], self._live.get(key)
        if self.realm is None:
            return None
        channel, topic = key
        resolved_name = f"{RESOLVED_TOPIC_PREFIX}{topic}"
        merged: dict[int, dict] = {}
        live: str | None = None
        answered = 0
        by_name: dict[str, list[int]] = {}
        for name in (topic, resolved_name):
            try:
                self.calls += 1
                found = self.realm.topic_history(channel, name, num_before=READ_DEPTH)
            except Exception as error:  # noqa: BLE001 - a gap, never an empty topic
                self.errors.append({"channel": channel, "topic": name,
                                    "error": f"{type(error).__name__}: {error}"})
                continue
            answered += 1
            if found:
                live = name
            by_name[name] = [int(message.get("id") or 0) for message in found]
            for message in found:
                merged[int(message.get("id") or 0)] = message
        # Neither name could be asked: unknown, which is not the same answer
        # as an empty topic and must never be reported as one.
        if answered == 0:
            return None
        # Both names answered with posts: the topic was resolved and then
        # posted into under its bare name, which Zulip makes a second, open
        # topic. The bare one is what is open, and what a ✔ must fold.
        if by_name.get(topic) and by_name.get(resolved_name):
            live = topic
            self._twins[key] = sorted(by_name[topic])
        messages = [merged[ident] for ident in sorted(merged)]
        self._histories[key] = messages
        if live is not None:
            self._live[key] = live
        return messages, live

    def open_twin(self, key: Key) -> list[int]:
        """The ids posted under the bare name of a ✔ topic — its open twin —
        or nothing. Reads the topic if nothing has yet."""
        if key not in self._histories:
            self.history(key)
        return list(self._twins.get(key, []))

    def stream_id(self, channel: str) -> int | None:
        if channel not in self._streams:
            if self.realm is None:
                self._streams[channel] = None
            else:
                try:
                    self.calls += 1
                    self._streams[channel] = int(self.realm.stream_id(channel))
                except Exception as error:  # noqa: BLE001
                    self.errors.append({"channel": channel, "topic": None,
                                        "error": f"{type(error).__name__}: {error}"})
                    self._streams[channel] = None
        return self._streams[channel]

    def channel_exists(self, channel: str) -> bool | None:
        """Whether the realm still lists this channel, or None if it could
        not be asked.

        An **archived** channel leaves every listing, so its topics stop
        being readable — and "could not be read" and "already archived" are
        different answers, the second of which is this operation's own work
        seen a second time. Asked once per discovery, and only when a topic
        list has already failed.
        """
        if self._channels is None:
            if self.realm is None:
                return None
            try:
                self.calls += 1
                self._channels = {str(row.get("name")) for row in self.realm.channels()}
            except Exception as error:  # noqa: BLE001
                self.errors.append({"channel": channel, "topic": None,
                                    "error": f"{type(error).__name__}: {error}"})
                return None
        return channel in self._channels

    def forget_errors(self, channel: str) -> None:
        """Drop the recorded failures of one channel's own lookups.

        Only for the case where a later, better answer explains them — an
        archived channel's unlistable topics. Nothing else in this module
        removes a gap once it is recorded.
        """
        self.errors = [error for error in self.errors
                       if not (error["channel"] == channel and error["topic"] is None)]

    def channel_topics(self, channel: str) -> list[str] | None:
        """Every topic name in a channel, or None when it could not be asked.

        This is what makes a `work-` channel's *contents* knowable: a note
        names the topics an agent worked in, and only the channel itself
        knows whether anything else is in there.
        """
        if channel in self._topics:
            return self._topics[channel]
        stream = self.stream_id(channel)
        if stream is None or self.realm is None:
            self._topics[channel] = None
            return None
        try:
            self.calls += 1
            self._topics[channel] = [str(name) for name in self.realm.channel_topics(stream)]
        except Exception as error:  # noqa: BLE001
            self.errors.append({"channel": channel, "topic": None,
                                "error": f"{type(error).__name__}: {error}"})
            self._topics[channel] = None
        return self._topics[channel]


class _ReadTopic:
    """A `Topic`-shaped view of a fetched history, so `children_of` can walk
    a topic the ops engine never swept without knowing the difference."""

    #: `children_of` and the walk both ask a topic whether it carries a
    #: history; a read one always does, whatever the sweep decided.
    keep_history = True

    def __init__(self, channel: str, topic: str, messages: list[dict]):
        self.channel, self.topic = channel, topic
        self.history = messages
        self.messages = messages
        self.roots: list[tuple[Conversation, int, str, int]] = []
        self.served: dict[Key, dict] = {}
        for message in messages:
            content = str(message.get("content") or "")
            note_id = int(message.get("id") or 0)
            home = parse_rootchat(content)
            sender_id = int(message.get("sender_id") or 0)
            sender = str(message.get("sender_full_name") or "")
            if home is not None:
                home = Conversation(home.channel, bare_topic(home.topic))
                if not any(root == home and by == sender_id for root, by, _, _ in self.roots):
                    self.roots.append((home, sender_id, sender, note_id))
            parsed = parse_served(content)
            if parsed is not None:
                remote, remote_id = parsed
                key = (remote.channel, bare_topic(remote.topic))
                found = self.served.get(key)
                if found is None:
                    self.served[key] = {"remote_id": remote_id, "first_note": note_id,
                                        "last_note": note_id}
                else:
                    found["remote_id"] = max(found["remote_id"], remote_id)
                    found["first_note"] = min(found["first_note"], note_id)
                    found["last_note"] = max(found["last_note"], note_id)
        self.roots.sort(key=lambda root: root[3])


# --- the walk ---------------------------------------------------------------


def _homes_of(node: Any) -> list[dict]:
    return [{"channel": home.channel, "topic": bare_topic(home.topic),
             "by": sender, "by_id": by, "message_id": note_id}
            for home, by, sender, note_id in (getattr(node, "roots", None) or [])]


#: The identity suffix a writer appends to a name it minted from an anchor
#: id: `assetrun-red-apple-a5912`, `workrun-task1-m5512`. Dropped when
#: pairing siblings, because the two halves of one request wear the same
#: stem and only one of them wears the id.
ANCHOR_SUFFIX = re.compile(r"-[am]\d+$")


def _stem(topic: str) -> str:
    """A topic name without its writer's prefix or its anchor suffix:
    `assetrun-red-apple-a5912` and `assetplan-red-apple` share `red-apple`,
    which is how their author pairs them. Never evidence on its own — only a
    reason to read."""
    _, separator, rest = topic.partition("-")
    stem = rest if separator and rest else topic
    return ANCHOR_SUFFIX.sub("", stem) or stem


def related_topics(
    topics: dict, root: Key, *, reader: Reader | None = None, max_nodes: int = MAX_NODES,
    seed_channels: Iterable[str] = (),
) -> tuple[dict[Key, Related], dict]:
    """Every conversation related to `root`, and what could not be reached.

    Breadth-first over both link edges, to a **fixed point**: a topic read
    late carries notes that name a topic expanded early, so the sweep is
    repeated until no node is added. The realm is read only for topics the
    engine does not hold with a history — which, resolved topics never being
    swept, is most of a finished session.

    `seed_channels` are channels whose every topic is *read* as a candidate
    — a mission's dedicated `work-` channel, named by the mission rather
    than by any note. Reading is all it buys: a candidate joins the graph on
    its own root note naming something already reached, exactly like every
    other node, or not at all.
    """
    reader = reader if reader is not None else Reader(realm=None)
    working: dict[Key, Any] = dict(topics)
    found: dict[Key, Related] = {}
    truncated = False

    def ensure(key: Key) -> Any:
        """The richest view of one topic: held with a history, else read."""
        held = working.get(key)
        if held is not None and getattr(held, "keep_history", False) and getattr(held, "history", None):
            return held
        read = reader.history(key)
        if read is None:
            return held
        messages, live = read
        node = _ReadTopic(key[0], key[1], messages)
        node.live = live  # type: ignore[attr-defined]
        node.messages = messages  # type: ignore[attr-defined]
        working[key] = node
        return node

    def register(key: Key, depth: int, link: dict | None) -> Related:
        existing = found.get(key)
        if existing is None:
            node = ensure(key)
            held = topics.get(key)
            messages = list(getattr(node, "messages", None) or [])
            if not messages and held is not None:
                messages = [{"id": m.id, "sender_id": m.sender_id,
                             "sender_full_name": m.sender, "content": m.content}
                            for m in getattr(held, "history", None) or []]
            live = (getattr(held, "live_topic", None) if held is not None
                    else getattr(node, "live", None)) or key[1]
            known = ("read" if isinstance(node, _ReadTopic)
                     else "held" if held is not None and getattr(held, "history", None)
                     else "note-only")
            # autolab's notes, from two places: a read gives the raw
            # messages, a held topic gives the binding the engine retained,
            # because its `history` has the selfnotes filtered out of it.
            notes = notes_in(messages)
            if not notes and held is not None:
                notes = [Note.of(entry) for entry in (getattr(held, "autolab", None) or [])]
            # forge's, from the same two places and for the same reason.
            forge_notes = forge_notes_in(messages)
            if not forge_notes and held is not None:
                forge_notes = [ForgeNote.of(entry)
                               for entry in (getattr(held, "forge", None) or [])]
            # A ✔ topic may have an open twin under its bare name (a post
            # made after the resolve). The engine keys both as one and shows
            # whichever name it saw last, so a resolved node is read once
            # more to ask; the answer is cached with the history.
            if isinstance(node, _ReadTopic):
                twin_ids = reader.open_twin(key)  # cached with the read
            elif live.startswith(RESOLVED_TOPIC_PREFIX):
                # A held ✔ topic is read again only when the channel's own
                # topic list carries both names — one cached call per
                # channel, and no history read for the common case.
                names = set(reader.channel_topics(key[0]) or [])
                twin_ids = reader.open_twin(key) if key[1] in names and live in names else []
            else:
                twin_ids = []
            if twin_ids:
                live = key[1]
            existing = Related(
                channel=key[0], topic=key[1], live_topic=live,
                resolved=live.startswith(RESOLVED_TOPIC_PREFIX),
                known=known, depth=depth,
                homes=_homes_of(node) if node is not None else [],
                notes=notes,
                record=read_record(key[0], key[1], notes),
                forge_notes=forge_notes,
                forge_record=forge_read_record(key[0], key[1], forge_notes),
                history_bounded=len(messages) >= READ_DEPTH,
                last_post_id=(max(twin_ids) if twin_ids else
                              max((int(m.get("id") or 0) for m in messages), default=0)),
                twin=bool(twin_ids), twin_posts=len(twin_ids),
            )
            found[key] = existing
        else:
            existing.depth = min(existing.depth, depth)
        if link is not None and link not in existing.links:
            existing.links.append(link)
        return existing

    def sweep() -> bool:
        """One breadth-first pass; True when it added a node."""
        added = False
        frontier = [(root, 0)]
        seen = {root}
        nonlocal truncated
        while frontier:
            key, depth = frontier.pop(0)
            ensure(key)
            for child in children_of(working, key):
                child_key = (child["channel"], bare_topic(child["topic"]))
                if child_key == key:
                    continue
                link = {"via": child["via"], "from": {"channel": key[0], "topic": key[1]},
                        "message_id": child["link_id"], "by": child.get("by")}
                if child_key not in found and len(found) >= max_nodes:
                    truncated = True
                    continue
                before = child_key in found
                node = register(child_key, depth + 1, link)
                if not before:
                    added = True
                if child_key not in seen:
                    seen.add(child_key)
                    frontier.append((child_key, node.depth))
        return added

    register(root, 0, None)
    while sweep():
        pass
    # **Upward, once.** A reached topic's root note names the conversation
    # it was opened for; when nothing here has read that conversation, its
    # own notes are unknown — and it may well name *this* root (a plan Front
    # served a task of, but never the plan). Read every such home; a home
    # joins the graph only if a sweep then links it from something reached,
    # otherwise it stays outside and ownership names it as somebody else's.
    asked: set[Key] = set()

    def read_homes() -> bool:
        added = False
        for node in list(found.values()):
            for home in node.homes:
                key = (home["channel"], home["topic"])
                if key == root or key in found or key in asked:
                    continue
                asked.add(key)
                if ensure(key) is not None:
                    added = True
        return added

    while read_homes():
        while sweep():
            pass
    # **A mission's own channel, read whole.** autolab's `workplan-` topic
    # carries no note naming its `workrun-` topics — each task topic names
    # the plan, not the other way round — so from a plan (or from anything
    # that reached the plan only by a note) the tasks are invisible until
    # something reads them. The mission names the channel; its topics are
    # read here and admitted by their own root notes, or not at all.
    seeded = False
    for channel in seed_channels:
        names = reader.channel_topics(channel)
        for name in names or []:
            key = (channel, bare_topic(name))
            if key not in found and ensure(key) is not None:
                seeded = True
    if seeded:
        while sweep():
            pass
    # **The blind spot of both notes, closed with the realm's own topic list.**
    # A topic an agent opened *for its own* conversation carries a root note
    # naming that conversation — and nothing anywhere names the new topic, so
    # the walk cannot find it: forge's `assetrun-<stem>` beside its
    # `assetplan-<stem>` is the standing example. The stem is how the writers
    # themselves pair the two (`agforge.anchor.assetrun_topic_name`), so it
    # is used to decide *what to read* — and only that. A sibling joins the
    # graph on its own link notes, exactly like every other node, or not at
    # all.
    if reader.realm is not None:
        for _ in range(2):
            candidates: list[Key] = []
            for channel in sorted({key[0] for key in found}):
                names = reader.channel_topics(channel)
                if names is None:
                    continue
                stems = {_stem(key[1]) for key in found if key[0] == channel}
                for name in names:
                    bare = bare_topic(name)
                    if (channel, bare) not in found and _stem(bare) in stems:
                        candidates.append((channel, bare))
            if not candidates:
                break
            for key in candidates:
                ensure(key)
            if not sweep():
                break
    gaps = {
        "truncated": truncated, "max_nodes": max_nodes,
        "unread": sorted(f"{node.channel}/{node.topic}" for node in found.values()
                         if node.known == "note-only"),
        "bounded": sorted(f"{node.channel}/{node.topic}" for node in found.values()
                          if node.history_bounded),
        "errors": _unique(reader.errors),
        "zulip_calls": reader.calls,
    }
    return found, gaps


@dataclass
class WorkTarget:
    """One work record this request is responsible for.

    One storage now — **the conversations** — and two agents keeping records
    in it. autolab's mission is a `workplan-` topic whose identity is the
    message id of its own `[selfnote][mission]` note, with its tasks in
    `workrun-` topics that name it (`refactor` p1); forge's request is an
    `assetplan-` topic anchored by an `[asset]` note, with its runs in
    `assetrun-` topics that name it (p2).

    `source` is the only thing a caller branches on, and it selects a
    *lifecycle*, not a storage: a mission is finished when every one of its
    tasks is, a request when something has been delivered. `key` is what
    both are addressed by, so a preview and the operation that follows it
    agree on which row is which.

    `refactor` p3 removed the last Plane coordinates. They had been kept as
    empty strings so a consumer reading `issue_id` got an honest "there is
    none"; with Plane gone there is nobody left to be honest *to*, and a
    field nothing can ever fill is a shape that invites a reader to look for
    the system behind it.
    """

    #: Which agent's record this is: `AUTOLAB_SOURCE` or `FORGE_SOURCE`.
    source: str | None
    label: str
    title: str
    #: Where the work has got to, in its own agent's vocabulary.
    state: str
    #: autolab: `mission` or `task`. forge: `request` or `run`.
    role: str
    #: The conversation's coordinates.
    channel: str = ""
    topic: str = ""
    #: The message id that *is* this record, for a chat-kept one.
    anchor_id: int = 0
    #: How it was found — a `[work]` note and who wrote it, or the mission
    #: note in the topic itself.
    evidence: list[dict] = field(default_factory=list)
    parent_id: str | None = None
    children: list[dict] = field(default_factory=list)
    #: Durable object keys this record has delivered (forge only). What an
    #: acceptance is *of*, and the reference that outlives every presigned
    #: URL the delivery carried.
    results: list[str] = field(default_factory=list)

    @property
    def key(self) -> str:
        """What an action is addressed by, stable across previews."""
        return f"work:{self.label}"

    def as_dict(self) -> dict:
        return {"source": self.source, "label": self.label, "title": self.title,
                "state": self.state, "role": self.role,
                "channel": self.channel, "topic": self.topic,
                "anchor_id": self.anchor_id, "evidence": self.evidence,
                "parent_id": self.parent_id, "children": self.children,
                "results": self.results}


# --- the whole answer -------------------------------------------------------


@dataclass
class Discovery:
    """What closing this request would touch, and what it would not."""

    scope: Scope
    topics: list[Related]
    excluded: list[dict]
    works: list[WorkTarget]
    channels: list[dict]
    gaps: dict

    @property
    def root(self) -> Key:
        return self.scope.root

    def as_dict(self) -> dict:
        return {
            "scope": self.scope.as_dict(),
            "root": {"channel": self.root[0], "topic": self.root[1]},
            "topics": [node.as_dict() for node in self.topics],
            "excluded": self.excluded,
            "works": [work.as_dict() for work in self.works],
            "channels": self.channels,
            "gaps": self.gaps,
        }


def _exclude(node: Related, reason: str, evidence: list[dict] | None = None) -> dict:
    return {"channel": node.channel, "topic": node.topic, "live_topic": node.live_topic,
            "resolved": node.resolved, "reason": reason, "evidence": evidence or [],
            "known": node.known, "kind": classify(node.channel, node.topic)}


def _root_messages(topics: dict, root: Key, reader: Reader) -> list[dict]:
    """The root's own posts, from the engine when it holds them and from
    the reader's cache otherwise (never a second call)."""
    held = topics.get(root)
    if held is not None and getattr(held, "history", None):
        return [{"id": m.id, "sender_id": m.sender_id, "sender_full_name": m.sender,
                 "content": m.content} for m in held.history]
    read = reader.history(root)
    return read[0] if read is not None else []


def _scope(topics: dict, root: Key, node: Related, reader: Reader) -> Scope:
    """The boundary the selected root draws, from its kind and its own notes."""
    kind = classify(*root)
    structural_kind = STRUCTURAL_HOME.get(kind)
    parents = [{**home, "kind": classify(home["channel"], home["topic"]),
                "structural": structural_kind is None
                or classify(home["channel"], home["topic"]) == structural_kind}
               for home in node.homes if (home["channel"], home["topic"]) != root]
    parents.sort(key=lambda p: (not p["structural"], p["message_id"]))
    label = f"#{root[0]} › {root[1]}"
    if kind in RETIRING_KINDS:
        what = ("a ✔ on a guide retires the routine; complete one of its runs instead"
                if kind == ROUTINE_GUIDE else
                "a ✔ on an introduction retires the agent; this is not a request")
        return Scope(root, kind, False, what, f"{label} is {describe_kind(kind, root[1], root[0])}",
                     parents=parents)
    if kind in EXECUTION_KINDS or (kind not in REQUEST_KINDS and parents):
        structural = [p for p in parents if p["structural"]] or parents
        named = ", ".join(f"#{p['channel']} › {p['topic']}" for p in structural)
        served = ", ".join(f"#{p['channel']} › {p['topic']}" for p in parents if p not in structural)
        return Scope(
            root, kind, False,
            (f"this is {describe_kind(kind, root[1], root[0])} of {named}; select that request "
             "to complete it and its work together"
             + (f" (it was also served on behalf of {served})" if served else "") if parents else
             f"this is {describe_kind(kind, root[1], root[0])} and its records name no parent request; "
             "nothing here says what it belongs to"),
            f"{label} is an execution topic, not a request", parents=parents)
    context: list[dict] = []
    routine: dict | None = None
    if kind == ROUTINE_RUN:
        name = routine_name(root[0]) or "?"
        context.append({"channel": root[0], "topic": GUIDE_TOPIC, "relation": "guide",
                        "reason": "the routine's guide and its channel stay as they are; "
                                  "a ✔ on the guide would retire the routine"})
        routine = {"name": name, "channel": root[0], "run_topic": root[1], "guide_topic": GUIDE_TOPIC}
        description = (f"run {root[1]} of routine {name} and the work it opened; "
                       f"the guide, the channel and the routine's other runs are not touched")
    elif kind == DESK:
        description = f"Front Desk conversation {desk_id(root[1])} and the work it opened"
    elif kind == FRONT:
        description = f"{label}, a whole Front conversation, and the work it opened"
    elif kind == WORKPLAN:
        record = node.record if isinstance(node.record, Mission) else None
        named = f" (mission {record.label})" if record is not None else ""
        description = (f"{label}, an Autolab request{named}, its tasks and its work channel")
        if record is not None and record.replaces:
            # The retired predecessor is a request of its own. Say so here,
            # because the reader is looking at a topic that used to be it.
            older = mission_label(record.replaces)
            description += (f"; it replaced mission {older}, which is retired and is not "
                            "touched by finishing this one")
    elif kind == ASSETPLAN:
        description = f"{label}, a Forge request and its runs"
    else:
        description = f"{label} and the work its records link to it"
    if parents:
        description += ("; it was opened for " +
                        ", ".join(f"#{p['channel']} › {p['topic']}" for p in parents) +
                        ", which stays open")
    return Scope(root, kind, True, "", description, parents=parents, context=context,
                 routine=routine)


#: The home an execution topic *belongs* to, by kind: autolab anchors a
#: `workrun-` to its `workplan-`, forge an `assetrun-` to its `assetplan-`.
#: Any other root note in such a topic is a visitor's — Front, posting there
#: on behalf of whatever it was serving — and says who was served from it,
#: not whose it is. The live realm has both in one topic: a task re-run for a
#: later routine run carries autolab's note naming the plan and Front's note
#: naming the later run (`front_desk` p4 step 1).
STRUCTURAL_HOME = {WORKRUN: WORKPLAN, ASSETRUN: ASSETPLAN}


def _ownership(
    root: Key, found: dict[Key, Related], lineage: Iterable[Key] = (),
) -> tuple[list[Related], list[dict]]:
    """Which reached conversations are this request's, and why the rest are not.

    A **root note** is a topic saying which conversation it was opened for,
    and it decides: a topic whose every home is this request or something
    this request owns is owned, and one naming anything else is somebody
    else's — with that note's message id as the evidence (p2's reused plan
    topic, met head-on). For an execution topic only its *structural* home
    counts (`STRUCTURAL_HOME`); a visitor's note naming another request is
    kept on the node as `visitors`, shown and not obeyed. A topic with no
    root note is owned only when a link from something owned reached it —
    unless it is itself a *request* (another Front conversation, another
    run, an agent's own plan topic), which no served note can claim. The two
    retiring kinds are never owned. `lineage` is what the root itself was
    opened for: a note naming it is not a note naming a stranger. Decided to
    a fixed point, so the order the walk found things in does not matter.
    """
    order = sorted(found.items(), key=lambda item: (item[1].depth, item[0]))
    owned: set[Key] = {root}
    known: set[Key] = set(lineage)
    excluded: dict[Key, dict] = {}
    pending = [key for key, _ in order if key != root]
    # Where each mission the walk reached actually lives, keyed by the anchor
    # id that *is* the mission. This is what lets a task be attributed by id
    # rather than by the name its root note happens to carry — and the two
    # differ exactly when a display name has been reused, which since
    # `refactor` p2 is a thing the system does on purpose.
    missions = {node.record.anchor_id: key for key, node in found.items()
                if isinstance(node.record, Mission)}

    def settle(key: Key, node: Related) -> str | None:
        kind = classify(node.channel, node.topic)
        record = node.record
        if isinstance(record, Mission) and key != root and record.state == MISSION_REPLACED:
            # A retired mission is a *different request*, whatever note
            # reached it: its replacement is the work, and closing one must
            # never close the other.
            excluded[key] = _exclude(
                node, f"mission {record.label} was replaced; its replacement is the request "
                      "to complete, and this conversation is its retired record", node.links)
            return "excluded"
        if isinstance(record, Task):
            home = missions.get(record.mission_id)
            if home is not None and home != key:
                # The id decides, in both directions.
                if home == root or home in owned:
                    owned.add(key)
                    return "owned"
                if home in excluded:
                    excluded[key] = _exclude(
                        node, f"its task note names mission {mission_label(record.mission_id)}, "
                              "which this request does not own",
                        [{"how": "task note", "mission": record.mission_id,
                          "message_id": record.anchor_id}])
                    return "excluded"
            elif home is None:
                # The mission itself was not reached. If the conversation this
                # task names as its home *has* been reached and is a different
                # mission, the name was reused and the note is stale: this task
                # belongs to work nobody here is looking at.
                for entry in node.homes:
                    other = found.get((entry["channel"], entry["topic"]))
                    if (other is not None and isinstance(other.record, Mission)
                            and other.record.anchor_id != record.mission_id):
                        excluded[key] = _exclude(
                            node,
                            f"its task note names mission {mission_label(record.mission_id)}, but "
                            f"{entry['channel']}/{entry['topic']} is now mission "
                            f"{other.record.label}: the name was reused and this is the older work",
                            [{"how": "task note", "mission": record.mission_id,
                              "message_id": record.anchor_id}, entry])
                        return "excluded"
        if kind in RETIRING_KINDS:
            excluded[key] = _exclude(
                node, f"{describe_kind(kind, node.topic, node.channel)}: a ✔ there means something else",
                node.links)
            return "excluded"
        if node.homes:
            structural_kind = STRUCTURAL_HOME.get(kind)
            deciding = [home for home in node.homes
                        if structural_kind is None
                        or classify(home["channel"], home["topic"]) == structural_kind]
            if not deciding:
                deciding = list(node.homes)
            homes = [(h["channel"], h["topic"]) for h in deciding]
            foreign = [h for h, home in zip(homes, deciding)
                       if h != root and h not in owned and h not in found and h not in known]
            if foreign:
                names = sorted({f"{h[0]}/{h[1]}" for h in foreign})
                excluded[key] = _exclude(
                    node, f"anchored to another request ({', '.join(names)})",
                    [home for h, home in zip(homes, deciding) if h in foreign])
                return "excluded"
            through = sorted({h[1] for h in homes if h in excluded})
            if through:
                excluded[key] = _exclude(
                    node, "reached only through a conversation this one does not own "
                          f"({', '.join(through)})", node.links)
                return "excluded"
            if all(h == root or h in owned or h in known for h in homes):
                owned.add(key)
                return "owned"
            return None
        if kind in REQUEST_KINDS:
            excluded[key] = _exclude(node, f"another request: {describe_kind(kind, node.topic, node.channel)}",
                                     node.links)
            return "excluded"
        froms = [(l["from"]["channel"], l["from"]["topic"]) for l in node.links]
        if any(f in owned for f in froms):
            owned.add(key)
            return "owned"
        if froms and all(f in excluded for f in froms):
            excluded[key] = _exclude(
                node, "reached only through a conversation this one does not own "
                      f"({', '.join(sorted({f[1] for f in froms}))})", node.links)
            return "excluded"
        return None

    progress = True
    while pending and progress:
        progress = False
        still: list[Key] = []
        for key in pending:
            if settle(key, found[key]) is None:
                still.append(key)
            else:
                progress = True
        pending = still
    for key in pending:
        node = found[key]
        through = sorted({l["from"]["topic"] for l in node.links})
        excluded[key] = _exclude(
            node, "reached only through a conversation this one does not own "
                  f"({', '.join(through)})" if through else
                  "nothing links this request to it", node.links)
    kept = [node for key, node in order if key in owned]
    for node in kept:
        structural_kind = STRUCTURAL_HOME.get(classify(node.channel, node.topic))
        node.visitors = [
            home for home in node.homes
            if structural_kind is not None
            and classify(home["channel"], home["topic"]) != structural_kind
            and (home["channel"], home["topic"]) not in owned | known]
    return kept, sorted(excluded.values(), key=lambda row: (row["channel"], row["topic"]))


def discover(
    topics: dict,
    root: Key,
    *,
    realm: Realm | None = None,
    max_nodes: int = MAX_NODES,
) -> Discovery:
    """Everything closing the request at `root` would touch.

    Read-only, and every answer carries the record it came from. Four
    questions, in the order the evidence allows:

    1. **what the root is** — `classify` and its own root notes (`Scope`).
       An execution topic answers with its parent and nothing else;
    2. **which conversations** — the link-note walk, to a fixed point, and
       then `_ownership` over what it reached;
    3. **which work records** — autolab's missions and their tasks, forge's
       requests and their runs, all out of the topics already read;
    4. **which channels** — a `work-` channel whose *whole* topic list is
       accounted for by this request's targets. A channel with anything
       else in it is reported and kept.
    """
    root = (root[0], bare_topic(root[1]))
    reader = Reader(realm=realm)
    found, gaps = related_topics(topics, root, reader=reader, max_nodes=max_nodes)
    scope = _scope(topics, root, found[root], reader)
    if not scope.closable:
        # Nothing reached from here is a target: the walk was paid for the
        # root's own notes, and what it found beyond them is the parent's to
        # close. Said as exclusions so a preview can still show the shape.
        excluded = [_exclude(node, "belongs to the parent request", node.links)
                    for key, node in sorted(found.items(), key=lambda i: (i[1].depth, i[0]))
                    if key != root]
        gaps = {**gaps, "zulip_calls": reader.calls, "errors": _unique(reader.errors)}
        return Discovery(scope=scope, topics=[found[root]], excluded=excluded, works=[],
                         channels=[], gaps=gaps)
    lineage = [(p["channel"], p["topic"]) for p in scope.parents]
    kept, excluded = _ownership(root, found, lineage)
    _mark_archived(kept, root, reader)
    works, channels = _works(kept, reader)
    # A mission this request owns names its dedicated channel — `work-m<id>`,
    # from the anchor id that *is* the mission — and the channel may hold
    # task topics no note from here reached. Read them and walk once more;
    # every read is cached, so what was already known costs nothing, and
    # ownership is decided again over the larger graph.
    seeds = []
    for work in works:
        if work.role != "mission" or work.source != AUTOLAB_SOURCE:
            continue
        channel = work_channel_name(work.anchor_id)
        names = reader.channel_topics(channel) or []
        if any((channel, bare_topic(name)) not in found for name in names):
            seeds.append(channel)
    if seeds:
        found, gaps = related_topics(topics, root, reader=reader, max_nodes=max_nodes,
                                     seed_channels=sorted(set(seeds)))
        kept, excluded = _ownership(root, found, lineage)
        _mark_archived(kept, root, reader)
        works, channels = _works(kept, reader)
    gaps = {**gaps, "zulip_calls": reader.calls, "errors": _unique(reader.errors)}
    return Discovery(scope=scope, topics=kept, excluded=excluded, works=works,
                     channels=channels, gaps=gaps)


def _mark_archived(kept: list[Related], root: Key, reader: Reader) -> None:
    """Say which related topics sit in a channel the realm no longer lists.

    Their history reads fine, so the walk finds them like any other topic —
    and a resolve there is refused (HTTP 400 on the move), which p4 met live
    on a retired agent's channel. One channel-list call, only when an
    unresolved related topic exists to ask it for.
    """
    channels = {node.channel for node in kept if node.key != root and not node.resolved}
    for channel in sorted(channels):
        if reader.channel_exists(channel) is False:
            for node in kept:
                if node.channel == channel and node.key != root:
                    node.channel_archived = True


def _unique(rows: list[dict]) -> list[dict]:
    """The same failure met twice is one gap."""
    seen: list[dict] = []
    for row in rows:
        if row not in seen:
            seen.append(row)
    return seen


def _works(
    kept: list[Related], reader: Reader,
) -> tuple[list[WorkTarget], list[dict]]:
    """Every work record these topics account for, and the channels they fill.

    Two agents, two readers, one place: **the conversations**. autolab's
    `workplan-` topic carrying a `[mission]` note *is* a mission and its
    `workrun-` topics are its tasks; forge's `assetplan-` topic carrying an
    `[asset]` note *is* a request and its `assetrun-` topics are its runs.
    Nothing is looked up anywhere else, because since `refactor` p2 there is
    nowhere else to look — which is the whole of these two phases seen from
    this side.

    They are read separately because their lifecycles differ, not because
    their storage does: a mission is finished when every task is, a request
    when something has been delivered.
    """
    missions, mission_targets = _autolab_works(kept)
    requests = _forge_works(kept)
    labels = {target.label.lower(): True for target in missions}
    return [*missions, *requests], _channels(kept, reader, labels)


def _autolab_works(kept: list[Related]) -> tuple[list[WorkTarget], list[WorkTarget]]:
    """autolab's missions and tasks, read out of the conversations.

    A task is attributed to a mission by the **anchor id** its note names,
    never by the channel it is in or the name it wears: that is what makes a
    reused topic name harmless and a replaced mission's leftovers visible as
    somebody else's rather than silently counted here.

    A mission's `children` are its tasks with `reached` on each, because the
    completion rule is about all of them and one this walk never saw must
    block rather than be assumed done. A task whose mission is not among the
    kept topics is returned as a target of its own, so it is still shown —
    a request that reached a task without reaching its plan is a real shape
    and saying nothing about it would be worse than saying it is orphaned.
    """
    records = [node.record for node in kept if node.record is not None]
    missions = {record.anchor_id: record for record in records if isinstance(record, Mission)}
    tasks = [record for record in records if isinstance(record, Task)]
    for record in tasks:
        parent = missions.get(record.mission_id)
        if parent is not None:
            parent.tasks.append(record)
    mission_targets = []
    for record in sorted(missions.values(), key=lambda one: one.anchor_id):
        target = WorkTarget(
            source=AUTOLAB_SOURCE, label=record.label, title="", state=record.state,
            role="mission", channel=record.channel, topic=record.topic,
            anchor_id=record.anchor_id,
            evidence=[{"how": "mission note", "channel": record.channel,
                       "topic": record.topic, "message_id": record.anchor_id,
                       "by": record.by}],
            children=[
                {"anchor_id": task.anchor_id, "label": task.label,
                 "title": "", "state": task.state, "serial": task.serial,
                 "channel": task.channel, "topic": task.topic, "reached": True}
                for task in sorted(record.tasks, key=lambda one: (one.serial, one.anchor_id))
            ],
        )
        mission_targets.append(target)
    orphans = [
        WorkTarget(
            source=AUTOLAB_SOURCE, label=record.label, title="", state=record.state,
            role="task", channel=record.channel, topic=record.topic,
            anchor_id=record.anchor_id, parent_id=mission_label(record.mission_id),
            evidence=[{"how": "task note", "channel": record.channel,
                       "topic": record.topic, "message_id": record.anchor_id,
                       "by": record.by}],
        )
        for record in sorted(tasks, key=lambda one: one.anchor_id)
        if record.mission_id not in missions
    ]
    return [*mission_targets, *orphans], mission_targets


def _forge_works(kept: list[Related]) -> list[WorkTarget]:
    """forge's requests and their runs, read out of the conversations.

    A run belongs to a request by the **anchor id** its `[assetrun]` note
    names, never by the topic name it wears — which is what keeps a stem the
    requester reused from handing one request another's runs, and a retired
    request's leftovers visible as somebody else's.

    A request's `runs` are its children for the *hold* rule
    (`close._hold_dependents`), not for a counting rule: forge has none. A
    run this walk never reached is not a gap either, because no run of a
    request has to have finished for the request to be finished — only
    something has to have been delivered.

    A run whose request is not among the kept topics is returned as a target
    of its own, so it is still shown: a request that reached a run without
    reaching its plan is a real shape, and saying nothing about it would be
    worse than saying it is orphaned.
    """
    records = [node.forge_record for node in kept if node.forge_record is not None]
    requests = {record.anchor_id: record for record in records
                if isinstance(record, ForgeRequest)}
    runs = [record for record in records if isinstance(record, ForgeRun)]
    for record in runs:
        parent = requests.get(record.request_id)
        if parent is not None:
            parent.runs.append(record)
    targets = []
    for record in sorted(requests.values(), key=lambda one: one.anchor_id):
        targets.append(WorkTarget(
            source=FORGE_SOURCE, label=record.label, title=record.stem, state=record.state,
            role="request", channel=record.channel, topic=record.topic,
            anchor_id=record.anchor_id, results=list(record.results),
            evidence=[{"how": "asset note", "channel": record.channel,
                       "topic": record.topic, "message_id": record.anchor_id,
                       "by": record.by}],
            children=[
                {"anchor_id": run.anchor_id, "label": run.label,
                 "title": "", "state": run.state, "serial": 0,
                 "channel": run.channel, "topic": run.topic, "reached": True,
                 "results": run.results}
                for run in sorted(record.runs, key=lambda one: one.anchor_id)
            ],
        ))
    targets.extend(
        WorkTarget(
            source=FORGE_SOURCE, label=record.label, title="", state=record.state,
            role="run", channel=record.channel, topic=record.topic,
            anchor_id=record.anchor_id, parent_id=f"a{record.request_id}",
            evidence=[{"how": "assetrun note", "channel": record.channel,
                       "topic": record.topic, "message_id": record.anchor_id,
                       "by": record.by}],
        )
        for record in sorted(runs, key=lambda one: one.anchor_id)
        if record.request_id not in requests
    )
    return targets


def _channels(kept: list[Related], reader: Reader, mission_labels: dict) -> list[dict]:
    """The `work-` channels these topics live in, and whether each is done.

    A channel is archivable when *everything in it* is a topic this
    conversation accounts for — read from the channel itself, never from its
    name or its description. A `work-` channel bound to a mission Work this
    conversation owns and holding one topic nobody here reached is reported
    with that topic named, which is the difference between "finished" and
    "not looked at".
    """
    rows: list[dict] = []
    ours = {(node.channel, node.topic) for node in kept}
    for channel in sorted({node.channel for node in kept if node.channel.startswith(WORK_CHANNEL_PREFIX)}):
        label = channel[len(WORK_CHANNEL_PREFIX):]
        names = reader.channel_topics(channel)
        bound = label in mission_labels
        row = {"channel": channel, "label": label, "bound_to_mission": bound,
               "topics": None, "unaccounted": [], "archivable": False, "archived": False,
               "reason": ""}
        if names is None:
            # Archiving is what makes a channel unlistable, so this operation's
            # own finished work looks exactly like a read failure until the
            # realm's channel list is asked which one it is.
            exists = reader.channel_exists(channel)
            if exists is False:
                row["archived"] = True
                row["reason"] = "already archived: the realm no longer lists this channel"
                # The failed lookup was the *question* this answered, so it
                # stops being a gap: a preview that reports its own finished
                # work as something it could not read is the lie this whole
                # payload exists to avoid.
                reader.forget_errors(channel)
            else:
                row["reason"] = "the channel's topics could not be read"
            rows.append(row)
            continue
        bare = sorted({bare_topic(name) for name in names})
        row["topics"] = bare
        row["unaccounted"] = [name for name in bare if (channel, name) not in ours]
        if not bound:
            row["reason"] = ("no mission Work of this conversation carries this channel's label, "
                             "so nothing binds the channel to this work")
        elif row["unaccounted"]:
            row["reason"] = ("the channel holds topics this conversation did not reach: "
                             + ", ".join(row["unaccounted"]))
        elif not bare:
            row["reason"] = "the channel has no topics; nothing here says it is this conversation's"
        else:
            row["archivable"] = True
            row["reason"] = f"every one of its {len(bare)} topics belongs to this conversation"
        rows.append(row)
    return rows
