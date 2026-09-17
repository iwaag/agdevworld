"""A source conversation and its memo: what the rooms show of both.

`argue` p2 step 3. The Front Desk and the Arguing Room show the same two
things about a conversation: **what was said** — every participant's posts,
verbatim, which is also where the human's input goes — and **how Front
re-voiced it** as character dialogue, saved as `ag-memo` records in a memo
topic nobody reacts to (`agag.memo`, written by `agfront.render`). This
module is the relation between the two, read **entirely from the mirror**:
a browser refresh, a poll or a second tab costs no Zulip call.

- A source is identified by an **anchor** message id. `locate` answers where
  that message is *now*, so a renamed or resolved topic is followed and a
  reused display name is never mistaken for the conversation.
- The memo of a source is the memo topic whose `[selfnote][memosource]` note
  names that anchor.
- An **interpretation** is one `(settings revision, renderer)` pair. Every
  result record says which it belongs to; older interpretations stay, with
  the revision their portraits are retained under.
- A result carries the **fingerprint** of the posts it was made from. It is
  recomputed here over the source as it stands: a mismatch is `stale` (a post
  was edited), a missing id is `stale` too (a post was deleted).
- **Status** is what the memo shows and nothing else: a `failed` record, a
  `refused` request, or — derived — agent speech with no result at the active
  settings revision (`pending`, and `overdue` once it is older than
  `OVERDUE_SECONDS`: the renderer is slow, switched off or down, which looks
  the same from here and is said so).

Nothing here decides what a post means beyond the realm's own facts: the
introductions say which accounts are agents, `agag.argue.speaker_of` reads a
logical speaker's header, `agag.agent.is_ack` names the transport ack.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass

from agag.agent import is_ack
from agag.argue import speaker_of
from agag.memo import DIALOGUE_SCHEMA, MEMO_CHANNEL, RENDER_TAG, SOURCE_TAG, fingerprint, parse_record
from agag.mirror import Mirror, bare_topic
from agag.selfnote import is_selfnote, is_speech, parse_note
from agag.zulip import RESOLVED_TOPIC_PREFIX

#: Agent speech this old with no result is not "about to be rendered".
OVERDUE_SECONDS = 900.0
HANDOFF = re.compile(r"^\s*@\*\*[^*\n]+\*\*\s*\n+")
_SPEAKER_HEADER = re.compile(r"^\*\*\[[a-z][\w-]*:[\w.-]+\]\*\*[ \t]*\n")

__all__ = [
    "OVERDUE_SECONDS", "Located", "agents_of", "locate", "memo_topic_of", "post_payload", "presentation",
    "shown_content", "source_posts",
]


def shown_content(content: str) -> str:
    """A post as a person should read it: without the leading hand-off
    mention the skeleton prefixes to a reply, and without a logical
    speaker's header (the speaker is a field of its own)."""
    text = HANDOFF.sub("", str(content or ""), count=1)
    return _SPEAKER_HEADER.sub("", text.lstrip(), count=1).strip()


@dataclass(frozen=True)
class Located:
    """Where a source conversation is now."""

    anchor: int
    channel: str
    topic: str          # bare
    live_topic: str     # as it can be read and written now
    resolved: bool


def locate(mirror: Mirror, anchor: int) -> Located | None:
    """The conversation holding message `anchor` now, or None when that
    message is gone. The open topic is preferred over a ✔ twin."""
    message = mirror.message(int(anchor))
    if message is None:
        return None
    bare = bare_topic(message.topic)
    # Judged from the messages, not from the topic listing: a listing row can
    # outlive the rename that emptied it (met live, `argue` p2 step 5 — a
    # resolved argue read as open). The anchor's own topic is where the
    # conversation is; an open twin counts only when it really holds posts.
    live = message.topic
    if live.startswith(RESOLVED_TOPIC_PREFIX) and mirror.messages(message.channel, bare, across_resolve=False):
        live = bare
    return Located(int(anchor), message.channel, bare, live, live.startswith(RESOLVED_TOPIC_PREFIX))


def agents_of(mirror: Mirror) -> dict[int, str]:
    """`{bot user id: roster agent name}` from every introduction, retired
    ones included — what an agent said is still an agent's speech."""
    found: dict[int, str] = {}
    for intro in mirror.intros().values():
        roster = intro.roster
        if roster is not None and roster.bot_id is not None:
            found[int(roster.bot_id)] = roster.agent
    return found


def memo_topic_of(mirror: Mirror, anchor: int) -> str | None:
    for found in mirror.notes(tag=SOURCE_TAG, channel=MEMO_CHANNEL, include_memos=True):
        if found.value.split()[:1] == [str(int(anchor))]:
            return found.topic
    return None


def post_payload(message, agents: dict[int, str]) -> dict:
    """One real post of a source, for a room: who said it and as whom."""
    content = str(message.content or "")
    agent = agents.get(int(message.sender_id))
    logical = speaker_of(HANDOFF.sub("", content, count=1)) if agent else None
    if is_ack(content.strip()):
        kind = "ack"
    elif agent is not None:
        kind = "agent"
    else:
        kind = "human"
    return {
        "message_id": message.id, "at": message.timestamp, "by": message.sender_name,
        "sender_id": message.sender_id, "kind": kind, "agent": agent,
        "speaker": logical or message.sender_name, "logical": logical,
        "content": shown_content(content), "edited": message.edited_at is not None,
    }


