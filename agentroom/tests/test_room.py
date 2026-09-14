"""The two rules the plan makes non-negotiable, tested against made-up messages.

Live Zulip cannot prove either of them today: the realm's `intro-` topics
happen to contain no selfnote and no Zulip notice, so a broken filter would
read exactly like a working one. These are the messages that would break it.
"""

from conftest import FakeRealm, mirror_over, pump

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


ROSTER = """```agag-roster
schema: ag.agent-roster.v1
instance: front-agstudio1
agent: front
bot: Front
bot_id: 15
channel: front-agstudio1
prefixes: front-
```"""


def realm_with(*, intros=(), channels=(), topics=()):
    """`intros`: `(instance, text, resolved)`; `channels`: `(id, name)`;
    `topics`: `(channel, topic, resolved)`. `#agents` is always there."""
    realm = FakeRealm()
    realm.add_channel(35, "agents")
    for stream_id, name in channels:
        realm.add_channel(stream_id, name)
    for instance, text, resolved in intros:
        realm.post("agents", f"intro-{instance}", text, quiet=True)
        if resolved:
            realm.resolve("agents", f"intro-{instance}", quiet=True)
    for channel, topic, resolved in topics:
        realm.post(channel, topic, "a post", quiet=True)
        if resolved:
            realm.resolve(channel, topic, quiet=True)
    return realm


def room_over(realm) -> Room:
    return Room(mirror=mirror_over(realm))


def test_a_resolved_introduction_retires_its_agent_from_the_room():
    # `operation_room` p2 ex2 step C. An introduction is the contract that
    # says an agent exists and how to reach it, so resolving that topic is the
    # realm's only way to say the agent is gone — a project can be deleted
    # from every machine without Zulip noticing, which is what left
    # `agping-agstudio1` on the board after its fixture stopped existing.
    realm = realm_with(intros=[("agforge-agstudio1", "hello", False), ("agping-agstudio1", "hello", True)])
    realm.post("agents", "front-greet-agecho", "not an introduction", quiet=True)
    realm.resolve("agents", "front-greet-agecho", quiet=True)
    found = room_over(realm).agents()
    assert [agent["instance"] for agent in found["agents"]] == ["agforge-agstudio1"]
    assert found["retired"] == ["agping-agstudio1"]
    assert found["health"]["state"] == "live"


def test_a_resolved_topic_that_is_not_an_introduction_is_neither():
    realm = realm_with()
    realm.post("agents", "front-greet-agecho", "x", quiet=True)
    realm.resolve("agents", "front-greet-agecho", quiet=True)
    found = room_over(realm).agents()
    assert found["agents"] == [] and found["retired"] == []


def test_a_retired_agents_channel_is_not_walked_for_open_work():
    # The signature change that retires an agent has two callers, and the
    # second one is the agent room's work half. Missed once, live: the view
    # said "the agent room is unreadable · ValueError" and only a screenshot
    # said so — `/agents` alone answered perfectly well.
    realm = realm_with(
        intros=[("agforge-agstudio1", "hello", False), ("agping-agstudio1", "hello", True)],
        channels=[(7, "agforge-agstudio1"), (8, "agping-agstudio1")],
        topics=[("agforge-agstudio1", "assetplan-a-poster", False), ("agping-agstudio1", "agpingplan-something", False)],
    )
    found = room_over(realm).work()
    assert found["channels"] == ["agforge-agstudio1"]
    assert [row["topic"] for row in found["topics"]] == ["assetplan-a-poster"]


def test_resolved_work_is_listed_only_when_asked_and_says_so():
    """`front_desk` p4: a finished request is completed from the agent room,
    and finished means ✔ — so the board can list resolved topics too, each
    row saying which it is, and never by default."""
    realm = realm_with(
        intros=[("agforge-agstudio1", "hello", False)], channels=[(7, "agforge-agstudio1")],
        topics=[("agforge-agstudio1", "assetplan-a-poster", False), ("agforge-agstudio1", "assetplan-done", True)],
    )
    room = room_over(realm)
    found = room.work()
    assert [row["topic"] for row in found["topics"]] == ["assetplan-a-poster"]
    assert found["topics"][0]["resolved"] is False and found["include_resolved"] is False
    found = room.work(True)
    assert [(row["topic"], row["resolved"]) for row in found["topics"]] == [
        ("assetplan-a-poster", False), ("✔ assetplan-done", True)]
    assert found["include_resolved"] is True


def test_front_s_conversations_are_filed_under_front_by_its_declared_prefix():
    """`front_desk` p4: Front's own channel does not exist, so its
    conversations live in `#front` and are its by the `front-` prefix the
    roster block declares — the standing `routine-` requests are nobody's."""
    realm = realm_with(
        intros=[("front-agstudio1", "hello\n" + ROSTER, False), ("agforge-agstudio1", "no block here", False)],
        channels=[(5, "front"), (7, "agforge-agstudio1")],
        topics=[("front", "front-p2-greet-agecho", False), ("front", "front-desk-1", True),
                ("front", "routine-ghtrends", False), ("agforge-agstudio1", "assetplan-a-poster", False)],
    )
    room = room_over(realm)
    found = room.work()
    assert [(row["group"], row["topic"]) for row in found["topics"]] == [
        ("agforge-agstudio1", "assetplan-a-poster"), ("front-agstudio1", "front-p2-greet-agecho")]
    assert "front" in found["channels"]
    found = room.work(True)
    assert sorted((row["group"], row["topic"], row["resolved"]) for row in found["topics"] if row["channel"] == "front") == [
        ("front-agstudio1", "front-p2-greet-agecho", False), ("front-agstudio1", "✔ front-desk-1", True)]


def test_a_change_in_the_realm_reaches_the_next_read_with_no_cache_to_clear():
    # What `forget()` used to be for. There is no cache now: the mirror
    # applies the event and the next read sees the realm as it is.
    realm = realm_with(intros=[("agforge-agstudio1", "hello", False)], channels=[(7, "agforge-agstudio1")])
    room = room_over(realm)
    assert room.work()["topics"] == []
    realm.post("agforge-agstudio1", "assetplan-new", "please")
    pump(room.mirror)
    assert [row["topic"] for row in room.work()["topics"]] == ["assetplan-new"]
    realm.resolve("agforge-agstudio1", "assetplan-new")
    pump(room.mirror)
    assert room.work()["topics"] == []
