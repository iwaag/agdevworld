"""What finishing one request actually means, discovered.

A request is rarely one topic. The Developer asks Front for something; Front
opens a workplan topic in a project channel; autolab plans it into a Plane
Work with one Sub-Work per task and opens a `work-<label>` channel with one
`workrun-` topic per task; Front follows the callbacks back. When the thing
is done, five conversations, one channel and two Plane issues are all still
open, and the human closes them by hand or not at all — the braindump this
module answers.

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
- the `[work]` note autolab and forge write into an execution topic
  (`agautolab.anchor`, `agforge.anchor`): `<issue id>` for autolab,
  `<project id>/<issue id>` for forge.
- Plane's own `external_source` / `external_id`, which is how autolab's
  mission Work names the workplan topic that planned it
  (`mission.work_key`) — an identifier, not a guess at a title.

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

from .frontdesk import DESK_PREFIX, FRONT_CHANNEL, desk_id
from .room import AGENTS_CHANNEL, INTRO_PREFIX, bare_topic
from .routines import (
    GUIDE_TOPIC, children_of, is_guide_topic, is_routine_channel, is_run_topic, routine_name,
)

#: One conversation, keyed the way the ops engine keys them: bare topic name.
Key = tuple[str, str]

#: The selfnote tag both autolab and forge anchor an execution topic with.
#: One tag, two shapes, and the shape says which agent wrote it.
WORK_TAG = "work"
#: `external_source` on every issue autolab registers (`mission.EXTERNAL_SOURCE`).
AUTOLAB_SOURCE = "agautolab"
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
    "AUTOLAB_SOURCE", "Discovery", "EXECUTION_KINDS", "MAX_NODES", "PlaneBoard", "PlaneReader",
    "READ_DEPTH", "REQUEST_KINDS", "RETIRING_KINDS", "Related", "Scope", "WORK_CHANNEL_PREFIX",
    "WORK_TAG", "WorkNote", "WorkTarget", "classify", "describe_kind", "discover",
    "parse_work_note", "related_topics", "work_notes",
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


def parse_work_note(content) -> tuple[str | None, str] | None:
    """`(project id or None, issue id)` of a `[selfnote][work]`, or None.

    Two writers, one tag. forge writes `<project id>/<issue id>` because an
    `assetrun-` topic's channel says nothing about which Plane project it
    runs in; autolab writes the bare `<issue id>` because its topic's root
    note already names the `pj-<slug>` channel the project is derived from.
    The presence of a separator is therefore the whole discriminator, and it
    is the writers' own format rather than a heuristic.
    """
    value = (parse_note(content, WORK_TAG) or "").strip()
    if not value:
        return None
    if "/" in value:
        project_id, issue_id = (part.strip() for part in value.split("/", 1))
        return (project_id, issue_id) if project_id and issue_id else None
    return (None, value)


@dataclass(frozen=True)
class WorkNote:
    """One `[work]` note, with who wrote it and where."""

    channel: str
    topic: str
    project_id: str | None
    issue_id: str
    by_id: int
    by: str
    message_id: int

    def as_dict(self) -> dict:
        return {"channel": self.channel, "topic": self.topic, "project_id": self.project_id,
                "issue_id": self.issue_id, "by": self.by, "by_id": self.by_id,
                "message_id": self.message_id}


def work_notes(channel: str, topic: str, messages: Iterable[dict]) -> list[WorkNote]:
    """Every `[work]` note in one topic's history, oldest first.

    Both anchors say the earliest note wins for *their own* bot; a topic can
    carry notes from two agents, so nothing is picked here — every note is
    returned with its author and the caller decides what it is party to.
    """
    found: list[WorkNote] = []
    for message in messages:
        parsed = parse_work_note(message.get("content"))
        if parsed is None:
            continue
        found.append(WorkNote(
            channel=channel, topic=topic, project_id=parsed[0], issue_id=parsed[1],
            by_id=int(message.get("sender_id") or 0),
            by=str(message.get("sender_full_name") or ""),
            message_id=int(message.get("id") or 0),
        ))
    found.sort(key=lambda note: note.message_id)
    return found


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
    works: list[WorkNote] = field(default_factory=list)
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
            "works": [note.as_dict() for note in self.works],
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


def _stem(topic: str) -> str:
    """A topic name without its writer's prefix: `assetrun-red-apple` and
    `assetplan-red-apple` share `red-apple`, which is how their author pairs
    them. Never evidence on its own — only a reason to read."""
    _, separator, rest = topic.partition("-")
    return rest if separator and rest else topic


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
    — a mission's dedicated `work-` channel, named by the Plane Work rather
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
            # A held topic's history holds no selfnotes — they are not real
            # posts — so its `[work]` notes come from the binding the engine
            # retains (`ops.Topic.works`), not from re-reading the history.
            works = work_notes(key[0], key[1], messages)
            if not works and held is not None:
                works = [WorkNote(channel=key[0], topic=key[1], project_id=project_id,
                                  issue_id=issue_id, by_id=by_id, by=by, message_id=note_id)
                         for project_id, issue_id, by_id, by, note_id
                         in (getattr(held, "works", None) or [])]
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
                works=works,
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
    # something reads them. The Plane Work names the channel; its topics are
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


# --- Plane ------------------------------------------------------------------


class PlaneBoard(Protocol):  # pragma: no cover - structural typing only
    """What discovery needs of Plane: projects, issues and state groups.

    A protocol rather than the adapter itself so a fixture can answer it —
    the plan's requirement that this be verifiable without paid runs applies
    to Plane just as much, and one 403 on one project is a state the tests
    have to be able to produce (`plane_credential_note`).
    """

    def projects(self) -> list[dict]: ...
    def issues(self, project_id: str) -> list[dict]: ...
    def state_groups(self, project_id: str) -> dict[str, str]: ...


@dataclass
class PlaneReader:
    """`agag.plane` behind `PlaneBoard`, each project asked for once.

    Errors are kept rather than raised: a credential that can read one
    project and is refused another is a *reported* condition at preview time
    (planning met exactly that), not a failure of the whole preview.
    """

    config: Any
    errors: list[dict] = field(default_factory=list)
    _projects: list[dict] | None = field(default=None, repr=False)
    _issues: dict[str, list[dict]] = field(default_factory=dict, repr=False)
    _groups: dict[str, dict[str, str]] = field(default_factory=dict, repr=False)

    def projects(self) -> list[dict]:
        if self._projects is None:
            from agag.plane import list_projects
            try:
                self._projects = list_projects(self.config)
            except Exception as error:  # noqa: BLE001
                self.errors.append({"project_id": None, "error": f"{type(error).__name__}: {error}"})
                self._projects = []
        return self._projects

    def issues(self, project_id: str) -> list[dict]:
        if project_id not in self._issues:
            from agag.plane import list_issues
            try:
                self._issues[project_id] = list_issues(self.config, project_id)
            except Exception as error:  # noqa: BLE001
                self.errors.append({"project_id": project_id, "error": f"{type(error).__name__}: {error}"})
                self._issues[project_id] = []
        return self._issues[project_id]

    def state_groups(self, project_id: str) -> dict[str, str]:
        if project_id not in self._groups:
            from agag.plane import state_groups
            try:
                self._groups[project_id] = state_groups(self.config, project_id)
            except Exception as error:  # noqa: BLE001
                self.errors.append({"project_id": project_id, "error": f"{type(error).__name__}: {error}"})
                self._groups[project_id] = {}
        return self._groups[project_id]

    def complete(self, project_id: str, issue_id: str) -> None:
        """Move one issue into the project's `completed` state.

        The **only** write this whole feature makes to Plane, and it is the
        one `agautolab.mission_done` makes: the state group is asked of the
        project rather than assumed, because a project's states are its own.
        """
        from agag.plane import state_id_for_group, update_issue
        update_issue(self.config, project_id, issue_id,
                     {"state": state_id_for_group(self.config, project_id, "completed")})


@dataclass
class WorkTarget:
    """One Plane issue this conversation is responsible for."""

    project_id: str
    project_name: str
    issue_id: str
    label: str
    title: str
    state_group: str
    #: `mission` (a Work planned in a `workplan-` topic) or `task` (a
    #: Sub-Work an execution topic was anchored to).
    role: str
    #: How it was found: an `external_id` on the workplan topic, or a
    #: `[work]` note and who wrote it.
    evidence: list[dict] = field(default_factory=list)
    parent_id: str | None = None
    children: list[dict] = field(default_factory=list)
    #: The issue's `external_source`: which agent registered it. autolab's
    #: missions have a dedicated `work-` channel; nobody else's do.
    source: str | None = None

    def as_dict(self) -> dict:
        return {"project_id": self.project_id, "project": self.project_name,
                "issue_id": self.issue_id, "label": self.label, "title": self.title,
                "state": self.state_group, "role": self.role, "evidence": self.evidence,
                "parent_id": self.parent_id, "children": self.children, "source": self.source}


def _project_slug(row: dict) -> str | None:
    """`mission.project_slug`, reproduced: the local slug of an `[AUTO]`
    Plane project, from the description autolab wrote when it made it."""
    description = str(row.get("description") or "").strip()
    if not description.upper().startswith(AUTO_MARKER):
        return None
    remainder = description[len(AUTO_MARKER):].strip()
    _, _, tail = remainder.partition(":")
    slug = re.sub(r"\s+", " ", (tail if tail.strip() else str(row.get("name", "")))).strip().lower()
    return slug or None


def _issue_label(project: dict, issue: dict) -> str:
    identifier = str(project.get("identifier") or "").strip()
    sequence = issue.get("sequence_id")
    return f"{identifier}-{sequence}" if identifier and sequence is not None else str(issue.get("id"))


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
        description = f"{label}, an Autolab request, its tasks, its Plane Work and its work channel"
    elif kind == ASSETPLAN:
        description = f"{label}, a Forge request, its run and its Plane Work"
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

    def settle(key: Key, node: Related) -> str | None:
        kind = classify(node.channel, node.topic)
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
    plane: PlaneBoard | None = None,
    max_nodes: int = MAX_NODES,
) -> Discovery:
    """Everything closing the request at `root` would touch.

    Read-only, and every answer carries the record it came from. Four
    questions, in the order the evidence allows:

    1. **what the root is** — `classify` and its own root notes (`Scope`).
       An execution topic answers with its parent and nothing else;
    2. **which conversations** — the link-note walk, to a fixed point, and
       then `_ownership` over what it reached;
    3. **which Plane Works** — the workplan topics' `external_id` and the
       execution topics' `[work]` notes, looked up in the projects those
       topics name;
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
        gaps = {**gaps, "plane": [], "zulip_calls": reader.calls, "errors": _unique(reader.errors)}
        return Discovery(scope=scope, topics=[found[root]], excluded=excluded, works=[],
                         channels=[], gaps=gaps)
    lineage = [(p["channel"], p["topic"]) for p in scope.parents]
    kept, excluded = _ownership(root, found, lineage)
    _mark_archived(kept, root, reader)
    works, channels, plane_gaps = _plane_and_channels(kept, reader, plane)
    # A mission Work this request owns names its dedicated channel, and the
    # channel may hold task topics no note from here reached. Read them and
    # walk once more; every read is cached, so what was already known costs
    # nothing, and ownership is decided again over the larger graph.
    seeds = []
    for work in works:
        if work.role != "mission" or work.source != AUTOLAB_SOURCE:
            continue
        channel = f"{WORK_CHANNEL_PREFIX}{work.label.lower()}"
        names = reader.channel_topics(channel) or []
        if any((channel, bare_topic(name)) not in found for name in names):
            seeds.append(channel)
    if seeds:
        found, gaps = related_topics(topics, root, reader=reader, max_nodes=max_nodes,
                                     seed_channels=sorted(set(seeds)))
        kept, excluded = _ownership(root, found, lineage)
        _mark_archived(kept, root, reader)
        works, channels, plane_gaps = _plane_and_channels(kept, reader, plane)
    gaps = {**gaps, **plane_gaps, "zulip_calls": reader.calls, "errors": _unique(reader.errors)}
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


