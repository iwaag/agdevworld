"""What finishing one request actually means, discovered.

A request is rarely one topic. The Developer asks Front for something;
Front serves it, and the callbacks it follows open conversations of their
own. When the thing is done, several conversations are still open, and the
human closes them by hand or not at all — the braindump this module answers.

**The selected request is any conversation, named by channel and topic**
(`front_desk` p4). The Front Desk's `front-desk-<id>` was the first caller;
an ordinary `front-*` conversation, one run of a routine
(`front-routine-<name>-<stamp>`) and an argue are the others, and
`classify()` says which one a root is. What
differs between them is only the **boundary**: which reached conversations
are *this* request's and which are somebody else's — see `Scope` and
`_ownership`. An execution topic (anything that is not a request and
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

from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Protocol

from agag.argue import ARGUE_CHANNEL, ARGUE_TOPIC_PREFIX
from agag.selfnote import Conversation, parse_note, parse_rootchat, parse_served
from agag.zulip import RESOLVED_TOPIC_PREFIX

from .frontdesk import DESK_PREFIX, FRONT_CHANNEL, desk_id
from .room import AGENTS_CHANNEL, INTRO_PREFIX, bare_topic
from .routines import (
    GUIDE_TOPIC, children_of, is_guide_topic, is_routine_channel, is_run_topic, routine_name,
)

#: One conversation, keyed the way the ops engine keys them: bare topic name.
Key = tuple[str, str]

#: Front's own sweep prefix: every `front-*` topic in `#front` is a request
#: to Front, the Front Desk's and the routines' included.
FRONT_PREFIX = "front-"

#: What a conversation is, by name. The **request** kinds may be selected as
#: the root of a completion; any other topic carrying a root note is
#: somebody's execution topic and names its parent instead; the two
#: **retiring** kinds carry a ✔ that means something else entirely and are
#: never a target.
DESK, FRONT, ROUTINE_RUN = "desk", "front", "routine-run"
#: An argue (`argue` p2 ex1): `#argue › argue-<stem>`, a discussion a human
#: leads. A request kind — another argue reached by a link is somebody
#: else's — with a boundary of its own: closing one ends the *discussion*
#: and nothing it opened (`_argue_boundary`).
ARGUE = "argue"
ROUTINE_GUIDE, INTRO = "routine-guide", "intro"
TOPIC = "topic"
REQUEST_KINDS = frozenset({DESK, FRONT, ROUTINE_RUN, ARGUE})
RETIRING_KINDS = frozenset({ROUTINE_GUIDE, INTRO})
#: How much of an unheld topic one read fetches. A topic is a
#: conversation, not a log; 400 is far past any this realm has produced, and
#: hitting it is reported as a gap rather than assumed to be the whole.
READ_DEPTH = 400
#: A cycle in the notes is possible (two agents anchoring each other) and the
#: walk dedupes, so this cap is a bound on a *runaway*, not on a session.
#: Reaching it is truncation and is reported.
MAX_NODES = 120
__all__ = [
    "ARGUE", "Discovery", "MAX_NODES", "READ_DEPTH", "REQUEST_KINDS", "RETIRING_KINDS",
    "Related", "Scope", "classify", "describe_kind", "discover", "related_topics",
]


# --- what a conversation is ----------------------------------------------------


def classify(channel: str, topic: str) -> str:
    """The kind of one conversation, from its channel and bare name.

    Names decide *what* a topic is because the writers' own code makes them
    (`routines.run_topic`, `frontdesk.desk_topic`); they never
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
    if channel == ARGUE_CHANNEL and topic.startswith(ARGUE_TOPIC_PREFIX):
        return ARGUE
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
        ARGUE: "an argue",
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
    def as_dict(self) -> dict:
        return {
            "channel": self.channel, "topic": self.topic, "live_topic": self.live_topic,
            "resolved": self.resolved, "known": self.known, "depth": self.depth,
            "links": self.links, "homes": self.homes,
            "channel_archived": self.channel_archived,
            "twin": self.twin, "twin_posts": self.twin_posts,
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

    def channel_topics(self, channel: str) -> list[str] | None:
        """Every topic name in a channel, or None when it could not be asked.

        This is how a held ✔ topic's open twin is noticed: only the
        channel's own listing carries both names.
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


def related_topics(
    topics: dict, root: Key, *, reader: Reader | None = None, max_nodes: int = MAX_NODES,
) -> tuple[dict[Key, Related], dict]:
    """Every conversation related to `root`, and what could not be reached.

    Breadth-first over both link edges, to a **fixed point**: a topic read
    late carries notes that name a topic expanded early, so the sweep is
    repeated until no node is added. The realm is read only for topics the
    engine does not hold with a history — which, resolved topics never being
    swept, is most of a finished session.

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
    # own notes are unknown — and it may well name *this* root. Read every
    # such home; a home joins the graph only if a sweep then links it from something reached,
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
    gaps = {
        "truncated": truncated, "max_nodes": max_nodes,
        "unread": sorted(f"{node.channel}/{node.topic}" for node in found.values()
                         if node.known == "note-only"),
        "bounded": sorted(f"{node.channel}/{node.topic}" for node in found.values()
                          if node.history_bounded),
        "errors": _unique(reader.errors),
        # Reads of the realm *interface* — since `better_zulip_call` p1 the
        # mirror, so these are local. `Closer` adds `zulip_calls` beside it
        # from the mirror's own ledger: what actually left the host.
        "reads": reader.calls,
    }
    return found, gaps


# --- the whole answer -------------------------------------------------------


@dataclass
class Discovery:
    """What closing this request would touch, and what it would not."""

    scope: Scope
    topics: list[Related]
    excluded: list[dict]
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
            "gaps": self.gaps,
        }


