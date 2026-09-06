"""The routine board's rules, against made-up routines.

The live realm cannot prove any of these either: every routine on it is
answered most of the time, and the states worth getting right are the ones
that mean somebody has to look.
"""

import json
import os
import time
from pathlib import Path

from agentroom.chat import Chat, allowed_topic
from agentroom.inflight import Inflight, parse_roots
from agentroom.ops import Topic
from agentroom.routines import (
    Schedule,
    answer_of,
    fire_of,
    is_routine_topic,
    read_schedule,
    routine_name,
    chat_of,
    routine_rows,
    schedule_for,
    session_tree,
    sessions_of,
)

NOW = 1_800_000_000.0
STALL = 900.0
DEVELOPER = 8
FRONT = 15


def message(content, *, ident=1, sender_id=DEVELOPER, sender="Developer", ago=0.0):
    return {
        "id": ident,
        "sender_id": sender_id,
        "sender_full_name": sender,
        "sender_realm_str": "agdev",
        "timestamp": int(NOW - ago),
        "content": content,
    }


def fire(name, *, ident=1, ago=0.0):
    return message(
        f"Routine `{name}`, run of 2026-09-06T00:00Z. The standing request is the latest "
        f"post in #front › `routine-{name}`; this topic holds the earlier runs. Do it.",
        ident=ident, ago=ago,
    )


def history_of(*messages):
    """The `Message` records a fire topic keeps, which is what the two readers
    below are given in the engine."""
    return topic("front", "front-routine-x", *messages).history


def topic(channel, name, *messages, resolved=False, keep=True):
    found = Topic(
        channel=channel, topic=name, live_topic=name, resolved=resolved, keep_history=keep
    )
    for one in messages:
        found.add(one)
    return found


# --- which topics are a routine's -----------------------------------------


def test_both_of_a_routines_topics_are_recognised_and_nothing_else_is():
    assert is_routine_topic("front", "routine-papers")
    assert is_routine_topic("front", "front-routine-papers")
    # Same names in another channel are somebody else's conversation.
    assert not is_routine_topic("pj-studyarxiv", "routine-papers")
    assert not is_routine_topic("front", "front-p10-cleanup")


def test_the_name_comes_off_the_longer_prefix_first():
    # `front-routine-papers` starts with neither `routine-`, but a reader that
    # tested the short prefix first would have called it `front-routine-papers`
    # in the standing branch and produced a second, phantom routine.
    assert routine_name("front-routine-papers") == "papers"
    assert routine_name("routine-papers") == "papers"
    assert routine_name("front-p10-cleanup") is None


# --- which post is the fire -----------------------------------------------


def test_the_fire_is_the_triggers_own_wording_not_the_newest_developer_post():
    history = history_of(fire("papers", ident=1, ago=600), message("that run was wrong", ident=2, ago=60))
    found = fire_of(history, "papers")
    assert found is not None and found.id == 1


def test_a_fire_of_another_routine_in_the_same_topic_is_not_this_ones():
    history = history_of(fire("papers", ident=1), fire("publish", ident=2))
    assert fire_of(history, "papers").id == 1
    assert fire_of(history, "publish").id == 2


# --- answered, acked, unanswered ------------------------------------------


def test_an_ack_is_not_an_answer():
    # The whole reason this is three states: Front acks every request it
    # receives, so a board that read the ack as a reply would call a routine
    # answered the instant it was fired, forever.
    history = history_of(
        fire("papers", ident=1, ago=300),
        message("Message received. Please wait for the reply.",
                ident=2, sender_id=FRONT, sender="Front", ago=290),
    )
    found = answer_of(history, fire_of(history, "papers"), NOW)
    assert found["state"] == "acked"
    assert found["ack"]["message_id"] == 2
    # Measured from the fire, not from the ack: the question is how long ago
    # the routine was asked for.
    assert found["age_seconds"] == 300


def test_a_real_reply_by_somebody_else_is_the_answer():
    history = history_of(
        fire("papers", ident=1, ago=300),
        message("Message received. Please wait for the reply.",
                ident=2, sender_id=FRONT, sender="Front", ago=290),
        message("Done — one paper summarised.", ident=3, sender_id=FRONT, sender="Front", ago=100),
    )
    found = answer_of(history, fire_of(history, "papers"), NOW)
    assert found["state"] == "answered"
    assert found["answer"]["message_id"] == 3
    assert found["answered_after"] == 200


