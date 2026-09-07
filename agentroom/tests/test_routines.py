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
    nodes = session_tree(topics, ("front", "front-routine-papers"), {}, since=0, until=None)["nodes"]
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
    nodes = session_tree(topics, ("front", "front-routine-papers"), {}, since=0, until=None)["nodes"]
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
                         ("front", "front-routine-papers"), {}, since=0, until=None)["nodes"]
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
                         rows, since=0, until=None)["nodes"]
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


def test_graph_edges_keep_the_immediate_parent_through_three_hops():
    root = topic("front", "front-routine-papers", fire("papers", ident=10),
                 servednote("project/plan", 90, ident=20))
    plan = topic("project", "plan", rootnote("front/front-routine-papers", ident=21))
    work = topic("work", "task", rootnote("project/plan", ident=30),
                 servednote("forge/result", 100, ident=40))
    nodes = session_tree(mapping(root, plan, work),
                         ("front", "front-routine-papers"), {}, since=0, until=None)["nodes"]
    assert [(node["channel"], node["topic"], node["depth"], node["parent"]) for node in nodes] == [
        ("project", "plan", 1, {"channel": "front", "topic": "front-routine-papers"}),
        ("work", "task", 2, {"channel": "project", "topic": "plan"}),
        ("forge", "result", 3, {"channel": "work", "topic": "task"}),
    ]
    assert nodes[-1]["known"] == "note-only"
    assert nodes[-1]["state"] == "unknown"


def test_node_limit_reports_only_actual_omissions():
    root = topic("front", "front-routine-papers", fire("papers", ident=10),
                 *[servednote(f"pj-a/child-{i}", 90, ident=20+i) for i in range(41)])
    tree = session_tree(mapping(root), ("front", root.topic), {}, since=0, until=None)
    assert len(tree["nodes"]) == 40
    assert tree["truncation"] == {
        "truncated": True, "reasons": ["nodes"], "max_nodes": 40, "max_depth": 4,
    }
    # A link outside the fire window does not consume the limit.
    exact = session_tree(mapping(root), ("front", root.topic), {}, since=0, until=60)
    assert len(exact["nodes"]) == 40
    assert exact["truncation"]["truncated"] is False


def test_depth_limit_distinguishes_leaf_cycle_and_omitted_descendant():
    root = topic("front", "front-routine-papers", fire("papers", ident=10),
                 servednote("pj-a/level-1", 90, ident=20))
    chain = [topic("pj-a", f"level-{i}",
                   servednote(f"pj-a/level-{i+1}", 90, ident=20+i)) for i in range(1, 5)]
    tree = session_tree(mapping(root, *chain), ("front", root.topic), {}, since=0, until=None)
    assert len(tree["nodes"]) == 4
    assert tree["truncation"]["reasons"] == ["depth"]
    leaf = session_tree(mapping(root, *chain[:-1]), ("front", root.topic), {}, since=0, until=None)
    assert leaf["truncation"]["truncated"] is False
    cycle = topic("pj-a", "level-4", servednote("front/front-routine-papers", 90, ident=30))
    tree = session_tree(mapping(root, *chain[:-1], cycle), ("front", root.topic), {}, since=0, until=None)
    assert tree["truncation"]["truncated"] is False


def test_sessions_expose_reconstruction_bounds_for_manual_and_scheduled_activity():
    for posts in [[], [fire("papers", ident=10)]]:
        root = topic("front", "front-routine-papers", *posts,
                     *[servednote(f"pj-a/child-{i}", 90, ident=20+i) for i in range(41)])
        session = sessions_of(mapping(root), "papers", {})[0]
        assert session["truncation"]["truncated"] is True
        assert len(session["nodes"]) == 40


# --- session identity, origin and resolution (operation_room p6) ----------


from agentroom.routines import (  # noqa: E402
    MANUAL_MARK,
    fire_line,
    fire_origin,
    resolution_of,
    session_list,
)

TRIGGER = Path(__file__).resolve().parents[3] / "devenv" / "routine" / "trigger.sh"


def notice(kind, *, ident):
    return {
        "id": ident, "sender_id": 6, "sender_full_name": "Notification Bot",
        "sender_realm_str": "zulipinternal", "timestamp": int(NOW),
        "content": f"@_**Developer|8** has marked this topic as {kind}.",
    }


def test_the_triggers_own_wording_is_recognised_as_a_scheduled_fire():
    # The contract with `devenv/routine/trigger.sh`: its `text=` line, with
    # the shell pieces substituted, must be a fire and must read as scheduled.
    # Rewording the script without rewording this reader breaks here, not on
    # the board.
    source = TRIGGER.read_text(encoding="utf-8")
    line = next(one for one in source.splitlines() if one.startswith("text="))
    text = line[len("text="):].strip('"').replace("\\`", "`")
    text = text.replace("$name", "papers").replace("$stamp", "2026-09-07T05:00Z")
    assert FIRE_LINE_MATCH(text) == "papers"
    assert fire_origin(text) == "scheduled"


def FIRE_LINE_MATCH(text):
    from agentroom.routines import FIRE_LINE
    match = FIRE_LINE.match(text)
    return match.group("name") if match else None


