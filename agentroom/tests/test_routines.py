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
    DEEP_RUNS,
    Schedule,
    answer_of,
    fire_of,
    is_routine_topic,
    newest_run_topics,
    read_schedule,
    routine_name,
    routine_rows,
    run_topics_of,
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


STAMP = "2026-09-06T00:00Z"
RUN = f"front-routine-papers-{STAMP}"


def fire(name, *, ident=1, ago=0.0, stamp=STAMP):
    return message(
        f"Routine `{name}`, run of {stamp}. The standing request is the latest "
        f"post in #front › `routine-{name}`. This topic is this run alone. Do it.",
        ident=ident, ago=ago,
    )


def history_of(*messages):
    """The `Message` records a run topic keeps, which is what the two readers
    below are given in the engine."""
    return topic("front", RUN, *messages).history


def run(name, index, *messages, resolved=False):
    """A run topic of `name`, its stamp `index` hours after `STAMP`."""
    stamp = f"2026-09-06T{index:02d}:00Z"
    return topic("front", f"front-routine-{name}-{stamp}", *messages, resolved=resolved)


def topic(channel, name, *messages, resolved=False, keep=True):
    found = Topic(
        channel=channel, topic=name, live_topic=name, resolved=resolved, keep_history=keep
    )
    for one in messages:
        found.add(one)
    return found


# --- which topics are a routine's -----------------------------------------


def test_a_routines_standing_and_run_topics_are_recognised_and_nothing_else_is():
    assert is_routine_topic("front", "routine-papers")
    assert is_routine_topic("front", RUN)
    # Same names in another channel are somebody else's conversation.
    assert not is_routine_topic("pj-studyarxiv", "routine-papers")
    assert not is_routine_topic("front", "front-p10-cleanup")
    # The pre-p7 layout, one topic per routine, is an ordinary conversation now.
    assert not is_routine_topic("front", "front-routine-papers")


def test_the_name_comes_off_a_run_topic_without_its_stamp():
    assert routine_name(RUN) == "papers"
    assert routine_name("front-routine-my-routine-2026-09-06T00:00Z") == "my-routine"
    assert routine_name("routine-papers") == "papers"
    assert routine_name("front-routine-papers") is None
    assert routine_name("front-p10-cleanup") is None


def test_run_topics_sort_newest_first_and_the_newest_few_are_the_deep_ones():
    held = mapping(run("papers", 1), run("papers", 3, resolved=True), run("papers", 2),
                   run("publish", 9), topic("front", "routine-papers"))
    assert [found.topic for found in run_topics_of(held, "papers")] == [
        "front-routine-papers-2026-09-06T03:00Z",
        "front-routine-papers-2026-09-06T02:00Z",
        "front-routine-papers-2026-09-06T01:00Z",
    ]
    names = [f"front-routine-papers-2026-09-06T{i:02d}:00Z" for i in range(6)]
    names += ["front-routine-publish-2026-09-06T00:00Z", "routine-papers", "front-routine-papers"]
    deep = newest_run_topics(names)
    assert deep == set(names[6 - DEEP_RUNS:6]) | {"front-routine-publish-2026-09-06T00:00Z"}


# --- which post is the fire -----------------------------------------------


def test_the_fire_is_the_triggers_own_wording_not_the_newest_developer_post():
    history = history_of(fire("papers", ident=1, ago=600), message("that run was wrong", ident=2, ago=60))
    found = fire_of(history, "papers")
    assert found is not None and found.id == 1
    # A second fire line pasted into a run topic is a comment: the run is the
    # topic, and it started once.
    again = history_of(fire("papers", ident=1), fire("papers", ident=2))
    assert fire_of(again, "papers").id == 1


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