def _plane_and_channels(
    kept: list[Related], reader: Reader, plane: PlaneBoard | None,
) -> tuple[list[WorkTarget], list[dict], dict]:
    """The Plane Works and dedicated channels these topics account for."""
    notes = [note for node in kept for note in node.works]
    # The projects in play: every `pj-<slug>` channel a kept topic lives in,
    # plus any project a forge note named outright.
    slugs = {node.channel[len(PROJECT_CHANNEL_PREFIX):] for node in kept
             if node.channel.startswith(PROJECT_CHANNEL_PREFIX)}
    named = {note.project_id for note in notes if note.project_id}
    missing_plane = []
    if plane is None:
        missing_plane.append("no Plane credential is configured, so no Work is known")
        return [], _channels(kept, reader, {}, missing_plane), {"plane": missing_plane}

    projects = {str(row["id"]): row for row in plane.projects() if row.get("id")}
    wanted: dict[str, dict] = {pid: row for pid, row in projects.items() if pid in named}
    for pid, row in projects.items():
        if _project_slug(row) in slugs:
            wanted[pid] = row
    for pid in named - set(projects):
        missing_plane.append(f"a [work] note names Plane project {pid}, which this credential cannot see")
    for slug in sorted(slugs - {_project_slug(row) for row in wanted.values()}):
        missing_plane.append(f"no [AUTO] Plane project matches the channel pj-{slug}")

    issues: dict[str, dict] = {}
    by_external: dict[tuple[str, str], dict] = {}
    groups: dict[str, dict[str, str]] = {}
    for pid in wanted:
        groups[pid] = plane.state_groups(pid)
        if not groups[pid]:
            missing_plane.append(f"the states of project {wanted[pid].get('name') or pid} could not be read")
        for issue in plane.issues(pid):
            issue = {**issue, "_project": pid}
            issues[str(issue["id"])] = issue
            external = str(issue.get("external_id") or "")
            if external and str(issue.get("external_source") or "") == AUTOLAB_SOURCE:
                by_external[(pid, external)] = issue

    targets: dict[str, WorkTarget] = {}

    def add(issue: dict, role: str, evidence: dict) -> None:
        ident = str(issue["id"])
        pid = str(issue["_project"])
        existing = targets.get(ident)
        if existing is None:
            existing = WorkTarget(
                project_id=pid, project_name=str(wanted[pid].get("name") or pid),
                issue_id=ident, label=_issue_label(wanted[pid], issue),
                title=str(issue.get("name") or ""),
                state_group=groups.get(pid, {}).get(str(issue.get("state") or "")) or "unknown",
                role=role, parent_id=str(issue.get("parent") or "") or None,
                source=str(issue.get("external_source") or "") or None,
            )
            targets[ident] = existing
        elif existing.role == "task" and role == "mission":
            existing.role = role
        if evidence not in existing.evidence:
            existing.evidence.append(evidence)

    # A mission Work names its workplan topic outright; that identifier is
    # the strongest evidence there is, and it needs no note to have survived.
    for node in kept:
        if not node.topic.startswith(WORKPLAN_PREFIX):
            continue
        for pid, row in wanted.items():
            issue = by_external.get((pid, f"{node.channel}/{node.topic}"))
            if issue is not None:
                add(issue, "mission", {"how": "external_id", "external_id": f"{node.channel}/{node.topic}",
                                       "channel": node.channel, "topic": node.topic})

    for note in notes:
        issue = issues.get(note.issue_id)
        if issue is None:
            missing_plane.append(
                f"the [work] note in {note.channel}/{note.topic} names issue {note.issue_id}, "
                "which is not in any project this conversation reaches")
            continue
        add(issue, "mission" if not issue.get("parent") else "task",
            {"how": "work note", **note.as_dict()})
        parent = issues.get(str(issue.get("parent") or ""))
        if parent is not None:
            add(parent, "mission", {"how": "parent of a [work] note's Sub-Work",
                                    "child": note.issue_id, "channel": note.channel,
                                    "topic": note.topic})

    # Every child of a mission, whether or not this conversation reached its
    # topic: the completion rule is about *all* the children, and one this
    # walk never saw is exactly what must block rather than be assumed done.
    for target in list(targets.values()):
        if target.role != "mission":
            continue
        group = groups.get(target.project_id, {})
        target.children = [
            {"issue_id": str(row["id"]), "label": _issue_label(wanted[target.project_id], row),
             "title": str(row.get("name") or ""),
             "state": group.get(str(row.get("state") or "")) or "unknown",
             "reached": str(row["id"]) in targets}
            for row in issues.values()
            if str(row.get("parent") or "") == target.issue_id
            and str(row["_project"]) == target.project_id
        ]
        target.children.sort(key=lambda row: row["label"])

    labels = {target.label.lower() for target in targets.values() if target.role == "mission"}
    return (sorted(targets.values(), key=lambda t: (t.project_name, t.label)),
            _channels(kept, reader, {label: True for label in labels}, missing_plane),
            {"plane": missing_plane})


def _channels(
    kept: list[Related], reader: Reader, mission_labels: dict, notes: list[str],
) -> list[dict]:
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
