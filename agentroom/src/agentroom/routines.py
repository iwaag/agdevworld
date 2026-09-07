"""Routines, as the realm and the local schedule together describe them.

A routine is three things that live in three places, and the operation room is
the first screen that puts them side by side:

- a **standing request**, the latest post in `#front` › `routine-<name>`. It
  has no `front-` prefix, so Front never serves it — it is a document the
  Developer edits, not a conversation.
- a **run topic per run**, `#front` › `front-routine-<name>-<stamp>`
  (`operation_room` p7). `trigger.sh` and the board's start button post one
  fire line into a fresh topic as the Developer, and Front is served because
  the last real poster there is not Front. The topic *is* the session: its
  ✔ is the run's resolution, its history is the run's chat, and the
  conversations it opened are found from the link notes exactly as before.
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
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from agag.agent import is_ack

#: The channel every routine lives in. Public (`invite_only: False`), which is
#: why the observer's queue already carries all of this.
ROUTINE_CHANNEL = "front"
#: The standing request's topic prefix. Deliberately *not* `front-`.
STANDING_PREFIX = "routine-"
#: The run topics' prefix. `front-` is Front's own sweep prefix, which is
#: what makes a post here a request to Front. A bare `front-routine-<name>`
#: (the pre-p7 layout, one topic per routine) is no longer a routine topic.
FIRE_PREFIX = "front-routine-"
#: `devenv/routine/trigger.sh`'s one line, as a reader can recognise it again.
#: Matching the trigger's own wording is what makes "the last fire" a fact
#: rather than a guess at which post looked like a request.
FIRE_LINE = re.compile(r"^\s*Routine\s+`?(?P<name>[^`\s,]+)`?,\s*run of\b")
#: The phrase a fire started from the operation room carries after its stamp
#: (`operation_room` p6). `fire_line()` writes it and `fire_origin()` reads
#: it back, so the two cannot drift; the dispatcher's own wording never has it.
MANUAL_MARK = "started by hand from the operation room"
#: The sentence `trigger.sh` writes after the stamp. Its presence, without the
#: manual mark, is what says a fire came from the dispatcher.
TRIGGER_SENTENCE = "The standing request is the latest post in"
#: The pointer to the routine's previous run topic (`operation_room` p7). One
#: topic per run means the previous run is not in this topic's history; the
#: fire names it so Front can read it if it wants the context.
PREVIOUS_MARK = "Previous run: #front › "
#: The dispatcher's `run_topic()`: `front-routine-<name>-<stamp>`, the stamp
#: being the fire line's own UTC minute. Both writers build it from the same
#: pieces and this regex reads it back.
RUN_TOPIC = re.compile(r"^front-routine-(?P<name>.+)-(?P<stamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)$")
#: How close the dispatcher's `fired_at` must be to the fire post for the two
#: to be the same event. The dispatcher runs every five minutes and posts
#: within seconds of its receipt.
SCHEDULE_MATCH_SECONDS = 180.0
#: Optional display metadata, one line anywhere in the standing request:
#: `display: 📰 Papers digest` (`operation_room` p6). The standing request is
#: already the document the Developer edits for the routine, so a title lives
#: where the routine is defined and travels with its version — no file, no
#: variable, nothing to provision. Front reads past the line like any other.
DISPLAY_LINE = re.compile(r"^\s*display:\s*(?P<value>\S.*?)\s*$", re.IGNORECASE | re.MULTILINE)
#: A markdown heading as the first line is the next best title.
HEADING_LINE = re.compile(r"^\s*#{1,3}\s+(?P<value>\S.*?)\s*$")
#: A leading emoji (or other symbol) on either of the above becomes the icon.
LEADING_SYMBOL = re.compile(r"^(?P<icon>[^\w\s`*#][\uFE0F\u200D]?(?:[^\w\s`*#][\uFE0F]?)?)\s+(?P<rest>.+)$")
#: Icons assigned when the request names none: picked by the routine's name,
#: so a routine keeps its icon across restarts and screens without anybody
#: maintaining a mapping. Assigned, not meaningful, and the payload says so.
ASSIGNED_ICONS = ("🔁 📌 🧭 🛰 🧪 📦 🗂 🔔 🪄 🧵 🎯 🧰 🌱 🔭 🎲 🧲 🪁 🗝 🧊 🎨 "
                  "🛠 🧯 🪐 🧿").split()
#: Sessions listed for one routine. The braindump asks for about three: a
#: fourth is a drill-down, not a board.
SESSION_LIMIT = 3
#: Caps on the walk. A cycle in the link notes is possible — two agents can
#: anchor each other — and a board is not where that should be discovered.
MAX_DEPTH = 4
MAX_NODES = 40
#: Messages kept per deep-read routine topic. The sweep reads a topic in one
#: call whatever the depth, so depth costs nothing — *count* does, which is
#: what `DEEP_RUNS` caps.
ROUTINE_HISTORY = 200
#: Run topics per routine the sweep reads deep and reads even under ✔. Older
#: runs are ordinary topics: read shallow while open, not read at all once
#: resolved. Without this cap every ✔'d run on the realm would be one deep
#: call per resync, forever.
DEEP_RUNS = SESSION_LIMIT

__all__ = [
    "FIRE_PREFIX",
    "PREVIOUS_MARK",
    "RUN_TOPIC",
    "fire_line",
    "parse_run_topic",
    "previous_of",
    "run_topic",
    "MANUAL_MARK",
    "DEEP_RUNS",
    "display_of",
    "fire_origin",
    "newest_run_topics",
    "resolution_of",
    "run_topics_of",
    "session_list",
    "session_of",
    "ROUTINE_CHANNEL",
    "ROUTINE_HISTORY",
    "STANDING_PREFIX",
    "Schedule",
    "MAX_DEPTH",
    "MAX_NODES",
    "SESSION_LIMIT",
    "children_of",
    "fire_of",
    "is_routine_topic",
    "read_schedule",
    "routine_name",
    "routine_rows",
    "schedule_for",
    "session_tree",
    "sessions_of",
    "standing_request",
]


def is_routine_topic(channel: str, topic: str) -> bool:
    """Whether this conversation is part of a routine's paper trail: its
    standing request, or one of its run topics."""
    return channel == ROUTINE_CHANNEL and (
        parse_run_topic(topic) is not None or topic.startswith(STANDING_PREFIX)
    )


def routine_name(topic: str) -> str | None:
    """The routine a topic belongs to, or None."""
    parsed = parse_run_topic(topic)
    if parsed is not None:
        return parsed[0]
    if topic.startswith(STANDING_PREFIX):
        return topic[len(STANDING_PREFIX):] or None
    return None


def run_topics_of(topics: dict, name: str) -> list:
    """This routine's run topics the engine holds, newest first.

    Newest by *stamp*, which is the topic's own name: a topic the sweep read
    shallow and one it read deep sort the same, and a run started by hand
    and one the dispatcher started sort by when they started.
    """
    found = []
    for (channel, topic), held in topics.items():
        if channel != ROUTINE_CHANNEL:
            continue
        parsed = parse_run_topic(topic)
        if parsed is not None and parsed[0] == name:
            found.append((parsed[1], held))
    found.sort(key=lambda pair: pair[0], reverse=True)
    return [held for _, held in found]


def newest_run_topics(names: Iterable[str], per_routine: int = DEEP_RUNS) -> set[str]:
    """Of these bare `#front` topic names, the newest `per_routine` run topics
    of each routine — the ones the sweep reads deep and reads even under ✔."""
    by_routine: dict[str, list[tuple[str, str]]] = {}
    for topic in names:
        parsed = parse_run_topic(topic)
        if parsed is not None:
            by_routine.setdefault(parsed[0], []).append((parsed[1], topic))
    chosen: set[str] = set()
    for runs in by_routine.values():
        runs.sort(reverse=True)
        chosen.update(topic for _, topic in runs[:per_routine])
    return chosen


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
   
    found = None
    for post in history:
        match = FIRE_LINE.match(post.content or "")
        if match and match.group("name") == name and (found is None or post.id < found.id):
            found = post
    return found


def assigned_icon(name: str, taken: set[str] | None = None) -> str:
    """The icon a routine gets from its name alone.

    FNV-1a over the name, so similar names land apart; `taken` lets a board
    step past an icon another routine already wears, walking the palette from
    the hashed slot so the step is deterministic too.
    """
    digest = 0x811C9DC5
    for byte in name.encode("utf-8"):
        digest = ((digest ^ byte) * 0x01000193) & 0xFFFFFFFF
    slot = digest % len(ASSIGNED_ICONS)
    for offset in range(len(ASSIGNED_ICONS)):
        icon = ASSIGNED_ICONS[(slot + offset) % len(ASSIGNED_ICONS)]
        if not taken or icon not in taken:
            return icon
    return ASSIGNED_ICONS[slot]


def display_of(name: str, request_text: str | None) -> dict:
    """How a routine is shown: an icon, a title, and where each came from.

    Routing stays keyed by `name`; this is presentation only. A `display:`
    line wins, then a first-line heading, then the internal name — a routine
    nobody has titled is still usable and still recognisable, because the
    assigned icon is stable for its name.
    """
    text = request_text or ""
    source, value = "name", name
    found = DISPLAY_LINE.search(text)
    if found:
        source, value = "metadata", found.group("value")
    else:
        first = next((line for line in text.splitlines() if line.strip()), "")
        heading = HEADING_LINE.match(first)
        if heading:
            source, value = "heading", heading.group("value")
    value = value.strip().strip("*_").strip()
    icon_source = "assigned"
    icon = assigned_icon(name)
    symbol = LEADING_SYMBOL.match(value)
    if symbol and source != "name":
        icon, value, icon_source = symbol.group("icon"), symbol.group("rest").strip(), source
    if not value:
        source, value = "name", name
    return {"icon": icon, "icon_source": icon_source, "title": value, "title_source": source}


def run_topic(name: str, stamp: str) -> str:
    """The topic one run lives in: the dispatcher's `run_topic()`, verbatim."""
    return f"{FIRE_PREFIX}{name}-{stamp}"