def test_the_developers_own_second_post_does_not_answer_their_fire():
    history = history_of(fire("papers", ident=1, ago=300), message("and be quick", ident=2, ago=200))
    found = answer_of(history, fire_of(history, "papers"), NOW)
    assert found["state"] == "unanswered"


def test_a_reply_older_than_the_fire_belongs_to_the_previous_run():
    history = history_of(
        fire("papers", ident=1, ago=9000),
        message("done", ident=2, sender_id=FRONT, sender="Front", ago=8000),
        fire("papers", ident=3, ago=300),
    )
    found = answer_of(history, fire_of(history, "papers"), NOW)
    assert found["state"] == "unanswered"


# --- the row's state word --------------------------------------------------


def rows(*topics, schedule=None, now=NOW):
    mapping = {(found.channel, found.topic): found for found in topics}
    return routine_rows(
        mapping,
        schedule or Schedule(path=None, ok=False, error="unset"),
        now,
        stalled_seconds=STALL,
    )


def test_an_unanswered_fire_becomes_stalled_at_the_ops_threshold():
    quick = rows(topic("front", "front-routine-papers", fire("papers", ident=1, ago=60)))
    assert quick[0]["state"] == "awaiting"
    slow = rows(topic("front", "front-routine-papers", fire("papers", ident=1, ago=4000)))
    assert slow[0]["state"] == "stalled"


def test_an_ack_that_never_became_an_answer_stalls_too():
    # A run that acked and then died looks exactly like a healthy one for as
    # long as you only ask "did it start?". This is the p9 failure again, in
    # the one place the routine board can catch it.
    history = topic(
        "front", "front-routine-papers",
        fire("papers", ident=1, ago=4000),
        message("Message received. Please wait for the reply.",
                ident=2, sender_id=FRONT, sender="Front", ago=3990),
    )
    assert rows(history)[0]["state"] == "stalled"


def test_a_routine_with_no_fire_at_all_is_unknown_and_never_idle():
    found = rows(topic("front", "routine-papers", message("the standing request", ident=1)))
    assert found[0]["state"] == "unknown"
    assert found[0]["answer"]["state"] == "no fire"


def test_the_standing_request_is_the_newest_post_in_the_request_topic():
    found = rows(topic(
        "front", "routine-papers",
        message("v1 of the request", ident=1),
        message("v2 of the request", ident=2),
    ))
    assert found[0]["request"]["text"] == "v2 of the request"
    assert found[0]["request"]["message_id"] == 2


def test_a_post_by_somebody_else_is_not_the_standing_request():
    # Measured on the live realm (`operation_room` p3 step 1): Front filed a
    # run report into `#front` › `routine-ghtrends` on 2026-09-04, so the
    # "latest post" the trigger names is a report about the routine. The
    # author of the topic is who the request belongs to.
    found = rows(topic(
        "front", "routine-ghtrends",
        message("Standing request for the `ghtrends` routine, v1.", ident=1),
        message("Done — routine ghtrends run.", ident=2, sender_id=FRONT, sender="Front"),
    ))
    assert found[0]["request"]["message_id"] == 1
    assert [stray["message_id"] for stray in found[0]["request_strays"]] == [2]


def test_a_tick_on_the_standing_request_retires_the_routine():
    found = rows(topic(
        "front", "routine-papers", message("the standing request", ident=1), resolved=True
    ))
    assert found[0]["retired"] is True


def test_a_selfnote_is_not_history_and_never_reaches_the_view():
    # Constraint 4: notes may link, never appear. The chat view renders
    # `history`, so a note in it would be a note on the screen.
    found = topic(
        "front", "front-routine-papers",
        fire("papers", ident=1),
        message("[selfnote][served] pj-studyarxiv/workplan-papers 2809",
                ident=2, sender_id=FRONT, sender="Front"),
    )
    assert [kept.id for kept in found.history] == [1]
    assert found.served[("pj-studyarxiv", "workplan-papers")]["remote_id"] == 2809


def test_a_routine_the_schedule_names_but_the_realm_does_not_still_gets_a_row():
    schedule = Schedule(
        path="x", ok=True, requests=[],
        events=[{"id": "e1", "at": "2026-09-06T09:00:00Z", "kind": "fire",
                 "from": "r1", "fired_at": None, "routine": "ghosts"}],
    )
    found = rows(schedule=schedule)
    assert [row["name"] for row in found] == ["ghosts"]
    assert found[0]["fire_topic"] is None


# --- the schedule ----------------------------------------------------------


