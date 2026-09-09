"""Routines, as the realm describes them since `refine_routine` p1.

A routine is a **guide** kept in Zulip and the **runs** made of it:

- one public channel per routine, `#routine-<name>`, filed in the `routine`
  channel folder;
- its fixed `guide` topic — the **newest post there is the whole guide**; a
  new version is a new full post, never an edit, and no agent posts there;
- one `routinerun-<id>` topic per run, in the same channel, opened by Front
  with a single opening post (the request as it was made, the conditions as
  Front read them, the guide post it read, and where the request came from)
  and then owned by Front: its entries are Front's own record, its
  delegations are anchored to it by root notes, and the listener resolves it
  (✔) when the run ends with an `ag-routinerun` finish block.

There is no schedule any more and no fire line: a run starts because
somebody asked Front for it, and the opening post is that ask, recorded.
The old `#front › routine-<name>` / `front-routine-<name>-<stamp>` layout is
gone with the dispatcher (`refine_routine` p1 step 1).

Nothing in this module talks to Zulip. It is given the topics the `/ops`
engine already holds — the sweep and its event queue are the only realm
readers this service has, and a second one would be the polling
`operation_room` p1 measured a 429 for.

**What the board asks of a run** is where it stands, read off its own topic:
`unstarted` (the opening post and nothing else — the listener has not served
it yet), `acked` (a serving is under way), `waiting` (Front wrote its entry
and is waiting on what it delegated), `awaiting`/`stalled` (somebody else
posted into the run and Front owes an answer — the ops board's own words),
`finished` (the finish block is there, or the topic carries ✔). Ending a run
and reaching the routine's goal are two different sentences: the finish
block says `achieved` for the second.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from typing import Iterable

from agag.agent import is_ack

from .room import bare_topic

#: The channel folder every routine channel is filed in.
ROUTINE_FOLDER = "routine"
#: One channel per routine: `routine-<name>`.
ROUTINE_CHANNEL_PREFIX = "routine-"
#: The fixed topic holding the guide.
GUIDE_TOPIC = "guide"
#: One topic per run, opened by Front in the routine's channel. Front's own
#: sweep prefix (`agfront.instance.ROUTINE_RUN_PREFIX`), which is what makes
#: a post there a request to Front.
RUN_PREFIX = "routinerun-"
#: The finish block a run ends with (`agfront.routine`): one fenced
#: `ag-routinerun` JSON object at the end of Front's last entry, saying
#: whether the routine's goal was reached, why the run ends, and the report
#: that was delivered to the requester.
FINISH_FENCE = "ag-routinerun"
FINISH_SCHEMA = "ag.routinerun-finish.v1"
FINISH_BLOCK = re.compile(r"```[ \t]*" + re.escape(FINISH_FENCE) + r"[ \t]*\n(.*?)\n[ \t]*```", re.DOTALL)
#: Optional display metadata, one line anywhere in the guide:
#: `display: 📰 Papers digest`. The guide is the document the Developer
#: edits for the routine, so a title lives where the routine is defined and
#: travels with its version.
DISPLAY_LINE = re.compile(r"^\s*display:\s*(?P<value>\S.*?)\s*$", re.IGNORECASE | re.MULTILINE)
#: A markdown heading as the first line is the next best title.
HEADING_LINE = re.compile(r"^\s*#{1,3}\s+(?P<value>\S.*?)\s*$")
#: A leading emoji (or other symbol) on either of the above becomes the icon.
LEADING_SYMBOL = re.compile(r"^(?P<icon>[^\w\s`*#][️‍]?(?:[^\w\s`*#][️]?)?)\s+(?P<rest>.+)$")
#: Icons assigned when the guide names none: picked by the routine's name,
#: so a routine keeps its icon across restarts and screens.
ASSIGNED_ICONS = ("🔁 📌 🧭 🛰 🧪 📦 🗂 🔔 🪄 🧵 🎯 🧰 🌱 🔭 🎲 🧲 🪁 🗝 🧊 🎨 "
                  "🛠 🧯 🪐 🧿").split()
#: Sessions listed for one routine. About three: a fourth is a drill-down.
SESSION_LIMIT = 3
#: Caps on the walk. A cycle in the link notes is possible — two agents can
#: anchor each other — and a board is not where that should be discovered.
MAX_DEPTH = 4
MAX_NODES = 40
#: Messages kept per deep-read routine topic.
ROUTINE_HISTORY = 200
#: Run topics per routine the sweep reads deep and reads even under ✔ — a
#: finished run is resolved by the listener, so a board that skipped ✔ runs
#: would never show one finishing. Older runs are ordinary topics.
DEEP_RUNS = SESSION_LIMIT

__all__ = [
    "DEEP_RUNS",
    "FINISH_FENCE",
    "FINISH_SCHEMA",
    "GUIDE_TOPIC",
    "MAX_DEPTH",
    "MAX_NODES",
    "ROUTINE_CHANNEL_PREFIX",
    "ROUTINE_FOLDER",
    "ROUTINE_HISTORY",
    "RUN_PREFIX",
    "SESSION_LIMIT",
    "children_of",
    "display_of",
    "finish_of",
    "guide_of",
    "is_guide_topic",
    "is_routine_channel",
    "is_routine_topic",
    "is_run_topic",
    "newest_run_topics",
    "opening_of",
    "origin_of",
    "resolution_of",
    "routine_channel",
    "routine_name",
    "routine_rows",
    "run_state",
    "run_topics_of",
    "session_list",
    "session_of",
    "session_tree",
    "sessions_of",
]


# --- names -------------------------------------------------------------------


def is_routine_channel(channel: str) -> bool:
    return channel.startswith(ROUTINE_CHANNEL_PREFIX) and len(channel) > len(ROUTINE_CHANNEL_PREFIX)


def routine_name(channel: str) -> str | None:
    """The routine a channel belongs to, or None."""
    return channel[len(ROUTINE_CHANNEL_PREFIX):] if is_routine_channel(channel) else None


def routine_channel(name: str) -> str:
    return f"{ROUTINE_CHANNEL_PREFIX}{name}"


def is_run_topic(topic: str) -> bool:
    return bare_topic(topic).startswith(RUN_PREFIX)


def is_guide_topic(topic: str) -> bool:
    return bare_topic(topic) == GUIDE_TOPIC


def is_routine_topic(channel: str, topic: str) -> bool:
    """Whether this conversation is part of a routine's paper trail: its
    guide, or one of its run topics."""
    return is_routine_channel(channel) and (is_run_topic(topic) or is_guide_topic(topic))


def run_topics_of(topics: dict, name: str) -> list:
    """This routine's run topics the engine holds, newest first.

    Newest by the id of the oldest held post — the opening post when the
    topic was read deep — and by the newest post when nothing older is held:
    a run's id is chosen by Front and says nothing about order, and Zulip's
    message ids do.
    """
    channel = routine_channel(name)
    found = []
    for (held_channel, topic), held in topics.items():
        if held_channel != channel or not is_run_topic(topic):
            continue
        history = getattr(held, "history", None) or []
        last = getattr(held, "last", None)
        first_id = history[0].id if history else (last.id if last is not None else 0)
        found.append((first_id, topic, held))
    found.sort(key=lambda row: (row[0], row[1]), reverse=True)
    return [held for _, _, held in found]


def newest_run_topics(names: Iterable[str], per_routine: int = DEEP_RUNS) -> set[str]:
    """Of one routine channel's topic names, **in the realm's listing order
    (newest activity first)**, the run topics the sweep reads deep and reads
    even under ✔."""
    chosen: set[str] = set()
    for live in names:
        bare = bare_topic(live)
        if is_run_topic(bare):
            chosen.add(bare)
            if len(chosen) >= per_routine:
                break
    return chosen


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


def _sorted(history: Iterable) -> list:
    return sorted(history, key=lambda found: found.id)


def guide_of(history: Iterable) -> dict | None:
    """The guide: the newest post in the `guide` topic, whole.

    The rule is stated in every guide's first paragraph and in the channel
    description, and it is deliberately not "the newest post by the author":
    a guide is a document nobody answers in, and a post there by anybody is a
    new version by construction. `posts` and `authors` are carried so a
    reader can see when that assumption was broken.
    """
    posts = _sorted(history)
    if not posts:
        return None
    newest = posts[-1]
    return {
        **_message(newest),
        "text": newest.content.strip(),
        "posts": len(posts),
        "authors": sorted({found.sender for found in posts}),
    }


def opening_of(history: Iterable) -> dict | None:
    """The opening post of a run: its oldest real post, whole."""
    posts = _sorted(history)
    if not posts:
        return None
    return {**_message(posts[0]), "text": posts[0].content.strip()}


def origin_of(run) -> dict | None:
    """Where the run was requested from: the conversation Front's own root
    note in the run topic names (`agfront.routine.origin_of`), or None for a
    run opened by hand.

    The earliest note wins, as everywhere: a run is opened once.
    """
    roots = getattr(run, "roots", None) or []
    if not roots:
        return None
    home, sender_id, sender, note_id = roots[0]
    return {"channel": home.channel, "topic": home.topic, "by": sender, "by_id": sender_id,
            "message_id": note_id}


def _parse_finish(body: str) -> dict | None:
    try:
        data = json.loads(body)
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("schema") != FINISH_SCHEMA:
        return None
    if not isinstance(data.get("achieved"), bool):
        return None
    return {"achieved": data["achieved"], "reason": str(data.get("reason") or "").strip(),
            "report": str(data.get("report") or "").strip()}


def finish_of(history: Iterable) -> dict | None:
    """How the run ended, if it did: the newest post carrying a usable finish
    block, with the block's verdict and where it was said."""
    for found in reversed(_sorted(history)):
        blocks = FINISH_BLOCK.findall(found.content or "")
        if not blocks:
            continue
        parsed = _parse_finish(blocks[-1].strip())
        if parsed is not None:
            return {**parsed, **_message(found)}
    return None


