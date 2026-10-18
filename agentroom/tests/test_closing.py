"""What closing one Front Desk conversation would touch (`front_desk` p3 step 1).

Fixtures only — no Zulip, no paid run. What is pinned is what the plan asks
discovery to get right: the whole delegated chain (Front → an agent's plan
topic → its run → a tool it called), a resolved topic read under its ✔ name,
a cycle in the notes, a topic anchored to *another* Front conversation, and a
history that could not be read.
"""

from agentroom.closing import discover
from agentroom.ops import Topic

DESK = "20260908-1600"
DESK_TOPIC = f"front-desk-{DESK}"
ROOT = ("front", DESK_TOPIC)
FRONT_BOT, AGECHO_BOT, TOOL_BOT, DEVELOPER = 15, 11, 9, 8
AGECHO = "agecho-agstudio1"
AGENT_CHANNEL = "agecho-agstudio1"
PLAN_TOPIC = "agechoplan-trend8"
RUN_TOPIC = "agechorun-trend8"
TOOL_CHANNEL = "agtool-agstudio1"
TOOL_TOPIC = "toolrun-robot"


def post(ident, content, *, sender_id=FRONT_BOT, sender="Front"):
    return {"id": ident, "sender_id": sender_id, "sender_full_name": sender,
            "sender_realm_str": "agdev", "timestamp": 1_800_000_000 + ident,
            "content": content}


def selfnote(ident, tag, value, **kwargs):
    return post(ident, f"[selfnote][{tag}] {value}", **kwargs)


class Realm:
    """Topic histories under whichever name each one actually has."""

    def __init__(self, histories, topics=None, fail=(), streams=None):
        self.histories = dict(histories)
        self.topics = dict(topics or {})
        self.fail = set(fail)
        self.streams = dict(streams or {})
        self.reads = []

    def topic_history(self, channel, topic, num_before=50):
        self.reads.append((channel, topic))
        if channel in self.fail or (channel, topic) in self.fail:
            raise ConnectionError("realm down")
        return list(self.histories.get((channel, topic), []))

    def stream_id(self, name):
        if name not in self.streams:
            raise KeyError(name)
        return self.streams[name]

    def channel_topics(self, stream_id):
        for name, ident in self.streams.items():
            if ident == stream_id:
                if name in self.fail:
                    raise ConnectionError("realm down")
                return list(self.topics.get(name, []))
        raise KeyError(stream_id)

    def channels(self):
        return [{"name": name, "stream_id": ident} for name, ident in self.streams.items()]


def chain_realm(**kwargs):
    """The whole delegated shape, as `front-desk-20260908-1600` produced it."""
    agecho = {"sender_id": AGECHO_BOT, "sender": AGECHO}
    tool = {"sender_id": TOOL_BOT, "sender": "agtool"}
    histories = {
        ("front", DESK_TOPIC): [
            post(1, "Please cover a new trending repo.", sender_id=DEVELOPER, sender="Developer"),
            selfnote(2, "served", f"{AGENT_CHANNEL}/{PLAN_TOPIC} 1"),
            selfnote(3, "served", f"{AGENT_CHANNEL}/{RUN_TOPIC} 1"),
            post(4, "Done — the summary is written up."),
        ],
        (AGENT_CHANNEL, PLAN_TOPIC): [
            selfnote(11, "rootchat", f"front/{DESK_TOPIC}", **agecho),
            post(12, "# Add one summary\n\nOne step.", **agecho),
        ],
        (AGENT_CHANNEL, f"✔ {RUN_TOPIC}"): [
            selfnote(21, "rootchat", f"{AGENT_CHANNEL}/{PLAN_TOPIC}", **agecho),
            post(22, "# Summarize\n\nbody", **agecho),
            selfnote(24, "served", f"{TOOL_CHANNEL}/{TOOL_TOPIC} 1", **agecho),
        ],
        (TOOL_CHANNEL, f"✔ {TOOL_TOPIC}"): [
            selfnote(30, "rootchat", f"{AGENT_CHANNEL}/{RUN_TOPIC}", **tool),
            post(32, "# Render a robot\n\nOne 512x512 PNG.", **tool),
        ],
    }
    topics = {"front": [DESK_TOPIC], AGENT_CHANNEL: [PLAN_TOPIC, f"✔ {RUN_TOPIC}"],
              TOOL_CHANNEL: [f"✔ {TOOL_TOPIC}"]}
    streams = {"front": 24, AGENT_CHANNEL: 79, TOOL_CHANNEL: 34}
    histories.update(kwargs.pop("histories", {}))
    topics.update(kwargs.pop("topics", {}))
    return Realm(histories, topics=topics, streams=streams, **kwargs)