def parse_run_topic(topic: str) -> tuple[str, str] | None:
    """`(name, stamp)` of a run topic, or None for anything else."""
    match = RUN_TOPIC.match(topic)
    return (match.group("name"), match.group("stamp")) if match else None


def fire_line(
    name: str, stamp: str, instruction: str | None = None, previous: str | None = None
) -> str:
    """The one line that starts a run by hand, in the trigger's own shape.

    `devenv/routine/trigger.sh` is the other writer of this sentence and the
    contract between the two is `FIRE_LINE` plus the tests: a manual fire
    must be recognised as a fire by the same reader, and told apart from the
    dispatcher's by `MANUAL_MARK` alone. Front reads the rest exactly as it
    reads the trigger's, which is the point — a run started from the screen
    is the same run, not a different request. `previous` is the routine's
    last run topic, named the way the trigger names it.
    """
    text = (
        f"Routine `{name}`, run of {stamp}, {MANUAL_MARK}. "
        f"{TRIGGER_SENTENCE} #front › `{STANDING_PREFIX}{name}`. "
        f"This topic is this run alone; resolve it (✔) when the run is finished."
    )
    if previous:
        text += f" {PREVIOUS_MARK}`{previous}`."
    text += " Do it."
    extra = (instruction or "").strip()
    if extra:
        text += f"\n\nInstruction for this run: {extra}"
    return text