def test_the_schedule_splits_fired_upcoming_and_overdue():
    schedule = Schedule(
        path="x", ok=True, requests=[],
        events=[
            {"id": "e1", "at": "2026-09-05T09:00:00Z", "fired_at": "2026-09-05T09:00:15Z",
             "from": "r8", "routine": "papers"},
            {"id": "e2", "at": "2026-09-06T09:00:00Z", "fired_at": None,
             "from": "r8", "routine": "papers"},
            {"id": "e3", "at": "2026-09-07T09:00:00Z", "fired_at": None,
             "from": "r8", "routine": "papers"},
        ],
    )
    # 2026-09-06T12:00Z, so e2 is due and unfired: the dispatcher runs every
    # five minutes, and one that did not is exactly what this must not hide.
    found = schedule_for(schedule, "papers", 1_788_696_000.0)
    assert found["next"]["id"] == "e3"
    assert found["last"]["id"] == "e1"
    assert [event["id"] for event in found["overdue"]] == ["e2"]


def test_an_unset_schedule_path_is_an_answer_and_not_an_empty_schedule(tmp_path):
    found = read_schedule(None)
    assert found.ok is False and "unset" in found.error
    assert found.payload()["configured"] is False


def test_an_unreadable_schedule_says_so_rather_than_reading_as_no_fires(tmp_path):
    missing = read_schedule(tmp_path / "nope.json")
    assert missing.ok is False and "cannot read" in missing.error
    broken = tmp_path / "schedule.json"
    broken.write_text("{ not json", encoding="utf-8")
    assert read_schedule(broken).ok is False
    shaped = tmp_path / "shaped.json"
    shaped.write_text(json.dumps({"requests": [], "events": []}), encoding="utf-8")
    assert read_schedule(shaped).ok is True


# --- the session tree ------------------------------------------------------


def rootnote(home, *, ident, sender_id=FRONT, sender="Front"):
    return message(f"[selfnote][rootchat] {home}", ident=ident,
                   sender_id=sender_id, sender=sender)


def servednote(remote, remote_id, *, ident, sender_id=FRONT, sender="Front"):
    return message(f"[selfnote][served] {remote} {remote_id}", ident=ident,
                   sender_id=sender_id, sender=sender)


def mapping(*topics):
    return {(found.channel, found.topic): found for found in topics}


def test_a_served_note_finds_a_child_that_was_resolved_and_never_swept():
    # The half of a finished session that only this edge can see: a resolved
    # topic is not swept, so the child is not in `topics` at all — and the
    # board says `note-only` rather than pretending it read it.
    topics = mapping(topic(
        "front", "front-routine-papers",
        fire("papers", ident=10),
        servednote("pj-studyarxiv/workplan-papers", 90, ident=20),
    ))
    nodes = session_tree(topics, ("front", "front-routine-papers"), {}, since=0, until=None)
    assert [(node["topic"], node["via"], node["known"]) for node in nodes] == [
        ("workplan-papers", "served", "note-only")
    ]
    assert nodes[0]["state"] == "unknown"


def test_a_rootchat_note_finds_a_child_nothing_has_answered_yet():
    # The in-flight half: Front has posted into the workplan topic and nobody
    # has called back, so no served note exists anywhere.
    child = topic("pj-studyarxiv", "workplan-papers",
                  rootnote("front/front-routine-papers", ident=21),
                  message("opened the mission", ident=22, sender_id=FRONT, sender="Front"),
                  keep=False)
    topics = mapping(topic("front", "front-routine-papers", fire("papers", ident=10)), child)
    nodes = session_tree(topics, ("front", "front-routine-papers"), {}, since=0, until=None)
    assert [(node["topic"], node["via"], node["known"]) for node in nodes] == [
        ("workplan-papers", "rootchat", "swept")
    ]
    # No ops row for it means nothing is owed there, which is not "unknown".
    assert nodes[0]["state"] == "quiet"


def test_the_tree_goes_deeper_than_one_hop():
    root = topic("front", "front-routine-papers", fire("papers", ident=10),
                 servednote("pj-studyarxiv/workplan-papers", 90, ident=20))
    middle = topic("pj-studyarxiv", "workplan-papers",
                   servednote("work-s3-1/workrun-task1", 95, ident=30), keep=False)
    nodes = session_tree(topics := mapping(root, middle),
                         ("front", "front-routine-papers"), {}, since=0, until=None)
    assert [(node["topic"], node["depth"]) for node in nodes] == [
        ("workplan-papers", 1), ("workrun-task1", 2)
    ]
    assert topics is not None