def test_a_second_fire_line_in_a_run_topic_does_not_restart_the_run():
    # One topic is one run (p7): the answer to the first fire stays the
    # answer, and a fire line pasted in later is a comment.
    history = history_of(
        fire("papers", ident=1, ago=9000),
        message("done", ident=2, sender_id=FRONT, sender="Front", ago=8000),
        fire("papers", ident=3, ago=300),
    )
    found = answer_of(history, fire_of(history, "papers"), NOW)
    assert found["state"] == "answered" and found["answer"]["message_id"] == 2


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
    quick = rows(topic("front", RUN, fire("papers", ident=1, ago=60)))
    assert quick[0]["state"] == "awaiting"
    slow = rows(topic("front", RUN, fire("papers", ident=1, ago=4000)))
    assert slow[0]["state"] == "stalled"


def test_an_ack_that_never_became_an_answer_stalls_too():
    # A run that acked and then died looks exactly like a healthy one for as
    # long as you only ask "did it start?". This is the p9 failure again, in
    # the one place the routine board can catch it.
    history = topic(
        "front", RUN,
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
    assert found[0]["latest_topic"] is None and found[0]["runs"] == 0


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
        "front", RUN,
        fire("papers", ident=10),
        servednote("pj-studyarxiv/workplan-papers", 90, ident=20),
    ))
    nodes = session_tree(topics, ("front", RUN), {}, since=0, until=None)["nodes"]
    assert [(node["topic"], node["via"], node["known"]) for node in nodes] == [
        ("workplan-papers", "served", "note-only")
    ]
    assert nodes[0]["state"] == "unknown"


def test_a_rootchat_note_finds_a_child_nothing_has_answered_yet():
    # The in-flight half: Front has posted into the workplan topic and nobody
    # has called back, so no served note exists anywhere.
    child = topic("pj-studyarxiv", "workplan-papers",
                  rootnote(f"front/{RUN}", ident=21),
                  message("opened the mission", ident=22, sender_id=FRONT, sender="Front"),
                  keep=False)
    topics = mapping(topic("front", RUN, fire("papers", ident=10)), child)
    nodes = session_tree(topics, ("front", RUN), {}, since=0, until=None)["nodes"]
    assert [(node["topic"], node["via"], node["known"]) for node in nodes] == [
        ("workplan-papers", "rootchat", "swept")
    ]
    # No ops row for it means nothing is owed there, which is not "unknown".
    assert nodes[0]["state"] == "quiet"


def test_the_tree_goes_deeper_than_one_hop():
    root = topic("front", RUN, fire("papers", ident=10),
                 servednote("pj-studyarxiv/workplan-papers", 90, ident=20))
    middle = topic("pj-studyarxiv", "workplan-papers",
                   servednote("work-s3-1/workrun-task1", 95, ident=30), keep=False)
    nodes = session_tree(topics := mapping(root, middle),
                         ("front", RUN), {}, since=0, until=None)["nodes"]
    assert [(node["topic"], node["depth"]) for node in nodes] == [
        ("workplan-papers", 1), ("workrun-task1", 2)
    ]
    assert topics is not None


def test_a_node_wears_the_ops_boards_verdict_and_never_its_own():
    root = topic("front", RUN, fire("papers", ident=10),
                 servednote("pj-studyarxiv/workplan-papers", 90, ident=20))
    child = topic("pj-studyarxiv", "workplan-papers",
                  message("anybody?", ident=91), keep=False)
    rows = {("pj-studyarxiv", "workplan-papers"): [
        {"state": "done", "instance": "a"}, {"state": "stalled", "instance": "b"},
    ]}
    nodes = session_tree(mapping(root, child), ("front", RUN),
                         rows, since=0, until=None)["nodes"]
    # Both rows are carried; the node wears the most urgent of them.
    assert nodes[0]["state"] == "stalled"
    assert len(nodes[0]["rows"]) == 2


