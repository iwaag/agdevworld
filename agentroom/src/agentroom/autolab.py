"""autolab's work record, as this room reads it.

Until `refactor` p1 autolab kept its record in Plane: a Work per mission, a
Sub-Work per task, and a `[selfnote][work]` note in each execution topic
naming the issue it ran. This room read that record from Plane and used the
notes as the bridge. The record is the **conversation** now, so the bridge
is gone and there is nothing to bridge to: what a mission is, which tasks it
has, and how far each has got are all written in the topics themselves.

This module is the reader for that. It reproduces the format
`agautolab.anchor` writes — the way `closing.parse_work_note` reproduces the
`[work]` note and `routines` reproduces the run-topic names — because this
room is a *reader* of other agents' realms and holds no dependency on any of
their packages. The format is one line per fact:

    [selfnote][mission] <project slug>       in a workplan- topic
    [selfnote][task] <mission id>#<serial>   in a workrun- topic
    [selfnote][doc] <message id>             the visible document that is current
    [selfnote][state] <word>                 the newest one wins
    [selfnote][replaces] <anchor id>         the work this one replaced

Two rules, and they are the writer's:

- **identity is written once**, so the earliest note of its kind wins, and
  the note's **own message id** is the mission or the task. A name decides
  nothing: a topic may be renamed, resolved, or replaced by other work that
  took its name, and the anchor still says which conversation is which.
- **state and the current document change**, so the newest note wins.

Nothing here is rendered as prose from a selfnote. What the room *shows* a
human is the visible post the `[doc]` note points at — the plan, or a task's
description — which is an ordinary message anybody in the channel can read.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

from agag.selfnote import parse_note

#: The five tags autolab writes, beside the shared `rootchat` and `served`.
MISSION_TAG = "mission"
TASK_TAG = "task"
DOC_TAG = "doc"
STATE_TAG = "state"
REPLACES_TAG = "replaces"
TAGS = (MISSION_TAG, TASK_TAG, DOC_TAG, STATE_TAG, REPLACES_TAG)

#: A mission's states, as the writer words them.
MISSION_PLANNED = "planned"
MISSION_STARTED = "started"
MISSION_CANCELLED = "cancelled"
MISSION_REPLACED = "replaced"
MISSION_DONE = "done"

#: A task's states. `open` is the absence of any other, so it is never written.
TASK_OPEN = "open"
TASK_COMPLETED = "completed"
TASK_CANCELLED = "cancelled"
TASK_ACCEPTED = "accepted"
#: What counts as finished for the mission's own completion rule. Accepting a
#: task is a stronger statement than completing it, so it counts too.
TASK_FINISHED = (TASK_COMPLETED, TASK_ACCEPTED)

#: One channel per mission, named from the mission's anchor id.
WORK_CHANNEL_PREFIX = "work-"

#: Said when a mission is already done, so a caller can recognise the no-op.
ALREADY_DONE = "it is already done"

#: The two state words somebody **other than the record's own author** may
#: write. Every other state is the agent reporting its own work. These two are
#: a *person* accepting it — and the person accepts it from here, with their
#: own credential, so reading them from anyone is what makes this room's own
#: write visible to the record it was written into. `refactor` p1 step 4 met
#: the alternative live: the acceptance landed and the next preview read the
#: mission as unfinished.
EXTERNAL_STATES = (TASK_ACCEPTED, MISSION_DONE)

__all__ = [
    "ALREADY_DONE", "MISSION_CANCELLED", "MISSION_DONE", "MISSION_PLANNED",
    "MISSION_REPLACED", "MISSION_STARTED", "Mission", "Note", "TAGS",
    "TASK_ACCEPTED", "TASK_CANCELLED", "TASK_COMPLETED", "TASK_FINISHED",
    "EXTERNAL_STATES", "TASK_OPEN", "Task", "WORK_CHANNEL_PREFIX", "mission_label",
    "notes_in", "read_record", "reason_not_finished", "work_channel_name",
]


@dataclass(frozen=True)
class Note:
    """One of autolab's selfnotes, with who wrote it and where."""

    tag: str
    value: str
    message_id: int
    by_id: int
    by: str

    def as_tuple(self) -> tuple[str, str, int, int, str]:
        return (self.tag, self.value, self.message_id, self.by_id, self.by)

    @classmethod
    def of(cls, entry) -> "Note":
        """A note back from the tuple form the ops engine retains."""
        tag, value, message_id, by_id, by = entry
        return cls(str(tag), str(value), int(message_id), int(by_id), str(by))


def notes_in(messages: Iterable[dict]) -> list[Note]:
    """Every autolab note in one topic's history, oldest first.

    Every note, from every sender: a topic can in principle carry notes from
    more than one bot, and picking is the caller's job — the same discipline
    `closing.work_notes` follows.
    """
    found: list[Note] = []
    for message in messages:
        content = message.get("content")
        for tag in TAGS:
            value = parse_note(content, tag)
            if value is None:
                continue
            found.append(Note(
                tag=tag, value=value.strip(),
                message_id=int(message.get("id") or 0),
                by_id=int(message.get("sender_id") or 0),
                by=str(message.get("sender_full_name") or ""),
            ))
            break
    found.sort(key=lambda note: note.message_id)
    return found


def mission_label(anchor_id: int) -> str:
    """`m5512` — a mission's anchor id, worn as a name."""
    return f"m{int(anchor_id)}"


