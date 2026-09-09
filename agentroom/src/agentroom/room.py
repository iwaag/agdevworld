"""What the agent room knows, read live from Zulip on every request.

Nothing here is written to disk. The plan for this view rules out the
snapshot-file shape the cluster views use (`public/cluster/*.json`), so the
only state is the process-lifetime cache in `Room`.

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

import time
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock

from agag.selfnote import SELFNOTE_MARKER, is_selfnote
from agag.zulip import RESOLVED_TOPIC_PREFIX, ZulipClient

#: The shared channel every agent posts its own introduction to.
AGENTS_CHANNEL = "agents"
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


@dataclass
class Room:
    """A Zulip reader with a short process-lifetime cache.

    The cache is not a snapshot: it is only there so a browser that reloads
    the view twice in a row does not spend a second full sweep of the realm.
    `ttl_seconds = 0` turns it off.
    """

    env_path: Path
    ttl_seconds: float = 30.0
    intro_history: int = 20
    _lock: Lock = field(default_factory=Lock, repr=False)
    _cache: dict = field(default_factory=dict, repr=False)

    def client(self) -> ZulipClient:
        return ZulipClient.from_env(self.env_path)

    # -- caching ---------------------------------------------------------

    def _cached(self, key: str, build):
        if self.ttl_seconds <= 0:
            return build()
        with self._lock:
            hit = self._cache.get(key)
            if hit and time.monotonic() - hit[0] < self.ttl_seconds:
                return hit[1]
        value = build()
        with self._lock:
            self._cache[key] = (time.monotonic(), value)
        return value

    def agents(self) -> dict:
        return self._cached("agents", self._read_agents)

    def work(self, include_resolved: bool = False) -> dict:
        """Every board's open topics; with `include_resolved`, its ✔ ones
        too, each row saying which (`front_desk` p4: a finished request is
        completed from the agent room, and finished means resolved)."""
        if include_resolved:
            return self._cached("work+resolved", lambda: self._read_work(True))
        return self._cached("work", self._read_work)

    # -- reads -----------------------------------------------------------

    def _intro_topics(self, client: ZulipClient) -> tuple[list[tuple[str, str]], list[str]]:
        """`(topic, instance)` for every live introduction in `#agents`, and
        the instances that have been retired.

        Matched after the `\u2714 ` prefix is removed, so a resolved
        introduction topic is still recognised as an agent — but since
        `operation_room` p2 ex2 it is recognised as a **retired** one. An
        introduction is the contract that says an agent exists and how to
        reach it, so the realm's way of saying an agent is gone is to resolve
        that topic; there is no other signal, because a project can disappear
        from every machine without the realm noticing.
        """
        stream_id = client.stream_id(AGENTS_CHANNEL)
        found: list[tuple[str, str]] = []
        retired: list[str] = []
        for topic in client.channel_topics(stream_id):
            name = bare_topic(topic)
            if not name.startswith(INTRO_PREFIX):
                continue
            instance = name[len(INTRO_PREFIX):]
            if unresolved(topic):
                found.append((topic, instance))
            else:
                retired.append(instance)
        return found, sorted(retired)

    def _read_agents(self) -> dict:
        client = self.client()
        channel_names = {channel["name"] for channel in client.channels()}
        agents = []
        live, retired = self._intro_topics(client)
        for topic, instance in live:
            posts = _readable(client.topic_history(AGENTS_CHANNEL, topic, self.intro_history))
            agents.append({
                "instance": instance,
                "topic": topic,
                # The entrance is the instance's own channel where one exists.
                # It is stated in the introduction too; this is only the link.
                "entrance": instance if instance in channel_names else None,
                "intro": posts[-1] if posts else None,
                "history": posts,
            })
        agents.sort(key=lambda agent: agent["instance"])
        # `retired` is named rather than merely missing: a reader has to be
        # able to tell an agent that was retired on purpose from one that was
        # never there.
        return {
            "channel": AGENTS_CHANNEL,
            "agents": agents,
            "retired": retired,
            "calls": client.calls,
        }

    def _read_work(self, include_resolved: bool = False) -> dict:
        """Every unresolved topic of every board an agent works on, flat.

        Two kinds of board, because work lives in two places:

        - a **project**: the `pj-<slug>` channel, plus the `work-<label>`
          channels autolab opens for its tasks. Those are linked to the project
          by their **channel folder**, not by their name — a project channel
          files itself and its `work-` channels inherit the folder — which is
          the only machine-readable link back (see `agautolab/project_archive.py`
          for the naming rules themselves).
        - an **agent**: the instance's own channel, where forge's
          `assetplan-`/`assetrun-` topics and every question put to an agent
          live. Nothing in a `pj-` channel would ever show those.

        What counts as open is Zulip's `\u2714 ` rename and nothing else. Topic
        naming differs per agent; resolution does not.
        """
        client = self.client()
        channels = client.channels()
        by_name = {channel["name"]: channel for channel in channels}
        projects = {
            channel["folder_id"]: channel["name"]
            for channel in channels
            if channel["name"].startswith(PROJECT_PREFIX) and channel.get("folder_id") is not None
        }
        # (channel, kind, group) — `group` is what the row is filed under.
        watched: list[tuple[dict, str, str]] = []
        for channel in sorted(channels, key=lambda c: c["name"]):
            name = channel["name"]
            if name.startswith(PROJECT_PREFIX):
                watched.append((channel, "project", name))
            elif name.startswith(WORK_PREFIX) and channel.get("folder_id") in projects:
                watched.append((channel, "project", projects[channel["folder_id"]]))
        # A retired agent's channel is not a board any more: its introduction
        # is resolved, so nothing is expected to answer there. The live half
        # is the only half this walks.
        introduced, _retired = self._intro_topics(client)
        for _, instance in introduced:
            channel = by_name.get(instance)
            if channel is not None:
                watched.append((channel, "agent", instance))

        rows: list[dict] = []
        errors: list[dict] = []
        for channel, kind, group in watched:
            try:
                topics = client.channel_topics(int(channel["stream_id"]))
            except Exception as error:  # one unreadable channel must not empty the view
                errors.append({"channel": channel["name"], "error": str(error)})
                continue
            for topic in topics:
                if not unresolved(topic) and not include_resolved:
                    continue
                rows.append({
                    "channel": channel["name"],
                    "topic": topic,
                    "kind": kind,
                    "group": group,
                    "stream_id": int(channel["stream_id"]),
                    "resolved": not unresolved(topic),
                })
        return {
            "channels": [channel["name"] for channel, _, _ in watched],
            "topics": rows,
            "errors": errors,
            "calls": client.calls,
            "include_resolved": include_resolved,
        }