def resolution_of(run) -> dict:
    """Whether the run topic carries Zulip's ✔ — the listener's own mark on a
    finished run, or a human's."""
    if getattr(run, "resolved", False):
        return {"state": "resolved", "evidence": "the run topic carries ✔"}
    return {"state": "open", "evidence": "the run topic is not resolved"}


def run_state(history: Iterable, run, now: float, *, stalled_seconds: float) -> dict:
    """Where the run stands, from its own posts, with the evidence.

    Front owns the run topic, so the ops board's owner rule applies to it:
    Front owes nothing while its own entry is the last post, and owes an
    answer when somebody else posted after it. What is added is the run's
    own vocabulary — `unstarted`, `waiting`, `finished`.
    """
    posts = _sorted(history)
    resolved = bool(getattr(run, "resolved", False))
    finish = finish_of(posts)
    if finish is not None or resolved:
        evidence = ("the finish block is in the run's last entry" if finish is not None
                    else "the run topic carries ✔ and no finish block was found")
        if finish is not None and resolved:
            evidence = "the finish block is there and the run topic carries ✔"
        return {"state": "finished", "evidence": evidence, "age_seconds": None}
    if not posts:
        return {"state": "unknown", "evidence": "no post of this run is held", "age_seconds": None}
    opener = posts[0].sender_id
    last = posts[-1]
    age = round(now - last.timestamp, 1)
    if all(found.sender_id == opener for found in posts) and not any(is_ack(f.content) for f in posts):
        return {"state": "unstarted", "age_seconds": age,
                "evidence": f"only the opening post (by {posts[0].sender}) and nothing served it yet"}
    if is_ack(last.content):
        return {"state": "acked", "age_seconds": age,
                "evidence": f"Front's ack #{last.id} is the newest post: a serving is under way"}
    entries = [found for found in posts if found.sender == "Front" and not is_ack(found.content)]
    if entries and last.id == entries[-1].id:
        return {"state": "waiting", "age_seconds": age,
                "evidence": f"Front's entry #{last.id} is the newest post; it waits on what it delegated"}
    state = "stalled" if age >= stalled_seconds else "awaiting"
    return {"state": state, "age_seconds": age,
            "evidence": f"{last.sender}'s post #{last.id} is the newest and Front has not answered it"}