def work_channel_name(anchor_id: int) -> str:
    """`work-m5512` — the channel that mission's task topics live in."""
    return f"{WORK_CHANNEL_PREFIX}{mission_label(anchor_id)}"


def _earliest(notes: list[Note], tag: str) -> Note | None:
    return next((note for note in notes if note.tag == tag), None)


def _newest_value(notes: list[Note], tag: str) -> str | None:
    found = [note for note in notes if note.tag == tag]
    return found[-1].value if found else None


def _int(value: str | None) -> int | None:
    try:
        return int((value or "").strip())
    except ValueError:
        return None


@dataclass
class Mission:
    """One mission: the conversation that plans it, and where it has got to."""

    anchor_id: int
    slug: str
    channel: str
    topic: str
    state: str = MISSION_PLANNED
    #: The message id of the visible post holding the current plan, if any.
    document_id: int | None = None
    #: The anchor id of the mission this one replaced, if any.
    replaces: int | None = None
    by: str = ""
    tasks: list["Task"] = field(default_factory=list)

    @property
    def label(self) -> str:
        return mission_label(self.anchor_id)

    @property
    def work_channel(self) -> str:
        return work_channel_name(self.anchor_id)

    def as_dict(self) -> dict:
        return {"anchor_id": self.anchor_id, "slug": self.slug, "channel": self.channel,
                "topic": self.topic, "state": self.state, "document_id": self.document_id,
                "replaces": self.replaces, "by": self.by, "label": self.label,
                "work_channel": self.work_channel}


@dataclass
class Task:
    """One task: the conversation that runs it, and where it has got to."""

    anchor_id: int
    mission_id: int
    serial: int
    channel: str
    topic: str
    state: str = TASK_OPEN
    document_id: int | None = None
    replaces: int | None = None
    by: str = ""

    @property
    def label(self) -> str:
        return f"{mission_label(self.mission_id)}#{self.serial}"

    @property
    def finished(self) -> bool:
        return self.state in TASK_FINISHED

    def as_dict(self) -> dict:
        return {"anchor_id": self.anchor_id, "mission_id": self.mission_id,
                "serial": self.serial, "channel": self.channel, "topic": self.topic,
                "state": self.state, "document_id": self.document_id,
                "replaces": self.replaces, "by": self.by, "label": self.label}


def read_record(channel: str, topic: str, notes: list[Note]) -> Mission | Task | None:
    """The mission or task this conversation *is*, or None for neither.

    A topic carries one or the other, never both: a `workplan-` topic is
    anchored with a `[mission]` note and a `workrun-` topic with a `[task]`
    note. The note's own message id is the identity, so the topic's name is
    read back only to say where the conversation currently is.

    **The identity note's author is the record's author**, and only that
    sender's other notes are read. A topic can carry notes from more than
    one bot, and a visitor's `[state]` line must not be able to say where
    somebody else's work has got to — the writer asks the same question of
    its own history as `self_id` (`agautolab.anchor`), and this is that rule
    from outside, where the author is discovered rather than known.

    The exception is `EXTERNAL_STATES`, and it is the reason this room can
    write at all: acceptance is somebody else's word by definition.
    """
    identity = _earliest(notes, MISSION_TAG) or _earliest(notes, TASK_TAG)
    if identity is None:
        return None
    own = [note for note in notes if note.by_id == identity.by_id]
    state = _newest_value(
        [note for note in notes
         if note.by_id == identity.by_id or note.value.strip().lower() in EXTERNAL_STATES],
        STATE_TAG,
    )
    document_id = _int(_newest_value(own, DOC_TAG))
    replaces = _int(_newest_value(own, REPLACES_TAG))
    mission = _earliest(own, MISSION_TAG)
    if mission is not None:
        return Mission(
            anchor_id=mission.message_id, slug=mission.value, channel=channel, topic=topic,
            state=(state or MISSION_PLANNED).lower(), document_id=document_id,
            replaces=replaces, by=mission.by,
        )
    task = _earliest(own, TASK_TAG)
    if task is None:
        return None
    head, separator, tail = task.value.partition("#")
    mission_id, serial = _int(head), _int(tail) if separator else None
    if mission_id is None or serial is None:
        return None
    return Task(
        anchor_id=task.message_id, mission_id=mission_id, serial=serial,
        channel=channel, topic=topic, state=(state or TASK_OPEN).lower(),
        document_id=document_id, replaces=replaces, by=task.by,
    )


def reason_not_finished(mission: Mission, tasks: list[Task]) -> str | None:
    """Why this mission may not be marked done, or None when it may.

    `agautolab.mission_done.reason_not_finished`, reproduced: the counting
    rule that decides a mission is over. Counting, not judgement — the
    human's click is what says the work was any good.

    A **cancelled** task is not counted at all: it was called off, and the
    tasks that remain are the mission. A mission with nothing but cancelled
    tasks therefore has no task, which is the honest answer for work that
    never ran.
    """
    if mission.state == MISSION_DONE:
        return ALREADY_DONE
    if mission.state == MISSION_CANCELLED:
        return "it is cancelled"
    if mission.state == MISSION_REPLACED:
        return "it was replaced, and its replacement is the work to finish"
    live = [task for task in tasks if task.state != TASK_CANCELLED]
    if not live:
        return "it has no task, so there is nothing that could have finished"
    unfinished = [task for task in live if not task.finished]
    if unfinished:
        serials = ", ".join(str(task.serial) for task in sorted(unfinished, key=lambda t: t.serial))
        return f"task {serials} of {len(live)} is not finished"
    return None