def test_a_manual_fire_is_a_fire_and_is_told_apart_by_its_mark():
    text = fire_line("papers", "2026-09-07T05:00Z")
    assert FIRE_LINE_MATCH(text) == "papers"
    assert fire_origin(text) == "manual"
    assert MANUAL_MARK in text and "routine-papers" in text
    with_note = fire_line("papers", "2026-09-07T05:00Z", "  only the first paper  ")
    assert with_note.endswith("Instruction for this run: only the first paper")
    assert fire_origin("Routine `papers`, run of now. Go.") == "unknown"


def test_a_resolve_notice_is_kept_beside_the_history_and_never_in_it():
    found = topic("front", "front-routine-papers", fire("papers", ident=1),
                  notice("resolved", ident=2))
    assert [kept.id for kept in found.history] == [1]
    assert [kept.id for kept in found.notices] == [2]
    # A human typing the sentence is speech, not a notice.
    typed = topic("front", "front-routine-papers",
                  message("has marked this topic as resolved", ident=3))
    assert typed.notices == [] and [kept.id for kept in typed.history] == [3]


def test_the_latest_session_is_resolved_by_the_topics_current_flag():
    found = resolution_of([], since=10, until=None, topic_resolved=True)
    assert found["state"] == "resolved" and "latest fire" in found["evidence"]
    assert resolution_of([], since=10, until=None, topic_resolved=False)["state"] == "open"


def test_an_older_session_is_resolved_only_by_a_notice_inside_its_span():
    notices = topic("front", "front-routine-papers", notice("resolved", ident=15)).notices
    # Inside [10, 20): resolved, and it says which notice.
    inside = resolution_of(notices, since=10, until=20, topic_resolved=False)
    assert inside["state"] == "resolved" and inside["notice"]["message_id"] == 15
    # A span with no notice is unknown even while the topic carries ✔ today.
    older = resolution_of(notices, since=1, until=10, topic_resolved=True)
    assert older["state"] == "unknown" and older["notice"] is None


def test_reopening_is_the_newest_notice_in_the_span():
    notices = topic("front", "front-routine-papers",
                    notice("resolved", ident=15), notice("unresolved", ident=17)).notices
    found = resolution_of(notices, since=10, until=20, topic_resolved=False)
    assert found["state"] == "reopened" and found["notice"]["message_id"] == 17
    # For the latest session the current flag still wins over an old notice.
    assert resolution_of(notices, since=10, until=None, topic_resolved=True)["state"] == "resolved"


def test_sessions_carry_their_identity_origin_and_resolution():
    schedule = Schedule(
        path="x", ok=True, requests=[],
        events=[{"id": "e7", "at": "2026-09-06T00:00:00Z", "kind": "fire", "from": "r8",
                 "fired_at": "2026-09-06T00:00:20Z", "routine": "papers"}],
    )
    from datetime import datetime, timezone
    at = int(datetime(2026, 9, 6, tzinfo=timezone.utc).timestamp())
    root = topic(
        "front", "front-routine-papers",
        {**fire("papers", ident=10), "timestamp": at + 5},
        notice("resolved", ident=12),
        {**message(fire_line("papers", "2026-09-07T05:00Z"), ident=20), "timestamp": at + 9000},
    )
    found = session_list(mapping(root), "papers", {}, schedule=schedule)
    first, second = found["sessions"]
    assert (first["id"], first["start_id"], first["end_id"]) == (20, 20, None)
    assert first["origin"] == "manual" and first["resolution"]["state"] == "open"
    assert (second["id"], second["start_id"], second["end_id"]) == (10, 10, 20)
    assert second["origin"] == "scheduled" and second["schedule_event"]["id"] == "e7"
    assert second["resolution"]["state"] == "resolved"
    assert found["latest_fire"]["message_id"] == 20
    assert found["history"]["fires"] == 2 and found["history"]["bounded"] is False


def test_hiding_resolved_sessions_filters_before_the_limit():
    posts = []
    for index in range(5):
        posts.append(fire("papers", ident=10 * (index + 1)))
        if index < 3:
            posts.append(notice("resolved", ident=10 * (index + 1) + 5))
    root = topic("front", "front-routine-papers", *posts)
    shown = session_list(mapping(root), "papers", {}, include_resolved=False)
    assert [session["id"] for session in shown["sessions"]] == [50, 40]
    assert shown["history"]["hidden_resolved"] == 3
    # The unfiltered reading still leads with the actual latest fire.
    assert [session["id"] for session in sessions_of(mapping(root), "papers", {})] == [50, 40, 30]


def test_a_full_history_window_is_reported_as_bounded():
    posts = [fire("papers", ident=index + 1) for index in range(ROUTINE_HISTORY_LIMIT() + 1)]
    root = topic("front", "front-routine-papers", *posts)
    found = session_list(mapping(root), "papers", {})
    assert found["history"]["bounded"] is True
    assert "not searched" in found["history"]["note"]


def ROUTINE_HISTORY_LIMIT():
    from agentroom.routines import ROUTINE_HISTORY
    return ROUTINE_HISTORY