def previous_of(content: str) -> str | None:
    """The previous run topic a fire names, if it names one."""
    text = content or ""
    at = text.find(PREVIOUS_MARK)
    if at < 0:
        return None
    rest = text[at + len(PREVIOUS_MARK):]
    match = re.match(r"`?(?P<topic>[^`\s.]+(?:\.[^`\s.]+)*)`?", rest)
    return match.group("topic") if match else None


def fire_origin(content: str) -> str:
    """Who started this fire, as far as its own wording says.

    `manual` carries the operation room's mark; `scheduled` is the trigger's
    sentence without it; anything else that still matches `FIRE_LINE` is a
    fire somebody typed and is `unknown`. Not a guess from the sender — both
    writers post as the Developer.
    """
    text = content or ""
    if MANUAL_MARK in text:
        return "manual"
    if TRIGGER_SENTENCE in text:
        return "scheduled"
    return "unknown"


def _schedule_event_for(schedule: "Schedule | None", name: str, at: int) -> dict | None:
    """The dispatcher's fired event this post is the receipt of, if one is."""
    if schedule is None or not schedule.ok:
        return None
    best = None
    for event in schedule.events:
        if not isinstance(event, dict) or event.get("routine") != name:
            continue
        fired = _seconds(event.get("fired_at"))
        if fired is None or abs(fired - at) > SCHEDULE_MATCH_SECONDS:
            continue
        if best is None or abs(fired - at) < abs(best[1] - at):
            best = (event, fired)
    return None if best is None else {"id": best[0].get("id"), "fired_at": best[1]}