def test_a_session_is_a_run_topic_and_carries_only_what_it_linked():
    held = mapping(
        run("papers", 1, fire("papers", ident=10), servednote("pj-a/one", 5, ident=11)),
        run("papers", 2, fire("papers", ident=20), servednote("pj-a/two", 6, ident=21)),
    )
    found = sessions_of(held, "papers", {})
    # Newest first, and each run carries only what was linked inside it.
    assert [session["fire"]["message_id"] for session in found] == [20, 10]
    assert [session["topic"] for session in found] == [
        "front-routine-papers-2026-09-06T02:00Z", "front-routine-papers-2026-09-06T01:00Z",
    ]
    assert [node["topic"] for node in found[0]["nodes"]] == ["two"]
    assert [node["topic"] for node in found[1]["nodes"]] == ["one"]


def test_only_the_last_three_runs_are_listed():
    held = mapping(*[
        run("papers", index, fire("papers", ident=10 * index),
            servednote(f"pj-a/run{index}", 1, ident=10 * index + 1))
        for index in range(1, 6)
    ])
    found = sessions_of(held, "papers", {})
    assert [session["fire"]["message_id"] for session in found] == [50, 40, 30]


def test_a_run_topic_opened_by_hand_is_still_a_session():
    # No trigger line at all: somebody opened the topic and typed.
    root = run("mediagen", 1,
               message("do the thing by hand", ident=10),
               servednote("pj-mediagen/assetplan-x", 5, ident=11))
    found = sessions_of(mapping(root), "mediagen", {})
    assert len(found) == 1 and found[0]["fire"] is None and found[0]["id"] == 10
    assert found[0]["origin"] == "unknown" and "by hand" in found[0]["origin_evidence"]
    assert [node["topic"] for node in found[0]["nodes"]] == ["assetplan-x"]


def test_the_chat_is_real_posts_only_and_oldest_first():
    root = topic(
        "front", RUN,
        message("later", ident=20),
        message(f"[selfnote][rootchat] front/{RUN}", ident=15,
                sender_id=FRONT, sender="Front"),
        fire("papers", ident=10),
    )
    found = sessions_of(mapping(root), "papers", {})[0]["chat"]
    assert [post["message_id"] for post in found] == [10, 20]


# --- the write door --------------------------------------------------------


def test_chat_posts_only_into_a_known_routines_topics():
    names = {"papers"}
    assert allowed_topic(RUN, names)
    assert allowed_topic("front-routine-papers-2099-01-01T00:00Z", names)  # a run not opened yet
    assert allowed_topic("routine-papers", names)
    # Front's own request topics, another agent's channel, a routine this
    # relay has never seen and the pre-p7 bare topic are all the same
    # refusal: routing is Front's job.
    assert not allowed_topic("front-p10-cleanup", names)
    assert not allowed_topic("front-routine-ghosts-2026-09-06T00:00Z", names)
    assert not allowed_topic("front-routine-papers", names)


def test_an_unconfigured_chat_refuses_and_says_which_variable():
    chat = Chat(env_path=None)
    refused = chat.check(RUN, "hello", {"papers"})
    assert "AGENTROOM_CHAT_ZULIP_ENV" in refused
    assert chat.status()["configured"] is False


def test_a_configured_chat_still_refuses_the_wrong_topic(tmp_path):
    chat = Chat(env_path=tmp_path / "developer.env")
    assert chat.check("pj-mediagen/whatever", "hello", {"papers"}) is not None
    assert chat.check(RUN, "hello", {"papers"}) is None


def test_an_over_long_message_is_refused_rather_than_truncated(tmp_path):
    # comfynotify proved Zulip drops the tail of an over-long post with no
    # error anywhere. A boundary that fails invisibly gets a loud refusal.
    chat = Chat(env_path=tmp_path / "developer.env", max_chars=50)
    refused = chat.check(RUN, "x" * 51, {"papers"})
    assert "51 characters" in refused and "10000" in refused
    assert chat.check(RUN, "x" * 50, {"papers"}) is None