def test_a_node_wears_the_ops_boards_verdict_and_never_its_own():
    root = topic("front", "front-routine-papers", fire("papers", ident=10),
                 servednote("pj-studyarxiv/workplan-papers", 90, ident=20))
    child = topic("pj-studyarxiv", "workplan-papers",
                  message("anybody?", ident=91), keep=False)
    rows = {("pj-studyarxiv", "workplan-papers"): [
        {"state": "done", "instance": "a"}, {"state": "stalled", "instance": "b"},
    ]}
    nodes = session_tree(mapping(root, child), ("front", "front-routine-papers"),
                         rows, since=0, until=None)
    # Both rows are carried; the node wears the most urgent of them.
    assert nodes[0]["state"] == "stalled"
    assert len(nodes[0]["rows"]) == 2


def test_a_session_is_bounded_by_the_next_fire():
    root = topic(
        "front", "front-routine-papers",
        fire("papers", ident=10),
        servednote("pj-a/one", 5, ident=11),
        fire("papers", ident=20),
        servednote("pj-a/two", 6, ident=21),
    )
    found = sessions_of(mapping(root), "papers", {})
    # Newest first, and each run carries only what was linked inside it.
    assert [session["fire"]["message_id"] for session in found] == [20, 10]
    assert [node["topic"] for node in found[0]["nodes"]] == ["two"]
    assert [node["topic"] for node in found[1]["nodes"]] == ["one"]


def test_only_the_last_three_runs_are_listed():
    posts = []
    for index in range(5):
        posts.append(fire("papers", ident=10 * (index + 1)))
        posts.append(servednote(f"pj-a/run{index}", 1, ident=10 * (index + 1) + 1))
    found = sessions_of(mapping(topic("front", "front-routine-papers", *posts)), "papers", {})
    assert [session["fire"]["message_id"] for session in found] == [50, 40, 30]


def test_a_routine_nobody_fired_still_shows_its_conversation():
    # mediagen: 164 posts in the fire topic and not one trigger line.
    root = topic("front", "front-routine-mediagen",
                 message("do the thing by hand", ident=10),
                 servednote("pj-mediagen/assetplan-x", 5, ident=11))
    found = sessions_of(mapping(root), "mediagen", {})
    assert len(found) == 1 and found[0]["fire"] is None
    assert [node["topic"] for node in found[0]["nodes"]] == ["assetplan-x"]


def test_the_chat_is_real_posts_only_and_oldest_first():
    root = topic(
        "front", "front-routine-papers",
        message("later", ident=20),
        message("[selfnote][rootchat] front/front-routine-papers", ident=15,
                sender_id=FRONT, sender="Front"),
        fire("papers", ident=10),
    )
    found = chat_of(mapping(root), "papers")
    assert [post["message_id"] for post in found] == [10, 20]


# --- the write door --------------------------------------------------------


def test_chat_posts_only_into_a_known_routines_topics():
    names = {"papers"}
    assert allowed_topic("front-routine-papers", names)
    assert allowed_topic("routine-papers", names)
    # Front's own request topics, another agent's channel, and a routine this
    # relay has never seen are all the same refusal: routing is Front's job.
    assert not allowed_topic("front-p10-cleanup", names)
    assert not allowed_topic("front-routine-ghosts", names)


def test_an_unconfigured_chat_refuses_and_says_which_variable():
    chat = Chat(env_path=None)
    refused = chat.check("front-routine-papers", "hello", {"papers"})
    assert "AGENTROOM_CHAT_ZULIP_ENV" in refused
    assert chat.status()["configured"] is False


def test_a_configured_chat_still_refuses_the_wrong_topic(tmp_path):
    chat = Chat(env_path=tmp_path / "developer.env")
    assert chat.check("pj-mediagen/whatever", "hello", {"papers"}) is not None
    assert chat.check("front-routine-papers", "hello", {"papers"}) is None


def test_an_over_long_message_is_refused_rather_than_truncated(tmp_path):
    # comfynotify proved Zulip drops the tail of an over-long post with no
    # error anywhere. A boundary that fails invisibly gets a loud refusal.
    chat = Chat(env_path=tmp_path / "developer.env", max_chars=50)
    refused = chat.check("front-routine-papers", "x" * 51, {"papers"})
    assert "51 characters" in refused and "10000" in refused
    assert chat.check("front-routine-papers", "x" * 50, {"papers"}) is None


def test_a_selfnote_cannot_be_typed_by_hand(tmp_path):
    chat = Chat(env_path=tmp_path / "developer.env")
    refused = chat.check("front-routine-papers", "[selfnote][served] a/b 1", {"papers"})
    assert "machine-to-machine" in refused


