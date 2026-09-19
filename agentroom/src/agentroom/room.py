"""What the agent room knows, answered from the mirror.

Until `better_zulip_call` p1 this module read Zulip live on every request
behind a 30-second cache that every completion cleared: a cold reload was
36 calls on the Developer's 200-a-minute quota, and nine closes in twelve
minutes were 1,800 calls and 250 refusals. Now every read here is a query
of the process's `agag.mirror` — the persisted, event-updated copy of the
realm — and costs no Zulip call at all. There is no cache to forget, because
there is nothing to re-read: a completion's writes come back as events and
the next read sees them.

Two things are deliberately *not* re-implemented:

- the resolved-topic marker. `agag.zulip.RESOLVED_TOPIC_PREFIX` is the one
  definition of Zulip's `✔ ` rename, and a second copy of it here would drift
  — which has already cost this system a mission (`README_DEV.md`, the p9
  callback lost to a rename a lookup could not see past).
- `[selfnote]` recognition. `agag.selfnote.is_selfnote` decides what is
  machine-to-machine, and this relay hides exactly what `agentchat read`
  hides, for the same reason: a selfnote is bookkeeping, not something an
  agent said.
"""

from __future__ import annotations

from dataclasses import dataclass

from agag.mirror import Mirror
from agag.selfnote import SELFNOTE_MARKER, is_selfnote
from agag.zulip import RESOLVED_TOPIC_PREFIX

#: The shared channel every agent posts its own introduction to.
AGENTS_CHANNEL = "agents"
#: Front's entrance channel and the Front Desk's topic prefix, here so the
#: modules that write there (`chat`) and the one that reads it (`frontdesk`)
#: share them without importing each other.
FRONT_CHANNEL = "front"
DESK_PREFIX = "front-desk-"

#: The append-only topic prefix that introduction lives under.
INTRO_PREFIX = "intro-"
#: A project's own channel, and the channels its work is carried out in.
PROJECT_PREFIX = "pj-"
WORK_PREFIX = "work-"
#: Zulip's own bots (Notification Bot and friends) live in this realm string.
SYSTEM_REALM = "zulipinternal"


def unresolved(topic: str) -> bool:
    """True when a topic has not been marked resolved."""
    return not topic.startswith(RESOLVED_TOPIC_PREFIX)


def bare_topic(topic: str) -> str:
    """The topic's name without Zulip's resolve marker."""
    return topic[len(RESOLVED_TOPIC_PREFIX):] if topic.startswith(RESOLVED_TOPIC_PREFIX) else topic


def strip_selfnotes(content: str) -> str:
    """Drop `[selfnote]` lines from a message body.

    Whole selfnote messages are dropped earlier; this catches the case of a
    note that was written into an otherwise ordinary post, because the view
    must never show one either way.
    """
    kept = [line for line in content.splitlines() if not line.lstrip().startswith(SELFNOTE_MARKER)]
    return "\n".join(kept).strip()


def _is_system(message: dict) -> bool:
    return message.get("sender_realm_str") == SYSTEM_REALM


def _post(message: dict) -> dict:
    return {
        "id": int(message["id"]),
        "sender": message.get("sender_full_name", ""),
        "timestamp": int(message.get("timestamp", 0)),
        "content": strip_selfnotes(message.get("content", "")),
    }


def _readable(messages: list[dict]) -> list[dict]:
    """The posts a human is meant to see: no selfnotes, no Zulip notices,
    nothing left empty once the notes are stripped."""
    posts = [
        _post(message)
        for message in messages
        if not is_selfnote(message.get("content", "")) and not _is_system(message)
    ]
    return [post for post in posts if post["content"]]


def health_block(mirror: Mirror | None) -> dict:
    """What a view needs to know before it trusts a payload: whether the
    copy is live, and since when it is not. A stale mirror still answers —
    with the last good copy — and the block says so beside the data."""
    if mirror is None:
        return {"state": "unknown", "reason": "no mirror is configured", "stale_since": None,
                "revision": 0, "last_event_at": None, "resyncs": 0}
    found = mirror.health()
    return {
        "state": "live" if found["state"] == "live" else "stale",
        "reason": found["reason"],
        "stale_since": found["stale_since"],
        "revision": found["revision"],
        "last_event_at": found["last_event_at"],
        "resyncs": found["resyncs"],
        # What the mirror has spent on Zulip since it started: a board that
        # costs nothing to re-read shows the same number after every reload.
        "calls": int(found.get("calls") or 0),
    }


