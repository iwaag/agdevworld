"""Talking in a project's conversations: read one, post into it as the Developer.

`project_room` p1 step 2. The read model (`projectroom.py`) says what a
project has; this door shows the selected conversation's visible history and
carries a comment into **the conversation it belongs to**:

- a *plan comment* goes into the mission's `workplan-` conversation (the
  planning conversation, which autolab serves);
- a *run comment* goes into the task's `workrun-` conversation (the
  execution conversation, which autolab serves too);
- a comment on a *setup* or an *unrecorded plan* goes into that `workplan-`
  conversation;
- a *document* (`goal`, `researchplan-…`) is **not** a conversation anybody
  serves. Posting into it would dispatch nothing and would look as if it had,
  so the door refuses it and names the path instead: the source in Zulip, and
  Front — at the Front Desk or in the argue the project grew out of — for
  discussing how to proceed.

**The destination is resolved from the anchor at send time**
(`presentation.locate`): a mission or task is its anchor message id, and the
post goes where that message is *now*. A renamed topic is followed; a topic
that took a freed display name is somebody else's conversation and is never
posted into by mistake; a deleted anchor is *absent* and nothing is sent.

**A finished conversation is not reopened by accident.** A ✔'d target is
refused unless the submit says `resume: true`, and then the topic is
un-resolved first and the answer says `resumed: true`. Loading a room never
starts work; a post always does — autolab serves the topic and a run is
bought — which is why nothing here retries, every submit carries a token
(`argueroom.SubmitTokens`), and a failure after the post left is *uncertain*
rather than repeated.

The existing `/chat` accepts routine conversations and cannot serve this
without loosening its rule, so this is the third write door beside it and the
rooms', on the same Developer credential (`chat.py`) with the same text
checks. It is not another agent entrance: a comment is posted where the work
is, and autolab reads it there as it reads everything else.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from urllib.parse import quote

from agag.mirror import Mirror, bare_topic
from agag.zulip import RESOLVED_TOPIC_PREFIX

from .argueroom import SubmitTokens
from .chat import Chat
from .ops import owns
from .presentation import Located, agents_of, locate, source_posts
from .projectroom import DOCUMENT, MISSION, PLAN, SETUP, TASK, ProjectRoom, classify
from .room import health_block

SCHEMA = "ag.projecttalk.v1"
#: Where a comment lands, by the shape of the conversation.
PLANNING, EXECUTION, NONE = "planning", "execution", "none"

__all__ = ["EXECUTION", "NONE", "PLANNING", "ProjectTalk", "SCHEMA"]


@dataclass
class ProjectTalk:
    room: ProjectRoom
    chat: Chat
    tokens: SubmitTokens = field(default_factory=SubmitTokens, repr=False)

    @property
    def mirror(self) -> Mirror | None:
        return self.room.mirror

    # -- who answers where --------------------------------------------------------------

    def _responsible(self, channel: str, topic: str) -> list[dict]:
        """The live instances whose roster owns this conversation — read off
        the introductions the ops engine already parsed, never guessed."""
        ops = self.room.ops
        if ops is None:
            return []
        ops.refresh()
        with ops._lock:
            rosters = {i: r for i, r in ops._rosters.items() if r is not None}
            retired = set(ops._retired)
        return [{"instance": instance, "agent": roster.agent, "bot": roster.bot, "bot_id": roster.bot_id}
                for instance, roster in sorted(rosters.items())
                if instance not in retired and owns(roster, channel, bare_topic(topic))]

    def _destination(self, where: Located, role: str) -> dict:
        who = self._responsible(where.channel, where.topic)
        names = ", ".join(w["instance"] for w in who) or "nobody on the board"
        what = {PLANNING: "the planning conversation", EXECUTION: "the execution conversation",
                NONE: "a document topic"}[role]
        return {
            "channel": where.channel, "topic": where.topic, "live_topic": where.live_topic,
            "resolved": where.resolved, "role": role, "responsible": who,
            "label": f"#{where.channel} › {where.topic} — {what}"
                     + (f", answered by {names}" if role != NONE else ", which nobody serves"),
            "postable": role != NONE,
        }

    def _front_path(self, project: dict | None) -> dict:
        """Where to discuss how to proceed: Front, at the desk or in the argue
        the project grew out of."""
        found = {"desk": "/?view=frontdesk", "argue": None,
                 "note": "a document dispatches nothing; ask Front how to proceed — a mission is asked for in a "
                         "workplan- topic of this project channel"}
        origin = (project or {}).get("origin")
        if origin and origin.get("anchor") is not None:
            found["argue"] = f"/?view=argue&argue={origin['anchor']}"
        return found

    def _narrow(self, channel: str, live_topic: str) -> str | None:
        mirror = self.mirror
        base = getattr(mirror, "base_url", "") if mirror is not None else ""
        found = mirror.channel(channel) if mirror is not None else None
        if not base or found is None:
            return None
        return f"{base}/#narrow/channel/{found.stream_id}-{quote(channel, safe='')}/topic/{quote(live_topic, safe='')}"

    def _health(self) -> dict:
        return health_block(self.mirror)

    # -- reads ------------------------------------------------------------------------

    def _posts(self, where: Located) -> tuple[list[dict], list]:
        agents = agents_of(self.mirror)
        posts, messages = source_posts(self.mirror, where, agents)
        return posts, messages

    @staticmethod
    def status_of(posts: list[dict], resolved: bool, responsible: list[dict]) -> dict:
        """Where the conversation stands, judged against **who serves it**: a
        post by a responsible agent answers, its ack means it is running,
        anybody else's post — Front's ask included — is waiting for it. The
        argue's rule (Front answers) does not hold here: in a project
        conversation Front is a requester like the Developer."""
        last = posts[-1] if posts else None
        if resolved:
            return {"state": "done", "since": last["at"] if last else None, "evidence": "the topic carries ✔"}
        if last is None:
            return {"state": "quiet", "since": None, "evidence": "no real post in this conversation"}
        serving = {int(r["bot_id"]) for r in responsible if r.get("bot_id") is not None}
        by_server = int(last["sender_id"]) in serving
        if last["kind"] == "ack" and by_server:
            return {"state": "received", "since": last["at"],
                    "evidence": f"{last['by']}'s ack #{last['message_id']} is the newest post: a reply is being written"}
        if by_server:
            return {"state": "answered", "since": last["at"],
                    "evidence": f"{last['by']}'s post #{last['message_id']} is the newest"}
        if not serving:
            return {"state": "quiet", "since": last["at"],
                    "evidence": f"nobody on the board serves this conversation; {last['by']}'s post #{last['message_id']} is the newest"}
        return {"state": "waiting", "since": last["at"],
                "evidence": f"{last['by']}'s post #{last['message_id']} is the newest and no serving agent has picked it up"}

    def _payload(self, kind: str, where: Located, role: str, project: dict | None, record: dict | None,
                 now: float) -> dict:
        posts, _ = self._posts(where)
        health = self._health()
        destination = self._destination(where, role)
        status = self.status_of(posts, where.resolved, destination["responsible"])
        if health["state"] != "live":
            status = {**status, "stale_state": status["state"], "state": "unknown",
                      "evidence": f"{health['reason']}; last known: {status['evidence']}"}
        return {
            "schema": SCHEMA, "generated_at": now, "health": health, "chat": self.chat.status(),
            "conversation": {
                "kind": kind, "anchor": where.anchor if kind in (MISSION, TASK) else None,
                "project": project, "record": record,
                "destination": destination,
                "posts": posts, "status": status,
                "zulip_url": self._narrow(where.channel, where.live_topic),
                "front": self._front_path(project) if role == NONE else None,
                "note": ("posting here is a comment in the conversation autolab serves: it buys a run"
                         if role != NONE else "this is a document: reading it starts nothing, and nothing is posted here"),
            },
        }

    def _project_stub(self, project_id) -> dict | None:
        derived = self.room.refresh()
        found = derived["projects"].get(project_id) if project_id is not None else None
        if found is None:
            return None
        origin = found["origin"]
        return {"key": str(project_id), "channel": found["channel"].name, "slug": found["slug"], "kind": found["kind"],
                "origin": None if origin is None else {**origin, "anchor": self.room._argue_anchor(origin)}}

    def work(self, anchor, now: float | None = None) -> dict:
        """One mission or task by its anchor: history, destination, record."""
        now = time.time() if now is None else now
        if self.mirror is None:
            return {"error": "no mirror: nothing can be read"}
        found = self.room.locate_work(anchor)
        if found is None:
            return {"error": f"no mission or task wears the anchor {anchor!r}"}
        where = locate(self.mirror, int(anchor))
        if where is None:
            return {"error": f"message {anchor} is not in the realm any more: the record was deleted"}
        role = PLANNING if found["kind"] == MISSION else EXECUTION
        record = self.room.work_row(int(anchor), now=now)
        return self._payload(found["kind"], where, role, self._project_stub(found["project_id"]), record, now)

    def _topic_location(self, project_id: int, bare: str) -> Located | None:
        mirror = self.mirror
        derived = self.room.refresh()
        project = derived["projects"].get(project_id)
        if project is None:
            return None
        channel = project["channel"].name
        live = mirror.live_name(channel, bare)
        if live is None:
            return None
        messages = mirror.messages(channel, bare)
        if not messages:
            return None
        return Located(messages[0].id, channel, bare, live, live.startswith(RESOLVED_TOPIC_PREFIX))

    def topic(self, key, topic, now: float | None = None) -> dict:
        """One unrecorded conversation of a project channel — a document, a
        setup, a plan with no mission note — by its name."""
        now = time.time() if now is None else now
        if self.mirror is None:
            return {"error": "no mirror: nothing can be read"}
        project_id = self.room._resolve_key(key)
        if isinstance(project_id, dict):
            return project_id
        bare = bare_topic(str(topic or ""))
        where = self._topic_location(project_id, bare)
        if where is None:
            return {"error": f"no conversation named {bare!r} in that project channel"}
        read = self.room.refresh()["projects"][project_id]["reads"].get(bare)
        kind = classify(bare, read.record if read else None)
        if kind in (MISSION, TASK):
            # A recorded conversation is reached by its anchor, so a reused
            # name never shows another mission's history under this one.
            return {"error": f"{bare!r} carries a work record; read it as /work/{read.record.anchor_id}",
                    "anchor": read.record.anchor_id, "kind": kind}
        role = NONE if kind == DOCUMENT else PLANNING if kind in (SETUP, PLAN) else NONE
        return self._payload(kind, where, role, self._project_stub(project_id), None, now)

    # -- the write -------------------------------------------------------------------

    def _refusal(self, text: str, token) -> str | None:
        if not self.chat.configured:
            return self.chat.status()["reason"]
        bad = SubmitTokens.check(token)
        if bad is not None:
            return bad
        return self.chat.text_check(text)

    def _send(self, where: Located, role: str, text: str, token: str, resume: bool) -> dict:
        if where.resolved and not resume:
            return {"sent": False, "uncertain": False, "resolved": True, "needs_resume": True,
                    "error": f"#{where.channel} › {where.live_topic} carries ✔: a post would resume it and buy a run; "
                             "submit again with resume: true to do that on purpose"}
        earlier = self.tokens.earlier(token)
        if earlier is not None:
            return earlier
        client = self.chat.client()
        resumed = False
        if where.resolved:
            resumed = self._unresolve(client, where)
        try:
            message_id = client.send_to_channel(where.channel, where.topic, text.strip())
        except Exception as error:  # noqa: BLE001 - reported, never retried
            return self.tokens.keep(token, {
                "sent": False, "uncertain": True, "error": f"{type(error).__name__}: {error}",
                "channel": where.channel, "topic": where.topic,
                "note": f"the post may have landed; read #{where.channel} › {where.topic} before sending again"})
        return self.tokens.keep(token, {
            "sent": True, "uncertain": False, "anchor": where.anchor, "channel": where.channel, "topic": where.topic,
            "role": role, "message_id": message_id, "resumed": resumed,
            "note": ("the conversation is resumed and the comment is live; autolab serves it from here" if resumed
                     else "the comment is live in the realm; the event queue will carry it back")})

    def _unresolve(self, client, where: Located) -> bool:
        messages = self.mirror.messages(where.channel, where.live_topic, across_resolve=False)
        if not messages:
            return False
        try:
            client.call("PATCH", f"messages/{messages[-1].id}",
                        {"topic": where.topic, "propagate_mode": "change_all",
                         "send_notification_to_new_thread": False})
        except Exception:  # noqa: BLE001 - the post still goes out; Zulip keeps two names
            return False
        return True

    def post_work(self, anchor, text: str, token: str, *, resume: bool = False) -> dict:
        """A plan comment (mission) or run comment (task), into the
        conversation the anchor is in now, once per token."""
        refused = self._refusal(text, token)
        if refused is not None:
            return {"sent": False, "uncertain": False, "error": refused}
        if self.mirror is None:
            return {"sent": False, "uncertain": False, "error": "no mirror: the destination cannot be resolved"}
        found = self.room.locate_work(anchor)
        if found is None:
            return {"sent": False, "uncertain": False, "error": f"no mission or task wears the anchor {anchor!r}"}
        where = locate(self.mirror, int(anchor))
        if where is None:
            return {"sent": False, "uncertain": False,
                    "error": f"message {anchor} is not in the realm any more: the record was deleted, nothing was sent"}
        return self._send(where, PLANNING if found["kind"] == MISSION else EXECUTION, text, token, resume)

    def post_topic(self, key, topic, text: str, token: str, *, resume: bool = False) -> dict:
        """A comment into an unrecorded conversation (setup, plan without a
        note); a document is refused with the path to Front."""
        refused = self._refusal(text, token)
        if refused is not None:
            return {"sent": False, "uncertain": False, "error": refused}
        if self.mirror is None:
            return {"sent": False, "uncertain": False, "error": "no mirror: the destination cannot be resolved"}
        project_id = self.room._resolve_key(key)
        if isinstance(project_id, dict):
            return {"sent": False, "uncertain": False, **project_id}
        bare = bare_topic(str(topic or ""))
        where = self._topic_location(project_id, bare)
        if where is None:
            return {"sent": False, "uncertain": False,
                    "error": f"no conversation named {bare!r} in that project channel; nothing was sent"}
        read = self.room.refresh()["projects"][project_id]["reads"].get(bare)
        kind = classify(bare, read.record if read else None)
        if kind == DOCUMENT:
            return {"sent": False, "uncertain": False, "kind": kind,
                    "front": self._front_path(self._project_stub(project_id)),
                    "error": "a document is not a conversation anybody serves: posting there would dispatch nothing. "
                             "Ask Front how to proceed instead"}
        if kind in (MISSION, TASK):
            return {"sent": False, "uncertain": False, "kind": kind, "anchor": read.record.anchor_id,
                    "error": f"{bare!r} carries a work record; post to it by anchor, /work/{read.record.anchor_id}/post"}
        if kind not in (SETUP, PLAN):
            return {"sent": False, "uncertain": False, "kind": kind,
                    "error": f"{bare!r} is neither a plan, a setup nor a document; this door does not post there"}
        return self._send(where, PLANNING, text, token, resume)
