"""What finishing one Front Desk conversation actually means, discovered.

A conversation at the Front Desk is rarely one topic. The Developer asks
Front for something; Front opens a workplan topic in a project channel;
autolab plans it into a Plane Work with one Sub-Work per task and opens a
`work-<label>` channel with one `workrun-` topic per task; Front follows the
callbacks back. When the thing is done, five conversations, one channel and
two Plane issues are all still open, and the human closes them by hand or
not at all — the braindump this module answers.

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
`front-desk-` conversation is another conversation's work — p2 met a reused
plan topic whose first root note still named an older Front conversation —
and it leaves this module as an *exclusion with its evidence*, for the
preview to show and the human to see, rather than as something quietly
closed or quietly dropped.

Nothing here writes. Execution is `close.py`'s (p3 step 2).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Protocol

from agag.selfnote import Conversation, parse_note, parse_rootchat, parse_served
from agag.zulip import RESOLVED_TOPIC_PREFIX

from .frontdesk import DESK_PREFIX, desk_topic, is_desk_topic
from .room import bare_topic
from .routines import ROUTINE_CHANNEL, children_of

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
    "AUTOLAB_SOURCE", "Discovery", "MAX_NODES", "PlaneBoard", "PlaneReader", "READ_DEPTH",
    "Related", "WORK_CHANNEL_PREFIX", "WORK_TAG", "WorkNote", "WorkTarget",
    "discover", "parse_work_note", "related_topics", "work_notes",
]


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

    def as_dict(self) -> dict:
        return {
            "channel": self.channel, "topic": self.topic, "live_topic": self.live_topic,
            "resolved": self.resolved, "known": self.known, "depth": self.depth,
            "links": self.links, "homes": self.homes,
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
            for message in found:
                merged[int(message.get("id") or 0)] = message
        # Neither name could be asked: unknown, which is not the same answer
        # as an empty topic and must never be reported as one.
        if answered == 0:
            return None
        messages = [merged[ident] for ident in sorted(merged)]
        self._histories[key] = messages
        if live is not None:
            self._live[key] = live
        return messages, live

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
            # A held topic's history holds no selfnotes — they are not real
            # posts — so its `[work]` notes come from the binding the engine
            # retains (`ops.Topic.works`), not from re-reading the history.
            works = work_notes(key[0], key[1], messages)
            if not works and held is not None:
                works = [WorkNote(channel=key[0], topic=key[1], project_id=project_id,
                                  issue_id=issue_id, by_id=by_id, by=by, message_id=note_id)
                         for project_id, issue_id, by_id, by, note_id
                         in (getattr(held, "works", None) or [])]
            existing = Related(
                channel=key[0], topic=key[1], live_topic=live,
                resolved=live.startswith(RESOLVED_TOPIC_PREFIX),
                known=known, depth=depth,
                homes=_homes_of(node) if node is not None else [],
                works=works,
                history_bounded=len(messages) >= READ_DEPTH,
                last_post_id=max((int(m.get("id") or 0) for m in messages), default=0),
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
        "errors": list(reader.errors),
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

    def as_dict(self) -> dict:
        return {"project_id": self.project_id, "project": self.project_name,
                "issue_id": self.issue_id, "label": self.label, "title": self.title,
                "state": self.state_group, "role": self.role, "evidence": self.evidence,
                "parent_id": self.parent_id, "children": self.children}


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
    """What closing this conversation would touch, and what it would not."""

    conversation: str
    root: Key
    topics: list[Related]
    excluded: list[dict]
    works: list[WorkTarget]
    channels: list[dict]
    gaps: dict

    def as_dict(self) -> dict:
        return {
            "conversation": self.conversation,
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
            "known": node.known}


def discover(
    topics: dict,
    ident: str,
    *,
    realm: Realm | None = None,
    plane: PlaneBoard | None = None,
    max_nodes: int = MAX_NODES,
) -> Discovery:
    """Everything closing the Front Desk conversation `ident` would touch.

    Read-only, and every answer carries the record it came from. Three
    questions, in the order the evidence allows:

    1. **which conversations** — the link-note walk, to a fixed point;
    2. **which Plane Works** — the workplan topics' `external_id` and the
       execution topics' `[work]` notes, looked up in the projects those
       topics name;
    3. **which channels** — a `work-` channel whose *whole* topic list is
       accounted for by this conversation's targets. A channel with anything
       else in it is reported and kept.
    """
    root: Key = (ROUTINE_CHANNEL, desk_topic(ident))
    reader = Reader(realm=realm)
    found, gaps = related_topics(topics, root, reader=reader, max_nodes=max_nodes)

    order = sorted(found.items(), key=lambda item: (item[1].depth, item[0]))
    excluded: list[dict] = []
    disqualified: set[Key] = set()
    for key, node in order:
        if key == root:
            continue
        if is_desk_topic(node.channel, node.topic):
            excluded.append(_exclude(node, "another Front Desk conversation", node.links))
            disqualified.add(key)
            continue
        # A root note is a topic saying which conversation it belongs to. One
        # naming a *different* desk conversation makes this somebody else's
        # work, whatever reached it from here (p2's reused plan topic).
        others = [home for home in node.homes
                  if home["channel"] == ROUTINE_CHANNEL
                  and home["topic"].startswith(DESK_PREFIX)
                  and (home["channel"], home["topic"]) != root]
        if others:
            excluded.append(_exclude(
                node, f"anchored to another Front Desk conversation "
                      f"({', '.join(sorted({home['topic'] for home in others}))})", others))
            disqualified.add(key)
    # Excluding a conversation excludes what only *it* reached: the work
    # under somebody else's plan topic is that conversation's to close, and
    # a path back to here through it is not this conversation's claim on it.
    # A target this conversation also reached by a link of its own stays.
    reachable = {root}
    growing = True
    while growing:
        growing = False
        for key, node in order:
            if key in reachable or key in disqualified:
                continue
            if any((link["from"]["channel"], link["from"]["topic"]) in reachable
                   for link in node.links):
                reachable.add(key)
                growing = True
    kept: list[Related] = []
    for key, node in order:
        if key in disqualified:
            continue
        if key not in reachable:
            through = sorted({link["from"]["topic"] for link in node.links})
            excluded.append(_exclude(
                node, "reached only through a conversation this one does not own "
                      f"({', '.join(through)})" if through else
                      "nothing links this conversation to it", node.links))
            continue
        kept.append(node)
    excluded.sort(key=lambda row: (row["channel"], row["topic"]))

    works, channels, plane_gaps = _plane_and_channels(kept, reader, plane)
    gaps = {**gaps, **plane_gaps, "zulip_calls": reader.calls, "errors": list(reader.errors)}
    return Discovery(conversation=ident, root=root, topics=kept, excluded=excluded,
                     works=works, channels=channels, gaps=gaps)


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