@dataclass
class Room:
    """The agent room's two boards, from the mirror."""

    mirror: Mirror
    intro_history: int = 20

    def agents(self) -> dict:
        """Every live introduction in `#agents`, and the retired instances.

        Matched after the `✔ ` prefix is removed, so a resolved introduction
        topic is still recognised as an agent — but as a **retired** one. An
        introduction is the contract that says an agent exists and how to
        reach it, so the realm's way of saying an agent is gone is to resolve
        that topic; there is no other signal.
        """
        channel_names = {channel.name for channel in self.mirror.channels()}
        agents = []
        retired = []
        for instance, intro in sorted(self.mirror.intros(AGENTS_CHANNEL, INTRO_PREFIX).items()):
            if intro.retired:
                retired.append(instance)
                continue
            posts = _readable([m.as_zulip() for m in intro.history])[-self.intro_history:]
            agents.append({
                "instance": instance,
                "topic": intro.topic,
                # The entrance is the instance's own channel where one exists.
                # It is stated in the introduction too; this is only the link.
                "entrance": instance if instance in channel_names else None,
                "intro": posts[-1] if posts else None,
                "history": posts,
            })
        return {
            "channel": AGENTS_CHANNEL,
            "agents": agents,
            # `retired` is named rather than merely missing: a reader has to be
            # able to tell an agent that was retired on purpose from one that
            # was never there.
            "retired": sorted(retired),
            "health": health_block(self.mirror),
        }

    def work(self, include_resolved: bool = False) -> dict:
        """Every board's open topics; with `include_resolved`, its ✔ ones
        too, each row saying which (`front_desk` p4: a finished request is
        completed from the agent room, and finished means resolved).

        Two kinds of board, because work lives in two places:

        - a **project**: the `pj-<slug>` channel, plus the `work-<label>`
          channels autolab opens for its tasks. Those are linked to the project
          by their **channel folder**, not by their name — a project channel
          files itself and its `work-` channels inherit the folder — which is
          the only machine-readable link back.
        - an **agent**: the instance's own channel, where forge's
          `assetplan-`/`assetrun-` topics and every question put to an agent
          live. Nothing in a `pj-` channel would ever show those.

        `#front` belongs to whoever declares a prefix its topics carry — read
        off the roster block of each live introduction, never guessed.

        What counts as open is Zulip's `✔ ` rename and nothing else.
        """
        channels = self.mirror.channels()
        by_name = {channel.name: channel for channel in channels}
        projects = {
            channel.folder_id: channel.name
            for channel in channels
            if channel.name.startswith(PROJECT_PREFIX) and channel.folder_id is not None
        }
        # (channel, kind, group) — `group` is what the row is filed under.
        watched: list[tuple] = []
        for channel in sorted(channels, key=lambda c: c.name):
            if channel.name.startswith(PROJECT_PREFIX):
                watched.append((channel, "project", channel.name))
            elif channel.name.startswith(WORK_PREFIX) and channel.folder_id in projects:
                watched.append((channel, "project", projects[channel.folder_id]))
        intros = self.mirror.intros(AGENTS_CHANNEL, INTRO_PREFIX)
        live = {instance: intro for instance, intro in intros.items() if not intro.retired}
        # A retired agent's channel is not a board any more: its introduction
        # is resolved, so nothing is expected to answer there.
        for instance in sorted(live):
            channel = by_name.get(instance)
            if channel is not None:
                watched.append((channel, "agent", instance))
        prefixed = [(instance, tuple(intro.roster.prefixes))
                    for instance, intro in sorted(live.items())
                    if intro.roster is not None and intro.roster.prefixes]
        front = by_name.get(FRONT_CHANNEL)

        rows: list[dict] = []
        for channel, kind, group in watched:
            for index in self.mirror.topics(channel.name, include_resolved=include_resolved):
                rows.append({
                    "channel": channel.name,
                    "topic": index.live_name,
                    "kind": kind,
                    "group": group,
                    "stream_id": channel.stream_id,
                    "resolved": index.resolved,
                })
        if front is not None:
            for index in self.mirror.topics(FRONT_CHANNEL, include_resolved=include_resolved):
                owner = next((instance for instance, prefixes in prefixed
                              if index.name.startswith(prefixes)), None)
                if owner is None:
                    continue
                rows.append({
                    "channel": FRONT_CHANNEL, "topic": index.live_name, "kind": "agent", "group": owner,
                    "stream_id": front.stream_id, "resolved": index.resolved,
                })
        return {
            "channels": [channel.name for channel, _, _ in watched]
                        + ([FRONT_CHANNEL] if front is not None else []),
            "topics": rows,
            "include_resolved": include_resolved,
            "health": health_block(self.mirror),
        }