def resolution_of(run) -> dict:
    """Whether one run is finished, and what says so.

    `done` on the routine row means the fire got an answer; a run being
    *resolved* is a different sentence and a human's, made with Zulip's ✔ on
    the run's own topic (`operation_room` p7). One topic per run is what
    makes the flag the whole answer: there is no older session the flag
    could fail to describe, so there is no `unknown`.
    """
    if getattr(run, "resolved", False):
        return {"state": "resolved", "evidence": "the run topic carries ✔"}
    return {"state": "open", "evidence": "the run topic is not resolved"}


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
        runs = run_topics_of(topics, name)
        latest = runs[0] if runs else None
        history = list(getattr(latest, "history", []) or [])
        history.sort(key=lambda found: found.id)
        fire = fire_of(history, name)
        answer = answer_of(history, fire, now)
        request, strays = standing_request(getattr(standing, "history", None) or [])
        rows.append({
            "name": name,
            "display": display_of(name, request["text"] if request else None),
            # A ✔ on the standing request is the realm retiring the routine,
            # the same sentence a ✔ on an `intro-` topic makes about an agent.
            "retired": bool(standing is not None and standing.resolved),
            "request": request,
            "request_topic": f"{STANDING_PREFIX}{name}" if standing is not None else None,
            #: Posts in the standing-request topic by anybody but its author.
            #: Named rather than skipped: they are the reason the newest post
            #: is not the request, and a reader has to be able to see that.
            "request_strays": strays,
            #: The newest run topic — where a continuation goes, and the
            #: `Previous run:` the next fire will name.
            "latest_topic": latest.topic if latest is not None else None,
            "runs": len(runs),
            "open_runs": sum(1 for run in runs if not run.resolved),
            "posts": len(history),
            "last_fire": ({**_message(fire), "text": _excerpt(fire.content, 200)}
                          if fire is not None else None),
            "answer": answer,
            "state": _state(answer, stalled_seconds),
            "schedule": schedule_for(schedule, name, now),
        })
    # Assigned icons must not collide on one board: two routines wearing the
    # same symbol would defeat the point. Chosen icons are kept as chosen;
    # assigned ones step to the next free slot in name order.
    worn = {row["display"]["icon"] for row in rows if row["display"]["icon_source"] != "assigned"}
    for row in rows:
        display = row["display"]
        if display["icon_source"] != "assigned":
            continue
        display["icon"] = assigned_icon(row["name"], worn)
        worn.add(display["icon"])
    return rows


# --- the session tree ------------------------------------------------------


def children_of(topics: dict, key: tuple[str, str]) -> list[dict]:
    """Every conversation opened on behalf of `key`, and how that is known.

    Two edges, and both are needed because each one is blind where the other
    sees:

    - a **`[served]` note written in this topic** names a remote conversation
      whose callback this one's owner answered. It survives the remote being
      resolved, which matters because a resolved topic is never swept — most
      of a finished session is invisible without it.
    - a **`[rootchat]` note written in the remote** names this conversation as
      the home the remote was opened for. It exists from the remote's very
      first post, which is the whole of an in-flight session: nothing has been
      answered yet, so no served note has been written.

    Neither is ever rendered (constraint 4). This is the linking they are read
    for, and the reason the plan allows it.
    """
    found: dict[tuple[str, str], dict] = {}
    here = topics.get(key)
    if here is not None:
        for child, note in (getattr(here, "served", None) or {}).items():
            found[child] = {
                "channel": child[0], "topic": child[1],
                "via": "served", "link_id": note.get("first_note") or 0,
                "by": None,
            }
    for other_key, other in topics.items():
        if other_key == key:
            continue
        for home, sender_id, sender, note_id in getattr(other, "roots", None) or []:
            if (home.channel, home.topic) != key:
                continue
            existing = found.get(other_key)
            if existing is None or note_id < existing["link_id"]:
                found[other_key] = {
                    "channel": other_key[0], "topic": other_key[1],
                    "via": "rootchat", "link_id": note_id, "by": sender,
                }
    return sorted(found.values(), key=lambda child: child["link_id"])


