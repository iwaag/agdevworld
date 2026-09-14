"""Completing a request: the plan, and carrying it out.

`closing.py` answers *what* finishing the selected request would touch.
This module answers *what would change*, and — on a second, explicit
request — changes it. The request is any conversation `closing.classify`
accepts as a root, named by channel and topic; the Front Desk's
`front-desk-<id>` is one caller of it (`Closer.desk_key`), the operation
room's routine runs and the agent room's conversations are the others
(`front_desk` p4).

**The human's click is the acceptance.** Nothing here judges whether the
work was any good; it decides only whether each target is in a state this
operation may move, and it decides that by counting:

- a **work record** may be closed when its own agent's rule says it is
  finished — autolab's mission when every one of its live tasks is
  completed (`autolab.reason_not_finished`), forge's request when something
  has been delivered (`forge.reason_not_accepted`). Two lifecycles, each the
  writer's own and neither re-invented here. An already-accepted record is a
  successful no-op; a cancelled or retired one is left exactly as it is;
  anything else is **blocked**, says so, and holds its own conversations
  open (`_hold_dependents`).
- a **topic** may be resolved when the walk actually read it. A topic known
  only by the note that named it is a gap, not a finished conversation.
- a **channel** may be archived when it is `work-<label>` for a mission of
  this conversation and every topic it actually holds is one of these
  targets (`closing._channels`). The shared `#front`, project and agent
  channels are never candidates.

**Order matters and is fixed**: the work records first, then the related
topics, then the dedicated channels, then the Front conversation itself.
Resolving the Front topic last is what makes a half-finished run visible —
if anything related is blocked or failed, the Front conversation **stays
open**, which is the only way the screen can honestly say "partially
closed". Records first is also what lets a failed acceptance hold back the
conversations it is about in the same pass.

**The browser never names a destination.** A request carries the selected
conversation and the fingerprint of the preview the human looked at. Since
`better_zulip_call` p1 step 4 the preview is **remembered** with what it
depends on — every conversation it reached and every channel whose listing
it consulted — and a close **reuses** it when the mirror shows none of that
moved, rather than walking the graph again. The fingerprint is the human's
decision token, never a freshness check: before anything is written the
scoped channels' listings are read from Zulip once each (event lag is
possible, and an unchanged local revision proves nothing about the realm),
whatever moved is hydrated, and a plan that changed is a refusal with the
fresh one rather than a write against a stale picture.

**Retrying is re-running.** Every action is idempotent in the realm's own
terms — a resolved topic resolves to `already`, an accepted record to
`already` — so a second click after a partial failure repeats nothing and
finishes what is left. The post-write answer is built from the results and
the mirror's confirmation of them, not from a third walk; a retry reads the
copy, which now carries what was written. The operation record kept here is
for the screen, not for correctness.

This operation closes work. It does not stop a running agent, and it says
so rather than implying otherwise.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from hashlib import sha256
from typing import Any, Callable, Protocol

from agag.selfnote import note as selfnote
from agag.zulip import ZulipClient, live_topic_name

from .autolab import (
    ALREADY_DONE,
    MISSION_DONE,
    MISSION_REPLACED,
    Mission as AutolabMission,
    STATE_TAG,
    TASK_ACCEPTED,
    TASK_CANCELLED,
    Task as AutolabTask,
    WORK_CHANNEL_PREFIX,
    reason_not_finished,
    work_channel_name,
)
from .closing import AUTOLAB_SOURCE, Discovery, Key, Realm, WorkTarget, discover
from .forge import (
    ALREADY_ACCEPTED,
    REQUEST_ACCEPTED,
    REQUEST_RETIRED,
    STATE_TAG as FORGE_STATE_TAG,
    Request as ForgeRequest,
    Run as ForgeRun,
    reason_not_accepted,
)
from .frontdesk import FRONT_CHANNEL, ID_PATTERN, desk_topic
from .room import bare_topic

SCHEMA = "ag.completion.v1"
#: A channel or topic name this door will look up: Zulip's own limits, so a
#: request cannot make the relay build a narrow out of anything else.
NAME_MAX = 200
#: What an action may be before it runs.
READY, DONE, BLOCKED, KEPT = "ready", "done", "blocked", "kept"
#: What it was after.
APPLIED, ALREADY, FAILED, SKIPPED = "applied", "already", "failed", "skipped"
#: Operations remembered for the screen, newest last.
RECORD_MEMORY = 20
#: How long the answer waits for the mirror to carry the writes back. Zulip
#: delivers an event within a second of the write on this realm; the wait is
#: bounded because a stale mirror must not hold a completion hostage.
CONFIRM_SECONDS = 5.0

__all__ = [
    "ALREADY", "APPLIED", "Action", "BLOCKED", "Closer", "DONE", "FAILED", "KEPT",
    "READY", "SCHEMA", "SKIPPED", "dependents", "fingerprint", "parse_key",
    "plan_actions",
]


def parse_key(channel: object, topic: object) -> Key | dict:
    """`(channel, bare topic)` from what a request named, or the refusal.

    A ✔ name is accepted and read bare, so a link copied from a resolved
    topic still names the same conversation.
    """
    if not isinstance(channel, str) or not isinstance(topic, str):
        return {"error": "channel and topic must both be strings"}
    channel, topic = channel.strip(), bare_topic(topic.strip())
    if not channel or not topic:
        return {"error": "channel and topic must both be named"}
    if len(channel) > NAME_MAX or len(topic) > NAME_MAX:
        return {"error": f"channel and topic are at most {NAME_MAX} characters"}
    if any(ch in channel for ch in "\n\r") or any(ch in topic for ch in "\n\r"):
        return {"error": "channel and topic are one line each"}
    return (channel, topic)


@dataclass
class Action:
    """One thing this operation would do, or would not, and why."""

    #: `work`, `topic`, `channel` or `conversation`.
    kind: str
    #: Stable across previews and retries: what a result is matched to.
    key: str
    label: str
    state: str
    reason: str
    detail: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {"kind": self.kind, "key": self.key, "label": self.label,
                "state": self.state, "reason": self.reason, "detail": self.detail}


@dataclass
class Plan:
    """One preview, remembered: what it decided and what it rested on.

    `evidence` is `(live name, last post id, resolved)` per conversation the
    walk reached or excluded; `listings` is every channel whose topic
    names the walk consulted, with the names it saw. Both are compared
    against the mirror before the plan is reused, and the channels are what
    the pre-write revalidation reads.
    """

    key: Key
    fingerprint: str
    revision: int
    found: Discovery
    actions: list[Action]
    evidence: dict[Key, tuple[str, int, bool]]
    listings: dict[str, frozenset[str]]
    at: float
    zulip_calls: int = 0


def _work_action(work: WorkTarget) -> Action:
    """One work record, judged by its own agent's rule.

    One question — *is this finished?* — and two different right answers,
    because the two agents do different work. The rule is the writer's in
    both cases and is never re-invented here.
    """
    return (_autolab_action(work) if work.source == AUTOLAB_SOURCE
            else _forge_action(work))


def _autolab_action(work: WorkTarget) -> Action:
    """One autolab mission, judged from the conversations it is made of.

    `autolab.reason_not_finished` is `agautolab.mission_done`'s rule, and
    what this operation would *write* is what makes the three things the
    plan asks to keep apart actually distinct in the record:

    - a task is `completed` by the **run** that did it — execution success,
      already written, never written here;
    - a task becomes `accepted` and its mission `done` when the **human**
      clicks — this operation, and the only thing that writes those words;
    - the ✔ on each topic is neither: it closes the **conversation**, and it
      happens afterwards as its own action.

    A task orphaned from its mission is shown and never moved: accepting one
    piece of a request nobody here can see the whole of is not this button's
    decision to make.
    """
    detail = {**work.as_dict(),
              "unreached_children": [row["label"] for row in work.children
                                     if not row.get("reached", True)]}
    label = f"{work.label} {work.title}".strip()
    if work.role != "mission":
        return Action("work", work.key, label, KEPT,
                      f"kept — this task's mission ({work.parent_id}) is not part of this "
                      "request, so nothing here decides whether it is accepted", detail)
    tasks = [
        AutolabTask(anchor_id=int(row.get("anchor_id") or 0), mission_id=work.anchor_id,
                    serial=int(row.get("serial") or 0), channel=str(row.get("channel") or ""),
                    topic=str(row.get("topic") or ""), state=str(row.get("state") or ""))
        for row in work.children
    ]
    mission = AutolabMission(anchor_id=work.anchor_id, slug="", channel=work.channel,
                             topic=work.topic, state=work.state)
    reason = reason_not_finished(mission, tasks)
    live = [task for task in tasks if task.state != TASK_CANCELLED]
    if reason is None:
        return Action("work", work.key, label, READY,
                      f"every one of its {len(live)} tasks is finished; accepting them and "
                      "marking the mission done", detail)
    if reason == ALREADY_DONE:
        return Action("work", work.key, label, DONE,
                      "already done; closing it again changes nothing", detail)
    if reason == "it is cancelled":
        return Action("work", work.key, label, KEPT,
                      "cancelled: this operation never moves a cancelled mission", detail)
    if mission.state == MISSION_REPLACED:
        return Action("work", work.key, label, KEPT, f"kept — {reason}", detail)
    return Action("work", work.key, label, BLOCKED, reason, detail)


def _forge_action(work: WorkTarget) -> Action:
    """One forge request, judged from the conversations it is made of.

    `forge.reason_not_accepted` is forge's lifecycle, not autolab's counting
    rule: what finishes a request is that **something was delivered**, not
    that every run of it completed. A second attempt after a failure is the
    same request trying again.

    What this operation would *write* keeps the same three things apart that
    `refactor` p1 separated for autolab:

    - the generation succeeded and the asset reached the requester — the
      **run** said so, in both conversations, and it is never written here;
    - a person accepted it — this operation, `[state] accepted`, and the only
      thing that writes that word;
    - the ✔ on each topic is neither, and happens afterwards.

    A run orphaned from its request is shown and never moved.
    """
    detail = {**work.as_dict(), "unreached_children": []}
    label = f"{work.label} {work.title}".strip()
    if work.role != "request":
        return Action("work", work.key, label, KEPT,
                      f"kept — this run's request ({work.parent_id}) is not part of this "
                      "request, so nothing here decides whether it is accepted", detail)
    runs = [
        ForgeRun(anchor_id=int(row.get("anchor_id") or 0), request_id=work.anchor_id,
                 channel=str(row.get("channel") or ""), topic=str(row.get("topic") or ""),
                 state=str(row.get("state") or ""))
        for row in work.children
    ]
    request = ForgeRequest(anchor_id=work.anchor_id, stem=work.title, channel=work.channel,
                           topic=work.topic, state=work.state)
    reason = reason_not_accepted(request, runs)
    if reason is None:
        return Action("work", work.key, label, READY,
                      "its asset was delivered; accepting it", detail)
    if reason == ALREADY_ACCEPTED:
        return Action("work", work.key, label, DONE,
                      "already accepted; accepting it again changes nothing", detail)
    if request.state == REQUEST_RETIRED:
        return Action("work", work.key, label, KEPT, f"kept — {reason}", detail)
    return Action("work", work.key, label, BLOCKED, reason, detail)


def dependents(action: Action) -> set[str]:
    """The action keys whose closure this work record decides.

    A work record is the answer to *is this finished?*, and the
    conversations it is made of are the place the unfinished part is still
    being worked. So a blocked mission holds back its own plan topic, the
    topic of every task under it, and the dedicated `work-` channel named
    after it — closing those would archive a conversation somebody still has
    to post in, which is the defect `refactor` p1 recorded and left standing.

    Keys, not coordinates, because that is what a result row is matched to
    and what `_apply` walks. A record names its channel by its label and by
    the anchor id that *is* it; both are asked for, and a name that matches
    no target simply holds nothing — forge keeps no dedicated channel, so
    its requests hold their conversations and nothing else.
    """
    detail = action.detail
    keys: set[str] = set()
    pairs = [(str(detail.get("channel") or ""), str(detail.get("topic") or ""))]
    pairs += [(str(row.get("channel") or ""), str(row.get("topic") or ""))
              for row in detail.get("children") or []]
    for channel, topic in pairs:
        if channel and topic:
            keys.add(f"topic:{channel}/{topic}")
    label = str(detail.get("label") or "").strip()
    if label:
        keys.add(f"channel:{WORK_CHANNEL_PREFIX}{label}")
    anchor_id = int(detail.get("anchor_id") or 0)
    if anchor_id:
        keys.add(f"channel:{work_channel_name(anchor_id)}")
    return keys


def _hold_dependents(actions: list[Action]) -> None:
    """Keep open what a blocked work record is still about.

    Only a `READY` target is moved, and only a topic or a channel: an
    already-✔ topic stays `DONE` (there is nothing to hold), and the
    selected request's own conversation is held by `_apply`'s rule instead,
    because *anything* left undone keeps that one open. An independent
    branch of the same request — another mission, forge's Work, a topic no
    blocked record names — is untouched and still closes.
    """
    held: dict[str, str] = {}
    for action in actions:
        if action.kind != "work" or action.state != BLOCKED:
            continue
        for key in dependents(action):
            held.setdefault(key, action.label)
    for action in actions:
        if action.state != READY or action.kind not in {"topic", "channel"}:
            continue
        label = held.get(action.key)
        if label is None:
            continue
        action.state = KEPT
        action.reason = (f"kept — {label} is not finished, so this stays open for the rest of "
                         "the work; complete it and close the request again")


def plan_actions(found: Discovery) -> list[Action]:
    """Every action, in the order execution applies them.

    The work records first — so a blocked or failed one can hold back what
    it is about — then the related topics, then the dedicated channels, then the selected request
    itself, last so that anything left undone keeps it open.

    A root that may not be completed (an execution topic, a standing
    request, an introduction) is one blocked action carrying the scope's
    reason: the panel shows why, and there is nothing to approve.

    A blocked work record then holds back what it is *about*
    (`_hold_dependents`): unfinished work stays reachable, and its channel
    is not archived out from under it.
    """
    scope = found.scope
    if not scope.closable:
        return [Action("conversation", f"topic:{found.root[0]}/{found.root[1]}",
                       f"#{found.root[0]} › {found.root[1]}", BLOCKED, scope.reason,
                       {"parents": scope.parents, "kind": scope.kind})]
    actions: list[Action] = [_work_action(work) for work in found.works]

    for node in found.topics:
        if (node.channel, node.topic) == found.root:
            continue
        key = f"topic:{node.channel}/{node.topic}"
        label = f"#{node.channel} › {node.topic}"
        if node.resolved:
            actions.append(Action("topic", key, label, DONE, "already ✔", node.as_dict()))
        elif node.channel_archived:
            actions.append(Action("topic", key, label, KEPT,
                                  f"kept — #{node.channel} is archived: the realm refuses to move "
                                  "its posts, and nothing there is open to anybody", node.as_dict()))
        elif node.known == "note-only" or not node.last_post_id:
            actions.append(Action("topic", key, label, BLOCKED,
                                  "this topic could not be read, so nothing here says it is "
                                  "finished", node.as_dict()))
        elif node.twin:
            actions.append(Action("topic", key, label, READY, _twin_reason(node), node.as_dict()))
        else:
            actions.append(Action("topic", key, label, READY, "will be marked ✔", node.as_dict()))

    for row in found.channels:
        key = f"channel:{row['channel']}"
        label = f"#{row['channel']}"
        if row.get("archived"):
            actions.append(Action("channel", key, label, DONE, row["reason"], row))
        elif row["archivable"]:
            actions.append(Action("channel", key, label, READY,
                                  f"will be archived — {row['reason']}", row))
        else:
            actions.append(Action("channel", key, label, KEPT,
                                  f"kept — {row['reason']}", row))

    root = next((node for node in found.topics if (node.channel, node.topic) == found.root), None)
    key = f"topic:{found.root[0]}/{found.root[1]}"
    label = f"#{found.root[0]} › {found.root[1]}"
    if root is not None and root.resolved:
        actions.append(Action("conversation", key, label, DONE, "already ✔",
                              root.as_dict() if root else {}))
    elif root is None or not root.last_post_id:
        actions.append(Action("conversation", key, label, BLOCKED,
                              "this conversation has no post to resolve" if root is None
                              or root.known != "note-only" else
                              "this conversation could not be read", {}))
    elif root.twin:
        actions.append(Action("conversation", key, label, READY,
                              _twin_reason(root) + ", once everything above is done",
                              root.as_dict()))
    else:
        actions.append(Action("conversation", key, label, READY,
                              "will be marked ✔ once everything above is done", root.as_dict()))
    _hold_dependents(actions)
    return actions


def _twin_reason(node) -> str:
    """Why a topic that already carries a ✔ is still a target."""
    return (f"will be marked ✔ — {node.twin_posts} post{'s' if node.twin_posts != 1 else ''} "
            "made under the bare name after it was resolved opened a twin; folding it in")


def fingerprint(actions: list[Action]) -> str:
    """What the human looked at, in one string.

    Only the parts a decision rests on: which targets, and what state each
    was in. A new post in a related topic is not a different decision; a
    Work that has since been cancelled, or a target that has appeared, is.
    """
    material = "\n".join(f"{action.key}={action.state}" for action in sorted(
        actions, key=lambda one: one.key))
    return sha256(material.encode("utf-8")).hexdigest()[:16]


def _accept_mission(client: ZulipClient, detail: dict) -> str:
    """Write the human's acceptance into the conversations it is about.

    One `[selfnote][state]` note per topic, and they say different things on
    purpose: each finished task becomes `accepted`, and the mission becomes
    `done`. Appended, never edited — the sequence of notes is the history of
    the work, and this is the entry that says a person looked at it.

    A selfnote, so nobody is served by it: writing the record must not buy a
    run. Written under each topic's **live** name, because a task topic is
    very often already resolved by the run that finished it, and a post
    under the bare name of a ✔ topic opens a twin beside it.

    A task that was cancelled is left alone: it was called off, and
    accepting it would say a person approved work nobody did. Whatever
    fails here raises, and `_apply` reports it against this one target.
    """
    moved = []
    for row in detail.get("children") or []:
        if str(row.get("state") or "") == TASK_CANCELLED:
            continue
        channel, topic = str(row.get("channel") or ""), str(row.get("topic") or "")
        if not channel or not topic:
            continue
        client.send_to_channel(channel, live_topic_name(client, channel, topic),
                               selfnote(STATE_TAG, TASK_ACCEPTED))
        moved.append(str(row.get("label") or topic))
    channel, topic = str(detail.get("channel") or ""), str(detail.get("topic") or "")
    if not channel or not topic:
        raise RuntimeError("this mission's conversation is not known, so nothing can be written")
    client.send_to_channel(channel, live_topic_name(client, channel, topic),
                           selfnote(STATE_TAG, MISSION_DONE))
    accepted = f"; accepted {', '.join(moved)}" if moved else ""
    return f"{detail.get('label')} is done{accepted}"


def _accept_request(client: ZulipClient, detail: dict) -> str:
    """Write the human's acceptance into the request it is about.

    One `[selfnote][state] accepted` note, in the request's conversation.
    Not in its runs: a run is an *attempt*, and a person accepting the asset
    is saying something about the request, not about each try that led to
    it. Appended, never edited, and a selfnote so nobody is served by it —
    writing the record must not buy a run.

    Written under the topic's **live** name, because a request's
    conversation is often already resolved by the time somebody accepts it,
    and a post under the bare name of a ✔ topic opens a twin beside it.
    Whatever fails here raises, and `_apply` reports it against this one
    target — and holds back the conversations it is about.
    """
    channel, topic = str(detail.get("channel") or ""), str(detail.get("topic") or "")
    if not channel or not topic:
        raise RuntimeError("this request's conversation is not known, so nothing can be written")
    client.send_to_channel(channel, live_topic_name(client, channel, topic),
                           selfnote(FORGE_STATE_TAG, REQUEST_ACCEPTED))
    keys = [str(key) for key in (detail.get("results") or []) if str(key).strip()]
    delivered = f"; its asset is {', '.join(keys)}" if keys else ""
    return f"{detail.get('label')} is accepted{delivered}"


@dataclass
class Closer:
    """The completion door: preview, and carry out.

    Both halves derive their targets the same way and from the same places.
    The realm read uses the relay's read credential; the writes use the
    Developer's (`AGENTROOM_CHAT_ZULIP_ENV`), which is the credential that
    already posts here — no new identity for an operation the browser's own
    user could perform by hand.
    """

    #: The ops engine's held topics, as a callable so a preview always sees
    #: the current memory rather than a snapshot taken at construction.
    topics: Callable[[], dict]
    reader_factory: Callable[[], ZulipClient] | None = None
    writer_factory: Callable[[], ZulipClient] | None = None
    #: The process's mirror (`better_zulip_call` p1). After the writes, the
    #: answer waits for the mirror to carry them back as events — briefly —
    #: and each result says whether the realm has confirmed it, so a pending
    #: write and a confirmed change are told apart rather than assumed equal.
    mirror: Any | None = None
    confirm_seconds: float = CONFIRM_SECONDS
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _locks: dict[Key, threading.Lock] = field(default_factory=dict, repr=False)
    _records: list[dict] = field(default_factory=list, repr=False)
    _reader: ZulipClient | None = field(default=None, repr=False)
    _writer: ZulipClient | None = field(default=None, repr=False)
    #: The last preview per root, with its dependencies (`Plan`).
    _plans: dict[Key, Plan] = field(default_factory=dict, repr=False)
    #: How many graph walks this door has made — the measurement step 4
    #: is about, so a test can say "one, not three".
    discoveries: int = 0

    # -- the Front Desk, as one caller -------------------------------------

    @staticmethod
    def desk_key(ident: str) -> Key | dict:
        """The conversation a Front Desk id names, or the refusal."""
        if not ID_PATTERN.match(ident or ""):
            return {"error": f"{ident!r} is not a Front Desk conversation id"}
        return (FRONT_CHANNEL, desk_topic(ident))

    # -- what is configured -------------------------------------------------

    def status(self) -> dict:
        """What this door can do, before a button is drawn for it.

        A missing credential is said here rather than discovered on submit:
        a preview that lists a Work it cannot move is a preview that lies.
        """
        return {
            "zulip_read": self.reader_factory is not None,
            "zulip_write": self.writer_factory is not None,
            "reason": ("" if self.reader_factory and self.writer_factory else
                       "this relay has no write credential, so nothing can be closed"
                       if self.reader_factory else
                       "this relay has no Zulip credential"),
        }

    def _reader_client(self) -> ZulipClient | None:
        if self._reader is None and self.reader_factory is not None:
            self._reader = self.reader_factory()
        return self._reader

    def _writer_client(self) -> ZulipClient | None:
        if self._writer is None and self.writer_factory is not None:
            self._writer = self.writer_factory()
        return self._writer

    def _zulip_calls(self) -> int:
        """What the mirror has spent on Zulip *for questions* so far —
        hydrations, verifies, listing refreshes — by purpose, so the ingest
        thread's own polling never counts against a preview. A discovery's
        cost is the difference across it. Without a mirror the reader is the
        realm itself and its own count is the answer."""
        if self.mirror is not None:
            ledger = self.mirror.health().get("ledger") or {}
            return sum(int(n) for key, n in ledger.items()
                       if key.split(" ", 1)[0] in ("hydrate", "verify"))
        reader = self._reader
        return int(getattr(reader, "calls", 0) or 0)

    def _conversation_lock(self, key: Key) -> threading.Lock:
        with self._lock:
            return self._locks.setdefault(key, threading.Lock())

    # -- the preview --------------------------------------------------------

    def plan(self, key: Key | dict, now: float | None = None) -> dict:
        """What closing this request would change, with the evidence.

        `key` is `(channel, topic)` or the refusal `parse_key`/`desk_key`
        answered instead, passed through so a caller can chain them. The
        plan is remembered; a second preview while nothing it depends on has
        moved is answered from memory without a walk.
        """
        now = time.time() if now is None else now
        if isinstance(key, dict):
            return key
        plan = self._current_plan(key, now)
        return self._payload(now, plan.found, plan.actions, plan=plan)

    # -- the remembered plan ----------------------------------------------------

    def _discover(self, key: Key, now: float) -> Plan:
        """One coherent walk, remembered with everything it rested on.

        Ingestion is deliberately not stopped while a preview is built. If a
        relevant change overlaps the walk, repeat it; unrelated traffic may
        advance the global revision without making the evidence incoherent.
        """
        realm: Realm | None = self._reader_client()
        spent = self._zulip_calls()
        while True:
            revision = self._revision()
            found = discover(self.topics(), key, realm=realm)
            self.discoveries += 1
            actions = plan_actions(found)
            evidence = self._evidence_of(found)
            listings = self._listings_of(found)
            if not self._dependencies_changed(revision, evidence, listings):
                break
        found.gaps["zulip_calls"] = self._zulip_calls() - spent
        # Keep the revision from before the walk. Advancing it to a newer
        # unrelated event would risk claiming that an event arriving after
        # the evidence read was part of the snapshot; `_unchanged()` can
        # cheaply inspect those extra feed entries later.
        plan = Plan(key=key, fingerprint=fingerprint(actions), revision=revision,
                    found=found, actions=actions, evidence=evidence,
                    listings=listings, at=now, zulip_calls=found.gaps["zulip_calls"])
        with self._lock:
            self._plans[key] = plan
        return plan

    def _current_plan(self, key: Key, now: float) -> Plan:
        """The remembered plan when the mirror shows nothing it depends on
        moved, else a fresh walk."""
        with self._lock:
            remembered = self._plans.get(key)
        if remembered is not None and self._unchanged(remembered):
            return remembered
        return self._discover(key, now)

    def _revision(self) -> int:
        return int(self.mirror.revision()) if self.mirror is not None else 0

    def _evidence_of(self, found: Discovery) -> dict[Key, tuple[str, int, bool]]:
        evidence: dict[Key, tuple[str, int, bool]] = {}
        for node in found.topics:
            evidence[node.key] = (node.live_topic, node.last_post_id, node.resolved)
        for row in found.excluded:
            evidence[(row["channel"], row["topic"])] = (row["live_topic"], 0, row["resolved"])
        return evidence

    def _listings_of(self, found: Discovery) -> dict[str, frozenset[str]]:
        """The channels whose topic names the walk depends on: every channel
        a reached conversation is in (the stem and seed rules read their
        listings), the dedicated `work-` channel of each mission, and the
        root's own — with the names the mirror holds for each now."""
        channels = {found.root[0]}
        channels.update(node.channel for node in found.topics)
        channels.update(row["channel"] for row in found.excluded)
        for work in found.works:
            if work.source == AUTOLAB_SOURCE and work.anchor_id:
                channels.add(work_channel_name(work.anchor_id))
        for row in found.channels:
            channels.add(row["channel"])
        return {channel: self._names_now(channel) for channel in sorted(channels)}

    def _names_now(self, channel: str) -> frozenset[str]:
        if self.mirror is None:
            return frozenset()
        return frozenset(t.live_name for t in self.mirror.topics(channel))

    def _unchanged(self, plan: Plan) -> bool:
        """Whether the mirror still shows every conversation and listing the
        plan rested on exactly as the plan saw them. Local, no Zulip call;
        without a mirror nothing can be compared and the plan is rebuilt."""
        mirror = self.mirror
        if mirror is None:
            return False
        if mirror.revision() == plan.revision:
            return True
        return not self._dependencies_changed(plan.revision, plan.evidence, plan.listings)

    def _dependencies_changed(self, revision: int,
                              evidence: dict[Key, tuple[str, int, bool]],
                              listings: dict[str, frozenset[str]]) -> bool:
        """Whether dependency evidence moved after ``revision``.

        The index tuple catches posts, moves and resolves. The change feed is
        also required: an edit or deletion of an older message changes the
        meaning of a conversation without changing its last id. A lost or
        truncated feed is uncertainty, so the remembered discovery is not
        reused.
        """
        mirror = self.mirror
        if mirror is None:
            return True
        for channel, names in listings.items():
            if self._names_now(channel) != names:
                return True
        for (channel, topic), (live, last_id, resolved) in evidence.items():
            found = mirror.topic(channel, topic)
            if not found:
                # Not listed: an archived channel's topic, which the mirror
                # hydrated on demand and holds, or a topic that is gone.
                held = mirror.messages(channel, topic)
                if (held[-1].id if held else 0) != last_id:
                    return True
                continue
            open_ones = [t for t in found if not t.resolved]
            now_live = (open_ones or found)[0].live_name
            now_last = max(t.last_id for t in found)
            now_resolved = not open_ones
            if (now_live, now_last, now_resolved) != (live, last_id, resolved):
                return True
        current = mirror.revision()
        changes = mirror.changes(revision)
        if changes is None:
            return True
        if current > revision and not changes:
            return True
        if changes and changes[-1].revision < current:
            return True
        relevant = {(channel, bare_topic(topic)) for channel, topic in evidence}
        for change in changes:
            if change.kind == "resync":
                return True
            if change.kind == "channel" and change.channel in listings:
                return True
            if (change.channel, bare_topic(change.topic)) in relevant:
                return True
            if change.kind == "move":
                old_topic = bare_topic(str(change.detail.get("from_topic") or ""))
                old_stream = change.detail.get("from_stream_id")
                old_channel = mirror.store.channel_by_id(int(old_stream)) if old_stream is not None else None
                if old_channel is not None and (old_channel.name, old_topic) in relevant:
                    return True
        return False

    def _revalidate(self, plan: Plan) -> dict:
        """The targeted reads before a write: one listing per channel the
        plan depends on, straight from Zulip, folded into the mirror. What
        the listings say moved is hydrated; the caller re-plans if anything
        did. Without a mirror there is nothing to fold into, and the reader
        is the realm itself — a fresh walk is the revalidation."""
        mirror = self.mirror
        if mirror is None:
            return {"channels": [], "changed": [], "zulip_calls": 0, "note": "no mirror; the plan was re-derived from the realm"}
        spent = self._zulip_calls()
        changed: list[tuple[str, str]] = []
        for channel in sorted(plan.listings):
            try:
                changed.extend(mirror.refresh_listing(channel))
            except Exception as error:  # noqa: BLE001 - a failed check is not a changed plan
                changed.append((channel, f"<unread: {type(error).__name__}: {error}>"))
        return {"channels": sorted(plan.listings), "changed": [f"{c}/{t}" for c, t in changed],
                "zulip_calls": self._zulip_calls() - spent}

    def _payload(self, now: float, found: Discovery, actions: list[Action],
                 results: list[dict] | None = None, plan: Plan | None = None) -> dict:
        ready = [action for action in actions if action.state == READY]
        blocked = [action for action in actions if action.state == BLOCKED]
        return {
            "schema": SCHEMA, "generated_at": now,
            "channel": found.root[0], "topic": found.root[1],
            "root": {"channel": found.root[0], "topic": found.root[1]},
            "scope": found.scope.as_dict(),
            "fingerprint": fingerprint(actions),
            # What the preview rests on, so a reader can see how wide the
            # pre-write check will be and how fresh the copy was.
            "depends_on": ({"revision": plan.revision, "channels": sorted(plan.listings),
                            "topics": len(plan.evidence), "planned_at": plan.at,
                            "walk_zulip_calls": plan.zulip_calls}
                           if plan is not None else None),
            "status": self.status(),
            "actions": [action.as_dict() for action in actions],
            "counts": {"ready": len(ready), "blocked": len(blocked),
                       "done": sum(1 for a in actions if a.state == DONE),
                       "kept": sum(1 for a in actions if a.state == KEPT)},
            "blocked": [action.as_dict() for action in blocked],
            "excluded": found.excluded,
            "gaps": found.gaps,
            "results": results or [],
            "history": self.records(found.root),
            "note": ("this closes work; it does not stop a running agent"),
        }

    # -- carrying it out ----------------------------------------------------

    def close(self, key: Key | dict, expected: str | None = None,
              now: float | None = None) -> dict:
        """Apply the plan, in order, and report every target's outcome.

        The remembered plan is reused when the mirror shows nothing it
        depends on moved; the scoped channels are then read from Zulip once
        each and whatever moved is folded in; a plan that changed under the
        human is answered with the new one and no write at all. `expected`
        is the preview the human approved.
        """
        now = time.time() if now is None else now
        if isinstance(key, dict):
            return key
        client = self._writer_client()
        if client is None:
            return {"error": self.status()["reason"], "status": self.status()}
        with self._conversation_lock(key):
            plan = self._current_plan(key, now)
            checked = self._revalidate(plan)
            if checked["changed"] or not self._unchanged(plan):
                plan = self._discover(key, now)
            if expected is not None and expected != plan.fingerprint:
                payload = self._payload(now, plan.found, plan.actions, plan=plan)
                payload["refused"] = True
                payload["revalidated"] = checked
                payload["error"] = ("the targets have changed since this preview was made; "
                                    "nothing was closed — read the refreshed plan and approve it")
                return payload
            revision = self._revision()
            results = self._apply(client, plan.actions)
            self._confirm(results, plan.actions, revision)
            with self._lock:
                self._records.append({"at": now, "channel": plan.key[0],
                                      "topic": plan.key[1], "kind": plan.found.scope.kind,
                                      "fingerprint": plan.fingerprint, "results": results,
                                      "revalidated": checked})
                del self._records[:-RECORD_MEMORY]
                # The plan is spent: a retry re-reads the copy, which now
                # carries what was written, and finds the rest.
                self._plans.pop(key, None)
            shown = self._after(plan.actions, results)
            payload = self._payload(now, plan.found, shown, results)
            payload["applied"] = True
            payload["revalidated"] = checked
            # "Partially closed" is judged on the request itself as much as on
            # the counts: an operation that kept the Front topic open because
            # something was blocked is partial even when the blocked target
            # has since gone out of the plan.
            root_kept = any(row["kind"] == "conversation" and row["outcome"] == SKIPPED
                            for row in results)
            payload["partial"] = (any(row["outcome"] == FAILED for row in results)
                                  or bool(payload["counts"]["blocked"]) or root_kept)
            return payload

    @staticmethod
    def _after(actions: list[Action], results: list[dict]) -> list[Action]:
        """The plan as it stands after the writes, from the results.

        No third walk: an applied target is done (and says whether the
        mirror has confirmed it), a failed one is ready again with the error
        as its reason, and everything skipped or already done is as it was.
        The fingerprint of this list is what a retry approves.
        """
        by_key = {row["key"]: row for row in results}
        shown: list[Action] = []
        for action in actions:
            row = by_key.get(action.key)
            if row is None:
                shown.append(action)
                continue
            if row["outcome"] == APPLIED:
                confirmed = row.get("confirmed")
                note = ("closed by this operation; the mirror has confirmed it" if confirmed
                        else "closed by this operation; the mirror has not carried it back yet"
                        if confirmed is False else "closed by this operation")
                shown.append(Action(action.kind, action.key, action.label, DONE, note, action.detail))
            elif row["outcome"] == FAILED:
                shown.append(Action(action.kind, action.key, action.label, READY,
                                    f"failed — {row['note']}; retry closes it", action.detail))
            else:
                shown.append(action)
        return shown

    def _confirm(self, results: list[dict], actions: list[Action], revision: int) -> None:
        """Wait, briefly, for the mirror to carry the writes back, and stamp
        every applied result `confirmed` (True / False); None without a
        mirror, and for anything that was not written."""
        mirror = self.mirror
        by_key = {action.key: action for action in actions}
        pending = [row for row in results if row["outcome"] == APPLIED]
        for row in results:
            row["confirmed"] = None
        if mirror is None or not pending:
            return
        deadline = time.time() + self.confirm_seconds
        while True:
            unconfirmed = [row for row in pending if not self._is_confirmed(row, by_key[row["key"]])]
            if not unconfirmed:
                break
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            revision = mirror.wait(revision, timeout=remaining)
        for row in pending:
            row["confirmed"] = self._is_confirmed(row, by_key[row["key"]])

    def _is_confirmed(self, row: dict, action: Action) -> bool:
        """Whether the store already shows what this write changed."""
        mirror = self.mirror
        detail = action.detail
        if action.kind in ("topic", "conversation"):
            found = mirror.topic(detail.get("channel", ""), detail.get("topic", ""))
            return bool(found) and all(t.resolved for t in found)
        if action.kind == "channel":
            found = mirror.channel(detail.get("channel", ""))
            return found is None or found.archived
        if action.kind == "work":
            word = MISSION_DONE if detail.get("source") == AUTOLAB_SOURCE else REQUEST_ACCEPTED
            tag = STATE_TAG if detail.get("source") == AUTOLAB_SOURCE else FORGE_STATE_TAG
            notes = mirror.notes(tag=tag, channel=detail.get("channel", ""))
            here = [n for n in notes if bare_topic(n.topic) == bare_topic(detail.get("topic", ""))]
            return bool(here) and here[-1].value == word
        return False

    def _apply(self, client: ZulipClient, actions: list[Action]) -> list[dict]:
        """Run the ready actions in order. Nothing rolls back.

        A failure stops nothing except the Front topic and whatever the
        failed target was *about*: the other targets are independent of one
        another, and leaving four of five closed with the fifth named is
        more useful than leaving all five open. Two exceptions. A work
        record whose acceptance failed holds back its own conversations and
        its dedicated channel, the same rule the preview applies to one it
        already knew was blocked — an unaccepted mission whose channel is
        archived leaves its unfinished task nowhere to continue. And the
        Front conversation, because its ✔ is the claim that the whole thing
        is finished.
        """
        results: list[dict] = []
        trouble = False
        #: Targets a work record that failed *here* is still about. The
        #: preview applied the same rule to what it already knew was
        #: blocked; a write that fails mid-operation is the same fact
        #: learned later, and the plan's order — work first — is what makes
        #: acting on it possible without a second pass.
        held: dict[str, str] = {}
        for action in actions:
            if action.state in {DONE, ALREADY}:
                results.append(self._result(action, ALREADY, action.reason))
                continue
            if action.state in {BLOCKED, KEPT}:
                trouble = trouble or action.state == BLOCKED
                results.append(self._result(action, SKIPPED, action.reason))
                continue
            if action.key in held:
                results.append(self._result(
                    action, SKIPPED,
                    f"kept open: {held[action.key]} could not be accepted, so the work it is "
                    "about is not finished; retry once that is resolved"))
                continue
            if action.kind == "conversation" and trouble:
                results.append(self._result(
                    action, SKIPPED,
                    "kept open: related work is still blocked or failed, and a ✔ here would "
                    "say the whole thing is finished"))
                continue
            try:
                note = self._run(client, action)
            except Exception as error:  # noqa: BLE001 - reported per target, never raised
                trouble = True
                if action.kind == "work":
                    for key in dependents(action):
                        held.setdefault(key, action.label)
                results.append(self._result(action, FAILED, f"{type(error).__name__}: {error}"))
                continue
            results.append(self._result(action, APPLIED, note))
        return results

    @staticmethod
    def _result(action: Action, outcome: str, note: str) -> dict:
        return {"key": action.key, "kind": action.kind, "label": action.label,
                "outcome": outcome, "note": note}

    def _run(self, client: ZulipClient, action: Action) -> str:
        if action.kind == "work":
            if action.detail.get("source") == AUTOLAB_SOURCE:
                return _accept_mission(client, action.detail)
            return _accept_request(client, action.detail)
        if action.kind == "channel":
            stream = client.stream_id(action.detail["channel"])
            client.archive_channel(int(stream))
            return f"#{action.detail['channel']} is archived"
        message_id = int(action.detail.get("last_post_id") or 0)
        if not message_id:
            raise RuntimeError("no message to rename: a topic is resolved by moving its posts")
        client.resolve_topic(message_id, action.detail["topic"])
        return f"{action.detail['topic']} is ✔"

    # -- for the screen -----------------------------------------------------

    def records(self, key: Key | None = None) -> list[dict]:
        """Operations this relay carried out, newest last, for one request
        or for all of them. Memory only: a restart forgets them, and the
        realm is the record that matters."""
        with self._lock:
            return [row for row in self._records
                    if key is None or (row["channel"], row["topic"]) == key]
