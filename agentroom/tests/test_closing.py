"""What closing one Front Desk conversation would touch (`front_desk` p3 step 1).

Fixtures only — no Zulip, no paid run. What is pinned is what the plan asks
discovery to get right: the whole chain (Front → autolab's plan → its task →
a forge delegation), a resolved topic read under its ✔ name, a cycle in the
notes, a topic anchored to *another* Front conversation, a task this walk
never reached, a channel holding something else, and a history that could not
be read.

Since `refactor` p1 autolab's half is read out of the conversations
themselves, and since p2 forge's is too — a `[mission]` note makes a
`workplan-` topic a mission, an `[asset]` note makes an `assetplan-` topic a
request, and there is no second system left in this traversal. The fixture is
the realm as the two agents now write it: mission `m10` with its channel
`work-m10` and task topic `workrun-task1-m10`; request `a31` with its run
topic `assetrun-robot-a31`.
"""

import pytest

from agentroom.closing import MAX_NODES, Related, discover, related_topics
from agentroom.ops import Topic

DESK = "20260908-1600"
DESK_TOPIC = f"front-desk-{DESK}"
ROOT = ("front", DESK_TOPIC)
FRONT_BOT, AUTOLAB_BOT, FORGE_BOT, DEVELOPER = 15, 11, 9, 8
AUTOLAB = "autolab-agstudio1"
#: The anchor ids that *are* the mission and its task: the message ids of
#: their own notes, which is autolab's whole model of identity.
MISSION = 10
TASK = 20
MISSION_LABEL = "m10"
TASK_LABEL = "m10#1"
WORK_CHANNEL = "work-m10"
RUN_TOPIC = "workrun-task1-m10"
PLAN_TOPIC = "workplan-trend8"
PROJECT_CHANNEL = "pj-ghtrends"
#: forge's half, as `refactor` p2 writes it: the request's anchor id is its
#: identity and its run topic wears it, so the stem `robot` is reusable.
FORGE_CHANNEL = "agforge-agstudio1"
REQUEST = 31
FORGE_RUN = 41
REQUEST_LABEL = "a31"
FORGE_RUN_LABEL = "r41"
ASSETPLAN_TOPIC = "assetplan-robot"
ASSETRUN_TOPIC = f"assetrun-robot-{REQUEST_LABEL}"
ASSET_KEY = "files/2026-09-08/robot.zip"


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
    histories = {
        ("front", DESK_TOPIC): [
            post(1, "Please cover a new trending repo.", sender_id=DEVELOPER, sender="Developer"),
            selfnote(2, "served", f"{PROJECT_CHANNEL}/{PLAN_TOPIC} 1"),
            selfnote(3, "served", f"{WORK_CHANNEL}/{RUN_TOPIC} 1"),
            post(4, "Done — the summary is written up."),
        ],
        (PROJECT_CHANNEL, PLAN_TOPIC): [
            # The mission note's own id is the mission: `m10`, and therefore
            # `work-m10`. Nothing anywhere holds a Plane issue for it.
            selfnote(MISSION, "mission", "ghtrends", sender_id=AUTOLAB_BOT, sender=AUTOLAB),
            selfnote(11, "rootchat", f"front/{DESK_TOPIC}", sender_id=AUTOLAB_BOT, sender=AUTOLAB),
            post(12, "# Add one summary\n\nOne task.", sender_id=AUTOLAB_BOT, sender=AUTOLAB),
            selfnote(13, "doc", "12", sender_id=AUTOLAB_BOT, sender=AUTOLAB),
            selfnote(14, "state", "started", sender_id=AUTOLAB_BOT, sender=AUTOLAB),
        ],
        (WORK_CHANNEL, f"✔ {RUN_TOPIC}"): [
            selfnote(TASK, "task", f"{MISSION}#1", sender_id=AUTOLAB_BOT, sender=AUTOLAB),
            selfnote(21, "rootchat", f"{PROJECT_CHANNEL}/{PLAN_TOPIC}",
                     sender_id=AUTOLAB_BOT, sender=AUTOLAB),
            post(22, "# Summarize\n\nbody", sender_id=AUTOLAB_BOT, sender=AUTOLAB),
            selfnote(23, "doc", "22", sender_id=AUTOLAB_BOT, sender=AUTOLAB),
            selfnote(24, "served", f"{FORGE_CHANNEL}/{ASSETPLAN_TOPIC} 1",
                     sender_id=AUTOLAB_BOT, sender=AUTOLAB),
            selfnote(25, "state", "completed", sender_id=AUTOLAB_BOT, sender=AUTOLAB),
        ],
        (FORGE_CHANNEL, f"✔ {ASSETPLAN_TOPIC}"): [
            selfnote(30, "rootchat", f"{WORK_CHANNEL}/{RUN_TOPIC}",
                     sender_id=FORGE_BOT, sender="forge"),
            # The asset note's own id is the request: `a31`, and therefore
            # `assetrun-robot-a31`. Nothing anywhere holds a Plane issue.
            selfnote(REQUEST, "asset", "robot", sender_id=FORGE_BOT, sender="forge"),
            post(32, "# Render a robot\n\nOne 512x512 PNG.",
                 sender_id=FORGE_BOT, sender="forge"),
            selfnote(33, "doc", "32", sender_id=FORGE_BOT, sender="forge"),
            selfnote(34, "tools", "toolset-image", sender_id=FORGE_BOT, sender="forge"),
            selfnote(35, "result", ASSET_KEY, sender_id=FORGE_BOT, sender="forge"),
            selfnote(36, "state", "delivered", sender_id=FORGE_BOT, sender="forge"),
        ],
        (FORGE_CHANNEL, f"✔ {ASSETRUN_TOPIC}"): [
            selfnote(40, "rootchat", f"{FORGE_CHANNEL}/{ASSETPLAN_TOPIC}",
                     sender_id=FORGE_BOT, sender="forge"),
            selfnote(FORGE_RUN, "assetrun", str(REQUEST),
                     sender_id=FORGE_BOT, sender="forge"),
            selfnote(42, "result", ASSET_KEY, sender_id=FORGE_BOT, sender="forge"),
            selfnote(43, "state", "delivered", sender_id=FORGE_BOT, sender="forge"),
        ],
    }
    topics = {"front": [DESK_TOPIC], PROJECT_CHANNEL: [PLAN_TOPIC],
              WORK_CHANNEL: [f"✔ {RUN_TOPIC}"],
              FORGE_CHANNEL: [f"✔ {ASSETPLAN_TOPIC}", f"✔ {ASSETRUN_TOPIC}"]}
    streams = {"front": 24, PROJECT_CHANNEL: 79, WORK_CHANNEL: 122, FORGE_CHANNEL: 34}
    histories.update(kwargs.pop("histories", {}))
    topics.update(kwargs.pop("topics", {}))
    return Realm(histories, topics=topics, streams=streams, **kwargs)