def source_posts(mirror: Mirror, where: Located, agents: dict[int, str]) -> tuple[list[dict], list]:
    """`(posts a room shows, every message)` of a source, oldest first."""
    messages = mirror.messages(where.channel, where.topic)
    posts = [post_payload(m, agents) for m in messages if is_speech(m.as_zulip())]
    return posts, messages


def presentation(mirror: Mirror, where: Located, messages: list, agents: dict[int, str], *,
                 active_revision: str | None, now: float | None = None) -> dict:
    """Everything a room needs to switch between speech and dialogue."""
    now = time.time() if now is None else now
    current = {m.id: str(m.content or "") for m in messages}
    speech = [m for m in messages if is_speech(m.as_zulip()) and int(m.sender_id) in agents
              and not is_ack(str(m.content or "").strip()) and shown_content(m.content)]
    topic = memo_topic_of(mirror, where.anchor)
    results: dict[str, dict] = {}
    failed: list[dict] = []
    refused: list[dict] = []
    if topic is not None:
        for memo in mirror.messages(MEMO_CHANNEL, topic):
            record = parse_record(memo.content)
            if not record or record.get("schema") != DIALOGUE_SCHEMA:
                continue
            kind = record.get("kind")
            source = record.get("source") or {}
            if kind == "result":
                found = results.setdefault(str(record.get("job")), {
                    "job": str(record.get("job")), "settings_revision": str(record.get("settings_revision") or ""),
                    "renderer": str(record.get("renderer") or ""),
                    "messages": [int(i) for i in source.get("messages") or []],
                    "fingerprint": str(source.get("fingerprint") or ""), "parts": int(record.get("parts") or 1),
                    "held": {}, "memo_message_ids": [], "at": memo.timestamp,
                })
                found["held"][int(record.get("part") or 1)] = record.get("turns") or []
                found["memo_message_ids"].append(memo.id)
            elif kind == "failed":
                failed.append({"job": record.get("job"), "messages": [int(i) for i in source.get("messages") or []],
                               "settings_revision": record.get("settings_revision"), "renderer": record.get("renderer"),
                               "attempts": record.get("attempts"), "error": record.get("error"), "at": memo.timestamp})
            elif kind == "refused":
                refused.append({"request": record.get("request"), "settings_revision": record.get("settings_revision"),
                                "error": record.get("error"), "at": memo.timestamp})

    renderings: dict[str, list[dict]] = {}
    interpretations: dict[tuple[str, str], dict] = {}
    for found in sorted(results.values(), key=lambda r: r["at"]):
        if any(part not in found["held"] for part in range(1, found["parts"] + 1)):
            continue  # a result whose parts are not all here yet is not shown
        missing = [i for i in found["messages"] if i not in current]
        stale = bool(missing) or fingerprint((i, current[i]) for i in found["messages"]) != found["fingerprint"]
        turns = [turn for part in sorted(found["held"]) for turn in found["held"][part]]
        by_first: dict[int, list[dict]] = {}
        for turn in turns:
            cited = [int(s["message_id"]) for s in turn.get("sources") or [] if s.get("message_id") is not None]
            if cited:
                by_first.setdefault(min(cited), []).append(turn)
        key = (found["settings_revision"], found["renderer"])
        entry = interpretations.setdefault(key, {
            "settings_revision": key[0], "renderer": key[1], "results": 0, "posts": 0, "stale": 0,
            "newest_at": 0})
        entry["results"] += 1
        entry["posts"] += len(found["messages"])
        entry["stale"] += 1 if stale else 0
        entry["newest_at"] = max(entry["newest_at"], found["at"])
        for message_id, its_turns in by_first.items():
            renderings.setdefault(str(message_id), []).append({
                "settings_revision": key[0], "renderer": key[1], "job": found["job"], "stale": stale,
                "missing_sources": missing, "turns": its_turns, "memo_message_ids": found["memo_message_ids"],
                "at": found["at"]})

    # A request the memo has not answered with anything yet.
    requests = [{"message_id": m.id, "settings_revision": (parse_note(m.content, RENDER_TAG) or "").strip(),
                 "at": m.timestamp} for m in messages
                if is_selfnote(m.content) and parse_note(m.content, RENDER_TAG) is not None]

    failed_ids = {i for one in failed if one["settings_revision"] == active_revision for i in one["messages"]}
    pending = []
    if active_revision:
        for message in speech:
            shown = [r for r in renderings.get(str(message.id), []) if r["settings_revision"] == active_revision
                     and not r["stale"]]
            if shown or message.id in failed_ids:
                continue
            age = max(0.0, now - float(message.timestamp))
            pending.append({"message_id": message.id, "age_seconds": round(age, 1), "overdue": age > OVERDUE_SECONDS})
    overdue = [p for p in pending if p["overdue"]]
    if overdue:
        state, reason = "unavailable", (f"{len(overdue)} post(s) have waited more than {OVERDUE_SECONDS / 60:.0f} min "
                                        "for a rendering: the renderer is slow, switched off or down")
    elif pending:
        state, reason = "rendering", f"{len(pending)} post(s) are waiting to be rendered"
    elif not active_revision:
        state, reason = "unknown", "no settings revision is active, so nothing can be rendered"
    else:
        state, reason = "idle", "every agent post has a rendering at the active settings, or a recorded failure"
    return {
        "anchor": where.anchor,
        "memo": ({"channel": MEMO_CHANNEL, "topic": topic} if topic is not None else None),
        "active_revision": active_revision,
        "interpretations": sorted(interpretations.values(), key=lambda e: e["newest_at"], reverse=True),
        "renderings": renderings, "pending": pending, "failed": failed, "refused": refused,
        "requests": requests, "renderer": {"state": state, "reason": reason},
    }
