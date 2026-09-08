"""What closing one Front Desk conversation would touch (`front_desk` p3 step 1).

Fixtures only — no Zulip, no Plane, no paid run. What is pinned is what the
plan asks discovery to get right: the whole chain (Front → autolab's plan →
its task → a forge delegation), a resolved topic read under its ✔ name, a
cycle in the notes, a topic anchored to *another* Front conversation, a
Sub-Work this walk never reached, a channel holding something else, a
history that could not be read, and a Plane credential refused one project.
"""

import pytest

from agentroom.closing import (
    MAX_NODES, PlaneReader, Related, WORK_TAG, discover, parse_work_note, related_topics,
    work_notes,
)
from agentroom.ops import Topic

DESK = "20260908-1600"
DESK_TOPIC = f"front-desk-{DESK}"
FRONT_BOT, AUTOLAB_BOT, FORGE_BOT, DEVELOPER = 15, 11, 9, 8
MISSION = "4353fc9f"
TASK = "61c7936b"


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
                return list(self.topics.get(name, []))
        raise KeyError(stream_id)

    def channels(self):
        return [{"name": name, "stream_id": ident} for name, ident in self.streams.items()]


class Board:
    """A Plane the fixtures own: projects, issues, and a refusal."""

    def __init__(self, projects, issues, groups, refuse=()):
        self._projects, self._issues = list(projects), dict(issues)
        self._groups, self.refuse = dict(groups), set(refuse)

    def projects(self):
        return list(self._projects)

    def issues(self, project_id):
        return [] if project_id in self.refuse else list(self._issues.get(project_id, []))

    def state_groups(self, project_id):
        return {} if project_id in self.refuse else dict(self._groups.get(project_id, {}))


GHTRENDS = "49612621"
FREEFORGE = "5b4728ec"
PROJECTS = [
    {"id": GHTRENDS, "identifier": "G", "name": "Ghtrends",
     "description": "[AUTO] autolab project: ghtrends"},
    {"id": FREEFORGE, "identifier": "F2", "name": "FreeForge",
     "description": "[AUTO] agforge request records: FreeForge"},
]
GROUPS = {GHTRENDS: {"s-started": "started", "s-done": "completed", "s-cancel": "cancelled"},
          FREEFORGE: {"f-done": "completed"}}


def issue(ident, *, sequence, name, state, parent=None, external=None):
    return {"id": ident, "sequence_id": sequence, "name": name, "state": state,
            "parent": parent,
            "external_source": "agautolab" if external else None, "external_id": external}


def board(extra_ghtrends=(), refuse=()):
    return Board(PROJECTS, {
        GHTRENDS: [
            issue(MISSION, sequence=17, name="Add one summary", state="s-started",
                  external="pj-ghtrends/workplan-trend8"),
            issue(TASK, sequence=18, name="Summarize", state="s-done", parent=MISSION,
                  external="pj-ghtrends/workplan-trend8#1"),
            *extra_ghtrends,
        ],
        FREEFORGE: [issue("f-1", sequence=28, name="Render a robot", state="f-done")],
    }, GROUPS, refuse=refuse)