def session_tree(
    topics: dict,
    root: tuple[str, str],
    rows_by_topic: dict,
    *,
    since: int,
    until: int | None,
    max_depth: int = MAX_DEPTH,
    max_nodes: int = MAX_NODES,
) -> dict:
    """The conversations of one fire, walked breadth-first from the fire topic.

    `since`/`until` are **message ids**, not times: the link notes carry ids,
    Zulip's ids are realm-wide and monotonic, and a fire's own id is therefore
    the cleanest boundary between one run of a routine and the next. A link
    recorded inside the window belongs to that run — including a note written
    late about an old callback, which is honest: the note *is* when this
    conversation started working there again.

    Depth and node caps exist because a cycle in the notes is possible (two
    agents anchoring each other) and a board is not the place to discover it.
    """
    nodes: list[dict] = []
    seen = {root}
    frontier = [(root, 0)]
    exhausted: set[str] = set()
    while frontier:
        key, depth = frontier.pop(0)
        for child in children_of(topics, key):
            child_key = (child["channel"], child["topic"])
            if child_key in seen:
                continue
            if child["link_id"] < since or (until is not None and child["link_id"] >= until):
                continue
            # Inspect only already-held link evidence. Reaching the exact cap
            # is not truncation unless an eligible unseen child was omitted.
            if depth >= max_depth:
                exhausted.add("depth")
                continue
            if len(nodes) >= max_nodes:
                exhausted.add("nodes")
                continue
            seen.add(child_key)
            found = topics.get(child_key)
            node = {
                **child,
                "depth": depth + 1,
                "parent": {"channel": key[0], "topic": key[1]},
                # A topic the sweep never read is one this board knows only by
                # the note that named it — usually because it carries a ✔ and
                # resolved topics are not swept. Saying which is the difference
                # between "quiet" and "not looked at", which is this whole
                # board's one rule.
                "known": "swept" if found is not None else "note-only",
                "resolved": bool(getattr(found, "resolved", False)) if found else None,
                "last_post": None,
                "rows": rows_by_topic.get(child_key, []),
            }
            last = getattr(found, "last", None) if found else None
            if last is not None:
                node["last_post"] = {
                    "message_id": last.id, "at": last.timestamp, "by": last.sender,
                }
            node["state"] = _node_state(node)
            nodes.append(node)
            frontier.append((child_key, depth + 1))
    return {
        "nodes": nodes,
        "truncation": {
            "truncated": bool(exhausted),
            "reasons": sorted(exhausted),
            "max_nodes": max_nodes,
            "max_depth": max_depth,
        },
    }


def _node_state(node: dict) -> str:
    """The node's state, taken from `/ops` and never recomputed.

    The ops board already decides what every conversation owes and explains
    what it decided it from; a second opinion here would be the drift p1's 66
    phantom rows came from. What is added is only what `/ops` has no row for:
    a topic nobody owes anything in is `quiet`, and one this board has never
    read is `unknown`.
    """
    if node["known"] == "note-only":
        return "unknown"
    rows = node.get("rows") or []
    if not rows:
        return "quiet"
    order = {"stalled": 0, "unknown": 1, "awaiting": 2, "acked": 3, "done": 4}
    return sorted(rows, key=lambda row: order.get(row["state"], 9))[0]["state"]