# --- the walk ---------------------------------------------------------------


def test_the_whole_delegated_chain_is_walked_through_resolved_topics():
    realm = chain_realm()
    found = discover({}, ROOT, realm=realm)
    assert [(node.channel, node.topic) for node in found.topics] == [
        ("front", DESK_TOPIC),
        ("pj-ghtrends", "workplan-trend8"),
        ("work-m10", "workrun-task1-m10"),
        (FORGE_CHANNEL, ASSETPLAN_TOPIC),
        (FORGE_CHANNEL, ASSETRUN_TOPIC),
    ]
    # Read under the ✔ name and reported as resolved, which is the only way
    # most of a finished session is visible at all.
    resolved = {node.topic for node in found.topics if node.resolved}
    assert resolved == {RUN_TOPIC, ASSETPLAN_TOPIC, ASSETRUN_TOPIC}
    assert found.gaps["unread"] == [] and found.gaps["errors"] == []


def test_a_topic_nothing_names_is_still_found_beside_its_own_plan():
    """`assetrun-robot-a31` is named by no note anywhere; its stem pairs it
    with the plan topic, and its own root note is what admits it."""
    found = discover({}, ROOT, realm=chain_realm())
    run = next(node for node in found.topics if node.topic == ASSETRUN_TOPIC)
    assert [link["via"] for link in run.links] == ["rootchat"]
    assert run.links[0]["from"]["topic"] == ASSETPLAN_TOPIC


