"""The Project Room's read model: a project, from its purpose to its runs.

`project_room` p1 step 1. Since `argue` p1 an argue can end in a **project**
or a **study** — a `pj-<slug>` channel holding a purpose document (`goal`,
or `researchplan-<stem>`), a `workplan-setup-<slug>` conversation in which
autolab prepares the workspace, and, later, the `workplan-` missions and
their `workrun-` tasks. Until now the only screens showing any of this were
the agent room (open topics by channel) and the operation room (who owes a
reply). Neither says what a project *is for*, which plans it has, how far
each run has got, or that a study has a research plan and no mission yet.

This module reads all of that **from the mirror**, so a board refresh costs
no Zulip call, and says what it could not read rather than showing an empty
board. Its rules:

- **The channel is the project.** `pj-<slug>` is opened by a human or by
  `agproject`; its stream id is the stable selection key, its name the slug.
  Kind (`project` / `study`) is read from the description when a writer put
  it there (`agproject` does; autolab's `(study pattern)` marker counts) and
  is `unknown` for older channels — never guessed from the topics.
- **Four shapes of conversation, told apart by what they carry.** A `goal`
  or `researchplan-…` topic is a *document*: the newest visible post is the
  current text. A `workplan-setup-…` topic is *setup*: autolab prepares
  folders and deliberately plans no mission (an older setup that does carry
  a `[mission]` note is shown as the mission it is, marked setup). A
  `workplan-…` topic with a `[mission]` note is a *mission*; one without is
  an *unrecorded plan* — planned before the conversation became the record,
  or not yet answered. A `workrun-…` topic with a `[task]` note is a *task*
  of the mission the note names.
- **Identity is the anchor id** (`autolab.read_record`): a rename, a ✔ or a
  reused name never turns one mission into another, `[replaces]` is the one
  recorded relation between two missions, and a task belongs to a mission by
  the id in its note, never by the channel it is in. **No research-plan-to-
  mission relation is inferred** from similar names: recorded links (`[rootchat]`
  notes, `[replaces]`) are exposed, and a missing one stays unassigned.
- **Two states, side by side.** The *recorded* work state is autolab's own
  `[state]` word (`planned`, `started`, `done`…), and `started` does not prove
  a process is running. The *reply* state is the ops engine's judgement of
  who owes a reply in that conversation (`awaiting`, `stalled`, `acked`,
  `done`) — one engine, one verdict, never computed twice here. A resolved
  topic is `done` as a conversation and says nothing about whether the work
  was any good; the human's acceptance (`accepted` / `done` notes) does.
- **Counts, not percentages.** A mission shows how many tasks it has and how
  many are finished; a work channel the mirror does not hold (archived, or
  never opened) makes that count *incomplete* and the payload says so.
- **Unknown stays unknown.** While the mirror is stale every reply state is
  `unknown` with the last known state beside it; an archived project channel
  is listed with what its description says and nothing invented for the rest.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from urllib.parse import quote

from agag.argue import ARGUE_TAG
from agag.mirror import Mirror, bare_topic
from agag.selfnote import is_speech, parse_rootchat

from .autolab import (
    MISSION_DONE,
    MISSION_PLANNED,
    TASK_ACCEPTED,
    TASK_CANCELLED,
    TASK_COMPLETED,
    TASK_FINISHED,
    Mission,
    Task,
    notes_in,
    read_record,
    work_channel_name,
)
from .presentation import shown_content
from .room import PROJECT_PREFIX, WORK_PREFIX, health_block, strip_selfnotes

SCHEMA = "ag.projectroom.v1"
GOAL_TOPIC = "goal"
RESEARCHPLAN_PREFIX = "researchplan-"
SETUP_PREFIX = "workplan-setup-"
PLAN_PREFIX = "workplan-"
RUN_PREFIX = "workrun-"
#: What a conversation in a project channel *is*, told by what it carries.
DOCUMENT, SETUP, MISSION, PLAN, TASK, OTHER = "document", "setup", "mission", "plan", "task", "other"
#: How a link found in a source post is filed, for the room's link rail.
LINK_REPOSITORY, LINK_REPORT, LINK_ZULIP, LINK_OTHER = "repository", "report", "zulip", "other"

_DESCRIPTION = re.compile(r"project:\s*(?P<slug>[a-z0-9_-]+);\s*(?P<kind>project|study)\b", re.IGNORECASE)
_ORIGIN = re.compile(r"opened from argue\s+(?P<channel>[^/\s]+)/(?P<topic>[^;\n]+?)\s*(?:;|$)", re.IGNORECASE)
_STUDY_MARK = re.compile(r"\(study pattern\)|^\s*study project\b", re.IGNORECASE)
_URL = re.compile(r"(https?://[^\s<>)\]`'\"]+)")
_HEADING = re.compile(r"^\s*#{1,6}\s+(?P<title>.+?)\s*$", re.MULTILINE)
#: The order the reply states are ranked in when one conversation has rows for
#: several instances: what is owed longest is what the board leads with.
REPLY_ORDER = {"stalled": 0, "unknown": 1, "awaiting": 2, "acked": 3, "done": 4}

__all__ = [
    "DOCUMENT", "MISSION", "OTHER", "PLAN", "ProjectRoom", "SCHEMA", "SETUP", "TASK",
    "classify", "links_in", "parse_description", "title_of",
]


# --- reading one post ----------------------------------------------------------


def parse_description(description: str | None) -> dict:
    """What a channel's description says about the project: its kind, and the
    argue it was opened from. `unknown` when the writer did not say."""
    text = str(description or "")
    kind = "unknown"
    found = _DESCRIPTION.search(text)
    if found:
        kind = found.group("kind").lower()
    elif _STUDY_MARK.search(text):
        kind = "study"
    origin = None
    where = _ORIGIN.search(text)
    if where:
        origin = {"channel": where.group("channel").strip().lstrip("#"), "topic": where.group("topic").strip()}
    return {"kind": kind, "origin": origin, "text": text}


def title_of(content: str | None) -> str:
    """The first heading of a document, else its first non-empty line."""
    text = strip_selfnotes(shown_content(content or ""))
    found = _HEADING.search(text)
    if found:
        return found.group("title").strip("* ").strip()
    for line in text.splitlines():
        line = line.strip().strip("*").strip()
        if line and not line.startswith(("```", "|", "---")):
            return line[:160]
    return ""


def link_kind(url: str) -> str:
    lower = url.lower()
    if "/#narrow/" in lower:
        return LINK_ZULIP
    if lower.endswith(".git") or "github.com/" in lower or ":3000/" in lower or "gitea" in lower:
        return LINK_REPOSITORY
    if "report" in lower.rsplit("/", 1)[-1] or lower.endswith((".md", ".pdf", ".html")):
        return LINK_REPORT
    return LINK_OTHER


def links_in(content: str | None) -> list[dict]:
    """Every URL a post names, once, filed by what it looks like."""
    seen: set[str] = set()
    found = []
    for match in _URL.finditer(str(content or "")):
        url = match.group(1).rstrip(".,;:!?")
        if url in seen:
            continue
        seen.add(url)
        found.append({"url": url, "kind": link_kind(url)})
    return found


def classify(topic: str, record: Mission | Task | None) -> str:
    """The shape of one project-channel conversation, from its name and
    the record it carries. A record outranks a name: a setup topic that
    carries a `[mission]` note is a mission (and says it is setup-shaped
    through `setup: true` on the row)."""
    bare = bare_topic(topic)
    if isinstance(record, Mission):
        return MISSION
    if isinstance(record, Task):
        return TASK
    if bare == GOAL_TOPIC or bare.startswith(RESEARCHPLAN_PREFIX):
        return DOCUMENT
    if bare.startswith(SETUP_PREFIX):
        return SETUP
    if bare.startswith(PLAN_PREFIX):
        return PLAN
    return OTHER


# --- the model -----------------------------------------------------------------


@dataclass
class Read:
    """One conversation, as the mirror holds it now."""

    channel: str
    topic: str            # bare
    live_topic: str
    resolved: bool
    messages: list
    complete: bool
    record: Mission | Task | None = None
    speech: list = field(default_factory=list)


@dataclass
class ProjectRoom:
    """The read model: derived once per mirror revision, answered from memory."""

    mirror: Mirror | None
    ops: object | None = None
    _lock: threading.RLock = field(default_factory=threading.RLock, repr=False)
    _revision: int = -1
    _derived: dict | None = field(default=None, repr=False)

    # -- reads of the mirror --------------------------------------------------------

    def _narrow(self, channel: str, live_topic: str | None, message_id: int | None = None) -> str | None:
        mirror = self.mirror
        if mirror is None or not getattr(mirror, "base_url", ""):
            return None
        found = mirror.channel(channel) or next(
            (c for c in mirror.channels(include_archived=True) if c.name == channel), None)
        if found is None:
            return None
        url = f"{mirror.base_url}/#narrow/channel/{found.stream_id}-{quote(channel, safe='')}"
        if live_topic is not None:
            url += f"/topic/{quote(live_topic, safe='')}"
        if message_id is not None:
            url += f"/near/{int(message_id)}"
        return url

    def _read(self, channel: str, bare: str, indexes: list) -> Read:
        mirror = self.mirror
        messages = mirror.messages(channel, bare) if mirror is not None else []
        open_ones = [t for t in indexes if not t.resolved]
        live = (open_ones or indexes)[0].live_name if indexes else bare
        resolved = not open_ones if indexes else False
        # An open twin counts only when it really holds posts (`presentation.locate`).
        if open_ones and indexes and len(indexes) > 1 and not any(m.topic == live for m in messages):
            live = next(t.live_name for t in indexes if t.resolved)
            resolved = True
        complete = all(t.complete for t in indexes) if indexes else False
        zulip = [m.as_zulip() for m in messages]
        record = read_record(channel, bare, notes_in(zulip))
        speech = [m for m in messages if is_speech(m.as_zulip())]
        return Read(channel=channel, topic=bare, live_topic=live, resolved=resolved, messages=messages,
                    complete=complete, record=record, speech=speech)

    def _reads_of(self, channel: str) -> dict[str, Read]:
        """Every conversation of one channel, keyed by bare name."""
        mirror = self.mirror
        grouped: dict[str, list] = {}
        for index in mirror.topics(channel):
            grouped.setdefault(index.name, []).append(index)
        return {bare: self._read(channel, bare, indexes) for bare, indexes in grouped.items()}

    def _argue_anchor(self, origin: dict | None) -> int | None:
        """The anchor id of the argue a description names, when the mirror
        holds it — a recorded link, followed to the id a rename cannot touch."""
        if origin is None or self.mirror is None:
            return None
        found = [n.message_id for n in self.mirror.notes(tag=ARGUE_TAG, channel=origin["channel"])
                 if bare_topic(n.topic) == bare_topic(origin["topic"])]
        return min(found) if found else None

    # -- derivation -----------------------------------------------------------------

    def refresh(self) -> dict:
        mirror = self.mirror
        if mirror is None:
            return {"projects": {}, "by_name": {}, "tasks": {}, "orphans": [], "replaced_by": {}}
        revision = int(mirror.revision())
        with self._lock:
            if self._derived is not None and revision == self._revision:
                return self._derived
        derived = self._derive(mirror)
        with self._lock:
            self._derived, self._revision = derived, revision
        return derived

    def _derive(self, mirror: Mirror) -> dict:
        every = mirror.channels(include_archived=True)
        live_names = {c.name for c in mirror.channels()}
        projects: dict[int, dict] = {}
        folder_to_project: dict[int, int] = {}
        for channel in sorted(every, key=lambda c: c.name):
            if not channel.name.startswith(PROJECT_PREFIX):
                continue
            described = parse_description(channel.description)
            reads = self._reads_of(channel.name) if channel.name in live_names else {}
            projects[channel.stream_id] = {
                "channel": channel, "slug": channel.name[len(PROJECT_PREFIX):], "kind": described["kind"],
                "origin": described["origin"], "description": described["text"],
                "archived": channel.archived or channel.name not in live_names, "reads": reads,
            }
            if channel.folder_id is not None:
                folder_to_project[channel.folder_id] = channel.stream_id

        # Tasks live in `work-` channels; the note names the mission by id.
        tasks: dict[int, list[Task]] = {}
        orphans: list[dict] = []
        work_channels = {c.name: c for c in every if c.name.startswith(WORK_PREFIX)}
        seen_tasks: set[tuple[str, str]] = set()
        for note in mirror.notes(tag="task"):
            key = (note.channel, bare_topic(note.topic))
            if key in seen_tasks or not note.channel:
                continue
            seen_tasks.add(key)
            read = self._read(note.channel, key[1], mirror.topic(note.channel, key[1]))
            if not isinstance(read.record, Task):
                continue
            read.record.tasks_read = read  # type: ignore[attr-defined]
            tasks.setdefault(read.record.mission_id, []).append(read.record)
        missions_by_anchor: dict[int, tuple[int, Read]] = {}
        for stream_id, project in projects.items():
            for read in project["reads"].values():
                if isinstance(read.record, Mission):
                    missions_by_anchor[read.record.anchor_id] = (stream_id, read)
        for mission_id, found in tasks.items():
            if mission_id in missions_by_anchor:
                continue
            for task in found:
                channel = work_channels.get(task.channel)
                project_id = folder_to_project.get(channel.folder_id) if channel and channel.folder_id else None
                orphans.append({"task": task, "project_id": project_id})
        replaced_by: dict[int, int] = {}
        for anchor, (_, read) in missions_by_anchor.items():
            if read.record.replaces is not None:
                replaced_by[read.record.replaces] = anchor
        return {"projects": projects, "by_name": {p["channel"].name: i for i, p in projects.items()},
                "tasks": tasks, "orphans": orphans, "replaced_by": replaced_by,
                "missions": missions_by_anchor, "work_channels": work_channels}

    # -- the reply state, lifted from the ops engine --------------------------------------

    def _reply_rows(self, now: float) -> tuple[dict[tuple[str, str], list[dict]], bool]:
        """`{(channel, bare topic): ops rows}` and whether the engine is live."""
        if self.ops is None:
            return {}, False
        board = self.ops.snapshot(now)
        found: dict[tuple[str, str], list[dict]] = {}
        for row in board["rows"]:
            if row.get("channel") is None or row.get("topic") is None:
                continue
            found.setdefault((row["channel"], row["topic"]), []).append(row)
        return found, board["health"]["state"] == "live"

    @staticmethod
    def _reply(rows: list[dict], read: Read, live: bool, has_ops: bool) -> dict:
        if not has_ops:
            return {"state": "unknown", "evidence": "the ops engine is not configured", "rows": []}
        if not rows:
            if read.resolved:
                return {"state": "done", "evidence": "the topic carries ✔", "rows": []}
            if not read.speech:
                return {"state": "quiet", "evidence": "nobody has spoken here", "rows": []}
            last = read.speech[-1]
            return {"state": "quiet", "evidence": f"nobody owes a reply; {last.sender_name}'s post #{last.id} is the newest",
                    "rows": []}
        ranked = sorted(rows, key=lambda r: (REPLY_ORDER.get(str(r.get("stale_state") or r["state"]), 9),
                                             -(r.get("age_seconds") or 0)))
        lead = ranked[0]
        reply = {
            "state": lead["state"], "instance": lead["instance"], "route": lead.get("route"),
            "age_seconds": lead.get("age_seconds"), "evidence": lead["provenance"]["text"],
            "short": lead["provenance"]["short"],
            "rows": [{"instance": r["instance"], "state": r["state"], "short": r["provenance"]["short"]} for r in ranked],
        }
        if lead.get("stale_state"):
            reply["stale_state"] = lead["stale_state"]
        if not live and "stale_state" not in reply:
            reply["stale_state"] = reply["state"]
            reply["state"] = "unknown"
        return reply

    # -- payload pieces -----------------------------------------------------------------

    @staticmethod
    def _post(message) -> dict:
        return {"message_id": message.id, "at": message.timestamp, "by": message.sender_name,
                "sender_id": message.sender_id}

    def _conversation(self, read: Read, replies, live: bool, *, with_links: bool = True) -> dict:
        last = read.speech[-1] if read.speech else None
        links = []
        if with_links:
            for message in read.speech:
                for link in links_in(message.content):
                    if all(l["url"] != link["url"] for l in links):
                        links.append({**link, "message_id": message.id})
        origins = []
        for message in read.messages:
            home = parse_rootchat(message.content)
            if home is not None:
                origins.append({"channel": home.channel, "topic": bare_topic(home.topic),
                                "by": message.sender_name, "by_id": message.sender_id, "message_id": message.id})
        return {
            "channel": read.channel, "topic": read.topic, "live_topic": read.live_topic, "resolved": read.resolved,
            "posts": len(read.speech), "last_post": self._post(last) if last else None,
            "first_post": self._post(read.speech[0]) if read.speech else None,
            "read": {"complete": read.complete,
                     "note": None if read.complete else "the mirror does not hold this conversation whole"},
            "reply": self._reply(replies.get((read.channel, read.topic), []), read, live, self.ops is not None),
            "origins": origins, "links": links,
            "zulip_url": self._narrow(read.channel, read.live_topic),
        }

    def _document_row(self, read: Read, replies, live: bool, *, full: bool) -> dict:
        current = read.speech[-1] if read.speech else None
        bare = read.topic
        row = {
            **self._conversation(read, replies, live),
            "kind": DOCUMENT, "document_kind": "goal" if bare == GOAL_TOPIC else "researchplan",
            "stem": None if bare == GOAL_TOPIC else bare[len(RESEARCHPLAN_PREFIX):],
            "title": title_of(current.content) if current else "",
            "versions": len(read.speech),
            "current": None if current is None else {**self._post(current), "title": title_of(current.content)},
            # A document is not executable work: nothing here starts anything,
            # and no mission is inferred to belong to it.
            "missions": [],
            "note": "a document: not executable work; discuss how to proceed with Front",
        }
        if full and current is not None:
            row["current"]["content"] = shown_content(current.content)
        return row

    def _task_row(self, task: Task, replies, live: bool, *, full: bool) -> dict:
        read: Read | None = getattr(task, "tasks_read", None)
        doc = None
        if read is not None and task.document_id is not None:
            doc = next((m for m in read.messages if m.id == task.document_id), None)
        row = {
            "kind": TASK, "anchor": task.anchor_id, "label": task.label, "serial": task.serial,
            "mission": task.mission_id, "state": task.state, "finished": task.finished,
            "replaces": task.replaces, "by": task.by,
            "document": None if doc is None else {**self._post(doc), "title": title_of(doc.content)},
        }
        if read is not None:
            row.update(self._conversation(read, replies, live))
        else:
            row.update({"channel": task.channel, "topic": task.topic, "live_topic": task.topic, "resolved": False,
                        "posts": 0, "last_post": None, "first_post": None,
                        "read": {"complete": False, "note": "the conversation is not held"},
                        "reply": {"state": "unknown", "evidence": "the conversation is not held", "rows": []},
                        "origins": [], "links": [], "zulip_url": None})
        if full and doc is not None:
            row["document"]["content"] = shown_content(doc.content)
        return row

    def _mission_row(self, read: Read, derived: dict, replies, live: bool, *, full: bool) -> dict:
        mission: Mission = read.record  # type: ignore[assignment]
        found = sorted(derived["tasks"].get(mission.anchor_id, []), key=lambda t: (t.serial, t.anchor_id))
        work_name = work_channel_name(mission.anchor_id)
        work = derived["work_channels"].get(work_name)
        if work is None:
            work_read = {"complete": False, "channel": work_name,
                         "note": "no work channel of that name is in the realm: none opened yet, or it was deleted"}
        elif work.archived:
            work_read = {"complete": False, "channel": work_name,
                         "note": "the work channel is archived: its conversations are not mirrored, so tasks here may be missing"}
        else:
            work_read = {"complete": True, "channel": work_name, "note": None}
        live_tasks = [t for t in found if t.state != TASK_CANCELLED]
        counts = {
            "total": len(found), "live": len(live_tasks),
            "finished": sum(1 for t in live_tasks if t.state in TASK_FINISHED),
            "completed": sum(1 for t in found if t.state == TASK_COMPLETED),
            "accepted": sum(1 for t in found if t.state == TASK_ACCEPTED),
            "cancelled": sum(1 for t in found if t.state == TASK_CANCELLED),
            "open": sum(1 for t in live_tasks if t.state not in TASK_FINISHED),
        }
        doc = next((m for m in read.messages if m.id == mission.document_id), None) if mission.document_id else None
        replaced_by = derived["replaced_by"].get(mission.anchor_id)
        row = {
            **self._conversation(read, replies, live),
            "kind": MISSION, "setup": read.topic.startswith(SETUP_PREFIX),
            "anchor": mission.anchor_id, "label": mission.label, "slug": mission.slug, "by": mission.by,
            "work": {"state": mission.state,
                     "note": ("recorded by autolab; `started` does not prove a process is running"
                              if mission.state not in (MISSION_DONE,) else
                              "marked done by whoever accepted it")},
            "replaces": mission.replaces, "replaced_by": replaced_by,
            "document": None if doc is None else {**self._post(doc), "title": title_of(doc.content)},
            "tasks": [self._task_row(t, replies, live, full=full) for t in found],
            "task_counts": counts, "tasks_read": work_read,
            "gaps": [],
        }
        if read.resolved and mission.state in (MISSION_PLANNED, "started"):
            row["gaps"].append({"kind": "resolved-unfinished",
                                "text": f"the conversation carries ✔ while the recorded state is `{mission.state}`: "
                                        "closed without a recorded end"})
        if not found and work_read["complete"]:
            row["gaps"].append({"kind": "no-task", "text": "no task is recorded for this mission"})
        if not found and not work_read["complete"]:
            row["gaps"].append({"kind": "tasks-unknown", "text": work_read["note"]})
        if doc is None:
            row["gaps"].append({"kind": "no-document", "text": "no `[doc]` note names a current plan document"})
        if full and doc is not None:
            row["document"]["content"] = shown_content(doc.content)
        return row

    def _setup_row(self, read: Read, replies, live: bool) -> dict:
        return {**self._conversation(read, replies, live), "kind": SETUP,
                "note": "workspace preparation: autolab replies when the folders exist and plans no mission"}

    def _plan_row(self, read: Read, replies, live: bool) -> dict:
        return {**self._conversation(read, replies, live), "kind": PLAN, "recorded": False,
                "note": "a workplan- conversation with no `[mission]` note: planned before the conversation "
                        "became the record, or not answered yet"}

    def _project(self, stream_id: int, derived: dict, replies, live: bool, now: float, *, full: bool) -> dict:
        project = derived["projects"][stream_id]
        channel = project["channel"]
        reads: dict[str, Read] = project["reads"]
        documents, setups, missions, plans, others = [], [], [], [], []
        for bare in sorted(reads):
            read = reads[bare]
            shape = classify(bare, read.record)
            if shape == DOCUMENT:
                documents.append(self._document_row(read, replies, live, full=full))
            elif shape == MISSION:
                missions.append(self._mission_row(read, derived, replies, live, full=full))
            elif shape == SETUP:
                setups.append(self._setup_row(read, replies, live))
            elif shape == PLAN:
                plans.append(self._plan_row(read, replies, live))
            elif shape == TASK:
                # A task anchored in the project channel itself is a real
                # shape; it is listed with the orphans below by its mission.
                others.append({"topic": bare, "kind": TASK})
            else:
                others.append({"topic": bare, "kind": OTHER, "resolved": read.resolved})
        orphans = [self._task_row(o["task"], replies, live, full=full)
                   for o in derived["orphans"] if o["project_id"] == stream_id]
        missions.sort(key=lambda m: m["anchor"])
        every = [*documents, *setups, *missions, *plans, *orphans]
        # A task's post is the project's activity too; tasks sit inside their mission.
        spoken = [*every, *(t for m in missions for t in m["tasks"])]
        latest_where = max((c for c in spoken if c.get("last_post")), key=lambda c: c["last_post"]["at"], default=None)
        latest = latest_where["last_post"] if latest_where else None
        open_missions = [m for m in missions
                         if m["work"]["state"] not in ("done", "cancelled", "replaced") and not m["resolved"]]
        gaps: list[dict] = []
        if project["archived"]:
            gaps.append({"kind": "archived", "text": "the channel is archived: its conversations are not mirrored"})
        else:
            if not documents:
                gaps.append({"kind": "no-document", "text": "no goal or research plan document is posted"})
            real_missions = [m for m in missions if not m["setup"]]
            if setups and not real_missions and not plans:
                gaps.append({"kind": "setup-only",
                             "text": "setup only: the workspace was prepared and no mission has been asked for"})
            elif (project["kind"] == "study" or any(d["document_kind"] == "researchplan" for d in documents)) \
                    and not real_missions and not plans and documents:
                gaps.append({"kind": "no-mission",
                             "text": "a research plan alone is not executable work: no mission has been asked for"})
            elif not real_missions and not plans and not setups and documents:
                gaps.append({"kind": "no-mission", "text": "a purpose document and no plan or mission yet"})
        tasks_total = sum(m["task_counts"]["total"] for m in missions)
        tasks_finished = sum(m["task_counts"]["finished"] for m in missions)
        incomplete = [m["label"] for m in missions if not m["tasks_read"]["complete"]]
        reply_states = [c["reply"]["state"] for c in every if c.get("reply")]
        lead = min(reply_states, key=lambda s: REPLY_ORDER.get(s, 9), default="quiet")
        row = {
            "key": str(stream_id), "stream_id": stream_id, "channel": channel.name, "slug": project["slug"],
            "folder_id": channel.folder_id, "archived": project["archived"], "kind": project["kind"],
            "description": project["description"],
            "origin": None if project["origin"] is None else {
                **project["origin"], "anchor": self._argue_anchor(project["origin"]),
                "zulip_url": self._narrow(project["origin"]["channel"], project["origin"]["topic"])},
            "zulip_url": self._narrow(channel.name, None),
            "counts": {
                "documents": len(documents), "setups": len(setups), "missions": len(missions),
                "open_missions": len(open_missions), "plans_unrecorded": len(plans), "orphan_tasks": len(orphans),
                "tasks": tasks_total, "tasks_finished": tasks_finished, "other_topics": len(others),
                "missions_by_state": _count_by(m["work"]["state"] for m in missions),
            },
            "tasks_read": {"complete": not incomplete and not project["archived"],
                           "incomplete_missions": incomplete},
            "latest": None if latest is None else {**latest, "channel": latest_where["channel"],
                                                   "topic": latest_where["topic"], "kind": latest_where["kind"]},
            "reply": {"state": lead if reply_states else ("unknown" if project["archived"] else "quiet")},
            "gaps": gaps,
            "documents": documents if full else [
                {k: d[k] for k in ("topic", "document_kind", "stem", "title", "versions", "resolved", "last_post")}
                for d in documents],
        }
        if full:
            row.update({"setups": setups, "missions": missions, "plans": plans, "orphan_tasks": orphans,
                        "other_topics": others})
        else:
            row["missions"] = [{k: m[k] for k in ("anchor", "label", "topic", "resolved", "setup", "work",
                                                  "task_counts", "tasks_read", "last_post", "reply", "replaces",
                                                  "replaced_by", "gaps")}
                               | {"title": (m["document"] or {}).get("title", "")} for m in missions]
            row["setups"] = [{k: s[k] for k in ("topic", "resolved", "last_post", "reply")} for s in setups]
            row["plans"] = [{k: p[k] for k in ("topic", "resolved", "last_post", "reply")} for p in plans]
        return row

    # -- what the view reads ------------------------------------------------------------

    def _health(self) -> dict:
        health = health_block(self.mirror)
        return health

    def board(self, now: float | None = None) -> dict:
        """Every project channel, live and archived, with its shape counted."""
        now = time.time() if now is None else now
        health = self._health()
        if self.mirror is None:
            return {"schema": SCHEMA, "generated_at": now, "health": health, "projects": [],
                    "note": "no mirror: nothing can be read"}
        derived = self.refresh()
        replies, live = self._reply_rows(now)
        rows = [self._project(stream_id, derived, replies, live, now, full=False)
                for stream_id in derived["projects"]]
        rows.sort(key=lambda r: (r["archived"], -((r["latest"] or {}).get("at") or 0), r["channel"]))
        return {"schema": SCHEMA, "generated_at": now, "health": health,
                "stale": health["state"] != "live", "projects": rows,
                "counts": {"projects": len(rows), "live": sum(1 for r in rows if not r["archived"]),
                           "archived": sum(1 for r in rows if r["archived"])}}

    def _resolve_key(self, key) -> int | dict:
        derived = self.refresh()
        text = str(key or "").strip()
        if text.isdigit() and int(text) in derived["projects"]:
            return int(text)
        name = text if text.startswith(PROJECT_PREFIX) else f"{PROJECT_PREFIX}{text}"
        if name in derived["by_name"]:
            return derived["by_name"][name]
        return {"error": f"no project channel is known as {key!r} (a stream id, a channel name or a slug)"}

    def project(self, key, now: float | None = None) -> dict:
        """One project whole: documents with their text, setups, missions with
        their tasks and plan documents, unrecorded plans, orphan tasks."""
        now = time.time() if now is None else now
        health = self._health()
        if self.mirror is None:
            return {"error": "no mirror: nothing can be read", "health": health}
        found = self._resolve_key(key)
        if isinstance(found, dict):
            return found
        derived = self.refresh()
        replies, live = self._reply_rows(now)
        return {"schema": SCHEMA, "generated_at": now, "health": health, "stale": health["state"] != "live",
                "project": self._project(found, derived, replies, live, now, full=True)}

    def work_row(self, anchor: int, now: float | None = None) -> dict | None:
        """One mission or task row, whole, by its anchor (for the talk door)."""
        now = time.time() if now is None else now
        found = self.locate_work(anchor)
        if found is None:
            return None
        derived = self.refresh()
        replies, live = self._reply_rows(now)
        if found["kind"] == MISSION:
            return self._mission_row(found["read"], derived, replies, live, full=True)
        return self._task_row(found["record"], replies, live, full=True)

    def locate_work(self, anchor) -> dict | None:
        """The mission or task a work anchor names, with the project it belongs
        to — for the conversation routes (step 2). None when no record wears
        that id."""
        derived = self.refresh()
        try:
            ident = int(anchor)
        except (TypeError, ValueError):
            return None
        held = derived["missions"].get(ident)
        if held is not None:
            stream_id, read = held
            return {"kind": MISSION, "project_id": stream_id, "read": read, "record": read.record}
        for mission_id, found in derived["tasks"].items():
            for task in found:
                if task.anchor_id == ident:
                    parent = derived["missions"].get(mission_id)
                    project_id = parent[0] if parent else next(
                        (o["project_id"] for o in derived["orphans"] if o["task"].anchor_id == ident), None)
                    return {"kind": TASK, "project_id": project_id, "read": getattr(task, "tasks_read", None),
                            "record": task, "mission": parent[1].record if parent else None}
        return None


def _count_by(values) -> dict[str, int]:
    found: dict[str, int] = {}
    for value in values:
        found[value] = found.get(value, 0) + 1
    return dict(sorted(found.items()))
