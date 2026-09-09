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

- a mission **Work** may be closed when every one of its live Sub-Works is
  completed. That is `agag.plane.reason_not_completed`, the same rule
  `agautolab.mission_done` applies, called here for one named Work instead
  of a whole board. A Work already Done is a successful no-op; a cancelled
  one is left exactly as it is; a Work with unfinished children, or a
  standalone Work with no children at all, is **blocked** and says so.
- a **topic** may be resolved when the walk actually read it. A topic known
  only by the note that named it is a gap, not a finished conversation.
- a **channel** may be archived when it is `work-<label>` for a mission of
  this conversation and every topic it actually holds is one of these
  targets (`closing._channels`). The shared `#front`, project and agent
  channels are never candidates.

**Order matters and is fixed**: Plane first, then the related topics, then
the dedicated channels, then the Front conversation itself. Resolving the
Front topic last is what makes a half-finished run visible — if anything
related is blocked or failed, the Front conversation **stays open**, which
is the only way the screen can honestly say "partially closed".

**The browser never names a destination.** A request carries the selected
conversation and the fingerprint of the preview the human looked at; every
target is re-derived here from the realm and from Plane, and a material
change since the preview is a refusal with a fresh plan rather than a write
against a stale picture.

**Retrying is re-running.** Every action is idempotent in the realm's own
terms — a resolved topic resolves to `already`, a Done Work to `already` —
so a second click after a partial failure repeats nothing and finishes what
is left. The operation record kept here is for the screen, not for
correctness.

This operation closes work. It does not stop a running agent, and it says
so rather than implying otherwise.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from hashlib import sha256
from typing import Any, Callable, Protocol

from agag.plane import ALREADY_COMPLETED, reason_not_completed, sub_works
from agag.zulip import ZulipClient

from .closing import Discovery, Key, PlaneBoard, Realm, WorkTarget, discover
from .frontdesk import FRONT_CHANNEL, ID_PATTERN, desk_topic
from .room import bare_topic

SCHEMA = "ag.completion.v1"
#: A channel or topic name this door will look up: Zulip's own limits, so a
#: request cannot make the relay build a narrow out of anything else.
NAME_MAX = 200
#: Plane's state groups, used as their own mapping so the shared rule can be
#: asked about a target whose states were already reduced to their groups by
#: discovery. One rule, two shapes of input.
GROUP_IDENTITY = {name: name for name in
                  ("backlog", "unstarted", "started", "completed", "cancelled", "unknown")}
#: What an action may be before it runs.
READY, DONE, BLOCKED, KEPT = "ready", "done", "blocked", "kept"
#: What it was after.
APPLIED, ALREADY, FAILED, SKIPPED = "applied", "already", "failed", "skipped"
#: Operations remembered for the screen, newest last.
RECORD_MEMORY = 20