def test_a_sent_message_goes_to_front_and_reports_its_id(tmp_path):
    class FakeClient:
        def __init__(self):
            self.sent = []

        def send_to_channel(self, channel, topic, content):
            self.sent.append((channel, topic, content))
            return 4242

    fake = FakeClient()
    chat = Chat(env_path=tmp_path / "developer.env", client_factory=lambda path: fake)
    found = chat.send("front-routine-papers", "  how did that run go?  ", {"papers"})
    assert found == {
        "sent": True, "channel": "front", "topic": "front-routine-papers",
        "message_id": 4242,
        "note": "the post is live in the realm; the event queue will carry it back",
    }
    # Trimmed, and posted exactly once.
    assert fake.sent == [("front", "front-routine-papers", "how did that run go?")]


def test_a_refused_message_is_never_posted(tmp_path):
    class Exploding:
        def send_to_channel(self, *args):
            raise AssertionError("a refused message must not reach Zulip")

    chat = Chat(env_path=tmp_path / "developer.env", client_factory=lambda path: Exploding())
    assert chat.send("front-p10-cleanup", "hello", {"papers"})["sent"] is False


# --- the host-side in-flight signal ----------------------------------------


def workspace(root, channel, topic, generation, role="front"):
    made = root / ".local" / "topics" / channel / topic / str(generation) / role
    made.mkdir(parents=True)
    (made / "chatlog.md").write_text("hello", encoding="utf-8")
    return made


def record(root, role, number, *, at):
    made = root / ".local" / "agent" / role
    made.mkdir(parents=True, exist_ok=True)
    path = made / f"run-{number:04d}.json"
    path.write_text("{}", encoding="utf-8")
    os.utime(path, (at, at))
    return path


def test_roots_are_parsed_as_instances_because_an_agent_runs_on_more_than_one_node():
    found = parse_roots("front-agstudio1=/a/agfront, autolab-agstudio1=/a/agautolab ,junk")
    assert set(found) == {"front-agstudio1", "autolab-agstudio1"}
    assert found["front-agstudio1"] == Path("/a/agfront")


def test_an_instance_with_no_root_here_is_unknown_and_never_idle(tmp_path):
    look = Inflight(roots={})
    found = look.look("agecho-agautolab1", "front", "front-routine-papers")
    assert found["known"] is False and found["in_flight"] is None
    assert look.busy("agecho-agautolab1")["known"] is False


def test_a_workspace_newer_than_every_run_record_is_a_run_in_flight(tmp_path):
    root = tmp_path / "agfront"
    record(root, "front", 1, at=time.time() - 3600)
    workspace(root, "front", "front-routine-papers", 7)
    found = Inflight(roots={"front-agstudio1": root}).look(
        "front-agstudio1", "front", "front-routine-papers")
    assert found["in_flight"] is True and found["generation"] == 7


def test_a_finished_run_leaves_a_record_newer_than_its_workspace(tmp_path):
    root = tmp_path / "agfront"
    workspace(root, "front", "front-routine-papers", 7)
    record(root, "entrance_front", 1, at=time.time() + 60)
    found = Inflight(roots={"front-agstudio1": root}).look(
        "front-agstudio1", "front", "front-routine-papers")
    # The record is filed under a different role name than the workspace uses
    # (p1: `…/<N>/front/` against `.local/agent/entrance_front/`), so the
    # comparison is against the newest record of *any* role.
    assert found["in_flight"] is False


def test_a_topic_this_instance_never_worked_in_is_not_in_flight(tmp_path):
    root = tmp_path / "agfront"
    record(root, "front", 1, at=time.time() - 60)
    found = Inflight(roots={"front-agstudio1": root}).look(
        "front-agstudio1", "front", "front-routine-nothing")
    assert found["in_flight"] is False and found["generation"] is None


def test_busy_catches_a_run_that_is_not_in_this_topics_workspace(tmp_path):
    # p1: autolab's `coding` and `director` roles run in no topic workspace at
    # all — 100% of them. The coarse signal is what keeps the screen from
    # calling an agent idle exactly when it is busiest.
    root = tmp_path / "agautolab"
    record(root, "coding", 1, at=time.time() - 3600)
    workspace(root, "pj-studyarxiv", "workplan-papers", 2, role="supercoder")
    look = Inflight(roots={"autolab-agstudio1": root})
    assert look.look("autolab-agstudio1", "front", "front-routine-papers")["in_flight"] is False
    busy = look.busy("autolab-agstudio1")
    assert busy["in_flight"] is True and busy["where"] == "pj-studyarxiv/workplan-papers"