def session_of(
    topics: dict,
    run,
    name: str,
    rows_by_topic: dict,
    *,
    schedule: Schedule | None = None,
    now: float | None = None,
    index: int = 0,
) -> dict:
    """One run: the topic, its fire, its resolution, its chat and its tree."""
    now = time.time() if now is None else now
    history = sorted(getattr(run, "history", None) or [], key=lambda found: found.id)
    fire = fire_of(history, name)
    parsed = parse_run_topic(run.topic)
    stamp = parsed[1] if parsed else None
    if fire is not None:
        origin = fire_origin(fire.content)
        event = _schedule_event_for(schedule, name, fire.timestamp)
        evidence = _origin_evidence(origin, event)
        previous = previous_of(fire.content)
    else:
        origin, event, previous = "unknown", None, None
        evidence = ("no fire line in this run topic; it was opened by hand" if history
                    else "no post of this run topic is held")
    bounded = bool(getattr(run, "history_bounded", False))
    return {
        "id": fire.id if fire is not None else (history[0].id if history else None),
        "index": index,
        "topic": run.topic,
        "stamp": stamp,
        "fire": ({**_message(fire), "text": _excerpt(fire.content, 200)}
                 if fire is not None else None),
        "origin": origin,
        "origin_evidence": evidence,
        "schedule_event": event,
        "previous": previous,
        "answer": answer_of(history, fire, now),
        "resolution": resolution_of(run),
        "history": {
            "posts": len(history),
            "post_limit": ROUTINE_HISTORY,
            "bounded": bounded,
            "note": ("the newest posts of this run were read; older ones are not held"
                     if bounded else "every post of this run the realm holds is here"),
        },
        # Real posts, oldest first. Selfnotes never enter `history`, so there
        # is nothing to filter here and nothing that could leak.
        "chat": [{**_message(found), "content": found.content} for found in history],
        **session_tree(topics, (ROUTINE_CHANNEL, run.topic), rows_by_topic, since=0, until=None),
    }


def session_list(
    topics: dict,
    name: str,
    rows_by_topic: dict,
    *,
    schedule: Schedule | None = None,
    limit: int = SESSION_LIMIT,
    include_resolved: bool = True,
    now: float | None = None,
) -> dict:
    """The last `limit` runs of one routine, newest first, each a topic.

    `include_resolved=False` drops the ✔'d runs **before** the last `limit`
    are taken, so hiding three finished runs shows the three before them.
    `history` says how far back that could look: the sweep reads the newest
    `DEEP_RUNS` run topics of a routine even under ✔, and older runs only
    while they are open — so a resolved run older than that is in Zulip and
    not on this board.
    """
    runs = run_topics_of(topics, name)
    about = {
        "runs": len(runs),
        "open_runs": sum(1 for run in runs if not run.resolved),
        "session_limit": limit,
        "deep_runs": DEEP_RUNS,
        "hidden_resolved": 0,
        "note": (f"{len(runs)} run topic(s) held; the newest {DEEP_RUNS} are read whole, "
                 f"older ones only while open — a resolved run older than that is in "
                 f"Zulip, not here"),
    }
    chosen = []
    for run in runs:
        if not include_resolved and run.resolved:
            about["hidden_resolved"] += 1
            continue
        chosen.append(run)
        if len(chosen) >= limit:
            break
    sessions = [
        session_of(topics, run, name, rows_by_topic, schedule=schedule, now=now, index=index)
        for index, run in enumerate(chosen)
    ]
    latest_fire = None
    if runs:
        newest = sorted(getattr(runs[0], "history", None) or [], key=lambda found: found.id)
        fire = fire_of(newest, name)
        if fire is not None:
            latest_fire = {**_message(fire), "text": _excerpt(fire.content, 200)}
    return {
        "sessions": sessions,
        "latest_topic": runs[0].topic if runs else None,
        "latest_fire": latest_fire,
        "history": about,
    }


def _origin_evidence(origin: str, event: dict | None) -> str:
    if origin == "manual":
        return "the fire carries the operation room's mark"
    if origin == "scheduled":
        if event:
            return f"the trigger's wording, and schedule event {event['id']} fired at the same time"
        return "the trigger's wording; no fired schedule event within reach matches its time"
    if event:
        return f"unfamiliar wording, but schedule event {event['id']} fired at the same time"
    return "unfamiliar wording and no matching schedule event"


def sessions_of(
    topics: dict,
    name: str,
    rows_by_topic: dict,
    *,
    limit: int = SESSION_LIMIT,
    now: float | None = None,
) -> list[dict]:
    """`session_list` without the filter: every session, newest first."""
    return session_list(topics, name, rows_by_topic, limit=limit, now=now)["sessions"]


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