# --- the walk ---------------------------------------------------------------


def test_the_whole_delegated_chain_is_walked_through_resolved_topics():
    realm = chain_realm()
    found = discover({}, ROOT, realm=realm)
    assert [(node.channel, node.topic) for node in found.topics] == [
        ("front", DESK_TOPIC),
        (AGENT_CHANNEL, PLAN_TOPIC),
        (AGENT_CHANNEL, RUN_TOPIC),
        (TOOL_CHANNEL, TOOL_TOPIC),
    ]
    # Read under the ✔ name and reported as resolved, which is the only way
    # most of a finished session is visible at all.
    resolved = {node.topic for node in found.topics if node.resolved}
    assert resolved == {RUN_TOPIC, TOOL_TOPIC}
    assert found.gaps["unread"] == [] and found.gaps["errors"] == []


def test_a_similarly_named_sibling_without_a_link_note_is_not_related():
    realm = chain_realm(
        histories={(TOOL_CHANNEL, "toolnote-robot"): [post(50, "unrelated")]},
        topics={TOOL_CHANNEL: [f"✔ {TOOL_TOPIC}", "toolnote-robot"]},
    )
    found = discover({}, ROOT, realm=realm)
    assert all(node.topic != "toolnote-robot" for node in found.topics)
    assert all(row["topic"] != "toolnote-robot" for row in found.excluded)


def test_a_cycle_in_the_notes_terminates():
    agecho = {"sender_id": AGECHO_BOT, "sender": AGECHO}
    realm = chain_realm(histories={
        (AGENT_CHANNEL, PLAN_TOPIC): [
            selfnote(10, "rootchat", f"front/{DESK_TOPIC}"),
            selfnote(12, "served", f"{AGENT_CHANNEL}/{RUN_TOPIC} 1"),
        ],
        (AGENT_CHANNEL, f"✔ {RUN_TOPIC}"): [
            selfnote(20, "rootchat", f"{AGENT_CHANNEL}/{PLAN_TOPIC}", **agecho),
            # The run anchors the plan topic back to itself: a loop.
            selfnote(23, "served", f"{AGENT_CHANNEL}/{PLAN_TOPIC} 1", **agecho),
        ],
    })
    found = discover({}, ROOT, realm=realm)
    assert len({(node.channel, node.topic) for node in found.topics}) == len(found.topics)
    assert found.gaps["truncated"] is False


def test_the_node_cap_is_reported_rather_than_silently_applied():
    found = discover({}, ROOT, realm=chain_realm(), max_nodes=2)
    assert found.gaps["truncated"] is True
    assert len(found.topics) + len(found.excluded) == 2