def test_a_selfnote_cannot_be_typed_by_hand(tmp_path):
    chat = Chat(env_path=tmp_path / "developer.env")
    refused = chat.check(RUN, "[selfnote][served] a/b 1", {"papers"})
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
    found = chat.send(RUN, "  how did that run go?  ", {"papers"})
    assert found == {
        "sent": True, "channel": "front", "topic": RUN,
        "message_id": 4242,
        "note": "the post is live in the realm; the event queue will carry it back",
    }
    # Trimmed, and posted exactly once.
    assert fake.sent == [("front", RUN, "how did that run go?")]


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
    found = look.look("agecho-agautolab1", "front", RUN)
    assert found["known"] is False and found["in_flight"] is None
    assert look.busy("agecho-agautolab1")["known"] is False


def test_a_workspace_newer_than_every_run_record_is_a_run_in_flight(tmp_path):
    root = tmp_path / "agfront"
    record(root, "front", 1, at=time.time() - 3600)
    workspace(root, "front", RUN, 7)
    found = Inflight(roots={"front-agstudio1": root}).look(
        "front-agstudio1", "front", RUN)
    assert found["in_flight"] is True and found["generation"] == 7


def test_a_finished_run_leaves_a_record_newer_than_its_workspace(tmp_path):
    root = tmp_path / "agfront"
    workspace(root, "front", RUN, 7)
    record(root, "entrance_front", 1, at=time.time() + 60)
    found = Inflight(roots={"front-agstudio1": root}).look(
        "front-agstudio1", "front", RUN)
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
    assert look.look("autolab-agstudio1", "front", RUN)["in_flight"] is False
    busy = look.busy("autolab-agstudio1")
    assert busy["in_flight"] is True and busy["where"] == "pj-studyarxiv/workplan-papers"


def test_graph_edges_keep_the_immediate_parent_through_three_hops():
    root = topic("front", RUN, fire("papers", ident=10),
                 servednote("project/plan", 90, ident=20))
    plan = topic("project", "plan", rootnote(f"front/{RUN}", ident=21))
    work = topic("work", "task", rootnote("project/plan", ident=30),
                 servednote("forge/result", 100, ident=40))
    nodes = session_tree(mapping(root, plan, work),
                         ("front", RUN), {}, since=0, until=None)["nodes"]
    assert [(node["channel"], node["topic"], node["depth"], node["parent"]) for node in nodes] == [
        ("project", "plan", 1, {"channel": "front", "topic": RUN}),
        ("work", "task", 2, {"channel": "project", "topic": "plan"}),
        ("forge", "result", 3, {"channel": "work", "topic": "task"}),
    ]
    assert nodes[-1]["known"] == "note-only"
    assert nodes[-1]["state"] == "unknown"


