"""Routines, as the realm and the local schedule together describe them.

A routine is three things that live in three places, and the operation room is
the first screen that puts them side by side:

- a **standing request**, the latest post in `#front` › `routine-<name>`. It
  has no `front-` prefix, so Front never serves it — it is a document the
  Developer edits, not a conversation.
- a **fire conversation**, `#front` › `front-routine-<name>`. `trigger.sh`
  posts one line into it as the Developer, and Front is served because the
  last real poster there is not Front. Every run of the routine, and every
  comment on a run, is in that one topic.
- a **schedule**, `.local/rtschedule/schedule.json`, which the dispatcher
  rewrites as it fires. It is read as a **local file**: the routine GUI on
  `:8093` is a `http.server` and answers no CORS header, so a browser cannot
  read it at all and the relay is not merely a convenience here.

Nothing in this module talks to Zulip. It is given the topics the `/ops`
engine already holds — the sweep and its event queue are the only realm
readers this service has, and a second one would be the polling `operation_room`
p1 measured a 429 for.

**The question this adds to the board is whether the last fire was answered.**
An unanswered fire is the failure mode a routine has that a conversation does
not: the schedule says it ran, the topic says nobody came. Front's own ack
(`agag.agent.SWEEP_ACK`) is not an answer — it is the transport saying the
message arrived — so a fire that has only an ack is its own state, `acked`,
and the ages here are ages since the *fire*, not since the ack.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from agag.agent import is_ack

#: The channel every routine lives in. Public (`invite_only: False`), which is
#: why the observer's queue already carries all of this.
ROUTINE_CHANNEL = "front"
#: The standing request's topic prefix. Deliberately *not* `front-`.
STANDING_PREFIX = "routine-"
#: The fire conversation's topic prefix. `front-` is Front's own sweep prefix,
#: which is what makes a post here a request to Front.
FIRE_PREFIX = "front-routine-"
#: `devenv/routine/trigger.sh`'s one line, as a reader can recognise it again.
#: Matching the trigger's own wording is what makes "the last fire" a fact
#: rather than a guess at which post looked like a request.
FIRE_LINE = re.compile(r"^\s*Routine\s+`?(?P<name>[^`\s,]+)`?,\s*run of\b")
#: Messages kept per routine topic. The sweep reads a topic in one call
#: whatever the depth, so this costs nothing over the engine's usual 50 — and
#: a fire topic is the one place where the history *is* the feature.
ROUTINE_HISTORY = 200

__all__ = [
    "FIRE_PREFIX",
    "ROUTINE_CHANNEL",
    "ROUTINE_HISTORY",
    "STANDING_PREFIX",
    "Schedule",
    "fire_of",
    "is_routine_topic",
    "read_schedule",
    "routine_name",
    "routine_rows",
    "schedule_for",
    "standing_request",
]


def is_routine_topic(channel: str, topic: str) -> bool:
    """Whether this conversation is part of a routine's paper trail.

    Both prefixes, because `front-routine-x` also starts with `routine-`'s
    channel but not with its prefix, and the two topics are read for different
    things.
    """
    return channel == ROUTINE_CHANNEL and (
        topic.startswith(FIRE_PREFIX) or topic.startswith(STANDING_PREFIX)
    )


def routine_name(topic: str) -> str | None:
    """The routine a `#front` topic belongs to, or None for anything else."""
    if topic.startswith(FIRE_PREFIX):
        return topic[len(FIRE_PREFIX):] or None
    if topic.startswith(STANDING_PREFIX):
        return topic[len(STANDING_PREFIX):] or None
    return None


# --- the schedule, read from disk -----------------------------------------


@dataclass
class Schedule:
    """`schedule.json` as the view needs it, or the reason there is none.

    A missing path and an unreadable file are different answers and both are
    kept: the board's rule is that an absence is never rendered as a quiet
    "nothing scheduled".
    """

    path: str | None
    ok: bool
    error: str | None = None
    requests: list[dict] = None  # type: ignore[assignment]
    events: list[dict] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self.requests = self.requests or []
        self.events = self.events or []

    def payload(self) -> dict:
        return {
            # The path is a local absolute path and stays out of the payload:
            # it is configuration (`devpolicy/styles.md`), and the view has no
            # use for it beyond knowing whether it was set.
            "configured": self.path is not None,
            "ok": self.ok,
            "error": self.error,
            "requests": len(self.requests),
            "events": len(self.events),
        }


def read_schedule(path: Path | None) -> Schedule:
    """The dispatcher's own file, re-read on every request.

    It is a few kilobytes and the dispatcher rewrites it atomically several
    times per fire, so re-reading is both cheap and the only way to be right;
    a watcher would be more machinery for a file this size.
    """
    if path is None:
        return Schedule(path=None, ok=False, error="AGENTROOM_SCHEDULE_JSON is unset")
    try:
        found = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        return Schedule(path=str(path), ok=False, error=f"cannot read the schedule: {error}")
    except json.JSONDecodeError as error:
        return Schedule(path=str(path), ok=False, error=f"the schedule is not JSON: {error}")
    if not isinstance(found, dict):
        return Schedule(path=str(path), ok=False, error="the schedule's root is not an object")
    requests = found.get("requests")
    events = found.get("events")
    if not isinstance(requests, list) or not isinstance(events, list):
        return Schedule(
            path=str(path), ok=False, error="the schedule has no requests/events arrays"
        )
    return Schedule(path=str(path), ok=True, requests=requests, events=events)


def _seconds(value: Any) -> float | None:
    """An ISO-8601 stamp as epoch seconds, or None when it is not one."""
    if not isinstance(value, str) or not value:
        return None
    from datetime import datetime

    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.timestamp()


def schedule_for(schedule: Schedule, name: str, now: float) -> dict:
    """What the local schedule says about one routine.

    `fired_at` is the dispatcher's own receipt and `at` is the plan, so a
    fired event in the past is history and an unfired one in the future is the
    next fire. An unfired event whose time has passed is neither, and it is
    named as `overdue` rather than folded into either — the dispatcher runs
    every five minutes, so a stale one is a signal.
    """
    mine = [
        event
        for event in schedule.events
        if isinstance(event, dict) and event.get("routine") == name
    ]
    upcoming: list[dict] = []
    fired: list[dict] = []
    overdue: list[dict] = []
    for event in mine:
        at = _seconds(event.get("at"))
        entry = {
            "id": event.get("id"),
            "at": at,
            "fired_at": _seconds(event.get("fired_at")),
            "from": event.get("from"),
        }
        if entry["fired_at"] is not None:
            fired.append(entry)
        elif at is not None and at > now:
            upcoming.append(entry)
        else:
            overdue.append(entry)
    fired.sort(key=lambda entry: entry["fired_at"] or 0.0)
    upcoming.sort(key=lambda entry: entry["at"] or 0.0)
    overdue.sort(key=lambda entry: entry["at"] or 0.0)
    return {
        "events": len(mine),
        "next": upcoming[0] if upcoming else None,
        "last": fired[-1] if fired else None,
        "overdue": overdue,
    }


# --- what the topics say ---------------------------------------------------


def _message(found) -> dict:
    return {
        "message_id": found.id,
        "at": found.timestamp,
        "by": found.sender,
        "sender_id": found.sender_id,
    }


def _excerpt(text: str, limit: int = 400) -> str:
    stripped = text.strip()
    return stripped if len(stripped) <= limit else stripped[: limit - 1].rstrip() + "…"


def fire_of(history: Iterable, name: str):
    """The newest post in the fire topic that is a fire of this routine.

    The trigger's wording is the test. A Developer comment on a run is a post
    in the same topic by the same person, and reading "the newest post by the
    Developer" as the fire would have made every comment a new unanswered run.
    """
    newest = None
    for found in history:
        match = FIRE_LINE.match(found.content or "")
        if match is None or match.group("name") != name:
            continue
        if newest is None or found.id > newest.id:
            newest = found
    return newest


def standing_request(history: Iterable) -> tuple[dict | None, list[dict]]:
    """The standing request, and every post in its topic by somebody else.

    `trigger.sh` tells Front the request is "the latest post" in the topic, and
    on this realm that is **false**: on 2026-09-04 Front filed a run report
    into `#front` › `routine-ghtrends` instead of the fire topic, so the latest
    post there is a report about the routine rather than the request for it. A
    board that repeated the trigger's rule would have shown that report as the
    standing request of `ghtrends`.

    The rule that survives it: the request is the newest post **by the author
    who opened the topic**. A `v2` is written by the person who wrote `v1`;
    anybody else posting there is a stray, and the strays are returned rather
    than dropped, because they are also the evidence that an agent answered in
    the wrong topic.
    """
    posts = sorted(history, key=lambda found: found.id)
    if not posts:
        return None, []
    author = posts[0].sender_id
    mine = [found for found in posts if found.sender_id == author]
    strays = [_message(found) for found in posts if found.sender_id != author]
    newest = mine[-1]
    return {**_message(newest), "text": newest.content.strip()}, strays


def answer_of(history: Iterable, fire, now: float) -> dict:
    """Whether the last fire was answered, and by what.

    Three states, and the middle one is the reason this is not a boolean:

    - `answered` — somebody other than the fire's sender posted real prose
      after it. That is the run reporting back.
    - `acked` — the only thing after the fire is Front's transport ack. The
      run started; nothing has come back yet. p2 already treats an ack as its
      own state on the ops board and this reads it the same way.
    - `unanswered` — nothing at all followed the fire.

    The age is always measured from the **fire**, never from the ack: the
    question a human is asking is how long ago they asked for this.
    """
    if fire is None:
        return {"state": "no fire", "age_seconds": None, "answer": None, "ack": None}
    answer = None
    ack = None
    for found in history:
        if found.id <= fire.id or found.sender_id == fire.sender_id:
            continue
        if is_ack(found.content or ""):
            if ack is None or found.id < ack.id:
                ack = found
            continue
        if answer is None or found.id < answer.id:
            answer = found
    age = round(now - fire.timestamp, 1)
    if answer is not None:
        return {
            "state": "answered",
            "age_seconds": age,
            "answered_after": round(answer.timestamp - fire.timestamp, 1),
            "answer": {**_message(answer), "excerpt": _excerpt(answer.content)},
            "ack": _message(ack) if ack else None,
        }
    return {
        "state": "acked" if ack is not None else "unanswered",
        "age_seconds": age,
        "answer": None,
        "ack": _message(ack) if ack else None,
    }


def routine_rows(
    topics: dict,
    schedule: Schedule,
    now: float,
    *,
    stalled_seconds: float,
) -> list[dict]:
    """One row per routine the realm or the schedule knows about.

    `topics` is keyed `(channel, bare topic)` — the engine's own map, passed
    in rather than re-read. A routine named only by the schedule still gets a
    row: a fire event for a routine with no topics is a dispatcher pointed at
    a name nobody has written a request for, which is worth seeing.
    """
    names: set[str] = set()
    for channel, topic in topics:
        if channel != ROUTINE_CHANNEL:
            continue
        if is_routine_topic(channel, topic):
            found = routine_name(topic)
            if found:
                names.add(found)
    for event in schedule.events:
        if isinstance(event, dict) and isinstance(event.get("routine"), str):
            names.add(event["routine"])

    rows = []
    for name in sorted(names):
        standing = topics.get((ROUTINE_CHANNEL, f"{STANDING_PREFIX}{name}"))
        fire_topic = topics.get((ROUTINE_CHANNEL, f"{FIRE_PREFIX}{name}"))
        history = list(getattr(fire_topic, "history", []) or [])
        history.sort(key=lambda found: found.id)
        fire = fire_of(history, name)
        answer = answer_of(history, fire, now)
        request, strays = standing_request(getattr(standing, "history", None) or [])
        rows.append({
            "name": name,
            # A ✔ on the standing request is the realm retiring the routine,
            # the same sentence a ✔ on an `intro-` topic makes about an agent.
            "retired": bool(standing is not None and standing.resolved),
            "request": request,
            "request_topic": f"{STANDING_PREFIX}{name}" if standing is not None else None,
            #: Posts in the standing-request topic by anybody but its author.
            #: Named rather than skipped: they are the reason the newest post
            #: is not the request, and a reader has to be able to see that.
            "request_strays": strays,
            "fire_topic": f"{FIRE_PREFIX}{name}" if fire_topic is not None else None,
            "posts": len(history),
            "last_fire": ({**_message(fire), "text": _excerpt(fire.content, 200)}
                          if fire is not None else None),
            "answer": answer,
            "state": _state(answer, stalled_seconds),
            "schedule": schedule_for(schedule, name, now),
        })
    return rows


def _state(answer: dict, stalled_seconds: float) -> str:
    """The routine's own state word, in the ops board's vocabulary.

    Deliberately the same five words the conversation board uses, because the
    same human reads both screens; `stalled` here means the fire has gone
    unanswered for longer than the ops board's own threshold.
    """
    state = answer["state"]
    if state == "no fire":
        return "unknown"
    if state == "answered":
        return "done"
    age = answer["age_seconds"] or 0.0
    if state == "acked":
        return "acked" if age < stalled_seconds else "stalled"
    return "awaiting" if age < stalled_seconds else "stalled"
