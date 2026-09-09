"""The two rules the plan makes non-negotiable, tested against made-up messages.

Live Zulip cannot prove either of them today: the realm's `intro-` topics
happen to contain no selfnote and no Zulip notice, so a broken filter would
read exactly like a working one. These are the messages that would break it.
"""

from agentroom.room import Room, _readable, bare_topic, strip_selfnotes, unresolved


def message(content: str, *, ident: int = 1, system: bool = False) -> dict:
    return {
        "id": ident,
        "content": content,
        "timestamp": 1700000000,
        "sender_full_name": "Notification Bot" if system else "autolab-agstudio1",
        "sender_realm_str": "zulipinternal" if system else "agdev",
    }


def test_resolved_topics_are_recognised_by_zulips_own_marker():
    assert unresolved("workplan-thing")
    assert not unresolved("✔ workplan-thing")
    assert bare_topic("✔ workplan-thing") == "workplan-thing"
    assert bare_topic("workplan-thing") == "workplan-thing"


def test_a_topic_named_with_a_tick_elsewhere_is_still_unresolved():
    # The marker is a prefix, not a character anywhere in the name.
    assert unresolved("workplan-✔-in-the-middle")


def test_selfnote_lines_are_stripped_from_an_otherwise_ordinary_post():
    content = "[selfnote][rootchat] front/front-1\nHere is the plan.\nSecond line."
    assert strip_selfnotes(content) == "Here is the plan.\nSecond line."


def test_a_whole_selfnote_message_is_not_a_post():
    posts = _readable([
        message("[selfnote][served] pj-x/workplan-y 42", ident=1),
        message("Real answer.", ident=2),
    ])
    assert [post["id"] for post in posts] == [2]


def test_zulip_notices_are_not_posts():
    posts = _readable([
        message("@_**Developer|8** has marked this topic as resolved.", ident=1, system=True),
        message("Real answer.", ident=2),
    ])
    assert [post["id"] for post in posts] == [2]


def test_a_post_that_was_only_a_note_leaves_nothing_behind():
    assert _readable([message("[selfnote][work] project/1", ident=1)]) == []


# --- retirement: a ✔ on an introduction ------------------------------------


class FakeClient:
    """Just enough of `ZulipClient` for `_intro_topics` and `_read_work`."""

    calls = 0

    def __init__(self, topics, channels=(), by_stream=None):
        self._topics = topics
        self._channels = list(channels)
        self._by_stream = by_stream or {}

    def stream_id(self, name):
        return 35

    def channels(self):
        return list(self._channels)

    def channel_topics(self, stream_id):
        if stream_id == 35:
            return list(self._topics)
        return list(self._by_stream.get(stream_id, ()))

    intros = {}

    def topic_history(self, channel, topic, num_before=50):
        return [{"id": 1, "content": self.intros.get(topic, "")}] if topic in self.intros else []


def test_a_resolved_introduction_retires_its_agent_from_the_room():
    # `operation_room` p2 ex2 step C. An introduction is the contract that
    # says an agent exists and how to reach it, so resolving that topic is the
    # realm's only way to say the agent is gone — a project can be deleted
    # from every machine without Zulip noticing, which is what left
    # `agping-agstudio1` on the board after its fixture stopped existing.
    room = Room.__new__(Room)
    live, retired = room._intro_topics(FakeClient([
        "intro-agforge-agstudio1",
        "✔ intro-agping-agstudio1",
        "✔ front-greet-agecho",
    ]))
    assert live == [("intro-agforge-agstudio1", "agforge-agstudio1")]
    assert retired == ["agping-agstudio1"]


def test_a_resolved_topic_that_is_not_an_introduction_is_neither():
    room = Room.__new__(Room)
    live, retired = room._intro_topics(FakeClient(["✔ front-greet-agecho"]))
    assert live == [] and retired == []


def test_a_retired_agents_channel_is_not_walked_for_open_work():
    # The signature change that retires an agent has two callers, and the
    # second one is the agent room's work half. Missed once, live: the view
    # said "the agent room is unreadable · ValueError" and only a screenshot
    # said so — `/agents` alone answered perfectly well.
    room = Room.__new__(Room)
    room.client = lambda: client
    client = FakeClient(
        ["intro-agforge-agstudio1", "\u2714 intro-agping-agstudio1"],
        channels=[
            {"name": "agforge-agstudio1", "stream_id": 7, "folder_id": None},
            {"name": "agping-agstudio1", "stream_id": 8, "folder_id": None},
        ],
        by_stream={7: ["assetplan-a-poster"], 8: ["agpingplan-something"]},
    )
    found = room._read_work()
    assert found["channels"] == ["agforge-agstudio1"]
    assert [row["topic"] for row in found["topics"]] == ["assetplan-a-poster"]


def test_resolved_work_is_listed_only_when_asked_and_says_so():
    """`front_desk` p4: a finished request is completed from the agent room,
    and finished means ✔ — so the board can list resolved topics too, each
    row saying which it is, and never by default."""
    room = Room.__new__(Room)
    room.client = lambda: client
    client = FakeClient(
        ["intro-agforge-agstudio1"],
        channels=[{"name": "agforge-agstudio1", "stream_id": 7, "folder_id": None}],
        by_stream={7: ["assetplan-a-poster", "✔ assetplan-done"]},
    )
    found = room._read_work()
    assert [row["topic"] for row in found["topics"]] == ["assetplan-a-poster"]
    assert found["topics"][0]["resolved"] is False and found["include_resolved"] is False
    found = room._read_work(True)
    assert [(row["topic"], row["resolved"]) for row in found["topics"]] == [
        ("assetplan-a-poster", False), ("✔ assetplan-done", True)]
    assert found["include_resolved"] is True


ROSTER = """```agag-roster
schema: ag.agent-roster.v1
instance: front-agstudio1
agent: front
bot: Front
bot_id: 15
channel: front-agstudio1
prefixes: front-
```"""


def test_front_s_conversations_are_filed_under_front_by_its_declared_prefix():
    """`front_desk` p4: Front's own channel does not exist, so its
    conversations live in `#front` and are its by the `front-` prefix the
    roster block declares — the standing `routine-` requests are nobody's."""
    room = Room.__new__(Room)
    room.client = lambda: client
    client = FakeClient(
        ["intro-front-agstudio1", "intro-agforge-agstudio1"],
        channels=[
            {"name": "front", "stream_id": 5, "folder_id": None},
            {"name": "agforge-agstudio1", "stream_id": 7, "folder_id": None},
        ],
        by_stream={5: ["front-p2-greet-agecho", "✔ front-desk-1", "routine-ghtrends"],
                   7: ["assetplan-a-poster"]},
    )
    client.intros = {"intro-front-agstudio1": "hello\n" + ROSTER,
                     "intro-agforge-agstudio1": "no block here"}
    found = room._read_work()
    assert [(row["group"], row["topic"]) for row in found["topics"]] == [
        ("agforge-agstudio1", "assetplan-a-poster"), ("front-agstudio1", "front-p2-greet-agecho")]
    assert "front" in found["channels"]
    found = room._read_work(True)
    assert [(row["group"], row["topic"], row["resolved"]) for row in found["topics"]][1:] == [
        ("front-agstudio1", "front-p2-greet-agecho", False), ("front-agstudio1", "✔ front-desk-1", True)]