def assigned_icon(name: str, taken: set[str] | None = None) -> str:
    """The icon a routine gets from its name alone (FNV-1a over the name)."""
    digest = 0x811C9DC5
    for byte in name.encode("utf-8"):
        digest = ((digest ^ byte) * 0x01000193) & 0xFFFFFFFF
    slot = digest % len(ASSIGNED_ICONS)
    for offset in range(len(ASSIGNED_ICONS)):
        icon = ASSIGNED_ICONS[(slot + offset) % len(ASSIGNED_ICONS)]
        if not taken or icon not in taken:
            return icon
    return ASSIGNED_ICONS[slot]


def display_of(name: str, guide_text: str | None) -> dict:
    """How a routine is shown: an icon, a title, and where each came from.

    A `display:` line in the guide wins, then a first-line heading, then the
    name — a routine nobody has titled is still usable and recognisable.
    """
    text = guide_text or ""
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


# --- the board -------------------------------------------------------------


def _run_summary(run, name: str, now: float, *, stalled_seconds: float) -> dict:
    history = _sorted(getattr(run, "history", None) or [])
    opening = opening_of(history)
    finish = finish_of(history)
    return {
        "channel": routine_channel(name),
        "topic": run.topic,
        "opened": {**opening, "text": _excerpt(opening["text"], 200)} if opening else None,
        "origin": origin_of(run),
        "finish": ({"achieved": finish["achieved"], "reason": finish["reason"],
                    "message_id": finish["message_id"], "at": finish["at"]} if finish else None),
        "resolution": resolution_of(run),
        "run": run_state(history, run, now, stalled_seconds=stalled_seconds),
        "posts": len(history),
    }


