"""Completing a request: the plan, and carrying it out.

`closing.py` answers *what* finishing the selected request would touch.
This module answers *what would change*, and — on a second, explicit
request — changes it. The request is any conversation `closing.classify`
accepts as a root, named by channel and topic; the Front Desk's
`front-desk-<id>` is one caller of it (`Closer.desk_key`), the operation
room's routine runs and the agent room's conversations are the others
(`front_desk` p4).

**The human's click is the decision.** Nothing here judges whether the
work was any good; it decides only whether each target is in a state this
operation may move: a **topic** may be resolved when the walk actually read
it. A topic known only by the note that named it is a gap, not a finished
conversation.

**Order matters and is fixed**: the related topics first, then the selected
conversation itself. Resolving it last is what makes a half-finished run
visible — if anything related is blocked or failed, the selected
conversation **stays open**, which is the only way the screen can honestly
say "partially closed".

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
terms — a resolved topic resolves to `already` — so a second click after a
partial failure repeats nothing and finishes what is left. The post-write answer is built from the results and
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

from agag.zulip import ZulipClient

from .closing import Discovery, Key, Realm, discover
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

    #: `topic` or `conversation`.
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


def plan_actions(found: Discovery) -> list[Action]:
    """Every action, in the order execution applies them.

    The related topics first, then the selected request itself, last so
    that anything left undone keeps it open.

    A root that may not be completed (an execution topic, a standing
    request, an introduction) is one blocked action carrying the scope's
    reason: the panel shows why, and there is nothing to approve.
    """
    scope = found.scope
    if not scope.closable:
        return [Action("conversation", f"topic:{found.root[0]}/{found.root[1]}",
                       f"#{found.root[0]} › {found.root[1]}", BLOCKED, scope.reason,
                       {"parents": scope.parents, "kind": scope.kind})]
    actions: list[Action] = []

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
    topic that has since been resolved, or a target that has appeared, is.
    """
    material = "\n".join(f"{action.key}={action.state}" for action in sorted(
        actions, key=lambda one: one.key))
    return sha256(material.encode("utf-8")).hexdigest()[:16]


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
        a preview that lists a topic it cannot move is a preview that lies.
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
            if self.mirror is None or not self._dependencies_changed(
                    revision, evidence, listings, compare_evidence=False):
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
            evidence[(row["channel"], row["topic"])] = (
                row["live_topic"], int(row.get("last_post_id") or 0), row["resolved"])
        return evidence

    def _listings_of(self, found: Discovery) -> dict[str, frozenset[str]]:
        """The channels whose topic names the walk depends on: every channel
        a reached conversation is in (twin detection reads their listings)
        and the root's own — with the names the mirror holds for each now."""
        channels = {found.root[0]}
        channels.update(node.channel for node in found.topics)
        channels.update(row["channel"] for row in found.excluded)
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
                              listings: dict[str, frozenset[str]], *,
                              compare_evidence: bool = True) -> bool:
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
        if compare_evidence:
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
            return {"ok": True, "channels": [], "changed": [], "failures": [],
                    "zulip_calls": 0, "note": "no mirror; the plan was re-derived from the realm"}
        spent = self._zulip_calls()
        changed: list[tuple[str, str]] = []
        failures: list[dict[str, str]] = []
        for channel in sorted(plan.listings):
            try:
                changed.extend(mirror.refresh_listing(channel))
            except Exception as error:  # noqa: BLE001 - uncertainty is returned explicitly
                failures.append({"channel": channel,
                                 "reason": f"{type(error).__name__}: {error}"})
        return {"ok": not failures, "channels": sorted(plan.listings),
                "changed": [f"{c}/{t}" for c, t in changed], "failures": failures,
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
            if not checked["ok"]:
                payload = self._payload(now, plan.found, plan.actions, plan=plan)
                payload["verification_failed"] = True
                payload["retryable"] = True
                payload["applied"] = False
                payload["revalidated"] = checked
                channels = ", ".join(row["channel"] for row in checked["failures"])
                payload["error"] = ("pre-write verification failed for " + channels
                                    + "; nothing was closed — retry after the reads recover")
                return payload
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
        return False

    def _apply(self, client: ZulipClient, actions: list[Action]) -> list[dict]:
        """Run the ready actions in order. Nothing rolls back.

        A failure stops nothing except the selected conversation: the other
        targets are independent of one another, and leaving four of five
        closed with the fifth named is more useful than leaving all five
        open. The selected conversation is held because its ✔ is the claim
        that the whole thing is finished.
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
                note = self._run(client, action)
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

    def _run(self, client: ZulipClient, action: Action) -> str:
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