def _exclude(node: Related, reason: str, evidence: list[dict] | None = None) -> dict:
    return {"channel": node.channel, "topic": node.topic, "live_topic": node.live_topic,
            "last_post_id": node.last_post_id, "resolved": node.resolved,
            "reason": reason, "evidence": evidence or [],
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
    parents = [{**home, "kind": classify(home["channel"], home["topic"])}
               for home in node.homes if (home["channel"], home["topic"]) != root]
    parents.sort(key=lambda p: p["message_id"])
    label = f"#{root[0]} › {root[1]}"
    if kind in RETIRING_KINDS:
        what = ("a ✔ on a guide retires the routine; complete one of its runs instead"
                if kind == ROUTINE_GUIDE else
                "a ✔ on an introduction retires the agent; this is not a request")
        return Scope(root, kind, False, what, f"{label} is {describe_kind(kind, root[1], root[0])}",
                     parents=parents)
    if kind not in REQUEST_KINDS and parents:
        named = ", ".join(f"#{p['channel']} › {p['topic']}" for p in parents)
        return Scope(
            root, kind, False,
            f"this is {describe_kind(kind, root[1], root[0])} of {named}; select that request "
            "to complete it and its work together",
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
    elif kind == ARGUE:
        # The boundary p2 put into words: "posting here resumes the
        # discussion, not what it ended in". Whatever an argue opened is the
        # next chapter and belongs to whoever the
        # outcome names; the desk conversation it came from is somebody
        # else's request. A ✔ here ends the discussion and nothing else.
        description = (f"{label}, an argue: the discussion only. What it opened stays open, "
                       "and so does the conversation it was opened from")
    else:
        description = f"{label} and the work its records link to it"
    if parents:
        description += ("; it was opened for " +
                        ", ".join(f"#{p['channel']} › {p['topic']}" for p in parents) +
                        ", which stays open")
    return Scope(root, kind, True, "", description, parents=parents, context=context,
                 routine=routine)


def _ownership(
    root: Key, found: dict[Key, Related], lineage: Iterable[Key] = (),
) -> tuple[list[Related], list[dict]]:
    """Which reached conversations are this request's, and why the rest are not.

    A **root note** is a topic saying which conversation it was opened for,
    and it decides: a topic whose every home is this request or something
    this request owns is owned, and one naming anything else is somebody
    else's — with that note's message id as the evidence (p2's reused plan
    topic, met head-on). A topic with no root note is owned only when a link from something owned reached it —
    unless it is itself a *request* (another Front conversation, another
    run, an argue), which no served note can claim. The two
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
    return kept, sorted(excluded.values(), key=lambda row: (row["channel"], row["topic"]))


def discover(
    topics: dict,
    root: Key,
    *,
    realm: Realm | None = None,
    max_nodes: int = MAX_NODES,
) -> Discovery:
    """Everything closing the request at `root` would touch.

    Read-only, and every answer carries the record it came from. Two
    questions, in the order the evidence allows:

    1. **what the root is** — `classify` and its own root notes (`Scope`).
       An execution topic answers with its parent and nothing else;
    2. **which conversations** — the link-note walk, to a fixed point, and
       then `_ownership` over what it reached;
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
        gaps = {**gaps, "reads": reader.calls, "errors": _unique(reader.errors)}
        return Discovery(scope=scope, topics=[found[root]], excluded=excluded, gaps=gaps)
    if scope.kind == ARGUE:
        return _argue_boundary(scope, found, reader, gaps)
    lineage = [(p["channel"], p["topic"]) for p in scope.parents]
    kept, excluded = _ownership(root, found, lineage)
    _mark_archived(kept, root, reader)
    gaps = {**gaps, "reads": reader.calls, "errors": _unique(reader.errors)}
    return Discovery(scope=scope, topics=kept, excluded=excluded, gaps=gaps)


ARGUE_DOWNSTREAM = ("what the argue ended in stays open: closing an argue ends the "
                    "discussion and nothing it opened")


def _argue_boundary(scope: Scope, found: dict[Key, Related], reader: Reader, gaps: dict) -> Discovery:
    """An argue's closure is the argue topic and nothing else.

    The walk was still made, so the preview can *show* what the argue led
    to — but every conversation it reached is the outcome's work, not the
    discussion's, and is listed as an exclusion with that reason rather
    than as a target. The memo is not in this graph at all (`[memosource]`
    is deliberately not a root note) and is left as it is: presentation
    only, a ✔ there changes nothing.
    """
    root = scope.root
    kept = [found[root]]
    _mark_archived(kept, root, reader)
    excluded = [_exclude(node, ARGUE_DOWNSTREAM, node.links)
                for key, node in sorted(found.items(), key=lambda i: (i[1].depth, i[0]))
                if key != root]
    gaps = {**gaps, "reads": reader.calls, "errors": _unique(reader.errors)}
    return Discovery(scope=scope, topics=kept, excluded=excluded, gaps=gaps)


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
