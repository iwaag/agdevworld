"""The completion walk's realm, answered by the mirror.

`closing.Reader` asks a `Realm` four things — a topic's history, a channel's
stream id, a channel's topic names, the channel list — and until
`better_zulip_call` p1 every one of them was a Zulip call made with the
Developer's credential: 46 topic reads for one preview of a 29-target
request, three times per close. The mirror holds every public conversation
whole, so the same four questions are answered from the store, and a topic
whose coverage is not complete is hydrated once rather than read every time.

The shapes the walk relies on are kept exactly:

- a topic is read under **the name given** (`closing.Reader.history` asks
  for the bare and the ✔ name separately and merges them itself, which is
  how it recognises a twin);
- `stream_id` of a channel the realm no longer lists **raises**, as Zulip's
  `get_stream_id` answered 400 — that is how `closing` tells "archived"
  from "unreadable", by asking `channels()` afterwards;
- `channels()` lists live channels only, as `GET /streams` does.
"""

from __future__ import annotations

from agag.mirror import Mirror
from agag.zulip import RESOLVED_TOPIC_PREFIX

__all__ = ["MirrorRealm"]


class MirrorRealm:
    """`closing.Realm` over a mirror. Zero Zulip calls while coverage is
    complete; one hydrate per incomplete topic; nothing else."""

    def __init__(self, mirror: Mirror):
        self.mirror = mirror

    def topic_history(self, channel: str, topic: str, num_before: int = 50) -> list[dict]:
        if self.mirror.store.channel(channel) is None:
            raise LookupError(f"no channel named {channel!r}")
        return self.mirror.history(channel, topic, num_before=num_before, across_resolve=False, hydrate=True)

    def stream_id(self, name: str) -> int:
        found = self.mirror.channel(name)
        if found is None or found.archived:
            raise LookupError(f"{name!r} is not a live channel")
        return found.stream_id

    def channel_topics(self, stream_id: int) -> list[str]:
        for channel in self.mirror.channels():
            if channel.stream_id == int(stream_id):
                return [t.live_name for t in self.mirror.topics(channel.name)]
        raise LookupError(f"no live channel with id {stream_id}")

    def channels(self) -> list[dict]:
        return [{"name": c.name, "stream_id": c.stream_id, "folder_id": c.folder_id}
                for c in self.mirror.channels()]

    # -- the writer side's one read ------------------------------------------

    def live_name(self, channel: str, topic: str) -> str:
        """`agag.zulip.live_topic_name`'s answer from the store: the ✔ name
        when that is the only one that exists now."""
        return self.mirror.live_name(channel, topic) or topic

    def resolved(self, channel: str, topic: str) -> bool:
        found = self.mirror.topic(channel, topic)
        return bool(found) and all(t.live_name.startswith(RESOLVED_TOPIC_PREFIX) for t in found)