def test_node_limit_reports_only_actual_omissions():
    root = topic("front", RUN, fire("papers", ident=10),
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
    root = topic("front", RUN, fire("papers", ident=10),
                 servednote("pj-a/level-1", 90, ident=20))
    chain = [topic("pj-a", f"level-{i}",
                   servednote(f"pj-a/level-{i+1}", 90, ident=20+i)) for i in range(1, 5)]
    tree = session_tree(mapping(root, *chain), ("front", root.topic), {}, since=0, until=None)
    assert len(tree["nodes"]) == 4
    assert tree["truncation"]["reasons"] == ["depth"]
    leaf = session_tree(mapping(root, *chain[:-1]), ("front", root.topic), {}, since=0, until=None)
    assert leaf["truncation"]["truncated"] is False
    cycle = topic("pj-a", "level-4", servednote(f"front/{RUN}", 90, ident=30))
    tree = session_tree(mapping(root, *chain[:-1], cycle), ("front", root.topic), {}, since=0, until=None)
    assert tree["truncation"]["truncated"] is False


def test_sessions_expose_reconstruction_bounds_for_manual_and_scheduled_activity():
    for posts in [[], [fire("papers", ident=10)]]:
        root = topic("front", RUN, *posts,
                     *[servednote(f"pj-a/child-{i}", 90, ident=20+i) for i in range(41)])
        session = sessions_of(mapping(root), "papers", {})[0]
        assert session["truncation"]["truncated"] is True
        assert len(session["nodes"]) == 40


# --- session identity, origin and resolution (operation_room p6) ----------


from agentroom.routines import (  # noqa: E402
    MANUAL_MARK,
    fire_line,
    fire_origin,
    parse_run_topic,
    previous_of,
    resolution_of,
    run_topic,
    session_list,
)

TRIGGER = Path(__file__).resolve().parents[3] / "devenv" / "routine" / "trigger.sh"


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
    # The trigger's topic line builds the same name `run_topic` does, and the
    # previous-run sentence is the one `previous_of` reads.
    topic_line = next(one for one in source.splitlines() if one.startswith("topic="))
    topic = topic_line[len("topic="):].strip('"').replace("$name", "papers").replace("$stamp", "2026-09-07T05:00Z")
    assert topic == run_topic("papers", "2026-09-07T05:00Z")
    assert parse_run_topic(topic) == ("papers", "2026-09-07T05:00Z")
    prev_line = next(one for one in source.splitlines() if "Previous run:" in one)
    prev = prev_line.split('"$text ', 1)[1].rstrip('"').replace("\\`", "`").replace("$prev", "front-routine-papers-2026-09-06T05:00Z")
    assert previous_of(text + " " + prev) == "front-routine-papers-2026-09-06T05:00Z"


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
    assert previous_of(with_note) is None
    linked = fire_line("papers", "2026-09-07T05:00Z", None, "front-routine-papers-2026-09-06T05:00Z")
    assert previous_of(linked) == "front-routine-papers-2026-09-06T05:00Z"
    assert linked.endswith("Do it.")
    assert parse_run_topic("front-routine-papers") is None
    assert parse_run_topic("front-routine-my-routine-2026-09-07T05:00Z") == ("my-routine", "2026-09-07T05:00Z")


def test_a_run_is_resolved_by_its_own_topics_flag_and_nothing_else():
    assert resolution_of(run("papers", 1, resolved=True))["state"] == "resolved"
    assert resolution_of(run("papers", 1))["state"] == "open"
    # Zulip's notice is not speech and not history; it changes nothing here.
    typed = run("papers", 1, {**message("has marked this topic as resolved", ident=3),
                              "sender_realm_str": "zulipinternal"})
    assert [kept.id for kept in typed.history] == [] and resolution_of(typed)["state"] == "open"


def test_sessions_carry_their_identity_origin_resolution_and_pointer():
    schedule = Schedule(
        path="x", ok=True, requests=[],
        events=[{"id": "e7", "at": "2026-09-06T00:00:00Z", "kind": "fire", "from": "r8",
                 "fired_at": "2026-09-06T00:00:20Z", "routine": "papers"}],
    )
    from datetime import datetime, timezone
    at = int(datetime(2026, 9, 6, tzinfo=timezone.utc).timestamp())
    older = run("papers", 0, {**fire("papers", ident=10), "timestamp": at + 5}, resolved=True)
    newer = run("papers", 5, {**message(fire_line(
        "papers", "2026-09-06T05:00Z", None, older.topic), ident=20), "timestamp": at + 9000})
    found = session_list(mapping(older, newer), "papers", {}, schedule=schedule, now=NOW)
    first, second = found["sessions"]
    assert (first["id"], first["topic"], first["stamp"]) == (20, newer.topic, "2026-09-06T05:00Z")
    assert first["origin"] == "manual" and first["resolution"]["state"] == "open"
    assert first["previous"] == older.topic and first["answer"]["state"] == "unanswered"
    assert (second["id"], second["topic"]) == (10, older.topic)
    assert second["origin"] == "scheduled" and second["schedule_event"]["id"] == "e7"
    assert second["resolution"]["state"] == "resolved" and second["previous"] is None
    assert found["latest_fire"]["message_id"] == 20 and found["latest_topic"] == newer.topic
    assert found["history"]["runs"] == 2 and found["history"]["open_runs"] == 1


def test_hiding_resolved_sessions_filters_before_the_limit():
    held = mapping(*[
        run("papers", index, fire("papers", ident=10 * index), resolved=index <= 3)
        for index in range(1, 6)
    ])
    shown = session_list(held, "papers", {}, include_resolved=False)
    assert [session["id"] for session in shown["sessions"]] == [50, 40]
    assert shown["history"]["hidden_resolved"] == 3
    # The unfiltered reading still leads with the actual latest run.
    assert [session["id"] for session in sessions_of(held, "papers", {})] == [50, 40, 30]


def test_a_full_history_window_is_reported_on_the_session():
    posts = [fire("papers", ident=1)] + [message(f"post {i}", ident=i + 2)
                                          for i in range(ROUTINE_HISTORY_LIMIT())]
    session = sessions_of(mapping(run("papers", 1, *posts)), "papers", {})[0]
    assert session["history"]["bounded"] is True
    assert "not held" in session["history"]["note"]
    # The fire itself fell out of the window: the session is still there.
    assert session["fire"] is None and session["id"] is not None


def ROUTINE_HISTORY_LIMIT():
    from agentroom.routines import ROUTINE_HISTORY
    return ROUTINE_HISTORY


# --- starting a session by hand (operation_room p6 step 2) ------------------


class RecordingClient:
    def __init__(self, fail=None):
        self.sent = []
        self.fail = fail

    def send_to_channel(self, channel, topic, content):
        if self.fail:
            raise self.fail
        self.sent.append((channel, topic, content))
        return 5100


def started_chat(tmp_path, client=None):
    client = client or RecordingClient()
    return Chat(env_path=tmp_path / "developer.env", client_factory=lambda path: client), client


def live_row(**overrides):
    row = {"name": "papers", "retired": False, "latest_topic": RUN,
           "request": {"message_id": 1, "text": "the standing request"}}
    row.update(overrides)
    return row


def test_a_manual_start_posts_the_marked_fire_line_as_the_developer(tmp_path):
    chat, client = started_chat(tmp_path)
    found = chat.start(live_row(), "papers", " one paper only ", stamp="2026-09-07T05:00Z",
                       names={"papers"})
    assert found["sent"] is True and found["message_id"] == 5100
    assert found["topic"] == "front-routine-papers-2026-09-07T05:00Z" and found["previous"] == RUN
    channel, topic, text = client.sent[0]
    assert (channel, topic) == ("front", "front-routine-papers-2026-09-07T05:00Z")
    assert text == found["text"] == fire_line("papers", "2026-09-07T05:00Z", "one paper only", RUN)
    assert fire_origin(text) == "manual" and FIRE_LINE_MATCH(text) == "papers"
    assert previous_of(text) == RUN


def test_the_first_run_of_a_routine_names_no_previous_one(tmp_path):
    chat, client = started_chat(tmp_path)
    found = chat.start(live_row(latest_topic=None), "papers", None, stamp="2026-09-07T05:00Z",
                       names={"papers"})
    assert found["sent"] is True and found["previous"] is None
    assert client.sent[0][1] == "front-routine-papers-2026-09-07T05:00Z"
    assert "Previous run" not in client.sent[0][2]


def test_two_starts_in_one_minute_would_share_a_topic_and_the_second_is_refused(tmp_path):
    chat, client = started_chat(tmp_path)
    found = chat.start(live_row(latest_topic="front-routine-papers-2026-09-07T05:00Z"), "papers",
                       None, stamp="2026-09-07T05:00Z", names={"papers"})
    assert found["sent"] is False and "this minute" in found["error"] and client.sent == []


def test_a_retired_or_requestless_routine_is_refused_before_anything_is_posted(tmp_path):
    chat, client = started_chat(tmp_path)
    retired = chat.start(live_row(retired=True), "papers", None, stamp="2026-09-07T05:00Z", names={"papers"})
    assert retired["sent"] is False and "retired" in retired["error"]
    blank = chat.start(live_row(request=None), "papers", None, stamp="2026-09-07T05:00Z", names={"papers"})
    assert blank["sent"] is False and "standing request" in blank["error"]
    unknown = chat.start(None, "ghosts", None, stamp="2026-09-07T05:00Z", names={"papers"})
    assert unknown["sent"] is False and "ghosts" in unknown["error"]
    assert client.sent == []


def test_an_unconfigured_relay_refuses_to_start_and_names_the_variable(tmp_path):
    found = Chat(env_path=None).start(live_row(), "papers", None, stamp="2026-09-07T05:00Z", names={"papers"})
    assert found["sent"] is False and "AGENTROOM_CHAT_ZULIP_ENV" in found["error"]


def test_a_failed_post_is_reported_as_uncertain_and_never_retried(tmp_path):
    chat, client = started_chat(tmp_path, RecordingClient(fail=ConnectionError("reset")))
    found = chat.start(live_row(), "papers", None, stamp="2026-09-07T05:00Z", names={"papers"})
    assert found["sent"] is False and found["uncertain"] is True
    assert "may have landed" in found["note"]


def test_an_over_long_instruction_is_refused_like_any_other_post(tmp_path):
    chat, client = started_chat(tmp_path)
    chat.max_chars = 300
    found = chat.start(live_row(), "papers", "x" * 300, stamp="2026-09-07T05:00Z", names={"papers"})
    assert found["sent"] is False and found["uncertain"] is False
    assert client.sent == []


# --- display metadata (operation_room p6 step 5) ----------------------------


from agentroom.routines import display_of  # noqa: E402


def test_a_display_line_anywhere_in_the_request_names_icon_and_title():
    found = display_of("papers", "Standing request, v4.\n\ndisplay: 📰 Papers digest\n\nDo it.")
    assert found == {"icon": "📰", "icon_source": "metadata",
                     "title": "Papers digest", "title_source": "metadata"}


def test_a_first_line_heading_is_the_next_title_and_the_name_is_last():
    heading = display_of("papers", "# Weekly papers\nthe request")
    assert (heading["title"], heading["title_source"]) == ("Weekly papers", "heading")
    assert heading["icon_source"] == "assigned"
    bare = display_of("papers", "Standing request for the `papers` routine, **v4**.")
    assert (bare["title"], bare["title_source"]) == ("papers", "name")
    none = display_of("papers", None)
    assert none["title"] == "papers" and none["icon"] == bare["icon"] == heading["icon"]


def test_display_reaches_the_row_without_any_mapping():
    found = rows(topic("front", "routine-papers", message("display: 🧪 Lab run", ident=1)))
    assert found[0]["display"]["title"] == "Lab run" and found[0]["display"]["icon"] == "🧪"


def test_assigned_icons_do_not_collide_on_one_board():
    names = ["ghtrends", "imgprompt", "localtest", "manual", "mediagen", "papers", "publish", "rtnotes"]
    found = rows(*[topic("front", f"routine-{name}", message("request", ident=i + 1)) for i, name in enumerate(names)])
    icons = [row["display"]["icon"] for row in found]
    assert len(set(icons)) == len(icons)
    # And a chosen icon is never displaced by an assigned one.
    chosen = rows(topic("front", "routine-a", message("display: 🔁 A", ident=1)),
                  topic("front", "routine-b", message("request", ident=2)))
    assert chosen[0]["display"]["icon"] == "🔁" and chosen[1]["display"]["icon"] != "🔁"