def test_the_engines_own_memory_answers_without_a_read():
    """A held conversation costs no Zulip call — and its root note survives,
    though a selfnote is in no history."""
    held = Topic(channel=AGENT_CHANNEL, topic=RUN_TOPIC,
                 live_topic=f"✔ {RUN_TOPIC}", resolved=True, keep_history=True)
    for message in [
        selfnote(21, "rootchat", f"{AGENT_CHANNEL}/{PLAN_TOPIC}",
                 sender_id=AGECHO_BOT, sender=AGECHO),
        post(24, "the run is done", sender_id=AGECHO_BOT, sender=AGECHO),
    ]:
        held.add(message)
    realm = chain_realm()
    found = discover({(AGENT_CHANNEL, RUN_TOPIC): held}, ROOT, realm=realm)
    node = next(one for one in found.topics if one.topic == RUN_TOPIC)
    assert node.known == "held"
    assert [home["topic"] for home in node.homes] == [PLAN_TOPIC]
    assert (AGENT_CHANNEL, RUN_TOPIC) not in realm.reads
    assert (AGENT_CHANNEL, f"✔ {RUN_TOPIC}") not in realm.reads


# --- what is not this conversation's -----------------------------------------


def test_a_topic_anchored_to_another_front_conversation_is_excluded_with_evidence():
    """p2's reused plan topic: reachable from here, owned elsewhere."""
    realm = chain_realm(histories={
        ("front", DESK_TOPIC): [
            post(1, "Please cover a new trending repo.", sender_id=DEVELOPER, sender="Developer"),
            selfnote(2, "served", f"{AGENT_CHANNEL}/{PLAN_TOPIC} 1"),
        ],
        (AGENT_CHANNEL, PLAN_TOPIC): [
            selfnote(9, "rootchat", "front/front-desk-20260907-0900"),
            selfnote(10, "rootchat", f"front/{DESK_TOPIC}"),
            selfnote(12, "served", f"{AGENT_CHANNEL}/{RUN_TOPIC} 1"),
        ],
    })
    found = discover({}, ROOT, realm=realm)
    shared = next(row for row in found.excluded if row["topic"] == PLAN_TOPIC)
    assert "front-desk-20260907-0900" in shared["reason"]
    assert shared["evidence"][0]["message_id"] == 9
    # Nothing reached only through it is closed on this conversation's behalf.
    assert [node.topic for node in found.topics] == [DESK_TOPIC]
    cascaded = next(row for row in found.excluded if row["topic"] == RUN_TOPIC)
    assert cascaded["reason"] == ("reached only through a conversation this one does not own "
                                  f"({PLAN_TOPIC})")


def test_another_front_desk_conversation_is_never_a_target():
    realm = chain_realm(histories={
        ("front", DESK_TOPIC): [
            selfnote(2, "served", "front/front-desk-20260907-0900 1"),
        ],
        ("front", "front-desk-20260907-0900"): [post(3, "another conversation")],
    })
    found = discover({}, ROOT, realm=realm)
    assert [node.topic for node in found.topics] == [DESK_TOPIC]
    assert found.excluded[0]["reason"] == "another request: a Front Desk conversation"


# --- gaps --------------------------------------------------------------------


def test_a_topic_that_cannot_be_read_is_a_gap_and_never_an_empty_one():
    realm = chain_realm(fail=(TOOL_CHANNEL,))
    found = discover({}, ROOT, realm=realm)
    assert f"{TOOL_CHANNEL}/{TOOL_TOPIC}" in found.gaps["unread"]
    assert any(error["channel"] == TOOL_CHANNEL for error in found.gaps["errors"])
    node = next(one for one in found.topics if one.topic == TOOL_TOPIC)
    assert node.known == "note-only" and node.homes == []


def test_without_a_reader_every_named_topic_is_unread():
    found = discover({}, ROOT, realm=None)
    assert [node.topic for node in found.topics] == [DESK_TOPIC]
    assert found.gaps["reads"] == 0


def test_a_full_read_is_reported_as_a_window():
    long_history = [post(ident, "chatter") for ident in range(1, 401)]
    long_history.append(selfnote(401, "served", f"{AGENT_CHANNEL}/{PLAN_TOPIC} 1"))
    realm = chain_realm(histories={("front", DESK_TOPIC): long_history})
    found = discover({}, ROOT, realm=realm)
    assert found.gaps["bounded"] == [f"front/{DESK_TOPIC}"]