def test_a_similarly_named_sibling_without_a_link_note_is_not_related():
    realm = chain_realm(
        histories={(FORGE_CHANNEL, "assetnote-robot"): [post(50, "unrelated")]},
        topics={FORGE_CHANNEL: [f"✔ {ASSETPLAN_TOPIC}", f"✔ {ASSETRUN_TOPIC}",
                                "assetnote-robot"]},
    )
    found = discover({}, ROOT, realm=realm)
    assert all(node.topic != "assetnote-robot" for node in found.topics)
    assert all(row["topic"] != "assetnote-robot" for row in found.excluded)


def test_a_cycle_in_the_notes_terminates():
    realm = chain_realm(histories={
        ("pj-ghtrends", "workplan-trend8"): [
            selfnote(10, "rootchat", f"front/{DESK_TOPIC}"),
            selfnote(12, "served", "work-m10/workrun-task1-m10 1"),
        ],
        ("work-m10", "✔ workrun-task1-m10"): [
            selfnote(20, "rootchat", "pj-ghtrends/workplan-trend8",
                     sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
            selfnote(21, "task", f"{MISSION}#1", sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
            # autolab anchors the plan topic back to its own run: a loop.
            selfnote(23, "served", "pj-ghtrends/workplan-trend8 1",
                     sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
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
    """A held conversation costs no Zulip call — and the notes that say what
    it *is* survive, though a selfnote is in no history."""
    held = Topic(channel=WORK_CHANNEL, topic=RUN_TOPIC,
                 live_topic=f"✔ {RUN_TOPIC}", resolved=True, keep_history=True)
    for message in [
        selfnote(TASK, "task", f"{MISSION}#1", sender_id=AUTOLAB_BOT, sender=AUTOLAB),
        selfnote(21, "rootchat", f"{PROJECT_CHANNEL}/{PLAN_TOPIC}",
                 sender_id=AUTOLAB_BOT, sender=AUTOLAB),
        post(24, "the task is done", sender_id=AUTOLAB_BOT, sender=AUTOLAB),
        selfnote(25, "state", "completed", sender_id=AUTOLAB_BOT, sender=AUTOLAB),
    ]:
        held.add(message)
    assert held.autolab == [("task", f"{MISSION}#1", TASK, AUTOLAB_BOT, AUTOLAB),
                            ("state", "completed", 25, AUTOLAB_BOT, AUTOLAB)]
    realm = chain_realm()
    found = discover({(WORK_CHANNEL, RUN_TOPIC): held}, ROOT, realm=realm)
    node = next(one for one in found.topics if one.topic == RUN_TOPIC)
    assert node.known == "held"
    assert node.record.anchor_id == TASK and node.record.state == "completed"
    assert (WORK_CHANNEL, RUN_TOPIC) not in realm.reads


# --- what is not this conversation's -----------------------------------------


def test_a_topic_anchored_to_another_front_conversation_is_excluded_with_evidence():
    """p2's reused plan topic: reachable from here, owned elsewhere."""
    realm = chain_realm(histories={
        ("front", DESK_TOPIC): [
            post(1, "Please cover a new trending repo.", sender_id=DEVELOPER, sender="Developer"),
            selfnote(2, "served", "pj-ghtrends/workplan-trend8 1"),
        ],
        ("pj-ghtrends", "workplan-trend8"): [
            selfnote(9, "rootchat", "front/front-desk-20260907-0900"),
            selfnote(10, "rootchat", f"front/{DESK_TOPIC}"),
            selfnote(12, "served", "work-m10/workrun-task1-m10 1"),
        ],
    })
    found = discover({}, ROOT, realm=realm)
    shared = next(row for row in found.excluded if row["topic"] == "workplan-trend8")
    assert "front-desk-20260907-0900" in shared["reason"]
    assert shared["evidence"][0]["message_id"] == 9
    # Nothing reached only through it is closed on this conversation's behalf.
    assert [node.topic for node in found.topics] == [DESK_TOPIC]
    cascaded = next(row for row in found.excluded if row["topic"] == "workrun-task1-m10")
    assert cascaded["reason"] == ("reached only through a conversation this one does not own "
                                  "(workplan-trend8)")
    assert found.works == [] and found.channels == []


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
    realm = chain_realm(fail=("work-m10",))
    found = discover({}, ROOT, realm=realm)
    assert "work-m10/workrun-task1-m10" in found.gaps["unread"]
    assert any(error["channel"] == "work-m10" for error in found.gaps["errors"])
    node = next(one for one in found.topics if one.topic == RUN_TOPIC)
    assert node.known == "note-only" and node.record is None


def test_without_a_reader_every_named_topic_is_unread():
    found = discover({}, ROOT, realm=None)
    assert found.topics[0].topic == DESK_TOPIC
    # Nothing was read, so no conversation said what it is: the gap is the
    # unread topics, and there is no work record to show.
    assert found.works == []


def test_a_full_read_is_reported_as_a_window():
    long_history = [post(ident, "chatter") for ident in range(1, 401)]
    long_history.append(selfnote(401, "served", "pj-ghtrends/workplan-trend8 1"))
    realm = chain_realm(histories={("front", DESK_TOPIC): long_history})
    found = discover({}, ROOT, realm=realm)
    assert found.gaps["bounded"] == [f"front/{DESK_TOPIC}"]


# --- the work records -------------------------------------------------------


def test_the_mission_and_its_task_are_read_out_of_their_own_conversations():
    """No lookup anywhere: the notes in the topics are the whole record."""
    found = discover({}, ROOT, realm=chain_realm())
    by_label = {work.label: work for work in found.works}
    assert set(by_label) == {MISSION_LABEL, REQUEST_LABEL}
    mission = by_label[MISSION_LABEL]
    assert mission.source == "agautolab" and mission.role == "mission"
    assert (mission.channel, mission.topic) == (PROJECT_CHANNEL, PLAN_TOPIC)
    assert mission.anchor_id == MISSION and mission.state == "started"
    assert [row["how"] for row in mission.evidence] == ["mission note"]
    # Its task is a child of the mission rather than a target of its own: the
    # task *is* a conversation, and the conversation already has its own row.
    assert mission.children == [
        {"anchor_id": TASK, "label": TASK_LABEL, "title": "",
         "state": "completed", "serial": 1, "channel": WORK_CHANNEL,
         "topic": RUN_TOPIC, "reached": True}]
    # forge's request, read the same way out of its own conversation. There
    # is no Plane record left in this traversal at all.
    request = by_label[REQUEST_LABEL]
    assert request.source == "agforge" and request.role == "request"


def test_a_task_is_attributed_by_the_mission_id_its_note_names():
    """Not by the channel it is in and not by the name it wears: a second
    task topic naming another mission is that mission's."""
    realm = chain_realm(
        topics={WORK_CHANNEL: [f"✔ {RUN_TOPIC}", "workrun-task1-m99"]},
        histories={(WORK_CHANNEL, "workrun-task1-m99"): [
            selfnote(70, "task", "99#1", sender_id=AUTOLAB_BOT, sender=AUTOLAB),
            selfnote(71, "rootchat", f"{PROJECT_CHANNEL}/{PLAN_TOPIC}",
                     sender_id=AUTOLAB_BOT, sender=AUTOLAB),
        ]},
    )
    found = discover({}, ROOT, realm=realm)
    mission = next(work for work in found.works if work.label == MISSION_LABEL)
    assert [row["label"] for row in mission.children] == [TASK_LABEL]
    # Its root note names this very plan topic, whose name was reused: the id
    # is what says it is the older work, and it is excluded with that reason.
    stale = next(row for row in found.excluded if row["topic"] == "workrun-task1-m99")
    assert "the name was reused" in stale["reason"]


def test_a_task_state_written_by_somebody_else_does_not_move_the_work():
    """The identity note's author is the record's author. A visitor's state
    line in a task topic is not that task saying where it has got to."""
    realm = chain_realm()
    realm.histories[(WORK_CHANNEL, f"✔ {RUN_TOPIC}")] = [
        selfnote(TASK, "task", f"{MISSION}#1", sender_id=AUTOLAB_BOT, sender=AUTOLAB),
        selfnote(21, "rootchat", f"{PROJECT_CHANNEL}/{PLAN_TOPIC}",
                 sender_id=AUTOLAB_BOT, sender=AUTOLAB),
        selfnote(26, "state", "completed", sender_id=FORGE_BOT, sender="forge"),
    ]
    found = discover({}, ROOT, realm=realm)
    mission = next(work for work in found.works if work.label == MISSION_LABEL)
    assert [row["state"] for row in mission.children] == ["open"]


def test_a_task_whose_mission_this_walk_never_reached_is_shown_as_orphaned():
    realm = chain_realm(histories={(PROJECT_CHANNEL, PLAN_TOPIC): [
        selfnote(11, "rootchat", f"front/{DESK_TOPIC}", sender_id=AUTOLAB_BOT, sender=AUTOLAB),
        selfnote(12, "served", f"{WORK_CHANNEL}/{RUN_TOPIC} 1",
                 sender_id=AUTOLAB_BOT, sender=AUTOLAB),
    ]})
    found = discover({}, ROOT, realm=realm)
    orphan = next(work for work in found.works if work.label == TASK_LABEL)
    assert orphan.role == "task" and orphan.parent_id == MISSION_LABEL


def test_a_request_and_its_run_are_read_out_of_their_own_conversations():
    """forge's half of the same move (`refactor` p2). The run is a child of
    the request by the **anchor id** its note names, and the request carries
    the durable object key it delivered."""
    found = discover({}, ROOT, realm=chain_realm())

    request = next(work for work in found.works if work.label == REQUEST_LABEL)
    assert request.state == "delivered" and request.title == "robot"
    assert (request.channel, request.topic) == (FORGE_CHANNEL, ASSETPLAN_TOPIC)
    assert request.anchor_id == REQUEST
    assert [row["how"] for row in request.evidence] == ["asset note"]
    assert request.results == [ASSET_KEY]
    assert [(row["label"], row["state"], row["topic"]) for row in request.children] == [
        (FORGE_RUN_LABEL, "delivered", ASSETRUN_TOPIC)]


def test_a_run_is_attributed_by_the_request_id_its_note_names():
    """Not by the topic name it wears. A run naming another request is that
    request's, which is what makes a reused stem harmless."""
    realm = chain_realm()
    realm.histories[(FORGE_CHANNEL, f"✔ {ASSETRUN_TOPIC}")] = [
        selfnote(40, "rootchat", f"{FORGE_CHANNEL}/{ASSETPLAN_TOPIC}",
                 sender_id=FORGE_BOT, sender="forge"),
        selfnote(FORGE_RUN, "assetrun", "9999", sender_id=FORGE_BOT, sender="forge"),
    ]

    found = discover({}, ROOT, realm=realm)

    request = next(work for work in found.works if work.label == REQUEST_LABEL)
    assert request.children == []
    orphan = next(work for work in found.works if work.label == FORGE_RUN_LABEL)
    assert orphan.role == "run" and orphan.parent_id == "a9999"


def test_a_pending_generation_is_the_request_s_state_not_a_missing_child():
    """forge's lifecycle: a run still waiting on ComfyUI is what says the
    request is not finished — there is no counting rule to fail."""
    realm = chain_realm()
    realm.histories[(FORGE_CHANNEL, f"✔ {ASSETRUN_TOPIC}")][-1] = selfnote(
        43, "state", "pending", sender_id=FORGE_BOT, sender="forge")
    realm.histories[(FORGE_CHANNEL, f"✔ {ASSETPLAN_TOPIC}")][-1] = selfnote(
        36, "state", "planned", sender_id=FORGE_BOT, sender="forge")

    found = discover({}, ROOT, realm=realm)

    request = next(work for work in found.works if work.label == REQUEST_LABEL)
    assert request.state == "planned"
    assert [row["state"] for row in request.children] == ["pending"]


def test_forge_never_contributes_a_channel_to_archive():
    """Its conversations live in the shared agent channel, which is never a
    candidate: only `work-` channels are, and only when bound to a mission."""
    found = discover({}, ROOT, realm=chain_realm())
    assert [row["channel"] for row in found.channels] == [WORK_CHANNEL]


# --- channels ----------------------------------------------------------------


def test_a_dedicated_channel_whose_every_topic_is_ours_is_archivable():
    found = discover({}, ROOT, realm=chain_realm())
    row = next(one for one in found.channels if one["channel"] == "work-m10")
    assert row["archivable"] is True and row["bound_to_mission"] is True
    assert row["topics"] == ["workrun-task1-m10"]
    # The shared channels are never candidates at all.
    assert [one["channel"] for one in found.channels] == ["work-m10"]


def test_a_channel_holding_a_topic_this_conversation_did_not_reach_is_kept():
    realm = chain_realm(topics={"work-m10": ["✔ workrun-task1-m10", "workrun-task2-m10"]})
    realm.histories[("work-m10", "workrun-task2-m10")] = [post(60, "somebody else's task")]
    found = discover({}, ROOT, realm=realm)
    row = next(one for one in found.channels if one["channel"] == "work-m10")
    assert row["archivable"] is False
    assert row["unaccounted"] == ["workrun-task2-m10"]


def test_a_channel_with_no_mission_of_ours_behind_it_is_not_archivable():
    """A `work-` channel is bound to a request by the **mission** whose anchor
    id names it, never by the channel's own name. With the plan topic holding
    no mission note, nothing here says the channel is this request's."""
    realm = chain_realm(histories={(PROJECT_CHANNEL, PLAN_TOPIC): [
        selfnote(11, "rootchat", f"front/{DESK_TOPIC}", sender_id=AUTOLAB_BOT, sender=AUTOLAB),
    ]})
    found = discover({}, ROOT, realm=realm)
    row = next(one for one in found.channels if one["channel"] == WORK_CHANNEL)
    assert row["archivable"] is False and row["bound_to_mission"] is False
    assert "nothing binds the channel" in row["reason"]


def test_a_channel_whose_topics_cannot_be_listed_is_reported():
    """The realm still lists it, so silence here is a read failure."""
    realm = chain_realm()
    realm.fail.add("work-m10")
    found = discover({}, ROOT, realm=realm)
    row = next(one for one in found.channels if one["channel"] == "work-m10")
    assert row["archivable"] is False and row["topics"] is None
    assert row["archived"] is False
    assert row["reason"] == "the channel's topics could not be read"


def test_a_channel_already_archived_is_not_a_read_failure():
    """Archiving is what makes a channel unlistable, so this operation's own
    finished work looks exactly like a read failure until the realm's channel
    list is asked which one it is."""
    realm = chain_realm()
    realm.streams.pop("work-m10")
    found = discover({}, ROOT, realm=realm)
    row = next(one for one in found.channels if one["channel"] == "work-m10")
    assert row["archived"] is True and row["archivable"] is False
    assert row["reason"] == "already archived: the realm no longer lists this channel"
    # And it stops being a gap: the failed lookup is what this answered.
    assert found.gaps["errors"] == []