__all__ = [
    "ALREADY", "APPLIED", "Action", "BLOCKED", "Closer", "DONE", "FAILED", "KEPT",
    "READY", "SCHEMA", "SKIPPED", "fingerprint", "parse_key", "plan_actions",
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


def _work_action(work: WorkTarget) -> Action:
    """One Plane Work, judged by the shared parent/child rule."""
    issue = {"id": work.issue_id, "state": work.state_group}
    children = sub_works(
        [{"id": row["issue_id"], "parent": work.issue_id, "state": row["state"],
          "sequence_id": index} for index, row in enumerate(work.children)],
        work.issue_id, GROUP_IDENTITY,
    )
    reason = reason_not_completed(issue, children, GROUP_IDENTITY)
    detail = {**work.as_dict(),
              "unreached_children": [row["label"] for row in work.children if not row["reached"]]}
    label = f"{work.label} {work.title}".strip()
    if reason is None:
        return Action("work", f"work:{work.issue_id}", label, READY,
                      f"every one of its {len(children)} sub-works is completed", detail)
    if reason == ALREADY_COMPLETED:
        return Action("work", f"work:{work.issue_id}", label, DONE,
                      "already Done; closing it again changes nothing", detail)
    if reason == "cancelled":
        return Action("work", f"work:{work.issue_id}", label, KEPT,
                      "cancelled: this operation never moves a cancelled Work", detail)
    return Action("work", f"work:{work.issue_id}", label, BLOCKED, reason, detail)


def plan_actions(found: Discovery) -> list[Action]:
    """Every action, in the order execution applies them.

    Plane first — a Work is the record the chat cannot rebuild — then the
    related topics, then the dedicated channels, then the selected request
    itself, last so that anything left undone keeps it open.

    A root that may not be completed (an execution topic, a standing
    request, an introduction) is one blocked action carrying the scope's
    reason: the panel shows why, and there is nothing to approve.
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


class PlaneOps(PlaneBoard, Protocol):  # pragma: no cover - structural typing only
    def complete(self, project_id: str, issue_id: str) -> None: ...


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
    plane_factory: Callable[[], PlaneOps] | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _locks: dict[Key, threading.Lock] = field(default_factory=dict, repr=False)
    _records: list[dict] = field(default_factory=list, repr=False)
    _reader: ZulipClient | None = field(default=None, repr=False)
    _writer: ZulipClient | None = field(default=None, repr=False)

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
            "plane": self.plane_factory is not None,
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

    def _conversation_lock(self, key: Key) -> threading.Lock:
        with self._lock:
            return self._locks.setdefault(key, threading.Lock())

    # -- the preview --------------------------------------------------------

    def plan(self, key: Key | dict, now: float | None = None) -> dict:
        """What closing this request would change, with the evidence.

        `key` is `(channel, topic)` or the refusal `parse_key`/`desk_key`
        answered instead, passed through so a caller can chain them.
        """
        now = time.time() if now is None else now
        if isinstance(key, dict):
            return key
        realm: Realm | None = self._reader_client()
        plane: PlaneOps | None = self.plane_factory() if self.plane_factory else None
        found = discover(self.topics(), key, realm=realm, plane=plane)
        actions = plan_actions(found)
        return self._payload(now, found, actions)

    def _payload(self, now: float, found: Discovery, actions: list[Action],
                 results: list[dict] | None = None) -> dict:
        ready = [action for action in actions if action.state == READY]
        blocked = [action for action in actions if action.state == BLOCKED]
        return {
            "schema": SCHEMA, "generated_at": now,
            "channel": found.root[0], "topic": found.root[1],
            "root": {"channel": found.root[0], "topic": found.root[1]},
            "scope": found.scope.as_dict(),
            "fingerprint": fingerprint(actions),
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

        The plan is re-derived here: `expected` says which preview the human
        approved, and a different one is answered with the new plan and no
        write at all.
        """
        now = time.time() if now is None else now
        if isinstance(key, dict):
            return key
        client = self._writer_client()
        if client is None:
            return {"error": self.status()["reason"], "status": self.status()}
        with self._conversation_lock(key):
            realm: Realm | None = self._reader_client()
            plane: PlaneOps | None = self.plane_factory() if self.plane_factory else None
            found = discover(self.topics(), key, realm=realm, plane=plane)
            actions = plan_actions(found)
            current = fingerprint(actions)
            if expected is not None and expected != current:
                payload = self._payload(now, found, actions)
                payload["refused"] = True
                payload["error"] = ("the targets have changed since this preview was made; "
                                    "nothing was closed — read the refreshed plan and approve it")
                return payload
            results = self._apply(client, plane, actions)
            with self._lock:
                self._records.append({"at": now, "channel": found.root[0],
                                      "topic": found.root[1], "kind": found.scope.kind,
                                      "fingerprint": current, "results": results})
                del self._records[:-RECORD_MEMORY]
            # The answer is the plan **as it now stands**, re-derived after the
            # writes, with the results laid over it: its fingerprint is what a
            # retry approves, and a retry that carried the pre-write
            # fingerprint would only ever be refused (p4 step 2 met exactly
            # that in a browser fixture). What was archived reads `done`, what
            # failed reads `ready` again, and `partial` is judged on what is
            # still left to do rather than on what was attempted.
            plane = self.plane_factory() if self.plane_factory else None
            after = discover(self.topics(), key, realm=realm, plane=plane)
            actions_after = plan_actions(after)
            # A target this operation made unreadable — the topics of a
            # channel it archived — is not in the plan as it now stands, and
            # a result row with no action to sit under would be lost. The
            # pre-write plan's order is kept, each row wearing its post-write
            # state where there is one and its outcome where there is not;
            # the fingerprint is the post-write plan's alone, because that is
            # what a fresh preview would answer.
            by_key = {action.key: action for action in actions_after}
            shown: list[Action] = []
            for action in actions:
                found_after = by_key.pop(action.key, None)
                if found_after is not None:
                    shown.append(found_after)
                    continue
                outcome = next((row for row in results if row["key"] == action.key), None)
                if outcome is not None and outcome["outcome"] in (APPLIED, ALREADY):
                    shown.append(Action(action.kind, action.key, action.label, DONE,
                                        "closed by this operation; no longer readable from the realm",
                                        action.detail))
                else:
                    shown.append(action)
            shown.extend(by_key.values())
            payload = self._payload(now, after, shown, results)
            payload["fingerprint"] = fingerprint(actions_after)
            payload["applied"] = True
            payload["partial"] = any(row["outcome"] == FAILED for row in results) or bool(
                payload["counts"]["blocked"])
            return payload

    def _apply(self, client: ZulipClient, plane: PlaneOps | None,
               actions: list[Action]) -> list[dict]:
        """Run the ready actions in order. Nothing rolls back.

        A failure stops nothing except the Front topic: the other targets are
        independent of one another, and leaving four of five closed with the
        fifth named is more useful than leaving all five open. The Front
        conversation is the exception, because its ✔ is the claim that the
        whole thing is finished.
        """
        results: list[dict] = []
        trouble = False
        for action in actions:
            if action.state in {DONE, ALREADY}:
                results.append(self._result(action, ALREADY, action.reason))
                continue
            if action.state in {BLOCKED, KEPT}:
                trouble = trouble or action.state == BLOCKED
                results.append(self._result(action, SKIPPED, action.reason))
                continue
            if action.kind == "conversation" and trouble:
                results.append(self._result(
                    action, SKIPPED,
                    "kept open: related work is still blocked or failed, and a ✔ here would "
                    "say the whole thing is finished"))
                continue
            try:
                note = self._run(client, plane, action)
            except Exception as error:  # noqa: BLE001 - reported per target, never raised
                trouble = True
                results.append(self._result(action, FAILED, f"{type(error).__name__}: {error}"))
                continue
            results.append(self._result(action, APPLIED, note))
        return results

    @staticmethod
    def _result(action: Action, outcome: str, note: str) -> dict:
        return {"key": action.key, "kind": action.kind, "label": action.label,
                "outcome": outcome, "note": note}

    def _run(self, client: ZulipClient, plane: PlaneOps | None, action: Action) -> str:
        if action.kind == "work":
            if plane is None:
                raise RuntimeError("no Plane credential is configured")
            plane.complete(action.detail["project_id"], action.detail["issue_id"])
            return f"{action.detail['label']} is Done"
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
        realm and Plane are the record that matters."""
        with self._lock:
            return [row for row in self._records
                    if key is None or (row["channel"], row["topic"]) == key]