def chain_realm(**kwargs):
    """The whole delegated shape, as `front-desk-20260908-1600` produced it."""
    histories = {
        ("front", DESK_TOPIC): [
            post(1, "Please cover a new trending repo.", sender_id=DEVELOPER, sender="Developer"),
            selfnote(2, "served", "pj-ghtrends/workplan-trend8 1"),
            selfnote(3, "served", "work-g-17/workrun-task1-g-17 1"),
            post(4, "Done — G-18 is written up."),
        ],
        ("pj-ghtrends", "workplan-trend8"): [
            selfnote(10, "rootchat", f"front/{DESK_TOPIC}"),
            post(11, "Planned as G-17.", sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
        ],
        ("work-g-17", "✔ workrun-task1-g-17"): [
            selfnote(20, "rootchat", "pj-ghtrends/workplan-trend8",
                     sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
            selfnote(21, WORK_TAG, TASK, sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
            selfnote(22, "served", "agforge-agstudio1/assetplan-robot 1",
                     sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
        ],
        ("agforge-agstudio1", "✔ assetplan-robot"): [
            selfnote(30, "rootchat", "work-g-17/workrun-task1-g-17",
                     sender_id=FORGE_BOT, sender="forge"),
        ],
        ("agforge-agstudio1", "✔ assetrun-robot"): [
            selfnote(40, "rootchat", "agforge-agstudio1/assetplan-robot",
                     sender_id=FORGE_BOT, sender="forge"),
            selfnote(41, WORK_TAG, f"{FREEFORGE}/f-1", sender_id=FORGE_BOT, sender="forge"),
        ],
    }
    topics = {"front": [DESK_TOPIC], "pj-ghtrends": ["workplan-trend8"],
              "work-g-17": ["✔ workrun-task1-g-17"],
              "agforge-agstudio1": ["✔ assetplan-robot", "✔ assetrun-robot"]}
    streams = {"front": 24, "pj-ghtrends": 79, "work-g-17": 122, "agforge-agstudio1": 34}
    histories.update(kwargs.pop("histories", {}))
    topics.update(kwargs.pop("topics", {}))
    return Realm(histories, topics=topics, streams=streams, **kwargs)


# --- the note ---------------------------------------------------------------


def test_a_work_note_says_which_agent_wrote_it_by_its_shape():
    assert parse_work_note(f"[selfnote][work] {TASK}") == (None, TASK)
    assert parse_work_note("[selfnote][work] proj/issue") == ("proj", "issue")
    assert parse_work_note("[selfnote][rootchat] front/x") is None
    assert parse_work_note("we finished the work") is None
    assert parse_work_note("[selfnote][work]  ") is None


def test_every_work_note_in_a_topic_is_returned_with_its_author():
    found = work_notes("work-g-17", "workrun-task1-g-17", [
        selfnote(2, WORK_TAG, TASK, sender_id=AUTOLAB_BOT, sender="autolab"),
        post(3, "hello"),
        selfnote(1, WORK_TAG, "p/i", sender_id=FORGE_BOT, sender="forge"),
    ])
    assert [(note.message_id, note.by, note.project_id) for note in found] == [
        (1, "forge", "p"), (2, "autolab", None)]


# --- the walk ---------------------------------------------------------------


def test_the_whole_delegated_chain_is_walked_through_resolved_topics():
    realm = chain_realm()
    found = discover({}, DESK, realm=realm, plane=board())
    assert [(node.channel, node.topic) for node in found.topics] == [
        ("front", DESK_TOPIC),
        ("pj-ghtrends", "workplan-trend8"),
        ("work-g-17", "workrun-task1-g-17"),
        ("agforge-agstudio1", "assetplan-robot"),
        ("agforge-agstudio1", "assetrun-robot"),
    ]
    # Read under the ✔ name and reported as resolved, which is the only way
    # most of a finished session is visible at all.
    resolved = {node.topic for node in found.topics if node.resolved}
    assert resolved == {"workrun-task1-g-17", "assetplan-robot", "assetrun-robot"}
    assert found.gaps["unread"] == [] and found.gaps["errors"] == []


def test_a_topic_nothing_names_is_still_found_beside_its_own_plan():
    """`assetrun-robot` is named by no note anywhere; its stem pairs it with
    the plan topic, and its own root note is what admits it."""
    found = discover({}, DESK, realm=chain_realm(), plane=board())
    run = next(node for node in found.topics if node.topic == "assetrun-robot")
    assert [link["via"] for link in run.links] == ["rootchat"]
    assert run.links[0]["from"]["topic"] == "assetplan-robot"


def test_a_similarly_named_sibling_without_a_link_note_is_not_related():
    realm = chain_realm(
        histories={("agforge-agstudio1", "assetnote-robot"): [post(50, "unrelated")]},
        topics={"agforge-agstudio1": ["✔ assetplan-robot", "✔ assetrun-robot", "assetnote-robot"]},
    )
    found = discover({}, DESK, realm=realm, plane=board())
    assert all(node.topic != "assetnote-robot" for node in found.topics)
    assert all(row["topic"] != "assetnote-robot" for row in found.excluded)


def test_a_cycle_in_the_notes_terminates():
    realm = chain_realm(histories={
        ("pj-ghtrends", "workplan-trend8"): [
            selfnote(10, "rootchat", f"front/{DESK_TOPIC}"),
            selfnote(12, "served", "work-g-17/workrun-task1-g-17 1"),
        ],
        ("work-g-17", "✔ workrun-task1-g-17"): [
            selfnote(20, "rootchat", "pj-ghtrends/workplan-trend8",
                     sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
            selfnote(21, WORK_TAG, TASK, sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
            # autolab anchors the plan topic back to its own run: a loop.
            selfnote(23, "served", "pj-ghtrends/workplan-trend8 1",
                     sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
        ],
    })
    found = discover({}, DESK, realm=realm, plane=board())
    assert len({(node.channel, node.topic) for node in found.topics}) == len(found.topics)
    assert found.gaps["truncated"] is False


def test_the_node_cap_is_reported_rather_than_silently_applied():
    found = discover({}, DESK, realm=chain_realm(), plane=board(), max_nodes=2)
    assert found.gaps["truncated"] is True
    assert len(found.topics) + len(found.excluded) == 2


def test_the_engines_own_memory_answers_without_a_read():
    """A held conversation costs no Zulip call — and its `[work]` binding
    survives, though a selfnote is in no history."""
    held = Topic(channel="work-g-17", topic="workrun-task1-g-17",
                 live_topic="✔ workrun-task1-g-17", resolved=True, keep_history=True)
    for message in [
        selfnote(20, "rootchat", "pj-ghtrends/workplan-trend8",
                 sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
        selfnote(21, WORK_TAG, TASK, sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
        post(24, "the task is done", sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
    ]:
        held.add(message)
    assert held.works == [(None, TASK, AUTOLAB_BOT, "autolab-agstudio1", 21)]
    realm = chain_realm()
    found = discover({("work-g-17", "workrun-task1-g-17"): held}, DESK,
                     realm=realm, plane=board())
    node = next(one for one in found.topics if one.topic == "workrun-task1-g-17")
    assert node.known == "held"
    assert [note.issue_id for note in node.works] == [TASK]
    assert ("work-g-17", "workrun-task1-g-17") not in realm.reads


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
            selfnote(12, "served", "work-g-17/workrun-task1-g-17 1"),
        ],
    })
    found = discover({}, DESK, realm=realm, plane=board())
    shared = next(row for row in found.excluded if row["topic"] == "workplan-trend8")
    assert "front-desk-20260907-0900" in shared["reason"]
    assert shared["evidence"][0]["message_id"] == 9
    # Nothing reached only through it is closed on this conversation's behalf.
    assert [node.topic for node in found.topics] == [DESK_TOPIC]
    cascaded = next(row for row in found.excluded if row["topic"] == "workrun-task1-g-17")
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
    found = discover({}, DESK, realm=realm, plane=board())
    assert [node.topic for node in found.topics] == [DESK_TOPIC]
    assert found.excluded[0]["reason"] == "another Front Desk conversation"


# --- gaps --------------------------------------------------------------------


def test_a_topic_that_cannot_be_read_is_a_gap_and_never_an_empty_one():
    realm = chain_realm(fail=("work-g-17",))
    found = discover({}, DESK, realm=realm, plane=board())
    assert "work-g-17/workrun-task1-g-17" in found.gaps["unread"]
    assert any(error["channel"] == "work-g-17" for error in found.gaps["errors"])
    node = next(one for one in found.topics if one.topic == "workrun-task1-g-17")
    assert node.known == "note-only" and node.works == []


def test_without_a_reader_every_named_topic_is_unread():
    found = discover({}, DESK, realm=None, plane=None)
    assert found.topics[0].topic == DESK_TOPIC
    assert found.gaps["plane"] == ["no Plane credential is configured, so no Work is known"]


def test_a_full_read_is_reported_as_a_window():
    long_history = [post(ident, "chatter") for ident in range(1, 401)]
    long_history.append(selfnote(401, "served", "pj-ghtrends/workplan-trend8 1"))
    realm = chain_realm(histories={("front", DESK_TOPIC): long_history})
    found = discover({}, DESK, realm=realm, plane=board())
    assert found.gaps["bounded"] == [f"front/{DESK_TOPIC}"]


# --- Plane -------------------------------------------------------------------


def test_the_mission_and_its_task_are_found_by_identifier_and_by_note():
    found = discover({}, DESK, realm=chain_realm(), plane=board())
    by_label = {work.label: work for work in found.works}
    assert set(by_label) == {"G-17", "G-18", "F2-28"}
    mission = by_label["G-17"]
    assert mission.role == "mission" and mission.state_group == "started"
    assert {row["how"] for row in mission.evidence} == {
        "external_id", "parent of a [work] note's Sub-Work"}
    assert by_label["G-18"].role == "task" and by_label["G-18"].state_group == "completed"
    assert mission.children == [{"issue_id": TASK, "label": "G-18", "title": "Summarize",
                                 "state": "completed", "reached": True}]
    # forge's own Work, named outright by its `<project>/<issue>` note.
    assert by_label["F2-28"].project_name == "FreeForge"


def test_a_sub_work_this_conversation_never_reached_is_listed_unreached():
    extra = issue("second", sequence=19, name="A task nobody linked", state="s-started",
                  parent=MISSION, external="pj-ghtrends/workplan-trend8#2")
    found = discover({}, DESK, realm=chain_realm(), plane=board(extra_ghtrends=(extra,)))
    mission = next(work for work in found.works if work.label == "G-17")
    assert [(row["label"], row["state"], row["reached"]) for row in mission.children] == [
        ("G-18", "completed", True), ("G-19", "started", False)]


def test_a_cancelled_child_is_carried_with_its_state():
    extra = issue("third", sequence=20, name="Dropped", state="s-cancel", parent=MISSION)
    found = discover({}, DESK, realm=chain_realm(), plane=board(extra_ghtrends=(extra,)))
    mission = next(work for work in found.works if work.label == "G-17")
    assert ("G-20", "cancelled") in [(row["label"], row["state"]) for row in mission.children]


def test_a_project_the_credential_cannot_read_is_reported_not_raised():
    found = discover({}, DESK, realm=chain_realm(), plane=board(refuse=(GHTRENDS,)))
    assert [work.label for work in found.works] == ["F2-28"]
    assert any("states of project Ghtrends" in note for note in found.gaps["plane"])
    assert any("which is not in any project" in note for note in found.gaps["plane"])


# --- channels ----------------------------------------------------------------


def test_a_dedicated_channel_whose_every_topic_is_ours_is_archivable():
    found = discover({}, DESK, realm=chain_realm(), plane=board())
    row = next(one for one in found.channels if one["channel"] == "work-g-17")
    assert row["archivable"] is True and row["bound_to_mission"] is True
    assert row["topics"] == ["workrun-task1-g-17"]
    # The shared channels are never candidates at all.
    assert [one["channel"] for one in found.channels] == ["work-g-17"]


def test_a_channel_holding_a_topic_this_conversation_did_not_reach_is_kept():
    realm = chain_realm(topics={"work-g-17": ["✔ workrun-task1-g-17", "workrun-task2-g-17"]})
    realm.histories[("work-g-17", "workrun-task2-g-17")] = [post(60, "somebody else's task")]
    found = discover({}, DESK, realm=realm, plane=board())
    row = next(one for one in found.channels if one["channel"] == "work-g-17")
    assert row["archivable"] is False
    assert row["unaccounted"] == ["workrun-task2-g-17"]


def test_a_channel_with_no_mission_of_ours_behind_it_is_not_archivable():
    found = discover({}, DESK, realm=chain_realm(), plane=board(refuse=(GHTRENDS,)))
    row = next(one for one in found.channels if one["channel"] == "work-g-17")
    assert row["archivable"] is False and row["bound_to_mission"] is False
    assert "nothing binds the channel" in row["reason"]


def test_a_channel_whose_topics_cannot_be_listed_is_reported():
    realm = chain_realm()
    realm.streams.pop("work-g-17")
    found = discover({}, DESK, realm=realm, plane=board())
    row = next(one for one in found.channels if one["channel"] == "work-g-17")
    assert row["archivable"] is False and row["topics"] is None
    assert row["reason"] == "the channel's topics could not be read"