def routine_rows(
    topics: dict,
    now: float,
    *,
    stalled_seconds: float,
    channels: Iterable[str] = (),
) -> list[dict]:
    """One row per routine channel the realm holds.

    `topics` is keyed `(channel, bare topic)` — the engine's own map, passed
    in rather than re-read. `channels` adds routine channels that hold no
    topic yet, so a freshly made routine is on the board before its guide.
    """
    names: set[str] = set()
    for channel, _topic in topics:
        found = routine_name(channel)
        if found:
            names.add(found)
    for channel in channels:
        found = routine_name(channel)
        if found:
            names.add(found)

    rows = []
    for name in sorted(names):
        channel = routine_channel(name)
        guide_topic = topics.get((channel, GUIDE_TOPIC))
        guide = guide_of(getattr(guide_topic, "history", None) or []) if guide_topic else None
        runs = run_topics_of(topics, name)
        latest = _run_summary(runs[0], name, now, stalled_seconds=stalled_seconds) if runs else None
        retired = bool(guide_topic is not None and guide_topic.resolved)
        if retired:
            state = "retired"
        elif latest is None:
            state = "idle"
        else:
            state = latest["run"]["state"]
        rows.append({
            "name": name,
            "channel": channel,
            "display": display_of(name, guide["text"] if guide else None),
            # A ✔ on the guide is the realm retiring the routine, the same
            # sentence a ✔ on an `intro-` topic makes about an agent.
            "retired": retired,
            "guide": guide,
            "guide_topic": GUIDE_TOPIC if guide_topic is not None else None,
            "runs": len(runs),
            "open_runs": sum(1 for run in runs if not run.resolved),
            "latest": latest,
            "latest_topic": runs[0].topic if runs else None,
            "state": state,
        })
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
      resolved, which matters because a resolved topic is never swept.
    - a **`[rootchat]` note written in the remote** names this conversation as
      the home the remote was opened for. It exists from the remote's very
      first post, which is the whole of an in-flight session.

    Neither is ever rendered. This is the linking they are read for.
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
    """The conversations of one run, walked breadth-first from the run topic.

    `since`/`until` are **message ids**: the link notes carry ids, Zulip's
    ids are realm-wide and monotonic. Depth and node caps exist because a
    cycle in the notes is possible and a board is not the place to discover
    it.
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
                # the note that named it — usually because it carries a ✔.
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
    """The node's state, taken from `/ops` and never recomputed."""
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
    now: float | None = None,
    index: int = 0,
    stalled_seconds: float = 900.0,
) -> dict:
    """One run: its topic, its opening, its origin, its state, its finish,
    its chat and its tree — everything the board says about a run, so the
    requester, the conditions, the progress, what is waited on, the result
    and the end reason can all be reached from one payload."""
    now = time.time() if now is None else now
    history = _sorted(getattr(run, "history", None) or [])
    channel = routine_channel(name)
    opening = opening_of(history)
    finish = finish_of(history)
    entries = [found for found in history if found.sender == "Front" and not is_ack(found.content)]
    last_entry = entries[-1] if entries else None
    bounded = bool(getattr(run, "history_bounded", False))
    return {
        "id": history[0].id if history else None,
        "index": index,
        "channel": channel,
        "topic": run.topic,
        "opened": opening,
        "origin": origin_of(run),
        "entries": len(entries),
        "last_entry": ({**_message(last_entry), "excerpt": _excerpt(last_entry.content)}
                       if last_entry is not None else None),
        "finish": finish,
        "resolution": resolution_of(run),
        "run": run_state(history, run, now, stalled_seconds=stalled_seconds),
        "history": {
            "posts": len(history),
            "post_limit": ROUTINE_HISTORY,
            "bounded": bounded,
            "note": ("the newest posts of this run were read; older ones are not held"
                     if bounded else "every post of this run the realm holds is here"),
        },
        # Real posts, oldest first. Selfnotes never enter `history`.
        "chat": [{**_message(found), "content": found.content} for found in history],
        **session_tree(topics, (channel, run.topic), rows_by_topic, since=0, until=None),
    }


def session_list(
    topics: dict,
    name: str,
    rows_by_topic: dict,
    *,
    limit: int = SESSION_LIMIT,
    include_resolved: bool = True,
    now: float | None = None,
    stalled_seconds: float = 900.0,
) -> dict:
    """The last `limit` runs of one routine, newest first.

    `include_resolved=False` drops the ✔'d runs **before** the last `limit`
    are taken. `history` says how far back that could look: the sweep reads
    the newest `DEEP_RUNS` run topics of a routine even under ✔, and older
    runs only while they are open.
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
        session_of(topics, run, name, rows_by_topic, now=now, index=index,
                   stalled_seconds=stalled_seconds)
        for index, run in enumerate(chosen)
    ]
    return {
        "sessions": sessions,
        "latest_topic": runs[0].topic if runs else None,
        "history": about,
    }


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
